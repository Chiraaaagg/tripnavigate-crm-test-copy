-- TripNavigate CRM - Accounts phase 3, track A, foundation: the "by the CRM"
-- actor and the timer (task registry, tick, scheduler pieces created paused).
-- Contract: accounts-phase3-2026-11-12/contract.md sections 5.1, 5.2, 5.9 (A11),
-- 17.2 (timer switch Off), 21 LD1 and LD2. Lands before every other Phase 3
-- migration: tracks B, D, E and G build on these objects.
--
-- 1. authz.system_rule(rule) and authz.write_system_audit(...): automatic
--    actions carry a rule name; their audit rows say {by: 'crm', rule}; the
--    actor is auth.uid() (the person whose step caused it), null on timer runs.
--    No fake staff account (LD2). No grant to any role.
-- 2. Timer (LD1): timer_settings (single row, enabled Off), timer_tasks (the
--    registry: each track registers its own tasks in its own migration through
--    authz.timer_task_register), timer_runs (14 days, pruned by the tick) and
--    timer_alerts (written by task timer_health; track D turns them into
--    notice 46). public.timer_tick() runs each due task in its own exception
--    block, so one task's failure never stops the others (service_role only).
-- 3. authz.dispatch_timer / run_scheduled_timer / provision_timer_job: copies
--    of the Bitrix sync pattern (20261107000100). Vault names crm_timer_url,
--    crm_timer_bearer, optional vercel_protection_bypass; job crm-timer every
--    minute, created PAUSED by the operator step only. Nothing is scheduled
--    here, no extension is installed, and every pg_cron / pg_net / Vault
--    reference is guarded so this file loads on a database without them.
-- 4. A11 public.admin_set_timer_enabled(enabled, reason): Super Admin, reason
--    10..500. Audit settings.timer_changed by trigger: column names only.
--
-- Task function contract: a no-argument function in schema authz or public
-- returning jsonb (an object of counts; never names, amounts or text), owned by
-- the migration owner, executable by nobody else. It runs inside the tick's
-- transaction under a savepoint: an error rolls back that task's own work only
-- and is recorded as its SQLSTATE in timer_tasks.last_error_code.
--
-- Refusal tokens: not_authorized (42501), invalid_input (22023, hint names the
-- field).
--
-- Rollback (forward-only): a NEW migration dropping the objects created here
-- (after the tracks that registered timer tasks have dropped their rows).

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. "By the CRM" actor (5.1, LD2)
-- ===========================================================================

create function authz.system_rule_ok(p_rule text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_rule ~ '^[a-z][a-z0-9_.]{2,59}$', false)
$$;

-- Validates the rule name and records it for the rest of the transaction
-- (tripnavigate.system_rule), so guards and triggers can see that the change
-- is automatic. Returns the rule.
create function authz.system_rule(p_rule text) returns text
language plpgsql volatile set search_path = '' as $$
begin
  if not authz.system_rule_ok(p_rule) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'rule';
  end if;
  perform set_config('tripnavigate.system_rule', p_rule, true);
  return p_rule;
end;
$$;

-- As authz.write_audit, with details || {by: 'crm', rule}. The actor is
-- auth.uid(): the person whose command caused the automatic action, or null
-- when the timer caused it. Details must be an object (ids, kinds, counts,
-- codes only - contract section 0).
create function authz.write_system_audit(
  p_action text, p_entity uuid, p_branch uuid, p_target_type text, p_target_id uuid,
  p_rule text, p_details jsonb
) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if not authz.system_rule_ok(p_rule) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'rule';
  end if;
  if p_details is not null and jsonb_typeof(p_details) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'details';
  end if;
  perform authz.write_audit(p_action, p_entity, p_branch, p_target_type, p_target_id, null,
    coalesce(p_details, '{}'::jsonb) || jsonb_build_object('by', 'crm', 'rule', p_rule));
end;
$$;

-- ===========================================================================
-- 2. Settings audit by column name (5.9: "column names, never values")
-- ===========================================================================
-- TG_ARGV[0] = audit action; TG_ARGV[1..] = watched columns. Writes the names
-- of the watched columns that changed, never their values. An UPDATE that
-- changes no watched column writes nothing. Reason and command come from
-- authz.settings_begin_change (20261114000100). Reused by later track A
-- settings tables (customer message switches, pilot, templates).
create function authz.audit_settings_columns() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(to_jsonb(new), to_jsonb(old));
  v_changed text[] := '{}';
  v_col text;
  v_reason text := left(nullif(btrim(coalesce(current_setting('tripnavigate.change_reason', true), ''), E' \t\r\n'), ''), 500);
  v_command text := left(nullif(btrim(coalesce(current_setting('tripnavigate.change_command', true), ''), E' \t\r\n'), ''), 100);
  v_role text := nullif(current_setting('role', true), 'none');
  v_jwt_role text := (select auth.jwt()) ->> 'role';
  v_entity uuid;
  v_target uuid;
begin
  foreach v_col in array tg_argv[1:] loop
    if (v_old -> v_col) is distinct from (v_new -> v_col) then
      v_changed := v_changed || v_col;
    end if;
  end loop;
  if tg_op = 'UPDATE' and cardinality(v_changed) = 0 then
    return null;
  end if;
  v_entity := case when jsonb_typeof(v_row -> 'legal_entity_id') = 'string' then (v_row ->> 'legal_entity_id')::uuid end;
  v_target := coalesce(case when jsonb_typeof(v_row -> 'id') = 'string' then (v_row ->> 'id')::uuid end, v_entity);
  perform authz.write_audit(tg_argv[0], v_entity, null, tg_table_name, v_target, v_reason,
    jsonb_build_object(
      'operation', lower(tg_op),
      'columns', to_jsonb(v_changed),
      'via', case
        when v_command is not null then 'command'
        when v_role in ('authenticated', 'anon', 'service_role') or v_jwt_role is not null then 'api'
        else 'direct_sql' end,
      'command', v_command,
      'reasonGiven', v_reason is not null));
  return null;
end;
$$;

-- ===========================================================================
-- 3. Timer settings (single row, Off)
-- ===========================================================================

create table public.timer_settings (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  -- Last pg_net request id and when it was sent (overlap guard, no content).
  last_request_id bigint,
  last_dispatched_at timestamptz,
  -- End of the last completed public.timer_tick().
  last_ok_at timestamptz,
  updated_by uuid references public.staff_profiles (user_id),
  updated_at timestamptz not null default now()
);
create index timer_settings_updated_by_idx on public.timer_settings (updated_by) where updated_by is not null;
insert into public.timer_settings (id, enabled) values (true, false);
comment on table public.timer_settings is
  'Single row. enabled changes through public.admin_set_timer_enabled (Super Admin, reason) or owner SQL; audited by trigger (settings.timer_changed, column names only). The cron job crm-timer is created paused by authz.provision_timer_job() (operator step). URL and bearer live in Vault, never here.';

-- updated_at / updated_by describe the switch, not the minute bookkeeping.
create function authz.timer_settings_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.enabled is distinct from old.enabled then
    new.updated_at := now();
  else
    new.updated_at := old.updated_at;
    new.updated_by := old.updated_by;
  end if;
  return new;
end;
$$;

create function authz.timer_settings_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'timer settings cannot be deleted' using errcode = '42501';
end;
$$;

create trigger timer_settings_a_guard before delete on public.timer_settings
  for each row execute function authz.timer_settings_guard();
create trigger timer_settings_touch before update on public.timer_settings
  for each row execute function authz.timer_settings_touch();
create trigger timer_settings_audit after insert or update or delete on public.timer_settings
  for each row execute function authz.audit_settings_columns('settings.timer_changed', 'enabled');
create trigger timer_settings_no_truncate before truncate on public.timer_settings
  for each statement execute function authz.refuse_settings_truncate();

-- ===========================================================================
-- 4. Task registry, runs, alerts
-- ===========================================================================

create table public.timer_tasks (
  name text primary key check (name ~ '^[a-z_]{3,40}$'),
  function_name text not null check (function_name ~ '^(authz|public)\.[a-z_]+$'),
  every_minutes integer not null check (every_minutes between 1 and 1440),
  enabled boolean not null default true,
  last_run_at timestamptz,
  last_result jsonb check (last_result is null or jsonb_typeof(last_result) = 'object'),
  last_error_code text check (last_error_code is null or last_error_code ~ '^[A-Za-z0-9_]{1,40}$'),
  created_at timestamptz not null default now()
);
comment on table public.timer_tasks is
  'Timer task registry (contract 5.2). Each track registers its own tasks in its own migration with authz.timer_task_register; nobody edits another track''s task. function_name: a no-argument function returning a jsonb object of counts.';

create function authz.timer_tasks_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'timer tasks cannot be deleted; disable them instead' using errcode = '42501';
  end if;
  if new.name is distinct from old.name or new.function_name is distinct from old.function_name
     or new.created_at is distinct from old.created_at then
    raise exception 'a timer task keeps its name and function' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger timer_tasks_a_guard before update or delete on public.timer_tasks
  for each row execute function authz.timer_tasks_guard();

create table public.timer_runs (
  id bigint generated always as identity primary key,
  started_at timestamptz not null,
  finished_at timestamptz,
  -- task name -> the task's counts, or {errorCode} when it failed.
  results jsonb not null default '{}'::jsonb check (jsonb_typeof(results) = 'object'),
  error_code text check (error_code is null or error_code ~ '^[a-z_]{1,40}$')
);
create index timer_runs_started_idx on public.timer_runs (started_at);

-- Append-only; the tick removes rows older than 14 days.
create function authz.timer_runs_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    raise exception 'timer runs are append-only' using errcode = '42501';
  end if;
  if old.started_at >= now() - interval '14 days' then
    raise exception 'timer runs are kept for 14 days' using errcode = '42501';
  end if;
  return old;
end;
$$;
create trigger timer_runs_a_guard before update or delete on public.timer_runs
  for each row execute function authz.timer_runs_guard();

-- Stalled-timer and late-queue alerts (task timer_health). One row per kind
-- and India-time hour; track D turns each into notice 46 (timer_stalled,
-- dedup timer:<hour_key>).
create table public.timer_alerts (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('timer_late', 'message_queue_late', 'push_queue_late')),
  oldest_minutes integer not null check (oldest_minutes >= 0),
  hour_key text not null check (hour_key ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}$'),
  created_at timestamptz not null default now(),
  unique (kind, hour_key)
);
create index timer_alerts_created_idx on public.timer_alerts (created_at desc);

create function authz.timer_alerts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'timer alerts are append-only' using errcode = '42501';
end;
$$;
create trigger timer_alerts_a_guard before update or delete on public.timer_alerts
  for each row execute function authz.timer_alerts_guard();

create trigger timer_tasks_no_truncate before truncate on public.timer_tasks
  for each statement execute function authz.refuse_settings_truncate();
create trigger timer_alerts_no_truncate before truncate on public.timer_alerts
  for each statement execute function authz.refuse_settings_truncate();

-- RLS on, session policy, no API privileges (reads go through definer reads).
alter table public.timer_settings enable row level security;
alter table public.timer_tasks enable row level security;
alter table public.timer_runs enable row level security;
alter table public.timer_alerts enable row level security;
create policy require_valid_session on public.timer_settings as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
create policy require_valid_session on public.timer_tasks as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
create policy require_valid_session on public.timer_runs as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
create policy require_valid_session on public.timer_alerts as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.timer_settings, public.timer_tasks, public.timer_runs, public.timer_alerts
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Registration (called from migrations only)
-- ---------------------------------------------------------------------------
-- Registers a task, or changes every_minutes of a task the same function
-- already owns. Refuses a function that does not exist, takes arguments or
-- does not return jsonb, and a name already taken by another function.
create function authz.timer_task_register(p_name text, p_function_name text, p_every_minutes integer) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_proc regprocedure;
  v_existing text;
begin
  if p_name is null or p_name !~ '^[a-z_]{3,40}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'name';
  end if;
  if p_function_name is null or p_function_name !~ '^(authz|public)\.[a-z_]+$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'function_name';
  end if;
  v_proc := to_regprocedure(p_function_name || '()');
  if v_proc is null
     or (select p.prorettype from pg_catalog.pg_proc p where p.oid = v_proc) <> 'jsonb'::regtype then
    raise exception 'invalid_input' using errcode = '22023', hint = 'function_name';
  end if;
  if p_every_minutes is null or p_every_minutes not between 1 and 1440 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'every_minutes';
  end if;
  select t.function_name into v_existing from public.timer_tasks t where t.name = p_name for update;
  if v_existing is null then
    insert into public.timer_tasks (name, function_name, every_minutes) values (p_name, p_function_name, p_every_minutes);
  elsif v_existing <> p_function_name then
    raise exception 'invalid_input' using errcode = '22023', hint = 'name';
  else
    update public.timer_tasks t set every_minutes = p_every_minutes where t.name = p_name;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- The tick
-- ---------------------------------------------------------------------------
-- Runs every enabled task that is due (never run, or last run at least
-- every_minutes ago, with 20 seconds of slack for a minute clock). Each task
-- runs under its own savepoint; its error is kept as a code. One tick at a
-- time (transaction advisory lock): a second concurrent call returns
-- {status: 'busy'}. Returns counts only. Does not read the timer switch: the
-- switch stops the scheduled call (authz.run_scheduled_timer); a direct call
-- with the bearer (local script, tests) always runs.
create function public.timer_tick() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_started timestamptz := clock_timestamp();
  v_task record;
  v_result jsonb;
  v_code text;
  v_results jsonb := '{}'::jsonb;
  v_ran integer := 0;
  v_failed integer := 0;
  v_pruned integer;
begin
  if not pg_try_advisory_xact_lock(hashtextextended('tripnavigate.timer_tick', 0)) then
    return jsonb_build_object('status', 'busy');
  end if;

  delete from public.timer_runs r where r.started_at < now() - interval '14 days';
  get diagnostics v_pruned = row_count;

  for v_task in
    select t.name, t.function_name
    from public.timer_tasks t
    where t.enabled
      and (t.last_run_at is null
           or t.last_run_at <= now() - make_interval(mins => t.every_minutes) + interval '20 seconds')
    order by t.name
  loop
    v_result := null;
    v_code := null;
    -- A rule recorded by an earlier task must not leak into this one.
    perform set_config('tripnavigate.system_rule', '', true);
    begin
      if to_regprocedure(v_task.function_name || '()') is null then
        v_code := 'missing_function';
      else
        -- function_name is pattern-checked (schema.name, lower case and _ only).
        execute format('select %s()', v_task.function_name) into v_result;
        if v_result is null then
          v_result := '{}'::jsonb;
        elsif jsonb_typeof(v_result) <> 'object' then
          v_result := null;
          v_code := 'bad_result';
        end if;
      end if;
    exception when others then
      v_result := null;
      v_code := sqlstate;
    end;
    v_ran := v_ran + 1;
    if v_code is not null then
      v_failed := v_failed + 1;
    end if;
    update public.timer_tasks t
    set last_run_at = now(), last_result = v_result, last_error_code = v_code
    where t.name = v_task.name;
    v_results := v_results || jsonb_build_object(v_task.name,
      coalesce(v_result, jsonb_build_object('errorCode', v_code)));
  end loop;

  insert into public.timer_runs (started_at, finished_at, results, error_code)
  values (v_started, clock_timestamp(), v_results, case when v_failed > 0 then 'task_failed' end);
  update public.timer_settings s set last_ok_at = now() where s.id;

  return jsonb_build_object('status', 'ok', 'ran', v_ran, 'failed', v_failed, 'pruned', v_pruned,
    'tasks', v_results);
end;
$$;

-- ---------------------------------------------------------------------------
-- Task timer_health (5.2 "Stalled check")
-- ---------------------------------------------------------------------------
-- Inserts a timer_alerts row (at most one per kind and India-time hour) when
-- the previous tick finished more than 15 minutes ago, or the oldest due
-- customer message or push job has waited more than 15 minutes. The queue
-- tables belong to later migrations (customer_messages: track A 0110;
-- staff_push_jobs: track D) and are read only once they exist.
create function authz.timer_health() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_hour text := to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24');
  v_last timestamptz;
  v_minutes integer;
  v_alerts integer := 0;
  v_n integer;
begin
  select s.last_ok_at into v_last from public.timer_settings s where s.id;
  if v_last is not null and v_last < now() - interval '15 minutes' then
    insert into public.timer_alerts (kind, oldest_minutes, hour_key)
    values ('timer_late', floor(extract(epoch from now() - v_last) / 60)::integer, v_hour)
    on conflict (kind, hour_key) do nothing;
    get diagnostics v_n = row_count;
    v_alerts := v_alerts + v_n;
  end if;

  if to_regclass('public.customer_messages') is not null then
    execute $q$
      select floor(extract(epoch from now() - min(greatest(m.next_attempt_at, m.not_before))) / 60)::integer
      from public.customer_messages m
      where m.status = 'queued' and m.next_attempt_at <= now() and m.not_before <= now()
    $q$ into v_minutes;
    if v_minutes > 15 then
      insert into public.timer_alerts (kind, oldest_minutes, hour_key) values ('message_queue_late', v_minutes, v_hour)
      on conflict (kind, hour_key) do nothing;
      get diagnostics v_n = row_count;
      v_alerts := v_alerts + v_n;
    end if;
  end if;

  v_minutes := null;
  if to_regclass('public.staff_push_jobs') is not null then
    execute $q$
      select floor(extract(epoch from now() - min(j.available_at)) / 60)::integer
      from public.staff_push_jobs j
      where j.status = 'queued' and j.available_at <= now()
    $q$ into v_minutes;
    if v_minutes > 15 then
      insert into public.timer_alerts (kind, oldest_minutes, hour_key) values ('push_queue_late', v_minutes, v_hour)
      on conflict (kind, hour_key) do nothing;
      get diagnostics v_n = row_count;
      v_alerts := v_alerts + v_n;
    end if;
  end if;

  return jsonb_build_object('alerts', v_alerts);
end;
$$;

-- ===========================================================================
-- 5. Scheduler pieces (copies of the Bitrix sync pattern, 20261107000100)
-- ===========================================================================

-- Sends one POST to the timer route. Returns the pg_net request id, or null
-- when pg_net or Vault is missing or a Vault value is missing (nothing is
-- sent). Secret values never leave this function except in the request.
create function authz.dispatch_timer() returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_url text;
  v_bearer text;
  v_bypass text;
  v_headers jsonb;
begin
  if to_regclass('vault.decrypted_secrets') is null or to_regnamespace('net') is null then
    return null;
  end if;
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'crm_timer_url';
  select s.decrypted_secret into v_bearer from vault.decrypted_secrets s where s.name = 'crm_timer_bearer';
  select s.decrypted_secret into v_bypass from vault.decrypted_secrets s where s.name = 'vercel_protection_bypass';
  v_url := nullif(btrim(v_url), '');
  v_bearer := nullif(btrim(v_bearer), '');
  if v_url is null or v_bearer is null or v_url !~ '^https?://[^\s?#]+$' then
    return null;
  end if;

  v_headers := jsonb_build_object(
    'Authorization', 'Bearer ' || v_bearer,
    'Content-Type', 'application/json');
  if nullif(btrim(v_bypass), '') is not null then
    v_headers := v_headers || jsonb_build_object('x-vercel-protection-bypass', btrim(v_bypass));
  end if;

  return net.http_post(
    url := v_url,
    headers := v_headers,
    body := '{}'::jsonb,
    -- The route is bounded to 55 s (maxDuration).
    timeout_milliseconds := 60000);
end;
$$;

-- Cron entry point. Skips while the timer switch is Off, and while the
-- previous request is still unanswered and younger than 2 minutes.
create function authz.run_scheduled_timer() returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_settings public.timer_settings%rowtype;
  v_id bigint;
  v_answered boolean;
begin
  select * into v_settings from public.timer_settings s where s.id for update skip locked;
  if v_settings.id is null or not v_settings.enabled then
    return;
  end if;
  if v_settings.last_request_id is not null
     and v_settings.last_dispatched_at > now() - interval '2 minutes'
     and to_regclass('net._http_response') is not null then
    -- Dynamic: the statement must not name pg_net's table where it is missing.
    execute 'select exists (select 1 from net._http_response r where r.id = $1)'
      into v_answered using v_settings.last_request_id;
    if not v_answered then
      return;
    end if;
  end if;
  v_id := authz.dispatch_timer();
  if v_id is not null then
    update public.timer_settings s
    set last_request_id = v_id, last_dispatched_at = now()
    where s.id;
  end if;
end;
$$;

-- Operator step only (each step needs the owner's approval for the exact database):
--   1. create extension if not exists pg_cron;
--      create extension if not exists pg_net with schema extensions;
--   2. select authz.provision_timer_job();                    -- job exists, paused
--   3. Vault values crm_timer_url, crm_timer_bearer (and vercel_protection_bypass)
--   4. select cron.alter_job(j.jobid, active := true) from cron.job j where j.jobname = 'crm-timer';
--   5. select public.admin_set_timer_enabled(true, '<reason>');  (Super Admin)
-- Pause again with step 5 (false) or cron.alter_job(..., active := false).
-- A job that already exists under the name is left exactly as it is.
create function authz.provision_timer_job() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id bigint;
  v_result jsonb;
begin
  if to_regclass('cron.job') is null then
    raise exception 'pg_cron is not installed' using errcode = '55000';
  end if;
  execute 'select j.jobid from cron.job j where j.jobname = $1' into v_id using 'crm-timer';
  if v_id is null then
    execute 'select cron.schedule($1, $2, $3)' into v_id
      using 'crm-timer', '* * * * *', 'select authz.run_scheduled_timer()';
    execute 'select cron.alter_job($1, active := false)' using v_id;
  end if;
  execute $q$
    select coalesce(jsonb_agg(jsonb_build_object('jobname', j.jobname, 'schedule', j.schedule, 'active', j.active)
                              order by j.jobname), '[]'::jsonb)
    from cron.job j where j.jobname = 'crm-timer'
  $q$ into v_result;
  return v_result;
end;
$$;

-- ===========================================================================
-- 6. A11 admin_set_timer_enabled (Super Admin)
-- ===========================================================================

create function public.admin_set_timer_enabled(p_enabled boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before boolean;
  v_after public.timer_settings%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''), E' \t\r\n');
  v_prev text[];
begin
  if not authz.can_switch_live_settings(null) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if char_length(v_reason) < 10 or char_length(v_reason) > 500 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  if p_enabled is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'enabled';
  end if;
  select s.enabled into v_before from public.timer_settings s where s.id for update;
  if not found then
    raise exception 'settings row missing' using errcode = '55000';
  end if;

  v_prev := authz.settings_begin_change('admin_set_timer_enabled', v_reason);
  update public.timer_settings s set enabled = p_enabled, updated_by = (select auth.uid())
  where s.id returning * into v_after;
  perform authz.settings_end_change(v_prev);

  return jsonb_build_object('changed', v_before is distinct from v_after.enabled,
    'before', v_before, 'after', v_after.enabled, 'updatedAt', v_after.updated_at);
end;
$$;

-- ===========================================================================
-- 7. Registration of track A's foundation task and privileges
-- ===========================================================================

select authz.timer_task_register('timer_health', 'authz.timer_health', 5);

revoke all on function
  authz.system_rule_ok(text),
  authz.system_rule(text),
  authz.write_system_audit(text, uuid, uuid, text, uuid, text, jsonb),
  authz.audit_settings_columns(),
  authz.timer_settings_touch(),
  authz.timer_settings_guard(),
  authz.timer_tasks_guard(),
  authz.timer_runs_guard(),
  authz.timer_alerts_guard(),
  authz.timer_task_register(text, text, integer),
  authz.timer_health(),
  authz.dispatch_timer(),
  authz.run_scheduled_timer(),
  authz.provision_timer_job(),
  public.timer_tick(),
  public.admin_set_timer_enabled(boolean, text)
from public, anon, authenticated, service_role;

-- Worker entry point: the timer route and the local script only.
grant execute on function public.timer_tick() to service_role;
-- Super Admin switch (the command checks the role itself).
grant execute on function public.admin_set_timer_enabled(boolean, text) to authenticated;

commit;
