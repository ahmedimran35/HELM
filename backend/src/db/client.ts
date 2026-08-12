// Postgres client. We use the `postgres` library (porsager/postgres) —
// tagged-template SQL, transactions, prepared statements, and a single
// shared pool for the whole backend process.

import postgres from "postgres";
import { config } from "../config.ts";

declare global {
  // eslint-disable-next-line no-var
  var __helm_sql__: ReturnType<typeof postgres> | undefined;
}

export const sql =
  globalThis.__helm_sql__ ??
  postgres(config.db.url, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    // Don't log statements at INFO — too noisy. We'll wire a custom logger
    // for errors only.
    onnotice: () => {},
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.__helm_sql__ = sql;
}