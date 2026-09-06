import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { verifySignupToken, hashToken } from '../../../../lib/signupToken';
import { getUpstashClient } from '../../../../lib/upstashRedis';
import { ensureSupabaseUser } from '../../../../lib/supabase/admin';
import {
  getUser,
  upsertUser,
  getFirm,
  countActiveUsersForFirm,
  recordSeatRequest,
  sendSeatLimitNotification,
} from '../../../../lib/firmStore';
import { syncOrgSeatQuantity } from '../../../../lib/orgBilling';

const HOUR_MS    = 60 * 60 * 1000;
const RATE_LIMIT = 5;

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

function passwordError(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (!/\d/.test(password)) return 'Password must contain at least one number.';
  return null;
}

// Signs in via Supabase and captures the session Set-Cookie entries.
// Returns an empty array on failure so callers always get a usable value.
async function trySupabaseSignIn(
  request: NextRequest,
  email: string,
  password: string,
): Promise<Array<{ name: string; value: string; options?: SetCookieOption }>> {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) return [];

  try {
    const captured: Array<{ name: string; value: string; options?: SetCookieOption }> = [];
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
    if (error || !data.user) return [];
    return captured;
  } catch {
    return [];
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const token = request.nextUrl.searchParams.get('token') ?? '';

  // ── 1. Verify token signature + expiry ────────────────────────────────────
  const verified = verifySignupToken(token);

  if (!verified.valid) {
    if (verified.expired) {
      return Response.json(
        { error: 'invite_expired', message: 'This invitation link has expired. Contact your administrator for a new one.' },
        { status: 410 },
      );
    }
    return Response.json(
      { error: 'invite_invalid', message: 'This invitation is invalid or has already been used.' },
      { status: 404 },
    );
  }

  const { email, firmName } = verified;
  const domain = email.split('@')[1] ?? '';
  const hash   = hashToken(token);

  const redis = getUpstashClient();
  if (!redis) {
    return Response.json({ error: 'service_unavailable' }, { status: 503 });
  }

  // ── 2. Rate limit ─────────────────────────────────────────────────────────
  const { count } = await redis.incrWithWindow(`invite-rl:${hash.slice(0, 16)}`, HOUR_MS);
  if (count > RATE_LIMIT) {
    return Response.json(
      { error: 'rate_limited', message: 'Too many attempts. Try again later.' },
      { status: 429 },
    );
  }

  // ── 3. Parse + validate body ──────────────────────────────────────────────
  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const b               = body as Record<string, unknown>;
  const password        = typeof b.password        === 'string' ? b.password        : '';
  const confirmPassword = typeof b.confirmPassword === 'string' ? b.confirmPassword : '';

  if (password !== confirmPassword) {
    return Response.json({ error: 'passwords_mismatch', message: 'Passwords do not match.' }, { status: 400 });
  }

  const pwErr = passwordError(password);
  if (pwErr) return Response.json({ error: 'invalid_password', message: pwErr }, { status: 400 });

  // ── 4. Check token not consumed ───────────────────────────────────────────
  const storedEmail = await redis.get(`invite-token:${hash}`);
  if (!storedEmail) {
    return Response.json(
      { error: 'invite_used', message: 'This invite link has already been used.' },
      { status: 409 },
    );
  }

  // ── 5. Get user record — must exist and be pending ────────────────────────
  let user;
  try {
    user = await getUser(email);
  } catch {
    console.error('[auth/set-password] failed to read user', { email: '[redacted]' });
    return Response.json({ error: 'invite_used' }, { status: 409 });
  }

  if (!user || user.status !== 'pending') {
    return Response.json(
      { error: 'invite_used', message: 'This invite link has already been used.' },
      { status: 409 },
    );
  }

  // ── 6. Atomic token consumption ───────────────────────────────────────────
  const consumed = await redis.getAndDel(`invite-token:${hash}`);
  if (!consumed) {
    return Response.json(
      { error: 'invite_used', message: 'This invite link has already been used.' },
      { status: 409 },
    );
  }

  // ── 7. Check active seat count BEFORE activating ──────────────────────────
  if (domain) {
    try {
      const [firm, activeCount] = await Promise.all([
        getFirm(domain),
        countActiveUsersForFirm(domain),
      ]);

      // seat_limit is an optional platform-admin cap; null means unlimited.
      const seatLimit = firm?.seatLimit ?? null;

      if (seatLimit !== null && activeCount >= seatLimit) {
        await recordSeatRequest(email, domain, {
          name:     `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim(),
          firmName: firm?.name ?? firmName,
        }).catch(() => {});
        await sendSeatLimitNotification({
          attemptedEmail:  email,
          firmName:        firm?.name ?? firmName,
          firmDomain:      domain,
          activeSeatCount: activeCount,
          seatLimit,
        });

        return Response.json(
          {
            error:   'seat_limit_reached',
            message: "Your firm's account is full. Reach out to your account admin to add more seats.",
          },
          { status: 403 },
        );
      }
    } catch { /* non-fatal — let activation proceed */ }
  }

  // ── 8. Set the Supabase password + activate the account ──────────────────
  const authId = await ensureSupabaseUser(email, password);
  if (!authId) {
    console.error('[auth/set-password] failed to set password', { email: '[redacted]' });
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  try {
    await upsertUser(email, {
      status:             'active',
      onboardingComplete: false, // new users always begin onboarding
      ...(domain ? { firmDomain: domain } : {}),
    });
  } catch {
    console.error('[auth/set-password] failed to activate user', { email: '[redacted]' });
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  // The organization just gained an active seat. upsertUser already syncs on a
  // membership status change; this is the explicit belt-and-braces call and is
  // idempotent. Never fails the activation.
  const activated = await getUser(email).catch(() => null);
  if (activated?.orgId) {
    try { await syncOrgSeatQuantity(activated.orgId); } catch { /* best effort */ }
  }

  // ── 9. Sign in and return the session cookies ─────────────────────────────
  const supabaseCookies = await trySupabaseSignIn(request, email, password);

  const response = NextResponse.json({ ok: true });
  for (const { name, value, options = {} } of supabaseCookies) {
    response.cookies.set(name, value, options);
  }
  return response;
}
