// RunHistory — sheet listing every run for this workflow, with per-node
// log details. Lets the user see *what* each node did on the last
// execution, including the AI agent's text reply. Opens via the
// StatusBar "log" button, the empty-Inspector's run history link, or
// directly from the polling-status badge while a run is in flight.
//
// All data is read from the workflow row's `runs` array — no extra API
// round-trip needed; the editor already keeps the latest snapshot.

import { useEffect, useState } from "react";
import { SideSheet } from "../../components/ui/layout/SideSheet";
import type { Model, Workflow, WorkflowEdge, WorkflowNode, WorkflowRun } from "./types";

interface Props {
  open: boolean;
  onClose: () => void;
  workflow: Workflow;
  models: Model[];
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleString();
}

function fmtMs(start: string, end: string | null): string {
  if (!end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function entryIcon(kind: string): string {
  switch (kind) {
    case "trigger":
      return "⚡";
    case "agent_run":
      return "▶";
    case "panel_message":
      return "✉";
    case "http_post":
      return "⇄";
    case "condition":
      return "◆";
    case "delay":
      return "⏱";
    default:
      return "•";
  }
}

function statusColor(status: string): string {
  if (status === "ok" || status === "completed") return "text-teal";
  if (status === "error" || status === "failed") return "text-rust";
  if (status === "skipped") return "text-textFaint";
  if (status === "running") return "text-brass";
  return "text-text";
}

export function RunHistory({ open, onClose, workflow, models }: Props) {
  const modelsById = new Map(models.map((m) => [m.id, m]));
  const nodesById = new Map<string, WorkflowNode>(
    workflow.graph.nodes.map((n) => [n.id, n]),
  );
  const edgeById = new Map<string, WorkflowEdge>(
    workflow.graph.edges.map((e) => [e.id, e]),
  );

  // edgeById is reserved for future "show edges between runs" support; we
  // leave it wired so the type-import doesn't go unused.
  void edgeById;

  // Most recent first.
  const runs = (workflow.runs ?? []).slice().reverse();

  const [expanded, setExpanded] = useState<string | null>(runs[0]?.id ?? null);
  // Reset the expanded panel to the most-recent run each time the sheet opens.
  useEffect(() => {
    if (open && runs[0]) setExpanded(runs[0].id);
  }, [open, runs[0]?.id]);

  return (
    <SideSheet
      open={open}
      onClose={onClose}
      title="Run history"
      description={
        workflow.runs?.length
          ? `${workflow.runs.length} run${workflow.runs.length === 1 ? "" : "s"} · sorted newest first`
          : "no runs yet"
      }
      side="right"
      widthClass="w-[520px] max-w-[90vw]"
    >
      <div className="p-4 space-y-4">
        {runs.length === 0 ? (
          <div className="border border-border p-4 text-center">
            <div className="mono-caps text-[10px] text-textFaint tracking-wider mb-1">
              NO RUNS YET
            </div>
            <p className="text-[12px] text-textMuted">
              Click <span className="mono-caps text-brass">Execute</span> in the topbar to run this workflow. Each run's per-node output will appear here.
            </p>
          </div>
        ) : (
          runs.map((r) => (
            <RunCard
              key={r.id}
              run={r}
              isOpen={expanded === r.id}
              onToggle={() => setExpanded(expanded === r.id ? null : r.id)}
              nodesById={nodesById}
              modelsById={modelsById}
            />
          ))
        )}
      </div>
    </SideSheet>
  );
}

interface RunCardProps {
  run: WorkflowRun;
  isOpen: boolean;
  onToggle: () => void;
  nodesById: Map<string, WorkflowNode>;
  modelsById: Map<string, Model>;
}

/** Local copy of the run-status pill (re-exported from StatusBar as a
 *  future cleanup). Identical visual to the StatusBar version. */
function RunStatusDot({ status }: { status: WorkflowRun["status"] }) {
  const color =
    status === "running"
      ? "bg-brass animate-pulse"
      : status === "completed"
      ? "bg-teal"
      : status === "failed"
      ? "bg-rust"
      : "bg-textFaint";
  return <span className={`w-2 h-2 rounded-full flex-shrink-0 ${color}`} />;
}

function RunCard({
  run,
  isOpen,
  onToggle,
  nodesById,
  modelsById,
}: RunCardProps) {
  const log = (run.result?.log ?? []) as Array<{
    node_id: string;
    kind: string;
    started_at: string;
    finished_at: string;
    status: "ok" | "error" | "skipped";
    output?: unknown;
    error?: string;
  }>;

  return (
    <div className="border border-border bg-panel">
      <button
        type="button"
        onClick={onToggle}
        className="w-full px-3 py-2 flex items-center gap-3 text-left hover:bg-panelAlt/50"
      >
        <span className="flex items-center gap-1.5">
          <RunStatusDot status={run.status} />
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] flex items-center gap-2">
            <span className={statusColor(run.status)}>{run.status}</span>
            <span className="mono-caps text-[10px] text-textFaint">
              {fmtMs(run.started_at, run.finished_at)}
            </span>
          </div>
          <div className="mono-caps text-[10px] text-textFaint">
            {fmtTime(run.started_at)}
          </div>
        </div>
        <span className="mono-caps text-[10px] text-textFaint">
          {isOpen ? "−" : "+"}
        </span>
      </button>
      {isOpen && (
        <div className="border-t border-border bg-bg/40">
          {log.length === 0 ? (
            <div className="p-3 text-[12px] text-textFaint">
              No per-node log entries (run failed before any node could start).
            </div>
          ) : (
            <ul className="divide-y divide-borderSoft">
              {log.map((e, i) => {
                const node = nodesById.get(e.node_id);
                const label = node?.label?.trim() || e.kind;
                return (
                  <li key={i} className="p-3 space-y-1">
                    <div className="flex items-center gap-2">
                      <span className="mono-caps text-[11px] text-brass">
                        {entryIcon(e.kind)} {label}
                      </span>
                      <span className="mono-caps text-[9px] text-textFaint">
                        {e.node_id.slice(0, 6)}
                      </span>
                      <span className={`mono-caps text-[10px] ${statusColor(e.status)}`}>
                        {e.status}
                      </span>
                      <span className="mono-caps text-[9px] text-textFaint ml-auto">
                        {fmtMs(e.started_at, e.finished_at)}
                      </span>
                    </div>
                    <NodeOutput
                      kind={e.kind}
                      status={e.status}
                      output={e.output}
                      error={e.error}
                      modelsById={modelsById}
                      nodeConfig={nodesById.get(e.node_id)?.config as Record<string, unknown> | undefined}
                    />
                  </li>
                );
              })}
            </ul>
          )}
          {run.error && (
            <div className="border-t border-borderSoft p-3 text-[12px] text-rust font-mono">
              {run.error}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function NodeOutput({
  kind,
  status,
  output,
  error,
  modelsById,
  nodeConfig,
}: {
  kind: string;
  status: "ok" | "error" | "skipped";
  output: unknown;
  error?: string;
  modelsById: Map<string, Model>;
  nodeConfig?: Record<string, unknown>;
}) {
  if (status === "error") {
    return (
      <pre className="bg-bg/60 border border-rust/30 p-2 text-[11px] text-rust font-mono whitespace-pre-wrap break-words">
        {error || "node errored without a message"}
      </pre>
    );
  }
  if (kind === "agent_run") {
    const o = (output ?? {}) as { text?: string; model?: string };
    const modelId = nodeConfig?.model_id as string | undefined;
    const model = modelId ? modelsById.get(modelId) : undefined;
    return (
      <div className="bg-bg/60 border border-border p-2 space-y-1">
        <div className="mono-caps text-[9px] text-textFaint tracking-wider">
          AI REPLY
        </div>
        <pre className="text-[12px] font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
          {o.text ?? "(empty)"}
        </pre>
        <div className="mono-caps text-[9px] text-textFaint flex flex-wrap gap-x-3 gap-y-1">
          <span>model: {o.model ?? "?"}</span>
          {model && <span>· display: {model.display_name}</span>}
          {model?.provider_base_url && <span>· {model.provider_base_url.replace(/^https?:\/\//, "")}</span>}
        </div>
      </div>
    );
  }
  if (kind === "trigger") {
    const o = (output ?? {}) as { trigger?: string; when?: string };
    return (
      <div className="bg-bg/60 border border-border p-2 mono-caps text-[10px] text-textMuted space-y-0.5">
        <div>trigger: {o.trigger ?? "?"}</div>
        <div>when: {o.when ?? "?"}</div>
      </div>
    );
  }
  if (kind === "delay") {
    const o = (output ?? {}) as { waited_ms?: number };
    return (
      <div className="bg-bg/60 border border-border p-2 mono-caps text-[10px] text-textMuted">
        wait: {o.waited_ms ?? "?"}ms
      </div>
    );
  }
  if (kind === "condition") {
    const o = (output ?? {}) as { branch?: string };
    return (
      <div className="bg-bg/60 border border-border p-2 mono-caps text-[10px] text-textMuted">
        branch: {o.branch ?? "?"}
      </div>
    );
  }
  if (kind === "http_post") {
    const o = (output ?? {}) as { status?: number; body?: string };
    return (
      <div className="bg-bg/60 border border-border p-2 space-y-1">
        <div className="mono-caps text-[9px] text-textFaint tracking-wider">
          HTTP RESPONSE
        </div>
        <pre className="text-[11px] font-mono whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
          {o.status ? `${o.status} ${o.body ?? ""}` : "no response"}
        </pre>
      </div>
    );
  }
  if (status === "skipped") {
    return (
      <div className="bg-bg/60 border border-borderSoft p-2 mono-caps text-[10px] text-textFaint">
        (skipped)
      </div>
    );
  }
  return (
    <pre className="bg-bg/60 border border-border p-2 text-[11px] font-mono whitespace-pre-wrap break-words">
      {JSON.stringify(output, null, 2)}
    </pre>
  );
}
