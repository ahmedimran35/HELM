// Request-metrics middleware — feeds the Prometheus registry in
// lib/metrics.ts. Mounted early (before route handlers) so every
// request is timed, including 404s and errors.
//
// The middleware does no allocation on the hot path beyond the label
// string; the scrape endpoint (/api/metrics) does the formatting work
// once per scrape.

import type { MiddlewareHandler } from "hono";
import { recordResponse, metricsRegistry } from "../lib/metrics.ts";

export const requestMetrics: MiddlewareHandler = async (c, next) => {
  metricsRegistry.inFlight++;
  const started = performance.now();
  try {
    await next();
  } finally {
    metricsRegistry.inFlight--;
    // c.req.path is the paramless route shape in Hono (e.g.
    // /api/panels/:id/messages) — exactly what we want for labels.
    recordResponse(c.req.method, c.req.path, c.res.status, performance.now() - started);
  }
};
