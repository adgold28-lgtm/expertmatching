import { getUpstashClient } from './upstashRedis';

const APPROVED_DOMAINS_KEY = 'approved-domains';

export type FirmPlan = 'starter' | 'growth' | 'enterprise';

export const SEAT_LIMITS: Record<FirmPlan, number> = {
  starter:    3,
  growth:     10,
  enterprise: Infinity,
};

// ─── Domain whitelist ─────────────────────────────────────────────────────────

export async function isApprovedDomain(domain: string): Promise<boolean> {
  const redis = getUpstashClient();
  if (!redis) return false;
  return redis.sismember(APPROVED_DOMAINS_KEY, domain.toLowerCase());
}

export async function approveDomain(domain: string): Promise<void> {
  const redis = getUpstashClient();
  if (!redis) return;
  await redis.sadd(APPROVED_DOMAINS_KEY, domain.toLowerCase());
}

export async function removeDomain(domain: string): Promise<void> {
  const redis = getUpstashClient();
  if (!redis) return;
  await redis.srem(APPROVED_DOMAINS_KEY, domain.toLowerCase());
}

export async function listApprovedDomains(): Promise<string[]> {
  const redis = getUpstashClient();
  if (!redis) return [];
  return redis.smembers(APPROVED_DOMAINS_KEY);
}

// ─── Seat tracking ────────────────────────────────────────────────────────────

// Counts users by reading SCARD of the domain-users:[domain] tracking set.
// Users are added to this set when their account is created.
export async function countUsersForDomain(domain: string): Promise<number> {
  const redis = getUpstashClient();
  if (!redis) return 0;
  return redis.scard(`domain-users:${domain.toLowerCase()}`);
}

export async function addUserToDomain(domain: string, email: string): Promise<void> {
  const redis = getUpstashClient();
  if (!redis) return;
  await redis.sadd(`domain-users:${domain.toLowerCase()}`, email.toLowerCase());
}

// ─── Firm plan ────────────────────────────────────────────────────────────────

export async function getFirmPlan(domain: string): Promise<FirmPlan> {
  const redis = getUpstashClient();
  if (!redis) return 'starter';
  const plan = await redis.get(`firm-plan:${domain.toLowerCase()}`);
  if (plan === 'growth' || plan === 'enterprise') return plan;
  return 'starter';
}

export async function setFirmPlan(domain: string, plan: FirmPlan): Promise<void> {
  const redis = getUpstashClient();
  if (!redis) return;
  await redis.set(`firm-plan:${domain.toLowerCase()}`, plan);
}
