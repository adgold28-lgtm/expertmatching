// scripts/test-outreach-stats.ts — the outreach numbers (lib/outreachStats.ts):
// the client's live project stats and the Test A scoreboard.
//
//   npx tsx scripts/test-outreach-stats.ts
//
// Pure: no network, no database, no env vars. What it proves:
//   - the five-business-day window, judged on the US Eastern calendar, across
//     weekends and across the UTC date line
//   - a walkthrough-held intro (and a send the chokepoint released) never counts
//   - bounces, complaints and delivered; a reply overrules a bounce
//   - the arm split, with the event payload filling a missing arm
//   - empty denominators come back null, never 0%
//   - the median, and first-reply time from events and messages over the
//     overwritten replyDetectedAt
//   - first intro → first booked call, ignoring a cancelled booking
//   - the Test A marks (pass / fail / pending / no data) and their bounds
//   - the client payload builder carries five numbers and nothing staff-only

import type { Expert, ProjectExpert } from '../types';
import {
  addBusinessDays,
  collectDeclineWords,
  collectPages,
  deriveEngagementFacts,
  introSentBetween,
  median,
  onOrBeforeDay,
  outreachByArm,
  ratio,
  replyMessageFromRow,
  replyWindowDeadline,
  statsEventFromRow,
  statsFieldsFromRecord,
  summarizeOutreach,
  summarizeProject,
  testAMarks,
  toClientProjectStats,
  type ClientProjectStats,
  type EngagementFacts,
  type ProjectOutreachSummary,
  type StatsEngagement,
  type StatsEvent,
  type StatsExpertFields,
  type StatsReplyMessage,
} from '../lib/outreachStats';
import { civilDateToIso, isoToCivilDate, type CivilDate } from '../lib/availabilityWindows';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

const HOUR = 3_600_000;
const DAY  = 24 * HOUR;

/** An instant from a local US Eastern wall time; October 2026 is EDT (UTC-4). */
function edt(local: string): number {
  return Date.parse(`${local}-04:00`);
}
/** November 2026 after the 1st is EST (UTC-5). */
function est(local: string): number {
  return Date.parse(`${local}-05:00`);
}
function day(iso: string): CivilDate {
  const d = isoToCivilDate(iso);
  if (!d) throw new Error(`bad date ${iso}`);
  return d;
}

// The read-out: Wednesday 2026-11-11, noon Eastern.
const NOW = est('2026-11-11T12:00:00');

const P1 = 'a'.repeat(24);
const P2 = 'b'.repeat(24);

let seq = 0;
function eng(fields: Partial<StatsExpertFields> & { status?: string }, projectId = P1, expertId?: string): StatsEngagement {
  seq++;
  return {
    projectId,
    expertId: expertId ?? `exp-${seq}`,
    pe: { status: 'contacted', ...fields },
  };
}

function facts(
  engagements: StatsEngagement[],
  events: StatsEvent[] = [],
  replies: StatsReplyMessage[] = [],
  now = NOW,
): EngagementFacts[] {
  return deriveEngagementFacts(engagements, events, replies, now);
}

// ── A ProjectExpert is accepted as-is (compile-time) ─────────────────────────
// The client route hands the project's own records straight to the stats.
const fullRecord: ProjectExpert = {
  expert:    { id: 'x', name: 'Scott Smithers' } as Expert,
  status:    'contacted',
  addedAt:   1,
  updatedAt: 1,
  email1SentAt: edt('2026-10-14T10:00:00'),
  booking: null,
};
const asStats: StatsExpertFields = fullRecord;
check('a ProjectExpert satisfies StatsExpertFields', asStats.status === 'contacted');

// ═════════════════════════════════════════════════════════════════════════════
section('business days: the window across weekends');

eq('Mon + 5 business days = next Mon', civilDateToIso(addBusinessDays(day('2026-10-12'), 5)), '2026-10-19');
eq('Wed + 5 = next Wed',               civilDateToIso(addBusinessDays(day('2026-10-14'), 5)), '2026-10-21');
eq('Fri + 5 = next Fri',               civilDateToIso(addBusinessDays(day('2026-10-16'), 5)), '2026-10-23');
eq('Sat + 5 = the Fri after (Mon is day 1)', civilDateToIso(addBusinessDays(day('2026-10-17'), 5)), '2026-10-23');
eq('Sun + 5 = the Fri after',          civilDateToIso(addBusinessDays(day('2026-10-18'), 5)), '2026-10-23');
eq('Thu + 1 = Fri',                    civilDateToIso(addBusinessDays(day('2026-10-15'), 1)), '2026-10-16');
eq('Fri + 1 = Mon',                    civilDateToIso(addBusinessDays(day('2026-10-16'), 1)), '2026-10-19');
eq('across the DST change: Fri Oct 30 + 5 = Fri Nov 6',
  civilDateToIso(addBusinessDays(day('2026-10-30'), 5)), '2026-11-06');
eq('holidays are not skipped: Fri Nov 6 + 5 = Fri Nov 13 (Veterans Day counts)',
  civilDateToIso(addBusinessDays(day('2026-11-06'), 5)), '2026-11-13');

section('business days: judged on the Eastern calendar, not UTC');

// Mon Oct 19, 23:30 Eastern is already Tue Oct 20 in UTC.
const lateMonday = edt('2026-10-19T23:30:00');
eq('a late-Monday intro is a Monday intro', civilDateToIso(replyWindowDeadline(lateMonday)), '2026-10-26');
check('reply Mon Oct 26 at 23:00 Eastern is inside',
  onOrBeforeDay(edt('2026-10-26T23:00:00'), replyWindowDeadline(lateMonday)));
check('reply Tue Oct 27 at 09:00 Eastern is outside',
  !onOrBeforeDay(edt('2026-10-27T09:00:00'), replyWindowDeadline(lateMonday)));

{
  const friIntro = edt('2026-10-16T10:00:00');
  const [weekendReply, sixthDayReply, fifthDayReply, sameDayReply] = facts([
    eng({ email1SentAt: friIntro, replyDetectedAt: edt('2026-10-18T09:00:00'), replyIntent: 'interested' }),
    eng({ email1SentAt: friIntro, replyDetectedAt: edt('2026-10-26T09:00:00'), replyIntent: 'interested' }),
    eng({ email1SentAt: friIntro, replyDetectedAt: edt('2026-10-23T22:00:00'), replyIntent: 'interested' }),
    eng({ email1SentAt: friIntro, replyDetectedAt: edt('2026-10-16T11:00:00'), replyIntent: 'declined' }),
  ]);
  check('Fri intro, Sun reply → inside the window', weekendReply.repliedInWindow);
  check('Fri intro, reply on business day 6 (Mon) → outside', !sixthDayReply.repliedInWindow);
  check('Fri intro, reply late on business day 5 (Fri) → inside', fifthDayReply.repliedInWindow);
  check('same-day reply → inside', sameDayReply.repliedInWindow);
  check('a window that ended Oct 23 is closed by Nov 11', weekendReply.windowClosed);
}

{
  // Intro Mon Nov 9; on Wed Nov 11 its window is still open.
  const [open] = facts([eng({ email1SentAt: est('2026-11-09T10:00:00') })]);
  check('an intro two days old has an open window', !open.windowClosed);
  const t = summarizeOutreach([open]);
  eq('open window, no reply → stillInWindow', t.stillInWindow, 1);
  eq('open window is left out of the window rate denominator', t.inWindowRate.denominator, 0);
  eq('…so the window rate is null, not 0', t.inWindowRate.rate, null);
}

// ═════════════════════════════════════════════════════════════════════════════
section('walkthrough and held sends never count');

{
  const t0 = edt('2026-10-14T10:00:00');
  const fs = facts([
    // Walkthrough bookmark: drafted, never claimed (draftOnly).
    eng({ status: 'outreach_drafted' }),
    // The chokepoint held the send: the claim was released (email1SentAt 0),
    // contactedAt and outreachStep 'email1' are left behind. Still not sent.
    { projectId: P1, expertId: 'released', pe: { status: 'outreach_drafted', email1SentAt: 0 } },
    // Walkthrough intro for an expert with no address.
    eng({ status: 'bookmarked' }),
    // A real send.
    eng({ email1SentAt: t0 }),
  ]);
  const t = summarizeOutreach(fs);
  eq('only the claimed intro is sent', t.introsSent, 1);
  eq('held rows are nowhere in the counts', fs.filter(f => f.introSentAt !== null).length, 1);

  const walkthroughOnly = facts([eng({ status: 'outreach_drafted' }, P2), eng({ status: 'bookmarked' }, P2)]);
  const client = toClientProjectStats(summarizeProject(P2, walkthroughOnly));
  eq('a walkthrough project: client introsSent 0 (the panel hides)', client.introsSent, 0);
  eq('a walkthrough project: client replyRate null', client.replyRate, null);
  eq('a walkthrough project: no first-call time', client.firstCallAfterMs, null);
}

{
  // A re-send after a bounce reset the claim: the intro_sent event still says it went.
  const at = edt('2026-10-15T09:00:00');
  const [f] = facts(
    [{ projectId: P1, expertId: 'resent', pe: { status: 'outreach_drafted', email1SentAt: 0, contactBouncedAt: at + HOUR } }],
    [{ projectId: P1, expertId: 'resent', type: 'intro_sent', at, introArm: 2 }],
  );
  eq('intro time falls back to the intro_sent event', f.introSentAt, at);
  eq('…and the arm to its payload', f.arm, 2);
  check('…and that intro bounced', f.bounced);
}

// ═════════════════════════════════════════════════════════════════════════════
section('bounces, complaints, delivered');

{
  const t0 = edt('2026-10-14T10:00:00');
  const fs = facts([
    eng({ email1SentAt: t0, contactBouncedAt: t0 + 5 * 60_000, bouncedEmails: ['x@example.com'] }),
    // Bounced, then a new address and a new intro after it: delivered.
    eng({ email1SentAt: t0 + DAY, contactBouncedAt: t0 + HOUR }),
    // A reply proves delivery even with a bounce stamp on record.
    eng({ email1SentAt: t0, contactBouncedAt: t0 + HOUR, replyDetectedAt: t0 + 2 * HOUR, replyIntent: 'interested' }),
    // Bounced list with no stamp: treated as bounced.
    eng({ email1SentAt: t0, bouncedEmails: ['y@example.com'] }),
    // Complaint: delivered (they saw it), counted.
    eng({ email1SentAt: t0, complaintAt: t0 + DAY }),
    eng({ email1SentAt: t0 }),
  ]);
  const t = summarizeOutreach(fs);
  eq('sent', t.introsSent, 6);
  eq('bounces', t.bounces, 2);
  eq('delivered = sent - bounces', t.delivered, 4);
  eq('complaints', t.complaints, 1);
  eq('a bounced intro is not waiting in its window', t.stillInWindow, 0);
}

// ═════════════════════════════════════════════════════════════════════════════
section('arm split');

{
  const t0 = edt('2026-10-14T10:00:00');
  const fs = facts(
    [
      eng({ email1SentAt: t0, introArm: 1, replyDetectedAt: t0 + HOUR, replyIntent: 'interested' }),
      eng({ email1SentAt: t0, introArm: 1 }),
      eng({ email1SentAt: t0, introArm: 2, replyDetectedAt: t0 + HOUR, replyIntent: 'declined' }),
      eng({ email1SentAt: t0 }, P1, 'arm-from-event'),
      eng({ email1SentAt: t0 }),                       // legacy: no arm anywhere
      eng({ status: 'outreach_drafted', introArm: 2 }),  // drafted, never sent
    ],
    [{ projectId: P1, expertId: 'arm-from-event', type: 'intro_sent', at: t0, introArm: 2 }],
  );
  const split = outreachByArm(fs);
  eq('all', split.all.introsSent, 5);
  eq('arm 1', split.arm1.introsSent, 2);
  eq('arm 2 (one from the event payload; the unsent draft excluded)', split.arm2.introsSent, 2);
  eq('unassigned', split.unassigned, 1);
  eq('arm 1 replies', split.arm1.replies, 1);
  eq('arm 2 replies', split.arm2.replies, 1);
  eq('arm 1 reply rate', split.arm1.replyRate.rate, 0.5);
  eq('arm 2 declines', split.arm2.declines.expertSaidNo, 1);
}

// ═════════════════════════════════════════════════════════════════════════════
section('null, never zero, on an empty denominator');

{
  const t = summarizeOutreach([]);
  eq('reply rate on nothing', t.replyRate.rate, null);
  eq('window rate on nothing', t.inWindowRate.rate, null);
  eq('median wait on nothing', t.medianTimeToFirstReplyMs, null);
  const marks = testAMarks(t);
  eq('Test A reply line with nothing sent', marks.replyLine, 'no_data');
  eq('Test A agreed line with nothing sent', marks.agreedLine, 'no_data');
  eq('ratio(0, 0).rate', ratio(0, 0).rate, null);
  eq('ratio(0, 4).rate is a real 0', ratio(0, 4).rate, 0);
  const empty = outreachByArm([]);
  eq('an empty arm has a null rate', empty.arm2.replyRate.rate, null);
}

// ═════════════════════════════════════════════════════════════════════════════
section('median and the first reply');

eq('median of one', median([7]), 7);
eq('median of odd', median([5, 1, 3]), 3);
eq('median of even', median([4, 1, 3, 2]), 2.5);
eq('median of none', median([]), null);

{
  const t0 = edt('2026-10-14T10:00:00');
  const [f] = facts(
    // replyDetectedAt is the LATEST classified reply; the first was earlier.
    [{ projectId: P1, expertId: 'two-replies', pe: { status: 'followup_sent', email1SentAt: t0, replyDetectedAt: t0 + 9 * DAY, replyIntent: 'interested' } }],
    [{ projectId: P1, expertId: 'two-replies', type: 'reply_received', at: t0 + 3 * HOUR }],
    [{ projectId: P1, expertId: 'two-replies', at: t0 + 2 * HOUR, intent: 'interested' }],
  );
  eq('first reply = earliest of events and messages', f.firstReplyAt, t0 + 2 * HOUR);
  check('…which is inside the window', f.repliedInWindow);

  const [fallback] = facts([eng({ email1SentAt: t0, replyDetectedAt: t0 + 30 * HOUR, replyIntent: 'conflict' })]);
  eq('no events or messages: falls back to replyDetectedAt', fallback.firstReplyAt, t0 + 30 * HOUR);

  const fs = facts([
    eng({ email1SentAt: t0, replyDetectedAt: t0 + 1 * HOUR, replyIntent: 'interested' }),
    eng({ email1SentAt: t0, replyDetectedAt: t0 + 5 * HOUR, replyIntent: 'interested' }),
    eng({ email1SentAt: t0, replyDetectedAt: t0 + 3 * HOUR, replyIntent: 'declined' }),
    eng({ email1SentAt: t0 }),
  ]);
  eq('median time to first reply', summarizeOutreach(fs).medianTimeToFirstReplyMs, 3 * HOUR);
}

// ═════════════════════════════════════════════════════════════════════════════
section('automatic replies are not replies (founder, 2026-10-17)');

{
  const t0 = edt('2026-10-14T10:00:00');
  const fs = facts(
    [
      eng({ email1SentAt: t0 }, P1, 'ooo-then-yes'),
      eng({ email1SentAt: t0 }, P1, 'ooo-only'),
      eng({ email1SentAt: t0 }, P1, 'blocked-only'),
      eng({ email1SentAt: t0 }, P1, 'unclear-human'),
    ],
    [],
    [
      { projectId: P1, expertId: 'ooo-then-yes',  at: t0 + DAY,      intent: 'auto_reply' },
      { projectId: P1, expertId: 'ooo-then-yes',  at: t0 + 12 * DAY, intent: 'interested' },
      { projectId: P1, expertId: 'ooo-only',      at: t0 + DAY,      intent: 'auto_reply' },
      { projectId: P1, expertId: 'blocked-only',  at: t0 + DAY,      intent: 'auto_reply' },
      // A real person asking "who is this?" is a reply, even if Matchy cannot file it.
      { projectId: P1, expertId: 'unclear-human', at: t0 + DAY,      intent: 'unclear' },
    ],
  );
  const [late, ooo, blocked, human] = fs;
  check('an out-of-office does not start the reply clock', late.firstReplyAt === t0 + 12 * DAY);
  check('…so the real reply after the window is not in time', !late.repliedInWindow);
  check('an out-of-office alone is not a reply', ooo.firstReplyAt === null);
  check('…and is marked automatic-only', ooo.automaticReplyOnly);
  check('a blocked notice alone is not a reply', blocked.firstReplyAt === null && blocked.automaticReplyOnly);
  check('a human reply Matchy could not file still counts', human.firstReplyAt === t0 + DAY && human.repliedInWindow);
  check('…and is not automatic', !human.automaticReplyOnly);
  const t = summarizeOutreach(fs);
  eq('replies leave automatic ones out', t.replies, 2);
  eq('replies in window', t.repliesInWindow, 1);
  eq('automatic replies counted on their own', t.automaticReplies, 2);
}

// ═════════════════════════════════════════════════════════════════════════════
section('agreement, counters, declines, passes');

{
  const t0 = edt('2026-10-14T10:00:00');
  const fs = facts(
    [
      eng({ email1SentAt: t0, status: 'scheduling_sent', rateAgreedAt: t0 + DAY, replyIntent: 'interested' }),
      // Countered, the client accepted, now booked: agreed, but not at the offered rate.
      eng({ email1SentAt: t0, status: 'scheduled', expertCounterRate: 700, rateAgreedAt: t0 + DAY,
            booking: { bookedAt: t0 + 2 * DAY } }),
      // Counter with no number: only the event says so.
      eng({ email1SentAt: t0, status: 'scheduled', booking: { bookedAt: t0 + 2 * DAY } }, P1, 'quiet-counter'),
      eng({ email1SentAt: t0, status: 'rejected_after_outreach', replyIntent: 'declined', replyDetectedAt: t0 + HOUR }),
      eng({ email1SentAt: t0, status: 'rejected_after_outreach', rejectionReason: 'too_generic' }),
      eng({ email1SentAt: t0, status: 'rejected_after_outreach' }),
      // Staff removal for fault is not a client pass.
      eng({ email1SentAt: t0, status: 'rejected_after_outreach', expertRemovedAt: t0 + 3 * DAY,
            booking: { bookedAt: t0 + 2 * DAY, cancelledAt: t0 + 3 * DAY } }),
      eng({ email1SentAt: t0, status: 'conflict_flagged', replyIntent: 'conflict', replyDetectedAt: t0 + HOUR }),
    ],
    [{ projectId: P1, expertId: 'quiet-counter', type: 'intent_classified', at: t0 + HOUR, intent: 'counter_rate' }],
  );
  const t = summarizeOutreach(fs);
  // The expert removed for fault had agreed and booked before cancelling: an
  // agreement is a fact about what they said, not about how the call ended.
  eq('agreed to a call (any rate; the later-cancelled booking included)', t.agreedToCall, 4);
  eq('agreed at the offered rate', t.agreedAtOfferedRate, 2);
  eq('countered on rate', t.counteredOnRate, 2);
  eq('positive replies', t.positiveReplies, 4);
  eq('expert said no', t.declines.expertSaidNo, 1);
  eq('client passed after the intro', t.declines.clientPassed, 2);
  eq('pass reason recorded', t.declines.clientPassReasons.too_generic, 1);
  eq('pass reason missing → unspecified', t.declines.clientPassReasons.unspecified, 1);
  eq('conflicts raised', t.conflictsRaised, 1);
  eq('calls booked: the cancelled booking is not one', t.callsBooked, 2);
}

// ═════════════════════════════════════════════════════════════════════════════
section('first intro → first booked call');

{
  const t0 = edt('2026-10-14T10:00:00');
  const fs = facts(
    [
      eng({ email1SentAt: t0 }),
      eng({ email1SentAt: t0 + DAY, status: 'scheduled', booking: { bookedAt: t0 + 3 * DAY } }),
      // An earlier booking that was cancelled is not the first booked call.
      eng({ email1SentAt: t0 + DAY, status: 'scheduling_sent', booking: { bookedAt: t0 + 2 * DAY, cancelledAt: t0 + 2.5 * DAY } }),
      // Another project's earlier booking does not leak in.
      eng({ email1SentAt: t0, status: 'scheduled', booking: { bookedAt: t0 + HOUR } }, P2),
    ],
  );
  const s = summarizeProject(P1, fs);
  eq('first intro', s.firstIntroAt, t0);
  eq('first booked call', s.firstBookedAt, t0 + 3 * DAY);
  eq('first intro → first call', s.firstCallAfterMs, 3 * DAY);
  eq('calls booked in P1', s.callsBooked, 1);

  const [manual] = facts(
    [{ projectId: P1, expertId: 'manual', pe: { status: 'completed', email1SentAt: t0 } }],
    [{ projectId: P1, expertId: 'manual', type: 'scheduled', at: t0 + 4 * DAY }],
  );
  eq('completed with no booking record: time from the scheduled event', manual.firstBookedAt, t0 + 4 * DAY);
  check('…and it counts as a booked call', manual.callBooked);

  const none = summarizeProject(P1, facts([eng({ email1SentAt: t0 })]));
  eq('no call yet → null', none.firstCallAfterMs, null);
}

// ═════════════════════════════════════════════════════════════════════════════
section('Test A marks');

/** `n` intros sent on Mon Oct 12 (all windows closed by Nov 11). */
function cohort(n: number, repliedInWindow: number, openNoReply = 0): EngagementFacts[] {
  const sent = edt('2026-10-12T10:00:00');
  const open = est('2026-11-10T10:00:00');
  const list: StatsEngagement[] = [];
  for (let i = 0; i < n - openNoReply; i++) {
    list.push(eng(i < repliedInWindow
      ? { email1SentAt: sent, replyDetectedAt: sent + DAY, replyIntent: 'interested' }
      : { email1SentAt: sent }));
  }
  for (let i = 0; i < openNoReply; i++) list.push(eng({ email1SentAt: open }));
  return facts(list);
}

eq('15 of 100, every window closed → pass', testAMarks(summarizeOutreach(cohort(100, 15))).replyLine, 'pass');
eq('14 of 100, every window closed → fail', testAMarks(summarizeOutreach(cohort(100, 14))).replyLine, 'fail');
eq('10 of 100 with 10 still open → pending', testAMarks(summarizeOutreach(cohort(100, 10, 10))).replyLine, 'pending');
eq('10 of 100 with 4 still open → fail (cannot reach 15)', testAMarks(summarizeOutreach(cohort(100, 10, 4))).replyLine, 'fail');
eq('15 of 100 with 30 still open → already a pass', testAMarks(summarizeOutreach(cohort(100, 15, 30))).replyLine, 'pass');
{
  const t = summarizeOutreach(cohort(100, 10, 10));
  eq('window rate counts closed windows only (denominator)', t.inWindowRate.denominator, 90);
  eq('window rate numerator', t.inWindowRate.numerator, 10);
}

function agreedCohort(agreed: number, openNoReply: number): EngagementFacts[] {
  const sent = edt('2026-10-12T10:00:00');
  const list: StatsEngagement[] = [];
  for (let i = 0; i < agreed; i++) list.push(eng({ email1SentAt: sent, status: 'scheduling_sent', rateAgreedAt: sent + DAY }));
  for (let i = 0; i < 20; i++) list.push(eng({ email1SentAt: sent }));
  for (let i = 0; i < openNoReply; i++) list.push(eng({ email1SentAt: est('2026-11-10T10:00:00') }));
  return facts(list);
}
eq('5 agreed → pass', testAMarks(summarizeOutreach(agreedCohort(5, 0))).agreedLine, 'pass');
eq('4 agreed, windows still open → pending', testAMarks(summarizeOutreach(agreedCohort(4, 3))).agreedLine, 'pending');
eq('4 agreed, every window closed → fail', testAMarks(summarizeOutreach(agreedCohort(4, 0))).agreedLine, 'fail');

// ═════════════════════════════════════════════════════════════════════════════
section('the client payload carries five numbers and nothing else');

{
  const t0 = edt('2026-10-14T10:00:00');
  const fs = facts(
    [
      eng({ email1SentAt: t0, introArm: 1, replyDetectedAt: t0 + HOUR, replyIntent: 'declined', complaintAt: t0 + DAY }),
      eng({ email1SentAt: t0, introArm: 2, contactBouncedAt: t0 + HOUR, bouncedEmails: ['bounced@example.com'] }),
      eng({ email1SentAt: t0, introArm: 2, status: 'scheduled', rateAgreedAt: t0 + DAY, expertCounterRate: 900,
            booking: { bookedAt: t0 + 2 * DAY }, mismatchFlaggedAt: t0 + 3 * DAY }),
      eng({ email1SentAt: t0 + HOUR }),
    ],
    [],
    [{ projectId: P1, expertId: 'exp-x', at: t0 + HOUR, intent: 'declined', summary: 'Not interested, retired from the field.' }],
  );
  const s = summarizeProject(P1, fs);
  const client = toClientProjectStats(s);
  eq('client introsSent is the delivered count', client.introsSent, 3);
  eq('client replies', client.replies, 1);
  eq('client reply rate is over the delivered count', client.replyRate, 1 / 3);
  eq('client calls booked', client.callsBooked, 1);
  eq('client first call after', client.firstCallAfterMs, 2 * DAY);

  const allowed = ['introsSent', 'replies', 'replyRate', 'callsBooked', 'firstCallAfterMs'].sort();
  eq('exactly the five keys', JSON.stringify(Object.keys(client).sort()), JSON.stringify(allowed));

  // Whatever is added to the server-side summary later stays there.
  const loaded = { ...s, arm: 2, bouncedEmails: ['bounced@example.com'], declineWords: ['retired'], expertRate: 900, expertName: 'Scott' } as ProjectOutreachSummary;
  const fromLoaded: ClientProjectStats = toClientProjectStats(loaded);
  const wire = JSON.stringify(fromLoaded);
  eq('extra summary keys do not cross', JSON.stringify(Object.keys(fromLoaded).sort()), JSON.stringify(allowed));
  for (const needle of ['arm', 'bounce', '@', 'decline', 'retired', 'expert', 'Scott', '900', 'mismatch', 'complaint', 'summary', 'projectId']) {
    check(`client payload carries no "${needle}"`, !wire.toLowerCase().includes(needle.toLowerCase()), wire);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
section('decline wording (staff list)');

{
  const t0 = edt('2026-10-14T10:00:00');
  const engagements = [
    eng({ email1SentAt: t0 }, P1, 'd1'),
    eng({ email1SentAt: t0 }, P1, 'd2'),
    eng({ status: 'outreach_drafted' }, P1, 'never-sent'),
  ];
  const replies: StatsReplyMessage[] = [
    { projectId: P1, expertId: 'd1', at: t0 + HOUR,     intent: 'declined',   summary: 'Declined. Too busy this quarter.' },
    { projectId: P1, expertId: 'd2', at: t0 + 2 * HOUR, intent: 'declined',   summary: 'Declined. Conflict with current employer.' },
    { projectId: P1, expertId: 'd2', at: t0 + 3 * HOUR, intent: 'interested', summary: 'Changed their mind.' },
    { projectId: P1, expertId: 'never-sent', at: t0, intent: 'declined', summary: 'Should not appear.' },
    { projectId: P1, expertId: 'd1', at: t0 + 4 * HOUR, intent: 'declined',   summary: null },
  ];
  const words = collectDeclineWords(facts(engagements, [], replies), replies);
  eq('only declined replies with a summary, from sent intros', words.length, 2);
  eq('newest first', words[0].expertId, 'd2');
  eq('the words are Matchy\'s summary', words[1].summary, 'Declined. Too busy this quarter.');
  eq('the cap holds', collectDeclineWords(facts(engagements, [], replies), replies, 1).length, 1);
}

// ═════════════════════════════════════════════════════════════════════════════
section('row adapters');

{
  const fields = statsFieldsFromRecord('scheduled', {
    email1SentAt: 1_760_000_000_000,
    introArm: '1',                       // wrong type: dropped
    replyIntent: 'interested',
    rateAgreedAt: null,
    booking: { bookedAt: 1_760_100_000_000, cancelledAt: null, zoomMeetingId: 'z' },
    bouncedEmails: 'not-an-array',       // wrong type: dropped
    complaintAt: 'yesterday',            // wrong type: dropped
  });
  eq('number kept', fields.email1SentAt, 1_760_000_000_000);
  eq('string arm dropped', fields.introArm, null);
  eq('intent kept', fields.replyIntent, 'interested');
  eq('booking time kept', fields.booking?.bookedAt, 1_760_100_000_000);
  check('booking carries only the two times', JSON.stringify(Object.keys(fields.booking ?? {}).sort()) === '["bookedAt","cancelledAt"]');
  eq('non-array bounced list dropped', fields.bouncedEmails, null);
  eq('string complaint dropped', fields.complaintAt, null);

  const ev = statsEventFromRow({
    project_id: P1, expert_id: 'e', type: 'intent_classified',
    payload: { intent: 'declined', hasRate: false }, created_at: '2026-10-14T14:00:00.000Z',
  });
  eq('event intent read from the payload', ev?.intent, 'declined');
  eq('event time parsed', ev?.at, Date.parse('2026-10-14T14:00:00.000Z'));
  eq('unparseable event time → dropped', statsEventFromRow({ project_id: P1, expert_id: 'e', type: 'x', payload: null, created_at: 'nope' }), null);

  const base = { project_id: P1, expert_id: 'e', created_at: '2026-10-14T14:00:00.000Z', intent: 'interested', summary: 's' };
  check('an inbound expert message is a reply', replyMessageFromRow({ ...base, direction: 'inbound', author: 'expert' }) !== null);
  eq('Matchy\'s outbound message is not a reply', replyMessageFromRow({ ...base, direction: 'outbound', author: 'matchy' }), null);
  eq('a client message is not a reply', replyMessageFromRow({ ...base, direction: 'outbound', author: 'client' }), null);
}

section('date filter (Eastern calendar)');

{
  const from = day('2026-10-14');
  const to   = day('2026-10-20');
  check('Oct 14 00:30 Eastern is inside', introSentBetween(edt('2026-10-14T00:30:00'), from, to));
  check('Oct 13 23:30 Eastern is outside (already Oct 14 in UTC)', !introSentBetween(edt('2026-10-13T23:30:00'), from, to));
  check('Oct 20 23:30 Eastern is inside (Oct 21 in UTC)', introSentBetween(edt('2026-10-20T23:30:00'), from, to));
  check('Oct 21 08:00 Eastern is outside', !introSentBetween(edt('2026-10-21T08:00:00'), from, to));
}

// ═════════════════════════════════════════════════════════════════════════════
section('paging');

void (async () => {
  const table = Array.from({ length: 2500 }, (_, i) => i);
  const page = (from: number, to: number) => Promise.resolve({ data: table.slice(from, to + 1), error: null });

  const all = await collectPages(page);
  eq('reads every row across pages', all.rows.length, 2500);
  check('not truncated, not failed', !all.truncated && !all.failed);

  const capped = await collectPages(page, 2000);
  eq('stops at the cap', capped.rows.length, 2000);
  check('…and says so', capped.truncated);

  let calls = 0;
  const failing = (from: number, to: number) => {
    calls++;
    return Promise.resolve(calls === 2
      ? { data: null, error: { message: 'boom' } }
      : { data: table.slice(from, to + 1), error: null });
  };
  const broken = await collectPages(failing);
  check('a failed page is reported', broken.failed);
  eq('…with the rows read before it', broken.rows.length, 1000);

  const exact = await collectPages((from: number, to: number) => Promise.resolve({ data: table.slice(0, 1000).slice(from, to + 1), error: null }));
  eq('an exact multiple of the page size ends on the empty page', exact.rows.length, 1000);

  summary('outreach-stats');
})();
