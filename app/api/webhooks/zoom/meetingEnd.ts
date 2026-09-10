// The two pure decisions behind POST /api/webhooks/zoom (see ./route.ts):
// is this signed delivery recent enough to act on, and what does a
// `meeting.ended` mean for an engagement that may already be completed or may
// carry no usable duration? Both are money decisions, so both are tested by
// scripts/test-zoom-webhook.ts.
//
// It also owns the SIGNATURE itself (zoomSignature / verifyZoomWebhook): the
// route reads the headers and answers, this file decides — which is what lets
// scripts/test-webhook-signature.ts check the v0 HMAC and the replay window
// against real fixtures instead of trusting the route's inline copy.
//
// WHY THIS FILE EXISTS RATHER THAN LIVING IN route.ts: Next's App Router
// type-checks a `route.ts` against a closed set of exports (the HTTP verbs plus
// the route segment config), so exporting a helper VALUE from it fails
// `next build`. Types may be exported from a route file; functions and consts
// may not. Colocating them here keeps them testable and keeps the route file
// legal. No I/O, no clock of its own, no env: `now` is always supplied.

import { createHmac, timingSafeEqual } from 'crypto';

/**
 * How old a signed Zoom delivery may be before it is refused, in seconds.
 * Zoom's own retry backoff is well inside this.
 */
export const ZOOM_TIMESTAMP_TOLERANCE_SEC = 300;

/**
 * True when the `x-zm-request-timestamp` header is within
 * ZOOM_TIMESTAMP_TOLERANCE_SEC of `now` (unix ms) in either direction. The
 * header carries Unix SECONDS; anything non-numeric (including the empty
 * string a missing header collapses to) is not fresh.
 *
 * The window is two-sided on purpose: a stamp far ahead of our clock is as much
 * a sign of a forged or replayed delivery as one far behind.
 */
export function isFreshTimestamp(ts: string | null | undefined, now: number): boolean {
  const raw = String(ts ?? '').trim();
  if (raw === '') return false;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds)) return false;
  return Math.abs(now / 1000 - seconds) <= ZOOM_TIMESTAMP_TOLERANCE_SEC;
}

/**
 * The parts of a ProjectExpert row that decide whether a `meeting.ended` may be
 * acted on. Structural on purpose so a test can pass a fixture; a real
 * ProjectExpert satisfies it.
 */
export interface MeetingEndRow {
  status?:             string;
  zoomMeetingEndedAt?: number | null;
  booking?:            { durationMin?: number | null } | null;
}

/** Either "do not touch this row, because …" or the two numbers to write. */
export type MeetingEndResolution =
  | { skip: true;  reason: 'already_ended' | 'already_completed' | 'no_duration' }
  | { skip: false; actualDurationMin: number; endedAt: number };

/**
 * Decides what a `meeting.ended` delivery means for one engagement.
 *
 * Two rules, both money rules:
 *   1. Completion guard (C-4). A row that already carries zoomMeetingEndedAt,
 *      or that is already 'completed', is done. Zoom redelivers on any non-2xx
 *      and the manual complete route can finish the same call, so a redelivery
 *      must not overwrite the measured duration or re-enter the invoice path.
 *   2. Never NaN (M-35). Zoom can omit or mangle start_time; the old
 *      arithmetic then yielded NaN, which was stored as the duration and passed
 *      to lib/pricing.callChargeDollars. When the stamp is unusable we fall
 *      back to the duration the call was BOOKED for, and when there is no
 *      booking either we refuse rather than guess — the caller records a
 *      system failure so a human sees the uncharged call.
 *
 * A missing or unparseable end_time still falls back to `now`, as before.
 */
export function resolveMeetingEnd(
  obj:      Record<string, unknown> | undefined,
  now:      number,
  existing: MeetingEndRow | null | undefined,
): MeetingEndResolution {
  if (existing?.zoomMeetingEndedAt)     return { skip: true, reason: 'already_ended' };
  if (existing?.status === 'completed') return { skip: true, reason: 'already_completed' };

  const startTs = obj?.start_time == null ? NaN : new Date(String(obj.start_time)).getTime();
  const endRaw  = obj?.end_time   == null ? NaN : new Date(String(obj.end_time)).getTime();
  const endTs   = Number.isFinite(endRaw) ? endRaw : now;

  if (Number.isFinite(startTs)) {
    return {
      skip:              false,
      actualDurationMin: Math.max(1, Math.ceil((endTs - startTs) / 60000)),
      endedAt:           now,
    };
  }

  const booked = existing?.booking?.durationMin;
  if (typeof booked === 'number' && Number.isFinite(booked) && booked > 0) {
    return { skip: false, actualDurationMin: Math.max(1, Math.ceil(booked)), endedAt: now };
  }

  return { skip: true, reason: 'no_duration' };
}

// ─── Signature (v0 HMAC) ──────────────────────────────────────────────────────

/**
 * Zoom's `x-zm-signature` value for a delivery: `v0=` plus the hex
 * HMAC-SHA256, keyed with the webhook secret token, over the exact string
 * `v0:{timestamp}:{raw body}`. The RAW body matters — re-serialising the parsed
 * JSON changes the bytes and therefore the signature. Pure.
 */
export function zoomSignature(secret: string, timestamp: string, rawBody: string): string {
  return 'v0=' + createHmac('sha256', secret).update(`v0:${timestamp}:${rawBody}`).digest('hex');
}

/**
 * The answer to Zoom's `endpoint.url_validation` handshake: the hex HMAC of the
 * plainToken under the same secret. That handshake carries no signature of its
 * own, which is why it is answered before the checks below. Pure.
 */
export function zoomUrlValidationHash(secret: string, plainToken: string): string {
  return createHmac('sha256', secret).update(plainToken).digest('hex');
}

export type ZoomVerifyResult =
  | { ok: true }
  | { ok: false; error: 'missing_signature' | 'invalid_signature' | 'stale_timestamp' };

/**
 * Whether a signed Zoom delivery may be acted on, in the order the route
 * answers: a missing secret or header is 'missing_signature'; a signature that
 * does not match (including a wrong-length one, which makes timingSafeEqual
 * throw) is 'invalid_signature'; a correctly signed but old or future-dated
 * delivery is 'stale_timestamp' (C-4 — a captured body stays validly signed
 * forever, so the signature alone proves authorship, never freshness).
 *
 * Pure apart from the HMAC: `now` is always supplied by the caller.
 */
export function verifyZoomWebhook(input: {
  secret:    string | undefined;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  rawBody:   string;
  now:       number;
}): ZoomVerifyResult {
  const { secret, timestamp, signature, rawBody, now } = input;
  if (!secret || !signature) return { ok: false, error: 'missing_signature' };

  const expected = zoomSignature(secret, String(timestamp ?? ''), rawBody);
  try {
    if (!timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) {
      return { ok: false, error: 'invalid_signature' };
    }
  } catch {
    // Length mismatch — timingSafeEqual throws rather than returning false.
    return { ok: false, error: 'invalid_signature' };
  }

  if (!isFreshTimestamp(timestamp, now)) return { ok: false, error: 'stale_timestamp' };
  return { ok: true };
}
