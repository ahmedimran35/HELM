// Browser-automation route (Tier 3 — Voice + Multimodal).
//
//   POST /api/browser/exec        — run an action graph against a URL
//   GET  /api/browser/screenshots/:scope/:file — serve a saved PNG
//   GET  /api/browser/status      — is Playwright installed?
//
// Action graph format: see lib/browser.ts. The route scopes the
// screenshot subdir by `user_id` so users only see their own shots.

import { Hono } from "hono";
import { requireAuth } from "../middleware/auth.ts";
import { logAudit } from "../lib/audit.ts";
import {
  isBrowserAvailable,
  readScreenshot,
  runBrowser,
  type BrowserAction,
  type BrowserExecOutput,
} from "../lib/browser.ts";
import { validate, validationErrorResponse } from "../lib/validate.ts";
import { safeError } from "../lib/safe-error.ts";

const router = new Hono();
router.use("*", requireAuth);

router.get("/status", async (c) => {
  const ok = await isBrowserAvailable();
  return c.json({ available: ok });
});

router.post("/exec", async (c) => {
  const user = c.get("user");
  let body: {
    url?: string;
    actions?: BrowserAction[];
    panel_id?: string;
  };
  try {
    body = validate(await c.req.json().catch(() => ({})), {
      url: { type: "string", minLength: 1, maxLength: 4096, trim: true },
      actions: { type: "array", of: { type: "object", fields: {} }, maxLength: 32 },
      panel_id: { type: "uuid" },
    });
  } catch (err) {
    const r = validationErrorResponse(err);
    return c.json(r.body, r.status);
  }
  if (!body.url || !/^https?:\/\//i.test(body.url)) {
    return c.json({ error: "url must be an http(s) URL" }, 400);
  }
  // Block requests to private IP ranges — same SSRF guardrails as the
  // rest of the backend (assertSafeBaseUrl covers most of this).
  try {
    const { assertSafeBaseUrl } = await import("../providers/registry.ts");
    await assertSafeBaseUrl(body.url, { allowLocal: false, allowAnyPort: false });
  } catch (err) {
    return safeError(c, err, { status: 400, code: "browser_invalid" });
  }
  const actions = (body.actions ?? []) as BrowserAction[];
  const scope = body.panel_id
    ? `panel-${body.panel_id}`
    : `user-${user.id}`;
  const result: BrowserExecOutput = await runBrowser({
    url: body.url,
    actions,
    scope,
  });
  await logAudit({
    userId: user.id,
    target: body.url,
    action: "browser_exec",
    metadata: {
      duration_ms: result.duration_ms,
      actions: actions.length,
      stub: result.stub ? "true" : "false",
      reason: result.reason ?? null,
    },
  });
  return c.json(result);
});

router.get("/screenshots/:scope/:file", async (c) => {
  const user = c.get("user");
  const scope = c.req.param("scope");
  const file = c.req.param("file");
  // Only allow users to fetch their own scoped shots.
  if (
    scope !== `user-${user.id}` &&
    !(user.role === "admin" && scope.startsWith("panel-"))
  ) {
    return c.json({ error: "not_found" }, 404);
  }
  const bytes = await readScreenshot(scope, file);
  if (!bytes) return c.json({ error: "not_found" }, 404);
  // Copy into a plain ArrayBuffer so the Response constructor accepts
  // the bytes regardless of whether the Uint8Array was backed by a
  // SharedArrayBuffer.
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return new Response(ab, {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "private, max-age=60",
    },
  });
});

export default router;