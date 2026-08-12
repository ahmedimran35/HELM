// Provider CRUD + model registry endpoints.
//
//   GET    /api/providers           (admin)  — list providers
//   POST   /api/providers           (admin)  — add provider (base URL + key)
//   DELETE /api/providers/:id       (admin)  — remove provider
//   POST   /api/providers/:id/fetch (admin)  — call upstream /models, populate registry
//   GET    /api/models              (any)    — list all known models (with assigned flag)
//   GET    /api/providers/test      (admin)  — quick reachability check
//
// API keys are encrypted at rest and only ever returned masked.

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAdmin } from "../middleware/role.ts";
import { encryptSecret, maskSecret, decryptSecret } from "../providers/crypto.ts";
import {
  assertSafeBaseUrl,
  buildAdapter,
  listProviders,
  getProviderById,
} from "../providers/registry.ts";
import { logAudit } from "../lib/audit.ts";
import { safeError } from "../lib/safe-error.ts";

const router = new Hono();

router.use("*", requireAuth);

const ALLOWED_TYPES = new Set([
  "openai",
  "anthropic",
  "nvidia-nim",
  "openai-compatible",
]);

interface ProviderRow {
  id: string;
  type: string;
  base_url: string;
  display_name: string | null;
  api_key_encrypted: string;
  added_at: Date;
  model_count: number;
}

router.get("/", requireAdmin, async (c) => {
  const rows = await sql<ProviderRow[]>`
    SELECT p.id, p.type, p.base_url, p.display_name, p.api_key_encrypted, p.added_at,
           (SELECT count(*) FROM models m WHERE m.provider_id = p.id)::int AS model_count
    FROM providers p
    ORDER BY p.added_at ASC
  `;
  return c.json(
    rows.map((r) => ({
      id: r.id,
      type: r.type,
      base_url: r.base_url,
      display_name: r.display_name,
      api_key_masked: maskSecret(decryptSafe(r.api_key_encrypted)),
      added_at: r.added_at,
      model_count: r.model_count,
    })),
  );
});

router.post("/", requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    type?: string;
    base_url?: string;
    api_key?: string;
    display_name?: string;
  };
  const type = body.type ?? "";
  const baseUrl = (body.base_url ?? "").trim();
  const apiKey = body.api_key ?? "";
  // Default the display name to the provider type so a new row is
  // never blank in the UI.
  const displayName = (body.display_name ?? "").trim() || type || null;
  if (!ALLOWED_TYPES.has(type)) return c.json({ error: "invalid type" }, 400);
  if (!baseUrl) return c.json({ error: "base_url required" }, 400);
  if (!apiKey) return c.json({ error: "api_key required" }, 400);
  try {
    await assertSafeBaseUrl(baseUrl, {
      allowLocal: c.req.query("allow_local") === "1",
      allowAnyPort: true,
    });
  } catch (err) {
    return safeError(c, err, { status: 400, code: "providers_invalid" });
  }

  const enc = encryptSecret(apiKey);
  const rows = await sql<{ id: string }[]>`
    INSERT INTO providers (type, base_url, api_key_encrypted, display_name, added_by)
    VALUES (${type}, ${baseUrl}, ${enc}, ${displayName}, ${c.get("user").id}::uuid)
    RETURNING id
  `;
  const id = rows[0]!.id;
  await logAudit({
    userId: c.get("user").id,
    target: id,
    action: "provider_added",
    metadata: { type, base_url: baseUrl, display_name: displayName },
  });
  return c.json({ id, type, base_url: baseUrl, display_name: displayName });
});

router.delete("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const existing = await getProviderById(id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  await sql`DELETE FROM providers WHERE id = ${id}::uuid`;
  await logAudit({
    userId: c.get("user").id,
    target: id,
    action: "provider_removed",
    metadata: { type: existing.type, base_url: existing.base_url },
  });
  return c.json({ ok: true });
});

router.post("/:id/fetch", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const allowLocal = c.req.query("allow_local") === "1";
  const provider = await getProviderById(id);
  if (!provider) return c.json({ error: "not_found" }, 404);
  let adapter;
  try {
    adapter = await buildAdapter(provider, { allowLocal });
  } catch (err) {
    return safeError(c, err, { status: 400, code: "providers_invalid" });
  }
  let upstream;
  try {
    upstream = await adapter.fetchModels();
  } catch (err) {
    return safeError(c, err, { status: 502, code: "providers_upstream_failed" });
  }
  // Upsert each model.
  let added = 0;
  let updated = 0;
  for (const m of upstream) {
    const r = await sql<{ xmax: number }[]>`
      INSERT INTO models (provider_id, external_id, display_name)
      VALUES (${id}::uuid, ${m.externalId}, ${m.displayName})
      ON CONFLICT (provider_id, external_id)
      DO UPDATE SET display_name = EXCLUDED.display_name
      RETURNING xmax
    `;
    // xmax = 0 means INSERT, > 0 means UPDATE.
    if (r[0]?.xmax === 0) added++;
    else updated++;
  }
  await logAudit({
    userId: c.get("user").id,
    target: id,
    action: "provider_models_fetched",
    metadata: { added, updated },
  });
  return c.json({ ok: true, added, updated, total: upstream.length });
});

function decryptSafe(blob: string): string {
  return decryptSecret(blob);
}

export default router;