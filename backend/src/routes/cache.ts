// Cache admin routes (Tier 5).
//
//   POST /api/cache/invalidate — admin-only, clears every row in
//     response_cache and returns the count.

import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.ts";
import { requireAdmin } from "../middleware/role.ts";
import { invalidateAll, cacheHitStats } from "../lib/response-cache.ts";
import { logAudit } from "../lib/audit.ts";

const router = new Hono();
router.use("*", requireAuth);

router.post("/invalidate", requireAdmin, async (c) => {
  const user = c.get("user");
  const removed = await invalidateAll();
  await logAudit({
    userId: user.id,
    target: "response_cache",
    action: "cache_invalidated",
    metadata: { removed },
  });
  return c.json({ ok: true, removed });
});

router.get("/stats", async (c) => {
  const user = c.get("user");
  const stats = await cacheHitStats(user.id);
  return c.json(stats);
});

export default router;