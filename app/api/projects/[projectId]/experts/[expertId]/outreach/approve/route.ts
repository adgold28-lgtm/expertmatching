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
// THE PERSONAL LINE (docs/OUTREACH_EMAIL_RUBRIC.md). The intro's first line is
// a fact about the expert's career. When Matchy could not write one it trusts,
// the step leaves the expert at `outreach_drafted` with `introNeedsWhyThem`,
// and this route answers 409 `why_them_required` until a line arrives in the
// body as `{ whyThem }`. ONLY A PLATFORM ADMIN may send that field: the owner
// is a client who does not know who the expert is before the reveal, so a
// line they wrote could only be a guess or a leak — 403 `staff_only`. The
// line is screened like any other client→expert text (lib/matchyScreen.ts,
// any finding blocks), checked against the rubric (no em dash, no banned
// phrase), capped at 200 characters, given the rubric's closing clause when
// the admin wrote only the fact, and persisted BEFORE the step runs so the
// step picks it up.
//
// WALKTHROUGH MODE: 409 `walkthrough_mode`, before any side effect. In
// walkthrough the bookmark already leaves the intro at `outreach_drafted`, so
// this button is exactly where an impatient client would try to leave the
// building; it says so instead of sending.
//
// ONLY FROM `outreach_drafted`. Any other status means the intro already went
// out (or the expert was rejected), and approving again would be a second cold
// email to the same person. lib/outreachSteps backs that up with a send-once
// guard on the row itself, so a double click that gets past this status check
// (two requests reading `outreach_drafted` at the same moment) still sends
// exactly one email; the second answers `intro_sent` with nothing sent and no
// event emitted.
//
// Never logs: expert name, expert email, project name, token, email content,
// the why-them line.

import { NextRequest, NextResponse } from 'next/server';
import { getSessionUser } from '../../../../../../../../lib/auth';
import { guardMutatingRequest } from '../../../../../../../../lib/projectsGuard';
import { getProjectForUser, updateExpertStatus } from '../../../../../../../../lib/projectStore';
import { runSequenceStep } from '../../../../../../../../lib/outreachSteps';
import { isSuppressed } from '../../../../../../../../lib/outreachSuppressions';
import { emitEngagementEvent } from '../../../../../../../../lib/engagementEvents';
import { redactExpertForViewer } from '../../../../../../../../lib/redactExpert';
import { getFirm } from '../../../../../../../../lib/firmStore';
import { clientRateFor } from '../../../../../../../../lib/pricing';
import { isWalkthrough } from '../../../../../../../../lib/walkthrough';
import { screenMessage } from '../../../../../../../../lib/matchyScreen';
import { whyThemRejection, withWhyThemClause } from '../../../../../../../../lib/introPersonalization';

const ID_RE        = /^[a-f0-9]{24}$/;
const EXPERT_ID_RE = /^[a-zA-Z0-9\-_]+$/;

/** Longest why-them line staff may submit. The rubric's whole body is under 90 words. */
const MAX_WHY_THEM_CHARS = 200;
/** 200 characters is about 35 words; the word cap is the backstop, not the rule. */
const MAX_WHY_THEM_WORDS = 40;

const WHY_THEM_REQUIRED_MESSAGE = 'Matchy could not write the personal line for this intro. Add it, then send.';

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

    // The personal line, if one was sent. Staff only — checked before anything
    // else so a client never learns whether the field does something.
    const rawWhyThem = guard.body.whyThem;
    if (rawWhyThem !== undefined) {
      if (role !== 'admin') {
        return NextResponse.json(
          { error: 'staff_only', message: 'Only ExpertMatch staff can write the personal line of an intro.' },
          { status: 403 },
        );
      }
      if (typeof rawWhyThem !== 'string' || !rawWhyThem.trim()) {
        return NextResponse.json({ error: 'invalid_why_them' }, { status: 400 });
      }
      if (rawWhyThem.trim().length > MAX_WHY_THEM_CHARS) {
        return NextResponse.json(
          { error: 'invalid_why_them', message: `Keep the personal line under ${MAX_WHY_THEM_CHARS} characters.` },
          { status: 400 },
        );
      }
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

    if (pe.introNeedsWhyThem && rawWhyThem === undefined) {
      return NextResponse.json(
        { error: 'why_them_required', message: WHY_THEM_REQUIRED_MESSAGE },
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

<<<<<<< HEAD
    // Screen, lint and persist the staff line before the step runs.
    if (typeof rawWhyThem === 'string') {
      const line = withWhyThemClause(rawWhyThem);

      const screen = screenMessage({
        text:           line,
        direction:      'client_to_expert',
        clientFirmName: firm?.name,
        expertFullName: pe.expert.name,
      });
      if (screen.findings.length > 0) {
        return NextResponse.json(
          {
            error:    'why_them_blocked',
            message:  'The personal line cannot go out as written.',
            findings: screen.findings.map(f => ({ kind: f.kind, hint: f.hint })),
          },
          { status: 422 },
        );
      }

      const rejection = whyThemRejection(line, { requireSecondPerson: false, maxWords: MAX_WHY_THEM_WORDS });
      if (rejection) {
        return NextResponse.json(
          {
            error:   'why_them_rubric',
            reason:  rejection,
            message: 'The personal line breaks the outreach rubric (no em dashes, no banned phrases, under 30 words).',
          },
          { status: 422 },
        );
      }

      await updateExpertStatus(params.projectId, params.expertId, {
        whyThem:           line,
        introNeedsWhyThem: false,
      });
    }

=======
    // IDENTICAL DENY LIST TO THE BOOKMARK ROUTE (M-29). `firmName` is never
    // written into the email: lib/matchyTemplates.deriveTopic takes it as a
    // deny term so a research question containing the client's own firm name
    // cannot reach the expert. The review-first path must not be blinded any
    // less carefully than the auto-sent one.
>>>>>>> 5e21428 (fix(outreach): suppression at the send chokepoint, send-once intro, held outcomes honoured)
    const result = await runSequenceStep({
      projectId: params.projectId,
      expertId:  params.expertId,
      step:      'intro',
      token:     pe.outreachToken ?? '',
      firmType:  firm?.firmType ?? null,
      firmSize:  firm?.firmSize ?? null,
      firmName:  firm?.name ?? null,
      draftOnly: false,
    });

    if (!result.ok) {
      console.warn('[outreach/approve] intro not sent', JSON.stringify({ reason: result.error }));
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    const updated = result.project.experts.find(e => e.expert.id === params.expertId) ?? pe;

<<<<<<< HEAD
    // The step can decline to send: it holds an intro it has no personal line
    // for (a draft that predates the rubric, or a line that broke it), and the
    // send chokepoint can refuse. Neither is an `intro_sent`.
    if (updated.status !== 'contacted') {
      if (updated.introNeedsWhyThem) {
        return NextResponse.json(
          { error: 'why_them_required', message: WHY_THEM_REQUIRED_MESSAGE },
          { status: 409 },
        );
      }
      return NextResponse.json({
        ok:            true,
        projectExpert: redactExpertForViewer(updated, { role }),
        outcome:       'intro_drafted',
=======
    // The send-once guard refused: this expert already has the intro (a double
    // click, or a bookmark that raced the approval). Nothing was sent and
    // nothing was written, so no `intro_sent` event is emitted for it either —
    // the engagement_events stream must not record two intros for one email.
    if (result.alreadySent) {
      return NextResponse.json({
        ok:            true,
        projectExpert: redactExpertForViewer(updated, { role }),
        outcome:       'intro_sent',
>>>>>>> 5e21428 (fix(outreach): suppression at the send chokepoint, send-once intro, held outcomes honoured)
      });
    }

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
        introArm:   updated.introArm ?? null,
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
