// Standalone smoke for requireAdmin middleware. Builds a tiny Hono app
// in-process, mounts requireAuth + requireAdmin on a test route, and
// verifies the role boundary:
//   1. No cookie           -> 401
//   2. Cookie w/ user role -> 403
//   3. Cookie w/ admin     -> 200
//
// We don't hit the real DB here — we stub the cookie parsing by
// injecting a fake session id, then monkey-patch the loadUserForSession
// import to return a user of our choosing. Real E2E coverage comes in
// Phase 8 hardening; this is enough for Phase 0 confidence.

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { requireAuth } from "../middleware/auth.ts";
import { requireAdmin } from "../middleware/role.ts";
import { config } from "../config.ts";

type SessionFixture = {
  id: string;
  user_id: string;
  login_at: Date;
  expires_at: Date;
};

type UserFixture = {
  id: string;
  username: string;
  name: string;
  role: "admin" | "user";
  must_change_password: boolean;
  is_active: boolean;
};

async function withFakeSession<T>(
  role: "admin" | "user" | null,
  fn: () => Promise<T>,
): Promise<T> {
  if (role === null) {
    return fn();
  }
  // Make a real user + session in the DB so the middleware's lookup
    // succeeds end-to-end. This is closer to production than mocking.
  const username = `__probe_${role}_${Date.now()}`;
  const passwordHash =
    "$2a$12$abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123";
  const userRows = await sql<{ id: string }[]>`
    INSERT INTO users (name, username, password_hash, role, must_change_password, is_active)
    VALUES (${username}, ${username}, ${passwordHash}, ${role}, false, true)
    RETURNING id
  `;
  const userId = userRows[0]!.id;
  const sessRows = await sql<{ id: string }[]>`
    INSERT INTO sessions (user_id, expires_at)
    VALUES (${userId}, now() + interval '1 hour')
    RETURNING id
  `;
  const sessionId = sessRows[0]!.id;
  try {
    return await fn();
  } finally {
    await sql`DELETE FROM sessions WHERE id = ${sessionId}::uuid`;
    await sql`DELETE FROM users WHERE id = ${userId}::uuid`;
  }
}

async function buildApp(): Promise<Hono> {
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

async function main(): Promise<void> {
  const app = await buildApp();

  // 1. No cookie -> 401
  const r1 = await request(app);
  if (r1.status !== 401) throw new Error(`expected 401 for no cookie, got ${r1.status}`);

  // 2. User cookie -> 403
  await withFakeSession("user", async () => {
    const fakeSession = await sql<SessionFixture[]>`
      SELECT id, user_id, login_at, expires_at FROM sessions ORDER BY login_at DESC LIMIT 1
    `;
    const sid = fakeSession[0]!.id;
    const cookie = `${config.session.cookieName}=${sid}`;
    const r = await request(app, cookie);
    if (r.status !== 403) throw new Error(`expected 403 for user, got ${r.status}`);
    if ((r.body as { error?: string }).error !== "forbidden") {
      throw new Error(`expected error="forbidden", got ${JSON.stringify(r.body)}`);
    }
  });

  // 3. Admin cookie -> 200
  await withFakeSession("admin", async () => {
    const fakeSession = await sql<SessionFixture[]>`
      SELECT id, user_id, login_at, expires_at FROM sessions ORDER BY login_at DESC LIMIT 1
    `;
    const sid = fakeSession[0]!.id;
    const cookie = `${config.session.cookieName}=${sid}`;
    const r = await request(app, cookie);
    if (r.status !== 200) throw new Error(`expected 200 for admin, got ${r.status}`);
    if ((r.body as { role?: string }).role !== "admin") {
      throw new Error(`expected role="admin", got ${JSON.stringify(r.body)}`);
    }
  });

  // 4. Verify the lookupUserForSession path returns the role at the moment
  //    of the request — set up admin, then flip role to user in DB, then
  //    hit the endpoint and confirm it now 403s.
  await withFakeSession("admin", async () => {
    const sessRows = await sql<SessionFixture[]>`
      SELECT id, user_id, login_at, expires_at FROM sessions ORDER BY login_at DESC LIMIT 1
    `;
    const sid = sessRows[0]!.id;
    const userId = sessRows[0]!.user_id;
    const cookie = `${config.session.cookieName}=${sid}`;

    // First hit: should be 200 (admin)
    const r1 = await request(app, cookie);
    if (r1.status !== 200) throw new Error(`pre-flip expected 200, got ${r1.status}`);

    // Flip the role in the DB.
    await sql`UPDATE users SET role = 'user' WHERE id = ${userId}::uuid`;

    // Same cookie, no refresh — should now 403 because middleware re-reads.
    const r2 = await request(app, cookie);
    if (r2.status !== 403) throw new Error(`post-flip expected 403, got ${r2.status}`);

    // Flip back so the cleanup is clean.
    await sql`UPDATE users SET role = 'admin' WHERE id = ${userId}::uuid`;
  });

  console.log("✓ requireAdmin: 401 / 403 / 200 / role-flip-propagates all pass");
  await sql.end();
}

main().catch((err) => {
  console.error("✗", err);
  process.exit(1);
});