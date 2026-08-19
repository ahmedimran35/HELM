# Recovery runbook

Use this when something has gone wrong at the deployment / data
layer and you need to get back to a known-good state without
losing more than you have to.

## 1. Identify the last known-good state

```bash
# What was the last successful deploy?
git log --oneline --decorate -20

# What was the last successful CI run?
gh run list --workflow=ci --status=success --limit=5

# What was the last successful DB migration?
docker compose exec postgres psql -U helm -d helm \
  -c "SELECT version, applied_at FROM schema_migrations ORDER BY applied_at DESC LIMIT 5;"
```

## 2. Rollback the api (image)

The fastest recovery is to redeploy the previous image tag.

```bash
# Pin the previous tag. (Adjust to your registry / tag scheme.)
PREVIOUS_TAG="helm-api:$(git rev-parse --short HEAD~1)"
docker compose pull api   # if using a remote registry
docker tag "${PREVIOUS_TAG}" helm-api:current
docker compose up -d --no-deps api
```

Verify:

```bash
curl -fsS http://localhost:3000/api/health
docker compose logs --tail=50 api | grep "listening on"
```

## 3. Rollback a migration (last resort)

Schema rollbacks are dangerous — only do this if the migration
caused the outage AND no data has been written under the new schema.

```bash
# 1. Stop the api so it can't write against the broken schema.
docker compose stop api

# 2. Run the down migration. Each migration ships a `down()` —
#    if it doesn't, you have to write one manually.
docker compose run --rm api bun src/db/migrate.ts down

# 3. Restart the api.
docker compose up -d api

# 4. Audit-log the rollback so the next on-call knows.
echo "$(date -u) — rolled back migration $(MIGRATION_ID)" \
  >> /var/log/helm/ops.log
```

## 4. Restore from backup (catastrophic)

If the DB is corrupted, restore from the last daily snapshot.

```bash
# 1. List available snapshots.
aws rds describe-db-snapshots --db-instance-identifier helm-prod \
  --query 'DBSnapshots[?Status==`available`].[DBSnapshotIdentifier,SnapshotCreateTime]' \
  --output table

# 2. Pick the snapshot and restore to a NEW instance.
#    DO NOT overwrite the live instance — restore alongside so you
#    can validate before cutover.
NEW_INSTANCE="helm-recovery-$(date +%s)"
aws rds restore-db-instance-from-db-snapshot \
  --db-instance-identifier "${NEW_INSTANCE}" \
  --db-snapshot-identifier "<snapshot-id>"

# 3. Wait for the new instance to be available.
aws rds wait db-instance-available --db-instance-identifier "${NEW_INSTANCE}"

# 4. Cut over by updating DATABASE_URL and bouncing the api.
#    Coordinate this with the Comms Lead — it's a user-visible
#    outage.
```

## 5. Post-recovery

1. Verify the fix is actually working — don't trust the "it boots"
   signal alone.
2. Capture the timeline (when it broke, when you noticed, when you
   fixed it) for the post-mortem.
3. If you had to restore from backup, audit for data loss between
   the snapshot time and the cutover time.
4. File the post-mortem within 7 days.
