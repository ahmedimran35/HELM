-- 0006 — Account lockout support.
-- Adds `failed_logins` and `locked_until` to users so credential-stuffing
-- attacks are blunted by the application layer (the IP-based rate limit
-- in middleware/ratelimit.ts is bypassed by botnets).
--
-- failed_logins: counter of recent bad-password attempts (reset on success).
-- locked_until:  timestamp; if now() < locked_until, every login is refused
--                with 423 Locked.
--
-- Reset strategy: failed_logins resets to 0 on successful login. locked_until
-- is set to now() + LOCKOUT_DURATION once a threshold is crossed. The
-- threshold + duration are env-driven so the operator can tune for risk.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS failed_logins INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS locked_until  TIMESTAMPTZ;
