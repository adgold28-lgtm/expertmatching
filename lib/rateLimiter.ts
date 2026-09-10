import { createHmac } from 'crypto';
import { getUpstashClient, type UpstashRedis } from './upstashRedis';

// Rate limiter abstraction, originally written for /api/enrich-contact.
//
// THREE THINGS LIVE HERE, and only three:
//   createRateLimiterStore — the shared store for five public, token-gated
//     routes: /api/schedule/[token], /api/availability/[token]/google-auth,
//     /api/expert-onboarding/[token], /api/inbound-email and
//     /api/outreach/unsubscribe. Also the store passed to the budget check.
//   checkAndIncrementGlobalBudget — the global daily provider-spend cap, called
//     once per provider attempt in lib/contactDiscovery.ts (H-13) so a Snov +
//     Hunter waterfall consumes two credits from the budget, not one.
//   checkDraftLimits — the two windows on Matchy's composer draft (Matchy 2.0).
//
// Removed 2026-09-09 (W4-1): checkRequestThrottle, checkCreditLimits and
// incrementProviderDailyCount. They served /api/enrich-contact, which no longer
// exists, and had no callers. The per-request throttling they describe now
// lives in the routes' own createRateLimiterStore() use. `rlKey` survived them:
// the draft limiter keys on a user's email and a project id, and neither may
// sit in Redis in the clear.
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

// ─── Key helper (no PII in Redis key names) ───────────────────────────────────

function rlKey(prefix: string, value: string): string {
  const secret = process.env.LOG_HASH_SECRET ?? 'dev-insecure-fallback';
  return `${prefix}:${createHmac('sha256', secret).update(value).digest('hex').slice(0, 16)}`;
}

const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;

// ─── Global provider budget (called BEFORE each provider API call) ───────────
// Called once per provider attempt in lib/contactDiscovery.ts so a Snov +
// Hunter waterfall consumes 2 credits from the budget, not 1. The caller
// fails OPEN when Redis is unreachable — a spend cap must not stop discovery.

export async function checkAndIncrementGlobalBudget(
  store: RateLimiterStore,
): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  const dailyBudget = parseInt(process.env.ENRICHMENT_DAILY_BUDGET ?? '500', 10);
  const { count, ttlMs } = await store.increment('rl:global:24h', TWENTY_FOUR_H);
  if (count > dailyBudget) return { allowed: false, retryAfterMs: ttlMs };
  return { allowed: true };
}

// ─── Matchy composer: "write the reply for me" ────────────────────────────────
// One model call per draft, so the budget is the model bill. Two windows: a
// per-user burst limit (a client hammering the button) and a per-project daily
// ceiling (a runaway client or script). Keys are HMAC'd — no email, no project
// id in Redis. The caller wraps this in try/catch and FAILS OPEN: a store
// outage must not take the composer down (HANDOFF, Session 7 lesson).

const ONE_MIN_MS = 60 * 1000;

export const DRAFT_LIMIT_PER_USER_MINUTE  = 10;
export const DRAFT_LIMIT_PER_PROJECT_DAY  = 200;

export async function checkDraftLimits(
  store: RateLimiterStore,
  userEmail: string,
  projectId: string,
): Promise<{ allowed: boolean; retryAfterMs?: number }> {
  // Per user: 10 drafts / minute.
  const { count: c1, ttlMs: t1 } = await store.increment(
    rlKey('rl:draft:user:1m', userEmail.trim().toLowerCase()), ONE_MIN_MS);
  if (c1 > DRAFT_LIMIT_PER_USER_MINUTE) return { allowed: false, retryAfterMs: t1 };

  // Per project: 200 drafts / 24 h.
  const { count: c2, ttlMs: t2 } = await store.increment(
    rlKey('rl:draft:project:24h', projectId), TWENTY_FOUR_H);
  if (c2 > DRAFT_LIMIT_PER_PROJECT_DAY) return { allowed: false, retryAfterMs: t2 };

  return { allowed: true };
}
