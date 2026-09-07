// POST /api/projects/:projectId/experts/:expertId/rate-decision
//
// The client settles a rate. Body: { action: 'accept' | 'counter' }.
//
// WHY THIS ROUTE EXISTS AT ALL. The client's decision card shows CLIENT-side
// dollars ("Casey wants $1,300/hr — that's what you'd pay"). Before this route
// the Accept / Offer buttons posted that sentence to .../messages, which emails
// the text verbatim — so the expert received the number that includes our fee.
// docs/MATCHY_SPEC.md, "Pricing rule": the two numbers never share a message,
// and the expert only ever sees the expert-side one. So the button now sends an
// ACTION, no text, and Matchy writes the outbound line from a template that can
// only ever carry `expertRate` (lib/matchyTemplates.rateAccepted/rateCounter).
//
//   accept  → the expert's counter becomes the agreed rate.
//             expertRate = expertCounterRate, clientRate = clientRateFor(it)
//             (written together by projectStore.rateFieldsFor, never apart).
//   counter → the client holds at their standing rate. The expert-side figure
//             is expertRateFor(clientRate) — pricing.ts is the only place the
//             two convert.
//
// WHO MAY: the project owner or a platform admin. Collaborators are read-only
// (spec, founder answer 5) and get 403. 404 rather than 403 on an inaccessible
// project, so the route never confirms that a project exists.
//
// STATUS IS NOT TOUCHED. There is no "rate agreed" status in
// lib/expertPipeline.ts and this is not the place to invent one: an engagement
// advances when the expert replies (POST /api/inbound-email classifies it), and
// until then 'rate_negotiation' is exactly where this sits. What changes here
// is the money and the outstanding counter.
//
// NO ADDRESS EVER LEAVES THIS ROUTE, and the response goes through
// redactExpertForViewer, so a client never receives `expertRate`.
//
// Never logs: expert name, expert email, project name, token, message text.

import { NextRequest, NextResponse } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../../../../lib/auth';
import { guardMutatingRequest, requireProjectOwner } from '../../../../../../../lib/projectsGuard';
import { getProjectForUser, updateExpertStatus, rateFieldsFor } from '../../../../../../../lib/projectStore';
import { appendMessage } from '../../../../../../../lib/conversations';
import { expertRateFor } from '../../../../../../../lib/pricing';
import { rateAcceptedTemplate, rateCounterTemplate } from '../../../../../../../lib/matchyTemplates';
import { sendSequenceEmail } from '../../../../../../../lib/emailSequence';
import { emitEngagementEvent } from '../../../../../../../lib/engagementEvents';
import { redactExpertForViewer } from '../../../../../../../lib/redactExpert';
import { getFirm } from '../../../../../../../lib/firmStore';
import type { EngagementEventType } from '../../../../../../../lib/engagementEvents';

const ID_RE        = /^[a-f0-9]{24}$/;
const EXPERT_ID_RE = /^[a-zA-Z0-9\-_]+$/;

type RateAction = 'accept' | 'counter';

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string; expertId: string } },
): Promise<NextResponse> {
  // 1. Auth (defence in depth on top of middleware) and the mutating guard.
  const authErr = await routeAuthGuard(request);
  if (authErr) return authErr as NextResponse;

  const guard = await guardMutatingRequest(request);
  if ('error' in guard) return guard.error as NextResponse;

  // 2. Ids and action
  if (!ID_RE.test(params.projectId)) {
    return NextResponse.json({ error: 'invalid_project_id' }, { status: 400 });
  }
  if (!EXPERT_ID_RE.test(params.expertId)) {
    return NextResponse.json({ error: 'invalid_expert_id' }, { status: 400 });
  }

  const action = guard.body.action;
  if (action !== 'accept' && action !== 'counter') {
    return NextResponse.json(
      { error: 'invalid_action', message: "action must be 'accept' or 'counter'." },
      { status: 400 },
    );
  }

  try {
    // 3. Access — 404 on inaccessible so we never leak project existence.
    const { email, role } = await getSessionUser(request);
    const project = await getProjectForUser(params.projectId, email, role);
    if (!project) return NextResponse.json({ error: 'project_not_found' }, { status: 404 });

    const pe = project.experts.find(e => e.expert.id === params.expertId);
    if (!pe) return NextResponse.json({ error: 'expert_not_found' }, { status: 404 });

    // 4. Only the owner (or staff) settles money.
    const ownerErr = requireProjectOwner(project, { email, role });
    if (ownerErr) return ownerErr as NextResponse;

    // 5. The expert-side number, and the line that carries it.
    const decision = resolveDecision(action as RateAction, pe.expertCounterRate, pe.clientRate);
    if ('error' in decision) {
      return NextResponse.json({ error: decision.error, message: decision.message }, { status: 409 });
    }

    const rates = rateFieldsFor(decision.expertRate);
    const text  = action === 'accept'
      ? rateAcceptedTemplate({ firstName: pe.expert.name, expertRate: rates.expertRate })
      : rateCounterTemplate({ firstName: pe.expert.name, expertRate: rates.expertRate });

    // 6. Tell the expert. An engagement with no address yet (bookmark ended in
    //    `contact_not_found`) still records the decision — the line is stored
    //    on the thread, the send is skipped, and nothing throws. Same shape the
    //    bookmark route uses when there is nobody to write to.
    if (pe.contactEmail && pe.outreachToken) {
      const base    = pe.outreachSubject?.trim() || 'Paid expert call';
      const subject = /^re:/i.test(base) ? base : `Re: ${base}`;
      await sendSequenceEmail(pe.contactEmail, subject, text, pe.outreachToken, 'rate_decision');
    }

    // 7. The money. clientRate is never written on its own — rateFieldsFor
    //    derives it so the two can never drift. The expert's counter is settled
    //    either way: accepted, or answered with our standing number. Inbound
    //    writes a fresh one if they come back again.
    const updated = await updateExpertStatus(params.projectId, params.expertId, {
      ...rates,
      expertCounterRate: null,
      clientCounterRate: null,
    });

    const current = updated.experts.find(e => e.expert.id === params.expertId) ?? pe;

    // 8. The thread copy. `maskCurrency` in lib/conversations takes the amount
    //    back out on the way to a client's screen — this body is written for
    //    the expert.
    await appendMessage({
      projectId: params.projectId,
      expertId:  params.expertId,
      direction: 'outbound',
      author:    'matchy',
      bodyClean: text,
      summary:   action === 'accept'
        ? 'Rate agreed. Finding a time next.'
        : 'Held at your rate. Waiting on their answer.',
    });

    const firm  = await getFirm(project.firmDomain).catch(() => null);
    const type: EngagementEventType = action === 'accept' ? 'rate_agreed' : 'rate_offered';
    await emitEngagementEvent({
      projectId: params.projectId,
      expertId:  params.expertId,
      orgId:     firm?.id ?? null,
      type,
      payload:   { expertRate: rates.expertRate, clientRate: rates.clientRate, sent: !!pe.contactEmail },
    });

    return NextResponse.json({
      ok:            true,
      projectExpert: redactExpertForViewer(current, { role }),
    });
  } catch (err) {
    console.error('[rate-decision] failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.json({ error: 'rate_decision_failed' }, { status: 500 });
  }
}

interface DecisionError { error: string; message: string }

/**
 * The expert-side number this decision quotes, or the 409 that says why there
 * is none. Pure — the only arithmetic is lib/pricing's.
 */
function resolveDecision(
  action: RateAction,
  expertCounterRate: number | null | undefined,
  clientRate: number | null | undefined,
): { expertRate: number } | DecisionError {
  if (action === 'accept') {
    if (typeof expertCounterRate !== 'number' || expertCounterRate <= 0) {
      return {
        error:   'no_counter_rate',
        message: 'There is no counter-offer to accept.',
      };
    }
    return { expertRate: expertCounterRate };
  }

  // The client holds at the rate already on the engagement. It is a client-side
  // number, so it converts before it can be quoted.
  if (typeof clientRate !== 'number' || clientRate <= 0) {
    return {
      error:   'no_standing_rate',
      message: 'There is no rate on this engagement yet.',
    };
  }
  const expertRate = expertRateFor(clientRate);
  if (expertRate <= 0) {
    return {
      error:   'no_standing_rate',
      message: 'There is no rate on this engagement yet.',
    };
  }
  return { expertRate };
}
