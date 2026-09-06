// GET /api/auth/me — the caller's own identity and onboarding state.
//
// Session fields (role / email / firm / firstName / onboardingComplete / org
// membership) come from the verified auth user's app_metadata — no DB read
// needed. `lastName` and `title` live only on the profile row, so a single
// firmStore.getUser() read supplies them; when the service-role client is
// unavailable the response degrades to the session fields rather than failing.
//
// billingComplete is ORGANIZATION-level: the firm is the paying entity, so one
// colleague saving the card completes this step for everyone at the firm
// (lib/orgBilling.isBillingCompleteForUser, which still honours the legacy
// per-user profile flag for accounts created before org billing).
//
// The onboarding stepper reads billingComplete to resume on the right step and
// lastName/title to seed the profile form.
//
// NEVER returns: Stripe customer ids, tokens, or any other user's data.

import { NextRequest } from 'next/server';
import { routeAuthGuard, getSessionUser } from '../../../../lib/auth';
import { getUser } from '../../../../lib/firmStore';
import { getUserBillingSummary } from '../../../../lib/orgBilling';

export async function GET(request: NextRequest): Promise<Response> {
  const authError = await routeAuthGuard(request);
  if (authError) return authError;

  const session = await getSessionUser(request);
  const { role, email, firmDomain } = session;

  // Profile-only fields and firm billing. Never fatal — the session fields are
  // the contract; both helpers resolve to safe defaults on failure.
  const [record, billing] = await Promise.all([
    email ? getUser(email).catch(() => null) : Promise.resolve(null),
    email
      ? getUserBillingSummary(email)
      : Promise.resolve({
          organizationId: null, orgName: null, billingComplete: false, billingSetUpByYou: false,
        }),
  ]);

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
    // Organization membership (app_metadata mirror; billing falls back to a
    // lookup when the mirror has not caught up yet).
    orgId:              session.orgId   ?? billing.organizationId ?? null,
    orgRole:            session.orgRole ?? null,
    orgName:            billing.orgName || record?.firmName || session.firmName || '',
    // Firm-level: true as soon as ANY colleague saved the firm's card. The
    // legacy per-user flag is the fallback inside getUserBillingSummary, and
    // the session mirror is the last resort when Supabase is unreachable.
    billingComplete:    billing.billingComplete || session.billingComplete || false,
    billingSetUpByYou:  billing.billingSetUpByYou,
    onboardingComplete: record?.onboardingComplete ?? session.onboardingComplete ?? false,
  });
}
