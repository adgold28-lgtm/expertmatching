// Session and auth helpers.
//
// Pure HMAC functions (isAuthEnabled, COOKIE_NAME, SESSION_TTL_MS,
// createSessionCookie, verifySessionCookie, getSessionPayload) use only the
// Web Crypto API and are safe in Edge Runtime and middleware.
//
// Guard functions (routeAuthGuard, adminGuard, getSessionUser) check Supabase
// first, then fall back to the HMAC cookie.  Both @supabase/ssr and firmStore
// use fetch internally — they are Edge-compatible but are only called from
// Route Handlers (not from middleware.ts, which uses lib/supabase/middleware.ts
// for its session work).

import type { NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { getUpstashClient } from './upstashRedis';

export const COOKIE_NAME    = 'expertmatch_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// Always on in production — fail closed if APP_AUTH_ENABLED is not 'true'.
// In development, gated by APP_AUTH_ENABLED=true.
export function isAuthEnabled(): boolean {
  if (process.env.NODE_ENV === 'production') return true;
  return process.env.APP_AUTH_ENABLED === 'true';
}

async function importHmacKey(usage: 'sign' | 'verify'): Promise<CryptoKey> {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error('SESSION_SECRET not configured');
  return globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    [usage],
  );
}

export interface SessionPayload {
  iat:                 number;
  exp:                 number;
  role:                'admin' | 'user';
  email:               string;
  firmName?:           string;
  firstName?:          string;           // set after onboarding step 3
  onboardingComplete?: boolean;          // false = must complete onboarding; absent/true = done
}

// Returns a signed, base64url-encoded session token: <payload>.<sig>
export async function createSessionCookie(
  role: 'admin' | 'user',
  email: string,
  firmName?: string,
  opts: { firstName?: string; onboardingComplete?: boolean } = {},
): Promise<string> {
  const key     = await importHmacKey('sign');
  const payload: SessionPayload = {
    iat: Date.now(),
    exp: Date.now() + SESSION_TTL_MS,
    role,
    email,
    ...(firmName                             ? { firmName }                                       : {}),
    ...(opts.firstName                       ? { firstName: opts.firstName }                      : {}),
    ...(opts.onboardingComplete !== undefined ? { onboardingComplete: opts.onboardingComplete }   : {}),
  };
  const b64    = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sigBuf = await globalThis.crypto.subtle.sign('HMAC', key, new TextEncoder().encode(b64));
  const sig    = Buffer.from(sigBuf).toString('base64url');
  return `${b64}.${sig}`;
}

// Returns true only if the token has a valid HMAC signature and has not expired.
export async function verifySessionCookie(token: string): Promise<boolean> {
  try {
    const secret = process.env.SESSION_SECRET;
    if (!secret) return false;

    const dot = token.lastIndexOf('.');
    if (dot === -1) return false;

    const b64      = token.slice(0, dot);
    const sigBytes = Buffer.from(token.slice(dot + 1), 'base64url');

    const key     = await importHmacKey('verify');
    const isValid = await globalThis.crypto.subtle.verify(
      'HMAC', key,
      sigBytes,
      new TextEncoder().encode(b64),
    );
    if (!isValid) return false;

    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8'));
    return typeof payload.exp === 'number' && Date.now() <= payload.exp;
  } catch {
    return false;
  }
}

// Decodes and verifies the session cookie, returning the full payload.
// Returns null if invalid or expired.
export async function getSessionPayload(token: string): Promise<SessionPayload | null> {
  try {
    const dot = token.lastIndexOf('.');
    if (dot === -1) return null;

    const b64      = token.slice(0, dot);
    const sigBytes = Buffer.from(token.slice(dot + 1), 'base64url');

    const key     = await importHmacKey('verify');
    const isValid = await globalThis.crypto.subtle.verify(
      'HMAC', key, sigBytes, new TextEncoder().encode(b64),
    );
    if (!isValid) return null;

    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString('utf8')) as SessionPayload;
    if (typeof payload.exp !== 'number' || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// ─── Minimal Redis user reader ────────────────────────────────────────────────
//
// Reads only the fields needed for auth decisions, using upstashRedis directly.
// Intentionally does NOT import firmStore — firmStore imports Resend, which
// would pull @react-email/render into the middleware bundle and break the build.
//
interface RedisAuthUser {
  role?:               string;
  status?:             string;
  firmName?:           string;
  firmDomain?:         string;
  firstName?:          string;
  onboardingComplete?: boolean;
}

async function readRedisUser(email: string): Promise<RedisAuthUser | null> {
  try {
    const redis = getUpstashClient();
    if (!redis) return null;
    const raw = await redis.get(`user:${email}`);
    if (!raw) return null;
    return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw)) as RedisAuthUser;
  } catch {
    return null;
  }
}

// ─── Supabase session helper (shared by guard functions) ─────────────────────
//
// Creates a read-only Supabase server client from the request's cookies and
// returns the authenticated user, or null.  Does not write any cookies —
// session refreshes are handled by middleware.ts via updateSession().
// Fails open: returns null on any error so HMAC fallback takes over.

async function getSupabaseSessionUser(
  request: NextRequest,
): Promise<{ email: string; id: string } | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;

  try {
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        // setAll is intentionally omitted — we don't write cookies from Route
        // Handlers here; middleware already handles session refresh.
        setAll() {},
      },
    });
    const { data: { user } } = await supabase.auth.getUser();
    if (!user?.email) return null;
    return { email: user.email, id: user.id };
  } catch {
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface SessionUser {
  role:                'admin' | 'user';
  email:               string;
  firmDomain:          string; // '*' for admin, else email.split('@')[1]
  firmName?:           string;
  firstName?:          string;
  onboardingComplete?: boolean;
}

/**
 * Returns the current session user, or a default admin user when auth is
 * disabled.  Checks Supabase first, falls back to HMAC cookie.
 *
 * Supabase path: looks up the Redis user record for role / firmName /
 * onboardingComplete.  Redis remains the single source of truth for these
 * fields during the migration period.
 *
 * HMAC fallback: reads the session cookie as before (backward-compatible for
 * users who haven't yet logged in via Supabase Auth).
 */
export async function getSessionUser(request: NextRequest): Promise<SessionUser> {
  if (!isAuthEnabled()) {
    return { role: 'admin', email: 'admin', firmDomain: '*' };
  }

  // 1. Try Supabase session
  const supabaseSessionUser = await getSupabaseSessionUser(request);
  if (supabaseSessionUser) {
    const redisUser = await readRedisUser(supabaseSessionUser.email);
    if (redisUser) {
      const role: 'admin' | 'user' = redisUser.role === 'admin' ? 'admin' : 'user';
      const firmDomain = role === 'admin'
        ? '*'
        : (redisUser.firmDomain || supabaseSessionUser.email.split('@')[1] || '');
      return {
        role,
        email:               supabaseSessionUser.email,
        firmDomain,
        firmName:            redisUser.firmName,
        firstName:           redisUser.firstName,
        onboardingComplete:  redisUser.onboardingComplete,
      };
    }
  }

  // 2. Fall back to HMAC cookie
  const cookie  = request.cookies.get(COOKIE_NAME)?.value ?? '';
  const payload = cookie ? await getSessionPayload(cookie) : null;
  if (!payload) {
    // Should not happen if a guard ran first; return a safe default.
    return { role: 'user', email: '', firmDomain: '' };
  }
  // Security: default missing/legacy roles to 'user', never 'admin'. Legacy
  // sessions minted before the role field must NOT be silently elevated to admin
  // — a real admin re-authenticates to receive a role-stamped session.
  const role = payload.role ?? 'user';
  const base = {
    firmName:           payload.firmName,
    firstName:          payload.firstName,
    onboardingComplete: payload.onboardingComplete,
  };
  if (role === 'admin') {
    return { role: 'admin', email: payload.email, firmDomain: '*', ...base };
  }
  const firmDomain = payload.email.includes('@') ? payload.email.split('@')[1] : '';
  return { role: 'user', email: payload.email, firmDomain, ...base };
}

/**
 * Route-level auth guard — supplements middleware (defense in depth).
 * Returns null if authenticated (Supabase or HMAC), or a 401 Response if not.
 */
export async function routeAuthGuard(request: NextRequest): Promise<Response | null> {
  if (!isAuthEnabled()) return null;

  // 1. Supabase session
  const supabaseUser = await getSupabaseSessionUser(request);
  if (supabaseUser) return null;

  // 2. HMAC cookie fallback
  const cookie = request.cookies.get(COOKIE_NAME)?.value ?? '';
  if (cookie && await verifySessionCookie(cookie)) return null;

  return Response.json({ error: 'unauthorized' }, { status: 401 });
}

/**
 * Admin-only guard — checks both auth validity and role === 'admin'.
 * Returns null if the request is from an authenticated admin, or a 401/403.
 *
 * For Supabase users: role is read from the Redis user record.
 * For HMAC users: role is read from the session payload.
 * Fails closed: an explicit role === 'admin' is required; missing/legacy roles
 * are denied (403), and unreadable Supabase metadata is denied (401).
 */
export async function adminGuard(request: NextRequest): Promise<Response | null> {
  if (!isAuthEnabled()) return null;

  // 1. Supabase session
  const supabaseUser = await getSupabaseSessionUser(request);
  if (supabaseUser) {
    try {
      const redisUser = await readRedisUser(supabaseUser.email);
      if (!redisUser) return Response.json({ error: 'unauthorized' }, { status: 401 });
      if (redisUser.role !== 'admin') return Response.json({ error: 'forbidden' }, { status: 403 });
      return null;
    } catch {
      // Fail closed: a verified Supabase user whose role we cannot read is
      // denied admin access rather than falling through to the HMAC path.
      return Response.json({ error: 'unauthorized' }, { status: 401 });
    }
  }

  // 2. HMAC cookie fallback
  const cookie = request.cookies.get(COOKIE_NAME)?.value ?? '';
  if (!cookie) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const payload = await getSessionPayload(cookie);
  if (!payload) return Response.json({ error: 'unauthorized' }, { status: 401 });
  // Require an explicit admin role. Missing/legacy roles are NOT treated as
  // admin — they fail closed with 403.
  if (payload.role !== 'admin') {
    return Response.json({ error: 'forbidden' }, { status: 403 });
  }
  return null;
}
