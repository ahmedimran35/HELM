// Swarm Lab routes (experimental, admin-only).
//
// POST /run  — one swarm run as an SSE stream (see lib/swarm/events.ts
//              for the event protocol). A run = N models (2-10) answer
//              one question in debate rounds, then a synthesizer call
//              merges everything. Tight rate limit: 6 runs/hour/user —
//              a single run fans out to dozens of provider calls.
// GET  /runs — last 20 runs for the current user (history strip).

import { Hono } from "hono";
import { streamSSE, type SSEStreamingApi } from "hono/streaming";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAdmin } from "../middleware/role.ts";
import { rateLimit } from "../middleware/ratelimit.ts";
import { logAudit } from "../lib/audit.ts";
import { rawConsole } from "../lib/log.ts";
import { startHeartbeat } from "../lib/chat/stream.ts";
import { runSwarm, type SwarmModel } from "../lib/swarm/orchestrator.ts";
import type { SwarmEvent } from "../lib/swarm/events.ts";
import type { HarnessKind } from "../harness/types.ts";
import { isHarnessKind } from "../harness/types.ts";

const router = new Hono();

router.use("*", requireAuth, requireAdmin);

const MAX_QUESTION = 8_000;
const MIN_MODELS = 2;
const MAX_MODELS = 10;

/** Harness kind for a provider row — swarm calls go through the
 *  singleton harnesses (governance + failover), not raw adapters. */
function harnessForProviderType(type: string): HarnessKind {
  if (type === "anthropic") return "anthropic";
  if (type === "mock") return "mock";
  return "openai"; // openai, nvidia-nim, openai-compatible
}

router.post("/run", rateLimit({ limit: 20, windowMs: 3_600_000, scope: "user" }), async (c) => {
  const user = c.get("user")!;
  const body = await c.req.json().catch(() => null);
  if (!body || typeof body !== "object") {
    return c.json({ error: "invalid_body" }, 400);
  }

  const question = String((body as { question?: unknown }).question ?? "").trim();
  if (question.length === 0 || question.length > MAX_QUESTION) {
    return c.json({ error: "question_length", max: MAX_QUESTION }, 400);
  }

  const rawIds = (body as { model_ids?: unknown }).model_ids;
  if (!Array.isArray(rawIds)) return c.json({ error: "model_ids_required" }, 400);
  const modelIds = [...new Set(rawIds.map(String))].filter((id) =>
    /^[0-9a-f-]{36}$/i.test(id),
  );
  if (modelIds.length < MIN_MODELS || modelIds.length > MAX_MODELS) {
    return c.json(
      { error: "model_count", min: MIN_MODELS, max: MAX_MODELS },
      400,
    );
  }

  const searchEnabled = Boolean((body as { force_web_search?: unknown }).force_web_search);

  // Load the requested models (active only) + their provider type so we
  // can pick the harness kind per model.
  const rows = await sql<{
    id: string;
    external_id: string;
    display_name: string;
    provider_type: string;
  }[]>`
    SELECT m.id, m.external_id, m.display_name, p.type AS provider_type
    FROM models m JOIN providers p ON p.id = m.provider_id
    WHERE m.state = 'active' AND m.id = ANY(${modelIds}::uuid[])
  `;
  if (rows.length !== modelIds.length) {
    return c.json({ error: "model_not_found" }, 404);
  }
  // Preserve the caller's order.
  const byId = new Map(rows.map((r) => [r.id, r]));
  const models: SwarmModel[] = modelIds.map((id) => {
    const r = byId.get(id)!;
    return {
      model_id: r.id,
      external_id: r.external_id,
      label: r.display_name,
      harness: isHarnessKind(harnessForProviderType(r.provider_type))
        ? harnessForProviderType(r.provider_type)
        : "openai",
    };
  });

  // Abort when the client disconnects (Stop button / tab close).
  const clientSignal = c.req.raw.signal;

  return streamSSE(c, async (stream) => {
    // Watchdog: when the client goes away mid-run (Stop click already
    // aborts the server signal via c.req.raw.signal, but a tab close or
    // network drop doesn't always fire it), the heartbeat write fails
    // — abort the orchestrator so we stop burning provider calls.
    const clientGone = new AbortController();
    const abortOnDead = () => clientGone.abort();
    const stopHeartbeat = startHeartbeat(stream, 15_000, abortOnDead);
    const runSignal = clientSignal.aborted ? clientSignal : clientGone.signal;
    // Events are queued by the orchestrator and drained in order. The
    // drain loop yields to a microtask/idle sleep so we don't spin, and
    // a final flush after the run settles guarantees no event is lost.
    const queue: SwarmEvent[] = [];
    const emit = (e: SwarmEvent) => {
      queue.push(e);
    };
    const flush = async () => {
      while (queue.length > 0) {
        const e = queue.shift()!;
        await stream.writeSSE({ data: JSON.stringify(e) });
      }
    };
    const settle = () => new Promise((r) => setTimeout(r, 25));

    try {
      const runPromise = runSwarm(
        { userId: user.id, question, models, searchEnabled, signal: runSignal },
        emit,
      ).then(
        (r) => r,
        (err) => {
          throw err;
        },
      );
      let result: Awaited<ReturnType<typeof runSwarm>> | undefined;
      let error: unknown;
      runPromise.then((r) => (result = r), (e) => (error = e));
      while (result === undefined && error === undefined) {
        await flush();
        await settle();
      }
      await flush();

      if (error !== undefined) throw error;
      await logAudit({
        userId: user.id,
        target: "swarm",
        action: "swarm_run",
        metadata: {
          run_id: result?.runId ?? "",
          status: result?.status ?? "completed",
          models: models.length,
          rounds: result?.roundsCompleted ?? 0,
          degraded: result?.degraded ?? false,
        },
      });
    } catch (err) {
      rawConsole.error("[swarm] run failed:", (err as Error).message);
      try {
        await stream.writeSSE({
          data: JSON.stringify({ event: "error", message: (err as Error).message }),
        });
      } catch { /* stream already closed */ }
    } finally {
      stopHeartbeat();
    }
  });
});

router.get("/runs", async (c) => {
  const user = c.get("user")!;
  const runs = await sql<Record<string, unknown>[]>`
    SELECT id, question, status, models, rounds_completed, final_answer,
           search_sources, error, created_at, completed_at
    FROM swarm_runs
    WHERE user_id = ${user.id}::uuid
    ORDER BY created_at DESC
    LIMIT 20
  `;
  return c.json({ runs });
});

export default router;
