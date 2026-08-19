// /health — real-time reachability of every popular AI provider.
//
// Pings 14 hardcoded public provider endpoints (OpenAI, Anthropic,
// Google Gemini, Mistral, Cohere, Groq, Together, OpenRouter,
// Perplexity, DeepSeek, xAI, Hugging Face, Replicate, Fireworks)
// every 30 seconds. No admin configuration required. No auth sent.
//
// Classification:
//   2xx, 3xx, 4xx → "up" (401/403 still mean the service is reachable)
//   5xx           → "degraded"
//   timeout, DNS failure, refused → "down"
//
// Each card shows the provider name, status dot, latency, last-
// checked timestamp, and a sparkline of the last 10 samples.

import { useEffect, useState, useRef } from "react";
import { apiGet } from "../api/client";
import { Button } from "../components/ui/Button";
import { Sparkline } from "../components/ui/data/charts";
import { RefreshIcon } from "../components/ui/Icon";
import { Skeleton } from "../components/ui/feedback/Skeleton";
import { cn } from "../lib/cn";

type Status = "up" | "degraded" | "down" | "unknown";

interface PopularProviderHealth {
  id: string;
  name: string;
  short: string;
  url: string;
  status: Status;
  latency_ms: number;
  http_code: number;
  checked_at: number;
  reason?: string;
}

interface Summary {
  up: number;
  degraded: number;
  down: number;
  unknown: number;
}

interface HealthResponse {
  providers: PopularProviderHealth[];
  summary: Summary;
  ts: number;
}

const STATUS_LABEL: Record<Status, string> = {
  up: "up",
  degraded: "degraded",
  down: "down",
  unknown: "checking…",
};

const STATUS_DOT: Record<Status, string> = {
  up: "bg-teal",
  degraded: "bg-amber",
  down: "bg-rust",
  unknown: "bg-textFaint",
};

const STATUS_TONE: Record<Status, "teal" | "amber" | "rust" | "neutral"> = {
  up: "teal",
  degraded: "amber",
  down: "rust",
  unknown: "neutral",
};

export function HealthPage() {
  const [data, setData] = useState<HealthResponse | null>(null);
  const historyRef = useRef<Map<string, number[]>>(new Map());
  const [, force] = useState(0);

  async function load(forceRefresh: boolean) {
    try {
      const q = forceRefresh ? "?refresh=1" : "";
      const res = await apiGet<HealthResponse>(`/health/providers/popular${q}`);
      setData(res);
      const hist = historyRef.current;
      for (const row of res.providers) {
        const prev = hist.get(row.id) ?? [];
        prev.push(row.latency_ms);
        if (prev.length > 10) prev.shift();
        hist.set(row.id, prev);
      }
      force((n) => n + 1);
    } catch {
      setData(null);
    }
  }

  useEffect(() => {
    void load(false);
    const id = setInterval(() => void load(false), 30_000);
    return () => clearInterval(id);
  }, []);

  const summary = data?.summary;
  const allUp = summary && summary.up === summary.up + summary.degraded + summary.down + summary.unknown;
  const anyDown = summary && summary.down > 0;

  return (
    <div className="p-6 max-w-[960px] space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-display text-[24px] font-semibold text-text tracking-wide leading-tight">
            Provider health
          </h2>
          <p className="text-textMuted text-[13px] mt-1">
            Real-time reachability of every popular AI provider. No configuration required.
            Refreshed every 30s. No auth is sent — a 401 still means the service is up.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <SummaryBar summary={summary} />
          <Button variant="ghost" onClick={() => void load(true)} title="force refresh">
            <RefreshIcon size={12} />
          </Button>
        </div>
      </div>

      {data === null ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {Array.from({ length: 12 }, (_, i) => (
            <Skeleton key={i} variant="block" height={112} />
          ))}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {data.providers.map((row) => (
            <ProviderCard
              key={row.id}
              row={row}
              history={historyRef.current.get(row.id) ?? []}
            />
          ))}
        </div>
      )}

      <p className="text-textFaint text-[11px] mono-caps">
        {data
          ? <>Last polled {new Date(data.ts).toLocaleTimeString()} · 14 providers · 30s cache</>
          : <>Loading…</>}
      </p>
    </div>
  );
}

function SummaryBar({ summary }: { summary: Summary | undefined }) {
  if (!summary) return null;
  const total = summary.up + summary.degraded + summary.down + summary.unknown;
  return (
    <div className="flex items-center gap-2 mono-caps text-[10px]">
      <Pill count={summary.up} label="up" tone="teal" />
      <Pill count={summary.degraded} label="degraded" tone="amber" />
      <Pill count={summary.down} label="down" tone="rust" />
      <span className="text-textFaint">/{ total }</span>
    </div>
  );
}

function Pill({ count, label, tone }: { count: number; label: string; tone: "teal" | "amber" | "rust" }) {
  const cls = tone === "teal"
    ? "border-teal/40 text-teal"
    : tone === "amber"
    ? "border-amber/40 text-amber"
    : "border-rust/40 text-rust";
  return (
    <span className={cn("border px-1.5 h-[18px] inline-flex items-center gap-1", cls)}>
      <span className="font-mono">{count}</span>
      <span>{label}</span>
    </span>
  );
}

function ProviderCard({
  row,
  history,
}: {
  row: PopularProviderHealth;
  history: number[];
}) {
  const dot = STATUS_DOT[row.status];
  const tone = STATUS_TONE[row.status];
  const host = (() => {
    try { return new URL(row.url).host; } catch { return row.url; }
  })();
  const reason = row.http_code > 0 ? `HTTP ${row.http_code}` : (row.reason ?? "—");
  return (
    <article className="border border-border bg-panel">
      <div className="px-4 py-3 flex items-center gap-3">
        <div className="flex flex-col items-center gap-1 w-[34px] shrink-0">
          <span className={cn("w-2.5 h-2.5 rounded-full", dot)} />
          <span className="font-mono text-[10px] text-textFaint tracking-wider">{row.short}</span>
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="font-mono text-[13px] text-text truncate">{row.name}</span>
            <span
              className={cn(
                "mono-caps text-[10px] border px-1.5 h-[16px] inline-flex items-center",
                tone === "teal" && "border-teal/40 text-teal",
                tone === "amber" && "border-amber/40 text-amber",
                tone === "rust" && "border-rust/40 text-rust",
                tone === "neutral" && "border-borderSoft text-textMuted",
              )}
            >
              {STATUS_LABEL[row.status]}
            </span>
          </div>
          <div className="mono-caps text-[10px] text-textFaint mt-0.5 truncate" title={row.url}>
            {host} · {row.latency_ms}ms · {reason}
          </div>
        </div>
        <div className="w-[80px] h-[28px] flex items-center">
          <Sparkline
            values={history}
            tone={row.status === "down" ? "rust" : row.status === "degraded" ? "muted" : "teal"}
            height={24}
            width={80}
          />
        </div>
      </div>
    </article>
  );
}
