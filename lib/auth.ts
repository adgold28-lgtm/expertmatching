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
 * Route-level auth guard — supplements middleware (defense in depth).
 * Returns null if authenticated and not disabled, or a 401/403 Response.
 */
export async function routeAuthGuard(request: NextRequest): Promise<Response | null> {
  if (!isAuthEnabled()) return null;
  const user = await getSupabaseSessionUser(request);
  if (!user) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const meta = (user.app_metadata ?? {}) as AuthAppMetadata;
  if (meta.status === 'disabled') {
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
  if (meta.status === 'disabled' || meta.role !== 'admin') {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  return null;
}
