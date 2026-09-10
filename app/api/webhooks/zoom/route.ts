// POST /api/webhooks/zoom — the end of the engagement, driven by Zoom.
//
// Public, no routeAuthGuard: the caller is Zoom's server, and the only proof of
// identity is the v2 HMAC signature checked below. Two events matter, both
// emitted for meetings created by lib/createZoomMeeting.ts during lib/bookCall:
//
//   meeting.started  → `zoomMeetingStarted: true` on the ProjectExpert, which is
//                      what the Staff panel reads to show a call is live.
//   meeting.ended    → the ACTUAL duration (end_time - start_time, rounded up,
//                      floor of 1 minute), status → 'completed', and — when an
//                      expertRate was agreed — the client's card is charged via
//                      lib/createAndSendInvoice. This is the ONLY automatic path
//                      from "a call happened" to "money moves".
//
// The meeting id is the only join key Zoom gives us; lib/zoomLookup.ts resolves
// it back to { projectId, expertId } through `project_experts.data->>zoomMeetingId`.
// A booking whose Zoom creation failed carries no meeting id, so no webhook can
// ever land on it and the call will not bill itself (see lib/bookCall.ts).
//
// The billing amount is computed here from the STORED `pe.expertRate` and the
// measured duration (lib/pricing.callChargeDollars) — never from anything in the
// webhook payload, which is attacker-shaped data even after the signature check.
//
// REPLAY AND RE-COMPLETION (C-4). A signature alone does not make a delivery
// current: a captured body stays validly signed forever, and Zoom itself
// redelivers on any non-2xx. So every signed event must also arrive inside the
// five-minute window checked by isFreshTimestamp(), and meeting.ended is
// resolved through resolveMeetingEnd(), which refuses to write or invoice a
// second time once zoomMeetingEndedAt or status 'completed' is on the row.
// Idempotency no longer rests entirely on lib/createAndSendInvoice.
//
// NEVER log: expert names, project names, meeting topics.
// Meeting IDs and durations are safe to log.

import { callChargeDollars } from '../../../../lib/pricing';
import { NextRequest, NextResponse } from 'next/server';
import { getProject, updateExpertStatus } from '../../../../lib/projectStore';
import { recordSystemFailure } from '../../../../lib/engagementEvents';
import { findProjectExpertByZoomMeetingId } from '../../../../lib/zoomLookup';
// The pure decisions on this path — the v0 signature, the replay window and
// what a meeting.ended means — live next door so they can be unit tested: a
// route.ts may not export helper values (Next type-checks its exports). See
// ./meetingEnd.ts, scripts/test-zoom-webhook.ts and
// scripts/test-webhook-signature.ts.
import {
  resolveMeetingEnd,
  verifyZoomWebhook,
  zoomUrlValidationHash,
} from './meetingEnd';

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
    const hash    = zoomUrlValidationHash(secret, String(payload.plainToken));
    return NextResponse.json({ plainToken: payload.plainToken, encryptedToken: hash });
  }

  // ── Signature and replay window ─────────────────────────────────────────
  // Zoom signs `v0:{timestamp}:{raw body}` with the webhook secret token, which
  // is why the body was read as text and parsed separately above rather than
  // with request.json(). The signature proves authorship, never freshness — a
  // captured body stays validly signed forever — so verifyZoomWebhook also
  // requires the delivery to be recent. Same three error strings and the same
  // 400 as before. The url_validation handshake is exempt: it is answered above
  // and Zoom sends it out of band.
  const verified = verifyZoomWebhook({
    secret,
    timestamp: ts,
    signature: zmSig,
    rawBody,
    now:       Date.now(),
  });
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 400 });
  }

  const eventType = body.event as string;
  const payload   = body.payload as Record<string, unknown>;
  const obj       = payload?.object as Record<string, unknown> | undefined;
  const meetingId = String(obj?.id ?? '');

  if (eventType === 'meeting.started') {
    const match = await findProjectExpertByZoomMeetingId(meetingId);
    if (match) {
      const { projectId, expertId } = match;
      await updateExpertStatus(projectId, expertId, { zoomMeetingStarted: true });
      console.log('[zoom] meeting-started', { meetingId });
    }
  }

  // ── meeting.ended: duration, completion, and the charge ─────────────────
  // resolveMeetingEnd() (./meetingEnd.ts) owns the two decisions that matter: whether
  // this engagement has already been completed by an earlier delivery or by the
  // manual complete route, and how many minutes to bill when Zoom's own stamps
  // are unusable. Everything downstream of the status write is money:
  // lib/pricing.callChargeDollars applies the 15-minute minimum and the
  // per-minute rate, and lib/createAndSendInvoice charges the client's saved
  // card. An invoice failure is logged and swallowed so the completion still
  // stands — a call that happened must never be un-completed by a Stripe blip.
  if (eventType === 'meeting.ended') {
    const match = await findProjectExpertByZoomMeetingId(meetingId);
    if (match) {
      const { projectId, expertId } = match;
      const project = await getProject(projectId);
      const pe      = project?.experts.find(e => e.expert.id === expertId);

      const resolved = resolveMeetingEnd(obj, Date.now(), pe);

      if (resolved.skip) {
        // Count-only: the reason is a fixed label, never payload text.
        console.log('[zoom] meeting-ended-skip', { meetingId, reason: resolved.reason });
        if (resolved.reason === 'no_duration') {
          // A call we cannot measure is a call we cannot bill; surface it
          // instead of writing NaN. recordSystemFailure never throws.
          await recordSystemFailure({
            area:   'invoice',
            reason: 'zoom_end_without_duration',
            projectId,
            expertId,
          });
        }
      } else {
        const { actualDurationMin, endedAt } = resolved;

        await updateExpertStatus(projectId, expertId, {
          actualDurationMin,
          zoomMeetingEndedAt: endedAt,
          status:             'completed',
        });

        console.log('[zoom] meeting-ended', { meetingId, durationMin: actualDurationMin });

        // Auto-invoice if rate is set — amount computed from the stored expertRate
        // (client rate × billable minutes, lib/pricing.ts), never from webhook payload
        if (pe?.expertRate) {
          const invoiceAmount = callChargeDollars(pe.expertRate, actualDurationMin);
          try {
            const { createAndSendInvoice } = await import('../../../../lib/createAndSendInvoice');
            await createAndSendInvoice(projectId, expertId, invoiceAmount, actualDurationMin);
          } catch (err) {
            console.error('[zoom] auto-invoice failed', err instanceof Error ? err.message : String(err));
          }
        }
      }
    }
  }

  return NextResponse.json({ received: true });
}
