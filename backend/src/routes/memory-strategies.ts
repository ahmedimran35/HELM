import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { summarizeStrategy } from "../lib/memory-strategies/index.ts";

const router = new Hono();
router.use("*", requireAuth);

router.get("/strategies", async (c) => {
  const user = c.get("user");
  const rows = user.role === "admin"
    ? await sql`SELECT id, scope, scope_id, kind, config, enabled, priority, created_at FROM memory_strategies ORDER BY priority ASC, created_at ASC`
    : await sql`SELECT id, scope, scope_id, kind, config, enabled, priority, created_at FROM memory_strategies WHERE scope = 'personal' AND scope_id = ${user.id}::uuid ORDER BY priority ASC, created_at ASC`;
  return c.json(rows);
});

router.post("/strategies", async (c) => {
  const user = c.get("user");
  if (user.role !== "admin") return c.json({ error: "admin role required" }, 403);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const scope = String(body.scope ?? "");
  const kind = String(body.kind ?? "");
  if (!['personal', 'team', 'admin'].includes(String(scope)) || !['rows', 'summary', 'vector'].includes(String(kind))) {
    return c.json({ error: "valid scope and kind required" }, 400);
  }
  const scopeId = body.scope_id ? String(body.scope_id) : null;
  const config = body.config && typeof body.config === "object" ? body.config : {};
  const priority = Number(body.priority ?? 100);
  const rows = await sql`
    INSERT INTO memory_strategies (scope, scope_id, kind, config, priority)
    VALUES (${scope}, ${scopeId}::uuid, ${kind}, ${JSON.stringify(config)}::jsonb, ${priority})
    RETURNING id, scope, scope_id, kind, config, enabled, priority, created_at
  `;
  return c.json(rows[0], 201);
});

router.patch("/strategies/:id", async (c) => {
  if (c.get("user").role !== "admin") return c.json({ error: "admin role required" }, 403);
  const body = await c.req.json().catch(() => ({})) as { enabled?: boolean };
  if (typeof body.enabled !== "boolean") return c.json({ error: "enabled boolean required" }, 400);
  const rows = await sql`UPDATE memory_strategies SET enabled = ${body.enabled} WHERE id = ${c.req.param("id")}::uuid RETURNING id, enabled`;
  if (rows.length === 0) return c.json({ error: "not found" }, 404);
  return c.json(rows[0]);
});

router.post("/strategies/:id/summarize", async (c) => {
  if (c.get("user").role !== "admin") return c.json({ error: "admin role required" }, 403);
  const count = await summarizeStrategy(c.req.param("id"));
  return c.json({ ok: true, collapsed: count });
});

router.delete("/strategies/:id", async (c) => {
  if (c.get("user").role !== "admin") return c.json({ error: "admin role required" }, 403);
  const result = await sql`DELETE FROM memory_strategies WHERE id = ${c.req.param("id")}::uuid`;
  if (result.count === 0) return c.json({ error: "not found" }, 404);
  return c.json({ ok: true });
});

export default router;
