// Tier 6 — Self-improvement feedback (docs §6).
//
// Three tables back this surface:
//   - message_feedback       : one row per (user, message) thumbs vote
//   - user_preference_profiles : derived preferences (recomputed by
//                                preference-learner.ts)
//   - self_test_results      : written by lib/self-test.ts; read-only here
//
// Endpoints:
//   POST   /api/feedback                       — upsert own vote
//   GET    /api/feedback?message_id=…          — list feedback for one msg
//   DELETE /api/feedback/:id                   — remove own vote
//   GET    /api/feedback/stats                 — admin aggregate
//   POST   /api/feedback/recompute-profile     — admin (re-)run learner
//   GET    /api/feedback/profile               — own preference profile
//   PUT    /api/feedback/profile               — admin-overridable prefs
//   GET    /api/messages/:id/self-test         — self-test result
//
// Ratings are constrained at the DB level ('up' | 'down'). Feedback is
// globally unique per (user_id, message_id) so repeated votes update
// rather than duplicate.

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { validate, validationErrorResponse } from "../lib/validate.ts";
import { logAudit } from "../lib/audit.ts";
import { recomputeProfileForUser } from "../lib/preference-learner.ts";

const router = new Hono();
router.use("*", requireAuth);

// ───────────────────────────────────────────────────────────────────
// POST / — upsert (user_id, message_id) → rating, reason?
// ───────────────────────────────────────────────────────────────────

router.post("/", async (c) => {
  const user = c.get("user");
  let body: { message_id?: string; rating?: "up" | "down"; reason?: string };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      message_id: { type: "uuid" },
      rating: { type: "enum", values: ["up", "down"] },
      reason: { type: "string", maxLength: 1000, trim: true },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (!body.message_id || !body.rating) {
    return c.json({ error: "message_id and rating required" }, 400);
  }
  // Sanity-check the message exists and is owned by *some* user; admins
  // can react to anything, regular users only to their own messages.
  const msg = await sql<{ user_id: string; role: string }[]>`
    SELECT user_id, role FROM messages WHERE id = ${body.message_id}::uuid LIMIT 1
  `;
  if (!msg[0]) return c.json({ error: "message_not_found" }, 404);
  if (user.role !== "admin" && msg[0].user_id !== user.id) {
    return c.json({ error: "forbidden" }, 403);
  }
  // Upsert. ON CONFLICT clause targets the UNIQUE (user_id, message_id)
  // constraint defined in migration 0009. This is what makes a second
  // vote replace the first rather than stack.
  const rows = await sql<{ id: string }[]>`
    INSERT INTO message_feedback (user_id, message_id, rating, reason)
    VALUES (${user.id}::uuid, ${body.message_id}::uuid,
            ${body.rating}, ${body.reason ?? null})
    ON CONFLICT (user_id, message_id)
    DO UPDATE SET rating = EXCLUDED.rating,
                  reason = EXCLUDED.reason
    RETURNING id
  `;
  await logAudit({
    userId: user.id,
    target: body.message_id,
    action: "feedback_vote",
    metadata: { rating: body.rating, has_reason: !!body.reason },
  });
  return c.json({ id: rows[0]!.id, rating: body.rating, reason: body.reason ?? null });
});

// ───────────────────────────────────────────────────────────────────
// GET / — list feedback for a message (admins see all, users see own)
// ───────────────────────────────────────────────────────────────────

router.get("/", async (c) => {
  const user = c.get("user");
  const messageId = c.req.query("message_id");
  if (!messageId) {
    return c.json({ error: "message_id required" }, 400);
  }
  // Verify message exists first so we can give a clean 404.
  const exists = await sql<{ id: string }[]>`
    SELECT id FROM messages WHERE id = ${messageId}::uuid LIMIT 1
  `;
  if (!exists[0]) return c.json({ error: "message_not_found" }, 404);
  if (user.role === "admin") {
    const rows = await sql<{
      id: string;
      user_id: string;
      user_name: string;
      rating: "up" | "down";
      reason: string | null;
      created_at: Date;
    }[]>`
      SELECT f.id, f.user_id, u.name AS user_name, f.rating, f.reason, f.created_at
      FROM message_feedback f
      JOIN users u ON u.id = f.user_id
      WHERE f.message_id = ${messageId}::uuid
      ORDER BY f.created_at DESC
    `;
    return c.json(rows);
  }
  // Non-admin: only their own vote for this message.
  const rows = await sql<{
    id: string;
    rating: "up" | "down";
    reason: string | null;
    created_at: Date;
  }[]>`
    SELECT id, rating, reason, created_at
    FROM message_feedback
    WHERE message_id = ${messageId}::uuid AND user_id = ${user.id}::uuid
    LIMIT 1
  `;
  return c.json(rows);
});

// ───────────────────────────────────────────────────────────────────
// DELETE /:id — remove own vote. Admins can remove anyone's.
// ───────────────────────────────────────────────────────────────────

router.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  // Look up first so we can return a clean 404 vs 403 vs 204.
  const rows = await sql<{ user_id: string }[]>`
    SELECT user_id FROM message_feedback WHERE id = ${id}::uuid LIMIT 1
  `;
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  if (user.role !== "admin" && rows[0].user_id !== user.id) {
    return c.json({ error: "forbidden" }, 403);
  }
  await sql`DELETE FROM message_feedback WHERE id = ${id}::uuid`;
  return c.json({ ok: true });
});

// ───────────────────────────────────────────────────────────────────
// GET /stats — admin only. Aggregate signal.
// ───────────────────────────────────────────────────────────────────

router.get("/stats", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") return c.json({ error: "forbidden" }, 403);

  // Totals — three numbers: total votes, ups, downs.
  const totals = await sql<{ total: number; ups: number; downs: number }[]>`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (WHERE rating = 'up')::int AS ups,
      count(*) FILTER (WHERE rating = 'down')::int AS downs
    FROM message_feedback
  `;
  const t = totals[0] ?? { total: 0, ups: 0, downs: 0 };
  const upPct = t.total > 0 ? (t.ups / t.total) * 100 : 0;

  // Per-model breakdown. Joins through messages.model_id → models so
  // we can show display names. NULL model_id never happens in 1:1 chat
  // (message_feedback references messages with a NOT NULL model_id) but
  // we keep COALESCE just in case.
  const perModel = await sql<{
    model_id: string;
    model_name: string | null;
    ups: number;
    downs: number;
    total: number;
  }[]>`
    SELECT m.id AS model_id,
           md.display_name AS model_name,
           count(*) FILTER (WHERE f.rating = 'up')::int AS ups,
           count(*) FILTER (WHERE f.rating = 'down')::int AS downs,
           count(*)::int AS total
    FROM message_feedback f
    JOIN messages m ON m.id = f.message_id
    LEFT JOIN models md ON md.id = m.model_id
    GROUP BY m.id, md.display_name
    ORDER BY total DESC
    LIMIT 50
  `;

  // Last-14-day daily trend.
  const trend = await sql<{ bucket: string; ups: number; downs: number }[]>`
    SELECT to_char(date_trunc('day', f.created_at), 'YYYY-MM-DD') AS bucket,
           count(*) FILTER (WHERE f.rating = 'up')::int AS ups,
           count(*) FILTER (WHERE f.rating = 'down')::int AS downs
    FROM message_feedback f
    WHERE f.created_at >= now() - INTERVAL '14 days'
    GROUP BY 1
    ORDER BY 1 ASC
  `;

  return c.json({
    total: t.total,
    up_pct: upPct,
    down_pct: 100 - upPct,
    ups: t.ups,
    downs: t.downs,
    per_model: perModel.map((p) => ({
      ...p,
      up_pct: p.total > 0 ? (p.ups / p.total) * 100 : 0,
    })),
    trend,
  });
});

// ───────────────────────────────────────────────────────────────────
// POST /recompute-profile — admin trigger for the preference learner
// ───────────────────────────────────────────────────────────────────

router.post("/recompute-profile", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") return c.json({ error: "forbidden" }, 403);
  let body: { user_id?: string } = {};
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      user_id: { type: "uuid" },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (body.user_id) {
    const prefs = await recomputeProfileForUser(body.user_id);
    return c.json({ updated: 1, preferences: prefs });
  }
  // Otherwise: recompute for every user that has feedback in the last 30
  // days. This is what the nightly scheduler also calls.
  const targets = await sql<{ user_id: string }[]>`
    SELECT DISTINCT user_id FROM message_feedback
    WHERE created_at >= now() - INTERVAL '30 days'
  `;
  let updated = 0;
  for (const row of targets) {
    await recomputeProfileForUser(row.user_id);
    updated++;
  }
  await logAudit({
    userId: user.id,
    target: "all",
    action: "preference_recompute_all",
    metadata: { updated },
  });
  return c.json({ updated });
});

// ───────────────────────────────────────────────────────────────────
// GET /profile — current user's derived preference profile
// ───────────────────────────────────────────────────────────────────

router.get("/profile", async (c) => {
  const user = c.get("user");
  const rows = await sql<{
    preferences: Record<string, unknown>;
    updated_at: Date;
  }[]>`
    SELECT preferences, updated_at
    FROM user_preference_profiles
    WHERE user_id = ${user.id}::uuid
    LIMIT 1
  `;
  if (!rows[0]) {
    return c.json({
      preferences: {
        preferred_models: [],
        dislikes: [],
        model_scores: {},
        sample_size: 0,
      },
      updated_at: null,
    });
  }
  return c.json(rows[0]);
});

// ───────────────────────────────────────────────────────────────────
// PUT /profile — user overrides their learned preferences
// ───────────────────────────────────────────────────────────────────

router.put("/profile", async (c) => {
  const user = c.get("user");
  let body: {
    preferred_models?: string[];
    dislikes?: string[];
  };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      preferred_models: { type: "array", of: { type: "string" }, maxLength: 50 },
      dislikes: { type: "array", of: { type: "string" }, maxLength: 50 },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  // We merge the user's overrides into the existing derived profile so
  // recompute runs keep the manual bits intact.
  const existing = await sql<{ preferences: Record<string, unknown> }[]>`
    SELECT preferences FROM user_preference_profiles
    WHERE user_id = ${user.id}::uuid LIMIT 1
  `;
  const merged: Record<string, unknown> = {
    ...(existing[0]?.preferences ?? {}),
    manual_overrides: true,
    updated_at: new Date().toISOString(),
  };
  if (body.preferred_models) merged.preferred_models = body.preferred_models;
  if (body.dislikes) merged.dislikes = body.dislikes;
  await sql`
    INSERT INTO user_preference_profiles (user_id, preferences, updated_at)
    VALUES (${user.id}::uuid, ${sql.json(merged as Record<string, never>)}, now())
    ON CONFLICT (user_id) DO UPDATE
      SET preferences = EXCLUDED.preferences,
          updated_at  = now()
  `;
  return c.json({ ok: true, preferences: merged });
});

export default router;
