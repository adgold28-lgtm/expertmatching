// lib/loginThrottle.ts — the throttle decision for POST /api/auth/login.
//
// WHO CALLS THIS: app/api/auth/login/route.ts, and nothing else. It lives in a
// module rather than in the route because a Next 14 route.ts may only export
// HTTP handlers and route segment config — exporting a helper from a route file
// fails the build — and because the decision has to be testable without an HTTP
// server (scripts/test-auth-guards.ts).
//
// WHAT IT ENFORCES (two counters, deliberately different shapes):
//
//   login-rl:<hmac(ip)>      every attempt,  10 per 15 minutes  → 429 rate_limited
//   login-fail:<hmac(email)> FAILURES only,  10 per 1 hour      → uniform 401
//
// The per-IP counter is the one that already existed. The per-account counter
// is the answer to credential stuffing spread across IP addresses (audit H-15):
// an attacker who rotates source addresses still spends the target account's
// hourly failure budget. It is incremented ONLY when a sign-in fails, so a
// person who logs in successfully every hour is never counted, and it is read
// (never incremented) on the way in, so checking cannot lock anyone out.
//
// Exceeding the per-account cap answers 401 invalid_credentials — the SAME body
// a wrong password gets. A 429 there would tell an attacker that the address
// exists and is under attack; the route's no-enumeration property (see its
// header) is worth more than the honest status code.
//
// REDIS POLICY — this module is the one auth-surface exception (audit H-14).
// Every other limiter in the repo fails open when Upstash is unavailable, which
// is right for recovery flows (a cache outage must not lock people out) and
// wrong for the credential-checking endpoint, where fail-open removes the only
// brute-force control exactly when the provider is degraded. So login degrades
// instead: `createLoginThrottleBackend()` returns a backend that falls back to
// an in-process Map on a null client or a thrown call.
//
// THE FALLBACK IS WEAK, AND KNOWINGLY SO. It is per serverless instance, so N
// concurrently warm instances multiply the effective cap by N, and it is lost
// on a cold start. It is not a distributed limiter and must not be described as
// one. It is strictly better than no cap at all, which is what was there
// before, and it keeps login available (a 503 would lock out every legitimate
// user for the length of an Upstash incident).
//
// Reset and request-access keep their fail-open policy; only login changed.

import { createHmac } from 'crypto';
import type { UpstashRedis } from './upstashRedis';

// ─── Policy ───────────────────────────────────────────────────────────────────

/** Attempts per window per IP, counted whether they succeed or fail. */
export const LOGIN_IP_LIMIT     = 10;
export const LOGIN_IP_WINDOW_MS = 15 * 60 * 1000;   // 15 minutes

/** Consecutive-ish failures per window per account. Successes are not counted. */
export const LOGIN_FAIL_LIMIT     = 10;
export const LOGIN_FAIL_WINDOW_MS = 60 * 60 * 1000; // 1 hour

// ─── Key helpers (no PII in Redis key names) ──────────────────────────────────
//
// DUPLICATION, ON PURPOSE: lib/rateLimiter.rlKey, lib/passwordReset.rlKey and
// app/api/request-access each carry their own copy of these four lines. This is
// the fourth. Wave 4 should extract one helper (see the repair plan's
// consolidation brief); doing it now would mean editing three modules this
// brief does not own. The truncation length differs between the existing copies
// (16 vs 24 hex chars); 16 is used here, matching lib/rateLimiter.
function hashForKey(value: string): string {
  const secret = process.env.LOG_HASH_SECRET ?? 'dev-insecure-fallback';
  return createHmac('sha256', secret).update(value).digest('hex').slice(0, 16);
}

/**
 * Per-IP attempt counter key. The IP is HMAC'd first: it used to be
 * interpolated raw (`login-rl:<ip>`), which put personal data into key names
 * that show up in the Upstash console and in any SCAN output (audit M-1).
 * Changing the shape invalidates in-flight counters exactly once, which is
 * harmless — everyone's window restarts at zero on the deploy.
 */
export function loginIpKey(ip: string): string {
  return `login-rl:${hashForKey(ip)}`;
}

/** Per-account failure counter key. Never contains the address itself. */
export function loginFailKey(email: string): string {
  return `login-fail:${hashForKey(email.trim().toLowerCase())}`;
}

// ─── Backend ──────────────────────────────────────────────────────────────────

/**
 * The two counter operations login needs. Implemented over Upstash in
 * production and over a process-local Map when Upstash is unreachable.
 */
export interface LoginThrottleBackend {
  /** INCR within a fixed window. */
  increment(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }>;
  /** Current count for a key, 0 when absent. Never increments. */
  read(key: string): Promise<number>;
  /** True once any call has had to use the in-process fallback. */
  readonly degraded: boolean;
}

/**
 * Per-instance limiter. Exported for the tests; the route never constructs one
 * directly. Windows are pruned lazily on access, so a burst of distinct keys is
 * bounded by the pruning that the next calls perform rather than growing
 * without limit for the life of the instance.
 */
export class InProcessLoginLimiter {
  private windows = new Map<string, { count: number; resetAt: number }>();

  /** Test seam: the clock. Production uses Date.now. */
  constructor(private readonly now: () => number = Date.now) {}

  increment(key: string, windowMs: number): { count: number; ttlMs: number } {
    const t    = this.now();
    this.prune(t);
    const slot = this.windows.get(key);
    if (!slot || t >= slot.resetAt) {
      this.windows.set(key, { count: 1, resetAt: t + windowMs });
      return { count: 1, ttlMs: windowMs };
    }
    slot.count += 1;
    return { count: slot.count, ttlMs: slot.resetAt - t };
  }

  read(key: string): number {
    const t    = this.now();
    const slot = this.windows.get(key);
    if (!slot || t >= slot.resetAt) return 0;
    return slot.count;
  }

  private prune(t: number): void {
    // Array.from rather than iterating the Map directly: the tsconfig target
    // predates for-of over a Map, and it also makes deleting while walking safe.
    for (const [k, slot] of Array.from(this.windows.entries())) {
      if (t >= slot.resetAt) this.windows.delete(k);
    }
  }

  /** Test helper — drops every window. */
  clear(): void {
    this.windows.clear();
  }
}

/**
 * Module-level fallback so every request served by this instance shares one set
 * of windows. A new Map per request would count nothing.
 */
const processLimiter = new InProcessLoginLimiter();

/**
 * A backend over Upstash that degrades to `fallback` on a null client or a
 * thrown call, rather than failing open the way the rest of the auth surface
 * does. `degraded` flips to true the first time the fallback is used, so the
 * route can decide what to say about it.
 */
export class DegradingLoginThrottleBackend implements LoginThrottleBackend {
  private usedFallback = false;

  constructor(
    private readonly redis: Pick<UpstashRedis, 'incrWithWindow' | 'get'> | null,
    private readonly fallback: InProcessLoginLimiter = processLimiter,
  ) {}

  get degraded(): boolean {
    return this.usedFallback;
  }

  async increment(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
    if (this.redis) {
      try {
        return await this.redis.incrWithWindow(key, windowMs);
      } catch {
        // fall through — Upstash is degraded, keep counting locally
      }
    }
    this.usedFallback = true;
    return this.fallback.increment(key, windowMs);
  }

  async read(key: string): Promise<number> {
    if (this.redis) {
      try {
        const raw = await this.redis.get(key);
        if (raw === null || raw === undefined) return 0;
        const n = parseInt(String(raw), 10);
        return Number.isFinite(n) && n > 0 ? n : 0;
      } catch {
        // fall through
      }
    }
    this.usedFallback = true;
    return this.fallback.read(key);
  }
}

/** The backend the route uses: Upstash when configured, in-process otherwise. */
export function createLoginThrottleBackend(
  redis: Pick<UpstashRedis, 'incrWithWindow' | 'get'> | null,
): LoginThrottleBackend {
  return new DegradingLoginThrottleBackend(redis);
}

// ─── Decision ─────────────────────────────────────────────────────────────────

export interface LoginThrottleCounts {
  /** Attempts recorded against this IP in the current window, this one included. */
  ipCount:          number;
  ipTtlMs:          number;
  /** Failures already recorded against this account. The current attempt is NOT in it. */
  accountFailCount: number;
}

export type LoginThrottleDecision =
  | { allowed: true }
  /** Too many attempts from this address — honest 429, no account was named. */
  | { allowed: false; reason: 'ip';      retryAfterMs: number }
  /** This account's failure budget is spent — answered as a plain 401. */
  | { allowed: false; reason: 'account' };

/**
 * Pure: given the two counters, may this attempt proceed to Supabase?
 *
 * The IP cap is checked first so that a flood from one address is rejected
 * before it can burn any account's budget — otherwise an attacker could lock a
 * victim out of their own account (a denial of service) simply by failing
 * against it, which is the standard objection to per-account lockouts. The
 * per-account counter caps the ATTACKER's rate; because the window is an hour
 * and successful logins never increment it, a legitimate user who knows their
 * password is unaffected even while their account is being sprayed.
 */
export function decideLoginThrottle(counts: LoginThrottleCounts): LoginThrottleDecision {
  if (counts.ipCount > LOGIN_IP_LIMIT) {
    return { allowed: false, reason: 'ip', retryAfterMs: counts.ipTtlMs };
  }
  if (counts.accountFailCount >= LOGIN_FAIL_LIMIT) {
    return { allowed: false, reason: 'account' };
  }
  return { allowed: true };
}

/**
 * Runs both counters and returns the decision. Increments the per-IP counter
 * (every attempt counts) and only READS the per-account counter.
 */
export async function checkLoginThrottle(
  backend: LoginThrottleBackend,
  ip: string,
  email: string,
): Promise<LoginThrottleDecision> {
  const [ipWindow, accountFailCount] = await Promise.all([
    backend.increment(loginIpKey(ip), LOGIN_IP_WINDOW_MS),
    backend.read(loginFailKey(email)),
  ]);
  return decideLoginThrottle({
    ipCount: ipWindow.count,
    ipTtlMs: ipWindow.ttlMs,
    accountFailCount,
  });
}

/**
 * Records one failed sign-in against the account. Called ONLY when Supabase
 * refused the credentials — not for a disabled account (the password was
 * correct there, so it is not an attack) and not for a malformed request.
 * Never throws: a counter that cannot be written must not turn a 401 into a 500.
 */
export async function recordLoginFailure(
  backend: LoginThrottleBackend,
  email: string,
): Promise<void> {
  try {
    await backend.increment(loginFailKey(email), LOGIN_FAIL_WINDOW_MS);
  } catch {
    /* the cap is best-effort on the write side; the read side already degrades */
  }
}
