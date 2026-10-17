// The outreach numbers: the client's live project stats and the Test A
// scoreboard (founder/launch.md: "post two real briefs, let Matchy send 100
// anonymized intros. Success line: at least 15 of 100 experts reply within five
// business days, and at least 5 agree to a call at the offered rate").
//
// PURE. No I/O, no clock, no env: callers pass the rows and `now`. Two readers:
//   GET /api/projects/[projectId]/stats   → toClientProjectStats (aggregates only)
//   GET /api/admin/outreach-stats         → outreachByArm, testAMarks, the rest
// Safe to import from a client component for its TYPES; it pulls in nothing
// that touches a database or a secret.
//
// ─── WHERE EACH NUMBER COMES FROM ───────────────────────────────────────────
//
// project_experts.data (the ProjectExpert record) is authoritative wherever it
// carries the fact. engagement_events and conversation_messages fill in only
// what the record lacks, which is mostly WHEN something first happened: the
// record keeps the latest reply, not the first.
//
//   intro sent        data.email1SentAt > 0. It is the durable send claim
//                     (lib/outreachSteps.ts): written before the send and put
//                     back to 0 when the send chokepoint held it. A walkthrough
//                     intro never claims at all (draftOnly), so it never counts.
//                     NOT contactedAt: a released claim leaves contactedAt
//                     behind on an intro that never went. Fallback: the
//                     earliest `intro_sent` event, for a row whose claim was
//                     reset after the email really went (a re-send after a
//                     bounce). A row with neither never reached anyone.
//   intro arm         data.introArm, else the intro_sent event's payload.
//   bounced           data.contactBouncedAt at or after the intro (or a
//                     bouncedEmails list with no stamp), and no reply since: a
//                     reply proves the intro arrived. delivered = sent - bounced.
//   complaint         data.complaintAt.
//   first reply       the earliest of: `reply_received` events and inbound
//                     expert conversation_messages. Fallback data.replyDetectedAt,
//                     which is the LATEST classified reply (each reply
//                     overwrites it), so it can only ever overstate the wait.
//   reply intents     data.replyIntent (latest), every intent_classified event,
//                     every inbound message's intent. "Said yes", "said no",
//                     "countered" and "raised a conflict" mean ever, not last.
//   automatic reply   an inbound message stored with intent 'auto_reply': an
//                     out-of-office note or a "message blocked" / delivery
//                     notice (lib/autoReply.ts). Never a reply (founder,
//                     2026-10-17): it starts no reply clock and is left out of
//                     every reply count. Counted on its own as automaticReplies.
//   agreed to a call  data.rateAgreedAt, a status at or past scheduling
//                     (scheduling_sent / scheduled / completed), a booking, or a
//                     rate_agreed / scheduled event. "At the offered rate" adds:
//                     the expert never countered (no counter on the record, no
//                     counter_rate intent, no rate_countered event).
//   call booked       data.booking.bookedAt on a booking with no cancelledAt, or
//                     status 'completed'. The first booking time is bookedAt
//                     (kept across reschedules), else the earliest `scheduled`
//                     event.
//   client passed     status 'rejected_after_outreach' that is not an expert
//                     "no", not a staff removal and not a cancelled booking;
//                     its reason is data.rejectionReason.
//   mismatch claim    data.mismatchFlaggedAt, unless data.mismatchVoidedAt (the call ran
//                     past ten minutes and was billed). Completed call: status 'completed'.
//
// ─── THE FIVE-BUSINESS-DAY RULE ─────────────────────────────────────────────
//
// Days are judged on the calendar in US Eastern time (America/New_York).
// Business days are Monday to Friday; Saturdays and Sundays never count. US
// public holidays are NOT skipped (every weekday counts), so the rule is the
// same every week and needs no holiday table. The day the intro went out is
// day 0. The window closes at the end of the fifth business day after it:
//   intro Mon → through next Mon     intro Fri → through next Fri
//   intro Sat → through the Fri after (Mon is business day 1)
// A reply on the intro's own day, or over the weekend, is inside the window.
//
// The within-window RATE is read only over intros whose window has closed, so
// an intro sent yesterday cannot drag it down before it had its five days. The
// Test A mark uses bounds instead: settled when no open window can change it.
//
// EMPTY IS NOT ZERO. Every rate is a Ratio whose `rate` is null when its
// denominator is 0, and a median of nothing is null. A screen shows "not
// enough data" for those, never 0%.

import type { IntroArm, RejectionReason } from '../types';
import {
  addCivilDays,
  civilDateInZone,
  civilDateIsBefore,
  civilDayOfWeek,
  type CivilDate,
} from './availabilityWindows';

// ─── Constants ────────────────────────────────────────────────────────────────

/** The calendar the business-day rule is judged on. */
export const OUTREACH_STATS_ZONE = 'America/New_York';

/** Test A's reply window, in business days. */
export const REPLY_WINDOW_BUSINESS_DAYS = 5;

/** Test A line 1: replies within the window, as a whole percentage of intros sent. */
export const TEST_A_REPLY_LINE_PCT = 15;

/** Test A line 2: experts who agree to a call at the offered rate. */
export const TEST_A_AGREED_LINE = 5;

/** Statuses that are only reached once the expert has accepted a rate. */
const AGREED_STATUSES: ReadonlySet<string> = new Set(['scheduling_sent', 'scheduled', 'completed']);

/** The intent lib/autoReply.ts stores on an automatic reply. Never counted as a reply. */
const AUTO_REPLY_INTENT = 'auto_reply';

/** Most decline summaries the scoreboard lists. */
export const MAX_DECLINE_WORDS = 200;

/** The engagement_events types the stats read; the routes select only these. */
export const STATS_EVENT_TYPES = [
  'intro_sent', 'reply_received', 'intent_classified',
  'rate_countered', 'rate_agreed', 'scheduled', 'rejected',
] as const;

// ─── Inputs ───────────────────────────────────────────────────────────────────

/** A booking as far as the stats need it. BookingState satisfies it. */
export interface StatsBooking {
  bookedAt?:    number | null;
  cancelledAt?: number | null;
}

/**
 * The fields of one engagement record the stats read. A ProjectExpert is
 * assignable as-is (the client route passes the project's own rows); the admin
 * route reads only these paths out of `project_experts.data` and runs them
 * through statsFieldsFromRecord.
 */
export interface StatsExpertFields {
  status:               string;
  email1SentAt?:        number | null;
  introArm?:            number | null;
  replyDetectedAt?:     number | null;
  replyIntent?:         string | null;
  rejectionReason?:     string | null;
  rateAgreedAt?:        number | null;
  expertCounterRate?:   number | null;
  clientCounterRate?:   number | null;
  counterRateProposed?: number | null;
  booking?:             StatsBooking | null;
  bouncedEmails?:       readonly unknown[] | null;
  contactBouncedAt?:    number | null;
  complaintAt?:         number | null;
  mismatchFlaggedAt?:   number | null;
  mismatchVoidedAt?:    number | null;
  expertRemovedAt?:     number | null;
}

export interface StatsEngagement {
  projectId: string;
  expertId:  string;
  pe:        StatsExpertFields;
}

/** One engagement_events row, reduced to what the stats read. */
export interface StatsEvent {
  projectId: string;
  expertId:  string;
  type:      string;
  at:        number;
  /** payload.intent on intent_classified. */
  intent?:   string | null;
  /** payload.introArm on intro_sent. */
  introArm?: number | null;
  /** payload.reason on rejected. */
  reason?:   string | null;
}

/** One inbound expert message (conversation_messages, author 'expert'). */
export interface StatsReplyMessage {
  projectId: string;
  expertId:  string;
  at:        number;
  intent:    string | null;
  /** Matchy's one-line summary. Staff only: read by collectDeclineWords, never by a client payload. */
  summary?:  string | null;
}

// ─── Outputs ──────────────────────────────────────────────────────────────────

/** A rate that knows when it has nothing to say: `rate` is null on a 0 denominator. */
export interface Ratio {
  numerator:   number;
  denominator: number;
  rate:        number | null;
}

/** Everything the stats know about one engagement. Staff-side only. */
export interface EngagementFacts {
  projectId:             string;
  expertId:              string;
  arm:                   IntroArm | null;
  /** Null: the intro never reached anyone. Such a row is left out of every count. */
  introSentAt:           number | null;
  bounced:               boolean;
  complained:            boolean;
  firstReplyAt:          number | null;
  /** Only automatic replies came back (out of office, blocked notices): not a reply. */
  automaticReplyOnly:    boolean;
  /** The last calendar day (US Eastern) of this intro's reply window. */
  windowDeadline:        CivilDate | null;
  windowClosed:          boolean;
  repliedInWindow:       boolean;
  saidYes:               boolean;
  saidNo:                boolean;
  countered:             boolean;
  conflictRaised:        boolean;
  agreedToCall:          boolean;
  agreedAtOfferedRate:   boolean;
  clientPassed:          boolean;
  clientPassReason:      string | null;
  callBooked:            boolean;
  firstBookedAt:         number | null;
  completed:             boolean;
  mismatchClaimed:       boolean;
}

export interface DeclineCounts {
  /** The expert's reply was read as a no. */
  expertSaidNo:      number;
  /** The client passed on the expert after the intro went (status rejected_after_outreach). */
  clientPassed:      number;
  /** clientPassed by RejectionReason; 'unspecified' when none was recorded. */
  clientPassReasons: Record<string, number>;
}

export interface OutreachTotals {
  introsSent:             number;
  delivered:              number;
  bounces:                number;
  complaints:             number;
  /** Engagements with at least one reply of any kind. */
  replies:                number;
  /** replies / introsSent. */
  replyRate:              Ratio;
  /** Replied inside the five-business-day window (window open or closed). */
  repliesInWindow:        number;
  /** Over intros whose window has closed: replied inside it / closed. */
  inWindowRate:           Ratio;
  /** Window still open, no reply yet, and not bounced: could still count. */
  stillInWindow:          number;
  /** Intros that got only automatic replies (out of office, blocked notices). */
  automaticReplies:       number;
  positiveReplies:        number;
  counteredOnRate:        number;
  conflictsRaised:        number;
  agreedToCall:           number;
  agreedAtOfferedRate:    number;
  declines:               DeclineCounts;
  medianTimeToFirstReplyMs: number | null;
  callsBooked:            number;
  completedCalls:         number;
  mismatchClaims:         number;
}

export interface ArmSplit<T> {
  all:  T;
  arm1: T;
  arm2: T;
  /** Sent intros with no recorded arm: in `all`, in neither arm. */
  unassigned: number;
}

/** One project's headline numbers. */
export interface ProjectOutreachSummary {
  projectId:        string;
  introsSent:       number;
  delivered:        number;
  /** Replies; every replied intro was delivered, so replies <= delivered. */
  replies:          number;
  callsBooked:      number;
  firstIntroAt:     number | null;
  firstBookedAt:    number | null;
  firstCallAfterMs: number | null;
}

/**
 * The ONLY shape a client receives. Aggregates of one project: no per-expert
 * rows, no arms, no decline wording, no money, no delivery machinery. Built by
 * toClientProjectStats, which copies these five fields by name and nothing else.
 */
export interface ClientProjectStats {
  /** Intros that reached an expert (sent minus the ones that could not be delivered). */
  introsSent:       number;
  replies:          number;
  /** replies / introsSent, or null when nothing has gone out. */
  replyRate:        number | null;
  callsBooked:      number;
  /** From the project's first intro to its first booked call, or null before one is booked. */
  firstCallAfterMs: number | null;
}

export type TestAMark = 'pass' | 'fail' | 'pending' | 'no_data';

export interface TestAReadout {
  /** Line 1 on any reply. */
  replyLine:         TestAMark;
  /** Line 2: agreed to a call at the offered rate. */
  agreedLine:        TestAMark;
}

export interface DeclineWords {
  projectId: string;
  expertId:  string;
  at:        number;
  summary:   string;
}

// ─── The staff wire shape (GET /api/admin/outreach-stats) ────────────────────

export interface ProjectOption {
  id:         string;
  name:       string;
  /** Intros this project has sent, any date. */
  introsSent: number;
}

export interface ProjectRowOut extends ProjectOutreachSummary {
  name: string;
}

export interface DeclineWordsOut extends DeclineWords {
  projectName: string;
  expertName:  string;
  arm:         IntroArm | null;
}

export interface OutreachStatsResponse {
  /** US Eastern calendar days the intros went out on, both inclusive. */
  range:          { from: string; to: string; zone: string };
  generatedAt:    number;
  /** The project filter applied; empty means every project. */
  projectIds:     string[];
  /** Every project that has sent an intro, for the filter. */
  projectOptions: ProjectOption[];
  byArm:          ArmSplit<OutreachTotals>;
  testA:          TestAReadout;
  projects:       ProjectRowOut[];
  declineWords:   DeclineWordsOut[];
  /** A read failed or hit its bound: the numbers may undercount. */
  incomplete:     boolean;
}

// ─── Small helpers ────────────────────────────────────────────────────────────

/** A positive finite number, else null. Stored stamps are unix ms; 0 means unset. */
function stamp(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/** A finite number other than 0 (a counter rate), else null. */
function present(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value !== 0 ? value : null;
}

function earliest(values: readonly (number | null)[]): number | null {
  let out: number | null = null;
  for (const v of values) {
    if (v === null) continue;
    if (out === null || v < out) out = v;
  }
  return out;
}

function toArm(value: unknown): IntroArm | null {
  return value === 1 || value === 2 ? value : null;
}

/** numerator / denominator, or null when there is nothing to divide by. */
export function ratio(numerator: number, denominator: number): Ratio {
  return { numerator, denominator, rate: denominator > 0 ? numerator / denominator : null };
}

/** The middle value (mean of the two middles on an even count), or null for none. */
export function median(values: readonly number[]): number | null {
  const sorted = values.filter(v => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function keyOf(projectId: string, expertId: string): string {
  return `${projectId}\u0000${expertId}`;
}

// ─── Business days ────────────────────────────────────────────────────────────

/** Monday to Friday. */
export function isBusinessDay(day: CivilDate): boolean {
  const dow = civilDayOfWeek(day);
  return dow >= 1 && dow <= 5;
}

/**
 * The `n`th business day after `day` (which is day 0 and never counts itself).
 * Civil arithmetic only, so a DST weekend cannot skip or repeat a date.
 */
export function addBusinessDays(day: CivilDate, n: number): CivilDate {
  let cursor = day;
  let counted = 0;
  // At most n business days plus the weekends between them; the cap is a
  // belt-and-braces bound on a loop that always terminates.
  for (let i = 0; counted < n && i < n * 2 + 7; i++) {
    cursor = addCivilDays(cursor, 1);
    if (isBusinessDay(cursor)) counted++;
  }
  return cursor;
}

/** The last calendar day (in `zone`) a reply to an intro sent at `introAt` still counts. */
export function replyWindowDeadline(
  introAt: number,
  zone: string = OUTREACH_STATS_ZONE,
  businessDays: number = REPLY_WINDOW_BUSINESS_DAYS,
): CivilDate {
  return addBusinessDays(civilDateInZone(new Date(introAt), zone), businessDays);
}

/** True when `at` falls on or before `deadline`, judged on the calendar in `zone`. */
export function onOrBeforeDay(at: number, deadline: CivilDate, zone: string = OUTREACH_STATS_ZONE): boolean {
  return !civilDateIsBefore(deadline, civilDateInZone(new Date(at), zone));
}

/** True when `introAt`'s calendar day (in `zone`) is within [from, to], both inclusive. */
export function introSentBetween(
  introAt: number,
  from: CivilDate,
  to: CivilDate,
  zone: string = OUTREACH_STATS_ZONE,
): boolean {
  const day = civilDateInZone(new Date(introAt), zone);
  return !civilDateIsBefore(day, from) && !civilDateIsBefore(to, day);
}

// ─── Row adapters ─────────────────────────────────────────────────────────────

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The stats fields out of an untyped record (a JSON-path select over
 * project_experts.data, where every value arrives as unknown JSON). Anything of
 * the wrong type is dropped rather than trusted.
 */
export function statsFieldsFromRecord(status: string, rec: Record<string, unknown>): StatsExpertFields {
  const rawBooking = rec.booking;
  let booking: StatsBooking | null = null;
  if (rawBooking && typeof rawBooking === 'object' && !Array.isArray(rawBooking)) {
    const b = rawBooking as Record<string, unknown>;
    booking = { bookedAt: asNumber(b.bookedAt), cancelledAt: asNumber(b.cancelledAt) };
  }
  return {
    status,
    email1SentAt:        asNumber(rec.email1SentAt),
    introArm:            asNumber(rec.introArm),
    replyDetectedAt:     asNumber(rec.replyDetectedAt),
    replyIntent:         asString(rec.replyIntent),
    rejectionReason:     asString(rec.rejectionReason),
    rateAgreedAt:        asNumber(rec.rateAgreedAt),
    expertCounterRate:   asNumber(rec.expertCounterRate),
    clientCounterRate:   asNumber(rec.clientCounterRate),
    counterRateProposed: asNumber(rec.counterRateProposed),
    booking,
    bouncedEmails:       Array.isArray(rec.bouncedEmails) ? rec.bouncedEmails : null,
    contactBouncedAt:    asNumber(rec.contactBouncedAt),
    complaintAt:         asNumber(rec.complaintAt),
    mismatchFlaggedAt:   asNumber(rec.mismatchFlaggedAt),
    mismatchVoidedAt:    asNumber(rec.mismatchVoidedAt),
    expertRemovedAt:     asNumber(rec.expertRemovedAt),
  };
}

/** An engagement_events row as the stats read it, or null when it is unusable. */
export function statsEventFromRow(row: {
  project_id: string;
  expert_id:  string;
  type:       string;
  payload:    unknown;
  created_at: string;
}): StatsEvent | null {
  const at = Date.parse(row.created_at);
  if (!row.project_id || !row.expert_id || !Number.isFinite(at)) return null;
  const payload = row.payload && typeof row.payload === 'object' && !Array.isArray(row.payload)
    ? row.payload as Record<string, unknown>
    : {};
  return {
    projectId: row.project_id,
    expertId:  row.expert_id,
    type:      row.type,
    at,
    intent:    asString(payload.intent),
    introArm:  asNumber(payload.introArm),
    reason:    asString(payload.reason),
  };
}

/**
 * An inbound expert conversation_messages row as the stats read it. Returns
 * null for anything that is not the expert writing in (Matchy's and the
 * client's messages are not replies).
 */
export function replyMessageFromRow(row: {
  project_id: string;
  expert_id:  string;
  created_at: string;
  intent:     string | null;
  summary?:   string | null;
  direction?: string;
  author?:    string;
}): StatsReplyMessage | null {
  if (row.direction !== undefined && row.direction !== 'inbound') return null;
  if (row.author !== undefined && row.author !== 'expert') return null;
  const at = Date.parse(row.created_at);
  if (!row.project_id || !row.expert_id || !Number.isFinite(at)) return null;
  return {
    projectId: row.project_id,
    expertId:  row.expert_id,
    at,
    intent:    asString(row.intent),
    summary:   asString(row.summary ?? null),
  };
}

// ─── Per-engagement facts ─────────────────────────────────────────────────────

interface Signals {
  events:  StatsEvent[];
  replies: StatsReplyMessage[];
}

function groupSignals(
  events: readonly StatsEvent[],
  replies: readonly StatsReplyMessage[],
): Map<string, Signals> {
  const map = new Map<string, Signals>();
  const slot = (projectId: string, expertId: string): Signals => {
    const k = keyOf(projectId, expertId);
    let s = map.get(k);
    if (!s) { s = { events: [], replies: [] }; map.set(k, s); }
    return s;
  };
  for (const e of events)  slot(e.projectId, e.expertId).events.push(e);
  for (const r of replies) slot(r.projectId, r.expertId).replies.push(r);
  return map;
}

/** The facts for one engagement. Exported for the tests; deriveEngagementFacts runs it per row. */
export function factsForEngagement(
  engagement: StatsEngagement,
  signals: Signals,
  now: number,
  zone: string = OUTREACH_STATS_ZONE,
): EngagementFacts {
  const { projectId, expertId, pe } = engagement;
  const { events, replies } = signals;
  const ofType = (type: string): StatsEvent[] => events.filter(e => e.type === type);

  // ── Sent ──
  const introEvents = ofType('intro_sent');
  const introSentAt = stamp(pe.email1SentAt) ?? earliest(introEvents.map(e => e.at));
  const armFromEvent = introEvents
    .slice()
    .sort((a, b) => a.at - b.at)
    .map(e => toArm(e.introArm))
    .find((a): a is IntroArm => a !== null) ?? null;
  const arm = toArm(pe.introArm) ?? armFromEvent;

  // ── Replies ──
  // An automatic reply (out of office, a blocked notice) is not a reply.
  const realReplies = replies.filter(r => r.intent !== AUTO_REPLY_INTENT);
  const replyStamps = [
    ...ofType('reply_received').map(e => e.at),
    ...realReplies.map(r => r.at),
  ];
  const replyDetectedAt = stamp(pe.replyDetectedAt);
  const firstReplyAt = earliest(replyStamps) ?? replyDetectedAt;

  const intents = new Set<string>();
  if (pe.replyIntent) intents.add(pe.replyIntent);
  for (const e of ofType('intent_classified')) if (e.intent) intents.add(e.intent);
  for (const r of realReplies) if (r.intent) intents.add(r.intent);


  // ── Delivery ──
  const bounceAt   = stamp(pe.contactBouncedAt);
  const bounceList = Array.isArray(pe.bouncedEmails) && pe.bouncedEmails.length > 0;
  const bounceHit  = introSentAt !== null && (bounceAt !== null ? bounceAt >= introSentAt : bounceList);
  const bounced    = bounceHit && firstReplyAt === null;
  const complained = stamp(pe.complaintAt) !== null;

  // ── The window ──
  const windowDeadline = introSentAt !== null ? replyWindowDeadline(introSentAt, zone) : null;
  const windowClosed   = windowDeadline !== null && civilDateIsBefore(windowDeadline, civilDateInZone(new Date(now), zone));
  const repliedInWindow  = windowDeadline !== null && firstReplyAt !== null && onOrBeforeDay(firstReplyAt, windowDeadline, zone);
  const automaticReplyOnly = firstReplyAt === null && replies.some(r => r.intent === AUTO_REPLY_INTENT);

  // ── What they said ──
  const status = pe.status;
  const booking = pe.booking ?? null;
  const bookedAtOnRecord = stamp(booking?.bookedAt);
  const bookingCancelled = stamp(booking?.cancelledAt) !== null;

  const countered = intents.has('counter_rate')
    || ofType('rate_countered').length > 0
    || present(pe.expertCounterRate) !== null
    || present(pe.clientCounterRate) !== null
    || present(pe.counterRateProposed) !== null
    || status === 'rate_negotiation';

  const agreedToCall = stamp(pe.rateAgreedAt) !== null
    || AGREED_STATUSES.has(status)
    || bookedAtOnRecord !== null
    || ofType('rate_agreed').length > 0
    || ofType('scheduled').length > 0;

  const saidNo = intents.has('declined') || ofType('rejected').some(e => e.reason === 'declined');
  const saidYes = intents.has('interested') || status === 'followup_sent' || agreedToCall;
  const conflictRaised = intents.has('conflict') || status === 'conflict_flagged';

  const clientPassed = status === 'rejected_after_outreach'
    && !saidNo
    && stamp(pe.expertRemovedAt) === null
    && !bookingCancelled;

  // ── The call ──
  const liveBooking = bookedAtOnRecord !== null && !bookingCancelled;
  const completed   = status === 'completed';
  const callBooked  = liveBooking || completed;
  const firstBookedAt = callBooked
    ? (bookedAtOnRecord ?? earliest(ofType('scheduled').map(e => e.at)))
    : null;

  return {
    projectId,
    expertId,
    arm,
    introSentAt,
    bounced,
    complained,
    firstReplyAt,
    automaticReplyOnly,
    windowDeadline,
    windowClosed,
    repliedInWindow,
    saidYes,
    saidNo,
    countered,
    conflictRaised,
    agreedToCall,
    agreedAtOfferedRate: agreedToCall && !countered,
    clientPassed,
    clientPassReason: clientPassed ? (pe.rejectionReason ?? 'unspecified') : null,
    callBooked,
    firstBookedAt,
    completed,
    // A flag voided because the call ran past ten minutes was billed as usual.
    mismatchClaimed: stamp(pe.mismatchFlaggedAt) !== null && stamp(pe.mismatchVoidedAt) === null,
  };
}

/** Facts for every engagement, events and replies matched by (project, expert). */
export function deriveEngagementFacts(
  engagements: readonly StatsEngagement[],
  events:      readonly StatsEvent[],
  replies:     readonly StatsReplyMessage[],
  now:         number,
  zone:        string = OUTREACH_STATS_ZONE,
): EngagementFacts[] {
  const signals = groupSignals(events, replies);
  const none: Signals = { events: [], replies: [] };
  return engagements.map(e =>
    factsForEngagement(e, signals.get(keyOf(e.projectId, e.expertId)) ?? none, now, zone),
  );
}

// ─── Totals ───────────────────────────────────────────────────────────────────

/** The scoreboard numbers over a set of facts. Rows whose intro never went are ignored. */
export function summarizeOutreach(facts: readonly EngagementFacts[]): OutreachTotals {
  const sent = facts.filter(f => f.introSentAt !== null);
  const count = (pred: (f: EngagementFacts) => boolean): number => sent.filter(pred).length;

  const replies   = count(f => f.firstReplyAt !== null);
  const bounces   = count(f => f.bounced);
  const closed    = sent.filter(f => f.windowClosed);
  const passes    = sent.filter(f => f.clientPassed);

  const clientPassReasons: Record<string, number> = {};
  for (const f of passes) {
    const reason = f.clientPassReason ?? 'unspecified';
    clientPassReasons[reason] = (clientPassReasons[reason] ?? 0) + 1;
  }

  const waits = sent
    .filter(f => f.firstReplyAt !== null)
    .map(f => Math.max(0, (f.firstReplyAt as number) - (f.introSentAt as number)));

  return {
    introsSent:  sent.length,
    delivered:   sent.length - bounces,
    bounces,
    complaints:  count(f => f.complained),
    replies,
    replyRate:   ratio(replies, sent.length),
    repliesInWindow: count(f => f.repliedInWindow),
    inWindowRate:    ratio(closed.filter(f => f.repliedInWindow).length, closed.length),
    // A bounced intro is not waiting on anyone, so it is not "still in its window".
    stillInWindow:   count(f => !f.windowClosed && !f.repliedInWindow && !f.bounced),
    automaticReplies:    count(f => f.automaticReplyOnly),
    positiveReplies:     count(f => f.saidYes),
    counteredOnRate:     count(f => f.countered),
    conflictsRaised:     count(f => f.conflictRaised),
    agreedToCall:        count(f => f.agreedToCall),
    agreedAtOfferedRate: count(f => f.agreedAtOfferedRate),
    declines: {
      expertSaidNo: count(f => f.saidNo),
      clientPassed: passes.length,
      clientPassReasons,
    },
    medianTimeToFirstReplyMs: median(waits),
    callsBooked:    count(f => f.callBooked),
    completedCalls: count(f => f.completed),
    mismatchClaims: count(f => f.mismatchClaimed),
  };
}

/** The scoreboard by intro arm, and in total. */
export function outreachByArm(facts: readonly EngagementFacts[]): ArmSplit<OutreachTotals> {
  return {
    all:  summarizeOutreach(facts),
    arm1: summarizeOutreach(facts.filter(f => f.arm === 1)),
    arm2: summarizeOutreach(facts.filter(f => f.arm === 2)),
    unassigned: facts.filter(f => f.introSentAt !== null && f.arm === null).length,
  };
}

// ─── Test A ───────────────────────────────────────────────────────────────────

/**
 * Line 1, settled only when no open window can change it. The final rate (when
 * every window has closed) is at least `inWindow / sent` (replies only add) and
 * at most `(inWindow + stillOpen) / sent` (every open intro answers in time),
 * so the mark is 'pass' or 'fail' once the line sits outside that range, and
 * 'pending' while it sits inside. Integer arithmetic: 15 of 100 is a pass.
 */
function replyMark(inWindow: number, stillOpen: number, sent: number): TestAMark {
  if (sent === 0) return 'no_data';
  if (inWindow * 100 >= TEST_A_REPLY_LINE_PCT * sent) return 'pass';
  if ((inWindow + stillOpen) * 100 < TEST_A_REPLY_LINE_PCT * sent) return 'fail';
  return 'pending';
}

export function testAMarks(totals: OutreachTotals): TestAReadout {
  const agreedLine: TestAMark = totals.introsSent === 0
    ? 'no_data'
    : totals.agreedAtOfferedRate >= TEST_A_AGREED_LINE
      ? 'pass'
      // Below the line: still open while any reply window is, a miss once none is.
      : totals.stillInWindow > 0 ? 'pending' : 'fail';
  return {
    replyLine:         replyMark(totals.repliesInWindow, totals.stillInWindow, totals.introsSent),
    agreedLine,
  };
}

// ─── Per project ──────────────────────────────────────────────────────────────

/** One project's headline numbers, from that project's facts. */
export function summarizeProject(projectId: string, facts: readonly EngagementFacts[]): ProjectOutreachSummary {
  const sent = facts.filter(f => f.projectId === projectId && f.introSentAt !== null);
  const firstIntroAt  = earliest(sent.map(f => f.introSentAt));
  const firstBookedAt = earliest(sent.filter(f => f.callBooked).map(f => f.firstBookedAt));
  const bounces = sent.filter(f => f.bounced).length;
  return {
    projectId,
    introsSent:  sent.length,
    delivered:   sent.length - bounces,
    replies:     sent.filter(f => f.firstReplyAt !== null).length,
    callsBooked: sent.filter(f => f.callBooked).length,
    firstIntroAt,
    firstBookedAt,
    firstCallAfterMs: firstIntroAt !== null && firstBookedAt !== null
      ? Math.max(0, firstBookedAt - firstIntroAt)
      : null,
  };
}

/**
 * The client payload. Copies five numbers by name; everything else on the
 * summary (and anything added to it later) stays on the server.
 *
 * "Intros sent" for a client is the delivered count: an intro that could not
 * be delivered never reached anyone, and the thread already tells the client
 * so in plain words. The reply rate is over that same number, so the two
 * figures a client reads side by side agree with each other.
 */
export function toClientProjectStats(summary: ProjectOutreachSummary): ClientProjectStats {
  return {
    introsSent:       summary.delivered,
    replies:          summary.replies,
    replyRate:        summary.delivered > 0 ? summary.replies / summary.delivered : null,
    callsBooked:      summary.callsBooked,
    firstCallAfterMs: summary.firstCallAfterMs,
  };
}

// ─── Decline wording (staff) ──────────────────────────────────────────────────

/**
 * Matchy's one-line summary of every reply read as a no, for the engagements in
 * `facts` that really sent. Newest first, capped. STAFF ONLY: the summary is the
 * expert's position in Matchy's words, already screened for contact details.
 */
export function collectDeclineWords(
  facts:   readonly EngagementFacts[],
  replies: readonly StatsReplyMessage[],
  limit:   number = MAX_DECLINE_WORDS,
): DeclineWords[] {
  const inScope = new Set(facts.filter(f => f.introSentAt !== null).map(f => keyOf(f.projectId, f.expertId)));
  return replies
    .filter(r => r.intent === 'declined' && !!r.summary && inScope.has(keyOf(r.projectId, r.expertId)))
    .sort((a, b) => b.at - a.at)
    .slice(0, Math.max(0, limit))
    .map(r => ({ projectId: r.projectId, expertId: r.expertId, at: r.at, summary: r.summary as string }));
}

// ─── Paging ───────────────────────────────────────────────────────────────────

/** Rows per page: PostgREST's default max-rows on Supabase. */
export const STATS_PAGE_SIZE = 1000;

export interface CollectedPages<T> {
  rows:      T[];
  /** Stopped at `maxRows` with more rows still there. */
  truncated: boolean;
  /** A page failed; `rows` holds what came back before it. */
  failed:    boolean;
}

/**
 * Reads a query page by page until a short page, an error or `maxRows`. The
 * caller supplies the page (a Supabase builder with `.range(from, to)` and a
 * stable order); this module still does no I/O of its own. Never throws.
 */
export async function collectPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  maxRows: number = 20 * STATS_PAGE_SIZE,
  pageSize: number = STATS_PAGE_SIZE,
): Promise<CollectedPages<T>> {
  const rows: T[] = [];
  try {
    for (let from = 0; from < maxRows; from += pageSize) {
      const to = Math.min(from + pageSize, maxRows) - 1;
      const { data, error } = await fetchPage(from, to);
      if (error) return { rows, truncated: false, failed: true };
      const page = data ?? [];
      rows.push(...page);
      if (page.length < to - from + 1) return { rows, truncated: false, failed: false };
    }
    return { rows, truncated: true, failed: false };
  } catch {
    return { rows, truncated: false, failed: true };
  }
}

// ─── Labels ───────────────────────────────────────────────────────────────────

/** Staff-readable labels for the client pass reasons. */
export const CLIENT_PASS_REASON_LABEL: Readonly<Record<RejectionReason | 'unspecified', string>> = {
  too_generic:             'Too generic',
  wrong_industry:          'Wrong industry',
  wrong_geography:         'Wrong geography',
  weak_evidence:           'Weak evidence',
  no_contact_path:         'No contact path',
  conflict_risk:           'Conflict risk',
  not_senior_enough:       'Not senior enough',
  too_academic:            'Too academic',
  vendor_biased:           'Vendor biased',
  better_option_available: 'Better option available',
  other:                   'Other',
  unspecified:             'No reason given',
};
