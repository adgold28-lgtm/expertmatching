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
  get customers()    { return getStripe().customers; },
  get products()     { return getStripe().products; },
  get prices()       { return getStripe().prices; },
  get paymentLinks() { return getStripe().paymentLinks; },
  get webhooks()     { return getStripe().webhooks; },
};
