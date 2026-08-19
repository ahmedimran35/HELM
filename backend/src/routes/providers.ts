// Provider CRUD + model registry endpoints.
//
//   GET    /api/providers           (admin)  — list providers (with per-provider health)
//   POST   /api/providers           (admin)  — add provider (base URL + key)
//   GET    /api/providers/:id       (admin)  — single provider detail
//   DELETE /api/providers/:id       (admin)  — remove provider (cascades to models)
//   POST   /api/providers/:id/fetch (admin)  — call upstream /models, populate registry
//   POST   /api/providers/:id/test  (admin)  — one-shot reachability + latency check
//   GET    /api/models              (any)    — list all known models (with assigned flag)
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
  // Per-provider health: ping the upstream /models endpoint with a 3s
  // timeout and record latency. Runs in parallel for the whole list so
  // a slow Upstream doesn't serialise the UI load.
  const healthEntries = await Promise.all(
    rows.map((r) => pingProvider(r)),
  );
  return c.json(
    rows.map((r, i) => {
      const dec = decryptSafe(r.api_key_encrypted);
      return {
        id: r.id,
        type: r.type,
        base_url: r.base_url,
        display_name: r.display_name,
        api_key_masked: dec.ok ? maskSecret(dec.value) : "••• (key unreadable)",
        key_unreadable: !dec.ok,
        added_at: r.added_at,
        model_count: r.model_count,
        health: healthEntries[i],
      };
    }),
  );
});

/** Single-provider detail with full health snapshot. */
router.get("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const rows = await sql<ProviderRow[]>`
    SELECT p.id, p.type, p.base_url, p.display_name, p.api_key_encrypted, p.added_at,
           (SELECT count(*) FROM models m WHERE m.provider_id = p.id)::int AS model_count
    FROM providers p
    WHERE p.id = ${id}::uuid
    LIMIT 1
  `;
  const r = rows[0];
  if (!r) return c.json({ error: "not_found" }, 404);
  const health = await pingProvider(r);
  const dec = decryptSafe(r.api_key_encrypted);
  return c.json({
    id: r.id,
    type: r.type,
    base_url: r.base_url,
    display_name: r.display_name,
    api_key_masked: dec.ok ? maskSecret(dec.value) : "••• (key unreadable)",
    key_unreadable: !dec.ok,
    added_at: r.added_at,
    model_count: r.model_count,
    health,
  });
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
  // Cascade: delete in a transaction so the provider and its models
  // go away together. Without this, deleting a provider leaves
  // orphaned models that are invisible (filtered by the JOIN in
  // /api/models) but still occupy storage. We also clear any
  // model_access grants keyed on those models.
  const cascade = await sql.begin(async (tx) => {
    const modelIds = await tx<{ id: string }[]>`
      SELECT id FROM models WHERE provider_id = ${id}::uuid
    `;
    const ids = modelIds.map((m) => m.id);
    if (ids.length > 0) {
      await tx`DELETE FROM model_access WHERE model_id = ANY(${ids}::uuid[])`;
      await tx`DELETE FROM access_requests WHERE model_id = ANY(${ids}::uuid[])`;
      await tx`DELETE FROM models WHERE provider_id = ${id}::uuid`;
    }
    await tx`DELETE FROM providers WHERE id = ${id}::uuid`;
    return { models_removed: ids.length };
  });
  await logAudit({
    userId: c.get("user").id,
    target: id,
    action: "provider_removed",
    metadata: {
      type: existing.type,
      base_url: existing.base_url,
      ...cascade,
    },
  });
  return c.json({ ok: true, ...cascade });
});

/** One-shot reachability + latency probe. Calls the upstream /models
 *  endpoint with a 3s timeout and returns the status, latency, and
 *  the count of models the upstream actually returned (lets the
 *  admin verify their key works without leaving the UI). */
router.post("/:id/test", requireAdmin, async (c) => {
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
  const start = Date.now();
  try {
    const upstream = await adapter.fetchModels();
    const latency_ms = Date.now() - start;
    return c.json({
      ok: true,
      latency_ms,
      upstream_status: "reachable",
      models_seen: upstream.length,
      sample: upstream.slice(0, 3).map((m) => m.externalId),
    });
  } catch (err) {
    const latency_ms = Date.now() - start;
    return c.json({
      ok: false,
      latency_ms,
      upstream_status: "unreachable",
      error: (err as Error).message,
    });
  }
});

/** Re-encrypt the API key with the current SESSION_SECRET / v2 AAD.
 *  Used when a stored key fails to decrypt (typically because
 *  SESSION_SECRET was rotated between when the row was written and
 *  when the server is now reading it). The admin re-enters the
 *  key here and the new ciphertext is written under the current
 *  crypto parameters. The old, broken ciphertext is overwritten
 *  in place. */
router.put("/:id/key", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const body = (await c.req.json().catch(() => ({}))) as { api_key?: string };
  const apiKey = (body.api_key ?? "").trim();
  if (!apiKey || apiKey.length < 8) {
    return c.json({ error: "api_key required (min 8 chars)" }, 400);
  }
  const existing = await getProviderById(id);
  if (!existing) return c.json({ error: "not_found" }, 404);
  const enc = encryptSecret(apiKey);
  await sql`UPDATE providers SET api_key_encrypted = ${enc} WHERE id = ${id}::uuid`;
  await logAudit({
    userId: c.get("user").id,
    target: id,
    action: "provider_key_rotated",
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

function decryptSafe(blob: string): { value: string; ok: boolean } {
  // Wrap so a corrupt / unwrappable stored key (e.g. SESSION_SECRET
  // rotated since the row was written, or a v1→v2 mismatch) doesn't
  // take down the entire providers list. The caller renders a flag
  // so the admin can re-enter the key.
  try {
    return { value: decryptSecret(blob), ok: true };
  } catch {
    return { value: "", ok: false };
  }
}

interface ProviderHealth {
  status: "healthy" | "degraded" | "down" | "unknown";
  latency_ms: number;
  checked_at: number;
  reason?: string;
  models_seen?: number;
}

/** Probe a single provider's reachability. Returns a snapshot the
 *  UI can render as a green/yellow/red dot. Best-effort — never
 *  throws. Health thresholds match the harness health-check:
 *  healthy<2s, degraded<8s, down otherwise. The 3s timeout here
 *  keeps the table load snappy even when several providers are
 *  slow. */
async function pingProvider(r: ProviderRow): Promise<ProviderHealth> {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3_000);
  try {
    const dec = decryptSafe(r.api_key_encrypted);
    if (!dec.ok) {
      // Key unreadable — can't ping with auth. Report as down with a
      // clear reason rather than attempting unauthenticated GET.
      return {
        status: "down",
        latency_ms: 0,
        checked_at: Date.now(),
        reason: "key_unreadable",
      };
    }
    const apiKey = dec.value;
    // Build the upstream URL. Most providers expose /models at the
    // base URL or a subpath; we strip any trailing /v1 to find the
    // canonical host, then GET /models. For OpenAI we use the
    // canonical base instead of the stored row.
    let baseUrl = r.base_url.replace(/\/+$/, "");
    if (r.type === "openai") {
      baseUrl = "https://api.openai.com/v1";
    } else if (r.type === "anthropic") {
      baseUrl = "https://api.anthropic.com/v1";
    }
    const url = `${baseUrl}/models`;
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: ctrl.signal,
    });
    const latency_ms = Date.now() - start;
    if (res.ok) {
      // Try to count models so the UI can confirm "yes, your key
      // works and there are N models upstream".
      let models_seen: number | undefined;
      try {
        const body = await res.json() as { data?: unknown[] } | unknown[];
        if (Array.isArray(body)) models_seen = body.length;
        else if (typeof body === "object" && body !== null && Array.isArray((body as { data?: unknown[] }).data)) {
          models_seen = (body as { data: unknown[] }).data.length;
        }
      } catch {
        /* non-JSON body — that's fine */
      }
      const status: ProviderHealth["status"] =
        latency_ms < 2_000 ? "healthy" : latency_ms < 8_000 ? "degraded" : "down";
      return {
        status,
        latency_ms,
        checked_at: Date.now(),
        models_seen,
      };
    }
    return {
      status: res.status >= 500 ? "down" : "degraded",
      latency_ms,
      checked_at: Date.now(),
      reason: `http_${res.status}`,
    };
  } catch (err) {
    const latency_ms = Date.now() - start;
    const isAbort = (err as Error).name === "AbortError";
    return {
      status: isAbort ? "down" : "down",
      latency_ms,
      checked_at: Date.now(),
      reason: isAbort ? "timeout" : "ping_failed",
    };
  } finally {
    clearTimeout(timer);
  }
}

export default router;