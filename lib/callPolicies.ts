// The cancellation policy, as arithmetic.
//
// docs/CALL_POLICIES_DRAFT.md "Founder decisions" (approved 2026-09-10) says
// three things about cancelling a booked call, and this module is all three of
// them with no I/O attached:
//
//   1. THE WINDOW. Either side may cancel outright while the call is still more
//      than 24 hours away. Inside 24 hours a cancel is a LATE cancel, and the
//      product's advice is to move the call instead.
//   2. THE FEE. A late cancel is 15 minutes at the agreed rates — the client is
//      charged 15 minutes of the client rate, the expert is paid 15 minutes of
//      the expert rate. Both numbers come from lib/pricing.ts, which is the
//      only module in the system allowed to convert a rate into money.
//   3. THE CONSEQUENCE. Who cancelled decides what happens: a client late
//      cancel is billable, an expert late cancel removes the expert from the
//      platform (lib/expertRemoval.ts), and a staff cancel never does either.
//
// Everything here is PURE and `now` is always supplied by the caller, so
// scripts/test-call-policies.ts can walk the boundary a millisecond at a time
// and across a DST change without owning a clock.
//
// FAIL CLOSED ON A BAD TIME: a `startUtc` that does not parse is treated as
// 'late'. The alternative — treating an unreadable time as a free cancel —
// would let a corrupt row waive a fee, and money fails closed here the same way
// it does in lib/createAndSendInvoice.ts.
//
// Never logs anything.

import { callChargeDollars, expertPayoutDollars, MIN_BILLABLE_MINUTES } from './pricing';

/** The free-cancellation window: 24 hours before the booked UTC start. */
export const CANCEL_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Minutes billed and paid for a late cancel or a no-show. */
export const LATE_CANCEL_MINUTES = MIN_BILLABLE_MINUTES;

/**
 * Where a cancel falls relative to the booked start.
 *
 *   'free'    more than 24 hours out — no money, no consequence
 *   'late'    inside 24 hours, call not yet due
 *   'started' the booked start has passed
 */
export type CancelWindow = 'free' | 'late' | 'started';

/**
 * Which side of the 24-hour line `now` sits on.
 *
 * EXACTLY 24 hours before the start is 'free'; one millisecond later is 'late'.
 * `now >= start` is 'started'. An unparseable start is 'late' (see the header).
 */
export function cancelWindow(now: number, startUtc: string): CancelWindow {
  const start = Date.parse(startUtc);
  if (!Number.isFinite(start) || !Number.isFinite(now)) return 'late';
  if (now >= start) return 'started';
  return start - now >= CANCEL_WINDOW_MS ? 'free' : 'late';
}

export interface LateCancelFee {
  /** Whole dollars the client is charged. */
  clientCharge: number;
  /** Whole dollars the expert is paid. */
  expertPayout: number;
  /** Always 15 — the minimum billable block, and the whole fee. */
  minutes:      typeof LATE_CANCEL_MINUTES;
}

/**
 * The 15-minute fee for one engagement, from the expert's agreed hourly rate.
 * Both numbers are lib/pricing.ts's; nothing here multiplies a rate itself.
 */
export function lateCancelFee(expertRate: number): LateCancelFee {
  return {
    clientCharge: callChargeDollars(expertRate, LATE_CANCEL_MINUTES),
    expertPayout: expertPayoutDollars(expertRate, LATE_CANCEL_MINUTES),
    minutes:      LATE_CANCEL_MINUTES,
  };
}

/** Who pressed cancel. 'staff' is an admin acting for either side. */
export type CancelledBy = 'client' | 'expert' | 'staff';

export interface CancelDecision {
  /** True when the cancel fell inside the window (or after the start). */
  late:          boolean;
  /** Charge the client 15 minutes (lib/lateCancelBilling.ts). */
  clientCharged: boolean;
  /** Pay the expert 15 minutes — always together with clientCharged. */
  expertPaid:    boolean;
  /** Remove the expert from the platform (lib/expertRemoval.ts). */
  expertRemoved: boolean;
  /** Where the engagement ends. Cancel is always terminal. */
  status:        'rejected_after_outreach';
}

/**
 * What a cancel costs and who it costs.
 *
 * 'started' is treated exactly like 'late': a call the booked time has already
 * passed for is at least as late as one 30 seconds before it, and nothing about
 * the clock running out makes the fee go away.
 *
 * STAFF NEVER TRIGGER MONEY OR A REMOVAL. An admin cancelling on someone's
 * behalf is an operational act; the commercial decision that goes with it is
 * made by a person, through the admin routes, not implied by this one.
 */
export function cancelOutcome(by: CancelledBy, window: CancelWindow): CancelDecision {
  const late = window !== 'free';
  const base = { late, status: 'rejected_after_outreach' as const };

  if (!late || by === 'staff') {
    return { ...base, clientCharged: false, expertPaid: false, expertRemoved: false };
  }
  if (by === 'client') {
    return { ...base, clientCharged: true, expertPaid: true, expertRemoved: false };
  }
  return { ...base, clientCharged: false, expertPaid: false, expertRemoved: true };
}
