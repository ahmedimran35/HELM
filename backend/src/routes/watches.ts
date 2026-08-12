// Watches + Triggers — event-driven background work (docs §P4).
//
//   GET    /api/watches                list watches for current user
//   POST   /api/watches                create
//   PATCH  /api/watches/:id            toggle enabled / update config
//   DELETE /api/watches/:id
//   POST   /api/watches/:id/run        manual fire
//   GET    /api/watches/:id/runs       recent run history (limit 20)
//   POST   /api/webhooks/:watch_id     inbound HTTP webhook receiver
//   GET    /api/triggers               list triggers
//   POST   /api/triggers               create
//   PATCH  /api/triggers/:id           update
//   DELETE /api/triggers/:id
//
// The webhook receiver is intentionally unauthenticated (it lives at a
// per-watch URL with an optional `secret` enforced via bearer token).
// Each webhook fire also evaluates the user's triggers, so a single
// inbound can drive many downstream actions.

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { logAudit } from "../lib/audit.ts";
import { validate, validationErrorResponse } from "../lib/validate.ts";
import { isValidCron } from "../lib/cron.ts";
import {
  runWatch,
  evaluateTriggers,
  type WatchSource,
  type WatchAction,
  type PredicateOp,
} from "../lib/watches.ts";

const WATCH_SOURCES: readonly WatchSource[] = ["schedule", "webhook", "email", "file", "manual"];
const WATCH_ACTIONS: readonly WatchAction[] = ["panel_message", "http_post", "agent_run"];
const PREDICATE_OPS: readonly PredicateOp[] = ["eq", "neq", "gt", "lt", "contains", "exists"];

const router = new Hono();

// Auth sub-router for everything except the public webhook receiver
// (which uses bearer-secret auth, not session cookies). Note: we do NOT
// add `router.use("*", requireAuth)` here — that would intercept unmatched
// paths through this sub-router when it's mounted at the parent app's
// root (which we need to do for the webhook URL to be at /api/webhooks).
// Instead, each route below adds `requireAuth` in its own chain so
// only the matching routes are gated.
const authedRouter = new Hono();

// ----- Watches ------------------------------------------------------------
authedRouter.get("/watches", requireAuth, async (c) => {
  const user = c.get("user");
  const rows = await sql<{
    id: string;
    name: string;
    source: WatchSource;
    config: Record<string, unknown>;
    action: WatchAction;
    action_config: Record<string, unknown>;
    enabled: boolean;
    last_fired_at: Date | null;
    created_at: Date;
  }[]>`
    SELECT id, name, source, config, action, action_config, enabled,
           last_fired_at, created_at
    FROM watches
    WHERE user_id = ${user.id}::uuid
    ORDER BY created_at DESC
  `;
  return c.json(rows);
});

authedRouter.post("/watches", requireAuth, async (c) => {
  const user = c.get("user");
  let body: {
    name?: string;
    source?: WatchSource;
    config?: Record<string, unknown>;
    action?: WatchAction;
    action_config?: Record<string, unknown>;
    enabled?: boolean;
  };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      name: { type: "string", minLength: 1, maxLength: 120, trim: true },
      source: { type: "enum", values: WATCH_SOURCES },
      config: { type: "object", fields: {}, optional: true },
      action: { type: "enum", values: WATCH_ACTIONS },
      action_config: { type: "object", fields: {}, optional: true },
      enabled: { type: "boolean" },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (!body.name || !body.source || !body.action) {
    return c.json({ error: "name, source, action required" }, 400);
  }
  // Validate per-source config. Reject early so the user doesn't have
  // to discover a missing `cron` field at fire time.
  if (body.source === "schedule") {
    const cron = String((body.config ?? {})?.cron ?? "").trim();
    if (!cron || !isValidCron(cron)) {
      return c.json({ error: "schedule watch requires a valid cron expr in config.cron" }, 400);
    }
  }
  if (body.source === "webhook") {
    const path = String((body.config ?? {})?.path ?? "").trim();
    if (!path || !/^[a-zA-Z0-9_-]+$/.test(path)) {
      return c.json({ error: "webhook watch requires config.path (slug)" }, 400);
    }
    // Secrets are mandatory for webhook watches. Without one, anyone
    // who guesses the watch id can fire the trigger and run agent
    // prompts / panel posts / outbound HTTP as the user. 16-char
    // minimum gives enough entropy to resist URL-pasted / log-scrape
    // leaks. (The receiver at /api/webhooks/:watch_id enforces this
    // too — but enforcing at create time gives the user a clear
    // error before they wire anything to the URL.)
    const secret = String((body.config ?? {})?.secret ?? "").trim();
    if (secret.length < 16) {
      return c.json({ error: "webhook watch requires config.secret (≥16 chars)" }, 400);
    }
  }
  const rows = await sql<{ id: string }[]>`
    INSERT INTO watches (user_id, name, source, config, action, action_config, enabled)
    VALUES (
      ${user.id}::uuid,
      ${body.name},
      ${body.source},
      ${sql.json((body.config ?? {}) as never)},
      ${body.action},
      ${sql.json((body.action_config ?? {}) as never)},
      ${body.enabled ?? true}
    )
    RETURNING id
  `;
  await logAudit({
    userId: user.id,
    target: rows[0]!.id,
    action: "watch_created",
    metadata: { name: body.name, source: body.source, action: body.action },
  });
  return c.json({ id: rows[0]!.id });
});

authedRouter.patch("/watches/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  let body: {
    name?: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
    action_config?: Record<string, unknown>;
  };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      name: { type: "string", minLength: 1, maxLength: 120, trim: true },
      enabled: { type: "boolean" },
      config: { type: "object", fields: {}, optional: true },
      action_config: { type: "object", fields: {}, optional: true },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  // The DB doesn't have a generic PATCH helper, so each field is its
  // own conditional. Cheap because the row count is bounded per user.
  if (body.name !== undefined) {
    await sql`UPDATE watches SET name = ${body.name} WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid`;
  }
  if (body.enabled !== undefined) {
    await sql`UPDATE watches SET enabled = ${body.enabled} WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid`;
  }
  if (body.config !== undefined) {
    await sql`UPDATE watches SET config = ${sql.json(body.config as never)} WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid`;
  }
  if (body.action_config !== undefined) {
    await sql`UPDATE watches SET action_config = ${sql.json(body.action_config as never)} WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid`;
  }
  return c.json({ ok: true });
});

authedRouter.delete("/watches/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await sql`DELETE FROM watches WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid`;
  return c.json({ ok: true });
});

authedRouter.post("/watches/:id/run", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  // Make sure the watch belongs to the caller before we kick off
  // background work.
  const own = await sql<{ id: string }[]>`
    SELECT id FROM watches WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid LIMIT 1
  `;
  if (!own[0]) return c.json({ error: "not_found" }, 404);
  const result = await runWatch(id, { reason: "manual" });
  return c.json(result);
});

authedRouter.get("/watches/:id/runs", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  // Ownership-check the watch first so we don't leak run rows to other
  // users.
  const own = await sql<{ id: string }[]>`
    SELECT id FROM watches WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid LIMIT 1
  `;
  if (!own[0]) return c.json({ error: "not_found" }, 404);
  const rows = await sql<{
    id: string;
    watch_id: string | null;
    trigger_id: string | null;
    started_at: Date;
    finished_at: Date | null;
    status: "ok" | "error" | "skipped";
    message: string | null;
  }[]>`
    SELECT id, watch_id, trigger_id, started_at, finished_at, status, message
    FROM watch_runs
    WHERE watch_id = ${id}::uuid
    ORDER BY started_at DESC
    LIMIT 20
  `;
  return c.json(rows);
});

// ----- Webhook receiver ---------------------------------------------------
// Unauthenticated by design — the URL slug is the shared secret in
// addition to the optional `secret` bearer. Look up the watch by id
// (the URL path uses the watch id so the slug stays user-friendly
// only for the path-based matcher; the watch id is the real key).
router.post("/webhooks/:watch_id", async (c) => {
  const watchId = c.req.param("watch_id");
  const w = await sql<{
    id: string;
    user_id: string;
    enabled: boolean;
    source: string;
    config: Record<string, unknown>;
  }[]>`
    SELECT id, user_id, enabled, source, config
    FROM watches
    WHERE id = ${watchId}::uuid
    LIMIT 1
  `;
  const watch = w[0];
  if (!watch || watch.source !== "webhook" || !watch.enabled) {
    return c.json({ error: "not_found" }, 404);
  }
  // Webhook secrets are now MANDATORY. Creating a webhook without a
  // secret leaves the trigger callable by anyone who guesses the watch
  // id, which then runs agent prompts / panel posts / outbound HTTP
  // as the user. Watch creation at /api/watches POST validates that
  // the secret is set + ≥16 chars; this server enforces the check.
  const cfgSecret = String(watch.config?.secret ?? "").trim();
  if (cfgSecret.length < 16) {
    return c.json({ error: "webhook_missing_secret" }, 412);
  }
  // Constant-time bearer comparison — never log the secret.
  const auth = c.req.header("authorization") ?? "";
  const expected = `Bearer ${cfgSecret}`;
  const authBuf = Buffer.from(auth, "utf8");
  const expectedBuf = Buffer.from(expected, "utf8");
  let equal = authBuf.length === expectedBuf.length;
  if (equal) {
    // timingSafeEqual requires equal-length; this still walks every byte
    // so the timing reveals nothing about the value.
    // node:crypto.timingSafeEqual is the canonical primitive; bun supports it.
    const crypto = await import("node:crypto");
    equal = crypto.timingSafeEqual(authBuf, expectedBuf);
  }
  if (!equal) {
    return c.json({ error: "unauthorized" }, 401);
  }
  // Read the payload as JSON if we can, otherwise as text. Headers +
  // query string go into the payload too so triggers can match on them.
  let body: unknown = null;
  const ct = c.req.header("content-type") ?? "";
  if (ct.includes("application/json")) {
    body = await c.req.json().catch(() => null);
  } else {
    body = await c.req.text().catch(() => "");
  }
  const url = new URL(c.req.url);
  const payload: Record<string, unknown> = {
    body,
    headers: Object.fromEntries(c.req.raw.headers.entries()),
    query: Object.fromEntries(url.searchParams.entries()),
  };
  // Run the watch + walk the user's triggers in parallel — neither
  // depends on the other. We await both so we can return a coherent
  // summary to the webhook caller.
  const [watchRun, triggerResult] = await Promise.all([
    runWatch(watch.id, { reason: "webhook", payload }),
    evaluateTriggers(watch.user_id, payload),
  ]);
  await logAudit({
    userId: watch.user_id,
    target: watch.id,
    action: "webhook_received",
    metadata: { triggers_matched: triggerResult.matched, triggers_fired: triggerResult.fired },
  });
  return c.json({ ok: true, run_id: watchRun.run_id, triggers_fired: triggerResult.fired });
});

// ----- Triggers -----------------------------------------------------------
authedRouter.get("/triggers", requireAuth, async (c) => {
  const user = c.get("user");
  const rows = await sql<{
    id: string;
    name: string;
    when_clause: Array<{ op: string; path: string; value?: unknown }>;
    then_action: WatchAction;
    then_config: Record<string, unknown>;
    enabled: boolean;
    created_at: Date;
  }[]>`
    SELECT id, name, when_clause, then_action, then_config, enabled, created_at
    FROM triggers
    WHERE user_id = ${user.id}::uuid
    ORDER BY created_at DESC
  `;
  return c.json(rows);
});

authedRouter.post("/triggers", requireAuth, async (c) => {
  const user = c.get("user");
  let body: {
    name?: string;
    when_clause?: Array<{ op?: PredicateOp; path?: string; value?: unknown }>;
    then_action?: WatchAction;
    then_config?: Record<string, unknown>;
    enabled?: boolean;
  };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      name: { type: "string", minLength: 1, maxLength: 120, trim: true },
      then_action: { type: "enum", values: WATCH_ACTIONS },
      then_config: { type: "object", fields: {}, optional: true },
      enabled: { type: "boolean" },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (!body.name || !body.then_action) {
    return c.json({ error: "name and then_action required" }, 400);
  }
  const clause = Array.isArray(body.when_clause) ? body.when_clause : [];
  for (const p of clause) {
    if (!p || typeof p !== "object" || !p.op || !PREDICATE_OPS.includes(p.op) || typeof p.path !== "string") {
      return c.json({ error: "when_clause must be {op, path, value?}" }, 400);
    }
  }
  const rows = await sql<{ id: string }[]>`
    INSERT INTO triggers (user_id, name, when_clause, then_action, then_config, enabled)
    VALUES (
      ${user.id}::uuid,
      ${body.name},
      ${sql.json(clause as never)},
      ${body.then_action},
      ${sql.json((body.then_config ?? {}) as never)},
      ${body.enabled ?? true}
    )
    RETURNING id
  `;
  await logAudit({
    userId: user.id,
    target: rows[0]!.id,
    action: "trigger_created",
    metadata: { name: body.name, then_action: body.then_action },
  });
  return c.json({ id: rows[0]!.id });
});

authedRouter.patch("/triggers/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  let body: {
    name?: string;
    enabled?: boolean;
    when_clause?: Array<{ op?: PredicateOp; path?: string; value?: unknown }>;
    then_config?: Record<string, unknown>;
  };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      name: { type: "string", minLength: 1, maxLength: 120, trim: true },
      enabled: { type: "boolean" },
      then_config: { type: "object", fields: {}, optional: true },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (body.name !== undefined) {
    await sql`UPDATE triggers SET name = ${body.name} WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid`;
  }
  if (body.enabled !== undefined) {
    await sql`UPDATE triggers SET enabled = ${body.enabled} WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid`;
  }
  if (body.when_clause !== undefined) {
    for (const p of body.when_clause) {
      if (!p || typeof p !== "object" || !p.op || !PREDICATE_OPS.includes(p.op) || typeof p.path !== "string") {
        return c.json({ error: "when_clause must be {op, path, value?}" }, 400);
      }
    }
    await sql`UPDATE triggers SET when_clause = ${sql.json(body.when_clause as never)} WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid`;
  }
  if (body.then_config !== undefined) {
    await sql`UPDATE triggers SET then_config = ${sql.json(body.then_config as never)} WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid`;
  }
  return c.json({ ok: true });
});

authedRouter.delete("/triggers/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await sql`DELETE FROM triggers WHERE id = ${id}::uuid AND user_id = ${user.id}::uuid`;
  return c.json({ ok: true });
});

// Merge authed sub-router so every /watches + /triggers endpoint runs
// under requireAuth. The /webhooks/:watch_id receiver stays public
// (it uses bearer-secret auth, not session cookies).
router.route("/", authedRouter);

export default router;
