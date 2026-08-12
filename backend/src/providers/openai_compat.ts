// OpenAI-compatible adapter. This works against:
//   - OpenAI itself            (https://api.openai.com/v1)
//   - NVIDIA NIM               (https://integrate.api.nvidia.com/v1)
//   - Local OpenAI-compatible  (lm-studio, ollama --openai, vllm, our fake)
//
// Each upstream exposes the same shape:
//   GET  /models         -> { data: [{ id, ... }] }
//   POST /chat/completions -> SSE stream of { choices: [{ delta: { content } }] }
//
// We deliberately implement streaming via fetch + NDJSON-ish line parsing
// rather than EventSource so we can POST and pass an API key.

import type {
  ProviderAdapter,
  ProviderChatChunk,
  ProviderChatOptions,
  ProviderMessage,
  ProviderModel,
} from "./adapter.ts";

export interface OpenAICompatConfig {
  baseUrl: string;       // e.g. https://api.openai.com/v1
  apiKey: string;
  timeoutMs?: number;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

export class OpenAICompatAdapter implements ProviderAdapter {
  constructor(private cfg: OpenAICompatConfig) {}

  private get base(): string {
    return stripTrailingSlash(this.cfg.baseUrl);
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.cfg.apiKey}`,
      "Content-Type": "application/json",
    };
  }

  async fetchModels(): Promise<ProviderModel[]> {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 15_000);
    try {
      const res = await fetch(`${this.base}/models`, {
        headers: this.headers(),
        signal: ctrl.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`provider /models ${res.status}: ${text.slice(0, 200)}`);
      }
      const body = (await res.json()) as { data?: Array<{ id: string }> };
      const list = body.data ?? [];
      return list.map((m) => ({
        externalId: m.id,
        displayName: m.id,
      }));
    } finally {
      clearTimeout(timeout);
    }
  }

  async *chat(opts: ProviderChatOptions): AsyncIterable<ProviderChatChunk> {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 60_000);
    if (opts.signal) {
      opts.signal.addEventListener("abort", () => ctrl.abort());
    }
    let res: Response;
    try {
      res = await fetch(`${this.base}/chat/completions`, {
        method: "POST",
        headers: this.headers(),
        signal: ctrl.signal,
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
          temperature: opts.temperature ?? 0.7,
          max_tokens: opts.maxTokens ?? 1024,
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
    } catch (err) {
      clearTimeout(timeout);
      yield {
        delta: "",
        done: true,
        promptTokens: 0,
        completionTokens: 0,
      };
      throw new Error(`provider chat failed: ${(err as Error).message}`);
    }
    if (!res.ok || !res.body) {
      clearTimeout(timeout);
      const text = await res.text().catch(() => "");
      yield {
        delta: `[provider ${res.status}] ${text.slice(0, 200)}`,
        done: true,
      };
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let promptTokens: number | undefined;
    let completionTokens: number | undefined;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        // SSE messages are separated by blank lines.
        let nlIdx: number;
        while ((nlIdx = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, nlIdx);
          buffer = buffer.slice(nlIdx + 2);
          for (const line of block.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") {
              yield {
                delta: "",
                done: true,
                promptTokens,
                completionTokens,
              };
              return;
            }
            try {
              const parsed = JSON.parse(payload) as {
                choices?: Array<{ delta?: { content?: string } }>;
                usage?: { prompt_tokens?: number; completion_tokens?: number };
              };
              const piece = parsed.choices?.[0]?.delta?.content;
              if (piece) yield { delta: piece, done: false };
              if (parsed.usage) {
                promptTokens = parsed.usage.prompt_tokens;
                completionTokens = parsed.usage.completion_tokens;
              }
            } catch {
              // Some providers send keepalive comments or partial JSON;
              // ignore them and keep streaming.
            }
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
    yield {
      delta: "",
      done: true,
      promptTokens,
      completionTokens,
    };
  }
}

// Helper: convert a stored message array into the wire shape.
export function toOpenAIMessages(
  msgs: Array<{ role: "user" | "assistant" | "system"; content: string }>,
): ProviderMessage[] {
  return msgs.map((m) => ({ role: m.role, content: m.content }));
}