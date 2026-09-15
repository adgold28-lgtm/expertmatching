// POST /api/requests/[id]/tokens/[tokenId]/request-call
//
// The client's one action on a respondent: "I want this call"
// (docs/SCREENING_FLOW_PLAN.md, build step 5). It stamps
// `outreach_tokens.call_requested_at` and nothing else — no scheduling, no
// charge, no email. Stage 6 (Matchy) picks the stamp up; this route is the
// consent that lets it.
//
// WHY THE STATE CHECKS ARE HERE AND NOT ONLY IN THE UI. The table disables the
// button until the expert has answered and hides it once the link is revoked,
// but a disabled button is a suggestion: two tabs, a stale page and a retried
// fetch all reach this handler with the row in a state the client last saw
// minutes ago. So the row is read again and judged again:
//   not submitted → 409 not_submitted. Requesting a call with an expert who has
//       not said which objectives they can speak to is exactly the blind
//       booking this whole flow exists to stop.
//   revoked       → 409 link_revoked. The link is dead and the answers behind
//       it, if any, are not an offer.
//
// IDEMPOTENT. lib/requestStore.requestCall writes only when the stamp is null
// and reads the row back either way, so a double press returns the same time
// and the caller cannot tell the two apart. The product event is the one thing
// that must not double-count, so it is emitted only on the press that actually
// moved the row.
//
// ACCESS: routeAuthGuard → guardMutatingRequest → getRequestForUser (404, never
// 403 — a stranger must not learn a request id exists) → approved (409) → the
// candidate (404) → its state (409) → write. Owner or platform admin; the
// response is rebuilt through lib/screeningView so a client still gets no name,
// no address and no expert-side rate.
//
// Never logs: the topic, an objective, an expert's name or address, or an
// expert's own words. The product event carries two counts.

import { NextRequest } from 'next/server';
import { getRequestForUser, listCandidates, requestCall } from '../../../../../../../lib/requestStore';
import { guardMutatingRequest } from '../../../../../../../lib/projectsGuard';
import { routeAuthGuard, getSessionUser } from '../../../../../../../lib/auth';
import { buildRequestView } from '../../../../../../../lib/screeningView';
import { computeCoverage } from '../../../../../../../lib/screeningCoverage';
import { trackProductEvent } from '../../../../../../../lib/productEvents';

const NOT_FOUND = { error: 'not_found' } as const;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; tokenId: string } },
) {
  const authErr = await routeAuthGuard(request);
  if (authErr) return authErr;

  const guard = await guardMutatingRequest(request);
  if ('error' in guard) return guard.error;

  try {
    const { email, role } = await getSessionUser(request);
    const found = await getRequestForUser(params.id, email, role);
    if (!found) return Response.json(NOT_FOUND, { status: 404 });

    if (found.status !== 'approved') {
      return Response.json(
        {
          error:   'request_not_approved',
          message: 'Approve the screening set before asking for a call.',
        },
        { status: 409 },
      );
    }

    const candidates = await listCandidates(found.id);
    const candidate  = candidates.find(c => c.id === params.tokenId);
    if (!candidate) return Response.json(NOT_FOUND, { status: 404 });

    if (!candidate.submittedAt) {
      return Response.json(
        {
          error:   'not_submitted',
          message: 'This expert has not answered the screening yet.',
        },
        { status: 409 },
      );
    }

    if (candidate.revokedAt) {
      return Response.json(
        {
          error:   'link_revoked',
          message: 'This screening link was revoked, so the call cannot be requested.',
        },
        { status: 409 },
      );
    }

    // Read BEFORE the write: requestCall is idempotent and hands back the same
    // row either way, so this is the only moment that knows whether this press
    // is the one that moved it.
    const alreadyRequested = candidate.callRequestedAt !== null;

    const updated = await requestCall(found.id, candidate.id);
    if (!updated) return Response.json(NOT_FOUND, { status: 404 });

    if (!alreadyRequested) {
      const coverage = computeCoverage(candidate.responses);
      void trackProductEvent({
        type:           'call_requested',
        actorEmail:     email,
        organizationId: found.organizationId,
        payload: { yes: coverage.yes, total: coverage.total },
      });
    }

    const view       = buildRequestView(found, await listCandidates(found.id), { email, role });
    const respondent = view.respondents.find(r => r.id === candidate.id);
    if (!respondent) return Response.json(NOT_FOUND, { status: 404 });

    return Response.json({ respondent });
  } catch (err) {
    console.error('[api/requests/[id]/tokens/[tokenId]/request-call] error:',
      err instanceof Error ? err.message : String(err));
    return Response.json(
      { error: 'failed_to_request_call', message: 'We could not request that call. Try again.' },
      { status: 500 },
    );
  }
}
