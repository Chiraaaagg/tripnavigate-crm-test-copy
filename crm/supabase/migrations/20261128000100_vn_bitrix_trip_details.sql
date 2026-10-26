-- TripNavigate CRM - voice-note booking form batch (24 October 2026), part 1:
-- read-only Bitrix trip details (destination, adults, children, infants) and
-- the destination classification (domestic / international).
--
-- Owner answers of 24 October 2026 (lead brief lead-voice-notes.md, answer 3):
-- trip facts come from the Bitrix Deal: destination (UF_CRM_6876462911034
-- single choice first, else the first value of UF_CRM_6A9BD81EA7CCF multiple
-- choice), adults / children / infants (UF_CRM_68A83F913F4EF /
-- UF_CRM_68A83F91465CD / UF_CRM_68A83F914D169), next to the tour start / end
-- and total travellers already read by 20261120000400. The new reads sit
-- behind their OWN switch, off by default; live activation needs the owner's
-- APPROVE. Domestic / international is set once per Bitrix destination option
-- by a Super Admin (reason, audited); an unclassified or missing destination
-- is chosen by staff on the booking; never guessed. Field map:
-- docs/implementation/frontend-first-plan-2026-10-10/b1.2/
-- phase-a-bitrix-and-engines.md sections 2.2 and 2.5. Shapes: Atlas notes
-- atlas-vn-shapes.md.
--
-- What changes:
--   1. Switch integration_intake_config.bitrix_trip_details_read (off),
--      written only by public.integration_set_bitrix_trip_details_read (Super
--      Admin at aal2, reason 10-500, audited); the settings audit trigger is
--      recreated from its latest list (20261121000100) with the column added;
--      public.bitrix_trip_details_read_state() (same shape as
--      bitrix_name_read_state) and public.settings_switch_states() (body of
--      20261125000100, the key added to the Bitrix list) show it.
--   2. deal_source_trip_facts: destination (field and option id), adults,
--      children, infants and their own issue list (details_issues). Written
--      only while the new switch is on; the older fields keep following
--      bitrix_trip_facts_read.
--   3. public.integration_apply_bitrix_trip_facts (replaces 20261120000400):
--      runs when either switch is on; each group of fields is written only
--      while its own switch is on (a group whose switch is off keeps its stored
--      values and its keys are ignored). Linked parties are still asked for
--      only while bitrix_trip_facts_read is on.
--   4. Destination option names: bitrix_name_lists accepts the lists
--      DEAL_DESTINATION (options of UF_CRM_6876462911034) and
--      DEAL_DESTINATION_MULTI (options of UF_CRM_6A9BD81EA7CCF), read from
--      crm.deal.fields (an already allowed READ method) by the daily name
--      refresh while the new switch is on. integration_bitrix_names_due and
--      integration_apply_bitrix_names (replace 20261121000100) work when either
--      bitrix_name_read or the new switch is on; each list kind only while its
--      own switch is on. public.bitrix_name_map() (replaces 20261121000100)
--      never returns the destination lists (its answer is unchanged).
--   5. public.bitrix_destination_scopes: (portal, list, option) -> domestic |
--      international | null (cleared). Rows never deleted. Written only by
--      public.bitrix_destination_scope_set (Super Admin, reason, audited);
--      read through public.bitrix_destination_options() by the Super Admin
--      and booking editors (active Sales or Manager of the entity).
--
-- Never: no Bitrix write, no new Bitrix method, no sync-scope change, no
-- guessed scope.
--
-- Refusal tokens (message is exactly the token):
--   42501 not_authorized; 22023 invalid_input (hint names the field);
--   40001 version_changed; P0002 not_found;
--   55000 intake is not configured (unchanged wording);
--   22023 'a reason of 10 to 500 characters is required' (settings rule).
--
-- Rollback (forward-only): switch off with
-- integration_set_bitrix_trip_details_read(false, reason): the apply then
-- writes no new field, the refresh reads no destination list and every read
-- answers as if nothing was read. Rows are kept. Emergency: a new migration
-- restoring the replaced bodies.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Switch, audit trigger, command, state read
-- ===========================================================================

alter table public.integration_intake_config
  add column bitrix_trip_details_read boolean not null default false;
comment on column public.integration_intake_config.bitrix_trip_details_read is
  'Voice-note batch: the sync stores the Bitrix Deal destination (option id) and the adults / children / infants counts (read-only) and the daily name refresh reads the destination option names. Off by default; written only by public.integration_set_bitrix_trip_details_read (Super Admin, reason, audited). Live use needs the owner''s APPROVE.';

-- Latest list (20261121000100) with the new switch appended.
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
    'bitrix_name_read',
    -- Voice-note batch
    'bitrix_trip_details_read');

-- Same shape and authorization as public.integration_set_bitrix_name_read.
create function public.integration_set_bitrix_trip_details_read(p_enabled boolean, p_reason text) returns jsonb
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
  if v_cfg.bitrix_trip_details_read = p_enabled then
    return jsonb_build_object('changed', false, 'enabled', p_enabled);
  end if;
  v_prev := authz.settings_begin_change('integration_set_bitrix_trip_details_read', v_reason);
  update public.integration_intake_config c
  set bitrix_trip_details_read = p_enabled, updated_at = now(), updated_by = auth.uid()
  where c.id = v_cfg.id;
  perform authz.settings_end_change(v_prev);
  perform authz.write_audit('integration.bitrix_trip_details_read_set', v_cfg.pilot_legal_entity_id, null,
    'integration_intake_config', v_cfg.id, v_reason,
    jsonb_build_object('before', v_cfg.bitrix_trip_details_read, 'after', p_enabled));
  return jsonb_build_object('changed', true, 'enabled', p_enabled);
end;
$$;

-- Same shape as public.bitrix_name_read_state (20261121000140).
create function public.bitrix_trip_details_read_state() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_n integer;
  v_last public.audit_events%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select count(*) into v_n from public.integration_intake_config;
  if v_n <> 1 then
    raise exception 'intake is not configured' using errcode = '55000';
  end if;
  select * into v_cfg from public.integration_intake_config;
  if not (coalesce(authz.can_admin('integration.manage', v_cfg.pilot_legal_entity_id), false)
          or authz.can_switch_live_settings(v_cfg.pilot_legal_entity_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select a.* into v_last
  from public.audit_events a
  where a.action = 'settings.intake_config_changed' and a.target_id = v_cfg.id
    and a.details ->> 'operation' = 'update' and (a.details -> 'changes') ? 'bitrix_trip_details_read'
  order by a.occurred_at desc, a.id desc
  limit 1;
  return jsonb_build_object(
    'enabled', v_cfg.bitrix_trip_details_read,
    'connectionEnabled', v_cfg.enabled,
    'effective', v_cfg.enabled and v_cfg.bitrix_trip_details_read,
    'canSwitch', authz.can_switch_live_settings(v_cfg.pilot_legal_entity_id),
    'lastChange', case when v_last.id is null then null else jsonb_build_object(
      'at', v_last.occurred_at,
      'byName', (select p.display_name from public.staff_profiles p where p.user_id = v_last.actor_user_id),
      'via', v_last.details ->> 'via',
      'to', v_last.details -> 'changes' -> 'bitrix_trip_details_read' -> 'to',
      'reason', v_last.reason) end);
end;
$$;

-- ===========================================================================
-- 2. Stored trip details
-- ===========================================================================

alter table public.deal_source_trip_facts
  add column destination_field text check (destination_field in ('single', 'multi')),
  add column destination_option_id text check (destination_option_id ~ '^[1-9][0-9]{0,9}$'),
  add column adults smallint check (adults between 0 and 100),
  add column children smallint check (children between 0 and 100),
  add column infants smallint check (infants between 0 and 100),
  add column details_issues text[] not null default '{}',
  add column details_read_at timestamptz,
  add constraint deal_source_trip_facts_destination_pair
    check ((destination_field is null) = (destination_option_id is null));
comment on column public.deal_source_trip_facts.destination_option_id is
  'Voice-note batch: Bitrix Destination option id (UF_CRM_6876462911034, else the first value of UF_CRM_6A9BD81EA7CCF; destination_field says which). Written only while bitrix_trip_details_read is on. The label comes from bitrix_name_lists.';

-- Issue codes of the trip details (never the value).
create function authz.trip_detail_issue_codes() returns text[]
language sql immutable set search_path = '' as $$
  select array['adults_unreadable', 'children_unreadable', 'infants_unreadable', 'destination_unreadable']
$$;

-- ===========================================================================
-- 3. Trip facts apply (replaces 20261120000400; lines marked "VN")
-- ===========================================================================

-- p_facts (camelCase, normalised by the app; the database re-checks every key):
--   Deal: {dateModify, bookingNotes, travellerTotal, tourStart, tourEnd, customerTypeId, contactId, contactIds,
--          companyId, issues,
--          VN: destinationField ('single' | 'multi' | null), destinationOptionId, adults, children, infants,
--              detailsIssues}
--   Lead: {dateModify, customerTypeId, contactId, contactIds, companyId, companyTitle, issues}
-- Each group is written only while its switch is on (older fields and the
-- Lead: bitrix_trip_facts_read; VN fields: bitrix_trip_details_read); the keys
-- of a group whose switch is off are ignored and its stored values are kept.
-- Returns {outcome: switched_off | not_applicable | stale | unchanged | stored,
--          parties: [{kind, id}]}.
create or replace function public.integration_apply_bitrix_trip_facts(p_inbox_id uuid, p_facts jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_inbox public.integration_inbox%rowtype;
  v_cfg public.integration_intake_config%rowtype;
  v_subject uuid;
  v_entity uuid;
  v_branch uuid;
  v_modified timestamptz;
  v_subject_modified timestamptz;
  v_is_deal boolean;
  v_allowed text[];
  v_notes text;
  v_total smallint;
  v_start date;
  v_end date;
  v_type text;
  v_contact bigint;
  v_contacts bigint[];
  v_company bigint;
  v_company_title text;
  v_issues text[];
  v_deal public.deal_source_trip_facts%rowtype;
  v_lead public.lead_source_facts%rowtype;
  v_changed text[] := '{}'::text[];
  v_parties jsonb := '[]'::jsonb;
  v_primary bigint;
  v_link_changed boolean := false;
  k text;
  -- VN
  v_facts_on boolean;
  v_details_on boolean;
  v_dest_field text;
  v_dest_option text;
  v_adults smallint;
  v_children smallint;
  v_infants smallint;
  v_details_issues text[];
begin
  select * into v_inbox from public.integration_inbox i where i.id = p_inbox_id;
  if v_inbox.id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'inbox';
  end if;
  select * into v_cfg from public.integration_intake_config c
  where c.portal_member_id = v_inbox.portal_member_id and c.enabled for share;
  -- VN: either switch.
  v_facts_on := coalesce(v_cfg.bitrix_trip_facts_read, false);
  v_details_on := coalesce(v_cfg.bitrix_trip_details_read, false);
  if v_cfg.id is null or not (v_facts_on or v_details_on) then
    return jsonb_build_object('outcome', 'switched_off', 'parties', '[]'::jsonb);
  end if;
  v_subject := authz.trip_facts_subject(v_inbox);
  if v_subject is null then
    return jsonb_build_object('outcome', 'not_applicable', 'parties', '[]'::jsonb);
  end if;
  v_is_deal := v_inbox.source_object = 'deal';
  -- VN: a Lead has no trip details; with only the details switch on there is nothing to store.
  if not v_is_deal and not v_facts_on then
    return jsonb_build_object('outcome', 'switched_off', 'parties', '[]'::jsonb);
  end if;

  -- Shape: exactly the allowed keys, each of the expected JSON type.
  v_allowed := case when v_is_deal
    then array['dateModify', 'bookingNotes', 'travellerTotal', 'tourStart', 'tourEnd', 'customerTypeId',
               'contactId', 'contactIds', 'companyId', 'issues',
               -- VN
               'destinationField', 'destinationOptionId', 'adults', 'children', 'infants', 'detailsIssues']
    else array['dateModify', 'customerTypeId', 'contactId', 'contactIds', 'companyId', 'companyTitle', 'issues'] end;
  if p_facts is null or jsonb_typeof(p_facts) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'facts';
  end if;
  for k in select jsonb_object_keys(p_facts) loop
    if not (k = any (v_allowed)) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'facts';
    end if;
  end loop;
  begin
    if coalesce(jsonb_typeof(p_facts -> 'dateModify'), 'null') = 'null' then
      v_modified := null;
    elsif jsonb_typeof(p_facts -> 'dateModify') is distinct from 'string'
       or (p_facts ->> 'dateModify') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:?[0-9]{2})$' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'dateModify';
    else
      v_modified := (p_facts ->> 'dateModify')::timestamptz;
    end if;
    if coalesce(jsonb_typeof(p_facts -> 'bookingNotes'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(p_facts -> 'travellerTotal'), 'null') not in ('number', 'null')
       or coalesce(jsonb_typeof(p_facts -> 'tourStart'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(p_facts -> 'tourEnd'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(p_facts -> 'customerTypeId'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(p_facts -> 'contactId'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(p_facts -> 'contactIds'), 'array') <> 'array'
       or coalesce(jsonb_typeof(p_facts -> 'companyId'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(p_facts -> 'companyTitle'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(p_facts -> 'issues'), 'array') <> 'array'
       -- VN
       or coalesce(jsonb_typeof(p_facts -> 'destinationField'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(p_facts -> 'destinationOptionId'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(p_facts -> 'adults'), 'null') not in ('number', 'null')
       or coalesce(jsonb_typeof(p_facts -> 'children'), 'null') not in ('number', 'null')
       or coalesce(jsonb_typeof(p_facts -> 'infants'), 'null') not in ('number', 'null')
       or coalesce(jsonb_typeof(p_facts -> 'detailsIssues'), 'array') <> 'array' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'facts';
    end if;
    v_notes := nullif(p_facts ->> 'bookingNotes', '');
    if v_notes is not null and (char_length(v_notes) > 4000 or v_notes ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]') then
      raise exception 'invalid_input' using errcode = '22023', hint = 'bookingNotes';
    end if;
    if p_facts ? 'travellerTotal' and jsonb_typeof(p_facts -> 'travellerTotal') = 'number' then
      if (p_facts ->> 'travellerTotal') !~ '^[0-9]{1,3}$' or (p_facts ->> 'travellerTotal')::integer > 100 then
        raise exception 'invalid_input' using errcode = '22023', hint = 'travellerTotal';
      end if;
      v_total := (p_facts ->> 'travellerTotal')::smallint;
    end if;
    if nullif(p_facts ->> 'tourStart', '') is not null then
      if (p_facts ->> 'tourStart') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'invalid_input' using errcode = '22023', hint = 'tourStart';
      end if;
      v_start := (p_facts ->> 'tourStart')::date;
    end if;
    if nullif(p_facts ->> 'tourEnd', '') is not null then
      if (p_facts ->> 'tourEnd') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
        raise exception 'invalid_input' using errcode = '22023', hint = 'tourEnd';
      end if;
      v_end := (p_facts ->> 'tourEnd')::date;
    end if;
    v_type := nullif(p_facts ->> 'customerTypeId', '');
    if v_type is not null and v_type !~ '^[1-9][0-9]{0,9}$' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'customerTypeId';
    end if;
    if nullif(p_facts ->> 'contactId', '') is not null then
      if (p_facts ->> 'contactId') !~ '^[1-9][0-9]{0,17}$' then
        raise exception 'invalid_input' using errcode = '22023', hint = 'contactId';
      end if;
      v_contact := (p_facts ->> 'contactId')::bigint;
    end if;
    if exists (select 1 from jsonb_array_elements(coalesce(p_facts -> 'contactIds', '[]'::jsonb)) e
               where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^[1-9][0-9]{0,17}$')
       or jsonb_array_length(coalesce(p_facts -> 'contactIds', '[]'::jsonb)) > 20 then
      raise exception 'invalid_input' using errcode = '22023', hint = 'contactIds';
    end if;
    select coalesce(array_agg(distinct (e #>> '{}')::bigint), '{}') into v_contacts
    from jsonb_array_elements(coalesce(p_facts -> 'contactIds', '[]'::jsonb)) e;
    select coalesce(array_agg(x order by x), '{}') into v_contacts from unnest(v_contacts) x;
    if nullif(p_facts ->> 'companyId', '') is not null then
      if (p_facts ->> 'companyId') !~ '^[1-9][0-9]{0,17}$' then
        raise exception 'invalid_input' using errcode = '22023', hint = 'companyId';
      end if;
      v_company := (p_facts ->> 'companyId')::bigint;
    end if;
    v_company_title := nullif(btrim(coalesce(p_facts ->> 'companyTitle', '')), '');
    if v_company_title is not null and (char_length(v_company_title) > 200
        or v_company_title ~ '[\x00-\x1F\x7F]') then
      raise exception 'invalid_input' using errcode = '22023', hint = 'companyTitle';
    end if;
    if exists (select 1 from jsonb_array_elements(coalesce(p_facts -> 'issues', '[]'::jsonb)) e
               where jsonb_typeof(e) <> 'string' or not ((e #>> '{}') = any (authz.trip_fact_issue_codes()))) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'issues';
    end if;
    select coalesce(array_agg(distinct e #>> '{}'), '{}') into v_issues
    from jsonb_array_elements(coalesce(p_facts -> 'issues', '[]'::jsonb)) e;
    select coalesce(array_agg(x order by x), '{}') into v_issues from unnest(v_issues) x;
    -- VN: destination and counts.
    v_dest_field := nullif(p_facts ->> 'destinationField', '');
    v_dest_option := nullif(p_facts ->> 'destinationOptionId', '');
    if (v_dest_field is not null and v_dest_field not in ('single', 'multi'))
       or (v_dest_option is not null and v_dest_option !~ '^[1-9][0-9]{0,9}$')
       or ((v_dest_field is null) <> (v_dest_option is null)) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'destination';
    end if;
    foreach k in array array['adults', 'children', 'infants'] loop
      if jsonb_typeof(p_facts -> k) = 'number'
         and ((p_facts ->> k) !~ '^[0-9]{1,3}$' or (p_facts ->> k)::integer > 100) then
        raise exception 'invalid_input' using errcode = '22023', hint = k;
      end if;
    end loop;
    v_adults := case when jsonb_typeof(p_facts -> 'adults') = 'number' then (p_facts ->> 'adults')::smallint end;
    v_children := case when jsonb_typeof(p_facts -> 'children') = 'number' then (p_facts ->> 'children')::smallint end;
    v_infants := case when jsonb_typeof(p_facts -> 'infants') = 'number' then (p_facts ->> 'infants')::smallint end;
    if exists (select 1 from jsonb_array_elements(coalesce(p_facts -> 'detailsIssues', '[]'::jsonb)) e
               where jsonb_typeof(e) <> 'string' or not ((e #>> '{}') = any (authz.trip_detail_issue_codes()))) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'detailsIssues';
    end if;
    select coalesce(array_agg(distinct e #>> '{}'), '{}') into v_details_issues
    from jsonb_array_elements(coalesce(p_facts -> 'detailsIssues', '[]'::jsonb)) e;
    select coalesce(array_agg(x order by x), '{}') into v_details_issues from unnest(v_details_issues) x;
  exception when data_exception then
    raise exception 'invalid_input' using errcode = '22023', hint = 'facts';
  end;

  -- The facts must belong to exactly the version the apply stored.
  if v_is_deal then
    select d.legal_entity_id, d.branch_id, d.source_modified_at into v_entity, v_branch, v_subject_modified
    from public.deals d where d.id = v_subject;
  else
    select l.legal_entity_id, l.branch_id, l.source_modified_at into v_entity, v_branch, v_subject_modified
    from public.crm_leads l where l.id = v_subject;
  end if;
  if v_subject_modified is not null and v_modified is null then
    v_modified := v_subject_modified;
    if not ('date_modify_unreadable' = any (v_issues)) then
      v_issues := array(select x from unnest(array_append(v_issues, 'date_modify_unreadable')) x order by x);
    end if;
  end if;
  if v_subject_modified is null or v_subject_modified <> v_modified then
    return jsonb_build_object('outcome', 'stale', 'parties', '[]'::jsonb);
  end if;
  v_primary := coalesce(v_contact, v_contacts[1]);

  if v_is_deal then
    select * into v_deal from public.deal_source_trip_facts f where f.deal_id = v_subject for update;
    if v_deal.deal_id is not null and v_deal.source_modified_at > v_modified then
      return jsonb_build_object('outcome', 'stale', 'parties', '[]'::jsonb);
    end if;
    -- VN: a group whose switch is off keeps its stored values (keys ignored).
    if not v_facts_on then
      v_notes := v_deal.booking_notes; v_total := v_deal.traveller_total; v_start := v_deal.tour_start;
      v_end := v_deal.tour_end; v_type := v_deal.customer_type_enum_id; v_contact := v_deal.source_contact_id;
      v_contacts := coalesce(v_deal.source_contact_ids, '{}'); v_company := v_deal.source_company_id;
      v_issues := coalesce(v_deal.read_issues, '{}');
      v_primary := null;
    end if;
    if not v_details_on then
      v_dest_field := v_deal.destination_field; v_dest_option := v_deal.destination_option_id;
      v_adults := v_deal.adults; v_children := v_deal.children; v_infants := v_deal.infants;
      v_details_issues := coalesce(v_deal.details_issues, '{}');
    end if;
    if v_facts_on then
      if v_deal.deal_id is null or v_deal.booking_notes is distinct from v_notes then v_changed := array_append(v_changed, 'bookingNotes'); end if;
      if v_deal.deal_id is null or v_deal.traveller_total is distinct from v_total then v_changed := array_append(v_changed, 'travellerTotal'); end if;
      if v_deal.deal_id is null or v_deal.tour_start is distinct from v_start then v_changed := array_append(v_changed, 'tourStart'); end if;
      if v_deal.deal_id is null or v_deal.tour_end is distinct from v_end then v_changed := array_append(v_changed, 'tourEnd'); end if;
      if v_deal.deal_id is null or v_deal.customer_type_enum_id is distinct from v_type then v_changed := array_append(v_changed, 'customerType'); end if;
      if v_deal.deal_id is null or v_deal.source_contact_id is distinct from v_contact
         or v_deal.source_contact_ids is distinct from v_contacts then
        v_changed := array_append(v_changed, 'contact'); v_link_changed := true;
      end if;
      if v_deal.deal_id is null or v_deal.source_company_id is distinct from v_company then
        v_changed := array_append(v_changed, 'company'); v_link_changed := true;
      end if;
      if v_deal.deal_id is null or v_deal.read_issues is distinct from v_issues then v_changed := array_append(v_changed, 'issues'); end if;
    end if;
    -- VN
    if v_details_on then
      if v_deal.deal_id is null or v_deal.destination_option_id is distinct from v_dest_option
         or v_deal.destination_field is distinct from v_dest_field then
        v_changed := array_append(v_changed, 'destination');
      end if;
      if v_deal.deal_id is null or v_deal.adults is distinct from v_adults then v_changed := array_append(v_changed, 'adults'); end if;
      if v_deal.deal_id is null or v_deal.children is distinct from v_children then v_changed := array_append(v_changed, 'children'); end if;
      if v_deal.deal_id is null or v_deal.infants is distinct from v_infants then v_changed := array_append(v_changed, 'infants'); end if;
      if v_deal.deal_id is null or v_deal.details_issues is distinct from v_details_issues then
        v_changed := array_append(v_changed, 'detailsIssues');
      end if;
    end if;
    insert into public.deal_source_trip_facts as f
      (deal_id, legal_entity_id, booking_notes, traveller_total, tour_start, tour_end, customer_type_enum_id,
       source_contact_id, source_contact_ids, source_company_id, read_issues, source_modified_at, read_at,
       destination_field, destination_option_id, adults, children, infants, details_issues, details_read_at)
    values
      (v_subject, v_entity, v_notes, v_total, v_start, v_end, v_type,
       v_contact, v_contacts, v_company, v_issues, v_modified, now(),
       v_dest_field, v_dest_option, v_adults, v_children, v_infants, v_details_issues,
       case when v_details_on then now() end)
    on conflict (deal_id) do update
    set booking_notes = excluded.booking_notes, traveller_total = excluded.traveller_total,
        tour_start = excluded.tour_start, tour_end = excluded.tour_end,
        customer_type_enum_id = excluded.customer_type_enum_id, source_contact_id = excluded.source_contact_id,
        source_contact_ids = excluded.source_contact_ids, source_company_id = excluded.source_company_id,
        read_issues = excluded.read_issues, source_modified_at = excluded.source_modified_at, read_at = now(),
        destination_field = excluded.destination_field, destination_option_id = excluded.destination_option_id,
        adults = excluded.adults, children = excluded.children, infants = excluded.infants,
        details_issues = excluded.details_issues,
        details_read_at = coalesce(excluded.details_read_at, f.details_read_at);
  else
    select * into v_lead from public.lead_source_facts f where f.lead_id = v_subject for update;
    if v_lead.lead_id is not null and v_lead.source_modified_at > v_modified then
      return jsonb_build_object('outcome', 'stale', 'parties', '[]'::jsonb);
    end if;
    if v_lead.lead_id is null or v_lead.customer_type_enum_id is distinct from v_type then v_changed := array_append(v_changed, 'customerType'); end if;
    if v_lead.lead_id is null or v_lead.source_contact_id is distinct from v_contact
       or v_lead.source_contact_ids is distinct from v_contacts then
      v_changed := array_append(v_changed, 'contact'); v_link_changed := true;
    end if;
    if v_lead.lead_id is null or v_lead.source_company_id is distinct from v_company then
      v_changed := array_append(v_changed, 'company'); v_link_changed := true;
    end if;
    if v_lead.lead_id is null or v_lead.company_title is distinct from v_company_title then v_changed := array_append(v_changed, 'companyTitle'); end if;
    if v_lead.lead_id is null or v_lead.read_issues is distinct from v_issues then v_changed := array_append(v_changed, 'issues'); end if;
    insert into public.lead_source_facts as f
      (lead_id, legal_entity_id, customer_type_enum_id, source_contact_id, source_contact_ids, source_company_id,
       company_title, read_issues, source_modified_at, read_at)
    values
      (v_subject, v_entity, v_type, v_contact, v_contacts, v_company, v_company_title, v_issues, v_modified, now())
    on conflict (lead_id) do update
    set customer_type_enum_id = excluded.customer_type_enum_id, source_contact_id = excluded.source_contact_id,
        source_contact_ids = excluded.source_contact_ids, source_company_id = excluded.source_company_id,
        company_title = excluded.company_title, read_issues = excluded.read_issues,
        source_modified_at = excluded.source_modified_at, read_at = now();
  end if;

  -- Parties to read (VN: only while bitrix_trip_facts_read is on).
  if v_facts_on and v_primary is not null and (v_link_changed or not exists (
       select 1 from public.bitrix_party_snapshots s
       where s.source_portal = v_cfg.portal_member_id and s.party_kind = 'contact' and s.source_party_id = v_primary)) then
    v_parties := v_parties || jsonb_build_object('kind', 'contact', 'id', v_primary::text);
  end if;
  if v_facts_on and v_company is not null and (v_link_changed or not exists (
       select 1 from public.bitrix_party_snapshots s
       where s.source_portal = v_cfg.portal_member_id and s.party_kind = 'company' and s.source_party_id = v_company)) then
    v_parties := v_parties || jsonb_build_object('kind', 'company', 'id', v_company::text);
  end if;

  if cardinality(v_changed) = 0 then
    return jsonb_build_object('outcome', 'unchanged', 'parties', v_parties);
  end if;
  -- Field names and issue codes only, never values.
  perform authz.write_audit('integration.trip_facts_stored', v_entity, v_branch,
    case when v_is_deal then 'deal' else 'crm_lead' end, v_subject, null,
    jsonb_build_object('inboxId', v_inbox.id, 'fields', to_jsonb(v_changed), 'issues', to_jsonb(v_issues))
    || case when v_details_on and v_is_deal then jsonb_build_object('detailsIssues', to_jsonb(v_details_issues))
            else '{}'::jsonb end);
  return jsonb_build_object('outcome', 'stored', 'parties', v_parties);
end;
$$;

-- ===========================================================================
-- 4. Destination option names (name map lists)
-- ===========================================================================

alter table public.bitrix_name_lists drop constraint bitrix_name_lists_entity_id_check;
alter table public.bitrix_name_lists add constraint bitrix_name_lists_entity_id_check
  check (entity_id ~ '^(DEAL_STAGE|DEAL_STAGE_[1-9][0-9]{0,9}|STATUS|SOURCE|DEAL_DESTINATION|DEAL_DESTINATION_MULTI)$');

-- The enabled configuration of a portal with either name-reading switch on
-- (bitrix_name_read: stage / status / source lists; bitrix_trip_details_read:
-- the destination lists), or null.
create function authz.bitrix_names_config_any(p_portal text) returns public.integration_intake_config
language sql stable security definer set search_path = '' as $$
  select c.* from public.integration_intake_config c
  where c.portal_member_id = p_portal and c.enabled and (c.bitrix_name_read or c.bitrix_trip_details_read)
    and authz.intake_portal_allowed(c.portal_domain)
$$;
revoke all on function authz.bitrix_names_config_any(text) from public, anon, authenticated, service_role;

-- Replaces 20261121000100 (lines marked VN): works with either switch;
-- while the details switch is on it also answers statusLists (stage / status /
-- source lists may be read: the name switch) and destinations: true.
-- pipelineIds is empty while the name switch is off.
create or replace function public.integration_bitrix_names_due(p_portal text) returns jsonb
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
  v_cfg := authz.bitrix_names_config_any(p_portal);  -- VN
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
  if v_cfg.bitrix_name_read then  -- VN
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
  else
    v_pipelines := '{}';
  end if;
  -- VN: the list kinds are named only while the details switch is on, so the
  -- answer with only the name switch on is exactly as before.
  return jsonb_build_object('due', true, 'pipelineIds', to_jsonb(v_pipelines))
    || case when v_cfg.bitrix_trip_details_read
            then jsonb_build_object('statusLists', v_cfg.bitrix_name_read, 'destinations', true)
            else '{}'::jsonb end;
end;
$$;

-- Replaces 20261121000100 (lines marked VN): either switch; a stage, status or
-- source list needs the name switch and a destination list the details switch
-- (any other list is invalid_input, hint lists).
create or replace function public.integration_apply_bitrix_names(p_portal text, p_lists jsonb, p_complete boolean) returns jsonb
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
  v_cfg := authz.bitrix_names_config_any(p_portal);  -- VN
  if v_cfg.id is null then
    return jsonb_build_object('applied', false, 'reason', 'switched_off');
  end if;

  for v_list in select value from jsonb_array_elements(p_lists) loop
    if jsonb_typeof(v_list) <> 'object' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'lists';
    end if;
    v_entity := v_list ->> 'entityId';
    if v_entity is null
       or v_entity !~ '^(DEAL_STAGE|DEAL_STAGE_[1-9][0-9]{0,9}|STATUS|SOURCE|DEAL_DESTINATION|DEAL_DESTINATION_MULTI)$'
       -- VN: each list kind only while its own switch is on.
       or (v_entity like 'DEAL\_DESTINATION%' and not v_cfg.bitrix_trip_details_read)
       or (v_entity not like 'DEAL\_DESTINATION%' and not v_cfg.bitrix_name_read)
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

-- Replaces 20261121000100 (line marked VN): the destination lists are never
-- part of this answer (they have their own read below).
create or replace function public.bitrix_name_map() returns jsonb
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
        and l.entity_id not like 'DEAL\_DESTINATION%'  -- VN
        and (not v_purchase or l.entity_id like 'DEAL\_STAGE%')), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- 5. Destination classification
-- ===========================================================================

create table public.bitrix_destination_scopes (
  source_portal text not null check (source_portal ~ '^[A-Za-z0-9_-]{1,64}$'),
  list_entity_id text not null check (list_entity_id in ('DEAL_DESTINATION', 'DEAL_DESTINATION_MULTI')),
  option_id text not null check (option_id ~ '^[1-9][0-9]{0,9}$'),
  legal_entity_id uuid not null references public.legal_entities (id),
  scope text check (scope in ('domestic', 'international')),
  reason text not null check (char_length(reason) between 10 and 500),
  set_by uuid not null references public.staff_profiles (user_id),
  set_at timestamptz not null default now(),
  row_version integer not null default 1 check (row_version >= 1),
  created_at timestamptz not null default now(),
  primary key (source_portal, list_entity_id, option_id)
);
create index bitrix_destination_scopes_entity_idx on public.bitrix_destination_scopes (legal_entity_id);
create index bitrix_destination_scopes_set_by_idx on public.bitrix_destination_scopes (set_by);
comment on table public.bitrix_destination_scopes is
  'Voice-note batch: domestic / international per Bitrix Destination option, set once by a Super Admin with a reason (audited; null = cleared). Never guessed. Rows are never deleted. Written only by public.bitrix_destination_scope_set; read through public.bitrix_destination_options() and the booking trip facts. No Data API access.';

create trigger bitrix_destination_scopes_no_delete before delete on public.bitrix_destination_scopes
  for each row execute function authz.bitrix_names_no_delete();

alter table public.bitrix_destination_scopes enable row level security;
create policy require_valid_session on public.bitrix_destination_scopes as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.bitrix_destination_scopes from public, anon, authenticated, service_role;

-- Booking editors of an entity: an active Sales or Manager membership, no Purchase role.
create function authz.vn_booking_staff(p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false)
    and (authz.holds_active_role('sales', p_entity) or authz.holds_active_role('manager', p_entity))
    and not authz.holds_role('purchase', p_entity)
$$;

-- Options of both destination lists with their classification. The Super
-- Admin of the configuration's entity and its booking editors. While the
-- details switch (or the connection) is off: {enabled: false, options: []}.
create function public.bitrix_destination_options() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_n integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select count(*) into v_n from public.integration_intake_config;
  if v_n <> 1 then
    raise exception 'intake is not configured' using errcode = '55000';
  end if;
  select * into v_cfg from public.integration_intake_config;
  if not (authz.can_switch_live_settings(v_cfg.pilot_legal_entity_id)
          or authz.vn_booking_staff(v_cfg.pilot_legal_entity_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not (v_cfg.enabled and v_cfg.bitrix_trip_details_read) then
    return jsonb_build_object('enabled', false, 'readAt', null, 'canSet', false, 'options', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'enabled', true,
    'readAt', (select s.last_success_at from public.bitrix_name_refresh_state s where s.source_portal = v_cfg.portal_member_id),
    'canSet', authz.can_switch_live_settings(v_cfg.pilot_legal_entity_id),
    'options', coalesce((
      select jsonb_agg(jsonb_build_object(
          'listId', l.entity_id, 'optionId', l.code, 'label', l.name, 'missing', l.missing_since is not null,
          'scope', s.scope, 'rowVersion', coalesce(s.row_version, 0),
          'setByName', (select p.display_name from public.staff_profiles p where p.user_id = s.set_by),
          'setAt', s.set_at)
        order by l.entity_id, l.sort, l.name, l.code)
      from public.bitrix_name_lists l
      left join public.bitrix_destination_scopes s
        on s.source_portal = l.source_portal and s.list_entity_id = l.entity_id and s.option_id = l.code
      where l.source_portal = v_cfg.portal_member_id and l.entity_id like 'DEAL\_DESTINATION%'), '[]'::jsonb));
end;
$$;

-- Sets (domestic / international) or clears (null) the scope of one option.
-- Super Admin at aal2, reason 10-500, row version (0 = never set). The option
-- must be in the stored name list. Audited with before / after.
create function public.bitrix_destination_scope_set(
  p_list_id text, p_option_id text, p_scope text, p_expected_row_version integer, p_reason text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_n integer;
  v_reason text;
  v_old public.bitrix_destination_scopes%rowtype;
  v_row integer;
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
  if p_list_id is null or p_list_id not in ('DEAL_DESTINATION', 'DEAL_DESTINATION_MULTI') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'listId';
  end if;
  if p_option_id is null or p_option_id !~ '^[1-9][0-9]{0,9}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'optionId';
  end if;
  if p_scope is not null and p_scope not in ('domestic', 'international') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'scope';
  end if;
  if p_expected_row_version is null or p_expected_row_version < 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  if not exists (select 1 from public.bitrix_name_lists l
                 where l.source_portal = v_cfg.portal_member_id and l.entity_id = p_list_id and l.code = p_option_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_old from public.bitrix_destination_scopes s
  where s.source_portal = v_cfg.portal_member_id and s.list_entity_id = p_list_id and s.option_id = p_option_id
  for update;
  if coalesce(v_old.row_version, 0) <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if v_old.option_id is not null and v_old.scope is not distinct from p_scope then
    return jsonb_build_object('changed', false, 'scope', p_scope, 'rowVersion', v_old.row_version);
  end if;
  if v_old.option_id is null and p_scope is null then
    return jsonb_build_object('changed', false, 'scope', null, 'rowVersion', 0);
  end if;
  insert into public.bitrix_destination_scopes as s
    (source_portal, list_entity_id, option_id, legal_entity_id, scope, reason, set_by)
  values (v_cfg.portal_member_id, p_list_id, p_option_id, v_cfg.pilot_legal_entity_id, p_scope, v_reason,
    (select auth.uid()))
  on conflict (source_portal, list_entity_id, option_id) do update
  set scope = excluded.scope, reason = excluded.reason, set_by = excluded.set_by, set_at = now(),
      row_version = s.row_version + 1
  returning row_version into v_row;
  perform authz.write_audit('integration.destination_scope_set', v_cfg.pilot_legal_entity_id, null,
    'integration_intake_config', v_cfg.id, v_reason,
    jsonb_build_object('listId', p_list_id, 'optionId', p_option_id, 'before', v_old.scope, 'after', p_scope,
      'rowVersion', v_row));
  return jsonb_build_object('changed', true, 'scope', p_scope, 'rowVersion', v_row);
end;
$$;

-- ===========================================================================
-- 6. Settings page: the switch in the Bitrix list (body of 20261125000100;
--    lines marked VN)
-- ===========================================================================

create or replace function public.settings_switch_states() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_super boolean;
  v_wf public.workflow_settings%rowtype;
  v_workflow jsonb;
  v_n integer;
  v_cfg public.integration_intake_config%rowtype;
  v_bitrix jsonb;
  v_sync boolean;
  v_saved public.audit_events%rowtype;
  v_live jsonb;
  v_booking boolean;
  v_procurement boolean;
  k text;
  v_items jsonb;
  v_purchase boolean;  -- Echo-A M1
  v_integration boolean;  -- Echo-A L9
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_super := authz.can_switch_live_settings(null);
  v_purchase := authz.holds_purchase_anywhere();
  v_integration := not v_purchase and coalesce(authz.can_admin_any('integration.manage'), false);

  -- Workflow switches: Super Admin at aal2 (may change), and integration
  -- managers who hold no Purchase role (read only, as workflow_settings_get
  -- showed them before; Echo-A L9).
  if v_super or v_integration then
    select * into v_wf from public.workflow_settings s where s.id;
    v_items := '[]'::jsonb;
    foreach k in array array['service_items_enabled', 'intake_prompt_enabled', 'visa_passport_tasks_enabled',
                             'prefill_auto_fill', 'referral_drafts'] loop
      v_items := v_items || jsonb_build_object(
        'key', k,
        'state', authz.switch_state(case when v_wf.id is null then null else (to_jsonb(v_wf) ->> k)::boolean end),
        'lastChange', authz.settings_last_change('settings.workflow_changed', null, null, array[k], 'bool'));
    end loop;
    v_workflow := jsonb_build_object('readable', v_wf.id is not null, 'canSwitch', v_super, 'switches', v_items);
  end if;

  -- Bitrix connection (integration.manage or Super Admin of the config's
  -- company); never a Purchase holder (Echo-A M1, money-privacy-settings 6.4).
  select count(*) into v_n from public.integration_intake_config;
  if v_n = 1 and not v_purchase then
    select * into v_cfg from public.integration_intake_config;
    if coalesce(authz.can_admin('integration.manage', v_cfg.pilot_legal_entity_id), false)
       or authz.can_switch_live_settings(v_cfg.pilot_legal_entity_id) then
      v_items := '[]'::jsonb;
      foreach k in array array['bitrix_trip_facts_read', 'lead_intake_unowned', 'bitrix_id_proof_copy',
                               'bitrix_name_read'] loop
        v_items := v_items || jsonb_build_object(
          'key', k,
          'state', authz.switch_state((to_jsonb(v_cfg) ->> k)::boolean),
          'lastChange', authz.settings_last_change('settings.intake_config_changed', v_cfg.id, null, array[k], 'bool'));
      end loop;
      v_items := v_items || jsonb_build_object(
        'key', 'won_only_intake',
        'state', authz.switch_state(v_cfg.deal_entry_stage_ids is not null),
        'lastChange', authz.settings_last_change('settings.intake_config_changed', v_cfg.id, null,
                                                 array['deal_entry_stage_ids'], 'not_null'));
      -- VN: the trip details switch, after the existing list (order kept).
      v_items := v_items || jsonb_build_object(
        'key', 'bitrix_trip_details_read',
        'state', authz.switch_state(v_cfg.bitrix_trip_details_read),
        'lastChange', authz.settings_last_change('settings.intake_config_changed', v_cfg.id, null,
                                                 array['bitrix_trip_details_read'], 'bool'));
      select s.enabled into v_sync from public.integration_sync_schedule s where s.id;
      select a.* into v_saved from public.audit_events a
      where a.action = 'integration.settings_updated' and a.target_id = v_cfg.id
      order by a.occurred_at desc, a.id desc limit 1;
      v_bitrix := jsonb_build_object(
        'readable', true,
        'canSwitch', authz.can_switch_live_settings(v_cfg.pilot_legal_entity_id),
        'canManageSync', coalesce(authz.can_admin('integration.manage', v_cfg.pilot_legal_entity_id), false),
        'connectionEnabled', v_cfg.enabled,
        'pilotLegalEntityId', v_cfg.pilot_legal_entity_id,
        'pilotBranchId', v_cfg.pilot_branch_id,
        'pilotBranchName', (select b.name from public.branches b where b.id = v_cfg.pilot_branch_id),
        'switches', v_items,
        'syncSettings', jsonb_build_object(
          'categoryIds', to_jsonb(authz.intake_categories(v_cfg)),
          'stageIds', to_jsonb(v_cfg.eligible_stage_ids),
          'cutoffAt', v_cfg.cutoff_at,
          'leadIntakeMode', v_cfg.lead_intake_mode,
          'dealIntakeMode', v_cfg.deal_intake_mode,
          'autoSync', authz.switch_state(v_sync),
          'lastScopeChange', authz.settings_last_change('settings.intake_config_changed', v_cfg.id, null,
            array['eligible_category_ids', 'category_id', 'eligible_stage_ids', 'cutoff_at', 'lead_intake_mode',
                  'deal_intake_mode'], null),
          'lastSaved', case when v_saved.id is null then null else jsonb_build_object(
            'at', v_saved.occurred_at,
            'byName', (select p.display_name from public.staff_profiles p where p.user_id = v_saved.actor_user_id),
            'byYou', v_saved.actor_user_id is not null and v_saved.actor_user_id = (select auth.uid()),
            'reason', v_saved.reason,
            'autoSync', case when jsonb_typeof(v_saved.details -> 'syncEnabled') = 'boolean'
                             then v_saved.details -> 'syncEnabled' else 'null'::jsonb end,
            'hidden', case when jsonb_typeof(v_saved.details -> 'removed') = 'number'
                           then v_saved.details -> 'removed' else 'null'::jsonb end,
            'broughtBack', case when jsonb_typeof(v_saved.details -> 'restored') = 'number'
                                then v_saved.details -> 'restored' else 'null'::jsonb end) end));
    end if;
  elsif v_n <> 1 and not v_purchase and (v_integration or v_super) then
    -- No or several configurations: everything Unknown, never Off.
    v_bitrix := jsonb_build_object(
      'readable', false, 'canSwitch', false, 'canManageSync', false, 'connectionEnabled', null,
      'pilotLegalEntityId', null, 'pilotBranchId', null, 'pilotBranchName', null,
      'switches', (select jsonb_agg(jsonb_build_object('key', x, 'state', 'unknown', 'lastChange', null) order by o)
                   from unnest(array['bitrix_trip_facts_read', 'lead_intake_unowned', 'bitrix_id_proof_copy',
                                     'bitrix_name_read', 'won_only_intake',
                                     'bitrix_trip_details_read' /* VN */]) with ordinality u (x, o)),
      'syncSettings', jsonb_build_object('categoryIds', null, 'stageIds', null, 'cutoffAt', null,
        'leadIntakeMode', null, 'dealIntakeMode', null, 'autoSync', 'unknown', 'lastScopeChange', null,
        'lastSaved', null));
  end if;

  -- Read-only live switches (Super Admin at aal2; no control anywhere).
  if v_super then
    select s.real_booking_enabled into v_booking from public.booking_settings s where s.id;
    select s.live_supplier_confirmation_enabled into v_procurement from public.procurement_settings s where s.id;
    v_live := jsonb_build_object(
      'realBooking', jsonb_build_object('state', authz.switch_state(v_booking),
        'lastChange', authz.settings_last_change('settings.booking_changed', null, null,
                                                 array['real_booking_enabled'], 'bool')),
      'supplierConfirmation', jsonb_build_object('state', authz.switch_state(v_procurement),
        'lastChange', authz.settings_last_change('settings.procurement_changed', null, null,
                                                 array['live_supplier_confirmation_enabled'], 'bool')),
      'financeModes', coalesce((
        select jsonb_agg(jsonb_build_object(
          'legalEntityId', e.id, 'legalName', e.legal_name,
          'modes', (select jsonb_agg(jsonb_build_object(
                      'key', m.key,
                      'state', authz.switch_state((to_jsonb(f) ->> (m.key || '_live'))::boolean),
                      'lastChange', authz.settings_last_change('settings.finance_live_changed', e.id, e.id,
                                                               array[m.key || '_live'], 'bool'))
                      order by m.o)
                    from unnest(array['bank_transfer', 'upi', 'cash', 'cheque']) with ordinality m (key, o)))
          order by e.legal_name)
        from public.finance_live_settings f
        join public.legal_entities e on e.id = f.legal_entity_id
        where authz.holds_active_role('super_admin', e.id)), '[]'::jsonb));
  end if;

  if v_workflow is null and v_bitrix is null and v_live is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return jsonb_build_object('workflow', v_workflow, 'bitrix', v_bitrix, 'live', v_live);
end;
$$;

-- ===========================================================================
-- 7. Privileges
-- ===========================================================================

revoke all on function authz.trip_detail_issue_codes(), authz.vn_booking_staff(uuid)
from public, anon, authenticated, service_role;

revoke all on function public.integration_set_bitrix_trip_details_read(boolean, text), public.bitrix_trip_details_read_state(),
  public.bitrix_destination_options(), public.bitrix_destination_scope_set(text, text, text, integer, text)
from public, anon, authenticated, service_role;
grant execute on function public.integration_set_bitrix_trip_details_read(boolean, text), public.bitrix_trip_details_read_state(),
  public.bitrix_destination_options(), public.bitrix_destination_scope_set(text, text, text, integer, text)
to authenticated;

commit;
