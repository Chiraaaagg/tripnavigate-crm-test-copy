-- TripNavigate CRM - B1.2 Phase E (Nova): read-only Bitrix trip facts (DEC-36)
-- and all Leads (DEC-37).
--
-- Freeze note: docs/implementation/frontend-first-plan-2026-10-10/b1.2/
--   b1.2-freeze-note-part-2.md section 4 (frozen 12 October 2026).
-- Field codes: phase-a-bitrix-and-engines.md section 2.0 (metadata of 12 Oct).
--
-- What changes:
--   1. Two switches on public.integration_intake_config, both OFF by default,
--      written only by the audited Super Admin command
--      public.integration_set_bitrix_read_switches (reason 10-500), watched by
--      the settings audit trigger:
--        bitrix_trip_facts_read  the sync stores the DEC-36 values below;
--        lead_intake_unowned     a scope-mode Lead whose Bitrix responsible is
--                                not an eligible pilot Sales member is stored
--                                "waiting for an owner" instead of being
--                                ignored (owner_not_eligible).
--   2. public.crm_leads: owner_user_id becomes nullable (only for scope-mode
--      Leads, constraint crm_leads_owner_required_unless_scope) and gains
--      source_assigned_by_id (Bitrix ASSIGNED_BY_ID, written by the Lead apply).
--      Visibility is unchanged: authz.can_read_lead already shows every Lead of
--      the branch to its Manager and only own Leads to Sales, so an unowned
--      Lead is visible to the branch Manager (and the integration admin) only.
--   3. New tables, written only by the two service-role commands below, no Data
--      API grants (definer reads only):
--        deal_source_trip_facts    Booking Notes, Total Number of Travelers,
--                                  Tour Start/End Date, Customer Type, Contact
--                                  and Company links of an imported Deal;
--        lead_source_facts         Customer Type, Contact/Company links and
--                                  company name of an imported Lead;
--        bitrix_party_snapshots    linked Contact / Company: name, phones,
--                                  e-mails only (personal data);
--        bitrix_customer_type_options  enumeration ids -> label (metadata).
--   4. public.integration_apply_bitrix_trip_facts(p_inbox_id, p_facts) and
--      public.integration_apply_bitrix_party(p_inbox_id, p_party): service role
--      only; run after the Deal/Lead apply has finished the same inbox row;
--      no-op ('switched_off') while bitrix_trip_facts_read is off. Audit rows
--      carry field NAMES and issue codes only, never values.
--   5. authz.bitrix_prefill_json(p_subject_kind, p_subject_id): the frozen read
--      helper for Atlas's prefill landing (20261120000600). Not granted to any
--      API role: only definer commands that have already authorized the caller
--      may call it.
--   6. Replaced (latest bodies copied unchanged except lines marked "B1.2 0400"):
--        public.integration_apply_bitrix_lead(uuid, uuid, jsonb)  from 20261112000100
--        authz.reassign_bitrix_user_deals(text, bigint, text)     from 20261107000100
--      Same signatures, same grants.
--
-- Switch behaviour: with both switches off every replaced function behaves as
-- before (the Lead apply additionally records source_assigned_by_id; its
-- outcome, audit details and stale rule are unchanged), the new commands write
-- nothing and the helper answers {available: false}.
--
-- Refusal tokens (message is exactly the token):
--   42501 not_authorized
--   22023 invalid_input (hint names the field), not_linked
--   55000 intake is not configured (unchanged wording)
--
-- Rollback (forward-only): switch both off with
-- integration_set_bitrix_read_switches(false, false, reason). Stored Leads
-- waiting for an owner stay visible to the branch Manager (nothing deleted).
-- Emergency: a new migration revoking execute on the new commands. Never
-- delete Leads, facts snapshots or audit rows.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Switches
-- ===========================================================================

alter table public.integration_intake_config
  add column bitrix_trip_facts_read boolean not null default false,
  add column lead_intake_unowned boolean not null default false;
comment on column public.integration_intake_config.bitrix_trip_facts_read is
  'B1.2 DEC-36: the sync stores Booking Notes, Total Number of Travelers, Tour Start/End Date, Customer Type and the linked Contact/Company name, phone and e-mail (read-only). Off by default; written only by public.integration_set_bitrix_read_switches (Super Admin, reason, audited). Live use needs the owner''s APPROVE.';
comment on column public.integration_intake_config.lead_intake_unowned is
  'B1.2 DEC-37: in Lead scope mode, a Lead whose Bitrix responsible is not an eligible pilot Sales member is stored waiting for an owner (visible to the branch Manager) instead of being ignored. Off by default; written only by public.integration_set_bitrix_read_switches.';

drop trigger integration_intake_config_audit on public.integration_intake_config;
create trigger integration_intake_config_audit
  after insert or update or delete on public.integration_intake_config
  for each row execute function authz.audit_settings_change(
    'settings.intake_config_changed', 'enabled', 'portal_domain', 'portal_member_id', 'category_id',
    'eligible_category_ids', 'eligible_stage_ids', 'cutoff_at', 'pilot_legal_entity_id', 'pilot_branch_id',
    'lead_intake_mode', 'deal_intake_mode',
    'deal_entry_stage_ids',
    -- B1.2 0400
    'bitrix_trip_facts_read', 'lead_intake_unowned');

-- ===========================================================================
-- 2. Leads waiting for an owner
-- ===========================================================================

alter table public.crm_leads alter column owner_user_id drop not null;
alter table public.crm_leads
  add column source_assigned_by_id bigint check (source_assigned_by_id > 0);
alter table public.crm_leads add constraint crm_leads_owner_required_unless_scope
  check (owner_user_id is not null or intake_mode = 'scope');
comment on column public.crm_leads.owner_user_id is
  'CRM Sales owner. Null = waiting for an owner (scope-mode Lead whose Bitrix responsible is not an eligible pilot Sales member; lead_intake_unowned on). Filled when the Bitrix user is linked to an eligible Sales member.';
comment on column public.crm_leads.source_assigned_by_id is
  'Bitrix ASSIGNED_BY_ID of the Lead as last applied (null for Leads written before 20261120000400 until their next apply).';
create index crm_leads_waiting_owner_idx on public.crm_leads (source_portal, source_assigned_by_id)
  where owner_user_id is null;

-- ===========================================================================
-- 3. Tables
-- ===========================================================================

-- Customer Type enumeration ids per Bitrix object (crm.*.fields metadata of
-- 12 October 2026), mapped to one canonical code per Bitrix label:
-- b2d = "B2D", corporate = "Corporate", travel_agent = the third Bitrix label.
-- The code is the only thing other code relies on (screens show the label).
create table public.bitrix_customer_type_options (
  source_object text not null check (source_object in ('deal', 'lead', 'contact')),
  enum_id text not null check (enum_id ~ '^[1-9][0-9]{0,9}$'),
  code text not null check (code in ('b2d', 'corporate', 'travel_agent')),
  primary key (source_object, enum_id)
);
comment on table public.bitrix_customer_type_options is
  'Bitrix Customer Type option ids (metadata, not customer data) mapped to a canonical code. An id not listed reads as an unknown option.';
insert into public.bitrix_customer_type_options (source_object, enum_id, code) values
  ('deal', '3045', 'b2d'), ('deal', '5049', 'corporate'), ('deal', '5051', 'travel_agent'),
  ('lead', '1353', 'b2d'), ('lead', '5053', 'corporate'), ('lead', '5055', 'travel_agent'),
  ('contact', '2421', 'b2d'), ('contact', '5057', 'corporate'), ('contact', '5059', 'travel_agent');

create table public.deal_source_trip_facts (
  deal_id uuid primary key references public.deals (id),
  legal_entity_id uuid not null references public.legal_entities (id),
  booking_notes text check (char_length(booking_notes) between 1 and 4000),
  traveller_total smallint check (traveller_total between 0 and 100),
  tour_start date check (tour_start between date '2000-01-01' and date '2100-12-31'),
  tour_end date check (tour_end between date '2000-01-01' and date '2100-12-31'),
  customer_type_enum_id text check (customer_type_enum_id ~ '^[1-9][0-9]{0,9}$'),
  source_contact_id bigint check (source_contact_id > 0),
  source_contact_ids bigint[] not null default '{}' check (cardinality(source_contact_ids) <= 20),
  source_company_id bigint check (source_company_id > 0),
  read_issues text[] not null default '{}',
  source_modified_at timestamptz not null,
  read_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index deal_source_trip_facts_entity_idx on public.deal_source_trip_facts (legal_entity_id);
comment on table public.deal_source_trip_facts is
  'Read-only Bitrix values of an imported Deal (DEC-36): suggestions only, never booking facts. May contain prices or personal details in Booking Notes: Sales owner, branch Manager and Accounts through definer reads; never Purchase, Flight, the desk or Super Admin. No Data API access.';

create table public.lead_source_facts (
  lead_id uuid primary key references public.crm_leads (id),
  legal_entity_id uuid not null references public.legal_entities (id),
  customer_type_enum_id text check (customer_type_enum_id ~ '^[1-9][0-9]{0,9}$'),
  source_contact_id bigint check (source_contact_id > 0),
  source_contact_ids bigint[] not null default '{}' check (cardinality(source_contact_ids) <= 20),
  source_company_id bigint check (source_company_id > 0),
  company_title text check (char_length(company_title) between 1 and 200),
  read_issues text[] not null default '{}',
  source_modified_at timestamptz not null,
  read_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index lead_source_facts_entity_idx on public.lead_source_facts (legal_entity_id);
comment on table public.lead_source_facts is
  'Read-only Bitrix values of an imported Lead (DEC-36; Leads have no Booking Notes, traveller total or tour dates). Definer reads only.';

create table public.bitrix_party_snapshots (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  source_portal text not null check (source_portal ~ '^[A-Za-z0-9_-]{1,64}$'),
  party_kind text not null check (party_kind in ('contact', 'company')),
  source_party_id bigint not null check (source_party_id > 0),
  display_name text check (char_length(display_name) between 1 and 200),
  phones text[] not null default '{}' check (cardinality(phones) <= 5),
  emails text[] not null default '{}' check (cardinality(emails) <= 5),
  source_modified_at timestamptz,
  read_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (source_portal, party_kind, source_party_id)
);
create index bitrix_party_snapshots_entity_idx on public.bitrix_party_snapshots (legal_entity_id);
comment on table public.bitrix_party_snapshots is
  'Linked Bitrix Contact / Company basics (name, phones, e-mails only; personal data). Never passport, birth date, address, religion or files. No Data API access; read only through authz.bitrix_prefill_json for an authorized caller.';

do $$
declare
  t text;
begin
  foreach t in array array['bitrix_customer_type_options', 'deal_source_trip_facts', 'lead_source_facts',
                           'bitrix_party_snapshots'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

-- ===========================================================================
-- 4. Switch command (Super Admin, reason, audited)
-- ===========================================================================

-- Null keeps a switch as it is. Turning lead_intake_unowned on hands the
-- LATEST ignored owner_not_eligible event of each Lead (at most 2000 Leads,
-- Leads with an open row skipped) back to the worker, so those Leads are
-- stored waiting for an owner; the result and the audit row carry the count
-- requeued and the count left (a later full Lead check covers those). Turning
-- a switch off deletes nothing.
create function public.integration_set_bitrix_read_switches(
  p_trip_facts_read boolean, p_lead_intake_unowned boolean, p_reason text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_n integer;
  v_reason text;
  v_prev text[];
  v_facts boolean;
  v_unowned boolean;
  v_requeued integer := 0;
  v_left integer := 0;
  v_before jsonb;
  v_after jsonb;
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
  if p_trip_facts_read is null and p_lead_intake_unowned is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'switches';
  end if;

  select * into v_cfg from public.integration_intake_config c where c.id = v_cfg.id for update;
  v_facts := coalesce(p_trip_facts_read, v_cfg.bitrix_trip_facts_read);
  v_unowned := coalesce(p_lead_intake_unowned, v_cfg.lead_intake_unowned);
  v_before := jsonb_build_object('tripFactsRead', v_cfg.bitrix_trip_facts_read, 'leadIntakeUnowned', v_cfg.lead_intake_unowned);
  v_after := jsonb_build_object('tripFactsRead', v_facts, 'leadIntakeUnowned', v_unowned);
  if v_before = v_after then
    return jsonb_build_object('changed', false, 'before', v_before, 'after', v_after, 'requeued', 0, 'notRequeued', 0);
  end if;

  v_prev := authz.settings_begin_change('integration_set_bitrix_read_switches', v_reason);
  update public.integration_intake_config c
  set bitrix_trip_facts_read = v_facts, lead_intake_unowned = v_unowned, updated_at = now(), updated_by = auth.uid()
  where c.id = v_cfg.id;
  perform authz.settings_end_change(v_prev);

  if v_unowned and not v_cfg.lead_intake_unowned then
    -- One row per Lead (its newest skipped event), bounded; Leads that already
    -- have a pending, processing or failed row are left to that row.
    with latest as (
      select distinct on (i.source_deal_id) i.id, i.source_deal_id
      from public.integration_inbox i
      where i.portal_member_id = v_cfg.portal_member_id and i.source_object = 'lead' and i.status = 'ignored'
        and i.reason_code = 'owner_not_eligible'
        and not exists (select 1 from public.integration_inbox o
                        where o.portal_member_id = i.portal_member_id and o.source_object = 'lead'
                          and o.source_deal_id = i.source_deal_id and o.status in ('pending', 'processing', 'failed'))
      -- Newest by the Bitrix event time first: received_at ties inside one
      -- transaction (now() is the transaction start), so it only breaks ties.
      order by i.source_deal_id, i.source_ts desc, i.received_at desc, i.id desc
    ), picked as (
      select l.id from latest l order by l.source_deal_id limit 2000
    )
    update public.integration_inbox i
    set status = 'pending', attempts = 0, next_attempt_at = now(), reason_code = null,
        origin = 'manual_retry', updated_at = now()
    from picked p
    where i.id = p.id;
    get diagnostics v_requeued = row_count;
    select count(distinct i.source_deal_id)::integer into v_left
    from public.integration_inbox i
    where i.portal_member_id = v_cfg.portal_member_id and i.source_object = 'lead' and i.status = 'ignored'
      and i.reason_code = 'owner_not_eligible'
      and not exists (select 1 from public.integration_inbox o
                      where o.portal_member_id = i.portal_member_id and o.source_object = 'lead'
                        and o.source_deal_id = i.source_deal_id and o.status in ('pending', 'processing', 'failed'));
  end if;

  perform authz.write_audit('integration.bitrix_read_switches_set', v_cfg.pilot_legal_entity_id, null,
    'integration_intake_config', v_cfg.id, v_reason,
    jsonb_build_object('before', v_before, 'after', v_after, 'requeued', v_requeued, 'notRequeued', v_left));
  return jsonb_build_object('changed', true, 'before', v_before, 'after', v_after, 'requeued', v_requeued,
    'notRequeued', v_left);
end;
$$;

revoke all on function public.integration_set_bitrix_read_switches(boolean, boolean, text)
from public, anon, authenticated, service_role;
grant execute on function public.integration_set_bitrix_read_switches(boolean, boolean, text) to authenticated;

-- ===========================================================================
-- 5. Lead apply (replaces 20261112000100; lines marked "B1.2 0400")
-- ===========================================================================

create or replace function public.integration_apply_bitrix_lead(p_inbox_id uuid, p_lock_token uuid, p_lead jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_inbox public.integration_inbox%rowtype;
  v_cfg public.integration_intake_config%rowtype;
  v_manifest public.intake_manifests%rowtype;
  v_existing public.crm_leads%rowtype;
  v_outcome text;
  v_reason text;
  v_lead_id uuid;
  v_owner uuid;
  v_title text;
  v_status text;
  v_source_code text;
  -- Stage 6: scope mode (integration_intake_config.lead_intake_mode).
  v_scope boolean;
  v_assigned bigint;
  v_created timestamptz;
  v_modified timestamptz;
  v_owner_changed boolean := false;
  v_invalid boolean := false;
  v_ref_conflict boolean := false;
  v_constraint text;
  v_iso constant text :=
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:?[0-9]{2})$';
begin
  select * into v_inbox from public.integration_inbox where id = p_inbox_id for update;
  if v_inbox.id is null or v_inbox.status <> 'processing' or v_inbox.lock_token is distinct from p_lock_token
     or v_inbox.locked_until <= now() then
    raise exception 'inbox lease not held' using errcode = '55P03';
  end if;
  -- A Deal is never passed to the Lead command.
  if v_inbox.source_object <> 'lead' then
    raise exception 'source object mismatch' using errcode = '22023';
  end if;

  <<checks>>
  begin
    if authz.deployment_environment() = 'unset' then
      v_outcome := 'needs_review'; v_reason := 'environment_unset';
      exit checks;
    end if;

    select * into v_cfg from public.integration_intake_config c
    where c.portal_member_id = v_inbox.portal_member_id and c.enabled for share;
    if v_cfg.id is null or not authz.intake_portal_allowed(v_cfg.portal_domain) then
      v_outcome := 'needs_review'; v_reason := 'not_configured';
      exit checks;
    end if;

    -- Stage 6: scope mode takes no manifest (v_manifest stays null). The
    -- config row is held FOR SHARE, so the mode cannot change mid-apply.
    v_scope := v_cfg.lead_intake_mode = 'scope';
    if not v_scope then
    -- Lock the active manifest row (FOR SHARE) for the rest of this command:
    -- integration_manifest_close takes FOR UPDATE, so a close either commits
    -- before this read (nothing is written here) or waits until this
    -- command has finished. Membership is checked against the locked row.
    select * into v_manifest from public.intake_manifests m
    where m.config_id = v_cfg.id and m.source_object = 'lead' and m.status = 'active'
    for share;
    if v_manifest.id is null or not exists (
      select 1 from public.intake_manifest_items i
      where i.manifest_id = v_manifest.id and i.source_object = 'lead' and i.source_id = v_inbox.source_deal_id
    ) then
      v_outcome := 'ignored'; v_reason := 'not_in_manifest';
      exit checks;
    end if;
    end if;

    if p_lead is null or jsonb_typeof(p_lead) = 'null' then
      v_outcome := 'needs_review'; v_reason := 'source_deal_not_found';
      exit checks;
    end if;

    if jsonb_typeof(p_lead) <> 'object' or exists (
         select 1 from unnest(array['id', 'title', 'statusId', 'assignedById', 'dateCreate', 'dateModify']) k
         where jsonb_typeof(p_lead -> k) is distinct from 'string')
       or coalesce(jsonb_typeof(p_lead -> 'sourceId'), 'null') not in ('string', 'null') then
      v_outcome := 'needs_review'; v_reason := 'invalid_source_data';
      exit checks;
    end if;
    begin
      if (p_lead ->> 'id') !~ '^[1-9][0-9]{0,17}$'
         -- Stage 6b: scope mode keeps the first 200 characters of a longer title.
         or length(btrim(p_lead ->> 'title')) not between 1 and (case when v_scope then 100000 else 200 end)
         or (p_lead ->> 'statusId') !~ '^[A-Za-z0-9_:.-]{1,50}$'
         or (p_lead ->> 'assignedById') !~ '^[1-9][0-9]{0,17}$'
         or (p_lead ->> 'dateCreate') !~ v_iso
         or (p_lead ->> 'dateModify') !~ v_iso then
        v_invalid := true;
      else
        v_title := btrim(p_lead ->> 'title');
        if v_scope and length(v_title) > 200 then
          v_title := left(v_title, 197) || '...';  -- Stage 6b: display copy only; Bitrix keeps the full title.
        end if;
        v_status := p_lead ->> 'statusId';
        v_source_code := p_lead ->> 'sourceId';
        v_assigned := (p_lead ->> 'assignedById')::bigint;
        v_created := (p_lead ->> 'dateCreate')::timestamptz;
        v_modified := (p_lead ->> 'dateModify')::timestamptz;
        if (p_lead ->> 'id')::bigint <> v_inbox.source_deal_id or v_modified < v_created then
          v_invalid := true;
        end if;
      end if;
    exception when data_exception then
      v_invalid := true;
    end;
    if v_invalid then
      v_outcome := 'needs_review'; v_reason := 'invalid_source_data';
      exit checks;
    end if;

    if v_scope then
      -- Stage 6: an empty or absent SOURCE_ID is stored as NONE; any other code
      -- must fit the stored code format.
      v_source_code := coalesce(nullif(v_source_code, ''), 'NONE');
      -- Stage 6b: Bitrix open-channel sources look like "1|WHATSAPP"; keep the
      -- code readable in the stored format ("|" and other characters become ":"
      -- or "_", at most 50 characters) instead of holding the Lead for review.
      v_source_code := left(regexp_replace(replace(v_source_code, '|', ':'), '[^A-Za-z0-9_:.-]', '_', 'g'), 50);
      if v_source_code !~ '^[A-Za-z0-9_:.-]{1,50}$' then
        v_outcome := 'needs_review'; v_reason := 'invalid_source_data';
        exit checks;
      end if;
    else
    -- Manifest scope: verified source code and creation interval.
    if v_source_code is distinct from v_manifest.source_code
       or v_created < v_manifest.interval_from or v_created >= v_manifest.interval_to then
      v_outcome := 'needs_review'; v_reason := 'outside_manifest_scope';
      exit checks;
    end if;
    end if;

    select * into v_existing from public.crm_leads l
    where l.source_system = 'bitrix' and l.source_portal = v_cfg.portal_member_id
      and l.source_lead_id = v_inbox.source_deal_id
    for update;
    -- A config change does not transfer an existing CRM record across a
    -- branch or legal entity. Hold the snapshot for an explicit transfer.
    if v_existing.id is not null and (
      v_existing.legal_entity_id is distinct from v_cfg.pilot_legal_entity_id
      or v_existing.branch_id is distinct from v_cfg.pilot_branch_id
    ) then
      v_outcome := 'needs_review'; v_reason := 'scope_changed';
      exit checks;
    end if;

    if v_existing.id is not null and v_modified < v_existing.source_modified_at then
      v_outcome := 'stale_ignored'; v_reason := 'stale_ignored'; v_lead_id := v_existing.id;
      exit checks;
    end if;

    if v_scope then
      -- Stage 6 entry rule: a new Lead must be CREATED on/after the sync date.
      -- A stored Lead keeps following Bitrix (DATE_CREATE does not change).
      if v_existing.id is null and v_created < v_cfg.cutoff_at then
        v_outcome := 'ignored'; v_reason := 'before_cutoff';
        exit checks;
      end if;
      -- Stage 6 owner rule: the Bitrix responsible maps to an active Sales
      -- member of the pilot branch (authz.is_eligible_deal_owner). Otherwise
      -- (lead decision) the Lead is outside the pilot: ignored, nothing is
      -- written (a stored Lead stays exactly as it is). Not held for review.
      v_owner := authz.bitrix_owner_for(v_cfg.portal_member_id, v_cfg.pilot_legal_entity_id, v_assigned);
      -- B1.2 0400: with lead_intake_unowned on, a NEW Lead (or a Lead already
      -- waiting for an owner) is stored waiting for an owner (owner_user_id
      -- null) instead of being ignored. A stored Lead that has an owner keeps
      -- it exactly as before: ignored / owner_not_eligible, nothing written.
      if v_owner is null and (not v_cfg.lead_intake_unowned
                              or (v_existing.id is not null and v_existing.owner_user_id is not null)) then
        v_outcome := 'ignored'; v_reason := 'owner_not_eligible'; v_lead_id := v_existing.id;
        exit checks;
      end if;
    else
    select m.staff_user_id into v_owner
    from public.bitrix_user_mappings m
    join public.staff_profiles p on p.user_id = m.staff_user_id and p.status = 'active'
    where m.portal_member_id = v_cfg.portal_member_id and m.bitrix_user_id = v_assigned and m.active;
    if v_owner is null then
      v_outcome := 'needs_review'; v_reason := 'unmapped_owner';
      exit checks;
    end if;
    -- Lead owners must hold an active Sales membership in the pilot branch
    -- (the same rule that makes the lead visible to them).
    if not exists (
      select 1 from public.memberships ms
      where ms.user_id = v_owner and ms.legal_entity_id = v_cfg.pilot_legal_entity_id
        and ms.branch_id = v_cfg.pilot_branch_id and ms.role_code = 'sales' and ms.status = 'active'
    ) then
      v_outcome := 'needs_review'; v_reason := 'owner_not_in_pilot_branch';
      exit checks;
    end if;
    end if;

    if v_existing.id is null then
      begin
        insert into public.crm_leads
          (legal_entity_id, branch_id, reference, title, owner_user_id, source_system, source_portal,
           source_lead_id, source_status_id, source_id_code, source_created_at, source_modified_at,
           last_synced_at, last_verified_at, intake_inbox_id, manifest_id,
           -- Stage 6
           intake_mode,
           -- B1.2 0400
           source_assigned_by_id)
        values
          (v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'BXL-' || v_inbox.source_deal_id::text,
           v_title, v_owner, 'bitrix', v_cfg.portal_member_id,
           v_inbox.source_deal_id, v_status, v_source_code, v_created, v_modified,
           now(), now(), v_inbox.id, v_manifest.id,
           -- Stage 6
           v_cfg.lead_intake_mode,
           -- B1.2 0400
           v_assigned)
        on conflict on constraint crm_leads_source_identity_unique do nothing
        returning id into v_lead_id;
      exception when unique_violation then
        get stacked diagnostics v_constraint = constraint_name;
        if v_constraint is distinct from 'crm_leads_reference_key' then
          raise;
        end if;
        v_ref_conflict := true;
      end;
      if v_ref_conflict then
        select * into v_existing from public.crm_leads l
        where l.source_system = 'bitrix' and l.source_portal = v_cfg.portal_member_id
          and l.source_lead_id = v_inbox.source_deal_id
        for update;
        if v_existing.id is null then
          v_outcome := 'needs_review'; v_reason := 'reference_conflict';
          exit checks;
        end if;
      end if;
      if v_lead_id is not null then
        v_outcome := 'created';
        exit checks;
      end if;
      select * into v_existing from public.crm_leads l
      where l.source_system = 'bitrix' and l.source_portal = v_cfg.portal_member_id
        and l.source_lead_id = v_inbox.source_deal_id
      for update;
      if v_modified < v_existing.source_modified_at then
        v_outcome := 'stale_ignored'; v_reason := 'stale_ignored'; v_lead_id := v_existing.id;
        exit checks;
      end if;
    end if;

    if v_modified = v_existing.source_modified_at
       and v_existing.title = v_title and v_existing.source_status_id = v_status
       -- B1.2 0400: null-safe owner comparison; the Bitrix responsible counts
       -- only while lead_intake_unowned is on (switch off: rule unchanged).
       and v_existing.source_id_code = v_source_code and v_existing.owner_user_id is not distinct from v_owner
       and (not v_cfg.lead_intake_unowned or v_existing.source_assigned_by_id is not distinct from v_assigned) then
      v_outcome := 'stale_ignored'; v_reason := 'stale_ignored'; v_lead_id := v_existing.id;
      exit checks;
    end if;

    -- B1.2 0400: null-safe.
    v_owner_changed := v_existing.owner_user_id is distinct from v_owner;
    update public.crm_leads l
    set title = v_title,
        owner_user_id = v_owner,
        source_status_id = v_status,
        source_id_code = v_source_code,
        source_created_at = v_created,
        source_modified_at = v_modified,
        last_synced_at = now(),
        last_verified_at = now(),
        intake_inbox_id = v_inbox.id,
        -- Stage 6: scope mode keeps the Lead's earlier manifest (if any).
        manifest_id = coalesce(v_manifest.id, l.manifest_id),
        intake_mode = v_cfg.lead_intake_mode,
        -- B1.2 0400
        source_assigned_by_id = v_assigned
    where l.id = v_existing.id;
    v_lead_id := v_existing.id;
    v_outcome := 'updated';
  end checks;

  if v_outcome = 'stale_ignored' then
    update public.crm_leads l set last_verified_at = now() where l.id = v_lead_id;
  end if;

  update public.integration_inbox i
  set status = case v_outcome
                 when 'created' then 'processed'
                 when 'updated' then 'processed'
                 when 'needs_review' then 'needs_review'
                 else 'ignored'
               end,
      reason_code = v_reason,
      processed_lead_id = v_lead_id,
      processed_at = now(),
      lock_token = null,
      locked_until = null,
      next_attempt_at = null,
      updated_at = now()
  where i.id = v_inbox.id;

  if v_outcome in ('created', 'updated') then
    perform authz.write_audit(
      case when v_outcome = 'created' then 'integration.lead_created' else 'integration.lead_updated' end,
      v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'crm_lead', v_lead_id, null,
      jsonb_build_object('inboxId', v_inbox.id, 'origin', v_inbox.origin, 'ownerChanged', v_owner_changed,
        'manifestId', v_manifest.id,
        -- Stage 6
        'intakeMode', v_cfg.lead_intake_mode)
      -- B1.2 0400: only a Lead waiting for an owner carries the extra key.
      || case when v_owner is null then jsonb_build_object('waitingForOwner', true) else '{}'::jsonb end);
  elsif v_outcome = 'needs_review' then
    perform authz.write_audit('integration.lead_needs_review',
      v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'integration_inbox', v_inbox.id, null,
      jsonb_build_object('inboxId', v_inbox.id, 'origin', v_inbox.origin, 'reasonCode', v_reason));
  end if;

  return jsonb_build_object('outcome', v_outcome, 'leadId', v_lead_id, 'reasonCode', v_reason);
end;
$$;

revoke all on function public.integration_apply_bitrix_lead(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.integration_apply_bitrix_lead(uuid, uuid, jsonb) to service_role;

-- ===========================================================================
-- 6. Owner re-evaluation on link / unlink / (de)activation
--    (replaces 20261107000100 line 1228; lines marked "B1.2 0400")
-- ===========================================================================

create or replace function authz.reassign_bitrix_user_deals(p_member_id text, p_bitrix_user bigint, p_cause text)
returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_owner uuid;
  v_count integer := 0;
  -- B1.2 0400
  v_leads integer := 0;
  r record;
begin
  select * into v_cfg from public.integration_intake_config c where c.portal_member_id = p_member_id;
  if v_cfg.id is null then
    return 0;
  end if;
  v_owner := authz.bitrix_owner_for(p_member_id, v_cfg.pilot_legal_entity_id, p_bitrix_user);
  for r in
    select d.id from public.deals d
    where d.source_system = 'bitrix' and d.source_portal = p_member_id and d.source_assigned_by_id = p_bitrix_user
      and d.removed_at is null
    order by d.id
    for update
  loop
    if authz.set_deal_owner(r.id, v_owner) then
      v_count := v_count + 1;
    end if;
  end loop;
  if v_count > 0 then
    perform authz.write_audit('integration.deal_owners_recomputed', v_cfg.pilot_legal_entity_id, null,
      'staff_profile', v_owner, null,
      jsonb_build_object('bitrixUserId', p_bitrix_user, 'ownerUserId', v_owner, 'dealsChanged', v_count,
        'cause', p_cause));
  end if;

  -- B1.2 0400: Leads waiting for an owner get the newly eligible owner. A Lead
  -- that already has an owner is left alone (its next Bitrix update decides).
  if v_cfg.lead_intake_unowned and v_owner is not null then
    for r in
      select l.id from public.crm_leads l
      where l.source_system = 'bitrix' and l.source_portal = p_member_id and l.source_assigned_by_id = p_bitrix_user
        and l.owner_user_id is null
        and l.legal_entity_id = v_cfg.pilot_legal_entity_id and l.branch_id = v_cfg.pilot_branch_id
      order by l.id
      for update
    loop
      update public.crm_leads l set owner_user_id = v_owner where l.id = r.id;
      v_leads := v_leads + 1;
    end loop;
    if v_leads > 0 then
      perform authz.write_audit('integration.lead_owners_filled', v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id,
        'staff_profile', v_owner, null,
        jsonb_build_object('bitrixUserId', p_bitrix_user, 'ownerUserId', v_owner, 'leadsFilled', v_leads,
          'cause', p_cause));
    end if;
  end if;
  return v_count;
end;
$$;

revoke all on function authz.reassign_bitrix_user_deals(text, bigint, text) from public, anon, authenticated, service_role;

-- ===========================================================================
-- 7. Trip facts and party snapshots (service role; after the apply)
-- ===========================================================================

-- Subject of a finished inbox row: the Deal or Lead it processed (created,
-- updated or confirmed unchanged). Null for any other row.
create function authz.trip_facts_subject(p_inbox public.integration_inbox) returns uuid
language sql stable set search_path = '' as $$
  select case
    when p_inbox.status = 'processed' or (p_inbox.status = 'ignored' and p_inbox.reason_code = 'stale_ignored') then
      case p_inbox.source_object when 'deal' then p_inbox.processed_deal_id when 'lead' then p_inbox.processed_lead_id end
  end
$$;

-- Issue codes the sync may record next to a value it could not read (never the value).
create function authz.trip_fact_issue_codes() returns text[]
language sql immutable set search_path = '' as $$
  select array['travellers_not_whole', 'travellers_out_of_range', 'tour_start_unreadable', 'tour_end_unreadable',
               'tour_end_before_start', 'booking_notes_truncated', 'customer_type_unreadable',
               'contact_ids_truncated', 'company_title_truncated', 'date_modify_unreadable']
$$;

-- p_facts (camelCase, normalised by the app; the database re-checks every key):
--   Deal: {dateModify (ISO, or null when unreadable), bookingNotes, travellerTotal, tourStart, tourEnd, customerTypeId,
--          contactId, contactIds, companyId, issues}
--   Lead: {dateModify, customerTypeId, contactId, contactIds, companyId, companyTitle, issues}
-- Returns {outcome: switched_off | not_applicable | stale | unchanged | stored,
--          parties: [{kind, id}]} - the linked parties the app should read next
-- (stored facts with a changed link, or a party without a snapshot).
create function public.integration_apply_bitrix_trip_facts(p_inbox_id uuid, p_facts jsonb) returns jsonb
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
  v_changed text[] := '{}';
  v_parties jsonb := '[]'::jsonb;
  v_primary bigint;
  v_link_changed boolean := false;
  k text;
begin
  select * into v_inbox from public.integration_inbox i where i.id = p_inbox_id;
  if v_inbox.id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'inbox';
  end if;
  select * into v_cfg from public.integration_intake_config c
  where c.portal_member_id = v_inbox.portal_member_id and c.enabled for share;
  if v_cfg.id is null or not v_cfg.bitrix_trip_facts_read then
    return jsonb_build_object('outcome', 'switched_off', 'parties', '[]'::jsonb);
  end if;
  v_subject := authz.trip_facts_subject(v_inbox);
  if v_subject is null then
    return jsonb_build_object('outcome', 'not_applicable', 'parties', '[]'::jsonb);
  end if;
  v_is_deal := v_inbox.source_object = 'deal';

  -- Shape: exactly the allowed keys, each of the expected JSON type.
  v_allowed := case when v_is_deal
    then array['dateModify', 'bookingNotes', 'travellerTotal', 'tourStart', 'tourEnd', 'customerTypeId',
               'contactId', 'contactIds', 'companyId', 'issues']
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
    -- dateModify null = the app could not read the Bitrix DATE_MODIFY: the
    -- values (read together with the version the apply just stored) are kept
    -- for that version with the issue date_modify_unreadable.
    if coalesce(jsonb_typeof(p_facts -> 'dateModify'), 'null') = 'null' then
      v_modified := null;
    elsif jsonb_typeof(p_facts -> 'dateModify') is distinct from 'string'
       or (p_facts ->> 'dateModify') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:?[0-9]{2})$' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'dateModify';
    else
      v_modified := (p_facts ->> 'dateModify')::timestamptz;
    end if;
    -- Optional strings and numbers: absent or JSON null = no value.
    if coalesce(jsonb_typeof(p_facts -> 'bookingNotes'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(p_facts -> 'travellerTotal'), 'null') not in ('number', 'null')
       or coalesce(jsonb_typeof(p_facts -> 'tourStart'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(p_facts -> 'tourEnd'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(p_facts -> 'customerTypeId'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(p_facts -> 'contactId'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(p_facts -> 'contactIds'), 'array') <> 'array'
       or coalesce(jsonb_typeof(p_facts -> 'companyId'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(p_facts -> 'companyTitle'), 'null') not in ('string', 'null')
       or coalesce(jsonb_typeof(p_facts -> 'issues'), 'array') <> 'array' then
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
    insert into public.deal_source_trip_facts as f
      (deal_id, legal_entity_id, booking_notes, traveller_total, tour_start, tour_end, customer_type_enum_id,
       source_contact_id, source_contact_ids, source_company_id, read_issues, source_modified_at, read_at)
    values
      (v_subject, v_entity, v_notes, v_total, v_start, v_end, v_type,
       v_contact, v_contacts, v_company, v_issues, v_modified, now())
    on conflict (deal_id) do update
    set booking_notes = excluded.booking_notes, traveller_total = excluded.traveller_total,
        tour_start = excluded.tour_start, tour_end = excluded.tour_end,
        customer_type_enum_id = excluded.customer_type_enum_id, source_contact_id = excluded.source_contact_id,
        source_contact_ids = excluded.source_contact_ids, source_company_id = excluded.source_company_id,
        read_issues = excluded.read_issues, source_modified_at = excluded.source_modified_at, read_at = now();
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

  -- Parties to read: the primary contact and the company, when the link
  -- changed or no snapshot exists yet.
  if v_primary is not null and (v_link_changed or not exists (
       select 1 from public.bitrix_party_snapshots s
       where s.source_portal = v_cfg.portal_member_id and s.party_kind = 'contact' and s.source_party_id = v_primary)) then
    v_parties := v_parties || jsonb_build_object('kind', 'contact', 'id', v_primary::text);
  end if;
  if v_company is not null and (v_link_changed or not exists (
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
    jsonb_build_object('inboxId', v_inbox.id, 'fields', to_jsonb(v_changed), 'issues', to_jsonb(v_issues)));
  return jsonb_build_object('outcome', 'stored', 'parties', v_parties);
end;
$$;

-- p_party: {kind: contact | company, id, dateModify (ISO or null), name, phones[], emails[]}
-- (already reduced by the app to these keys). The party must be linked from
-- the facts of the inbox row's Deal or Lead. Returns {outcome: switched_off |
-- not_applicable | stale | unchanged | stored}.
create function public.integration_apply_bitrix_party(p_inbox_id uuid, p_party jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_inbox public.integration_inbox%rowtype;
  v_cfg public.integration_intake_config%rowtype;
  v_subject uuid;
  v_entity uuid;
  v_branch uuid;
  v_kind text;
  v_id bigint;
  v_modified timestamptz;
  v_name text;
  v_phones text[];
  v_emails text[];
  v_existing public.bitrix_party_snapshots%rowtype;
  v_linked boolean;
  v_changed text[] := '{}';
  k text;
begin
  select * into v_inbox from public.integration_inbox i where i.id = p_inbox_id;
  if v_inbox.id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'inbox';
  end if;
  select * into v_cfg from public.integration_intake_config c
  where c.portal_member_id = v_inbox.portal_member_id and c.enabled for share;
  if v_cfg.id is null or not v_cfg.bitrix_trip_facts_read then
    return jsonb_build_object('outcome', 'switched_off');
  end if;
  v_subject := authz.trip_facts_subject(v_inbox);
  if v_subject is null then
    return jsonb_build_object('outcome', 'not_applicable');
  end if;

  if p_party is null or jsonb_typeof(p_party) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'party';
  end if;
  for k in select jsonb_object_keys(p_party) loop
    if k not in ('kind', 'id', 'dateModify', 'name', 'phones', 'emails') then
      raise exception 'invalid_input' using errcode = '22023', hint = 'party';
    end if;
  end loop;
  v_kind := p_party ->> 'kind';
  if v_kind is null or v_kind not in ('contact', 'company')
     or jsonb_typeof(p_party -> 'id') is distinct from 'string' or (p_party ->> 'id') !~ '^[1-9][0-9]{0,17}$'
     or coalesce(jsonb_typeof(p_party -> 'name'), 'null') not in ('string', 'null')
     or coalesce(jsonb_typeof(p_party -> 'dateModify'), 'null') not in ('string', 'null')
     or coalesce(jsonb_typeof(p_party -> 'phones'), 'array') <> 'array'
     or coalesce(jsonb_typeof(p_party -> 'emails'), 'array') <> 'array' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'party';
  end if;
  v_id := (p_party ->> 'id')::bigint;
  begin
    if nullif(p_party ->> 'dateModify', '') is not null then
      if (p_party ->> 'dateModify') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:?[0-9]{2})$' then
        raise exception 'invalid_input' using errcode = '22023', hint = 'dateModify';
      end if;
      v_modified := (p_party ->> 'dateModify')::timestamptz;
    end if;
  exception when data_exception then
    raise exception 'invalid_input' using errcode = '22023', hint = 'dateModify';
  end;
  v_name := nullif(btrim(coalesce(p_party ->> 'name', '')), '');
  if v_name is not null and (char_length(v_name) > 200 or v_name ~ '[\x00-\x1F\x7F]') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'name';
  end if;
  if jsonb_array_length(coalesce(p_party -> 'phones', '[]'::jsonb)) > 5
     or exists (select 1 from jsonb_array_elements(coalesce(p_party -> 'phones', '[]'::jsonb)) e
                where jsonb_typeof(e) <> 'string' or (e #>> '{}') !~ '^[0-9+() .-]{3,40}$') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'phones';
  end if;
  if jsonb_array_length(coalesce(p_party -> 'emails', '[]'::jsonb)) > 5
     or exists (select 1 from jsonb_array_elements(coalesce(p_party -> 'emails', '[]'::jsonb)) e
                where jsonb_typeof(e) <> 'string' or char_length(e #>> '{}') > 254
                   or (e #>> '{}') !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'emails';
  end if;
  select coalesce(array_agg(e #>> '{}' order by o), '{}') into v_phones
  from jsonb_array_elements(coalesce(p_party -> 'phones', '[]'::jsonb)) with ordinality x(e, o);
  select coalesce(array_agg(lower(e #>> '{}') order by o), '{}') into v_emails
  from jsonb_array_elements(coalesce(p_party -> 'emails', '[]'::jsonb)) with ordinality x(e, o);

  -- Only a party linked from this row's Deal or Lead facts.
  if v_inbox.source_object = 'deal' then
    select d.legal_entity_id, d.branch_id into v_entity, v_branch from public.deals d where d.id = v_subject;
    select case v_kind
             when 'contact' then f.source_contact_id = v_id or v_id = any (f.source_contact_ids)
             else f.source_company_id = v_id end
    into v_linked from public.deal_source_trip_facts f where f.deal_id = v_subject;
  else
    select l.legal_entity_id, l.branch_id into v_entity, v_branch from public.crm_leads l where l.id = v_subject;
    select case v_kind
             when 'contact' then f.source_contact_id = v_id or v_id = any (f.source_contact_ids)
             else f.source_company_id = v_id end
    into v_linked from public.lead_source_facts f where f.lead_id = v_subject;
  end if;
  if not coalesce(v_linked, false) then
    raise exception 'not_linked' using errcode = '22023';
  end if;

  select * into v_existing from public.bitrix_party_snapshots s
  where s.source_portal = v_cfg.portal_member_id and s.party_kind = v_kind and s.source_party_id = v_id
  for update;
  if v_existing.id is not null and v_modified is not null and v_existing.source_modified_at is not null
     and v_existing.source_modified_at > v_modified then
    return jsonb_build_object('outcome', 'stale');
  end if;
  if v_existing.id is null or v_existing.display_name is distinct from v_name then v_changed := array_append(v_changed, 'name'); end if;
  if v_existing.id is null or v_existing.phones is distinct from v_phones then v_changed := array_append(v_changed, 'phones'); end if;
  if v_existing.id is null or v_existing.emails is distinct from v_emails then v_changed := array_append(v_changed, 'emails'); end if;

  insert into public.bitrix_party_snapshots as s
    (legal_entity_id, source_portal, party_kind, source_party_id, display_name, phones, emails, source_modified_at, read_at)
  values (v_entity, v_cfg.portal_member_id, v_kind, v_id, v_name, v_phones, v_emails, v_modified, now())
  on conflict (source_portal, party_kind, source_party_id) do update
  set display_name = excluded.display_name, phones = excluded.phones, emails = excluded.emails,
      source_modified_at = excluded.source_modified_at, read_at = now();

  if cardinality(v_changed) = 0 then
    return jsonb_build_object('outcome', 'unchanged');
  end if;
  perform authz.write_audit('integration.party_snapshot_stored', v_entity, v_branch,
    case when v_inbox.source_object = 'deal' then 'deal' else 'crm_lead' end, v_subject, null,
    jsonb_build_object('inboxId', v_inbox.id, 'partyKind', v_kind, 'fields', to_jsonb(v_changed)));
  return jsonb_build_object('outcome', 'stored');
end;
$$;

revoke all on function
  authz.trip_facts_subject(public.integration_inbox), authz.trip_fact_issue_codes(),
  public.integration_apply_bitrix_trip_facts(uuid, jsonb), public.integration_apply_bitrix_party(uuid, jsonb)
from public, anon, authenticated, service_role;
grant execute on function
  public.integration_apply_bitrix_trip_facts(uuid, jsonb), public.integration_apply_bitrix_party(uuid, jsonb)
to service_role;

-- ===========================================================================
-- 8. Prefill read helper (frozen for Atlas 20261120000600)
-- ===========================================================================

-- {available, subjectKind, sourceModifiedAt, lastVerifiedAt, issues,
--  fields: {bookingNotes, travellerTotal, tourStart, tourEnd,
--           customerType: {enumId, code} | null   (code = b2d | corporate |
--                         travel_agent, null for an unknown option),
--           contact: {name, mobile, email} | null,
--           company: {name, phone, email} | null}}
-- Lead fields carry no Booking Notes, traveller total or tour dates (null).
-- available = false (fields null) while the read switch is off or nothing was
-- read yet. The caller authorizes first: this helper checks nothing and is
-- granted to no API role.
create function authz.bitrix_prefill_json(p_subject_kind text, p_subject_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_portal text;
  v_on boolean;
  v_deal public.deal_source_trip_facts%rowtype;
  v_lead public.lead_source_facts%rowtype;
  v_type text;
  v_contact_id bigint;
  v_company_id bigint;
  v_company_title text;
  v_modified timestamptz;
  v_read timestamptz;
  v_issues text[];
  v_label text;
  v_contact public.bitrix_party_snapshots%rowtype;
  v_company public.bitrix_party_snapshots%rowtype;
  v_empty constant jsonb := jsonb_build_object('bookingNotes', null, 'travellerTotal', null, 'tourStart', null,
    'tourEnd', null, 'customerType', null, 'contact', null, 'company', null);
begin
  if p_subject_kind not in ('deal', 'lead') or p_subject_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'subject';
  end if;
  if p_subject_kind = 'deal' then
    select d.source_portal into v_portal from public.deals d where d.id = p_subject_id;
    select * into v_deal from public.deal_source_trip_facts f where f.deal_id = p_subject_id;
    v_type := v_deal.customer_type_enum_id;
    v_contact_id := coalesce(v_deal.source_contact_id, v_deal.source_contact_ids[1]);
    v_company_id := v_deal.source_company_id;
    v_modified := v_deal.source_modified_at;
    v_read := v_deal.read_at;
    v_issues := v_deal.read_issues;
  else
    select l.source_portal into v_portal from public.crm_leads l where l.id = p_subject_id;
    select * into v_lead from public.lead_source_facts f where f.lead_id = p_subject_id;
    v_type := v_lead.customer_type_enum_id;
    v_contact_id := coalesce(v_lead.source_contact_id, v_lead.source_contact_ids[1]);
    v_company_id := v_lead.source_company_id;
    v_company_title := v_lead.company_title;
    v_modified := v_lead.source_modified_at;
    v_read := v_lead.read_at;
    v_issues := v_lead.read_issues;
  end if;
  select c.bitrix_trip_facts_read into v_on from public.integration_intake_config c
  where c.portal_member_id = v_portal and c.enabled;
  if not coalesce(v_on, false) or v_read is null then
    return jsonb_build_object('available', false, 'subjectKind', p_subject_kind, 'sourceModifiedAt', null,
      'lastVerifiedAt', null, 'issues', '[]'::jsonb, 'fields', v_empty);
  end if;

  select o.code into v_label from public.bitrix_customer_type_options o
  where o.source_object = p_subject_kind and o.enum_id = v_type;
  if v_contact_id is not null then
    select * into v_contact from public.bitrix_party_snapshots s
    where s.source_portal = v_portal and s.party_kind = 'contact' and s.source_party_id = v_contact_id;
  end if;
  if v_company_id is not null then
    select * into v_company from public.bitrix_party_snapshots s
    where s.source_portal = v_portal and s.party_kind = 'company' and s.source_party_id = v_company_id;
  end if;

  return jsonb_build_object(
    'available', true,
    'subjectKind', p_subject_kind,
    'sourceModifiedAt', v_modified,
    'lastVerifiedAt', v_read,
    'issues', to_jsonb(coalesce(v_issues, '{}'::text[])),
    'fields', jsonb_build_object(
      'bookingNotes', v_deal.booking_notes,
      'travellerTotal', v_deal.traveller_total,
      'tourStart', v_deal.tour_start,
      'tourEnd', v_deal.tour_end,
      'customerType', case when v_type is null then null
                           else jsonb_build_object('enumId', v_type, 'code', v_label) end,
      'contact', case when v_contact.id is null then null
                      else jsonb_build_object('name', v_contact.display_name, 'mobile', v_contact.phones[1],
                                              'email', v_contact.emails[1]) end,
      'company', case
                   when v_company.id is not null then jsonb_build_object('name', v_company.display_name,
                     'phone', v_company.phones[1], 'email', v_company.emails[1])
                   when v_company_title is not null then jsonb_build_object('name', v_company_title,
                     'phone', null, 'email', null)
                   else null end));
end;
$$;

revoke all on function authz.bitrix_prefill_json(text, uuid) from public, anon, authenticated, service_role;

commit;
