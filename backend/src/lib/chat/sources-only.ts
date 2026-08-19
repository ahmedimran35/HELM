// Sources-only refetch fallback (chat.ts auto re-query without search).
//
// Some models, when handed a hard search-prompt override, will return
// only the "## Sources" section and skip the body — the user then sees
// a list of URLs and reads it as "the AI didn't respond". To avoid
// that, we detect the sources-only shape (body stripped of the Sources
// section is < 20 chars AND a "## Sources" heading exists) and re-query
// the same model WITHOUT the search context. The re-query uses a
// softened system note that tells the model to answer the user directly
// without re-running search.
//
// We then re-append the Sources section to the re-queried response so
// the user still gets the citations. The chat UI is notified via an
// SSE `refetch` event so it can surface "AI re-queried without search"
// rather than just looking like a slow first response.
//
// All operations are best-effort: if the fallback call fails, we keep
// the original sources-only response and log a warning.

import type { SSEStreamingApi } from "hono/streaming";
import type { Harness, HarnessMessage } from "../../harness/types.ts";

export interface SourcesOnlyInputs {
  harness: Harness;
  /** Messages array as built up to this point (system + user). The
   *  system message is rewritten to soften the search override. */
  messages: HarnessMessage[];
  /** The list of search-result URLs we tried to cite. */
  searchSources: Array<{ title: string; url: string }>;
  /** The text the model assembled before the refetch decision. */
  assembled: string;
  /** Model external id to send to the harness. */
  externalId: string;
  /** The user's `system` body param (if any). */
  system?: string;
  /** Abort signal — forwarded to the fallback harness call. */
  signal: AbortSignal;
}

export interface SourcesOnlyResult {
  /** Whether a refetch actually happened. When false, the original
   *  inputs are echoed back unchanged. */
  refetched: boolean;
  /** The (possibly appended) assembled text after the refetch. */
  assembled: string;
  /** Updated prompt / completion token counts from the refetch. */
  promptTokens?: number;
  completionTokens?: number;
  /** True when the refetch injected a real-time Sources block. */
  hasRealtimeSources: boolean;
  /** Wall-clock ms spent on the fallback call (only set when refetched). */
  fallbackMs?: number;
}

/** Decide whether the assembled text looks "sources-only" (just the
 *  Sources section with no real body). Body is considered empty when,
 *  after stripping the trailing Sources block, fewer than 20 chars remain
 *  AND the assembled text actually contains a Sources heading. */
export function isSourcesOnlyResponse(assembled: string): boolean {
  const bodyOnly = assembled.replace(/##\s+Sources[\s\S]*$/im, "").trim();
  return bodyOnly.length < 20 && /##\s+Sources/im.test(assembled);
}

/** If the assembled reply is a sources-only response, re-query the
 *  model without the search context and re-append the Sources block.
 *
 *  When `assembled` is a normal (non-sources-only) reply, the call is
 *  a no-op and the inputs are echoed back. */
export async function refetchIfSourcesOnly(
  inputs: SourcesOnlyInputs,
  stream: SSEStreamingApi,
): Promise<SourcesOnlyResult> {
  const {
    harness,
    messages,
    searchSources,
    externalId,
    system,
    signal,
  } = inputs;
  // No-op when there's no search context (nothing to append later)
  // or when the reply is already a normal body — saves a useless call.
  if (
    searchSources.length === 0 ||
    !isSourcesOnlyResponse(inputs.assembled)
  ) {
    return {
      refetched: false,
      assembled: inputs.assembled,
      promptTokens: undefined,
      completionTokens: undefined,
      hasRealtimeSources: false,
    };
  }

  const fallbackStart = Date.now();
  // Soften the system override for the re-query: tell the model the
  // previous search yielded no useful body and to answer directly
  // without re-running the search.
  const fallbackMessages = messages.map((m) =>
    m.role === "system"
      ? {
          role: "system" as const,
          content: `${m.content}\n\n[NOTE: the previous live-web search returned no useful body text. Reply to the user's question directly without re-running the search.]`,
        }
      : m,
  );
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  let assembled = inputs.assembled;
  try {
    const fallback = harness.chat({
      model: externalId,
      messages: fallbackMessages,
      system,
      signal,
    });
    for await (const fchunk of fallback) {
      if (fchunk.done) {
        if (typeof fchunk.prompt_tokens === "number") {
          promptTokens = fchunk.prompt_tokens;
        }
        if (typeof fchunk.completion_tokens === "number") {
          completionTokens = fchunk.completion_tokens;
        }
        break;
      }
      if (fchunk.delta) {
        assembled += fchunk.delta;
        await stream.writeSSE({
          event: "token",
          data: JSON.stringify({ delta: fchunk.delta }),
        });
      }
    }
    // Now re-append the Sources section at the end of the
    // re-queried response so the user still gets the citations.
    const sourcesBlock = searchSources
      .map((s) => `- [${s.title}](${s.url})`)
      .join("\n");
    const addition = "\n\n## Sources\n" + sourcesBlock + "\n";
    assembled += addition;
    await stream.writeSSE({
      event: "token",
      data: JSON.stringify({ delta: addition }),
    });
    // Notify the client that we did a re-query so the chat UI can
    // surface "AI re-queried without search" rather than just
    // looking like a slow first response.
    await stream.writeSSE({
      event: "refetch",
      data: JSON.stringify({
        reason: "sources_only",
        ms: Date.now() - fallbackStart,
      }),
    });
    return {
      refetched: true,
      assembled,
      promptTokens,
      completionTokens,
      hasRealtimeSources: true,
      fallbackMs: Date.now() - fallbackStart,
    };
  } catch (err) {
    // Fallback failed — keep the original sources-only response.
    console.warn("[chat] sources-only refetch failed:", (err as Error).message);
    return {
      refetched: false,
      assembled: inputs.assembled,
      promptTokens: undefined,
      completionTokens: undefined,
      hasRealtimeSources: false,
    };
  }
}