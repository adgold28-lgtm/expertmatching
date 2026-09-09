// POST /api/projects/:projectId/experts/:expertId/propose-times
//
// The client asks Matchy to find a time. Body:
//   { reason?: 'initial' | 'reschedule'; preferences?: string }
//
// WHAT IT DOES. lib/matchyScheduling.proposeTimes reads the OWNER's calendar
// (whatever they linked during onboarding), intersects it with the expert's
// when the expert has connected one, cuts the result into up to three 60-minute
// slots inside the owner's business day, emails them with a private picker
// link, and moves the expert to 'scheduling_sent'. The client never types a
// time and never sees the expert's address.
//
// PREFERENCES are a client sentence ("Tuesday or Thursday afternoons"), so they
// are SCREENED client→expert before they are stored, exactly like a message on
// the thread: a preference that smuggles a phone number is a preference that
// would reach an expert through the proposal round it shapes. Blocked is 422
// with the findings and nothing is written.
//
// WHO MAY: the project owner or a platform admin. Collaborators are read-only
// (docs/MATCHY_SPEC.md, founder answer 5) and get 403. 404 rather than 403 on
// an inaccessible project, so the route never confirms a project exists.
//
// THE OUTCOMES, all of them 200:
//   times_proposed        slots emailed, status 'scheduling_sent'
//   link_sent             no usable overlap, so just the picker link
//   reschedule_requested  a booked call, and we asked to move it
//   no_client_availability the owner has no usable calendar connection; NOTHING
//                         was sent and the client is told to link one
//
// WALKTHROUGH MODE (lib/walkthrough.ts): the email is held, the outbound line
// is written to the thread marked held so the client can read it, the status
// does NOT advance, and the response carries `held: true`. The picker token is
// not persisted either, so the dead link in that preview can never book a call.
//
// Never logs: expert name, expert email, project name, token, preference text.

import { NextRequest, NextResponse } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../../../../lib/auth';
import { guardMutatingRequest, requireProjectOwner } from '../../../../../../../lib/projectsGuard';
import { getProjectForUser } from '../../../../../../../lib/projectStore';
import { screenMessage } from '../../../../../../../lib/matchyScreen';
import { redactExpertForViewer, isIdentityRevealed } from '../../../../../../../lib/redactExpert';
import { proposeTimes } from '../../../../../../../lib/matchyScheduling';
import { getFirm, getUser } from '../../../../../../../lib/firmStore';
import type { ExpertStatus, Project } from '../../../../../../../types';

const ID_RE        = /^[a-f0-9]{24}$/;
const EXPERT_ID_RE = /^[a-zA-Z0-9\-_]+$/;

/** Longest preference line a client may attach. Matches SchedulingState. */
const MAX_PREFERENCE_CHARS = 200;

/**
 * Where an engagement may be when the client first asks for times. Anything
 * earlier has not had a conversation yet; anything later is already booked or
 * finished. 'scheduling_sent' is included on purpose: asking again is how a
 * client sends a second round when the expert has gone quiet.
 */
const READY_TO_SCHEDULE: ReadonlySet<ExpertStatus> = new Set<ExpertStatus>([
  'replied', 'followup_sent', 'rate_negotiation', 'scheduling_sent',
]);

/**
 * The two names the compliance screen needs. Best-effort: a name we do not
 * have is a check the screen cannot run, not a reason to refuse the request.
 */
async function loadScreenContext(project: Project, fallbackEmail: string) {
  const firm = await getFirm(project.firmDomain).catch(() => null);

  let clientFullName = project.clientName?.trim() || undefined;
  if (!clientFullName) {
    const owner = await getUser(project.ownerEmail || fallbackEmail).catch(() => null);
    const parts = [owner?.firstName, owner?.lastName].filter(Boolean);
    if (parts.length > 0) clientFullName = parts.join(' ');
  }

  return { clientFirmName: firm?.name?.trim() || undefined, clientFullName };
}

export async function POST(
  request: NextRequest,
  { params }: { params: { projectId: string; expertId: string } },
): Promise<NextResponse> {
  // 1. Auth (defence in depth on top of middleware) and the mutating guard.
  const authErr = await routeAuthGuard(request);
  if (authErr) return authErr as NextResponse;

  const guard = await guardMutatingRequest(request);
  if ('error' in guard) return guard.error as NextResponse;

  // 2. Ids and body.
  if (!ID_RE.test(params.projectId)) {
    return NextResponse.json({ error: 'invalid_project_id' }, { status: 400 });
  }
  if (!EXPERT_ID_RE.test(params.expertId)) {
    return NextResponse.json({ error: 'invalid_expert_id' }, { status: 400 });
  }

  const rawReason = guard.body.reason ?? 'initial';
  if (rawReason !== 'initial' && rawReason !== 'reschedule') {
    return NextResponse.json(
      { error: 'invalid_reason', message: "reason must be 'initial' or 'reschedule'." },
      { status: 400 },
    );
  }
  const reason: 'initial' | 'reschedule' = rawReason;

  const rawPreferences = guard.body.preferences;
  if (rawPreferences !== undefined && typeof rawPreferences !== 'string') {
    return NextResponse.json({ error: 'invalid_preferences' }, { status: 400 });
  }
  const preferences = (rawPreferences ?? '').trim();
  if (preferences.length > MAX_PREFERENCE_CHARS) {
    return NextResponse.json(
      { error: 'preferences_too_long', message: `Keep it under ${MAX_PREFERENCE_CHARS} characters.` },
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

    // 4. Only the owner (or staff) acts on an expert.
    const ownerErr = requireProjectOwner(project, { email, role });
    if (ownerErr) return ownerErr as NextResponse;

    // 5. There has to be a thread to propose on.
    if (!pe.contactEmail || !pe.outreachToken) {
      return NextResponse.json(
        { error: 'thread_not_started', message: 'Nothing has been sent to this expert yet.' },
        { status: 422 },
      );
    }

    // 6. The right point in the funnel.
    if (reason === 'initial' && !READY_TO_SCHEDULE.has(pe.status)) {
      return NextResponse.json(
        { error: 'not_ready_to_schedule', message: 'This expert is not at the scheduling stage yet.' },
        { status: 409 },
      );
    }
    if (reason === 'reschedule' && (pe.status !== 'scheduled' || !pe.booking)) {
      return NextResponse.json(
        { error: 'nothing_booked', message: 'There is no booked call to move.' },
        { status: 409 },
      );
    }

    // 7. Screen the preference the same way a typed message is screened.
    if (preferences) {
      const { clientFirmName, clientFullName } = await loadScreenContext(project, email);
      const screened = screenMessage({
        text:             preferences,
        direction:        'client_to_expert',
        identityRevealed: isIdentityRevealed(pe),
        clientFirmName,
        expertFullName:   pe.expert.name,
        clientFullName,
      });
      if (screened.blocked) {
        return NextResponse.json(
          { error: 'message_blocked', findings: screened.findings },
          { status: 422 },
        );
      }
    }

    // 8. Do the thing.
    const result = await proposeTimes({
      project, pe, reason,
      preferences: preferences || null,
      trigger:     'client',
    });

    if (!result.outcome) {
      // proposeTimes only returns null when there is no thread (checked above)
      // or a token could not be minted — an environment fault, not a user one.
      return NextResponse.json({ error: 'propose_times_failed' }, { status: 500 });
    }

    const current = result.project.experts.find(e => e.expert.id === params.expertId) ?? pe;

    return NextResponse.json({
      ok:            true,
      projectExpert: redactExpertForViewer(current, { role }),
      outcome:       result.outcome,
      ...(result.held && { held: true }),
    });
  } catch (err) {
    console.error('[propose-times] failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.json({ error: 'propose_times_failed' }, { status: 500 });
  }
}
