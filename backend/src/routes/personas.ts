// Personas (docs §2.8) — reusable system-prompt presets that can be
// assigned to a panel instead of a raw model.
//
//   GET    /api/personas              — list
//   POST   /api/personas     (admin)  — create
//   PATCH  /api/personas/:id (admin)  — update
//   DELETE /api/personas/:id (admin)  — remove

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAdmin } from "../middleware/role.ts";
import { logAudit } from "../lib/audit.ts";

const router = new Hono();
router.use("*", requireAuth);

router.get("/", async (c) => {
  const rows = await sql<{
    id: string;
    name: string;
    description: string;
    system_prompt: string;
    created_at: Date;
  }[]>`
    SELECT id, name, description, system_prompt, created_at
    FROM personas ORDER BY created_at ASC
  `;
  return c.json(rows);
});

router.post("/", requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    description?: string;
    system_prompt?: string;
  };
  const name = (body.name ?? "").trim();
  if (!name) return c.json({ error: "name required" }, 400);
  try {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO personas (name, description, system_prompt)
      VALUES (${name}, ${body.description ?? ""}, ${body.system_prompt ?? ""})
      RETURNING id
    `;
    await logAudit({
      userId: c.get("user").id,
      target: rows[0]!.id,
      action: "persona_created",
      metadata: { name },
    });
    return c.json({ id: rows[0]!.id });
  } catch (err) {
    if ((err as Error).message.includes("personas_name_key")) {
      return c.json({ error: "name_taken" }, 409);
    }
    throw err;
  }
});

router.patch("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    description?: string;
    system_prompt?: string;
  };
  if (typeof body.name === "string") {
    await sql`UPDATE personas SET name = ${body.name} WHERE id = ${id}::uuid`;
  }
  if (typeof body.description === "string") {
    await sql`UPDATE personas SET description = ${body.description} WHERE id = ${id}::uuid`;
  }
  if (typeof body.system_prompt === "string") {
    await sql`UPDATE personas SET system_prompt = ${body.system_prompt} WHERE id = ${id}::uuid`;
  }
  return c.json({ ok: true });
});

router.delete("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  await sql`DELETE FROM personas WHERE id = ${id}::uuid`;
  await logAudit({
    userId: c.get("user").id,
    target: id,
    action: "persona_deleted",
  });
  return c.json({ ok: true });
});

export default router;