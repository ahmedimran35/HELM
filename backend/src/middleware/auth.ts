// Auth middleware. Resolves the session cookie to a user record on every
// request — no in-memory caching here. Per docs §2.1a,5: "the change takes
// effect on their next request (server checks the current role from the
// database, not a value baked into a long-lived token)".

import type { MiddlewareHandler } from "hono";
import { config } from "../config.ts";
import { findSession, loadUserForSession, touchSession } from "../auth/session.ts";
import type { UserRow } from "../auth/session.ts";

declare module "hono" {
  interface ContextVariableMap {
    user: UserRow;
    sessionId: string;
  }
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
  await touchSession(sessionId, section);

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