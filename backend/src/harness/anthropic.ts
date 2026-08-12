// Anthropic harness. Hits /v1/messages with the `anthropic-version`
// header + a required `max_tokens`. SSE events are typed
// (event: content_block_delta) rather than the OpenAI "data: {...}"
// line — we translate on the way out so callers see the same shape
// as the OpenAI harness.

import { sql } from "../db/client.ts";
import { decryptSecret } from "../providers/crypto.ts";
import { assertSafeBaseUrl } from "../providers/registry.ts";
import type { ChatChunk, ChatRequest, Harness } from "./types.ts";

const ANTHROPIC_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

interface AnthropicProviderRow {
  api_key_encrypted: string;
  base_url: string | null;
}

async function pickAnthropicCreds(): Promise<{
  baseUrl: string;
  apiKey: string;
} | null> {
  const rows = await sql<AnthropicProviderRow[]>`
    SELECT api_key_encrypted, base_url FROM providers
    WHERE type = 'anthropic'
    ORDER BY added_at ASC LIMIT 1
  `;
  const row = rows[0];
  if (row) {
    const baseUrl = (row.base_url ?? ANTHROPIC_BASE).replace(/\/$/, "");
    // Validate baseUrl — admin-tampered row could otherwise pivot
    // every Anthropic chat to an attacker-controlled server (this
    // harness previously bypassed the assertSafeBaseUrl guard).
    try {
      await assertSafeBaseUrl(baseUrl, { allowAnyPort: true });
    } catch {
      return null;
    }
    return { baseUrl, apiKey: decryptSecret(row.api_key_encrypted) };
  }
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (envKey && envKey.length > 0) {
    return { baseUrl: ANTHROPIC_BASE, apiKey: envKey };
  }
  return null;
}

class AnthropicHarness implements Harness {
  readonly kind = "anthropic" as const;
  readonly label = "anthropic";

  async status(): Promise<{ configured: boolean; reason?: string }> {
    const c = await pickAnthropicCreds();
    if (!c) return { configured: false, reason: "no_anthropic_provider" };
    return { configured: true };
  }

  async listModels(): Promise<string[]> {
    // Anthropic has no list-models endpoint — ship the known set.
    return [
      "claude-opus-4-20250514",
      "claude-sonnet-4-20250514",
      "claude-3-5-sonnet-latest",
      "claude-3-5-haiku-latest",
    ];
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const cfg = await pickAnthropicCreds();
    if (!cfg) {
      yield {
        delta: "[anthropic harness not configured — add an Anthropic provider]",
        done: true,
        error: "not_configured",
      };
      return;
    }
    const system =
      req.system ?? req.messages.find((m) => m.role === "system")?.content;
    const rest = req.messages.filter((m) => m.role !== "system");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    if (req.signal) req.signal.addEventListener("abort", () => ctrl.abort());
    let res: Response;
    try {
      res = await fetch(`${cfg.baseUrl}/v1/messages`, {
        method: "POST",
        headers: {
          "x-api-key": cfg.apiKey,
          "anthropic-version": ANTHROPIC_VERSION,
          "Content-Type": "application/json",
        },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: req.model,
          system: system ?? undefined,
          messages: rest.map((m) => ({ role: m.role, content: m.content })),
          max_tokens: req.maxTokens ?? 1024,
          temperature: req.temperature ?? 0.7,
          stream: true,
        }),
      });
    } catch (err) {
      clearTimeout(timer);
      yield {
        delta: `[anthropic fetch failed: ${(err as Error).message}]`,
        done: true,
        error: "fetch_failed",
      };
      return;
    }
    clearTimeout(timer);
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      yield {
        delta: `[anthropic ${res.status}] ${text.slice(0, 200)}`,
        done: true,
        error: `http_${res.status}`,
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
              done: true,
              prompt_tokens: promptTokens,
              completion_tokens: completionTokens,
            };
            return;
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* ignore */
      }
    }
    yield { done: true, prompt_tokens: promptTokens, completion_tokens: completionTokens };
  }
}

export const anthropicHarness: Harness = new AnthropicHarness();
