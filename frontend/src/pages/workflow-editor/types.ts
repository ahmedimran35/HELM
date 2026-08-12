// Workflow editor — shared type definitions.
// Mirror of the backend schema (backend/src/lib/workflow-runner.ts) so the
// React tree never has to import server-side types directly.

export type NodeKind =
  | "trigger"
  | "agent_run"
  | "panel_message"
  | "http_post"
  | "condition"
  | "delay";

export type PredicateOp =
  | "eq"
  | "neq"
  | "gt"
  | "lt"
  | "contains"
  | "exists";

export interface WorkflowNode {
  id: string;
  kind: NodeKind;
  label?: string;
  /** Node origin in SVG world coordinates. */
  x: number;
  y: number;
  /** Free-form per-kind config (prompt, message, url, path, seconds, …). */
  config?: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  condition?: { op: PredicateOp; path: string; value?: unknown } | null;
  label?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface NodeLogEntry {
  node_id: string;
  kind: NodeKind;
  started_at: string;
  finished_at: string;
  status: "ok" | "error" | "skipped";
  output?: unknown;
  error?: string;
}

export interface WorkflowRun {
  id: string;
  status: "running" | "completed" | "failed" | "paused";
  started_at: string;
  finished_at: string | null;
  result: { log?: NodeLogEntry[]; outputs?: Record<string, unknown> } | null;
  error: string | null;
  duration_ms?: number;
}

/** Payload returned by GET /api/workflows/:id. Mirrors backend WorkflowRow. */
export interface Workflow {
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

/** A draft of an edge that the user is currently drawing. */
export interface PendingEdge {
  fromId: string;
  /** Current cursor position in SVG world coordinates. */
  x: number;
  y: number;
}

export type RunIndicatorStatus = "idle" | "running" | "ok" | "error" | "skipped";

/** Mirrors /api/models — the AI providers + their assigned models. */
export interface Model {
  id: string;
  provider_id: string;
  provider_type: string;
  provider_base_url: string;
  external_id: string;
  display_name: string;
  context_window: number | null;
  assigned: boolean;
  pending_request: boolean;
}
