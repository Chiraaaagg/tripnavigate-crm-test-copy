-- Book now v2 (26 October 2026): "Refresh from Bitrix now".
--
-- Build plan: docs/implementation/booking-form-v2-2026-10-26/build-plan.md section 3
-- (agent C, migration range 20261129000200-0290). Forward-only.
--
-- A booking editor asks the CRM to read ONE Bitrix Deal at once instead of
-- waiting for the next sync. This migration only authorizes the request and
-- hands the app a leased inbox row; the app then reads the Deal through the
-- allow-listed READ methods (crm.deal.get, crm.contact.get, crm.company.get)
-- and applies it through the normal intake commands
-- (integration_apply_bitrix_deal, integration_apply_bitrix_trip_facts,
-- integration_apply_bitrix_party). Nothing is ever written to Bitrix.
--
-- Contents:
--   1. integration_inbox.origin gains 'staff_refresh'.
--   2. deal_bitrix_refresh_state: the 20-second cooldown per Deal;
--      staff_bitrix_refresh_rate: at most 10 refreshes per staff member per
--      rolling minute (review round 1).
--   3. public.booking_bitrix_refresh_begin(p_deal_id uuid, p_request_id uuid).
--
-- One transaction with a lock timeout (review round 1), like the other
-- Book now v2 migrations.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Inbox origin
-- ===========================================================================

-- The column check was declared inline in 20261003000100 (default name).
alter table public.integration_inbox drop constraint integration_inbox_origin_check;
-- Added NOT VALID (no full scan under the lock), then validated.
alter table public.integration_inbox add constraint integration_inbox_origin_check
  check (origin in ('event', 'reconcile', 'manual_retry', 'staff_refresh')) not valid;
alter table public.integration_inbox validate constraint integration_inbox_origin_check;

-- ===========================================================================
-- 2. Cooldown state (one row per Deal; written only by the command below)
-- ===========================================================================

create table public.deal_bitrix_refresh_state (
  deal_id uuid primary key references public.deals (id) on delete cascade,
  legal_entity_id uuid not null references public.legal_entities (id),
  last_requested_at timestamptz not null,
  last_requested_by uuid not null references public.staff_profiles (user_id),
  last_request_id uuid not null
);
comment on table public.deal_bitrix_refresh_state is
  'Last "Refresh from Bitrix now" per Deal (ids and time only). Enforces the 20-second cooldown. '
  'Written only by booking_bitrix_refresh_begin; no API access.';
create index deal_bitrix_refresh_state_entity_idx on public.deal_bitrix_refresh_state (legal_entity_id);
create index deal_bitrix_refresh_state_by_idx on public.deal_bitrix_refresh_state (last_requested_by);

alter table public.deal_bitrix_refresh_state enable row level security;
create policy require_valid_session on public.deal_bitrix_refresh_state as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.deal_bitrix_refresh_state from public, anon, authenticated, service_role;

-- Per staff member: the times of the last refreshes (at most 10 kept, the
-- rolling-minute limit). One row per staff member, no content.
create table public.staff_bitrix_refresh_rate (
  user_id uuid primary key references public.staff_profiles (user_id) on delete cascade,
  recent_at timestamptz[] not null default '{}' check (cardinality(recent_at) <= 10),
  updated_at timestamptz not null default now()
);
comment on table public.staff_bitrix_refresh_rate is
  'Times of the last "Refresh from Bitrix now" requests per staff member (at most 10). '
  'Enforces 10 refreshes per rolling minute. Written only by booking_bitrix_refresh_begin; no API access.';

alter table public.staff_bitrix_refresh_rate enable row level security;
create policy require_valid_session on public.staff_bitrix_refresh_rate as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.staff_bitrix_refresh_rate from public, anon, authenticated, service_role;

-- ===========================================================================
-- 3. booking_bitrix_refresh_begin
-- ===========================================================================

-- Called under the staff member's own session, BEFORE any Bitrix call or any
-- privileged client. Checks, in order:
--   * valid session (42501), both arguments present (22023);
--   * the caller may edit this Deal's booking draft (same gate as the
--     booking form editors, authz.can_edit_booking_draft; 42501 otherwise);
--   * the CRM environment can run intake (55000 environment_unset / not_configured);
--   * the Deal came from Bitrix ({allowed:false, reason:'not_bitrix_deal'})
--     and was not removed by the sync (reason 'deal_removed'; defence in
--     depth: a removed Deal is not readable, so the editor check refuses it first);
--   * its portal's intake is enabled and allowed here, and the Bitrix read
--     switch bitrix_trip_details_read or bitrix_trip_facts_read is On
--     (reason 'switched_off');
--   * the scheduled sync is not paused (integration_sync_schedule.enabled;
--     reason 'sync_paused');
--   * the caller made fewer than 10 refreshes in the last 60 seconds, across
--     all Deals (reason 'staff_limit', retryAfterSeconds);
--   * no refresh of this Deal in the last 20 seconds, by anyone
--     (reason 'too_soon', retryAfterSeconds).
-- Only a refresh that passes every check counts towards either limit.
-- Then, in the same transaction: takes over a waiting (pending or failed)
-- inbox row of this Deal, or inserts a new one with origin 'staff_refresh',
-- leased to a new token for 90 seconds (a row another run holds stays with it;
-- the apply serialises on the Deal row), and writes the audit row
-- booking.bitrix_refresh_requested with ids only.
-- Answer {allowed:true, inboxId, lockToken, portalMemberId, sourceDealId,
--         sourceObject:'deal', eventType, origin, attempts}.
-- A lease the app does not finish expires; the scheduled sync then processes
-- the row like any other.
create function public.booking_bitrix_refresh_begin(p_deal_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_cfg public.integration_intake_config%rowtype;
  v_state public.deal_bitrix_refresh_state%rowtype;
  v_recent timestamptz[];
  v_uid uuid := (select auth.uid());
  v_inbox public.integration_inbox%rowtype;
  v_taken_over boolean := false;
  v_wait integer;
  v_lease constant interval := interval '90 seconds';
  v_cooldown constant interval := interval '20 seconds';
  v_window constant interval := interval '60 seconds';
  v_staff_limit constant integer := 10;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_deal_id is null or p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if not authz.can_edit_booking_draft(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if authz.deployment_environment() not in ('operational', 'test') then
    raise exception 'not_configured' using errcode = '55000';
  end if;

  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.source_system is distinct from 'bitrix' or v_deal.source_deal_id is null or v_deal.source_portal is null then
    return jsonb_build_object('allowed', false, 'reason', 'not_bitrix_deal');
  end if;
  if v_deal.removed_at is not null then
    return jsonb_build_object('allowed', false, 'reason', 'deal_removed');
  end if;

  select * into v_cfg from public.integration_intake_config c
  where c.portal_member_id = v_deal.source_portal and c.enabled;
  if v_cfg.id is null or not authz.intake_portal_allowed(v_cfg.portal_domain)
     or not (coalesce(v_cfg.bitrix_trip_details_read, false) or coalesce(v_cfg.bitrix_trip_facts_read, false)) then
    return jsonb_build_object('allowed', false, 'reason', 'switched_off');
  end if;
  -- Scheduled sync paused by an admin (a missing row reads as paused).
  if not coalesce((select s.enabled from public.integration_sync_schedule s where s.id), false) then
    return jsonb_build_object('allowed', false, 'reason', 'sync_paused');
  end if;

  -- Per staff member: 10 refreshes per rolling minute. The row lock
  -- serialises one person's concurrent requests until this transaction ends.
  insert into public.staff_bitrix_refresh_rate (user_id) values (v_uid) on conflict (user_id) do nothing;
  perform 1 from public.staff_bitrix_refresh_rate r where r.user_id = v_uid for update;
  select coalesce(array_agg(t order by t), '{}') into v_recent
  from public.staff_bitrix_refresh_rate r, unnest(r.recent_at) t
  where r.user_id = v_uid and t > now() - v_window;
  if cardinality(v_recent) >= v_staff_limit then
    v_wait := greatest(1, ceil(extract(epoch from (v_recent[cardinality(v_recent) - v_staff_limit + 1] + v_window - now())))::integer);
    return jsonb_build_object('allowed', false, 'reason', 'staff_limit', 'retryAfterSeconds', least(v_wait, 60));
  end if;

  -- Cooldown: a concurrent request waits on the row lock and then sees the new time.
  insert into public.deal_bitrix_refresh_state as s
    (deal_id, legal_entity_id, last_requested_at, last_requested_by, last_request_id)
  values (v_deal.id, v_deal.legal_entity_id, now(), (select auth.uid()), p_request_id)
  on conflict (deal_id) do update
  set last_requested_at = excluded.last_requested_at,
      last_requested_by = excluded.last_requested_by,
      last_request_id = excluded.last_request_id
  where s.last_requested_at <= now() - v_cooldown
  returning * into v_state;
  if v_state.deal_id is null then
    select greatest(1, ceil(extract(epoch from (s.last_requested_at + v_cooldown - now())))::integer) into v_wait
    from public.deal_bitrix_refresh_state s where s.deal_id = v_deal.id;
    return jsonb_build_object('allowed', false, 'reason', 'too_soon', 'retryAfterSeconds', least(coalesce(v_wait, 20), 20));
  end if;

  update public.staff_bitrix_refresh_rate r
  set recent_at = v_recent || now(), updated_at = now()
  where r.user_id = v_uid;

  -- A waiting row of this Deal is taken over (one read serves both).
  select i.* into v_inbox from public.integration_inbox i
  where i.portal_member_id = v_cfg.portal_member_id and i.source_object = 'deal'
    and i.source_deal_id = v_deal.source_deal_id
    and i.status in ('pending', 'failed') and i.attempts < i.max_attempts
  order by i.received_at
  limit 1
  for update skip locked;
  if v_inbox.id is not null then
    update public.integration_inbox i
    set status = 'processing', lock_token = gen_random_uuid(), locked_until = now() + v_lease,
        attempts = i.attempts + 1, updated_at = now()
    where i.id = v_inbox.id
    returning i.* into v_inbox;
    v_taken_over := true;
  else
    insert into public.integration_inbox
      (portal_member_id, source_object, event_type, source_deal_id, source_ts, dedupe_key, origin,
       status, attempts, next_attempt_at, lock_token, locked_until)
    values
      (v_cfg.portal_member_id, 'deal', 'RECONCILE', v_deal.source_deal_id, floor(extract(epoch from now()))::bigint,
       encode(sha256(convert_to('staff_refresh|' || v_cfg.portal_member_id || '|' || v_deal.source_deal_id::text
                                || '|' || p_request_id::text, 'UTF8')), 'hex'),
       'staff_refresh', 'processing', 1, now(), gen_random_uuid(), now() + v_lease)
    on conflict (dedupe_key) do nothing
    returning * into v_inbox;
    if v_inbox.id is null then
      -- The same request id was used before (a replayed request): nothing is leased.
      raise exception 'request_conflict' using errcode = '23505';
    end if;
  end if;

  perform authz.write_audit('booking.bitrix_refresh_requested', v_deal.legal_entity_id, v_deal.branch_id,
    'deal', v_deal.id, null,
    jsonb_build_object('inboxId', v_inbox.id, 'requestId', p_request_id, 'takenOver', v_taken_over));

  return jsonb_build_object(
    'allowed', true,
    'inboxId', v_inbox.id,
    'lockToken', v_inbox.lock_token,
    'portalMemberId', v_inbox.portal_member_id,
    'sourceDealId', v_inbox.source_deal_id::text,
    'sourceObject', v_inbox.source_object,
    'eventType', v_inbox.event_type,
    'origin', v_inbox.origin,
    'attempts', v_inbox.attempts);
end;
$$;

revoke all on function public.booking_bitrix_refresh_begin(uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.booking_bitrix_refresh_begin(uuid, uuid) to authenticated;

commit;
