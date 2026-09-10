// scripts/test-scheduling.ts — unit tests for Matchy's scheduling core.
//
//   npx tsx scripts/test-scheduling.ts
//
// Pure: no network, no database, no model call, no API key. Every function
// under test either takes its clock as an argument or is deterministic, which
// is why `now` is fixed below rather than read from the wall.
//
// What it proves:
//
//   pickProposals            business hours, weekdays only, 24h lead time, the
//                            half-hour grid, the day spread, the exclusion list
//   parsePreferences         halves of the day, weekday names, "not Monday",
//                            "after 2", "before noon" — and that those actually
//                            constrain what pickProposals returns
//   matchProposalByRegex     "option 2", "the first one", "Tuesday at 2 works",
//                            and that a rejection is never read as a pick
//   parseSchedulingCompletion  strict shape: no partial credit
//   the templates            at most two sentences before the slot list, no
//                            money, no em dash, no client identity
//   generateIcs              SEQUENCE moves on a reschedule, UID does not
//   redactExpertForViewer    the picker token hash never reaches a client, and
//                            stripping it does not mutate the stored record
//
// The brevity helper (lib/matchyBrevity.ts, Builder C) is loaded at RUNTIME so
// this script runs whether or not that file exists yet. The fallback lives here
// and nowhere else: no library code ever fakes a brevity pass.

import {
  pickProposals,
  parsePreferences,
  matchProposalByRegex,
  parseSchedulingCompletion,
  localPartsOf,
  mergeRanges,
  intersectRanges,
  emptySchedulingState,
  type UtcRange,
} from '../lib/matchyScheduling';
import { localToUtc } from '../lib/computeOverlap';
import {
  proposeTimesEmail,
  linkOnlyEmail,
  confirmedEmail,
  clientConfirmedEmail,
  rescheduleAskEmail,
  movedEmail,
  noTimesLeftEmail,
  threadSubject,
  formatSlotLine,
  type MatchyEmail,
} from '../lib/schedulingTemplates';
import { generateIcs } from '../lib/generateIcs';
import { redactExpertForViewer } from '../lib/redactExpert';
import type { Expert, ProjectExpert, ProposedSlot, SchedulingState } from '../types';
import { check, eq as equal, summary } from './testHarness';

// The CAN-SPAM footer signs a per-recipient opt-out token with this secret.
// A throwaway value keeps the templates exercisable with no configured env.
process.env.AVAILABILITY_TOKEN_SECRET ||= 'test-only-secret-for-scheduling-assertions';

// ─── Harness ──────────────────────────────────────────────────────────────────

function section(title: string): void {
  console.log(`\n${title}`);
}

// ─── The brevity helper, if Builder C has landed it ───────────────────────────

type BrevityResult = { ok: true; text: string } | { ok: false; reason: string };
type BrevityFn = (text: string, opts?: { maxSentences?: number; maxChars?: number }) => BrevityResult;

/** ONLY the test may fake this. lib/ never does. */
const fallbackBrevity: BrevityFn = text => ({ ok: true, text });

async function loadBrevity(): Promise<{ enforce: BrevityFn; real: boolean }> {
  // A variable specifier, so a missing module is a runtime miss rather than a
  // resolution failure at load time.
  const specifier = '../lib/matchyBrevity';
  try {
    const mod = await import(specifier) as { enforceBrevity?: BrevityFn };
    if (typeof mod.enforceBrevity === 'function') return { enforce: mod.enforceBrevity, real: true };
  } catch {
    // Builder C has not landed it yet.
  }
  return { enforce: fallbackBrevity, real: false };
}

// ─── Clock and calendar fixtures ──────────────────────────────────────────────

const ZONE = 'America/New_York';

/** A fixed Monday, 12:00 local, so every assertion below is reproducible. */
const NOW = localToUtc(2026, 9, 7, 12, 0, ZONE).getTime();

/** 09:00 to 17:00 local on the given date, as a UTC range. */
function businessDay(year: number, month: number, day: number): UtcRange {
  return {
    startMs: localToUtc(year, month, day, 9,  0, ZONE).getTime(),
    endMs:   localToUtc(year, month, day, 17, 0, ZONE).getTime(),
  };
}

/** Fourteen consecutive business-hour windows, weekends included on purpose. */
function twoWeeksOfWindows(): UtcRange[] {
  const out: UtcRange[] = [];
  for (let i = 0; i < 14; i++) {
    const date = new Date(Date.UTC(2026, 8, 7 + i));  // month is 0-based here
    out.push(businessDay(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()));
  }
  return out;
}

const WINDOWS = twoWeeksOfWindows();

// ─── pickProposals ────────────────────────────────────────────────────────────

section('pickProposals');

const proposals = pickProposals(WINDOWS, { timezone: ZONE, now: NOW });

equal('returns three proposals', proposals.length, 3);

check('every proposal is 60 minutes',
  proposals.every(p => p.durationMin === 60
    && Date.parse(p.endUtc) - Date.parse(p.startUtc) === 60 * 60_000));

check('every proposal is a weekday',
  proposals.every(p => {
    const wd = localPartsOf(Date.parse(p.startUtc), ZONE).weekday;
    return wd >= 1 && wd <= 5;
  }),
  proposals.map(p => localPartsOf(Date.parse(p.startUtc), ZONE).weekday).join(','));

check('every proposal starts at or after 09:00 local',
  proposals.every(p => {
    const local = localPartsOf(Date.parse(p.startUtc), ZONE);
    return local.hour * 60 + local.minute >= 9 * 60;
  }));

check('every proposal ends by 17:00 local',
  proposals.every(p => {
    const local = localPartsOf(Date.parse(p.startUtc), ZONE);
    return local.hour * 60 + local.minute + 60 <= 17 * 60;
  }));

check('every proposal sits on the hour or the half hour',
  proposals.every(p => localPartsOf(Date.parse(p.startUtc), ZONE).minute % 30 === 0));

check('nothing inside the 24 hour lead time',
  proposals.every(p => Date.parse(p.startUtc) >= NOW + 24 * 3_600_000),
  proposals.map(p => p.startUtc).join(' '));

check('nothing beyond the 14 day horizon',
  proposals.every(p => Date.parse(p.startUtc) <= NOW + 14 * 86_400_000));

check('spread across at least two different days',
  new Set(proposals.map(p => localPartsOf(Date.parse(p.startUtc), ZONE).dayKey)).size >= 2,
  proposals.map(p => p.startUtc).join(' '));

check('returned in chronological order',
  proposals.every((p, i) => i === 0 || Date.parse(p.startUtc) > Date.parse(proposals[i - 1].startUtc)));

// Weekends only → nothing at all.
const weekendOnly = WINDOWS.filter(w => {
  const wd = localPartsOf(w.startMs, ZONE).weekday;
  return wd === 0 || wd === 6;
});
equal('weekend-only availability yields no proposals',
  pickProposals(weekendOnly, { timezone: ZONE, now: NOW }).length, 0);

// Everything inside the lead time → nothing at all.
equal('availability inside the lead time yields no proposals',
  pickProposals([{ startMs: NOW + 3_600_000, endMs: NOW + 6 * 3_600_000 }],
    { timezone: ZONE, now: NOW }).length, 0);

// Exclusion: a second round never re-offers the first round's slots.
const roundTwo = pickProposals(WINDOWS, {
  timezone: ZONE, now: NOW, exclude: proposals.map(p => p.startUtc),
});
check('a second round offers nothing from the first',
  roundTwo.every(p => !proposals.some(first => first.startUtc === p.startUtc)),
  roundTwo.map(p => p.startUtc).join(' '));
check('a second round still finds times', roundTwo.length === 3);

// An empty calendar is not an error.
equal('no free windows yields no proposals', pickProposals([], { timezone: ZONE, now: NOW }).length, 0);

// ─── Ranges ───────────────────────────────────────────────────────────────────

section('range algebra');

equal('mergeRanges collapses touching windows',
  mergeRanges([{ startMs: 0, endMs: 100 }, { startMs: 100, endMs: 200 }]).length, 1);
equal('mergeRanges drops an empty window',
  mergeRanges([{ startMs: 50, endMs: 50 }]).length, 0);
equal('intersectRanges finds the shared middle',
  JSON.stringify(intersectRanges([{ startMs: 0, endMs: 100 }], [{ startMs: 40, endMs: 300 }])),
  JSON.stringify([{ startMs: 40, endMs: 100 }]));
equal('intersectRanges of disjoint windows is empty',
  intersectRanges([{ startMs: 0, endMs: 10 }], [{ startMs: 20, endMs: 30 }]).length, 0);

// ─── parsePreferences ─────────────────────────────────────────────────────────

section('parsePreferences');

const mornings = parsePreferences('mornings please');
equal('"mornings" caps the end hour at noon', mornings.maxHour, 12);
equal('"mornings" sets no floor', mornings.minHour, null);

const afternoons = parsePreferences('Tuesday or Thursday afternoons');
equal('"afternoons" sets a noon floor', afternoons.minHour, 12);
equal('weekday names are collected', JSON.stringify(afternoons.includeDays), JSON.stringify([2, 4]));

const notMonday = parsePreferences('any day but not Mondays');
equal('"not Mondays" is an exclusion', JSON.stringify(notMonday.excludeDays), JSON.stringify([1]));
equal('"not Mondays" does not also include Monday', notMonday.includeDays, null);

equal('"after 2" reads as 2pm', parsePreferences('after 2').minHour, 14);
equal('"after 10am" reads as 10am', parsePreferences('after 10am').minHour, 10);
equal('"before noon" caps at 12', parsePreferences('before noon').maxHour, 12);
equal('"before 3" caps at 3pm', parsePreferences('before 3').maxHour, 15);
equal('an unparseable preference constrains nothing',
  JSON.stringify(parsePreferences('whenever suits, really')),
  JSON.stringify({ includeDays: null, excludeDays: [], minHour: null, maxHour: null }));
equal('an empty preference constrains nothing', parsePreferences('').minHour, null);

// The constraints actually reach the picker.
const morningsOnly = pickProposals(WINDOWS, { timezone: ZONE, now: NOW, preferences: 'mornings only' });
check('"mornings" keeps every proposal before noon',
  morningsOnly.length > 0 && morningsOnly.every(p => {
    const local = localPartsOf(Date.parse(p.startUtc), ZONE);
    return local.hour * 60 + local.minute + 60 <= 12 * 60;
  }),
  morningsOnly.map(p => p.startUtc).join(' '));

const noMondays = pickProposals(WINDOWS, { timezone: ZONE, now: NOW, preferences: 'not Mondays' });
check('"not Mondays" keeps Monday out',
  noMondays.length > 0 && noMondays.every(p => localPartsOf(Date.parse(p.startUtc), ZONE).weekday !== 1));

const tuesOnly = pickProposals(WINDOWS, { timezone: ZONE, now: NOW, preferences: 'Tuesdays work best' });
check('a named weekday narrows to that day',
  tuesOnly.length > 0 && tuesOnly.every(p => localPartsOf(Date.parse(p.startUtc), ZONE).weekday === 2));

// ─── matchProposalByRegex ─────────────────────────────────────────────────────

section('matchProposalByRegex');

const OFFERED: ProposedSlot[] = proposals;

equal('"option 2"',            matchProposalByRegex('option 2 please', OFFERED, ZONE), OFFERED[1].startUtc);
equal('"#3"',                  matchProposalByRegex('#3 works for me', OFFERED, ZONE), OFFERED[2].startUtc);
equal('"the first one"',       matchProposalByRegex('the first one is fine', OFFERED, ZONE), OFFERED[0].startUtc);
equal('"second option"',       matchProposalByRegex('second option, thanks', OFFERED, ZONE), OFFERED[1].startUtc);
equal('"let us do 1"',         matchProposalByRegex("let's do 1", OFFERED, ZONE), OFFERED[0].startUtc);
equal('an option out of range is not a pick',
  matchProposalByRegex('option 9 please', OFFERED, ZONE), null);
equal('a rejection is never read as a pick',
  matchProposalByRegex('none of these work, sorry', OFFERED, ZONE), null);
equal('"do not work" is never read as a pick',
  matchProposalByRegex('those times do not work for me', OFFERED, ZONE), null);
equal('no offered slots means no regex pick',
  matchProposalByRegex('option 1', [], ZONE), null);

// Weekday plus a clock time, built from a real proposal so it must match.
const first      = OFFERED[0];
const firstLocal = localPartsOf(Date.parse(first.startUtc), ZONE);
const DAY_NAMES  = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const hour12     = firstLocal.hour > 12 ? firstLocal.hour - 12 : firstLocal.hour;
const meridiem   = firstLocal.hour >= 12 ? 'pm' : 'am';

equal('a weekday plus a matching time picks that slot',
  matchProposalByRegex(
    `${DAY_NAMES[firstLocal.weekday]} at ${hour12}${meridiem} works`, OFFERED, ZONE),
  first.startUtc);

equal('a weekday with no time is not enough',
  matchProposalByRegex(`${DAY_NAMES[firstLocal.weekday]} works for me`, OFFERED, ZONE), null);

// ─── parseSchedulingCompletion ────────────────────────────────────────────────

section('parseSchedulingCompletion');

equal('a chosen index resolves to the slot',
  parseSchedulingCompletion('{"kind":"chosen","optionIndex":2}', OFFERED)?.kind === 'chosen'
    ? (parseSchedulingCompletion('{"kind":"chosen","optionIndex":2}', OFFERED) as { startUtc: string }).startUtc
    : null,
  OFFERED[1].startUtc);

equal('a chosen index outside the list is discarded whole',
  parseSchedulingCompletion('{"kind":"chosen","optionIndex":7}', OFFERED), null);
equal('a chosen with no index is discarded whole',
  parseSchedulingCompletion('{"kind":"chosen"}', OFFERED), null);
equal('an unknown kind is discarded whole',
  parseSchedulingCompletion('{"kind":"maybe"}', OFFERED), null);
equal('unparseable JSON is discarded whole',
  parseSchedulingCompletion('sure, Tuesday works!', OFFERED), null);
equal('an empty answer is discarded whole', parseSchedulingCompletion('', OFFERED), null);

const fenced = parseSchedulingCompletion(
  '```json\n{"kind":"unavailable","windows":[],"note":"travelling"}\n```', OFFERED);
equal('a fenced answer is still read', fenced?.kind, 'unavailable');

const withWindows = parseSchedulingCompletion(
  '{"kind":"unavailable","windows":[{"startTime":"9:00 AM","endTime":"11:00 AM","timezone":"PT","dayOfWeek":"Tuesday"},{"startTime":"bad"}],"note":null}',
  OFFERED,
);
equal('a malformed window is dropped, not coerced',
  withWindows?.kind === 'unavailable' ? withWindows.windows.length : -1, 1);

equal('reschedule survives', parseSchedulingCompletion('{"kind":"reschedule","note":null}', OFFERED)?.kind, 'reschedule');
equal('declined survives',   parseSchedulingCompletion('{"kind":"declined"}', OFFERED)?.kind, 'declined');

// ─── Templates ────────────────────────────────────────────────────────────────

section('templates');

const CLIENT_NAME = 'Dana Whitfield';
const CLIENT_FIRM = 'Cedarline Partners';
const PROJECT_NAME = 'Veterinary rollup diligence';
const PICK_URL = 'https://expertmatch.fit/schedule/abc.def';
const RECIPIENT = 'expert@example.com';
const SUBJECT = threadSubject('Paid expert call — specialty pharma margins');

/**
 * Sentences, counted the way the founder's rule means them: prose terminated by
 * a full stop, question mark or exclamation. A trailing fragment is allowed
 * ONLY when it ends in a colon, because that is the lead-in to the link or the
 * slot list on the next line. Anything else dangling is a bug.
 */
function sentenceCount(text: string): number {
  return (text.match(/[.!?](\s|$)/g) ?? []).length;
}

function trailingFragmentOk(text: string): boolean {
  const after = text.split(/[.!?](?=\s|$)/).pop()?.trim() ?? '';
  return after === '' || after.endsWith(':');
}

/** The prose block: everything between the greeting and the slots or the link. */
function proseOf(email: MatchyEmail): string {
  return email.text.split(/\n{2,}/)[1] ?? '';
}

const SLOTS: ProposedSlot[] = OFFERED;

const expertFacing: Array<[string, MatchyEmail]> = [
  ['proposeTimes round 1', proposeTimesEmail({
    expertFirstName: 'Casey Testperson', slots: SLOTS, pickUrl: PICK_URL,
    round: 1, zone: ZONE, recipientEmail: RECIPIENT, subject: SUBJECT,
  })],
  ['proposeTimes round 2', proposeTimesEmail({
    expertFirstName: 'Casey Testperson', slots: SLOTS, pickUrl: PICK_URL,
    round: 2, zone: ZONE, recipientEmail: RECIPIENT, subject: SUBJECT,
  })],
  ['linkOnly', linkOnlyEmail({
    expertFirstName: 'Casey Testperson', pickUrl: PICK_URL,
    recipientEmail: RECIPIENT, subject: SUBJECT,
  })],
  ['confirmed', confirmedEmail({
    expertFirstName: 'Casey Testperson', whenLabel: 'Tue Sep 15, 2:00 PM ET',
    recipientEmail: RECIPIENT, subject: SUBJECT,
  })],
  ['rescheduleAsk', rescheduleAskEmail({
    expertFirstName: 'Casey Testperson', slots: SLOTS, pickUrl: PICK_URL,
    whenLabel: 'Tue Sep 15, 2:00 PM ET', zone: ZONE,
    recipientEmail: RECIPIENT, subject: SUBJECT,
  })],
  ['moved', movedEmail({
    firstName: 'Casey Testperson', whenLabel: 'Thu Sep 17, 10:00 AM ET',
    recipientEmail: RECIPIENT, subject: SUBJECT,
  })],
  ['noTimesLeft', noTimesLeftEmail({
    expertFirstName: 'Casey Testperson', pickUrl: PICK_URL,
    recipientEmail: RECIPIENT, subject: SUBJECT,
  })],
];

for (const [name, email] of expertFacing) {
  const prose = proseOf(email);

  check(`${name}: at most two sentences`, sentenceCount(prose) <= 2,
    `${sentenceCount(prose)} in ${JSON.stringify(prose)}`);
  check(`${name}: nothing dangles unterminated`, trailingFragmentOk(prose),
    JSON.stringify(prose));
  check(`${name}: greets by first name`, email.text.startsWith('Hi Casey,'),
    email.text.slice(0, 24));
  check(`${name}: no currency symbol`, !email.text.includes('$'));
  check(`${name}: no money word`, !/\b(dollars?|usd|rate|per hour|hourly)\b/i.test(prose));
  check(`${name}: no em dash`, !email.text.includes('—') && !email.html.includes('—'));
  check(`${name}: never names the client`, !email.text.includes(CLIENT_NAME));
  check(`${name}: never names the firm`, !email.text.includes(CLIENT_FIRM));
  check(`${name}: never names the project`, !email.text.includes(PROJECT_NAME));
  check(`${name}: html carries the same prose`, email.html.includes('Hi Casey,'));
}

// The two that carry a link put it on its own line, unbroken.
for (const name of ['proposeTimes round 1', 'proposeTimes round 2', 'linkOnly', 'rescheduleAsk', 'noTimesLeft']) {
  const email = expertFacing.find(([n]) => n === name)?.[1];
  check(`${name}: the picker link is on its own line`,
    !!email && email.text.split('\n').some(line => line.trim() === PICK_URL));
}

// The proposal emails list one line per slot, in the reader's zone.
const round1 = expertFacing[0][1];
for (const slot of SLOTS) {
  check('proposeTimes lists every slot', round1.text.includes(formatSlotLine(slot.startUtc, ZONE)),
    formatSlotLine(slot.startUtc, ZONE));
}
check('a slot line names its zone', /\b(EDT|EST|GMT|UTC|[A-Z]{2,4})\b/.test(formatSlotLine(SLOTS[0].startUtc, ZONE)));

// The client's copy is the ONE that may name the expert: the booking is the
// reveal boundary (lib/redactExpert.ts).
const clientCopy = clientConfirmedEmail({
  clientFirstName: CLIENT_NAME, whenLabel: 'Tue Sep 15, 2:00 PM ET',
  expertName: 'Casey Testperson', recipientEmail: 'owner@firm.example', subject: 'Call booked',
});
check('client copy names the expert', clientCopy.text.includes('Casey Testperson'));
check('client copy is at most two sentences', sentenceCount(proseOf(clientCopy)) <= 2);
check('client copy has no opt-out footer', !/unsubscribe|opt out|opt-out/i.test(clientCopy.text));
check('client copy has no em dash', !clientCopy.text.includes('—'));

// Expert-facing bodies DO carry the CAN-SPAM footer, except the two the sender
// footers itself (the booking pair).
check('a thread email carries the opt-out footer',
  /unsubscribe|opt out|opt-out/i.test(expertFacing[0][1].text),
  expertFacing[0][1].text.slice(-160));
check('a booking email leaves the footer to the sender',
  !/unsubscribe|opt out|opt-out/i.test(expertFacing[3][1].text));

// Subjects stay on the thread.
equal('threadSubject prefixes once', threadSubject('Paid expert call'), 'Re: Paid expert call');
equal('threadSubject does not double-prefix', threadSubject('Re: Paid expert call'), 'Re: Paid expert call');
equal('threadSubject has a default', threadSubject(undefined), 'Re: Paid expert call');

// ─── Brevity (Builder C's helper, when present) ───────────────────────────────

async function runBrevityChecks(): Promise<void> {
  section('brevity');
  const { enforce, real } = await loadBrevity();
  console.log(real ? '  using lib/matchyBrevity.ts' : '  lib/matchyBrevity.ts not present yet — skipped');
  if (!real) return;

  for (const [name, email] of expertFacing) {
    const result = enforce(proseOf(email), { maxSentences: 2, maxChars: 200 });
    check(`${name}: passes enforceBrevity`, result.ok,
      result.ok ? '' : result.reason);
  }
}

// ─── ICS ──────────────────────────────────────────────────────────────────────

section('generateIcs');

const ICS_BASE = {
  title:       'Expert call',
  startUtc:    '2026-09-15T18:00:00Z',
  endUtc:      '2026-09-15T19:00:00Z',
  description: 'Expert call with Casey Testperson.',
  location:    'https://zoom.us/j/123',
  organizer:   'team@expertmatch.fit',
  attendees:   ['owner@firm.example'],
  uid:         'deadbeefdeadbeefdeadbeefdeadbeef',
};

const icsFirst = generateIcs(ICS_BASE);
check('a first invite is SEQUENCE 0', icsFirst.includes('\r\nSEQUENCE:0\r\n'));
check('a first invite is a REQUEST',  icsFirst.includes('\r\nMETHOD:REQUEST\r\n'));
check('the UID is namespaced',        icsFirst.includes(`UID:${ICS_BASE.uid}@expertmatch.fit`));
check('the invite is CONFIRMED',      icsFirst.includes('\r\nSTATUS:CONFIRMED\r\n'));

const icsMoved = generateIcs({
  ...ICS_BASE,
  startUtc: '2026-09-17T14:00:00Z',
  endUtc:   '2026-09-17T15:00:00Z',
  sequence: 1,
});
check('a reschedule bumps SEQUENCE', icsMoved.includes('\r\nSEQUENCE:1\r\n'));
check('a reschedule keeps the same UID',
  icsMoved.includes(`UID:${ICS_BASE.uid}@expertmatch.fit`));
check('a reschedule carries the new start', icsMoved.includes('DTSTART:20260917T140000Z'));

const icsCancel = generateIcs({ ...ICS_BASE, sequence: 2, method: 'CANCEL' });
check('a cancellation is METHOD CANCEL', icsCancel.includes('\r\nMETHOD:CANCEL\r\n'));
check('a cancellation is STATUS CANCELLED', icsCancel.includes('\r\nSTATUS:CANCELLED\r\n'));

// ─── Redaction ────────────────────────────────────────────────────────────────

section('redaction');

const SAMPLE_EXPERT: Expert = {
  id: 'exp-1', name: 'Casey Testperson', title: 'Chief Operating Officer',
  company: 'Example Coatings Inc', location: 'Ohio, US', category: 'Operator',
  justification: 'Ran operations at a coatings manufacturer.',
  relevance_score: 88, source_url: 'https://example.com', source_label: 'example',
  source_links: [], seniorityTier: 'executive',
};

const SCHEDULING: SchedulingState = {
  ...emptySchedulingState(),
  round:           2,
  proposed:        SLOTS,
  proposedAt:      NOW,
  expertTimezone:  'America/Chicago',
  preferences:     'afternoons',
  outcome:         'times_proposed',
  pickTokenHash:   'a'.repeat(64),
  pickTokenExpiry: NOW + 7 * 86_400_000,
};

function peWithScheduling(): ProjectExpert {
  return {
    expert:   SAMPLE_EXPERT,
    status:   'scheduling_sent',
    scheduling: { ...SCHEDULING, proposed: SLOTS.map(s => ({ ...s })) },
    booking:  null,
    addedAt:  1,
    updatedAt: 2,
  };
}

const source   = peWithScheduling();
const asClient = redactExpertForViewer(source, { role: 'user' });

equal('client never receives the picker token hash', asClient.scheduling?.pickTokenHash, null);
equal('client never receives the token expiry',      asClient.scheduling?.pickTokenExpiry, null);
equal('client still sees the round',                 asClient.scheduling?.round, 2);
equal('client still sees the outcome',               asClient.scheduling?.outcome, 'times_proposed');
equal('client still sees the expert zone',           asClient.scheduling?.expertTimezone, 'America/Chicago');
equal('client still sees the preference',            asClient.scheduling?.preferences, 'afternoons');
equal('client still sees the proposed times',        asClient.scheduling?.proposed.length, 3);

check('stripping did not mutate the stored record',
  source.scheduling?.pickTokenHash === 'a'.repeat(64)
  && source.scheduling?.pickTokenExpiry !== null,
  JSON.stringify(source.scheduling?.pickTokenHash)?.slice(0, 12));

check('the proposed array was deep copied',
  asClient.scheduling?.proposed[0] !== source.scheduling?.proposed[0]);

const asAdmin = redactExpertForViewer(source, { role: 'admin' });
check('admin gets the object untouched', asAdmin === source);
equal('admin keeps the token hash', asAdmin.scheduling?.pickTokenHash, 'a'.repeat(64));

const noScheduling = redactExpertForViewer(
  { expert: SAMPLE_EXPERT, status: 'contacted', addedAt: 1, updatedAt: 2 },
  { role: 'user' },
);
check('an expert with no scheduling state gains no key',
  !('scheduling' in noScheduling), JSON.stringify(Object.keys(noScheduling)));

// ─── Result ───────────────────────────────────────────────────────────────────

void runBrevityChecks().then(() => {
  summary('scheduling assertions');
});
