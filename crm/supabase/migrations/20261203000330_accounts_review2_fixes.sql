-- Accounts phase, Track B (14): second independent review of 0300-0320.
--
-- 1. (MED) An edit committed while an export runs could be missed: the
--    touch took no lock the export waits on, a first export had no Tally row
--    to touch, and the touch time could precede the export's now(). Every
--    touch trigger (authz.tally_touch_source, tally_touch_deal,
--    tally_touch_document) now first takes the per-entity Tally lock SHARED
--    (authz.tally_entity_lock, the key the export takes EXCLUSIVE, 0300),
--    whether or not a Tally row exists. A writer therefore waits for a
--    running export and touches after it (clock time >= the export's
--    last_exported_at), or commits first and the export reads its new value.
--    Lock order: the trigger takes the advisory lock before any tally_records
--    row; T1-T3 take it shared too (compatible); the export takes it first
--    and never locks a source row, so no cycle.
-- 2. (MED) Voucher history: accounts.tally_matched details gain voucherRef and
--    voucherDate; accounts.tally_exception_raised and accounts.tally_reopened
--    gain previousVoucherRef / previousVoucherDate (lead decision; this
--    replaces "the voucher ref is not in the audit" of contract 7.1).
-- 3. (LOW) The export locks its Tally rows FOR NO KEY UPDATE (the touch
--    insert's foreign key takes KEY SHARE; serialisation comes from 1).
-- 4. (LOW) Reopen back to ready stores NULL: the computed status applies
--    (status column now nullable; a NULL row carries no voucher, match or
--    exception). The command still answers status 'ready'.
-- 5. (LOW) Manager rows link to the Deal dues card only when the Deal's
--    branch is one of the viewer's Manager branches (a receipt seen through
--    its collecting branch, AL8, gets 'none').
--
-- Replaced (latest bodies): authz.tally_touch_source (0320),
-- authz.tally_touch_deal / tally_touch_document (0310),
-- public.accounts_tally_match / accounts_tally_exception (0250),
-- public.accounts_tally_reopen / accounts_tally_export_create (0300),
-- authz.acct_row_json (0310).
--
-- Rollback (forward-only): a NEW migration restoring those bodies; the
-- nullable status stays.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 4. Nullable stored status
-- ===========================================================================

alter table public.tally_records alter column status drop not null;
alter table public.tally_records add constraint tally_records_null_status_clean check (status is not null
  or (matched_at is null and voucher_ref is null and exception_reason is null and status_before_exception is null));

-- Replaces 20261203000320: + the shared entity lock first.
create or replace function authz.tally_touch_source() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_ids uuid[];
  v_entity uuid;
begin
  -- Accounts phase (20261203000330): wait for a running export of the entity (it holds this lock exclusive).
  if tg_table_name = 'finance_journal_lines' then
    select e.legal_entity_id into v_entity from public.finance_journal_entries e
    where e.id = coalesce((v_new ->> 'entry_id')::uuid, (v_old ->> 'entry_id')::uuid);
  else
    v_entity := coalesce((v_new ->> 'legal_entity_id')::uuid, (v_old ->> 'legal_entity_id')::uuid);
  end if;
  if v_entity is not null then
    perform authz.tally_entity_lock(v_entity, false);
  end if;
  -- finance_journal_lines has a bigint id (it touches through entry_id).
  if tg_table_name <> 'finance_journal_lines' then
    v_ids := array_remove(array[(v_old ->> 'id')::uuid, (v_new ->> 'id')::uuid], null);
  end if;
  case tg_table_name
    when 'finance_journal_entries' then
      perform authz.tally_touch_kind('journal_entry', v_ids);
    when 'finance_journal_lines' then
      perform authz.tally_touch_kind('journal_entry',
        array_remove(array[(v_old ->> 'entry_id')::uuid, (v_new ->> 'entry_id')::uuid], null));
    when 'customer_receipts' then
      perform authz.tally_touch_kind('journal_entry',
        array(select e.id from public.finance_journal_entries e where e.receipt_id = any(v_ids)));
    when 'cash_deposits' then
      perform authz.tally_touch_kind('journal_entry',
        array(select e.id from public.finance_journal_entries e where e.deposit_id = any(v_ids)));
    when 'supplier_payment_requests' then
      perform authz.tally_touch_kind('supplier_payment', v_ids);
    when 'supplier_documents' then
      -- The document itself and the credit notes that print its number.
      perform authz.tally_touch_kind('supplier_document',
        v_ids || array(select s.id from public.supplier_documents s where s.credits_document_id = any(v_ids)));
    when 'fulfilment_tasks' then
      perform authz.tally_touch_kind('supplier_document',
        array(select s.id from public.supplier_documents s where s.task_id = any(v_ids)));
    when 'department_cost_entries' then
      perform authz.tally_touch_kind('expense', v_ids);
    when 'deal_tally_invoices' then
      perform authz.tally_touch_kind('tally_gst_invoice', v_ids);
    when 'supplier_document_tasks' then
      perform authz.tally_touch_kind('supplier_document',
        array_remove(array[(v_old ->> 'document_id')::uuid, (v_new ->> 'document_id')::uuid], null));
    when 'deals' then
      perform authz.tally_touch_rows(array(select t.id from public.tally_records t
                                           where t.deal_id = any(v_ids) and t.last_export_hash is not null));
    else
      null;
  end case;
  return null;
end;
$$;

-- Replaces 20261203000310: + the shared entity lock first.
create or replace function authz.tally_touch_deal() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform authz.tally_entity_lock(new.legal_entity_id, false);  -- Accounts phase (20261203000330)
  perform authz.tally_touch_rows(array(select t.id from public.tally_records t where t.deal_id = new.id and t.last_export_hash is not null));
  return null;
end;
$$;

-- Replaces 20261203000310: + the shared entity lock first.
create or replace function authz.tally_touch_document() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_doc uuid;
begin
  if tg_table_name = 'supplier_documents' then
    v_doc := new.id;
  else
    v_doc := new.document_id;
  end if;
  perform authz.tally_entity_lock(new.legal_entity_id, false);  -- Accounts phase (20261203000330)
  perform authz.tally_touch_rows(array(select t.id from public.tally_records t
                                       where t.record_kind = 'supplier_document' and t.record_id = v_doc));
  return null;
end;
$$;

-- Replaces 20261203000250: voucher in the audit.
create or replace function public.accounts_tally_match(p_kind text, p_record_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  t record;
  v_tr public.tally_records%rowtype;
  v_payload jsonb := jsonb_build_object('kind', p_kind, 'recordId', p_record_id, 'expectedRowVersion', p_expected_row_version,
    'fields', p_fields);
  v_result jsonb;
  v_ref text;
  v_date date;
  v_from text;
begin
  select * into t from authz.tally_prelude(p_kind, p_record_id, p_request_id) x limit 1;
  select * into v_tr from public.tally_records r where r.record_kind = p_kind and r.record_id = p_record_id for update;
  v_result := authz.finance_replay(t.entity, p_request_id, 'accounts_tally_match', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_expected_row_version is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' or (p_fields - array['voucherRef', 'voucherDate']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  begin
    v_ref := authz.finance_text(authz.finance_field(p_fields, 'voucherRef'), 1, 60, false);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'voucherRef';
  end;
  if v_ref is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'voucherRef';
  end if;
  v_date := authz.tally_voucher_date(authz.finance_field(p_fields, 'voucherDate'));
  if coalesce(v_tr.row_version, 0) <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_from := authz.tally_effective(t.computed, v_tr.status);
  if v_from in ('not_ready', 'not_applicable') then
    raise exception 'tally_not_ready' using errcode = '55000';
  elsif v_from = 'matched' then
    raise exception 'already_matched' using errcode = '55000';
  elsif v_from = 'exception' then
    raise exception 'tally_exception_open' using errcode = '55000';
  end if;

  if v_tr.id is null then
    insert into public.tally_records (legal_entity_id, branch_id, deal_id, record_kind, record_id, status, voucher_ref, voucher_date,
      matched_by, matched_at, updated_by)
    values (t.entity, t.branch_id, t.deal_id, p_kind, p_record_id, 'matched', v_ref, v_date, (select auth.uid()), now(), (select auth.uid()))
    returning * into v_tr;
  else
    update public.tally_records r
    set status = 'matched', voucher_ref = v_ref, voucher_date = v_date, matched_by = (select auth.uid()), matched_at = now(),
        row_version = r.row_version + 1, updated_at = now(), updated_by = (select auth.uid())
    where r.id = v_tr.id
    returning * into v_tr;
  end if;
  perform authz.write_audit('accounts.tally_matched', t.entity, t.branch_id, p_kind, p_record_id, null,
    jsonb_build_object('tallyRecordId', v_tr.id, 'rowVersion', v_tr.row_version, 'fromStatus', v_from,
      -- Accounts phase (20261203000330): voucher history (lead decision).
      'voucherRef', v_tr.voucher_ref, 'voucherDate', to_char(v_tr.voucher_date, 'YYYY-MM-DD')));
  v_result := jsonb_build_object('outcome', 'updated', 'tallyRecordId', v_tr.id, 'status', v_tr.status, 'rowVersion', v_tr.row_version);
  return authz.finance_remember(t.entity, p_request_id, 'accounts_tally_match', v_payload, v_result);
end;
$$;

-- Replaces 20261203000250: previous voucher in the audit.
create or replace function public.accounts_tally_exception(p_kind text, p_record_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  t record;
  v_tr public.tally_records%rowtype;
  v_payload jsonb := jsonb_build_object('kind', p_kind, 'recordId', p_record_id, 'expectedRowVersion', p_expected_row_version,
    'fields', p_fields);
  v_result jsonb;
  v_reason text;
  v_amount bigint;
  v_raw jsonb;
  v_from text;
  v_prev_ref text;
  v_prev_date date;
begin
  select * into t from authz.tally_prelude(p_kind, p_record_id, p_request_id) x limit 1;
  select * into v_tr from public.tally_records r where r.record_kind = p_kind and r.record_id = p_record_id for update;
  v_result := authz.finance_replay(t.entity, p_request_id, 'accounts_tally_exception', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_expected_row_version is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' or (p_fields - array['reason', 'tallyAmountPaise']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  begin
    v_reason := authz.finance_reason(authz.finance_field(p_fields, 'reason'));
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end;
  v_raw := p_fields -> 'tallyAmountPaise';
  if v_raw is not null and jsonb_typeof(v_raw) <> 'null' then
    if jsonb_typeof(v_raw) <> 'string' or (v_raw #>> '{}') !~ '^[1-9][0-9]{0,14}$' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'tallyAmountPaise';
    end if;
    v_amount := (v_raw #>> '{}')::bigint;
  end if;
  if coalesce(v_tr.row_version, 0) <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_from := authz.tally_effective(t.computed, v_tr.status);
  if v_from in ('not_ready', 'not_applicable') then
    raise exception 'tally_not_ready' using errcode = '55000';
  elsif v_from = 'exception' then
    raise exception 'tally_exception_open' using errcode = '55000';
  end if;

  v_prev_ref := v_tr.voucher_ref;
  v_prev_date := v_tr.voucher_date;
  if v_tr.id is null then
    insert into public.tally_records (legal_entity_id, branch_id, deal_id, record_kind, record_id, status, exception_reason,
      exception_tally_amount_paise, exception_by, exception_at, status_before_exception, updated_by)
    values (t.entity, t.branch_id, t.deal_id, p_kind, p_record_id, 'exception', v_reason, v_amount, (select auth.uid()), now(),
      v_from, (select auth.uid()))
    returning * into v_tr;
  else
    -- The voucher reference stays known while the exception is open.
    update public.tally_records r
    set status = 'exception', exception_reason = v_reason, exception_tally_amount_paise = v_amount,
        exception_by = (select auth.uid()), exception_at = now(), status_before_exception = v_from,
        matched_by = null, matched_at = null,
        row_version = r.row_version + 1, updated_at = now(), updated_by = (select auth.uid())
    where r.id = v_tr.id
    returning * into v_tr;
  end if;
  perform authz.write_audit('accounts.tally_exception_raised', t.entity, t.branch_id, p_kind, p_record_id, v_reason,
    jsonb_build_object('tallyRecordId', v_tr.id, 'rowVersion', v_tr.row_version, 'fromStatus', v_from,
      'amountGiven', v_amount is not null,
      -- Accounts phase (20261203000330): voucher history.
      'previousVoucherRef', v_prev_ref, 'previousVoucherDate', to_char(v_prev_date, 'YYYY-MM-DD')));
  v_result := jsonb_build_object('outcome', 'updated', 'tallyRecordId', v_tr.id, 'status', v_tr.status, 'rowVersion', v_tr.row_version);
  return authz.finance_remember(t.entity, p_request_id, 'accounts_tally_exception', v_payload, v_result);
end;
$$;

-- Replaces 20261203000300: NULL for ready; previous voucher in the audit.
create or replace function public.accounts_tally_reopen(p_kind text, p_record_id uuid, p_expected_row_version integer, p_reason text,
  p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  t record;
  v_tr public.tally_records%rowtype;
  v_payload jsonb := jsonb_build_object('kind', p_kind, 'recordId', p_record_id, 'expectedRowVersion', p_expected_row_version,
    'reason', p_reason);
  v_result jsonb;
  v_reason text;
  v_from text;
  v_to text;
  v_prev_ref text;
  v_prev_date date;
begin
  select * into t from authz.tally_prelude(p_kind, p_record_id, p_request_id) x limit 1;
  select * into v_tr from public.tally_records r where r.record_kind = p_kind and r.record_id = p_record_id for update;
  v_result := authz.finance_replay(t.entity, p_request_id, 'accounts_tally_reopen', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_expected_row_version is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  begin
    v_reason := authz.finance_reason(p_reason);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end;
  if coalesce(v_tr.row_version, 0) <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_from := authz.tally_effective(t.computed, v_tr.status);
  -- Accounts phase (20261203000300, Addendum L1): no dead ends.
  v_to := case
    when v_from = 'exception' and v_tr.status_before_exception = 'matched' and v_tr.voucher_ref is not null then 'matched'
    when v_from = 'exception' and (v_tr.status_before_exception = 'exported'
                                   or (v_tr.status_before_exception = 'ready' and v_tr.export_count > 0)) then 'exported'
    when v_from = 'exception' and v_tr.status_before_exception = 'ready' and v_tr.export_count = 0 then 'ready'
    when v_from = 'matched' and p_kind <> 'tally_gst_invoice' and v_tr.export_count > 0 then 'exported'
    when v_from = 'matched' and p_kind <> 'tally_gst_invoice' and v_tr.id is not null and v_tr.export_count = 0 then 'ready'
    else null end;
  if v_to is null then
    raise exception 'wrong_state' using errcode = '55000', hint = 'notReopenable';
  end if;

  v_prev_ref := v_tr.voucher_ref;
  v_prev_date := v_tr.voucher_date;
  -- Accounts phase (20261203000330): back to ready stores NULL (the computed status applies).
  update public.tally_records r
  set status = case when v_to = 'ready' then null else v_to end,
      voucher_ref = case when v_to = 'matched' then r.voucher_ref end,
      voucher_date = case when v_to = 'matched' then r.voucher_date end,
      matched_by = case when v_to = 'matched' then (select auth.uid()) end,
      matched_at = case when v_to = 'matched' then now() end,
      exception_reason = null, exception_tally_amount_paise = null, exception_by = null, exception_at = null,
      status_before_exception = null,
      row_version = r.row_version + 1, updated_at = now(), updated_by = (select auth.uid())
  where r.id = v_tr.id
  returning * into v_tr;
  perform authz.write_audit('accounts.tally_reopened', t.entity, t.branch_id, p_kind, p_record_id, v_reason,
    jsonb_build_object('tallyRecordId', v_tr.id, 'rowVersion', v_tr.row_version, 'fromStatus', v_from, 'toStatus', v_to,
      'previousVoucherRef', v_prev_ref, 'previousVoucherDate', to_char(v_prev_date, 'YYYY-MM-DD')));
  v_result := jsonb_build_object('outcome', 'updated', 'tallyRecordId', v_tr.id, 'status', coalesce(v_tr.status, v_to),
    'rowVersion', v_tr.row_version);
  return authz.finance_remember(t.entity, p_request_id, 'accounts_tally_reopen', v_payload, v_result);
end;
$$;

-- Replaces 20261203000300: FOR NO KEY UPDATE on the Tally rows.
create or replace function public.accounts_tally_export_create(p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c_kinds constant text[] := array['journal_entry', 'supplier_payment', 'supplier_document', 'expense', 'tally_gst_invoice'];
  v_payload jsonb := jsonb_build_object('fields', p_fields);
  v_result jsonb;
  v_entity uuid;
  v_from date;
  v_to date;
  v_kinds text[];
  v_include boolean;
  v_branches uuid[];
  v_syn boolean;
  v_count integer;
  v_skipped integer := 0;
  v_already integer := 0;
  v_year integer;
  v_no integer;
  v_export public.tally_exports%rowtype;
begin
  perform authz.finance_require_accounts_anywhere();
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['entityId', 'from', 'to', 'kinds', 'includeExported', 'branchIds']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  begin
    v_entity := authz.finance_uuid(authz.finance_field(p_fields, 'entityId'));
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'entityId';
  end;
  if v_entity is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'entityId';
  end if;
  perform authz.finance_require_accounts(v_entity, null);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_entity, p_request_id, 'accounts_tally_export_create', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if not coalesce((select s.tally_export_enabled from public.accounts_settings s where s.legal_entity_id = v_entity), false) then
    raise exception 'tally_export_off' using errcode = '55000';
  end if;
  begin
    v_from := authz.finance_date(authz.finance_field(p_fields, 'from'));
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'from'; end;
  begin
    v_to := authz.finance_date(authz.finance_field(p_fields, 'to'));
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'to'; end;
  if v_from is null or v_from < date '2000-01-01' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'from';
  end if;
  if v_to is null or v_to < v_from or v_to > authz.finance_today() or v_to - v_from > 366 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'to';
  end if;
  if jsonb_typeof(p_fields -> 'kinds') is distinct from 'array' or jsonb_array_length(p_fields -> 'kinds') = 0
     or exists (select 1 from jsonb_array_elements(p_fields -> 'kinds') e
                where jsonb_typeof(e) <> 'string' or not ((e #>> '{}') = any(c_kinds))) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kinds';
  end if;
  select array_agg(distinct e order by e) into v_kinds from jsonb_array_elements_text(p_fields -> 'kinds') e;
  if jsonb_typeof(p_fields -> 'includeExported') is distinct from 'boolean' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'includeExported';
  end if;
  v_include := (p_fields ->> 'includeExported')::boolean;
  if p_fields ? 'branchIds' and jsonb_typeof(p_fields -> 'branchIds') <> 'null' then
    if jsonb_typeof(p_fields -> 'branchIds') <> 'array' or jsonb_array_length(p_fields -> 'branchIds') not between 1 and 50
       or exists (select 1 from jsonb_array_elements(p_fields -> 'branchIds') e
                  where jsonb_typeof(e) <> 'string'
                     or (e #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     or not exists (select 1 from public.branches b where b.id = (e #>> '{}')::uuid and b.legal_entity_id = v_entity)) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'branchIds';
    end if;
    select array_agg(distinct (e #>> '{}')::uuid) into v_branches from jsonb_array_elements(p_fields -> 'branchIds') e;
  end if;
  v_syn := authz.acct_synthetic();

  -- Accounts phase (20261203000300, Addendum L1): one exclusive lock per
  -- entity (single-record Tally commands hold it shared), then FOR UPDATE on
  -- the Tally rows changed; everything below is set-based.
  perform authz.tally_entity_lock(v_entity, true);
  create temporary table if not exists tally_export_work (
    kind text, id uuid, line integer, branch_id uuid, deal_id uuid, tr_id uuid, prev_at timestamptz, prev_hash text,
    source jsonb, hash text) on commit drop;
  truncate tally_export_work;
  insert into tally_export_work (kind, id, line, branch_id, deal_id, tr_id, prev_at, prev_hash)
  select c.kind, c.id, row_number() over (order by c.kind, c.id), c.branch_id, c.deal_id, c.tr_id, c.prev_at, c.prev_hash
  from (
      select 'journal_entry'::text as kind, e.id, coalesce(d.branch_id, e.branch_id) as branch_id, tr.status as stored, 'ready'::text as computed, coalesce(d.id, null::uuid) as deal_id, tr.id as tr_id, tr.last_exported_at as prev_at, tr.last_export_hash as prev_hash
      from public.finance_journal_entries e
      left join public.deals d on d.id = e.deal_id
      left join public.tally_records tr on tr.record_kind = 'journal_entry' and tr.record_id = e.id
      where 'journal_entry' = any(v_kinds) and e.legal_entity_id = v_entity and e.business_date between v_from and v_to
        and (d.id is null or d.is_synthetic = v_syn)
      union all
      select 'supplier_payment', p.id, d.branch_id, tr.status, 'ready', d.id, tr.id, tr.last_exported_at, tr.last_export_hash
      from public.supplier_payment_requests p
      join public.deals d on d.id = p.deal_id
      left join public.tally_records tr on tr.record_kind = 'supplier_payment' and tr.record_id = p.id
      where 'supplier_payment' = any(v_kinds) and p.legal_entity_id = v_entity and p.status = 'verified'
        and p.paid_on between v_from and v_to and d.is_synthetic = v_syn
      union all
      select 'supplier_document', x.id, d.branch_id, tr.status, 'ready', d.id, tr.id, tr.last_exported_at, tr.last_export_hash
      from public.supplier_documents x
      join public.deals d on d.id = x.deal_id
      left join public.tally_records tr on tr.record_kind = 'supplier_document' and tr.record_id = x.id
      where 'supplier_document' = any(v_kinds) and x.legal_entity_id = v_entity and x.status = 'accepted'
        and x.doc_date between v_from and v_to and d.is_synthetic = v_syn
      union all
      select 'expense', c.id, d.branch_id, tr.status, 'ready', d.id, tr.id, tr.last_exported_at, tr.last_export_hash
      from public.department_cost_entries c
      join public.deals d on d.id = c.deal_id
      left join public.tally_records tr on tr.record_kind = 'expense' and tr.record_id = c.id
      where 'expense' = any(v_kinds) and c.legal_entity_id = v_entity and c.paid_by = 'company' and c.expense_status = 'accepted'
        and coalesce(c.paid_on, (timezone('Asia/Kolkata', c.created_at))::date) between v_from and v_to and d.is_synthetic = v_syn
      union all
      select 'tally_gst_invoice', g.id, g.branch_id, tr.status, 'matched', d.id, tr.id, tr.last_exported_at, tr.last_export_hash
      from public.deal_tally_invoices g
      join public.deals d on d.id = g.deal_id
      left join public.tally_records tr on tr.record_kind = 'tally_gst_invoice' and tr.record_id = g.id
      where 'tally_gst_invoice' = any(v_kinds) and g.legal_entity_id = v_entity and g.status = 'active'
        and g.invoice_date between v_from and v_to and d.is_synthetic = v_syn
    ) c
  where (v_branches is null or c.branch_id = any(v_branches))
    and (authz.tally_effective(c.computed, c.stored) = 'ready'
         or (v_include and authz.tally_effective(c.computed, c.stored) = 'exported'))
  order by c.kind, c.id
  limit 10001;
  select count(*)::int into v_count from tally_export_work;
  if v_count > 10000 then
    raise exception 'export_too_large' using errcode = '22023', hint = 'from';
  end if;
  if v_count = 0 then
    raise exception 'nothing_to_export' using errcode = '55000';
  end if;
  perform 1 from public.tally_records r where r.id in (select w.tr_id from tally_export_work w where w.tr_id is not null)
  order by r.id for no key update;  -- Accounts phase (20261203000330)

  -- Source values and hashes: one pass per kind.
  update tally_export_work w set source = s.source, hash = authz.tally_hash(s.source, s.ids)
  from (select k.kind, x.record_id, x.source, x.ids
        from (select distinct w2.kind from tally_export_work w2) k
        cross join lateral authz.tally_source_set(k.kind, (select array_agg(w3.id) from tally_export_work w3 where w3.kind = k.kind)) x) s
  where s.kind = w.kind and s.record_id = w.id;
  select count(*)::int into v_already from tally_export_work w where w.prev_at is not null;

  v_year := extract(year from authz.finance_today())::integer;
  insert into public.tally_export_counters as c (legal_entity_id, year, last_no) values (v_entity, v_year, 1)
  on conflict (legal_entity_id, year) do update set last_no = c.last_no + 1
  returning c.last_no into v_no;
  insert into public.tally_exports (legal_entity_id, export_no, period_from, period_to, kinds, include_exported, branch_ids,
    row_count, created_by, request_id)
  values (v_entity, 'TE-' || v_year::text || '-' || lpad(v_no::text, 6, '0'), v_from, v_to, v_kinds, v_include, v_branches,
    v_count, (select auth.uid()), p_request_id)
  returning * into v_export;

  -- New Tally rows (records exported for the first time).
  with ins as (
    insert into public.tally_records (legal_entity_id, branch_id, deal_id, record_kind, record_id, status, export_count,
      last_export_id, last_exported_at, last_export_hash, updated_by)
    select v_entity, w.branch_id, w.deal_id, w.kind, w.id, 'exported', 1, v_export.id, now(), w.hash, (select auth.uid())
    from tally_export_work w where w.tr_id is null
    returning id, record_kind, record_id)
  update tally_export_work w set tr_id = ins.id from ins where ins.record_kind = w.kind and ins.record_id = w.id;
  -- Lines (snapshots, masked) with the previous export state.
  insert into public.tally_export_lines (export_id, line_no, legal_entity_id, record_kind, record_id, tally_record_id, "values",
    source_hash, previously_exported_at)
  select v_export.id, w.line, v_entity, w.kind, w.id, w.tr_id,
    authz.tally_line_values(w.source, v_export.export_no, w.line, w.prev_at, w.prev_hash is not null and w.prev_hash <> w.hash),
    w.hash, w.prev_at
  from tally_export_work w;
  -- Rows exported before (or back at ready).
  update public.tally_records r
  set status = 'exported', export_count = r.export_count + 1, last_export_id = v_export.id, last_exported_at = now(),
      last_export_hash = w.hash, row_version = r.row_version + 1, updated_at = now(), updated_by = (select auth.uid())
  from tally_export_work w
  where r.id = w.tr_id and r.last_export_id is distinct from v_export.id;

  perform authz.write_audit('accounts.tally_export_created', v_entity, null, 'tally_export', v_export.id, null,
    jsonb_build_object('exportId', v_export.id, 'rowCount', v_count, 'kinds', to_jsonb(v_kinds),
      'alreadyExportedCount', v_already, 'skippedCount', v_skipped));
  v_result := jsonb_build_object('outcome', 'created', 'exportId', v_export.id, 'exportNo', v_export.export_no,
    'rowCount', v_count, 'alreadyExportedCount', v_already, 'skippedCount', v_skipped);
  return authz.finance_remember(v_entity, p_request_id, 'accounts_tally_export_create', v_payload, v_result);
end;
$$;

-- Replaces 20261203000310: Manager dues link only for the viewer's branches.
create or replace function authz.acct_row_json(p authz.acct_row) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tr public.tally_records%rowtype;
  v_deal public.deals%rowtype;
  v_files jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_other jsonb := '[]'::jsonb;
  v_link jsonb;
  v_original jsonb;
  v_changed boolean := false;
  v_service text;
  v_can jsonb;
  v_tally_status text := p.tally_status;
begin
  if p.tally_kind is not null then
    select * into v_tr from public.tally_records t where t.record_kind = p.tally_kind and t.record_id = p.tally_id;
    -- Accounts phase (20261203000310): only a record touched after its last export can have changed.
    if v_tr.id is not null and v_tr.last_export_hash is not null
       and exists (select 1 from public.tally_source_touches x where x.tally_record_id = v_tr.id and x.touched_at >= v_tr.last_exported_at) then
      v_changed := v_tr.last_export_hash <> coalesce(authz.tally_source_hash(v_tr.record_kind, v_tr.record_id), '');
    end if;
  end if;
  if p.deal_id is not null then
    select * into v_deal from public.deals d where d.id = p.deal_id;
  end if;
  if p.task_id is not null then
    select replace(initcap(i.service_type), '_', ' ') || ' ' || i.item_no::text into v_service
    from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
    where t.id = p.task_id;
  end if;

  -- Files: links only for A (existing Accounts download routes), counts for M.
  if p.kind = 'receipt' then
    select count(*)::int, coalesce(jsonb_agg(jsonb_build_object('kind', 'finance', 'evidenceId', e.id, 'fileName', e.file_name)
                                             order by e.seq), '[]'::jsonb)
    into v_count, v_files
    from public.finance_evidence e where e.receipt_id = p.record_id and e.status = 'stored';
  elsif p.kind = 'cash_deposit' then
    select count(*)::int, coalesce(jsonb_agg(jsonb_build_object('kind', 'finance', 'evidenceId', e.id, 'fileName', e.file_name)
                                             order by e.seq), '[]'::jsonb)
    into v_count, v_files
    from public.finance_evidence e where e.deposit_id = p.record_id and e.status = 'stored';
  elsif p.kind = 'supplier_payment' then
    select count(*)::int, coalesce(jsonb_agg(jsonb_build_object('kind', 'supplier_money', 'evidenceId', e.id, 'fileName', e.file_name)
                                             order by e.created_at), '[]'::jsonb)
    into v_count, v_files
    from public.supplier_payment_requests x
    join public.supplier_money_evidence e on e.id in (x.proforma_evidence_id, x.payment_proof_evidence_id)
    where x.id = p.record_id and e.status = 'stored';
  elsif p.kind in ('supplier_invoice', 'supplier_credit_note') then
    select count(*)::int, coalesce(jsonb_agg(jsonb_build_object('kind', 'supplier_money', 'evidenceId', e.id, 'fileName', e.file_name)), '[]'::jsonb)
    into v_count, v_files
    from public.supplier_documents x join public.supplier_money_evidence e on e.id = x.evidence_id
    where x.id = p.record_id and e.status = 'stored';
    select coalesce(jsonb_agg(c.number), '[]'::jsonb) into v_other
    from public.supplier_documents x join public.supplier_documents c on c.id = x.credits_document_id
    where x.id = p.record_id;
  elsif p.kind = 'expense' then
    select count(*)::int, coalesce(jsonb_agg(jsonb_build_object('kind', 'department', 'evidenceId', e.id, 'fileName', e.file_name)), '[]'::jsonb)
    into v_count, v_files
    from public.department_cost_entries x join public.department_evidence e on e.id = x.receipt_evidence_id
    where x.id = p.record_id and e.status = 'stored';
  elsif p.kind = 'flight_ticket_batch' then
    with t as (
      select tr.airline_pnr, tr.crs_pnr, tr.ticket_number
      from public.flight_ticket_revisions tr where tr.batch_id = p.record_id)
    select coalesce((select jsonb_agg(x.v order by x.v) from (
             select distinct airline_pnr as v from t union select distinct crs_pnr from t where crs_pnr is not null) x), '[]'::jsonb)
        || coalesce((select jsonb_build_array(case when min(ticket_number) = max(ticket_number) then min(ticket_number)
                                                  else min(ticket_number) || ' – ' || max(ticket_number) end)
                     from t having count(*) > 0), '[]'::jsonb)
    into v_other;
  elsif p.kind = 'company_funding' then
    v_other := '[]'::jsonb;
  end if;
  if not p.is_a then
    v_files := '[]'::jsonb;
  end if;

  -- Accounts phase (20261203000300): a screen the viewer can open.
  if not p.is_a then
    -- Branch Manager: the Deal page dues card, or nothing.
    -- Accounts phase (20261203000330): only for a Deal of one of the viewer's Manager branches.
    v_link := case when p.deal_id is not null and authz.is_branch_sales_manager(p.deal_id)
                   then jsonb_build_object('kind', 'deal_dues', 'id', p.deal_id)
                   else jsonb_build_object('kind', 'none', 'id', null) end;
  else
    v_link := case p.kind
      when 'claim' then jsonb_build_object('kind', 'claim', 'id', p.record_id)
      when 'cash_deposit' then jsonb_build_object('kind', 'cash', 'id', p.record_id)
      when 'cash_count' then jsonb_build_object('kind', 'cash', 'id', p.record_id)
      when 'supplier_payment' then jsonb_build_object('kind', 'supplier_payment', 'id', p.record_id)
      when 'company_funding' then jsonb_build_object('kind', 'supplier_payment',
        'id', (select f.payment_request_id from public.company_funding_requests f where f.id = p.record_id))
      when 'supplier_invoice' then jsonb_build_object('kind', 'supplier_document', 'id', p.record_id)
      when 'supplier_credit_note' then jsonb_build_object('kind', 'supplier_document', 'id', p.record_id)
      when 'expense' then jsonb_build_object('kind', 'expense', 'id', p.record_id)
      else case when p.deal_id is not null then jsonb_build_object('kind', 'accounts_deal', 'id', p.deal_id)
                else jsonb_build_object('kind', 'none', 'id', null) end
    end;
  end if;
  v_link := v_link || jsonb_build_object('dealId', p.deal_id,
    'ref', case when p.kind = 'original' then null else p.reference end);

  if p.kind = 'original' then
    v_original := jsonb_build_object('what', p.orig_what, 'state', p.orig_state, 'since', to_char(p.orig_since, 'YYYY-MM-DD'),
      'ownerRole', p.owner_role, 'ownerName', (select s.display_name from public.staff_profiles s where s.user_id = p.owner_user));
  end if;

  v_can := jsonb_build_object(
    'match', p.is_a and p.tally_kind is not null and v_tally_status in ('ready', 'exported'),
    'exception', p.is_a and p.tally_kind is not null and v_tally_status in ('ready', 'exported', 'matched'),
    -- Accounts phase (20261203000300): exactly where T3 succeeds (Addendum L1).
    'reopen', p.is_a and p.tally_kind is not null and v_tr.id is not null
              and (v_tally_status = 'exception' or (v_tally_status = 'matched' and p.tally_kind <> 'tally_gst_invoice')),
    'linkTask', p.is_a and p.kind in ('supplier_invoice', 'supplier_credit_note') and p.status_code <> 'returned');

  return jsonb_build_object(
    'rowId', p.kind || ':' || p.record_id::text,
    'kind', p.kind,
    'recordId', p.record_id,
    'recordDate', to_char(p.rd, 'YYYY-MM-DD'),
    'createdAt', p.ca,
    -- Accounts phase (20261203000290): an original's reference is filled here, for page rows only.
    'reference', case when p.kind <> 'original' then p.reference
                      when p.orig_what = 'bank_proof' then (select r.receipt_no from public.customer_receipts r where r.id = p.record_id)
                      else v_deal.reference end,
    'otherReferences', v_other,
    'dealId', p.deal_id,
    'dealReference', v_deal.reference,
    'bitrixDealId', v_deal.source_deal_id::text,
    'branchName', (select b.name from public.branches b where b.id = p.branch_id),
    'collectingBranchName', case when p.kind in ('receipt', 'receipt_reversal')
      then (select b.name from public.branches b where b.id = p.coll_branch_id) end,
    'department', p.department,
    'taskId', p.task_id,
    'serviceLabel', v_service,
    'supplierId', p.supplier_id,
    'supplierName', (select s.name from public.suppliers s where s.id = p.supplier_id),
    'amountPaise', p.amount::text,
    'direction', p.direction,
    'statusCode', p.status_code,
    'stage', p.stage,
    'reviewStatus', p.review,
    'tally', jsonb_build_object(
      'status', v_tally_status,
      'rowVersion', coalesce(v_tr.row_version, 0),
      'recordKind', p.tally_kind,
      'recordId', p.tally_id,
      'changedSinceExport', v_changed,
      'lastExportedAt', v_tr.last_exported_at,
      'exportCount', coalesce(v_tr.export_count, 0),
      'voucherRef', case when p.is_a then v_tr.voucher_ref end,
      'voucherDate', case when p.is_a then to_char(v_tr.voucher_date, 'YYYY-MM-DD') end,
      'exceptionReason', case when p.is_a then v_tr.exception_reason end),
    'files', jsonb_build_object('count', v_count, 'links', v_files),
    'original', v_original,
    'link', v_link,
    'can', v_can);
end;
$$;

commit;
