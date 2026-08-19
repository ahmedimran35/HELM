// Retrieved-context assembly for the 1:1 chat route.
//
// Pulls together the three layers of context that get injected into the
// model's system prompt:
//   1. Panel RAG: top-K relevant chunks from every panel the user
//      belongs to (Postgres tsvector full-text search, sanitised).
//   2. User memory: personal + team-visible + admin memory entries for
//      the user, rendered as a "Known context" block.
//   3. Live web search: results from the chat_search provider when the
//      user / posture says we should.
//
// All three layers are concatenated into a single `retrievedContext`
// string that the search-prompt builder drops into the system message.

import { sql } from "../../db/client.ts";
import { logAudit } from "../audit.ts";

export interface SearchSource {
  title: string;
  url: string;
}

export interface SearchSummary {
  service: string;
  result_count: number;
  answer: string | null;
}

export interface AssembleContextInputs {
  userId: string;
  isAdmin: boolean;
  content: string;
  forceWebSearch: boolean | undefined;
  /** Override for the search provider URL (e.g. lightpanda). */
  searchUrl?: string;
}

export interface AssembleContextResult {
  /** Concatenated RAG + memory + (optional) search context. Empty
   *  string when nothing was retrieved. */
  retrievedContext: string;
  /** The list of search-result URLs/titles we should cite. Empty when
   *  no search was run. */
  searchSources: SearchSource[];
  /** Search summary for the SSE `search` event banner. Null when no
   *  search was run. */
  searchSummary: SearchSummary | null;
}

/** Retrieve relevant panel knowledge + memory context for the user. */
export async function retrieveUserKnowledge(
  userId: string,
  content: string,
): Promise<string> {
  const userPanelIds = await sql<{ panel_id: string }[]>`
    SELECT panel_id FROM panel_members WHERE user_id = ${userId}::uuid
  `;
  let context = "";
  for (const row of userPanelIds.slice(0, 5)) {
    const { retrieveForPanel, formatContext } = await import("../retrieve.ts");
    const chunks = await retrieveForPanel(row.panel_id, content, 2);
    const ctx = formatContext(chunks);
    if (ctx) context += (context ? "\n\n" : "") + ctx;
  }
  return context;
}

/** Render the user's personal + team + admin memory entries into a
 *  context block. Returns an empty string when the user has no
 *  memory entries. */
export async function retrieveUserMemory(
  user: { id: string; role: string },
): Promise<string> {
  const { buildMemoryContext } = await import("../../routes/workspace.ts");
  const memCtx = await buildMemoryContext(user);
  return memCtx ?? "";
}

/** Resolve whether a live web search should run for this turn.
 *  Per-message toggle semantics:
 *    - force_web_search === true   → always search.
 *    - force_web_search === false  → never search (admins still search).
 *    - force_web_search === undefined → admins always search, others
 *      follow the configured posture (auto → search, strict → no). */
export async function shouldRunWebSearch(
  userId: string,
  isAdmin: boolean,
  forceWebSearch: boolean | undefined,
): Promise<boolean> {
  if (forceWebSearch === true) return true;
  if (forceWebSearch === false) return isAdmin;
  if (isAdmin) return true;
  const postureRows = await sql<{ posture: string }[]>`
    SELECT posture FROM tool_posture
    WHERE user_id = ${userId}::uuid AND tool_name = 'web_search' LIMIT 1
  `;
  const posture = postureRows[0]?.posture ?? "auto";
  return posture === "auto";
}

/** Run the live web search and return its results + summary. Returns
 *  null sources + null summary when the search provider fails. */
export async function runLiveWebSearch(
  query: string,
  searchUrl: string | undefined,
  isForced: boolean,
  userId: string,
): Promise<{
  sources: SearchSource[];
  summary: SearchSummary | null;
}> {
  try {
    const { callLightpanda } = await import("../chat_search.ts");
    // Pass 8 results to the model — gives it enough context for any
    // query type, not just news.
    const response = await callLightpanda("lightpanda", "", query, 8, { url: searchUrl });
    if (!response) return { sources: [], summary: null };
    const sources: SearchSource[] = response.results.map((r) => ({
      title: r.title,
      url: r.url,
    }));
    const summary: SearchSummary = {
      service: response.service ?? "lightpanda",
      result_count: response.results.length,
      answer: response.answer ?? null,
    };
    void logAudit({
      userId,
      target: response.service ?? "lightpanda",
      action: isForced ? "web_search_forced" : "web_search_auto",
      metadata: {
        query,
        intent: response.intent ?? "general",
        result_count: response.results.length,
        source: "chat_stream",
        trace: JSON.stringify(response.trace ?? []),
      },
    });
    return { sources, summary };
  } catch (err) {
    console.warn("[chat] web_search failed:", (err as Error).message);
    return { sources: [], summary: null };
  }
}

/** Render the search results into the context block that the search-
 *  prompt builder will splice into the system message. */
export function renderSearchContext(
  sources: SearchSource[],
  answer: string | null,
): string {
  if (sources.length === 0) return "";
  return (
    "Web search results:\n" +
    sources
      .map((s, i) => `[${i + 1}] ${s.title}\n${s.url}`)
      .join("\n\n") +
    (answer ? `\n\nDirect answer: ${answer}` : "")
  );
}

/** One-shot helper that assembles retrievedContext from RAG + memory +
 *  (optional) live search. */
export async function assembleRetrievedContext(
  inputs: AssembleContextInputs,
  user: { id: string; role: string },
): Promise<AssembleContextResult> {
  // RAG + memory first (always-on; the agent has the user's notes for
  // every reply).
  let retrievedContext = await retrieveUserKnowledge(inputs.userId, inputs.content);
  const memCtx = await retrieveUserMemory(user);
  if (memCtx) {
    retrievedContext = (retrievedContext ? retrievedContext + "\n\n" : "") + memCtx;
  }
  let searchSources: SearchSource[] = [];
  let searchSummary: SearchSummary | null = null;
  if (await shouldRunWebSearch(inputs.userId, inputs.isAdmin, inputs.forceWebSearch)) {
    const search = await runLiveWebSearch(
      inputs.content,
      inputs.searchUrl,
      inputs.forceWebSearch === true,
      inputs.userId,
    );
    searchSources = search.sources;
    searchSummary = search.summary;
    if (searchSources.length > 0) {
      const ctx = renderSearchContext(searchSources, searchSummary?.answer ?? null);
      retrievedContext += (retrievedContext ? "\n\n" : "") + ctx;
    }
  }
  return { retrievedContext, searchSources, searchSummary };
}