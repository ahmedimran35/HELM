// WorkflowEditorPage — top-level workflow editor.
//
// 3-pane layout: [NodePalette (left) | Canvas (center) | Inspector (right)].
// State: loaded Workflow + selected node/edge + poll loop + auto-save
// debounce + UI toggles (snap-to-grid, mini-map). Undo stack lives in
// memory and supports ⌘Z. Keyboard shortcuts are mounted once at the
// editor-page level so they fire regardless of which subcomponent has focus
// (except while typing in INPUT/TEXTAREA/contenteditable).

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { useNavigate, useParams } from "react-router-dom";
import { apiGet, apiPatch, apiPost } from "../../api/client";
import { useToast } from "../../components/ui/feedback/Toast";
import { XIcon } from "../../components/ui/Icon";
import { Badge } from "../../components/ui/Badge";
import { NODE_KIND_META, PALETTE_CATEGORIES } from "./constants";
import { nid, eid } from "./helpers";
import { Canvas } from "./Canvas";
import { EditorTopBar } from "./EditorTopBar";
import { EmptyHint } from "./EmptyHint";
import { Inspector } from "./Inspector";
import { NodePalette } from "./NodePalette";
import { RunHistory } from "./RunHistory";
import { StatusBar } from "./StatusBar";
import type {
  Model,
  NodeKind,
  Workflow,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowRun,
} from "./types";

/** Maximum entries kept in the in-memory undo stack. */
const UNDO_LIMIT = 20;

export function WorkflowEditorPage() {
  const params = useParams();
  const navigate = useNavigate();
  const { addToast } = useToast();
  const id = params.id;

  // Canvas container ref for drop-coord math.
  const canvasContainerRef = useRef<HTMLDivElement | null>(null);
  // Ref to Canvas's imperative API (fitToContent for F, etc.).
  const canvasApiRef = useRef<{ fitToContent: () => void; resetView: () => void } | null>(null);

  // Workflow state. latestWorkflowRef is the source of truth for auto-save.
  const [workflow, setWorkflow] = useState<Workflow | null>(null);
  const latestWorkflowRef = useRef<Workflow | null>(null);
  useEffect(() => {
    latestWorkflowRef.current = workflow;
  }, [workflow]);

  const [loading, setLoading] = useState(true);
  const [selectedNode, setSelectedNode] = useState<WorkflowNode | null>(null);
  const [selectedEdge, setSelectedEdge] = useState<WorkflowEdge | null>(null);
  const [pollRun, setPollRun] = useState<WorkflowRun | null>(null);
  const [pollActive, setPollActive] = useState(false);
  const [runBusy, setRunBusy] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [lastSaveAt, setLastSaveAt] = useState<string | null>(null);
  const [showMiniMap, setShowMiniMap] = useState(true);
  const [snapToGrid, setSnapToGrid] = useState(true);
  const [showAddNodePopup, setShowAddNodePopup] = useState(false);
  const [cursorPos, setCursorPos] = useState<{ x: number; y: number } | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, scale: 1 });

  // Available AI models (from /api/models). Wires the Inspector's model
  // picker for `agent_run` nodes and the "model" line on the card body.
  const [models, setModels] = useState<Model[]>([]);
  // Whether the Run History sheet is open.
  const [showRunHistory, setShowRunHistory] = useState(false);

  // Undo stack: array of graph snapshots, capped at UNDO_LIMIT.
  const undoStack = useRef<WorkflowGraph[]>([]);
  const [, forceRender] = useState(0);

  // ---- Load ----------------------------------------------------------------

  // Serialize only the fields the backend persists. Used for equality checks
  // to detect whether a save is a no-op (which we skip to avoid round-trips)
  // and to detect when a stale in-flight save is about to clobber newer state.
  function serializeWorkflow(w: Workflow): string {
    return JSON.stringify({
      name: w.name,
      description: w.description,
      graph: w.graph,
      enabled: w.enabled,
    });
  }

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    try {
      const wf = await apiGet<Workflow>(`/workflows/${id}`);
      setWorkflow(wf);
      setPollRun(wf.runs?.[0] ?? null);
      setPollActive(wf.runs?.[0]?.status === "running");
      setDirty(false);
      // The server's response is the new baseline for change detection, so
      // an autosave right after load isn't a no-op trip but also doesn't
      // fire just because the ref differs.
      lastSavedSerializedRef.current = serializeWorkflow(wf);
      undoStack.current = [];
      forceRender((n) => n + 1);
    } catch (err) {
      addToast({
        id: `wf-load-${Date.now()}`,
        title: "Failed to load workflow",
        description: (err as Error).message,
        tone: "warning",
      });
    } finally {
      setLoading(false);
    }
  }, [id, addToast]);

  useEffect(() => {
    void load();
  }, [load]);

  // Models are static for the session — fetch once on mount. Failures
  // are non-fatal: the Inspector falls back to "model id only" mode.
  useEffect(() => {
    let cancelled = false;
    apiGet<Model[]>("/models")
      .then((arr) => {
        if (!cancelled) setModels(arr.filter((m) => m.assigned));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  // ---- Polling -------------------------------------------------------------

  useEffect(() => {
    if (!pollActive || !id) return;
    const t = setInterval(() => {
      apiGet<Workflow>(`/workflows/${id}`)
        .then((wf) => {
          const latest = wf.runs?.[0] ?? null;
          setPollRun(latest);
          if (!latest || latest.status !== "running") {
            setPollActive(false);
            setWorkflow(wf);
          }
        })
        .catch(() => {});
    }, 1500);
    return () => clearInterval(t);
  }, [pollActive, id]);

  // ---- Graph mutation helpers ---------------------------------------------

  const pushUndo = (graph: WorkflowGraph) => {
    undoStack.current.push(graph);
    if (undoStack.current.length > UNDO_LIMIT) undoStack.current.shift();
    forceRender((n) => n + 1);
  };

  const updateGraph = useCallback(
    (patch: (g: WorkflowGraph) => WorkflowGraph) => {
      setWorkflow((w) => {
        if (!w) return w;
        pushUndo(w.graph);
        return { ...w, graph: patch(w.graph) };
      });
      setDirty(true);
      scheduleAutoSave();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    setWorkflow((w) => (w ? { ...w, graph: prev } : w));
    setDirty(true);
    scheduleAutoSave();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-save (debounced) reads the latest workflow from the ref so it
  // never uses a stale closure value.
  //
  // Race-safety: PATCHes are serialized through a single in-flight Promise
  // (`saveInFlightRef`). If a new save arrives while one is in flight, we
  // wait for the in-flight one to settle, then re-serialize from the live
  // ref and save again. This prevents a slow save of state S1 from
  // landing after a faster save of state S3 and clobbering it — every
  // iteration writes the freshest state known to the client.
  //
  // `lastSavedSerializedRef` lets us skip no-op saves (the user made
  // changes that were undone, or only flipped transient UI state) and
  // double-check that a queued save hasn't already been covered.
  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedSerializedRef = useRef<string | null>(null);
  const saveInFlightRef = useRef<Promise<void> | null>(null);

  async function runSaveOnce(serialized: string): Promise<void> {
    const w = latestWorkflowRef.current;
    if (!w) return;
    // Claim this snapshot before awaiting the network so the drain loop
    // doesn't schedule the same snapshot twice in a race.
    lastSavedSerializedRef.current = serialized;
    try {
      await apiPatch(`/workflows/${w.id}`, {
        name: w.name,
        description: w.description,
        graph: w.graph,
        enabled: w.enabled,
      });
      setDirty(false);
      setLastSaveAt(new Date().toISOString());
      addToast({
        id: `wf-autosave-${Date.now()}`,
        title: "Auto-saved",
        tone: "info",
        duration: 1200,
      });
    } catch (err) {
      addToast({
        id: `wf-autosave-err-${Date.now()}`,
        title: "Auto-save failed",
        description: (err as Error).message,
        tone: "warning",
      });
    }
  }

  async function drainSaves(): Promise<void> {
    // Loop until the live state matches what we last persisted (or
    // persisted+in-flight), bounded so a pathological edit storm can't
    // pin the loop forever.
    for (let i = 0; i < 8; i++) {
      const inflight = saveInFlightRef.current;
      if (inflight) {
        try {
          await inflight;
        } catch {
          /* surfaced via toast in runSaveOnce */
        }
      }
      const w = latestWorkflowRef.current;
      if (!w) return;
      const serialized = serializeWorkflow(w);
      if (serialized === lastSavedSerializedRef.current) return;
      const p = runSaveOnce(serialized).finally(() => {
        if (saveInFlightRef.current === p) saveInFlightRef.current = null;
      });
      saveInFlightRef.current = p;
      await p;
    }
  }

  function scheduleAutoSave() {
    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(() => {
      autoSaveTimer.current = null;
      void drainSaves();
    }, 500);
  }

  async function save() {
    const w = latestWorkflowRef.current;
    if (!w) return;
    setSaving(true);
    // Cancel any pending debounced autosave so it doesn't fire a redundant
    // PATCH immediately after our manual one.
    if (autoSaveTimer.current) {
      clearTimeout(autoSaveTimer.current);
      autoSaveTimer.current = null;
    }
    // Wait for an in-flight autosave to land first so our manual save
    // can't race against a stale snapshot.
    const inflight = saveInFlightRef.current;
    if (inflight) {
      try {
        await inflight;
      } catch {
        /* surfaced via toast */
      }
    }
    const serialized = serializeWorkflow(w);
    lastSavedSerializedRef.current = serialized;
    try {
      await apiPatch(`/workflows/${w.id}`, {
        name: w.name,
        description: w.description,
        graph: w.graph,
        enabled: w.enabled,
      });
      setDirty(false);
      setLastSaveAt(new Date().toISOString());
      addToast({
        id: `wf-save-${Date.now()}`,
        title: "Saved",
        tone: "success",
        duration: 1500,
      });
    } catch (err) {
      addToast({
        id: `wf-save-err-${Date.now()}`,
        title: "Save failed",
        description: (err as Error).message,
        tone: "warning",
      });
    } finally {
      setSaving(false);
    }
  }

  async function run() {
    if (!workflow) return;
    setRunBusy(true);
    try {
      await save();
      await apiPost(`/workflows/${workflow.id}/run`, {});
      const wf = await apiGet<Workflow>(`/workflows/${workflow.id}`);
      setWorkflow(wf);
      setPollRun(wf.runs?.[0] ?? null);
      setPollActive(wf.runs?.[0]?.status === "running");
    } catch (err) {
      addToast({
        id: `wf-run-err-${Date.now()}`,
        title: "Run failed",
        description: (err as Error).message,
        tone: "warning",
      });
    } finally {
      setRunBusy(false);
    }
  }

  // ---- Node / edge operations ---------------------------------------------

  function addNodeAtVisibleCenter(kind: NodeKind) {
    const rect = canvasContainerRef.current?.getBoundingClientRect();
    const w = 260, h = 96;
    if (!rect || rect.width < 10 || rect.height < 10) {
      addNode(kind, 200, 200);
      return;
    }
    const cx = rect.width / 2 - w / 2 + (Math.random() - 0.5) * 40;
    const cy = rect.height / 2 - h / 2 + (Math.random() - 0.5) * 40;
    addNode(kind, cx, cy);
  }

  function addNode(kind: NodeKind, x: number, y: number) {
    const node: WorkflowNode = {
      id: nid(),
      kind,
      x: Math.max(0, x),
      y: Math.max(0, y),
      config: {},
    };
    setWorkflow((w) => {
      if (!w) return w;
      pushUndo(w.graph);
      return { ...w, graph: { ...w.graph, nodes: [...w.graph.nodes, node] } };
    });
    setSelectedNode(node);
    setSelectedEdge(null);
    setDirty(true);
    scheduleAutoSave();
  }

  function addEdge(source: string, target: string) {
    if (source === target || !workflow) return;
    if (workflow.graph.edges.some((e) => e.source === source && e.target === target)) return;
    setWorkflow((w) => {
      if (!w) return w;
      pushUndo(w.graph);
      const e: WorkflowEdge = { id: eid(), source, target };
      return { ...w, graph: { ...w.graph, edges: [...w.graph.edges, e] } };
    });
    setDirty(true);
    scheduleAutoSave();
  }

  function deleteNode(id: string) {
    setWorkflow((w) => {
      if (!w) return w;
      pushUndo(w.graph);
      return {
        ...w,
        graph: {
          nodes: w.graph.nodes.filter((n) => n.id !== id),
          edges: w.graph.edges.filter((e) => e.source !== id && e.target !== id),
        },
      };
    });
    if (selectedNode?.id === id) setSelectedNode(null);
    setDirty(true);
    scheduleAutoSave();
  }

  function deleteEdge(id: string) {
    setWorkflow((w) => {
      if (!w) return w;
      pushUndo(w.graph);
      return { ...w, graph: { ...w.graph, edges: w.graph.edges.filter((e) => e.id !== id) } };
    });
    if (selectedEdge?.id === id) setSelectedEdge(null);
    setDirty(true);
    scheduleAutoSave();
  }

  function duplicateNode(id: string) {
    const src = workflow?.graph.nodes.find((n) => n.id === id);
    if (!src) return;
    const copy: WorkflowNode = {
      ...src,
      id: nid(),
      x: src.x + 40,
      y: src.y + 40,
      label: src.label,
      config: src.config ? { ...src.config } : {},
    };
    setWorkflow((w) => {
      if (!w) return w;
      pushUndo(w.graph);
      return { ...w, graph: { ...w.graph, nodes: [...w.graph.nodes, copy] } };
    });
    setSelectedNode(copy);
    setDirty(true);
    scheduleAutoSave();
  }

  // ---- Inspector wiring ---------------------------------------------------

  function updateNode(patch: Partial<WorkflowNode>) {
    if (!selectedNode) return;
    setWorkflow((w) => {
      if (!w) return w;
      pushUndo(w.graph);
      return {
        ...w,
        graph: {
          ...w.graph,
          nodes: w.graph.nodes.map((n) =>
            n.id === selectedNode.id ? { ...n, ...patch } : n,
          ),
        },
      };
    });
    setSelectedNode((n) => (n ? { ...n, ...patch } : n));
    setDirty(true);
    scheduleAutoSave();
  }

  function updateEdge(patch: Partial<WorkflowEdge>) {
    if (!selectedEdge) return;
    setWorkflow((w) => {
      if (!w) return w;
      pushUndo(w.graph);
      return {
        ...w,
        graph: {
          ...w.graph,
          edges: w.graph.edges.map((e) =>
            e.id === selectedEdge.id ? { ...e, ...patch } : e,
          ),
        },
      };
    });
    setSelectedEdge((e) => (e ? { ...e, ...patch } : e));
    setDirty(true);
    scheduleAutoSave();
  }

  // ---- Keyboard shortcuts -------------------------------------------------

  useEffect(() => {
    function isTextTarget(t: EventTarget | null) {
      const el = t as HTMLElement | null;
      if (!el) return false;
      return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable;
    }
    function onKey(e: KeyboardEvent) {
      // Always-available shortcuts (even in text fields unless meta):
      const mod = e.metaKey || e.ctrlKey;

      if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void save();
        return;
      }
      if (mod && e.key.toLowerCase() === "z" && !e.shiftKey) {
        if (!isTextTarget(e.target)) {
          e.preventDefault();
          undo();
        }
        return;
      }
      if (mod && e.key.toLowerCase() === "d") {
        if (!isTextTarget(e.target) && selectedNode) {
          e.preventDefault();
          duplicateNode(selectedNode.id);
        }
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setSelectedNode(null);
        setSelectedEdge(null);
        setShowAddNodePopup(false);
        return;
      }
      if (e.key.toLowerCase() === "f" && !isTextTarget(e.target) && !mod) {
        e.preventDefault();
        canvasApiRef.current?.fitToContent();
        return;
      }
      // Non-modifier shortcuts shouldn't fire while typing.
      if (isTextTarget(e.target)) return;

      if (e.key === "Delete" || e.key === "Backspace") {
        if (selectedNode) {
          e.preventDefault();
          deleteNode(selectedNode.id);
        } else if (selectedEdge) {
          e.preventDefault();
          deleteEdge(selectedEdge.id);
        }
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNode, selectedEdge, undo]);

  // ---- Render -------------------------------------------------------------

  if (loading || !workflow) {
    return (
      <div className="h-full flex items-center justify-center bg-bg">
        <div className="mono-caps text-[11px] text-textFaint">
          {loading ? "loading workflow…" : "not found"}
        </div>
      </div>
    );
  }

  const inspectorOpen = !!selectedNode || !!selectedEdge || showAddNodePopup;

  return (
    <div className="h-screen flex flex-col bg-bg overflow-hidden">
      <EditorTopBar
        workflowId={workflow.id}
        workflowName={workflow.name}
        description={workflow.description}
        enabled={workflow.enabled}
        dirty={dirty}
        saving={saving}
        runBusy={runBusy}
        pollActive={pollActive}
        onBack={() => navigate("/workflows")}
        onAddNode={() => setShowAddNodePopup((v) => !v)}
        onNameChange={(name) => {
          setWorkflow({ ...workflow, name });
          setDirty(true);
        }}
        onDescriptionChange={(description) => {
          setWorkflow({ ...workflow, description });
          setDirty(true);
        }}
        onSave={save}
        onRun={run}
        onToggleEnabled={() => {
          setWorkflow({ ...workflow, enabled: !workflow.enabled });
          setDirty(true);
        }}
      />

      {/* Body — 3 panes. Canvas container holds its own canvas div. */}
      <div
        ref={canvasContainerRef}
        className="flex-1 flex min-h-0 relative bg-bg"
      >
        {/* LEFT — palette */}
        <NodePalette
          onDragStart={() => { /* drag handled in Canvas via dataTransfer */ }}
          onPick={(kind) => {
            addNodeAtVisibleCenter(kind);
            setShowAddNodePopup(false);
          }}
        />

        {/* CENTER — canvas. Inside is the actual Canvas component. */}
        <div className="flex-1 flex flex-col min-w-0 min-h-0 relative">
          <div className="flex-1 min-h-0 relative">
            <Canvas
              graph={workflow.graph}
              selectedNodeId={selectedNode?.id ?? null}
              selectedEdgeId={selectedEdge?.id ?? null}
              pollRun={pollRun}
              pollActive={pollActive}
              snapToGrid={snapToGrid}
              showMiniMap={showMiniMap}
              modelDisplayNameById={Object.fromEntries(models.map((m) => [m.id, m.display_name]))}
              onSelectNode={(id) => setSelectedNode(id ? (workflow?.graph.nodes.find((n) => n.id === id) ?? null) : null)}
              onSelectEdge={(id) => setSelectedEdge(id ? (workflow?.graph.edges.find((e) => e.id === id) ?? null) : null)}
              onUpdateGraph={updateGraph}
              onAddEdge={addEdge}
              onAddNode={addNode}
              onPanChange={setView}
              onCursorMove={setCursorPos}
              imperativeRef={canvasApiRef}
            />

            {/* Empty-state overlay — only when no nodes exist */}
            {workflow.graph.nodes.length === 0 && !showAddNodePopup && (
              <EmptyHint onPick={addNodeAtVisibleCenter} />
            )}

            {/* Quick "+ Add Node" popup (rare path; the palette covers the
                common case). Same UX as before — includes Trigger /
                Agent run / Panel message / HTTP / Condition / Delay. */}
            {showAddNodePopup && (
              <AddNodePopupInline
                onPick={(kind) => {
                  addNodeAtVisibleCenter(kind);
                  setShowAddNodePopup(false);
                }}
                onClose={() => setShowAddNodePopup(false)}
              />
            )}
          </div>
        </div>
      </div>

      {/* BOTTOM — Status bar */}
      <StatusBar
        dirty={dirty}
        saving={saving}
        lastSaveAt={lastSaveAt}
        pollRun={pollRun}
        pollActive={pollActive}
        viewScale={view.scale}
        snapToGrid={snapToGrid}
        showMiniMap={showMiniMap}
        onToggleSnap={() => setSnapToGrid((v) => !v)}
        onToggleMiniMap={() => setShowMiniMap((v) => !v)}
        onFit={() => canvasApiRef.current?.fitToContent()}
        onOpenLog={() => setShowRunHistory(true)}
        cursorPos={cursorPos}
        totalNodes={workflow.graph.nodes.length}
        totalEdges={workflow.graph.edges.length}
      />

      {/* RIGHT — Inspector (SideSheet, conditional) */}
      <Inspector
        open={inspectorOpen}
        selectedNode={selectedNode}
        selectedEdge={selectedEdge}
        lastRun={pollRun}
        availableModels={models}
        onOpenRunHistory={() => setShowRunHistory(true)}
        onClose={() => {
          setSelectedNode(null);
          setSelectedEdge(null);
          setShowAddNodePopup(false);
        }}
        onUpdateNode={updateNode}
        onUpdateEdge={updateEdge}
        onDeleteNode={() => selectedNode && deleteNode(selectedNode.id)}
        onDeleteEdge={() => selectedEdge && deleteEdge(selectedEdge.id)}
      />

      {/* Run History sheet — shows per-node output for every run. */}
      <RunHistory
        open={showRunHistory}
        onClose={() => setShowRunHistory(false)}
        workflow={workflow}
        models={models}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Small inline + Add Node popup — kept for users who hit the toolbar button
// instead of using the palette rail. (Mostly useful on narrow screens.)
// ---------------------------------------------------------------------------

function AddNodePopupInline({ onPick, onClose }: { onPick: (k: NodeKind) => void; onClose: () => void }) {
  return (
    <div
      data-add-node-popup
      className="absolute top-3 left-3 z-20 w-72 bg-panel border border-brass/40 shadow-2xl"
      onClick={(e) => e.stopPropagation()}
    >
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <Badge tone="brass">Add node</Badge>
        <button
          type="button"
          onClick={onClose}
          className="text-textMuted hover:text-text"
          aria-label="Close"
        >
          <XIcon size={12} />
        </button>
      </div>
      <div className="p-2 max-h-[400px] overflow-y-auto">
        {PALETTE_CATEGORIES.map((g) => (
          <div key={g.name} className="mb-2 last:mb-0">
            <div className="mono-caps text-[9px] text-textFaint tracking-wider px-2 py-1 uppercase">
              {g.name}
            </div>
            <div className="space-y-1">
              {g.kinds.map((kind) => {
                const meta = NODE_KIND_META[kind];
                return (
                  <button
                    key={kind}
                    type="button"
                    onClick={() => onPick(kind)}
                    className="w-full flex items-center gap-2.5 px-2.5 py-2 bg-panelAlt border border-border hover:border-brass/40 hover:bg-bg transition-colors text-left"
                  >
                    <div
                      className="w-7 h-7 flex items-center justify-center text-[14px] font-mono flex-shrink-0"
                      style={{
                        color: meta.color,
                        background: meta.color + "20",
                        border: `1px solid ${meta.color}40`,
                      }}
                    >
                      {meta.icon}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12px] font-medium">{meta.label}</div>
                      <div className="text-[10px] text-textFaint truncate">
                        {meta.description}
                      </div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
