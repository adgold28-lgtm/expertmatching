import { NextRequest } from 'next/server';
import { adminGuard } from '../../../../lib/auth';
import {
  listApprovedDomains,
  approveDomain,
  removeDomain,
  getFirmPlan,
  setFirmPlan,
  countUsersForDomain,
  SEAT_LIMITS,
  type FirmPlan,
} from '../../../../lib/domainWhitelist';

const VALID_PLANS = new Set<FirmPlan>(['starter', 'growth', 'enterprise']);

// Returns all approved domains with their plan and seat usage.
export async function GET(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  try {
    const domains = await listApprovedDomains();

    const enriched = await Promise.all(
      domains.map(async (domain) => {
        const [plan, used] = await Promise.all([
          getFirmPlan(domain),
          countUsersForDomain(domain),
        ]);
        const limit = SEAT_LIMITS[plan];
        return { domain, plan, seatLimit: limit === Infinity ? null : limit, seatUsed: used };
      }),
    );

    return Response.json({ domains: enriched });
  } catch {
    return Response.json({ error: 'Failed to load domains' }, { status: 500 });
  }
}

// Add a domain to the whitelist and/or update its plan.
// Body: { domain: string, plan?: FirmPlan }
export async function POST(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const b = body as Record<string, unknown>;
  const domain = typeof b.domain === 'string' ? b.domain.trim().toLowerCase() : '';
  if (!domain || domain.length < 3 || !domain.includes('.')) {
    return Response.json({ error: 'Valid domain required (e.g. blackstone.com)' }, { status: 400 });
  }

  await approveDomain(domain);

  if (typeof b.plan === 'string' && VALID_PLANS.has(b.plan as FirmPlan)) {
    await setFirmPlan(domain, b.plan as FirmPlan);
  }

  return Response.json({ ok: true });
}

// Remove a domain from the whitelist.
// Body: { domain: string }
export async function DELETE(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  const domain = typeof (body as Record<string, unknown>).domain === 'string'
    ? ((body as Record<string, unknown>).domain as string).trim().toLowerCase()
    : '';

  if (!domain) return Response.json({ error: 'domain required' }, { status: 400 });

  await removeDomain(domain);
  return Response.json({ ok: true });
}
