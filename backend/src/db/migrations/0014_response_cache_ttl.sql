-- ============================================================================
-- Add expires_at to response_cache so the cache is not permanent.
-- ============================================================================
--
-- Background: response_cache was created in 0009 with `created_at` and
-- `last_hit_at` but no expiry. Every prior query stayed a hit forever,
-- so users asking "hi" / "morning" / "who are you" continued to see the
-- original cached response even after re-adding providers, rotating
-- API keys, or upgrading models. The user read this as "AI is not
-- responding" — but the cache was just answering for the LLM.
--
-- This migration adds a `expires_at` column and a partial index for
-- the lookup path. The TTL is configurable via
-- HELM_RESPONSE_CACHE_TTL_SECONDS (default 3600s = 1 hour, but disabled
-- in test mode). Existing rows get an expires_at = now() + TTL so
-- they don't all expire at the same instant — they roll over
-- naturally as their TTL elapses.

ALTER TABLE response_cache
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Backfill: existing rows get expires_at = created_at + the new
-- default TTL. This is a one-shot so the very next query doesn't
-- accidentally hit the old, semi-fresh rows; it rolls over as
-- new requests come in.
UPDATE response_cache
   SET expires_at = created_at + interval '1 hour'
 WHERE expires_at IS NULL;

-- Now enforce NOT NULL so every future insert must set an expiry.
ALTER TABLE response_cache
  ALTER COLUMN expires_at SET NOT NULL;

-- Replace the lookup path's index with a partial one keyed on
-- expires_at > now() so the index stays small. The panel_id index
-- from 0009 is kept for the per-panel history view.
--
-- NOTE: PostgreSQL rejects partial indexes whose predicate uses a
-- non-IMMUTABLE function, and `now()` is STABLE, not IMMUTABLE.
-- We use a regular btree index on (expires_at) instead — the
-- lookup's `WHERE expires_at > now()` filter still uses it; the
-- index just isn't pruned as aggressively as a partial index.
CREATE INDEX IF NOT EXISTS response_cache_expires_at_idx
  ON response_cache (expires_at);
