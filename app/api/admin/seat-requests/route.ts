import { NextRequest } from 'next/server';
import { adminGuard } from '../../../../lib/auth';
import { getUpstashClient } from '../../../../lib/upstashRedis';
import { generateSignupToken } from '../../../../lib/signupToken';
import { sendInviteEmail } from '../../../../lib/sendAvailabilityRequest';
import {
  listSeatRequests,
  removeSeatRequest,
  getFirm,
  getUser,
  upsertUser,
  countActiveUsersForFirm,
  SEAT_LIMITS,
  tryClaimSeat,
  releaseSeatClaim,
} from '../../../../lib/firmStore';

// GET — list pending seat requests
export async function GET(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  try {
    const requests = await listSeatRequests();
    return Response.json({ requests });
  } catch {
    console.error('[admin/seat-requests] failed to list');
    return Response.json({ error: 'Failed to load seat requests' }, { status: 500 });
  }
}

// POST { email, action: 'approve' | 'reject' }
export async function POST(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const b      = body as Record<string, unknown>;
  const email  = typeof b.email  === 'string' ? b.email.trim().toLowerCase()  : '';
  const action = typeof b.action === 'string' ? b.action                       : '';

  if (!email || !email.includes('@')) {
    return Response.json({ error: 'valid_email_required' }, { status: 400 });
  }

  if (action !== 'approve' && action !== 'reject') {
    return Response.json({ error: 'action must be "approve" or "reject"' }, { status: 400 });
  }

  if (action === 'reject') {
    try {
      await removeSeatRequest(email);
      return Response.json({ ok: true });
    } catch {
      return Response.json({ error: 'Failed to reject request' }, { status: 500 });
    }
  }

  // action === 'approve' — run invite logic
  const domain = email.split('@')[1]?.toLowerCase() ?? '';
  if (!domain) {
    return Response.json({ error: 'invalid_email' }, { status: 400 });
  }

  const firm = await getFirm(domain);
  if (!firm) {
    return Response.json({ error: 'firm_not_found' }, { status: 404 });
  }

  // Re-check seat limit
  const activeSeatCount = await countActiveUsersForFirm(domain);
  const seatLimit       = SEAT_LIMITS[firm.plan];
  if (activeSeatCount >= seatLimit) {
    return Response.json(
      { error: 'seat_limit_still_reached', message: 'Seat limit is still reached. Upgrade the firm plan first.' },
      { status: 403 },
    );
  }

  // Concurrent protection
  const claimResult = await tryClaimSeat(domain, email, 10);
  if (claimResult === 'concurrent_signup') {
    return Response.json({ error: 'concurrent_signup' }, { status: 409 });
  }

  try {
    // Check existing user
    const existing = await getUser(email);
    if (existing && existing.status === 'active') {
      // Already active — just remove the seat request
      await removeSeatRequest(email).catch(() => {});
      return Response.json({ ok: true });
    }

    // Upsert as pending
    await upsertUser(email, {
      firmDomain:           domain,
      firmName:             firm.name,
      role:                 'user',
      status:               'pending',
      passwordHash:         existing?.passwordHash ?? '',
      createdAt:            existing?.createdAt    ?? Date.now(),
      inviteTokenExpiresAt: Date.now() + 24 * 60 * 60 * 1000,
    });

    // Generate + store invite token
    const { token, hash, expiry } = generateSignupToken(email, firm.name);
    const ttlSeconds = Math.floor((expiry - Date.now()) / 1000);

    const redis = getUpstashClient();
    if (!redis) {
      return Response.json({ error: 'storage_unavailable' }, { status: 503 });
    }

    await redis.set(`invite-token:${hash}`, email, { ex: ttlSeconds });

    // Build set-password URL + send invite
    const appUrl         = process.env.NEXT_PUBLIC_APP_URL ?? '';
    const setPasswordUrl = `${appUrl}/auth/set-password?token=${encodeURIComponent(token)}`;

    try {
      await sendInviteEmail(email, firm.name, setPasswordUrl);
    } catch {
      console.error('[admin/seat-requests] invite email failed', { email: '[redacted]' });
      await removeSeatRequest(email).catch(() => {});
      return Response.json({ ok: true, warning: 'Invite email failed to send' });
    }

    await removeSeatRequest(email);
    console.log('[admin/seat-requests] approved + invite sent', { domain });
    return Response.json({ ok: true });
  } finally {
    await releaseSeatClaim(domain, email).catch(() => {});
  }
}
