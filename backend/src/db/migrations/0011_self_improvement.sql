-- Migration 0011 — Tier 6 self-improvement scaffolding.
--
-- The base tables (message_feedback, user_preference_profiles,
-- self_test_results) shipped with 0009. This file adds the bits those
-- tables need that didn't make the original cut:
--
--   - messages.metadata   : a JSONB column so auto-summarisation can
--                            record source-message ids on the summary
--                            row (which is itself inserted as a system
--                            message in the panel thread).
--
-- Idempotent so the migration runner can safely re-apply in dev.

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
