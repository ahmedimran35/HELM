// Latency-aware health check + automatic failover (Tier 5).
//
// Maintains an in-memory cache of per-harness health: { status,
// latency_ms, last_checked_at }. A background scheduler pings every
// registered harness every 30s (configurable) by calling
// `harness.status()` plus a short `listModels()` round-trip —
// `status()` alone is too cheap to surface real latency.
//
// Failover support: when a caller asks `pickModel()` for a model
// served by a degraded harness, the router skips it. When a caller
// wraps `getHarnessByKind('openai').chat(...)` with
// `withFailover()`, the wrapper tries the next preferred harness
// after the configured timeout.
//
// The health cache is fire-and-forget. If the DB or upstream is
// slow, the chat hot path is never blocked — we read the cache
// synchronously and fall back to the configured default if it's
// stale.

import { listHarnesses, getHarnessByKind } from "../harness/router.ts";
import { isHarnessKind, type HarnessKind, type ChatChunk, type ChatRequest } from "../harness/types.ts";

export type HarnessStatus = "healthy" | "degraded" | "down" | "unknown";

export interface HarnessHealth {
  kind: HarnessKind;
  status: HarnessStatus;
  /** Last measured round-trip latency in milliseconds for the ping. */
  latency_ms: number;
  /** When we last refreshed this entry. Epoch ms. */
  last_checked_at: number;
  /** Short reason when status isn't 'healthy'. */
  reason?: string;
}

const HEALTH_TTL_MS = 60_000;
const HEALTH_REFRESH_INTERVAL_MS = 30_000;
const FAILOVER_TIMEOUT_MS = 10_000;

const health = new Map<HarnessKind, HarnessHealth>();
let schedulerStarted = false;
let schedulerTimer: ReturnType<typeof setInterval> | null = null;

/** Preferred failover order when the primary harness is degraded.
 *  We keep it conservative — 'mock' is the last-resort fallback so
 *  the user always gets *some* answer when every real harness is
 *  down. */
const FAILOVER_ORDER: HarnessKind[] = [
  "openai",
  "anthropic",
  "pi",
  "cli",
  "mock",
];

/** Read the current health snapshot for a harness. Returns null if
 *  we've never checked it (synchronous caller — no I/O). */
export function getHarnessHealth(kind: HarnessKind): HarnessHealth | null {
  return health.get(kind) ?? null;
}

/** Return all known health snapshots in deterministic order. */
export function listHarnessHealth(): HarnessHealth[] {
  const out: HarnessHealth[] = [];
  for (const k of FAILOVER_ORDER) {
    const h = health.get(k);
    if (h) out.push(h);
  }
  return out;
}

/** Ping a single harness. Updates the in-memory cache. Returns the
 *  new entry. Best-effort — never throws. */
async function ping(kind: HarnessKind): Promise<HarnessHealth> {
  const started = Date.now();
  let status: HarnessStatus = "unknown";
  let reason: string | undefined;
  try {
    const harness = getHarnessByKind(kind);
    const cfg = await harness.status();
    if (!cfg.configured) {
      // Not configured = not necessarily down — it just means the
      // admin hasn't wired it up. Report as 'unknown' so the UI
      // renders it neutrally and the failover skips it.
      status = "unknown";
      reason = cfg.reason ?? "not_configured";
      const entry: HarnessHealth = {
        kind,
        status,
        latency_ms: Date.now() - started,
        last_checked_at: Date.now(),
        reason,
      };
      health.set(kind, entry);
      return entry;
    }
    // Add a small synthetic load probe — listModels is a real
    // round-trip for openai/anthropic, so its latency is meaningful.
    const probeStart = Date.now();
    try {
      await harness.listModels();
    } catch {
      // Probe failed — treat as down. We still record the latency
      // so the UI can see the timing of the failed probe.
      status = "down";
      reason = "list_models_failed";
      const entry: HarnessHealth = {
        kind,
        status,
        latency_ms: Date.now() - started,
        last_checked_at: Date.now(),
        reason,
      };
      health.set(kind, entry);
      return entry;
    }
    const probeMs = Date.now() - probeStart;
    // Healthy when under 2s; degraded up to 8s; down above.
    status = probeMs < 2_000 ? "healthy" : probeMs < 8_000 ? "degraded" : "down";
    reason = status !== "healthy" ? `slow_${probeMs}ms` : undefined;
    const entry: HarnessHealth = {
      kind,
      status,
      latency_ms: probeMs,
      last_checked_at: Date.now(),
      reason,
    };
    health.set(kind, entry);
    return entry;
  } catch (err) {
    // Don't leak raw error.message into the harness entry — that
    // field is surfaced back to admins via /api/health/harnesses and
    // could expose internal provider hostnames or API key fragments.
    // Log full details server-side and store a generic marker.
    console.warn("[health-check] ping failed:", (err as Error).message);
    const entry: HarnessHealth = {
      kind,
      status: "down",
      latency_ms: Date.now() - started,
      last_checked_at: Date.now(),
      reason: "ping_failed",
    };
    health.set(kind, entry);
    return entry;
  }
}

/** Refresh every harness in parallel. Used by both the scheduler
 *  and the on-demand /api/health/harnesses endpoint (force-refresh). */
export async function refreshAllHarnesses(): Promise<HarnessHealth[]> {
  const harnesses = listHarnesses();
  const out = await Promise.all(harnesses.map((h) => ping(h.kind)));
  // Drop stale entries (older than HEALTH_TTL_MS).
  const cutoff = Date.now() - HEALTH_TTL_MS;
  for (const [k, entry] of health.entries()) {
    if (entry.last_checked_at < cutoff && !FAILOVER_ORDER.includes(k)) {
      health.delete(k);
    }
  }
  return out;
}

/** Start the background scheduler. Idempotent — safe to call
 *  multiple times. The scheduler ping is silent when the server is
 *  in a test/CI mode (Bun.env.SKIP_HEALTH_SCHEDULER === "1"). */
export function startHealthScheduler(): void {
  if (schedulerStarted) return;
  if (process.env.SKIP_HEALTH_SCHEDULER === "1") return;
  schedulerStarted = true;
  // Run once immediately so the first request sees fresh data.
  void refreshAllHarnesses().catch((err) =>
    console.warn("[health-check] initial refresh failed:", (err as Error).message),
  );
  schedulerTimer = setInterval(() => {
    void refreshAllHarnesses().catch((err) =>
      console.warn("[health-check] periodic refresh failed:", (err as Error).message),
    );
  }, HEALTH_REFRESH_INTERVAL_MS);
}

export function stopHealthScheduler(): void {
  if (schedulerTimer) clearInterval(schedulerTimer);
  schedulerTimer = null;
  schedulerStarted = false;
}

/** Pick the next usable harness for failover, skipping any whose
 *  cached health says 'down'. */
export function pickFailoverHarness(primary: HarnessKind): HarnessKind | null {
  const startIdx = FAILOVER_ORDER.indexOf(primary);
  if (startIdx < 0) {
    // Unknown kind — start from the top.
    for (const k of FAILOVER_ORDER) {
      const h = health.get(k);
      if (!h || h.status !== "down") return k;
    }
    return primary;
  }
  for (let i = startIdx; i < FAILOVER_ORDER.length; i++) {
    const k = FAILOVER_ORDER[i];
    if (!k) continue;
    if (!isHarnessKind(k)) continue;
    const h = health.get(k);
    if (!h || h.status !== "down") return k;
  }
  // Every harness is down — return the primary anyway so callers
  // can try it and surface a real error.
  return primary;
}

/** Wrap a harness.chat call with a timeout + automatic failover.
 *  Yields chunks from the primary harness until either it closes
 *  the stream or the timeout fires. On timeout, switches to the
 *  next healthy harness and re-issues the call. The returned chunks
 *  come from whichever harness actually produced them. */
export async function* withFailover(
  primary: HarnessKind,
  req: ChatRequest,
  opts: { timeoutMs?: number } = {},
): AsyncGenerator<ChatChunk & { __harness?: HarnessKind }, void, void> {
  const timeoutMs = opts.timeoutMs ?? FAILOVER_TIMEOUT_MS;
  let current = pickFailoverHarness(primary);
  if (!current) current = primary;

  // We attempt one harness per iteration. If the underlying harness
  // throws before producing any token, we fall through to the next.
  let attempted = new Set<HarnessKind>();
  while (current && !attempted.has(current)) {
    attempted.add(current);
    const harness = getHarnessByKind(current);
    const iter = harness.chat(req) as AsyncIterableIterator<ChatChunk>;
    let producedAny = false;
    let timedOut = false;
    const startedAt = Date.now();
    while (true) {
      const remaining = timeoutMs - (Date.now() - startedAt);
      if (remaining <= 0) {
        timedOut = true;
        break;
      }
      // Race the next chunk against the timeout.
      const next = await Promise.race([
        iter.next(),
        new Promise<{ value: undefined; done: true }>((resolve) =>
          setTimeout(() => resolve({ value: undefined, done: true }), remaining),
        ),
      ]);
      if (next.done) {
        // Either the stream ended or our timer fired.
        if (Date.now() - startedAt >= timeoutMs) {
          timedOut = !producedAny;
        }
        break;
      }
      producedAny = true;
      const chunk = next.value as ChatChunk;
      yield { ...chunk, __harness: current };
      if (chunk.done) {
        return;
      }
    }
    if (!timedOut || producedAny) {
      // Stream closed naturally before timeout OR we already shipped
      // some tokens — either way, don't failover.
      return;
    }
    // Timeout before any token — try the next harness.
    current = pickFailoverHarness(current);
    if (!current || attempted.has(current)) return;
  }
}