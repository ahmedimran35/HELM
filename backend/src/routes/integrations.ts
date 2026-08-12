// Integrations (docs §2.9) — outbound webhooks to Discord, Telegram,
// and Slack. Each integration can subscribe to one or more events and
// has a Test-send button that fires a synthetic event.
//
//   GET    /api/integrations              — list
//   POST   /api/integrations     (admin)  — create / upsert by service
//   DELETE /api/integrations/:id  (admin)  — remove
//   POST   /api/integrations/:id/test (admin) — fire a test event

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAdmin } from "../middleware/role.ts";
import { logAudit } from "../lib/audit.ts";
import { assertSafeBaseUrl } from "../providers/registry.ts";
import { safeError } from "../lib/safe-error.ts";

const router = new Hono();
router.use("*", requireAuth);

const ALLOWED_SERVICES = new Set(["discord", "telegram", "slack"]);
const ALLOWED_EVENTS = new Set([
  "access_requested",
  "access_decided",
  "budget_alert",
  "panel_activity",
]);

router.get("/", async (c) => {
  const rows = await sql<{
    id: string;
    service: string;
    webhook_url: string;
    events: string[];
    connected: boolean;
    created_at: Date;
  }[]>`
    SELECT id, service, webhook_url, events, connected, created_at
    FROM integrations ORDER BY created_at ASC
  `;
  return c.json(
    rows.map((r) => ({
      ...r,
      // mask the webhook URL — keep host, hide path tail
      webhook_url_masked: maskUrl(r.webhook_url),
    })),
  );
});

router.post("/", requireAdmin, async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    service?: string;
    webhook_url?: string;
    events?: string[];
    connected?: boolean;
  };
  const service = body.service ?? "";
  if (!ALLOWED_SERVICES.has(service)) {
    return c.json({ error: "invalid service" }, 400);
  }
  const url = (body.webhook_url ?? "").trim();
  if (!/^https?:\/\//.test(url)) {
    return c.json({ error: "webhook_url must be http(s)" }, 400);
  }
  // SSRF guard — admin-tampered or compromised admins can still probe
  // private IPs through the "Test" button. Resolve DNS, reject
  // loopback/private/metadata.
  try {
    await assertSafeBaseUrl(url, { allowAnyPort: true });
  } catch (err) {
    return safeError(c, err, { status: 400, code: "integrations_invalid" });
  }
  const events = (body.events ?? []).filter((e): e is string =>
    typeof e === "string" && ALLOWED_EVENTS.has(e),
  );
  try {
    new URL(url);
  } catch {
    return c.json({ error: "invalid webhook_url" }, 400);
  }
  const rows = await sql<{ id: string }[]>`
    INSERT INTO integrations (service, webhook_url, events, connected)
    VALUES (${service}, ${url}, ${events}, ${body.connected ?? true})
    ON CONFLICT (service) DO UPDATE
      SET webhook_url = EXCLUDED.webhook_url,
          events = EXCLUDED.events,
          connected = EXCLUDED.connected
    RETURNING id
  `;
  await logAudit({
    userId: c.get("user").id,
    target: rows[0]!.id,
    action: "integration_upserted",
    metadata: { service, event_count: events.length },
  });
  return c.json({ id: rows[0]!.id });
});

router.delete("/:id", requireAdmin, async (c) => {
  const id = c.req.param("id");
  await sql`DELETE FROM integrations WHERE id = ${id}::uuid`;
  await logAudit({
    userId: c.get("user").id,
    target: id,
    action: "integration_deleted",
  });
  return c.json({ ok: true });
});

router.post("/:id/test", requireAdmin, async (c) => {
  const id = c.req.param("id");
  const rows = await sql<{
    service: string;
    webhook_url: string;
  }[]>`
    SELECT service, webhook_url FROM integrations WHERE id = ${id}::uuid LIMIT 1
  `;
  const integ = rows[0];
  if (!integ) return c.json({ error: "not_found" }, 404);
  let result: "delivered" | "failed";
  let error: string | undefined;
  try {
    // SSRF guard — the URL was validated at insert-time but the operator
    // can re-validate here in case the block-list has tightened since.
    await assertSafeBaseUrl(integ.webhook_url, { allowAnyPort: true });
    const payload = formatTestPayload(integ.service);
    const res = await fetch(integ.webhook_url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
      redirect: "manual",
    });
    if (res.ok) result = "delivered";
    else {
      result = "failed";
      error = `${res.status}`;
    }
  } catch (err) {
    result = "failed";
    error = (err as Error).message;
  }
  await logAudit({
    userId: c.get("user").id,
    target: id,
    action: "integration_test",
    metadata: { result, error: error ?? null },
  });
  return c.json({ result, error });
});

function maskUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}/••••`;
  } catch {
    return "••••";
  }
}

function formatTestPayload(service: string): unknown {
  if (service === "slack") {
    return { text: "HELM test event — your integration is connected." };
  }
  if (service === "discord") {
    return { content: "HELM test event — your integration is connected." };
  }
  // telegram + anything else — generic JSON
  return { text: "HELM test event — your integration is connected." };
}

export default router;