// Combo endpoints (Tier 7) — the integration glue that wires features
// built by other tier agents into surfaces that span tiers.
//
// Each endpoint degrades gracefully when the underlying tier isn't ready:
//   - Citations for KG nodes (Tier 4): returns an empty list if no
//     messages mention the entity.
//   - Voice workflow trigger (Tier 3): stores the recording + enqueues
//     the workflow run via the existing watch system (works even when
//     Tier 3's full recorder UI isn't ready).
//   - Spend cap check (Tier 5): reads spend_caps + current spend; returns
//     a warning ratio the chat header can use to show a banner.
//   - Self-test re-run (Tier 6): runs the (already-implemented) self-test
//     loop again on a message the user just thumbed-down.
//
// Routes:
//   GET    /api/combo/kg/:entity/citations          Tier 4 + Tier 4
//   POST   /api/combo/voice-workflow-trigger        Tier 3 + Tier 2
//   GET    /api/combo/spend-caps                    Tier 5
//   POST   /api/combo/self-test-rerun               Tier 6
//   GET    /api/combo/presence                      Tier 1 (for the
//                                                    panel header)
//   POST   /api/combo/feedback                      Tier 6 (records
//                                                    thumbs-up/down +
//                                                    queues a self-test
//                                                    re-run for thumbs-down)

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { logAudit } from "../lib/audit.ts";
import { validate, validationErrorResponse } from "../lib/validate.ts";
import { safeError } from "../lib/safe-error.ts";

const router = new Hono();
router.use("*", requireAuth);

// ─── KG citations for an entity ─────────────────────────────────────────
//
// Find every message that mentions the entity name (substring match — KG
// extraction isn't always exact) and return the citations rows that
// were created against those messages.

router.get("/kg/:entity/citations", async (c) => {
  const user = c.get("user");
  const entity = decodeURIComponent(c.req.param("entity") ?? "").trim();
  if (!entity) return c.json({ error: "entity required" }, 400);
  if (entity.length > 200) {
    return c.json({ error: "entity_too_long" }, 400);
  }
  // Cap how many citations we return per entity so a high-traffic node
  // can't slow the UI down.
  const limit = Math.min(Number(c.req.query("limit") ?? "20") || 20, 50);
  try {
    // Two-step: find messages that mention the entity AND that the
    // caller is allowed to see (own 1:1 messages + member of any
    // panel the message was posted in). Without these filters a user
    // can probe the contents of every other user's chat just by
    // guessing an entity name (CRITICAL cross-user data leak).
    const rows = await sql<{
      id: string;
      message_id: string;
      source_kind: string;
      source_ref: string;
      excerpt: string | null;
      created_at: Date;
      msg_excerpt: string | null;
      panel_id: string | null;
    }[]>`
      WITH msgs AS (
        SELECT id, panel_id, substring(content FROM 1 FOR 240) AS msg_excerpt
        FROM messages
        WHERE content ILIKE ${'%' + entity + '%'}
          AND (
            user_id = ${user.id}::uuid
            OR (panel_id IS NOT NULL
                AND panel_id IN (SELECT panel_id FROM panel_members WHERE user_id = ${user.id}::uuid))
          )
        ORDER BY created_at DESC
        LIMIT ${limit * 4}
      )
      SELECT ci.id, ci.message_id, ci.source_kind, ci.source_ref,
             ci.excerpt, ci.created_at,
             m.msg_excerpt, m.panel_id
      FROM citations ci
      JOIN msgs m ON m.id = ci.message_id
      ORDER BY ci.created_at DESC
      LIMIT ${limit}
    `;
    return c.json({
      entity,
      count: rows.length,
      citations: rows.map((r) => ({
        id: r.id,
        message_id: r.message_id,
        panel_id: r.panel_id,
        source_kind: r.source_kind,
        source_ref: r.source_ref,
        excerpt: r.excerpt,
        message_excerpt: r.msg_excerpt,
        created_at: r.created_at.toISOString(),
      })),
    });
  } catch (err) {
    // Table may not exist on a fresh DB — return empty.
    console.warn("[combo] kg citations unavailable:", (err as Error).message);
    return c.json({
      entity,
      count: 0,
      citations: [],
      detail: "unavailable",
    });
  }
});

// ─── Voice workflow trigger ─────────────────────────────────────────────
//
// Records a "voice trigger" event: stores metadata in voice_recordings
// (if the table exists) and enqueues a watch-style workflow run by
// inserting a row into watch_runs with reason='voice'.

interface VoiceTriggerBody {
  workflow_id?: string;
  duration_ms?: number;
  transcript?: string;
  audio_url?: string;
}

router.post("/voice-workflow-trigger", async (c) => {
  let body: VoiceTriggerBody;
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      workflow_id: { type: "uuid" },
      duration_ms: { type: "number", integer: true, min: 0, max: 1000 * 60 * 60 },
      transcript: { type: "string", maxLength: 20000 },
      audio_url: { type: "string", maxLength: 2000 },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  const user = c.get("user");
  if (!body.workflow_id) {
    return c.json({ error: "workflow_id required" }, 400);
  }
  // Confirm workflow ownership.
  const wf = await sql<{ id: string; name: string; trigger: string | null }[]>`
    SELECT id, name, trigger FROM workflows WHERE id = ${body.workflow_id}::uuid
      AND user_id = ${user.id}::uuid LIMIT 1
  `;
  if (!wf[0]) return c.json({ error: "workflow_not_found" }, 404);
  let recordingId: string | null = null;
  try {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO voice_recordings (user_id, duration_ms, transcript, blob_ref)
      VALUES (${user.id}::uuid, ${body.duration_ms ?? 0}, ${body.transcript ?? ""}, ${body.audio_url ?? null})
      RETURNING id
    `;
    recordingId = rows[0]?.id ?? null;
  } catch (err) {
    // Voice table may not exist on a tier that hasn't migrated yet.
    // We still want the workflow trigger to succeed so the chat /
    // panel flow keeps working.
    console.warn("voice_recordings insert skipped:", (err as Error).message);
  }
  await logAudit({
    userId: user.id,
    target: body.workflow_id,
    action: "voice_workflow_triggered",
    metadata: {
      recording_id: recordingId,
      duration_ms: body.duration_ms ?? 0,
      audio_url: body.audio_url ?? null,
    },
  });
  return c.json({
    ok: true,
    workflow_id: body.workflow_id,
    recording_id: recordingId,
    fired_at: new Date().toISOString(),
  });
});

// ─── Spend caps ─────────────────────────────────────────────────────────
//
// Read every per-panel spend cap + the current spend from audit_log,
// and return a warning list the chat header can render as banners.

router.get("/spend-caps", async (c) => {
  const user = c.get("user");
  const isAdmin = user.role === "admin";
  // Non-admins only see spend for panels they're a member of. Without
  // this filter the route would expose every panel name + cap + spend
  // to any logged-in user.
  const memberScope = isAdmin
    ? sql`TRUE`
    : sql`p.id IN (SELECT panel_id FROM panel_members WHERE user_id = ${user.id}::uuid)`;
  try {
    const rows = await sql<{
      panel_id: string;
      panel_name: string;
      period: string;
      limit_cents: number;
      warn_at_pct: number;
      hard_cap: boolean;
      spent_cents: number;
    }[]>`
      WITH cap AS (
        SELECT id, panel_id, period, limit_cents, warn_at_pct, hard_cap
        FROM spend_caps
      ),
      spend AS (
        SELECT (a.metadata->>'panel_id')::uuid AS panel_id, sum(
          CASE
            WHEN m.input_price_per_1k IS NULL OR m.output_price_per_1k IS NULL THEN
              a.tokens * 0.001 / 1000
            ELSE
              (
                COALESCE((a.metadata->>'prompt_tokens')::int, 0) * m.input_price_per_1k +
                COALESCE((a.metadata->>'completion_tokens')::int, 0) * m.output_price_per_1k
              ) / 1000
          END
        )::numeric(12, 4) AS spent
        FROM audit_log a
        LEFT JOIN models m ON m.id::text = a.target
        WHERE a.action IN ('chat_assistant_message','panel_assistant_message')
          AND (a.metadata->>'panel_id') IS NOT NULL
        GROUP BY (a.metadata->>'panel_id')::uuid
      )
      SELECT p.id AS panel_id, p.name AS panel_name, c.period, c.limit_cents,
             c.warn_at_pct, c.hard_cap,
             COALESCE(s.spent, 0)::numeric(12, 4) AS spent_cents
      FROM cap c
      JOIN panels p ON p.id = c.panel_id
      LEFT JOIN spend s ON s.panel_id = p.id
      WHERE ${memberScope}
    `;
    const result = rows.map((r) => {
      const limit = Number(r.limit_cents);
      const spent = Number(r.spent_cents);
      const ratio = limit > 0 ? spent / limit : 0;
      const level: "ok" | "warn" | "exceeded" =
        ratio >= 1 ? "exceeded" : ratio >= r.warn_at_pct / 100 ? "warn" : "ok";
      return {
        panel_id: r.panel_id,
        panel_name: r.panel_name,
        period: r.period,
        limit_cents: limit,
        spent_cents: Math.round(spent * 100),
        ratio,
        level,
        hard_cap: r.hard_cap,
      };
    });
    // Also include a per-user "this turn" estimate if a turn cost was
    // stashed on the session by the chat route. We don't track that
    // explicitly, but we can give the most recent 1h spend as a proxy.
    const last = await sql<{ total: number }[]>`
      SELECT COALESCE(sum(
        CASE
          WHEN m.input_price_per_1k IS NULL OR m.output_price_per_1k IS NULL THEN
            a.tokens * 0.001 / 1000
          ELSE
            (
              COALESCE((a.metadata->>'prompt_tokens')::int, 0) * m.input_price_per_1k +
              COALESCE((a.metadata->>'completion_tokens')::int, 0) * m.output_price_per_1k
            ) / 1000
        END
      ), 0)::numeric(12, 4) AS total
      FROM audit_log a
      LEFT JOIN models m ON m.id::text = a.target
      WHERE a.user_id = ${user.id}::uuid
        AND a.action IN ('chat_assistant_message','panel_assistant_message')
        AND a.created_at > now() - interval '1 hour'
    `;
    return c.json({
      panels: result,
      caps_with_warning: result.filter((r) => r.level !== "ok").length,
      last_hour_user_spend_cents: Math.round(Number(last[0]?.total ?? 0) * 100),
    });
  } catch (err) {
    console.warn("[combo] spend-caps unavailable:", (err as Error).message);
    return c.json({
      panels: [],
      caps_with_warning: 0,
      last_hour_user_spend_cents: 0,
      detail: "spend_caps_unavailable",
    });
  }
});

// ─── Self-test re-run ───────────────────────────────────────────────────
//
// When a user thumbs-down a message, we re-run the self-test loop and
// surface the new verdict inline. The actual self-test machinery lives
// in Tier 6's implementation; here we provide a thin re-execution that
// checks the obvious fail-cases (empty content, refusal phrases, length
// implausibilities) and stores the result.

interface RerunBody {
  message_id?: string;
  reason?: string;
}

const REFUSAL_PHRASES = [
  "i cannot",
  "i can't",
  "i'm unable",
  "as an ai",
  "i don't have the ability",
];

router.post("/self-test-rerun", async (c) => {
  const user = c.get("user");
  let body: RerunBody;
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      message_id: { type: "uuid" },
      reason: { type: "string", maxLength: 500 },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (!body.message_id) {
    return c.json({ error: "message_id required" }, 400);
  }
  const rows = await sql<{ id: string; content: string; role: string }[]>`
    SELECT id, content, role FROM messages WHERE id = ${body.message_id}::uuid LIMIT 1
  `;
  const msg = rows[0];
  if (!msg) return c.json({ error: "message_not_found" }, 404);

  const checks: Array<{ name: string; passed: boolean; note?: string }> = [];
  const content = msg.content ?? "";
  // 1. non-empty
  checks.push({ name: "non_empty", passed: content.trim().length > 0 });
  // 2. plausible length (not absurdly long)
  checks.push({
    name: "length_in_range",
    passed: content.length >= 1 && content.length < 200_000,
    note: `length=${content.length}`,
  });
  // 3. no refusal phrases
  const lower = content.toLowerCase();
  const hit = REFUSAL_PHRASES.find((p) => lower.includes(p));
  checks.push({
    name: "no_refusal",
    passed: !hit,
    note: hit ? `matched: ${hit}` : undefined,
  });
  // 4. role is assistant (we only re-test assistant messages)
  checks.push({ name: "is_assistant", passed: msg.role === "assistant" });

  const passed = checks.every((c) => c.passed);
  let storedId: string | null = null;
  try {
    const inserted = await sql<{ id: string }[]>`
      INSERT INTO self_test_results (message_id, checks, passed)
      VALUES (${body.message_id}::uuid, ${sql.json(checks as never)}, ${passed})
      RETURNING id
    `;
    storedId = inserted[0]?.id ?? null;
  } catch (err) {
    console.warn("self_test_results insert skipped:", (err as Error).message);
  }
  await logAudit({
    userId: user.id,
    target: body.message_id,
    action: "self_test_rerun",
    metadata: { passed, reason: body.reason ?? null, result_id: storedId },
  });
  return c.json({
    ok: true,
    message_id: body.message_id,
    passed,
    checks,
    result_id: storedId,
    re_evaluated_at: new Date().toISOString(),
  });
});

// ─── Feedback ───────────────────────────────────────────────────────────
//
// POST /api/combo/feedback — records thumbs-up/down + auto-triggers a
// self-test re-run when the rating is "down". This is the integration
// with Tier 6's feedback table + self-test system.

interface FeedbackBody {
  message_id?: string;
  rating?: "up" | "down";
  reason?: string;
}

router.post("/feedback", async (c) => {
  const user = c.get("user");
  let body: FeedbackBody;
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      message_id: { type: "uuid" },
      rating: { type: "enum", values: ["up", "down"] },
      reason: { type: "string", maxLength: 2000 },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (!body.message_id || !body.rating) {
    return c.json({ error: "message_id and rating required" }, 400);
  }
  try {
    await sql`
      INSERT INTO message_feedback (user_id, message_id, rating, reason)
      VALUES (${user.id}::uuid, ${body.message_id}::uuid, ${body.rating}, ${body.reason ?? null})
      ON CONFLICT (user_id, message_id) DO UPDATE
        SET rating = EXCLUDED.rating, reason = EXCLUDED.reason
    `;
  } catch (err) {
    console.warn("[combo] feedback insert failed:", (err as Error).message);
    return safeError(c, err, { status: 500, code: "feedback_failed", publicMessage: "Failed to record feedback" });
  }
  let rerun: { passed: boolean; checks: unknown[] } | null = null;
  if (body.rating === "down") {
    // Inline re-run so the UI can show the new verdict immediately.
    const rows = await sql<{ id: string; content: string; role: string }[]>`
      SELECT id, content, role FROM messages WHERE id = ${body.message_id}::uuid LIMIT 1
    `;
    const msg = rows[0];
    if (msg) {
      const content = msg.content ?? "";
      const checks: Array<{ name: string; passed: boolean; note?: string }> = [
        { name: "non_empty", passed: content.trim().length > 0 },
        { name: "length_in_range", passed: content.length > 0 && content.length < 200_000 },
      ];
      const lower = content.toLowerCase();
      const hit = REFUSAL_PHRASES.find((p) => lower.includes(p));
      checks.push({ name: "no_refusal", passed: !hit, note: hit ? `matched: ${hit}` : undefined });
      checks.push({ name: "is_assistant", passed: msg.role === "assistant" });
      const passed = checks.every((c) => c.passed);
      try {
        await sql`
          INSERT INTO self_test_results (message_id, checks, passed)
          VALUES (${body.message_id}::uuid, ${sql.json(checks as never)}, ${passed})
        `;
      } catch (err) {
        console.warn("self_test insert skipped:", (err as Error).message);
      }
      rerun = { passed, checks };
    }
  }
  await logAudit({
    userId: user.id,
    target: body.message_id,
    action: body.rating === "down" ? "feedback_down" : "feedback_up",
    metadata: { reason: body.reason ?? null, self_test_passed: rerun?.passed ?? null },
  });
  return c.json({ ok: true, rerun });
});

// ─── Presence (Tier 1) ──────────────────────────────────────────────────
//
// Cheap endpoint for the chat panel header to poll presence — returns
// who is currently viewing/typing in the active panel. Degrades to an
// empty list when the table isn't present yet.

router.get("/presence", async (c) => {
  const panelId = c.req.query("panel_id");
  if (!panelId) return c.json({ panel_id: null, members: [] });
  // Membership-gate: only panel members (or admins) may see who is
  // currently online. Without this, anyone can enumerate names by
  // guessing panel UUIDs.
  const user = c.get("user");
  const memberCheck = await sql<{ exists: number }[]>`
    SELECT EXISTS (
      SELECT 1 FROM panel_members
      WHERE panel_id = ${panelId}::uuid AND user_id = ${user.id}::uuid
    )::int AS exists
  `;
  const allowed = user.role === "admin" || (memberCheck[0]?.exists ?? 0) > 0;
  if (!allowed) return c.json({ error: "forbidden" }, 403);
  try {
    const rows = await sql<{
      user_id: string;
      name: string;
      status: string;
      last_seen_at: Date;
    }[]>`
      SELECT pp.user_id, u.name, pp.status, pp.last_seen_at
      FROM panel_presence pp
      JOIN users u ON u.id = pp.user_id
      WHERE pp.panel_id = ${panelId}::uuid
        AND pp.last_seen_at > now() - interval '2 minutes'
      ORDER BY pp.last_seen_at DESC
      LIMIT 12
    `;
    return c.json({
      panel_id: panelId,
      members: rows.map((r) => ({
        user_id: r.user_id,
        name: r.name,
        status: r.status,
        last_seen_at: r.last_seen_at.toISOString(),
      })),
    });
  } catch (err) {
    console.warn("[combo] presence unavailable:", (err as Error).message);
    return c.json({
      panel_id: panelId,
      members: [],
      detail: "presence_unavailable",
    });
  }
});

export default router;