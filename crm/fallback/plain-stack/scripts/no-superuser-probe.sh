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

# One pass: fresh probe database and role, platform steps, shim, migrations.
#   $1 = pass name (A, B); $2 = "bypassrls" to give the role BYPASSRLS (Supabase's
#   own postgres role has it; whether a managed database's master user can hold
#   it is not verified here).
probe_pass() {
  local pass="$1" bypass="${2:-}"
  local dir="$work/$pass"
  mkdir -p "$dir"
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
  if [ "$bypass" = bypassrls ]; then
    psql "$admin" -X -q -v ON_ERROR_STOP=1 -c 'alter role plain_probe_owner bypassrls' > /dev/null
  fi

  # Platform step: auth and storage schemas as the services created them.
  "${compose[@]}" exec -T db pg_dump -U postgres -d postgres --schema-only -n auth -n storage --no-publications --no-subscriptions \
    > "$dir/auth-storage.sql"
  psql "$probe_admin" -X -q -v ON_ERROR_STOP=0 -f "$dir/auth-storage.sql" > /dev/null 2> "$dir/platform.err"
  psql "$probe_admin" -X -q -v ON_ERROR_STOP=1 <<'SQL' 2>> "$dir/platform.err"
grant usage on schema auth, storage to plain_probe_owner;
grant all on all tables in schema auth, storage to plain_probe_owner;
grant all on all sequences in schema auth, storage to plain_probe_owner;
grant all on all routines in schema auth, storage to plain_probe_owner;
grant anon, authenticated, service_role to plain_probe_owner with admin option;
SQL

  # The shim as the probe role, statement by statement (its own
  # "\set ON_ERROR_STOP on" line removed for this run).
  grep -v '^\\set ON_ERROR_STOP' "$here/shim/10-before-services.sql" > "$dir/shim1.sql"
  psql "$probe" -X -v ON_ERROR_STOP=0 -v VERBOSITY=verbose -v svc_password=probe-not-used \
    -f "$dir/shim1.sql" > /dev/null 2> "$dir/shim.err"
  grep -v '^\\set ON_ERROR_STOP' "$here/shim/20-after-services.sql" > "$dir/shim2.sql"
  psql "$probe" -X -v ON_ERROR_STOP=0 -v VERBOSITY=verbose -f "$dir/shim2.sql" > /dev/null 2> "$dir/shim2.err"

  # Can this role create a BYPASSRLS role (service_role needs one)?
  psql "$probe" -X -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
    -c 'create role plain_probe_bypass nologin bypassrls' > /dev/null 2> "$dir/bypass.err"
  echo "$?" > "$dir/bypass.rc"
  psql "$admin" -X -q -c 'drop role if exists plain_probe_bypass' > /dev/null 2>&1 || true

  # Migrations as the probe role: first failure of each file, then the next file.
  : > "$dir/migrations.tsv"
  total=0
  for file in $(find "$migrations" -maxdepth 1 -name '*.sql' -printf '%f\n' | LC_ALL=C sort); do
    total=$((total + 1))
    if ! psql "$probe" -X -q -v ON_ERROR_STOP=1 -v VERBOSITY=verbose -f "$migrations/$file" > /dev/null 2> "$dir/m.err"; then
      code="$(grep -oE 'ERROR: +[0-9A-Z]{5}' "$dir/m.err" | head -1 | grep -oE '[0-9A-Z]{5}$' || true)"
      msg="$(grep -m1 -E 'ERROR:' "$dir/m.err" | sed -E 's/^.*ERROR: +([0-9A-Z]{5}: )?//' | tr '\t' ' ' | cut -c1-240)"
      printf '%s\t%s\t%s\n' "$file" "${code:-?}" "$msg" >> "$dir/migrations.tsv"
    fi
  done
  echo "$total" > "$dir/total"
}

probe_pass A
probe_pass B bypassrls

node --input-type=module - "$work" "$out" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const [work, out] = process.argv.slice(2);
function pass(name, role) {
  const dir = join(work, name);
  const errors = (file) => readFileSync(join(dir, file), 'utf8').split('\n')
    .filter((l) => /ERROR:/.test(l))
    .map((l) => l.replace(/^.*ERROR: +/, '').slice(0, 240));
  const failed = readFileSync(join(dir, 'migrations.tsv'), 'utf8').split('\n').filter(Boolean)
    .map((l) => { const [file, sqlstate, message] = l.split('\t'); return { file, sqlstate, message }; });
  const bySqlstate = {};
  for (const f of failed) bySqlstate[f.sqlstate] = (bySqlstate[f.sqlstate] ?? 0) + 1;
  return {
    role,
    platformStepErrors: errors('platform.err'),
    shimPart1Errors: errors('shim.err'),
    shimPart2Errors: errors('shim2.err'),
    createBypassRlsRole: { ok: readFileSync(join(dir, 'bypass.rc'), 'utf8').trim() === '0', errors: errors('bypass.err') },
    migrations: { total: Number(readFileSync(join(dir, 'total'), 'utf8')), failedFiles: failed.length, bySqlstate, firstFailure: failed[0] ?? null, failed },
  };
}
const A = pass('A', 'plain_probe_owner: LOGIN CREATEROLE CREATEDB, not superuser, no BYPASSRLS');
const B = pass('B', 'plain_probe_owner: the same plus BYPASSRLS (as Supabase\'s own postgres role)');
// Top-level fields of pass A kept for the report job.
writeFileSync(out, `${JSON.stringify({ ...A, passA: A, passB: B }, null, 2)}\n`);
for (const [name, r] of [['A', A], ['B', B]]) {
  console.log(`P9 pass ${name} (${r.role}): shim part 1 errors ${r.shimPart1Errors.length}, part 2 errors ${r.shimPart2Errors.length}, `
    + `bypassrls role creation ${r.createBypassRlsRole.ok ? 'allowed' : 'refused'}, migrations failing ${r.migrations.failedFiles} of ${r.migrations.total}`);
  for (const f of r.migrations.failed.slice(0, 15)) console.log(`  ${f.file}: ${f.sqlstate} ${f.message}`);
}
NODE
psql "$admin" -X -q -c 'drop database if exists plain_probe' > /dev/null 2>&1 || true
psql "$admin" -X -q -c 'drop owned by plain_probe_owner cascade' > /dev/null 2>&1 || true
psql "$admin" -X -q -c 'drop role if exists plain_probe_owner' > /dev/null 2>&1 || true
exit 0
