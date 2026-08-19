-- ============================================================================
-- TOCTOU-safe spend cap checks
-- ============================================================================
--
-- The previous evaluateCap() read the cap row + the harness_runs aggregate in
-- a transaction with FOR UPDATE on spend_caps, but it did not lock
-- harness_runs — so two concurrent chat turns could each read the same
-- `spent` total, each decide their projected was under cap, then each commit
-- a harness_runs row and jointly bust the cap.
--
-- The fix the application now uses is a single atomic UPDATE that
-- increments a denormalised `spent_cents` counter on spend_caps only when
-- the projected total stays under `limit_cents`. The matcher-row lock from
-- UPDATE serialises every concurrent reservation against the same panel /
-- period; if no row matches (because we don't have a spend_caps row, or
-- because we'd exceed the cap) the UPDATE returns 0 rows and the caller
-- can branch on that.
--
-- The counter is kept in sync by application code (evaluateCap explicitly
-- recomputes it from harness_runs at the start of each transaction so a
-- crash doesn't desync the two sources of truth).

ALTER TABLE spend_caps
  ADD COLUMN IF NOT EXISTS spent_cents NUMERIC(12, 4) NOT NULL DEFAULT 0;

-- Look-ups by (panel, period) were already covered by the composite
-- unique constraint from migration 0009. The added column doesn't need
-- any new index.
