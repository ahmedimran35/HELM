// /health — latency-aware harness health (Tier 5).
//
// Polls /api/health/harnesses every 30s. Each row shows the harness
// label, current status (green/amber/red), last measured latency,
// and a sparkline of the last few samples. A "refresh" button
// forces a fresh probe.

import { useEffect, useState, useRef } from "react";
import { apiGet } from "../api/client";
import { EmptyState } from "../components/ui/feedback/EmptyState";
import { StatusPill } from "../components/ui/feedback/StatusPill";
import { Button } from "../components/ui/Button";
import { Sparkline } from "../components/ui/data/charts";
import { ActivityIcon, RefreshIcon } from "../components/ui/Icon";
import { cn } from "../lib/cn";

interface HarnessHealth {
  kind: string;
  status: "healthy" | "degraded" | "down" | "unknown";
  latency_ms: number;
  last_checked_at: number;
  reason?: string;
}

interface HealthResponse {
  harnesses: HarnessHealth[];
}

const STATUS_LABEL: Record<HarnessHealth["status"], string> = {
  healthy: "healthy",
  degraded: "degraded",
  down: "down",
  unknown: "not configured",
};

const STATUS_TONE: Record<HarnessHealth["status"], "teal" | "amber" | "rust" | "neutral"> = {
  healthy: "teal",
  degraded: "amber",
  down: "rust",
  unknown: "neutral",
};

export function HealthPage() {
  const [data, setData] = useState<HarnessHealth[] | null>(null);
  // Sparkline history per harness — keeps the last ~10 samples.
  const historyRef = useRef<Map<string, number[]>>(new Map());
  const [, force] = useState(0);

  async function load(forceRefresh: boolean) {
    try {
      const q = forceRefresh ? "?refresh=1" : "";
      const res = await apiGet<HealthResponse>(`/health/harnesses${q}`);
      const rows = res.harnesses;
      setData(rows);
      for (const row of rows) {
        const prev = historyRef.current.get(row.kind) ?? [];
        prev.push(row.latency_ms);
        if (prev.length > 10) prev.shift();
        historyRef.current.set(row.kind, prev);
      }
      force((n) => n + 1);
    } catch {
      setData([]);
    }
  }

  useEffect(() => {
    void load(false);
    const id = setInterval(() => void load(false), 30_000);
    return () => clearInterval(id);
  }, []);

  const allHealthy = data && data.every((r) => r.status === "healthy");
  const anyDown = data && data.some((r) => r.status === "down");

  return (
    <div className="p-6 max-w-[900px] space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-display text-[24px] font-semibold text-text tracking-wide leading-tight">
            Harness health
          </h2>
          <p className="text-textMuted text-[13px] mt-1">
            Per-harness latency + status, refreshed every 30s. Failover skips red rows.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill
            state={
              data === null
                ? "unknown"
                : anyDown
                ? "degraded"
                : allHealthy
                ? "healthy"
                : "warming"
            }
            label={
              data === null
                ? "loading…"
                : anyDown
                ? "one or more harnesses down"
                : allHealthy
                ? "all harnesses healthy"
                : "some harnesses degraded"
            }
          />
          <Button variant="ghost" onClick={() => void load(true)} title="force refresh">
            <RefreshIcon size={12} />
          </Button>
        </div>
      </div>

      {data === null ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="border border-border bg-panel h-[68px]" />
          ))}
        </div>
      ) : data.length === 0 ? (
        <EmptyState
          variant="gear"
          title="No harnesses configured"
          description="Add an OpenAI / Anthropic provider, then come back to see live health."
          tone="neutral"
        />
      ) : (
        <section className="space-y-3">
          {data.map((row) => (
            <HarnessRow
              key={row.kind}
              row={row}
              history={historyRef.current.get(row.kind) ?? []}
            />
          ))}
        </section>
      )}
    </div>
  );
}

function HarnessRow({ row, history }: { row: HarnessHealth; history: number[] }) {
  const tone = STATUS_TONE[row.status];
  const dot =
    row.status === "healthy"
      ? "bg-teal"
      : row.status === "degraded"
      ? "bg-amber"
      : row.status === "down"
      ? "bg-rust"
      : "bg-textFaint";
  return (
    <article className="border border-border bg-panel">
      <div className="px-4 py-3 flex items-center gap-3">
        <span className={cn("w-2 h-2 rounded-full shrink-0", dot)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <ActivityIcon size={14} className="text-brass" />
            <span className="font-mono text-[13px] text-text">{row.kind}</span>
            <Badge tone={tone} small>
              {STATUS_LABEL[row.status]}
            </Badge>
          </div>
          <div className="mono-caps text-[10px] text-textFaint mt-0.5">
            {row.latency_ms} ms · last checked{" "}
            {new Date(row.last_checked_at).toLocaleTimeString()}
            {row.reason ? ` · ${row.reason}` : ""}
          </div>
        </div>
        <div className="w-[160px] h-[36px] flex items-center">
          <Sparkline
            values={history}
            tone={row.status === "down" ? "rust" : row.status === "degraded" ? "muted" : "teal"}
            height={28}
            width={160}
          />
        </div>
      </div>
    </article>
  );
}

// Small inline Badge so we don't import the heavy one for one row.
function Badge({
  tone,
  small,
  children,
}: {
  tone: "teal" | "amber" | "rust" | "neutral";
  small?: boolean;
  children: React.ReactNode;
}) {
  const cls =
    tone === "teal"
      ? "border-teal/40 text-teal"
      : tone === "amber"
      ? "border-amber/40 text-amber"
      : tone === "rust"
      ? "border-rust/40 text-rust"
      : "border-borderSoft text-textMuted";
  return (
    <span
      className={cn(
        "mono-caps tracking-wider border px-1.5 inline-flex items-center",
        small ? "h-[16px] text-[10px]" : "h-[18px] text-[11px]",
        cls,
      )}
    >
      {children}
    </span>
  );
}