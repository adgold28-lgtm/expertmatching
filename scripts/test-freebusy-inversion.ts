// scripts/test-freebusy-inversion.ts — unit tests for invertBusyToFree, the
// busy→free step in lib/fetchGoogleFreebusy.ts (H-21).
//
// The question this file answers: can a client whose working day is nowhere near
// UTC still be offered their real availability? invertBusyToFree used to invert
// inside a fixed 08:00–19:00 UTC band, which is 03:00–14:00 in New York,
// 00:00–11:00 in Los Angeles and 16:00–03:00 in Singapore — so most of a
// west-coast or Asian working day could never be proposed. It now inverts over
// the whole UTC day and leaves business hours to pickProposals, which applies
// them in the OWNER's zone.
//
// Every assertion below is written in LOCAL business hours for a real zone and
// checks that the free ranges cover them, so a re-introduced UTC band fails here
// rather than in production. No network, no env vars, pure functions only.
//
//   npx tsx scripts/test-freebusy-inversion.ts
//
// Exits non-zero on any failing assertion.

import { invertBusyToFree } from '../lib/fetchGoogleFreebusy';
import { slotToUtcRange } from '../lib/computeOverlap';
import type { AvailabilitySlot } from '../types';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** The UTC instant of a wall-clock time in a named zone. Mirrors localToUtc. */
function utcMsOfLocal(dateIso: string, hour: number, minute: number, tz: string): number {
  const [y, m, d] = dateIso.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d, hour, minute, 0);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(guess));
  const p = Object.fromEntries(parts.map(pt => [pt.type, pt.value]));
  const offsetMin = (hour - (parseInt(p.hour, 10) % 24)) * 60 + (minute - parseInt(p.minute, 10));
  return guess + offsetMin * 60_000;
}

/** The free slots, resolved back to absolute UTC ranges the scheduler would see. */
function rangesOf(slots: AvailabilitySlot[]): Array<{ startMs: number; endMs: number }> {
  const out: Array<{ startMs: number; endMs: number }> = [];
  for (const slot of slots) {
    const r = slotToUtcRange(slot, 'UTC');
    if (r) out.push({ startMs: r.start.getTime(), endMs: r.end.getTime() });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Is a whole [from, to] interval inside one free range? */
function covered(ranges: Array<{ startMs: number; endMs: number }>, from: number, to: number): boolean {
  return ranges.some(r => r.startMs <= from && r.endMs >= to);
}

/** Every 60-minute call start on the half-hour grid inside local 09:00–17:00. */
function businessStarts(dateIso: string, tz: string): Array<{ label: string; from: number; to: number }> {
  const out: Array<{ label: string; from: number; to: number }> = [];
  for (let mins = 9 * 60; mins + 60 <= 17 * 60; mins += 30) {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    const from = utcMsOfLocal(dateIso, h, m, tz);
    out.push({ label: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')} local`, from, to: from + 60 * 60_000 });
  }
  return out;
}

/**
 * The documented boundary: a slot cannot name a time on the following day, so
 * each UTC day's free block stops at 23:59 and a call that would run past it is
 * unofferable. Exactly one half-hour start per day is affected — 23:00 UTC —
 * plus the 23:30 start, which straddles midnight and could never be offered by a
 * per-day inversion anyway. Everything else must be free.
 */
const MS_DAY = 24 * 60 * 60_000;
function pastDayEnd(from: number, to: number): boolean {
  return to > Math.floor(from / MS_DAY) * MS_DAY + 23 * 60 * 60_000 + 59 * 60_000;
}

// A Wednesday, and the two days around it, well clear of any DST boundary.
const DAY   = '2026-10-14';
const START = new Date(Date.UTC(2026, 9, 13, 0, 0, 0));   // Tue 13 Oct 00:00 UTC
const END   = new Date(Date.UTC(2026, 9, 17, 0, 0, 0));   // Sat 17 Oct 00:00 UTC

// ── An empty calendar covers the whole local working day ─────────────────────
// This is the H-21 regression: with the old 08:00–19:00 UTC band, LA lost every
// start from 11:00 local and Singapore lost all but the earliest.

section('an empty calendar covers every business-hour start, in every zone');

for (const tz of ['America/New_York', 'America/Los_Angeles', 'Asia/Singapore']) {
  const free = rangesOf(invertBusyToFree([], START, END));
  for (const s of businessStarts(DAY, tz)) {
    if (pastDayEnd(s.from, s.to)) {
      // Not a failure: the midnight-UTC boundary, stated so it stays visible.
      check(`${tz} ${s.label} is the midnight-UTC casualty`, !covered(free, s.from, s.to));
    } else {
      check(`${tz} ${s.label} offerable`, covered(free, s.from, s.to));
    }
  }
}

// ── A real busy block removes exactly itself, and nothing else ───────────────

section('busy blocks subtract only themselves');

{
  const tz = 'America/Los_Angeles';
  // Busy 10:00–11:00 Pacific.
  const busyStart = utcMsOfLocal(DAY, 10, 0, tz);
  const busy = [{
    start: new Date(busyStart).toISOString(),
    end:   new Date(busyStart + 60 * 60_000).toISOString(),
  }];
  const free = rangesOf(invertBusyToFree(busy, START, END));

  for (const s of businessStarts(DAY, tz)) {
    const blocked = (s.from < busyStart + 60 * 60_000 && s.to > busyStart) || pastDayEnd(s.from, s.to);
    check(
      `LA ${s.label} ${blocked ? 'blocked' : 'offerable'}`,
      covered(free, s.from, s.to) === !blocked,
    );
  }
}

{
  const tz = 'Asia/Singapore';
  // Busy 14:00–15:30 Singapore — an afternoon the old UTC band could not even
  // represent, since 14:00 SGT is 06:00 UTC, before the old 08:00 floor.
  const busyStart = utcMsOfLocal(DAY, 14, 0, tz);
  const busyEnd   = busyStart + 90 * 60_000;
  const busy = [{ start: new Date(busyStart).toISOString(), end: new Date(busyEnd).toISOString() }];
  const free = rangesOf(invertBusyToFree(busy, START, END));

  check('SGT 09:00 still offerable', covered(free, utcMsOfLocal(DAY, 9, 0, tz), utcMsOfLocal(DAY, 10, 0, tz)));
  check('SGT 13:00 still offerable', covered(free, utcMsOfLocal(DAY, 13, 0, tz), utcMsOfLocal(DAY, 14, 0, tz)));
  check('SGT 14:00 blocked',        !covered(free, busyStart, busyStart + 60 * 60_000));
  check('SGT 15:00 blocked',        !covered(free, busyStart + 60 * 60_000, busyStart + 120 * 60_000));
  check('SGT 16:00 offerable again', covered(free, busyEnd, busyEnd + 30 * 60_000));
}

// ── The old band, stated as an explicit regression ──────────────────────────
// These three fail on the pre-fix code and are the reason this file exists.

section('the pre-fix 08:00–19:00 UTC band is gone');

{
  const free = rangesOf(invertBusyToFree([], START, END));
  const before8 = Date.UTC(2026, 9, 14, 3, 0, 0);
  const after19 = Date.UTC(2026, 9, 14, 20, 0, 0);
  check('03:00 UTC is free',                 covered(free, before8, before8 + 60 * 60_000));
  check('20:00 UTC is free',                 covered(free, after19, after19 + 60 * 60_000));
  // 15:00 Pacific is 22:00 UTC: inside no business band the old code allowed,
  // and the single check that most cleanly separates old behaviour from new.
  check('15:00 Pacific free',
    covered(free, utcMsOfLocal(DAY, 15, 0, 'America/Los_Angeles'), utcMsOfLocal(DAY, 16, 0, 'America/Los_Angeles')));
  // Late Eastern, the case H-21 names first: nothing after ~13:00 ET survived.
  check('16:00 Eastern free',
    covered(free, utcMsOfLocal(DAY, 16, 0, 'America/New_York'), utcMsOfLocal(DAY, 17, 0, 'America/New_York')));
}

// ── Shape of the emitted slots ───────────────────────────────────────────────

section('slot shape');

{
  const slots = invertBusyToFree([], START, END);
  const day   = slots.filter(s => s.date === DAY);
  eq('one slot per free day',            day.length, 1);
  eq('stamped UTC',                      day[0].timezone, 'UTC');
  eq('starts at midnight',               day[0].startTime, '12:00 AM');
  eq('ends at 11:59 PM, never midnight', day[0].endTime,   '11:59 PM');
  eq('weekday name matches the date',    day[0].dayOfWeek, 'Wednesday');
  eq('confidence is high',               day[0].confidence, 'high');
  check('every emitted slot resolves to a real range',
    slots.length > 0 && rangesOf(slots).length === slots.length);
}

{
  // A day that is busy end to end emits nothing at all.
  const busy = [{
    start: new Date(Date.UTC(2026, 9, 14, 0, 0, 0)).toISOString(),
    end:   new Date(Date.UTC(2026, 9, 15, 0, 0, 0)).toISOString(),
  }];
  const slots = invertBusyToFree(busy, START, END).filter(s => s.date === DAY);
  eq('a fully booked day emits no free slot', slots.length, 0);
}

{
  // Overlapping and out-of-order busy blocks must not produce inverted ranges.
  const mk = (h1: number, h2: number) => ({
    start: new Date(Date.UTC(2026, 9, 14, h1, 0, 0)).toISOString(),
    end:   new Date(Date.UTC(2026, 9, 14, h2, 0, 0)).toISOString(),
  });
  const slots = invertBusyToFree([mk(14, 16), mk(9, 12), mk(10, 13)], START, END);
  const ranges = rangesOf(slots.filter(s => s.date === DAY));
  check('no zero or negative ranges', ranges.every(r => r.endMs > r.startMs));
  check('overlapping busy blocks merge',
    !covered(ranges, Date.UTC(2026, 9, 14, 12, 0, 0), Date.UTC(2026, 9, 14, 13, 0, 0)));
  check('the gap between the two busy runs is free',
    covered(ranges, Date.UTC(2026, 9, 14, 13, 0, 0), Date.UTC(2026, 9, 14, 14, 0, 0)));
}

// ── Result ───────────────────────────────────────────────────────────────────

summary();
