// WebSearch — user-facing search box that calls /api/web-search.
// Admin config lives in Settings → websearch (WebSearchAdminTab).

import { useEffect, useState } from "react";
import { apiGet, apiPost } from "../api/client";
import { Badge } from "../components/ui/Badge";
import { Button } from "../components/ui/Button";
import { CallSign } from "../components/ui/CallSign";
import { Input } from "../components/ui/Input";
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

  const lastResult = response;
  return (
    <div className="p-6 max-w-[900px] space-y-4">
      <div className="flex items-baseline gap-3">
        <h2 className="font-display text-[20px] font-semibold text-text tracking-wide">
          Web Search
        </h2>
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
      </div>
      <div className="text-textMuted text-[13px]">
        Real-time web search across the public internet. Admin configures the provider key
        in Settings → websearch. Each call is logged and subject to per-user quota and the
        web_search tool posture.
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Card label="quota today" value={`${remaining} / ${status?.quota.daily_limit ?? 50}`} hint="resets every 24h" />
        <Card
          label="posture"
          value={status?.posture ?? "—"}
          hint="set in Workspace → posture"
        />
        <Card
          label="provider"
          value={configured ? status!.providers[0]!.service : "none"}
          hint="configured in Settings → websearch"
        />
      </div>

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

      {response && (
        <div className="space-y-3">
          {response.answer && (
            <div className="border border-brassSoft/40 bg-brass/5 px-4 py-3">
              <div className="mono-caps text-[10px] text-brass mb-1">
                Direct answer
              </div>
              <div className="text-[14px] text-text leading-relaxed">{response.answer}</div>
            </div>
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
              response.results.map((r, i) => (
                <div
                  key={i}
                  className="px-4 py-3 border-b border-borderSoft last:border-b-0"
                >
                  <div className="flex items-baseline gap-2 mb-1">
                    <Badge tone="brass">[{i + 1}]</Badge>
                    <a
                      href={safeHref(r.url)}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-[13px] text-text hover:text-brass underline-offset-2 hover:underline truncate flex-1"
                    >
                      {r.title}
                    </a>
                    <span className="mono-caps text-[10px] text-textFaint truncate max-w-[260px]">
                      {new URL(r.url).hostname}
                    </span>
                  </div>
                  <div className="font-mono text-[11px] text-textMuted mb-1 break-all">
                    {r.url}
                  </div>
                  {r.snippet && (
                    <div className="text-[12px] text-text leading-relaxed">
                      {r.snippet}
                    </div>
                  )}
                </div>
              ))
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

function Card({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint: string;
}) {
  return (
    <div className="border border-border bg-panel p-4">
      <div className="mono-caps text-[10px] text-textMuted">{label}</div>
      <div className="font-display text-[20px] font-semibold text-brass mt-1 truncate">
        {value}
      </div>
      <div className="mono-caps text-[10px] text-textFaint mt-1">{hint}</div>
    </div>
  );
}