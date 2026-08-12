// Governance: quotas, budgets, analytics (docs §2.6).
//
//   GET  /api/governance/quotas/:userId   (admin) — quota for a user
//   POST /api/governance/quotas/:userId   (admin) — upsert
//   GET  /api/governance/budgets/:userId  (admin)
//   POST /api/governance/budgets/:userId  (admin)
//   GET  /api/governance/me/quotas                 — current user's quota
//   GET  /api/governance/me/budgets                — current user's budget
//   GET  /api/governance/analytics/spend-by-model (admin)
//   GET  /api/governance/analytics/messages-over-time (admin)
//   GET  /api/governance/analytics/top-users      (admin)
//   GET  /api/governance/analytics/alerts          (admin) — budget-overrun banners

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAdmin } from "../middleware/role.ts";
import { logAudit } from "../lib/audit.ts";

const router = new Hono();
router.use("*", requireAuth);

const ALLOWED_PERIODS = new Set(["day", "week", "month"]);

router.get("/quotas/:userId", requireAdmin, async (c) => {
  const userId = c.req.param("userId");
  const rows = await sql<{
    message_limit: number | null;
    period: string;
  }[]>`SELECT message_limit, period FROM quotas WHERE user_id = ${userId}::uuid LIMIT 1`;
  return c.json(rows[0] ?? { message_limit: null, period: "month" });
});

router.post("/quotas/:userId", requireAdmin, async (c) => {
  const userId = c.req.param("userId");
  const body = (await c.req.json().catch(() => ({}))) as {
    message_limit?: number | null;
    period?: string;
  };
  const limit = body.message_limit ?? null;
  const period = ALLOWED_PERIODS.has(body.period ?? "") ? body.period! : "month";
  await sql`
    INSERT INTO quotas (user_id, message_limit, period)
    VALUES (${userId}::uuid, ${limit}, ${period})
    ON CONFLICT (user_id) DO UPDATE
      SET message_limit = EXCLUDED.message_limit, period = EXCLUDED.period
  `;
  await logAudit({
    userId: c.get("user").id,
    target: userId,
    action: "quota_set",
    metadata: { limit, period },
  });
  return c.json({ ok: true });
});

router.get("/budgets/:userId", requireAdmin, async (c) => {
  const userId = c.req.param("userId");
  const rows = await sql<{
    dollar_limit: string | null;
    period: string;
  }[]>`SELECT dollar_limit::text, period FROM budgets WHERE user_id = ${userId}::uuid LIMIT 1`;
  return c.json(rows[0] ?? { dollar_limit: null, period: "month" });
});

router.post("/budgets/:userId", requireAdmin, async (c) => {
  const userId = c.req.param("userId");
  const body = (await c.req.json().catch(() => ({}))) as {
    dollar_limit?: number | null;
    period?: string;
  };
  const limit = body.dollar_limit ?? null;
  const period = ALLOWED_PERIODS.has(body.period ?? "") ? body.period! : "month";
  await sql`
    INSERT INTO budgets (user_id, dollar_limit, period)
    VALUES (${userId}::uuid, ${limit}, ${period})
    ON CONFLICT (user_id) DO UPDATE
      SET dollar_limit = EXCLUDED.dollar_limit, period = EXCLUDED.period
  `;
  await logAudit({
    userId: c.get("user").id,
    target: userId,
    action: "budget_set",
    metadata: { limit, period },
  });
  return c.json({ ok: true });
});

router.get("/me/quotas", async (c) => {
  const user = c.get("user");
  const rows = await sql<{
    message_limit: number | null;
    period: string;
  }[]>`SELECT message_limit, period FROM quotas WHERE user_id = ${user.id}::uuid LIMIT 1`;
  return c.json(rows[0] ?? { message_limit: null, period: "month" });
});

router.get("/me/budgets", async (c) => {
  const user = c.get("user");
  const rows = await sql<{
    dollar_limit: string | null;
    period: string;
  }[]>`SELECT dollar_limit::text, period FROM budgets WHERE user_id = ${user.id}::uuid LIMIT 1`;
  return c.json(rows[0] ?? { dollar_limit: null, period: "month" });
});

router.get("/analytics/spend-by-model", requireAdmin, async (c) => {
  // Real spend from per-model token usage and pricing.
  const rows = await sql<{
    model_id: string | null;
    model_name: string | null;
    spend: number;
    tokens: number;
  }[]>`
    WITH usage AS (
      SELECT
        m.id AS model_id,
        m.display_name AS model_name,
        COALESCE((a.metadata->>'prompt_tokens')::int, 0)    AS prompt_tokens,
        COALESCE((a.metadata->>'completion_tokens')::int, 0) AS completion_tokens,
        a.tokens AS total_tokens,
        m.input_price_per_1k,
        m.output_price_per_1k
      FROM audit_log a
      LEFT JOIN models m ON m.id::text = a.target
      WHERE a.action IN ('chat_assistant_message', 'panel_assistant_message')
        AND a.target IS NOT NULL
    )
    SELECT model_id, model_name,
           sum(
             CASE
               WHEN input_price_per_1k IS NULL OR output_price_per_1k IS NULL THEN
                 total_tokens * 0.001 / 1000
               ELSE
                 (prompt_tokens * input_price_per_1k +
                  completion_tokens * output_price_per_1k) / 1000
             END
           )::numeric(12, 4) AS spend,
           sum(total_tokens)::int AS tokens
    FROM usage
    GROUP BY model_id, model_name
    ORDER BY spend DESC
  `;
  return c.json(rows);
});

router.get("/analytics/messages-over-time", requireAdmin, async (c) => {
  const rows = await sql<{
    bucket: string;
    count: number;
  }[]>`
    SELECT date_trunc('hour', created_at)::text AS bucket, count(*)::int AS count
    FROM messages WHERE created_at > now() - interval '24 hours'
    GROUP BY bucket ORDER BY bucket ASC
  `;
  return c.json(rows);
});

router.get("/analytics/top-users", requireAdmin, async (c) => {
  const rows = await sql<{
    user_id: string;
    user_name: string;
    count: number;
  }[]>`
    SELECT u.id AS user_id, u.name AS user_name, count(m.id)::int AS count
    FROM users u LEFT JOIN messages m ON m.user_id = u.id
    GROUP BY u.id, u.name
    ORDER BY count DESC LIMIT 10
  `;
  return c.json(rows);
});

router.get("/analytics/alerts", requireAdmin, async (c) => {
  // For each user with a budget, compute real spend from audit_log token
  // counts joined with the model's input/output prices. We use the
  // stored prompt_tokens/completion_tokens when present (recorded by the
  // chat handler) and fall back to a 60/40 split if only the total is
  // available. Then multiply by the per-1k prices on the models row.
  const rows = await sql<{
    user_id: string;
    user_name: string;
    dollar_limit: string | null;
    spent: number;
  }[]>`
    WITH usage AS (
      SELECT
        a.user_id,
        m.id AS model_id,
        m.input_price_per_1k,
        m.output_price_per_1k,
        COALESCE((a.metadata->>'prompt_tokens')::int, 0)    AS prompt_tokens,
        COALESCE((a.metadata->>'completion_tokens')::int, 0) AS completion_tokens,
        a.tokens AS total_tokens
      FROM audit_log a
      JOIN users u ON u.id = a.user_id
      LEFT JOIN models m ON m.id::text = a.target
      WHERE a.action IN ('chat_assistant_message','panel_assistant_message')
        AND a.created_at >= date_trunc('month', now())
    )
    SELECT u.id AS user_id, u.name AS user_name,
           b.dollar_limit::text AS dollar_limit,
           COALESCE(sum(
             CASE
               WHEN usage.input_price_per_1k IS NULL OR usage.output_price_per_1k IS NULL THEN
                 -- Fallback: assume the entire token count is completion
                 -- and price it at $0.001 per 1k as a conservative default.
                 usage.total_tokens * 0.001 / 1000
               ELSE
                 (usage.prompt_tokens  * usage.input_price_per_1k  +
                  usage.completion_tokens * usage.output_price_per_1k) / 1000
             END
           ), 0)::numeric(12, 4) AS spent
    FROM users u
    LEFT JOIN budgets b ON b.user_id = u.id
    LEFT JOIN usage ON usage.user_id = u.id
    GROUP BY u.id, u.name, b.dollar_limit
  `;
  const alerts = rows
    .map((r) => {
      const limit = r.dollar_limit ? Number(r.dollar_limit) : null;
      if (limit === null) return null;
      const dollars = Number(r.spent);
      const ratio = limit > 0 ? dollars / limit : 0;
      if (ratio >= 1) return { user_id: r.user_id, user_name: r.user_name, level: "exceeded", ratio, dollars, limit };
      if (ratio >= 0.8) return { user_id: r.user_id, user_name: r.user_name, level: "warning", ratio, dollars, limit };
      return null;
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
  return c.json(alerts);
});

router.get("/analytics/spend-by-model", requireAdmin, async (c) => {
  // Real spend from per-model token usage and pricing.
  const rows = await sql<{
    model_id: string | null;
    model_name: string | null;
    spend: number;
    tokens: number;
  }[]>`
    WITH usage AS (
      SELECT
        m.id AS model_id,
        m.display_name AS model_name,
        COALESCE((a.metadata->>'prompt_tokens')::int, 0)    AS prompt_tokens,
        COALESCE((a.metadata->>'completion_tokens')::int, 0) AS completion_tokens,
        a.tokens AS total_tokens,
        m.input_price_per_1k,
        m.output_price_per_1k
      FROM audit_log a
      LEFT JOIN models m ON m.id::text = a.target
      WHERE a.action IN ('chat_assistant_message','panel_assistant_message')
        AND a.target IS NOT NULL
        AND a.created_at >= date_trunc('month', now())
    )
    SELECT model_id, model_name,
           sum(
             CASE
               WHEN input_price_per_1k IS NULL OR output_price_per_1k IS NULL THEN
                 total_tokens * 0.001 / 1000
               ELSE
                 (prompt_tokens * input_price_per_1k +
                  completion_tokens * output_price_per_1k) / 1000
             END
           )::numeric(12, 4) AS spend,
           sum(total_tokens)::int AS tokens
    FROM usage
    GROUP BY model_id, model_name
    ORDER BY spend DESC
  `;
  return c.json(rows);
});

export default router;