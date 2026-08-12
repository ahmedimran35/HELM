// Health + ping endpoints — used by the smoke test and by ops to verify
// the backend is reachable and the DB is reachable.
//
// Tier 5 adds /health/harnesses which reports per-harness status +
// latency. The endpoint serves the cached snapshot (TTL 60s) and
// accepts ?refresh=1 to force a fresh probe.

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { listHarnessHealth, refreshAllHarnesses } from "../lib/health-check.ts";

const router = new Hono();

router.get("/", (c) => c.json({ ok: true, ts: Date.now() }));

router.get("/db-ping", async (c) => {
  try {
    const rows = await sql<{ now: Date }[]>`SELECT now() AS now`;
    return c.json({ ok: true, db_time: rows[0]?.now ?? null });
  } catch (err) {
    return c.json({ ok: false, error: (err as Error).message }, 503);
  }
});

// Per-harness status + latency. Auth-required so we don't reveal
// internal harness counts to anonymous probers. Cached snapshots
// expire after 60s; ?refresh=1 forces a fresh probe.
router.get("/harnesses", requireAuth, async (c) => {
  const force = c.req.query("refresh") === "1";
  if (force) {
    await refreshAllHarnesses();
  }
  return c.json({ harnesses: listHarnessHealth() });
});

export default router;