// Redis-backed rate limiter. Used when `REDIS_URL` is set in env;
// falls back to the in-memory limiter otherwise. The redis path is
// preferred for multi-process deployments (k8s, compose scale-out)
// so the bucket survives process restarts and is shared across pods.
//
// Token bucket semantics: limit requests per windowMs, sliding counter
// (counter resets at window expiry). For finer control (leaky bucket
// / token bucket / per-IP fixed-window) extend this; the current
// fixed-window is sufficient for login abuse protection.
//
// We use the bare `redis` protocol (no extra dependency) via
// Bun's built-in `RedisClient` from `bun:redis`.

interface RedisLike {
  incr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<unknown>;
  ttl(key: string): Promise<number>;
  pttl(key: string): Promise<number>;
  del(key: string): Promise<unknown>;
  eval(script: string, keys: string[], args: (string | number)[]): Promise<unknown>;
}

interface Bucket {
  count: number;
  resetAt: number;
}

let redis: RedisLike | null = null;
let connectAttempted = false;

async function tryConnect(): Promise<RedisLike | null> {
  if (redis) return redis;
  if (connectAttempted) return null;
  connectAttempted = true;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    // Bun ships a native Redis client. Lazy-import so the dependency
    // is only loaded when REDIS_URL is set.
    const mod = (await import("bun:redis" as string).catch(
      () => null,
    )) as { RedisClient: new (u: string) => RedisLike } | null;
    if (!mod) return null;
    redis = new mod.RedisClient(url);
    return redis;
  } catch {
    return null;
  }
}

/**
 * Try Redis-backed counter. If Redis is unavailable, return null and
 * the caller falls back to the in-memory limiter.
 *
 * Atomic via Lua — the script does INCR + EXPIRE in a single round
 * trip so a second concurrent request can't sneak in between INCR and
 * EXPIRE on a fresh key.
 */
export async function redisTake(
  key: string,
  limit: number,
  windowMs: number,
): Promise<{ ok: boolean; count: number; resetMs: number } | null> {
  const r = await tryConnect();
  if (!r) return null;
  const windowSec = Math.ceil(windowMs / 1000);
  // KEYS[1] = bucket key, ARGV[1] = limit, ARGV[2] = window seconds.
  // Returns: { allowed (0/1), count, ttl_ms }
  const lua =
    "local n = redis.call('INCR', KEYS[1]) " +
    "if n == 1 then redis.call('EXPIRE', KEYS[1], ARGV[2]) end " +
    "local ttl = redis.call('PTTL', KEYS[1]) " +
    "return { n <= tonumber(ARGV[1]) and 1 or 0, n, ttl }";
  try {
    const out = (await r.eval(lua, [key], [String(limit), String(windowSec)])) as [
      number,
      number,
      number,
    ];
    return { ok: out[0] === 1, count: out[1], resetMs: out[2] };
  } catch {
    // Redis went away — fall back to null (caller uses in-memory).
    redis = null;
    return null;
  }
}
