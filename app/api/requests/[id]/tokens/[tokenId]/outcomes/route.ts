// POST /api/requests/[id]/tokens/[tokenId]/outcomes
//
// What the call actually covered (docs/SCREENING_FLOW_PLAN.md, build step 5).
// The client marks each objective answered / partial / unanswered afterwards
// and those rows are the other half of the product's claim: the screening said
// what the expert could speak to, this says what they did speak to.
//
// NOTHING IS BUILT ON THESE ROWS YET, DELIBERATELY. The two queries they exist
// for — gap re-match (find another expert who said yes to what this call left
// unanswered) and per-expert reliability (claimed yes vs delivered answered) —
// are written out in the migration header and are not implemented. Writing the
// data now is what makes them possible later; inventing a score from them now
// is the model commentary this whole surface refuses.
//
// PARTIAL SAVES ARE THE NORMAL CASE. A client marks the three objectives they
// got to and saves; they come back and mark the rest, or change their mind
// about one. lib/requestStore.recordOutcomes upserts on the unique
// (token_id, objective_id), so a second save moves a verdict rather than adding
// a second row — the reliability count stays honest. An EMPTY list is refused
// by the validator rather than silently accepted: a save that saved nothing is
// something the person should be told about.
//
// ACCESS: routeAuthGuard → guardMutatingRequest → getRequestForUser (404, never
// 403) → approved (409) → the candidate (404) → call requested (409
// call_not_requested: an outcome for a call nobody asked for is a row about an
// event that did not happen) → validation (400) → write. Owner or platform
// admin; the response is rebuilt through lib/screeningView, so a client still
// gets no name, no address and no expert-side rate back.
//
// Never logs: the topic, an objective, an expert's name or address, an expert's
// own words, or a verdict.

import { NextRequest } from 'next/server';
import { getRequestForUser, listCandidates, recordOutcomes } from '../../../../../../../lib/requestStore';
import { guardMutatingRequest } from '../../../../../../../lib/projectsGuard';
import { routeAuthGuard, getSessionUser } from '../../../../../../../lib/auth';
import { validateOutcomesInput, isValid } from '../../../../../../../lib/screeningValidation';
import { buildRequestView } from '../../../../../../../lib/screeningView';

const NOT_FOUND = { error: 'not_found' } as const;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string; tokenId: string } },
) {
  const authErr = await routeAuthGuard(request);
  if (authErr) return authErr;

  const guard = await guardMutatingRequest(request);
  if ('error' in guard) return guard.error;
  const { body } = guard;

  try {
    const { email, role } = await getSessionUser(request);
    const found = await getRequestForUser(params.id, email, role);
    if (!found) return Response.json(NOT_FOUND, { status: 404 });

    if (found.status !== 'approved') {
      return Response.json(
        {
          error:   'request_not_approved',
          message: 'Approve the screening set before recording what a call covered.',
        },
        { status: 409 },
      );
    }

    const candidates = await listCandidates(found.id);
    const candidate  = candidates.find(c => c.id === params.tokenId);
    if (!candidate) return Response.json(NOT_FOUND, { status: 404 });

    if (!candidate.callRequestedAt) {
      return Response.json(
        {
          error:   'call_not_requested',
          message: 'Request the call first, then mark what it covered.',
        },
        { status: 409 },
      );
    }

    const validated = validateOutcomesInput(body, found.objectives.map(o => o.id));
    if (!isValid(validated)) {
      const first = validated.errors[0];
      return Response.json(
        {
          error:   first.error,
          field:   first.field,
          message: first.message,
          errors:  validated.errors,
        },
        { status: 400 },
      );
    }

    // The empty string lib/auth.getSessionUser falls back to matches no
    // profile; null says "we do not know who marked this" honestly instead.
    const updated = await recordOutcomes(found.id, candidate.id, validated.data, email || null);
    if (!updated) return Response.json(NOT_FOUND, { status: 404 });

    const view       = buildRequestView(found, await listCandidates(found.id), { email, role });
    const respondent = view.respondents.find(r => r.id === candidate.id);
    if (!respondent) return Response.json(NOT_FOUND, { status: 404 });

    return Response.json({ respondent });
  } catch (err) {
    console.error('[api/requests/[id]/tokens/[tokenId]/outcomes] error:',
      err instanceof Error ? err.message : String(err));
    return Response.json(
      { error: 'failed_to_record_outcomes', message: 'We could not save what that call covered. Try again.' },
      { status: 500 },
    );
  }
}
