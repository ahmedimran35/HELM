// Users CRUD (admin-only, docs §2.10).
//
//   GET    /api/users                 — list accounts (admin)
//   POST   /api/users                 — create account (admin)
//   POST   /api/users/:id/deactivate  — soft-disable (admin)
//   POST   /api/users/:id/reactivate  — re-enable (admin)
//   POST   /api/users/:id/reset-password — one-time password, shown once
//
// Creating + resetting always sets must_change_password = TRUE so the
// user is forced to set their own password on next login (docs §7).

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAdmin } from "../middleware/role.ts";
import { hashPassword } from "../auth/password.ts";
import { generateOneTimePassword } from "../lib/ids.ts";
import { logAudit } from "../lib/audit.ts";
import { validate, validationErrorResponse } from "../lib/validate.ts";

const router = new Hono();
router.use("*", requireAuth);

router.get("/", requireAdmin, async (c) => {
  const rows = await sql<{
    id: string;
    name: string;
    username: string;
    role: string;
    is_active: boolean;
    must_change_password: boolean;
    created_at: Date;
  }[]>`
    SELECT id, name, username, role, is_active, must_change_password, created_at
    FROM users ORDER BY created_at ASC
  `;
  return c.json(rows);
});

router.post("/", requireAdmin, async (c) => {
  const admin = c.get("user");
  let body: { name?: string; username?: string; password?: string; role?: string };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      name: { type: "string", minLength: 1, maxLength: 120, trim: true },
      username: { type: "string", minLength: 1, maxLength: 60, trim: true },
      password: { type: "string", minLength: 10, maxLength: 200 },
      role: { type: "enum", values: ["admin", "user"] },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (!body.name || !body.username) {
    return c.json({ error: "name and username required" }, 400);
  }
  const role = body.role ?? "user";
  const password = body.password ?? generateOneTimePassword();
  const mustChange = !body.password;
  const hash = await hashPassword(password);
  let insertedId: string;
  try {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO users (name, username, password_hash, role, must_change_password, created_by)
      VALUES (${body.name}, ${body.username}, ${hash}, ${role}, ${mustChange}, ${admin.id}::uuid)
      RETURNING id
    `;
    insertedId = rows[0]!.id;
  } catch (err) {
    if ((err as Error).message.includes("users_username_key")) {
      return c.json({ error: "username_taken" }, 409);
    }
    throw err;
  }
  await logAudit({
    userId: admin.id,
    target: insertedId,
    action: "user_created",
    metadata: { username: body.username, role, generated_password: mustChange },
  });
  return c.json({
    id: insertedId,
    username: body.username,
    name: body.name,
    role,
    generated_password: mustChange ? password : undefined,
  });
});

router.post("/:id/deactivate", requireAdmin, async (c) => {
  const id = c.req.param("id");
  if (id === c.get("user").id) {
    return c.json({ error: "cannot deactivate self" }, 400);
  }
  await sql`UPDATE users SET is_active = FALSE WHERE id = ${id}::uuid`;
  // Revoke all sessions — without this, an already-open tab from
  // before the deactivation would remain usable (requireAuth checks
  // is_active only at login).
  await sql`
    UPDATE sessions SET logout_at = now()
    WHERE user_id = ${id}::uuid AND logout_at IS NULL
  `;
  await logAudit({
    userId: c.get("user").id,
    target: id,
    action: "user_deactivated",
  });
  return c.json({ ok: true });
});

router.post("/:id/reactivate", requireAdmin, async (c) => {
  const id = c.req.param("id");
  await sql`UPDATE users SET is_active = TRUE WHERE id = ${id}::uuid`;
  await logAudit({
    userId: c.get("user").id,
    target: id,
    action: "user_reactivated",
  });
  return c.json({ ok: true });
});

router.post("/:id/reset-password", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const newPw = generateOneTimePassword();
  const hash = await hashPassword(newPw);
  await sql`
    UPDATE users SET password_hash = ${hash}, must_change_password = TRUE
    WHERE id = ${id}::uuid
  `;
  // Revoke every active session for the reset user. Otherwise an
  // attacker who stole a session cookie would keep using it for up to
  // 7 days after the admin reset the password.
  await sql`
    UPDATE sessions SET logout_at = now()
    WHERE user_id = ${id}::uuid AND logout_at IS NULL
  `;
  await logAudit({
    userId: c.get("user").id,
    target: id,
    action: "password_reset",
  });
  return c.json({ generated_password: newPw });
});

// Edit user fields (name, role, username). Email-style names with @ are
// allowed since docs list username as the identifier.
router.patch("/:id", requireAdmin, async (c) => {
  const admin = c.get("user");
  const id = c.req.param("id");
  let body: { name?: string; username?: string; role?: string };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      name: { type: "string", minLength: 1, maxLength: 120, trim: true },
      username: { type: "string", minLength: 1, maxLength: 120, trim: true },
      role: { type: "enum", values: ["admin", "user"] },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (id === admin.id && body.role && body.role !== "admin") {
    return c.json({ error: "cannot demote self" }, 400);
  }
  if (Object.keys(body).length === 0) {
    return c.json({ error: "no fields to update" }, 400);
  }
  try {
    if (body.name !== undefined) {
      await sql`UPDATE users SET name = ${body.name} WHERE id = ${id}::uuid`;
    }
    if (body.username !== undefined) {
      await sql`UPDATE users SET username = ${body.username} WHERE id = ${id}::uuid`;
    }
    if (body.role !== undefined) {
      await sql`UPDATE users SET role = ${body.role} WHERE id = ${id}::uuid`;
    }
  } catch (err) {
    if ((err as Error).message.includes("users_username_key")) {
      return c.json({ error: "username_taken" }, 409);
    }
    throw err;
  }
  await logAudit({
    userId: admin.id,
    target: id,
    action: "user_updated",
    metadata: { fields: Object.keys(body).join(",") },
  });
  return c.json({ ok: true });
});

// Hard delete a user. Cascade removes their sessions, messages, etc.
// Refuses to delete the currently-authenticated admin or the last admin.
router.delete("/:id", requireAdmin, async (c) => {
  const admin = c.get("user");
  const id = c.req.param("id");
  if (id === admin.id) {
    return c.json({ error: "cannot delete self" }, 400);
  }
  // Ensure we don't strand the system without an admin.
  const target = await sql<{ role: string; username: string }[]>`
    SELECT role, username FROM users WHERE id = ${id}::uuid LIMIT 1
  `;
  if (!target[0]) return c.json({ error: "not_found" }, 404);
  if (target[0].role === "admin") {
    const admins = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM users WHERE role = 'admin' AND is_active = TRUE
    `;
    if ((admins[0]?.n ?? 0) <= 1) {
      return c.json({ error: "cannot delete the last admin" }, 400);
    }
  }
  // Hard delete — FK cascades take care of sessions, model_access, etc.
  await sql`DELETE FROM users WHERE id = ${id}::uuid`;
  await logAudit({
    userId: admin.id,
    target: id,
    action: "user_deleted",
    metadata: { username: target[0].username },
  });
  return c.json({ ok: true });
});

export default router;