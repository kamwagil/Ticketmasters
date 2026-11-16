#!/bin/sh
# Logical backup of the platform database (custom format, compressed). Runs on a schedule in the
# "backup" service. Copy /backups off the host (object storage in another region) for disaster recovery.
set -eu
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
FILE="/backups/ctp-${STAMP}.dump"
pg_dump --format=custom --compress=6 --no-owner --file="${FILE}.partial"
mv "${FILE}.partial" "$FILE"
# A backup that cannot be read is not a backup: check that the archive lists cleanly.
pg_restore --list "$FILE" > /dev/null
find /backups -name 'ctp-*.dump' -mtime +"${BACKUP_KEEP_DAYS:-14}" -delete
echo "backup ok: $FILE ($(du -h "$FILE" | cut -f1))"
