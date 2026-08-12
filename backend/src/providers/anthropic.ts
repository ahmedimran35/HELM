// Anthropic adapter. They have a different wire shape than OpenAI:
//   - endpoint is /v1/messages (not /v1/chat/completions)
//   - system prompt is a top-level `system` field, not a message
//   - SSE events are typed (event: content_block_delta ...) rather than
//     the OpenAI "data: {...}" line
//
// We translate on the way in and out so the rest of the backend only sees
// ProviderAdapter.

import type {
  ProviderAdapter,
  ProviderChatChunk,
  ProviderChatOptions,
  ProviderModel,
} from "./adapter.ts";

export interface AnthropicConfig {
  baseUrl?: string; // default https://api.anthropic.com
  apiKey: string;
  timeoutMs?: number;
}

export class AnthropicAdapter implements ProviderAdapter {
  constructor(private cfg: AnthropicConfig) {}

  private get base(): string {
    const b = this.cfg.baseUrl ?? "https://api.anthropic.com";
    return b.endsWith("/") ? b.slice(0, -1) : b;
  }

  async fetchModels(): Promise<ProviderModel[]> {
    // Anthropic has no list-models endpoint; we ship a known list.
    return [
      { externalId: "claude-opus-4-20250514", displayName: "Claude Opus 4" },
      { externalId: "claude-sonnet-4-20250514", displayName: "Claude Sonnet 4" },
      { externalId: "claude-3-5-haiku-latest", displayName: "Claude 3.5 Haiku" },
    ];
  }

  async *chat(opts: ProviderChatOptions): AsyncIterable<ProviderChatChunk> {
    const system = opts.messages.find((m) => m.role === "system")?.content;
    const rest = opts.messages.filter((m) => m.role !== "system");
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), this.cfg.timeoutMs ?? 60_000);
    if (opts.signal) opts.signal.addEventListener("abort", () => ctrl.abort());

    let res: Response;
    try {
      res = await fetch(`${this.base}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": this.cfg.apiKey,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: opts.model,
          system: system ?? undefined,
          messages: rest.map((m) => ({ role: m.role, content: m.content })),
          max_tokens: opts.maxTokens ?? 1024,
          temperature: opts.temperature ?? 0.7,
          stream: true,
        }),
      });
    } catch (err) {
      clearTimeout(timeout);
      throw new Error(`anthropic chat failed: ${(err as Error).message}`);
    }
    if (!res.ok || !res.body) {
      clearTimeout(timeout);
      const text = await res.text().catch(() => "");
      yield {
        delta: `[anthropic ${res.status}] ${text.slice(0, 200)}`,
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
        let nlIdx: number;
        while ((nlIdx = buffer.indexOf("\n\n")) >= 0) {
          const block = buffer.slice(0, nlIdx);
          buffer = buffer.slice(nlIdx + 2);
          let eventType = "message";
          let data = "";
          for (const line of block.split("\n")) {
            if (line.startsWith("event:")) eventType = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (eventType === "content_block_delta") {
            try {
              const parsed = JSON.parse(data) as {
                delta?: { type?: string; text?: string };
              };
              if (parsed.delta?.type === "text_delta" && parsed.delta.text) {
                yield { delta: parsed.delta.text, done: false };
              }
            } catch {
              /* ignore */
            }
          } else if (eventType === "message_delta") {
            try {
              const parsed = JSON.parse(data) as {
                usage?: { output_tokens?: number };
              };
              if (parsed.usage?.output_tokens !== undefined) {
                completionTokens = parsed.usage.output_tokens;
              }
            } catch {
              /* ignore */
            }
          } else if (eventType === "message_start") {
            try {
              const parsed = JSON.parse(data) as {
                message?: { usage?: { input_tokens?: number } };
              };
              promptTokens = parsed.message?.usage?.input_tokens;
            } catch {
              /* ignore */
            }
          } else if (eventType === "message_stop") {
            yield {
              delta: "",
              done: true,
              promptTokens,
              completionTokens,
            };
            return;
          }
        }
      }
    } finally {
      clearTimeout(timeout);
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
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