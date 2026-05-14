// Search result cache for expert candidate queries.
//
// Production: Upstash Redis — durable, TTL-enforced.
// Development: no-op (returns null on get, silently skips on set).
//
// Cache key = HMAC-SHA256(normalized query string) — raw query text is NEVER
// stored in Redis key names.

import { createHmac } from 'crypto';
import { getUpstashClient } from './upstashRedis';
import type { SearchResult, SearchProviderName } from './searchProviders/types';

export interface CachedSearchPage {
  results:    SearchResult[];
  provider:   SearchProviderName;
  cached_at:  number; // Date.now()
  expires_at: number;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

// 32-char HMAC key — raw query text NEVER appears in Redis key names.
function cacheKeyHash(query: string): string {
  const secret = process.env.LOG_HASH_SECRET ?? 'dev-insecure-fallback';
  const normalized = query.toLowerCase().trim().replace(/\s+/g, ' ');
  return createHmac('sha256', secret).update(normalized).digest('hex').slice(0, 32);
}

export async function getCachedSearchPage(query: string): Promise<CachedSearchPage | null> {
  const redis = getUpstashClient();
  if (!redis) return null;

  const hash = cacheKeyHash(query);
  let raw: string | null;
  try { raw = await redis.get(`search:${hash}`); }
  catch { return null; }

  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw) as CachedSearchPage;
    if (Date.now() > parsed.expires_at) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function setCachedSearchPage(
  query:    string,
  results:  SearchResult[],
  provider: SearchProviderName,
): Promise<void> {
  const redis = getUpstashClient();
  if (!redis) return; // dev: skip cache silently

  const hash = cacheKeyHash(query);
  const now  = Date.now();
  const payload: CachedSearchPage = {
    results,
    provider,
    cached_at:  now,
    expires_at: now + SEVEN_DAYS_MS,
  };

  const ttlSec = Math.ceil(SEVEN_DAYS_MS / 1000);
  try {
    await redis.set(`search:${hash}`, JSON.stringify(payload), { ex: ttlSec });
  } catch (err) {
    console.error('[searchCache] set failed:', err instanceof Error ? err.message : String(err));
  }
}
