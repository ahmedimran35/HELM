// 1:1 chat with streaming (docs §2.2). User sends a message to a model
// they've been granted access to, and we stream the model's reply back
// token-by-token via Server-Sent Events.
//
// This file is the thin route handler — the real work lives in:
//   - lib/chat/quota.ts       : monthly message quota enforcement
//   - lib/chat/cache.ts       : 1:1 chat-specific cache wrappers
//   - lib/chat/context.ts     : RAG + memory + web-search assembly
//   - lib/chat/search-prompt.ts: MANDATORY reply-shape + intent rules
//   - lib/chat/persist.ts     : assistant message + citations + post-turn
//   - lib/chat/sources-only.ts: sources-only re-query fallback
//   - lib/chat/stream.ts      : SSE event helpers + chunked consumption
//
// Quota enforcement (docs §2.6): if the user has a quota with a
// message_limit set, we increment-and-check atomically. If the limit is
// reached, we return 429 BEFORE issuing the upstream call.
// Budget enforcement is best-effort (we record tokens after the call
// finishes; alerting-only, not a hard block, per docs §2.6 wording).

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { logAudit } from "../lib/audit.ts";
import { streamSSE } from "hono/streaming";
import { validate, validationErrorResponse } from "../lib/validate.ts";
import { getHarnessByKind } from "../harness/router.ts";
import { isHarnessKind, type HarnessKind, type HarnessMessage } from "../harness/types.ts";
import { pickModel } from "../lib/model-router.ts";
import { withFailover } from "../lib/health-check.ts";
import { enforceUserMessageQuota } from "../lib/chat/quota.ts";
import { composeSystemPrompt } from "../lib/chat/system-prompt.ts";
import { lookupCached } from "../lib/chat/cache.ts";
import {
  buildSearchSystemPrompt,
  type SearchPromptInputs,
} from "../lib/chat/search-prompt.ts";
import {
  persistAssistantMessage,
  persistCitations,
  extractCitations,
  runPostTurnBookkeeping,
  recordFailedTurn,
} from "../lib/chat/persist.ts";
import {
  refetchIfSourcesOnly,
  isSourcesOnlyResponse,
} from "../lib/chat/sources-only.ts";
import {
  writeCached,
  writeDone,
  writeError,
  writeSearchSummary,
  startHeartbeat,
  replayCachedTokens,
  consumeStreamToSSE,
} from "../lib/chat/stream.ts";
import { assembleRetrievedContext } from "../lib/chat/context.ts";

// Re-exported for ws.ts panel chat so it can enforce the same monthly
// quota the HTTP /api/chat route enforces. See lib/chat/quota.ts for the
// race-condition rationale (the user-message insert + count must be a
// single transaction with an advisory lock keyed on the user id).
export { enforceUserMessageQuota } from "../lib/chat/quota.ts";

const router = new Hono();
router.use("*", requireAuth);

interface ModelRow {
  id: string;
  external_id: string;
  display_name: string;
  provider_id: string;
  state: string;
}

async function loadActiveModel(modelId: string): Promise<ModelRow | undefined> {
  const rows = await sql<ModelRow[]>`
    SELECT id, external_id, display_name, provider_id, state
    FROM models
    WHERE id = ${modelId}::uuid AND state = 'active'
    LIMIT 1
  `;
  return rows[0];
}

router.post("/", async (c) => {
  const user = c.get("user");
  let body: {
    model_id?: string;
    content?: string;
    system?: string;
    force_web_search?: boolean;
    url?: string;
    harness?: string;
  };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      model_id: { type: "uuid" },
      content: { type: "string", minLength: 1, maxLength: 32000, trim: true },
      system: { type: "string", minLength: 1, maxLength: 8000 },
      force_web_search: { type: "boolean" },
      url: { type: "string", minLength: 1, maxLength: 500 },
      harness: { type: "enum", values: ["openai", "anthropic", "mock", "pi", "cli"] },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (!body.model_id || !body.content) {
    return c.json({ error: "model_id and content required" }, 400);
  }
  const modelId = body.model_id;
  const content = body.content;
  // Harness routing — default to 'openai' so legacy clients keep working.
  // The harness picks the runtime (OpenAI-compat vs Anthropic vs the
  // future Pi/CLI seams). We always run through the harness abstraction
  // so harness_runs captures every invocation, even the openai one.
  const harnessKind: HarnessKind = isHarnessKind(body.harness ?? "")
    ? (body.harness as HarnessKind)
    : "openai";

  // Access check (admins skip — they have implicit access to everything).
  if (user.role !== "admin") {
    const access = await sql<{ model_id: string }[]>`
      SELECT model_id FROM model_access
      WHERE user_id = ${user.id}::uuid AND model_id = ${modelId}::uuid LIMIT 1
    `;
    if (!access[0]) {
      return c.json({ error: "no_access" }, 403);
    }
  }

  // Quota check + user message INSERT are atomic in a single
  // transaction (see lib/chat/quota.ts for the why).
  const quota = await enforceUserMessageQuota(user.id, content, { modelId });
  if (!quota.ok) {
    return c.json({ error: "quota_exceeded" }, 429);
  }

  const model = await loadActiveModel(modelId);
  if (!model) return c.json({ error: "model_not_found" }, 404);

  // Tier 5 — cost-aware model router. Pick a model based on the
  // user's `model_router_policies` row. When the router returns a
  // different model, swap `model` + `modelId` so the rest of the
  // handler writes to the chosen model row. The original requested
  // model is recorded as the audit target for traceability.
  const requestedModelId = modelId;
  const routerDecision = await pickModel({
    userId: user.id,
    isAdmin: user.role === "admin",
    panelId: null,
    originalModelId: modelId,
    prompt: content,
    requestedHarness: isHarnessKind(harnessKind) ? harnessKind : null,
  }).catch((err) => {
    console.warn("[chat] model-router failed:", (err as Error).message);
    return null;
  });
  let activeModelId = modelId;
  let activeModel = model;
  let activeHarnessKind = harnessKind;
  if (routerDecision && routerDecision.modelId !== model.id) {
    const swap = await loadActiveModel(routerDecision.modelId);
    if (swap) {
      activeModelId = swap.id;
      activeModel = swap;
      activeHarnessKind = routerDecision.harnessKind;
      void logAudit({
        userId: user.id,
        target: swap.id,
        action: "model_router_swap",
        metadata: {
          requested: requestedModelId,
          chosen: swap.id,
          reason: routerDecision.reason,
          preference_index: routerDecision.preferenceIndex ?? null,
        },
      });
    }
  }

  // Tier 5 — response cache short-circuit. Exact-match on the user's
  // content (sha256 of normalised query + scope) returns the cached
  // response without touching the harness. The hit_count + last_hit_at
  // are updated fire-and-forget inside lookupCached(). We scope by
  // user id (the 1:1 chat has no panel) so two users asking the same
  // question can't share a cached reply.
  //
  // The user can bypass the cache with `?refresh=1` (sent from the
  // chat UI when they click Refresh). The bypass is per-request and
  // doesn't touch the stored row — subsequent identical queries can
  // still hit the cache.
  const skipCache = (() => {
    try {
      const url = new URL(c.req.url);
      return url.searchParams.get("refresh") === "1";
    } catch {
      return false;
    }
  })();
  const cached = skipCache
    ? null
    : await lookupCached(content, user.id).catch(() => null);
  if (cached) {
    void logAudit({
      userId: user.id,
      target: activeModelId,
      action: "cache_hit",
      tokens: Math.ceil(cached.response_text.length / 4),
      metadata: { cache_id: cached.id, model: cached.model },
    });
    return streamSSE(c, async (stream) => {
      try {
        await writeCached(stream, cached);
        await replayCachedTokens(stream, cached.response_text);
        const tokens = Math.ceil(cached.response_text.length / 4);
        await sql`
          INSERT INTO messages (user_id, model_id, role, content, tokens)
          VALUES (${user.id}::uuid, ${activeModelId}::uuid, 'assistant', ${cached.response_text}, ${tokens})
        `;
        await writeDone(stream, 0, tokens);
      } catch (err) {
        console.warn("[chat] cache replay failed:", (err as Error).message);
        await writeError(stream);
      }
    });
  }

  // Persist the user message audit row — the user row itself was
  // already inserted by enforceUserMessageQuota above.
  await logAudit({
    userId: user.id,
    target: activeModelId,
    action: "chat_user_message",
    tokens: Math.ceil(content.length / 4),
  });

  const harness = getHarnessByKind(activeHarnessKind);
  // Compose the system prompt: default + (optional) caller override.
  // The default anchors the model's identity and behaviour; the override
  // is appended for per-conversation customisation.
  const systemPrompt = composeSystemPrompt(body.system);
  const messages: HarnessMessage[] = [
    { role: "system" as const, content: systemPrompt },
    { role: "user" as const, content },
  ];

  // Assemble RAG + memory + (optional) live search context. See
  // lib/chat/context.ts for the per-layer semantics.
  const ctx = await assembleRetrievedContext(
    {
      userId: user.id,
      isAdmin: user.role === "admin",
        content,
        forceWebSearch: body.force_web_search,
        searchUrl: body.url,
      },
      user,
    );
  const { retrievedContext, searchSources, searchSummary } = ctx;

  // Detect query intent and assemble the intent-aware search system
  // override. The intent determines the reply shape (lists for news,
  // comparisons for vs queries, etc.).
  if (retrievedContext) {
    const existingSystem = messages.find((m) => m.role === "system")?.content;
    const promptInputs: SearchPromptInputs = {
      query: content,
      retrievedContext,
      existingSystemContent: existingSystem,
    };
    messages.unshift(buildSearchSystemPrompt(promptInputs));
  }

  return streamSSE(c, async (stream) => {
    let assembled = "";
    let usedCache = false;
    let hasRealtimeSources = false;
    const ctrl = new AbortController();
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    const streamStart = Date.now();

    const stopHeartbeat = startHeartbeat(stream);

    if (searchSummary) {
      try {
        await writeSearchSummary(stream, searchSummary);
      } catch { /* fall through */ }
    }
    try {
      // Tier 5 — wrap the call with failover. If the chosen harness
      // hangs past the 10s timeout, withFailover switches to the next
      // healthy harness (or 'mock' as last resort) and re-issues the
      // request. The yielded chunks come from whichever harness
      // actually produced them.
      const { assembled: streamText, promptTokens: pt, completionTokens: ct } =
        await consumeStreamToSSE(
          stream,
          withFailover(activeHarnessKind, {
            model: activeModel.external_id,
            system: systemPrompt,
            messages,
            temperature: 0.5,
            maxTokens: 4096,
          }),
        );
      assembled = streamText;
      promptTokens = pt;
      completionTokens = ct;
      // Auto-append the full Sources list. We ALWAYS inject every
      // search result, not just when the model forgot — many models
      // either drop the bullet list, invent fake list items with
      // no real source, or only cite a few of the available URLs.
      // The user expects every real article we found to be listed.
      // Dedup against URLs already in the *Sources section* only —
      // the main list often re-cites the same URL several times
      // Sources injection. We always strip whatever Sources section the
      // model produced (regardless of where it placed it) and re-append
      // a clean, ordered list at the END. This guarantees:
      //   1. Sources always appear at the bottom (the user reads the
      //      answer first, then checks sources).
      //   2. No duplicate Sources blocks (the model sometimes emits
      //      one section but the server also wants to add links it
      //      missed).
      //   3. The auto-injected list is always complete (every URL
      //      the search returned is listed, even if the model
      //      forgot to cite them).
      if (searchSources.length > 0) {
        // Strip ALL "## Sources" sections (case-insensitive, greedy) so
        // we don't end up with the model's stray section + our appended
        // one. We don't touch preceding content.
        const stripPattern = /\n*##\s+Sources\s*\n[\s\S]*?(?=\n##\s|\n*$)/gim;
        const stripped = assembled.replace(stripPattern, "").replace(/\s+$/, "");
        const bullets = searchSources
          .map((s) => `- [${s.title}](${s.url})`)
          .join("\n");
        const addition = stripped.length > 0
          ? `\n\n## Sources\n${bullets}\n`
          : `## Sources\n${bullets}\n`;
        // Compute the diff so the SSE stream only emits the new tail.
        const diff = assembled.length > stripped.length
          ? addition
          : (stripped + (stripped.length > 0 ? "\n\n" : "") + "## Sources\n" + bullets + "\n");
        // Simpler: if we stripped anything, send the entire new tail
        // (the strip forwards left a gap we fill by re-emitting).
        if (stripped.length !== assembled.length) {
          const newTail = (stripped.length > 0 ? stripped + "\n\n" : "") + "## Sources\n" + bullets + "\n";
          const removedLen = assembled.length - stripped.length;
          assembled = stripped + (stripped.length > 0 ? "\n\n" : "") + "## Sources\n" + bullets + "\n";
          await stream.writeSSE({
            event: "token",
            data: JSON.stringify({ delta: "\n\n## Sources\n" + bullets + "\n", replaced_length: removedLen }),
          });
        } else {
          // Nothing was stripped — just append the canonical section.
          assembled += stripped.length > 0 ? "\n\n## Sources\n" + bullets + "\n" : "## Sources\n" + bullets + "\n";
          await stream.writeSSE({
            event: "token",
            data: JSON.stringify({ delta: assembled }),
          });
        }
      }
      // Detect "sources-only" responses — the model returned only the
      // Sources section without a lead sentence, which is what happens
      // when the model is hardcoded to dump links for a greeting. If
      // we let that through, the user sees a list of URLs and reads
      // it as "the AI didn't respond". Strip the Sources section and
      // re-query the model WITHOUT the search context so the model
      // produces a real answer.
      if (isSourcesOnlyResponse(assembled) && searchSources.length > 0 && !usedCache) {
        const refetch = await refetchIfSourcesOnly(
          {
            harness,
            messages,
            searchSources,
            assembled,
            externalId: activeModel.external_id,
            system: systemPrompt,
            signal: ctrl.signal,
          },
          stream,
        );
        if (refetch.refetched) {
          assembled = refetch.assembled;
          if (typeof refetch.promptTokens === "number") promptTokens = refetch.promptTokens;
          if (typeof refetch.completionTokens === "number") completionTokens = refetch.completionTokens;
          hasRealtimeSources = refetch.hasRealtimeSources;
        }
      }
      // Persist the assistant message.
      const tokens = completionTokens ?? Math.ceil(assembled.length / 4);
      const latencyMs = Date.now() - streamStart;
      const assistantMessageId = await persistAssistantMessage({
        userId: user.id,
        modelId: activeModelId,
        content: assembled,
        tokens,
      });

      // Tier 4 (Discovery): citation lineage. Persist one row per URL
      // we see in the assembled answer so `GET /api/messages/:id/citations`
      // can render the lineage card. Best-effort — never breaks the stream.
      if (assistantMessageId) {
        try {
          const citations = extractCitations(assembled, searchSources);
          await persistCitations(assistantMessageId, citations);
        } catch (err) {
          console.warn("[chat] citation extract failed:", (err as Error).message);
        }
      }
      // All other post-turn bookkeeping: harness_runs row, audit log,
      // spend record, cache store, self-test dispatch. See
      // lib/chat/persist.ts.
      await runPostTurnBookkeeping({
        userId: user.id,
        modelId: activeModelId,
        requestedModelId,
        harnessKind: activeHarnessKind,
        externalId: activeModel.external_id,
        query: content,
        assembled,
        promptTokens,
        completionTokens: tokens,
        latencyMs,
        assistantMessageId,
      });

      await writeDone(stream, promptTokens ?? 0, tokens);
    } catch (err) {
      // Persist the failure as an 'error' harness_run so the audit
      // log shows dropped calls too. We don't have a completion
      // token count or full prompt tokens, so write zeros.
      const latencyMs = Date.now() - streamStart;
      console.warn("[chat] stream failed:", (err as Error).message);
      await recordFailedTurn({
        userId: user.id,
        harnessKind: activeHarnessKind,
        externalId: activeModel.external_id,
        latencyMs,
        errorMessage: (err as Error).message ?? "unknown",
      });
      await writeError(stream);
    } finally {
      stopHeartbeat();
    }
  });
});

// Tier 6 — fetch the self-test result for one message. Returns 404
// when the result hasn't been computed yet (judge still running) or
// when the message isn't owned by the caller. Admins can fetch any.
router.get("/messages/:id/self-test", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const msg = await sql<{ user_id: string | null; panel_id: string | null }[]>`
    SELECT user_id, panel_id FROM messages WHERE id = ${id}::uuid LIMIT 1
  `;
  if (!msg[0]) return c.json({ error: "not_found" }, 404);
  // Access check — admins skip; otherwise the message must belong to
  // the user (1:1 chat) or be on a panel the user belongs to.
  if (user.role !== "admin") {
    if (msg[0].user_id === user.id) {
      // ok
    } else if (msg[0].panel_id) {
      const m = await sql<{ user_id: string }[]>`
        SELECT user_id FROM panel_members
        WHERE panel_id = ${msg[0].panel_id}::uuid AND user_id = ${user.id}::uuid LIMIT 1
      `;
      if (!m[0]) return c.json({ error: "forbidden" }, 403);
    } else {
      return c.json({ error: "forbidden" }, 403);
    }
  }
  const rows = await sql<{
    id: string;
    checks: Array<{ name: string; passed: boolean; note?: string }>;
    passed: boolean;
    created_at: Date;
  }[]>`
    SELECT id, checks, passed, created_at
    FROM self_test_results
    WHERE message_id = ${id}::uuid
    ORDER BY created_at DESC LIMIT 1
  `;
  if (!rows[0]) return c.json({ available: false }, 404);
  return c.json({
    available: true,
    result: rows[0],
  });
});

// List chat history for the current user.
router.get("/history", async (c) => {
  const user = c.get("user");
  const rows = await sql<{
    id: string;
    model_id: string;
    role: string;
    content: string;
    tokens: number;
    created_at: Date;
    model_name: string;
    provider_id: string;
  }[]>`
    SELECT m.id, m.model_id, m.role, m.content, m.tokens, m.created_at,
           md.display_name AS model_name, md.provider_id
    FROM messages m
    JOIN models md ON md.id = m.model_id
    WHERE m.user_id = ${user.id}::uuid
    ORDER BY m.created_at ASC
    LIMIT 500
  `;
  return c.json(rows);
});

router.get("/threads/:modelId", async (c) => {
  const user = c.get("user");
  const modelId = c.req.param("modelId");
  const rows = await sql<{
    id: string;
    role: string;
    content: string;
    tokens: number;
    created_at: Date;
  }[]>`
    SELECT id, role, content, tokens, created_at
    FROM messages
    WHERE user_id = ${user.id}::uuid AND model_id = ${modelId}::uuid
    ORDER BY created_at ASC
  `;
  return c.json(rows);
});

// Tier 4 (Discovery): citation lineage. Returns the citations we
// extracted for one message at write time. Admins may fetch any
// message; users only their own.
router.get("/messages/:id/citations", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  // Confirm the message belongs to this user (admins bypass).
  if (user.role !== "admin") {
    const m = await sql<{ user_id: string | null }[]>`
      SELECT user_id FROM messages WHERE id = ${id}::uuid LIMIT 1
    `;
    const owner = m[0]?.user_id ?? null;
    if (!owner || owner !== user.id) {
      return c.json({ error: "forbidden" }, 403);
    }
  }
  const rows = await sql<{
    id: string;
    message_id: string;
    source_kind: string;
    source_ref: string;
    excerpt: string | null;
    created_at: Date;
  }[]>`
    SELECT id, message_id, source_kind, source_ref, excerpt, created_at
    FROM citations
    WHERE message_id = ${id}::uuid
    ORDER BY created_at ASC
  `;
  return c.json(rows);
});

export default router;