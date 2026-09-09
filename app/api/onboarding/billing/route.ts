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
// REPLACING A CARD (from /settings): POST { replace: true }. That skips the
// "already complete" short-circuit and mints a SetupIntent even though a card
// is on file, so the Settings panel can run the exact same two-step flow
// instead of a second copy of it. /confirm then promotes the new payment
// method to the org customer's default, which is what replacing means.
//
// `replace` is ORG-ADMIN ONLY (or platform admin) — a member must not be able
// to change the firm's card. The gate lives here, at the point the SetupIntent
// is minted, because /confirm can only ever promote a SetupIntent that already
// belongs to this org's customer; without a client secret there is nothing to
// confirm. A non-admin asking to replace gets 403 forbidden.
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
import { getOrgEntitlements } from '../../../../lib/entitlements';

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

  // ── Replace-the-card request? ─────────────────────────────────────────────
  // Read defensively: the onboarding stepper posts `{}` and older clients post
  // nothing parseable at all, and neither should become an error here.
  let replace  = false;
  let activate = false;
  try {
    const body = await request.json() as unknown;
    if (body !== null && typeof body === 'object' && !Array.isArray(body)) {
      replace  = (body as Record<string, unknown>).replace  === true;
      activate = (body as Record<string, unknown>).activate === true;
    }
  } catch {
    // No body / not JSON — a plain onboarding call.
  }

  // Replacing the card, or ACTIVATING a trial by adding one, is the champion's
  // (org_admin) decision — it starts the seat subscription for the whole firm.
  if ((replace || activate) && sessionUser.role !== 'admin' && sessionUser.orgRole !== 'org_admin') {
    return Response.json({ error: 'forbidden' }, { status: 403 });
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
    // Seat economics are the champion's business (org_admin) and the platform's.
    // An ordinary member onboarding into a firm gets the seat count without the
    // price — BillingStep only renders the rate line when the price is > 0.
    const seesEconomics = sessionUser.role === 'admin' || sessionUser.orgRole === 'org_admin';
    const seatSummary = {
      orgName,
      activeSeats,
      seatUnitPriceCents: seesEconomics ? seatUnitPriceCents(activeSeats) : 0,
    };

    // ─── Someone at this firm already saved the card ───────────────────────
    // Unless this is a deliberate replacement, in which case a card on file is
    // the whole premise and we mint a SetupIntent for the new one.
    if (status.billingComplete && !replace) {
      return Response.json({ alreadyComplete: true, ...seatSummary });
    }

    // ─── Trial: no card at onboarding ──────────────────────────────────────
    // A trial organization (lib/entitlements.ts) walks through onboarding
    // without a card and stays in walkthrough until one is added. The stepper
    // treats this like "already complete"; `activate: true` (Settings → add a
    // card) is the conversion path and skips this short-circuit, so a
    // SetupIntent is minted normally and no Stripe customer exists until then.
    const entitlements = await getOrgEntitlements(organizationId);
    if (entitlements.kind === 'trial' && !replace && !activate) {
      return Response.json({ trial: true, alreadyComplete: false, ...seatSummary });
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
      metadata:             { organizationId, intent: replace ? 'replace' : 'onboarding' },
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
