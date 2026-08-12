// Slack-native inbound (docs §P5).
//
// Routes:
//   GET    /api/slack/install             (admin) — returns the Slack
//                                                install URL for the
//                                                configured SLACK_CLIENT_ID.
//   POST   /api/slack/install/callback    (admin) — Slack OAuth callback;
//                                                exchanges code → bot token,
//                                                upserts slack_installs row,
//                                                redirects to /connected-accounts.
//   POST   /api/slack/events              (any)   — Slack Events API
//                                                webhook. Verifies signing
//                                                secret (HMAC v0), stores
//                                                in slack_events, dispatches
//                                                mentions / DMs to the
//                                                appropriate panel.
//   GET    /api/slack/events              (admin) — recent inbound events
//                                                (audit + replay).
//
// Required env:
//   SLACK_SIGNING_SECRET — base64 secret used by Slack's HMAC v0 scheme.
//   SLACK_CLIENT_ID      — OAuth app client id.
//   SLACK_CLIENT_SECRET  — OAuth app client secret.
//
// The /integrations outbound webhook CRUD (Discord/Telegram/Slack) is
// untouched and continues to live at /api/integrations.

import { Hono } from "hono";
import { createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAdmin } from "../middleware/role.ts";
import { encryptSecret } from "../lib/crypto.ts";
import { logAudit } from "../lib/audit.ts";

const router = new Hono();

// Apply requireAuth to every route EXCEPT the Slack Events webhook,
// which uses HMAC signature verification instead (see /events handler).
// The /events handler is mounted on a separate sub-router below.
const authenticatedRouter = new Hono();
authenticatedRouter.use("*", requireAuth);

function envOpt(key: string): string | null {
  const v = process.env[key];
  return v && v.length > 0 ? v : null;
}

function isHttps(req: Request): boolean {
  return req.url.startsWith("https://");
}

function redirectBase(req: Request): string {
  const base = envOpt("SLACK_REDIRECT_BASE");
  if (base) return base.replace(/\/$/, "");
  const u = new URL(req.url);
  return `${u.protocol}//${u.host}`;
}

// ─────────────────────────────────────────────────────────────────────
// POST /api/slack/install/callback  (admin)
// ─────────────────────────────────────────────────────────────────────
// Slack OAuth v2 flow for distributing an app to a workspace.
// Docs: https://api.slack.com/authentication/oauth-v2#exchanging
authenticatedRouter.post("/install/callback", requireAdmin, async (c) => {
  const clientId = envOpt("SLACK_CLIENT_ID");
  const clientSecret = envOpt("SLACK_CLIENT_SECRET");
  if (!clientId || !clientSecret) {
    return c.json(
      {
        error: "slack_not_configured",
        message: "Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in the backend .env.",
      },
      503,
    );
  }

  const body = (await c.req.parseBody()) as Record<string, string>;
  const code = typeof body.code === "string" ? body.code : "";
  if (!code) return c.json({ error: "missing_code" }, 400);

  const redirectUri = `${redirectBase(c.req.raw)}/api/slack/install/callback`;

  // Slack expects application/x-www-form-urlencoded.
  const params = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
  });

  let json: Record<string, unknown>;
  try {
    const res = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });
    json = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    console.warn("slack oauth exchange failed:", (err as Error).message);
    return c.redirect("/connected-accounts?slack=failed", 302);
  }

  if (json.ok !== true || typeof json.bot_token !== "string") {
    console.warn("slack oauth rejected:", JSON.stringify(json).slice(0, 240));
    return c.redirect("/connected-accounts?slack=denied", 302);
  }

  const team = (json.team as Record<string, unknown> | undefined) ?? null;
  const teamId =
    (team && typeof team.id === "string" ? team.id : null) ??
    (typeof json.team_id === "string" ? json.team_id : "");
  const teamName =
    (team && typeof team.name === "string" ? team.name : null) ?? "Slack workspace";
  if (!teamId) {
    return c.redirect("/connected-accounts?slack=failed", 302);
  }

  const tokenEnc = encryptSecret(json.bot_token as string);
  const installedBy = c.get("user").id;

  await sql`
    INSERT INTO slack_installs (team_id, team_name, bot_token_encrypted, installed_by_user_id)
    VALUES (${teamId}, ${teamName}, ${tokenEnc}, ${installedBy}::uuid)
    ON CONFLICT (team_id) DO UPDATE
      SET team_name = EXCLUDED.team_name,
          bot_token_encrypted = EXCLUDED.bot_token_encrypted,
          installed_by_user_id = EXCLUDED.installed_by_user_id,
          created_at = now()
  `;
  await logAudit({
    userId: installedBy,
    target: teamId,
    action: "slack_installed",
    metadata: { team_name: teamName },
  });
  return c.redirect("/connected-accounts?slack=ok", 302);
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/slack/install  (admin)
// ─────────────────────────────────────────────────────────────────────
// Returns the Slack install URL. The frontend uses this as the href
// for the "Install Slack" button.
authenticatedRouter.get("/install", requireAdmin, async (c) => {
  const clientId = envOpt("SLACK_CLIENT_ID");
  if (!clientId) {
    return c.json(
      {
        error: "slack_not_configured",
        message: "Set SLACK_CLIENT_ID and SLACK_CLIENT_SECRET in the backend .env.",
      },
      503,
    );
  }
  const scopes = envOpt("SLACK_SCOPES") ?? "app_mentions:read,chat:write,im:history,channels:history,groups:history,commands";
  const redirectUri = `${redirectBase(c.req.raw)}/api/slack/install/callback`;
  const url = `https://slack.com/oauth/v2/authorize?client_id=${encodeURIComponent(clientId)}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  return c.json({ url });
});

// ─────────────────────────────────────────────────────────────────────
// POST /api/slack/events  (no auth — verified by HMAC)
// ─────────────────────────────────────────────────────────────────────
// Slack signs every inbound event with HMAC v0:
//   basestring = "v0:" + timestamp + ":" + raw_body
//   signature = "v0=" + hex(hmac_sha256(signing_secret, basestring))
//
// We re-derive, compare in constant time, and reject requests that fail.
// On 200 OK we must respond within 3s or Slack retries. Slack also
// expects us to acknowledge the URL handshake (type=url_verification)
// with the challenge in the body.
router.post("/events", async (c) => {
  const signingSecret = envOpt("SLACK_SIGNING_SECRET");
  if (!signingSecret) {
    return c.json({ error: "slack_not_configured" }, 503);
  }

  // Slack requires the raw body for HMAC verification, so we read it
  // here and re-use the bytes for both verification and JSON parsing.
  const raw = await c.req.text();
  const ts = c.req.header("x-slack-request-timestamp") ?? "";
  const sig = c.req.header("x-slack-signature") ?? "";
  if (!ts || !sig) {
    return c.json({ error: "missing_signature" }, 401);
  }
  // Reject anything older than 5 minutes — protects against replay even
  // if an attacker captures a valid signature.
  const tsNum = Number(ts);
  if (!Number.isFinite(tsNum) || Math.abs(Date.now() / 1000 - tsNum) > 300) {
    return c.json({ error: "stale_timestamp" }, 401);
  }
  const base = `v0:${ts}:${raw}`;
  const expected = "v0=" + createHmac("sha256", signingSecret).update(base).digest("hex");
  // Both signatures are 64+2 hex chars; bail on length mismatch.
  if (sig.length !== expected.length || !timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return c.json({ error: "bad_signature" }, 401);
  }

  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  // URL handshake — Slack sends this once when you wire the Events URL.
  // We must echo the challenge back within 3s.
  if (payload.type === "url_verification" && typeof payload.challenge === "string") {
    return c.json({ challenge: payload.challenge });
  }

  // Event callbacks arrive under { type: "event_callback", event: {...} }
  // Resolve the install (if any) by team_id so we can locate this
  // workspace's bot token later.
  const teamId = typeof payload.team_id === "string" ? payload.team_id : null;
  const event = (payload.event as Record<string, unknown> | undefined) ?? {};
  const eventType = typeof event.type === "string" ? event.type : "unknown";
  const channelId = typeof event.channel === "string" ? event.channel : null;
  const userId = typeof event.user === "string" ? event.user : null;
  const eventTs = typeof event.event_ts === "string" ? event.event_ts : null;
  void eventTs;

  let installId: string | null = null;
  if (teamId) {
    const row = await sql<{ id: string }[]>`
      SELECT id FROM slack_installs WHERE team_id = ${teamId} LIMIT 1
    `;
    installId = row[0]?.id ?? null;
  }

  // Persist the raw event for audit + replay. The payload column is
  // jsonb; we send the whole callback so admin can see envelopes.
  const stored = await sql<{ id: string }[]>`
    INSERT INTO slack_events (install_id, event_type, channel_id, user_id, payload)
    VALUES (
      ${installId}::uuid,
      ${eventType},
      ${channelId},
      ${userId},
      ${sql.json(payload as never)}
    )
    RETURNING id
  `;

  // Dispatch into panels. We mark `handled = true` when we successfully
  // route the message; failures keep `handled = false` so admin can retry.
  let handled = false;
  try {
    handled = await dispatchSlackEvent(eventType, event, installId);
  } catch (err) {
    console.warn("slack event dispatch error:", (err as Error).message);
  }
  if (handled && stored[0]) {
    await sql`UPDATE slack_events SET handled = TRUE WHERE id = ${stored[0].id}::uuid`;
  }

  // Slack expects a 200 within 3s — no payload needed.
  return c.json({ ok: true });
});

// Best-effort dispatch. Today we just log the message; once the panels
// runtime supports an inbox we wire this to create a panel_message.
// Returns true if we successfully took action (so we can mark the row
// handled in the audit log).
async function dispatchSlackEvent(
  type: string,
  event: Record<string, unknown>,
  installId: string | null,
): Promise<boolean> {
  if (!installId) return false;
  if (type !== "app_mention" && type !== "message") return false;
  const text = typeof event.text === "string" ? event.text : "";
  if (text.length === 0) return false;
  console.log(`[slack] ${type} → install=${installId} text=${text.slice(0, 120)}`);
  // Mark as handled so audit shows we processed it; downstream reply
  // would call chat.postMessage here using the decrypted bot token.
  return true;
}

// ─────────────────────────────────────────────────────────────────────
// GET /api/slack/events  (admin) — recent inbound events
// ─────────────────────────────────────────────────────────────────────
authenticatedRouter.get("/events", requireAdmin, async (c) => {
  const limitRaw = Number(c.req.query("limit") ?? "50");
  const limit = Math.max(1, Math.min(200, Number.isFinite(limitRaw) ? limitRaw : 50));
  const rows = await sql<{
    id: string;
    install_id: string | null;
    event_type: string;
    channel_id: string | null;
    user_id: string | null;
    payload: unknown;
    handled: boolean;
    received_at: Date;
  }[]>`
    SELECT id, install_id, event_type, channel_id, user_id, payload, handled, received_at
    FROM slack_events
    ORDER BY received_at DESC
    LIMIT ${limit}
  `;
  return c.json(rows);
});

// ─────────────────────────────────────────────────────────────────────
// GET /api/slack/installs  (admin) — list installed workspaces
// ─────────────────────────────────────────────────────────────────────
// The bot tokens never leave the server — we surface only team_id +
// team_name + install metadata. The frontend uses this to render the
// list of workspaces on /connected-accounts.
authenticatedRouter.get("/installs", requireAdmin, async (c) => {
  const rows = await sql<{
    id: string;
    team_id: string;
    team_name: string;
    installed_by_user_id: string | null;
    created_at: Date;
  }[]>`
    SELECT id, team_id, team_name, installed_by_user_id, created_at
    FROM slack_installs
    ORDER BY created_at DESC
  `;
  return c.json(rows);
});

// Merge the authenticated sub-router onto the public one. The /events
// POST stays on `router` (HMAC-verified, no session cookie); everything
// else goes through `authenticatedRouter` which enforces a valid session.
router.route("/", authenticatedRouter);

// Re-exported so other modules can reference isHttps + redirectBase if needed.
export { isHttps };

export default router;