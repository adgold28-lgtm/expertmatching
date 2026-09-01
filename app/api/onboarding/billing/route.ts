// POST /api/onboarding/billing — protected by routeAuthGuard()
//
// Step 1 of the billing onboarding flow: ensure the caller has a Stripe
// customer, then open a SetupIntent so the browser can collect and save a card
// with Stripe Elements. No money moves here — the saved card is charged
// off-session when a call completes (lib/chargeSavedCard.ts).
//
// Flow:
//   1. POST here                     → { clientSecret, publishableKey }
//   2. Client confirms the SetupIntent with Stripe.js
//   3. POST /api/onboarding/billing/confirm { setupIntentId }
//                                    → marks the user billingComplete
//
// Required env vars:
//   STRIPE_SECRET_KEY                    — server-side Stripe key
//   NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY   — client-side key for Stripe Elements.
//                                          Deliberately NOT in validateEnv's
//                                          REQUIRED_VARS; when it is absent
//                                          this route returns 503
//                                          billing_unavailable before creating
//                                          anything in Stripe.
//
// NEVER log: emails, names, client secrets, or Stripe customer ids.

import { NextRequest } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../lib/auth';
import { getUser, upsertUser } from '../../../../lib/firmStore';
import { stripe } from '../../../../lib/stripe';

export async function POST(request: NextRequest): Promise<Response> {
  const authError = await routeAuthGuard(request);
  if (authError) return authError;

  // Fail before touching Stripe: without the publishable key the client cannot
  // mount Elements, so a customer/SetupIntent here would be orphaned.
  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY;
  if (!publishableKey) {
    return Response.json({ error: 'billing_unavailable' }, { status: 503 });
  }

  const sessionUser = await getSessionUser(request);
  if (!sessionUser.email) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const record = await getUser(sessionUser.email);
  if (!record) {
    return Response.json({ error: 'user_not_found' }, { status: 404 });
  }

  try {
    // ─── Stripe customer (create once, reuse forever) ──────────────────────
    let customerId = record.stripeCustomerId ?? null;

    if (!customerId) {
      const displayName =
        [record.firstName, record.lastName].filter(Boolean).join(' ') || record.firmName;

      const customer = await stripe.customers.create({
        email:    record.email,
        ...(displayName ? { name: displayName } : {}),
        metadata: { firmDomain: record.firmDomain },
      });
      customerId = customer.id;

      // Persist immediately so a failure below never strands the customer.
      await upsertUser(record.email, { stripeCustomerId: customerId });
    }

    // ─── SetupIntent (card capture, no charge) ─────────────────────────────
    const setupIntent = await stripe.setupIntents.create({
      customer:             customerId,
      payment_method_types: ['card'],
    });

    if (!setupIntent.client_secret) {
      console.error('[api/onboarding/billing] setup intent missing client_secret');
      return Response.json({ error: 'internal_error' }, { status: 500 });
    }

    return Response.json({
      clientSecret: setupIntent.client_secret,
      publishableKey,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[api/onboarding/billing] error:', msg.slice(0, 120));
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}
