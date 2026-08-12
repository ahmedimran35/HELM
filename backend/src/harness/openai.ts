// OpenAI-compat harness. Talks to any service that implements the
// OpenAI `/v1/chat/completions` shape — OpenAI itself, NVIDIA NIM,
// vLLM, lm-studio, OpenRouter, etc.
//
// Credentials + base URL are pulled from the first active provider
// of type 'openai' or 'openai-compatible' (or, for the OpenAI public
// API, type 'openai' uses the canonical base). If none is configured
// the harness reports `configured: false` and `listModels()` returns
// an empty list — the chat route still works against `mock` for demos.

import { sql } from "../db/client.ts";
import { decryptSecret } from "../providers/crypto.ts";
import { assertSafeBaseUrl } from "../providers/registry.ts";
import type { ChatChunk, ChatRequest, Harness } from "./types.ts";

const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";

interface OpenAIProviderRow {
  id: string;
  type: string;
  base_url: string;
  api_key_encrypted: string;
}

async function pickOpenAIProvider(): Promise<{
  baseUrl: string;
  apiKey: string;
} | null> {
  // Prefer a configured openai-compatible provider so admins can point
  // HELM at any third-party (NVIDIA NIM, OpenRouter, lm-studio). Fall
  // back to a dedicated 'openai' row if one exists, then to the public
  // endpoint if OPENAI_API_KEY is set in the env.
  const rows = await sql<OpenAIProviderRow[]>`
    SELECT id, type, base_url, api_key_encrypted FROM providers
    WHERE type IN ('openai', 'openai-compatible', 'nvidia-nim')
    ORDER BY (type = 'openai') DESC, added_at ASC
    LIMIT 1
  `;
  const row = rows[0];
  if (row) {
    const apiKey = decryptSecret(row.api_key_encrypted);
    const baseUrl =
      row.type === "openai"
        ? DEFAULT_OPENAI_BASE
        : normalizeBase(row.base_url);
    return { baseUrl, apiKey };
  }
  const envKey = process.env.OPENAI_API_KEY;
  if (envKey && envKey.length > 0) {
    return { baseUrl: DEFAULT_OPENAI_BASE, apiKey: envKey };
  }
  return null;
}

function normalizeBase(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

class OpenAIHarness implements Harness {
  readonly kind = "openai" as const;
  readonly label = "openai";

  private async cfg(): Promise<{ baseUrl: string; apiKey: string } | null> {
    return pickOpenAIProvider();
  }

  async status(): Promise<{ configured: boolean; reason?: string }> {
    const cfg = await this.cfg();
    if (!cfg) return { configured: false, reason: "no_openai_provider" };
    return { configured: true };
  }

  async listModels(): Promise<string[]> {
    const cfg = await this.cfg();
    if (!cfg) return [];
    // Try the upstream /models endpoint first.
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10_000);
      const res = await fetch(`${cfg.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${cfg.apiKey}` },
        signal: ctrl.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return [];
      const body = (await res.json()) as { data?: Array<{ id: string }> };
      return (body.data ?? []).map((m) => m.id);
    } catch {
      return [];
    }
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const cfg = await this.cfg();
    if (!cfg) {
      yield {
        delta: "[openai harness not configured — add an OpenAI-compatible provider]",
        done: true,
        error: "not_configured",
      };
      return;
    }
    try {
      await assertSafeBaseUrl(cfg.baseUrl, { allowAnyPort: true });
    } catch (err) {
      yield {
        delta: `[openai ${(err as Error).message}]`,
        done: true,
        error: "unsafe_base_url",
      };
      return;
    }
    const messages = req.system
      ? [{ role: "system" as const, content: req.system }, ...req.messages]
      : req.messages;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    if (req.signal) req.signal.addEventListener("abort", () => ctrl.abort());
    let res: Response;
    try {
      res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          "Content-Type": "application/json",
        },
        signal: ctrl.signal,
        body: JSON.stringify({
          model: req.model,
          messages,
          temperature: req.temperature ?? 0.7,
          max_tokens: req.maxTokens ?? 1024,
          stream: true,
          stream_options: { include_usage: true },
        }),
      });
    } catch (err) {
      clearTimeout(timer);
      yield {
        delta: `[openai fetch failed: ${(err as Error).message}]`,
        done: true,
        error: "fetch_failed",
      };
      return;
    }
    clearTimeout(timer);
    if (!res.ok || !res.body) {
      const text = await res.text().catch(() => "");
      yield {
        delta: `[openai ${res.status}] ${text.slice(0, 200)}`,
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
          for (const line of block.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const payload = trimmed.slice(5).trim();
            if (payload === "[DONE]") {
              yield { done: true, prompt_tokens: promptTokens, completion_tokens: completionTokens };
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
              /* ignore partial JSON */
            }
          }
        }
      }
    } finally {
      try {
        reader.releaseLock();
      } catch {
        /* already released */
      }
    }
    yield { done: true, prompt_tokens: promptTokens, completion_tokens: completionTokens };
  }
}

export const openaiHarness: Harness = new OpenAIHarness();
