// lib/membershipReconcile.ts — the nightly repair for revocations that did not
// reach the JWT.
//
// WHO CALLS THIS: app/api/jobs/reconcile/route.ts (the 06:00 UTC cron), as a
// fourth sweep alongside seats, payouts and sourcing. Nothing else. It lives in
// its own module rather than inside that route so that the two Wave-2 briefs
// touching the reconcile job do not edit the same file.
//
// WHY IT EXISTS. Every authorization decision in this product reads
// app_metadata off the JWT; the tables are never consulted per request. So
// disabling a member is only really done once lib/supabase/admin.syncAppMetadata
// has written status:'disabled' onto the auth user. That write is best-effort
// and reports failure as a return value, which app/api/org/members now surfaces
// as a warning — but a warning on a screen nobody is watching is not a repair.
// This sweep is the repair: it finds every membership row that says 'disabled'
// whose auth user does not, and re-runs the sync (audit H-16).
//
// DIRECTION IS DELIBERATE. It only ever repairs towards LESS access:
// row disabled + claims not disabled → re-sync. The opposite disagreement
// (claims disabled, row active) is left alone here — that direction is a
// lockout, not an escape, and firmStore.syncUserMetadata already fixes it on
// the next write to that account. Widening access from a cron job with no human
// in the loop is not a thing this job should be able to do.
//
// BOUNDS. At most MAX_ROWS rows per night, ordered oldest membership first so
// the same backlog is not re-scanned from a different place each night. A
// steady-state disabled population larger than that means rows past the bound
// are never checked; the count is returned so that shows up rather than hides.
//
// NEVER logs or returns: emails, names, organization names.

import { getServiceRoleClient } from './supabase/admin';
import { syncUserMetadata } from './firmStore';

/** Safety rail, matching the other sweeps in the reconcile job. */
export const MAX_ROWS = 500;

export interface MembershipSweepResult {
  /** Disabled memberships examined. */
  scanned:  number;
  /** Of those, how many had stale claims and were re-synced successfully. */
  repaired: number;
  /** Rows that could not be read or whose re-sync failed. */
  errors:   number;
}

/** One disabled membership, reduced to what the sweep needs. */
export interface DisabledMembership {
  profileId: string;
  email:     string;
}

/**
 * Injection points, all optional — production uses the real implementations
 * below. scripts/test-auth-guards.ts drives the sweep entirely through these,
 * so the logic is testable with no Supabase and no network.
 */
export interface MembershipReconcileDeps {
  /** Disabled memberships, oldest first, at most `limit`. */
  listDisabledMemberships?: (limit: number) => Promise<DisabledMembership[]>;
  /**
   * The auth user's app_metadata.status, or null when it is absent.
   * Throwing means "could not be read" and is counted as an error.
   */
  readAuthStatus?:          (profileId: string) => Promise<string | null>;
  /** Re-writes the claims. False means the write did not land. */
  resyncMetadata?:          (email: string) => Promise<boolean>;
  /** Row cap, for tests. Never above MAX_ROWS in production. */
  limit?:                   number;
}

/**
 * Pure: does this disabled membership need its claims repaired?
 *
 * A row whose auth user already says 'disabled' is correct and is left alone —
 * that is the overwhelmingly common case, so the sweep does almost no writes on
 * a healthy night. An ABSENT status counts as stale: no claim means no guard
 * refuses the account, which is exactly the failure being repaired.
 */
export function membershipClaimsAreStale(authStatus: string | null | undefined): boolean {
  return authStatus !== 'disabled';
}

// ─── Real implementations ─────────────────────────────────────────────────────

async function listDisabledMembershipsFromDb(limit: number): Promise<DisabledMembership[]> {
  const db = getServiceRoleClient();
  if (!db) return [];

  const { data: members, error } = await db
    .from('organization_members')
    .select('profile_id')
    .eq('status', 'disabled')
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw new Error(`disabled memberships unreadable: ${error.message.slice(0, 120)}`);
  if (!members || members.length === 0) return [];

  // One extra query rather than one per row: syncUserMetadata is keyed on the
  // address, and organization_members only carries the profile id.
  const ids = Array.from(new Set(members.map(m => m.profile_id)));
  const { data: profiles, error: profileError } = await db
    .from('profiles')
    .select('id, email')
    .in('id', ids);
  if (profileError) {
    throw new Error(`profiles unreadable: ${profileError.message.slice(0, 120)}`);
  }

  const emailById = new Map((profiles ?? []).map(p => [p.id, p.email]));
  const out: DisabledMembership[] = [];
  for (const id of ids) {
    const email = emailById.get(id);
    if (email) out.push({ profileId: id, email });
  }
  return out;
}

async function readAuthStatusFromSupabase(profileId: string): Promise<string | null> {
  const db = getServiceRoleClient();
  if (!db) throw new Error('supabase admin client unavailable');
  const { data, error } = await db.auth.admin.getUserById(profileId);
  if (error || !data?.user) throw new Error('auth user unreadable');
  const meta = (data.user.app_metadata ?? {}) as { status?: string };
  return typeof meta.status === 'string' ? meta.status : null;
}

// ─── The sweep ────────────────────────────────────────────────────────────────

/**
 * Re-syncs app_metadata for every disabled membership whose auth user still
 * claims something else. Never throws: each row is isolated, and a failure to
 * list rows at all returns zeroes with one error counted, so this sweep can
 * never take down the reconcile job's other steps.
 */
export async function sweepMembershipStatus(
  deps: MembershipReconcileDeps = {},
): Promise<MembershipSweepResult> {
  const list    = deps.listDisabledMemberships ?? listDisabledMembershipsFromDb;
  const read    = deps.readAuthStatus          ?? readAuthStatusFromSupabase;
  const resync  = deps.resyncMetadata          ?? syncUserMetadata;
  const limit   = Math.min(deps.limit ?? MAX_ROWS, MAX_ROWS);

  let rows: DisabledMembership[];
  try {
    rows = await list(limit);
  } catch {
    return { scanned: 0, repaired: 0, errors: 1 };
  }

  let repaired = 0;
  let errors   = 0;

  for (const row of rows) {
    try {
      const authStatus = await read(row.profileId);
      if (!membershipClaimsAreStale(authStatus)) continue;
      const ok = await resync(row.email);
      if (ok) repaired += 1;
      else errors += 1;
    } catch {
      // One unreadable or unwritable account must not stop the rest.
      errors += 1;
    }
  }

  return { scanned: rows.length, repaired, errors };
}
