// POST /api/projects/:projectId/experts/:expertId/outreach/approve
//
// The other half of the "review first" switch. On a review-first project the
// bookmark writes the intro to `outreachSubject` / `outreachDraft` and leaves
// the expert at `outreach_drafted` without sending anything
// (lib/outreachSteps.runSequenceStep with draftOnly). This route is the button
// that sends it.
//
// It re-runs the SAME step — `runSequenceStep({ step: 'intro' })` with
// draftOnly off — rather than mailing the stored draft directly, so there is
// exactly one implementation of "send the intro": one place that resolves the
// reply token, indexes it in Redis for inbound lookup, sends through Resend and
// writes the status. Approving cannot drift from auto-sending.
//
// WHO MAY: the project owner or a platform admin. Collaborators are read-only
// (docs/MATCHY_SPEC.md, founder answer 5). 404 rather than 403 on an
// inaccessible project.
//
// WALKTHROUGH MODE: 409 `walkthrough_mode`, before any side effect. In
// walkthrough the bookmark already leaves the intro at `outreach_drafted`, so
// this button is exactly where an impatient client would try to leave the
// building; it says so instead of sending.
//
// ONLY FROM `outreach_drafted`. Any other status means the intro already went
// out (or the expert was rejected), and approving again would be a second cold
// email to the same person.
//
// Never logs: expert name, expert email, project name, token, email content.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '../../../../../../../../lib/auth';
import { guardMutatingRequest } from '../../../../../../../../lib/projectsGuard';
import { getProjectForUser } from '../../../../../../../../lib/projectStore';
import { runSequenceStep } from '../../../../../../../../lib/outreachSteps';
import { isSuppressed } from '../../../../../../../../lib/outreachSuppressions';
import { emitEngagementEvent } from '../../../../../../../../lib/engagementEvents';
import { redactExpertForViewer } from '../../../../../../../../lib/redactExpert';
import { getFirm } from '../../../../../../../../lib/firmStore';
import { clientRateFor } from '../../../../../../../../lib/pricing';
import { isWalkthrough } from '../../../../../../../../lib/walkthrough';

const ID_RE        = /^[a-f0-9]{24}$/;
const EXPERT_ID_RE = /^[a-zA-Z0-9\-_]+$/;

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string; expertId: string } },
): Promise<NextResponse> {
  const guard = await guardMutatingRequest(request);
  if ('error' in guard) return guard.error as NextResponse;

  if (!ID_RE.test(params.projectId)) {
    return NextResponse.json({ error: 'invalid_project_id' }, { status: 400 });
  }
  if (!EXPERT_ID_RE.test(params.expertId)) {
    return NextResponse.json({ error: 'invalid_expert_id' }, { status: 400 });
  }

  try {
    const { email, role } = await getSessionUser(request);
    const project = await getProjectForUser(params.projectId, email, role);
    if (!project) return NextResponse.json({ error: 'project_not_found' }, { status: 404 });

    const pe = project.experts.find(e => e.expert.id === params.expertId);
    if (!pe) return NextResponse.json({ error: 'expert_not_found' }, { status: 404 });

    if (role !== 'admin' && project.ownerEmail !== email) {
      return NextResponse.json(
        { error: 'read_only', message: 'Only the project owner can approve outreach.' },
        { status: 403 },
      );
    }

    // Walkthrough: nothing may be sent from this project at all. Refuse before
    // any side effect — no suppression lookup, no status write, no Resend call.
    if (isWalkthrough(project)) {
      return NextResponse.json(
        {
          error:   'walkthrough_mode',
          message: 'Nothing is sent in walkthrough mode. Switch the project to live first.',
        },
        { status: 409 },
      );
    }

    if (pe.status !== 'outreach_drafted') {
      return NextResponse.json(
        { error: 'not_awaiting_approval', message: 'There is no draft waiting to be sent to this expert.' },
        { status: 409 },
      );
    }

    if (!pe.contactEmail) {
      return NextResponse.json(
        { error: 'no_contact_email', message: 'I do not have an address for this expert yet.' },
        { status: 422 },
      );
    }

    // The global do-not-contact list can have gained this address between the
    // draft and the approval. Fails CLOSED — if we cannot check, we do not send.
    const suppression = await isSuppressed(pe.contactEmail);
    if (!suppression.ok || suppression.suppressed) {
      return NextResponse.json(
        {
          error:   suppression.ok ? 'contact_suppressed' : 'contact_check_unavailable',
          message: suppression.ok
            ? 'This expert has opted out of outreach.'
            : 'I could not check the opt-out list, so I have not sent anything.',
        },
        { status: 409 },
      );
    }

    const firm = await getFirm(project.firmDomain).catch(() => null);

    const result = await runSequenceStep({
      projectId: params.projectId,
      expertId:  params.expertId,
      step:      'intro',
      token:     pe.outreachToken ?? '',
      firmType:  firm?.firmType ?? null,
      firmSize:  firm?.firmSize ?? null,
      draftOnly: false,
    });

    if (!result.ok) {
      console.warn('[outreach/approve] intro not sent', JSON.stringify({ reason: result.error }));
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    const updated = result.project.experts.find(e => e.expert.id === params.expertId) ?? pe;

    const expertRate = updated.expertRate ?? 0;
    await emitEngagementEvent({
      projectId: params.projectId,
      expertId:  params.expertId,
      orgId:     firm?.id ?? null,
      type:      'intro_sent',
      payload:   {
        hasAddress: true,
        approved:   true,
        tier:       updated.expert.seniorityTier ?? 'unknown',
        expertRate,
        clientRate: expertRate > 0 ? clientRateFor(expertRate) : 0,
      },
    });

    return NextResponse.json({
      ok:            true,
      projectExpert: redactExpertForViewer(updated, { role }),
      outcome:       'intro_sent',
    });
  } catch (err) {
    console.error('[outreach/approve] failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.json({ error: 'approve_failed' }, { status: 500 });
  }
}
