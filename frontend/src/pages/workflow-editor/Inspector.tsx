// Inspector — right-side panel for the selected node or edge.
//
// Wraps the existing SideSheet (which already handles ESC, backdrop
// click, body scroll lock, and slide-in animation) plus the SheetTabs
// helper for the Parameters / Settings / Docs tab strip.
//
// When nothing is selected, we render an empty-state body inside the
// same sheet (keeps the panel mounted but shows workflow-level info).

import { useMemo, useState } from "react";
import {
  LightningIcon,
  PlayIcon,
  SearchIcon,
  TrashIcon,
  XIcon,
} from "../../components/ui/Icon";
import { Input } from "../../components/ui/Input";
import { SideSheet, SheetTabs } from "../../components/ui/layout/SideSheet";
import {
  INSPECTOR_WIDTH_PX,
  NODE_KIND_META,
  PREDICATE_OPS,
} from "./constants";
import type {
  Model,
  NodeKind,
  PredicateOp,
  WorkflowEdge,
  WorkflowNode,
  WorkflowRun,
} from "./types";

type TabId = "parameters" | "settings" | "run";

interface Props {
  open: boolean;
  selectedNode: WorkflowNode | null;
  selectedEdge: WorkflowEdge | null;
  /** Last polled run, if any — used for run history mini-list in empty state. */
  lastRun?: WorkflowRun | null;
  /** AI models available to the current user — drives the agent_run picker. */
  availableModels?: Model[];
  onOpenRunHistory?: () => void;
  onClose: () => void;
  onUpdateNode: (patch: Partial<WorkflowNode>) => void;
  onUpdateEdge: (patch: Partial<WorkflowEdge>) => void;
  onDeleteNode: () => void;
  onDeleteEdge: () => void;
}

export function Inspector({
  open,
  selectedNode,
  selectedEdge,
  lastRun,
  availableModels = [],
  onOpenRunHistory,
  onClose,
  onUpdateNode,
  onUpdateEdge,
  onDeleteNode,
  onDeleteEdge,
}: Props) {
  const tabFor = selectedNode ? "parameters" : selectedEdge ? "settings" : "parameters";
  const [tab, setTab] = useState<TabId>(tabFor);

  // If the selection changes type, snap to the right tab.
  const tabs = useMemo(() => {
    if (selectedNode) {
      return [
        { id: "parameters" as TabId, label: "Parameters" },
        { id: "run" as TabId, label: "Last run", count: lastRun ? 1 : 0 },
        { id: "settings" as TabId, label: "Settings" },
      ];
    }
    if (selectedEdge) {
      return [
        { id: "parameters" as TabId, label: "Connection" },
        { id: "settings" as TabId, label: "Condition" },
      ];
    }
    return [{ id: "parameters" as TabId, label: "Workflow" }];
  }, [selectedNode, selectedEdge]);

  const title = selectedNode
    ? NODE_KIND_META[selectedNode.kind].label
    : selectedEdge
    ? "Connection"
    : "Workflow";

  const description = selectedNode
    ? `${selectedNode.id}  ·  ${NODE_KIND_META[selectedNode.kind].category}`
    : selectedEdge
    ? `${selectedEdge.source.slice(0, 8)} → ${selectedEdge.target.slice(0, 8)}`
    : "Inspector idle";

  return (
    <SideSheet
      open={open}
      onClose={onClose}
      title={title}
      description={description}
      side="right"
      widthClass="w-[380px] max-w-[90vw]"
      footer={
        selectedNode ? (
          <button
            type="button"
            onClick={onDeleteNode}
            className="w-full flex items-center justify-center gap-1.5 bg-rust/10 text-rust border border-rust/30 hover:bg-rust/20 mono-caps text-[10px] h-7"
          >
            <TrashIcon size={10} /> Delete node
          </button>
        ) : selectedEdge ? (
          <button
            type="button"
            onClick={onDeleteEdge}
            className="w-full flex items-center justify-center gap-1.5 bg-rust/10 text-rust border border-rust/30 hover:bg-rust/20 mono-caps text-[10px] h-7"
          >
            <TrashIcon size={10} /> Delete connection
          </button>
        ) : (
          <div className="flex items-center justify-between text-textFaint text-[11px]">
            <span className="mono-caps text-[9px]">no selection</span>
            <button
              type="button"
              onClick={onClose}
              className="text-textMuted hover:text-text"
              aria-label="Close inspector"
            >
              <XIcon size={14} />
            </button>
          </div>
        )
      }
    >
      <div className="px-2 pt-2">
        <SheetTabs<TabId>
          tabs={tabs}
          active={tab}
          onChange={setTab}
        />
      </div>

      {!selectedNode && !selectedEdge && (
        <EmptyInspectorBody lastRun={lastRun ?? null} onOpenRunHistory={onOpenRunHistory} />
      )}
      {selectedNode && (tab === "parameters" || tabs.length === 1) && (
        <NodeParameterTab
          key={selectedNode.id}
          node={selectedNode}
          availableModels={availableModels}
          onUpdate={onUpdateNode}
        />
      )}
      {selectedNode && tab === "run" && (
        <NodeRunTab
          key={selectedNode.id}
          node={selectedNode}
          lastRun={lastRun ?? null}
          onOpenRunHistory={onOpenRunHistory}
        />
      )}
      {selectedNode && tab === "settings" && (
        <NodeSettingsTab
          key={selectedNode.id}
          node={selectedNode}
          onUpdate={onUpdateNode}
        />
      )}
      {selectedEdge && (tab === "parameters" || tabs.length === 1) && (
        <EdgeConnectionTab
          key={selectedEdge.id}
          edge={selectedEdge}
          onUpdate={onUpdateEdge}
        />
      )}
      {selectedEdge && tab === "settings" && (
        <EdgeConditionTab
          key={selectedEdge.id}
          edge={selectedEdge}
          onUpdate={onUpdateEdge}
        />
      )}
    </SideSheet>
  );
}

// ---------------------------------------------------------------------------
// Empty (workflow-level) state. Shown when no node/edge is selected.
// ---------------------------------------------------------------------------

function EmptyInspectorBody({
  lastRun,
  onOpenRunHistory,
}: {
  lastRun: WorkflowRun | null;
  onOpenRunHistory?: () => void;
}) {
  return (
    <div className="p-4 space-y-4">
      <div>
        <div className="mono-caps text-[9px] text-textFaint tracking-wider mb-1">
          QUICK ADD
        </div>
        <p className="text-[12px] text-textMuted leading-[1.55]">
          Click a node kind in the left palette to drop it in the canvas,
          or drag a kind directly onto the canvas to place it at the
          cursor.
        </p>
      </div>
      <div>
        <div className="mono-caps text-[9px] text-textFaint tracking-wider mb-1">
          KEYBOARD
        </div>
        <ul className="text-[11px] text-textMuted space-y-1 font-mono">
          <li><kbd className="text-text">Del</kbd> — delete selected</li>
          <li><kbd className="text-text">⌘S</kbd> — save</li>
          <li><kbd className="text-text">⌘Z</kbd> — undo</li>
          <li><kbd className="text-text">Space + drag</kbd> — pan canvas</li>
          <li><kbd className="text-text">F</kbd> — fit to content</li>
        </ul>
      </div>
      <div>
        <div className="flex items-center justify-between mb-1">
          <div className="mono-caps text-[9px] text-textFaint tracking-wider">
            LAST RUN
          </div>
          {onOpenRunHistory && (
            <button
              type="button"
              onClick={onOpenRunHistory}
              className="mono-caps text-[9px] text-brass hover:underline"
            >
              open log →
            </button>
          )}
        </div>
        {lastRun ? (
          <button
            type="button"
            onClick={onOpenRunHistory}
            className="w-full text-left border border-border bg-panel p-2 text-[11px] hover:border-brass/40 transition-colors"
          >
            <div className="flex items-center gap-2">
              <span
                className={
                  lastRun.status === "completed"
                    ? "text-teal"
                    : lastRun.status === "failed"
                    ? "text-rust"
                    : "text-brass"
                }
              >
                <PlayIcon size={10} />
              </span>
              <span className="font-mono">{lastRun.status}</span>
              <span className="mono-caps text-[9px] text-textFaint ml-auto">
                {lastRun.id.slice(0, 6)}
              </span>
            </div>
            <div className="mono-caps text-[9px] text-textFaint mt-1">
              tap to see per-node output
            </div>
          </button>
        ) : (
          <p className="text-[11px] text-textFaint">
            No runs yet. Click <span className="mono-caps text-brass">Execute</span> in the toolbar.
          </p>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Node parameter tab — kind-specific config editor.
// ---------------------------------------------------------------------------

function NodeParameterTab({
  node,
  onUpdate,
  availableModels,
}: {
  node: WorkflowNode;
  onUpdate: (patch: Partial<WorkflowNode>) => void;
  availableModels: Model[];
}) {
  const meta = NODE_KIND_META[node.kind];
  const cfg = (node.config ?? {}) as Record<string, unknown>;
  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center gap-2">
        <div
          className="w-7 h-7 flex items-center justify-center text-[14px] font-mono flex-shrink-0"
          style={{ color: meta.color, background: meta.color + "15", border: "1px solid " + meta.color + "30" }}
        >
          {meta.icon}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-[12px] font-medium truncate">{meta.label}</div>
          <div className="mono-caps text-[9px] text-textFaint">{node.id}</div>
        </div>
      </div>

      <div>
        <div className="mono-caps text-[9px] text-textFaint tracking-wider mb-1">
          LABEL
        </div>
        <Input
          value={node.label ?? ""}
          onChange={(e) => onUpdate({ label: e.target.value })}
          placeholder={`${meta.label}…`}
          name={`label-${node.id}`}
        />
      </div>

      {node.kind === "agent_run" && (
        <ModelPicker
          cfg={cfg}
          availableModels={availableModels}
          onChange={(patch) => onUpdate({ config: { ...cfg, ...patch } })}
        />
      )}

      <NodeKindFields kind={node.kind} cfg={cfg} onChange={(patch) => onUpdate({ config: { ...cfg, ...patch } })} />
    </div>
  );
}

/** Inline AI model picker. Lists every model assigned to the current
 *  user (fetched from /api/models). Empty state falls back to "use
 *  your first assigned model" with a hint. */
function ModelPicker({
  cfg,
  availableModels,
  onChange,
}: {
  cfg: Record<string, unknown>;
  availableModels: Model[];
  onChange: (patch: Record<string, unknown>) => void;
}) {
  const selected = (cfg.model_id as string) ?? "";
  const selectedModel = availableModels.find((m) => m.id === selected);
  return (
    <div>
      <div className="mono-caps text-[9px] text-textFaint tracking-wider mb-1">
        AI MODEL
      </div>
      {availableModels.length === 0 ? (
        <div className="border border-border bg-bg/60 p-2 text-[11px] text-textFaint">
          No assigned models. Ask an admin to grant access on <span className="text-text">Settings → Models</span>, or this agent will fall back to your first granted model.
        </div>
      ) : (
        <select
          value={selected}
          onChange={(e) => onChange({ model_id: e.target.value })}
          className="w-full h-8 bg-panelAlt border border-border text-text px-2 text-[12px] font-mono focus:border-brass"
          name="agent-run-model"
        >
          <option value="">— auto (first assigned) —</option>
          {availableModels.map((m) => (
            <option key={m.id} value={m.id}>
              {m.display_name}
              {m.provider_base_url ? `  ·  ${m.provider_base_url.replace(/^https?:\/\//, "").slice(0, 32)}` : ""}
            </option>
          ))}
        </select>
      )}
      {selectedModel && (
        <div className="mono-caps text-[9px] text-textFaint mt-1 flex flex-wrap gap-x-2">
          <span>· id: {selectedModel.external_id}</span>
          <span>· {selectedModel.provider_type}</span>
        </div>
      )}
    </div>
  );
}

function NodeSettingsTab({
  node: _node,
  onUpdate: _onUpdate,
}: {
  node: WorkflowNode;
  onUpdate: (patch: Partial<WorkflowNode>) => void;
}) {
  return (
    <div className="p-4 space-y-3">
      <div>
        <div className="mono-caps text-[9px] text-textFaint tracking-wider mb-1">
          POSITION
        </div>
        <p className="text-[11px] text-textMuted">
          Drag the node on the canvas to reposition. Hold <kbd>Shift</kbd>
          to fine-tune (no snap).
        </p>
      </div>
      <div>
        <div className="mono-caps text-[9px] text-textFaint tracking-wider mb-1">
          ADVANCED
        </div>
        <p className="text-[11px] text-textMuted">
          Retry policy and timeout land here in a later release.
        </p>
      </div>
    </div>
  );
}

/** "Last run" tab inside the Inspector — shows the most recent run's
 *  entry for the selected node, plus a button to open the full
 *  timeline. Falls back to "no runs yet" instructions when empty. */
function NodeRunTab({
  node,
  lastRun,
  onOpenRunHistory,
}: {
  node: WorkflowNode;
  lastRun: WorkflowRun | null;
  onOpenRunHistory?: () => void;
}) {
  const meta = NODE_KIND_META[node.kind];
  const log = (lastRun?.result?.log ?? []) as Array<{
    node_id: string;
    kind: string;
    started_at: string;
    finished_at: string;
    status: "ok" | "error" | "skipped";
    output?: unknown;
    error?: string;
  }>;
  const entry = log.find((e) => e.node_id === node.id);
  return (
    <div className="p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="mono-caps text-[9px] text-textFaint tracking-wider">
          MOST RECENT RUN
        </div>
        {onOpenRunHistory && (
          <button
            type="button"
            onClick={onOpenRunHistory}
            className="mono-caps text-[9px] text-brass hover:underline"
          >
            all runs →
          </button>
        )}
      </div>
      {!entry ? (
        <div className="border border-border bg-bg/60 p-3 text-[12px] text-textFaint">
          No entry for this node in the most recent run. Either the run
          skipped this branch (condition false) or no run has happened yet.
        </div>
      ) : (
        <div className="border border-border bg-bg/60 p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="mono-caps text-[11px] text-brass">
              {meta.icon} {node.label?.trim() || meta.label}
            </span>
            <span className="mono-caps text-[9px] text-textFaint">
              {entry.kind}
            </span>
            <span
              className={
                entry.status === "ok"
                  ? "mono-caps text-[10px] text-teal"
                  : entry.status === "error"
                  ? "mono-caps text-[10px] text-rust"
                  : "mono-caps text-[10px] text-textFaint"
              }
            >
              {entry.status}
            </span>
          </div>
          {entry.kind === "agent_run" && (
            <div className="space-y-1">
              <div className="mono-caps text-[9px] text-textFaint tracking-wider">
                AI REPLY
              </div>
              <pre className="bg-panelAlt/50 border border-border p-2 text-[12px] font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                {String((entry.output as { text?: unknown })?.text ?? "(empty)")}
              </pre>
              <div className="mono-caps text-[9px] text-textFaint">
                model: {String((entry.output as { model?: unknown })?.model ?? "?")}
              </div>
            </div>
          )}
          {entry.kind !== "agent_run" && entry.status === "ok" && (
            <pre className="bg-panelAlt/50 border border-border p-2 text-[11px] font-mono whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
              {JSON.stringify(entry.output ?? {}, null, 2)}
            </pre>
          )}
          {entry.status === "error" && (
            <pre className="bg-bg/40 border border-rust/40 p-2 text-[11px] font-mono text-rust whitespace-pre-wrap break-words">
              {entry.error ?? "no error message"}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function NodeKindFields({
  kind,
  cfg,
  onChange,
}: {
  kind: NodeKind;
  cfg: Record<string, unknown>;
  onChange: (patch: Record<string, unknown>) => void;
}) {
  switch (kind) {
    case "agent_run":
      return (
        <div>
          <div className="mono-caps text-[9px] text-textFaint tracking-wider mb-1">
            PROMPT
          </div>
          <textarea
            value={(cfg.prompt as string) ?? ""}
            onChange={(e) => onChange({ prompt: e.target.value })}
            rows={5}
            placeholder="e.g. Summarize the recent messages"
            className="w-full bg-panelAlt border border-border text-text px-2 py-1.5 text-[12px] font-mono focus:border-brass resize-y"
          />
        </div>
      );
    case "panel_message":
      return (
        <div>
          <div className="mono-caps text-[9px] text-textFaint tracking-wider mb-1">
            MESSAGE
          </div>
          <textarea
            value={(cfg.message as string) ?? ""}
            onChange={(e) => onChange({ message: e.target.value })}
            rows={4}
            placeholder="Message to post"
            className="w-full bg-panelAlt border border-border text-text px-2 py-1.5 text-[12px] font-mono focus:border-brass resize-y"
          />
        </div>
      );
    case "http_post":
      return (
        <>
          <div>
            <div className="mono-caps text-[9px] text-textFaint tracking-wider mb-1">
              URL
            </div>
            <Input
              value={(cfg.url as string) ?? ""}
              onChange={(e) => onChange({ url: e.target.value })}
              placeholder="https://…"
              name="url"
            />
          </div>
          <div>
            <div className="mono-caps text-[9px] text-textFaint tracking-wider mb-1">
              METHOD
            </div>
            <select
              value={(cfg.method as string) ?? "POST"}
              onChange={(e) => onChange({ method: e.target.value })}
              className="w-full h-8 bg-panelAlt border border-border text-text px-2 text-[12px] font-mono focus:border-brass"
            >
              {["GET", "POST", "PUT", "DELETE"].map((m) => (
                <option key={m}>{m}</option>
              ))}
            </select>
          </div>
        </>
      );
    case "delay":
      return (
        <div>
          <div className="mono-caps text-[9px] text-textFaint tracking-wider mb-1">
            DELAY (SECONDS)
          </div>
          <Input
            type="number"
            value={String((cfg.seconds as number) ?? 5)}
            onChange={(e) => onChange({ seconds: Number(e.target.value) })}
            name="delay-seconds"
          />
        </div>
      );
    case "condition":
      return (
        <div>
          <div className="mono-caps text-[9px] text-textFaint tracking-wider mb-1">
            PATH (e.g. $.output)
          </div>
          <Input
            value={(cfg.path as string) ?? ""}
            onChange={(e) => onChange({ path: e.target.value })}
            placeholder="$.output"
            name="condition-path"
          />
        </div>
      );
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Edge tabs.
// ---------------------------------------------------------------------------

function EdgeConnectionTab({
  edge,
  onUpdate,
}: {
  edge: WorkflowEdge;
  onUpdate: (patch: Partial<WorkflowEdge>) => void;
}) {
  return (
    <div className="p-4 space-y-3">
      <div>
        <div className="mono-caps text-[9px] text-textFaint tracking-wider mb-1">
          LABEL
        </div>
        <Input
          value={edge.label ?? ""}
          onChange={(e) => onUpdate({ label: e.target.value })}
          placeholder="optional label…"
          name="edge-label"
        />
      </div>
      <div>
        <div className="mono-caps text-[9px] text-textFaint tracking-wider mb-1">
          FROM → TO
        </div>
        <p className="text-[11px] text-textMuted font-mono break-all">
          {edge.source} → {edge.target}
        </p>
      </div>
    </div>
  );
}

function EdgeConditionTab({
  edge,
  onUpdate,
}: {
  edge: WorkflowEdge;
  onUpdate: (patch: Partial<WorkflowEdge>) => void;
}) {
  return (
    <div className="p-4 space-y-3">
      <div>
        <div className="mono-caps text-[9px] text-textFaint tracking-wider mb-1">
          CONDITION
        </div>
        <p className="text-[11px] text-textMuted mb-2">
          When set, this edge only fires when the predicate matches.
        </p>
        <select
          value={edge.condition?.op ?? ""}
          onChange={(e) =>
            onUpdate({
              condition: e.target.value
                ? {
                    op: e.target.value as PredicateOp,
                    path: edge.condition?.path ?? "$.output",
                    value: edge.condition?.value,
                  }
                : null,
            })
          }
          className="w-full h-8 bg-panelAlt border border-border text-text px-2 text-[12px] font-mono focus:border-brass"
        >
          <option value="">always</option>
          {PREDICATE_OPS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <div>
        <div className="mono-caps text-[9px] text-textFaint tracking-wider mb-1">
          PATH
        </div>
        <Input
          value={edge.condition?.path ?? ""}
          onChange={(e) =>
            onUpdate({
              condition: edge.condition
                ? { ...edge.condition, path: e.target.value }
                : { op: "eq", path: e.target.value },
            })
          }
          placeholder="$.output"
          name="edge-condition-path"
        />
      </div>
      {edge.condition && (
        <div>
          <div className="mono-caps text-[9px] text-textFaint tracking-wider mb-1">
            VALUE
          </div>
          <Input
            value={String(edge.condition.value ?? "")}
            onChange={(e) =>
              onUpdate({
                condition: edge.condition
                  ? { ...edge.condition, value: e.target.value }
                  : { op: "eq", path: "$.output" },
              })
            }
            name="edge-condition-value"
          />
        </div>
      )}
    </div>
  );
}
