// Search-aware system-prompt builder for the 1:1 chat route.
//
// When the user's question triggered a live-web search (or hit RAG context),
// we prepend a system message that:
//
//   1. Tells the model a real-time search was performed and lists the
//      most current, on-topic results as context.
//   2. Specifies the MANDATORY reply shape (markdown heading, bold lead,
//      bullet/numbered lists as needed, and an explicit "## Sources"
//      section listing every URL cited).
//   3. Applies an intent-aware framing rule so the model picks the right
//      shape based on what the user actually asked for (list, comparison,
//      how/why, creative, factual, news, or general).
//
// The "memory priority" reminder is also baked in: when memory entries
// are present in the context, the project memory wins over general web
// knowledge — even if the search results describe a different X.
//
// The returned system message is intended to be `unshift`ed onto the
// messages array so the model sees it before any prior system message.

import type { HarnessMessage } from "../../harness/types.ts";
import { classifyQuery, extractListCount } from "../web_search.ts";

/** All the inputs `buildSearchSystemPrompt` needs to render the
 *  system override. The function is pure (no DB / no I/O) so callers
 *  can construct it once and reuse. */
export interface SearchPromptInputs {
  /** The user's question. Used to detect "top N" list intent. */
  query: string;
  /** The rendered RAG + memory + (optional) search result context. */
  retrievedContext: string;
  /** The pre-existing system message body (if the caller passed
   *  `system` in the request body), so we can prefix it. */
  existingSystemContent?: string;
}

/** Build the search-aware system override message. Returns a single
 *  `HarnessMessage` ready to be `unshift`ed onto the messages array. */
export function buildSearchSystemPrompt(
  inputs: SearchPromptInputs,
): HarnessMessage {
  const { query, retrievedContext } = inputs;
  const existing = inputs.existingSystemContent ?? "";
  const prefix = existing ? `${existing}\n\n` : "";

  // Per-intent framing rules. The model picks the right shape based
  // on what the user actually asked for.
  const requestedN = extractListCount(query);
  const intent = classifyQuery(query);
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

  return {
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
      `5. DO NOT emit a "## Sources" heading. The server appends a complete, ordered Sources section at the end of your reply automatically. Writing your own duplicates them.\n` +
      `6. If the search returned nothing useful, write the answer and the server will show "no fresh web results available" in place of Sources.\n` +
      `Do not mention "training data" in your reply. Render the reply as proper markdown — never output raw asterisks for emphasis.\n\n` +
      `${retrievedContext}`,
  };
}