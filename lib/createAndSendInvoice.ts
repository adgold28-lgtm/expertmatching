// lib/createAndSendInvoice.ts
// Shared helper: create Stripe payment link and send invoice email.
// Called from the complete route AND the Zoom meeting.ended webhook.
//
// NEVER log: expert names, client names, emails.
// Amounts are safe to log.

import { Resend } from 'resend';
import { getStripe } from './stripe';
import { getProject, updateExpertStatus, updateProjectFields } from './projectStore';

// ─── Email HTML/text builders (shared with complete route) ────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

export function buildInvoiceHtml(
  clientName:  string,
  expertName:  string,
  durationMin: number,
  amount:      number,
  paymentUrl:  string,
): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Invoice</title>
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
            <p style="margin:0 0 16px;">Hi ${escapeHtml(clientName)},</p>
            <p style="margin:0 0 16px;">
              Your expert call with <strong>${escapeHtml(expertName)}</strong> has been completed
              (${durationMin} minute${durationMin !== 1 ? 's' : ''}).
              Please find your invoice below.
            </p>
            <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;width:100%;border:1px solid #e2e8f0;">
              <tr style="background:#f8fafc;">
                <td style="padding:10px 16px;font-size:12px;color:#64748b;font-weight:bold;text-transform:uppercase;letter-spacing:1px;">Description</td>
                <td style="padding:10px 16px;font-size:12px;color:#64748b;font-weight:bold;text-transform:uppercase;letter-spacing:1px;text-align:right;">Amount</td>
              </tr>
              <tr>
                <td style="padding:12px 16px;font-size:13px;color:#1e293b;">Expert call — ${escapeHtml(expertName)} (${durationMin} min)</td>
                <td style="padding:12px 16px;font-size:13px;color:#1e293b;text-align:right;font-weight:bold;">$${amount.toLocaleString()}</td>
              </tr>
            </table>
            <table cellpadding="0" cellspacing="0" style="margin:0 0 28px;">
              <tr>
                <td style="background:#0d9488;padding:0;">
                  <a href="${escapeHtml(paymentUrl)}"
                     style="display:inline-block;padding:12px 28px;color:#ffffff;font-size:13px;font-weight:bold;text-decoration:none;letter-spacing:0.5px;">
                    Pay Now — $${amount.toLocaleString()}
                  </a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 8px;font-size:12px;color:#64748b;">
              If the button above doesn't work, copy and paste this link into your browser:
            </p>
            <p style="margin:0 0 24px;font-size:11px;color:#94a3b8;word-break:break-all;">
              ${escapeHtml(paymentUrl)}
            </p>
            <p style="margin:0;font-size:12px;color:#94a3b8;">
              Thank you for working with ExpertMatch.
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
}

export function buildInvoiceText(
  clientName:  string,
  expertName:  string,
  durationMin: number,
  amount:      number,
  paymentUrl:  string,
): string {
  return [
    `Hi ${clientName},`,
    '',
    `Your expert call with ${expertName} has been completed (${durationMin} minutes).`,
    '',
    `Invoice amount: $${amount.toLocaleString()}`,
    '',
    `Pay now: ${paymentUrl}`,
    '',
    '— ExpertMatch',
  ].join('\n');
}

// ─── Public API ───────────────────────────────────────────────────────────────

export async function createAndSendInvoice(
  projectId:     string,
  expertId:      string,
  invoiceAmount: number,  // already-computed dollar amount
  durationMin:   number,
): Promise<{ paymentLinkUrl: string } | null> {
  try {
    // 1. Load project and find expert
    const project = await getProject(projectId);
    if (!project) {
      console.error('[stripe] createAndSendInvoice: project not found');
      return null;
    }
    const pe = project.experts.find(e => e.expert.id === expertId);
    if (!pe) {
      console.error('[stripe] createAndSendInvoice: expert not found');
      return null;
    }

    const stripe = getStripe();

    // 2. Create/retrieve Stripe customer for the project
    let stripeCustomerId = project.stripeCustomerId ?? null;
    if (!stripeCustomerId && project.clientEmail) {
      const customer = await stripe.customers.create({
        email:    project.clientEmail,
        name:     project.clientName ?? undefined,
        metadata: { projectId },
      });
      stripeCustomerId = customer.id;
      await updateProjectFields(projectId, { stripeCustomerId });
    }

    // 3. Create Stripe product + price + payment link
    const productName = `Expert Call: ${pe.expert.name} — ${project.researchQuestion.slice(0, 50)}`;
    const product = await stripe.products.create({ name: productName });
    const price   = await stripe.prices.create({
      product:     product.id,
      unit_amount: invoiceAmount * 100,
      currency:    'usd',
    });

    const successUrl = process.env.NEXT_PUBLIC_APP_URL
      ? `${process.env.NEXT_PUBLIC_APP_URL}/payment/success`
      : 'https://expertmatch.ai/payment/success';

    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      metadata:   { projectId, expertId },
      after_completion: {
        type:     'redirect',
        redirect: { url: successUrl },
      },
    });

    // 4. Persist payment link to expert record
    await updateExpertStatus(projectId, expertId, {
      stripePaymentLinkId:  paymentLink.id,
      stripePaymentLinkUrl: paymentLink.url,
      paymentStatus:        'invoice_sent',
    });

    // 5. Send invoice email via Resend (if not suppressed)
    if (process.env.DISABLE_EMAILS !== 'true' && project.clientEmail) {
      const resendKey = process.env.RESEND_API_KEY;
      const fromAddr  = process.env.OUTREACH_FROM_EMAIL;
      if (resendKey && fromAddr) {
        const resend     = new Resend(resendKey);
        const clientName = project.clientName ?? 'there';
        await resend.emails.send({
          from:    fromAddr,
          to:      project.clientEmail,
          subject: 'Invoice for your expert call',
          html:    buildInvoiceHtml(clientName, pe.expert.name, durationMin, invoiceAmount, paymentLink.url),
          text:    buildInvoiceText(clientName, pe.expert.name, durationMin, invoiceAmount, paymentLink.url),
        });
      }
    }

    // 6. Log (no PII)
    console.log('[stripe] payment-link-created', { amount: invoiceAmount, projectId });

    return { paymentLinkUrl: paymentLink.url };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[stripe] createAndSendInvoice error:', msg);
    return null;
  }
}
