// Rate limiting for expensive AI endpoints.
// Builds on the same RateLimiterStore infrastructure used by enrich-contact.
// Two tiers: per-user hourly limit (blocks runaway single users) and a global
// daily budget (caps total API spend). Fails open on Redis errors so a Redis
// outage never takes down the AI features — auth remains the hard gate.
//
// Redis key names use HMAC pseudonymization — raw emails are never stored.

import { createHmac } from 'crypto';
import { createRateLimiterStore, type RateLimiterStore } from './rateLimiter';

let _store: RateLimiterStore | null = null;

function getStore(): RateLimiterStore {
  if (!_store) _store = createRateLimiterStore();
  return _store;
}

function aiRlKey(prefix: string, value: string): string {
  const secret = process.env.LOG_HASH_SECRET ?? 'dev-insecure-fallback';
  return `${prefix}:${createHmac('sha256', secret).update(value).digest('hex').slice(0, 16)}`;
}

const ONE_HOUR_MS   = 60 * 60 * 1000;
const TWENTY_FOUR_H = 24 * 60 * 60 * 1000;

export interface AiEndpointConfig {
  name: string;
  perUserHourlyLimit: number;
  globalDailyBudgetEnvVar: string;
  defaultGlobalDailyBudget: number;
}

export const AI_ENDPOINTS = {
  generateExperts: {
    name: 'generate-experts',
    perUserHourlyLimit: 10,
    globalDailyBudgetEnvVar: 'AI_GENERATE_EXPERTS_DAILY_BUDGET',
    defaultGlobalDailyBudget: 100,
  },
  generateOutreach: {
    name: 'generate-outreach',
    perUserHourlyLimit: 30,
    globalDailyBudgetEnvVar: 'AI_GENERATE_OUTREACH_DAILY_BUDGET',
    defaultGlobalDailyBudget: 500,
  },
  rankExperts: {
    name: 'rank-experts',
    perUserHourlyLimit: 20,
    globalDailyBudgetEnvVar: 'AI_RANK_EXPERTS_DAILY_BUDGET',
    defaultGlobalDailyBudget: 300,
  },
  screenExpert: {
    name: 'screen-expert',
    perUserHourlyLimit: 20,
    globalDailyBudgetEnvVar: 'AI_SCREEN_EXPERT_DAILY_BUDGET',
    defaultGlobalDailyBudget: 300,
  },
} as const;

export interface AiRateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
  reason?: 'per_user_hourly_limit' | 'global_daily_budget';
}

export async function checkAiRateLimit(
  endpoint: AiEndpointConfig,
  userKey: string,
): Promise<AiRateLimitResult> {
  try {
    const store = getStore();

    // Tier 1: per-user hourly limit
    const { count: userCount, ttlMs: userTtl } = await store.increment(
      aiRlKey(`ai:user:1h:${endpoint.name}`, userKey),
      ONE_HOUR_MS,
    );
    if (userCount > endpoint.perUserHourlyLimit) {
      return { allowed: false, retryAfterMs: userTtl, reason: 'per_user_hourly_limit' };
    }

    // Tier 2: global daily budget — configurable via env var
    const dailyBudget = parseInt(
      process.env[endpoint.globalDailyBudgetEnvVar] ?? String(endpoint.defaultGlobalDailyBudget),
      10,
    );
    const { count: globalCount, ttlMs: globalTtl } = await store.increment(
      `ai:global:24h:${endpoint.name}`,
      TWENTY_FOUR_H,
    );
    if (globalCount > dailyBudget) {
      return { allowed: false, retryAfterMs: globalTtl, reason: 'global_daily_budget' };
    }

    return { allowed: true };
  } catch {
    // Fail open — a Redis outage should not take down AI features.
    // Auth (routeAuthGuard) is the hard gate; rate limiting is cost control.
    console.warn(`[aiRateLimiter] rate limit check failed for endpoint: ${endpoint.name}`);
    return { allowed: true };
  }
}

export function aiRateLimitResponse(result: AiRateLimitResult): Response {
  const retryAfterSec = result.retryAfterMs ? Math.ceil(result.retryAfterMs / 1000) : 60;
  const isGlobal = result.reason === 'global_daily_budget';
  return Response.json(
    {
      error:              isGlobal ? 'service_temporarily_unavailable' : 'rate_limit_exceeded',
      message:            isGlobal
        ? 'This service is temporarily unavailable due to high demand. Please try again later.'
        : 'You have exceeded the request limit for this feature. Please wait before trying again.',
      retryAfterSeconds:  retryAfterSec,
    },
    {
      status:  429,
      headers: { 'Retry-After': String(retryAfterSec) },
    },
  );
}
