// Smoke for requireAuth + requireAdmin middleware. Builds a tiny
// Hono app in-process, mounts the middlewares on a test route, and
// asserts the auth boundary end-to-end against the real DB:
//
//   1. requireAuth returns 401 if no cookie is present
//   2. requireAdmin returns 403 if the role is 'user'
//   3. requireAdmin returns 200 if the role is 'admin'
//   4. Role flip propagates on the next request (no JWT-style
//      caching of the role at login time).

import { describe, test, expect, afterAll, beforeEach } from "bun:test";
import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "./auth.ts";
import { requireAdmin } from "./role.ts";
import { config } from "../config.ts";

const COOKIE_NAME = config.session.cookieName;

async function makeUser(role: "admin" | "user"): Promise<string> {
  const username = `__probe_${role}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const passwordHash =
    "$2a$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123";
  const r = await sql<{ id: string }[]>`
    INSERT INTO users (name, username, password_hash, role, must_change_password, is_active)
    VALUES (${username}, ${username}, ${passwordHash}, ${role}, false, true)
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
  // Sessions cascade via FK to users.
  await sql`DELETE FROM users WHERE username LIKE '__probe_%'`;
}

beforeEach(cleanup);
afterAll(async () => {
  await cleanup();
  // Don't call sql.end() — bun:test runs all suites in one process and
  // the pool is shared via globalThis.__helm_sql__. The process exit
  // will tear it down.
});

function buildApp(): Hono {
  const app = new Hono();
  app.get("/api/probe", requireAuth, requireAdmin, (c) =>
    c.json({ ok: true, role: c.get("user").role }),
  );
  return app;
}

async function request(
  app: Hono,
  cookie?: string,
): Promise<{ status: number; body: unknown }> {
  const headers: Record<string, string> = {};
  if (cookie) headers["cookie"] = cookie;
  const res = await app.request("/api/probe", { headers });
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

describe("requireAuth + requireAdmin", () => {
  test("requireAuth returns 401 if no cookie is present", async () => {
    const app = buildApp();
    const r = await request(app);
    expect(r.status).toBe(401);
    expect((r.body as { error?: string }).error).toBe("unauthenticated");
  });

  test("requireAdmin returns 403 if the user role is 'user'", async () => {
    const app = buildApp();
    const userId = await makeUser("user");
    const sid = await makeSession(userId);
    const r = await request(app, `${COOKIE_NAME}=${sid}`);
    expect(r.status).toBe(403);
    expect((r.body as { error?: string }).error).toBe("forbidden");
  });

  test("requireAdmin returns 200 if the user role is 'admin'", async () => {
    const app = buildApp();
    const userId = await makeUser("admin");
    const sid = await makeSession(userId);
    const r = await request(app, `${COOKIE_NAME}=${sid}`);
    expect(r.status).toBe(200);
    expect((r.body as { role?: string }).role).toBe("admin");
  });

  test("role flip propagates on the next request (no JWT-style caching)", async () => {
    // Belt-and-braces: confirms the middleware re-reads the role
    // from the DB on every request so a privilege downgrade takes
    // effect immediately, not at the next login.
    const app = buildApp();
    const userId = await makeUser("admin");
    const sid = await makeSession(userId);
    const cookie = `${COOKIE_NAME}=${sid}`;

    const r1 = await request(app, cookie);
    expect(r1.status).toBe(200);

    await sql`UPDATE users SET role = 'user' WHERE id = ${userId}::uuid`;
    const r2 = await request(app, cookie);
    expect(r2.status).toBe(403);

    // Flip back so cleanup is clean.
    await sql`UPDATE users SET role = 'admin' WHERE id = ${userId}::uuid`;
  });
});