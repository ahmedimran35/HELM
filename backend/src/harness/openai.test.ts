// Unit tests for the OpenAI-compat SSE stream parser
// (harness/openai.ts#parseOpenAIStream) — every OpenAI-compatible
// provider (OpenAI, NVIDIA NIM, vLLM, lm-studio, OpenRouter) rides
// this exact code path in 1:1 chat.
//
// The parser must tolerate: SSE frames split across arbitrary network
// read boundaries, [DONE] sentinels, usage payloads on the final
// frame, and malformed/partial JSON lines.

import { describe, test, expect } from "bun:test";
import { parseOpenAIStream } from "./openai.ts";
import type { ChatChunk } from "./types.ts";

/** Build a reader that emits the SSE body in fixed-size chunks —
 *  simulating TCP/TLS read boundaries landing mid-frame. */
function chunkedReader(sse: string, chunkSize = 7): ReadableStreamDefaultReader<Uint8Array> {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  for (let i = 0; i < sse.length; i += chunkSize) {
    parts.push(enc.encode(sse.slice(i, i + chunkSize)));
  }
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i < parts.length) controller.enqueue(parts[i++]!);
      else controller.close();
    },
  }).getReader();
}

async function collect(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of parseOpenAIStream(reader)) out.push(c);
  return out;
}

const FRAME = (delta: string) =>
  `data: {"choices":[{"delta":{"content":${JSON.stringify(delta)}}}]}\n\n`;

describe("parseOpenAIStream", () => {
  test("yields deltas in order then done with token counts", async () => {
    const sse =
      FRAME("Hello") +
      FRAME(" world") +
      `data: {"choices":[{"delta":{}}],"usage":{"prompt_tokens":11,"completion_tokens":2}}\n\n` +
      "data: [DONE]\n\n";
    const chunks = await collect(chunkedReader(sse));
    expect(chunks).toEqual([
      { delta: "Hello", done: false },
      { delta: " world", done: false },
      { done: true, prompt_tokens: 11, completion_tokens: 2 },
    ]);
  });

  test("handles frames split across tiny network reads", async () => {
    // chunkSize=3 slices every JSON frame into many partial reads —
    // the parser must buffer and only emit complete frames.
    const sse = FRAME("a") + FRAME("b") + "data: [DONE]\n\n";
    const chunks = await collect(chunkedReader(sse, 3));
    expect(chunks.filter((c) => c.delta)).toEqual([
      { delta: "a", done: false },
      { delta: "b", done: false },
    ]);
    expect(chunks.at(-1)?.done).toBe(true);
  });

  test("single-read body (whole stream in one chunk)", async () => {
    const sse = FRAME("x") + "data: [DONE]\n\n";
    const chunks = await collect(chunkedReader(sse, 10_000));
    expect(chunks).toEqual([
      { delta: "x", done: false },
      { done: true, prompt_tokens: undefined, completion_tokens: undefined },
    ]);
  });

  test("ignores malformed JSON lines without dying", async () => {
    const sse =
      "data: {broken json\n\n" +
      FRAME("ok") +
      "data: [DONE]\n\n";
    const chunks = await collect(chunkedReader(sse));
    expect(chunks.some((c) => c.delta === "ok")).toBe(true);
    expect(chunks.at(-1)?.done).toBe(true);
  });

  test("stream ending without [DONE] still yields done", async () => {
    // Upstream closed mid-stream — parser must terminate the iterator
    // with a done chunk so the chat route persists what it received.
    const chunks = await collect(chunkedReader(FRAME("partial")));
    expect(chunks.at(-1)?.done).toBe(true);
    expect(chunks.some((c) => c.delta === "partial")).toBe(true);
  });

  test("ignores non-data SSE lines (comments, event:, empty)", async () => {
    const sse = ": keep-alive\n\nevent: ping\n\n" + FRAME("v") + "data: [DONE]\n\n";
    const chunks = await collect(chunkedReader(sse));
    expect(chunks.filter((c) => c.delta).length).toBe(1);
  });

  test("empty deltas (role-only first frame) produce no chunk", async () => {
    // OpenAI sends {"delta":{"role":"assistant"}} first — no content.
    const sse =
      `data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n` +
      FRAME("hi") +
      "data: [DONE]\n\n";
    const chunks = await collect(chunkedReader(sse));
    expect(chunks.filter((c) => c.delta)).toEqual([{ delta: "hi", done: false }]);
  });
});
