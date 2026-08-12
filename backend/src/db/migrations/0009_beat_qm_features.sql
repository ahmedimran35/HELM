-- Migration 0009 — Tables for "beat qm" features.
--
-- Adds the schema for 28 features across 7 tiers. Each agent is
-- responsible for its own routes + frontend, but they share these
-- tables so cross-tier features (e.g. "summarize this workflow run"
-- + "cache this result") compose cleanly.
--
-- All timestamps TIMESTAMPTZ. UUIDs everywhere.

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- Tier 1 — Co-pilot (presence, approvals, time-travel)
-- ============================================================================

-- Per-panel live presence: who's reading / typing / editing right now.
CREATE TABLE panel_presence (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  panel_id       UUID NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status         TEXT NOT NULL CHECK (status IN ('viewing','typing','idle')),
  cursor_block   TEXT,    -- optional cursor location (e.g. message id, scroll pos)
  last_seen_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (panel_id, user_id)
);
CREATE INDEX panel_presence_panel_idx ON panel_presence (panel_id, status, last_seen_at DESC);

-- Pending approval requests. Agent emits one when it wants to call a
-- "dangerous" tool (file delete, public post, email send). Human approves
-- or denies in the UI.
CREATE TABLE approval_requests (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  panel_id        UUID REFERENCES panels(id) ON DELETE SET NULL,
  tool_name       TEXT NOT NULL,
  tool_args       JSONB NOT NULL,
  reason          TEXT,
  status          TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','denied','expired')),
  decided_by      UUID REFERENCES users(id) ON DELETE SET NULL,
  decided_at      TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '15 minutes'),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX approval_requests_pending_idx ON approval_requests (user_id, status, created_at DESC)
  WHERE status = 'pending';

-- Time-travel snapshots: every assistant turn stores a snapshot of the
-- panel state so the user can replay / branch / fork from any step.
CREATE TABLE session_snapshots (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  panel_id        UUID NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  message_id      UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  state           JSONB NOT NULL,    -- { messages, agent_state, knowledge, etc. }
  label           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX session_snapshots_panel_idx ON session_snapshots (panel_id, created_at DESC);

-- ============================================================================
-- Tier 2 — Workflow builder
-- ============================================================================

-- A workflow is a graph of nodes (trigger, agent_run, http_request,
-- panel_message, condition) connected by directed edges. Owned by a user,
-- optionally attached to a panel.
CREATE TABLE workflows (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  panel_id        UUID REFERENCES panels(id) ON DELETE SET NULL,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  graph           JSONB NOT NULL,    -- { nodes: [...], edges: [...] }
  status          TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
  trigger         TEXT,               -- 'manual' | 'schedule' | 'webhook' | 'event'
  schedule        TEXT,               -- cron expr if trigger='schedule'
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX workflows_user_idx ON workflows (user_id, enabled);
CREATE INDEX workflows_panel_idx ON workflows (panel_id);

CREATE TABLE workflow_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id     UUID NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status          TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed','paused')),
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  result          JSONB,
  error           TEXT
);
CREATE INDEX workflow_runs_workflow_idx ON workflow_runs (workflow_id, started_at DESC);

-- ============================================================================
-- Tier 3 — Voice / multimodal
-- ============================================================================

-- Uploaded file blobs (already in files table) plus voice recordings.
-- We'll reuse files table for general uploads; voice gets its own table
-- for transcripts + audio refs.
CREATE TABLE voice_recordings (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  panel_id        UUID REFERENCES panels(id) ON DELETE SET NULL,
  duration_ms     INTEGER NOT NULL,
  transcript      TEXT NOT NULL DEFAULT '',
  blob_ref        TEXT,    -- path to audio file
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Generated documents (docx, xlsx, pdf, pptx) by the agent.
CREATE TABLE generated_documents (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  panel_id        UUID REFERENCES panels(id) ON DELETE SET NULL,
  format          TEXT NOT NULL CHECK (format IN ('docx','xlsx','pdf','pptx','md','html')),
  title           TEXT NOT NULL,
  blob_ref        TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Tier 4 — Discovery (marketplace, search, knowledge graph, notifs, citations)
-- ============================================================================

-- Marketplace catalog entries — versioned, installable. Distinguishes
-- between "skill packs" (auto-loaded into agent) and "apps" (installed
-- by the user for personal use).
CREATE TABLE marketplace_entries (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            TEXT NOT NULL CHECK (kind IN ('skill_pack','app','workflow_template','persona')),
  slug            TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  version         TEXT NOT NULL DEFAULT '0.1.0',
  author          TEXT,                  -- community / org name
  tags            TEXT[] NOT NULL DEFAULT '{}',
  install_count   INTEGER NOT NULL DEFAULT 0,
  rating          REAL,                  -- 0.0 - 5.0
  manifest        JSONB NOT NULL DEFAULT '{}'::jsonb,  -- kind-specific install data
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX marketplace_entries_kind_idx ON marketplace_entries (kind, enabled);

-- Per-user installs from marketplace (separate from app_installs
-- which is for in-org custom apps).
CREATE TABLE marketplace_installs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entry_id        UUID NOT NULL REFERENCES marketplace_entries(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version         TEXT NOT NULL,
  installed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (entry_id, user_id)
);

-- Knowledge graph: entities + relationships extracted from conversations.
CREATE TABLE kg_entities (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  kind            TEXT NOT NULL,    -- 'person' | 'project' | 'topic' | 'file' | 'concept'
  attributes      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE kg_relationships (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_entity_id  UUID NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  to_entity_id    UUID NOT NULL REFERENCES kg_entities(id) ON DELETE CASCADE,
  relation        TEXT NOT NULL,    -- 'works_on' | 'depends_on' | 'mentioned_with' ...
  weight          REAL NOT NULL DEFAULT 1.0,
  source_message_id UUID REFERENCES messages(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX kg_relationships_from_idx ON kg_relationships (from_entity_id);
CREATE INDEX kg_relationships_to_idx ON kg_relationships (to_entity_id);

-- Notification preferences + queue.
CREATE TABLE notification_preferences (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,    -- 'budget_alert' | 'mention' | 'approval_needed' | 'summary_due'
  channel         TEXT NOT NULL CHECK (channel IN ('in_app','email','webhook')),
  enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  threshold       REAL,             -- e.g. 80% means "alert when budget at 80%"
  UNIQUE (user_id, kind, channel)
);

CREATE TABLE notifications (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  title           TEXT NOT NULL,
  body            TEXT NOT NULL DEFAULT '',
  link            TEXT,
  priority        TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low','normal','high','urgent')),
  read_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX notifications_user_idx ON notifications (user_id, read_at, created_at DESC);

-- Citation lineage: trace every fact back to the message / doc / URL
-- that produced it.
CREATE TABLE citations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  source_kind     TEXT NOT NULL,    -- 'web' | 'memory' | 'panel' | 'file' | 'tool'
  source_ref      TEXT NOT NULL,    -- URL, memory_id, panel_id, etc.
  excerpt         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX citations_message_idx ON citations (message_id);

-- ============================================================================
-- Tier 5 — Cost + performance (semantic cache, spend caps, model router)
-- ============================================================================

-- Semantic response cache: store previous Q→A pairs with embeddings;
-- reuse when a similar question comes in.
CREATE TABLE response_cache (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  query_hash      TEXT NOT NULL UNIQUE,    -- sha256 of normalised query
  query_text      TEXT NOT NULL,
  response_text   TEXT NOT NULL,
  model           TEXT NOT NULL,
  panel_id        UUID REFERENCES panels(id) ON DELETE SET NULL,
  hit_count       INTEGER NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_hit_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX response_cache_panel_idx ON response_cache (panel_id, created_at DESC);

-- Per-panel spend caps (extending the existing quotas/budgets system).
CREATE TABLE spend_caps (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  panel_id        UUID NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  period          TEXT NOT NULL CHECK (period IN ('day','week','month')),
  limit_cents     INTEGER NOT NULL,
  warn_at_pct     INTEGER NOT NULL DEFAULT 80,
  hard_cap        BOOLEAN NOT NULL DEFAULT FALSE,  -- true = reject over limit
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (panel_id, period)
);

-- Model router policy: per user/panel, preferred models + fallback order.
CREATE TABLE model_router_policies (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  panel_id        UUID REFERENCES panels(id) ON DELETE SET NULL,
  -- ordered list of { model_id, max_cost_cents_per_1k } entries
  preferences     JSONB NOT NULL DEFAULT '[]'::jsonb,
  fallback_model_id UUID REFERENCES models(id) ON DELETE SET NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================================
-- Tier 6 — Self-improvement
-- ============================================================================

-- User feedback on agent outputs.
CREATE TABLE message_feedback (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  message_id      UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  rating          TEXT NOT NULL CHECK (rating IN ('up','down')),
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, message_id)
);

-- Per-user preference profile derived from feedback.
CREATE TABLE user_preference_profiles (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  preferences     JSONB NOT NULL DEFAULT '{}'::jsonb,  -- { preferred_models, dislikes, etc. }
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Self-test results: agent evaluates its own outputs before returning.
CREATE TABLE self_test_results (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id      UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  checks          JSONB NOT NULL,    -- [{ name, passed, note }]
  passed          BOOLEAN NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
