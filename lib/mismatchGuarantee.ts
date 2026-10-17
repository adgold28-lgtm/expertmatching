// lib/mismatchGuarantee.ts — the ten-minute mismatch guarantee, as pure rules.
//
// The founder's offer (founder/offer.md): "The first ten minutes of every call
// are on us. Flag a mismatch inside ten minutes and nothing is charged; the
// expert is still paid." Costed as: the client is charged nothing for that
// call, and the expert is paid 15 minutes at their agreed (expert-side) rate
// out of platform funds.
//
// THIS FILE DECIDES; IT NEVER ACTS. No I/O, no clock of its own, no env. Every
// function takes `now` (or nothing time-dependent) so scripts/
// test-mismatch-guarantee.ts can walk every edge. The places that act on these
// decisions:
//
//   POST /api/projects/[projectId]/experts/[expertId]/mismatch
//        the owner's flag: mismatchEligibility → mismatchFlaggedAt +
//        mismatchCallId on the row (compare-and-set), event, attention row.
//   lib/lateCancelBilling.settleMismatchFlag
//        the money for a flagged call: mismatchSettlement says whether to wait
//        for the call to end, waive it, cancel its payment link, or refund the
//        charge that already went through.
//   lib/lateCancelBilling.applyAttendanceOutcome, lib/createAndSendInvoice,
//   POST …/complete, POST /api/admin/attendance
//        every path that could charge the call checks chargeIsForFlaggedCall
//        first and charges nothing.
//   lib/expertPayout.runExpertPayout
//        a 'waived' row pays out, for exactly MISMATCH_PAYOUT_MINUTES, once
//        (isWaivedMismatchPayout, mismatchPayoutMinutes).
//   app/api/webhooks/stripe/handlers.ts
//        a payment or a refund on the flagged call is expected, never an alarm
//        (paymentIsForFlaggedCall, refundIsForFlaggedCall).
//
// THE CALL. A flag names one call: `booking.icsUid`, the same identity the
// per-call billing guard and the payout guard key on. A row holds one flag; a
// second call with the same expert cannot be flagged once one has been.
//
// The expert is never told about a flag. Nothing here, or downstream of here,
// sends the expert anything.

import type { ProjectExpert } from '../types';
import { MIN_BILLABLE_MINUTES } from './pricing';

// ─── Constants ────────────────────────────────────────────────────────────────

/** How long after the booked start a client may flag the call. */
export const MISMATCH_WINDOW_MS = 10 * 60_000;

/**
 * Server-side tolerance for clock skew between the client's screen and ours.
 * The button disappears at ten minutes on the client's clock; the server still
 * honours a flag that lands inside this minute after it.
 */
export const MISMATCH_GRACE_MS = 60_000;

/**
 * The longest flagged call that is still free (founder, 2026-10-17: "a call
 * past 10 minutes shouldn't be free"). The guarantee covers a call the client
 * ENDS inside its first ten minutes; one that keeps going past ten minutes is
 * billed as usual, and the flag is voided (mismatchVoidedAt).
 */
export const MISMATCH_MAX_FREE_MINUTES = 10;

/**
 * True when a flagged call ran long enough that the guarantee no longer
 * applies. A missing or unreadable duration keeps the guarantee: the call
 * cannot be shown to have run past ten minutes. Pure.
 */
export function flagVoidedByDuration(durationMin: number | null | undefined): boolean {
  return typeof durationMin === 'number' && Number.isFinite(durationMin) && durationMin > MISMATCH_MAX_FREE_MINUTES;
}

/** What the expert is paid for a flagged call: the platform minimum. */
export const MISMATCH_PAYOUT_MINUTES = MIN_BILLABLE_MINUTES;

// ─── The window ───────────────────────────────────────────────────────────────

export type MismatchWindowState = 'not_started' | 'open' | 'window_closed';

export interface MismatchWindowBounds {
  /** Unix ms the window opens: the booked start. */
  opensAt:  number;
  /** Unix ms ten minutes later, WITHOUT the grace. */
  closesAt: number;
}

/** The window for a booked start, or null when the start cannot be read. Pure. */
export function mismatchWindowBounds(startUtc: string | null | undefined): MismatchWindowBounds | null {
  if (typeof startUtc !== 'string' || !startUtc) return null;
  const opensAt = Date.parse(startUtc);
  if (!Number.isFinite(opensAt)) return null;
  return { opensAt, closesAt: opensAt + MISMATCH_WINDOW_MS };
}

/**
 * Where `now` sits against the window of a call booked at `startUtc`.
 *
 *   before the start                     → 'not_started'
 *   start … start + 10 min + grace       → 'open' (both ends inclusive)
 *   after that                           → 'window_closed'
 *
 * FAILS CLOSED: an unreadable start or a non-finite `now` is 'window_closed',
 * so a malformed booking can never be flagged. The browser passes graceMs 0 so
 * the button matches the copy ("the first ten minutes"); the server keeps the
 * default. Pure.
 */
export function mismatchWindowState(
  now:      number,
  startUtc: string | null | undefined,
  graceMs:  number = MISMATCH_GRACE_MS,
): MismatchWindowState {
  const bounds = mismatchWindowBounds(startUtc);
  if (!bounds || !Number.isFinite(now)) return 'window_closed';
  if (now < bounds.opensAt) return 'not_started';
  if (now <= bounds.closesAt + Math.max(0, graceMs)) return 'open';
  return 'window_closed';
}

/**
 * True when a meeting that ended at `endedAt` ended inside the window of the
 * call booked at `startUtc` (grace included). Only such a completed call may
 * still be flagged: a call that ran past ten minutes is past the guarantee
 * whenever the client gets round to asking. Pure.
 */
export function endedInsideMismatchWindow(
  endedAt:  number | null | undefined,
  startUtc: string | null | undefined,
  graceMs:  number = MISMATCH_GRACE_MS,
): boolean {
  const bounds = mismatchWindowBounds(startUtc);
  if (!bounds || typeof endedAt !== 'number' || !Number.isFinite(endedAt)) return false;
  return endedAt <= bounds.closesAt + Math.max(0, graceMs);
}

// ─── Eligibility ──────────────────────────────────────────────────────────────

/** Why a flag is refused. Fixed labels; the route maps each to a written line. */
export type MismatchRefusal =
  | 'not_booked'          // no booking, a cancelled one, or one with no call id
  | 'not_started'         // before the booked start
  | 'window_closed'       // more than ten minutes (plus grace) after it
  | 'call_not_eligible'   // not scheduled, or completed after the window
  | 'flagged_other_call'; // this engagement already used its flag on another call

export type MismatchEligibility =
  /** `already` is true for a replay: this call is flagged, nothing to write. */
  | { ok: true;  callId: string; already: boolean }
  | { ok: false; reason: MismatchRefusal };

/** The fields eligibility reads. A ProjectExpert satisfies it. */
export type MismatchEligibilityView = Pick<
  ProjectExpert,
  'status' | 'booking' | 'zoomMeetingEndedAt' | 'mismatchCallId' | 'actualDurationMin'
>;

/**
 * May this engagement's current call be flagged right now?
 *
 * In order:
 *   1. There is a live booking with an ICS uid (the call's identity).
 *   2. A flag that already names THIS call is a replay: ok, already. This runs
 *      before the window so a second click after minute ten still answers with
 *      the state the first click created rather than an error.
 *   3. A flag that names a DIFFERENT call is refused: the row carries one.
 *   4. The window is open (grace included).
 *   5. The engagement is 'scheduled', or 'completed' with a meeting that ended
 *      inside the window. Anything else (a no-show, a cancel, a removal) is
 *      settled by its own policy, not by this one.
 * Pure.
 */
export function mismatchEligibility(
  pe:      MismatchEligibilityView,
  now:     number,
  graceMs: number = MISMATCH_GRACE_MS,
): MismatchEligibility {
  const booking = pe.booking;
  if (!booking || booking.cancelledAt) return { ok: false, reason: 'not_booked' };
  const callId = typeof booking.icsUid === 'string' ? booking.icsUid : '';
  if (!callId) return { ok: false, reason: 'not_booked' };

  if (pe.mismatchCallId) {
    if (pe.mismatchCallId === callId) return { ok: true, callId, already: true };
    return { ok: false, reason: 'flagged_other_call' };
  }

  const window = mismatchWindowState(now, booking.startUtc, graceMs);
  if (window !== 'open') return { ok: false, reason: window };

  if (pe.status === 'scheduled') return { ok: true, callId, already: false };
  if (pe.status === 'completed'
      && !flagVoidedByDuration(pe.actualDurationMin)
      && endedInsideMismatchWindow(pe.zoomMeetingEndedAt, booking.startUtc, graceMs)) {
    return { ok: true, callId, already: false };
  }
  return { ok: false, reason: 'call_not_eligible' };
}

// ─── The billing decision ─────────────────────────────────────────────────────

export interface MismatchBillingDecision {
  /** Dollars charged to the client for the flagged call. Always 0. */
  clientAmount:   0;
  /** The row's paymentStatus once the call is settled. */
  paymentStatus:  'waived';
  /** Minutes the expert is paid for, at their own agreed rate. */
  expertMinutes:  number;
}

/** What a flagged call costs, and what it pays. Constant on purpose. Pure. */
export function mismatchBillingDecision(): MismatchBillingDecision {
  return { clientAmount: 0, paymentStatus: 'waived', expertMinutes: MISMATCH_PAYOUT_MINUTES };
}

/**
 * True when a charge billed under `callId` belongs to the flagged call: the
 * call itself, or an id derived from it (the late-cancel / no-show fee is
 * `${icsUid}:late-cancel`, lib/lateCancelBilling.lateCancelCallId). Every path
 * that can charge the client asks this first and charges nothing when it says
 * yes. Pure.
 */
export function chargeIsForFlaggedCall(
  pe:     Pick<ProjectExpert, 'mismatchCallId'>,
  callId: string | null | undefined,
): boolean {
  const flagged = pe.mismatchCallId;
  if (!flagged || typeof callId !== 'string' || !callId) return false;
  return callId === flagged || callId.startsWith(`${flagged}:`);
}

/**
 * The payout rule's exception (lib/expertPayout.runExpertPayout): an expert is
 * normally paid only once the client's payment is 'paid'. A flagged call is
 * never paid for by the client, so 'waived' also releases the payout, but only
 * for the call the flag names. Pure.
 */
export function isWaivedMismatchPayout(
  pe:     Pick<ProjectExpert, 'paymentStatus' | 'mismatchCallId'>,
  callId: string | null | undefined,
): boolean {
  return pe.paymentStatus === 'waived' && chargeIsForFlaggedCall(pe, callId);
}

/**
 * Minutes the expert is paid for a payout keyed on `callId`:
 * MISMATCH_PAYOUT_MINUTES when it is the flagged call, else null (the caller
 * falls back to its ordinary rule). Applies whatever the payment status says,
 * so a payout that runs between the charge and its refund is also 15 minutes.
 * Pure.
 */
export function mismatchPayoutMinutes(
  pe:     Pick<ProjectExpert, 'mismatchCallId'>,
  callId: string | null | undefined,
): number | null {
  return chargeIsForFlaggedCall(pe, callId) ? MISMATCH_PAYOUT_MINUTES : null;
}

// ─── Settling a flag ──────────────────────────────────────────────────────────

/** The fields the settlement decision reads. A ProjectExpert satisfies it. */
export type MismatchSettlementView = Pick<
  ProjectExpert,
  | 'status' | 'mismatchCallId' | 'paymentStatus' | 'billedCallId'
  | 'stripePaymentIntentId' | 'stripePaymentLinkId'
>;

/** What to do about the money for a flagged call, right now. */
export type MismatchSettlementAction =
  /** The row carries no flag. Nothing to do. */
  | { kind: 'not_flagged' }
  /** Already waived for the flagged call. Nothing to do. */
  | { kind: 'settled' }
  /** The call has not ended (or its attendance is under review). The path that ends it waives it. */
  | { kind: 'await_call_end' }
  /** It ended and nothing was charged for it: waive it and pay the expert. */
  | { kind: 'waive' }
  /** A payment link was sent for it and not paid: deactivate the link, then waive. */
  | { kind: 'cancel_link'; linkId: string }
  /** The card was charged for it: refund the PaymentIntent in full, then waive. */
  | { kind: 'refund'; paymentIntentId: string }
  /** It was paid with no PaymentIntent on record to refund: a person has to. */
  | { kind: 'manual_refund' };

/**
 * The money decision for a flagged call.
 *
 *   * Billed for the flagged call (billedCallId is it, or its fee):
 *       'waived'                       → settled
 *       a PaymentIntent, not 'failed'  → refund it (a refund of an already
 *                                        refunded charge is a success at the
 *                                        caller, so a replay is harmless)
 *       a payment link, not 'paid'     → deactivate it
 *       'paid' with neither            → manual_refund (legacy rows only)
 *   * Otherwise nothing was charged for it:
 *       the call has ended             → waive
 *       it has not                     → await_call_end
 *
 * `callEnded` lets a caller that has just ended the call on a non-'completed'
 * branch (a client no-show, a cancel after the flag) say so; without it only
 * 'completed' counts as ended. Pure.
 */
export function mismatchSettlement(
  pe:   MismatchSettlementView,
  opts: { callEnded?: boolean } = {},
): MismatchSettlementAction {
  if (!pe.mismatchCallId) return { kind: 'not_flagged' };

  if (chargeIsForFlaggedCall(pe, pe.billedCallId)) {
    if (pe.paymentStatus === 'waived') return { kind: 'settled' };
    if (pe.stripePaymentIntentId && pe.paymentStatus !== 'failed') {
      return { kind: 'refund', paymentIntentId: pe.stripePaymentIntentId };
    }
    if (pe.stripePaymentLinkId && pe.paymentStatus !== 'paid') {
      return { kind: 'cancel_link', linkId: pe.stripePaymentLinkId };
    }
    if (pe.paymentStatus === 'paid') return { kind: 'manual_refund' };
  }

  if (opts.callEnded === true || pe.status === 'completed') return { kind: 'waive' };
  return { kind: 'await_call_end' };
}

/**
 * True when a payment that just settled at Stripe (`intentId`) is for the
 * flagged call: the row is billed for it, and the payment is the row's own
 * charge or a payment-link payment the row has not recorded yet. The Stripe
 * webhook refunds such a payment instead of recording it as 'paid'. Pure.
 */
export function paymentIsForFlaggedCall(
  pe:       Pick<ProjectExpert, 'mismatchCallId' | 'billedCallId' | 'stripePaymentIntentId'>,
  intentId: string | null | undefined,
): boolean {
  if (!chargeIsForFlaggedCall(pe, pe.billedCallId)) return false;
  if (!pe.stripePaymentIntentId || !intentId) return true;
  return pe.stripePaymentIntentId === intentId;
}

/**
 * True when a refund Stripe reports (on `intentId`) is the refund of the
 * flagged call's charge: expected, so it keeps 'waived', raises no alarm and
 * does not hold the expert's payout. Anything else is an ordinary refund. Pure.
 */
export function refundIsForFlaggedCall(
  pe:       Pick<ProjectExpert, 'mismatchCallId' | 'billedCallId' | 'stripePaymentIntentId'>,
  intentId: string | null | undefined,
): boolean {
  if (!chargeIsForFlaggedCall(pe, pe.billedCallId)) return false;
  return typeof intentId === 'string' && !!intentId && pe.stripePaymentIntentId === intentId;
}

/**
 * Stripe idempotency key for the refund of one flagged call's charge. Keyed on
 * the call the charge was billed under, the same shape as the charge's own key
 * (lib/chargeSavedCard.chargeIdempotencyKey), so a double click, a webhook and
 * a retry all replay one refund. Pure.
 */
export function mismatchRefundIdempotencyKey(
  projectId: string,
  expertId:  string,
  callId:    string,
): string {
  return `mismatch-refund:${projectId}:${expertId}:${callId}`;
}
