import { createHmac } from 'crypto';
import { getUpstashClient, type UpstashRedis } from './upstashRedis';
import type { ActiveProviderName } from './contactProviders/types';

// Rate limiter abstraction for /api/enrich-contact.
//
// Three separate functions with intentionally different call sites:
//   checkRequestThrottle        — cheap per-IP check, BEFORE cache read (prevents spam)
//   checkCreditLimits           — per-IP/day + per-key/day, AFTER cache read
//                                 (never counts cache hits against budgets)
//   checkAndIncrementGlobalBudget — global daily budget, called BEFORE each provider API
//                                   call inside performLookup so each waterfall step
//                                   (Snov, Hunter) decrements the budget separately
//
// Production: Upstash Redis — durable, multi-instance.
// Development: in-memory Map — local-process only, resets on cold start.
// In production without UPSTASH_REDIS_REST_URL, createRateLimiterStore() throws —
// the route.ts fail-closed check prevents this from being reached.

export interface RateLimiterStore {
  increment(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }>;
}

// ─── In-memory (dev only) ─────────────────────────────────────────────────────

class InMemoryRateLimiterStore implements RateLimiterStore {
  private windows = new Map<string, { count: number; resetAt: number }>();

  async increment(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
    const now  = Date.now();
    const slot = this.windows.get(key);
    if (!slot || now >= slot.resetAt) {
      const resetAt = now + windowMs;
      this.windows.set(key, { count: 1, resetAt });
      return { count: 1, ttlMs: windowMs };
    }
    slot.count += 1;
    return { count: slot.count, ttlMs: slot.resetAt - now };
  }
}

// ─── Upstash Redis (production) ───────────────────────────────────────────────

class UpstashRateLimiterStore implements RateLimiterStore {
  constructor(private readonly redis: UpstashRedis) {}

  async increment(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
    return this.redis.incrWithWindow(key, windowMs);
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createRateLimiterStore(): RateLimiterStore {
  const redis = getUpstashClient();
  if (redis) return new UpstashRateLimiterStore(redis);

  if (process.env.NODE_ENV === 'production') {
    throw new Error('[rateLimiter] FATAL: production requires UPSTASH_REDIS_REST_URL');
  }

  console.warn('[rateLimiter] Using in-memory store — dev mode only, NOT production-safe.');
  return new InMemoryRateLimiterStore();
}

// ─── Key helpers (no PII in Redis key names) ──────────────────────────────────

function rlKey(prefix: string, value: string): string {
  const secret = process.env.LOG_HASH_SECRET ?? 'dev-insecure-fallback';
  return `${prefix}:${createHmac('sha256', secret).update(value).digest('hex').slice(0, 16)}`;
}

const TEN_MIN_MS    = 10 * 60 * 1000;
const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;

// ─── Tier 1: request throttle (BEFORE cache read) ─────────────────────────────
// Purpose: prevent request spam regardless of cache state.

export async function checkRequestThrottle(
  store: RateLimiterStore,
  ip: string,
): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  const { count, ttlMs } = await store.increment(rlKey('rl:ip:10m', ip), TEN_MIN_MS);
  if (count > 10) return { allowed: false, retryAfterMs: ttlMs };
  return { allowed: true };
}

// ─── Tier 2: per-IP and per-key credit limits (AFTER cache read) ──────────────
// Purpose: enforce per-user and per-target quotas.
// Global budget is intentionally NOT incremented here — that happens per provider
// call inside performLookup so each waterfall step counts separately.

export async function checkCreditLimits(
  store: RateLimiterStore,
  ip: string,
  cacheKey: string,
): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  // Per-IP daily: 25 lookups / 24 h
  const { count: c1, ttlMs: t1 } = await store.increment(rlKey('rl:ip:24h',  ip),       TWENTY_FOUR_H);
  if (c1 > 25) return { allowed: false, retryAfterMs: t1 };

  // Per normalized lookup key: 3 / 24 h (prevents re-querying the same person repeatedly).
  // Checked before global budget so rejected per-key requests don't consume global counter.
  const { count: c3, ttlMs: t3 } = await store.increment(rlKey('rl:key:24h', cacheKey), TWENTY_FOUR_H);
  if (c3 > 3) return { allowed: false, retryAfterMs: t3 };

  return { allowed: true };
}

// ─── Tier 3: global provider budget (called BEFORE each provider API call) ────
// Called once per provider inside performLookup so a Snov + Hunter waterfall
// consumes 2 credits from the budget, not 1.

export async function checkAndIncrementGlobalBudget(
  store: RateLimiterStore,
): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  const dailyBudget = parseInt(process.env.ENRICHMENT_DAILY_BUDGET ?? '500', 10);
  const { count, ttlMs } = await store.increment('rl:global:24h', TWENTY_FOUR_H);
  if (count > dailyBudget) return { allowed: false, retryAfterMs: ttlMs };
  return { allowed: true };
}

// ─── Informational: per-provider daily counter ────────────────────────────────
// No hard limit — used for monitoring how many credits each provider consumes.

export async function incrementProviderDailyCount(
  store: RateLimiterStore,
  provider: ActiveProviderName,
): Promise<void> {
  await store.increment(`rl:provider:${provider}:24h`, TWENTY_FOUR_H);
}
