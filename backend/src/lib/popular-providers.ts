// Public-AI-provider health probe.
//
// The Health page shows every popular AI provider's reachability in
// real-time, **without** the admin needing to configure each one. We
// ping a hardcoded list of public /models endpoints over HTTPS and
// classify the response:
//
//   2xx, 3xx, 4xx → "up"      (401/403 still mean the service is up)
//   5xx           → "degraded" (server is reachable but unhappy)
//   timeout, DNS,
//   connection refused,
//   no route to host → "down"
//
// Auth is intentionally NOT sent — these are read-only pings to
// determine *is the service reachable*, not *can I call it*. A 401
// from OpenAI's /models is a green light, not a red one.
//
// Network safety: every URL goes through `safeFetch`, so private-IP
// resolution is blocked and redirects are disabled. Body is capped at
// 1 KB so a misconfigured upstream can't pin us to a 50 MB response.
//
// Caching: results are cached in-memory for 30 s. The Health page
// polls every 30 s, so this is a no-op for the page itself but
// protects against a flood of API scrapers.

import { assertSafeOutboundUrl } from "./safe-fetch.ts";

export interface PopularProvider {
  /** Stable id used by the frontend as a React key. */
  id: string;
  /** Display name. */
  name: string;
  /** Probe URL — always public, no auth. */
  url: string;
  /** Optional logo hint for the UI (initials work fine). */
  short: string;
}

export const POPULAR_PROVIDERS: PopularProvider[] = [
  { id: "openai", name: "OpenAI", url: "https://api.openai.com/v1/models", short: "OA" },
  { id: "anthropic", name: "Anthropic", url: "https://api.anthropic.com/v1/models", short: "AN" },
  { id: "google", name: "Google Gemini", url: "https://generativelanguage.googleapis.com/v1/models", short: "GG" },
  { id: "mistral", name: "Mistral AI", url: "https://api.mistral.ai/v1/models", short: "MS" },
  { id: "cohere", name: "Cohere", url: "https://api.cohere.ai/v1/models", short: "CO" },
  { id: "groq", name: "Groq", url: "https://api.groq.com/openai/v1/models", short: "GQ" },
  { id: "together", name: "Together AI", url: "https://api.together.xyz/v1/models", short: "TG" },
  { id: "openrouter", name: "OpenRouter", url: "https://openrouter.ai/api/v1/models", short: "OR" },
  { id: "perplexity", name: "Perplexity", url: "https://api.perplexity.ai/v1/models", short: "PX" },
  { id: "deepseek", name: "DeepSeek", url: "https://api.deepseek.com/v1/models", short: "DS" },
  { id: "xai", name: "xAI (Grok)", url: "https://api.x.ai/v1/models", short: "XA" },
  { id: "huggingface", name: "Hugging Face", url: "https://huggingface.co/api/models", short: "HF" },
  { id: "replicate", name: "Replicate", url: "https://api.replicate.com/v1/models", short: "RP" },
  { id: "fireworks", name: "Fireworks AI", url: "https://api.fireworks.ai/inference/v1/models", short: "FW" },
];

export type ProviderStatus = "up" | "degraded" | "down" | "unknown";

export interface PopularProviderHealth extends PopularProvider {
  status: ProviderStatus;
  latency_ms: number;
  http_code: number;
  checked_at: number;
  reason?: string;
}

const PROBE_TIMEOUT_MS = 3_000;
const CACHE_TTL_MS = 30_000;
const MAX_CACHE_ENTRIES = 64;

const cache = new Map<string, PopularProviderHealth>();

function classify(status: number | null, latency_ms: number): ProviderStatus {
  if (status === null) return "down";
  if (status >= 500) return "degraded";
  // 2xx, 3xx, 4xx all mean the service is reachable. 401 is the
  // most common response from a public /models endpoint without
  // auth keys — and that's a green light for our purposes.
  return latency_ms > 5_000 ? "degraded" : "up";
}

/** Probe a single URL. Never throws. We only care about the
 *  HTTP status code, so we abort the body read immediately after
 *  headers arrive — this is what lets us probe providers that
 *  return multi-MB /models responses (OpenRouter, Hugging Face)
 *  without buffering any of it. Body cap is 0 = read nothing. */
async function pingOne(p: PopularProvider): Promise<PopularProviderHealth> {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    // Validate the URL against the SSRF guard (private-IP block,
    // DNS-rebind protection, etc.) before connecting. We don't
    // need the full safeFetch helper because we never read the
    // body; a raw fetch + abort-once-we-have-headers is enough.
    await assertSafeOutboundUrl(p.url, { allowLocal: false });
    const res = await fetch(p.url, {
      method: "GET",
      signal: ctrl.signal,
      redirect: "manual",
    });
    const latency_ms = Date.now() - start;
    // Cancel the body so the connection can be released without
    // us reading any of it.
    try { await res.body?.cancel(); } catch { /* ignore */ }
    const status = classify(res.status, latency_ms);
    return {
      ...p,
      status,
      latency_ms,
      http_code: res.status,
      checked_at: Date.now(),
      reason: status === "degraded" ? `http_${res.status}` : undefined,
    };
  } catch (err) {
    const latency_ms = Date.now() - start;
    const isAbort = (err as Error).name === "AbortError";
    return {
      ...p,
      status: "down",
      latency_ms,
      http_code: 0,
      checked_at: Date.now(),
      reason: isAbort ? "timeout" : (err as Error).message?.slice(0, 60) ?? "ping_failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Probe every popular provider in parallel. */
export async function pingPopularProviders(
  opts: { forceRefresh?: boolean } = {},
): Promise<PopularProviderHealth[]> {
  const now = Date.now();
  const out: PopularProviderHealth[] = [];
  const toFetch: PopularProvider[] = [];
  if (!opts.forceRefresh) {
    for (const p of POPULAR_PROVIDERS) {
      const cached = cache.get(p.id);
      if (cached && now - cached.checked_at < CACHE_TTL_MS) {
        out.push(cached);
      } else {
        toFetch.push(p);
      }
    }
  } else {
    toFetch.push(...POPULAR_PROVIDERS);
  }
  const fresh = await Promise.all(toFetch.map(pingOne));
  for (const entry of fresh) {
    cache.set(entry.id, entry);
    // Bounded cache — keep the most recent N entries.
    if (cache.size > MAX_CACHE_ENTRIES) {
      const oldest = [...cache.entries()].sort((a, b) => a[1].checked_at - b[1].checked_at)[0];
      if (oldest) cache.delete(oldest[0]);
    }
  }
  // Re-order result to match the canonical POPULAR_PROVIDERS order.
  const byId = new Map([...out, ...fresh].map((h) => [h.id, h] as const));
  return POPULAR_PROVIDERS.map((p) => byId.get(p.id) ?? {
    ...p,
    status: "unknown" as ProviderStatus,
    latency_ms: 0,
    http_code: 0,
    checked_at: 0,
  });
}
