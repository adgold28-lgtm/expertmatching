// POST /api/admin/attendance — the staff answer to "who actually turned up?".
//
// Platform admins only (adminGuard; middleware.ts also 404s /api/admin/* for
// non-admins, so this is defence in depth).
//
// WHY THIS ROUTE EXISTS. Zoom only tells us who joined when the
// `meeting.participant_joined` subscription is enabled and the participant is
// identifiable. When the telemetry is missing or ambiguous, the Zoom webhook
// refuses to guess: it parks the engagement with `attendanceReviewPending` and
// records an `invoice` / `attendance_unconfirmed` system failure so the row
// lands on the admin attention feed (docs/CALL_POLICIES_DRAFT.md — a client is
// never charged a no-show fee on missing telemetry). This route is where a
// human resolves that, and it runs EXACTLY the branch the webhook would have
// run, through the same lib/lateCancelBilling.applyAttendanceOutcome:
//
//   both           → status 'completed' and the ordinary charge, over the
//                    measured duration, else the booked one
//   client_no_show → engagement ends, no_show event, the 15-minute fee
//   expert_no_show → engagement ends, no_show event, the expert is removed
//                    from the platform; no charge, no payout
//   neither        → engagement ends with no money at all
//
// Body: { projectId, expertId, outcome }
// Answers: 200 { ok: true, outcome, charged }
//          400 { error: 'invalid_json' | 'projectId_and_expertId_required'
//                       | 'invalid_outcome' }
//          404 { error: 'not_found' }
//          500 { error: 'internal_error' }
//
// NEVER log or return: emails, names, project names, research content.

import { NextRequest } from 'next/server';
import { adminGuard } from '../../../../lib/auth';
import { getProject } from '../../../../lib/projectStore';
import {
  applyAttendanceOutcome,
  type AttendanceOutcome,
} from '../../../../lib/lateCancelBilling';

const OUTCOMES: readonly AttendanceOutcome[] = ['both', 'client_no_show', 'expert_no_show', 'neither'];

function isOutcome(value: unknown): value is AttendanceOutcome {
  return typeof value === 'string' && (OUTCOMES as readonly string[]).includes(value);
}

export async function POST(request: NextRequest): Promise<Response> {
  const authError = await adminGuard(request);
  if (authError) return authError;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const b         = body as Record<string, unknown>;
  const projectId = typeof b.projectId === 'string' ? b.projectId.trim() : '';
  const expertId  = typeof b.expertId  === 'string' ? b.expertId.trim()  : '';

  if (!projectId || !expertId) {
    return Response.json({ error: 'projectId_and_expertId_required' }, { status: 400 });
  }
  if (!isOutcome(b.outcome)) {
    return Response.json(
      { error: 'invalid_outcome', message: `outcome must be one of: ${OUTCOMES.join(', ')}` },
      { status: 400 },
    );
  }
  const outcome = b.outcome;

  try {
    // Platform admin, so the unscoped read is correct here — the same one the
    // Zoom webhook uses. Per-user access control does not apply to staff.
    const project = await getProject(projectId);
    const pe      = project?.experts.find(e => e.expert.id === expertId);
    if (!project || !pe) return Response.json({ error: 'not_found' }, { status: 404 });

    // The minutes the 'both' branch bills: what Zoom measured, else what the
    // call was booked for, else the platform minimum. Never a number from the
    // request body — staff confirm WHO attended, not what it costs.
    const durationMin =
      pe.actualDurationMin
      ?? pe.booking?.durationMin
      ?? pe.callDurationMin
      ?? 15;

    const result = await applyAttendanceOutcome(project, pe, outcome, {
      durationMin,
      endedAt: pe.zoomMeetingEndedAt ?? null,
    });

    console.log('[admin/attendance] resolved', {
      projectId, outcome: result.outcome, charged: result.charged,
    });

    return Response.json({ ok: true, outcome: result.outcome, charged: result.charged });
  } catch (err) {
    console.error('[admin/attendance] error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}
