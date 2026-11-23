-- TripNavigate CRM - Accounts phase 3, track E (4 of 5): rate-sheet import
-- (import kind 'rate_sheet'). Contract: accounts-phase3-2026-11-12/contract.md
-- section 9.4, LD22, 17.1 (import batch lock, then rows by id; supplier +
-- hotel pair lock when a draft is created).
--
-- Rules:
--   * Purchase of the entity (authz.can_manage_suppliers) or Super Admin
--     stage, check, read and apply; the rate contracts switch must be On to
--     stage or apply (rate_contracts_off).
--   * Columns (strings or null): supplierRef (suppliers.source_ref, or the
--     exact supplier name), hotelRef (hotel_catalogue.source_ref, or the exact
--     name of one active hotel; the optional city column narrows it),
--     validFrom, validTo, seasonFrom, seasonTo (YYYY-MM-DD), roomType,
--     mealPlan (code EP/CP/MAP/AP/AI or its label), rate, weekendRate,
--     extraAdult, childWithBed, childWithoutBed (rupees), blackoutDates
--     ("from..to; from..to"), cancellationTerms.
--   * Row outcomes create | invalid. Reasons: supplier_not_found,
--     hotel_not_found, supplier_does_not_sell_hotel (no hotel service, not
--     active, or no active link), dates_invalid, season_outside_validity
--     (season or blackout outside the validity), meal_plan_invalid,
--     rate_invalid, line_overlap, duplicate_in_file (the first row wins);
--     besides the generic not_text, unknown_column, formula_cell, and
--     room_type_invalid, terms_too_long, too_many_lines (more than 500 lines
--     for one contract). Warnings: new_room_type, overlaps_active_contract.
--   * Summary (dry run, set-based): the usual import keys plus rateSheet
--     {contracts, lines, newRoomTypes, invalidRows, warnings {newRoomType,
--     overlapsActiveContract}}. proposalHash covers every row's outcome,
--     supplier, hotel, room type (null = new), meal plan, reasons and
--     warnings: a room type added since the check makes apply import_stale.
--   * Apply creates the missing room types and one DRAFT contract per
--     (supplier, hotel, validity) with its lines and blackouts (source
--     'import'); it never touches an active contract. A Manager then approves
--     each draft (E7). Staged cells are kept (no personal data).
--
-- Replaced (latest bodies; changed lines marked "Accounts phase 3 (20261205000530)"):
--   authz.vn_import_role (M/20261204000120:57): rate_sheet -> Purchase or Super Admin.
--   authz.vn_import_evaluate (M/20261204000120:467): rate_sheet -> the new evaluation.
--   public.import_batch_stage (M/20261204000140:526): accepts rate_sheet (no branch).
--   public.import_batch_apply (M/20261204000140:612): the rate_sheet branch.
--   public.import_batch_get (M/20261204000120:978): rate_sheet rows with their values.
--   public.import_batch_list (M/20261204000120:1044): accepts rate_sheet.
--   import_batch_cancel and import_batch_validate need no change (they go
--   through vn_import_lock / vn_import_evaluate).
--
-- Refusal tokens: unchanged import tokens; rate_contracts_off (55000).
-- Audit: import.staged | validated | applied | cancelled with kind
-- 'rate_sheet'; purchase.rate_contract.saved (source import) per draft.
-- Rollback (forward-only): a new migration restoring the replaced bodies.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Row rule (set-based)
-- ===========================================================================

-- A sheet cell: trimmed text with spaces collapsed; null when blank or not a string.
create function authz.rc_sheet_cell(p_data jsonb, p_key text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select case when jsonb_typeof(p_data -> p_key) = 'string'
              then nullif(regexp_replace(btrim(p_data ->> p_key, E' \t\r\n'), '\s+', ' ', 'g'), '') end
$$;

-- Every row of a rate-sheet batch, parsed and matched: reasons (empty = create),
-- warnings and the resolved values. Read-only.
create function authz.rc_sheet_rows(p_batch public.import_batches)
returns table (row_no integer, reasons text[], warnings text[], supplier_id uuid, hotel_id uuid, valid_from date, valid_to date,
  season_from date, season_to date, room_type_id uuid, room_name text, meal_plan text, rate_paise bigint,
  weekend_rate_paise bigint, extra_adult_paise bigint, child_with_bed_paise bigint, child_without_bed_paise bigint,
  blackouts jsonb, cancellation_terms text)
language sql stable security definer set search_path = '' as $$
  with raw as (
    select x.row_no,
      exists (select 1 from jsonb_each(x.data) e where jsonb_typeof(e.value) not in ('string', 'null')) as not_text,
      exists (select 1 from jsonb_object_keys(x.data) k
              where k not in ('supplierRef', 'hotelRef', 'city', 'validFrom', 'validTo', 'seasonFrom', 'seasonTo', 'roomType',
                              'mealPlan', 'rate', 'weekendRate', 'extraAdult', 'childWithBed', 'childWithoutBed',
                              'blackoutDates', 'cancellationTerms')) as unknown_col,
      cardinality(authz.vn_formula_keys(x.data)) > 0 as formula,
      authz.rc_sheet_cell(x.data, 'supplierRef') as c_sup,
      authz.rc_sheet_cell(x.data, 'hotelRef') as c_hotel,
      authz.rc_sheet_cell(x.data, 'city') as c_city,
      authz.rc_sheet_cell(x.data, 'validFrom') as c_vf,
      authz.rc_sheet_cell(x.data, 'validTo') as c_vt,
      authz.rc_sheet_cell(x.data, 'seasonFrom') as c_sf,
      authz.rc_sheet_cell(x.data, 'seasonTo') as c_st,
      authz.rc_sheet_cell(x.data, 'roomType') as c_room,
      authz.rc_sheet_cell(x.data, 'mealPlan') as c_meal,
      authz.rc_sheet_cell(x.data, 'rate') as c_rate,
      authz.rc_sheet_cell(x.data, 'weekendRate') as c_weekend,
      authz.rc_sheet_cell(x.data, 'extraAdult') as c_xa,
      authz.rc_sheet_cell(x.data, 'childWithBed') as c_cb,
      authz.rc_sheet_cell(x.data, 'childWithoutBed') as c_cnb,
      authz.rc_sheet_cell(x.data, 'blackoutDates') as c_black,
      case when jsonb_typeof(x.data -> 'cancellationTerms') = 'string'
           then nullif(btrim(x.data ->> 'cancellationTerms', E' \t\r\n'), '') end as c_terms
    from public.import_rows x
    where x.batch_id = p_batch.id
  ),
  p as (
    select r.*,
      authz.rc_date(r.c_vf) as vf, authz.rc_date(r.c_vt) as vt, authz.rc_date(r.c_sf) as sf, authz.rc_date(r.c_st) as st,
      authz.rc_meal_code(r.c_meal) as meal,
      authz.rc_rupees_paise(r.c_rate) as rate, authz.rc_rupees_paise(r.c_weekend) as weekend,
      authz.rc_rupees_paise(r.c_xa) as xa, authz.rc_rupees_paise(r.c_cb) as cb, authz.rc_rupees_paise(r.c_cnb) as cnb,
      authz.rc_blackouts(r.c_black) as bl,
      lower(r.c_room) as room_key,
      sup.id as sup_id, coalesce(sup.hotel_kind, false) as hotel_kind,
      ht.id as hotel_id_
    from raw r
    left join lateral (
      select s.id, ('hotel' = any (s.service_types) and s.status = 'active') as hotel_kind
      from public.suppliers s
      where r.c_sup is not null and s.legal_entity_id = p_batch.legal_entity_id
        and (s.source_ref = r.c_sup or lower(s.name) = lower(r.c_sup))
      order by (s.source_ref is not distinct from r.c_sup) desc, s.id
      limit 1) sup on true
    left join lateral (
      select coalesce(
        (select h.id from public.hotel_catalogue h
         where r.c_hotel is not null and h.legal_entity_id = p_batch.legal_entity_id and h.status = 'active' and h.source_ref = r.c_hotel),
        (select case when count(*) = 1 then (array_agg(h.id))[1] end
         from public.hotel_catalogue h
         where r.c_hotel is not null and h.legal_entity_id = p_batch.legal_entity_id and h.status = 'active'
           and h.name_key = lower(r.c_hotel) and (r.c_city is null or lower(h.city) = lower(r.c_city)))) as id) ht on true
  ),
  b as (
    select p.*,
      rt.id as rt_id,
      (p.sup_id is not null and p.hotel_id_ is not null and p.hotel_kind
       and exists (select 1 from public.supplier_hotels l
                   where l.supplier_id = p.sup_id and l.hotel_id = p.hotel_id_ and l.status = 'active')) as sells,
      coalesce(p.vf is not null and p.vt is not null and p.sf is not null and p.st is not null and p.vf <= p.vt
               and p.vt - p.vf <= 1100 and p.sf <= p.st and (p.bl is null or jsonb_typeof(p.bl) = 'array'), false) as dates_ok
    from p
    left join lateral (
      select t.id from public.hotel_room_types t
      where t.hotel_id = p.hotel_id_ and t.status = 'active' and t.name_key = p.room_key) rt on true
  ),
  c as (
    select b.*,
      array_remove(array[
        case when b.not_text then 'not_text' end,
        case when b.unknown_col then 'unknown_column' end,
        case when b.formula then 'formula_cell' end,
        case when b.sup_id is null then 'supplier_not_found' end,
        case when b.hotel_id_ is null then 'hotel_not_found' end,
        case when b.sup_id is not null and b.hotel_id_ is not null and not b.sells then 'supplier_does_not_sell_hotel' end,
        case when not b.dates_ok then 'dates_invalid' end,
        case when b.dates_ok and (b.sf < b.vf or b.st > b.vt
                                  or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(b.bl) = 'array' then b.bl else '[]'::jsonb end) e
                                             where (e ->> 'fromDate')::date < b.vf or (e ->> 'toDate')::date > b.vt))
             then 'season_outside_validity' end,
        case when b.meal is null then 'meal_plan_invalid' end,
        case when b.rate is null or b.rate <= 0 or coalesce(b.weekend, 1) <= 0 or coalesce(b.xa, 0) < 0
                  or coalesce(b.cb, 0) < 0 or coalesce(b.cnb, 0) < 0 then 'rate_invalid' end,
        case when b.c_room is null or char_length(b.c_room) > 120 then 'room_type_invalid' end,
        case when char_length(coalesce(b.c_terms, '')) > 2000 then 'terms_too_long' end
      ]::text[], null) as r0
    from b
  ),
  ok as (
    select c.row_no, c.sup_id, c.hotel_id_, c.vf, c.vt, c.room_key, c.meal, c.sf, c.st,
      row_number() over (partition by c.sup_id, c.hotel_id_, c.vf, c.vt, c.room_key, c.meal, c.sf, c.st order by c.row_no) as dup_rank
    from c where cardinality(c.r0) = 0
  ),
  nd as (
    select ok.*,
      max(ok.st) over (partition by ok.sup_id, ok.hotel_id_, ok.vf, ok.vt, ok.room_key, ok.meal
                       order by ok.sf, ok.row_no rows between unbounded preceding and 1 preceding) as prev_st
    from ok where ok.dup_rank = 1
  ),
  grp as (
    select nd.row_no,
      row_number() over (partition by nd.sup_id, nd.hotel_id_, nd.vf, nd.vt order by nd.row_no) as grp_rank
    from nd where nd.prev_st is null or nd.sf > nd.prev_st
  ),
  fin as (
    select c.*,
      case
        when cardinality(c.r0) > 0 then c.r0
        when ok.dup_rank > 1 then array['duplicate_in_file']
        when g.row_no is null then array['line_overlap']
        when g.grp_rank > 500 then array['too_many_lines']
        else '{}'::text[] end as reasons_
    from c
    left join ok on ok.row_no = c.row_no
    left join grp g on g.row_no = c.row_no
  )
  select f.row_no,
    array(select distinct y from unnest(f.reasons_) y order by y),
    case when cardinality(f.reasons_) = 0 then array_remove(array[
        case when f.rt_id is null then 'new_room_type' end,
        case when exists (select 1 from public.rate_contracts x
                          where x.supplier_id = f.sup_id and x.hotel_id = f.hotel_id_ and x.status = 'active'
                            and x.valid_from <= f.vt and f.vf <= x.valid_to) then 'overlaps_active_contract' end
      ]::text[], null) else '{}'::text[] end,
    f.sup_id, f.hotel_id_, f.vf, f.vt, f.sf, f.st, f.rt_id, f.c_room, f.meal, f.rate, f.weekend, f.xa, f.cb, f.cnb,
    f.bl, f.c_terms
  from fin f
$$;

-- ===========================================================================
-- 2. Evaluation (dry run and the re-run inside apply)
-- ===========================================================================

create function authz.vn_import_evaluate_rate_sheet(p_batch public.import_batches) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v jsonb;
begin
  with r as materialized (select * from authz.rc_sheet_rows(p_batch)),
  u as (
    update public.import_rows x
    set source_ref = null, outcome = case when cardinality(r.reasons) = 0 then 'create' else 'invalid' end,
        reasons = r.reasons, warnings = r.warnings, target_id = null
    from r
    where x.batch_id = p_batch.id and x.row_no = r.row_no
    returning x.row_no)
  select jsonb_build_object(
    'batchId', p_batch.id, 'kind', p_batch.kind,
    'rows', (select count(*) from r), 'rowCount', (select count(*) from r),
    'valid', (select count(*) from r where cardinality(r.reasons) = 0),
    'invalid', (select count(*) from r where cardinality(r.reasons) > 0),
    'duplicatesInFile', 0, 'possibleDuplicates', 0, 'assumedRows', 0, 'clearRows', 0, 'rowNotes', '[]'::jsonb,
    'proposed', jsonb_build_object('create', (select count(*) from r where cardinality(r.reasons) = 0),
                                   'update', 0, 'unchanged', 0, 'skippedChecked', 0),
    'proposalHash', encode(sha256(convert_to(coalesce((
      select jsonb_agg(jsonb_build_array(r.row_no, case when cardinality(r.reasons) = 0 then 'create' else 'invalid' end,
          r.supplier_id, r.hotel_id, r.room_type_id, r.meal_plan, to_jsonb(r.reasons), to_jsonb(r.warnings)) order by r.row_no)
      from r), '[]'::jsonb)::text, 'UTF8')), 'hex'),
    'invalidRows', coalesce((
      select jsonb_agg(jsonb_build_object('rowNo', y.row_no, 'reasons', to_jsonb(y.reasons)) order by y.row_no)
      from (select r.row_no, r.reasons from r where cardinality(r.reasons) > 0 order by r.row_no limit 200) y), '[]'::jsonb),
    'duplicateRows', '[]'::jsonb,
    'rateSheet', jsonb_build_object(
      'contracts', (select count(*) from (select distinct r.supplier_id, r.hotel_id, r.valid_from, r.valid_to
                                          from r where cardinality(r.reasons) = 0) g),
      'lines', (select count(*) from r where cardinality(r.reasons) = 0),
      'newRoomTypes', (select count(*) from (select distinct r.hotel_id, lower(r.room_name)
                                             from r where cardinality(r.reasons) = 0 and r.room_type_id is null) t),
      'invalidRows', (select count(*) from r where cardinality(r.reasons) > 0),
      'warnings', jsonb_build_object(
        'newRoomType', (select count(*) from r where 'new_room_type' = any (r.warnings)),
        'overlapsActiveContract', (select count(*) from r where 'overlaps_active_contract' = any (r.warnings)))))
  into v;
  return v || jsonb_build_object('columns', coalesce((
    select jsonb_agg(jsonb_build_object('key', c.k, 'filled', c.filled) order by c.k)
    from (select e.key as k, count(*) filter (where jsonb_typeof(e.value) = 'string' and btrim(e.value #>> '{}') <> '') as filled
          from public.import_rows x, jsonb_each(x.data) e where x.batch_id = p_batch.id group by e.key) c), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- 3. Apply (rate-sheet rows): room types, then one draft per supplier + hotel + validity
-- ===========================================================================

-- The caller holds the batch lock and the hotel_room_types table lock and has
-- checked the proposal hash. Answers {created (contracts), lines, roomTypes}.
create function authz.vn_import_apply_rate_sheet(p_batch public.import_batches) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  g record;
  c public.rate_contracts%rowtype;
  v_version integer;
  v_types integer := 0;
  v_contracts integer := 0;
  v_lines integer := 0;
  v_n integer;
begin
  drop table if exists pg_temp.rc_apply_rows;
  create temp table rc_apply_rows on commit drop as
    select * from authz.rc_sheet_rows(p_batch) r where cardinality(r.reasons) = 0;

  insert into public.hotel_room_types (legal_entity_id, hotel_id, name, created_by, updated_by, import_batch_id)
  select distinct on (r.hotel_id, lower(r.room_name)) p_batch.legal_entity_id, r.hotel_id, r.room_name, v_uid, v_uid, p_batch.id
  from pg_temp.rc_apply_rows r
  where r.room_type_id is null
  order by r.hotel_id, lower(r.room_name), r.row_no;
  get diagnostics v_types = row_count;

  for g in
    select r.supplier_id, r.hotel_id, r.valid_from, r.valid_to, min(r.row_no) as first_row,
      (array_agg(r.cancellation_terms order by r.row_no) filter (where r.cancellation_terms is not null))[1] as terms
    from pg_temp.rc_apply_rows r
    group by r.supplier_id, r.hotel_id, r.valid_from, r.valid_to
    order by min(r.row_no)
  loop
    perform authz.rc_lock_pair(g.supplier_id, g.hotel_id);
    select coalesce(max(x.version_no), 0) + 1 into v_version
    from public.rate_contracts x where x.supplier_id = g.supplier_id and x.hotel_id = g.hotel_id;
    insert into public.rate_contracts (legal_entity_id, supplier_id, hotel_id, contract_no, version_no, valid_from, valid_to,
      cancellation_terms, source, import_batch_id, entered_by)
    values (p_batch.legal_entity_id, g.supplier_id, g.hotel_id, authz.rc_next_number(p_batch.legal_entity_id), v_version,
      g.valid_from, g.valid_to, g.terms, 'import', p_batch.id, v_uid)
    returning * into c;
    insert into public.rate_contract_lines (legal_entity_id, contract_id, line_no, season_from, season_to, room_type_id, meal_plan,
      rate_paise, weekend_rate_paise, extra_adult_paise, child_with_bed_paise, child_without_bed_paise)
    select c.legal_entity_id, c.id, row_number() over (order by r.row_no), r.season_from, r.season_to, t.id, r.meal_plan,
      r.rate_paise, r.weekend_rate_paise, r.extra_adult_paise, r.child_with_bed_paise, r.child_without_bed_paise
    from pg_temp.rc_apply_rows r
    join public.hotel_room_types t on t.hotel_id = r.hotel_id and t.status = 'active' and t.name_key = lower(r.room_name)
    where r.supplier_id = g.supplier_id and r.hotel_id = g.hotel_id and r.valid_from = g.valid_from and r.valid_to = g.valid_to;
    get diagnostics v_n = row_count;
    v_lines := v_lines + v_n;
    insert into public.rate_contract_blackouts (legal_entity_id, contract_id, from_date, to_date)
    select distinct c.legal_entity_id, c.id, (e ->> 'fromDate')::date, (e ->> 'toDate')::date
    from pg_temp.rc_apply_rows r, jsonb_array_elements(coalesce(r.blackouts, '[]'::jsonb)) e
    where r.supplier_id = g.supplier_id and r.hotel_id = g.hotel_id and r.valid_from = g.valid_from and r.valid_to = g.valid_to;
    update public.import_rows x set target_id = c.id
    where x.batch_id = p_batch.id and x.row_no in (
      select r.row_no from pg_temp.rc_apply_rows r
      where r.supplier_id = g.supplier_id and r.hotel_id = g.hotel_id and r.valid_from = g.valid_from and r.valid_to = g.valid_to);
    perform authz.write_audit('purchase.rate_contract.saved', c.legal_entity_id, null, 'rate_contract', c.id, null,
      jsonb_build_object('contractId', c.id, 'supplierId', c.supplier_id, 'hotelId', c.hotel_id, 'versionNo', c.version_no,
        'outcome', 'created', 'source', 'import', 'batchId', p_batch.id, 'lines', v_n));
    v_contracts := v_contracts + 1;
  end loop;
  drop table if exists pg_temp.rc_apply_rows;
  return jsonb_build_object('created', v_contracts, 'lines', v_lines, 'roomTypes', v_types);
end;
$$;

-- ===========================================================================
-- 4. Role
-- ===========================================================================

create or replace function authz.vn_import_role(p_entity uuid, p_kind text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case p_kind
    when 'hotel' then coalesce(authz.can_switch_live_settings(p_entity), false)
    when 'customer' then coalesce(authz.vn_party_accounts(p_entity), false)
    -- Accounts phase 2 (20261204000120, LD21).
    when 'supplier' then coalesce(authz.vn_party_accounts(p_entity), false)
                         or coalesce(authz.can_switch_live_settings(p_entity), false)
    -- Accounts phase 3 (20261205000530, LD22): Purchase or Super Admin.
    when 'rate_sheet' then coalesce(authz.can_manage_suppliers(p_entity), false)
                           or coalesce(authz.can_switch_live_settings(p_entity), false)
    else false end
$$;

-- ===========================================================================
-- 5. Replaced bodies
-- ===========================================================================

create or replace function authz.vn_import_evaluate(p_batch public.import_batches) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.import_rows%rowtype;
  v_chk jsonb;
  v_vals jsonb;
  v_reasons text[];
  v_warn text[];
  v_ref text;
  v_outcome text;
  v_target uuid;
  v_hotel public.hotel_catalogue%rowtype;
  v_party public.customer_parties%rowtype;
  v_refs jsonb := '{}'::jsonb;
  v_names jsonb := '{}'::jsonb;
  v_name_key text;
  v_same boolean;
  v_target_rv integer;   -- Echo-A L3
  v_proposal jsonb := '[]'::jsonb;
  v_present jsonb;       -- Echo-A L6
  v_stored jsonb;
begin
  -- Accounts phase 2 (20261204000120).
  if p_batch.kind = 'supplier' then
    return authz.vn_import_evaluate_supplier(p_batch);
  end if;
  -- Accounts phase 3 (20261205000530): rate sheets.
  if p_batch.kind = 'rate_sheet' then
    return authz.vn_import_evaluate_rate_sheet(p_batch);
  end if;
  -- Pass 1: source references and name keys seen in the file.
  for r in select * from public.import_rows x where x.batch_id = p_batch.id order by x.row_no loop
    v_ref := nullif(btrim(coalesce(case when jsonb_typeof(r.data -> 'sourceRef') = 'string' then r.data ->> 'sourceRef' end, '')), '');
    if v_ref is not null then
      v_refs := jsonb_set(v_refs, array[v_ref], to_jsonb(coalesce((v_refs ->> v_ref)::integer, 0) + 1));
    end if;
    v_name_key := lower(btrim(coalesce(case when jsonb_typeof(r.data -> 'name') = 'string' then r.data ->> 'name' end, '')))
      || case when p_batch.kind = 'hotel'
              then '|' || lower(btrim(coalesce(case when jsonb_typeof(r.data -> 'city') = 'string' then r.data ->> 'city' end, '')))
              else '' end;
    v_names := jsonb_set(v_names, array[v_name_key], to_jsonb(coalesce((v_names ->> v_name_key)::integer, 0) + 1));
  end loop;

  -- Pass 2: each row.
  for r in select * from public.import_rows x where x.batch_id = p_batch.id order by x.row_no loop
    v_reasons := '{}';
    v_warn := '{}';
    v_target := null;
    v_target_rv := null;
    v_outcome := null;
    v_stored := null;
    if exists (select 1 from jsonb_each(r.data) e where jsonb_typeof(e.value) not in ('string', 'null')) then
      v_reasons := v_reasons || 'not_text'::text;
    end if;
    if p_batch.kind = 'hotel' then
      -- An import never verifies a hotel.
      if r.data ? 'verification' then
        v_reasons := v_reasons || 'unknown_column'::text;
      end if;
      v_chk := authz.vn_hotel_check(r.data - 'verification');
    else
      v_chk := authz.vn_party_check(r.data, false);
      -- Lead ruling Q8: what the rule assumed, flagged per row.
      v_warn := v_warn || array(select jsonb_array_elements_text(coalesce(v_chk -> 'notes', '[]'::jsonb)));
    end if;
    v_reasons := v_reasons || array(select jsonb_array_elements_text(v_chk -> 'reasons'));
    v_vals := v_chk -> 'values';
    v_ref := v_vals ->> 'sourceRef';
    v_name_key := lower(coalesce(v_vals ->> 'name', ''))
      || case when p_batch.kind = 'hotel' then '|' || lower(coalesce(v_vals ->> 'city', '')) else '' end;

    if cardinality(v_reasons) > 0 then
      v_outcome := 'invalid';
    elsif v_ref is not null and coalesce((v_refs ->> v_ref)::integer, 0) > 1 then
      v_outcome := 'duplicate_in_file';
      v_reasons := array['duplicate_in_file'];
    elsif p_batch.kind = 'hotel' then
      select * into v_hotel from public.hotel_catalogue h
      where v_ref is not null and h.legal_entity_id = p_batch.legal_entity_id and h.source_ref = v_ref;
      if v_hotel.id is not null then
        v_target := v_hotel.id;
        v_target_rv := v_hotel.row_version;
        v_stored := authz.vn_hotel_fields(v_hotel);
        v_same := authz.vn_hotel_fields(v_hotel)
                  = (authz.vn_hotel_fields(v_hotel) || (authz.vn_import_present(v_vals, r.data) - 'sourceRef'));
        v_outcome := case when v_same then 'unchanged' when v_hotel.verification = 'checked' then 'skipped_checked' else 'update' end;
      else
        v_outcome := 'create';
        if exists (select 1 from public.hotel_catalogue h
                   where h.legal_entity_id = p_batch.legal_entity_id and h.name_key = lower(v_vals ->> 'name')
                     and lower(h.city) = lower(v_vals ->> 'city')) then
          v_warn := v_warn || 'same_name_stored'::text;
        end if;
      end if;
    else
      select * into v_party from public.customer_parties p
      where v_ref is not null and p.legal_entity_id = p_batch.legal_entity_id and p.source_ref = v_ref;
      if v_party.id is not null then
        v_target := v_party.id;
        v_target_rv := v_party.row_version;
        v_stored := authz.vn_party_fields(v_party);
        v_same := authz.vn_party_fields(v_party)
                  = (authz.vn_party_fields(v_party) || (authz.vn_import_present(v_vals, r.data) - 'sourceRef'));
        v_outcome := case when v_same then 'unchanged' when v_party.check_status = 'checked' then 'skipped_checked' else 'update' end;
      else
        v_outcome := 'create';
        if exists (select 1 from public.customer_parties p
                   where p.legal_entity_id = p_batch.legal_entity_id and p.name_key = lower(v_vals ->> 'name')) then
          v_warn := v_warn || 'same_name_stored'::text;
        end if;
      end if;
    end if;
    if v_outcome in ('create', 'update', 'unchanged') and coalesce((v_names ->> v_name_key)::integer, 0) > 1 then
      v_warn := v_warn || 'same_name_in_file'::text;
    end if;
    -- Echo-A L6: an update clears a stored value whose column is in the file but blank.
    if v_outcome = 'update' then
      v_present := authz.vn_import_present(v_vals, r.data) - 'sourceRef';
      v_warn := v_warn || array(select 'will_clear:' || e.key from jsonb_each(v_present) e
                                where jsonb_typeof(e.value) = 'null' and v_stored ? e.key
                                  and jsonb_typeof(v_stored -> e.key) <> 'null');
    end if;
    -- Echo-A L3: what this row will do, against which stored version.
    v_proposal := v_proposal || jsonb_build_array(jsonb_build_array(r.row_no, v_outcome, v_target, v_target_rv,
      to_jsonb(array(select distinct y from unnest(v_reasons) y order by y))));
    update public.import_rows x
    set source_ref = v_ref, outcome = v_outcome,
        reasons = array(select distinct y from unnest(v_reasons) y order by y),
        warnings = array(select distinct y from unnest(v_warn) y order by y), target_id = v_target
    where x.batch_id = r.batch_id and x.row_no = r.row_no;
  end loop;

  return jsonb_build_object(
    'batchId', p_batch.id, 'kind', p_batch.kind,
    'rows', (select count(*) from public.import_rows x where x.batch_id = p_batch.id),
    'valid', (select count(*) from public.import_rows x where x.batch_id = p_batch.id
              and x.outcome in ('create', 'update', 'unchanged', 'skipped_checked')),
    'invalid', (select count(*) from public.import_rows x where x.batch_id = p_batch.id and x.outcome = 'invalid'),
    'duplicatesInFile', (select count(*) from public.import_rows x where x.batch_id = p_batch.id and x.outcome = 'duplicate_in_file'),
    'possibleDuplicates', (select count(*) from public.import_rows x where x.batch_id = p_batch.id
                           and x.warnings && array['same_name_stored', 'same_name_in_file']),
    -- Lead ruling Q8: rows where a value was assumed (GST status registered from a GSTIN, a padded state code).
    'assumedRows', (select count(*) from public.import_rows x where x.batch_id = p_batch.id
                    and x.warnings && array['gst_status_assumed_registered', 'state_code_padded']),
    -- Echo-A L6: rows whose update clears a stored value (note will_clear:<key>).
    'clearRows', (select count(*) from public.import_rows x where x.batch_id = p_batch.id
                  and exists (select 1 from unnest(x.warnings) w where w like 'will\_clear:%')),
    'rowNotes', coalesce((
      select jsonb_agg(jsonb_build_object('rowNo', y.row_no, 'notes', to_jsonb(y.notes)) order by y.row_no)
      from (select x.row_no, array(select w from unnest(x.warnings) w
                                   where w not in ('same_name_stored', 'same_name_in_file') order by w) as notes
            from public.import_rows x
            where x.batch_id = p_batch.id
              and exists (select 1 from unnest(x.warnings) w where w not in ('same_name_stored', 'same_name_in_file'))
            order by x.row_no limit 200) y), '[]'::jsonb),
    -- Echo-A L3: hash of every row's outcome, target and target version.
    'proposalHash', encode(sha256(convert_to(v_proposal::text, 'UTF8')), 'hex'),
    'proposed', jsonb_build_object(
      'create', (select count(*) from public.import_rows x where x.batch_id = p_batch.id and x.outcome = 'create'),
      'update', (select count(*) from public.import_rows x where x.batch_id = p_batch.id and x.outcome = 'update'),
      'unchanged', (select count(*) from public.import_rows x where x.batch_id = p_batch.id and x.outcome = 'unchanged'),
      'skippedChecked', (select count(*) from public.import_rows x where x.batch_id = p_batch.id and x.outcome = 'skipped_checked')),
    'columns', coalesce((
      select jsonb_agg(jsonb_build_object('key', c.k, 'filled', c.filled) order by c.k)
      from (select e.key as k, count(*) filter (where jsonb_typeof(e.value) = 'string' and btrim(e.value #>> '{}') <> '') as filled
            from public.import_rows x, jsonb_each(x.data) e where x.batch_id = p_batch.id group by e.key) c), '[]'::jsonb),
    'invalidRows', coalesce((
      select jsonb_agg(jsonb_build_object('rowNo', y.row_no, 'reasons', to_jsonb(y.reasons)) order by y.row_no)
      from (select x.row_no, x.reasons from public.import_rows x
            where x.batch_id = p_batch.id and x.outcome = 'invalid' order by x.row_no limit 200) y), '[]'::jsonb),
    'duplicateRows', coalesce((
      select jsonb_agg(jsonb_build_object('rowNo', y.row_no, 'sourceRef', y.source_ref, 'kind', y.kind) order by y.row_no, y.kind)
      from (select x.row_no, x.source_ref, case when x.outcome = 'duplicate_in_file' then 'in_file' else 'same_name' end as kind
            from public.import_rows x
            where x.batch_id = p_batch.id and (x.outcome = 'duplicate_in_file'
                                               or x.warnings && array['same_name_stored', 'same_name_in_file'])
            order by x.row_no limit 200) y), '[]'::jsonb));
end;
$$;

create or replace function public.import_batch_stage(p_legal_entity_id uuid, p_kind text, p_branch_id uuid, p_file_name text,
  p_sha256 text, p_rows jsonb, p_request_id uuid, p_entity_wide boolean default false) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_existing public.import_batches%rowtype;
  v_name text := btrim(left(btrim(regexp_replace(coalesce(p_file_name, ''), '[^A-Za-z0-9._ -]', '_', 'g')), 120));
  v_sha text := lower(btrim(coalesce(p_sha256, '')));
  v_id uuid := gen_random_uuid();
  v_n integer;
begin
  -- Accounts phase 2 (20261204000120): 'supplier'.
  -- Accounts phase 3 (20261205000530): 'rate_sheet'.
  if p_kind is null or p_kind not in ('hotel', 'customer', 'supplier', 'rate_sheet') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  if p_legal_entity_id is null or not authz.vn_import_role(p_legal_entity_id, p_kind) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Accounts phase 3 (20261205000530): rate sheets need the rate contracts switch.
  if p_kind = 'rate_sheet' then
    perform authz.rc_require_on();
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into v_existing from public.import_batches b
  where b.legal_entity_id = p_legal_entity_id and b.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.uploaded_by is distinct from (select auth.uid()) or v_existing.kind <> p_kind
       or v_existing.source_sha256 <> v_sha or v_existing.branch_id is distinct from p_branch_id
       -- Accounts phase 3 (20261205000530): a rate sheet is always for the whole entity (the flag is ignored).
       or v_existing.entity_wide <> (case when p_kind = 'rate_sheet' then false else coalesce(p_entity_wide, false) end) then
      raise exception 'request_conflict' using errcode = '40001';
    end if;
    return jsonb_build_object('batchId', v_existing.id, 'rowCount', v_existing.row_count, 'outcome', 'existing');
  end if;
  if v_name = '' or v_name ~ '^[. ]+$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fileName';
  end if;
  if v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'sha256';
  end if;
  if p_kind in ('hotel', 'supplier', 'rate_sheet') and p_branch_id is not null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'branchId';
  end if;
  -- Echo-A M1: customers need a branch, or the explicit whole-company choice (never both).
  if p_kind = 'customer' and p_branch_id is null and coalesce(p_entity_wide, false) is false then
    raise exception 'invalid_input' using errcode = '22023', hint = 'branchId';
  end if;
  -- Accounts phase 3 (20261205000530): rate sheets ignore the flag (always the whole entity).
  if coalesce(p_entity_wide, false) and ((p_kind <> 'customer' and p_kind <> 'rate_sheet') or p_branch_id is not null) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'entityWide';
  end if;
  if p_branch_id is not null and not exists (
       select 1 from public.branches b where b.id = p_branch_id and b.legal_entity_id = p_legal_entity_id) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'branchId';
  end if;
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) = 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'rows';
  end if;
  v_n := jsonb_array_length(p_rows);
  if v_n > 5000 then
    raise exception 'import_too_large' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(p_rows) e
             where jsonb_typeof(e) <> 'object'
                or (select count(*) from jsonb_object_keys(e)) > 40
                or exists (select 1 from jsonb_each(e) f
                           where f.key !~ '^[A-Za-z][A-Za-z0-9]{0,39}$'
                              or (jsonb_typeof(f.value) = 'string' and char_length(f.value #>> '{}') > 1000))) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'rows';
  end if;
  insert into public.import_batches (id, legal_entity_id, kind, branch_id, entity_wide, request_id, source_file_name,
    source_sha256, row_count, uploaded_by)
  values (v_id, p_legal_entity_id, p_kind, p_branch_id, p_kind = 'customer' and coalesce(p_entity_wide, false), p_request_id,
    v_name, v_sha, v_n, (select auth.uid()));
  insert into public.import_rows (batch_id, row_no, legal_entity_id, data)
  select v_id, e.ordinality::integer, p_legal_entity_id,
    -- Accounts phase 2 (20261204000140, L7): a supplier row never stores a full
    -- account number: XXXX<last4> only (the full number comes again with Import).
    case when p_kind = 'supplier' and jsonb_typeof(e.value -> 'accountNumber') = 'string'
              and btrim(e.value ->> 'accountNumber') <> ''
         then authz.vn_supplier_stage_account(e.value)
         else e.value - 'accountNumberHash' end
  from jsonb_array_elements(p_rows) with ordinality e;
  -- Counts and the file hash only (never a file name or a value).
  perform authz.write_audit('import.staged', p_legal_entity_id, p_branch_id, 'import_batch', v_id, null,
    jsonb_build_object('kind', p_kind, 'rows', v_n, 'sha256', v_sha, 'entityWide', p_kind = 'customer' and coalesce(p_entity_wide, false)));
  return jsonb_build_object('batchId', v_id, 'rowCount', v_n, 'outcome', 'created');
end;
$$;

create or replace function public.import_batch_apply(p_batch_id uuid, p_expected_row_version integer, p_reason text,
  p_proposal_hash text default null, p_bank jsonb default null) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  b public.import_batches%rowtype;
  v_reason text;
  v_summary jsonb;
  r public.import_rows%rowtype;
  v_v jsonb;
  v_id uuid;
  v_hotel public.hotel_catalogue%rowtype;
  v_party public.customer_parties%rowtype;
  v_created integer := 0;
  v_updated integer := 0;
  v_result jsonb;
  v_counts jsonb;  -- Accounts phase 2
  v_rs jsonb;      -- Accounts phase 3 (20261205000530)
begin
  b := authz.vn_import_lock(p_batch_id);
  if b.status = 'applied' then
    return b.apply_result || jsonb_build_object('outcome', 'existing');
  end if;
  if b.status = 'cancelled' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if b.status <> 'validated' then
    raise exception 'import_not_validated' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, b.row_version);
  v_reason := authz.settings_change_reason(p_reason);
  -- Accounts phase 3 (20261205000530): rate sheets need the rate contracts switch.
  if b.kind = 'rate_sheet' then
    perform authz.rc_require_on();
  end if;

  -- Writers of the target table wait for this apply; readers do not.
  if b.kind = 'hotel' then
    lock table public.hotel_catalogue in share row exclusive mode;
  elsif b.kind = 'supplier' then
    lock table public.suppliers in share row exclusive mode;
  -- Accounts phase 3 (20261205000530): room types are matched by name; their writers wait.
  elsif b.kind = 'rate_sheet' then
    lock table public.hotel_room_types in share row exclusive mode;
  else
    lock table public.customer_parties in share row exclusive mode;
  end if;
  v_summary := authz.vn_import_evaluate(b);
  -- Echo-A L3: the screen posts the row version (and optionally the
  -- proposal hash) of the summary it showed; the re-run must give the same
  -- rows, outcomes, targets and target versions.
  if (p_proposal_hash is not null and p_proposal_hash is distinct from b.summary ->> 'proposalHash')
     or v_summary ->> 'proposalHash' is distinct from b.summary ->> 'proposalHash' then
    raise exception 'import_stale' using errcode = '40001';
  end if;

  if b.kind = 'supplier' then
    -- Accounts phase 2 (20261204000140, L7): bank numbers come from the same file sent
    -- again (its sha256 must be the staged file's); rows that need one without it are refused.
    if p_bank is not null and (jsonb_typeof(p_bank) <> 'object' or p_bank ->> 'fileSha256' is distinct from b.source_sha256
                               or jsonb_typeof(coalesce(p_bank -> 'accounts', '{}'::jsonb)) <> 'object') then
      raise exception 'invalid_input' using errcode = '22023', hint = 'file';
    end if;
    v_counts := authz.vn_import_apply_supplier(b, coalesce(p_bank -> 'accounts', '{}'::jsonb));
    v_created := (v_counts ->> 'created')::integer;
    v_updated := (v_counts ->> 'updated')::integer;
  -- Accounts phase 3 (20261205000530): draft contracts, lines, blackouts and new room types.
  elsif b.kind = 'rate_sheet' then
    v_rs := authz.vn_import_apply_rate_sheet(b);
    v_created := (v_rs ->> 'created')::integer;
  else
  for r in select * from public.import_rows x where x.batch_id = b.id and x.outcome in ('create', 'update') order by x.row_no loop
    if b.kind = 'hotel' then
      v_v := authz.vn_hotel_check(r.data - 'verification') -> 'values';
      if r.outcome = 'create' then
        insert into public.hotel_catalogue (legal_entity_id, name, city, area, address, star_category, source_ref, status,
          import_batch_id, created_by, updated_by)
        values (b.legal_entity_id, v_v ->> 'name', v_v ->> 'city', v_v ->> 'area', v_v ->> 'address',
          v_v ->> 'starCategory', v_v ->> 'sourceRef', v_v ->> 'status', b.id, (select auth.uid()), (select auth.uid()))
        returning id into v_id;
        v_created := v_created + 1;
        update public.import_rows x set target_id = v_id where x.batch_id = r.batch_id and x.row_no = r.row_no;
      else
        select * into v_hotel from public.hotel_catalogue h where h.id = r.target_id for update;
        -- Columns missing from the file keep the stored value.
        v_v := authz.vn_hotel_fields(v_hotel) || (authz.vn_import_present(v_v, r.data) - 'sourceRef');
        update public.hotel_catalogue h
        set name = v_v ->> 'name', city = v_v ->> 'city', area = v_v ->> 'area', address = v_v ->> 'address',
            star_category = v_v ->> 'starCategory', status = v_v ->> 'status', import_batch_id = b.id,
            row_version = h.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
        where h.id = v_hotel.id and h.verification <> 'checked';
        v_updated := v_updated + 1;
        update public.import_rows x
        set before = jsonb_build_object('name', v_hotel.name, 'city', v_hotel.city, 'area', v_hotel.area,
              'address', v_hotel.address, 'starCategory', v_hotel.star_category, 'status', v_hotel.status)
        where x.batch_id = r.batch_id and x.row_no = r.row_no;
      end if;
    else
      v_v := authz.vn_party_check(r.data, false) -> 'values';
      if r.outcome = 'create' then
        insert into public.customer_parties (legal_entity_id, branch_id, party_type, name, contact_person, phone, email,
          address_line1, address_line2, city, state_code, postal_code, gst_status, gstin, gst_reason, source_ref,
          import_batch_id, created_by, updated_by)
        values (b.legal_entity_id, b.branch_id, v_v ->> 'partyType', v_v ->> 'name', v_v ->> 'contactPerson',
          v_v ->> 'phone', v_v ->> 'email', v_v ->> 'addressLine1', v_v ->> 'addressLine2', v_v ->> 'city',
          v_v ->> 'stateCode', v_v ->> 'postalCode', v_v ->> 'gstStatus', v_v ->> 'gstin', v_v ->> 'gstReason',
          v_v ->> 'sourceRef', b.id, (select auth.uid()), (select auth.uid()))
        returning id into v_id;
        v_created := v_created + 1;
        update public.import_rows x set target_id = v_id where x.batch_id = r.batch_id and x.row_no = r.row_no;
      else
        select * into v_party from public.customer_parties p where p.id = r.target_id for update;
        -- Columns missing from the file keep the stored value.
        v_v := authz.vn_party_fields(v_party) || (authz.vn_import_present(v_v, r.data) - 'sourceRef');
        update public.customer_parties p
        set party_type = v_v ->> 'partyType', name = v_v ->> 'name', contact_person = v_v ->> 'contactPerson',
            phone = v_v ->> 'phone', email = v_v ->> 'email', address_line1 = v_v ->> 'addressLine1',
            address_line2 = v_v ->> 'addressLine2', city = v_v ->> 'city', state_code = v_v ->> 'stateCode',
            postal_code = v_v ->> 'postalCode', gst_status = v_v ->> 'gstStatus', gstin = v_v ->> 'gstin',
            gst_reason = v_v ->> 'gstReason',
            -- Never checked by an import; a returned party goes back to not_checked.
            check_status = 'not_checked', check_reason = null, checked_by = null, checked_at = null,
            import_batch_id = b.id, row_version = p.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
        where p.id = v_party.id and p.check_status <> 'checked';
        v_updated := v_updated + 1;
        update public.import_rows x set before = authz.vn_party_fields(v_party)
        where x.batch_id = r.batch_id and x.row_no = r.row_no;
      end if;
    end if;
  end loop;
  end if;

  v_result := jsonb_build_object('batchId', b.id, 'status', 'applied', 'created', v_created, 'updated', v_updated,
    'unchanged', (v_summary -> 'proposed' -> 'unchanged')::integer,
    'skippedChecked', (v_summary -> 'proposed' -> 'skippedChecked')::integer,
    'invalid', (v_summary ->> 'invalid')::integer + (v_summary ->> 'duplicatesInFile')::integer);
  if b.kind = 'rate_sheet' then
    -- Accounts phase 3 (20261205000530): counts only; the staged cells are kept (no personal data).
    v_result := v_result || jsonb_build_object('lines', (v_rs ->> 'lines')::integer, 'roomTypes', (v_rs ->> 'roomTypes')::integer);
  elsif b.kind = 'supplier' then
    -- Accounts phase 2 (LD21): staged account numbers become XXXX<last4>.
    perform authz.vn_supplier_mask_rows(b.id);
  else
    -- Echo-A L4: the staged cells (personal data for customers) are blanked;
    -- source reference, outcome, reasons, target and previous values stay.
    update public.import_rows x set data = '{}'::jsonb where x.batch_id = b.id;
  end if;
  update public.import_batches x
  set status = 'applied', summary = v_summary, apply_result = v_result, apply_reason = v_reason,
      applied_by = (select auth.uid()), applied_at = now(), row_version = x.row_version + 1, updated_at = now()
  where x.id = b.id;
  perform authz.write_audit('import.applied', b.legal_entity_id, b.branch_id, 'import_batch', b.id, v_reason,
    jsonb_build_object('kind', b.kind) || (v_result - 'batchId' - 'status'));
  return v_result;
end;
$$;

create or replace function public.import_batch_get(p_batch_id uuid, p_limit integer default 100, p_offset integer default 0)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  b public.import_batches%rowtype;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 5000);
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into b from public.import_batches x where x.id = p_batch_id;
  if b.id is null or not authz.vn_import_role(b.legal_entity_id, b.kind) then
    return null;
  end if;
  if b.kind = 'supplier' then
    -- Accounts phase 2 (13.3): values (PAN and account number always masked)
    -- and the warnings with the supplier they point at.
    return jsonb_build_object('batch', authz.vn_import_batch_json(b),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object('rowNo', y.row_no, 'sourceRef', y.source_ref,
            'name', case when jsonb_typeof(y.data -> 'name') = 'string' then left(y.data ->> 'name', 200) end,
            'outcome', y.outcome, 'reasons', to_jsonb(y.reasons), 'targetId', y.target_id,
            -- 13.3: warnings as objects ({code, supplierId, supplierName}; hotelSourceRef for hotel_not_found).
            'warnings', coalesce((
              select jsonb_agg(jsonb_build_object('code', split_part(w, ':', 1),
                  'supplierId', case when w !~ '^hotel_not_found:' then (select s.id from public.suppliers s
                                     where s.id::text = substr(w, strpos(w, ':') + 1) and s.legal_entity_id = b.legal_entity_id) end,
                  'supplierName', case when w !~ '^hotel_not_found:' then (select s.name from public.suppliers s
                                     where s.id::text = substr(w, strpos(w, ':') + 1) and s.legal_entity_id = b.legal_entity_id) end,
                  'hotelSourceRef', case when w ~ '^hotel_not_found:' then substr(w, strpos(w, ':') + 1) end) order by w)
              from unnest(y.warnings) w), '[]'::jsonb),
            'warningCodes', to_jsonb(y.warnings),
            'values', jsonb_build_object(
              'name', y.data ->> 'name', 'supplierKind', y.data ->> 'supplierKind',
              'serviceTypes', case when jsonb_typeof(y.data -> 'serviceTypes') = 'string' then to_jsonb(array(
                select lower(btrim(e)) from regexp_split_to_table(y.data ->> 'serviceTypes', '[;,]') e where btrim(e) <> '')) end,
              'city', y.data ->> 'city', 'stateCode', coalesce(authz.gst_state_code(y.data ->> 'stateCode'), y.data ->> 'stateCode'),
              'gstin', y.data ->> 'gstin',
              'panMasked', authz.acct_mask_pan(upper(regexp_replace(coalesce(y.data ->> 'pan', ''), '\s', '', 'g'))),
              'tallyLedgerName', y.data ->> 'tallyLedgerName', 'sourceRef', y.data ->> 'sourceRef',
              'contactName', y.data ->> 'contactName', 'contactPhone', y.data ->> 'contactPhone',
              'contactEmail', y.data ->> 'contactEmail',
              'hotelSourceRefs', case when jsonb_typeof(y.data -> 'hotelSourceRefs') = 'string' then to_jsonb(array(
                select btrim(e) from regexp_split_to_table(y.data ->> 'hotelSourceRefs', ';') e where btrim(e) <> '')) end,
              'bank', case when jsonb_typeof(y.data -> 'accountNumber') = 'string' and btrim(y.data ->> 'accountNumber') <> ''
                then jsonb_build_object('holder', y.data ->> 'bankAccountHolder', 'bankName', y.data ->> 'bankName',
                  'ifsc', upper(y.data ->> 'ifsc'),
                  'accountLast4', right(regexp_replace(y.data ->> 'accountNumber', '[^0-9]', '', 'g'), 4)) end))
          order by y.row_no)
        from (select * from public.import_rows x where x.batch_id = b.id order by x.row_no limit v_limit offset v_offset) y),
        '[]'::jsonb),
      'hasMore', b.row_count > v_offset + v_limit);
  end if;
  if b.kind = 'rate_sheet' then
    -- Accounts phase 3 (20261205000530): rate-sheet rows with their values (warnings as codes).
    return jsonb_build_object('batch', authz.vn_import_batch_json(b),
      'rows', coalesce((
        select jsonb_agg(jsonb_build_object('rowNo', y.row_no, 'outcome', y.outcome, 'reasons', to_jsonb(y.reasons),
            'warnings', to_jsonb(y.warnings), 'targetId', y.target_id,
            'values', jsonb_build_object(
              'supplierRef', left(authz.rc_sheet_cell(y.data, 'supplierRef'), 200),
              'hotelRef', left(authz.rc_sheet_cell(y.data, 'hotelRef'), 200),
              'city', left(authz.rc_sheet_cell(y.data, 'city'), 120),
              'validFrom', left(authz.rc_sheet_cell(y.data, 'validFrom'), 40),
              'validTo', left(authz.rc_sheet_cell(y.data, 'validTo'), 40),
              'seasonFrom', left(authz.rc_sheet_cell(y.data, 'seasonFrom'), 40),
              'seasonTo', left(authz.rc_sheet_cell(y.data, 'seasonTo'), 40),
              'roomType', left(authz.rc_sheet_cell(y.data, 'roomType'), 120),
              'mealPlan', left(authz.rc_sheet_cell(y.data, 'mealPlan'), 60),
              'rate', left(authz.rc_sheet_cell(y.data, 'rate'), 40),
              'weekendRate', left(authz.rc_sheet_cell(y.data, 'weekendRate'), 40),
              'extraAdult', left(authz.rc_sheet_cell(y.data, 'extraAdult'), 40),
              'childWithBed', left(authz.rc_sheet_cell(y.data, 'childWithBed'), 40),
              'childWithoutBed', left(authz.rc_sheet_cell(y.data, 'childWithoutBed'), 40),
              'blackoutDates', left(authz.rc_sheet_cell(y.data, 'blackoutDates'), 300)))
          order by y.row_no)
        from (select * from public.import_rows x where x.batch_id = b.id order by x.row_no limit v_limit offset v_offset) y),
        '[]'::jsonb),
      'hasMore', b.row_count > v_offset + v_limit);
  end if;
  return jsonb_build_object('batch', authz.vn_import_batch_json(b),
    'rows', coalesce((
      select jsonb_agg(jsonb_build_object('rowNo', y.row_no, 'sourceRef', y.source_ref,
          'name', case when jsonb_typeof(y.data -> 'name') = 'string' then left(y.data ->> 'name', 200) end,
          'outcome', y.outcome, 'reasons', to_jsonb(y.reasons), 'warnings', to_jsonb(y.warnings), 'targetId', y.target_id)
        order by y.row_no)
      from (select * from public.import_rows x where x.batch_id = b.id order by x.row_no limit v_limit offset v_offset) y),
      '[]'::jsonb),
    'hasMore', b.row_count > v_offset + v_limit);
end;
$$;

create or replace function public.import_batch_list(p_kind text, p_limit integer default 20) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_entities uuid[];
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Accounts phase 2 (20261204000120): 'supplier'.
  -- Accounts phase 3 (20261205000530): 'rate_sheet'.
  if p_kind is null or p_kind not in ('hotel', 'customer', 'supplier', 'rate_sheet') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  select coalesce(array_agg(e), '{}') into v_entities
  from unnest(authz.vn_member_entities()) e where authz.vn_import_role(e, p_kind);
  if cardinality(v_entities) = 0 then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return jsonb_build_object('items', coalesce((
    select jsonb_agg(jsonb_build_object('batchId', y.id, 'kind', y.kind, 'fileName', y.source_file_name,
        'status', y.status, 'rows', y.row_count, 'createdAt', y.created_at,
        'uploadedByName', (select s.display_name from public.staff_profiles s where s.user_id = y.uploaded_by),
        'appliedAt', y.applied_at,
        -- Counts of an applied batch (null before apply).
        'created', (y.apply_result ->> 'created')::integer, 'updated', (y.apply_result ->> 'updated')::integer,
        'invalid', (y.apply_result ->> 'invalid')::integer) order by y.created_at desc, y.id)
    from (select * from public.import_batches x
          where x.legal_entity_id = any (v_entities) and x.kind = p_kind
          order by x.created_at desc, x.id limit least(greatest(coalesce(p_limit, 20), 1), 100)) y), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- 6. Privileges (grants on the replaced public commands are kept)
-- ===========================================================================

revoke all on function authz.rc_sheet_cell(jsonb, text), authz.rc_sheet_rows(public.import_batches),
  authz.vn_import_evaluate_rate_sheet(public.import_batches), authz.vn_import_apply_rate_sheet(public.import_batches)
from public, anon, authenticated, service_role;

commit;
