// Provider adapter interface. Every AI provider we wire in implements
// this shape so the rest of the backend never has to know whether it's
// talking to OpenAI, Anthropic, NVIDIA NIM, or some OpenAI-compatible
// clone. Tests run against `FakeOpenAIProvider` (see ./fake.ts) without
// needing real API keys.
//
// The contract is intentionally minimal:
//   - fetchModels(): list what's available right now
//   - chat():       send a conversation, get back a stream of tokens
//
// `chat()` returns an async iterable so the chat route can pipe tokens
// straight into the SSE response without buffering.

export interface ProviderModel {
  externalId: string;
  displayName: string;
  contextWindow?: number;
  inputPricePer1k?: number;
  outputPricePer1k?: number;
}

export interface ProviderMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ProviderChatOptions {
  model: string;
  messages: ProviderMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface ProviderChatChunk {
  // Token delta. Empty `delta` indicates end-of-stream.
  delta: string;
  // Cumulative token counts so we can persist into audit_log on close.
  promptTokens?: number;
  completionTokens?: number;
  done: boolean;
}

export interface ProviderAdapter {
  /** Quick reachability / credentials check. */
  fetchModels(): Promise<ProviderModel[]>;
  /** Stream a chat completion. Throws on hard failure; soft errors
      mid-stream are returned as the final chunk's `done` + `delta`. */
  chat(opts: ProviderChatOptions): AsyncIterable<ProviderChatChunk>;
}