// Bulletproof web-search for chat + panel code paths.
//
// This is the single entry point every chat / panel handler calls.
// It always returns SOMETHING useful — never an empty result set —
// because every tier falls back to the next:
//
//   1. Pattern-match factual queries ("who is the pm of X",
//      "capital of Y", "president of Z") and hit Wikipedia REST
//      directly with the topic as the article title.
//   2. Wikipedia REST opensearch → summary free-text lookup.
//   3. lightpanda / plain fetch through a chain of free search engines.
//   4. Wikipedia opensearch with a rephrased query.
//
// If we still have nothing, return a graceful "no fresh data" marker
// instead of an empty list — the caller's system override will let
// the model answer from training data rather than refuse outright.

export interface WebSearchHit {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

export interface WebSearchResult {
  query: string;
  results: WebSearchHit[];
  answer: string | null;
  service: string;
  /** Free-text note about what we did. Useful for debugging + UI. */
  trace: string[];
  /** True if every tier failed and we have nothing. */
  exhausted: boolean;
}

const TIMEOUT_MS = 10_000;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Pattern-match common factual queries and return a Wikipedia article
 *  title that we can look up directly. Returns null if the query
 *  doesn't match any known pattern. */
function factualTopicToWikiTitle(query: string): string | null {
  const q = query
    .trim()
    // Strip common filler instructions the user tacks on, e.g.
    // "who is the pm of bangladesh? one sentence" or
    // "what is the capital of france? answer in one word".
    .replace(
      /\b(?:answer|reply)\s+in\s+(?:one\s+)?(?:a\s+)?(?:single\s+)?(?:sentence|word|line|paragraph)\b.*$/i,
      "",
    )
    .replace(/\b(?:in\s+)?one\s+(?:sentence|word|line|paragraph)\b.*$/i, "")
    .replace(/\bjust\s+(?:one\s+)?(?:a\s+)?(?:word|sentence|line)\b.*$/i, "")
    .replace(/\b(?:please|thanks|thank\s+you)\b.*$/i, "")
    .replace(/\b(?:only|just)\b.*$/i, "")
    .trim();

  // "who is the prime minister of X" / "who is the pm of X"
  const pm = q.match(/\b(?:prime\s+minister|pm)\s+of\s+(?:the\s+)?(.+)/i);
  if (pm) {
    const country = pm[1]!.trim().replace(/[?.!]+$/, "");
    return `Prime Minister of ${titleCase(country)}`;
  }
  // "who is the president of X"
  const pres = q.match(/\bpresident\s+of\s+(?:the\s+)?(.+)/i);
  if (pres) {
    const country = pres[1]!.trim().replace(/[?.!]+$/, "");
    return `President of ${titleCase(country)}`;
  }
  // "who is the king/queen of X"
  const monarch = q.match(/\b(?:king|queen|monarch)\s+of\s+(?:the\s+)?(.+)/i);
  if (monarch) {
    const country = monarch[1]!.trim().replace(/[?.!]+$/, "");
    return `Monarchy of ${titleCase(country)}`;
  }
  // "capital of X"
  const cap = q.match(/\bcapital\s+(?:city\s+)?of\s+(?:the\s+)?(.+)/i);
  if (cap) {
    const country = cap[1]!.trim().replace(/[?.!]+$/, "");
    return titleCase(country);
  }
  // "population of X"
  const pop = q.match(/\bpopulation\s+of\s+(?:the\s+)?(.+)/i);
  if (pop) {
    const country = pop[1]!.trim().replace(/[?.!]+$/, "");
    return titleCase(country);
  }
  return null;
}

/** Smart query classifier — used by chat + panel to pick the right
 *  retrieval strategy and adapt the system prompt. Returns one of
 *  "factual" | "news" | "comparison" | "howto" | "creative" | "general".
 *  The goal: every user question gets the most useful retrieval tier
 *  and a system-prompt frame that's actually appropriate for it. */
export type QueryIntent =
  | "factual"
  | "news"
  | "comparison"
  | "howto"
  | "creative"
  | "general";

export function classifyQuery(query: string): QueryIntent {
  const q = query.trim();
  // News intent — explicit news term + time/list signal, or just
  // "top/best N" with a geographic scope.
  if (isNewsQuery(q)) return "news";
  // Comparison intent — X vs Y / X or Y / X compared to Y.
  if (/\bvs\.?\b|\bversus\b|\bcompared\s+to\b|\bor\s+better\b|\bwhich\s+is\s+better\b/i.test(q)) {
    return "comparison";
  }
  // How-to / explanation — how / why / what does X do / explain
  if (/^(how|why)\b/i.test(q) ||
      /\b(explain|how\s+does|how\s+do|how\s+to|why\s+is|why\s+does|why\s+do|how\s+come)\b/i.test(q)) {
    return "howto";
  }
  // Creative — write / draft / compose / poem / story / email
  if (/^(write|draft|compose|craft|generate)\b/i.test(q) ||
      /\b(write\s+me|write\s+a|draft\s+(?:a|an|me)|compose\s+(?:a|an))\b/i.test(q)) {
    return "creative";
  }
  // Factual — who/what/when/where of a specific entity.
  if (/^(who|what|when|where)\b/i.test(q) ||
      /\b(who\s+is|who\s+was|what\s+is\s+the|when\s+did|where\s+is)\b/i.test(q)) {
    return "factual";
  }
  return "general";
}

/** Detect news-shaped queries (e.g. "top 5 cyber news today in uk",
 *  "latest AI news this week", "breaking news about tesla", "best
 *  5 X news Y", "what's hot in uk"). The Google News RSS feed
 *  gives per-article URLs that the generic search engines can't,
 *  so we route these through a dedicated tier. */
function isNewsQuery(query: string): boolean {
  const hasNewsTerm =
    /\b(news|headlines|stories|article|articles|press|hot|happening|buzz|trending)\b/i.test(query);
  if (!hasNewsTerm) {
    // Catch "top 5" / "best 5" alone — users often drop the "news"
    // when the context is obvious from prior messages.
    const hasList =
      /\b(?:top|best|latest|current|breaking|recent)\s+\d+\b/i.test(query) ||
      /^\s*(?:what(?:'s)?\s+(?:is\s+)?hot|what(?:'s)?\s+happening)/i.test(query);
    if (!hasList) return false;
  }
  // Time/list signals that strongly imply "give me stories from now":
  // top, latest, best, current, recent, breaking, today's, today,
  // this week / month / year, etc. We also accept "top N" / "best
  // N" patterns where the user is asking for a list.
  return /\b(top|latest|best|current|breaking|recent|today(?:'s)?|yesterday|this\s+(?:week|month|year)|update|happening|now|hot|buzz|trending)\b/i.test(query)
      || /\b(?:top|best|give\s+me|show\s+me)\s+\d+\b/i.test(query)
      || /^\s*(?:what\s+(?:is|are)|who|when|where)\s+(?:the\s+)?(?:latest|recent|top|best|current|new|today|hot)/i.test(query)
      || /^\s*what(?:'s)?\s+(?:hot|happening|new|trending)\b/i.test(query);
}

/** Extract the N from "top N" / "best N" / "give me N" patterns so the
 *  system override can pass it to the model. Returns null if not
 *  a list query. */
export function extractListCount(query: string): number | null {
  const m = query.match(/\b(?:top|best|give\s+me|show\s+me|list)\s+(\d{1,2})\b/i);
  if (m) {
    const n = Number(m[1]);
    if (n >= 1 && n <= 50) return n;
  }
  // "five" / "ten" / etc.
  const words: Record<string, number> = {
    one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  const w = query.match(/\b(?:top|best)\s+(one|two|three|four|five|six|seven|eight|nine|ten)\b/i);
  if (w) return words[w[1]!.toLowerCase()] ?? null;
  return null;
}

/** Rewrite informal / vague news queries into something Google News
 *  is more likely to index. "top 5 hot news" → "top uk news", etc. */
function rewriteNewsQuery(query: string): string {
  let q = query.trim();
  // Strip filler
  q = q.replace(/\b(?:please|thanks?|thank\s+you)\b/gi, "").trim();
  // Strip "top N" / "best N" — we keep the count for the model but
  // remove it from the Google News query so it doesn't choke.
  q = q.replace(/\b(?:top|best|latest)\s+\d+\b/gi, "").trim();
  // Expand informal terms.
  q = q.replace(/\bhot\s+news\b/gi, "news");
  q = q.replace(/\bbuzz\b/gi, "news");
  // "for today in UK" → "today UK"
  q = q.replace(/\bfor\s+today\b/gi, "today").trim();
  // Drop "tell me"
  q = q.replace(/^tell\s+me\s+/i, "").trim();
  return q || query.trim();
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1).toLowerCase() : w))
    .join(" ");
}

// ----------------------------------------------------------------- smart multi-tier search

export interface SmartSearchOptions {
  /** Maximum total results to return across all tiers (default 8). */
  maxResults?: number;
  /** Optional URL extracted from the user's message — fetch directly. */
  url?: string;
  /** When true, skip tiers that don't fit the query intent. */
  intentAware?: boolean;
}

/** Build a search plan from the query and intent — which tiers to
 *  try, in what order, with what locale. The plan is the same
 *  shape the runtime `webSearch` uses internally, but here we
 *  return the plan + run all tiers in parallel and merge. */
function planTiers(query: string, intent: QueryIntent, opts: SmartSearchOptions): string[] {
  const plan: string[] = [];
  // 1. Direct URL fetch takes priority.
  if (opts.url) {
    plan.push("url");
    return plan;
  }
  // 2. Wikipedia fast-path for factual lookups ("prime minister of X").
  if (intent === "factual") plan.push("wikipedia");
  // 3. Google News for news / current-events queries.
  if (intent === "news") plan.push("news");
  // 4. Wikipedia opensearch fallback (general factual coverage).
  plan.push("opensearch");
  // 5. Search engines for general / how-to / comparison / creative.
  plan.push("search-engines");
  return plan;
}

/** Single entry point that always runs multi-tier search in
 *  parallel and merges results. Returns a deduplicated, ranked
 *  list of hits plus per-tier trace info. Used by chat + panel. */
export async function smartSearch(
  query: string,
  opts: SmartSearchOptions = {},
): Promise<WebSearchResult> {
  const maxResults = opts.maxResults ?? 8;
  const trace: string[] = [];
  const intent = classifyQuery(query);
  trace.push(`intent=${intent}`);

  const plan = planTiers(query, intent, opts);
  trace.push(`plan=${plan.join(",")}`);

  // Build a parallel set of promises for each tier.
  type TierPromise = Promise<{ name: string; result: WebSearchResult | null }>;
  const tasks: TierPromise[] = [];
  for (const t of plan) {
    if (t === "url" && opts.url) {
      tasks.push(
        tierUrl(opts.url, query, trace).then((r) => ({ name: "url", result: r })),
      );
    } else if (t === "wikipedia") {
      const title = factualTopicToWikiTitle(query);
      if (title) {
        tasks.push(
          tierFactual(title, trace).then((r) => ({ name: "wikipedia", result: r })),
        );
      }
    } else if (t === "news") {
      tasks.push(tierNews(query, trace).then((r) => ({ name: "news", result: r })));
    } else if (t === "opensearch") {
      tasks.push(tierOpensearch(query, trace).then((r) => ({ name: "opensearch", result: r })));
    } else if (t === "search-engines") {
      tasks.push(tierSearchEngines(query, trace).then((r) => ({ name: "search-engines", result: r })));
    }
  }

  const settled = await Promise.allSettled(tasks);
  const merged: WebSearchHit[] = [];
  const seen = new Set<string>();
  let primary: WebSearchResult | null = null;
  let primaryTier = "";
  for (const s of settled) {
    if (s.status !== "fulfilled" || !s.value.result) continue;
    const { name, result } = s.value;
    trace.push(`tier=${name} hits=${result.results.length}`);
    // First non-empty tier is the primary "answer source" — its
    // answer blob (if any) goes to the model verbatim.
    if (!primary && result.results.length > 0) {
      primary = result;
      primaryTier = name;
    }
    for (const hit of result.results) {
      if (seen.has(hit.url)) continue;
      seen.add(hit.url);
      merged.push(hit);
      if (merged.length >= maxResults) break;
    }
    if (merged.length >= maxResults) break;
  }
  // If everything failed, return exhausted.
  if (merged.length === 0 && !primary) {
    return {
      query,
      results: [],
      answer: null,
      service: "exhausted",
      trace: [...trace, "all tiers failed"],
      exhausted: true,
    };
  }
  return {
    query,
    results: merged,
    answer: primary?.answer ?? null,
    service: primary?.service ?? "multi",
    trace,
    exhausted: false,
  };
}

/** Direct-URL fetch tier — used when the user pastes a URL. */
async function tierUrl(
  url: string,
  query: string,
  trace: string[],
): Promise<WebSearchResult | null> {
  trace.push(`tier-url: ${url}`);
  try {
    const r = await fetchText(url, 12_000);
    const text = htmlToText(r);
    return {
      query,
      service: "url",
      results: [
        {
          title: url,
          url,
          snippet: text.slice(0, 600),
          source: "url",
        },
      ],
      answer: text.slice(0, 4000),
      trace,
      exhausted: false,
    };
  } catch (err) {
    trace.push(`tier-url failed: ${(err as Error).message}`);
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
  return s.replace(/\s+/g, " ").trim().slice(0, 8000);
}

// ----------------------------------------------------------------- fetch

async function fetchText(url: string, timeoutMs = TIMEOUT_MS): Promise<string> {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: {
      "User-Agent": USER_AGENT,
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (!r.ok) throw new Error(`fetch ${url} → ${r.status}`);
  return r.text();
}

// ----------------------------------------------------------------- tiers

/** Tier 1: Pattern-matched factual query → Wikipedia REST by title. */
async function tierFactual(title: string, trace: string[]): Promise<WebSearchResult | null> {
  trace.push(`tier1: factual lookup → ${title}`);
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, "_"))}`;
  try {
    const r = await fetchText(url);
    const data = JSON.parse(r) as {
      title?: string;
      extract?: string;
      content_urls?: { desktop?: { page?: string } };
    };
    if (!data.extract) return null;
    const pageUrl =
      data.content_urls?.desktop?.page ??
      `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`;

    // The REST summary doesn't include the infobox — e.g. for
    // "Prime Minister of Bangladesh" it says "the head of government"
    // but never says "Tarique Rahman". Fetch the article HTML and
    // extract the infobox so the actual answer (the current
    // incumbent's name) reaches the model.
    let answer = data.extract;
    try {
      const html = await fetchText(pageUrl);
      const infobox = extractInfobox(html);
      if (infobox) {
        answer = `${data.extract}\n\nCurrent: ${infobox}`;
      }
    } catch {
      // keep the summary as the answer
    }

    return {
      query: title,
      service: "wikipedia",
      results: [
        {
          title: data.title ?? title,
          url: pageUrl,
          snippet: answer.slice(0, 600),
          source: "wikipedia",
        },
      ],
      answer,
      trace,
      exhausted: false,
    };
  } catch (err) {
    trace.push(`tier1 failed: ${(err as Error).message}`);
    return null;
  }
}

/** Extract the "Incumbent" / "Current" / "Capital" line from a
 *  Wikipedia article's infobox. The infobox is rendered as a `<table>`
 *  with a `<th>` for the field and a `<td>` for the value. We look
 *  for rows whose label mentions Incumbent / Current / President /
 *  Prime Minister / Monarch / Capital / Population, and return the
 *  value. */
function extractInfobox(html: string): string | null {
  // Try to locate the infobox table first (class starts with "infobox").
  const infoboxRe = /<table[^>]*class="[^"]*infobox[^"]*"[\s\S]*?<\/table>/i;
  const tableMatch = html.match(infoboxRe);
  const table = tableMatch ? tableMatch[0] : html;
  // Walk every <tr> in the table.
  const rowRe = /<tr\b[\s\S]*?<\/tr>/gi;
  const rows = [...table.matchAll(rowRe)]
    .map((m) => stripTags(m[0]).replace(/\s+/g, " ").trim())
    .filter((t) => t.length >= 3 && t.length <= 400);

  // First pass: look for the actual current-holder / capital / population
  // row. These are always the answer for "who is X" / "what is X" queries.
  const directKeys = [
    "Incumbent",
    "Current",
    "Head of State",
    "Capital",
    "Population",
  ];
  for (const key of directKeys) {
    for (const txt of rows) {
      if (new RegExp(`\\b${key}\\b`, "i").test(txt)) return txt;
    }
  }

  // Second pass: fall back to role labels (President / PM / Monarch).
  // These ALSO match the infobox title row, so we skip the very first
  // row — that's always the role title (e.g. "Prime Minister of the
  // People's Republic of Bangladesh") and not the actual answer.
  const roleKeys = ["President", "Prime Minister", "Monarch", "Sovereign", "Leader"];
  for (let i = 1; i < rows.length; i++) {
    const txt = rows[i]!;
    for (const key of roleKeys) {
      if (new RegExp(`\\b${key}\\b`, "i").test(txt)) return txt;
    }
  }
  return null;
}

/** Tier 2: Wikipedia REST opensearch by free-text query. */
async function tierOpensearch(query: string, trace: string[]): Promise<WebSearchResult | null> {
  trace.push(`tier2: opensearch("${query}")`);
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&search=${encodeURIComponent(query)}&limit=3&format=json`;
  try {
    const r = await fetchText(url);
    const data = JSON.parse(r) as [string, string[], string[], string[]];
    const titles = data[1] ?? [];
    if (titles.length === 0) {
      trace.push("tier2: no titles");
      return null;
    }
    // Fetch the first summary.
    const first = titles[0]!;
    const sumUrl = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(first.replace(/ /g, "_"))}`;
    try {
      const sum = await fetchText(sumUrl);
      const sumData = JSON.parse(sum) as {
        title?: string;
        extract?: string;
        content_urls?: { desktop?: { page?: string } };
      };
      if (!sumData.extract) {
        trace.push("tier2: no extract");
        return null;
      }
      const results: WebSearchHit[] = titles.map((title, i) => ({
        title,
        url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, "_"))}`,
        snippet: (data[3]?.[i] ?? "").slice(0, 200) || sumData.extract!.slice(0, 200),
        source: "wikipedia",
      }));
      return {
        query,
        service: "wikipedia",
        results,
        answer: sumData.extract,
        trace,
        exhausted: false,
      };
    } catch (err) {
      trace.push(`tier2 summary failed: ${(err as Error).message}`);
      return null;
    }
  } catch (err) {
    trace.push(`tier2 failed: ${(err as Error).message}`);
    return null;
  }
}

/** Tier 3: Search engines (Brave → DDG → Startpage) via plain fetch + HTML parse. */
async function tierSearchEngines(query: string, trace: string[]): Promise<WebSearchResult | null> {
  const enc = encodeURIComponent(query);
  const engines: Array<{ name: string; url: string; extractAnswers: (html: string) => string | null }> = [
    {
      name: "brave",
      url: `https://search.brave.com/search?q=${enc}&source=web`,
      extractAnswers: extractBraveAnswer,
    },
    {
      name: "duckduckgo",
      url: `https://html.duckduckgo.com/html/?q=${enc}`,
      extractAnswers: () => null,
    },
    {
      name: "startpage",
      url: `https://www.startpage.com/do/search?q=${enc}`,
      extractAnswers: () => null,
    },
  ];
  for (const engine of engines) {
    trace.push(`tier3: ${engine.name}`);
    try {
      const html = await fetchText(engine.url);
      if (looksBlocked(html)) {
        trace.push(`tier3 ${engine.name}: blocked/captcha`);
        continue;
      }
      const results = parseHTMLResults(html, 5);
      if (results.length === 0) {
        trace.push(`tier3 ${engine.name}: no results parsed`);
        continue;
      }
      const answerBox = engine.extractAnswers(html);
      // Try to fetch the top page for richer text.
      let topText = "";
      if (results[0]) {
        try {
          topText = await fetchAndHtmlToText(results[0].url);
        } catch { /* ignore */ }
      }
      return {
        query,
        service: engine.name,
        results,
        answer: answerBox || topText || null,
        trace,
        exhausted: false,
      };
    } catch (err) {
      trace.push(`tier3 ${engine.name} failed: ${(err as Error).message}`);
      continue;
    }
  }
  return null;
}

function looksBlocked(html: string): boolean {
  const lower = html.toLowerCase();
  return (
    lower.includes("unfortunately, bots use duckduckgo") ||
    lower.includes("captcha") ||
    lower.includes("verifying your request") ||
    lower.includes("are you a human")
  );
}

function extractBraveAnswer(html: string): string | null {
  // The AI answer is in a <div> or <p> with class containing "answer" or
  // right after an "AI-generated" marker.
  const m = html.match(/AI[\u2010-\u2015\-]?generated[\s\S]{0,200}?<\/[^>]+>\s*<([a-z]+)[^>]*>([\s\S]{120,1500}?)<\/\1>/i);
  if (m) return stripTags(m[2] ?? "").trim();
  return null;
}

function parseHTMLResults(html: string, maxResults: number): WebSearchHit[] {
  const found: WebSearchHit[] = [];
  const seen = new Set<string>();

  // DDG-style class anchors
  const classRe = /<a\b[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(classRe)) {
    const url = unwrapRedirect(m[1] ?? "");
    if (looksLikeNav(url)) continue;
    const title = stripTags(m[2] ?? "").trim();
    if (title.length < 4) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    found.push({ title, url, snippet: "", source: "html" });
    if (found.length >= maxResults) break;
  }

  // Any other off-site anchor
  if (found.length < maxResults) {
    const anyRe = /<a\b[^>]*\bhref="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    for (const m of html.matchAll(anyRe)) {
      const url = unwrapRedirect(m[1] ?? "");
      if (looksLikeNav(url)) continue;
      const inner = m[2] ?? "";
      if (/^<img\b/i.test(inner.trim())) continue;
      if (/<a\b/i.test(inner)) continue;
      const title = stripTags(inner).trim();
      if (title.length < 4) continue;
      if (seen.has(url)) continue;
      seen.add(url);
      found.push({ title, url, snippet: "", source: "html" });
      if (found.length >= maxResults) break;
    }
  }
  return found;
}

function unwrapRedirect(url: string): string {
  if (url.startsWith("//")) url = "https:" + url;
  try {
    const u = new URL(url);
    if (
      (u.hostname === "duckduckgo.com" || u.hostname === "html.duckduckgo.com") &&
      u.pathname.startsWith("/l/")
    ) {
      const target = u.searchParams.get("uddg");
      if (target) return target;
    }
    if (u.hostname === "www.bing.com" && u.pathname.startsWith("/ck/")) {
      const target = u.searchParams.get("u");
      if (target) return target;
    }
    return u.toString();
  } catch {
    return url;
  }
}

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
];

function looksLikeNav(url: string): boolean {
  return NAV_HOSTNAMES.some((h) => url.startsWith(`https://${h}`) || url.startsWith(`http://${h}`));
}

function stripTags(s: string): string {
  // Insert a space at <br> and closing block tags so adjacent words
  // don't smush together (e.g. "Incumbent<br/>Tarique" → "Incumbent Tarique").
  let out = s
    .replace(/<br\b[^>]*>/gi, " ")
    .replace(/<\/(p|div|li|h[1-6]|tr|td|th)>/gi, " ");
  // Strip all remaining tags.
  out = out.replace(/<[^>]+>/g, "");
  // Decode HTML entities.
  out = out
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&[a-z]+;/gi, " ");
  // Collapse whitespace.
  return out.replace(/\s+/g, " ").trim();
}

async function fetchAndHtmlToText(url: string): Promise<string> {
  const html = await fetchText(url);
  return htmlToText(html);
}

/** Google News RSS feed — gives per-article URLs (wrapped in a Google
 *  News redirect that 302s to the real article), each with the
 *  publication name in a <source> child. This is the only path that
 *  returns real article URLs for "top 5 news" queries — generic
 *  search engines return either no news results or an AI-summary
 *  blob without URLs. */
async function tierNews(query: string, trace: string[]): Promise<WebSearchResult | null> {
  trace.push("tier-news: google news rss");
  const rewritten = rewriteNewsQuery(query);
  if (rewritten !== query) trace.push(`tier-news: rewritten "${query}" → "${rewritten}"`);
  // Try the rewritten query first; fall back to the original if it
  // produces zero items (e.g. very informal rewrites).
  const queries = rewritten !== query ? [rewritten, query] : [query];
  for (const q of queries) {
    const enc = encodeURIComponent(q);
    // Try the user's likely region first (UK/GB → en-GB + GB:en),
    // then fall back to en-US. The region param affects which
    // publisher set Google News surfaces.
    const localeVariants = q.match(/\buk\b|\bbritain\b|\bengland\b|\bscotland\b|\bwales\b/i)
      ? [
          `hl=en-GB&gl=GB&ceid=GB:en`,
          `hl=en-US&gl=US&ceid=US:en`,
        ]
      : [
          `hl=en-US&gl=US&ceid=US:en`,
          `hl=en-GB&gl=GB&ceid=GB:en`,
        ];
    for (const locale of localeVariants) {
      const url = `https://news.google.com/rss/search?q=${enc}&${locale}`;
      let xml: string;
      try {
        xml = await fetchText(url, 10_000);
      } catch (err) {
        trace.push(`tier-news fetch failed (${locale}): ${(err as Error).message}`);
        continue;
      }
      const parsed = parseGoogleNewsRss(xml);
      if (parsed.length >= 3) {
        trace.push(`tier-news: ${parsed.length} items via "${q}" / ${locale}`);
        return {
          query,
          service: "google news",
          results: parsed,
          answer: null,
          trace,
          exhausted: false,
        };
      }
    }
  }
  trace.push("tier-news: no items after all variants");
  return null;
}

/** Parse a Google News RSS XML payload into structured hits. Items
 *  are returned in source order (already most-recent first), capped
 *  at 20 so the model has plenty of candidates to pick from. */
function parseGoogleNewsRss(xml: string): WebSearchHit[] {
  const itemRe = /<item>([\s\S]*?)<\/item>/gi;
  const items: WebSearchHit[] = [];
  const seen = new Set<string>();
  for (const m of xml.matchAll(itemRe)) {
    const block = m[1]!;
    const titleMatch = block.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/) ||
      block.match(/<title>([\s\S]*?)<\/title>/);
    const linkMatch = block.match(/<link>([\s\S]*?)<\/link>/);
    const sourceMatch = block.match(/<source[^>]*url="([^"]+)"[^>]*>([\s\S]*?)<\/source>/);
    const pubDateMatch = block.match(/<pubDate>([\s\S]*?)<\/pubDate>/);
    if (!titleMatch || !linkMatch) continue;
    const title = stripTags(titleMatch[1]!).trim();
    let url = stripTags(linkMatch[1]!).trim();
    if (!title || !url) continue;
    if (sourceMatch) {
      const srcName = stripTags(sourceMatch[2]!).trim();
      const srcUrl = sourceMatch[1]!.trim();
      // Prefer the publisher's URL when we can extract it — the
      // Google News wrapper 302s to the real article, but the
      // source URL is a direct publisher link.
      if (srcUrl) url = srcUrl;
      if (srcName) {
        // Prepend the publication name to the title so the model
        // sees "BBC — Track UK's latest migration numbers" and
        // can pick UK-specific stories by name.
        const prefixed = `${srcName} — ${title}`;
        if (!seen.has(url) && !seen.has(prefixed)) {
          seen.add(url);
          seen.add(prefixed);
          items.push({
            title: prefixed,
            url,
            snippet: pubDateMatch ? `Published: ${stripTags(pubDateMatch[1]!).trim()}` : "",
            source: srcName,
          });
        }
      }
    }
    if (items.length >= 20) break;
  }
  return items;
}

// ----------------------------------------------------------------- entry

/** Single entry point for chat + panel code. Always returns SOMETHING. */
export async function webSearch(query: string): Promise<WebSearchResult> {
  const trace: string[] = [];

  // Tier 1: pattern-match factual queries → go straight to Wikipedia.
  const title = factualTopicToWikiTitle(query);
  if (title) {
    const t1 = await tierFactual(title, trace);
    if (t1) return t1;
  }

  // Tier 2: news-shaped queries → Google News RSS for per-article URLs.
  if (isNewsQuery(query)) {
    const tNews = await tierNews(query, trace);
    if (tNews) return tNews;
  }

  // Tier 3: Wikipedia REST opensearch.
  const t2 = await tierOpensearch(query, trace);
  if (t2) return t2;

  // Tier 4: search engines.
  const t3 = await tierSearchEngines(query, trace);
  if (t3) return t3;

  // Tier 5: rephrased Wikipedia lookup for "who is X" queries.
  const rephrased = query
    .replace(/^who\s+is\s+(?:the\s+)?/i, "")
    .replace(/\?+$/, "")
    .trim();
  if (rephrased && rephrased !== query) {
    const t4 = await tierOpensearch(rephrased, trace);
    if (t4) return t4;
  }

  // Everything failed. Return a graceful exhausted result so the
  // caller can let the model answer from training data.
  return {
    query,
    results: [],
    answer: null,
    service: "exhausted",
    trace: [...trace, "all tiers failed"],
    exhausted: true,
  };
}
