-- Agents Swarm Lab (experimental) — one row per swarm run.
-- A run = 1 question fanned out to N models (2-10) that share the same
-- context (one web search, run once at start) and debate each other in
-- dynamic rounds (LLM consensus check per round, hard cap 10), then a
-- separate synthesizer call merges everything into the final answer.
-- Every individual LLM call inside a run (agent turn, scorer, consensus
-- check, synthesizer) is additionally accounted in `harness_runs` with
-- panel_id NULL — this table holds the run-level state and transcript.
CREATE TABLE IF NOT EXISTS swarm_runs (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  question         TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'running',  -- running | completed | error
  models           JSONB NOT NULL DEFAULT '[]',      -- [{model_id, external_id, label, harness}]
  rounds_completed INT  NOT NULL DEFAULT 0,
  final_answer     TEXT,
  search_sources   JSONB NOT NULL DEFAULT '[]',      -- [{title, url}]
  transcript       JSONB NOT NULL DEFAULT '[]',      -- per round: answers, scores, consensus
  error            TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at     TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS swarm_runs_user_idx ON swarm_runs (user_id, created_at DESC);
