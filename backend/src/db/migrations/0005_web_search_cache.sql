-- Migration 0005 — web-search result cache + free-provider support.
--
-- We cache every successful web-search result in Postgres with a 24h
-- TTL keyed by a hash of (provider, query). Repeat queries (which are
-- very common when many panels ask the same thing — e.g. "what is the
-- capital of France") never hit the upstream API after the first one.

CREATE TABLE web_search_cache (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service        TEXT NOT NULL,
  query_hash     TEXT NOT NULL,        -- sha256(service || query)
  query          TEXT NOT NULL,
  response_json  JSONB NOT NULL,       -- the full WebSearchResponse payload
  cached_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at     TIMESTAMPTZ NOT NULL,
  UNIQUE (service, query_hash)
);

CREATE INDEX web_search_cache_expires_idx ON web_search_cache (expires_at);
CREATE INDEX web_search_cache_query_idx ON web_search_cache (query_hash);

-- Add the new free providers. We allow NULL api_key since
-- DuckDuckGo's instant-answer endpoint requires no key.
ALTER TABLE web_search_keys
  DROP CONSTRAINT IF EXISTS web_search_keys_service_check;
ALTER TABLE web_search_keys
  ADD CONSTRAINT web_search_keys_service_check
  CHECK (service IN ('tavily', 'brave', 'serpapi', 'duckduckgo', 'searxng'));

-- api_key_encrypted is NOT NULL today; relax it for the keyless
-- duckduckgo case. The encrypt/decrypt helpers are no-ops on empty
-- strings, so we keep the column shape and just allow empty values.
-- (searxng was removed in migration 0006 when Lightpanda replaced it.)
ALTER TABLE web_search_keys
  ALTER COLUMN api_key_encrypted DROP NOT NULL;