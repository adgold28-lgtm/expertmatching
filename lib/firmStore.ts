// firmStore.ts — data layer for the new multi-firm, multi-user auth model.
// All storage is in Upstash Redis via the custom HTTP client (no SDK).
//
// Redis key scheme:
//   firm:{domain}            → JSON FirmRecord
//   firms:index              → JSON string[] (all domains)
//   user:{email}             → JSON UserRecord (backward-compat with old format)
//   firm-users:{domain}      → Set<email> (all users, all statuses)
//   seat-request:{email}     → JSON SeatRequest
//   seat-requests:list       → JSON string[] (pending emails)
//
// Never logs: email, firm name, domain, token, or PII.

import { getUpstashClient } from './upstashRedis';
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
  passwordHash:          string;
  firmDomain:            string;     // lowercase
  firmName:              string;
  role:                  'admin' | 'user';
  status:                UserStatus;
  createdAt:             number;
  inviteTokenHash?:      string;    // SHA-256(token) — for revocation
  inviteTokenExpiresAt?: number;
  onboardingComplete?:   boolean;   // false = must complete onboarding; absent/true = done
  firstName?:            string;
  lastName?:             string;
  title?:                string;
}

export interface SeatRequest {
  email:      string;
  firmDomain: string;
  reason:     'seat_limit_reached';
  status:     'pending' | 'approved' | 'rejected';
  createdAt:  number;
}

// ─── Firm operations ───────────────────────────────────────────────────────────

export async function upsertFirm(
  domain: string,
  fields: Partial<Omit<FirmRecord, 'domain'>>,
): Promise<void> {
  const redis = getUpstashClient();
  if (!redis) return;

  const key = `firm:${domain.toLowerCase().trim()}`;

  // Read existing to merge
  const existing = await getFirm(domain);

  const record: FirmRecord = {
    domain:    domain.toLowerCase().trim(),
    name:      fields.name      ?? existing?.name      ?? '',
    plan:      fields.plan      ?? existing?.plan      ?? 'starter',
    status:    fields.status    ?? existing?.status    ?? 'active',
    createdAt: existing?.createdAt ?? Date.now(),
  };

  await redis.set(key, JSON.stringify(record));

  // Maintain firms:index
  const indexRaw = await redis.get('firms:index');
  const index: string[] = indexRaw ? JSON.parse(indexRaw) : [];
  if (!index.includes(record.domain)) {
    index.push(record.domain);
    await redis.set('firms:index', JSON.stringify(index));
  }
}

export async function getFirm(domain: string): Promise<FirmRecord | null> {
  const redis = getUpstashClient();
  if (!redis) return null;

  const raw = await redis.get(`firm:${domain.toLowerCase().trim()}`);
  if (!raw) return null;

  try {
    return JSON.parse(raw) as FirmRecord;
  } catch {
    return null;
  }
}

export async function deleteFirm(domain: string): Promise<void> {
  const redis = getUpstashClient();
  if (!redis) return;

  const normalized = domain.toLowerCase().trim();
  await redis.del(`firm:${normalized}`);

  // Remove from firms:index
  const indexRaw = await redis.get('firms:index');
  if (indexRaw) {
    try {
      const index: string[] = JSON.parse(indexRaw);
      const filtered = index.filter(d => d !== normalized);
      await redis.set('firms:index', JSON.stringify(filtered));
    } catch { /* best effort */ }
  }
}

export async function listFirms(): Promise<FirmRecord[]> {
  const redis = getUpstashClient();
  if (!redis) return [];

  const indexRaw = await redis.get('firms:index');
  if (!indexRaw) return [];

  let index: string[];
  try {
    index = JSON.parse(indexRaw);
  } catch {
    return [];
  }

  const records = await Promise.all(index.map(d => getFirm(d)));
  return records.filter((r): r is FirmRecord => r !== null);
}

// ─── Domain approval check ─────────────────────────────────────────────────────

// Returns true only if a FirmRecord exists for this exact domain AND status === 'active'.
// Always lowercase + trim — never substring match.
export async function isApprovedDomain(domain: string): Promise<boolean> {
  const firm = await getFirm(domain.toLowerCase().trim());
  if (!firm) return false;
  return firm.status === 'active';
}

// ─── User operations ───────────────────────────────────────────────────────────

// Backward compat: old records have { email, firmName, passwordHash, createdAt, domain }
// but no role, status, or firmDomain fields.
export async function getUser(email: string): Promise<UserRecord | null> {
  const redis = getUpstashClient();
  if (!redis) return null;

  const raw = await redis.get(`user:${email.toLowerCase().trim()}`);
  if (!raw) return null;

  try {
    const record = JSON.parse(raw) as Record<string, unknown>;

    // Apply backward-compat defaults
    const firmDomain =
      (typeof record.firmDomain === 'string' && record.firmDomain)
        ? record.firmDomain
        : (typeof record.domain === 'string' && record.domain)
          ? record.domain
          : '';

    const firmName =
      typeof record.firmName === 'string' ? record.firmName : '';

    return {
      email:                 (typeof record.email === 'string' ? record.email : email).toLowerCase().trim(),
      passwordHash:          typeof record.passwordHash === 'string' ? record.passwordHash : '',
      firmDomain:            firmDomain.toLowerCase(),
      firmName,
      role:                  (record.role === 'admin' || record.role === 'user') ? record.role : 'user',
      status:                (record.status === 'active' || record.status === 'pending' || record.status === 'disabled')
                               ? record.status
                               : 'active',
      createdAt:             typeof record.createdAt === 'number' ? record.createdAt : 0,
      inviteTokenHash:       typeof record.inviteTokenHash === 'string' ? record.inviteTokenHash : undefined,
      inviteTokenExpiresAt:  typeof record.inviteTokenExpiresAt === 'number' ? record.inviteTokenExpiresAt : undefined,
      onboardingComplete:    typeof record.onboardingComplete === 'boolean' ? record.onboardingComplete : undefined,
      firstName:             typeof record.firstName === 'string' ? record.firstName : undefined,
      lastName:              typeof record.lastName  === 'string' ? record.lastName  : undefined,
      title:                 typeof record.title     === 'string' ? record.title     : undefined,
    };
  } catch {
    return null;
  }
}

export async function upsertUser(
  email: string,
  fields: Partial<Omit<UserRecord, 'email'>>,
): Promise<void> {
  const redis = getUpstashClient();
  if (!redis) return;

  const normalizedEmail = email.toLowerCase().trim();
  const existing = await getUser(normalizedEmail);

  const record: UserRecord = {
    email:                normalizedEmail,
    passwordHash:         fields.passwordHash        ?? existing?.passwordHash        ?? '',
    firmDomain:           (fields.firmDomain         ?? existing?.firmDomain          ?? '').toLowerCase(),
    firmName:             fields.firmName             ?? existing?.firmName             ?? '',
    role:                 fields.role                 ?? existing?.role                 ?? 'user',
    status:               fields.status               ?? existing?.status               ?? 'active',
    createdAt:            fields.createdAt            ?? existing?.createdAt            ?? Date.now(),
    inviteTokenHash:      fields.inviteTokenHash      ?? existing?.inviteTokenHash,
    inviteTokenExpiresAt: fields.inviteTokenExpiresAt ?? existing?.inviteTokenExpiresAt,
    // onboardingComplete can be explicitly false — use !== undefined guard to preserve it
    onboardingComplete:   fields.onboardingComplete !== undefined ? fields.onboardingComplete : existing?.onboardingComplete,
    firstName:            fields.firstName  ?? existing?.firstName,
    lastName:             fields.lastName   ?? existing?.lastName,
    title:                fields.title      ?? existing?.title,
  };

  // Remove undefined optional fields
  if (record.inviteTokenHash      === undefined) delete record.inviteTokenHash;
  if (record.inviteTokenExpiresAt === undefined) delete record.inviteTokenExpiresAt;
  if (record.onboardingComplete   === undefined) delete record.onboardingComplete;
  if (record.firstName            === undefined) delete record.firstName;
  if (record.lastName             === undefined) delete record.lastName;
  if (record.title                === undefined) delete record.title;

  await redis.set(`user:${normalizedEmail}`, JSON.stringify(record));

  // Maintain firm-users:{domain} set
  if (record.firmDomain) {
    await redis.sadd(`firm-users:${record.firmDomain}`, normalizedEmail);
  }
}

export async function updateUserStatus(email: string, status: UserStatus): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();
  const user = await getUser(normalizedEmail);
  if (!user) return;
  await upsertUser(normalizedEmail, { status });
}

export async function listUsersForFirm(domain: string): Promise<UserRecord[]> {
  const redis = getUpstashClient();
  if (!redis) return [];

  const emails = await redis.smembers(`firm-users:${domain.toLowerCase().trim()}`);
  const users = await Promise.all(emails.map(e => getUser(e)));
  return users.filter((u): u is UserRecord => u !== null);
}

export async function countActiveUsersForFirm(domain: string): Promise<number> {
  const users = await listUsersForFirm(domain);
  return users.filter(u => u.status === 'active').length;
}

// ─── Concurrent seat claim protection ──────────────────────────────────────────

// Returns 'ok' on success, 'concurrent_signup' if another claim is in flight.
export async function tryClaimSeat(domain: string, email: string, ttlSeconds = 5): Promise<'ok' | 'concurrent_signup'> {
  const redis = getUpstashClient();
  if (!redis) return 'ok'; // if no Redis, let other checks catch it

  const key = `seat-claim:${domain.toLowerCase()}:${email.toLowerCase()}`;
  const result = await redis.set(key, '1', { ex: ttlSeconds, nx: true });
  return result === 'OK' ? 'ok' : 'concurrent_signup';
}

export async function releaseSeatClaim(domain: string, email: string): Promise<void> {
  const redis = getUpstashClient();
  if (!redis) return;
  await redis.del(`seat-claim:${domain.toLowerCase()}:${email.toLowerCase()}`);
}

// ─── Seat request operations ───────────────────────────────────────────────────

export async function recordSeatRequest(email: string, firmDomain: string): Promise<void> {
  const redis = getUpstashClient();
  if (!redis) return;

  const normalizedEmail = email.toLowerCase().trim();
  const record: SeatRequest = {
    email:      normalizedEmail,
    firmDomain: firmDomain.toLowerCase().trim(),
    reason:     'seat_limit_reached',
    status:     'pending',
    createdAt:  Date.now(),
  };

  await redis.set(`seat-request:${normalizedEmail}`, JSON.stringify(record));

  // Add to list if not already present
  const listRaw = await redis.get('seat-requests:list');
  const list: string[] = listRaw ? JSON.parse(listRaw) : [];
  if (!list.includes(normalizedEmail)) {
    list.push(normalizedEmail);
    await redis.set('seat-requests:list', JSON.stringify(list));
  }
}

export async function listSeatRequests(): Promise<SeatRequest[]> {
  const redis = getUpstashClient();
  if (!redis) return [];

  const listRaw = await redis.get('seat-requests:list');
  if (!listRaw) return [];

  let emails: string[];
  try {
    emails = JSON.parse(listRaw);
  } catch {
    return [];
  }

  const records = await Promise.all(
    emails.map(async (e) => {
      const raw = await redis.get(`seat-request:${e}`);
      if (!raw) return null;
      try { return JSON.parse(raw) as SeatRequest; } catch { return null; }
    }),
  );

  return records.filter((r): r is SeatRequest => r !== null);
}

export async function removeSeatRequest(email: string): Promise<void> {
  const redis = getUpstashClient();
  if (!redis) return;

  const normalizedEmail = email.toLowerCase().trim();
  await redis.del(`seat-request:${normalizedEmail}`);

  const listRaw = await redis.get('seat-requests:list');
  if (!listRaw) return;
  try {
    const list: string[] = JSON.parse(listRaw);
    const filtered = list.filter(e => e !== normalizedEmail);
    await redis.set('seat-requests:list', JSON.stringify(filtered));
  } catch { /* best effort */ }
}

// ─── Admin seat-limit notification ────────────────────────────────────────────

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
