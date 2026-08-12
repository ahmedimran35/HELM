// Apps (P7, docs §qm-parity). Admin CRUD on the `apps` registry.
//
//   GET    /api/apps             — admin: full list · user: only apps
//                                  they (or a panel they're on) have installed
//   GET    /api/apps/bootstrap   — SDK bootstrap: identity + (optional)
//                                  install + theme. Used by the browser
//                                  SDK injected into every app bundle.
//   GET    /api/apps/:slug       — single app config (visible to anyone
//                                  who can read it)
//   POST   /api/apps     (admin) — create app
//   PATCH  /api/apps/:id (admin) — update name / desc / bundle / routes
//                                  / data_sources / permissions / enabled / version
//   DELETE /api/apps/:id (admin) — hard-delete (cascades to installs + data)
//
// `slug` becomes the URL the app is served at (/apps/:slug/...). We keep
// the slug a strict kebab so we can rely on it for routing without
// surprise characters.

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAdmin } from "../middleware/role.ts";
import { logAudit } from "../lib/audit.ts";
import { getHarnessByKind } from "../harness/router.ts";
import { isHarnessKind } from "../harness/types.ts";
import { BUNDLES_ROOT, transformAppHtml } from "./apps-bundles.ts";
import { join } from "node:path";
import { mkdir, rm } from "node:fs/promises";

const router = new Hono();
router.use("*", requireAuth);

const SLUG_RX = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Derive a kebab-case slug from a free-form name. Mirrors the helper
// the frontend uses so the two stay in lock-step if the admin edits
// the name field after generation.
function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

// Strip code fences / leading prose the model sometimes adds despite
// the system prompt telling it to return pure JSON. We grab the first
// top-level {...} block.
function extractJsonObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  // 1. Try direct parse.
  try { return JSON.parse(trimmed); } catch { /* fall through */ }
  // 2. Strip ```json ... ``` fences.
  const fence = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    try { return JSON.parse(fence[1]!.trim()); } catch { /* fall through */ }
  }
  // 3. Greedy first { ... last }.
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) {
    try { return JSON.parse(trimmed.slice(first, last + 1)); } catch { /* fall through */ }
  }
  return null;
}

router.get("/", async (c) => {
  const user = c.get("user");
  if (user.role === "admin") {
    const rows = await sql<{
      id: string;
      slug: string;
      name: string;
      description: string;
      bundle_url: string | null;
      routes: unknown;
      data_sources: unknown;
      permissions: unknown;
      version: string;
      enabled: boolean;
      created_by: string | null;
      created_at: Date;
      updated_at: Date;
      install_count: number;
    }[]>`
      SELECT a.id, a.slug, a.name, a.description, a.bundle_url, a.routes,
             a.data_sources, a.permissions, a.version, a.enabled,
             a.created_by, a.created_at, a.updated_at,
             (SELECT count(*) FROM app_installs WHERE app_id = a.id)::int AS install_count
      FROM apps a
      ORDER BY a.created_at ASC
    `;
    return c.json(rows);
  }
  // Non-admin users see every enabled app (so they can browse + install),
  // plus a per-app `user_install` row describing the install that gives
  // them access (their own user install, or a panel they're on). Apps
  // they have no install for are returned with `user_install: null` and
  // the front-end shows an "Install" button instead of "Open".
  const rows = await sql<{
    id: string;
    slug: string;
    name: string;
    description: string;
    bundle_url: string | null;
    routes: unknown;
    data_sources: unknown;
    permissions: unknown;
    version: string;
    enabled: boolean;
    install_count: number;
    user_install_id: string | null;
    user_install_scope: "user" | "panel" | null;
    user_install_label: string | null;
  }[]>`
    SELECT a.id, a.slug, a.name, a.description, a.bundle_url, a.routes,
           a.data_sources, a.permissions, a.version, a.enabled,
           (SELECT count(*) FROM app_installs WHERE app_id = a.id)::int AS install_count,
           ui.id AS user_install_id,
           CASE WHEN ui.user_id IS NOT NULL THEN 'user'::text
                WHEN ui.panel_id IS NOT NULL THEN 'panel'::text
                ELSE NULL END AS user_install_scope,
           COALESCE(p.name, u.username) AS user_install_label
    FROM apps a
    LEFT JOIN app_installs ui ON ui.app_id = a.id AND (
      ui.user_id = ${user.id}::uuid
      OR (ui.panel_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM panel_members
        WHERE panel_id = ui.panel_id AND user_id = ${user.id}::uuid
      ))
    )
    LEFT JOIN panels p ON p.id = ui.panel_id
    LEFT JOIN users u ON u.id = ui.user_id
    WHERE a.enabled = TRUE
    ORDER BY (ui.id IS NULL) ASC, a.name ASC
  `;
  return c.json(rows);
});

// /api/apps/bootstrap — the SDK injected into every app bundle calls
// this on init so the app can read the current user, the resolved
// install (if ?install=… was provided), and the active theme.
//
// This endpoint MUST be registered BEFORE the /:slug wildcard so the
// literal "bootstrap" path isn't captured as a slug. It also accepts
// the install id from the query string so an app that's been loaded
// without an explicit install context (e.g. opened in a new tab via
// "open in browser") can still find its install from a parent message.
//
// Authorization for the install is enforced the same way as the
// /api/app-data endpoints: admin always, panel install if the user is
// a panel member, user install if the user is the install owner.
router.get("/bootstrap", async (c) => {
  const user = c.get("user");
  const installId = c.req.query("install");
  const theme = (c.req.query("theme") === "light") ? "light" : "dark";
  const payload: Record<string, unknown> = {
    user: {
      id: user.id,
      username: user.username,
      name: user.name,
      role: user.role,
    },
    theme,
  };
  if (installId) {
    const rows = await sql<{
      id: string;
      app_id: string;
      app_slug: string;
      app_name: string;
      app_enabled: boolean;
      panel_id: string | null;
      user_id: string | null;
      granted_scopes: string[];
      installed_at: Date;
    }[]>`
      SELECT i.id, i.app_id, a.slug AS app_slug, a.name AS app_name,
             a.enabled AS app_enabled, i.panel_id, i.user_id,
             i.granted_scopes, i.installed_at
      FROM app_installs i JOIN apps a ON a.id = i.app_id
      WHERE i.id = ${installId}::uuid LIMIT 1
    `;
    const install = rows[0];
    if (!install) {
      return c.json({ error: "install_not_found", ...payload }, 404);
    }
    if (!install.app_enabled && user.role !== "admin") {
      return c.json({ error: "app_disabled", ...payload }, 403);
    }
    if (user.role !== "admin") {
      let allowed = false;
      if (install.user_id === user.id) allowed = true;
      if (install.panel_id) {
        const m = await sql<{ user_id: string }[]>`
          SELECT user_id FROM panel_members
          WHERE panel_id = ${install.panel_id}::uuid
            AND user_id = ${user.id}::uuid LIMIT 1
        `;
        if (m[0]) allowed = true;
      }
      if (!allowed) {
        return c.json({ error: "forbidden", ...payload }, 403);
      }
    }
    payload.install = {
      id: install.id,
      app_id: install.app_id,
      app_slug: install.app_slug,
      app_name: install.app_name,
      panel_id: install.panel_id,
      user_id: install.user_id,
      granted_scopes: install.granted_scopes,
      installed_at: install.installed_at,
    };
  }
  return c.json(payload);
});

router.get("/:slug", async (c) => {
  const user = c.get("user");
  const slug = c.req.param("slug");
  const rows = await sql<{
    id: string;
    slug: string;
    name: string;
    description: string;
    bundle_url: string | null;
    routes: unknown;
    data_sources: unknown;
    permissions: unknown;
    version: string;
    enabled: boolean;
    created_by: string | null;
    created_at: Date;
    updated_at: Date;
  }[]>`
    SELECT id, slug, name, description, bundle_url, routes, data_sources,
           permissions, version, enabled, created_by, created_at, updated_at
    FROM apps WHERE slug = ${slug} LIMIT 1
  `;
  const app = rows[0];
  if (!app) return c.json({ error: "not_found" }, 404);
  if (!app.enabled && user.role !== "admin") {
    return c.json({ error: "forbidden" }, 403);
  }
  return c.json(app);
});

// ─── AI draft generator ──────────────────────────────────────────────
//
// The admin types a free-form description of what they want the app to
// do ("a daily standup that reads my panel messages and posts back").
// We forward it to the user's assigned model with a system prompt that
// asks for a strict JSON object describing the app's name, slug,
// description, and bundle URL. The frontend uses the response to
// pre-fill the NewAppForm so the admin can review + tweak before
// committing.
//
// The route is mounted under the same requireAuth middleware as the
// rest of /api/apps and additionally requires admin role — only
// admins are allowed to provision new apps.
router.post("/generate", requireAdmin, async (c) => {
  const admin = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as { prompt?: string };
  const prompt = (body.prompt ?? "").trim();
  if (!prompt) {
    return c.json({ error: "prompt required" }, 400);
  }
  if (prompt.length > 2000) {
    return c.json({ error: "prompt too long (max 2000 chars)" }, 400);
  }

  // Pick any active model the admin can use. The policy router requires
  // an `originalModelId` baseline, but for this admin-only tool we
  // don't have a pre-selected model — just grab the first active model
  // the admin has access to. If none, fall back to any active model
  // (admins bypass access checks elsewhere, but be explicit here).
  // We also join `providers.type` so we know which harness to dispatch
  // to without a second round-trip.
  const rows = await sql<{
    id: string;
    external_id: string;
    provider_id: string;
    provider_type: string;
    display_name: string;
  }[]>`
    SELECT m.id, m.external_id, m.provider_id, p.type AS provider_type, m.display_name
      FROM models m
      JOIN providers p ON p.id = m.provider_id
     WHERE m.state = 'active'
       AND (EXISTS (
             SELECT 1 FROM model_access ma
              WHERE ma.model_id = m.id AND ma.user_id = ${admin.id}::uuid
           )
           OR ${admin.role === "admin"})
     ORDER BY m.display_name
     LIMIT 1
  `;
  let chosen = rows[0];
  if (!chosen) {
    const fallback = await sql<{
      id: string;
      external_id: string;
      provider_id: string;
      provider_type: string;
      display_name: string;
    }[]>`
      SELECT m.id, m.external_id, m.provider_id, p.type AS provider_type, m.display_name
        FROM models m
        JOIN providers p ON p.id = m.provider_id
       WHERE m.state = 'active'
       ORDER BY m.display_name
       LIMIT 1
    `;
    chosen = fallback[0];
  }
  if (!chosen) {
    return c.json(
      { error: "no_model_available", detail: "add an AI provider + activate a model to use AI drafting" },
      400,
    );
  }

  const harnessKind = isHarnessKind(chosen.provider_type) ? chosen.provider_type : "openai";
  if (!isHarnessKind(harnessKind)) {
    return c.json({ error: "model_harness_unavailable" }, 502);
  }
  const harness = getHarnessByKind(harnessKind);
  const system = [
    "You design HELM apps. The user will describe what they want.",
    "Respond with a single JSON object and NOTHING else — no prose, no code fences, no markdown.",
    "Required keys:",
    `  "name"        — short human label, title case, 2-4 words (e.g. "Daily Standup")`,
    `  "slug"        — kebab-case url path derived from the name, 2-48 chars, lowercase letters/digits/hyphens (e.g. "daily-standup")`,
    `  "description" — one sentence (max 140 chars) describing what the app does`,
    `  "bundle_url"  — path where the frontend bundle will be served. Default to "/apps/<slug>-app/" — only deviate if the user explicitly says they host the bundle elsewhere.`,
    `  "html"        — a complete single-file HTML document (no SDK script tag — that's injected automatically) implementing the described app.`,
    "",
    "HELM SDK (window.helmApp) — use these to connect with HELM features:",
    `  Core: helmApp.me (user), helmApp.install.id (per-install key), helmApp.theme ('light'|'dark')`,
    `  Persistence: helmApp.data.get(key) / .set(key, value) / .del(key) / .list()`,
    `  Notifications: helmApp.toast({title, description, tone: 'info'|'success'|'warning'})`,
    `  Navigation: helmApp.navigate('/path') or helmApp.openPanel(panelId)`,
    `  Raw backend: helmApp.callAPI(path, {method, body}) — e.g. callAPI('/panels', {method:'GET'})`,
    `  Typed helpers:`,
    `    helmApp.panels.list()                    — panels the user belongs to`,
    `    helmApp.panels.get(panelId)              — single panel details`,
    `    helmApp.panels.messages(panelId, {limit, before})  — recent messages`,
    `    helmApp.chat.complete({messages, system, model})   — one-shot LLM call (auto-picks a model if none given; returns {content, model})`,
    `    helmApp.users.search(query)              — search user directory`,
    `    helmApp.users.me()                       — get current user`,
    `    helmApp.models.list()                    — list usable models`,
    "",
    "When the prompt implies HELM integration, USE THE TYPED HELPERS rather than raw callAPI. Render at least one piece of real, working UI that demonstrates the integration. Show actual data, not placeholders.",
    "Style: CSS variables —bg:#0B0E12, --panel:#14171d, --border:#2a2f38, --text:#e6e6e6, --muted:#9aa0a6, --faint:#6a707a, --brass:#C9A227, --teal:#4c9c90. Use ui-monospace font. Dense, keyboard-friendly, monospace numerics.",
    "Keep total html under 8KB. Do not include version, permissions, routes, or data_sources — those are filled in later.",
  ].join("\n");

  let assembled = "";
  try {
    const stream = harness.chat({
      model: chosen.external_id,
      system,
      messages: [{ role: "user", content: prompt }],
      temperature: 0.4,
      maxTokens: 6000,
    });
    for await (const chunk of stream) {
      if (chunk.error) {
        return c.json({ error: "model_error", detail: chunk.error }, 502);
      }
      if (chunk.delta) assembled += chunk.delta;
      if (chunk.done) break;
    }
  } catch (err) {
    console.warn("[apps.generate] harness.chat failed:", (err as Error).message);
    return c.json({ error: "model_error", detail: (err as Error).message }, 502);
  }

  const parsed = extractJsonObject(assembled);
  if (!parsed) {
    return c.json(
      { error: "model_returned_unparseable", detail: assembled.slice(0, 240) },
      502,
    );
  }

  // Coerce + validate the model's output. If the slug is bad we
  // re-derive it from the name so the admin never sees a draft that's
  // guaranteed to be rejected by the create endpoint.
  const name = String(parsed.name ?? "").trim().slice(0, 80) || "Untitled App";
  let slug = slugify(String(parsed.slug ?? ""));
  if (!slug) slug = slugify(name);
  if (!SLUG_RX.test(slug)) slug = slugify(name);
  if (!slug) slug = "untitled-app";
  const description = String(parsed.description ?? "").trim().slice(0, 240);
  const bundleUrl = String(parsed.bundle_url ?? "").trim() || `/apps/${slug}-app/`;
  // The AI may or may not include `html` — if it does, the frontend
  // will forward it on POST /api/apps and we'll write it to disk. If
  // not, the create handler falls back to the placeholder bundle.
  const html = typeof parsed.html === "string" && parsed.html.includes("<")
    ? parsed.html
    : null;

  return c.json({ name, slug, description, bundle_url: bundleUrl, html });
});

router.post("/", requireAdmin, async (c) => {
  const admin = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as {
    slug?: string;
    name?: string;
    description?: string;
    bundle_url?: string | null;
    routes?: unknown;
    data_sources?: unknown;
    permissions?: unknown;
    version?: string;
    enabled?: boolean;
    /** Optional full bundle HTML returned by /generate. When present
     *  we write it to the bundle directory instead of the placeholder. */
    html?: string | null;
  };
  const slug = (body.slug ?? "").trim().toLowerCase();
  const name = (body.name ?? "").trim();
  if (!SLUG_RX.test(slug)) {
    return c.json({ error: "slug must be kebab-case (a-z0-9-)" }, 400);
  }
  if (!name) return c.json({ error: "name required" }, 400);
  if (body.bundle_url !== undefined && body.bundle_url !== null && body.bundle_url !== "") {
    try {
      new URL(body.bundle_url, c.req.url);
    } catch {
      return c.json({ error: "bundle_url must be a URL or a /-prefixed path" }, 400);
    }
  }
  const version = (body.version ?? "0.1.0").trim() || "0.1.0";
  const enabled = body.enabled === false ? false : true;
  let id: string;
  try {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO apps (slug, name, description, bundle_url, routes, data_sources,
                        permissions, version, enabled, created_by)
      VALUES (${slug}, ${name}, ${body.description ?? ""},
              ${body.bundle_url ?? null}, ${sql.json((body.routes ?? []) as never)},
              ${sql.json((body.data_sources ?? []) as never)},
              ${sql.json((body.permissions ?? []) as never)},
              ${version}, ${enabled}, ${admin.id}::uuid)
      RETURNING id
    `;
    id = rows[0]!.id;
  } catch (err) {
    if ((err as Error).message.includes("apps_slug_key")) {
      return c.json({ error: "slug_taken" }, 409);
    }
    throw err;
  }

  // Write the bundle:
  //   1. If the AI produced a full html bundle (from /generate), use it.
  //   2. Otherwise, seed a placeholder so the Open button works immediately.
  // In both cases the bundle server's transformAppHtml injects the SDK.
  const bundleUrl = (body.bundle_url ?? "").trim();
  const description = (body.description ?? "").trim();
  const aiHtml = typeof body.html === "string" && body.html.includes("<") ? body.html : null;
  if (bundleUrl.startsWith("/apps/")) {
    try {
      const slugDir = join(BUNDLES_ROOT, `${slug}-app`);
      await mkdir(slugDir, { recursive: true });
      const bundlePath = join(slugDir, "index.html");
      const rawHtml = aiHtml ?? buildPlaceholderBundleHtml(name, description, bundleUrl, slug);
      const transformed = transformAppHtml(rawHtml);
      await Bun.write(bundlePath, transformed);
    } catch (err) {
      // Non-fatal — the app is created in the DB; the admin can still
      // upload a real bundle later. Log and continue.
      console.warn(`[apps.create] bundle write failed for ${slug}:`, (err as Error).message);
    }
  }

  await logAudit({
    userId: admin.id,
    target: id,
    action: "app_created",
    metadata: { slug, name, version, ai_generated: !!aiHtml },
  });
  return c.json({ id, slug });
});

// Build a minimal, immediately-usable HELM app bundle. The admin can
// replace this file with the real frontend code once the AI generation
// is done; the SDK is injected automatically by the bundle server.
function buildPlaceholderBundleHtml(name: string, description: string, bundleUrl: string, slug: string): string {
  const safeName = String(name || "Untitled App").replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
  const safeDesc = String(description || "").replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c]!,
  );
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeName} — HELM</title>
  <style>
    :root { --bg:#0B0E12; --panel:#14171d; --panel-alt:#1a1e25; --border:#2a2f38;
            --text:#e6e6e6; --muted:#9aa0a6; --faint:#6a707a; --brass:#C9A227; --teal:#4c9c90; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text);
           font-family: ui-monospace, "SF Mono", "JetBrains Mono", "Fira Code", monospace;
           font-size:13px; line-height:1.55; min-height:100vh; }
    .wrap { max-width: 720px; margin: 0 auto; padding: 48px 24px; }
    .badge { display:inline-block; padding:3px 8px; border:1px solid var(--brass);
             color:var(--brass); font-size:10px; letter-spacing:0.18em;
             text-transform:uppercase; }
    h1 { font-size:24px; font-weight:600; margin:14px 0 6px; }
    p { color:var(--muted); margin:0 0 28px; }
    .card { background:var(--panel); border:1px solid var(--border); padding:20px; }
    .row { display:flex; gap:16px; flex-wrap:wrap; }
    .field { flex:1; min-width:200px; }
    .label { font-size:10px; letter-spacing:0.18em; text-transform:uppercase;
             color:var(--faint); margin-bottom:4px; }
    .value { color:var(--text); }
    code { background:var(--panel-alt); padding:1px 6px; border:1px solid var(--border); }
    .hint { margin-top:24px; padding:16px; border:1px dashed var(--border); color:var(--faint); }
  </style>
</head>
<body>
  <div class="wrap">
    <span class="badge">HELM · placeholder bundle</span>
    <h1>${safeName}</h1>
    <p>${safeDesc || "Your app was created. Replace this file with the real frontend code."}</p>
    <div class="card">
      <div class="row">
        <div class="field">
          <div class="label">Bundle path</div>
          <div class="value"><code>${bundleUrl}</code></div>
        </div>
        <div class="field">
          <div class="label">Next step</div>
          <div class="value">Edit <code>apps-bundles/${slug}-app/index.html</code> and reload.</div>
        </div>
      </div>
    </div>
    <div class="hint">
      This is a placeholder auto-generated by HELM so the Open button works the moment
      you create the app. Use the <em>Generate draft</em> button in the New app form to
      have the AI scaffold the full bundle, or replace this file manually.
    </div>
  </div>
</body>
</html>`;
}

router.patch("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    description?: string;
    bundle_url?: string | null;
    routes?: unknown;
    data_sources?: unknown;
    permissions?: unknown;
    version?: string;
    enabled?: boolean;
    slug?: string;
  };
  const exists = await sql<{ id: string }[]>`
    SELECT id FROM apps WHERE id = ${id}::uuid LIMIT 1
  `;
  if (!exists[0]) return c.json({ error: "not_found" }, 404);
  if (typeof body.slug === "string") {
    const newSlug = body.slug.trim().toLowerCase();
    if (!SLUG_RX.test(newSlug)) {
      return c.json({ error: "slug must be kebab-case (a-z0-9-)" }, 400);
    }
    try {
      await sql`UPDATE apps SET slug = ${newSlug} WHERE id = ${id}::uuid`;
    } catch (err) {
      if ((err as Error).message.includes("apps_slug_key")) {
        return c.json({ error: "slug_taken" }, 409);
      }
      throw err;
    }
  }
  if (typeof body.name === "string") {
    await sql`UPDATE apps SET name = ${body.name} WHERE id = ${id}::uuid`;
  }
  if (typeof body.description === "string") {
    await sql`UPDATE apps SET description = ${body.description} WHERE id = ${id}::uuid`;
  }
  if (body.bundle_url !== undefined) {
    if (body.bundle_url === null || body.bundle_url === "") {
      await sql`UPDATE apps SET bundle_url = NULL WHERE id = ${id}::uuid`;
    } else {
      // Accept both absolute URLs (https://cdn/...) and same-origin
      // relative paths (/apps/<slug>/). The latter is the common case
      // for self-hosted bundles — `new URL("/apps/x/")` throws without
      // a base, so we resolve against the request origin.
      try {
        new URL(body.bundle_url, c.req.url);
      } catch {
        return c.json({ error: "bundle_url must be a URL or a /-prefixed path" }, 400);
      }
      await sql`UPDATE apps SET bundle_url = ${body.bundle_url} WHERE id = ${id}::uuid`;
    }
  }
  if (body.routes !== undefined) {
    await sql`UPDATE apps SET routes = ${sql.json(body.routes as never)} WHERE id = ${id}::uuid`;
  }
  if (body.data_sources !== undefined) {
    await sql`UPDATE apps SET data_sources = ${sql.json(body.data_sources as never)} WHERE id = ${id}::uuid`;
  }
  if (body.permissions !== undefined) {
    await sql`UPDATE apps SET permissions = ${sql.json(body.permissions as never)} WHERE id = ${id}::uuid`;
  }
  if (typeof body.version === "string" && body.version.trim()) {
    await sql`UPDATE apps SET version = ${body.version.trim()} WHERE id = ${id}::uuid`;
  }
  if (typeof body.enabled === "boolean") {
    await sql`UPDATE apps SET enabled = ${body.enabled} WHERE id = ${id}::uuid`;
  }
  await sql`UPDATE apps SET updated_at = now() WHERE id = ${id}::uuid`;
  await logAudit({
    userId: c.get("user").id,
    target: id,
    action: "app_updated",
    metadata: { fields: Object.keys(body).join(",") },
  });
  return c.json({ ok: true });
});

router.delete("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  // Look up the slug before deleting so we can remove the bundle
  // directory on disk. Failing to clean up disk is non-fatal — the
  // app is removed from the registry either way.
  const rows = await sql<{ slug: string; bundle_url: string | null }[]>`
    SELECT slug, bundle_url FROM apps WHERE id = ${id}::uuid
  `;
  await sql`DELETE FROM apps WHERE id = ${id}::uuid`;
  const removed = rows[0];
  if (removed) {
    const dirsToTry = [
      join(BUNDLES_ROOT, `${removed.slug}-app`),
      join(BUNDLES_ROOT, removed.slug),
    ];
    for (const dir of dirsToTry) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (err) {
        console.warn(`[apps.delete] bundle cleanup failed for ${dir}:`, (err as Error).message);
      }
    }
  }
  await logAudit({
    userId: c.get("user").id,
    target: id,
    action: "app_deleted",
    metadata: removed ? { slug: removed.slug } : undefined,
  });
  return c.json({ ok: true });
});

export default router;