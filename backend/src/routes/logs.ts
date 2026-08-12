// Logs (admin-only, password-gated, docs §2.7).
//
//   POST /api/logs/step-up           — verify admin password before showing logs
//   GET  /api/logs/activity          — every audit entry (paginated, filterable)
//   GET  /api/logs/sessions          — login history per session
//
// Step-up is enforced via a short-lived signed cookie set by step-up. The
// cookie is bound to the user's session and expires in 5 minutes — after
// which the admin must re-enter the password to view logs again.

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAdmin } from "../middleware/role.ts";
import { verifyPassword } from "../auth/password.ts";
import { config } from "../config.ts";

const router = new Hono();
router.use("*", requireAuth);

const STEPUP_COOKIE = "helm_logstep";
const STEPUP_TTL = 5 * 60; // 5 minutes

function parseStepUp(header: string | null | undefined): string | null {
  if (!header) return null;
  const parts = header.split(";").map((p) => p.trim());
  for (const part of parts) {
    if (part.startsWith(`${STEPUP_COOKIE}=`)) {
      return decodeURIComponent(part.slice(STEPUP_COOKIE.length + 1));
    }
  }
  return null;
}

function requireStepUp(): import("hono").MiddlewareHandler {
  return async (c, next) => {
    const token = parseStepUp(c.req.header("cookie"));
    if (!token) return c.json({ error: "step_up_required" }, 401);
    try {
      const decoded = Buffer.from(token, "base64url").toString("utf8");
      const [sid, expires] = decoded.split("|");
      if (sid !== c.get("sessionId")) {
        return c.json({ error: "step_up_required" }, 401);
      }
      if (!expires || Number(expires) < Math.floor(Date.now() / 1000)) {
        return c.json({ error: "step_up_expired" }, 401);
      }
    } catch {
      return c.json({ error: "step_up_required" }, 401);
    }
    return next();
  };
}

router.post("/step-up", requireAdmin, async (c) => {
  const user = c.get("user");
  const body = (await c.req.json().catch(() => ({}))) as { password?: string };
  const pw = typeof body.password === "string" ? body.password : "";
  if (!pw) return c.json({ error: "password required" }, 400);
  const rows = await sql<{ password_hash: string }[]>`
    SELECT password_hash FROM users WHERE id = ${user.id}::uuid LIMIT 1
  `;
  if (!rows[0]) return c.json({ error: "user not found" }, 404);
  const ok = await verifyPassword(pw, rows[0].password_hash);
  if (!ok) return c.json({ error: "invalid" }, 401);
  const expires = Math.floor(Date.now() / 1000) + STEPUP_TTL;
  const sid = c.get("sessionId");
  const token = Buffer.from(`${sid}|${expires}`).toString("base64url");
  const isHttps = c.req.url.startsWith("https://");
  const cookieAttrs = [
    `${STEPUP_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${STEPUP_TTL}`,
  ];
  if (isHttps) cookieAttrs.push("Secure");
  c.header("Set-Cookie", cookieAttrs.join("; "), { append: true });
  return c.json({ ok: true, expires_in: STEPUP_TTL });
});

router.get("/activity", requireAdmin, requireStepUp(), async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 25), 1), 500);
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
  const actionFilter = c.req.query("action");
  const rows = await sql<{
    id: string;
    user_id: string | null;
    user_name: string | null;
    target: string;
    action: string;
    tokens: number;
    metadata: unknown;
    created_at: Date;
  }[]>`
    SELECT a.id, a.user_id, u.name AS user_name, a.target, a.action, a.tokens,
           a.metadata, a.created_at
    FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
    ${actionFilter ? sql`WHERE a.action LIKE ${`%${actionFilter}%`}` : sql``}
    ORDER BY a.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const totalRows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM audit_log
    ${actionFilter ? sql`WHERE action LIKE ${`%${actionFilter}%`}` : sql``}
  `;
  return c.json({
    rows,
    total: totalRows[0]?.n ?? 0,
    limit,
    offset,
  });
});

router.get("/sessions", requireAdmin, requireStepUp(), async (c) => {
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 25), 1), 200);
  const offset = Math.max(Number(c.req.query("offset") ?? 0), 0);
  const rows = await sql<{
    id: string;
    user_id: string;
    user_name: string;
    user_username: string;
    login_at: Date;
    logout_at: Date | null;
    last_seen_at: Date;
    expires_at: Date;
    ip: string | null;
    user_agent: string | null;
    sections_visited: string[];
  }[]>`
    SELECT s.id, s.user_id, u.name AS user_name, u.username AS user_username,
           s.login_at, s.logout_at, s.last_seen_at, s.expires_at, s.ip,
           s.user_agent, s.sections_visited
    FROM sessions s JOIN users u ON u.id = s.user_id
    ORDER BY s.login_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;
  const totalRows = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM sessions
  `;
  return c.json({
    rows,
    total: totalRows[0]?.n ?? 0,
    limit,
    offset,
  });
});

export default router;