// Centralised security headers for every API response.
//
// Defense-in-depth layered on top of the per-route CSRF/SameSite
// cookie/Origin defenses. Browsers honour:
//
//   - Strict-Transport-Security (HSTS): force https for 2 years,
//     preload-ready. Without this, a downgrade or sslstrip attack
//     on a coffee-shop / public Wi-Fi catches you.
//   - X-Frame-Options: DENY → no UI redress. (CSP frame-ancestors
//     'none' would be the modern alternative; we set both for
//     browsers that ignore CSP frame-ancestors.)
//   - X-Content-Type-Options: nosniff → no MIME sniffing.
//   - Referrer-Policy: same-origin → our /api/* URLs aren't leaked
//     to third-party trackers in fetch() redirects.
//   - Permissions-Policy: disable camera, microphone, geolocation,
//     payment, USB, etc. — this API shouldn't need any of them; if a
//     future feature does, it has to opt in explicitly.
//   - Content-Security-Policy: default-src 'none'; we don't serve
//     HTML from /api/*. The BackendForFrontend (the SPA) sets its
//     own CSP via a meta tag.
//   - Cross-Origin-Resource-Policy: same-origin → the API can't be
//     embedded cross-origin by an attacker's iframe.
//
// We deliberately omit:
//   - `Access-Control-Allow-Origin: *` (CORS is configured separately
//     on the CORS preflight path; we don't want to leak credentials
//     to non-trusted origins).

import type { MiddlewareHandler } from "hono";

const SECURITY_HEADERS: Record<string, string> = {
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "same-origin",
  "Permissions-Policy":
    "accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
  "Cross-Origin-Opener-Policy": "same-origin",
};

export const securityHeaders: MiddlewareHandler = async (_c, next) => {
  await next();
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    _c.header(name, value);
  }
};

/**
 * Reject state-changing requests whose Origin doesn't match the SPA
 * origin. This is a belt-and-braces CSRF defense on top of
 * SameSite=Strict cookies: even if a future contributor forgets to
 * mark a route POST-only, the browser is still blocked from making
 * a state-changing cross-origin call from JS unless the SPA's own
 * origin matches the Origin header.
 */
export const originGuard = (webOrigin: string): MiddlewareHandler => {
  return async (c, next) => {
    const method = c.req.method.toUpperCase();
    if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
    const origin = c.req.header("origin");
    if (!origin) {
      // No Origin header on a non-GET is suspicious — block. Browsers
      // always send Origin on cross-origin POSTs and on same-origin
      // POSTs from JS (the SPA). The exception is curl / server-to-
      // server; if you need that, sign your requests.
      return c.json({ error: "origin_required" }, 403);
    }
    const expected = webOrigin.replace(/\/$/, "");
    if (origin !== expected) {
      return c.json({ error: "origin_mismatch" }, 403);
    }
    return next();
  };
};
