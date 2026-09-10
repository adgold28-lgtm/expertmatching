// Fetch available time slots from a public Calendly scheduling link.
//
// Returns up to 50 slots within the next `windowDays` days (default: 14).
// Returns an empty array on any failure — never throws.
//
// VERIFIED 2026-09-09 (M-32): api.calendly.com requires a bearer token for
// EVERY endpoint, including event_types for a public scheduling page. Probed by
// hand against a real public link (calendly.com/calendly-demo): the API answers
//   401 {"title":"Unauthenticated","message":"The access token is invalid"}
// and fetchCalendlySlots therefore returns [] for every link, always. There is
// no CALENDLY_* credential anywhere in the app, so this provider cannot work as
// written; `probeCalendlyLink` below exists so the connect-time path can say so
// instead of accepting a link that will never yield a slot. Until a token or
// OAuth is added, treat any Calendly connection as producing no availability.
//
// NEVER log the Calendly URL (may contain PII or private identifiers). Status
// codes are safe to log and are the only way to tell a rejected request from a
// genuinely empty calendar.

import type { AvailabilitySlot } from '../types';

const MAX_SLOTS    = 50;
const DEFAULT_DAYS = 14;

// ─── Calendly API types ───────────────────────────────────────────────────────

interface CalendlyCollection<T> {
  collection: T[];
  pagination?: { count: number; next_page?: string };
}

interface CalendlyEventType {
  uri:            string;
  name:           string;
  scheduling_url: string;
  duration:       number;  // minutes
  slug:           string;
}

interface CalendlyAvailableTime {
  status:             'available';
  invitees_remaining: number;
  start_time:         string; // ISO 8601
}

// ─── URL helpers ─────────────────────────────────────────────────────────────

/**
 * Extract the Calendly username (and optional event slug) from a scheduling URL.
 * Supports: https://calendly.com/username  and  https://calendly.com/username/event-slug
 */
function parseCalendlyUrl(url: string): { username: string; eventSlug?: string } | null {
  try {
    const u     = new URL(url.trim());
    if (!u.hostname.includes('calendly.com')) return null;
    const parts = u.pathname.replace(/^\//, '').split('/').filter(Boolean);
    if (parts.length === 0) return null;
    return { username: parts[0], eventSlug: parts[1] };
  } catch {
    return null;
  }
}

// ─── API fetchers ─────────────────────────────────────────────────────────────

// Both calls below go to api.calendly.com with NO Authorization header and no
// CALENDLY_* env var anywhere in the app. Measured answer: 401 on both (see the
// file header). They still degrade to [] rather than throwing — that contract is
// what keeps a Calendly outage from breaking a proposal round — but the status
// is now logged, so "Calendly never yields times" is answerable from the logs.
// The status is the only thing logged; the URL is PII.
async function fetchEventTypes(username: string): Promise<CalendlyEventType[]> {
  const res = await fetch(
    `https://api.calendly.com/event_types?organization=&user=https://api.calendly.com/users/${username}`,
    {
      headers: { 'Content-Type': 'application/json' },
      signal:  AbortSignal.timeout(8_000),
    },
  );
  if (!res.ok) {
    console.warn('[fetchCalendlySlots] event_types rejected', JSON.stringify({ status: res.status }));
    return [];
  }
  const data = await res.json() as CalendlyCollection<CalendlyEventType>;
  return data.collection ?? [];
}

/**
 * Is this link one the scheduler could actually read? One event_types call, no
 * slot fetch. `ok` is true only when Calendly answered 200 AND named at least
 * one event type — which, unauthenticated, it never does today (M-32).
 *
 * Exported for the connect-time check: POST /api/onboarding/calendar and
 * lib/calendarConnections.connectionIsUsable should refuse a link this rejects
 * rather than storing one that will silently produce no availability forever.
 * Never logs or returns the URL.
 */
export async function probeCalendlyLink(
  calendlyUrl: string,
): Promise<{ ok: boolean; status: number | null; reason: 'ok' | 'invalid_url' | 'unauthenticated' | 'http_error' | 'no_event_types' | 'network_error' }> {
  const parsed = parseCalendlyUrl(calendlyUrl);
  if (!parsed) return { ok: false, status: null, reason: 'invalid_url' };

  try {
    const res = await fetch(
      `https://api.calendly.com/event_types?organization=&user=https://api.calendly.com/users/${parsed.username}`,
      {
        headers: { 'Content-Type': 'application/json' },
        signal:  AbortSignal.timeout(8_000),
      },
    );
    if (res.status === 401 || res.status === 403) {
      return { ok: false, status: res.status, reason: 'unauthenticated' };
    }
    if (!res.ok) return { ok: false, status: res.status, reason: 'http_error' };

    const data = await res.json() as CalendlyCollection<CalendlyEventType>;
    const count = (data.collection ?? []).length;
    return count > 0
      ? { ok: true,  status: res.status, reason: 'ok' }
      : { ok: false, status: res.status, reason: 'no_event_types' };
  } catch {
    return { ok: false, status: null, reason: 'network_error' };
  }
}

async function fetchAvailableTimes(
  eventTypeUri: string,
  startTime: string,
  endTime: string,
): Promise<CalendlyAvailableTime[]> {
  const params = new URLSearchParams({
    event_type:  eventTypeUri,
    start_time:  startTime,
    end_time:    endTime,
  });

  const res = await fetch(
    `https://api.calendly.com/event_type_available_times?${params}`,
    {
      headers: { 'Content-Type': 'application/json' },
      signal:  AbortSignal.timeout(8_000),
    },
  );
  if (!res.ok) {
    console.warn('[fetchCalendlySlots] available_times rejected', JSON.stringify({ status: res.status }));
    return [];
  }
  const data = await res.json() as CalendlyCollection<CalendlyAvailableTime>;
  return (data.collection ?? []).filter(t => t.status === 'available');
}

// ─── Slot builder ─────────────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function isoToSlot(isoStart: string, durationMins: number): AvailabilitySlot {
  const start = new Date(isoStart);
  const end   = new Date(start.getTime() + durationMins * 60_000);

  const pad = (n: number) => String(n).padStart(2, '0');
  const fmt = (d: Date) => {
    const h   = d.getUTCHours();
    const m   = pad(d.getUTCMinutes());
    const ampm = h >= 12 ? 'PM' : 'AM';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${m} ${ampm}`;
  };

  const dateStr = `${start.getUTCFullYear()}-${pad(start.getUTCMonth() + 1)}-${pad(start.getUTCDate())}`;

  return {
    dayOfWeek:  DAY_NAMES[start.getUTCDay()],
    date:       dateStr,
    startTime:  fmt(start),
    endTime:    fmt(end),
    timezone:   'UTC',
    confidence: 'high',
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch available slots from a public Calendly scheduling URL.
 * Returns up to MAX_SLOTS slots within the next windowDays days.
 * Returns [] on any error — never throws.
 */
export async function fetchCalendlySlots(
  calendlyUrl: string,
  windowDays: number = DEFAULT_DAYS,
): Promise<AvailabilitySlot[]> {
  try {
    const parsed = parseCalendlyUrl(calendlyUrl);
    if (!parsed) return [];

    const { username, eventSlug } = parsed;

    // Fetch event types for the user
    const eventTypes = await fetchEventTypes(username);
    if (eventTypes.length === 0) return [];

    // Select matching event type (by slug if provided, else first)
    const eventType = eventSlug
      ? (eventTypes.find(et => et.slug === eventSlug) ?? eventTypes[0])
      : eventTypes[0];

    if (!eventType) return [];

    // Build time window
    const now   = new Date();
    const start = now.toISOString();
    const endTs = new Date(now.getTime() + windowDays * 24 * 60 * 60 * 1000);
    const end   = endTs.toISOString();

    const times = await fetchAvailableTimes(eventType.uri, start, end);

    return times
      .slice(0, MAX_SLOTS)
      .map(t => isoToSlot(t.start_time, eventType.duration));

  } catch (err) {
    // Never throw — empty array is a safe fallback
    console.warn('[fetchCalendlySlots] error (slots will be empty):', (err as Error).message);
    return [];
  }
}
