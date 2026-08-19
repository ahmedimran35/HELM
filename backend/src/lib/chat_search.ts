// Chat-time web search. Thin wrapper around `smartSearch()` in
// ./web_search.ts — preserves the legacy `callLightpanda` signature
// so the chat + panel routes don't need to change, but uses the
// smart multi-tier parallel-search under the hood.

import { smartSearch, classifyQuery, type QueryIntent } from "./web_search.ts";
import { safeFetch, assertSafeOutboundUrl, SafeFetchError } from "./safe-fetch.ts";

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface WebSearchResponse {
  query: string;
  results: WebSearchResult[];
  answer: string | null;
  service: string | null;
  remaining_today: number;
  limit: number;
  cached?: boolean;
  auto_configured?: boolean;
  /** Debug trace of what we tried. */
  trace?: string[];
  /** Detected query intent — used by the route to adapt the
   *  system-prompt frame. */
  intent?: QueryIntent;
}

const URL_RE = /https?:\/\/[^\s<>"']+/i;

/** Detect a URL embedded in the user's message — many users paste
 *  a link when they want the chat to read/summarise a page. */
function extractUrl(query: string): string | null {
  const m = query.match(URL_RE);
  return m ? m[0] : null;
}

/** Used by the chat route to fetch a specific URL given in the
 *  message or pasted in the user's text.
 *
 * Every fetch goes through `safeFetch`, which DNS-resolves, blocks
 * private/loopback/metadata IPs, and disallows non-80/443 ports for
 * arbitrary user input. The fetch also disables redirects so a 30x
 * can't pivot to an internal IP, and caps the response body. */
export async function callLightpandaForUrl(url: string): Promise<WebSearchResponse | null> {
  try {
    // Pre-validate early to reject obvious garbage without burning the
    // DNS round-trip.
    try {
      await assertSafeOutboundUrl(url, { allowLocal: false });
    } catch (err) {
      // Surface the rejection to the caller — chat must NOT proceed to
      // call safeFetch with an unsafe URL because the response body
      // gets echoed into the model context.
      throw err instanceof SafeFetchError
        ? err
        : new SafeFetchError((err as Error).message);
    }
    const r = await safeFetch(url, {
      signal: AbortSignal.timeout(15_000),
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
      maxBytes: 5 * 1024 * 1024,
    });
    if (r.status >= 400) return null;
    const html = await r.text();
    const text = htmlToText(html);
    return {
      query: url,
      service: "lightpanda",
      results: [
        { title: url, url, snippet: text.slice(0, 800), source: "lightpanda" },
      ],
      answer: text.slice(0, 4000),
      remaining_today: 0,
      limit: 0,
    };
  } catch (err) {
    // SSRF rejections fall here too. We surface the reason via trace so
    // the chat can let the user know the URL was blocked for safety.
    if (err instanceof SafeFetchError) {
      console.warn(`chat url blocked by safeFetch: ${err.message}`);
      return {
        query: url,
        service: "safe_blocked",
        results: [],
        answer: "This URL can't be fetched by the assistant for safety reasons",
        remaining_today: 0,
        limit: 0,
      };
    }
    return null;
  }
}

function htmlToText(html: string): string {
  let s = html.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|td|th|br)>/gi, "\n");
  s = s.replace(/<br\b[^>]*>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&[a-z]+;/gi, " ");
  return s.replace(/\s+/g, " ").trim().slice(0, 12000);
}

/** Legacy signature — chat route still calls this. Uses the new
 *  `smartSearch()` so any query type (factual / news / how-to /
 *  comparison / creative / general) gets the right tier mix. */
export async function callLightpanda(
  service: "lightpanda",
  apiKey: string,
  query: string,
  maxResults: number,
  opts: { url?: string } = {},
): Promise<WebSearchResponse | null> {
  try {
    // 1. Explicit URL from the route? Fetch directly.
    if (opts.url) {
      return await callLightpandaForUrl(opts.url);
    }
    // 2. URL pasted inside the user's message? Fetch directly.
    const embeddedUrl = extractUrl(query);
    if (embeddedUrl) {
      const r = await callLightpandaForUrl(embeddedUrl);
      if (r) return r;
    }
    // 3. Classify and run multi-tier smart search in parallel.
    const intent = classifyQuery(query);
    const r = await smartSearch(query, { maxResults });
    return {
      query: r.query,
      service: r.exhausted ? "none" : r.service,
      results: r.results.slice(0, maxResults),
      answer: r.answer,
      remaining_today: 0,
      limit: 0,
      trace: r.trace,
      intent,
    };
  } catch (err) {
    // Last-ditch: never throw. Return an exhausted result so the
    // chat can still answer from training data.
    return {
      query,
      service: "none",
      results: [],
      answer: null,
      remaining_today: 0,
      limit: 0,
      trace: [`error: ${(err as Error).message}`],
    };
  }
}

/** Re-export the classifier so routes can use it directly. */
export { classifyQuery, type QueryIntent } from "./web_search.ts";
