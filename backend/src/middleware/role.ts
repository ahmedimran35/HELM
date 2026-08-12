// Role gating. Any handler that requires admin access calls this so a
// logged-in user hitting an admin-only endpoint gets 403 — never relies
// on the UI hiding the link (docs §2.1a,4).

import type { MiddlewareHandler } from "hono";

export const requireAdmin: MiddlewareHandler = async (c, next) => {
  const user = c.get("user");
  if (!user) return c.json({ error: "unauthenticated" }, 401);
  if (user.role !== "admin") return c.json({ error: "forbidden" }, 403);
  return next();
};