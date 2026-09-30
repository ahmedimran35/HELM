// WebSearch — user-facing search box that calls /api/web-search.
// Admin config lives in Settings → websearch (WebSearchAdminTab).

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api/client";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { CallSign } from "../components/ui/CallSign";
import { Input } from "../components/ui/Input";
import { Markdown } from "../components/ui/Markdown";
import { ChevronDownIcon } from "../components/ui/Icon";
import { safeHref } from "../lib/safe-href";

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
  details: string | null;
  service: string | null;
  remaining_today: number;
  limit: number;
  cached?: boolean;
  auto_configured?: boolean;
}

interface WebSearchStatus {
  providers: Array<{ service: string; connected: boolean }>;
  quota: { daily_limit: number; used_today: number };
  posture: "auto" | "strict";
}

export function WebSearchPage() {
  const [status, setStatus] = useState<WebSearchStatus | null>(null);
  const [query, setQuery] = useState("");
  const [response, setResponse] = useState<WebSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    apiGet<WebSearchStatus>("/web-search/status").then(setStatus).catch(() => {});
  }, []);

  async function run() {
    if (!query.trim() || loading) return;
    setError(null);
    setResponse(null);
    setLoading(true);
    try {
      const data = await apiPost<WebSearchResponse>("/web-search", {
        query: query.trim(),
        max_results: 8,
      });
      setResponse(data);
      // Refresh quota in the sidebar.
      apiGet<WebSearchStatus>("/web-search/status").then(setStatus).catch(() => {});
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const configured = status && status.providers.length > 0;
  const remaining = status ? status.quota.daily_limit - status.quota.used_today : 0;

  return (
    <div className="content-page-sm space-y-4">
      {/* Search box — prominent, at top */}
      <div className="border border-border bg-panel p-4">
        <div className="flex items-end gap-2">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                run();
              }
            }}
            placeholder="What do you want to find out?"
            className="flex-1 h-10"
          />
          <Button
            variant="primary"
            onClick={run}
            disabled={loading || !query.trim() || !configured}
          >
            {loading ? "Searching…" : "Search"}
          </Button>
        </div>
        {!configured && (
          <div className="mt-2 mono-caps text-[10px] text-rust">
            No search provider configured. Ask an admin to add one in Settings → websearch.
          </div>
        )}
        {error && (
          <div className="mt-2 mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-2 py-1.5">
            {error}
          </div>
        )}
      </div>

      {/* Header + compact stats */}
      <div className="flex items-center gap-3 flex-wrap">
        <h2 className="page-title">Web Search</h2>
        <CallSign id="WSR-01" />
        {configured ? (
          status?.providers[0]?.service === "lightpanda" &&
          status.providers.length === 1 ? (
            <Badge tone="brass">lightpanda · auto-configured</Badge>
          ) : (
            <Badge tone="teal">{status?.providers[0]?.service} configured</Badge>
          )
        ) : (
          <Badge tone="rust">not configured</Badge>
        )}
        <span className="mono-caps text-[10px] text-textFaint">
          quota {remaining}/{status?.quota.daily_limit ?? 50} · posture {status?.posture ?? "—"} · provider {configured ? status!.providers[0]!.service : "none"}
        </span>
      </div>
      <div className="text-textMuted text-[13px]">
        Real-time web search across the public internet. Admin configures the provider key
        in Settings → websearch. Each call is logged and subject to per-user quota and the
        web_search tool posture.
      </div>

      {response && (
        <div className="space-y-3">
          {response.answer && (
            <div className="border border-brassSoft/40 bg-brass/5 px-4 py-3">
              <div className="mono-caps text-[10px] text-brass mb-1">
                Direct answer
              </div>
              <div className="text-[14px] text-text leading-relaxed">
                <Markdown content={response.answer} />
              </div>
            </div>
          )}
          {response.details && (
            <details className="group border border-border bg-panel">
              <summary className="px-4 py-2 cursor-pointer select-none mono-caps text-[11px] text-textMuted hover:text-text list-none flex items-center gap-2">
                <ChevronDownIcon size={11} className="transition-transform group-open:rotate-180" />
                Details
              </summary>
              <div className="px-4 pb-3 border-t border-borderSoft">
                <Markdown content={response.details} />
              </div>
            </details>
          )}
          <div className="border border-border bg-panel">
            <div className="px-4 py-2 border-b border-borderSoft mono-caps text-[11px] text-textMuted flex items-center justify-between">
              <span>
                Results ({response.results.length}){" "}
                {response.cached && (
                  <span className="text-textFaint">· cached</span>
                )}
              </span>
              <span className="text-textFaint">via {response.service}</span>
            </div>
            {response.results.length === 0 ? (
              <div className="p-4 mono-caps text-[11px] text-textFaint">
                no results
              </div>
            ) : (
              dedupeResults(response.results).map((r, i) => {
                let hostname = "";
                try {
                  hostname = new URL(r.url).hostname;
                } catch {
                  hostname = "";
                }
                const title = cleanTitle(r.title, r.url);
                return (
                  <div
                    key={r.url}
                    className="px-4 py-3 border-b border-borderSoft last:border-b-0 flex gap-3"
                  >
                    <img
                      src={`https://www.google.com/s2/favicons?domain=${hostname}&sz=32`}
                      alt=""
                      width={16}
                      height={16}
                      className="mt-0.5 shrink-0 rounded-sm"
                      loading="lazy"
                      onError={(e) => {
                        (e.currentTarget as HTMLImageElement).style.visibility = "hidden";
                      }}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2 mb-0.5">
                        <Badge tone="brass">[{i + 1}]</Badge>
                        <a
                          href={safeHref(r.url)}
                          target="_blank"
                          rel="noreferrer"
                          className="font-mono text-[13px] text-text hover:text-brass underline-offset-2 hover:underline truncate flex-1"
                        >
                          {title}
                        </a>
                      </div>
                      <div className="mono-caps text-[10px] text-textFaint truncate">
                        {hostname}
                      </div>
                      {r.snippet && (
                        <div className="text-[12px] text-text leading-relaxed mt-1 line-clamp-3">
                          {r.snippet}
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <div className="mono-caps text-[10px] text-textFaint text-right">
            {response.remaining_today} of {response.limit} searches remaining today
          </div>
        </div>
      )}
    </div>
  );
}

/** Normalise a URL for dedupe: drop the fragment and trailing slash so the
 *  same page listed with/without an `#anchor` collapses to one row. */
function normaliseUrl(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url;
  }
}

function dedupeResults(results: WebSearchResult[]): WebSearchResult[] {
  const seen = new Set<string>();
  const out: WebSearchResult[] = [];
  for (const r of results) {
    const key = normaliseUrl(r.url);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

/** Derive a readable title when the scraper returned the raw URL (or a
 *  junk token) as the title. Falls back to a title-cased last path segment. */
function cleanTitle(title: string, url: string): string {
  const t = (title ?? "").trim();
  if (t && !/^https?:\/\//i.test(t) && t.length > 1 && t !== "personal") return t;
  try {
    const u = new URL(url);
    const seg = u.pathname.split("/").filter(Boolean).pop();
    if (seg) {
      return decodeURIComponent(seg).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    }
    return u.hostname.replace(/^www\./, "");
  } catch {
    return t || url;
  }
}