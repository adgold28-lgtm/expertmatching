import { NextRequest } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../lib/auth';
import { getUser, upsertUser } from '../../../../lib/firmStore';
import { stripe } from '../../../../lib/stripe';

export async function POST(request: NextRequest): Promise<Response> {
  const authError = await routeAuthGuard(request);
  if (authError) return authError;

  const user = await getSessionUser(request);
  const record = await getUser(user.email);
  if (!record) return Response.json({ error: 'user_not_found' }, { status: 404 });

  let customerId = record.stripeCustomerId ?? null;

  if (!customerId) {
    const displayName = [record.firstName, record.lastName].filter(Boolean).join(' ') || record.firmName;
    const customer = await stripe.customers.create({
      email: record.email,
      name: displayName || undefined,
      metadata: { firmDomain: record.firmDomain },
    });
    customerId = customer.id;
    await upsertUser(record.email, { stripeCustomerId: customerId });
  }

  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    payment_method_types: ['card'],
  });

  const publishableKey = process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '';

  return Response.json({
    clientSecret: setupIntent.client_secret,
    publishableKey,
  });
}
