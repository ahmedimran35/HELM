// Performance dashboard (Tier 5).
//
//   GET /api/perf  — aggregate metrics for the current user:
//     * avg chat latency (last 24h, harness_runs)
//     * cache hit rate (response_cache)
//     * total tokens (last 30d)
//     * total cost (cents, last 30d)
//     * tokens per turn
//     * top model by usage
//     * per-panel breakdown for spend caps
//
// The route is read-only and intentionally cheap — every query is a
// single aggregate. Admins see system-wide; users see only their own.

import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.ts";
import { sql } from "../db/client.ts";
import { cacheHitStats } from "../lib/response-cache.ts";
import { listSpendCapsForUser } from "../lib/spend-tracker.ts";

const router = new Hono();
router.use("*", requireAuth);

interface PerfRow {
  metric: string;
  value: number;
}

interface ModelUsageRow {
  model: string;
  runs: number;
  tokens: number;
}

interface PanelUsageRow {
  panel_id: string;
  panel_name: string;
  runs: number;
  tokens: number;
}

interface LatencyPointRow {
  bucket: string;
  avg_ms: number;
}

router.get("/", async (c) => {
  const user = c.get("user");
  const isAdmin = user.role === "admin";

  // Postgres.js tagged-template fragments compose cleanly when bound to
  // a variable. Admin sees all rows; non-admin sees only own.
  const whereUser = isAdmin
    ? sql`TRUE`
    : sql`hr.user_id = ${user.id}::uuid`;

  // Aggregate metrics in one shot.
  const aggRows = await sql<PerfRow[]>`
    SELECT 'avg_latency_ms'::text AS metric,
           COALESCE(AVG(latency_ms) FILTER (WHERE status = 'ok'), 0)::numeric(12, 2)::float AS value
    FROM harness_runs hr WHERE ${whereUser} AND created_at > now() - interval '24 hours'
    UNION ALL
    SELECT 'p95_latency_ms'::text,
           COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms)
                    FILTER (WHERE status = 'ok'), 0)::numeric(12, 2)::float
    FROM harness_runs hr WHERE ${whereUser} AND created_at > now() - interval '24 hours'
    UNION ALL
    SELECT 'total_tokens'::text,
           COALESCE(SUM(prompt_tokens + completion_tokens), 0)::bigint::float
    FROM harness_runs hr WHERE ${whereUser} AND created_at > now() - interval '30 days'
    UNION ALL
    SELECT 'total_runs'::text,
           COALESCE(COUNT(*), 0)::float
    FROM harness_runs hr WHERE ${whereUser} AND created_at > now() - interval '30 days'
    UNION ALL
    SELECT 'error_runs'::text,
           COALESCE(COUNT(*) FILTER (WHERE status = 'error'), 0)::float
    FROM harness_runs hr WHERE ${whereUser} AND created_at > now() - interval '30 days'
  `;
  const byMetric = new Map(aggRows.map((r) => [r.metric, r.value]));

  // Cost — join through models for the per-1k prices.
  const costRows = await sql<{ total: number }[]>`
    SELECT COALESCE(SUM(
      CASE
        WHEN m.input_price_per_1k IS NULL OR m.output_price_per_1k IS NULL THEN
          (hr.prompt_tokens + hr.completion_tokens) * 0.1 / 1000
        ELSE
          (hr.prompt_tokens  * m.input_price_per_1k +
           hr.completion_tokens * m.output_price_per_1k)
      END
    ), 0)::numeric(12, 4)::float AS total
    FROM harness_runs hr
    LEFT JOIN models m ON m.external_id = hr.model
    WHERE ${whereUser} AND hr.created_at > now() - interval '30 days'
  `;

  // Tokens per turn.
  const tokensPerTurnRows = await sql<{ avg: number }[]>`
    SELECT COALESCE(AVG(total), 0)::numeric(12, 2)::float AS avg
    FROM (
      SELECT date_trunc('day', created_at) AS bucket,
             SUM(prompt_tokens + completion_tokens) AS total
      FROM harness_runs hr
      WHERE ${whereUser} AND created_at > now() - interval '30 days'
      GROUP BY bucket
    ) sub
  `;

  // Latency timeseries — hourly buckets for the last 24h.
  const latencyRows = await sql<LatencyPointRow[]>`
    SELECT date_trunc('hour', created_at)::text AS bucket,
           AVG(latency_ms)::numeric(12, 2)::float AS avg_ms
    FROM harness_runs hr
    WHERE ${whereUser} AND created_at > now() - interval '24 hours' AND status = 'ok'
    GROUP BY bucket ORDER BY bucket ASC
  `;

  // Top model by usage.
  const topModels = await sql<ModelUsageRow[]>`
    SELECT COALESCE(hr.model, 'unknown') AS model,
           COUNT(*)::int AS runs,
           COALESCE(SUM(hr.prompt_tokens + hr.completion_tokens), 0)::int AS tokens
    FROM harness_runs hr
    WHERE ${whereUser} AND hr.created_at > now() - interval '30 days'
    GROUP BY model ORDER BY runs DESC LIMIT 5
  `;

  // Per-panel usage.
  const panelRows = await sql<PanelUsageRow[]>`
    SELECT COALESCE(p.id::text, 'unknown') AS panel_id,
           COALESCE(p.name, 'unknown') AS panel_name,
           COUNT(*)::int AS runs,
           COALESCE(SUM(hr.prompt_tokens + hr.completion_tokens), 0)::int AS tokens
    FROM harness_runs hr
    LEFT JOIN panels p ON p.id = hr.panel_id
    WHERE ${whereUser} AND hr.created_at > now() - interval '30 days'
    GROUP BY p.id, p.name ORDER BY runs DESC LIMIT 8
  `;

  const stats = await cacheHitStats(user.id);
  const caps = await listSpendCapsForUser(user.id, isAdmin);

  return c.json({
    avg_latency_ms: byMetric.get("avg_latency_ms") ?? 0,
    p95_latency_ms: byMetric.get("p95_latency_ms") ?? 0,
    total_tokens: byMetric.get("total_tokens") ?? 0,
    total_runs: byMetric.get("total_runs") ?? 0,
    error_runs: byMetric.get("error_runs") ?? 0,
    total_cost_cents: costRows[0]?.total ?? 0,
    tokens_per_turn: tokensPerTurnRows[0]?.avg ?? 0,
    cache: stats,
    latency_series: latencyRows,
    top_models: topModels,
    per_panel: panelRows,
    spend_caps: caps,
  });
});

export default router;