// lib/expertPayout.ts
// Expert payout for a paid expert call — shared by every "client money
// received" webhook branch (checkout.session.completed and
// payment_intent.succeeded).
//
// The payout amount is ALWAYS recomputed server-side from the stored
// expertRate and duration. A webhook payload is never trusted for money:
//   payout = round(expertRate × (actualDurationMin ?? callDurationMin) / 60) × 70%
//
// Behaviour:
//   1. Load the ProjectExpert; skip silently if there is no contact email.
//   2. If the expert has a Connect account with onboarding complete → transfer.
//   3. Otherwise → mark payout pending and email a 7-day onboarding link.
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
import { getProject, updateExpertStatus } from './projectStore';
import {
  getConnectAccountId,
  isOnboardingComplete,
  transferExpertPayout,
} from './stripeConnect';
import { generateAvailabilityToken } from './availabilityToken';

// ─── Expert payout email ──────────────────────────────────────────────────────

export async function sendPayoutOnboardingEmail(
  expertEmail:     string,
  expertFirstName: string,
  expertAmount:    number,
  onboardingUrl:   string,
): Promise<void> {
  if (process.env.DISABLE_EMAILS === 'true') return;

  const resendKey = process.env.RESEND_API_KEY;
  const fromAddr  = process.env.OUTREACH_FROM_EMAIL;
  if (!resendKey || !fromAddr) return;

  const resend = new Resend(resendKey);

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
              To receive your <strong>$${expertAmount.toLocaleString()}</strong>, please set up your payout account.
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
    `To receive your $${expertAmount.toLocaleString()}, please set up your payout account — it takes about 5 minutes:`,
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
    subject: `Set up your payout account — $${expertAmount.toLocaleString()} waiting`,
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

    if (!pe || !expertEmail) {
      if (!expertEmail) console.log('[stripe] expert-email-missing', { projectId, expertId });
      return;
    }

    const expertFirstName = pe.expert.name.split(' ')[0] ?? pe.expert.name;

    // Compute payout server-side — NEVER trust webhook amount
    const rate        = pe.expertRate ?? 0;
    const durationMin = pe.actualDurationMin ?? pe.callDurationMin ?? 0;
    const grossAmount = rate > 0 && durationMin > 0
      ? Math.round((rate * durationMin) / 60)
      : (pe.invoiceAmount ?? 0);
    const expertAmountDollars = Math.round(grossAmount * 0.70);
    const expertAmountCents   = expertAmountDollars * 100;

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
        await sendOnboardingLink(projectId, expertId, expertEmail, expertFirstName, expertAmountDollars);
      }
      return;
    }

    // No Connect account yet — send onboarding email
    await updateExpertStatus(projectId, expertId, { expertOnboardingStatus: 'pending' });
    await sendOnboardingLink(projectId, expertId, expertEmail, expertFirstName, expertAmountDollars);
  } catch (err) {
    // Never throw — payment is already recorded
    console.error('[stripe] payout error:', err instanceof Error ? err.message.slice(0, 120) : String(err));
  }
}

// ─── Internal ─────────────────────────────────────────────────────────────────

async function sendOnboardingLink(
  projectId:       string,
  expertId:        string,
  expertEmail:     string,
  expertFirstName: string,
  expertAmount:    number,
): Promise<void> {
  if (process.env.DISABLE_EMAILS === 'true') return;
  const { token }     = generateAvailabilityToken(projectId, expertId);
  const baseUrl       = process.env.NEXT_PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://expertmatch.fit';
  const onboardingUrl = `${baseUrl}/expert-onboarding/${token}`;
  await sendPayoutOnboardingEmail(expertEmail, expertFirstName, expertAmount, onboardingUrl);
}
