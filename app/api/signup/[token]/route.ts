import { NextRequest } from 'next/server';
import { verifySignupToken, hashToken } from '../../../../lib/signupToken';
import { hashPassword } from '../../../../lib/authPassword';
import { createSessionCookie, COOKIE_NAME, SESSION_TTL_MS } from '../../../../lib/auth';
import { getUpstashClient } from '../../../../lib/upstashRedis';
import {
  getFirmPlan,
  countUsersForDomain,
  addUserToDomain,
  SEAT_LIMITS,
} from '../../../../lib/domainWhitelist';

const HOUR_MS    = 60 * 60 * 1000;
const RATE_LIMIT = 5; // attempts per token per hour

interface UserRecord {
  email:        string;
  firmName:     string;
  passwordHash: string;
  createdAt:    number;
  domain:       string;
}

function passwordError(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters.';
  if (!/\d/.test(password)) return 'Password must contain at least one number.';
  return null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } },
): Promise<Response> {
  const rawToken = params.token ?? '';

  // ── 1. Verify token signature + expiry ────────────────────────────────────
  const verified = verifySignupToken(rawToken);

  if (!verified.valid) {
    if (verified.expired) {
      return Response.json({ error: 'invite_expired', message: 'This invite link has expired.' }, { status: 410 });
    }
    return Response.json({ error: 'invite_invalid', message: 'This invite link is invalid.' }, { status: 404 });
  }

  const { email, firmName } = verified;
  const domain = email.split('@')[1] ?? '';
  const hash   = hashToken(rawToken);

  const redis = getUpstashClient();
  if (!redis) {
    return Response.json({ error: 'service_unavailable' }, { status: 503 });
  }

  // ── 2. Rate limit: max 5 attempts per token per hour ─────────────────────
  const { count } = await redis.incrWithWindow(`signup-rl:${hash.slice(0, 16)}`, HOUR_MS);
  if (count > RATE_LIMIT) {
    return Response.json({ error: 'rate_limited', message: 'Too many attempts. Try again later.' }, { status: 429 });
  }

  // ── 3. Parse + validate body ──────────────────────────────────────────────
  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const b        = body as Record<string, unknown>;
  const password = typeof b.password === 'string' ? b.password : '';

  const pwErr = passwordError(password);
  if (pwErr) return Response.json({ error: 'invalid_password', message: pwErr }, { status: 400 });

  // ── 4. Check seat limits BEFORE consuming the token ───────────────────────
  if (domain) {
    try {
      const [plan, used] = await Promise.all([getFirmPlan(domain), countUsersForDomain(domain)]);
      const limit = SEAT_LIMITS[plan];
      if (used >= limit) {
        return Response.json(
          {
            error:   'seat_limit_reached',
            message: "Your firm's account is full. Reach out to your account admin to add more seats.",
          },
          { status: 403 },
        );
      }
    } catch { /* non-fatal: proceed */ }
  }

  // ── 5. Atomic token consumption (single-use) ──────────────────────────────
  const tokenOwner = await redis.getAndDel(`signup-token:${hash}`);
  if (!tokenOwner) {
    return Response.json(
      { error: 'invite_used', message: 'This invite link has already been used.' },
      { status: 409 },
    );
  }

  // ── 6. Check no existing account for this email ───────────────────────────
  const existing = await redis.get(`user:${email}`);
  if (existing) {
    return Response.json(
      { error: 'account_exists', message: 'An account already exists for this email.' },
      { status: 409 },
    );
  }

  // ── 7. Create user record ─────────────────────────────────────────────────
  const userRecord: UserRecord = {
    email,
    firmName,
    passwordHash: hashPassword(password),
    createdAt:    Date.now(),
    domain,
  };

  await redis.set(`user:${email}`, JSON.stringify(userRecord));

  // Track user in domain set for seat counting
  if (domain) {
    await addUserToDomain(domain, email).catch(() => {});
  }

  // ── 8. Create session and respond ─────────────────────────────────────────
  const sessionToken  = await createSessionCookie('user', email, firmName);
  const isProduction  = process.env.NODE_ENV === 'production';
  const maxAge        = Math.floor(SESSION_TTL_MS / 1000);

  const setCookie = [
    `${COOKIE_NAME}=${sessionToken}`,
    'HttpOnly',
    `Max-Age=${maxAge}`,
    'Path=/',
    'SameSite=Lax',
    ...(isProduction ? ['Secure'] : []),
  ].join('; ');

  console.log('[signup] account created', { domain });

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'Content-Type': 'application/json',
      'Set-Cookie': setCookie,
    },
  });
}
