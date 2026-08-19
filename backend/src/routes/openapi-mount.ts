// OpenAPI orchestrator. Generates the spec from the OpenAPIHono
// registered routes and exposes two endpoints:
//   GET /api/openapi.json  — the OpenAPI 3.1 spec document
//   GET /api/docs          — Swagger UI rendering the spec
//
// Both endpoints are PUBLIC (no auth) — they only serve metadata.

import { OpenAPIHono } from "@hono/zod-openapi";
import { swaggerUI } from "@hono/swagger-ui";
import { buildOpenAPIRouter } from "./openapi.ts";

const info = {
  title: "Helm Backend API",
  version: "0.1.0",
  description:
    "Documented surface for the top 20 API endpoints. Auth uses a __Host- session cookie set by /api/login.",
};

const servers = [{ url: "/api", description: "Same-origin /api base" }];

const tags = [
  { name: "Health", description: "Liveness + harness + provider probes" },
  { name: "Auth", description: "Login, logout, me, change-password, bootstrap" },
  { name: "Providers", description: "Admin CRUD + connectivity probes on providers" },
  { name: "Models", description: "Per-user model registry" },
  { name: "Chat", description: "1:1 chat streaming + thread reads" },
  { name: "Feedback", description: "Self-improvement signal surfaces" },
  { name: "CSP", description: "Content Security Policy report receiver (public)" },
  { name: "Audit", description: "Admin audit log" },
];

export function buildOpenAPIDocsApp(): OpenAPIHono {
  // Build the documented routes once, then layer them under a fresh
  // OpenAPIHono that exposes `/openapi.json` (the spec) and `/docs`
  // (the rendered swagger UI).  Each `.openapi(...)` call from
  // buildOpenAPIRouter() registers the route on its own OpenAPIHono
  // — we then re-mount that registry under our docs app.
  const registry = buildOpenAPIRouter();
  const app = new OpenAPIHono();
  app.route("/", registry);
  // doc31 generates an OpenAPI 3.1 document at the given path.
  app.doc31("/openapi.json", {
    openapi: "3.1.0",
    info,
    servers,
    tags: [...tags],
  });
  // Swagger UI is served from /docs and points at the spec URL.
  // The docs app is mounted at /api/_docs so the actual paths are
  // /api/_docs/openapi.json and /api/_docs/docs.
  app.get("/docs", swaggerUI({ url: "/api/_docs/openapi.json" }));
  return app;
}
