// lib/attention.ts — what needs a human, in one list.
//
// Three sources, each a thing the product currently fails at quietly:
//
//   1. system_failure rows (public.system_events) — every catch block that used
//      to swallow: seat syncs, payouts, mail, sourcing, invoices. Written by
//      lib/engagementEvents.recordSystemFailure.
//
//   2. Sourcing runs stuck 'running' for more than STUCK_SOURCING_MINUTES. The
//      QStash job that would have finished them is gone; the client is still
//      looking at a "Sourcing experts…" pill that will never resolve.
//
//   3. organization_billing rows whose Stripe subscription is past_due or
//      unpaid. A firm whose card stopped working keeps using the product until
//      someone notices; this is the noticing.
//
// EVERY SOURCE IS INDEPENDENT AND FAILS SOFT. A missing table, an unreadable
// column or an unreachable database drops that one source and keeps the others
// — an attention list that 500s because one of its inputs is unavailable is
// exactly the wrong failure mode for a page whose job is to surface failures.
//
// Read-only. Service-role only (every table involved has RLS enabled with no
// authenticated policies), reached exclusively through GET /api/admin/attention
// behind adminGuard.
//
// NEVER returns: emails, names, Stripe ids, card details, or research content.
// Messages are assembled from enum labels, counts and ids that are already
// admin-visible.

import { getServiceRoleClient } from './supabase/admin';
import { getSystemEventsClient, SYSTEM_FAILURE_KIND } from './engagementEvents';

// ─── Types ────────────────────────────────────────────────────────────────────

export type AttentionKind = 'system_failure' | 'sourcing_stuck' | 'billing_past_due';

export interface AttentionItem {
  /** Stable within a response; prefixed by kind so ids from different sources never collide. */
  id:              string;
  kind:            AttentionKind;
  /** One plain-language line an admin can act on. No PII. */
  message:         string;
  /** ISO 8601. When the thing happened, or when it got stuck. */
  occurredAt:      string;
  organizationId?: string;
  projectId?:      string;
  expertId?:       string;
}

/** A sourcing run still 'running' after this long is not running. */
export const STUCK_SOURCING_MINUTES = 15;

/** Subscription states that mean Stripe is not collecting money. */
const UNHEALTHY_SUBSCRIPTION_STATUSES = ['past_due', 'unpaid'] as const;

const DEFAULT_LIMIT = 50;
const MAX_LIMIT     = 200;
/** Per-source scan cap, so one noisy source cannot crowd out the others. */
const SOURCE_SCAN_LIMIT = 200;

// ─── Copy ─────────────────────────────────────────────────────────────────────

const AREA_LABELS: Record<string, string> = {
  seat_sync: 'Seat billing did not sync to Stripe',
  payout:    'An expert payout did not go out',
  mail:      'An email was not delivered',
  sourcing:  'A sourcing run failed',
  invoice:   'An invoice could not be raised',
};

function areaLabel(area: string): string {
  return AREA_LABELS[area] ?? 'A background job failed';
}

/** Whole minutes between two instants, floored at 0. */
function minutesSince(from: number, now: number): number {
  return Math.max(0, Math.floor((now - from) / 60_000));
}

// ─── Source 1: recorded system failures ───────────────────────────────────────

async function systemFailureItems(limit: number): Promise<AttentionItem[]> {
  try {
    const db = getSystemEventsClient();
    if (!db) return [];

    const { data, error } = await db
      .from('system_events')
      .select('*')
      .eq('kind', SYSTEM_FAILURE_KIND)
      .order('created_at', { ascending: false })
      .limit(limit);

    // A missing table is the expected state before the migration is applied —
    // recordSystemFailure has already said so once. Stay quiet here.
    if (error || !data) return [];

    return data.map(row => ({
      id:         `system_failure:${row.id}`,
      kind:       'system_failure' as const,
      message:    `${areaLabel(row.area)} — ${row.reason}`,
      occurredAt: row.created_at,
      ...(row.organization_id ? { organizationId: row.organization_id } : {}),
      ...(row.project_id      ? { projectId:      row.project_id      } : {}),
      ...(row.expert_id       ? { expertId:       row.expert_id       } : {}),
    }));
  } catch {
    return [];
  }
}

// ─── Source 2: sourcing runs that never finished ──────────────────────────────

/**
 * sourcingStatus / sourcingStartedAt are unpromoted fields inside
 * `projects.brief` (see lib/projectStore.ts), so this filters on the jsonb key
 * rather than a column. A run with no recorded start is treated as stuck too —
 * it cannot be shown to have finished, and the pill is up either way.
 */
async function stuckSourcingItems(limit: number, now: number): Promise<AttentionItem[]> {
  try {
    const db = getServiceRoleClient();
    if (!db) return [];

    const { data, error } = await db
      .from('projects')
      .select('id, organization_id, brief, updated_at')
      .filter('brief->>sourcingStatus', 'eq', 'running')
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (error || !data) return [];

    const items: AttentionItem[] = [];

    for (const row of data) {
      const brief = row.brief as { sourcingStartedAt?: unknown } | null;
      const rawStart = brief?.sourcingStartedAt;
      const startedAt = typeof rawStart === 'number' && Number.isFinite(rawStart)
        ? rawStart
        : Date.parse(row.updated_at);
      if (!Number.isFinite(startedAt)) continue;

      const minutes = minutesSince(startedAt, now);
      if (minutes < STUCK_SOURCING_MINUTES) continue;

      items.push({
        id:         `sourcing_stuck:${row.id}`,
        kind:       'sourcing_stuck',
        message:    `Sourcing has been running for ${minutes} minutes on this project. `
                  + 'The client is still being shown a "Sourcing experts…" pill.',
        occurredAt: new Date(startedAt).toISOString(),
        projectId:  row.id,
        ...(row.organization_id ? { organizationId: row.organization_id } : {}),
      });
    }

    return items;
  } catch {
    return [];
  }
}

// ─── Source 3: firms Stripe is not collecting from ────────────────────────────

async function billingItems(limit: number): Promise<AttentionItem[]> {
  try {
    const db = getServiceRoleClient();
    if (!db) return [];

    const { data, error } = await db
      .from('organization_billing')
      .select('organization_id, subscription_status, seat_quantity_synced, updated_at')
      .in('subscription_status', [...UNHEALTHY_SUBSCRIPTION_STATUSES])
      .order('updated_at', { ascending: false })
      .limit(limit);

    if (error || !data) return [];

    return data.map(row => ({
      id:             `billing_past_due:${row.organization_id}`,
      kind:           'billing_past_due' as const,
      message:        row.subscription_status === 'unpaid'
        ? `This firm's seat subscription is unpaid — Stripe has stopped retrying. `
          + `${row.seat_quantity_synced} seat(s) are still in use.`
        : `This firm's seat subscription is past due — a payment failed and Stripe is retrying. `
          + `${row.seat_quantity_synced} seat(s) are still in use.`,
      occurredAt:     row.updated_at,
      organizationId: row.organization_id,
    }));
  } catch {
    return [];
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * The current attention list, newest first, capped at `limit`.
 *
 * The three sources are read in parallel and merged; any that fails contributes
 * nothing rather than failing the call. Never throws.
 */
export async function listAttentionItems(limit: number = DEFAULT_LIMIT): Promise<AttentionItem[]> {
  const capped = Math.min(Math.max(Math.trunc(limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);
  const now    = Date.now();

  const [failures, sourcing, billing] = await Promise.all([
    systemFailureItems(SOURCE_SCAN_LIMIT),
    stuckSourcingItems(SOURCE_SCAN_LIMIT, now),
    billingItems(SOURCE_SCAN_LIMIT),
  ]);

  return [...failures, ...sourcing, ...billing]
    .sort((a, b) => {
      const timeA = Date.parse(a.occurredAt);
      const timeB = Date.parse(b.occurredAt);
      if (Number.isNaN(timeA) || Number.isNaN(timeB)) return 0;
      return timeB - timeA;
    })
    .slice(0, capped);
}
