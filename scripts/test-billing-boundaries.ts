// scripts/test-billing-boundaries.ts — unit tests for the money boundaries a
// Stripe security review of this repo turned up (September 2026).
//
// Pure functions only: no network, no database, no Stripe.
//
//   npx tsx scripts/test-billing-boundaries.ts
//
// What it proves:
//   1. Payment state is server-owned. Every field that decides whether a call
//      was billed is in SERVER_OWNED_FIELDS and in neither writable tier, so
//      the paying client cannot send { paymentStatus: 'paid' } and walk past
//      lib/createAndSendInvoice.ts's double-bill guard uncharged.
//   2. An agreed rate is locked on BOTH sides of the conversion. The lock used
//      to sit only on the clientRate branch of the expert PUT, leaving
//      `expertRate` as a way to rewrite what the card is charged after the
//      engagement was settled.
//   3. A Zoom-derived call length is bounded. It cannot be NaN, cannot be
//      negative, and cannot exceed MAX_BILLABLE_MINUTES — the ceiling the
//      manual completion route already enforced.

import {
  COLLABORATOR_FIELDS,
  OWNER_ONLY_FIELDS,
  SERVER_OWNED_FIELDS,
  serverOwnedFieldsIn,
} from '../lib/expertWriteFields';
import { isRateLocked } from '../lib/matchyIntent';
import {
  billableCallMinutesFromWindow,
  callChargeDollars,
  MAX_BILLABLE_MINUTES,
} from '../lib/pricing';
import type { ExpertStatus } from '../types';

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

// ─── 1. Payment state is nobody's to send ─────────────────────────────────────

section('SERVER_OWNED_FIELDS — the fields that decide whether a call was billed');

const MUST_BE_SERVER_OWNED = [
  'paymentStatus',          // the double-bill guard reads this
  'stripePaymentIntentId',  // and this
  'paidAt',
  'invoiceAmount',
  'callDurationMin',        // feeds the payout the Stripe webhook computes
  'stripePaymentLinkId',
  'stripePaymentLinkUrl',
];

for (const field of MUST_BE_SERVER_OWNED) {
  check(`${field} is server-owned`, SERVER_OWNED_FIELDS.includes(field));
  check(`${field} is not collaborator-writable`, !COLLABORATOR_FIELDS.has(field));
  check(`${field} is not owner-writable`, !OWNER_ONLY_FIELDS.includes(field));
}

check('the writable tiers do not overlap',
  OWNER_ONLY_FIELDS.every(f => !COLLABORATOR_FIELDS.has(f)));

// The rates stay writable — setting a rate is the owner's job, and the fix must
// not have taken that away.
check('clientRate is still owner-writable', OWNER_ONLY_FIELDS.includes('clientRate'));
check('expertRate is still owner-writable', OWNER_ONLY_FIELDS.includes('expertRate'));

section('serverOwnedFieldsIn — what a body is actually trying to write');

eq('a note-only body writes nothing server-owned',
  serverOwnedFieldsIn({ userNotes: 'good call' }).length, 0);
eq('an explicit undefined is not an attempt to write',
  serverOwnedFieldsIn({ paymentStatus: undefined }).length, 0);
eq('the free-call payload is caught',
  serverOwnedFieldsIn({ paymentStatus: 'paid' })[0], 'paymentStatus');
eq('null is an attempt to write, and is caught',
  serverOwnedFieldsIn({ paidAt: null })[0], 'paidAt');
eq('a forged intent id is caught',
  serverOwnedFieldsIn({ stripePaymentIntentId: 'pi_forged' })[0], 'stripePaymentIntentId');
eq('a post-charge duration bump is caught',
  serverOwnedFieldsIn({ callDurationMin: 480 })[0], 'callDurationMin');
eq('every server-owned field in one body is reported',
  serverOwnedFieldsIn({ paymentStatus: 'paid', paidAt: 1, invoiceAmount: 0 }).length, 3);

// ─── 2. An agreed rate does not move ──────────────────────────────────────────

section('isRateLocked — the lock the expertRate branch was missing');

const locked: Array<{ status: ExpertStatus; rateAgreedAt?: number | null }> = [
  { status: 'scheduling_sent' },
  { status: 'scheduled' },
  { status: 'completed' },
  { status: 'contacted', rateAgreedAt: Date.now() },
];
for (const pe of locked) {
  check(`locked at ${pe.status}${pe.rateAgreedAt ? ' (rate agreed)' : ''}`, isRateLocked(pe));
}

const open_: Array<{ status: ExpertStatus; rateAgreedAt?: number | null }> = [
  { status: 'bookmarked' },
  { status: 'contacted' },
  { status: 'followup_sent', rateAgreedAt: null },
];
for (const pe of open_) {
  check(`still negotiable at ${pe.status}`, !isRateLocked(pe));
}

// ─── 3. A Zoom-derived call length is bounded ─────────────────────────────────

section('billableCallMinutesFromWindow — the duration that becomes a charge');

const t0  = Date.parse('2026-09-10T14:00:00.000Z');
const now = t0 + 45 * 60_000;

eq('a 45-minute meeting is 45 minutes',
  billableCallMinutesFromWindow(t0, t0 + 45 * 60_000, now), 45);
eq('a missing end_time falls back to now',
  billableCallMinutesFromWindow(t0, null, now), 45);
eq('an unparseable end_time falls back to now',
  billableCallMinutesFromWindow(t0, NaN, now), 45);
eq('an unparseable start_time is one minute, never NaN',
  billableCallMinutesFromWindow(NaN, t0 + 45 * 60_000, now), 1);
eq('an end before the start never goes negative',
  billableCallMinutesFromWindow(t0, t0 - 60 * 60_000, now), 1);
eq('a meeting left open all week is clamped to the ceiling',
  billableCallMinutesFromWindow(t0, t0 + 7 * 24 * 60 * 60_000, now), MAX_BILLABLE_MINUTES);
eq('a replayed event with a stale start is clamped too',
  billableCallMinutesFromWindow(t0 - 30 * 24 * 60 * 60_000, null, now), MAX_BILLABLE_MINUTES);
eq('the ceiling itself is allowed exactly',
  billableCallMinutesFromWindow(t0, t0 + MAX_BILLABLE_MINUTES * 60_000, now), MAX_BILLABLE_MINUTES);

section('the clamp bounds the charge, not just the number');

// $800/hr to the expert → $1,600/hr to the client. Eight hours is the most the
// card can be asked for off one meeting.event, whatever Zoom reports.
const worstCase = callChargeDollars(800, billableCallMinutesFromWindow(t0, t0 + 7 * 24 * 60 * 60_000, now));
eq('an eight-day meeting bills eight hours, not eight days', worstCase, 1600 * 8);
check('the unclamped number would have been far larger',
  callChargeDollars(800, 7 * 24 * 60) > worstCase);

// ─── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILED`} (${checks} checks)`);
process.exit(failures === 0 ? 0 : 1);
