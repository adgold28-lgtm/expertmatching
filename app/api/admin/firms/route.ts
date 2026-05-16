import { NextRequest } from 'next/server';
import { adminGuard } from '../../../../lib/auth';
import {
  listFirms,
  upsertFirm,
  deleteFirm,
  countActiveUsersForFirm,
  SEAT_LIMITS,
  type FirmPlan,
} from '../../../../lib/firmStore';
import { approveDomain, removeDomain } from '../../../../lib/domainWhitelist';

const VALID_PLANS = new Set<FirmPlan>(['starter', 'growth', 'enterprise']);

// GET — list all firms with seat usage
export async function GET(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  try {
    const firms = await listFirms();

    const enriched = await Promise.all(
      firms.map(async (firm) => {
        const seatUsed  = await countActiveUsersForFirm(firm.domain);
        const seatLimit = SEAT_LIMITS[firm.plan];
        return {
          ...firm,
          seatUsed,
          seatLimit: seatLimit === Infinity ? null : seatLimit,
        };
      }),
    );

    return Response.json({ firms: enriched });
  } catch {
    console.error('[admin/firms] failed to list firms');
    return Response.json({ error: 'Failed to load firms' }, { status: 500 });
  }
}

// POST { domain, name, plan } — create or update a firm
export async function POST(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const b      = body as Record<string, unknown>;
  const domain = typeof b.domain === 'string' ? b.domain.trim().toLowerCase() : '';
  const name   = typeof b.name   === 'string' ? b.name.trim()                 : '';
  const plan   = typeof b.plan   === 'string' ? b.plan                        : 'starter';

  if (!domain || domain.length < 3 || !domain.includes('.')) {
    return Response.json({ error: 'Valid domain required (e.g. blackstone.com)' }, { status: 400 });
  }
  if (!name) {
    return Response.json({ error: 'firm_name_required', message: 'Firm name is required.' }, { status: 400 });
  }
  if (!VALID_PLANS.has(plan as FirmPlan)) {
    return Response.json({ error: 'invalid_plan' }, { status: 400 });
  }

  try {
    await upsertFirm(domain, { name, plan: plan as FirmPlan, status: 'active' });
    // Backward compat: keep the old approved-domains set in sync
    await approveDomain(domain);
    console.log('[admin/firms] upserted', { plan });
    return Response.json({ ok: true });
  } catch {
    console.error('[admin/firms] failed to upsert firm', { domain: '[redacted]' });
    return Response.json({ error: 'Failed to save firm' }, { status: 500 });
  }
}

// DELETE { domain } — remove a firm
export async function DELETE(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const domain = typeof (body as Record<string, unknown>).domain === 'string'
    ? ((body as Record<string, unknown>).domain as string).trim().toLowerCase()
    : '';

  if (!domain) {
    return Response.json({ error: 'domain_required' }, { status: 400 });
  }

  try {
    await deleteFirm(domain);
    // Backward compat: remove from old approved-domains set too
    await removeDomain(domain);
    console.log('[admin/firms] deleted', { domain: '[redacted]' });
    return Response.json({ ok: true });
  } catch {
    console.error('[admin/firms] failed to delete firm', { domain: '[redacted]' });
    return Response.json({ error: 'Failed to delete firm' }, { status: 500 });
  }
}
