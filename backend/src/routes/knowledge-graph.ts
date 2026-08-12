// Knowledge graph (Tier 4: Discovery).
//
//   GET  /api/kg/entities              — current user's entities (filter by ?kind=)
//   GET  /api/kg/entities/:id          — single entity + its relationships
//   POST /api/kg/extract               — body { message_id } → run small LLM,
//                                          insert entities + relationships
//   GET  /api/kg/graph                 — full graph dump for visualisation
//
// We deliberately keep extraction simple and synchronous: it reads the
// single message, asks the user's first available model for a small JSON
// shape, parses it, and inserts. There's no background queue — the user
// triggers it explicitly via "Extract from selection" in the UI.

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { validate, validationErrorResponse } from "../lib/validate.ts";
import { getProviderById, buildAdapter } from "../providers/registry.ts";

const router = new Hono();
router.use("*", requireAuth);

const VALID_KINDS = new Set([
  "person",
  "project",
  "topic",
  "file",
  "concept",
]);

router.get("/entities", async (c) => {
  const user = c.get("user");
  const kindFilter = c.req.query("kind") ?? "";
  const rows = await sql<{
    id: string;
    name: string;
    kind: string;
    attributes: unknown;
    created_at: Date;
    rel_count: number;
  }[]>`
    SELECT e.id, e.name, e.kind, e.attributes, e.created_at,
           (SELECT count(*) FROM kg_relationships r
            WHERE r.from_entity_id = e.id OR r.to_entity_id = e.id)::int AS rel_count
    FROM kg_entities e
    WHERE e.user_id = ${user.id}::uuid
      ${kindFilter && VALID_KINDS.has(kindFilter)
        ? sql`AND e.kind = ${kindFilter}`
        : sql``}
    ORDER BY e.name ASC
    LIMIT 500
  `;
  return c.json(rows);
});

router.get("/entities/:id", async (c) => {
  const user = c.get("user");
  const id = c.req.param("id");
  const rows = await sql<{
    id: string;
    name: string;
    kind: string;
    attributes: unknown;
    user_id: string;
    created_at: Date;
  }[]>`
    SELECT id, name, kind, attributes, user_id, created_at FROM kg_entities
    WHERE id = ${id}::uuid LIMIT 1
  `;
  const entity = rows[0];
  if (!entity) return c.json({ error: "not_found" }, 404);
  if (entity.user_id !== user.id && user.role !== "admin") {
    return c.json({ error: "forbidden" }, 403);
  }
  const rels = await sql<{
    id: string;
    from_entity_id: string;
    to_entity_id: string;
    relation: string;
    weight: number;
    source_message_id: string | null;
    from_name: string;
    to_name: string;
  }[]>`
    SELECT r.id, r.from_entity_id, r.to_entity_id, r.relation,
           r.weight, r.source_message_id,
           fe.name AS from_name, te.name AS to_name
    FROM kg_relationships r
    JOIN kg_entities fe ON fe.id = r.from_entity_id
    JOIN kg_entities te ON te.id = r.to_entity_id
    WHERE r.from_entity_id = ${id}::uuid OR r.to_entity_id = ${id}::uuid
    ORDER BY r.weight DESC, r.created_at DESC
    LIMIT 200
  `;
  // Recent messages that mention this entity name. Cheap textual search
  // — saved us wiring up an embeddings index for this lightweight view.
  const mentionRows = await sql<{
    id: string;
    role: string;
    content: string;
    created_at: Date;
  }[]>`
    SELECT id, role, content, created_at FROM messages
    WHERE user_id = ${user.id}::uuid
      AND (LOWER(content) LIKE ${"%" + entity.name.toLowerCase() + "%"})
    ORDER BY created_at DESC LIMIT 8
  `;
  return c.json({ entity, relationships: rels, recent_messages: mentionRows });
});

router.get("/graph", async (c) => {
  const user = c.get("user");
  const nodes = await sql<{
    id: string;
    name: string;
    kind: string;
  }[]>`SELECT id, name, kind FROM kg_entities WHERE user_id = ${user.id}::uuid ORDER BY name ASC LIMIT 300`;
  const edges = await sql<{
    id: string;
    from_entity_id: string;
    to_entity_id: string;
    relation: string;
    weight: number;
  }[]>`
    SELECT r.id, r.from_entity_id, r.to_entity_id, r.relation, r.weight
    FROM kg_relationships r
    JOIN kg_entities fe ON fe.id = r.from_entity_id
    JOIN kg_entities te ON te.id = r.to_entity_id
    WHERE fe.user_id = ${user.id}::uuid AND te.user_id = ${user.id}::uuid
    ORDER BY r.weight DESC LIMIT 1500
  `;
  return c.json({ nodes, edges });
});

router.post("/extract", async (c) => {
  const user = c.get("user");
  let body: { message_id?: string; text?: string };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      message_id: { type: "uuid" },
      text: { type: "string", maxLength: 8000, trim: true },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }

  let text = body.text ?? "";
  if (body.message_id && !text) {
    const msgRows = await sql<{
      id: string;
      content: string;
      user_id: string | null;
    }[]>`
      SELECT id, content, user_id FROM messages
      WHERE id = ${body.message_id}::uuid LIMIT 1
    `;
    const msg = msgRows[0];
    if (!msg) return c.json({ error: "message_not_found" }, 404);
    if (msg.user_id !== user.id && user.role !== "admin") {
      return c.json({ error: "forbidden" }, 403);
    }
    text = msg.content;
  }
  text = text.trim();
  if (!text) return c.json({ error: "text required" }, 400);

  // Cheap LLM call: ask the user's first available model for a tiny
  // JSON shape describing entities + relationships. We constrain the
  // output so even small models stay on-format.
  const modelRow = await sql<{
    id: string;
    external_id: string;
    provider_id: string;
  }[]>`
    SELECT m.id, m.external_id, m.provider_id FROM models m
    ${user.role === "admin"
      ? sql``
      : sql`JOIN model_access ma ON ma.model_id = m.id AND ma.user_id = ${user.id}::uuid`}
    WHERE m.state = 'active' ORDER BY m.created_at ASC LIMIT 1
  `;
  const model = modelRow[0];
  if (!model) return c.json({ error: "no_model_available" }, 409);
  const provider = await getProviderById(model.provider_id);
  if (!provider) return c.json({ error: "provider_missing" }, 500);
  const adapter = await buildAdapter(provider, { allowLocal: true });

  const systemPrompt =
    "You extract entities and relationships from a single message. " +
    "Return ONLY compact JSON with two arrays: entities and relations. " +
    "Each entity: { name: string, kind: one of [person, project, topic, file, concept] }. " +
    "Each relation: { from: <entity name>, to: <entity name>, relation: short verb phrase, weight: number 0..1 }. " +
    "Keep it small (≤ 6 entities, ≤ 8 relations). Skip obviously generic nouns. " +
    "Output must parse as JSON; no commentary.";
  let assembled = "";
  for await (const chunk of adapter.chat({
    model: model.external_id,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ],
    temperature: 0.2,
    maxTokens: 600,
  })) {
    if (chunk.delta) assembled += chunk.delta;
  }
  let parsed: {
    entities?: Array<{ name: string; kind: string }>;
    relations?: Array<{ from: string; to: string; relation: string; weight: number }>;
  } | null = null;
  try {
    // Models sometimes wrap JSON in ```json fences — strip them.
    const cleaned = assembled
      .replace(/^```(?:json)?/im, "")
      .replace(/```$/m, "")
      .trim();
    parsed = JSON.parse(cleaned);
  } catch {
    return c.json({ error: "extraction_parse_failed", raw: assembled.slice(0, 400) }, 422);
  }
  if (!parsed) {
    return c.json({ error: "extraction_empty" }, 422);
  }
  const entities = Array.isArray(parsed.entities) ? parsed.entities : [];
  const relations = Array.isArray(parsed.relations) ? parsed.relations : [];
  if (entities.length === 0) {
    return c.json({ ok: true, inserted_entities: 0, inserted_relations: 0 });
  }

  // Insert entities (ON CONFLICT keeps dedup by user_id+name) and
  // collect id map so we can resolve relation endpoints. Wrapped in a
  // single transaction so partial extraction doesn't leak.
  let insertedEntities = 0;
  let insertedRelations = 0;
  await sql.begin(async (tx) => {
    const nameToId = new Map<string, string>();
    for (const e of entities) {
      const name = (e.name ?? "").toString().trim().slice(0, 200);
      if (!name) continue;
      const kind = VALID_KINDS.has(e.kind) ? e.kind : "concept";
      const rows = await tx<{ id: string }[]>`
        INSERT INTO kg_entities (user_id, name, kind)
        VALUES (${user.id}::uuid, ${name}, ${kind})
        ON CONFLICT (user_id, name) DO UPDATE SET kind = EXCLUDED.kind
        RETURNING id
      `;
      if (rows[0]) {
        nameToId.set(name.toLowerCase(), rows[0].id);
        insertedEntities++;
      }
    }
    for (const r of relations) {
      const fromKey = (r.from ?? "").toString().trim().toLowerCase();
      const toKey = (r.to ?? "").toString().trim().toLowerCase();
      const fromId = nameToId.get(fromKey);
      const toId = nameToId.get(toKey);
      if (!fromId || !toId || fromId === toId) continue;
      const relation = (r.relation ?? "relates_to").toString().slice(0, 80);
      const weight = Math.max(0, Math.min(1, Number(r.weight) || 0.5));
      await tx`
        INSERT INTO kg_relationships (from_entity_id, to_entity_id, relation, weight, source_message_id)
        VALUES (${fromId}::uuid, ${toId}::uuid, ${relation}, ${weight}, ${body.message_id ?? null}::uuid)
        ON CONFLICT DO NOTHING
      `;
      insertedRelations++;
    }
  });
  return c.json({ ok: true, inserted_entities: insertedEntities, inserted_relations: insertedRelations });
});

export default router;
