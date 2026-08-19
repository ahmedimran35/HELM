// Lightpanda (https://github.com/lightpanda-io/browser) headless-browser
// wrapper. This is the single source of truth for all live-data web
// search in HELM — nothing else calls out to paid APIs.
//
// Strategy: ALL free, ALL rendered by lightpanda. We scrape the public
// HTML of free search engines (no API keys, no metasearch index) and
// fall back to Wikipedia's public REST API for direct factual lookups.
// The chain is:
//
//   1. Wikipedia REST "summary" endpoint (fast path, free, no key)
//        → "who is X" / "what is X" queries get the intro + infobox
//   2. Brave Search HTML (no API key, fast, has an AI answer box)
//        → rendered by lightpanda
//   3. DuckDuckGo HTML (no API key, but often CAPTCHA'd)
//        → rendered by lightpanda
//   4. Startpage HTML (no API key, no tracker redirects)
//        → rendered by lightpanda
//   5. Wikipedia on-site search (always works, no captcha)
//        → rendered by lightpanda
//
// Lightpanda has two operating modes:
//
//  1. CLI (one-shot per query) — `lightpanda fetch --dump markdown <url>`.
//     We spawn this for every search unless a long-running daemon is
//     configured via $WEB_SEARCH_LIGHTPANDA_URL.
//  2. Long-running HTTP daemon — set $WEB_SEARCH_LIGHTPANDA_URL.
//     We GET `<baseUrl>/fetch?url=<target>`.
//
// Whichever we use, the shape is the same: { url, markdown, title,
// duration_ms }.

import { spawn } from "bun";
import { config } from "../config.ts";
import { safeFetch, SafeFetchError } from "./safe-fetch.ts";

export interface LightpandaResult {
  url: string;
  markdown: string;
  title: string;
  duration_ms: number;
  /** When fetched via a configured HTTP daemon, the daemon's
      response may include extra fields. Reserved for future use. */
  source?: "cli" | "http" | "wikipedia";
}

function extractTitleFromMd(md: string): string {
  const m = md.match(/^#\s+(.+)$/m);
  return m ? m[1]!.trim().slice(0, 200) : "";
}

/** Skip the leading sidebar / nav chrome that lightpanda renders for
 *  Wikipedia pages (the "Main menu" / "Contents" / "Toggle sidebar"
 *  block). We look for the first Markdown H1 (`# Title`) and the
 *  paragraph that follows it; everything before that is chrome. */
function stripLeadingChrome(md: string): string {
  // The first H1 is the page title. Strip the sidebar nav that precedes it.
  const idx = md.search(/^#\s+\S/m);
  if (idx > 0 && idx < md.length / 2) {
    return md.slice(idx);
  }
  return md;
}

// ----------------------------------------------------------------- fetch

/** Shell out to the `lightpanda` binary. Default in docker-compose;
    override via $LIGHTPANDA_BIN. Returns the rendered markdown of
    the page (JS-executed, full DOM rendered, no headless-Chrome
    overhead — 9x faster, 16x less memory per the project's own
    benchmarks). */
export async function lightpandaFetchViaCli(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<LightpandaResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? 20000;
  const proc = spawn({
    cmd: [
      config.webSearch.lightpandaBin,
      "fetch",
      "--dump",
      "markdown",
      "--log-level",
      "error",
      url,
    ],
    stdout: "pipe",
    stderr: "pipe",
  });
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  let stdout = "";
  let stderr = "";
  try {
    stdout = await new Response(proc.stdout).text();
    stderr = await new Response(proc.stderr).text();
  } catch {
    /* ignore */
  }
  clearTimeout(timer);
  const code = await proc.exited;
  const duration_ms = Date.now() - start;
  if (code !== 0) {
    throw new Error(
      `lightpanda exited ${code}: ${stderr.slice(0, 200)}`,
    );
  }
  return {
    url,
    markdown: stdout,
    title: extractTitleFromMd(stdout),
    duration_ms,
    source: "cli",
  };
}

/** HTTP fetch via a configured long-running daemon. We hit
    `<baseUrl>/fetch?url=<target>` which the wrapper daemon (e.g. a
    small Express server in front of `lightpanda serve`) is expected
    to expose. We keep the same return shape as the CLI path.
    The baseUrl is configured in the env / config and treated as a
    trusted internal daemon — pass `allowLocal: true` so a local
    loopback binding is accepted. The actual `url` argument is
    validated when the daemon forwards the fetch (or via the same
    safeFetch check if we later implement client-side validation). */
export async function lightpandaFetchViaHttp(
  baseUrl: string,
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<LightpandaResult> {
  const start = Date.now();
  const timeoutMs = opts.timeoutMs ?? 20000;
  // safeFetch with allowLocal: true — the lightpanda daemon is
  // explicitly a trusted internal companion. The strict URL checks
  // for DNS rebinding, embedded credentials, and numeric-IP encoding
  // still apply.
  const r = await safeFetch(
    `${baseUrl.replace(/\/$/, "")}/fetch?url=${encodeURIComponent(url)}`,
    {
      signal: AbortSignal.timeout(timeoutMs),
      allowLocal: true,
    },
  );
  const duration_ms = Date.now() - start;
  if (!r.ok) {
    throw new Error(`lightpanda daemon ${r.status}: ${(await r.text()).slice(0, 200)}`);
  }
  const body = (await r.json()) as { markdown?: string; title?: string };
  return {
    url,
    markdown: body.markdown ?? "",
    title: body.title ?? extractTitleFromMd(body.markdown ?? ""),
    duration_ms,
    source: "http",
  };
}

/** Top-level entry: pick CLI or HTTP based on config. */
export async function lightpandaFetch(
  url: string,
  opts: { timeoutMs?: number } = {},
): Promise<LightpandaResult> {
  if (config.webSearch.lightpandaUrl) {
    return lightpandaFetchViaHttp(config.webSearch.lightpandaUrl, url, opts);
  }
  return lightpandaFetchViaCli(url, opts);
}

// ----------------------------------------------------------------- search

interface SearchEngineDef {
  name: string;
  url: (q: string) => string;
  /** Detect CAPTCHA / block pages so we abort early. */
  isBlocked?: (md: string) => boolean;
}

/** Free search engines — all scraped via lightpanda, no API keys. */
const SEARCH_ENGINES: SearchEngineDef[] = [
  {
    name: "brave",
    url: (q) => `https://search.brave.com/search?q=${encodeURIComponent(q)}&source=web`,
    isBlocked: (md) =>
      md.includes("verify you are a human") ||
      md.toLowerCase().includes("captcha") ||
      md.includes("Please complete the following challenge"),
  },
  {
    name: "duckduckgo",
    url: (q) => `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`,
    isBlocked: (md) =>
      md.includes("Unfortunately, bots use DuckDuckGo") ||
      md.includes("Please complete the following challenge"),
  },
  {
    name: "startpage",
    url: (q) => `https://www.startpage.com/do/search?q=${encodeURIComponent(q)}`,
    isBlocked: (md) => md.includes("Verifying your request"),
  },
  {
    name: "wikipedia",
    url: (q) => `https://en.wikipedia.org/w/index.php?search=${encodeURIComponent(q)}&title=Special:Search&ns0=1`,
  },
];

/** Trim a title — strip HTML, collapse whitespace, drop trailing "...". */
function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, "")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/&#[0-9]+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Unwrap search-engine redirect wrappers so the caller gets the real URL. */
function unwrapRedirect(url: string): string {
  if (url.startsWith("//")) url = "https:" + url;
  try {
    const u = new URL(url);
    // DuckDuckGo wraps real URLs in /l/?uddg=<encoded-url>
    if (
      (u.hostname === "duckduckgo.com" || u.hostname === "html.duckduckgo.com") &&
      u.pathname.startsWith("/l/")
    ) {
      const target = u.searchParams.get("uddg");
      if (target) return target;
    }
    // Bing wraps real URLs in /ck/a?...&u=<encoded-url>
    if (u.hostname === "www.bing.com" && u.pathname.startsWith("/ck/")) {
      const target = u.searchParams.get("u");
      if (target) return target;
    }
    // Brave /cdn links are decorative — keep the original target URL
    return u.toString();
  } catch {
    return url;
  }
}

/** Navigation / chrome hosts we never want to surface as a result. */
const NAV_HOSTNAMES = [
  "search.brave.com",
  "brave.com",
  "html.duckduckgo.com",
  "duckduckgo.com",
  "www.startpage.com",
  "startpage.com",
  "en.wikipedia.org/wiki/Special:",
  "en.wikipedia.org/wiki/Main_Page",
  "en.wikipedia.org/wiki/Wikipedia:",
  "en.wikipedia.org/wiki/Help:",
  "en.wikipedia.org/wiki/Portal:",
  "en.wikipedia.org/wiki/Category:",
  "en.wikipedia.org/wiki/Template:",
  "wikipedia.org/wiki/File:",
  "cdn.search.brave.com",
  "imgs.search.brave.com",
  "upload.wikimedia.org",
  "favicon.ico",
];

/** Words that are too generic to be a useful result title (nav chrome). */
const NAV_TITLE_REGEX =
  /^(all|images|videos|news|maps|more|login|account|settings|help|search|ask|main menu|menu|privacy|about|home|skip to content|skip to main content|close|submit|copy|share|view all|elaborate|next|prev|previous)$/i;

function looksLikeNav(url: string): boolean {
  return NAV_HOSTNAMES.some((h) => url.startsWith(`https://${h}`) || url.startsWith(`http://${h}`));
}

/** Add a result to the dedup map if it passes the quality filters. */
function addResult(
  found: Map<string, LightpandaResult>,
  title: string,
  rawUrl: string,
  maxResults: number,
): void {
  if (found.size >= maxResults) return;
  const cleanTitle = stripTags(title);
  if (cleanTitle.length < 4) return;
  if (NAV_TITLE_REGEX.test(cleanTitle)) return;
  const url = unwrapRedirect(rawUrl);
  if (looksLikeNav(url)) return;
  // De-dupe by URL
  if (found.has(url)) return;
  found.set(url, {
    url,
    title: cleanTitle,
    markdown: "",
    duration_ms: 0,
    source: "cli",
  });
}

/** Parse search results from lightpanda's rendered output.
 *
 *  Lightpanda's `--dump markdown` converts HTML to markdown, but it
 *  doesn't always convert `<a>` tags to `[text](url)` form — many
 *  search engines render anchors with rich children (icon divs, spans)
 *  that confuse the converter. We therefore try BOTH formats:
 *    1. Markdown links  `[title](url)`
 *    2. HTML anchor tags `<a href="url" ...>title</a>` (with stripped tags)
 */
function parseSearchResults(
  md: string,
  maxResults: number,
): LightpandaResult[] {
  const found = new Map<string, LightpandaResult>();

  // 1. Markdown links first (highest signal).
  const mdRe = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g;
  for (const m of md.matchAll(mdRe)) {
    addResult(found, m[1]!, m[2]!, maxResults);
    if (found.size >= maxResults) break;
  }

  // 2. HTML anchor tags (fallback when markdown conversion missed).
  if (found.size < maxResults) {
    const htmlRe = /<a\b[^>]*\bhref=["'](https?:\/\/[^"'\s]+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    for (const m of md.matchAll(htmlRe)) {
      const rawUrl = m[1]!;
      const inner = m[2] ?? "";
      // Skip image-only links (no useful title).
      if (/^<img\b/i.test(inner.trim())) continue;
      // Skip links that contain another nested anchor (nested menus).
      if (/<a\b/i.test(inner)) continue;
      addResult(found, inner, rawUrl, maxResults);
      if (found.size >= maxResults) break;
    }
  }

  return Array.from(found.values()).slice(0, maxResults);
}

/** Extract Brave's AI-generated answer box (the bolded paragraph at the
 *  top of the search results page). This is the best direct answer. */
function extractBraveAnswerBox(md: string): string | null {
  // The AI answer is rendered as a bolded paragraph immediately after the
  // search nav. It usually starts with "**" and ends before "AI-generated".
  const m = md.match(/\*\*([\s\S]+?)\*\*\s*\n[\s\S]{0,40}?AI[‐‑-]generated/i);
  if (m) return stripTags(m[1] ?? "").trim();
  return null;
}

/** Search via lightpanda by scraping free search engines.
 *  Tries each engine in order; returns the first that yields results. */
export async function lightpandaSearch(
  query: string,
  maxResults = 5,
): Promise<LightpandaResult[]> {
  for (const engine of SEARCH_ENGINES) {
    try {
      const url = engine.url(query);
      const r = await lightpandaFetch(url, { timeoutMs: 20000 });
      if (engine.isBlocked?.(r.markdown)) continue;
      const results = parseSearchResults(r.markdown, maxResults);
      if (results.length > 0) return results;
    } catch {
      continue;
    }
  }
  return [];
}

/** Search and return an enriched response: results + top result's full
 *  rendered markdown. Used by /api/web-search and the chat SSE endpoint. */
export async function lightpandaSearchWithTopPage(
  query: string,
  maxResults: number,
): Promise<{
  results: LightpandaResult[];
  topMarkdown: string;
  answerBox: string | null;
}> {
  // 1. Wikipedia REST fast-path (free, no key, perfect for "who is X" queries).
  //    Plain `fetch`, no lightpanda needed — works in every environment.
  try {
    const wp = await wikipediaFastPath(query);
    if (wp) {
      // Use lightpanda to render the actual article page so we capture
      // the infobox (e.g. "Incumbent: Tarique Rahman") which the REST
      // summary endpoint strips out. Falls back to a plain `fetch`
      // (raw HTML) if lightpanda is missing or fails.
      let rendered = "";
      try {
        const fetched = await lightpandaFetch(wp.url, { timeoutMs: 20000 });
        rendered = stripLeadingChrome(fetched.markdown).slice(0, 12000);
      } catch {
        // lightpanda unavailable or timed out — try plain fetch + HTML parse
        try {
          rendered = await fetchAndParsePageText(wp.url);
        } catch {
          rendered = wp.extract;
        }
      }
      return {
        results: [
          {
            url: wp.url,
            title: wp.title,
            markdown: "",
            duration_ms: 0,
            source: "wikipedia",
          },
        ],
        topMarkdown: rendered,
        answerBox: wp.extract,
      };
    }
  } catch {
    // Fall through to search-engine scraping.
  }

  // 2. Search-engine scraping.
  //    For each engine we try: plain `fetch` (no lightpanda needed),
  //    then lightpanda-rendered markdown as a fallback. Plain fetch
  //    alone works for DDG/Brave/Startpage because they all return
  //    server-rendered HTML with `<a href="...">title</a>` result rows.
  let answerBox: string | null = null;
  for (const engine of SEARCH_ENGINES) {
    const url = engine.url(query);

    // 2a. Plain fetch (no lightpanda required) — works in any env.
    try {
      const html = await plainFetch(url);
      if (!engine.isBlocked?.(html)) {
        const results = parseHTMLResults(html, maxResults);
        if (results.length > 0) {
          if (engine.name === "brave") {
            answerBox = extractBraveAnswerBoxFromHTML(html);
          }
          // Fetch the top page's text via plain fetch (cheap).
          let topMarkdown = "";
          if (results[0]) {
            try {
              topMarkdown = await fetchAndParsePageText(results[0].url);
            } catch { /* ignore */ }
          }
          return {
            results,
            topMarkdown,
            answerBox: answerBox || topMarkdown || null,
          };
        }
      }
    } catch {
      // continue to lightpanda fallback
    }

    // 2b. Lightpanda fallback — only if plain fetch didn't yield
    //     enough results. This handles JS-only result pages.
    try {
      const r = await lightpandaFetch(url, { timeoutMs: 20000 });
      if (engine.isBlocked?.(r.markdown)) continue;
      const results = parseSearchResults(r.markdown, maxResults);
      if (results.length === 0) continue;
      if (engine.name === "brave") {
        answerBox = extractBraveAnswerBox(r.markdown);
      }
      let topMarkdown = "";
      try {
        const top = await lightpandaFetch(results[0]!.url, { timeoutMs: 20000 });
        topMarkdown = stripLeadingChrome(top.markdown).slice(0, 12000);
      } catch { /* keep what we have */ }
      return { results, topMarkdown, answerBox: answerBox || topMarkdown || null };
    } catch {
      continue;
    }
  }
  return { results: [], topMarkdown: "", answerBox: null };
}

// ----------------------------------------------------------------- HTML

/** Plain HTTP fetch with a sane timeout. No lightpanda required.
 *  Uses safeFetch so user-driven URLs (search-engine pages derived
 *  from a chat question) are SSRF-guarded: private/loopback/metadata
 *  IPs are rejected, redirects are not followed, and the body is
 *  capped. The default port allowlist (80/443) is intentionally
 *  strict. */
async function plainFetch(url: string, timeoutMs = 15_000): Promise<string> {
  let r: Response;
  try {
    r = await safeFetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        // Pretend to be a normal browser. Some engines (Brave) block
        // requests with the default Bun/Node UA.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
  } catch (err) {
    if (err instanceof SafeFetchError) {
      throw new Error(`safe_fetch_blocked: ${err.message}`);
    }
    throw err;
  }
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  return r.text();
}

/** Parse raw HTML (not lightpanda markdown) into search-result rows.
 *  Many search engines send `<a class="result__a" href="...">title</a>`
 *  in their HTML, so we look for both class-anchored results and any
 *  plain `<a>` that links off-site. */
function parseHTMLResults(html: string, maxResults: number): LightpandaResult[] {
  const found = new Map<string, LightpandaResult>();

  // 1. DDG-style: <a class="result__a" href="...">title</a>
  const classRe = /<a\b[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(classRe)) {
    addResult(found, m[2] ?? "", m[1] ?? "", maxResults);
    if (found.size >= maxResults) break;
  }

  // 2. Brave/Bing/Startpage: any <a href="https://..."> with non-trivial text
  if (found.size < maxResults) {
    const anyRe = /<a\b[^>]*\bhref="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    for (const m of html.matchAll(anyRe)) {
      const url = m[1] ?? "";
      const inner = m[2] ?? "";
      // Skip image-only / nested-anchor / short links
      if (/^<img\b/i.test(inner.trim())) continue;
      if (/<a\b/i.test(inner)) continue;
      addResult(found, inner, url, maxResults);
      if (found.size >= maxResults) break;
    }
  }

  return Array.from(found.values()).slice(0, maxResults);
}

/** Fetch a page and extract the main text (no lightpanda needed).
 *  Used as a fallback for environments where the lightpanda binary
 *  isn't installed. Returns plain text — the model still gets the
 *  page content; it just won't have markdown structure. */
async function fetchAndParsePageText(url: string, timeoutMs = 15_000): Promise<string> {
  const html = await plainFetch(url, timeoutMs);
  return htmlToText(html);
}

/** Strip HTML to plain text. Good enough for the chat model to read. */
function htmlToText(html: string): string {
  // Drop scripts/styles/comments entirely
  let s = html.replace(/<script\b[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // Convert block-level tags to newlines so paragraph breaks survive
  s = s.replace(/<\/(p|div|li|h[1-6]|tr|td|th|br)>/gi, "\n");
  s = s.replace(/<br\b[^>]*>/gi, "\n");
  // Strip remaining tags
  s = s.replace(/<[^>]+>/g, "");
  // Decode common entities
  s = s
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&[a-z]+;/gi, " ");
  // Collapse runs of whitespace
  s = s.replace(/[ \t]+/g, " ").replace(/\n\s*\n+/g, "\n\n").trim();
  return s.slice(0, 12000);
}

/** Same regex as `extractBraveAnswerBox` but applied to raw HTML.
 *  The AI answer in Brave's HTML is wrapped in a `<div class="...">`
 *  with the answer text inside; we look for a `<p>` or `<div>` that
 *  follows the AI-answer marker and contains a long paragraph. */
function extractBraveAnswerBoxFromHTML(html: string): string | null {
  // Look for the AI-answer marker followed by a long paragraph
  const m = html.match(/AI[\u2010-\u2015\-]?generated[^<]*<\/[^>]+>\s*<([a-z]+)[^>]*>([\s\S]{120,1500}?)<\/\1>/i);
  if (m) return stripTags(m[2] ?? "").trim();
  return null;
}

/** Wikipedia REST API fallback for "who is X" / "what is X" queries.
 *  Two-step: opensearch to find the article, then summary endpoint to
 *  get the intro. Free, no key, no rate limit. Uses safeFetch so the
 *  endpoint can't be spoofed into talking to a private IP via DNS
 *  rebinding, even though the URL is constructed from a constant
 *  template + URL-encoded query string. */
async function wikipediaFastPath(
  query: string,
): Promise<{ title: string; url: string; extract: string } | null> {
  const searchUrl = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=1&format=json`;
  const sr = await safeFetch(searchUrl, { signal: AbortSignal.timeout(10_000) });
  if (!sr.ok) return null;
  const data = (await sr.json()) as [string, string[], string[], string[]];
  const titles = data[1];
  if (!titles || titles.length === 0) return null;
  const title = titles[0]!;
  const articleUrl = `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;
  const sumUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`;
  const sumR = await safeFetch(sumUrl, { signal: AbortSignal.timeout(10_000) });
  if (!sumR.ok) return null;
  const sumData = (await sumR.json()) as {
    title?: string;
    extract?: string;
    content_urls?: { desktop?: { page?: string } };
  };
  if (!sumData.extract) return null;
  return {
    title: sumData.title ?? title,
    url: sumData.content_urls?.desktop?.page ?? articleUrl,
    extract: sumData.extract.slice(0, 4000),
  };
}
