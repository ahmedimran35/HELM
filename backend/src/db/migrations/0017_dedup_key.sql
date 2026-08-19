-- Migration 0017 — add `dedup_key` column to `notifications`.
--
-- The notification scheduler (see lib/notifications.ts) emits
-- user-meaningful events (budget caps, stale approvals, summary_due
-- reminders, @-mentions) once per (user_id, kind, source_ref) tuple
-- inside a 6-hour cool-off window. To make that idempotent, the
-- SELECT-then-INSERT pattern in `insertNotification` queries the
-- `notifications` table by `dedup_key` and writes the same key on
-- every new row.
--
-- The original `0009_beat_qm_features.sql` CREATE TABLE for
-- `notifications` did not include this column, so the SELECT/INSERT
-- in `insertNotification` failed with
--   "column \"dedup_key\" does not exist"
-- and every scheduler tick logged:
--   [notifications] job summary_due failed ms=4 message="column \"dedup_key\" does not exist"
-- (the same error would surface for budget_alert, approval_needed,
-- and mention as soon as a non-empty row set existed).
--
-- We add the column NULL-able so existing rows (if any) are not
-- rewritten, then backfill legacy rows with a stable key derived from
-- (user_id, kind, source_ref) so the dedup window still suppresses
-- repeats against the old data. New rows are written by the
-- application with the explicit key.
--
-- A btree index on (user_id, dedup_key, created_at) makes the dedup
-- query an index scan instead of a sequential one — important once
-- the table grows past a few thousand rows.

ALTER TABLE notifications
  ADD COLUMN IF NOT EXISTS dedup_key TEXT;

-- Backfill: synthesize a deterministic key for any pre-existing row
-- that doesn't have one. Uses id as the source_ref fallback since
-- older rows didn't carry an explicit reference.
UPDATE notifications
   SET dedup_key = user_id::text || '|' || kind || '|' || COALESCE(SUBSTRING(id::text, 1, 8), 'legacy')
 WHERE dedup_key IS NULL;

CREATE INDEX IF NOT EXISTS notifications_dedup_idx
  ON notifications (user_id, dedup_key, created_at DESC);
