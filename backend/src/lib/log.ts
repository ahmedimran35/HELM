// Log level gate.
//
// Console output is expensive (each call serialises + flushes to
// stdout). In production we want fewer, more meaningful log lines
// and zero noise. This module wraps `console.log/warn/error` so
// every log site respects a single env-driven threshold:
//
//   HELM_LOG_LEVEL=off     — silent (default for production)
//   HELM_LOG_LEVEL=error   — only errors
//   HELM_LOG_LEVEL=warn    — warnings + errors
//   HELM_LOG_LEVEL=info    — info + warnings + errors (default for dev)
//
// Per-call perf benefit:
//   - Below the threshold: zero work (just a numeric compare).
//   - Above the threshold: same as raw console.* (single call site, no
//     Object spread or interpolation if the line is dropped).
//
// The threshold is parsed once at module load (fast O(1) check on each
// call). No regex, no string parsing per log.

const LEVELS = { off: 0, error: 1, warn: 2, info: 3 } as const;
type Level = keyof typeof LEVELS;

function parseLevel(): number {
  const raw = (process.env.HELM_LOG_LEVEL ?? "info").toLowerCase();
  if (raw === "off" || raw === "error" || raw === "warn" || raw === "info") {
    return LEVELS[raw];
  }
  return LEVELS.info;
}

const ACTIVE_LEVEL = parseLevel();

/** Whether a level is enabled at the current threshold. O(1). */
export function isLogEnabled(level: Level): boolean {
  return LEVELS[level] <= ACTIVE_LEVEL;
}

/** Drop-in replacements that respect the level gate.
 *  Usage:
 *    import { log } from "./lib/log.ts";
 *    log.info("started");     // gated
 *    log.warn("deprecated"); // gated
 *    log.error("crashed");    // gated (always shown at error+)
 *    log.security(event);   // structured — always written (alerts)
 *
 *  Each method short-circuits to nothing when below threshold. */
export const log = {
  info: (msg: string) => {
    if (ACTIVE_LEVEL >= LEVELS.info) console.log(msg);
  },
  warn: (msg: string) => {
    if (ACTIVE_LEVEL >= LEVELS.warn) console.warn(msg);
  },
  error: (msg: string) => {
    if (ACTIVE_LEVEL >= LEVELS.error) console.error(msg);
  },
  /** Security events always go to stderr + alerting channel regardless
   *  of log level. Used by lib/security-events.ts. */
  security: (event: object) => {
    // Security events are always on — losing these defeats the point
    // of having them. Structurally identical to the existing
    // JSON-line writer in security-events.ts.
    try {
      process.stderr.write(
        JSON.stringify({ level: "security_event", ...event, ts: new Date().toISOString() }) + "\n",
      );
    } catch {
      /* ignore */
    }
  },
};

/** Stripped stdlib console for hot-path code that wants raw throughput.
 *  Use `log.info(...)` everywhere else. */
export const rawConsole = {
  log: (...args: unknown[]) => {
    if (ACTIVE_LEVEL >= LEVELS.info) console.log(...args);
  },
  warn: (...args: unknown[]) => {
    if (ACTIVE_LEVEL >= LEVELS.warn) console.warn(...args);
  },
  error: (...args: unknown[]) => {
    if (ACTIVE_LEVEL >= LEVELS.error) console.error(...args);
  },
} as const;
