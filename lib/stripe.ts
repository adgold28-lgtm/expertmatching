// lib/stripe.ts — the ONLY place a Stripe client is constructed.
//
// Every money path in the app (per-seat subscriptions in lib/orgBilling.ts,
// off-session call charges in lib/chargeSavedCard.ts, payment links in
// lib/createAndSendInvoice.ts, Connect payouts in lib/stripeConnect.ts, and
// webhook signature verification in app/api/webhooks/stripe/route.ts) imports
// from here so the secret key is read once and the pinned apiVersion is
// identical everywhere — a version skew between modules would change how
// Stripe shapes the objects those modules read money out of.
//
// Must never be constructed at module load: STRIPE_SECRET_KEY is absent during
// `next build`, so the getters below defer it to the first request.

import Stripe from 'stripe';

let _stripe: Stripe | null = null;

export function getStripe(): Stripe {
  if (_stripe) return _stripe;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('[stripe] STRIPE_SECRET_KEY missing');
  _stripe = new Stripe(key, { apiVersion: '2026-04-22.dahlia' });
  return _stripe;
}

// Named export kept for convenience — lazily initialised on first use.
// Do NOT call this at module-load time in route files; it will fail during build.
export const stripe = {
  get customers()     { return getStripe().customers; },
  get products()      { return getStripe().products; },
  get prices()        { return getStripe().prices; },
  get paymentLinks()  { return getStripe().paymentLinks; },
  get webhooks()      { return getStripe().webhooks; },
  get accounts()      { return getStripe().accounts; },
  get accountLinks()  { return getStripe().accountLinks; },
  get transfers()     { return getStripe().transfers; },
  // Onboarding card capture + off-session charges at call completion.
  get setupIntents()   { return getStripe().setupIntents; },
  get paymentIntents() { return getStripe().paymentIntents; },
  get paymentMethods() { return getStripe().paymentMethods; },
  // Per-seat subscription billing (lib/orgBilling.ts): one tiered Price found
  // by lookup key, one subscription per organization, quantity = active seats.
  get subscriptions()     { return getStripe().subscriptions; },
  get subscriptionItems() { return getStripe().subscriptionItems; },
  get invoices()          { return getStripe().invoices; },
};
