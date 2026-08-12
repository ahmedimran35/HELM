// Per-IP + per-user rate limiter (Phase 8 hardening, docs §8).
// Uses an in-memory bucket map by default; switches to Redis-backed
// (REDIS_URL env) for multi-process deployments. The defaults are
// intentionally generous so they don't get in the way of normal
// testing — production should tighten them.

import type { MiddlewareHandler } from "hono";
import { redisTake } from "./redis-limiter.ts";

interface Bucket {
  count: number;
  resetAt: number;
}

const buckets = new Map<string, Bucket>();

function take(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  const b = buckets.get(key);
  if (!b || b.resetAt < now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  b.count++;
  return b.count <= limit;
}

/** Extract a client identifier for rate-limit bucketing.
 *  Order of preference (most-trusted first):
 *    1. `HELM_TRUSTED_PROXY=1` + XFF right-most hop (proxy chain).
 *    2. `cf-connecting-ip` (Cloudflare edge — trusted since the edge
 *       controls the connection and rewrites the header itself).
 *    3. `x-real-ip` (single trusted reverse proxy — nginx, caddy, etc).
 *    4. Cloudflare Workers / Pages platform exposes the peer here.
 *    5. `"unknown"` — last-ditch shared bucket (all anonymous traffic).
 *
 *  If `HELM_TRUSTED_PROXY=1` is set we trust ONLY XFF; this prevents an
 *  attacker from sending cf-connecting-ip or x-real-ip to bypass the
 *  proxy-set XFF chain.
 */
function clientId(c: { req: { header(k: string): string | undefined; raw?: unknown } }): string {
  const trustProxy = process.env.HELM_TRUSTED_PROXY === "1";
  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
      if (hops.length > 0) return hops[hops.length - 1]!;
    }
    return "unknown";
  }
  // Cloudflare sets cf-connecting-ip at the edge and TLS-terminates
  // before the request hits our process. Safe to trust without
  // `HELM_TRUSTED_PROXY` because we only see the value Cloudflare writes.
  const cf = c.req.header("cf-connecting-ip");
  if (cf) return cf.trim();
  // Single trusted reverse proxy convention (nginx, caddy, traefik).
  const xri = c.req.header("x-real-ip");
  if (xri) return xri.trim();
  // Cloudflare Workers / Pages platform exposes the peer at
  // `Request.cf` (typed as `IncomingRequestCfProperties`). We look
  // it up without TS help (Bun/Hono don't expose the CF namespace
  // on `c.req.raw` here).
  const raw = c.req.raw as { cf?: { clientIp?: string } } | undefined;
  const cf2 = raw?.cf?.clientIp;
  if (cf2) return cf2;
  return "unknown";
}

export function rateLimit(opts: {
  limit: number;
  windowMs: number;
  scope: "ip" | "user";
}): MiddlewareHandler {
  return async (c, next) => {
    let key: string;
    if (opts.scope === "user") {
      const user = c.get("user");
      if (!user) return next();
      key = `u:${user.id}`;
    } else {
      key = `i:${clientId(c)}`;
    }
    // Try Redis first (multi-process); fall back to in-memory if Redis
    // is unavailable or refuses the connection.
    const redisResult = await redisTake(key, opts.limit, opts.windowMs);
    if (redisResult) {
      if (!redisResult.ok) {
        c.header("Retry-After", String(Math.ceil(redisResult.resetMs / 1000)));
        return c.json({ error: "rate_limited" }, 429);
      }
      return next();
    }
    if (!take(key, opts.limit, opts.windowMs)) {
      c.header("Retry-After", String(Math.ceil(opts.windowMs / 1000)));
      return c.json({ error: "rate_limited" }, 429);
    }
    return next();
  };
}

/**
 * Keyed-by-username rate limit. Use on /api/login to complement the
 * per-IP bucket — a botnet of 1000 IPs (each within its 30/min bucket)
 * can otherwise hit one username at 30 000 attempts/minute.
 *
 * Pass a function that pulls the bucket key from the request — we
 * can't read the user object (no auth yet). For login we use the
 * normalised `username` from the JSON body.
 */
export function rateLimitByBody(opts: {
  limit: number;
  windowMs: number;
  bodyKey: "username" | "panel_id";
  prefix: string;
}): MiddlewareHandler {
  return async (c, next) => {
    let key: string;
    try {
      const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
      const v = typeof body[opts.bodyKey] === "string"
        ? (body[opts.bodyKey] as string).trim().toLowerCase()
        : "";
      if (!v) return next();
      key = `${opts.prefix}:${v}`;
    } catch {
      return next();
    }
    // Try Redis first.
    const redisResult = await redisTake(key, opts.limit, opts.windowMs);
    if (redisResult) {
      if (!redisResult.ok) {
        c.header("Retry-After", String(Math.ceil(redisResult.resetMs / 1000)));
        return c.json({ error: "rate_limited" }, 429);
      }
      return next();
    }
    if (!take(key, opts.limit, opts.windowMs)) {
      c.header("Retry-After", String(Math.ceil(opts.windowMs / 1000)));
      return c.json({ error: "rate_limited" }, 429);
    }
    return next();
  };
}

// Periodic cleanup so the bucket map doesn't grow unbounded.
setInterval(() => {
  const now = Date.now();
  for (const [k, b] of buckets) {
    if (b.resetAt < now) buckets.delete(k);
  }
}, 60_000).unref();