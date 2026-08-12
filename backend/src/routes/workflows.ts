// Workflows — visual workflow builder (Tier 2 / docs §P2).
//
//   GET    /api/workflows                list current user's workflows (admin sees all)
//   GET    /api/workflows/:id            single workflow + recent runs (last 10)
//   POST   /api/workflows                create
//   PATCH  /api/workflows/:id            update any field
//   DELETE /api/workflows/:id            delete (cascades runs)
//   POST   /api/workflows/:id/run        manual fire
//   GET    /api/workflow-templates       built-in templates
//
// The graph stored in `workflows.graph` is a JSON document with shape
//   { nodes: WorkflowNode[], edges: WorkflowEdge[] }
// It is validated on every write — every edge must connect two nodes
// and the graph must be a DAG (no cycles). The execution semantics
// live in `lib/workflow-runner.ts`.

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { logAudit } from "../lib/audit.ts";
import { validate, validationErrorResponse } from "../lib/validate.ts";
import { isValidCron } from "../lib/cron.ts";
import {
  runWorkflow,
  validateGraph,
  builtinTemplates,
  type WorkflowGraph,
  type WorkflowRow,
} from "../lib/workflow-runner.ts";
import { safeError } from "../lib/safe-error.ts";

const TRIGGER_KINDS = ["manual", "schedule", "webhook", "event"] as const;
const STATUS_KINDS = ["draft", "active", "paused", "archived"] as const;

const router = new Hono();
// NOTE: We deliberately do NOT use `router.use("*", requireAuth)` here.
// When this router is mounted at /api (the root), a global middleware
// would intercept /api/login and other public endpoints before any route
// matching happens. Instead, each route below adds `requireAuth` in its
// own middleware chain so only the matching route is gated.


// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

router.get("/workflows", requireAuth, async (c) => {
  const user = c.get("user");
  // Admins can see every workflow; regular users only their own.
  const rows = user.role === "admin"
    ? await sql<WorkflowRow[]>`
        SELECT id, user_id, panel_id, name, description, graph, status,
               trigger, schedule, enabled, last_run_at, created_at
        FROM workflows
        ORDER BY created_at DESC
      `
    : await sql<WorkflowRow[]>`
        SELECT id, user_id, panel_id, name, description, graph, status,
               trigger, schedule, enabled, last_run_at, created_at
        FROM workflows
        WHERE user_id = ${user.id}::uuid
        ORDER BY created_at DESC
      `;
  return c.json(rows);
});

// ---------------------------------------------------------------------------
// Get one (with runs)
// ---------------------------------------------------------------------------

router.get("/workflows/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const rows = await sql<WorkflowRow[]>`
    SELECT id, user_id, panel_id, name, description, graph, status,
           trigger, schedule, enabled, last_run_at, created_at
    FROM workflows
    WHERE id = ${id}::uuid
    LIMIT 1
  `;
  const wf = rows[0];
  if (!wf) return c.json({ error: "not_found" }, 404);
  // Non-admins can only see their own workflows.
  if (user.role !== "admin" && wf.user_id !== user.id) {
    return c.json({ error: "not_found" }, 404);
  }
  const runs = await sql<
    Array<{
      id: string;
      status: "running" | "completed" | "failed" | "paused";
      started_at: Date;
      finished_at: Date | null;
      result: { log?: unknown; outputs?: unknown } | null;
      error: string | null;
    }>
  >`
    SELECT id, status, started_at, finished_at, result, error
    FROM workflow_runs
    WHERE workflow_id = ${id}::uuid
    ORDER BY started_at DESC
    LIMIT 10
  `;
  return c.json({ ...wf, runs });
});

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

router.post("/workflows", requireAuth, async (c) => {
  const user = c.get("user");
  let body: {
    name?: string;
    description?: string;
    panel_id?: string | null;
    graph?: WorkflowGraph;
    trigger?: string;
    schedule?: string | null;
    enabled?: boolean;
    status?: string;
  };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      name: { type: "string", minLength: 1, maxLength: 200, trim: true },
      description: { type: "string", maxLength: 4000, trim: true },
      panel_id: { type: "uuid" },
      graph: { type: "object", fields: {}, optional: true },
      trigger: { type: "enum", values: TRIGGER_KINDS as unknown as string[] },
      schedule: { type: "string", maxLength: 200, trim: true },
      enabled: { type: "boolean" },
      status: { type: "enum", values: STATUS_KINDS as unknown as string[] },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (!body.name) return c.json({ error: "name required" }, 400);
  const graph = body.graph ?? { nodes: [], edges: [] };
  const graphError = validateGraph(graph);
  if (graphError) return c.json({ error: `graph: ${graphError}` }, 400);
  if (body.trigger === "schedule") {
    const cron = String(body.schedule ?? "").trim();
    if (!cron || !isValidCron(cron)) {
      return c.json({ error: "schedule workflow requires a valid cron expr in schedule" }, 400);
    }
  }
  const rows = await sql<{ id: string }[]>`
    INSERT INTO workflows (
      user_id, panel_id, name, description, graph, status,
      trigger, schedule, enabled
    ) VALUES (
      ${user.id}::uuid,
      ${body.panel_id ?? null}::uuid,
      ${body.name},
      ${body.description ?? ""},
      ${sql.json(graph as never)},
      ${body.status ?? "draft"},
      ${body.trigger ?? null},
      ${body.schedule ?? null},
      ${body.enabled ?? true}
    )
    RETURNING id
  `;
  await logAudit({
    userId: user.id,
    target: rows[0]!.id,
    action: "workflow_created",
    metadata: { name: body.name, trigger: body.trigger ?? null },
  });
  return c.json({ id: rows[0]!.id });
});

// ---------------------------------------------------------------------------
// Update
// ---------------------------------------------------------------------------

router.patch("/workflows/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  // Ownership check; admins can edit any workflow.
  const own = await sql<{ id: string; user_id: string }[]>`
    SELECT id, user_id FROM workflows WHERE id = ${id}::uuid LIMIT 1
  `;
  if (!own[0]) return c.json({ error: "not_found" }, 404);
  if (user.role !== "admin" && own[0].user_id !== user.id) {
    return c.json({ error: "not_found" }, 404);
  }

  let body: {
    name?: string;
    description?: string;
    panel_id?: string | null;
    graph?: WorkflowGraph;
    trigger?: string;
    schedule?: string | null;
    enabled?: boolean;
    status?: string;
  };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      name: { type: "string", minLength: 1, maxLength: 200, trim: true },
      description: { type: "string", maxLength: 4000, trim: true },
      panel_id: { type: "uuid" },
      graph: { type: "object", fields: {}, optional: true },
      trigger: { type: "enum", values: TRIGGER_KINDS as unknown as string[] },
      schedule: { type: "string", maxLength: 200, trim: true },
      enabled: { type: "boolean" },
      status: { type: "enum", values: STATUS_KINDS as unknown as string[] },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (body.graph !== undefined) {
    const err = validateGraph(body.graph);
    if (err) return c.json({ error: `graph: ${err}` }, 400);
  }
  if (body.trigger === "schedule") {
    const cron = String(body.schedule ?? "").trim();
    if (!cron || !isValidCron(cron)) {
      return c.json({ error: "schedule workflow requires a valid cron expr in schedule" }, 400);
    }
  }

  if (body.name !== undefined) {
    await sql`UPDATE workflows SET name = ${body.name}, updated_at = now() WHERE id = ${id}::uuid`;
  }
  if (body.description !== undefined) {
    await sql`UPDATE workflows SET description = ${body.description}, updated_at = now() WHERE id = ${id}::uuid`;
  }
  if (body.panel_id !== undefined) {
    await sql`UPDATE workflows SET panel_id = ${body.panel_id}::uuid, updated_at = now() WHERE id = ${id}::uuid`;
  }
  if (body.graph !== undefined) {
    await sql`UPDATE workflows SET graph = ${sql.json(body.graph as never)}, updated_at = now() WHERE id = ${id}::uuid`;
  }
  if (body.trigger !== undefined) {
    await sql`UPDATE workflows SET trigger = ${body.trigger}, updated_at = now() WHERE id = ${id}::uuid`;
  }
  if (body.schedule !== undefined) {
    await sql`UPDATE workflows SET schedule = ${body.schedule}, updated_at = now() WHERE id = ${id}::uuid`;
  }
  if (body.enabled !== undefined) {
    await sql`UPDATE workflows SET enabled = ${body.enabled}, updated_at = now() WHERE id = ${id}::uuid`;
  }
  if (body.status !== undefined) {
    await sql`UPDATE workflows SET status = ${body.status}, updated_at = now() WHERE id = ${id}::uuid`;
  }
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Delete
// ---------------------------------------------------------------------------

router.delete("/workflows/:id", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const rows = await sql<{ user_id: string }[]>`
    SELECT user_id FROM workflows WHERE id = ${id}::uuid LIMIT 1
  `;
  const wf = rows[0];
  if (!wf) return c.json({ error: "not_found" }, 404);
  if (user.role !== "admin" && wf.user_id !== user.id) {
    return c.json({ error: "not_found" }, 404);
  }
  // ON DELETE CASCADE on workflow_runs drops the child rows.
  await sql`DELETE FROM workflows WHERE id = ${id}::uuid`;
  return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

router.post("/workflows/:id/run", requireAuth, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const own = await sql<{ id: string }[]>`
    SELECT id FROM workflows
    WHERE id = ${id}::uuid
      AND (user_id = ${user.id}::uuid OR ${user.role === "admin"}::boolean)
    LIMIT 1
  `;
  if (!own[0]) return c.json({ error: "not_found" }, 404);
  try {
    const result = await runWorkflow(id, { reason: "manual" });
    return c.json(result);
  } catch (err) {
    return safeError(c, err, { status: 500, code: "workflow_load_failed" });
  }
});

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

router.get("/workflow-templates", requireAuth, async (c) => {
  return c.json(builtinTemplates());
});

// ---------------------------------------------------------------------------
// Instantiate a template (creates a real workflow row from a template).
// ---------------------------------------------------------------------------

router.post("/workflow-templates/:slug/instantiate", requireAuth, async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const tpl = builtinTemplates().find((t) => t.slug === slug);
  if (!tpl) return c.json({ error: "not_found" }, 404);
  const rows = await sql<{ id: string }[]>`
    INSERT INTO workflows (
      user_id, name, description, graph, status, trigger, schedule, enabled
    ) VALUES (
      ${user.id}::uuid,
      ${tpl.name},
      ${tpl.description},
      ${sql.json(tpl.graph as never)},
      'draft',
      ${tpl.trigger},
      ${tpl.schedule},
      FALSE
    )
    RETURNING id
  `;
  return c.json({ id: rows[0]!.id });
});

export default router;
