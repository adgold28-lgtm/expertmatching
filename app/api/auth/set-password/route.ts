import { NextRequest } from 'next/server';
import { verifySignupToken, hashToken } from '../../../../lib/signupToken';
import { hashPassword } from '../../../../lib/authPassword';
import { createSessionCookie, COOKIE_NAME, SESSION_TTL_MS } from '../../../../lib/auth';
import { getUpstashClient } from '../../../../lib/upstashRedis';
import {
  getUser,
  upsertUser,
  getFirm,
  countActiveUsersForFirm,
  SEAT_LIMITS,
  recordSeatRequest,
  sendSeatLimitNotification,
} from '../../../../lib/firmStore';

const HOUR_MS    = 60 * 60 * 1000;
const RATE_LIMIT = 5; // attempts per token per hour

function passwordError(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (!/\d/.test(password)) return 'Password must contain at least one number.';
  return null;
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

  // ── 2. Rate limit: max 5 attempts per token per hour ─────────────────────
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

      const plan       = firm?.plan ?? 'starter';
      const seatLimit  = SEAT_LIMITS[plan];

      if (activeCount >= seatLimit) {
        // Record seat request and notify admin
        await recordSeatRequest(email, domain).catch(() => {});
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

  // ── 8. Activate user ──────────────────────────────────────────────────────
  try {
    await upsertUser(email, {
      passwordHash: hashPassword(password),
      status:       'active',
    });
  } catch {
    console.error('[auth/set-password] failed to activate user', { email: '[redacted]' });
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  // ── 9. Create session ─────────────────────────────────────────────────────
  // Re-read so we have the freshest role/firmName
  const activatedUser = await getUser(email).catch(() => null);
  const role          = activatedUser?.role     ?? 'user';
  const resolvedName  = activatedUser?.firmName ?? firmName;

  const sessionToken = await createSessionCookie(role, email, resolvedName);

  console.log('[auth/set-password] account activated', { domain: domain || '[redacted]' });
  return sessionResponse(sessionToken);
}

function sessionResponse(token: string): Response {
  const isProduction = process.env.NODE_ENV === 'production';
  const maxAge       = Math.floor(SESSION_TTL_MS / 1000);

  const setCookie = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    `Max-Age=${maxAge}`,
    'Path=/',
    'SameSite=Lax',
    ...(isProduction ? ['Secure'] : []),
  ].join('; ');

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': setCookie,
    },
  });
}
