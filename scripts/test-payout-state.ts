// scripts/test-payout-state.ts — unit tests for the payout, refund and webhook
// de-duplication decisions (repair-plan brief W2-C: H-6, H-7, H-9, M-38).
//
// Pure functions only: no Stripe, no database, no network, no env vars. The
// money-moving functions themselves are never CALLED here; what is asserted is
// the decision layer they are built out of — which call a payout belongs to,
// whether it has already been sent, which two writes follow a transfer and in
// which order, when the onboarding reminder is allowed to go out again, whether
// a redelivered Stripe event runs, and what a refund does to the row.
//
//   npx tsx scripts/test-payout-state.ts
//
// Exits non-zero on the first failing assertion set, so it can gate a deploy.

import type { ProjectExpert } from '../types';
import {
  PAYOUT_REMINDER_CAP,
  PAYOUT_REMINDER_INTERVAL_MS,
  MAX_PAYOUT_ATTEMPTS,
  payoutCallId,
  payoutAlreadySent,
  nextPaidCallIds,
  shouldSendPayoutReminder,
  shouldRetryPayoutRow,
  payoutSuccessPatches,
  runExpertPayout,
  retryPendingPayoutsForAccount,
  type PayoutGuardView,
} from '../lib/expertPayout';
import {
  payoutIdempotencyKey,
  canReversePayout,
  reversedCallId,
  payoutReversalIdempotencyKey,
  type PayoutReversalView,
} from '../lib/stripeConnect';
import {
  decideEventDedup,
  decideRefundTransition,
  engagementRefFromMetadata,
  stripeEventKey,
  STRIPE_EVENT_TTL_SECONDS,
} from '../app/api/webhooks/stripe/handlers';
import { reverseExpertPayout as reverseExpertPayoutFn } from '../lib/stripeConnect';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

const CALL_A = 'ics-call-a@expertmatch.fit';
const CALL_B = 'ics-call-b@expertmatch.fit';
const ZOOM   = '8812345678';
const ACCT   = 'acct_TEST';
const DAY    = 24 * 60 * 60 * 1000;

// ── Which call a payout is for ───────────────────────────────────────────────
// The payout follows a client payment, so the call it pays for is the call the
// client was billed for: billedCallId first, then the same fallbacks the
// billing guard uses.

section('payoutCallId');

eq('billedCallId wins',
  payoutCallId({ billedCallId: CALL_A, zoomMeetingId: ZOOM } as PayoutGuardView), CALL_A);

eq('falls back to the booking uid',
  payoutCallId({ booking: { icsUid: CALL_B } } as unknown as PayoutGuardView), CALL_B);

eq('falls back to the Zoom meeting id',
  payoutCallId({ zoomMeetingId: ZOOM } as PayoutGuardView), ZOOM);

eq('falls back to the manual call id',
  payoutCallId({ callId: 'manual:p:e:1' } as PayoutGuardView), 'manual:p:e:1');

eq('nothing identifies the call', payoutCallId({} as PayoutGuardView), null);

// ── The durable per-call payout guard (H-6 / repeat calls) ───────────────────

section('payoutAlreadySent');

check('a fresh row is not paid',
  payoutAlreadySent({} as PayoutGuardView, CALL_A) === false);

check('this call is in paidCallIds → skip',
  payoutAlreadySent(
    { stripeTransferId: 'tr_1', paidCallIds: [CALL_A] } as PayoutGuardView, CALL_A) === true);

check('a DIFFERENT call on a row that lists its paid calls → pay',
  payoutAlreadySent(
    { stripeTransferId: 'tr_1', paidCallIds: [CALL_A] } as PayoutGuardView, CALL_B) === false);

check('legacy row: transfer id, no paidCallIds → skip whatever call is asked',
  payoutAlreadySent({ stripeTransferId: 'tr_1' } as PayoutGuardView, CALL_B) === true);

check('legacy row is skipped for a null call id too',
  payoutAlreadySent({ stripeTransferId: 'tr_1' } as PayoutGuardView, null) === true);

check('null call id on a row that has already transferred → skip (fail-closed)',
  payoutAlreadySent(
    { stripeTransferId: 'tr_1', paidCallIds: [CALL_A] } as PayoutGuardView, null) === true);

check('never transferred, unidentified call → still payable',
  payoutAlreadySent({ paidCallIds: [] } as PayoutGuardView, null) === false);

check('paidCallIds without a transfer id still blocks the same call',
  payoutAlreadySent({ paidCallIds: [CALL_A] } as PayoutGuardView, CALL_A) === true);

// ── The paid-call list ───────────────────────────────────────────────────────

section('nextPaidCallIds');

eq('appends to an empty list', nextPaidCallIds(undefined, CALL_A).join(','), CALL_A);
eq('appends a second call', nextPaidCallIds([CALL_A], CALL_B).join(','), `${CALL_A},${CALL_B}`);
eq('never duplicates', nextPaidCallIds([CALL_A], CALL_A).join(','), CALL_A);
eq('a null call id adds nothing', nextPaidCallIds([CALL_A], null).join(','), CALL_A);
eq('a null call id on an empty list stays empty', nextPaidCallIds(undefined, null).length, 0);

// ── Transfer idempotency key ─────────────────────────────────────────────────

section('payoutIdempotencyKey');

eq('carries the call id',
  payoutIdempotencyKey('p1', 'e1', CALL_A), `expert-payout:p1:e1:${CALL_A}`);

check('a second call gets a different key',
  payoutIdempotencyKey('p1', 'e1', CALL_A) !== payoutIdempotencyKey('p1', 'e1', CALL_B));

eq('an unidentified call keeps the legacy per-engagement key',
  payoutIdempotencyKey('p1', 'e1', null), 'expert-payout:p1:e1');

check('the key is stable for the same call',
  payoutIdempotencyKey('p1', 'e1', CALL_A) === payoutIdempotencyKey('p1', 'e1', CALL_A));

// ── H-6: transfer succeeded, write order ─────────────────────────────────────
// The bug: ONE try/catch wrapped both transfers.create and the write, so a
// failed write sent the row to 'failed' with the transfer id lost — an expert
// either never paid or paid twice. The transfer id must be written first, and
// alone.

section('payoutSuccessPatches');

const [moneyPatch, bookkeepingPatch] =
  payoutSuccessPatches('tr_99', ACCT, CALL_A, [CALL_B], 1_700_000_000_000);

eq('the first write carries the transfer id', moneyPatch.stripeTransferId, 'tr_99');
eq('the first write records the call as paid',
  (moneyPatch.paidCallIds ?? []).join(','), `${CALL_B},${CALL_A}`);
check('the first write carries NOTHING else',
  Object.keys(moneyPatch).sort().join(',') === 'paidCallIds,stripeTransferId',
  Object.keys(moneyPatch).join(','));

eq('the second write stamps the payout time', bookkeepingPatch.expertPaidAt, 1_700_000_000_000);
eq('the second write completes onboarding', bookkeepingPatch.expertOnboardingStatus, 'complete');
eq('the second write records the account', bookkeepingPatch.stripeConnectAccountId, ACCT);
check('the second write does NOT repeat the transfer id',
  bookkeepingPatch.stripeTransferId === undefined);

// A row written by the first patch is then seen as paid by the guard — this is
// the invariant that makes "transfer ok, second write failed" safe.
const afterMoneyWrite: PayoutGuardView = {
  stripeTransferId: moneyPatch.stripeTransferId,
  paidCallIds:      moneyPatch.paidCallIds,
};
check('after the first write alone, the same call is never paid again',
  payoutAlreadySent(afterMoneyWrite, CALL_A) === true);
check('after the first write alone, a genuine NEW call is still payable',
  payoutAlreadySent(afterMoneyWrite, 'ics-call-c@expertmatch.fit') === false);

// ── H-9: the onboarding reminder throttle ────────────────────────────────────

section('shouldSendPayoutReminder');

const NOW = 1_700_000_000_000;

check('never reminded → send', shouldSendPayoutReminder({}, NOW) === true);

check('reminded yesterday → hold',
  shouldSendPayoutReminder(
    { payoutReminderCount: 1, payoutReminderSentAt: NOW - DAY }, NOW) === false);

check('reminded six days ago → hold',
  shouldSendPayoutReminder(
    { payoutReminderCount: 1, payoutReminderSentAt: NOW - 6 * DAY }, NOW) === false);

check('reminded eight days ago → send',
  shouldSendPayoutReminder(
    { payoutReminderCount: 1, payoutReminderSentAt: NOW - 8 * DAY }, NOW) === true);

check('exactly at the interval → send',
  shouldSendPayoutReminder(
    { payoutReminderCount: 2, payoutReminderSentAt: NOW - PAYOUT_REMINDER_INTERVAL_MS }, NOW) === true);

check('the cap wins over the interval',
  shouldSendPayoutReminder(
    { payoutReminderCount: PAYOUT_REMINDER_CAP, payoutReminderSentAt: NOW - 400 * DAY }, NOW) === false);

check('the fourth reminder is the last one allowed',
  shouldSendPayoutReminder(
    { payoutReminderCount: PAYOUT_REMINDER_CAP - 1, payoutReminderSentAt: NOW - 8 * DAY }, NOW) === true);

check('a garbage timestamp does not block the reminder forever',
  shouldSendPayoutReminder(
    { payoutReminderCount: 1, payoutReminderSentAt: Number.NaN }, NOW) === true);

eq('the cap is four', PAYOUT_REMINDER_CAP, 4);
eq('the interval is seven days', PAYOUT_REMINDER_INTERVAL_MS, 7 * DAY);

// ── H-6: which rows a sweep revisits ─────────────────────────────────────────

section('shouldRetryPayoutRow');

check('a pending row is retried',
  shouldRetryPayoutRow({ expertOnboardingStatus: 'pending' }) === true);

check('a FAILED row is retried (it used to be terminal)',
  shouldRetryPayoutRow({ expertOnboardingStatus: 'failed' }) === true);

check('a completed row is not',
  shouldRetryPayoutRow({ expertOnboardingStatus: 'complete' }) === false);

check('a row with no payout status is not',
  shouldRetryPayoutRow({}) === false);

check('a row that already transferred is not',
  shouldRetryPayoutRow({ expertOnboardingStatus: 'pending', stripeTransferId: 'tr_1' }) === false);

check('a row under the attempt cap is retried',
  shouldRetryPayoutRow({
    expertOnboardingStatus: 'failed',
    payoutAttempts:         MAX_PAYOUT_ATTEMPTS - 1,
  }) === true);

check('a row at the attempt cap is not',
  shouldRetryPayoutRow({
    expertOnboardingStatus: 'failed',
    payoutAttempts:         MAX_PAYOUT_ATTEMPTS,
  }) === false);

check('a non-numeric attempt count counts as zero',
  shouldRetryPayoutRow({ expertOnboardingStatus: 'failed', payoutAttempts: 'lots' }) === true);

eq('the attempt cap is five', MAX_PAYOUT_ATTEMPTS, 5);

// ── Stripe webhook de-duplication ────────────────────────────────────────────

section('decideEventDedup');

eq('claimed the key → process', decideEventDedup('OK', true), 'process');
eq('key already existed → duplicate', decideEventDedup(null, true), 'duplicate');
eq('Redis unavailable → process (fail-open)', decideEventDedup(null, false), 'process');
eq('Redis unavailable with an OK is still process', decideEventDedup('OK', false), 'process');

eq('the key namespaces the event id', stripeEventKey('evt_123'), 'stripe-event:evt_123');
check('the key holds no PII', !stripeEventKey('evt_123').includes('@'));
eq('the id is remembered for a week', STRIPE_EVENT_TTL_SECONDS, 7 * 24 * 60 * 60);

// ── Engagement lookup from metadata ──────────────────────────────────────────

section('engagementRefFromMetadata');

const ref = engagementRefFromMetadata({ projectId: 'p1', expertId: 'e1' });
eq('reads the project id', ref?.projectId, 'p1');
eq('reads the expert id', ref?.expertId, 'e1');
eq('no metadata → null', engagementRefFromMetadata(null), null);
eq('half the metadata → null', engagementRefFromMetadata({ projectId: 'p1' }), null);
eq('empty strings → null', engagementRefFromMetadata({ projectId: '', expertId: 'e1' }), null);

// ── H-7: refunds and disputes ────────────────────────────────────────────────

section('decideRefundTransition');

const paidRefund = decideRefundTransition('paid', 'refund');
check('a paid call is written', paidRefund.write === true);
eq('the new state is refunded', paidRefund.paymentStatus, 'refunded');
eq('the reason names the refund', paidRefund.reason, 'refund_or_dispute:refund');

const disputed = decideRefundTransition('paid', 'dispute');
check('a dispute is written too', disputed.write === true);
eq('the reason names the dispute', disputed.reason, 'refund_or_dispute:dispute');

check('an already-refunded row is not written again',
  decideRefundTransition('refunded', 'refund').write === false);

check('an already-refunded row still raises the alert reason',
  decideRefundTransition('refunded', 'dispute').reason === 'refund_or_dispute:dispute');

check('a dispute on a row we never saw pay is still recorded',
  decideRefundTransition('unpaid', 'dispute').write === true);

check('an invoice_sent row moves too',
  decideRefundTransition('invoice_sent', 'refund').write === true);

check('a null status moves too', decideRefundTransition(null, 'refund').write === true);

// 'refunded' must be a legal ProjectExpert.paymentStatus — this is a compile
// -time assertion that types.ts carries the new union member.
const refundedRow: Pick<ProjectExpert, 'paymentStatus'> = { paymentStatus: 'refunded' };
eq('refunded is a valid paymentStatus', refundedRow.paymentStatus, 'refunded');

// ── Payout reversal (staff clawback, Wave 5 brief B3) ────────────────────────
// canReversePayout is the one decision both the admin console and
// POST /api/admin/payouts/reverse consult, so money never leaves an expert's
// account twice. Fails closed: anything it does not recognise is a refusal.
// FAILS ON OLD CODE: canReversePayout / reversedCallId /
// payoutReversalIdempotencyKey do not exist in lib/stripeConnect before Wave 5.

section('canReversePayout');

const PAID_ROW: PayoutReversalView = {
  stripeTransferId: 'tr_TEST',
  paidCallIds:      [CALL_A, CALL_B],
};

check('a paid, unreversed row is reversible', canReversePayout(PAID_ROW).ok === true);

const noTransfer = canReversePayout({ paidCallIds: [CALL_A] });
check('no transfer is refused', noTransfer.ok === false);
eq('  with reason no_transfer', noTransfer.ok === false ? noTransfer.reason : '', 'no_transfer');

const nullTransfer = canReversePayout({ stripeTransferId: null, expertPayoutReversedAt: null });
check('a null transfer id is refused too', nullTransfer.ok === false);

const twice = canReversePayout({ ...PAID_ROW, expertPayoutReversedAt: 1757000000000 });
check('an already-reversed row is refused', twice.ok === false);
eq('  with reason already_reversed', twice.ok === false ? twice.reason : '', 'already_reversed');

check('an empty row is refused (fails closed)', canReversePayout({}).ok === false);

section('reversedCallId');

eq('the most recent paid call is the one reversed', reversedCallId(PAID_ROW), CALL_B);
eq('a legacy row with no paidCallIds keeps the legacy key', reversedCallId({ stripeTransferId: 'tr_X' }), null);
eq('an empty paidCallIds is legacy too', reversedCallId({ paidCallIds: [] }), null);

section('payoutReversalIdempotencyKey');

eq('the reversal key is the payout key, prefixed',
  payoutReversalIdempotencyKey('proj_1', 'exp_1', CALL_B),
  `expert-payout-reversal:${payoutIdempotencyKey('proj_1', 'exp_1', CALL_B)}`);

check('two different calls on one engagement get different reversal keys',
  payoutReversalIdempotencyKey('proj_1', 'exp_1', CALL_A)
  !== payoutReversalIdempotencyKey('proj_1', 'exp_1', CALL_B));

check('two engagements get different reversal keys',
  payoutReversalIdempotencyKey('proj_1', 'exp_1', CALL_A)
  !== payoutReversalIdempotencyKey('proj_2', 'exp_1', CALL_A));

check('the reversal key never collides with the payout key it reverses',
  payoutReversalIdempotencyKey('proj_1', 'exp_1', CALL_A)
  !== payoutIdempotencyKey('proj_1', 'exp_1', CALL_A));

// A ProjectExpert must satisfy the narrow reversal view structurally, and must
// carry the two fields the route stamps.
const reversedRow: Pick<ProjectExpert, 'expertPayoutReversedAt' | 'stripeTransferReversalId'> = {
  expertPayoutReversedAt:   1757000000000,
  stripeTransferReversalId: 'trr_TEST',
};
check('ProjectExpert carries the reversal stamps',
  reversedRow.expertPayoutReversedAt === 1757000000000);

// ── Import shape ─────────────────────────────────────────────────────────────
// These do real network work, so they are asserted, never invoked.

section('import shape');

eq('runExpertPayout is still exported', typeof runExpertPayout, 'function');
eq('retryPendingPayoutsForAccount is still exported', typeof retryPendingPayoutsForAccount, 'function');

eq('reverseExpertPayout is exported', typeof reverseExpertPayoutFn, 'function');

// ── Result ───────────────────────────────────────────────────────────────────

summary();
