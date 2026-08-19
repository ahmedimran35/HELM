// IDOR / authorization guards for the panels router. Mounts the real
// router in a tiny app, seeds users + sessions + panels directly via
// SQL (not via the API), and asserts the auth outcomes match the
// documented membership rules.

import { describe, test, expect, afterAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { sql } from "../db/client.ts";
import panelRoutes from "./panels.ts";
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

async function makePanel(createdBy: string): Promise<string> {
  const r = await sql<{ id: string }[]>`
    INSERT INTO panels (name, created_by)
    VALUES ('probe-' || ${createdBy}, ${createdBy}::uuid)
    RETURNING id
  `;
  return r[0]!.id;
}

async function addMember(panelId: string, userId: string): Promise<void> {
  await sql`
    INSERT INTO panel_members (panel_id, user_id)
    VALUES (${panelId}::uuid, ${userId}::uuid)
    ON CONFLICT DO NOTHING
  `;
}

async function cleanup(): Promise<void> {
  // Cascade via the panel -> panel_members FK; just delete panels and users.
  await sql`DELETE FROM panels WHERE name LIKE 'probe-%'`;
  await sql`DELETE FROM users WHERE username LIKE 'probe-%'`;
  // Sessions are FK'd to users with ON DELETE CASCADE so they're auto-cleaned.
  await sql`DELETE FROM sessions WHERE user_id IN (SELECT id FROM users WHERE username LIKE 'probe-%')`;
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  // Don't call sql.end() — the pool is shared across all test files
  // via globalThis.__helm_sql__. Process exit handles teardown.
});

function buildApp(): Hono {
  const app = new Hono();
  app.route("/api/panels", panelRoutes);
  return app;
}

async function request(
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

describe("IDOR: GET /api/panels/:id", () => {
  test("non-member gets 403", async () => {
    const app = buildApp();
    const owner = await makeUser("probe-owner1-" + Date.now());
    const stranger = await makeUser("probe-stranger1-" + Date.now());
    const panel = await makePanel(owner);
    await addMember(panel, owner);

    const sid = await makeSession(stranger);
    const r = await request(app, "GET", `/api/panels/${panel}`, {
      cookie: `${COOKIE_NAME}=${sid}`,
    });
    expect(r.status).toBe(403);
    expect((r.body as { error?: string }).error).toBe("forbidden");
  });

  test("member gets 200", async () => {
    const app = buildApp();
    const owner = await makeUser("probe-owner2-" + Date.now());
    const member = await makeUser("probe-member1-" + Date.now());
    const panel = await makePanel(owner);
    await addMember(panel, owner);
    await addMember(panel, member);

    const sid = await makeSession(member);
    const r = await request(app, "GET", `/api/panels/${panel}`, {
      cookie: `${COOKIE_NAME}=${sid}`,
    });
    expect(r.status).toBe(200);
    const body = r.body as { id: string; members: { user_id: string }[] };
    expect(body.id).toBe(panel);
    expect(body.members.some((m) => m.user_id === member)).toBe(true);
  });

  test("admin (non-member) gets 200 (admin bypass)", async () => {
    const app = buildApp();
    const owner = await makeUser("probe-owner3-" + Date.now());
    const admin = await makeUser("probe-admin1-" + Date.now(), "admin");
    const panel = await makePanel(owner);
    await addMember(panel, owner);

    const sid = await makeSession(admin);
    const r = await request(app, "GET", `/api/panels/${panel}`, {
      cookie: `${COOKIE_NAME}=${sid}`,
    });
    expect(r.status).toBe(200);
  });
});

describe("IDOR: DELETE /api/panels/:id", () => {
  test("regular user (even as creator/owner) gets 403", async () => {
    const app = buildApp();
    const owner = await makeUser("probe-owner4-" + Date.now());
    const panel = await makePanel(owner);
    await addMember(panel, owner);

    const sid = await makeSession(owner);
    const r = await request(app, "DELETE", `/api/panels/${panel}`, {
      cookie: `${COOKIE_NAME}=${sid}`,
    });
    // The route is gated by requireAdmin — only an admin session
    // may delete a panel. Owner (a regular user) gets 403.
    expect(r.status).toBe(403);
  });

  test("admin gets 200 and the panel row is removed", async () => {
    const app = buildApp();
    const owner = await makeUser("probe-owner5-" + Date.now());
    const admin = await makeUser("probe-admin2-" + Date.now(), "admin");
    const panel = await makePanel(owner);
    await addMember(panel, owner);

    const sid = await makeSession(admin);
    const r = await request(app, "DELETE", `/api/panels/${panel}`, {
      cookie: `${COOKIE_NAME}=${sid}`,
    });
    expect(r.status).toBe(200);
    // Verify the row was actually removed.
    const remaining = await sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM panels WHERE id = ${panel}::uuid
    `;
    expect(remaining[0]?.count).toBe(0);
  });
});

describe("IDOR: POST /api/panels/:id/knowledge (member-only)", () => {
  test("non-member gets 403", async () => {
    const app = buildApp();
    const owner = await makeUser("probe-owner6-" + Date.now());
    const stranger = await makeUser("probe-stranger2-" + Date.now());
    const panel = await makePanel(owner);
    await addMember(panel, owner);

    const sid = await makeSession(stranger);
    const r = await request(app, "POST", `/api/panels/${panel}/knowledge`, {
      cookie: `${COOKIE_NAME}=${sid}`,
      body: { name: "x", text: "hello" },
    });
    expect(r.status).toBe(403);
    expect((r.body as { error?: string }).error).toBe("forbidden");
  });

  test("member gets 200 and the doc is inserted", async () => {
    const app = buildApp();
    const owner = await makeUser("probe-owner7-" + Date.now());
    const member = await makeUser("probe-member2-" + Date.now());
    const panel = await makePanel(owner);
    await addMember(panel, owner);
    await addMember(panel, member);

    const sid = await makeSession(member);
    const r = await request(app, "POST", `/api/panels/${panel}/knowledge`, {
      cookie: `${COOKIE_NAME}=${sid}`,
      body: { name: "test-doc", text: "some text content for chunking" },
    });
    expect(r.status).toBe(200);
    expect((r.body as { id?: string }).id).toBeTruthy();
  });
});