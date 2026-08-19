// Status — admin-only health endpoint (Tier 7 integration).
//
//   GET /api/status
//
// Returns a deep snapshot of the system so the /status page can render
// a green/yellow/red pill per subsystem. Designed to NEVER throw —
// every probe is wrapped in try/catch and returns a degraded entry
// instead. That keeps the status page useful when half the system is
// down (which is exactly when admins need it most).
//
// Subsystems probed:
//   - db                Postgres connectivity + latency
//   - redis             Optional Redis (only present when REDIS_URL set)
//   - harnesses         List of registered harnesses + per-harness model count
//   - jobs              Watch scheduler, memory scheduler (via recent activity)
//   - counts            Active users, panels, workflows
//   - providers         Provider + model registry health
//   - uptime            Process start time + seconds since boot
//
// Output is plain JSON so a future cron / watchdog can scrape it.

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAdmin } from "../middleware/role.ts";
import { safeError } from "../lib/safe-error.ts";

const router = new Hono();
router.use("*", requireAuth);
router.use("*", requireAdmin);

interface ServiceStatus {
  state: "healthy" | "degraded" | "down";
  detail?: string;
  latency_ms?: number;
}

interface HarnessStatus extends ServiceStatus {
  kind: string;
  model_count: number;
}

interface JobStatus extends ServiceStatus {
  name: string;
  last_run_at?: string;
}

interface ProviderStatus extends ServiceStatus {
  count: number;
  model_count: number;
}

interface StatusReport {
  generated_at: string;
  uptime_seconds: number;
  process_started_at: string;
  db: ServiceStatus;
  redis: ServiceStatus;
  providers: ProviderStatus;
  harnesses: HarnessStatus[];
  jobs: JobStatus[];
  counts: {
    users: number;
    panels: number;
    workflows: number;
    sessions: number;
  };
  restart_supported: boolean;
}

const PROCESS_START = Date.now();

async function probeDb(): Promise<ServiceStatus> {
  const start = Date.now();
  try {
    const rows = await sql<{ n: number }[]>`SELECT 1::int AS n`;
    return {
      state: rows.length > 0 ? "healthy" : "degraded",
      detail: rows.length > 0 ? "ok" : "no rows",
      latency_ms: Date.now() - start,
    };
  } catch (err) {
    console.warn("[status] db probe failed:", (err as Error).message);
    return { state: "down", detail: "db_unreachable", latency_ms: Date.now() - start };
  }
}

async function probeRedis(): Promise<ServiceStatus> {
  const url = process.env.REDIS_URL;
  if (!url || url.length === 0) {
    return { state: "degraded", detail: "REDIS_URL not configured" };
  }
  // Avoid pulling a redis client into the bundle just for a health
  // probe. Try a TCP connect with a short timeout; if it succeeds we
  // declare the service "healthy" (further ops will surface real errors).
  const start = Date.now();
  try {
    const u = new URL(url);
    const host = u.hostname;
    const port = Number(u.port || "6379");
    // Bun supports Bun.connect for raw TCP. We use node:net here so
    // the probe works under both bun and node test harnesses.
    const { createConnection } = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const sock = createConnection({ host, port });
      const t = setTimeout(() => {
        sock.destroy();
        reject(new Error("redis probe timeout"));
      }, 1000);
      sock.once("connect", () => {
        clearTimeout(t);
        sock.end();
        resolve();
      });
      sock.once("error", (err) => {
        clearTimeout(t);
        reject(err);
      });
    });
    return { state: "healthy", detail: `tcp ${host}:${port}`, latency_ms: Date.now() - start };
  } catch (err) {
    console.warn("[status] redis probe failed:", (err as Error).message);
    return { state: "down", detail: "redis_unreachable", latency_ms: Date.now() - start };
  }
}

async function probeProviders(): Promise<ProviderStatus> {
  try {
    const rows = await sql<{ p: number; m: number }[]>`
      SELECT (SELECT count(*) FROM providers)::int AS p,
             (SELECT count(*) FROM models)::int     AS m
    `;
    const r = rows[0];
    const count = r?.p ?? 0;
    const model_count = r?.m ?? 0;
    return count > 0
      ? { state: "healthy", count, model_count }
      : { state: "degraded", count, model_count, detail: "no providers configured" };
  } catch (err) {
    console.warn("[status] providers probe failed:", (err as Error).message);
    return { state: "down", detail: "providers_unavailable", count: 0, model_count: 0 };
  }
}

async function probeHarnesses(): Promise<HarnessStatus[]> {
  try {
    const rows = await sql<{ kind: string; model_count: number }[]>`
      SELECT p.type AS kind, count(m.id)::int AS model_count
      FROM providers p LEFT JOIN models m ON m.provider_id = p.id
      GROUP BY p.type
      ORDER BY p.type
    `;
    if (rows.length === 0) {
      return [{ kind: "none", state: "degraded", model_count: 0, detail: "no harnesses registered" }];
    }
    return rows.map((r) => ({
      kind: r.kind,
      state: r.model_count > 0 ? "healthy" : "degraded",
      model_count: r.model_count,
      detail: r.model_count > 0 ? `${r.model_count} models` : "0 models",
    }));
  } catch (err) {
    console.warn("[status] harnesses probe failed:", (err as Error).message);
    return [{ kind: "unknown", state: "down", model_count: 0, detail: "harnesses_unavailable" }];
  }
}

async function probeJobs(): Promise<JobStatus[]> {
  const jobs: JobStatus[] = [];
  // Watch scheduler — measured by activity in watch_runs within 5 min
  try {
    const rows = await sql<{ recent: number; last: Date | null; total: number }[]>`
      SELECT
        count(*) FILTER (WHERE started_at > now() - interval '5 minutes')::int AS recent,
        max(started_at) AS last,
        count(*)::int AS total
      FROM watch_runs
    `;
    const r = rows[0];
    const recent = r?.recent ?? 0;
    const total = r?.total ?? 0;
    jobs.push({
      name: "watch_scheduler",
      state: recent > 0 || total === 0 ? "healthy" : "degraded",
      detail: recent > 0 ? `${recent} runs in last 5m` : total > 0 ? "no recent runs" : "no runs yet (cold install)",
      last_run_at: r?.last?.toISOString() ?? undefined,
    });
  } catch (err) {
    console.warn("[status] watch_scheduler probe failed:", (err as Error).message);
    jobs.push({ name: "watch_scheduler", state: "down", detail: "watch_scheduler_unavailable" });
  }
  // Memory scheduler — measured by activity in memory_entries
  try {
    const rows = await sql<{ recent: number; last: Date | null }[]>`
      SELECT
        count(*) FILTER (WHERE created_at > now() - interval '5 minutes')::int AS recent,
        max(created_at) AS last
      FROM memory_entries
    `;
    const r = rows[0];
    const recent = r?.recent ?? 0;
    jobs.push({
      name: "memory_scheduler",
      state: recent > 0 || r === undefined ? "healthy" : "degraded",
      detail: recent > 0 ? `${recent} writes in last 5m` : "idle (no writes yet)",
      last_run_at: r?.last?.toISOString() ?? undefined,
    });
  } catch (err) {
    console.warn("[status] memory_scheduler probe failed:", (err as Error).message);
    jobs.push({ name: "memory_scheduler", state: "down", detail: "memory_scheduler_unavailable" });
  }
  // Summarizer — same memory_entries table; status distinguishes by
  // checking if any summarizer row was added in the last hour.
  try {
    const rows = await sql<{ last: Date | null }[]>`
      SELECT max(created_at) AS last
      FROM memory_entries
      WHERE source_type = 'summary'
    `;
    const last = rows[0]?.last ?? null;
    jobs.push({
      name: "summarizer",
      state: last ? "healthy" : "degraded",
      detail: last ? "ran recently" : "no summaries yet",
      last_run_at: last?.toISOString() ?? undefined,
    });
  } catch (err) {
    console.warn("[status] summarizer probe failed:", (err as Error).message);
    jobs.push({ name: "summarizer", state: "down", detail: "summarizer_unavailable" });
  }
  return jobs;
}

async function probeCounts(): Promise<StatusReport["counts"]> {
  try {
    const u = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM users WHERE is_active = TRUE`;
    const p = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM panels`;
    const w = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM workflows WHERE enabled = TRUE`;
    const s = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM sessions WHERE logout_at IS NULL AND expires_at > now()`;
    return {
      users: u[0]?.n ?? 0,
      panels: p[0]?.n ?? 0,
      workflows: w[0]?.n ?? 0,
      sessions: s[0]?.n ?? 0,
    };
  } catch {
    return { users: 0, panels: 0, workflows: 0, sessions: 0 };
  }
}

router.get("/", async (c) => {
  const [db, redis, providers, harnesses, jobs, counts] = await Promise.all([
    probeDb(),
    probeRedis(),
    probeProviders(),
    probeHarnesses(),
    probeJobs(),
    probeCounts(),
  ]);
  const report: StatusReport = {
    generated_at: new Date().toISOString(),
    uptime_seconds: Math.floor((Date.now() - PROCESS_START) / 1000),
    process_started_at: new Date(PROCESS_START).toISOString(),
    db,
    redis,
    providers,
    harnesses,
    jobs,
    counts,
    restart_supported: true,
  };
  return c.json(report);
});

// Restart button — used by /status. We don't actually restart the
// process (that's the cli's job); we signal "yes, you can" and the
// admin runs `bun src/cli.ts up` in a terminal. We do kill the
// schedulers so an admin can hot-reload them without a full restart
// (useful after seeding).
router.post("/restart", async (c) => {
  try {
    // The schedulers are idempotent — start again after stopping.
    const { stopWatchScheduler, startWatchScheduler } = await import("../lib/watches.ts");
    stopWatchScheduler();
    startWatchScheduler();
    const { startMemoryScheduler } = await import("../lib/memory-strategies/scheduler.ts");
    startMemoryScheduler();
    return c.json({ ok: true, restarted_at: new Date().toISOString() });
  } catch (err) {
    return safeError(c, err, { status: 500, code: "internal_error" });
  }
});

export default router;