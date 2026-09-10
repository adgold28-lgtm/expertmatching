// Session and auth helpers — Supabase Auth is the only session system.
//
// Authorization data (role / status / firm / onboarding) is read from the
// auth user's app_metadata, which is written exclusively by the service role
// (lib/firmStore.ts + lib/supabase/admin.ts). No per-request DB reads.
//
// Everything here uses @supabase/ssr with fetch under the hood — safe in both
// the Node and Edge runtimes. Middleware session *refresh* (cookie writes) is
// handled separately by lib/supabase/middleware.ts.
//
// WHICH GUARD A ROUTE SHOULD CALL
//   routeAuthGuard  — any ACTIVE signed-in user. Checks a session exists and
//                     the status is neither 'disabled' nor 'pending'. Nothing
//                     else: it does NOT check onboarding_complete
//                     (middleware.ts owns the onboarding gate).
//   adminGuard      — platform staff only (app_metadata.role === 'admin'),
//                     same status rule. /api/admin/* runs this AND is shadowed
//                     by middleware's admin-only 404, deliberately twice.
//   orgAdminGuard   — the Team API. Platform admin OR org_admin with an org_id;
//                     same status rule. Returns the SessionUser so the caller
//                     does not re-read the session.
// None of these check project ownership — that is getProjectForUser (404 on no
// access) followed by lib/projectsGuard.requireProjectOwner (403), in that order.
//
// ALL THREE AGREE ON WHAT "MAY USE THE PRODUCT" MEANS — statusMayUseProduct()
// below is the single definition. They did not always: routeAuthGuard and
// adminGuard used to admit status 'pending' while orgAdminGuard refused it
// (audit M-2). That was not exploitable, because a pending account holds only
// the unguessable random password ensureSupabaseUser sets and so cannot sign
// in, but any future path that establishes a session before activation — a
// magic link, an SSO bridge, a set-password that signs in before upsertUser
// finishes — would have handed a pending account every routeAuthGuard route.
//
// Each guard performs its own getUser() round-trip to the Supabase auth server,
// so a handler that calls a guard and then getSessionUser() makes two. That is
// the accepted cost of never trusting a locally-decoded JWT: getUser()
// revalidates, so a just-disabled account cannot ride an unexpired token.

import type { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { User } from '@supabase/supabase-js';

// Legacy HMAC session cookie name — no longer issued; logout still clears it
// so stale browsers converge to a clean state.
export const LEGACY_COOKIE_NAME = 'expertmatch_session';

// Always on in production — fail closed if APP_AUTH_ENABLED is not 'true'.
// In development, gated by APP_AUTH_ENABLED=true.
export function isAuthEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return true;
  return process.env.APP_AUTH_ENABLED === 'true';
}

export interface SessionUser {
  role:                'admin' | 'user';
  email:               string;
  firmDomain:          string; // '*' for platform admin, else the org domain
  firmName?:           string;
  // Organization membership (from app_metadata; written only by the service role).
  orgId?:              string;
  orgRole?:            'org_admin' | 'org_member';
  firstName?:          string;
  onboardingComplete?: boolean;
  // True once the onboarding SetupIntent flow saved a default card. Mirrored
  // onto app_metadata by firmStore.syncUserMetadata, so the onboarding stepper
  // can resume on the right step without a DB read.
  billingComplete?:    boolean;
}

/** Shape of the app_metadata written by lib/supabase/admin.ts. */
interface AuthAppMetadata {
  role?:                string;
  status?:              string;
  firm_domain?:         string;
  firm_name?:           string;
  org_id?:              string;
  org_role?:            string;
  first_name?:          string;
  onboarding_complete?: boolean;
  billing_complete?:    boolean;
}

/**
 * The one definition of "this account may use the product", shared by all three
 * guards. 'pending' means invited but not yet activated; 'disabled' means
 * revoked. An absent status is treated as usable, because accounts provisioned
 * before the claim existed carry none and locking them out would be worse than
 * the (nil, given the above) risk.
 */
export function statusMayUseProduct(status: string | undefined | null): boolean {
  return status !== 'disabled' && status !== 'pending';
}

/**
 * Constant-time-ish comparison of a bearer secret, shared by the cron routes
 * (/api/jobs/reconcile and /api/jobs/schedule-nudges), which used to hold two
 * byte-identical private copies of it.
 *
 * Not a defence against a local attacker — this is a header check on a
 * serverless function, not a crypto primitive — but it costs nothing to avoid
 * the early-exit compare. Char-code based rather than timingSafeEqual so it is
 * safe in the Edge runtime as well as Node.
 */
export function secretMatches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * Reads the authenticated Supabase user from the request's cookies, or null.
 * Read-only — never writes cookies (middleware owns session refresh).
 * Fails closed: returns null on any error.
 */
export async function getSupabaseSessionUser(request: NextRequest): Promise<User | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;

  try {
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll() {}, // read-only by design
      },
    });
    const { data: { user } } = await supabase.auth.getUser();
    return user?.email ? user : null;
  } catch {
    return null;
  }
}

/** Builds a SessionUser from a verified auth user's app_metadata. */
export function sessionUserFromAuthUser(user: User): SessionUser {
  const meta  = (user.app_metadata ?? {}) as AuthAppMetadata;
  const email = user.email ?? '';
  // Fail closed: only an explicit 'admin' grants platform-admin role.
  const role: 'admin' | 'user' = meta.role === 'admin' ? 'admin' : 'user';
  const firmDomain = role === 'admin'
    ? '*'
    : (meta.firm_domain || (email.includes('@') ? email.split('@')[1] : ''));
  return {
    role,
    email,
    firmDomain,
    ...(meta.firm_name  ? { firmName:  meta.firm_name }  : {}),
    ...(meta.org_id     ? { orgId:     meta.org_id }     : {}),
    ...(meta.org_role === 'org_admin' || meta.org_role === 'org_member'
      ? { orgRole: meta.org_role }
      : {}),
    ...(meta.first_name ? { firstName: meta.first_name } : {}),
    ...(meta.onboarding_complete !== undefined
      ? { onboardingComplete: meta.onboarding_complete }
      : {}),
    ...(meta.billing_complete !== undefined
      ? { billingComplete: meta.billing_complete }
      : {}),
  };
}

/**
 * Returns the current session user, or a default admin user when auth is
 * disabled (development only).
 */
export async function getSessionUser(request: NextRequest): Promise<SessionUser> {
  if (!isAuthEnabled()) {
    return { role: 'admin', email: 'admin', firmDomain: '*' };
  }
  const user = await getSupabaseSessionUser(request);
  if (!user) {
    // Should not happen if a guard ran first; return a safe default.
    // The empty email is load-bearing: it matches no profile and no
    // project.ownerEmail, so an ownership comparison downstream fails closed
    // rather than granting access. Callers must still run a guard first —
    // this value is a floor, not authorization.
    return { role: 'user', email: '', firmDomain: '' };
  }
  return sessionUserFromAuthUser(user);
}

/**
 * Route-level auth guard — supplements middleware (defense in depth).
 * Returns null if authenticated and active, or a 401/403 Response.
 *
 * A 'pending' session gets the same 403 { error: 'forbidden' } a disabled one
 * does, rather than a 401: the body and status clients already handle, and the
 * distinction (no session vs a session that may not act) stays honest.
 */
export async function routeAuthGuard(request: NextRequest): Promise<Response | null> {
  if (!isAuthEnabled()) return null;
  const user = await getSupabaseSessionUser(request);
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const meta = (user.app_metadata ?? {}) as AuthAppMetadata;
  if (!statusMayUseProduct(meta.status)) {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  return null;
}

/**
 * Admin-only guard — requires an ACTIVE authenticated user whose app_metadata
 * role is explicitly 'admin'. Missing/legacy roles, and any status that is not
 * usable ('pending' or 'disabled'), fail closed with 403.
 */
export async function adminGuard(request: NextRequest): Promise<Response | null> {
  if (!isAuthEnabled()) return null;
  const user = await getSupabaseSessionUser(request);
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const meta = (user.app_metadata ?? {}) as AuthAppMetadata;
  if (!statusMayUseProduct(meta.status) || meta.role !== 'admin') {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  return null;
}

/**
 * Organization-admin guard — for the Team management API.
 *
 * Allows the request through when the caller is an active user who is either a
 * platform admin (role 'admin') or an org admin (org_role 'org_admin' with an
 * org_id). Everyone else gets 401 (no session) or 403.
 *
 * Reads only app_metadata, which the service role keeps in step with
 * organization_members (firmStore.syncUserMetadata) — @supabase/ssr's getUser()
 * revalidates against the auth server, so the claims are never stale by more
 * than the write that produced them. Deliberately does NOT import firmStore:
 * this module is pulled into the Edge middleware bundle.
 *
 * Returns the resolved SessionUser so callers need not re-read the session.
 */
export async function orgAdminGuard(
  request: NextRequest,
): Promise<{ user: SessionUser } | { error: Response }> {
  if (!isAuthEnabled()) {
    return { user: { role: 'admin', email: 'admin', firmDomain: '*' } };
  }

  const authUser = await getSupabaseSessionUser(request);
  if (!authUser) {
    return { error: Response.json({ error: 'unauthorized' }, { status: 401 }) };
  }

  const meta = (authUser.app_metadata ?? {}) as AuthAppMetadata;
  if (!statusMayUseProduct(meta.status)) {
    return {
      error: Response.json(
        { error: 'forbidden', message: 'Your account is not active.' },
        { status: 403 },
      ),
    };
  }

  const user            = sessionUserFromAuthUser(authUser);
  const isPlatformAdmin = user.role === 'admin';
  const isOrgAdmin      = user.orgRole === 'org_admin' && !!user.orgId;

  if (!isPlatformAdmin && !isOrgAdmin) {
    return {
      error: Response.json(
        { error: 'forbidden', message: 'Only organization admins can manage the team.' },
        { status: 403 },
      ),
    };
  }

  return { user };
}
