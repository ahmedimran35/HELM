// Centralized env config — fail fast at boot if anything is missing.
// All values are read once at module load time.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT_ENV = join(import.meta.dir, "..", "..", ".env");

// Lightweight .env loader — we deliberately don't depend on a runtime lib so
// the backend has zero external bootstrap beyond `bun`. Keys must be
// `KEY=value`, comments start with `#`. We do NOT export this loader; we
// just call it from this module on import.
function loadDotenv(path: string): void {
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

loadDotenv(ROOT_ENV);

function required(key: string): string {
  const v = process.env[key];
  if (!v || v.length === 0) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return v;
}

function optional(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.length > 0 ? v : fallback;
}

export const config = {
  admin: {
    username: required("ADMIN_USERNAME"),
    password: required("ADMIN_PASSWORD"),
  },
  db: {
    url: required("DATABASE_URL"),
  },
  redis: {
    url: optional("REDIS_URL", "redis://localhost:6379"),
  },
  session: {
    secret: required("SESSION_SECRET"),
    cookieName: "helm_sid",
    ttlSeconds: 60 * 60 * 24 * 7, // 7 days
  },
  api: {
    port: Number(optional("API_PORT", "3000")),
  },
  web: {
    origin: optional("WEB_ORIGIN", "http://localhost:5173"),
  },
  webSearch: {
    // Lightpanda (https://github.com/lightpanda-io/browser) is the
    // headless browser we use for live-data web search. If installed on
    // the PATH (e.g. inside the api container via docker-compose), the
    // backend can spawn it directly to fetch a URL and return its
    // rendered markdown. Override either:
    //   LIGHTPANDA_BIN   — full path to the binary (default: lightpanda)
    //   WEB_SEARCH_LIGHTPANDA_URL — optional, for long-running daemon
    //                            mode. If set, we use HTTP fetch instead of
    //                            spawning a new process per query.
    lightpandaBin: optional("LIGHTPANDA_BIN", "lightpanda"),
    lightpandaUrl: optional("WEB_SEARCH_LIGHTPANDA_URL", ""),
  },
} as const;

export type Config = typeof config;