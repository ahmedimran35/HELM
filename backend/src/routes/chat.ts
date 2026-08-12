// 1:1 chat with streaming (docs §2.2). User sends a message to a model
// they've been granted access to, and we stream the model's reply back
// token-by-token via Server-Sent Events.
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
import { isHarnessKind, type HarnessKind } from "../harness/types.ts";
import { pickModel } from "../lib/model-router.ts";
import { lookupCached, storeCached } from "../lib/response-cache.ts";
import { withFailover } from "../lib/health-check.ts";

const router = new Hono();
router.use("*", requireAuth);

interface QuotaRow {
  message_limit: number | null;
}

// Sentinel error used to roll back the quota-check transaction without
// surfacing as a real error to the caller.
const QUOTA_EXCEEDED = Symbol("quota_exceeded");

// Atomically check the user's monthly quota AND insert the new user
// message in a single transaction. Returns { ok: true } when the message
// has been persisted and the request may proceed; { ok: false } when the
// quota is exceeded (the INSERT is rolled back so the count stays
// accurate).
//
// Why this is one transaction:
//   - The previous version read the count and then did a separate
//     INSERT. Two concurrent requests at the boundary could both pass
//     the check before either incremented, letting users blow past
//     their limit.
//   - We serialise quota decisions for a single user with an advisory
//     transaction lock keyed on the user id. Different users still run
//     in parallel.
//   - We count AFTER the insert so the current request is included in
//     the count; if the resulting count is over the limit we throw to
//     roll back the insert.
async function checkQuotaAndInsertUserMessage(
  userId: string,
  modelId: string | null,
  content: string,
  panelId?: string,
): Promise<{ ok: true } | { ok: false }> {
  return await sql
    .begin(async (tx) => {
      // Serialise concurrent quota checks for this user. hashtext is
      // stable within a single Postgres install; using the two-int form
      // avoids any bigint/int4 ambiguity in the tagged-template call.
      await tx`SELECT pg_advisory_xact_lock(hashtext(${userId}::text), 0)`;
      const qrows = await tx<QuotaRow[]>`SELECT message_limit FROM quotas WHERE user_id = ${userId}::uuid LIMIT 1`;
      const limit = qrows[0]?.message_limit ?? null;
      if (limit === null) {
        // No quota row → unlimited. Insert and commit.
        await tx`
          INSERT INTO messages (user_id, model_id, panel_id, role, content, tokens)
          VALUES (${userId}::uuid, ${modelId}::uuid, ${panelId ?? null}::uuid, 'user', ${content}, 0)
        `;
        return { ok: true } as const;
      }
      // Insert first, then count. Each chat turn produces two rows in
      // messages (user + assistant); only count the user row so the
      // limit maps 1:1 to turns, not halves the effective budget.
      await tx`
        INSERT INTO messages (user_id, model_id, panel_id, role, content, tokens)
        VALUES (${userId}::uuid, ${modelId}::uuid, ${panelId ?? null}::uuid, 'user', ${content}, 0)
      `;
      const countRows = await tx<{ n: number }[]>`
        SELECT count(*)::int AS n FROM messages
        WHERE user_id = ${userId}::uuid
          AND role = 'user'
          AND created_at >= date_trunc('month', now())
      `;
      if ((countRows[0]?.n ?? 0) > limit) {
        // Throwing inside sql.begin rolls the transaction back, undoing
        // the INSERT above so the count remains accurate.
        throw QUOTA_EXCEEDED;
      }
      return { ok: true } as const;
    })
    .catch((err) => {
      if (err === QUOTA_EXCEEDED) return { ok: false } as const;
      throw err;
    });
}

// Public wrapper so other modules (ws.ts panel chat) can share the same
// quota enforcement as the HTTP /api/chat route. Without this, a user
// could bypass their monthly message budget by talking to the panel
// agent via the WebSocket instead of the HTTP route.
export async function enforceUserMessageQuota(
  userId: string,
  content: string,
  opts: { modelId?: string; panelId?: string } = {},
): Promise<{ ok: true } | { ok: false; reason?: string }> {
  return await checkQuotaAndInsertUserMessage(
    userId,
    opts.modelId ?? null,
    content,
    opts.panelId,
  );
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
  // transaction (see checkQuotaAndInsertUserMessage for the why).
  const quota = await checkQuotaAndInsertUserMessage(user.id, modelId, content);
  if (!quota.ok) {
    return c.json({ error: "quota_exceeded" }, 429);
  }

  // Load model + provider.
  const modelRows = await sql<{
    id: string;
    external_id: string;
    display_name: string;
    provider_id: string;
    state: string;
  }[]>`
    SELECT id, external_id, display_name, provider_id, state
    FROM models
    WHERE id = ${modelId}::uuid AND state = 'active'
    LIMIT 1
  `;
  const model = modelRows[0];
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
    const swapRows = await sql<{
      id: string;
      external_id: string;
      display_name: string;
      provider_id: string;
      state: string;
    }[]>`
      SELECT id, external_id, display_name, provider_id, state
      FROM models
      WHERE id = ${routerDecision.modelId}::uuid AND state = 'active'
      LIMIT 1
    `;
    const swap = swapRows[0];
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
  // content (sha256 of normalised query) returns the cached response
  // without touching the harness. The hit_count + last_hit_at are
  // updated fire-and-forget inside lookupCached().
  const cached = await lookupCached(content, null).catch(() => null);
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
        await stream.writeSSE({
          event: "cached",
          data: JSON.stringify({
            id: cached.id,
            hit_count: cached.hit_count + 1,
            model: cached.model,
          }),
        });
        // Stream the cached body in chunks so the UI behaves the
        // same as a real reply. We pick 80 chars per delta — small
        // enough to feel live, large enough not to flood.
        const CHUNK = 80;
        for (let i = 0; i < cached.response_text.length; i += CHUNK) {
          await stream.writeSSE({
            event: "token",
            data: JSON.stringify({ delta: cached.response_text.slice(i, i + CHUNK) }),
          });
        }
        const tokens = Math.ceil(cached.response_text.length / 4);
        await sql`
          INSERT INTO messages (user_id, model_id, role, content, tokens)
          VALUES (${user.id}::uuid, ${activeModelId}::uuid, 'assistant', ${cached.response_text}, ${tokens})
        `;
        await stream.writeSSE({
          event: "done",
          data: JSON.stringify({ prompt_tokens: 0, completion_tokens: tokens }),
        });
      } catch (err) {
        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ message: (err as Error).message }),
        });
      }
    });
  }

  // Persist the user message immediately.
  // (User message is already inserted by checkQuotaAndInsertUserMessage
  // above; we only log audit here.)
  await logAudit({
    userId: user.id,
    target: activeModelId,
    action: "chat_user_message",
    tokens: Math.ceil(content.length / 4),
  });

  // Search summary captured during the search step (further down) so the
  // SSE stream can emit a "search" event for the frontend banner.
  const searchRef: { summary: { service: string; result_count: number; answer: string | null } | null } = { summary: null };

  const harness = getHarnessByKind(activeHarnessKind);
  const messages = [
    ...(body.system
      ? [{ role: "system" as const, content: body.system }]
      : []),
    { role: "user" as const, content },
  ];
  // Retrieve relevant panel knowledge for the current user (their
  // own + any panels they belong to). This makes 1:1 chat also RAG-
  // aware when the user has uploaded docs to a panel.
  const userPanelIds = await sql<{ panel_id: string }[]>`
    SELECT panel_id FROM panel_members WHERE user_id = ${user.id}::uuid
  `;
  let retrievedContext = "";
  for (const row of userPanelIds.slice(0, 5)) {
    const { retrieveForPanel, formatContext } = await import("../lib/retrieve.ts");
    const chunks = await retrieveForPanel(row.panel_id, content, 2);
    const ctx = formatContext(chunks);
    if (ctx) retrievedContext += (retrievedContext ? "\n\n" : "") + ctx;
  }
  // Inject the user's memory (personal + team-visible, plus admin
  // scope if the user is an admin) into the context. Lightweight:
  // one SQL query, recent 50 entries, no embeddings. Memory is
  // ALWAYS injected — even when there's no RAG and no web search
  // hit — so the agent has the user's notes available for every
  // reply.
  const { buildMemoryContext } = await import("./workspace.ts");
  const memCtx = await buildMemoryContext(user);
  if (memCtx) {
    retrievedContext = (retrievedContext ? retrievedContext + "\n\n" : "") + memCtx;
  }
// Real-time web search — runs when:
//   - the user has force_web_search=true in the request body (per-message
//     toggle on the chat UI), OR
//   - the user has force_web_search=undefined and the user's posture for
//     the tool is "auto", OR
//   - the caller is admin (toggle is ignored for admins — they always
//     search, including when force_web_search is explicitly false).
// The toggle actually disables search for non-admins when set to false,
// which the previous OR-chain silently ignored. The configured provider
  // is tried first; if it returns 0 or errors, we fall back to the
  // keyless Wikipedia API so users always get some live signal.
  const postureRows = await sql<{ posture: string }[]>`
    SELECT posture FROM tool_posture
    WHERE user_id = ${user.id}::uuid AND tool_name = 'web_search' LIMIT 1
  `;
  const webSearchPosture = postureRows[0]?.posture ?? "auto";
  // Per-message toggle semantics:
  //   - force_web_search === true  → always search (explicit on).
  //   - force_web_search === false → never search (explicit off). For
  //     admins we keep the existing override so they can't accidentally
  //     disable live search while debugging; for non-admins the toggle
  //     actually wins.
  //   - force_web_search === undefined → default behaviour: admins
  //     always search for accuracy, otherwise follow the configured
  //     posture (auto → search, strict → no search).
  let shouldSearch: boolean;
  if (body.force_web_search === true) {
    shouldSearch = true;
  } else if (body.force_web_search === false) {
    shouldSearch = user.role === "admin";
  } else {
    shouldSearch = user.role === "admin" || webSearchPosture === "auto";
  }
  if (shouldSearch) {
    // The actual search call, result context assembly, and audit logging
    // happen inside the streamSSE callback below so we can keep
    // `searchSources` for the auto-append pass.
  }
  if (retrievedContext) {
    // Force the model to use the search results when present, but
    // don't refuse to answer if the search returned nothing — let
    // the model fall back to its training data so the user always
    // gets *some* answer. Always require proper markdown formatting
    // and an explicit Sources section.
    const systemAddon = messages.find((m) => m.role === "system")?.content ?? "";
    const prefix = systemAddon ? `${systemAddon}\n\n` : "";
    messages.unshift({
      role: "system",
      content:
        `${prefix}` +
        `[SYSTEM OVERRIDE — live-web search is on]\n` +
        `A real-time web search was performed on the user's question and the following are the most current, on-topic results.\n\n` +
        `MANDATORY reply shape (always follow this exactly):\n` +
        `1. Start with a markdown heading (## or ###) for the answer topic.\n` +
        `2. One bold (**...**) lead sentence that directly answers the question.\n` +
        `3. Use bullet/numbered lists when there are multiple items.\n` +
        `4. End the reply with a "## Sources" heading, followed by **one bullet per source on its own line** in the form:\n` +
        `   - [descriptive title](https://full.url)\n` +
        `   Every URL you used (including the Wikipedia link in the context) must appear here as a separate bullet. Never leave the Sources section empty — if you used any result, list it.\n` +
        `5. If the search returned nothing useful, the Sources section must contain exactly: "no fresh web results available".\n\n` +
        `Do not mention "training data" in your reply. Render the reply as proper markdown — never output raw asterisks for emphasis.\n\n` +
        `${retrievedContext}`,
    });
  }

  // `searchSources` is the list of result URLs/titles from the search —
// we keep it around so we can auto-append a "## Sources" section when
// the model forgets to (most models drop the section, leaving an
// empty heading).
const searchSources: Array<{ title: string; url: string }> = [];
if (shouldSearch) {
    try {
      const { callLightpanda, classifyQuery } = await import("../lib/chat_search.ts");
      // Pass 8 results to the model — gives it enough context for
      // any query type, not just news.
      const searchResponse = await callLightpanda("lightpanda", "", content, 8, { url: body.url });
      if (searchResponse) {
        for (const r of searchResponse.results) searchSources.push({ title: r.title, url: r.url });
        const ctx =
          "Web search results:\n" +
          searchResponse.results
            .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${(r.snippet ?? "").slice(0, 240)}`)
            .join("\n\n") +
          (searchResponse.answer ? `\n\nDirect answer: ${searchResponse.answer}` : "");
        retrievedContext += (retrievedContext ? "\n\n" : "") + ctx;
        searchRef.summary = {
          service: searchResponse.service ?? "lightpanda",
          result_count: searchResponse.results.length,
          answer: searchResponse.answer ?? null,
        };
        await logAudit({
          userId: user.id,
          target: searchResponse.service ?? "lightpanda",
          action: body.force_web_search ? "web_search_forced" : "web_search_auto",
          metadata: {
            query: content,
            intent: searchResponse.intent ?? "general",
            result_count: searchResponse.results.length,
            source: "chat_stream",
            trace: JSON.stringify(searchResponse.trace ?? []),
          },
        });
      }
    } catch (err) {
      console.warn("[chat] web_search failed:", (err as Error).message);
    }
  }
// Detect query intent and count for list queries, then build an
// intent-aware system override. The intent determines the reply
// shape (lists for news, comparisons for vs queries, etc.).
const { extractListCount, classifyQuery } = await import("../lib/web_search.ts");
const requestedN = extractListCount(content);
const intent = classifyQuery(content);
if (retrievedContext) {
  const systemAddon = messages.find((m) => m.role === "system")?.content ?? "";
  const prefix = systemAddon ? `${systemAddon}\n\n` : "";

  // Per-intent framing rules. The model picks the right shape based
  // on what the user actually asked for.
  let intentRule: string;
  if (requestedN) {
    intentRule = `The user explicitly asked for ${requestedN} items. You MUST produce exactly ${requestedN} entries — pick the best ${requestedN} from the search results, mixing regional and broader results if needed; never reply with fewer than ${requestedN} by saying "the search only returned X". Never split one article into multiple items to fill the count — each item must be a distinct source.`;
  } else if (intent === "comparison") {
    intentRule = `The user is asking for a comparison. Produce a side-by-side comparison table or two clearly labelled sections (one per subject) with the key differences called out. Use the search results for both subjects.`;
  } else if (intent === "howto") {
    intentRule = `The user is asking how or why something works. Give a clear step-by-step explanation with concrete examples. If the search results cover the topic, build your explanation on those; otherwise supplement with your own knowledge but flag anything that isn't from the sources.`;
  } else if (intent === "creative") {
    intentRule = `The user wants creative output (a write, draft, or composition). The search results are background context, not the main content. Produce the requested creative output directly; cite sources only if you actually used specific facts from them.`;
  } else if (intent === "factual") {
    intentRule = `The user is asking a factual question. Give a concise, direct answer (one short paragraph). Always cite the source so the user can verify. If the search returned multiple sources, cross-check them and prefer the most authoritative (Wikipedia > news > blogs).`;
  } else if (intent === "news") {
    intentRule = `The user is asking about recent news / current events. For "top N" questions produce a numbered list of N distinct items, each starting with **bold headline**. For "what's happening with X" give a 2–4 sentence summary with the most recent timestamped facts.`;
  } else {
    intentRule = `Answer the user's question directly using the search results as primary evidence. If the search results don't fully cover the question, supplement from your training data but flag anything not from the sources.`;
  }

  messages.unshift({
    role: "system",
    content:
      `${prefix}` +
      `[SYSTEM OVERRIDE — live-web search is on]\n` +
      `A real-time web search was just performed on the user's question and the most current, on-topic results are below.\n\n` +
      `**MEMORY PRIORITY**: the user/team memory entries in the "Known context" section below are AUTHORITATIVE for this project. If the memory says "we use X", the project uses X — even if web search results describe a different X. Web search is general world knowledge; the memory describes THIS user's project.\n\n` +
      `Detected query intent: ${intent}. ${intentRule}\n\n` +
      `Formatting rules (always follow):\n` +
      `1. Start with a markdown heading (## or ###) for the answer topic.\n` +
      `2. One bold (**...**) lead sentence that directly answers the question.\n` +
      `3. Use bullet/numbered lists, tables, or short paragraphs as fits the intent. Use \`code\` for technical terms.\n` +
      `4. For lists, each item must reference a distinct source URL — never split one article into multiple items.\n` +
      `5. End the reply with a "## Sources" heading listing every URL you cited, one bullet per source in the form: - [descriptive title](https://full.url).\n` +
      `6. If the search returned nothing useful, the Sources section must contain exactly: "no fresh web results available".\n` +
      `Do not mention "training data" in your reply. Render the reply as proper markdown — never output raw asterisks for emphasis.\n\n` +
      `${retrievedContext}`,
  });
}

return streamSSE(c, async (stream) => {
    let assembled = "";
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    const streamStart = Date.now();

    // SSE heartbeat — every 15 s write a tiny "ping" frame so the
    // HTTP layer (Bun, proxies, browsers) doesn't time the stream
    // out during a long web search or a slow first-token model
    // response. Big questions like "top 5 cyber news for today"
    // can take 30–60 s end-to-end.
    const heartbeat = setInterval(() => {
      try {
        stream.writeSSE({ event: "ping", data: String(Date.now()) });
      } catch {
        // Connection dropped — clear will fire next tick.
      }
    }, 15_000);

    if (searchRef.summary) {
      try {
        await stream.writeSSE({
          event: "search",
          data: JSON.stringify({
            service: searchRef.summary.service,
            result_count: searchRef.summary.result_count,
            has_answer: !!searchRef.summary.answer,
          }),
        });
      } catch { /* fall through */ }
    }
    try {
      // Tier 5 — wrap the call with failover. If the chosen harness
      // hangs past the 10s timeout, withFailover switches to the next
      // healthy harness (or 'mock' as last resort) and re-issues the
      // request. The yielded chunks come from whichever harness
      // actually produced them.
      for await (const chunk of withFailover(activeHarnessKind, {
        model: activeModel.external_id,
        system: body.system,
        messages,
        temperature: 0.7,
        maxTokens: 1024,
      })) {
        if (chunk.done) {
          promptTokens = chunk.prompt_tokens;
          completionTokens = chunk.completion_tokens;
          break;
        }
        if (chunk.delta) assembled += chunk.delta;
        await stream.writeSSE({
          event: "token",
          data: JSON.stringify({ delta: chunk.delta }),
        });
      }
      // Auto-append the full Sources list. We ALWAYS inject every
      // search result, not just when the model forgot — many models
      // either drop the bullet list, invent fake list items with
      // no real source, or only cite a few of the available URLs.
      // The user expects every real article we found to be listed.
      // Dedup against URLs already in the *Sources section* only —
      // the main list often re-cites the same URL several times
      // (one per row of a numbered list), which shouldn't suppress
      // the source bullet.
      if (searchSources.length > 0) {
        // Find the existing Sources section (if any) and extract
        // the URLs it already lists.
        const sourcesMatch = assembled.match(/##\s+Sources\s*\n([\s\S]*?)(?=\n##\s|\n*$)/im);
        const sourcesBlock = sourcesMatch?.[1] ?? "";
        const existing = new Set<string>();
        for (const m of sourcesBlock.matchAll(/\]\((https?:\/\/[^)]+)\)/g)) {
          existing.add(m[1]!);
        }
        const missing = searchSources.filter((s) => !existing.has(s.url));
        if (missing.length > 0) {
          const bullets = missing
            .map((s) => `- [${s.title}](${s.url})`)
            .join("\n");
          const hasHeading = /^##\s+Sources\s*$/im.test(assembled);
          const addition = hasHeading
            ? "\n" + bullets + "\n"
            : "\n\n## Sources\n" + bullets + "\n";
          assembled += addition;
          await stream.writeSSE({
            event: "token",
            data: JSON.stringify({ delta: addition }),
          });
        }
      }
      // Persist the assistant message.
      const tokens = completionTokens ?? Math.ceil(assembled.length / 4);
      const latencyMs = Date.now() - streamStart;
      const insertedRows = await sql<{ id: string }[]>`
        INSERT INTO messages (user_id, model_id, role, content, tokens)
        VALUES (${user.id}::uuid, ${activeModelId}::uuid, 'assistant', ${assembled}, ${tokens})
        RETURNING id
      `;
      const assistantMessageId = insertedRows[0]?.id;

      // Tier 4 (Discovery): citation lineage. Persist one row per URL
      // we see in the assembled answer so `GET /api/messages/:id/citations`
      // can render the lineage card. Also persist pure-text citations
      // for quoted memories ("memory:...") and file references. We do
      // this best-effort and never break the chat stream on failure.
      if (assistantMessageId) {
        try {
          const citations = extractCitations(assembled, searchSources);
          for (const c of citations) {
            await sql`
              INSERT INTO citations (message_id, source_kind, source_ref, excerpt)
              VALUES (${assistantMessageId}::uuid, ${c.kind}, ${c.ref}, ${c.excerpt ?? null})
            `.catch(() => undefined);
          }
        } catch (err) {
          console.warn("[chat] citation extract failed:", (err as Error).message);
        }
      }
      // Audit every harness invocation (P2). Best-effort — never
      // breaks the request. Includes the harness kind so the admin
      // Logs view can split by runtime.
      await sql`
        INSERT INTO harness_runs (user_id, harness, model, prompt_tokens, completion_tokens, latency_ms, status)
        VALUES (${user.id}::uuid, ${activeHarnessKind}, ${activeModel.external_id},
                ${promptTokens ?? 0}, ${tokens}, ${latencyMs}, 'ok')
      `.catch((err) => console.warn("[chat] harness_runs insert failed:", (err as Error).message));
      await logAudit({
        userId: user.id,
        target: activeModelId,
        action: "chat_assistant_message",
        tokens,
        metadata: {
          duration_ms: latencyMs,
          prompt_tokens: promptTokens ?? 0,
          completion_tokens: tokens,
          harness: activeHarnessKind,
          requested_model: requestedModelId,
        },
      });

      // Tier 5 — record the spend for this turn. Cost is derived
      // from the model's stored per-1k prices. 1:1 chat has no
      // panel_id, so we skip the spend_caps path and just log
      // the cost on the audit row.
      const costCents = await computeCostCents(
        activeModel.external_id,
        promptTokens ?? 0,
        tokens,
      );
      if (costCents > 0) {
        // Record against the per-user budget so the audit/alerts
        // surface still triggers. spend_caps are panel-scoped so
        // we only fire the warn notification for actual panels.
        void sql`
          INSERT INTO audit_log (user_id, target, action, tokens, metadata)
          VALUES (${user.id}::uuid, ${activeModelId}::uuid, 'turn_spend', ${tokens},
                  ${sql.json({ cost_cents: costCents, harness: activeHarnessKind })})
        `.catch(() => undefined);
      }

      // Tier 5 — populate the response cache for future exact-match
      // hits. Fire-and-forget; never breaks the stream.
      void storeCached(content, assembled, activeModel.external_id, null);

      // Tier 6 — self-test (fire-and-forget). The judge grades the
      // assistant reply in the background so we don't slow down the
      // stream; the frontend polls /api/messages/:id/self-test to
      // surface the badge once it lands. We already have the assistant
      // message id from the INSERT above — no need to re-query.
      if (assistantMessageId) {
        try {
          const { runSelfTest } = await import("../lib/self-test.ts");
          void runSelfTest(assistantMessageId).catch((err) =>
            console.warn("[chat] self-test failed:", (err as Error).message),
          );
        } catch (err) {
          console.warn("[chat] self-test dispatch failed:", (err as Error).message);
        }
      }

      await stream.writeSSE({
        event: "done",
        data: JSON.stringify({ prompt_tokens: promptTokens ?? 0, completion_tokens: tokens }),
      });
    } catch (err) {
      // Persist the failure as an 'error' harness_run so the audit
      // log shows dropped calls too. We don't have a completion
      // token count or full prompt tokens, so write zeros.
      const latencyMs = Date.now() - streamStart;
      await sql`
        INSERT INTO harness_runs (user_id, harness, model, prompt_tokens, completion_tokens, latency_ms, status, error)
        VALUES (${user.id}::uuid, ${activeHarnessKind}, ${activeModel.external_id},
                0, 0, ${latencyMs}, 'error', ${(err as Error).message ?? "unknown"})
      `.catch((insertErr) => console.warn("[chat] harness_runs error insert failed:", (insertErr as Error).message));
      await stream.writeSSE({
        event: "error",
        data: JSON.stringify({ message: (err as Error).message }),
      });
    } finally {
      clearInterval(heartbeat);
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

// ---------------------------------------------------------------------------
// Citation extraction. Called once per assistant turn to seed the
// lineage row so downstream UI can render "where did this come from?"
//
// We only capture three kinds of source so the front end can render
// them with sensible icons:
//   - web    : http(s) URLs seen in the bullet list under ## Sources
//   - memory : explicit "memory:<id>" markers the user / agent uses
//   - file   : explicit "file:<ref>" markers
// Anything else falls back to a generic "tool" kind so we never throw.
// ---------------------------------------------------------------------------
function extractCitations(
  text: string,
  searchSources: Array<{ title: string; url: string }>,
): Array<{ kind: string; ref: string; excerpt: string | null }> {
  const out: Array<{ kind: string; ref: string; excerpt: string | null }> = [];
  const seen = new Set<string>();
  // Markdown links: [title](https://...)
  for (const m of text.matchAll(/\[[^\]]+\]\((https?:\/\/[^)\s]+)\)/g)) {
    const url = m[1]!;
    if (seen.has(url)) continue;
    seen.add(url);
    const title = extractTitleForUrl(url, searchSources);
    out.push({ kind: "web", ref: url, excerpt: title });
  }
  // Bare URLs in markdown (rare, but the auto-append uses markdown links so
  // we still cover plain URLs as a defensive secondary pass).
  for (const m of text.matchAll(/\b(https?:\/\/[^\s)]+)/g)) {
    const url = m[1]!.replace(/[).,]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ kind: "web", ref: url, excerpt: null });
  }
  // Memory: UUIDs marked as `memory:<uuid>`
  for (const m of text.matchAll(/memory:([0-9a-f-]{36})/gi)) {
    const ref = m[1]!;
    if (seen.has("memory:" + ref)) continue;
    seen.add("memory:" + ref);
    out.push({ kind: "memory", ref, excerpt: null });
  }
  // File: `file:<name>` markers. The agent sometimes references uploaded
  // docs by filename. We keep the name and let the UI match.
  for (const m of text.matchAll(/`?file:([^\s`)]+)`?/g)) {
    const ref = m[1]!;
    if (seen.has("file:" + ref)) continue;
    seen.add("file:" + ref);
    out.push({ kind: "file", ref, excerpt: null });
  }
  return out;
}

function extractTitleForUrl(
  url: string,
  searchSources: Array<{ title: string; url: string }>,
): string | null {
  for (const s of searchSources) {
    if (s.url === url) return s.title.slice(0, 240);
  }
  return null;
}

/** Tier 5 — compute the cost (cents) for a chat turn given the model's
 *  external id and the token counts. Falls back to 0 when the model
 *  isn't priced (test fixtures, mock harness). */
async function computeCostCents(
  externalId: string,
  promptTokens: number,
  completionTokens: number,
): Promise<number> {
  try {
    const rows = await sql<{ input: string | null; output: string | null }[]>`
      SELECT input_price_per_1k::text AS input,
             output_price_per_1k::text AS output
      FROM models
      WHERE external_id = ${externalId}
      LIMIT 1
    `;
    const row = rows[0];
    if (!row || row.input === null || row.output === null) return 0;
    const inCents = Number(row.input);
    const outCents = Number(row.output);
    return (
      (promptTokens * inCents + completionTokens * outCents) / 1000
    );
  } catch {
    return 0;
  }
}

export default router;