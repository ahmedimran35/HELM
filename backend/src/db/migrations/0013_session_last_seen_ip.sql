-- Add last_seen_ip column to sessions for IP-binding detection.
--
-- Background: previously the only IP we recorded was the one the user
-- had when they logged in (`sessions.ip`). If a cookie was stolen and
-- replayed from a different network, the api had no way to notice.
--
-- This migration adds `last_seen_ip`, updated on every authenticated
-- request. requireAuth compares `req.ip` against this column; if they
-- differ we log `session_hijack_suspect` and force a re-login.
--
-- Existing sessions migrate with `last_seen_ip = NULL`, which disables
-- the check for them (treated as "unknown" — first request after the
-- migration will set it from req.ip without flagging a mismatch).
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS last_seen_ip TEXT;

-- Backfill from the original login IP so the check is active for rows
-- that already have one. Rows with NULL `ip` stay NULL.
UPDATE sessions
   SET last_seen_ip = ip
 WHERE last_seen_ip IS NULL
   AND ip IS NOT NULL;