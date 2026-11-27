#!/usr/bin/env bash
# Starts the plain stack in the order of contract file 12, section 3.2:
#   Postgres -> shim part 1 -> GoTrue (own migrations) -> storage-api (own
#   migrations, S3 stand-in first) -> shim part 2 -> the CRM migrations ->
#   PostgREST -> front door.
# Seeding is the workflow's next step (scripts/seed-local.mjs, unchanged).
#
# CI only (GitHub Actions runner). Needs the values from mint-keys.mjs in the
# environment. Usage (from crm/):
#   bash fallback/plain-stack/scripts/up.sh [output-dir]
# Writes <output-dir>/timings.json, migrations.json, shim-notices.txt.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd)"
out="${1:-test-results/plain}"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
compose=(docker compose -f "$here/compose.yml")

for name in PLAIN_DB_PASSWORD PLAIN_SVC_DB_PASSWORD PLAIN_JWT_SECRET PLAIN_ANON_KEY PLAIN_SERVICE_KEY \
  PLAIN_S3_ACCESS_KEY PLAIN_S3_SECRET_KEY PLAIN_ADMIN_DB_URL; do
  if [ -z "${!name:-}" ]; then echo "::error title=plain stack::$name is missing (run mint-keys.mjs first)"; exit 1; fi
done

timings="$out/timings.tsv"
: > "$timings"
start_all=$SECONDS
mark() { echo -e "$1\t$(( SECONDS - start_all ))" >> "$timings"; echo "== $1 (+$(( SECONDS - start_all )) s)"; }

logs_and_fail() {
  echo "::error title=plain stack::$1"
  "${compose[@]}" ps -a || true
  for service in "${@:2}"; do
    echo "---- last log lines of $service"
    "${compose[@]}" logs --no-color --tail 80 "$service" || true
  done
  exit 1
}

wait_http() { # name url tries [expected-status-regex] [extra curl args...]
  local name="$1" url="$2" tries="$3" want="${4:-^[23]}"
  shift 4 || shift $#
  local code=""
  for _ in $(seq 1 "$tries"); do
    code="$(curl -s -o /dev/null -w '%{http_code}' "$@" "$url" || true)"
    if [[ "$code" =~ $want ]]; then echo "$name ready (HTTP $code)"; return 0; fi
    sleep 2
  done
  echo "$name not ready: last HTTP status $code"
  return 1
}

# Image pulls: Docker Hub anonymous limits can refuse a pull; retry slowly, as
# scripts/ci/supabase-start.sh does for the CLI stack.
for attempt in 1 2 3; do
  if "${compose[@]}" pull --quiet; then break; fi
  if [ "$attempt" = 3 ]; then echo "::error title=plain stack::image pull failed 3 times"; exit 1; fi
  echo "::warning title=plain stack::image pull attempt $attempt failed; retrying"
  sleep $(( attempt * 45 ))
done
mark pulled

"${compose[@]}" up -d db
for _ in $(seq 1 60); do
  if psql "$PLAIN_ADMIN_DB_URL" -Atc 'select 1' > /dev/null 2>&1; then break; fi
  sleep 1
done
psql "$PLAIN_ADMIN_DB_URL" -Atc 'select version()' || logs_and_fail "Postgres did not start" db
mark postgres

psql "$PLAIN_ADMIN_DB_URL" -q -v ON_ERROR_STOP=1 -v svc_password="$PLAIN_SVC_DB_PASSWORD" \
  -f "$here/shim/10-before-services.sql" 2> "$out/shim1.log" || { cat "$out/shim1.log"; logs_and_fail "shim part 1 failed" db; }
mark shim-part-1

"${compose[@]}" up -d mailpit auth
wait_http GoTrue http://127.0.0.1:59999/health 90 || logs_and_fail "GoTrue did not become healthy (its own migrations on a plain database, G2)" auth db
wait_http Mailpit "http://127.0.0.1:54324/api/v1/messages?limit=1" 30 || logs_and_fail "Mailpit did not start" mailpit
mark gotrue

"${compose[@]}" up -d s3
# Any HTTP answer means the S3 stand-in listens; an unsigned request is refused.
wait_http "S3 stand-in" http://127.0.0.1:59000/ 60 '^[2-5]' || logs_and_fail "S3 stand-in did not start" s3
bucket_code="$(curl -s -o "$out/s3-bucket.txt" -w '%{http_code}' --aws-sigv4 'aws:amz:us-east-1:s3' \
  --user "$PLAIN_S3_ACCESS_KEY:$PLAIN_S3_SECRET_KEY" -X PUT http://127.0.0.1:59000/crm-plain-files || true)"
echo "S3 stand-in: create bucket crm-plain-files -> HTTP $bucket_code"
[[ "$bucket_code" =~ ^(200|409)$ ]] || { cat "$out/s3-bucket.txt"; logs_and_fail "could not create the S3 bucket" s3; }
mark s3

"${compose[@]}" up -d storage
wait_http storage-api http://127.0.0.1:55000/status 90 || logs_and_fail "storage-api did not become healthy (its own migrations on a plain database, G3)" storage db
mark storage

psql "$PLAIN_ADMIN_DB_URL" -q -v ON_ERROR_STOP=1 -f "$here/shim/20-after-services.sql" 2> "$out/shim2.log" \
  || { cat "$out/shim2.log"; logs_and_fail "shim part 2 failed" auth storage; }
grep -E 'NOTICE' "$out/shim2.log" | sed 's/^.*NOTICE: *//' > "$out/shim-notices.txt" || true
cat "$out/shim-notices.txt"
mark shim-part-2

bash "$here/scripts/apply-migrations.sh" "$PLAIN_ADMIN_DB_URL" "$out/migrations.json"
mark migrations

"${compose[@]}" up -d rest14 rest16
wait_http "PostgREST 14.18" http://127.0.0.1:3999/ 60 || logs_and_fail "PostgREST 14.18 did not start" rest14
wait_http "PostgREST 16.4" http://127.0.0.1:53998/ 60 || logs_and_fail "PostgREST 16.4 did not start" rest16
mark postgrest

"${compose[@]}" up -d proxy
wait_http "front door /rest/v1" http://127.0.0.1:54321/rest/v1/ 30 '^2' -H "apikey: $PLAIN_ANON_KEY" \
  || logs_and_fail "front door did not route /rest/v1" proxy rest14
wait_http "front door /auth/v1" http://127.0.0.1:54321/auth/v1/health 30 '^2' -H "apikey: $PLAIN_ANON_KEY" \
  || logs_and_fail "front door did not route /auth/v1" proxy auth
wait_http "front door /storage/v1" http://127.0.0.1:54321/storage/v1/bucket 30 '^2' \
  -H "apikey: $PLAIN_SERVICE_KEY" -H "Authorization: Bearer $PLAIN_SERVICE_KEY" \
  || logs_and_fail "front door did not route /storage/v1" proxy storage
wait_http "information leg /rest/v1" http://127.0.0.1:54331/rest/v1/ 30 '^2' -H "apikey: $PLAIN_ANON_KEY" \
  || logs_and_fail "information-leg front door did not route /rest/v1" proxy rest16
# The API-key gate: no key, no Data API.
nokey="$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:54321/rest/v1/ || true)"
echo "front door without an API key -> HTTP $nokey (expected 401)"
[ "$nokey" = 401 ] || logs_and_fail "the front door answered $nokey without an API key" proxy
mark front-door

node --input-type=module -e '
  import { readFileSync, writeFileSync } from "node:fs";
  const [tsv, json] = process.argv.slice(1);
  const steps = readFileSync(tsv, "utf8").trim().split("\n").map((l) => { const [step, s] = l.split("\t"); return { step, secondsSinceStart: Number(s) }; });
  writeFileSync(json, JSON.stringify({ steps }, null, 2) + "\n");
' "$timings" "$out/timings.json"

# Isolation (A1): every published port of the stack is on loopback.
"${compose[@]}" ps --format '{{.Service}} {{.Publishers}}' > "$out/published-ports.txt"
cat "$out/published-ports.txt"
docker ps --format '{{.Names}} {{.Ports}}' > "$out/docker-ports.txt"
if grep -E '0\.0\.0\.0:|:::|\[::\]:' "$out/docker-ports.txt"; then
  echo "::error title=plain stack::a port is published on a non-loopback address"
  exit 1
fi
echo "plain stack up in $(( SECONDS - start_all )) s"
