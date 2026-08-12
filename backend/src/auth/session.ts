// Session storage. We keep sessions in Postgres so we can:
//   1. Revoke them instantly (set logout_at, delete row, etc.).
//   2. Surface them in the §2.7 admin Sessions tab without a second store.
//   3. Re-read the user's role from `users` on every request, so a role
//      change made by another admin takes effect on the *next* request
//      rather than waiting for a long-lived token to expire (docs §2.1a,5).
//
// The cookie carries ONLY the session id; role + name + username are
// looked up on every request from the live DB row.

import { sql } from "../db/client.ts";
import { config } from "../config.ts";

export interface SessionRow {
  id: string;
  user_id: string;
  login_at: Date;
  expires_at: Date;
}

export interface UserRow {
  id: string;
  username: string;
  name: string;
  role: "admin" | "user";
  must_change_password: boolean;
  is_active: boolean;
}

export async function createSession(opts: {
  userId: string;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<SessionRow> {
  const expiresAt = new Date(Date.now() + config.session.ttlSeconds * 1000);
  const rows = await sql<SessionRow[]>`
    INSERT INTO sessions (user_id, expires_at, ip, user_agent)
    VALUES (${opts.userId}, ${expiresAt}, ${opts.ip ?? null}, ${opts.userAgent ?? null})
    RETURNING id, user_id, login_at, expires_at
  `;
  return rows[0]!;
}

/**
 * Idle timeout — sessions auto-expire `IDLE_TTL_SECONDS` after the last
 * request even if the absolute TTL hasn't elapsed. Set in config; default
 * 24 hours. This is the missing piece: previously a session could live
 * up to 7 days even if the user only logged in once, so a stolen cookie
 * from a kiosk remained usable indefinitely.
 */
const IDLE_TTL_MS = (() => {
  const v = Number(process.env.HELM_IDLE_TTL_SECONDS);
  if (Number.isFinite(v) && v > 0) return v * 1000;
  return 24 * 60 * 60 * 1000; // 24 hours
})();

export async function findSession(sessionId: string): Promise<SessionRow | null> {
  // Effective expiry = MIN(absolute expires_at, last_seen_at + IDLE_TTL).
  // We do the sliding-window check in SQL so we don't pull dead rows.
  const rows = await sql<SessionRow[]>`
    SELECT id, user_id, login_at, expires_at
    FROM sessions
    WHERE id = ${sessionId}
      AND logout_at IS NULL
      AND expires_at > now()
      AND COALESCE(last_seen_at, login_at) > now() - (${IDLE_TTL_MS}::bigint || ' milliseconds')::interval
    LIMIT 1
  `;
  return rows[0] ?? null;
}

// Touch last_seen_at and append to sections_visited. Best-effort: if the
// DB write fails, the request still proceeds — observability shouldn't
// break the auth path.
export async function touchSession(sessionId: string, section: string): Promise<void> {
  try {
    await sql`
      UPDATE sessions
      SET last_seen_at = now(),
          sections_visited = (
            CASE
              WHEN ${section} = ANY(sections_visited) THEN sections_visited
              ELSE array_append(sections_visited, ${section})
            END
          )
      WHERE id = ${sessionId}
    `;
  } catch (err) {
    console.warn("touchSession failed:", (err as Error).message);
  }
}

export async function revokeSession(sessionId: string): Promise<void> {
  await sql`
    UPDATE sessions
    SET logout_at = now()
    WHERE id = ${sessionId} AND logout_at IS NULL
  `;
}

// Load the *current* user row for a session — re-read every time so role
// changes propagate instantly (docs §2.1a,5).
export async function loadUserForSession(sessionId: string): Promise<UserRow | null> {
  const rows = await sql<UserRow[]>`
    SELECT u.id, u.username, u.name, u.role, u.must_change_password, u.is_active
    FROM sessions s
    JOIN users u ON u.id = s.user_id
    WHERE s.id = ${sessionId}
      AND s.logout_at IS NULL
      AND s.expires_at > now()
    LIMIT 1
  `;
  return rows[0] ?? null;
}