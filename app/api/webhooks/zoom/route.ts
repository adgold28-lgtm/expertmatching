// POST — public, no routeAuthGuard.
// Handles Zoom webhook events with v2 signature verification.
// Uses timingSafeEqual for signature comparison.
//
// NEVER log: expert names, project names, meeting topics.
// Meeting IDs and durations are safe to log.

import { createHmac, timingSafeEqual } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getProject, listProjects, updateExpertStatus } from '../../../../lib/projectStore';

// ─── Helper: find project+expert by zoomMeetingId ────────────────────────────
// O(n) scan — project count is small, no secondary index needed.

async function findByZoomMeetingId(
  meetingId: string,
): Promise<{ projectId: string | null; expertId: string | null }> {
  const summaries = await listProjects();
  for (const summary of summaries) {
    const project = await getProject(summary.id);
    if (!project) continue;
    for (const pe of project.experts) {
      if (pe.zoomMeetingId === meetingId) {
        return { projectId: project.id, expertId: pe.expert.id };
      }
    }
  }
  return { projectId: null, expertId: null };
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const ts      = request.headers.get('x-zm-request-timestamp') ?? '';
  const zmSig   = request.headers.get('x-zm-signature') ?? '';
  const secret  = process.env.ZOOM_WEBHOOK_SECRET_TOKEN;

  // Parse body (do this after reading text)
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  // URL validation challenge (Zoom setup handshake) — exempt from signature check,
  // but still requires the secret to be configured so the HMAC is meaningful.
  if (body.event === 'endpoint.url_validation') {
    if (!secret) {
      return NextResponse.json({ error: 'missing_signature' }, { status: 400 });
    }
    const payload = body.payload as Record<string, unknown>;
    const hash = createHmac('sha256', secret)
      .update(String(payload.plainToken))
      .digest('hex');
    return NextResponse.json({ plainToken: payload.plainToken, encryptedToken: hash });
  }

  // Verify signature for all other requests
  if (!secret || !zmSig) {
    return NextResponse.json({ error: 'missing_signature' }, { status: 400 });
  }
  const message  = `v0:${ts}:${rawBody}`;
  const expected = 'v0=' + createHmac('sha256', secret).update(message).digest('hex');
  try {
    const sigOk = timingSafeEqual(Buffer.from(zmSig), Buffer.from(expected));
    if (!sigOk) return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
  } catch {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
  }

  const eventType = body.event as string;
  const payload   = body.payload as Record<string, unknown>;
  const obj       = payload?.object as Record<string, unknown> | undefined;
  const meetingId = String(obj?.id ?? '');

  if (eventType === 'meeting.started') {
    const { projectId, expertId } = await findByZoomMeetingId(meetingId);
    if (projectId && expertId) {
      await updateExpertStatus(projectId, expertId, { zoomMeetingStarted: true });
      console.log('[zoom] meeting-started', { meetingId });
    }
  }

  if (eventType === 'meeting.ended') {
    const startTs    = new Date(String(obj?.start_time ?? '')).getTime();
    const endTimeStr = obj?.end_time;
    const resolvedEnd = endTimeStr
      ? new Date(String(endTimeStr)).getTime()
      : Date.now();
    const actualDurationMin = Math.max(1, Math.ceil((resolvedEnd - startTs) / 60000));

    const { projectId, expertId } = await findByZoomMeetingId(meetingId);
    if (projectId && expertId) {
      const project = await getProject(projectId);
      const pe      = project?.experts.find(e => e.expert.id === expertId);

      await updateExpertStatus(projectId, expertId, {
        actualDurationMin,
        zoomMeetingEndedAt: Date.now(),
        status:             'completed',
      });

      console.log('[zoom] meeting-ended', { meetingId, durationMin: actualDurationMin });

      // Auto-invoice if rate is set — amount computed from stored expertRate, never from webhook payload
      if (pe?.expertRate) {
        const invoiceAmount = Math.round((pe.expertRate * actualDurationMin) / 60);
        try {
          const { createAndSendInvoice } = await import('../../../../lib/createAndSendInvoice');
          await createAndSendInvoice(projectId, expertId, invoiceAmount, actualDurationMin);
        } catch (err) {
          console.error('[zoom] auto-invoice failed', err instanceof Error ? err.message : String(err));
        }
      }
    }
  }

  return NextResponse.json({ received: true });
}
