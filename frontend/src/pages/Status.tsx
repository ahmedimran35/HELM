// Status — admin-only system health page (Tier 7).
//
// Polls /api/status and renders green/yellow/red pills per subsystem.
// Shows uptime, active counts, and a restart button. Designed to
// always render — when the API itself is unreachable the page falls
// back to a degraded banner + retry.

import { useEffect, useState, useCallback } from "react";
import { apiGet, apiPost } from "../api/client";
import { Button } from "../components/ui/Button";
import { StatusPill } from "../components/ui/feedback/StatusPill";
import {
  GaugeIcon,
  DatabaseIcon,
  RefreshIcon,
  PlayIcon,
  AlertTriangleIcon,
  CheckIcon,
  InfoIcon,
  ActivityIcon,
  ZapIcon,
} from "../components/ui/Icon";
import { useToast } from "../components/ui/feedback/Toast";
import { cn } from "../lib/cn";

interface ServiceStatus {
  state: "healthy" | "degraded" | "down";
  detail?: string;
  latency_ms?: number;
  count?: number;
  model_count?: number;
}
interface HarnessStatus extends ServiceStatus {
  kind: string;
  model_count: number;
}
interface JobStatus extends ServiceStatus {
  name: string;
  last_run_at?: string;
}
interface StatusReport {
  generated_at: string;
  uptime_seconds: number;
  process_started_at: string;
  db: ServiceStatus;
  redis: ServiceStatus;
  providers: ServiceStatus & { count: number; model_count: number };
  harnesses: HarnessStatus[];
  jobs: JobStatus[];
  counts: {
    users: number;
    panels: number;
    workflows: number;
    sessions: number;
  };
  restart_supported: boolean;
}

type FetchState =
  | { kind: "loading" }
  | { kind: "ok"; report: StatusReport }
  | { kind: "unreachable"; error: string };

export function StatusPage() {
  const [state, setState] = useState<FetchState>({ kind: "loading" });
  const [restarting, setRestarting] = useState(false);
  const { addToast } = useToast();

  const fetchStatus = useCallback(async () => {
    try {
      const r = await apiGet<StatusReport>("/status");
      setState({ kind: "ok", report: r });
    } catch (err) {
      setState({ kind: "unreachable", error: (err as Error).message });
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
    const handle = setInterval(() => void fetchStatus(), 15_000);
    return () => clearInterval(handle);
  }, [fetchStatus]);

  async function restart() {
    setRestarting(true);
    try {
      await apiPost("/status/restart", {});
      addToast({
        id: "status-restart",
        title: "Schedulers restarted",
        description: "Watch + memory schedulers were reloaded.",
        tone: "info",
      });
      await fetchStatus();
    } catch (err) {
      addToast({
        id: "status-restart-fail",
        title: "Restart failed",
        description: (err as Error).message,
        tone: "warning",
      });
    } finally {
      setRestarting(false);
    }
  }

  if (state.kind === "loading") {
    return (
      <div className="p-6 max-w-[1100px]">
        <PageHeader />
        <div className="mt-6 mono-caps text-[11px] text-textFaint">
          contacting api…
        </div>
      </div>
    );
  }
  if (state.kind === "unreachable") {
    return (
      <div className="p-6 max-w-[1100px]">
        <PageHeader />
        <div className="mt-6 border border-rust/40 bg-rust/10 p-4">
          <div className="flex items-center gap-2 text-rust">
            <AlertTriangleIcon size={14} />
            <span className="mono-caps text-[11px] tracking-wider">
              status unreachable
            </span>
          </div>
          <p className="mt-1.5 text-[12px] text-textMuted">{state.error}</p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-3"
            onClick={() => void fetchStatus()}
          >
            <RefreshIcon size={12} /> Retry
          </Button>
        </div>
      </div>
    );
  }
  const r = state.report;
  const overall = overallState(r);
  return (
    <div className="p-6 max-w-[1100px] space-y-6">
      <PageHeader overall={overall} uptime={r.uptime_seconds} />
      <Counts counts={r.counts} />

      {/* Restart bar */}
      <div className="border border-border bg-panel p-4 flex items-center gap-3 flex-wrap">
        <div className="flex items-center gap-2 text-textMuted">
          <RefreshIcon size={14} />
          <span className="mono-caps text-[11px] tracking-wider">
            schedulers
          </span>
        </div>
        <span className="text-[12px] text-text flex-1 min-w-[200px]">
          Reload the background watch + memory schedulers without a
          full process restart. Useful after seed or migration changes.
        </span>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void restart()}
          disabled={restarting}
        >
          <PlayIcon size={12} />
          {restarting ? "Restarting…" : "Restart schedulers"}
        </Button>
      </div>

      {/* Services */}
      <Section title="services" icon={<DatabaseIcon size={14} />}>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
          <ServiceCard title="postgres" status={r.db} />
          <ServiceCard title="redis" status={r.redis} />
          <ProviderCard providers={r.providers} />
        </div>
      </Section>

      {/* Harnesses */}
      <Section title="harnesses" icon={<ZapIcon size={14} />}>
        {r.harnesses.length === 0 ? (
          <EmptyRow text="No harnesses registered yet." />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {r.harnesses.map((h) => (
              <HarnessCard key={h.kind} h={h} />
            ))}
          </div>
        )}
      </Section>

      {/* Jobs */}
      <Section title="background jobs" icon={<ActivityIcon size={14} />}>
        <ul className="divide-y divide-borderSoft border border-border">
          {r.jobs.map((j) => (
            <JobRow key={j.name} job={j} />
          ))}
        </ul>
      </Section>

      {/* Generated at */}
      <p className="mono-caps text-[10px] text-textFaint tracking-wider text-right">
        generated {new Date(r.generated_at).toLocaleString()} · auto-refresh every 15s
      </p>
    </div>
  );
}

// ─── Sub-components ─────────────────────────────────────────────────────

function PageHeader({
  overall,
  uptime,
}: {
  overall?: "healthy" | "degraded" | "down";
  uptime?: number;
}) {
  return (
    <div className="flex items-end justify-between gap-4 flex-wrap">
      <div>
        <h2 className="font-display text-[26px] font-semibold text-text leading-tight flex items-center gap-2">
          <GaugeIcon size={20} className="text-brass" />
          System status
        </h2>
        <p className="mt-1 text-[13px] text-textMuted">
          Live snapshot of databases, schedulers, and harnesses.{" "}
          {uptime !== undefined && (
            <>Up for {formatUptime(uptime)}.</>
          )}
        </p>
      </div>
      <StatusPill
        state={
          overall === "healthy"
            ? "healthy"
            : overall === "degraded"
            ? "warming"
            : overall === "down"
            ? "degraded"
            : "unknown"
        }
        label={overall ?? "connecting…"}
        size="md"
      />
    </div>
  );
}

function Section({
  title,
  icon,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="flex items-center gap-2 mb-2">
        <span className="text-brass">{icon}</span>
        <span className="mono-caps text-[11px] text-textMuted tracking-wider">
          {title}
        </span>
      </div>
      {children}
    </section>
  );
}

function ServiceCard({
  title,
  status,
}: {
  title: string;
  status: ServiceStatus;
}) {
  return (
    <div className="border border-border bg-panel p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="mono-caps text-[11px] text-textMuted tracking-wider">
          {title}
        </span>
        <StatusPill state={pillState(status.state)} label={status.state} />
      </div>
      <p className="text-[12px] text-text break-words">{status.detail ?? "—"}</p>
      {status.latency_ms !== undefined && (
        <p className="mono-caps text-[10px] text-textFaint tracking-wider">
          latency {status.latency_ms}ms
        </p>
      )}
    </div>
  );
}

function ProviderCard({
  providers,
}: {
  providers: ServiceStatus & { count: number; model_count: number };
}) {
  return (
    <div className="border border-border bg-panel p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="mono-caps text-[11px] text-textMuted tracking-wider">
          providers
        </span>
        <StatusPill state={pillState(providers.state)} label={providers.state} />
      </div>
      <p className="text-[12px] text-text">
        {providers.count} configured · {providers.model_count} models
      </p>
      {providers.detail && (
        <p className="text-[11px] text-textMuted">{providers.detail}</p>
      )}
    </div>
  );
}

function HarnessCard({ h }: { h: HarnessStatus }) {
  return (
    <div className="border border-border bg-panel p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="mono-caps text-[11px] text-textMuted tracking-wider">
          {h.kind}
        </span>
        <StatusPill state={pillState(h.state)} label={h.state} />
      </div>
      <p className="text-[12px] text-text">{h.model_count} models</p>
      {h.detail && <p className="text-[11px] text-textMuted">{h.detail}</p>}
    </div>
  );
}

function JobRow({ job }: { job: JobStatus }) {
  return (
    <li className="px-4 py-2.5 flex items-center gap-3">
      <StatusPill state={pillState(job.state)} label={job.state} />
      <span className="font-mono text-[12px] text-text flex-1 min-w-0 truncate">
        {job.name}
      </span>
      <span className="text-[11px] text-textMuted truncate">
        {job.detail ?? ""}
      </span>
      {job.last_run_at && (
        <span className="mono-caps text-[10px] text-textFaint tracking-wider shrink-0">
          last: {shortTime(job.last_run_at)}
        </span>
      )}
    </li>
  );
}

function Counts({ counts }: { counts: StatusReport["counts"] }) {
  const items = [
    { label: "active users", value: counts.users },
    { label: "panels", value: counts.panels },
    { label: "workflows", value: counts.workflows },
    { label: "active sessions", value: counts.sessions },
  ];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 border border-border bg-panel divide-x divide-border">
      {items.map((i) => (
        <div key={i.label} className="px-4 py-3">
          <div className="mono-caps text-[10px] text-textMuted tracking-wider">
            {i.label}
          </div>
          <div className="font-mono text-[20px] text-text tabular-nums mt-1">
            {i.value}
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyRow({ text }: { text: string }) {
  return (
    <div className="border border-dashed border-border bg-panelAlt px-4 py-3 mono-caps text-[11px] text-textFaint tracking-wider">
      {text}
    </div>
  );
}

// ─── helpers ────────────────────────────────────────────────────────────

function pillState(s: "healthy" | "degraded" | "down"): "healthy" | "warming" | "degraded" | "idle" {
  if (s === "healthy") return "healthy";
  if (s === "degraded") return "warming";
  return "degraded";
}

function overallState(r: StatusReport): "healthy" | "degraded" | "down" {
  const all: ServiceStatus[] = [
    r.db,
    r.redis,
    r.providers,
    ...r.harnesses,
    ...r.jobs,
  ];
  if (all.some((s) => s.state === "down")) return "down";
  if (all.some((s) => s.state === "degraded")) return "degraded";
  return "healthy";
}

function formatUptime(s: number): string {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d ${Math.floor((s % 86400) / 3600)}h`;
}

function shortTime(iso: string): string {
  try {
    const d = new Date(iso);
    const diff = Math.floor((Date.now() - d.getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return d.toLocaleDateString();
  } catch {
    return iso;
  }
}