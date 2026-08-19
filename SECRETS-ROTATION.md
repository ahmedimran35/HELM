# Secrets Rotation Runbook

Secrets are leases, not freeholds. Every secret in HELM has a
documented rotation path; this runbook is the playbook for executing
each one. Aim for **zero downtime** on every rotation unless the
secret is already known-compromised — in which case skip the grace
period.

## 1. SESSION_SECRET

`SESSION_SECRET` signs cookies (HMAC) and seeds the v1 provider-key
salt (`scryptSync`). Rotating it invalidates every active session
and (if you don't also rotate `PROVIDER_KEY_SECRET`) breaks the v1
path for encrypted provider keys.

**HMAC-safe prefix chain:** SESSION_SECRET is concatenated with a
**versioned prefix** so old cookies remain valid during the rollover
window:

```
SIGNING_KEY_V1 = HMAC_SHA256("v1:" + SESSION_SECRET)
SIGNING_KEY_V2 = HMAC_SHA256("v2:" + SESSION_SECRET)
```

Cookie payload format: `version:signed_value` where `signed_value` is
`HMAC(SIGNING_KEY_V<n>, session_id)`. On verify we try each version
in order — newest first. New cookies are issued with the newest
version; old cookies keep working until they expire naturally.

**Rotation playbook:**

1. Generate a new secret (`openssl rand -hex 64`).
2. Append it as `SESSION_SECRET_V2` env var (keep the old
   `SESSION_SECRET` set).
3. Deploy. The verifier now accepts both v1 (signed with the old)
   and v2 (signed with the new). All NEW cookies use v2.
4. Wait the full TTL (7 days by default; see `config.ts`). All
   v1-signed cookies have expired.
5. Set `SESSION_SECRET=<new>`, remove `SESSION_SECRET_V2`.
6. Deploy. v1 path is now signed against a different secret than the
   one the old cookies were issued under — verify still fails on
   those, but they're expired anyway.

**To skip the grace period** (forced rotation after compromise):

1. Set `SESSION_SECRET=<new>`.
2. `UPDATE sessions SET logout_at = now() WHERE logout_at IS NULL;`
3. Deploy.

## 3. PROVIDER_KEY_SECRET

`PROVIDER_KEY_SECRET` is the dedicated scrypt salt for v2 provider
ciphertexts. Rotating it requires re-encrypting every row.

**No-downtime playbook:**

1. Generate a new secret.
2. Set `PROVIDER_KEY_SECRET_V2=<new>` (keep the old
   `PROVIDER_KEY_SECRET`).
3. Deploy. `decryptSecret` now reads v2 blobs first, falls back to
   v1 (still works because both keys are loaded).
4. Run a one-shot migration:
   ```sql
   -- For every row in `providers`, re-encrypt under the new key.
   -- The migration script lives at scripts/rotate-provider-keys.ts
   -- and is run with `bun` once.
   ```
5. The migration writes new v2 blobs (now signed with the v2 key).
6. Set `PROVIDER_KEY_SECRET=<new>`, drop the `_V2` suffix.
7. Deploy. The v1 path is no longer reachable — old v1 blobs (if
   any survived) become undecryptable.

Note: with the **AAD context label** in `providers/crypto.ts`, every
v2 blob is bound to `"helm.provider-secret.v2"`. Rotation doesn't
need a new AAD label because we only rotate the key, not the
context.

## 4. POSTGRES_PASSWORD

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

## 5. REDIS_PASSWORD

Same shape. `REDIS_URL=redis://:<pw>@host:6379`.

1. Set the new password on the redis side (`CONFIG SET requirepass`
   or the managed equivalent).
2. Update `REDIS_URL` and deploy.
3. Test with `redis-cli -u <new-url> PING`.
4. Revoke the old password (`CONFIG SET requirepass ''` is NOT it;
   the proper API is `ACL DELUSER` for ACL-based auth).

## 6. ADMIN_PASSWORD

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
   The bcrypt cost is 12 by default (see `auth/password.ts`); use the
   same cost when rotating so the timing profile stays the same.
4. Deploy. The env var is now out of sync with the DB until you
   reset the cluster — that's fine; subsequent bootstraps use the
   DB row, not the env.

If you want to **delete** the bootstrap password entirely (env
doesn't matter anymore), rotate all admin users via
`/api/change-password` and set `ADMIN_PASSWORD` to a random
placeholder. The DB row is the source of truth post-bootstrap.

## 7. Provider API keys (encrypted at rest)

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