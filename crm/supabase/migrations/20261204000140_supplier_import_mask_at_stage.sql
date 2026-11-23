-- Accounts phase 2, Track A (5): fix-forward after the independent backend
-- review (review 8; contract Addendum L7): imported bank account numbers are
-- masked AT STAGING. Full numbers are never stored in import_rows.
--
-- Before (20261204000120): staged supplier rows kept the full account number
-- until apply or cancel, so an abandoned staged or validated batch kept it.
-- Now (lead review of this fix: no stored hash either, since the last 4 digits
-- and a known salt make a short account number easy to guess):
--   * import_batch_stage (replaces 20261204000120): a supplier row's
--     accountNumber is stored as XXXX<last4> only (IFSC, holder and bank name
--     as typed); a number that is not 6-18 digits is stored as 'invalid' so the
--     dry run says account_invalid. No hash, nothing else of the number.
--   * authz.vn_supplier_check (replaces 0120): accepts only XXXX<last4>.
--   * authz.vn_import_evaluate_supplier (replaces 0120): only the last 4
--     digits are known before Import, so a row of an unverified supplier with
--     bank details is never 'unchanged' (outcome update); Import compares the
--     full re-sent number exactly with the latest revision, so a changed
--     middle digit always makes a new unverified revision (payment hold).
--   * Apply needs the full numbers: Import sends the SAME file again.
--     public.import_batch_apply gains p_bank jsonb default null =
--     {fileSha256, accounts: {"<rowNo>": "<account number>"}}. The file hash
--     must equal the staged file's hash; every applied row with bank details
--     needs its number, with the staged last 4 digits; the exact comparison
--     with the latest revision happens here (a new UNVERIFIED revision only
--     when the number or another bank value differs). Anything missing or
--     different is refused invalid_input hint 'file' (nothing is applied).
--     The numbers exist only in the apply call's own transaction and land
--     only in supplier_beneficiary_revisions. The 4-argument
--     import_batch_apply is dropped and recreated with the extra defaulted
--     argument (4-argument callers keep working; batches without bank columns
--     import exactly as before).
--   * authz.vn_import_apply_supplier(batch) -> (batch, accounts jsonb).
--   * Data: staged or validated supplier batches made before this migration
--     are masked now (their numbers will be asked for again at Import).
--
-- Refusal tokens: unchanged (22023 invalid_input, hint 'file' = send the
-- checked file again with Import).
-- Rollback (forward-only): a new migration restoring the 0120 bodies; staged
-- numbers masked here cannot be restored (by design).

begin;
set local lock_timeout = '15s';

-- A staged supplier row's account number: XXXX<last4>, or 'invalid' when not 6-18 digits. Nothing else of it is kept.
create function authz.vn_supplier_stage_account(p_row jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select (p_row - 'accountNumberHash')
    || jsonb_build_object('accountNumber', case when d.digits ~ '^[0-9]{6,18}$' then 'XXXX' || right(d.digits, 4) else 'invalid' end)
  from (select regexp_replace(p_row ->> 'accountNumber', '[\s-]', '', 'g') as digits) d
$$;

create or replace function authz.vn_supplier_check(p_data jsonb) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_r text[] := '{}'::text[];
  v_vals jsonb := '{}'::jsonb;
  v_t record;
  v_types text[];
  v_refs text[];
  v_gstin text;
  v_pan text;
  v_state text;
  v_bank_n integer := 0;
  k text;
begin
  if p_data is null or jsonb_typeof(p_data) <> 'object' then
    return jsonb_build_object('reasons', jsonb_build_array('not_text'), 'values', '{}'::jsonb);
  end if;
  for k in select jsonb_object_keys(p_data) loop
    if k not in ('sourceRef', 'name', 'supplierKind', 'serviceTypes', 'city', 'stateCode', 'gstin', 'pan', 'address',
                 'tallyLedgerName', 'contactName', 'contactPhone', 'contactEmail', 'paymentTerms', 'hotelSourceRefs',
                 'bankAccountHolder', 'bankName', 'ifsc', 'accountNumber') then
      v_r := v_r || 'unknown_column'::text;
    end if;
  end loop;
  if cardinality(authz.vn_formula_keys(p_data)) > 0 then
    v_r := v_r || 'formula_cell'::text;
  end if;

  select * into v_t from authz.vn_text(p_data -> 'sourceRef', 80);
  if not v_t.ok or v_t.value is null or v_t.value !~ '^[A-Za-z0-9._:/-]{1,80}$' then
    v_r := v_r || 'source_ref_invalid'::text;
  else
    v_vals := v_vals || jsonb_build_object('sourceRef', v_t.value);
  end if;
  if p_data ? 'name' then
    select * into v_t from authz.vn_text(p_data -> 'name', 200);
    if not v_t.ok then v_r := v_r || 'name_too_long'::text;
    elsif v_t.value is null then v_r := v_r || 'name_required'::text;
    else v_vals := v_vals || jsonb_build_object('name', v_t.value); end if;
  else
    v_r := v_r || 'name_required'::text;
  end if;
  if p_data ? 'supplierKind' then
    select * into v_t from authz.vn_text(p_data -> 'supplierKind', 20);
    if not v_t.ok or (v_t.value is not null and lower(v_t.value) not in ('direct', 'channel')) then
      v_r := v_r || 'kind_invalid'::text;
    else
      v_vals := v_vals || jsonb_build_object('supplierKind', coalesce(lower(v_t.value), 'direct'));
    end if;
  end if;
  if p_data ? 'serviceTypes' then
    select * into v_t from authz.vn_text(p_data -> 'serviceTypes', 100);
    if v_t.ok and v_t.value is not null then
      select array_agg(distinct x order by x) into v_types
      from (select lower(btrim(e)) as x from regexp_split_to_table(v_t.value, '[;,]') e) y where x <> '';
    end if;
    if not v_t.ok or v_types is null or cardinality(v_types) not between 1 and 4
       or not v_types <@ array['hotel', 'transfer', 'activity', 'flight'] then
      v_r := v_r || 'service_types_invalid'::text;
    else
      v_vals := v_vals || jsonb_build_object('serviceTypes', to_jsonb(v_types));
    end if;
  end if;
  if p_data ? 'city' then
    select * into v_t from authz.vn_text(p_data -> 'city', 120);
    if not v_t.ok then v_r := v_r || 'city_too_long'::text;
    else v_vals := v_vals || jsonb_build_object('city', v_t.value); end if;
  end if;
  if p_data ? 'stateCode' then
    -- A GST state code or a state name (contract 5.6).
    select * into v_t from authz.vn_text(p_data -> 'stateCode', 60);
    v_state := authz.gst_state_code(v_t.value);
    if not v_t.ok or (v_t.value is not null and (v_state is null or v_state !~ '^(0[1-9]|[12][0-9]|3[0-8]|97)$')) then
      v_r := v_r || 'state_invalid'::text;
      v_state := null;
    else
      v_vals := v_vals || jsonb_build_object('stateCode', v_state);
    end if;
  end if;
  if p_data ? 'gstin' then
    select * into v_t from authz.vn_text(p_data -> 'gstin', 30);
    v_gstin := upper(regexp_replace(coalesce(v_t.value, ''), '\s', '', 'g'));
    if not v_t.ok or (v_gstin <> '' and v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$') then
      v_r := v_r || 'gstin_invalid'::text;
      v_gstin := null;
    else
      v_gstin := nullif(v_gstin, '');
      v_vals := v_vals || jsonb_build_object('gstin', v_gstin);
    end if;
  end if;
  if p_data ? 'pan' then
    select * into v_t from authz.vn_text(p_data -> 'pan', 20);
    v_pan := upper(regexp_replace(coalesce(v_t.value, ''), '\s', '', 'g'));
    if not v_t.ok or (v_pan <> '' and v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$') then
      v_r := v_r || 'pan_invalid'::text;
      v_pan := null;
    else
      v_pan := nullif(v_pan, '');
      v_vals := v_vals || jsonb_build_object('pan', v_pan);
    end if;
  end if;
  if v_gstin is not null and v_pan is not null and substr(v_gstin, 3, 10) <> v_pan then
    v_r := v_r || 'gstin_pan_mismatch'::text;
  end if;
  if v_gstin is not null and v_state is not null and left(v_gstin, 2) <> v_state then
    v_r := v_r || 'gstin_state_mismatch'::text;
  end if;
  if p_data ? 'address' then
    select * into v_t from authz.vn_text(p_data -> 'address', 300);
    if not v_t.ok then v_r := v_r || 'address_too_long'::text;
    else v_vals := v_vals || jsonb_build_object('address', v_t.value); end if;
  end if;
  if p_data ? 'tallyLedgerName' then
    select * into v_t from authz.vn_text(p_data -> 'tallyLedgerName', 100);
    if not v_t.ok then v_r := v_r || 'tally_ledger_invalid'::text;
    else v_vals := v_vals || jsonb_build_object('tallyLedgerName', v_t.value); end if;
  end if;
  if p_data ? 'paymentTerms' then
    select * into v_t from authz.vn_text(p_data -> 'paymentTerms', 1000);
    if not v_t.ok then v_r := v_r || 'payment_terms_invalid'::text;
    else v_vals := v_vals || jsonb_build_object('paymentTerms', v_t.value); end if;
  end if;
  if p_data ? 'contactName' then
    select * into v_t from authz.vn_text(p_data -> 'contactName', 120);
    if not v_t.ok then v_r := v_r || 'contact_invalid'::text;
    else v_vals := v_vals || jsonb_build_object('contactName', v_t.value); end if;
  end if;
  if p_data ? 'contactPhone' then
    select * into v_t from authz.vn_text(p_data -> 'contactPhone', 40);
    if not v_t.ok or (v_t.value is not null and v_t.value !~ '^[0-9+() -]{6,40}$') then
      v_r := v_r || 'contact_invalid'::text;
    else v_vals := v_vals || jsonb_build_object('contactPhone', v_t.value); end if;
  end if;
  if p_data ? 'contactEmail' then
    select * into v_t from authz.vn_text(p_data -> 'contactEmail', 254);
    if not v_t.ok or (v_t.value is not null and lower(v_t.value) !~ '^[^@[:space:]]{1,64}@[^@[:space:]]+\.[^@[:space:]]{2,}$') then
      v_r := v_r || 'contact_invalid'::text;
    else v_vals := v_vals || jsonb_build_object('contactEmail', lower(v_t.value)); end if;
  end if;
  if p_data ? 'hotelSourceRefs' then
    select * into v_t from authz.vn_text(p_data -> 'hotelSourceRefs', 1000);
    if v_t.ok and v_t.value is not null then
      select array_agg(distinct x order by x) into v_refs
      from (select btrim(e) as x from regexp_split_to_table(v_t.value, ';') e) y where x <> '';
    end if;
    if not v_t.ok or (v_refs is not null and (cardinality(v_refs) > 50
         or exists (select 1 from unnest(v_refs) x where x !~ '^[A-Za-z0-9._:/-]{1,80}$'))) then
      v_r := v_r || 'hotel_refs_invalid'::text;
    else
      v_vals := v_vals || jsonb_build_object('hotelSourceRefs', to_jsonb(coalesce(v_refs, '{}'::text[])));
    end if;
  end if;
  -- Bank details travel together (all four or none).
  select * into v_t from authz.vn_text(p_data -> 'bankAccountHolder', 120);
  if not v_t.ok then v_r := v_r || 'bank_incomplete'::text;
  elsif v_t.value is not null then v_bank_n := v_bank_n + 1; v_vals := v_vals || jsonb_build_object('bankAccountHolder', v_t.value); end if;
  select * into v_t from authz.vn_text(p_data -> 'bankName', 120);
  if not v_t.ok then v_r := v_r || 'bank_incomplete'::text;
  elsif v_t.value is not null then v_bank_n := v_bank_n + 1; v_vals := v_vals || jsonb_build_object('bankName', v_t.value); end if;
  select * into v_t from authz.vn_text(p_data -> 'ifsc', 20);
  if not v_t.ok or (v_t.value is not null and upper(v_t.value) !~ '^[A-Z]{4}0[A-Z0-9]{6}$') then
    v_r := v_r || 'ifsc_invalid'::text;
  elsif v_t.value is not null then v_bank_n := v_bank_n + 1; v_vals := v_vals || jsonb_build_object('ifsc', upper(v_t.value)); end if;
  -- Accounts phase 2 (20261204000140, L7): staged rows hold only XXXX<last4>
  -- ('invalid' when the typed number was not 6-18 digits).
  select * into v_t from authz.vn_text(p_data -> 'accountNumber', 30);
  if not v_t.ok or (v_t.value is not null and v_t.value !~ '^XXXX[0-9]{4}$') then
    v_r := v_r || 'account_invalid'::text;
  elsif v_t.value is not null then
    v_bank_n := v_bank_n + 1;
    v_vals := v_vals || jsonb_build_object('accountNumber', v_t.value);
  end if;
  if v_bank_n not in (0, 4) and not (v_r && array['ifsc_invalid', 'account_invalid', 'bank_incomplete']) then
    v_r := v_r || 'bank_incomplete'::text;
  end if;
  if v_bank_n <> 4 then
    v_vals := v_vals - array['bankAccountHolder', 'bankName', 'ifsc', 'accountNumber'];
  end if;
  return jsonb_build_object('reasons', to_jsonb(array(select distinct x from unnest(v_r) x order by x)), 'values', v_vals);
end;
$$;

create or replace function authz.vn_import_evaluate_supplier(p_batch public.import_batches) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.import_rows%rowtype;
  v_chk jsonb;
  v_vals jsonb;
  v_reasons text[];
  v_warn text[];
  v_ref text;
  v_outcome text;
  v_s public.suppliers%rowtype;
  v_refs jsonb := '{}'::jsonb;
  v_names jsonb := '{}'::jsonb;
  v_key text;
  v_stored jsonb;
  v_present jsonb;
  v_merged jsonb;
  v_bank record;
  v_new_links integer;
  v_bank_new boolean;
  v_proposal jsonb := '[]'::jsonb;
  v_dups jsonb;
  d jsonb;
begin
  -- Pass 1: source references and exact names in the file.
  for r in select * from public.import_rows x where x.batch_id = p_batch.id order by x.row_no loop
    v_ref := nullif(btrim(coalesce(case when jsonb_typeof(r.data -> 'sourceRef') = 'string' then r.data ->> 'sourceRef' end, '')), '');
    if v_ref is not null then
      v_refs := jsonb_set(v_refs, array[v_ref], to_jsonb(coalesce((v_refs ->> v_ref)::integer, 0) + 1));
    end if;
    v_key := lower(btrim(coalesce(case when jsonb_typeof(r.data -> 'name') = 'string' then r.data ->> 'name' end, '')));
    if v_key <> '' then
      v_names := jsonb_set(v_names, array[v_key], to_jsonb(coalesce((v_names ->> v_key)::integer, 0) + 1));
    end if;
  end loop;

  -- Pass 2: each row.
  for r in select * from public.import_rows x where x.batch_id = p_batch.id order by x.row_no loop
    v_reasons := '{}';
    v_warn := '{}';
    v_outcome := null;
    v_s := null;
    if exists (select 1 from jsonb_each(r.data) e where jsonb_typeof(e.value) not in ('string', 'null')) then
      v_reasons := v_reasons || 'not_text'::text;
    end if;
    v_chk := authz.vn_supplier_check(r.data);
    v_reasons := v_reasons || array(select jsonb_array_elements_text(v_chk -> 'reasons'));
    v_vals := v_chk -> 'values';
    v_ref := v_vals ->> 'sourceRef';

    if cardinality(v_reasons) = 0 and v_ref is not null and coalesce((v_refs ->> v_ref)::integer, 0) > 1 then
      v_outcome := 'duplicate_in_file';
      v_reasons := array['duplicate_in_file'];
    elsif cardinality(v_reasons) = 0 then
      select * into v_s from public.suppliers s
      where s.legal_entity_id = p_batch.legal_entity_id and s.source_ref = v_ref;
      if v_s.id is null then
        if not (v_vals ? 'serviceTypes') then
          v_reasons := v_reasons || 'service_types_invalid'::text;
        end if;
        if exists (select 1 from public.suppliers s
                   where s.legal_entity_id = p_batch.legal_entity_id and lower(s.name) = lower(v_vals ->> 'name'))
           or coalesce((v_names ->> lower(v_vals ->> 'name'))::integer, 0) > 1 then
          v_reasons := v_reasons || 'name_exists'::text;
        end if;
        v_outcome := case when cardinality(v_reasons) > 0 then 'invalid' else 'create' end;
      elsif v_s.verification_status = 'verified' then
        v_outcome := 'skipped_checked';
      else
        v_stored := authz.vn_supplier_fields(v_s);
        v_present := v_vals - array['sourceRef', 'hotelSourceRefs', 'bankAccountHolder', 'bankName', 'ifsc', 'accountNumber'];
        v_merged := v_stored || v_present;
        if lower(v_merged ->> 'name') <> lower(v_s.name) and exists (
             select 1 from public.suppliers s
             where s.legal_entity_id = p_batch.legal_entity_id and lower(s.name) = lower(v_merged ->> 'name') and s.id <> v_s.id) then
          v_reasons := v_reasons || 'name_exists'::text;
        end if;
        if (v_merged ->> 'gstin') is not null and (v_merged ->> 'pan') is not null
           and substr(v_merged ->> 'gstin', 3, 10) <> v_merged ->> 'pan' then
          v_reasons := v_reasons || 'gstin_pan_mismatch'::text;
        end if;
        if (v_merged ->> 'gstin') is not null and (v_merged ->> 'stateCode') is not null
           and left(v_merged ->> 'gstin', 2) <> v_merged ->> 'stateCode' then
          v_reasons := v_reasons || 'gstin_state_mismatch'::text;
        end if;
        select count(*) into v_new_links
        from public.hotel_catalogue h
        where h.legal_entity_id = p_batch.legal_entity_id and h.status = 'active'
          and h.source_ref in (select jsonb_array_elements_text(coalesce(v_vals -> 'hotelSourceRefs', '[]'::jsonb)))
          and not exists (select 1 from public.supplier_hotels l
                          where l.supplier_id = v_s.id and l.hotel_id = h.id and l.status = 'active');
        select * into v_bank from public.supplier_beneficiary_revisions b
        where b.supplier_id = v_s.id order by b.revision_no desc limit 1;
        -- 20261204000140 (L7): only the last 4 digits are known here, so a row with bank
        -- details is never 'unchanged': it goes to Import, which compares the full re-sent
        -- number exactly with the latest revision (a changed middle digit is caught there).
        v_bank_new := v_vals ? 'accountNumber';
        v_outcome := case when cardinality(v_reasons) > 0 then 'invalid'
                          when v_merged = v_stored and v_new_links = 0 and not v_bank_new then 'unchanged'
                          else 'update' end;
      end if;
    else
      v_outcome := 'invalid';
    end if;

    -- Warnings (never block) for rows that would be stored.
    if v_outcome in ('create', 'update', 'unchanged') then
      v_merged := coalesce(case when v_s.id is not null then authz.vn_supplier_fields(v_s) end, '{}'::jsonb)
                  || (v_vals - array['sourceRef', 'hotelSourceRefs']);
      v_dups := authz.supplier_near_duplicates(p_batch.legal_entity_id, v_s.id, v_merged ->> 'name', v_merged ->> 'city',
        v_merged ->> 'gstin', v_merged ->> 'pan', v_vals ->> 'ifsc', right(v_vals ->> 'accountNumber', 4));
      for d in select * from jsonb_array_elements(v_dups) loop
        v_warn := v_warn || array(select x || ':' || (d ->> 'supplierId') from jsonb_array_elements_text(d -> 'reasons') x);
      end loop;
      v_warn := v_warn || array(
        select 'hotel_not_found:' || x from jsonb_array_elements_text(coalesce(v_vals -> 'hotelSourceRefs', '[]'::jsonb)) x
        where not exists (select 1 from public.hotel_catalogue h
                          where h.legal_entity_id = p_batch.legal_entity_id and h.source_ref = x and h.status = 'active'));
    end if;

    v_proposal := v_proposal || jsonb_build_array(jsonb_build_array(r.row_no, v_outcome, v_s.id, v_s.row_version,
      to_jsonb(array(select distinct y from unnest(v_reasons) y order by y))));
    update public.import_rows x
    set source_ref = v_ref, outcome = v_outcome,
        reasons = array(select distinct y from unnest(v_reasons) y order by y),
        warnings = array(select distinct y from unnest(v_warn) y order by y), target_id = v_s.id
    where x.batch_id = r.batch_id and x.row_no = r.row_no;
  end loop;

  return (
    with x as (select * from public.import_rows y where y.batch_id = p_batch.id),
    c as (
      select count(*) as rows,
        count(*) filter (where outcome in ('create', 'update', 'unchanged', 'skipped_checked')) as valid,
        count(*) filter (where outcome = 'invalid') as invalid,
        count(*) filter (where outcome = 'duplicate_in_file') as dup,
        count(*) filter (where outcome = 'create') as creates,
        count(*) filter (where outcome = 'update') as updates,
        count(*) filter (where outcome = 'unchanged') as unchanged,
        count(*) filter (where outcome = 'skipped_checked') as skipped,
        count(*) filter (where exists (select 1 from unnest(warnings) w where w like 'similar\_name\_city:%')) as w_name,
        count(*) filter (where exists (select 1 from unnest(warnings) w where w like 'same\_gstin:%')) as w_gstin,
        count(*) filter (where exists (select 1 from unnest(warnings) w where w like 'same\_pan:%')) as w_pan,
        count(*) filter (where exists (select 1 from unnest(warnings) w where w like 'same\_bank:%')) as w_bank,
        count(*) filter (where exists (select 1 from unnest(warnings) w where w like 'hotel\_not\_found:%')) as w_hotel,
        count(*) filter (where exists (select 1 from unnest(warnings) w where w ~ '^(similar_name_city|same_gstin|same_pan|same_bank):')) as w_any,
        count(*) filter (where outcome in ('create', 'update', 'unchanged')
                           and jsonb_typeof(data -> 'accountNumber') = 'string' and btrim(data ->> 'accountNumber') <> '') as with_bank
      from x)
    select jsonb_build_object(
      'batchId', p_batch.id, 'kind', p_batch.kind,
      'rows', c.rows, 'rowCount', c.rows, 'valid', c.valid, 'invalid', c.invalid,
      'duplicatesInFile', c.dup, 'duplicateInFile', c.dup, 'possibleDuplicates', c.w_any,
      'assumedRows', 0, 'clearRows', 0, 'rowNotes', '[]'::jsonb,
      'create', c.creates, 'update', c.updates, 'unchanged', c.unchanged, 'skippedChecked', c.skipped,
      'proposed', jsonb_build_object('create', c.creates, 'update', c.updates, 'unchanged', c.unchanged,
                                     'skippedChecked', c.skipped),
      'warnings', jsonb_build_object('similarNameCity', c.w_name, 'sameGstin', c.w_gstin, 'samePan', c.w_pan,
                                     'sameBank', c.w_bank, 'hotelNotFound', c.w_hotel),
      'withBankDetails', c.with_bank,
      'proposalHash', encode(sha256(convert_to(v_proposal::text, 'UTF8')), 'hex'),
      'columns', coalesce((
        select jsonb_agg(jsonb_build_object('key', k.k, 'filled', k.filled) order by k.k)
        from (select e.key as k, count(*) filter (where jsonb_typeof(e.value) = 'string' and btrim(e.value #>> '{}') <> '') as filled
              from x, jsonb_each(x.data) e group by e.key) k), '[]'::jsonb),
      'invalidRows', coalesce((
        select jsonb_agg(jsonb_build_object('rowNo', y.row_no, 'reasons', to_jsonb(y.reasons)) order by y.row_no)
        from (select x.row_no, x.reasons from x where x.outcome = 'invalid' order by x.row_no limit 200) y), '[]'::jsonb),
      'duplicateRows', coalesce((
        select jsonb_agg(jsonb_build_object('rowNo', y.row_no, 'sourceRef', y.source_ref, 'kind', y.kind) order by y.row_no, y.kind)
        from (select x.row_no, x.source_ref,
                     case when x.outcome = 'duplicate_in_file' then 'in_file' else 'same_name' end as kind
              from x
              where x.outcome = 'duplicate_in_file'
                 or exists (select 1 from unnest(x.warnings) w where w like 'similar\_name\_city:%')
              order by x.row_no limit 200) y), '[]'::jsonb))
    from c);
end;
$$;

drop function authz.vn_import_apply_supplier(public.import_batches);
create function authz.vn_import_apply_supplier(p_batch public.import_batches, p_accounts jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.import_rows%rowtype;
  v_v jsonb;
  v_s public.suppliers%rowtype;
  v_old public.suppliers%rowtype;
  v_uid uuid := (select auth.uid());
  v_created integer := 0;
  v_updated integer := 0;
  v_m jsonb;
  v_hotel record;
  v_link uuid;
  v_bank record;
  v_no integer;
  v_contact boolean;
  v_number text;  -- 20261204000140: the full number, from the re-sent file only
begin
  perform set_config('tripnavigate.supplier_change_source', 'import', true);
  -- 13.1: supplier rows by id order.
  perform 1 from public.suppliers s
  where s.id in (select x.target_id from public.import_rows x where x.batch_id = p_batch.id and x.outcome = 'update')
  order by s.id for update;

  for r in select * from public.import_rows x where x.batch_id = p_batch.id and x.outcome in ('create', 'update') order by x.row_no loop
    v_v := authz.vn_supplier_check(r.data) -> 'values';
    v_contact := v_v ?| array['contactName', 'contactPhone', 'contactEmail'];
    if r.outcome = 'create' then
      insert into public.suppliers (legal_entity_id, name, service_types, city, contact_name, contact_phone, contact_email,
        payment_terms, supplier_kind, gstin, pan, state_code, address, tally_ledger_name, source_ref, import_batch_id,
        created_by, updated_by)
      values (p_batch.legal_entity_id, v_v ->> 'name', array(select jsonb_array_elements_text(v_v -> 'serviceTypes')),
        v_v ->> 'city', v_v ->> 'contactName', v_v ->> 'contactPhone', v_v ->> 'contactEmail', v_v ->> 'paymentTerms',
        coalesce(v_v ->> 'supplierKind', 'direct'), v_v ->> 'gstin', v_v ->> 'pan', v_v ->> 'stateCode', v_v ->> 'address',
        v_v ->> 'tallyLedgerName', v_v ->> 'sourceRef', p_batch.id, v_uid, v_uid)
      returning * into v_s;
      v_created := v_created + 1;
      update public.import_rows x set target_id = v_s.id where x.batch_id = r.batch_id and x.row_no = r.row_no;
    else
      select * into v_old from public.suppliers s where s.id = r.target_id;
      -- Columns missing from the file keep the stored value.
      v_m := authz.vn_supplier_fields(v_old)
             || (v_v - array['sourceRef', 'hotelSourceRefs', 'bankAccountHolder', 'bankName', 'ifsc', 'accountNumber']);
      -- 20261204000140: a row sent to Import for its bank details only leaves the supplier row as it is.
      if v_m = authz.vn_supplier_fields(v_old) then
        v_s := v_old;
      else
      update public.suppliers s
      set name = v_m ->> 'name', supplier_kind = v_m ->> 'supplierKind',
          service_types = array(select jsonb_array_elements_text(v_m -> 'serviceTypes')),
          city = v_m ->> 'city', state_code = v_m ->> 'stateCode', gstin = v_m ->> 'gstin', pan = v_m ->> 'pan',
          address = v_m ->> 'address', tally_ledger_name = v_m ->> 'tallyLedgerName',
          contact_name = v_m ->> 'contactName', contact_phone = v_m ->> 'contactPhone',
          contact_email = v_m ->> 'contactEmail', payment_terms = v_m ->> 'paymentTerms',
          import_batch_id = p_batch.id, row_version = s.row_version + 1, updated_by = v_uid, updated_at = now()
      where s.id = v_old.id and s.verification_status <> 'verified'
      returning * into v_s;
      end if;
      v_updated := v_updated + 1;
      update public.import_rows x set before = authz.vn_supplier_fields(v_old)
      where x.batch_id = r.batch_id and x.row_no = r.row_no;
    end if;
    -- Contacts: the file's contact is the primary contact.
    if v_contact and (r.outcome = 'create' or (v_old.contact_name, v_old.contact_phone, v_old.contact_email)
                                              is distinct from (v_s.contact_name, v_s.contact_phone, v_s.contact_email)) then
      perform authz.supplier_primary_from_legacy(v_s);
    end if;
    -- Hotel links (active catalogue hotels of the entity; unknown references were warned).
    for v_hotel in
      select h.id, h.name, h.city from public.hotel_catalogue h
      where h.legal_entity_id = p_batch.legal_entity_id and h.status = 'active'
        and h.source_ref in (select jsonb_array_elements_text(coalesce(v_v -> 'hotelSourceRefs', '[]'::jsonb)))
      order by h.id
    loop
      v_link := null;
      insert into public.supplier_hotels (legal_entity_id, supplier_id, hotel_id, source, created_by)
      values (p_batch.legal_entity_id, v_s.id, v_hotel.id, 'import', v_uid)
      on conflict (supplier_id, hotel_id) where status = 'active' do nothing
      returning id into v_link;
      if v_link is not null then
        insert into public.supplier_changes (legal_entity_id, supplier_id, changed_by, source, field, old_value, new_value)
        values (p_batch.legal_entity_id, v_s.id, v_uid, 'import', 'hotel:' || v_hotel.id, null,
          left('linked (import): ' || v_hotel.name || ', ' || v_hotel.city, 1000));
      end if;
    end loop;
    -- Bank details: the full number comes only from the file sent again with Import
    -- (L7), with the staged last 4 digits; a new UNVERIFIED revision only when it or
    -- another bank value differs from the latest revision (exact comparison here).
    if v_v ? 'accountNumber' then
      v_number := regexp_replace(coalesce(p_accounts ->> r.row_no::text, ''), '[\s-]', '', 'g');
      if v_number !~ '^[0-9]{6,18}$' or 'XXXX' || right(v_number, 4) <> v_v ->> 'accountNumber' then
        raise exception 'invalid_input' using errcode = '22023', hint = 'file';
      end if;
      select * into v_bank from public.supplier_beneficiary_revisions b
      where b.supplier_id = v_s.id order by b.revision_no desc limit 1;
      if v_bank.account_number is null
         or (v_bank.account_holder, v_bank.bank_name, v_bank.ifsc, v_bank.account_number)
            is distinct from (v_v ->> 'bankAccountHolder', v_v ->> 'bankName', v_v ->> 'ifsc', v_number) then
        v_no := coalesce(v_bank.revision_no, 0) + 1;
        insert into public.supplier_beneficiary_revisions (supplier_id, legal_entity_id, revision_no, request_id,
          account_holder, bank_name, ifsc, account_number, created_by)
        values (v_s.id, p_batch.legal_entity_id, v_no, gen_random_uuid(), v_v ->> 'bankAccountHolder', v_v ->> 'bankName',
          v_v ->> 'ifsc', v_number, v_uid);
      end if;
    end if;
  end loop;
  perform set_config('tripnavigate.supplier_change_source', '', true);
  return jsonb_build_object('created', v_created, 'updated', v_updated);
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
  if p_kind is null or p_kind not in ('hotel', 'customer', 'supplier') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  if p_legal_entity_id is null or not authz.vn_import_role(p_legal_entity_id, p_kind) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into v_existing from public.import_batches b
  where b.legal_entity_id = p_legal_entity_id and b.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.uploaded_by is distinct from (select auth.uid()) or v_existing.kind <> p_kind
       or v_existing.source_sha256 <> v_sha or v_existing.branch_id is distinct from p_branch_id
       or v_existing.entity_wide <> coalesce(p_entity_wide, false) then
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
  if p_kind in ('hotel', 'supplier') and p_branch_id is not null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'branchId';
  end if;
  -- Echo-A M1: customers need a branch, or the explicit whole-company choice (never both).
  if p_kind = 'customer' and p_branch_id is null and coalesce(p_entity_wide, false) is false then
    raise exception 'invalid_input' using errcode = '22023', hint = 'branchId';
  end if;
  if coalesce(p_entity_wide, false) and (p_kind <> 'customer' or p_branch_id is not null) then
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

drop function public.import_batch_apply(uuid, integer, text, text);
create function public.import_batch_apply(p_batch_id uuid, p_expected_row_version integer, p_reason text,
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

  -- Writers of the target table wait for this apply; readers do not.
  if b.kind = 'hotel' then
    lock table public.hotel_catalogue in share row exclusive mode;
  elsif b.kind = 'supplier' then
    lock table public.suppliers in share row exclusive mode;
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
  if b.kind = 'supplier' then
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

-- Staged or validated supplier batches made before this migration: mask now.
update public.import_rows x
set data = authz.vn_supplier_stage_account(x.data)
from public.import_batches b
where b.id = x.batch_id and b.kind = 'supplier' and b.status in ('staged', 'validated')
  and jsonb_typeof(x.data -> 'accountNumber') = 'string' and (x.data ->> 'accountNumber') !~ '^XXXX[0-9]{0,4}$';

revoke all on function authz.vn_supplier_stage_account(jsonb),
  authz.vn_import_apply_supplier(public.import_batches, jsonb)
from public, anon, authenticated, service_role;
revoke all on function public.import_batch_apply(uuid, integer, text, text, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.import_batch_apply(uuid, integer, text, text, jsonb) to authenticated;

commit;
