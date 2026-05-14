// Fetch available time slots from a public Calendly scheduling link.
//
// Uses Calendly's public event-types API (no auth required for public links).
// Returns up to 50 slots within the next `windowDays` days (default: 14).
// Returns an empty array on any failure — never throws.
//
// NEVER log the Calendly URL (may contain PII or private identifiers).

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

async function fetchEventTypes(username: string): Promise<CalendlyEventType[]> {
  const res = await fetch(
    `https://api.calendly.com/event_types?organization=&user=https://api.calendly.com/users/${username}`,
    {
      headers: { 'Content-Type': 'application/json' },
      signal:  AbortSignal.timeout(8_000),
    },
  );
  if (!res.ok) return [];
  const data = await res.json() as CalendlyCollection<CalendlyEventType>;
  return data.collection ?? [];
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
  if (!res.ok) return [];
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
