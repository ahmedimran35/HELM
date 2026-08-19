-- Migration 0006 — add Lightpanda headless browser as web-search backend.
--
-- Replaces the prior free metasearch provider with Lightpanda
-- (https://github.com/lightpanda-io/browser). Lightpanda is a Zig + V8
-- headless browser that renders pages (JS, dynamic SPAs, cookie banners)
-- and exposes them as markdown — faster and lighter than headless Chrome.
--
-- The legacy 'searxng' service is removed from the CHECK constraint and
-- any leftover rows are dropped. We also add a `base_url` column to
-- web_search_keys so Lightpanda's HTTP daemon mode (or future long-running
-- daemon) can be configured per-deployment.
--
-- Any legacy searxng rows are deleted BEFORE the new constraint is
-- applied; otherwise ALTER TABLE ADD CONSTRAINT would fail with
-- "check constraint violated by some row" (Postgres validates the
-- constraint against existing data at add time).

-- 1. Drop any legacy searxng rows (from the removed free metasearch
-- provider — Lightpanda supersedes it).
DELETE FROM web_search_keys WHERE service = 'searxng';

-- 2. Add the new base_url column.
ALTER TABLE web_search_keys
  ADD COLUMN IF NOT EXISTS base_url TEXT;

-- 3. Drop and re-add the CHECK constraint with the new service list.
ALTER TABLE web_search_keys
  DROP CONSTRAINT IF EXISTS web_search_keys_service_check;

ALTER TABLE web_search_keys
  ADD CONSTRAINT web_search_keys_service_check
  CHECK (service IN ('tavily', 'brave', 'serpapi', 'duckduckgo', 'lightpanda'));

-- 4. Index for fast lookup by service in the new lightpanda path.
CREATE INDEX IF NOT EXISTS web_search_keys_service_idx
  ON web_search_keys (service);