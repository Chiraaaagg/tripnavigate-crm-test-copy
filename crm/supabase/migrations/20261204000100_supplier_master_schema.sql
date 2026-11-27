-- Accounts phase 2, Track A (1): supplier and hotel master — schema.
-- Contract: accounts-phase2-2026-11-11/contract.md sections 5.1-5.4, 5.6
-- (import kind), 13.1; Addendum L2 (supplier kind values 'direct' and
-- 'channel'; the older proposed value trips the excluded-portal scope guard).
--
-- What changes:
--   * authz.supplier_name_key(text): the normalised name used for
--     near-duplicate warnings (lower-case, [a-z0-9 ] only, the words hotel,
--     hotels, resort, the, pvt, private, ltd, limited, llp, travels, tours and
--     "and" dropped, spaces removed). Mirrored in S/modules/suppliers/validate.ts.
--   * public.suppliers: supplier_kind (direct|channel), gstin, pan,
--     state_code, address, tally_ledger_name, source_ref (unique per entity),
--     import_batch_id, name_key (generated) with their checks and indexes.
--     Exact same name stays blocked (suppliers_entity_name_key, unchanged).
--   * hotel_catalogue gains unique (legal_entity_id, id); purchase_quotes and
--     service_item_facts gain catalogue_hotel_id (composite FK to the
--     catalogue; LD22: a column, never a facts key, so facts_hash, the
--     fixed-key readers and the Purchase diff stay unchanged).
--   * New tables supplier_contacts (one active primary per supplier),
--     supplier_hotels (which suppliers sell which catalogue hotels; several
--     suppliers per hotel, owner Q9) and supplier_changes (append-only
--     history; written by triggers on suppliers and on bank detail revisions,
--     and by the contact and hotel-link commands). History never holds an
--     account number, IFSC or account holder: a bank row reads
--     "revision <n> (…<last4>) <status>".
--   * Backfill: one primary contact per supplier from the legacy contact
--     columns when a phone or an e-mail is set (a contact needs one of them;
--     a name-only legacy contact stays in the legacy columns only). Legacy
--     columns are not changed.
--   * import_batches: kind 'supplier' (no branch, never entity-wide, like
--     hotels).
--
-- No new refusal tokens here (see 20261204000110).
--
-- Rollback (forward-only): a new migration dropping the triggers
-- suppliers_z_changes and supplier_beneficiary_revisions_z_changes; the new
-- tables and columns stay (data), commands are restored by later migrations.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Name key
-- ===========================================================================

create function authz.supplier_name_key(p_name text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select replace(
    regexp_replace(
      ' ' || regexp_replace(lower(coalesce(p_name, '')), '[^a-z0-9 ]', ' ', 'g') || ' ',
      '\m(hotel|hotels|resort|the|pvt|private|ltd|limited|llp|travels|tours|and)\M', ' ', 'g'),
    ' ', '')
$$;
revoke all on function authz.supplier_name_key(text) from public, anon, authenticated, service_role;

-- ===========================================================================
-- 2. Suppliers: new columns
-- ===========================================================================

alter table public.suppliers
  add column supplier_kind text not null default 'direct' check (supplier_kind in ('direct', 'channel')),
  add column gstin text check (gstin is null or gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'),
  add column pan text check (pan is null or pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  add column state_code text check (state_code is null or state_code ~ '^(0[1-9]|[12][0-9]|3[0-8]|97)$'),
  add column address text check (address is null or (char_length(address) between 1 and 300 and address !~ '[[:cntrl:]]')),
  add column tally_ledger_name text
    check (tally_ledger_name is null or (char_length(tally_ledger_name) between 1 and 100 and tally_ledger_name !~ '[[:cntrl:]]')),
  add column source_ref text check (source_ref is null or source_ref ~ '^[A-Za-z0-9._:/-]{1,80}$'),
  add column import_batch_id uuid references public.import_batches (id),
  add column name_key text generated always as (authz.supplier_name_key(name)) stored;

alter table public.suppliers
  add constraint suppliers_gstin_pan_match check (gstin is null or pan is null or substr(gstin, 3, 10) = pan),
  add constraint suppliers_gstin_state_match check (gstin is null or state_code is null or left(gstin, 2) = state_code);

create unique index suppliers_source_ref_key on public.suppliers (legal_entity_id, source_ref) where source_ref is not null;
create index suppliers_import_batch_idx on public.suppliers (import_batch_id) where import_batch_id is not null;
create index suppliers_name_key_idx on public.suppliers (legal_entity_id, name_key text_pattern_ops);
create index suppliers_gstin_idx on public.suppliers (legal_entity_id, gstin) where gstin is not null;
create index suppliers_pan_idx on public.suppliers (legal_entity_id, pan) where pan is not null;

comment on column public.suppliers.supplier_kind is
  'direct = the hotel or service itself; channel = an intermediary or booking channel (screen label per Addendum L2).';
comment on column public.suppliers.name_key is
  'authz.supplier_name_key(name): near-duplicate warnings only; never a match key (imports match by source_ref).';

-- ===========================================================================
-- 3. Catalogue hotel id on quotes and booking facts (LD22)
-- ===========================================================================

alter table public.hotel_catalogue add constraint hotel_catalogue_entity_id_key unique (legal_entity_id, id);

alter table public.purchase_quotes add column catalogue_hotel_id uuid;
alter table public.purchase_quotes add constraint purchase_quotes_catalogue_hotel_fkey
  foreign key (legal_entity_id, catalogue_hotel_id) references public.hotel_catalogue (legal_entity_id, id);
create index purchase_quotes_catalogue_hotel_idx on public.purchase_quotes (legal_entity_id, catalogue_hotel_id)
  where catalogue_hotel_id is not null;

alter table public.service_item_facts add column catalogue_hotel_id uuid;
alter table public.service_item_facts add constraint service_item_facts_catalogue_hotel_fkey
  foreign key (legal_entity_id, catalogue_hotel_id) references public.hotel_catalogue (legal_entity_id, id);
create index service_item_facts_catalogue_hotel_idx on public.service_item_facts (legal_entity_id, catalogue_hotel_id)
  where catalogue_hotel_id is not null;

-- ===========================================================================
-- 4. Supplier contacts
-- ===========================================================================

create table public.supplier_contacts (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  supplier_id uuid not null,
  name text not null check (char_length(name) between 1 and 120 and name !~ '[[:cntrl:]]'),
  role_label text check (role_label is null or (char_length(role_label) between 1 and 60 and role_label !~ '[[:cntrl:]]')),
  phone text check (phone is null or phone ~ '^[0-9+() -]{6,40}$'),
  email text check (email is null
    or (length(email) <= 254 and email ~ '^[^@[:space:]]{1,64}@[^@[:space:]]+\.[^@[:space:]]{2,}$')),
  is_primary boolean not null default false,
  status text not null default 'active' check (status in ('active', 'removed')),
  row_version integer not null default 1 check (row_version >= 1),
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_by uuid not null references public.staff_profiles (user_id),
  updated_at timestamptz not null default now(),
  removed_by uuid references public.staff_profiles (user_id),
  removed_at timestamptz,
  remove_reason text check (remove_reason is null or char_length(remove_reason) between 10 and 300),
  constraint supplier_contacts_reach check (phone is not null or email is not null),
  constraint supplier_contacts_removed check ((status = 'removed') = (removed_by is not null and removed_at is not null
                                                                       and remove_reason is not null)),
  constraint supplier_contacts_removed_not_primary check (status = 'active' or not is_primary),
  foreign key (legal_entity_id, supplier_id) references public.suppliers (legal_entity_id, id),
  unique (legal_entity_id, id)
);
create unique index supplier_contacts_one_primary on public.supplier_contacts (supplier_id)
  where is_primary and status = 'active';
create index supplier_contacts_supplier_idx on public.supplier_contacts (legal_entity_id, supplier_id);
create index supplier_contacts_supplier_only_idx on public.supplier_contacts (supplier_id, status);
create index supplier_contacts_created_by_idx on public.supplier_contacts (created_by);
create index supplier_contacts_updated_by_idx on public.supplier_contacts (updated_by);
create index supplier_contacts_removed_by_idx on public.supplier_contacts (removed_by) where removed_by is not null;
comment on table public.supplier_contacts is
  'Accounts phase 2: several contacts per supplier, at most one active primary. LD23: the commands keep suppliers.contact_name/phone/email equal to the active primary contact. Never deleted; removed is final. No Data API access.';

create function authz.supplier_contacts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'supplier contacts are never deleted' using errcode = '42501';
  end if;
  if new.supplier_id is distinct from old.supplier_id or new.legal_entity_id is distinct from old.legal_entity_id
     or new.id is distinct from old.id or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'supplier contact identity is immutable' using errcode = '42501';
  end if;
  if old.status = 'removed' then
    raise exception 'a removed supplier contact is final' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger supplier_contacts_a_guard before update or delete on public.supplier_contacts
  for each row execute function authz.supplier_contacts_guard();

-- ===========================================================================
-- 5. Supplier ↔ hotel links (owner Q9: several suppliers per hotel)
-- ===========================================================================

create table public.supplier_hotels (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  supplier_id uuid not null,
  hotel_id uuid not null,
  source text not null check (source in ('quote', 'manual', 'import')),
  first_quote_id uuid references public.purchase_quotes (id),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  removed_by uuid references public.staff_profiles (user_id),
  removed_at timestamptz,
  remove_reason text check (remove_reason is null or char_length(remove_reason) between 10 and 300),
  constraint supplier_hotels_removed check ((status = 'removed') = (removed_by is not null and removed_at is not null
                                                                     and remove_reason is not null)),
  constraint supplier_hotels_quote_source check ((source = 'quote') = (first_quote_id is not null)),
  foreign key (legal_entity_id, supplier_id) references public.suppliers (legal_entity_id, id),
  foreign key (legal_entity_id, hotel_id) references public.hotel_catalogue (legal_entity_id, id)
);
create unique index supplier_hotels_active_key on public.supplier_hotels (supplier_id, hotel_id) where status = 'active';
create index supplier_hotels_supplier_idx on public.supplier_hotels (legal_entity_id, supplier_id);
create index supplier_hotels_hotel_idx on public.supplier_hotels (legal_entity_id, hotel_id, status);
create index supplier_hotels_first_quote_idx on public.supplier_hotels (first_quote_id) where first_quote_id is not null;
create index supplier_hotels_created_by_idx on public.supplier_hotels (created_by);
create index supplier_hotels_removed_by_idx on public.supplier_hotels (removed_by) where removed_by is not null;
comment on table public.supplier_hotels is
  'Accounts phase 2: which suppliers sell which catalogue hotels (from Purchase quotes, by hand, or an import). Several suppliers per hotel. Never deleted; removed is final. No Data API access.';

create function authz.supplier_hotels_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'supplier hotel links are never deleted' using errcode = '42501';
  end if;
  if old.status = 'removed' then
    raise exception 'a removed supplier hotel link is final' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['status', 'removed_by', 'removed_at', 'remove_reason'])
     is distinct from (to_jsonb(old) - array['status', 'removed_by', 'removed_at', 'remove_reason']) then
    raise exception 'supplier hotel link facts are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger supplier_hotels_a_guard before update or delete on public.supplier_hotels
  for each row execute function authz.supplier_hotels_guard();

-- ===========================================================================
-- 6. Change history (append-only)
-- ===========================================================================

create table public.supplier_changes (
  id bigint generated always as identity primary key,
  legal_entity_id uuid not null,
  supplier_id uuid not null,
  changed_at timestamptz not null default now(),
  changed_by uuid not null references public.staff_profiles (user_id),
  source text not null check (source in ('edit', 'import', 'verify', 'contact', 'hotel_link', 'bank')),
  field text not null check (char_length(field) between 1 and 60),
  old_value text check (old_value is null or char_length(old_value) <= 1000),
  new_value text check (new_value is null or char_length(new_value) <= 1000),
  request_id uuid,
  foreign key (legal_entity_id, supplier_id) references public.suppliers (legal_entity_id, id)
);
create index supplier_changes_supplier_idx on public.supplier_changes (supplier_id, changed_at desc, id desc);
create index supplier_changes_entity_supplier_idx on public.supplier_changes (legal_entity_id, supplier_id);
create index supplier_changes_changed_by_idx on public.supplier_changes (changed_by);
comment on table public.supplier_changes is
  'Accounts phase 2: supplier change history (who, when, field, old and new value). Append-only. Bank rows carry only the revision number, the last 4 digits and the status. PAN is masked on read except for Accounts and Managers. No Data API access.';

create function authz.supplier_changes_append_only() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'supplier change history is append-only' using errcode = '42501';
end;
$$;
create trigger supplier_changes_a_append_only before update or delete on public.supplier_changes
  for each row execute function authz.supplier_changes_append_only();

-- The change source a command set for this transaction ('' = not set).
create function authz.supplier_change_source() returns text
language sql stable set search_path = '' as $$
  select nullif(coalesce(current_setting('tripnavigate.supplier_change_source', true), ''), '')
$$;

-- One history row per changed column of a supplier.
create function authz.supplier_changes_on_update() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_source text := authz.supplier_change_source();
  v_by uuid := coalesce((select auth.uid()), new.updated_by);
  c record;
  v_only_verify boolean := true;
  v_any boolean := false;
begin
  for c in
    select x.field, x.old_value, x.new_value from (values
      ('name', old.name, new.name),
      ('service_types', array_to_string(old.service_types, ';'), array_to_string(new.service_types, ';')),
      ('city', old.city, new.city),
      ('contact_name', old.contact_name, new.contact_name),
      ('contact_phone', old.contact_phone, new.contact_phone),
      ('contact_email', old.contact_email, new.contact_email),
      ('payment_terms', old.payment_terms, new.payment_terms),
      ('status', old.status, new.status),
      ('verification_status', old.verification_status, new.verification_status),
      ('supplier_kind', old.supplier_kind, new.supplier_kind),
      ('gstin', old.gstin, new.gstin),
      ('pan', old.pan, new.pan),
      ('state_code', old.state_code, new.state_code),
      ('address', old.address, new.address),
      ('tally_ledger_name', old.tally_ledger_name, new.tally_ledger_name),
      ('source_ref', old.source_ref, new.source_ref)
    ) as x (field, old_value, new_value)
    where x.old_value is distinct from x.new_value
  loop
    v_any := true;
    if c.field <> 'verification_status' then
      v_only_verify := false;
    end if;
  end loop;
  if not v_any then
    return null;
  end if;
  insert into public.supplier_changes (legal_entity_id, supplier_id, changed_by, source, field, old_value, new_value)
  select new.legal_entity_id, new.id, v_by,
    coalesce(v_source, case when v_only_verify then 'verify' else 'edit' end),
    x.field, left(x.old_value, 1000), left(x.new_value, 1000)
  from (values
      ('name', old.name, new.name),
      ('service_types', array_to_string(old.service_types, ';'), array_to_string(new.service_types, ';')),
      ('city', old.city, new.city),
      ('contact_name', old.contact_name, new.contact_name),
      ('contact_phone', old.contact_phone, new.contact_phone),
      ('contact_email', old.contact_email, new.contact_email),
      ('payment_terms', old.payment_terms, new.payment_terms),
      ('status', old.status, new.status),
      ('verification_status', old.verification_status, new.verification_status),
      ('supplier_kind', old.supplier_kind, new.supplier_kind),
      ('gstin', old.gstin, new.gstin),
      ('pan', old.pan, new.pan),
      ('state_code', old.state_code, new.state_code),
      ('address', old.address, new.address),
      ('tally_ledger_name', old.tally_ledger_name, new.tally_ledger_name),
      ('source_ref', old.source_ref, new.source_ref)
    ) as x (field, old_value, new_value)
  where x.old_value is distinct from x.new_value;
  return null;
end;
$$;
create trigger suppliers_z_changes after update on public.suppliers
  for each row execute function authz.supplier_changes_on_update();

-- Bank detail revisions: the revision number, last 4 digits and status only.
create function authz.supplier_bank_changes() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_note text := 'revision ' || new.revision_no || ' (…' || right(new.account_number, 4) || ')';
begin
  if tg_op = 'INSERT' then
    insert into public.supplier_changes (legal_entity_id, supplier_id, changed_by, source, field, old_value, new_value)
    values (new.legal_entity_id, new.supplier_id, coalesce((select auth.uid()), new.created_by), 'bank', 'bank_revision',
      null, v_note || ' ' || new.status);
  elsif new.status is distinct from old.status then
    insert into public.supplier_changes (legal_entity_id, supplier_id, changed_by, source, field, old_value, new_value)
    values (new.legal_entity_id, new.supplier_id, coalesce((select auth.uid()), new.approved_by, new.created_by), 'bank',
      'bank_revision', v_note || ' ' || old.status, v_note || ' ' || new.status);
  end if;
  return null;
end;
$$;
create trigger supplier_beneficiary_revisions_z_changes after insert or update on public.supplier_beneficiary_revisions
  for each row execute function authz.supplier_bank_changes();

-- ===========================================================================
-- 7. Row level security and privileges (no Data API access)
-- ===========================================================================

do $$
declare
  t text;
begin
  foreach t in array array['supplier_contacts', 'supplier_hotels', 'supplier_changes'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;
revoke all on sequence public.supplier_changes_id_seq from public, anon, authenticated, service_role;

revoke all on function authz.supplier_contacts_guard(), authz.supplier_hotels_guard(), authz.supplier_changes_append_only(),
  authz.supplier_change_source(), authz.supplier_changes_on_update(), authz.supplier_bank_changes()
from public, anon, authenticated, service_role;

-- ===========================================================================
-- 8. Backfill: one primary contact from the legacy columns (phone or e-mail set)
-- ===========================================================================

insert into public.supplier_contacts (legal_entity_id, supplier_id, name, phone, email, is_primary, created_by, updated_by,
  created_at, updated_at)
select s.legal_entity_id, s.id, coalesce(s.contact_name, 'Main contact'), s.contact_phone, s.contact_email, true,
  s.created_by, s.created_by, s.created_at, s.updated_at
from public.suppliers s
where s.contact_phone is not null or s.contact_email is not null;

-- ===========================================================================
-- 9. Supplier import batches (kind 'supplier': no branch, never entity-wide)
-- ===========================================================================

do $$
declare
  c record;
begin
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.import_batches'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%kind = ANY%'
  loop
    execute format('alter table public.import_batches drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table public.import_batches drop constraint import_batches_customer_scope;
alter table public.import_batches
  add constraint import_batches_kind_check check (kind in ('hotel', 'customer', 'supplier')),
  -- Customers: a branch, or the whole company chosen explicitly. Hotels and
  -- suppliers: neither (import_batches_hotel_no_branch, unchanged).
  add constraint import_batches_customer_scope check (kind <> 'customer' or ((branch_id is null) = entity_wide));

commit;
