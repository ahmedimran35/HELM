// Health + ping endpoints — used by the smoke test and by ops to verify
// the backend is reachable and the DB is reachable.
//
// Tier 5 adds /health/harnesses which reports per-harness status +
// latency. The endpoint serves the cached snapshot (TTL 60s) and
// accepts ?refresh=1 to force a fresh probe.
//
// /health/deep adds probes for every backing store (postgres, redis,
// lightpanda) so a load balancer can take the pod out of rotation when
// any of them goes down. Auth: NONE — uptime monitors don't carry a
// session cookie.

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { listHarnessHealth, refreshAllHarnesses } from "../lib/health-check.ts";
import { pingPopularProviders } from "../lib/popular-providers.ts";
import { safeError } from "../lib/safe-error.ts";
import { config } from "../config.ts";

const router = new Hono();

router.get("/", (c) => c.json({ ok: true, ts: Date.now() }));

// /db-ping is now auth-required so anonymous probers cannot extract
// database driver / host information from the error path. The error
// response is also sanitised via safeError.
router.get("/db-ping", requireAuth, async (c) => {
  try {
    const rows = await sql<{ now: Date }[]>`SELECT now() AS now`;
    return c.json({ ok: true, db_time: rows[0]?.now ?? null });
  } catch (err) {
    return safeError(c, err, { status: 503, code: "db_unavailable", publicMessage: "Database unavailable" });
  }
});

// Per-harness status + latency. Auth-required so we don't reveal
// internal harness counts to anonymous probers. Cached snapshots
// expire after 60s; ?refresh=1 forces a fresh probe.
router.get("/harnesses", requireAuth, async (c) => {
  const force = c.req.query("refresh") === "1";
  if (force) {
    await refreshAllHarnesses();
  }
  return c.json({ harnesses: listHarnessHealth() });
});

// ---------------------------------------------------------------------------
// /health/deep — probes every backing store. NO auth (uptime monitors).
//
// Each probe runs with a hard 2-second timeout via AbortController so a
// stuck Redis can't hang the route and make every monitor flip to red.
// On any failure we return 503 + per-probe status so the monitor can
// distinguish "db down" from "redis down" from "lightpanda down".
// ---------------------------------------------------------------------------

interface DeepProbeResult {
  ok: boolean;
  latency_ms?: number;
  error?: string;
}

async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${label} probe timed out after ${ms}ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function probePostgres(): Promise<DeepProbeResult> {
  const start = Date.now();
  try {
    await withTimeout(sql<{ ok: number }[]>`SELECT 1 AS ok`, 2_000, "postgres");
    return { ok: true, latency_ms: Date.now() - start };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - start, error: (err as Error).message };
  }
}

async function probeRedis(): Promise<DeepProbeResult> {
  // Only probe if REDIS_URL is configured — an instance that intentionally
  // runs without redis (single-process dev) shouldn't 503 just because
  // there is no redis to ping. We return ok=true with latency 0.
  const url = process.env.REDIS_URL;
  if (!url) {
    return { ok: true, latency_ms: 0 };
  }
  const start = Date.now();
  try {
    const mod = (await import("bun:redis" as string).catch(() => null)) as {
      RedisClient: new (u: string) => { ping(): Promise<string> };
    } | null;
    if (!mod) {
      // bun:redis not available (running under node, not bun) — skip
      // the probe rather than failing the whole route.
      return { ok: true, latency_ms: 0 };
    }
    const client = new mod.RedisClient(url);
    await withTimeout(client.ping(), 2_000, "redis");
    return { ok: true, latency_ms: Date.now() - start };
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - start, error: (err as Error).message };
  }
}

async function probeLightpanda(): Promise<DeepProbeResult> {
  // Only probe when an HTTP daemon is configured (WEB_SEARCH_LIGHTPANDA_URL).
  // The CLI spawn path doesn't have a ping endpoint we can call without
  // doing real work, so we treat CLI-mode as "no probe, assume ok".
  const url = config.webSearch.lightpandaUrl;
  if (!url) {
    return { ok: true, latency_ms: 0 };
  }
  const start = Date.now();
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2_000);
    try {
      const res = await fetch(`${url.replace(/\/$/, "")}/healthz`, { signal: ac.signal });
      if (!res.ok) {
        return {
          ok: false,
          latency_ms: Date.now() - start,
          error: `lightpanda /healthz returned ${res.status}`,
        };
      }
      return { ok: true, latency_ms: Date.now() - start };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, latency_ms: Date.now() - start, error: (err as Error).message };
  }
}

router.get("/deep", async (c) => {
  // Run all three probes in parallel — none of them depend on each
  // other, and we want the overall latency to be `max(probe)` not
  // `sum(probe)`.
  const [postgres, redis, lightpanda] = await Promise.all([
    probePostgres(),
    probeRedis(),
    probeLightpanda(),
  ]);
  const ok = postgres.ok && redis.ok && lightpanda.ok;
  const body = {
    ok,
    postgres: postgres.ok,
    redis: redis.ok,
    lightpanda: lightpanda.ok,
    probes: {
      postgres,
      redis,
      lightpanda,
    },
    ts: Date.now(),
  };
  return c.json(body, ok ? 200 : 503);
});

// ---------------------------------------------------------------------------
// /health/providers/popular — real-time reachability for every popular
// AI provider. No auth required (read-only public probe). No
// configuration required — these are hardcoded provider URLs.
// Cached 30s server-side so a flood of API scrapers doesn't hammer
// every upstream.
// ---------------------------------------------------------------------------
router.get("/providers/popular", async (c) => {
  const force = c.req.query("refresh") === "1";
  const providers = await pingPopularProviders({ forceRefresh: force });
  const summary = {
    up: providers.filter((p) => p.status === "up").length,
    degraded: providers.filter((p) => p.status === "degraded").length,
    down: providers.filter((p) => p.status === "down").length,
    unknown: providers.filter((p) => p.status === "unknown").length,
  };
  return c.json({ providers, summary, ts: Date.now() });
});

export default router;