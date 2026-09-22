# Secrets Rotation Runbook

Secrets are leases, not freeholds. This runbook covers every secret
in HELM and how to rotate it with minimum downtime. The single most
important fact: **`SESSION_SECRET` does not support a rolling grace
window** — changing it immediately ends every active session (see §1).

## 1. SESSION_SECRET

`SESSION_SECRET` derives provider-key encryption keys and is available
to the session layer. Rotating it ends every active session and
(before a separate provider-key rotation) can also make `v1` provider
ciphertexts unreadable. Plan for users to re-authenticate.

**No grace window.** Unlike some systems that keep an old signing key
around and accept both old and new cookies, HELM stores raw session IDs
in `sessions` and issues an opaque cookie (`helm_sid` +
`__Host-helm_sid` when `Secure`) whose value is the session UUID.
There is no `HMAC(SIGNING_KEY, session_id)` and no `version:signed`
encoding. There is therefore no dual-key path shaped like:

```
SIGNING_KEY_V1 = HMAC_SHA256("v1:" + SESSION_SECRET)
SIGNING_KEY_V2 = HMAC_SHA256("v2:" + SESSION_SECRET)
```

**Rotation playbook (only option):**

1. Generate a new secret (`openssl rand -hex 64`). Treat any
   `SESSION_SECRET_V1` / `SESSION_SECRET_V2` / `SIGNING_KEY` env you
   may have seen in an earlier draft of this doc as fictional — there
   is no such env.
2. Force-close every session:
   ```sql
   UPDATE sessions SET logout_at = now() WHERE logout_at IS NULL;
   ```
3. Set `SESSION_SECRET=<new>` and deploy. Every subsequent request
   presents a cookie whose session row is already closed and receives
   a `401`, which is the desired behaviour after a suspected leak.
4. Verify: `curl -fsS http://localhost:3000/api/login` with the new
   session secret works; old cookies are rejected.
5. Optionally rotate provider keys `v1` → `v2` as well (see §2).

## 2. PROVIDER_KEY_SECRET (dedicated key for provider ciphertexts — see `backend/src/providers/crypto.ts`)

`PROVIDER_KEY_SECRET` is the scrypt salt for `v2` provider
ciphertexts (see `backend/src/providers/crypto.ts`). The module derives
exactly two keys at import time:

- `KEY_V1` = scrypt(`SESSION_SECRET`, `"helm-provider-key-salt"`) — legacy rows
- `KEY_V2` = scrypt(`PROVIDER_KEY_SECRET ?? SESSION_SECRET`, `"helm-provider-key-salt-v2"`) — current rows

There is **no `PROVIDER_KEY_SECRET_V2` and no dual-v2-key rollover** —
only one `KEY_V2` is ever loaded, and there is no shipped re-encryption
script. The earlier draft's two-key grace-window playbook is not
implementable against this code.

**There is no zero-downtime rotation.** Changing
`PROVIDER_KEY_SECRET` immediately makes every existing `v2:` blob
undecryptable: the new key cannot read ciphertext written under the old
one. Two viable paths:

1. **Preferred — rotate the upstream provider keys instead** (see §6).
   That re-encrypts using the *existing* `PROVIDER_KEY_SECRET` and
   needs no crypto rotation at all.
2. **If `PROVIDER_KEY_SECRET` itself must change** (e.g. it leaked):
   a. Schedule a maintenance window.
   b. With the API stopped, decrypt each `providers.api_key_encrypted`
      under the old key and re-encrypt under the new key, using a
      script you write against `backend/src/providers/crypto.ts`
      (there is none in-repo).
   c. Set `PROVIDER_KEY_SECRET=<new>` and start the API.
   d. Verify each provider with a provider test / chat call.

`v1:` rows remain readable only while `SESSION_SECRET` is unchanged,
since `KEY_V1` derives from it.

## 3. POSTGRES_PASSWORD

`DATABASE_URL` carries the password. Rotating without downtime:

1. In postgres: `ALTER USER helm WITH PASSWORD '<new>';` (the new
   password is now valid alongside the old one — postgres keeps both
   until the next `ALTER USER`).
2. Update `DATABASE_URL` to use the new password.
3. Deploy.
4. Verify the API connects (`/api/health/deep`).
5. `ALTER USER helm WITH PASSWORD '<new>';` again — this drops the
   old password.

If you're on a managed postgres (RDS / Cloud SQL), use the
provider's rotate-password UI — it does the same dance atomically.

## 4. REDIS_PASSWORD

Same shape. `REDIS_URL=redis://:<pw>@host:6379`.

1. Set the new password on the redis side (`CONFIG SET requirepass`
   or the managed equivalent).
2. Update `REDIS_URL` and deploy.
3. Test with `redis-cli -u <new-url> PING`.
4. Revoke the old password (`CONFIG SET requirepass ''` is NOT it;
   the proper API is `ACL DELUSER` for ACL-based auth).

## 5. ADMIN_PASSWORD

`config.admin.password` (env `ADMIN_PASSWORD`) is the bootstrap
password for the first admin. Subsequent admins change theirs via
`/api/change-password`; only the initial bootstrap is env-driven.

**To rotate the bootstrap admin:**

1. Generate a new password.
2. Set `ADMIN_PASSWORD=<new>`.
3. Bcrypt-hash the new password and update the row:
   ```sql
   UPDATE users SET password_hash = '<new-bcrypt-hash>' WHERE username = '<admin>';
   ```
   The bcrypt cost defaults to 10 (`BCRYPT_COST`, clamped 4–15; see
   `auth/password.ts`); use the same cost when rotating so the timing
   profile stays the same.
4. Deploy. The env var is now out of sync with the DB until you
   reset the cluster — that's fine; subsequent bootstraps use the
   DB row, not the env.

If you want to **delete** the bootstrap password entirely (env
doesn't matter anymore), rotate all admin users via
`/api/change-password` and set `ADMIN_PASSWORD` to a random
placeholder. The DB row is the source of truth post-bootstrap.

## 6. Provider API keys (encrypted at rest)

Provider keys live in the `providers` table as v2 ciphertexts. To
rotate one:

1. Add the new key to the upstream provider dashboard. Old key
   remains valid for a grace period you control.
2. In HELM, go to `/settings/providers` → click the provider → paste
   the new key → Save.
3. `encryptSecret(plain)` runs with the current
   `PROVIDER_KEY_SECRET`; the row is updated to a fresh v2 blob.
4. Verify with a chat call against that provider.
5. Revoke the old key at the upstream.

No deploy. No DB migration. The row update is enough.

## Rotation cadence (recommended)

| Secret | Cadence | Reason |
| --- | --- | --- |
| SESSION_SECRET | every 12 months | HMAC key hygiene |
| PROVIDER_KEY_SECRET | every 24 months | Low-velocity key |
| POSTGRES_PASSWORD | every 6 months | Compliance default |
| REDIS_PASSWORD | every 6 months | Compliance default |
| ADMIN_PASSWORD | every 90 days | Bootstrap hygiene |
| Provider API keys | every 12 months OR on personnel change | Standard secret hygiene |

Track every rotation in the runbook log with the timestamp + who
performed it.