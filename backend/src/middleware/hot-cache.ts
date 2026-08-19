// Cache-Control tuned for authenticated, mostly-static endpoints.
//
// Some endpoints are read on every page load but change rarely:
//
//   - `/api/me`                — re-read by the SPA on every route change
//                                to refresh the user pill. The user record
//                                changes only on name/role/password edits.
//   - `/api/models`            — re-read whenever the model selector opens.
//   - `/api/bootstrap-status`  — re-read on every app boot.
//
// These were hitting the DB on every request. We don't want to send a
// full response cache (no per-user customisation on /api/models, but
// /api/me is per-user and would cross-leak if shared). Instead we use
// the `Cache-Control: private, max-age=N` header so the browser holds
// the response and revalidates with ETag on the next request.
//
// This file is a thin wrapper that:
//   - Sets Cache-Control: private, max-age=N
//   - Opts in to weak ETag generation
//   - Adds a Vary: Authorization header so CDN/proxies don't mis-share
//
// Pair with `cachingEtag` from compress.ts.

import type { MiddlewareHandler } from "hono";

/** Private cache. Browser caches up to `maxAgeSec`, re-fetches on
 *  expiry or when the ETag changes. The `private` directive prevents
 *  shared caches (CDNs, intermediaries) from caching per-user data. */
export const hotCache = (maxAgeSec: number): MiddlewareHandler => {
  return async (c, next) => {
    await next();
    if (c.req.method === "GET" && c.res.status >= 200 && c.res.status < 300) {
      c.res.headers.set("Cache-Control", `private, max-age=${maxAgeSec}`);
      // Per-user responses must vary on the auth token so a CDN
      // doesn't serve another user's payload.
      c.res.headers.append("Vary", "Authorization");
    }
  };
};
