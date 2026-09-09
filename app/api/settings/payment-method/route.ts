// GET /api/settings/payment-method — the card on file for the caller's FIRM.
//
// Session-authenticated (routeAuthGuard). Organization-level, like the rest of
// billing: one card covers everyone at the firm. Card details and the
// subscription state are the firm champion's business (org_role 'org_admin')
// or a platform admin's — an ordinary member gets `{ restricted: true, orgName }`
// and nothing about the card, so the firm's economics never reach the whole
// team.
//
// Replacing the card is likewise restricted: `canReplace` is true only for a
// champion or a platform admin. The replace flow itself reuses the onboarding routes
// unchanged — POST /api/onboarding/billing for the SetupIntent and
// POST /api/onboarding/billing/confirm to make it the default. There is no
// second copy of the Stripe card logic in this codebase, and there should not
// be: /confirm is the one place that verifies a SetupIntent belongs to the
// org's own customer before promoting it.
//
// Response 200:
//   { hasCard: false, canReplace: boolean, orgName, subscriptionStatus }
//   { hasCard: true,  canReplace: boolean, orgName, subscriptionStatus,
//     card: { brand, last4, expMonth, expYear }, addedBy: string | null }
//
// Other responses:
//   401 { error: 'unauthorized' }   409 { error: 'no_organization' }
//   503 { error: 'billing_unavailable' }   500 { error: 'internal_error' }
//
// `brand`, `last4` and the expiry are the only card fields returned — they are
// what Stripe itself shows a customer, and they cannot be used to charge
// anything. The Stripe customer id and payment method id NEVER leave the
// server.
//
// Required env vars: STRIPE_SECRET_KEY
//
// NEVER logs: emails, names, Stripe customer / payment method ids.

import { NextRequest } from 'next/server';
import type Stripe from 'stripe';
import { routeAuthGuard, getSessionUser } from '../../../../lib/auth';
import { stripe } from '../../../../lib/stripe';
import { getServiceRoleClient } from '../../../../lib/supabase/admin';
import {
  getOrganizationIdForUser,
  getOrgBillingRow,
  getOrganizationName,
} from '../../../../lib/orgBilling';
import { entitlementsFromBilling } from '../../../../lib/entitlements';

interface CardSummary {
  brand:    string;
  last4:    string;
  expMonth: number;
  expYear:  number;
}

/** Stripe expandable fields arrive as an id or an object — normalise to the id. */
function toId(value: string | { id: string } | null | undefined): string | null {
  if (!value) return null;
  return typeof value === 'string' ? value : value.id;
}

/** 'visa' → 'Visa', 'american_express' → 'American Express'. */
function prettyBrand(brand: string): string {
  return brand
    .split('_')
    .map(word => (word.length <= 2 ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
    .join(' ');
}

function cardFrom(paymentMethod: Stripe.PaymentMethod): CardSummary | null {
  const card = paymentMethod.card;
  if (!card) return null;
  return {
    brand:    prettyBrand(card.brand ?? 'card'),
    last4:    card.last4 ?? '••••',
    expMonth: card.exp_month ?? 0,
    expYear:  card.exp_year  ?? 0,
  };
}

/**
 * Display name for whoever saved the card. Falls back to null rather than to an
 * email address — this response reaches every member of the firm, and a
 * colleague's address is not theirs to hand out.
 */
async function displayNameForProfile(profileId: string | null): Promise<string | null> {
  if (!profileId) return null;
  try {
    const db = getServiceRoleClient();
    if (!db) return null;
    const { data } = await db
      .from('profiles')
      .select('first_name, last_name, full_name')
      .eq('id', profileId)
      .maybeSingle();
    if (!data) return null;
    const full = `${data.first_name ?? ''} ${data.last_name ?? ''}`.trim();
    return full || data.full_name || null;
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest): Promise<Response> {
  const authError = await routeAuthGuard(request);
  if (authError) return authError;

  const sessionUser = await getSessionUser(request);
  if (!sessionUser.email) {
    return Response.json({ error: 'unauthorized' }, { status: 401 });
  }

  const organizationId = sessionUser.orgId ?? (await getOrganizationIdForUser(sessionUser.email));
  if (!organizationId) {
    return Response.json({ error: 'no_organization' }, { status: 409 });
  }

  // Seeing and replacing the firm's card is a champion action. Platform admins can too.
  const canReplace = sessionUser.role === 'admin' || sessionUser.orgRole === 'org_admin';

  try {
    if (!canReplace) {
      const orgName = (await getOrganizationName(organizationId)) || sessionUser.firmName || 'your firm';
      return Response.json({ restricted: true, canReplace: false, orgName });
    }

    const [row, orgNameFromDb] = await Promise.all([
      getOrgBillingRow(organizationId),
      getOrganizationName(organizationId),
    ]);

    const orgName = orgNameFromDb || sessionUser.firmName || 'your firm';
    const base = {
      canReplace,
      orgName,
      subscriptionStatus: row?.subscription_status ?? null,
      // 'trial' until the champion adds a card (lib/entitlements.ts).
      accountKind: entitlementsFromBilling(organizationId, row).kind,
    };

    const customerId = row?.stripe_customer_id ?? null;
    if (!row?.billing_complete || !customerId) {
      return Response.json({ hasCard: false, ...base });
    }

    // The default payment method lives on the customer's invoice settings —
    // completeOrgBilling() puts it there. Expanding it saves a second call.
    const customer = await stripe.customers.retrieve(customerId, {
      expand: ['invoice_settings.default_payment_method'],
    });

    if (customer.deleted) {
      // The Stripe customer is gone but our row still says billing is complete.
      // Report honestly rather than inventing a card.
      console.warn('[api/settings/payment-method] stripe customer deleted', { organizationId });
      return Response.json({ hasCard: false, ...base });
    }

    const defaultPm = customer.invoice_settings?.default_payment_method;
    let card: CardSummary | null = null;

    if (defaultPm && typeof defaultPm !== 'string') {
      card = cardFrom(defaultPm);
    } else {
      const pmId = toId(defaultPm ?? null);
      if (pmId) {
        const paymentMethod = await stripe.paymentMethods.retrieve(pmId);
        card = cardFrom(paymentMethod);
      }
    }

    if (!card) return Response.json({ hasCard: false, ...base });

    const addedBy = await displayNameForProfile(row.set_up_by);

    return Response.json({ hasCard: true, ...base, card, addedBy });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[api/settings/payment-method] error:', msg.slice(0, 120));
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
}
