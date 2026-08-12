// Access request / approval workflow (docs §2.5).
//
//   POST  /api/access-requests              — user creates a request
//   GET   /api/access-requests              — list (admins see all, users see their own)
//   POST  /api/access-requests/:id/decide   — admin approves/denies
//
// Approve creates a model_access row in the same transaction so the
// "request → approve → model becomes usable" path is atomic (per docs §8.2).

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAdmin } from "../middleware/role.ts";
import { logAudit } from "../lib/audit.ts";
import { validate, validationErrorResponse } from "../lib/validate.ts";

const router = new Hono();
router.use("*", requireAuth);

router.post("/", async (c) => {
  const user = c.get("user");
  let body: { model_id?: string };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      model_id: { type: "uuid" },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (!body.model_id) return c.json({ error: "model_id required" }, 400);
  const modelId = body.model_id;
  const exists = await sql<{ id: string }[]>`
    SELECT id FROM models WHERE id = ${modelId}::uuid AND state = 'active' LIMIT 1
  `;
  if (!exists[0]) return c.json({ error: "model_not_found" }, 404);
  const already = await sql<{ status: string }[]>`
    SELECT status FROM access_requests
    WHERE user_id = ${user.id}::uuid
      AND model_id = ${modelId}::uuid
    ORDER BY requested_at DESC LIMIT 1
  `;
  if (already[0]?.status === "pending") {
    return c.json({ error: "request_already_pending" }, 409);
  }
  const rows = await sql<{ id: string }[]>`
    INSERT INTO access_requests (user_id, model_id)
    VALUES (${user.id}::uuid, ${modelId}::uuid)
    RETURNING id
  `;
  await logAudit({
    userId: user.id,
    target: modelId,
    action: "access_requested",
  });
  return c.json({ id: rows[0]!.id });
});

router.get("/", async (c) => {
  const user = c.get("user");
  const isAdmin = user.role === "admin";
  const rows = await sql<{
    id: string;
    user_id: string;
    user_name: string;
    user_username: string;
    model_id: string;
    model_name: string;
    status: string;
    requested_at: Date;
    decided_by: string | null;
    decided_at: Date | null;
  }[]>`
    SELECT r.id, r.user_id, u.name AS user_name, u.username AS user_username,
           r.model_id, m.display_name AS model_name, r.status,
           r.requested_at, r.decided_by, r.decided_at
    FROM access_requests r
    JOIN users u ON u.id = r.user_id
    JOIN models m ON m.id = r.model_id
    WHERE ${isAdmin ? sql`TRUE` : sql`r.user_id = ${user.id}::uuid`}
    ORDER BY r.requested_at DESC
    LIMIT 200
  `;
  return c.json(rows);
});

router.post("/:id/decide", requireAdmin, async (c) => {
  const admin = c.get("user");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    decision?: string;
  };
  const decision = body.decision;
  if (decision !== "approve" && decision !== "deny") {
    return c.json({ error: "decision must be 'approve' or 'deny'" }, 400);
  }
  const rows = await sql<{
    user_id: string;
    model_id: string;
    status: string;
  }[]>`
    SELECT user_id, model_id, status FROM access_requests
    WHERE id = ${id}::uuid LIMIT 1
  `;
  const row = rows[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  if (row.status !== "pending") {
    return c.json({ error: "already_decided" }, 409);
  }
  const newStatus = decision === "approve" ? "approved" : "denied";
  const result = await sql.begin(async (tx) => {
    await tx`
      UPDATE access_requests
      SET status = ${newStatus}, decided_by = ${admin.id}::uuid, decided_at = now()
      WHERE id = ${id}::uuid
    `;
    if (decision === "approve") {
      // Idempotent grant.
      await tx`
        INSERT INTO model_access (user_id, model_id, granted_by)
        VALUES (${row.user_id}::uuid, ${row.model_id}::uuid, ${admin.id}::uuid)
        ON CONFLICT (user_id, model_id) WHERE user_id IS NOT NULL DO NOTHING
      `;
    }
    return { ok: true };
  });
  await logAudit({
    userId: admin.id,
    target: row.model_id,
    action: decision === "approve" ? "access_granted" : "access_denied",
    metadata: { target_user_id: row.user_id, request_id: id },
  });
  return c.json(result);
});

export default router;