// POST — public, no auth guard.
// Stripe sends webhook events here. Raw body required.
//
// DO NOT add export const config = { api: { bodyParser: false } } — that's Pages Router.
// In App Router, request.text() reads the raw body directly.
//
// Handles:
//   checkout.session.completed         → paymentStatus='paid', send expert payment notification
//   checkout.session.async_payment_failed → paymentStatus='failed'
//
// NEVER log: expert names, project names, customer emails, card details.

import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { Resend } from 'resend';
import { stripe } from '../../../../lib/stripe';
import { getProject, updateExpertStatus } from '../../../../lib/projectStore';

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
    const session    = event.data.object as Stripe.Checkout.Session;
    const projectId  = session.metadata?.projectId;
    const expertId   = session.metadata?.expertId;
    const intentId   = typeof session.payment_intent === 'string'
      ? session.payment_intent
      : (session.payment_intent as Stripe.PaymentIntent | null)?.id ?? null;

    if (projectId && expertId) {
      try {
        await updateExpertStatus(projectId, expertId, {
          paymentStatus:        'paid',
          paidAt:               Date.now(),
          stripePaymentIntentId: intentId ?? undefined,
        });
        console.log('[stripe] payment-succeeded', { projectId, expertId });
      } catch (err) {
        console.error('[stripe] webhook update error:', err instanceof Error ? err.message : String(err));
      }

      // Send expert payment notification email
      try {
        const project = await getProject(projectId);
        const pe      = project?.experts.find(e => e.expert.id === expertId);
        const expertEmail = pe?.contactEmail;

        if (expertEmail && process.env.DISABLE_EMAILS !== 'true') {
          const resendKey = process.env.RESEND_API_KEY;
          const fromAddr  = process.env.OUTREACH_FROM_EMAIL;
          if (resendKey && fromAddr && pe) {
            const resend        = new Resend(resendKey);
            const expertFirstName = pe.expert.name.split(' ')[0] ?? pe.expert.name;
            const durationMin   = pe.actualDurationMin ?? pe.callDurationMin ?? 0;
            const amount        = pe.invoiceAmount ?? 0;

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
            <p style="margin:0 0 16px;">Payment has been received for your recent expert call.</p>
            <p style="margin:0 0 8px;">Call duration: <strong>${durationMin} minutes</strong></p>
            <p style="margin:0 0 24px;">Amount: <strong>$${amount.toLocaleString()}</strong></p>
            <p style="margin:0;font-size:12px;color:#94a3b8;">
              Thank you for your time. We look forward to working with you again.
            </p>
            <p style="margin:8px 0 0;font-size:12px;color:#94a3b8;">ExpertMatch</p>
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
              'Payment has been received for your recent expert call.',
              '',
              `Call duration: ${durationMin} minutes`,
              `Amount: $${amount.toLocaleString()}`,
              '',
              'Thank you for your time. We look forward to working with you again.',
              '',
              'ExpertMatch',
            ].join('\n');

            await resend.emails.send({
              from:    fromAddr,
              to:      expertEmail,
              subject: 'Payment received for your expert call',
              html:    htmlBody,
              text:    textBody,
            });
          }
        } else if (!expertEmail) {
          console.log('[stripe] expert-email-missing', { projectId, expertId });
        }
      } catch (err) {
        // Never throw — payment is already recorded
        console.error('[stripe] expert notification error:', err instanceof Error ? err.message : String(err));
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
