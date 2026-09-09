// lib/createAndSendInvoice.ts
// Shared billing helper for a completed expert call. Called from the complete
// route AND the Zoom meeting.ended webhook.
//
// Two paths, decided per call:
//   1. SAVED CARD — the FIRM that owns the project has a default payment method
//      (falling back to the project owner's legacy per-user card). Charge it
//      off-session (lib/chargeSavedCard.ts) and email a receipt. Idempotent per
//      (projectId, expertId, callId): one charge per CALL, so a repeat
//      consultation with the same expert on the same project bills again.
//   2. PAYMENT LINK — no saved card, or the card needs SCA / was declined.
//      Create a Stripe product + price + payment link, mark the engagement
//      'invoice_sent', and email a pay-now invoice. This is the pre-existing
//      behaviour, unchanged.
//
// Required env vars:
//   STRIPE_SECRET_KEY    — server-side Stripe key
//   RESEND_API_KEY       — invoice / receipt email (optional; skipped if absent)
//   OUTREACH_FROM_EMAIL  — sender address (optional; skipped if absent)
//   NEXT_PUBLIC_APP_URL  — payment-link success redirect
//   DISABLE_EMAILS       — 'true' suppresses all outbound mail
//
// NEVER log: expert names, client names, emails.
// Amounts and projectId are safe to log.

import { Resend } from 'resend';
import type { ProjectExpert } from '../types';
import { getStripe } from './stripe';
import { getProject, updateExpertStatus, updateProjectFields } from './projectStore';
import type { UpdateExpertInput } from './projectStore';
import { chargeSavedCard } from './chargeSavedCard';
import { getEntitlementsForProject, recordRestrictedAttempt } from './entitlements';
import { getFromAddress } from './mailFrom';

// ─── Email HTML/text builders (shared with complete route) ────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}

/** Shared branded shell so the invoice and the receipt stay visually identical. */
function renderEmailShell(innerHtml: string): string {
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
${innerHtml}
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

/** Line-item table shared by both email variants. */
function renderLineItem(expertName: string, durationMin: number, amount: number): string {
  return `            <table cellpadding="0" cellspacing="0" style="margin:0 0 24px;width:100%;border:1px solid #e2e8f0;">
              <tr style="background:#f8fafc;">
                <td style="padding:10px 16px;font-size:12px;color:#64748b;font-weight:bold;text-transform:uppercase;letter-spacing:1px;">Description</td>
                <td style="padding:10px 16px;font-size:12px;color:#64748b;font-weight:bold;text-transform:uppercase;letter-spacing:1px;text-align:right;">Amount</td>
              </tr>
              <tr>
                <td style="padding:12px 16px;font-size:13px;color:#1e293b;">Expert call — ${escapeHtml(expertName)} (${durationMin} min)</td>
                <td style="padding:12px 16px;font-size:13px;color:#1e293b;text-align:right;font-weight:bold;">$${amount.toLocaleString()}</td>
              </tr>
            </table>`;
}

export function buildInvoiceHtml(
  clientName:  string,
  expertName:  string,
  durationMin: number,
  amount:      number,
  paymentUrl:  string,
): string {
  return renderEmailShell(`            <p style="margin:0 0 16px;">Hi ${escapeHtml(clientName)},</p>
            <p style="margin:0 0 16px;">
              Your expert call with <strong>${escapeHtml(expertName)}</strong> has been completed
              (${durationMin} minute${durationMin !== 1 ? 's' : ''}).
              Please find your invoice below.
            </p>
${renderLineItem(expertName, durationMin, amount)}
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
            </p>`);
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

/** Receipt for the auto-charge path — the client has already been charged. */
export function buildReceiptHtml(
  clientName:  string,
  expertName:  string,
  durationMin: number,
  amount:      number,
): string {
  return renderEmailShell(`            <p style="margin:0 0 16px;">Hi ${escapeHtml(clientName)},</p>
            <p style="margin:0 0 16px;">
              Your expert call with <strong>${escapeHtml(expertName)}</strong> has been completed
              (${durationMin} minute${durationMin !== 1 ? 's' : ''}).
              We charged the card on file — no action is needed.
            </p>
${renderLineItem(expertName, durationMin, amount)}
            <p style="margin:0 0 24px;font-size:13px;color:#1e293b;">
              <strong>Total charged: $${amount.toLocaleString()}</strong>
            </p>
            <p style="margin:0 0 8px;font-size:12px;color:#64748b;">
              This receipt is for your records. To change the card on file, visit
              your billing settings.
            </p>
            <p style="margin:0;font-size:12px;color:#94a3b8;">
              Thank you for working with ExpertMatch.
            </p>`);
}

export function buildReceiptText(
  clientName:  string,
  expertName:  string,
  durationMin: number,
  amount:      number,
): string {
  return [
    `Hi ${clientName},`,
    '',
    `Your expert call with ${expertName} has been completed (${durationMin} minutes).`,
    '',
    `We charged the card on file — no action is needed.`,
    '',
    `Total charged: $${amount.toLocaleString()}`,
    '',
    'This receipt is for your records.',
    '',
    '— ExpertMatch',
  ].join('\n');
}

// ─── Email sending ────────────────────────────────────────────────────────────

interface SendEmailParams {
  to:      string;
  subject: string;
  html:    string;
  text:    string;
}

/** Best-effort transactional send. No-ops when email is disabled/unconfigured. */
async function sendClientEmail(params: SendEmailParams): Promise<void> {
  if (process.env.DISABLE_EMAILS === 'true') return;

  const resendKey = process.env.RESEND_API_KEY;
  const fromAddr  = getFromAddress();
  if (!resendKey || !params.to) return;

  const resend = new Resend(resendKey);
  await resend.emails.send({
    from:    fromAddr,
    to:      params.to,
    subject: params.subject,
    html:    params.html,
    text:    params.text,
  });
}

// ─── The per-call double-bill guard (pure) ────────────────────────────────────

/** The only fields the durable guard reads. */
export type BillingGuardView = Pick<
  ProjectExpert,
  'paymentStatus' | 'stripePaymentIntentId' | 'billedCallId'
>;

/**
 * Identity of the call being billed: what the caller passed, else the booking's
 * ICS uid, else the Zoom meeting id, else the id the manual complete route
 * invented for a call that had neither. Null when nothing identifies the call.
 */
export function resolveCallId(
  pe:     Pick<ProjectExpert, 'booking' | 'zoomMeetingId' | 'callId'>,
  passed?: string | null,
): string | null {
  return passed ?? pe.booking?.icsUid ?? pe.zoomMeetingId ?? pe.callId ?? null;
}

/**
 * Durable double-bill guard, keyed on the CALL rather than on
 * (projectId, expertId) — H-8. Stripe's idempotency key only covers ~24 hours,
 * so this is what stops a re-completion, a replayed Zoom webhook or a manual
 * completion of an already-billed call from charging the client twice.
 *
 * Skip when the row is already billed (paid, or an auto-charge is in flight)
 * AND that billing belongs to THIS call. A different billedCallId means a
 * genuine second call, which is billed again.
 *
 * Migration-free compatibility: rows written before `billedCallId` existed have
 * none, and there is no backfill. An already-billed row with no billedCallId is
 * therefore treated as billed for whatever call is being asked about, so
 * nothing already charged is re-charged on deploy; the field starts being
 * written the next time a charge succeeds. A call that nothing identifies
 * (callId null) is treated the same way, because "this is a new call" cannot be
 * proved and money is a fail-closed path.
 */
export function shouldSkipBilling(pe: BillingGuardView, callId: string | null): boolean {
  const alreadyBilled = pe.paymentStatus === 'paid' || !!pe.stripePaymentIntentId;
  if (!alreadyBilled) return false;
  if (pe.billedCallId === undefined || pe.billedCallId === null) return true;
  if (!callId) return true;
  return pe.billedCallId === callId;
}

/**
 * True when the row is already billed but for a DIFFERENT call — the repeat
 * consultation case, where the stale `paid` has to be cleared before charging
 * so the payment webhook's `paid` write refers to the new call.
 */
export function isRepeatCallForBilledRow(pe: BillingGuardView, callId: string | null): boolean {
  const alreadyBilled = pe.paymentStatus === 'paid' || !!pe.stripePaymentIntentId;
  return alreadyBilled && !shouldSkipBilling(pe, callId);
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface InvoiceResult {
  /** True when the client's saved card was charged off-session. */
  charged:         boolean;
  /** Present only on the payment-link path. */
  paymentLinkUrl:  string | null;
  /** Present only on the auto-charge path. */
  paymentIntentId: string | null;
}

/**
 * Bills a completed expert call.
 *
 * Charges the firm's saved card when one exists (legacy: the project owner's);
 * otherwise (or when the card needs SCA / was declined) falls back to the
 * manual payment link so
 * the client can always pay. Returns null only when the project or expert
 * cannot be loaded, or the payment link could not be created.
 *
 * `callId` identifies the call being billed and is optional: callers that do
 * not pass one (the Zoom webhook) get it derived from the row — see
 * resolveCallId. Only the manual complete route has to invent one.
 */
export async function createAndSendInvoice(
  projectId:     string,
  expertId:      string,
  invoiceAmount: number,  // already-computed dollar amount
  durationMin:   number,
  callId?:       string | null,
): Promise<InvoiceResult | null> {
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

    // Account boundary (lib/entitlements.ts): an organization with no card on
    // file is never charged and never emailed an invoice. A trial cannot book
    // a call in the first place; this is the backstop for every caller.
    const entitlements = await getEntitlementsForProject(projectId);
    if (!entitlements.canCharge) {
      console.warn('[stripe] createAndSendInvoice refused: activation required', { projectId });
      await recordRestrictedAttempt(entitlements, { action: 'charge_card', projectId, expertId });
      return null;
    }

    // 2. Durable double-bill guard, per CALL — see shouldSkipBilling above.
    //    An engagement already billed for THIS call is never billed again; a
    //    genuine second call with the same expert is. (An 'invoice_sent'
    //    engagement with no intent still re-runs, so a lost payment-link email
    //    can be regenerated.)
    const resolvedCallId = resolveCallId(pe, callId);
    if (shouldSkipBilling(pe, resolvedCallId)) {
      console.log('[stripe] already-billed-skip', { projectId });
      return {
        charged:         !!pe.stripePaymentIntentId && !pe.stripePaymentLinkUrl,
        paymentLinkUrl:  pe.stripePaymentLinkUrl ?? null,
        paymentIntentId: pe.stripePaymentIntentId ?? null,
      };
    }

    // A repeat call on a row that still carries the previous call's 'paid':
    //    clear it before charging so the payment_intent.succeeded write that
    //    follows this charge refers to the NEW call, not the old one.
    if (isRepeatCallForBilledRow(pe, resolvedCallId)) {
      await updateExpertStatus(projectId, expertId, { paymentStatus: 'unpaid' });
      console.log('[stripe] repeat-call-rebill', { projectId });
    }

    const clientName    = project.clientName ?? 'there';
    // The saved card belongs to the project's FIRM (or, for legacy accounts,
    // its owner); the invoice email still goes to the project's client contact
    // when one is set — unchanged.
    const recipientEmail = project.clientEmail ?? project.ownerEmail;

    // ─── Path 1: charge the saved card off-session ─────────────────────────
    const charge = await chargeSavedCard({
      projectId,
      expertId,
      ownerEmail: project.ownerEmail,
      amount:     invoiceAmount,
      callId:     resolvedCallId,
    });

    if (charge.outcome === 'charged') {
      // Persist the intent id immediately so a webhook retry, or a later
      // reconciliation, can always tie the charge back to this engagement, and
      // the call it belongs to alongside it so the guard above can tell this
      // call from the next one. paymentStatus is advanced to 'paid' by the
      // payment_intent.succeeded webhook, which also runs the expert payout.
      const chargePatch: UpdateExpertInput = {
        stripePaymentIntentId: charge.paymentIntentId,
        billedCallId:          resolvedCallId,
      };
      await updateExpertStatus(projectId, expertId, chargePatch);

      await sendClientEmail({
        to:      recipientEmail,
        subject: 'Receipt for your expert call',
        html:    buildReceiptHtml(clientName, pe.expert.name, durationMin, invoiceAmount),
        text:    buildReceiptText(clientName, pe.expert.name, durationMin, invoiceAmount),
      });

      console.log('[stripe] auto-charge-invoice-sent', { amount: invoiceAmount, projectId });

      return {
        charged:         true,
        paymentLinkUrl:  null,
        paymentIntentId: charge.paymentIntentId,
      };
    }

    // ─── Path 2: payment link (no saved card, SCA required, or declined) ───
    if (charge.outcome !== 'no_saved_card') {
      console.log('[stripe] falling-back-to-payment-link', {
        projectId,
        reason: charge.outcome,
      });
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
    // No expert name on the product: it surfaces on card statements and Stripe
    // receipts, which are not covered by the platform's identity-reveal rules.
    // The project name is enough for the client to reconcile the charge.
    const productName = `Expert Call — ${project.name}`;
    const product = await stripe.products.create({ name: productName });
    const price   = await stripe.prices.create({
      product:     product.id,
      unit_amount: invoiceAmount * 100,
      currency:    'usd',
    });

    const successUrl = process.env.NEXT_PUBLIC_APP_URL
      ? `${process.env.NEXT_PUBLIC_APP_URL}/payment/success`
      : 'https://expertmatch.fit/payment/success';

    const paymentLink = await stripe.paymentLinks.create({
      line_items: [{ price: price.id, quantity: 1 }],
      metadata:   { projectId, expertId },
      after_completion: {
        type:     'redirect',
        redirect: { url: successUrl },
      },
    });

    // 4. Persist payment link to expert record
    // The call id is recorded on this path too: when the client pays the link,
    // the webhook writes 'paid' onto a row that already knows which call it was,
    // so the NEXT call is still billable.
    const linkPatch: UpdateExpertInput = {
      stripePaymentLinkId:  paymentLink.id,
      stripePaymentLinkUrl: paymentLink.url,
      paymentStatus:        'invoice_sent',
      billedCallId:         resolvedCallId,
    };
    await updateExpertStatus(projectId, expertId, linkPatch);

    // 5. Send invoice email via Resend (if not suppressed)
    if (project.clientEmail) {
      await sendClientEmail({
        to:      project.clientEmail,
        subject: 'Invoice for your expert call',
        html:    buildInvoiceHtml(clientName, pe.expert.name, durationMin, invoiceAmount, paymentLink.url),
        text:    buildInvoiceText(clientName, pe.expert.name, durationMin, invoiceAmount, paymentLink.url),
      });
    }

    // 6. Log (no PII)
    console.log('[stripe] payment-link-created', { amount: invoiceAmount, projectId });

    return {
      charged:         false,
      paymentLinkUrl:  paymentLink.url,
      paymentIntentId: null,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[stripe] createAndSendInvoice error:', msg.slice(0, 120));
    return null;
  }
}
