// POST /api/webhooks/zoom — the end of the engagement, driven by Zoom.
//
// Public, no routeAuthGuard: the caller is Zoom's server, and the only proof of
// identity is the v2 HMAC signature checked below. Two events matter, both
// emitted for meetings created by lib/createZoomMeeting.ts during lib/bookCall:
//
//   meeting.started  → `zoomMeetingStarted: true` on the ProjectExpert, which is
//                      what the Staff panel reads to show a call is live.
//   meeting.participant_joined
//                    → `zoomAttendance.expertJoined / clientJoined`, matched by
//                      the participant's address (or the host role) against the
//                      expert's contactEmail and the project's client contact.
//                      This is the ONLY evidence of who turned up, and without
//                      it a finished meeting is never billed — see below.
//   meeting.ended    → the ACTUAL duration (end_time - start_time, rounded up,
//                      floor of 1 minute) and then, Wave 5, a branch on WHO
//                      ATTENDED (resolveAttendance):
//                        both           → status 'completed' and the ordinary
//                                         charge via lib/createAndSendInvoice.
//                                         This is the ONLY automatic path from
//                                         "a call happened" to "money moves".
//                        client_no_show → engagement ends, no_show event, the
//                                         15-minute fee (lib/lateCancelBilling).
//                        expert_no_show → engagement ends, no_show event, the
//                                         expert is removed; no charge.
//                        unknown        → NOTHING is billed and nothing is
//                                         completed: the row is parked with
//                                         attendanceReviewPending and a staff
//                                         member decides at
//                                         POST /api/admin/attendance. Missing
//                                         telemetry is never read as a no-show
//                                         (docs/CALL_POLICIES_DRAFT.md). Until
//                                         meeting.participant_joined is enabled
//                                         on the Zoom app, EVERY call lands
//                                         here — that subscription is a
//                                         prerequisite for automatic billing.
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

import { NextRequest, NextResponse } from 'next/server';
import { getProject, mutateExpert, updateExpertStatus } from '../../../../lib/projectStore';
import { recordSystemFailure } from '../../../../lib/engagementEvents';
import { findProjectExpertByZoomMeetingId } from '../../../../lib/zoomLookup';
import { applyAttendanceOutcome } from '../../../../lib/lateCancelBilling';
// The pure decisions on this path — the v0 signature, the replay window and
// what a meeting.ended means — live next door so they can be unit tested: a
// route.ts may not export helper values (Next type-checks its exports). See
// ./meetingEnd.ts, scripts/test-zoom-webhook.ts and
// scripts/test-webhook-signature.ts.
import {
  classifyParticipant,
  resolveAttendance,
  resolveMeetingEnd,
  verifyZoomWebhook,
  zoomUrlValidationHash,
  type ZoomParticipant,
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

  // ── meeting.participant_joined: the only evidence of who turned up ──────
  // Matched by address, lower-cased on both sides, against the expert's
  // contactEmail and the project's client contact; the host fallback covers an
  // expert who joined without signing in to Zoom (classifyParticipant). A
  // participant we cannot place writes nothing at all — an unrecognised guest
  // must never make the other side look absent, because an absence is billable.
  // The flags are merged under compare-and-set: the two sides arrive as two
  // deliveries and neither may clobber the other.
  if (eventType === 'meeting.participant_joined') {
    const match = await findProjectExpertByZoomMeetingId(meetingId);
    if (match) {
      const { projectId, expertId } = match;
      const project = await getProject(projectId);
      const pe      = project?.experts.find(e => e.expert.id === expertId);
      const who = classifyParticipant(
        obj?.participant as ZoomParticipant | undefined,
        {
          expertEmail: pe?.contactEmail ?? null,
          ownerEmail:  project?.ownerEmail ?? null,
          clientEmail: project?.clientEmail ?? null,
        },
      );

      if (who !== 'unknown' && project && pe) {
        await mutateExpert(projectId, expertId, current => ({
          ...current,
          zoomAttendance: {
            ...(current.zoomAttendance ?? {}),
            ...(who === 'expert' ? { expertJoined: true } : { clientJoined: true }),
          },
          updatedAt: Date.now(),
        })).catch(err => {
          console.error('[zoom] attendance write failed',
            err instanceof Error ? err.message.slice(0, 120) : 'unknown');
        });
      }
      // Count-only: 'expert' | 'client' | 'unknown' is a fixed label.
      console.log('[zoom] participant-joined', { meetingId, who });
    }
  }

  // ── meeting.ended: duration, attendance, and the charge ─────────────────
  // resolveMeetingEnd() (./meetingEnd.ts) owns the two decisions that come
  // first: whether this engagement has already been completed by an earlier
  // delivery or by the manual complete route, and how many minutes the call
  // ran when Zoom's own stamps are unusable. resolveAttendance() then decides
  // WHETHER those minutes are billable at all, and
  // lib/lateCancelBilling.applyAttendanceOutcome performs whichever branch it
  // names — the same function the staff override calls, so the two can never
  // drift. An invoice failure inside it is logged and swallowed so the
  // completion still stands: a call that happened must never be un-completed by
  // a Stripe blip.
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
      } else if (!project || !pe) {
        // The lookup found the row but the project did not load — never guess.
        console.log('[zoom] meeting-ended-skip', { meetingId, reason: 'row_not_loaded' });
      } else {
        const { actualDurationMin, endedAt } = resolved;
        const attendance = resolveAttendance(pe.zoomAttendance);

        if (attendance === 'unknown') {
          // NO TELEMETRY, NO MONEY. The meeting is stamped as ended so a
          // redelivery is still a no-op, but the engagement is neither
          // completed nor billed: a staff member decides at
          // POST /api/admin/attendance. Charging on silence is exactly what
          // the founder's policy forbids.
          await mutateExpert(projectId, expertId, current => ({
            ...current,
            actualDurationMin,
            zoomMeetingEndedAt:      endedAt,
            attendanceReviewPending: true,
            updatedAt:               Date.now(),
          })).catch(err => {
            console.error('[zoom] attendance-review write failed',
              err instanceof Error ? err.message.slice(0, 120) : 'unknown');
          });
          await recordSystemFailure({
            area:   'invoice',
            reason: 'attendance_unconfirmed',
            projectId,
            expertId,
          });
          console.log('[zoom] meeting-ended-review', { meetingId, durationMin: actualDurationMin });
        } else {
          // both / client_no_show / expert_no_show — one implementation,
          // shared with the staff override (lib/lateCancelBilling.ts).
          const result = await applyAttendanceOutcome(project, pe, attendance, {
            durationMin: actualDurationMin,
            endedAt,
          });
          console.log('[zoom] meeting-ended', {
            meetingId,
            durationMin: actualDurationMin,
            attendance:  result.outcome,
            charged:     result.charged,
          });
        }
      }
    }
  }

  return NextResponse.json({ received: true });
}
