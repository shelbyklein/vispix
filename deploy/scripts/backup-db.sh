#!/usr/bin/env bash
# Nightly Postgres backup for the Vispix droplet (#163). Dumps the prod DB from
# the running postgres container to /opt/vispix/backups and keeps the last N
# days. Run from cron:
#   0 4 * * * /opt/vispix/deploy/scripts/backup-db.sh >> /var/log/vispix-backup.log 2>&1
#
# This protects against logical corruption / a bad migration / accidental
# deletes. For droplet-loss protection, also enable DigitalOcean snapshots
# (control panel) and/or push these dumps off-site (GCS) — see DEPLOY.md.
set -euo pipefail

BACKUP_DIR="${BACKUP_DIR:-/opt/vispix/backups}"
KEEP_DAYS="${KEEP_DAYS:-7}"
CONTAINER="${CONTAINER:-vispix-postgres-1}"
DB="${DB:-vispix}"
DB_USER="${DB_USER:-vispix}"

mkdir -p "$BACKUP_DIR"
ts="$(date -u +%Y%m%d-%H%M%S)"
out="$BACKUP_DIR/vispix-$ts.dump"

# Custom-format (compressed, pg_restore-friendly) dump written INSIDE the
# container, then copied out with docker cp so binary bytes aren't mangled.
docker exec "$CONTAINER" pg_dump -U "$DB_USER" -d "$DB" -Fc -f /tmp/vispix.dump
docker cp "$CONTAINER:/tmp/vispix.dump" "$out"
docker exec "$CONTAINER" rm -f /tmp/vispix.dump

# Rotate: drop dumps older than KEEP_DAYS.
find "$BACKUP_DIR" -name 'vispix-*.dump' -mtime "+$KEEP_DAYS" -delete

echo "$(date -u +%FT%TZ) backup ok: $out ($(du -h "$out" | cut -f1))"
