-- Accounts phase 2, Track A (3): supplier import (import kind 'supplier').
-- Contract: accounts-phase2-2026-11-11/contract.md sections 5.6, 13.1, 13.3;
-- LD21 (Accounts or Super Admin; bank columns allowed, unverified, masked
-- after apply and cancel); owner Q10 (Tally Sundry Creditors + owner file).
--
-- Rules:
--   * Rows match a stored supplier ONLY by source reference (Tally ledger
--     GUID or the file's row id) — never by name. No match -> create; match
--     unverified -> update (only the columns the file has) or unchanged;
--     match verified -> skipped_checked (never overwritten); invalid values ->
--     invalid (reason codes, 13.3); the same source reference twice ->
--     duplicate_in_file (both rows); a create (or rename) to a name another
--     supplier already has (exact, ignoring case), or the same new name twice
--     in the file -> invalid name_exists.
--   * Warnings never block: similar_name_city:<supplierId>,
--     same_gstin:<id>, same_pan:<id>, same_bank:<id> (IFSC and last 4 of the
--     latest revision), hotel_not_found:<hotel source ref>.
--   * Apply: suppliers with source_ref and import_batch_id, history source
--     'import'; contacts as the primary contact; hotel links (source
--     'import'); bank columns -> a NEW UNVERIFIED bank detail revision
--     (created by the applier) only when they differ from the latest one, so
--     payments stay on hold until a Manager who is not the applier approves
--     (unchanged supplier_approve_beneficiary). Refused (import_stale) when
--     anything changed since the dry run (proposal hash rule, unchanged).
--   * Staged account numbers become XXXX<last4> after apply and after cancel;
--     import_batch_get always masks accountNumber and pan of supplier rows.
--     (Hotel and customer batches keep their rule: cells blanked.)
--
-- Replaced (same signatures; hotel and customer behaviour unchanged):
--   authz.vn_import_role (M/20261128000140:153): supplier -> Accounts of the
--     entity (vn_party_accounts) or Super Admin (can_switch_live_settings).
--   authz.vn_import_evaluate (:182): supplier batches -> authz.vn_import_evaluate_supplier.
--   public.import_batch_stage (:374), import_batch_list (:647): accept 'supplier'
--     (no branch, never entity-wide, like hotels).
--   public.import_batch_apply (:496), import_batch_get (:619),
--   public.import_batch_cancel (:677): the supplier branch above.
-- New: authz.gst_state_code, authz.vn_supplier_check, authz.vn_import_evaluate_supplier,
--   authz.vn_import_apply_supplier, authz.vn_supplier_mask_rows.
--
-- Refusal tokens: unchanged (42501 not_authorized; 22023 invalid_input
-- (hint), import_too_large; 55000 import_not_validated, import_applied,
-- wrong_state; 40001 import_stale, version_changed, request_conflict; P0002
-- not_found). Audit: the existing import.* actions with kind 'supplier'.
-- Lock order (13.1): the batch (vn_import_lock), then the suppliers table
-- (share row exclusive, as the hotel import), then supplier rows by id.
--
-- Rollback (forward-only): a new migration restoring the replaced bodies from
-- 20261128000140 (supplier batches then refuse kind 'supplier').

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Role
-- ===========================================================================

create or replace function authz.vn_import_role(p_entity uuid, p_kind text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case p_kind
    when 'hotel' then coalesce(authz.can_switch_live_settings(p_entity), false)
    when 'customer' then coalesce(authz.vn_party_accounts(p_entity), false)
    -- Accounts phase 2 (20261204000120, LD21).
    when 'supplier' then coalesce(authz.vn_party_accounts(p_entity), false)
                         or coalesce(authz.can_switch_live_settings(p_entity), false)
    else false end
$$;

-- ===========================================================================
-- 2. Row rule
-- ===========================================================================

-- A GST state code from a code ('8' or '08') or a state name (the list of
-- S/views/b11/book-fields.ts GST_STATES, which the import screen also uses); null when unknown.
create function authz.gst_state_code(p_value text) returns text
language sql immutable set search_path = '' as $$
  select case
    when btrim(coalesce(p_value, '')) ~ '^[0-9]$' then '0' || btrim(p_value)
    when btrim(coalesce(p_value, '')) ~ '^[0-9]{2}$' then btrim(p_value)
    else (select x.code from (values
  ('01', 'Jammu and Kashmir'), ('02', 'Himachal Pradesh'), ('03', 'Punjab'), ('04', 'Chandigarh'), ('05', 'Uttarakhand'),
  ('06', 'Haryana'), ('07', 'Delhi'), ('08', 'Rajasthan'), ('09', 'Uttar Pradesh'), ('10', 'Bihar'), ('11', 'Sikkim'),
  ('12', 'Arunachal Pradesh'), ('13', 'Nagaland'), ('14', 'Manipur'), ('15', 'Mizoram'), ('16', 'Tripura'), ('17', 'Meghalaya'),
  ('18', 'Assam'), ('19', 'West Bengal'), ('20', 'Jharkhand'), ('21', 'Odisha'), ('22', 'Chhattisgarh'), ('23', 'Madhya Pradesh'),
  ('24', 'Gujarat'), ('25', 'Daman and Diu (old code)'), ('26', 'Dadra and Nagar Haveli and Daman and Diu'), ('27', 'Maharashtra'),
  ('28', 'Andhra Pradesh (old code)'), ('29', 'Karnataka'), ('30', 'Goa'), ('31', 'Lakshadweep'), ('32', 'Kerala'),
  ('33', 'Tamil Nadu'), ('34', 'Puducherry'), ('35', 'Andaman and Nicobar Islands'), ('36', 'Telangana'), ('37', 'Andhra Pradesh'),
  ('38', 'Ladakh'), ('97', 'Other territory')
      ) as x (code, name) where lower(x.name) = lower(btrim(coalesce(p_value, '')))) end
$$;

-- One supplier row: {reasons: [codes], values: {...cleaned, only the keys the
-- row has}}. serviceTypes and hotelSourceRefs are arrays in values.
create function authz.vn_supplier_check(p_data jsonb) returns jsonb
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
  select * into v_t from authz.vn_text(p_data -> 'accountNumber', 30);
  if not v_t.ok or (v_t.value is not null and regexp_replace(v_t.value, '[\s-]', '', 'g') !~ '^[0-9]{6,18}$') then
    v_r := v_r || 'account_invalid'::text;
  elsif v_t.value is not null then
    v_bank_n := v_bank_n + 1;
    v_vals := v_vals || jsonb_build_object('accountNumber', regexp_replace(v_t.value, '[\s-]', '', 'g'));
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

-- A stored supplier as import values (the columns an import may change).
create function authz.vn_supplier_fields(s public.suppliers) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('name', s.name, 'supplierKind', s.supplier_kind, 'serviceTypes', to_jsonb(s.service_types),
    'city', s.city, 'stateCode', s.state_code, 'gstin', s.gstin, 'pan', s.pan, 'address', s.address,
    'tallyLedgerName', s.tally_ledger_name, 'contactName', s.contact_name, 'contactPhone', s.contact_phone,
    'contactEmail', s.contact_email, 'paymentTerms', s.payment_terms)
$$;

-- ===========================================================================
-- 3. Evaluation (dry run and the re-run inside apply)
-- ===========================================================================

create function authz.vn_import_evaluate_supplier(p_batch public.import_batches) returns jsonb
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
        v_bank_new := v_vals ? 'accountNumber' and (v_bank.account_number is null
          or (v_bank.account_holder, v_bank.bank_name, v_bank.ifsc, v_bank.account_number)
             is distinct from (v_vals ->> 'bankAccountHolder', v_vals ->> 'bankName', v_vals ->> 'ifsc', v_vals ->> 'accountNumber'));
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

-- Hotel and customer evaluation unchanged (20261128000140); suppliers go to
-- their own rule. The body below is the 20261128000140 body with one branch.
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

-- ===========================================================================
-- 4. Apply (supplier rows) and masking
-- ===========================================================================

-- Writes the create/update rows of an evaluated supplier batch. The caller
-- holds the batch lock and the suppliers table lock and has checked the
-- proposal hash. Answers {created, updated}.
create function authz.vn_import_apply_supplier(p_batch public.import_batches) returns jsonb
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
    -- Bank details: a new UNVERIFIED revision when they differ from the latest one.
    if v_v ? 'accountNumber' then
      select * into v_bank from public.supplier_beneficiary_revisions b
      where b.supplier_id = v_s.id order by b.revision_no desc limit 1;
      if v_bank.account_number is null
         or (v_bank.account_holder, v_bank.bank_name, v_bank.ifsc, v_bank.account_number)
            is distinct from (v_v ->> 'bankAccountHolder', v_v ->> 'bankName', v_v ->> 'ifsc', v_v ->> 'accountNumber') then
        v_no := coalesce(v_bank.revision_no, 0) + 1;
        insert into public.supplier_beneficiary_revisions (supplier_id, legal_entity_id, revision_no, request_id,
          account_holder, bank_name, ifsc, account_number, created_by)
        values (v_s.id, p_batch.legal_entity_id, v_no, gen_random_uuid(), v_v ->> 'bankAccountHolder', v_v ->> 'bankName',
          v_v ->> 'ifsc', v_v ->> 'accountNumber', v_uid);
      end if;
    end if;
  end loop;
  perform set_config('tripnavigate.supplier_change_source', '', true);
  return jsonb_build_object('created', v_created, 'updated', v_updated);
end;
$$;

-- Staged supplier cells after apply or cancel: the account number becomes XXXX<last4>.
create function authz.vn_supplier_mask_rows(p_batch uuid) returns void
language sql volatile security definer set search_path = '' as $$
  update public.import_rows x
  set data = jsonb_set(x.data, '{accountNumber}',
    to_jsonb('XXXX' || right(regexp_replace(x.data ->> 'accountNumber', '[^0-9]', '', 'g'), 4)))
  where x.batch_id = p_batch and jsonb_typeof(x.data -> 'accountNumber') = 'string'
    and (x.data ->> 'accountNumber') !~ '^XXXX[0-9]{0,4}$'
$$;

-- ===========================================================================
-- 5. Commands (replace 20261128000140; hotel and customer unchanged)
-- ===========================================================================

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
  select v_id, e.ordinality::integer, p_legal_entity_id, e.value
  from jsonb_array_elements(p_rows) with ordinality e;
  -- Counts and the file hash only (never a file name or a value).
  perform authz.write_audit('import.staged', p_legal_entity_id, p_branch_id, 'import_batch', v_id, null,
    jsonb_build_object('kind', p_kind, 'rows', v_n, 'sha256', v_sha, 'entityWide', p_kind = 'customer' and coalesce(p_entity_wide, false)));
  return jsonb_build_object('batchId', v_id, 'rowCount', v_n, 'outcome', 'created');
end;
$$;

create or replace function public.import_batch_apply(p_batch_id uuid, p_expected_row_version integer, p_reason text,
  p_proposal_hash text default null) returns jsonb
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
    -- Accounts phase 2 (20261204000120).
    v_counts := authz.vn_import_apply_supplier(b);
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
  if p_kind is null or p_kind not in ('hotel', 'customer', 'supplier') then
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

create or replace function public.import_batch_cancel(p_batch_id uuid, p_expected_row_version integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  b public.import_batches%rowtype;
begin
  b := authz.vn_import_lock(p_batch_id);
  if b.status = 'applied' then
    raise exception 'import_applied' using errcode = '55000';
  end if;
  if b.status = 'cancelled' then
    return jsonb_build_object('batchId', b.id, 'status', 'cancelled', 'rowVersion', b.row_version);
  end if;
  perform authz.require_row_version(p_expected_row_version, b.row_version);
  update public.import_batches x set status = 'cancelled', row_version = x.row_version + 1, updated_at = now()
  where x.id = b.id
  returning * into b;
  if b.kind = 'supplier' then
    -- Accounts phase 2 (LD21): staged account numbers become XXXX<last4>.
    perform authz.vn_supplier_mask_rows(b.id);
  else
    -- Echo-A L4: the staged cells are blanked (counts and outcomes stay).
    update public.import_rows x set data = '{}'::jsonb where x.batch_id = b.id;
  end if;
  perform authz.write_audit('import.cancelled', b.legal_entity_id, b.branch_id, 'import_batch', b.id, null,
    jsonb_build_object('kind', b.kind));
  return jsonb_build_object('batchId', b.id, 'status', 'cancelled', 'rowVersion', b.row_version);
end;
$$;

-- ===========================================================================
-- 6. Privileges (grants on the replaced public commands are kept)
-- ===========================================================================

revoke all on function authz.gst_state_code(text), authz.vn_supplier_check(jsonb), authz.vn_supplier_fields(public.suppliers),
  authz.vn_import_evaluate_supplier(public.import_batches), authz.vn_import_apply_supplier(public.import_batches),
  authz.vn_supplier_mask_rows(uuid)
from public, anon, authenticated, service_role;

commit;
