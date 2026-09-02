// Prometheus metrics for HELM (Phase 8 observability).
//
// Exposes request-count / latency / in-flight gauges plus process and
// runtime stats in Prometheus text format at GET /api/metrics.
//
// Design notes:
//   - Zero dependencies: counters and histograms are plain Maps kept
//     in module scope (one per Bun process). For multi-process deploys
//     each process exports its own series; Prometheus aggregates with
//     `sum by (...)` — same model as any Go/Python process exporter.
//   - Label cardinality is deliberately bounded: routes are normalized
//     to their paramless shape (e.g. /api/panels/:id/messages) so ids
//     can't explode the label space.
//   - The registry lives at `globalThis` in dev so `bun --watch` module
//     reloads don't reset the counters on every edit.

const REGISTRY_KEY = Symbol.for("helm.metrics.registry");

interface MetricsRegistry {
  startedAt: number;
  requestsTotal: Map<string, number>;
  requestDuration: Map<string, { buckets: number[]; counts: number[]; sum: number; count: number }>;
  inFlight: number;
  responses: { status: number; durationMs: number; route: string; method: string }[];
}

const DEFAULT_BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

function newRegistry(): MetricsRegistry {
  return {
    startedAt: Date.now(),
    requestsTotal: new Map(),
    requestDuration: new Map(),
    inFlight: 0,
    responses: [],
  };
}

// Reuse across --watch reloads in dev.
const reg: MetricsRegistry = ((globalThis as Record<symbol, unknown>)[REGISTRY_KEY] as
  | MetricsRegistry
  | undefined) ?? newRegistry();
(globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = reg;

/** Collapse a concrete request path into its paramless route shape so
 *  UUIDs and other identifiers don't blow up label cardinality. */
export function normalizeRoute(path: string): string {
  return (
    path
      // UUIDs → :id
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "/:id")
      // Long runs of digits → :id (dates, sequential ids)
      .replace(/\/\d{4,}/g, "/:id")
      // Non-UUID id-looking segments in known dynamic positions → :slug/:key
      .replace(/\/(install|installs)\/[^/]+/g, "/$1/:id")
      .replace(/\/screenshots\/[^/]+\/[^/]+/g, "/screenshots/:scope/:file")
  );
}

function bump(map: Map<string, number>, key: string) {
  map.set(key, (map.get(key) ?? 0) + 1);
}

export function recordResponse(
  method: string,
  path: string,
  status: number,
  durationMs: number
): void {
  const route = normalizeRoute(path);
  bump(reg.requestsTotal, `${method}|${route}|${status}`);
  const key = `${method}|${route}`;
  let h = reg.requestDuration.get(key);
  if (!h) {
    h = { buckets: [...DEFAULT_BUCKETS], counts: new Array(DEFAULT_BUCKETS.length).fill(0), sum: 0, count: 0 };
    reg.requestDuration.set(key, h);
  }
  h.sum += durationMs;
  h.count++;
  for (let i = 0; i < h.buckets.length; i++) {
    const bucket = h.buckets[i] ?? Infinity;
    if (durationMs <= bucket) h.counts[i] = (h.counts[i] ?? 0) + 1;
  }
}

export function scrape(): string {
  const lines: string[] = [];
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");

  lines.push("# HELP helm_up Whether the API process is serving (1).");
  lines.push("# TYPE helm_up gauge");
  lines.push("helm_up 1");

  const uptimeSec = (Date.now() - reg.startedAt) / 1000;
  lines.push("# HELP helm_uptime_seconds Process uptime in seconds.");
  lines.push("# TYPE helm_uptime_seconds gauge");
  lines.push(`helm_uptime_seconds ${uptimeSec.toFixed(1)}`);

  lines.push("# HELP helm_http_requests_in_flight Requests currently being served.");
  lines.push("# TYPE helm_http_requests_in_flight gauge");
  lines.push(`helm_http_requests_in_flight ${reg.inFlight}`);

  lines.push("# HELP helm_http_requests_total Total HTTP requests by method, route and status.");
  lines.push("# TYPE helm_http_requests_total counter");
  for (const [key, n] of [...reg.requestsTotal.entries()].sort()) {
    const [method = "?", route = "?", status = "?"] = key.split("|");
    lines.push(
      `helm_http_requests_total{method="${esc(method)}",route="${esc(route)}",status="${esc(status)}"} ${n}`
    );
  }

  lines.push("# HELP helm_http_request_duration_seconds Request latency histogram.");
  lines.push("# TYPE helm_http_request_duration_seconds histogram");
  for (const [key, h] of [...reg.requestDuration.entries()].sort()) {
    const [method = "?", route = "?"] = key.split("|");
    const label = `method="${esc(method)}",route="${esc(route)}"`;
    // counts[i] is already cumulative: recordResponse increments every
    // bucket whose le covers the duration, matching Prometheus's
    // expected _bucket semantics. Emit them as-is.
    for (let i = 0; i < h.buckets.length; i++) {
      lines.push(
        `helm_http_request_duration_seconds_bucket{${label},le="${h.buckets[i]}"} ${h.counts[i] ?? 0}`
      );
    }
    lines.push(`helm_http_request_duration_seconds_bucket{${label},le="+Inf"} ${h.count}`);
    lines.push(`helm_http_request_duration_seconds_sum{${label}} ${(h.sum / 1000).toFixed(4)}`);
    lines.push(`helm_http_request_duration_seconds_count{${label}} ${h.count}`);
  }

  // Process metrics — same source as the admin sandbox status route
  // (process.resourceUsage), so the two surfaces always agree.
  const ru = process.resourceUsage();
  lines.push("# HELP helm_process_max_rss_kb Peak resident set size (KB).");
  lines.push("# TYPE helm_process_max_rss_kb gauge");
  lines.push(`helm_process_max_rss_kb ${ru.maxRSS}`);

  lines.push("# HELP helm_process_cpu_seconds Total user+system CPU seconds.");
  lines.push("# TYPE helm_process_cpu_seconds gauge");
  const cpu = (ru.userCPUTime + ru.systemCPUTime) / 1e6;
  lines.push(`helm_process_cpu_seconds ${cpu.toFixed(2)}`);

  return lines.join("\n") + "\n";
}

/** Test hook: wipe the module registry between tests. */
export function resetMetricsForTest(): void {
  const fresh = newRegistry();
  Object.assign(reg, fresh);
  (globalThis as Record<symbol, unknown>)[REGISTRY_KEY] = reg;
}

export { reg as metricsRegistry };
