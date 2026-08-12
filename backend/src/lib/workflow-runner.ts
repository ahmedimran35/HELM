// Workflow Runner — topological executor for the visual workflow builder
// (Tier 2 / docs §P2).
//
// A workflow is a graph of nodes connected by edges. Each node has a
// `kind` (trigger, agent_run, panel_message, http_post, condition, delay)
// and a free-form `config` object describing its inputs. Edges carry a
// optional `condition` so a node can route its output to different
// successor nodes based on a predicate.
//
// Execution model:
//   1. Topologically sort `nodes` from `edges`. Cycles are an error.
//   2. Walk the sorted order. For each node, dispatch on `kind`.
//   3. Each node's `output` is stored in a per-run `outputs` map keyed
//      by node id. Successor nodes may read upstream outputs via
//      `{{node.<id>.<field>}}` template tokens.
//   4. Branching: every outgoing edge whose condition (or no condition)
//      matches the current node's output is followed. If a node has
//      `take_first` style behaviour, we follow the first matching edge.
//   5. Errors inside one node are caught and logged to the run row's
//      `error` column but do NOT abort sibling branches — we just skip
//      that node's outputs and continue with the next.
//
// Run lifecycle:
//   - insert workflow_runs(status='running', started_at=now())
//   - exec nodes
//   - update workflow_runs(status, finished_at, result, error)
//
// Scheduling of trigger='schedule' workflows is handled by the existing
// watch scheduler tick (we loop over it once per minute). This file
// only exposes the executor; the route layer + scheduler call it.

import { sql } from "../db/client.ts";
import { logAudit } from "./audit.ts";
import { getHarnessByKind } from "../harness/router.ts";
import { assertSafeOutboundUrl, safeFetch } from "./safe-fetch.ts";
import type { Predicate } from "./watches.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type NodeKind =
  | "trigger"
  | "agent_run"
  | "panel_message"
  | "http_post"
  | "condition"
  | "delay";

export const NODE_KINDS: readonly NodeKind[] = [
  "trigger",
  "agent_run",
  "panel_message",
  "http_post",
  "condition",
  "delay",
];

export interface WorkflowNode {
  id: string;
  kind: NodeKind;
  /** Human label used in the UI. Defaults to the kind. */
  label?: string;
  /** Canvas coordinates — not used for execution, but useful for log
   *  debugging and persistence. */
  x?: number;
  y?: number;
  config?: Record<string, unknown>;
}

export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  /** Optional predicate; when set, the edge is only followed when the
   *  source node's output satisfies the predicate. */
  condition?: Predicate | null;
  /** Optional label (e.g. "true" / "false") rendered on the edge. */
  label?: string;
}

export interface WorkflowGraph {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export interface WorkflowRow {
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
  last_run_at: Date | null;
  created_at: Date;
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

export interface RunResult {
  run_id: string;
  status: "running" | "completed" | "failed";
  /** Ultra-light log of executed nodes. */
  log: NodeLogEntry[];
  /** Final outputs keyed by node id. */
  outputs: Record<string, unknown>;
  error?: string;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/** Run a workflow end-to-end. Returns immediately with the run id; the
 *  actual execution happens in the background and writes back to the
 *  workflow_runs row when done. */
export async function runWorkflow(
  workflowId: string,
  opts: { reason?: string } = {},
): Promise<{ run_id: string; status: "running" }> {
  const w = await sql<WorkflowRow[]>`
    SELECT id, user_id, panel_id, name, description, graph, status,
           trigger, schedule, enabled, last_run_at, created_at
    FROM workflows
    WHERE id = ${workflowId}::uuid
    LIMIT 1
  `;
  const workflow = w[0];
  if (!workflow) throw new Error("workflow not found");
  return execute(workflow, opts);
}

/** Same as runWorkflow but takes a pre-loaded workflow row. Used by the
 *  scheduler tick where we don't want to re-fetch for every workflow. */
export async function execute(
  workflow: WorkflowRow,
  opts: { reason?: string } = {},
): Promise<{ run_id: string; status: "running" }> {
  const runRows = await sql<{ id: string }[]>`
    INSERT INTO workflow_runs (workflow_id, user_id, status)
    VALUES (${workflow.id}::uuid, ${workflow.user_id}::uuid, 'running')
    RETURNING id
  `;
  const runId = runRows[0]!.id;
  // Kick off the executor in the background. We never `await` it from
  // the request path so the HTTP response returns as soon as the run
  // row is committed.
  void executeBody(workflow, runId, opts).catch((err) => {
    console.warn("workflow execution failed:", (err as Error).message);
  });
  return { run_id: runId, status: "running" };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

interface ExecutionContext {
  workflow: WorkflowRow;
  runId: string;
  outputs: Record<string, unknown>;
  log: NodeLogEntry[];
  /** Edge map: source node id → outgoing edges. */
  outgoing: Map<string, WorkflowEdge[]>;
  /** Visited set, prevents infinite loops in malformed graphs. */
  visited: Set<string>;
}

async function executeBody(
  workflow: WorkflowRow,
  runId: string,
  opts: { reason?: string },
): Promise<void> {
  const graph = normaliseGraph(workflow.graph);
  const outgoing = buildOutgoingMap(graph.edges);
  const visited = new Set<string>();
  const ctx: ExecutionContext = {
    workflow,
    runId,
    outputs: {},
    log: [],
    outgoing,
    visited,
  };

  let status: "completed" | "failed" = "completed";
  let errorMessage: string | null = null;
  try {
    const order = topoSort(graph.nodes, graph.edges);
    if (order.length === 0) {
      // No nodes? That's a no-op success.
      return finishRun(runId, ctx, "completed", null);
    }
    // Find the entry point: the first trigger node; fall back to the
    // first node in topo order if there is no trigger.
    const entry = locateEntry(order, graph);
    if (!entry) {
      return finishRun(runId, ctx, "failed", "no usable entry node");
    }
    // Propagate the trigger's output downstream.
    await walk(entry, ctx);
  } catch (err) {
    status = "failed";
    errorMessage = (err as Error).message;
  } finally {
    await finishRun(runId, ctx, status, errorMessage);
    await sql`
      UPDATE workflows SET last_run_at = now() WHERE id = ${workflow.id}::uuid
    `;
    await logAudit({
      userId: workflow.user_id,
      target: workflow.id,
      action: "workflow_fired",
      metadata: {
        run_id: runId,
        reason: opts.reason ?? "manual",
        status,
        nodes: ctx.log.length,
      },
    });
  }
}

async function finishRun(
  runId: string,
  ctx: ExecutionContext,
  status: "completed" | "failed",
  error: string | null,
): Promise<void> {
  // Trim outputs to a sensible size so we don't blow up the jsonb column.
  const trimmed: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ctx.outputs)) {
    trimmed[k] = truncate(v, 4000);
  }
  await sql`
    UPDATE workflow_runs
    SET finished_at = now(),
        status = ${status},
        result = ${sql.json({ log: ctx.log, outputs: trimmed } as never)},
        error = ${error}
    WHERE id = ${runId}::uuid
  `;
}

// ---------------------------------------------------------------------------
// Walk — recursive descent through the graph
// ---------------------------------------------------------------------------

async function walk(nodeId: string, ctx: ExecutionContext): Promise<void> {
  if (ctx.visited.has(nodeId)) return;
  // Hard cap on total nodes executed so a runaway loop can't drain the
  // process. 200 is generous for any realistic workflow.
  if (ctx.log.length >= 200) {
    appendLog(ctx, nodeId, "skipped", undefined, "execution limit reached");
    return;
  }
  const node = findNode(ctx, nodeId);
  if (!node) {
    appendLog(ctx, nodeId, "skipped", undefined, "node not found");
    return;
  }
  ctx.visited.add(nodeId);

  const startedAt = new Date().toISOString();
  let output: unknown;
  let status: "ok" | "error" = "ok";
  let err: string | undefined;
  try {
    output = await dispatchNode(node, ctx);
    ctx.outputs[node.id] = output;
  } catch (e) {
    status = "error";
    err = (e as Error).message;
  }
  const finishedAt = new Date().toISOString();
  ctx.log.push({
    node_id: node.id,
    kind: node.kind,
    started_at: startedAt,
    finished_at: finishedAt,
    status,
    output: status === "ok" ? output : undefined,
    error: err,
  });

  // Follow outgoing edges. If a node has no outgoing edges, we're done.
  const edges = ctx.outgoing.get(nodeId) ?? [];
  if (edges.length === 0) return;
  // If the node errored, skip downstream — but only for that branch.
  if (status === "error") return;

  // Run every outgoing edge whose condition matches. Edges without a
  // condition are always followed. Conditional edges are skipped when
  // their predicate fails.
  for (const edge of edges) {
    if (edge.condition) {
      const matched = matchPredicate([edge.condition], {
        node: ctx.outputs[nodeId] ?? {},
      });
      if (!matched) continue;
    }
    await walk(edge.target, ctx);
  }
}

// ---------------------------------------------------------------------------
// Dispatch — kind → handler
// ---------------------------------------------------------------------------

async function dispatchNode(
  node: WorkflowNode,
  ctx: ExecutionContext,
): Promise<unknown> {
  switch (node.kind) {
    case "trigger":
      return trigger(node, ctx);
    case "agent_run":
      return agentRun(node, ctx);
    case "panel_message":
      return panelMessage(node, ctx);
    case "http_post":
      return httpPost(node, ctx);
    case "condition":
      return condition(node, ctx);
    case "delay":
      return delay(node, ctx);
    default:
      throw new Error(`unknown node kind: ${node.kind as string}`);
  }
}

async function trigger(node: WorkflowNode, ctx: ExecutionContext): Promise<unknown> {
  // A trigger node is just a marker; it emits a small "started" event
  // object so downstream nodes can read it via {{node.<id>.when}}.
  return {
    when: new Date().toISOString(),
    trigger: ctx.workflow.trigger ?? "manual",
    workflow: ctx.workflow.name,
  };
}

async function agentRun(node: WorkflowNode, ctx: ExecutionContext): Promise<unknown> {
  const cfg = node.config ?? {};
  const promptTpl = String(cfg.prompt ?? "").trim();
  if (!promptIsNonEmpty(promptTpl)) throw new Error("agent_run requires config.prompt");
  const prompt = renderTemplate(promptTpl, ctx);
  const modelId = typeof cfg.model_id === "string" && cfg.model_id.length > 0
    ? cfg.model_id
    : null;
  // Admin override (used by seeded sample workflows): admins may invoke
  // any active model without a model_access row. Everyone else MUST
  // have an explicit grant — otherwise a workflow persisted with an
  // admin-only model_id would still let a non-admin trigger the model
  // via the workflow runner after their grant is revoked.
  const isAdmin = ctx.workflow.user_id
    ? (await sql<{ role: string }[]>`
        SELECT role FROM users WHERE id = ${ctx.workflow.user_id}::uuid LIMIT 1
      `)[0]?.role === "admin"
    : false;
  let resolvedModelId = modelId;
  if (!resolvedModelId) {
    const fallback = await sql<{ id: string }[]>`
      SELECT m.id FROM model_access ma
      JOIN models m ON m.id = ma.model_id
      WHERE ma.user_id = ${ctx.workflow.user_id}::uuid AND m.state = 'active'
      ORDER BY ma.granted_at ASC LIMIT 1
    `;
    resolvedModelId = fallback[0]?.id ?? null;
  } else if (!isAdmin) {
    // Explicit model_id supplied — verify the user has access.
    const access = await sql<{ ok: number }[]>`
      SELECT EXISTS (
        SELECT 1 FROM model_access
        WHERE user_id = ${ctx.workflow.user_id}::uuid AND model_id = ${modelId}::uuid
      )::int AS ok
    `;
    if ((access[0]?.ok ?? 0) === 0) {
      throw new Error("agent_run: workflow owner is not authorized for the configured model_id");
    }
  }
  if (!resolvedModelId) {
    throw new Error("agent_run: no model_id and no user-assigned model");
  }
  const modelRows = await sql<{
    external_id: string;
    display_name: string;
    provider_id: string;
  }[]>`
    SELECT external_id, display_name, provider_id
    FROM models WHERE id = ${resolvedModelId}::uuid LIMIT 1
  `;
  const model = modelRows[0];
  if (!model) throw new Error("agent_run: model not found");
  const harness = getHarnessByKind("openai");
  let assembled = "";
  for await (const chunk of harness.chat({
    model: model.external_id,
    messages: [
      { role: "system", content: "You are HELM. Be concise." },
      { role: "user", content: prompt },
    ],
    maxTokens: 1024,
  })) {
    if (chunk.delta) assembled += chunk.delta;
    if (chunk.done) break;
  }
  // Persist the agent's reply into the user's 1:1 chat thread so it
  // shows up in their history.
  await sql`
    INSERT INTO messages (user_id, model_id, role, content, tokens)
    VALUES (${ctx.workflow.user_id}::uuid, ${resolvedModelId}::uuid,
            'assistant', ${assembled.slice(0, 4000)},
            ${Math.ceil(assembled.length / 4)})
  `;
  return { text: assembled, model: model.display_name };
}

async function panelMessage(node: WorkflowNode, ctx: ExecutionContext): Promise<unknown> {
  const cfg = node.config ?? {};
  const panelId = String(cfg.panel_id ?? "").trim();
  if (!panelId) throw new Error("panel_message requires config.panel_id");
  // Membership check — without this, a user with a workflow that uses
  // this node could post attacker-controlled text into any other user's
  // panel by guessing the UUID.
  const member = await sql<{ exists: number }[]>`
    SELECT EXISTS (
      SELECT 1 FROM panel_members
      WHERE panel_id = ${panelId}::uuid AND user_id = ${ctx.workflow.user_id}::uuid
    )::int AS exists
  `;
  if ((member[0]?.exists ?? 0) === 0) {
    throw new Error("panel_message: workflow owner is not a member of the target panel");
  }
  const role = cfg.role === "assistant" ? "assistant" : "user";
  const contentTpl = String(cfg.content ?? "");
  const content = renderTemplate(contentTpl, ctx);
  const rows = await sql<{ id: string }[]>`
    INSERT INTO messages (panel_id, user_id, role, content, tokens)
    VALUES (${panelId}::uuid, ${ctx.workflow.user_id}::uuid,
            ${role}, ${content}, 0)
    RETURNING id
  `;
  return { id: rows[0]!.id, panel_id: panelId, role, content };
}

async function httpPost(node: WorkflowNode, ctx: ExecutionContext): Promise<unknown> {
  const cfg = node.config ?? {};
  const url = String(cfg.url ?? "").trim();
  if (!url) throw new Error("http_post requires config.url");
  // SSRF guard — the URL is stored in the workflow's persisted config
  // (admin-or-self authored), but it still gets re-evaluated on every
  // run, so a workflow with an old local URL doesn't keep working after
  // a hostname rebind. Better to fail loudly than exfiltrate.
  await assertSafeOutboundUrl(url, { allowLocal: false });
  const body = renderTemplate(JSON.stringify(cfg.body ?? {}), ctx);
  const headers = isPlainObject(cfg.headers) ? cfg.headers as Record<string, string> : {};
  const timeoutMs = clampNumber(cfg.timeout_ms, 1000, 60_000, 15_000);
  // Use safeFetch with a 5 MB response cap so a malicious target can't
  // OOM the runner with a gigabyte response. safeFetch also disables
  // redirect-following (a 30x on a private IP would pivot past
  // assertSafeOutboundUrl).
  const res = await safeFetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body,
    signal: AbortSignal.timeout(timeoutMs),
    maxBytes: 5 * 1024 * 1024,
  });
  const text = await res.text().catch(() => "");
  return {
    status: res.status,
    ok: res.ok,
    body: text.slice(0, 4000),
  };
}

async function condition(node: WorkflowNode, ctx: ExecutionContext): Promise<unknown> {
  const cfg = node.config ?? {};
  const path = String(cfg.path ?? "").trim();
  const op = (typeof cfg.op === "string" ? cfg.op : "eq") as Predicate["op"];
  const expected = cfg.value;
  if (!path) throw new Error("condition requires config.path");
  // Resolve `path` against the union of upstream outputs. The path may
  // be either a dot-walk into the condition node's own previous output
  // (most common) — we just look at the condition node's own private
  // state. The user wires it explicitly via the prompt.
  const lhs = getByPath(ctx.outputs, path);
  const ok = matchPredicate([{ op, path, value: expected }], {
    node: lhs === undefined ? {} : (typeof lhs === "object" && lhs !== null ? lhs as Record<string, unknown> : { value: lhs }),
  });
  return { ok, path, op, expected, value: lhs };
}

async function delay(node: WorkflowNode, ctx: ExecutionContext): Promise<unknown> {
  const cfg = node.config ?? {};
  const seconds = clampNumber(cfg.seconds, 0, 3600, 5);
  await new Promise<void>((resolve) => setTimeout(resolve, seconds * 1000));
  return { slept: seconds };
}

// ---------------------------------------------------------------------------
// Templates — seed/clone the graph for built-in workflows
// ---------------------------------------------------------------------------

export interface WorkflowTemplate {
  slug: string;
  name: string;
  description: string;
  category: "ops" | "analytics" | "support" | "research";
  graph: WorkflowGraph;
  trigger: string;
  schedule: string | null;
}

export function builtinTemplates(): WorkflowTemplate[] {
  return [
    dailyStandup(),
    supportTriage(),
    weeklySummary(),
    onDemandResearch(),
    costWatchdog(),
  ];
}

function dailyStandup(): WorkflowTemplate {
  return {
    slug: "daily-standup",
    name: "Daily Standup",
    description: "Generate a standup summary and post it to your primary panel every weekday at 9am.",
    category: "ops",
    trigger: "schedule",
    schedule: "0 9 * * 1-5",
    graph: {
      nodes: [
        { id: "t1", kind: "trigger", label: "9am weekdays", x: 60, y: 80 },
        { id: "a1", kind: "agent_run", label: "Generate standup", x: 320, y: 80, config: {
          prompt: "Write a concise standup summary based on the most recent 24h of activity. Use three bullets: yesterday, today, blockers.",
        } },
        { id: "p1", kind: "panel_message", label: "Post to panel", x: 580, y: 80, config: {
          role: "assistant",
          content: "Here is your standup:\n\n{{node.a1.text}}",
        } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e2", source: "a1", target: "p1" },
      ],
    },
  };
}

function supportTriage(): WorkflowTemplate {
  return {
    slug: "support-triage",
    name: "Support Triage",
    description: "Hourly: scan unread messages, decide if anything looks urgent, and Slack if so.",
    category: "support",
    trigger: "schedule",
    schedule: "0 * * * *",
    graph: {
      nodes: [
        { id: "t1", kind: "trigger", label: "Hourly", x: 60, y: 80 },
        { id: "a1", kind: "agent_run", label: "Analyse unread", x: 320, y: 80, config: {
          prompt: "Look at recent unread messages. Decide if any are urgent. Return JSON like {\"urgent\": true|false, \"summary\": \"...\"}.",
        } },
        { id: "c1", kind: "condition", label: "Urgent?", x: 580, y: 80, config: {
          path: "node.urgent", op: "eq", value: true,
        } },
        { id: "h1", kind: "http_post", label: "Slack alert", x: 840, y: 40, config: {
          url: "https://hooks.slack.com/services/REPLACE/ME/ME",
          body: { text: "Urgent support message: {{node.a1.text}}" },
        } },
        { id: "p1", kind: "panel_message", label: "Log to panel", x: 840, y: 140, config: {
          role: "assistant",
          content: "Triage done. No urgent messages.",
        } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e2", source: "a1", target: "c1" },
        { id: "e3", source: "c1", target: "h1", label: "true", condition: { op: "eq", path: "node.ok", value: true } },
        { id: "e4", source: "c1", target: "p1", label: "false", condition: { op: "eq", path: "node.ok", value: false } },
      ],
    },
  };
}

function weeklySummary(): WorkflowTemplate {
  return {
    slug: "weekly-summary",
    name: "Weekly Summary",
    description: "Friday 5pm: summarise the week and post to your primary panel.",
    category: "ops",
    trigger: "schedule",
    schedule: "0 17 * * 5",
    graph: {
      nodes: [
        { id: "t1", kind: "trigger", label: "Friday 5pm", x: 60, y: 80 },
        { id: "a1", kind: "agent_run", label: "Summarise week", x: 320, y: 80, config: {
          prompt: "Summarise the last week's work in three short paragraphs.",
        } },
        { id: "p1", kind: "panel_message", label: "Post to panel", x: 580, y: 80, config: {
          role: "assistant",
          content: "Weekly summary:\n\n{{node.a1.text}}",
        } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e2", source: "a1", target: "p1" },
      ],
    },
  };
}

function onDemandResearch(): WorkflowTemplate {
  return {
    slug: "on-demand-research",
    name: "On-Demand Research",
    description: "Manually fire a research query and post the answer to a panel.",
    category: "research",
    trigger: "manual",
    schedule: null,
    graph: {
      nodes: [
        { id: "t1", kind: "trigger", label: "Manual", x: 60, y: 80 },
        { id: "a1", kind: "agent_run", label: "Research", x: 320, y: 80, config: {
          prompt: "Research this question thoroughly and return a concise answer: {{node.t1.query}}",
        } },
        { id: "p1", kind: "panel_message", label: "Post to panel", x: 580, y: 80, config: {
          role: "assistant",
          content: "{{node.a1.text}}",
        } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e2", source: "a1", target: "p1" },
      ],
    },
  };
}

function costWatchdog(): WorkflowTemplate {
  return {
    slug: "cost-watchdog",
    name: "Cost Watchdog",
    description: "Every 6 hours: review recent spend and Slack if over a threshold.",
    category: "analytics",
    trigger: "schedule",
    schedule: "0 */6 * * *",
    graph: {
      nodes: [
        { id: "t1", kind: "trigger", label: "Every 6h", x: 60, y: 80 },
        { id: "a1", kind: "agent_run", label: "Review spend", x: 320, y: 80, config: {
          prompt: "Analyse recent AI spend. Return JSON like {\"over\": true|false, \"summary\": \"...\"}.",
        } },
        { id: "c1", kind: "condition", label: "Over threshold?", x: 580, y: 80, config: {
          path: "node.over", op: "eq", value: true,
        } },
        { id: "h1", kind: "http_post", label: "Slack alert", x: 840, y: 40, config: {
          url: "https://hooks.slack.com/services/REPLACE/ME/ME",
          body: { text: "Spend alert: {{node.a1.text}}" },
        } },
      ],
      edges: [
        { id: "e1", source: "t1", target: "a1" },
        { id: "e2", source: "a1", target: "c1" },
        { id: "e3", source: "c1", target: "h1", label: "true", condition: { op: "eq", path: "node.ok", value: true } },
      ],
    },
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

/** Validate a graph shape. Returns an error message or null. */
export function validateGraph(graph: unknown): string | null {
  if (!isPlainObject(graph)) return "graph must be an object";
  const nodes = (graph as Record<string, unknown>).nodes;
  const edges = (graph as Record<string, unknown>).edges;
  if (!Array.isArray(nodes)) return "graph.nodes must be an array";
  if (!Array.isArray(edges)) return "graph.edges must be an array";
  const nodeIds = new Set<string>();
  for (const n of nodes) {
    if (!isPlainObject(n)) return "every node must be an object";
    const id = String((n as Record<string, unknown>).id ?? "");
    const kind = String((n as Record<string, unknown>).kind ?? "");
    if (!id) return "every node needs an id";
    if (!NODE_KINDS.includes(kind as NodeKind)) {
      return `node ${id}: unknown kind ${kind}`;
    }
    if (nodeIds.has(id)) return `duplicate node id: ${id}`;
    nodeIds.add(id);
  }
  for (const e of edges) {
    if (!isPlainObject(e)) return "every edge must be an object";
    const id = String((e as Record<string, unknown>).id ?? "");
    const source = String((e as Record<string, unknown>).source ?? "");
    const target = String((e as Record<string, unknown>).target ?? "");
    if (!source || !target) return `edge ${id || "?"}: source and target required`;
    if (!nodeIds.has(source)) return `edge ${id || "?"}: source ${source} not in nodes`;
    if (!nodeIds.has(target)) return `edge ${id || "?"}: target ${target} not in nodes`;
  }
  return null;
}

export function normaliseGraph(graph: unknown): WorkflowGraph {
  const g = isPlainObject(graph) ? graph as Record<string, unknown> : {};
  const nodes = Array.isArray(g.nodes) ? g.nodes as WorkflowNode[] : [];
  const edges = Array.isArray(g.edges) ? g.edges as WorkflowEdge[] : [];
  return { nodes, edges };
}

// ---------------------------------------------------------------------------
// Graph utilities
// ---------------------------------------------------------------------------

function buildOutgoingMap(edges: WorkflowEdge[]): Map<string, WorkflowEdge[]> {
  const map = new Map<string, WorkflowEdge[]>();
  for (const e of edges) {
    const arr = map.get(e.source) ?? [];
    arr.push(e);
    map.set(e.source, arr);
  }
  return map;
}

function findNode(ctx: ExecutionContext, id: string): WorkflowNode | null {
  return ctx.workflow.graph.nodes.find((n) => n.id === id) ?? null;
}

function locateEntry(order: string[], graph: WorkflowGraph): string | null {
  const trigger = graph.nodes.find((n) => n.kind === "trigger");
  if (trigger) return trigger.id;
  return order[0] ?? null;
}

/** Kahn-style topological sort. Returns the empty array when there's a
 *  cycle. */
function topoSort(nodes: WorkflowNode[], edges: WorkflowEdge[]): string[] {
  const indeg = new Map<string, number>();
  for (const n of nodes) indeg.set(n.id, 0);
  for (const e of edges) {
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
  }
  const queue: string[] = [];
  for (const [id, d] of indeg.entries()) if (d === 0) queue.push(id);
  const out: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    out.push(id);
    for (const e of edges) {
      if (e.source !== id) continue;
      const d = (indeg.get(e.target) ?? 0) - 1;
      indeg.set(e.target, d);
      if (d === 0) queue.push(e.target);
    }
  }
  return out.length === nodes.length ? out : [];
}

// ---------------------------------------------------------------------------
// Template + predicate language
// ---------------------------------------------------------------------------

export function matchPredicate(
  clause: Predicate[],
  payload: Record<string, unknown>,
): boolean {
  if (!Array.isArray(clause) || clause.length === 0) return true;
  for (const p of clause) {
    const lhs = getByPath(payload, p.path);
    switch (p.op) {
      case "exists":
        if (lhs === undefined) return false;
        continue;
      case "eq":
        if (!eq(lhs, p.value)) return false;
        continue;
      case "neq":
        if (eq(lhs, p.value)) return false;
        continue;
      case "gt":
        if (typeof lhs !== "number" || typeof p.value !== "number") return false;
        if (!(lhs > p.value)) return false;
        continue;
      case "lt":
        if (typeof lhs !== "number" || typeof p.value !== "number") return false;
        if (!(lhs < p.value)) return false;
        continue;
      case "contains":
        if (typeof lhs !== "string" || typeof p.value !== "string") return false;
        if (!lhs.includes(p.value)) return false;
        continue;
      default:
        return false;
    }
  }
  return true;
}

function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return a === b;
  return JSON.stringify(a) === JSON.stringify(b);
}

function getByPath(obj: Record<string, unknown>, path: string): unknown {
  if (!path) return obj;
  const parts = path.split(".");
  let cur: unknown = obj;
  for (const p of parts) {
    if (cur && typeof cur === "object" && p in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[p];
    } else {
      return undefined;
    }
  }
  return cur;
}

// ---------------------------------------------------------------------------
// Template rendering
// ---------------------------------------------------------------------------

/** Render `{{node.<id>.<field>}}` tokens against the executor's outputs.
 *  Unknown tokens are left intact so the user notices them. */
function renderTemplate(template: string, ctx: ExecutionContext): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, expr: string) => {
    const path = expr.trim();
    if (path.startsWith("node.")) {
      const rest = path.slice("node.".length);
      const dotIdx = rest.indexOf(".");
      if (dotIdx < 0) {
        const v = ctx.outputs[rest];
        return v === undefined ? "" : serialise(v);
      }
      const nodeId = rest.slice(0, dotIdx);
      const fieldPath = rest.slice(dotIdx + 1);
      const nodeOutput = ctx.outputs[nodeId];
      if (nodeOutput === undefined) return "";
      if (typeof nodeOutput !== "object" || nodeOutput === null) {
        return fieldPath === "" ? serialise(nodeOutput) : "";
      }
      const v = getByPath(nodeOutput as Record<string, unknown>, fieldPath);
      return v === undefined ? "" : serialise(v);
    }
    if (path === "workflow.name") return ctx.workflow.name;
    if (path === "when") return new Date().toISOString();
    return `{{${path}}}`;
  });
}

function serialise(v: unknown): string {
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function appendLog(
  ctx: ExecutionContext,
  nodeId: string,
  status: "ok" | "error" | "skipped",
  output?: unknown,
  error?: string,
): void {
  const now = new Date().toISOString();
  ctx.log.push({
    node_id: nodeId,
    kind: "trigger",
    started_at: now,
    finished_at: now,
    status,
    output,
    error,
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function promptIsNonEmpty(s: string): boolean {
  return s.length > 0;
}

function clampNumber(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function truncate(v: unknown, max: number): unknown {
  if (typeof v === "string") return v.length > max ? v.slice(0, max) + "…" : v;
  try {
    const s = JSON.stringify(v);
    return s.length > max ? s.slice(0, max) + "…" : v;
  } catch {
    return String(v);
  }
}
