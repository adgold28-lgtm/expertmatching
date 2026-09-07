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
} from '../lib/orgBilling';
import { retryPendingPayoutsForAccount, runExpertPayout } from '../lib/expertPayout';
import { findProjectExpertByZoomMeetingId } from '../lib/zoomLookup';

let failures = 0;
let checks   = 0;

function check(name: string, ok: boolean, detail = ''): void {
  checks++;
  if (!ok) {
    failures++;
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function eq<T>(name: string, actual: T, expected: T): void {
  check(name, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

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

console.log(`\n${failures === 0 ? 'PASS' : 'FAIL'} — ${checks - failures}/${checks} checks passed`);
process.exit(failures === 0 ? 0 : 1);
