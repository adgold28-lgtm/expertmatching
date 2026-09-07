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
//   1. Load the ProjectExpert; skip if already paid (stripeTransferId set) or
//      if there is no contact email.
//   2. If the expert has a Connect account with onboarding complete → transfer.
//   3. Otherwise → mark payout pending and email a 7-day onboarding link.
//
// Payouts left pending because the expert had not finished Stripe onboarding
// are retried by retryPendingPayoutsForAccount(), called from the
// account.updated branch of the Stripe webhook. Nothing else retries.
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
import { getServiceRoleClient } from './supabase/admin';
import {
  getConnectAccountId,
  isOnboardingComplete,
  transferExpertPayout,
} from './stripeConnect';
import { generateAvailabilityToken } from './availabilityToken';
import { expertPayoutDollars, formatUsdFromCents } from './pricing';
import { getFromAddress } from './mailFrom';

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

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Pays out (or onboards) the expert for a completed, client-paid call.
 *
 * Never throws — the client payment is already recorded by the time this runs,
 * so every failure is logged and swallowed.
 */
export async function runExpertPayout(projectId: string, expertId: string): Promise<void> {
  try {
    const project     = await getProject(projectId);
    const pe          = project?.experts.find(e => e.expert.id === expertId);
    const expertEmail = pe?.contactEmail;

    if (!pe) return;

    // Idempotency: a recorded transfer means this expert has already been paid
    // for this call. Webhook replays and the account.updated retry sweep both
    // land here, so a second call must be a no-op. (stripeConnect's transfer
    // also carries a deterministic idempotency key for the racing case.)
    if (pe.stripeTransferId) {
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
        try {
          const transferId = await transferExpertPayout(
            connectAccountId,
            expertAmountCents,
            projectId,
            expertId,
          );
          await updateExpertStatus(projectId, expertId, {
            stripeTransferId:       transferId,
            expertPaidAt:           Date.now(),
            expertOnboardingStatus: 'complete',
            stripeConnectAccountId: connectAccountId,
          });
        } catch (transferErr) {
          console.error('[stripe] transfer error:',
            transferErr instanceof Error ? transferErr.message.slice(0, 120) : 'unknown');
          await updateExpertStatus(projectId, expertId, {
            expertOnboardingStatus: 'failed',
          });
        }
        return;
      }

      if (!onboardingDone) {
        // Account exists but onboarding not complete — resend link
        await updateExpertStatus(projectId, expertId, { expertOnboardingStatus: 'pending' });
        await sendOnboardingLink(projectId, expertId, expertEmail, expertFirstName, expertAmountCents);
      }
      return;
    }

    // No Connect account yet — send onboarding email
    await updateExpertStatus(projectId, expertId, { expertOnboardingStatus: 'pending' });
    await sendOnboardingLink(projectId, expertId, expertEmail, expertFirstName, expertAmountCents);
  } catch (err) {
    // Never throw — payment is already recorded
    console.error('[stripe] payout error:', err instanceof Error ? err.message.slice(0, 120) : String(err));
  }
}

// ─── Late-onboarding retry ────────────────────────────────────────────────────

/**
 * Upper bound on the pending-payout rows one account.updated event may inspect.
 * The set is small by construction (a row is only 'pending' between a paid call
 * and the expert finishing Stripe onboarding), and a webhook must stay fast.
 */
const MAX_PENDING_ROWS = 200;

/** The payout state this module records on a ProjectExpert, as stored in `data`. */
type PayoutState = Pick<
  ProjectExpert,
  'stripeConnectAccountId' | 'stripeTransferId' | 'expertOnboardingStatus'
>;

/** Reads the payout fields off one project_experts `data` blob. */
function payoutState(data: unknown): PayoutState {
  const d = (data ?? {}) as Partial<PayoutState>;
  return {
    stripeConnectAccountId: d.stripeConnectAccountId,
    stripeTransferId:       d.stripeTransferId,
    expertOnboardingStatus: d.expertOnboardingStatus,
  };
}

/**
 * Pays every expert whose payout stalled on unfinished Stripe onboarding and
 * whose Connect account is `accountId`. Called from the account.updated branch
 * of the Stripe webhook — the only retry path in the system.
 *
 * Candidates are the project_experts rows whose stored payout state is
 * `expertOnboardingStatus: 'pending'` with no `stripeTransferId` (both live in
 * the row's `data` JSON — only `status` and `contact_email` are promoted
 * columns, see lib/projectStore.ts). A row matches the account either because
 * runExpertPayout already recorded `stripeConnectAccountId`, or because the
 * expert's email maps to it in Redis (the usual case: the account is created
 * when the expert opens the onboarding link, after the payout went pending).
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

    const { data: rows, error } = await db
      .from('project_experts')
      .select('project_id, expert_id, contact_email, data')
      .filter('data->>expertOnboardingStatus', 'eq', 'pending')
      .limit(MAX_PENDING_ROWS);

    if (error) {
      console.error('[stripe] pending-payout query failed:', error.message.slice(0, 120));
      return empty;
    }
    if (!rows || rows.length === 0) return empty;

    let attempted = 0;
    let paid      = 0;

    for (const row of rows) {
      const state = payoutState(row.data);
      if (state.stripeTransferId) continue;

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
  expertEmail:       string,
  expertFirstName:   string,
  expertAmountCents: number,
): Promise<void> {
  if (process.env.DISABLE_EMAILS === 'true') return;
  const { token }     = generateAvailabilityToken(projectId, expertId);
  const baseUrl       = process.env.NEXT_PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://expertmatch.fit';
  const onboardingUrl = `${baseUrl}/expert-onboarding/${token}`;
  await sendPayoutOnboardingEmail(expertEmail, expertFirstName, expertAmountCents, onboardingUrl);
}
