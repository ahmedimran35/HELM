// Assistant-message persistence + citation lineage (Tier 4 Discovery)
// + post-turn bookkeeping (audit, spend, cache, self-test).
//
// After each chat turn we:
//   1. INSERT the assembled assistant reply into `messages` and return
//      its id.
//   2. Walk the assembled text for citation markers and INSERT one row
//      per citation into `citations` so `GET /api/messages/:id/citations`
//      can render the lineage card.
//   3. Run the rest of the post-turn bookkeeping: harness_runs row,
//      audit log, turn spend record, response cache store, and fire-
//      and-forget self-test dispatch.
//
// Citation kinds we capture:
//   - web    : http(s) URLs seen in the bullet list under ## Sources.
//   - memory : explicit "memory:<id>" markers the user / agent uses.
//   - file   : explicit "file:<ref>" markers.
// Anything else falls back to a generic "tool" kind so we never throw.
//
// All operations are best-effort — a citation-insert failure must never
// break the chat stream the caller already shipped tokens for.

import { sql } from "../../db/client.ts";
import { logAudit } from "../audit.ts";
import type { HarnessKind } from "../../harness/types.ts";
import { storeCached as chatStoreCached } from "./cache.ts";

/** Persist the assembled assistant reply and return its id. */
export async function persistAssistantMessage(args: {
  userId: string;
  modelId: string;
  content: string;
  tokens: number;
}): Promise<string | undefined> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO messages (user_id, model_id, role, content, tokens)
    VALUES (${args.userId}::uuid, ${args.modelId}::uuid, 'assistant', ${args.content}, ${args.tokens})
    RETURNING id
  `;
  return rows[0]?.id;
}

/** Persist one citation row per source we extracted from the assistant
 *  reply. Best-effort — never throws. Returns the number of rows that
 *  were attempted (not necessarily inserted). */
export async function persistCitations(
  messageId: string,
  citations: Array<{ kind: string; ref: string; excerpt: string | null }>,
): Promise<void> {
  for (const c of citations) {
    await sql`
      INSERT INTO citations (message_id, source_kind, source_ref, excerpt)
      VALUES (${messageId}::uuid, ${c.kind}, ${c.ref}, ${c.excerpt ?? null})
    `.catch(() => undefined);
  }
}

/** Extract citation references from an assembled assistant reply.
 *
 *  We only capture three kinds of source so the front end can render
 *  them with sensible icons:
 *    - web    : http(s) URLs seen in the bullet list under ## Sources
 *    - memory : explicit "memory:<id>" markers the user / agent uses
 *    - file   : explicit "file:<ref>" markers
 *  Anything else falls back to a generic "tool" kind so we never throw. */
export function extractCitations(
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

/** Resolve a citation URL back to the descriptive title we used for it
 *  during the search step. Returns null when the URL didn't come from
 *  search results (e.g. a bare URL the model invented). */
export function extractTitleForUrl(
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
export async function computeCostCents(
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

/** Inputs for the post-turn bookkeeping pass. */
export interface PostTurnInputs {
  userId: string;
  modelId: string;
  requestedModelId: string;
  harnessKind: HarnessKind;
  externalId: string;
  query: string;
  assembled: string;
  promptTokens: number | undefined;
  completionTokens: number;
  latencyMs: number;
  assistantMessageId: string | undefined;
}

/** Run every post-stream side-effect: harness_runs row, chat_assistant_message
 *  audit log, turn_spend record, response cache write, and fire-and-
 *  forget self-test dispatch.
 *
 *  Every step is best-effort and never throws — the chat stream the
 *  caller already shipped tokens for must not be retroactively broken. */
export async function runPostTurnBookkeeping(
  inputs: PostTurnInputs,
): Promise<void> {
  const {
    userId,
    modelId,
    requestedModelId,
    harnessKind,
    externalId,
    query,
    assembled,
    promptTokens,
    completionTokens,
    latencyMs,
    assistantMessageId,
  } = inputs;
  // Audit every harness invocation (P2). Best-effort — never
  // breaks the request. Includes the harness kind so the admin
  // Logs view can split by runtime.
  await sql`
    INSERT INTO harness_runs (user_id, harness, model, prompt_tokens, completion_tokens, latency_ms, status)
    VALUES (${userId}::uuid, ${harnessKind}, ${externalId},
            ${promptTokens ?? 0}, ${completionTokens}, ${latencyMs}, 'ok')
  `.catch((err) => console.warn("[chat] harness_runs insert failed:", (err as Error).message));
  await logAudit({
    userId,
    target: modelId,
    action: "chat_assistant_message",
    tokens: completionTokens,
    metadata: {
      duration_ms: latencyMs,
      prompt_tokens: promptTokens ?? 0,
      completion_tokens: completionTokens,
      harness: harnessKind,
      requested_model: requestedModelId,
    },
  });

  // Tier 5 — record the spend for this turn. Cost is derived
  // from the model's stored per-1k prices. 1:1 chat has no
  // panel_id, so we skip the spend_caps path and just log
  // the cost on the audit row.
  const costCents = await computeCostCents(
    externalId,
    promptTokens ?? 0,
    completionTokens,
  );
  if (costCents > 0) {
    // Record against the per-user budget so the audit/alerts
    // surface still triggers. spend_caps are panel-scoped so
    // we only fire the warn notification for actual panels.
    void sql`
      INSERT INTO audit_log (user_id, target, action, tokens, metadata)
      VALUES (${userId}::uuid, ${modelId}::uuid, 'turn_spend', ${completionTokens},
              ${sql.json({ cost_cents: costCents, harness: harnessKind })})
    `.catch(() => undefined);
  }

  // Tier 5 — populate the response cache for future exact-match
  // hits. Scoped by user id so the same query from a different
  // user can't poison this user's cache. Fire-and-forget; never
  // breaks the stream.
  void chatStoreCached(query, assembled, externalId, userId);

  // Tier 6 — self-test (fire-and-forget). The judge grades the
  // assistant reply in the background so we don't slow down the
  // stream; the frontend polls /api/messages/:id/self-test to
  // surface the badge once it lands. We already have the assistant
  // message id from the INSERT above — no need to re-query.
  if (assistantMessageId) {
    try {
      const { runSelfTest } = await import("../self-test.ts");
      void runSelfTest(assistantMessageId).catch((err) =>
        console.warn("[chat] self-test failed:", (err as Error).message),
      );
    } catch (err) {
      console.warn("[chat] self-test dispatch failed:", (err as Error).message);
    }
  }
}

/** Record a failed turn so the audit log shows dropped calls too.
 *  We don't have a completion token count or full prompt tokens,
 *  so write zeros. */
export async function recordFailedTurn(inputs: {
  userId: string;
  harnessKind: HarnessKind;
  externalId: string;
  latencyMs: number;
  errorMessage: string;
}): Promise<void> {
  await sql`
    INSERT INTO harness_runs (user_id, harness, model, prompt_tokens, completion_tokens, latency_ms, status, error)
    VALUES (${inputs.userId}::uuid, ${inputs.harnessKind}, ${inputs.externalId},
            0, 0, ${inputs.latencyMs}, 'error', ${inputs.errorMessage})
  `.catch((err) => console.warn("[chat] harness_runs error insert failed:", (err as Error).message));
}