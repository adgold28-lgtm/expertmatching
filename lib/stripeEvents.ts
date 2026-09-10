// lib/stripeEvents.ts — pure predicates over Stripe event payloads.
//
// They live here, not inline in app/api/webhooks/stripe/route.ts, so the money
// decisions a webhook makes can be asserted directly
// (scripts/test-webhook-recovery.ts) rather than only through a live event.

/**
 * Whether a Checkout Session's money has actually arrived.
 *
 * `checkout.session.completed` means the customer FINISHED THE SESSION, not
 * that it was paid. With a delayed-notification payment method the session
 * completes with `payment_status: 'unpaid'` and settles — or fails — days
 * later, via `checkout.session.async_payment_succeeded` / `_failed`. Treating
 * `completed` as payment marked the engagement paid and transferred the
 * expert's share out of platform funds against money that had not cleared and
 * might never.
 *
 * 'no_payment_required' is a genuinely settled zero-amount session and counts.
 */
export function checkoutSessionSettled(paymentStatus: string | null | undefined): boolean {
  return paymentStatus === 'paid' || paymentStatus === 'no_payment_required';
}

/**
 * Whether a webhook handler failure is worth a Stripe redelivery.
 *
 * Answering 500 so Stripe retries is right for a TRANSIENT failure (a store
 * blip, a timeout) and wrong for a permanent one. The engagement ids on a
 * Stripe event come from metadata baked into a payment link days earlier, and
 * the row can be gone by the time the client pays — deleting an expert from a
 * project hard-deletes it. projectStore then throws 'Project not found' /
 * 'Expert not found' on every single redelivery, for Stripe's full three-day
 * retry schedule, and an endpoint that keeps failing gets DISABLED — which
 * would stop payouts, refunds and subscription events arriving too.
 *
 * A permanent failure is recorded once and acknowledged: retrying it cannot
 * make the missing row exist.
 */
export function isPermanentFailure(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('Project not found') || msg.includes('Expert not found');
}
