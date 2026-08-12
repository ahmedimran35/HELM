// MiniMap — bottom-right overview of the canvas.
//
// Renders a scaled-down clone of every node + edge inside a small SVG,
// plus a translucent brass rectangle showing the current viewport.
// Click the background to recenter, drag the viewport rectangle to pan
// live, drag any node marker in the mini-map to teleport a node.
//
// Owns no state — it's a controlled component reading `view`, `dims`,
// `nodes`, and `edges`. Pan on the mini-map flows back through
// `onPan({ x, y })`. Node moves in the mini-map flow through `onMoveNode`.

import { useMemo, useRef, useState } from "react";
import { MINIMAP_H, MINIMAP_PADDING, MINIMAP_W } from "./constants";
import { graphBounds, nodeBounds } from "./helpers";
import type { WorkflowEdge, WorkflowNode } from "./types";

interface Props {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  view: { x: number; y: number; scale: number };
  dims: { w: number; h: number };
  onPan: (deltaX: number, deltaY: number) => void;
  onMoveNode?: (id: string, x: number, y: number) => void;
}

const PAD = 8; // Pixels of empty space inside the mini-map around the world bounds.

export function MiniMap({ nodes, edges, view, dims, onPan, onMoveNode }: Props) {
  const ref = useRef<SVGSVGElement | null>(null);
  const [draggingVp, setDraggingVp] = useState<{ startX: number; startY: number; origView: { x: number; y: number } } | null>(null);
  const [draggingNode, setDraggingNode] = useState<{ id: string; offX: number; offY: number } | null>(null);

  const bounds = useMemo(
    () => graphBounds(nodes, 1200, 800), // tighter fallback than the canvas's full virtual size
    [nodes],
  );

  const worldW = Math.max(1, bounds.maxX - bounds.minX);
  const worldH = Math.max(1, bounds.maxY - bounds.minY);
  const innerW = MINIMAP_W - PAD * 2;
  const innerH = MINIMAP_H - PAD * 2;
  const scale = Math.min(innerW / worldW, innerH / worldH);
  const offsetX = PAD + (innerW - worldW * scale) / 2 - bounds.minX * scale;
  const offsetY = PAD + (innerH - worldH * scale) / 2 - bounds.minY * scale;

  // Viewport rect in mini-map coords.
  // World-space top-left: (-view.x / scale, -view.y / scale)
  // World-space width/height: dims.w / scale, dims.h / scale
  const vpWorldX = -view.x / view.scale;
  const vpWorldY = -view.y / view.scale;
  const vpWorldW = dims.w / view.scale;
  const vpWorldH = dims.h / view.scale;
  const vpX = vpWorldX * scale + offsetX;
  const vpY = vpWorldY * scale + offsetY;
  const vpW = vpWorldW * scale;
  const vpH = vpWorldH * scale;

  function pointerToMini(clientX: number, clientY: number) {
    const svg = ref.current;
    if (!svg) return { x: 0, y: 0 };
    const r = svg.getBoundingClientRect();
    return { x: clientX - r.left, y: clientY - r.top };
  }

  function onBackgroundDown(e: React.MouseEvent) {
    if (!ref.current) return;
    const { x: mx, y: my } = pointerToMini(e.clientX, e.clientY);
    if (onPan) {
      // Center the viewport on the clicked mini-map point.
      // worldX = (mx - offsetX) / scale
      // We want viewport center to land at that world point, so:
      //   vpWorldCX = vpWorldX + vpWorldW / 2 = mxWorld
      //   vpWorldX_new = mxWorld - vpWorldW / 2
      //   view.x_new = -vpWorldX_new * view.scale
      const mxWorld = (mx - offsetX) / scale;
      const myWorld = (my - offsetY) / scale;
      const newVpX = mxWorld - vpWorldW / 2;
      const newVpY = myWorld - vpWorldH / 2;
      const newViewX = -newVpX * view.scale;
      const newViewY = -newVpY * view.scale;
      onPan(newViewX - view.x, newViewY - view.y);
    }
  }

  function onViewportPointerDown(e: React.MouseEvent) {
    e.stopPropagation();
    setDraggingVp({
      startX: e.clientX,
      startY: e.clientY,
      origView: { x: view.x, y: view.y },
    });
  }

  function onMiniNodePointerDown(e: React.MouseEvent, node: WorkflowNode) {
    if (!onMoveNode) return;
    e.stopPropagation();
    const svg = ref.current;
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const nodeMiniX = node.x * scale + offsetX;
    const nodeMiniY = node.y * scale + offsetY;
    setDraggingNode({
      id: node.id,
      offX: e.clientX - r.left - nodeMiniX,
      offY: e.clientY - r.top - nodeMiniY,
    });
  }

  function onMove(e: React.MouseEvent) {
    if (draggingVp) {
      const dx = e.clientX - draggingVp.startX;
      const dy = e.clientY - draggingVp.startY;
      // Convert CSS-pixel delta to world-pixel delta (then back to view offset).
      const worldDx = dx / scale;
      const worldDy = dy / scale;
      onPan(
        draggingVp.origView.x + worldDx * view.scale - view.x,
        draggingVp.origView.y + worldDy * view.scale - view.y,
      );
    } else if (draggingNode && ref.current && onMoveNode) {
      const r = ref.current.getBoundingClientRect();
      const mx = e.clientX - r.left - draggingNode.offX;
      const my = e.clientY - r.top - draggingNode.offY;
      const newX = (mx - offsetX) / scale;
      const newY = (my - offsetY) / scale;
      onMoveNode(draggingNode.id, newX, newY);
    }
  }

  function onUp() {
    setDraggingVp(null);
    setDraggingNode(null);
  }

  return (
    <div
      className="absolute pointer-events-auto"
      style={{
        bottom: MINIMAP_PADDING,
        right: MINIMAP_PADDING,
        width: MINIMAP_W,
        height: MINIMAP_H,
      }}
    >
      <svg
        ref={ref}
        width={MINIMAP_W}
        height={MINIMAP_H}
        onMouseDown={onBackgroundDown}
        onMouseMove={onMove}
        onMouseUp={onUp}
        onMouseLeave={onUp}
        className="block bg-[#0B0E12] border border-brass/60 shadow-2xl cursor-crosshair select-none"
      >
        {/* Crosshair at the world center, faint */}
        <line x1={MINIMAP_W / 2} y1={0} x2={MINIMAP_W / 2} y2={MINIMAP_H} stroke="#1D2229" strokeWidth={0.5} />
        <line x1={0} y1={MINIMAP_H / 2} x2={MINIMAP_W} y2={MINIMAP_H / 2} stroke="#1D2229" strokeWidth={0.5} />

        {/* Edges */}
        {edges.map((e) => {
          const src = nodes.find((n) => n.id === e.source);
          const dst = nodes.find((n) => n.id === e.target);
          if (!src || !dst) return null;
          const sx = (src.x + nodeBounds(src).w / 2) * scale + offsetX;
          const sy = (src.y + nodeBounds(src).h / 2) * scale + offsetY;
          const dx = (dst.x + nodeBounds(dst).w / 2) * scale + offsetX;
          const dy = (dst.y + nodeBounds(dst).h / 2) * scale + offsetY;
          return (
            <line
              key={e.id}
              x1={sx}
              y1={sy}
              x2={dx}
              y2={dy}
              stroke={e.condition ? "#b58a23" : "#4c9c90"}
              strokeWidth={1}
              opacity={0.5}
              strokeDasharray={e.condition ? "2 2" : undefined}
            />
          );
        })}

        {/* Nodes */}
        {nodes.map((n) => {
          const b = nodeBounds(n);
          return (
            <rect
              key={n.id}
              x={n.x * scale + offsetX}
              y={n.y * scale + offsetY}
              width={Math.max(3, b.w * scale)}
              height={Math.max(2, b.h * scale)}
              fill={n.kind === "trigger" ? "#C9A227" : "#4c9c90"}
              opacity={0.85}
              stroke="#0B0E12"
              strokeWidth={0.5}
              className="cursor-grab"
              onMouseDown={(e) => onMiniNodePointerDown(e, n)}
            />
          );
        })}

        {/* Viewport rectangle */}
        <rect
          x={vpX}
          y={vpY}
          width={Math.max(8, vpW)}
          height={Math.max(6, vpH)}
          fill="rgba(201,162,39,0.10)"
          stroke="#C9A227"
          strokeWidth={1}
          className="cursor-grab"
          onMouseDown={onViewportPointerDown}
        />
        {/* Resize-free viewport handle at center for affordance */}
        <line
          x1={vpX + vpW / 2 - 4}
          y1={vpY + vpH / 2}
          x2={vpX + vpW / 2 + 4}
          y2={vpY + vpH / 2}
          stroke="#C9A227"
          strokeWidth={1}
          pointerEvents="none"
        />
        <line
          x1={vpX + vpW / 2}
          y1={vpY + vpH / 2 - 4}
          x2={vpX + vpW / 2}
          y2={vpY + vpH / 2 + 4}
          stroke="#C9A227"
          strokeWidth={1}
          pointerEvents="none"
        />

        {/* Header label */}
        <text x={6} y={10} fontSize={8} fill="#8A7220" pointerEvents="none" letterSpacing="0.04em">
          MAP · {Math.round(view.scale * 100)}%
        </text>
      </svg>
    </div>
  );
}
