// Harness discovery endpoints (P2).
//
//   GET /api/harnesses                  — list every harness with its status
//   GET /api/harnesses/:kind/models     — list models for one harness
//
// These power the UI: the chat page shows the active harness as a pill
// and (later) the @harness:<kind>/ model selector. The route never
// reveals API keys or upstream URLs — only kind, label, configured-ness,
// and a count of models.

import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.ts";
import { listHarnesses } from "../harness/router.ts";
import { isHarnessKind, type HarnessKind } from "../harness/types.ts";

const router = new Hono();
router.use("*", requireAuth);

router.get("/", async (c) => {
  const out: Array<{
    kind: HarnessKind;
    label: string;
    configured: boolean;
    reason?: string;
    model_count: number;
  }> = [];
  for (const h of listHarnesses()) {
    const [status, models] = await Promise.all([
      h.status(),
      h.listModels().catch(() => []),
    ]);
    out.push({
      kind: h.kind,
      label: h.label,
      configured: status.configured,
      reason: status.reason,
      model_count: models.length,
    });
  }
  return c.json(out);
});

router.get("/:kind/models", async (c) => {
  const kind = c.req.param("kind");
  if (!isHarnessKind(kind)) {
    return c.json({ error: "unknown_harness" }, 404);
  }
  const harness = listHarnesses().find((h) => h.kind === kind);
  if (!harness) return c.json({ error: "not_found" }, 404);
  const status = await harness.status();
  if (!status.configured) {
    return c.json({
      kind,
      configured: false,
      reason: status.reason ?? "not_configured",
      models: [],
    });
  }
  const models = await harness.listModels().catch(() => []);
  return c.json({ kind, configured: true, models });
});

export default router;
