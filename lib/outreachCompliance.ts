// Cold outreach compliance guardrails.
//
// Three concerns:
//   1. Suppression list — opt-out tracking backed by Redis SADD/SISMEMBER.
//      Email is hashed with LOG_HASH_SECRET so no PII is stored in Redis keys.
//   2. Opt-out keyword detection — fast regex bypass before LLM classification.
//      Catches explicit "STOP / unsubscribe / do not contact" signals reliably.
//   3. Per-project daily outreach cap — limits daily email1 sends per project.
//      Configurable via OUTREACH_DAILY_LIMIT env var (default 20).
//
// No new env vars required — reuses LOG_HASH_SECRET and UPSTASH_REDIS_REST_*.

import { createHmac } from 'crypto';
import { getUpstashClient } from './upstashRedis';

const SUPPRESSION_SET_KEY = 'outreach:suppressions';
const DAILY_LIMIT_WINDOW  = 24 * 60 * 60 * 1000; // 24 h in ms
const DEFAULT_DAILY_CAP   = 20;

// ─── Email hashing (no PII in Redis) ─────────────────────────────────────────

function hashEmail(email: string): string {
  const secret = process.env.LOG_HASH_SECRET ?? 'dev-insecure-fallback';
  return createHmac('sha256', secret)
    .update(email.toLowerCase().trim())
    .digest('hex')
    .slice(0, 24);
}

// ─── Suppression list ─────────────────────────────────────────────────────────

export async function addToSuppressionList(email: string): Promise<void> {
  const redis = getUpstashClient();
  if (!redis) return; // dev: no Redis — silently skip
  await redis.sadd(SUPPRESSION_SET_KEY, hashEmail(email));
}

export async function isOnSuppressionList(email: string): Promise<boolean> {
  const redis = getUpstashClient();
  if (!redis) return false; // dev: assume not suppressed
  return redis.sismember(SUPPRESSION_SET_KEY, hashEmail(email));
}

// ─── Opt-out keyword detection (no LLM, fast) ────────────────────────────────
//
// Intentionally broad — false positives are fine here (err toward fewer emails).
// LLM classification in replyDetection.ts runs afterward for nuanced intent.

const OPT_OUT_PATTERNS: RegExp[] = [
  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /\bopt.?out\b/i,
  /\bdo not (?:contact|email|reach out)\b/i,
  /\bremove (?:me|my (?:email|address))\b/i,
  /\bplease remove\b/i,
  /\bnot interested\b/i,
  /\bno (?:thanks|thank you)\b/i,
];

export function containsOptOutSignal(text: string): boolean {
  return OPT_OUT_PATTERNS.some(p => p.test(text));
}

// ─── Per-project daily outreach cap ──────────────────────────────────────────
//
// Increments the counter and returns whether the send is allowed.
// Counter resets after 24 h. In dev (no Redis) always returns allowed.

export async function incrementAndCheckDailyLimit(
  projectId: string,
): Promise<{ allowed: boolean }> {
  const redis = getUpstashClient();
  if (!redis) return { allowed: true };

  const cap = parseInt(process.env.OUTREACH_DAILY_LIMIT ?? String(DEFAULT_DAILY_CAP), 10);
  const key = `outreach:daily:${projectId}`;
  const { count } = await redis.incrWithWindow(key, DAILY_LIMIT_WINDOW);
  return { allowed: count <= cap };
}
