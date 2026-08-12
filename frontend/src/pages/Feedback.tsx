// Feedback analytics dashboard — Tier 6 self-improvement.
//
// Admin-only surface that surfaces:
//   - aggregate totals (up %, down %, sample size)
//   - per-model thumbs ratio (BarChart of approval rate by model)
//   - 14-day feedback trend (LineChart)
//   - admin "recompute profiles" button so the learning loop can be
//     triggered on demand after a deploy
//
// Mirrors Analytics.tsx in feel so an admin bouncing between pages
// gets the same chart primitives, status pill, and call-out treatment.

import { useEffect, useState } from "react";
import { useAuth } from "../auth/AuthContext";
import { apiGet, apiPost } from "../api/client";
import { NoAccess } from "../components/ui/NoAccess";
import { EmptyState } from "../components/ui/feedback/EmptyState";
import { Skeleton } from "../components/ui/feedback/Skeleton";
import {
  BarChart,
  LineChart,
  StatTile,
  type BarDatum,
  type LineDatum,
} from "../components/ui/data/charts";
import { StatusPill } from "../components/ui/feedback/StatusPill";
import { Button } from "../components/ui/Button";
import { useToast } from "../components/ui/feedback/Toast";
import {
  ThumbsUpIcon,
  ThumbsDownIcon,
  ActivityIcon,
  RefreshIcon,
  AlertTriangleIcon,
} from "../components/ui/Icon";
import { cn } from "../lib/cn";

interface FeedbackStats {
  total: number;
  up_pct: number;
  down_pct: number;
  ups: number;
  downs: number;
  per_model: Array<{
    model_id: string;
    model_name: string | null;
    ups: number;
    downs: number;
    total: number;
    up_pct: number;
  }>;
  trend: Array<{ bucket: string; ups: number; downs: number }>;
}

export function FeedbackPage() {
  const { user } = useAuth();
  const { addToast } = useToast();
  const [stats, setStats] = useState<FeedbackStats | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recomputing, setRecomputing] = useState(false);

  async function load() {
    setError(null);
    try {
      const s = await apiGet<FeedbackStats>("/feedback/stats");
      setStats(s);
    } catch (err) {
      setError((err as Error).message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function recompute() {
    setRecomputing(true);
    try {
      await apiPost("/feedback/recompute-profile", {});
      addToast({
        id: `recomp-${Date.now()}`,
        title: "Profiles recomputed",
        description: "All preference profiles rebuilt from feedback.",
        tone: "success",
        duration: 2500,
      });
    } catch (err) {
      addToast({
        id: `recomp-err-${Date.now()}`,
        title: "Recompute failed",
        description: (err as Error).message,
        tone: "warning",
        duration: 4000,
      });
    } finally {
      setRecomputing(false);
    }
  }

  if (user?.role !== "admin") return <NoAccess title="Feedback" />;

  const trendData: LineDatum[] = (stats?.trend ?? []).map((t) => ({
    label: shortBucket(t.bucket),
    value: t.ups - t.downs,
  }));
  // Sort per-model rows by total votes desc — that's the most useful
  // ordering for an admin scanning "which models get the most signal".
  const perModelRows = (stats?.per_model ?? [])
    .slice()
    .sort((a, b) => b.total - a.total);
  const modelBars: BarDatum[] = perModelRows.slice(0, 12).map((m) => ({
    label: m.model_name ?? m.model_id.slice(0, 8),
    value: Math.round(m.up_pct),
    display: `${Math.round(m.up_pct)}%`,
    secondary: `${m.ups}/${m.total}`,
  }));

  const totalSpark = trendData.slice(-10).map((d) => d.value);

  return (
    <div className="p-6 max-w-[1100px] space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-display text-[24px] font-semibold text-text tracking-wide leading-tight">
            Feedback
          </h2>
          <p className="text-textMuted text-[13px] mt-1">
            Thumbs votes drive the preference learner — last 30 days.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <StatusPill
            state={
              stats === null
                ? "unknown"
                : stats.total === 0
                  ? "idle"
                  : stats.up_pct >= 70
                    ? "healthy"
                    : stats.up_pct >= 40
                      ? "warming"
                      : "degraded"
            }
            label={
              stats === null
                ? "loading…"
                : stats.total === 0
                  ? "no votes yet"
                  : `${Math.round(stats.up_pct)}% positive`
            }
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={recompute}
            disabled={recomputing}
          >
            <RefreshIcon size={11} />
            {recomputing ? "recomputing…" : "recompute profiles"}
          </Button>
        </div>
      </div>

      {error && (
        <div className="mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-3 py-2">
          {error}
        </div>
      )}

      {/* Stat tiles */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatTile
          label="total votes"
          value={stats === null ? "…" : stats.total.toLocaleString()}
          tone="brass"
          icon={<ActivityIcon size={16} />}
          hint="last 30 days"
          spark={totalSpark.length > 0 ? totalSpark : undefined}
        />
        <StatTile
          label="thumbs up"
          value={stats === null ? "…" : `${Math.round(stats.up_pct)}%`}
          tone="teal"
          icon={<ThumbsUpIcon size={16} />}
          hint={stats ? `${stats.ups} ups` : "—"}
        />
        <StatTile
          label="thumbs down"
          value={stats === null ? "…" : `${Math.round(stats.down_pct)}%`}
          tone="rust"
          icon={<ThumbsDownIcon size={16} />}
          hint={stats ? `${stats.downs} downs` : "—"}
        />
      </section>

      {/* Charts */}
      <section className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <ChartCard
          title="Approval rate by model"
          subtitle="up % · top 12 by votes"
          loading={stats === null}
          isEmpty={!!stats && perModelRows.length === 0}
        >
          <BarChart
            data={modelBars}
            tone="teal"
            height={Math.max(180, modelBars.length * 28)}
          />
        </ChartCard>

        <ChartCard
          title="14-day net sentiment"
          subtitle="(ups − downs) per day"
          loading={stats === null}
          isEmpty={!!stats && trendData.length === 0}
        >
          <LineChart data={trendData} tone="brass" height={220} xAxis yAxis />
        </ChartCard>
      </section>

      {/* Per-model table */}
      <section className="border border-border bg-panel">
        <header className="px-4 py-2 border-b border-borderSoft flex items-center gap-2">
          <ThumbsUpIcon size={14} className="text-brass" />
          <span className="mono-caps text-[11px] text-textMuted tracking-wider">
            Per-model breakdown
          </span>
          <span className="mono-caps text-[10px] text-textFaint">
            · {perModelRows.length} model{perModelRows.length === 1 ? "" : "s"}
          </span>
        </header>
        <div className="p-4">
          {stats === null ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }, (_, i) => (
                <Skeleton key={i} variant="row" />
              ))}
            </div>
          ) : perModelRows.length === 0 ? (
            <EmptyState
              variant="ledger"
              title="No votes yet"
              description="Once team members rate assistant replies, the table will populate."
              tone="neutral"
            />
          ) : (
            <ModelTable rows={perModelRows} />
          )}
        </div>
      </section>

      {stats && stats.total > 0 && stats.up_pct < 50 && (
        <section className="border border-rust/40 bg-rust/10 px-4 py-3 flex items-center gap-3">
          <AlertTriangleIcon size={16} className="text-rust shrink-0" />
          <div className="flex-1 text-[13px] text-text">
            Approval rate is below 50%. Consider recomputing preference
            profiles to surface better-fit models to each user.
          </div>
        </section>
      )}
    </div>
  );
}

function ChartCard({
  title,
  subtitle,
  loading,
  isEmpty,
  children,
}: {
  title: string;
  subtitle?: string;
  loading?: boolean;
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
        {loading ? (
          <div className="space-y-2.5">
            {Array.from({ length: 5 }, (_, i) => (
              <Skeleton key={i} variant="row" />
            ))}
          </div>
        ) : isEmpty ? (
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

function ModelTable({
  rows,
}: {
  rows: Array<{
    model_id: string;
    model_name: string | null;
    ups: number;
    downs: number;
    total: number;
    up_pct: number;
  }>;
}) {
  // Sort by approval ratio descending — gives the "best liked" rank
  // for admins scanning the list.
  const sorted = rows.slice().sort((a, b) => b.up_pct - a.up_pct);
  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="border-b border-border text-left">
            <Th>model</Th>
            <Th align="right">ups</Th>
            <Th align="right">downs</Th>
            <Th align="right">total</Th>
            <Th align="right">approval</Th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <tr
              key={r.model_id}
              className="border-b border-borderSoft hover:bg-panelAlt/40"
            >
              <Td>
                <span className="font-mono text-text">
                  {r.model_name ?? r.model_id.slice(0, 8)}
                </span>
              </Td>
              <Td align="right">
                <span className="font-mono text-teal tabular-nums">{r.ups}</span>
              </Td>
              <Td align="right">
                <span className="font-mono text-rust tabular-nums">{r.downs}</span>
              </Td>
              <Td align="right">
                <span className="font-mono text-textMuted tabular-nums">
                  {r.total}
                </span>
              </Td>
              <Td align="right">
                <div className="flex items-center gap-2 justify-end">
                  <div className="hidden md:block w-[120px] h-[8px] bg-bg border border-borderSoft relative">
                    <div
                      className={cn(
                        "absolute inset-y-0 left-0",
                        r.up_pct >= 70
                          ? "bg-teal/70"
                          : r.up_pct >= 40
                            ? "bg-brass/70"
                            : "bg-rust/70",
                      )}
                      style={{ width: `${Math.max(2, r.up_pct)}%` }}
                    />
                  </div>
                  <span
                    className={cn(
                      "font-mono tabular-nums w-12 text-right",
                      r.up_pct >= 70
                        ? "text-teal"
                        : r.up_pct >= 40
                          ? "text-brass"
                          : "text-rust",
                    )}
                  >
                    {Math.round(r.up_pct)}%
                  </span>
                </div>
              </Td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Th({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <th
      className={`mono-caps text-[10px] text-textMuted font-normal py-2 px-2 ${align === "right" ? "text-right" : "text-left"}`}
    >
      {children}
    </th>
  );
}

function Td({ children, align = "left" }: { children: React.ReactNode; align?: "left" | "right" }) {
  return (
    <td className={`py-2 px-2 align-top ${align === "right" ? "text-right" : "text-left"}`}>
      {children}
    </td>
  );
}

function shortBucket(s: string): string {
  const m = s.match(/(\d{2})$/);
  return m ? `${m[1]}d` : s;
}
