-- Migration 0010 — Companion tables for the 0009 Discovery tier.
--
-- 0009 shipped the catalogue + installs + kg + notifications + citations
-- tables. The actual code paths need a few siblings that didn't fit the
-- original scope:
--
--   - marketplace_reviews   — ratings + comments (1 per user per entry)
--   - pgcrypto              — already in 0009 but harmless to re-state
--
-- Idempotent so the migration runner can safely re-apply in dev.

CREATE TABLE IF NOT EXISTS marketplace_reviews (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id        UUID NOT NULL REFERENCES marketplace_entries(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating          INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment         TEXT NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entry_id, user_id)
);
CREATE INDEX IF NOT EXISTS marketplace_reviews_entry_idx
  ON marketplace_reviews (entry_id, created_at DESC);
