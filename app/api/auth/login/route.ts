import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { getUpstashClient } from '../../../../lib/upstashRedis';
import { trackProductEvent } from '../../../../lib/productEvents';
import {
  createLoginThrottleBackend,
  checkLoginThrottle,
  recordLoginFailure,
} from '../../../../lib/loginThrottle';

// POST /api/auth/login — the ONE login path. Public (middleware PUBLIC_PATHS).
//
// Supabase Auth is the only login path. On success the @supabase/ssr client
// writes the session cookies onto the response; authorization metadata
// (role / status / firm / onboarding) rides in the JWT's app_metadata.
//
// Sequence: body-size guard → JSON parse → throttle (per-IP attempts AND the
// target account's failure budget) → Supabase signInWithPassword →
// app_metadata.status check → record a failure if it was one → capture
// Set-Cookie → product event. From here the browser's next request goes through
// middleware.ts, which refreshes the cookie (lib/supabase/middleware.updateSession)
// and applies the disabled / admin-only / onboarding gates.
//
// Two deliberate properties worth knowing before changing anything here:
//   - A wrong password, an unknown address and a spent per-account failure
//     budget all answer 401 invalid_credentials, so this route never confirms an
//     address has an account. A DISABLED account is the one exception
//     (403 account_disabled) — the password was correct, so nothing is leaked to
//     someone who does not already hold it.
//   - The throttle policy lives in lib/loginThrottle.ts (a route.ts may not
//     export helpers). Two counters: every attempt against `login-rl:<hmac(ip)>`
//     at 10 per 15 min, and FAILURES ONLY against `login-fail:<hmac(email)>` at
//     10 per hour. Unlike every other limiter in this repo, login does NOT fail
//     open when Upstash is down — it degrades to a per-instance in-process
//     limiter, which is weak (N warm instances multiply the cap by N) but not
//     absent. See that module's header for why.

const MAX_BODY = 4 * 1024;                 // 4 KB — email+password only

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

export async function POST(request: NextRequest): Promise<Response> {
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

  if (!email || !email.includes('@')) {
    return Response.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────
  //
  // The backend is built once and reused below to record a failure, so a single
  // request never opens two Upstash connections and the in-process fallback
  // (if it is in play) counts the attempt and its failure in the same limiter.
  const throttle = createLoginThrottleBackend(getUpstashClient());
  {
    const ip = request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()
            ?? request.headers.get('x-real-ip')
            ?? 'unknown';
    const decision = await checkLoginThrottle(throttle, ip, email);
    if (!decision.allowed) {
      if (decision.reason === 'ip') {
        return Response.json(
          { error: 'rate_limited', message: 'Too many login attempts. Please try again later.' },
          { status: 429, headers: { 'Retry-After': String(Math.ceil(decision.retryAfterMs / 1000)) } },
        );
      }
      // Per-account cap: answer exactly as a wrong password does. Telling the
      // caller the account is locked would confirm the address exists.
      return Response.json({ error: 'invalid_credentials' }, { status: 401 });
    }
  }

  // ── Supabase sign-in ──────────────────────────────────────────────────────
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    return Response.json({ error: 'service_unavailable' }, { status: 503 });
  }

  const captured: Array<{ name: string; value: string; options?: SetCookieOption }> = [];
  let signInOk = false;
  let disabled = false;
  let signedInUserId: string | null = null;

  try {
    const supabase = createServerClient(url, key, {
      cookies: {
        getAll() { return request.cookies.getAll(); },
        setAll(items) {
          items.forEach(({ name, value, options }) =>
            captured.push({ name, value, options: options as SetCookieOption }),
          );
        },
      },
    });
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    if (!error && data.user) {
      const meta = (data.user.app_metadata ?? {}) as { status?: string };
      if (meta.status === 'disabled') {
        disabled = true;
        await supabase.auth.signOut().catch(() => {});
      } else {
        signInOk = true;
        signedInUserId = data.user.id;
      }
    }
  } catch {
    return Response.json({ error: 'service_unavailable' }, { status: 503 });
  }

  if (disabled) {
    return Response.json(
      { error: 'account_disabled', message: 'This account has been disabled. Contact your administrator.' },
      { status: 403 },
    );
  }

  if (!signInOk) {
    // Count it against this account's hourly failure budget. Only wrong
    // credentials land here: the disabled branch returned above, because there
    // the password was correct and the attempt is not an attack.
    await recordLoginFailure(throttle, email);
    // Uniform error — do not reveal whether the email exists.
    return Response.json({ error: 'invalid_credentials' }, { status: 401 });
  }

  void trackProductEvent({ type: 'signed_in', actorId: signedInUserId });

  const response = NextResponse.json({ ok: true });
  for (const { name, value, options = {} } of captured) {
    response.cookies.set(name, value, options);
  }
  return response;
}
