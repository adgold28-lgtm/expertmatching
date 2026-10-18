// lib/keyHash.ts — the one HMAC behind every pseudonymous Redis key name.
//
// Rate-limit counters, caches and lookup tables are keyed by an email, an IP,
// a token or a search query. None of those may appear in a key name: key names
// show up in the Upstash console and in any SCAN output, so the value is
// HMAC'd with LOG_HASH_SECRET first and only a prefix of the digest is kept.
//
// This used to be eight hand-copied four-line functions (lib/rateLimiter.ts,
// lib/searchCache.ts, lib/passwordReset.ts, lib/conversationExport.ts,
// lib/stripeConnect.ts, lib/loginThrottle.ts, app/api/request-access,
// app/api/expert-onboarding), each with its own truncation length and each
// carrying a `?? 'dev-insecure-fallback'` default. The lengths are preserved
// per call site, so every existing key is unchanged by the consolidation.
//
// The fallback secret is DEV ONLY. lib/validateEnv.ts refuses to boot a
// production server without LOG_HASH_SECRET, and this module refuses to hash
// with the fallback in production as well, so a misconfigured deployment can
// never silently write dictionary-reversible pseudonyms.

import { createHmac } from 'crypto';

const DEV_FALLBACK_SECRET = 'dev-insecure-fallback';

function secret(): string {
  const configured = process.env.LOG_HASH_SECRET;
  if (configured) return configured;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('[keyHash] LOG_HASH_SECRET is not set — refusing to pseudonymize with the dev fallback in production');
  }
  return DEV_FALLBACK_SECRET;
}

/**
 * The first `hexChars` characters of HMAC-SHA256(LOG_HASH_SECRET, value), hex.
 * Pass the value exactly as the call site always has (trimmed, lower-cased,
 * or raw) — normalization is the caller's contract with its own keys.
 */
export function keyHash(value: string, hexChars: number): string {
  return createHmac('sha256', secret()).update(value).digest('hex').slice(0, hexChars);
}
