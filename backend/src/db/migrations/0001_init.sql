-- ============================================================================
-- HELM — initial schema (Phase 0 + all future phases)
-- ----------------------------------------------------------------------------
-- Every entity listed in CwLab-project-docs.md §4 is created here so later
-- phases can rely on a stable shape instead of touching the schema each round.
-- We add a synthetic `id` primary key even where the docs show composite keys
-- (model_access, panel_members, etc.) — keeps FKs uniform across the codebase.
-- UUIDs everywhere; no serial types.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- Users + sessions + sessions table (yes, both for HTTP cookies and the
-- session-tracking feature in §2.7)
-- ----------------------------------------------------------------------------
CREATE TABLE users (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   TEXT NOT NULL,
  username               TEXT NOT NULL UNIQUE,
  password_hash          TEXT NOT NULL,
  role                   TEXT NOT NULL CHECK (role IN ('admin', 'user')),
  must_change_password   BOOLEAN NOT NULL DEFAULT FALSE,
  is_active              BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_by             UUID REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE sessions (
  -- This table doubles: it backs both HTTP session cookies (lookups by id)
  -- and the §2.7 admin Sessions tab (login_at, ip, sections_visited).
  -- `expires_at` is the cookie expiry; `logout_at` is set when the user logs
  -- out or the session is killed.
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  login_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  logout_at              TIMESTAMPTZ,
  last_seen_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at             TIMESTAMPTZ NOT NULL,
  ip                     TEXT,
  user_agent             TEXT,
  sections_visited       TEXT[] NOT NULL DEFAULT '{}'::TEXT[]
);

CREATE INDEX sessions_user_idx ON sessions (user_id, login_at DESC);
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- ----------------------------------------------------------------------------
-- AI providers + models + access grants
-- ----------------------------------------------------------------------------
CREATE TABLE providers (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type                   TEXT NOT NULL,                  -- 'openai' | 'anthropic' | 'nvidia-nim' | 'openai-compatible'
  base_url               TEXT NOT NULL,
  api_key_encrypted      TEXT NOT NULL,                  -- never returned to clients
  display_name           TEXT,
  added_by               UUID REFERENCES users(id) ON DELETE SET NULL,
  added_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE models (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider_id            UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
  external_id            TEXT NOT NULL,                  -- id from the upstream provider
  display_name           TEXT NOT NULL,
  state                  TEXT NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'deprecated')),
  context_window         INTEGER,
  input_price_per_1k     NUMERIC(12, 6),
  output_price_per_1k    NUMERIC(12, 6),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider_id, external_id)
);

-- model_access: doc notation is "(user_id | panel_id, model_id, granted_at,
-- granted_by)". We model it as one table with a nullable panel_id and a
-- nullable user_id; one of them must be set.
CREATE TABLE model_access (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID REFERENCES users(id) ON DELETE CASCADE,
  panel_id               UUID,                          -- FK added after panels table
  model_id               UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  granted_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  granted_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  CHECK (user_id IS NOT NULL OR panel_id IS NOT NULL)
);

CREATE UNIQUE INDEX model_access_user_unique ON model_access (user_id, model_id) WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX model_access_panel_unique ON model_access (panel_id, model_id) WHERE panel_id IS NOT NULL;

CREATE TABLE access_requests (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  model_id               UUID NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  panel_id               UUID,                          -- FK added below
  status                 TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'denied')),
  requested_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at             TIMESTAMPTZ
);

CREATE INDEX access_requests_status_idx ON access_requests (status, requested_at DESC);

-- ----------------------------------------------------------------------------
-- Panels + membership + persona + RAG knowledge
-- ----------------------------------------------------------------------------
CREATE TABLE personas (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   TEXT NOT NULL UNIQUE,
  description            TEXT NOT NULL DEFAULT '',
  system_prompt          TEXT NOT NULL DEFAULT '',
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE panels (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name                   TEXT NOT NULL,
  agent_model_id         UUID REFERENCES models(id) ON DELETE SET NULL,
  persona_id             UUID REFERENCES personas(id) ON DELETE SET NULL,
  created_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Now we can wire the back-references that depend on `panels`.
ALTER TABLE model_access
  ADD CONSTRAINT model_access_panel_fk
  FOREIGN KEY (panel_id) REFERENCES panels(id) ON DELETE CASCADE;
ALTER TABLE access_requests
  ADD CONSTRAINT access_requests_panel_fk
  FOREIGN KEY (panel_id) REFERENCES panels(id) ON DELETE CASCADE;

CREATE TABLE panel_members (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  panel_id               UUID NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  joined_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (panel_id, user_id)
);

CREATE TABLE messages (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID REFERENCES users(id) ON DELETE SET NULL,
  panel_id               UUID REFERENCES panels(id) ON DELETE CASCADE,
  model_id               UUID REFERENCES models(id) ON DELETE SET NULL,
  role                   TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  content                TEXT NOT NULL,
  tokens                 INTEGER NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR panel_id IS NOT NULL)
);

CREATE INDEX messages_panel_idx ON messages (panel_id, created_at DESC);
CREATE INDEX messages_user_idx ON messages (user_id, created_at DESC);

CREATE TABLE knowledge_docs (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  panel_id               UUID NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  chunk_count            INTEGER NOT NULL DEFAULT 0,
  uploaded_by            UUID REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- Workspace: memory, files, sandbox, keychain, crons, tool posture
-- ----------------------------------------------------------------------------
CREATE TABLE memory_entries (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  text                   TEXT NOT NULL,
  source_type            TEXT NOT NULL,                 -- 'chat' | 'panel' | 'manual'
  source_id              UUID,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX memory_entries_user_idx ON memory_entries (user_id, created_at DESC);

CREATE TABLE files (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id          UUID REFERENCES users(id) ON DELETE CASCADE,
  panel_id               UUID REFERENCES panels(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  size                   BIGINT NOT NULL DEFAULT 0,
  path                   TEXT NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (owner_user_id IS NOT NULL OR panel_id IS NOT NULL)
);

CREATE UNIQUE INDEX files_user_name_unique ON files (owner_user_id, name) WHERE owner_user_id IS NOT NULL;
CREATE UNIQUE INDEX files_panel_name_unique ON files (panel_id, name) WHERE panel_id IS NOT NULL;

CREATE TABLE sandboxes (
  user_id                UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  status                 TEXT NOT NULL DEFAULT 'stopped' CHECK (status IN ('stopped', 'running', 'error')),
  cpu_pct                NUMERIC(5, 2) NOT NULL DEFAULT 0,
  mem_pct                NUMERIC(5, 2) NOT NULL DEFAULT 0,
  last_reset_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE keychain_grants (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  credential_name        TEXT NOT NULL,
  scope                  TEXT NOT NULL DEFAULT '',
  granted_by             UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, credential_name)
);

CREATE TABLE crons (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name                   TEXT NOT NULL,
  schedule               TEXT NOT NULL,                 -- cron expr
  last_run_at            TIMESTAMPTZ,
  next_run_at            TIMESTAMPTZ,
  enabled                BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tool_posture (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID REFERENCES users(id) ON DELETE CASCADE,
  panel_id               UUID REFERENCES panels(id) ON DELETE CASCADE,
  tool_name              TEXT NOT NULL,
  posture                TEXT NOT NULL DEFAULT 'auto' CHECK (posture IN ('strict', 'auto')),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (user_id IS NOT NULL OR panel_id IS NOT NULL),
  UNIQUE (user_id, tool_name)
);

-- ----------------------------------------------------------------------------
-- Governance: quotas, budgets
-- ----------------------------------------------------------------------------
CREATE TABLE quotas (
  user_id                UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  message_limit          INTEGER,                       -- null = unlimited
  period                 TEXT NOT NULL DEFAULT 'month' CHECK (period IN ('day', 'week', 'month'))
);

CREATE TABLE budgets (
  user_id                UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  dollar_limit           NUMERIC(12, 2),                -- null = unlimited
  period                 TEXT NOT NULL DEFAULT 'month' CHECK (period IN ('day', 'week', 'month'))
);

-- ----------------------------------------------------------------------------
-- Integrations + audit log
-- ----------------------------------------------------------------------------
CREATE TABLE integrations (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  service                TEXT NOT NULL CHECK (service IN ('discord', 'telegram', 'slack')),
  webhook_url            TEXT NOT NULL,
  events                 TEXT[] NOT NULL DEFAULT '{}'::TEXT[],
  connected              BOOLEAN NOT NULL DEFAULT TRUE,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (service)
);

CREATE TABLE audit_log (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                UUID REFERENCES users(id) ON DELETE SET NULL,
  target                 TEXT NOT NULL,                 -- model id, panel id, etc.
  action                 TEXT NOT NULL,
  tokens                 INTEGER NOT NULL DEFAULT 0,
  metadata               JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX audit_log_user_idx ON audit_log (user_id, created_at DESC);
CREATE INDEX audit_log_target_idx ON audit_log (target, created_at DESC);

-- ----------------------------------------------------------------------------
-- Bootstrap marker — a single row that records the first boot. Lets later
-- code tell whether the initial admin seed ran, without having to inspect
-- `users`. (For §8.4: "restarting the server with a populated users table
-- does not re-seed".)
-- ----------------------------------------------------------------------------
CREATE TABLE bootstrap_meta (
  id                     INTEGER PRIMARY KEY CHECK (id = 1),  -- always exactly one row
  bootstrapped_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  bootstrapped_admin_id  UUID REFERENCES users(id) ON DELETE SET NULL
);

INSERT INTO bootstrap_meta (id) VALUES (1);