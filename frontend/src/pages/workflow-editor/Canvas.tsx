// Canvas — the SVG canvas at the heart of the workflow editor.
//
// Owns:
//   - the dot-grid background (two layers)
//   - the SVG view (graph)
//   - pan & zoom (mouse wheel + middle/Shift/Space-drag)
//   - node drag (mousedown on a node → mousemove → mouseup)
//   - edge draw (mousedown on output port → mousemove → release over input port)
//   - drop from palette (HTML5 drag-drop with the text/x-node-kind MIME)
//   - selection (single click selects, click background clears)
//
// Reports upward:
//   - onPan({x, y, scale}) — when the view changes
//   - onCursorMove({x, y}) — last cursor position in SVG world coords
//   - onSelectNode / onSelectEdge — for the inspector
//   - onUpdateGraph / onAddEdge / onAddNode / onDropNode — graph mutations
//
// Children rendered by the editor page (MiniMap, EmptyHint) are siblings
// of the canvas div and use position: absolute to overlay. The canvas
// itself uses h-full so the parent flex column gives it a real height —
// this is the bugfix for the empty-canvas issue.

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  GRID,
  MAX_SCALE,
  MIN_SCALE,
  NODE_KIND_META,
} from "./constants";
import {
  edgePath,
  findEdge,
  nodeBounds,
  nodePortOut,
  pendingEdgePath,
  screenToWorld,
  snap,
} from "./helpers";
import { MiniMap } from "./MiniMap";
import { NodeView } from "./NodeView";
import type {
  NodeKind,
  NodeLogEntry,
  PendingEdge,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowRun,
} from "./types";

interface CanvasProps {
  graph: WorkflowGraph;
  selectedNodeId: string | null;
  selectedEdgeId: string | null;
  pollRun: WorkflowRun | null;
  pollActive: boolean;
  snapToGrid: boolean;
  showMiniMap: boolean;
  /** model_id → display_name lookup so NodeView can show the assigned model. */
  modelDisplayNameById?: Record<string, string>;
  onSelectNode: (id: string | null) => void;
  onSelectEdge: (id: string | null) => void;
  onUpdateGraph: (patch: (g: WorkflowGraph) => WorkflowGraph) => void;
  onAddEdge: (source: string, target: string) => void;
  onAddNode: (kind: NodeKind, x: number, y: number) => void;
  onPanChange: (view: { x: number; y: number; scale: number }) => void;
  onCursorMove: (pos: { x: number; y: number } | null) => void;
  /** Imperative ref handle for fitting to nodes (Cmd+F). */
  imperativeRef: React.MutableRefObject<{ fitToContent: () => void; resetView: () => void } | null>;
}

interface ViewState {
  x: number;
  y: number;
  scale: number;
}

export function Canvas(props: CanvasProps) {
  const {
    graph,
    selectedNodeId,
    selectedEdgeId,
    pollRun,
    pollActive,
    snapToGrid,
    showMiniMap,
    modelDisplayNameById,
    onSelectNode,
    onSelectEdge,
    onUpdateGraph,
    onAddEdge,
    onAddNode,
    onPanChange,
    onCursorMove,
    imperativeRef,
  } = props;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const spaceDownRef = useRef(false);

  const [view, setView] = useState<ViewState>({ x: 0, y: 0, scale: 1 });
  const [dims, setDims] = useState<{ w: number; h: number }>({ w: 0, h: 0 });
  const [drag, setDrag] = useState<
    | null
    | {
        nodeId: string;
        offsetX: number;
        offsetY: number;
      }
  >(null);
  const [panState, setPanState] = useState<
    | null
    | {
        startX: number;
        startY: number;
        origView: { x: number; y: number };
      }
  >(null);
  const [pendingEdge, setPendingEdge] = useState<PendingEdge | null>(null);

  // Refs that mirror state — the global mouse listeners read these so they
  // never see a stale closure even when re-render hasn't flushed yet.
  const dragRef = useRef<typeof drag>(null);
  const panRef = useRef<typeof panState>(null);
  const pendingEdgeRef = useRef<PendingEdge | null>(null);
  const viewRef = useRef<ViewState>(view);
  const edgesRef = useRef<WorkflowEdge[]>(graph.edges);
  dragRef.current = drag;
  panRef.current = panState;
  pendingEdgeRef.current = pendingEdge;
  viewRef.current = view;
  edgesRef.current = graph.edges;

  // Measure dimensions. `h-full` on this div (the bug fix) is what gives
  // the SVG a real height — without it the div collapses to 0 and the
  // SVG content is clipped by overflow:hidden.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) {
        setDims({ w: Math.round(r.width), h: Math.round(r.height) });
      }
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    window.addEventListener("resize", measure);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, []);

  // Listen for the Space key to enable "space-drag" panning.
  useEffect(() => {
    function down(e: KeyboardEvent) {
      if (e.code === "Space" && !isTextTarget(e.target)) {
        spaceDownRef.current = true;
        if (containerRef.current) containerRef.current.style.cursor = "grab";
        e.preventDefault();
      }
    }
    function up(e: KeyboardEvent) {
      if (e.code === "Space") {
        spaceDownRef.current = false;
        if (containerRef.current) containerRef.current.style.cursor = "";
      }
    }
    window.addEventListener("keydown", down);
    window.addEventListener("keyup", up);
    return () => {
      window.removeEventListener("keydown", down);
      window.removeEventListener("keyup", up);
    };
  }, []);

  // Notify parent of view changes for the status bar / mini-map.
  useEffect(() => {
    onPanChange(view);
  }, [view, onPanChange]);

  // Index the latest log per node_id for fast lookup in NodeView.
  const logByNodeId = useMemo(() => {
    const map = new Map<string, NodeLogEntry>();
    const arr = pollRun?.result?.log ?? [];
    for (const entry of arr) map.set(entry.node_id, entry);
    return map;
  }, [pollRun]);

  function svgPoint(clientX: number, clientY: number): { x: number; y: number } {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    return screenToWorld(clientX, clientY, rect, view);
  }

  function onCanvasMouseDown(evt: React.MouseEvent) {
    if (evt.target === svgRef.current) {
      onSelectNode(null);
      onSelectEdge(null);
      const shouldPan = evt.button === 1 || evt.shiftKey || spaceDownRef.current;
      if (shouldPan) {
        setPanState({
          startX: evt.clientX,
          startY: evt.clientY,
          origView: { x: view.x, y: view.y },
        });
      }
    }
  }

  function onNodeMouseDown(evt: React.MouseEvent, node: WorkflowNode) {
    evt.stopPropagation();
    // Decide between "drag node" vs "start edge draft" based on where the
    // user grabbed the card. The bottom 35% of the card (and especially
    // around the visible port) starts an edge — this matches n8n's
    // "drag from the handle" UX while being more forgiving than a
    // 6-pixel port circle.
    const pt = svgPoint(evt.clientX, evt.clientY);
    const localY = pt.y - node.y;
    const b = nodeBounds(node);
    const inBottomThird = localY > b.h * 0.65 && node.kind !== "trigger";
    if (inBottomThird) {
      setPendingEdge({ fromId: node.id, x: pt.x, y: pt.y });
      return;
    }
    onSelectNode(node.id);
    onSelectEdge(null);
    setDrag({
      nodeId: node.id,
      offsetX: pt.x - node.x,
      offsetY: pt.y - node.y,
    });
  }

  /**
   * Click handler on a node port. Begins drawing an edge from the
   * clicked port. The hit areas are bigger than the visible ports so
   * the user doesn't have to be pixel-precise.
   *
   *   - Output port → start drawing an edge from this node.
   *   - Input port  → ignored for now (drag-to-connect is from outputs
   *                   only, matching n8n/Excalidraw conventions).
   */
  function onPortMouseDown(
    evt: React.MouseEvent,
    port: "in" | "out",
    nodeId: string,
  ) {
    if (port !== "out") return;
    const node = graph.nodes.find((n) => n.id === nodeId);
    if (!node) return;
    const p = nodePortOut(node);
    const pt = svgPoint(evt.clientX, evt.clientY);
    setPendingEdge({ fromId: nodeId, x: pt.x, y: pt.y });
    // Keep the connection near where the user clicked.
    void p;
  }

  // Global pointer listeners — installed once. They read the latest state
  // through refs so the closures are never stale (the previous version
  // re-installed on every render which created a window where mouseup
  // could fire after cleanup but before re-install).
  useEffect(() => {
    function onMove(e: MouseEvent) {
      const d = dragRef.current;
      const pan = panRef.current;
      const pe = pendingEdgeRef.current;
      if (d && svgRef.current) {
        const pt = svgPoint(e.clientX, e.clientY);
        let nx = Math.max(0, pt.x - d.offsetX);
        let ny = Math.max(0, pt.y - d.offsetY);
        if (snapToGrid) {
          nx = snap(nx, GRID);
          ny = snap(ny, GRID);
        }
        onUpdateGraph((g) => ({
          ...g,
          nodes: g.nodes.map((n) =>
            n.id === d.nodeId ? { ...n, x: nx, y: ny } : n,
          ),
        }));
      }
      if (pan) {
        const dx = e.clientX - pan.startX;
        const dy = e.clientY - pan.startY;
        setView((v) => ({ ...v, x: pan.origView.x + dx, y: pan.origView.y + dy }));
      }
      if (pe && svgRef.current) {
        const pt = svgPoint(e.clientX, e.clientY);
        setPendingEdge({ ...pe, x: pt.x, y: pt.y });
      }
      // Track cursor for StatusBar readout.
      const svg = svgRef.current;
      if (svg) {
        const pt = svgPoint(e.clientX, e.clientY);
        onCursorMove(pt);
      }
    }

    function onUp(e: MouseEvent) {
      // Clear transient state first; both moves and pending-edges end on
      // any mouseup regardless of where it lands.
      const wasDragging = dragRef.current !== null;
      const wasPanning = panRef.current !== null;
      const pe = pendingEdgeRef.current;
      dragRef.current = null;
      panRef.current = null;
      pendingEdgeRef.current = null;
      setDrag(null);
      setPanState(null);

      if (pe) {
        // Hit-test from the actual mouseup target. The hit area port
        // circles use `data-port="out"`; we look for the closest ancestor
        // node group to find where the user released. The transparent
        // hit-area sits inside the node's <g data-node-id=…>, so the
        // closest() walk reaches it.
        const t = e.target as Element | null;
        const group = t?.closest?.("[data-node-id]") ?? null;
        const targetId = group?.getAttribute("data-node-id") ?? null;
        if (targetId && targetId !== pe.fromId) {
          // Reject duplicate edges.
          const edges = edgesRef.current;
          if (!findEdge(edges, pe.fromId, targetId)) {
            onAddEdge(pe.fromId, targetId);
          }
        }
        setPendingEdge(null);
      }
      // Suppress an unused warning that's caught by the variable refs.
      void wasDragging;
      void wasPanning;
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    const onLeave = () => onCursorMove(null);
    containerRef.current?.addEventListener("mouseleave", onLeave);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      containerRef.current?.removeEventListener("mouseleave", onLeave);
    };
  }, [snapToGrid, onAddEdge, onUpdateGraph, onCursorMove]);

  function onWheel(evt: React.WheelEvent) {
    if (!evt.ctrlKey && !evt.metaKey) return;
    evt.preventDefault();
    const svg = svgRef.current;
    if (!svg) return;
    const rect = svg.getBoundingClientRect();
    const mx = evt.clientX - rect.left;
    const my = evt.clientY - rect.top;
    const factor = evt.deltaY < 0 ? 1.1 : 0.9;
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, view.scale * factor));
    // Keep the cursor's world point under the same screen point.
    const dx = (mx - view.x) * (newScale / view.scale - 1);
    const dy = (my - view.y) * (newScale / view.scale - 1);
    setView({ x: view.x - dx, y: view.y - dy, scale: newScale });
  }

  function onDragOver(evt: React.DragEvent) {
    // Only accept a single text/x-node-kind drop. A drag carrying any
    // other type (Files, custom MIME from a hostile source) is rejected
    // here so the browser stops routing the drop to onDrop.
    const types = Array.from(evt.dataTransfer.types);
    if (types.length === 1 && types[0] === "text/x-node-kind") {
      evt.preventDefault();
      evt.dataTransfer.dropEffect = "copy";
    }
  }

  function onDrop(evt: React.DragEvent) {
    const types = Array.from(evt.dataTransfer.types);
    if (types.length !== 1 || types[0] !== "text/x-node-kind") return;
    const raw = evt.dataTransfer.getData("text/x-node-kind");
    // Strict allowlist — only the six known kinds. A hostile page
    // could craft a custom MIME with an arbitrary string and drop it
    // on the canvas; hasOwnProperty rejects anything outside the
    // canonical NODE_KIND_META map (including the empty string that
    // getData() returns when no payload is set). Rejected drops are
    // silently dropped — no node is added.
    if (!raw) return;
    if (!Object.prototype.hasOwnProperty.call(NODE_KIND_META, raw)) return;
    const kind = raw as NodeKind;
    if (!kind) return;
    evt.preventDefault();
    const pt = svgPoint(evt.clientX, evt.clientY);
    const b = nodeBounds({ kind });
    let x = pt.x - b.w / 2;
    let y = pt.y - b.h / 2;
    if (snapToGrid) {
      x = snap(x, GRID);
      y = snap(y, GRID);
    }
    onAddNode(kind, Math.max(0, x), Math.max(0, y));
  }

  // Imperative API for the editor page (F to fit, programmatic reset).
  useEffect(() => {
    imperativeRef.current = {
      fitToContent: () => {
        if (graph.nodes.length === 0) {
          setView({ x: 0, y: 0, scale: 1 });
          return;
        }
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const n of graph.nodes) {
          const b = nodeBounds(n);
          if (n.x < minX) minX = n.x;
          if (n.y < minY) minY = n.y;
          if (n.x + b.w > maxX) maxX = n.x + b.w;
          if (n.y + b.h > maxY) maxY = n.y + b.h;
        }
        const pad = 80;
        const w = maxX - minX + pad * 2;
        const h = maxY - minY + pad * 2;
        const scale = Math.max(
          MIN_SCALE,
          Math.min(MAX_SCALE, Math.min(dims.w / w, dims.h / h)),
        );
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        setView({
          x: dims.w / 2 - cx * scale,
          y: dims.h / 2 - cy * scale,
          scale,
        });
      },
      resetView: () => setView({ x: 0, y: 0, scale: 1 }),
    };
  }, [graph.nodes, dims.w, dims.h, imperativeRef]);

  // ---- Edge factory helpers --------------------------------------------------

  function onBackgroundClick(e: React.MouseEvent) {
    // Already handled in onCanvasMouseDown; this is a no-op reserved for future use.
    void e;
  }

  const callSign = "Wf-canvas";

  return (
    <div
      ref={containerRef}
      data-canvas-container
      className="h-full relative overflow-hidden bg-bg select-none"
      onDragOver={onDragOver}
      onDrop={onDrop}
      onMouseMove={(e) => {
        const pt = svgPoint(e.clientX, e.clientY);
        onCursorMove(pt);
      }}
      onMouseLeave={() => onCursorMove(null)}
      style={{ cursor: spaceDownRef.current ? "grab" : undefined }}
    >
      {/* Dot grid background — two layers: minor dots every GRID, major every GRID*4 */}
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            "radial-gradient(circle, rgba(255,255,255,0.05) 1px, transparent 1px)",
          backgroundSize: `${GRID * view.scale}px ${GRID * view.scale}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      />
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage:
            "radial-gradient(circle, rgba(201, 162, 39, 0.12) 1.4px, transparent 1.6px)",
          backgroundSize: `${GRID * 4 * view.scale}px ${GRID * 4 * view.scale}px`,
          backgroundPosition: `${view.x}px ${view.y}px`,
        }}
      />

      {/* Brass corner brackets — signature chrome */}
      <CornerBrackets />

      {/* Canvas call-sign */}
      <div className="absolute top-3 left-3 mono-caps text-[10px] text-brass tracking-wider pointer-events-none z-10">
        {callSign}
      </div>

      <svg
        ref={svgRef}
        className="absolute top-0 left-0 block"
        width={dims.w || 1}
        height={dims.h || 1}
        viewBox={`0 0 ${dims.w || 1} ${dims.h || 1}`}
        preserveAspectRatio="xMidYMid meet"
        onMouseDown={onCanvasMouseDown}
        onWheel={onWheel}
        onClick={onBackgroundClick}
      >
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={8} markerHeight={8} orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#4c9c90" />
          </marker>
          <marker id="arrow-selected" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={8} markerHeight={8} orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#C9A227" />
          </marker>
          <marker id="arrow-pending" viewBox="0 0 10 10" refX={9} refY={5} markerWidth={8} markerHeight={8} orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#C9A227" />
          </marker>
          {[
            { id: "trigger", color: "#C9A227" },
            { id: "agent_run", color: "#4c9c90" },
            { id: "panel_message", color: "#7a9cc9" },
            { id: "http_post", color: "#b58a23" },
            { id: "condition", color: "#9a7ad0" },
            { id: "delay", color: "#7a7a7a" },
          ].map((g) => (
            <linearGradient key={g.id} id={`grad-${g.id}`} x1="0%" y1="0%" x2="0%" y2="100%">
              <stop offset="0%" stopColor={g.color} stopOpacity={0.35} />
              <stop offset="100%" stopColor={g.color} stopOpacity={0.05} />
            </linearGradient>
          ))}
        </defs>

        <g transform={`translate(${view.x} ${view.y}) scale(${view.scale})`}>
          {/* Edges */}
          {graph.edges.map((e) => {
            const src = graph.nodes.find((n) => n.id === e.source);
            const dst = graph.nodes.find((n) => n.id === e.target);
            if (!src || !dst) return null;
            const from = nodePortOut(src);
            const toPt = (() => {
              // input port = top-center
              const nb = nodeBounds(dst);
              return { x: dst.x + nb.w / 2, y: dst.y };
            })();
            const d = edgePath(from, toPt);
            const isSelected = e.id === selectedEdgeId;
            const hasCond = !!e.condition;
            const stroke = isSelected ? "#C9A227" : hasCond ? "#b58a23" : "#4c9c90";
            return (
              <g
                key={e.id}
                onClick={(ev) => {
                  ev.stopPropagation();
                  onSelectEdge(e.id);
                  onSelectNode(null);
                }}
                className="cursor-pointer"
              >
                {/* Wide invisible hit-area for easier clicking */}
                <path d={d} stroke="transparent" strokeWidth={18} fill="none" />
                {isSelected && (
                  <path d={d} stroke={stroke} strokeWidth={7} fill="none" opacity={0.18} />
                )}
                <path
                  d={d}
                  stroke={stroke}
                  strokeWidth={isSelected ? 2.4 : 1.8}
                  fill="none"
                  opacity={isSelected ? 1 : 0.75}
                  markerEnd={`url(#${isSelected ? "arrow-selected" : "arrow"})`}
                  strokeLinecap="round"
                />
                {hasCond && (
                  <path
                    d={d}
                    stroke={stroke}
                    strokeWidth={1.4}
                    fill="none"
                    strokeDasharray="4 6"
                    opacity={0.45}
                  />
                )}
                {(e.label || hasCond) && (() => {
                  const labelWidth = e.label ? e.label.length * 6.4 + 20 : 36;
                  const cx = (from.x + toPt.x) / 2;
                  const cy = (from.y + toPt.y) / 2;
                  return (
                    <g>
                      <rect
                        x={cx - labelWidth / 2}
                        y={cy - 20}
                        width={labelWidth}
                        height={14}
                        rx={7}
                        fill="#14171d"
                        stroke={stroke}
                        strokeWidth={0.8}
                        opacity={0.95}
                      />
                      <text
                        x={cx}
                        y={cy - 10}
                        textAnchor="middle"
                        fontSize={10}
                        fill="#e6e6e6"
                        style={{ pointerEvents: "none" }}
                      >
                        {e.label || (e.condition ? `${e.condition.op}` : "")}
                      </text>
                    </g>
                  );
                })()}
              </g>
            );
          })}

          {/* Pending edge */}
          {pendingEdge && (() => {
            const src = graph.nodes.find((n) => n.id === pendingEdge.fromId);
            if (!src) return null;
            const from = nodePortOut(src);
            const d = pendingEdgePath(pendingEdge, from);
            return (
              <g>
                <path
                  d={d}
                  stroke="#C9A227"
                  strokeWidth={2}
                  strokeDasharray="6 4"
                  fill="none"
                  opacity={0.85}
                />
                <circle cx={pendingEdge.x} cy={pendingEdge.y} r={8} fill="#C9A227" opacity={0.25} />
                <circle cx={pendingEdge.x} cy={pendingEdge.y} r={4} fill="#C9A227" />
              </g>
            );
          })()}

          {/* Nodes */}
          {graph.nodes.map((n) => (
            <NodeView
              key={n.id}
              node={n}
              selected={n.id === selectedNodeId}
              logEntry={logByNodeId.get(n.id)}
              isRunning={pollActive}
              modelDisplayName={
                (n.config as Record<string, unknown> | undefined)?.model_id
                  ? modelDisplayNameById?.[
                      String((n.config as Record<string, unknown>).model_id)
                    ]
                  : undefined
              }
              onMouseDown={(e) => onNodeMouseDown(e, n)}
              onPortMouseDown={onPortMouseDown}
            />
          ))}
        </g>
      </svg>

      {/* Mini-map overlay */}
      {showMiniMap && (
        <MiniMap
          nodes={graph.nodes}
          edges={graph.edges}
          view={view}
          dims={dims}
          onPan={(dx, dy) => setView((v) => ({ ...v, x: v.x + dx, y: v.y + dy }))}
        />
      )}
    </div>
  );
}

function CornerBrackets() {
  // Four small brass L-brackets at the corners of the visible canvas.
  const L = 14;
  const T = 2;
  const C = "#C9A227";
  const corners = [
    { x: 8, y: 8, dx: 1, dy: 1 },
    { x: `calc(100% - 8px)`, y: 8, dx: -1, dy: 1 },
    { x: 8, y: `calc(100% - 8px)`, dx: 1, dy: -1 },
    { x: `calc(100% - 8px)`, y: `calc(100% - 8px)`, dx: -1, dy: -1 },
  ];
  return (
    <>
      {corners.map((c, i) => (
        <svg
          key={i}
          className="absolute pointer-events-none"
          style={{ left: c.x, top: c.y, width: L, height: L }}
        >
          <path
            d={`M ${c.dx < 0 ? L : 0} 0 H ${c.dx < 0 ? 0 : L} V ${L}`}
            stroke={C}
            strokeWidth={T}
            fill="none"
          />
        </svg>
      ))}
    </>
  );
}

function isTextTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}
