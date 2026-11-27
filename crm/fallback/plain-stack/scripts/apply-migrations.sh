#!/usr/bin/env bash
# Applies crm/supabase/migrations/*.sql to the plain stack without the
# Supabase CLI (contract file 12, section 3.4): file-name order, each file sent
# whole with `psql -v ON_ERROR_STOP=1 -f`, as the database owner. The same
# order and granularity as the in-memory test path (tests/helpers/db.ts).
# Each applied file and its SHA-256 are recorded in plain_meta.applied_migrations
# (outside the fingerprinted schemas). The first failure stops the run and is
# reported with the file name and SQLSTATE.
#
# Usage: apply-migrations.sh <database-url> <result.json> [migrations-dir]
set -uo pipefail

db="$1"
result="$2"
dir="${3:-$(cd "$(dirname "$0")/../../../supabase/migrations" && pwd)}"
log="$(dirname "$result")/migrations-psql.log"
: > "$log"

psql "$db" -q -v ON_ERROR_STOP=1 <<'SQL' || { echo "::error title=migrations::could not create plain_meta"; exit 1; }
create schema if not exists plain_meta;
revoke all on schema plain_meta from public;
create table if not exists plain_meta.applied_migrations (
  file text primary key,
  sha256 text not null,
  applied_at timestamptz not null default now(),
  seconds numeric not null
);
SQL

mapfile -t files < <(find "$dir" -maxdepth 1 -name '*.sql' -printf '%f\n' | LC_ALL=C sort)
total=${#files[@]}
applied=0
failed_file=""
sqlstate=""
message=""
started=$SECONDS
for file in "${files[@]}"; do
  sum="$(sha256sum "$dir/$file" | cut -d' ' -f1)"
  t0=$(date +%s%3N)
  if ! psql "$db" -q -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -f "$dir/$file" > /dev/null 2> "$log.current"; then
    cat "$log.current" >> "$log"
    failed_file="$file"
    sqlstate="$(grep -oE 'ERROR: +[0-9A-Z]{5}' "$log.current" | head -1 | grep -oE '[0-9A-Z]{5}$' || true)"
    message="$(grep -m1 -E 'ERROR:' "$log.current" | sed -E 's/^.*ERROR: +([0-9A-Z]{5}: )?//' | cut -c1-300)"
    echo "::error title=migrations::$file failed: SQLSTATE ${sqlstate:-?} ${message}"
    tail -30 "$log.current"
    break
  fi
  cat "$log.current" >> "$log"
  ms=$(( $(date +%s%3N) - t0 ))
  # Variables are interpolated only in psql input (not with -c), hence stdin.
  psql "$db" -q -X -v ON_ERROR_STOP=1 -v file="$file" -v sum="$sum" -v ms="$ms" > /dev/null <<'SQL'
insert into plain_meta.applied_migrations (file, sha256, seconds) values (:'file', :'sum', :'ms'::numeric / 1000)
on conflict (file) do update set sha256 = excluded.sha256, applied_at = now(), seconds = excluded.seconds;
SQL
  applied=$((applied + 1))
done
rm -f "$log.current"

node --input-type=module -e '
  import { writeFileSync } from "node:fs";
  const [out, total, applied, failedFile, sqlstate, message, seconds] = process.argv.slice(1);
  writeFileSync(out, JSON.stringify({
    total: Number(total), applied: Number(applied), failedFile: failedFile || null,
    sqlstate: sqlstate || null, message: message || null, seconds: Number(seconds),
  }, null, 2) + "\n");
' "$result" "$total" "$applied" "$failed_file" "$sqlstate" "$message" "$(( SECONDS - started ))"

echo "migrations: $applied of $total applied in $(( SECONDS - started )) s"
if [ -n "$failed_file" ] || [ "$applied" -ne "$total" ]; then exit 1; fi
