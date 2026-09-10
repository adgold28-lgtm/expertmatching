// scripts/test-nudges.ts — unit tests for lib/nudges.ts.
//
// Pure decision layer only: no database, no network, no email. The two routes
// (app/api/jobs/schedule-nudges, app/api/jobs/send-nudge) are the I/O; every
// rule they enforce is decided by a function tested here.
//
//   npx tsx scripts/test-nudges.ts
//
// Exits non-zero on any failing assertion, so it can gate a deploy.
//
// What it proves:
//   - every line in every pool is one or two sentences, inside the length
//     budget, unique within its stage, and free of money, links, em dashes,
//     markdown and follow-up clichés (the founder: "it can't be the same, but
//     it needs to be like one line")
//   - four consecutive picks never repeat a line
//   - the schedule lands on 08:00 local on the next BUSINESS day, counts today
//     when 08:00 has not happened yet, and does not drift across the US
//     fall-back weekend of 1 November 2026
//   - a reply ends the waiting stage, a held or unsent draft does not start one
//   - the cap is four per stage, and a new stage resets it
//   - LLM variation is off by default and falls back on anything it dislikes

import {
  MAX_NUDGES,
  MAX_NUDGE_LINE_CHARS,
  NUDGE_HOUR_LOCAL,
  NUDGE_JITTER_MAX_S,
  NUDGE_LINES,
  buildNudgeBody,
  nextNudgeInstant,
  nudgeStageFor,
  nudgeSubjectFor,
  nudgeSummary,
  pickNudgeLine,
  shouldSchedule,
  varyNudgeLine,
  waitingSinceFor,
  zonedTimeToUtc,
  type NudgeThreadMessage,
} from '../lib/nudges';
import { enforceBrevity } from '../lib/matchyBrevity';
import type { NudgeStage, NudgeState, ExpertStatus } from '../types';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

const NY  = 'America/New_York';
const ALL_STAGES: readonly NudgeStage[] = ['intro', 'terms', 'times'];

/** The wall-clock 'YYYY-MM-DD HH:MM' an instant reads as in a zone. */
function localReading(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(instant);
  const read = (type: string) => parts.find(p => p.type === type)?.value ?? '??';
  return `${read('year')}-${read('month')}-${read('day')} ${read('hour') === '24' ? '00' : read('hour')}:${read('minute')}`;
}

/** The local hour an instant falls on in a zone, as a number. */
function localHour(instant: Date, timeZone: string): number {
  return Number(localReading(instant, timeZone).slice(11, 13));
}

// ─── The lines ────────────────────────────────────────────────────────────────

section('the lines');

/** Filler that makes a follow-up unreadable. None of these may appear. */
const CLICHES = [
  'just checking in',
  'checking in',
  'circling back',
  'circle back',
  'bumping this',
  'bump this',
  'touch base',
  'touching base',
  'following up on my',
  'hope this finds you',
  'per my last email',
  'gentle reminder',
  'friendly reminder',
];

for (const stage of ALL_STAGES) {
  const pool = NUDGE_LINES[stage];

  check(`${stage}: at least 8 lines, so 4 sends never run out`,
    pool.length >= 8, `has ${pool.length}`);

  check(`${stage}: every line is unique`,
    new Set(pool).size === pool.length,
    `${pool.length - new Set(pool).size} duplicate(s)`);

  for (const line of pool) {
    const result = enforceBrevity(line);
    check(`${stage}: passes brevity — "${line.slice(0, 40)}..."`,
      result.ok, result.ok ? '' : result.reason);

    // Brevity TRIMS to two sentences; a pool line must already be within it,
    // or a sentence would be silently dropped before sending.
    check(`${stage}: is not trimmed by brevity — "${line.slice(0, 40)}..."`,
      result.ok && result.text === line);

    check(`${stage}: within ${MAX_NUDGE_LINE_CHARS} chars — "${line.slice(0, 40)}..."`,
      line.length <= MAX_NUDGE_LINE_CHARS, `${line.length} chars`);

    const lower = line.toLowerCase();
    const found = CLICHES.find(phrase => lower.includes(phrase));
    check(`${stage}: no filler — "${line.slice(0, 40)}..."`,
      found === undefined, found ? `contains "${found}"` : '');
  }
}

// No line appears in two stages: a nudge has to read as a follow-up to the
// specific thing we last said.
const everyLine = ALL_STAGES.flatMap(stage => [...NUDGE_LINES[stage]]);
eq('no line is shared between stages', new Set(everyLine).size, everyLine.length);

// ─── Stage mapping ────────────────────────────────────────────────────────────

section('stage mapping');

eq('contacted waits in intro',          nudgeStageFor('contacted'), 'intro');
eq('followup_sent waits in terms',      nudgeStageFor('followup_sent'), 'terms');
eq('rate_negotiation waits in terms',   nudgeStageFor('rate_negotiation'), 'terms');
eq('scheduling_sent waits in times',    nudgeStageFor('scheduling_sent'), 'times');

// Everything else is our turn, or finished. Never nudged.
for (const status of ['replied', 'scheduled', 'completed', 'rejected', 'bookmarked',
                      'discovered', 'conflict_flagged', 'rejected_after_outreach'] as ExpertStatus[]) {
  eq(`${status} is never nudged`, nudgeStageFor(status), null);
}
eq('an absent status is never nudged', nudgeStageFor(undefined), null);

// ─── Picking a line ───────────────────────────────────────────────────────────

section('picking a line');

for (const stage of ALL_STAGES) {
  // Four picks, each one told what the previous ones used. This is exactly the
  // sequence a real four-nudge stage produces.
  const used: string[] = [];
  for (let i = 0; i < MAX_NUDGES; i++) {
    used.push(pickNudgeLine(stage, used, () => 0.5));
  }
  eq(`${stage}: ${MAX_NUDGES} picks produce ${MAX_NUDGES} distinct lines`,
    new Set(used).size, MAX_NUDGES);
  check(`${stage}: every pick came from the pool`,
    used.every(line => NUDGE_LINES[stage].includes(line)));
}

// A deterministic rng at each end of the range still lands inside the pool.
check('rng 0 picks the first unused line',
  pickNudgeLine('intro', [], () => 0) === NUDGE_LINES.intro[0]);
check('rng just under 1 stays in range',
  NUDGE_LINES.intro.includes(pickNudgeLine('intro', [], () => 0.999999)));

// Exhaustion cannot happen with ten lines and a cap of four, but a corrupted
// linesUsed must still produce something — the least recent one.
const allUsed = [...NUDGE_LINES.terms];
eq('when every line is used, the oldest comes back',
  pickNudgeLine('terms', allUsed), allUsed[0]);

// ─── When the next one goes ───────────────────────────────────────────────────

section('scheduling the next nudge');

const noJitter = { rng: () => 0 };

// 2026-09-04 is a Friday. 09:00 New York (EDT, UTC-4) is 13:00 UTC, so today's
// 08:00 has passed and the weekend is skipped.
const fridayMorning = new Date('2026-09-04T13:00:00Z');
const fromFriday    = nextNudgeInstant(fridayMorning, NY, noJitter);
eq('Friday 09:00 lands on the following Monday', fromFriday.day, '2026-09-07');
eq('and at 08:00 local',        localReading(fromFriday.at, NY), '2026-09-07 08:00');

// 2026-09-07 is a Monday. 07:00 New York is before 08:00, so today counts.
const mondayEarly = new Date('2026-09-07T11:00:00Z');
const fromEarly   = nextNudgeInstant(mondayEarly, NY, noJitter);
eq('Monday 07:00 lands the same day', fromEarly.day, '2026-09-07');
eq('at 08:00 local',                  localReading(fromEarly.at, NY), '2026-09-07 08:00');

// 08:30 the same Monday is past the hour, so it rolls to Tuesday.
const mondayLate = new Date('2026-09-07T12:30:00Z');
const fromLate   = nextNudgeInstant(mondayLate, NY, noJitter);
eq('Monday 08:30 lands on Tuesday', fromLate.day, '2026-09-08');
eq('at 08:00 local',                localReading(fromLate.at, NY), '2026-09-08 08:00');

// Saturday is never a delivery day.
const saturday = new Date('2026-09-05T13:00:00Z');
eq('Saturday lands on Monday', nextNudgeInstant(saturday, NY, noJitter).day, '2026-09-07');
const sunday = new Date('2026-09-06T13:00:00Z');
eq('Sunday lands on Monday',   nextNudgeInstant(sunday, NY, noJitter).day, '2026-09-07');

// THE DST CASE. US clocks fall back on Sunday 1 November 2026, so Friday the
// 30th is EDT (UTC-4) and the following Monday is EST (UTC-5). 08:00 local must
// still be 08:00 local — a schedule built by adding 86 400 000 ms per day would
// land at 07:00 and drift further every week.
const dstFriday = new Date('2026-10-30T13:00:00Z');   // Friday 09:00 EDT
const acrossDst = nextNudgeInstant(dstFriday, NY, noJitter);
eq('across the fall-back weekend, the day is the Monday', acrossDst.day, '2026-11-02');
eq('and 08:00 local is still 08:00 local',
  localReading(acrossDst.at, NY), '2026-11-02 08:00');
eq('which is a different UTC instant than before the transition',
  acrossDst.at.toISOString(), '2026-11-02T13:00:00.000Z');
// Sanity: the Friday itself would have been 12:00 UTC, one hour earlier.
eq('the pre-transition 08:00 was one UTC hour earlier',
  zonedTimeToUtc({ year: 2026, month: 10, day: 30 }, NUDGE_HOUR_LOCAL, 0, NY).toISOString(),
  '2026-10-30T12:00:00.000Z');

// Jitter: the founder's "plus a random 0 through 60 minutes".
const maxJitter = nextNudgeInstant(mondayEarly, NY, { rng: () => 0.999999 });
eq('maximum jitter stays inside the 08:00 hour', localHour(maxJitter.at, NY), 8);
check('maximum jitter is under the ceiling',
  maxJitter.at.getTime() - new Date('2026-09-07T12:00:00Z').getTime() <= NUDGE_JITTER_MAX_S * 1000);
check('maximum jitter actually moved the instant',
  maxJitter.at.getTime() > new Date('2026-09-07T12:00:00Z').getTime());

// A different zone gets its own morning.
const london = nextNudgeInstant(new Date('2026-09-07T04:00:00Z'), 'Europe/London', noJitter);
eq('London gets 08:00 London', localReading(london.at, 'Europe/London'), '2026-09-07 08:00');

// An unusable zone must not throw; it falls back to UTC arithmetic.
const bogus = nextNudgeInstant(mondayEarly, 'Not/AZone', noJitter);
check('an unusable zone still returns a date', bogus.at instanceof Date && !Number.isNaN(bogus.at.getTime()));

// ─── Waiting ──────────────────────────────────────────────────────────────────

section('waiting');

function outbound(createdAt: string, extra: Partial<NudgeThreadMessage> = {}): NudgeThreadMessage {
  return { direction: 'outbound', author: 'matchy', created_at: createdAt, ...extra };
}
function inbound(createdAt: string): NudgeThreadMessage {
  return { direction: 'inbound', author: 'expert', created_at: createdAt };
}

const T1 = '2026-09-01T12:00:00.000Z';
const T2 = '2026-09-02T12:00:00.000Z';
const T3 = '2026-09-03T12:00:00.000Z';

eq('an empty thread is not waiting', waitingSinceFor([]), null);
eq('a last inbound message is not waiting', waitingSinceFor([outbound(T1), inbound(T2)]), null);
eq('a last outbound message is waiting since then',
  waitingSinceFor([inbound(T1), outbound(T2)]), Date.parse(T2));
eq('the LATEST outbound is the one we wait on',
  waitingSinceFor([outbound(T1), outbound(T2), outbound(T3)]), Date.parse(T3));
eq("the client's own outbound counts as ours",
  waitingSinceFor([{ direction: 'outbound', author: 'client', created_at: T2 }]), Date.parse(T2));

// A draft awaiting approval and a walkthrough-held message never went out, so
// neither starts a waiting stage nor hides the message underneath it.
eq('a pending draft is skipped',
  waitingSinceFor([outbound(T1), outbound(T2, { screen_result: { pending: true } })]),
  Date.parse(T1));
eq('a held message is skipped',
  waitingSinceFor([outbound(T1), outbound(T2, { screen_result: { held: 'walkthrough' } })]),
  Date.parse(T1));
eq('a thread of nothing but held messages is not waiting',
  waitingSinceFor([outbound(T1, { screen_result: { held: 'walkthrough' } })]), null);
eq('an unparseable timestamp is not waiting',
  waitingSinceFor([outbound('not a date')]), null);

// ─── The decision ─────────────────────────────────────────────────────────────

section('the decision');

const NOW = Date.parse(T3) + 3_600_000;

function state(patch: Partial<NudgeState> = {}): NudgeState {
  return {
    stage:        'intro',
    waitingSince: Date.parse(T2),
    count:        0,
    lastSentAt:   null,
    scheduledFor: null,
    scheduledDay: null,
    linesUsed:    [],
    ...patch,
  };
}

const waitingThread = [inbound(T1), outbound(T2)];

const first = shouldSchedule({ status: 'contacted' }, waitingThread, NOW);
check('a fresh waiting engagement schedules', first.schedule);
if (first.schedule) {
  eq('in the intro stage',   first.stage, 'intro');
  eq('with a count of zero', first.count, 0);
  eq('and no lines used',    first.linesUsed.length, 0);
  eq('waiting since the outbound', first.waitingSince, Date.parse(T2));
}

const replied = shouldSchedule({ status: 'contacted' }, [outbound(T1), inbound(T2)], NOW);
check('a replied thread does not schedule', !replied.schedule);
eq('because it is not waiting', replied.schedule ? '' : replied.reason, 'not_waiting');

const wrongStatus = shouldSchedule({ status: 'scheduled' }, waitingThread, NOW);
check('a booked engagement does not schedule', !wrongStatus.schedule);
eq('because the status has no stage', wrongStatus.schedule ? '' : wrongStatus.reason, 'no_stage');

const capped = shouldSchedule(
  { status: 'contacted', nudges: state({ count: MAX_NUDGES }) },
  waitingThread, NOW,
);
check('the cap stops it', !capped.schedule);
eq(`because ${MAX_NUDGES} have been sent`, capped.schedule ? '' : capped.reason, 'capped');

const underCap = shouldSchedule(
  { status: 'contacted', nudges: state({ count: MAX_NUDGES - 1, linesUsed: ['a', 'b', 'c'] }) },
  waitingThread, NOW,
);
check('one under the cap still schedules', underCap.schedule);
if (underCap.schedule) {
  eq('carrying the count forward',     underCap.count, MAX_NUDGES - 1);
  eq('and the lines already sent',     underCap.linesUsed.join(','), 'a,b,c');
}

const queued = shouldSchedule(
  { status: 'contacted', nudges: state({ scheduledFor: new Date(NOW + 3_600_000).toISOString() }) },
  waitingThread, NOW,
);
check('a job already in flight is not queued twice', !queued.schedule);
eq('because one is pending', queued.schedule ? '' : queued.reason, 'already_queued');

const stale = shouldSchedule(
  { status: 'contacted', nudges: state({ scheduledFor: new Date(NOW - 3_600_000).toISOString() }) },
  waitingThread, NOW,
);
check('a scheduledFor in the past does not block a new job', stale.schedule);

// THE RESET RULE. The status moved on, so the previous stage is over and the
// new one starts with a full budget — this is what "4 per waiting stage" means.
const newStage = shouldSchedule(
  { status: 'scheduling_sent', nudges: state({ stage: 'intro', count: MAX_NUDGES, linesUsed: ['a', 'b', 'c', 'd'] }) },
  waitingThread, NOW,
);
check('a new stage resets past the cap', newStage.schedule);
if (newStage.schedule) {
  eq('into the times stage', newStage.stage, 'times');
  eq('with a fresh count',   newStage.count, 0);
  eq('and no line history',  newStage.linesUsed.length, 0);
}

// Same stage, but we sent something newer: also a reset.
const newOutbound = shouldSchedule(
  { status: 'contacted', nudges: state({ count: MAX_NUDGES, waitingSince: Date.parse(T1) }) },
  waitingThread, NOW,
);
check('a newer outbound resets the stage', newOutbound.schedule);
if (newOutbound.schedule) {
  eq('to the new waiting instant', newOutbound.waitingSince, Date.parse(T2));
  eq('with a fresh count',         newOutbound.count, 0);
}

// ─── Composing ────────────────────────────────────────────────────────────────

section('composing');

eq('the subject replies into the original thread',
  nudgeSubjectFor({ outreachSubject: 'Quick question on pricing software' }),
  'Re: Quick question on pricing software');
eq('a subject that is already a reply is not prefixed twice',
  nudgeSubjectFor({ outreachSubject: 'Re: Quick question' }), 'Re: Quick question');
eq('a missing subject falls back',
  nudgeSubjectFor({}), 'Re: Paid expert call');

delete process.env.OUTREACH_SIGNATURE;
eq('with no signature configured, the body is the greeting and the line',
  buildNudgeBody('Dana Reed', 'Let me know either way.'),
  'Hi Dana,\n\nLet me know either way.');

process.env.OUTREACH_SIGNATURE = 'Asher';
eq('with a signature, it lands after the line',
  buildNudgeBody('Dana Reed', 'Let me know either way.'),
  'Hi Dana,\n\nLet me know either way.\n\nAsher');
delete process.env.OUTREACH_SIGNATURE;

eq('an unknown name still greets somebody',
  buildNudgeBody(null, 'Let me know.'), 'Hi there,\n\nLet me know.');

eq('the summary says which day of the sequence this was',
  nudgeSummary('Dana Reed', 2), `Nudged Dana. Day 2 of ${MAX_NUDGES}, no reply yet.`);
check('the summary carries no surname', !nudgeSummary('Dana Reed', 2).includes('Reed'));

// ─── LLM variation ────────────────────────────────────────────────────────────

async function variationChecks(): Promise<void> {
  section('llm variation');

  const line = NUDGE_LINES.intro[0];

  delete process.env.NUDGE_LLM_VARIATION;
  eq('off by default, the pool line is used unchanged',
    await varyNudgeLine(line, [], { llm: async () => 'A completely different sentence.' }),
    line);

  eq('when enabled, a clean rewrite is used',
    await varyNudgeLine(line, [], { enabled: true, llm: async () => 'A yes or no is all I need.' }),
    'A yes or no is all I need.');

  eq('surrounding quotes are stripped',
    await varyNudgeLine(line, [], { enabled: true, llm: async () => '"A yes or no is all I need."' }),
    'A yes or no is all I need.');

  eq('an answer with a link falls back',
    await varyNudgeLine(line, [], { enabled: true, llm: async () => 'Book at https://example.com now.' }),
    line);

  eq('an answer with money falls back',
    await varyNudgeLine(line, [], { enabled: true, llm: async () => 'The call pays $400 an hour.' }),
    line);

  eq('an answer with an em dash falls back',
    await varyNudgeLine(line, [], { enabled: true, llm: async () => 'Let me know—either way.' }),
    line);

  eq('an answer in markdown falls back',
    await varyNudgeLine(line, [], { enabled: true, llm: async () => '**Let me know** either way.' }),
    line);

  eq('an over-long answer falls back',
    await varyNudgeLine(line, [], { enabled: true, llm: async () => `${'x'.repeat(200)}.` }),
    line);

  eq('an empty answer falls back',
    await varyNudgeLine(line, [], { enabled: true, llm: async () => '   ' }),
    line);

  eq('an answer that repeats a line already sent falls back',
    await varyNudgeLine(line, ['A yes or no is all i need.'], {
      enabled: true,
      llm: async () => 'A yes or no is all I need.',
    }),
    line);

  eq('a throwing model falls back',
    await varyNudgeLine(line, [], { enabled: true, llm: async () => { throw new Error('boom'); } }),
    line);

  process.env.NUDGE_LLM_VARIATION = 'true';
  eq('the env switch turns it on',
    await varyNudgeLine(line, [], { llm: async () => 'A yes or no is all I need.' }),
    'A yes or no is all I need.');
  delete process.env.NUDGE_LLM_VARIATION;
}

variationChecks()
  .then(() => {
    summary();
  })
  .catch(err => {
    console.log(`FAIL  variation checks threw — ${err instanceof Error ? err.message : 'unknown'}`);
    process.exit(1);
  });
