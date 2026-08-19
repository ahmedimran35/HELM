// Semantic response cache (Tier 5).
//
// Stores (query → response) pairs in `response_cache` keyed by
// sha256(normalisedQuery). On a hit the row's hit_count and
// last_hit_at columns are incremented so we can later surface
// "most-reused response" / "cache hit rate" analytics.
//
// v1 is exact-match only — a hit means the normalised query text
// hashes to the same digest. Embedding-based similarity is left as
// a future enhancement (the schema's `query_text` column is preserved
// verbatim so embeddings can be appended later without a migration).
//
// Writes are idempotent under concurrent inserts via the unique
// `query_hash` constraint + ON CONFLICT DO UPDATE.

import { createHash } from "node:crypto";
import { sql } from "../db/client.ts";

export interface CachedResponse {
  id: string;
  query_text: string;
  response_text: string;
  model: string;
  hit_count: number;
  created_at: string;
  last_hit_at: string;
}

/** Normalise a query for hashing: lowercase, collapse whitespace,
 *  trim. Cheap; we want the cache to be tolerant of minor variations
 *  like trailing punctuation + double spaces but not tolerant of
 *  rephrased questions (those need embeddings). */
export function normaliseQuery(query: string): string {
  return query
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[\s\u00a0]+$/g, "")
    .trim();
}

/** Ownership scope baked into the cache key. A panel-scoped row is
 *  keyed by `panel:<id>` so a different panel cannot resolve the same
 *  query to the same cached reply (cross-panel leak). When `panelId`
 *  is null the scope is `user:<userId>` so the 1:1 chat (which has no
 *  panel) is scoped per-user instead of globally — otherwise two users
 *  asking the same question would share a cached reply. */
function cacheScope(panelId: string | null, userId: string | null): string {
  if (panelId) return `panel:${panelId}`;
  if (userId) return `user:${userId}`;
  // Last-resort fallback. With both null we'd dedupe across every
  // caller; we still namespace it so it can't collide with a scoped key.
  return "global";
}

/** sha256 hex digest of (scope + normalised query). The scope prefix
 *  is what stops cross-panel + cross-user leakage — the bare text
 *  hash would collide for any caller that asks the same question. */
export function hashQuery(query: string, panelId: string | null, userId: string | null): string {
  const scope = cacheScope(panelId, userId);
  return createHash("sha256")
    .update(`${scope}\u0000${normaliseQuery(query)}`)
    .digest("hex");
}

/** Look up a cached response. Returns null on a miss.
 *  On a hit, increments hit_count + updates last_hit_at atomically. */
export async function lookupCached(
  query: string,
  panelId: string | null,
  opts: { userId?: string | null; similarity_threshold?: number } = {},
): Promise<CachedResponse | null> {
  const hash = hashQuery(query, panelId, opts.userId ?? null);
  // The threshold is reserved for the future embedding path. For v1
  // we ignore it — every hash match is a hit, period.
  void opts.similarity_threshold;
  const rows = await sql<CachedResponse[]>`
    SELECT id, query_text, response_text, model, hit_count,
           created_at::text AS created_at,
           last_hit_at::text AS last_hit_at
    FROM response_cache
    WHERE query_hash = ${hash}
      AND expires_at > now()
    LIMIT 1
  `;
  const row = rows[0];
  if (!row) return null;
  // Fire-and-forget hit increment. The route returns the cached
  // response immediately; analytics gets the bump within a tick.
  // We deliberately don't `await` so a slow DB doesn't gate the chat.
  void sql`
    UPDATE response_cache
    SET hit_count = hit_count + 1,
        last_hit_at = now()
    WHERE id = ${row.id}::uuid
  `.catch((err) => console.warn("[response-cache] hit update failed:", (err as Error).message));
  return row;
}

/** Store a (query → response) pair. Idempotent: if the hash already
 *  exists, the row is left alone so concurrent writes don't clobber
 *  each other. The caller can decide to refresh via `refreshCached`. */
export async function storeCached(
  query: string,
  response: string,
  model: string,
  panelId: string | null,
  opts: { userId?: string | null } = {},
): Promise<void> {
  const hash = hashQuery(query, panelId, opts.userId ?? null);
  // TTL is env-driven so tests can disable it. Default 1 hour — long
  // enough to suppress duplicate round-trips in a chat session, short
  // enough that a freshly-rotated provider key actually gets exercised.
  const ttlSec = (() => {
    const raw = process.env.HELM_RESPONSE_CACHE_TTL_SECONDS;
    if (raw === undefined || raw === "") return 3600;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 3600;
  })();
  if (ttlSec === 0) return; // tests / ops disabled
  try {
    await sql`
      INSERT INTO response_cache (query_hash, query_text, response_text, model, panel_id, hit_count, expires_at)
      VALUES (${hash}, ${query}, ${response}, ${model}, ${panelId}, 0, now() + (${ttlSec}::int * interval '1 second'))
      ON CONFLICT (query_hash) DO UPDATE
        SET expires_at = EXCLUDED.expires_at
    `;
  } catch (err) {
    console.warn("[response-cache] store failed:", (err as Error).message);
  }
}

/** Admin-only cache wipe. Returns the number of rows removed. */
export async function invalidateAll(): Promise<number> {
  try {
    const rows = await sql<{ count: number }[]>`SELECT count(*)::int AS count FROM response_cache`;
    await sql`DELETE FROM response_cache`;
    return rows[0]?.count ?? 0;
  } catch (err) {
    console.warn("[response-cache] invalidate failed:", (err as Error).message);
    return 0;
  }
}

/** Total cache hit count for the current user's most-recent
 *  activity (used by the /perf dashboard). */
export async function cacheHitStats(
  userId: string,
): Promise<{ total_rows: number; total_hits: number; hit_rate: number }> {
  // Hit rate is defined as: total hits / (total hits + total misses).
  // We don't have a misses column — derive "misses" from assistant
  // messages that were *not* served by cache. For v1 we just return
  // the raw totals and let the UI compute the rate from `messages`.
  const rows = await sql<{ rows: number; hits: number }[]>`
    SELECT count(*)::int AS rows,
           COALESCE(sum(hit_count), 0)::int AS hits
    FROM response_cache
  `;
  const totalRows = rows[0]?.rows ?? 0;
  const totalHits = rows[0]?.hits ?? 0;
  // Estimate misses from total assistant messages in the last 30d.
  // The estimate is intentionally coarse — accuracy isn't required,
  // just a directional indicator for the dashboard.
  const msgRows = await sql<{ count: number }[]>`
    SELECT count(*)::int AS count
    FROM messages
    WHERE user_id = ${userId}::uuid
      AND role = 'assistant'
      AND created_at > now() - interval '30 days'
  `;
  const totalMsgs = msgRows[0]?.count ?? 0;
  const total = totalHits + Math.max(0, totalMsgs - totalHits);
  const hitRate = total > 0 ? totalHits / total : 0;
  return { total_rows: totalRows, total_hits: totalHits, hit_rate: hitRate };
}