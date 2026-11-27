-- TripNavigate CRM - S4 background sync load (3 of 4): cadence as data
--
-- Contract: hosting-migration-2026-11-26/10-s4-sync-load-contract.md, sections
-- 2.2 (D5, D6, D13), 2.5 (g), (h), (i) and 2.7; review 10a (I1, M11).
--
-- Why: "30 seconds" is hard-coded in the sync-stopped alert check (stopped
-- after 3 x 30 s). At a 5-minute cadence that would raise a false "sync
-- stopped" incident and e-mail within 90 seconds. The cadence now lives in
-- integration_sync_schedule.interval_seconds (20261208000100), and "stopped"
-- stays "no successful full run for more than 3 intervals" (15 minutes at
-- 300 s, 90 seconds at 30 s). Also, since S4 the dispatch table holds event,
-- copy and chain calls that only the next tick settles; the "last scheduler
-- calls" that explain a stopped sync now read the scheduler's own calls
-- (kind = 'tick') only. Rows written before S4 are all 'tick'.
--
-- What changes:
--   * public.integration_sync_alert_check(): v_interval is read from the
--     schedule row (fallback 30 seconds); the three "last five calls" reads
--     use kind = 'tick'. Everything else is unchanged.
--   * public.integration_auto_sync_status(): two more keys, intervalSeconds
--     and kickEnabled; lastCalls, lastOkCallAt and both reads of failingSince
--     use kind = 'tick'. Every other key is unchanged, so older app versions
--     keep working.
--   * authz.set_bitrix_sync_cadence(p_seconds, p_reason) (new, owner SQL
--     only): 30 or 300 seconds, reason 10 to 500 characters (22023). Needs
--     pg_cron and the job bitrix-sync (55000). In one transaction it changes
--     the job's schedule ('30 seconds' or '*/5 * * * *'; pg_cron's "N seconds"
--     form allows 1 to 59 only), sets interval_seconds and writes one audit row
--     (integration.sync_cadence_changed) per enabled intake config, or one for
--     the newest config row when none is enabled (55000 when there is none).
--     It never changes the job's active flag or the pause switch. Answers
--     {jobname, schedule, active, intervalSeconds}.
--
-- Replaces (same signatures, same grants and owner, kept by create or replace):
--   public.integration_sync_alert_check()   from 20261111000100_sync_completion.sql
--   public.integration_auto_sync_status()   from 20261113000100_sync_reliability.sql
-- Bodies copied unchanged except the lines marked "S4" and the added
-- kind = 'tick' conditions (tests/db/s4-sync-load.test.ts compares the
-- definitions before and after with those changes put back).
--
-- Nothing here creates, alters or activates a pg_cron job (the cadence
-- function changes the schedule only when an operator calls it), deletes a
-- row or contains a URL or a secret. On apply the cadence stays 30 seconds,
-- so the alert check and the admin page behave exactly as before.
-- Rollback: select authz.set_bitrix_sync_cadence(30, '<reason>'); (reverse
-- scripts R1 and R1b in supabase/s4-sync-load/). Forward-only otherwise.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Alert check: restated from 20261111000100_sync_completion.sql
-- ---------------------------------------------------------------------------

-- Opens or closes incidents from the facts integration_auto_sync_status()
-- uses (pg_cron job 'bitrix-sync', the schedule switch, the last scheduler
-- calls) plus the last successful reconcile heartbeat, with the admin page
-- rule (autoSyncState): switch off = paused (no incident); otherwise running
-- only when the last ok/partial reconcile run finished at most 3 intervals ago
-- (S4: interval_seconds, 30 or 300) and the job exists and is active.
-- S4: the last scheduler calls are the pg_cron tick's own (kind = 'tick').
-- Returns the notices still to send (unchanged).
create or replace function public.integration_sync_alert_check() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_interval interval;
  v_intervals constant integer := 3;
  -- Review L1: send lease per notice.
  v_lease constant interval := interval '2 minutes';
  v_job jsonb := null;
  v_enabled boolean;
  v_last_ok timestamptz;
  v_running boolean;
  v_reason text;
  v_failed record;
  v_answered record;
  v_calls integer;
  v_recipients jsonb;
  v_send jsonb;
  r record;
begin
  -- S4: the cadence is data (30 or 300 seconds); stopped stays 3 intervals.
  select make_interval(secs => s.interval_seconds) into v_interval
  from public.integration_sync_schedule s where s.id;
  v_interval := coalesce(v_interval, interval '30 seconds');
  -- Facts (as public.integration_auto_sync_status()).
  if to_regclass('cron.job') is not null then
    execute $q$select jsonb_build_object('schedule', j.schedule, 'active', j.active)
               from cron.job j where j.jobname = 'bitrix-sync'$q$ into v_job;
  end if;
  select s.enabled into v_enabled from public.integration_sync_schedule s where s.id;
  select max(w.finished_at) into v_last_ok from public.integration_worker_runs w
  where w.kind = 'reconcile' and w.outcome in ('ok', 'partial');

  v_running := v_last_ok is not null and now() - v_last_ok <= v_interval * v_intervals
    and v_job is not null and coalesce((v_job ->> 'active')::boolean, false);

  if not v_running and v_enabled is distinct from false then
    -- Stopped: the same order of reasons as the admin page.
    if v_job is null then
      v_reason := 'job_missing';
    elsif not coalesce((v_job ->> 'active')::boolean, false) then
      v_reason := 'job_inactive';
    else
      select count(*) into v_calls from (
        select 1 from public.integration_sync_dispatches d where d.kind = 'tick' order by d.dispatched_at desc limit 5) x;
      select d.ok, d.reason into v_answered from (
        select * from public.integration_sync_dispatches where kind = 'tick' order by dispatched_at desc limit 5) d
      where d.ok is not null order by d.dispatched_at desc limit 1;
      select d.reason into v_failed from (
        select * from public.integration_sync_dispatches where kind = 'tick' order by dispatched_at desc limit 5) d
      where d.ok = false order by d.dispatched_at desc limit 1;
      v_reason := case
        when v_answered.ok is false and v_failed.reason is not null then 'call_failed'
        when v_calls = 0 then 'no_scheduler_calls'
        when v_answered.ok then 'sync_incomplete'
        else 'waiting_for_answer'
      end;
    end if;

    -- One open incident per portal with intake switched on.
    for r in
      select c.portal_member_id, c.pilot_legal_entity_id, c.id from public.integration_intake_config c
      where c.enabled order by c.portal_member_id
    loop
      insert into public.integration_sync_incidents (portal_member_id, reason_code)
      values (r.portal_member_id, v_reason)
      on conflict (portal_member_id) where recovered_at is null do nothing;
      if found then
        perform authz.write_audit('integration.sync_incident_opened', r.pilot_legal_entity_id, null,
          'integration_intake_config', r.id, null, jsonb_build_object('reasonCode', v_reason));
      end if;
    end loop;
  elsif v_running then
    -- Recovered: a successful run finished after the incident opened.
    for r in
      update public.integration_sync_incidents i
      set recovered_at = now()
      where i.recovered_at is null and i.opened_at < v_last_ok
      returning i.id, i.portal_member_id, i.opened_at
    loop
      perform authz.write_audit('integration.sync_incident_recovered', c.pilot_legal_entity_id, null,
          'integration_intake_config', c.id, null,
          jsonb_build_object('incidentId', r.id, 'openedAt', r.opened_at))
      from public.integration_intake_config c where c.portal_member_id = r.portal_member_id;
    end loop;
  end if;

  -- Recipients: Auth emails of active staff with an active Super Admin membership.
  select coalesce(jsonb_agg(e.email order by e.email), '[]'::jsonb) into v_recipients
  from (
    select distinct u.email
    from auth.users u
    join public.staff_profiles p on p.user_id = u.id and p.status = 'active'
    where u.email is not null and btrim(u.email) <> ''
      and exists (
        select 1 from public.memberships m
        where m.user_id = u.id and m.role_code = 'super_admin' and m.status = 'active')
  ) e;

  -- Review L1: each notice is claimed with a 2-minute lease (row locks make a
  -- concurrent check wait and then skip it), so overlapping checks never hand
  -- out the same notice twice. An unmarked notice comes back after its lease.
  with stopped as (
    update public.integration_sync_incidents i
    set open_sending_until = now() + v_lease
    where i.recovered_at is null and i.open_notified_at is null
      and (i.open_sending_until is null or i.open_sending_until <= now())
    returning i.id, i.opened_at, i.recovered_at, i.reason_code, i.open_sending_until sending_until
  ), recovered as (
    update public.integration_sync_incidents i
    set recovery_sending_until = now() + v_lease
    where i.recovered_at is not null and i.open_notified_at is not null and i.recovery_notified_at is null
      and (i.recovery_sending_until is null or i.recovery_sending_until <= now())
    returning i.id, i.opened_at, i.recovered_at, i.reason_code, i.recovery_sending_until sending_until
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'incidentId', x.id, 'kind', x.kind, 'openedAt', x.opened_at, 'recoveredAt', x.recovered_at,
           'reasonCode', x.reason_code, 'recipients', v_recipients, 'sendingUntil', x.sending_until)
         order by x.opened_at, x.kind_order), '[]'::jsonb)
    into v_send
  from (
    select st.id, 'stopped' kind, 1 kind_order, st.opened_at, st.recovered_at, st.reason_code, st.sending_until from stopped st
    union all
    select rc.id, 'recovered', 2, rc.opened_at, rc.recovered_at, rc.reason_code, rc.sending_until from recovered rc
  ) x;

  return jsonb_build_object('send', v_send, 'emailRecipientsCount', jsonb_array_length(v_recipients));
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin status: restated from 20261113000100_sync_reliability.sql
-- ---------------------------------------------------------------------------

-- Admin-only: cron job state, the schedule, the last scheduler calls (S4: kind
-- 'tick' only) and the cadence and kick switch (no URL, no secret).
create or replace function public.integration_auto_sync_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_job jsonb := null;
begin
  if not authz.can_admin_any('integration.manage') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if to_regclass('cron.job') is not null then
    execute $q$select jsonb_build_object('schedule', j.schedule, 'active', j.active)
               from cron.job j where j.jobname = 'bitrix-sync'$q$ into v_job;
  end if;
  return jsonb_build_object(
    'cronInstalled', to_regclass('cron.job') is not null,
    'job', v_job,
    'enabled', (select s.enabled from public.integration_sync_schedule s where s.id),
    -- S4: the cadence and the kick switch.
    'intervalSeconds', (select s.interval_seconds from public.integration_sync_schedule s where s.id),
    'kickEnabled', (select s.kick_enabled from public.integration_sync_schedule s where s.id),
    'lastCalls', coalesce((
      select jsonb_agg(jsonb_build_object('at', d.dispatched_at, 'answeredAt', d.answered_at,
               'statusCode', d.status_code, 'ok', d.ok, 'reason', d.reason) order by d.dispatched_at desc)
      from (select * from public.integration_sync_dispatches where kind = 'tick' order by dispatched_at desc limit 5) d), '[]'::jsonb),
    'lastOkCallAt', (select max(d.dispatched_at) from public.integration_sync_dispatches d where d.kind = 'tick' and d.ok),
    'failingSince', (select min(d.dispatched_at) from public.integration_sync_dispatches d
                     where d.kind = 'tick' and d.ok = false and d.dispatched_at > coalesce(
                       (select max(x.dispatched_at) from public.integration_sync_dispatches x where x.kind = 'tick' and x.ok), '-infinity')),
    -- Sync reliability: every heartbeat of the last 24 hours, counted per kind and outcome.
    'runs24h', (
      select jsonb_build_object(
        'since', now() - interval '24 hours',
        'worker', jsonb_build_object(
          'ok', count(*) filter (where r.kind = 'worker' and r.outcome = 'ok'),
          'partial', count(*) filter (where r.kind = 'worker' and r.outcome = 'partial'),
          'providerError', count(*) filter (where r.kind = 'worker' and r.outcome = 'provider_error'),
          'internalError', count(*) filter (where r.kind = 'worker' and r.outcome = 'internal_error')),
        'reconcile', jsonb_build_object(
          'ok', count(*) filter (where r.kind = 'reconcile' and r.outcome = 'ok'),
          'partial', count(*) filter (where r.kind = 'reconcile' and r.outcome = 'partial'),
          'providerError', count(*) filter (where r.kind = 'reconcile' and r.outcome = 'provider_error'),
          'internalError', count(*) filter (where r.kind = 'reconcile' and r.outcome = 'internal_error')),
        'itemsFailed', coalesce(sum(r.failed), 0),
        'itemsDeadLettered', coalesce(sum(r.dead_lettered), 0),
        'lastFailedAt', max(r.finished_at) filter (where r.outcome in ('provider_error', 'internal_error')))
      from public.integration_worker_runs r
      where r.finished_at >= now() - interval '24 hours'));
end;
$$;

-- ---------------------------------------------------------------------------
-- Cadence (owner SQL only, audited)
-- ---------------------------------------------------------------------------

-- Changes the pg_cron schedule of bitrix-sync and interval_seconds together.
-- Reverse script R1 is select authz.set_bitrix_sync_cadence(30, '<reason>');
create function authz.set_bitrix_sync_cadence(p_seconds integer, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job bigint;
  v_from integer;
  v_schedule text;
  v_result jsonb;
  v_audited integer := 0;
  r record;
begin
  if p_seconds is null or p_seconds not in (30, 300) then
    raise exception 'cadence must be 30 or 300 seconds' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 10 and 500 then
    raise exception 'reason must be 10 to 500 characters' using errcode = '22023';
  end if;
  if to_regclass('cron.job') is null then
    raise exception 'pg_cron is not installed' using errcode = '55000';
  end if;
  execute 'select j.jobid from cron.job j where j.jobname = $1' into v_job using 'bitrix-sync';
  if v_job is null then
    raise exception 'the bitrix-sync job does not exist' using errcode = '55000';
  end if;
  if not exists (select 1 from public.integration_intake_config) then
    raise exception 'no intake configuration to record the change against' using errcode = '55000';
  end if;
  select s.interval_seconds into v_from from public.integration_sync_schedule s where s.id;
  if not found then
    raise exception 'sync schedule row is missing' using errcode = '55000';
  end if;

  v_schedule := case p_seconds when 30 then '30 seconds' else '*/5 * * * *' end;
  execute 'select cron.alter_job($1, schedule := $2)' using v_job, v_schedule;
  update public.integration_sync_schedule s set interval_seconds = p_seconds, updated_at = now() where s.id;

  for r in
    select c.id, c.pilot_legal_entity_id from public.integration_intake_config c
    where c.enabled order by c.portal_member_id
  loop
    perform authz.write_audit('integration.sync_cadence_changed', r.pilot_legal_entity_id, null,
      'integration_intake_config', r.id, p_reason, jsonb_build_object('fromSeconds', v_from, 'toSeconds', p_seconds));
    v_audited := v_audited + 1;
  end loop;
  if v_audited = 0 then
    perform authz.write_audit('integration.sync_cadence_changed', c.pilot_legal_entity_id, null,
      'integration_intake_config', c.id, p_reason, jsonb_build_object('fromSeconds', v_from, 'toSeconds', p_seconds))
    from (select x.id, x.pilot_legal_entity_id from public.integration_intake_config x
          order by x.created_at desc, x.id desc limit 1) c;
  end if;

  execute $q$select jsonb_build_object('jobname', j.jobname, 'schedule', j.schedule, 'active', j.active)
             from cron.job j where j.jobid = $1$q$ into v_result using v_job;
  return v_result || jsonb_build_object('intervalSeconds', p_seconds);
end;
$$;

revoke all on function authz.set_bitrix_sync_cadence(integer, text) from public, anon, authenticated, service_role;

commit;
