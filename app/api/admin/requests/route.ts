import { NextRequest } from 'next/server';
import { adminGuard } from '../../../../lib/auth';
import { getUpstashClient } from '../../../../lib/upstashRedis';
import { generateSignupToken } from '../../../../lib/signupToken';
import { sendInviteEmail } from '../../../../lib/sendAvailabilityRequest';
import { getServiceRoleClient } from '../../../../lib/supabase/admin';
import { upsertUser, upsertFirm, type FirmPlan } from '../../../../lib/firmStore';

// Wire shape consumed by app/admin/requests/page.tsx — kept stable.
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
    const db = getServiceRoleClient();
    if (!db) return Response.json({ requests: [] });

    const { data } = await db
      .from('access_requests')
      .select('*')
      .eq('kind', 'access')
      .eq('status', 'requested')
      .order('created_at', { ascending: false })
      .limit(500);

    const requests: AccessRequest[] = (data ?? []).map(r => ({
      name:        r.name ?? '',
      firm:        r.firm_name ?? '',
      email:       r.email,
      useCase:     r.use_case ?? '',
      submittedAt: Date.parse(r.created_at) || 0,
    }));
    return Response.json({ requests });
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

  const db = getServiceRoleClient();
  if (!db) return Response.json({ error: 'Storage unavailable' }, { status: 503 });

  if (action === 'reject') {
    await db.from('access_requests')
      .update({ status: 'rejected', reviewed_at: new Date().toISOString() })
      .eq('kind', 'access')
      .eq('email', email)
      .eq('status', 'requested');
    return Response.json({ ok: true });
  }

  if (action === 'approve') {
    const rawPlan = typeof b.plan === 'string' ? b.plan : 'starter';
    const plan: FirmPlan = VALID_PLANS.has(rawPlan as FirmPlan) ? (rawPlan as FirmPlan) : 'starter';

    // Retrieve firm name from the pending request record.
    const { data: pending } = await db
      .from('access_requests')
      .select('firm_name')
      .eq('kind', 'access')
      .eq('email', email)
      .eq('status', 'requested')
      .maybeSingle();
    const firmName = pending?.firm_name || (email.split('@')[0] ?? email);

    const domain = email.split('@')[1] ?? '';

    // Upsert firm + pending user (auth account is provisioned with a random
    // password; the invite set-password flow replaces it).
    if (domain) {
      await upsertFirm(domain, { name: firmName, plan, status: 'active' }).catch(() => {});
      await upsertUser(email, {
        firmDomain: domain,
        firmName,
        role:       'user',
        status:     'pending',
      }).catch(() => {});
    }

    // Generate signup token and store in Redis (24h TTL) — short-lived
    // single-use tokens stay in Redis by design.
    const redis = getUpstashClient();
    if (!redis) return Response.json({ error: 'Storage unavailable' }, { status: 503 });

    const { token, hash, expiry } = generateSignupToken(email, firmName);
    const ttlSeconds = Math.floor((expiry - Date.now()) / 1000);
    await redis.set(`invite-token:${hash}`, email, { ex: ttlSeconds });

    // Send invite email with the set-password URL.
    const appUrl    = process.env.NEXT_PUBLIC_APP_URL ?? '';
    const signupUrl = `${appUrl}/auth/set-password?token=${encodeURIComponent(token)}`;

    try {
      await sendInviteEmail(email, firmName, signupUrl);
    } catch {
      console.error('[admin/requests] invite email failed', { email: '[redacted]' });
      // Don't fail the action — token is already in Redis
      return Response.json({ ok: true, warning: 'Invite email failed to send' });
    }

    await db.from('access_requests')
      .update({ status: 'approved', reviewed_at: new Date().toISOString() })
      .eq('kind', 'access')
      .eq('email', email)
      .eq('status', 'requested');

    return Response.json({ ok: true });
  }

  return Response.json({ error: 'Invalid action' }, { status: 400 });
}
