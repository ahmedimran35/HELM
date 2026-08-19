// Login lockout helpers.  Sits in its own file so both the HTTP
// /api/login and the (future) WebSocket-issued challenge path can
// share the same failure-tracking primitive.
//
// Strategy:
//   - After every wrong password, increment users.failed_logins.
//   - When failed_logins >= THRESHOLD, set users.locked_until =
//     now() + DURATION. While now() < locked_until, every login
//     attempt for that user returns 423 Locked — even with the right
//     password — to prevent brute force.
//   - On successful login, reset failed_logins = 0 and clear locked_until.
//   - When a user crosses the threshold, fire a real-time alert via
//     `fireAlert` so the operator can investigate (Slack / PagerDuty
//     / Discord / Mattermost incoming-webhook).
//
// The threshold and duration are env-driven so the operator can tune
// for risk. Defaults: 5 attempts, 15 minutes lockout.

import { sql } from "../db/client.ts";
import { fireAlert } from "../lib/alerts.ts";
import { logSecurityEvent } from "../lib/security-events.ts";

const THRESHOLD = Number(process.env.HELM_LOGIN_LOCKOUT_THRESHOLD ?? 5);
const DURATION_MINUTES = Number(process.env.HELM_LOGIN_LOCKOUT_MINUTES ?? 15);

export async function isLockedOut(userId: string): Promise<boolean> {
  const r = await sql<{ locked_until: Date | null }[]>`
    SELECT locked_until FROM users WHERE id = ${userId}::uuid LIMIT 1
  `;
  const lu = r[0]?.locked_until;
  return lu != null && lu.getTime() > Date.now();
}

export async function recordFailedLogin(
  userId: string,
  opts: { username?: string; ip?: string } = {},
): Promise<{ locked: boolean; remainingMs: number; failed_logins: number }> {
  // Bump the counter atomically. If we just crossed the threshold,
  // set locked_until too.
  const r = await sql<{ failed_logins: number; locked_until: Date | null }[]>`
    UPDATE users
    SET failed_logins = failed_logins + 1,
        locked_until  = CASE
          WHEN failed_logins + 1 >= ${THRESHOLD} AND (locked_until IS NULL OR locked_until < now())
            THEN now() + (${DURATION_MINUTES}::int * interval '1 minute')
          ELSE locked_until
        END
    WHERE id = ${userId}::uuid
    RETURNING failed_logins, locked_until
  `;
  const row = r[0];
  const locked = row?.locked_until != null && (row.locked_until as Date).getTime() > Date.now();
  const remainingMs = locked && row ? (row.locked_until as Date).getTime() - Date.now() : 0;
  // Every failed login is a structured security event (warn). Even
  // non-locking failures get recorded so a credential-stuffing pattern
  // shows up in the log aggregator even before lockout fires.
  logSecurityEvent({
    type: "auth_failure",
    severity: "warn",
    userId,
    ip: opts.ip,
    route: "/api/login",
    details: {
      username: opts.username ?? "?",
      failed_logins: row?.failed_logins ?? 0,
      locked: locked ? "true" : "false",
    },
    ts: Date.now(),
  });
  if (locked) {
    logSecurityEvent({
      type: "account_lockout",
      severity: "critical",
      userId,
      ip: opts.ip,
      route: "/api/login",
      details: {
        username: opts.username ?? "?",
        failed_logins: row?.failed_logins ?? 0,
        locked_for_seconds: Math.ceil(remainingMs / 1000),
      },
      ts: Date.now(),
    });
    fireAlert({
      severity: "critical",
      title: `account locked: ${opts.username ?? userId}`,
      body:
        `User account exceeded ${THRESHOLD} failed login attempts and was ` +
        `locked for ${DURATION_MINUTES} minutes.\n` +
        `If this is unexpected, investigate immediately — credential stuffing ` +
        `is in progress.`,
      fields: [
        { name: "user_id", value: userId },
        { name: "username", value: opts.username ?? "?" },
        { name: "ip", value: opts.ip ?? "?" },
        { name: "failed_logins", value: String(row?.failed_logins ?? 0) },
        { name: "locked_for_seconds", value: String(Math.ceil(remainingMs / 1000)) },
      ],
    });
  }
  return { locked: !!locked, remainingMs, failed_logins: row?.failed_logins ?? 0 };
}

export async function recordSuccessfulLogin(userId: string): Promise<void> {
  await sql`
    UPDATE users
    SET failed_logins = 0, locked_until = NULL
    WHERE id = ${userId}::uuid
  `;
}
