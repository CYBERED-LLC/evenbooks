#!/usr/bin/env bash
# Backup + restore exercise. Dumps the local `evenbooks` database, restores it into a
# fresh database under a new name, copies the object store, and verifies ledger
# invariants and attachment presence in the restored copy.
#
# Requires: pg_dump/pg_restore/psql 15+, DATABASE_ADMIN_URL (superuser), the
# repo .env. Safe to run repeatedly; the restored database is dropped at the end
# unless KEEP_RESTORED=1.
set -euo pipefail
cd "$(dirname "$0")/.."
set -a; . ./.env; set +a

SRC_DB="${EVENBOOKS_DB_NAME:-evenbooks}"
DEST_DB="${SRC_DB}_restore_$(date +%s)"
ADMIN="${DATABASE_ADMIN_URL:?DATABASE_ADMIN_URL required}"
OWNER_PW="${EVENBOOKS_OWNER_PASSWORD:-evenbooks_owner}"
APP_PW="${EVENBOOKS_APP_PASSWORD:-evenbooks_app}"
STORAGE_SRC="${STORAGE_LOCAL_DIR:-./.data/storage}"
STORAGE_DEST="./.data/storage-restore-$(date +%s)"
DUMP="./.data/backup-${SRC_DB}-$(date +%F-%H%M%S).dump"
mkdir -p ./.data

admin_db_url() { python3 - "$ADMIN" "$1" <<'EOF'
import sys
from urllib.parse import urlsplit, urlunsplit
u = urlsplit(sys.argv[1]); print(urlunsplit((u.scheme, u.netloc, '/' + sys.argv[2], u.query, u.fragment)))
EOF
}
role_url() { python3 - "$1" "$2" "$3" "$4" <<'EOF'
import sys
from urllib.parse import urlsplit, urlunsplit
u = urlsplit(sys.argv[1]); host = u.hostname + (f":{u.port}" if u.port else "")
print(urlunsplit((u.scheme, f"{sys.argv[3]}:{sys.argv[4]}@{host}", '/' + sys.argv[2], '', '')))
EOF
}

echo "1/5 dumping ${SRC_DB} -> ${DUMP}"
# pgboss (queue state) is excluded: it is operational, not financial, and the worker recreates it.
pg_dump --format=custom --no-owner --no-privileges --no-comments --exclude-schema=pgboss "$(admin_db_url "$SRC_DB")" > "$DUMP"
ls -la "$DUMP"

echo "2/5 creating ${DEST_DB} and bootstrapping roles"
psql "$ADMIN" -qc "create database \"${DEST_DB}\" owner evenbooks_owner"
psql "$(admin_db_url "$DEST_DB")" -qc "alter schema public owner to evenbooks_owner; grant usage on schema public to evenbooks_app; create extension if not exists btree_gist; create schema if not exists pgboss authorization evenbooks_app; grant create on database \"${DEST_DB}\" to evenbooks_app;"

echo "3/5 restoring as evenbooks_owner"
pg_restore --no-owner --no-privileges --dbname "$(role_url "$ADMIN" "$DEST_DB" evenbooks_owner "$OWNER_PW")" "$DUMP"
psql "$(role_url "$ADMIN" "$DEST_DB" evenbooks_owner "$OWNER_PW")" -qc "set client_min_messages = error; select app.grant_app_privileges();"

echo "4/5 copying objects ${STORAGE_SRC} -> ${STORAGE_DEST}"
mkdir -p "$STORAGE_DEST"
if [ -d "$STORAGE_SRC" ]; then rsync -a "$STORAGE_SRC/" "$STORAGE_DEST/"; fi

echo "5/5 verifying restored ledger (as superuser, bypassing RLS for the audit)"
psql "$(admin_db_url "$DEST_DB")" -v ON_ERROR_STOP=1 <<'SQL'
\echo -- posted entries that do not balance (must be 0):
select count(*) as unbalanced from (
  select e.id from journal_entries e join journal_lines l on l.entry_id = e.id
  where e.status = 'posted' group by e.id having sum(l.debit) <> sum(l.credit)) x;
\echo -- trial balance difference per company (must be 0):
select l.company_id, sum(l.debit) - sum(l.credit) as diff from journal_lines l join journal_entries e on e.id = l.entry_id where e.status='posted' group by l.company_id;
\echo -- invoices whose balance disagrees with allocations (must be 0):
select count(*) as inconsistent from invoices i where i.status in ('issued','paid')
  and i.amount_settled <> coalesce((select sum(amount) from payment_allocations a where a.invoice_id = i.id and a.status = 'active'), 0);
\echo -- counts:
select (select count(*) from companies) companies, (select count(*) from journal_entries) entries, (select count(*) from invoices) invoices, (select count(*) from attachments where status='uploaded') attachments;
SQL

echo "-- attachment objects present in the restored store:"
MISSING=0; TOTAL=0
while IFS= read -r key; do
  TOTAL=$((TOTAL+1))
  [ -f "$STORAGE_DEST/$key" ] || { MISSING=$((MISSING+1)); echo "missing: $key"; }
done < <(psql "$(admin_db_url "$DEST_DB")" -At -c "select object_key from attachments where status='uploaded'")
echo "attachments checked: $TOTAL, missing: $MISSING"
[ "$MISSING" -eq 0 ] || { echo "RESTORE VERIFICATION FAILED"; exit 1; }

echo "-- application-role access through RLS in the restored database (must return 0 rows without context):"
psql "$(role_url "$ADMIN" "$DEST_DB" evenbooks_app "$APP_PW")" -Atc "select count(*) from accounts"

if [ "${KEEP_RESTORED:-0}" != "1" ]; then
  psql "$ADMIN" -qc "drop database \"${DEST_DB}\""
  rm -rf "$STORAGE_DEST"
  echo "restored copy dropped (set KEEP_RESTORED=1 to keep ${DEST_DB})"
else
  echo "kept ${DEST_DB} and ${STORAGE_DEST}"
fi
echo "RESTORE EXERCISE OK"
