import { NextRequest } from 'next/server';
import { adminGuard } from '../../../../lib/auth';
import { getUpstashClient } from '../../../../lib/upstashRedis';
import { generateSignupToken } from '../../../../lib/signupToken';
import { sendInviteEmail } from '../../../../lib/sendAvailabilityRequest';
import {
  isApprovedDomain,
  getFirm,
  getUser,
  upsertUser,
  countActiveUsersForFirm,
  SEAT_LIMITS,
  recordSeatRequest,
  sendSeatLimitNotification,
  tryClaimSeat,
  releaseSeatClaim,
} from '../../../../lib/firmStore';

export async function POST(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const b = body as Record<string, unknown>;

  // ── 1. Validate email ──────────────────────────────────────────────────────
  const email = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';
  if (!email || !email.includes('@') || email.split('@').length !== 2) {
    return Response.json({ error: 'invalid_email', message: 'A valid email address is required.' }, { status: 400 });
  }

  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (!domain) {
    return Response.json({ error: 'invalid_email', message: 'A valid email address is required.' }, { status: 400 });
  }

  // ── 2. Check domain is approved ────────────────────────────────────────────
  const approved = await isApprovedDomain(domain);
  if (!approved) {
    return Response.json(
      { error: 'domain_not_approved', message: 'This email domain is not approved for access. Contact your administrator.' },
      { status: 400 },
    );
  }

  // ── 3. Get firm record ─────────────────────────────────────────────────────
  const firm = await getFirm(domain);
  if (!firm) {
    return Response.json({ error: 'firm_not_found', message: 'Firm record not found.' }, { status: 404 });
  }

  // ── 4. Check for duplicate active/pending user ─────────────────────────────
  const existing = await getUser(email);
  if (existing && (existing.status === 'active' || existing.status === 'pending')) {
    return Response.json(
      { error: 'user_exists', message: 'A user with this email already exists.' },
      { status: 409 },
    );
  }

  // ── 5. Check seat limit ────────────────────────────────────────────────────
  const activeSeatCount = await countActiveUsersForFirm(domain);
  const seatLimit       = SEAT_LIMITS[firm.plan];

  if (activeSeatCount >= seatLimit) {
    await recordSeatRequest(email, domain).catch(() => {});
    await sendSeatLimitNotification({
      attemptedEmail: email,
      firmName:       firm.name,
      firmDomain:     domain,
      activeSeatCount,
      seatLimit,
    });
    return Response.json(
      { error: 'seat_limit_reached', message: 'Seat limit reached for this firm. Admin has been notified.' },
      { status: 403 },
    );
  }

  // ── 6. Concurrent protection ───────────────────────────────────────────────
  const claimResult = await tryClaimSeat(domain, email, 10);
  if (claimResult === 'concurrent_signup') {
    return Response.json({ error: 'concurrent_signup' }, { status: 409 });
  }

  try {
    // ── 7. Create pending user ───────────────────────────────────────────────
    const inviteExpiresAt = Date.now() + 24 * 60 * 60 * 1000;
    await upsertUser(email, {
      firmDomain:           domain,
      firmName:             firm.name,
      role:                 'user',
      status:               'pending',
      passwordHash:         '',
      createdAt:            Date.now(),
      inviteTokenExpiresAt: inviteExpiresAt,
    });

    // ── 8. Generate invite token ─────────────────────────────────────────────
    const { token, hash, expiry } = generateSignupToken(email, firm.name);
    const ttlSeconds = Math.floor((expiry - Date.now()) / 1000);

    const redis = getUpstashClient();
    if (!redis) {
      return Response.json({ error: 'storage_unavailable' }, { status: 503 });
    }

    // Store under new key (invite-token:) for the set-password flow
    await redis.set(`invite-token:${hash}`, email, { ex: ttlSeconds });

    // ── 9. Build set-password URL + send invite ──────────────────────────────
    const appUrl         = process.env.NEXT_PUBLIC_APP_URL ?? '';
    const setPasswordUrl = `${appUrl}/auth/set-password?token=${encodeURIComponent(token)}`;

    try {
      await sendInviteEmail(email, firm.name, setPasswordUrl);
    } catch {
      console.error('[admin/invite] invite email failed', { email: '[redacted]' });
      // Don't fail — token is already stored
      return Response.json({ ok: true, warning: 'Invite email failed to send' });
    }

    console.log('[admin/invite] invite sent', { domain });
    return Response.json({ ok: true });
  } finally {
    // ── 10. Release claim key ────────────────────────────────────────────────
    await releaseSeatClaim(domain, email).catch(() => {});
  }
}
