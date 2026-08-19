// Hono server entry. Single app, role-based rendering happens on the
// client side, every endpoint re-checks the user's role from the DB
// (docs §2.1a,4-5). We use Bun's native `serve` (not @hono/node-server)
// so we can also bind a WebSocket handler for panel chat.

import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { config } from "./config.ts";
import { runMigrations } from "./db/migrate.ts";
import { runBootstrap } from "./auth/bootstrap.ts";
import { runSkillsSeed } from "./db/seed/skills-seed.ts";
import { seedAppsIfEmpty } from "./db/seed/apps-seed.ts";
import { seedMarketplaceIfEmpty } from "./db/seed/marketplace-seed.ts";
import authRoutes from "./routes/auth.ts";
import healthRoutes from "./routes/health.ts";
import providerRoutes from "./routes/providers.ts";
import modelRoutes from "./routes/models.ts";
import accessRoutes from "./routes/access.ts";
import chatRoutes from "./routes/chat.ts";
import panelRoutes from "./routes/panels.ts";
import userRoutes from "./routes/users.ts";
import logsRoutes from "./routes/logs.ts";
import workspaceRoutes from "./routes/workspace.ts";
import personaRoutes from "./routes/personas.ts";
import integrationRoutes from "./routes/integrations.ts";
import { skillsRouter, packsRouter } from "./routes/skills.ts";
import quotaRoutes from "./routes/quotas.ts";
import harnessRoutes from "./routes/harness.ts";
import { handlePanelUpgrade, panelWS } from "./ws.ts";
import { rateLimit, rateLimitByBody } from "./middleware/ratelimit.ts";
import { securityHeaders, originGuard } from "./middleware/security-headers.ts";
import webSearchRoutes from "./routes/websearch.ts";
import searchRoutes from "./routes/search.ts";
import memoryStrategyRoutes from "./routes/memory-strategies.ts";
import { startMemoryScheduler } from "./lib/memory-strategies/scheduler.ts";
import watchRoutes from "./routes/watches.ts";
import { startWatchScheduler } from "./lib/watches.ts";
import workflowRoutes from "./routes/workflows.ts";
import oauthRoutes from "./routes/oauth.ts";
import slackRoutes from "./routes/slack.ts";
import appRoutes from "./routes/apps.ts";
import appInstallsRoutes, { appInstallsIdRouter } from "./routes/app-installs.ts";
import appDataRoutes from "./routes/app-data.ts";
import appsBundlesRoutes, { appsEmbedRouter } from "./routes/apps-bundles.ts";
import sandboxRoutes from "./routes/sandbox.ts";
import approvalRoutes, { startApprovalSweeper } from "./routes/approvals.ts";
import setupRoutes from "./routes/setup.ts";
import feedbackRoutes from "./routes/feedback.ts";
import { startPreferenceScheduler } from "./lib/preference-learner.ts";
import { startAutoSummarizeScheduler } from "./lib/auto-summarize.ts";
import { startAuditRetention } from "./lib/audit-retention.ts";
import { startCacheRetention } from "./lib/cache-retention.ts";
import statusRoutes from "./routes/status.ts";
import comboRoutes from "./routes/combo.ts";
// Tier 3 — Voice + Multimodal
import filesRoutes from "./routes/files.ts";
import voiceRoutes from "./routes/voice.ts";
import browserRoutes from "./routes/browser.ts";
import documentsRoutes from "./routes/documents.ts";

// Tier 4 — Discovery: marketplace, knowledge graph, smart notifications.
import marketplaceRoutes from "./routes/marketplace.ts";
import knowledgeGraphRoutes from "./routes/knowledge-graph.ts";
import {
  notificationRouter,
  preferencesRouter,
  startNotificationScheduler,
} from "./lib/notifications.ts";
import { compression, cachingEtag } from "./middleware/compress.ts";

const app = new Hono();

// Optimisation: gzip + ETag reduce bandwidth and let browsers cache
// identical responses. Streaming SSE paths opt out by going through
// streamSSE() which sets Transfer-Encoding: chunked and bypasses
// compress()'s body buffer.
app.use("*", compression());
app.use("*", cachingEtag);

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: config.web.origin,
    credentials: true,
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  }),
);

// Security headers on every response + Origin guard on every state-
// changing API request. Registered BEFORE the routes so they apply
// even to early-mounted handlers (auth, providers, etc).
app.use("*", securityHeaders);
// Skip the Origin guard on unauthenticated / public endpoints so
// curl/Postman/server-to-server callers can still hit them. The SPA
// still sets Origin, so this only affects non-browser clients.
app.use("/api/*", async (c, next) => {
  const p = c.req.path;
  if (
    p === "/api/login" ||
    p === "/api/bootstrap-status" ||
    p === "/api/setup/complete"
  ) {
    return next();
  }
  return originGuard(config.web.origin)(c, next);
});

// 405 for wrong method on a known path. Hono's default 404s when
// a route is defined for one method and called with another; we
// upgrade that to a 405 + "method_not_allowed" so the client can
// see the distinction between "this URL doesn't exist" and "this
// URL exists but you used the wrong verb".
app.notFound((c) => {
  const path = c.req.path;
  const method = c.req.method;
  // Known top-level paths: any non-listed method on a known path
  // returns 405. We list the routes that exist with their supported
  // methods below; routes that aren't in any list are 404.
  const knownPaths: Record<string, string[]> = {
    "/api/login":                       ["POST"],
    "/api/logout":                      ["POST"],
    "/api/bootstrap-status":             ["GET"],
    "/api/health":                      ["GET"],
    "/api/me":                          ["GET"],
    "/api/change-password":             ["POST"],
    "/api/panels":                      ["GET", "POST"],
    "/api/chat/history":                ["GET"],
    "/api/chat/threads":               ["GET"],
    "/api/providers":                   ["GET", "POST"],
    "/api/users":                       ["GET", "POST"],
    "/api/models":                       ["GET", "POST"],
    "/api/integrations":                ["GET", "POST"],
    "/api/workspace/memory":            ["GET", "POST"],
    "/api/memory/strategies":              ["GET", "POST", "PATCH", "DELETE"],
    "/api/workspace/files":             ["GET", "POST"],
    "/api/workspace/sandbox":           ["GET"],
    "/api/workspace/keychain":          ["GET"],
    "/api/workspace/crons":             ["GET", "POST"],
    "/api/workspace/posture":           ["GET", "POST"],
    "/api/web-search":                  ["POST"],
    "/api/web-search/status":            ["GET"],
    "/api/logs/activity":               ["GET"],
    "/api/logs/sessions":               ["GET"],
    "/api/logs/step-up":                ["POST"],
    "/api/chat":                        ["POST"],
    "/api/harnesses":                   ["GET"],
    "/api/watches":                     ["GET", "POST"],
    "/api/triggers":                    ["GET", "POST"],
    "/api/workflows":                   ["GET", "POST"],
    "/api/workflow-templates":          ["GET"],
    "/api/oauth/accounts":              ["GET"],
    "/api/oauth/callback":              ["GET"],
    "/api/slack/install":               ["GET"],
    "/api/slack/install/callback":      ["POST"],
    "/api/slack/installs":              ["GET"],
    "/api/apps":                        ["GET", "POST"],
    "/api/apps/bootstrap":              ["GET"],
    "/api/apps/generate":               ["POST"],
    "/apps-embed":                      ["GET"],
    "/api/slack/events":                ["GET", "POST"],
    "/api/sandbox/sessions":            ["GET", "POST"],
    "/api/sandbox/files":               ["POST"],
    "/api/skills":                      ["GET", "POST"],
    "/api/skill-packs":                 ["GET", "POST"],
    "/api/feedback":                    ["GET", "POST", "PUT"],
    "/api/feedback/recompute-profile":  ["POST"],
    "/api/feedback/stats":              ["GET"],
    "/api/feedback/profile":            ["GET", "PUT"],
    "/api/cache/invalidate":            ["POST"],
    "/api/cache/stats":                 ["GET"],
    "/api/spend-caps":                  ["GET", "POST"],
    "/api/perf":                        ["GET"],
    "/api/health/harnesses":            ["GET"],
    // Tier 3 — Voice + Multimodal
    "/api/files":                       ["GET", "POST"],
    "/api/voice":                       ["GET", "POST"],
    "/api/browser/status":              ["GET"],
    "/api/browser/exec":                ["POST"],
    "/api/documents":                   ["GET", "POST"],
    "/api/documents/generate":          ["POST"],
  };
  if (path in knownPaths) {
    const supported = knownPaths[path]!;
    if (!supported.includes(method)) {
      return c.json({ error: "method_not_allowed" }, 405);
    }
  }
  // Sub-app prefixes — any known-method call to /api/panels/<id>,
  // /api/users/<id>, /api/workspace/{memory,files,crons}/<id> etc.
  // that uses a different verb gets 405 too.
  const subAppKnownMethods = (() => {
    if (/^\/api\/panels\/[0-9a-f-]+$/.test(path)) {
      return ["GET", "PATCH", "DELETE"];
    }
    if (/^\/api\/panels\/[0-9a-f-]+\/messages$/.test(path)) {
      return ["GET"];
    }
    if (/^\/api\/panels\/[0-9a-f-]+\/knowledge$/.test(path)) {
      return ["GET", "POST"];
    }
    if (/^\/api\/panels\/[0-9a-f-]+\/members\/?$/.test(path)) {
      return ["GET", "POST"];
    }
    if (/^\/api\/panels\/[0-9a-f-]+\/members\/[0-9a-f-]+$/.test(path)) {
      return ["DELETE"];
    }
    if (/^\/api\/panels\/[0-9a-f-]+\/agents\/?$/.test(path)) {
      return ["PUT", "DELETE"];
    }
    if (/^\/api\/panels\/[0-9a-f-]+\/agents\/[0-9a-f-]+$/.test(path)) {
      return ["DELETE"];
    }
    if (/^\/api\/panels\/[0-9a-f-]+\/skills$/.test(path)) {
      return ["GET"];
    }
    if (/^\/api\/panels\/[0-9a-f-]+\/skills\/[0-9a-f-]+$/.test(path)) {
      return ["DELETE"];
    }
    if (/^\/api\/panels\/[0-9a-f-]+\/skills\/[0-9a-f-]+\/grant$/.test(path)) {
      return ["POST"];
    }
    if (/^\/api\/panels\/[0-9a-f-]+\/presence$/.test(path)) {
      return ["GET"];
    }
    if (/^\/api\/panels\/[0-9a-f-]+\/replay$/.test(path)) {
      return ["GET", "POST"];
    }
    if (/^\/api\/users\/[0-9a-f-]+$/.test(path)) {
      return ["GET", "PATCH", "DELETE"];
    }
    if (/^\/api\/workspace\/memory\/[0-9a-f-]+$/.test(path)) {
      return ["DELETE"];
    }
    if (/^\/api\/workspace\/files\/[0-9a-f-]+$/.test(path)) {
      return ["GET", "DELETE"];
    }
    if (/^\/api\/workspace\/files\/[0-9a-f-]+\/download$/.test(path)) {
      return ["GET"];
    }
    if (/^\/api\/workspace\/crons\/[0-9a-f-]+$/.test(path)) {
      return ["DELETE"];
    }
    if (/^\/api\/workspace\/crons\/[0-9a-f-]+\/(toggle|run)$/.test(path)) {
      return ["POST"];
    }
    if (/^\/api\/providers\/[0-9a-f-]+$/.test(path)) {
      return ["GET", "DELETE"];
    }
    if (/^\/api\/providers\/[0-9a-f-]+\/fetch$/.test(path)) {
      return ["POST"];
    }
    if (/^\/api\/providers\/[0-9a-f-]+\/test$/.test(path)) {
      return ["POST"];
    }
    if (/^\/api\/providers\/[0-9a-f-]+\/key$/.test(path)) {
      return ["PUT"];
    }
    if (/^\/api\/models\/[0-9a-f-]+$/.test(path)) {
      return ["GET", "DELETE"];
    }
    if (/^\/api\/integrations\/[0-9a-f-]+$/.test(path)) {
      return ["GET", "DELETE"];
    }
    if (/^\/api\/integrations\/[0-9a-f-]+\/test$/.test(path)) {
      return ["POST"];
    }
    if (/^\/api\/harnesses\/[a-z]+\/models$/.test(path)) {
      return ["GET"];
    }
    if (/^\/api\/watches\/[0-9a-f-]+$/.test(path)) {
      return ["PATCH", "DELETE"];
    }
    if (/^\/api\/watches\/[0-9a-f-]+\/run$/.test(path)) {
      return ["POST"];
    }
    if (/^\/api\/watches\/[0-9a-f-]+\/runs$/.test(path)) {
      return ["GET"];
    }
    if (/^\/api\/webhooks\/[0-9a-f-]+$/.test(path)) {
      return ["POST"];
    }
    if (/^\/api\/triggers\/[0-9a-f-]+$/.test(path)) {
      return ["PATCH", "DELETE"];
    }
    if (/^\/api\/oauth\/[a-z]+\/start$/.test(path)) {
      return ["GET"];
    }
    if (/^\/api\/oauth\/accounts\/[0-9a-f-]+$/.test(path)) {
      return ["DELETE"];
    }
    if (/^\/api\/sandbox\/sessions\/[0-9a-f-]+$/.test(path)) {
      return ["GET"];
    }
    if (/^\/api\/sandbox\/sessions\/[0-9a-f-]+\/(exec|end|files|tree)$/.test(path)) {
      return ["GET", "POST"];
    }
    if (/^\/api\/sandbox\/sessions\/[0-9a-f-]+\/raw$/.test(path)) {
      return ["GET"];
    }
    if (/^\/api\/sandbox\/files\/[0-9a-f-]+$/.test(path)) {
      return ["GET"];
    }
    if (/^\/api\/apps\/[a-z0-9][a-z0-9-]{0,62}$/.test(path)) {
      return ["GET"];
    }
    if (/^\/api\/apps\/[0-9a-f-]+$/.test(path)) {
      return ["PATCH", "DELETE"];
    }
    if (/^\/api\/apps\/[a-z0-9][a-z0-9-]{0,62}\/installs$/.test(path)) {
      return ["GET"];
    }
    if (/^\/api\/apps\/[a-z0-9][a-z0-9-]{0,62}\/install$/.test(path)) {
      return ["POST"];
    }
    if (/^\/api\/app-installs\/[0-9a-f-]+$/.test(path)) {
      return ["DELETE"];
    }
    if (/^\/api\/app-data\/[0-9a-f-]+\/[^/]+$/.test(path)) {
      return ["GET", "POST", "DELETE"];
    }
    if (/^\/api\/skills\/[0-9a-f-]+$/.test(path)) {
      return ["GET", "PATCH", "DELETE"];
    }
    if (/^\/api\/skill-packs\/[0-9a-f-]+$/.test(path)) {
      return ["GET", "DELETE"];
    }
    if (/^\/api\/skill-packs\/[0-9a-f-]+\/import$/.test(path)) {
      return ["POST"];
    }
    if (/^\/api\/feedback\/[0-9a-f-]+$/.test(path)) {
      return ["DELETE"];
    }
    if (/^\/api\/messages\/[0-9a-f-]+\/self-test$/.test(path)) {
      return ["GET"];
    }
    if (/^\/api\/spend-caps\/[0-9a-f-]+$/.test(path)) {
      return ["GET"];
    }
    // Tier 3 — Voice + Multimodal subpaths
    if (/^\/api\/files\/[0-9a-f-]+$/.test(path)) {
      return ["GET", "DELETE"];
    }
    if (/^\/api\/files\/[0-9a-f-]+\/(download|describe)$/.test(path)) {
      return ["GET", "POST"];
    }
    if (/^\/api\/voice\/[0-9a-f-]+$/.test(path)) {
      return ["GET", "DELETE"];
    }
    if (/^\/api\/browser\/screenshots\/[a-zA-Z0-9_-]+\/[a-zA-Z0-9_.-]+$/.test(path)) {
      return ["GET"];
    }
    if (/^\/api\/documents\/[0-9a-f-]+\/download$/.test(path)) {
      return ["GET"];
    }
    if (/^\/api\/documents\/[0-9a-f-]+$/.test(path)) {
      return ["DELETE"];
    }
    return null;
  })();

  if (subAppKnownMethods !== null) {
    if (!subAppKnownMethods.includes(method)) {
      return c.json({ error: "method_not_allowed" }, 405);
    }
  }
  return c.json({ error: "not_found" }, 404);
});

app.onError((err, c) => {
  console.error("unhandled error:", err);
  return c.json({ error: "internal_error" }, 500);
});

// Health / observability
app.route("/api/health", healthRoutes);

// Auth (login, logout, me, change-password, bootstrap-status) is mounted
// LATE so the wildcard `router.use("*", requireAuth)` doesn't catch
// setup / status / public endpoints registered before it. NotFound
// delegation is a belt-and-braces fallback.
authRoutes.notFound((c) => c.notFound());

// Providers + models registry (admin CRUD + per-user list)
app.route("/api/providers", providerRoutes);

// Models (per-user list + admin grant/revoke + playground)
app.route("/api/models", modelRoutes);

// Access requests (user) + approve/deny (admin)
app.route("/api/access-requests", accessRoutes);

// 1:1 chat (streaming)
app.route("/api/chat", chatRoutes);

// Panels CRUD + members + knowledge
app.route("/api/panels", panelRoutes);

// Users CRUD (admin) — Phase 6
app.route("/api/users", userRoutes);

// Logs (admin) — Phase 6
app.route("/api/logs", logsRoutes);

// Workspace tabs — Phase 3
app.route("/api/workspace", workspaceRoutes);

// Personas — Phase 4
app.route("/api/personas", personaRoutes);

// Integrations (webhooks) — Phase 5
app.route("/api/integrations", integrationRoutes);

// Skills + skill packs (qm-parity P3)
app.route("/api/skills", skillsRouter);
app.route("/api/skill-packs", packsRouter);

// Quotas / budgets — Phase 4
app.route("/api/governance", quotaRoutes);

// Real-time web search (admin configures key, users issue queries)
app.route("/api/web-search", webSearchRoutes);

// Global search (powers the Cmd+K command palette)
app.route("/api/search", searchRoutes);

// Pluggable agent harness (P2) — list + per-harness model discovery.
app.route("/api/harnesses", harnessRoutes);

// OAuth (P5) — identity linking for Google / GitHub / Microsoft.
app.route("/api/oauth", oauthRoutes);

// Slack-native inbound (P5) — install + event webhook + audit list.
app.route("/api/slack", slackRoutes);

// Watches + triggers + webhook receiver (P4) — event-driven background
// work layered on top of the existing crons system.
// Mounted at /api but with a notFound handler that delegates back to
// the parent app so unrelated /api/* paths don't accidentally hit the
// watch router's auth middleware.
app.route("/api", watchRoutes);

// Visual workflow builder (P2) — graph CRUD + manual run + templates.
// Same delegation trick — don't accidentally auth-protect unrelated paths.
workflowRoutes.notFound((c) => c.notFound());
app.route("/api", workflowRoutes);

// Sandbox sessions (qm-parity P1) — per-user shell execution with
// real subprocess isolation (timeout, output caps, audited).
app.route("/api/sandbox", sandboxRoutes);

// Web apps platform (P7) — admin CRUD on apps + per-install data API
// + the static bundle server.
app.route("/api/apps", appRoutes);
app.route("/api/apps", appInstallsRoutes);   // /:slug/installs + /:slug/install
app.route("/api/app-installs", appInstallsIdRouter); // DELETE /:id
app.route("/api/app-data", appDataRoutes);
app.route("/apps", appsBundlesRoutes);       // public — SPA-style bundles
app.route("/", appsEmbedRouter);             // public — /apps-embed chrome

// Pluggable memory strategy administration and summaries.
app.route("/api/memory", memoryStrategyRoutes);

// Tier 1 co-pilot: inline approval gates (agent pauses, human clicks
// approve / deny). Wired after auth so the handler can resolve user.
app.route("/api/approvals", approvalRoutes);

// Tier 7 integration: combo endpoints (KG citations, voice workflow
// trigger, spend caps, self-test re-run, feedback) — wires features
// from tiers 1-6 into surfaces that span them.
app.route("/api/combo", comboRoutes);

// Tier 7 setup wizard — public endpoint used by /setup before any
// admin exists. Mounted before auth so an unconfigured instance can
// still receive the completion POST.
app.route("/api/setup", setupRoutes);

// Tier 7 status — admin-only deep health snapshot.
app.route("/api/status", statusRoutes);

// Tier 3 — Voice + Multimodal
app.route("/api/files", filesRoutes);
app.route("/api/voice", voiceRoutes);
app.route("/api/browser", browserRoutes);
app.route("/api/documents", documentsRoutes);

// Tier 5 — cost + performance: cache, spend caps, perf dashboard.
import cacheRoutes from "./routes/cache.ts";
import spendCapsRoutes from "./routes/spend-caps.ts";
import perfRoutes from "./routes/perf.ts";
import { startHealthScheduler } from "./lib/health-check.ts";
app.route("/api/cache", cacheRoutes);
app.route("/api/spend-caps", spendCapsRoutes);
app.route("/api/perf", perfRoutes);

// CSP violation report endpoint. NO auth (browsers may send reports
// from any origin, including hostile same-origin pages). Body size
// is capped and the payload is sanitised before being logged.
import cspReportRoutes from "./routes/csp-report.ts";
app.route("/api/csp-report", cspReportRoutes);

// Auth (login, logout, me, change-password, bootstrap-status) mounted
// LATE so the wildcard requireAuth doesn't catch public endpoints
// registered before it (setup, status, perf, etc).
app.route("/api", authRoutes);

// ── OpenAPI documentation surface ───────────────────────────────────
// Two PUBLIC (no-auth) endpoints:
//   GET /api/openapi.json   — the OpenAPI 3.1 spec
//   GET /api/docs           — Swagger UI rendering the spec
//
// Both are mounted LAST so any 404 fall-through from other routers
// doesn't accidentally hit the docs handlers. Implementation lives
// in src/routes/openapi-mount.ts.
//
// We mount the docs app under a dedicated `_docs` prefix so its
// OpenAPIHono-registered routes (mirrors of the real routes) don't
// shadow the actual handlers mounted below. Without this, every
// `/api/*` request gets caught by the docs copy which doesn't have
// the auth middleware in its chain — leading to `c.get("user")`
// returning undefined and 500s on every authenticated endpoint.
import { buildOpenAPIDocsApp } from "./routes/openapi-mount.ts";
app.route("/api/_docs", buildOpenAPIDocsApp());

// Tier 6 — self-improvement: feedback CRUD + profile + stats.
app.route("/api/feedback", feedbackRoutes);

// Tier 4 — Discovery (marketplace, knowledge graph, notifications).
app.route("/api/marketplace", marketplaceRoutes);
app.route("/api/kg", knowledgeGraphRoutes);
app.route("/api/notifications", notificationRouter);
app.route("/api/notification-preferences", preferencesRouter);

// Phase 8: per-IP rate limit on login + chat (the spammiest endpoints).
// Also per-username login limit so a botnet of 1000 IPs can still only
// hit one user at a small bucket.
app.use(
  "/api/login",
  rateLimit({ limit: 30, windowMs: 60_000, scope: "ip" }),
);
app.use(
  "/api/login",
  rateLimitByBody({ limit: 5, windowMs: 60_000, bodyKey: "username", prefix: "login-u", scope: "login-username" }),
);
app.use(
  "/api/chat",
  rateLimit({ limit: 120, windowMs: 60_000, scope: "user" }),
);
// Sandbox exec is the second most abusable endpoint — bound each user
// to ~60 commands / minute.
app.use(
  "/api/sandbox/sessions/:id/exec",
  rateLimit({ limit: 60, windowMs: 60_000, scope: "user" }),
);

// Boot the server: run migrations, then bootstrap the first admin, then
// start accepting HTTP + WebSocket connections.
async function main(): Promise<void> {
  await runMigrations();
  await runBootstrap();
  await runSkillsSeed();
  await seedAppsIfEmpty();
  await seedMarketplaceIfEmpty();

  // Start the watch scheduler after migrations + auth so it can read
  // watches safely. Idempotent.
  startWatchScheduler();
  startMemoryScheduler();
  // Tier 1 co-pilot: background sweeper flips stale approval requests
  // to 'expired' once their 15-minute window passes. Idempotent.
  startApprovalSweeper();
  // Tier 5 — latency-aware health checks (drives the model-router's
  // failover logic and the /health/harnesses endpoint).
  startHealthScheduler();
  // Tier 4 — smart notifications tick every 60s. Idempotent.
  startNotificationScheduler();
  // Tier 6 — preference learner (midnight) + auto-summarise (03:30).
  // Both are idempotent and short — they walk users with feedback /
  // panels with old messages respectively.
  startPreferenceScheduler();
  startAutoSummarizeScheduler();
  startAuditRetention();
  startCacheRetention();

  const server = Bun.serve<{ panelId: string; userId: string; name: string }>({
    port: config.api.port,
    // Chat streams can be long (web search + LLM thinking + slow
    // first-token). Default idleTimeout is 10s and would cut them
    // off mid-stream. Bump to 4 minutes (Bun's max is 255s) so any
    // single request has room to finish, even on big questions.
    idleTimeout: 240,
    async fetch(req, srv) {
      const url = new URL(req.url);
      // WebSocket upgrade for panel chat.
      if (url.pathname.startsWith("/api/ws/panels/")) {
        return handlePanelUpgrade(req, srv);
      }
      return app.fetch(req);
    },
    websocket: {
      // Cap inbound frame size to defeat memory-exhaustion via
      // authenticated clients (or via the cross-origin WS hijack
      // vector that authFromRequest now closes). 64 KiB is well above
      // the largest legitimate chat frame we expect.
      maxPayloadLength: 64 * 1024,
      open: panelWS.open,
      close: panelWS.close,
      message: panelWS.message,
    },
  });
  console.log(`✓ helm api listening on http://localhost:${server.port}`);
  console.log(`  web origin allowed: ${config.web.origin}`);
}

main().catch((err) => {
  console.error("✗ fatal during boot:", err);
  process.exit(1);
});

export { app };
// Debug logging to find which route catches /api/login
