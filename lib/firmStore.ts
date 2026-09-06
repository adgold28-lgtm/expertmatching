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
import type { OrganizationRow, ProfileRow, OrganizationMemberRow } from './supabase/database.types';
import { Resend } from 'resend';

// ─── Types ─────────────────────────────────────────────────────────────────────

export type FirmPlan   = 'starter' | 'growth' | 'enterprise';
export type FirmStatus = 'active' | 'disabled';
export type UserStatus = 'active' | 'pending' | 'disabled';

export interface FirmRecord {
  domain:    string;     // lowercase
  name:      string;
  plan:      FirmPlan;
  status:    FirmStatus;
  createdAt: number;
}

// Single source of truth for seat limits.
export const SEAT_LIMITS: Record<FirmPlan, number> = {
  starter:    3,
  growth:     10,
  enterprise: Infinity,
};

export interface UserRecord {
  email:                 string;     // lowercase
  firmDomain:            string;     // lowercase; '' for platform admins with no firm
  firmName:              string;
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
}

/** Fields accepted by upsertUser — all optional; only provided fields change. */
export interface UpsertUserInput {
  role?:               'admin' | 'user';
  status?:             UserStatus;
  firmDomain?:         string;
  firmName?:           string;
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
  return {
    domain:    row.domain ?? '',
    name:      row.name,
    plan:      row.plan,
    status:    row.status,
    createdAt: toMs(row.created_at),
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
    createdAt:          toMs(profile.created_at),
    onboardingComplete: profile.onboarding_complete,
    stripeCustomerId:   profile.stripe_customer_id,
    billingComplete:    profile.billing_complete,
    ...(profile.first_name ? { firstName: profile.first_name } : {}),
    ...(profile.last_name  ? { lastName:  profile.last_name  } : {}),
    ...(profile.title      ? { title:     profile.title      } : {}),
  };
}

/** Mirrors the user's authorization state onto app_metadata (best-effort). */
async function syncUserMetadata(email: string): Promise<void> {
  const user = await getUser(email);
  if (!user) return;
  await syncAppMetadata(email, {
    role:                user.role,
    status:              user.status,
    firm_domain:         user.firmDomain,
    firm_name:           user.firmName,
    ...(user.firstName ? { first_name: user.firstName } : {}),
    onboarding_complete: user.onboardingComplete ?? false,
    billing_complete:    user.billingComplete ?? false,
  });
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

  const patch = {
    ...(fields.name   !== undefined ? { name:   fields.name }   : {}),
    ...(fields.plan   !== undefined ? { plan:   fields.plan, seat_limit: fields.plan === 'enterprise' ? 2147483647 : SEAT_LIMITS[fields.plan] } : {}),
    ...(fields.status !== undefined ? { status: fields.status } : {}),
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
  if (fields.firmDomain) {
    const d = normDomain(fields.firmDomain);
    let { data: org } = await db.from('organizations').select('id').eq('domain', d).maybeSingle();
    if (!org) {
      await upsertFirm(d, { name: fields.firmName ?? d });
      ({ data: org } = await db.from('organizations').select('id').eq('domain', d).maybeSingle());
    }
    if (org) {
      const { data: member } = await db
        .from('organization_members')
        .select('id')
        .eq('organization_id', org.id)
        .eq('profile_id', profileId)
        .maybeSingle();
      if (member) {
        if (fields.status !== undefined) {
          await db.from('organization_members').update({ status: fields.status }).eq('id', member.id);
        }
      } else {
        await db.from('organization_members').insert({
          organization_id: org.id,
          profile_id:      profileId,
          status:          fields.status ?? 'active',
        });
      }
    }
  } else if (fields.status !== undefined) {
    // Status change without a firm hint — apply to the existing membership.
    await db
      .from('organization_members')
      .update({ status: fields.status })
      .eq('profile_id', profileId);
  }

  // 4. Mirror onto app_metadata (best-effort).
  await syncUserMetadata(e).catch(() => {});
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
  // Deleting the auth user cascades to profiles and organization_members.
  await deleteSupabaseUser(normEmail(email));
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

export async function recordSeatRequest(email: string, firmDomain: string): Promise<void> {
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
  }));
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
    const from       = process.env.OUTREACH_FROM_EMAIL;
    if (!adminEmail || !from) return;

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
