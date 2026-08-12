-- Migration 0007 — Real memory with three scopes.
--
-- The current `memory_entries` table is per-user only. This migration
-- extends it with a `scope` column so each entry can be tagged as:
--
--   'personal' — only the creator sees it (default; backward compatible)
--   'team'     — shared between admin and all members of the team
--   'admin'    — only admins can see it (privileged notes, e.g. "stop
--                using this provider", "user X has a billing exception")
--
-- The `user_id` column becomes nullable: a 'team' or 'admin' entry
-- has an author (user_id) for accountability, but the entry is not
-- "owned" by any single user.
--
-- The routes enforce:
--   read  personal → only owner; team → all; admin → all admins
--   write personal → owner only; team → any auth user; admin → admins only
--   delete → owner of personal, or any admin

ALTER TABLE memory_entries
  ALTER COLUMN user_id DROP NOT NULL;

ALTER TABLE memory_entries
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'personal'
    CHECK (scope IN ('personal', 'team', 'admin'));

-- Speed up the per-scope "feed" reads.
CREATE INDEX memory_entries_scope_idx
  ON memory_entries (scope, created_at DESC);
