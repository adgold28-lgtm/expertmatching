// POST /api/auth/set-password?token=…&th=… — the one place a password is chosen.
//
// A link has two halves (lib/authLinks.ts): `token`, our own HMAC-signed
// payload (email, organization, kind, expiry — stateless, so a tampered or
// expired link is refused without a storage read), and `th`, a Supabase
// recovery token hash that Supabase keeps, expires and burns on first use.
// Redeeming `th` is what makes a link single-use; there is no Redis in this
// path any more, so a rate-limited cache can no longer stop an invitee.
//
// Two token kinds land here (lib/signupToken):
//   'invite' — a pending account is activated. The invite's own organization
//              (payload orgId) decides the membership and the seat check;
//              legacy tokens without one fall back to the email domain.
//   'reset'  — an ACTIVE account replaces its password. Nothing else moves: no
//              status change, no membership write, no onboarding reset.
//
// Ordering matters: the seat cap is checked BEFORE the link is redeemed, so a
// capped firm leaves the invitee holding a link that still works once a seat
// is freed.

import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { verifySignupToken, hashToken, type SignupTokenKind } from '../../../../lib/signupToken';
import { redeemSetPasswordLink } from '../../../../lib/authLinks';
import { getUpstashClient } from '../../../../lib/upstashRedis';
import { getSupabaseAdminClient, getAuthUserIdByEmail } from '../../../../lib/supabase/admin';
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
import { trackProductEvent } from '../../../../lib/productEvents';

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

function linkExpired(kind: SignupTokenKind): Response {
  return Response.json(
    {
      error:   kind === 'reset' ? 'reset_expired' : 'invite_expired',
      message: kind === 'reset'
        ? 'This reset link has expired. Request a new one from the sign-in page.'
        : 'This invitation has expired. Ask for a new one to continue.',
    },
    { status: 410 },
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

/** Best-effort per-link attempt cap. Redis down = no cap, never a refusal. */
async function overAttemptLimit(rawToken: string): Promise<boolean> {
  const redis = getUpstashClient();
  if (!redis) return false;
  try {
    const { count } = await redis.incrWithWindow(`invite-rl:${hashToken(rawToken).slice(0, 16)}`, HOUR_MS);
    return count > RATE_LIMIT;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const token       = request.nextUrl.searchParams.get('token') ?? '';
  const hashedToken = request.nextUrl.searchParams.get('th')    ?? '';

  // ── 1. Verify our token's signature + expiry (stateless) ──────────────────
  const verified = verifySignupToken(token);

  if (!verified.valid) {
    if (verified.expired) return linkExpired('invite');
    return Response.json(
      { error: 'invite_invalid', message: 'This link is invalid or has already been used.' },
      { status: 404 },
    );
  }

  const { email, firmName, orgId, kind } = verified;

  // A link minted before single use moved to Supabase has no `th`. Those links
  // were stored in Redis, which is no longer consulted — ask for a fresh one.
  if (!hashedToken) {
    return Response.json(
      {
        error:   kind === 'reset' ? 'reset_invalid' : 'invite_invalid',
        message: 'This link is from an older invitation. Ask for a new one to continue.',
      },
      { status: 404 },
    );
  }

  // ── 2. Attempt cap (best effort) ──────────────────────────────────────────
  if (await overAttemptLimit(token)) {
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

  return kind === 'reset'
    ? handleReset(request, hashedToken, email, password)
    : handleInvite(request, hashedToken, email, password, firmName, orgId);
}

/** Redeems the single-use half, mapping Supabase's answer onto our errors. */
async function redeemOrRefuse(
  request:     NextRequest,
  hashedToken: string,
  email:       string,
  kind:        SignupTokenKind,
): Promise<{ ok: true; userId: string } | { ok: false; response: Response }> {
  const redeemed = await redeemSetPasswordLink(request, hashedToken, email);
  if (redeemed.ok) return redeemed;
  if (redeemed.reason === 'expired') return { ok: false, response: linkExpired(kind) };
  if (redeemed.reason === 'invalid') return { ok: false, response: linkSpent(kind) };
  return {
    ok: false,
    response: Response.json(
      { error: 'temporarily_unavailable', message: 'We couldn’t check your link just now — try again in a minute.' },
      { status: 503 },
    ),
  };
}

// ─── Reset: swap the password, touch nothing else ─────────────────────────────

async function handleReset(
  request:     NextRequest,
  hashedToken: string,
  email:       string,
  password:    string,
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

  const redeemed = await redeemOrRefuse(request, hashedToken, email, 'reset');
  if (!redeemed.ok) return redeemed.response;

  const admin = getSupabaseAdminClient();
  if (!admin) {
    console.error('[auth/set-password] reset: admin client unavailable');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  const { error } = await admin.auth.admin.updateUserById(redeemed.userId, { password });
  if (error) {
    console.error('[auth/set-password] reset failed to update the password');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }

  return signedInResponse(await trySupabaseSignIn(request, email, password));
}

// ─── Invite: activate the pending account inside its own organization ─────────

async function handleInvite(
  request:     NextRequest,
  hashedToken: string,
  email:       string,
  password:    string,
  firmName:    string,
  orgId:       string | null,
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

  // ── Seat cap — checked BEFORE the link is redeemed ────────────────────────
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

  // ── Redeem the single-use half ────────────────────────────────────────────
  const redeemed = await redeemOrRefuse(request, hashedToken, email, 'invite');
  if (!redeemed.ok) return redeemed.response;

  // ── Set the Supabase password + activate the account ──────────────────────
  const admin  = getSupabaseAdminClient();
  const authId = redeemed.userId || (await getAuthUserIdByEmail(email).catch(() => null));
  if (!admin || !authId) {
    console.error('[auth/set-password] invite: could not resolve the account');
    return Response.json({ error: 'internal_error' }, { status: 500 });
  }
  const { error: pwError } = await admin.auth.admin.updateUserById(authId, { password });
  if (pwError) {
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
      await recordSystemFailure({ area: 'seat_sync', reason: err, organizationId: seatOrgId });
    }
  }

  await trackProductEvent({
    type:           'account_activated',
    actorId:        authId,
    organizationId: seatOrgId ?? null,
  });

  return signedInResponse(await trySupabaseSignIn(request, email, password));
}
