-- TripNavigate CRM - Direction A Batch 1, item B1-1: read-only Bitrix name map
-- (Deal stage, Lead status and Lead source NAMES only).
--
-- Contract: docs/implementation/frontend-redesign-2026-10-15/batch-1-backend-contract.md
-- item B1-1, contracts.md section D and the Echo rulings F.5 (M2, L6) and
-- F.6 (N1). Owner answer (15 October, round 2): read-only list calls, names
-- only, no other fields, no writes; live activation needs the owner's APPROVE.
--
-- What changes:
--   1. Switch integration_intake_config.bitrix_name_read (OFF by default),
--      written only by public.integration_set_bitrix_name_read (Super Admin
--      at aal2, reason 10-500, audited). The settings audit trigger
--      integration_intake_config_audit is recreated from its LATEST definition
--      (20261120000700_b12_id_proof_bitrix_copy.sql, Echo N1) with
--      bitrix_name_read appended, so a change by direct SQL is audited too.
--   2. Table public.bitrix_name_lists: one row per (portal, list, code) with
--      the Bitrix display name, sort and (stages only) open/won/lost. Rows are
--      never deleted: a code that a later read no longer lists gets
--      missing_since. No Data API access (RLS on, no select policy, revoke all).
--   3. Table public.bitrix_name_refresh_state: per portal, the last refresh
--      attempt and the last successful refresh (so the worker reads Bitrix at
--      most once a day, retrying a failed day at most hourly). No Data API
--      access.
--   4. Worker commands (service_role only):
--        integration_bitrix_names_due(p_portal)   claims today's refresh when
--          the switch is on and no refresh succeeded today (Asia/Kolkata) and
--          none was attempted in the last hour; answers the pipeline ids to
--          read (configured pipelines plus pipelines of stored Deals).
--        integration_apply_bitrix_names(p_portal, p_lists, p_complete)
--          idempotent apply: unchanged names write nothing; new codes are
--          added, renamed codes updated, missing codes marked, returning codes
--          unmarked; one audit row integration.bitrix_names_refreshed with
--          counts and list ids only when something changed. An empty list is
--          refused (a failed read, never "every code is gone"). The day's
--          success is recorded only when p_complete is true (every list was
--          read), so a run with a failed list is retried within the day.
--   5. Staff read public.bitrix_name_map(): any active staff member of the
--      configuration's legal entity. While the switch is off it answers
--      {enabled: false, readAt: null, names: []} even when rows exist.
--      Purchase holders get the Deal stage lists only, never the Lead STATUS
--      and SOURCE lists (Purchase receives no Lead data).
--
-- Never: no Bitrix write, no new Bitrix method (crm.status.list is already
-- allowed), no sync-scope change. Nothing uses a name or `kind` for a
-- business decision: Won-only intake, the task trigger and every gate keep
-- using stage ids.
--
-- Refusal tokens (message is exactly the token):
--   42501 not_authorized
--   22023 invalid_input (hint names the field)
--   55000 intake is not configured (unchanged wording, as the other switches)
--
-- Rollback (forward-only): switch off with
-- integration_set_bitrix_name_read(false, reason); the read then answers
-- enabled:false and the worker reads nothing. Rows are kept. Emergency: a new
-- migration revoking execute on the new functions. Never delete rows or audit.
--
-- Apply history: this file has run only on disposable local and CI stacks.
-- It was amended in place on 19 October 2026 after the Echo-A review
-- (echo-redesign-batch1-data.md: M1, L1-L3, L5, L7) before any kept or live
-- database applied it.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Switch and audit trigger (latest list from 20261120000700 + bitrix_name_read)
-- ===========================================================================

alter table public.integration_intake_config
  add column bitrix_name_read boolean not null default false;
comment on column public.integration_intake_config.bitrix_name_read is
  'Direction A B1-1: read Bitrix stage, status and source NAMES (crm.status.list, read-only, names only) at most once a day and show them instead of codes. Off by default; written only by public.integration_set_bitrix_name_read (Super Admin, reason, audited). Live use needs the owner''s APPROVE.';

drop trigger integration_intake_config_audit on public.integration_intake_config;
create trigger integration_intake_config_audit
  after insert or update or delete on public.integration_intake_config
  for each row execute function authz.audit_settings_change(
    'settings.intake_config_changed', 'enabled', 'portal_domain', 'portal_member_id', 'category_id',
    'eligible_category_ids', 'eligible_stage_ids', 'cutoff_at', 'pilot_legal_entity_id', 'pilot_branch_id',
    'lead_intake_mode', 'deal_intake_mode',
    'deal_entry_stage_ids',
    'bitrix_trip_facts_read', 'lead_intake_unowned',
    'bitrix_id_proof_copy',
    -- Batch 1 B1-1
    'bitrix_name_read');

-- ===========================================================================
-- 2. Tables
-- ===========================================================================

create table public.bitrix_name_lists (
  id uuid primary key default gen_random_uuid(),
  source_portal text not null check (source_portal ~ '^[A-Za-z0-9_-]{1,64}$'),
  entity_id text not null check (entity_id ~ '^(DEAL_STAGE|DEAL_STAGE_[1-9][0-9]{0,9}|STATUS|SOURCE)$'),
  code text not null check (code ~ '^[A-Za-z0-9_:.-]{1,50}$'),
  name text not null check (char_length(name) between 1 and 120 and name = btrim(name) and name !~ '[[:cntrl:]]'),
  kind text check (kind in ('open', 'won', 'lost')),
  sort integer not null default 0 check (sort between -2147483648 and 2147483647),
  read_at timestamptz not null default now(),
  missing_since timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint bitrix_name_lists_unique unique (source_portal, entity_id, code),
  -- open / won / lost is display data of stage lists only.
  constraint bitrix_name_lists_kind_stage_only check (kind is null or entity_id like 'DEAL\_STAGE%')
);
comment on table public.bitrix_name_lists is
  'Bitrix display names of Deal stages (per pipeline), Lead statuses and Lead sources (metadata, not personal data). Display text only: no gate, intake rule or task trigger reads a name or kind. Written only by public.integration_apply_bitrix_names (service role); read by staff only through public.bitrix_name_map(). Rows are never deleted (missing_since marks codes no longer listed).';

create table public.bitrix_name_refresh_state (
  source_portal text primary key check (source_portal ~ '^[A-Za-z0-9_-]{1,64}$'),
  last_attempt_at timestamptz,
  last_success_at timestamptz,
  updated_at timestamptz not null default now()
);
comment on table public.bitrix_name_refresh_state is
  'Per portal: last name-refresh attempt and last successful refresh (worker bookkeeping, no names). Written only by the service-role name commands.';

-- Rows are never deleted.
create function authz.bitrix_names_no_delete() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'Bitrix name rows are never deleted' using errcode = '42501';
end;
$$;
create trigger bitrix_name_lists_no_delete before delete on public.bitrix_name_lists
  for each row execute function authz.bitrix_names_no_delete();
create trigger bitrix_name_refresh_state_no_delete before delete on public.bitrix_name_refresh_state
  for each row execute function authz.bitrix_names_no_delete();
revoke all on function authz.bitrix_names_no_delete() from public, anon, authenticated, service_role;

do $$
declare
  t text;
begin
  foreach t in array array['bitrix_name_lists', 'bitrix_name_refresh_state'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

-- ===========================================================================
-- 3. Switch command (Super Admin, reason, audited)
-- ===========================================================================

-- Same shape and authorization as public.integration_set_bitrix_id_proof_copy
-- (20261120000700): exactly one configuration row, Super Admin of its entity
-- at aal2, reason 10-500, row locked FOR UPDATE, unchanged state answers
-- changed:false and writes nothing. Turning the switch off deletes nothing.
create function public.integration_set_bitrix_name_read(p_enabled boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_n integer;
  v_reason text;
  v_prev text[];
begin
  select count(*) into v_n from public.integration_intake_config;
  if v_n <> 1 then
    raise exception 'intake is not configured' using errcode = '55000';
  end if;
  select * into v_cfg from public.integration_intake_config;
  if not authz.can_switch_live_settings(v_cfg.pilot_legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_reason := authz.settings_change_reason(p_reason);
  if p_enabled is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'enabled';
  end if;
  select * into v_cfg from public.integration_intake_config c where c.id = v_cfg.id for update;
  if v_cfg.bitrix_name_read = p_enabled then
    return jsonb_build_object('changed', false, 'enabled', p_enabled);
  end if;
  v_prev := authz.settings_begin_change('integration_set_bitrix_name_read', v_reason);
  update public.integration_intake_config c
  set bitrix_name_read = p_enabled, updated_at = now(), updated_by = auth.uid()
  where c.id = v_cfg.id;
  perform authz.settings_end_change(v_prev);
  perform authz.write_audit('integration.bitrix_name_read_set', v_cfg.pilot_legal_entity_id, null,
    'integration_intake_config', v_cfg.id, v_reason,
    jsonb_build_object('before', v_cfg.bitrix_name_read, 'after', p_enabled));
  return jsonb_build_object('changed', true, 'enabled', p_enabled);
end;
$$;

revoke all on function public.integration_set_bitrix_name_read(boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.integration_set_bitrix_name_read(boolean, text) to authenticated;

-- ===========================================================================
-- 4. Worker commands (service_role only)
-- ===========================================================================

-- The enabled configuration row of a portal with the switch on, or null.
create function authz.bitrix_names_config(p_portal text) returns public.integration_intake_config
language sql stable security definer set search_path = '' as $$
  select c.* from public.integration_intake_config c
  where c.portal_member_id = p_portal and c.enabled and c.bitrix_name_read
    and authz.intake_portal_allowed(c.portal_domain)
$$;
revoke all on function authz.bitrix_names_config(text) from public, anon, authenticated, service_role;

-- Claims today's refresh. due:false (no write) while the switch is off, after
-- a successful refresh today (Asia/Kolkata), or within an hour of the last
-- attempt. due:true records the attempt and answers the pipelines to read:
-- the configured pipelines plus every pipeline of a stored Deal of the portal
-- (at most 50, ascending).
create function public.integration_bitrix_names_due(p_portal text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_state public.bitrix_name_refresh_state%rowtype;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_pipelines bigint[];
begin
  if p_portal is null or p_portal !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'portal';
  end if;
  v_cfg := authz.bitrix_names_config(p_portal);
  if v_cfg.id is null then
    return jsonb_build_object('due', false, 'reason', 'switched_off');
  end if;
  insert into public.bitrix_name_refresh_state (source_portal) values (p_portal)
  on conflict (source_portal) do nothing;
  select * into v_state from public.bitrix_name_refresh_state s where s.source_portal = p_portal for update;
  if v_state.last_success_at is not null and (v_state.last_success_at at time zone 'Asia/Kolkata')::date >= v_today then
    return jsonb_build_object('due', false, 'reason', 'fresh');
  end if;
  if v_state.last_attempt_at is not null and v_state.last_attempt_at > now() - interval '1 hour' then
    return jsonb_build_object('due', false, 'reason', 'recently_attempted');
  end if;
  update public.bitrix_name_refresh_state s set last_attempt_at = now(), updated_at = now()
  where s.source_portal = p_portal;
  select coalesce(array_agg(p order by p), '{}') into v_pipelines
  from (
    select distinct p from (
      select v_cfg.category_id::bigint as p
      union all select unnest(coalesce(v_cfg.eligible_category_ids, '{}'::bigint[]))
      union all select d.source_category_id from public.deals d
        where d.source_system = 'bitrix' and d.source_portal = p_portal and d.source_category_id is not null
    ) a where p is not null and p >= 0
    order by p
    limit 50
  ) b;
  return jsonb_build_object('due', true, 'pipelineIds', to_jsonb(v_pipelines));
end;
$$;

revoke all on function public.integration_bitrix_names_due(text) from public, anon, authenticated, service_role;
grant execute on function public.integration_bitrix_names_due(text) to service_role;

-- p_lists: [{entityId, items: [{code, name, sort, kind}]}], at most 60 lists of
-- 1 to 500 items. p_complete: true only when the worker read every list it
-- asked for; false applies the lists given without recording the day's
-- success. Only lists present in p_lists are compared (a list the
-- worker could not read is left as it was). Names are trimmed, control
-- characters removed and cut to 120 characters; an item whose name is empty
-- after cleaning is skipped (counted as dropped). kind is kept for stage lists
-- only. Answers {applied, lists, added, renamed, missing, restored, dropped}.
create function public.integration_apply_bitrix_names(p_portal text, p_lists jsonb, p_complete boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_list jsonb;
  v_item jsonb;
  v_entity text;
  v_code text;
  v_name text;
  v_kind text;
  v_sort integer;
  v_codes text[];
  v_lists text[] := '{}'::text[];
  v_added integer := 0;
  v_renamed integer := 0;
  v_missing integer := 0;
  v_restored integer := 0;
  v_dropped integer := 0;
  v_n integer;
  v_row public.bitrix_name_lists%rowtype;
begin
  if p_portal is null or p_portal !~ '^[A-Za-z0-9_-]{1,64}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'portal';
  end if;
  if p_lists is null or (case when jsonb_typeof(p_lists) = 'array' then jsonb_array_length(p_lists) > 60 else true end) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'lists';
  end if;
  if p_complete is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'complete';
  end if;
  v_cfg := authz.bitrix_names_config(p_portal);
  if v_cfg.id is null then
    return jsonb_build_object('applied', false, 'reason', 'switched_off');
  end if;

  for v_list in select value from jsonb_array_elements(p_lists) loop
    if jsonb_typeof(v_list) <> 'object' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'lists';
    end if;
    v_entity := v_list ->> 'entityId';
    if v_entity is null
       or v_entity !~ '^(DEAL_STAGE|DEAL_STAGE_[1-9][0-9]{0,9}|STATUS|SOURCE)$'
       or v_entity = any (v_lists)
       or (case when jsonb_typeof(v_list -> 'items') = 'array' then jsonb_array_length(v_list -> 'items') not between 1 and 500 else true end)
       or exists (select 1 from jsonb_object_keys(v_list) k where k not in ('entityId', 'items')) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'lists';
    end if;
    v_lists := v_lists || v_entity;
    v_codes := '{}'::text[];
    for v_item in select value from jsonb_array_elements(v_list -> 'items') loop
      if jsonb_typeof(v_item) <> 'object' then
        raise exception 'invalid_input' using errcode = '22023', hint = 'items';
      end if;
      v_code := v_item ->> 'code';
      if v_code is null or v_code !~ '^[A-Za-z0-9_:.-]{1,50}$'
         or v_code = any (v_codes)
         or jsonb_typeof(v_item -> 'name') is distinct from 'string'
         or (v_item ? 'sort' and jsonb_typeof(v_item -> 'sort') not in ('number', 'null'))
         or (v_item ? 'kind' and jsonb_typeof(v_item -> 'kind') not in ('string', 'null'))
         or exists (select 1 from jsonb_object_keys(v_item) k where k not in ('code', 'name', 'sort', 'kind')) then
        raise exception 'invalid_input' using errcode = '22023', hint = 'items';
      end if;
      v_name := left(btrim(regexp_replace(v_item ->> 'name', '[[:cntrl:]]', '', 'g')), 120);
      v_name := btrim(v_name);
      if v_name = '' then
        v_dropped := v_dropped + 1;
        continue;
      end if;
      v_codes := v_codes || v_code;
      v_kind := case when v_entity like 'DEAL\_STAGE%' and (v_item ->> 'kind') in ('open', 'won', 'lost')
                     then v_item ->> 'kind' end;
      v_sort := case when jsonb_typeof(v_item -> 'sort') = 'number'
                     then greatest(least(trunc((v_item ->> 'sort')::numeric), 2147483647), -2147483648)::integer
                     else 0 end;
      select * into v_row from public.bitrix_name_lists l
      where l.source_portal = p_portal and l.entity_id = v_entity and l.code = v_code
      for update;
      if v_row.id is null then
        insert into public.bitrix_name_lists (source_portal, entity_id, code, name, kind, sort)
        values (p_portal, v_entity, v_code, v_name, v_kind, v_sort);
        v_added := v_added + 1;
      elsif v_row.name is distinct from v_name or v_row.kind is distinct from v_kind
            or v_row.sort is distinct from v_sort or v_row.missing_since is not null then
        update public.bitrix_name_lists l
        set name = v_name, kind = v_kind, sort = v_sort, read_at = now(), missing_since = null, updated_at = now()
        where l.id = v_row.id;
        if v_row.name is distinct from v_name then
          v_renamed := v_renamed + 1;
        end if;
        if v_row.missing_since is not null then
          v_restored := v_restored + 1;
        end if;
      end if;
    end loop;
    -- Codes of this list that Bitrix no longer lists are marked, never deleted.
    update public.bitrix_name_lists l
    set missing_since = now(), updated_at = now()
    where l.source_portal = p_portal and l.entity_id = v_entity and l.missing_since is null
      and not (l.code = any (v_codes));
    get diagnostics v_n = row_count;
    v_missing := v_missing + v_n;
  end loop;

  if p_complete then
    update public.bitrix_name_refresh_state s set last_success_at = now(), updated_at = now()
    where s.source_portal = p_portal;
    if not found then
      insert into public.bitrix_name_refresh_state (source_portal, last_attempt_at, last_success_at)
      values (p_portal, now(), now());
    end if;
  end if;
  if v_added + v_renamed + v_missing + v_restored > 0 then
    perform authz.write_audit('integration.bitrix_names_refreshed', v_cfg.pilot_legal_entity_id, null,
      'integration_intake_config', v_cfg.id, null,
      jsonb_build_object('lists', to_jsonb(v_lists), 'added', v_added, 'renamed', v_renamed,
        'missing', v_missing, 'restored', v_restored, 'dropped', v_dropped));
  end if;
  return jsonb_build_object('applied', true, 'lists', jsonb_array_length(to_jsonb(v_lists)), 'added', v_added,
    'renamed', v_renamed, 'missing', v_missing, 'restored', v_restored, 'dropped', v_dropped);
end;
$$;

revoke all on function public.integration_apply_bitrix_names(text, jsonb, boolean) from public, anon, authenticated, service_role;
grant execute on function public.integration_apply_bitrix_names(text, jsonb, boolean) to service_role;

-- ===========================================================================
-- 5. Staff read
-- ===========================================================================

-- Any active staff member (aal2) of the configuration's legal entity. Names
-- are display metadata, not personal or commercial data. While the switch is
-- off (or the configuration is missing, disabled or ambiguous) the answer is
-- {enabled: false, readAt: null, names: []} even when rows exist, so
-- switching off restores the code fallback at once without deleting rows.
-- readAt = the last successful refresh. missing = no longer in the Bitrix list.
-- Purchase holders of the entity get the Deal stage lists only (no Lead
-- STATUS or SOURCE lists; Purchase receives no Lead data).
create function public.bitrix_name_map() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_n integer;
  v_read_at timestamptz;
  v_purchase boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select count(*) into v_n from public.integration_intake_config;
  if v_n = 1 then
    select * into v_cfg from public.integration_intake_config;
    if not authz.is_entity_member(v_cfg.pilot_legal_entity_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
  end if;
  if v_n <> 1 or not v_cfg.enabled or not v_cfg.bitrix_name_read then
    return jsonb_build_object('enabled', false, 'readAt', null, 'names', '[]'::jsonb);
  end if;
  select s.last_success_at into v_read_at
  from public.bitrix_name_refresh_state s where s.source_portal = v_cfg.portal_member_id;
  v_purchase := authz.holds_role('purchase', v_cfg.pilot_legal_entity_id);
  return jsonb_build_object(
    'enabled', true,
    'readAt', v_read_at,
    'names', coalesce((
      select jsonb_agg(jsonb_build_object('entityId', l.entity_id, 'code', l.code, 'name', l.name, 'kind', l.kind,
                                          'missing', l.missing_since is not null)
                       order by l.entity_id, l.sort, l.code)
      from public.bitrix_name_lists l
      where l.source_portal = v_cfg.portal_member_id
        and (not v_purchase or l.entity_id like 'DEAL\_STAGE%')), '[]'::jsonb));
end;
$$;

revoke all on function public.bitrix_name_map() from public, anon, authenticated, service_role;
grant execute on function public.bitrix_name_map() to authenticated;

commit;
