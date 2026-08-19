# Incident Response Runbook

This runbook is what you grab when the pager fires. It assumes
you're in the middle of an incident, time is short, and the exact
root cause is unknown. Read top-to-bottom.

## Severity ladder

| Sev | Definition | Examples | Response time |
| --- | --- | --- | --- |
| P1 | Production data at risk OR service fully down for all users | Credential dump leaked, ransomware, full DB unreachable | 15 min |
| P2 | Material impact, limited subset | Single account compromise, partial outage, repeated 5xx | 1 hour |
| P3 | Minor impact | One user locked out repeatedly, single failed deploy | 1 business day |
| P4 | Cosmetic / hardening | Bad log line, misconfigured CSP, doc drift | next sprint |

## Contact roster

Fill in. Keep on paper AND on this runbook.

| Role | Primary | Backup |
| --- | --- | --- |
| Incident commander | _________________ | _________________ |
| Backend on-call | _________________ | _________________ |
| Frontend on-call | _________________ | _________________ |
| DBA (postgres) | _________________ | _________________ |
| Security lead | _________________ | _________________ |
| Comms / status page | _________________ | _________________ |
| Legal (post-disclosure) | _________________ | _________________ |

## The five phases

### 1. Detect

A security event triggered an alert. The alert source is the
`fireAlert` webhook → Slack channel → PagerDuty. The first action is
to **acknowledge** so the rotation knows someone is on it.

Look at the structured log (`level=security_event` JSON in stdout) to
see the surrounding events. The `security-events.ts` library writes
one line per event with `type`, `severity`, `user_id`, `ip`, `route`,
and `details`.

### 2. Contain

For credential / session compromise:

```sql
-- Revoke every session for the compromised user.
UPDATE sessions
SET logout_at = now()
WHERE user_id = '<compromised_user_id>'::uuid
  AND logout_at IS NULL;

-- Force a password change on next login.
UPDATE users
SET must_change_password = TRUE
WHERE id = '<compromised_user_id>'::uuid;
```

For a generic "revoke all sessions for everyone" (think: leaked
session secret):

```sql
UPDATE sessions SET logout_at = now() WHERE logout_at IS NULL;
```

Roll the affected secret (see `SECRETS-ROTATION.md`) immediately,
even before root cause is known — the cost of rotation is low and
buys time.

For a rate-limit / brute-force event in progress: temporarily tighten
`HELM_LOGIN_LOCKOUT_THRESHOLD` (env var, see `backend/src/auth/lockout.ts`)
to `2` and `HELM_LOGIN_LOCKOUT_MINUTES` to `60`. Restart the API.

For SSRF / data exfil in progress: cut egress to the destination
(see `EGRESS-FIREWALL.md`).

### 3. Eradicate

- Patch the root cause (deploy a hotfix; rotate the key; revoke the
  OAuth grant).
- Search for related indicators. If you found one leaked API key,
  check whether other keys of the same provider were also touched.
- Audit-log the cleanup actions — same audit log, new action names
  prefixed `incident_` (`incident_session_revoked`,
  `incident_secret_rotated`).

### 4. Recover

- Restore service to users. Communicate in `#status` channel (see
  Comms row of the contact roster).
- Verify the system is clean: re-run the deep health check
  (`GET /api/health/deep`), the smoke tests, and the relevant
  per-feature test (`bun test`).
- Watch the security event stream for 24 hours — recurrence of the
  same event type means the cleanup missed something.

### 5. Communicate

Internal:
- Status page update within the response time for the sev level.
- `#incident-<date>` channel for live ops chatter.
- Post-incident doc within 5 business days.

External (only if P1 or P2 with user-visible impact):
- One-paragraph email to affected users within 24 hours, even if all
  you can say is "we detected X, here's what we're doing, more soon."
- Coordinated disclosure: see `SECURITY.md` SLA.

## Session revocation script (one-liner)

```bash
# Standalone, no app deploy required. Use when the API itself is
# unreachable (you have to revoke sessions to bring it back up).
psql "$DATABASE_URL" -c "
  UPDATE sessions SET logout_at = now() WHERE logout_at IS NULL;
"
```

To revoke a single user:

```bash
psql "$DATABASE_URL" -c "
  UPDATE sessions SET logout_at = now()
    WHERE user_id = '<uuid>'::uuid AND logout_at IS NULL;
"
```

To revoke by IP (suspected attacker):

```bash
psql "$DATABASE_URL" -c "
  UPDATE sessions SET logout_at = now()
    WHERE ip = '<ip>' AND logout_at IS NULL;
"
```

## "What happened in the last hour?" — audit query

The `audit_log` table is the source of truth. Time-windowed queries
during an incident:

```sql
-- Everything in the last hour, newest first.
SELECT
  to_char(ts, 'YYYY-MM-DD HH24:MI:SS') AS ts,
  action,
  user_id,
  target,
  metadata
FROM audit_log
WHERE ts > now() - interval '1 hour'
ORDER BY ts DESC
LIMIT 1000;

-- Per-user breakdown in the last hour.
SELECT user_id, count(*), array_agg(distinct action) AS actions
FROM audit_log
WHERE ts > now() - interval '1 hour'
GROUP BY user_id
ORDER BY count(*) DESC
LIMIT 50;

-- All session logins in the last hour (successful and failed).
SELECT
  to_char(ts, 'YYYY-MM-DD HH24:MI:SS') AS ts,
  user_id,
  target,
  action,
  metadata
FROM audit_log
WHERE ts > now() - interval '1 hour'
  AND action IN ('login_success', 'login_failed', 'login_blocked_locked')
ORDER BY ts DESC;

-- All security events routed through fireAlert in the last hour
-- (if you also log to a structured channel). Grep on stdout:
--   level=security_event AND ts > "1 hour ago"
```

For deeper forensics:

```sql
-- Every action a single user took in the last 24 hours.
SELECT ts, action, target, metadata
FROM audit_log
WHERE user_id = '<uuid>'::uuid
  AND ts > now() - interval '24 hours'
ORDER BY ts;

-- IP overlap: did anyone else use the same IP recently?
SELECT user_id, count(*) AS hits, min(ts) AS first, max(ts) AS last
FROM audit_log
WHERE ip = '<suspect_ip>'
  AND ts > now() - interval '7 days'
GROUP BY user_id
ORDER BY hits DESC;
```

## Post-incident

Within 5 business days:

1. Root cause: what failed and why did our defenses not catch it
   earlier?
2. Detection lag: how long between event and alert? How long
   between alert and page?
3. Containment actions: what worked, what didn't.
4. Process improvements: rule changes, alert threshold changes,
   documentation updates.
5. Track the improvements as tickets in your tracker.