-- TripNavigate CRM - B1.1a: "Book now" data, commands, readiness and reads.
--
-- Contract: docs/implementation/frontend-first-plan-2026-10-10/b1.1/
--   b1.1-contract-2026-10-11.md (frozen 11 Oct 2026), b1.1-plan-2026-10-11.md
--   (field matrix section 3, data plan 5.1).
-- Shapes:  b1.1-freeze-note.md (same folder) and its appendix A section 1.
--
-- What changes (all additive; B1's migration 20261118000100 is not edited):
--   * booking_versions: trip block (destination, scope, start, end) and
--     hash_schema (1 = the B1 package formula, 2 = B1.1). Every existing row
--     is 1, existing draft package versions move to 2, new rows default to 2.
--     Hotel versions keep authz.booking_hash unchanged. Confirmed B1 package
--     versions keep their stored hash: the only change for schema 1 is that a
--     confirmed version reads its traveller snapshot instead of the live
--     travellers (B1 review E13), which are equal because B1 cannot change
--     travellers after confirmation.
--   * booking_version_contacts (one row per package version), traveller
--     extras (age, special needs) on deal_travellers and the snapshot,
--     restricted traveller_identities + booking_version_traveller_identities
--     (no Data API read at all), service_item_travellers (participation per
--     item and version), list price / discount on booking_version_commercials,
--     booking_version_instalments (payment plan). Contacts, participation,
--     trip and identity are hashed (schema 2); the plan and list/discount reach
--     the hash only through commercial_revision (redrawn on every change).
--   * customer_billing_profiles.prefill_source may be 'sales' (Sales proposes
--     the same record; Accounts still verifies; a verified row is refused).
--   * Service types visa and passport (department visa) are captured. Their
--     tasks are created only while workflow_settings.visa_passport_tasks_enabled
--     is on; that switch is added here (default off) and becomes settable in
--     20261119000500. Until then sold visa/passport items are confirmed, shown
--     as waiting for the desk launch and counted as outstanding.
--   * Facts keys added (authz.validate_service_facts, same signature); the
--     transfer vehicle type and passengers become optional; flight from/to
--     accept an IATA code or a place name.
--   * Commands: booking_contacts_save, booking_billing_propose,
--     booking_customer_save (both in one transaction), booking_trip_save,
--     traveller_identity_save, service_item_travellers_save,
--     booking_commercials_save, booking_instalments_save. Read:
--     booking_form_get. Replaced (latest bodies copied, B1.1 lines marked):
--     service_item_add, deal_travellers_save, booking_confirm,
--     intake_checklist, workflow_settings_get (20261118000100) and the authz
--     helpers listed in each section.
--   * authz.current_accepted_version(p_deal) for the claims migration.
--
-- Refusal tokens added (message is exactly the token):
--   55000 billing_verified
--   Existing tokens keep their SQLSTATEs.
--
-- Switch behaviour: while service_items_enabled is off every new command
-- refuses service_items_disabled (55000); reads return what is stored; the
-- hotel path is untouched.
--
-- Rollback (forward-only): switch service_items_enabled off. Emergency: a NEW
-- migration revoking execute on the new commands. Rows are kept.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Columns and widened checks on existing tables
-- ===========================================================================

alter table public.booking_versions
  add column trip_destination text check (length(trip_destination) between 1 and 200),
  add column trip_scope text check (trip_scope in ('domestic', 'international')),
  add column trip_start date check (trip_start between date '2000-01-01' and date '2100-12-31'),
  add column trip_end date check (trip_end between date '2000-01-01' and date '2100-12-31'),
  add column hash_schema smallint not null default 1 check (hash_schema in (1, 2)),
  add column updated_by uuid references public.staff_profiles (user_id),
  add constraint booking_versions_trip_dates_check check (trip_end >= trip_start);
create index booking_versions_updated_by_idx on public.booking_versions (updated_by) where updated_by is not null;
comment on column public.booking_versions.updated_by is
  'Who last saved the package draft (set by every package draft command); shown with updated_at after a version_changed refusal.';
comment on column public.booking_versions.hash_schema is
  'Package hash formula: 1 = B1 (items, travellers, commercial revision, evidence), 2 = B1.1 (adds participation, traveller extras, identities, trip, contacts). Immutable.';

alter table public.workflow_settings
  add column visa_passport_tasks_enabled boolean not null default false;
drop trigger workflow_settings_audit on public.workflow_settings;
create trigger workflow_settings_audit
  after insert or update or delete on public.workflow_settings
  for each row execute function authz.audit_settings_change(
    'settings.workflow_changed', 'intake_prompt_enabled', 'service_items_enabled', 'visa_passport_tasks_enabled');
comment on column public.workflow_settings.visa_passport_tasks_enabled is
  'B1.1c: Visa & Passport desk tasks. Off: sold visa/passport items wait for the desk launch. Settable from 20261119000500.';

create function authz.visa_passport_tasks_enabled() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.visa_passport_tasks_enabled from public.workflow_settings s where s.id), false)
$$;
revoke all on function authz.visa_passport_tasks_enabled() from public, anon, authenticated, service_role;

-- service_items: visa and passport (department visa).
do $$
declare
  c record;
begin
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.service_items'::regclass and con.contype = 'c'
      and (pg_get_constraintdef(con.oid) like '%service_type%' or pg_get_constraintdef(con.oid) like '%department%')
  loop
    execute format('alter table public.service_items drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table public.service_items
  add constraint service_items_service_type_check
    check (service_type in ('hotel', 'transfer', 'activity', 'flight', 'visa', 'passport')),
  add constraint service_items_department_check check (department in ('purchase', 'flight', 'visa')),
  add constraint service_items_department_matches_type check (department = case
    when service_type = 'flight' then 'flight' when service_type in ('visa', 'passport') then 'visa' else 'purchase' end);

-- fulfilment_tasks: purposes visa / passport (department visa); tasks are
-- created only while visa_passport_tasks_enabled is on.
alter table public.fulfilment_tasks
  drop constraint fulfilment_tasks_service_purpose_check,
  drop constraint fulfilment_tasks_department_check,
  drop constraint fulfilment_tasks_department_matches_purpose;
alter table public.fulfilment_tasks
  add constraint fulfilment_tasks_service_purpose_check
    check (service_purpose in ('hotel', 'transfer', 'activity', 'flight', 'visa', 'passport')),
  add constraint fulfilment_tasks_department_check check (department in ('purchase', 'flight', 'visa')),
  add constraint fulfilment_tasks_department_matches_purpose check (department = case
    when service_purpose = 'flight' then 'flight' when service_purpose in ('visa', 'passport') then 'visa' else 'purchase' end);

-- Replaces 20261118000100: department mapping includes visa.
create or replace function authz.fulfilment_tasks_link_item() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.service_item_id is null and new.task_key like 'booking:%' then
    new.service_item_id := authz.hotel_item_for_deal(new.deal_id, new.created_by, null);
  end if;
  if new.service_item_id is null then
    raise exception 'fulfilment task needs a service item' using errcode = '22023';
  end if;
  -- B1.1
  new.department := case when new.service_purpose = 'flight' then 'flight'
                         when new.service_purpose in ('visa', 'passport') then 'visa' else 'purchase' end;
  return new;
end;
$$;

-- customer_billing_profiles: Sales may propose (prefill_source 'sales').
alter table public.customer_billing_profiles drop constraint customer_billing_profiles_prefill_source_check;
alter table public.customer_billing_profiles
  add constraint customer_billing_profiles_prefill_source_check check (prefill_source in ('none', 'sales'));

-- Traveller extras (live and snapshot).
alter table public.deal_travellers
  add column age_years integer check (age_years between 0 and 17),
  add column special_needs text check (length(special_needs) between 1 and 500);
alter table public.booking_version_travellers
  add column age_years integer check (age_years between 0 and 17),
  add column special_needs text check (length(special_needs) between 1 and 500);

-- List price and discount (whole paise). Readable with the selling total only.
alter table public.booking_version_commercials
  add column list_price_paise bigint check (list_price_paise >= 0),
  add column discount_paise bigint check (discount_paise >= 0),
  add constraint booking_version_commercials_discount_needs_list check (discount_paise is null or list_price_paise is not null),
  add constraint booking_version_commercials_list_matches_total
    check (list_price_paise is null or list_price_paise - coalesce(discount_paise, 0) = selling_total_paise);

-- ===========================================================================
-- 2. New tables
-- ===========================================================================

create table public.booking_version_contacts (
  booking_version_id uuid primary key,
  legal_entity_id uuid not null,
  deal_id uuid not null,
  contact_name text not null check (length(contact_name) between 1 and 120),
  mobile text check (mobile ~ '^[6-9][0-9]{9}$'),
  email text check (length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  contact_confirmed boolean not null default false,
  confirmed_by uuid references public.staff_profiles (user_id),
  confirmed_at timestamptz,
  booking_for text not null check (booking_for in ('individual', 'business')),
  payer_different boolean not null default false,
  payer_name text check (length(payer_name) between 1 and 200),
  updated_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, deal_id, booking_version_id) references public.booking_versions (legal_entity_id, deal_id, id),
  check (mobile is not null or email is not null),
  check (contact_confirmed = (confirmed_at is not null)),
  check ((confirmed_at is null) = (confirmed_by is null)),
  check (payer_different = (payer_name is not null))
);
create index booking_version_contacts_deal_idx on public.booking_version_contacts (deal_id);
create index booking_version_contacts_confirmed_by_idx on public.booking_version_contacts (confirmed_by) where confirmed_by is not null;
create index booking_version_contacts_updated_by_idx on public.booking_version_contacts (updated_by);
comment on table public.booking_version_contacts is
  'Booking contact of one package version (personal data: Sales owner, branch Manager and Accounts only; never Purchase, Flight or the Visa desk). Immutable once the version is not a draft. Hashed into the version.';

create table public.traveller_identities (
  traveller_id uuid primary key references public.deal_travellers (id) on delete cascade,
  deal_id uuid not null,
  legal_entity_id uuid not null,
  date_of_birth date check (date_of_birth >= date '1900-01-01'),
  nationality text check (length(nationality) between 2 and 60),
  passport_number text check (passport_number ~ '^[A-Z0-9]{6,15}$'),
  passport_expiry date check (passport_expiry between date '2000-01-01' and date '2100-12-31'),
  row_version integer not null default 1 check (row_version >= 1),
  updated_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id)
);
create index traveller_identities_deal_idx on public.traveller_identities (deal_id);
create index traveller_identities_updated_by_idx on public.traveller_identities (updated_by);
comment on table public.traveller_identities is
  'Restricted identity data of a Deal traveller (date of birth, nationality, passport). No Data API read; definer functions only. Never in Purchase, Accounts or Super Admin reads; never sent to an external service.';

create table public.booking_version_traveller_identities (
  booking_version_id uuid not null,
  legal_entity_id uuid not null,
  seq integer not null check (seq between 1 and 100),
  date_of_birth date,
  nationality text,
  passport_number text,
  passport_expiry date,
  created_at timestamptz not null default now(),
  primary key (booking_version_id, seq),
  foreign key (legal_entity_id, booking_version_id) references public.booking_versions (legal_entity_id, id)
);
comment on table public.booking_version_traveller_identities is
  'Restricted identity snapshot frozen into a confirmed booking version. Immutable. No Data API read.';

create table public.service_item_travellers (
  booking_version_id uuid not null,
  service_item_id uuid not null,
  legal_entity_id uuid not null,
  traveller_seq integer not null check (traveller_seq between 1 and 100),
  created_at timestamptz not null default now(),
  primary key (booking_version_id, service_item_id, traveller_seq),
  foreign key (service_item_id, booking_version_id)
    references public.service_item_facts (service_item_id, booking_version_id) on delete cascade,
  foreign key (legal_entity_id, service_item_id) references public.service_items (legal_entity_id, id)
);
create index service_item_travellers_item_idx on public.service_item_travellers (service_item_id);
comment on table public.service_item_travellers is
  'Travellers taking part in one service item inside one booking version (by traveller seq). Immutable once the version is not a draft. Hashed.';

create table public.booking_version_instalments (
  id uuid primary key default gen_random_uuid(),
  booking_version_id uuid not null,
  deal_id uuid not null,
  legal_entity_id uuid not null,
  seq integer not null check (seq between 1 and 12),
  label text not null check (length(label) between 1 and 60),
  amount_paise bigint not null check (amount_paise > 0),
  due_date date not null check (due_date between date '2000-01-01' and date '2100-12-31'),
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, deal_id, booking_version_id) references public.booking_versions (legal_entity_id, deal_id, id),
  unique (booking_version_id, seq)
);
create index booking_version_instalments_deal_idx on public.booking_version_instalments (deal_id);
comment on table public.booking_version_instalments is
  'Customer payment plan of a package version (commercial: Sales owner, branch Manager, Accounts; never Purchase, Flight or the Visa desk). Instalments add up to the selling total (readiness). Immutable once the version is not a draft.';

-- ===========================================================================
-- 3. Guards and hash triggers
-- ===========================================================================

-- Rows that belong to one booking version: refused once the version is not a
-- draft; the version id never changes.
create function authz.b11_version_child_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.booking_versions v
    where v.status <> 'draft'
      and v.id in (case when tg_op = 'INSERT' then null else old.booking_version_id end,
                   case when tg_op = 'DELETE' then null else new.booking_version_id end)
  ) then
    raise exception '% rows of a confirmed booking version are immutable', tg_table_name using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.booking_version_id is distinct from old.booking_version_id then
    raise exception '% identity columns are immutable', tg_table_name using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- Any change refreshes the draft package version's hash.
create function authz.b11_rehash_version() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.booking_versions v set content_hash = v.content_hash
  where v.id in (case when tg_op = 'INSERT' then null else old.booking_version_id end,
                 case when tg_op = 'DELETE' then null else new.booking_version_id end)
    and v.status = 'draft' and v.service_type = 'package';
  return null;
end;
$$;

-- Live identity rows: refresh every draft package version of the Deal.
create function authz.b11_rehash_deal() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.booking_versions v set content_hash = v.content_hash
  where v.deal_id in (case when tg_op = 'INSERT' then null else old.deal_id end,
                      case when tg_op = 'DELETE' then null else new.deal_id end)
    and v.status = 'draft' and v.service_type = 'package';
  return null;
end;
$$;

-- Plan rows are commercial: a change draws a new commercial_revision.
create function authz.b11_plan_revision() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.booking_versions v set commercial_revision = gen_random_uuid()
  where v.id in (case when tg_op = 'INSERT' then null else old.booking_version_id end,
                 case when tg_op = 'DELETE' then null else new.booking_version_id end)
    and v.status = 'draft';
  return null;
end;
$$;

create function authz.b11_touch() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger booking_version_contacts_a_guard
  before insert or update or delete on public.booking_version_contacts
  for each row execute function authz.b11_version_child_guard();
create trigger booking_version_contacts_a_touch before update on public.booking_version_contacts
  for each row execute function authz.b11_touch();
create trigger booking_version_contacts_b_rehash
  after insert or update or delete on public.booking_version_contacts
  for each row execute function authz.b11_rehash_version();

create trigger service_item_travellers_a_guard
  before insert or update or delete on public.service_item_travellers
  for each row execute function authz.b11_version_child_guard();
create trigger service_item_travellers_b_rehash
  after insert or update or delete on public.service_item_travellers
  for each row execute function authz.b11_rehash_version();

create trigger booking_version_instalments_a_guard
  before insert or update or delete on public.booking_version_instalments
  for each row execute function authz.b11_version_child_guard();
create trigger booking_version_instalments_b_revision
  after insert or update or delete on public.booking_version_instalments
  for each row execute function authz.b11_plan_revision();

create trigger traveller_identities_a_touch before update on public.traveller_identities
  for each row execute function authz.b11_touch();
create trigger traveller_identities_b_rehash
  after insert or update or delete on public.traveller_identities
  for each row execute function authz.b11_rehash_deal();

create trigger booking_version_traveller_identities_a_guard
  before update or delete on public.booking_version_traveller_identities
  for each row execute function authz.booking_version_travellers_guard();

-- Replaces 20261004000100: list price and discount changes draw a new
-- commercial_revision too (the plan is handled by its own trigger).
create or replace function authz.booking_commercials_rehash() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.selling_total_paise = old.selling_total_paise
     -- B1.1
     and new.list_price_paise is not distinct from old.list_price_paise
     and new.discount_paise is not distinct from old.discount_paise then
    return null;
  end if;
  update public.booking_versions v set commercial_revision = gen_random_uuid()
  where v.id = case when tg_op = 'DELETE' then old.version_id else new.version_id end
    and v.status = 'draft';
  return null;
end;
$$;

-- Package hash of a booking_versions row (the trigger passes NEW).
-- hash_schema 1: exactly the B1 formula (20261118000100 booking_package_hash);
--   a version that is no longer a draft reads its traveller snapshot (E13).
-- hash_schema 2: adds participation, traveller extras, identities, trip and
--   contacts. Live rows while draft, snapshots afterwards. The plan and
--   list/discount are covered by commercial_revision.
create function authz.booking_package_hash_row(v public.booking_versions) returns text
language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(case when v.hash_schema = 1 then jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_array(i.item_no, i.service_type, f.facts, f.purchase_budget_paise) order by i.item_no)
      from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
      where f.booking_version_id = v.id), '[]'::jsonb),
    'travellers', case when v.status = 'draft' then coalesce((
        select jsonb_agg(jsonb_build_array(t.seq, t.full_name, t.traveller_type) order by t.seq)
        from public.deal_travellers t where t.deal_id = v.deal_id), '[]'::jsonb)
      else coalesce((
        select jsonb_agg(jsonb_build_array(s.seq, s.full_name, s.traveller_type) order by s.seq)
        from public.booking_version_travellers s where s.booking_version_id = v.id), '[]'::jsonb) end,
    'commercial_revision', v.commercial_revision,
    'stored_evidence', authz.booking_stored_evidence(v.id)
  ) else jsonb_build_object(
    'schema', 2,
    'items', coalesce((
      select jsonb_agg(jsonb_build_array(i.item_no, i.service_type, f.facts, f.purchase_budget_paise,
        coalesce((select jsonb_agg(p.traveller_seq order by p.traveller_seq) from public.service_item_travellers p
                  where p.booking_version_id = v.id and p.service_item_id = i.id), '[]'::jsonb)) order by i.item_no)
      from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
      where f.booking_version_id = v.id), '[]'::jsonb),
    'travellers', case when v.status = 'draft' then coalesce((
        select jsonb_agg(jsonb_build_array(t.seq, t.full_name, t.traveller_type, t.age_years, t.special_needs) order by t.seq)
        from public.deal_travellers t where t.deal_id = v.deal_id), '[]'::jsonb)
      else coalesce((
        select jsonb_agg(jsonb_build_array(s.seq, s.full_name, s.traveller_type, s.age_years, s.special_needs) order by s.seq)
        from public.booking_version_travellers s where s.booking_version_id = v.id), '[]'::jsonb) end,
    'identities', case when v.status = 'draft' then coalesce((
        select jsonb_agg(jsonb_build_array(t.seq, x.date_of_birth, x.nationality, x.passport_number, x.passport_expiry) order by t.seq)
        from public.traveller_identities x join public.deal_travellers t on t.id = x.traveller_id
        where t.deal_id = v.deal_id
          -- Review A1: only travellers whose identity the trip needs (participants of a visa or
          -- passport item, or of a flight item on an international trip); the snapshot holds the same.
          and t.seq in (select p.traveller_seq from public.service_item_travellers p
                        join public.service_items i on i.id = p.service_item_id
                        where p.booking_version_id = v.id
                          and (i.service_type in ('visa', 'passport') or (i.service_type = 'flight' and v.trip_scope = 'international')))),
        '[]'::jsonb)
      else coalesce((
        select jsonb_agg(jsonb_build_array(s.seq, s.date_of_birth, s.nationality, s.passport_number, s.passport_expiry) order by s.seq)
        from public.booking_version_traveller_identities s where s.booking_version_id = v.id), '[]'::jsonb) end,
    'trip', jsonb_build_array(v.trip_destination, v.trip_scope, v.trip_start, v.trip_end),
    'contacts', (select jsonb_build_array(c.contact_name, c.mobile, c.email, c.contact_confirmed, c.booking_for,
                   c.payer_different, c.payer_name)
                 from public.booking_version_contacts c where c.booking_version_id = v.id),
    'commercial_revision', v.commercial_revision,
    'stored_evidence', authz.booking_stored_evidence(v.id)
  ) end::text, 'UTF8')), 'hex')
$$;

-- Replaces 20261118000100: package versions use booking_package_hash_row.
create or replace function authz.booking_versions_hash() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.service_type = 'package' then
    new.content_hash := authz.booking_package_hash_row(new);
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
    then authz.booking_package_hash_row(v)
    else authz.booking_hash(v.hotel_name, v.city, v.check_in, v.check_out, v.rooms, v.room_type,
      v.meal_plan, v.adults, v.children, v.inclusions, v.special_requests, v.purchase_budget_paise,
      v.commercial_revision, authz.booking_stored_evidence(v.id)) end
  from public.booking_versions v
  where v.id = p_version
$$;

-- Existing draft package versions follow the B1.1 formula (their hash
-- changes; drafts are optimistic, the next save reloads). Confirmed rows stay 1.
update public.booking_versions v set hash_schema = 2
where v.service_type = 'package' and v.status = 'draft';
alter table public.booking_versions alter column hash_schema set default 2;

-- Replaces 20261004000100: hash_schema joins the identity columns.
create or replace function authz.booking_versions_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'confirmed' then
      raise exception 'confirmed booking versions are immutable' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if old.status = 'confirmed' then
      raise exception 'confirmed booking versions are immutable' using errcode = '42501';
    end if;
    if new.id is distinct from old.id or new.deal_id is distinct from old.deal_id
       or new.legal_entity_id is distinct from old.legal_entity_id
       or new.branch_id is distinct from old.branch_id or new.version_no is distinct from old.version_no
       or new.service_type is distinct from old.service_type or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at
       -- B1.1
       or new.hash_schema is distinct from old.hash_schema then
      raise exception 'booking version identity columns are immutable' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- Participation of existing draft package versions: every traveller on every
-- item (the form's default). Confirmed versions get none (readers treat no
-- rows on a confirmed version as "all snapshot travellers").
insert into public.service_item_travellers (booking_version_id, service_item_id, legal_entity_id, traveller_seq)
select f.booking_version_id, f.service_item_id, f.legal_entity_id, t.seq
from public.service_item_facts f
join public.booking_versions v on v.id = f.booking_version_id and v.status = 'draft' and v.service_type = 'package'
join public.deal_travellers t on t.deal_id = v.deal_id;

do $$
declare
  v_expected integer;
  v_actual integer;
begin
  select count(*) into v_expected
  from public.service_item_facts f
  join public.booking_versions v on v.id = f.booking_version_id and v.status = 'draft' and v.service_type = 'package'
  join public.deal_travellers t on t.deal_id = v.deal_id;
  select count(*) into v_actual from public.service_item_travellers;
  if v_actual <> v_expected then
    raise exception 'B1.1 backfill: % participation rows, expected %', v_actual, v_expected using errcode = '55000';
  end if;
  if exists (select 1 from public.booking_versions v where v.service_type = 'package' and v.status = 'confirmed'
             and v.hash_schema <> 1) then
    raise exception 'B1.1 backfill: a confirmed package version changed hash schema' using errcode = '55000';
  end if;
end;
$$;

-- ===========================================================================
-- 4. Authorization and lookup helpers
-- ===========================================================================

-- Replaces 20261118000100: booking readers who hold none of the department
-- roles (purchase, flight, visa).
create or replace function authz.can_read_service_rows(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.can_read_booking(p_deal) and exists (
    select 1 from public.deals d
    where d.id = p_deal and not authz.holds_role('flight', d.legal_entity_id)
      -- B1.1
      and not authz.holds_role('visa', d.legal_entity_id)
  )
$$;

-- Contacts and the payment plan: the same readers (Sales, Manager, booking
-- readers); never a department role. Accounts reads them through the
-- finance reads.
create function authz.can_read_contacts(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.can_read_service_rows(p_deal)
$$;

-- Replaces 20261118000100: department roles include visa.
create or replace function authz.deal_services_scope(p_deal uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select case
    when authz.holds_role('purchase', d.legal_entity_id) or authz.holds_role('flight', d.legal_entity_id)
         or authz.holds_role('visa', d.legal_entity_id) then
      array_remove(array[
        case when authz.holds_active_role('purchase', d.legal_entity_id) then 'purchase' end,
        case when authz.holds_active_role('flight', d.legal_entity_id) then 'flight' end,
        case when authz.holds_active_role('visa', d.legal_entity_id) then 'visa' end], null)
    when authz.can_read_booking(p_deal) then null
    else '{}'::text[] end
  from public.deals d where d.id = p_deal
$$;

-- The Deal's accepted version in force (status confirmed), else null.
create function authz.current_accepted_version(p_deal uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select v.id from public.booking_versions v where v.deal_id = p_deal and v.status = 'confirmed'
$$;

-- The one gate for reading a traveller's identity data (review A5): booking
-- editors and acceptors (Sales owner/assignee, branch Manager) and the
-- assignee of an open Flight task on an international trip whose flight
-- the traveller takes. 20261119000500 adds the assigned Visa desk person.
-- Never Purchase, Accounts or Super Admin by this rule.
create function authz.can_read_traveller_identity(p_deal uuid, p_seq integer) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_seq is not null and (
    authz.can_edit_booking_draft(p_deal) or authz.can_confirm_booking(p_deal)
    or exists (
      select 1 from public.fulfilment_tasks t
      join public.booking_versions v on v.id = t.booking_version_id
      where t.deal_id = p_deal and t.department = 'flight' and t.status = 'in_progress'
        and t.assignee_user_id = (select auth.uid()) and authz.holds_active_role('flight', t.legal_entity_id)
        and v.trip_scope = 'international'
        and exists (select 1 from public.service_item_travellers p
                    where p.service_item_id = t.service_item_id and p.traveller_seq = p_seq
                      and p.booking_version_id = (select c.id from public.booking_versions c
                                                  where c.deal_id = p_deal and c.status = 'confirmed'))))
$$;

-- Traveller seqs taking part in an item inside a version. A confirmed version
-- without participation rows (confirmed under B1) means every snapshot traveller.
create function authz.item_participant_seqs(p_item uuid, p_version uuid) returns integer[]
language sql stable security definer set search_path = '' as $$
  select case
    when exists (select 1 from public.service_item_travellers p
                 where p.booking_version_id = p_version and p.service_item_id = p_item)
      then (select array_agg(p.traveller_seq order by p.traveller_seq) from public.service_item_travellers p
            where p.booking_version_id = p_version and p.service_item_id = p_item)
    when exists (select 1 from public.booking_versions v where v.id = p_version and v.status <> 'draft')
      then coalesce((select array_agg(s.seq order by s.seq) from public.booking_version_travellers s
                     where s.booking_version_id = p_version), '{}'::integer[])
    else '{}'::integer[] end
$$;

-- Identity JSON of a traveller seq: live row (null version or draft) or snapshot.
create function authz.booking_identity_json(p_deal uuid, p_seq integer, p_version uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case
    when p_version is not null and exists (select 1 from public.booking_versions v where v.id = p_version and v.status <> 'draft')
      then (select jsonb_build_object('dateOfBirth', to_char(s.date_of_birth, 'YYYY-MM-DD'), 'nationality', s.nationality,
              'passportNumber', s.passport_number, 'passportExpiry', to_char(s.passport_expiry, 'YYYY-MM-DD'), 'rowVersion', null)
            from public.booking_version_traveller_identities s where s.booking_version_id = p_version and s.seq = p_seq)
    else (select jsonb_build_object('dateOfBirth', to_char(x.date_of_birth, 'YYYY-MM-DD'), 'nationality', x.nationality,
            'passportNumber', x.passport_number, 'passportExpiry', to_char(x.passport_expiry, 'YYYY-MM-DD'), 'rowVersion', x.row_version)
          from public.traveller_identities x join public.deal_travellers t on t.id = x.traveller_id
          where t.deal_id = p_deal and t.seq = p_seq) end
$$;

-- Seqs whose identity is needed (participants of a visa or passport item, or
-- of a flight item on an international trip) on a version.
create function authz.b11_identity_needed_seqs(p_version uuid) returns integer[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct s order by s), '{}'::integer[])
  from public.service_item_facts f
  join public.service_items i on i.id = f.service_item_id
  join public.booking_versions v on v.id = f.booking_version_id
  cross join lateral unnest(authz.item_participant_seqs(i.id, v.id)) as s
  where f.booking_version_id = p_version
    and (i.service_type in ('visa', 'passport') or (i.service_type = 'flight' and v.trip_scope = 'international'))
$$;

-- Identity fields of a seq on a version: live for drafts, snapshot otherwise.
create function authz.b11_identity_row(p_version uuid, p_seq integer)
returns table (date_of_birth date, nationality text, passport_number text, passport_expiry date)
language sql stable security definer set search_path = '' as $$
  select x.date_of_birth, x.nationality, x.passport_number, x.passport_expiry
  from public.booking_versions v
  join public.deal_travellers t on t.deal_id = v.deal_id and t.seq = p_seq
  join public.traveller_identities x on x.traveller_id = t.id
  where v.id = p_version and v.status = 'draft'
  union all
  select s.date_of_birth, s.nationality, s.passport_number, s.passport_expiry
  from public.booking_versions v
  join public.booking_version_traveller_identities s on s.booking_version_id = v.id and s.seq = p_seq
  where v.id = p_version and v.status <> 'draft'
$$;

-- Needed seqs without date of birth or nationality.
create function authz.b11_identity_missing_seqs(p_version uuid) returns integer[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(s order by s), '{}'::integer[])
  from unnest(authz.b11_identity_needed_seqs(p_version)) as s
  where not exists (select 1 from authz.b11_identity_row(p_version, s) r
                    where r.date_of_birth is not null and r.nationality is not null)
$$;

-- Item numbers of a version's items without participants.
create function authz.b11_participation_missing_nos(p_version uuid) returns integer[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(i.item_no order by i.item_no), '{}'::integer[])
  from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
  where f.booking_version_id = p_version and cardinality(authz.item_participant_seqs(i.id, p_version)) = 0
$$;

-- A valid ISO date between two bounds, else null.
create function authz.b11_date(p_value jsonb, p_min date, p_max date) returns date
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
  if to_char(v_date, 'YYYY-MM-DD') <> v_text or v_date not between p_min and p_max then
    return null;
  end if;
  return v_date;
end;
$$;

-- Boolean field (absent or null -> p_default; non-boolean -> null = invalid).
create function authz.b11_bool(p_value jsonb, p_default boolean) returns boolean
language sql immutable set search_path = '' as $$
  select case when p_value is null or jsonb_typeof(p_value) = 'null' then p_default
              when jsonb_typeof(p_value) = 'boolean' then (p_value #>> '{}')::boolean end
$$;

-- Trimmed text or null (absent, JSON null, blank).
create function authz.b11_text(p_value jsonb) returns text
language sql immutable set search_path = '' as $$
  select case when p_value is not null and jsonb_typeof(p_value) = 'string'
              then nullif(btrim(p_value #>> '{}', E' \t\r\n'), '') end
$$;

-- Unknown keys of a JSON object (empty = none).
create function authz.b11_unknown_keys(p_object jsonb, p_allowed text[]) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(k order by k), '{}'::text[])
  from jsonb_object_keys(case when jsonb_typeof(p_object) = 'object' then p_object else '{}'::jsonb end) k
  where k <> all (p_allowed)
$$;

revoke all on function authz.can_read_contacts(uuid), authz.current_accepted_version(uuid),
  authz.can_read_traveller_identity(uuid, integer), authz.item_participant_seqs(uuid, uuid),
  authz.booking_identity_json(uuid, integer, uuid), authz.b11_identity_needed_seqs(uuid),
  authz.b11_identity_row(uuid, integer), authz.b11_identity_missing_seqs(uuid),
  authz.b11_participation_missing_nos(uuid), authz.b11_date(jsonb, date, date), authz.b11_bool(jsonb, boolean),
  authz.b11_text(jsonb), authz.b11_unknown_keys(jsonb, text[]), authz.booking_package_hash_row(public.booking_versions)
from public, anon, authenticated, service_role;
grant execute on function authz.can_read_contacts(uuid) to authenticated;

-- ===========================================================================
-- 5. Facts validation (replaces 20261118000100; same signature)
-- ===========================================================================

-- Flight leg place: an IATA code or a place name.
create function authz.b11_place_ok(p_value jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select p_value is not null and jsonb_typeof(p_value) = 'string'
    and ((p_value #>> '{}') ~ '^[A-Z]{3}$' or (p_value #>> '{}') ~ '^[A-Za-z][A-Za-z .''-]{1,59}$')
$$;
revoke all on function authz.b11_place_ok(jsonb) from public, anon, authenticated, service_role;

create or replace function authz.validate_service_facts(p_type text, p_facts jsonb) returns text[]
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
  v_mode text;
  v_ages jsonb;
begin
  -- B1.1: visa and passport.
  if p_type is null or p_type not in ('hotel', 'transfer', 'activity', 'flight', 'visa', 'passport') then
    return array['type'];
  end if;
  if p_facts is null or jsonb_typeof(p_facts) <> 'object' then
    return array['facts'];
  end if;
  v_allowed := case p_type
    when 'hotel' then array['hotelName', 'city', 'checkIn', 'checkOut', 'rooms', 'adults', 'roomType', 'mealPlan',
                            'children', 'inclusions', 'specialRequests',
                            'mode', 'preferences', 'area', 'childAges', 'exclusions']
    when 'transfer' then array['route', 'date', 'vehicleType', 'passengers', 'pickupTime', 'notes', 'pickup', 'drop']
    when 'activity' then array['name', 'city', 'date', 'participants', 'time', 'notes', 'inclusions']
    when 'flight' then array['segments', 'passengers', 'preferredTime', 'cabin', 'notes', 'tripType', 'preferences', 'assistance']
    when 'visa' then array['country', 'purpose', 'travelDate', 'applyBy', 'feePaidBy', 'notes']
    else array['applicationType', 'officeCity', 'neededBy', 'notes'] end;
  for v_key in select k from jsonb_object_keys(p_facts) k loop
    if v_key <> all (v_allowed) then
      v_bad := v_bad || v_key;
    end if;
  end loop;

  if p_type = 'hotel' then
    v_mode := case when jsonb_typeof(p_facts -> 'mode') = 'string' then p_facts ->> 'mode' end;
    if p_facts ? 'mode' and jsonb_typeof(p_facts -> 'mode') <> 'null'
       and (v_mode is null or v_mode not in ('specific', 'preferences')) then
      v_bad := v_bad || 'mode'::text;
    end if;
    -- mode absent or 'specific': a named hotel (B1 rule); 'preferences': the
    -- acceptable options instead.
    if not authz.sf_text_ok(p_facts -> 'hotelName', 200, coalesce(v_mode, 'specific') <> 'preferences') then
      v_bad := v_bad || 'hotelName'::text;
    end if;
    if not authz.sf_text_ok(p_facts -> 'preferences', 2000, coalesce(v_mode = 'preferences', false)) then
      v_bad := v_bad || 'preferences'::text;
    end if;
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
    if not authz.sf_text_ok(p_facts -> 'area', 120, false) then v_bad := v_bad || 'area'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'exclusions', 2000, false) then v_bad := v_bad || 'exclusions'::text; end if;
    v_ages := p_facts -> 'childAges';
    if v_ages is not null and jsonb_typeof(v_ages) <> 'null' and (
         jsonb_typeof(v_ages) <> 'array'
         or jsonb_array_length(v_ages) <> coalesce(authz.sf_int_value(p_facts -> 'children'), 0)
         or exists (select 1 from jsonb_array_elements(v_ages) a where not authz.sf_int_ok(a, 0, 17, true))) then
      v_bad := v_bad || 'childAges'::text;
    end if;
  elsif p_type = 'transfer' then
    -- B1.1: route optional when pickup and drop are given; vehicle type and
    -- passengers optional (plan section 3f).
    if not authz.sf_text_ok(p_facts -> 'route', 200,
         not (authz.sf_text_ok(p_facts -> 'pickup', 200, true) and authz.sf_text_ok(p_facts -> 'drop', 200, true))) then
      v_bad := v_bad || 'route'::text;
    end if;
    if not authz.sf_text_ok(p_facts -> 'pickup', 200, false) then v_bad := v_bad || 'pickup'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'drop', 200, false) then v_bad := v_bad || 'drop'::text; end if;
    if authz.sf_date(p_facts -> 'date') is null then v_bad := v_bad || 'date'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'vehicleType', 60, false) then v_bad := v_bad || 'vehicleType'::text; end if;
    if not authz.sf_int_ok(p_facts -> 'passengers', 1, 100, false) then v_bad := v_bad || 'passengers'::text; end if;
    if not authz.sf_time_ok(p_facts -> 'pickupTime', false) then v_bad := v_bad || 'pickupTime'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'notes', 2000, false) then v_bad := v_bad || 'notes'::text; end if;
  elsif p_type = 'activity' then
    if not authz.sf_text_ok(p_facts -> 'name', 200, true) then v_bad := v_bad || 'name'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'city', 120, true) then v_bad := v_bad || 'city'::text; end if;
    if authz.sf_date(p_facts -> 'date') is null then v_bad := v_bad || 'date'::text; end if;
    if not authz.sf_int_ok(p_facts -> 'participants', 1, 100, true) then v_bad := v_bad || 'participants'::text; end if;
    if not authz.sf_time_ok(p_facts -> 'time', false) then v_bad := v_bad || 'time'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'notes', 2000, false) then v_bad := v_bad || 'notes'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'inclusions', 2000, false) then v_bad := v_bad || 'inclusions'::text; end if;
  elsif p_type = 'flight' then
    if p_facts -> 'segments' is null or jsonb_typeof(p_facts -> 'segments') <> 'array'
       or jsonb_array_length(p_facts -> 'segments') not between 1 and 8 then
      v_seg_ok := false;
    else
      for v_seg in select s from jsonb_array_elements(p_facts -> 'segments') s loop
        v_n := v_n + 1;
        -- B1.1: IATA code or place name; optional flexibility per leg.
        if jsonb_typeof(v_seg) <> 'object'
           or exists (select 1 from jsonb_object_keys(v_seg) k where k not in ('from', 'to', 'date', 'flex'))
           or not authz.b11_place_ok(v_seg -> 'from') or not authz.b11_place_ok(v_seg -> 'to')
           or not authz.sf_text_ok(v_seg -> 'flex', 60, false) then
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
    if p_facts ? 'tripType' and jsonb_typeof(p_facts -> 'tripType') <> 'null'
       and (jsonb_typeof(p_facts -> 'tripType') <> 'string'
            or (p_facts ->> 'tripType') not in ('one_way', 'return', 'multi_city')) then
      v_bad := v_bad || 'tripType'::text;
    end if;
    if not authz.sf_text_ok(p_facts -> 'preferences', 500, false) then v_bad := v_bad || 'preferences'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'assistance', 500, false) then v_bad := v_bad || 'assistance'::text; end if;
  elsif p_type = 'visa' then
    if not authz.sf_text_ok(p_facts -> 'country', 60, true) then v_bad := v_bad || 'country'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'purpose', 60, true) then v_bad := v_bad || 'purpose'::text; end if;
    if authz.sf_date(p_facts -> 'travelDate') is null then v_bad := v_bad || 'travelDate'::text; end if;
    if p_facts ? 'applyBy' and jsonb_typeof(p_facts -> 'applyBy') <> 'null'
       and (authz.sf_date(p_facts -> 'applyBy') is null
            or (authz.sf_date(p_facts -> 'travelDate') is not null
                and authz.sf_date(p_facts -> 'applyBy') > authz.sf_date(p_facts -> 'travelDate'))) then
      v_bad := v_bad || 'applyBy'::text;
    end if;
    if jsonb_typeof(p_facts -> 'feePaidBy') is distinct from 'string'
       or (p_facts ->> 'feePaidBy') not in ('customer', 'company', 'not_decided') then
      v_bad := v_bad || 'feePaidBy'::text;
    end if;
    if not authz.sf_text_ok(p_facts -> 'notes', 2000, false) then v_bad := v_bad || 'notes'::text; end if;
  else
    if jsonb_typeof(p_facts -> 'applicationType') is distinct from 'string'
       or (p_facts ->> 'applicationType') not in ('fresh', 'renewal', 'tatkaal', 'minor') then
      v_bad := v_bad || 'applicationType'::text;
    end if;
    if not authz.sf_text_ok(p_facts -> 'officeCity', 120, true) then v_bad := v_bad || 'officeCity'::text; end if;
    if p_facts ? 'neededBy' and jsonb_typeof(p_facts -> 'neededBy') <> 'null' and authz.sf_date(p_facts -> 'neededBy') is null then
      v_bad := v_bad || 'neededBy'::text;
    end if;
    if not authz.sf_text_ok(p_facts -> 'notes', 2000, false) then v_bad := v_bad || 'notes'::text; end if;
  end if;
  return v_bad;
end;
$$;

-- Replaces 20261118000100: titles for visa, passport, pickup/drop transfers
-- and preference-mode hotels.
create or replace function authz.service_item_title(p_type text, p_facts jsonb) returns text
language sql immutable set search_path = '' as $$
  select case p_type
    when 'hotel' then concat_ws(' · ', coalesce(nullif(p_facts ->> 'hotelName', ''), nullif(left(p_facts ->> 'preferences', 60), '')),
                                nullif(p_facts ->> 'city', ''))
    when 'transfer' then coalesce(nullif(p_facts ->> 'route', ''),
                                  nullif(concat_ws(' to ', nullif(p_facts ->> 'pickup', ''), nullif(p_facts ->> 'drop', '')), ''))
    when 'activity' then concat_ws(' · ', nullif(p_facts ->> 'name', ''), nullif(p_facts ->> 'city', ''))
    when 'visa' then concat_ws(' · ', nullif(p_facts ->> 'country', ''), nullif(p_facts ->> 'purpose', ''))
    when 'passport' then concat_ws(' · ', nullif(initcap(p_facts ->> 'applicationType'), ''), nullif(p_facts ->> 'officeCity', ''))
    else (select string_agg(concat_ws(' to ', s ->> 'from', s ->> 'to'), ', ')
          from jsonb_array_elements(case when jsonb_typeof(p_facts -> 'segments') = 'array'
                                         then p_facts -> 'segments' else '[]'::jsonb end) s)
  end
$$;

-- Replaces 20261118000100: visa and passport need no head count (participation
-- drives them); missing transfer passengers count as 0.
create or replace function authz.service_item_travellers_needed(p_type text, p_facts jsonb) returns integer
language sql stable set search_path = '' as $$
  select case p_type
    when 'hotel' then coalesce(authz.sf_int_value(p_facts -> 'adults'), 0) + coalesce(authz.sf_int_value(p_facts -> 'children'), 0)
    when 'transfer' then coalesce(authz.sf_int_value(p_facts -> 'passengers'), 0)
    when 'activity' then coalesce(authz.sf_int_value(p_facts -> 'participants'), 0)
    when 'flight' then coalesce(authz.sf_int_value(p_facts -> 'passengers'), 0)
    else 0
  end
$$;

-- ===========================================================================
-- 6. Row level security and grants for the new tables
-- ===========================================================================

alter table public.booking_version_contacts enable row level security;
alter table public.traveller_identities enable row level security;
alter table public.booking_version_traveller_identities enable row level security;
alter table public.service_item_travellers enable row level security;
alter table public.booking_version_instalments enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'booking_version_contacts', 'traveller_identities', 'booking_version_traveller_identities',
    'service_item_travellers', 'booking_version_instalments'
  ] loop
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
  end loop;
end;
$$;

create policy scoped_read on public.booking_version_contacts
  for select to authenticated using (authz.can_read_contacts(deal_id));
create policy scoped_read on public.service_item_travellers
  for select to authenticated using (exists (
    select 1 from public.service_items i where i.id = service_item_id and authz.can_read_service_rows(i.deal_id)));
create policy scoped_read on public.booking_version_instalments
  for select to authenticated using (authz.can_read_contacts(deal_id) and authz.can_read_booking_commercial(booking_version_id));
-- traveller_identities and booking_version_traveller_identities: no permissive
-- policy and no privilege at all (definer functions only).

revoke all on public.booking_version_contacts, public.traveller_identities, public.booking_version_traveller_identities,
  public.service_item_travellers, public.booking_version_instalments
from public, anon, authenticated, service_role;
grant select on public.booking_version_contacts, public.service_item_travellers, public.booking_version_instalments
to authenticated, service_role;

-- ===========================================================================
-- 7. Readiness (replaces 20261118000100 authz.booking_issues)
-- ===========================================================================

create or replace function authz.booking_issues(p_version uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select case when v.service_type = 'package' then array_remove(array[
    case when not authz.deal_in_trigger_stage(d.id) then 'stage_not_confirmed' end,
    case when not exists (select 1 from public.service_item_facts f where f.booking_version_id = v.id) then 'no_services' end,
    case when cardinality(authz.service_item_invalid_nos(v.id)) > 0 then 'service_facts_invalid' end,
    -- B1.1: customer and billing.
    case when not exists (select 1 from public.booking_version_contacts c where c.booking_version_id = v.id)
      then 'contact_missing' end,
    case when exists (select 1 from public.booking_version_contacts c where c.booking_version_id = v.id and not c.contact_confirmed)
      then 'contact_not_confirmed' end,
    case when not exists (select 1 from public.customer_billing_profiles b where b.deal_id = d.id) then 'billing_missing' end,
    case when exists (select 1 from public.booking_version_contacts c
                      join public.customer_billing_profiles b on b.deal_id = d.id
                      where c.booking_version_id = v.id and c.booking_for = 'business' and b.gstin is null)
      then 'gstin_missing' end,
    -- B1.1: trip.
    case when v.trip_destination is null or v.trip_scope is null or v.trip_start is null or v.trip_end is null
      then 'trip_missing' end,
    case when authz.version_travellers_needed(v.id) > 0
          and not exists (select 1 from public.deal_travellers t where t.deal_id = d.id) then 'traveller_missing' end,
    case when exists (select 1 from public.deal_travellers t where t.deal_id = d.id)
          and (select count(*) from public.deal_travellers t where t.deal_id = d.id) < authz.version_travellers_needed(v.id)
          then 'traveller_count_mismatch' end,
    -- B1.1: travellers, participation, identity.
    case when exists (select 1 from public.deal_travellers t
                      where t.deal_id = d.id and t.traveller_type in ('child', 'infant') and t.age_years is null)
      then 'child_age_missing' end,
    case when cardinality(authz.b11_participation_missing_nos(v.id)) > 0 then 'participation_missing' end,
    case when cardinality(authz.b11_identity_missing_seqs(v.id)) > 0 then 'identity_missing' end,
    case when not exists (select 1 from public.booking_version_commercials c where c.version_id = v.id)
      then 'missing_selling_total' end,
    -- B1.1: payment plan (DEC-29).
    case when not exists (select 1 from public.booking_version_instalments p where p.booking_version_id = v.id)
      then 'plan_missing' end,
    case when exists (select 1 from public.booking_version_instalments p where p.booking_version_id = v.id)
          and exists (select 1 from public.booking_version_commercials c where c.version_id = v.id)
          and (select sum(p.amount_paise) from public.booking_version_instalments p where p.booking_version_id = v.id)
              <> (select c.selling_total_paise from public.booking_version_commercials c where c.version_id = v.id)
      then 'plan_total_mismatch' end,
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

-- Replaces 20261004000100: without commercial scope the selling-total and
-- plan items become "ask the owner".
create or replace function authz.booking_issues_for_viewer(p_version uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select case when authz.can_read_deal_commercial(v.deal_id) then authz.booking_issues(v.id)
              else array_replace(array_replace(array_replace(authz.booking_issues(v.id),
                     'missing_selling_total', 'missing_selling_total_ask_owner'),
                     -- B1.1
                     'plan_missing', 'plan_ask_owner'), 'plan_total_mismatch', 'plan_ask_owner')
         end
  from public.booking_versions v where v.id = p_version
$$;

-- ===========================================================================
-- 8. JSON shapes (replaced from 20261118000100)
-- ===========================================================================

-- ServiceItemView. B1.1: nextStep waiting_for_desk_launch for an accepted
-- visa/passport item without a task.
create or replace function authz.service_item_json(p_item uuid, p_version uuid, p_with_budget boolean) returns jsonb
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
      -- B1.1
      when t.id is null and i.state = 'active' and i.service_type in ('visa', 'passport') then 'waiting_for_desk_launch'
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

-- DealProgress. B1.1: accepted visa/passport items without a task are
-- waitingForLaunch (outstanding, never fulfilled), need desk_launch.
create or replace function authz.deal_progress_json(p_deal uuid, p_departments text[]) returns jsonb
language sql stable security definer set search_path = '' as $$
  with items as (
    select i.id, i.state, i.service_type, t.status
    from public.service_items i
    left join public.fulfilment_tasks t on t.service_item_id = i.id
    where i.deal_id = p_deal and i.state <> 'cancelled'
      and (p_departments is null or i.department = any (p_departments))
  ), counts as (
    select count(*) as total,
      count(*) filter (where status is null and not (state = 'active' and service_type in ('visa', 'passport'))) as planned,
      count(*) filter (where status is null and state = 'active' and service_type in ('visa', 'passport')) as waiting,
      count(*) filter (where status = 'not_started') as not_started,
      count(*) filter (where status = 'in_progress') as in_progress,
      count(*) filter (where status = 'supplier_confirmed') as supplier_confirmed
    from items
  )
  select jsonb_build_object(
    'total', c.total,
    'byState', jsonb_build_object('planned', c.planned, 'waitingForLaunch', c.waiting, 'notStarted', c.not_started,
      'inProgress', c.in_progress, 'supplierConfirmed', c.supplier_confirmed),
    'fulfilled', c.total > 0 and c.supplier_confirmed = c.total,
    'staleCount', 0,
    'needs', (select coalesce(jsonb_agg(n.step order by n.ord), '[]'::jsonb) from (values
      ('confirm_version', 1), ('waiting_for_desk_launch', 2), ('take_task', 3), ('supplier_confirmation', 4)) as n(step, ord)
      where (n.step = 'confirm_version' and c.planned > 0)
         or (n.step = 'waiting_for_desk_launch' and c.waiting > 0)
         or (n.step = 'take_task' and c.not_started > 0)
         or (n.step = 'supplier_confirmation' and c.in_progress > 0)))
  from counts c
$$;

-- DealServicesView. B1.1: trip on the version; full-scope travellers carry
-- age, special needs and an identity status (never values); full-scope items
-- carry their participants.
create or replace function authz.deal_services_json(p_deal uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_scope text[];
  v_ver public.booking_versions;
  v_items jsonb;
  v_full boolean;
  v_needed integer[];
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
  select coalesce(jsonb_agg(authz.service_item_json(i.id, v_ver.id, v_full or i.department = any (v_scope))
           || case when v_full then jsonb_build_object('participants',
                to_jsonb(authz.item_participant_seqs(i.id, v_ver.id))) else '{}'::jsonb end
           order by i.item_no), '[]'::jsonb)
  into v_items
  from public.service_items i
  where i.deal_id = p_deal and (v_full or i.department = any (v_scope));
  if v_full and v_ver.id is not null then
    v_needed := authz.b11_identity_needed_seqs(v_ver.id);
  end if;
  return jsonb_build_object(
    'dealId', p_deal,
    'version', case when v_ver.id is null then null else jsonb_build_object(
      'versionId', v_ver.id, 'versionNo', v_ver.version_no, 'status', v_ver.status, 'rowVersion', v_ver.row_version,
      'contentHash', v_ver.content_hash, 'serviceType', v_ver.service_type,
      -- B1.1
      'trip', jsonb_build_object('destination', v_ver.trip_destination, 'scope', v_ver.trip_scope,
        'start', to_char(v_ver.trip_start, 'YYYY-MM-DD'), 'end', to_char(v_ver.trip_end, 'YYYY-MM-DD'))) end,
    'items', v_items,
    'progress', authz.deal_progress_json(p_deal, v_scope),
    'canEdit', v_full and coalesce(v_ver.status, 'draft') = 'draft' and authz.can_edit_booking_draft(p_deal),
    'canConfirm', v_full and v_ver.status = 'draft' and authz.can_confirm_booking(p_deal))
  || case when v_full then jsonb_build_object('travellers', coalesce((
       select jsonb_agg(jsonb_build_object('fullName', t.full_name, 'type', t.traveller_type, 'seq', t.seq,
           -- B1.1
           'ageYears', t.age_years, 'specialNeeds', t.special_needs,
           'identityStatus', case
             when not (t.seq = any (coalesce(v_needed, '{}'::integer[]))) then 'not_needed'
             when x.traveller_id is null or (x.date_of_birth is null and x.nationality is null) then 'missing'
             when x.date_of_birth is null or x.nationality is null or x.passport_number is null or x.passport_expiry is null then 'partial'
             else 'complete' end)
         order by t.seq)
       from public.deal_travellers t
       left join public.traveller_identities x on x.traveller_id = t.id
       where t.deal_id = p_deal), '[]'::jsonb))
     else '{}'::jsonb end;
end;
$$;

-- Participants of a task's item for department detail views: name, type,
-- age and special needs (freeze note 3.1); identity fields only when
-- p_identity (Flight assignee on an international trip, the Visa desk assignee).
create function authz.task_participants_json(p_task uuid, p_identity boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('seq', s.seq, 'fullName', s.full_name, 'type', s.traveller_type,
      'ageYears', s.age_years, 'specialNeeds', s.special_needs)
    || case when p_identity and authz.can_read_traveller_identity(t.deal_id, s.seq) then coalesce((
         select jsonb_build_object('dateOfBirth', to_char(x.date_of_birth, 'YYYY-MM-DD'), 'nationality', x.nationality,
           'passportNumber', x.passport_number, 'passportExpiry', to_char(x.passport_expiry, 'YYYY-MM-DD'))
         from public.deal_travellers dt join public.traveller_identities x on x.traveller_id = dt.id
         where dt.deal_id = t.deal_id and dt.seq = s.seq),
         jsonb_build_object('dateOfBirth', null, 'nationality', null, 'passportNumber', null, 'passportExpiry', null))
       else '{}'::jsonb end
    order by s.seq), '[]'::jsonb)
  from public.fulfilment_tasks t
  join public.booking_version_travellers s on s.booking_version_id = t.booking_version_id
  where t.id = p_task
    and s.seq = any (authz.item_participant_seqs(t.service_item_id, t.booking_version_id))
$$;
revoke all on function authz.task_participants_json(uuid, boolean) from public, anon, authenticated, service_role;

-- Replaces 20261118000100: detail adds the item's participants (no identity).
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
    'canClaim', authz.can_claim_purchase_task(x.id) and x.assignee_user_id is null,
    -- B1.1
    'participants', authz.task_participants_json(x.id, false)
  ) else '{}'::jsonb end
  from x
  join public.booking_versions v on v.id = x.booking_version_id
  join public.deals d on d.id = x.deal_id
  join public.branches b on b.id = x.branch_id
  left join public.staff_profiles ap on ap.user_id = x.assignee_user_id
  left join public.staff_profiles cp on cp.user_id = v.confirmed_by
$$;

-- Replaces 20261118000100: detail adds participants; identity fields only for
-- the assignee on an international trip.
create or replace function authz.flight_task_json(p_task uuid, p_detail boolean) returns jsonb
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
    'travellerCount', (select count(*) from public.booking_version_travellers s where s.booking_version_id = v.id),
    -- B1.1
    'tripScope', v.trip_scope,
    'participants', authz.task_participants_json(t.id,
      t.assignee_user_id is not distinct from (select auth.uid()) and v.trip_scope = 'international')
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

-- ===========================================================================
-- 9. Commands
-- ===========================================================================

-- Replaces 20261118000100: also records who saved (booking_versions.updated_by).
create or replace function authz.bump_package_version(p_version_id uuid) returns public.booking_versions
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
begin
  update public.booking_versions v
  set row_version = v.row_version + 1, updated_at = now(),
      -- B1.1
      updated_by = (select auth.uid())
  where v.id = p_version_id
  returning * into v_ver;
  return v_ver;
end;
$$;

-- Contacts of a draft package version (validated, upserted). Returns the
-- changed field names. The caller has already locked and authorized.
create function authz.b11_contacts_write(p_ver public.booking_versions, p_fields jsonb) returns text[]
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_old public.booking_version_contacts%rowtype;
  v_bad text[];
  v_name text;
  v_mobile text;
  v_email text;
  v_confirmed boolean;
  v_for text;
  v_payer_diff boolean;
  v_payer text;
  v_by uuid;
  v_at timestamptz;
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'contact';
  end if;
  v_bad := authz.b11_unknown_keys(p_fields, array['contactName', 'mobile', 'email', 'contactConfirmed', 'bookingFor',
    'payerDifferent', 'payerName']);
  if not authz.sf_text_ok(p_fields -> 'contactName', 120, true) then v_bad := v_bad || 'contactName'::text; end if;
  v_name := authz.b11_text(p_fields -> 'contactName');
  v_mobile := regexp_replace(coalesce(authz.b11_text(p_fields -> 'mobile'), ''), '[ -]', '', 'g');
  v_mobile := nullif(v_mobile, '');
  if (p_fields ? 'mobile' and jsonb_typeof(p_fields -> 'mobile') not in ('string', 'null'))
     or (v_mobile is not null and v_mobile !~ '^[6-9][0-9]{9}$') then
    v_bad := v_bad || 'mobile'::text;
  end if;
  v_email := lower(authz.b11_text(p_fields -> 'email'));
  if (p_fields ? 'email' and jsonb_typeof(p_fields -> 'email') not in ('string', 'null'))
     or (v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')) then
    v_bad := v_bad || 'email'::text;
  end if;
  if v_mobile is null and v_email is null and not ('mobile' = any (v_bad)) and not ('email' = any (v_bad)) then
    v_bad := v_bad || array['mobile', 'email'];
  end if;
  v_confirmed := authz.b11_bool(p_fields -> 'contactConfirmed', false);
  if v_confirmed is null then v_bad := v_bad || 'contactConfirmed'::text; end if;
  v_for := authz.b11_text(p_fields -> 'bookingFor');
  if v_for is null or v_for not in ('individual', 'business') then v_bad := v_bad || 'bookingFor'::text; end if;
  v_payer_diff := authz.b11_bool(p_fields -> 'payerDifferent', false);
  if v_payer_diff is null then
    v_bad := v_bad || 'payerDifferent'::text;
  elsif v_payer_diff then
    if not authz.sf_text_ok(p_fields -> 'payerName', 200, true) then v_bad := v_bad || 'payerName'::text; end if;
    v_payer := authz.b11_text(p_fields -> 'payerName');
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;

  select * into v_old from public.booking_version_contacts c where c.booking_version_id = p_ver.id for update;
  -- Confirmation names who confirmed the channel; a changed channel needs a
  -- fresh confirmation (kept only while the mobile and email are unchanged).
  if v_confirmed then
    if v_old.contact_confirmed and v_old.mobile is not distinct from v_mobile and v_old.email is not distinct from v_email then
      v_by := v_old.confirmed_by;
      v_at := v_old.confirmed_at;
    else
      v_by := (select auth.uid());
      v_at := now();
    end if;
  end if;

  insert into public.booking_version_contacts as c (booking_version_id, legal_entity_id, deal_id, contact_name, mobile,
    email, contact_confirmed, confirmed_by, confirmed_at, booking_for, payer_different, payer_name, updated_by)
  values (p_ver.id, p_ver.legal_entity_id, p_ver.deal_id, v_name, v_mobile, v_email, v_confirmed, v_by, v_at, v_for,
    v_payer_diff, v_payer, (select auth.uid()))
  on conflict (booking_version_id) do update
    set contact_name = excluded.contact_name, mobile = excluded.mobile, email = excluded.email,
        contact_confirmed = excluded.contact_confirmed, confirmed_by = excluded.confirmed_by,
        confirmed_at = excluded.confirmed_at, booking_for = excluded.booking_for,
        payer_different = excluded.payer_different, payer_name = excluded.payer_name, updated_by = excluded.updated_by;

  return array_remove(array[
    case when v_old.contact_name is distinct from v_name then 'contactName' end,
    case when v_old.mobile is distinct from v_mobile then 'mobile' end,
    case when v_old.email is distinct from v_email then 'email' end,
    case when v_old.contact_confirmed is distinct from v_confirmed then 'contactConfirmed' end,
    case when v_old.booking_for is distinct from v_for then 'bookingFor' end,
    case when v_old.payer_different is distinct from v_payer_diff then 'payerDifferent' end,
    case when v_old.payer_name is distinct from v_payer then 'payerName' end], null);
end;
$$;

-- Billing proposal by Sales (writes the Accounts record with prefill_source
-- 'sales'; never a verified row). The caller has authorized the actor.
-- Locks the finance Deal head; exact retry through finance_command_results.
create function authz.b11_billing_propose(p_deal uuid, p_expected_row_version integer, p_fields jsonb, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_old public.customer_billing_profiles%rowtype;
  v_payload jsonb := jsonb_build_object('dealId', p_deal, 'expectedRowVersion', p_expected_row_version, 'fields', p_fields);
  v_result jsonb;
  v_name text; v_line1 text; v_line2 text; v_city text; v_state text; v_postal text; v_gstin text;
  v_changed text[] := '{}';
  v_row integer;
begin
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_deal := authz.finance_lock_deal(p_deal);
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'booking_billing_propose', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  -- Field rules copied from accounts_billing_save (20261101000100).
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['billingName', 'addressLine1', 'addressLine2', 'city', 'stateCode', 'postalCode', 'gstin']) <> '{}'::jsonb
     or p_expected_row_version is null or p_expected_row_version < 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'billing';
  end if;
  v_name := authz.finance_text(authz.finance_field(p_fields, 'billingName'), 1, 200, false);
  v_line1 := authz.finance_text(authz.finance_field(p_fields, 'addressLine1'), 1, 200, false);
  v_line2 := authz.finance_text(authz.finance_field(p_fields, 'addressLine2'), 1, 200, false);
  v_city := authz.finance_text(authz.finance_field(p_fields, 'city'), 1, 120, false);
  v_state := authz.finance_text(authz.finance_field(p_fields, 'stateCode'), 1, 2, false);
  v_postal := authz.finance_text(authz.finance_field(p_fields, 'postalCode'), 1, 6, false);
  v_gstin := upper(authz.finance_text(authz.finance_field(p_fields, 'gstin'), 1, 15, false));
  if v_name is null or v_line1 is null or v_city is null or v_state is null or v_postal is null
     or v_state !~ '^(0[1-9]|[12][0-9]|3[0-8]|97)$' or v_postal !~ '^[1-9][0-9]{5}$'
     or (v_gstin is not null and (v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' or left(v_gstin, 2) <> v_state)) then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(array_remove(array[
      case when v_name is null then 'billingName' end,
      case when v_line1 is null then 'addressLine1' end,
      case when v_city is null then 'city' end,
      case when v_state is null or v_state !~ '^(0[1-9]|[12][0-9]|3[0-8]|97)$' then 'stateCode' end,
      case when v_postal is null or v_postal !~ '^[1-9][0-9]{5}$' then 'postalCode' end,
      case when v_gstin is not null and (v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
                                        or left(v_gstin, 2) is distinct from v_state) then 'gstin' end], null), ',');
  end if;

  select * into v_old from public.customer_billing_profiles b where b.deal_id = v_deal.id for update;
  if coalesce(v_old.row_version, 0) <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if v_old.status = 'verified' then
    raise exception 'billing_verified' using errcode = '55000';
  end if;

  if v_old.deal_id is null then
    insert into public.customer_billing_profiles (deal_id, legal_entity_id, billing_name, address_line1, address_line2,
      city, state_code, postal_code, gstin, status, prefill_source, updated_by)
    values (v_deal.id, v_deal.legal_entity_id, v_name, v_line1, v_line2, v_city, v_state, v_postal, v_gstin, 'draft',
      'sales', (select auth.uid()))
    returning row_version into v_row;
    v_changed := array['billingName', 'addressLine1', 'addressLine2', 'city', 'stateCode', 'postalCode', 'gstin'];
  else
    v_changed := array_remove(array[
      case when v_old.billing_name is distinct from v_name then 'billingName' end,
      case when v_old.address_line1 is distinct from v_line1 then 'addressLine1' end,
      case when v_old.address_line2 is distinct from v_line2 then 'addressLine2' end,
      case when v_old.city is distinct from v_city then 'city' end,
      case when v_old.state_code is distinct from v_state then 'stateCode' end,
      case when v_old.postal_code is distinct from v_postal then 'postalCode' end,
      case when v_old.gstin is distinct from v_gstin then 'gstin' end], null);
    update public.customer_billing_profiles b
    set billing_name = v_name, address_line1 = v_line1, address_line2 = v_line2, city = v_city,
        state_code = v_state, postal_code = v_postal, gstin = v_gstin, prefill_source = 'sales',
        row_version = b.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
    where b.deal_id = v_deal.id
    returning row_version into v_row;
  end if;

  v_result := jsonb_build_object('outcome', case when v_old.deal_id is null then 'created' else 'updated' end,
    'status', 'draft', 'rowVersion', v_row);
  perform authz.finance_remember(v_deal.legal_entity_id, p_request_id, 'booking_billing_propose', v_payload, v_result);
  perform authz.write_audit('booking.billing_proposed', v_deal.legal_entity_id, v_deal.branch_id, 'deal', v_deal.id, null,
    jsonb_build_object('changedFields', to_jsonb(v_changed), 'rowVersion', v_row));
  return v_result;
end;
$$;

revoke all on function authz.b11_contacts_write(public.booking_versions, jsonb),
  authz.b11_billing_propose(uuid, integer, jsonb, uuid)
from public, anon, authenticated, service_role;

create function public.booking_contacts_save(p_version_id uuid, p_expected_row_version integer, p_fields jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_changed text[];
begin
  v_ver := authz.lock_package_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  v_changed := authz.b11_contacts_write(v_ver, p_fields);
  v_ver := authz.bump_package_version(v_ver.id);
  perform authz.write_audit('booking.contacts_saved', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id,
    null, jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'changedFields', to_jsonb(v_changed),
      'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;

create function public.booking_billing_propose(p_deal_id uuid, p_expected_row_version integer, p_fields jsonb, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
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
  return authz.b11_billing_propose(p_deal_id, p_expected_row_version, p_fields, p_request_id);
end;
$$;

-- Customer step: contacts and (when given) the billing proposal in one
-- transaction. Lock order: version row, then the finance Deal head.
create function public.booking_customer_save(
  p_version_id uuid, p_expected_row_version integer, p_contact jsonb, p_billing jsonb,
  p_billing_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_changed text[];
  v_billing jsonb;
  v_result jsonb;
  v_payload jsonb := jsonb_build_object('versionId', p_version_id, 'expectedRowVersion', p_expected_row_version,
    'contact', p_contact, 'billing', p_billing, 'billingExpectedRowVersion', p_billing_expected_row_version);
begin
  v_ver := authz.lock_package_draft(p_version_id);
  -- Review A2: an exact retry of a committed step returns its stored result
  -- (finance_command_results, keyed by entity and request id) before the
  -- row-version check; another payload or actor is request_conflict.
  if p_request_id is not null then
    v_result := authz.finance_replay(v_ver.legal_entity_id, p_request_id, 'booking_customer_save', v_payload);
    if v_result is not null then
      return v_result;
    end if;
  elsif p_billing is not null and jsonb_typeof(p_billing) <> 'null' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  v_changed := authz.b11_contacts_write(v_ver, p_contact);
  if p_billing is not null and jsonb_typeof(p_billing) <> 'null' then
    -- The billing part has its own derived request id (one result row per id).
    v_billing := authz.b11_billing_propose(v_ver.deal_id, p_billing_expected_row_version, p_billing,
      md5(p_request_id::text || ':billing')::uuid);
    v_billing := jsonb_build_object('outcome', v_billing ->> 'outcome', 'status', v_billing ->> 'status',
      'rowVersion', (v_billing ->> 'rowVersion')::integer);
  end if;
  v_ver := authz.bump_package_version(v_ver.id);
  perform authz.write_audit('booking.contacts_saved', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id,
    null, jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'changedFields', to_jsonb(v_changed),
      'rowVersion', v_ver.row_version));
  v_result := jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash, 'billing', v_billing);
  if p_request_id is not null then
    perform authz.finance_remember(v_ver.legal_entity_id, p_request_id, 'booking_customer_save', v_payload, v_result);
  end if;
  return v_result;
end;
$$;

create function public.booking_trip_save(p_version_id uuid, p_expected_row_version integer, p_fields jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_bad text[];
  v_dest text;
  v_scope text;
  v_start date;
  v_end date;
begin
  v_ver := authz.lock_package_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'trip';
  end if;
  v_bad := authz.b11_unknown_keys(p_fields, array['destination', 'scope', 'start', 'end']);
  if not authz.sf_text_ok(p_fields -> 'destination', 200, false) then v_bad := v_bad || 'destination'::text; end if;
  v_dest := authz.b11_text(p_fields -> 'destination');
  v_scope := authz.b11_text(p_fields -> 'scope');
  if (p_fields ? 'scope' and jsonb_typeof(p_fields -> 'scope') not in ('string', 'null'))
     or (v_scope is not null and v_scope not in ('domestic', 'international')) then
    v_bad := v_bad || 'scope'::text;
  end if;
  v_start := authz.sf_date(p_fields -> 'start');
  if p_fields ? 'start' and jsonb_typeof(p_fields -> 'start') <> 'null' and v_start is null then v_bad := v_bad || 'start'::text; end if;
  v_end := authz.sf_date(p_fields -> 'end');
  if (p_fields ? 'end' and jsonb_typeof(p_fields -> 'end') <> 'null' and v_end is null) or v_end < v_start then
    v_bad := v_bad || 'end'::text;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  update public.booking_versions v
  set trip_destination = v_dest, trip_scope = v_scope, trip_start = v_start, trip_end = v_end
  where v.id = v_ver.id;
  v_ver := authz.bump_package_version(v_ver.id);
  perform authz.write_audit('booking.trip_saved', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;

-- Replaces 20261118000100. B1.1: optional ageYears / specialNeeds; the set is
-- upserted by seq (traveller ids stay stable for identities); removed seqs
-- also leave the draft's participation.
create or replace function public.deal_travellers_save(p_deal_id uuid, p_expected_row_version integer, p_travellers jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_draft uuid;
  v_row jsonb;
  v_seq integer;
  v_seqs integer[] := '{}'::integer[];
  v_count integer := 0;
  v_removed integer := 0;
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
       -- B1.1: ageYears, specialNeeds
       or exists (select 1 from jsonb_object_keys(v_row) k where k not in ('fullName', 'type', 'seq', 'ageYears', 'specialNeeds'))
       or not authz.sf_text_ok(v_row -> 'fullName', 120, true)
       or not authz.sf_int_ok(v_row -> 'seq', 1, 100, true)
       or jsonb_typeof(v_row -> 'type') <> 'string' or (v_row #>> '{type}') not in ('adult', 'child', 'infant')
       or not authz.sf_int_ok(v_row -> 'ageYears', 0, 17, false)
       or not authz.sf_text_ok(v_row -> 'specialNeeds', 500, false) then
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

  -- B1.1: upsert by seq.
  delete from public.service_item_travellers p
  where p.booking_version_id = v_ver.id and p.traveller_seq <> all (v_seqs);
  delete from public.deal_travellers t where t.deal_id = p_deal_id and t.seq <> all (v_seqs);
  get diagnostics v_removed = row_count;
  insert into public.deal_travellers as t (deal_id, legal_entity_id, seq, full_name, traveller_type, age_years, special_needs)
  select p_deal_id, v_ver.legal_entity_id, (e #>> '{seq}')::integer, btrim(e #>> '{fullName}', E' \t\r\n'), e #>> '{type}',
    authz.sf_int_value(e -> 'ageYears'), authz.b11_text(e -> 'specialNeeds')
  from jsonb_array_elements(p_travellers) e
  on conflict (deal_id, seq) do update
    set full_name = excluded.full_name, traveller_type = excluded.traveller_type, age_years = excluded.age_years,
        special_needs = excluded.special_needs
    where (t.full_name, t.traveller_type, t.age_years, t.special_needs)
          is distinct from (excluded.full_name, excluded.traveller_type, excluded.age_years, excluded.special_needs);
  v_ver := authz.bump_package_version(v_ver.id);

  -- Count only; no names.
  perform authz.write_audit('booking.travellers_saved', v_ver.legal_entity_id, v_ver.branch_id,
    'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', p_deal_id, 'versionNo', v_ver.version_no, 'travellerCount', v_count,
      'removedCount', v_removed, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;

-- Identity of one traveller (restricted). p_expected_row_version is the
-- identity row's version (0 when none). Works with or without a draft
-- (passport details may come later); the draft's hash follows by trigger.
create function authz.b11_can_edit_identity(p_deal uuid, p_seq integer) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.can_edit_booking_draft(p_deal)
$$;
revoke all on function authz.b11_can_edit_identity(uuid, integer) from public, anon, authenticated, service_role;

create function public.traveller_identity_save(p_deal_id uuid, p_seq integer, p_expected_row_version integer, p_fields jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_trav public.deal_travellers%rowtype;
  v_old public.traveller_identities%rowtype;
  v_bad text[];
  v_dob date;
  v_nat text;
  v_pass text;
  v_exp date;
  v_row integer;
  v_branch uuid;
begin
  perform authz.refuse_removed_deal(p_deal_id);
  if p_deal_id is null or not authz.b11_can_edit_identity(p_deal_id, p_seq) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not authz.service_items_enabled() then
    raise exception 'service_items_disabled' using errcode = '55000';
  end if;
  if authz.deal_not_active(p_deal_id) then
    raise exception 'deal_not_active' using errcode = '55000';
  end if;
  select * into v_trav from public.deal_travellers t where t.deal_id = p_deal_id and t.seq = p_seq for update;
  if v_trav.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_old from public.traveller_identities x where x.traveller_id = v_trav.id for update;
  perform authz.require_row_version(p_expected_row_version, coalesce(v_old.row_version, 0));
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'identity';
  end if;
  v_bad := authz.b11_unknown_keys(p_fields, array['dateOfBirth', 'nationality', 'passportNumber', 'passportExpiry']);
  v_dob := authz.b11_date(p_fields -> 'dateOfBirth', date '1900-01-01', current_date - 1);
  if p_fields ? 'dateOfBirth' and jsonb_typeof(p_fields -> 'dateOfBirth') <> 'null' and v_dob is null then
    v_bad := v_bad || 'dateOfBirth'::text;
  end if;
  v_nat := authz.b11_text(p_fields -> 'nationality');
  if not authz.sf_text_ok(p_fields -> 'nationality', 60, false) or length(v_nat) < 2 then
    v_bad := v_bad || 'nationality'::text;
  end if;
  v_pass := nullif(upper(regexp_replace(coalesce(authz.b11_text(p_fields -> 'passportNumber'), ''), '[ -]', '', 'g')), '');
  if (p_fields ? 'passportNumber' and jsonb_typeof(p_fields -> 'passportNumber') not in ('string', 'null'))
     or (v_pass is not null and v_pass !~ '^[A-Z0-9]{6,15}$') then
    v_bad := v_bad || 'passportNumber'::text;
  end if;
  v_exp := authz.sf_date(p_fields -> 'passportExpiry');
  if p_fields ? 'passportExpiry' and jsonb_typeof(p_fields -> 'passportExpiry') <> 'null' and v_exp is null then
    v_bad := v_bad || 'passportExpiry'::text;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;

  if v_dob is null and v_nat is null and v_pass is null and v_exp is null then
    delete from public.traveller_identities x where x.traveller_id = v_trav.id;
    v_row := 0;
  elsif v_old.traveller_id is null then
    insert into public.traveller_identities (traveller_id, deal_id, legal_entity_id, date_of_birth, nationality,
      passport_number, passport_expiry, updated_by)
    values (v_trav.id, p_deal_id, v_trav.legal_entity_id, v_dob, v_nat, v_pass, v_exp, (select auth.uid()))
    returning row_version into v_row;
  else
    update public.traveller_identities x
    set date_of_birth = v_dob, nationality = v_nat, passport_number = v_pass, passport_expiry = v_exp,
        row_version = x.row_version + 1, updated_by = (select auth.uid())
    where x.traveller_id = v_trav.id
    returning row_version into v_row;
  end if;

  select d.branch_id into v_branch from public.deals d where d.id = p_deal_id;
  -- Field names only; never the values.
  perform authz.write_audit('booking.traveller_identity_saved', v_trav.legal_entity_id, v_branch, 'deal', p_deal_id, null,
    jsonb_build_object('seq', p_seq, 'changedFields', to_jsonb(array_remove(array[
      case when v_old.date_of_birth is distinct from v_dob then 'dateOfBirth' end,
      case when v_old.nationality is distinct from v_nat then 'nationality' end,
      case when v_old.passport_number is distinct from v_pass then 'passportNumber' end,
      case when v_old.passport_expiry is distinct from v_exp then 'passportExpiry' end], null)), 'rowVersion', v_row));
  return jsonb_build_object('seq', p_seq, 'rowVersion', v_row);
end;
$$;

create function public.service_item_travellers_save(p_item_id uuid, p_version_id uuid, p_expected_row_version integer,
  p_seqs integer[])
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_item public.service_items%rowtype;
begin
  v_ver := authz.lock_package_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  select i.* into v_item from public.service_items i where i.id = p_item_id and i.deal_id = v_ver.deal_id;
  if v_item.id is null or not exists (
       select 1 from public.service_item_facts f where f.service_item_id = v_item.id and f.booking_version_id = v_ver.id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_seqs is null or cardinality(p_seqs) > 100
     or (select count(distinct s) from unnest(p_seqs) s) <> cardinality(p_seqs)
     or exists (select 1 from unnest(p_seqs) s
                where s is null or not exists (select 1 from public.deal_travellers t where t.deal_id = v_ver.deal_id and t.seq = s))
     or (v_item.service_type = 'passport' and cardinality(p_seqs) > 1) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'travellers';
  end if;
  delete from public.service_item_travellers p where p.booking_version_id = v_ver.id and p.service_item_id = v_item.id;
  insert into public.service_item_travellers (booking_version_id, service_item_id, legal_entity_id, traveller_seq)
  select v_ver.id, v_item.id, v_ver.legal_entity_id, s from unnest(p_seqs) s;
  v_ver := authz.bump_package_version(v_ver.id);
  perform authz.write_audit('booking.participation_saved', v_ver.legal_entity_id, v_ver.branch_id, 'service_item', v_item.id,
    null, jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'itemNo', v_item.item_no,
      'travellerCount', cardinality(p_seqs), 'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;

-- Replaces 20261118000100. B1.1: visa and passport are sold (department
-- visa); only train stays on hold; a new item takes every current traveller.
create or replace function public.service_item_add(
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
  -- B1.1: only train stays on hold.
  if p_service_type = 'train' then
    raise exception 'service_on_hold' using errcode = '22023';
  end if;
  if p_service_type is null or p_service_type not in ('hotel', 'transfer', 'activity', 'flight', 'visa', 'passport') then
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
    case when p_service_type = 'flight' then 'flight' when p_service_type in ('visa', 'passport') then 'visa' else 'purchase' end,
    'planned', p_request_id, (select auth.uid()))
  returning * into v_item;
  insert into public.service_item_facts (service_item_id, booking_version_id, legal_entity_id, facts,
    purchase_budget_paise, facts_hash)
  values (v_item.id, v_ver.id, v_ver.legal_entity_id, v_facts, p_purchase_budget_paise,
    authz.service_facts_hash(v_facts, p_purchase_budget_paise));
  -- B1.1: participation defaults to every current traveller (a passport item
  -- takes the first traveller only).
  insert into public.service_item_travellers (booking_version_id, service_item_id, legal_entity_id, traveller_seq)
  select v_ver.id, v_item.id, v_ver.legal_entity_id, t.seq
  from public.deal_travellers t
  where t.deal_id = v_ver.deal_id
    and (p_service_type <> 'passport'
         or t.seq = (select min(t2.seq) from public.deal_travellers t2 where t2.deal_id = v_ver.deal_id));
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

-- Selling total with list price and discount (commercial readers who may
-- edit the draft). total > 0; when a list price is given, total = list - discount.
create function public.booking_commercials_save(p_version_id uuid, p_expected_row_version integer,
  p_list_paise bigint, p_discount_paise bigint, p_total_paise bigint)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
begin
  v_ver := authz.lock_package_draft(p_version_id);
  if not authz.can_read_deal_commercial(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_total_paise is null or p_total_paise <= 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'totalPaise';
  end if;
  if p_discount_paise is not null and (p_discount_paise < 0 or p_list_paise is null) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'discountPaise';
  end if;
  if p_list_paise is not null and (p_list_paise < 0 or p_list_paise - coalesce(p_discount_paise, 0) <> p_total_paise) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'listPaise';
  end if;
  insert into public.booking_version_commercials (version_id, legal_entity_id, selling_total_paise, list_price_paise, discount_paise)
  values (v_ver.id, v_ver.legal_entity_id, p_total_paise, p_list_paise, p_discount_paise)
  on conflict (version_id) do update
    set selling_total_paise = excluded.selling_total_paise, list_price_paise = excluded.list_price_paise,
        discount_paise = excluded.discount_paise, updated_at = now();
  v_ver := authz.bump_package_version(v_ver.id);
  -- No amounts in the audit record.
  perform authz.write_audit('booking.commercials_saved', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id,
    null, jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;

-- Payment plan: replaces the set. Rows {seq, label, amountPaise, dueDate};
-- the total is checked by readiness (plan_total_mismatch), not here.
create function public.booking_instalments_save(p_version_id uuid, p_expected_row_version integer, p_instalments jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_row jsonb;
  v_n integer := 0;
  v_seqs integer[] := '{}'::integer[];
  v_amount text;
begin
  v_ver := authz.lock_package_draft(p_version_id);
  if not authz.can_read_deal_commercial(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_instalments is null or jsonb_typeof(p_instalments) <> 'array' or jsonb_array_length(p_instalments) > 12 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'instalments';
  end if;
  for v_row in select e from jsonb_array_elements(p_instalments) e loop
    v_n := v_n + 1;
    v_amount := case when jsonb_typeof(v_row -> 'amountPaise') in ('string', 'number') then v_row #>> '{amountPaise}' end;
    if jsonb_typeof(v_row) <> 'object'
       or cardinality(authz.b11_unknown_keys(v_row, array['seq', 'label', 'amountPaise', 'dueDate'])) > 0
       or not authz.sf_int_ok(v_row -> 'seq', 1, 12, true)
       or not authz.sf_text_ok(v_row -> 'label', 60, true)
       or v_amount is null or v_amount !~ '^[1-9][0-9]{0,14}$'
       or authz.sf_date(v_row -> 'dueDate') is null
       or (v_row #>> '{seq}')::integer = any (v_seqs) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'instalments[' || v_n::text || ']';
    end if;
    v_seqs := v_seqs || (v_row #>> '{seq}')::integer;
  end loop;
  delete from public.booking_version_instalments p where p.booking_version_id = v_ver.id;
  insert into public.booking_version_instalments (booking_version_id, deal_id, legal_entity_id, seq, label, amount_paise, due_date)
  select v_ver.id, v_ver.deal_id, v_ver.legal_entity_id, (e #>> '{seq}')::integer, authz.b11_text(e -> 'label'),
    (e #>> '{amountPaise}')::bigint, authz.sf_date(e -> 'dueDate')
  from jsonb_array_elements(p_instalments) e;
  v_ver := authz.bump_package_version(v_ver.id);
  perform authz.write_audit('booking.plan_saved', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'count', v_n, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;

-- Replaces 20261118000100. B1.1 (package path): the traveller snapshot keeps
-- age and special needs; identities are snapshotted; visa/passport items get
-- no task while visa_passport_tasks_enabled is off (they still become active).
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
    if cardinality(v_tasks) > 0 or v_ver.service_type = 'package' then
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
    -- Traveller snapshot (B1.1: with age and special needs).
    insert into public.booking_version_travellers (booking_version_id, legal_entity_id, seq, full_name, traveller_type,
      age_years, special_needs)
    select v_ver.id, v_ver.legal_entity_id, t.seq, t.full_name, t.traveller_type, t.age_years, t.special_needs
    from public.deal_travellers t where t.deal_id = v_ver.deal_id;
    -- B1.1: identity snapshot (restricted).
    insert into public.booking_version_traveller_identities (booking_version_id, legal_entity_id, seq, date_of_birth,
      nationality, passport_number, passport_expiry)
    select v_ver.id, v_ver.legal_entity_id, t.seq, x.date_of_birth, x.nationality, x.passport_number, x.passport_expiry
    from public.traveller_identities x join public.deal_travellers t on t.id = x.traveller_id
    where t.deal_id = v_ver.deal_id
      -- Review A1: identities the trip needs only (same set as the draft hash).
      and t.seq = any (authz.b11_identity_needed_seqs(v_ver.id));
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
    -- Review V3: read the desk switch under a share lock so a concurrent
    -- switch-on either sees this version's items or is seen here.
    perform 1 from public.workflow_settings s where s.id for share;
    update public.service_items i set state = 'active', updated_at = now()
    where i.state = 'planned'
      and i.id in (select f.service_item_id from public.service_item_facts f where f.booking_version_id = v_ver.id);
    for v_item in
      select i.id, i.item_no, i.service_type, i.department
      from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
      where f.booking_version_id = v_ver.id
        -- B1.1: visa/passport tasks wait for the desk launch.
        and (i.service_type not in ('visa', 'passport') or authz.visa_passport_tasks_enabled())
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
      jsonb_strip_nulls(jsonb_build_object('version_id', v_ver.id, 'deal_id', v_ver.deal_id, 'task_id', v_tasks[1],
        'version_no', v_ver.version_no, 'service_purpose', 'package')))
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
-- 10. Reads
-- ===========================================================================

-- Replaces 20261118000100. B1.1 rules: customer, billing, trip, child ages,
-- participation, identity, selling total, plan (blocking); participation
-- count, passport details, passport expiry, waiting for the desk launch,
-- billing not yet verified (warnings). Trip dates bound dates_outside_trip
-- when set. Traveller-level codes carry travellerSeqs.
create or replace function public.intake_checklist(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ver public.booking_versions;
  v_items jsonb := '[]'::jsonb;
  v_needed integer := 0;
  v_travellers integer := 0;
  v_nos integer[];
  v_seqs integer[];
  v_text text;
  v_contact public.booking_version_contacts;
  v_billing public.customer_billing_profiles;
  v_total bigint;
  v_plan bigint;
  v_commercial boolean;
begin
  -- Booking readers who hold no department role (review E1).
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
  -- B1.1: customer, billing and trip.
  select * into v_billing from public.customer_billing_profiles b where b.deal_id = p_deal_id;
  if v_ver.id is not null then
    select * into v_contact from public.booking_version_contacts c where c.booking_version_id = v_ver.id;
    if v_contact.booking_version_id is null then
      v_items := v_items || jsonb_build_object('code', 'contact_missing', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
    elsif not v_contact.contact_confirmed then
      v_items := v_items || jsonb_build_object('code', 'contact_not_confirmed', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
    end if;
    if v_billing.deal_id is null then
      v_items := v_items || jsonb_build_object('code', 'billing_missing', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
    elsif v_contact.booking_for = 'business' and v_billing.gstin is null then
      v_items := v_items || jsonb_build_object('code', 'gstin_missing', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
    end if;
    if v_ver.trip_destination is null or v_ver.trip_scope is null or v_ver.trip_start is null or v_ver.trip_end is null then
      v_items := v_items || jsonb_build_object('code', 'trip_missing', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
    end if;
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
  -- B1.1: child ages.
  select coalesce(array_agg(t.seq order by t.seq), '{}'::integer[]) into v_seqs
  from public.deal_travellers t where t.deal_id = p_deal_id and t.traveller_type in ('child', 'infant') and t.age_years is null;
  if cardinality(v_seqs) > 0 then
    v_items := v_items || jsonb_build_object('code', 'child_age_missing', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb,
      'travellerSeqs', to_jsonb(v_seqs));
  end if;
  if v_ver.id is not null then
    v_nos := authz.service_item_invalid_nos(v_ver.id);
    if cardinality(v_nos) > 0 then
      v_items := v_items || jsonb_build_object('code', 'service_facts_invalid', 'blocking', true, 'owner', 'sales', 'itemNos', to_jsonb(v_nos));
    end if;
    -- B1.1: participation and identity.
    v_nos := authz.b11_participation_missing_nos(v_ver.id);
    if cardinality(v_nos) > 0 then
      v_items := v_items || jsonb_build_object('code', 'participation_missing', 'blocking', true, 'owner', 'sales', 'itemNos', to_jsonb(v_nos));
    end if;
    v_seqs := authz.b11_identity_missing_seqs(v_ver.id);
    if cardinality(v_seqs) > 0 then
      v_items := v_items || jsonb_build_object('code', 'identity_missing', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb,
        'travellerSeqs', to_jsonb(v_seqs));
    end if;
    -- B1.1: selling total and plan.
    select c.selling_total_paise into v_total from public.booking_version_commercials c where c.version_id = v_ver.id;
    select sum(p.amount_paise) into v_plan from public.booking_version_instalments p where p.booking_version_id = v_ver.id;
    -- Review A3: without commercial scope the codes read "ask the owner".
    v_commercial := authz.can_read_deal_commercial(p_deal_id);
    if v_total is null then
      v_items := v_items || jsonb_build_object('code', case when v_commercial then 'selling_total_missing' else 'selling_total_ask_owner' end,
        'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
    end if;
    if v_plan is null or (v_total is not null and v_plan <> v_total) then
      v_items := v_items || jsonb_build_object('code', case when not v_commercial then 'plan_ask_owner'
                                                            when v_plan is null then 'plan_missing' else 'plan_total_mismatch' end,
        'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
    end if;
    -- An item whose dates fall more than a day outside the trip dates (when
    -- set), else outside the other items' dates.
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
    where case when v_ver.trip_start is not null and v_ver.trip_end is not null
      then a.day < v_ver.trip_start - 1 or a.day > v_ver.trip_end + 1
      else exists (select 1 from d b where b.item_no <> a.item_no)
        and (a.day < (select min(b.day) from d b where b.item_no <> a.item_no) - 1
          or a.day > (select max(b.day) from d b where b.item_no <> a.item_no) + 1) end;
    if cardinality(v_nos) > 0 then
      v_items := v_items || jsonb_build_object('code', 'dates_outside_trip', 'blocking', false, 'owner', 'sales', 'itemNos', to_jsonb(v_nos));
    end if;
    select coalesce(array_agg(i.item_no order by i.item_no), '{}'::integer[]) into v_nos
    from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
    where f.booking_version_id = v_ver.id and f.purchase_budget_paise = 0;
    if cardinality(v_nos) > 0 then
      v_items := v_items || jsonb_build_object('code', 'budget_missing', 'blocking', false, 'owner', 'sales', 'itemNos', to_jsonb(v_nos));
    end if;
    -- B1.1 warnings.
    select coalesce(array_agg(i.item_no order by i.item_no), '{}'::integer[]) into v_nos
    from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
    where f.booking_version_id = v_ver.id
      and authz.service_item_travellers_needed(i.service_type, f.facts) > 0
      and cardinality(authz.item_participant_seqs(i.id, v_ver.id)) > 0
      and cardinality(authz.item_participant_seqs(i.id, v_ver.id)) <> authz.service_item_travellers_needed(i.service_type, f.facts);
    if cardinality(v_nos) > 0 then
      v_items := v_items || jsonb_build_object('code', 'participation_count_mismatch', 'blocking', false, 'owner', 'sales', 'itemNos', to_jsonb(v_nos));
    end if;
    select coalesce(array_agg(s order by s), '{}'::integer[]) into v_seqs
    from unnest(authz.b11_identity_needed_seqs(v_ver.id)) s
    where not exists (select 1 from authz.b11_identity_row(v_ver.id, s) r
                      where r.passport_number is not null and r.passport_expiry is not null);
    if cardinality(v_seqs) > 0 then
      v_items := v_items || jsonb_build_object('code', 'passport_details_later', 'blocking', false, 'owner', 'sales', 'itemNos', '[]'::jsonb,
        'travellerSeqs', to_jsonb(v_seqs));
    end if;
    if v_ver.trip_end is not null then
      select coalesce(array_agg(s order by s), '{}'::integer[]) into v_seqs
      from unnest(authz.b11_identity_needed_seqs(v_ver.id)) s
      where exists (select 1 from authz.b11_identity_row(v_ver.id, s) r where r.passport_expiry <= v_ver.trip_end);
      if cardinality(v_seqs) > 0 then
        v_items := v_items || jsonb_build_object('code', 'passport_expiry_before_trip_end', 'blocking', false, 'owner', 'sales',
          'itemNos', '[]'::jsonb, 'travellerSeqs', to_jsonb(v_seqs));
      end if;
    end if;
    if not authz.visa_passport_tasks_enabled() then
      select coalesce(array_agg(i.item_no order by i.item_no), '{}'::integer[]) into v_nos
      from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
      where f.booking_version_id = v_ver.id and i.service_type in ('visa', 'passport');
      if cardinality(v_nos) > 0 then
        v_items := v_items || jsonb_build_object('code', 'visa_waiting_for_launch', 'blocking', false, 'owner', 'admin', 'itemNos', to_jsonb(v_nos));
      end if;
    end if;
    if v_billing.deal_id is not null and v_billing.status <> 'verified' then
      v_items := v_items || jsonb_build_object('code', 'billing_unverified', 'blocking', false, 'owner', 'accounts', 'itemNos', '[]'::jsonb);
    end if;
    select string_agg(coalesce(f.facts ->> 'notes', '') || ' ' || coalesce(f.facts ->> 'specialRequests', '')
      || ' ' || coalesce(f.facts ->> 'inclusions', ''), ' ') into v_text
    from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
    -- B1.1: a sold visa/passport item's own notes do not count as a mention.
    where f.booking_version_id = v_ver.id and i.service_type not in ('visa', 'passport');
  end if;
  v_text := coalesce(v_text, '') || ' ' || coalesce((select d.title from public.deals d where d.id = p_deal_id), '');
  if v_text ~* '\m(visa|passport|train)\M'
     and not (v_text !~* '\mtrain\M' and v_ver.id is not null and exists (
       select 1 from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
       where f.booking_version_id = v_ver.id and i.service_type in ('visa', 'passport'))) then
    v_items := v_items || jsonb_build_object('code', 'visa_mentioned', 'blocking', false, 'owner', 'sales', 'itemNos', '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'items', v_items,
    'canConfirm', coalesce(v_ver.status = 'draft', false) and authz.can_confirm_booking(p_deal_id)
      and not exists (select 1 from jsonb_array_elements(v_items) e where (e ->> 'blocking')::boolean));
end;
$$;

-- The one editor read of the Book now form (freeze note D7): booking editors
-- and acceptors only (Sales owner/assignee, branch Manager); commercial keys
-- (list price, discount, selling total, plan) only with deal.read_commercial.
-- Never for Purchase, Flight, the Visa desk, Accounts-only or Super Admin.
create function public.booking_form_get(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ver public.booking_versions;
  v_result jsonb;
  v_billing public.customer_billing_profiles;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_deal_id is null or not (authz.can_edit_booking_draft(p_deal_id) or authz.can_confirm_booking(p_deal_id)) then
    return null;
  end if;
  v_ver := authz.deal_current_version(p_deal_id);
  select * into v_billing from public.customer_billing_profiles b where b.deal_id = p_deal_id;

  v_result := jsonb_build_object(
    'dealId', p_deal_id,
    'canEdit', coalesce(v_ver.status, 'draft') = 'draft' and authz.can_edit_booking_draft(p_deal_id),
    'canConfirm', v_ver.status = 'draft' and authz.can_confirm_booking(p_deal_id),
    -- Review A3: may see and edit the selling price and payment plan.
    'canEditCommercials', authz.can_read_deal_commercial(p_deal_id),
    'serviceItemsEnabled', authz.service_items_enabled(),
    'visaPassportTasksEnabled', authz.visa_passport_tasks_enabled(),
    'dealNotActive', authz.deal_not_active(p_deal_id),
    'version', case when v_ver.id is null then null else jsonb_build_object(
      'versionId', v_ver.id, 'versionNo', v_ver.version_no, 'status', v_ver.status, 'serviceType', v_ver.service_type,
      'rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash, 'updatedAt', v_ver.updated_at,
      'updatedByName', (select p.display_name from public.staff_profiles p where p.user_id = v_ver.updated_by),
      'confirmedAt', v_ver.confirmed_at) end,
    'trip', jsonb_build_object('destination', v_ver.trip_destination, 'scope', v_ver.trip_scope,
      'start', to_char(v_ver.trip_start, 'YYYY-MM-DD'), 'end', to_char(v_ver.trip_end, 'YYYY-MM-DD')),
    'contacts', (select jsonb_build_object('contactName', c.contact_name, 'mobile', c.mobile, 'email', c.email,
        'contactConfirmed', c.contact_confirmed, 'confirmedAt', c.confirmed_at,
        'confirmedByName', (select p.display_name from public.staff_profiles p where p.user_id = c.confirmed_by),
        'bookingFor', c.booking_for, 'payerDifferent', c.payer_different, 'payerName', c.payer_name)
      from public.booking_version_contacts c where c.booking_version_id = v_ver.id),
    'billing', case when v_billing.deal_id is null
      then jsonb_build_object('status', 'none', 'prefillSource', null, 'rowVersion', 0)
      else jsonb_build_object('status', v_billing.status, 'prefillSource', v_billing.prefill_source,
        'rowVersion', v_billing.row_version, 'billingName', v_billing.billing_name,
        'addressLine1', v_billing.address_line1, 'addressLine2', v_billing.address_line2, 'city', v_billing.city,
        'stateCode', v_billing.state_code, 'postalCode', v_billing.postal_code, 'gstin', v_billing.gstin) end,
    'travellers', coalesce((
      select jsonb_agg(jsonb_build_object('travellerId', t.id, 'seq', t.seq, 'fullName', t.full_name, 'type', t.traveller_type,
          'ageYears', t.age_years, 'specialNeeds', t.special_needs,
          'identity', case when authz.can_read_traveller_identity(p_deal_id, t.seq)
                           then authz.booking_identity_json(p_deal_id, t.seq, null) end) order by t.seq)
      from public.deal_travellers t where t.deal_id = p_deal_id), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(authz.service_item_json(i.id, v_ver.id, true)
          || jsonb_build_object('participants', to_jsonb(authz.item_participant_seqs(i.id, v_ver.id))) order by i.item_no)
      from public.service_items i where i.deal_id = p_deal_id), '[]'::jsonb),
    'evidence', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'fileName', e.file_name, 'mime', e.mime,
          'sizeBytes', e.size_bytes, 'status', e.status, 'uploadedByYou', e.uploaded_by = (select auth.uid()),
          'createdAt', e.created_at, 'storedAt', e.stored_at) order by e.created_at, e.id)
      from public.booking_evidence e where e.version_id = v_ver.id and e.status <> 'removed'), '[]'::jsonb));

  if authz.can_read_deal_commercial(p_deal_id) then
    v_result := v_result
      || jsonb_build_object('commercials', (select jsonb_build_object(
           'listPricePaise', c.list_price_paise::text, 'discountPaise', c.discount_paise::text,
           'sellingTotalPaise', c.selling_total_paise::text)
         from public.booking_version_commercials c where c.version_id = v_ver.id))
      || jsonb_build_object('plan', coalesce((
           select jsonb_agg(jsonb_build_object('seq', p.seq, 'label', p.label, 'amountPaise', p.amount_paise::text,
             'dueDate', to_char(p.due_date, 'YYYY-MM-DD')) order by p.seq)
           from public.booking_version_instalments p where p.booking_version_id = v_ver.id), '[]'::jsonb));
  end if;
  return v_result;
end;
$$;

-- Replaces 20261118000100: adds visaPassportTasksEnabled.
create or replace function public.workflow_settings_get() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return (select jsonb_build_object('intakePromptEnabled', s.intake_prompt_enabled,
    'serviceItemsEnabled', s.service_items_enabled,
    -- B1.1
    'visaPassportTasksEnabled', s.visa_passport_tasks_enabled,
    'updatedAt', s.updated_at)
    from public.workflow_settings s where s.id);
end;
$$;

-- ===========================================================================
-- 11. Grants
-- ===========================================================================

revoke all on function
  public.booking_contacts_save(uuid, integer, jsonb),
  public.booking_billing_propose(uuid, integer, jsonb, uuid),
  public.booking_customer_save(uuid, integer, jsonb, jsonb, integer, uuid),
  public.booking_trip_save(uuid, integer, jsonb),
  public.traveller_identity_save(uuid, integer, integer, jsonb),
  public.service_item_travellers_save(uuid, uuid, integer, integer[]),
  public.booking_commercials_save(uuid, integer, bigint, bigint, bigint),
  public.booking_instalments_save(uuid, integer, jsonb),
  public.booking_form_get(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.booking_contacts_save(uuid, integer, jsonb),
  public.booking_billing_propose(uuid, integer, jsonb, uuid),
  public.booking_customer_save(uuid, integer, jsonb, jsonb, integer, uuid),
  public.booking_trip_save(uuid, integer, jsonb),
  public.traveller_identity_save(uuid, integer, integer, jsonb),
  public.service_item_travellers_save(uuid, uuid, integer, integer[]),
  public.booking_commercials_save(uuid, integer, bigint, bigint, bigint),
  public.booking_instalments_save(uuid, integer, jsonb),
  public.booking_form_get(uuid)
to authenticated;

-- Trigger functions created here are never callable through the API.
revoke all on function
  authz.b11_version_child_guard(), authz.b11_rehash_version(), authz.b11_rehash_deal(), authz.b11_plan_revision(),
  authz.b11_touch(), authz.visa_passport_tasks_enabled()
from public, anon, authenticated, service_role;

commit;
