// /analytics — Analytics (merged with the former /perf page).
//
// One tab answers everything about how the instance is used:
//   1. Speed & reliability   → latency, error rate, cache hit rate
//   2. Usage & cost          → tokens, tokens/run, cost, top model
//   3. Volume & adoption     → messages over time, top users (admin)
//   4. Attribution           → chat vs panel split, per-panel usage
//   5. Budget                → spend by model, budget overruns (admin)
//
// Perf data comes from GET /api/perf (harness_runs aggregates, last
// 30d; latency series last 24h). Analytics data comes from the
// /api/governance/analytics/* endpoints (admin-only) and renders only
// for admins. Refreshed every 30s.

import { useEffect, useState } from "react";
import { apiGet } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Avatar } from "../components/ui/Avatar";
import { CallSign } from "../components/ui/CallSign";
import { EmptyState } from "../components/ui/feedback/EmptyState";
import { Skeleton } from "../components/ui/feedback/Skeleton";
import { StatusPill } from "../components/ui/feedback/StatusPill";
import {
  BarChart,
  LineChart,
  type BarDatum,
  type LineDatum,
  StatTile,
} from "../components/ui/data/charts";
import {
  GaugeIcon,
  ClockIcon,
  ZapIcon,
  DollarSignIcon,
  ActivityIcon,
  CheckIcon,
  AlertTriangleIcon,
} from "../components/ui/Icon";
import { cn } from "../lib/cn";

// ── Perf data (GET /api/perf) ────────────────────────────────────────

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
  origins?: Array<{ origin: string; runs: number; tokens: number }>;
}

// ── Governance analytics data (admin) ────────────────────────────────

interface SpendByModel {
  model_id: string;
  model_name: string | null;
  tokens: number;
}

interface MessageBucket {
  bucket: string;
  count: number;
}

interface TopUser {
  user_id: string;
  user_name: string;
  count: number;
}

interface Alert {
  user_id: string;
  user_name: string;
  level: "warning" | "exceeded";
  ratio: number;
  dollars: number;
  limit: number;
}

export function AnalyticsPage() {
  const { user } = useAuth();
  const isAdmin = user?.role === "admin";

  // Perf metrics — every user sees these for their own (admins: all) runs.
  const [perf, setPerf] = useState<PerfResponse | null>(null);

  // Admin-only governance analytics.
  const [spend, setSpend] = useState<SpendByModel[] | null>(null);
  const [timeline, setTimeline] = useState<MessageBucket[] | null>(null);
  const [top, setTop] = useState<TopUser[] | null>(null);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);

  useEffect(() => {
    void apiGet<PerfResponse>("/perf").then(setPerf).catch(() => setPerf(null));
    if (!isAdmin) return;
    apiGet<SpendByModel[]>("/governance/analytics/spend-by-model")
      .then(setSpend)
      .catch(() => setSpend([]));
    apiGet<MessageBucket[]>("/governance/analytics/messages-over-time")
      .then(setTimeline)
      .catch(() => setTimeline([]));
    apiGet<TopUser[]>("/governance/analytics/top-users")
      .then(setTop)
      .catch(() => setTop([]));
    apiGet<Alert[]>("/governance/analytics/alerts")
      .then(setAlerts)
      .catch(() => setAlerts([]));
  }, [isAdmin]);

  // Re-poll both sources every 30s.
  useEffect(() => {
    const id = setInterval(() => {
      void apiGet<PerfResponse>("/perf").then(setPerf).catch(() => setPerf(null));
    }, 30_000);
    return () => clearInterval(id);
  }, []);

  const latencySeries: LineDatum[] = (perf?.latency_series ?? []).map((p) => ({
    label: shortBucket(p.bucket),
    value: p.avg_ms,
  }));
  const latencySpark = latencySeries.map((p) => p.value);

  const totalRuns = perf?.total_runs ?? 0;
  const errorRuns = perf?.error_runs ?? 0;
  const errorPct = totalRuns > 0 ? (errorRuns / totalRuns) * 100 : 0;
  const chatOrigin = perf?.origins?.find((o) => o.origin === "chat");
  const panelOrigin = perf?.origins?.find((o) => o.origin === "panel");

  const spendData: BarDatum[] = (spend ?? []).map((s) => ({
    label: s.model_name ?? s.model_id?.slice(0, 8) ?? "unknown",
    value: s.tokens,
    display: s.tokens.toLocaleString(),
  }));

  const lineData: LineDatum[] = (timeline ?? []).map((b) => ({
    label: shortBucket(b.bucket),
    value: b.count,
  }));

  return (
    <div className="content-page space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="page-title">
            Analytics
          </h2>
          <p className="text-textMuted text-[13px] mt-1">
            Latency, usage, cost, and adoption — last 30 days. Refreshed every 30s.
          </p>
        </div>
        {isAdmin && alerts !== null && alerts.length > 0 && (
          <StatusPill
            state="degraded"
            label={`${alerts.length} budget overrun${alerts.length === 1 ? "" : "s"}`}
          />
        )}
      </div>

      {perf === null ? (
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          {Array.from({ length: 6 }, (_, i) => (
            <Skeleton key={i} variant="row" />
          ))}
        </div>
      ) : (
        <div data-stagger className="space-y-6">
          {/* 1 · Speed & reliability */}
          <section>
            <SectionLabel>Speed &amp; reliability</SectionLabel>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
              <StatTile
                label="avg latency"
                countUp={perf.avg_latency_ms}
                format={(n) => `${n.toFixed(0)} ms`}
                tone="brass"
                icon={<ClockIcon size={16} />}
                spark={latencySpark}
                hint={`p95 ${perf.p95_latency_ms.toFixed(0)} ms · last 24h`}
              />
              <StatTile
                label="error rate"
                countUp={errorPct}
                format={(n) => `${n.toFixed(1)}%`}
                tone={errorPct > 5 ? "rust" : "teal"}
                icon={<ActivityIcon size={16} />}
                hint={`${errorRuns.toLocaleString()} failed of ${totalRuns.toLocaleString()} runs`}
              />
              <StatTile
                label="cache hit rate"
                countUp={perf.cache.hit_rate * 100}
                format={(n) => `${n.toFixed(1)}%`}
                tone="teal"
                icon={<CheckIcon size={16} />}
                hint={`${perf.cache.total_hits} hits / ${perf.cache.total_rows} rows`}
              />
            </div>
          </section>

          {/* 2 · Usage & cost */}
          <section>
            <SectionLabel>Usage &amp; cost</SectionLabel>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatTile
                label="total tokens"
                countUp={perf.total_tokens}
                tone="brass"
                icon={<ZapIcon size={16} />}
                hint={`${totalRuns.toLocaleString()} runs · last 30d`}
              />
              <StatTile
                label="tokens / run"
                countUp={perf.tokens_per_turn}
                format={(n) => n.toFixed(0)}
                tone="teal"
                icon={<ActivityIcon size={16} />}
                hint="avg prompt + completion per run"
              />
              <StatTile
                label="total cost"
                countUp={perf.total_cost_cents}
                format={(n) => `${n.toFixed(2)} ¢`}
                tone="brass"
                icon={<DollarSignIcon size={16} />}
                hint="input + output · last 30d"
              />
              <StatTile
                label="top model"
                value={perf.top_models[0]?.model ?? "—"}
                tone="brass"
                icon={<GaugeIcon size={16} />}
                hint={perf.top_models[0] ? `${perf.top_models[0].runs.toLocaleString()} runs` : ""}
              />
            </div>
          </section>

          {/* 3 · Trend + models */}
          <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <ChartCard
              title="Latency · last 24h"
              subtitle="hourly average in ms (ok runs)"
              isEmpty={latencySeries.length === 0}
            >
              <LineChart data={latencySeries} tone="brass" height={220} xAxis yAxis />
            </ChartCard>

            <ChartCard
              title="Top models by usage"
              subtitle="runs · last 30d"
              isEmpty={perf.top_models.length === 0}
            >
              <ul className="divide-y divide-borderSoft">
                {perf.top_models.map((m, i) => (
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

          {/* 4 · Adoption (admin) — messages over time + top users */}
          {isAdmin && (
            <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <ChartCard
                title="Messages · last 24h"
                subtitle="hourly bucket count"
                loading={timeline === null}
                isEmpty={!!timeline && timeline.length === 0}
                emptyVariant="inbox"
              >
                <LineChart data={lineData} tone="teal" height={220} xAxis yAxis />
              </ChartCard>

              <ChartCard
                title="Top users"
                subtitle="all-time message count"
                loading={top === null}
                isEmpty={!!top && top.length === 0}
                emptyVariant="inbox"
              >
                <TopUserTable users={top ?? []} />
              </ChartCard>
            </section>
          )}

          {/* 5 · Attribution */}
          <section className="border border-border bg-panel">
            <header className="px-4 py-2 border-b border-borderSoft flex items-center gap-2">
              <ActivityIcon size={14} className="text-brass" />
              <span className="mono-caps text-[11px] text-textMuted tracking-wider">
                Usage attribution · last 30d
              </span>
              <span className="ml-auto flex items-center gap-2">
                <OriginChip
                  label="direct chat"
                  runs={chatOrigin?.runs ?? 0}
                  tone="teal"
                />
                <OriginChip
                  label="panels"
                  runs={panelOrigin?.runs ?? 0}
                  tone="brass"
                />
              </span>
            </header>
            <div className="p-4">
              {perf.per_panel.length === 0 ? (
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
                      <th className="pb-2 pr-3 text-right">tokens</th>
                      <th className="pb-2 text-right">share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {perf.per_panel.map((p) => {
                      const panelTokens = panelOrigin?.tokens ?? 0;
                      const share = panelTokens > 0 ? (p.tokens / panelTokens) * 100 : 0;
                      return (
                        <tr key={p.panel_id} className="border-t border-borderSoft">
                          <td className="py-2 pr-3 font-mono text-[13px] text-text truncate max-w-[420px]">
                            {p.panel_id === "unknown" ? (
                              <span
                                className="text-textMuted"
                                title="Runs recorded before panel attribution existed"
                              >
                                {p.panel_name}
                              </span>
                            ) : (
                              p.panel_name
                            )}
                          </td>
                          <td className="py-2 pr-3 font-mono text-[12px] tabular-nums text-right">
                            {p.runs.toLocaleString()}
                          </td>
                          <td className="py-2 pr-3 font-mono text-[12px] tabular-nums text-right">
                            {p.tokens.toLocaleString()}
                          </td>
                          <td className="py-2 font-mono text-[12px] tabular-nums text-right text-textMuted">
                            {p.panel_id === "unknown" ? "—" : `${share.toFixed(0)}%`}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          {/* 6 · Budget (admin) — spend by model + overrun callout */}
          {isAdmin && (spend?.length || alerts?.length) ? (
            <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
              <ChartCard
                title="Spend by model"
                subtitle="tokens consumed across the window"
                loading={spend === null}
                isEmpty={!!spend && spend.length === 0}
                emptyVariant="ledger"
              >
                <BarChart data={spendData} tone="brass" height={Math.max(180, spendData.length * 32)} />
              </ChartCard>

              {alerts && alerts.length > 0 && (
                <section className="border border-rust/40 bg-rust/10">
                  <header className="px-4 py-2 border-b border-rust/40 flex items-center gap-2">
                    <AlertTriangleIcon size={14} className="text-rust" />
                    <span className="mono-caps text-[11px] text-rust tracking-wider">
                      Budget overrun
                    </span>
                    <span className="mono-caps text-[10px] text-textMuted">
                      · {alerts.length}
                    </span>
                  </header>
                  <ul>
                    {alerts.map((a) => (
                      <li
                        key={a.user_id}
                        className="px-4 py-2.5 flex items-center gap-3 border-b border-rust/20 last:border-b-0"
                      >
                        <Avatar name={a.user_name} size={24} />
                        <span className="text-[13px] text-text flex-1 truncate font-medium">
                          {a.user_name}
                        </span>
                        <span className="mono-caps text-[10px] text-rust tabular-nums">
                          ${a.dollars.toFixed(2)} / ${a.limit.toFixed(2)}
                        </span>
                        <span className="mono-caps text-[10px] text-rust tabular-nums w-12 text-right">
                          {(a.ratio * 100).toFixed(0)}%
                        </span>
                      </li>
                    ))}
                  </ul>
                </section>
              )}
            </section>
          ) : null}
        </div>
      )}
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="mono-caps text-[10px] text-textFaint tracking-wider mb-2">
      {children}
    </div>
  );
}

function OriginChip({
  label,
  runs,
  tone,
}: {
  label: string;
  runs: number;
  tone: "brass" | "teal";
}) {
  return (
    <span className="inline-flex items-center gap-1.5 border border-borderSoft px-2 py-0.5">
      <span
        className={cn(
          "inline-block w-1.5 h-1.5 rounded-full",
          tone === "brass" ? "bg-brass" : "bg-teal",
        )}
      />
      <span className="mono-caps text-[10px] text-textMuted">{label}</span>
      <span className="font-mono text-[11px] tabular-nums text-text">
        {runs.toLocaleString()}
      </span>
    </span>
  );
}

function ChartCard({
  title,
  subtitle,
  loading,
  isEmpty,
  emptyVariant,
  children,
}: {
  title: string;
  subtitle?: string;
  loading?: boolean;
  isEmpty?: boolean;
  emptyVariant?: "inbox" | "ledger" | "search";
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
        {loading ? (
          <div className="space-y-2.5">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} variant="row" />
            ))}
          </div>
        ) : isEmpty ? (
          <EmptyState
            variant={emptyVariant}
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

function TopUserTable({ users }: { users: TopUser[] }) {
  const max = Math.max(1, ...users.map((u) => u.count));
  return (
    <ol className="divide-y divide-borderSoft">
      {users.map((u, i) => {
        const pct = (u.count / max) * 100;
        const rank = i + 1;
        return (
          <li
            key={u.user_id}
            className={cn(
              "flex items-center gap-3 py-2",
            )}
          >
            <span
              className={cn(
                "font-mono text-[12px] w-6 text-right tabular-nums",
                rank === 1 ? "text-brass" : "text-textMuted",
              )}
            >
              {rank}.
            </span>
            <CallSign id={`USR-${u.user_id.slice(0, 4).toUpperCase()}`} />
            <Avatar name={u.user_name} size={24} />
            <span className="font-mono text-[13px] text-text flex-1 truncate">
              {u.user_name}
            </span>
            <div className="hidden md:block flex-1 max-w-[180px] h-[10px] bg-bg border border-borderSoft relative">
              <div
                className="absolute inset-y-0 left-0 bg-brass/70"
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="font-mono text-[12px] text-text w-20 text-right tabular-nums">
              {u.count.toLocaleString()}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

// Postgres date_trunc returns e.g. "2026-09-28 22:00:00+01" (space
// separator) or ISO "2026-09-28T22:00:00". Show a compact local hour
// label; keep the full timestamp for the hover tooltip only.
function shortBucket(s: string): string {
  const m = s.match(/(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):/);
  if (!m) return s;
  return `${m[4]}:00`;
}
