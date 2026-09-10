// GET /api/jobs/reconcile — the nightly sweep that catches what the request
// path let go.
//
// Four things in this product are deliberately best-effort, because failing
// them would fail something that matters more: seat quantities are synced to
// Stripe on membership changes (but a membership change must not fail on
// billing), expert payouts are retried when a Connect account becomes usable
// (but a webhook must not fail on a payout), sourcing runs are finished by a
// QStash job (which can die mid-run and leave the client staring at a pill),
// and a disabled member's auth claims are re-synced (but disabling a member
// must not fail on Supabase Auth — lib/membershipReconcile.ts).
//
// This route is where those four get another chance, once a day, out of band.
// Every step is isolated in its own try/catch, given its own slice of the
// clock, and counted: a Stripe outage OR a slow seat sweep must not stop the
// payout, sourcing or membership sweeps.
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
//   seats:    { synced, errors, overflow },
//   payouts:  { attempted, paid, overflow },
//   sourcing: { reset, overflow },
//   membership: { scanned, repaired, errors },
//   ranMs:    number,
//   steps:    { seats, payouts, sourcing, membership }
//                                              // 'ok' | 'partial' | 'failed' | 'skipped'
// }
//
// `overflow: true` means a full page of candidates came back, so there are
// probably more than the bound; `partial` means the sweep hit its own deadline
// and stopped early. Both are "come back tomorrow", not failures.
//
// NEVER logs or returns: emails, names, Stripe ids, or research content.

import { NextRequest } from 'next/server';
import { getServiceRoleClient } from '../../../../lib/supabase/admin';
import { secretMatches } from '../../../../lib/auth';
import { syncOrgSeatQuantity } from '../../../../lib/orgBilling';
import { retryPendingPayoutsForAccount, MAX_PAYOUT_ATTEMPTS } from '../../../../lib/expertPayout';
import { updateProjectFields } from '../../../../lib/projectStore';
import { recordSystemFailure } from '../../../../lib/engagementEvents';
import { STUCK_SOURCING_MINUTES } from '../../../../lib/attention';
import { sweepMembershipStatus } from '../../../../lib/membershipReconcile';
import type { MembershipSweepResult } from '../../../../lib/membershipReconcile';

// The sweeps run in sequence and the first two talk to Stripe per row; 60s is
// the same ceiling the other long jobs in this app use, and each sweep gets its
// own slice of it (SWEEP_DEADLINE_MS).
export const maxDuration = 60;

/** Safety rails, so one pathological night cannot run for an hour. */
const MAX_ORGS             = 500;
const MAX_PENDING_PAYOUTS  = 500;
const MAX_STUCK_PROJECTS   = 200;

/**
 * Each money-moving sweep's own slice of the 60 s budget (H-10). Three slices
 * of 18 s leave a few seconds for the auth check, the bounded membership sweep,
 * the final writes and the response — and, more importantly, mean the seat
 * sweep can no longer eat the whole invocation and leave payouts and sourcing
 * silently unrun. A sweep that
 * hits its deadline stops on a row boundary and reports 'partial'; every sweep
 * is idempotent, so tomorrow's run continues where this one stopped (the
 * queries are ordered oldest-first, so it really is the same rows next).
 */
const SWEEP_DEADLINE_MS = 18_000;

/** A payout owed for longer than this is worth waking someone for (M-38). */
const PAYOUT_STALE_DAYS = 14;

type StepStatus = 'ok' | 'partial' | 'failed' | 'skipped';

/** True when this sweep has used its slice of the invocation's budget. */
function outOfTime(deadline: number): boolean {
  return Date.now() > deadline;
}

interface ReconcileResult {
  ok:       boolean;
  seats:    { synced: number; errors: number; overflow: boolean };
  payouts:  { attempted: number; paid: number; overflow: boolean };
  sourcing: { reset: number; overflow: boolean };
  membership: MembershipSweepResult;
  ranMs:    number;
  steps:    { seats: StepStatus; payouts: StepStatus; sourcing: StepStatus; membership: StepStatus };
}

// ─── Step 1: seat quantities ──────────────────────────────────────────────────

/**
 * Re-syncs every organization that has finished billing setup. syncOrgSeatQuantity
 * is idempotent — an org already matching Stripe reports 'unchanged' and costs
 * one API call — so running the whole set nightly is cheap and self-healing.
 *
 * Ordered by updated_at ascending (M-36): with a bound and no order, Postgres
 * is free to return the same arbitrary 500 rows every night and the rest are
 * never synced at all. Oldest-first makes the excess a queue rather than a
 * lottery.
 */
async function sweepSeats(deadline: number): Promise<{ synced: number; errors: number; overflow: boolean; partial: boolean }> {
  const db = getServiceRoleClient();
  if (!db) return { synced: 0, errors: 0, overflow: false, partial: false };

  const { data, error } = await db
    .from('organization_billing')
    .select('organization_id')
    .eq('billing_complete', true)
    .order('updated_at', { ascending: true })
    .limit(MAX_ORGS);

  if (error) throw new Error(`billing rows unreadable: ${error.message.slice(0, 120)}`);
  const overflow = (data?.length ?? 0) >= MAX_ORGS;
  if (!data || data.length === 0) return { synced: 0, errors: 0, overflow, partial: false };

  let synced  = 0;
  let errors  = 0;
  let partial = false;

  for (const row of data) {
    if (outOfTime(deadline)) { partial = true; break; }
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

  return { synced, errors, overflow, partial };
}

// ─── Step 2: pending expert payouts ───────────────────────────────────────────

/** The payout state this job cares about, as stored inside project_experts.data. */
interface PayoutState {
  expertOnboardingStatus?: unknown;
  stripeConnectAccountId?: unknown;
  stripeTransferId?:       unknown;
  payoutAttempts?:         unknown;
  /** When the CLIENT paid — the moment the expert became owed money. */
  paidAt?:                 unknown;
}

/**
 * Retries payouts that went pending because the expert had no usable Connect
 * account at the time, and payouts whose transfer failed.
 *
 * lib/expertPayout.retryPendingPayoutsForAccount already knows how to find and
 * pay every retryable row for ONE account, so this job's only job is to find
 * the distinct accounts. It reads them off the rows rather than adding a new
 * function to that module.
 *
 * A row whose account id is known only in Redis (the expert opened the
 * onboarding link, but runExpertPayout has not written the id back yet) is not
 * picked up here — that case is exactly what the account.updated webhook
 * handles, and it fires the moment the account becomes usable.
 *
 * TWO CONSEQUENCES A READER SHOULD EXPECT, neither of them obvious from the
 * name of this function:
 *
 *   IT SENDS EMAIL. retryPendingPayoutsForAccount calls runExpertPayout, and
 *   runExpertPayout's "account exists but onboarding is not finished" branch
 *   re-sends the payout onboarding link (lib/expertPayout.sendOnboardingLink).
 *   That branch is now throttled on the row — at most one mail a week and four
 *   in total (lib/expertPayout.shouldSendPayoutReminder) — so a nightly sweep
 *   can no longer write to the same expert every day (H-9).
 *
 *   THE TWO BOUNDS STILL DISAGREE. This query reads up to MAX_PENDING_PAYOUTS
 *   (500) rows purely to collect the DISTINCT account ids; the actual paying is
 *   done by retryPendingPayoutsForAccount, which re-runs its own query capped
 *   at lib/expertPayout.MAX_PENDING_ROWS (200) per status. So the scan is
 *   O(accounts) queries rather than one pass (M-37, open). Both queries are now
 *   ordered oldest-first, so a row past the inner bound is reached on a later
 *   night rather than never.
 */
async function sweepPayouts(deadline: number): Promise<{ attempted: number; paid: number; overflow: boolean; partial: boolean }> {
  const db = getServiceRoleClient();
  if (!db) return { attempted: 0, paid: 0, overflow: false, partial: false };

  const rows: Array<{ data: unknown }> = [];
  // 'failed' is swept too: a transfer that failed used to be terminal (H-6).
  // Queried one status at a time — a PostgREST `or` over a JSON path is easy to
  // get subtly wrong, and a filter that silently matches nothing here means
  // nobody gets paid.
  for (const status of ['pending', 'failed']) {
    const { data, error } = await db
      .from('project_experts')
      .select('data')
      .filter('data->>expertOnboardingStatus', 'eq', status)
      .order('updated_at', { ascending: true })
      .limit(MAX_PENDING_PAYOUTS);

    if (error) throw new Error(`pending payouts unreadable: ${error.message.slice(0, 120)}`);
    if (data) rows.push(...data);
  }

  const overflow = rows.length >= MAX_PENDING_PAYOUTS;
  if (rows.length === 0) return { attempted: 0, paid: 0, overflow, partial: false };

  const accounts = new Set<string>();
  const now      = Date.now();
  let staleOwed  = 0;

  for (const row of rows) {
    const state = (row.data ?? {}) as PayoutState;
    // Already paid — nothing to retry.
    if (typeof state.stripeTransferId === 'string' && state.stripeTransferId) continue;
    const attempts = typeof state.payoutAttempts === 'number' ? state.payoutAttempts : 0;
    if (attempts >= MAX_PAYOUT_ATTEMPTS) continue;

    const paidAt = state.paidAt;
    if (typeof paidAt === 'number' && Number.isFinite(paidAt)
        && now - paidAt > PAYOUT_STALE_DAYS * 24 * 60 * 60 * 1000) {
      staleOwed++;
    }

    const accountId = state.stripeConnectAccountId;
    if (typeof accountId === 'string' && accountId) accounts.add(accountId);
  }

  let attempted = 0;
  let paid      = 0;
  let partial   = false;

  for (const accountId of Array.from(accounts)) {
    if (outOfTime(deadline)) { partial = true; break; }
    // Never throws; returns zeroes on any failure.
    const result = await retryPendingPayoutsForAccount(accountId);
    attempted += result.attempted;
    paid      += result.paid;
  }

  // M-38: "attempted but not paid" is the NORMAL outcome for every expert who
  // has not finished Stripe onboarding, so alerting on it meant alerting every
  // night forever, which is the same as not alerting at all. The condition that
  // actually needs a human is money owed for a fortnight.
  if (staleOwed > 0) {
    await recordSystemFailure({
      area:   'payout',
      reason: `${staleOwed} payout(s) unpaid more than ${PAYOUT_STALE_DAYS} days after the client paid`,
    });
  }

  return { attempted, paid, overflow, partial };
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
async function sweepSourcing(now: number, deadline: number): Promise<{ reset: number; overflow: boolean; partial: boolean }> {
  const db = getServiceRoleClient();
  if (!db) return { reset: 0, overflow: false, partial: false };

  const { data, error } = await db
    .from('projects')
    .select('id, brief, updated_at')
    .filter('brief->>sourcingStatus', 'eq', 'running')
    .order('updated_at', { ascending: true })
    .limit(MAX_STUCK_PROJECTS);

  if (error) throw new Error(`running projects unreadable: ${error.message.slice(0, 120)}`);
  const overflow = (data?.length ?? 0) >= MAX_STUCK_PROJECTS;
  if (!data || data.length === 0) return { reset: 0, overflow, partial: false };

  const cutoffMs = STUCK_SOURCING_MINUTES * 60_000;
  let reset   = 0;
  let partial = false;

  for (const row of data) {
    if (outOfTime(deadline)) { partial = true; break; }
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

  return { reset, overflow, partial };
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
    seats:    { synced: 0, errors: 0, overflow: false },
    payouts:  { attempted: 0, paid: 0, overflow: false },
    sourcing: { reset: 0, overflow: false },
    membership: { scanned: 0, repaired: 0, errors: 0 },
    ranMs:    0,
    steps:    { seats: 'skipped', payouts: 'skipped', sourcing: 'skipped', membership: 'skipped' },
  };

  // Each step is isolated against THROWING and, since H-10, against TIME: every
  // sweep gets its own SWEEP_DEADLINE_MS slice of the invocation and stops on a
  // row boundary when it is spent, reporting 'partial'. Before that, the three
  // shared one 60 s budget in a fixed order with no clock check, so a slow seat
  // sweep (one or more Stripe round trips per organization) simply consumed the
  // whole invocation and the payout and sourcing sweeps — the two that unstick
  // paid experts and stuck runs — never ran at all, leaving 'skipped' behind
  // with no response and no system_events row to say so.
  //
  // The sweeps are individually idempotent and read oldest-first, so a partial
  // night is a delay: tomorrow's run starts with the rows this one did not
  // reach.
  try {
    const seats        = await sweepSeats(Date.now() + SWEEP_DEADLINE_MS);
    result.seats       = { synced: seats.synced, errors: seats.errors, overflow: seats.overflow };
    result.steps.seats = seats.partial ? 'partial' : 'ok';
  } catch (err) {
    result.ok          = false;
    result.steps.seats = 'failed';
    await recordSystemFailure({ area: 'seat_sync', reason: err });
  }

  try {
    const payouts        = await sweepPayouts(Date.now() + SWEEP_DEADLINE_MS);
    result.payouts       = { attempted: payouts.attempted, paid: payouts.paid, overflow: payouts.overflow };
    result.steps.payouts = payouts.partial ? 'partial' : 'ok';
  } catch (err) {
    result.ok            = false;
    result.steps.payouts = 'failed';
    await recordSystemFailure({ area: 'payout', reason: err });
  }

  try {
    const sourcing        = await sweepSourcing(startedAt, Date.now() + SWEEP_DEADLINE_MS);
    result.sourcing       = { reset: sourcing.reset, overflow: sourcing.overflow };
    result.steps.sourcing = sourcing.partial ? 'partial' : 'ok';
  } catch (err) {
    result.ok             = false;
    result.steps.sourcing = 'failed';
    await recordSystemFailure({ area: 'sourcing', reason: err });
  }

  // Fourth sweep (H-16): repair auth app_metadata for members the database
  // says are disabled. It lives in lib/membershipReconcile.ts rather than here
  // so that two Wave-2 briefs did not have to edit this file at once. It never
  // throws and bounds itself, so it needs no deadline argument — but it still
  // runs last, after the three sweeps that move money.
  try {
    result.membership       = await sweepMembershipStatus();
    result.steps.membership = 'ok';
  } catch (err) {
    result.ok               = false;
    result.steps.membership = 'failed';
    await recordSystemFailure({ area: 'membership', reason: err });
  }

  result.ranMs = Date.now() - startedAt;

  console.log('[api/jobs/reconcile] done', JSON.stringify({
    ok:       result.ok,
    seats:    result.seats,
    payouts:  result.payouts,
    sourcing: result.sourcing,
    membership: result.membership,
    ranMs:    result.ranMs,
  }));

  return Response.json(result);
}
