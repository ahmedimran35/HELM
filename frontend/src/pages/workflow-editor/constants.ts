// Workflow editor — visual constants & per-kind metadata.

import type { NodeKind, PredicateOp } from "./types";

// Canvas geometry.
export const NODE_W = 260; // Action card width.
export const NODE_H = 96;  // Action card height.
export const PORT_R = 6;   // Edge-port radius (output/input sockets).
export const GRID = 24;    // Snap-to-grid step. Dot grid step matches.
export const CANVAS_W = 3000; // Virtual world width (the mini-map clamps to nodes, so this is just a fallback).
export const CANVAS_H = 2000;

export const MIN_SCALE = 0.3;
export const MAX_SCALE = 2.5;

// Truncation limits shown inside an action-card node body.
export const MAX_LABEL = 24;
export const MAX_PREVIEW = 28;

// Side-panel widths (the inspector SideSheet and the palette rail).
export const PALETTE_WIDTH_PX = 240;
export const INSPECTOR_WIDTH_PX = 380;

// Mini-map default size in CSS pixels.
export const MINIMAP_W = 180;
export const MINIMAP_H = 120;
export const MINIMAP_PADDING = 12;

export interface NodeKindMeta {
  label: string;
  category: "trigger" | "action" | "logic";
  description: string;
  color: string;
  icon: string;
  shape: "circle" | "rect" | "diamond";
}

export const NODE_KIND_META: Record<NodeKind, NodeKindMeta> = {
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

export const PALETTE_CATEGORIES: Array<{
  name: string;
  kinds: NodeKind[];
}> = [
  { name: "Trigger", kinds: ["trigger"] },
  { name: "Actions", kinds: ["agent_run", "panel_message", "http_post"] },
  { name: "Logic", kinds: ["condition", "delay"] },
];

// Ordered list of all kinds, for empty-state quick-start chips and the
// validation API on the backend. Order matches PALETTE_CATEGORIES.
export const ALL_NODE_KINDS: NodeKind[] = [
  "trigger",
  "agent_run",
  "panel_message",
  "http_post",
  "condition",
  "delay",
];

export const PREDICATE_OPS: { value: PredicateOp; label: string }[] = [
  { value: "eq", label: "==" },
  { value: "neq", label: "!=" },
  { value: "gt", label: ">" },
  { value: "lt", label: "<" },
  { value: "contains", label: "contains" },
  { value: "exists", label: "exists" },
];
