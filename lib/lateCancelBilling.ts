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

import type { Project, ProjectExpert } from '../types';
import { callChargeDollars, MIN_BILLABLE_MINUTES } from './pricing';
import { createAndSendInvoice } from './createAndSendInvoice';
import type { InvoiceResult } from './createAndSendInvoice';
import { getEntitlementsForProject } from './entitlements';
import type { Entitlements } from './entitlements';
import { emitEngagementEvent, recordSystemFailure } from './engagementEvents';
import { mutateExpert } from './projectStore';
import { removeExpertForFault } from './expertRemoval';
import type { ExpertRemovalResult } from './expertRemoval';

/** The fee is always the platform minimum — never the duration that was booked. */
export const LATE_CANCEL_MINUTES = MIN_BILLABLE_MINUTES;

/** Invoice / receipt line item for the fee. A fixed label, never request text. */
export const LATE_CANCEL_LINE_LABEL = `Late cancellation (${LATE_CANCEL_MINUTES} min)`;

export interface LateCancelBillingResult {
  ok:      boolean;
  /** Fixed labels only — never payload text. */
  reason?: 'not_implemented' | 'already_charged' | 'no_rates' | 'charge_failed' | 'trial'
           | 'no_call_id';
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
  now(): number;
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

  try {
    if (outcome === 'both') {
      await d.patchExpert(projectId, expertId, {
        ...common,
        actualDurationMin: input.durationMin,
        status:            'completed',
      });
      console.log('[attendance] both-attended', { projectId, durationMin: input.durationMin });

      // Amount from the STORED rate and the measured minutes — never a payload.
      if (pe.expertRate) {
        const amount = callChargeDollars(pe.expertRate, input.durationMin);
        await d.createAndSendInvoice(projectId, expertId, amount, input.durationMin);
        return { outcome, charged: true };
      }
      return { outcome, charged: false };
    }

    if (outcome === 'client_no_show') {
      await d.patchExpert(projectId, expertId, { ...common, status: 'rejected_after_outreach' });
      await d.emitEngagementEvent({
        projectId, expertId, type: 'no_show', payload: { who: 'client' },
      });
      const money = await applyClientLateCancelMoney(project, pe, deps);
      console.log('[attendance] client-no-show', { projectId, charged: money.ok });
      return { outcome, charged: false, money };
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
