// Unit tests for the Prometheus metrics registry (lib/metrics.ts).
// Pins: route-label cardinality collapsing, counter accumulation,
// histogram bucket semantics, and scrape-format invariants.

import { describe, test, expect, beforeEach } from "bun:test";
import {
  normalizeRoute,
  recordResponse,
  scrape,
  resetMetricsForTest,
  metricsRegistry,
} from "./metrics.ts";

beforeEach(() => {
  resetMetricsForTest();
});

describe("normalizeRoute (label cardinality)", () => {
  test("collapses UUIDs to :id", () => {
    expect(normalizeRoute("/api/panels/550e8400-e29b-41d4-a716-446655440000/messages")).toBe(
      "/api/panels/:id/messages"
    );
  });

  test("collapses long numeric ids to :id", () => {
    expect(normalizeRoute("/api/logs/activity/20260902120000")).toBe(
      "/api/logs/activity/:id"
    );
  });

  test("leaves static routes untouched", () => {
    expect(normalizeRoute("/api/health")).toBe("/api/health");
    expect(normalizeRoute("/api/chat")).toBe("/api/chat");
  });

  test("collapses screenshot paths (scope + file labels)", () => {
    expect(normalizeRoute("/api/browser/screenshots/user-1/1690000000000.png")).toBe(
      "/api/browser/screenshots/:scope/:file"
    );
  });

  test("collapses install ids", () => {
    expect(normalizeRoute("/api/app-data/550e8400-e29b-41d4-a716-446655440000/theme")).toBe(
      "/api/app-data/:id/theme"
    );
  });
});

describe("recordResponse + scrape", () => {
  test("counts requests by method/route/status", () => {
    recordResponse("GET", "/api/health", 200, 3);
    recordResponse("GET", "/api/health", 200, 4);
    recordResponse("GET", "/api/panels", 403, 12);
    const out = scrape();
    expect(out).toContain(
      'helm_http_requests_total{method="GET",route="/api/health",status="200"} 2'
    );
    expect(out).toContain(
      'helm_http_requests_total{method="GET",route="/api/panels",status="403"} 1'
    );
  });

  test("histogram buckets are cumulative and monotone", () => {
    // 1ms → lands in every bucket ≥ le=5; 600ms → only le ≥ 1000.
    recordResponse("GET", "/api/health", 200, 1);
    recordResponse("GET", "/api/health", 200, 600);
    const out = scrape();
    const b5 = out.match(/duration_seconds_bucket\{method="GET",route="\/api\/health",le="5"\} (\d+)/);
    const b1000 = out.match(
      /duration_seconds_bucket\{method="GET",route="\/api\/health",le="1000"\} (\d+)/)
    ;
    const inf = out.match(/duration_seconds_bucket\{method="GET",route="\/api\/health",le="\+Inf"\} (\d+)/);
    expect(b5?.[1]).toBe("1");
    expect(b1000?.[1]).toBe("2");
    expect(inf?.[1]).toBe("2");
  });

  test("sum is in seconds and count matches", () => {
    recordResponse("POST", "/api/chat", 200, 1500);
    const out = scrape();
    expect(out).toContain('helm_http_request_duration_seconds_sum{method="POST",route="/api/chat"}');
    expect(out).toMatch(/duration_seconds_count\{method="POST",route="\/api\/chat"\} 1/);
  });

  test("scrape exposes uptime, in-flight and process gauges", () => {
    metricsRegistry.inFlight = 2;
    const out = scrape();
    expect(out).toContain("helm_up 1");
    expect(out).toContain("helm_http_requests_in_flight 2");
    expect(out).toContain("helm_uptime_seconds ");
    expect(out).toContain("helm_process_max_rss_kb ");
    expect(out).toContain("helm_process_cpu_seconds ");
  });

  test("counters survive scrape (monotone across scrapes)", () => {
    recordResponse("GET", "/api/health", 200, 5);
    scrape();
    recordResponse("GET", "/api/health", 200, 5);
    const out = scrape();
    expect(out).toContain(
      'helm_http_requests_total{method="GET",route="/api/health",status="200"} 2'
    );
  });
});
