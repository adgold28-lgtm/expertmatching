import { NextRequest } from 'next/server';
import { adminGuard } from '../../../../lib/auth';
import { getUpstashClient } from '../../../../lib/upstashRedis';
import { generateSignupToken } from '../../../../lib/signupToken';
import { sendInviteEmail } from '../../../../lib/sendAvailabilityRequest';
import { setFirmPlan, type FirmPlan } from '../../../../lib/domainWhitelist';

interface AccessRequest {
  name:        string;
  firm:        string;
  email:       string;
  useCase:     string;
  submittedAt: number;
}

const VALID_PLANS = new Set<FirmPlan>(['starter', 'growth', 'enterprise']);

export async function GET(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  try {
    const redis = getUpstashClient();
    if (!redis) return Response.json({ requests: [] });

    const raw = await redis.get('access-requests:list');
    const list: AccessRequest[] = raw ? JSON.parse(raw) : [];
    return Response.json({ requests: list });
  } catch {
    return Response.json({ error: 'Failed to load requests' }, { status: 500 });
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null) {
    return Response.json({ error: 'Invalid request' }, { status: 400 });
  }

  const b      = body as Record<string, unknown>;
  const action = b.action;
  const email  = typeof b.email === 'string' ? b.email.trim().toLowerCase() : '';

  if (!email || !email.includes('@')) {
    return Response.json({ error: 'Valid email required' }, { status: 400 });
  }

  const redis = getUpstashClient();
  if (!redis) return Response.json({ error: 'Storage unavailable' }, { status: 503 });

  if (action === 'reject') {
    await removeFromList(redis, email);
    return Response.json({ ok: true });
  }

  if (action === 'approve') {
    const rawPlan = typeof b.plan === 'string' ? b.plan : 'starter';
    const plan: FirmPlan = VALID_PLANS.has(rawPlan as FirmPlan) ? (rawPlan as FirmPlan) : 'starter';

    // Retrieve firm name from pending request record
    const requestRaw = await redis.get(`access-request:${email}`);
    let firmName = email.split('@')[0] ?? email;
    if (requestRaw) {
      try {
        const req: AccessRequest = JSON.parse(requestRaw);
        if (req.firm) firmName = req.firm;
      } catch { /* use default */ }
    }

    // Set firm plan
    const domain = email.split('@')[1] ?? '';
    if (domain) await setFirmPlan(domain, plan);

    // Generate signup token and store in Redis (7-day TTL)
    const { token, hash, expiry } = generateSignupToken(email, firmName);
    const ttlSeconds = Math.floor((expiry - Date.now()) / 1000);
    await redis.set(`signup-token:${hash}`, email, { ex: ttlSeconds });

    // Send invite email
    const appUrl    = process.env.NEXT_PUBLIC_APP_URL ?? '';
    const signupUrl = `${appUrl}/signup/${token}`;

    try {
      await sendInviteEmail(email, firmName, signupUrl);
    } catch (emailErr) {
      console.error('[admin/requests] invite email failed', { email: '[redacted]' });
      // Don't fail the action — token is already in Redis
      return Response.json({ ok: true, warning: 'Invite email failed to send' });
    }

    // Remove from pending list
    await removeFromList(redis, email);

    console.log('[admin/requests] approved', { domain, plan });
    return Response.json({ ok: true });
  }

  return Response.json({ error: 'Invalid action' }, { status: 400 });
}

async function removeFromList(
  redis: Awaited<ReturnType<typeof getUpstashClient>>,
  email: string,
): Promise<void> {
  if (!redis) return;
  try {
    await redis.del(`access-request:${email}`);
    const listRaw = await redis.get('access-requests:list');
    if (!listRaw) return;
    const list: AccessRequest[] = JSON.parse(listRaw);
    const filtered = list.filter(r => r.email !== email);
    await redis.set('access-requests:list', JSON.stringify(filtered));
  } catch { /* best effort */ }
}
