// scripts/test-zoom-webhook.ts — unit tests for the pure decisions inside
// app/api/webhooks/zoom/meetingEnd.ts, the pure half of the Zoom webhook: is
// this signed delivery fresh enough to act on (the replay window, C-4), what
// does meeting.ended mean for a row that may already be completed or may carry
// no usable duration (C-4, M-35), and — Wave 5 — who actually turned up
// (classifyParticipant / resolveAttendance), which is what decides whether a
// finished meeting is billed, refunded to silence, or held for staff review.
//
// Pure functions only: no Zoom, no Stripe, no database, no network. The route
// handler itself is never imported or called here.
//
//   npx tsx scripts/test-zoom-webhook.ts
//
// Exits non-zero when any assertion fails, so it can gate a deploy.

import {
  ZOOM_TIMESTAMP_TOLERANCE_SEC,
  classifyParticipant,
  isFreshTimestamp,
  resolveAttendance,
  resolveMeetingEnd,
  type MeetingEndRow,
} from '../app/api/webhooks/zoom/meetingEnd';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// A fixed clock so every case is deterministic.
const NOW  = Date.parse('2026-09-09T15:00:00.000Z');   // unix ms
const NOWS = Math.floor(NOW / 1000);                   // unix seconds, as Zoom sends

// ── The replay window ────────────────────────────────────────────────────────
// The header is Unix SECONDS. A signature never expires on its own, so this is
// the only thing standing between a captured body and a second charge.

section('isFreshTimestamp: the five-minute window');

eq('tolerance is five minutes',        ZOOM_TIMESTAMP_TOLERANCE_SEC, 300);
eq('same second is fresh',             isFreshTimestamp(String(NOWS), NOW), true);
eq('one minute old is fresh',          isFreshTimestamp(String(NOWS - 60), NOW), true);
eq('exactly five minutes old is fresh', isFreshTimestamp(String(NOWS - 300), NOW), true);
eq('six minutes old is stale',         isFreshTimestamp(String(NOWS - 360), NOW), false);
eq('a day old is stale',               isFreshTimestamp(String(NOWS - 86400), NOW), false);
eq('six minutes in the future is stale', isFreshTimestamp(String(NOWS + 360), NOW), false);
eq('a few seconds of clock skew ahead is fresh', isFreshTimestamp(String(NOWS + 5), NOW), true);
eq('garbage is stale',                 isFreshTimestamp('not-a-timestamp', NOW), false);
eq('empty header is stale',            isFreshTimestamp('', NOW), false);
eq('missing header is stale',          isFreshTimestamp(null, NOW), false);
eq('undefined header is stale',        isFreshTimestamp(undefined, NOW), false);
eq('whitespace is stale',              isFreshTimestamp('   ', NOW), false);
eq('milliseconds pasted as seconds are stale', isFreshTimestamp(String(NOW), NOW), false);
eq('surrounding whitespace still parses', isFreshTimestamp(` ${NOWS} `, NOW), true);

// ── meeting.ended ────────────────────────────────────────────────────────────

const started = '2026-09-09T14:00:00Z';
const ended47 = '2026-09-09T14:47:00Z';

/** Convenience: the duration a non-skipped resolution decided on, else null. */
function durationOf(r: ReturnType<typeof resolveMeetingEnd>): number | null {
  return r.skip ? null : r.actualDurationMin;
}
/** Convenience: the skip reason, else null. */
function reasonOf(r: ReturnType<typeof resolveMeetingEnd>): string | null {
  return r.skip ? r.reason : null;
}

const scheduledRow: MeetingEndRow = { status: 'scheduled', zoomMeetingEndedAt: null, booking: null };

section('resolveMeetingEnd: the normal call');

const normal = resolveMeetingEnd({ start_time: started, end_time: ended47 }, NOW, scheduledRow);
eq('a 47-minute call is not skipped', normal.skip, false);
eq('a 47-minute call bills 47 minutes', durationOf(normal), 47);
eq('endedAt is the caller clock',      normal.skip ? null : normal.endedAt, NOW);
eq('a 46m30s call rounds up to 47',
  durationOf(resolveMeetingEnd({ start_time: started, end_time: '2026-09-09T14:46:30Z' }, NOW, scheduledRow)), 47);
eq('a zero-length call still bills the 1-minute floor',
  durationOf(resolveMeetingEnd({ start_time: started, end_time: started }, NOW, scheduledRow)), 1);
eq('a missing end_time falls back to now',
  durationOf(resolveMeetingEnd({ start_time: '2026-09-09T14:30:00Z' }, NOW, scheduledRow)), 30);
eq('an unparseable end_time falls back to now',
  durationOf(resolveMeetingEnd({ start_time: '2026-09-09T14:30:00Z', end_time: 'soon' }, NOW, scheduledRow)), 30);
eq('a row we have never seen (no pe) still resolves',
  durationOf(resolveMeetingEnd({ start_time: started, end_time: ended47 }, NOW, undefined)), 47);
eq('a null row still resolves',
  durationOf(resolveMeetingEnd({ start_time: started, end_time: ended47 }, NOW, null)), 47);

section('resolveMeetingEnd: the completion guard (a redelivery is a no-op)');

const alreadyEnded: MeetingEndRow = { status: 'scheduled', zoomMeetingEndedAt: NOW - 60_000 };
eq('an already-ended row is skipped',
  resolveMeetingEnd({ start_time: started, end_time: ended47 }, NOW, alreadyEnded).skip, true);
eq('…with reason already_ended',
  reasonOf(resolveMeetingEnd({ start_time: started, end_time: ended47 }, NOW, alreadyEnded)), 'already_ended');
eq('a completed row is skipped',
  resolveMeetingEnd({ start_time: started, end_time: ended47 }, NOW, { status: 'completed' }).skip, true);
eq('…with reason already_completed',
  reasonOf(resolveMeetingEnd({ start_time: started, end_time: ended47 }, NOW, { status: 'completed' })), 'already_completed');
eq('the guard runs before any arithmetic, so a garbage payload is still just a skip',
  reasonOf(resolveMeetingEnd({}, NOW, { status: 'completed' })), 'already_completed');
eq('zoomMeetingEndedAt: 0 is not a completion',
  resolveMeetingEnd({ start_time: started, end_time: ended47 }, NOW, { zoomMeetingEndedAt: 0 }).skip, false);

section('resolveMeetingEnd: never NaN (M-35)');

const booked60: MeetingEndRow = { status: 'scheduled', booking: { durationMin: 60 } };

const missingStart = resolveMeetingEnd({ end_time: ended47 }, NOW, booked60);
eq('a missing start_time falls back to the booked duration', durationOf(missingStart), 60);
eq('…and is not skipped',                                    missingStart.skip, false);
eq('an unparseable start_time falls back to the booked duration',
  durationOf(resolveMeetingEnd({ start_time: 'yesterday', end_time: ended47 }, NOW, booked60)), 60);
eq('a null start_time falls back to the booked duration',
  durationOf(resolveMeetingEnd({ start_time: null, end_time: ended47 }, NOW, booked60)), 60);
eq('no start_time and no booking → skip',
  reasonOf(resolveMeetingEnd({ end_time: ended47 }, NOW, scheduledRow)), 'no_duration');
eq('no start_time and no row at all → skip',
  reasonOf(resolveMeetingEnd({}, NOW, undefined)), 'no_duration');
eq('a booking with a zero duration is not a duration',
  reasonOf(resolveMeetingEnd({}, NOW, { booking: { durationMin: 0 } })), 'no_duration');
eq('a booking with a null duration is not a duration',
  reasonOf(resolveMeetingEnd({}, NOW, { booking: { durationMin: null } })), 'no_duration');

// The point of the whole section: nothing that leaves this function can be NaN.
const nanProbes = [
  resolveMeetingEnd({ start_time: 'yesterday', end_time: 'tomorrow' }, NOW, booked60),
  resolveMeetingEnd({ start_time: started, end_time: 'tomorrow' }, NOW, scheduledRow),
  resolveMeetingEnd({ start_time: started, end_time: ended47 }, NOW, scheduledRow),
];
check('no resolution ever carries a NaN duration',
  nanProbes.every(r => r.skip || Number.isFinite(r.actualDurationMin)),
  nanProbes.map(r => String(durationOf(r))).join(', '));

// ── Attendance: who joined (Wave 5) ──────────────────────────────────────────
// The only evidence of a no-show, and a no-show is billable, so every one of
// these is a money decision.

section('classifyParticipant: matching a Zoom participant to a side of the call');

const IDS = {
  expertEmail: 'Expert@Example.com',
  ownerEmail:  'Owner@Firm.com',
  clientEmail: 'Client@Firm.com',
};

eq('the expert\'s own address is the expert',
  classifyParticipant({ email: 'expert@example.com' }, IDS), 'expert');
eq('case and padding do not matter',
  classifyParticipant({ email: '  EXPERT@EXAMPLE.COM ' }, IDS), 'expert');
eq('the project owner is the client',
  classifyParticipant({ email: 'owner@firm.com' }, IDS), 'client');
eq('the client contact is the client too',
  classifyParticipant({ email: 'client@firm.com' }, IDS), 'client');
eq('a stranger is unknown',
  classifyParticipant({ email: 'someone@else.com' }, IDS), 'unknown');
eq('no email and no host flag is unknown',
  classifyParticipant({ user_name: 'Guest' }, IDS), 'unknown');
eq('a missing participant is unknown',
  classifyParticipant(undefined, IDS), 'unknown');
eq('a null participant is unknown',
  classifyParticipant(null, IDS), 'unknown');
eq('the host with no address is the expert',
  classifyParticipant({ role: 'host' }, IDS), 'expert');
eq('Zoom\'s numeric host role counts too',
  classifyParticipant({ role: 1 }, IDS), 'expert');
eq('the boolean host flag counts too',
  classifyParticipant({ host: true }, IDS), 'expert');
eq('the CLIENT joining as host is still the client',
  classifyParticipant({ email: 'owner@firm.com', role: 'host' }, IDS), 'client');
eq('with no identities on file, an address matches nothing',
  classifyParticipant({ email: 'expert@example.com' }, {}), 'unknown');
eq('empty identities never match an empty address',
  classifyParticipant({ email: '' }, { expertEmail: '', ownerEmail: '' }), 'unknown');
eq('a non-string email is ignored',
  classifyParticipant({ email: 12345 }, IDS), 'unknown');

section('resolveAttendance: the verdict on a finished meeting');

eq('both joined → both',
  resolveAttendance({ expertJoined: true, clientJoined: true }), 'both');
eq('expert only → the client did not show',
  resolveAttendance({ expertJoined: true, clientJoined: false }), 'client_no_show');
eq('expert only, client flag absent → the client did not show',
  resolveAttendance({ expertJoined: true }), 'client_no_show');
eq('client only → the expert did not show',
  resolveAttendance({ clientJoined: true }), 'expert_no_show');
eq('neither flag set → unknown, never a no-show',
  resolveAttendance({ expertJoined: false, clientJoined: false }), 'unknown');
eq('an empty record → unknown',        resolveAttendance({}), 'unknown');
eq('no telemetry at all → unknown',    resolveAttendance(undefined), 'unknown');
eq('a null record → unknown',          resolveAttendance(null), 'unknown');

// The point of the section: silence is never chargeable. A row with no
// participant data can only ever be 'unknown', which the webhook parks for
// staff review rather than billing.
check('missing telemetry never resolves to a billable no-show',
  [undefined, null, {}, { expertJoined: false }, { clientJoined: false }]
    .every(a => resolveAttendance(a) === 'unknown'),
  'all unknown');
check('only a POSITIVE expert-joined can produce a client no-show',
  resolveAttendance({ clientJoined: false }) !== 'client_no_show',
  resolveAttendance({ clientJoined: false }));

// ── Result ───────────────────────────────────────────────────────────────────

summary();
