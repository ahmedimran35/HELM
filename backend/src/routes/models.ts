// Models registry endpoints (every user can read; admins can grant).
//
//   GET   /api/models                 — list models with per-user `assigned` flag
//   POST  /api/models/:id/grant       (admin) — grant a user access to a model
//   POST  /api/models/:id/revoke      (admin) — revoke access
//   POST  /api/playground             (admin) — send the same prompt to two models and compare

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAdmin } from "../middleware/role.ts";
import { buildAdapter, getProviderById } from "../providers/registry.ts";
import { logAudit } from "../lib/audit.ts";

const router = new Hono();
router.use("*", requireAuth);

interface ModelRow {
  id: string;
  provider_id: string;
  external_id: string;
  display_name: string;
  state: string;
  context_window: number | null;
  provider_type: string;
  provider_base_url: string;
}

router.get("/", async (c) => {
  const user = c.get("user");
  const rows = await sql<ModelRow[]>`
    SELECT m.id, m.provider_id, m.external_id, m.display_name, m.state,
           m.context_window,
           p.type AS provider_type, p.base_url AS provider_base_url
    FROM models m
    JOIN providers p ON p.id = m.provider_id
    WHERE m.state = 'active'
    ORDER BY p.added_at ASC, m.display_name ASC
  `;
  // Implicit access for admins; explicit grants for users.
  const accessRows = user.role === "admin"
    ? []
    : await sql<{ model_id: string }[]>`
        SELECT model_id FROM model_access WHERE user_id = ${user.id}::uuid
      `;
  const assigned = new Set(accessRows.map((r) => r.model_id));
  const pendingReq = await sql<{ model_id: string; status: string }[]>`
    SELECT model_id, status FROM access_requests
    WHERE user_id = ${user.id}::uuid AND status = 'pending'
  `;
  const pending = new Set(pendingReq.map((r) => r.model_id));
  return c.json(
    rows.map((r) => ({
      id: r.id,
      provider_id: r.provider_id,
      provider_type: r.provider_type,
      provider_base_url: r.provider_base_url,
      external_id: r.external_id,
      display_name: r.display_name,
      context_window: r.context_window,
      assigned: user.role === "admin" ? true : assigned.has(r.id),
      pending_request: pending.has(r.id),
    })),
  );
});

router.post("/:id/grant", requireAdmin, async (c) => {
  const admin = c.get("user");
  const modelId = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    user_id?: string;
  };
  const userId = typeof body.user_id === "string" ? body.user_id : "";
  if (!userId) return c.json({ error: "user_id required" }, 400);
  await sql`
    INSERT INTO model_access (user_id, model_id, granted_by)
    VALUES (${userId}::uuid, ${modelId}::uuid, ${admin.id}::uuid)
    ON CONFLICT (user_id, model_id) WHERE user_id IS NOT NULL DO NOTHING
  `;
  await logAudit({
    userId: admin.id,
    target: modelId,
    action: "access_granted_direct",
    metadata: { target_user_id: userId },
  });
  return c.json({ ok: true });
});

router.post("/:id/revoke", requireAdmin, async (c) => {
  const admin = c.get("user");
  const modelId = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    user_id?: string;
  };
  const userId = typeof body.user_id === "string" ? body.user_id : "";
  if (!userId) return c.json({ error: "user_id required" }, 400);
  await sql`
    DELETE FROM model_access
    WHERE user_id = ${userId}::uuid AND model_id = ${modelId}::uuid
  `;
  await logAudit({
    userId: admin.id,
    target: modelId,
    action: "access_revoked",
    metadata: { target_user_id: userId },
  });
  return c.json({ ok: true });
});

// Playground: send the same prompt to two models and stream both replies
// side-by-side. Each stream is independent and tagged with a label.
router.post("/playground", requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    model_a?: string;
    model_b?: string;
    prompt?: string;
    system?: string;
  };
  if (!body.model_a || !body.model_b || !body.prompt) {
    return c.json({ error: "model_a, model_b, prompt required" }, 400);
  }
  const loadModel = async (id: string) => {
    const rows = await sql<{
      id: string;
      external_id: string;
      display_name: string;
      provider_id: string;
    }[]>`
      SELECT id, external_id, display_name, provider_id
      FROM models WHERE id = ${id}::uuid AND state = 'active' LIMIT 1
    `;
    return rows[0] ?? null;
  };
  const [mA, mB] = await Promise.all([loadModel(body.model_a), loadModel(body.model_b)]);
  if (!mA || !mB) return c.json({ error: "model_not_found" }, 404);
  const [pA, pB] = await Promise.all([getProviderById(mA.provider_id), getProviderById(mB.provider_id)]);
  if (!pA || !pB) return c.json({ error: "provider_not_found" }, 500);
  const [aA, aB] = await Promise.all([buildAdapter(pA), buildAdapter(pB)]);
  const msgs = [
    ...(body.system ? [{ role: "system" as const, content: body.system }] : []),
    { role: "user" as const, content: body.prompt },
  ];
  const enc = new TextEncoder();
  const stream = new ReadableStream({
    async start(ctrl) {
      const write = (label: string, delta: string, done: boolean) => {
        ctrl.enqueue(
          enc.encode(`data: ${JSON.stringify({ label, delta, done })}\n\n`),
        );
      };
      const runOne = async (
        label: string,
        adapter: typeof aA,
        externalId: string,
      ) => {
        let assembled = "";
        for await (const chunk of adapter.chat({ model: externalId, messages: msgs })) {
          if (chunk.done) {
            write(label, "", true);
            return assembled;
          }
          assembled += chunk.delta;
          write(label, chunk.delta, false);
        }
        write(label, "", true);
        return assembled;
      };
      try {
        await Promise.all([
          runOne("A", aA, mA.external_id),
          runOne("B", aB, mB.external_id),
        ]);
      } finally {
        ctrl.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    },
  });
});

export default router;