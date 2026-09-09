// POST — public, no auth guard.
// Stripe sends webhook events here. Raw body required.
//
// Handles:
//   checkout.session.completed            → paymentStatus='paid' + expert payout
//   checkout.session.async_payment_failed → paymentStatus='failed'
//   payment_intent.succeeded              → paymentStatus='paid' + expert payout
//                                           (off-session auto-charge path)
//   payment_intent.payment_failed         → paymentStatus='failed'
//   customer.subscription.updated         → mirror status onto organization_billing
//   customer.subscription.deleted         → mirror status onto organization_billing
//   invoice.payment_failed                → mirror 'past_due' for the org whose
//                                           seat subscription the invoice bills
//   account.updated                       → an expert finished Connect
//                                           onboarding: retry their pending
//                                           payouts (the only retry path)
//
// Both "money received" branches funnel into runExpertPayout()
// (lib/expertPayout.ts), which recomputes the payout server-side from the
// stored expertRate — a webhook payload is never trusted for money.
//
// PaymentIntents created outside the billing flow carry no projectId/expertId
// metadata; those events are acknowledged and ignored.
//
// Required env vars:
//   STRIPE_SECRET_KEY      — server-side Stripe key
//   STRIPE_WEBHOOK_SECRET  — signature verification (requests are rejected
//                            with 400 when it is absent)
//
// NEVER log: expert names, project names, customer emails, card details,
// accountId, transferId.

import { NextRequest, NextResponse } from 'next/server';
import type Stripe from 'stripe';
import { stripe } from '../../../../lib/stripe';
import { updateExpertStatus } from '../../../../lib/projectStore';
import { runExpertPayout, retryPendingPayoutsForAccount } from '../../../../lib/expertPayout';
import { recordSubscriptionStatus } from '../../../../lib/orgBilling';

// ─── Shared branch handlers ───────────────────────────────────────────────────

/** Records a successful client payment, then pays out the expert. */
async function handlePaymentSucceeded(
  projectId: string,
  expertId:  string,
  intentId:  string | null,
): Promise<void> {
  try {
    await updateExpertStatus(projectId, expertId, {
      paymentStatus:         'paid',
      paidAt:                Date.now(),
      ...(intentId ? { stripePaymentIntentId: intentId } : {}),
    });
    console.log('[stripe] payment-succeeded', { projectId, expertId });
  } catch (err) {
    console.error('[stripe] webhook update error:', err instanceof Error ? err.message.slice(0, 120) : String(err));
  }

  // Never throws — the client payment is already recorded.
  await runExpertPayout(projectId, expertId);
}

/**
 * The subscription an invoice bills, on this API version. Since the 2025 basil
 * releases `invoice.subscription` is gone: the link lives under
 * `invoice.parent.subscription_details.subscription`. The legacy top-level
 * field is still read (behind a narrow cast, never `any`) so replayed events
 * from an older API version are handled too.
 */
function subscriptionIdForInvoice(invoice: Stripe.Invoice): string | null {
  const fromParent = invoice.parent?.subscription_details?.subscription;
  if (typeof fromParent === 'string') return fromParent;
  if (fromParent && typeof fromParent === 'object') return fromParent.id;

  const legacy = (invoice as { subscription?: string | { id?: string } }).subscription;
  if (typeof legacy === 'string') return legacy;
  if (legacy && typeof legacy.id === 'string') return legacy.id;
  return null;
}

async function handlePaymentFailed(projectId: string, expertId: string): Promise<void> {
  try {
    await updateExpertStatus(projectId, expertId, { paymentStatus: 'failed' });
    console.log('[stripe] payment-failed', { projectId, expertId });
  } catch (err) {
    console.error('[stripe] webhook update error:', err instanceof Error ? err.message.slice(0, 120) : String(err));
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

  // Signature verified — everything below writes. Deliberate properties of
  // this handler, worth knowing before adding a branch:
  //   * NO EVENT DE-DUPLICATION. event.id is never stored, so every branch must
  //     be safe to run twice. Today they are: the paid/failed writes are
  //     last-writer-wins on the same values, and runExpertPayout guards on the
  //     stored stripeTransferId plus a deterministic transfer idempotency key.
  //   * NO ORDERING GUARANTEE. Stripe may deliver out of order, so a late
  //     customer.subscription.updated can overwrite a 'past_due' mirrored from
  //     invoice.payment_failed; organization_billing is a hint for the UI, not
  //     the ledger — Stripe is.
  //   * NO REFUND BRANCH. charge.refunded / charge.dispute.* are not handled
  //     anywhere in this codebase: a refunded call keeps paymentStatus 'paid'
  //     and the expert payout is not clawed back.
  //   * ALWAYS 200. A branch that fails logs and is dropped, rather than asking
  //     Stripe to redeliver.

  // ── Checkout (payment-link path) ────────────────────────────────────────
  if (event.type === 'checkout.session.completed') {
    const session   = event.data.object as Stripe.Checkout.Session;
    const projectId = session.metadata?.projectId;
    const expertId  = session.metadata?.expertId;
    const intentId  = typeof session.payment_intent === 'string'
      ? session.payment_intent
      : (session.payment_intent as Stripe.PaymentIntent | null)?.id ?? null;

    if (projectId && expertId) {
      await handlePaymentSucceeded(projectId, expertId, intentId);
    }
  }

  if (event.type === 'checkout.session.async_payment_failed') {
    const session   = event.data.object as Stripe.Checkout.Session;
    const projectId = session.metadata?.projectId;
    const expertId  = session.metadata?.expertId;

    if (projectId && expertId) {
      await handlePaymentFailed(projectId, expertId);
    }
  }

  // ── PaymentIntent (off-session auto-charge path) ────────────────────────
  // Guard on metadata: intents created outside this flow are ignored.
  if (event.type === 'payment_intent.succeeded') {
    const intent    = event.data.object as Stripe.PaymentIntent;
    const projectId = intent.metadata?.projectId;
    const expertId  = intent.metadata?.expertId;

    if (projectId && expertId) {
      await handlePaymentSucceeded(projectId, expertId, intent.id);
    }
  }

  if (event.type === 'payment_intent.payment_failed') {
    const intent    = event.data.object as Stripe.PaymentIntent;
    const projectId = intent.metadata?.projectId;
    const expertId  = intent.metadata?.expertId;

    if (projectId && expertId) {
      await handlePaymentFailed(projectId, expertId);
    }
  }

  // ── Per-seat subscription (organization billing) ────────────────────────
  // Mirrored onto organization_billing so the app can tell a firm its billing
  // needs attention without calling Stripe. recordSubscriptionStatus never
  // throws and ignores subscriptions this deployment does not own.
  if (event.type === 'customer.subscription.updated' || event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object as Stripe.Subscription;
    await recordSubscriptionStatus(
      subscription.id,
      // A deleted subscription is terminal regardless of the status Stripe sent.
      event.type === 'customer.subscription.deleted' ? 'canceled' : subscription.status,
    );
  }

  if (event.type === 'invoice.payment_failed') {
    const invoice = event.data.object as Stripe.Invoice;
    const subscriptionId = subscriptionIdForInvoice(invoice);
    // Only subscription invoices matter here; one-off call charges are tracked
    // through payment_intent.payment_failed above.
    if (subscriptionId) {
      await recordSubscriptionStatus(subscriptionId, 'past_due');
    }
  }

  // ── Connect account finished onboarding (expert payout) ─────────────────
  // An expert who set up Stripe AFTER their call was billed has a payout sitting
  // in 'pending'; nothing else ever retries it. isOnboardingComplete()
  // (lib/stripeConnect.ts) treats details_submitted as the bar, and
  // payouts_enabled is the stricter signal that money can actually move —
  // either is worth a sweep, and runExpertPayout re-checks the account before
  // transferring. Never throws; logs counts only.
  if (event.type === 'account.updated') {
    const account = event.data.object as Stripe.Account;
    const ready =
      account.payouts_enabled === true
      || (account.details_submitted === true && account.charges_enabled === true);
    if (ready && account.id) {
      await retryPendingPayoutsForAccount(account.id);
    }
  }

  // Always return 200
  return NextResponse.json({ received: true });
}
