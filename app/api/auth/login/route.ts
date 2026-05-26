import { createHmac } from 'crypto';
import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { verifyAdminPassword, verifyPassword } from '../../../../lib/authPassword';
import { createSessionCookie, COOKIE_NAME, SESSION_TTL_MS } from '../../../../lib/auth';
import { getUser, upsertUser } from '../../../../lib/firmStore';
import { getUpstashClient } from '../../../../lib/upstashRedis';
import { ensureSupabaseUser } from '../../../../lib/supabase/admin';

const MAX_BODY         = 2048;
const LOGIN_RATE_LIMIT = 10;
const LOGIN_WINDOW_MS  = 15 * 60 * 1000;

// Cookie options compatible with both @supabase/ssr and Next.js ResponseCookies.
type SetCookieOption = {
  domain?:      string;
  expires?:     Date;
  httpOnly?:    boolean;
  maxAge?:      number;
  partitioned?: boolean;
  path?:        string;
  priority?:    'low' | 'medium' | 'high';
  sameSite?:    boolean | 'lax' | 'strict' | 'none';
  secure?:      boolean;
};

function loginRlKey(ip: string): string {
  const secret = process.env.LOG_HASH_SECRET ?? 'dev-insecure-fallback';
  return `login-rl:${createHmac('sha256', secret).update(ip).digest('hex').slice(0, 16)}`;
}

// Attempts Supabase signInWithPassword and returns captured Set-Cookie entries.
// Returns null if Supabase is misconfigured, unavailable, or rejects credentials.
async function trySupabaseSignIn(
  request: NextRequest,
  email: string,
  password: string,
): Promise<Array<{ name: string; value: string; options?: SetCookieOption }> | null> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return null;

  try {
    const cookiesToSet: Array<{ name: string; value: string; options?: SetCookieOption }> = [];
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(items) {
          items.forEach(({ name, value, options }) =>
            cookiesToSet.push({ name, value, options: options as SetCookieOption }),
          );
        },
      },
    });
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (error || !data.user) return null;
    return cookiesToSet;
  } catch {
    return null;
  }
}

// Builds the final response with both the HMAC session cookie and any Supabase
// session cookies.  Using NextResponse so all cookies are on one object.
function buildResponse(
  hmacToken: string,
  supabaseCookies: Array<{ name: string; value: string; options?: SetCookieOption }>,
): Response {
  const isProduction = process.env.NODE_ENV === 'production';
  const response = NextResponse.json({ ok: true });

  response.cookies.set(COOKIE_NAME, hmacToken, {
    httpOnly: true,
    maxAge:   Math.floor(SESSION_TTL_MS / 1000),
    path:     '/',
    sameSite: 'lax',
    secure:   isProduction,
  });

  for (const { name, value, options = {} } of supabaseCookies) {
    // The options shape from @supabase/ssr is structurally compatible with
    // Next.js ResponseCookies options — same fields, same types.
    response.cookies.set(name, value, options);
  }

  return response;
}

export async function POST(request: NextRequest): Promise<Response> {
  // ── Content-Type guard ────────────────────────────────────────────────────
  if (!request.headers.get('content-type')?.includes('application/json')) {
    return Response.json({ error: 'content_type_required' }, { status: 415 });
  }

  // ── Body size guard ───────────────────────────────────────────────────────
  const cl = request.headers.get('content-length');
  if (cl && parseInt(cl, 10) > MAX_BODY) {
    return Response.json({ error: 'request_too_large' }, { status: 413 });
  }

  let raw: string;
  try { raw = await request.text(); } catch {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }
  if (raw.length > MAX_BODY) {
    return Response.json({ error: 'request_too_large' }, { status: 413 });
  }

  let body: unknown;
  try { body = JSON.parse(raw); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null) {
    return Response.json({ error: 'invalid_request' }, { status: 400 });
  }

  const b = body as Record<string, unknown>;

  if (typeof b.password !== 'string') {
    return Response.json({ error: 'password_required' }, { status: 400 });
  }

  const password = b.password.slice(0, 200);
  const email    = typeof b.email === 'string' ? b.email.trim().toLowerCase().slice(0, 200) : '';

  // ── Rate limiting ─────────────────────────────────────────────────────────
  {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
            ?? request.headers.get('x-real-ip')
            ?? 'unknown';
    const redis = getUpstashClient();
    if (redis) {
      try {
        const { count, ttlMs } = await redis.incrWithWindow(loginRlKey(ip), LOGIN_WINDOW_MS);
        if (count > LOGIN_RATE_LIMIT) {
          return Response.json(
            { error: 'rate_limited', message: 'Too many login attempts. Please try again later.' },
            { status: 429, headers: { 'Retry-After': String(Math.ceil(ttlMs / 1000)) } },
          );
        }
      } catch { /* fail open */ }
    }
  }

  // ── Emergency admin override ──────────────────────────────────────────────
  // Bootstrap mechanism for initial setup — not a normal login path.
  if (process.env.ADMIN_PASSWORD_HASH && email && verifyAdminPassword(password, email)) {
    try { await upsertUser(email, { role: 'admin', status: 'active' }); } catch { /* non-fatal */ }
    const token = await createSessionCookie('admin', email, undefined, { onboardingComplete: true });
    // Admin override sets only the HMAC cookie — no Supabase session.
    const isProduction = process.env.NODE_ENV === 'production';
    const response = NextResponse.json({ ok: true });
    response.cookies.set(COOKIE_NAME, token, {
      httpOnly: true,
      maxAge:   Math.floor(SESSION_TTL_MS / 1000),
      path:     '/',
      sameSite: 'lax',
      secure:   isProduction,
    });
    return response;
  }

  // ── Normal flow ───────────────────────────────────────────────────────────
  if (!email || !email.includes('@')) {
    return Response.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  // ── 1. Try Supabase sign-in ───────────────────────────────────────────────
  // This succeeds for users who have already been migrated to Supabase Auth
  // (either via a previous login or the migration script).
  const supabaseCookies = await trySupabaseSignIn(request, email, password);
  if (supabaseCookies !== null) {
    // Supabase credential check passed — look up Redis for role / status.
    let user;
    try {
      user = await getUser(email);
    } catch {
      console.warn('[auth/login] Supabase ok but Redis read failed', { email: '[redacted]' });
      return Response.json({ error: 'invalid_credentials' }, { status: 401 });
    }

    if (!user) {
      // User is in Supabase but not in Redis — unusual state; reject.
      console.warn('[auth/login] Supabase user has no Redis record');
      return Response.json({ error: 'invalid_credentials' }, { status: 401 });
    }

    if (user.status === 'pending') {
      return Response.json(
        { error: 'account_pending', message: 'Your account is pending activation.' },
        { status: 403 },
      );
    }
    if (user.status === 'disabled') {
      return Response.json(
        { error: 'account_disabled', message: 'Your account has been disabled. Contact your administrator.' },
        { status: 403 },
      );
    }

    const hmacToken = await createSessionCookie(user.role, user.email, user.firmName, {
      firstName:          user.firstName,
      onboardingComplete: user.onboardingComplete ?? true,
    });
    return buildResponse(hmacToken, supabaseCookies);
  }

  // ── 2. Fall back to Redis / scrypt ────────────────────────────────────────
  // Handles users who haven't been migrated to Supabase yet, Supabase outages,
  // and misconfigured Supabase credentials.
  let user;
  try {
    user = await getUser(email);
  } catch {
    console.warn('[auth/login] failed to read user record', { email: '[redacted]' });
    return Response.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  if (!user) {
    console.warn('[auth/login] user not found');
    return Response.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  if (!verifyPassword(password, user.passwordHash)) {
    console.warn('[auth/login] invalid password');
    return Response.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  if (user.status === 'pending') {
    return Response.json(
      { error: 'account_pending', message: 'Your account is pending activation.' },
      { status: 403 },
    );
  }
  if (user.status === 'disabled') {
    return Response.json(
      { error: 'account_disabled', message: 'Your account has been disabled. Contact your administrator.' },
      { status: 403 },
    );
  }

  // ── 3. Auto-migrate to Supabase (best-effort) ────────────────────────────
  // Redis auth succeeded — create/update the Supabase account so the next
  // login uses Supabase.  Failures here are non-fatal: we always issue an
  // HMAC session regardless.
  let migratedSupabaseCookies: Array<{ name: string; value: string; options?: SetCookieOption }> = [];

  const migrated = await ensureSupabaseUser(email, password, {
    role:               user.role,
    firmName:           user.firmName,
    firmDomain:         user.firmDomain,
    onboardingComplete: user.onboardingComplete,
  });

  if (migrated) {
    // Supabase account is now correct — sign in to get session cookies.
    const freshCookies = await trySupabaseSignIn(request, email, password);
    if (freshCookies) migratedSupabaseCookies = freshCookies;
  }

  const hmacToken = await createSessionCookie(user.role, user.email, user.firmName, {
    firstName:          user.firstName,
    onboardingComplete: user.onboardingComplete ?? true,
  });

  console.log('[auth/login] signed in via Redis/scrypt', {
    migrated,
    hasSupabaseCookies: migratedSupabaseCookies.length > 0,
  });

  return buildResponse(hmacToken, migratedSupabaseCookies);
}

// Redirect GET to login page instead of 404.
export function GET(): Response {
  return Response.redirect('/login', 302);
}
