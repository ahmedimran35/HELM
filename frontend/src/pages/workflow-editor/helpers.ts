// Workflow editor — pure helpers. No React, no DOM, no side effects.
// Imported by Canvas, NodeView, MiniMap, and the editor page itself.

import { NODE_H, NODE_KIND_META, NODE_W } from "./constants";
import type { PendingEdge, WorkflowEdge, WorkflowNode } from "./types";

/** Quick random ID generator for newly created nodes / edges. */
export function nid(): string {
  return "n" + Math.random().toString(36).slice(2, 9);
}
export function eid(): string {
  return "e" + Math.random().toString(36).slice(2, 9);
}

/** Bounding box for a node, taking its shape into account. */
export function nodeBounds(node: Pick<WorkflowNode, "kind">): { w: number; h: number } {
  const shape = NODE_KIND_META[node.kind].shape;
  if (shape === "diamond") return { w: 140, h: 90 };
  if (shape === "circle") return { w: 100, h: 100 };
  return { w: NODE_W, h: NODE_H };
}

export function nodeCenter(n: Pick<WorkflowNode, "kind" | "x" | "y">): { x: number; y: number } {
  const b = nodeBounds(n);
  return { x: n.x + b.w / 2, y: n.y + b.h / 2 };
}

export function nodePortOut(n: Pick<WorkflowNode, "kind" | "x" | "y">): { x: number; y: number } {
  const c = nodeCenter(n);
  return { x: c.x, y: c.y + nodeBounds(n).h / 2 };
}

export function nodePortIn(n: Pick<WorkflowNode, "kind" | "x" | "y">): { x: number; y: number } {
  const c = nodeCenter(n);
  return { x: c.x, y: c.y - nodeBounds(n).h / 2 };
}

/** Snap a coordinate value to the GRID step. */
export function snap(value: number, grid: number): number {
  return Math.round(value / grid) * grid;
}

/** Snap a node's position to the grid. */
export function snapNode<T extends Pick<WorkflowNode, "x" | "y">>(
  node: T,
  grid: number,
): T {
  return { ...node, x: snap(node.x, grid), y: snap(node.y, grid) };
}

/** World bounds covering every node (defaults to (0,0) → (CANVAS_W,CANVAS_H) when empty). */
export function graphBounds(
  nodes: ReadonlyArray<Pick<WorkflowNode, "kind" | "x" | "y">>,
  fallbackW: number,
  fallbackH: number,
): { minX: number; minY: number; maxX: number; maxY: number } {
  if (nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: fallbackW, maxY: fallbackH };
  }
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const n of nodes) {
    const b = nodeBounds(n);
    if (n.x < minX) minX = n.x;
    if (n.y < minY) minY = n.y;
    if (n.x + b.w > maxX) maxX = n.x + b.w;
    if (n.y + b.h > maxY) maxY = n.y + b.h;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Convert a screen-space point (clientX/Y) to SVG world coordinates.
 * Mirrors the math used inside Canvas's `svgPoint` helper.
 */
export function screenToWorld(
  clientX: number,
  clientY: number,
  rect: { left: number; top: number },
  view: { x: number; y: number; scale: number },
): { x: number; y: number } {
  return {
    x: (clientX - rect.left - view.x) / view.scale,
    y: (clientY - rect.top - view.y) / view.scale,
  };
}

/** Build a cubic-bezier path string between two ports (the standard "S-curve" we use everywhere). */
export function edgePath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const dy = to.y - from.y;
  const cp1y = from.y + Math.max(40, dy * 0.45);
  const cp2y = to.y - Math.max(40, dy * 0.45);
  return `M ${from.x} ${from.y} C ${from.x} ${cp1y}, ${to.x} ${cp2y}, ${to.x} ${to.y}`;
}

/** Build a pending-edge preview path (mouse still dragging from a port). */
export function pendingEdgePath(p: PendingEdge, from: { x: number; y: number }): string {
  const dy = p.y - from.y;
  const cp1y = from.y + Math.max(40, dy * 0.45);
  const cp2y = p.y - Math.max(40, dy * 0.45);
  return `M ${from.x} ${from.y} C ${from.x} ${cp1y}, ${p.x} ${cp2y}, ${p.x} ${p.y}`;
}

/** Short preview text shown in a node card body (what the user has configured so far). */
export function nodeBodyPreview(node: WorkflowNode): string {
  const cfg = (node.config ?? {}) as Record<string, unknown>;
  switch (node.kind) {
    case "agent_run":
      return (cfg.prompt as string) ?? "";
    case "panel_message":
      return (cfg.message as string) ?? "";
    case "http_post":
      return `${(cfg.method as string) ?? "POST"} ${(cfg.url as string) ?? ""}`;
    case "delay":
      return `${(cfg.seconds as number) ?? 5}s wait`;
    case "condition":
      return (cfg.path as string) ?? "";
    default:
      return "";
  }
}

/** Auto-suggest the next id for an edge, given existing edges (for tests/dev). */
export function findEdge(
  edges: ReadonlyArray<WorkflowEdge>,
  source: string,
  target: string,
): WorkflowEdge | undefined {
  return edges.find((e) => e.source === source && e.target === target);
}
