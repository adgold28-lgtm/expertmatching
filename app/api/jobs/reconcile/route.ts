// GET /api/jobs/reconcile — the nightly sweep that catches what the request
// path let go.
//
// Three things in this product are deliberately best-effort, because failing
// them would fail something that matters more: seat quantities are synced to
// Stripe on membership changes (but a membership change must not fail on
// billing), expert payouts are retried when a Connect account becomes usable
// (but a webhook must not fail on a payout), and sourcing runs are finished by
// a QStash job (which can die mid-run and leave the client staring at a pill).
//
// This route is where those three get another chance, once a day, out of band.
// Every step is isolated in its own try/catch and counted: a Stripe outage
// during the seat sweep must not stop the payout sweep or the sourcing sweep.
//
// AUTH: `Authorization: Bearer ${CRON_SECRET}`, which Vercel Cron sends on
// every scheduled invocation. Note that middleware.ts lets /api/jobs/ through
// without a session (those routes are signature-verified rather than
// session-authenticated), so THIS CHECK IS THE ONLY THING PROTECTING THIS
// ROUTE. Without CRON_SECRET set it returns 503 rather than running unguarded.
//
// Schedule: vercel.json → "0 6 * * *" (06:00 UTC daily).
//
// SET `CRON_SECRET` IN THE VERCEL PROJECT ENV. Vercel generates and sends it
// for cron invocations only when the variable exists.
//
// Response: 200 {
//   ok:       boolean,                          // false if any step threw
//   seats:    { synced, errors },
//   payouts:  { attempted, paid },
//   sourcing: { reset },
//   ranMs:    number,
//   steps:    { seats, payouts, sourcing }      // 'ok' | 'failed' | 'skipped'
// }
//
// NEVER logs or returns: emails, names, Stripe ids, or research content.

import { NextRequest } from 'next/server';
import { getServiceRoleClient } from '../../../../lib/supabase/admin';
import { syncOrgSeatQuantity } from '../../../../lib/orgBilling';
import { retryPendingPayoutsForAccount } from '../../../../lib/expertPayout';
import { updateProjectFields } from '../../../../lib/projectStore';
import { recordSystemFailure } from '../../../../lib/engagementEvents';
import { STUCK_SOURCING_MINUTES } from '../../../../lib/attention';

// The three sweeps run in sequence and each talks to Stripe per row; 60s is the
// same ceiling the other long jobs in this app use.
export const maxDuration = 60;

/** Safety rails, so one pathological night cannot run for an hour. */
const MAX_ORGS             = 500;
const MAX_PENDING_PAYOUTS  = 500;
const MAX_STUCK_PROJECTS   = 200;

type StepStatus = 'ok' | 'failed' | 'skipped';

interface ReconcileResult {
  ok:       boolean;
  seats:    { synced: number; errors: number };
  payouts:  { attempted: number; paid: number };
  sourcing: { reset: number };
  ranMs:    number;
  steps:    { seats: StepStatus; payouts: StepStatus; sourcing: StepStatus };
}

// ─── Auth ─────────────────────────────────────────────────────────────────────

/**
 * Constant-time-ish comparison. Not a defence against a local attacker (this is
 * a header check on a serverless function, not a crypto primitive) but it costs
 * nothing to avoid the early-exit compare.
 */
function secretMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

// ─── Step 1: seat quantities ──────────────────────────────────────────────────

/**
 * Re-syncs every organization that has finished billing setup. syncOrgSeatQuantity
 * is idempotent — an org already matching Stripe reports 'unchanged' and costs
 * one API call — so running the whole set nightly is cheap and self-healing.
 */
async function sweepSeats(): Promise<{ synced: number; errors: number }> {
  const db = getServiceRoleClient();
  if (!db) return { synced: 0, errors: 0 };

  const { data, error } = await db
    .from('organization_billing')
    .select('organization_id')
    .eq('billing_complete', true)
    .limit(MAX_ORGS);

  if (error) throw new Error(`billing rows unreadable: ${error.message.slice(0, 120)}`);
  if (!data || data.length === 0) return { synced: 0, errors: 0 };

  let synced = 0;
  let errors = 0;

  for (const row of data) {
    try {
      // syncOrgSeatQuantity records its own system_events row on failure.
      const result = await syncOrgSeatQuantity(row.organization_id);
      if (result.outcome === 'error') errors++;
      else if (result.outcome === 'updated') synced++;
    } catch (err) {
      errors++;
      await recordSystemFailure({
        area:           'seat_sync',
        reason:         err,
        organizationId: row.organization_id,
      });
    }
  }

  return { synced, errors };
}

// ─── Step 2: pending expert payouts ───────────────────────────────────────────

/** The payout state this job cares about, as stored inside project_experts.data. */
interface PayoutState {
  stripeConnectAccountId?: unknown;
  stripeTransferId?:       unknown;
}

/**
 * Retries payouts that went pending because the expert had no usable Connect
 * account at the time.
 *
 * lib/expertPayout.retryPendingPayoutsForAccount already knows how to find and
 * pay every pending row for ONE account, so this job's only job is to find the
 * distinct accounts. It reads them off the rows rather than adding a new
 * function to that module.
 *
 * A row whose account id is known only in Redis (the expert opened the
 * onboarding link, but runExpertPayout has not written the id back yet) is not
 * picked up here — that case is exactly what the account.updated webhook
 * handles, and it fires the moment the account becomes usable.
 */
async function sweepPayouts(): Promise<{ attempted: number; paid: number }> {
  const db = getServiceRoleClient();
  if (!db) return { attempted: 0, paid: 0 };

  const { data, error } = await db
    .from('project_experts')
    .select('data')
    .filter('data->>expertOnboardingStatus', 'eq', 'pending')
    .limit(MAX_PENDING_PAYOUTS);

  if (error) throw new Error(`pending payouts unreadable: ${error.message.slice(0, 120)}`);
  if (!data || data.length === 0) return { attempted: 0, paid: 0 };

  const accounts = new Set<string>();

  for (const row of data) {
    const state = (row.data ?? {}) as PayoutState;
    // Already paid — nothing to retry.
    if (typeof state.stripeTransferId === 'string' && state.stripeTransferId) continue;
    const accountId = state.stripeConnectAccountId;
    if (typeof accountId === 'string' && accountId) accounts.add(accountId);
  }

  let attempted = 0;
  let paid      = 0;

  for (const accountId of Array.from(accounts)) {
    // Never throws; returns zeroes on any failure.
    const result = await retryPendingPayoutsForAccount(accountId);
    attempted += result.attempted;
    paid      += result.paid;
  }

  if (attempted > paid) {
    await recordSystemFailure({
      area:   'payout',
      reason: `${attempted - paid} pending payout(s) still unpaid after the nightly retry`,
    });
  }

  return { attempted, paid };
}

// ─── Step 3: sourcing runs that never finished ────────────────────────────────

/**
 * A sourcing run still 'running' after STUCK_SOURCING_MINUTES is not running —
 * the QStash worker that would have finished it is gone. Left alone, the client
 * sees a "Sourcing experts…" pill forever and no error.
 *
 * Marking it failed with a message the client can act on is the honest outcome:
 * they can start it again.
 */
async function sweepSourcing(now: number): Promise<{ reset: number }> {
  const db = getServiceRoleClient();
  if (!db) return { reset: 0 };

  const { data, error } = await db
    .from('projects')
    .select('id, brief, updated_at')
    .filter('brief->>sourcingStatus', 'eq', 'running')
    .limit(MAX_STUCK_PROJECTS);

  if (error) throw new Error(`running projects unreadable: ${error.message.slice(0, 120)}`);
  if (!data || data.length === 0) return { reset: 0 };

  const cutoffMs = STUCK_SOURCING_MINUTES * 60_000;
  let reset = 0;

  for (const row of data) {
    const brief    = row.brief as { sourcingStartedAt?: unknown } | null;
    const rawStart = brief?.sourcingStartedAt;
    // No recorded start: fall back to the row's own last write. A run we cannot
    // show to be recent is a run that has been sitting there.
    const startedAt = typeof rawStart === 'number' && Number.isFinite(rawStart)
      ? rawStart
      : Date.parse(row.updated_at);
    if (!Number.isFinite(startedAt)) continue;
    if (now - startedAt < cutoffMs) continue;

    try {
      await updateProjectFields(row.id, {
        sourcingStatus: 'failed',
        sourcingError:  'Sourcing stopped before it finished. Nothing was charged — '
                      + 'open the project and start it again.',
      });
      reset++;
      await recordSystemFailure({
        area:      'sourcing',
        reason:    `sourcing run abandoned after ${Math.floor((now - startedAt) / 60_000)} minutes`,
        projectId: row.id,
      });
    } catch (err) {
      await recordSystemFailure({ area: 'sourcing', reason: err, projectId: row.id });
    }
  }

  return { reset };
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest): Promise<Response> {
  const secret = process.env.CRON_SECRET;
  if (!secret) {
    // Refuse to run unguarded. middleware.ts does not authenticate /api/jobs/,
    // so an unset secret would mean a publicly runnable billing sweep.
    console.error('[api/jobs/reconcile] CRON_SECRET is not set — refusing to run');
    return Response.json({ error: 'cron_secret_unset' }, { status: 503 });
  }

  const header   = request.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!provided || !secretMatches(provided, secret)) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();

  const result: ReconcileResult = {
    ok:       true,
    seats:    { synced: 0, errors: 0 },
    payouts:  { attempted: 0, paid: 0 },
    sourcing: { reset: 0 },
    ranMs:    0,
    steps:    { seats: 'skipped', payouts: 'skipped', sourcing: 'skipped' },
  };

  // Each step is isolated: one failing sweep must not cost the other two.
  try {
    result.seats       = await sweepSeats();
    result.steps.seats = 'ok';
  } catch (err) {
    result.ok          = false;
    result.steps.seats = 'failed';
    await recordSystemFailure({ area: 'seat_sync', reason: err });
  }

  try {
    result.payouts       = await sweepPayouts();
    result.steps.payouts = 'ok';
  } catch (err) {
    result.ok            = false;
    result.steps.payouts = 'failed';
    await recordSystemFailure({ area: 'payout', reason: err });
  }

  try {
    result.sourcing       = await sweepSourcing(startedAt);
    result.steps.sourcing = 'ok';
  } catch (err) {
    result.ok             = false;
    result.steps.sourcing = 'failed';
    await recordSystemFailure({ area: 'sourcing', reason: err });
  }

  result.ranMs = Date.now() - startedAt;

  console.log('[api/jobs/reconcile] done', JSON.stringify({
    ok:       result.ok,
    seats:    result.seats,
    payouts:  result.payouts,
    sourcing: result.sourcing,
    ranMs:    result.ranMs,
  }));

  return Response.json(result);
}
