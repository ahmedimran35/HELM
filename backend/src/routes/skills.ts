// Skills + Skill Packs (P3 of qm-parity).
//
// A skill is a markdown doc with optional YAML frontmatter describing a
// reusable agent behavior. A skill_pack bundles many skills (typically
// imported from a git repo). Per-panel grants opt a panel into a skill
// (those endpoints live in routes/panels.ts because they hang off
// /api/panels/... — mounting two routers at the same prefix in Hono would
// be ambiguous for matching paths).
//
// This module exports two routers:
//
//   skillsRouter mounted at /api/skills:
//     GET    /                  — list skills (?scope=&pack_id=&kind=)
//     GET    /:id               — single skill with body
//     POST   /         (admin)  — create
//     PATCH  /:id      (admin)  — update
//     DELETE /:id      (admin)  — remove
//
//   packsRouter mounted at /api/skill-packs:
//     GET    /                  — list packs
//     POST   /         (admin)  — create pack
//     POST   /:id/import (admin) — pull from source (git / local / inline)
//
// Auth: every endpoint requires a logged-in user; mutations are admin-only.

import { Hono } from "hono";
import { mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAdmin } from "../middleware/role.ts";
import { logAudit } from "../lib/audit.ts";

const ALLOWED_KINDS = new Set(["prompt", "tool", "workflow"]);
const ALLOWED_SCOPES = new Set(["org", "panel", "user"]);
const ALLOWED_SOURCES = new Set(["git:url", "local:path", "inline"]);

// ─────────────────────────────────────────────────────────────────────
// Skills router
// ─────────────────────────────────────────────────────────────────────

export const skillsRouter = new Hono();
skillsRouter.use("*", requireAuth);

skillsRouter.get("/", async (c) => {
  const user = c.get("user");
  const isAdmin = user.role === "admin";
  const scope = c.req.query("scope");
  const packId = c.req.query("pack_id");
  const kind = c.req.query("kind");

  // Each filter is built as a parameterised postgres.js fragment, so
  // user input is always escaped at the driver layer — no `sql.unsafe`.
  const conditions: ReturnType<typeof sql>[] = [];
  if (scope && ALLOWED_SCOPES.has(scope)) {
    conditions.push(sql`s.scope = ${scope}`);
  }
  if (packId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(packId)) {
    conditions.push(sql`s.pack_id = ${packId}::uuid`);
  }
  if (kind && ALLOWED_KINDS.has(kind)) {
    conditions.push(sql`s.kind = ${kind}`);
  }
  // Compose the WHERE with sql.join-like behaviour by appending a
  // homogeneous fragment to a base query.
  let whereFragment = sql`TRUE`;
  for (const cond of conditions) {
    whereFragment = sql`${whereFragment} AND ${cond}`;
  }

  // `available_to_user`:
  //   - skills with scope=org are available to everyone
  //   - skills with scope=panel are available only if a grant exists for one of the
  //     user's panels (admins bypass — they always see org + panel skills)
  //   - skills with scope=user and owner_user_id=me are available to me
  // We compute this server-side so the client doesn't have to re-derive the
  // access rules on every render.
  const rows = await sql<{
    id: string;
    pack_id: string | null;
    name: string;
    description: string;
    scope: string;
    owner_user_id: string | null;
    owner_panel_id: string | null;
    kind: string;
    tags: string[];
    version: string;
    available_to_user: boolean;
    created_at: Date;
    updated_at: Date;
  }[]>`
    SELECT
      s.id, s.pack_id, s.name, s.description, s.scope,
      s.owner_user_id, s.owner_panel_id, s.kind, s.tags, s.version,
      s.created_at, s.updated_at,
      CASE
        WHEN ${isAdmin}::boolean THEN TRUE
        WHEN s.scope = 'org' THEN TRUE
        WHEN s.scope = 'panel' THEN EXISTS (
          SELECT 1 FROM skill_grants g
          WHERE g.skill_id = s.id
            AND g.panel_id IN (SELECT panel_id FROM panel_members WHERE user_id = ${user.id}::uuid)
        )
        WHEN s.scope = 'user' THEN s.owner_user_id = ${user.id}::uuid
        ELSE FALSE
      END AS available_to_user
    FROM skills s
    WHERE ${whereFragment}
    ORDER BY s.created_at ASC
  `;
  return c.json(rows);
});

skillsRouter.get("/:id", async (c) => {
  const user = c.get("user");
  const isAdmin = user.role === "admin";
  const id = c.req.param("id");
  const rows = await sql<{
    id: string;
    pack_id: string | null;
    name: string;
    description: string;
    body: string;
    scope: string;
    owner_user_id: string | null;
    owner_panel_id: string | null;
    kind: string;
    tags: string[];
    version: string;
    available_to_user: boolean;
    created_at: Date;
    updated_at: Date;
  }[]>`
    SELECT
      s.id, s.pack_id, s.name, s.description, s.body, s.scope,
      s.owner_user_id, s.owner_panel_id, s.kind, s.tags, s.version,
      s.created_at, s.updated_at,
      CASE
        WHEN ${isAdmin}::boolean THEN TRUE
        WHEN s.scope = 'org' THEN TRUE
        WHEN s.scope = 'panel' THEN EXISTS (
          SELECT 1 FROM skill_grants g
          WHERE g.skill_id = s.id
            AND g.panel_id IN (SELECT panel_id FROM panel_members WHERE user_id = ${user.id}::uuid)
        )
        WHEN s.scope = 'user' THEN s.owner_user_id = ${user.id}::uuid
        ELSE FALSE
      END AS available_to_user
    FROM skills s
    WHERE s.id = ${id}::uuid
    LIMIT 1
  `;
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  const skill = rows[0];
  if (!skill.available_to_user) {
    return c.json({ error: "forbidden" }, 403);
  }
  return c.json(skill);
});

skillsRouter.post("/", requireAdmin, async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    description?: string;
    body?: string;
    kind?: string;
    scope?: string;
    pack_id?: string;
  };

  const name = (body.name ?? "").trim();
  if (!name) return c.json({ error: "name required" }, 400);

  const rawBody = typeof body.body === "string" ? body.body : "";
  if (!rawBody.trim()) return c.json({ error: "body required" }, 400);

  // Parse YAML frontmatter if present (`---\nname: ...\n---`). We do NOT
  // pull in a YAML lib — we only need a handful of keys and frontmatter is
  // a stable shape. Falls back to the explicit fields if there's no
  // frontmatter in the body.
  const parsed = parseFrontmatter(rawBody);
  const effectiveName =
    parsed.name && parsed.name.length > 0 ? parsed.name : name;
  const effectiveDescription =
    parsed.description ?? (body.description ?? "").trim();
  const effectiveKind =
    parsed.kind && ALLOWED_KINDS.has(parsed.kind)
      ? parsed.kind
      : typeof body.kind === "string" && ALLOWED_KINDS.has(body.kind)
      ? body.kind
      : "prompt";
  const effectiveScope =
    parsed.scope && ALLOWED_SCOPES.has(parsed.scope)
      ? parsed.scope
      : typeof body.scope === "string" && ALLOWED_SCOPES.has(body.scope)
      ? body.scope
      : "org";
  const packId =
    parsed.pack_id ?? (typeof body.pack_id === "string" ? body.pack_id : null);

  const rows = await sql<{ id: string }[]>`
    INSERT INTO skills
      (pack_id, name, description, body, scope, owner_user_id, kind, tags)
    VALUES
      (${packId}::uuid, ${effectiveName}, ${effectiveDescription},
       ${parsed.body}, ${effectiveScope}, ${user.id}::uuid,
       ${effectiveKind}, ${parsed.tags})
    RETURNING id
  `;
  await logAudit({
    userId: user.id,
    target: rows[0]!.id,
    action: "skill_created",
    metadata: { name: effectiveName, kind: effectiveKind },
  });
  return c.json({ id: rows[0]!.id });
});

skillsRouter.patch("/:id", requireAdmin, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    description?: string;
    body?: string;
    kind?: string;
    scope?: string;
  };

  // Single-field updates — same pattern as panels.ts PATCH. Cheap and
  // explicit; lets us validate each field type before touching the DB.
  if (typeof body.name === "string") {
    const trimmed = body.name.trim();
    if (!trimmed) return c.json({ error: "name cannot be empty" }, 400);
    await sql`UPDATE skills SET name = ${trimmed}, updated_at = now() WHERE id = ${id}::uuid`;
  }
  if (typeof body.description === "string") {
    await sql`UPDATE skills SET description = ${body.description}, updated_at = now() WHERE id = ${id}::uuid`;
  }
  if (typeof body.body === "string") {
    if (!body.body.trim()) return c.json({ error: "body cannot be empty" }, 400);
    const parsed = parseFrontmatter(body.body);
    await sql`UPDATE skills SET body = ${parsed.body}, updated_at = now() WHERE id = ${id}::uuid`;
  }
  if (typeof body.kind === "string") {
    if (!ALLOWED_KINDS.has(body.kind)) {
      return c.json({ error: "invalid kind" }, 400);
    }
    await sql`UPDATE skills SET kind = ${body.kind}, updated_at = now() WHERE id = ${id}::uuid`;
  }
  if (typeof body.scope === "string") {
    if (!ALLOWED_SCOPES.has(body.scope)) {
      return c.json({ error: "invalid scope" }, 400);
    }
    await sql`UPDATE skills SET scope = ${body.scope}, updated_at = now() WHERE id = ${id}::uuid`;
  }

  await logAudit({
    userId: user.id,
    target: id,
    action: "skill_updated",
  });
  return c.json({ ok: true });
});

skillsRouter.delete("/:id", requireAdmin, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  await sql`DELETE FROM skills WHERE id = ${id}::uuid`;
  await logAudit({
    userId: user.id,
    target: id,
    action: "skill_deleted",
  });
  return c.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────
// Skill Packs router
// ─────────────────────────────────────────────────────────────────────

export const packsRouter = new Hono();
packsRouter.use("*", requireAuth);

packsRouter.get("/", async (c) => {
  const rows = await sql<{
    id: string;
    name: string;
    source: string;
    source_ref: string;
    description: string;
    version: string;
    enabled: boolean;
    created_at: Date;
    updated_at: Date;
    skill_count: number;
  }[]>`
    SELECT p.id, p.name, p.source, p.source_ref, p.description, p.version,
           p.enabled, p.created_at, p.updated_at,
           (SELECT count(*)::int FROM skills s WHERE s.pack_id = p.id) AS skill_count
    FROM skill_packs p
    ORDER BY p.created_at ASC
  `;
  return c.json(rows);
});

packsRouter.post("/", requireAdmin, async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    source?: string;
    source_ref?: string;
    description?: string;
  };
  const name = (body.name ?? "").trim();
  if (!name) return c.json({ error: "name required" }, 400);
  const source = body.source ?? "";
  if (!ALLOWED_SOURCES.has(source)) {
    return c.json(
      { error: "source must be one of git:url, local:path, inline" },
      400,
    );
  }
  const sourceRef = (body.source_ref ?? "").trim();
  if (!sourceRef) return c.json({ error: "source_ref required" }, 400);
  try {
    const rows = await sql<{ id: string }[]>`
      INSERT INTO skill_packs (name, source, source_ref, description)
      VALUES (${name}, ${source}, ${sourceRef}, ${body.description ?? ""})
      RETURNING id
    `;
    await logAudit({
      userId: user.id,
      target: rows[0]!.id,
      action: "skill_pack_created",
      metadata: { name, source },
    });
    return c.json({ id: rows[0]!.id });
  } catch (err) {
    if ((err as Error).message.includes("skill_packs_name_key")) {
      return c.json({ error: "name_taken" }, 409);
    }
    throw err;
  }
});

packsRouter.post("/:id/import", requireAdmin, async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const rows = await sql<{
    id: string;
    name: string;
    source: string;
    source_ref: string;
  }[]>`
    SELECT id, name, source, source_ref FROM skill_packs WHERE id = ${id}::uuid LIMIT 1
  `;
  const pack = rows[0];
  if (!pack) return c.json({ error: "not_found" }, 404);

  let imported = 0;
  try {
    if (pack.source === "git:url") {
      imported = await importFromGit(pack);
    } else if (pack.source === "local:path") {
      imported = await importFromLocal(pack);
    } else if (pack.source === "inline") {
      // Nothing to do — inline packs have their skills authored by hand.
      imported = 0;
    } else {
      return c.json({ error: "unknown source" }, 400);
    }
  } catch (err) {
    console.warn("skill pack import failed:", (err as Error).message);
    return c.json(
      { error: "import_failed", detail: (err as Error).message },
      500,
    );
  }

  await sql`UPDATE skill_packs SET updated_at = now() WHERE id = ${id}::uuid`;
  await logAudit({
    userId: user.id,
    target: id,
    action: "skill_pack_imported",
    metadata: { imported, source: pack.source },
  });
  return c.json({ imported });
});

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

interface ParsedSkill {
  name: string;
  description: string;
  body: string;
  kind: string;
  scope: string;
  pack_id: string | null;
  tags: string[];
}

/**
 * Very small YAML-frontmatter parser. Looks for `---\n...\n---` at the very
 * top of the body and parses simple `key: value` lines plus a flat `tags:
 * [a, b]` list. Anything else is left alone and falls back to the explicit
 * API fields.
 *
 * Intentionally tiny — skills are written by humans / admins, not by a
 * machine pipeline. The goal is just to honor the convention that's common
 * in skill repos (e.g. Anthropic's skills format).
 */
function parseFrontmatter(raw: string): ParsedSkill {
  const trimmed = raw.replace(/^\uFEFF/, "");
  if (!trimmed.startsWith("---")) {
    return {
      name: "",
      description: "",
      body: raw,
      kind: "",
      scope: "",
      pack_id: null,
      tags: [],
    };
  }
  // Find the closing fence. Must be at the start of a line.
  const rest = trimmed.slice(3);
  const afterLead = rest.startsWith("\n") ? rest.slice(1) : rest;
  const closeIdx = afterLead.indexOf("\n---");
  if (closeIdx < 0) {
    return {
      name: "",
      description: "",
      body: raw,
      kind: "",
      scope: "",
      pack_id: null,
      tags: [],
    };
  }
  const fmBlock = afterLead.slice(0, closeIdx);
  const bodyAfter = afterLead.slice(closeIdx + 4).replace(/^\n/, "");

  const fm: Record<string, string | string[]> = {};
  for (const line of fmBlock.split("\n")) {
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.startsWith("[") && value.endsWith("]")) {
      // inline list: [a, b, c]
      value = value.slice(1, -1).trim();
      fm[key] = value.length > 0
        ? value.split(",").map((v) => v.trim()).filter(Boolean)
        : [];
    } else if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      fm[key] = value.slice(1, -1);
    } else {
      fm[key] = value;
    }
  }

  return {
    name: typeof fm.name === "string" ? fm.name : "",
    description: typeof fm.description === "string" ? fm.description : "",
    body: bodyAfter.length > 0 ? bodyAfter : raw,
    kind: typeof fm.kind === "string" ? fm.kind : "",
    scope: typeof fm.scope === "string" ? fm.scope : "",
    pack_id: typeof fm.pack_id === "string" ? fm.pack_id : null,
    tags: Array.isArray(fm.tags) ? fm.tags : [],
  };
}

function tmpDirForPack(packId: string): string {
  const base = join(tmpdir(), "helm-skills", packId);
  mkdirSync(base, { recursive: true });
  return base;
}

async function importFromGit(pack: {
  id: string;
  source_ref: string;
}): Promise<number> {
  // Bun.spawn `git clone --depth 1 <url> <dir>`. We discard the URL into a
  // private tmpdir so the operator can re-import without polluting the
  // repo. A non-zero exit means the clone failed — surface it.
  const dir = tmpDirForPack(pack.id);
  // Wipe any prior contents so we always start clean.
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  const proc = Bun.spawn({
    cmd: ["git", "clone", "--depth", "1", pack.source_ref, "."],
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  });
  const exit = await proc.exited;
  if (exit !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`git clone failed (exit ${exit}): ${err.trim()}`);
  }
  return await ingestDir(pack.id, dir);
}

async function importFromLocal(pack: {
  id: string;
  source_ref: string;
}): Promise<number> {
  // For local:path we just read straight from disk. No copy — the source
  // is operator-owned. We refuse to ingest if the path doesn't exist so
  // the operator gets a clear error instead of an empty import.
  const dir = pack.source_ref;
  let entries: string[];
  try {
    entries = readdirSync(dir);
    if (entries.length === 0) {
      throw new Error(`source path is empty: ${dir}`);
    }
  } catch (err) {
    throw new Error(
      `cannot read source path "${dir}": ${(err as Error).message}`,
    );
  }
  return await ingestDir(pack.id, dir);
}

async function ingestDir(packId: string, dir: string): Promise<number> {
  // Walk the dir for *.md / *.markdown files (one level deep is fine for
  // v1). For each, parse frontmatter + body and INSERT.
  const entries = readdirSync(dir, { withFileTypes: true });
  let imported = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/\.(md|markdown)$/i.test(entry.name)) continue;
    const raw = readFileSync(join(dir, entry.name), "utf8");
    const parsed = parseFrontmatter(raw);
    // Fall back to filename (without extension) for the name.
    const fallbackName = entry.name.replace(/\.(md|markdown)$/i, "");
    const name = (parsed.name || fallbackName).trim();
    if (!name) continue;
    try {
      // Parameterised insert — every user-supplied field goes through
      // a tagged template so escaping happens at the driver layer.
      const safeKind =
        parsed.kind && ALLOWED_KINDS.has(parsed.kind) ? parsed.kind : "prompt";
      const safeScope =
        parsed.scope && ALLOWED_SCOPES.has(parsed.scope)
          ? parsed.scope
          : "org";
      // Tags are untrusted YAML array — validate each is a plain string
      // and bound as a JSON array (postgres.js handles jsonb arrays).
      const safeTags = (parsed.tags ?? []).filter(
        (t): t is string => typeof t === "string" && t.length > 0 && t.length < 200,
      );
      await sql`
        INSERT INTO skills (pack_id, name, description, body, kind, scope, tags)
        VALUES (${packId}::uuid, ${name}, ${parsed.description ?? ""},
                ${parsed.body}, ${safeKind}, ${safeScope}, ${sql.json(safeTags)})
        ON CONFLICT DO NOTHING
      `;
      imported++;
    } catch (err) {
      console.warn(
        `skill import skipped (${entry.name}): ${(err as Error).message}`,
      );
    }
  }
  return imported;
}
