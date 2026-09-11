// POST /api/onboarding/calendar — link a Calendly or manual calendar.
// GET  /api/onboarding/calendar — which providers this deployment offers.
//
// Session-authenticated (routeAuthGuard). Writes the caller's single row in
// public.user_calendar_connections via lib/calendarConnections.ts.
//
// Body (one of):
//   { provider: 'calendly', calendlyUrl: 'https://calendly.com/...', timezone?: 'America/New_York' }
//   { provider: 'manual',   timezone?: 'America/New_York',
//     weeklyWindows?: [{ dayOfWeek: 0-6, from: 'HH:MM', to: 'HH:MM', timezone }],
//     slots?:         AvailabilitySlot[] }
//
// A manual connection needs AT LEAST ONE of weeklyWindows or slots — a
// recurring rule ("Tuesdays 9–11") and specific dates are both complete
// answers, and a user may give either or both. Both are REPLACED on every
// write, matching upsertCalendarConnection's replace-the-row contract: sending
// weeklyWindows without slots clears the one-off dates, which is what the
// Settings editor means when it saves.
//
// Google is NOT accepted here — it is a browser redirect, not a JSON POST:
//   GET /api/onboarding/calendar/google[?tz=<IANA zone>]
// A `provider: 'google'` body gets 400 use_oauth_redirect with the path to use.
//
// CALENDLY IS HIDDEN unless CALENDLY_ENABLED === 'true' (lib/calendlyFlag.ts):
// Calendly's public API answers 401 to every unauthenticated call, so a stored
// link yields no slots. With the flag off this route answers
// 400 { error: 'calendly_disabled' } for provider 'calendly', and GET reports
// calendlyEnabled:false so the browser step never offers it. The flag is read
// server-side and handed to the client through GET — there is deliberately no
// NEXT_PUBLIC copy of it to drift.
//
// The Calendly URL is stored, not resolved: slots are fetched lazily at
// scheduling time by getClientSlotsForUser(), so a slow Calendly API never
// blocks onboarding. (The expert-facing submit route resolves eagerly because
// it has no later chance to.)
//
// Responses:
//   200 { ok: true, connected: true, provider }
//   400 { error: 'invalid_json' | 'invalid_provider' | 'use_oauth_redirect'
//                | 'calendly_disabled' | 'invalid_calendly_url'
//                | 'invalid_timezone' | 'no_slots'
//                | 'invalid_weekly_windows', reason?, index? }
//   401 { error: 'unauthorized' }   413 { error: 'request_too_large' }
//   415 { error: 'content_type_required' }   500 { error: 'internal_error' }
//
// NEVER logs: email addresses, Calendly URLs, or slot times.

import { NextRequest } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../lib/auth';
import { trackProductEvent } from '../../../../lib/productEvents';
import {
  upsertCalendarConnection,
  normalizeTimezone,
} from '../../../../lib/calendarConnections';
import { parseWeeklyWindows } from '../../../../lib/availabilityWindows';
import { calendlyEnabled } from '../../../../lib/calendlyFlag';
import type { AvailabilitySlot } from '../../../../types';

const MAX_BODY         = 16_384;  // bytes — manual slots are the largest payload
const MAX_URL_CHARS    = 300;
const MAX_SLOTS        = 60;
const MAX_SLOT_FIELD   = 40;      // chars per slot string field
const GOOGLE_AUTH_PATH = '/api/onboarding/calendar/google';

// ─── Validation helpers ───────────────────────────────────────────────────────

/** Trims, strips control characters, and caps length. Non-strings → ''. */
function cleanString(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  return value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, max);
}

/** Mirrors the availability submit route's check: a real calendly.com link. */
function isValidCalendlyUrl(url: string): boolean {
  if (!url.startsWith('https://calendly.com/')) return false;
  try {
    const u = new URL(url);
    return u.hostname === 'calendly.com' && u.pathname.length > 1;
  } catch {
    return false;
  }
}

/**
 * Narrows and sanitizes user-supplied slots. Anything without both a start and
 * an end time is dropped; the list is capped at MAX_SLOTS.
 */
function sanitizeSlots(value: unknown, fallbackTimezone: string): AvailabilitySlot[] {
  if (!Array.isArray(value)) return [];

  const slots: AvailabilitySlot[] = [];

  for (const item of value) {
    if (slots.length >= MAX_SLOTS) break;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;

    const rec       = item as Record<string, unknown>;
    const startTime = cleanString(rec.startTime, MAX_SLOT_FIELD);
    const endTime   = cleanString(rec.endTime,   MAX_SLOT_FIELD);
    if (!startTime || !endTime) continue;

    const dayOfWeek  = cleanString(rec.dayOfWeek, MAX_SLOT_FIELD);
    const date       = cleanString(rec.date,      MAX_SLOT_FIELD);
    const timezone   = cleanString(rec.timezone,  MAX_SLOT_FIELD) || fallbackTimezone;
    const confidence = rec.confidence;

    slots.push({
      startTime,
      endTime,
      timezone,
      ...(dayOfWeek ? { dayOfWeek } : {}),
      ...(date      ? { date }      : {}),
      ...(confidence === 'high' || confidence === 'medium' || confidence === 'low'
        ? { confidence }
        : { confidence: 'high' as const }),
    });
  }

  return slots;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<Response> {
  const authError = await routeAuthGuard(request);
  if (authError) return authError;

  // ── Content-type + size guards ────────────────────────────────────────────
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return Response.json({ error: 'content_type_required' }, { status: 415 });
  }

  const contentLength = request.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_BODY) {
    return Response.json({ error: 'request_too_large' }, { status: 413 });
  }

  let raw: string;
  try { raw = await request.text(); } catch {
    return Response.json({ error: 'read_error' }, { status: 400 });
  }
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY) {
    return Response.json({ error: 'request_too_large' }, { status: 413 });
  }

  let body: Record<string, unknown>;
  try { body = JSON.parse(raw) as Record<string, unknown>; } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  // ── Provider ──────────────────────────────────────────────────────────────
  const provider = body.provider;

  if (provider === 'google') {
    return Response.json(
      { error: 'use_oauth_redirect', authPath: GOOGLE_AUTH_PATH },
      { status: 400 },
    );
  }
  if (provider !== 'calendly' && provider !== 'manual') {
    return Response.json({ error: 'invalid_provider' }, { status: 400 });
  }
  // Refused before any validation or write: the flag is the whole answer, and
  // a rejected Calendly body must never reach upsertCalendarConnection and
  // replace a working Google or manual row with a dead one.
  if (provider === 'calendly' && !calendlyEnabled()) {
    return Response.json({ error: 'calendly_disabled' }, { status: 400 });
  }

  // ── Timezone (optional) ───────────────────────────────────────────────────
  let timezone: string | null = null;
  if (body.timezone !== undefined && body.timezone !== null && body.timezone !== '') {
    timezone = normalizeTimezone(body.timezone);
    if (!timezone) return Response.json({ error: 'invalid_timezone' }, { status: 400 });
  }

  // ── Session ───────────────────────────────────────────────────────────────
  const sessionUser = await getSessionUser(request);
  if (!sessionUser.email) return Response.json({ error: 'unauthorized' }, { status: 401 });

  // ── Build the connection ──────────────────────────────────────────────────
  let saved: boolean;

  try {
    if (provider === 'calendly') {
      const url = cleanString(body.calendlyUrl, MAX_URL_CHARS);
      if (!isValidCalendlyUrl(url)) {
        return Response.json({ error: 'invalid_calendly_url' }, { status: 400 });
      }
      saved = await upsertCalendarConnection(sessionUser.email, {
        provider:    'calendly',
        calendlyUrl: url,
        timezone,
      });
    } else {
      // Recurring windows are validated strictly — a user who typed an
      // impossible window is told which one, rather than having it dropped.
      const weekly = parseWeeklyWindows(body.weeklyWindows);
      if (!weekly.ok) {
        return Response.json(
          { error: 'invalid_weekly_windows', reason: weekly.reason, index: weekly.index },
          { status: 400 },
        );
      }

      const slots = sanitizeSlots(body.slots, timezone ?? 'UTC');
      if (slots.length === 0 && weekly.windows.length === 0) {
        return Response.json({ error: 'no_slots' }, { status: 400 });
      }

      saved = await upsertCalendarConnection(sessionUser.email, {
        provider:      'manual',
        manualSlots:   slots,
        weeklyWindows: weekly.windows,
        timezone,
      });
    }
  } catch (err) {
    console.error('[api/onboarding/calendar] error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  if (!saved) {
    console.error('[api/onboarding/calendar] failed to store connection');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  console.log('[api/onboarding/calendar] calendar connected', { provider });
  void trackProductEvent({
    type:       'onboarding_step_completed',
    actorEmail: sessionUser.email,
    payload:    { step: 'calendar', provider },
  });

  return Response.json({ ok: true, connected: true, provider });
}

/**
 * What the calendar step is allowed to offer in this deployment. Session-gated
 * like the POST — it says nothing secret, but it is not public surface either.
 *
 * Response: 200 { calendlyEnabled: boolean }
 */
export async function GET(request: NextRequest): Promise<Response> {
  const authError = await routeAuthGuard(request);
  if (authError) return authError;

  return Response.json({ calendlyEnabled: calendlyEnabled() });
}
