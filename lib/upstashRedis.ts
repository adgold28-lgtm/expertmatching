// Minimal Upstash Redis REST client — no external dependencies.
// Uses the Upstash Redis HTTP pipeline API for all operations.
//
// Redis is EPHEMERAL infrastructure here, never a source of truth: Supabase
// Postgres owns all durable data. Everything below is a counter, a cache entry
// or a short-lived lock, and every caller is expected to keep working when
// getUpstashClient() returns null or a call throws (Upstash is on a plan that
// gets rate-limited, which is exactly why single-use invite tokens were moved
// off Redis and onto Supabase recovery tokens — see lib/authLinks.ts).
//
// Key families written by the auth batch:
//   login-rl:<hmac(ip)>               login attempt throttle, 15-min window (lib/loginThrottle)
//   login-fail:<hmac(email)>          per-account login FAILURE cap, 1 h    (lib/loginThrottle)
//   invite-rl:<sha256(token)[0..16]>  set-password attempt cap, 1 h  (app/api/auth/set-password)
//   reset-rl:{ip|email}:<hmac>        password-reset request cap, 1 h (lib/passwordReset)
//   access-rl:{ip|email}:<hmac>       access-request cap, 1 h        (app/api/request-access)
//   seat-claim:<domain>:<email>       5-10 s NX lock against a double invite (lib/firmStore)
//   rl:*                              enrichment / token-route limiter keys (lib/rateLimiter)
//
// Every operation goes through pipeline(), which has a 5 s AbortController
// timeout and THROWS on transport errors, HTTP errors and per-command errors —
// including Upstash's account-level {"error": ...} shape. Callers decide the
// policy; every one of them fails open.
//
// STATUS: six commands — getAndDel and the set family (sadd, srem, smembers,
// sismember, scard) — were removed 2026-09-09 (W4-1): they served the Redis-era
// single-use token flow and had no callers. keys() and delMany() are used only by
// scripts/wipe-projects.ts. Add a command back only with its first caller.

interface PipelineEntry {
  result: unknown;
  error?: string;
}

export class UpstashRedis {
  private readonly url: string;
  private readonly token: string;

  constructor(url: string, token: string) {
    this.url = url.replace(/\/$/, '');
    this.token = token;
  }

  private get headers(): Record<string, string> {
    return {
      'Authorization': `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  async pipeline(commands: [string, ...unknown[]][], timeoutMs = 5_000): Promise<PipelineEntry[]> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.url}/pipeline`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify(commands),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`Upstash HTTP ${res.status}: ${text.slice(0, 200)}`);
      }
      const data = await res.json() as PipelineEntry[] | { error: string };
      // Account-level failures (e.g. Upstash rate limiting the whole database)
      // return {"error": "..."} instead of a result array.
      if (!Array.isArray(data)) {
        throw new Error(`Upstash unavailable: ${('error' in data ? data.error : 'unexpected response').slice(0, 120)}`);
      }
      for (const entry of data) {
        if (entry.error) throw new Error(`Upstash error: ${entry.error}`);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  // Atomically INCR + PEXPIRE on first increment (window doesn't reset on subsequent calls).
  // Returns { count, ttlMs }.
  async incrWithWindow(key: string, windowMs: number): Promise<{ count: number; ttlMs: number }> {
    const script =
      "local c = redis.call('INCR', KEYS[1]); " +
      "if c == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end; " +
      "return {c, redis.call('PTTL', KEYS[1])}";
    const results = await this.pipeline([['EVAL', script, '1', key, String(windowMs)]]);
    const result = results[0].result as [number, number];
    return { count: result[0], ttlMs: result[1] > 0 ? result[1] : windowMs };
  }

  async get(key: string): Promise<string | null> {
    const results = await this.pipeline([['GET', key]]);
    return (results[0].result as string | null) ?? null;
  }

  async set(key: string, value: string, options?: { ex?: number; nx?: boolean }): Promise<'OK' | null> {
    const cmd: [string, ...unknown[]] = ['SET', key, value];
    if (options?.ex != null) cmd.push('EX', options.ex);
    if (options?.nx) cmd.push('NX');
    const results = await this.pipeline([cmd]);
    return (results[0].result as 'OK' | null);
  }

  async del(key: string): Promise<number> {
    const results = await this.pipeline([['DEL', key]]);
    return (results[0].result as number) ?? 0;
  }

  // Owner-safe lock release: only DEL if current value === requestId.
  async releaseLockIfOwner(lockKey: string, requestId: string): Promise<boolean> {
    const script =
      "if redis.call('get', KEYS[1]) == ARGV[1] then " +
      "return redis.call('del', KEYS[1]) else return 0 end";
    const results = await this.pipeline([['EVAL', script, '1', lockKey, requestId]]);
    return (results[0].result as number) === 1;
  }

  async keys(pattern: string): Promise<string[]> {
    const results = await this.pipeline([['KEYS', pattern]]);
    return (results[0].result as string[]) ?? [];
  }

  async delMany(keys: string[]): Promise<number> {
    if (keys.length === 0) return 0;
    const results = await this.pipeline([['DEL', ...keys]]);
    return (results[0].result as number) ?? 0;
  }
}

let _client: UpstashRedis | null = null;

export function getUpstashClient(): UpstashRedis | null {
  const url   = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !token) return null;
  if (!_client) _client = new UpstashRedis(url, token);
  return _client;
}
