// POST /api/onboarding/billing — protected by routeAuthGuard()
//
// Step 1 of the billing onboarding flow, at the ORGANIZATION level: the firm is
// the paying entity, so the FIRST person from a firm to reach this step saves
// the card that covers everyone. Everyone after them is told billing is already
// set up and continues without entering a card.
//
// Flow:
//   1. POST here → { alreadyComplete: true, orgName, … }        (card on file)
//                  { clientSecret, publishableKey, orgName, … } (needs a card)
//   2. Client confirms the SetupIntent with Stripe.js
//   3. POST /api/onboarding/billing/confirm { setupIntentId }
//                  → marks the ORGANIZATION billing-complete and starts /
//                    resizes the per-seat subscription
//
// The card pays for two things, which is why the response carries the seat
// count and the current per-seat price: per-minute expert call charges, and the
// monthly per-seat subscription priced by the volume tiers in lib/pricing.ts.
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
import { stripe } from '../../../../lib/stripe';
import { seatUnitPriceCents } from '../../../../lib/pricing';
import {
  getOrganizationIdForUser,
  getOrgBillingStatus,
  getOrganizationName,
  countActiveSeats,
  ensureOrgStripeCustomer,
} from '../../../../lib/orgBilling';

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

  // The org is the payer — without one there is nothing to bill.
  const organizationId = sessionUser.orgId ?? (await getOrganizationIdForUser(sessionUser.email));
  if (!organizationId) {
    return Response.json({ error: 'no_organization' }, { status: 409 });
  }

  try {
    const [status, orgNameFromDb, activeSeats] = await Promise.all([
      getOrgBillingStatus(organizationId),
      getOrganizationName(organizationId),
      countActiveSeats(organizationId),
    ]);

    const orgName = orgNameFromDb || sessionUser.firmName || 'your firm';
    const seatSummary = {
      orgName,
      activeSeats,
      seatUnitPriceCents: seatUnitPriceCents(activeSeats),
    };

    // ─── Someone at this firm already saved the card ───────────────────────
    if (status.billingComplete) {
      return Response.json({ alreadyComplete: true, ...seatSummary });
    }

    // ─── Org Stripe customer (create once, reuse forever) ──────────────────
    const customerId = await ensureOrgStripeCustomer(organizationId, {
      email:   sessionUser.email,
      orgName,
    });

    // ─── SetupIntent (card capture, no charge) ─────────────────────────────
    const setupIntent = await stripe.setupIntents.create({
      customer:             customerId,
      usage:                'off_session',
      payment_method_types: ['card'],
      metadata:             { organizationId },
    });

    if (!setupIntent.client_secret) {
      console.error('[api/onboarding/billing] setup intent missing client_secret');
      return Response.json({ error: 'internal_error' }, { status: 500 });
    }

    return Response.json({
      clientSecret: setupIntent.client_secret,
      publishableKey,
      ...seatSummary,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[api/onboarding/billing] error:', msg.slice(0, 120));
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}
