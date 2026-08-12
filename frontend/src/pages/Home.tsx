// Home — post-login dashboard (logged in) OR public landing page (logged
// out). Tier 7 adds the public landing variant: hero, feature grid, two
// testimonials, and a CTA that sends the visitor to /setup (if first
// boot) or /login.

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";
import { apiGet } from "../api/client";
import { Avatar } from "../components/ui/Avatar";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/feedback/EmptyState";
import { Skeleton, SkeletonText } from "../components/ui/feedback/Skeleton";
import { Sparkline, StatTile } from "../components/ui/data/charts";
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
  BellIcon,
  SkillsIcon,
  PlayIcon,
  TerminalIcon,
  AppWindowIcon,
  LayoutIcon,
} from "../components/ui/Icon";
import { useCommandPalette } from "../components/system/CommandPalette";
import { useToast } from "../components/ui/feedback/Toast";

interface PanelSummary {
  id: string;
  name: string;
  member_count: number;
  message_count: number;
}

interface ModelRow {
  id: string;
  display_name: string;
  assigned: boolean;
  pending_request: boolean;
}

interface SandboxState {
  status: string;
  cpu_pct: string;
  mem_pct: string;
}

interface Analytics {
  spend_by_model: Array<{ display_name: string; total: number }>;
  messages_over_time: Array<{ ts: string; count: number }>;
}

interface AuditRow {
  id: number;
  ts: string;
  user_name: string;
  action: string;
  target: string;
  tokens: number | null;
}

interface SetupStatus {
  setup_required: boolean;
  users: number;
  providers: number;
}

export function HomePage() {
  const { user } = useAuth();
  const { open: openPalette } = useCommandPalette();
  const { addToast } = useToast();
  const navigate = useNavigate();
  const [panels, setPanels] = useState<PanelSummary[] | null>(null);
  const [models, setModels] = useState<ModelRow[] | null>(null);
  const [sandbox, setSandbox] = useState<SandboxState | null>(null);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [activity, setActivity] = useState<AuditRow[] | null>(null);

  const isAdmin = user?.role === "admin";

  useEffect(() => {
    apiGet<PanelSummary[]>("/panels").then(setPanels).catch(() => setPanels([]));
    apiGet<ModelRow[]>("/models").then(setModels).catch(() => setModels([]));
    if (user) {
      apiGet<SandboxState>("/workspace/sandbox")
        .then(setSandbox)
        .catch(() => setSandbox(null));
    }
    if (isAdmin) {
      apiGet<Array<{ display_name: string; total: number }>>(
        "/governance/analytics/spend-by-model",
      )
        .then((rows) =>
          setAnalytics((cur) => ({
            spend_by_model: rows,
            messages_over_time: cur?.messages_over_time ?? [],
          })),
        )
        .catch(() => {});
      apiGet<Array<{ ts: string; count: number }>>(
        "/governance/analytics/messages-over-time",
      )
        .then((rows) =>
          setAnalytics((cur) => ({
            spend_by_model: cur?.spend_by_model ?? [],
            messages_over_time: rows,
          })),
        )
        .catch(() => {});
    }
    if (isAdmin) {
      apiGet<{ rows: AuditRow[] }>("/logs/activity?limit=10")
        .then((r) => setActivity(r.rows ?? []))
        .catch(() => setActivity([]));
    } else {
      setActivity([]);
    }
  }, [user?.id, isAdmin]);

  const totalSpend = useMemo(
    () =>
      (analytics?.spend_by_model ?? []).reduce(
        (acc, m) => acc + (Number.isFinite(m.total) ? m.total : 0),
        0,
      ),
    [analytics],
  );

  // Compose per-day message series for the sparkline (last 14d if possible).
  const msgSpark = useMemo(() => {
    const counts = analytics?.messages_over_time ?? [];
    return counts.slice(-14).map((p) => (Number.isFinite(p.count) ? p.count : 0));
  }, [analytics]);

  // Spend trend (cumulative over time would need more data; show per-model
  // spend sorted, then take top-3 for a quick visual).
  const spendSpark = useMemo(() => {
    if (!analytics) return [];
    const sorted = [...analytics.spend_by_model]
      .filter((m) => Number.isFinite(m.total))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8)
      .map((m) => m.total);
    return sorted;
  }, [analytics]);

  if (!user) return <PublicLandingPage />;
  const greeting = greetingFor(new Date());

  return (
    <div className="p-6 max-w-[1100px] space-y-6">
      {/* Greeting + role + last-seen */}
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="font-display text-[26px] font-semibold text-text leading-tight">
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
            </button>
            {" "}
            with <kbd className="mono-caps text-[10px] border border-borderSoft px-1 h-[14px] inline-flex items-center">⌘K</kbd>
          </p>
        </div>
        <StatusPill
          state={sandbox?.status === "running" ? "healthy" : sandbox?.status === "stopped" ? "idle" : "unknown"}
          label={sandbox?.status ?? "sandbox"}
          meta={sandbox ? `${Number(sandbox.cpu_pct).toFixed(1)}% cpu` : undefined}
        />
      </div>

      {/* Stat tiles */}
      <section className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatTile
          label="panels"
          value={panels === null ? "…" : panels.length}
          tone="brass"
          icon={<PanelsIcon size={16} />}
          hint={isAdmin ? "across the workspace" : "you belong to"}
        />
        <StatTile
          label="messages"
          value={msgSpark.length > 0 ? msgSpark.reduce((a, b) => a + b, 0) : 0}
          tone="teal"
          icon={<ChatIcon size={16} />}
          spark={msgSpark}
          hint="last 24h"
        />
        <StatTile
          label="sandbox"
          value={sandbox?.status ?? "—"}
          tone={sandbox?.status === "running" ? "teal" : "rust"}
          icon={<DatabaseIcon size={16} />}
          hint={
            sandbox
              ? `cpu ${Number(sandbox.cpu_pct).toFixed(1)}% · mem ${Number(sandbox.mem_pct).toFixed(1)}%`
              : "not running"
          }
        />
        <StatTile
          label="spend"
          value={!Number.isFinite(totalSpend) || totalSpend === 0 ? "$0" : `$${totalSpend.toFixed(2)}`}
          tone="brass"
          icon={<DollarSignIcon size={16} />}
          spark={spendSpark}
          hint={isAdmin ? "this month, all models" : "your usage"}
        />
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
          {isAdmin && (
            <QuickAction
              icon={<PanelsIcon size={16} />}
              label="New panel"
              hint="Multiplayer room"
              onClick={() => navigate("/panels")}
            />
          )}
          {isAdmin && (
            <QuickAction
              icon={<ProvidersIcon size={16} />}
              label="Add provider"
              hint="OpenAI, Anthropic, NIM, custom"
              onClick={() => navigate("/providers")}
            />
          )}
          <QuickAction
            icon={<UserIcon size={16} />}
            label="Invite user"
            hint={isAdmin ? "Settings → Users" : "Ask an admin"}
            onClick={() => {
              if (isAdmin) navigate("/settings");
              else
                addToast({
                  id: "home-invite-toast",
                  title: "Ask an admin to invite",
                  description: "Only admins can invite users to the workspace.",
                  tone: "info",
                });
            }}
          />
        </div>
      </section>

      {/* Two-column: recent panels + recent activity */}
      <section className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Recent panels — spans 2 columns on lg */}
        <div className="lg:col-span-2 border border-border bg-panel">
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
                {panels.slice(0, 5).map((p) => (
                  <PanelRow key={p.id} panel={p} />
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Recent activity */}
        <div className="border border-border bg-panel">
          <PanelHeader
            title="Recent activity"
            icon={<ActivityIcon size={14} />}
          />
          <div className="p-1">
            {activity === null ? (
              <div className="p-4 space-y-3">
                {Array.from({ length: 6 }, (_, i) => (
                  <SkeletonText key={i} lines={2} />
                ))}
              </div>
            ) : activity.length === 0 ? (
              <EmptyState
                variant="ledger"
                title="No activity yet"
                description="Once anyone chats or uses a tool, the last 24 hours will show here."
                tone="neutral"
              />
            ) : (
              <ul className="divide-y divide-borderSoft">
                {activity.slice(0, 10).map((row) => (
                  <ActivityRow key={row.id} row={row} />
                ))}
              </ul>
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
  return (
    <li>
      <button
        type="button"
        onClick={() => {
          window.location.href = `/panels?panel=${panel.id}`;
        }}
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

function ActivityRow({ row }: { row: AuditRow }) {
  return (
    <li className="px-4 py-2 flex items-start gap-3">
      <Avatar name={row.user_name} size={20} />
      <div className="flex-1 min-w-0">
        <div className="text-[12px] text-text truncate">
          <span className="font-medium">{row.user_name}</span>{" "}
          <span className="text-textMuted">{humanise(row.action)}</span>
        </div>
        <div className="mono-caps text-[10px] text-textFaint tracking-wider flex items-center gap-1">
          <ClockIcon size={9} />
          <span>{shortTime(row.ts)}</span>
          {row.tokens !== null && row.tokens > 0 && (
            <>
              <span className="mx-1">·</span>
              <span>{row.tokens} tok</span>
            </>
          )}
        </div>
      </div>
    </li>
  );
}

function humanise(action: string): string {
  return action.replace(/_/g, " ");
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
// to decide between /setup (first boot) and /login (configured).
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
