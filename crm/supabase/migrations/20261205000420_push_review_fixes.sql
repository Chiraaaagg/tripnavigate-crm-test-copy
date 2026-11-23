-- TripNavigate CRM - Accounts phase 3, track D (3): pull-request review fixes
-- for closed-browser alerts. Contract: accounts-phase3-2026-11-12/contract.md
-- section 8 and Addendum O3 (lead, review findings).
--
-- 1. public.push_devices_remove_all(p_request_id): "Sign out of all devices"
--    removes every active alert device of the caller (reason signed_out; one
--    notices.push_device_removed audit row per device, ids only). Self only.
-- 2. Push endpoint allowlist, authz.push_endpoint_allowed(endpoint): https
--    on fcm.googleapis.com, *.push.services.mozilla.com, web.push.apple.com or
--    *.notify.windows.com only (default port, no user part).
--    push_device_register refuses any other endpoint (invalid_input, hint
--    endpoint); push_claim never hands one to the worker (job failed,
--    endpoint_not_allowed); push_complete gains p_error_code (default null)
--    so the worker can fail a job without a retry when its own allowlist
--    check refuses it.
--
-- Replaced (latest bodies, 20261205000400; changed lines marked
-- "Accounts phase 3 review (20261205000420)"): public.push_device_register,
-- public.push_claim (same signatures); public.push_complete is dropped and
-- re-created with one more argument p_error_code text default null (existing
-- four-argument calls keep working).
--
-- Refusal tokens: not_authorized (42501), invalid_input (22023, hint
-- requestId / endpoint / errorCode).
-- Rollback (forward-only): a NEW migration restoring the 20261205000400 bodies
-- (and the four-argument push_complete) and dropping
-- push_devices_remove_all and push_endpoint_allowed.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Allowlist
-- ===========================================================================

create function authz.push_endpoint_allowed(p_endpoint text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(
    p_endpoint ~ '^https://[A-Za-z0-9.-]+(:443)?(/[^[:space:]]*)?$'
    and (lower(substring(p_endpoint from '^https://([A-Za-z0-9.-]+)')) in ('fcm.googleapis.com', 'web.push.apple.com')
         or lower(substring(p_endpoint from '^https://([A-Za-z0-9.-]+)')) ~ '^[a-z0-9-]+(\.[a-z0-9-]+)*\.push\.services\.mozilla\.com$'
         or lower(substring(p_endpoint from '^https://([A-Za-z0-9.-]+)')) ~ '^[a-z0-9-]+(\.[a-z0-9-]+)*\.notify\.windows\.com$'),
    false)
$$;

create or replace function public.push_device_register(p_endpoint text, p_p256dh text, p_auth_key text, p_label text, p_request_id uuid)
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
  -- Accounts phase 3 review (20261205000420): only the browsers' own push services.
  if not authz.push_endpoint_allowed(p_endpoint) then
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

create or replace function public.push_claim(p_worker text, p_limit integer, p_lease_seconds integer) returns jsonb
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
    -- Accounts phase 3 review (20261205000420): an endpoint outside the push-service allowlist is never sent to.
    if not authz.push_endpoint_allowed(r.endpoint) then
      update public.staff_push_jobs j set status = 'failed', lease_owner = null, lease_until = null,
        last_error_code = 'endpoint_not_allowed'
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

drop function public.push_complete(uuid, text, boolean, integer);
create function public.push_complete(p_job_id uuid, p_worker text, p_ok boolean, p_status_code integer,
  p_error_code text default null) returns jsonb
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
  -- Accounts phase 3 review (20261205000420): the worker refused to send (endpoint outside the allowlist): failed, no retry.
  if p_error_code is not null then
    if p_error_code !~ '^[a-z0-9_]{1,40}$' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'errorCode';
    end if;
    update public.staff_push_jobs j set status = 'failed', lease_owner = null, lease_until = null, last_error_code = p_error_code
    where j.id = v_job.id;
    return jsonb_build_object('outcome', 'failed');
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
-- 2. "Sign out of all devices"
-- ===========================================================================

create function public.push_devices_remove_all(p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  r public.staff_push_devices%rowtype;
  v_n integer := 0;
begin
  if not coalesce(authz.session_ok(), false) or v_uid is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('tripnavigate.push_user:' || v_uid::text, 0));
  for r in
    select * from public.staff_push_devices d where d.user_id = v_uid and d.status = 'active' order by d.id for update
  loop
    perform authz.push_device_remove_row(r, 'signed_out');
    v_n := v_n + 1;
  end loop;
  return jsonb_build_object('removed', v_n);
end;
$$;

-- ===========================================================================
-- 3. Privileges
-- ===========================================================================

revoke all on function
  authz.push_endpoint_allowed(text),
  public.push_device_register(text, text, text, text, uuid),
  public.push_claim(text, integer, integer),
  public.push_complete(uuid, text, boolean, integer, text),
  public.push_devices_remove_all(uuid)
from public, anon, authenticated, service_role;
grant execute on function
  public.push_device_register(text, text, text, text, uuid),
  public.push_devices_remove_all(uuid)
to authenticated;
grant execute on function
  public.push_claim(text, integer, integer),
  public.push_complete(uuid, text, boolean, integer, text)
to service_role;

commit;
