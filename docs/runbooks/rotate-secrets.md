# Rotate secrets runbook

Use this when any of the following is true:

- A secret was committed to git history (gitleaks fired)
- An operator with access left the org
- A suspected leak from a third party (provider breach)
- The 90-day rotation cadence has elapsed (see `§4 Schedule`)

## 1. Identify the blast radius

Before touching anything, list every consumer of the secret. The
table below is the authoritative inventory for this project.

| Secret                       | Stored in                      | Consumers                                          |
| ---------------------------- | ------------------------------ | -------------------------------------------------- |
| `SESSION_SECRET`             | env (`SESSION_SECRET`)         | api — session cookie signing                       |
| `ADMIN_PASSWORD`             | env (`ADMIN_PASSWORD`)         | api — bootstrap admin (only on first boot)         |
| `POSTGRES_PASSWORD`          | env + `docker-compose.yml`     | api, postgres                                      |
| `REDIS_PASSWORD`             | env + `docker-compose.yml`     | api, redis                                         |
| `WEB_SEARCH_BRAVE_KEY`       | env                            | api — web search provider                          |
| `WEB_SEARCH_TAVILY_KEY`      | env                            | api — web search provider                          |
| GitHub PAT / deploy keys     | 1Password + GitHub Secrets     | CI workflows                                       |
| cosign key (keyful mode)     | 1Password + GitHub Secrets     | `image-sign.yml` (only if KEYFUL is enabled)       |

If the leak is git-history, treat EVERY secret that's ever lived
in the repo as compromised — not just the one gitleaks flagged.
Git history is not a secret manager.

## 2. Rotation order

Rotate in this order. Skipping a step = auth breaks for users.

1. **POSTGRES_PASSWORD** first (api can't talk to db without it)
2. **REDIS_PASSWORD** (api caches break)
3. **SESSION_SECRET** (force all sessions to re-auth — expected)
4. **ADMIN_PASSWORD** (force admin to log in again — expected)
5. **Provider keys** (Brave / Tavily / OAuth client secrets)

## 3. Procedure (compose-based deployment)

```bash
# 1. Generate new secrets. NEVER reuse a secret across rotations.
NEW_PG=$(openssl rand -base64 24)
NEW_REDIS=$(openssl rand -base64 24)
NEW_SESSION=$(openssl rand -base64 48)
NEW_ADMIN=$(openssl rand -base64 24)

# 2. Update .env (and any secrets manager — DO NOT COMMIT .env).
sed -i.bak "s|^POSTGRES_PASSWORD=.*|POSTGRES_PASSWORD=${NEW_PG}|"     .env
sed -i.bak "s|^REDIS_PASSWORD=.*|REDIS_PASSWORD=${NEW_REDIS}|"       .env
sed -i.bak "s|^SESSION_SECRET=.*|SESSION_SECRET=${NEW_SESSION}|"     .env
sed -i.bak "s|^ADMIN_PASSWORD=.*|ADMIN_PASSWORD=${NEW_ADMIN}|"       .env

# 3. Rotate the postgres + redis service-side passwords.
docker compose exec postgres \
  psql -U helm -c "ALTER USER helm PASSWORD '${NEW_PG}';"
docker compose exec redis \
  redis-cli -a "${OLD_REDIS:-helm_dev}" --no-auth-warning \
    CONFIG SET requirepass "${NEW_REDIS}"

# 4. Bounce the api so it picks up the new env. The api is
#    stateless (sessions are server-side but get re-derived from
#    SESSION_SECRET — which is new anyway) so a rolling restart
#    is safe.
docker compose up -d --no-deps api
```

## 4. Schedule

- **Provider keys** — every 90 days, owner: platform-eng rotation
- **`SESSION_SECRET`** — every 30 days, owner: platform-eng rotation
- **DB / Redis passwords** — every 180 days, owner: DBA rotation
- **`ADMIN_PASSWORD`** — only rotate when the admin who knows it
  leaves the org. The bootstrap admin is for first-boot only;
  day-to-day admin auth uses individual user accounts with bcrypt.

Add the next rotation date to your calendar with the format:
`rotate-secrets — <YYYY-MM-DD> — owner: <name>`.

## 5. Verification

After the rotation:

```bash
# Login should work with the NEW admin password.
curl -fsS -X POST http://localhost:3000/api/login \
  -H 'Content-Type: application/json' \
  -d "{\"username\":\"${ADMIN_USERNAME}\",\"password\":\"${NEW_ADMIN}\"}"

# Sessions issued under the OLD secret should now fail.
# (They will; the cookie HMAC won't match. This is the desired
# behaviour — every user re-authenticates.)

# Health + audit log should be quiet (no 500s from the rotation).
curl -fsS http://localhost:3000/api/health
```

If anything above fails, see `docs/runbooks/recovery.md`.
