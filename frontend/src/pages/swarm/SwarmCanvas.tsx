// Swarm Lab — force-directed live visualization.
//
// Physics constants lifted from the deleted KnowledgeGraph page
// (verified recoverable via `git show 8c05b5a`): REPULSION 3200,
// SPRING 0.04, DAMP 0.82, 240-frame settle cap. Positions live in a
// ref (no re-render per tick); the canvas repaints via rAF while
// "hot". Theme hex tokens come from useSvgTheme() (SVG attributes
// can't inherit CSS variables).

import {
  useEffect,
  useMemo,
  useRef,
  type FC,
} from "react";
import { useSvgTheme } from "../workflow-editor/svg-theme";
import type { AgentState, SwarmState } from "./useSwarmRun";

const REPULSION = 3200;
const SPRING = 0.04;
const EDGE_DISTANCE = 110;
const CENTER_PULL = 0.012;
const DAMP = 0.82;
const SETTLE = 0.05;
const FRAME_CAP = 240;

interface Props {
  state: SwarmState;
  phase: SwarmState["phase"];
}

interface Node {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
}

interface Particle {
  from: string;
  to: string;
  born: number;
}

export const SwarmCanvas: FC<Props> = ({ state, phase }) => {
  const t = useSvgTheme();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const nodesRef = useRef<Map<string, Node>>(new Map());
  const sizeRef = useRef({ w: 600, h: 400 });
  const particlesRef = useRef<Particle[]>([]);
  const frameRef = useRef(0);
  const rafRef = useRef<number | null>(null);
  const hotRef = useRef(false);

  const agentList = useMemo(
    () =>
      state.order
        .map((id) => state.agents[id])
        .filter((a): a is AgentState => a != null),
    [state.order, state.agents],
  );

  // Rank map: agent_id → 1-based leaderboard position by peer-score avg.
  // Recomputed when scores change; used for the crown badge on nodes.
  const rankById = useMemo(() => {
    const scored = agentList
      .filter((a) => a.avgScore != null)
      .sort((x, y) => (y.avgScore ?? 0) - (x.avgScore ?? 0));
    const m = new Map<string, number>();
    scored.forEach((a, i) => m.set(a.model_id, i + 1));
    return m;
  }, [agentList]);

  const reducedMotion = useMemo(
    () =>
      typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches,
    [],
  );

  // ResizeObserver → keep the canvas sized to the wrap.
  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => {
      const rect = wrap.getBoundingClientRect();
      sizeRef.current = { w: rect.width, h: rect.height };
    });
    ro.observe(wrap);
    return () => ro.disconnect();
  }, []);

  // Ensure a node exists per id, placed on a circle.
  const ensureNode = (id: string) => {
    let n = nodesRef.current.get(id);
    if (n) return n;
    const { w, h } = sizeRef.current;
    const count = nodesRef.current.size;
    const angle = (count / Math.max(1, agentList.length + 1)) * Math.PI * 2;
    n = {
      id,
      x: w / 2 + Math.cos(angle) * 120,
      y: h / 2 + Math.sin(angle) * 120,
      vx: 0,
      vy: 0,
    };
    nodesRef.current.set(id, n);
    return n;
  };

  // ── physics tick ────────────────────────────────────────────────────
  const tick = () => {
    const nodes = [...nodesRef.current.values()];
    const { w, h } = sizeRef.current;
    const cx = w / 2;
    const cy = h / 2;

    // Repulsion (all pairs).
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i]!;
        const b = nodes[j]!;
        let dx = b.x - a.x;
        let dy = b.y - a.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) {
          dx = Math.random() - 0.5;
          dy = Math.random() - 0.5;
          d2 = 1;
        }
        const d = Math.sqrt(d2);
        const f = REPULSION / d2;
        const fx = (dx / d) * f;
        const fy = (dy / d) * f;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }

    // Springs along edges.
    const edges: [Node, Node][] = [];
    const q = nodesRef.current.get("__question");
    if (q) {
      for (const a of agentList) {
        const n = nodesRef.current.get(a.model_id);
        if (n) edges.push([q, n]);
      }
      const synth = nodesRef.current.get("__synth");
      if (synth) edges.push([q, synth]);
    }
    for (const [a, b] of edges) {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.sqrt(dx * dx + dy * dy) || 1;
      const f = (SPRING * (d - EDGE_DISTANCE)) / d;
      a.vx += dx * f;
      a.vy += dy * f;
      b.vx -= dx * f;
      b.vy -= dy * f;
    }

    let maxV = 0;
    for (const n of nodes) {
      // Center pull.
      n.vx += (cx - n.x) * CENTER_PULL;
      n.vy += (cy - n.y) * CENTER_PULL;
      n.vx *= DAMP;
      n.vy *= DAMP;
      n.x += n.vx;
      n.y += n.vy;
      maxV = Math.max(maxV, Math.abs(n.vx) + Math.abs(n.vy));
    }
    return maxV < SETTLE;
  };

  const repaint = () => {
    const svg = svgRef.current;
    if (!svg) return;
    const q = nodesRef.current.get("__question");
    const synth = nodesRef.current.get("__synth");

    // Edges: question → agent, thickening per round.
    let edges = "";
    if (q) {
      for (const a of agentList) {
        const n = nodesRef.current.get(a.model_id);
        if (!n) continue;
        const stroke =
          a.status === "error"
            ? t.rust
            : a.status === "answered"
              ? t.teal
              : t.border;
        const width = Math.min(4, 1 + state.round * 0.5);
        edges += `<line x1="${q.x}" y1="${q.y}" x2="${n.x}" y2="${n.y}" stroke="${stroke}" stroke-width="${width}" stroke-opacity="0.6" />`;
      }
      if (synth) {
        edges += `<line x1="${q.x}" y1="${q.y}" x2="${synth.x}" y2="${synth.y}" stroke="${t.brass}" stroke-width="3" stroke-opacity="0.8" />`;
      }
    }

    // Debate edges during scoring: agent ↔ agent.
    if (phase === "score" || phase === "consensus") {
      const list = agentList.filter((a) => a.status === "answered");
      for (let i = 0; i < list.length; i++) {
        for (let j = i + 1; j < list.length; j++) {
          const a = nodesRef.current.get(list[i]!.model_id);
          const b = nodesRef.current.get(list[j]!.model_id);
          if (!a || !b) continue;
          edges += `<line x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}" stroke="${t.brassSoft}" stroke-width="1" stroke-opacity="0.5" stroke-dasharray="3 4" />`;
        }
      }
    }

    // Particles (agent → synth at the end).
    let parts = "";
    const now = Date.now();
    particlesRef.current = particlesRef.current.filter((p) => now - p.born < 1600);
    for (const p of particlesRef.current) {
      const a = nodesRef.current.get(p.from);
      const b = nodesRef.current.get(p.to);
      if (!a || !b) continue;
      const k = (now - p.born) / 1600;
      const x = a.x + (b.x - a.x) * k;
      const y = a.y + (b.y - a.y) * k;
      parts += `<circle cx="${x}" cy="${y}" r="2.5" fill="${t.brass}" fill-opacity="${(1 - k).toFixed(2)}" />`;
    }

    // Nodes.
    let nodesSvg = "";
    if (q) {
      nodesSvg += `<g><circle cx="${q.x}" cy="${q.y}" r="26" fill="${t.panelAlt}" stroke="${t.brass}" stroke-width="2" /><text x="${q.x}" y="${q.y + 4}" text-anchor="middle" fill="${t.text}" font-size="10" font-weight="bold" font-family="ui-monospace, monospace">Q</text><text x="${q.x}" y="${q.y + 44}" text-anchor="middle" fill="${t.textMuted}" font-size="10">Question</text></g>`;
    }
    for (const a of agentList) {
      const n = nodesRef.current.get(a.model_id);
      if (!n) continue;
      const fill =
        a.status === "error"
          ? t.rustDark
          : a.status === "answered"
            ? t.tealDark
            : t.panelAlt;
      const ring =
        a.status === "error"
          ? t.rust
          : a.status === "answered"
            ? t.teal
            : a.status === "thinking"
              ? t.brass
              : t.border;
      const pulse =
        a.status === "thinking"
          ? `<animate attributeName="r" values="3;5;3" dur="1.1s" repeatCount="indefinite" />`
          : "";
      const scoreBadge =
        a.avgScore != null
          ? `<g><circle cx="${n.x + 16}" cy="${n.y - 16}" r="10" fill="${t.brass}" /><text x="${n.x + 16}" y="${n.y - 12.5}" text-anchor="middle" fill="${t.bg}" font-size="9" font-weight="bold">${a.avgScore.toFixed(1)}</text></g>`
          : "";
      // Crown: rank #1 wears the filled brass marker, others a muted ring.
      const rank = rankById.get(a.model_id);
      const rankBadge =
        rank != null
          ? `<g><circle cx="${n.x - 16}" cy="${n.y - 16}" r="9" fill="${rank === 1 ? t.brass : t.panelAlt}" stroke="${rank === 1 ? t.brass : t.border}" stroke-width="1.5" /><text x="${n.x - 16}" y="${n.y - 12.5}" text-anchor="middle" fill="${rank === 1 ? t.bg : t.textMuted}" font-size="9" font-weight="bold">${rank}</text></g>`
          : "";
      nodesSvg += `<g><circle cx="${n.x}" cy="${n.y}" r="16" fill="${fill}" stroke="${ring}" stroke-width="2" /><circle cx="${n.x}" cy="${n.y}" r="3" fill="${ring}">${pulse}</circle><text x="${n.x}" y="${n.y + 32}" text-anchor="middle" fill="${t.textMuted}" font-size="10">${escapeHtml(truncate(a.label, 18))}</text>${scoreBadge}${rankBadge}${a.status === "error" ? `<text x="${n.x}" y="${n.y + 46}" text-anchor="middle" fill="${t.rust}" font-size="9">failed</text>` : ""}</g>`;
    }
    if (synth) {
      nodesSvg += `<g><circle cx="${synth.x}" cy="${synth.y}" r="20" fill="${t.brass}" fill-opacity="0.15" stroke="${t.brass}" stroke-width="2" /><text x="${synth.x}" y="${synth.y + 4}" text-anchor="middle" fill="${t.brass}" font-size="9" font-family="ui-monospace, monospace">SYN</text><text x="${synth.x}" y="${synth.y + 36}" text-anchor="middle" fill="${t.textMuted}" font-size="10">Synthesis</text></g>`;
    }

    svg.innerHTML = `<g>${edges}${parts}${nodesSvg}</g>`;
  };

  const frame = () => {
    const settled = tick();
    repaint();
    frameRef.current++;
    if (frameRef.current < FRAME_CAP && !settled) {
      rafRef.current = requestAnimationFrame(frame);
    } else {
      hotRef.current = false;
    }
  };

  // Kick the simulation whenever topology or phase changes.
  useEffect(() => {
    ensureNode("__question");
    for (const a of agentList) ensureNode(a.model_id);
    if (state.status === "done" || phase === "synthesize") ensureNode("__synth");

    // Particles: answered agents stream to synth.
    if (phase === "synthesize" && !reducedMotion) {
      for (const a of agentList) {
        if (a.status === "answered") {
          particlesRef.current.push({
            from: a.model_id,
            to: "__synth",
            born: Date.now(),
          });
        }
      }
    }

    if (reducedMotion) {
      // Static pre-tick: settle positions without rAF, then paint once.
      for (let i = 0; i < 120; i++) tick();
      repaint();
      return;
    }

    if (hotRef.current) return; // already animating
    hotRef.current = true;
    frameRef.current = 0;
    rafRef.current = requestAnimationFrame(frame);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      hotRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.order.join(","), agentList.map((a) => a.status).join(","), phase, state.status]);

  // Repaint on theme change too.
  useEffect(() => {
    repaint();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [t]);

  // Keep repainting during streaming deltas (positions already settled;
  // the pulse animation is declarative SVG, but scores/badges change).
  useEffect(() => {
    if (!hotRef.current && !reducedMotion) {
      hotRef.current = true;
      frameRef.current = 0;
      rafRef.current = requestAnimationFrame(frame);
    } else if (reducedMotion) {
      repaint();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.scores.length, state.status]);

  useEffect(() => {
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  return (
    <div
      ref={wrapRef}
      className="relative w-full overflow-hidden rounded-xl border border-border bg-gradient-to-b from-panelAlt to-panel"
      style={{ height: 460 }}
    >
      <svg
        ref={svgRef}
        width="100%"
        height="100%"
        viewBox={`0 0 ${sizeRef.current.w} ${sizeRef.current.h}`}
        role="img"
        aria-label="Swarm visualization"
        className="block"
      />
      {state.status === "idle" && (
        <div className="absolute inset-0 grid place-items-center">
          <div className="text-center space-y-1.5">
            <p className="text-sm text-textMuted">
              The swarm will appear here.
            </p>
            <p className="text-xs text-textFaint">
              Pick 2–10 models above, ask a question, hit Run.
            </p>
          </div>
        </div>
      )}
      <div className="absolute bottom-3 right-3 flex items-center gap-3 rounded-md border border-border bg-panel/90 px-2.5 py-1.5 text-[10px] text-textMuted">
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-brass" aria-hidden />
          thinking
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-teal" aria-hidden />
          answered
        </span>
        <span className="flex items-center gap-1.5">
          <span className="inline-block h-2 w-2 rounded-full bg-rust" aria-hidden />
          failed
        </span>
      </div>
    </div>
  );
};

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function escapeHtml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
