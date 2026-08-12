-- Migration 0004 — web search provider configuration.
--
-- Admin stores one search-provider key per service. The key is
-- encrypted at rest with AES-256-GCM (same scheme as provider keys).
-- The system uses whichever row has connected = TRUE for that service.

CREATE TABLE web_search_keys (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service         TEXT NOT NULL CHECK (service IN ('tavily', 'brave', 'serpapi')),
  api_key_encrypted TEXT NOT NULL,
  connected       BOOLEAN NOT NULL DEFAULT TRUE,
  added_by        UUID REFERENCES users(id) ON DELETE SET NULL,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_used_at    TIMESTAMPTZ,
  UNIQUE (service)
);

-- Per-user search quota so admins can rate-limit abuse.
CREATE TABLE search_quotas (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  daily_limit      INTEGER NOT NULL DEFAULT 50,
  used_today       INTEGER NOT NULL DEFAULT 0,
  used_reset_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);