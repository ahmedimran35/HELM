// /perf — performance dashboard (Tier 5).
//
// Aggregates last-30d metrics for the current user (admins see all).
// StatTiles at the top show avg latency, p95 latency, total tokens,
// total cost, cache hit rate, and tokens per turn. A LineChart
// renders the last-24h hourly latency series, and a small table
// lists top models by usage.

import { useEffect, useState } from "react";
import { apiGet } from "../api/client";
import { EmptyState } from "../components/ui/feedback/EmptyState";
import { Skeleton, SkeletonTable } from "../components/ui/feedback/Skeleton";
import { StatTile, LineChart, type LineDatum } from "../components/ui/data/charts";
import {
  GaugeIcon,
  ClockIcon,
  ZapIcon,
  DollarSignIcon,
  ActivityIcon,
  CheckIcon,
  RefreshIcon,
} from "../components/ui/Icon";
import { cn } from "../lib/cn";

interface PerfResponse {
  avg_latency_ms: number;
  p95_latency_ms: number;
  total_tokens: number;
  total_runs: number;
  error_runs: number;
  total_cost_cents: number;
  tokens_per_turn: number;
  cache: { total_rows: number; total_hits: number; hit_rate: number };
  latency_series: Array<{ bucket: string; avg_ms: number }>;
  top_models: Array<{ model: string; runs: number; tokens: number }>;
  per_panel: Array<{ panel_id: string; panel_name: string; runs: number; tokens: number }>;
}

export function PerfPage() {
  const [data, setData] = useState<PerfResponse | null>(null);

  async function load() {
    try {
      setData(await apiGet<PerfResponse>("/perf"));
    } catch {
      setData(null);
    }
  }

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), 30_000);
    return () => clearInterval(id);
  }, []);

  const latencySeries: LineDatum[] = (data?.latency_series ?? []).map((p) => ({
    label: shortBucket(p.bucket),
    value: p.avg_ms,
  }));
  const latencySpark = latencySeries.map((p) => p.value);

  return (
    <div className="p-6 max-w-[1100px] space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-display text-[24px] font-semibold text-text tracking-wide leading-tight">
            Performance
          </h2>
          <p className="text-textMuted text-[13px] mt-1">
            Latency, cache, throughput, and cost — last 30 days. Refreshed every 30s.
          </p>
        </div>
      </div>

      {data === null ? (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} variant="row" />
          ))}
        </div>
      ) : (
        <>
          <section className="grid grid-cols-2 md:grid-cols-3 gap-3">
            <StatTile
              label="avg latency"
              value={`${data.avg_latency_ms.toFixed(0)} ms`}
              tone="brass"
              icon={<ClockIcon size={16} />}
              spark={latencySpark}
              hint={`p95 ${data.p95_latency_ms.toFixed(0)} ms`}
            />
            <StatTile
              label="cache hit rate"
              value={`${(data.cache.hit_rate * 100).toFixed(1)}%`}
              tone="teal"
              icon={<CheckIcon size={16} />}
              hint={`${data.cache.total_hits} hits / ${data.cache.total_rows} rows`}
            />
            <StatTile
              label="total tokens"
              value={data.total_tokens.toLocaleString()}
              tone="brass"
              icon={<ZapIcon size={16} />}
              hint={`${data.total_runs.toLocaleString()} runs · ${data.error_runs} errors`}
            />
            <StatTile
              label="total cost"
              value={`${data.total_cost_cents.toFixed(2)} ¢`}
              tone="brass"
              icon={<DollarSignIcon size={16} />}
              hint="input + output"
            />
            <StatTile
              label="tokens / turn"
              value={data.tokens_per_turn.toFixed(0)}
              tone="teal"
              icon={<ActivityIcon size={16} />}
              hint="avg per day bucket"
            />
            <StatTile
              label="top model"
              value={data.top_models[0]?.model ?? "—"}
              tone="brass"
              icon={<GaugeIcon size={16} />}
              hint={data.top_models[0] ? `${data.top_models[0].runs} runs` : ""}
            />
          </section>

          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ChartCard
              title="Latency · last 24h"
              subtitle="hourly average in ms"
              isEmpty={latencySeries.length === 0}
            >
              <LineChart data={latencySeries} tone="brass" height={220} xAxis yAxis />
            </ChartCard>

            <ChartCard
              title="Top models by usage"
              subtitle="runs in the window"
              isEmpty={data.top_models.length === 0}
            >
              <ul className="divide-y divide-borderSoft">
                {data.top_models.map((m, i) => (
                  <li
                    key={m.model}
                    className="flex items-center gap-3 py-2"
                  >
                    <span
                      className={cn(
                        "font-mono text-[12px] w-6 text-right tabular-nums",
                        i === 0 ? "text-brass" : "text-textMuted",
                      )}
                    >
                      {i + 1}.
                    </span>
                    <span className="font-mono text-[13px] text-text flex-1 truncate">
                      {m.model}
                    </span>
                    <span className="font-mono text-[12px] text-textMuted tabular-nums w-20 text-right">
                      {m.runs.toLocaleString()} runs
                    </span>
                    <span className="font-mono text-[12px] text-textFaint tabular-nums w-24 text-right">
                      {m.tokens.toLocaleString()} tok
                    </span>
                  </li>
                ))}
              </ul>
            </ChartCard>
          </section>

          <section className="border border-border bg-panel">
            <header className="px-4 py-2 border-b border-borderSoft flex items-center gap-2">
              <ActivityIcon size={14} className="text-brass" />
              <span className="mono-caps text-[11px] text-textMuted tracking-wider">
                Per-panel usage
              </span>
            </header>
            <div className="p-4">
              {data.per_panel.length === 0 ? (
                <EmptyState
                  variant="inbox"
                  title="No panel activity yet"
                  description="Chat in a panel to populate this list."
                  tone="neutral"
                />
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="text-left text-[10px] mono-caps text-textFaint tracking-wider">
                      <th className="pb-2 pr-3">panel</th>
                      <th className="pb-2 pr-3 text-right">runs</th>
                      <th className="pb-2 text-right">tokens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.per_panel.map((p) => (
                      <tr key={p.panel_id} className="border-t border-borderSoft">
                        <td className="py-2 pr-3 font-mono text-[13px] text-text truncate max-w-[420px]">
                          {p.panel_name}
                        </td>
                        <td className="py-2 pr-3 font-mono text-[12px] tabular-nums text-right">
                          {p.runs.toLocaleString()}
                        </td>
                        <td className="py-2 font-mono text-[12px] tabular-nums text-right">
                          {p.tokens.toLocaleString()}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  isEmpty,
  children,
}: {
  title: string;
  subtitle?: string;
  isEmpty?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section className="border border-border bg-panel">
      <header className="px-4 py-2 border-b border-borderSoft flex items-center gap-2">
        <span className="mono-caps text-[11px] text-textMuted tracking-wider">
          {title}
        </span>
        {subtitle && (
          <span className="mono-caps text-[10px] text-textFaint">· {subtitle}</span>
        )}
      </header>
      <div className="p-4">
        {isEmpty ? (
          <EmptyState
            variant="ledger"
            title="Nothing to chart yet"
            description="Once there's activity, the chart will render here."
            tone="neutral"
          />
        ) : (
          children
        )}
      </div>
    </section>
  );
}

function shortBucket(s: string): string {
  const m = s.match(/T(\d{2}:\d{2})/);
  return m ? m[1]! : s;
}