-- Migration 0008 — qm-feature parity tables.
--
-- Adds the schema needed to close the gap with yc-software/qm:
--   * harness_runs      — pluggable agent harness audit (P2)
--   * skills            — skills + skill packs + grants (P3)
--   * watches           — event-driven background work (P4)
--   * triggers          — if-X-then-do-Y rules (P4)
--   * oauth_accounts    — OAuth + device-flow tokens (P5)
--   * slack_installs    — Slack workspace bindings (P5)
--   * memory_strategies — pluggable memory strategies (P6)
--   * apps              — published internal apps (P7)
--   * app_installs      — per-panel grants for an app (P7)
--   * sandbox_sessions  — exec sessions for a sandbox (P1)
--
-- All timestamps TIMESTAMPTZ. UUIDs everywhere. No destructive
-- changes to existing tables.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- P2 — Pluggable agent harness
-- ============================================================================
-- A "harness" is the abstraction over the model runtime (Pi, OpenCode,
-- OpenAI-compat, Anthropic direct, local CLI, etc). harness_runs records
-- each invocation so we can audit latency, tokens, cost per run.
CREATE TABLE harness_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  panel_id        UUID REFERENCES panels(id) ON DELETE SET NULL,
  harness         TEXT NOT NULL,           -- 'openai' | 'anthropic' | 'pi' | 'cli' | 'mock'
  model           TEXT,                    -- external model id, nullable for mock
  prompt_tokens   INTEGER NOT NULL DEFAULT 0,
  completion_tokens INTEGER NOT NULL DEFAULT 0,
  latency_ms      INTEGER NOT NULL DEFAULT 0,
  status          TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'error', 'canceled')),
  error           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX harness_runs_user_idx  ON harness_runs (user_id, created_at DESC);
CREATE INDEX harness_runs_panel_idx ON harness_runs (panel_id, created_at DESC);

-- ============================================================================
-- P3 — Skills + skill packs
-- ============================================================================
-- A skill is a markdown document with YAML frontmatter describing a
-- reusable agent behavior. Skills are scope-owned and can be shared via
-- grants. Skill packs are importable directories (initially from a git
-- repo) that contain many skills.
CREATE TABLE skills (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  pack_id         UUID,                   -- FK to skill_packs (nullable: an ad-hoc skill)
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  body            TEXT NOT NULL,          -- markdown
  scope           TEXT NOT NULL DEFAULT 'org' CHECK (scope IN ('org', 'panel', 'user')),
  owner_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
  owner_panel_id  UUID REFERENCES panels(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL DEFAULT 'prompt' CHECK (kind IN ('prompt', 'tool', 'workflow')),
  tags            TEXT[] NOT NULL DEFAULT '{}',
  version         TEXT NOT NULL DEFAULT '0.1.0',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX skills_pack_idx ON skills (pack_id);
CREATE INDEX skills_scope_owner_idx ON skills (scope, owner_user_id, owner_panel_id);

CREATE TABLE skill_packs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL UNIQUE,
  source          TEXT NOT NULL,           -- 'git:url' | 'local:path' | 'inline'
  source_ref      TEXT NOT NULL,           -- e.g. git url or local path
  description     TEXT NOT NULL DEFAULT '',
  version         TEXT NOT NULL DEFAULT '0.1.0',
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A panel can opt into a skill. Per-panel grant, separate from the
-- skill's own scope.
CREATE TABLE skill_grants (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_id        UUID NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  panel_id        UUID NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  granted_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  granted_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (skill_id, panel_id)
);

-- ============================================================================
-- P4 — Background work beyond crons: watches + triggers
-- ============================================================================
-- A watch fires on a schedule OR an event. A trigger is a rule that
-- evaluates to "true" and fires an action. Both schedule a run via the
-- existing job queue.
CREATE TABLE watches (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  source          TEXT NOT NULL CHECK (source IN ('schedule', 'webhook', 'email', 'file', 'manual')),
  -- For source='schedule', `cron` is a 5-field cron expr.
  -- For source='webhook', `path` is the URL slug and `secret` is the bearer.
  -- For source='file', `path` is a glob relative to the sandbox.
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  action          TEXT NOT NULL,           -- 'panel_message' | 'http_post' | 'agent_run'
  action_config   JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  last_fired_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX watches_user_idx ON watches (user_id, enabled);

CREATE TABLE triggers (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  -- `when` is a simple JSON predicate (left as opaque to keep the schema
  -- stable; the engine evaluates against the watch payload). Operators
  -- are 'eq' | 'gt' | 'lt' | 'contains' | 'exists'.
  when_clause     JSONB NOT NULL DEFAULT '[]'::jsonb,
  then_action     TEXT NOT NULL,
  then_config     JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX triggers_user_idx ON triggers (user_id, enabled);

-- Append-only run log for watches/triggers so the user can see history.
CREATE TABLE watch_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  watch_id        UUID REFERENCES watches(id) ON DELETE SET NULL,
  trigger_id      UUID REFERENCES triggers(id) ON DELETE SET NULL,
  user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok','error','skipped')),
  message         TEXT
);
CREATE INDEX watch_runs_watch_idx ON watch_runs (watch_id, started_at DESC);

-- ============================================================================
-- P5 — OAuth providers + Slack-native inbound
-- ============================================================================
CREATE TABLE oauth_accounts (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL CHECK (provider IN ('google','github','microsoft','slack')),
  account_id      TEXT NOT NULL,           -- external subject id
  account_email   TEXT,
  account_name    TEXT,
  access_token_encrypted TEXT NOT NULL,
  refresh_token_encrypted TEXT,
  scopes          TEXT[] NOT NULL DEFAULT '{}',
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (provider, account_id)
);
CREATE INDEX oauth_accounts_user_idx ON oauth_accounts (user_id, provider);

-- One row per Slack workspace that has installed HELM.
CREATE TABLE slack_installs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         TEXT NOT NULL UNIQUE,
  team_name       TEXT NOT NULL,
  bot_token_encrypted TEXT NOT NULL,
  installed_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Inbound Slack events. Used for audit + replay.
CREATE TABLE slack_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  install_id      UUID REFERENCES slack_installs(id) ON DELETE SET NULL,
  event_type      TEXT NOT NULL,           -- 'message' | 'slash_command' | 'app_mention'
  channel_id      TEXT,
  user_id         TEXT,
  payload         JSONB NOT NULL,
  handled         BOOLEAN NOT NULL DEFAULT FALSE,
  received_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX slack_events_install_idx ON slack_events (install_id, received_at DESC);

-- ============================================================================
-- P6 — Pluggable memory strategies
-- ============================================================================
-- A memory strategy is a named, configurable way to store + recall entries.
-- Built-ins: 'rows' (current behavior), 'summary' (rolling summarization).
-- Future: 'vector' (semantic search).
CREATE TABLE memory_strategies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scope           TEXT NOT NULL CHECK (scope IN ('personal','team','admin')),
  -- scope_id is null when scope='org' (applies to everyone); otherwise the
  -- id of the user / panel / org unit.
  scope_id        UUID,
  kind            TEXT NOT NULL CHECK (kind IN ('rows','summary','vector')),
  config          JSONB NOT NULL DEFAULT '{}'::jsonb,
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  priority        INTEGER NOT NULL DEFAULT 100,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (scope, scope_id, kind)
);

-- ============================================================================
-- P7 — Web apps platform
-- ============================================================================
-- An "app" is a deployable mini-app (form, dashboard, runbook). Apps have a
-- bundle (frontend) + a server-side config that defines routes, data
-- sources, and permissions.
CREATE TABLE apps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            TEXT NOT NULL UNIQUE,     -- /apps/:slug
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  -- bundle_url points at a static bundle (CDN or local /apps-bundles/).
  -- For dev, we'll host the bundle behind /apps/{slug}/_/.
  bundle_url      TEXT,
  routes          JSONB NOT NULL DEFAULT '[]'::jsonb,  -- [{path, requires, ...}]
  data_sources    JSONB NOT NULL DEFAULT '[]'::jsonb,  -- named data bindings
  permissions     JSONB NOT NULL DEFAULT '[]'::jsonb,  -- required scopes/roles
  version         TEXT NOT NULL DEFAULT '0.1.0',
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A panel (or user) can install an app, giving it access to that scope's
-- data. Installations are explicit, like Slack installs.
CREATE TABLE app_installs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  panel_id        UUID REFERENCES panels(id) ON DELETE CASCADE,
  user_id         UUID REFERENCES users(id) ON DELETE CASCADE,
  granted_scopes  TEXT[] NOT NULL DEFAULT '{}',
  installed_by    UUID REFERENCES users(id) ON DELETE SET NULL,
  installed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- exactly one of panel_id / user_id is set
  CHECK ((panel_id IS NOT NULL) <> (user_id IS NOT NULL))
);

CREATE TABLE app_data (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  app_id          UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  install_id      UUID NOT NULL REFERENCES app_installs(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  value           JSONB NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (install_id, key)
);

-- ============================================================================
-- P1 — Sandbox sessions (extend existing sandboxes table)
-- ============================================================================
-- The existing `sandboxes` row tracks per-user CPU/mem status. Sessions
-- are individual exec invocations within that sandbox.
CREATE TABLE sandbox_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  panel_id        UUID REFERENCES panels(id) ON DELETE CASCADE,
  -- mode: 'shell' for one-off exec, 'repl' for an interactive session.
  mode            TEXT NOT NULL DEFAULT 'shell' CHECK (mode IN ('shell','repl')),
  cwd             TEXT NOT NULL DEFAULT '/',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at        TIMESTAMPTZ,
  exit_code       INTEGER,
  bytes_written   INTEGER NOT NULL DEFAULT 0,
  bytes_read      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX sandbox_sessions_user_idx ON sandbox_sessions (user_id, started_at DESC);

-- Files created in the sandbox live in the existing `files` table (it
-- already has owner_user_id + panel_id). We just give it a new path
-- column so sessions can store relative paths.
ALTER TABLE files
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES sandbox_sessions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sandbox_path TEXT;

CREATE INDEX files_session_idx ON files (session_id);
