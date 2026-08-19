// Workflows — visual workflow builder (Tier 2 / docs §P2).
//
// Two views:
//   - WorkflowsList      shown at /workflows
//   - WorkflowEditor     shown at /workflows/:id
//
// Inspired by (not copying) n8n's visual canvas + palette + inspector
// UX. The list view shows a stats bar, workflow grid with mini-canvas
// previews, templates, and a recent-runs timeline. The editor has a
// top breadcrumb, left node palette, center canvas, right inspector,
// bottom execution log, mini-map, and zoom controls.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useNavigate } from "react-router-dom";
import { apiGet, apiPost, apiPatch, apiDelete } from "../api/client";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { Badge } from "../components/ui/Badge";
import { EmptyState } from "../components/ui/feedback/EmptyState";
import { useToast } from "../components/ui/feedback/Toast";
import { SideSheet } from "../components/ui/layout/SideSheet";
import {
  PlusIcon,
  PlayIcon,
  SaveIcon,
  TrashIcon,
  XIcon,
  LightningIcon,
  SearchIcon,
} from "../components/ui/Icon";
import { cn } from "../lib/cn";

// Re-export the editor page so the existing router import
// (`./pages/Workflows` → `WorkflowEditorPage`) keeps working after the
// editor split out into `./workflow-editor/`.
export { WorkflowEditorPage } from "./workflow-editor";

// ---------------------------------------------------------------------------
// Types — mirror the backend schema
// ---------------------------------------------------------------------------

type NodeKind =
  | "trigger"
  | "agent_run"
  | "panel_message"
  | "http_post"
  | "condition"
  | "delay";

type PredicateOp = "eq" | "neq" | "gt" | "lt" | "contains" | "exists";

interface WorkflowNode {
  id: string;
  kind: NodeKind;
  label?: string;
  x: number;
  y: number;
  config?: Record<string, unknown>;
}

interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  condition?: { op: PredicateOp; path: string; value?: unknown } | null;
  label?: string;
}

interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

interface NodeLogEntry {
  node_id: string;
  kind: NodeKind;
  started_at: string;
  finished_at: string;
  status: "ok" | "error" | "skipped";
  output?: unknown;
  error?: string;
}

interface WorkflowRun {
  id: string;
  status: "running" | "completed" | "failed" | "paused";
  started_at: string;
  finished_at: string | null;
  result: { log?: NodeLogEntry[]; outputs?: Record<string, unknown> } | null;
  error: string | null;
  duration_ms?: number;
}

interface Workflow {
  id: string;
  user_id: string;
  panel_id: string | null;
  name: string;
  description: string;
  graph: WorkflowGraph;
  status: "draft" | "active" | "paused" | "archived";
  trigger: string | null;
  schedule: string | null;
  enabled: boolean;
  last_run_at: string | null;
  created_at: string;
  runs?: WorkflowRun[];
}

interface WorkflowTemplate {
  slug: string;
  name: string;
  description: string;
  category: "ops" | "analytics" | "support" | "research";
  graph: WorkflowGraph;
  trigger: string;
  schedule: string | null;
}

// ---------------------------------------------------------------------------
// Visual constants
// ---------------------------------------------------------------------------

const NODE_W = 260;
const NODE_H = 96;
const PORT_R = 6;
const CANVAS_W = 3000;
const CANVAS_H = 2000;
const GRID = 24;

interface NodeKindMeta {
  label: string;
  category: "trigger" | "action" | "logic";
  description: string;
  color: string;
  icon: string;
  shape: "circle" | "rect" | "diamond";
}

const NODE_KIND_META: Record<NodeKind, NodeKindMeta> = {
  trigger: {
    label: "Trigger",
    category: "trigger",
    description: "Start a workflow on event or schedule",
    color: "#C9A227",
    icon: "⚡",
    shape: "circle",
  },
  agent_run: {
    label: "Agent run",
    category: "action",
    description: "Run a HELM agent with a prompt",
    color: "#4c9c90",
    icon: "▶",
    shape: "rect",
  },
  panel_message: {
    label: "Panel message",
    category: "action",
    description: "Post a message into a HELM panel",
    color: "#7a9cc9",
    icon: "✉",
    shape: "rect",
  },
  http_post: {
    label: "HTTP POST",
    category: "action",
    description: "Send an HTTP request to a URL",
    color: "#b58a23",
    icon: "⇄",
    shape: "rect",
  },
  condition: {
    label: "Condition",
    category: "logic",
    description: "Branch based on a value",
    color: "#9a7ad0",
    icon: "◆",
    shape: "diamond",
  },
  delay: {
    label: "Delay",
    category: "logic",
    description: "Wait a fixed amount of time",
    color: "#7a7a7a",
    icon: "⏱",
    shape: "rect",
  },
};

const PREDICATE_OPS: { value: PredicateOp; label: string }[] = [
  { value: "eq", label: "==" },
  { value: "neq", label: "!=" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "contains", label: "contains" },
  { value: "exists", label: "exists" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function nid(): string {
  return "n" + Math.random().toString(36).slice(2, 9);
}
function eid(): string {
  return "e" + Math.random().toString(36).slice(2, 9);
}

function nodeBounds(node: WorkflowNode): { w: number; h: number } {
  if (NODE_KIND_META[node.kind].shape === "diamond") {
    return { w: 140, h: 90 };
  }
  if (NODE_KIND_META[node.kind].shape === "circle") {
    return { w: 100, h: 100 };
  }
  return { w: NODE_W, h: NODE_H };
}

function nodeCenter(node: WorkflowNode): { x: number; y: number } {
  const b = nodeBounds(node);
  return { x: node.x + b.w / 2, y: node.y + b.h / 2 };
}

function nodePortOut(node: WorkflowNode): { x: number; y: number } {
  const c = nodeCenter(node);
  return { x: c.x, y: c.y + nodeBounds(node).h / 2 };
}
function nodePortIn(node: WorkflowNode): { x: number; y: number } {
  const c = nodeCenter(node);
  return { x: c.x, y: c.y - nodeBounds(node).h / 2 };
}

function fmtDate(s: string | null | undefined): string {
  if (!s) return "—";
  const d = new Date(s);
  const now = Date.now();
  const diff = now - d.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return d.toLocaleDateString();
}

function fmtDuration(ms: number | undefined): string {
  if (!ms) return "—";
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60_000)}m ${Math.floor((ms % 60_000) / 1000)}s`;
}

// ---------------------------------------------------------------------------
// List view: /workflows
// ---------------------------------------------------------------------------

export function WorkflowsPage() {
  const navigate = useNavigate();
  const { addToast } = useToast();
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [templates, setTemplates] = useState<WorkflowTemplate[] | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    try {
      const [wfs, tpls] = await Promise.all([
        apiGet<Workflow[]>("/workflows"),
        apiGet<WorkflowTemplate[]>(`/workflow-templates`).catch(() => []),
      ]);
      setWorkflows(wfs);
      setTemplates(tpls);
    } catch (err) {
      addToast({
        id: `wf-load-${Date.now()}`,
        title: "Failed to load workflows",
        description: (err as Error).message,
        tone: "warning",
      });
    }
  }, [addToast]);

  useEffect(() => {
    void load();
  }, [load]);

  const stats = useMemo(() => {
    if (!workflows) return { total: 0, active: 0, runs: 0, lastRun: null as string | null };
    let active = 0;
    let runs = 0;
    let lastRun: string | null = null;
    for (const w of workflows) {
      if (w.enabled && w.status === "active") active++;
      const n = w.runs?.length ?? 0;
      runs += n;
      if (w.last_run_at && (!lastRun || w.last_run_at > lastRun)) lastRun = w.last_run_at;
    }
    return { total: workflows.length, active, runs, lastRun };
  }, [workflows]);

  const filtered = useMemo(() => {
    if (!workflows) return [];
    const s = q.trim().toLowerCase();
    if (!s) return workflows;
    return workflows.filter(
      (w) =>
        w.name.toLowerCase().includes(s) ||
        w.description.toLowerCase().includes(s),
    );
  }, [workflows, q]);

  return (
    <div className="flex h-full">
      {/* Main column */}
      <div className="flex-1 overflow-y-auto p-6 max-w-[1280px]">
        {/* Hero header */}
        <div className="flex items-start justify-between gap-4 mb-6">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <Badge tone="brass">workflows</Badge>
              <span className="text-textFaint mono-caps text-[10px]">
                / visual builder
              </span>
            </div>
            <h1 className="text-[28px] font-display font-semibold tracking-tight">
              Compose multi-step flows
            </h1>
            <p className="text-textMuted text-[13px] mt-1 max-w-[60ch]">
              Chain triggers, agents, panel posts, HTTP calls, conditions and
              delays on a visual canvas. No code, runs as a graph.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setShowTemplates(true)}>
              <LightningIcon size={12} /> Templates
            </Button>
            <Button variant="primary" onClick={() => setShowNew(true)}>
              <PlusIcon size={12} /> New workflow
            </Button>
          </div>
        </div>

        {/* Stats bar */}
        <div className="grid grid-cols-4 gap-3 mb-6">
          <StatCard
            label="Total"
            value={String(stats.total)}
            tone="brass"
          />
          <StatCard
            label="Active"
            value={`${stats.active} / ${stats.total}`}
            tone="teal"
          />
          <StatCard
            label="Total runs"
            value={String(stats.runs)}
            tone="neutral"
          />
          <StatCard
            label="Last run"
            value={fmtDate(stats.lastRun)}
            tone="neutral"
          />
        </div>

        {/* Search */}
        <div className="flex items-center gap-2 mb-4">
          <div className="relative flex-1 max-w-md">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-textFaint pointer-events-none">
              <SearchIcon size={14} />
            </span>
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search workflows…"
              className="w-full pl-8"
            />
          </div>
          {q && (
            <span className="mono-caps text-[10px] text-textFaint">
              {filtered.length} of {workflows?.length ?? 0}
            </span>
          )}
        </div>

        {/* Workflow grid */}
        {workflows === null ? (
          <SkeletonGrid />
        ) : filtered.length === 0 ? (
          <EmptyState
            title={q ? "No workflows match" : "No workflows yet"}
            description={
              q
                ? "Try a different search term."
                : "Click 'New workflow' to compose your first multi-step flow."
            }
            tone="brass"
            action={
              !q && (
                <Button variant="primary" onClick={() => setShowNew(true)}>
                  <PlusIcon size={12} /> New workflow
                </Button>
              )
            }
          />
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filtered.map((w) => (
              <WorkflowCard
                key={w.id}
                workflow={w}
                onOpen={() => navigate(`/workflows/${w.id}`)}
                onChanged={load}
              />
            ))}
          </div>
        )}
      </div>

      {/* Right rail: templates + recent runs */}
      <aside className="w-[280px] border-l border-border bg-panel/40 p-4 overflow-y-auto hidden lg:block">
        <h3 className="mono-caps text-[10px] text-textFaint tracking-wider mb-3">
          Templates
        </h3>
        {templates && templates.length > 0 ? (
          <div className="space-y-2 mb-6">
            {templates.slice(0, 4).map((t) => (
              <button
                key={t.slug}
                onClick={() => setShowTemplates(true)}
                className="w-full text-left bg-panel border border-border hover:border-brass/40 p-3 transition-colors"
              >
                <div className="flex items-center justify-between mb-1">
                  <span className="text-[12px] font-medium truncate">
                    {t.name}
                  </span>
                  <Badge tone="neutral">{t.category}</Badge>
                </div>
                <div className="text-[11px] text-textMuted line-clamp-2 leading-snug">
                  {t.description}
                </div>
              </button>
            ))}
          </div>
        ) : (
          <div className="text-[11px] text-textFaint mb-6">No templates available</div>
        )}

        <h3 className="mono-caps text-[10px] text-textFaint tracking-wider mb-3">
          Recent runs
        </h3>
        <RecentRuns workflows={workflows} />
      </aside>

      {showNew && (
        <NewWorkflowForm
          templates={templates ?? []}
          onCancel={() => setShowNew(false)}
          onCreated={(w) => {
            setShowNew(false);
            navigate(`/workflows/${w.id}`);
          }}
        />
      )}
      {showTemplates && (
        <TemplatesSheet
          templates={templates ?? []}
          onClose={() => setShowTemplates(false)}
          onPick={async (t) => {
            setShowTemplates(false);
            try {
              const r = await apiPost<{ id: string }>("/workflows", {
                name: t.name,
                description: t.description,
                graph: t.graph,
                trigger: t.trigger,
                schedule: t.schedule,
                enabled: true,
              });
              addToast({
                id: `wf-tpl-${Date.now()}`,
                title: "Workflow created from template",
                description: t.name,
                tone: "success",
              });
              navigate(`/workflows/${r.id}`);
            } catch (err) {
              addToast({
                id: `wf-tpl-err-${Date.now()}`,
                title: "Failed to create from template",
                description: (err as Error).message,
                tone: "warning",
              });
            }
          }}
        />
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "brass" | "teal" | "neutral";
}) {
  return (
    <div className="bg-panel border border-border p-3">
      <div className="mono-caps text-[10px] text-textFaint tracking-wider mb-1">
        {label}
      </div>
      <div
        className={cn(
          "text-[18px] font-display font-semibold tabular-nums",
          tone === "brass" && "text-brass",
          tone === "teal" && "text-teal",
          tone === "neutral" && "text-text",
        )}
      >
        {value}
      </div>
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="bg-panel border border-border h-44 animate-pulse"
        />
      ))}
    </div>
  );
}

function RecentRuns({ workflows }: { workflows: Workflow[] | null }) {
  const runs = useMemo(() => {
    if (!workflows) return [];
    const out: Array<{
      run: WorkflowRun;
      workflow: Workflow;
    }> = [];
    for (const w of workflows) {
      for (const r of w.runs ?? []) {
        out.push({ run: r, workflow: w });
      }
    }
    out.sort((a, b) => b.run.started_at.localeCompare(a.run.started_at));
    return out.slice(0, 8);
  }, [workflows]);

  if (runs.length === 0) {
    return (
      <div className="text-[11px] text-textFaint">
        No runs yet. Click Run on a workflow to execute it.
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      {runs.map(({ run, workflow }) => (
        <div
          key={run.id}
          className="bg-panel border border-border px-2.5 py-1.5 flex items-center gap-2"
        >
          <RunStatusDot status={run.status} />
          <div className="flex-1 min-w-0">
            <div className="text-[11px] truncate">{workflow.name}</div>
            <div className="mono-caps text-[9px] text-textFaint">
              {fmtDate(run.started_at)} · {fmtDuration(run.duration_ms)}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function RunStatusDot({ status }: { status: WorkflowRun["status"] }) {
  const color =
    status === "running"
      ? "bg-brass animate-pulse"
      : status === "completed"
      ? "bg-teal"
      : status === "failed"
      ? "bg-rust"
      : "bg-textFaint";
  return <div className={cn("w-2 h-2 rounded-full flex-shrink-0", color)} />;
}

function NodeLogDot({ status }: { status: "ok" | "error" | "skipped" }) {
  const color =
    status === "ok"
      ? "bg-teal"
      : status === "error"
      ? "bg-rust"
      : "bg-textFaint";
  return <div className={cn("w-2 h-2 rounded-full flex-shrink-0", color)} />;
}

// ---------------------------------------------------------------------------
// Workflow card (list view tile) with mini-canvas preview
// ---------------------------------------------------------------------------

function WorkflowCard({
  workflow: w,
  onOpen,
  onChanged,
}: {
  workflow: Workflow;
  onOpen: () => void;
  onChanged: () => void;
}) {
  const { addToast } = useToast();
  const [busy, setBusy] = useState(false);

  async function run(e: React.MouseEvent) {
    e.stopPropagation();
    setBusy(true);
    try {
      await apiPost(`/workflows/${w.id}/run`, {});
      addToast({
        id: `wf-run-${Date.now()}`,
        title: "Run started",
        description: w.name,
        tone: "info",
      });
      onChanged();
    } catch (err) {
      addToast({
        id: `wf-run-err-${Date.now()}`,
        title: "Run failed",
        description: (err as Error).message,
        tone: "warning",
      });
    } finally {
      setBusy(false);
    }
  }

  async function remove(e: React.MouseEvent) {
    e.stopPropagation();
    if (!confirm(`Delete workflow "${w.name}"? This can't be undone.`)) return;
    setBusy(true);
    try {
      await apiDelete(`/workflows/${w.id}`);
      addToast({
        id: `wf-del-${Date.now()}`,
        title: "Workflow deleted",
        description: w.name,
        tone: "warning",
      });
      onChanged();
    } catch (err) {
      addToast({
        id: `wf-del-err-${Date.now()}`,
        title: "Delete failed",
        description: (err as Error).message,
        tone: "warning",
      });
    } finally {
      setBusy(false);
    }
  }

  async function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    setBusy(true);
    try {
      await apiPatch(`/workflows/${w.id}`, { enabled: !w.enabled });
      onChanged();
    } catch (err) {
      addToast({
        id: `wf-tog-err-${Date.now()}`,
        title: "Toggle failed",
        description: (err as Error).message,
        tone: "warning",
      });
    } finally {
      setBusy(false);
    }
  }

  const nodeCount = w.graph?.nodes?.length ?? 0;
  const edgeCount = w.graph?.edges?.length ?? 0;
  const lastRun = w.runs?.[0];

  return (
    <div
      onClick={onOpen}
      className="bg-panel border border-border hover:border-brass/40 transition-colors cursor-pointer group"
    >
      {/* Mini canvas preview */}
      <div className="h-28 bg-bg/60 border-b border-borderSoft relative overflow-hidden">
        <MiniCanvasPreview graph={w.graph} />
        <div className="absolute top-2 right-2 flex items-center gap-1.5">
          {w.enabled ? (
            <Badge tone="teal">active</Badge>
          ) : (
            <Badge tone="neutral">paused</Badge>
          )}
        </div>
      </div>

      {/* Meta */}
      <div className="p-3">
        <div className="flex items-start justify-between gap-2 mb-1">
          <div className="text-[13px] font-medium truncate flex-1">
            {w.name}
          </div>
        </div>
        <div className="text-[11px] text-textMuted line-clamp-2 h-7 leading-tight">
          {w.description || "No description"}
        </div>

        <div className="flex items-center justify-between mt-2 pt-2 border-t border-borderSoft">
          <div className="flex items-center gap-2 mono-caps text-[9px] text-textFaint">
            <span>{nodeCount} nodes</span>
            <span>·</span>
            <span>{edgeCount} edges</span>
            <span>·</span>
            <span>{fmtDate(w.last_run_at)}</span>
          </div>
          {lastRun && (
            <div className="flex items-center gap-1">
              <RunStatusDot status={lastRun.status} />
              <span className="mono-caps text-[9px] text-textFaint">
                {fmtDuration(lastRun.duration_ms)}
              </span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-1.5 mt-2">
          <button
            onClick={run}
            disabled={busy}
            className="flex-1 bg-brass/10 text-brass border border-brass/30 hover:bg-brass/20 mono-caps text-[10px] h-7 flex items-center justify-center gap-1"
          >
            <PlayIcon size={10} /> Run
          </button>
          <button
            onClick={onOpen}
            className="bg-panelAlt text-text border border-border hover:border-brass/30 mono-caps text-[10px] h-7 px-3"
          >
            Edit
          </button>
          <button
            onClick={remove}
            disabled={busy}
            className="bg-panelAlt text-textMuted hover:text-rust border border-border mono-caps text-[10px] h-7 px-2"
            aria-label="Delete"
          >
            <TrashIcon size={10} />
          </button>
        </div>
      </div>
    </div>
  );
}

function MiniCanvasPreview({ graph }: { graph: WorkflowGraph }) {
  const nodes = graph?.nodes ?? [];
  const edges = graph?.edges ?? [];
  if (nodes.length === 0) {
    return (
      <div className="w-full h-full flex items-center justify-center text-textFaint mono-caps text-[10px]">
        empty workflow
      </div>
    );
  }

  // Compute bounds and scale to fit
  const bounds = nodes.reduce(
    (acc, n) => ({
      minX: Math.min(acc.minX, n.x),
      minY: Math.min(acc.minY, n.y),
      maxX: Math.max(acc.maxX, n.x + nodeBounds(n).w),
      maxY: Math.max(acc.maxY, n.y + nodeBounds(n).h),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  );
  const w = bounds.maxX - bounds.minX + 40;
  const h = bounds.maxY - bounds.minY + 40;
  const scale = Math.min(440 / w, 100 / h);
  const tx = -bounds.minX * scale + 20;
  const ty = -bounds.minY * scale + 20;

  return (
    <svg
      viewBox={`0 0 440 100`}
      preserveAspectRatio="xMidYMid meet"
      className="w-full h-full"
    >
      <g transform={`translate(${tx} ${ty}) scale(${scale})`}>
        {/* Edges */}
        {edges.map((e) => {
          const src = nodes.find((n) => n.id === e.source);
          const dst = nodes.find((n) => n.id === e.target);
          if (!src || !dst) return null;
          const a = nodePortOut(src);
          const b = nodePortIn(dst);
          const mid = (a.y + b.y) / 2;
          const d = `M ${a.x} ${a.y} C ${a.x} ${mid}, ${b.x} ${mid}, ${b.x} ${b.y}`;
          return (
            <path
              key={e.id}
              d={d}
              stroke="#4c9c90"
              strokeWidth={2}
              fill="none"
              opacity={0.7}
            />
          );
        })}
        {/* Nodes */}
        {nodes.map((n) => {
          const meta = NODE_KIND_META[n.kind];
          const b = nodeBounds(n);
          return (
            <g key={n.id} transform={`translate(${n.x} ${n.y})`}>
              {meta.shape === "circle" ? (
                <circle
                  cx={b.w / 2}
                  cy={b.h / 2}
                  r={Math.min(b.w, b.h) / 2 - 2}
                  fill={meta.color}
                  opacity={0.85}
                />
              ) : meta.shape === "diamond" ? (
                <polygon
                  points={`${b.w / 2},0 ${b.w},${b.h / 2} ${b.w / 2},${b.h} 0,${b.h / 2}`}
                  fill={meta.color}
                  opacity={0.85}
                />
              ) : (
                <rect
                  width={b.w}
                  height={b.h}
                  fill={meta.color}
                  opacity={0.85}
                />
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Templates sheet
// ---------------------------------------------------------------------------

function TemplatesSheet({
  templates,
  onClose,
  onPick,
}: {
  templates: WorkflowTemplate[];
  onClose: () => void;
  onPick: (t: WorkflowTemplate) => void;
}) {
  return (
    <SideSheet open onClose={onClose} title="Workflow templates" widthClass="w-[600px] max-w-[90vw]">
      <div className="p-4 space-y-3">
        {templates.length === 0 ? (
          <EmptyState
            title="No templates"
            description="Templates will appear here once the backend seeds them."
            tone="neutral"
          />
        ) : (
          templates.map((t) => (
            <button
              key={t.slug}
              onClick={() => onPick(t)}
              className="w-full text-left bg-panel border border-border hover:border-brass/40 p-3 transition-colors"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="text-[13px] font-medium">{t.name}</span>
                <Badge tone="neutral">{t.category}</Badge>
              </div>
              <div className="text-[11px] text-textMuted mb-2">
                {t.description}
              </div>
              <div className="mono-caps text-[10px] text-textFaint">
                {t.graph.nodes.length} nodes · {t.graph.edges.length} edges
              </div>
            </button>
          ))
        )}
      </div>
    </SideSheet>
  );
}

// ---------------------------------------------------------------------------
// New workflow form
// ---------------------------------------------------------------------------

function NewWorkflowForm({
  templates,
  onCancel,
  onCreated,
}: {
  templates: WorkflowTemplate[];
  onCancel: () => void;
  onCreated: (w: { id: string; slug: string }) => void;
}) {
  const { addToast } = useToast();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    if (!name.trim()) {
      setErr("name required");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const r = await apiPost<{ id: string; slug: string }>("/workflows", {
        name: name.trim(),
        description: description.trim(),
        graph: { nodes: [], edges: [] },
        trigger: "manual",
        enabled: true,
      });
      onCreated(r);
    } catch (e) {
      const msg = (e as Error).message;
      setErr(msg);
      addToast({
        id: `wf-new-err-${Date.now()}`,
        title: "Create workflow failed",
        description: msg,
        tone: "warning",
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-bg/80 backdrop-blur-sm flex items-center justify-center p-6">
      <div className="bg-panel border border-brass/40 w-[480px] max-w-[90vw] shadow-2xl">
        <div className="flex items-center justify-between p-3 border-b border-border">
          <span className="mono-caps text-[11px] text-brass">New workflow</span>
          <button onClick={onCancel} className="text-textMuted hover:text-text">
            <XIcon size={14} />
          </button>
        </div>
        <div className="p-4 space-y-3">
          <Input
            name="new-wf-name"
            label="Name"
            placeholder="e.g. Daily standup digest"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
          <Input
            name="new-wf-desc"
            label="Description"
            placeholder="What this workflow does"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          {err && (
            <div className="mono-caps text-[11px] text-rust border border-rust/40 bg-rust/10 px-2 py-1.5">
              {err}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            <Button variant="ghost" onClick={onCancel} disabled={busy}>
              cancel
            </Button>
            <Button variant="primary" onClick={create} disabled={busy || !name.trim()}>
              {busy ? "creating…" : "Create empty workflow"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
