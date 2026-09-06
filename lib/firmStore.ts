// firmStore.ts — data layer for the multi-firm, multi-user account model.
//
// Source of truth: Supabase Postgres.
//   organizations        ← firms (domain unique)
//   profiles             ← users (1:1 with Supabase Auth; role = is_platform_admin)
//   organization_members ← firm membership + per-firm status
//   access_requests      ← access requests (kind='access') and seat requests (kind='seat')
//
// Supabase Auth owns credentials — there is no passwordHash here. Every
// mutation also syncs the auth user's app_metadata (role/status/firm/
// onboarding) so middleware and guards never need a DB read per request.
//
// Redis is used ONLY for the short-TTL seat-claim lock (concurrency guard).
//
// Never logs: email, firm name, domain, token, or PII.

import { getUpstashClient } from './upstashRedis';
import {
  getServiceRoleClient,
  ensureSupabaseUser,
  syncAppMetadata,
  deleteSupabaseUser,
} from './supabase/admin';
import type {
  OrganizationRow,
  ProfileRow,
  OrganizationMemberRow,
  FirmTypeValue,
  FirmSizeValue,
} from './supabase/database.types';
import { Resend } from 'resend';
import { getFromAddress } from './mailFrom';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type FirmPlan   = 'starter' | 'growth' | 'enterprise';
export type { FirmTypeValue, FirmSizeValue };
export type FirmStatus = 'active' | 'disabled';
export type UserStatus = 'active' | 'pending' | 'disabled';
export type OrgRole    = 'org_admin' | 'org_member';

/** organizations.seat_limit sentinel meaning "no cap" (int4 max, per migration 20260902). */
export const UNLIMITED_SEATS = 2_147_483_647;

export interface FirmRecord {
  id:        string;     // organizations.id (uuid) — the organization id used for billing
  domain:    string;     // lowercase
  name:      string;
  plan:      FirmPlan;
  status:    FirmStatus;
  createdAt: number;
  /**
   * OPTIONAL platform-admin cap on active seats; null = unlimited (the default).
   * Plans no longer imply a cap — organizations are billed per active seat.
   */
  seatLimit: number | null;
  /**
   * How Matchy describes this client to an expert without naming them: one
   * type word and one size word, e.g. "a mid-size PE firm". Captured on the
   * access request and applied at approval. Null falls back to
   * "an investment firm" (lib/matchyTemplates.firmPhrase).
   */
  firmType: FirmTypeValue | null;
  firmSize: FirmSizeValue | null;
}

export interface UserRecord {
  email:                 string;     // lowercase
  firmDomain:            string;     // lowercase; '' for platform admins with no firm
  firmName:              string;
  orgId?:                string;     // organizations.id (uuid)
  orgRole?:              OrgRole;    // membership role inside that organization
  role:                  'admin' | 'user';   // 'admin' = platform admin
  status:                UserStatus;
  createdAt:             number;
  onboardingComplete?:   boolean;   // false = must complete onboarding; absent/true = done
  firstName?:            string;
  lastName?:             string;
  title?:                string;
  // Billing (onboarding SetupIntent flow). Never logged.
  stripeCustomerId?:     string | null;  // Stripe customer (cus_...)
  billingComplete?:      boolean;        // a default payment method is saved
}

export interface SeatRequest {
  email:      string;
  firmDomain: string;
  reason:     'seat_limit_reached';
  status:     'pending' | 'approved' | 'rejected';
  createdAt:  number;
  /** Captured when the request was recorded so approval can provision directly. */
  name?:      string;
  firmName?:  string;
}

/** Fields accepted by upsertUser — all optional; only provided fields change. */
export interface UpsertUserInput {
  role?:               'admin' | 'user';
  status?:             UserStatus;
  firmDomain?:         string;
  firmName?:           string;
  /** Membership role. Defaults to org_admin for an organization's first member. */
  orgRole?:            OrgRole;
  firstName?:          string;
  lastName?:           string;
  title?:              string;
  onboardingComplete?: boolean;
  stripeCustomerId?:   string | null;
  billingComplete?:    boolean;
  createdAt?:          number;   // accepted for API compat; ignored (DB stamps it)
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

function normEmail(email: string): string {
  return email.toLowerCase().trim();
}

function normDomain(domain: string): string {
  return domain.toLowerCase().trim();
}

function toMs(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

function toFirmRecord(row: OrganizationRow): FirmRecord {
  const cap = typeof row.seat_limit === 'number' ? row.seat_limit : UNLIMITED_SEATS;
  return {
    id:        row.id,
    domain:    row.domain ?? '',
    name:      row.name,
    plan:      row.plan,
    status:    row.status,
    createdAt: toMs(row.created_at),
    seatLimit: cap >= UNLIMITED_SEATS || cap <= 0 ? null : cap,
    firmType:  row.firm_type ?? null,
    firmSize:  row.firm_size ?? null,
  };
}

interface MembershipContext {
  membership: OrganizationMemberRow | null;
  org:        OrganizationRow | null;
}

/** First membership (+ its org) for a profile. Most users have exactly one. */
async function getMembership(profileId: string): Promise<MembershipContext> {
  const db = getServiceRoleClient();
  if (!db) return { membership: null, org: null };

  const { data: membership } = await db
    .from('organization_members')
    .select('*')
    .eq('profile_id', profileId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!membership) return { membership: null, org: null };

  const { data: org } = await db
    .from('organizations')
    .select('*')
    .eq('id', membership.organization_id)
    .maybeSingle();
  return { membership, org: org ?? null };
}

function toUserRecord(
  profile: ProfileRow,
  membership: OrganizationMemberRow | null,
  org: OrganizationRow | null,
): UserRecord {
  return {
    email:              profile.email,
    firmDomain:         org?.domain ?? '',
    firmName:           org?.name ?? '',
    role:               profile.is_platform_admin ? 'admin' : 'user',
    status:             membership?.status ?? 'active',
    ...(org ? { orgId: org.id } : {}),
    ...(membership ? { orgRole: membership.role } : {}),
    createdAt:          toMs(profile.created_at),
    onboardingComplete: profile.onboarding_complete,
    stripeCustomerId:   profile.stripe_customer_id,
    billingComplete:    profile.billing_complete,
    ...(profile.first_name ? { firstName: profile.first_name } : {}),
    ...(profile.last_name  ? { lastName:  profile.last_name  } : {}),
    ...(profile.title      ? { title:     profile.title      } : {}),
  };
}

/**
 * Mirrors the user's authorization state onto app_metadata (best-effort).
 * Includes the organization claims (org_id / org_role) that orgAdminGuard reads,
 * so team management never needs a per-request DB round-trip.
 */
export async function syncUserMetadata(email: string): Promise<void> {
  const user = await getUser(email);
  if (!user) return;
  await syncAppMetadata(email, {
    role:                user.role,
    status:              user.status,
    firm_domain:         user.firmDomain,
    firm_name:           user.firmName,
    ...(user.orgId   ? { org_id:   user.orgId }   : {}),
    ...(user.orgRole ? { org_role: user.orgRole } : {}),
    ...(user.firstName ? { first_name: user.firstName } : {}),
    onboarding_complete: user.onboardingComplete ?? false,
    billing_complete:    user.billingComplete ?? false,
  });
}

/**
 * Recomputes the organization's billable seat quantity in Stripe. Best effort —
 * a membership change must never fail because billing is unreachable.
 */
async function syncSeatsBestEffort(organizationId: string | null | undefined): Promise<void> {
  if (!organizationId) return;
  try {
    const { syncOrgSeatQuantity } = await import('./orgBilling');
    await syncOrgSeatQuantity(organizationId);
  } catch {
    // Billing is not reachable (or not yet configured) — the next membership
    // change or the reconcile job catches up.
  }
}

// ─── Firm operations ───────────────────────────────────────────────────────────

export async function upsertFirm(
  domain: string,
  fields: Partial<Omit<FirmRecord, 'domain'>>,
): Promise<void> {
  const db = getServiceRoleClient();
  if (!db) return;
  const d = normDomain(domain);

  const { data: existing } = await db
    .from('organizations')
    .select('id')
    .eq('domain', d)
    .maybeSingle();

  // seat_limit is an OPTIONAL platform-admin cap: null means unlimited, stored
  // as the UNLIMITED_SEATS sentinel. Plans no longer imply a cap.
  const seatLimitPatch =
    fields.seatLimit === undefined
      ? {}
      : {
          seat_limit:
            fields.seatLimit === null || !Number.isFinite(fields.seatLimit) || fields.seatLimit <= 0
              ? UNLIMITED_SEATS
              : Math.min(Math.floor(fields.seatLimit), UNLIMITED_SEATS),
        };

  const patch = {
    ...(fields.name     !== undefined ? { name:      fields.name }            : {}),
    ...(fields.plan     !== undefined ? { plan:      fields.plan }            : {}),
    ...(fields.status   !== undefined ? { status:    fields.status }          : {}),
    // Matchy firm phrase. Passing null clears it back to the generic wording.
    ...(fields.firmType !== undefined ? { firm_type: fields.firmType ?? null } : {}),
    ...(fields.firmSize !== undefined ? { firm_size: fields.firmSize ?? null } : {}),
    ...seatLimitPatch,
  };

  if (existing) {
    if (Object.keys(patch).length > 0) {
      await db.from('organizations').update(patch).eq('id', existing.id);
    }
    return;
  }

  await db.from('organizations').insert({
    domain: d,
    name:   fields.name ?? d,
    ...patch,
  });
}

export async function getFirm(domain: string): Promise<FirmRecord | null> {
  const db = getServiceRoleClient();
  if (!db) return null;
  const { data } = await db
    .from('organizations')
    .select('*')
    .eq('domain', normDomain(domain))
    .maybeSingle();
  return data ? toFirmRecord(data) : null;
}

export async function deleteFirm(domain: string): Promise<void> {
  const db = getServiceRoleClient();
  if (!db) return;
  // Cascades to organization_members (and projects via FK) by schema design.
  await db.from('organizations').delete().eq('domain', normDomain(domain));
}

export async function listFirms(): Promise<FirmRecord[]> {
  const db = getServiceRoleClient();
  if (!db) return [];
  const { data } = await db
    .from('organizations')
    .select('*')
    .order('created_at', { ascending: true });
  return (data ?? []).map(toFirmRecord);
}

export async function isApprovedDomain(domain: string): Promise<boolean> {
  const db = getServiceRoleClient();
  if (!db) return false;
  const { data } = await db
    .from('organizations')
    .select('id')
    .eq('domain', normDomain(domain))
    .eq('status', 'active')
    .maybeSingle();
  return !!data;
}

// ─── User operations ───────────────────────────────────────────────────────────

export async function getUser(email: string): Promise<UserRecord | null> {
  const db = getServiceRoleClient();
  if (!db) return null;
  const { data: profile } = await db
    .from('profiles')
    .select('*')
    .eq('email', normEmail(email))
    .maybeSingle();
  if (!profile) return null;
  const { membership, org } = await getMembership(profile.id);
  return toUserRecord(profile, membership, org);
}

/**
 * Creates or updates a user. Ensures a Supabase auth account + profile exist,
 * applies profile fields, ensures firm membership when firmDomain is given,
 * and syncs app_metadata. Throws on hard failures so callers can 500.
 */
export async function upsertUser(email: string, fields: UpsertUserInput): Promise<void> {
  const db = getServiceRoleClient();
  if (!db) throw new Error('[firmStore] Supabase unavailable');
  const e = normEmail(email);

  // 1. Ensure auth account + profile row exist.
  const profileId = await ensureSupabaseUser(e, null);
  if (!profileId) throw new Error('[firmStore] failed to ensure auth user');

  // 2. Apply profile fields.
  const profilePatch = {
    ...(fields.firstName          !== undefined ? { first_name: fields.firstName } : {}),
    ...(fields.lastName           !== undefined ? { last_name:  fields.lastName  } : {}),
    ...(fields.title              !== undefined ? { title:      fields.title     } : {}),
    ...(fields.onboardingComplete !== undefined ? { onboarding_complete: fields.onboardingComplete } : {}),
    ...(fields.role               !== undefined ? { is_platform_admin: fields.role === 'admin' } : {}),
    // Service-role-only columns (see trg_prevent_profile_privileged_changes).
    ...(fields.stripeCustomerId   !== undefined ? { stripe_customer_id: fields.stripeCustomerId } : {}),
    ...(fields.billingComplete    !== undefined ? { billing_complete:   fields.billingComplete  } : {}),
  };
  if (Object.keys(profilePatch).length > 0) {
    const { error } = await db.from('profiles').update(profilePatch).eq('id', profileId);
    if (error) throw new Error('[firmStore] profile update failed');
  }

  // 3. Ensure firm membership.
  let touchedOrgId: string | null = null;
  let membershipChanged = false;

  if (fields.firmDomain) {
    const d = normDomain(fields.firmDomain);
    let { data: org } = await db.from('organizations').select('id').eq('domain', d).maybeSingle();
    if (!org) {
      await upsertFirm(d, { name: fields.firmName ?? d });
      ({ data: org } = await db.from('organizations').select('id').eq('domain', d).maybeSingle());
    }
    if (org) {
      touchedOrgId = org.id;

      const { data: member } = await db
        .from('organization_members')
        .select('id, role, status')
        .eq('organization_id', org.id)
        .eq('profile_id', profileId)
        .maybeSingle();

      if (member) {
        const statusChanged = fields.status  !== undefined && fields.status  !== member.status;
        const roleChanged   = fields.orgRole !== undefined && fields.orgRole !== member.role;
        if (statusChanged || roleChanged) {
          await db.from('organization_members').update({
            ...(statusChanged ? { status: fields.status }  : {}),
            ...(roleChanged   ? { role:   fields.orgRole } : {}),
          }).eq('id', member.id);
          membershipChanged = statusChanged;
        }
      } else {
        // The first member of an organization becomes its admin; everyone
        // afterwards joins as a member unless the caller says otherwise.
        let orgRole: OrgRole = fields.orgRole ?? 'org_member';
        if (fields.orgRole === undefined) {
          const { count } = await db
            .from('organization_members')
            .select('id', { count: 'exact', head: true })
            .eq('organization_id', org.id);
          if ((count ?? 0) === 0) orgRole = 'org_admin';
        }
        await db.from('organization_members').insert({
          organization_id: org.id,
          profile_id:      profileId,
          role:            orgRole,
          status:          fields.status ?? 'active',
        });
        membershipChanged = true;
      }
    }
  } else if (fields.status !== undefined || fields.orgRole !== undefined) {
    // Status / role change without a firm hint — apply to the existing membership.
    const { data: existing } = await db
      .from('organization_members')
      .select('id, organization_id, status')
      .eq('profile_id', profileId)
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle();

    if (existing) {
      touchedOrgId = existing.organization_id;
      await db
        .from('organization_members')
        .update({
          ...(fields.status  !== undefined ? { status: fields.status }  : {}),
          ...(fields.orgRole !== undefined ? { role:   fields.orgRole } : {}),
        })
        .eq('id', existing.id);
      membershipChanged = fields.status !== undefined && fields.status !== existing.status;
    }
  }

  // 4. Mirror onto app_metadata (best-effort).
  await syncUserMetadata(e).catch(() => {});

  // 5. A membership that became active / disabled changes the org's billable
  //    seat count. Best effort — billing never fails an account write.
  if (membershipChanged) await syncSeatsBestEffort(touchedOrgId);
}

export async function updateUserStatus(email: string, status: UserStatus): Promise<void> {
  await upsertUser(email, { status });
}

export async function listUsersForFirm(domain: string): Promise<UserRecord[]> {
  const db = getServiceRoleClient();
  if (!db) return [];
  const { data: org } = await db
    .from('organizations')
    .select('*')
    .eq('domain', normDomain(domain))
    .maybeSingle();
  if (!org) return [];

  const { data: members } = await db
    .from('organization_members')
    .select('*')
    .eq('organization_id', org.id);
  if (!members || members.length === 0) return [];

  const { data: profiles } = await db
    .from('profiles')
    .select('*')
    .in('id', members.map(m => m.profile_id));

  const byId = new Map((profiles ?? []).map(p => [p.id, p]));
  return members
    .map(m => {
      const p = byId.get(m.profile_id);
      return p ? toUserRecord(p, m, org) : null;
    })
    .filter((u): u is UserRecord => u !== null);
}

export async function countActiveUsersForFirm(domain: string): Promise<number> {
  const db = getServiceRoleClient();
  if (!db) return 0;
  const { data: org } = await db
    .from('organizations')
    .select('id')
    .eq('domain', normDomain(domain))
    .maybeSingle();
  if (!org) return 0;
  const { count } = await db
    .from('organization_members')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', org.id)
    .eq('status', 'active');
  return count ?? 0;
}

export async function listAllUsers(): Promise<UserRecord[]> {
  const db = getServiceRoleClient();
  if (!db) return [];
  const [{ data: profiles }, { data: members }, { data: orgs }] = await Promise.all([
    db.from('profiles').select('*'),
    db.from('organization_members').select('*'),
    db.from('organizations').select('*'),
  ]);
  const orgById     = new Map((orgs ?? []).map(o => [o.id, o]));
  const memberByPid = new Map((members ?? []).map(m => [m.profile_id, m]));
  return (profiles ?? []).map(p => {
    const m = memberByPid.get(p.id) ?? null;
    const o = m ? (orgById.get(m.organization_id) ?? null) : null;
    return toUserRecord(p, m, o);
  });
}

export async function deleteUser(email: string): Promise<void> {
  // Read the membership first — the cascade removes it with the auth user.
  const user = await getUser(email).catch(() => null);
  // Deleting the auth user cascades to profiles and organization_members.
  await deleteSupabaseUser(normEmail(email));
  // A removed active membership frees a billable seat.
  if (user?.status === 'active') await syncSeatsBestEffort(user.orgId);
}

// ─── Organization membership helpers ──────────────────────────────────────────

export interface OrgMembership {
  email:     string;
  orgId:     string;
  orgName:   string;
  orgDomain: string;
  orgRole:   OrgRole;
  role:      'admin' | 'user';
  status:    UserStatus;
}

/** The caller's organization membership, or null when they belong to none. */
export async function getUserOrgMembership(email: string): Promise<OrgMembership | null> {
  const user = await getUser(email);
  if (!user || !user.orgId) return null;
  return {
    email:     user.email,
    orgId:     user.orgId,
    orgName:   user.firmName,
    orgDomain: user.firmDomain,
    orgRole:   user.orgRole ?? 'org_member',
    role:      user.role,
    status:    user.status,
  };
}

/** Organization by id (uuid), or null. */
export async function getFirmById(organizationId: string): Promise<FirmRecord | null> {
  const db = getServiceRoleClient();
  if (!db) return null;
  const { data } = await db
    .from('organizations')
    .select('*')
    .eq('id', organizationId)
    .maybeSingle();
  return data ? toFirmRecord(data) : null;
}

/** Every member of an organization (by uuid), oldest membership first. */
export async function listOrgMembers(organizationId: string): Promise<UserRecord[]> {
  const db = getServiceRoleClient();
  if (!db) return [];

  const { data: org } = await db
    .from('organizations')
    .select('*')
    .eq('id', organizationId)
    .maybeSingle();
  if (!org) return [];

  const { data: members } = await db
    .from('organization_members')
    .select('*')
    .eq('organization_id', org.id)
    .order('created_at', { ascending: true });
  if (!members || members.length === 0) return [];

  const { data: profiles } = await db
    .from('profiles')
    .select('*')
    .in('id', members.map(m => m.profile_id));

  const byId = new Map((profiles ?? []).map(p => [p.id, p]));
  return members
    .map(m => {
      const profile = byId.get(m.profile_id);
      return profile ? toUserRecord(profile, m, org) : null;
    })
    .filter((u): u is UserRecord => u !== null);
}

/** Active seats in an organization (by uuid). */
export async function countActiveSeats(organizationId: string): Promise<number> {
  const db = getServiceRoleClient();
  if (!db) return 0;
  const { count } = await db
    .from('organization_members')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('status', 'active');
  return count ?? 0;
}

/** Org admins that are not disabled — guards against removing the last one. */
export async function countOrgAdmins(organizationId: string): Promise<number> {
  const db = getServiceRoleClient();
  if (!db) return 0;
  const { count } = await db
    .from('organization_members')
    .select('id', { count: 'exact', head: true })
    .eq('organization_id', organizationId)
    .eq('role', 'org_admin')
    .neq('status', 'disabled');
  return count ?? 0;
}

/** Promotes / demotes a member inside their organization. */
export async function updateOrgMemberRole(email: string, orgRole: OrgRole): Promise<void> {
  await upsertUser(email, { orgRole });
}

// ─── Seat claim lock (Redis — short-TTL concurrency guard only) ────────────────

export async function tryClaimSeat(domain: string, email: string, ttlSeconds = 5): Promise<'ok' | 'concurrent_signup'> {
  const redis = getUpstashClient();
  if (!redis) return 'ok'; // no lock available — proceed (best-effort guard)
  const key = `seat-claim:${normDomain(domain)}:${normEmail(email)}`;
  const result = await redis.set(key, '1', { ex: ttlSeconds, nx: true }).catch(() => 'OK' as const);
  return result === 'OK' ? 'ok' : 'concurrent_signup';
}

export async function releaseSeatClaim(domain: string, email: string): Promise<void> {
  const redis = getUpstashClient();
  if (!redis) return;
  await redis.del(`seat-claim:${normDomain(domain)}:${normEmail(email)}`).catch(() => {});
}

// ─── Seat requests (access_requests, kind='seat') ─────────────────────────────

export async function recordSeatRequest(
  email: string,
  firmDomain: string,
  details: { name?: string; firmName?: string } = {},
): Promise<void> {
  const db = getServiceRoleClient();
  if (!db) return;
  const e = normEmail(email);
  // One open seat request per email — skip if one is already pending.
  const { data: existing } = await db
    .from('access_requests')
    .select('id')
    .eq('kind', 'seat')
    .eq('email', e)
    .eq('status', 'requested')
    .maybeSingle();
  if (existing) return;
  await db.from('access_requests').insert({
    kind:             'seat',
    email:            e,
    requested_domain: normDomain(firmDomain),
    ...(details.name     ? { name:      details.name }     : {}),
    ...(details.firmName ? { firm_name: details.firmName } : {}),
  });
}

export async function listSeatRequests(): Promise<SeatRequest[]> {
  const db = getServiceRoleClient();
  if (!db) return [];
  const { data } = await db
    .from('access_requests')
    .select('*')
    .eq('kind', 'seat')
    .eq('status', 'requested')
    .order('created_at', { ascending: false });
  return (data ?? []).map(r => ({
    email:      r.email,
    firmDomain: r.requested_domain ?? '',
    reason:     'seat_limit_reached' as const,
    status:     'pending' as const,
    createdAt:  toMs(r.created_at),
    ...(r.name      ? { name:     r.name }      : {}),
    ...(r.firm_name ? { firmName: r.firm_name } : {}),
  }));
}

/** The pending seat request for an email, or null. */
export async function getSeatRequest(email: string): Promise<SeatRequest | null> {
  const db = getServiceRoleClient();
  if (!db) return null;
  const { data } = await db
    .from('access_requests')
    .select('*')
    .eq('kind', 'seat')
    .eq('email', normEmail(email))
    .eq('status', 'requested')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!data) return null;
  return {
    email:      data.email,
    firmDomain: data.requested_domain ?? '',
    reason:     'seat_limit_reached',
    status:     'pending',
    createdAt:  toMs(data.created_at),
    ...(data.name      ? { name:     data.name }      : {}),
    ...(data.firm_name ? { firmName: data.firm_name } : {}),
  };
}

export async function removeSeatRequest(email: string): Promise<void> {
  const db = getServiceRoleClient();
  if (!db) return;
  await db
    .from('access_requests')
    .delete()
    .eq('kind', 'seat')
    .eq('email', normEmail(email));
}

// ─── Seat limit notification (Resend) ─────────────────────────────────────────

let _adminResend: Resend | null = null;

function getAdminResend(): Resend | null {
  const key = process.env.RESEND_API_KEY;
  if (!key) return null;
  if (!_adminResend) _adminResend = new Resend(key);
  return _adminResend;
}

export interface SeatLimitNotificationParams {
  attemptedEmail:  string;
  firmName:        string;
  firmDomain:      string;
  activeSeatCount: number;
  seatLimit:       number;
}

// Silently no-ops if env vars are missing. Never throws.
export async function sendSeatLimitNotification(params: SeatLimitNotificationParams): Promise<void> {
  try {
    if (process.env.DISABLE_EMAILS === 'true') return;

    const adminEmail = process.env.ADMIN_NOTIFICATION_EMAIL;
    const from       = getFromAddress();
    if (!adminEmail) return;

    const resend = getAdminResend();
    if (!resend) return;

    await resend.emails.send({
      from,
      to:      adminEmail,
      subject: `[ExpertMatch] Seat limit reached — ${params.firmDomain}`,
      text: [
        'A user attempted to sign up but the firm seat limit was reached.',
        '',
        `Firm domain:       ${params.firmDomain}`,
        `Active seats:      ${params.activeSeatCount}`,
        `Seat limit:        ${params.seatLimit}`,
        '',
        'Please review the seat request in the admin panel.',
      ].join('\n'),
    });
  } catch {
    // Notification is best-effort — never throw
  }
}
