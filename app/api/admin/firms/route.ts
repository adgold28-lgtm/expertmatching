import { NextRequest } from 'next/server';
import { adminGuard } from '../../../../lib/auth';
import { seatUnitPriceCents, monthlySeatTotalCents } from '../../../../lib/pricing';
import { syncOrgSeatQuantity, getOrgBillingRow, cancelOrgSubscription } from '../../../../lib/orgBilling';
import {
  listFirms,
  upsertFirm,
  deleteFirm,
  listUsersForFirm,
  getFirm,
} from '../../../../lib/firmStore';

// What the admin page shows about an organization's auto-billing. Mirrors
// organization_billing (service-role only), never Stripe directly.
interface FirmBillingView {
  /** Card on file and a Stripe subscription created at onboarding. */
  complete:           boolean;
  /** Stripe subscription status mirror, or null before one exists. */
  subscriptionStatus: string | null;
  /** Seat quantity last pushed to Stripe, or null if never synced. */
  seatQuantitySynced: number | null;
  billingEmail:       string | null;
}

async function billingViewFor(organizationId: string): Promise<FirmBillingView> {
  const row = await getOrgBillingRow(organizationId);
  return {
    complete:           row?.billing_complete === true,
    subscriptionStatus: row?.subscription_status ?? null,
    seatQuantitySynced: row?.seat_quantity_synced ?? null,
    billingEmail:       row?.billing_email ?? null,
  };
}

// GET — every organization with its seat usage, monthly seat spend and
// auto-billing state.
export async function GET(request: NextRequest): Promise<Response> {
  const err = await adminGuard(request);
  if (err) return err;

  try {
    const firms = await listFirms();

    const enriched = await Promise.all(
      firms.map(async (firm) => {
        const [members, billing] = await Promise.all([
          listUsersForFirm(firm.domain),
          billingViewFor(firm.id),
        ]);
        const seatUsed    = members.filter(m => m.status === 'active').length;
        const seatPending = members.filter(m => m.status === 'pending').length;
        return {
          ...firm,
          seatUsed,
          seatPending,
          seatLimit:             firm.seatLimit,   // null = unlimited
          seatUnitPriceCents:    seatUnitPriceCents(seatUsed),
          monthlySeatTotalCents: monthlySeatTotalCents(seatUsed),
          billing,
        };
      }),
    );

    return Response.json({ firms: enriched });
  } catch {
    console.error('[admin/firms] failed to list organizations');
    return Response.json({ error: 'Failed to load organizations' }, { status: 500 });
  }
}

// POST { domain, name, seatLimit? } — create or update an organization.
// seatLimit is an OPTIONAL platform-admin cap: null clears it (unlimited).
// Omitting the key entirely leaves any existing cap unchanged.
//
// POST { domain, action: 'sync-seats' } — re-push this organization's active
// seat count to Stripe and report what happened. No `name` is required: this
// action never writes to the organization row. Returns
// { ok, outcome, activeSeats } where outcome is 'updated' | 'unchanged' |
// 'skipped' (no completed billing yet) | 'error'.
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
  const action = typeof b.action === 'string' ? b.action                      : '';

  // ── Seat sync ───────────────────────────────────────────────────────────────
  // Handled before the create/update validation because it needs neither a name
  // nor a seat cap.
  if (action === 'sync-seats') {
    if (!domain) {
      return Response.json({ error: 'domain_required' }, { status: 400 });
    }

    const firm = await getFirm(domain).catch(() => null);
    if (!firm) {
      return Response.json(
        { error: 'organization_not_found', message: 'No organization with that domain.' },
        { status: 404 },
      );
    }

    try {
      const result = await syncOrgSeatQuantity(firm.id);
      return Response.json({
        ok:          result.outcome !== 'error',
        outcome:     result.outcome,
        activeSeats: result.activeSeats,
      });
    } catch {
      console.error('[admin/firms] seat sync threw');
      return Response.json(
        {
          error:   'seat_sync_failed',
          message: 'Could not reach Stripe to sync seats. Try again in a moment.',
        },
        { status: 502 },
      );
    }
  }

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
    // Stop the money first. Deleting the organization row would orphan a live
    // Stripe subscription, so a refusal from Stripe blocks the delete outright
    // rather than leaving a firm that no longer exists paying for seats.
    // 'none' covers "never had a subscription" and the case where the billing
    // table is unreadable — the delete still proceeds.
    const firm = await getFirm(domain).catch(() => null);
    let subscription: 'canceled' | 'none' | 'error' = 'none';
    if (firm) {
      const result = await cancelOrgSubscription(firm.id);
      subscription = result.outcome;
      if (subscription === 'error') {
        return Response.json(
          {
            error:   'subscription_cancel_failed',
            message: 'Could not cancel the Stripe subscription; the organization was not removed. Try again or cancel it in Stripe first.',
          },
          { status: 409 },
        );
      }
    }

    await deleteFirm(domain);
    return Response.json({ ok: true, subscription });
  } catch {
    console.error('[admin/firms] failed to delete organization');
    return Response.json({ error: 'Failed to delete organization' }, { status: 500 });
  }
}
