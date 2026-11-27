#!/usr/bin/env bash
# Step 0 capture (contract file 12, section 3.3): measure, do not assume.
#
#   capture-baseline.sh baseline <out-dir>   on the running Supabase CLI stack
#   capture-baseline.sh plain    <out-dir>   on the running plain stack
#
# Writes <out-dir>/capture-<mode>.json with:
#   images  - image, tag and digest of every service container (docker inspect)
#   env     - setting NAMES of each service and the values of the non-secret ones
#   db      - scripts/capture.sql (roles, role settings, grants, default
#             privileges, extensions, publications, event triggers, settings)
#   token   - scripts/token-shape.mjs (signing method, claim names; after seeding)
# Names and non-secret values only: anything that looks like a secret is
# written as "(redacted)", and nothing is echoed to the log.
set -euo pipefail

mode="$1"
out="$2"
here="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$out"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

case "$mode" in
  baseline) pattern='^supabase_'; db_url="${TEST_DATABASE_URL:?}" ;;
  plain) pattern='^plainstack-'; db_url="${PLAIN_ADMIN_DB_URL:?}" ;;
  *) echo "usage: $0 baseline|plain <out-dir>" >&2; exit 2 ;;
esac

# Containers and images.
: > "$tmp/containers.tsv"
for name in $(docker ps --format '{{.Names}}' | grep -E "$pattern" | sort); do
  image="$(docker inspect -f '{{.Config.Image}}' "$name")"
  id="$(docker inspect -f '{{.Image}}' "$name")"
  digests="$(docker image inspect -f '{{join .RepoDigests ","}}' "$id" 2> /dev/null || true)"
  printf '%s\t%s\t%s\n' "$name" "$image" "$digests" >> "$tmp/containers.tsv"
  # Environment of the container: read by node from a file in the temporary
  # folder, filtered there; never printed.
  docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$name" > "$tmp/env-$name.txt"
done

psql "$db_url" -X -At -v ON_ERROR_STOP=1 -f "$here/capture.sql" > "$tmp/db.json"

token_json='null'
if node "$here/token-shape.mjs" > "$tmp/token.json" 2> "$tmp/token.err"; then
  token_json="$(cat "$tmp/token.json")"
else
  echo "capture: token shape not read ($(head -c 300 "$tmp/token.err"))"
fi
printf '%s' "$token_json" > "$tmp/token.json"

node --input-type=module - "$mode" "$tmp" "$out/capture-$mode.json" <<'NODE'
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [mode, tmp, outFile] = process.argv.slice(2);
const SECRET_NAME = /(SECRET|PASSWORD|PASS\b|_PASS|KEY|TOKEN|DATABASE_URL|DB_URI|DB_URL|_SID|JWKS|ENCRYPTION|CREDENTIAL|PRIVATE)/i;
const SECRET_VALUE = /eyJ[A-Za-z0-9_-]{8,}|postgres(ql)?:\/\/|sb_secret_|sb_publishable_|BEGIN [A-Z ]*PRIVATE KEY/;
// Kept as names only even though not secret: long, noisy or host-specific.
const NAME_ONLY = /^(PATH|HOSTNAME|HOME|GOSU_VERSION|PG_SHA256|LANG|LC_ALL|PGDATA|PG_MAJOR|PG_VERSION|NODE_VERSION|YARN_VERSION)$/;

const images = [];
const env = {};
for (const line of readFileSync(join(tmp, 'containers.tsv'), 'utf8').split('\n').filter(Boolean)) {
  const [container, image, digests] = line.split('\t');
  const service = container.replace(/^supabase_/, '').replace(/^plainstack-/, '').replace(/_tripnavigate-crm$/, '').replace(/-\d+$/, '');
  images.push({ service, container, image, digests: digests ? digests.split(',') : [] });
  const entries = {};
  for (const raw of readFileSync(join(tmp, `env-${container}.txt`), 'utf8').split('\n').filter(Boolean)) {
    const eq = raw.indexOf('=');
    const name = eq < 0 ? raw : raw.slice(0, eq);
    const value = eq < 0 ? '' : raw.slice(eq + 1);
    if (SECRET_NAME.test(name) || SECRET_VALUE.test(value)) entries[name] = value ? '(redacted)' : '(empty)';
    else if (NAME_ONLY.test(name)) entries[name] = '(not recorded)';
    else entries[name] = value.length > 400 ? `${value.slice(0, 400)}...(truncated)` : value;
  }
  env[service] = entries;
}
const capture = {
  mode,
  capturedAt: new Date().toISOString(),
  images,
  env,
  db: JSON.parse(readFileSync(join(tmp, 'db.json'), 'utf8')),
  token: JSON.parse(readFileSync(join(tmp, 'token.json'), 'utf8') || 'null'),
};
writeFileSync(outFile, `${JSON.stringify(capture, null, 2)}\n`);
console.log(`capture ${mode}: ${images.length} containers, ${Object.keys(capture.db.roles ?? {}).length} roles, token ${capture.token ? capture.token.alg : 'not read'}`);
for (const i of images) console.log(`  ${i.service}: ${i.image} ${i.digests.join(' ')}`);
NODE
