-- Accounts phase 2, Track A (2): supplier and hotel master — commands.
-- Contract: accounts-phase2-2026-11-11/contract.md sections 5.5 (A1-A9),
-- 5.7 (near-duplicate warnings), 9, 13.1, 13.2; Addendum L2 (kind 'channel').
--
-- New helpers:
--   authz.supplier_near_duplicates(entity, except, name, city, gstin, pan,
--     ifsc, last4) -> [{supplierId, name, reasons}] (at most 10): similar
--     name (equal name key, or one key a prefix of the other with the shorter
--     at least 5 characters) AND the same city (LD24); same GSTIN; same PAN;
--     same bank (IFSC and last 4 digits of the latest revision). Warnings,
--     never blocks.
--   authz.supplier_master_values(fields, old row): supplierKind, gstin, pan,
--     stateCode, address (absent key = keep), with the GSTIN/PAN/state rules.
--   authz.supplier_can_edit(supplier): Flight for suppliers serving
--     flights, else Purchase (can_manage_suppliers).
--   authz.supplier_sync_legacy(supplier): LD23, suppliers.contact_name/
--     phone/email := the active primary contact (null when none).
--   authz.supplier_primary_from_legacy(supplier): the reverse, for the
--     legacy contact keys of supplier_create/update and Flight's commands.
--
-- Replaced (same signatures):
--   authz.supplier_fields_check (M/20261005000100:383) + supplierKind, gstin,
--     pan, stateCode, address.
--   public.supplier_create (M/20261005000100:551): new fields; primary
--     contact when a phone or e-mail is given; returns
--     {supplierId, rowVersion, warnings}.
--   public.supplier_update (M/20261201000230:76): new fields (an absent key
--     keeps the stored value); any change of details (incl. kind, GSTIN, PAN,
--     state, address) resets verification as before; primary contact follows
--     the legacy contact keys; returns warnings. Audit unchanged.
--   public.flight_supplier_create (M/20261201000210:1538) and
--     public.flight_supplier_update (M/20261201000240:28): the same new fields.
--   public.purchase_quote_add (M/20261130000110:40): + catalogueHotelId
--     (hotel tasks; an active catalogue hotel of the entity, else
--     invalid_input hint catalogueHotelId); the supplier is linked to the
--     hotel (source 'quote') when it sells hotels. Existing quotes untouched.
--   authz.vn_hotel_adults_default (M/20261128000110:1037): before stripping
--     catalogueHotelId from the facts, keeps it in
--     service_item_facts.catalogue_hotel_id (an id that is not an active or
--     inactive catalogue hotel of the entity is ignored). An insert without
--     the key that copies a revision base row keeps the base row's id; an
--     update without the key keeps the stored id unless the hotel name
--     changed. Strip and adults rules unchanged.
--
-- New commands (execute to authenticated):
--   supplier_contact_save(p_supplier_id uuid, p_contact_id uuid, p_expected_row_version integer,
--     p_fields jsonb, p_request_id uuid) -> {outcome, contactId, rowVersion, supplierRowVersion}
--   supplier_contact_remove(p_contact_id uuid, p_expected_row_version integer, p_reason text,
--     p_request_id uuid) -> {outcome, contactId, supplierRowVersion}
--   supplier_hotel_link(p_supplier_id uuid, p_hotel_id uuid, p_request_id uuid) -> {outcome, linkId}
--   supplier_hotel_unlink(p_link_id uuid, p_reason text, p_request_id uuid) -> {outcome, linkId}
--
-- Refusal tokens: 42501 not_authorized; 55000 environment_unset,
-- link_not_allowed; 22023 invalid_input (hint = field); 40001
-- version_changed, request_conflict; 23505 supplier_exists (Purchase),
-- duplicate_supplier (Flight, unchanged); P0002 not_found.
-- Audit: supplier.contact_saved {supplierId, contactId, primary},
-- supplier.contact_removed (reason), supplier.hotel_linked {supplierId,
-- hotelId, linkId}, supplier.hotel_unlinked (reason); supplier.created /
-- supplier.updated / flight.supplier_created unchanged. No contact values,
-- GSTIN, PAN or bank values in audit details.
-- Lock order (13.1): the supplier row first, then its contacts / links. No
-- Deal lock.
--
-- Rollback (forward-only): a new migration restoring the replaced bodies from
-- the migrations cited above and revoking the new commands.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Helpers
-- ===========================================================================

-- One text field, refused with the field as hint (booking_fact_text rules).
create function authz.supplier_text(p_fields jsonb, p_key text, p_max integer, p_multiline boolean) returns text
language plpgsql immutable set search_path = '' as $$
begin
  return authz.booking_fact_text(p_fields, p_key, p_max, p_multiline);
exception when sqlstate '22023' then
  raise exception 'invalid_input' using errcode = '22023', hint = p_key;
end;
$$;

-- supplierKind, gstin, pan, stateCode, address of a create or update. An
-- absent key keeps the stored value (create: kind 'direct', others null).
create function authz.supplier_master_values(p_fields jsonb, p_old public.suppliers) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_kind text := coalesce(p_old.supplier_kind, 'direct');
  v_gstin text := p_old.gstin;
  v_pan text := p_old.pan;
  v_state text := p_old.state_code;
  v_address text := p_old.address;
  v_t text;
begin
  if p_fields ? 'supplierKind' then
    v_t := authz.supplier_text(p_fields, 'supplierKind', 20, false);
    if v_t is null or v_t not in ('direct', 'channel') then
      raise exception 'invalid_input' using errcode = '22023', hint = 'supplierKind';
    end if;
    v_kind := v_t;
  end if;
  if p_fields ? 'gstin' then
    v_t := upper(regexp_replace(coalesce(authz.supplier_text(p_fields, 'gstin', 30, false), ''), '\s', '', 'g'));
    if v_t <> '' and v_t !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'gstin';
    end if;
    v_gstin := nullif(v_t, '');
  end if;
  if p_fields ? 'pan' then
    v_t := upper(regexp_replace(coalesce(authz.supplier_text(p_fields, 'pan', 20, false), ''), '\s', '', 'g'));
    if v_t <> '' and v_t !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'pan';
    end if;
    v_pan := nullif(v_t, '');
  end if;
  if p_fields ? 'stateCode' then
    v_t := authz.supplier_text(p_fields, 'stateCode', 2, false);
    if v_t is not null and v_t !~ '^(0[1-9]|[12][0-9]|3[0-8]|97)$' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'stateCode';
    end if;
    v_state := v_t;
  end if;
  if p_fields ? 'address' then
    v_address := authz.supplier_text(p_fields, 'address', 300, false);
  end if;
  if v_gstin is not null and v_pan is not null and substr(v_gstin, 3, 10) <> v_pan then
    raise exception 'invalid_input' using errcode = '22023', hint = 'pan';
  end if;
  if v_gstin is not null and v_state is not null and left(v_gstin, 2) <> v_state then
    raise exception 'invalid_input' using errcode = '22023', hint = 'stateCode';
  end if;
  return jsonb_build_object('supplierKind', v_kind, 'gstin', v_gstin, 'pan', v_pan, 'stateCode', v_state,
    'address', v_address);
end;
$$;

-- Section 5.7: near-duplicate warnings (never a block), at most 10.
create function authz.supplier_near_duplicates(p_entity uuid, p_except uuid, p_name text, p_city text, p_gstin text,
  p_pan text, p_ifsc text, p_last4 text) returns jsonb
language sql stable security definer set search_path = '' as $$
  with k as (
    select authz.supplier_name_key(p_name) as key, nullif(lower(btrim(coalesce(p_city, ''))), '') as city
  ), pre as (
    select coalesce(array(select left(k.key, n) from generate_series(5, char_length(k.key) - 1) n), '{}'::text[]) as prefixes
    from k
  ), cand as (
    select s.id, 'similar_name_city'::text as reason
    from public.suppliers s, k, pre
    where s.legal_entity_id = p_entity and k.key <> '' and k.city is not null and lower(s.city) = k.city
      and (s.name_key = k.key
           or (char_length(k.key) >= 5 and s.name_key like k.key || '%')
           or s.name_key = any (pre.prefixes))
    union all
    select s.id, 'same_gstin' from public.suppliers s
    where nullif(btrim(coalesce(p_gstin, '')), '') is not null and s.legal_entity_id = p_entity and s.gstin = upper(btrim(p_gstin))
    union all
    select s.id, 'same_pan' from public.suppliers s
    where nullif(btrim(coalesce(p_pan, '')), '') is not null and s.legal_entity_id = p_entity and s.pan = upper(btrim(p_pan))
    union all
    select r.supplier_id, 'same_bank' from public.supplier_beneficiary_revisions r
    where nullif(btrim(coalesce(p_ifsc, '')), '') is not null and p_last4 ~ '^[0-9]{4}$'
      and r.legal_entity_id = p_entity and r.ifsc = upper(btrim(p_ifsc)) and right(r.account_number, 4) = p_last4
      and r.revision_no = (select max(x.revision_no) from public.supplier_beneficiary_revisions x where x.supplier_id = r.supplier_id)
  )
  select coalesce(jsonb_agg(jsonb_build_object('supplierId', y.id, 'name', y.name, 'reasons', to_jsonb(y.reasons))
           order by y.name_key, y.id), '[]'::jsonb)
  from (
    select s.id, s.name, s.name_key, array_agg(distinct c.reason order by c.reason) as reasons
    from cand c join public.suppliers s on s.id = c.id
    where c.id is distinct from p_except
    group by s.id, s.name, s.name_key
    order by s.name_key, s.id
    limit 10
  ) y
$$;

-- A4/A5 caller: Flight for suppliers serving flights, else Purchase.
create function authz.supplier_can_edit(p_supplier uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case when 'flight' = any (s.service_types)
                then coalesce(authz.session_ok(), false) and authz.holds_active_role('flight', s.legal_entity_id)
                else authz.can_manage_suppliers(s.legal_entity_id) end
    from public.suppliers s where s.id = p_supplier), false)
$$;

-- "Name · phone · e-mail · primary" for the history of one contact.
create function authz.supplier_contact_note(c public.supplier_contacts) returns text
language sql immutable set search_path = '' as $$
  select case when c.id is null then null else left(concat_ws(' · ', c.name, c.role_label, c.phone, c.email,
    case when c.status = 'removed' then 'removed' when c.is_primary then 'primary' end), 1000) end
$$;

-- LD23: the legacy contact columns follow the active primary contact. Bumps
-- the supplier row version (an open edit form then refreshes) but keeps
-- verification and updated_by (a contact is not a verified detail).
create function authz.supplier_sync_legacy(p_supplier uuid) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_c public.supplier_contacts%rowtype;
  v_rv integer;
begin
  select * into v_c from public.supplier_contacts c
  where c.supplier_id = p_supplier and c.status = 'active' and c.is_primary;
  perform set_config('tripnavigate.supplier_change_source', 'contact', true);
  update public.suppliers s
  set contact_name = v_c.name, contact_phone = v_c.phone, contact_email = v_c.email,
      row_version = s.row_version + 1, updated_at = now()
  where s.id = p_supplier
    and (s.contact_name, s.contact_phone, s.contact_email) is distinct from (v_c.name, v_c.phone, v_c.email);
  perform set_config('tripnavigate.supplier_change_source', '', true);
  select s.row_version into v_rv from public.suppliers s where s.id = p_supplier;
  return v_rv;
end;
$$;

-- The legacy contact keys of the supplier forms drive the primary contact:
-- update it (or add one when a phone or e-mail is given); with neither, the
-- primary is removed (no other contact is promoted).
create function authz.supplier_primary_from_legacy(p_s public.suppliers) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_c public.supplier_contacts%rowtype;
  v_uid uuid := coalesce((select auth.uid()), p_s.updated_by);
begin
  select * into v_c from public.supplier_contacts c
  where c.supplier_id = p_s.id and c.status = 'active' and c.is_primary for update;
  if p_s.contact_phone is null and p_s.contact_email is null then
    if v_c.id is not null then
      update public.supplier_contacts c
      set status = 'removed', is_primary = false, removed_by = v_uid, removed_at = now(),
          remove_reason = 'Contact cleared in the supplier details', row_version = c.row_version + 1,
          updated_by = v_uid, updated_at = now()
      where c.id = v_c.id;
    end if;
    return;
  end if;
  if v_c.id is null then
    insert into public.supplier_contacts (legal_entity_id, supplier_id, name, phone, email, is_primary, created_by, updated_by)
    values (p_s.legal_entity_id, p_s.id, coalesce(p_s.contact_name, 'Main contact'), p_s.contact_phone, p_s.contact_email,
      true, v_uid, v_uid);
  elsif (v_c.name, v_c.phone, v_c.email) is distinct from (coalesce(p_s.contact_name, v_c.name), p_s.contact_phone, p_s.contact_email) then
    update public.supplier_contacts c
    set name = coalesce(p_s.contact_name, c.name), phone = p_s.contact_phone, email = p_s.contact_email,
        row_version = c.row_version + 1, updated_by = v_uid, updated_at = now()
    where c.id = v_c.id;
  end if;
end;
$$;

-- The latest bank revision's IFSC and last 4 digits (for same_bank warnings).
create function authz.supplier_bank_key(p_supplier uuid, out ifsc text, out last4 text)
language sql stable security definer set search_path = '' as $$
  select r.ifsc, right(r.account_number, 4) from public.supplier_beneficiary_revisions r
  where r.supplier_id = p_supplier order by r.revision_no desc limit 1
$$;

-- Warnings for a stored supplier (after create / update).
create function authz.supplier_warnings(p_supplier uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select authz.supplier_near_duplicates(s.legal_entity_id, s.id, s.name, s.city, s.gstin, s.pan, b.ifsc, b.last4)
  from public.suppliers s left join lateral authz.supplier_bank_key(s.id) b on true
  where s.id = p_supplier
$$;

-- Supplier field allowlist (replaces 20261005000100): + supplierKind, gstin, pan, stateCode, address.
create or replace function authz.supplier_fields_check(p_fields jsonb) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['name', 'serviceTypes', 'city', 'contactName', 'contactPhone', 'contactEmail',
                          'paymentTerms', 'status',
                          -- Accounts phase 2 (20261204000110)
                          'supplierKind', 'gstin', 'pan', 'stateCode', 'address']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
end;
$$;

-- ===========================================================================
-- 2. Purchase supplier commands (A1, A2)
-- ===========================================================================

create or replace function public.supplier_create(p_entity_id uuid, p_fields jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid;
  v_name text;
  v_none public.suppliers%rowtype;
  v_m jsonb;
  v_s public.suppliers%rowtype;
begin
  if p_entity_id is null or not authz.can_manage_suppliers(p_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  perform authz.supplier_fields_check(p_fields);
  if p_fields ? 'status' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_name := authz.booking_fact_text(p_fields, 'name', 200, false);
  if v_name is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if exists (select 1 from public.suppliers s where s.legal_entity_id = p_entity_id and lower(s.name) = lower(v_name)) then
    raise exception 'supplier_exists' using errcode = '23505';
  end if;
  -- Accounts phase 2 (20261204000110): kind, GSTIN, PAN, state, address.
  v_m := authz.supplier_master_values(p_fields, v_none);

  begin
    insert into public.suppliers (legal_entity_id, name, service_types, city, contact_name, contact_phone,
      contact_email, payment_terms, supplier_kind, gstin, pan, state_code, address, created_by, updated_by)
    values (p_entity_id, v_name, authz.supplier_service_types(p_fields),
      authz.booking_fact_text(p_fields, 'city', 120, false),
      authz.booking_fact_text(p_fields, 'contactName', 120, false),
      authz.booking_fact_text(p_fields, 'contactPhone', 40, false),
      authz.booking_fact_text(p_fields, 'contactEmail', 254, false),
      authz.booking_fact_text(p_fields, 'paymentTerms', 1000, true),
      v_m ->> 'supplierKind', v_m ->> 'gstin', v_m ->> 'pan', v_m ->> 'stateCode', v_m ->> 'address',
      (select auth.uid()), (select auth.uid()))
    returning * into v_s;
  exception
    when unique_violation then
      raise exception 'supplier_exists' using errcode = '23505';
    when check_violation then
      raise exception 'invalid_input' using errcode = '22023';
  end;
  v_id := v_s.id;
  -- Accounts phase 2: the legacy contact keys make the primary contact.
  if v_s.contact_phone is not null or v_s.contact_email is not null then
    perform authz.supplier_primary_from_legacy(v_s);
  end if;

  perform authz.write_audit('supplier.created', p_entity_id, null, 'supplier', v_id, null,
    jsonb_build_object('serviceTypes', p_fields -> 'serviceTypes'));
  return jsonb_build_object('supplierId', v_id, 'rowVersion', 1, 'warnings', authz.supplier_warnings(v_id));
end;
$$;

-- Replaces 20261201000230: + kind, GSTIN, PAN, state, address (absent = keep),
-- primary contact follows the legacy keys, warnings in the result.
create or replace function public.supplier_update(p_supplier_id uuid, p_expected_row_version integer, p_fields jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_s public.suppliers%rowtype;
  v_name text;
  v_status text;
  v_types text[];
  v_city text;
  v_contact text;
  v_phone text;
  v_email text;
  v_terms text;
  v_m jsonb;
  v_details_changed boolean;
  v_contact_changed boolean;
  v_reset boolean;
  v_changed text[];
begin
  select * into v_s from public.suppliers s where s.id = p_supplier_id for update;
  if v_s.id is null or not authz.can_manage_suppliers(v_s.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Flight build (20261201000230): Flight owns its airline/consolidator suppliers.
  if 'flight' = any (v_s.service_types) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v_s.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  perform authz.supplier_fields_check(p_fields);
  v_name := authz.booking_fact_text(p_fields, 'name', 200, false);
  v_status := coalesce(authz.booking_fact_text(p_fields, 'status', 20, false), v_s.status);
  if v_name is null or v_status not in ('active', 'archived') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if exists (select 1 from public.suppliers s
             where s.legal_entity_id = v_s.legal_entity_id and lower(s.name) = lower(v_name) and s.id <> v_s.id) then
    raise exception 'supplier_exists' using errcode = '23505';
  end if;
  v_types := authz.supplier_service_types(p_fields);
  v_city := authz.booking_fact_text(p_fields, 'city', 120, false);
  v_contact := authz.booking_fact_text(p_fields, 'contactName', 120, false);
  v_phone := authz.booking_fact_text(p_fields, 'contactPhone', 40, false);
  v_email := authz.booking_fact_text(p_fields, 'contactEmail', 254, false);
  v_terms := authz.booking_fact_text(p_fields, 'paymentTerms', 1000, true);
  -- Accounts phase 2 (20261204000110).
  v_m := authz.supplier_master_values(p_fields, v_s);
  v_details_changed := (v_name, v_types, v_city, v_contact, v_phone, v_email, v_terms)
    is distinct from (v_s.name, v_s.service_types, v_s.city, v_s.contact_name, v_s.contact_phone, v_s.contact_email,
                      v_s.payment_terms)
    or (v_m ->> 'supplierKind', v_m ->> 'gstin', v_m ->> 'pan', v_m ->> 'stateCode', v_m ->> 'address')
       is distinct from (v_s.supplier_kind, v_s.gstin, v_s.pan, v_s.state_code, v_s.address);
  v_contact_changed := (v_contact, v_phone, v_email) is distinct from (v_s.contact_name, v_s.contact_phone, v_s.contact_email);
  v_reset := v_details_changed and v_s.verification_status = 'verified';

  begin
    update public.suppliers s set
      name = v_name,
      service_types = v_types,
      city = v_city,
      contact_name = v_contact,
      contact_phone = v_phone,
      contact_email = v_email,
      payment_terms = v_terms,
      supplier_kind = v_m ->> 'supplierKind',
      gstin = v_m ->> 'gstin',
      pan = v_m ->> 'pan',
      state_code = v_m ->> 'stateCode',
      address = v_m ->> 'address',
      status = v_status,
      verification_status = case when v_details_changed then 'unverified' else s.verification_status end,
      verified_by = case when v_details_changed then null else s.verified_by end,
      verified_at = case when v_details_changed then null else s.verified_at end,
      row_version = s.row_version + 1,
      updated_by = case when v_details_changed then (select auth.uid()) else s.updated_by end,
      updated_at = now()
    where s.id = v_s.id
    returning * into v_s;
  exception
    when unique_violation then
      raise exception 'supplier_exists' using errcode = '23505';
    when check_violation then
      raise exception 'invalid_input' using errcode = '22023';
  end;
  if v_contact_changed then
    perform authz.supplier_primary_from_legacy(v_s);
  end if;

  -- Field names only; contact values are not copied into the audit trail.
  select coalesce(array_agg(k order by k), '{}') into v_changed from jsonb_object_keys(p_fields) k;
  perform authz.write_audit('supplier.updated', v_s.legal_entity_id, null, 'supplier', v_s.id, null,
    jsonb_build_object('fields', to_jsonb(v_changed), 'rowVersion', v_s.row_version, 'status', v_s.status,
      'detailsChanged', v_details_changed, 'verificationReset', v_reset));
  return jsonb_build_object('supplierId', v_s.id, 'rowVersion', v_s.row_version,
    'warnings', authz.supplier_warnings(v_s.id));
end;
$$;

-- ===========================================================================
-- 3. Flight supplier commands (A3)
-- ===========================================================================

create or replace function public.flight_supplier_create(p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entity uuid;
  v_name text;
  v_payload jsonb := jsonb_build_object('fields', p_fields);
  v_result jsonb;
  v_none public.suppliers%rowtype;
  v_m jsonb;
  v_s public.suppliers%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_entity := authz.flight_caller_entity();
  if v_entity is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  v_result := authz.flight_replay(v_entity, p_request_id, 'flight_supplier_create', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['name', 'city', 'contactName', 'contactPhone', 'contactEmail',
                          -- Accounts phase 2 (20261204000110)
                          'supplierKind', 'gstin', 'pan', 'stateCode', 'address']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  begin
    v_name := authz.booking_fact_text(p_fields, 'name', 200, false);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'name';
  end;
  if v_name is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'name';
  end if;
  if exists (select 1 from public.suppliers s where s.legal_entity_id = v_entity and lower(s.name) = lower(v_name)) then
    raise exception 'duplicate_supplier' using errcode = '23505';
  end if;
  v_m := authz.supplier_master_values(p_fields, v_none);
  begin
    insert into public.suppliers (legal_entity_id, name, service_types, city, contact_name, contact_phone,
      contact_email, payment_terms, supplier_kind, gstin, pan, state_code, address, created_by, updated_by)
    values (v_entity, v_name, array['flight'],
      authz.booking_fact_text(p_fields, 'city', 120, false),
      authz.booking_fact_text(p_fields, 'contactName', 120, false),
      authz.booking_fact_text(p_fields, 'contactPhone', 40, false),
      authz.booking_fact_text(p_fields, 'contactEmail', 254, false),
      null, v_m ->> 'supplierKind', v_m ->> 'gstin', v_m ->> 'pan', v_m ->> 'stateCode', v_m ->> 'address',
      (select auth.uid()), (select auth.uid()))
    returning * into v_s;
  exception
    when unique_violation then
      raise exception 'duplicate_supplier' using errcode = '23505';
    when check_violation or sqlstate '22023' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end;
  if v_s.contact_phone is not null or v_s.contact_email is not null then
    perform authz.supplier_primary_from_legacy(v_s);
  end if;
  perform authz.write_audit('flight.supplier_created', v_entity, null, 'supplier', v_s.id, null,
    jsonb_build_object('serviceTypes', jsonb_build_array('flight')));
  v_result := jsonb_build_object('outcome', 'created', 'supplierId', v_s.id, 'rowVersion', 1,
    'warnings', authz.supplier_warnings(v_s.id));
  return authz.flight_remember(v_entity, p_request_id, 'flight_supplier_create', v_payload, v_result);
end;
$$;

create or replace function public.flight_supplier_update(p_supplier_id uuid, p_expected_row_version integer, p_fields jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_s public.suppliers%rowtype;
  v_name text;
  v_status text;
  v_city text;
  v_contact text;
  v_phone text;
  v_email text;
  v_m jsonb;
  v_details_changed boolean;
  v_contact_changed boolean;
  v_reset boolean;
  v_changed text[];
begin
  select * into v_s from public.suppliers s where s.id = p_supplier_id for update;
  if v_s.id is null or not coalesce(authz.session_ok(), false)
     or not authz.holds_active_role('flight', v_s.legal_entity_id) or v_s.service_types <> array['flight'] then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v_s.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['name', 'city', 'contactName', 'contactPhone', 'contactEmail', 'status',
                          -- Accounts phase 2 (20261204000110)
                          'supplierKind', 'gstin', 'pan', 'stateCode', 'address']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  begin
    v_name := authz.booking_fact_text(p_fields, 'name', 200, false);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'name';
  end;
  if v_name is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'name';
  end if;
  begin
    v_status := coalesce(authz.booking_fact_text(p_fields, 'status', 20, false), v_s.status);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'status';
  end;
  if v_status not in ('active', 'archived') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'status';
  end if;
  begin
    v_city := authz.booking_fact_text(p_fields, 'city', 120, false);
    v_contact := authz.booking_fact_text(p_fields, 'contactName', 120, false);
    v_phone := authz.booking_fact_text(p_fields, 'contactPhone', 40, false);
    v_email := authz.booking_fact_text(p_fields, 'contactEmail', 254, false);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end;
  if exists (select 1 from public.suppliers s
             where s.legal_entity_id = v_s.legal_entity_id and lower(s.name) = lower(v_name) and s.id <> v_s.id) then
    raise exception 'duplicate_supplier' using errcode = '23505';
  end if;
  v_m := authz.supplier_master_values(p_fields, v_s);
  v_details_changed := (v_name, v_city, v_contact, v_phone, v_email)
    is distinct from (v_s.name, v_s.city, v_s.contact_name, v_s.contact_phone, v_s.contact_email)
    or (v_m ->> 'supplierKind', v_m ->> 'gstin', v_m ->> 'pan', v_m ->> 'stateCode', v_m ->> 'address')
       is distinct from (v_s.supplier_kind, v_s.gstin, v_s.pan, v_s.state_code, v_s.address);
  v_contact_changed := (v_contact, v_phone, v_email) is distinct from (v_s.contact_name, v_s.contact_phone, v_s.contact_email);
  v_reset := v_details_changed and v_s.verification_status = 'verified';

  begin
    update public.suppliers s set
      name = v_name,
      city = v_city,
      contact_name = v_contact,
      contact_phone = v_phone,
      contact_email = v_email,
      supplier_kind = v_m ->> 'supplierKind',
      gstin = v_m ->> 'gstin',
      pan = v_m ->> 'pan',
      state_code = v_m ->> 'stateCode',
      address = v_m ->> 'address',
      status = v_status,
      verification_status = case when v_details_changed then 'unverified' else s.verification_status end,
      verified_by = case when v_details_changed then null else s.verified_by end,
      verified_at = case when v_details_changed then null else s.verified_at end,
      row_version = s.row_version + 1,
      updated_by = case when v_details_changed then (select auth.uid()) else s.updated_by end,
      updated_at = now()
    where s.id = v_s.id
    returning * into v_s;
  exception
    when unique_violation then
      raise exception 'duplicate_supplier' using errcode = '23505';
    when check_violation then
      raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end;
  if v_contact_changed then
    perform authz.supplier_primary_from_legacy(v_s);
  end if;

  -- Field names only; contact values are not copied into the audit trail.
  select coalesce(array_agg(k order by k), '{}') into v_changed from jsonb_object_keys(p_fields) k;
  perform authz.write_audit('supplier.updated', v_s.legal_entity_id, null, 'supplier', v_s.id, null,
    jsonb_build_object('fields', to_jsonb(v_changed), 'rowVersion', v_s.row_version, 'status', v_s.status,
      'detailsChanged', v_details_changed, 'verificationReset', v_reset, 'department', 'flight'));
  return jsonb_build_object('supplierId', v_s.id, 'rowVersion', v_s.row_version,
    'warnings', authz.supplier_warnings(v_s.id));
end;
$$;

-- ===========================================================================
-- 4. Contacts (A4, A5)
-- ===========================================================================

create function public.supplier_contact_save(p_supplier_id uuid, p_contact_id uuid, p_expected_row_version integer,
  p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_s public.suppliers%rowtype;
  v_old public.supplier_contacts%rowtype;
  v_c public.supplier_contacts%rowtype;
  v_uid uuid := (select auth.uid());
  v_payload jsonb := jsonb_build_object('supplierId', p_supplier_id, 'contactId', p_contact_id,
    'expectedRowVersion', p_expected_row_version, 'fields', p_fields);
  v_result jsonb;
  v_name text;
  v_role text;
  v_phone text;
  v_email text;
  v_primary boolean;
  v_has_primary boolean;
  v_rv integer;
begin
  select * into v_s from public.suppliers s where s.id = p_supplier_id for update;
  if v_s.id is null or not authz.supplier_can_edit(v_s.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_s.legal_entity_id, p_request_id, 'supplier_contact_save', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['name', 'roleLabel', 'phone', 'email', 'isPrimary']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  if p_contact_id is not null then
    select * into v_old from public.supplier_contacts c where c.id = p_contact_id and c.supplier_id = v_s.id for update;
    if v_old.id is null or v_old.status <> 'active' then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    if p_expected_row_version is distinct from v_old.row_version then
      raise exception 'version_changed' using errcode = '40001';
    end if;
  elsif coalesce(p_expected_row_version, 0) <> 0 then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_name := authz.supplier_text(p_fields, 'name', 120, false);
  if v_name is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'name';
  end if;
  v_role := authz.supplier_text(p_fields, 'roleLabel', 60, false);
  v_phone := authz.supplier_text(p_fields, 'phone', 40, false);
  if v_phone is not null and v_phone !~ '^[0-9+() -]{6,40}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'phone';
  end if;
  v_email := lower(authz.supplier_text(p_fields, 'email', 254, false));
  if v_email is not null and v_email !~ '^[^@[:space:]]{1,64}@[^@[:space:]]+\.[^@[:space:]]{2,}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'email';
  end if;
  if v_phone is null and v_email is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'phone';
  end if;
  if p_fields ? 'isPrimary' and jsonb_typeof(p_fields -> 'isPrimary') <> 'boolean' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'isPrimary';
  end if;
  v_has_primary := exists (select 1 from public.supplier_contacts c
                           where c.supplier_id = v_s.id and c.status = 'active' and c.is_primary
                             and c.id is distinct from p_contact_id);
  -- A first contact is primary unless the form says otherwise; an edit keeps its flag.
  v_primary := coalesce((p_fields ->> 'isPrimary')::boolean, case when v_old.id is null then not v_has_primary else v_old.is_primary end);
  if v_primary then
    update public.supplier_contacts c set is_primary = false, row_version = c.row_version + 1, updated_by = v_uid,
      updated_at = now()
    where c.supplier_id = v_s.id and c.status = 'active' and c.is_primary and c.id is distinct from p_contact_id;
  end if;

  begin
    if v_old.id is null then
      insert into public.supplier_contacts (legal_entity_id, supplier_id, name, role_label, phone, email, is_primary,
        created_by, updated_by)
      values (v_s.legal_entity_id, v_s.id, v_name, v_role, v_phone, v_email, v_primary, v_uid, v_uid)
      returning * into v_c;
    else
      update public.supplier_contacts c
      set name = v_name, role_label = v_role, phone = v_phone, email = v_email, is_primary = v_primary,
          row_version = c.row_version + 1, updated_by = v_uid, updated_at = now()
      where c.id = v_old.id
      returning * into v_c;
    end if;
  exception when check_violation then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end;

  if authz.supplier_contact_note(v_old) is distinct from authz.supplier_contact_note(v_c) then
    insert into public.supplier_changes (legal_entity_id, supplier_id, changed_by, source, field, old_value, new_value, request_id)
    values (v_s.legal_entity_id, v_s.id, v_uid, 'contact', 'contact:' || v_c.id, authz.supplier_contact_note(v_old),
      authz.supplier_contact_note(v_c), p_request_id);
  end if;
  v_rv := authz.supplier_sync_legacy(v_s.id);
  perform authz.write_audit('supplier.contact_saved', v_s.legal_entity_id, null, 'supplier', v_s.id, null,
    jsonb_build_object('supplierId', v_s.id, 'contactId', v_c.id, 'primary', v_c.is_primary));
  v_result := jsonb_build_object('outcome', case when v_old.id is null then 'created' else 'updated' end,
    'contactId', v_c.id, 'rowVersion', v_c.row_version, 'supplierRowVersion', v_rv);
  return authz.finance_remember(v_s.legal_entity_id, p_request_id, 'supplier_contact_save', v_payload, v_result);
end;
$$;

create function public.supplier_contact_remove(p_contact_id uuid, p_expected_row_version integer, p_reason text,
  p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_supplier uuid;
  v_s public.suppliers%rowtype;
  v_old public.supplier_contacts%rowtype;
  v_c public.supplier_contacts%rowtype;
  v_next uuid;
  v_uid uuid := (select auth.uid());
  v_reason text := btrim(coalesce(p_reason, ''), E' \t\r\n');
  v_payload jsonb := jsonb_build_object('contactId', p_contact_id, 'expectedRowVersion', p_expected_row_version,
    'reason', p_reason);
  v_result jsonb;
  v_rv integer;
begin
  select c.supplier_id into v_supplier from public.supplier_contacts c where c.id = p_contact_id;
  -- 13.1: the supplier row first, then the contact.
  select * into v_s from public.suppliers s where s.id = v_supplier for update;
  if v_s.id is null or not authz.supplier_can_edit(v_s.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_s.legal_entity_id, p_request_id, 'supplier_contact_remove', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  select * into v_old from public.supplier_contacts c where c.id = p_contact_id for update;
  if v_old.status <> 'active' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_expected_row_version is distinct from v_old.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if char_length(v_reason) not between 10 and 300 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  update public.supplier_contacts c
  set status = 'removed', is_primary = false, removed_by = v_uid, removed_at = now(), remove_reason = v_reason,
      row_version = c.row_version + 1, updated_by = v_uid, updated_at = now()
  where c.id = v_old.id
  returning * into v_c;
  -- Removing the primary promotes the most recently changed other active contact (else the legacy columns clear).
  if v_old.is_primary then
    select c.id into v_next from public.supplier_contacts c
    where c.supplier_id = v_s.id and c.status = 'active'
    order by c.updated_at desc, c.id desc limit 1 for update;
    if v_next is not null then
      update public.supplier_contacts c set is_primary = true, row_version = c.row_version + 1, updated_by = v_uid,
        updated_at = now()
      where c.id = v_next;
    end if;
  end if;
  insert into public.supplier_changes (legal_entity_id, supplier_id, changed_by, source, field, old_value, new_value, request_id)
  values (v_s.legal_entity_id, v_s.id, v_uid, 'contact', 'contact:' || v_c.id, authz.supplier_contact_note(v_old),
    authz.supplier_contact_note(v_c), p_request_id);
  v_rv := authz.supplier_sync_legacy(v_s.id);
  perform authz.write_audit('supplier.contact_removed', v_s.legal_entity_id, null, 'supplier', v_s.id, v_reason,
    jsonb_build_object('supplierId', v_s.id, 'contactId', v_c.id, 'promotedContactId', v_next));
  v_result := jsonb_build_object('outcome', 'updated', 'contactId', v_c.id, 'supplierRowVersion', v_rv);
  return authz.finance_remember(v_s.legal_entity_id, p_request_id, 'supplier_contact_remove', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 5. Hotel links (A6, A7)
-- ===========================================================================

create function public.supplier_hotel_link(p_supplier_id uuid, p_hotel_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_s public.suppliers%rowtype;
  v_link public.supplier_hotels%rowtype;
  v_uid uuid := (select auth.uid());
  v_payload jsonb := jsonb_build_object('supplierId', p_supplier_id, 'hotelId', p_hotel_id);
  v_result jsonb;
begin
  select * into v_s from public.suppliers s where s.id = p_supplier_id for update;
  if v_s.id is null or not authz.can_manage_suppliers(v_s.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_s.legal_entity_id, p_request_id, 'supplier_hotel_link', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if not ('hotel' = any (v_s.service_types)) then
    raise exception 'link_not_allowed' using errcode = '55000', hint = 'supplierId';
  end if;
  if p_hotel_id is null or not exists (select 1 from public.hotel_catalogue h
                                       where h.id = p_hotel_id and h.legal_entity_id = v_s.legal_entity_id
                                         and h.status = 'active') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'hotelId';
  end if;
  select * into v_link from public.supplier_hotels l
  where l.supplier_id = v_s.id and l.hotel_id = p_hotel_id and l.status = 'active';
  if v_link.id is not null then
    v_result := jsonb_build_object('outcome', 'existing', 'linkId', v_link.id);
    return authz.finance_remember(v_s.legal_entity_id, p_request_id, 'supplier_hotel_link', v_payload, v_result);
  end if;
  insert into public.supplier_hotels (legal_entity_id, supplier_id, hotel_id, source, created_by)
  values (v_s.legal_entity_id, v_s.id, p_hotel_id, 'manual', v_uid)
  returning * into v_link;
  insert into public.supplier_changes (legal_entity_id, supplier_id, changed_by, source, field, old_value, new_value, request_id)
  values (v_s.legal_entity_id, v_s.id, v_uid, 'hotel_link', 'hotel:' || p_hotel_id, null,
    left('linked (manual): ' || (select h.name || ', ' || h.city from public.hotel_catalogue h where h.id = p_hotel_id), 1000),
    p_request_id);
  perform authz.write_audit('supplier.hotel_linked', v_s.legal_entity_id, null, 'supplier', v_s.id, null,
    jsonb_build_object('supplierId', v_s.id, 'hotelId', p_hotel_id, 'linkId', v_link.id));
  v_result := jsonb_build_object('outcome', 'created', 'linkId', v_link.id);
  return authz.finance_remember(v_s.legal_entity_id, p_request_id, 'supplier_hotel_link', v_payload, v_result);
end;
$$;

create function public.supplier_hotel_unlink(p_link_id uuid, p_reason text, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_supplier uuid;
  v_s public.suppliers%rowtype;
  v_link public.supplier_hotels%rowtype;
  v_uid uuid := (select auth.uid());
  v_reason text := btrim(coalesce(p_reason, ''), E' \t\r\n');
  v_payload jsonb := jsonb_build_object('linkId', p_link_id, 'reason', p_reason);
  v_result jsonb;
begin
  select l.supplier_id into v_supplier from public.supplier_hotels l where l.id = p_link_id;
  select * into v_s from public.suppliers s where s.id = v_supplier for update;
  if v_s.id is null or not authz.can_manage_suppliers(v_s.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_s.legal_entity_id, p_request_id, 'supplier_hotel_unlink', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  select * into v_link from public.supplier_hotels l where l.id = p_link_id for update;
  if v_link.status = 'removed' then
    v_result := jsonb_build_object('outcome', 'existing', 'linkId', v_link.id);
    return authz.finance_remember(v_s.legal_entity_id, p_request_id, 'supplier_hotel_unlink', v_payload, v_result);
  end if;
  if char_length(v_reason) not between 10 and 300 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  update public.supplier_hotels l
  set status = 'removed', removed_by = v_uid, removed_at = now(), remove_reason = v_reason
  where l.id = v_link.id;
  insert into public.supplier_changes (legal_entity_id, supplier_id, changed_by, source, field, old_value, new_value, request_id)
  values (v_s.legal_entity_id, v_s.id, v_uid, 'hotel_link', 'hotel:' || v_link.hotel_id, 'linked (' || v_link.source || ')',
    'removed', p_request_id);
  perform authz.write_audit('supplier.hotel_unlinked', v_s.legal_entity_id, null, 'supplier', v_s.id, v_reason,
    jsonb_build_object('supplierId', v_s.id, 'hotelId', v_link.hotel_id, 'linkId', v_link.id));
  v_result := jsonb_build_object('outcome', 'updated', 'linkId', v_link.id);
  return authz.finance_remember(v_s.legal_entity_id, p_request_id, 'supplier_hotel_unlink', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 6. Quotes keep the catalogue hotel (A8; replaces 20261130000110)
-- ===========================================================================

create or replace function public.purchase_quote_add(p_task_id uuid, p_request_id uuid, p_fields jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_existing uuid;
  v_supplier public.suppliers%rowtype;
  v_cost bigint;
  v_per_night bigint;
  v_id uuid;
  v_hotel uuid;          -- Accounts phase 2 (20261204000110)
  v_link uuid;
begin
  v_task := authz.lock_workable_task(p_task_id);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select q.id into v_existing from public.purchase_quotes q where q.task_id = v_task.id and q.request_id = p_request_id;
  if v_existing is not null then
    return jsonb_build_object('quoteId', v_existing, 'created', false);
  end if;
  -- Purchase build: perRoomNightPaise and note are accepted. Accounts phase 2: catalogueHotelId.
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['supplierId', 'hotelName', 'roomType', 'mealPlan', 'quotedCostPaise', 'holdUntil',
                          'cancellationTerms', 'perRoomNightPaise', 'note', 'catalogueHotelId']) <> '{}'::jsonb
     or jsonb_typeof(p_fields -> 'supplierId') is distinct from 'string'
     or (p_fields ->> 'supplierId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into v_supplier from public.suppliers s
  where s.id = (p_fields ->> 'supplierId')::uuid and s.legal_entity_id = v_task.legal_entity_id;
  -- Purchase build: the supplier offers the task's service type (hotel, transfer or activity).
  if v_supplier.id is null or v_supplier.status <> 'active' or not (v_task.service_purpose = any (v_supplier.service_types)) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_cost := authz.booking_fact_paise(p_fields, 'quotedCostPaise');
  if v_cost is null or v_cost <= 0 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_per_night := authz.booking_fact_paise(p_fields, 'perRoomNightPaise');
  if v_per_night is not null and (v_per_night <= 0 or v_task.service_purpose <> 'hotel') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- Accounts phase 2: an active catalogue hotel of the entity, hotel tasks only.
  if p_fields ? 'catalogueHotelId' and jsonb_typeof(p_fields -> 'catalogueHotelId') <> 'null' then
    if jsonb_typeof(p_fields -> 'catalogueHotelId') <> 'string'
       or (p_fields ->> 'catalogueHotelId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or v_task.service_purpose <> 'hotel'
       or not exists (select 1 from public.hotel_catalogue h
                      where h.id = (p_fields ->> 'catalogueHotelId')::uuid
                        and h.legal_entity_id = v_task.legal_entity_id and h.status = 'active') then
      raise exception 'invalid_input' using errcode = '22023', hint = 'catalogueHotelId';
    end if;
    v_hotel := (p_fields ->> 'catalogueHotelId')::uuid;
  end if;

  begin
    insert into public.purchase_quotes (task_id, legal_entity_id, supplier_id, request_id, hotel_name, room_type,
      meal_plan, quoted_cost_paise, hold_until, cancellation_terms, per_room_night_paise, note, catalogue_hotel_id, created_by)
    values (v_task.id, v_task.legal_entity_id, v_supplier.id, p_request_id,
      authz.booking_fact_text(p_fields, 'hotelName', 200, false),
      authz.booking_fact_text(p_fields, 'roomType', 120, false),
      authz.booking_fact_text(p_fields, 'mealPlan', 60, false),
      v_cost,
      authz.booking_fact_date(p_fields, 'holdUntil'),
      authz.booking_fact_text(p_fields, 'cancellationTerms', 2000, true),
      v_per_night,
      authz.booking_fact_text(p_fields, 'note', 300, true),
      v_hotel,
      (select auth.uid()))
    returning id into v_id;
  exception when check_violation or not_null_violation then
    raise exception 'invalid_input' using errcode = '22023';
  end;

  -- Accounts phase 2: the supplier sells this hotel (first quote wins; nothing when already linked).
  if v_hotel is not null and 'hotel' = any (v_supplier.service_types) then
    insert into public.supplier_hotels (legal_entity_id, supplier_id, hotel_id, source, first_quote_id, created_by)
    values (v_task.legal_entity_id, v_supplier.id, v_hotel, 'quote', v_id, (select auth.uid()))
    on conflict (supplier_id, hotel_id) where status = 'active' do nothing
    returning id into v_link;
    if v_link is not null then
      insert into public.supplier_changes (legal_entity_id, supplier_id, changed_by, source, field, old_value, new_value)
      values (v_task.legal_entity_id, v_supplier.id, (select auth.uid()), 'hotel_link', 'hotel:' || v_hotel, null,
        left('linked (quote): ' || (select h.name || ', ' || h.city from public.hotel_catalogue h where h.id = v_hotel), 1000));
    end if;
  end if;

  perform authz.write_audit('purchase.quote_added', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null, jsonb_build_object('quoteId', v_id, 'supplierId', v_supplier.id));
  return jsonb_build_object('quoteId', v_id, 'created', true);
end;
$$;

-- ===========================================================================
-- 7. Booking facts keep the catalogue hotel (A9; replaces 20261128000110)
-- ===========================================================================

create or replace function authz.vn_hotel_adults_default() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_def integer;
  v_raw jsonb;
begin
  if not exists (select 1 from public.service_items i where i.id = new.service_item_id and i.service_type = 'hotel') then
    return new;
  end if;
  -- Accounts phase 2 (20261204000110): the catalogue row id is kept in the
  -- column catalogue_hotel_id before the key is stripped (LD22).
  v_raw := new.facts -> 'catalogueHotelId';
  if v_raw is not null then
    new.catalogue_hotel_id := case
      when jsonb_typeof(v_raw) = 'string'
           and (v_raw #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      then (select h.id from public.hotel_catalogue h
            where h.id = (v_raw #>> '{}')::uuid and h.legal_entity_id = new.legal_entity_id) end;
  elsif tg_op = 'INSERT' and new.catalogue_hotel_id is null then
    -- A revision copy keeps the base row's hotel (same item, same hotel name).
    new.catalogue_hotel_id := (
      select f.catalogue_hotel_id
      from public.booking_versions v
      join public.service_item_facts f on f.booking_version_id = v.revises_version_id
      where v.id = new.booking_version_id and f.service_item_id = new.service_item_id
        and (f.facts -> 'hotelName') is not distinct from (new.facts -> 'hotelName'));
  elsif tg_op = 'UPDATE' and (new.facts -> 'hotelName') is distinct from (old.facts -> 'hotelName') then
    -- Another hotel typed without a catalogue pick: the old id no longer applies.
    new.catalogue_hotel_id := null;
  end if;
  -- The catalogue row id is checked by validate_service_facts but never
  -- stored in the facts: readers (and the previous app) parse hotel facts
  -- with a fixed key list.
  new.facts := new.facts - 'catalogueHotelId';
  if coalesce(jsonb_typeof(new.facts -> 'adults'), 'null') = 'null' then
    v_def := authz.vn_version_adults(new.booking_version_id);
    if v_def is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'adults';
    end if;
    new.facts := (new.facts - 'adults') || jsonb_build_object('adults', v_def);
    new.adults_from_booking := true;
  elsif tg_op = 'UPDATE' and (new.facts -> 'adults') is distinct from (old.facts -> 'adults')
        and coalesce(current_setting('tripnavigate.vn_adults_refresh', true), '') <> 'on' then
    new.adults_from_booking := false;
  elsif tg_op = 'INSERT' then
    -- A revision copies the base version's facts: the copy keeps following
    -- the booking when the base row did (same item, same adults).
    new.adults_from_booking := coalesce((
      select f.adults_from_booking
      from public.booking_versions v
      join public.service_item_facts f on f.booking_version_id = v.revises_version_id
      where v.id = new.booking_version_id and f.service_item_id = new.service_item_id
        and (f.facts -> 'adults') = (new.facts -> 'adults')), new.adults_from_booking);
  end if;
  return new;
end;
$$;

-- ===========================================================================
-- 8. Privileges
-- ===========================================================================

revoke all on function authz.supplier_text(jsonb, text, integer, boolean),
  authz.supplier_master_values(jsonb, public.suppliers),
  authz.supplier_near_duplicates(uuid, uuid, text, text, text, text, text, text),
  authz.supplier_can_edit(uuid), authz.supplier_contact_note(public.supplier_contacts),
  authz.supplier_sync_legacy(uuid), authz.supplier_primary_from_legacy(public.suppliers),
  authz.supplier_bank_key(uuid), authz.supplier_warnings(uuid)
from public, anon, authenticated, service_role;

revoke all on function public.supplier_contact_save(uuid, uuid, integer, jsonb, uuid),
  public.supplier_contact_remove(uuid, integer, text, uuid),
  public.supplier_hotel_link(uuid, uuid, uuid), public.supplier_hotel_unlink(uuid, text, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.supplier_contact_save(uuid, uuid, integer, jsonb, uuid),
  public.supplier_contact_remove(uuid, integer, text, uuid),
  public.supplier_hotel_link(uuid, uuid, uuid), public.supplier_hotel_unlink(uuid, text, uuid)
to authenticated;

commit;
