-- TripNavigate CRM - Accounts phase 3, track E (2 of 5): rate contract commands.
-- Contract: accounts-phase3-2026-11-12/contract.md section 9.3 (E2..E8), 4
-- (Approver), 13, 14, 17.1 (lock order: the contract row, then the supplier +
-- hotel advisory lock, then other contract rows by id), 17.3 (audit actions).
--
-- New commands (security definer, search_path '', session first, actor from
-- auth.uid(), execute to authenticated only; every write with its audit row in
-- one transaction; p_request_id replays through finance_replay / remember):
--   E2 public.hotel_room_type_save(p_hotel_id, p_room_type_id, p_expected_row_version, p_name, p_request_id)
--      public.hotel_room_type_remove(p_room_type_id, p_reason, p_request_id)
--   E3 public.rate_contract_save(p_contract_id, p_expected_row_version, p_fields, p_request_id)
--   E4 public.rate_contract_lines_set(p_contract_id, p_expected_row_version, p_lines, p_blackouts, p_request_id)
--   E5 public.rate_contract_file_begin(p_contract_id, p_file_name, p_mime, p_size_bytes, p_sha256)
--      public.rate_contract_file_finish(p_file_id, p_ok)
--      public.rate_contract_file_authorize_download(p_file_id)
--   E6 public.rate_contract_submit(p_contract_id, p_expected_row_version, p_request_id)
--   E7 public.rate_contract_decide(p_contract_id, p_decision, p_reason, p_expected_row_version, p_request_id)
--   E8 public.rate_contract_end(p_contract_id, p_expected_row_version, p_reason, p_request_id)
-- Callers: Purchase of the entity (authz.can_manage_suppliers) for E2-E6
-- uploads; Managers of the entity for E7 (not the enterer: not_self_approval)
-- and E8; Purchase, Manager or Accounts of the entity for downloads. Rate
-- contracts carry no selling data, so a Manager who also holds Purchase may
-- approve (section 14 fences selling data, not supplier costs); a Manager or
-- Accounts person who also holds Flight or Visa does not count (authz.rc_reader).
--
-- Audit (17.3): purchase.room_type_saved | room_type_removed,
-- purchase.rate_contract.saved | lines_set | submitted | approved | returned |
-- ended, purchase.rate_contract_file.stored | failed | downloaded. Details carry
-- ids, counts, versions and outcomes only - never rates or names.
--
-- Refusal tokens: not_authorized (42501), not_self_approval (42501),
-- rate_contracts_off (55000), link_not_allowed (55000), wrong_state (55000),
-- not_ready (55000), already_recorded (55000), in_use (55000),
-- invalid_input (22023; hint names the field, lines[n].<field> or
-- blackouts[n].<field>), lines_overlap (22023; hint lines[n].seasonFrom),
-- evidence_rejected (22023), version_changed (40001), request_conflict
-- (40001), not_found (P0002).
--
-- Rollback (forward-only): a new migration revoking execute on these commands.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Small helpers
-- ===========================================================================

-- A text field of p_fields: null when absent, null or blank; invalid_input
-- (hint p_hint) when not a string, too long or holding control characters
-- (line breaks and tabs allowed when p_multiline).
create function authz.rc_text_field(p_fields jsonb, p_key text, p_max integer, p_multiline boolean, p_hint text default null)
returns text
language plpgsql immutable set search_path = '' as $$
declare
  v jsonb := p_fields -> p_key;
  t text;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v) <> 'string' then
    raise exception 'invalid_input' using errcode = '22023', hint = coalesce(p_hint, p_key);
  end if;
  t := nullif(btrim(v #>> '{}', E' \t\r\n'), '');
  if t is not null and (char_length(t) > p_max
       or (p_multiline and t ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]')
       or (not p_multiline and t ~ '[[:cntrl:]]')) then
    raise exception 'invalid_input' using errcode = '22023', hint = coalesce(p_hint, p_key);
  end if;
  return t;
end;
$$;

create function authz.rc_uuid(p jsonb) returns uuid
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p) = 'string'
              and (p #>> '{}') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
         then (p #>> '{}')::uuid end
$$;

create function authz.rc_reason(p_reason text, p_max integer) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v text := btrim(coalesce(p_reason, ''), E' \t\r\n');
begin
  if char_length(v) < 10 or char_length(v) > p_max or v ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  return v;
end;
$$;

create function authz.rc_require_on() returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.rate_contracts_enabled() then
    raise exception 'rate_contracts_off' using errcode = '55000';
  end if;
end;
$$;

-- The supplier sells hotels, is active and has an active link to the hotel.
create function authz.rc_link_ok(p_supplier uuid, p_hotel uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.suppliers s
    join public.supplier_hotels l on l.supplier_id = s.id and l.hotel_id = p_hotel and l.status = 'active'
    where s.id = p_supplier and s.status = 'active' and 'hotel' = any (s.service_types))
$$;

-- The next RC-<India year>-<6 digits> number of an entity.
create function authz.rc_next_number(p_entity uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_year integer := extract(year from (now() at time zone 'Asia/Kolkata'))::integer;
  v_no integer;
begin
  insert into public.rate_contract_counters as c (legal_entity_id, year, last_no)
  values (p_entity, v_year, 1)
  on conflict (legal_entity_id, year) do update set last_no = c.last_no + 1
  returning c.last_no into v_no;
  return 'RC-' || v_year::text || '-' || lpad(v_no::text, 6, '0');
end;
$$;

create function authz.rc_result(c public.rate_contracts, p_outcome text) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('outcome', p_outcome, 'contractId', c.id, 'contractNo', c.contract_no, 'versionNo', c.version_no,
    'status', c.status, 'rowVersion', c.row_version)
$$;

-- The contract row locked for a command (not_found when missing).
create function authz.rc_lock(p_contract uuid) returns public.rate_contracts
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.rate_contracts%rowtype;
begin
  select * into c from public.rate_contracts x where x.id = p_contract for update;
  if c.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return c;
end;
$$;

-- ===========================================================================
-- 2. E2 room types
-- ===========================================================================

create function public.hotel_room_type_save(p_hotel_id uuid, p_room_type_id uuid, p_expected_row_version integer,
  p_name text, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_rt public.hotel_room_types%rowtype;
  v_hotel public.hotel_catalogue%rowtype;
  v_name text := regexp_replace(btrim(coalesce(p_name, ''), E' \t\r\n'), '\s+', ' ', 'g');
  v_uid uuid := (select auth.uid());
  v_payload jsonb := jsonb_build_object('hotelId', p_hotel_id, 'roomTypeId', p_room_type_id,
    'expectedRowVersion', p_expected_row_version, 'name', p_name);
  v_result jsonb;
  v_outcome text;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_room_type_id is not null then
    select * into v_rt from public.hotel_room_types t where t.id = p_room_type_id for update;
    if v_rt.id is null then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    if p_hotel_id is not null and p_hotel_id <> v_rt.hotel_id then
      raise exception 'invalid_input' using errcode = '22023', hint = 'hotelId';
    end if;
  end if;
  select * into v_hotel from public.hotel_catalogue h where h.id = coalesce(v_rt.hotel_id, p_hotel_id);
  if v_hotel.id is null or not authz.can_manage_suppliers(v_hotel.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.rc_require_on();
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_hotel.legal_entity_id, p_request_id, 'hotel_room_type_save', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if char_length(v_name) not between 1 and 120 or v_name ~ '[[:cntrl:]]' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'name';
  end if;

  if v_rt.id is null then
    if v_hotel.status <> 'active' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'hotelId';
    end if;
    if exists (select 1 from public.hotel_room_types t where t.hotel_id = v_hotel.id and t.status = 'active' and t.name_key = lower(v_name)) then
      raise exception 'already_recorded' using errcode = '55000', hint = 'name';
    end if;
    begin
      insert into public.hotel_room_types (legal_entity_id, hotel_id, name, created_by, updated_by)
      values (v_hotel.legal_entity_id, v_hotel.id, v_name, v_uid, v_uid)
      returning * into v_rt;
    exception when unique_violation then
      raise exception 'already_recorded' using errcode = '55000', hint = 'name';
    end;
    v_outcome := 'created';
  else
    if v_rt.status <> 'active' then
      raise exception 'wrong_state' using errcode = '55000';
    end if;
    perform authz.require_row_version(p_expected_row_version, v_rt.row_version);
    if v_rt.name = v_name then
      v_outcome := 'existing';
    else
      if exists (select 1 from public.hotel_room_types t
                 where t.hotel_id = v_rt.hotel_id and t.status = 'active' and t.name_key = lower(v_name) and t.id <> v_rt.id) then
        raise exception 'already_recorded' using errcode = '55000', hint = 'name';
      end if;
      update public.hotel_room_types t
      set name = v_name, row_version = t.row_version + 1, updated_by = v_uid, updated_at = now()
      where t.id = v_rt.id
      returning * into v_rt;
      v_outcome := 'updated';
    end if;
  end if;
  if v_outcome <> 'existing' then
    perform authz.write_audit('purchase.room_type_saved', v_hotel.legal_entity_id, null, 'hotel_room_type', v_rt.id, null,
      jsonb_build_object('roomTypeId', v_rt.id, 'hotelId', v_rt.hotel_id, 'outcome', v_outcome, 'rowVersion', v_rt.row_version));
  end if;
  v_result := jsonb_build_object('outcome', v_outcome, 'roomTypeId', v_rt.id, 'hotelId', v_rt.hotel_id, 'name', v_rt.name,
    'rowVersion', v_rt.row_version);
  return authz.finance_remember(v_hotel.legal_entity_id, p_request_id, 'hotel_room_type_save', v_payload, v_result);
end;
$$;

create function public.hotel_room_type_remove(p_room_type_id uuid, p_reason text, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_rt public.hotel_room_types%rowtype;
  v_uid uuid := (select auth.uid());
  v_payload jsonb := jsonb_build_object('roomTypeId', p_room_type_id, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_rt from public.hotel_room_types t where t.id = p_room_type_id for update;
  if v_rt.id is null or not authz.can_manage_suppliers(v_rt.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.rc_require_on();
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_rt.legal_entity_id, p_request_id, 'hotel_room_type_remove', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_rt.status = 'removed' then
    v_result := jsonb_build_object('outcome', 'existing', 'roomTypeId', v_rt.id, 'rowVersion', v_rt.row_version);
    return authz.finance_remember(v_rt.legal_entity_id, p_request_id, 'hotel_room_type_remove', v_payload, v_result);
  end if;
  v_reason := authz.rc_reason(p_reason, 300);
  -- A type priced by an active contract, or one waiting for approval, stays.
  if exists (select 1 from public.rate_contract_lines l
             join public.rate_contracts c on c.id = l.contract_id
             where l.room_type_id = v_rt.id and c.status in ('active', 'pending_approval')) then
    raise exception 'in_use' using errcode = '55000';
  end if;
  update public.hotel_room_types t
  set status = 'removed', removed_by = v_uid, removed_at = now(), remove_reason = v_reason,
      row_version = t.row_version + 1, updated_by = v_uid, updated_at = now()
  where t.id = v_rt.id
  returning * into v_rt;
  perform authz.write_audit('purchase.room_type_removed', v_rt.legal_entity_id, null, 'hotel_room_type', v_rt.id, v_reason,
    jsonb_build_object('roomTypeId', v_rt.id, 'hotelId', v_rt.hotel_id));
  v_result := jsonb_build_object('outcome', 'updated', 'roomTypeId', v_rt.id, 'rowVersion', v_rt.row_version);
  return authz.finance_remember(v_rt.legal_entity_id, p_request_id, 'hotel_room_type_remove', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 3. E3 contract header
-- ===========================================================================

-- p_fields: supplierId, hotelId (fixed after creation; an existing contract
-- accepts them only unchanged), validFrom, validTo (YYYY-MM-DD; from <= to;
-- at most 1100 days), cancellationTerms (<= 2000), note (<= 500). A new
-- contract passes p_contract_id null (p_expected_row_version is ignored).
create function public.rate_contract_save(p_contract_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.rate_contracts%rowtype;
  v_s public.suppliers%rowtype;
  v_hotel public.hotel_catalogue%rowtype;
  v_uid uuid := (select auth.uid());
  v_entity uuid;
  v_key text;
  v_supplier uuid;
  v_hotel_id uuid;
  v_from date;
  v_to date;
  v_terms text;
  v_note text;
  v_version integer;
  v_payload jsonb := jsonb_build_object('contractId', p_contract_id, 'expectedRowVersion', p_expected_row_version,
    'fields', p_fields);
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  for v_key in select jsonb_object_keys(p_fields) loop
    if v_key not in ('supplierId', 'hotelId', 'validFrom', 'validTo', 'cancellationTerms', 'note') then
      raise exception 'invalid_input' using errcode = '22023', hint = v_key;
    end if;
  end loop;
  if p_fields ? 'supplierId' and jsonb_typeof(p_fields -> 'supplierId') <> 'null' then
    v_supplier := authz.rc_uuid(p_fields -> 'supplierId');
    if v_supplier is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'supplierId';
    end if;
  end if;
  if p_fields ? 'hotelId' and jsonb_typeof(p_fields -> 'hotelId') <> 'null' then
    v_hotel_id := authz.rc_uuid(p_fields -> 'hotelId');
    if v_hotel_id is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'hotelId';
    end if;
  end if;

  if p_contract_id is null then
    -- New contract: the supplier names the entity.
    if v_supplier is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'supplierId';
    end if;
    select * into v_s from public.suppliers s where s.id = v_supplier;
    if v_s.id is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'supplierId';
    end if;
    v_entity := v_s.legal_entity_id;
    if not authz.can_manage_suppliers(v_entity) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
  else
    c := authz.rc_lock(p_contract_id);
    v_entity := c.legal_entity_id;
    if not authz.can_manage_suppliers(v_entity) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
  end if;
  perform authz.rc_require_on();
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_entity, p_request_id, 'rate_contract_save', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  if c.id is not null then
    if c.status not in ('draft', 'returned') then
      raise exception 'wrong_state' using errcode = '55000';
    end if;
    perform authz.require_row_version(p_expected_row_version, c.row_version);
    if v_supplier is not null and v_supplier <> c.supplier_id then
      raise exception 'invalid_input' using errcode = '22023', hint = 'supplierId';
    end if;
    if v_hotel_id is not null and v_hotel_id <> c.hotel_id then
      raise exception 'invalid_input' using errcode = '22023', hint = 'hotelId';
    end if;
  else
    if v_hotel_id is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'hotelId';
    end if;
    select * into v_hotel from public.hotel_catalogue h
    where h.id = v_hotel_id and h.legal_entity_id = v_entity and h.status = 'active';
    if v_hotel.id is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'hotelId';
    end if;
    if not authz.rc_link_ok(v_s.id, v_hotel.id) then
      raise exception 'link_not_allowed' using errcode = '55000', hint = 'supplierId';
    end if;
  end if;

  -- Dates: a key that is absent keeps the stored value (new contracts need both).
  if p_fields ? 'validFrom' then
    v_from := authz.rc_date(case when jsonb_typeof(p_fields -> 'validFrom') = 'string' then p_fields ->> 'validFrom' end);
    if v_from is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'validFrom';
    end if;
  else
    v_from := c.valid_from;
  end if;
  if p_fields ? 'validTo' then
    v_to := authz.rc_date(case when jsonb_typeof(p_fields -> 'validTo') = 'string' then p_fields ->> 'validTo' end);
    if v_to is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'validTo';
    end if;
  else
    v_to := c.valid_to;
  end if;
  if v_from is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'validFrom';
  end if;
  if v_to is null or v_to < v_from or v_to - v_from > 1100 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'validTo';
  end if;
  v_terms := case when p_fields ? 'cancellationTerms' then authz.rc_text_field(p_fields, 'cancellationTerms', 2000, true)
                  else c.cancellation_terms end;
  v_note := case when p_fields ? 'note' then authz.rc_text_field(p_fields, 'note', 500, true) else c.note end;

  if c.id is null then
    perform authz.rc_lock_pair(v_s.id, v_hotel.id);
    select coalesce(max(x.version_no), 0) + 1 into v_version
    from public.rate_contracts x where x.supplier_id = v_s.id and x.hotel_id = v_hotel.id;
    insert into public.rate_contracts (legal_entity_id, supplier_id, hotel_id, contract_no, version_no, valid_from, valid_to,
      cancellation_terms, note, entered_by)
    values (v_entity, v_s.id, v_hotel.id, authz.rc_next_number(v_entity), v_version, v_from, v_to, v_terms, v_note, v_uid)
    returning * into c;
    perform authz.write_audit('purchase.rate_contract.saved', v_entity, null, 'rate_contract', c.id, null,
      jsonb_build_object('contractId', c.id, 'supplierId', c.supplier_id, 'hotelId', c.hotel_id, 'versionNo', c.version_no,
        'outcome', 'created', 'source', 'manual'));
    v_result := authz.rc_result(c, 'created');
  else
    -- Lines and blackouts must stay inside the validity.
    if exists (select 1 from public.rate_contract_lines l where l.contract_id = c.id and l.season_from < v_from)
       or exists (select 1 from public.rate_contract_blackouts b where b.contract_id = c.id and b.from_date < v_from) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'validFrom';
    end if;
    if exists (select 1 from public.rate_contract_lines l where l.contract_id = c.id and l.season_to > v_to)
       or exists (select 1 from public.rate_contract_blackouts b where b.contract_id = c.id and b.to_date > v_to) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'validTo';
    end if;
    update public.rate_contracts x
    set valid_from = v_from, valid_to = v_to, cancellation_terms = v_terms, note = v_note,
        row_version = x.row_version + 1, updated_at = now()
    where x.id = c.id
    returning * into c;
    perform authz.write_audit('purchase.rate_contract.saved', v_entity, null, 'rate_contract', c.id, null,
      jsonb_build_object('contractId', c.id, 'versionNo', c.version_no, 'outcome', 'updated', 'rowVersion', c.row_version));
    v_result := authz.rc_result(c, 'updated');
  end if;
  return authz.finance_remember(v_entity, p_request_id, 'rate_contract_save', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 4. E4 lines and blackouts (replace all, draft or returned only)
-- ===========================================================================

-- p_lines: [{seasonFrom, seasonTo, roomTypeId, mealPlan, ratePaise,
-- weekendRatePaise?, extraAdultPaise?, childWithBedPaise?,
-- childWithoutBedPaise?, note?}] (paise as decimal strings; lineId and
-- roomTypeName are ignored); at most 500. p_blackouts: [{fromDate, toDate}];
-- at most 100. Both inside the validity.
create function public.rate_contract_lines_set(p_contract_id uuid, p_expected_row_version integer, p_lines jsonb,
  p_blackouts jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.rate_contracts%rowtype;
  v_payload jsonb := jsonb_build_object('contractId', p_contract_id, 'expectedRowVersion', p_expected_row_version,
    'lines', p_lines, 'blackouts', p_blackouts);
  v_result jsonb;
  e record;
  v_key text;
  v_p text;
  v_from date;
  v_to date;
  v_rt uuid;
  v_meal text;
  v_rate bigint;
  v_n bigint;
  v_clean jsonb := '[]'::jsonb;
  v_black jsonb := '[]'::jsonb;
  v_overlap integer;
  v_lines integer;
  v_blackouts integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  c := authz.rc_lock(p_contract_id);
  if not authz.can_manage_suppliers(c.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.rc_require_on();
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(c.legal_entity_id, p_request_id, 'rate_contract_lines_set', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if c.status not in ('draft', 'returned') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, c.row_version);
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) > 500 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'lines';
  end if;
  if p_blackouts is not null and (jsonb_typeof(p_blackouts) <> 'array' or jsonb_array_length(p_blackouts) > 100) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'blackouts';
  end if;

  for e in select x.value as l, (x.ordinality - 1)::integer as i from jsonb_array_elements(p_lines) with ordinality x loop
    v_p := 'lines[' || e.i || '].';
    if jsonb_typeof(e.l) <> 'object' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'lines[' || e.i || ']';
    end if;
    for v_key in select jsonb_object_keys(e.l) loop
      if v_key not in ('seasonFrom', 'seasonTo', 'roomTypeId', 'mealPlan', 'ratePaise', 'weekendRatePaise', 'extraAdultPaise',
                       'childWithBedPaise', 'childWithoutBedPaise', 'note', 'lineId', 'roomTypeName') then
        raise exception 'invalid_input' using errcode = '22023', hint = v_p || v_key;
      end if;
    end loop;
    v_from := authz.rc_date(case when jsonb_typeof(e.l -> 'seasonFrom') = 'string' then e.l ->> 'seasonFrom' end);
    if v_from is null or v_from < c.valid_from or v_from > c.valid_to then
      raise exception 'invalid_input' using errcode = '22023', hint = v_p || 'seasonFrom';
    end if;
    v_to := authz.rc_date(case when jsonb_typeof(e.l -> 'seasonTo') = 'string' then e.l ->> 'seasonTo' end);
    if v_to is null or v_to < v_from or v_to > c.valid_to then
      raise exception 'invalid_input' using errcode = '22023', hint = v_p || 'seasonTo';
    end if;
    v_rt := authz.rc_uuid(e.l -> 'roomTypeId');
    if v_rt is null or not exists (select 1 from public.hotel_room_types t
                                   where t.id = v_rt and t.hotel_id = c.hotel_id and t.status = 'active') then
      raise exception 'invalid_input' using errcode = '22023', hint = v_p || 'roomTypeId';
    end if;
    v_meal := case when jsonb_typeof(e.l -> 'mealPlan') = 'string' and (e.l ->> 'mealPlan') in ('EP', 'CP', 'MAP', 'AP', 'AI')
                   then e.l ->> 'mealPlan' end;
    if v_meal is null then
      raise exception 'invalid_input' using errcode = '22023', hint = v_p || 'mealPlan';
    end if;
    v_rate := authz.rc_paise(e.l -> 'ratePaise');
    if v_rate is null or v_rate <= 0 then
      raise exception 'invalid_input' using errcode = '22023', hint = v_p || 'ratePaise';
    end if;
    v_n := authz.rc_paise(e.l -> 'weekendRatePaise');
    if v_n is not null and v_n <= 0 then
      raise exception 'invalid_input' using errcode = '22023', hint = v_p || 'weekendRatePaise';
    end if;
    foreach v_key in array array['extraAdultPaise', 'childWithBedPaise', 'childWithoutBedPaise'] loop
      if authz.rc_paise(e.l -> v_key) < 0 then
        raise exception 'invalid_input' using errcode = '22023', hint = v_p || v_key;
      end if;
    end loop;
    v_clean := v_clean || jsonb_build_array(jsonb_build_object(
      'i', e.i, 'seasonFrom', v_from, 'seasonTo', v_to, 'roomTypeId', v_rt, 'mealPlan', v_meal, 'ratePaise', v_rate,
      'weekendRatePaise', v_n, 'extraAdultPaise', authz.rc_paise(e.l -> 'extraAdultPaise'),
      'childWithBedPaise', authz.rc_paise(e.l -> 'childWithBedPaise'),
      'childWithoutBedPaise', authz.rc_paise(e.l -> 'childWithoutBedPaise'),
      'note', authz.rc_text_field(e.l, 'note', 300, false, v_p || 'note')));
  end loop;

  -- Same room type and meal plan must not overlap: the later line is named.
  select min(b.i) into v_overlap
  from jsonb_to_recordset(v_clean) as a (i integer, "seasonFrom" date, "seasonTo" date, "roomTypeId" uuid, "mealPlan" text)
  join jsonb_to_recordset(v_clean) as b (i integer, "seasonFrom" date, "seasonTo" date, "roomTypeId" uuid, "mealPlan" text)
    on b.i > a.i and b."roomTypeId" = a."roomTypeId" and b."mealPlan" = a."mealPlan"
   and b."seasonFrom" <= a."seasonTo" and a."seasonFrom" <= b."seasonTo";
  if v_overlap is not null then
    raise exception 'lines_overlap' using errcode = '22023', hint = 'lines[' || v_overlap || '].seasonFrom';
  end if;

  for e in select x.value as b, (x.ordinality - 1)::integer as i
           from jsonb_array_elements(coalesce(p_blackouts, '[]'::jsonb)) with ordinality x loop
    v_p := 'blackouts[' || e.i || '].';
    if jsonb_typeof(e.b) <> 'object' or exists (select 1 from jsonb_object_keys(e.b) k where k not in ('fromDate', 'toDate', 'blackoutId')) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'blackouts[' || e.i || ']';
    end if;
    v_from := authz.rc_date(case when jsonb_typeof(e.b -> 'fromDate') = 'string' then e.b ->> 'fromDate' end);
    if v_from is null or v_from < c.valid_from or v_from > c.valid_to then
      raise exception 'invalid_input' using errcode = '22023', hint = v_p || 'fromDate';
    end if;
    v_to := authz.rc_date(case when jsonb_typeof(e.b -> 'toDate') = 'string' then e.b ->> 'toDate' end);
    if v_to is null or v_to < v_from or v_to > c.valid_to then
      raise exception 'invalid_input' using errcode = '22023', hint = v_p || 'toDate';
    end if;
    v_black := v_black || jsonb_build_array(jsonb_build_object('fromDate', v_from, 'toDate', v_to));
  end loop;

  delete from public.rate_contract_lines l where l.contract_id = c.id;
  delete from public.rate_contract_blackouts b where b.contract_id = c.id;
  insert into public.rate_contract_lines (legal_entity_id, contract_id, line_no, season_from, season_to, room_type_id, meal_plan,
    rate_paise, weekend_rate_paise, extra_adult_paise, child_with_bed_paise, child_without_bed_paise, note)
  select c.legal_entity_id, c.id, x.i + 1, x."seasonFrom", x."seasonTo", x."roomTypeId", x."mealPlan", x."ratePaise",
    x."weekendRatePaise", x."extraAdultPaise", x."childWithBedPaise", x."childWithoutBedPaise", x.note
  from jsonb_to_recordset(v_clean) as x (i integer, "seasonFrom" date, "seasonTo" date, "roomTypeId" uuid, "mealPlan" text,
    "ratePaise" bigint, "weekendRatePaise" bigint, "extraAdultPaise" bigint, "childWithBedPaise" bigint,
    "childWithoutBedPaise" bigint, note text);
  get diagnostics v_lines = row_count;
  insert into public.rate_contract_blackouts (legal_entity_id, contract_id, from_date, to_date)
  select distinct c.legal_entity_id, c.id, x."fromDate", x."toDate"
  from jsonb_to_recordset(v_black) as x ("fromDate" date, "toDate" date);
  get diagnostics v_blackouts = row_count;

  update public.rate_contracts x set row_version = x.row_version + 1, updated_at = now() where x.id = c.id returning * into c;
  perform authz.write_audit('purchase.rate_contract.lines_set', c.legal_entity_id, null, 'rate_contract', c.id, null,
    jsonb_build_object('contractId', c.id, 'lines', v_lines, 'blackouts', v_blackouts, 'rowVersion', c.row_version));
  v_result := authz.rc_result(c, 'updated') || jsonb_build_object('lineCount', v_lines, 'blackoutCount', v_blackouts);
  return authz.finance_remember(c.legal_entity_id, p_request_id, 'rate_contract_lines_set', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 5. E6 submit, E7 decide, E8 end
-- ===========================================================================

create function public.rate_contract_submit(p_contract_id uuid, p_expected_row_version integer, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.rate_contracts%rowtype;
  v_payload jsonb := jsonb_build_object('contractId', p_contract_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_lines integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  c := authz.rc_lock(p_contract_id);
  if not authz.can_manage_suppliers(c.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.rc_require_on();
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(c.legal_entity_id, p_request_id, 'rate_contract_submit', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if c.status not in ('draft', 'returned') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, c.row_version);
  select count(*) into v_lines from public.rate_contract_lines l where l.contract_id = c.id;
  if v_lines = 0 or exists (select 1 from public.rate_contract_lines l
                            join public.hotel_room_types t on t.id = l.room_type_id
                            where l.contract_id = c.id and t.status <> 'active') then
    raise exception 'not_ready' using errcode = '55000', hint = 'lines';
  end if;
  if not authz.rc_link_ok(c.supplier_id, c.hotel_id) then
    raise exception 'link_not_allowed' using errcode = '55000', hint = 'supplierId';
  end if;
  update public.rate_contracts x
  set status = 'pending_approval', submitted_at = now(), row_version = x.row_version + 1, updated_at = now()
  where x.id = c.id
  returning * into c;
  perform authz.write_audit('purchase.rate_contract.submitted', c.legal_entity_id, null, 'rate_contract', c.id, null,
    jsonb_build_object('contractId', c.id, 'versionNo', c.version_no, 'lines', v_lines, 'rowVersion', c.row_version));
  v_result := authz.rc_result(c, 'updated');
  return authz.finance_remember(c.legal_entity_id, p_request_id, 'rate_contract_submit', v_payload, v_result);
end;
$$;

-- Approver (section 4): any Manager of the entity who did not enter the
-- contract. Approving ends every overlapping active contract of the same
-- supplier and hotel ("Replaced by RC-..."), under the pair lock.
create function public.rate_contract_decide(p_contract_id uuid, p_decision text, p_reason text, p_expected_row_version integer,
  p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.rate_contracts%rowtype;
  o public.rate_contracts%rowtype;
  v_uid uuid := (select auth.uid());
  v_payload jsonb := jsonb_build_object('contractId', p_contract_id, 'decision', p_decision, 'reason', p_reason,
    'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_reason text;
  v_ended integer := 0;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  c := authz.rc_lock(p_contract_id);
  -- The enterer is told so (also when they hold Purchase as well as Manager).
  if c.entered_by = v_uid and authz.holds_active_role('manager', c.legal_entity_id) then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if not authz.rc_approver(c.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.rc_require_on();
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(c.legal_entity_id, p_request_id, 'rate_contract_decide', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if c.status <> 'pending_approval' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, c.row_version);
  if p_decision is null or p_decision not in ('approve', 'return') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'decision';
  end if;

  if p_decision = 'return' then
    v_reason := authz.rc_reason(p_reason, 500);
    update public.rate_contracts x
    set status = 'returned', decided_by = v_uid, decided_at = now(), return_reason = v_reason,
        row_version = x.row_version + 1, updated_at = now()
    where x.id = c.id
    returning * into c;
    perform authz.write_audit('purchase.rate_contract.returned', c.legal_entity_id, null, 'rate_contract', c.id, v_reason,
      jsonb_build_object('contractId', c.id, 'versionNo', c.version_no, 'rowVersion', c.row_version));
  else
    -- 17.1 step 5: the supplier + hotel pair, then the older contracts by id.
    perform authz.rc_lock_pair(c.supplier_id, c.hotel_id);
    for o in
      select * from public.rate_contracts x
      where x.supplier_id = c.supplier_id and x.hotel_id = c.hotel_id and x.status = 'active' and x.id <> c.id
        and x.valid_from <= c.valid_to and c.valid_from <= x.valid_to
      order by x.id
      for update
    loop
      update public.rate_contracts x
      set status = 'ended', ended_by = v_uid, ended_at = now(), end_reason = 'Replaced by ' || c.contract_no,
          row_version = x.row_version + 1, updated_at = now()
      where x.id = o.id;
      perform authz.write_audit('purchase.rate_contract.ended', o.legal_entity_id, null, 'rate_contract', o.id,
        'Replaced by ' || c.contract_no,
        jsonb_build_object('contractId', o.id, 'replacedBy', c.id, 'versionNo', o.version_no));
      v_ended := v_ended + 1;
    end loop;
    update public.rate_contracts x
    set status = 'active', decided_by = v_uid, decided_at = now(), return_reason = null,
        row_version = x.row_version + 1, updated_at = now()
    where x.id = c.id
    returning * into c;
    perform authz.write_audit('purchase.rate_contract.approved', c.legal_entity_id, null, 'rate_contract', c.id, null,
      jsonb_build_object('contractId', c.id, 'versionNo', c.version_no, 'endedOlder', v_ended, 'rowVersion', c.row_version));
  end if;
  v_result := authz.rc_result(c, 'updated') || jsonb_build_object('endedOlder', v_ended);
  return authz.finance_remember(c.legal_entity_id, p_request_id, 'rate_contract_decide', v_payload, v_result);
end;
$$;

create function public.rate_contract_end(p_contract_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.rate_contracts%rowtype;
  v_uid uuid := (select auth.uid());
  v_payload jsonb := jsonb_build_object('contractId', p_contract_id, 'expectedRowVersion', p_expected_row_version,
    'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  c := authz.rc_lock(p_contract_id);
  if not authz.rc_approver(c.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.rc_require_on();
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(c.legal_entity_id, p_request_id, 'rate_contract_end', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if c.status <> 'active' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, c.row_version);
  v_reason := authz.rc_reason(p_reason, 500);
  update public.rate_contracts x
  set status = 'ended', ended_by = v_uid, ended_at = now(), end_reason = v_reason, row_version = x.row_version + 1, updated_at = now()
  where x.id = c.id
  returning * into c;
  perform authz.write_audit('purchase.rate_contract.ended', c.legal_entity_id, null, 'rate_contract', c.id, v_reason,
    jsonb_build_object('contractId', c.id, 'versionNo', c.version_no, 'rowVersion', c.row_version));
  v_result := authz.rc_result(c, 'updated');
  return authz.finance_remember(c.legal_entity_id, p_request_id, 'rate_contract_end', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 6. E5 contract files (pattern of purchase_evidence; bucket purchase-evidence)
-- ===========================================================================

create function public.rate_contract_file_begin(p_contract_id uuid, p_file_name text, p_mime text, p_size_bytes integer,
  p_sha256 text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.rate_contracts%rowtype;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_name text := btrim(coalesce(p_file_name, ''));
  v_sha text := lower(coalesce(p_sha256, ''));
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  c := authz.rc_lock(p_contract_id);
  if not authz.can_manage_suppliers(c.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.rc_require_on();
  if c.status = 'ended' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes not between 1 and 4194304
     or v_sha !~ '^[0-9a-f]{64}$'
     or length(v_name) not between 1 and 120 or v_name !~ '^[A-Za-z0-9._ -]+$' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  if (select count(*) from public.rate_contract_files f where f.contract_id = c.id and f.status <> 'removed') >= 10 then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  v_path := c.legal_entity_id::text || '/rate-contracts/' || c.id::text || '/' || v_id::text;
  insert into public.rate_contract_files (id, legal_entity_id, contract_id, object_path, file_name, mime, size_bytes, sha256, uploaded_by)
  values (v_id, c.legal_entity_id, c.id, v_path, v_name, p_mime, p_size_bytes, v_sha, (select auth.uid()));
  return jsonb_build_object('fileId', v_id, 'objectPath', v_path);
end;
$$;

create function public.rate_contract_file_finish(p_file_id uuid, p_ok boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.rate_contracts%rowtype;
  f public.rate_contract_files%rowtype;
  v_status text;
  v_missing boolean := false;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Lock order: the contract, then the file.
  select * into c from public.rate_contracts x
  where x.id = (select y.contract_id from public.rate_contract_files y where y.id = p_file_id)
  for update;
  select * into f from public.rate_contract_files y where y.id = p_file_id for update;
  if f.id is null or c.id is null or f.uploaded_by is distinct from (select auth.uid())
     or not authz.can_manage_suppliers(c.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_ok is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'ok';
  end if;
  v_status := case when p_ok then 'stored' else 'failed' end;
  if f.status <> 'pending_upload' then
    if f.status = v_status or (p_ok and f.status = 'failed') then
      return jsonb_build_object('fileId', f.id, 'status', f.status);
    end if;
    raise exception 'invalid_input' using errcode = '22023', hint = 'ok';
  end if;
  -- 'stored' only when Storage holds the object at the generated path with the declared size.
  if p_ok and (to_regclass('storage.objects') is null or not exists (
       select 1 from storage.objects o
       where o.bucket_id = 'purchase-evidence' and o.name = f.object_path
         and (o.metadata ->> 'size') ~ '^[0-9]{1,18}$'
         and (o.metadata ->> 'size')::bigint = f.size_bytes)) then
    v_status := 'failed';
    v_missing := true;
  end if;
  update public.rate_contract_files y
  set status = v_status, stored_at = case when v_status = 'stored' then now() end, updated_at = now()
  where y.id = f.id;
  perform authz.write_audit(case when v_status = 'stored' then 'purchase.rate_contract_file.stored'
                                 else 'purchase.rate_contract_file.failed' end,
    c.legal_entity_id, null, 'rate_contract_file', f.id, null,
    jsonb_build_object('contractId', c.id, 'objectMissing', v_missing));
  return jsonb_build_object('fileId', f.id, 'status', v_status);
end;
$$;

create function public.rate_contract_file_authorize_download(p_file_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  f public.rate_contract_files%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into f from public.rate_contract_files y where y.id = p_file_id;
  if f.id is null or not authz.rc_can_read(f.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if f.status <> 'stored' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.write_audit('purchase.rate_contract_file.downloaded', f.legal_entity_id, null, 'rate_contract_file', f.id, null,
    jsonb_build_object('contractId', f.contract_id));
  return jsonb_build_object('objectPath', f.object_path, 'fileName', f.file_name, 'mime', f.mime);
end;
$$;

-- ===========================================================================
-- 7. Privileges
-- ===========================================================================

revoke all on function authz.rc_text_field(jsonb, text, integer, boolean, text), authz.rc_uuid(jsonb), authz.rc_reason(text, integer),
  authz.rc_require_on(), authz.rc_link_ok(uuid, uuid), authz.rc_next_number(uuid),
  authz.rc_result(public.rate_contracts, text), authz.rc_lock(uuid)
from public, anon, authenticated, service_role;

revoke all on function
  public.hotel_room_type_save(uuid, uuid, integer, text, uuid),
  public.hotel_room_type_remove(uuid, text, uuid),
  public.rate_contract_save(uuid, integer, jsonb, uuid),
  public.rate_contract_lines_set(uuid, integer, jsonb, jsonb, uuid),
  public.rate_contract_submit(uuid, integer, uuid),
  public.rate_contract_decide(uuid, text, text, integer, uuid),
  public.rate_contract_end(uuid, integer, text, uuid),
  public.rate_contract_file_begin(uuid, text, text, integer, text),
  public.rate_contract_file_finish(uuid, boolean),
  public.rate_contract_file_authorize_download(uuid)
from public, anon, authenticated, service_role;
grant execute on function
  public.hotel_room_type_save(uuid, uuid, integer, text, uuid),
  public.hotel_room_type_remove(uuid, text, uuid),
  public.rate_contract_save(uuid, integer, jsonb, uuid),
  public.rate_contract_lines_set(uuid, integer, jsonb, jsonb, uuid),
  public.rate_contract_submit(uuid, integer, uuid),
  public.rate_contract_decide(uuid, text, text, integer, uuid),
  public.rate_contract_end(uuid, integer, text, uuid),
  public.rate_contract_file_begin(uuid, text, text, integer, text),
  public.rate_contract_file_finish(uuid, boolean),
  public.rate_contract_file_authorize_download(uuid)
to authenticated;

commit;
