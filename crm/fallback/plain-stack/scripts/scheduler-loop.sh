#!/usr/bin/env bash
# Proof P5 (contract file 12, section 4.2): the outside scheduler that replaces
# pg_cron + pg_net. Posts to the worker route of the running app every
# INTERVAL seconds, COUNT times, with the worker bearer, exactly as the
# pg_cron job's call (POST ?task=sync) does. One JSON line per call on stdout:
#   {"call":1,"startedAt":"...","status":200,"seconds":1.23}
# The bearer comes from INTAKE_WORKER_SECRET in the environment; it is never
# put on a command line or printed.
#
# Usage: scheduler-loop.sh <app-base-url> <interval-seconds> <count> [query]
set -uo pipefail

base="$1"
interval="$2"
count="$3"
query="${4:-?task=sync}"
case "$base" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo '{"error":"the app must be on a loopback address"}'; exit 2 ;;
esac
[ -n "${INTAKE_WORKER_SECRET:-}" ] || { echo '{"error":"INTAKE_WORKER_SECRET is missing"}'; exit 2; }

header_file="$(mktemp)"
trap 'rm -f "$header_file"' EXIT
chmod 600 "$header_file"
printf 'Authorization: Bearer %s\n' "$INTAKE_WORKER_SECRET" > "$header_file"

t0=$(date +%s)
for call in $(seq 1 "$count"); do
  # Fixed cadence from the loop start, like a scheduler (not "sleep after each call").
  due=$(( t0 + (call - 1) * interval ))
  now=$(date +%s)
  if [ "$due" -gt "$now" ]; then sleep $(( due - now )); fi
  started="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
  result="$(curl -s -o /dev/null -w '%{http_code} %{time_total}' -X POST -H @"$header_file" \
    --max-time 90 "$base/api/integrations/bitrix/worker$query" || echo "000 0")"
  status="${result%% *}"
  seconds="${result##* }"
  printf '{"call":%d,"startedAt":"%s","status":%d,"seconds":%s}\n' "$call" "$started" "$status" "$seconds"
done
