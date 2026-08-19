// Knowledge Graph (Tier 4: Discovery).
//
// Visualises the user's `kg_entities` + `kg_relationships` as an SVG
// force-directed graph. Pure SVG — no external deps. A simple physics
// loop runs in a `requestAnimationFrame` callback until the system
// settles (low kinetic energy) or 4 s passes, whichever comes first.
//
// Controls:
//   - "Extract from selection" button opens a small modal that takes a
//     raw message id (or the user can paste text) and asks the backend
//     to LLM-extract entities + relations into the graph.
//   - Click a node → right-side sheet listing every relationship plus
//     recent messages that mention the entity by name.
//   - Sidebar lets the user filter by entity kind.
//
// Token-efficient: position state lives in `useRef` (mutated) rather
// than React state to avoid re-rendering on every animation frame.

import { useEffect, useMemo, useRef, useState } from "react";
import { apiGet, apiPost } from "../api/client";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { EmptyState } from "../components/ui/feedback/EmptyState";
import { Skeleton } from "../components/ui/feedback/Skeleton";
import { useToast } from "../components/ui/feedback/Toast";
import { SideSheet } from "../components/ui/layout/SideSheet";
import { cn } from "../lib/cn";

interface KGNode {
  id: string;
  name: string;
  kind: string;
}
interface KGEdge {
  id: string;
  from_entity_id: string;
  to_entity_id: string;
  relation: string;
  weight: number;
}

interface PositionedNode extends KGNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  degree: number;
}

type EntityKind = "all" | "person" | "project" | "topic" | "file" | "concept";

// Brand-toned fills for each kind. Two flavours per kind: a strong
// ("-tone") for nodes, and a soft ("-tone-soft") for hover halos.
const KIND_FILL: Record<string, string> = {
  person: "var(--brass)",
  project: "var(--teal)",
  topic: "var(--textMuted)",
  file: "var(--brassSoft)",
  concept: "var(--teal)",
};

const KIND_STROKE: Record<string, string> = {
  person: "var(--brass)",
  project: "var(--teal)",
  topic: "var(--textFaint)",
  file: "var(--brassSoft)",
  concept: "var(--teal)",
};

const KIND_ORDER: EntityKind[] = ["all", "person", "project", "topic", "file", "concept"];

export function KnowledgeGraphPage() {
  const { addToast } = useToast();
  const [nodes, setNodes] = useState<KGNode[] | null>(null);
  const [edges, setEdges] = useState<KGEdge[] | null>(null);
  const [kindFilter, setKindFilter] = useState<EntityKind>("all");
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [extractOpen, setExtractOpen] = useState(false);
  const [extractText, setExtractText] = useState("");
  const [extractMessageId, setExtractMessageId] = useState("");
  const [extracting, setExtracting] = useState(false);
  const svgRef = useRef<SVGSVGElement | null>(null);

  // Initial load.
  useEffect(() => {
    let cancelled = false;
    apiGet<{ nodes: KGNode[]; edges: KGEdge[] }>("/kg/graph")
      .then((r) => {
        if (cancelled) return;
        setNodes(r.nodes ?? []);
        setEdges(r.edges ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setNodes([]);
          setEdges([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Until the first fetch settles, render a placeholder shape so the
  // canvas doesn't pop in empty. Defaults keep the rest of the page
  // (sidebar / counts) untouched.
  const viewNodes = nodes ?? [];
  const viewEdges = edges ?? [];
  const isLoading = nodes === null || edges === null;

  // Resolved graph — filtered nodes + the edges that stay when both
  // endpoints remain after the kind filter.
  const view = useMemo(() => {
    const allowed = new Set<string>(
      viewNodes.filter((n) => kindFilter === "all" || n.kind === kindFilter).map((n) => n.id),
    );
    const filtEdges = viewEdges.filter(
      (e) => allowed.has(e.from_entity_id) && allowed.has(e.to_entity_id),
    );
    const degreeMap = new Map<string, number>();
    for (const e of filtEdges) {
      degreeMap.set(e.from_entity_id, (degreeMap.get(e.from_entity_id) ?? 0) + 1);
      degreeMap.set(e.to_entity_id, (degreeMap.get(e.to_entity_id) ?? 0) + 1);
    }
    return {
      nodes: viewNodes.filter((n) => allowed.has(n.id)),
      edges: filtEdges,
      degreeMap,
    };
  }, [viewNodes, viewEdges, kindFilter]);

  // Position state lives in a ref so the physics tick mutates it
  // without triggering a React render. We seed nodes on a circle to
  // give the simulation a kickstart.
  const positionsRef = useRef<Map<string, { x: number; y: number; vx: number; vy: number }>>(new Map());
  // Tick counter — incremented after each physics step. The SVG is
  // driven by state so React's reconciler knows when to repaint.
  const [tick, setTick] = useState(0);
  const sizeRef = useRef<{ w: number; h: number }>({ w: 800, h: 520 });

  // Resize observer so the force-directed layout adapts to whatever
  // container size we end up in.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const cr = e.contentRect;
        sizeRef.current = { w: cr.width, h: cr.height };
      }
    });
    ro.observe(svg);
    return () => ro.disconnect();
  }, []);

  // Re-seed positions when the visible node set changes (so a new
  // extraction doesn't dump new nodes on top of the old layout).
  useEffect(() => {
    if (view.nodes.length === 0) {
      positionsRef.current = new Map();
      return;
    }
    const { w, h } = sizeRef.current;
    const cx = w / 2;
    const cy = h / 2;
    const r = Math.min(w, h) * 0.35;
    const next = new Map<string, { x: number; y: number; vx: number; vy: number }>();
    view.nodes.forEach((n, i) => {
      const angle = (i / Math.max(1, view.nodes.length)) * Math.PI * 2;
      const existing = positionsRef.current.get(n.id);
      next.set(n.id, existing ?? {
        x: cx + Math.cos(angle) * r,
        y: cy + Math.sin(angle) * r,
        vx: 0,
        vy: 0,
      });
    });
    positionsRef.current = next;
    setTick((t) => t + 1);
  }, [view.nodes.length === 0 ? 0 : view.nodes[0]?.id, kindFilter, view.nodes]);

  // Physics loop. Runs until the total kinetic energy falls under the
  // settle threshold OR MAX_FRAMES frames have elapsed (whichever first).
  useEffect(() => {
    let frame = 0;
    const MAX_FRAMES = 240;
    const REPULSION = 3200;
    const SPRING = 0.04;
    const DAMP = 0.82;
    const CENTER_PULL = 0.012;
    const SETTLE = 0.05;
    const EDGE_DISTANCE = 110;
    let raf = 0;

    function step() {
      frame++;
      const positions = positionsRef.current;
      const { w, h } = sizeRef.current;
      if (positions.size === 0) {
        setTick((t) => t + 1);
        return;
      }
      // Reset accelerations.
      const acc = new Map<string, { ax: number; ay: number }>();
      for (const id of positions.keys()) {
        acc.set(id, { ax: 0, ay: 0 });
      }
      // Repulsive Coulomb-like force (O(n²) — fine at our scale of a
      // few hundred nodes).
      const list = [...positions.entries()];
      for (let i = 0; i < list.length; i++) {
        const [ai, pa] = list[i]!;
        for (let j = i + 1; j < list.length; j++) {
          const [bi, pb] = list[j]!;
          const dx = pa.x - pb.x;
          const dy = pa.y - pb.y;
          const distSq = dx * dx + dy * dy + 0.01;
          const force = REPULSION / distSq;
          const dist = Math.sqrt(distSq);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          const a = acc.get(ai)!;
          const b = acc.get(bi)!;
          a.ax += fx;
          a.ay += fy;
          b.ax -= fx;
          b.ay -= fy;
        }
      }
      // Spring forces along edges.
      for (const e of view.edges) {
        const a = positions.get(e.from_entity_id);
        const b = positions.get(e.to_entity_id);
        if (!a || !b) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const target = EDGE_DISTANCE * (1 / Math.max(0.6, e.weight));
        const force = SPRING * (dist - target);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        const aa = acc.get(e.from_entity_id)!;
        const bb = acc.get(e.to_entity_id)!;
        aa.ax += fx;
        aa.ay += fy;
        bb.ax -= fx;
        bb.ay -= fy;
      }
      // Center pull so disconnected nodes don't drift away forever.
      for (const [id, p] of positions.entries()) {
        const a = acc.get(id)!;
        a.ax += (w / 2 - p.x) * CENTER_PULL;
        a.ay += (h / 2 - p.y) * CENTER_PULL;
      }
      // Integrate.
      let energy = 0;
      for (const [id, p] of positions.entries()) {
        const a = acc.get(id)!;
        p.vx = (p.vx + a.ax) * DAMP;
        p.vy = (p.vy + a.ay) * DAMP;
        p.x += p.vx;
        p.y += p.vy;
        // Keep inside the box.
        const m = 18;
        if (p.x < m) p.x = m;
        if (p.y < m) p.y = m;
        if (p.x > w - m) p.x = w - m;
        if (p.y > h - m) p.y = h - m;
        energy += Math.abs(p.vx) + Math.abs(p.vy);
      }
      setTick((t) => t + 1);
      if (frame < MAX_FRAMES && energy > SETTLE * list.length) {
        raf = requestAnimationFrame(step);
      }
    }
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [view.edges, view.nodes.length]);

  const positioned = useMemo<PositionedNode[]>(() => {
    return view.nodes.map((n) => {
      const p = positionsRef.current.get(n.id);
      return {
        ...n,
        x: p?.x ?? 0,
        y: p?.y ?? 0,
        vx: p?.vx ?? 0,
        vy: p?.vy ?? 0,
        degree: view.degreeMap.get(n.id) ?? 0,
      };
    });
  }, [view.nodes, view.degreeMap, tick]);

  async function runExtract() {
    setExtracting(true);
    try {
      const payload: Record<string, unknown> = {};
      if (extractMessageId.trim()) payload.message_id = extractMessageId.trim();
      else if (extractText.trim()) payload.text = extractText.trim();
      else {
        addToast({ id: "kg-extract-empty", title: "Need a message id or text", tone: "warning", duration: 2200 });
        return;
      }
      const r = await apiPost<{ ok: boolean; inserted_entities: number; inserted_relations: number }>(
        "/kg/extract",
        payload,
      );
      addToast({
        id: "kg-extract-ok",
        title: "Extracted",
        description: `${r.inserted_entities} entities, ${r.inserted_relations} relations`,
        tone: "info",
        duration: 2500,
      });
      // Refresh graph.
      const fresh = await apiGet<{ nodes: KGNode[]; edges: KGEdge[] }>("/kg/graph");
      setNodes(fresh.nodes ?? []);
      setEdges(fresh.edges ?? []);
      setExtractOpen(false);
      setExtractText("");
      setExtractMessageId("");
    } catch (err) {
      addToast({
        id: "kg-extract-err",
        title: "Extraction failed",
        description: (err as Error).message,
        tone: "warning",
        duration: 3000,
      });
    } finally {
      setExtracting(false);
    }
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: nodes?.length ?? 0 };
    for (const n of viewNodes) c[n.kind] = (c[n.kind] ?? 0) + 1;
    return c;
  }, [viewNodes, nodes?.length]);

  return (
    <div className="p-6 md:p-8 max-w-[1400px] mx-auto">
      <header className="flex flex-col md:flex-row md:items-end gap-3 mb-5">
        <div className="flex-1 min-w-0">
          <div className="mono-caps text-[11px] text-textFaint">WORKSPACE / KNOWLEDGE GRAPH</div>
          <h1 className="font-display text-[28px] font-semibold tracking-tight text-text">
            Knowledge Graph
          </h1>
          <p className="mt-1 text-[13px] text-textMuted max-w-[640px]">
            Entities + relationships extracted from your conversations.
            Click a node to inspect its relationships. Try "Extract from selection".
          </p>
        </div>
        <Button variant="primary" onClick={() => setExtractOpen(true)}>
          Extract from selection
        </Button>
      </header>

      <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-4">
        {/* Sidebar */}
        <aside className="bg-panel border border-border p-3 self-start space-y-3 lg:sticky lg:top-3">
          <section>
            <h3 className="mono-caps text-[10px] text-textFaint mb-2">Filter by kind</h3>
            <div className="flex flex-col gap-1">
              {KIND_ORDER.map((k) => {
                const active = k === kindFilter;
                return (
                  <button
                    key={k}
                    onClick={() => setKindFilter(k)}
                    className={cn(
                      "flex items-center justify-between text-left px-2 h-7 mono-caps text-[10px] tracking-wider border",
                      active
                        ? "border-brass text-brass bg-brass/10"
                        : "border-borderSoft text-textMuted hover:text-text hover:border-border",
                    )}
                    aria-pressed={active}
                  >
                    <span className="inline-flex items-center gap-2">
                      <span
                        className="w-2 h-2 rounded-full"
                        style={{ backgroundColor: KIND_FILL[k] ?? "var(--textFaint)" }}
                      />
                      {k}
                    </span>
                    <span className="text-textFaint">{counts[k] ?? 0}</span>
                  </button>
                );
              })}
            </div>
          </section>
          <section>
            <h3 className="mono-caps text-[10px] text-textFaint mb-2">Legend</h3>
            <ul className="space-y-1 text-[12px] text-textMuted">
              {(["person", "project", "topic", "file", "concept"] as const).map((k) => (
                <li key={k} className="inline-flex items-center gap-2 w-full">
                  <span
                    className="w-2.5 h-2.5 rounded-full"
                    style={{ backgroundColor: KIND_FILL[k] }}
                  />
                  <span>{k}</span>
                </li>
              ))}
            </ul>
          </section>
        </aside>

        {/* Canvas */}
        <div className="bg-panel border border-border h-[520px] relative overflow-hidden">
          {isLoading ? (
            <div className="h-full p-6 space-y-3" aria-busy="true">
              <Skeleton variant="text" width="40%" />
              <Skeleton variant="block" height={120} />
              <Skeleton variant="block" height={120} />
              <Skeleton variant="block" height={120} />
            </div>
          ) : view.nodes.length === 0 ? (
            <div className="h-full flex items-center justify-center">
              <EmptyState
                title="No entities yet"
                description="Run an extraction from a chat message or paste in text to seed the graph."
              />
            </div>
          ) : (
            <svg ref={svgRef} className="w-full h-full" role="img" aria-label="Knowledge graph">
              <defs>
                <marker
                  id="kg-arrow"
                  viewBox="0 0 10 10"
                  refX="10"
                  refY="5"
                  markerWidth="5"
                  markerHeight="5"
                  orient="auto-start-reverse"
                >
                  <path d="M0 0 L10 5 L0 10 Z" fill="var(--border)" />
                </marker>
              </defs>

              {/* Edges first so they sit under the nodes. */}
              <g>
                {view.edges.map((e) => {
                  const from = positionsRef.current.get(e.from_entity_id);
                  const to = positionsRef.current.get(e.to_entity_id);
                  if (!from || !to) return null;
                  return (
                    <g key={e.id}>
                      <line
                        x1={from.x}
                        y1={from.y}
                        x2={to.x}
                        y2={to.y}
                        stroke="var(--border)"
                        strokeOpacity={Math.max(0.25, Math.min(0.85, e.weight))}
                        strokeWidth={1 + e.weight * 1.5}
                        markerEnd="url(#kg-arrow)"
                      />
                      <text
                        x={(from.x + to.x) / 2}
                        y={(from.y + to.y) / 2 - 4}
                        textAnchor="middle"
                        fontSize="9"
                        fill="var(--textFaint)"
                        className="mono-caps"
                      >
                        {e.relation.slice(0, 24)}
                      </text>
                    </g>
                  );
                })}
              </g>

              {/* Nodes */}
              <g>
                {positioned.map((n) => {
                  const r = 8 + Math.min(8, n.degree);
                  return (
                    <g
                      key={n.id}
                      transform={`translate(${n.x}, ${n.y})`}
                      onClick={() => setActiveNodeId(n.id)}
                      style={{ cursor: "pointer" }}
                    >
                      <circle r={r} fill={KIND_FILL[n.kind] ?? "var(--textFaint)"} fillOpacity={0.85} />
                      <circle r={r + 3} fill="none" stroke={KIND_STROKE[n.kind] ?? "var(--border)"} strokeOpacity={0.35} />
                      <text
                        x={r + 6}
                        y={4}
                        fontSize="11"
                        fill="var(--text)"
                        className="select-none"
                      >
                        {n.name.length > 28 ? n.name.slice(0, 26) + "…" : n.name}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
          )}
        </div>
      </div>

      {/* Node detail sheet */}
      <SideSheet
        open={!!activeNodeId}
        onClose={() => setActiveNodeId(null)}
        title={activeNodeName(nodes, activeNodeId)}
        description="Relationships · recent messages"
        widthClass="w-[440px] max-w-[90vw]"
      >
        {activeNodeId && <NodeDetailBody nodeId={activeNodeId} />}
      </SideSheet>

      {/* Extract modal */}
      <SideSheet
        open={extractOpen}
        onClose={() => setExtractOpen(false)}
        title="Extract from selection"
        description="Use a message id or paste text. We'll run a small LLM call and insert any entities + relations we can identify."
        widthClass="w-[480px] max-w-[90vw]"
      >
        <div className="p-4 space-y-3">
          <Input
            placeholder="Message id (UUID, optional)"
            value={extractMessageId}
            onChange={(e) => setExtractMessageId(e.target.value)}
          />
          <textarea
            value={extractText}
            onChange={(e) => setExtractText(e.target.value)}
            rows={6}
            placeholder="…or paste raw text here"
            className="w-full bg-bg border border-border text-text px-3 py-2 font-mono text-[12px] resize-none focus:border-brass"
          />
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setExtractOpen(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={runExtract} disabled={extracting}>
              {extracting ? "Extracting…" : "Extract"}
            </Button>
          </div>
        </div>
      </SideSheet>
    </div>
  );
}

function activeNodeName(nodes: KGNode[] | null, id: string | null): string {
  if (!id) return "Node";
  if (!nodes) return "Node";
  const n = nodes.find((x) => x.id === id);
  return n?.name ?? "Unknown node";
}

function NodeDetailBody({ nodeId }: { nodeId: string }) {
  const [data, setData] = useState<{
    entity: { id: string; name: string; kind: string };
    relationships: Array<{
      id: string;
      from_entity_id: string;
      to_entity_id: string;
      relation: string;
      weight: number;
      from_name: string;
      to_name: string;
    }>;
    recent_messages: Array<{ id: string; role: string; content: string; created_at: string }>;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    apiGet<typeof data>(`/kg/entities/${nodeId}`)
      .then((r) => {
        if (!cancelled) setData(r);
      })
      .catch(() => {
        if (!cancelled) setData(null);
      });
    return () => {
      cancelled = true;
    };
  }, [nodeId]);
  if (!data) return <div className="p-6 text-textMuted text-[12px]">Loading…</div>;
  const { entity, relationships, recent_messages } = data;
  return (
    <div className="p-4 space-y-4 text-[13px]">
      <section>
        <div className="flex items-center gap-2 mb-2">
          <span
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: KIND_FILL[entity.kind] ?? "var(--textFaint)" }}
          />
          <span className="mono-caps text-[10px] text-textFaint">{entity.kind}</span>
        </div>
        <h3 className="font-display text-[18px] text-text">{entity.name}</h3>
      </section>

      <section>
        <h4 className="mono-caps text-[11px] text-textFaint mb-2">Relationships ({relationships.length})</h4>
        {relationships.length === 0 && (
          <p className="text-[12px] text-textMuted">No relationships recorded yet.</p>
        )}
        <ul className="space-y-1.5">
          {relationships.map((r) => {
            const otherId = r.from_entity_id === entity.id ? r.to_entity_id : r.from_entity_id;
            const other = r.from_entity_id === entity.id ? r.to_name : r.from_name;
            return (
              <li
                key={r.id}
                className="bg-panelAlt border border-borderSoft px-2 py-1.5 text-[12px] flex items-center justify-between"
              >
                <span className="text-text truncate">{other}</span>
                <span className="mono-caps text-[10px] text-textFaint">{r.relation}</span>
                <span className="hidden">{otherId}</span>
              </li>
            );
          })}
        </ul>
      </section>

      <section>
        <h4 className="mono-caps text-[11px] text-textFaint mb-2">Recent messages</h4>
        {recent_messages.length === 0 && (
          <p className="text-[12px] text-textMuted">No recent messages mention this entity.</p>
        )}
        <ul className="space-y-1.5">
          {recent_messages.map((m) => (
            <li key={m.id} className="bg-panelAlt border border-borderSoft px-2 py-1.5">
              <div className="text-[12px] text-textMuted line-clamp-3">{m.content}</div>
              <div className="mt-1 mono-caps text-[9px] text-textFaint">
                {m.role} · {new Date(m.created_at).toLocaleString()}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
