// Home — post-login dashboard (logged in) OR public landing page (logged
// out). The dashboard polls live endpoints every 30s: /perf for latency,
// tokens, runs and cost; governance analytics for the hourly message
// series and per-model spend; /api/swarm/runs for recent swarm runs.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { apiGet } from "../api/client";
import { Avatar } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/feedback/EmptyState";
import { Skeleton, SkeletonText } from "../components/ui/feedback/Skeleton";
import { BarChart, LineChart, StatTile } from "../components/ui/data/charts";
import type { BarDatum, LineDatum } from "../components/ui/data/charts";
import { StatusPill } from "../components/ui/feedback/StatusPill";
import { CallSign } from "../components/ui/CallSign";
import {
  ChatIcon,
  PanelsIcon,
  ProvidersIcon,
  UserIcon,
  ArrowRightIcon,
  ActivityIcon,
  DatabaseIcon,
  ZapIcon,
  DollarSignIcon,
  ClockIcon,
  InboxIcon,
  SkillsIcon,
  PlayIcon,
  TerminalIcon,
  AppWindowIcon,
  LayoutIcon,
  GaugeIcon,
  LayersIcon,
  RefreshIcon,
  GraphIcon,
} from "../components/ui/Icon";
import { useCommandPalette } from "../components/system/CommandPalette";
import { useToast } from "../components/ui/feedback/Toast";

interface PanelSummary {
  id: string;
  name: string;
  member_count: number;
  message_count: number;
}

interface SandboxState {
  status: string;
  cpu_pct: string;
  mem_pct: string;
}

// /perf — admin sees workspace-wide, non-admin sees own usage.
interface Perf {
  avg_latency_ms: number;
  p95_latency_ms: number;
  total_tokens: number;
  total_runs: number;
  error_runs: number;
  total_cost_cents: number;
  tokens_per_turn: number;
  latency_series: Array<{ bucket: string; avg_ms: number }>;
  top_models: Array<{ model: string; runs: number; tokens: number }>;
  origins: Array<{ origin: string; runs: number; tokens: number }>;
  cache: { total_rows: number; total_hits: number; hit_rate: number };
}

// Governance analytics (admin-only). spend rows are {model_id, model_name,
// spend, tokens} with spend a numeric string; messages rows {bucket, count}.
interface SpendRow {
  model_id: string | null;
  model_name: string | null;
  spend: string | number;
  tokens: number;
}
interface MsgBucket {
  bucket: string;
  count: number;
}

interface SwarmRunRow {
  id: string;
  question: string;
  status: string;
  models: Array<{ model_id: string; external_id?: string; label?: string }> | null;
  rounds_completed: number;
  created_at: string;
  completed_at: string | null;
}

interface SetupStatus {
  setup_required: boolean;
  users: number;
  providers: number;
}

const POLL_MS = 30_000;

export function HomePage() {
  const { user } = useAuth();
  const { open: openPalette } = useCommandPalette();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const [panels, setPanels] = useState<PanelSummary[] | null>(null);
  const [sandbox, setSandbox] = useState<SandboxState | null>(null);
  const [perf, setPerf] = useState<Perf | null>(null);
  const [spend, setSpend] = useState<SpendRow[] | null>(null);
  const [msgs, setMsgs] = useState<MsgBucket[] | null>(null);
  const [swarm, setSwarm] = useState<SwarmRunRow[] | null>(null);
  const [lastLoaded, setLastLoaded] = useState<number | null>(null);

  const isAdmin = user?.role === "admin";

  const load = useCallback(() => {
    apiGet<PanelSummary[]>("/panels").then(setPanels).catch(() => setPanels([]));
    if (user?.id) {
      apiGet<SandboxState>("/workspace/sandbox")
        .then(setSandbox)
        .catch(() => setSandbox(null));
    }
    // /perf is live for every role (admin = workspace-wide).
    apiGet<Perf>("/perf")
      .then((p) => {
        setPerf(p);
        setLastLoaded(Date.now());
      })
      .catch(() => setPerf((cur) => cur));
    apiGet<{ runs: SwarmRunRow[] }>("/swarm/runs")
      .then((r) => setSwarm(r.runs ?? []))
      .catch(() => setSwarm([]));
    if (isAdmin) {
      apiGet<SpendRow[]>("/governance/analytics/spend-by-model")
        .then(setSpend)
        .catch(() => setSpend([]));
      apiGet<MsgBucket[]>("/governance/analytics/messages-over-time")
        .then(setMsgs)
        .catch(() => setMsgs([]));
    }
  }, [user?.id, isAdmin]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const totalSpendUsd = useMemo(() => {
    if (perf && perf.total_cost_cents > 0) return perf.total_cost_cents / 100;
    return (spend ?? []).reduce((acc, m) => acc + Number(m.spend || 0), 0);
  }, [perf, spend]);

  // Hourly messages over the last 24h, labelled 0h..23h ago.
  const msgSeries: LineDatum[] = useMemo(() => {
    if (!msgs) return [];
    return msgs.map((p, i, arr) => ({
      label: i === arr.length - 1 ? "now" : `${arr.length - 1 - i}h ago`,
      value: p.count,
    }));
  }, [msgs]);

  const msgTotal24h = useMemo(
    () => msgSeries.reduce((a, b) => a + b.value, 0),
    [msgSeries],
  );

  // Top models by tokens — bar chart.
  const modelBars: BarDatum[] = useMemo(() => {
    if (!perf?.top_models) return [];
    return perf.top_models.slice(0, 6).map((m) => ({
      label: m.model.split("/").pop() ?? m.model,
      value: m.tokens,
      display: `${m.tokens.toLocaleString()} tok`,
      secondary: `${m.runs} runs`,
    }));
  }, [perf]);

  const errRate =
    perf && perf.total_runs > 0
      ? Math.round((perf.error_runs / perf.total_runs) * 100)
      : 0;

  if (!user) return <PublicLandingPage />;
  const greeting = greetingFor(new Date());

  return (
    <div className="content-page space-y-6">
      {/* Greeting + live pulse */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="page-title">
            {greeting}, {user.name}.
          </h2>
          <p className="mt-1 text-[13px] text-textMuted">
            role <span className="text-brass">{user.role}</span>
            {" · "}
            <button
              type="button"
              onClick={openPalette}
              className="text-textMuted hover:text-brass underline-offset-2 hover:underline"
            >
              search any panel, model, or user
            </button>{" "}
            with{" "}
            <kbd className="mono-caps text-[10px] border border-borderSoft px-1 h-[14px] inline-flex items-center">
              ⌘K
            </kbd>
          </p>
        </div>
        <div className="flex items-center gap-3">
          {lastLoaded !== null && (
            <span className="mono-caps text-[10px] text-textFaint tracking-wider flex items-center gap-1.5">
              <RefreshIcon size={10} className="text-teal" />
              live · refreshed{" "}
              {new Date(lastLoaded).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </span>
          )}
          <StatusPill
            state={
              sandbox?.status === "running"
                ? "healthy"
                : sandbox?.status === "stopped"
                  ? "idle"
                  : "unknown"
            }
            label={sandbox?.status ?? "sandbox"}
            meta={
              sandbox
                ? `${Number(sandbox.cpu_pct).toFixed(1)}% cpu · ${Number(sandbox.mem_pct).toFixed(1)}% mem`
                : undefined
            }
          />
        </div>
      </div>

      {/* Stat tiles — all live */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile
          label="messages"
          countUp={msgTotal24h}
          tone="teal"
          icon={<ChatIcon size={16} />}
          spark={msgSeries.map((d) => d.value)}
          hint="last 24h"
        />
        <StatTile
          label="spend"
          countUp={Number.isFinite(totalSpendUsd) ? totalSpendUsd : 0}
          format={(n) => `$${n.toFixed(2)}`}
          tone="brass"
          icon={<DollarSignIcon size={16} />}
          hint={
            isAdmin
              ? "this month, all models"
              : "your usage, last 30 days"
          }
        />
        <StatTile
          label="avg latency"
          value={
            perf ? (
              `${Math.round(perf.avg_latency_ms / 100) / 10}s`
            ) : (
              "…"
            )
          }
          delta={
            perf
              ? { value: Math.round(perf.p95_latency_ms / 100) / 10, suffix: "s p95" }
              : undefined
          }
          tone="teal"
          icon={<GaugeIcon size={16} />}
          hint="model responses, 24h"
        />
        <StatTile
          label="model runs"
          value={perf ? perf.total_runs.toLocaleString() : "…"}
          delta={perf ? { value: -errRate, suffix: "% errors" } : undefined}
          tone={errRate > 5 ? "rust" : "brass"}
          icon={<LayersIcon size={16} />}
          hint={`${perf?.total_tokens.toLocaleString() ?? "…"} tokens · 30d`}
        />
      </section>

      {/* Charts row: message pulse + spend split */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 border border-border bg-panel">
          <PanelHeader
            title="Message pulse · 24h"
            icon={<ActivityIcon size={14} />}
            action={
              <button
                type="button"
                onClick={() => navigate("/analytics")}
                className="mono-caps text-[10px] text-textMuted hover:text-brass"
              >
                analytics <ArrowRightIcon size={10} className="inline" />
              </button>
            }
          />
          <div className="p-4">
            {msgs === null ? (
              <Skeleton variant="row" />
            ) : msgSeries.length === 0 ? (
              <EmptyState
                variant="conversation"
                title="No messages in the last 24h"
                description="Send a message in any panel or chat to see the pulse."
                tone="neutral"
              />
            ) : (
              <LineChart
                data={msgSeries}
                height={180}
                tone="teal"
                yAxis
                xAxis
              />
            )}
          </div>
        </div>

        <div className="border border-border bg-panel">
          <PanelHeader
            title="Spend by model"
            icon={<DollarSignIcon size={14} />}
            action={
              isAdmin ? (
                <button
                  type="button"
                  onClick={() => navigate("/analytics")}
                  className="mono-caps text-[10px] text-textMuted hover:text-brass"
                >
                  analytics <ArrowRightIcon size={10} className="inline" />
                </button>
              ) : undefined
            }
          />
          <div className="p-4">
            {spend === null ? (
              <Skeleton variant="row" />
            ) : spend.length === 0 ? (
              <EmptyState
                variant="ledger"
                title={isAdmin ? "No spend yet this month" : "Admin sees model spend"}
                description={
                  isAdmin
                    ? "Model calls accrue here as the workspace uses them."
                    : "Your own token usage is tracked under Analytics."
                }
                tone="brass"
              />
            ) : (
              <BarChart
                data={spend.slice(0, 6).map((m) => ({
                  label: (m.model_name ?? "unattributed").split("/").pop() ?? "—",
                  value: Number(m.spend) || 0,
                  display: `$${Number(m.spend).toFixed(4)}`,
                  secondary: `${m.tokens.toLocaleString()} tok`,
                }))}
                tone="brass"
                height={180}
                showValues
              />
            )}
          </div>
        </div>
      </section>

      {/* Quick actions */}
      <section className="border border-border bg-panel">
        <div className="px-4 py-2 border-b border-borderSoft flex items-center gap-2">
          <ZapIcon size={14} className="text-brass" />
          <span className="mono-caps text-[11px] text-textMuted tracking-wider">
            Quick actions
          </span>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 divide-x divide-border">
          <QuickAction
            icon={<ChatIcon size={16} />}
            label="New chat"
            hint="Open chat with no model"
            onClick={() => navigate("/chat")}
          />
          <QuickAction
            icon={<GraphIcon size={16} />}
            label="Swarm run"
            hint="Multi-agent debate"
            onClick={() => navigate("/swarm")}
          />
          {isAdmin && (
            <QuickAction
              icon={<PanelsIcon size={16} />}
              label="New panel"
              hint="Multiplayer room"
              onClick={() => navigate("/panels")}
            />
          )}
          {isAdmin ? (
            <QuickAction
              icon={<ProvidersIcon size={16} />}
              label="Add provider"
              hint="OpenAI, Anthropic, NIM, custom"
              onClick={() => navigate("/providers")}
            />
          ) : (
            <QuickAction
              icon={<UserIcon size={16} />}
              label="Invite user"
              hint="Ask an admin"
              onClick={() =>
                addToast({
                  id: "home-invite-toast",
                  title: "Ask an admin to invite",
                  description:
                    "Only admins can invite users to the workspace.",
                  tone: "info",
                })
              }
            />
          )}
        </div>
      </section>

      {/* Three-column live feed: panels · swarm runs · traffic split */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Recent panels */}
        <div className="border border-border bg-panel">
          <PanelHeader
            title="Recent panels"
            icon={<PanelsIcon size={14} />}
            action={
              <button
                type="button"
                onClick={() => navigate("/panels")}
                className="mono-caps text-[10px] text-textMuted hover:text-brass"
              >
                view all <ArrowRightIcon size={10} className="inline" />
              </button>
            }
          />
          <div className="p-1">
            {panels === null ? (
              <div className="p-4 space-y-3">
                {Array.from({ length: 3 }, (_, i) => (
                  <Skeleton key={i} variant="row" />
                ))}
              </div>
            ) : panels.length === 0 ? (
              <EmptyState
                variant="conversation"
                title="No panels yet"
                description="Panels are multiplayer rooms where invited users and an AI agent share a thread."
                tone="brass"
              />
            ) : (
              <ul className="divide-y divide-borderSoft">
                {panels.slice(0, 4).map((p) => (
                  <PanelRow key={p.id} panel={p} />
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Recent swarm runs */}
        <div className="border border-border bg-panel">
          <PanelHeader
            title="Swarm runs"
            icon={<GraphIcon size={14} />}
            action={
              <button
                type="button"
                onClick={() => navigate("/swarm")}
                className="mono-caps text-[10px] text-textMuted hover:text-brass"
              >
                open lab <ArrowRightIcon size={10} className="inline" />
              </button>
            }
          />
          <div className="p-1">
            {swarm === null ? (
              <div className="p-4 space-y-3">
                {Array.from({ length: 3 }, (_, i) => (
                  <Skeleton key={i} variant="row" />
                ))}
              </div>
            ) : swarm.length === 0 ? (
              <EmptyState
                variant="conversation"
                title="No swarm runs yet"
                description="Pick 2+ models in Agents Swarm and run a debate."
                tone="teal"
              />
            ) : (
              <ul className="divide-y divide-borderSoft">
                {swarm.slice(0, 4).map((r) => (
                  <SwarmRow key={r.id} run={r} />
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Traffic split: chat vs panel */}
        <div className="border border-border bg-panel">
          <PanelHeader
            title="Traffic split"
            icon={<LayersIcon size={14} />}
          />
          <div className="p-4">
            {!perf || perf.origins.length === 0 ? (
              <div className="space-y-3">
                <SkeletonText lines={4} />
              </div>
            ) : (
              <div className="space-y-4">
                <BarChart
                  data={perf.origins.map((o) => ({
                    label: o.origin,
                    value: o.runs,
                    display: `${o.runs.toLocaleString()} runs`,
                    secondary: `${o.tokens.toLocaleString()} tok`,
                  }))}
                  tone="teal"
                  height={110}
                  showValues
                />
                <div className="grid grid-cols-2 gap-3 pt-1">
                  <MiniStat
                    label="tokens / turn"
                    value={perf.tokens_per_turn.toFixed(0)}
                  />
                  <MiniStat
                    label="total tokens"
                    value={perf.total_tokens.toLocaleString()}
                  />
                  <MiniStat
                    label="top model"
                    value={
                      perf.top_models[0]
                        ? (perf.top_models[0].model.split("/").pop() ??
                          perf.top_models[0].model)
                        : "—"
                    }
                  />
                  <MiniStat
                    label="cache hit"
                    value={
                      perf.cache
                        ? `${Math.round((perf.cache.hit_rate ?? 0) * 100)}%`
                        : "—"
                    }
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}

function greetingFor(d: Date): string {
  const h = d.getHours();
  if (h < 5) return "Good evening";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function PanelHeader({
  title,
  icon,
  action,
}: {
  title: string;
  icon: React.ReactNode;
  action?: React.ReactNode;
}) {
  return (
    <div className="px-4 py-2 border-b border-borderSoft flex items-center gap-2">
      <span className="text-brass">{icon}</span>
      <span className="mono-caps text-[11px] text-textMuted tracking-wider flex-1">
        {title}
      </span>
      {action}
    </div>
  );
}

function QuickAction({
  icon,
  label,
  hint,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex items-center gap-3 px-4 py-3 text-left hover:bg-panelAlt transition-colors"
    >
      <span className="text-textMuted group-hover:text-brass shrink-0 transition-colors">
        {icon}
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-[13px] text-text font-medium">{label}</span>
        <span className="block text-[11px] text-textMuted truncate">{hint}</span>
      </span>
      <ArrowRightIcon
        size={12}
        className="text-textFaint opacity-0 group-hover:opacity-100 transition-opacity"
      />
    </button>
  );
}

function PanelRow({ panel }: { panel: PanelSummary }) {
  const navigate = useNavigate();
  return (
    <li>
      <button
        type="button"
        onClick={() => navigate(`/panels?panel=${panel.id}`)}
        className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-panelAlt transition-colors text-left"
      >
        <Avatar name={panel.name} size={28} />
        <div className="flex-1 min-w-0">
          <div className="font-mono text-[13px] text-text truncate">
            {panel.name}
          </div>
          <div className="mono-caps text-[10px] text-textMuted tracking-wider">
            PNL-{panel.id.slice(0, 4).toUpperCase()}
          </div>
        </div>
        <div className="text-right">
          <div className="font-mono text-[12px] text-text tabular-nums">
            {panel.message_count}
          </div>
          <div className="mono-caps text-[10px] text-textMuted tracking-wider">
            msgs
          </div>
        </div>
      </button>
    </li>
  );
}

function SwarmRow({ run }: { run: SwarmRunRow }) {
  const navigate = useNavigate();
  const modelCount = Array.isArray(run.models) ? run.models.length : 0;
  const tone =
    run.status === "completed"
      ? "text-teal"
      : run.status === "error"
        ? "text-rust"
        : "text-brass";
  return (
    <li>
      <button
        type="button"
        onClick={() => navigate("/swarm")}
        className="w-full px-4 py-2.5 flex items-center gap-3 hover:bg-panelAlt transition-colors text-left"
      >
        <span className={`shrink-0 ${tone}`}>
          <GraphIcon size={16} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[13px] text-text truncate">{run.question}</div>
          <div className="mono-caps text-[10px] text-textMuted tracking-wider">
            {modelCount} models · {run.rounds_completed}{" "}
            {run.rounds_completed === 1 ? "round" : "rounds"} ·{" "}
            {shortTime(run.created_at)}
          </div>
        </div>
        <span
          className={`mono-caps text-[10px] tracking-wider shrink-0 ${tone}`}
        >
          {run.status}
        </span>
      </button>
    </li>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[13px] text-text tabular-nums truncate">
        {value}
      </div>
      <div className="mono-caps text-[10px] text-textMuted tracking-wider">
        {label}
      </div>
    </div>
  );
}

function shortTime(ts: string): string {
  try {
    const d = new Date(ts);
    const now = Date.now();
    const diff = Math.floor((now - d.getTime()) / 1000);
    if (diff < 60) return `${diff}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
    return d.toLocaleString();
  } catch {
    return ts;
  }
}

// ─────────────────────────────────────────────────────────────────────
// PublicLandingPage — shown when the visitor isn't logged in. Hero +
// feature grid + testimonials + CTA. The CTA reads /api/setup/status
// to decide between /setup (first boot) or /login.
// ─────────────────────────────────────────────────────────────────────

interface LandingFeature {
  title: string;
  desc: string;
  icon: React.ReactNode;
}

const LANDING_FEATURES: LandingFeature[] = [
  { title: "Real-time collaboration", desc: "Panels with presence, approvals, time-travel.", icon: <PanelsIcon size={16} /> },
  { title: "Skill packs", desc: "Reusable agent behaviour — git-importable.", icon: <SkillsIcon size={16} /> },
  { title: "Cost router", desc: "Per-panel caps with automatic model fallback.", icon: <DollarSignIcon size={16} /> },
  { title: "Voice in/out", desc: "Transcribe audio, drive workflows by voice.", icon: <PlayIcon size={16} /> },
  { title: "Workflow builder", desc: "Triggers, actions, conditions — visual + YAML.", icon: <ZapIcon size={16} /> },
  { title: "App marketplace", desc: "Install apps into panels with one click.", icon: <AppWindowIcon size={16} /> },
  { title: "Audit log", desc: "Every token, every action — replayable.", icon: <InboxIcon size={16} /> },
  { title: "Sandbox", desc: "Bounded shell execution with audit + caps.", icon: <TerminalIcon size={16} /> },
];

const TESTIMONIALS: Array<{ quote: string; name: string; role: string }> = [
  {
    quote:
      "We swapped a Notion + 3 GPT tabs for one HELM panel. The audit log alone saved us in last quarter's compliance review.",
    name: "Priya S.",
    role: "Head of Data, Northwind Labs",
  },
  {
    quote:
      "The cost router is the killer feature. We route 70% of our traffic to a local model and the rest to GPT-4 — and we never blow the budget.",
    name: "Marcus J.",
    role: "CTO, Stratus AI",
  },
  {
    quote:
      "Voice-to-workflow means my engineers dictate runbooks while walking around the floor. Craziest productivity unlock this year.",
    name: "Yuki T.",
    role: "Ops Lead, Helix Robotics",
  },
];

function PublicLandingPage() {
  const navigate = useNavigate();
  const [setupRequired, setSetupRequired] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiGet<SetupStatus>("/setup/status")
      .then((s) => {
        if (!cancelled) setSetupRequired(s.setup_required);
      })
      .catch(() => {
        if (!cancelled) setSetupRequired(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);
  const cta = setupRequired === false ? "/login" : "/setup";
  const ctaLabel = setupRequired === false ? "Sign in" : "Get started";
  return (
    <div className="min-h-full bg-bg">
      {/* Hero */}
      <section className="px-6 pt-16 pb-10 max-w-[1100px] mx-auto">
        <div className="flex items-baseline gap-3 mb-3">
          <span className="font-display font-bold tracking-[0.22em] text-text text-[40px] leading-none">
            HELM
          </span>
          <CallSign id="OPS-01" />
        </div>
        <h1 className="font-display text-[44px] md:text-[56px] leading-[1.05] font-semibold text-text tracking-tight">
          Governed multiplayer <br className="hidden md:block" />AI workspace.
        </h1>
        <p className="mt-4 max-w-[60ch] text-[16px] text-textMuted leading-[1.55]">
          Shared panels, audit logs, per-panel spend caps, voice in/out,
          and a real-time command palette. One product, every layer of
          the stack you need to put AI in production.
        </p>
        <div className="mt-7 flex items-center gap-3 flex-wrap">
          <Button variant="primary" size="md" onClick={() => navigate(cta)}>
            {ctaLabel} <ArrowRightIcon size={12} />
          </Button>
          <Button
            variant="ghost"
            size="md"
            onClick={() => navigate("/login")}
          >
            I already have an account
          </Button>
        </div>
        <p className="mt-3 mono-caps text-[10px] text-textFaint tracking-wider">
          self-hosted · single binary · &lt; 5 min to first message
        </p>
      </section>

      {/* Feature grid */}
      <section className="px-6 pb-12 max-w-[1100px] mx-auto">
        <div className="border-t border-border pt-6">
          <div className="flex items-center gap-2 mb-4">
            <LayoutIcon size={14} className="text-brass" />
            <span className="mono-caps text-[11px] text-textMuted tracking-wider">
              what's in the box
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            {LANDING_FEATURES.map((f) => (
              <div
                key={f.title}
                className="border border-border bg-panel p-3 flex flex-col gap-1.5 hover:border-brassSoft transition-colors"
              >
                <span className="text-brass">{f.icon}</span>
                <span className="text-[12px] font-medium text-text">
                  {f.title}
                </span>
                <span className="text-[11px] text-textMuted leading-snug">
                  {f.desc}
                </span>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Testimonials */}
      <section className="px-6 pb-12 max-w-[1100px] mx-auto">
        <div className="border-t border-border pt-6">
          <div className="flex items-center gap-2 mb-4">
            <ChatIcon size={14} className="text-brass" />
            <span className="mono-caps text-[11px] text-textMuted tracking-wider">
              what teams are saying
            </span>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            {TESTIMONIALS.map((t) => (
              <figure
                key={t.name}
                className="border border-border bg-panel p-4 flex flex-col gap-2"
              >
                <blockquote className="text-[13px] text-text leading-[1.5]">
                  "{t.quote}"
                </blockquote>
                <figcaption className="mt-auto pt-2 border-t border-borderSoft flex items-center gap-2">
                  <Avatar name={t.name} size={20} />
                  <div className="text-[11px]">
                    <div className="text-text">{t.name}</div>
                    <div className="text-textMuted">{t.role}</div>
                  </div>
                </figcaption>
              </figure>
            ))}
          </div>
        </div>
      </section>

      {/* CTA strip */}
      <section className="px-6 pb-16 max-w-[1100px] mx-auto">
        <div className="border border-brassSoft bg-brass/10 p-6 flex items-center justify-between gap-4 flex-wrap">
          <div>
            <h3 className="font-display text-[20px] text-text font-semibold">
              Put AI in production without losing control.
            </h3>
            <p className="mt-1 text-[12px] text-textMuted">
              Single binary, Postgres, Redis. Bring your own provider.
            </p>
          </div>
          <Button variant="primary" size="md" onClick={() => navigate(cta)}>
            {ctaLabel} <ArrowRightIcon size={12} />
          </Button>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border px-6 py-5 max-w-[1100px] mx-auto flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2 mono-caps text-[10px] text-textFaint tracking-wider">
          <CallSign id="HELM" />
          <span>· governed multiplayer AI workspace</span>
        </div>
        <div className="flex items-center gap-3 mono-caps text-[10px] text-textFaint tracking-wider">
          <a
            href="https://github.com/CwLab/HELM"
            className="hover:text-text"
          >
            github
          </a>
          <span>·</span>
          <a href="/CLI.md" className="hover:text-text">
            cli docs
          </a>
        </div>
      </footer>
    </div>
  );
}
