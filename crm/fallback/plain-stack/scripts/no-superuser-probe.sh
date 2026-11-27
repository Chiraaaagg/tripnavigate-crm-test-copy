#!/usr/bin/env bash
# Proof P9 (information only; contract file 12, section 4.2): re-apply the shim
# and the 225 migrations on a second, empty database as a role that is NOT a
# superuser (LOGIN CREATEROLE CREATEDB only), and list every statement that
# fails. A managed database (for example RDS) gives its master user roughly
# this; the real permission model there is not tested here.
#
# Platform steps done first as the superuser, standing in for what the
# platform and the two services do on a managed database:
#   - the auth and storage schemas are copied (schema only) from the main
#     database, where GoTrue and storage-api created them;
#   - the probe role gets what Supabase gives its postgres role on those
#     schemas, and membership of the three API roles WITH ADMIN OPTION.
#
# Usage: no-superuser-probe.sh <out.json>   (needs PLAIN_ADMIN_DB_URL,
# PLAIN_PROBE_PASSWORD; run from crm/ with the plain stack up)
set -uo pipefail

out="$1"
here="$(cd "$(dirname "$0")/.." && pwd)"
migrations="$(cd "$here/../../supabase/migrations" && pwd)"
compose=(docker compose -f "$here/compose.yml")
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
admin="${PLAIN_ADMIN_DB_URL:?}"
probe_admin="${admin%/postgres}/plain_probe"
probe="postgres://plain_probe_owner:${PLAIN_PROBE_PASSWORD:?}@127.0.0.1:55432/plain_probe"

psql "$admin" -X -q -v ON_ERROR_STOP=1 -v pw="$PLAIN_PROBE_PASSWORD" <<'SQL'
drop database if exists plain_probe;
do $$ begin
  if exists (select from pg_roles where rolname = 'plain_probe_owner') then
    execute 'drop owned by plain_probe_owner cascade';
    execute 'drop role plain_probe_owner';
  end if;
end $$;
create role plain_probe_owner login createrole createdb nosuperuser nobypassrls;
alter role plain_probe_owner password :'pw';
create database plain_probe owner plain_probe_owner;
SQL

# Platform step 1: auth and storage schemas as the services created them.
"${compose[@]}" exec -T db pg_dump -U postgres -d postgres --schema-only -n auth -n storage --no-publications --no-subscriptions \
  > "$work/auth-storage.sql"
psql "$probe_admin" -X -q -v ON_ERROR_STOP=0 -f "$work/auth-storage.sql" > /dev/null 2> "$work/platform.err"
psql "$probe_admin" -X -q -v ON_ERROR_STOP=1 <<'SQL' 2>> "$work/platform.err"
grant usage on schema auth, storage to plain_probe_owner;
grant all on all tables in schema auth, storage to plain_probe_owner;
grant all on all sequences in schema auth, storage to plain_probe_owner;
grant all on all routines in schema auth, storage to plain_probe_owner;
grant anon, authenticated, service_role to plain_probe_owner with admin option;
SQL

# The shim as the probe role, statement by statement (no stop on error; the
# shim's own "\set ON_ERROR_STOP on" line is removed for this run).
grep -v '^\\set ON_ERROR_STOP' "$here/shim/10-before-services.sql" > "$work/shim1.sql"
psql "$probe" -X -v ON_ERROR_STOP=0 -v VERBOSITY=verbose -v svc_password=probe-not-used \
  -f "$work/shim1.sql" > /dev/null 2> "$work/shim.err"
grep -v '^\\set ON_ERROR_STOP' "$here/shim/20-after-services.sql" > "$work/shim2.sql"
psql "$probe" -X -v ON_ERROR_STOP=0 -v VERBOSITY=verbose -f "$work/shim2.sql" > /dev/null 2> "$work/shim2.err"

# Explicit check: can a non-superuser create a BYPASSRLS role (service_role needs one)?
psql "$probe" -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
  -c 'create role plain_probe_bypass nologin bypassrls' > /dev/null 2> "$work/bypass.err"
echo "$?" > "$work/bypass.rc"
psql "$admin" -X -q -c 'drop role if exists plain_probe_bypass' > /dev/null 2>&1 || true

# Migrations as the probe role: first failure of each file, then the next file.
: > "$work/migrations.tsv"
total=0
for file in $(find "$migrations" -maxdepth 1 -name '*.sql' -printf '%f\n' | LC_ALL=C sort); do
  total=$((total + 1))
  if ! psql "$probe" -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -f "$migrations/$file" > /dev/null 2> "$work/m.err"; then
    code="$(grep -oE 'ERROR: +[0-9A-Z]{5}' "$work/m.err" | head -1 | grep -oE '[0-9A-Z]{5}$' || true)"
    msg="$(grep -m1 -E 'ERROR:' "$work/m.err" | sed -E 's/^.*ERROR: +([0-9A-Z]{5}: )?//' | tr '\t' ' ' | cut -c1-240)"
    printf '%s\t%s\t%s\n' "$file" "${code:-?}" "$msg" >> "$work/migrations.tsv"
  fi
done

node --input-type=module - "$work" "$out" "$total" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [work, out, total] = process.argv.slice(2);
const errors = (file) => readFileSync(join(work, file), 'utf8').split('\n')
  .filter((l) => /ERROR:/.test(l))
  .map((l) => l.replace(/^.*ERROR: +/, '').slice(0, 240));
const failed = readFileSync(join(work, 'migrations.tsv'), 'utf8').split('\n').filter(Boolean)
  .map((l) => { const [file, sqlstate, message] = l.split('\t'); return { file, sqlstate, message }; });
const bySqlstate = {};
for (const f of failed) bySqlstate[f.sqlstate] = (bySqlstate[f.sqlstate] ?? 0) + 1;
const result = {
  role: 'plain_probe_owner (LOGIN CREATEROLE CREATEDB, not superuser, no BYPASSRLS)',
  platformStepErrors: errors('platform.err'),
  shimPart1Errors: errors('shim.err'),
  shimPart2Errors: errors('shim2.err'),
  createBypassRlsRole: { ok: readFileSync(join(work, 'bypass.rc'), 'utf8').trim() === '0', errors: errors('bypass.err') },
  migrations: { total: Number(total), failedFiles: failed.length, bySqlstate, failed },
};
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(`P9 no-superuser probe: shim part 1 errors ${result.shimPart1Errors.length}, part 2 errors ${result.shimPart2Errors.length}, `
  + `bypassrls role creation ${result.createBypassRlsRole.ok ? 'allowed' : 'refused'}, migrations failing ${failed.length} of ${total}`);
for (const f of failed.slice(0, 25)) console.log(`  ${f.file}: ${f.sqlstate} ${f.message}`);
NODE

psql "$admin" -X -q -c 'drop database if exists plain_probe' > /dev/null 2>&1 || true
psql "$admin" -X -q -c 'drop owned by plain_probe_owner cascade' > /dev/null 2>&1 || true
psql "$admin" -X -q -c 'drop role if exists plain_probe_owner' > /dev/null 2>&1 || true
exit 0
