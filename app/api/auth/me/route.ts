// GET /api/auth/me — the caller's own identity and onboarding state.
//
// Session fields (role / email / firm / firstName / onboardingComplete /
// billingComplete) come from the verified auth user's app_metadata — no DB read
// needed. `lastName` and `title` live only on the profile row, so a single
// firmStore.getUser() read supplies them; when the service-role client is
// unavailable the response degrades to the session fields rather than failing.
//
// The onboarding stepper reads billingComplete to resume on the right step and
// lastName/title to seed the profile form (which previously read a `lastName`
// this route never returned).
//
// NEVER returns: Stripe customer ids, tokens, or any other user's data.

import { NextRequest } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../lib/auth';
import { getUser } from '../../../../lib/firmStore';

export async function GET(request: NextRequest): Promise<Response> {
  const authError = await routeAuthGuard(request);
  if (authError) return authError;

  const session = await getSessionUser(request);
  const { role, email, firmDomain } = session;

  // Profile-only fields. Never fatal — the session fields are the contract.
  const record = email ? await getUser(email).catch(() => null) : null;

  return Response.json({
    authenticated:      true,
    role,
    email,
    firmDomain,
    // `||` not `??`: an empty profile column means "not set", so it should fall
    // back to the session value rather than winning as a blank string.
    firmName:           record?.firmName  || session.firmName  || '',
    firstName:          record?.firstName || session.firstName || '',
    lastName:           record?.lastName  || '',
    title:              record?.title     || '',
    // The profile row is fresher than the app_metadata mirror when a write
    // just landed, so prefer it and fall back to the session flag.
    billingComplete:    record?.billingComplete    ?? session.billingComplete    ?? false,
    onboardingComplete: record?.onboardingComplete ?? session.onboardingComplete ?? false,
  });
}
