// POST — public, no auth guard.
// Stripe sends webhook events here. Raw body required.
//
// Handles:
//   checkout.session.completed            → paymentStatus='paid' + expert payout
//   checkout.session.async_payment_failed → paymentStatus='failed'
//   payment_intent.succeeded              → paymentStatus='paid' + expert payout
//                                           (off-session auto-charge path)
//   payment_intent.payment_failed         → paymentStatus='failed'
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
import { runExpertPayout } from '../../../../lib/expertPayout';

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

  // Always return 200
  return NextResponse.json({ received: true });
}
