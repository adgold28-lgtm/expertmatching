// TODO(stripe-integration): This is a stub. Replace with real Stripe SetupIntent flow.
//
// Requirements:
//   - STRIPE_SECRET_KEY (server-side)
//   - NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY (client-side, for Stripe Elements)
//   - npm install stripe @stripe/stripe-js @stripe/react-stripe-js
//
// Real implementation:
//   1. POST here → stripe.setupIntents.create({ customer }) → return { clientSecret }
//   2. Client uses <CardElement> + stripe.confirmCardSetup(clientSecret)
//   3. On success, Stripe stores the payment method; update UserRecord.stripeCustomerId
//   4. Mark user billingComplete: true
//
// Customer creation:
//   On first billing step, check if UserRecord.stripeCustomerId exists.
//   If not, call stripe.customers.create({ email, name }) and store the ID.

import { NextRequest } from 'next/server';
import { routeAuthGuard } from '../../../../lib/auth';

export async function POST(request: NextRequest): Promise<Response> {
  const authError = await routeAuthGuard(request);
  if (authError) return authError;

  // Stub: always succeeds. Real implementation creates a Stripe SetupIntent.
  return Response.json({ ok: true, stubbed: true });
}
