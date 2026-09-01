// POST /api/onboarding/billing/confirm — protected by routeAuthGuard()
//
// Step 2 of the billing onboarding flow. The client has confirmed the
// SetupIntent with Stripe.js and posts its id back here. This route is the
// server-side authority on whether billing is actually set up:
//
//   1. Retrieve the SetupIntent from Stripe (never trust a client-supplied
//      status).
//   2. Require status === 'succeeded'.
//   3. Require the SetupIntent's customer to equal the caller's stored
//      stripe_customer_id — otherwise any authenticated user could replay
//      someone else's SetupIntent id and mark themselves billing-complete.
//   4. Attach the resulting payment method as the customer's default for
//      invoices, which is what the off-session charge at call completion uses.
//   5. Mark the user billingComplete.
//
// Required env vars:
//   STRIPE_SECRET_KEY  — server-side Stripe key
//
// NEVER log: emails, names, payment method ids, or Stripe customer ids.

import { NextRequest } from 'next/server';
import type Stripe from 'stripe';
import { routeAuthGuard, getSessionUser } from '../../../../../lib/auth';
import { getUser, upsertUser } from '../../../../../lib/firmStore';
import { stripe } from '../../../../../lib/stripe';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Stripe expandable fields arrive as an id or an object — normalise to the id. */
function toId(
  value: string | { id: string } | null | undefined,
): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

// ─── Handler ──────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest): Promise<Response> {
  const authError = await routeAuthGuard(request);
  if (authError) return authError;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const b             = body as Record<string, unknown>;
  const setupIntentId = typeof b.setupIntentId === 'string' ? b.setupIntentId.trim() : '';
  if (!setupIntentId) {
    return Response.json({ error: 'missing_setup_intent_id' }, { status: 400 });
  }

  const sessionUser = await getSessionUser(request);
  if (!sessionUser.email) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const record = await getUser(sessionUser.email);
  if (!record) {
    return Response.json({ error: 'user_not_found' }, { status: 404 });
  }

  // No stored customer means this user never started the flow — nothing a
  // retrieved SetupIntent could legitimately match.
  const expectedCustomerId = record.stripeCustomerId ?? null;
  if (!expectedCustomerId) {
    return Response.json({ error: 'setup_intent_mismatch' }, { status: 403 });
  }

  try {
    let setupIntent: Stripe.SetupIntent;
    try {
      setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
    } catch {
      // Unknown / malformed id — do not distinguish from a foreign one.
      return Response.json({ error: 'setup_intent_not_found' }, { status: 404 });
    }

    // ─── Ownership check (before any state change) ─────────────────────────
    if (toId(setupIntent.customer) !== expectedCustomerId) {
      console.warn('[api/onboarding/billing/confirm] setup intent customer mismatch');
      return Response.json({ error: 'setup_intent_mismatch' }, { status: 403 });
    }

    if (setupIntent.status !== 'succeeded') {
      return Response.json({ error: 'setup_intent_not_succeeded' }, { status: 400 });
    }

    const paymentMethodId = toId(setupIntent.payment_method);
    if (!paymentMethodId) {
      return Response.json({ error: 'setup_intent_no_payment_method' }, { status: 400 });
    }

    // ─── Make it the default for off-session charges ───────────────────────
    await stripe.customers.update(expectedCustomerId, {
      invoice_settings: { default_payment_method: paymentMethodId },
    });

    await upsertUser(record.email, { billingComplete: true });

    console.log('[api/onboarding/billing/confirm] billing-complete');

    return Response.json({ ok: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[api/onboarding/billing/confirm] error:', msg.slice(0, 120));
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}
