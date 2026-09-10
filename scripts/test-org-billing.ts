// scripts/test-org-billing.ts — unit tests for the pure parts of
// lib/orgBilling.ts plus an import-shape check on the two money-moving
// entry points added for organization deletion and late expert onboarding.
//
// Pure functions only: no Stripe, no database, no network, no env vars. The
// async functions are never CALLED here — only their exported shape is
// asserted, because calling them would talk to Stripe and Supabase.
//
//   npx tsx scripts/test-org-billing.ts
//
// Exits non-zero on the first failing assertion set, so it can gate a deploy.

import {
  orgCancelIdempotencyKey,
  stripeFailureReason,
  cancelOrgSubscription,
  syncOrgSeatQuantity,
  getOrgBillingRow,
  pickAdoptableSubscription,
  stripeIdTail,
  type AdoptableSubscriptionView,
} from '../lib/orgBilling';
import { retryPendingPayoutsForAccount, runExpertPayout } from '../lib/expertPayout';
import { findProjectExpertByZoomMeetingId } from '../lib/zoomLookup';
import { check, eq, summary } from './testHarness';

function section(title: string): void {
  console.log(`\n── ${title} ──`);
}

// ── Cancellation idempotency key ─────────────────────────────────────────────
// One deterministic key per org: a retried admin delete must never produce a
// second proration invoice.

section('orgCancelIdempotencyKey');

eq('key for an org id', orgCancelIdempotencyKey('org-abc'), 'org-cancel:org-abc');
eq('key is stable across calls',
  orgCancelIdempotencyKey('org-abc'), orgCancelIdempotencyKey('org-abc'));
check('different orgs get different keys',
  orgCancelIdempotencyKey('org-a') !== orgCancelIdempotencyKey('org-b'));
check('key does not collide with the seat-subscription key',
  !orgCancelIdempotencyKey('org-a').startsWith('seat-sub:'));

// ── Stripe failure reasons ───────────────────────────────────────────────────
// The reason is logged and shown to an admin, so it must carry no Stripe object
// ids (customer / subscription / account) — see the logging rules in
// lib/orgBilling.ts.

section('stripeFailureReason');

eq('prefers the Stripe error code',
  stripeFailureReason({ code: 'resource_missing', message: 'No such subscription: sub_1A2b3C' }),
  'resource_missing');

eq('redacts a subscription id from a bare message',
  stripeFailureReason(new Error('No such subscription: sub_1A2b3C')),
  'No such subscription: [id]');

eq('redacts a customer id',
  stripeFailureReason(new Error('Customer cus_ABC123 has no payment method')),
  'Customer [id] has no payment method');

eq('redacts a Connect account id',
  stripeFailureReason(new Error('acct_1XyZ is not enabled')),
  '[id] is not enabled');

eq('redacts several ids at once',
  stripeFailureReason(new Error('sub_A on cus_B failed')),
  '[id] on [id] failed');

check('leaves ordinary words that merely contain an id-like suffix alone',
  stripeFailureReason(new Error('websub_notify timed out')) === 'websub_notify timed out',
  stripeFailureReason(new Error('websub_notify timed out')));

eq('non-Error values stringify', stripeFailureReason('gateway down'), 'gateway down');
eq('empty message falls back', stripeFailureReason(new Error('')), 'stripe_error');
eq('null falls back to a stringified value', stripeFailureReason(null), 'null');

const long = stripeFailureReason(new Error('x'.repeat(400)));
check('reason is capped at 120 chars', long.length === 120, `got ${long.length}`);

check('code wins even when the message is empty',
  stripeFailureReason({ code: 'card_declined', message: '' }) === 'card_declined');

// ── Adopting an existing seat subscription (H-23) ────────────────────────────
// The create carries idempotency key `seat-sub:<orgId>`, which Stripe forgets
// after about 24 hours — the same interval the reconcile cron runs on. So if
// the row write after a create ever fails, the next night's sweep would create
// a SECOND live subscription for the same customer. Looking at what the
// customer already has, before creating, is the fix.

section('pickAdoptableSubscription');

const SEAT_PRICE = 'price_seat_tiered';
const OTHER_PRICE = 'price_something_else';

function sub(
  id: string,
  status: string,
  priceId: string | null,
): AdoptableSubscriptionView {
  return {
    id,
    status,
    items: { data: [{ id: `si_${id}`, price: priceId ? { id: priceId } : null, quantity: 3 }] },
  };
}

check('no subscriptions → create',
  pickAdoptableSubscription([], SEAT_PRICE) === null);

eq('an active seat subscription is adopted',
  pickAdoptableSubscription([sub('sub_1', 'active', SEAT_PRICE)], SEAT_PRICE)?.id, 'sub_1');

eq('a trialing one is adopted',
  pickAdoptableSubscription([sub('sub_2', 'trialing', SEAT_PRICE)], SEAT_PRICE)?.id, 'sub_2');

eq('a past_due one is adopted rather than duplicated',
  pickAdoptableSubscription([sub('sub_3', 'past_due', SEAT_PRICE)], SEAT_PRICE)?.id, 'sub_3');

eq('an incomplete one is adopted (it may still be paid)',
  pickAdoptableSubscription([sub('sub_4', 'incomplete', SEAT_PRICE)], SEAT_PRICE)?.id, 'sub_4');

check('a canceled one is NOT adopted',
  pickAdoptableSubscription([sub('sub_5', 'canceled', SEAT_PRICE)], SEAT_PRICE) === null);

check('an incomplete_expired one is NOT adopted',
  pickAdoptableSubscription([sub('sub_6', 'incomplete_expired', SEAT_PRICE)], SEAT_PRICE) === null);

check('a live subscription for a DIFFERENT price is not ours',
  pickAdoptableSubscription([sub('sub_7', 'active', OTHER_PRICE)], SEAT_PRICE) === null);

check('a subscription with no price on its line is not adopted',
  pickAdoptableSubscription([sub('sub_8', 'active', null)], SEAT_PRICE) === null);

eq('the live one is picked out of a mixed list',
  pickAdoptableSubscription(
    [sub('sub_9', 'canceled', SEAT_PRICE), sub('sub_10', 'active', SEAT_PRICE)],
    SEAT_PRICE,
  )?.id,
  'sub_10');

eq('the first live match wins when the customer already has two',
  pickAdoptableSubscription(
    [sub('sub_11', 'active', SEAT_PRICE), sub('sub_12', 'active', SEAT_PRICE)],
    SEAT_PRICE,
  )?.id,
  'sub_11');

eq('a multi-line subscription is adopted on its seat line',
  pickAdoptableSubscription(
    [{
      id:     'sub_13',
      status: 'active',
      items:  { data: [
        { id: 'si_a', price: { id: OTHER_PRICE }, quantity: 1 },
        { id: 'si_b', price: { id: SEAT_PRICE  }, quantity: 4 },
      ] },
    }],
    SEAT_PRICE,
  )?.id,
  'sub_13');

// ── Stripe id tails in system_events reasons ─────────────────────────────────
// A create whose row write failed is recorded so an operator can find the
// subscription — by its last four characters, never by the id itself.

section('stripeIdTail');

eq('last four characters', stripeIdTail('sub_1A2b3C4d'), '3C4d');
eq('a short id is returned whole', stripeIdTail('abc'), 'abc');
check('the tail is not the id',
  !`subscription_created_but_unrecorded:${stripeIdTail('sub_1A2b3C4d')}`.includes('sub_1A2b3C4d'));

// ── Import shape ─────────────────────────────────────────────────────────────
// These do real network work, so they are asserted, never invoked. A rename or
// a dropped export breaks the admin delete / the payout retry silently
// otherwise.

section('import shape');

eq('cancelOrgSubscription is a function', typeof cancelOrgSubscription, 'function');
eq('cancelOrgSubscription takes an organizationId', cancelOrgSubscription.length, 1);

eq('retryPendingPayoutsForAccount is a function', typeof retryPendingPayoutsForAccount, 'function');
eq('retryPendingPayoutsForAccount takes an accountId', retryPendingPayoutsForAccount.length, 1);

eq('runExpertPayout is still exported', typeof runExpertPayout, 'function');
eq('findProjectExpertByZoomMeetingId is a function', typeof findProjectExpertByZoomMeetingId, 'function');
eq('syncOrgSeatQuantity is still exported', typeof syncOrgSeatQuantity, 'function');
eq('getOrgBillingRow is still exported', typeof getOrgBillingRow, 'function');

// ── Result ───────────────────────────────────────────────────────────────────

summary();
