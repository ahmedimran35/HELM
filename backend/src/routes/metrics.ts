// Prometheus scrape endpoint — GET /api/metrics.
//
// Admin-only: the request-rate labels (routes, error mix) are
// internal operational information; anonymous probers get 404 via the
// global not-found handler rather than a descriptive 403 (existence
// hiding, same policy as /api/status).
//
// Prometheus text exposition format, no dependencies. See
// lib/metrics.ts for the registry design notes.

import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.ts";
import { requireAdmin } from "../middleware/role.ts";
import { scrape } from "../lib/metrics.ts";

const router = new Hono();

router.use("*", requireAuth);
router.use("*", requireAdmin);

router.get("/", (c) => {
  const body = scrape();
  return c.body(body, 200, {
    "Content-Type": "text/plain; version=0.0.4; charset=utf-8",
    "Cache-Control": "no-store",
  });
});

export default router;
