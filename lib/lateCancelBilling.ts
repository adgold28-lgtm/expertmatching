// lib/lateCancelBilling.ts — what a cancelled or unattended call does to money
// and to the engagement. Wave 5, brief B2.
//
// TWO PUBLIC ENTRY POINTS, one policy:
//
//   applyClientLateCancelMoney(project, pe)
//     The CLIENT was at fault (a cancel inside the 24-hour window, or a
//     client no-show). docs/CALL_POLICIES_DRAFT.md founder decision 2: charge
//     the client 15 minutes at the agreed client rate and pay the expert 15
//     minutes at the agreed expert rate. The charge goes through the ordinary
//     money path (lib/createAndSendInvoice) under a call id that is NOT the
//     call's own — `${icsUid}:late-cancel` — so the per-call double-bill guard
//     treats the fee as a distinct call and the real call stays billable if it
//     is ever rebooked. The payout follows on its own, from
//     payment_intent.succeeded → lib/expertPayout.runExpertPayout, which reads
//     the same id off `billedCallId` and pays 15 minutes rather than the booked
//     hour (expertPayout.payoutMinutesFor).
//
//   applyAttendanceOutcome(project, pe, outcome, input)
//     What a finished Zoom meeting, or a staff member at
//     POST /api/admin/attendance, decided about who actually turned up. One
//     implementation for both callers so the webhook and the staff override can
//     never drift apart:
//       both            → status 'completed' and the ordinary per-minute charge
//       client_no_show  → engagement ends, no_show event, the fee above
//       expert_no_show  → engagement ends, no_show event, the expert is removed
//                         (lib/expertRemoval.removeExpertForFault), no charge
//       neither         → engagement ends, no money at all
//
//   settleMismatchFlag(projectId, expertId, opts)
//     The ten-minute mismatch guarantee (lib/mismatchGuarantee.ts, 2026-10-14):
//     a call the client flagged inside its first ten minutes costs the client
//     nothing and pays the expert 15 minutes from platform funds. Whatever
//     state the call's money is in when the flag lands, this brings it to
//     `paymentStatus: 'waived'`:
//       not ended yet         → nothing now; the branch that ends it settles it
//       ended, not charged    → waive and run the payout directly (no payment
//                               webhook will ever arrive for it)
//       payment link sent     → deactivate the link, waive, pay out
//       card charged          → refund the PaymentIntent in full (idempotency
//                               key per call), waive, pay out
//     applyAttendanceOutcome and applyClientLateCancelMoney check the flag
//     BEFORE charging and call this instead, so a flagged call is never
//     charged through the Zoom path, the staff override or a cancel.
//
// IDEMPOTENCE. The fee is written to `pe.lateCancelCallId` after it is charged
// and refused when that id is already on the row, so a Zoom redelivery, a
// double-clicked confirm and a staff override all charge once. The underlying
// guard in createAndSendInvoice holds even if this one is bypassed.
//
// NEITHER FUNCTION THROWS. Both are side effects of a decision that has already
// been written to the row; a Stripe or Resend failure must not unwind it.
//
// NEVER log: client or expert emails, names, project names, Stripe ids.
// Amounts, minutes, projectId and fixed labels are safe.

import type Stripe from 'stripe';
import type { Project, ProjectExpert } from '../types';
import { callChargeDollars, MIN_BILLABLE_MINUTES } from './pricing';
import { createAndSendInvoice } from './createAndSendInvoice';
import type { InvoiceResult } from './createAndSendInvoice';
import { getEntitlementsForProject } from './entitlements';
import type { Entitlements } from './entitlements';
import { emitEngagementEvent, recordSystemFailure } from './engagementEvents';
import { getProject, mutateExpert } from './projectStore';
import { removeExpertForFault } from './expertRemoval';
import type { ExpertRemovalResult } from './expertRemoval';
import { runExpertPayout } from './expertPayout';
import { getStripe } from './stripe';
import {
  chargeIsForFlaggedCall,
  mismatchRefundIdempotencyKey,
  mismatchSettlement,
  paymentIsForFlaggedCall,
  refundIsForFlaggedCall,
  MISMATCH_PAYOUT_MINUTES,
  type MismatchSettlementAction,
} from './mismatchGuarantee';

/** The fee is always the platform minimum — never the duration that was booked. */
export const LATE_CANCEL_MINUTES = MIN_BILLABLE_MINUTES;

/** Invoice / receipt line item for the fee. A fixed label, never request text. */
export const LATE_CANCEL_LINE_LABEL = `Late cancellation (${LATE_CANCEL_MINUTES} min)`;

export interface LateCancelBillingResult {
  ok:      boolean;
  /** Fixed labels only — never payload text. */
  reason?: 'not_implemented' | 'already_charged' | 'no_rates' | 'charge_failed' | 'trial'
           | 'no_call_id'
           /** The call is flagged under the mismatch guarantee: no fee, the waiver instead. */
           | 'waived';
  callId?: string;
  /** Dollars charged to the client, when a charge was attempted. */
  amount?: number;
}

/** The call id the late-cancel fee is billed and paid under. */
export function lateCancelCallId(pe: Pick<ProjectExpert, 'booking' | 'zoomMeetingId'>): string | null {
  const base = pe.booking?.icsUid ?? pe.zoomMeetingId ?? null;
  return base ? `${base}:late-cancel` : null;
}

// ─── Test seam ────────────────────────────────────────────────────────────────

/**
 * The slice of the Stripe SDK the mismatch settlement uses: a full refund of
 * the flagged call's PaymentIntent, and switching off its payment link. Narrow
 * on purpose, like InvoiceStripeClient and ConnectStripeClient: the real client
 * satisfies it structurally and a stub implements two calls.
 */
export interface MismatchStripeClient {
  refunds: {
    create(
      params:   Stripe.RefundCreateParams,
      options?: { idempotencyKey?: string },
    ): Promise<{ id: string; status?: string | null }>;
  };
  paymentLinks: {
    update(id: string, params: Stripe.PaymentLinkUpdateParams): Promise<{ id: string }>;
  };
}

/** The parts of a Project the mismatch settlement reads. A real Project satisfies it. */
export interface MismatchProjectView {
  experts: ProjectExpert[];
}

/**
 * Everything this module reaches outside itself. Production never passes it;
 * scripts/test-stripe-flows.ts substitutes parts of it. Declared with method
 * syntax so a stub may narrow a parameter type.
 */
export interface LateCancelDeps {
  getEntitlementsForProject(projectId: string): Promise<Entitlements>;
  createAndSendInvoice(
    projectId:     string,
    expertId:      string,
    invoiceAmount: number,
    durationMin:   number,
    callId?:       string | null,
    deps?:         undefined,
    options?:      { lineLabel?: string },
  ): Promise<InvoiceResult | null>;
  patchExpert(projectId: string, expertId: string, patch: Partial<ProjectExpert>): Promise<void>;
  emitEngagementEvent(input: {
    projectId: string;
    expertId:  string;
    orgId?:    string | null;
    type:      'no_show';
    payload?:  Record<string, string | number | boolean | null>;
  }): Promise<void>;
  recordSystemFailure(input: {
    area:      'invoice';
    reason:    string;
    projectId?: string;
    expertId?:  string;
  }): Promise<void>;
  removeExpertForFault(
    project: Project,
    pe:      ProjectExpert,
    fault:   'late_cancel' | 'no_show',
  ): Promise<ExpertRemovalResult>;
  /** A fresh read of the row the mismatch settlement decides on. */
  getProject(projectId: string): Promise<MismatchProjectView | null>;
  /** Decide-and-write on one row under compare-and-set (projectStore.mutateExpert). */
  mutateExpert(
    projectId: string,
    expertId:  string,
    mutate:    (current: ProjectExpert) => ProjectExpert,
  ): Promise<unknown>;
  mismatchStripe: MismatchStripeClient;
  /** lib/expertPayout.runExpertPayout. Never throws. */
  runExpertPayout(projectId: string, expertId: string): Promise<void>;
  now(): number;
}

/** The real Stripe client, reached lazily: STRIPE_SECRET_KEY is absent during `next build`. */
function realMismatchStripe(): MismatchStripeClient {
  return {
    refunds:      { create: (params, options) => getStripe().refunds.create(params, options) },
    paymentLinks: { update: (id, params) => getStripe().paymentLinks.update(id, params) },
  };
}

/**
 * The real store, biller and event stream. Row writes go through
 * projectStore.mutateExpert rather than updateExpertStatus because the Wave 5
 * fields this module writes (`lateCancelCallId`, `attendanceReviewPending`) are
 * on ProjectExpert but not yet on UpdateExpertInput, and mutateExpert is the
 * compare-and-set the cancel path already uses. Reported to the lead.
 */
function defaultDeps(): LateCancelDeps {
  return {
    getEntitlementsForProject,
    createAndSendInvoice,
    patchExpert: async (projectId, expertId, patch) => {
      await mutateExpert(projectId, expertId, current => ({
        ...current,
        ...patch,
        updatedAt: Date.now(),
      }));
    },
    emitEngagementEvent,
    recordSystemFailure,
    removeExpertForFault,
    getProject,
    mutateExpert: (projectId, expertId, mutate) => mutateExpert(projectId, expertId, mutate),
    mismatchStripe: realMismatchStripe(),
    runExpertPayout,
    now: Date.now,
  };
}

// ─── The client-fault fee ─────────────────────────────────────────────────────

/**
 * Charges the client the 15-minute late-cancel / no-show fee.
 *
 * Called only after the decision is already on the row (booking.lateCancel, or
 * a no_show event). Never throws; every refusal is a fixed label.
 */
export async function applyClientLateCancelMoney(
  project: Project,
  pe:      ProjectExpert,
  /** Test seam only. Production calls this with two arguments. */
  deps?:   Partial<LateCancelDeps>,
): Promise<LateCancelBillingResult> {
  const d = { ...defaultDeps(), ...deps };
  const projectId = project.id;
  const expertId  = pe.expert.id;

  try {
    const callId = lateCancelCallId(pe);
    if (!callId) return { ok: false, reason: 'no_call_id' };

    // The ten-minute mismatch guarantee. A client who flagged this call is not
    // charged for it in any form, the fee included; the expert is still paid
    // 15 minutes through the waiver. (A cancel after the flag lands here.)
    if (chargeIsForFlaggedCall(pe, callId)) {
      await settleMismatchFlag(projectId, expertId, { callEnded: true }, deps);
      return { ok: false, reason: 'waived', callId };
    }

    // Idempotent on the row: the fee for this call has already been billed.
    if (pe.lateCancelCallId === callId) {
      return { ok: false, reason: 'already_charged', callId };
    }

    const rate = pe.expertRate ?? 0;
    if (!rate || !Number.isFinite(rate) || rate <= 0) {
      return { ok: false, reason: 'no_rates', callId };
    }

    // The account boundary is checked here as well as inside
    // createAndSendInvoice, so a trial is reported as a trial rather than as a
    // failed charge — the caller shows a different message for each.
    const entitlements = await d.getEntitlementsForProject(projectId);
    if (!entitlements.canCharge) {
      return { ok: false, reason: 'trial', callId };
    }

    const amount = callChargeDollars(rate, LATE_CANCEL_MINUTES);
    const result = await d.createAndSendInvoice(
      projectId, expertId, amount, LATE_CANCEL_MINUTES, callId, undefined,
      { lineLabel: LATE_CANCEL_LINE_LABEL },
    );

    if (!result) {
      await d.recordSystemFailure({
        area: 'invoice', reason: 'late_cancel_fee_not_charged', projectId, expertId,
      });
      return { ok: false, reason: 'charge_failed', callId, amount };
    }

    // The billing backstop refused: the call was flagged after our read.
    if (result.waived) {
      await settleMismatchFlag(projectId, expertId, { callEnded: true }, deps);
      return { ok: false, reason: 'waived', callId };
    }

    // Stamped only after the money path accepted it. A failure here leaves the
    // fee charged and unrecorded, which createAndSendInvoice's own per-call
    // guard still refuses to repeat — recorded so a human sees the odd row.
    try {
      await d.patchExpert(projectId, expertId, { lateCancelCallId: callId });
    } catch {
      await d.recordSystemFailure({
        area: 'invoice', reason: 'late_cancel_fee_charged_but_unrecorded', projectId, expertId,
      });
    }

    console.log('[lateCancel] fee-charged', { projectId, amount, minutes: LATE_CANCEL_MINUTES });
    return { ok: true, callId, amount };
  } catch (err) {
    console.error('[lateCancel] fee error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return { ok: false, reason: 'charge_failed' };
  }
}

// ─── Attendance ───────────────────────────────────────────────────────────────

/** Who actually attended, as decided by Zoom telemetry or by a staff member. */
export type AttendanceOutcome = 'both' | 'client_no_show' | 'expert_no_show' | 'neither';

export interface ApplyAttendanceInput {
  /** Minutes to bill on the 'both' branch — measured, else booked. */
  durationMin: number;
  /** zoomMeetingEndedAt to stamp; omit for a staff decision with no meeting end. */
  endedAt?:    number | null;
}

export interface AttendanceApplyResult {
  outcome:  AttendanceOutcome;
  /** True only when an ordinary per-minute call charge was attempted. */
  charged:  boolean;
  /**
   * True when the call is flagged under the ten-minute mismatch guarantee: the
   * client was charged nothing and the expert is paid 15 minutes.
   */
  waived?:  boolean;
  /** Present when `waived`: what the settlement did. */
  mismatch?: MismatchSettleResult;
  /** Present on the client-fault branch. */
  money?:   LateCancelBillingResult;
  /** Present on the expert-fault branch. */
  removal?: ExpertRemovalResult;
}

/**
 * Applies one attendance decision to one engagement: the row writes, the event,
 * and whatever money the policy allows. Shared by the Zoom `meeting.ended`
 * branch and POST /api/admin/attendance so the automatic and the manual route
 * cannot diverge. Never throws.
 *
 * `attendanceReviewPending` is cleared on every branch — reaching here IS the
 * review being over, whether Zoom or a human did it.
 *
 * A call the client flagged under the ten-minute mismatch guarantee is never
 * charged here: 'both' completes it and waives it, 'client_no_show' ends it and
 * waives it instead of charging the fee, and in both cases the expert is paid
 * 15 minutes. The expert-side branches are unchanged: an expert who did not
 * turn up is not paid, flag or no flag.
 */
export async function applyAttendanceOutcome(
  project: Project,
  pe:      ProjectExpert,
  outcome: AttendanceOutcome,
  input:   ApplyAttendanceInput,
  /** Test seam only. */
  deps?:   Partial<LateCancelDeps>,
): Promise<AttendanceApplyResult> {
  const d = { ...defaultDeps(), ...deps };
  const projectId = project.id;
  const expertId  = pe.expert.id;
  const endedAt   = input.endedAt ?? null;

  /** Fields every branch stamps. */
  const common: Partial<ProjectExpert> = {
    attendanceReviewPending: false,
    ...(endedAt ? { zoomMeetingEndedAt: endedAt } : {}),
  };

  // The ten-minute mismatch guarantee: the flag names this booking's call.
  const flagged = !!pe.mismatchCallId && pe.mismatchCallId === (pe.booking?.icsUid ?? null);

  try {
    if (outcome === 'both') {
      await d.patchExpert(projectId, expertId, {
        ...common,
        actualDurationMin: input.durationMin,
        status:            'completed',
      });
      console.log('[attendance] both-attended', { projectId, durationMin: input.durationMin });

      if (flagged) {
        // No charge, no payment link: the waiver and the expert's 15 minutes.
        const mismatch = await settleMismatchFlag(projectId, expertId, { callEnded: true }, deps);
        // The founder watches the claim rate; a flagged call that kept going
        // well past the guarantee is worth a person's look (the expert is paid
        // 15 minutes for it and the client was charged nothing).
        if (input.durationMin > MISMATCH_PAYOUT_MINUTES) {
          await d.recordSystemFailure({
            area: 'invoice', reason: 'mismatch_flagged_call_ran_long', projectId, expertId,
          });
        }
        console.log('[attendance] mismatch-waived', { projectId, action: mismatch.action });
        return { outcome, charged: false, waived: true, mismatch };
      }

      // Amount from the STORED rate and the measured minutes — never a payload.
      if (pe.expertRate) {
        const amount = callChargeDollars(pe.expertRate, input.durationMin);
        const invoice = await d.createAndSendInvoice(projectId, expertId, amount, input.durationMin);
        if (invoice?.waived) {
          // The flag landed between our read and the biller's: it charged
          // nothing, and the waiver settles the call instead.
          const mismatch = await settleMismatchFlag(projectId, expertId, { callEnded: true }, deps);
          console.log('[attendance] mismatch-waived', { projectId, action: mismatch.action });
          return { outcome, charged: false, waived: true, mismatch };
        }
        return { outcome, charged: true };
      }
      return { outcome, charged: false };
    }

    if (outcome === 'client_no_show') {
      await d.patchExpert(projectId, expertId, { ...common, status: 'rejected_after_outreach' });
      await d.emitEngagementEvent({
        projectId, expertId, type: 'no_show', payload: { who: 'client' },
      });
      if (flagged) {
        // The client flagged the call and then never joined it: still no fee.
        // The expert, who turned up, is paid 15 minutes through the waiver.
        const mismatch = await settleMismatchFlag(projectId, expertId, { callEnded: true }, deps);
        console.log('[attendance] client-no-show-waived', { projectId, action: mismatch.action });
        return { outcome, charged: false, waived: true, mismatch };
      }
      const money = await applyClientLateCancelMoney(project, pe, deps);
      console.log('[attendance] client-no-show', { projectId, charged: money.ok });
      return { outcome, charged: false, money, ...(money.reason === 'waived' ? { waived: true } : {}) };
    }

    if (outcome === 'expert_no_show') {
      // No charge, no payout. The status is the removal's to write.
      await d.patchExpert(projectId, expertId, common);
      await d.emitEngagementEvent({
        projectId, expertId, type: 'no_show', payload: { who: 'expert' },
      });
      const removal = await d.removeExpertForFault(project, pe, 'no_show');
      console.log('[attendance] expert-no-show', { projectId, removed: removal.ok });
      return { outcome, charged: false, removal };
    }

    // 'neither': the call simply did not happen. The engagement ends and nobody
    // pays — there is no fault to attribute and no service to charge for.
    await d.patchExpert(projectId, expertId, { ...common, status: 'rejected_after_outreach' });
    await d.emitEngagementEvent({
      projectId, expertId, type: 'no_show', payload: { who: 'neither' },
    });
    console.log('[attendance] neither-attended', { projectId });
    return { outcome, charged: false };
  } catch (err) {
    console.error('[attendance] apply error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return { outcome, charged: false };
  }
}

// ─── The ten-minute mismatch guarantee: the money ─────────────────────────────

/** What settleMismatchFlag did. Fixed labels only. */
export interface MismatchSettleResult {
  ok:      boolean;
  action:  MismatchSettlementAction['kind'] | 'not_found';
  reason?: 'refund_failed' | 'write_failed' | 'needs_staff' | 'error';
}

/** Aborts a waiver write when the row no longer carries the flag it was for. */
class WaiverSkipped extends Error {
  constructor() { super('mismatch_waiver_skipped'); }
}

/** Stripe's answer when the charge has already been refunded: a replay, so a success. */
function isAlreadyRefunded(err: unknown): boolean {
  return stripeErrorCode(err) === 'charge_already_refunded';
}

/**
 * A Stripe error's code, for the log. Never the message: Stripe's messages name
 * the charge or the link they are about, and Stripe ids are never logged.
 */
function stripeErrorCode(err: unknown): string {
  const code = typeof err === 'object' && err !== null ? (err as { code?: unknown }).code : undefined;
  return typeof code === 'string' && code ? code.slice(0, 60) : 'unknown';
}

/**
 * Writes `paymentStatus: 'waived'` for the flagged call, under compare-and-set:
 * nothing is written when the row's flag no longer names `flaggedCallId`.
 *
 * When the row is billed for some OTHER call (an earlier consultation) or for
 * none, `billedCallId` is pointed at the flagged call, which is what the payout
 * keys on, and the other call's PaymentIntent id is cleared so a later refund
 * of THAT charge is never mistaken for this one's. When `refundedIntentId` is
 * given it is recorded, so the charge.refunded webhook recognises its refund.
 */
async function writeWaiver(
  projectId:        string,
  expertId:         string,
  flaggedCallId:    string,
  refundedIntentId: string | null,
  d:                LateCancelDeps,
): Promise<boolean> {
  try {
    await d.mutateExpert(projectId, expertId, current => {
      if (current.mismatchCallId !== flaggedCallId) throw new WaiverSkipped();
      const billedForFlag = chargeIsForFlaggedCall(current, current.billedCallId);
      return {
        ...current,
        paymentStatus: 'waived',
        ...(billedForFlag ? {} : { billedCallId: flaggedCallId, stripePaymentIntentId: null }),
        ...(refundedIntentId ? { stripePaymentIntentId: refundedIntentId } : {}),
        updatedAt: d.now(),
      };
    });
    return true;
  } catch (err) {
    if (err instanceof WaiverSkipped) return false;
    console.error('[mismatch] waiver write failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    await d.recordSystemFailure({
      area: 'invoice', reason: 'mismatch_waiver_unrecorded', projectId, expertId,
    });
    return false;
  }
}

/**
 * Brings the money for a flagged call to rest: the client charged nothing, the
 * expert paid 15 minutes. Re-reads the row and acts on
 * lib/mismatchGuarantee.mismatchSettlement:
 *
 *   await_call_end  nothing yet; the branch that ends the call calls this again
 *   waive           write 'waived', then run the payout directly
 *   cancel_link     deactivate the unpaid payment link, then as 'waive'. A link
 *                   that cannot be switched off is reported, and the waiver is
 *                   still written: a payment that arrives on it later is
 *                   refunded by the Stripe webhook (paymentIsForFlaggedCall).
 *   refund          refund the PaymentIntent in full, keyed per call so a
 *                   replay returns the same refund; a charge already refunded
 *                   counts as done. Only then 'waived' and the payout. A refund
 *                   that fails writes nothing and raises an attention row; the
 *                   next flag click or payment webhook retries it.
 *   manual_refund   paid with no PaymentIntent on record: an attention row.
 *
 * `opts.callEnded` comes from a caller that has just ended the call on a branch
 * that is not 'completed' (a client no-show, a cancel after the flag).
 * `opts.paymentIntentId` comes from the Stripe webhook: a payment settled for
 * this row, and if it is for the flagged call it is refunded rather than
 * recorded as 'paid'. Nothing is refunded for a row that is not flagged.
 *
 * Idempotent: a second run finds 'waived' and does nothing, and the payout has
 * its own per-call guard. Never throws. Never tells the expert anything.
 */
export async function settleMismatchFlag(
  projectId: string,
  expertId:  string,
  opts:      { callEnded?: boolean; paymentIntentId?: string | null } = {},
  /** Test seam only. */
  deps?:     Partial<LateCancelDeps>,
): Promise<MismatchSettleResult> {
  const d = { ...defaultDeps(), ...deps };
  try {
    const project = await d.getProject(projectId);
    const pe      = project?.experts.find(e => e.expert.id === expertId);
    if (!pe) return { ok: false, action: 'not_found' };

    const flaggedCallId = pe.mismatchCallId ?? null;
    if (!flaggedCallId) return { ok: true, action: 'not_flagged' };

    let action: MismatchSettlementAction;
    if (opts.paymentIntentId !== undefined) {
      if (!paymentIsForFlaggedCall(pe, opts.paymentIntentId)) return { ok: true, action: 'not_flagged' };
      action = opts.paymentIntentId
        ? { kind: 'refund', paymentIntentId: opts.paymentIntentId }
        : { kind: 'manual_refund' };
    } else {
      action = mismatchSettlement(pe, { callEnded: opts.callEnded });
    }

    switch (action.kind) {
      case 'not_flagged':
      case 'settled':
      case 'await_call_end':
        return { ok: true, action: action.kind };

      case 'manual_refund':
        await d.recordSystemFailure({
          area: 'invoice', reason: 'mismatch_refund_needs_staff', projectId, expertId,
        });
        return { ok: false, action: action.kind, reason: 'needs_staff' };

      case 'refund': {
        const chargeCallId = chargeIsForFlaggedCall(pe, pe.billedCallId) && pe.billedCallId
          ? pe.billedCallId
          : flaggedCallId;
        let refunded = false;
        try {
          const refund = await d.mismatchStripe.refunds.create(
            {
              payment_intent: action.paymentIntentId,
              reason:         'requested_by_customer',
              metadata:       { projectId, expertId },   // no PII in metadata
            },
            { idempotencyKey: mismatchRefundIdempotencyKey(projectId, expertId, chargeCallId) },
          );
          refunded = refund.status !== 'failed' && refund.status !== 'canceled';
        } catch (err) {
          refunded = isAlreadyRefunded(err);
          if (!refunded) console.error('[mismatch] refund failed:', stripeErrorCode(err));
        }
        if (!refunded) {
          await d.recordSystemFailure({
            area: 'invoice', reason: 'mismatch_refund_failed', projectId, expertId,
          });
          return { ok: false, action: action.kind, reason: 'refund_failed' };
        }
        if (!await writeWaiver(projectId, expertId, flaggedCallId, action.paymentIntentId, d)) {
          return { ok: false, action: action.kind, reason: 'write_failed' };
        }
        await d.runExpertPayout(projectId, expertId);
        console.log('[mismatch] refunded', { projectId });
        return { ok: true, action: action.kind };
      }

      case 'cancel_link': {
        try {
          await d.mismatchStripe.paymentLinks.update(action.linkId, { active: false });
        } catch (err) {
          console.error('[mismatch] payment link not deactivated:', stripeErrorCode(err));
          await d.recordSystemFailure({
            area: 'invoice', reason: 'mismatch_payment_link_still_active', projectId, expertId,
          });
        }
        if (!await writeWaiver(projectId, expertId, flaggedCallId, null, d)) {
          return { ok: false, action: action.kind, reason: 'write_failed' };
        }
        await d.runExpertPayout(projectId, expertId);
        console.log('[mismatch] link-cancelled', { projectId });
        return { ok: true, action: action.kind };
      }

      case 'waive': {
        if (!await writeWaiver(projectId, expertId, flaggedCallId, null, d)) {
          return { ok: false, action: action.kind, reason: 'write_failed' };
        }
        await d.runExpertPayout(projectId, expertId);
        console.log('[mismatch] waived', { projectId });
        return { ok: true, action: action.kind };
      }
    }
  } catch (err) {
    console.error('[mismatch] settle error:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    return { ok: false, action: 'not_found', reason: 'error' };
  }
}

/**
 * The charge.refunded webhook's half of the guarantee: the refund of the
 * flagged call's charge is expected. Writes 'waived' under compare-and-set,
 * only while the refund still matches the flagged call's PaymentIntent and the
 * row is not already 'waived'. The webhook runs the payout itself afterwards.
 * Throws only on a store failure, so the webhook answers 500 and Stripe
 * redelivers.
 */
export async function recordMismatchRefund(
  projectId: string,
  expertId:  string,
  intentId:  string,
  /** Test seam only. */
  deps?:     Partial<LateCancelDeps>,
): Promise<void> {
  const d = { ...defaultDeps(), ...deps };
  try {
    await d.mutateExpert(projectId, expertId, current => {
      if (!refundIsForFlaggedCall(current, intentId)) throw new WaiverSkipped();
      if (current.paymentStatus === 'waived') throw new WaiverSkipped();
      return { ...current, paymentStatus: 'waived', updatedAt: d.now() };
    });
  } catch (err) {
    if (err instanceof WaiverSkipped) return;
    console.error('[mismatch] refund record failed:',
      err instanceof Error ? err.message.slice(0, 120) : 'unknown');
    throw err;
  }
}
