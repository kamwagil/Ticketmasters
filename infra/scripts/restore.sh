#!/bin/sh
# Restores a backup into a NEW database and runs integrity checks on it.
# Usage: restore.sh /backups/ctp-<stamp>.dump <new-database-name>
# Restore into a new database first, review the checks below, then point the API at it.
set -eu
FILE="$1"
TARGET="$2"
createdb "$TARGET"
pg_restore --no-owner --exit-on-error --dbname="$TARGET" "$FILE"
psql -d "$TARGET" -At <<'SQL'
select 'orders: ' || count(*) from orders;
select 'tickets: ' || count(*) from tickets;
select 'ledger entries: ' || count(*) from financial_ledger_entries;
select 'ledger imbalance (must be 0): ' || coalesce(sum(case when direction = 'DEBIT' then "amountMinor" else -"amountMinor" end), 0) from financial_ledger_entries;
select 'oversold categories (must be 0): ' || count(*) from ticket_inventory where sold + reserved > total;
select 'latest order: ' || coalesce(max("createdAt")::text, 'none') from orders;
SQL
