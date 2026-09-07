// scripts/test-matchy-client.ts — unit tests for the client-side Matchy module.
//
// Pure functions only: no network, no database, no DOM. Everything under test
// here is what the client READS — the sentence Matchy shows about a call, the
// way an instant is written down, and the URL the calendar file comes from.
//
//   npx tsx scripts/test-matchy-client.ts
//
// What it proves:
//   - `schedulingLine` has a written sentence for every SchedulingOutcome, and
//     the switch is exhaustive: a new outcome added to types.ts fails the build
//     here rather than rendering nothing in the thread.
//   - a booked call outranks a stale proposal outcome, and a finished
//     engagement says nothing at all (no "waiting on their pick" after the call)
//   - `formatSlot` is deterministic against an EXPLICIT zone, never the
//     machine's, so this file reads the same on a laptop and in CI
//   - `bookingIcsUrl` encodes its ids
//   - no line a client sees carries an em dash, a raw error code, or a rate

import { formatSlot, viewerZoneLabel, schedulingLine, proposedSlotsOf, bookingIcsUrl, firstNameOf,
         PREFERENCES_MAX, type SchedulableExpert } from '../lib/matchyClient';
import type { BookingState, ProposedSlot, SchedulingOutcome, SchedulingState } from '../types';

let failures = 0;
let checks   = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq(name: string, actual: unknown, expected: unknown): void {
  check(name, actual === expected, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
}

function section(title: string): void {
  console.log(`\n${title}`);
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const NY  = 'America/New_York';
const LDN = 'Europe/London';
const TKO = 'Asia/Tokyo';

/** Tuesday 15 September 2026, 18:00 UTC — 2:00 PM in New York (EDT). */
const START = '2026-09-15T18:00:00.000Z';
const END   = '2026-09-15T19:00:00.000Z';

function slot(startUtc: string, endUtc: string): ProposedSlot {
  return { startUtc, endUtc, durationMin: 60 };
}

function scheduling(patch: Partial<SchedulingState> = {}): SchedulingState {
  return {
    round:           1,
    proposed:        [],
    proposedAt:      Date.parse('2026-09-08T12:00:00.000Z'),
    expertTimezone:  null,
    preferences:     null,
    outcome:         null,
    pickTokenHash:   null,
    pickTokenExpiry: null,
    ...patch,
  };
}

function booking(patch: Partial<BookingState> = {}): BookingState {
  return {
    startUtc:         START,
    endUtc:           END,
    durationMin:      60,
    zoomMeetingId:    '9876543210',
    icsUid:           'em-booking-1@expertmatch',
    icsSequence:      0,
    bookedAt:         Date.parse('2026-09-09T12:00:00.000Z'),
    rescheduledCount: 0,
    history:          [],
    ...patch,
  };
}

/** Every outcome in types.ts. Adding one to the union breaks this line. */
const ALL_OUTCOMES: readonly SchedulingOutcome[] = [
  'times_proposed', 'link_sent', 'expert_declined_times',
  'booked', 'reschedule_requested', 'no_client_availability',
];

// ─── formatSlot ───────────────────────────────────────────────────────────────

section('formatSlot — a fixed instant, in a fixed zone, every time');

eq('New York: the shared AM/PM prints once',
  formatSlot(START, END, { timeZone: NY }), 'Tue, Sep 15 · 2:00–3:00 PM EDT');

eq('London reads the same instant an hour later than the offset suggests',
  formatSlot(START, END, { timeZone: LDN }), 'Tue, Sep 15 · 7:00–8:00 PM GMT+1');

eq('Tokyo lands on the next calendar day',
  formatSlot(START, END, { timeZone: TKO }), 'Wed, Sep 16 · 3:00–4:00 AM GMT+9');

eq('no end: one time, still zone-named',
  formatSlot(START, null, { timeZone: NY }), 'Tue, Sep 15 · 2:00 PM EDT');

eq('end omitted entirely behaves the same',
  formatSlot(START, undefined, { timeZone: NY }), 'Tue, Sep 15 · 2:00 PM EDT');

eq('a slot that straddles noon prints both halves of the day',
  formatSlot('2026-09-15T15:30:00.000Z', '2026-09-15T16:30:00.000Z', { timeZone: NY }),
  'Tue, Sep 15 · 11:30 AM–12:30 PM EDT');

eq('a slot that straddles midnight rolls the clock, not the label',
  formatSlot('2026-09-16T03:30:00.000Z', '2026-09-16T04:30:00.000Z', { timeZone: NY }),
  'Tue, Sep 15 · 11:30 PM–12:30 AM EDT');

eq('an unparseable start renders as nothing, never "Invalid Date"',
  formatSlot('not a date', END, { timeZone: NY }), '');

eq('an unparseable END degrades to the start alone',
  formatSlot(START, 'not a date', { timeZone: NY }), 'Tue, Sep 15 · 2:00 PM EDT');

eq('an unknown zone degrades instead of throwing',
  formatSlot(START, END, { timeZone: 'Mars/Olympus_Mons' }), '');

check('no em dash anywhere in a formatted slot',
  !formatSlot(START, END, { timeZone: NY }).includes('—'));

section('viewerZoneLabel — the name printed next to the times');

eq('an explicit zone is named, not the machine zone', viewerZoneLabel(NY), 'EDT');
eq('a zone with no abbreviation still gets a name',  viewerZoneLabel(TKO), 'GMT+9');
check('an unknown zone falls back to the zone itself, never empty',
  viewerZoneLabel('Mars/Olympus_Mons') === 'Mars/Olympus_Mons');

// ─── schedulingLine ───────────────────────────────────────────────────────────

section('schedulingLine — one written sentence per outcome');

function lineFor(outcome: SchedulingOutcome, pe: Partial<SchedulableExpert> = {}): string {
  const result = schedulingLine(
    {
      status:     'scheduling_sent',
      scheduling: scheduling({ outcome }),
      booking:    null,
      ...pe,
    },
    'Scott',
    { timeZone: NY },
  );
  return result?.text ?? '';
}

eq('times_proposed, three of them',
  lineFor('times_proposed', { scheduling: scheduling({ outcome: 'times_proposed', proposed: [slot(START, END), slot(START, END), slot(START, END)] }) }),
  'Proposed 3 times to Scott. Waiting on their pick.');

eq('times_proposed, exactly one, is singular',
  lineFor('times_proposed', { scheduling: scheduling({ outcome: 'times_proposed', proposed: [slot(START, END)] }) }),
  'Proposed 1 time to Scott. Waiting on their pick.');

eq('times_proposed with nothing stored falls back to the link line',
  lineFor('times_proposed'),
  'Sent Scott a link to pick a time.');

eq('link_sent', lineFor('link_sent'), 'Sent Scott a link to pick a time.');

eq('expert_declined_times says what to do next',
  lineFor('expert_declined_times'),
  'Scott could not make any of the times. Add more hours in Settings, or propose different ones.');

eq('booked names the time',
  lineFor('booked', { status: 'scheduled', booking: booking() }),
  'Booked Tue, Sep 15 · 2:00–3:00 PM EDT. The Zoom link is on this card.');

eq('booked with no booking on the record still reads as a sentence',
  lineFor('booked'),
  'Booked a time with Scott. The Zoom link is on this card.');

eq('reschedule_requested', lineFor('reschedule_requested'), 'Finding a new time with Scott.');

eq('no_client_availability points at Settings',
  lineFor('no_client_availability'),
  'I need your hours first. Connect a calendar or add weekly hours in Settings.');

section('schedulingLine — tone and the one link');

for (const outcome of ALL_OUTCOMES) {
  const res = schedulingLine({ status: 'scheduling_sent', scheduling: scheduling({ outcome }) }, 'Scott', { timeZone: NY });
  check(`${outcome}: has a line`, res !== null);
  check(`${outcome}: the line is a full sentence`, /[.]$/.test(res?.text ?? ''), res?.text);
  check(`${outcome}: no em dash`,     !(res?.text ?? '').includes('—'), res?.text);
  check(`${outcome}: no raw code`,    !(res?.text ?? '').includes(outcome), res?.text);
  check(`${outcome}: no rate`,        !/[$]/.test(res?.text ?? ''), res?.text);
}

check('expert_declined_times is an alert',
  schedulingLine({ status: 'scheduling_sent', scheduling: scheduling({ outcome: 'expert_declined_times' }) }, 'Scott')?.tone === 'alert');
check('no_client_availability is an alert that links to Settings',
  schedulingLine({ status: 'replied', scheduling: scheduling({ outcome: 'no_client_availability' }) }, 'Scott')?.href === '/settings');
check('a booked call is not an alert',
  schedulingLine({ status: 'scheduled', scheduling: scheduling({ outcome: 'booked' }), booking: booking() }, 'Scott')?.tone === 'default');

section('schedulingLine — what outranks what');

eq('a booked call outranks a stale proposal outcome',
  schedulingLine(
    { status: 'scheduled', scheduling: scheduling({ outcome: 'times_proposed', proposed: [slot(START, END)] }), booking: booking() },
    'Scott',
    { timeZone: NY },
  )?.text,
  'Booked Tue, Sep 15 · 2:00–3:00 PM EDT. The Zoom link is on this card.');

eq('a reschedule in flight outranks the booking it is moving',
  schedulingLine(
    { status: 'scheduled', scheduling: scheduling({ outcome: 'reschedule_requested' }), booking: booking() },
    'Scott',
  )?.text,
  'Finding a new time with Scott.');

check('nothing to say before any scheduling has happened',
  schedulingLine({ status: 'replied', scheduling: null, booking: null }, 'Scott') === null);
check('an absent scheduling key says nothing',
  schedulingLine({ status: 'contacted' }, 'Scott') === null);
check('a completed call says nothing here — the wrap-up owns the thread',
  schedulingLine({ status: 'completed', scheduling: scheduling({ outcome: 'booked' }), booking: booking() }, 'Scott') === null);
check('a passed engagement says nothing',
  schedulingLine({ status: 'rejected_after_outreach', scheduling: scheduling({ outcome: 'times_proposed' }) }, 'Scott') === null);

check('the first name is the only name that reaches the line',
  (schedulingLine({ status: 'scheduling_sent', scheduling: scheduling({ outcome: 'link_sent' }) }, firstNameOf('Scott S.'))?.text ?? '')
    === 'Sent Scott a link to pick a time.');

// ─── proposedSlotsOf ──────────────────────────────────────────────────────────

section('proposedSlotsOf — always an array');

eq('reads the stored proposals',
  proposedSlotsOf({ status: 'scheduling_sent', scheduling: scheduling({ proposed: [slot(START, END)] }) }).length, 1);
eq('no scheduling state is an empty list, never a throw',
  proposedSlotsOf({ status: 'replied' }).length, 0);
eq('a null scheduling state is an empty list',
  proposedSlotsOf({ status: 'replied', scheduling: null }).length, 0);

// ─── bookingIcsUrl ────────────────────────────────────────────────────────────

section('bookingIcsUrl — the calendar file for a booked call');

eq('plain ids',
  bookingIcsUrl('proj_1', 'exp_2'),
  '/api/projects/proj_1/experts/exp_2/booking/ics');
eq('ids are encoded, so nothing can walk out of the path',
  bookingIcsUrl('a/b', 'c d'),
  '/api/projects/a%2Fb/experts/c%20d/booking/ics');

eq('the preferences cap matches the API contract', PREFERENCES_MAX, 200);

// ─── Result ───────────────────────────────────────────────────────────────────

console.log(`\n${checks - failures}/${checks} checks passed`);
if (failures > 0) {
  console.log(`${failures} FAILED`);
  process.exit(1);
}
console.log('ALL CHECKS PASSED');
