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
import { getProject, updateExpertStatus } from '../../../../lib/projectStore';
import { runExpertPayout, retryPendingPayoutsForAccount } from '../../../../lib/expertPayout';
import { recordSubscriptionStatus } from '../../../../lib/orgBilling';
import { checkoutSessionSettled, isPermanentFailure } from '../../../../lib/stripeEvents';

// ─── Shared branch handlers ───────────────────────────────────────────────────

/**
 * Records a successful client payment, then pays out the expert.
 *
 * Returns false when the durable write failed. The caller turns that into a
 * 500 so STRIPE RETRIES the event: this used to swallow the error and still
 * answer 200, which meant a transient database failure silently lost the
 * payment — the money was taken, nothing recorded it, and no retry ever came.
 *
 * The payout only runs once the paid state is actually persisted. Otherwise a
 * retry would re-enter with the engagement still 'unpaid', and runExpertPayout
 * now refuses to move money in that state anyway.
 */
async function handlePaymentSucceeded(
  projectId: string,
  expertId:  string,
  intentId:  string | null,
): Promise<boolean> {
  try {
    await updateExpertStatus(projectId, expertId, {
      paymentStatus:         'paid',
      paidAt:                Date.now(),
      ...(intentId ? { stripePaymentIntentId: intentId } : {}),
    });
    console.log('[stripe] payment-succeeded', { projectId, expertId });
  } catch (err) {
    console.error('[stripe] webhook update error:', err instanceof Error ? err.message.slice(0, 120) : String(err));
    if (isPermanentFailure(err)) {
      // The engagement is gone. Acknowledge so Stripe stops redelivering.
      console.error('[stripe] webhook-permanent-failure', { projectId, expertId, event: 'payment_succeeded' });
      return true;
    }
    return false;
  }

  // Never throws — the client payment is already recorded.
  await runExpertPayout(projectId, expertId);
  return true;
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

/**
 * Records a failed client payment. Returns false when the write failed, so the
 * caller can 500 and let Stripe retry.
 *
 * 'paid' is TERMINAL here. Stripe delivers events without an ordering
 * guarantee, so a late payment_failed for an earlier attempt could otherwise
 * overwrite a payment that has already succeeded — marking a charged call
 * unpaid and, worse, re-opening it for a second charge. A failure that arrives
 * after a success is logged and dropped. (Full per-event ordering across
 * different event ids is still open — see SECURITY_AUDIT.md R7.)
 */
async function handlePaymentFailed(projectId: string, expertId: string): Promise<boolean> {
  try {
    const project = await getProject(projectId);
    const pe      = project?.experts.find(e => e.expert.id === expertId);
    if (pe?.paymentStatus === 'paid') {
      console.log('[stripe] payment-failed-ignored-already-paid', { projectId, expertId });
      return true;
    }
    await updateExpertStatus(projectId, expertId, { paymentStatus: 'failed' });
    console.log('[stripe] payment-failed', { projectId, expertId });
  } catch (err) {
    console.error('[stripe] webhook update error:', err instanceof Error ? err.message.slice(0, 120) : String(err));
    if (isPermanentFailure(err)) {
      console.error('[stripe] webhook-permanent-failure', { projectId, expertId, event: 'payment_failed' });
      return true;
    }
    return false;
  }
  return true;
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

  // Set by any branch whose durable write failed. A 500 tells Stripe to
  // redeliver the event; every handler below is safe to re-run.
  let failed = false;

  // ── Checkout (payment-link path) ────────────────────────────────────────
  // `completed` means the customer finished the session, NOT that the money
  // arrived: for a delayed-notification method the session completes with
  // payment_status 'unpaid' and settles (or fails) days later. Paying the
  // expert on `completed` alone transferred platform funds against a payment
  // that had not cleared and might never. The money signal is payment_status,
  // and `async_payment_succeeded` is the event that carries the later 'paid'.
  if (event.type === 'checkout.session.completed'
      || event.type === 'checkout.session.async_payment_succeeded') {
    const session   = event.data.object as Stripe.Checkout.Session;
    const projectId = session.metadata?.projectId;
    const expertId  = session.metadata?.expertId;
    const intentId  = typeof session.payment_intent === 'string'
      ? session.payment_intent
      : (session.payment_intent as Stripe.PaymentIntent | null)?.id ?? null;

    const settled = checkoutSessionSettled(session.payment_status);

    if (projectId && expertId) {
      if (settled) {
        if (!(await handlePaymentSucceeded(projectId, expertId, intentId))) failed = true;
      } else {
        // Not an error, and not a failure either — the session is waiting on an
        // async payment. Stripe will send async_payment_succeeded/failed.
        console.log('[stripe] checkout-awaiting-payment', {
          projectId, expertId, paymentStatus: session.payment_status,
        });
      }
    }
  }

  if (event.type === 'checkout.session.async_payment_failed') {
    const session   = event.data.object as Stripe.Checkout.Session;
    const projectId = session.metadata?.projectId;
    const expertId  = session.metadata?.expertId;

    if (projectId && expertId) {
      if (!(await handlePaymentFailed(projectId, expertId))) failed = true;
    }
  }

  // ── PaymentIntent (off-session auto-charge path) ────────────────────────
  // Guard on metadata: intents created outside this flow are ignored.
  if (event.type === 'payment_intent.succeeded') {
    const intent    = event.data.object as Stripe.PaymentIntent;
    const projectId = intent.metadata?.projectId;
    const expertId  = intent.metadata?.expertId;

    if (projectId && expertId) {
      if (!(await handlePaymentSucceeded(projectId, expertId, intent.id))) failed = true;
    }
  }

  if (event.type === 'payment_intent.payment_failed') {
    const intent    = event.data.object as Stripe.PaymentIntent;
    const projectId = intent.metadata?.projectId;
    const expertId  = intent.metadata?.expertId;

    if (projectId && expertId) {
      if (!(await handlePaymentFailed(projectId, expertId))) failed = true;
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

  // A swallowed failure used to answer 200, which told Stripe the event was
  // handled and retired it forever. A TRANSIENT failure now gets a 500 and
  // Stripe's normal retry schedule; a permanent one (the engagement no longer
  // exists) is recorded and acknowledged, because redelivering it forever only
  // risks the endpoint being disabled. See isPermanentFailure.
  if (failed) {
    return NextResponse.json({ error: 'handler_failed' }, { status: 500 });
  }
  return NextResponse.json({ received: true });
}
