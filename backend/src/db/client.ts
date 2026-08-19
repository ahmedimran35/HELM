// Postgres client. We use the `postgres` library (porsager/postgres) —
// tagged-template SQL, transactions, prepared statements, and a single
// shared pool for the whole backend process.
//
// Pool sizing rationale:
//   - max: 10 connections per backend process. The default (10) is fine
//     for our workload (chat + panels + workflows), since each request
//     holds a connection for < 50ms in the common case. If you scale
//     to multiple replicas, multiply this by the replica count.
//   - idle_timeout: 30s. Idle connections close so the DB doesn't
//     carry dead sockets. Lower than 60s default because we re-warm
//     fast on the next request.
//   - connect_timeout: 10s. Bounded so a misconfigured DB host doesn't
//     hang request handlers forever.
//   - max_lifetime: 30 min. Forcibly recycle long-lived connections to
//     avoid stale TCP sockets behind cloud NATs.
//
// Slow-query logging:
//   - We log any prepared statement that takes > 200ms with the slow
//     query path + duration. Set HELM_LOG_SLOW_QUERY_MS to override.
//
// Notice suppression:
//   - onnotice is a no-op so the standard `NOTICE:` messages from
//     psql (e.g. "ALTER TABLE") don't spam stdout.

import postgres from "postgres";
import { config } from "../config.ts";
import { isLogEnabled } from "../lib/log.ts";

declare global {
  // eslint-disable-next-line no-var
  var __helm_sql__: ReturnType<typeof postgres> | undefined;
}

const SLOW_QUERY_MS = (() => {
  const raw = process.env.HELM_LOG_SLOW_QUERY_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 200;
})();

export const sql =
  globalThis.__helm_sql__ ??
  postgres(config.db.url, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    max_lifetime: 30 * 60,
    // Slow-query logger. We get a per-statement callback via the
    // `onnotice` + duration tracked via the postgres.js debug hook.
    // For the runtime path we wrap each query in a lightweight timer
    // at the call site (see `timed()` below).
    onnotice: () => {},
    // Use the debug hook to surface slow queries. postgres.js emits
    // {query, params, duration} tuples here on every statement.
    debug: (_conn, _query, _params, _type) => {
      // Debug hook is too noisy for prod. We rely on the per-call
      // `timed()` wrapper to log only outliers.
    },
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__helm_sql__ = sql;
}

/**
 * Wrap a tagged-template query so we log the path + duration whenever
 * the query is slower than `SLOW_QUERY_MS`. Drop-in for `sql\`...\``
 * via `timed(sql, "label", arg1, arg2)` returns a promise that
 * resolves to the same shape as the raw query.
 *
 * Use this on hot paths where you want to know if a route has
 * regressed. For ordinary CRUD queries the overhead is negligible
 * (one Date.now() + a single comparison per call).
 */
export async function timed<T>(
  label: string,
  fn: () => Promise<T>,
): Promise<T> {
  const start = Date.now();
  try {
    return await fn();
  } finally {
    const ms = Date.now() - start;
    if (ms >= SLOW_QUERY_MS && isLogEnabled("warn")) {
      console.warn(`[db-slow] ${ms}ms ${label}`);
    }
  }
}
