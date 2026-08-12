// Auth endpoints: POST /api/login, POST /api/logout, GET /api/me,
// POST /api/change-password. GET /api/bootstrap-status (no auth) lets the
// front end know whether first-boot seeding happened — used to render the
// right hint on the login page.

import { Hono } from "hono";
import { sql } from "../db/client.ts";
import { config } from "../config.ts";
import { verifyPassword, hashPassword } from "../auth/password.ts";
import { createSession, revokeSession } from "../auth/session.ts";
import { requireAuth, serializeSessionCookie, clearSessionCookie } from "../middleware/auth.ts";
import { logAudit } from "../lib/audit.ts";
import { safeError } from "../lib/safe-error.ts";
import { passwordIsStrong } from "../lib/validate.ts";
import {
  isLockedOut,
  recordFailedLogin,
  recordSuccessfulLogin,
} from "../auth/lockout.ts";

const router = new Hono();

// Module-scope: a real bcrypt hash pre-computed once at boot so the
// no-user-found branch still does a full bcrypt operation and is
// timing-equivalent to the real-user branch. The previous
// "$2a$12$invalidinvalidinvalidinvali" string had a malformed salt
// (28 chars; bcrypt wants exactly 22 after "$2a$12$") and bcryptjs
// short-circuited without hashing — letting an attacker enumerate
// valid usernames by latency.
let DUMMY_HASH_PROMISE: Promise<string> | null = null;
async function getDummyHash(): Promise<string> {
  if (!DUMMY_HASH_PROMISE) {
    // We never check the result, only its timing cost.
    DUMMY_HASH_PROMISE = hashPassword(`dummy-${crypto.randomUUID()}`);
  }
  return DUMMY_HASH_PROMISE;
}

interface LoginBody {
  username?: unknown;
  password?: unknown;
}

router.post("/login", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as LoginBody;
  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  if (!username || !password) {
    return c.json({ error: "username and password required" }, 400);
  }

  const rows = await sql<{
    id: string;
    password_hash: string;
    role: "admin" | "user";
    is_active: boolean;
    must_change_password: boolean;
  }[]>`
    SELECT id, password_hash, role, is_active, must_change_password
    FROM users
    WHERE username = ${username}
    LIMIT 1
  `;
  const row = rows[0];
  if (!row || !row.is_active) {
    // Constant-time fallback: still hash against a real bcrypt hash so the
    // branch doesn't reveal which arm ran.
    const dummyHash = await getDummyHash();
    await verifyPassword(password, dummyHash);
    return c.json({ error: "invalid credentials" }, 401);
  }
  // Account lockout — credential-stuffing defense in depth. If the user
  // is already locked out, refuse the password check entirely so the
  // lockout window can't be reset by sending a correct password.
  if (await isLockedOut(row.id)) {
    await logAudit({
      userId: row.id,
      target: "auth",
      action: "login_blocked_locked",
    });
    return c.json({ error: "account_locked" }, 423);
  }
  const ok = await verifyPassword(password, row.password_hash);
  if (!ok) {
    const lock = await recordFailedLogin(row.id, {
      username,
      ip: c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ?? undefined,
    });
    await logAudit({
      userId: row.id,
      target: "auth",
      action: "login_failed",
      metadata: lock.locked
        ? { failed_logins: lock.failed_logins, locked_for_ms: lock.remainingMs }
        : undefined,
    });
    if (lock.locked) {
      // Strong feedback to the attacker: 423 Locked. Body says how long.
      return c.json(
        { error: "account_locked", retry_after_ms: lock.remainingMs },
        423,
      );
    }
    return c.json({ error: "invalid credentials" }, 401);
  }
  // Successful login — clear the failed counter + any active lockout.
  await recordSuccessfulLogin(row.id);

  // We do NOT trust X-Forwarded-For here — the IP we log for the
  // session is the connection peer. Behind a reverse proxy that knows
  // how to strip XFF correctly, set HELM_TRUSTED_PROXY=1 in env and
  // ensure your proxy rewrites XFF on every request.
  const trustProxy = process.env.HELM_TRUSTED_PROXY === "1";
  let ip: string | null = null;
  if (trustProxy) {
    const xff = c.req.header("x-forwarded-for");
    if (xff) {
      // Take the closest hop (right-most) — proxy chain is
      // "client, proxy1, proxy2"; we want proxy1's view.
      const hops = xff.split(",").map((h) => h.trim());
      ip = hops[hops.length - 1] ?? null;
    }
  }
  const ua = c.req.header("user-agent") ?? null;
  const session = await createSession({ userId: row.id, ip, userAgent: ua });

  await logAudit({
    userId: row.id,
    target: "auth",
    action: "login_success",
  });

  // Secure cookie only when serving over https. We also accept the
  // config.web.origin hostname (when it parses to https://) as a hint
  // that the SPA is fronted by TLS.
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
  });
});

router.post("/logout", async (c) => {
  const sessionId = c.get("sessionId");
  const user = c.get("user");
  if (sessionId) await revokeSession(sessionId);
  if (user) {
    await logAudit({
      userId: user.id,
      target: "auth",
      action: "logout",
    });
  }
  const isHttps = c.req.url.startsWith("https://");
  c.header("Set-Cookie", clearSessionCookie(isHttps), { append: true });
  return c.json({ ok: true });
});

router.get("/me", requireAuth, async (c) => {
  const user = c.get("user");
  return c.json({
    id: user.id,
    username: user.username,
    name: user.name,
    role: user.role,
    must_change_password: user.must_change_password,
  });
});

router.post("/change-password", requireAuth, async (c) => {
  const user = c.get("user");
  const sessionId = c.get("sessionId");
  const body = (await c.req.json().catch(() => ({}))) as {
    current?: unknown;
    next?: unknown;
  };
  const current = typeof body.current === "string" ? body.current : "";
  const nextPw = typeof body.next === "string" ? body.next : "";
  if (!current || !nextPw) {
    return c.json({ error: "current and next password required" }, 400);
  }
  if (nextPw.length < 14) {
    // 14 chars + 1 number / 1 symbol brings us past the NIST 800-63B
    // minimums for memorised secrets. Combined with bcrypt cost 12
    // this is the floor for password rotation.
    return c.json({ error: "new password must be at least 14 characters" }, 400);
  }
  // Entropy check — reject "aaaaaaaaaaaaaa" or "12345678901234".
  const strength = passwordIsStrong(nextPw);
  if (!strength.ok) {
    return c.json({ error: strength.reason ?? "password too weak" }, 400);
  }
  try {
    const rows = await sql<{ password_hash: string }[]>`
      SELECT password_hash FROM users WHERE id = ${user.id} LIMIT 1
    `;
    const row = rows[0];
    if (!row) return c.json({ error: "user not found" }, 404);
    const ok = await verifyPassword(current, row.password_hash);
    if (!ok) return c.json({ error: "current password is wrong" }, 401);
    const newHash = await hashPassword(nextPw);
    await sql`
      UPDATE users SET password_hash = ${newHash}, must_change_password = FALSE
      WHERE id = ${user.id}
    `;
  } catch (err) {
    return safeError(c, err, { status: 500, code: "internal_error" });
  }
  // a leaked device / shared browser is invalidated.
  await sql`
    UPDATE sessions SET logout_at = now()
    WHERE user_id = ${user.id}::uuid
      AND id <> ${sessionId}::uuid
      AND logout_at IS NULL
  `;
  await logAudit({
    userId: user.id,
    target: "auth",
    action: "password_changed",
  });
  return c.json({ ok: true });
});

router.get("/bootstrap-status", async (c) => {
  const rows = await sql<{ count: string }[]>`SELECT count(*)::text AS count FROM users`;
  const userCount = Number(rows[0]?.count ?? "0");
  const meta = await sql<{ bootstrapped_at: Date; bootstrapped_admin_id: string | null }[]>`
    SELECT bootstrapped_at, bootstrapped_admin_id FROM bootstrap_meta WHERE id = 1
  `;
  return c.json({
    user_count: userCount,
    bootstrapped: userCount > 0,
    bootstrapped_at: meta[0]?.bootstrapped_at ?? null,
  });
});

export default router;