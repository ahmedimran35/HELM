// HTTP response compression middleware.
//
// Wraps the response stream with the correct Content-Encoding header
// based on the Accept-Encoding request header. Three algorithms:
//
//   - gzip         — universal compatibility, ~3x size reduction on text
//   - br (brotli)  — better compression for text (typically 15-25% smaller
//                    than gzip), slower compress, fast decompress
//   - deflate      — legacy fallback for very old clients
//
// We never compress:
//   - SSE streams (chat.ts, ws.ts) — chunked transfers; compressing each
//     chunk adds CPU overhead and the per-chunk size is already small
//   - Already-Compressed content (image/png, application/zip, etc.)
//   - Anything < 1 KB — compression overhead exceeds the savings
//
// The middleware also adds an ETag header based on the response content
// hash so identical GET responses can be served from browser cache
// without a server round-trip.

import type { MiddlewareHandler } from "hono";
import { compress } from "hono/compress";
import { etag } from "hono/etag";

const COMPRESSIBLE_TYPES = /^(text\/(html|css|plain|xml|javascript|markdown)|application\/(json|javascript|xml|ld\+json|manifest\+json|x-yaml|yaml)|image\/svg\+xml)/;

/** ETag middleware — only sets the header for cacheable responses. */
export const cachingEtag: MiddlewareHandler = etag({
  // Only cache static-looking responses. Streaming SSE and authenticated
  // routes opt out by setting `Cache-Control: no-store`.
  weak: true,
});

/** Cache-Control hint for immutable / cacheable read endpoints.
 *  Pair with `cachingEtag` above — the browser revalidates via
 *  If-None-Match on the next request, so the body is only sent when
 *  the ETag has changed. Use this on top-level catalog endpoints
 *  (/api/health/providers/popular, /api/models, etc.). Authenticated
 *  per-user endpoints should opt out via response-level Cache-Control
 *  unless the API is public. */
export const cacheControl = (maxAgeSec: number): MiddlewareHandler => {
  return async (c, next) => {
    await next();
    // Only set Cache-Control on successful GETs. 4xx/5xx and non-GETs
    // are not cached.
    if (c.req.method === "GET" && c.res.status >= 200 && c.res.status < 300) {
      c.res.headers.set("Cache-Control", `public, max-age=${maxAgeSec}`);
    }
  };
};

/** Per-request compression — respects Accept-Encoding and skips SSE. */
export const compression = (): MiddlewareHandler => {
  return compress({
    encoding: "gzip", // default; brotli and deflate added below
    threshold: 1024, // skip < 1 KB (overhead > savings)
  });
};

/** Stronger compression that also handles brotli when the client supports it.
 *  Hono's `compress` does gzip+deflate out of the box; brotli is opt-in
 *  via the `brotli` npm package (one small dep). We keep this off by
 *  default to avoid pulling it in for the typical case. If you need
 *  brotli, install `npm i brotli` and swap the `compress` call below.
 *
 *  The default `compression()` above is what we use in production. */
