// Auth middleware. Resolves the session cookie to a user record on every
// request — no in-memory caching here. Per docs §2.1a,5: "the change takes
// effect on their next request (server checks the current role from the
// database, not a value baked into a long-lived token)".

import type { MiddlewareHandler } from "hono";
import { config } from "../config.ts";
import { findSession, loadUserForSession, revokeSession, touchSession } from "../auth/session.ts";
import { logAudit } from "../lib/audit.ts";
import type { UserRow } from "../auth/session.ts";

declare module "hono" {
  interface ContextVariableMap {
    user: UserRow;
    sessionId: string;
  }
}

// Feature flag: IP-bind hijack detection. When `HELM_SESSION_IP_BIND=1`,
// the middleware compares req.ip to the session's `last_seen_ip`; a
// mismatch is treated as a likely cookie theft and the session is
// revoked. Default OFF so dev workflows that hop between WiFi, VPN,
// and 4G (where the IP changes legitimately every few minutes) don't
// get constant re-logins. Turn it on for any tenant that needs
// step-up auth on cookie replay.
const IP_BIND_ENABLED = process.env.HELM_SESSION_IP_BIND === "1";

export const requireAuth: MiddlewareHandler = async (c, next) => {
  const cookie = c.req.header("cookie") ?? "";
  const sessionId = parseSessionCookie(cookie);
  if (!sessionId) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  const session = await findSession(sessionId);
  if (!session) {
    return c.json({ error: "session_expired" }, 401);
  }
  // IP-bind hijack check. Compare req.ip against the session's last
  // seen IP. last_seen_ip may be NULL for sessions that pre-date the
  // 0013 migration — treat NULL as "unknown" and set it on this
  // request without flagging a mismatch.
  if (IP_BIND_ENABLED) {
    const reqIp = (c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
      ?? c.req.header("x-real-ip")
      ?? null);
    const lastIp = session.last_seen_ip ?? session.ip ?? null;
    if (reqIp && lastIp && reqIp !== lastIp) {
      // Cookie replay from a different network. Revoke the session,
      // log a security_event, and force a re-login.
      await revokeSession(sessionId);
      await logAudit({
        userId: session.user_id,
        target: sessionId,
        action: "session_hijack_suspect",
        metadata: {
          last_seen_ip: lastIp,
          current_ip: reqIp,
          path: c.req.path,
        },
      });
      return c.json({ error: "session_ip_changed", reason: "ip_mismatch" }, 401);
    }
  }
  const user = await loadUserForSession(sessionId);
  if (!user) {
    return c.json({ error: "unauthenticated" }, 401);
  }
  if (!user.is_active) {
    return c.json({ error: "account_disabled" }, 403);
  }
  c.set("user", user);
  c.set("sessionId", sessionId);

  // Record this section visit for the §2.7 Sessions tab.
  const section = c.req.path.replace(/^\/api\//, "").split("/")[0] ?? "root";
  const reqIpForTouch = (c.req.header("x-forwarded-for")?.split(",")[0]?.trim()
    ?? c.req.header("x-real-ip")
    ?? null);
  await touchSession(sessionId, section, { ip: reqIpForTouch });

  return next();
};

export function parseSessionCookie(header: string): string | null {
  if (!header) return null;
  const parts = header.split(";").map((p) => p.trim());
  for (const part of parts) {
    if (part.startsWith(`${config.session.cookieName}=`)) {
      return decodeURIComponent(part.slice(config.session.cookieName.length + 1));
    }
  }
  return null;
}

export function serializeSessionCookie(sessionId: string, opts: { maxAge: number; secure: boolean }): string {
  // `__Host-` prefix + the absence of `Domain` + `Path=/` + `Secure`
  // is the documented way to bind a cookie to a specific host + path
  // and stop subdomain attackers from setting/clobbering it. SameSite
  // is Strict (was Lax): the SPA is a same-origin API — there is no
  // legitimate cross-site flow that needs the cookie. Strict blocks
  // top-level-GET CSRF and any third-party iframe embed.
  const prefix = opts.secure ? "__Host-" : "";
  const attrs = [
    `${prefix}${config.session.cookieName}=${encodeURIComponent(sessionId)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${opts.maxAge}`,
  ];
  if (opts.secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearSessionCookie(secure: boolean): string {
  const prefix = secure ? "__Host-" : "";
  const attrs = [
    `${prefix}${config.session.cookieName}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    "Max-Age=0",
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}