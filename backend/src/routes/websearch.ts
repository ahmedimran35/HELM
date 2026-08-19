// Real-time web search via Lightpanda headless browser.
//
// Admin configures one or more search providers in Settings → websearch.
// The "live" web-search flow is powered by Lightpanda
// (https://github.com/lightpanda-io/browser). The same response shape
// is preserved for the frontend so nothing downstream needs to change.
//
// Lightpanda flow:
//   - If the request includes a `url`, we fetch and return that URL's
//     rendered markdown directly.
//   - Otherwise we use Lightpanda to scrape DuckDuckGo's HTML results
//     page for the query, then also fetch the top result's URL so the
//     model has the actual page content (not just DDG's snippet).
//
// We also cache every successful result in Postgres for 24h so
// repeated questions (e.g. "capital of France" in three panels) don't
// re-spawn the Lightpanda subprocess.

import { Hono } from "hono";
import { createHash } from "node:crypto";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAdmin } from "../middleware/role.ts";
import { logAudit } from "../lib/audit.ts";
import { validate, validationErrorResponse } from "../lib/validate.ts";
import { lightpandaFetch, lightpandaSearch, lightpandaSearchWithTopPage } from "../lib/lightpanda.ts";
import { assertSafeOutboundUrl, SafeFetchError } from "../lib/safe-fetch.ts";
import { assertSafeBaseUrl } from "../providers/registry.ts";
import { safeError } from "../lib/safe-error.ts";

const router = new Hono();
router.use("*", requireAuth);

const CACHE_TTL_HOURS = 24;

interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  answer: string | null;
  service: string | null;
  remaining_today: number;
  limit: number;
  cached?: boolean;
}

// ------------------------------------------------------------ admin ---

router.get("/config", requireAdmin, async (c) => {
  const rows = await sql<{
    service: string;
    connected: boolean;
    added_at: Date;
    last_used_at: Date | null;
  }[]>`
    SELECT service, connected, added_at, last_used_at
    FROM web_search_keys ORDER BY added_at ASC
  `;
  const out = rows.map((r) => ({
    ...r,
    api_key_masked: r.connected ? "configured" : "not set",
  }));
  return c.json({ keys: out });
});

router.get("/config/:service", requireAdmin, async (c) => {
  const service = c.req.param("service");
  if (!["tavily", "brave", "serpapi", "duckduckgo", "lightpanda"].includes(service)) {
    return c.json({ error: "invalid service" }, 400);
  }
  const rows = await sql<{
    service: string;
    connected: boolean;
    added_at: Date;
    last_used_at: Date | null;
  }[]>`
    SELECT service, connected, added_at, last_used_at
    FROM web_search_keys WHERE service = ${service} LIMIT 1
  `;
  return c.json(rows[0] ?? { service, connected: false });
});

router.put("/config/:service", requireAdmin, async (c) => {
  const service = c.req.param("service");
  if (!["tavily", "brave", "serpapi", "duckduckgo", "lightpanda"].includes(service)) {
    return c.json({ error: "invalid service" }, 400);
  }
  let body: {
    api_key?: string;
    base_url?: string;
  };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      api_key: { type: "string", minLength: 1, maxLength: 400 },
      base_url: { type: "string", minLength: 1, maxLength: 400 },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  // Lightpanda runs locally — no API key required. The base_url
  // (HTTP daemon mode) is optional; when blank we spawn the local
  // binary directly. Other paid providers (Tavily, Brave, SerpAPI)
  // still need an api_key.
  const needsKey = service === "tavily" || service === "brave" || service === "serpapi";
  if (needsKey && !body.api_key) {
    return c.json({ error: "api_key required for this provider" }, 400);
  }
  const key = body.api_key ?? "";
  const { encryptSecret } = await import("../providers/crypto.ts");
  const enc = encryptSecret(key);
  // For lightpanda HTTP daemon mode, store the base_url in a separate
  // column. We fall back to api_key_encrypted if base_url is unset
  // (legacy data).
  let stored: string;
  let baseUrlToStore: string | null = null;
  if (service === "lightpanda") {
    // SSRF guard — admin can configure the lightpanda daemon URL.
    // Refuse loopback / private / metadata IPs unless the operator
    // opts in via HELM_ALLOW_LOCAL_PROVIDERS=1 (for a local daemon).
    // Without this guard, an admin who pasted a metadata URL by
    // mistake would exfiltrate cloud IAM credentials.
    if (body.base_url) {
      try {
        await assertSafeBaseUrl(body.base_url, {
          allowLocal: process.env.HELM_ALLOW_LOCAL_PROVIDERS === "1",
          allowAnyPort: true,
        });
      } catch (err) {
        return safeError(c, err, { status: 400, code: "websearch_invalid" });
      }
    }
    stored = enc;
    baseUrlToStore = body.base_url ?? "";
  } else if (key) {
    stored = enc;
  } else {
    // duckduckgo with no key — store empty string
    stored = "";
  }
  await sql`
    INSERT INTO web_search_keys (service, api_key_encrypted, connected, base_url, added_by)
    VALUES (${service}, ${stored}, TRUE, ${baseUrlToStore}, ${c.get("user").id}::uuid)
    ON CONFLICT (service) DO UPDATE
      SET api_key_encrypted = EXCLUDED.api_key_encrypted,
          base_url = EXCLUDED.base_url,
          connected = TRUE,
          added_at = now(),
          added_by = EXCLUDED.add_by
  `;
  await logAudit({
    userId: c.get("user").id,
    target: service,
    action: "web_search_key_set",
  });
  return c.json({ ok: true, service });
});

router.delete("/config/:service", requireAdmin, async (c) => {
  const service = c.req.param("service");
  if (!["tavily", "brave", "serpapi", "duckduckgo", "lightpanda"].includes(service)) {
    return c.json({ error: "invalid service" }, 400);
  }
  await sql`DELETE FROM web_search_keys WHERE service = ${service}`;
  await logAudit({
    userId: c.get("user").id,
    target: service,
    action: "web_search_key_removed",
  });
  return c.json({ ok: true });
});

// --------------------------------------------- cache lookup/store ---

function cacheKey(service: string, query: string): string {
  return createHash("sha256")
    .update(service)
    .update("\x00")
    .update(query.trim().toLowerCase())
    .digest("hex");
}

async function lookupCache(service: string, query: string): Promise<WebSearchResponse | null> {
  const key = cacheKey(service, query);
  const rows = await sql<{ response_json: WebSearchResponse }[]>`
    SELECT response_json FROM web_search_cache
    WHERE service = ${service} AND query_hash = ${key} AND expires_at > now()
    LIMIT 1
  `;
  return rows[0]?.response_json ?? null;
}

async function storeCache(service: string, query: string, response: WebSearchResponse) {
  const key = cacheKey(service, query);
  const ttl = new Date(Date.now() + CACHE_TTL_HOURS * 60 * 60 * 1000);
  const persistable = {
    query: response.query,
    results: response.results,
    answer: response.answer,
    service: response.service,
    remaining_today: 0,
    limit: 0,
  };
  await sql`
    INSERT INTO web_search_cache (service, query_hash, query, response_json, expires_at)
    VALUES (${service}, ${key}, ${query}, ${sql.json(persistable as never)}::jsonb, ${ttl}::timestamptz)
    ON CONFLICT (service, query_hash) DO UPDATE
      SET response_json = EXCLUDED.response_json,
          expires_at = EXCLUDED.expires_at,
          cached_at = now()
  `.catch(() => {
    // Best-effort cache write — never fail the user's request.
  });
}

// --------------------------------------------- quota enforcement ---

async function enforceQuota(userId: string): Promise<{ allowed: boolean; remaining: number; limit: number }> {
  const rows = await sql<{ daily_limit: number; used_today: number; used_reset_at: Date }[]>`
    INSERT INTO search_quotas (user_id, daily_limit, used_today, used_reset_at)
    VALUES (${userId}::uuid, 50, 0, now())
    ON CONFLICT (user_id) DO NOTHING
    RETURNING daily_limit, used_today, used_reset_at
  `;
  const current =
    rows[0] ??
    (await sql<{ daily_limit: number; used_today: number; used_reset_at: Date }[]>`
      SELECT daily_limit, used_today, used_reset_at FROM search_quotas WHERE user_id = ${userId}::uuid
    `)[0]!;
  if (Date.now() - new Date(current.used_reset_at).getTime() > 24 * 60 * 60 * 1000) {
    await sql`
      UPDATE search_quotas
      SET used_today = 0, used_reset_at = now()
      WHERE user_id = ${userId}::uuid
    `;
    current.used_today = 0;
  }
  if (current.used_today >= current.daily_limit) {
    return { allowed: false, remaining: 0, limit: current.daily_limit };
  }
  await sql`
    UPDATE search_quotas SET used_today = used_today + 1
    WHERE user_id = ${userId}::uuid
  `;
  return {
    allowed: true,
    remaining: current.daily_limit - current.used_today - 1,
    limit: current.daily_limit,
  };
}

// --------------------------------------------- posture check ---

async function postureAllows(userId: string, role: string): Promise<boolean> {
  if (role === "admin") return true;
  const rows = await sql<{ posture: string }[]>`
    SELECT posture FROM tool_posture
    WHERE user_id = ${userId}::uuid AND tool_name = 'web_search' LIMIT 1
  `;
  return (rows[0]?.posture ?? "auto") === "auto";
}

// --------------------------------------------- main /search endpoint ---

interface ProviderConfig {
  service: "tavily" | "brave" | "serpapi" | "duckduckgo" | "lightpanda";
  api_key_encrypted: string | null;
  base_url: string | null;
}

async function listProviders(): Promise<ProviderConfig[]> {
  return sql<ProviderConfig[]>`
    SELECT service, api_key_encrypted, base_url FROM web_search_keys
    WHERE connected = TRUE
    ORDER BY added_at ASC
  `;
}

async function callLightpandaSearch(
  query: string,
  maxResults: number,
  url: string | undefined,
): Promise<WebSearchResponse> {
  if (url) {
    // Pre-flight SSRF guard. User-supplied URLs are rejected if they
    // resolve to a private/loopback/metadata IP, use a non-default port,
    // carry embedded credentials, or use a numeric IPv4 encoding. The
    // lightpanda daemon itself is reachable because the call is routed
    // through the daemon's HTTP API (configured via env), which is
    // trusted — but the *target* URL of the fetch is not.
    try {
      await assertSafeOutboundUrl(url, { allowLocal: false });
    } catch (err) {
      if (err instanceof SafeFetchError) {
        console.warn("[websearch] safe_blocked url:", (err as Error).message);
        return {
          query,
          service: "safe_blocked",
          results: [],
          answer: "URL blocked for safety",
          remaining_today: 0,
          limit: 0,
        };
      }
      throw err;
    }
    const r = await lightpandaFetch(url);
    return {
      query,
      service: "lightpanda",
      answer: r.markdown.slice(0, 4000),
      results: [
        {
          title: r.title || url,
          url: r.url,
          snippet: r.markdown.slice(0, 800),
          source: "lightpanda",
        },
      ],
      remaining_today: 0,
      limit: 0,
    };
  }
  // Free search path: lightpanda scrapes Brave → DDG → Startpage →
  // Wikipedia, with a Wikipedia REST fast-path for "who is X" queries.
  const { results, topMarkdown, answerBox } = await lightpandaSearchWithTopPage(query, maxResults);
  if (results.length === 0) {
    return { query, service: "lightpanda", results: [], answer: null, remaining_today: 0, limit: 0 };
  }
  return {
    query,
    service: "lightpanda",
    answer: answerBox || topMarkdown || null,
    results: results.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: r.source === "wikipedia" ? topMarkdown.slice(0, 800) : "",
      source: "lightpanda",
    })),
    remaining_today: 0,
    limit: 0,
  };
}

router.post("/", async (c) => {
  const user = c.get("user");
  let body: { query?: string; max_results?: number; url?: string };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      query: { type: "string", minLength: 1, maxLength: 500, trim: true },
      max_results: { type: "number", min: 1, max: 20, integer: true },
      url: { type: "string", minLength: 1, maxLength: 500 },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (!body.url && !body.query) {
    return c.json({ error: "query or url required" }, 400);
  }
  const maxResults = body.max_results ?? 5;

  if (!(await postureAllows(user.id, user.role))) {
    return c.json({ error: "web_search posture is strict — set it to auto in Workspace → Posture" }, 403);
  }

  const quota = await enforceQuota(user.id);
  if (!quota.allowed) {
    return c.json(
      { error: `daily search quota exhausted (${quota.limit}/day)`, limit: quota.limit, remaining: 0 },
      429,
    );
  }

  const { decryptSecret } = await import("../providers/crypto.ts");
  const configured = await listProviders();

  // Cache lookup first.
  const queryKey = body.query ?? body.url!;
  for (const p of configured) {
    const cached = await lookupCache(p.service, queryKey);
    if (cached) {
      await logAudit({
        userId: user.id,
        target: p.service,
        action: "web_search_cached",
        metadata: { query: queryKey, result_count: cached.results.length },
      });
      return c.json({
        ...cached,
        cached: true,
        remaining_today: quota.remaining,
        limit: quota.limit,
      });
    }
  }

  // Build the dispatch chain. Lightpanda is preferred (free, local,
  // real rendered content). Fall back to any paid key if Lightpanda
  // isn't configured.
  type Dispatcher = () => Promise<WebSearchResponse>;
  const chain: Dispatcher[] = [];
  const lp = configured.find((p) => p.service === "lightpanda");
  if (lp) {
    chain.push(() => callLightpandaSearch(body.query ?? body.url!, maxResults, body.url));
  }
  for (const p of configured) {
    if (p.service === "lightpanda") continue;
    const key = p.api_key_encrypted ? decryptSecret(p.api_key_encrypted) : "";
    if (!key) continue;
    // Lightpanda already added above; only fall through to paid keys
    // if Lightpanda didn't produce results.
    if (p.service === "tavily") {
      chain.push(async () => {
        const r = await fetch("https://api.tavily.com/search", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            api_key: key,
            query: body.query ?? body.url!,
            max_results: maxResults,
            include_answer: true,
            search_depth: "basic",
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) throw new Error(`tavily ${r.status}`);
        const b = (await r.json()) as {
          results: Array<{ title: string; url: string; content: string }>;
          answer?: string;
        };
        return {
          query: body.query ?? body.url!,
          service: "tavily",
          answer: b.answer ?? null,
          results: (b.results ?? []).map((r) => ({
            title: r.title,
            url: r.url,
            snippet: (r.content ?? "").slice(0, 400),
            source: "tavily",
          })),
          remaining_today: 0,
          limit: 0,
        };
      });
    }
    if (p.service === "brave") {
      chain.push(async () => {
        const u = new URL("https://api.search.brave.com/res/v1/web/search");
        u.searchParams.set("q", body.query ?? body.url!);
        u.searchParams.set("count", String(Math.min(maxResults, 20)));
        const r = await fetch(u, {
          headers: { "X-Subscription-Token": key, Accept: "application/json" },
          signal: AbortSignal.timeout(10_000),
        });
        if (!r.ok) throw new Error(`brave ${r.status}`);
        const b = (await r.json()) as {
          web?: { results?: Array<{ title: string; url: string; description: string }> };
        };
        return {
          query: body.query ?? body.url!,
          service: "brave",
          answer: null,
          results: (b.web?.results ?? []).map((r) => ({
            title: r.title,
            url: r.url,
            snippet: (r.description ?? "").slice(0, 400),
            source: "brave",
          })),
          remaining_today: 0,
          limit: 0,
        };
      });
    }
    if (p.service === "serpapi") {
      chain.push(async () => {
        const u = new URL("https://serpapi.com/search.json");
        u.searchParams.set("q", body.query ?? body.url!);
        u.searchParams.set("api_key", key);
        u.searchParams.set("num", String(Math.min(maxResults, 20)));
        const r = await fetch(u, { signal: AbortSignal.timeout(10_000) });
        if (!r.ok) throw new Error(`serpapi ${r.status}`);
        const b = (await r.json()) as {
          organic_results?: Array<{ title: string; link: string; snippet: string }>;
          answer_box?: { answer?: string };
        };
        return {
          query: body.query ?? body.url!,
          service: "serpapi",
          answer: b.answer_box?.answer ?? null,
          results: (b.organic_results ?? []).map((r) => ({
            title: r.title,
            url: r.link,
            snippet: (r.snippet ?? "").slice(0, 400),
            source: "serpapi",
          })),
          remaining_today: 0,
          limit: 0,
        };
      });
    }
    // duckduckgo legacy entries no longer fetch anything — Lightpanda
    // is the only keyless source.
  }

  let lastErr: string | null = null;
  for (const attempt of chain) {
    try {
      const r = await attempt();
      if (r.results.length === 0 && !r.answer) continue;
      const cacheSvc = r.service ?? "lightpanda";
      await storeCache(cacheSvc, queryKey, r);
      await sql`
        UPDATE web_search_keys SET last_used_at = now()
        WHERE service = ${cacheSvc}::text
      `;
      await logAudit({
        userId: user.id,
        target: cacheSvc,
        action: "web_search",
        metadata: { query: queryKey, result_count: r.results.length, remaining_today: quota.remaining },
      });
      return c.json({
        ...r,
        remaining_today: quota.remaining,
        limit: quota.limit,
        auto_configured: configured.length === 0 || configured[0]?.service === "lightpanda",
      });
    } catch (err) {
      console.warn("[websearch] search failed:", (err as Error).message);
      lastErr = (err as Error).message;
      await logAudit({
        userId: user.id,
        target: "lightpanda",
        action: "web_search_failed",
        metadata: { query: queryKey, error: lastErr },
      });
      continue;
    }
  }
  return c.json({
    error: lastErr
      ? "search_unavailable"
      : "no results for that query",
    remaining_today: quota.remaining,
    limit: quota.limit,
  }, 502);
});

router.get("/status", async (c) => {
  const user = c.get("user");
  const configured = await sql<{ service: string; connected: boolean }[]>`
    SELECT service, connected FROM web_search_keys WHERE connected = TRUE ORDER BY added_at ASC
  `;
  const quota = await sql<{ daily_limit: number; used_today: number }[]>`
    SELECT daily_limit, used_today FROM search_quotas WHERE user_id = ${user.id}::uuid LIMIT 1
  `;
  const posture = await sql<{ posture: string }[]>`
    SELECT posture FROM tool_posture WHERE user_id = ${user.id}::uuid AND tool_name = 'web_search' LIMIT 1
  `;
  return c.json({
    providers: configured,
    quota: quota[0] ?? { daily_limit: 50, used_today: 0 },
    posture: posture[0]?.posture ?? "auto",
  });
});

export default router;
export type { WebSearchResponse };