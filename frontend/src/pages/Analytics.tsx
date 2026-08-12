// Analytics (admin, docs §2.6). v2 upgrade:
//   - Real BarChart for "Spend by model" (replaces inline divs).
//   - Real LineChart for "Messages over time" (replaces vertical bars
//     without axis labels).
//   - Top users as a ranked table with sparkline-equivalent indicators
//     (just the rank bar — keeps the page readable).
//   - Alerts section uses StatusPill and a rust-bordered callout.
//   - Empty states use EmptyState with illustrations.

import { useEffect, useState } from "react";
import { apiGet } from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { Avatar } from "../components/ui/Avatar";
import { CallSign } from "../components/ui/CallSign";
import { NoAccess } from "../components/ui/NoAccess";
import { EmptyState } from "../components/ui/feedback/EmptyState";
import { Skeleton, SkeletonTable } from "../components/ui/feedback/Skeleton";
import { BarChart, LineChart, type BarDatum, type LineDatum, StatTile } from "../components/ui/data/charts";
import { StatusPill } from "../components/ui/feedback/StatusPill";
import {
  DollarSignIcon,
  ActivityIcon,
  UserIcon,
  AlertTriangleIcon,
} from "../components/ui/Icon";
import { cn } from "../lib/cn";

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
  if (user?.role !== "admin") return <NoAccess title="Analytics" />;
  const [spend, setSpend] = useState<SpendByModel[] | null>(null);
  const [timeline, setTimeline] = useState<MessageBucket[] | null>(null);
  const [top, setTop] = useState<TopUser[] | null>(null);
  const [alerts, setAlerts] = useState<Alert[] | null>(null);

  useEffect(() => {
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
  }, []);

  const spendData: BarDatum[] = (spend ?? []).map((s) => ({
    label: s.model_name ?? s.model_id?.slice(0, 8) ?? "unknown",
    value: s.tokens,
    display: s.tokens.toLocaleString(),
  }));

  const totalSpend = spendData.reduce((acc, s) => acc + s.value, 0);
  const spendSpark = [...spendData]
    .sort((a, b) => b.value - a.value)
    .slice(0, 8)
    .map((s) => s.value);

  const lineData: LineDatum[] = (timeline ?? []).map((b) => ({
    label: shortBucket(b.bucket),
    value: b.count,
  }));
  const totalMessages = lineData.reduce((acc, b) => acc + b.value, 0);

  return (
    <div className="p-6 max-w-[1100px] space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-display text-[24px] font-semibold text-text tracking-wide leading-tight">
            Analytics
          </h2>
          <p className="text-textMuted text-[13px] mt-1">
            Spend, volume, and budget alerts — last 30 days.
          </p>
        </div>
        <StatusPill
          state={
            alerts && alerts.length > 0
              ? "degraded"
              : alerts === null
              ? "unknown"
              : "healthy"
          }
          label={
            alerts && alerts.length > 0
              ? `${alerts.length} budget overrun${alerts.length === 1 ? "" : "s"}`
              : "all budgets healthy"
          }
        />
      </div>

      {/* Stat tiles */}
      <section className="grid grid-cols-1 md:grid-cols-3 gap-3">
        <StatTile
          label="total spend"
          value={spend === null ? "…" : `${totalSpend.toLocaleString()} tok`}
          tone="brass"
          icon={<DollarSignIcon size={16} />}
          spark={spendSpark}
          hint="across all models"
        />
        <StatTile
          label="messages"
          value={timeline === null ? "…" : totalMessages.toLocaleString()}
          tone="teal"
          icon={<ActivityIcon size={16} />}
          hint="last 24h"
        />
        <StatTile
          label="active users"
          value={top === null ? "…" : top.length.toString()}
          tone="brass"
          icon={<UserIcon size={16} />}
          hint="all-time"
        />
      </section>

      {/* Budget alerts */}
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

      {/* Charts */}
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

        <ChartCard
          title="Messages · last 24h"
          subtitle="hourly bucket count"
          loading={timeline === null}
          isEmpty={!!timeline && timeline.length === 0}
          emptyVariant="inbox"
        >
          <LineChart data={lineData} tone="teal" height={220} xAxis yAxis />
        </ChartCard>
      </section>

      {/* Top users */}
      <section className="border border-border bg-panel">
        <header className="px-4 py-2 border-b border-borderSoft flex items-center gap-2">
          <UserIcon size={14} className="text-brass" />
          <span className="mono-caps text-[11px] text-textMuted tracking-wider">
            Top users
          </span>
          <span className="mono-caps text-[10px] text-textFaint">
            · all-time message count
          </span>
        </header>
        <div className="p-4">
          {top === null ? (
            <SkeletonTable rows={5} columns={3} />
          ) : top.length === 0 ? (
            <EmptyState
              variant="inbox"
              title="No users yet"
              description="Once team members send messages, the leaderboard will populate."
              tone="neutral"
            />
          ) : (
            <TopUserTable users={top} />
          )}
        </div>
      </section>
    </div>
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

function shortBucket(s: string): string {
  // Backend returns an ISO timestamp; the chart only needs the HH:MM
  // portion. If the string doesn't look like ISO, return as-is.
  const m = s.match(/T(\d{2}:\d{2})/);
  return m ? m[1]! : s;
}
