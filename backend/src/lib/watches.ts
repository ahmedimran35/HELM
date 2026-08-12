// Watches + Triggers — event-driven background work (docs §P4).
//
// Watches are user-defined "fire when X" rules. Triggers are
// if-X-then-do-Y rules that can be layered on top of any watch
// payload. The scheduler walks enabled schedule-watches every minute
// and fires the ones whose cron expr matches the current wall-clock
// minute; webhooks + manual runs are dispatched synchronously by the
// HTTP layer.
//
// Execution is fire-and-forget (Bun.spawn for HTTP, awaited for
// agent_run so we can capture token counts). The HTTP request that
// kicked off the work responds immediately with the watch_runs id;
// the worker writes back to that row with status + message when it
// finishes.
//
// Trigger predicate language is intentionally tiny:
//   { op, path, value }
//     op     ∈ eq | neq | gt | lt | contains | exists
//     path   dot-path into the payload (e.g. "headers.x-event")
//     value  any JSON-serialisable scalar
// An empty array `[]` matches every payload.

import { sql } from "../db/client.ts";
import { logAudit } from "./audit.ts";
import { computeNextRun } from "./cron.ts";
import { getProviderById, buildAdapter } from "../providers/registry.ts";
import { assertSafeOutboundUrl, safeFetch } from "./safe-fetch.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type WatchSource = "schedule" | "webhook" | "email" | "file" | "manual";
export type WatchAction = "panel_message" | "http_post" | "agent_run";

export interface WatchRow {
  id: string;
  user_id: string;
  name: string;
  source: WatchSource;
  config: Record<string, unknown>;
  action: WatchAction;
  action_config: Record<string, unknown>;
  enabled: boolean;
  last_fired_at: Date | null;
  created_at: Date;
}

export type PredicateOp = "eq" | "neq" | "gt" | "lt" | "contains" | "exists";

export interface Predicate {
  op: PredicateOp;
  path: string;
  value?: unknown;
}

export interface TriggerRow {
  id: string;
  user_id: string;
  name: string;
  when_clause: Predicate[];
  then_action: WatchAction;
  then_config: Record<string, unknown>;
  enabled: boolean;
  created_at: Date;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

/** How often the scheduler ticks (in ms). One minute is fine — cron exprs
 *  are minute-grained anyway, and a faster loop would just hammer the DB. */
const TICK_MS = 30_000;

let schedulerHandle: ReturnType<typeof setInterval> | null = null;
let schedulerRunning = false;

/** Boot-time entry point. Called from index.ts after migrations + auth
 *  bootstrap complete. Idempotent — calling twice is a no-op. */
export function startWatchScheduler(): void {
  if (schedulerHandle) return;
  // Tick once immediately so a server restart fires any minute that
  // would otherwise be missed (e.g. the watch was due while we were
  // offline). Subsequent ticks keep the cadence honest.
  void tick();
  schedulerHandle = setInterval(() => void tick(), TICK_MS);
  console.log("✓ watch scheduler started (tick =", TICK_MS, "ms)");
}

export function stopWatchScheduler(): void {
  if (schedulerHandle) {
    clearInterval(schedulerHandle);
    schedulerHandle = null;
  }
}

async function tick(): Promise<void> {
  if (schedulerRunning) return;
  schedulerRunning = true;
  try {
    // Load every enabled schedule-watch. For each one compute the
    // next run. If `next_run_at` (i.e. the *scheduled* next run we
    // previously computed) is in the past or null, fire now.
    const rows = await sql<WatchRow[]>`
      SELECT id, user_id, name, source, config, action, action_config,
             enabled, last_fired_at, created_at
      FROM watches
      WHERE enabled = TRUE AND source = 'schedule'
    `;
    if (rows.length === 0) return;
    const now = Date.now();
    for (const w of rows) {
      const expr = String((w.config as { cron?: string })?.cron ?? "").trim();
      if (!expr) continue;
      const next = computeNextRun(expr, new Date(now));
      if (!next) continue;
      const last = w.last_fired_at ? w.last_fired_at.getTime() : 0;
      // We use last_fired_at as the proxy for "last time we actually ran
      // this"; if it's missing or older than the previous boundary, fire.
      // Using the cron expr's previous fire boundary would be more
      // accurate; this is good enough for minute-granularity.
      const previousBoundary = computeNextRun(expr, new Date(now - 60_000));
      if (!previousBoundary) continue;
      if (last < previousBoundary.getTime()) {
        // Fire-and-forget — don't block the tick.
        void runWatch(w.id, { reason: "schedule" });
      }
    }
  } catch (err) {
    console.warn("watch scheduler tick failed:", (err as Error).message);
  } finally {
    schedulerRunning = false;
  }
}

// ---------------------------------------------------------------------------
// Single execution
// ---------------------------------------------------------------------------

export interface RunOptions {
  reason?: "manual" | "schedule" | "webhook" | "trigger";
  payload?: Record<string, unknown>;
  triggerId?: string;
}

/** Fire a single watch and persist a `watch_runs` row. The function
 *  returns immediately with the run id; the action itself runs in the
 *  background. Errors inside the action are caught and recorded as
 *  watch_runs.status='error' + message. */
export async function runWatch(
  watchId: string,
  opts: RunOptions = {},
): Promise<{ run_id: string; status: "ok" | "skipped" }> {
  const w = await sql<WatchRow[]>`
    SELECT id, user_id, name, source, config, action, action_config,
           enabled, last_fired_at, created_at
    FROM watches
    WHERE id = ${watchId}::uuid
    LIMIT 1
  `;
  const watch = w[0];
  if (!watch) throw new Error("watch not found");
  if (!watch.enabled && opts.reason !== "manual") {
    // Manual runs from the UI always execute; scheduled + webhook
    // runs respect enabled.
    return { run_id: "", status: "skipped" };
  }
  const runRows = await sql<{ id: string }[]>`
    INSERT INTO watch_runs (watch_id, trigger_id, user_id, status, message)
    VALUES (${watch.id}::uuid, ${opts.triggerId ?? null}::uuid,
            ${watch.user_id}::uuid, 'ok',
            ${opts.reason ?? "manual"})
    RETURNING id
  `;
  const runId = runRows[0]!.id;
  // Kick off the action without awaiting — the API responds as soon
  // as the run row is committed. The background path updates the row
  // when it finishes.
  void executeAction(watch, runId, opts).catch((err) => {
    console.warn("watch action failed:", (err as Error).message);
  });
  return { run_id: runId, status: "ok" };
}

async function executeAction(
  watch: WatchRow,
  runId: string,
  opts: RunOptions,
): Promise<void> {
  let status: "ok" | "error" = "ok";
  let message = "";
  try {
    const result = await dispatchAction(
      watch.user_id,
      watch.action,
      watch.action_config as Record<string, unknown>,
      {
        watch_id: watch.id,
        watch_name: watch.name,
        reason: opts.reason ?? "manual",
        payload: opts.payload ?? {},
      },
    );
    message = result;
  } catch (err) {
    status = "error";
    message = (err as Error).message;
  }
  await sql`
    UPDATE watch_runs
    SET finished_at = now(),
        status = ${status},
        message = ${message.slice(0, 4000)}
    WHERE id = ${runId}::uuid
  `;
  await sql`
    UPDATE watches SET last_fired_at = now() WHERE id = ${watch.id}::uuid
  `;
  await logAudit({
    userId: watch.user_id,
    target: watch.id,
    action: "watch_fired",
    metadata: { action: watch.action, status, reason: opts.reason ?? "manual" },
  });
}

// ---------------------------------------------------------------------------
// Action dispatch
// ---------------------------------------------------------------------------

/** Route a fired action to the correct sink. Each branch builds the
 *  payload it needs from the watch row + the firing context. */
async function dispatchAction(
  userId: string,
  action: WatchAction,
  cfg: Record<string, unknown>,
  ctx: {
    watch_id: string;
    watch_name: string;
    reason: string;
    payload: Record<string, unknown>;
  },
): Promise<string> {
  if (action === "panel_message") {
    const panelId = String(cfg.panel_id ?? "").trim();
    const contentTemplate = String(cfg.content ?? "");
    if (!panelId) throw new Error("panel_message requires action_config.panel_id");
    // Membership check — without this, any user with a `panel_message`
    // watch could post attacker-controlled text into any other user's
    // panel by guessing the UUID.
    const isAdmin = (ctx as { isAdmin?: boolean }).isAdmin === true;
    if (!isAdmin) {
      const member = await sql<{ exists: number }[]>`
        SELECT EXISTS (
          SELECT 1 FROM panel_members
          WHERE panel_id = ${panelId}::uuid AND user_id = ${userId}::uuid
        )::int AS exists
      `;
      if ((member[0]?.exists ?? 0) === 0) {
        throw new Error("panel_message: not a member of the target panel");
      }
    }
    const content = renderTemplate(contentTemplate, ctx);
    const rows = await sql<{ id: string }[]>`
      INSERT INTO messages (panel_id, user_id, role, content, tokens)
      VALUES (${panelId}::uuid, ${userId}::uuid, 'user', ${content}, 0)
      RETURNING id
    `;
    return `posted message ${rows[0]!.id} to panel ${panelId}`;
  }
  if (action === "http_post") {
    const url = String(cfg.url ?? "").trim();
    if (!url) throw new Error("http_post requires action_config.url");
    // SSRF guard — resolve DNS, reject private/loopback/metadata IPs,
    // user-supplied URLs must use 80/443.
    await assertSafeOutboundUrl(url, { allowLocal: false });
    const body = renderTemplate(JSON.stringify(cfg.body ?? ctx), ctx);
    // Use safeFetch (with a 5 MB response cap) instead of raw curl
    // streaming. Without a cap, a malicious target URL can return
    // gigabytes of body, OOMing the runner. safeFetch also disables
    // redirect-following (a 30x on a private IP would pivot past
    // assertSafeOutboundUrl).
    const res = await safeFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
      maxBytes: 5 * 1024 * 1024,
    });
    if (!res.ok) {
      throw new Error(`http_post failed: status=${res.status}`);
    }
    return `POST ${url} → ${res.status}`;
  }
  if (action === "agent_run") {
    const promptTemplate = String(cfg.prompt ?? "");
    const modelId = typeof cfg.model_id === "string" ? cfg.model_id : null;
    const prompt = renderTemplate(promptTemplate, ctx);
    if (!prompt) throw new Error("agent_run requires action_config.prompt");
    return await runAgent(userId, modelId, prompt, {
      isAdmin: (ctx as { isAdmin?: boolean }).isAdmin === true,
    });
  }
  throw new Error(`unknown action: ${action}`);
}

/** Substitute `{{watch.name}}`, `{{payload.foo}}`, `{{reason}}` style
 *  tokens. Unknown tokens are left intact so the user notices them. */
function renderTemplate(
  template: string,
  ctx: { watch_name: string; reason: string; payload: Record<string, unknown> },
): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, expr: string) => {
    const path = expr.trim();
    if (path === "watch.name") return ctx.watch_name;
    if (path === "reason") return ctx.reason;
    if (path.startsWith("payload.")) {
      const key = path.slice("payload.".length);
      const v = getByPath(ctx.payload, key);
      if (v === undefined) return "";
      if (typeof v === "string") return v;
      try { return JSON.stringify(v); } catch { return String(v); }
    }
    return `{{${path}}}`;
  });
}

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

async function runAgent(
  userId: string,
  modelId: string | null,
  prompt: string,
  ctx: { isAdmin?: boolean } = {},
): Promise<string> {
  // Resolve the model. Prefer the explicit one from action_config;
  // otherwise fall back to the user's first assigned model.
  let resolvedModelId = modelId;
  if (!resolvedModelId) {
    const fallback = await sql<{ id: string }[]>`
      SELECT m.id FROM model_access ma
      JOIN models m ON m.id = ma.model_id
      WHERE ma.user_id = ${userId}::uuid AND m.state = 'active'
      ORDER BY ma.granted_at ASC LIMIT 1
    `;
    resolvedModelId = fallback[0]?.id ?? null;
  } else if (!ctx.isAdmin) {
    // Explicit model_id supplied by the watch author — verify the
    // owner has access. Without this, a watch persisted with an
    // admin-only model_id would still let a non-admin trigger the
    // model after their grant is revoked. We also look up the owner's
    // role to allow admins to bypass (they don't need model_access
    // rows for the models they themselves created).
    const owner = await sql<{ role: string }[]>`
      SELECT role FROM users WHERE id = ${userId}::uuid LIMIT 1
    `;
    if (owner[0]?.role !== "admin") {
      const access = await sql<{ ok: number }[]>`
        SELECT EXISTS (
          SELECT 1 FROM model_access
          WHERE user_id = ${userId}::uuid AND model_id = ${modelId}::uuid
        )::int AS ok
      `;
      if ((access[0]?.ok ?? 0) === 0) {
        throw new Error(
          "agent_run: watch owner is not authorized for the configured model_id",
        );
      }
    }
  }
  if (!resolvedModelId) {
    throw new Error("agent_run: no model assigned and no model_id in action_config");
  }
  const modelRows = await sql<{
    external_id: string;
    display_name: string;
    provider_id: string;
  }[]>`
    SELECT external_id, display_name, provider_id
    FROM models WHERE id = ${resolvedModelId}::uuid LIMIT 1
  `;
  const model = modelRows[0];
  if (!model) throw new Error("agent_run: model not found");
  const provider = await getProviderById(model.provider_id);
  if (!provider) throw new Error("agent_run: provider not found");
  const adapter = await buildAdapter(provider, { allowLocal: true });
  let assembled = "";
  for await (const chunk of adapter.chat({
    model: model.external_id,
    messages: [
      { role: "system", content: "You are HELM. Be concise." },
      { role: "user", content: prompt },
    ],
    maxTokens: 1024,
  })) {
    if (chunk.delta) assembled += chunk.delta;
  }
  // Persist the agent's reply into the user's 1:1 chat thread so it
  // shows up in their history.
  await sql`
    INSERT INTO messages (user_id, model_id, role, content, tokens)
    VALUES (${userId}::uuid, ${resolvedModelId}::uuid, 'assistant',
            ${assembled.slice(0, 4000)}, ${Math.ceil(assembled.length / 4)})
  `;
  await logAudit({
    userId,
    target: resolvedModelId,
    action: "watch_agent_run",
    metadata: { prompt_len: prompt.length, reply_len: assembled.length },
  });
  return `agent_run on ${model.display_name}: ${assembled.length} chars`;
}

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

/** Walk all enabled triggers for `userId`. For each one whose predicate
 *  matches the payload, fire its action as a synthetic watch run. */
export async function evaluateTriggers(
  userId: string,
  payload: Record<string, unknown>,
): Promise<{ matched: number; fired: number }> {
  const triggers = await sql<TriggerRow[]>`
    SELECT id, user_id, name, when_clause, then_action, then_config,
           enabled, created_at
    FROM triggers
    WHERE user_id = ${userId}::uuid AND enabled = TRUE
  `;
  let fired = 0;
  for (const t of triggers) {
    if (!matchPredicate(t.when_clause, payload)) continue;
    const runRows = await sql<{ id: string }[]>`
      INSERT INTO watch_runs (trigger_id, user_id, status, message)
      VALUES (${t.id}::uuid, ${userId}::uuid, 'ok', 'trigger matched')
      RETURNING id
    `;
    const runId = runRows[0]!.id;
    try {
      const result = await dispatchAction(
        userId,
        t.then_action,
        t.then_config as Record<string, unknown>,
        {
          watch_id: t.id,
          watch_name: t.name,
          reason: "trigger",
          payload,
        },
      );
      await sql`
        UPDATE watch_runs
        SET finished_at = now(), status = 'ok', message = ${result.slice(0, 4000)}
        WHERE id = ${runId}::uuid
      `;
      fired++;
    } catch (err) {
      await sql`
        UPDATE watch_runs
        SET finished_at = now(), status = 'error', message = ${(err as Error).message.slice(0, 4000)}
        WHERE id = ${runId}::uuid
      `;
    }
  }
  return { matched: triggers.length, fired };
}

export function matchPredicate(
  clause: Predicate[],
  payload: Record<string, unknown>,
): boolean {
  if (!Array.isArray(clause) || clause.length === 0) return true;
  for (const p of clause) {
    const lhs = getByPath(payload, p.path);
    switch (p.op) {
      case "exists": {
        if (lhs === undefined) return false;
        continue;
      }
      case "eq": {
        if (!eq(lhs, p.value)) return false;
        continue;
      }
      case "neq": {
        if (eq(lhs, p.value)) return false;
        continue;
      }
      case "gt": {
        if (typeof lhs !== "number" || typeof p.value !== "number") return false;
        if (!(lhs > p.value)) return false;
        continue;
      }
      case "lt": {
        if (typeof lhs !== "number" || typeof p.value !== "number") return false;
        if (!(lhs < p.value)) return false;
        continue;
      }
      case "contains": {
        if (typeof lhs !== "string" || typeof p.value !== "string") return false;
        if (!lhs.includes(p.value)) return false;
        continue;
      }
      default:
        return false;
    }
  }
  return true;
}

function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") {
    return a === b;
  }
  return JSON.stringify(a) === JSON.stringify(b);
}
