// Panels (multiplayer rooms, docs §2.3) + Knowledge docs (real chunking +
// tsvector retrieval in `lib/retrieve.ts`).
//
//   GET    /api/panels                 — list panels visible to the user
//   POST   /api/panels                 (admin) — create a panel
//   GET    /api/panels/:id             — panel detail + members
//   PATCH  /api/panels/:id             (admin) — update name / agent model / persona
//   DELETE /api/panels/:id             (admin) — remove
//   POST   /api/panels/:id/members     (admin) — add user(s)
//   DELETE /api/panels/:id/members/:uid (admin) — remove user
//   GET    /api/panels/:id/messages    — recent chat history
//   POST   /api/panels/:id/knowledge   (member) — upload a doc (chunks, tsvector)
//   GET    /api/panels/:id/knowledge   (member) — list docs
//
// Chat itself goes over WebSocket (see ws.ts). This file handles HTTP CRUD.

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAdmin } from "../middleware/role.ts";
import { parsePagination, paginatedResponse } from "../lib/pagination.ts";
import { logAudit } from "../lib/audit.ts";
import { getPresence } from "../lib/presence.ts";
import { summarizePanel } from "../lib/summarize.ts";
import { autoSummarizePanel } from "../lib/auto-summarize.ts";
import {
  listSnapshots,
  getSnapshotsFrom,
  type PanelSnapshotState,
} from "../lib/snapshots.ts";

const router = new Hono();
router.use("*", requireAuth);

router.get("/", async (c) => {
  const user = c.get("user");
  const isAdmin = user.role === "admin";
  const page = parsePagination(c, { defaultLimit: 50, maxLimit: 200 });
  const rows = await sql<{
    id: string;
    name: string;
    agent_model_id: string | null;
    persona_id: string | null;
    created_at: Date;
    member_count: number;
    message_count: number;
  }[]>`
    SELECT p.id, p.name, p.agent_model_id, p.persona_id, p.created_at,
           (SELECT count(*) FROM panel_members WHERE panel_id = p.id)::int AS member_count,
           (SELECT count(*) FROM messages WHERE panel_id = p.id)::int AS message_count
    FROM panels p
    ${isAdmin
      ? sql``
      : sql`WHERE EXISTS (SELECT 1 FROM panel_members WHERE panel_id = p.id AND user_id = ${user.id}::uuid)`}
    ORDER BY p.created_at DESC
    LIMIT ${page.limit} OFFSET ${page.offset}
  `;
  return c.json(rows);
});

router.post("/", requireAdmin, async (c) => {
  const admin = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    agent_model_id?: string;
    persona_id?: string;
    member_ids?: string[];
  };
  const name = (body.name ?? "").trim();
  if (!name) return c.json({ error: "name required" }, 400);
  const memberIds = Array.isArray(body.member_ids) ? body.member_ids : [];
  const rows = await sql<{ id: string }[]>`
    INSERT INTO panels (name, agent_model_id, persona_id, created_by)
    VALUES (${name}, ${body.agent_model_id ?? null}::uuid, ${body.persona_id ?? null}::uuid, ${admin.id}::uuid)
    RETURNING id
  `;
  const panelId = rows[0]!.id;
  // Add the creator + the listed members.
  const all = Array.from(new Set([admin.id, ...memberIds]));
  for (const uid of all) {
    await sql`
      INSERT INTO panel_members (panel_id, user_id) VALUES (${panelId}::uuid, ${uid}::uuid)
      ON CONFLICT DO NOTHING
    `;
  }
  await logAudit({
    userId: admin.id,
    target: panelId,
    action: "panel_created",
    metadata: { name, member_count: all.length },
  });
  return c.json({ id: panelId });
});

router.get("/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  // Membership check (admins skip).
  if (user.role !== "admin") {
    const m = await sql<{ user_id: string }[]>`
      SELECT user_id FROM panel_members WHERE panel_id = ${id}::uuid AND user_id = ${user.id}::uuid LIMIT 1
    `;
    if (!m[0]) return c.json({ error: "forbidden" }, 403);
  }
  const rows = await sql<{
    id: string;
    name: string;
    agent_model_id: string | null;
    persona_id: string | null;
    agent_model_name: string | null;
    persona_name: string | null;
    created_at: Date;
  }[]>`
    SELECT p.id, p.name, p.agent_model_id, p.persona_id, p.created_at,
           md.display_name AS agent_model_name, pe.name AS persona_name
    FROM panels p
    LEFT JOIN models md ON md.id = p.agent_model_id
    LEFT JOIN personas pe ON pe.id = p.persona_id
    WHERE p.id = ${id}::uuid
    LIMIT 1
  `;
  if (!rows[0]) return c.json({ error: "not_found" }, 404);
  const members = await sql<{
    user_id: string;
    username: string;
    name: string;
    role: string;
    joined_at: Date;
  }[]>`
    SELECT pm.user_id, u.username, u.name, u.role, pm.joined_at
    FROM panel_members pm JOIN users u ON u.id = pm.user_id
    WHERE pm.panel_id = ${id}::uuid
    ORDER BY pm.joined_at ASC
  `;
  return c.json({ ...rows[0], members });
});

router.patch("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    agent_model_id?: string | null;
    persona_id?: string | null;
  };
  const fields: string[] = [];
  const vals: unknown[] = [];
  if (typeof body.name === "string") {
    fields.push("name");
    vals.push(body.name);
  }
  // Build dynamic update with tagged-template approach would be heavy;
  // do explicit IFs.
  if (typeof body.name === "string") {
    await sql`UPDATE panels SET name = ${body.name} WHERE id = ${id}::uuid`;
  }
  if (body.agent_model_id !== undefined) {
    await sql`UPDATE panels SET agent_model_id = ${body.agent_model_id}::uuid WHERE id = ${id}::uuid`;
  }
  if (body.persona_id !== undefined) {
    await sql`UPDATE panels SET persona_id = ${body.persona_id}::uuid WHERE id = ${id}::uuid`;
  }
  return c.json({ ok: true });
});

router.delete("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  await sql`DELETE FROM panels WHERE id = ${id}::uuid`;
  await logAudit({ userId: c.get("user").id, target: id, action: "panel_deleted" });
  return c.json({ ok: true });
});

router.get("/:id/members", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  // Membership-gate: a user must be a member of the panel (or admin)
  // to see who else is in it. Without this every authenticated user
  // could enumerate members of any panel just by guessing UUIDs.
  const member = await sql<{ exists: number }[]>`
    SELECT EXISTS (
      SELECT 1 FROM panel_members
      WHERE panel_id = ${id}::uuid AND user_id = ${user.id}::uuid
    )::int AS exists
  `;
  const isAdmin = user.role === "admin";
  if (!isAdmin && (member[0]?.exists ?? 0) === 0) {
    return c.json({ error: "not_found" }, 404);
  }
  const exists = await sql<{ id: string }[]>`
    SELECT id FROM panels WHERE id = ${id}::uuid LIMIT 1
  `;
  if (!exists[0]) return c.json({ error: "not_found" }, 404);
  const rows = await sql<{
    user_id: string;
    username: string;
    name: string;
    role: string;
    joined_at: Date;
  }[]>`
    SELECT pm.user_id, u.username, u.name, u.role, pm.joined_at
    FROM panel_members pm
    JOIN users u ON u.id = pm.user_id
    WHERE pm.panel_id = ${id}::uuid
    ORDER BY pm.joined_at ASC
  `;
  return c.json(rows);
});

router.post("/:id/members", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as {
    user_ids?: string[];
  };
  const uids = Array.isArray(body.user_ids) ? body.user_ids : [];
  let added = 0;
  for (const uid of uids) {
    const r = await sql`
      INSERT INTO panel_members (panel_id, user_id) VALUES (${id}::uuid, ${uid}::uuid)
      ON CONFLICT DO NOTHING RETURNING user_id
    `;
    if (r.length > 0) added++;
  }
  await logAudit({
    userId: c.get("user").id,
    target: id,
    action: "panel_members_added",
    metadata: { count: added },
  });
  return c.json({ ok: true, added });
});

router.delete("/:id/members/:uid", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const uid = c.req.param("uid");
  await sql`DELETE FROM panel_members WHERE panel_id = ${id}::uuid AND user_id = ${uid}::uuid`;
  return c.json({ ok: true });
});

router.get("/:id/messages", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (user.role !== "admin") {
    const m = await sql<{ user_id: string }[]>`
      SELECT user_id FROM panel_members WHERE panel_id = ${id}::uuid AND user_id = ${user.id}::uuid LIMIT 1
    `;
    if (!m[0]) return c.json({ error: "forbidden" }, 403);
  }
  const rows = await sql<{
    id: string;
    user_id: string | null;
    role: string;
    content: string;
    tokens: number;
    created_at: Date;
    sender_name: string | null;
  }[]>`
    SELECT m.id, m.user_id, m.role, m.content, m.tokens, m.created_at,
           u.name AS sender_name
    FROM messages m
    LEFT JOIN users u ON u.id = m.user_id
    WHERE m.panel_id = ${id}::uuid
    ORDER BY m.created_at ASC
    LIMIT 500
  `;
  return c.json(rows);
});

router.get("/:id/available-models", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  // Membership check (admins skip).
  if (user.role !== "admin") {
    const m = await sql<{ user_id: string }[]>`
      SELECT user_id FROM panel_members WHERE panel_id = ${id}::uuid AND user_id = ${user.id}::uuid LIMIT 1
    `;
    if (!m[0]) return c.json({ error: "forbidden" }, 403);
  }
  // Admin: every active model. User: only their assigned models.
  const rows = user.role === "admin"
    ? await sql<{
        id: string;
        external_id: string;
        display_name: string;
        provider_type: string;
        assigned: boolean;
      }[]>`
        SELECT m.id, m.external_id, m.display_name, p.type AS provider_type,
               EXISTS (SELECT 1 FROM model_access WHERE user_id = ${user.id}::uuid AND model_id = m.id) AS assigned
        FROM models m JOIN providers p ON p.id = m.provider_id
        WHERE m.state = 'active'
        ORDER BY p.added_at ASC, m.display_name ASC
      `
    : await sql<{
        id: string;
        external_id: string;
        display_name: string;
        provider_type: string;
        assigned: boolean;
      }[]>`
        SELECT m.id, m.external_id, m.display_name, p.type AS provider_type, TRUE AS assigned
        FROM model_access ma
        JOIN models m ON m.id = ma.model_id
        JOIN providers p ON p.id = m.provider_id
        WHERE ma.user_id = ${user.id}::uuid AND m.state = 'active'
        ORDER BY m.display_name ASC
      `;
  return c.json(rows);
});

router.get("/:id/knowledge", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (user.role !== "admin") {
    const m = await sql<{ user_id: string }[]>`
      SELECT user_id FROM panel_members WHERE panel_id = ${id}::uuid AND user_id = ${user.id}::uuid LIMIT 1
    `;
    if (!m[0]) return c.json({ error: "forbidden" }, 403);
  }
  const rows = await sql<{
    id: string;
    name: string;
    chunk_count: number;
    uploaded_at: Date;
    total_tokens: number;
  }[]>`
    SELECT d.id, d.name, d.chunk_count, d.uploaded_at,
           COALESCE((SELECT sum(token_estimate)::int FROM knowledge_chunks WHERE doc_id = d.id), 0) AS total_tokens
    FROM knowledge_docs d WHERE d.panel_id = ${id}::uuid
    ORDER BY d.uploaded_at DESC
  `;
  return c.json(rows);
});

// Live presence snapshot for the panel — late joiners fetch this on
// open so their header doesn't sit at "0 watching" until the next
// presence_update frame arrives.
router.get("/:id/presence", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (user.role !== "admin") {
    const m = await sql<{ user_id: string }[]>`
      SELECT user_id FROM panel_members
      WHERE panel_id = ${id}::uuid AND user_id = ${user.id}::uuid LIMIT 1
    `;
    if (!m[0]) return c.json({ error: "forbidden" }, 403);
  }
  const list = await getPresence(id);
  return c.json(list);
});

// Time-travel / replay endpoints.
//
//   GET  /api/panels/:id/replay            — every snapshot, oldest first
//   GET  /api/panels/:id/replay?from=<mid> — only snapshots at/after that message
//   POST /api/panels/:id/replay            body { from_message_id, branch_label? }
//                                          — fork a NEW panel seeded with
//                                            every message up to and
//                                            including the anchor.
router.get("/:id/replay", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (user.role !== "admin") {
    const m = await sql<{ user_id: string }[]>`
      SELECT user_id FROM panel_members
      WHERE panel_id = ${id}::uuid AND user_id = ${user.id}::uuid LIMIT 1
    `;
    if (!m[0]) return c.json({ error: "forbidden" }, 403);
  }
  const from = c.req.query("from");
  const rows = from
    ? await getSnapshotsFrom(id, from)
    : await listSnapshots(id);
  return c.json(rows);
});

router.post("/:id/replay", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (user.role !== "admin") {
    const m = await sql<{ user_id: string }[]>`
      SELECT user_id FROM panel_members
      WHERE panel_id = ${id}::uuid AND user_id = ${user.id}::uuid LIMIT 1
    `;
    if (!m[0]) return c.json({ error: "forbidden" }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    from_message_id?: string;
    branch_label?: string;
  };
  const fromId = body.from_message_id;
  if (!fromId) return c.json({ error: "from_message_id required" }, 400);

  // Resolve the anchor message + parent panel meta so we can seed
  // the new panel with the same agent + persona + members.
  const anchorRows = await sql<{
    id: string;
    panel_id: string;
    created_at: Date;
    content: string;
  }[]>`
    SELECT id, panel_id, created_at, content FROM messages
    WHERE id = ${fromId}::uuid LIMIT 1
  `;
  const anchor = anchorRows[0];
  if (!anchor || anchor.panel_id !== id) {
    return c.json({ error: "anchor_not_found" }, 404);
  }

  const panelMeta = await sql<{
    id: string;
    name: string;
    agent_model_id: string | null;
    persona_id: string | null;
    created_by: string | null;
  }[]>`
    SELECT id, name, agent_model_id, persona_id, created_by
    FROM panels WHERE id = ${id}::uuid LIMIT 1
  `;
  const parent = panelMeta[0];
  if (!parent) return c.json({ error: "panel_not_found" }, 404);

  const branchLabel = (body.branch_label ?? "").trim() ||
    `branch @ ${new Date(anchor.created_at).toISOString().slice(0, 16).replace("T", " ")}`;
  const newName = `${parent.name} · ${branchLabel}`.slice(0, 120);

  // Create the branch panel + copy every member + copy messages up to
  // the anchor. We do this in one transaction so a half-copied branch
  // never appears in the UI.
  const newPanelId: string = await sql.begin(async (tx) => {
    const created = await tx<{ id: string }[]>`
      INSERT INTO panels (name, agent_model_id, persona_id, created_by)
      VALUES (${newName}, ${parent.agent_model_id}::uuid, ${parent.persona_id}::uuid, ${user.id}::uuid)
      RETURNING id
    `;
    const npid = created[0]!.id;
    // Copy members from the parent panel.
    await tx`
      INSERT INTO panel_members (panel_id, user_id)
      SELECT ${npid}::uuid, user_id FROM panel_members
      WHERE panel_id = ${id}::uuid
      ON CONFLICT DO NOTHING
    `;
    // Make sure the forker is a member of their new branch.
    await tx`
      INSERT INTO panel_members (panel_id, user_id)
      VALUES (${npid}::uuid, ${user.id}::uuid)
      ON CONFLICT DO NOTHING
    `;
    // Copy messages up to and including the anchor. We duplicate them
    // (different panel_id) so the branch is self-contained; the
    // original panel is unchanged.
    await tx`
      INSERT INTO messages (panel_id, user_id, model_id, role, content, tokens, created_at)
      SELECT ${npid}::uuid, user_id, model_id, role, content, tokens, created_at
      FROM messages
      WHERE panel_id = ${id}::uuid
        AND created_at <= ${anchor.created_at}
      ORDER BY created_at ASC, id ASC
    `;
    // Tag the new panel's first message with a "branched from PNL-XXX"
    // prefix so the user can see the lineage on open.
    const firstMsg = await tx<{ id: string }[]>`
      SELECT id FROM messages WHERE panel_id = ${npid}::uuid
      ORDER BY created_at ASC LIMIT 1
    `;
    if (firstMsg[0]) {
      await tx`
        UPDATE messages
        SET content = '> 🔀 branched from panel ${id.slice(0, 8)} · ' || content
        WHERE id = ${firstMsg[0].id}::uuid
      `;
    }
    return npid;
  });

  await logAudit({
    userId: user.id,
    target: newPanelId,
    action: "panel_branched",
    metadata: {
      from_panel: id,
      from_message: fromId,
      label: branchLabel,
    },
  });
  return c.json({ id: newPanelId, name: newName });
});

// Per-panel skill grants. Admins OR the panel's creator can grant/revoke.
// We treat "panel owner" as `panels.created_by` — there's no separate
// owner column yet, and that's the only row-level admin marker panels have.
// We inline the check in each handler so the Hono Context type stays
// happy (extracting it to a helper loses the `c.json` method).

router.get("/:id/skills", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  // Membership gate (admins bypass).
  if (user.role !== "admin") {
    const m = await sql<{ user_id: string }[]>`
      SELECT user_id FROM panel_members
      WHERE panel_id = ${id}::uuid AND user_id = ${user.id}::uuid
      LIMIT 1
    `;
    if (!m[0]) return c.json({ error: "forbidden" }, 403);
  }
  const rows = await sql<{
    id: string;
    pack_id: string | null;
    name: string;
    description: string;
    scope: string;
    kind: string;
    granted_by: string | null;
    granted_at: Date;
  }[]>`
    SELECT s.id, s.pack_id, s.name, s.description, s.scope, s.kind,
           g.granted_by, g.granted_at
    FROM skill_grants g
    JOIN skills s ON s.id = g.skill_id
    WHERE g.panel_id = ${id}::uuid
    ORDER BY g.granted_at ASC
  `;
  return c.json(rows);
});

router.post("/:id/skills/:skillId/grant", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const skillId = c.req.param("skillId");
  if (user.role !== "admin") {
    const owner = await sql<{ created_by: string | null }[]>`
      SELECT created_by FROM panels WHERE id = ${id}::uuid LIMIT 1
    `;
    if (!owner[0]) return c.json({ error: "not_found" }, 404);
    if (owner[0].created_by !== user.id) {
      const member = await sql<{ user_id: string }[]>`
        SELECT user_id FROM panel_members
        WHERE panel_id = ${id}::uuid AND user_id = ${user.id}::uuid LIMIT 1
      `;
      if (!member[0]) return c.json({ error: "forbidden" }, 403);
    }
  }
  const skillExists = await sql<{ id: string }[]>`
    SELECT id FROM skills WHERE id = ${skillId}::uuid LIMIT 1
  `;
  if (!skillExists[0]) return c.json({ error: "not_found" }, 404);
  await sql`
    INSERT INTO skill_grants (skill_id, panel_id, granted_by)
    VALUES (${skillId}::uuid, ${id}::uuid, ${user.id}::uuid)
    ON CONFLICT DO NOTHING
  `;
  await logAudit({
    userId: user.id,
    target: skillId,
    action: "skill_granted",
    metadata: { panel_id: id },
  });
  return c.json({ ok: true });
});

router.delete("/:id/skills/:skillId", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const skillId = c.req.param("skillId");
  if (user.role !== "admin") {
    const owner = await sql<{ created_by: string | null }[]>`
      SELECT created_by FROM panels WHERE id = ${id}::uuid LIMIT 1
    `;
    if (!owner[0]) return c.json({ error: "not_found" }, 404);
    if (owner[0].created_by !== user.id) {
      const member = await sql<{ user_id: string }[]>`
        SELECT user_id FROM panel_members
        WHERE panel_id = ${id}::uuid AND user_id = ${user.id}::uuid LIMIT 1
      `;
      if (!member[0]) return c.json({ error: "forbidden" }, 403);
    }
  }
  await sql`
    DELETE FROM skill_grants
    WHERE skill_id = ${skillId}::uuid AND panel_id = ${id}::uuid
  `;
  await logAudit({
    userId: user.id,
    target: skillId,
    action: "skill_revoked",
    metadata: { panel_id: id },
  });
  return c.json({ ok: true });
});

router.post("/:id/knowledge", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  if (user.role !== "admin") {
    const m = await sql<{ user_id: string }[]>`
      SELECT user_id FROM panel_members WHERE panel_id = ${id}::uuid AND user_id = ${user.id}::uuid LIMIT 1
    `;
    if (!m[0]) return c.json({ error: "forbidden" }, 403);
  }
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: string;
    text?: string;
  };
  const name = (body.name ?? "").trim();
  const text = typeof body.text === "string" ? body.text : "";
  if (!name || !text) return c.json({ error: "name and text required" }, 400);

  // Real chunking: split on word boundaries into ~200-word chunks. Each
  // chunk lands in `knowledge_chunks` with a tsvector for retrieval.
  const words = text.split(/\s+/).filter(Boolean);
  const CHUNK_WORDS = 200;
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += CHUNK_WORDS) {
    chunks.push(words.slice(i, i + CHUNK_WORDS).join(" "));
  }
  if (chunks.length === 0) chunks.push(text);

  let docId: string;
  await sql.begin(async (tx) => {
    const doc = await tx<{ id: string }[]>`
      INSERT INTO knowledge_docs (panel_id, name, chunk_count, uploaded_by)
      VALUES (${id}::uuid, ${name}, ${chunks.length}, ${user.id}::uuid)
      RETURNING id
    `;
    docId = doc[0]!.id;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i]!;
      const tokens = Math.ceil(chunk.length / 4);
      await tx`
        INSERT INTO knowledge_chunks (doc_id, panel_id, chunk_index, content, token_estimate)
        VALUES (${docId}::uuid, ${id}::uuid, ${i}, ${chunk}, ${tokens})
      `;
    }
  });
  await logAudit({
    userId: user.id,
    target: id,
    action: "knowledge_uploaded",
    metadata: { name, chunks: chunks.length },
  });
  return c.json({ id: docId!, chunk_count: chunks.length });
});

// Tier 4 (Discovery): conversation summarisation.
//
//   POST /api/panels/:id/summarize?days=N
//
// Collapse every message older than `days` (default 7) into a single
// 'system' message that captures the gist. Useful when a panel has
// accumulated enough history that the next agent turn would otherwise
// burn context replaying old chat. Admin or panel owner can trigger.
router.post("/:id/summarize", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const daysRaw = Number(c.req.query("days") ?? 7);
  const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(365, daysRaw)) : 7;
  const result = await summarizePanel(id, {
    days,
    userId: user.id,
    isAdmin: user.role === "admin",
  });
  if (!result.ok) {
    const status =
      result.reason === "not_found"
        ? 404
        : result.reason === "forbidden"
          ? 403
          : result.reason === "no_model_available"
            ? 409
            : result.reason === "provider_missing"
              ? 500
              : 200;
    return c.json({ error: result.reason }, status);
  }
  await logAudit({
    userId: user.id,
    target: id,
    action: "panel_summarized",
    metadata: { days, collapsed: result.collapsed },
  });
  return c.json(result);
});

// Tier 6 — auto-summarize. Chunk-by-chunk (20 messages per summary) and
// stash source ids in the summary row's metadata. We keep the originals
// so retrieval can still surface exact quotes if needed.
router.post("/:id/auto-summarize", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  // Confirm the panel exists + the user can see it. Admins can run on
  // any panel; non-admins must be a member.
  const panel = await sql<{ id: string; created_by: string }[]>`
    SELECT id, created_by FROM panels WHERE id = ${id}::uuid LIMIT 1
  `;
  if (!panel[0]) return c.json({ error: "not_found" }, 404);
  if (user.role !== "admin") {
    const m = await sql<{ user_id: string }[]>`
      SELECT user_id FROM panel_members
      WHERE panel_id = ${id}::uuid AND user_id = ${user.id}::uuid LIMIT 1
    `;
    if (!m[0]) return c.json({ error: "forbidden" }, 403);
  }
  const daysRaw = Number(c.req.query("days") ?? 30);
  const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(365, daysRaw)) : 30;
  const result = await autoSummarizePanel(id, days);
  await logAudit({
    userId: user.id,
    target: id,
    action: "panel_auto_summarized",
    metadata: {
      days,
      chunks: result.chunks,
      summaries_inserted: result.summaries_inserted,
      source_messages: result.source_messages,
    },
  });
  return c.json(result);
});

export default router;