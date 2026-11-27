#!/usr/bin/env bash
# CI only: start the local Supabase stack, retrying when image pulls fail.
#
# Why: GitHub-hosted runners share outgoing addresses, and anonymous pulls from
# public.ecr.aws often answer "error from registry: Rate exceeded". Supabase CLI
# 2.119.0 already retries each image twice (4 s, 8 s) and then falls back from
# public.ecr.aws to ghcr.io and Docker Hub; when every registry is refused it
# rolls the stack back and exits 1. This wrapper adds a slower outer retry
# (wait 30 s, then 90 s) so a short burst of rate limiting does not fail the job.
#
# Not started (the tests never use them): realtime, imgproxy, edge-runtime,
# logflare, vector, supavisor, and Studio with its postgres-meta. Leaving out
# Studio and postgres-meta saves two image pulls per job; `supabase gen types
# --local` and `supabase db lint` talk to Postgres directly.
#
# Usage (from crm/): bash scripts/ci/supabase-start.sh
set -uo pipefail

excluded='realtime,imgproxy,edge-runtime,logflare,vector,supavisor,studio,postgres-meta'
waits=(0 30 90)

for attempt in 1 2 3; do
  wait_seconds=${waits[$((attempt - 1))]}
  if [ "$wait_seconds" -gt 0 ]; then
    echo "Waiting ${wait_seconds} s before attempt ${attempt} of 3"
    sleep "$wait_seconds"
  fi
  if supabase start -x "$excluded"; then
    exit 0
  fi
  echo "::warning title=supabase start::attempt ${attempt} of 3 failed (see the image pull messages above)"
  # The CLI rolls back a failed start; stop again in case anything is left over.
  supabase stop --no-backup || true
done

echo "::error title=supabase start::the local Supabase stack did not start after 3 attempts"
exit 1
