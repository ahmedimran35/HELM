import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // Forward API calls + WebSocket upgrades to the backend during dev.
      // The browser still uses relative URLs (`/api/...`) and the cookie is
      // single-origin.
      "/api": {
        target: "http://localhost:3000",
        changeOrigin: false,
        ws: true,
      },
      // Apps platform (P7) — the embed chrome page and the per-slug
      // bundle server live on the backend. Without these proxies, dev
      // requests for `/apps-embed` and `/apps/:slug/...` would fall
      // through to Vite's SPA fallback, the React app would boot, the
      // catch-all `<Route path="*">` would match, and the user would be
      // redirected to `/` (Home). Forwarding keeps the browser on the
      // same origin (`localhost:5173`) so the session cookie is shared
      // with the React app and the iframe inside the embed page.
      //
      // The bare path `/apps` (no slug) is the in-app React route — let
      // it fall through to Vite so the SPA shell renders. Same for
      // `/apps-embed` with no slug: the embed route expects `?slug=…`.
      "/apps-embed": {
        target: "http://localhost:3000",
        changeOrigin: false,
        bypass: (req) => {
          // /apps-embed with no query string is not a real backend
          // endpoint (the backend requires a ?slug). Let Vite serve
          // the SPA fallback so React Router can handle it.
          const u = new URL(req.url ?? "", "http://localhost");
          if (!u.searchParams.has("slug")) return req.url;
        },
      },
      "/apps": {
        target: "http://localhost:3000",
        changeOrigin: false,
        // Skip the bare `/apps` route (it's the React SPA path) and
        // anything that doesn't have a slug segment after `/apps/`.
        // The backend returns 404 for `/apps` and `/apps/`; without
        // this bypass the browser would receive that JSON instead of
        // the React app.
        bypass: (req) => {
          const path = (req.url ?? "").split("?")[0];
          if (path === "/apps" || path === "/apps/") return req.url;
        },
      },
    },
  },
});