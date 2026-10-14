// POST /api/projects/:projectId/experts/:expertId/mismatch
//
// The ten-minute mismatch guarantee, the client's side: "Not the right expert?
// Flag it in the first ten minutes and you won't be charged." The client is
// charged nothing for the flagged call; the expert is still paid 15 minutes at
// their agreed rate, from platform funds. The rules are lib/mismatchGuarantee.ts;
// the money is lib/lateCancelBilling.settleMismatchFlag.
//
// WHO MAY: the project owner or a platform admin, the same guard as every other
// owner-only expert route (booking/cancel, propose-times, complete): an
// inaccessible project is 404 so the route never confirms one exists, and a
// collaborator, who is read-only, gets 403.
//
// WHAT IT DOES, once per call:
//   1. Checks the call can be flagged (mismatchEligibility): a live booking,
//      inside the window (booked start to ten minutes after, plus a minute of
//      grace for clock skew), scheduled, or completed by a meeting that ended
//      inside the window, and not already flagged for a different call.
//   2. Writes mismatchFlaggedAt + mismatchCallId (= booking.icsUid) under
//      compare-and-set (projectStore.mutateExpert), re-checking eligibility
//      against the freshly read row, so two clicks and a racing meeting end
//      resolve to one flag.
//   3. The first time only: the `mismatch_flagged` engagement event, one staff
//      attention row (the founder watches the claim rate) and a product event.
//   4. Settles the money for whatever state the call is in: nothing yet while
//      it is running (the meeting end waives it), a waiver and the payout if it
//      ended uncharged, a refund if it was already charged.
//
// IDEMPOTENT. A second flag for the same call answers 200 with the same state
// and writes nothing new; it re-runs only the settlement, which is itself
// idempotent, so a refund that failed the first time is retried.
//
// The expert is never told. Nothing here sends anything to anyone.
//
// STATUS CODES (lib/matchyClient.flagMismatch reads `message`):
//   200 { ok: true, flagged: true, projectExpert }
//   409 { error: MismatchRefusal | 'conflict', message }
//   404 { error: 'project_not_found' | 'expert_not_found' }
//   403 { error: 'forbidden' }            a collaborator
//
// NEVER log: names, emails, the project name, Stripe ids. projectId and fixed
// labels only.

import { NextRequest, NextResponse } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../../../../lib/auth';
import { guardMutatingRequest, requireProjectOwner } from '../../../../../../../lib/projectsGuard';
import { getProject, getProjectForUser, mutateExpert } from '../../../../../../../lib/projectStore';
import { redactExpertForViewer } from '../../../../../../../lib/redactExpert';
import { emitEngagementEvent, recordSystemFailure } from '../../../../../../../lib/engagementEvents';
import { trackProductEvent, type ProductEventType } from '../../../../../../../lib/productEvents';
import { getFirm } from '../../../../../../../lib/firmStore';
import { settleMismatchFlag } from '../../../../../../../lib/lateCancelBilling';
import {
  mismatchEligibility,
  mismatchWindowBounds,
  type MismatchRefusal,
} from '../../../../../../../lib/mismatchGuarantee';

const ID_RE        = /^[a-f0-9]{24}$/;
const EXPERT_ID_RE = /^[a-zA-Z0-9\-_]+$/;

/** The product_events type for a claim (lib/productEvents.ProductEventType). */
const MISMATCH_PRODUCT_EVENT: ProductEventType = 'mismatch_flagged';

/** The written line for each refusal. Plain, short, no machinery. */
const REFUSAL_COPY: Record<MismatchRefusal, string> = {
  not_booked:         'There is no booked call to flag.',
  not_started:        'The call has not started yet. You can flag it in its first ten minutes.',
  window_closed:      'The first ten minutes of this call are over, so it can no longer be flagged.',
  call_not_eligible:  'This call can no longer be flagged.',
  flagged_other_call: 'A call with this expert has already been flagged.',
};

/** Thrown inside the compare-and-set to refuse without writing. */
class MismatchRefused extends Error {
  constructor(readonly reason: MismatchRefusal) { super(reason); }
}

/** Thrown inside the compare-and-set when a concurrent click already flagged this call. */
class AlreadyFlagged extends Error {
  constructor() { super('already_flagged'); }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string; expertId: string } },
): Promise<NextResponse> {
  const authErr = await routeAuthGuard(request);
  if (authErr) return authErr as NextResponse;

  const guard = await guardMutatingRequest(request);
  if ('error' in guard) return guard.error as NextResponse;

  if (!ID_RE.test(params.projectId)) {
    return NextResponse.json({ error: 'invalid_project_id' }, { status: 400 });
  }
  if (!EXPERT_ID_RE.test(params.expertId)) {
    return NextResponse.json({ error: 'invalid_expert_id' }, { status: 400 });
  }

  const { projectId, expertId } = params;

  try {
    const { email, role } = await getSessionUser(request);
    const project = await getProjectForUser(projectId, email, role);
    if (!project) return NextResponse.json({ error: 'project_not_found' }, { status: 404 });

    const pe = project.experts.find(e => e.expert.id === expertId);
    if (!pe) return NextResponse.json({ error: 'expert_not_found' }, { status: 404 });

    const ownerErr = requireProjectOwner(project, { email, role });
    if (ownerErr) return ownerErr as NextResponse;

    const now = Date.now();
    const first = mismatchEligibility(pe, now);
    if (!first.ok) {
      return NextResponse.json(
        { error: first.reason, message: REFUSAL_COPY[first.reason] },
        { status: 409 },
      );
    }

    // Decide and write in one compare-and-set. `mutate` re-runs against the
    // freshly read row on a retry; a click that lost the race to another one
    // writes nothing and answers with the state the winner created.
    let wrote = false;
    if (!first.already) {
      try {
        await mutateExpert(projectId, expertId, current => {
          const fresh = mismatchEligibility(current, now);
          if (!fresh.ok) throw new MismatchRefused(fresh.reason);
          if (fresh.already) throw new AlreadyFlagged();
          return {
            ...current,
            mismatchFlaggedAt: now,
            mismatchCallId:    fresh.callId,
            updatedAt:         now,
          };
        });
        wrote = true;
      } catch (err) {
        if (err instanceof AlreadyFlagged) {
          // Fall through: same call, same state, nothing new to record.
        } else if (err instanceof MismatchRefused) {
          return NextResponse.json(
            { error: err.reason, message: REFUSAL_COPY[err.reason] },
            { status: 409 },
          );
        } else {
          console.error('[mismatch] flag write failed:',
            err instanceof Error ? err.message.slice(0, 120) : 'unknown');
          return NextResponse.json(
            { error: 'conflict', message: 'That did not go through. Please try again.' },
            { status: 409 },
          );
        }
      }
    }

    if (wrote) {
      const bounds    = mismatchWindowBounds(pe.booking?.startUtc);
      const minutesIn = bounds ? Math.max(0, Math.floor((now - bounds.opensAt) / 60_000)) : null;
      const firm      = await getFirm(project.firmDomain).catch(() => null);
      const orgId     = firm?.id ?? null;

      await emitEngagementEvent({
        projectId, expertId, orgId,
        type:    'mismatch_flagged',
        payload: { minutesIn, callStatus: pe.status === 'completed' ? 'completed' : 'scheduled' },
      });
      // One attention row per claim: the founder watches the claim rate.
      await recordSystemFailure({
        area: 'invoice', reason: 'mismatch_guarantee_claimed', projectId, expertId,
      });
      void trackProductEvent({
        type:           MISMATCH_PRODUCT_EVENT,
        actorEmail:     email,
        organizationId: orgId,
        projectId,
        payload:        { expertId, minutesIn },
      });
      console.log('[mismatch] flagged', { projectId, minutesIn });
    }

    // The money, for whatever state the call is in. Never throws; a refund
    // that fails is on the attention list and is retried by the next click or
    // by the payment webhook.
    const settled = await settleMismatchFlag(projectId, expertId);
    if (!settled.ok) console.warn('[mismatch] settlement pending', { projectId, action: settled.action });

    const after   = await getProject(projectId).catch(() => null);
    const current = after?.experts.find(e => e.expert.id === expertId) ?? pe;

    return NextResponse.json({
      ok:            true,
      flagged:       true,
      projectExpert: redactExpertForViewer(current, { role }),
    });
  } catch (err) {
    console.error('[mismatch] failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.json(
      { error: 'mismatch_failed', message: 'That did not go through. Please try again.' },
      { status: 500 },
    );
  }
}
