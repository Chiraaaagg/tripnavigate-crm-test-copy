-- TripNavigate CRM - S4 background sync load (2 of 4): the database wakes the worker
--
-- Contract: hosting-migration-2026-11-26/10-s4-sync-load-contract.md, sections
-- 2.1, 2.2 (D1, D2, D7, D8, D12), 2.3 and 2.5 (c), (d), (e), (f), (i2); review 10a.
--
-- Why: a Bitrix event recorded by the receiver waits today for the next
-- 30-second tick. With the tick moving to every 5 minutes (a later, separately
-- approved operator step), a new pending event must wake the worker itself.
-- The wake-up ("kick") is sent from inside the database with the same three
-- Vault values the tick already uses, so the Edge Function gets no new secret,
-- no new permission and is not redeployed.
--
-- What changes:
--   * authz.kick_bitrix_sync(p_kind) (new, owner only; modelled on
--     authz.push_kick, 20261205000400). Kinds: 'event' posts
--     ?task=batch&limit=25&source=event (inbox drain only); 'copy' and 'chain'
--     post ?task=sync (a full run). Returns false and sends nothing when: the
--     kind is unknown; Vault or pg_net is absent; the sync is paused
--     (integration_sync_schedule.enabled) or the kick switch is off
--     (kick_enabled, default false); 20 or more non-tick calls were sent in the
--     last 60 seconds; for 'chain', 10 or more chain calls in the last 10
--     minutes; the URL or bearer Vault value is missing or invalid. The
--     breaker is soft (counts read at READ COMMITTED). Never raises: the whole
--     body after the guards is inside an exception block. The schedule row is
--     read without a lock (the tick takes it FOR UPDATE SKIP LOCKED). It does
--     not touch last_request_id (the tick's overlap guard). pg_net sends only
--     after the caller commits; a rolled-back caller sends nothing. Every call
--     uses a 90-second timeout, so the existing reason text stays true. The
--     call is recorded in integration_sync_dispatches with its kind.
--   * public.integration_receive_bitrix_event (restated, see below): after the
--     durable record, a recorded row that is pending requests one 'event' kick.
--     That includes a coalesced duplicate (its earlier kick may have been
--     refused by the breaker); an ignored (not_in_manifest) row or a
--     redelivery of a finished row requests nothing. The answer shape
--     {inboxId, duplicate} and every refusal are unchanged.
--     integration_record_bitrix_event is not changed (the local receiver route
--     and its live batch behave as before).
--   * Trigger bitrix_id_proof_copy_jobs_kick: AFTER INSERT ... FOR EACH ROW,
--     one 'copy' kick per new DEC-43 copy job. Row level on purpose: an
--     insert ... on conflict do update that inserts nothing starts no run. No
--     DEC-43 function body is restated; a cancelled job revived by an update
--     waits for the next tick.
--   * public.integration_sync_request_followup(p_kind default 'chain') (new,
--     service role only): lets a full worker run ask for exactly one more run
--     ('chain': stopped for time or an open resync progressed; 'copy': it
--     copied an ID proof). Answers {"dispatched": boolean}; any other kind
--     answers {"dispatched": false}. Rate-limited by the breaker above. It
--     exposes no secret and no data.
--   * authz.set_bitrix_sync_kick(p_enabled, p_reason) (new, owner SQL only):
--     the audited switch for all kicks. Reason 10 to 500 characters. One audit
--     row (integration.sync_kick_changed) per enabled intake config, or one
--     for the newest config row when none is enabled; refuses (55000) when
--     there is no intake config at all.
--
-- Replaces (same signature, same grants and owner, kept by create or replace):
--   public.integration_receive_bitrix_event(text, text, text, text, bigint, bigint)
--     from 20261007000100_lead_intake_manifest.sql. Body copied unchanged except
--     the block marked "S4" before the return (tests/db/s4-sync-load.test.ts
--     compares the definition before and after with that block removed).
--
-- Nothing here creates, alters or activates a pg_cron job, deletes a row or
-- contains a URL or a secret. On apply the kick switch is off, so no request
-- is sent until the owner-approved release sub-step turns it on.
-- Rollback: select authz.set_bitrix_sync_kick(false, '<reason>'); (reverse
-- script R3 in supabase/s4-sync-load/). Forward-only otherwise.

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- The kick
-- ---------------------------------------------------------------------------

-- Posts once to the worker (the scheduler's own Vault values). Never raises:
-- an error or a missing piece means the next tick does the work instead.
create function authz.kick_bitrix_sync(p_kind text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_enabled boolean;
  v_kick boolean;
  v_recent integer;
  v_chains integer;
  v_url text;
  v_bearer text;
  v_bypass text;
  v_headers jsonb;
  v_params jsonb;
  v_id bigint;
begin
  if p_kind is null or p_kind not in ('event', 'copy', 'chain') then
    return false;
  end if;
  if to_regclass('vault.decrypted_secrets') is null or to_regnamespace('net') is null then
    return false;
  end if;
  begin
    -- The tick's pause switch and the kick switch. Plain read: no row lock.
    select s.enabled, s.kick_enabled into v_enabled, v_kick
    from public.integration_sync_schedule s where s.id;
    if not coalesce(v_enabled, false) or not coalesce(v_kick, false) then
      return false;
    end if;

    -- Soft circuit breaker (D2).
    select count(*)::integer into v_recent from public.integration_sync_dispatches d
    where d.dispatched_at > now() - interval '60 seconds' and d.kind <> 'tick';
    if v_recent >= 20 then
      return false;
    end if;
    if p_kind = 'chain' then
      select count(*)::integer into v_chains from public.integration_sync_dispatches d
      where d.dispatched_at > now() - interval '10 minutes' and d.kind = 'chain';
      if v_chains >= 10 then
        return false;
      end if;
    end if;

    -- Same names and validation as authz.dispatch_bitrix_sync.
    select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'bitrix_sync_url';
    select s.decrypted_secret into v_bearer from vault.decrypted_secrets s where s.name = 'bitrix_sync_bearer';
    select s.decrypted_secret into v_bypass from vault.decrypted_secrets s where s.name = 'vercel_protection_bypass';
    v_url := nullif(btrim(v_url), '');
    v_bearer := nullif(btrim(v_bearer), '');
    if v_url is null or v_bearer is null or v_url !~ '^https?://[^\s?#]+$' then
      return false;
    end if;
    v_headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_bearer,
      'Content-Type', 'application/json');
    if nullif(btrim(v_bypass), '') is not null then
      v_headers := v_headers || jsonb_build_object('x-vercel-protection-bypass', btrim(v_bypass));
    end if;

    if p_kind = 'event' then
      v_params := jsonb_build_object('task', 'batch', 'limit', '25', 'source', 'event');
    else
      v_params := jsonb_build_object('task', 'sync');
    end if;
    v_id := net.http_post(
      url := v_url,
      params := v_params,
      headers := v_headers,
      body := '{}'::jsonb,
      timeout_milliseconds := 90000);
    if v_id is null then
      return false;
    end if;
    insert into public.integration_sync_dispatches (request_id, kind) values (v_id, p_kind)
    on conflict do nothing;
    return true;
  exception when others then
    return false;
  end;
end;
$$;

revoke all on function authz.kick_bitrix_sync(text) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Receiver: restated from 20261007000100_lead_intake_manifest.sql
-- ---------------------------------------------------------------------------

-- Public receiver (anon + receiver credential). Credential first, then
-- environment (L1 messages), single enabled config, portal identity, portal
-- class for the environment (L2), then the durable record above.
create or replace function public.integration_receive_bitrix_event(
  p_credential text, p_member_id text, p_domain text, p_event_type text, p_deal_id bigint, p_source_ts bigint
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_enabled integer;
  v_match boolean;
  v_domain text;
  v_result jsonb;
begin
  -- 1. Receiver credential first: nothing else is read for an unknown caller.
  if not authz.intake_receiver_authorized(p_credential) then
    raise exception 'receiver not authorized' using errcode = '28000';
  end if;

  -- 2. Environment (L1: unset keeps its own refusal).
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if authz.deployment_environment() not in ('operational', 'test') then
    raise exception 'not_configured' using errcode = '55000';
  end if;

  -- 3. Exactly one enabled config; member_id AND domain must match it.
  select count(*)::integer,
         bool_or(c.portal_member_id = p_member_id
                 and c.portal_domain = authz.normalise_portal_domain(p_domain)),
         min(c.portal_domain)
    into v_enabled, v_match, v_domain
  from public.integration_intake_config c
  where c.enabled;
  if v_enabled <> 1 then
    raise exception 'not_configured' using errcode = '55000';
  end if;
  if p_member_id is null or p_domain is null or length(p_domain) > 253 or not coalesce(v_match, false) then
    raise exception 'portal not recognised' using errcode = '42501';
  end if;

  -- 4. Portal class for this environment (operational: real only; test: .test only).
  perform authz.require_intake_environment(v_domain);

  -- 5. Durable record (dedupe, manifest gate, coalescing, argument checks).
  v_result := public.integration_record_bitrix_event(p_member_id, p_event_type, p_deal_id, p_source_ts);
  -- S4: wake the worker when the recorded row is waiting. Never raises.
  if exists (
    select 1 from public.integration_inbox i
    where i.id = (v_result ->> 'inboxId')::uuid and i.status = 'pending'
  ) then
    perform authz.kick_bitrix_sync('event');
  end if;
  return jsonb_build_object('inboxId', v_result -> 'inboxId', 'duplicate', v_result -> 'duplicate');
end;
$$;

-- ---------------------------------------------------------------------------
-- DEC-43 copy jobs: one full run per new job
-- ---------------------------------------------------------------------------

create function authz.id_proof_copy_jobs_kick() returns trigger
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform authz.kick_bitrix_sync('copy');
  return null;
end;
$$;

revoke all on function authz.id_proof_copy_jobs_kick() from public, anon, authenticated, service_role;

create trigger bitrix_id_proof_copy_jobs_kick after insert on public.bitrix_id_proof_copy_jobs
  for each row execute function authz.id_proof_copy_jobs_kick();

-- ---------------------------------------------------------------------------
-- Worker follow-up (service role only)
-- ---------------------------------------------------------------------------

-- One more run, requested by a full worker run: 'chain' or 'copy' only.
create function public.integration_sync_request_followup(p_kind text default 'chain') returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_kind is null or p_kind not in ('chain', 'copy') then
    return jsonb_build_object('dispatched', false);
  end if;
  return jsonb_build_object('dispatched', authz.kick_bitrix_sync(p_kind));
end;
$$;

-- Both lines are required: the owner's default privileges in public grant new
-- functions to service_role automatically on the hosted database.
revoke all on function public.integration_sync_request_followup(text) from public, anon, authenticated, service_role;
grant execute on function public.integration_sync_request_followup(text) to service_role;

-- ---------------------------------------------------------------------------
-- The kick switch (owner SQL only, audited)
-- ---------------------------------------------------------------------------

-- Turns every kick (event, copy, chain) on or off. Reverse script R3 is
-- select authz.set_bitrix_sync_kick(false, '<reason>');
create function authz.set_bitrix_sync_kick(p_enabled boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_from boolean;
  v_audited integer := 0;
  r record;
begin
  if p_enabled is null then
    raise exception 'kick switch value is required' using errcode = '22023';
  end if;
  if p_reason is null or length(btrim(p_reason)) not between 10 and 500 then
    raise exception 'reason must be 10 to 500 characters' using errcode = '22023';
  end if;
  if not exists (select 1 from public.integration_intake_config) then
    raise exception 'no intake configuration to record the change against' using errcode = '55000';
  end if;
  select s.kick_enabled into v_from from public.integration_sync_schedule s where s.id;
  if not found then
    raise exception 'sync schedule row is missing' using errcode = '55000';
  end if;

  update public.integration_sync_schedule s set kick_enabled = p_enabled, updated_at = now() where s.id;

  for r in
    select c.id, c.pilot_legal_entity_id from public.integration_intake_config c
    where c.enabled order by c.portal_member_id
  loop
    perform authz.write_audit('integration.sync_kick_changed', r.pilot_legal_entity_id, null,
      'integration_intake_config', r.id, p_reason, jsonb_build_object('fromEnabled', v_from, 'toEnabled', p_enabled));
    v_audited := v_audited + 1;
  end loop;
  if v_audited = 0 then
    perform authz.write_audit('integration.sync_kick_changed', c.pilot_legal_entity_id, null,
      'integration_intake_config', c.id, p_reason, jsonb_build_object('fromEnabled', v_from, 'toEnabled', p_enabled))
    from (select x.id, x.pilot_legal_entity_id from public.integration_intake_config x
          order by x.created_at desc, x.id desc limit 1) c;
  end if;

  return jsonb_build_object('kickEnabled', p_enabled);
end;
$$;

revoke all on function authz.set_bitrix_sync_kick(boolean, text) from public, anon, authenticated, service_role;

commit;
