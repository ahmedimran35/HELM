// Chat-specific cache wrappers.
//
// The 1:1 chat route has its own caching rules that differ from the
// generic response-cache module:
//
//   - Exact-match on the user's content (sha256 of normalised query +
//     scope) returns the cached response without touching the harness.
//     hit_count + last_hit_at are updated fire-and-forget inside
//     lookupCached().
//   - We scope by user id (the 1:1 chat has no panel) so two users
//     asking the same question can't share a cached reply.
//   - The user can bypass the cache with `?refresh=1` (sent from the
//     chat UI when they click Refresh). The bypass is per-request and
//     doesn't touch the stored row — subsequent identical queries can
//     still hit the cache.
//
// These wrappers are thin re-exports of the generic response-cache API
// with chat-specific defaults baked in (panelId is always null in the
// 1:1 chat; the userId must be supplied).

import {
  lookupCached as genericLookupCached,
  storeCached as genericStoreCached,
  type CachedResponse,
} from "../response-cache.ts";

/** Look up a cached chat reply. Scoped by user id (panelId is null in
 *  the 1:1 chat). Returns null on a miss. On a hit, the row's
 *  hit_count + last_hit_at are updated fire-and-forget. */
export function lookupCached(
  query: string,
  userId: string,
): Promise<CachedResponse | null> {
  return genericLookupCached(query, null, { userId });
}

/** Store a chat (query → response) pair for future exact-match hits.
 *  Scoped by user id. Idempotent on hash collision (ON CONFLICT DO UPDATE
 *  only refreshes expires_at). */
export function storeCached(
  query: string,
  response: string,
  model: string,
  userId: string,
): Promise<void> {
  return genericStoreCached(query, response, model, null, { userId });
}