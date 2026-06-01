// Email suppression list — backed by Upstash Redis.
// Key: suppressed:{normalized-email} → JSON SuppressionEntry (no TTL — permanent).
// Falls back to no-op when Redis is unavailable (dev without env vars).

import { getUpstashClient } from './upstashRedis';

export interface SuppressionEntry {
  suppressedAt: number;  // unix ms
  reason: 'unsubscribe' | 'bounce' | 'complaint';
}

function normalize(email: string): string {
  return email.toLowerCase().trim();
}

export async function addToSuppressionList(
  email: string,
  reason: SuppressionEntry['reason'] = 'unsubscribe',
): Promise<void> {
  const key   = `suppressed:${normalize(email)}`;
  const entry: SuppressionEntry = { suppressedAt: Date.now(), reason };
  const redis = getUpstashClient();
  if (!redis) {
    console.warn('[suppressionList] Redis unavailable — suppression not persisted');
    return;
  }
  await redis.set(key, JSON.stringify(entry));
}

export async function isEmailSuppressed(email: string): Promise<boolean> {
  const key   = `suppressed:${normalize(email)}`;
  const redis = getUpstashClient();
  if (!redis) return false;
  const value = await redis.get(key);
  return value !== null;
}
