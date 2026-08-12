-- Migration 0002 — replaces stubbed logic with real persistence:
--   * knowledge_chunks   — text chunks for RAG retrieval (keyword + tsvector)
--   * cron_runs          — execution history (real cron runs)
--   * file_blobs         — actual file bytes (BLOB) stored in Postgres
-- We do NOT add an external blob store here; storing in Postgres is the
-- smallest real storage backend that's transactional with everything
-- else. A future migration can swap in S3/MinIO without changing the API.

CREATE TABLE knowledge_chunks (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id          UUID NOT NULL REFERENCES knowledge_docs(id) ON DELETE CASCADE,
  panel_id        UUID NOT NULL REFERENCES panels(id) ON DELETE CASCADE,
  chunk_index     INTEGER NOT NULL,
  content         TEXT NOT NULL,
  token_estimate  INTEGER NOT NULL DEFAULT 0,
  search_tsv      tsvector GENERATED ALWAYS AS (
    to_tsvector('english', content)
  ) STORED,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX knowledge_chunks_doc_idx ON knowledge_chunks (doc_id, chunk_index);
CREATE INDEX knowledge_chunks_panel_tsv_idx ON knowledge_chunks USING GIN (search_tsv);

CREATE TABLE cron_runs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cron_id         UUID NOT NULL REFERENCES crons(id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at     TIMESTAMPTZ,
  status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'ok', 'error', 'skipped')),
  result          TEXT,
  tokens          INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX cron_runs_cron_idx ON cron_runs (cron_id, started_at DESC);

CREATE TABLE file_blobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mime_type       TEXT NOT NULL,
  bytes           BYTEA NOT NULL,
  sha256          TEXT NOT NULL,
  byte_size       BIGINT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX file_blobs_sha_idx ON file_blobs (sha256);

-- Extend files table with a real storage reference.
ALTER TABLE files ADD COLUMN IF NOT EXISTS blob_id UUID REFERENCES file_blobs(id) ON DELETE SET NULL;
ALTER TABLE files ADD COLUMN IF NOT EXISTS mime_type TEXT;