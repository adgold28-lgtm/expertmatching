// Session and auth helpers — Supabase Auth is the only session system.
//
// Authorization data (role / status / firm / onboarding) is read from the
// auth user's app_metadata, which is written exclusively by the service role
// (lib/firmStore.ts + lib/supabase/admin.ts). No per-request DB reads.
//
// Everything here uses @supabase/ssr with fetch under the hood — safe in both
// the Node and Edge runtimes. Middleware session *refresh* (cookie writes) is
// handled separately by lib/supabase/middleware.ts.

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
 * Reads the authenticated Supabase user from the request's cookies, or null.
 * Read-only — never writes cookies (middleware owns session refresh).
 * Fails closed: returns null on any error.
 */
export async function getSupabaseSessionUser(request: NextRequest): Promise<User | null> {
  const cached = VERIFIED_USER_BY_REQUEST.get(request);
  if (cached) return cached;
  const pending = verifySupabaseSessionUser(request);
  VERIFIED_USER_BY_REQUEST.set(request, pending);
  return pending;
}

/**
 * Request-scoped cache of the verified user.
 *
 * A typical handler calls routeAuthGuard(request) and then
 * getSessionUser(request), which used to mean TWO auth.getUser() round trips
 * to Supabase for one request — the same token verified twice, serially, on
 * every authenticated read.
 *
 * The key is the NextRequest object itself, so the entry lives exactly as long
 * as the request does and cannot leak between requests or users: a new request
 * is a new object and always re-verifies. The in-flight promise is cached (not
 * just the result) so concurrent callers within one request share one call.
 * This is NOT a process-wide session cache and NOT a decoded-JWT shortcut —
 * revocation still takes effect on the very next request.
 */
const VERIFIED_USER_BY_REQUEST = new WeakMap<NextRequest, Promise<User | null>>();

/** The actual verification. Fails closed: null on any error. */
async function verifySupabaseSessionUser(request: NextRequest): Promise<User | null> {
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
    return { role: 'user', email: '', firmDomain: '' };
  }
  return sessionUserFromAuthUser(user);
}

/**
 * Whether an account status may use the product. THE one status policy —
 * middleware and every route guard read it, so an account cannot be refused by
 * one layer and admitted by another.
 *
 *   'active'      the normal state, set when set-password completes
 *   'pending'     invited, password not yet set. A Supabase invite/recovery
 *                 link establishes a SESSION before /api/auth/set-password
 *                 runs, so a pending session is reachable by anyone who opens
 *                 their invite and navigates away. Middleware only ever
 *                 rejected 'disabled', so such a session reached project routes
 *                 — the project guards deliberately lean on middleware for the
 *                 account-state check.
 *   'disabled'    revoked
 *   undefined     legacy accounts predating the field. DELIBERATELY ALLOWED:
 *                 refusing them would lock out every pre-existing user. Not a
 *                 new hole — it is the status quo, called out rather than
 *                 quietly tightened.
 *
 * The set-password flow is unaffected: '/auth/' and '/api/auth/set-password'
 * are in the middleware's PUBLIC_PREFIXES and are token-gated at the handler.
 */
export function statusMayUseProduct(status: string | undefined): boolean {
  return status !== 'pending' && status !== 'disabled';
}

/**
 * Route-level auth guard — supplements middleware (defense in depth).
 * Returns null if authenticated and not disabled, or a 401/403 Response.
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
 * Admin-only guard — requires an authenticated user whose app_metadata role
 * is explicitly 'admin'. Missing/legacy roles fail closed with 403.
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
  if (meta.status === 'disabled' || meta.status === 'pending') {
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
