// AuthZ contract tests — the surface-level guards every route in this
// app claims to enforce. Each test mounts the real router at its real
// prefix, seeds users + sessions directly via SQL (not the API), and
// asserts the documented auth outcome. A route that silently accepts an
// anonymous or cross-tenant call fails here.
//
// Pattern:
//   1. Mount the real router at its production prefix.
//   2. Create users/sessions via raw SQL so we bypass seeding.
//   3. Hit the route unauthenticated, as a regular user, and as an
//      admin where the contract says only admin may call it.
//   4. Assert on status codes.

import { describe, test, expect, afterAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { config } from "../config.ts";

const COOKIE_NAME = config.session.cookieName;

async function makeUser(name: string, role: "admin" | "user" = "user"): Promise<string> {
  const r = await sql<{ id: string }[]>`
    INSERT INTO users (name, username, password_hash, role, must_change_password, is_active)
    VALUES (${name}, ${name}, 'fake-hash', ${role}, false, true)
    RETURNING id
  `;
  return r[0]!.id;
}

async function makeSession(userId: string): Promise<string> {
  const r = await sql<{ id: string }[]>`
    INSERT INTO sessions (user_id, expires_at)
    VALUES (${userId}, now() + interval '1 hour')
    RETURNING id
  `;
  return r[0]!.id;
}

async function cleanup(): Promise<void> {
  // Messages FK user_id with ON DELETE SET NULL, but messages_check
  // requires user_id OR panel_id to be non-null — so delete the rows
  // first, before dropping the users.
  await sql`DELETE FROM messages WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'authz-%')`;
  await sql`DELETE FROM panel_presence WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'authz-%')`;
  await sql`DELETE FROM panel_members WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'authz-%')`;
  await sql`DELETE FROM panels WHERE created_by IN (SELECT id FROM users WHERE username LIKE 'authz-%')`;
  await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'authz-%')`;
  await sql`DELETE FROM users WHERE username LIKE 'authz-%'`;
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
});

function buildApp(routes: Hono, mountPath: string) {
  const app = new Hono();
  app.route(mountPath, routes);
  return app;
}

function cookieFor(sid: string) {
  return `${COOKIE_NAME}=${sid}`;
}

async function req(
  app: Hono,
  method: string,
  path: string,
  opts: { cookie?: string; body?: unknown } = {},
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (opts.cookie) headers["cookie"] = opts.cookie;
  const init: RequestInit = { method, headers };
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    init.body = JSON.stringify(opts.body);
  }
  const res = await app.request(path, init);
  let body: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { status: res.status, body };
}

// ─────────────────────────────────────────────────────────────────────────
// Contract: write routes must reject unauthenticated requests with 401.
// ─────────────────────────────────────────────────────────────────────────

describe("authz contract — unauthenticated write rejection", () => {
  // chat POST is authenticated. This is the hottest route — any hole
  // here is a full-account takeover vector.
  test("POST /api/chat rejects anonymous requests", async () => {
    const { default: routes } = await import("../routes/chat.ts");
    const app = buildApp(routes, "/api/chat");
    const r = await req(app, "POST", "/api/chat", {
      body: { model_id: "00000000-0000-0000-0000-000000000000", content: "hi" },
    });
    expect(r.status).toBe(401);
  });

  // panel creation is admin-only. A non-admin must not create panels
  // even when authenticated.
  test("POST /api/panels rejects non-admin with 403", async () => {
    const { default: routes } = await import("../routes/panels.ts");
    const app = buildApp(routes, "/api/panels");
    const uid = await makeUser("authz-user-write-" + Date.now());
    const sid = await makeSession(uid);
    const r = await req(app, "POST", "/api/panels", {
      cookie: cookieFor(sid),
      body: { name: "x" },
    });
    expect(r.status).toBe(403);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Contract: admin-only routes reject regular users with 403 and accept
// admins (or the route's success path) with a non-403 status.
// ─────────────────────────────────────────────────────────────────────────

describe("authz contract — admin-only routes", () => {
  test("GET /api/providers requires admin", async () => {
    const { default: routes } = await import("../routes/providers.ts");
    const app = buildApp(routes, "/api/providers");
    const uid = await makeUser("authz-user-prov-" + Date.now());
    const sid = await makeSession(uid);
    const r = await req(app, "GET", "/api/providers", { cookie: cookieFor(sid) });
    expect(r.status).toBe(403);
  });

  test("GET /api/metrics requires admin", async () => {
    const { default: routes } = await import("../routes/metrics.ts");
    const app = buildApp(routes, "/api/metrics");
    const uid = await makeUser("authz-user-met-" + Date.now());
    const sid = await makeSession(uid);
    const r = await req(app, "GET", "/api/metrics", { cookie: cookieFor(sid) });
    expect(r.status).toBe(403);
  });

  test("GET /api/users requires admin", async () => {
    const { default: routes } = await import("../routes/users.ts");
    const app = buildApp(routes, "/api/users");
    const uid = await makeUser("authz-user-users-" + Date.now());
    const sid = await makeSession(uid);
    const r = await req(app, "GET", "/api/users", { cookie: cookieFor(sid) });
    expect(r.status).toBe(403);
  });

  test("POST /api/models/:id/grant requires admin", async () => {
    const { default: routes } = await import("../routes/models.ts");
    const app = buildApp(routes, "/api/models");
    const uid = await makeUser("authz-user-grant-" + Date.now());
    const sid = await makeSession(uid);
    const r = await req(app, "POST", "/api/models/00000000-0000-0000-0000-000000000000/grant", {
      cookie: cookieFor(sid),
      body: {},
    });
    expect(r.status).toBe(403);
  });

  // Admin on the same routes gets past the guard (403 would mean the
  // guard is inverted or the admin check is broken).
  test("GET /api/users accepts admin", async () => {
    const { default: routes } = await import("../routes/users.ts");
    const app = buildApp(routes, "/api/users");
    const admin = await makeUser("authz-admin-users-" + Date.now(), "admin");
    const sid = await makeSession(admin);
    const r = await req(app, "GET", "/api/users", { cookie: cookieFor(sid) });
    expect(r.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Contract: IDOR — a user can only read their own messages. Admin may
// read any (documented bypass).
// ─────────────────────────────────────────────────────────────────────────

describe("authz contract — IDOR surface checks", () => {
  test("citations: owner 200, stranger 403, admin 200", async () => {
    const { default: routes } = await import("../routes/chat.ts");
    const app = buildApp(routes, "/api/chat");
    const owner = await makeUser("authz-owner-cit-" + Date.now());
    const stranger = await makeUser("authz-stranger-cit-" + Date.now());
    const admin = await makeUser("authz-admin-cit-" + Date.now(), "admin");
    const ownerSid = await makeSession(owner);
    const strangerSid = await makeSession(stranger);
    const adminSid = await makeSession(admin);
    const ins = await sql<{ id: string }[]>`
      INSERT INTO messages (user_id, model_id, role, content, tokens)
      VALUES (${owner}, NULL, 'assistant', 'hi', 1)
      RETURNING id
    `;
    const rid = ins[0]!.id;

    const ownerR = await req(app, "GET", `/api/chat/messages/${rid}/citations`, {
      cookie: cookieFor(ownerSid),
    });
    expect(ownerR.status).toBe(200);

    const strangerR = await req(app, "GET", `/api/chat/messages/${rid}/citations`, {
      cookie: cookieFor(strangerSid),
    });
    expect(strangerR.status).toBe(403);

    const adminR = await req(app, "GET", `/api/chat/messages/${rid}/citations`, {
      cookie: cookieFor(adminSid),
    });
    expect(adminR.status).toBe(200);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Contract: panel membership — non-members are rejected, members are
// accepted, admins bypass the membership gate.
// ─────────────────────────────────────────────────────────────────────────

describe("authz contract — panel membership gate", () => {
  test("GET /api/panels/:id: member 200, stranger 403, admin 200", async () => {
    const { default: routes } = await import("../routes/panels.ts");
    const app = buildApp(routes, "/api/panels");
    const owner = await makeUser("authz-panel-owner-" + Date.now());
    const member = await makeUser("authz-panel-member-" + Date.now());
    const stranger = await makeUser("authz-panel-stranger-" + Date.now());
    const admin = await makeUser("authz-panel-admin-" + Date.now(), "admin");

    const panelRows = await sql<{ id: string }[]>`
      INSERT INTO panels (name, created_by)
      VALUES ('authz-panel-' || ${Date.now()}, ${owner}::uuid)
      RETURNING id
    `;
    const panelId = panelRows[0]!.id;
    await sql`INSERT INTO panel_members (panel_id, user_id) VALUES (${panelId}::uuid, ${owner}::uuid)`;
    await sql`INSERT INTO panel_members (panel_id, user_id) VALUES (${panelId}::uuid, ${member}::uuid)`;

    const memberSid = await makeSession(member);
    const strangerSid = await makeSession(stranger);
    const adminSid = await makeSession(admin);

    const memberR = await req(app, "GET", `/api/panels/${panelId}`, {
      cookie: cookieFor(memberSid),
    });
    expect(memberR.status).toBe(200);

    const strangerR = await req(app, "GET", `/api/panels/${panelId}`, {
      cookie: cookieFor(strangerSid),
    });
    expect(strangerR.status).toBe(403);

    const adminR = await req(app, "GET", `/api/panels/${panelId}`, {
      cookie: cookieFor(adminSid),
    });
    expect(adminR.status).toBe(200);
  });
});
