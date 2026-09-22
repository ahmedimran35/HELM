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

/**
 * Resolve the client IP from headers we are actually allowed to trust.
 *
 * `x-forwarded-for` is client-settable unless a reverse proxy rewrites it,
 * so it is only consulted when `HELM_TRUSTED_PROXY=1`. When we are NOT
 * behind a trusted proxy we fall back to headers a single trusted proxy
 * sets itself (`cf-connecting-ip`, `x-real-ip`) and otherwise return null.
 * Returns null rather than a placeholder so callers skip the comparison
 * instead of matching everything against "unknown".
 */
function trustedClientIp(c: {
  req: { header(name: string): string | undefined };
}): string | null {
  const trustProxy = process.env.HELM_TRUSTED_PROXY === "1";
  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      // Right-most hop is the one our proxy appended.
      const hops = xff.split(",").map((h) => h.trim()).filter(Boolean);
      if (hops.length > 0) return hops[hops.length - 1]!;
    }
    return null;
  }
  const cf = c.req.header("cf-connecting-ip");
  if (cf && cf.trim()) return cf.trim();
  const xri = c.req.header("x-real-ip");
  if (xri && xri.trim()) return xri.trim();
  return null;
}

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
    // Only trust X-Forwarded-For when we've been told there is a trusted
    // proxy in front of us (HELM_TRUSTED_PROXY=1). Otherwise XFF is
    // attacker-controlled and an attacker replaying a stolen cookie could
    // simply set it to the victim's IP to satisfy the check. Fall back to
    // the single-proxy headers (cf-connecting-ip / x-real-ip).
    const reqIp = trustedClientIp(c);
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
  const reqIpForTouch = trustedClientIp(c);
  await touchSession(sessionId, section, { ip: reqIpForTouch });

  return next();
};

export function parseSessionCookie(header: string): string | null {
  if (!header) return null;
  const cookieName = config.session.cookieName;
  const parts = header.split(";").map((p) => p.trim());
  for (const part of parts) {
    // The cookie may be set with the `__Host-` prefix (when Secure) or
    // without it (non-secure). Match either form — the previous parser
    // only matched `helm_sid=` and silently failed to parse the
    // `__Host-helm_sid=` name the serializer emits, which broke auth
    // entirely on direct-TLS deployments.
    if (part.startsWith(`${cookieName}=`)) {
      return decodeURIComponent(part.slice(cookieName.length + 1));
    }
    if (part.startsWith(`__Host-${cookieName}=`)) {
      return decodeURIComponent(part.slice(`__Host-${cookieName}`.length + 1));
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

/**
 * Whether the request actually reached the user over TLS.
 *
 * When `HELM_TRUSTED_PROXY=1` (the standard nginx/LB TLS-termination
 * topology) we trust the `X-Forwarded-Proto` header; otherwise we trust
 * only the immediate connection's scheme, because a client can spoof
 * `X-Forwarded-*`. This drives the `Secure` + `__Host-` cookie flags so
 * they are set correctly even when Bun sits behind a TLS-terminating
 * proxy (previously the cookie was never marked Secure in that topology,
 * and the `__Host-` prefix was never matched on parse).
 */
export function isSecureRequest(
  reqUrl: string,
  getHeader: (name: string) => string | undefined,
): boolean {
  const trustProxy = process.env.HELM_TRUSTED_PROXY === "1";
  if (trustProxy) {
    const proto = getHeader("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
    return proto === "https";
  }
  try {
    return new URL(reqUrl).protocol === "https:";
  } catch {
    return false;
  }
}