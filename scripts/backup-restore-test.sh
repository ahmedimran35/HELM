#!/usr/bin/env bash
# ============================================================================
# backup-restore-test.sh — verify a pg_dump round-trip restores cleanly.
# ============================================================================
#
# What it does:
#   1. `pg_dump` the *source* compose (default: localhost:5432, db `helm`).
#   2. Spin up a fresh `postgres:16` container.
#   3. Restore the dump into the fresh container.
#   4. Snapshot per-table row counts on both sides and diff them.
#   5. Drop the fresh container; print PASS or FAIL; exit 0 / 1.
#
# Use:
#   ./backup-restore-test.sh                              # default src
#   ./backup-restore-test.sh --src postgres://user:pw@h:5432/d
#   ./backup-restore-test.sh --keep                       # keep fresh container
#   ./backup-restore-test.sh --src <url> --dump /tmp/x.sql # use a pre-made dump
#
# Designed to be run from a CI step *or* from the host (where docker is
# available). Idempotent: a failure cleans up after itself unless
# --keep is set.

set -euo pipefail

SRC_URL="${HELM_DATABASE_URL:-postgres://helm:helm_dev@localhost:5432/helm}"
DUMP_FILE="$(mktemp -t helm-backup-test-XXXXXX.sql)"
FRESH_CONTAINER="helm-restore-test-$RANDOM-$RANDOM"
FRESH_PORT=55432
KEEP=0

die()  { printf '[backup-test] ERROR: %s\n' "$*" >&2; exit 1; }
log()  { printf '[backup-test] %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

usage() {
  sed -n '2,30p' "$0"
  exit 0
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --src)    SRC_URL="$2"; shift 2 ;;
    --dump)   DUMP_FILE="$2"; shift 2 ;;
    --keep)   KEEP=1; shift ;;
    -h|--help) usage ;;
    *)        die "unknown argument: $1 (try --help)" ;;
  esac
done

have docker || die "docker not in PATH"
have psql   || die "psql not in PATH (apt-get install postgresql-client)"
have pg_dump || die "pg_dump not in PATH"

cleanup() {
  local code=$?
  if [[ $KEEP -eq 0 ]]; then
    log "removing fresh container $FRESH_CONTAINER"
    docker rm -f "$FRESH_CONTAINER" >/dev/null 2>&1 || true
    if [[ -f "$DUMP_FILE" && "$DUMP_FILE" == *helm-backup-test-* ]]; then
      rm -f "$DUMP_FILE"
    fi
  fi
  exit $code
}
trap cleanup EXIT INT TERM

log "dumping source: $SRC_URL"
pg_dump --no-owner --no-privileges --clean --if-exists \
        --format=plain --quote-all-identifiers \
        "$SRC_URL" > "$DUMP_FILE"
dump_size=$(wc -c < "$DUMP_FILE")
log "dump written: $DUMP_FILE ($dump_size bytes)"

log "spinning up fresh postgres container $FRESH_CONTAINER on :$FRESH_PORT"
docker run -d --rm \
  --name "$FRESH_CONTAINER" \
  -e POSTGRES_USER=helm \
  -e POSTGRES_PASSWORD=helm_dev \
  -e POSTGRES_DB=helm \
  -p "$FRESH_PORT:5432" \
  postgres:16 >/dev/null

log "waiting for fresh container to be ready"
for i in $(seq 1 30); do
  if docker exec "$FRESH_CONTAINER" pg_isready -U helm -d helm >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker exec "$FRESH_CONTAINER" pg_isready -U helm -d helm >/dev/null \
  || die "fresh container never came up"

FRESH_URL="postgres://helm:helm_dev@localhost:$FRESH_PORT/helm"

log "restoring dump into fresh container"
psql -v ON_ERROR_STOP=1 --quiet \
     -f "$DUMP_FILE" \
     "$FRESH_URL"

# ---- Row-count diff ------------------------------------------------------
# We can't compare the *exact* set of tables between source and fresh
# (schema-only dumps won't have the same content), but for an end-to-end
# round-trip we expect every non-empty source table to be present with
# the same row count on the fresh side. Dump the counts, sort, diff.
TABLES_QUERY="
SELECT n.nspname || '.' || c.relname AS table_name,
       c.reltuples::bigint AS est_rows
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE c.relkind = 'r'
  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
  AND c.reltuples > 0
ORDER BY 1;
"

log "snapshotting row counts (source)"
psql --quiet --tuples-only --no-align \
     -c "$TABLES_QUERY" "$SRC_URL" \
     > "$DUMP_FILE.src.counts"

log "snapshotting row counts (fresh)"
psql --quiet --tuples-only --no-align \
     -c "$TABLES_QUERY" "$FRESH_URL" \
     > "$DUMP_FILE.fresh.counts"

log "diffing row counts"
if diff -u "$DUMP_FILE.src.counts" "$DUMP_FILE.fresh.counts"; then
  log "PASS: row counts match between source and fresh restore"
  echo "[backup-test] OK"
  exit 0
else
  die "FAIL: row counts differ between source and fresh restore (see diff above)"
fi