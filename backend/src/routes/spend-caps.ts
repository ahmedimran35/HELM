// Spend cap CRUD (Tier 5).
//
//   GET  /api/spend-caps            — list caps the user can see
//   POST /api/spend-caps            — upsert (admin OR panel member)
//   GET  /api/spend-caps/:panelId   — current period snapshot for a
//                                     single panel
//
// Validation is deliberately light — the schema (CHECK constraint
// on period + integer limit_cents) catches the rest.

import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.ts";
import { validate, validationErrorResponse } from "../lib/validate.ts";
import { listSpendCapsForUser, getCurrentSpend, upsertSpendCap, type SpendPeriod } from "../lib/spend-tracker.ts";

const router = new Hono();
router.use("*", requireAuth);

const PERIODS = ["day", "week", "month"] as const;

router.get("/", async (c) => {
  const user = c.get("user");
  const rows = await listSpendCapsForUser(user.id, user.role === "admin");
  return c.json(rows);
});

router.post("/", async (c) => {
  const user = c.get("user");
  let body: {
    panel_id?: string;
    period?: string;
    limit_cents?: number;
    warn_at_pct?: number;
    hard_cap?: boolean;
  };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      panel_id: { type: "uuid" },
      period: { type: "enum", values: PERIODS },
      limit_cents: { type: "number", min: 1, integer: true },
      warn_at_pct: { type: "number", min: 1, max: 100, integer: true },
      hard_cap: { type: "boolean" },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (!body.panel_id || !body.period || !body.limit_cents) {
    return c.json({ error: "panel_id, period, limit_cents required" }, 400);
  }
  const period = body.period as SpendPeriod;
  const result = await upsertSpendCap({
    panelId: body.panel_id,
    userId: user.id,
    isAdmin: user.role === "admin",
    period,
    limit_cents: body.limit_cents,
    warn_at_pct: body.warn_at_pct ?? 80,
    hard_cap: body.hard_cap ?? false,
  });
  if (!result.ok) {
    return c.json({ error: result.reason }, 403);
  }
  return c.json({ ok: true });
});

router.get("/:panelId", async (c) => {
  const user = c.get("user");
  const panelId = c.req.param("panelId");
  const period = (c.req.query("period") ?? "month") as SpendPeriod;
  if (!PERIODS.includes(period)) {
    return c.json({ error: "invalid_period" }, 400);
  }
  // Non-admins must be members.
  if (user.role !== "admin") {
    const member = await (
      await import("../db/client.ts")
    ).sql<{ panel_id: string }[]>`
      SELECT panel_id FROM panel_members
      WHERE user_id = ${user.id}::uuid AND panel_id = ${panelId}::uuid LIMIT 1
    `;
    if (!member[0]) return c.json({ error: "forbidden" }, 403);
  }
  const snap = await getCurrentSpend(panelId, period);
  return c.json(snap);
});

export default router;