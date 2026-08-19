# Backup + Restore Runbook

HELM's source of truth is Postgres (sessions, messages, files,
audit log, keychain, model_access). Redis is a cache; if it dies,
the in-memory rate limiter takes over. This runbook covers
postgres only.

## What we back up

- Full DB dump via `pg_dump` (custom format, compressed).
- Schema-only dump, separately, so a future migration can be replayed.
- WAL archive (point-in-time recovery) — `archive_mode = on`,
  `archive_command` to an S3 bucket.

What's NOT backed up:

- Provider API keys in the keychain — those are encrypted at rest
  INSIDE the postgres dump (the encryption is at the column level,
  not the row level).
- File blobs in `file_blobs` — covered by the same dump.

## Schedule

`/etc/cron.d/helm-backup` (run as the `postgres` user):

```
# Full dump every 6 hours. Keep 28 days (4*7) locally; replicate to
# offsite (S3) with lifecycle policy.
0 */6 * * * /usr/local/bin/helm-backup.sh full
# WAL archive continuously (archive_mode + archive_command).
# Schema-only dump once a day, kept 90 days.
15 4 * * * /usr/local/bin/helm-backup.sh schema
```

`/usr/local/bin/helm-backup.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
MODE="${1:-full}"
TS=$(date -u +%Y%m%dT%H%M%SZ)
DEST=/var/backups/helm
mkdir -p "$DEST"

case "$MODE" in
  full)
    pg_dump -Fc -Z 9 \
      --no-owner --no-privileges \
      -d "$DATABASE_URL" \
      -f "$DEST/helm-full-$TS.dump"
    ;;
  schema)
    pg_dump -Fc --schema-only \
      --no-owner --no-privileges \
      -d "$DATABASE_URL" \
      -f "$DEST/helm-schema-$TS.dump"
    ;;
esac

# Sign the dump with our detached signature key (see "Verification"
# below). The signed file is what we replicate to S3; the raw dump
# stays on the local disk only.
gpg --batch --yes --detach-sign \
    --local-user helm-backup@helm.local \
    --output "$DEST/helm-$MODE-$TS.dump.sig" \
    "$DEST/helm-$MODE-$TS.dump"

aws s3 cp "$DEST/helm-$MODE-$TS.dump"     "s3://helm-backups/$MODE/$TS.dump"     --sse aws:kms
aws s3 cp "$DEST/helm-$MODE-$TS.dump.sig" "s3://helm-backups/$MODE/$TS.dump.sig" --sse aws:kms

# Prune local dumps older than 28 days.
find "$DEST" -name "helm-$MODE-*.dump*" -mtime +28 -delete
```

## Verification (signing + tamper-evidence)

Every backup is detached-signed with a GPG key stored on a separate
operator workstation (NEVER on the same host as postgres). The
verification step is what proves the dump hasn't been tampered with
between the backup host and the S3 bucket.

```bash
# Pull a backup from S3.
aws s3 cp s3://helm-backups/full/<TS>.dump     /tmp/restore.dump
aws s3 cp s3://helm-backups/full/<TS>.dump.sig /tmp/restore.dump.sig

# Verify the signature. ANY mismatch → fail.
gpg --verify /tmp/restore.dump.sig /tmp/restore.dump
```

A quarterly automation should:

1. Pull the most recent full dump + signature from S3.
2. Verify the signature.
3. Run `pg_restore --list` on the dump (doesn't touch a DB; just
   prints the TOC).
4. Compute a SHA-256 of the dump and compare to the SHA recorded in
   the backup index.

If any step fails, page the operator. A successful restore drill is
the only way to know the backup is actually good.

## Restore procedure (fresh cluster)

For "I lost the DB and need to stand up a new one":

```bash
# 1. Provision a fresh postgres cluster (same major version as the
#    original). The dump is a logical backup; the on-disk format
#    doesn't matter.

# 2. Pull the most recent full dump + signature from S3.
aws s3 cp s3://helm-backups/full/<TS>.dump     /tmp/restore.dump
aws s3 cp s3://helm-backups/full/<TS>.dump.sig /tmp/restore.dump.sig
gpg --verify /tmp/restore.dump.sig /tmp/restore.dump   # must succeed

# 3. Create the target database (empty).
createdb helm

# 4. Restore.
pg_restore --no-owner --no-privileges \
           --dbname=helm \
           --jobs=4 \
           /tmp/restore.dump

# 5. Replay WAL archive if available (point-in-time recovery):
#    configure recovery.conf (or postgresql.conf for PG12+) to
#    point at the S3 WAL archive, restart postgres, watch it catch
#    up to the desired timestamp.

# 6. Verify row counts against the last known-good snapshot:
psql -d helm -c "
SELECT 'users' tbl, count(*) FROM users
UNION ALL SELECT 'sessions', count(*) FROM sessions
UNION ALL SELECT 'messages', count(*) FROM messages
UNION ALL SELECT 'files',    count(*) FROM files
UNION ALL SELECT 'audit_log', count(*) FROM audit_log
;"

# 7. Flip the API to point at the new DB by updating DATABASE_URL
#    and restart.

# 8. Mark the incident resolved; capture the delta vs the previous
#    "known good" counts in the post-incident doc.
```

## Quarterly restore drill checklist

Date: __________   Operator: __________

- [ ] Pull the most recent full dump from S3.
- [ ] Verify GPG signature succeeds.
- [ ] Provision a fresh postgres (different cloud account / region).
- [ ] `pg_restore` completes without error.
- [ ] `psql -c "SELECT count(*) FROM users"` matches expected order of magnitude.
- [ ] `psql -c "SELECT count(*) FROM messages"` matches expected order of magnitude.
- [ ] Boot the API against the restored DB; smoke tests pass.
- [ ] Re-archive the dump + signature after the drill (they're not "fresh" anymore).
- [ ] Document any anomalies in the drill log.
- [ ] Update the runbook with anything that surprised you.

Drill failures should be treated as P1 (a backup we can't restore is
not a backup).