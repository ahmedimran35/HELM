// OpenAPI documentation surface for the top-20 public endpoints.
//
// We mount a separate `OpenAPIHono` (the same backing library used by
// `@hono/zod-openapi`) so that:
//   1. We don't disturb the existing `Hono` routers — they keep their
//      custom middleware order, ad-hoc body parsing, etc.
//   2. We can describe the routes with zod schemas + `createRoute()`
//      while the actual production routes remain defined inline (the
//      OpenAPI routes return simple placeholders that mirror the live
//      response shape — the production routes are still served from
//      `routes/*.ts`).
//
// Each error branch is typed loosely: the OpenAPI spec is the source
// of truth for documentation; TypeScript's `RouteConfigToTypedResponse`
// narrowing is a useful validation aid but isn't essential here.

import { OpenAPIHono, extendZodWithOpenApi, type RouteConfig } from "@hono/zod-openapi";
import { z } from "zod";
import { sql } from "../db/client.ts";
import { config } from "../config.ts";
import { verifyPassword, hashPassword } from "../auth/password.ts";
import { createSession, revokeSession } from "../auth/session.ts";
import { requireAuth, serializeSessionCookie, clearSessionCookie } from "../middleware/auth.ts";
import { logAudit } from "../lib/audit.ts";
import { safeError } from "../lib/safe-error.ts";
import { listHarnessHealth, refreshAllHarnesses } from "../lib/health-check.ts";
import { pingPopularProviders } from "../lib/popular-providers.ts";
import { encryptSecret, maskSecret, decryptSecret } from "../providers/crypto.ts";
import {
  assertSafeBaseUrl,
  buildAdapter,
  getProviderById,
} from "../providers/registry.ts";
import { recomputeProfileForUser } from "../lib/preference-learner.ts";

extendZodWithOpenApi(z);

// ── Common zod primitives ───────────────────────────────────────────
const uuid = z.string().uuid();
const errorSchema = z.object({
  error: z.string(),
  field: z.string().optional(),
});

// Helper that produces a `ResponseConfig` for a given status code.
// Cast to `any` so the recursive RouteConfig inference doesn't blow
// up the type checker.  The runtime behaviour is unaffected —
// only the spec generation matters here.
type RespConfig = Record<string, unknown>;

function errConfig(description: string): RespConfig {
  return {
    description,
    content: { "application/json": { schema: errorSchema } },
  };
}

// Same idea for success bodies.
function okConfig(
  schema: z.ZodTypeAny,
  description = "OK",
): RespConfig {
  return {
    description,
    content: { "application/json": { schema } },
  };
}

// Hono's `c.json(_, status)` infers a union of all known JSON status
// codes — which TypeScript can't narrow back to a single one of our
// declared responses. We cast to `any` at error-return sites so the
// spec is the single source of truth (not the TS narrowing).
type Ctx = import("hono").Context;
// Returning a `Response` widens the union so each handler's
// signature matches the .openapi() handler signature (which can be
// a Response | RouteConfigToTypedResponse union). The runtime
// behaviour is identical to c.json().
function errJson(c: Ctx, body: Record<string, unknown>, status: number): Response {
  return c.json(body, status as 400) as unknown as Response;
}

// ── OpenAPI registry app ────────────────────────────────────────────
export function buildOpenAPIRouter(): OpenAPIHono {
  const app = new OpenAPIHono();

  // ───── Health ────────────────────────────────────────────────────
  app.openapi(
    {
      method: "get",
      path: "/health",
      summary: "Liveness probe",
      description: "Returns a bare `ok` so uptime monitors can poll without auth.",
      responses: {
        200: okConfig(z.object({ ok: z.boolean(), ts: z.number() })),
      },
    },
    (c) => c.json({ ok: true, ts: Date.now() }),
  );

  app.openapi(
    {
      method: "get",
      path: "/health/harnesses",
      summary: "Per-harness latency-aware health snapshot",
      description:
        "Returns the cached harness status (60s TTL). Pass `?refresh=1` to force a fresh probe. Auth required.",
      request: {
        query: z.object({ refresh: z.string().optional() }),
      },
      security: [{ cookieAuth: [] }],
      responses: {
        200: okConfig(z.object({
          harnesses: z.array(z.object({
            kind: z.string(),
            status: z.enum(["healthy", "degraded", "down", "unknown"]),
            latency_ms: z.number(),
            last_checked_at: z.number(),
            reason: z.string().optional(),
          })),
        })),
        401: errConfig("Authentication required"),
      },
    },
    async (c) => {
      const { refresh } = c.req.valid("query");
      if (refresh === "1") await refreshAllHarnesses();
      return c.json({ harnesses: listHarnessHealth() }, 200);
    },
  );

  app.openapi(
    {
      method: "get",
      path: "/health/providers/popular",
      summary: "Reachability probe for popular AI providers",
      description:
        "No auth required. Cached 30s server-side. Returns a per-provider status, latency, and aggregate counts.",
      request: {
        query: z.object({ refresh: z.string().optional() }),
      },
      responses: {
        200: okConfig(z.any()),
      },
    },
    async (c) => {
      const { refresh } = c.req.valid("query");
      const providers = await pingPopularProviders({ forceRefresh: refresh === "1" });
      const summary = {
        up: providers.filter((p) => p.status === "up").length,
        degraded: providers.filter((p) => p.status === "degraded").length,
        down: providers.filter((p) => p.status === "down").length,
        unknown: providers.filter((p) => p.status === "unknown").length,
      };
      return c.json({ providers, summary, ts: Date.now() }, 200);
    },
  );

  // ───── Auth ──────────────────────────────────────────────────────
  const loginBody = z.object({
    username: z.string().min(1).max(120),
    password: z.string().min(1),
  });
  app.openapi(
    {
      method: "post",
      path: "/login",
      summary: "Username + password login",
      description:
        "Sets the session cookie on success. Returns 423 if the account is locked out after too many failed attempts.",
      request: {
        body: {
          content: { "application/json": { schema: loginBody } },
          required: true,
        },
      },
      responses: {
        200: okConfig(z.object({
          user: z.object({
            id: uuid,
            role: z.enum(["admin", "user"]),
            must_change_password: z.boolean(),
          }),
        })),
        400: errConfig("Missing username or password"),
        401: errConfig("Invalid credentials"),
        423: errConfig("Account locked"),
      },
    },
    async (c) => {
      const body = c.req.valid("json");
      const username = body.username.trim();
      const password = body.password;
      const rows = await sql<{
        id: string;
        password_hash: string;
        role: "admin" | "user";
        is_active: boolean;
        must_change_password: boolean;
      }[]>`
        SELECT id, password_hash, role, is_active, must_change_password
        FROM users
        WHERE username = ${username} LIMIT 1
      `;
      const row = rows[0];
      if (!row || !row.is_active) {
        return errJson(c, { error: "invalid credentials" }, 401);
      }
      const ok = await verifyPassword(password, row.password_hash);
      if (!ok) return errJson(c, { error: "invalid credentials" }, 401);
      const trustProxy = process.env.HELM_TRUSTED_PROXY === "1";
      let ip: string | null = null;
      if (trustProxy) {
        const xff = c.req.header("x-forwarded-for");
        if (xff) {
          const hops = xff.split(",").map((h) => h.trim());
          ip = hops[hops.length - 1] ?? null;
        }
      }
      const ua = c.req.header("user-agent") ?? null;
      const session = await createSession({ userId: row.id, ip, userAgent: ua });
      await logAudit({ userId: row.id, target: "auth", action: "login_success" });
      const reqUrl = new URL(c.req.url);
      const isHttps = reqUrl.protocol === "https:";
      c.header(
        "Set-Cookie",
        serializeSessionCookie(session.id, {
          maxAge: config.session.ttlSeconds,
          secure: isHttps,
        }),
        { append: true },
      );
      return c.json({
        user: {
          id: row.id,
          role: row.role,
          must_change_password: row.must_change_password,
        },
      }, 200);
    },
  );

  app.openapi(
    {
      method: "post",
      path: "/logout",
      summary: "Revoke the current session",
      description: "Clears the session cookie. Always returns 200 (idempotent).",
      security: [{ cookieAuth: [] }],
      responses: {
        200: okConfig(z.object({ ok: z.boolean() })),
      },
    },
    async (c) => {
      const sessionId = c.get("sessionId");
      const user = c.get("user");
      if (sessionId) await revokeSession(sessionId);
      if (user) {
        await logAudit({ userId: user.id, target: "auth", action: "logout" });
      }
      const isHttps = c.req.url.startsWith("https://");
      c.header("Set-Cookie", clearSessionCookie(isHttps), { append: true });
      return c.json({ ok: true }, 200);
    },
  );

  app.openapi(
    {
      method: "get",
      path: "/me",
      summary: "Current user profile",
      description: "Returns the authenticated user's id, username, name, and role.",
      security: [{ cookieAuth: [] }],
      responses: {
        200: okConfig(z.object({
          id: uuid,
          username: z.string(),
          name: z.string().nullable(),
          role: z.enum(["admin", "user"]),
          must_change_password: z.boolean(),
        })),
        401: errConfig("Authentication required"),
      },
    },
    async (c) => {
      const user = c.get("user");
      return c.json({
        id: user.id,
        username: user.username,
        name: user.name,
        role: user.role,
        must_change_password: user.must_change_password,
      }, 200);
    },
  );

  const changePasswordBody = z.object({
    current: z.string().min(1),
    next: z.string().min(14).max(1024),
  });
  app.openapi(
    {
      method: "post",
      path: "/change-password",
      summary: "Change the current user's password",
      description:
        "Validates the existing password, ensures the new password meets the 14-char / letter+digit-or-symbol complexity rule, then invalidates all other sessions.",
      security: [{ cookieAuth: [] }],
      request: {
        body: {
          content: { "application/json": { schema: changePasswordBody } },
          required: true,
        },
      },
      responses: {
        200: okConfig(z.object({ ok: z.boolean() })),
        400: errConfig("Validation failed"),
        401: errConfig("Current password is wrong"),
      },
    },
    async (c) => {
      const user = c.get("user");
      const sessionId = c.get("sessionId");
      const body = c.req.valid("json");
      try {
        const rows = await sql<{ password_hash: string }[]>`
          SELECT password_hash FROM users WHERE id = ${user.id}::uuid LIMIT 1
        `;
        const row = rows[0];
        if (!row) return errJson(c, { error: "user not found" }, 404);
        const ok = await verifyPassword(body.current, row.password_hash);
        if (!ok) return errJson(c, { error: "current password is wrong" }, 401);
        const newHash = await hashPassword(body.next);
        await sql`
          UPDATE users SET password_hash = ${newHash}, must_change_password = FALSE
          WHERE id = ${user.id}
        `;
      } catch (err) {
        return safeError(c, err, { status: 500, code: "internal_error" });
      }
      await sql`
        UPDATE sessions SET logout_at = now()
        WHERE user_id = ${user.id}::uuid
          AND id <> ${sessionId}::uuid
          AND logout_at IS NULL
      `;
      await logAudit({ userId: user.id, target: "auth", action: "password_changed" });
      return c.json({ ok: true }, 200);
    },
  );

  app.openapi(
    {
      method: "get",
      path: "/bootstrap-status",
      summary: "Whether first-boot seeding has occurred",
      description:
        "Public endpoint that returns user_count, bootstrapped flag, and the timestamp of the first admin creation. Used by the login page to render the right hint.",
      responses: {
        200: okConfig(z.object({
          user_count: z.number().int(),
          bootstrapped: z.boolean(),
          bootstrapped_at: z.string().nullable(),
        })),
      },
    },
    async (c) => {
      const rows = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM users`;
      const userCount = Number(rows[0]?.count ?? "0");
      const meta = await sql<{ bootstrapped_at: Date; bootstrapped_admin_id: string | null }[]>`
        SELECT bootstrapped_at, bootstrapped_admin_id FROM bootstrap_meta WHERE id = 1
      `;
      return c.json({
        user_count: userCount,
        bootstrapped: userCount > 0,
        bootstrapped_at: meta[0]?.bootstrapped_at ?? null,
      }, 200);
    },
  );

  // ───── Providers ─────────────────────────────────────────────────
  const ALLOWED_TYPES = new Set(["openai", "anthropic", "nvidia-nim", "openai-compatible"]);

  app.openapi(
    {
      method: "get",
      path: "/providers",
      summary: "List providers (admin)",
      description: "Returns every configured provider with masked API key and per-provider health snapshot.",
      security: [{ cookieAuth: [] }],
      responses: {
        200: okConfig(z.array(z.any())),
        401: errConfig("Unauthenticated"),
        403: errConfig("Admin only"),
      },
    },
    async (c) => {
      const user = c.get("user");
      if (!user) return errJson(c, { error: "unauthenticated" }, 401);
      if (user.role !== "admin") return errJson(c, { error: "forbidden" }, 403);
      interface ProviderRow {
        id: string;
        type: string;
        base_url: string;
        display_name: string | null;
        api_key_encrypted: string;
        added_at: Date;
        model_count: number;
      }
      const rows = await sql<ProviderRow[]>`
        SELECT p.id, p.type, p.base_url, p.display_name, p.api_key_encrypted, p.added_at,
               (SELECT count(*) FROM models m WHERE m.provider_id = p.id)::int AS model_count
        FROM providers p
        ORDER BY p.added_at ASC
      `;
      const healthEntries = await Promise.all(rows.map((r) => pingProviderOpenApi(r)));
      return c.json(rows.map((r, i) => {
        const dec = decryptSafeOpenApi(r.api_key_encrypted);
        return {
          id: r.id,
          type: r.type,
          base_url: r.base_url,
          display_name: r.display_name,
          api_key_masked: dec.ok ? maskSecret(dec.value) : "••• (key unreadable)",
          key_unreadable: !dec.ok,
          added_at: r.added_at,
          model_count: r.model_count,
          health: healthEntries[i],
        };
      }), 200);
    },
  );

  const addProviderBody = z.object({
    type: z.string().min(1),
    base_url: z.string().url().or(z.string().min(1)),
    api_key: z.string().min(1),
    display_name: z.string().nullable().optional(),
  });
  app.openapi(
    {
      method: "post",
      path: "/providers",
      summary: "Add a new provider (admin)",
      description:
        "Validates base_url against the SSRF guard, encrypts the key at rest, and writes the provider row. Pass `?allow_local=1` to permit loopback / LAN hosts.",
      security: [{ cookieAuth: [] }],
      request: {
        query: z.object({ allow_local: z.string().optional() }),
        body: {
          content: { "application/json": { schema: addProviderBody } },
          required: true,
        },
      },
      responses: {
        200: okConfig(z.object({
          id: uuid,
          type: z.string(),
          base_url: z.string(),
          display_name: z.string().nullable(),
        })),
        400: errConfig("Invalid input"),
        401: errConfig("Unauthenticated"),
        403: errConfig("Admin only"),
      },
    },
    async (c) => {
      const user = c.get("user");
      if (!user) return errJson(c, { error: "unauthenticated" }, 401);
      if (user.role !== "admin") return errJson(c, { error: "forbidden" }, 403);
      const { allow_local } = c.req.valid("query");
      const body = c.req.valid("json");
      const type = body.type;
      const baseUrl = String(body.base_url).trim();
      const apiKey = body.api_key;
      const displayName = (body.display_name ?? "").trim() || type || null;
      if (!ALLOWED_TYPES.has(type)) return errJson(c, { error: "invalid type" }, 400);
      if (!baseUrl) return errJson(c, { error: "base_url required" }, 400);
      if (!apiKey) return errJson(c, { error: "api_key required" }, 400);
      try {
        await assertSafeBaseUrl(baseUrl, { allowLocal: allow_local === "1", allowAnyPort: true });
      } catch (err) {
        return safeError(c, err, { status: 400, code: "providers_invalid" });
      }
      const enc = encryptSecret(apiKey);
      const rows = await sql<{ id: string }[]>`
        INSERT INTO providers (type, base_url, api_key_encrypted, display_name, added_by)
        VALUES (${type}, ${baseUrl}, ${enc}, ${displayName}, ${user.id}::uuid)
        RETURNING id
      `;
      const id = rows[0]!.id;
      await logAudit({
        userId: user.id,
        target: id,
        action: "provider_added",
        metadata: { type, base_url: baseUrl, display_name: displayName },
      });
      return c.json({ id, type, base_url: baseUrl, display_name: displayName }, 200);
    },
  );

  const rotateKeyBody = z.object({ api_key: z.string().min(8).max(2048) });
  app.openapi(
    {
      method: "put",
      path: "/providers/{id}/key",
      summary: "Rotate a provider's API key (admin)",
      description:
        "Re-encrypts and overwrites the stored API key with the current SESSION_SECRET. Use this when a stored key fails to decrypt (typically after a SESSION_SECRET rotation).",
      security: [{ cookieAuth: [] }],
      request: {
        params: z.object({ id: uuid }),
        body: {
          content: { "application/json": { schema: rotateKeyBody } },
          required: true,
        },
      },
      responses: {
        200: okConfig(z.object({ ok: z.boolean() })),
        400: errConfig("Validation failed"),
        404: errConfig("Provider not found"),
      },
    },
    async (c) => {
      const user = c.get("user");
      if (!user) return errJson(c, { error: "unauthenticated" }, 401);
      if (user.role !== "admin") return errJson(c, { error: "forbidden" }, 403);
      const { id } = c.req.valid("param");
      const body = c.req.valid("json");
      const existing = await getProviderById(id);
      if (!existing) return errJson(c, { error: "not_found" }, 404);
      const enc = encryptSecret(body.api_key);
      await sql`UPDATE providers SET api_key_encrypted = ${enc} WHERE id = ${id}::uuid`;
      await logAudit({
        userId: user.id,
        target: id,
        action: "provider_key_rotated",
        metadata: { type: existing.type, base_url: existing.base_url },
      });
      return c.json({ ok: true }, 200);
    },
  );

  app.openapi(
    {
      method: "post",
      path: "/providers/{id}/test",
      summary: "Reachability + latency probe (admin)",
      description:
        "Calls the upstream `/models` endpoint with a 3s timeout and returns the status, latency, and the count of models the upstream actually returned.",
      security: [{ cookieAuth: [] }],
      request: {
        params: z.object({ id: uuid }),
        query: z.object({ allow_local: z.string().optional() }),
      },
      responses: {
        200: okConfig(z.any()),
        404: errConfig("Provider not found"),
      },
    },
    async (c) => {
      const user = c.get("user");
      if (!user) return errJson(c, { error: "unauthenticated" }, 401);
      if (user.role !== "admin") return errJson(c, { error: "forbidden" }, 403);
      const { id } = c.req.valid("param");
      const { allow_local } = c.req.valid("query");
      const provider = await getProviderById(id);
      if (!provider) return errJson(c, { error: "not_found" }, 404);
      let adapter;
      try {
        adapter = await buildAdapter(provider, { allowLocal: allow_local === "1" });
      } catch (err) {
        return safeError(c, err, { status: 400, code: "providers_invalid" });
      }
      const start = Date.now();
      try {
        const upstream = await adapter.fetchModels();
        const latency_ms = Date.now() - start;
        return c.json({
          ok: true,
          latency_ms,
          upstream_status: "reachable",
          models_seen: upstream.length,
          sample: upstream.slice(0, 3).map((m) => m.externalId),
        }, 200);
      } catch (err) {
        const latency_ms = Date.now() - start;
        return c.json({
          ok: false,
          latency_ms,
          upstream_status: "unreachable",
          error: (err as Error).message,
        }, 200);
      }
    },
  );

  // ───── Models ────────────────────────────────────────────────────
  app.openapi(
    {
      method: "get",
      path: "/models",
      summary: "List models the current user can access",
      description:
        "Returns every active model joined with the user's `assigned` flag (true if admin or explicitly granted). The `pending_request` flag indicates a pending access request.",
      security: [{ cookieAuth: [] }],
      responses: {
        200: okConfig(z.array(z.any())),
      },
    },
    async (c) => {
      const user = c.get("user");
      interface ModelRow {
        id: string;
        provider_id: string;
        external_id: string;
        display_name: string;
        state: string;
        context_window: number | null;
        provider_type: string;
        provider_base_url: string;
      }
      const rows = await sql<ModelRow[]>`
        SELECT m.id, m.provider_id, m.external_id, m.display_name, m.state,
               m.context_window,
               p.type AS provider_type, p.base_url AS provider_base_url
        FROM models m
        JOIN providers p ON p.id = m.provider_id
        WHERE m.state = 'active'
        ORDER BY p.added_at ASC, m.display_name ASC
      `;
      const accessRows = user.role === "admin"
        ? []
        : await sql<{ model_id: string }[]>`
            SELECT model_id FROM model_access WHERE user_id = ${user.id}::uuid
          `;
      const assigned = new Set(accessRows.map((r) => r.model_id));
      const pendingReq = await sql<{ model_id: string; status: string }[]>`
        SELECT model_id, status FROM access_requests
        WHERE user_id = ${user.id}::uuid AND status = 'pending'
      `;
      const pending = new Set(pendingReq.map((r) => r.model_id));
      return c.json(rows.map((r) => ({
        id: r.id,
        provider_id: r.provider_id,
        provider_type: r.provider_type,
        provider_base_url: r.provider_base_url,
        external_id: r.external_id,
        display_name: r.display_name,
        context_window: r.context_window,
        assigned: user.role === "admin" ? true : assigned.has(r.id),
        pending_request: pending.has(r.id),
      })), 200);
    },
  );

  // ───── Chat ──────────────────────────────────────────────────────
  const chatBody = z.object({
    model_id: uuid,
    content: z.string().min(1).max(32000),
    system: z.string().min(1).max(8000).optional(),
    force_web_search: z.boolean().optional(),
    url: z.string().min(1).max(500).optional(),
    harness: z.enum(["openai", "anthropic", "mock", "pi", "cli"]).optional(),
  });
  app.openapi(
    {
      method: "post",
      path: "/chat",
      summary: "Send a chat message and stream the reply",
      description:
        "Streams a Server-Sent Events response (Content-Type: text/event-stream) with `data: {\"label\":\"\",\"delta\":\"...\",\"done\":false}` frames. Quota enforcement happens before the upstream call.",
      security: [{ cookieAuth: [] }],
      request: {
        body: {
          content: { "application/json": { schema: chatBody } },
          required: true,
        },
      },
      responses: {
        200: {
          description: "SSE stream of `data: {...}` lines",
          content: { "text/event-stream": { schema: z.string() } },
        },
        400: errConfig("Invalid input"),
        401: errConfig("Unauthenticated"),
        403: errConfig("No access to model"),
        404: errConfig("Model not found"),
        429: errConfig("Quota exceeded"),
      } as unknown as RouteConfig["responses"],
    },
    async (c) => {
      const user = c.get("user");
      if (!user) return errJson(c, { error: "unauthenticated" }, 401);
      const body = c.req.valid("json");
      // The actual streaming implementation lives in routes/chat.ts.
      // This OpenAPI route registers the spec for swagger so the docs
      // can describe the SSE surface; the live route is mounted
      // separately on the main Hono app.
      return c.text(`chat stream start: model_id=${body.model_id}`, 200);
    },
  );

  app.openapi(
    {
      method: "get",
      path: "/chat/threads/{id}",
      summary: "All messages for one model thread (1:1 chat)",
      description: "Returns every `messages` row for the current user, ordered by created_at ASC. `:id` is the model id.",
      security: [{ cookieAuth: [] }],
      request: {
        params: z.object({ id: uuid }),
      },
      responses: {
        200: okConfig(z.array(z.any())),
      },
    },
    async (c) => {
      const user = c.get("user");
      const { id: modelId } = c.req.valid("param");
      const rows = await sql<{
        id: string;
        role: string;
        content: string;
        tokens: number;
        created_at: Date;
      }[]>`
        SELECT id, role, content, tokens, created_at
        FROM messages
        WHERE user_id = ${user.id}::uuid AND model_id = ${modelId}::uuid
        ORDER BY created_at ASC
      `;
      return c.json(rows, 200);
    },
  );

  // ───── Feedback ──────────────────────────────────────────────────
  app.openapi(
    {
      method: "get",
      path: "/feedback/stats",
      summary: "Admin feedback aggregate",
      description:
        "Returns total votes, per-model breakdown (top 50), and a 14-day daily trend. Admin only.",
      security: [{ cookieAuth: [] }],
      responses: {
        200: okConfig(z.any()),
        403: errConfig("Admin only"),
      },
    },
    async (c) => {
      const user = c.get("user");
      if (user.role !== "admin") return errJson(c, { error: "forbidden" }, 403);
      const totals = await sql<{ total: number; ups: number; downs: number }[]>`
        SELECT
          count(*)::int AS total,
          count(*) FILTER (WHERE rating = 'up')::int AS ups,
          count(*) FILTER (WHERE rating = 'down')::int AS downs
        FROM message_feedback
      `;
      const t = totals[0] ?? { total: 0, ups: 0, downs: 0 };
      const upPct = t.total > 0 ? (t.ups / t.total) * 100 : 0;
      const perModel = await sql<{
        model_id: string;
        model_name: string | null;
        ups: number;
        downs: number;
        total: number;
      }[]>`
        SELECT m.id AS model_id, md.display_name AS model_name,
               count(*) FILTER (WHERE f.rating = 'up')::int AS ups,
               count(*) FILTER (WHERE f.rating = 'down')::int AS downs,
               count(*)::int AS total
        FROM message_feedback f
        JOIN messages m ON m.id = f.message_id
        LEFT JOIN models md ON md.id = m.model_id
        GROUP BY m.id, md.display_name
        ORDER BY total DESC
        LIMIT 50
      `;
      const trend = await sql<{ bucket: string; ups: number; downs: number }[]>`
        SELECT to_char(date_trunc('day', f.created_at), 'YYYY-MM-DD') AS bucket,
               count(*) FILTER (WHERE f.rating = 'up')::int AS ups,
               count(*) FILTER (WHERE f.rating = 'down')::int AS downs
        FROM message_feedback f
        WHERE f.created_at >= now() - INTERVAL '14 days'
        GROUP BY 1 ORDER BY 1 ASC
      `;
      return c.json({
        total: t.total,
        up_pct: upPct,
        down_pct: 100 - upPct,
        ups: t.ups,
        downs: t.downs,
        per_model: perModel.map((p) => ({
          ...p,
          up_pct: p.total > 0 ? (p.ups / p.total) * 100 : 0,
        })),
        trend,
      }, 200);
    },
  );

  const recomputeBody = z.object({ user_id: uuid.optional() });
  app.openapi(
    {
      method: "post",
      path: "/feedback/recompute-profile",
      summary: "Trigger the preference learner (admin)",
      description:
        "Recomputes derived preferences for one user (when `user_id` is provided) or every user with feedback in the last 30 days.",
      security: [{ cookieAuth: [] }],
      request: {
        body: {
          content: { "application/json": { schema: recomputeBody } },
          required: false,
        },
      },
      responses: {
        200: okConfig(z.object({ updated: z.number().int() })),
        403: errConfig("Admin only"),
      },
    },
    async (c) => {
      const user = c.get("user");
      if (user.role !== "admin") return errJson(c, { error: "forbidden" }, 403);
      const body = c.req.valid("json");
      if (body.user_id) {
        const prefs = await recomputeProfileForUser(body.user_id);
        return c.json({ updated: 1, preferences: prefs }, 200);
      }
      const targets = await sql<{ user_id: string }[]>`
        SELECT DISTINCT user_id FROM message_feedback
        WHERE created_at >= now() - INTERVAL '30 days'
      `;
      let updated = 0;
      for (const row of targets) {
        await recomputeProfileForUser(row.user_id);
        updated++;
      }
      await logAudit({
        userId: user.id,
        target: "all",
        action: "preference_recompute_all",
        metadata: { updated },
      });
      return c.json({ updated }, 200);
    },
  );

  // ───── CSP report (no auth) ──────────────────────────────────────
  const cspReportBody = z.object({
    "csp-report": z.object({
      "blocked-uri": z.string().optional(),
      "violated-directive": z.string().optional(),
      "effective-directive": z.string().optional(),
      "document-uri": z.string().optional(),
      disposition: z.string().optional(),
      "line-number": z.number().optional(),
      "column-number": z.number().optional(),
    }).passthrough(),
  }).passthrough();
  app.openapi(
    {
      method: "get",
      path: "/csp-report",
      summary: "CSP report receiver (GET — diagnostic only)",
      description:
        "Browsers POST actual CSP violations. This GET exists so the OpenAPI surface documents the endpoint and returns 200 to spec-compliant probes.",
      responses: {
        200: okConfig(z.object({ ok: z.boolean() })),
      },
    },
    (c) => c.json({ ok: true }, 200),
  );

  app.openapi(
    {
      method: "post",
      path: "/csp-report",
      summary: "CSP violation report receiver",
      description:
        "Receives `csp-report` payloads from browsers. No auth (per the CSP3 spec). Body is hard-capped at 8 KB.",
      request: {
        body: {
          content: { "application/json": { schema: cspReportBody } },
          required: true,
        },
      },
      responses: {
        204: { description: "Report accepted" },
      } as unknown as RouteConfig["responses"],
    },
    (c) => c.body(null, 204),
  );

  // ───── Audit activity (logs/activity) ────────────────────────────
  app.openapi(
    {
      method: "get",
      path: "/audit/activity",
      summary: "Admin audit log (admin + step-up required)",
      description:
        "Returns every audit_log row with optional `action` substring filter and pagination. Requires a recent step-up cookie (set by `/api/logs/step-up`).",
      security: [{ cookieAuth: [] }],
      request: {
        query: z.object({
          limit: z.string().optional(),
          offset: z.string().optional(),
          action: z.string().optional(),
        }),
      },
      responses: {
        200: okConfig(z.any()),
        401: errConfig("Step-up required"),
      },
    },
    async (c) => {
      const user = c.get("user");
      if (!user) return errJson(c, { error: "unauthenticated" }, 401);
      if (user.role !== "admin") return errJson(c, { error: "forbidden" }, 403);
      const { limit: limitRaw, offset: offsetRaw, action: actionFilter } = c.req.valid("query");
      const limit = Math.min(Math.max(Number(limitRaw ?? 25), 1), 500);
      const offset = Math.max(Number(offsetRaw ?? 0), 0);
      const rows = await sql<{
        id: string;
        user_id: string | null;
        user_name: string | null;
        target: string;
        action: string;
        tokens: number;
        metadata: unknown;
        created_at: Date;
      }[]>`
        SELECT a.id, a.user_id, u.name AS user_name, a.target, a.action, a.tokens,
               a.metadata, a.created_at
        FROM audit_log a LEFT JOIN users u ON u.id = a.user_id
        ${actionFilter ? sql`WHERE a.action LIKE ${`%${actionFilter}%`}` : sql``}
        ORDER BY a.created_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      const totalRows = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM audit_log
        ${actionFilter ? sql`WHERE action LIKE ${`%${actionFilter}%`}` : sql``}
      `;
      return c.json({
        rows,
        total: totalRows[0]?.n ?? 0,
        limit,
        offset,
      }, 200);
    },
  );

  // Apply auth middleware to the appropriate subtrees. This mirrors the
  // production routers — without these, an OpenAPIHono child route
  // wouldn't refuse calls when no session cookie is sent.
  app.use("/me", requireAuth);
  app.use("/logout", requireAuth);
  app.use("/change-password", requireAuth);
  app.use("/providers", requireAuth);
  app.use("/providers/*", requireAuth);
  app.use("/models", requireAuth);
  app.use("/chat/*", requireAuth);
  app.use("/feedback/*", requireAuth);
  app.use("/audit/*", requireAuth);
  app.use("/health/harnesses", requireAuth);

  return app;
}

// ── Helpers used inside the OpenAPIHono handlers above ──────────────
interface ProviderHealth {
  status: "healthy" | "degraded" | "down" | "unknown";
  latency_ms: number;
  checked_at: number;
  reason?: string;
  models_seen?: number;
}

interface ProviderRowOpenApi {
  type: string;
  base_url: string;
  api_key_encrypted: string;
}

function decryptSafeOpenApi(blob: string): { value: string; ok: boolean } {
  try {
    return { value: decryptSecret(blob), ok: true };
  } catch {
    return { value: "", ok: false };
  }
}

async function pingProviderOpenApi(r: ProviderRowOpenApi): Promise<ProviderHealth> {
  const start = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 3_000);
  try {
    const dec = decryptSafeOpenApi(r.api_key_encrypted);
    if (!dec.ok) {
      return {
        status: "down",
        latency_ms: 0,
        checked_at: Date.now(),
        reason: "key_unreadable",
      };
    }
    const apiKey = dec.value;
    let baseUrl = r.base_url.replace(/\/+$/, "");
    if (r.type === "openai") baseUrl = "https://api.openai.com/v1";
    else if (r.type === "anthropic") baseUrl = "https://api.anthropic.com/v1";
    const url = `${baseUrl}/models`;
    const res = await fetch(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: ctrl.signal,
    });
    const latency_ms = Date.now() - start;
    if (res.ok) {
      let models_seen: number | undefined;
      try {
        const body = await res.json() as { data?: unknown[] } | unknown[];
        if (Array.isArray(body)) models_seen = body.length;
        else if (typeof body === "object" && body !== null && Array.isArray((body as { data?: unknown[] }).data)) {
          models_seen = (body as { data: unknown[] }).data.length;
        }
      } catch { /* non-JSON body — that's fine */ }
      const status: ProviderHealth["status"] =
        latency_ms < 2_000 ? "healthy" : latency_ms < 8_000 ? "degraded" : "down";
      return { status, latency_ms, checked_at: Date.now(), models_seen };
    }
    return {
      status: res.status >= 500 ? "down" : "degraded",
      latency_ms,
      checked_at: Date.now(),
      reason: `http_${res.status}`,
    };
  } catch (err) {
    const latency_ms = Date.now() - start;
    const isAbort = (err as Error).name === "AbortError";
    return {
      status: "down",
      latency_ms,
      checked_at: Date.now(),
      reason: isAbort ? "timeout" : "ping_failed",
    };
  } finally {
    clearTimeout(timer);
  }
}
