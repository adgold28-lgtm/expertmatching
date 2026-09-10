// lib/expertPayout.ts
// Expert payout for a paid expert call — shared by every "client money
// received" webhook branch (checkout.session.completed and
// payment_intent.succeeded).
//
// The payout amount is ALWAYS recomputed server-side from the stored
// expertRate and duration. A webhook payload is never trusted for money:
//   payout = expertPayoutDollars(expertRate, actualDurationMin ?? callDurationMin)
//          = the hourly offer the expert accepted × billable minutes (15-min
//            minimum), lib/pricing.ts. The client was charged clientRateFor(
//            expertRate) over the same minutes; ExpertMatch keeps the difference.
//
// Behaviour:
//   1. Load the ProjectExpert; skip if this CALL has already been paid out
//      (paidCallIds contains it) or if there is no contact email.
//   2. If the expert has a Connect account with onboarding complete → transfer,
//      then record the transfer id in its OWN write before anything else.
//   3. Otherwise → mark payout pending and email a 7-day onboarding link, at
//      most once a week and four times in total.
//
// PER CALL, NOT PER ENGAGEMENT. A repeat consultation with the same expert on
// the same project is a second payout: the guard and the Stripe idempotency key
// both carry the call id (booking.icsUid, else the Zoom meeting id, else the id
// the manual complete route invented — lib/createAndSendInvoice.resolveCallId).
// Rows written before paidCallIds existed have none; one with a stripeTransferId
// is treated as already paid for whatever call is asked about, so no deploy can
// pay an old call twice.
//
// Payouts left pending because the expert had not finished Stripe onboarding,
// and payouts whose transfer failed, are retried by
// retryPendingPayoutsForAccount(), called BOTH from the account.updated branch
// of the Stripe webhook and from the nightly reconcile sweep
// (app/api/jobs/reconcile/route.ts). A row is retried at most
// MAX_PAYOUT_ATTEMPTS times.
//
// Required env vars:
//   RESEND_API_KEY        — payout onboarding email (optional; skipped if absent)
//   OUTREACH_FROM_EMAIL   — sender address (optional; skipped if absent)
//   NEXT_PUBLIC_BASE_URL  — base for the expert onboarding link
//   DISABLE_EMAILS        — 'true' suppresses all outbound mail
//
// NEVER log: expert names, project names, customer emails, card details,
// accountId, or transferId. Amounts, projectId and expertId are safe.

import { Resend } from 'resend';
import type { ProjectExpert } from '../types';
import { getProject, updateExpertStatus } from './projectStore';
import type { UpdateExpertInput } from './projectStore';
import { getServiceRoleClient } from './supabase/admin';
import {
  getConnectAccountId,
  isOnboardingComplete,
  transferExpertPayout,
} from './stripeConnect';
import { generateAvailabilityToken } from './availabilityToken';
import { expertPayoutDollars, formatUsdFromCents } from './pricing';
import { getFromAddress } from './mailFrom';
import { resolveCallId } from './createAndSendInvoice';
import { recordSystemFailure } from './engagementEvents';

// ─── Expert payout email ──────────────────────────────────────────────────────

export async function sendPayoutOnboardingEmail(
  expertEmail:       string,
  expertFirstName:   string,
  /** Expert's share of the call, in whole cents. */
  expertAmountCents: number,
  onboardingUrl:     string,
): Promise<void> {
  if (process.env.DISABLE_EMAILS === 'true') return;

  const resendKey = process.env.RESEND_API_KEY;
  const fromAddr  = getFromAddress();
  if (!resendKey) return;

  const resend = new Resend(resendKey);
  // Cents in, formatted dollars out — a 70% split is rarely a whole dollar.
  const amountLabel = formatUsdFromCents(expertAmountCents);

  const htmlBody = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
</head>
<body style="margin:0;padding:0;background:#f8fafc;font-family:Arial,Helvetica,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f8fafc;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e8f0;max-width:600px;">
        <tr>
          <td style="background:#0f172a;padding:24px 32px;">
            <span style="color:#ffffff;font-size:11px;font-weight:bold;letter-spacing:3px;">EXPERTMATCH</span>
          </td>
        </tr>
        <tr>
          <td style="padding:32px;color:#1e293b;font-size:14px;line-height:1.7;">
            <p style="margin:0 0 16px;">Hi ${expertFirstName},</p>
            <p style="margin:0 0 16px;">Your call is complete and payment has been received.</p>
            <p style="margin:0 0 24px;">
              To receive your <strong>${amountLabel}</strong>, please set up your payout account.
              It takes about 5 minutes:
            </p>
            <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;">
              <tr>
                <td style="background:#0B1F3B;padding:0;">
                  <a href="${onboardingUrl}"
                     style="display:inline-block;padding:12px 28px;color:#C6A75E;font-size:13px;font-weight:bold;text-decoration:none;letter-spacing:0.5px;">
                    Set Up Payout Account →
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:0;font-size:12px;color:#94a3b8;">
              This link expires in 7 days. If you have any questions, reply to this email.
            </p>
          </td>
        </tr>
        <tr>
          <td style="padding:16px 32px;border-top:1px solid #e2e8f0;">
            <p style="margin:0;font-size:11px;color:#94a3b8;">Sent via ExpertMatch</p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const textBody = [
    `Hi ${expertFirstName},`,
    '',
    'Your call is complete and payment has been received.',
    '',
    `To receive your ${amountLabel}, please set up your payout account — it takes about 5 minutes:`,
    '',
    onboardingUrl,
    '',
    'This link expires in 7 days.',
    '',
    '— ExpertMatch',
  ].join('\n');

  const { error } = await resend.emails.send({
    from:    fromAddr,
    to:      expertEmail,
    subject: `Set up your payout account — ${amountLabel} waiting`,
    html:    htmlBody,
    text:    textBody,
  });

  if (error) {
    console.error('[stripe] payout-onboarding-email error:', error.message);
  }
}

// ─── Payout state (pure, unit-tested in scripts/test-payout-state.ts) ─────────

/** At most four onboarding reminders, at most one a week (H-9). */
export const PAYOUT_REMINDER_CAP         = 4;
export const PAYOUT_REMINDER_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;

/** A row whose transfer has failed this many times is not retried again. */
export const MAX_PAYOUT_ATTEMPTS = 5;

/** The fields the per-call payout guard reads. */
export type PayoutGuardView = Pick<
  ProjectExpert,
  'booking' | 'zoomMeetingId' | 'callId' | 'billedCallId' | 'stripeTransferId' | 'paidCallIds'
>;

/**
 * The call this payout is for: the call the client was billed for
 * (`billedCallId`), else whatever identifies the engagement's current call.
 * Null when nothing does — see payoutAlreadySent for what that means. Pure.
 */
export function payoutCallId(pe: PayoutGuardView): string | null {
  return resolveCallId(pe, pe.billedCallId ?? null);
}

/**
 * Durable per-call payout guard. Skip when this call is already in
 * `paidCallIds`.
 *
 * Migration-free compatibility, and the fail-closed direction of each unknown:
 *   * A row with a `stripeTransferId` but no `paidCallIds` predates per-call
 *     payouts. It is treated as paid for whatever call is asked about, so a
 *     deploy can never re-pay a call that was already transferred. The list
 *     starts being written the next time a transfer succeeds.
 *   * A null callId (nothing identifies the call) on a row that has ever been
 *     transferred is treated the same way: "this is a NEW call" cannot be
 *     proved, and money leaving the platform is a fail-closed path.
 * Pure.
 */
export function payoutAlreadySent(pe: PayoutGuardView, callId: string | null): boolean {
  const paidIds = pe.paidCallIds ?? [];
  if (callId && paidIds.includes(callId)) return true;
  if (!pe.stripeTransferId) return false;
  // Transferred at least once, and this call is not in the list.
  return paidIds.length === 0 || !callId;
}

/** The paidCallIds to store after a successful transfer. Pure, no duplicates. */
export function nextPaidCallIds(existing: string[] | undefined, callId: string | null): string[] {
  const list = existing ?? [];
  if (!callId || list.includes(callId)) return list;
  return [...list, callId];
}

/** The fields the onboarding-reminder throttle reads. */
export type ReminderView = Pick<ProjectExpert, 'payoutReminderCount' | 'payoutReminderSentAt'>;

/**
 * H-9: the payout onboarding email is the only outbound path that used to be
 * uncapped — the nightly sweep re-sent it every 24 hours forever. At most
 * PAYOUT_REMINDER_CAP mails, at most one every PAYOUT_REMINDER_INTERVAL_MS.
 * Pure.
 */
export function shouldSendPayoutReminder(pe: ReminderView, now: number): boolean {
  const count = pe.payoutReminderCount ?? 0;
  if (count >= PAYOUT_REMINDER_CAP) return false;
  const last = pe.payoutReminderSentAt;
  if (typeof last === 'number' && Number.isFinite(last) && now - last < PAYOUT_REMINDER_INTERVAL_MS) {
    return false;
  }
  return true;
}

/** The payout fields a sweep reads off a candidate row. */
export interface RetryCandidateView {
  expertOnboardingStatus?: unknown;
  stripeTransferId?:       unknown;
  payoutAttempts?:         unknown;
}

/**
 * H-6: 'failed' used to be terminal — both sweeps selected only 'pending', so a
 * transfer that failed (or one that succeeded while its write did not) was
 * never looked at again. Both states are now retried, bounded by
 * MAX_PAYOUT_ATTEMPTS so a permanently broken payout is not retried nightly
 * forever. Pure.
 */
export function shouldRetryPayoutRow(state: RetryCandidateView): boolean {
  const status = state.expertOnboardingStatus;
  if (status !== 'pending' && status !== 'failed') return false;
  if (typeof state.stripeTransferId === 'string' && state.stripeTransferId) return false;
  const attempts = typeof state.payoutAttempts === 'number' ? state.payoutAttempts : 0;
  return attempts < MAX_PAYOUT_ATTEMPTS;
}

/**
 * The two writes that follow a successful transfer, IN ORDER. The first one
 * carries only the facts that mean "money left the platform"; the second is
 * bookkeeping. Splitting them is the whole of H-6: if the second write fails
 * the transfer id is still on the row, so no sweep and no manual retry can send
 * the money twice. Pure.
 */
export function payoutSuccessPatches(
  transferId:  string,
  accountId:   string,
  callId:      string | null,
  existingIds: string[] | undefined,
  now:         number,
): [UpdateExpertInput, UpdateExpertInput] {
  return [
    { stripeTransferId: transferId, paidCallIds: nextPaidCallIds(existingIds, callId) },
    { expertPaidAt: now, expertOnboardingStatus: 'complete', stripeConnectAccountId: accountId },
  ];
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Pays out (or onboards) the expert for a completed, client-paid call.
 *
 * Never throws — the client payment is already recorded by the time this runs,
 * so every failure is logged and swallowed. Failures that need a human are
 * recorded with recordSystemFailure({ area: 'payout' }) so they reach the admin
 * attention list (lib/attention.ts) instead of only a deploy log.
 */
export async function runExpertPayout(projectId: string, expertId: string): Promise<void> {
  try {
    const project     = await getProject(projectId);
    const pe          = project?.experts.find(e => e.expert.id === expertId);
    const expertEmail = pe?.contactEmail;

    if (!pe) return;

    // Idempotency, per CALL: this call is in paidCallIds (or the row predates
    // that list and has a transfer id). Webhook replays and both retry sweeps
    // land here, so a second run for the same call must be a no-op. A genuine
    // second call carries a different id and is paid. (stripeConnect's transfer
    // also carries a call-keyed idempotency key for the racing case.)
    const callId = payoutCallId(pe);
    if (payoutAlreadySent(pe, callId)) {
      console.log('[stripe] payout-already-sent', { projectId, expertId });
      return;
    }

    if (!expertEmail) {
      console.log('[stripe] expert-email-missing', { projectId, expertId });
      return;
    }

    const expertFirstName = pe.expert.name.split(' ')[0] ?? pe.expert.name;

    // Compute payout server-side — NEVER trust webhook amount
    const rate        = pe.expertRate ?? 0;
    const durationMin = pe.actualDurationMin ?? pe.callDurationMin ?? 0;
    // The expert is paid the rate they accepted over the billable minutes
    // (lib/pricing.ts) — never a share of what the client was charged.
    const expertAmountCents = Math.round(expertPayoutDollars(rate, durationMin) * 100);

    // Check if expert has a Connect account and onboarding is complete
    const connectAccountId = pe.stripeConnectAccountId
      ?? (await getConnectAccountId(expertEmail));

    if (connectAccountId) {
      const onboardingDone = await isOnboardingComplete(connectAccountId);
      if (onboardingDone && expertAmountCents >= 50) {
        let transferId: string;
        try {
          transferId = await transferExpertPayout(
            connectAccountId,
            expertAmountCents,
            projectId,
            expertId,
            callId,
          );
        } catch (transferErr) {
          // The transfer itself failed. The row goes to 'failed' with an
          // incremented attempt count — both sweeps now pick 'failed' rows up
          // again (shouldRetryPayoutRow), and the system_events row puts the
          // expert on the admin attention list instead of leaving the failure
          // in a deploy log nobody reads.
          console.error('[stripe] transfer error:',
            transferErr instanceof Error ? transferErr.message.slice(0, 120) : 'unknown');
          const failPatch: UpdateExpertInput = {
            expertOnboardingStatus: 'failed',
            payoutAttempts:         (pe.payoutAttempts ?? 0) + 1,
            stripeConnectAccountId: connectAccountId,
          };
          await updateExpertStatus(projectId, expertId, failPatch).catch(() => {});
          await recordSystemFailure({
            area:   'payout',
            reason: transferErr,
            projectId,
            expertId,
          });
          return;
        }

        // MONEY HAS LEFT THE PLATFORM. Record the transfer id and the call it
        // paid for on their own, before any other field: a failure here used to
        // send the row to 'failed' with the transfer id lost, which is a payout
        // that either never happens or happens twice (H-6). If this write
        // fails the row is left alone and the failure is recorded — a human
        // reconciles it against Stripe; no sweep can re-send it, because the
        // transfer's idempotency key covers the replay window and the amount is
        // only ever re-derived from the same stored rate.
        const [moneyPatch, bookkeepingPatch] = payoutSuccessPatches(
          transferId,
          connectAccountId,
          callId,
          pe.paidCallIds,
          Date.now(),
        );
        try {
          await updateExpertStatus(projectId, expertId, moneyPatch);
        } catch (writeErr) {
          console.error('[stripe] transfer-id write failed:',
            writeErr instanceof Error ? writeErr.message.slice(0, 120) : 'unknown');
          await recordSystemFailure({
            area:   'payout',
            reason: 'transfer_sent_but_unrecorded',
            projectId,
            expertId,
          });
          return;
        }

        try {
          await updateExpertStatus(projectId, expertId, bookkeepingPatch);
        } catch (writeErr) {
          // Cosmetic by comparison: the transfer id is already stored, so the
          // guard above holds. Recorded so the row is still visibly odd.
          console.error('[stripe] payout bookkeeping write failed:',
            writeErr instanceof Error ? writeErr.message.slice(0, 120) : 'unknown');
          await recordSystemFailure({
            area:   'payout',
            reason: 'payout_recorded_without_completion_fields',
            projectId,
            expertId,
          });
        }
        return;
      }

      if (!onboardingDone) {
        // Account exists but onboarding not complete — re-send the link, at
        // most weekly and four times in total (H-9).
        await updateExpertStatus(projectId, expertId, {
          expertOnboardingStatus: 'pending',
          stripeConnectAccountId: connectAccountId,
        });
        await sendOnboardingLink(projectId, expertId, pe, expertEmail, expertFirstName, expertAmountCents);
      }
      return;
    }

    // No Connect account yet — send onboarding email (same weekly cap).
    await updateExpertStatus(projectId, expertId, { expertOnboardingStatus: 'pending' });
    await sendOnboardingLink(projectId, expertId, pe, expertEmail, expertFirstName, expertAmountCents);
  } catch (err) {
    // Never throw — payment is already recorded
    console.error('[stripe] payout error:', err instanceof Error ? err.message.slice(0, 120) : String(err));
  }
}

// ─── Late-onboarding retry ────────────────────────────────────────────────────

/**
 * Upper bound on the rows one retry pass inspects PER payout status (so at most
 * twice this in total). The set is small by construction — a row is only
 * 'pending' between a paid call and the expert finishing Stripe onboarding, and
 * only 'failed' until MAX_PAYOUT_ATTEMPTS retries — and a webhook must stay
 * fast. Ordering by updated_at makes the excess a delay rather than a starved
 * subset.
 */
const MAX_PENDING_ROWS = 200;

/** The payout state this module records on a ProjectExpert, as stored in `data`. */
type PayoutState = Pick<
  ProjectExpert,
  'stripeConnectAccountId' | 'stripeTransferId' | 'expertOnboardingStatus' | 'payoutAttempts'
>;

/** Reads the payout fields off one project_experts `data` blob. */
function payoutState(data: unknown): PayoutState {
  const d = (data ?? {}) as Partial<PayoutState>;
  return {
    stripeConnectAccountId: d.stripeConnectAccountId,
    stripeTransferId:       d.stripeTransferId,
    expertOnboardingStatus: d.expertOnboardingStatus,
    payoutAttempts:         d.payoutAttempts,
  };
}

/** The two payout states a sweep revisits. Queried one at a time: PostgREST's
 *  `or` over a JSON path is easy to get subtly wrong, and a broken filter here
 *  would silently pay nobody. */
const RETRYABLE_STATUSES = ['pending', 'failed'] as const;

/**
 * Pays every expert whose payout stalled on unfinished Stripe onboarding, or
 * whose transfer failed, and whose Connect account is `accountId`. Called from
 * the account.updated branch of the Stripe webhook AND from the nightly
 * reconcile sweep (app/api/jobs/reconcile/route.ts) — two callers, not one.
 *
 * Candidates are the project_experts rows whose stored payout state is
 * `expertOnboardingStatus: 'pending'` or `'failed'`, with no `stripeTransferId`
 * and fewer than MAX_PAYOUT_ATTEMPTS failed attempts (all of it lives in the
 * row's `data` JSON — only `status` and `contact_email` are promoted columns,
 * see lib/projectStore.ts). 'failed' used to be excluded, which is what made a
 * failed transfer terminal (H-6). Rows are read oldest-write-first so a backlog
 * larger than the bound cannot starve the same rows every night (M-36).
 *
 * A row matches the account either because runExpertPayout already recorded
 * `stripeConnectAccountId`, or because the expert's email maps to it in Redis
 * (the usual case: the account is created when the expert opens the onboarding
 * link, after the payout went pending).
 *
 * Never throws. Logs counts only — never an account id, email, or transfer id.
 */
export async function retryPendingPayoutsForAccount(
  accountId: string,
): Promise<{ attempted: number; paid: number }> {
  const empty = { attempted: 0, paid: 0 };
  if (!accountId) return empty;

  try {
    const db = getServiceRoleClient();
    if (!db) return empty;

    const rows: Array<{
      project_id:    string;
      expert_id:     string;
      contact_email: string | null;
      data:          unknown;
    }> = [];

    for (const status of RETRYABLE_STATUSES) {
      const { data, error } = await db
        .from('project_experts')
        .select('project_id, expert_id, contact_email, data')
        .filter('data->>expertOnboardingStatus', 'eq', status)
        .order('updated_at', { ascending: true })
        .limit(MAX_PENDING_ROWS);

      if (error) {
        console.error('[stripe] pending-payout query failed:', error.message.slice(0, 120));
        return empty;
      }
      if (data) rows.push(...data);
    }

    if (rows.length === 0) return empty;

    let attempted = 0;
    let paid      = 0;

    for (const row of rows) {
      const state = payoutState(row.data);
      if (!shouldRetryPayoutRow(state)) continue;

      let matches = state.stripeConnectAccountId === accountId;
      if (!matches && !state.stripeConnectAccountId && row.contact_email) {
        matches = (await getConnectAccountId(row.contact_email)) === accountId;
      }
      if (!matches) continue;

      attempted++;
      await runExpertPayout(row.project_id, row.expert_id);

      // Ask the row whether money actually moved rather than assuming it did.
      const { data: after } = await db
        .from('project_experts')
        .select('data')
        .eq('project_id', row.project_id)
        .eq('expert_id', row.expert_id)
        .maybeSingle();
      if (payoutState(after?.data).stripeTransferId) paid++;
    }

    if (attempted > 0) console.log('[stripe] payout-retry', { attempted, paid });
    return { attempted, paid };
  } catch (err) {
    console.error('[stripe] payout-retry error:',
      err instanceof Error ? err.message.slice(0, 120) : String(err));
    return empty;
  }
}

// ─── Internal ─────────────────────────────────────────────────────────────────

async function sendOnboardingLink(
  projectId:         string,
  expertId:          string,
  pe:                ReminderView,
  expertEmail:       string,
  expertFirstName:   string,
  expertAmountCents: number,
): Promise<void> {
  if (process.env.DISABLE_EMAILS === 'true') return;

  // H-9: the nightly sweep calls this every night for as long as the row stays
  // pending. Counted and dated on the row so it stops after four, a week apart.
  const now = Date.now();
  if (!shouldSendPayoutReminder(pe, now)) {
    console.log('[stripe] payout-reminder-throttled', {
      projectId,
      expertId,
      sent: pe.payoutReminderCount ?? 0,
    });
    return;
  }
  const reminderPatch: UpdateExpertInput = {
    payoutReminderCount:  (pe.payoutReminderCount ?? 0) + 1,
    payoutReminderSentAt: now,
  };
  // Stamped BEFORE the send: a send that throws must not license a second
  // attempt every night. The cap is on attempts, not on deliveries.
  await updateExpertStatus(projectId, expertId, reminderPatch).catch(() => {});

  const { token }     = generateAvailabilityToken(projectId, expertId);
  const baseUrl       = process.env.NEXT_PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://expertmatch.fit';
  const onboardingUrl = `${baseUrl}/expert-onboarding/${token}`;
  await sendPayoutOnboardingEmail(expertEmail, expertFirstName, expertAmountCents, onboardingUrl);
}
