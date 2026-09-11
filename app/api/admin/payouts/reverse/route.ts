// POST /api/admin/payouts/reverse — claw one expert payout back (adminGuard).
//
// Wave 5, founder decision 4: a refund or a chargeback moves the engagement to
// `refunded` and alerts, and the expert's transfer is deliberately left alone
// (see the note in app/api/webhooks/stripe/handlers.ts). Reversing money out of
// an expert's bank account is a judgement call, so it is a staff action with a
// reason, never an automatic consequence of a webhook.
//
//   POST { projectId, expertId, reason }
//     200 { ok: true, reversalId }
//     409 { error: 'not_reversible', reason: 'no_transfer' | 'already_reversed' }
//     404 { error: 'not_found' }           — no such project or engagement
//     400 { error: 'invalid_request' }      — missing ids or reason
//     502 { error: 'stripe_failed' }        — Stripe refused the reversal
//
//   GET ?projectId=&expertId=
//     200 { reversible, reason?, expertPaidAt, expertPayoutReversedAt }
//   The admin console reads this to disable the control and to show the
//   reversed-at stamp. It returns no Stripe id — only whether one exists.
//
// Platform admins only; middleware.ts also 404s /api/admin/* for everyone else,
// so adminGuard here is defence in depth.
//
// NEVER log the transfer id, the reversal id, the expert's email or the reason
// text — the reason is staff prose about a specific person. The console line
// carries projectId and expertId only, like every other money path.
//
// The row is written through lib/projectStore.mutateExpert rather than
// updateExpertStatus: the two reversal fields live on ProjectExpert and
// UpdateExpertInput does not carry them, and lib/projectStore.ts is lead-owned.
// A failure to write AFTER Stripe has moved the money is the same class of
// problem as `transfer_sent_but_unrecorded` in lib/expertPayout.ts, and is
// recorded the same way rather than reported as a failed reversal.

import { NextRequest } from 'next/server';
import { adminGuard } from '../../../../../lib/auth';
import { getProject, mutateExpert } from '../../../../../lib/projectStore';
import { canReversePayout, reverseExpertPayout } from '../../../../../lib/stripeConnect';
import { recordSystemFailure } from '../../../../../lib/engagementEvents';
import type { Project, ProjectExpert } from '../../../../../types';

async function loadEngagement(
  projectId: string,
  expertId:  string,
): Promise<{ project: Project; pe: ProjectExpert } | null> {
  const project = await getProject(projectId);
  if (!project) return null;
  const pe = project.experts.find(e => e.expert.id === expertId);
  return pe ? { project, pe } : null;
}

// ─── GET — is this payout reversible? ─────────────────────────────────────────

export async function GET(request: NextRequest): Promise<Response> {
  const authError = await adminGuard(request);
  if (authError) return authError;

  const projectId = (request.nextUrl.searchParams.get('projectId') ?? '').trim();
  const expertId  = (request.nextUrl.searchParams.get('expertId')  ?? '').trim();
  if (!projectId || !expertId) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  try {
    const found = await loadEngagement(projectId, expertId);
    if (!found) return Response.json({ error: 'not_found' }, { status: 404 });

    const allowed = canReversePayout(found.pe);
    return Response.json({
      reversible:             allowed.ok,
      ...(allowed.ok ? {} : { reason: allowed.reason }),
      expertPaidAt:           found.pe.expertPaidAt ?? null,
      expertPayoutReversedAt: found.pe.expertPayoutReversedAt ?? null,
    });
  } catch (err) {
    console.error('[api/admin/payouts/reverse] lookup error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}

// ─── POST — reverse it ────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<Response> {
  const authError = await adminGuard(request);
  if (authError) return authError;

  let body: Record<string, unknown> | null = null;
  try {
    const parsed = await request.json() as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    body = null;
  }
  if (!body) return Response.json({ error: 'invalid_json' }, { status: 400 });

  const projectId = typeof body.projectId === 'string' ? body.projectId.trim() : '';
  const expertId  = typeof body.expertId  === 'string' ? body.expertId.trim()  : '';
  const reason    = typeof body.reason    === 'string' ? body.reason.trim()    : '';
  if (!projectId || !expertId || !reason) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  let found: { project: Project; pe: ProjectExpert } | null;
  try {
    found = await loadEngagement(projectId, expertId);
  } catch (err) {
    console.error('[api/admin/payouts/reverse] lookup error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
  if (!found) return Response.json({ error: 'not_found' }, { status: 404 });

  // Checked before Stripe is touched; checked again inside reverseExpertPayout.
  const allowed = canReversePayout(found.pe);
  if (!allowed.ok) {
    return Response.json({ error: 'not_reversible', reason: allowed.reason }, { status: 409 });
  }

  let result: Awaited<ReturnType<typeof reverseExpertPayout>>;
  try {
    result = await reverseExpertPayout(found.pe, projectId, expertId);
  } catch (err) {
    console.error('[api/admin/payouts/reverse] stripe refused', { projectId, expertId });
    await recordSystemFailure({
      area:   'payout',
      reason: `payout_reversal_failed: ${err instanceof Error ? err.message.slice(0, 120) : 'unknown'}`,
      projectId,
      expertId,
    });
    return Response.json({ error: 'stripe_failed' }, { status: 502 });
  }

  if (!result.ok) {
    return Response.json({ error: 'not_reversible', reason: result.reason }, { status: 409 });
  }

  // The money has moved. Stamp the row, and if that write loses, record the gap
  // rather than telling the operator the reversal failed — it did not.
  try {
    await mutateExpert(projectId, expertId, current => ({
      ...current,
      expertPayoutReversedAt:   Date.now(),
      stripeTransferReversalId: result.ok ? result.reversalId : null,
      updatedAt:                Date.now(),
    }));
  } catch {
    await recordSystemFailure({
      area:   'payout',
      reason: 'payout_reversed_but_unrecorded',
      projectId,
      expertId,
    });
  }

  await recordSystemFailure({
    area:   'payout',
    // The staff prose is deliberately NOT persisted: a system_events reason is
    // logged and shown on the admin attention feed, and free text about one
    // named expert belongs in neither. The reason is required so the action
    // cannot be a stray click.
    reason: 'payout_reversed_by_staff',
    projectId,
    expertId,
  });

  console.log('[api/admin/payouts/reverse] reversed', { projectId, expertId });

  return Response.json({ ok: true, reversalId: result.reversalId });
}
