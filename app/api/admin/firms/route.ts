import { NextRequest } from 'next/server';
import { adminGuard } from '../../../../lib/auth';
import { seatUnitPriceCents, monthlySeatTotalCents } from '../../../../lib/pricing';
import { syncOrgSeatQuantity } from '../../../../lib/orgBilling';
import {
  listFirms,
  upsertFirm,
  deleteFirm,
  listUsersForFirm,
  getFirm,
  type FirmPlan,
} from '../../../../lib/firmStore';

const VALID_PLANS = new Set<FirmPlan>(['starter', 'growth', 'enterprise']);

// GET — every organization with its seat usage and monthly seat spend.
export async function GET(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  try {
    const firms = await listFirms();

    const enriched = await Promise.all(
      firms.map(async (firm) => {
        const members     = await listUsersForFirm(firm.domain);
        const seatUsed    = members.filter(m => m.status === 'active').length;
        const seatPending = members.filter(m => m.status === 'pending').length;
        return {
          ...firm,
          seatUsed,
          seatPending,
          seatLimit:             firm.seatLimit,   // null = unlimited
          seatUnitPriceCents:    seatUnitPriceCents(seatUsed),
          monthlySeatTotalCents: monthlySeatTotalCents(seatUsed),
        };
      }),
    );

    return Response.json({ firms: enriched });
  } catch {
    console.error('[admin/firms] failed to list organizations');
    return Response.json({ error: 'Failed to load organizations' }, { status: 500 });
  }
}

// POST { domain, name, plan?, seatLimit? } — create or update an organization.
// seatLimit is an OPTIONAL platform-admin cap: null clears it (unlimited).
// Omitting the key entirely leaves any existing cap unchanged.
export async function POST(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  let body: unknown;
  try { body = await request.json(); } catch {
    return Response.json({ error: 'invalid_json' }, { status: 400 });
  }

  const b      = (body ?? {}) as Record<string, unknown>;
  const domain = typeof b.domain === 'string' ? b.domain.trim().toLowerCase() : '';
  const name   = typeof b.name   === 'string' ? b.name.trim()                 : '';
  const plan   = typeof b.plan   === 'string' ? b.plan                        : 'starter';

  if (!domain || domain.length < 3 || !domain.includes('.')) {
    return Response.json(
      { error: 'invalid_domain', message: 'Valid domain required (e.g. blackstone.com)' },
      { status: 400 },
    );
  }
  if (!name) {
    return Response.json(
      { error: 'organization_name_required', message: 'Organization name is required.' },
      { status: 400 },
    );
  }
  if (!VALID_PLANS.has(plan as FirmPlan)) {
    return Response.json({ error: 'invalid_plan' }, { status: 400 });
  }

  // Distinguish "not provided" (leave as-is) from null / '' (clear the cap).
  let seatLimit: number | null | undefined;
  if ('seatLimit' in b) {
    const raw = b.seatLimit;
    if (raw === null || raw === '' || raw === undefined) {
      seatLimit = null;
    } else {
      const parsed = typeof raw === 'number' ? raw : Number(raw);
      if (!Number.isFinite(parsed) || parsed < 1) {
        return Response.json(
          {
            error:   'invalid_seat_limit',
            message: 'Seat cap must be a whole number of at least 1, or empty for unlimited.',
          },
          { status: 400 },
        );
      }
      seatLimit = Math.floor(parsed);
    }
  }

  try {
    await upsertFirm(domain, {
      name,
      plan:   plan as FirmPlan,
      status: 'active',
      ...(seatLimit !== undefined ? { seatLimit } : {}),
    });

    // Seat pricing follows the active-seat count, but a cap change is a good
    // moment to re-assert the billable quantity.
    const firm = await getFirm(domain).catch(() => null);
    if (firm) {
      try { await syncOrgSeatQuantity(firm.id); } catch { /* best effort */ }
    }

    return Response.json({ ok: true });
  } catch {
    console.error('[admin/firms] failed to upsert organization');
    return Response.json({ error: 'Failed to save organization' }, { status: 500 });
  }
}

// DELETE { domain } — remove an organization
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
    return Response.json({ ok: true });
  } catch {
    console.error('[admin/firms] failed to delete organization');
    return Response.json({ error: 'Failed to delete organization' }, { status: 500 });
  }
}
