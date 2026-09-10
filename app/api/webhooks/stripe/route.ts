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
//                                           payouts (with the nightly sweep,
//                                           one of two retry paths)
//   charge.refunded                       → paymentStatus='refunded' + alert
//   charge.dispute.created                → paymentStatus='refunded' + alert
//
// EVENTS THAT MUST BE ENABLED ON THE STRIPE ENDPOINT for the branches below to
// ever run: checkout.session.completed, checkout.session.async_payment_failed,
// payment_intent.succeeded, payment_intent.payment_failed,
// customer.subscription.updated, customer.subscription.deleted,
// invoice.payment_failed, charge.refunded, charge.dispute.created, and
// account.updated on CONNECTED accounts.
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
// WHAT LIVES WHERE: this file verifies the signature and answers; every branch
// lives in ./handlers.ts as handleStripeEvent(event, deps) — a route.ts may not
// export helper values (Next type-checks its exports), and the branches need a
// test seam. scripts/test-stripe-flows.ts drives handleStripeEvent with stubs;
// scripts/test-webhook-signature.ts drives verifyStripeSignature with real HMAC
// fixtures. Behaviour, status codes and JSON bodies are unchanged.
//
// NEVER log: expert names, project names, customer emails, card details,
// accountId, transferId.

import { NextRequest, NextResponse } from 'next/server';
import { handleStripeEvent, verifyStripeSignature } from './handlers';

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  // Raw text, never request.json(): the signature is computed over these bytes.
  const body = await request.text();
  const sig  = request.headers.get('stripe-signature');

  const verified = verifyStripeSignature(body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  if (!verified.ok) {
    return NextResponse.json({ error: verified.error }, { status: 400 });
  }

  // Signature verified — everything below writes. The event is de-duplicated
  // and dispatched in ./handlers.ts, which always resolves (a failing branch
  // logs and is dropped) so Stripe always sees 200.
  const outcome = await handleStripeEvent(verified.event);
  return NextResponse.json(outcome);
}
