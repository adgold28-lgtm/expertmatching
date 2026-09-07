// lib/availabilityWindows.ts — recurring weekly availability.
//
// A client says "Tuesdays and Thursdays, 9:00–11:30, New York" once, and the
// scheduler gets concrete dated windows for the next two weeks every time it
// looks. That is the whole job of this file: turn a small recurring rule into
// the AvailabilitySlot[] that lib/computeOverlap.ts already knows how to read.
//
// STORAGE: user_calendar_connections.weekly_windows (jsonb array), added by
// supabase/migrations/20260907100000_availability_windows_and_indexes.sql.
// One-off dates keep living in manual_slots; the two are MERGED at scheduling
// time by lib/calendarConnections.getClientSlotsForUser. Neither shadows the
// other — "every Tuesday, plus the 14th" is a normal thing to mean.
//
// WHY THE EXPANSION IS PURE CIVIL-CALENDAR ARITHMETIC
//
// A slot carries wall-clock times plus an IANA zone; computeOverlap resolves
// them to UTC with Intl at the moment it needs an instant. So this file must
// never do UTC arithmetic on days — it walks the CIVIL calendar (year/month/day
// incremented directly) and stamps each date with the same wall-clock times.
//
// That is what makes DST a non-event. "Tuesday 09:00–11:30 America/New_York"
// means 09:00 local on both sides of a transition, and each date is produced by
// incrementing the previous date, never by adding 86 400 000 ms to an instant
// (which skips or repeats a day across a transition). The 23- and 25-hour days
// are resolved later, once, by computeOverlap's localToUtc.
//
// No new dependencies: Intl and Date only.
//
// Pure module — no I/O, no logging, nothing to leak. Unit-tested by
// scripts/test-availability-windows.ts.

import type { AvailabilitySlot } from '../types';

// ─── Types ────────────────────────────────────────────────────────────────────

/** One recurring weekly window. `dayOfWeek` is 0 = Sunday … 6 = Saturday. */
export interface WeeklyWindow {
  dayOfWeek: number;
  /** Local wall-clock start, 24-hour 'HH:MM'. */
  from:      string;
  /** Local wall-clock end, 24-hour 'HH:MM'. Must be strictly after `from`. */
  to:        string;
  /** IANA zone the two times are stated in, e.g. 'America/New_York'. */
  timezone:  string;
}

/** Why a candidate window was refused. Stable codes — the UI maps them to copy. */
export type WeeklyWindowError =
  | 'not_an_object'
  | 'invalid_day'
  | 'invalid_time'
  | 'end_not_after_start'
  | 'invalid_timezone'
  | 'too_many_windows';

export type WeeklyWindowParse =
  | { ok: true;  windows: WeeklyWindow[] }
  | { ok: false; reason: WeeklyWindowError; index: number };

/**
 * Most recurring windows one person may store. Three distinct windows on each
 * of the seven days is already an unusual amount of structure; past that it is
 * a runaway client, not a schedule.
 */
export const MAX_WEEKLY_WINDOWS = 21;

/** Default expansion horizon, matching the scheduler's 14-day look-ahead. */
export const DEFAULT_EXPANSION_DAYS = 14;

/** Longest horizon `expandWeeklyWindows` will honour — 21 windows × 60 days is already 180 slots. */
const MAX_EXPANSION_DAYS = 60;

const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
] as const;

/** Monday-first order, for a UI that reads Mon–Sun. Values are still 0 = Sunday. */
export const WEEKDAY_ORDER: readonly number[] = [1, 2, 3, 4, 5, 6, 0];

/** Short label for a day-of-week number, or '' when the number is out of range. */
export function weekdayShortLabel(dayOfWeek: number): string {
  const name = WEEKDAY_NAMES[dayOfWeek];
  return name ? name.slice(0, 3) : '';
}

/** Full label for a day-of-week number, or '' when the number is out of range. */
export function weekdayLabel(dayOfWeek: number): string {
  return WEEKDAY_NAMES[dayOfWeek] ?? '';
}

// ─── Time helpers ─────────────────────────────────────────────────────────────

const HH_MM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** True for a 24-hour 'HH:MM' string in 00:00–23:59. '24:00' is NOT a time. */
export function isHhMm(value: unknown): value is string {
  return typeof value === 'string' && HH_MM.test(value);
}

/** 'HH:MM' → minutes past local midnight. Returns -1 for anything unparseable. */
export function minutesOfDay(value: string): number {
  const match = value.match(HH_MM);
  if (!match) return -1;
  return Number(match[1]) * 60 + Number(match[2]);
}

/**
 * '14:30' → '2:30 PM' — the wall-clock format lib/computeOverlap.ts parses.
 * Returns '' for anything unparseable.
 */
export function toDisplayTime(value: string): string {
  const match = value.match(HH_MM);
  if (!match) return '';
  const hours  = Number(match[1]);
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const hour12 = hours % 12 === 0 ? 12 : hours % 12;
  return `${hour12}:${match[2]} ${suffix}`;
}

/** True when the runtime's own zone database knows this IANA name. */
export function isValidTimezone(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const tz = value.trim();
  if (!tz || tz.length > 64) return false;
  if (!/^[A-Za-z0-9_+\-/]+$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

// ─── Civil-calendar helpers ───────────────────────────────────────────────────

/** A calendar date with no instant and no zone attached. */
export interface CivilDate {
  year:  number;
  month: number;  // 1-12
  day:   number;  // 1-31
}

/**
 * The calendar date it is *in `timeZone`* at the given instant. This is the
 * only place an instant becomes a date; everything downstream is civil.
 * Falls back to the UTC date when the zone is unusable.
 */
export function civilDateInZone(instant: Date, timeZone: string): CivilDate {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year:  'numeric',
      month: '2-digit',
      day:   '2-digit',
    }).formatToParts(instant);

    const read = (type: string): number => {
      const part = parts.find(p => p.type === type);
      return part ? Number(part.value) : NaN;
    };

    const year  = read('year');
    const month = read('month');
    const day   = read('day');
    if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
      return { year, month, day };
    }
  } catch {
    // Unusable zone — fall through to UTC.
  }
  return {
    year:  instant.getUTCFullYear(),
    month: instant.getUTCMonth() + 1,
    day:   instant.getUTCDate(),
  };
}

/**
 * `date` advanced by `days` calendar days. Uses Date.UTC purely as a civil
 * calculator (month lengths, leap years) — no zone is involved, so a DST
 * transition inside the range cannot skip or repeat a date.
 */
export function addCivilDays(date: CivilDate, days: number): CivilDate {
  const anchor = new Date(Date.UTC(date.year, date.month - 1, date.day));
  anchor.setUTCDate(anchor.getUTCDate() + days);
  return {
    year:  anchor.getUTCFullYear(),
    month: anchor.getUTCMonth() + 1,
    day:   anchor.getUTCDate(),
  };
}

/** Day of week for a civil date: 0 = Sunday … 6 = Saturday. */
export function civilDayOfWeek(date: CivilDate): number {
  return new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay();
}

/** Civil date → 'YYYY-MM-DD'. */
export function civilDateToIso(date: CivilDate): string {
  const month = String(date.month).padStart(2, '0');
  const day   = String(date.day).padStart(2, '0');
  return `${date.year}-${month}-${day}`;
}

/** 'YYYY-MM-DD' → civil date, or null. Rejects impossible dates (2026-02-30). */
export function isoToCivilDate(value: string): CivilDate | null {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return null;
  const year  = Number(match[1]);
  const month = Number(match[2]);
  const day   = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const round = new Date(Date.UTC(year, month - 1, day));
  if (round.getUTCFullYear() !== year || round.getUTCMonth() + 1 !== month || round.getUTCDate() !== day) {
    return null;
  }
  return { year, month, day };
}

/** True when `a` falls strictly before `b`. */
export function civilDateIsBefore(a: CivilDate, b: CivilDate): boolean {
  if (a.year !== b.year)   return a.year  < b.year;
  if (a.month !== b.month) return a.month < b.month;
  return a.day < b.day;
}

// ─── Validation ───────────────────────────────────────────────────────────────

/**
 * Narrows one unknown value into a WeeklyWindow, or explains why it cannot be.
 *
 * The rules, all of them deliberate:
 *   • dayOfWeek is an INTEGER 0-6. '1' and 1.5 are refused, not coerced.
 *   • from/to are 24-hour 'HH:MM' in 00:00–23:59.
 *   • to must be strictly after from. Equal times are an empty window, and a
 *     window that wraps past midnight ('22:00'–'02:00') is refused outright
 *     rather than silently split: computeOverlap resolves both times against
 *     the SAME calendar date, so a wrapped window would produce an end before
 *     its start and be dropped later, invisibly. Two windows on two days is
 *     the honest way to say it.
 *   • timezone must be a zone the runtime's own database knows.
 */
export function validateWeeklyWindow(
  value: unknown,
): { ok: true; window: WeeklyWindow } | { ok: false; reason: WeeklyWindowError } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, reason: 'not_an_object' };
  }

  const record = value as Record<string, unknown>;

  const dayOfWeek = record.dayOfWeek;
  if (typeof dayOfWeek !== 'number' || !Number.isInteger(dayOfWeek) || dayOfWeek < 0 || dayOfWeek > 6) {
    return { ok: false, reason: 'invalid_day' };
  }

  const from = record.from;
  const to   = record.to;
  if (!isHhMm(from) || !isHhMm(to)) {
    return { ok: false, reason: 'invalid_time' };
  }
  if (minutesOfDay(to) <= minutesOfDay(from)) {
    return { ok: false, reason: 'end_not_after_start' };
  }

  const timezone = record.timezone;
  if (!isValidTimezone(timezone)) {
    return { ok: false, reason: 'invalid_timezone' };
  }

  return { ok: true, window: { dayOfWeek, from, to, timezone: timezone.trim() } };
}

/**
 * Validates a whole array, refusing the FIRST bad entry with its index. Used on
 * the request path (POST /api/onboarding/calendar), where a user who typed
 * something impossible deserves to be told rather than to have it dropped.
 */
export function parseWeeklyWindows(value: unknown): WeeklyWindowParse {
  if (value === undefined || value === null) return { ok: true, windows: [] };
  if (!Array.isArray(value)) return { ok: false, reason: 'not_an_object', index: 0 };
  if (value.length > MAX_WEEKLY_WINDOWS) {
    return { ok: false, reason: 'too_many_windows', index: MAX_WEEKLY_WINDOWS };
  }

  const windows: WeeklyWindow[] = [];
  for (let i = 0; i < value.length; i++) {
    const result = validateWeeklyWindow(value[i]);
    if (!result.ok) return { ok: false, reason: result.reason, index: i };
    windows.push(result.window);
  }

  return { ok: true, windows: dedupeWeeklyWindows(windows) };
}

/**
 * Drops anything malformed instead of explaining it. Used when READING the
 * jsonb column: the app wrote it, but a hand-edited row must not be able to
 * strand the scheduler. Mirrors slotsFromJson in lib/calendarConnections.ts.
 */
export function sanitizeWeeklyWindows(value: unknown): WeeklyWindow[] {
  if (!Array.isArray(value)) return [];
  const windows: WeeklyWindow[] = [];
  for (const item of value) {
    if (windows.length >= MAX_WEEKLY_WINDOWS) break;
    const result = validateWeeklyWindow(item);
    if (result.ok) windows.push(result.window);
  }
  return dedupeWeeklyWindows(windows);
}

/** Removes exact duplicates, preserving first-seen order. */
export function dedupeWeeklyWindows(windows: WeeklyWindow[]): WeeklyWindow[] {
  const seen = new Set<string>();
  const out: WeeklyWindow[] = [];
  for (const w of windows) {
    const key = `${w.dayOfWeek}|${w.from}|${w.to}|${w.timezone}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
  }
  return out;
}

/** Sorted for display: Monday first, then by start time. Does not mutate. */
export function sortWeeklyWindows(windows: WeeklyWindow[]): WeeklyWindow[] {
  const rank = (day: number): number => {
    const index = WEEKDAY_ORDER.indexOf(day);
    return index === -1 ? WEEKDAY_ORDER.length : index;
  };
  return [...windows].sort((a, b) =>
    rank(a.dayOfWeek) - rank(b.dayOfWeek) || minutesOfDay(a.from) - minutesOfDay(b.from));
}

// ─── Expansion ────────────────────────────────────────────────────────────────

/**
 * Expands recurring windows into concrete dated slots covering `days` calendar
 * days starting on the day `fromDate` falls on — in each window's OWN zone, so
 * a user in Tokyo and a window in New York each start from the right date.
 *
 * The result is sorted by date, then by start time, then by zone, and carries
 * no duplicates. Times are emitted as '9:00 AM' with `date` as 'YYYY-MM-DD',
 * which is exactly what lib/computeOverlap.ts parses.
 *
 * Pure: same inputs, same output, no clock read of its own.
 */
export function expandWeeklyWindows(
  windows:  WeeklyWindow[],
  fromDate: Date,
  days:     number = DEFAULT_EXPANSION_DAYS,
): AvailabilitySlot[] {
  if (!Array.isArray(windows) || windows.length === 0) return [];
  if (!(fromDate instanceof Date) || Number.isNaN(fromDate.getTime())) return [];

  const horizon = Math.min(Math.max(Math.trunc(days), 0), MAX_EXPANSION_DAYS);
  if (horizon === 0) return [];

  // One "today" per zone, resolved once rather than per window.
  const startByZone = new Map<string, CivilDate>();
  const slots: AvailabilitySlot[] = [];
  const seen  = new Set<string>();

  for (const window of windows) {
    let start = startByZone.get(window.timezone);
    if (!start) {
      start = civilDateInZone(fromDate, window.timezone);
      startByZone.set(window.timezone, start);
    }

    const startTime = toDisplayTime(window.from);
    const endTime   = toDisplayTime(window.to);
    if (!startTime || !endTime) continue;

    for (let offset = 0; offset < horizon; offset++) {
      // Civil increment, never an instant + 86 400 000 ms — see the file header.
      const date = addCivilDays(start, offset);
      if (civilDayOfWeek(date) !== window.dayOfWeek) continue;

      const iso = civilDateToIso(date);
      const key = `${iso}|${startTime}|${endTime}|${window.timezone}`;
      if (seen.has(key)) continue;
      seen.add(key);

      slots.push({
        startTime,
        endTime,
        timezone:   window.timezone,
        date:       iso,
        dayOfWeek:  weekdayLabel(window.dayOfWeek),
        confidence: 'high',
      });
    }
  }

  return sortSlots(slots);
}

/**
 * Chronological order for dated slots: date, then start time, then zone so the
 * order is total (two zones can hold the same wall-clock window on a day).
 * Slots with no date sort last, keeping their relative order.
 */
export function sortSlots(slots: AvailabilitySlot[]): AvailabilitySlot[] {
  const startMinutes = (slot: AvailabilitySlot): number => {
    const match = slot.startTime.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
    if (!match) return Number.MAX_SAFE_INTEGER;
    let hours = Number(match[1]) % 12;
    if (match[3].toUpperCase() === 'PM') hours += 12;
    return hours * 60 + Number(match[2]);
  };

  return [...slots].sort((a, b) => {
    const dateA = a.date ?? '￿';
    const dateB = b.date ?? '￿';
    if (dateA !== dateB) return dateA < dateB ? -1 : 1;
    const minutes = startMinutes(a) - startMinutes(b);
    if (minutes !== 0) return minutes;
    return a.timezone.localeCompare(b.timezone);
  });
}

/**
 * Drops slots whose date is already past, judged in the slot's OWN zone at
 * `now` — a 6pm-Tokyo slot is not stale because it is still yesterday morning
 * in New York. Undated slots (a bare day-of-week from another provider) are
 * kept: they carry no date to be past.
 */
export function dropPastSlots(slots: AvailabilitySlot[], now: Date): AvailabilitySlot[] {
  const todayByZone = new Map<string, CivilDate>();

  return slots.filter(slot => {
    if (!slot.date) return true;
    const date = isoToCivilDate(slot.date);
    if (!date) return false;

    const zone = slot.timezone || 'UTC';
    let today = todayByZone.get(zone);
    if (!today) {
      today = civilDateInZone(now, zone);
      todayByZone.set(zone, today);
    }
    return !civilDateIsBefore(date, today);
  });
}

/**
 * Merges expanded weekly windows with one-off slots into one ordered list with
 * no duplicates and nothing in the past. The single entry point the scheduler
 * uses (lib/calendarConnections.getClientSlotsForUser).
 */
export function mergeAvailability(
  weekly:  WeeklyWindow[],
  oneOffs: AvailabilitySlot[],
  now:     Date,
  days:    number = DEFAULT_EXPANSION_DAYS,
): AvailabilitySlot[] {
  const expanded = expandWeeklyWindows(weekly, now, days);
  const combined = dropPastSlots([...expanded, ...oneOffs], now);

  const seen = new Set<string>();
  const out: AvailabilitySlot[] = [];
  for (const slot of combined) {
    const key = `${slot.date ?? slot.dayOfWeek ?? ''}|${slot.startTime}|${slot.endTime}|${slot.timezone}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(slot);
  }

  return sortSlots(out);
}

// ─── jsonb round-trip ─────────────────────────────────────────────────────────

/** A WeeklyWindow as a plain jsonb-safe object (the interface has no index signature). */
export function weeklyWindowToJson(window: WeeklyWindow): {
  dayOfWeek: number; from: string; to: string; timezone: string;
} {
  return {
    dayOfWeek: window.dayOfWeek,
    from:      window.from,
    to:        window.to,
    timezone:  window.timezone,
  };
}
