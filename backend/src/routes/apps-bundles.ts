// Static bundle server for installed apps. Mounted at /apps (not
// under /api), so the URL an end-user sees is `/apps/:slug/...`.
//
// This endpoint is intentionally unauthenticated — the app bundle is
// served publicly. Per-app authorization happens at the app-data API
// (/api/app-data/:install_id/:key), which requires a valid install.
//
// Path semantics:
//   /apps/_sdk.js                  → the SDK injected into every app
//   /apps/:slug                    → apps-bundles/:slug/index.html
//   /apps/:slug/foo/bar.css        → apps-bundles/:slug/foo/bar.css
//   /apps/:slug/foo                → apps-bundles/:slug/foo (file if it
//                                    exists, otherwise fall back to
//                                    apps-bundles/:slug/index.html — SPA
//                                    fallback so client-side routers work)
//
// SDK injection: every HTML file served by this route has a small
// <script src="/apps/_sdk.js"></script> tag inserted just before </head>.
// The SDK exposes `window.helmApp` so the app can call HELM APIs and
// read the current user + install without knowing how the host is
// wired together.
//
// Security: we resolve the requested path and reject any traversal
// (anything resolving outside apps-bundles/:slug/). Files are streamed
// via Bun.file(), so the runtime handles ETags, range, and MIME.

import { Hono } from "hono";
import { join, normalize, relative, resolve } from "node:path";

const SLUG_RX = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Resolve from the project root (one level above /backend/src/routes).
// import.meta.dir walks up from this file: backend/src/routes → backend/src
// → backend → project root.
const ROOT = resolve(import.meta.dir, "..", "..", "..");
const BUNDLES_ROOT = join(ROOT, "apps-bundles");

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm":  "text/html; charset=utf-8",
  ".js":   "application/javascript; charset=utf-8",
  ".mjs":  "application/javascript; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
  ".ico":  "image/x-icon",
  ".woff": "font/woff",
  ".woff2":"font/woff2",
  ".ttf":  "font/ttf",
  ".txt":  "text/plain; charset=utf-8",
  ".map":  "application/json; charset=utf-8",
};

// The SDK is injected into every HTML response. We use a separate file
// so the browser can cache it and so the bundle server can serve it as
// a normal static file on /apps/_sdk.js. The `?v=` query string busts
// browser caches whenever the SDK is updated — the file itself is
// served with `max-age=300`, but the query string forces a fresh fetch.
const SDK_VERSION = "7";
const SDK_SCRIPT_TAG = `<script src="/apps/_sdk.js?v=${SDK_VERSION}"></script>`;

// Inject the SDK <script> tag just before </head>. If the document
// doesn't have a <head> (rare, but seen in some hand-rolled bundles),
// inject it before <body> so the SDK is still available before the
// app's own scripts run.
function transformAppHtml(html: string): string {
  if (html.includes("/apps/_sdk.js")) return html; // already injected
  const headClose = html.toLowerCase().lastIndexOf("</head>");
  if (headClose > -1) {
    return html.slice(0, headClose) +
      SDK_SCRIPT_TAG +
      html.slice(headClose);
  }
  const bodyOpen = html.toLowerCase().indexOf("<body");
  if (bodyOpen > -1) {
    // Insert as the first child of <body>.
    const close = html.indexOf(">", bodyOpen);
    if (close > -1) {
      return html.slice(0, close + 1) +
        SDK_SCRIPT_TAG +
        html.slice(close + 1);
    }
  }
  // Last resort: prepend before anything else. The app loader will run
  // after the SDK initializes `window.helmApp`, but a couple of init
  // races are possible — the app should always `await helmApp.ready`
  // before using the SDK.
  return SDK_SCRIPT_TAG + html;
}

const router = new Hono();

// The SDK lives at /apps/_sdk.js — a fixed path so we can serve it
// without paying the slug-validation cost and without being shadowed
// by the wildcard route below (slug validation rejects "_sdk" because
// of the leading underscore). This route must be registered BEFORE the
// /:slug/* wildcard so Hono matches it first.
router.get("/_sdk.js", async (c) => {
  const file = Bun.file(join(BUNDLES_ROOT, "_sdk.js"));
  if (!(await file.exists())) {
    return c.text("sdk not found", 404);
  }
  return new Response(file, {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      // The SDK is versioned via the `version` field on `window.helmApp`
      // and is small enough to cache for a deploy cycle.
      "cache-control": "public, max-age=300",
    },
  });
});

// Hono path param syntax: /apps/:slug/*  — `*` is a wildcard for the
// rest of the path. The matcher name is "rest" by default.
router.get("/:slug/*", async (c) => {
  const slug = c.req.param("slug");
  if (!SLUG_RX.test(slug)) {
    return c.text("invalid slug", 400);
  }
  const rest = c.req.param("rest") ?? "";
  const slugDir = join(BUNDLES_ROOT, slug);

  // Resolve the requested file safely — reject anything that walks
  // outside the slug directory.
  const requested = normalize(join(slugDir, rest));
  const rel = relative(slugDir, requested);
  if (rel.startsWith("..") || rel.includes("/..") || rel.startsWith("/")) {
    return c.text("forbidden", 403);
  }

  // If the request points at a directory (no extension, ends with "/"),
  // try index.html inside it.
  const candidates: string[] = [];
  if (rest === "" || rest.endsWith("/")) {
    candidates.push(join(slugDir, rest, "index.html"));
  } else {
    candidates.push(requested);
    candidates.push(join(slugDir, rest, "index.html"));
  }

  for (const candidate of candidates) {
    const file = Bun.file(candidate);
    if (await file.exists()) {
      const ext = (candidate.match(/\.[^./]+$/) ?? [""])[0]!.toLowerCase();
      const type = MIME[ext] ?? "application/octet-stream";
      // Inject the SDK into HTML responses so every app gets
      // `window.helmApp` for free. Non-HTML assets are streamed as-is.
      if (ext === ".html" || ext === ".htm") {
        const html = await file.text();
        const transformed = transformAppHtml(html);
        return new Response(transformed, {
          headers: {
            "content-type": type,
            // Short cache — bundles can change with each deploy. Apps can
            // add their own versioned URLs in their JS to bust further.
            "cache-control": "public, max-age=60",
          },
        });
      }
      return new Response(file, {
        headers: {
          "content-type": type,
          "cache-control": "public, max-age=60",
        },
      });
    }
  }

  // SPA fallback — anything we didn't recognise resolves to the slug's
  // index.html so client-side routers can take over.
  const fallback = Bun.file(join(slugDir, "index.html"));
  if (await fallback.exists()) {
    const html = await fallback.text();
    const transformed = transformAppHtml(html);
    return new Response(transformed, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, max-age=60",
      },
    });
  }
  return c.text("not found", 404);
});

// /apps/:slug/ (no trailing path) — same as /apps/:slug which already
// matches the wildcard above with `rest === ""`.

// ---------------------------------------------------------------------------
// /apps-embed — a small HTML page that hosts an app inside a sandboxed
// iframe with HELM-branded chrome around it. The page reads ?slug and
// ?install from the URL and renders the matching app at /apps/:slug/.
//
// We mount this OUTSIDE the /apps prefix so the address is stable
// (`/apps-embed`) and isn't shadowed by the slug wildcard above. The
// frontend AppFrame component points users here when they "open" an
// app from the My Apps page.
// ---------------------------------------------------------------------------
export const appsEmbedRouter = new Hono();

appsEmbedRouter.get("/apps-embed", async (c) => {
  const file = Bun.file(join(BUNDLES_ROOT, "helm-embed.html"));
  if (!(await file.exists())) {
    return c.text("embed page not found", 404);
  }
  const html = await file.text();
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The embed page is small and rarely changes — cache for a while.
      "cache-control": "public, max-age=60",
    },
  });
});

export default router;
export { BUNDLES_ROOT, transformAppHtml };
