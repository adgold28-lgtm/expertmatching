// POST — public, no auth guard.
// Stripe sends webhook events here. Raw body required.
//
// Handles:
//   checkout.session.completed         → paymentStatus='paid', trigger expert payout or onboarding email
//   checkout.session.async_payment_failed → paymentStatus='failed'
//
// Payout logic (checkout.session.completed):
//   1. Load ProjectExpert from Redis
//   2. Compute expert payout = expertRate × actualDurationMin / 60 × 70% (server-side; never trust webhook amount)
//   3. If stripeConnectAccountId exists and onboarding complete → transferExpertPayout()
//   4. Otherwise → send expert payout onboarding email with 7-day expiry link
//
// NEVER log: expert names, project names, customer emails, card details, accountId, transferId.

import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { Resend } from 'resend';
import { stripe } from '../../../../lib/stripe';
import { getProject, updateExpertStatus } from '../../../../lib/projectStore';
import {
  getConnectAccountId,
  isOnboardingComplete,
  transferExpertPayout,
} from '../../../../lib/stripeConnect';
import { generateAvailabilityToken } from '../../../../lib/availabilityToken';

// ─── Expert payout email ──────────────────────────────────────────────────────

async function sendPayoutOnboardingEmail(
  expertEmail:  string,
  expertFirstName: string,
  expertAmount: number,
  onboardingUrl: string,
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

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const body = await request.text();
  const sig  = request.headers.get('stripe-signature');

  if (!sig || !process.env.STRIPE_WEBHOOK_SECRET) {
    return NextResponse.json({ error: 'missing_signature' }, { status: 400 });
  }

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch {
    return NextResponse.json({ error: 'invalid_signature' }, { status: 400 });
  }

  if (event.type === 'checkout.session.completed') {
    const session   = event.data.object as Stripe.Checkout.Session;
    const projectId = session.metadata?.projectId;
    const expertId  = session.metadata?.expertId;
    const intentId  = typeof session.payment_intent === 'string'
      ? session.payment_intent
      : (session.payment_intent as Stripe.PaymentIntent | null)?.id ?? null;

    if (projectId && expertId) {
      // ── Mark payment as received ────────────────────────────────────────
      try {
        await updateExpertStatus(projectId, expertId, {
          paymentStatus:         'paid',
          paidAt:                Date.now(),
          stripePaymentIntentId: intentId ?? undefined,
        });
        console.log('[stripe] payment-succeeded', { projectId, expertId });
      } catch (err) {
        console.error('[stripe] webhook update error:', err instanceof Error ? err.message : String(err));
      }

      // ── Expert payout ───────────────────────────────────────────────────
      try {
        const project = await getProject(projectId);
        const pe      = project?.experts.find(e => e.expert.id === expertId);
        const expertEmail = pe?.contactEmail;

        if (expertEmail && pe) {
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
            ?? (expertEmail ? await getConnectAccountId(expertEmail) : null);

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
            } else if (!onboardingDone) {
              // Account exists but onboarding not complete — resend link
              await updateExpertStatus(projectId, expertId, {
                expertOnboardingStatus: 'pending',
              });
              if (process.env.DISABLE_EMAILS !== 'true') {
                const { token } = generateAvailabilityToken(projectId, expertId);
                const baseUrl   = process.env.NEXT_PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://expertmatch.fit';
                const onboardingUrl = `${baseUrl}/expert-onboarding/${token}`;
                await sendPayoutOnboardingEmail(expertEmail, expertFirstName, expertAmountDollars, onboardingUrl);
              }
            }
          } else {
            // No Connect account yet — send onboarding email
            await updateExpertStatus(projectId, expertId, {
              expertOnboardingStatus: 'pending',
            });
            if (process.env.DISABLE_EMAILS !== 'true') {
              const { token } = generateAvailabilityToken(projectId, expertId);
              const baseUrl   = process.env.NEXT_PUBLIC_BASE_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? 'https://expertmatch.fit';
              const onboardingUrl = `${baseUrl}/expert-onboarding/${token}`;
              await sendPayoutOnboardingEmail(expertEmail, expertFirstName, expertAmountDollars, onboardingUrl);
            }
          }
        } else if (!expertEmail) {
          console.log('[stripe] expert-email-missing', { projectId, expertId });
        }
      } catch (err) {
        // Never throw — payment is already recorded
        console.error('[stripe] payout error:', err instanceof Error ? err.message.slice(0, 120) : String(err));
      }
    }
  }

  if (event.type === 'checkout.session.async_payment_failed') {
    const session   = event.data.object as Stripe.Checkout.Session;
    const projectId = session.metadata?.projectId;
    const expertId  = session.metadata?.expertId;

    if (projectId && expertId) {
      try {
        await updateExpertStatus(projectId, expertId, { paymentStatus: 'failed' });
        console.log('[stripe] payment-failed', { projectId, expertId });
      } catch (err) {
        console.error('[stripe] webhook update error:', err instanceof Error ? err.message : String(err));
      }
    }
  }

  // Always return 200
  return NextResponse.json({ received: true });
}
