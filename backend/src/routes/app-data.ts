// App data proxy (P7). The bundle is static HTML/CSS/JS but any
// persistent state an app needs goes through this API.
//
//   GET    /api/app-data/:install_id/:key   — read JSON value
//   POST   /api/app-data/:install_id/:key   — upsert JSON value
//   DELETE /api/app-data/:install_id/:key   — delete key
//
// Access is gated on the install:
//   * Admin: always
//   * Panel install: any member of that panel
//   * User install: that user
//
// The bundle is served unauthenticated from /apps/:slug/ (apps-bundles.ts);
// per-app auth happens at THIS layer. The bundle is expected to know
// its install_id (typically rendered into the page by the host, or read
// from a cookie the host sets after install).

import { Hono, type Context } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";

const router = new Hono();
router.use("*", requireAuth);

// Single helper: load an install and confirm the caller can read/write
// its data. Returns either the install row (with app_id) or a Hono
// Response to short-circuit with.
type InstallRow = {
  id: string;
  app_id: string;
  panel_id: string | null;
  user_id: string | null;
  app_enabled: boolean;
};

async function loadInstallOrDeny(
  c: Context,
  installId: string,
): Promise<{ install: InstallRow } | { response: Response }> {
  const user = c.get("user");
  const rows = await sql<{
    id: string;
    app_id: string;
    panel_id: string | null;
    user_id: string | null;
    enabled: boolean;
  }[]>`
    SELECT i.id, i.app_id, i.panel_id, i.user_id, a.enabled
    FROM app_installs i JOIN apps a ON a.id = i.app_id
    WHERE i.id = ${installId}::uuid LIMIT 1
  `;
  const row = rows[0];
  if (!row) return { response: c.json({ error: "install_not_found" }, 404) };
  if (user.role !== "admin") {
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
    if (!allowed) return { response: c.json({ error: "forbidden" }, 403) };
  }
  return {
    install: {
      id: row.id,
      app_id: row.app_id,
      panel_id: row.panel_id,
      user_id: row.user_id,
      app_enabled: row.enabled,
    },
  };
}

router.get("/:install_id/:key", async (c) => {
  const installId = c.req.param("install_id");
  const key = c.req.param("key");
  const got = await loadInstallOrDeny(c, installId);
  if ("response" in got) return got.response;
  const rows = await sql<{ id: string; value: unknown }[]>`
    SELECT id, value FROM app_data
    WHERE install_id = ${got.install.id}::uuid AND key = ${key} LIMIT 1
  `;
  if (!rows[0]) return c.json({ value: null });
  return c.json({ id: rows[0].id, value: rows[0].value });
});

router.post("/:install_id/:key", async (c) => {
  const installId = c.req.param("install_id");
  const key = c.req.param("key");
  const got = await loadInstallOrDeny(c, installId);
  if ("response" in got) return got.response;
  const body = (await c.req.json().catch(() => ({}))) as { value?: unknown };
  if (!("value" in body)) {
    return c.json({ error: "value required" }, 400);
  }
  const valueJson = sql.json(body.value as never);
  const rows = await sql<{ id: string }[]>`
    INSERT INTO app_data (app_id, install_id, key, value)
    VALUES (${got.install.app_id}::uuid, ${got.install.id}::uuid, ${key}, ${valueJson})
    ON CONFLICT (install_id, key) DO UPDATE
      SET value = EXCLUDED.value,
          updated_at = now()
    RETURNING id
  `;
  return c.json({ id: rows[0]!.id });
});

router.delete("/:install_id/:key", async (c) => {
  const installId = c.req.param("install_id");
  const key = c.req.param("key");
  const got = await loadInstallOrDeny(c, installId);
  if ("response" in got) return got.response;
  await sql`
    DELETE FROM app_data
    WHERE install_id = ${got.install.id}::uuid AND key = ${key}
  `;
  return c.json({ ok: true });
});

export default router;