# HELM CLI

`backend/src/cli.ts` is a single-binary ops console for HELM. The
same file boots the api server, but it also exposes a small command
layer for the boring ops jobs you don't want to script in shell:
migrations, password resets, status probes, and log tailing.

Everything in this document assumes your cwd is `backend/` and the
api server is runnable as `bun src/index.ts`.

---

## Install

The cli is part of the repo — there's nothing to install separately.
If you have `bun` (≥ 1.1) and `postgres` running, you're done:

```bash
cd backend
bun install          # only required once, after a fresh checkout
bun src/cli.ts up    # bring up the whole stack
```

The first time you run `up`, the cli will:

1. Run every migration in `src/db/migrations/`.
2. Seed the first admin from `ADMIN_USERNAME` / `ADMIN_PASSWORD`
   (auto-generated if you didn't set them — printed to stdout).
3. Seed skill packs and demo apps.
4. Spawn `bun src/index.ts` in the foreground so logs flow to your
   terminal.

---

## Configuration

All knobs are environment variables. The cli auto-provisions the
ones it needs (database url, admin password, session secret) and
persists the auto-generated values to `backend/.helm-secrets` so
restarts stay stable across boots.

| Variable | Default | Used by |
|---|---|---|
| `DATABASE_URL` | `postgres://helm:helm@localhost:5432/helm` | `up`, every command |
| `ADMIN_USERNAME` | `admin` | `up` |
| `ADMIN_PASSWORD` | _auto-generated 24-hex_ | `up` |
| `SESSION_SECRET` | _auto-generated 64-hex_ | api |
| `REDIS_URL` | `redis://localhost:6379` | api |
| `API_PORT` | `3000` | api |
| `WEB_ORIGIN` | `http://localhost:5173` | api (CORS allow-list) |
| `LIGHTPANDA_BIN` | `lightpanda` | api (live web search) |

If you'd rather pin the values yourself, drop them in the repo-root
`.env` — the api's config loader reads it on boot.

---

## Commands

### `bun src/cli.ts up`

Migrate + seed + start the api in the foreground. This is the
"zero-config deploy" entrypoint — a fresh checkout with just `up`
gets a working install.

On first boot it prints the auto-generated admin credentials to the
console. **Change the admin password after the first login.**

### `bun src/cli.ts status`

Health probe that does **not** depend on the api being up. It
opens the DB directly so you can tell whether the system is healthy
when the api itself is broken. Output looks like:

```
  ✓  postgres    ok      2026-08-11T16:48:12.345Z
  ✗  api         down    ECONNREFUSED
  ·  schedulers  ok      watch scheduler
  ·  schedulers  ok      memory scheduler
  ·  users       4       active accounts
  ·  panels      12      active panels
  ·  workflows   3       active workflows
```

Exit codes:
- `0` — everything healthy.
- `1` — degraded (one subsystem down but the rest works).
- `2` — system down (DB unreachable, no point probing further).

### `bun src/cli.ts logs [lines=20]`

Tail the most recent audit log rows plus a snapshot of active
sessions. Useful when you're SSHed into a box and want to know
"who did what recently" without opening the admin UI.

```
$ bun src/cli.ts logs 5
  HELM  v0.1  ·  governed multiplayer ai workspace

  audit (last 5)

  2026-08-11 16:42:18  imran          login_success        auth
  2026-08-11 16:42:21  imran          chat_assistant_message  MDL-12
  2026-08-11 16:42:51  imran          panel_message        PNL-04
  2026-08-11 16:43:02  imran          chat_assistant_message  MDL-12
  2026-08-11 16:43:30  imran          chat_assistant_message  MDL-12

  active sessions (1)

  2026-08-11 16:42:18  imran          10.0.0.42
```

### `bun src/cli.ts reset-password <username>`

Generate a one-time password for an existing user. The cli prints
the new password once and marks the account with
`must_change_password=TRUE` so they're forced to set their own
password on next login.

```
$ bun src/cli.ts reset-password imran
  ✓ reset imran's password:
    Hk8BnP3wQrTvZ9
  · they must change this on next login
```

### `bun src/cli.ts seed`

Re-run all the seeders in sequence (migrations, bootstrap, skill
packs, demo apps). Idempotent — safe to run as many times as you
want. Useful after wiping the DB and wanting to repopulate it
without restarting the api.

### `bun src/cli.ts help`

Print the usage screen. Also the default behaviour when you run the
cli with no command at all.

---

## Backup / restore

HELM stores everything in Postgres, so the standard `pg_dump` /
`pg_restore` flow works. The cli does **not** wrap these — they're
trivially two-liners and you should wire them into whatever
infrastructure you already use (cron, systemd timers, k8s CronJob,
etc.).

```bash
# backup
pg_dump "$DATABASE_URL" --format=custom --file=helm-$(date +%Y%m%d).dump

# restore (DESTRUCTIVE — drops and re-creates the schema)
pg_restore --clean --if-exists --dbname="$DATABASE_URL" helm-20260811.dump
```

If you only want the structured data (skip audit + watch_runs, both
of which can grow large), filter the dump:

```bash
pg_dump "$DATABASE_URL" \
  --exclude-table=audit_log \
  --exclude-table=watch_runs \
  --format=custom \
  --file=helm-core-$(date +%Y%m%d).dump
```

The api's `files` table stores blobs on disk at the path recorded in
`files.path` — back those up separately if your workspace has heavy
file uploads. By default they're under `backend/tmp/files/`.

---

## Upgrade path

HELM's migrations are append-only and versioned. To upgrade:

```bash
cd backend
git pull
bun install
bun src/cli.ts up
```

Migrations that haven't been applied yet run automatically on boot
(see `runMigrations` in `src/db/migrate.ts`). The api is unavailable
during this window — for zero-downtime deployments, drain traffic
to a separate instance before running `up`.

If you run into a failed migration, look at
`schema_migrations.applied_at` to see which migration row got
written. The cli will refuse to re-apply a migration that's already
in `schema_migrations`, so you'll have to investigate manually if
the failure happened mid-transaction.

---

## Troubleshooting

**"ECONNREFUSED" on `bun src/cli.ts status` but postgres works.**

The cli uses the api's health endpoint for the `api` row when the
api is up, and falls back to a direct DB probe otherwise. If you
get `ECONNREFUSED` for `api`, the api server isn't running —
restart it with `bun src/cli.ts up`.

**"relation users does not exist" on first boot.**

The migrations didn't run. Either `DATABASE_URL` points at a fresh
database or the migrations dir is empty. Check
`src/db/migrations/*.sql` exists and re-run `up`.

**"permission denied for table users".**

The DB role in `DATABASE_URL` doesn't own the schema. Either grant
the role ownership or run `CREATE SCHEMA helm AUTHORIZATION <role>;`
before the first migration.

**"auto-generated secrets were lost".**

`backend/.helm-secrets` was deleted. Run `bun src/cli.ts up` once
to regenerate, then capture the new admin password from the
console. If you have existing users, reset their passwords via
`bun src/cli.ts reset-password <username>` instead — the cli will
not overwrite the existing admin on subsequent boots.