// Marketplace (Tier 4: Discovery). Versioned catalogue of skill packs,
// app templates, workflow templates and personas that any user can
// install and rate.
//
// Routes:
//   GET    /api/marketplace                 — paginated list (kind, search, sort)
//   GET    /api/marketplace/:id             — single entry + manifest + recent reviews
//   POST   /api/marketplace/:id/install     — install for current user
//   DELETE /api/marketplace/:id/install     — uninstall
//   GET    /api/marketplace/:id/reviews     — list ratings + comments
//   POST   /api/marketplace/:id/reviews     — submit { rating, comment }
//
// Sort values: "popular" (default), "rating", "newest".
//
// Ratings live on `marketplace_reviews` (sibling table to keep the
// catalogue schema clean). Aggregated rating on the entry is recomputed
// in a single UPDATE inside a transaction whenever a review lands.

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { validate, validationErrorResponse } from "../lib/validate.ts";
import { logAudit } from "../lib/audit.ts";

const router = new Hono();
router.use("*", requireAuth);

type SortKey = "popular" | "rating" | "newest";
const VALID_KINDS = new Set(["skill_pack", "app", "workflow_template", "persona"]);
const VALID_SORTS: ReadonlyArray<SortKey> = ["popular", "rating", "newest"];

interface EntryRow {
  id: string;
  kind: "skill_pack" | "app" | "workflow_template" | "persona";
  slug: string;
  name: string;
  description: string;
  version: string;
  author: string | null;
  tags: string[];
  install_count: number;
  rating: number | null;
  manifest: unknown;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

router.get("/", async (c) => {
  const kindFilter = c.req.query("kind") ?? "";
  const search = (c.req.query("search") ?? "").trim().toLowerCase();
  const sortRaw = (c.req.query("sort") ?? "popular").toLowerCase();
  const sort: SortKey = (VALID_SORTS as readonly string[]).includes(sortRaw)
    ? (sortRaw as SortKey)
    : "popular";
  const limit = Math.min(60, Math.max(1, Number(c.req.query("limit") ?? 48)));
  const offset = Math.max(0, Number(c.req.query("offset") ?? 0));

  // Build order clause dynamically. We need to keep the parametrised
  // sql composition; only the ORDER BY tail varies.
  const orderBy =
    sort === "rating"
      ? sql`rating DESC NULLS LAST, install_count DESC`
      : sort === "newest"
        ? sql`created_at DESC`
        : sql`install_count DESC, created_at DESC`;

  const rows = await sql<EntryRow[]>`
    SELECT id, kind, slug, name, description, version, author, tags,
           install_count, rating, manifest, enabled, created_at, updated_at
    FROM marketplace_entries
    WHERE enabled = TRUE
      ${kindFilter && VALID_KINDS.has(kindFilter)
        ? sql`AND kind = ${kindFilter}`
        : sql``}
      ${search
        ? sql`AND (
            LOWER(name) LIKE ${"%" + search + "%"}
            OR LOWER(description) LIKE ${"%" + search + "%"}
            OR LOWER(COALESCE(author, '')) LIKE ${"%" + search + "%"}
            OR EXISTS (SELECT 1 FROM unnest(tags) t WHERE LOWER(t) LIKE ${"%" + search + "%"})
          )`
        : sql``}
    ORDER BY ${orderBy}
    LIMIT ${limit} OFFSET ${offset}
  `;

  // Also count total for pagination. Done as a separate query — small
  // extra cost but keeps the rendering code straightforward.
  const totalRows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM marketplace_entries WHERE enabled = TRUE
      ${kindFilter && VALID_KINDS.has(kindFilter)
        ? sql`AND kind = ${kindFilter}`
        : sql``}
      ${search
        ? sql`AND (
            LOWER(name) LIKE ${"%" + search + "%"}
            OR LOWER(description) LIKE ${"%" + search + "%"}
            OR LOWER(COALESCE(author, '')) LIKE ${"%" + search + "%"}
            OR EXISTS (SELECT 1 FROM unnest(tags) t WHERE LOWER(t) LIKE ${"%" + search + "%"})
          )`
        : sql``}
  `;

  // Mark which ones the current user already has installed so the
  // frontend can show "Installed" instead of "Install".
  const user = c.get("user");
  const installedRows = await sql<{ entry_id: string }[]>`
    SELECT entry_id FROM marketplace_installs WHERE user_id = ${user.id}::uuid
  `;
  const installedSet = new Set(installedRows.map((r) => r.entry_id));

  return c.json({
    entries: rows.map((r) => ({
      ...r,
      installed: installedSet.has(r.id),
    })),
    total: totalRows[0]?.n ?? 0,
    limit,
    offset,
    sort,
  });
});

router.get("/:id", async (c) => {
  const id = c.req.param("id");
  const rows = await sql<EntryRow[]>`
    SELECT id, kind, slug, name, description, version, author, tags,
           install_count, rating, manifest, enabled, created_at, updated_at
    FROM marketplace_entries WHERE id = ${id}::uuid LIMIT 1
  `;
  const entry = rows[0];
  if (!entry) return c.json({ error: "not_found" }, 404);

  const reviews = await sql<{
    id: string;
    user_id: string | null;
    username: string | null;
    name: string | null;
    rating: number;
    comment: string | null;
    created_at: Date;
  }[]>`
    SELECT r.id, r.user_id, u.username, u.name, r.rating, r.comment, r.created_at
    FROM marketplace_reviews r
    LEFT JOIN users u ON u.id = r.user_id
    WHERE r.entry_id = ${id}::uuid
    ORDER BY r.created_at DESC
    LIMIT 12
  `;
  const user = c.get("user");
  const myInstall = await sql<{ id: string }[]>`
    SELECT id FROM marketplace_installs
    WHERE entry_id = ${id}::uuid AND user_id = ${user.id}::uuid LIMIT 1
  `;
  return c.json({
    entry,
    reviews,
    installed: !!myInstall[0],
  });
});

router.post("/:id/install", async (c) => {
  const slugOrId = c.req.param("id");
  const user = c.get("user");
  // The path param `id` may be either a slug or a UUID; resolve it to the
  // canonical entry UUID first so downstream queries can use uuid casts.
  const entries = await sql<{ id: string; version: string }[]>`
    SELECT id, version FROM marketplace_entries
    WHERE (id::text = ${slugOrId} OR slug = ${slugOrId})
      AND enabled = TRUE
    LIMIT 1
  `;
  const entry = entries[0];
  if (!entry) return c.json({ error: "not_found" }, 404);
  await sql`
    INSERT INTO marketplace_installs (entry_id, user_id, version)
    VALUES (${entry.id}::uuid, ${user.id}::uuid, ${entry.version})
    ON CONFLICT (entry_id, user_id) DO NOTHING
  `;
  await sql`
    UPDATE marketplace_entries SET install_count = install_count + 1 WHERE id = ${entry.id}::uuid
  `;
  await logAudit({
    userId: user.id,
    target: entry.id,
    action: "marketplace_installed",
  });
  return c.json({ ok: true });
});

router.delete("/:id/install", async (c) => {
  const slugOrId = c.req.param("id");
  const user = c.get("user");
  // Resolve slug → UUID first; the param can be either.
  const entries = await sql<{ id: string }[]>`
    SELECT id FROM marketplace_entries
    WHERE id::text = ${slugOrId} OR slug = ${slugOrId}
    LIMIT 1
  `;
  const entry = entries[0];
  if (!entry) return c.json({ ok: true, removed: 0 });
  const r = await sql`
    DELETE FROM marketplace_installs
    WHERE entry_id = ${entry.id}::uuid AND user_id = ${user.id}::uuid
    RETURNING entry_id
  `;
  if (r.length > 0) {
    // Floor of 0 — never display negative install counts.
    await sql`
      UPDATE marketplace_entries
      SET install_count = GREATEST(install_count - 1, 0)
      WHERE id = ${entry.id}::uuid
    `;
  }
  return c.json({ ok: true, removed: r.length });
});

router.get("/:id/reviews", async (c) => {
  const id = c.req.param("id");
  const limit = Math.min(50, Math.max(1, Number(c.req.query("limit") ?? 20)));
  const rows = await sql<{
    id: string;
    username: string | null;
    name: string | null;
    rating: number;
    comment: string | null;
    created_at: Date;
  }[]>`
    SELECT r.id, u.username, u.name, r.rating, r.comment, r.created_at
    FROM marketplace_reviews r
    LEFT JOIN users u ON u.id = r.user_id
    WHERE r.entry_id = ${id}::uuid
    ORDER BY r.created_at DESC
    LIMIT ${limit}
  `;
  return c.json(rows);
});

router.post("/:id/reviews", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  let body: { rating?: number; comment?: string };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      rating: { type: "number", min: 1, max: 5, integer: true },
      comment: { type: "string", maxLength: 2000, trim: true },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  const rating = body.rating;
  const comment = body.comment ?? "";
  if (typeof rating !== "number") return c.json({ error: "rating required (1-5)" }, 400);

  const exists = await sql<{ id: string }[]>`
    SELECT id FROM marketplace_entries WHERE id = ${id}::uuid LIMIT 1
  `;
  if (!exists[0]) return c.json({ error: "not_found" }, 404);

  // Upsert review (one per user per entry) and recompute aggregate
  // rating inside a single transaction so the catalogue card stays
  // accurate even under concurrent reviews.
  await sql.begin(async (tx) => {
    await tx`
      INSERT INTO marketplace_reviews (entry_id, user_id, rating, comment)
      VALUES (${id}::uuid, ${user.id}::uuid, ${rating}, ${comment})
      ON CONFLICT (entry_id, user_id) DO UPDATE
        SET rating = EXCLUDED.rating, comment = EXCLUDED.comment, created_at = now()
    `;
    const agg = await tx<{ avg: number | null; n: number }[]>`
      SELECT avg(rating)::numeric(3,2) AS avg, count(*)::int AS n
      FROM marketplace_reviews WHERE entry_id = ${id}::uuid
    `;
    const avg = agg[0]?.avg ?? null;
    await tx`UPDATE marketplace_entries SET rating = ${avg} WHERE id = ${id}::uuid`;
  });
  await logAudit({
    userId: user.id,
    target: id,
    action: "marketplace_reviewed",
    metadata: { rating },
  });
  return c.json({ ok: true });
});

export default router;
