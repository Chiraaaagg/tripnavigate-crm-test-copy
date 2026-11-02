-- TripNavigate CRM - booking form (22 October 2026): schema.
--
-- Contract: docs/implementation/booking-form-2026-10-22/contract.md (frozen by
--   the lead 22 Oct 2026, section 3) and crm/src/modules/fulfilment/
--   booking-form-contract.ts. Owner work order of 22 October 2026 (approved
--   three-step booking form).
--
-- What changes (all additive; no earlier migration is edited):
--   * booking_versions: party counts (pax_total 1..100, children_count and
--     infants_count 0..pax_total) and form_rules (1 = rules before this
--     release, 2 = drafts started in the new form through booking_form_start,
--     20261124000110, and drafts converted from an accepted quotation,
--     20261124000120). Every existing row is 1; a new row is 1 unless the
--     transaction setting tripnavigate.booking_form_rules is '2' (set only by
--     those two commands), so direct callers of booking_open_draft keep
--     today's rules. Under the same setting an open first package draft may
--     move 1 -> 2 (never back).
--   * Hash schema 3 (new drafts; existing package drafts move 2 -> 3; no
--     confirmed row changes): schema 2 plus the party counts, the contact
--     labels and the supplier estimates. Per-person prices reach the hash
--     through commercial_revision (redrawn on every price change), like the
--     payment plan. Passenger extras (marriage date, passenger phone/email) are
--     not hashed: they are optional contact details kept on the live identity
--     row only (no snapshot), never booking facts.
--   * booking_version_contacts: customer_type and market (plain labels; no
--     tax, currency, company or price effect).
--   * traveller_identities: date_of_marriage, phone, email (restricted; no
--     Data API read, as the rest of the row).
--   * booking_version_price_lines: per-person package prices (purchase and
--     sale per person in paise; markup derived; commercial readers only).
--   * service_item_cost_estimates: supplier estimates per item and version
--     (cost side only; unknown = null).
--   * service_item_files + private bucket service-item-files (flight
--     screenshot).
--   * customer_billing_profiles: Bill To type, contact person, phone, email,
--     GST status and the reason for no GSTIN (nullable; existing profiles stay
--     valid and read as before).
--
-- Amended 22 October 2026 after independent review A (Echo, before this file
-- ran on any kept database): H1 adds booking_versions_trip_length_check (a
-- trip is at most 365 nights; NOT VALID, so it applies to every new write and
-- never fails on an older row).
--
-- Rollback (forward-only): rows are kept. Emergency: a NEW migration revoking
-- execute on the commands of 20261124000110; the columns stay nullable and
-- unused.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. booking_versions: party counts, form rules, hash schema 3
-- ===========================================================================

alter table public.booking_versions
  add column pax_total smallint check (pax_total between 1 and 100),
  add column children_count smallint check (children_count between 0 and 100),
  add column infants_count smallint check (infants_count between 0 and 100),
  add column form_rules smallint not null default 1 check (form_rules in (1, 2)),
  add constraint booking_versions_party_check
    check (coalesce(children_count, 0) + coalesce(infants_count, 0) <= coalesce(pax_total, 100));
-- Review A H1: at most 365 nights, for every writer (commands, automatic
-- filling, conversion). NOT VALID: checked on every new write only.
alter table public.booking_versions
  add constraint booking_versions_trip_length_check check (trip_end - trip_start <= 365) not valid;
comment on column public.booking_versions.pax_total is
  'Booking form: total passengers (1..100). Null on versions started before the booking form.';
comment on column public.booking_versions.form_rules is
  'Readiness rules: 1 = rules before the booking form (existing rows, direct booking_open_draft callers); 2 = drafts started in the booking form (booking_form_start) or converted from an accepted quotation. Moves only 1 -> 2 on an open first draft inside those commands.';

alter table public.booking_versions drop constraint booking_versions_hash_schema_check;
alter table public.booking_versions
  add constraint booking_versions_hash_schema_check check (hash_schema in (1, 2, 3));

-- New rows: form rules 2 only inside booking_form_start or the quotation
-- conversion (transaction setting); a revision keeps its base's rules.
create function authz.booking_versions_form_rules() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.form_rules := case
    when new.revises_version_id is not null then
      coalesce((select b.form_rules from public.booking_versions b where b.id = new.revises_version_id), 1)
    when coalesce(current_setting('tripnavigate.booking_form_rules', true), '') = '2'
         and new.service_type = 'package' then 2
    else 1 end;
  return new;
end;
$$;
create trigger booking_versions_0_form_rules
  before insert on public.booking_versions
  for each row execute function authz.booking_versions_form_rules();

-- Replaces 20261119000300: form_rules joins the identity columns; a draft may
-- move from hash schema 2 to 3 only inside this migration's upgrade.
create or replace function authz.booking_versions_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'confirmed booking versions are immutable' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if old.status <> 'draft' then
      if old.status = 'confirmed' and new.status = 'superseded'
         and coalesce(current_setting('tripnavigate.booking_supersede', true), '') = old.id::text
         and (to_jsonb(new) - array['status', 'superseded_by_version_id', 'superseded_at', 'updated_at'])
             = (to_jsonb(old) - array['status', 'superseded_by_version_id', 'superseded_at', 'updated_at']) then
        return new;
      end if;
      raise exception 'confirmed booking versions are immutable' using errcode = '42501';
    end if;
    if new.id is distinct from old.id or new.deal_id is distinct from old.deal_id
       or new.legal_entity_id is distinct from old.legal_entity_id
       or new.branch_id is distinct from old.branch_id or new.version_no is distinct from old.version_no
       or new.service_type is distinct from old.service_type or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at
       -- Booking form: the one-way 2 -> 3 move of this migration only.
       or (new.hash_schema is distinct from old.hash_schema
           and not (old.hash_schema = 2 and new.hash_schema = 3
                    and coalesce(current_setting('tripnavigate.booking_hash_upgrade', true), '') = 'on'))
       -- Booking form: form rules move only 1 -> 2, on a first package draft,
       -- inside booking_form_start or the quotation conversion (setting).
       or (new.form_rules is distinct from old.form_rules
           and not (old.form_rules = 1 and new.form_rules = 2 and old.service_type = 'package'
                    and old.revises_version_id is null
                    and coalesce(current_setting('tripnavigate.booking_form_rules', true), '') = '2'))
       -- B1.1 revision
       or new.revises_version_id is distinct from old.revises_version_id then
      raise exception 'booking version identity columns are immutable' using errcode = '42501';
    end if;
    if new.status = 'superseded' then
      raise exception 'only an accepted version can be superseded' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- ===========================================================================
-- 2. Contacts, identity extras
-- ===========================================================================

alter table public.booking_version_contacts
  add column customer_type text check (customer_type in ('individual', 'b2d', 'corporate', 'travel_agent')),
  add column market text check (market in ('india', 'uae', 'other'));
comment on column public.booking_version_contacts.customer_type is
  'Booking form label only (no tax, currency, company or price effect).';

alter table public.traveller_identities
  add column date_of_marriage date check (date_of_marriage between date '1900-01-01' and date '2100-12-31'),
  add column phone text check (phone ~ '^[6-9][0-9]{9}$' or phone ~ '^\+[1-9][0-9]{6,14}$'),
  add column email text check (length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  add constraint traveller_identities_marriage_after_birth
    check (date_of_marriage is null or date_of_birth is null or date_of_marriage >= date_of_birth);

-- ===========================================================================
-- 3. Per-person package prices
-- ===========================================================================

create table public.booking_version_price_lines (
  booking_version_id uuid not null,
  legal_entity_id uuid not null,
  deal_id uuid not null,
  category text not null check (category in ('adult', 'child_bed', 'child_no_bed', 'infant')),
  quantity smallint not null check (quantity between 0 and 100),
  -- INR paise per person for the whole package; both null = not priced yet.
  purchase_paise bigint check (purchase_paise between 0 and 99999999999),
  sale_paise bigint check (sale_paise between 0 and 99999999999),
  -- May be negative (below-purchase sale): flagged by readiness, never clamped.
  markup_paise bigint generated always as (sale_paise - purchase_paise) stored,
  updated_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (booking_version_id, category),
  foreign key (legal_entity_id, deal_id, booking_version_id) references public.booking_versions (legal_entity_id, deal_id, id),
  check ((purchase_paise is null) = (sale_paise is null)),
  check (quantity > 0 or (purchase_paise is null and sale_paise is null))
);
create index booking_version_price_lines_deal_idx on public.booking_version_price_lines (deal_id);
create index booking_version_price_lines_entity_version_idx
  on public.booking_version_price_lines (legal_entity_id, deal_id, booking_version_id);
create index booking_version_price_lines_updated_by_idx on public.booking_version_price_lines (updated_by);
comment on table public.booking_version_price_lines is
  'Per-person package prices of one booking version (adult, child with bed, child without bed, infant): purchase and final sale per person in paise; markup derived. Commercial readers only (deal.read_commercial); never Purchase, Flight, the Visa desk or Super Admin. No Data API read. Immutable once the version is not a draft. Changes draw a new commercial_revision (hash).';

-- ===========================================================================
-- 4. Supplier estimates
-- ===========================================================================

create table public.service_item_cost_estimates (
  booking_version_id uuid not null,
  service_item_id uuid not null,
  legal_entity_id uuid not null,
  -- Hotel, nightly: per room, per extra bed, per no-bed guest.
  room_rate_paise bigint check (room_rate_paise between 0 and 99999999999),
  extra_bed_rate_paise bigint check (extra_bed_rate_paise between 0 and 99999999999),
  no_bed_rate_paise bigint check (no_bed_rate_paise between 0 and 99999999999),
  -- Car (transfer): per vehicle for the whole trip.
  vehicle_rate_paise bigint check (vehicle_rate_paise between 0 and 99999999999),
  -- Flight: estimated fare, total.
  fare_total_paise bigint check (fare_total_paise between 0 and 99999999999),
  updated_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (booking_version_id, service_item_id),
  foreign key (service_item_id, booking_version_id)
    references public.service_item_facts (service_item_id, booking_version_id) on delete cascade,
  foreign key (legal_entity_id, service_item_id) references public.service_items (legal_entity_id, id)
);
create index service_item_cost_estimates_item_idx on public.service_item_cost_estimates (service_item_id);
create index service_item_cost_estimates_entity_item_idx on public.service_item_cost_estimates (legal_entity_id, service_item_id);
create index service_item_cost_estimates_updated_by_idx on public.service_item_cost_estimates (updated_by);
comment on table public.service_item_cost_estimates is
  'Supplier cost estimates of one service item inside one booking version (unknown = null, never zero). Cost side only: never a selling value, never copied into the purchase budget or the per-person purchase. Readers: commercial readers and the assignee of that item''s department task. No Data API read. Immutable once the version is not a draft.';

-- ===========================================================================
-- 5. Private item files (flight screenshot)
-- ===========================================================================

create table public.service_item_files (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null,
  legal_entity_id uuid not null,
  service_item_id uuid not null,
  booking_version_id uuid not null,
  kind text not null check (kind = 'flight_screenshot'),
  request_id uuid not null,
  object_path text not null unique,
  file_name text not null check (length(file_name) between 1 and 120 and file_name ~ '^[A-Za-z0-9._ -]+$'),
  mime text not null check (mime in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 4194304),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending_upload' check (status in ('pending_upload', 'stored', 'failed', 'removed')),
  row_version integer not null default 1 check (row_version >= 1),
  uploaded_by uuid not null references public.staff_profiles (user_id),
  removed_by uuid references public.staff_profiles (user_id),
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  stored_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  foreign key (legal_entity_id, service_item_id) references public.service_items (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id, booking_version_id) references public.booking_versions (legal_entity_id, deal_id, id),
  constraint service_item_files_path_check
    check (object_path = legal_entity_id::text || '/' || deal_id::text || '/' || service_item_id::text || '/' || id::text),
  constraint service_item_files_stored_check check (status <> 'stored' or stored_at is not null),
  constraint service_item_files_removed_check check ((status = 'removed') = (removed_at is not null)),
  constraint service_item_files_request_unique unique (deal_id, request_id)
);
create index service_item_files_item_idx on public.service_item_files (service_item_id, status);
create index service_item_files_entity_deal_idx on public.service_item_files (legal_entity_id, deal_id);
create index service_item_files_entity_item_idx on public.service_item_files (legal_entity_id, service_item_id);
create index service_item_files_version_idx on public.service_item_files (legal_entity_id, deal_id, booking_version_id);
create index service_item_files_uploaded_by_idx on public.service_item_files (uploaded_by);
create index service_item_files_removed_by_idx on public.service_item_files (removed_by) where removed_by is not null;
comment on table public.service_item_files is
  'Private files of one service item (flight screenshot of the requested flight). Readers: booking editors and acceptors and the Flight assignee of that item; never Purchase, Accounts or Super Admin by role. No Data API read; never hashed; soft removal only; kept.';

-- Rows are never deleted; identity columns never change; status moves
-- pending_upload -> stored | failed and any open state -> removed (final).
create function authz.service_item_files_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'service item files are never deleted' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'pending_upload' or new.row_version <> 1 or new.removed_at is not null or new.removed_by is not null then
      raise exception 'a service item file starts as pending_upload' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id or new.deal_id is distinct from old.deal_id
     or new.legal_entity_id is distinct from old.legal_entity_id or new.service_item_id is distinct from old.service_item_id
     or new.booking_version_id is distinct from old.booking_version_id or new.kind is distinct from old.kind
     or new.request_id is distinct from old.request_id or new.object_path is distinct from old.object_path
     or new.file_name is distinct from old.file_name or new.mime is distinct from old.mime
     or new.size_bytes is distinct from old.size_bytes or new.sha256 is distinct from old.sha256
     or new.uploaded_by is distinct from old.uploaded_by or new.created_at is distinct from old.created_at then
    raise exception 'service item file identity columns are immutable' using errcode = '42501';
  end if;
  if old.status = 'removed'
     or (new.status is distinct from old.status and not (
           (old.status = 'pending_upload' and new.status in ('stored', 'failed'))
           or new.status = 'removed')) then
    raise exception 'service item file status change not allowed' using errcode = '42501';
  end if;
  new.row_version := old.row_version + 1;
  new.updated_at := now();
  return new;
end;
$$;
create trigger service_item_files_a_guard
  before insert or update or delete on public.service_item_files
  for each row execute function authz.service_item_files_guard();

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('service-item-files', 'service-item-files', false, 4194304,
      array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;

-- ===========================================================================
-- 6. Bill To columns
-- ===========================================================================

alter table public.customer_billing_profiles
  add column bill_to_type text check (bill_to_type in ('personal', 'business')),
  add column contact_person text check (length(contact_person) between 1 and 120),
  add column phone text check (phone ~ '^[6-9][0-9]{9}$' or phone ~ '^\+[1-9][0-9]{6,14}$'),
  add column email text check (length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  add column gst_status text check (gst_status in ('registered', 'unregistered')),
  add column gst_reason text check (length(gst_reason) between 10 and 500),
  add constraint customer_billing_profiles_personal_no_gst
    check (bill_to_type is distinct from 'personal' or (gst_status is null and gst_reason is null and contact_person is null)),
  add constraint customer_billing_profiles_unregistered_no_gstin
    check (gst_status is distinct from 'unregistered' or gstin is null),
  add constraint customer_billing_profiles_reason_unregistered
    check (gst_reason is null or gst_status = 'unregistered');
comment on column public.customer_billing_profiles.bill_to_type is
  'Booking form Bill To type. Null on a profile saved before the booking form: read as the booking contact''s booking_for.';
comment on column public.customer_billing_profiles.gst_status is
  'Business only: registered (GSTIN format checked, not a registration check) or unregistered (reason recorded, no GSTIN). Not a tax decision.';

-- ===========================================================================
-- 7. Guards, touch and hash triggers of the new version rows
-- ===========================================================================

create trigger booking_version_price_lines_a_guard
  before insert or update or delete on public.booking_version_price_lines
  for each row execute function authz.b11_version_child_guard();
create trigger booking_version_price_lines_a_touch before update on public.booking_version_price_lines
  for each row execute function authz.b11_touch();
-- Prices are commercial: a change draws a new commercial_revision (the plan's trigger).
create trigger booking_version_price_lines_b_revision
  after insert or update or delete on public.booking_version_price_lines
  for each row execute function authz.b11_plan_revision();

create trigger service_item_cost_estimates_a_guard
  before insert or update or delete on public.service_item_cost_estimates
  for each row execute function authz.b11_version_child_guard();
create trigger service_item_cost_estimates_a_touch before update on public.service_item_cost_estimates
  for each row execute function authz.b11_touch();
create trigger service_item_cost_estimates_b_rehash
  after insert or update or delete on public.service_item_cost_estimates
  for each row execute function authz.b11_rehash_version();

-- Replaces 20261119000300: hash schema 3 adds the party counts, the contact
-- labels and the supplier estimates to schema 2.
create or replace function authz.booking_package_hash_row(v public.booking_versions) returns text
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
  )
  -- Booking form: hash schema 3.
  || case when v.hash_schema >= 3 then jsonb_build_object(
       'schema', 3,
       'party', jsonb_build_array(v.pax_total, v.children_count, v.infants_count),
       'contactLabels', (select jsonb_build_array(c.customer_type, c.market)
                         from public.booking_version_contacts c where c.booking_version_id = v.id),
       'estimates', coalesce((
         select jsonb_agg(jsonb_build_array(i.item_no, e.room_rate_paise, e.extra_bed_rate_paise, e.no_bed_rate_paise,
             e.vehicle_rate_paise, e.fare_total_paise) order by i.item_no)
         from public.service_item_cost_estimates e join public.service_items i on i.id = e.service_item_id
         where e.booking_version_id = v.id), '[]'::jsonb))
     else '{}'::jsonb end
  || case when v.revises_version_id is not null
         then jsonb_build_object('revision', jsonb_build_array(v.revises_version_id, v.change_class))
         else '{}'::jsonb end end::text, 'UTF8')), 'hex')
$$;

-- Existing package drafts follow schema 3 (their hash changes; drafts are
-- optimistic, the next save reloads). Confirmed and other rows are unchanged.
select set_config('tripnavigate.booking_hash_upgrade', 'on', true);
update public.booking_versions v set hash_schema = 3
where v.service_type = 'package' and v.status = 'draft' and v.hash_schema = 2;
select set_config('tripnavigate.booking_hash_upgrade', '', true);
alter table public.booking_versions alter column hash_schema set default 3;

do $$
begin
  if exists (select 1 from public.booking_versions v where v.status <> 'draft' and v.hash_schema = 3) then
    raise exception 'booking form: a non-draft version changed hash schema' using errcode = '55000';
  end if;
  if exists (select 1 from public.booking_versions v where v.form_rules <> 1) then
    raise exception 'booking form: an existing version did not keep form rules 1' using errcode = '55000';
  end if;
end;
$$;

-- ===========================================================================
-- 8. Row level security and privileges (definer functions only)
-- ===========================================================================

do $$
declare
  t text;
begin
  foreach t in array array['booking_version_price_lines', 'service_item_cost_estimates', 'service_item_files'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

revoke all on function authz.booking_versions_form_rules(), authz.service_item_files_guard()
from public, anon, authenticated, service_role;

commit;
