// Minimal Upstash Redis REST client — no external dependencies.
// Uses the Upstash Redis HTTP pipeline API for all operations.

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
      const data = await res.json() as PipelineEntry[];
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

  // Atomic GET + DEL: returns the value if the key existed, null otherwise.
  // Used for single-use token consumption.
  async getAndDel(key: string): Promise<string | null> {
    const script = "local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]) end; return v";
    const results = await this.pipeline([['EVAL', script, '1', key]]);
    return (results[0].result as string | null) ?? null;
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    const results = await this.pipeline([['SADD', key, ...members]]);
    return (results[0].result as number) ?? 0;
  }

  async srem(key: string, ...members: string[]): Promise<number> {
    const results = await this.pipeline([['SREM', key, ...members]]);
    return (results[0].result as number) ?? 0;
  }

  async smembers(key: string): Promise<string[]> {
    const results = await this.pipeline([['SMEMBERS', key]]);
    return (results[0].result as string[]) ?? [];
  }

  async sismember(key: string, member: string): Promise<boolean> {
    const results = await this.pipeline([['SISMEMBER', key, member]]);
    return (results[0].result as number) === 1;
  }

  async scard(key: string): Promise<number> {
    const results = await this.pipeline([['SCARD', key]]);
    return (results[0].result as number) ?? 0;
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
