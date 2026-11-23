-- TripNavigate CRM - Accounts phase 3, track D (1 of 2): closed-browser alerts
-- (Web Push), per person and per device, opt-in.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 8.1-8.5, 13, 14
-- ("Push devices": own only; switch: Super Admin), 17.2 (switch Off), 17.3,
-- 21 LD19, LD20; Addendum L1 (web-push 3.6.7).
--
-- 1. notice_settings.push_enabled (default false). The notices audit trigger
--    is re-created to watch the new column too (settings.notices_changed).
-- 2. staff_push_devices: one row per browser subscription of one person.
--    endpoint, p256dh and auth_key are never returned by any staff read and
--    never written to an audit row. At most 10 active devices per person; an
--    endpoint registered by another person moves to the new person (old row
--    removed 'moved'). No DELETE; removed is final.
-- 3. staff_push_jobs: one job per (notice, active device of the recipient),
--    written by a statement-level AFTER INSERT trigger on staff_notices while
--    the switch is on, for urgent notices and for task_new / task_assigned
--    (LD20, 8.2). Test jobs (D4) carry no notice. Jobs older than 7 days are
--    removed by the timer task push_cleanup. Track A's timer_health reads
--    status and available_at.
-- 4. push_kick_state + authz.push_kick(): a statement-level trigger on
--    staff_push_jobs posts once to Vault crm_push_url with the timer bearer
--    (crm_timer_bearer; optional vercel_protection_bypass) when pg_net and the
--    Vault values exist, at most once per 5 seconds. Guarded: never fails the
--    step that wrote the notice; nothing happens on a stack without pg_net.
-- 5. Commands (staff, own session): D1 push_device_register, D2
--    push_device_remove / push_device_remove_current (sign-out), D3
--    push_devices_list, D4 push_test_send (at most 3 per person per 10
--    minutes), D5 admin_set_push_enabled (Super Admin, reason).
--    Worker (service_role only): W-D1 push_claim, push_complete.
-- 6. Timer task push_cleanup (daily): devices unused for 60 days ->
--    unused_60_days; devices of people no longer active -> access_lost; jobs
--    older than 7 days removed.
--
-- Claim re-check (8.2): the notice is still visible to the recipient
-- (authz.staff_notice_visible), unread, not done, unresolved; the person and
-- the device are active; notices and push are still on. Otherwise the job is
-- 'dropped'. 404 / 410 from the push service removes the device ('gone');
-- other failures are retried at +30 s and +2 min, then 'failed'.
--
-- push_claim returns, per job, the bell item of the notice
-- (authz.notice_item_json) and never a rendered text: the payload
-- {title, body, tag, url} is built in TypeScript by buildPushPayload with
-- noticeText() and noticeHref() (S/modules/notices), the single source of the
-- bell text (8.2). The endpoint and keys leave the database only here, only to
-- the server worker.
--
-- Refusal tokens: push_off (55000), push_too_many_devices (55000),
-- not_authorized (42501), not_found (P0002), invalid_input (22023, hint names
-- the field), not_ready (55000, hint 'test_limit': more than 3 test alerts in
-- 10 minutes).
-- Audit: notices.push_device_added | push_device_removed | push_test_sent
-- ({deviceId} and the removal reason only - never the endpoint or keys);
-- settings.notices_changed (column names, by the settings trigger).
--
-- Rollback (forward-only): a NEW migration dropping the triggers on
-- staff_notices / staff_push_jobs, the timer task row (disable it), the
-- functions and tables created here and the push_enabled column, and
-- re-creating notice_settings_audit with 'notices_enabled' only.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Switch
-- ===========================================================================

alter table public.notice_settings add column push_enabled boolean not null default false;

drop trigger notice_settings_audit on public.notice_settings;
create trigger notice_settings_audit
  after insert or update or delete on public.notice_settings
  for each row execute function authz.audit_settings_change('settings.notices_changed', 'notices_enabled', 'push_enabled');

-- The closed-browser alerts switch alone (push_off follows it). Notices themselves are written only while
-- notices_enabled is on, so no job exists for a notice while notices are Off; a test alert (D4) needs push only.
create function authz.push_enabled() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.push_enabled from public.notice_settings s where s.id), false)
$$;

-- ===========================================================================
-- 2. Devices
-- ===========================================================================

create table public.staff_push_devices (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.staff_profiles (user_id),
  endpoint text not null check (char_length(endpoint) between 9 and 1000 and endpoint ~ '^https://[^[:space:]]+$'),
  -- sha256 hex of the endpoint: "this device" in D3 is matched by it.
  endpoint_hash text not null check (endpoint_hash ~ '^[0-9a-f]{64}$'),
  p256dh text not null check (p256dh ~ '^[A-Za-z0-9_-]{20,200}={0,2}$'),
  auth_key text not null check (auth_key ~ '^[A-Za-z0-9_-]{16,64}={0,2}$'),
  label text not null check (char_length(label) between 1 and 60 and label !~ '[[:cntrl:]]'),
  status text not null default 'active' check (status in ('active', 'removed')),
  request_id uuid not null,
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  removed_at timestamptz,
  removed_reason text check (removed_reason in ('user', 'signed_out', 'unused_60_days', 'gone', 'access_lost', 'moved')),
  unique (user_id, request_id),
  check ((status = 'removed') = (removed_at is not null and removed_reason is not null))
);
create unique index staff_push_devices_endpoint_active on public.staff_push_devices (endpoint) where status = 'active';
create index staff_push_devices_user_active on public.staff_push_devices (user_id) where status = 'active';
create index staff_push_devices_user_idx on public.staff_push_devices (user_id, created_at desc);
create index staff_push_devices_cleanup_idx on public.staff_push_devices (coalesce(last_used_at, created_at)) where status = 'active';
comment on table public.staff_push_devices is
  'Closed-browser alert subscriptions (Accounts phase 3, 8.1): one row per browser of one person, opt-in. endpoint, p256dh and auth_key are read only by public.push_claim (service_role) and never returned by a staff read or written to an audit row. No DELETE; removed is final.';

create function authz.staff_push_devices_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'push devices cannot be deleted' using errcode = '42501';
  end if;
  if new.id <> old.id or new.user_id <> old.user_id or new.endpoint <> old.endpoint
     or new.endpoint_hash <> old.endpoint_hash or new.request_id <> old.request_id or new.created_at <> old.created_at then
    raise exception 'a push device keeps its owner and endpoint' using errcode = '42501';
  end if;
  if old.status = 'removed' and (to_jsonb(new) <> to_jsonb(old)) then
    raise exception 'a removed push device is final' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger staff_push_devices_a_guard before update or delete on public.staff_push_devices
  for each row execute function authz.staff_push_devices_guard();
create trigger staff_push_devices_no_truncate before truncate on public.staff_push_devices
  for each statement execute function authz.refuse_settings_truncate();

-- ===========================================================================
-- 3. Jobs
-- ===========================================================================

create table public.staff_push_jobs (
  id uuid primary key default gen_random_uuid(),
  -- null only for a test alert (D4).
  notice_id uuid references public.staff_notices (id),
  device_id uuid not null references public.staff_push_devices (id),
  user_id uuid not null references public.staff_profiles (user_id),
  is_test boolean not null default false,
  urgent boolean not null default false,
  request_id uuid,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'dropped')),
  attempts integer not null default 0 check (attempts between 0 and 3),
  available_at timestamptz not null default now(),
  lease_owner text check (char_length(lease_owner) between 1 and 60),
  lease_until timestamptz,
  last_error_code text check (last_error_code ~ '^[a-z0-9_]{1,40}$'),
  sent_at timestamptz,
  created_at timestamptz not null default now(),
  unique (notice_id, device_id),
  unique (user_id, request_id),
  check (is_test = (notice_id is null)),
  check (is_test = (request_id is not null)),
  check (status <> 'sending' or (lease_owner is not null and lease_until is not null))
);
create index staff_push_jobs_queue_idx on public.staff_push_jobs (available_at) where status in ('queued', 'sending');
create index staff_push_jobs_device_idx on public.staff_push_jobs (device_id);
create index staff_push_jobs_user_test_idx on public.staff_push_jobs (user_id, created_at) where is_test;
create index staff_push_jobs_created_idx on public.staff_push_jobs (created_at);
comment on table public.staff_push_jobs is
  'Closed-browser alert queue (Accounts phase 3, 8.1-8.3). Written by the staff_notices trigger (urgent, task_new, task_assigned) and by push_test_send; claimed by public.push_claim (service_role). Rows older than 7 days are removed by the timer task push_cleanup.';

create function authz.staff_push_jobs_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.created_at >= now() - interval '7 days' then
      raise exception 'push jobs are kept for 7 days' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.id <> old.id or new.notice_id is distinct from old.notice_id or new.device_id <> old.device_id
     or new.user_id <> old.user_id or new.is_test <> old.is_test or new.urgent <> old.urgent
     or new.request_id is distinct from old.request_id or new.created_at <> old.created_at then
    raise exception 'a push job keeps its notice and device' using errcode = '42501';
  end if;
  if old.status in ('sent', 'failed', 'dropped') then
    raise exception 'a finished push job is final' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger staff_push_jobs_a_guard before update or delete on public.staff_push_jobs
  for each row execute function authz.staff_push_jobs_guard();

-- ===========================================================================
-- 4. The kick (within seconds; the minute timer is the backstop)
-- ===========================================================================

create table public.push_kick_state (
  id boolean primary key default true check (id),
  last_kick_at timestamptz,
  last_request_id bigint
);
insert into public.push_kick_state (id) values (true);
comment on table public.push_kick_state is
  'Single row: when authz.push_kick last posted to the push route (at most once per 5 seconds). No content.';

create function authz.push_kick_state_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'push kick state cannot be deleted' using errcode = '42501';
end;
$$;
create trigger push_kick_state_a_guard before delete on public.push_kick_state
  for each row execute function authz.push_kick_state_guard();

-- Posts once to the push route when pg_net and the Vault values exist. Never
-- raises: an error or a missing piece means the timer sends the job instead.
create function authz.push_kick() returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_state public.push_kick_state%rowtype;
  v_url text;
  v_bearer text;
  v_bypass text;
  v_headers jsonb;
  v_id bigint;
begin
  if to_regclass('vault.decrypted_secrets') is null or to_regnamespace('net') is null then
    return false;
  end if;
  begin
    -- A kick already in flight in another transaction is enough.
    select * into v_state from public.push_kick_state s where s.id for update skip locked;
    if v_state.id is null or (v_state.last_kick_at is not null and v_state.last_kick_at > now() - interval '5 seconds') then
      return false;
    end if;
    select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'crm_push_url';
    select s.decrypted_secret into v_bearer from vault.decrypted_secrets s where s.name = 'crm_timer_bearer';
    select s.decrypted_secret into v_bypass from vault.decrypted_secrets s where s.name = 'vercel_protection_bypass';
    v_url := nullif(btrim(v_url), '');
    v_bearer := nullif(btrim(v_bearer), '');
    if v_url is null or v_bearer is null or v_url !~ '^https?://[^\s?#]+$' then
      return false;
    end if;
    v_headers := jsonb_build_object('Authorization', 'Bearer ' || v_bearer, 'Content-Type', 'application/json');
    if nullif(btrim(v_bypass), '') is not null then
      v_headers := v_headers || jsonb_build_object('x-vercel-protection-bypass', btrim(v_bypass));
    end if;
    v_id := net.http_post(url := v_url, headers := v_headers, body := '{}'::jsonb, timeout_milliseconds := 30000);
    update public.push_kick_state s set last_kick_at = now(), last_request_id = v_id where s.id;
    return true;
  exception when others then
    return false;
  end;
end;
$$;

create function authz.push_jobs_kick() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform authz.push_kick();
  return null;
end;
$$;
create trigger staff_push_jobs_kick after insert on public.staff_push_jobs
  for each statement execute function authz.push_jobs_kick();

-- One job per active device of the recipient for urgent notices and new /
-- assigned tasks, while notices and push are on (8.2). Set-based.
create function authz.push_jobs_on_notices() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not authz.push_enabled() then
    return null;
  end if;
  insert into public.staff_push_jobs (notice_id, device_id, user_id, urgent)
  select n.id, d.id, d.user_id, n.priority = 'urgent'
  from inserted n
  join public.staff_push_devices d on d.user_id = n.recipient_user_id and d.status = 'active'
  where n.priority = 'urgent' or n.kind in ('task_new', 'task_assigned')
  order by n.seq, d.id
  on conflict (notice_id, device_id) do nothing;
  return null;
end;
$$;
create trigger staff_notices_push_jobs after insert on public.staff_notices
  referencing new table as inserted
  for each statement execute function authz.push_jobs_on_notices();

-- ===========================================================================
-- 5. RLS (no direct API access; everything goes through the commands)
-- ===========================================================================

alter table public.staff_push_devices enable row level security;
alter table public.staff_push_jobs enable row level security;
alter table public.push_kick_state enable row level security;
create policy require_valid_session on public.staff_push_devices as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
create policy require_valid_session on public.staff_push_jobs as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
create policy require_valid_session on public.push_kick_state as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.staff_push_devices, public.staff_push_jobs, public.push_kick_state
from public, anon, authenticated, service_role;

-- ===========================================================================
-- 6. Staff commands (own session; own devices only)
-- ===========================================================================

create function authz.push_endpoint_hash(p_endpoint text) returns text
language sql immutable set search_path = '' as $$
  select encode(pg_catalog.sha256(pg_catalog.convert_to(p_endpoint, 'UTF8')), 'hex')
$$;

-- D1. Register this browser for the caller. Idempotent on the request id and on
-- the caller's own active endpoint (keys and label refreshed).
create function public.push_device_register(p_endpoint text, p_p256dh text, p_auth_key text, p_label text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_label text := btrim(coalesce(p_label, ''));
  v_dev public.staff_push_devices%rowtype;
  v_other public.staff_push_devices%rowtype;
  v_count integer;
begin
  if not coalesce(authz.session_ok(), false) or v_uid is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if p_endpoint is null or char_length(p_endpoint) not between 9 and 1000 or p_endpoint !~ '^https://[^[:space:]]+$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'endpoint';
  end if;
  if p_p256dh is null or p_p256dh !~ '^[A-Za-z0-9_-]{20,200}={0,2}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'p256dh';
  end if;
  if p_auth_key is null or p_auth_key !~ '^[A-Za-z0-9_-]{16,64}={0,2}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'authKey';
  end if;
  if char_length(v_label) not between 1 and 60 or v_label ~ '[[:cntrl:]]' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'label';
  end if;

  -- One registration at a time per person (the 10-device rule), then per endpoint.
  perform pg_advisory_xact_lock(hashtextextended('tripnavigate.push_user:' || v_uid::text, 0));
  perform pg_advisory_xact_lock(hashtextextended('tripnavigate.push_endpoint:' || authz.push_endpoint_hash(p_endpoint), 0));

  select * into v_dev from public.staff_push_devices d where d.user_id = v_uid and d.request_id = p_request_id;
  if v_dev.id is not null then
    return jsonb_build_object('outcome', 'existing', 'deviceId', v_dev.id);
  end if;
  if not authz.push_enabled() then
    raise exception 'push_off' using errcode = '55000';
  end if;

  select * into v_other from public.staff_push_devices d where d.endpoint = p_endpoint and d.status = 'active' for update;
  if v_other.id is not null and v_other.user_id = v_uid then
    update public.staff_push_devices d set p256dh = p_p256dh, auth_key = p_auth_key, label = v_label
    where d.id = v_other.id;
    return jsonb_build_object('outcome', 'existing', 'deviceId', v_other.id);
  end if;

  select count(*) into v_count from public.staff_push_devices d where d.user_id = v_uid and d.status = 'active';
  if v_count >= 10 then
    raise exception 'push_too_many_devices' using errcode = '55000';
  end if;

  if v_other.id is not null then
    -- The browser now belongs to the caller (LD20: an endpoint belongs to one person).
    perform authz.push_device_remove_row(v_other, 'moved');
  end if;

  insert into public.staff_push_devices (user_id, endpoint, endpoint_hash, p256dh, auth_key, label, request_id)
  values (v_uid, p_endpoint, authz.push_endpoint_hash(p_endpoint), p_p256dh, p_auth_key, v_label, p_request_id)
  returning * into v_dev;
  perform authz.write_audit('notices.push_device_added', null, null, 'staff_push_device', v_dev.id, null,
    jsonb_build_object('deviceId', v_dev.id));
  return jsonb_build_object('outcome', 'created', 'deviceId', v_dev.id);
end;
$$;

create function authz.push_device_remove_row(p_device public.staff_push_devices, p_reason text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.staff_push_devices d set status = 'removed', removed_at = now(), removed_reason = p_reason
  where d.id = p_device.id and d.status = 'active';
  if found then
    -- Queued alerts for the device are not sent.
    update public.staff_push_jobs j set status = 'dropped', lease_owner = null, lease_until = null,
      last_error_code = 'device_removed'
    where j.device_id = p_device.id and j.status = 'queued';
    perform authz.write_audit('notices.push_device_removed', null, null, 'staff_push_device', p_device.id, null,
      jsonb_build_object('deviceId', p_device.id, 'reason', p_reason));
  end if;
end;
$$;

-- D2. Remove one of the caller's own devices ("Remove" in the device list).
create function public.push_device_remove(p_device_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_dev public.staff_push_devices%rowtype;
begin
  if not coalesce(authz.session_ok(), false) or v_uid is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_device_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'deviceId';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into v_dev from public.staff_push_devices d where d.id = p_device_id and d.user_id = v_uid for update;
  if v_dev.id is null then
    -- Another person's device answers like a missing one.
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_dev.status = 'removed' then
    return jsonb_build_object('outcome', 'existing', 'deviceId', v_dev.id);
  end if;
  perform authz.push_device_remove_row(v_dev, 'user');
  return jsonb_build_object('outcome', 'updated', 'deviceId', v_dev.id);
end;
$$;

-- D2 (sign-out). Removes the caller's active device for this browser's endpoint, if any.
create function public.push_device_remove_current(p_endpoint text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_dev public.staff_push_devices%rowtype;
begin
  if not coalesce(authz.session_ok(), false) or v_uid is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_endpoint is null or char_length(p_endpoint) not between 9 and 1000 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'endpoint';
  end if;
  select * into v_dev from public.staff_push_devices d
  where d.endpoint = p_endpoint and d.user_id = v_uid and d.status = 'active' for update;
  if v_dev.id is null then
    return jsonb_build_object('removed', 0);
  end if;
  perform authz.push_device_remove_row(v_dev, 'signed_out');
  return jsonb_build_object('removed', 1);
end;
$$;

-- D3. The caller's own active devices; never an endpoint or key.
create function public.push_devices_list(p_endpoint_hash text default null) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_hash text := lower(nullif(btrim(coalesce(p_endpoint_hash, '')), ''));
begin
  if not coalesce(authz.session_ok(), false) or v_uid is null then
    return null;
  end if;
  if v_hash is not null and v_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'endpointHash';
  end if;
  return jsonb_build_object(
    'enabled', authz.push_enabled(),
    'devices', coalesce((
      select jsonb_agg(jsonb_build_object(
               'deviceId', d.id, 'label', d.label, 'createdAt', d.created_at, 'lastUsedAt', d.last_used_at,
               'thisDevice', v_hash is not null and d.endpoint_hash = v_hash)
             order by d.created_at desc, d.id)
      from public.staff_push_devices d where d.user_id = v_uid and d.status = 'active'), '[]'::jsonb));
end;
$$;

-- D4. One test alert to one of the caller's own devices; at most 3 per person per 10 minutes.
create function public.push_test_send(p_device_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_dev public.staff_push_devices%rowtype;
  v_job public.staff_push_jobs%rowtype;
  v_recent integer;
begin
  if not coalesce(authz.session_ok(), false) or v_uid is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_device_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'deviceId';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('tripnavigate.push_user:' || v_uid::text, 0));
  select * into v_job from public.staff_push_jobs j where j.user_id = v_uid and j.request_id = p_request_id;
  if v_job.id is not null then
    return jsonb_build_object('outcome', 'existing', 'jobId', v_job.id, 'deviceId', v_job.device_id);
  end if;
  if not authz.push_enabled() then
    raise exception 'push_off' using errcode = '55000';
  end if;
  select * into v_dev from public.staff_push_devices d where d.id = p_device_id and d.user_id = v_uid and d.status = 'active';
  if v_dev.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select count(*) into v_recent from public.staff_push_jobs j
  where j.user_id = v_uid and j.is_test and j.created_at > now() - interval '10 minutes';
  if v_recent >= 3 then
    raise exception 'not_ready' using errcode = '55000', hint = 'test_limit';
  end if;
  insert into public.staff_push_jobs (notice_id, device_id, user_id, is_test, urgent, request_id)
  values (null, v_dev.id, v_uid, true, true, p_request_id)
  returning * into v_job;
  perform authz.write_audit('notices.push_test_sent', null, null, 'staff_push_device', v_dev.id, null,
    jsonb_build_object('deviceId', v_dev.id));
  return jsonb_build_object('outcome', 'created', 'jobId', v_job.id, 'deviceId', v_dev.id);
end;
$$;

-- D5. Super Admin switch (reason 10..500; audited by the settings trigger).
create function public.admin_set_push_enabled(p_enabled boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before boolean;
  v_after public.notice_settings%rowtype;
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
  select s.push_enabled into v_before from public.notice_settings s where s.id for update;
  if not found then
    raise exception 'settings row missing' using errcode = '55000';
  end if;
  v_prev := authz.settings_begin_change('admin_set_push_enabled', v_reason);
  update public.notice_settings s set push_enabled = p_enabled, updated_by = (select auth.uid())
  where s.id returning * into v_after;
  perform authz.settings_end_change(v_prev);
  return jsonb_build_object('changed', v_before is distinct from v_after.push_enabled,
    'before', v_before, 'after', v_after.push_enabled, 'updatedAt', v_after.updated_at);
end;
$$;

-- ===========================================================================
-- 7. Worker (service_role only)
-- ===========================================================================

-- W-D1 claim: due jobs (queued, or sending with a lapsed lease), skip locked.
-- Re-checks every job (push and, for a notice, notices still on); a job that must not be sent is 'dropped'.
create function public.push_claim(p_worker text, p_limit integer, p_lease_seconds integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r record;
  v_out jsonb := '[]'::jsonb;
  v_ok boolean;
  v_on boolean := authz.push_enabled();
begin
  if p_worker is null or char_length(p_worker) not between 1 and 60 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'worker';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'limit';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 10 and 600 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'leaseSeconds';
  end if;
  for r in
    select j.id as job_id, j.is_test, j.urgent, j.attempts,
           d.id as device_id, d.status as device_status, d.endpoint, d.p256dh, d.auth_key,
           p.status as person_status, n as notice
    from (select x.id from public.staff_push_jobs x
          where x.available_at <= now()
            and (x.status = 'queued' or (x.status = 'sending' and x.lease_until < now()))
          order by x.available_at, x.id
          limit p_limit
          for update skip locked) q
    join public.staff_push_jobs j on j.id = q.id
    join public.staff_push_devices d on d.id = j.device_id
    join public.staff_profiles p on p.user_id = j.user_id
    left join public.staff_notices n on n.id = j.notice_id
    order by j.available_at, j.id
  loop
    v_ok := v_on and r.device_status = 'active' and r.person_status = 'active' and r.attempts < 3;
    if v_ok and not r.is_test then
      v_ok := authz.notices_enabled() and (r.notice).id is not null and (r.notice).read_at is null and (r.notice).done_at is null
        and (r.notice).resolved_at is null
        and authz.staff_notice_visible((r.notice).recipient_user_id, (r.notice).kind, (r.notice).legal_entity_id,
              (r.notice).deal_id, (r.notice).task_id, (r.notice).subject_kind, (r.notice).subject_id);
    end if;
    if not v_ok then
      update public.staff_push_jobs j set status = 'dropped', lease_owner = null, lease_until = null,
        last_error_code = 'not_deliverable'
      where j.id = r.job_id;
      continue;
    end if;
    update public.staff_push_jobs j
    set status = 'sending', attempts = j.attempts + 1, lease_owner = p_worker,
        lease_until = now() + make_interval(secs => p_lease_seconds)
    where j.id = r.job_id;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'jobId', r.job_id,
      'endpoint', r.endpoint,
      'p256dh', r.p256dh,
      'authKey', r.auth_key,
      'test', r.is_test,
      'urgent', r.urgent,
      'notice', case when r.is_test then null else authz.notice_item_json(r.notice) end));
  end loop;
  return v_out;
end;
$$;

-- W-D1 complete. p_status_code: the push service's HTTP status (null = no answer).
create function public.push_complete(p_job_id uuid, p_worker text, p_ok boolean, p_status_code integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.staff_push_jobs%rowtype;
  v_dev public.staff_push_devices%rowtype;
  v_code text;
begin
  if p_job_id is null or p_worker is null or p_ok is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'job';
  end if;
  select * into v_job from public.staff_push_jobs j where j.id = p_job_id for update;
  if v_job.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_job.status <> 'sending' or v_job.lease_owner is distinct from p_worker then
    -- The lease ran out and another worker owns the job now.
    return jsonb_build_object('outcome', 'stale', 'status', v_job.status);
  end if;
  if p_ok then
    update public.staff_push_jobs j set status = 'sent', sent_at = now(), lease_owner = null, lease_until = null,
      last_error_code = null
    where j.id = v_job.id;
    update public.staff_push_devices d set last_used_at = now() where d.id = v_job.device_id and d.status = 'active';
    return jsonb_build_object('outcome', 'sent');
  end if;
  if p_status_code in (404, 410) then
    update public.staff_push_jobs j set status = 'failed', lease_owner = null, lease_until = null, last_error_code = 'gone'
    where j.id = v_job.id;
    select * into v_dev from public.staff_push_devices d where d.id = v_job.device_id for update;
    perform authz.push_device_remove_row(v_dev, 'gone');
    return jsonb_build_object('outcome', 'gone');
  end if;
  v_code := case when p_status_code is null then 'network'
                 when p_status_code between 100 and 599 then 'http_' || p_status_code
                 else 'bad_status' end;
  if v_job.attempts >= 3 then
    update public.staff_push_jobs j set status = 'failed', lease_owner = null, lease_until = null, last_error_code = v_code
    where j.id = v_job.id;
    return jsonb_build_object('outcome', 'failed');
  end if;
  -- Retries at +30 s (after the first try) and +2 min (after the second).
  update public.staff_push_jobs j
  set status = 'queued', lease_owner = null, lease_until = null, last_error_code = v_code,
      available_at = now() + case when v_job.attempts <= 1 then interval '30 seconds' else interval '2 minutes' end
  where j.id = v_job.id;
  return jsonb_build_object('outcome', 'retry');
end;
$$;

-- ===========================================================================
-- 8. Timer task push_cleanup (daily)
-- ===========================================================================

create function authz.push_cleanup() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r record;
  v_unused integer := 0;
  v_lost integer := 0;
  v_jobs integer;
begin
  for r in
    select d.*, (p.status is distinct from 'active') as lost
    from public.staff_push_devices d
    join public.staff_profiles p on p.user_id = d.user_id
    where d.status = 'active'
      and (p.status is distinct from 'active' or coalesce(d.last_used_at, d.created_at) < now() - interval '60 days')
    order by d.id
    for update of d
  loop
    perform authz.push_device_remove_row(
      (select x from public.staff_push_devices x where x.id = r.id),
      case when r.lost then 'access_lost' else 'unused_60_days' end);
    if r.lost then v_lost := v_lost + 1; else v_unused := v_unused + 1; end if;
  end loop;
  delete from public.staff_push_jobs j where j.created_at < now() - interval '7 days';
  get diagnostics v_jobs = row_count;
  return jsonb_build_object('unused', v_unused, 'accessLost', v_lost, 'jobsRemoved', v_jobs);
end;
$$;

select authz.timer_task_register('push_cleanup', 'authz.push_cleanup', 1440);

-- ===========================================================================
-- 9. Privileges
-- ===========================================================================

revoke all on function
  authz.push_enabled(),
  authz.staff_push_devices_guard(),
  authz.staff_push_jobs_guard(),
  authz.push_kick_state_guard(),
  authz.push_kick(),
  authz.push_jobs_kick(),
  authz.push_jobs_on_notices(),
  authz.push_endpoint_hash(text),
  authz.push_device_remove_row(public.staff_push_devices, text),
  authz.push_cleanup(),
  public.push_device_register(text, text, text, text, uuid),
  public.push_device_remove(uuid, uuid),
  public.push_device_remove_current(text),
  public.push_devices_list(text),
  public.push_test_send(uuid, uuid),
  public.admin_set_push_enabled(boolean, text),
  public.push_claim(text, integer, integer),
  public.push_complete(uuid, text, boolean, integer)
from public, anon, authenticated, service_role;

grant execute on function
  public.push_device_register(text, text, text, text, uuid),
  public.push_device_remove(uuid, uuid),
  public.push_device_remove_current(text),
  public.push_devices_list(text),
  public.push_test_send(uuid, uuid),
  public.admin_set_push_enabled(boolean, text)
to authenticated;
grant execute on function
  public.push_claim(text, integer, integer),
  public.push_complete(uuid, text, boolean, integer)
to service_role;

commit;
