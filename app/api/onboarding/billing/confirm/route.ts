import { NextRequest } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../../lib/auth';
import { upsertUser } from '../../../../../lib/firmStore';
import { stripe } from '../../../../../lib/stripe';

export async function POST(request: NextRequest): Promise<Response> {
  const authError = await routeAuthGuard(request);
  if (authError) return authError;

  const body = await request.json() as { setupIntentId?: string };
  const { setupIntentId } = body;

  if (!setupIntentId || typeof setupIntentId !== 'string') {
    return Response.json({ error: 'missing_setup_intent_id' }, { status: 400 });
  }

  const setupIntent = await stripe.setupIntents.retrieve(setupIntentId);
  if (setupIntent.status !== 'succeeded') {
    return Response.json({ error: 'setup_intent_not_succeeded' }, { status: 400 });
  }

  const user = await getSessionUser(request);
  await upsertUser(user.email, { billingComplete: true });

  return Response.json({ ok: true });
}
