// Pluggable agent harness — runtime abstraction for P2 (qm-parity).
//
// A "harness" wraps a model runtime behind a single interface so the
// chat route (and any other caller) can route to OpenAI-compat,
// Anthropic, a CLI binary, the future Pi runtime, or a mock without
// caring which one is actually answering. The seam is intentionally
// tiny — every harness exposes:
//   - kind:       discriminator for telemetry + UI
//   - chat():     stream a completion as `ChatChunk` deltas
//   - listModels(): the set of model ids this harness can serve
//
// chat() returns an AsyncIterable so the SSE handler in routes/chat.ts
// can `for await` the same way it does for the legacy ProviderAdapter
// (see providers/openai_compat.ts for the streaming pattern). Token
// counts are reported on the final chunk (`done: true`) so callers
// can persist them after the stream closes.

export type HarnessKind = "openai" | "anthropic" | "mock" | "pi" | "cli";

export type HarnessRole = "system" | "user" | "assistant";

export interface HarnessMessage {
  role: HarnessRole;
  content: string;
}

export interface ChatRequest {
  model: string;
  system?: string;
  messages: HarnessMessage[];
  tools?: unknown[];
  temperature?: number;
  /** Hard cap for harness runs that need an explicit limit (Anthropic). */
  maxTokens?: number;
  /** Abort signal — when triggered, harnesses must stop streaming. */
  signal?: AbortSignal;
}

export interface ChatChunk {
  /** Token delta to forward to the SSE client. Empty on the final chunk. */
  delta?: string;
  /** Cumulative prompt tokens. Reported once, usually on the final chunk. */
  prompt_tokens?: number;
  /** Cumulative completion tokens. Reported once, usually on the final chunk. */
  completion_tokens?: number;
  /** True on the terminal chunk — caller should `break` out of the loop. */
  done: boolean;
  /** Soft error surfaced inline; the chunk is still marked done. */
  error?: string;
}

export interface Harness {
  kind: HarnessKind;
  /** Human label for the UI badge ("openai", "anthropic", ...). */
  label: string;
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;
  listModels(): Promise<string[]>;
  /** Cheap reachability/credentials check. Defaults to "ok" when unused. */
  status(): Promise<{ configured: boolean; reason?: string }>;
}

export const HARNESS_KINDS: readonly HarnessKind[] = [
  "openai",
  "anthropic",
  "mock",
  "pi",
  "cli",
] as const;

export function isHarnessKind(s: string): s is HarnessKind {
  return (HARNESS_KINDS as readonly string[]).includes(s);
}
