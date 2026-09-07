// POST /api/auth/set-password?token=… — the one place a password is chosen.
//
// Two token kinds land here (lib/signupToken):
//   'invite' — a pending account is activated. The invite's own organization
//              (payload orgId) decides the membership and the seat check;
//              legacy tokens without one fall back to the email domain, which
//              is what used to silently re-home a cross-domain invitee into a
//              brand-new organization.
//   'reset'  — an ACTIVE account replaces its password. Nothing else moves: no
//              status change, no membership write, no onboarding reset.
//
// Ordering matters: the seat cap is checked BEFORE the token is consumed, so a
// capped firm leaves the invitee holding a link that still works once a seat
// is freed. Redis being unreachable is 503 temporarily_unavailable, never
// "already used" — the two are indistinguishable to a user otherwise.

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { verifySignupToken, hashToken, tokenRedisKey, type SignupTokenKind } from '../../../../lib/signupToken';
import { getUpstashClient } from '../../../../lib/upstashRedis';
import { ensureSupabaseUser, getSupabaseAdminClient, getAuthUserIdByEmail } from '../../../../lib/supabase/admin';
import {
  getUser,
  upsertUser,
  getFirm,
  getFirmById,
  countActiveUsersForFirm,
  recordSeatRequest,
  sendSeatLimitNotification,
  type FirmRecord,
} from '../../../../lib/firmStore';
import { syncOrgSeatQuantity } from '../../../../lib/orgBilling';
import { recordSystemFailure } from '../../../../lib/engagementEvents';

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

/** Redis is down or refusing. Distinct from "this link is spent". */
function temporarilyUnavailable(): Response {
  return Response.json(
    {
      error:   'temporarily_unavailable',
      message: 'We couldn’t check your invitation just now — try again in a minute.',
    },
    { status: 503 },
  );
}

function linkSpent(kind: SignupTokenKind): Response {
  return kind === 'reset'
    ? Response.json(
        { error: 'reset_used', message: 'This reset link has already been used or has expired. Request a new one.' },
        { status: 409 },
      )
    : Response.json(
        { error: 'invite_used', message: 'This invite link has already been used.' },
        { status: 409 },
      );
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

/**
 * The response every successful path returns: session cookies when the sign-in
 * worked, `signedIn: false` when it did not so the form can send the user to
 * /login?ready=1 instead of bouncing them off a guarded page.
 */
function signedInResponse(
  cookies: Array<{ name: string; value: string; options?: SetCookieOption }>,
): Response {
  if (cookies.length === 0) return Response.json({ ok: true, signedIn: false });

  const response = NextResponse.json({ ok: true, signedIn: true });
  for (const { name, value, options = {} } of cookies) {
    response.cookies.set(name, value, options);
  }
  return response;
}

export async function POST(request: NextRequest): Promise<Response> {
  const token = request.nextUrl.searchParams.get('token') ?? '';

  // ── 1. Verify token signature + expiry ────────────────────────────────────
  const verified = verifySignupToken(token);

  if (!verified.valid) {
    if (verified.expired) {
      return Response.json(
        { error: 'invite_expired', message: 'This link has expired. Request a new one to continue.' },
        { status: 410 },
      );
    }
    return Response.json(
      { error: 'invite_invalid', message: 'This link is invalid or has already been used.' },
      { status: 404 },
    );
  }

  const { email, firmName, orgId, kind } = verified;
  const hash     = hashToken(token);
  const redisKey = tokenRedisKey(kind, hash);

  const redis = getUpstashClient();
  if (!redis) return temporarilyUnavailable();

  // ── 2. Rate limit ─────────────────────────────────────────────────────────
  try {
    const { count } = await redis.incrWithWindow(`invite-rl:${hash.slice(0, 16)}`, HOUR_MS);
    if (count > RATE_LIMIT) {
      return Response.json(
        { error: 'rate_limited', message: 'Too many attempts. Try again later.' },
        { status: 429 },
      );
    }
  } catch {
    return temporarilyUnavailable();
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

  // ── 4. Check the token has not been consumed (peek only) ──────────────────
  let stored: string | null;
  try {
    stored = await redis.get(redisKey);
  } catch {
    return temporarilyUnavailable();
  }
  if (!stored) return linkSpent(kind);

  return kind === 'reset'
    ? handleReset(request, redis, redisKey, email, password)
    : handleInvite(request, redis, redisKey, email, password, firmName, orgId);
}

type Redis = NonNullable<ReturnType<typeof getUpstashClient>>;

// ─── Reset: swap the password, touch nothing else ─────────────────────────────

async function handleReset(
  request:  NextRequest,
  redis:    Redis,
  redisKey: string,
  email:    string,
  password: string,
): Promise<Response> {
  const user = await getUser(email).catch(() => null);
  if (!user || user.status !== 'active') {
    return Response.json(
      {
        error:   'reset_invalid',
        message: 'This reset link is no longer valid. Request a new one from the sign-in page.',
      },
      { status: 409 },
    );
  }

  let consumed: string | null;
  try {
    consumed = await redis.getAndDel(redisKey);
  } catch {
    return temporarilyUnavailable();
  }
  if (!consumed) return linkSpent('reset');

  const admin  = getSupabaseAdminClient();
  const authId = await getAuthUserIdByEmail(email).catch(() => null);
  if (!admin || !authId) {
    console.error('[auth/set-password] reset could not resolve the account');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  const { error } = await admin.auth.admin.updateUserById(authId, { password });
  if (error) {
    console.error('[auth/set-password] reset failed to update the password');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  return signedInResponse(await trySupabaseSignIn(request, email, password));
}

// ─── Invite: activate the pending account inside its own organization ─────────

async function handleInvite(
  request:  NextRequest,
  redis:    Redis,
  redisKey: string,
  email:    string,
  password: string,
  firmName: string,
  orgId:    string | null,
): Promise<Response> {
  // ── The user record must exist and still be pending ───────────────────────
  let user;
  try {
    user = await getUser(email);
  } catch {
    console.error('[auth/set-password] failed to read user');
    return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
  }

  if (!user || user.status !== 'pending') {
    return linkSpent('invite');
  }

  // ── The organization the invite was issued for ────────────────────────────
  // orgId wins over the email domain: a platform admin may invite an address
  // whose domain differs from the firm's, and deriving the org from the domain
  // would create a second, empty organization for that person.
  const emailDomain = email.split('@')[1] ?? '';
  let firm: FirmRecord | null = null;
  try {
    firm = orgId ? await getFirmById(orgId) : (emailDomain ? await getFirm(emailDomain) : null);
  } catch {
    firm = null;
  }

  const orgDomain = firm?.domain ?? emailDomain;
  const orgName   = firm?.name   ?? firmName;

  // ── Seat cap — checked BEFORE the token is consumed ───────────────────────
  // seat_limit is an optional platform-admin cap; null means unlimited.
  if (orgDomain) {
    try {
      const activeCount = await countActiveUsersForFirm(orgDomain);
      const seatLimit   = firm?.seatLimit ?? null;

      if (seatLimit !== null && activeCount >= seatLimit) {
        await recordSeatRequest(email, orgDomain, {
          name:     `${user.firstName ?? ''} ${user.lastName ?? ''}`.trim(),
          firmName: orgName,
        }).catch(() => {});
        await sendSeatLimitNotification({
          attemptedEmail:  email,
          firmName:        orgName,
          firmDomain:      orgDomain,
          activeSeatCount: activeCount,
          seatLimit,
        });

        return Response.json(
          {
            error:   'seat_limit_reached',
            message: "Your firm's account is full. Reach out to your account admin to add more seats — your invite link stays valid.",
          },
          { status: 403 },
        );
      }
    } catch { /* non-fatal — a seat-count read failure must not strand an invitee */ }
  }

  // ── Atomic token consumption ──────────────────────────────────────────────
  let consumed: string | null;
  try {
    consumed = await redis.getAndDel(redisKey);
  } catch {
    return temporarilyUnavailable();
  }
  if (!consumed) return linkSpent('invite');

  // ── Set the Supabase password + activate the account ──────────────────────
  const authId = await ensureSupabaseUser(email, password);
  if (!authId) {
    console.error('[auth/set-password] failed to set password');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  try {
    await upsertUser(email, {
      status:             'active',
      onboardingComplete: false, // new users always begin onboarding
      ...(orgDomain ? { firmDomain: orgDomain, firmName: orgName } : {}),
    });
  } catch {
    console.error('[auth/set-password] failed to activate user');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  // The organization just gained an active seat. upsertUser already syncs on a
  // membership status change; this is the explicit belt-and-braces call and is
  // idempotent. Never fails the activation.
  const activated = await getUser(email).catch(() => null);
  const seatOrgId = activated?.orgId ?? firm?.id;
  if (seatOrgId) {
    try {
      await syncOrgSeatQuantity(seatOrgId);
    } catch (err) {
      // Never fails the activation — but no longer disappears either. The row
      // surfaces at GET /api/admin/attention and the nightly reconcile job
      // retries it, so a new seat cannot go unbilled unnoticed.
      await recordSystemFailure({ area: 'seat_sync', reason: err, organizationId: seatOrgId });
    }
  }

  return signedInResponse(await trySupabaseSignIn(request, email, password));
}
