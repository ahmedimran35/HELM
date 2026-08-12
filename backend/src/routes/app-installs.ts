// App installs (P7) — per-panel or per-user grants for an app.
//
//   GET    /api/apps/:slug/installs      — list installs for an app
//   POST   /api/apps/:slug/install      — admin or self: install
//   DELETE /api/app-installs/:id         — admin or (for user installs)
//                                          the installing user
//
// Install scope rules:
//   * Exactly one of panel_id / user_id must be provided.
//   * Admins may install for anyone (panel or user).
//   * Non-admins may only install for themselves (user_id == self).
//   * Re-installing the same (app, panel) or (app, user) is a no-op
//     (we return the existing install_id).
//
// The DELETE handler lives under a separate sub-router so it can be
// mounted at /api/app-installs while the install/create handlers stay
// nested under /api/apps/:slug/.

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { logAudit } from "../lib/audit.ts";

const router = new Hono();
router.use("*", requireAuth);

// /api/apps/:slug/installs + /api/apps/:slug/install are mounted under
// /api/apps (see index.ts), so we read :slug here.
router.get("/:slug/installs", async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const app = await sql<{ id: string; enabled: boolean }[]>`
    SELECT id, enabled FROM apps WHERE slug = ${slug} LIMIT 1
  `;
  const appRow = app[0];
  if (!appRow) return c.json({ error: "not_found" }, 404);
  // Non-admins only see installs they (or their panels) own.
  const rows = await sql<{
    id: string;
    app_id: string;
    panel_id: string | null;
    user_id: string | null;
    panel_name: string | null;
    user_name: string | null;
    user_username: string | null;
    granted_scopes: string[];
    installed_by: string | null;
    installed_by_name: string | null;
    installed_at: Date;
  }[]>`
    SELECT i.id, i.app_id, i.panel_id, i.user_id,
           p.name AS panel_name,
           u.name AS user_name, u.username AS user_username,
           i.granted_scopes, i.installed_by,
           ib.name AS installed_by_name,
           i.installed_at
    FROM app_installs i
    LEFT JOIN panels p ON p.id = i.panel_id
    LEFT JOIN users u ON u.id = i.user_id
    LEFT JOIN users ib ON ib.id = i.installed_by
    WHERE i.app_id = ${appRow.id}
      AND (
        ${user.role === "admin"}::boolean
        OR i.user_id = ${user.id}::uuid
        OR (i.panel_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM panel_members WHERE panel_id = i.panel_id AND user_id = ${user.id}::uuid
        ))
      )
    ORDER BY i.installed_at DESC
  `;
  return c.json(rows);
});

router.post("/:slug/install", async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const body = (await c.req.json().catch(() => ({}))) as {
    panel_id?: string;
    user_id?: string;
    granted_scopes?: string[];
  };
  const panelId = body.panel_id ?? null;
  const userId = body.user_id ?? null;
  if ((panelId === null) === (userId === null)) {
    return c.json({ error: "exactly one of panel_id or user_id required" }, 400);
  }
  if (user.role !== "admin") {
    // Non-admins may only install for themselves.
    if (userId !== user.id) {
      return c.json({ error: "forbidden" }, 403);
    }
  }
  const scopes = Array.isArray(body.granted_scopes)
    ? body.granted_scopes.filter((s): s is string => typeof s === "string")
    : [];

  const app = await sql<{ id: string; enabled: boolean }[]>`
    SELECT id, enabled FROM apps WHERE slug = ${slug} LIMIT 1
  `;
  if (!app[0]) return c.json({ error: "app_not_found" }, 404);
  if (!app[0].enabled && user.role !== "admin") {
    return c.json({ error: "app_disabled" }, 403);
  }

  // Confirm the panel exists if installing for a panel.
  if (panelId) {
    const p = await sql<{ id: string }[]>`
      SELECT id FROM panels WHERE id = ${panelId}::uuid LIMIT 1
    `;
    if (!p[0]) return c.json({ error: "panel_not_found" }, 404);
  }
  if (userId) {
    const u = await sql<{ id: string }[]>`
      SELECT id FROM users WHERE id = ${userId}::uuid LIMIT 1
    `;
    if (!u[0]) return c.json({ error: "user_not_found" }, 404);
  }

  // Upsert by (app_id, panel_id) or (app_id, user_id). Postgres UNIQUE
  // doesn't exist for these nullable pairs, so do an explicit EXISTS
  // probe first and INSERT if missing.
  if (panelId) {
    const existing = await sql<{ id: string }[]>`
      SELECT id FROM app_installs
      WHERE app_id = ${app[0].id}::uuid AND panel_id = ${panelId}::uuid
      LIMIT 1
    `;
    if (existing[0]) {
      return c.json({ id: existing[0].id, already_installed: true });
    }
    const rows = await sql<{ id: string }[]>`
      INSERT INTO app_installs (app_id, panel_id, user_id, granted_scopes, installed_by)
      VALUES (${app[0].id}::uuid, ${panelId}::uuid, NULL, ${scopes}, ${user.id}::uuid)
      RETURNING id
    `;
    await logAudit({
      userId: user.id,
      target: rows[0]!.id,
      action: "app_installed_panel",
      metadata: { app_slug: slug, panel_id: panelId, scopes: scopes.length },
    });
    return c.json({ id: rows[0]!.id });
  }
  // user install
  const existing = await sql<{ id: string }[]>`
    SELECT id FROM app_installs
    WHERE app_id = ${app[0].id}::uuid AND user_id = ${userId}::uuid
    LIMIT 1
  `;
  if (existing[0]) {
    return c.json({ id: existing[0].id, already_installed: true });
  }
  const rows = await sql<{ id: string }[]>`
    INSERT INTO app_installs (app_id, panel_id, user_id, granted_scopes, installed_by)
    VALUES (${app[0].id}::uuid, NULL, ${userId}::uuid, ${scopes}, ${user.id}::uuid)
    RETURNING id
  `;
  await logAudit({
    userId: user.id,
    target: rows[0]!.id,
    action: "app_installed_user",
    metadata: { app_slug: slug, target_user_id: userId, scopes: scopes.length },
  });
  return c.json({ id: rows[0]!.id });
});

// Separate sub-router mounted at /api/app-installs for the DELETE verb.
// We keep it in the same file so the data access lives together.
export const appInstallsIdRouter = new Hono();
appInstallsIdRouter.use("*", requireAuth);

appInstallsIdRouter.delete("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const rows = await sql<{
    id: string;
    panel_id: string | null;
    user_id: string | null;
    app_slug: string;
  }[]>`
    SELECT i.id, i.panel_id, i.user_id, a.slug AS app_slug
    FROM app_installs i JOIN apps a ON a.id = i.app_id
    WHERE i.id = ${id}::uuid LIMIT 1
  `;
  const row = rows[0];
  if (!row) return c.json({ error: "not_found" }, 404);
  if (user.role !== "admin") {
    // Non-admins may uninstall:
    //  * their own user installs (user_id == self)
    //  * panel installs IF they're a member of the panel
    let allowed = false;
    if (row.user_id === user.id) allowed = true;
    if (row.panel_id) {
      const m = await sql<{ user_id: string }[]>`
        SELECT user_id FROM panel_members
        WHERE panel_id = ${row.panel_id}::uuid AND user_id = ${user.id}::uuid
        LIMIT 1
      `;
      if (m[0]) allowed = true;
    }
    if (!allowed) return c.json({ error: "forbidden" }, 403);
  }
  await sql`DELETE FROM app_installs WHERE id = ${id}::uuid`;
  await logAudit({
    userId: user.id,
    target: id,
    action: "app_uninstalled",
    metadata: { app_slug: row.app_slug },
  });
  return c.json({ ok: true });
});

export default router;