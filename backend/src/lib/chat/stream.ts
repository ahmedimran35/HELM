// SSE streaming helpers for the chat route.
//
// Centralises every SSE event the chat route emits so the protocol
// contract is in one place. The protocol is:
//
//   token     — incremental assistant delta (JSON: { delta: string })
//   done      — stream complete     (JSON: { prompt_tokens, completion_tokens })
//   error     — fatal error          (JSON: { message: string })
//   cached    — replay from response cache   (JSON: { id, hit_count, model })
//   search    — search summary emitted (JSON: { service, result_count, has_answer })
//   refetch   — model re-query (sources-only fallback)  (JSON: { reason, ms })
//   ping      — heartbeat (JSON: string — epoch ms)
//
// New event types MUST be added here so all routes stay in lock-step
// with the chat UI.

import type { SSEStreamingApi } from "hono/streaming";
import type { ChatChunk } from "../../harness/types.ts";
import type { CachedResponse } from "../response-cache.ts";

/** Emit a `token` event with the supplied delta. */
export async function writeDelta(stream: SSEStreamingApi, delta: string): Promise<void> {
  await stream.writeSSE({
    event: "token",
    data: JSON.stringify({ delta }),
  });
}

/** Emit a `done` event with the final token counts. */
export async function writeDone(
  stream: SSEStreamingApi,
  promptTokens: number,
  completionTokens: number,
): Promise<void> {
  await stream.writeSSE({
    event: "done",
    data: JSON.stringify({ prompt_tokens: promptTokens, completion_tokens: completionTokens }),
  });
}

/** Emit a fatal `error` event. The message is intentionally generic so
 *  we never leak internal error detail to the client. */
export async function writeError(
  stream: SSEStreamingApi,
  message = "Chat error",
): Promise<void> {
  await stream.writeSSE({
    event: "error",
    data: JSON.stringify({ message }),
  });
}

/** Emit a `cached` event announcing the upcoming cache replay. */
export async function writeCached(
  stream: SSEStreamingApi,
  cached: CachedResponse,
): Promise<void> {
  await stream.writeSSE({
    event: "cached",
    data: JSON.stringify({
      id: cached.id,
      hit_count: cached.hit_count + 1,
      model: cached.model,
    }),
  });
}

/** Emit a `search` event with the search summary so the chat UI can
 *  show a "searched the web" banner. */
export async function writeSearchSummary(
  stream: SSEStreamingApi,
  summary: {
    service: string;
    result_count: number;
    answer: string | null;
  },
): Promise<void> {
  await stream.writeSSE({
    event: "search",
    data: JSON.stringify({
      service: summary.service,
      result_count: summary.result_count,
      has_answer: !!summary.answer,
    }),
  });
}

/** Emit a `refetch` event (the sources-only re-query fallback). */
export async function writeRefetch(
  stream: SSEStreamingApi,
  reason: string,
  ms: number,
): Promise<void> {
  await stream.writeSSE({
    event: "refetch",
    data: JSON.stringify({ reason, ms }),
  });
}

/** Emit a `ping` heartbeat frame. */
export async function writePing(stream: SSEStreamingApi): Promise<void> {
  await stream.writeSSE({ event: "ping", data: String(Date.now()) });
}

/** SSE heartbeat — every `intervalMs` write a tiny "ping" frame so the
 *  HTTP layer (Bun, proxies, browsers) doesn't time the stream out
 *  during a long web search or a slow first-token model response.
 *  Big questions like "top 5 cyber news for today" can take 30–60 s
 *  end-to-end. Returns a `stop()` function the caller MUST call in a
 *  `finally` block. */
export function startHeartbeat(
  stream: SSEStreamingApi,
  intervalMs = 15_000,
): () => void {
  const timer = setInterval(() => {
    writePing(stream).catch(() => {
      // Connection dropped — clear will fire next tick.
    });
  }, intervalMs);
  return () => clearInterval(timer);
}

/** Stream the cached body in chunks so the UI behaves the same as a
 *  real reply. We pick 80 chars per delta — small enough to feel
 *  live, large enough not to flood. */
export async function replayCachedTokens(
  stream: SSEStreamingApi,
  text: string,
  chunkSize = 80,
): Promise<void> {
  for (let i = 0; i < text.length; i += chunkSize) {
    await stream.writeSSE({
      event: "token",
      data: JSON.stringify({ delta: text.slice(i, i + chunkSize) }),
    });
  }
}

/** Drain a harness chunk iterable to the SSE stream, accumulating the
 *  assembled text and capturing final token counts. Returns the
 *  accumulated body + the prompt/completion token numbers from the
 *  terminal chunk (if any). */
export async function consumeStreamToSSE(
  stream: SSEStreamingApi,
  chunks: AsyncIterable<ChatChunk>,
): Promise<{
  assembled: string;
  promptTokens?: number;
  completionTokens?: number;
}> {
  let assembled = "";
  let promptTokens: number | undefined;
  let completionTokens: number | undefined;
  for await (const chunk of chunks) {
    if (chunk.done) {
      promptTokens = chunk.prompt_tokens;
      completionTokens = chunk.completion_tokens;
      break;
    }
    if (chunk.delta) {
      assembled += chunk.delta;
      await writeDelta(stream, chunk.delta);
    }
  }
  return { assembled, promptTokens, completionTokens };
}