// Compute scheduling overlap between expert and client availability slots.
// No external date libraries — uses Node built-ins (Intl, Date) only.
// Never logs slot contents or personal data.

import type { AvailabilitySlot, OverlapResult, OverlapSlot } from '../types';

// ─── Timezone normalization ───────────────────────────────────────────────────

const TZ_MAP: Record<string, string> = {
  ET: 'America/New_York',  EST: 'America/New_York',  EDT: 'America/New_York',
  CT: 'America/Chicago',   CST: 'America/Chicago',   CDT: 'America/Chicago',
  MT: 'America/Denver',    MST: 'America/Denver',    MDT: 'America/Denver',
  PT: 'America/Los_Angeles', PST: 'America/Los_Angeles', PDT: 'America/Los_Angeles',
  GMT: 'Europe/London',    UTC: 'UTC',
};

function resolveTimezone(tz: string): string {
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
function localToUtc(
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

/** Find the next occurrence of `targetDay` (e.g. "Monday") within the next 14 days. */
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

function slotToUtcRange(
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

// ─── Scoring ──────────────────────────────────────────────────────────────────

function scoreSlot(
  slot: OverlapSlot,
  expertTzIana: string,
  clientTzIana: string,
): number {
  let score = 0;
  const startUtc = new Date(slot.startUtc);

  // Business hours check for both parties (9am–6pm local)
  const expertHour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: expertTzIana, hour: 'numeric', hour12: false,
    }).format(startUtc),
    10,
  ) % 24;
  const clientHour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      timeZone: clientTzIana, hour: 'numeric', hour12: false,
    }).format(startUtc),
    10,
  ) % 24;

  if (expertHour >= 9 && expertHour < 18 && clientHour >= 9 && clientHour < 18) score += 30;

  // Within next 7 days
  if (startUtc.getTime() - Date.now() < 7 * 24 * 60 * 60_000) score += 20;

  // Duration >= 60 min
  if (slot.durationMin >= 60) score += 20;

  // Avoid Monday 9am or Friday 4pm+ (expert's local time)
  const dayOfWeek = new Intl.DateTimeFormat('en-US', {
    timeZone: expertTzIana, weekday: 'long',
  }).format(startUtc);

  if (!(dayOfWeek === 'Monday' && expertHour === 9) &&
      !(dayOfWeek === 'Friday' && expertHour >= 16)) {
    score += 30;
  }

  return score;
}

// ─── Format helper ────────────────────────────────────────────────────────────

function formatInTimezone(utcDate: Date, tzIana: string): string {
  return new Intl.DateTimeFormat('en-US', {
    timeZone:    tzIana,
    weekday:     'short',
    month:       'short',
    day:         'numeric',
    hour:        'numeric',
    minute:      '2-digit',
    hour12:      true,
  }).format(utcDate);
}

// ─── Timezone extraction helper ───────────────────────────────────────────────

function extractTimezone(slots: AvailabilitySlot[]): string {
  const tz = slots.find(s => s.timezone)?.timezone ?? 'UTC';
  return resolveTimezone(tz);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function computeOverlap(
  expertSlots:    AvailabilitySlot[],
  clientSlots:    AvailabilitySlot[],
  expertTimezone: string,
  clientTimezone: string,
): Promise<OverlapResult> {
  const expertTzIana = resolveTimezone(expertTimezone);
  const clientTzIana = resolveTimezone(clientTimezone);

  const overlaps: OverlapSlot[] = [];

  for (const es of expertSlots) {
    const eRange = slotToUtcRange(es, expertTzIana);
    if (!eRange) continue;

    for (const cs of clientSlots) {
      const cRange = slotToUtcRange(cs, clientTzIana);
      if (!cRange) continue;

      const overlapStart = new Date(Math.max(eRange.start.getTime(), cRange.start.getTime()));
      const overlapEnd   = new Date(Math.min(eRange.end.getTime(),   cRange.end.getTime()));

      const durationMs = overlapEnd.getTime() - overlapStart.getTime();
      if (durationMs < 30 * 60_000) continue;  // need at least 30 minutes

      const durationMin = Math.floor(durationMs / 60_000);

      const overlapSlot: OverlapSlot = {
        startUtc:    overlapStart.toISOString(),
        endUtc:      overlapEnd.toISOString(),
        startExpert: formatInTimezone(overlapStart, expertTzIana),
        startClient: formatInTimezone(overlapStart, clientTzIana),
        durationMin,
        score:       0,
      };

      overlapSlot.score = scoreSlot(overlapSlot, expertTzIana, clientTzIana);
      overlaps.push(overlapSlot);
    }
  }

  // Sort by score descending, take top 5
  overlaps.sort((a, b) => b.score - a.score);
  const topSlots = overlaps.slice(0, 5);

  return {
    found:          topSlots.length > 0,
    slots:          topSlots,
    bestSlot:       topSlots[0] ?? null,
    expertTimezone: expertTzIana,
    clientTimezone: clientTzIana,
  };
}
