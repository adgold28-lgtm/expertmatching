// Compute scheduling overlap between expert and client availability slots.
// No external date libraries — uses Node built-ins (Intl, Date) only.
// Never logs slot contents or personal data.
//
// WHAT THIS MODULE IS NOW. It predates Matchy Phase 2 and is a library of
// timezone primitives, not an overlap engine:
//   resolveTimezone / slotToUtcRange / extractTimezone → lib/matchyScheduling.ts
//   resolveTimezone                                    → lib/bookCall.ts
//   localToUtc / slotToUtcRange                        → scripts/test-scheduling.ts,
//                                                        scripts/test-freebusy-inversion.ts
//
// Removed 2026-09-09 (W4-1): computeOverlap(), scoreSlot() and
// formatInTimezone(), plus the OverlapResult / OverlapSlot types they returned.
// They lost their last caller when lib/triggerOverlapCheck.ts was retired. The
// overlap that matters is computed as absolute UTC ranges in
// lib/matchyScheduling.intersectRanges — that is the one engine now.

import type { AvailabilitySlot } from '../types';

// ─── Timezone normalization ───────────────────────────────────────────────────

const TZ_MAP: Record<string, string> = {
  ET: 'America/New_York',  EST: 'America/New_York',  EDT: 'America/New_York',
  CT: 'America/Chicago',   CST: 'America/Chicago',   CDT: 'America/Chicago',
  MT: 'America/Denver',    MST: 'America/Denver',    MDT: 'America/Denver',
  PT: 'America/Los_Angeles', PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles',
  GMT: 'Europe/London',    UTC: 'UTC',
};

/**
 * Normalizes an abbreviation ("ET", "PT") or a passthrough IANA name into an
 * IANA zone. Exported because lib/matchyScheduling.ts resolves the same zones
 * when it turns the owner's calendar into UTC ranges: one table, not two.
 */
export function resolveTimezone(tz: string): string {
  return TZ_MAP[tz.toUpperCase()] ?? tz;
}

// ─── Time parsing ─────────────────────────────────────────────────────────────

function parseTimeString(t: string): { h: number; m: number } | null {
  const match = t.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!match) return null;
  let h = parseInt(match[1], 10);
  const m   = parseInt(match[2], 10);
  const pm  = match[3].toUpperCase() === 'PM';
  if (pm && h !== 12) h += 12;
  if (!pm && h === 12) h = 0;
  return { h, m };
}

// ─── UTC construction ─────────────────────────────────────────────────────────

/**
 * Given a local wall-clock time (year, month 1-based, day, h, min) in tzIana,
 * return the corresponding UTC Date. Uses Intl to find the offset.
 */
export function localToUtc(
  year: number, month: number, day: number,
  h: number, min: number,
  tzIana: string,
): Date {
  // Create a guess assuming the local time IS UTC, then measure the offset.
  const guessUtc = new Date(Date.UTC(year, month - 1, day, h, min, 0));

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone:  tzIana,
    year:      'numeric',
    month:     '2-digit',
    day:       '2-digit',
    hour:      '2-digit',
    minute:    '2-digit',
    second:    '2-digit',
    hour12:    false,
  });

  const parts  = fmt.formatToParts(guessUtc);
  const p      = Object.fromEntries(parts.map(pt => [pt.type, pt.value]));
  const localH   = parseInt(p.hour,   10) % 24;  // Intl may return 24 for midnight
  const localMin = parseInt(p.minute, 10);

  // Difference between what we wanted (h, min) and what UTC-as-local gives us
  const offsetMin = (h - localH) * 60 + (min - localMin);
  return new Date(guessUtc.getTime() + offsetMin * 60_000);
}

// ─── Day-of-week helper ───────────────────────────────────────────────────────

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

/**
 * Find the next occurrence of `targetDay` (e.g. "Monday") within the next 14
 * days. The weekday is read in UTC, not in the slot's own zone, so a bare
 * "Monday" resolved close to midnight can land on the neighbouring date for a
 * far-from-UTC reader. Dated slots (`slot.date`) never take this path, and
 * every slot lib/availabilityWindows.ts produces is dated — this is only
 * reached for a weekday-only window, which is what the LLM reply parser emits.
 */
function nextOccurrenceOfDay(targetDay: string): { year: number; month: number; day: number } | null {
  const target = DAY_NAMES.findIndex(d => d.toLowerCase() === targetDay.toLowerCase());
  if (target === -1) return null;
  const now = new Date();
  for (let i = 0; i < 14; i++) {
    const d = new Date(now.getTime() + i * 86_400_000);
    if (d.getUTCDay() === target) {
      return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
    }
  }
  return null;
}

// ─── Slot → UTC range ─────────────────────────────────────────────────────────

/**
 * One AvailabilitySlot resolved to an absolute UTC range, or null when it does
 * not describe one (unparseable times, no date and no weekday, an end at or
 * before the start).
 *
 * Exported for lib/matchyScheduling.ts, which cuts these ranges into concrete
 * 60-minute proposals. The slot → UTC rule lives here and nowhere else.
 */
export function slotToUtcRange(
  slot: AvailabilitySlot,
  tzIana: string,
): { start: Date; end: Date } | null {
  const startParsed = parseTimeString(slot.startTime);
  const endParsed   = parseTimeString(slot.endTime);
  if (!startParsed || !endParsed) return null;

  let year: number, month: number, day: number;

  if (slot.date) {
    const parts = slot.date.split('-');
    if (parts.length !== 3) return null;
    year  = parseInt(parts[0], 10);
    month = parseInt(parts[1], 10);
    day   = parseInt(parts[2], 10);
    if (isNaN(year) || isNaN(month) || isNaN(day)) return null;
  } else if (slot.dayOfWeek) {
    const occ = nextOccurrenceOfDay(slot.dayOfWeek);
    if (!occ) return null;
    ({ year, month, day } = occ);
  } else {
    return null;
  }

  const start = localToUtc(year, month, day, startParsed.h, startParsed.m, tzIana);
  const end   = localToUtc(year, month, day, endParsed.h,   endParsed.m,   tzIana);

  // Handle midnight-crossing end times
  if (end <= start) return null;

  return { start, end };
}

// ─── Timezone extraction helper ───────────────────────────────────────────────

/** The first zone any slot in the list names, resolved to IANA. 'UTC' when none. */
export function extractTimezone(slots: AvailabilitySlot[]): string {
  const tz = slots.find(s => s.timezone)?.timezone ?? 'UTC';
  return resolveTimezone(tz);
}
