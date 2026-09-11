// scripts/test-availability-windows.ts — unit tests for lib/availabilityWindows.ts
// and for the CALENDLY_ENABLED flag that decides whether a Calendly connection
// counts as a calendar at all (lib/calendlyFlag.ts, lib/calendarConnections.ts).
//
// Pure functions only: no database, no network, no env vars.
//
//   npx tsx scripts/test-availability-windows.ts
//
// Exits non-zero on the first failing assertion set, so it can gate a deploy.
//
// The interesting case is the DST boundary. A recurring window means the same
// WALL-CLOCK time on both sides of a transition, and the expansion walks the
// civil calendar rather than adding 86 400 000 ms to an instant — so the run
// across 1 November 2026 (US fall-back) must produce consecutive Sundays with
// unchanged times, no skipped date and no repeated one.

import {
  MAX_WEEKLY_WINDOWS,
  expandWeeklyWindows,
  validateWeeklyWindow,
  parseWeeklyWindows,
  sanitizeWeeklyWindows,
  dedupeWeeklyWindows,
  sortWeeklyWindows,
  dropPastSlots,
  mergeAvailability,
  addCivilDays,
  civilDateInZone,
  civilDayOfWeek,
  civilDateToIso,
  isoToCivilDate,
  toDisplayTime,
  minutesOfDay,
  isHhMm,
  type WeeklyWindow,
} from '../lib/availabilityWindows';
import { calendlyEnabled } from '../lib/calendlyFlag';
import { connectionIsUsable } from '../lib/calendarConnections';
import type { UserCalendarConnectionRow } from '../lib/supabase/database.types';
import type { AvailabilitySlot } from '../types';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

const NY = 'America/New_York';

function window(dayOfWeek: number, from: string, to: string, timezone = NY): WeeklyWindow {
  return { dayOfWeek, from, to, timezone };
}

// ─── Civil-calendar primitives ────────────────────────────────────────────────

section('civil-calendar primitives');

eq('addCivilDays crosses a month end', civilDateToIso(addCivilDays({ year: 2026, month: 1, day: 31 }, 1)), '2026-02-01');
eq('addCivilDays handles a leap year', civilDateToIso(addCivilDays({ year: 2028, month: 2, day: 28 }, 1)), '2028-02-29');
eq('addCivilDays handles a non-leap year', civilDateToIso(addCivilDays({ year: 2026, month: 2, day: 28 }, 1)), '2026-03-01');
eq('civilDayOfWeek(2026-09-07) is Monday', civilDayOfWeek({ year: 2026, month: 9, day: 7 }), 1);
eq('civilDayOfWeek(2026-11-01) is Sunday', civilDayOfWeek({ year: 2026, month: 11, day: 1 }), 0);
eq('isoToCivilDate rejects 2026-02-30', isoToCivilDate('2026-02-30'), null);
eq('isoToCivilDate rejects a malformed string', isoToCivilDate('7 September'), null);
check('isoToCivilDate accepts a real date', civilDateToIso(isoToCivilDate('2026-09-07')!) === '2026-09-07');

// 02:30 UTC on 8 September is still 22:30 on the 7th in New York (UTC-4 in
// September) and already 11:30 on the 8th in Tokyo (UTC+9) — the zone decides
// which day "today" is.
const lateNightUtc = new Date('2026-09-08T02:30:00Z');
eq('civilDateInZone reads the local date in New York', civilDateToIso(civilDateInZone(lateNightUtc, NY)), '2026-09-07');
eq('civilDateInZone reads the local date in Tokyo',    civilDateToIso(civilDateInZone(lateNightUtc, 'Asia/Tokyo')), '2026-09-08');

eq('toDisplayTime(09:00)', toDisplayTime('09:00'), '9:00 AM');
eq('toDisplayTime(00:15)', toDisplayTime('00:15'), '12:15 AM');
eq('toDisplayTime(12:00)', toDisplayTime('12:00'), '12:00 PM');
eq('toDisplayTime(23:45)', toDisplayTime('23:45'), '11:45 PM');
eq('toDisplayTime rejects 24:00', toDisplayTime('24:00'), '');
eq('minutesOfDay(09:30)', minutesOfDay('09:30'), 570);
check('isHhMm rejects a single-digit hour', !isHhMm('9:00'));
check('isHhMm rejects 24:00',               !isHhMm('24:00'));
check('isHhMm accepts 00:00',                isHhMm('00:00'));
check('isHhMm accepts 23:59',                isHhMm('23:59'));

// ─── Validation ───────────────────────────────────────────────────────────────

section('validation');

check('a well-formed window is accepted', validateWeeklyWindow(window(2, '09:00', '11:30')).ok);

const rejects: Array<[name: string, value: unknown, reason: string]> = [
  ['to === from is rejected',              window(2, '09:00', '09:00'), 'end_not_after_start'],
  ['to < from is rejected',                window(2, '11:30', '09:00'), 'end_not_after_start'],
  ['a 24h wrap (22:00 → 02:00) is rejected', window(2, '22:00', '02:00'), 'end_not_after_start'],
  ['a full-day 00:00 → 24:00 is rejected', window(2, '00:00', '24:00'), 'invalid_time'],
  ['dayOfWeek 7 is rejected',              window(7, '09:00', '10:00'), 'invalid_day'],
  ['dayOfWeek -1 is rejected',             window(-1, '09:00', '10:00'), 'invalid_day'],
  ['a fractional dayOfWeek is rejected',   { dayOfWeek: 1.5, from: '09:00', to: '10:00', timezone: NY }, 'invalid_day'],
  ['a string dayOfWeek is not coerced',    { dayOfWeek: '1', from: '09:00', to: '10:00', timezone: NY }, 'invalid_day'],
  ['a single-digit hour is rejected',      { dayOfWeek: 1, from: '9:00', to: '10:00', timezone: NY }, 'invalid_time'],
  ['a made-up timezone is rejected',       window(1, '09:00', '10:00', 'Mars/Olympus_Mons'), 'invalid_timezone'],
  ['an injected timezone is rejected',     window(1, '09:00', '10:00', "'; drop table --"), 'invalid_timezone'],
  ['a missing timezone is rejected',       { dayOfWeek: 1, from: '09:00', to: '10:00' }, 'invalid_timezone'],
  ['an array is not a window',             [1, 2], 'not_an_object'],
  ['null is not a window',                 null, 'not_an_object'],
  ['a string is not a window',             'Tuesday 9-11', 'not_an_object'],
];

for (const [name, value, reason] of rejects) {
  const result = validateWeeklyWindow(value);
  check(name, !result.ok && result.reason === reason,
    result.ok ? 'accepted' : `reason was ${result.reason}`);
}

// 00:00 → 23:59 is the longest legal window: a whole day without wrapping.
check('00:00 → 23:59 is accepted as the longest legal window',
  validateWeeklyWindow(window(3, '00:00', '23:59')).ok);

section('parseWeeklyWindows');

const parsedOk = parseWeeklyWindows([window(1, '09:00', '10:00'), window(3, '13:00', '15:00')]);
check('a valid array parses', parsedOk.ok && parsedOk.windows.length === 2);

const parsedBad = parseWeeklyWindows([window(1, '09:00', '10:00'), window(3, '15:00', '13:00')]);
check('the first bad entry is refused with its index',
  !parsedBad.ok && parsedBad.reason === 'end_not_after_start' && parsedBad.index === 1,
  parsedBad.ok ? 'accepted' : `${parsedBad.reason} @ ${parsedBad.index}`);

const tooMany = parseWeeklyWindows(
  Array.from({ length: MAX_WEEKLY_WINDOWS + 1 }, (_, i) => window(i % 7, '09:00', '10:00')),
);
check(`more than ${MAX_WEEKLY_WINDOWS} windows is refused`,
  !tooMany.ok && tooMany.reason === 'too_many_windows');

const atLimit = parseWeeklyWindows(
  Array.from({ length: MAX_WEEKLY_WINDOWS }, (_, i) =>
    window(i % 7, `${String(9 + Math.floor(i / 7)).padStart(2, '0')}:00`, `${String(10 + Math.floor(i / 7)).padStart(2, '0')}:00`)),
);
check(`exactly ${MAX_WEEKLY_WINDOWS} windows is accepted`, atLimit.ok);

check('undefined parses as an empty list', parseWeeklyWindows(undefined).ok);
check('a non-array is refused', !parseWeeklyWindows({ dayOfWeek: 1 }).ok);

section('sanitizeWeeklyWindows drops rather than explains');

const sanitized = sanitizeWeeklyWindows([
  window(1, '09:00', '10:00'),
  window(1, '15:00', '13:00'),           // backwards — dropped
  'not a window',                        // junk — dropped
  window(4, '08:00', '09:00'),
]);
eq('two of four survive', sanitized.length, 2);
eq('the surviving order is preserved', sanitized[0].dayOfWeek, 1);
eq('sanitize of a non-array is empty', sanitizeWeeklyWindows('nope').length, 0);

section('dedupe and sort');

eq('exact duplicates collapse',
  dedupeWeeklyWindows([window(1, '09:00', '10:00'), window(1, '09:00', '10:00')]).length, 1);
eq('the same hours in two zones are NOT duplicates',
  dedupeWeeklyWindows([window(1, '09:00', '10:00', NY), window(1, '09:00', '10:00', 'Europe/London')]).length, 2);

const sortedWindows = sortWeeklyWindows([
  window(0, '09:00', '10:00'),  // Sunday — last in a Mon-first week
  window(3, '14:00', '15:00'),
  window(3, '09:00', '10:00'),
  window(1, '17:00', '18:00'),
]);
eq('Monday sorts first',            sortedWindows[0].dayOfWeek, 1);
eq('Wednesday morning before afternoon', sortedWindows[1].from, '09:00');
eq('then Wednesday afternoon',      sortedWindows[2].from, '14:00');
eq('Sunday sorts last',             sortedWindows[3].dayOfWeek, 0);

// ─── Expansion ────────────────────────────────────────────────────────────────

section('expansion — shape and ordering');

// Monday 7 September 2026, 13:00 UTC (09:00 in New York).
const MONDAY = new Date('2026-09-07T13:00:00Z');

const twoPerWeek = expandWeeklyWindows(
  [window(2, '09:00', '11:30'), window(4, '14:00', '16:00')],
  MONDAY,
  14,
);
eq('two windows over 14 days produce four slots', twoPerWeek.length, 4);
eq('the first slot is the coming Tuesday', twoPerWeek[0].date, '2026-09-08');
eq('then Thursday',                        twoPerWeek[1].date, '2026-09-10');
eq('then the following Tuesday',           twoPerWeek[2].date, '2026-09-15');
eq('then the following Thursday',          twoPerWeek[3].date, '2026-09-17');
eq('times are emitted in the format computeOverlap parses', twoPerWeek[0].startTime, '9:00 AM');
eq('and the end time likewise',            twoPerWeek[0].endTime, '11:30 AM');
eq('the zone rides on the slot',           twoPerWeek[0].timezone, NY);
eq('dayOfWeek is the full weekday name',   twoPerWeek[0].dayOfWeek, 'Tuesday');
eq('confidence is high — the user typed this', twoPerWeek[0].confidence, 'high');

check('dates come out in ascending order',
  twoPerWeek.every((slot, i) => i === 0 || (slot.date ?? '') >= (twoPerWeek[i - 1].date ?? '')));

// A window on the start day itself is included: "today counts".
const startDayIncluded = expandWeeklyWindows([window(1, '09:00', '17:00')], MONDAY, 14);
eq('a window falling on the start day is included', startDayIncluded[0].date, '2026-09-07');
eq('and recurs a week later',                      startDayIncluded[1].date, '2026-09-14');

// Two windows on the same day sort by start time.
const sameDay = expandWeeklyWindows([window(2, '15:00', '16:00'), window(2, '09:00', '10:00')], MONDAY, 7);
eq('same-day slots sort by start time', sameDay[0].startTime, '9:00 AM');
eq('the later one second',              sameDay[1].startTime, '3:00 PM');

eq('a zero-day horizon expands to nothing', expandWeeklyWindows([window(2, '09:00', '10:00')], MONDAY, 0).length, 0);
eq('no windows expand to nothing',          expandWeeklyWindows([], MONDAY, 14).length, 0);
eq('an invalid date expands to nothing',    expandWeeklyWindows([window(2, '09:00', '10:00')], new Date('nope'), 14).length, 0);
eq('a 7-day horizon yields one occurrence', expandWeeklyWindows([window(5, '09:00', '10:00')], MONDAY, 7).length, 1);
eq('duplicate windows do not duplicate slots',
  expandWeeklyWindows([window(2, '09:00', '10:00'), window(2, '09:00', '10:00')], MONDAY, 14).length, 2);

section('expansion — the start date is read in the WINDOW\'s zone');

// 03:00 UTC on Tuesday 8 September is still Monday evening (23:00) in New York,
// but already Tuesday midday in Tokyo. A Monday window must therefore still
// fire for New York today, and must wait a week for Tokyo — Monday is over
// there.
const tuesdayEarlyUtc = new Date('2026-09-08T03:00:00Z');
const nyMonday    = expandWeeklyWindows([window(1, '09:00', '10:00', NY)], tuesdayEarlyUtc, 8);
const tokyoMonday = expandWeeklyWindows([window(1, '09:00', '10:00', 'Asia/Tokyo')], tuesdayEarlyUtc, 8);
eq('New York still sees Monday the 7th', nyMonday[0].date, '2026-09-07');
eq('Tokyo has moved on to next Monday',  tokyoMonday[0].date, '2026-09-14');

section('expansion across a DST boundary');

// US fall-back is Sunday 1 November 2026 at 02:00 local. A "Sunday 09:00-11:00
// New York" window either side of it must stay 9:00 AM — the wall clock is the
// promise, not the UTC offset.
const OCT_26 = new Date('2026-10-26T12:00:00Z');   // Monday, before the change
const acrossFallBack = expandWeeklyWindows([window(0, '09:00', '11:00')], OCT_26, 21);

eq('three Sundays in a 21-day window', acrossFallBack.length, 3);
eq('the Sunday before the change', acrossFallBack[0].date, '2026-11-01');
eq('the Sunday after',             acrossFallBack[1].date, '2026-11-08');
eq('and the one after that',       acrossFallBack[2].date, '2026-11-15');
check('the wall-clock start is identical on both sides of the transition',
  acrossFallBack.every(s => s.startTime === '9:00 AM'),
  acrossFallBack.map(s => s.startTime).join(', '));
check('and so is the end',
  acrossFallBack.every(s => s.endTime === '11:00 AM'));

// The transition day itself. Sunday 1 November is a 25-hour day in New York;
// walking it must produce exactly one 1 November and exactly one 2 November.
const DAILY = [0, 1, 2, 3, 4, 5, 6].map(d => window(d, '09:00', '10:00'));
const acrossTransitionDaily = expandWeeklyWindows(DAILY, new Date('2026-10-30T12:00:00Z'), 7);
const transitionDates = acrossTransitionDaily.map(s => s.date ?? '');
eq('a daily window over 7 days yields 7 slots', acrossTransitionDaily.length, 7);
eq('no date is repeated across the 25-hour day', new Set(transitionDates).size, 7);
eq('the run starts on the 30th', transitionDates[0], '2026-10-30');
eq('1 November appears exactly once', transitionDates.filter(d => d === '2026-11-01').length, 1);
eq('2 November appears exactly once', transitionDates.filter(d => d === '2026-11-02').length, 1);
check('the dates are consecutive with no gap',
  transitionDates.every((iso, i) => i === 0 || civilDateToIso(addCivilDays(isoToCivilDate(transitionDates[i - 1])!, 1)) === iso),
  transitionDates.join(', '));

// Spring-forward: Sunday 8 March 2026 is a 23-hour day in New York.
const acrossSpringForward = expandWeeklyWindows(DAILY, new Date('2026-03-06T12:00:00Z'), 7);
const springDates = acrossSpringForward.map(s => s.date ?? '');
eq('seven slots across the 23-hour day', acrossSpringForward.length, 7);
eq('no date is lost',                    new Set(springDates).size, 7);
eq('8 March appears exactly once',       springDates.filter(d => d === '2026-03-08').length, 1);
check('every slot still starts at 9:00 AM local',
  acrossSpringForward.every(s => s.startTime === '9:00 AM'));

// A southern-hemisphere zone transitions in the opposite direction on a
// different date — the same code path, no special cases.
const sydney = expandWeeklyWindows(
  [window(0, '09:00', '10:00', 'Australia/Sydney')],
  new Date('2026-09-28T00:00:00Z'),
  21,
);
eq('three Sundays in Sydney across its October transition', sydney.length, 3);
check('unchanged wall-clock in Sydney too', sydney.every(s => s.startTime === '9:00 AM'));

// ─── Past-slot pruning and merging ────────────────────────────────────────────

section('dropPastSlots');

function slot(date: string, startTime = '9:00 AM', timezone = NY): AvailabilitySlot {
  return { date, startTime, endTime: '10:00 AM', timezone, confidence: 'high' };
}

const NOW = new Date('2026-09-07T16:00:00Z');   // Monday 7 September, noon in NY

const pruned = dropPastSlots(
  [slot('2026-09-01'), slot('2026-09-07'), slot('2026-09-20')],
  NOW,
);
eq('yesterday is gone, today and the future stay', pruned.length, 2);
eq('today survives',      pruned[0].date, '2026-09-07');
eq('the future survives', pruned[1].date, '2026-09-20');

eq('an unparseable date is dropped', dropPastSlots([slot('not-a-date')], NOW).length, 0);
eq('an undated slot is kept',
  dropPastSlots([{ dayOfWeek: 'Monday', startTime: '9:00 AM', endTime: '10:00 AM', timezone: NY }], NOW).length, 1);

// "Today" is judged in the slot's own zone. At 2026-09-08T02:30Z it is still
// the 7th in New York (so a 7 September slot survives) but already the 8th in
// Tokyo (so a 7 September Tokyo slot is past).
const acrossMidnight = dropPastSlots(
  [slot('2026-09-07', '9:00 AM', NY), slot('2026-09-07', '9:00 AM', 'Asia/Tokyo')],
  new Date('2026-09-08T02:30:00Z'),
);
eq('the New York slot survives its own midnight', acrossMidnight.length, 1);
eq('and it is the New York one',                  acrossMidnight[0].timezone, NY);

section('mergeAvailability');

const merged = mergeAvailability(
  [window(2, '09:00', '11:30')],                       // every Tuesday
  [slot('2026-09-09', '2:00 PM'), slot('2026-08-01')], // one-off + a past date
  MONDAY,
  14,
);
eq('past one-offs are dropped, the rest merge', merged.length, 3);
eq('the Tuesday from the rule comes first', merged[0].date, '2026-09-08');
eq('then the Wednesday one-off',            merged[1].date, '2026-09-09');
eq('then the following Tuesday',            merged[2].date, '2026-09-15');
check('the merged list is ordered by date',
  merged.every((s, i) => i === 0 || (s.date ?? '') >= (merged[i - 1].date ?? '')));

// A one-off that repeats what the rule already says must not appear twice.
// Identical means all four of date, start, end and zone — a one-off with the
// same start but a different end is a different window and must survive.
const overlapping = mergeAvailability(
  [window(2, '09:00', '11:30')],
  [{ date: '2026-09-08', startTime: '9:00 AM', endTime: '11:30 AM', timezone: NY, confidence: 'high' }],
  MONDAY,
  14,
);
eq('a one-off identical to a generated slot collapses', overlapping.length, 2);

const sameStartDifferentEnd = mergeAvailability(
  [window(2, '09:00', '11:30')],
  [{ date: '2026-09-08', startTime: '9:00 AM', endTime: '10:00 AM', timezone: NY, confidence: 'high' }],
  MONDAY,
  14,
);
eq('a one-off with the same start but a different end is kept', sameStartDifferentEnd.length, 3);

eq('merging nothing with nothing is empty', mergeAvailability([], [], MONDAY, 14).length, 0);
eq('weekly windows alone still merge',      mergeAvailability([window(2, '09:00', '10:00')], [], MONDAY, 14).length, 2);
eq('one-offs alone still merge',            mergeAvailability([], [slot('2026-09-20')], MONDAY, 14).length, 1);

// ─── CALENDLY_ENABLED ─────────────────────────────────────────────────────────
//
// Wave 5: Calendly is hidden, not deleted. The flag is a string comparison and
// nothing else — only the exact 'true' turns it on, so a deployment that typed
// '1' gets the safe answer rather than a calendar that silently offers nothing.

section('CALENDLY_ENABLED parsing');

check('unset is off',                calendlyEnabled({}) === false);
check('undefined is off',            calendlyEnabled({ CALENDLY_ENABLED: undefined }) === false);
check("'true' is on",                calendlyEnabled({ CALENDLY_ENABLED: 'true' }) === true);
check("'TRUE' is off — exact match", calendlyEnabled({ CALENDLY_ENABLED: 'TRUE' }) === false);
check("'True' is off",               calendlyEnabled({ CALENDLY_ENABLED: 'True' }) === false);
check("'1' is off",                  calendlyEnabled({ CALENDLY_ENABLED: '1' }) === false);
check("'yes' is off",                calendlyEnabled({ CALENDLY_ENABLED: 'yes' }) === false);
check("'false' is off",              calendlyEnabled({ CALENDLY_ENABLED: 'false' }) === false);
check("' true' is off — no trimming", calendlyEnabled({ CALENDLY_ENABLED: ' true' }) === false);
check("'' is off",                   calendlyEnabled({ CALENDLY_ENABLED: '' }) === false);

section('connectionIsUsable respects the flag');

const ON  = { CALENDLY_ENABLED: 'true' };
const OFF = {};

function row(over: Partial<UserCalendarConnectionRow>): UserCalendarConnectionRow {
  return {
    profile_id:     '00000000-0000-0000-0000-000000000000',
    provider:       'manual',
    access_token:   null,
    refresh_token:  null,
    token_expiry:   null,
    calendar_email: null,
    calendly_url:   null,
    manual_slots:   null,
    weekly_windows: null,
    timezone:       null,
    oauth_state:    null,
    created_at:     '2026-09-10T00:00:00.000Z',
    updated_at:     '2026-09-10T00:00:00.000Z',
    ...over,
  } as UserCalendarConnectionRow;
}

const calendlyRow = row({ provider: 'calendly', calendly_url: 'https://calendly.com/someone/30min' });

check('a Calendly link is usable with the flag on',   connectionIsUsable(calendlyRow, ON)  === true);
check('a Calendly link is NOT usable with it off',    connectionIsUsable(calendlyRow, OFF) === false);
check('a Calendly row with no link is never usable',
  connectionIsUsable(row({ provider: 'calendly' }), ON) === false);

// The flag must not touch the providers that work.
const googleRow = row({ provider: 'google', refresh_token: 'ciphertext' });
check('Google is usable with the flag off', connectionIsUsable(googleRow, OFF) === true);
check('Google is usable with the flag on',  connectionIsUsable(googleRow, ON)  === true);

const manualRow = row({
  provider:     'manual',
  manual_slots: [{ startTime: '9:00 AM', endTime: '10:00 AM', timezone: NY, date: '2026-09-20' }],
});
check('manual slots are usable with the flag off', connectionIsUsable(manualRow, OFF) === true);
check('manual slots are usable with the flag on',  connectionIsUsable(manualRow, ON)  === true);

const weeklyRow = row({
  provider:       'manual',
  weekly_windows: [{ dayOfWeek: 2, from: '09:00', to: '11:30', timezone: NY }],
});
check('weekly windows alone are usable with the flag off', connectionIsUsable(weeklyRow, OFF) === true);

check('a null row is never usable with either flag',
  connectionIsUsable(null, ON) === false && connectionIsUsable(null, OFF) === false);

// ─── Result ───────────────────────────────────────────────────────────────────

summary();

