import { createHmac, randomBytes } from 'crypto';
import type { ContactEnrichment, ContactStatus } from '../types';
import { getUpstashClient, type UpstashRedis } from './upstashRedis';

// Contact enrichment result cache with optional distributed locking.
//
// Production: Upstash Redis — durable, TTL-enforced, owner-safe locks.
//   Redis key names use a HMAC-SHA256 hash of the logical key — raw names/domains
//   are NEVER stored in Redis key names.
// Development: in-memory Map with TTL (local-process only).
//
// In production without UPSTASH_REDIS_REST_URL, createCacheStore() throws —
// the route.ts fail-closed check prevents this from being reached.

export interface CacheStore {
  get(key: string): Promise<ContactEnrichment | null>;
  set(key: string, value: ContactEnrichment, ttlMs: number): Promise<void>;
  // acquireLock returns a lockId if acquired, or null if the key is already locked.
  // releaseLock requires the same lockId — prevents a different owner from unlocking.
  acquireLock?(key: string, ttlMs: number): Promise<string | null>;
  releaseLock?(key: string, lockId: string): Promise<void>;
}

// ─── Pseudonymization helpers ────────────────────────────────────────────────

// 12-char HMAC truncation for audit log identifiers.
export function pseudonymize(value: string): string {
  const secret = process.env.LOG_HASH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[contactCache] FATAL: LOG_HASH_SECRET not set in production');
    }
    return createHmac('sha256', 'dev-insecure-fallback').update(value).digest('hex').slice(0, 12);
  }
  return createHmac('sha256', secret).update(value).digest('hex').slice(0, 12);
}

// 32-char HMAC for Redis storage keys — more entropy than the 12-char audit hash.
// Raw names/domains are NEVER used in Redis key names.
function storageKeyHash(value: string): string {
  const secret = process.env.LOG_HASH_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error('[contactCache] FATAL: LOG_HASH_SECRET not set in production');
    }
    return createHmac('sha256', 'dev-insecure-fallback').update(value).digest('hex').slice(0, 32);
  }
  return createHmac('sha256', secret).update(value).digest('hex').slice(0, 32);
}

// ─── In-memory implementation (dev only) ─────────────────────────────────────

class InMemoryCacheStore implements CacheStore {
  private data  = new Map<string, ContactEnrichment>();
  private locks = new Map<string, string>(); // key → lockId

  async get(key: string): Promise<ContactEnrichment | null> {
    const entry = this.data.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expires_at) { this.data.delete(key); return null; }
    return entry;
  }

  async set(key: string, value: ContactEnrichment, _ttlMs: number): Promise<void> {
    this.data.set(key, value);
  }

  async acquireLock(key: string, _ttlMs: number): Promise<string | null> {
    if (this.locks.has(key)) return null;
    const lockId = randomBytes(8).toString('hex');
    this.locks.set(key, lockId);
    return lockId;
  }

  async releaseLock(key: string, lockId: string): Promise<void> {
    if (this.locks.get(key) === lockId) this.locks.delete(key);
  }
}

// ─── Upstash Redis implementation (production) ───────────────────────────────

class UpstashCacheStore implements CacheStore {
  constructor(private readonly redis: UpstashRedis) {}

  async get(key: string): Promise<ContactEnrichment | null> {
    // Redis key name is a hash — never contains raw name/domain data
    const sk  = storageKeyHash(key);
    const raw = await this.redis.get(`cache:${sk}`);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as ContactEnrichment;
      // Defensive TTL check (Redis handles expiry, but belt-and-suspenders)
      if (Date.now() > parsed.expires_at) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async set(key: string, value: ContactEnrichment, ttlMs: number): Promise<void> {
    const sk     = storageKeyHash(key);
    const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
    await this.redis.set(`cache:${sk}`, JSON.stringify(value), { ex: ttlSec });
  }

  // SET lock:{hash} {requestId} EX {ttl} NX — atomic, expires automatically
  async acquireLock(key: string, ttlMs: number): Promise<string | null> {
    const sk     = storageKeyHash(key);
    const lockId = randomBytes(16).toString('hex');
    const ttlSec = Math.max(1, Math.ceil(ttlMs / 1000));
    const result = await this.redis.set(`lock:${sk}`, lockId, { ex: ttlSec, nx: true });
    return result === 'OK' ? lockId : null;
  }

  // Owner-safe release: Lua script only DEL if current value === lockId
  async releaseLock(key: string, lockId: string): Promise<void> {
    const sk = storageKeyHash(key);
    await this.redis.releaseLockIfOwner(`lock:${sk}`, lockId).catch(() => {});
  }
}

// ─── Factory ──────────────────────────────────────────────────────────────────

export function createCacheStore(): CacheStore {
  const redis = getUpstashClient();
  if (redis) return new UpstashCacheStore(redis);

  if (process.env.NODE_ENV === 'production') {
    throw new Error('[contactCache] FATAL: production requires UPSTASH_REDIS_REST_URL');
  }

  console.warn('[contactCache] Using in-memory store — dev mode only, NOT production-safe.');
  return new InMemoryCacheStore();
}

// ─── Utilities ────────────────────────────────────────────────────────────────

// Cache key includes the provider waterfall signature and cache version so that
// changing the waterfall (e.g. adding Hunter) or bumping CONTACT_CACHE_VERSION
// produces a fresh key — old not_found results cannot suppress a fuller waterfall.
// Raw names/domains are NEVER stored in Redis key names; this string is always
// passed through storageKeyHash() before use as a Redis key.
export function makeCacheKey(
  first:             string,
  last:              string,
  domain:            string,
  providerSignature: string,   // e.g. "snov+hunter"
  cacheVersion:      string,   // e.g. "v2"
): string {
  return [first, last, domain, providerSignature, cacheVersion]
    .map(s => s.toLowerCase().trim().replace(/\s+/g, ''))
    .join('|');
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function ttlForStatus(status: ContactStatus | 'not_found'): number {
  switch (status) {
    case 'verified':
    case 'catchall':  return 90 * DAY_MS;
    case 'risky':     return 30 * DAY_MS;
    case 'not_found':
    case 'invalid':
    default:          return 14 * DAY_MS;
  }
}
