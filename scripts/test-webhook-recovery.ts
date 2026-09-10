// scripts/test-webhook-recovery.ts — regression tests for the second round of
// the September 2026 Stripe/security review (the findings raised in an
// independent Codex review, verified against this code and fixed here).
//
// Pure functions and one mocked HTTP boundary: no live Supabase, no Stripe.
//
//   npx tsx scripts/test-webhook-recovery.ts
//
// What it proves:
//   A1  a Checkout Session that is merely `completed` is not money
//   A2  no payout without a persisted paid state and a current entitlement
//   A3  the one account-status policy middleware and the route guards share
//   A4  the verified user is fetched once per request, never reused across two
//
// The webhook's retry behaviour (a failed durable write must answer 500, not
// 200) is exercised end-to-end rather than here — see the note at the bottom.

import { checkoutSessionSettled, isPermanentFailure } from '../lib/stripeEvents';
import { payoutBlockReason } from '../lib/expertPayout';
import { statusMayUseProduct } from '../lib/auth';

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

// ─── A1. `completed` is not `paid` ────────────────────────────────────────────

section('checkoutSessionSettled — a finished session is not a paid one');

check('paid settles',                 checkoutSessionSettled('paid'));
check('no_payment_required settles',  checkoutSessionSettled('no_payment_required'));
check('unpaid does NOT settle',      !checkoutSessionSettled('unpaid'));
check('a delayed method does NOT settle before it clears',
                                     !checkoutSessionSettled('unpaid'));
check('an unknown status does NOT settle', !checkoutSessionSettled('weird_new_status'));
check('null does NOT settle',        !checkoutSessionSettled(null));
check('undefined does NOT settle',   !checkoutSessionSettled(undefined));

// ─── A1b. A permanent failure must not become an endless retry ────────────────

section('isPermanentFailure — retry the transient, acknowledge the impossible');

check('a deleted project is permanent',
  isPermanentFailure(new Error('Project not found: 65f1a2b3c4d5e6f7a8b9c0d1')));
check('a deleted engagement is permanent',
  isPermanentFailure(new Error('Expert not found: exp-a')));
check('a store timeout is TRANSIENT and must be retried',
  !isPermanentFailure(new Error('fetch failed: ETIMEDOUT')));
check('a write conflict is TRANSIENT',
  !isPermanentFailure(new Error('expert_update_conflict')));
check('an unknown failure is TRANSIENT (fail toward redelivery)',
  !isPermanentFailure(new Error('something else went wrong')));
check('a non-Error rejection is TRANSIENT', !isPermanentFailure('boom'));

// ─── A2. No payout without money ──────────────────────────────────────────────

section('payoutBlockReason — the gate the retry sweep never had');

const paid    = { paymentStatus: 'paid'   as const, stripeTransferId: undefined };
const unpaid  = { paymentStatus: 'unpaid' as const, stripeTransferId: undefined };
const failed  = { paymentStatus: 'failed' as const, stripeTransferId: undefined };
const invoice = { paymentStatus: 'invoice_sent' as const, stripeTransferId: undefined };
const unset   = { paymentStatus: undefined, stripeTransferId: undefined };

eq('a paid, entitled call pays out',        payoutBlockReason(paid, true), null);
eq('an unpaid call never pays out',         payoutBlockReason(unpaid, true), 'unpaid');
eq('a declined card never pays out',        payoutBlockReason(failed, true), 'unpaid');
eq('an unpaid invoice never pays out',      payoutBlockReason(invoice, true), 'unpaid');
eq('a missing payment state never pays out', payoutBlockReason(unset, true), 'unpaid');

// The exact abuse the retry sweep enabled: an expert finishes Stripe onboarding
// weeks after a call the client never paid for. account.updated fires, the
// sweep re-enters runExpertPayout — and used to transfer platform money.
eq('the late-onboarding sweep cannot pay an unpaid call',
  payoutBlockReason(unpaid, true), 'unpaid');

eq('a trial org never causes a payout',     payoutBlockReason(paid, false), 'not_entitled');
eq('an unpaid trial call is blocked too',   payoutBlockReason(unpaid, false), 'unpaid');
eq('an already-transferred call is a no-op',
  payoutBlockReason({ paymentStatus: 'paid', stripeTransferId: 'tr_1' }, true), 'already_paid_out');
eq('already-paid-out wins over every other reason',
  payoutBlockReason({ paymentStatus: 'unpaid', stripeTransferId: 'tr_1' }, false), 'already_paid_out');

// ─── A3. One account-status policy ────────────────────────────────────────────

section('statusMayUseProduct — middleware and the route guards agree');

check('active may use the product',   statusMayUseProduct('active'));
check('pending may NOT',             !statusMayUseProduct('pending'));
check('disabled may NOT',            !statusMayUseProduct('disabled'));
check('a legacy missing status is allowed (documented, not tightened here)',
  statusMayUseProduct(undefined));

// ─── A4. One verification per request ─────────────────────────────────────────

async function authCacheChecks(): Promise<void> {
section('getSupabaseSessionUser — one auth call per request, never shared');

process.env.NEXT_PUBLIC_SUPABASE_URL = 'https://stub.supabase.co';
process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY = 'stub-publishable-key';
// routeAuthGuard/getSessionUser short-circuit when auth is off (dev default).
process.env.APP_AUTH_ENABLED = 'true';

const { getSupabaseSessionUser, routeAuthGuard, getSessionUser } = await import('../lib/auth');
const { NextRequest } = await import('next/server');
const { PUBLIC_PATHS: MIDDLEWARE_PUBLIC_PATHS } = await import('../middleware');

/**
 * Counts VERIFICATION ATTEMPTS, not HTTP calls. Every attempt builds a Supabase
 * server client and hands it this request's cookies, so `getAll` firing is
 * exactly "we went and verified again" — true whether or not a session is
 * present, which keeps the test free of a hand-rolled session fixture.
 */
function countingRequest(): { request: InstanceType<typeof NextRequest>; verifications: () => number } {
  const request = new NextRequest('https://example.test/api/auth/me');
  let n = 0;
  const realGetAll = request.cookies.getAll.bind(request.cookies);
  (request.cookies as { getAll: () => unknown }).getAll = () => { n++; return realGetAll(); };
  return { request, verifications: () => n };
}

// One verification costs a fixed number of cookie reads; measure it rather
// than hard-coding Supabase's internals.
const baseline = countingRequest();
await getSupabaseSessionUser(baseline.request);
const PER_VERIFICATION = baseline.verifications();
check('a verification is observable at all', PER_VERIFICATION > 0);

const a = countingRequest();
await getSupabaseSessionUser(a.request);
await getSupabaseSessionUser(a.request);
eq('two lookups on one request verify once', a.verifications(), PER_VERIFICATION);

// The real shape of the saving: a handler that guards, then reads the user.
const b = countingRequest();
await routeAuthGuard(b.request);
await getSessionUser(b.request);
eq('guard + session read on one request verify once', b.verifications(), PER_VERIFICATION);

// Concurrent callers within one request share the in-flight promise.
const c = countingRequest();
await Promise.all([
  getSupabaseSessionUser(c.request),
  getSupabaseSessionUser(c.request),
  getSupabaseSessionUser(c.request),
]);
eq('three concurrent lookups on one request verify once', c.verifications(), PER_VERIFICATION);

// The safety property: a DIFFERENT request always re-verifies, so a revoked
// session can never ride the cache. This is why the key is the request object.
const d = countingRequest();
const e = countingRequest();
await getSupabaseSessionUser(d.request);
await getSupabaseSessionUser(e.request);
eq('a new request always re-verifies (d)', d.verifications(), PER_VERIFICATION);
eq('a new request always re-verifies (e)', e.verifications(), PER_VERIFICATION);

// A blocked session must still be able to sign out: PUBLIC_PATHS come through
// the status gate, so /login renders and /api/auth/logout clears the cookie
// instead of 403-ing the person it is blocking (middleware.ts).
check('/login is public, so a blocked session is never trapped there',
  MIDDLEWARE_PUBLIC_PATHS.has('/login'));
check('/api/auth/logout is public, so a blocked session can always sign out',
  MIDDLEWARE_PUBLIC_PATHS.has('/api/auth/logout'));
}

// ─── Not covered here ─────────────────────────────────────────────────────────
//
// The webhook retry fix (a failed updateExpertStatus must answer 500 so Stripe
// redelivers, instead of the old swallow-and-200) is a route-level behaviour:
// it needs the projectStore boundary mocked, which pulls the Supabase service
// client. It is verified by reading the branch wiring in
// app/api/webhooks/stripe/route.ts and is listed as unvalidated-by-test in
// SECURITY_AUDIT.md rather than claimed as covered.

async function main(): Promise<void> {
  await authCacheChecks();
  console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILED`} (${checks} checks)`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
