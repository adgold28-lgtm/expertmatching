// scripts/test-billing-guard.ts — unit tests for the per-call billing identity
// (H-8, second half of C-4): the durable double-bill guard in
// lib/createAndSendInvoice.ts and the Stripe idempotency key in
// lib/chargeSavedCard.ts.
//
// Pure functions only: no Stripe, no database, no env vars needed.
//
//   npx tsx scripts/test-billing-guard.ts
//
// Exits non-zero on the first failing assertion set, so it can gate a deploy.

import {
  shouldSkipBilling,
  isRepeatCallForBilledRow,
  resolveCallId,
  type BillingGuardView,
} from '../lib/createAndSendInvoice';
import { chargeIdempotencyKey } from '../lib/chargeSavedCard';
import type { BookingState, ProjectExpert } from '../types';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const CALL_A = 'ics-uid-aaaa';   // first call's booking.icsUid
const CALL_B = 'ics-uid-bbbb';   // a genuine second call, booked later
const MANUAL = 'manual:aaaaaaaaaaaaaaaaaaaaaaaa:exp-1:1757000000000';

/** A row that has never been billed. */
const fresh: BillingGuardView = {};

/** The first call is in flight: the intent exists, the webhook has not landed. */
const inFlight: BillingGuardView = {
  paymentStatus:         'unpaid',
  stripePaymentIntentId: 'pi_first',
  billedCallId:          CALL_A,
};

/** The first call is paid. */
const paidA: BillingGuardView = {
  paymentStatus:         'paid',
  stripePaymentIntentId: 'pi_first',
  billedCallId:          CALL_A,
};

/** Pre-existing row from before billedCallId existed — no backfill, no migration. */
const legacyPaid: BillingGuardView = {
  paymentStatus:         'paid',
  stripePaymentIntentId: 'pi_legacy',
};

/** Legacy row that has an intent but no 'paid' yet. */
const legacyIntentOnly: BillingGuardView = { stripePaymentIntentId: 'pi_legacy' };

/** A manual completion that has already been billed. */
const paidManual: BillingGuardView = {
  paymentStatus: 'paid',
  billedCallId:  MANUAL,
};

function booking(uid: string): BookingState {
  return {
    startUtc:         '2026-09-10T15:00:00.000Z',
    endUtc:           '2026-09-10T16:00:00.000Z',
    durationMin:      60,
    zoomMeetingId:    '8888888888',
    icsUid:           uid,
    icsSequence:      0,
    bookedAt:         1_757_000_000_000,
    rescheduledCount: 0,
    history:          [],
  };
}

type CallIdView = Pick<ProjectExpert, 'booking' | 'zoomMeetingId' | 'callId'>;

// ── The first call ───────────────────────────────────────────────────────────

section('a call that has never been billed is billed');

eq('fresh row, booked call → charge',      shouldSkipBilling(fresh, CALL_A), false);
eq('fresh row, no call identity → charge', shouldSkipBilling(fresh, null),   false);
eq('unpaid with no intent → charge',
  shouldSkipBilling({ paymentStatus: 'unpaid' }, CALL_A), false);
eq('invoice_sent with no intent still re-runs (link can be regenerated)',
  shouldSkipBilling({ paymentStatus: 'invoice_sent', billedCallId: CALL_A }, CALL_A), false);
eq('failed payment with no intent → charge',
  shouldSkipBilling({ paymentStatus: 'failed' }, CALL_A), false);

// ── The same call, a second time (C-4: replay, redelivery, double-click) ─────

section('the same call is never billed twice, through any path');

eq('Zoom replay of the paid call → skip',      shouldSkipBilling(paidA, CALL_A), true);
eq('manual re-complete of the paid call → skip', shouldSkipBilling(paidA, CALL_A), true);
eq('charge in flight, webhook not yet landed → skip', shouldSkipBilling(inFlight, CALL_A), true);
eq('manual call re-completed → skip',          shouldSkipBilling(paidManual, MANUAL), true);
eq('a paid call is not a repeat call',         isRepeatCallForBilledRow(paidA, CALL_A), false);

// ── A genuine second call (H-8) ──────────────────────────────────────────────

section('a genuine second call with the same expert is billed');

eq('new booking uid on a paid row → charge',   shouldSkipBilling(paidA, CALL_B), false);
eq('new booking uid on an in-flight row → charge', shouldSkipBilling(inFlight, CALL_B), false);
eq('second call after a manual first → charge', shouldSkipBilling(paidManual, CALL_B), false);
eq('second call is flagged for the paid reset', isRepeatCallForBilledRow(paidA, CALL_B), true);
eq('a never-billed row needs no reset',         isRepeatCallForBilledRow(fresh, CALL_B), false);

// ── Migration-free compatibility with pre-existing rows ──────────────────────

section('legacy rows with no billedCallId are never re-billed');

eq('legacy paid row, call A → skip',    shouldSkipBilling(legacyPaid, CALL_A), true);
eq('legacy paid row, call B → skip',    shouldSkipBilling(legacyPaid, CALL_B), true);
eq('legacy paid row, no call id → skip', shouldSkipBilling(legacyPaid, null),  true);
eq('legacy intent-only row → skip',     shouldSkipBilling(legacyIntentOnly, CALL_B), true);
eq('explicit null billedCallId counts as legacy',
  shouldSkipBilling({ paymentStatus: 'paid', billedCallId: null }, CALL_B), true);
eq('legacy paid row is not treated as a repeat call',
  isRepeatCallForBilledRow(legacyPaid, CALL_B), false);
eq('an unidentifiable call on a billed row → skip (fail closed on money)',
  shouldSkipBilling(paidA, null), true);

// ── Resolving the call identity ──────────────────────────────────────────────

section('call identity: booking uid, then Zoom meeting id, then the manual id');

const booked: CallIdView = { booking: booking(CALL_A), zoomMeetingId: '8888888888' };
const zoomOnly: CallIdView = { booking: null, zoomMeetingId: '9999999999' };
const manualRow: CallIdView = { booking: null, zoomMeetingId: null, callId: MANUAL };
const nothing: CallIdView = { booking: null, zoomMeetingId: null };

eq('booking uid wins over the meeting id',   resolveCallId(booked),     CALL_A);
eq('no booking → the Zoom meeting id',       resolveCallId(zoomOnly),   '9999999999');
eq('neither → the persisted manual id',      resolveCallId(manualRow),  MANUAL);
eq('nothing identifies the call → null',     resolveCallId(nothing),    null);
eq('an explicitly passed id always wins',    resolveCallId(booked, MANUAL), MANUAL);
eq('the Zoom webhook passes nothing and still resolves',
  resolveCallId(booked, undefined), CALL_A);

// ── The Stripe idempotency key ───────────────────────────────────────────────

section('the Stripe key is scoped to the call, not the engagement');

const pid = 'aaaaaaaaaaaaaaaaaaaaaaaa';
eq('key carries the call id',
  chargeIdempotencyKey(pid, 'exp-1', CALL_A), `charge:${pid}:exp-1:${CALL_A}`);
check('key contains the call id',
  chargeIdempotencyKey(pid, 'exp-1', CALL_A).includes(CALL_A));
check('a second call gets a different key',
  chargeIdempotencyKey(pid, 'exp-1', CALL_A) !== chargeIdempotencyKey(pid, 'exp-1', CALL_B));
check('the same call gets the same key',
  chargeIdempotencyKey(pid, 'exp-1', CALL_A) === chargeIdempotencyKey(pid, 'exp-1', CALL_A));
check('a different expert gets a different key',
  chargeIdempotencyKey(pid, 'exp-1', CALL_A) !== chargeIdempotencyKey(pid, 'exp-2', CALL_A));
eq('no call identity → a stable fallback, never "undefined"',
  chargeIdempotencyKey(pid, 'exp-1', null), `charge:${pid}:exp-1:nocall`);
eq('undefined is the same fallback',
  chargeIdempotencyKey(pid, 'exp-1', undefined), `charge:${pid}:exp-1:nocall`);

// ── Result ───────────────────────────────────────────────────────────────────

summary();
