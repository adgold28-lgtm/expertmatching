// Per-user and per-firm daily usage caps for expensive AI operations.
//
// Piggybacks on the existing RateLimiterStore abstraction:
//   Production: Upstash Redis — durable, multi-instance.
//   Development: in-memory Map (via createRateLimiterStore fallback).
//
// Fail-open: if the store cannot be created (e.g. Redis missing in prod),
// all cap checks pass through rather than blocking user requests.
//
// Admin users (firmDomain === '*') are never capped.
//
// Configurable via env vars:
//   CAP_USER_GENERATE_EXPERTS  (default 10/day)
//   CAP_USER_GENERATE_OUTREACH (default 50/day)
//   CAP_USER_RANK_EXPERTS      (default 25/day)
//   CAP_USER_SCREEN_EXPERT     (default 25/day)
//   CAP_FIRM_GENERATE_EXPERTS  (default 30/day)
//   CAP_FIRM_GENERATE_OUTREACH (default 150/day)
//   CAP_FIRM_RANK_EXPERTS      (default 75/day)
//   CAP_FIRM_SCREEN_EXPERT     (default 75/day)

import { createHmac } from 'crypto';
import { createRateLimiterStore, type RateLimiterStore } from './rateLimiter';

export type CapOperation =
  | 'generate_experts'
  | 'generate_outreach'
  | 'rank_experts'
  | 'screen_expert';

const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;

const USER_CAP_DEFAULTS: Record<CapOperation, number> = {
  generate_experts:  10,
  generate_outreach: 50,
  rank_experts:      25,
  screen_expert:     25,
};

const FIRM_CAP_DEFAULTS: Record<CapOperation, number> = {
  generate_experts:  30,
  generate_outreach: 150,
  rank_experts:      75,
  screen_expert:     75,
};

function userCap(op: CapOperation): number {
  const envKey = `CAP_USER_${op.toUpperCase()}`;
  const val    = parseInt(process.env[envKey] ?? '', 10);
  return Number.isFinite(val) && val > 0 ? val : USER_CAP_DEFAULTS[op];
}

function firmCap(op: CapOperation): number {
  const envKey = `CAP_FIRM_${op.toUpperCase()}`;
  const val    = parseInt(process.env[envKey] ?? '', 10);
  return Number.isFinite(val) && val > 0 ? val : FIRM_CAP_DEFAULTS[op];
}

// No PII in Redis key names — follows the same hashing pattern as rateLimiter.ts.
function capKey(prefix: string, value: string): string {
  const secret = process.env.LOG_HASH_SECRET ?? 'dev-insecure-fallback';
  return `${prefix}:${createHmac('sha256', secret).update(value).digest('hex').slice(0, 16)}`;
}

export interface CapResult {
  allowed:      boolean;
  operation:    CapOperation;
  retryAfterMs?: number;
  limitedBy?:   'user' | 'firm';
}

// Check and increment usage cap for an operation.
// Admins (firmDomain === '*') and a null store always pass through.
export async function checkUsageCap(
  store: RateLimiterStore | null,
  operation: CapOperation,
  userEmail: string,
  firmDomain: string,
): Promise<CapResult> {
  if (!store || firmDomain === '*') return { allowed: true, operation };

  const { count: userCount, ttlMs: userTtl } = await store.increment(
    capKey(`cap:user:${operation}:24h`, userEmail),
    TWENTY_FOUR_H,
  );
  if (userCount > userCap(operation)) {
    return { allowed: false, operation, retryAfterMs: userTtl, limitedBy: 'user' };
  }

  const { count: firmCount, ttlMs: firmTtl } = await store.increment(
    capKey(`cap:firm:${operation}:24h`, firmDomain),
    TWENTY_FOUR_H,
  );
  if (firmCount > firmCap(operation)) {
    return { allowed: false, operation, retryAfterMs: firmTtl, limitedBy: 'firm' };
  }

  return { allowed: true, operation };
}

let _capStore: RateLimiterStore | null | undefined = undefined;

// Returns the singleton cap store, or null if unavailable (fail-open).
export function getUsageCapStore(): RateLimiterStore | null {
  if (_capStore !== undefined) return _capStore;
  try {
    _capStore = createRateLimiterStore();
  } catch (err) {
    console.warn(
      '[usageCaps] store unavailable — caps disabled:',
      err instanceof Error ? err.message.slice(0, 80) : String(err).slice(0, 80),
    );
    _capStore = null;
  }
  return _capStore;
}
