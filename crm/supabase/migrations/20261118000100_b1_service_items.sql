-- TripNavigate CRM - B1: service items, confirmed-booking intake, one task per
-- sold service, Flight queue, My work counts and Deal progress.
--
-- Contract: docs/implementation/frontend-first-plan-2026-10-10/
--   b1-contract-service-items-intake-tasks-2026-10-10.md (frozen 10 Oct 2026)
-- Shapes:  b1-freeze-note.md (same folder), crm/src/modules/fulfilment/contracts.ts
--   section "B1" (camelCase JSON keys as named there).
--
-- What changes:
--   * authz.task_trigger_stages (private, data-driven like authz.lost_deal_stages):
--     the Bitrix stages at which departmental tasks may be created. Seed
--     (0, 'UC_AD0SLH', 'Won - Payment Received'). authz.deal_in_trigger_stage
--     is true for synthetic and CRM-native Deals (no Bitrix stage to check).
--   * public.workflow_settings (single row, both switches off): changed only
--     through public.admin_set_workflow_setting (Super Admin, reason), audited
--     by the 20261114000100 settings trigger (settings.workflow_changed).
--   * public.service_items (identity of one sold service on a Deal),
--     public.service_item_facts (its facts and Purchase budget inside one
--     booking version, immutable once that version is confirmed),
--     public.deal_travellers (CRM-owned traveller names) and
--     public.booking_version_travellers (snapshot frozen at confirmation).
--   * public.booking_versions.service_type widens to ('hotel', 'package').
--     Every existing version, and every new one while service_items_enabled is
--     off, is 'hotel' and keeps today's readiness issues, today's
--     booking_confirm path, today's task key 'booking:<version>:hotel' and
--     today's content hash (authz.booking_hash). 'package' versions hash
--     their items and travellers instead (authz.booking_package_hash).
--   * public.fulfilment_tasks gains service_item_id (backfilled, then NOT
--     NULL) and department; service_purpose widens to the service types;
--     task_key accepts the legacy 'booking:' form and the new 'item:' form;
--     unique (booking_version_id, service_purpose) is replaced by
--     unique (booking_version_id, service_item_id) and
--     unique (service_item_id, service_purpose).
--   * public.outbox_events payloads may carry service_item_id and
--     service_type (still never amounts).
--   * Backfill: one 'hotel' service item per Deal that has a booking version,
--     one facts row per version copied from the hotel columns, every task
--     linked to its item. Count assertions stop the migration if they disagree.
--     Nothing is deleted and no content hash changes.
--   * Commands: service_item_add / save / remove, deal_travellers_save,
--     flight_task_claim, admin_set_workflow_setting. Reads: intake_checklist,
--     deal_services, deal_service_summary, my_work_counts, flight_task_list,
--     flight_task_get, workflow_settings_get. Replaced (latest bodies copied,
--     B1 lines marked): booking_open_draft (20261115000100), booking_confirm
--     (20261107000300), booking_panel (20261115000100), booking_health,
--     authz.booking_issues, authz.booking_versions_hash,
--     authz.booking_content_hash, authz.fulfilment_tasks_guard,
--     authz.can_read_purchase_task, authz.can_claim_purchase_task,
--     authz.task_budget, authz.purchase_task_json (20261005000100/200).
--   * Permissions deal.intake_edit (sales own, manager own), flight_task.read
--     (flight entity), flight_task.claim (flight own); none grantable.
--
-- Refusal tokens added (message is exactly the token):
--   55000 service_items_disabled, item_locked, traveller_identity_locked,
--         (and not_ready with issue stage_not_confirmed from readiness)
--   22023 service_on_hold, too_many_items, invalid_input (hint = field keys)
--   Existing tokens keep their SQLSTATEs.
--
-- Switch behaviour (freeze note section 2): while workflow_settings
-- .service_items_enabled is false, booking_open_draft creates 'hotel'
-- versions exactly as today; service_item_* and deal_travellers_save refuse
-- service_items_disabled; booking_confirm of a 'package' version refuses
-- service_items_disabled; my_work_counts.intakeNeeded is 0 while
-- intake_prompt_enabled is false. Switch off restores previous behaviour;
-- rows created while on stay readable.
--
-- Rollback (forward-only): switch service_items_enabled off. An emergency
-- rollback is a NEW migration that revokes execute on the service_item_*,
-- deal_travellers_save, flight_task_* and intake_checklist functions from
-- authenticated. Items, facts, travellers, tasks, outbox rows and audit rows
-- are kept (export, never delete).

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Trigger stages (private, data-driven)
-- ===========================================================================

create table authz.task_trigger_stages (
  category_id integer not null check (category_id >= 0),
  stage_id text primary key check (length(stage_id) between 1 and 50),
  label text not null check (length(label) between 1 and 120),
  created_at timestamptz not null default now()
);
comment on table authz.task_trigger_stages is
  'Bitrix Deal stages (deals.source_category_id, deals.source_stage_id) at which an accepted version may be confirmed and departmental tasks created (B1, DEC-15). No row for pipeline 1 (DEC-20). Edit rows to change the list; no code change needed.';
alter table authz.task_trigger_stages enable row level security;
revoke all on authz.task_trigger_stages from public, anon, authenticated, service_role;

insert into authz.task_trigger_stages (category_id, stage_id, label) values
  (0, 'UC_AD0SLH', 'Won - Payment Received');

-- True for a Bitrix Deal whose current (category, stage) is a trigger stage,
-- and for synthetic / CRM-native Deals (they have no Bitrix stage to check).
create function authz.deal_in_trigger_stage(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.deals d
    where d.id = p_deal
      and (d.source_system is distinct from 'bitrix'
           or exists (select 1 from authz.task_trigger_stages s
                      where s.stage_id = d.source_stage_id and s.category_id = d.source_category_id))
  )
$$;
revoke all on function authz.deal_in_trigger_stage(uuid) from public, anon, authenticated, service_role;

-- ===========================================================================
-- 2. Workflow settings (single row, both switches off)
-- ===========================================================================

create table public.workflow_settings (
  id boolean primary key default true check (id),
  intake_prompt_enabled boolean not null default false,
  service_items_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
comment on table public.workflow_settings is
  'Single row. B1 switches: service_items_enabled (package intake, one task per sold service) and intake_prompt_enabled (Sales count of confirmed Bitrix Deals without a booking). Changed through public.admin_set_workflow_setting (Super Admin, reason) or owner SQL; every change is audited by trigger (settings.workflow_changed).';
insert into public.workflow_settings (id) values (true);

create trigger workflow_settings_audit
  after insert or update or delete on public.workflow_settings
  for each row execute function authz.audit_settings_change(
    'settings.workflow_changed', 'intake_prompt_enabled', 'service_items_enabled');
create trigger workflow_settings_touch before update on public.workflow_settings
  for each row execute function authz.touch_settings_updated_at();
create trigger workflow_settings_no_truncate before truncate on public.workflow_settings
  for each statement execute function authz.refuse_settings_truncate();

create function authz.service_items_enabled() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.service_items_enabled from public.workflow_settings s where s.id), false)
$$;
revoke all on function authz.service_items_enabled() from public, anon, authenticated, service_role;

-- Super Admins may also read the workflow switch audit rows (company-less).
drop policy audit_settings_global_read on public.audit_events;
create policy audit_settings_global_read on public.audit_events
  for select to authenticated
  using (legal_entity_id is null and sensitivity = 'standard'
    and action in ('settings.booking_changed', 'settings.procurement_changed', 'settings.workflow_changed')
    and (select authz.can_admin_any('audit.read')));

-- ===========================================================================
-- 3. Tables: service items, facts, travellers, snapshots
-- ===========================================================================

create table public.service_items (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null,
  legal_entity_id uuid not null,
  branch_id uuid not null,
  item_no integer not null check (item_no between 1 and 20),
  service_type text not null check (service_type in ('hotel', 'transfer', 'activity', 'flight')),
  department text not null check (department in ('purchase', 'flight')),
  state text not null default 'planned' check (state in ('planned', 'active', 'cancelled')),
  -- Exact-retry key of service_item_add (null for backfilled and hotel-path items).
  request_id uuid,
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, branch_id, deal_id) references public.deals (legal_entity_id, branch_id, id),
  unique (deal_id, item_no),
  unique (legal_entity_id, id),
  unique (deal_id, request_id),
  check (department = case when service_type = 'flight' then 'flight' else 'purchase' end)
);
comment on table public.service_items is
  'One sold service on a Deal (identity row; never changes or disappears once active). Facts live per booking version in service_item_facts. Never carries selling price or margin.';

create table public.service_item_facts (
  id uuid primary key default gen_random_uuid(),
  service_item_id uuid not null,
  booking_version_id uuid not null,
  legal_entity_id uuid not null,
  facts jsonb not null check (jsonb_typeof(facts) = 'object'),
  purchase_budget_paise bigint not null default 0 check (purchase_budget_paise >= 0),
  facts_hash text not null check (facts_hash ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, service_item_id) references public.service_items (legal_entity_id, id),
  foreign key (legal_entity_id, booking_version_id) references public.booking_versions (legal_entity_id, id),
  unique (service_item_id, booking_version_id)
);
create index service_item_facts_version_idx on public.service_item_facts (booking_version_id);
comment on table public.service_item_facts is
  'Facts (typed JSON per service type) and Purchase budget of one service item inside one booking version. Immutable once the version is confirmed. Facts keys are an allowlist; never a selling value.';

create table public.deal_travellers (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null,
  legal_entity_id uuid not null,
  seq integer not null check (seq between 1 and 100),
  full_name text not null check (length(full_name) between 1 and 120),
  traveller_type text not null check (traveller_type in ('adult', 'child', 'infant')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  unique (deal_id, seq)
);
comment on table public.deal_travellers is
  'CRM-owned travellers of a Deal (names are personal data: readable by booking readers only, never by Purchase or Flight).';

create table public.booking_version_travellers (
  id uuid primary key default gen_random_uuid(),
  booking_version_id uuid not null,
  legal_entity_id uuid not null,
  seq integer not null check (seq between 1 and 100),
  full_name text not null check (length(full_name) between 1 and 120),
  traveller_type text not null check (traveller_type in ('adult', 'child', 'infant')),
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, booking_version_id) references public.booking_versions (legal_entity_id, id),
  unique (booking_version_id, seq)
);
comment on table public.booking_version_travellers is
  'Traveller snapshot frozen into a confirmed booking version. Immutable.';

-- ---------------------------------------------------------------------------
-- booking_versions: 'package' versions
-- ---------------------------------------------------------------------------

do $$
declare
  c record;
begin
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.booking_versions'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%service_type%'
  loop
    execute format('alter table public.booking_versions drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table public.booking_versions add constraint booking_versions_service_type_check
  check (service_type in ('hotel', 'package'));
comment on table public.booking_versions is
  'Accepted version of a Deal. service_type hotel = legacy single hotel booking in the columns; package = service items and travellers (B1). Draft is editable through commands; confirmed is immutable.';

-- ---------------------------------------------------------------------------
-- fulfilment_tasks: one task per service item
-- ---------------------------------------------------------------------------

alter table public.fulfilment_tasks
  add column service_item_id uuid,
  add column department text not null default 'purchase' check (department in ('purchase', 'flight'));

do $$
declare
  c record;
begin
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.fulfilment_tasks'::regclass
      and ((con.contype = 'c' and (pg_get_constraintdef(con.oid) like '%service_purpose%'
                                   or pg_get_constraintdef(con.oid) like '%task_key%'))
        or (con.contype = 'u' and pg_get_constraintdef(con.oid) = 'UNIQUE (booking_version_id, service_purpose)'))
  loop
    execute format('alter table public.fulfilment_tasks drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table public.fulfilment_tasks
  add constraint fulfilment_tasks_service_purpose_check
    check (service_purpose in ('hotel', 'transfer', 'activity', 'flight')),
  add constraint fulfilment_tasks_task_key_check
    check (task_key = 'booking:' || booking_version_id::text || ':' || service_purpose
        or task_key = 'item:' || service_item_id::text || ':' || service_purpose),
  add constraint fulfilment_tasks_department_matches_purpose
    check (department = case when service_purpose = 'flight' then 'flight' else 'purchase' end);
-- Legacy direct inserts (tests, fixtures) and the hotel confirm path name no
-- item: the trigger below links the Deal's hotel item before the row lands.
-- For every task created before this migration the backfill (section 4)
-- fills the column, then it becomes NOT NULL.

-- ---------------------------------------------------------------------------
-- outbox_events: payloads may name the item and service type
-- ---------------------------------------------------------------------------

do $$
declare
  c record;
begin
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.outbox_events'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%payload%'
  loop
    execute format('alter table public.outbox_events drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table public.outbox_events add constraint outbox_events_payload_check check (
  jsonb_typeof(payload) = 'object'
  and (payload - array['version_id', 'deal_id', 'task_id', 'version_no', 'service_purpose',
                       'service_item_id', 'service_type']) = '{}'::jsonb);

-- ===========================================================================
-- 4. Backfill (idempotent; before the guards and rehash triggers exist)
-- ===========================================================================

-- Hotel facts JSON of a version's columns (null columns omitted). Same keys as
-- HotelServiceFacts in contracts.ts.
create function authz.hotel_facts_of_version(p_version uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'hotelName', v.hotel_name,
    'city', v.city,
    'checkIn', to_char(v.check_in, 'YYYY-MM-DD'),
    'checkOut', to_char(v.check_out, 'YYYY-MM-DD'),
    'rooms', v.rooms,
    'adults', v.adults,
    'roomType', v.room_type,
    'mealPlan', v.meal_plan,
    'children', v.children,
    'inclusions', v.inclusions,
    'specialRequests', v.special_requests))
  from public.booking_versions v where v.id = p_version
$$;

create function authz.service_facts_hash(p_facts jsonb, p_budget bigint) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(p_facts::text || ':' || p_budget::text, 'UTF8')), 'hex')
$$;

-- The Deal's hotel item (item 1, department purchase), created when missing.
-- Used by the backfill, the legacy task trigger and the hotel confirm path.
create function authz.hotel_item_for_deal(p_deal uuid, p_created_by uuid, p_created_at timestamptz) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  select i.id into v_id from public.service_items i
  where i.deal_id = p_deal and i.service_type = 'hotel' order by i.item_no limit 1;
  if v_id is not null then
    return v_id;
  end if;
  insert into public.service_items (deal_id, legal_entity_id, branch_id, item_no, service_type, department, state,
    created_by, created_at, updated_at)
  select d.id, d.legal_entity_id, d.branch_id,
    coalesce((select max(i.item_no) from public.service_items i where i.deal_id = d.id), 0) + 1,
    'hotel', 'purchase',
    case when exists (select 1 from public.booking_versions v where v.deal_id = d.id and v.status = 'confirmed')
         then 'active' else 'planned' end,
    coalesce(p_created_by, (select auth.uid())), coalesce(p_created_at, now()), now()
  from public.deals d where d.id = p_deal
  returning id into v_id;
  return v_id;
end;
$$;

-- Facts row of a hotel version from its columns (insert or refresh).
create function authz.hotel_facts_sync(p_version uuid, p_item uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_facts jsonb;
  v_budget bigint;
begin
  select * into v_ver from public.booking_versions v where v.id = p_version;
  v_facts := authz.hotel_facts_of_version(v_ver.id);
  v_budget := coalesce(v_ver.purchase_budget_paise, 0);
  insert into public.service_item_facts as f (service_item_id, booking_version_id, legal_entity_id, facts,
    purchase_budget_paise, facts_hash, created_at, updated_at)
  values (p_item, v_ver.id, v_ver.legal_entity_id, v_facts, v_budget, authz.service_facts_hash(v_facts, v_budget),
    v_ver.created_at, now())
  on conflict (service_item_id, booking_version_id) do update
    set facts = excluded.facts, purchase_budget_paise = excluded.purchase_budget_paise,
        facts_hash = excluded.facts_hash, updated_at = now()
    where (f.facts, f.purchase_budget_paise) is distinct from (excluded.facts, excluded.purchase_budget_paise);
end;
$$;

revoke all on function authz.hotel_facts_of_version(uuid), authz.service_facts_hash(jsonb, bigint),
  authz.hotel_item_for_deal(uuid, uuid, timestamptz), authz.hotel_facts_sync(uuid, uuid)
from public, anon, authenticated, service_role;

do $$
declare
  v_deal record;
  v_item uuid;
  v_ver record;
  v_deals_with_versions integer;
  v_items integer;
  v_versions integer;
  v_facts integer;
  v_unlinked integer;
begin
  for v_deal in
    select v.deal_id, min(v.created_at) as first_at,
      (array_agg(v.created_by order by v.created_at, v.version_no))[1] as first_by
    from public.booking_versions v
    group by v.deal_id
  loop
    v_item := authz.hotel_item_for_deal(v_deal.deal_id, v_deal.first_by, v_deal.first_at);
    for v_ver in select v.id from public.booking_versions v where v.deal_id = v_deal.deal_id loop
      perform authz.hotel_facts_sync(v_ver.id, v_item);
    end loop;
    update public.fulfilment_tasks t set service_item_id = v_item
    where t.deal_id = v_deal.deal_id and t.service_item_id is null;
  end loop;

  select count(distinct v.deal_id), count(*) into v_deals_with_versions, v_versions from public.booking_versions v;
  select count(*) into v_items from public.service_items;
  select count(*) into v_facts from public.service_item_facts;
  select count(*) into v_unlinked from public.fulfilment_tasks t where t.service_item_id is null;
  if v_items <> v_deals_with_versions then
    raise exception 'B1 backfill: % service items for % deals with booking versions', v_items, v_deals_with_versions
      using errcode = '55000';
  end if;
  if v_facts <> v_versions then
    raise exception 'B1 backfill: % facts rows for % booking versions', v_facts, v_versions using errcode = '55000';
  end if;
  if v_unlinked <> 0 then
    raise exception 'B1 backfill: % fulfilment tasks without a service item', v_unlinked using errcode = '55000';
  end if;
end;
$$;

alter table public.fulfilment_tasks alter column service_item_id set not null;
alter table public.fulfilment_tasks
  add constraint fulfilment_tasks_service_item_fk
    foreign key (legal_entity_id, service_item_id) references public.service_items (legal_entity_id, id),
  add constraint fulfilment_tasks_version_item_key unique (booking_version_id, service_item_id),
  add constraint fulfilment_tasks_item_purpose_key unique (service_item_id, service_purpose);
create index fulfilment_tasks_department_status_idx on public.fulfilment_tasks (department, legal_entity_id, status);

-- ===========================================================================
-- 5. Guards, hashes and rehash triggers
-- ===========================================================================

-- Legacy task rows (task_key 'booking:...') without an item get the Deal's
-- hotel item; every row must name the item it is for.
create function authz.fulfilment_tasks_link_item() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.service_item_id is null and new.task_key like 'booking:%' then
    new.service_item_id := authz.hotel_item_for_deal(new.deal_id, new.created_by, null);
  end if;
  if new.service_item_id is null then
    raise exception 'fulfilment task needs a service item' using errcode = '22023';
  end if;
  new.department := case when new.service_purpose = 'flight' then 'flight' else 'purchase' end;
  return new;
end;
$$;
create trigger fulfilment_tasks_0_link_item
  before insert on public.fulfilment_tasks
  for each row execute function authz.fulfilment_tasks_link_item();

-- Replaces 20261004000100: service_item_id and department are identity too.
create or replace function authz.fulfilment_tasks_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'fulfilment tasks cannot be deleted' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.deal_id is distinct from old.deal_id
     or new.legal_entity_id is distinct from old.legal_entity_id or new.branch_id is distinct from old.branch_id
     or new.booking_version_id is distinct from old.booking_version_id
     or new.service_purpose is distinct from old.service_purpose or new.task_key is distinct from old.task_key
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at
     -- B1
     or new.service_item_id is distinct from old.service_item_id or new.department is distinct from old.department then
    raise exception 'fulfilment task identity columns are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- service_items: identity immutable; planned -> active only; a planned item is
-- deleted only by service_item_remove (it names the row in a transaction setting).
create function authz.service_items_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.state <> 'planned'
       or coalesce(current_setting('tripnavigate.service_item_remove', true), '') <> old.id::text then
      raise exception 'service items are removed only through service_item_remove while planned' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.id is distinct from old.id or new.deal_id is distinct from old.deal_id
     or new.legal_entity_id is distinct from old.legal_entity_id or new.branch_id is distinct from old.branch_id
     or new.item_no is distinct from old.item_no or new.service_type is distinct from old.service_type
     or new.department is distinct from old.department or new.request_id is distinct from old.request_id
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'service item identity columns are immutable' using errcode = '42501';
  end if;
  if new.state is distinct from old.state and not (old.state = 'planned' and new.state = 'active') then
    raise exception 'service item state cannot move this way' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger service_items_a_guard
  before update or delete on public.service_items
  for each row execute function authz.service_items_guard();

-- service_item_facts: refused once the version is confirmed; identity immutable;
-- facts_hash always recomputed.
create function authz.service_item_facts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.booking_versions v
    where v.status = 'confirmed'
      and v.id in (case when tg_op = 'INSERT' then null else old.booking_version_id end,
                   case when tg_op = 'DELETE' then null else new.booking_version_id end)
  ) then
    raise exception 'facts of a confirmed booking version are immutable' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE' and (
       new.id is distinct from old.id or new.service_item_id is distinct from old.service_item_id
       or new.booking_version_id is distinct from old.booking_version_id
       or new.legal_entity_id is distinct from old.legal_entity_id or new.created_at is distinct from old.created_at) then
    raise exception 'service item facts identity columns are immutable' using errcode = '42501';
  end if;
  new.facts_hash := authz.service_facts_hash(new.facts, new.purchase_budget_paise);
  return new;
end;
$$;
create trigger service_item_facts_a_guard
  before insert or update or delete on public.service_item_facts
  for each row execute function authz.service_item_facts_guard();

create function authz.booking_version_travellers_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'booking version traveller snapshots are immutable' using errcode = '42501';
end;
$$;
create trigger booking_version_travellers_a_guard
  before update or delete on public.booking_version_travellers
  for each row execute function authz.booking_version_travellers_guard();

create function authz.deal_travellers_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;
create trigger deal_travellers_a_touch before update on public.deal_travellers
  for each row execute function authz.deal_travellers_touch();

-- Package hash: items (item_no, type, facts, budget) ordered by item_no,
-- travellers (seq, name, type) ordered by seq, the commercial revision and the
-- stored evidence set. Hotel versions keep authz.booking_hash unchanged.
create function authz.booking_package_hash(p_version uuid, p_deal uuid, p_commercial_revision uuid) returns text
language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_array(i.item_no, i.service_type, f.facts, f.purchase_budget_paise) order by i.item_no)
      from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
      where f.booking_version_id = p_version), '[]'::jsonb),
    'travellers', coalesce((
      select jsonb_agg(jsonb_build_array(t.seq, t.full_name, t.traveller_type) order by t.seq)
      from public.deal_travellers t where t.deal_id = p_deal), '[]'::jsonb),
    'commercial_revision', p_commercial_revision,
    'stored_evidence', authz.booking_stored_evidence(p_version)
  )::text, 'UTF8')), 'hex')
$$;

-- Replaces 20261004000100: package versions hash items and travellers.
create or replace function authz.booking_versions_hash() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.service_type = 'package' then
    new.content_hash := authz.booking_package_hash(new.id, new.deal_id, new.commercial_revision);
  else
    new.content_hash := authz.booking_hash(new.hotel_name, new.city, new.check_in, new.check_out, new.rooms,
      new.room_type, new.meal_plan, new.adults, new.children, new.inclusions, new.special_requests,
      new.purchase_budget_paise, new.commercial_revision, authz.booking_stored_evidence(new.id));
  end if;
  return new;
end;
$$;

create or replace function authz.booking_content_hash(p_version uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when v.service_type = 'package'
    then authz.booking_package_hash(v.id, v.deal_id, v.commercial_revision)
    else authz.booking_hash(v.hotel_name, v.city, v.check_in, v.check_out, v.rooms, v.room_type,
      v.meal_plan, v.adults, v.children, v.inclusions, v.special_requests, v.purchase_budget_paise,
      v.commercial_revision, authz.booking_stored_evidence(v.id)) end
  from public.booking_versions v
  where v.id = p_version
$$;

-- Any facts change refreshes the draft version's hash (hotel versions recompute
-- the same value: their hash ignores the facts rows).
create function authz.service_item_facts_rehash() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.booking_versions v set content_hash = v.content_hash
  where v.id = case when tg_op = 'DELETE' then old.booking_version_id else new.booking_version_id end
    and v.status = 'draft' and v.service_type = 'package';
  return null;
end;
$$;
create trigger service_item_facts_b_rehash
  after insert or update or delete on public.service_item_facts
  for each row execute function authz.service_item_facts_rehash();

create function authz.deal_travellers_rehash() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.booking_versions v set content_hash = v.content_hash
  where v.deal_id = case when tg_op = 'DELETE' then old.deal_id else new.deal_id end
    and v.status = 'draft' and v.service_type = 'package';
  return null;
end;
$$;
create trigger deal_travellers_b_rehash
  after insert or update or delete on public.deal_travellers
  for each row execute function authz.deal_travellers_rehash();

-- ===========================================================================
-- 6. Permission catalogue
-- ===========================================================================

insert into public.permissions (code, description, is_grantable) values
  ('deal.intake_edit', 'Open the intake screen; add, save and remove service items; save travellers (booking editors).', false),
  ('flight_task.read', 'See Flight tasks (flight facts and the item''s budget only).', false),
  ('flight_task.claim', 'Take a Flight task.', false);

insert into public.role_permissions (role_code, permission_code, scope, policy_status, note) values
  ('sales', 'deal.intake_edit', 'own', 'confirmed', 'B1: owner or active Sales assignee (reuses can_edit_booking_draft)'),
  ('manager', 'deal.intake_edit', 'own', 'confirmed', 'B1: Sales Manager of the deal''s branch'),
  ('flight', 'flight_task.read', 'entity', 'proposed', 'B1: Flight sees every flight task in the entity (mirrors Purchase)'),
  ('flight', 'flight_task.claim', 'own', 'proposed', 'B1: Flight takes a flight task (mirrors purchase_task.claim)');

-- ===========================================================================
-- 7. Authorization helpers
-- ===========================================================================

-- Replaces 20261004000100: Purchase holders see only department purchase
-- tasks; deal readers who hold neither the purchase nor the flight role see
-- every task of their Deals (review E1: a Flight person who took a flight
-- task becomes a Deal assignee and must not read the Purchase tasks' budgets).
create or replace function authz.can_read_purchase_task(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task
      and (
        (t.department = 'purchase' and authz.holds_active_role('purchase', t.legal_entity_id))
        or (authz.can_read_deal(t.deal_id)
            and not authz.holds_role('purchase', t.legal_entity_id)
            and not authz.holds_role('flight', t.legal_entity_id))
      )
  )
$$;

create or replace function authz.can_claim_purchase_task(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task and t.department = 'purchase' and authz.holds_active_role('purchase', t.legal_entity_id)
  )
$$;

create function authz.can_read_flight_task(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task and t.department = 'flight' and authz.holds_active_role('flight', t.legal_entity_id)
  )
$$;

-- Service rows (items, facts, travellers, snapshots) through the Data API:
-- booking readers who hold neither the purchase nor the flight role.
create function authz.can_read_service_rows(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.can_read_booking(p_deal) and exists (
    select 1 from public.deals d
    where d.id = p_deal and not authz.holds_role('flight', d.legal_entity_id)
  )
$$;
revoke all on function authz.can_read_service_rows(uuid) from public, anon, authenticated, service_role;
grant execute on function authz.can_read_service_rows(uuid) to authenticated;

create function authz.can_claim_flight_task(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.can_read_flight_task(p_task)
$$;

-- Replaces 20261005000200: the item's budget on the task's version, falling
-- back to the version column for versions without a facts row.
create or replace function authz.task_budget(p_task uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(f.purchase_budget_paise, v.purchase_budget_paise)
  from public.fulfilment_tasks t
  join public.booking_versions v on v.id = t.booking_version_id
  left join public.service_item_facts f on f.service_item_id = t.service_item_id and f.booking_version_id = v.id
  where t.id = p_task
$$;

revoke all on function authz.can_read_flight_task(uuid), authz.can_claim_flight_task(uuid)
from public, anon, authenticated, service_role;
grant execute on function authz.can_read_flight_task(uuid), authz.can_claim_flight_task(uuid) to authenticated;

-- ===========================================================================
-- 8. Facts validation (contract section 8; no table access)
-- ===========================================================================

-- Helpers return true when the value is acceptable.
create function authz.sf_text_ok(p_value jsonb, p_max integer, p_required boolean) returns boolean
language sql immutable set search_path = '' as $$
  select case
    when p_value is null or jsonb_typeof(p_value) = 'null' then not p_required
    when jsonb_typeof(p_value) <> 'string' then false
    else length(btrim(p_value #>> '{}', E' \t\r\n')) between 1 and p_max
         and (p_value #>> '{}') !~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]'
  end
$$;

create function authz.sf_int_ok(p_value jsonb, p_min integer, p_max integer, p_required boolean) returns boolean
language sql immutable set search_path = '' as $$
  select case
    when p_value is null or jsonb_typeof(p_value) = 'null' then not p_required
    when jsonb_typeof(p_value) <> 'number' then false
    when (p_value #>> '{}') !~ '^-?[0-9]{1,9}$' then false
    else (p_value #>> '{}')::integer between p_min and p_max
  end
$$;

-- A valid ISO date in 2000-01-01..2100-12-31, else null.
create function authz.sf_date(p_value jsonb) returns date
language plpgsql stable set search_path = '' as $$
declare
  v_text text;
  v_date date;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string' then
    return null;
  end if;
  v_text := p_value #>> '{}';
  if v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return null;
  end if;
  begin
    v_date := v_text::date;
  exception when data_exception then
    return null;
  end;
  if to_char(v_date, 'YYYY-MM-DD') <> v_text or v_date not between date '2000-01-01' and date '2100-12-31' then
    return null;
  end if;
  return v_date;
end;
$$;

create function authz.sf_time_ok(p_value jsonb, p_required boolean) returns boolean
language sql immutable set search_path = '' as $$
  select case
    when p_value is null or jsonb_typeof(p_value) = 'null' then not p_required
    when jsonb_typeof(p_value) <> 'string' then false
    else (p_value #>> '{}') ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
  end
$$;

-- Integer value of a JSON number within 9 digits, else null.
create function authz.sf_int_value(p_value jsonb) returns integer
language sql immutable set search_path = '' as $$
  select case when p_value is not null and jsonb_typeof(p_value) = 'number' and (p_value #>> '{}') ~ '^-?[0-9]{1,9}$'
    then (p_value #>> '{}')::integer end
$$;

-- Invalid field keys of a facts object for a service type (empty = valid).
-- Unknown keys are invalid (a selling value cannot hide under a new key).
create function authz.validate_service_facts(p_type text, p_facts jsonb) returns text[]
language plpgsql stable set search_path = '' as $$
declare
  v_bad text[] := '{}'::text[];
  v_allowed text[];
  v_key text;
  v_seg jsonb;
  v_prev date;
  v_date date;
  v_n integer := 0;
  v_seg_ok boolean := true;
begin
  if p_type is null or p_type not in ('hotel', 'transfer', 'activity', 'flight') then
    return array['type'];
  end if;
  if p_facts is null or jsonb_typeof(p_facts) <> 'object' then
    return array['facts'];
  end if;
  v_allowed := case p_type
    when 'hotel' then array['hotelName', 'city', 'checkIn', 'checkOut', 'rooms', 'adults', 'roomType', 'mealPlan',
                            'children', 'inclusions', 'specialRequests']
    when 'transfer' then array['route', 'date', 'vehicleType', 'passengers', 'pickupTime', 'notes']
    when 'activity' then array['name', 'city', 'date', 'participants', 'time', 'notes']
    else array['segments', 'passengers', 'preferredTime', 'cabin', 'notes'] end;
  for v_key in select k from jsonb_object_keys(p_facts) k loop
    if v_key <> all (v_allowed) then
      v_bad := v_bad || v_key;
    end if;
  end loop;

  if p_type = 'hotel' then
    if not authz.sf_text_ok(p_facts -> 'hotelName', 200, true) then v_bad := v_bad || 'hotelName'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'city', 120, true) then v_bad := v_bad || 'city'::text; end if;
    if authz.sf_date(p_facts -> 'checkIn') is null then v_bad := v_bad || 'checkIn'::text; end if;
    if authz.sf_date(p_facts -> 'checkOut') is null
       or (authz.sf_date(p_facts -> 'checkIn') is not null
           and authz.sf_date(p_facts -> 'checkOut') <= authz.sf_date(p_facts -> 'checkIn')) then
      v_bad := v_bad || 'checkOut'::text;
    end if;
    if not authz.sf_int_ok(p_facts -> 'rooms', 1, 50, true) then v_bad := v_bad || 'rooms'::text; end if;
    if not authz.sf_int_ok(p_facts -> 'adults', 1, 100, true) then v_bad := v_bad || 'adults'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'roomType', 120, false) then v_bad := v_bad || 'roomType'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'mealPlan', 60, false) then v_bad := v_bad || 'mealPlan'::text; end if;
    if not authz.sf_int_ok(p_facts -> 'children', 0, 100, false) then v_bad := v_bad || 'children'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'inclusions', 2000, false) then v_bad := v_bad || 'inclusions'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'specialRequests', 2000, false) then v_bad := v_bad || 'specialRequests'::text; end if;
  elsif p_type = 'transfer' then
    if not authz.sf_text_ok(p_facts -> 'route', 200, true) then v_bad := v_bad || 'route'::text; end if;
    if authz.sf_date(p_facts -> 'date') is null then v_bad := v_bad || 'date'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'vehicleType', 60, true) then v_bad := v_bad || 'vehicleType'::text; end if;
    if not authz.sf_int_ok(p_facts -> 'passengers', 1, 100, true) then v_bad := v_bad || 'passengers'::text; end if;
    if not authz.sf_time_ok(p_facts -> 'pickupTime', false) then v_bad := v_bad || 'pickupTime'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'notes', 2000, false) then v_bad := v_bad || 'notes'::text; end if;
  elsif p_type = 'activity' then
    if not authz.sf_text_ok(p_facts -> 'name', 200, true) then v_bad := v_bad || 'name'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'city', 120, true) then v_bad := v_bad || 'city'::text; end if;
    if authz.sf_date(p_facts -> 'date') is null then v_bad := v_bad || 'date'::text; end if;
    if not authz.sf_int_ok(p_facts -> 'participants', 1, 100, true) then v_bad := v_bad || 'participants'::text; end if;
    if not authz.sf_time_ok(p_facts -> 'time', false) then v_bad := v_bad || 'time'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'notes', 2000, false) then v_bad := v_bad || 'notes'::text; end if;
  else
    if p_facts -> 'segments' is null or jsonb_typeof(p_facts -> 'segments') <> 'array'
       or jsonb_array_length(p_facts -> 'segments') not between 1 and 8 then
      v_seg_ok := false;
    else
      for v_seg in select s from jsonb_array_elements(p_facts -> 'segments') s loop
        v_n := v_n + 1;
        if jsonb_typeof(v_seg) <> 'object'
           or exists (select 1 from jsonb_object_keys(v_seg) k where k not in ('from', 'to', 'date'))
           or jsonb_typeof(v_seg -> 'from') <> 'string' or (v_seg #>> '{from}') !~ '^[A-Z]{3}$'
           or jsonb_typeof(v_seg -> 'to') <> 'string' or (v_seg #>> '{to}') !~ '^[A-Z]{3}$' then
          v_seg_ok := false;
        end if;
        v_date := authz.sf_date(v_seg -> 'date');
        if v_date is null or (v_prev is not null and v_date < v_prev) then
          v_seg_ok := false;
        end if;
        v_prev := coalesce(v_date, v_prev);
      end loop;
    end if;
    if not v_seg_ok then v_bad := v_bad || 'segments'::text; end if;
    if not authz.sf_int_ok(p_facts -> 'passengers', 1, 100, true) then v_bad := v_bad || 'passengers'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'preferredTime', 60, false) then v_bad := v_bad || 'preferredTime'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'cabin', 40, false) then v_bad := v_bad || 'cabin'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'notes', 2000, false) then v_bad := v_bad || 'notes'::text; end if;
  end if;
  return v_bad;
end;
$$;

-- Trimmed copy of the facts: strings trimmed, '' and JSON null dropped.
create function authz.normalize_service_facts(p_facts jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select case
    when p_facts is null then '{}'::jsonb
    when jsonb_typeof(p_facts) <> 'object' then p_facts
    else coalesce((
      select jsonb_object_agg(k, case when jsonb_typeof(v) = 'string' then to_jsonb(btrim(v #>> '{}', E' \t\r\n')) else v end)
      from jsonb_each(p_facts) as e(k, v)
      where jsonb_typeof(v) <> 'null'
        and not (jsonb_typeof(v) = 'string' and btrim(v #>> '{}', E' \t\r\n') = '')
    ), '{}'::jsonb) end
$$;

-- Short title for lists: hotel name and city, route, activity name, flight route.
create function authz.service_item_title(p_type text, p_facts jsonb) returns text
language sql immutable set search_path = '' as $$
  select case p_type
    when 'hotel' then concat_ws(' · ', nullif(p_facts ->> 'hotelName', ''), nullif(p_facts ->> 'city', ''))
    when 'transfer' then nullif(p_facts ->> 'route', '')
    when 'activity' then concat_ws(' · ', nullif(p_facts ->> 'name', ''), nullif(p_facts ->> 'city', ''))
    else (select string_agg(concat_ws(' to ', s ->> 'from', s ->> 'to'), ', ')
          from jsonb_array_elements(case when jsonb_typeof(p_facts -> 'segments') = 'array'
                                         then p_facts -> 'segments' else '[]'::jsonb end) s)
  end
$$;

-- Travellers an item needs: adults + children, passengers or participants.
create function authz.service_item_travellers_needed(p_type text, p_facts jsonb) returns integer
language sql stable set search_path = '' as $$
  select case p_type
    when 'hotel' then coalesce(authz.sf_int_value(p_facts -> 'adults'), 0) + coalesce(authz.sf_int_value(p_facts -> 'children'), 0)
    when 'transfer' then coalesce(authz.sf_int_value(p_facts -> 'passengers'), 0)
    when 'activity' then coalesce(authz.sf_int_value(p_facts -> 'participants'), 0)
    else coalesce(authz.sf_int_value(p_facts -> 'passengers'), 0)
  end
$$;

revoke all on function authz.sf_text_ok(jsonb, integer, boolean), authz.sf_int_ok(jsonb, integer, integer, boolean),
  authz.sf_date(jsonb), authz.sf_time_ok(jsonb, boolean), authz.sf_int_value(jsonb), authz.validate_service_facts(text, jsonb),
  authz.normalize_service_facts(jsonb), authz.service_item_title(text, jsonb)
from public, anon, authenticated, service_role;

-- ===========================================================================
-- 9. Row level security and grants for the new tables
-- ===========================================================================

alter table public.workflow_settings enable row level security;
alter table public.service_items enable row level security;
alter table public.service_item_facts enable row level security;
alter table public.deal_travellers enable row level security;
alter table public.booking_version_travellers enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'workflow_settings', 'service_items', 'service_item_facts', 'deal_travellers', 'booking_version_travellers'
  ] loop
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
  end loop;
end;
$$;

create policy staff_read on public.workflow_settings
  for select to authenticated using ((select authz.is_active_staff()));
create policy scoped_read on public.service_items
  for select to authenticated using (authz.can_read_service_rows(deal_id));
create policy scoped_read on public.service_item_facts
  for select to authenticated using (exists (
    select 1 from public.service_items i where i.id = service_item_id and authz.can_read_service_rows(i.deal_id)));
create policy scoped_read on public.deal_travellers
  for select to authenticated using (authz.can_read_service_rows(deal_id));
create policy scoped_read on public.booking_version_travellers
  for select to authenticated using (exists (
    select 1 from public.booking_versions v where v.id = booking_version_id and authz.can_read_service_rows(v.deal_id)));
-- Flight role holders read their department's task rows directly (lists use the functions).
create policy flight_read on public.fulfilment_tasks
  for select to authenticated using (authz.can_read_flight_task(id));

revoke all on public.workflow_settings, public.service_items, public.service_item_facts,
  public.deal_travellers, public.booking_version_travellers
from public, anon, authenticated, service_role;
grant select on public.workflow_settings, public.service_items, public.service_item_facts,
  public.deal_travellers, public.booking_version_travellers
to authenticated, service_role;
-- fulfilment_tasks keeps its column grant (20261005000100) plus the two B1 columns.
grant select (service_item_id, department) on public.fulfilment_tasks to authenticated;

-- ===========================================================================
-- 10. Readiness for package versions (replaces authz.booking_issues)
-- ===========================================================================

-- Item numbers whose facts fail validation on this version.
create function authz.service_item_invalid_nos(p_version uuid) returns integer[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(i.item_no order by i.item_no), '{}'::integer[])
  from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
  where f.booking_version_id = p_version and cardinality(authz.validate_service_facts(i.service_type, f.facts)) > 0
$$;

create function authz.version_travellers_needed(p_version uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select coalesce(max(authz.service_item_travellers_needed(i.service_type, f.facts)), 0)
  from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
  where f.booking_version_id = p_version
$$;

-- Readiness issue codes in contract order. Hotel versions: unchanged list
-- (20261004000100). Package versions: B1 issues plus the shared ones.
create or replace function authz.booking_issues(p_version uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select case when v.service_type = 'package' then array_remove(array[
    case when not authz.deal_in_trigger_stage(d.id) then 'stage_not_confirmed' end,
    case when not exists (select 1 from public.service_item_facts f where f.booking_version_id = v.id) then 'no_services' end,
    case when cardinality(authz.service_item_invalid_nos(v.id)) > 0 then 'service_facts_invalid' end,
    case when authz.version_travellers_needed(v.id) > 0
          and not exists (select 1 from public.deal_travellers t where t.deal_id = d.id) then 'traveller_missing' end,
    case when exists (select 1 from public.deal_travellers t where t.deal_id = d.id)
          and (select count(*) from public.deal_travellers t where t.deal_id = d.id) < authz.version_travellers_needed(v.id)
          then 'traveller_count_mismatch' end,
    case when not exists (select 1 from public.booking_version_commercials c where c.version_id = v.id)
      then 'missing_selling_total' end,
    -- Package versions need the customer's acceptance message itself (contract section 5.1 and 9; review E5).
    case when not exists (select 1 from public.booking_evidence e
                          where e.version_id = v.id and e.kind = 'acceptance_message' and e.status = 'stored')
      then 'missing_acceptance_proof' end,
    case when exists (select 1 from public.booking_evidence e where e.version_id = v.id and e.status = 'pending_upload')
      then 'evidence_upload_incomplete' end,
    case when not d.is_synthetic
      and (d.last_verified_at is null or d.last_verified_at < now() - interval '24 hours')
      then 'source_not_recently_verified' end,
    case when authz.booking_gate_issue(d.id) = 'booking_disabled' then 'booking_disabled' end,
    case when authz.booking_gate_issue(d.id) = 'environment_unset' then 'environment_unset' end
  ], null)
  else array_remove(array[
    case when v.hotel_name is null then 'missing_hotel_name' end,
    case when v.city is null then 'missing_city' end,
    case when v.check_in is null or v.check_out is null then 'missing_dates' end,
    case when v.check_out <= v.check_in then 'check_out_not_after_check_in' end,
    case when v.rooms is null then 'missing_rooms' end,
    case when v.adults is null then 'missing_travellers' end,
    case when v.purchase_budget_paise is null then 'missing_purchase_budget' end,
    case when not exists (select 1 from public.booking_version_commercials c where c.version_id = v.id)
      then 'missing_selling_total' end,
    case when not exists (select 1 from public.booking_evidence e where e.version_id = v.id and e.status = 'stored')
      then 'missing_acceptance_proof' end,
    case when exists (select 1 from public.booking_evidence e where e.version_id = v.id and e.status = 'pending_upload')
      then 'evidence_upload_incomplete' end,
    -- STALE_SYNC_HOURS_PROPOSED = 24
    case when not d.is_synthetic
      and (d.last_verified_at is null or d.last_verified_at < now() - interval '24 hours')
      then 'source_not_recently_verified' end,
    case when authz.booking_gate_issue(d.id) = 'booking_disabled' then 'booking_disabled' end,
    case when authz.booking_gate_issue(d.id) = 'environment_unset' then 'environment_unset' end
  ], null) end
  from public.booking_versions v
  join public.deals d on d.id = v.deal_id
  where v.id = p_version
$$;

revoke all on function authz.service_item_invalid_nos(uuid), authz.version_travellers_needed(uuid),
  authz.service_item_travellers_needed(text, jsonb)
from public, anon, authenticated, service_role;

-- ===========================================================================
-- 11. JSON shapes: items, progress, Deal services
-- ===========================================================================

-- The version a Deal page shows: the confirmed one, else the newest draft.
create function authz.deal_current_version(p_deal uuid) returns public.booking_versions
language sql stable security definer set search_path = '' as $$
  select v.* from public.booking_versions v
  where v.deal_id = p_deal
  order by (v.status = 'confirmed') desc, v.version_no desc
  limit 1
$$;

-- One ServiceItemView. Facts from the given version when the item has a row
-- there, else the item's newest facts row. Budget only when p_with_budget.
create function authz.service_item_json(p_item uuid, p_version uuid, p_with_budget boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  with f as (
    select f.* from public.service_item_facts f
    where f.service_item_id = p_item
    order by (f.booking_version_id = p_version) desc, f.created_at desc, f.id desc
    limit 1
  ), t as (
    select t.*, p.display_name as assignee_name
    from public.fulfilment_tasks t
    left join public.staff_profiles p on p.user_id = t.assignee_user_id
    where t.service_item_id = p_item
    order by t.created_at desc
    limit 1
  )
  select jsonb_build_object(
    'itemId', i.id,
    'itemNo', i.item_no,
    'serviceType', i.service_type,
    'department', i.department,
    'state', i.state,
    'title', coalesce(nullif(authz.service_item_title(i.service_type, f.facts), ''),
                      initcap(i.service_type) || ' ' || i.item_no::text),
    'facts', jsonb_build_object('type', i.service_type, 'facts', coalesce(f.facts, '{}'::jsonb)),
    'factsHash', coalesce(f.facts_hash, repeat('0', 64)),
    'task', case when t.id is null then null else jsonb_build_object(
      'taskId', t.id,
      'status', t.status,
      'assigneeName', t.assignee_name,
      'assignedToYou', t.assignee_user_id is not distinct from (select auth.uid()),
      'supplierConfirmedAt', t.supplier_confirmed_at) end,
    'nextStep', case
      when t.id is null then 'confirm_version'
      when t.status = 'not_started' then 'take_task'
      when t.status = 'in_progress' then 'supplier_confirmation'
      else 'done' end)
  || case when p_with_budget then jsonb_build_object('purchaseBudgetPaise', coalesce(f.purchase_budget_paise, 0)::text)
          else '{}'::jsonb end
  from public.service_items i
  left join f on true
  left join t on true
  where i.id = p_item
$$;

-- DealProgress over the Deal's items of the given departments (null = all).
create function authz.deal_progress_json(p_deal uuid, p_departments text[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  with items as (
    select i.id, i.state, t.status
    from public.service_items i
    left join public.fulfilment_tasks t on t.service_item_id = i.id
    where i.deal_id = p_deal and i.state <> 'cancelled'
      and (p_departments is null or i.department = any (p_departments))
  ), counts as (
    select count(*) as total,
      count(*) filter (where status is null) as planned,
      count(*) filter (where status = 'not_started') as not_started,
      count(*) filter (where status = 'in_progress') as in_progress,
      count(*) filter (where status = 'supplier_confirmed') as supplier_confirmed
    from items
  )
  select jsonb_build_object(
    'total', c.total,
    'byState', jsonb_build_object('planned', c.planned, 'notStarted', c.not_started,
      'inProgress', c.in_progress, 'supplierConfirmed', c.supplier_confirmed),
    'fulfilled', c.total > 0 and c.supplier_confirmed = c.total,
    'staleCount', 0,
    'needs', (select coalesce(jsonb_agg(n.step order by n.ord), '[]'::jsonb) from (values
      ('confirm_version', 1), ('take_task', 2), ('supplier_confirmation', 3)) as n(step, ord)
      where (n.step = 'confirm_version' and c.planned > 0)
         or (n.step = 'take_task' and c.not_started > 0)
         or (n.step = 'supplier_confirmation' and c.in_progress > 0)))
  from counts c
$$;

-- Departments the caller may see on a Deal: null = every item with budgets
-- and travellers (booking readers: Sales, Accounts, Manager); Purchase and
-- Flight role holders get their own department(s) only, even when a task
-- assignment makes them a Deal reader (traveller names and other budgets
-- stay out, contract section 6); empty = nothing.
create function authz.deal_services_scope(p_deal uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select case
    when authz.holds_role('purchase', d.legal_entity_id) or authz.holds_role('flight', d.legal_entity_id) then
      array_remove(array[
        case when authz.holds_active_role('purchase', d.legal_entity_id) then 'purchase' end,
        case when authz.holds_active_role('flight', d.legal_entity_id) then 'flight' end], null)
    when authz.can_read_booking(p_deal) then null
    else '{}'::text[] end
  from public.deals d where d.id = p_deal
$$;

-- DealServicesView (null when the Deal is not visible to the caller).
create function authz.deal_services_json(p_deal uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_scope text[];
  v_ver public.booking_versions;
  v_items jsonb;
  v_full boolean;
begin
  if p_deal is null or not authz.session_ok() then
    return null;
  end if;
  v_scope := authz.deal_services_scope(p_deal);
  if v_scope is not null and cardinality(v_scope) = 0 then
    return null;
  end if;
  v_full := v_scope is null;
  v_ver := authz.deal_current_version(p_deal);
  select coalesce(jsonb_agg(authz.service_item_json(i.id, v_ver.id, v_full or i.department = any (v_scope)) order by i.item_no), '[]'::jsonb)
  into v_items
  from public.service_items i
  where i.deal_id = p_deal and (v_full or i.department = any (v_scope));
  return jsonb_build_object(
    'dealId', p_deal,
    'version', case when v_ver.id is null then null else jsonb_build_object(
      'versionId', v_ver.id, 'versionNo', v_ver.version_no, 'status', v_ver.status, 'rowVersion', v_ver.row_version,
      'contentHash', v_ver.content_hash, 'serviceType', v_ver.service_type) end,
    'items', v_items,
    'progress', authz.deal_progress_json(p_deal, v_scope),
    'canEdit', v_full and coalesce(v_ver.status, 'draft') = 'draft' and authz.can_edit_booking_draft(p_deal),
    'canConfirm', v_full and v_ver.status = 'draft' and authz.can_confirm_booking(p_deal))
  || case when v_full then jsonb_build_object('travellers', coalesce((
       select jsonb_agg(jsonb_build_object('fullName', t.full_name, 'type', t.traveller_type, 'seq', t.seq) order by t.seq)
       from public.deal_travellers t where t.deal_id = p_deal), '[]'::jsonb))
     else '{}'::jsonb end;
end;
$$;

revoke all on function authz.deal_current_version(uuid), authz.service_item_json(uuid, uuid, boolean),
  authz.deal_progress_json(uuid, text[]), authz.deal_services_scope(uuid), authz.deal_services_json(uuid)
from public, anon, authenticated, service_role;

-- ===========================================================================
-- 12. Purchase task DTO (replaces 20261005000100)
-- ===========================================================================

-- Adds serviceType, itemTitle, facts ({type, facts}) and department. Hotel
-- fields come from the item's facts (fallback: the version columns) and are
-- null / 0 for other service types. Still NEVER the selling total, margin,
-- evidence, supplier or cost.
create or replace function authz.purchase_task_json(p_task uuid, p_detail boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  with x as (
    select t.*, i.service_type, i.item_no,
      case when i.service_type = 'hotel'
        then coalesce(f.facts, authz.hotel_facts_of_version(v.id)) else coalesce(f.facts, '{}'::jsonb) end as facts
    from public.fulfilment_tasks t
    join public.service_items i on i.id = t.service_item_id
    join public.booking_versions v on v.id = t.booking_version_id
    left join public.service_item_facts f on f.service_item_id = t.service_item_id and f.booking_version_id = v.id
    where t.id = p_task
  )
  select jsonb_build_object(
    'taskId', x.id,
    'dealReference', d.reference,
    'serviceType', x.service_type,
    'itemTitle', coalesce(nullif(authz.service_item_title(x.service_type, x.facts), ''),
                          initcap(x.service_type) || ' ' || x.item_no::text),
    'facts', jsonb_build_object('type', x.service_type, 'facts', x.facts),
    'department', x.department,
    'hotelName', case when x.service_type = 'hotel' then x.facts ->> 'hotelName' end,
    'city', case when x.service_type = 'hotel' then x.facts ->> 'city' end,
    'checkIn', case when x.service_type = 'hotel' then x.facts ->> 'checkIn' end,
    'checkOut', case when x.service_type = 'hotel' then x.facts ->> 'checkOut' end,
    'nights', case when x.service_type = 'hotel' and authz.sf_date(x.facts -> 'checkIn') is not null
                        and authz.sf_date(x.facts -> 'checkOut') is not null
                   then authz.sf_date(x.facts -> 'checkOut') - authz.sf_date(x.facts -> 'checkIn') else 0 end,
    'rooms', case when x.service_type = 'hotel' then coalesce(authz.sf_int_value(x.facts -> 'rooms'), 0) else 0 end,
    'adults', case x.service_type
      when 'hotel' then coalesce(authz.sf_int_value(x.facts -> 'adults'), 0)
      when 'activity' then coalesce(authz.sf_int_value(x.facts -> 'participants'), 0)
      else coalesce(authz.sf_int_value(x.facts -> 'passengers'), 0) end,
    'children', case when x.service_type = 'hotel' then coalesce(authz.sf_int_value(x.facts -> 'children'), 0) else 0 end,
    'purchaseBudgetPaise', coalesce(authz.task_budget(x.id), 0)::text,
    'status', x.status,
    'assigneeName', ap.display_name,
    'assignedToYou', x.assignee_user_id is not distinct from (select auth.uid()),
    'branchName', b.name,
    'createdAt', x.created_at,
    'supplierConfirmedAt', x.supplier_confirmed_at
  ) || case when p_detail then jsonb_build_object(
    'roomType', case when x.service_type = 'hotel' then x.facts ->> 'roomType' end,
    'mealPlan', case when x.service_type = 'hotel' then x.facts ->> 'mealPlan' end,
    'inclusions', case when x.service_type = 'hotel' then x.facts ->> 'inclusions' end,
    'specialRequests', case when x.service_type = 'hotel' then x.facts ->> 'specialRequests' end,
    'confirmedAt', v.confirmed_at,
    'confirmedByName', cp.display_name,
    'versionNo', v.version_no,
    'canClaim', authz.can_claim_purchase_task(x.id) and x.assignee_user_id is null
  ) else '{}'::jsonb end
  from x
  join public.booking_versions v on v.id = x.booking_version_id
  join public.deals d on d.id = x.deal_id
  join public.branches b on b.id = x.branch_id
  left join public.staff_profiles ap on ap.user_id = x.assignee_user_id
  left join public.staff_profiles cp on cp.user_id = v.confirmed_by
$$;

-- Flight task DTO (FlightTaskSummary / FlightTaskView). Flight facts and the
-- flight item's budget only; traveller count, never names.
create function authz.flight_task_json(p_task uuid, p_detail boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'taskId', t.id,
    'dealReference', d.reference,
    'itemTitle', coalesce(nullif(authz.service_item_title('flight', f.facts), ''), 'Flight ' || i.item_no::text),
    'facts', coalesce(f.facts, '{}'::jsonb),
    'purchaseBudgetPaise', coalesce(f.purchase_budget_paise, 0)::text,
    'status', t.status,
    'assigneeName', ap.display_name,
    'assignedToYou', t.assignee_user_id is not distinct from (select auth.uid()),
    'branchName', b.name,
    'createdAt', t.created_at,
    'supplierConfirmedAt', t.supplier_confirmed_at
  ) || case when p_detail then jsonb_build_object(
    'confirmedAt', v.confirmed_at,
    'confirmedByName', cp.display_name,
    'versionNo', v.version_no,
    'canClaim', authz.can_claim_flight_task(t.id) and t.assignee_user_id is null,
    'travellerCount', (select count(*) from public.booking_version_travellers s where s.booking_version_id = v.id)
  ) else '{}'::jsonb end
  from public.fulfilment_tasks t
  join public.service_items i on i.id = t.service_item_id
  join public.booking_versions v on v.id = t.booking_version_id
  left join public.service_item_facts f on f.service_item_id = t.service_item_id and f.booking_version_id = v.id
  join public.deals d on d.id = t.deal_id
  join public.branches b on b.id = t.branch_id
  left join public.staff_profiles ap on ap.user_id = t.assignee_user_id
  left join public.staff_profiles cp on cp.user_id = v.confirmed_by
  where t.id = p_task
$$;

revoke all on function authz.flight_task_json(uuid, boolean) from public, anon, authenticated, service_role;

-- ===========================================================================
-- 13. Commands: service items and travellers
-- ===========================================================================

-- Shared checks of the draft package version. Order (freeze note 3.3):
-- removed Deal, authorization, switch, lost stage, draft package version. The row_version
-- check follows in each command, after its exact-retry replay lookup.
create function authz.lock_package_draft(p_version_id uuid)
returns public.booking_versions
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
begin
  select * into v_ver from public.booking_versions v where v.id = p_version_id for update;
  perform authz.refuse_removed_deal(v_ver.deal_id);
  if v_ver.id is null or not authz.can_edit_booking_draft(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not authz.service_items_enabled() then
    raise exception 'service_items_disabled' using errcode = '55000';
  end if;
  -- Stage 7: no new intake work on a Deal that is lost or rejected in Bitrix.
  if authz.deal_not_active(v_ver.deal_id) then
    raise exception 'deal_not_active' using errcode = '55000';
  end if;
  if v_ver.status = 'confirmed' then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  if v_ver.service_type <> 'package' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'version';
  end if;
  return v_ver;
end;
$$;

create function authz.require_row_version(p_expected integer, p_actual integer) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_expected is null or p_expected <> p_actual then
    raise exception 'version_changed' using errcode = '40001';
  end if;
end;
$$;

-- Bumps row_version (which recomputes the package hash) and returns the row.
create function authz.bump_package_version(p_version_id uuid) returns public.booking_versions
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
begin
  update public.booking_versions v
  set row_version = v.row_version + 1, updated_at = now()
  where v.id = p_version_id
  returning * into v_ver;
  return v_ver;
end;
$$;

revoke all on function authz.lock_package_draft(uuid), authz.require_row_version(integer, integer),
  authz.bump_package_version(uuid)
from public, anon, authenticated, service_role;

create function public.service_item_add(
  p_version_id uuid, p_expected_row_version integer, p_service_type text, p_facts jsonb,
  p_purchase_budget_paise bigint, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_existing public.service_items%rowtype;
  v_item public.service_items%rowtype;
  v_facts jsonb;
  v_bad text[];
  v_no integer;
begin
  v_ver := authz.lock_package_draft(p_version_id);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  -- Exact retry: the same (version, request) returns the existing item.
  select i.* into v_existing from public.service_items i
  where i.deal_id = v_ver.deal_id and i.request_id = p_request_id;
  if v_existing.id is not null then
    if not exists (select 1 from public.service_item_facts f
                   where f.service_item_id = v_existing.id and f.booking_version_id = v_ver.id) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
    end if;
    return jsonb_build_object('itemId', v_existing.id, 'itemNo', v_existing.item_no,
      'rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
  end if;
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_service_type in ('visa', 'passport', 'train') then
    raise exception 'service_on_hold' using errcode = '22023';
  end if;
  if p_service_type is null or p_service_type not in ('hotel', 'transfer', 'activity', 'flight') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'serviceType';
  end if;
  if p_purchase_budget_paise is null or p_purchase_budget_paise < 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'purchaseBudgetPaise';
  end if;
  v_facts := authz.normalize_service_facts(p_facts);
  v_bad := authz.validate_service_facts(p_service_type, v_facts);
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  if (select count(*) from public.service_items i where i.deal_id = v_ver.deal_id) >= 20 then
    raise exception 'too_many_items' using errcode = '22023';
  end if;
  v_no := coalesce((select max(i.item_no) from public.service_items i where i.deal_id = v_ver.deal_id), 0) + 1;

  insert into public.service_items (deal_id, legal_entity_id, branch_id, item_no, service_type, department,
    state, request_id, created_by)
  values (v_ver.deal_id, v_ver.legal_entity_id, v_ver.branch_id, v_no, p_service_type,
    case when p_service_type = 'flight' then 'flight' else 'purchase' end, 'planned', p_request_id, (select auth.uid()))
  returning * into v_item;
  insert into public.service_item_facts (service_item_id, booking_version_id, legal_entity_id, facts,
    purchase_budget_paise, facts_hash)
  values (v_item.id, v_ver.id, v_ver.legal_entity_id, v_facts, p_purchase_budget_paise,
    authz.service_facts_hash(v_facts, p_purchase_budget_paise));
  v_ver := authz.bump_package_version(v_ver.id);

  -- Ids and type only: no facts, no budget.
  perform authz.write_audit('booking.service_item_added', v_ver.legal_entity_id, v_ver.branch_id,
    'service_item', v_item.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no,
      'itemNo', v_item.item_no, 'serviceType', v_item.service_type, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('itemId', v_item.id, 'itemNo', v_item.item_no,
    'rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;

create function public.service_item_save(
  p_item_id uuid, p_version_id uuid, p_expected_row_version integer, p_facts jsonb, p_purchase_budget_paise bigint
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_item public.service_items%rowtype;
  v_facts jsonb;
  v_bad text[];
begin
  v_ver := authz.lock_package_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  select i.* into v_item from public.service_items i where i.id = p_item_id and i.deal_id = v_ver.deal_id for update;
  if v_item.id is null or not exists (
       select 1 from public.service_item_facts f where f.service_item_id = v_item.id and f.booking_version_id = v_ver.id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_purchase_budget_paise is null or p_purchase_budget_paise < 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'purchaseBudgetPaise';
  end if;
  v_facts := authz.normalize_service_facts(p_facts);
  v_bad := authz.validate_service_facts(v_item.service_type, v_facts);
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;

  update public.service_item_facts f
  set facts = v_facts, purchase_budget_paise = p_purchase_budget_paise, updated_at = now()
  where f.service_item_id = v_item.id and f.booking_version_id = v_ver.id;
  v_ver := authz.bump_package_version(v_ver.id);

  perform authz.write_audit('booking.service_item_saved', v_ver.legal_entity_id, v_ver.branch_id,
    'service_item', v_item.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no,
      'itemNo', v_item.item_no, 'serviceType', v_item.service_type, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;

create function public.service_item_remove(p_item_id uuid, p_version_id uuid, p_expected_row_version integer)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_item public.service_items%rowtype;
begin
  v_ver := authz.lock_package_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  select i.* into v_item from public.service_items i where i.id = p_item_id and i.deal_id = v_ver.deal_id for update;
  if v_item.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_item.state <> 'planned' or exists (
       select 1 from public.service_item_facts f join public.booking_versions v on v.id = f.booking_version_id
       where f.service_item_id = v_item.id and v.status = 'confirmed') then
    raise exception 'item_locked' using errcode = '55000';
  end if;

  delete from public.service_item_facts f where f.service_item_id = v_item.id;
  perform set_config('tripnavigate.service_item_remove', v_item.id::text, true);
  delete from public.service_items i where i.id = v_item.id;
  perform set_config('tripnavigate.service_item_remove', '', true);
  v_ver := authz.bump_package_version(v_ver.id);

  perform authz.write_audit('booking.service_item_removed', v_ver.legal_entity_id, v_ver.branch_id,
    'service_item', v_item.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no,
      'itemNo', v_item.item_no, 'serviceType', v_item.service_type, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('removed', true, 'rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;

-- p_travellers: JSON array of {fullName, type, seq}; replaces the Deal's set.
-- p_expected_row_version is the draft package version's row_version.
create function public.deal_travellers_save(p_deal_id uuid, p_expected_row_version integer, p_travellers jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_draft uuid;
  v_row jsonb;
  v_seq integer;
  v_name text;
  v_type text;
  v_seqs integer[] := '{}'::integer[];
  v_count integer := 0;
begin
  perform authz.refuse_removed_deal(p_deal_id);
  if p_deal_id is null or not authz.can_edit_booking_draft(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not authz.service_items_enabled() then
    raise exception 'service_items_disabled' using errcode = '55000';
  end if;
  if authz.deal_not_active(p_deal_id) then
    raise exception 'deal_not_active' using errcode = '55000';
  end if;
  select v.id into v_draft from public.booking_versions v
  where v.deal_id = p_deal_id and v.status = 'draft' and v.service_type = 'package';
  if v_draft is null then
    if exists (select 1 from public.booking_versions v where v.deal_id = p_deal_id and v.status = 'draft') then
      raise exception 'invalid_input' using errcode = '22023', hint = 'version';
    end if;
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_ver := authz.lock_package_draft(v_draft);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_travellers is null or jsonb_typeof(p_travellers) <> 'array' or jsonb_array_length(p_travellers) > 100 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'travellers';
  end if;

  -- Validate every row before writing anything.
  for v_row in select e from jsonb_array_elements(p_travellers) e loop
    v_count := v_count + 1;
    if jsonb_typeof(v_row) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_row) k where k not in ('fullName', 'type', 'seq'))
       or not authz.sf_text_ok(v_row -> 'fullName', 120, true)
       or not authz.sf_int_ok(v_row -> 'seq', 1, 100, true)
       or jsonb_typeof(v_row -> 'type') <> 'string' or (v_row #>> '{type}') not in ('adult', 'child', 'infant') then
      raise exception 'invalid_input' using errcode = '22023', hint = 'travellers[' || v_count::text || ']';
    end if;
    v_seq := (v_row #>> '{seq}')::integer;
    if v_seq = any (v_seqs) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'travellers[' || v_count::text || '].seq';
    end if;
    v_seqs := v_seqs || v_seq;
  end loop;

  -- Names frozen in a confirmed version cannot change through this command.
  if exists (
    select 1 from public.booking_versions v
    join public.booking_version_travellers s on s.booking_version_id = v.id
    where v.deal_id = p_deal_id and v.status = 'confirmed'
      and not exists (
        select 1 from jsonb_array_elements(p_travellers) e
        where (e #>> '{seq}')::integer = s.seq and btrim(e #>> '{fullName}', E' \t\r\n') = s.full_name)
  ) then
    raise exception 'traveller_identity_locked' using errcode = '55000';
  end if;

  delete from public.deal_travellers t where t.deal_id = p_deal_id;
  for v_row in select e from jsonb_array_elements(p_travellers) e loop
    v_seq := (v_row #>> '{seq}')::integer;
    v_name := btrim(v_row #>> '{fullName}', E' \t\r\n');
    v_type := v_row #>> '{type}';
    insert into public.deal_travellers (deal_id, legal_entity_id, seq, full_name, traveller_type)
    values (p_deal_id, v_ver.legal_entity_id, v_seq, v_name, v_type);
  end loop;
  v_ver := authz.bump_package_version(v_ver.id);

  -- Count only; no names.
  perform authz.write_audit('booking.travellers_saved', v_ver.legal_entity_id, v_ver.branch_id,
    'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', p_deal_id, 'versionNo', v_ver.version_no, 'travellerCount', v_count,
      'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;

-- ===========================================================================
-- 14. Booking commands (replaced bodies)
-- ===========================================================================

-- Replaces 20261115000100: a 'package' draft while service_items_enabled is on.
create or replace function public.booking_open_draft(p_deal_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_ver public.booking_versions%rowtype;
begin
  -- Stage 0: a Deal removed by the Bitrix sync takes no new booking work.
  perform authz.refuse_removed_deal(p_deal_id);
  if p_deal_id is null or not authz.can_edit_booking_draft(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  -- Serializes concurrent opens for one deal.
  select * into v_deal from public.deals d where d.id = p_deal_id for no key update;
  if exists (select 1 from public.booking_versions v where v.deal_id = p_deal_id and v.status = 'confirmed') then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  select * into v_ver from public.booking_versions v where v.deal_id = p_deal_id and v.status = 'draft';
  if v_ver.id is not null then
    return jsonb_build_object('versionId', v_ver.id, 'versionNo', v_ver.version_no,
      'rowVersion', v_ver.row_version, 'created', false);
  end if;
  -- Stage 7: a new draft only on an active Deal. Runs after the lock above, so
  -- it reads the stage the sync last committed.
  if authz.deal_not_active(v_deal.id) then
    raise exception 'deal_not_active' using errcode = '55000';
  end if;

  -- B1: a package draft (items and travellers) while the switch is on.
  insert into public.booking_versions (deal_id, legal_entity_id, branch_id, version_no, created_by, service_type)
  values (v_deal.id, v_deal.legal_entity_id, v_deal.branch_id,
    coalesce((select max(v.version_no) from public.booking_versions v where v.deal_id = v_deal.id), 0) + 1,
    (select auth.uid()),
    case when authz.service_items_enabled() then 'package' else 'hotel' end)
  returning * into v_ver;

  perform authz.write_audit('booking.draft_opened', v_deal.legal_entity_id, v_deal.branch_id,
    'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_deal.id, 'versionNo', v_ver.version_no, 'serviceType', v_ver.service_type));
  return jsonb_build_object('versionId', v_ver.id, 'versionNo', v_ver.version_no,
    'rowVersion', v_ver.row_version, 'created', true);
end;
$$;

-- Replaces 20261107000300. Hotel path unchanged (plus taskIds and the Deal's
-- hotel item). Package path: one task per service item, exactly once.
create or replace function public.booking_confirm(p_version_id uuid, p_expected_content_hash text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_deal public.deals%rowtype;
  v_task uuid;
  v_task_version uuid;
  v_key text;
  v_env text;
  v_item record;
  v_hotel_item uuid;
  v_tasks uuid[] := '{}'::uuid[];
begin
  -- 1. Row lock: a concurrent confirmation waits here, then sees 'confirmed'.
  select * into v_ver from public.booking_versions v where v.id = p_version_id for update;
  -- Stage 0: a Deal removed by the Bitrix sync takes no new booking work.
  perform authz.refuse_removed_deal(v_ver.deal_id);
  -- 2. Existence is not revealed.
  if v_ver.id is null or not authz.can_confirm_booking(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- 3. Repeat / concurrent confirmation: every task of the version, item order.
  if v_ver.status = 'confirmed' then
    select coalesce(array_agg(t.id order by i.item_no, t.created_at), '{}'::uuid[]) into v_tasks
    from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
    where t.booking_version_id = v_ver.id;
    if cardinality(v_tasks) > 0 then
      return jsonb_build_object('outcome', 'existing', 'taskId', v_tasks[1], 'versionId', v_ver.id,
        'taskIds', to_jsonb(v_tasks));
    end if;
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  -- B1: a package version confirms only while the switch is on.
  if v_ver.service_type = 'package' and not authz.service_items_enabled() then
    raise exception 'service_items_disabled' using errcode = '55000';
  end if;
  -- 4. Optimistic check against the live hash.
  if p_expected_content_hash is null or p_expected_content_hash <> authz.booking_content_hash(v_ver.id) then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  -- 5. Gate.
  select * into v_deal from public.deals d where d.id = v_ver.deal_id;
  v_env := authz.deployment_environment();
  if v_env = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if not v_deal.is_synthetic
     and not coalesce((select s.real_booking_enabled from public.booking_settings s where s.id), false) then
    raise exception 'booking_disabled' using errcode = '55000';
  end if;
  if v_deal.is_synthetic and v_env <> 'test' then
    raise exception 'booking_disabled' using errcode = '55000';
  end if;
  -- 6. Readiness (package versions: includes stage_not_confirmed, no_services, ...).
  if cardinality(authz.booking_issues(v_ver.id)) > 0 then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  -- B1 (before the freeze: facts rows of a confirmed version are immutable).
  if v_ver.service_type = 'package' then
    -- Traveller snapshot.
    insert into public.booking_version_travellers (booking_version_id, legal_entity_id, seq, full_name, traveller_type)
    select v_ver.id, v_ver.legal_entity_id, t.seq, t.full_name, t.traveller_type
    from public.deal_travellers t where t.deal_id = v_ver.deal_id;
  else
    -- Legacy hotel version: the Deal's hotel item and its facts snapshot.
    v_hotel_item := authz.hotel_item_for_deal(v_ver.deal_id, v_ver.created_by, v_ver.created_at);
    perform authz.hotel_facts_sync(v_ver.id, v_hotel_item);
  end if;
  -- 7. Freeze.
  update public.booking_versions v
  set status = 'confirmed', confirmed_by = (select auth.uid()), confirmed_at = now(),
      confirmed_deal_source_modified_at = v_deal.source_modified_at, updated_at = now()
  where v.id = v_ver.id
  returning * into v_ver;
  -- 8. Exactly one task per item (hotel path: one task, legacy key).
  if v_ver.service_type = 'package' then
    update public.service_items i set state = 'active', updated_at = now()
    where i.state = 'planned'
      and i.id in (select f.service_item_id from public.service_item_facts f where f.booking_version_id = v_ver.id);
    for v_item in
      select i.id, i.item_no, i.service_type, i.department
      from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
      where f.booking_version_id = v_ver.id
      order by i.item_no
    loop
      v_key := 'item:' || v_item.id::text || ':' || v_item.service_type;
      v_task := null;
      insert into public.fulfilment_tasks
        (deal_id, legal_entity_id, branch_id, booking_version_id, service_purpose, task_key, created_by,
         service_item_id, department)
      values (v_ver.deal_id, v_ver.legal_entity_id, v_ver.branch_id, v_ver.id, v_item.service_type, v_key,
        (select auth.uid()), v_item.id, v_item.department)
      on conflict (task_key) do nothing
      returning id into v_task;
      if v_task is null then
        select t.id, t.booking_version_id into v_task, v_task_version
        from public.fulfilment_tasks t where t.task_key = v_key;
        if v_task_version is distinct from v_ver.id then
          raise exception 'task_conflict' using errcode = '40001';
        end if;
      end if;
      v_tasks := v_tasks || v_task;
      -- 9. Outbox per task (ids and types only).
      insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
      values (v_ver.legal_entity_id, 'fulfilment_task', v_task, 'fulfilment.task_created',
        jsonb_build_object('task_id', v_task, 'version_id', v_ver.id, 'deal_id', v_ver.deal_id,
          'version_no', v_ver.version_no, 'service_purpose', v_item.service_type,
          'service_item_id', v_item.id, 'service_type', v_item.service_type))
      on conflict (event_type, aggregate_id) do nothing;
      -- 10. Audit per task.
      perform authz.write_audit('fulfilment.task_created', v_ver.legal_entity_id, v_ver.branch_id,
        'fulfilment_task', v_task, null,
        jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no,
          'serviceItemId', v_item.id, 'serviceType', v_item.service_type));
    end loop;
    insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
    values (v_ver.legal_entity_id, 'booking_version', v_ver.id, 'booking.version_confirmed',
      jsonb_build_object('version_id', v_ver.id, 'deal_id', v_ver.deal_id, 'task_id', v_tasks[1],
        'version_no', v_ver.version_no, 'service_purpose', 'package'))
    on conflict (event_type, aggregate_id) do nothing;
    perform authz.write_audit('booking.version_confirmed', v_ver.legal_entity_id, v_ver.branch_id,
      'booking_version', v_ver.id, null,
      jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'taskId', v_tasks[1],
        'taskIds', to_jsonb(v_tasks), 'serviceType', 'package'));
    return jsonb_build_object('outcome', 'created', 'taskId', v_tasks[1], 'versionId', v_ver.id,
      'taskIds', to_jsonb(v_tasks));
  end if;

  v_key := 'booking:' || v_ver.id::text || ':hotel';
  insert into public.fulfilment_tasks
    (deal_id, legal_entity_id, branch_id, booking_version_id, service_purpose, task_key, created_by, service_item_id)
  values (v_ver.deal_id, v_ver.legal_entity_id, v_ver.branch_id, v_ver.id, 'hotel', v_key, (select auth.uid()),
    v_hotel_item)
  on conflict (task_key) do nothing
  returning id into v_task;
  if v_task is null then
    select t.id, t.booking_version_id into v_task, v_task_version
    from public.fulfilment_tasks t where t.task_key = v_key;
    if v_task_version is distinct from v_ver.id then
      raise exception 'task_conflict' using errcode = '40001';
    end if;
  end if;
  update public.service_items i set state = 'active', updated_at = now()
  where i.id = v_hotel_item and i.state = 'planned';
  -- 9. Outbox (ids only).
  insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
  values
    (v_ver.legal_entity_id, 'booking_version', v_ver.id, 'booking.version_confirmed',
     jsonb_build_object('version_id', v_ver.id, 'deal_id', v_ver.deal_id, 'task_id', v_task,
       'version_no', v_ver.version_no, 'service_purpose', 'hotel')),
    (v_ver.legal_entity_id, 'fulfilment_task', v_task, 'fulfilment.task_created',
     jsonb_build_object('task_id', v_task, 'version_id', v_ver.id, 'deal_id', v_ver.deal_id,
       'version_no', v_ver.version_no, 'service_purpose', 'hotel'))
  on conflict (event_type, aggregate_id) do nothing;
  -- 10. Audit: ids and version_no only.
  perform authz.write_audit('booking.version_confirmed', v_ver.legal_entity_id, v_ver.branch_id,
    'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'taskId', v_task));
  perform authz.write_audit('fulfilment.task_created', v_ver.legal_entity_id, v_ver.branch_id,
    'fulfilment_task', v_task, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no));
  -- 11.
  return jsonb_build_object('outcome', 'created', 'taskId', v_task, 'versionId', v_ver.id,
    'taskIds', jsonb_build_array(v_task));
end;
$$;

-- ===========================================================================
-- 15. Flight queue
-- ===========================================================================

create function public.flight_task_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(authz.flight_task_json(t.id, false) order by t.created_at desc, t.id)
    from public.fulfilment_tasks t
    where t.department = 'flight' and authz.can_read_flight_task(t.id)
  ), '[]'::jsonb);
end;
$$;

create function public.flight_task_get(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_task_id is null or not authz.can_read_flight_task(p_task_id) then
    return null;
  end if;
  return authz.flight_task_json(p_task_id, true);
end;
$$;

create function public.flight_task_claim(p_task_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_uid uuid := (select auth.uid());
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  perform authz.refuse_removed_deal(v_task.deal_id);
  if v_task.id is null or not authz.can_claim_flight_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_task.assignee_user_id = v_uid then
    return jsonb_build_object('taskId', v_task.id, 'status', v_task.status, 'assignedToYou', true,
      'alreadyYours', true);
  end if;
  if v_task.assignee_user_id is not null then
    raise exception 'task_conflict' using errcode = '40001';
  end if;

  update public.fulfilment_tasks t
  set assignee_user_id = v_uid, status = 'in_progress', updated_at = now()
  where t.id = v_task.id;
  insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
  values (v_task.deal_id, v_task.legal_entity_id, v_uid, 'flight', v_uid)
  on conflict (deal_id, user_id, assignment_kind) where ended_at is null do nothing;

  perform authz.write_audit('fulfilment.task_claimed', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('dealId', v_task.deal_id, 'versionId', v_task.booking_version_id,
      'serviceItemId', v_task.service_item_id, 'department', 'flight'));
  return jsonb_build_object('taskId', v_task.id, 'status', 'in_progress', 'assignedToYou', true,
    'alreadyYours', false);
end;
$$;

-- ===========================================================================
-- 16. Reads: intake checklist, Deal services, summaries, counts, panel, health
-- ===========================================================================

create function public.intake_checklist(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ver public.booking_versions;
  v_items jsonb := '[]'::jsonb;
  v_needed integer := 0;
  v_travellers integer := 0;
  v_nos integer[];
  v_text text;
begin
  -- Booking readers who hold neither purchase nor flight (review E1).
  if p_deal_id is null or not authz.can_read_service_rows(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_ver := authz.deal_current_version(p_deal_id);
  if v_ver.service_type is distinct from 'package' then
    v_ver := null;
  end if;

  if not authz.deal_in_trigger_stage(p_deal_id) then
    v_items := v_items || jsonb_build_object('code', 'stage_not_confirmed', 'blocking', true, 'owner', 'bitrix', 'itemNos', '[]'::jsonb);
  end if;
  if v_ver.id is null or not exists (select 1 from public.service_item_facts f where f.booking_version_id = v_ver.id) then
    v_items := v_items || jsonb_build_object('code', 'no_services', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
  end if;
  if v_ver.id is not null and not exists (
       select 1 from public.booking_evidence e
       where e.version_id = v_ver.id and e.kind = 'acceptance_message' and e.status = 'stored') then
    v_items := v_items || jsonb_build_object('code', 'acceptance_missing', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
  end if;
  if v_ver.id is not null then
    v_needed := authz.version_travellers_needed(v_ver.id);
  end if;
  select count(*) into v_travellers from public.deal_travellers t where t.deal_id = p_deal_id;
  if v_travellers < v_needed then
    v_items := v_items || jsonb_build_object('code', 'traveller_missing', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
  end if;
  if exists (select 1 from public.deal_travellers t where t.deal_id = p_deal_id and btrim(t.full_name, E' \t\r\n') = '') then
    v_items := v_items || jsonb_build_object('code', 'traveller_name_incomplete', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
  end if;
  if v_ver.id is not null then
    v_nos := authz.service_item_invalid_nos(v_ver.id);
    if cardinality(v_nos) > 0 then
      v_items := v_items || jsonb_build_object('code', 'service_facts_invalid', 'blocking', true, 'owner', 'sales', 'itemNos', to_jsonb(v_nos));
    end if;
    -- An item whose dates fall more than a day outside the other items' dates.
    with d as (
      select i.item_no, authz.sf_date(x.d) as day
      from public.service_item_facts f
      join public.service_items i on i.id = f.service_item_id
      cross join lateral (
        select f.facts -> 'checkIn' as d union all select f.facts -> 'checkOut'
        union all select f.facts -> 'date'
        union all select s -> 'date' from jsonb_array_elements(
          case when jsonb_typeof(f.facts -> 'segments') = 'array' then f.facts -> 'segments' else '[]'::jsonb end) s
      ) x
      where f.booking_version_id = v_ver.id and authz.sf_date(x.d) is not null
    )
    select coalesce(array_agg(distinct a.item_no order by a.item_no), '{}'::integer[]) into v_nos
    from d a
    where exists (select 1 from d b where b.item_no <> a.item_no)
      and (a.day < (select min(b.day) from d b where b.item_no <> a.item_no) - 1
        or a.day > (select max(b.day) from d b where b.item_no <> a.item_no) + 1);
    if cardinality(v_nos) > 0 then
      v_items := v_items || jsonb_build_object('code', 'dates_outside_trip', 'blocking', false, 'owner', 'sales', 'itemNos', to_jsonb(v_nos));
    end if;
    select coalesce(array_agg(i.item_no order by i.item_no), '{}'::integer[]) into v_nos
    from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
    where f.booking_version_id = v_ver.id and f.purchase_budget_paise = 0;
    if cardinality(v_nos) > 0 then
      v_items := v_items || jsonb_build_object('code', 'budget_missing', 'blocking', false, 'owner', 'sales', 'itemNos', to_jsonb(v_nos));
    end if;
    select string_agg(coalesce(f.facts ->> 'notes', '') || ' ' || coalesce(f.facts ->> 'specialRequests', '')
      || ' ' || coalesce(f.facts ->> 'inclusions', ''), ' ') into v_text
    from public.service_item_facts f where f.booking_version_id = v_ver.id;
  end if;
  v_text := coalesce(v_text, '') || ' ' || coalesce((select d.title from public.deals d where d.id = p_deal_id), '');
  if v_text ~* '\m(visa|passport|train)\M' then
    v_items := v_items || jsonb_build_object('code', 'visa_mentioned', 'blocking', false, 'owner', 'sales', 'itemNos', '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'items', v_items,
    'canConfirm', coalesce(v_ver.status = 'draft', false) and authz.can_confirm_booking(p_deal_id)
      and not exists (select 1 from jsonb_array_elements(v_items) e where (e ->> 'blocking')::boolean));
end;
$$;

create function public.deal_services(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_deal_id is null or not authz.can_read_deal(p_deal_id) then
    return null;
  end if;
  return authz.deal_services_json(p_deal_id);
end;
$$;

-- At most 50 Deals; Deals the caller may not read are omitted. Purchase and
-- Flight viewers get counts over their own department's items only.
create function public.deal_service_summary(p_deal_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_deal_ids is null or cardinality(p_deal_ids) > 50 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(
      authz.deal_progress_json(x.id, x.scope)
      || jsonb_build_object(
        'dealId', x.id,
        'serviceTypes', coalesce((
          select jsonb_agg(i.service_type order by i.item_no) from public.service_items i
          where i.deal_id = x.id and i.state <> 'cancelled' and (x.scope is null or i.department = any (x.scope))), '[]'::jsonb))
      order by x.ord)
    from (
      select distinct on (ids.id) ids.id, ids.ord, authz.deal_services_scope(ids.id) as scope
      from unnest(p_deal_ids) with ordinality as ids(id, ord)
      where authz.can_read_deal(ids.id)
      order by ids.id, ids.ord
    ) x
    where x.scope is null or cardinality(x.scope) > 0
  ), '[]'::jsonb);
end;
$$;

-- Role-scoped Home counts (freeze note section 4; Accounts rules per the
-- finance read-through: same gate and predicates as accounts_queue).
create function public.my_work_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_sales boolean;
  v_manager boolean;
  v_purchase boolean;
  v_flight boolean;
  v_accounts boolean;
  v_waiting integer := 0;
  v_returned integer := 0;
  v_missing integer := 0;
  v_intake integer := 0;
  v_receipts integer;
  v_requests integer;
  v_n integer;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select
    bool_or(m.role_code = 'sales' and authz.holds_active_role('sales', m.legal_entity_id)),
    bool_or(m.role_code = 'manager' and authz.holds_active_role('manager', m.legal_entity_id)),
    bool_or(m.role_code = 'purchase' and authz.holds_active_role('purchase', m.legal_entity_id)),
    bool_or(m.role_code = 'flight' and authz.holds_active_role('flight', m.legal_entity_id)),
    bool_or(m.role_code = 'accounts' and authz.holds_active_role('accounts', m.legal_entity_id)
            and not authz.holds_role('purchase', m.legal_entity_id))
  into v_sales, v_manager, v_purchase, v_flight, v_accounts
  from public.memberships m where m.user_id = v_uid and m.status = 'active';

  -- Sales / Manager: drafts the caller may edit, their repair subset,
  -- returned reviews, and (while the prompt is on) confirmed Bitrix Deals
  -- without a booking.
  if coalesce(v_sales, false) or coalesce(v_manager, false) then
    select count(*), count(*) filter (where cardinality(authz.booking_issues(v.id)) > 0)
    into v_waiting, v_missing
    from public.booking_versions v
    where v.status = 'draft' and authz.can_edit_booking_draft(v.deal_id);
    select count(distinct d.id) into v_returned
    from public.deals d
    join public.booking_versions v on v.deal_id = d.id and v.status = 'confirmed'
    join public.accounts_booking_reviews rv on rv.booking_version_id = v.id and rv.status = 'returned'
    where d.removed_at is null
      and ((d.owner_user_id = v_uid and authz.holds_active_role('sales', d.legal_entity_id))
           or authz.is_branch_sales_manager(d.id));
    if coalesce((select s.intake_prompt_enabled from public.workflow_settings s where s.id), false) then
      select count(*) into v_intake
      from public.deals d
      where d.source_system = 'bitrix' and d.removed_at is null
        and authz.deal_in_trigger_stage(d.id)
        and not exists (select 1 from public.booking_versions v where v.deal_id = d.id)
        and ((d.owner_user_id = v_uid and authz.holds_active_role('sales', d.legal_entity_id))
             or authz.is_branch_sales_manager(d.id));
    end if;
  end if;

  -- Purchase: readable not-started purchase tasks plus own in-progress tasks.
  if coalesce(v_purchase, false) then
    select count(*) into v_n from public.fulfilment_tasks t
    where ((t.department = 'purchase' and t.status = 'not_started' and authz.can_read_purchase_task(t.id))
        or (t.status = 'in_progress' and t.assignee_user_id = v_uid and t.department = 'purchase'));
    v_waiting := v_waiting + v_n;
  end if;
  -- Flight: the same for the flight department.
  if coalesce(v_flight, false) then
    select count(*) into v_n from public.fulfilment_tasks t
    where ((t.department = 'flight' and t.status = 'not_started' and authz.can_read_flight_task(t.id))
        or (t.status = 'in_progress' and t.assignee_user_id = v_uid and t.department = 'flight'));
    v_waiting := v_waiting + v_n;
  end if;

  -- Accounts: accounts_queue('needs_review') row count and recorded receipts
  -- by someone else, over the queue's gate (entity x synthetic flag).
  if coalesce(v_accounts, false) then
    with gate as materialized (
      select e.id as legal_entity_id, s.is_synthetic
      from public.legal_entities e
      cross join (values (true), (false)) as s(is_synthetic)
      where authz.can_accounts(e.id)
        and authz.finance_gate_issue(e.id, s.is_synthetic) is null
    )
    select
      (select count(*)
       from public.deals d
       join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
       join public.booking_versions v on v.deal_id = d.id and v.status = 'confirmed'
       left join public.accounts_booking_reviews rv on rv.booking_version_id = v.id
       where coalesce(rv.status, 'pending') = 'pending'),
      (select count(*)
       from public.customer_receipts r
       join public.deals d on d.id = r.deal_id
       join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
       where r.status = 'recorded' and r.recorded_by <> v_uid)
    into v_n, v_receipts;
    v_waiting := v_waiting + v_n;
  end if;

  if coalesce(v_manager, false) then
    v_requests := 0; -- B3
  end if;

  return jsonb_build_object(
    'waitingForMe', v_waiting,
    'returnedToMe', v_returned,
    'missingDetails', v_missing,
    'intakeNeeded', v_intake,
    'receiptsToVerify', v_receipts,
    'requestsToApprove', v_requests);
end;
$$;

create function public.workflow_settings_get() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return (select jsonb_build_object('intakePromptEnabled', s.intake_prompt_enabled,
    'serviceItemsEnabled', s.service_items_enabled, 'updatedAt', s.updated_at)
    from public.workflow_settings s where s.id);
end;
$$;

create function public.admin_set_workflow_setting(p_key text, p_value boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before public.workflow_settings%rowtype;
  v_after public.workflow_settings%rowtype;
  v_reason text;
  v_prev text[];
  v_was boolean;
  v_now boolean;
begin
  if not authz.can_switch_live_settings(null) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_reason := authz.settings_change_reason(p_reason);
  if p_key is null or p_key not in ('intake_prompt_enabled', 'service_items_enabled') or p_value is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into v_before from public.workflow_settings s where s.id for update;
  if v_before.id is null then
    raise exception 'settings row missing' using errcode = '55000';
  end if;

  v_prev := authz.settings_begin_change('admin_set_workflow_setting', v_reason);
  update public.workflow_settings s
  set intake_prompt_enabled = case when p_key = 'intake_prompt_enabled' then p_value else s.intake_prompt_enabled end,
      service_items_enabled = case when p_key = 'service_items_enabled' then p_value else s.service_items_enabled end
  where s.id
  returning * into v_after;
  perform authz.settings_end_change(v_prev);

  v_was := case when p_key = 'intake_prompt_enabled' then v_before.intake_prompt_enabled else v_before.service_items_enabled end;
  v_now := case when p_key = 'intake_prompt_enabled' then v_after.intake_prompt_enabled else v_after.service_items_enabled end;
  return jsonb_build_object('key', p_key, 'changed', v_was is distinct from v_now, 'before', v_was, 'after', v_now,
    'updatedAt', v_after.updated_at);
end;
$$;

-- Replaces 20261115000100: adds services (role-filtered items) and progress.
create or replace function public.booking_panel(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_version jsonb;
  v_readiness jsonb;
  v_issues text[];
  v_evidence jsonb;
  v_task jsonb;
  v_can_edit boolean;
  v_can_confirm boolean;
  v_services jsonb;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Purchase role holders and non-readers get null (Purchase uses purchase_task_*).
  if p_deal_id is null or not authz.can_read_booking(p_deal_id) then
    return null;
  end if;

  select * into v_ver from public.booking_versions v
  where v.deal_id = p_deal_id
  order by (v.status = 'confirmed') desc, v.version_no desc
  limit 1;

  if v_ver.id is not null then
    v_version := jsonb_build_object(
      'versionId', v_ver.id,
      'versionNo', v_ver.version_no,
      'status', v_ver.status,
      'rowVersion', v_ver.row_version,
      'contentHash', v_ver.content_hash,
      'facts', authz.booking_facts_json(v_ver.id),
      -- B1
      'serviceType', v_ver.service_type,
      'confirmedAt', v_ver.confirmed_at,
      'confirmedByName', (select p.display_name from public.staff_profiles p where p.user_id = v_ver.confirmed_by));
    if authz.can_read_deal_commercial(p_deal_id) then
      v_version := v_version || jsonb_build_object('sellingTotalPaise',
        (select c.selling_total_paise::text from public.booking_version_commercials c where c.version_id = v_ver.id));
    end if;
    if v_ver.status = 'draft' then
      v_issues := authz.booking_issues_for_viewer(v_ver.id);
      v_readiness := jsonb_build_object('ready', cardinality(v_issues) = 0, 'issues', to_jsonb(v_issues),
        'contentHash', v_ver.content_hash);
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', e.id,
        'kind', e.kind,
        'fileName', e.file_name,
        'mime', e.mime,
        'sizeBytes', e.size_bytes,
        'status', e.status,
        'uploadedByYou', e.uploaded_by = (select auth.uid()),
        'createdAt', e.created_at,
        'storedAt', e.stored_at) order by e.created_at, e.id), '[]'::jsonb)
    into v_evidence
    from public.booking_evidence e
    where e.version_id = v_ver.id and e.status <> 'removed'
      and authz.can_read_booking_evidence(p_deal_id);  -- A4 M2
    -- B1: the first task of the version (the hotel task for hotel versions);
    -- only for full booking readers (review E6: a department-scoped viewer
    -- gets its own tasks through services[], never another department's).
    if authz.deal_services_scope(p_deal_id) is null then
      select jsonb_build_object('taskId', t.id, 'status', t.status, 'assigneeName', p.display_name)
      into v_task
      from public.fulfilment_tasks t
      join public.service_items i on i.id = t.service_item_id
      left join public.staff_profiles p on p.user_id = t.assignee_user_id
      where t.booking_version_id = v_ver.id
      order by i.item_no, t.created_at
      limit 1;
    end if;
  end if;

  v_can_edit := coalesce(v_ver.status, 'draft') = 'draft' and authz.can_edit_booking_draft(p_deal_id);
  v_can_confirm := v_ver.status = 'draft' and authz.can_confirm_booking(p_deal_id);
  v_services := authz.deal_services_json(p_deal_id);

  return jsonb_build_object(
    'dealId', p_deal_id,
    'canEdit', coalesce(v_can_edit, false),
    'canConfirm', coalesce(v_can_confirm, false),
    'gate', jsonb_build_object(
      'realBookingEnabled', coalesce((select s.real_booking_enabled from public.booking_settings s where s.id), false),
      'environment', authz.deployment_environment()),
    'version', v_version,
    'readiness', v_readiness,
    'evidence', coalesce(v_evidence, '[]'::jsonb),
    -- Re-review M-NEW-1: tells the UI the list was withheld, not empty.
    'evidenceVisible', authz.can_read_booking_evidence(p_deal_id),
    'task', v_task,
    -- Stage 7: the Deal is lost or rejected in Bitrix, so a new booking cannot be started.
    'dealNotActive', authz.deal_not_active(p_deal_id),
    -- B1
    'services', coalesce(v_services -> 'items', '[]'::jsonb),
    'progress', coalesce(v_services -> 'progress', authz.deal_progress_json(p_deal_id, null)),
    'serviceItemsEnabled', authz.service_items_enabled());
end;
$$;

-- Replaces 20261004000100: adds tasksByServiceType and serviceItemsEnabled.
create or replace function public.booking_health() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_entities uuid[];
  v_drafts integer;
  v_repair integer;
begin
  if not authz.can_admin_any('integration.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select coalesce(array_agg(distinct m.legal_entity_id), '{}') into v_entities
  from public.memberships m
  where m.user_id = (select auth.uid()) and m.status = 'active'
    and authz.can_admin('integration.manage', m.legal_entity_id);

  select count(*), count(*) filter (where cardinality(authz.booking_issues(v.id)) > 0)
  into v_drafts, v_repair
  from public.booking_versions v
  where v.status = 'draft' and v.legal_entity_id = any (v_entities);

  return jsonb_build_object(
    'realBookingEnabled', coalesce((select s.real_booking_enabled from public.booking_settings s where s.id), false),
    'environment', authz.deployment_environment(),
    'drafts', v_drafts,
    'draftsNeedingRepair', v_repair,
    'confirmed', (select count(*) from public.booking_versions v
                  where v.status = 'confirmed' and v.legal_entity_id = any (v_entities)),
    'tasksNotStarted', (select count(*) from public.fulfilment_tasks t
                        where t.status = 'not_started' and t.legal_entity_id = any (v_entities)),
    'tasksInProgress', (select count(*) from public.fulfilment_tasks t
                        where t.status = 'in_progress' and t.legal_entity_id = any (v_entities)),
    'pendingOutboxEvents', (select count(*) from public.outbox_events o
                            where o.status = 'pending' and o.legal_entity_id = any (v_entities)),
    -- B1: open (not supplier-confirmed) tasks per service type, and the switch.
    'tasksByServiceType', (select jsonb_build_object(
        'hotel', count(*) filter (where t.service_purpose = 'hotel'),
        'transfer', count(*) filter (where t.service_purpose = 'transfer'),
        'activity', count(*) filter (where t.service_purpose = 'activity'),
        'flight', count(*) filter (where t.service_purpose = 'flight'))
      from public.fulfilment_tasks t
      where t.status <> 'supplier_confirmed' and t.legal_entity_id = any (v_entities)),
    'serviceItemsEnabled', authz.service_items_enabled());
end;
$$;

-- ===========================================================================
-- 17. Grants on the public functions
-- ===========================================================================

revoke all on function
  public.service_item_add(uuid, integer, text, jsonb, bigint, uuid),
  public.service_item_save(uuid, uuid, integer, jsonb, bigint),
  public.service_item_remove(uuid, uuid, integer),
  public.deal_travellers_save(uuid, integer, jsonb),
  public.flight_task_list(), public.flight_task_get(uuid), public.flight_task_claim(uuid),
  public.intake_checklist(uuid), public.deal_services(uuid), public.deal_service_summary(uuid[]),
  public.my_work_counts(), public.workflow_settings_get(),
  public.admin_set_workflow_setting(text, boolean, text)
from public, anon, authenticated, service_role;

grant execute on function
  public.service_item_add(uuid, integer, text, jsonb, bigint, uuid),
  public.service_item_save(uuid, uuid, integer, jsonb, bigint),
  public.service_item_remove(uuid, uuid, integer),
  public.deal_travellers_save(uuid, integer, jsonb),
  public.flight_task_list(), public.flight_task_get(uuid), public.flight_task_claim(uuid),
  public.intake_checklist(uuid), public.deal_services(uuid), public.deal_service_summary(uuid[]),
  public.my_work_counts(), public.workflow_settings_get(),
  public.admin_set_workflow_setting(text, boolean, text)
to authenticated;

-- Trigger functions created here are never callable through the API.
revoke all on function
  authz.fulfilment_tasks_link_item(), authz.service_items_guard(), authz.service_item_facts_guard(),
  authz.booking_version_travellers_guard(), authz.deal_travellers_touch(),
  authz.booking_package_hash(uuid, uuid, uuid), authz.service_item_facts_rehash(), authz.deal_travellers_rehash()
from public, anon, authenticated, service_role;

commit;
