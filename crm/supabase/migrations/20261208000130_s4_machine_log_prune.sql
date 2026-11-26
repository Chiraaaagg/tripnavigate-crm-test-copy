-- TripNavigate CRM - S4 background sync load (4 of 4): nightly prune of three machine logs
--
-- Contract: hosting-migration-2026-11-26/10-s4-sync-load-contract.md, sections
-- 1.5, 2.2 (D9, D10, D11) and 2.5 (j), (k); review 10a (I4, M10).
-- Owner decision (file 09, S4 answers, item 3): scheduler run history and sync
-- worker-run history older than 14 days may be deleted automatically; business
-- and audit records are never touched.
--
-- Why: cron.job_run_details (pg_cron's own run history) has never been pruned
-- (about 139,000 rows, 23 MB, measured 26 Nov 2026); the two existing nightly
-- clean-ups each run one unbatched DELETE.
--
-- What changes:
--   * authz.prune_machine_logs(p_batch default 5000, p_rounds default 10)
--     (new, owner and pg_cron only). Retention: greatest(log_retention_days, 7)
--     from integration_sync_schedule; no schedule row = {"status":"no_policy"}
--     and nothing is deleted. Exactly three DELETE targets, each in rounds of
--     at most p_batch rows (clamped to 100..10,000), repeated until a round
--     deletes fewer than p_batch rows or p_rounds rounds (clamped to 1..10) are
--     done:
--       public.integration_worker_runs      finished_at older than the cutoff
--       public.integration_sync_dispatches  dispatched_at older than the cutoff
--                                           and answered (an unanswered call
--                                           is kept for the settle step)
--       cron.job_run_details                coalesce(end_time, start_time)
--                                           older than the cutoff, oldest runid
--                                           first; only when pg_cron exists
--                                           (dynamic SQL, so this file loads
--                                           without pg_cron)
--     lock_timeout 5 s for the call. Answers {status, retentionDays, cutoff,
--     workerRuns, dispatches, cronRuns, more}; more = a table stopped at the
--     round limit. No other table is named in a DELETE, and there is no
--     TRUNCATE or DROP (tests/db/s4-machine-log-prune.test.ts checks the
--     source). integration_inbox is not pruned (dedupe store, staff-visible).
--   * authz.provision_machine_log_prune_job() (new, owner only): same pattern
--     as authz.provision_bitrix_sync_jobs(). Refuses (55000) without pg_cron;
--     creates the job machine-log-prune ('30 20 * * *' = 02:00 IST, before the
--     22:10 UTC daily backup; command select authz.prune_machine_logs())
--     PAUSED in the same transaction; leaves an existing job of that name
--     exactly as it is; answers the machine-log-prune and bitrix-sync* jobs.
--     Activating it and pausing the two old clean-up jobs are operator steps
--     under their own approval (contract section 6, step 3).
--
-- Nothing here creates, alters or activates a pg_cron job on apply, deletes a
-- row or contains a URL or a secret.
-- Rollback: reverse script R2 in supabase/s4-sync-load/ (pause
-- machine-log-prune, reactivate the two old clean-ups). Rows already deleted
-- can only be restored from a daily backup. Forward-only otherwise.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Prune
-- ---------------------------------------------------------------------------

create function authz.prune_machine_logs(p_batch integer default 5000, p_rounds integer default 10) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_batch integer := least(greatest(coalesce(p_batch, 5000), 100), 10000);
  v_rounds integer := least(greatest(coalesce(p_rounds, 10), 1), 10);
  v_days integer;
  v_cutoff timestamptz;
  v_round integer;
  v_n integer;
  v_runs integer := 0;
  v_dispatches integer := 0;
  v_cron integer := 0;
  v_more boolean := false;
begin
  perform set_config('lock_timeout', '5s', true);

  select greatest(s.log_retention_days, 7) into v_days from public.integration_sync_schedule s where s.id;
  if v_days is null then
    return jsonb_build_object('status', 'no_policy');
  end if;
  v_cutoff := now() - make_interval(days => v_days);

  -- 1. Worker and reconcile heartbeats.
  v_round := 0;
  loop
    delete from public.integration_worker_runs w
    where w.id in (
      select x.id from public.integration_worker_runs x
      where x.finished_at < v_cutoff
      limit v_batch);
    get diagnostics v_n = row_count;
    v_runs := v_runs + v_n;
    v_round := v_round + 1;
    exit when v_n < v_batch;
    if v_round >= v_rounds then
      v_more := true;
      exit;
    end if;
  end loop;

  -- 2. Answered scheduler, event, copy and chain calls.
  v_round := 0;
  loop
    delete from public.integration_sync_dispatches d
    where d.request_id in (
      select x.request_id from public.integration_sync_dispatches x
      where x.dispatched_at < v_cutoff and x.answered_at is not null
      order by x.dispatched_at
      limit v_batch);
    get diagnostics v_n = row_count;
    v_dispatches := v_dispatches + v_n;
    v_round := v_round + 1;
    exit when v_n < v_batch;
    if v_round >= v_rounds then
      v_more := true;
      exit;
    end if;
  end loop;

  -- 3. pg_cron's own run history (only where pg_cron exists).
  if to_regclass('cron.job_run_details') is not null then
    v_round := 0;
    loop
      execute 'delete from cron.job_run_details d where d.runid in ('
        || 'select x.runid from cron.job_run_details x '
        || 'where coalesce(x.end_time, x.start_time) < $1 order by x.runid limit $2)'
        using v_cutoff, v_batch;
      get diagnostics v_n = row_count;
      v_cron := v_cron + v_n;
      v_round := v_round + 1;
      exit when v_n < v_batch;
      if v_round >= v_rounds then
        v_more := true;
        exit;
      end if;
    end loop;
  end if;

  return jsonb_build_object(
    'status', 'ok',
    'retentionDays', v_days,
    'cutoff', v_cutoff,
    'workerRuns', v_runs,
    'dispatches', v_dispatches,
    'cronRuns', v_cron,
    'more', v_more);
end;
$$;

revoke all on function authz.prune_machine_logs(integer, integer) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Job provisioning: an approved operator step, never automatic
-- ---------------------------------------------------------------------------

-- Creates machine-log-prune PAUSED (cron.job.active = false, set in the same
-- transaction). A job that already exists under that name is left exactly as
-- it is. Requires pg_cron; owner only.
create function authz.provision_machine_log_prune_job() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id bigint;
  v_result jsonb;
begin
  if to_regclass('cron.job') is null then
    raise exception 'pg_cron is not installed' using errcode = '55000';
  end if;
  execute 'select j.jobid from cron.job j where j.jobname = $1' into v_id using 'machine-log-prune';
  if v_id is null then
    execute 'select cron.schedule($1, $2, $3)' into v_id
      using 'machine-log-prune', '30 20 * * *', 'select authz.prune_machine_logs()';
    execute 'select cron.alter_job($1, active := false)' using v_id;
  end if;
  execute $q$
    select coalesce(jsonb_agg(jsonb_build_object('jobname', j.jobname, 'schedule', j.schedule, 'active', j.active)
                              order by j.jobname), '[]'::jsonb)
    from cron.job j where j.jobname = 'machine-log-prune' or j.jobname like 'bitrix-sync%'
  $q$ into v_result;
  return v_result;
end;
$$;

revoke all on function authz.provision_machine_log_prune_job() from public, anon, authenticated, service_role;

commit;
