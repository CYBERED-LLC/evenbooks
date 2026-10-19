#!/bin/sh
# One backup run, then exit (Railway cron). Dumps the production database and copies the
# production file bucket into the backup bucket. Any failure exits non-zero so the run shows
# as failed in Railway.
#
# Required variables:
#   SOURCE_DATABASE_URL   production Postgres through its TCP proxy, as the read-only
#                         evenbooks_backup role, with sslmode=require
#   SOURCE_S3_*           production `files` bucket (BUCKET, ACCESS_KEY_ID, SECRET_ACCESS_KEY, ENDPOINT, REGION)
#   BACKUP_S3_*           the backup bucket in this environment (same five)
# Optional: DAILY_RETENTION (default 35d), MONTHLY_RETENTION (default 400d).
set -eu
export RCLONE_CONFIG=/tmp/rclone.conf; : > "$RCLONE_CONFIG"   # remotes come from the environment

log() { echo "$(date -u +%FT%TZ) $*"; }

remote() { # remote <NAME> <PREFIX>: configure an rclone S3 remote from <PREFIX>_* variables
  eval "export RCLONE_CONFIG_$1_TYPE=s3 RCLONE_CONFIG_$1_PROVIDER=Other RCLONE_CONFIG_$1_FORCE_PATH_STYLE=false \
    RCLONE_CONFIG_$1_ACCESS_KEY_ID=\"\$$2_ACCESS_KEY_ID\" RCLONE_CONFIG_$1_SECRET_ACCESS_KEY=\"\$$2_SECRET_ACCESS_KEY\" \
    RCLONE_CONFIG_$1_ENDPOINT=\"\$$2_ENDPOINT\" RCLONE_CONFIG_$1_REGION=\"\$$2_REGION\""
}
remote SRC SOURCE_S3
remote DST BACKUP_S3
DST="DST:${BACKUP_S3_BUCKET}"
: "${SOURCE_DATABASE_URL:?}" "${SOURCE_S3_BUCKET:?}" "${BACKUP_S3_BUCKET:?}"

stamp=$(date -u +%Y-%m-%dT%H%MZ)
file="/tmp/evenbooks-${stamp}.dump"

log "dumping database"
# Same flags as scripts/restore-exercise.sh: pgboss is queue state the worker recreates.
pg_dump --format=custom --no-owner --no-privileges --no-comments --exclude-schema=pgboss \
  --dbname "$SOURCE_DATABASE_URL" --file "$file"
pg_restore --list "$file" > /tmp/toc.txt   # proves the archive is readable
tables=$(grep -c ' TABLE DATA ' /tmp/toc.txt || true)
[ "$tables" -gt 0 ] || { log "dump has no table data"; exit 1; }
size=$(stat -c %s "$file")
sum=$(sha256sum "$file" | cut -d' ' -f1)
log "dump ok: ${size} bytes, ${tables} tables, sha256 ${sum}"

# Restore into a throwaway local server and check the ledger (same checks as
# scripts/restore-exercise.sh), so a dump is only uploaded once it is known to restore.
log "verifying restore"
V=/tmp/verify; mkdir -p "$V"; chown postgres "$V"
su-exec postgres initdb -D "$V/data" -U postgres --auth=trust --no-locale -E UTF8 >/dev/null
su-exec postgres pg_ctl -D "$V/data" -o "-c listen_addresses='' -k $V" -w start >/dev/null
L="host=$V user=postgres"
psql "$L dbname=postgres" -qv ON_ERROR_STOP=1 -c "create role evenbooks_owner nologin" -c "create role evenbooks_app nologin" -c "create database verify owner evenbooks_owner"
psql "$L dbname=verify" -qv ON_ERROR_STOP=1 -c "create extension if not exists btree_gist"
pg_restore --no-owner --no-privileges --exit-on-error --dbname "$L dbname=verify" "$file"
check=$(psql "$L dbname=verify" -Atv ON_ERROR_STOP=1 <<'SQL'
select (select count(*) from (select e.id from journal_entries e join journal_lines l on l.entry_id = e.id
          where e.status = 'posted' group by e.id having sum(l.debit) <> sum(l.credit)) x)
     + (select count(*) from (select l.company_id from journal_lines l join journal_entries e on e.id = l.entry_id
          where e.status = 'posted' group by l.company_id having sum(l.debit) <> sum(l.credit)) y)
     + (select count(*) from invoices i where i.status in ('issued','paid') and i.amount_settled <>
          coalesce((select sum(amount) from payment_allocations a where a.invoice_id = i.id and a.status = 'active'), 0));
SQL
)
counts=$(psql "$L dbname=verify" -At -c "select format('companies=%s entries=%s invoices=%s', (select count(*) from companies), (select count(*) from journal_entries), (select count(*) from invoices))")
psql "$L dbname=verify" -At -c "select object_key from attachments where status = 'uploaded'" > /tmp/attachments.txt
su-exec postgres pg_ctl -D "$V/data" -m fast -w stop >/dev/null
[ "$check" = "0" ] || { log "restored ledger is inconsistent ($check problems)"; exit 1; }
log "restore ok: $counts"

rclone copyto "$file" "${DST}/db/daily/$(basename "$file")"
if [ "$(date -u +%d)" = "01" ]; then
  rclone copyto "$file" "${DST}/db/monthly/$(basename "$file")"
fi
rclone delete --min-age "${DAILY_RETENTION:-35d}" "${DST}/db/daily"
rclone delete --min-age "${MONTHLY_RETENTION:-400d}" "${DST}/db/monthly"

log "copying file bucket"
# copy, not sync: an object deleted in production stays in the backup.
rclone copy "SRC:${SOURCE_S3_BUCKET}" "${DST}/files" --checksum --transfers 8
rclone lsf -R --files-only "${DST}/files" | sort > /tmp/objects.txt
missing=$(sort /tmp/attachments.txt | comm -23 - /tmp/objects.txt | wc -l)
[ "$missing" -eq 0 ] || { log "$missing attachment objects missing from the backup"; exit 1; }
log "files ok: $(wc -l < /tmp/attachments.txt) attachments present"

printf '{"finishedAt":"%s","dump":"db/daily/%s","bytes":%s,"sha256":"%s","tables":%s,"counts":"%s"}\n' \
  "$(date -u +%FT%TZ)" "$(basename "$file")" "$size" "$sum" "$tables" "$counts" > /tmp/latest.json
rclone copyto /tmp/latest.json "${DST}/latest.json"
log "backup complete"
