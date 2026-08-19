// Response cache retention.
//
// Without a sweep, `response_cache` rows with `expires_at < now()`
// accumulate (the lookup ignores them but they still occupy disk).
// We sweep every hour and prune expired rows.
//
// Frequency choice:
//   - 1 hour is short enough that no more than ~1 MB of stale rows
//     accumulate between sweeps
//   - Long enough that the sweep itself is rare (no measurable CPU
//     cost in normal operation)
//
// Storage saved:
//   - The DB query is a single `DELETE ... WHERE expires_at < now()`
//     which uses the partial index on expires_at from migration 0014.
//     Index scan, no full table scan.
//   - VACUUM is run automatically by autovacuum; we don't need to
//     trigger one explicitly.

import { sql } from "../db/client.ts";
import { log } from "./log.ts";

let scheduled = false;

const SWEEP_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export function startCacheRetention(): void {
  if (scheduled) return;
  scheduled = true;
  const tick = async () => {
    try {
      const r = await sql<{ n: number }[]>`
        DELETE FROM response_cache WHERE expires_at < now()
      `;
      const n = r[0]?.n ?? 0;
      if (n > 0) log.info(`[cache-retention] pruned ${n} expired cache rows`);
    } catch (err) {
      log.warn(`[cache-retention] sweep failed: ${(err as Error).message}`);
    }
  };
  // Run once at boot, then every hour.
  void tick();
  setInterval(tick, SWEEP_INTERVAL_MS).unref();
}
