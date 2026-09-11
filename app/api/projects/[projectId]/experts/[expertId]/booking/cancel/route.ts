// The client's side of cancelling a booked call.
//
//   GET  /api/projects/:projectId/experts/:expertId/booking/cancel
//        → { window, fee } — what the confirm dialog has to say before it asks
//   POST /api/projects/:projectId/experts/:expertId/booking/cancel
//        { reason?, confirmLate? } → cancels it
//
// THE POLICY is docs/CALL_POLICIES_DRAFT.md founder decisions 1, 2 and 4, and
// it lives in lib/callPolicies.ts: more than 24 hours out the cancel is free;
// inside 24 hours it is a LATE cancel and the client is charged 15 minutes at
// the agreed rate while the expert is paid 15 minutes at theirs. A late cancel
// is refused with `409 late_not_confirmed` and the fee UNTIL the body carries
// `confirmLate: true`, so the number is always on screen before the money
// moves. The GET exists for exactly that dialog.
//
// WHO MAY: the project owner or a platform admin, the same rule as
// propose-times — collaborators are read-only and get the same 403, an
// inaccessible project is 404 so the route never confirms one exists.
//
// STATUS CODES, which lib/matchyClient-shaped callers key off:
//   200 { ok: true, outcome, fee, projectExpert }
//   409 { error: 'late_not_confirmed', fee }   the confirm step
//   409 { error: 'not_booked' | 'already_cancelled' | 'conflict' | 'locked' }
//   404 { error: 'project_not_found' | 'expert_not_found' }
//
// The engagement on the response goes through redactExpertForViewer like every
// other client-facing expert payload.
//
// Never logs: the reason text, either address, the project name, the time.

import { NextRequest, NextResponse } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../../../../../lib/auth';
import { guardMutatingRequest, guardReadRequest, requireProjectOwner } from '../../../../../../../../lib/projectsGuard';
import { getProjectForUser } from '../../../../../../../../lib/projectStore';
import { redactExpertForViewer } from '../../../../../../../../lib/redactExpert';
import { cancelCall } from '../../../../../../../../lib/bookCall';
import { cancelWindow, lateCancelFee } from '../../../../../../../../lib/callPolicies';

const ID_RE        = /^[a-f0-9]{24}$/;
const EXPERT_ID_RE = /^[a-zA-Z0-9\-_]+$/;

/** Longest cancellation reason a client may attach. Stored, never logged. */
const MAX_REASON_CHARS = 500;

export async function GET(
  request: NextRequest,
  { params }: { params: { projectId: string; expertId: string } },
): Promise<NextResponse> {
  const guard = guardReadRequest(request);
  if (guard) return guard as NextResponse;

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

    const ownerErr = requireProjectOwner(project, { email, role });
    if (ownerErr) return ownerErr as NextResponse;

    if (!pe.booking || pe.booking.cancelledAt) {
      return NextResponse.json({ error: 'not_booked' }, { status: 409 });
    }

    return NextResponse.json({
      window: cancelWindow(Date.now(), pe.booking.startUtc),
      fee:    lateCancelFee(pe.expertRate ?? 0),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    console.error('[booking/cancel] preview failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.json({ error: 'cancel_failed' }, { status: 500 });
  }
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

  const rawReason = guard.body.reason;
  if (rawReason !== undefined && typeof rawReason !== 'string') {
    return NextResponse.json({ error: 'invalid_reason' }, { status: 400 });
  }
  const reason = (rawReason ?? '').trim().slice(0, MAX_REASON_CHARS);

  const confirmLate = guard.body.confirmLate === true;

  try {
    const { email, role } = await getSessionUser(request);
    const project = await getProjectForUser(params.projectId, email, role);
    if (!project) return NextResponse.json({ error: 'project_not_found' }, { status: 404 });

    const pe = project.experts.find(e => e.expert.id === params.expertId);
    if (!pe) return NextResponse.json({ error: 'expert_not_found' }, { status: 404 });

    const ownerErr = requireProjectOwner(project, { email, role });
    if (ownerErr) return ownerErr as NextResponse;

    const result = await cancelCall({
      projectId: params.projectId,
      expertId:  params.expertId,
      by:        'client',
      ...(reason ? { reason } : {}),
      confirmLate,
    });

    if (!result.ok) {
      // Every refusal is a 409: the request was well formed and the caller is
      // allowed, the engagement is simply not in a state that can be cancelled
      // (or, for late_not_confirmed, not yet).
      return NextResponse.json(
        { error: result.error, ...(result.fee ? { fee: result.fee } : {}) },
        { status: 409 },
      );
    }

    const current = result.project.experts.find(e => e.expert.id === params.expertId) ?? pe;

    return NextResponse.json({
      ok:            true,
      outcome:       result.outcome,
      window:        result.window,
      fee:           result.fee,
      projectExpert: redactExpertForViewer(current, { role }),
    });
  } catch (err) {
    console.error('[booking/cancel] failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return NextResponse.json({ error: 'cancel_failed' }, { status: 500 });
  }
}
