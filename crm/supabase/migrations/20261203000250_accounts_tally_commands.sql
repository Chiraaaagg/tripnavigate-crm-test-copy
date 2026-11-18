-- Accounts phase, Track B (6 of 6): Tally matching commands, the Deal GST
-- invoice reference, Accounts settings setters and the CSV evidence export.
-- Contract: implementation/accounts-phase-2026-11-10/contract.md sections
-- 7.1 (T1-T7), 7.2 (T8-T10), 7.4, 7.7, AL12, AL21 (frozen 10 Nov 2026).
--
-- Commands (security definer, execute to authenticated only; p_request_id
-- required and replayed through finance_replay/finance_remember):
--   T1 public.accounts_tally_match(p_kind, p_record_id, p_expected_row_version, p_fields, p_request_id)
--   T2 public.accounts_tally_exception(p_kind, p_record_id, p_expected_row_version, p_fields, p_request_id)
--   T3 public.accounts_tally_reopen(p_kind, p_record_id, p_expected_row_version, p_reason, p_request_id)
--   T4 public.accounts_tally_invoice_add(p_deal_id, p_fields, p_request_id)
--   T5 public.accounts_tally_invoice_withdraw(p_id, p_expected_row_version, p_reason, p_request_id)
--   T6 public.admin_set_accounts_exception_owner(p_entity, p_user_id, p_reason)   (no request id: admin setter)
--   T7 public.admin_set_tally_export_enabled(p_entity, p_enabled, p_reason)       (no request id: admin setter)
--   T8 public.accounts_tally_export_create(p_fields, p_request_id)
--   T10 public.accounts_tally_export_download_log(p_export_id)  (one audit row per download)
-- Reads:
--   T9 public.accounts_tally_export_lines(p_export_id, p_after_line, p_limit)
--   public.accounts_tally_exports(p_limit)          (addition: past exports + switch state for the Tally page)
--   public.admin_accounts_settings(p_entity)       (addition: current settings + exception owner candidates)
--
-- Lock order (never reversed): per-record advisory lock
-- pg_advisory_xact_lock(hashtextextended(kind || ':' || id, 0)) -> the
-- tally_records row FOR UPDATE. The export takes the advisory locks in
-- (record_kind, record_id) order, so a match and an export of the same record
-- serialise. GST invoice commands take finance_lock_deal first.
--
-- Matching is by any Accounts person of the entity (AL21); the branch Manager
-- never. Export never sets matched; matched and exception rows are never
-- exported; more than 10,000 rows is refused.
--
-- Refusal tokens (message is exactly the token): 42501 not_authorized |
-- P0002 not_found | 40001 version_changed, request_conflict | 22023
-- invalid_input (hint = field), export_too_large (hint from) | 23505
-- duplicate_tally_invoice (hint invoiceRef) | 55000 tally_not_ready,
-- already_matched, tally_exception_open, tally_export_off, nothing_to_export,
-- wrong_state (hint neverExported), environment_unset, not_configured.
--
-- Audit rows (ids, kinds, counts, row versions only; reasons in the reason
-- column; never voucher references, amounts or names):
-- accounts.tally_matched, accounts.tally_exception_raised,
-- accounts.tally_reopened, accounts.tally_invoice_added,
-- accounts.tally_invoice_withdrawn, accounts.tally_export_created,
-- accounts.tally_export_downloaded, settings.accounts_changed (trigger).
--
-- Rollback (forward-only): a NEW migration revoking execute on these
-- functions. Rows are never deleted.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Helpers
-- ===========================================================================

create function authz.tally_lock(p_kind text, p_id uuid) returns void
language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended(p_kind || ':' || p_id::text, 0))
$$;

-- The record a Tally command acts on: entity, row branch, Deal, synthetic
-- flag (null for records without a Deal) and computed status. No row when
-- the record does not exist (or is not a Tally record).
create function authz.tally_target(p_kind text, p_id uuid)
returns table (entity uuid, branch_id uuid, deal_id uuid, synthetic boolean, computed text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_kind = 'journal_entry' then
    return query select e.legal_entity_id, coalesce(d.branch_id, e.branch_id), e.deal_id, d.is_synthetic, 'ready'::text
      from public.finance_journal_entries e left join public.deals d on d.id = e.deal_id where e.id = p_id;
  elsif p_kind = 'supplier_payment' then
    return query select p.legal_entity_id, d.branch_id, p.deal_id, d.is_synthetic,
        case when p.status = 'verified' then 'ready' when p.status in ('returned', 'cancelled') then 'not_applicable' else 'not_ready' end
      from public.supplier_payment_requests p join public.deals d on d.id = p.deal_id where p.id = p_id;
  elsif p_kind = 'supplier_document' then
    return query select x.legal_entity_id, d.branch_id, x.deal_id, d.is_synthetic,
        case x.status when 'accepted' then 'ready' when 'returned' then 'not_applicable' else 'not_ready' end
      from public.supplier_documents x join public.deals d on d.id = x.deal_id where x.id = p_id;
  elsif p_kind = 'expense' then
    return query select c.legal_entity_id, d.branch_id, c.deal_id, d.is_synthetic,
        case when c.expense_status = 'accepted' then 'ready' else 'not_ready' end
      from public.department_cost_entries c join public.deals d on d.id = c.deal_id
      where c.id = p_id and c.paid_by = 'company';
  elsif p_kind = 'tally_gst_invoice' then
    return query select g.legal_entity_id, g.branch_id, g.deal_id, d.is_synthetic,
        case when g.status = 'withdrawn' then 'not_applicable' else 'matched' end
      from public.deal_tally_invoices g join public.deals d on d.id = g.deal_id where g.id = p_id;
  end if;
end;
$$;

-- Command prelude: kind, request id, record, Accounts of the record's
-- entity (finance gate with the Deal's synthetic flag), then the per-record
-- lock. Returns the target.
create function authz.tally_prelude(p_kind text, p_id uuid, p_request uuid)
returns table (entity uuid, branch_id uuid, deal_id uuid, synthetic boolean, computed text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  t record;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('journal_entry', 'supplier_payment', 'supplier_document', 'expense', 'tally_gst_invoice') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  if p_request is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into t from authz.tally_target(p_kind, p_id) x limit 1;
  if t.entity is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.finance_require_accounts(t.entity, t.synthetic);
  perform authz.tally_lock(p_kind, p_id);
  return query select t.entity, t.branch_id, t.deal_id, t.synthetic, t.computed;
end;
$$;

-- Voucher date: YYYY-MM-DD, 2000-01-01 .. today IST.
create function authz.tally_voucher_date(p_value text) returns date
language plpgsql stable set search_path = '' as $$
declare
  v date;
begin
  begin
    v := authz.finance_date(p_value);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'voucherDate';
  end;
  if v is null or v < date '2000-01-01' or v > authz.finance_today() then
    raise exception 'invalid_input' using errcode = '22023', hint = 'voucherDate';
  end if;
  return v;
end;
$$;

-- ===========================================================================
-- 2. T1-T3 matching
-- ===========================================================================

create function public.accounts_tally_match(p_kind text, p_record_id uuid, p_expected_row_version integer, p_fields jsonb,
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
    jsonb_build_object('tallyRecordId', v_tr.id, 'rowVersion', v_tr.row_version, 'fromStatus', v_from));
  v_result := jsonb_build_object('outcome', 'updated', 'tallyRecordId', v_tr.id, 'status', v_tr.status, 'rowVersion', v_tr.row_version);
  return authz.finance_remember(t.entity, p_request_id, 'accounts_tally_match', v_payload, v_result);
end;
$$;

create function public.accounts_tally_exception(p_kind text, p_record_id uuid, p_expected_row_version integer, p_fields jsonb,
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
      'amountGiven', v_amount is not null));
  v_result := jsonb_build_object('outcome', 'updated', 'tallyRecordId', v_tr.id, 'status', v_tr.status, 'rowVersion', v_tr.row_version);
  return authz.finance_remember(t.entity, p_request_id, 'accounts_tally_exception', v_payload, v_result);
end;
$$;

create function public.accounts_tally_reopen(p_kind text, p_record_id uuid, p_expected_row_version integer, p_reason text,
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
  v_to := case
    when v_from = 'exception' and v_tr.status_before_exception = 'matched' and v_tr.voucher_ref is not null then 'matched'
    when v_from = 'exception' and (v_tr.status_before_exception = 'exported'
                                   or (v_tr.status_before_exception = 'ready' and v_tr.export_count > 0)) then 'exported'
    when v_from = 'matched' and v_tr.export_count > 0 then 'exported'
    else null end;
  if v_to is null then
    raise exception 'wrong_state' using errcode = '55000', hint = 'neverExported';
  end if;

  update public.tally_records r
  set status = v_to,
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
    jsonb_build_object('tallyRecordId', v_tr.id, 'rowVersion', v_tr.row_version, 'fromStatus', v_from, 'toStatus', v_to));
  v_result := jsonb_build_object('outcome', 'updated', 'tallyRecordId', v_tr.id, 'status', v_tr.status, 'rowVersion', v_tr.row_version);
  return authz.finance_remember(t.entity, p_request_id, 'accounts_tally_reopen', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 3. T4-T5 GST invoice reference
-- ===========================================================================

create function public.accounts_tally_invoice_add(p_deal_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id, 'fields', p_fields);
  v_result jsonb;
  v_ref text;
  v_date date;
  v_note text;
  v_inv public.deal_tally_invoices%rowtype;
  v_tr public.tally_records%rowtype;
  v_constraint text;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.finance_require_accounts(v_deal.legal_entity_id, v_deal.is_synthetic);
  perform authz.finance_lock_deal(v_deal.id);
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'accounts_tally_invoice_add', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['invoiceRef', 'invoiceDate', 'note']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  begin
    v_ref := authz.finance_text(authz.finance_field(p_fields, 'invoiceRef'), 1, 40, false);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'invoiceRef';
  end;
  if v_ref is null or v_ref !~ '^[A-Za-z0-9/ .-]+$' or authz.sm_number_norm(v_ref) = '' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'invoiceRef';
  end if;
  begin
    v_date := authz.finance_date(authz.finance_field(p_fields, 'invoiceDate'));
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'invoiceDate';
  end;
  if v_date is null or v_date < date '2000-01-01' or v_date > authz.finance_today() then
    raise exception 'invalid_input' using errcode = '22023', hint = 'invoiceDate';
  end if;
  begin
    v_note := authz.finance_text(authz.finance_field(p_fields, 'note'), 1, 300, true);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'note';
  end;
  if exists (select 1 from public.deal_tally_invoices g
             where g.legal_entity_id = v_deal.legal_entity_id and g.status = 'active'
               and g.ref_norm = authz.sm_number_norm(v_ref) and g.fiscal_year = authz.finance_fiscal_year(v_date)) then
    raise exception 'duplicate_tally_invoice' using errcode = '23505', hint = 'invoiceRef';
  end if;
  begin
    insert into public.deal_tally_invoices (legal_entity_id, branch_id, deal_id, invoice_ref, invoice_date, note, created_by, request_id)
    values (v_deal.legal_entity_id, v_deal.branch_id, v_deal.id, v_ref, v_date, v_note, (select auth.uid()), p_request_id)
    returning * into v_inv;
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'deal_tally_invoices_active_ref_key' then
      raise exception 'duplicate_tally_invoice' using errcode = '23505', hint = 'invoiceRef';
    end if;
    raise;
  end;
  -- The reference is itself the Tally voucher: matched at creation.
  perform authz.tally_lock('tally_gst_invoice', v_inv.id);
  insert into public.tally_records (legal_entity_id, branch_id, deal_id, record_kind, record_id, status, voucher_ref, voucher_date,
    matched_by, matched_at, updated_by)
  values (v_deal.legal_entity_id, v_deal.branch_id, v_deal.id, 'tally_gst_invoice', v_inv.id, 'matched', v_ref, v_date,
    (select auth.uid()), now(), (select auth.uid()))
  returning * into v_tr;
  perform authz.write_audit('accounts.tally_invoice_added', v_deal.legal_entity_id, v_deal.branch_id, 'deal', v_deal.id, null,
    jsonb_build_object('dealId', v_deal.id, 'tallyInvoiceId', v_inv.id, 'tallyRecordId', v_tr.id));
  v_result := jsonb_build_object('outcome', 'created', 'id', v_inv.id, 'tallyRecordId', v_tr.id, 'rowVersion', v_inv.row_version);
  return authz.finance_remember(v_deal.legal_entity_id, p_request_id, 'accounts_tally_invoice_add', v_payload, v_result);
end;
$$;

create function public.accounts_tally_invoice_withdraw(p_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_inv public.deal_tally_invoices%rowtype;
  v_synthetic boolean;
  v_payload jsonb := jsonb_build_object('id', p_id, 'expectedRowVersion', p_expected_row_version, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into v_inv from public.deal_tally_invoices g where g.id = p_id;
  if v_inv.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = v_inv.deal_id;
  perform authz.finance_require_accounts(v_inv.legal_entity_id, v_synthetic);
  perform authz.finance_lock_deal(v_inv.deal_id);
  select * into v_inv from public.deal_tally_invoices g where g.id = p_id for update;
  v_result := authz.finance_replay(v_inv.legal_entity_id, p_request_id, 'accounts_tally_invoice_withdraw', v_payload);
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
  if v_inv.row_version <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if v_inv.status <> 'active' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  update public.deal_tally_invoices g
  set status = 'withdrawn', withdrawn_by = (select auth.uid()), withdrawn_at = now(), withdraw_reason = v_reason,
      row_version = g.row_version + 1, updated_at = now()
  where g.id = v_inv.id
  returning * into v_inv;
  perform authz.write_audit('accounts.tally_invoice_withdrawn', v_inv.legal_entity_id, v_inv.branch_id, 'deal', v_inv.deal_id,
    v_reason, jsonb_build_object('dealId', v_inv.deal_id, 'tallyInvoiceId', v_inv.id, 'rowVersion', v_inv.row_version));
  v_result := jsonb_build_object('outcome', 'updated', 'id', v_inv.id, 'status', v_inv.status, 'rowVersion', v_inv.row_version);
  return authz.finance_remember(v_inv.legal_entity_id, p_request_id, 'accounts_tally_invoice_withdraw', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 4. T6-T7 settings (policy manager: Super Admin without Accounts)
-- ===========================================================================

create function public.admin_set_accounts_exception_owner(p_entity uuid, p_user_id uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before uuid;
  v_after public.accounts_settings%rowtype;
  v_reason text;
  v_prev text[];
begin
  if p_entity is null or not authz.can_manage_finance_policy(p_entity) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  begin
    v_reason := authz.finance_reason(p_reason);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end;
  if p_user_id is not null and (not authz.is_active_department_person(p_user_id, p_entity, 'accounts')
     or exists (select 1 from public.memberships m where m.user_id = p_user_id and m.legal_entity_id = p_entity
                and m.role_code = 'purchase' and m.status = 'active')) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'userId';
  end if;
  select s.exception_owner_user_id into v_before from public.accounts_settings s where s.legal_entity_id = p_entity for update;
  v_prev := authz.settings_begin_change('admin_set_accounts_exception_owner', v_reason);
  insert into public.accounts_settings as s (legal_entity_id, exception_owner_user_id, updated_by)
  values (p_entity, p_user_id, (select auth.uid()))
  on conflict (legal_entity_id) do update
    set exception_owner_user_id = excluded.exception_owner_user_id, updated_by = excluded.updated_by, updated_at = now(),
        row_version = s.row_version + 1
    where s.exception_owner_user_id is distinct from excluded.exception_owner_user_id
  returning * into v_after;
  perform authz.settings_end_change(v_prev);
  if v_after.legal_entity_id is null then
    select * into v_after from public.accounts_settings s where s.legal_entity_id = p_entity;
  end if;
  return jsonb_build_object('changed', v_before is distinct from p_user_id or v_after.row_version = 1 and v_before is null and p_user_id is not null,
    'exceptionOwnerUserId', v_after.exception_owner_user_id, 'rowVersion', v_after.row_version, 'updatedAt', v_after.updated_at);
end;
$$;

create function public.admin_set_tally_export_enabled(p_entity uuid, p_enabled boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before boolean;
  v_after public.accounts_settings%rowtype;
  v_reason text;
  v_prev text[];
begin
  if p_entity is null or not authz.can_manage_finance_policy(p_entity) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  begin
    v_reason := authz.finance_reason(p_reason);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end;
  if p_enabled is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'enabled';
  end if;
  select s.tally_export_enabled into v_before from public.accounts_settings s where s.legal_entity_id = p_entity for update;
  v_prev := authz.settings_begin_change('admin_set_tally_export_enabled', v_reason);
  insert into public.accounts_settings as s (legal_entity_id, tally_export_enabled, updated_by)
  values (p_entity, p_enabled, (select auth.uid()))
  on conflict (legal_entity_id) do update
    set tally_export_enabled = excluded.tally_export_enabled, updated_by = excluded.updated_by, updated_at = now(),
        row_version = s.row_version + 1
    where s.tally_export_enabled is distinct from excluded.tally_export_enabled
  returning * into v_after;
  perform authz.settings_end_change(v_prev);
  if v_after.legal_entity_id is null then
    select * into v_after from public.accounts_settings s where s.legal_entity_id = p_entity;
  end if;
  return jsonb_build_object('changed', coalesce(v_before, false) is distinct from p_enabled,
    'tallyExportEnabled', v_after.tally_export_enabled, 'rowVersion', v_after.row_version, 'updatedAt', v_after.updated_at);
end;
$$;

-- Addition for the admin settings screen: current values and the people who
-- may be named exception owner (active Accounts of the entity without
-- Purchase). Policy managers only.
create function public.admin_accounts_settings(p_entity uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.accounts_settings%rowtype;
begin
  if p_entity is null or not authz.can_manage_finance_policy(p_entity) then
    return null;
  end if;
  select * into v from public.accounts_settings s where s.legal_entity_id = p_entity;
  return jsonb_build_object(
    'entityId', p_entity,
    'exceptionOwnerUserId', v.exception_owner_user_id,
    'exceptionOwnerName', (select p.display_name from public.staff_profiles p where p.user_id = v.exception_owner_user_id),
    'exceptionOwnerActive', authz.acct_exception_owner(p_entity) is not null,
    'tallyExportEnabled', coalesce(v.tally_export_enabled, false),
    'rowVersion', coalesce(v.row_version, 0),
    'updatedAt', v.updated_at,
    'candidates', coalesce((
      select jsonb_agg(jsonb_build_object('userId', p.user_id, 'name', p.display_name) order by p.display_name, p.user_id)
      from public.staff_profiles p
      where authz.is_active_department_person(p.user_id, p_entity, 'accounts')
        and not exists (select 1 from public.memberships m where m.user_id = p.user_id and m.legal_entity_id = p_entity
                        and m.role_code = 'purchase' and m.status = 'active')), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- 5. T8-T10 export
-- ===========================================================================

-- The masked CSV values of one line (contract 7.4).
create function authz.tally_line_values(p_source jsonb, p_export_no text, p_line integer, p_previous timestamptz, p_changed boolean)
returns jsonb
language sql immutable set search_path = '' as $$
  select (p_source - array['pan', 'mobile'])
    || jsonb_build_object(
      'exportNo', p_export_no,
      'line', p_line::text,
      'pan', authz.acct_mask_pan(p_source ->> 'pan'),
      'mobile', authz.acct_mask_mobile(p_source ->> 'mobile'),
      'alreadyExportedOn', case when p_previous is null then null else to_char(timezone('Asia/Kolkata', p_previous), 'YYYY-MM-DD') end,
      'changedSinceLastExport', case when p_changed then 'yes' else 'no' end)
$$;

create function public.accounts_tally_export_create(p_fields jsonb, p_request_id uuid) returns jsonb
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
  v_cand record;
  v_kind_arr text[] := array[]::text[];
  v_id_arr uuid[] := array[]::uuid[];
  v_keep_kind text[] := array[]::text[];
  v_keep_id uuid[] := array[]::uuid[];
  v_count integer;
  v_skipped integer := 0;
  v_already integer := 0;
  v_tr public.tally_records%rowtype;
  v_target record;
  v_eff text;
  v_year integer;
  v_no integer;
  v_export public.tally_exports%rowtype;
  v_source jsonb;
  v_hash text;
  i integer;
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

  -- Candidates by accounting date, in (record_kind, record_id) order.
  for v_cand in
    select c.kind, c.id from (
      select 'journal_entry'::text as kind, e.id, coalesce(d.branch_id, e.branch_id) as branch_id, tr.status as stored, 'ready'::text as computed
      from public.finance_journal_entries e
      left join public.deals d on d.id = e.deal_id
      left join public.tally_records tr on tr.record_kind = 'journal_entry' and tr.record_id = e.id
      where 'journal_entry' = any(v_kinds) and e.legal_entity_id = v_entity and e.business_date between v_from and v_to
        and (d.id is null or d.is_synthetic = v_syn)
      union all
      select 'supplier_payment', p.id, d.branch_id, tr.status, 'ready'
      from public.supplier_payment_requests p
      join public.deals d on d.id = p.deal_id
      left join public.tally_records tr on tr.record_kind = 'supplier_payment' and tr.record_id = p.id
      where 'supplier_payment' = any(v_kinds) and p.legal_entity_id = v_entity and p.status = 'verified'
        and p.paid_on between v_from and v_to and d.is_synthetic = v_syn
      union all
      select 'supplier_document', x.id, d.branch_id, tr.status, 'ready'
      from public.supplier_documents x
      join public.deals d on d.id = x.deal_id
      left join public.tally_records tr on tr.record_kind = 'supplier_document' and tr.record_id = x.id
      where 'supplier_document' = any(v_kinds) and x.legal_entity_id = v_entity and x.status = 'accepted'
        and x.doc_date between v_from and v_to and d.is_synthetic = v_syn
      union all
      select 'expense', c.id, d.branch_id, tr.status, 'ready'
      from public.department_cost_entries c
      join public.deals d on d.id = c.deal_id
      left join public.tally_records tr on tr.record_kind = 'expense' and tr.record_id = c.id
      where 'expense' = any(v_kinds) and c.legal_entity_id = v_entity and c.paid_by = 'company' and c.expense_status = 'accepted'
        and coalesce(c.paid_on, (timezone('Asia/Kolkata', c.created_at))::date) between v_from and v_to and d.is_synthetic = v_syn
      union all
      select 'tally_gst_invoice', g.id, g.branch_id, tr.status, 'matched'
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
    limit 10001
  loop
    v_kind_arr := v_kind_arr || v_cand.kind;
    v_id_arr := v_id_arr || v_cand.id;
  end loop;
  v_count := cardinality(v_kind_arr);
  if v_count > 10000 then
    raise exception 'export_too_large' using errcode = '22023', hint = 'from';
  end if;
  if v_count = 0 then
    raise exception 'nothing_to_export' using errcode = '55000';
  end if;

  -- Lock in (record_kind, record_id) order and re-check under the lock.
  for i in 1 .. v_count loop
    perform authz.tally_lock(v_kind_arr[i], v_id_arr[i]);
    select * into v_tr from public.tally_records r where r.record_kind = v_kind_arr[i] and r.record_id = v_id_arr[i] for update;
    select * into v_target from authz.tally_target(v_kind_arr[i], v_id_arr[i]) x limit 1;
    v_eff := authz.tally_effective(v_target.computed, v_tr.status);
    if v_eff = 'ready' or (v_include and v_eff = 'exported') then
      v_keep_kind := v_keep_kind || v_kind_arr[i];
      v_keep_id := v_keep_id || v_id_arr[i];
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;
  v_count := cardinality(v_keep_kind);
  if v_count = 0 then
    raise exception 'nothing_to_export' using errcode = '55000';
  end if;

  v_year := extract(year from authz.finance_today())::integer;
  insert into public.tally_export_counters as c (legal_entity_id, year, last_no) values (v_entity, v_year, 1)
  on conflict (legal_entity_id, year) do update set last_no = c.last_no + 1
  returning c.last_no into v_no;
  insert into public.tally_exports (legal_entity_id, export_no, period_from, period_to, kinds, include_exported, branch_ids,
    row_count, created_by, request_id)
  values (v_entity, 'TE-' || v_year::text || '-' || lpad(v_no::text, 6, '0'), v_from, v_to, v_kinds, v_include, v_branches,
    v_count, (select auth.uid()), p_request_id)
  returning * into v_export;

  for i in 1 .. v_count loop
    select * into v_tr from public.tally_records r where r.record_kind = v_keep_kind[i] and r.record_id = v_keep_id[i];
    select * into v_target from authz.tally_target(v_keep_kind[i], v_keep_id[i]) x limit 1;
    v_source := authz.tally_source_json(v_keep_kind[i], v_keep_id[i]);
    v_hash := authz.finance_payload_hash(v_source);
    if v_tr.last_exported_at is not null then
      v_already := v_already + 1;
    end if;
    if v_tr.id is null then
      insert into public.tally_records (legal_entity_id, branch_id, deal_id, record_kind, record_id, status, export_count,
        last_export_id, last_exported_at, last_export_hash, updated_by)
      values (v_entity, v_target.branch_id, v_target.deal_id, v_keep_kind[i], v_keep_id[i], 'exported', 1,
        v_export.id, now(), v_hash, (select auth.uid()))
      returning * into v_tr;
      insert into public.tally_export_lines (export_id, line_no, legal_entity_id, record_kind, record_id, tally_record_id, "values",
        source_hash, previously_exported_at)
      values (v_export.id, i, v_entity, v_keep_kind[i], v_keep_id[i], v_tr.id,
        authz.tally_line_values(v_source, v_export.export_no, i, null, false), v_hash, null);
    else
      insert into public.tally_export_lines (export_id, line_no, legal_entity_id, record_kind, record_id, tally_record_id, "values",
        source_hash, previously_exported_at)
      values (v_export.id, i, v_entity, v_keep_kind[i], v_keep_id[i], v_tr.id,
        authz.tally_line_values(v_source, v_export.export_no, i, v_tr.last_exported_at,
          v_tr.last_export_hash is not null and v_tr.last_export_hash <> v_hash),
        v_hash, v_tr.last_exported_at);
      update public.tally_records r
      set status = 'exported', export_count = r.export_count + 1, last_export_id = v_export.id, last_exported_at = now(),
          last_export_hash = v_hash, row_version = r.row_version + 1, updated_at = now(), updated_by = (select auth.uid())
      where r.id = v_tr.id;
    end if;
  end loop;

  perform authz.write_audit('accounts.tally_export_created', v_entity, null, 'tally_export', v_export.id, null,
    jsonb_build_object('exportId', v_export.id, 'rowCount', v_count, 'kinds', to_jsonb(v_kinds),
      'alreadyExportedCount', v_already, 'skippedCount', v_skipped));
  v_result := jsonb_build_object('outcome', 'created', 'exportId', v_export.id, 'exportNo', v_export.export_no,
    'rowCount', v_count, 'alreadyExportedCount', v_already, 'skippedCount', v_skipped);
  return authz.finance_remember(v_entity, p_request_id, 'accounts_tally_export_create', v_payload, v_result);
end;
$$;

-- The export header (shared by T9, T10 and the export list).
create function authz.tally_export_json(p_export uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'exportId', x.id, 'exportNo', x.export_no, 'entityId', x.legal_entity_id,
    'periodFrom', to_char(x.period_from, 'YYYY-MM-DD'), 'periodTo', to_char(x.period_to, 'YYYY-MM-DD'),
    'kinds', to_jsonb(x.kinds), 'includeExported', x.include_exported,
    'branchNames', case when x.branch_ids is null then null else
      (select jsonb_agg(b.name order by b.name) from public.branches b where b.id = any(x.branch_ids)) end,
    'rowCount', x.row_count,
    'alreadyExportedCount', (select count(*) from public.tally_export_lines l
                             where l.export_id = x.id and l.previously_exported_at is not null),
    'createdAt', x.created_at, 'createdByName', p.display_name,
    'fileName', 'tripnavigate-' || x.export_no || '.csv')
  from public.tally_exports x
  left join public.staff_profiles p on p.user_id = x.created_by
  where x.id = p_export
$$;

-- T9: lines of one export, page by page (snapshots: a re-download gives the
-- same file). A of the export's entity; else null.
create function public.accounts_tally_export_lines(p_export_id uuid, p_after_line integer default 0, p_limit integer default 1000)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_export public.tally_exports%rowtype;
  v_limit integer := least(greatest(coalesce(p_limit, 1000), 1), 1000);
  v_after integer := greatest(coalesce(p_after_line, 0), 0);
  v_lines jsonb;
  v_last integer;
begin
  if p_export_id is null or not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v_export from public.tally_exports x where x.id = p_export_id;
  if v_export.id is null or not (v_export.legal_entity_id = any(authz.acct_a_entities())) then
    return null;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('lineNo', l.line_no, 'values', l."values") order by l.line_no), '[]'::jsonb),
         max(l.line_no)
  into v_lines, v_last
  from (select * from public.tally_export_lines l where l.export_id = v_export.id and l.line_no > v_after
        order by l.line_no limit v_limit) l;
  return jsonb_build_object('exportId', v_export.id, 'exportNo', v_export.export_no, 'lines', v_lines,
    'nextAfter', case when v_last is not null and v_last < v_export.row_count then v_last end);
end;
$$;

-- T10: one audit row per download (called once before streaming); returns
-- the header.
create function public.accounts_tally_export_download_log(p_export_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_export public.tally_exports%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_export from public.tally_exports x where x.id = p_export_id;
  if v_export.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.finance_require_accounts(v_export.legal_entity_id, null);
  perform authz.write_audit('accounts.tally_export_downloaded', v_export.legal_entity_id, null, 'tally_export', v_export.id, null,
    jsonb_build_object('exportId', v_export.id, 'rowCount', v_export.row_count));
  return authz.tally_export_json(v_export.id);
end;
$$;

-- Addition for the Tally page: switch state and the latest exports of the
-- caller's Accounts entities. A only; else null.
create function public.accounts_tally_exports(p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_a uuid[];
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  v_a := authz.acct_a_entities();
  if cardinality(v_a) = 0 then
    return null;
  end if;
  return jsonb_build_object(
    'entities', coalesce((select jsonb_agg(jsonb_build_object('entityId', e.id, 'name', e.legal_name,
        'exportEnabled', coalesce(s.tally_export_enabled, false),
        'branches', coalesce((select jsonb_agg(jsonb_build_object('branchId', b.id, 'name', b.name) order by b.name)
                              from public.branches b where b.legal_entity_id = e.id and b.status = 'enabled'), '[]'::jsonb))
        order by e.legal_name)
      from public.legal_entities e left join public.accounts_settings s on s.legal_entity_id = e.id
      where e.id = any(v_a)), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(authz.tally_export_json(x.id) order by x.created_at desc, x.id)
                       from (select t.id, t.created_at from public.tally_exports t where t.legal_entity_id = any(v_a)
                             order by t.created_at desc, t.id limit v_limit) x), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- 6. Grants
-- ===========================================================================

revoke all on function authz.tally_lock(text, uuid), authz.tally_target(text, uuid), authz.tally_prelude(text, uuid, uuid),
  authz.tally_voucher_date(text), authz.tally_line_values(jsonb, text, integer, timestamptz, boolean),
  authz.tally_export_json(uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  public.accounts_tally_match(text, uuid, integer, jsonb, uuid),
  public.accounts_tally_exception(text, uuid, integer, jsonb, uuid),
  public.accounts_tally_reopen(text, uuid, integer, text, uuid),
  public.accounts_tally_invoice_add(uuid, jsonb, uuid),
  public.accounts_tally_invoice_withdraw(uuid, integer, text, uuid),
  public.admin_set_accounts_exception_owner(uuid, uuid, text),
  public.admin_set_tally_export_enabled(uuid, boolean, text),
  public.admin_accounts_settings(uuid),
  public.accounts_tally_export_create(jsonb, uuid),
  public.accounts_tally_export_lines(uuid, integer, integer),
  public.accounts_tally_export_download_log(uuid),
  public.accounts_tally_exports(integer)
  from public, anon, authenticated, service_role;
grant execute on function
  public.accounts_tally_match(text, uuid, integer, jsonb, uuid),
  public.accounts_tally_exception(text, uuid, integer, jsonb, uuid),
  public.accounts_tally_reopen(text, uuid, integer, text, uuid),
  public.accounts_tally_invoice_add(uuid, jsonb, uuid),
  public.accounts_tally_invoice_withdraw(uuid, integer, text, uuid),
  public.admin_set_accounts_exception_owner(uuid, uuid, text),
  public.admin_set_tally_export_enabled(uuid, boolean, text),
  public.admin_accounts_settings(uuid),
  public.accounts_tally_export_create(jsonb, uuid),
  public.accounts_tally_export_lines(uuid, integer, integer),
  public.accounts_tally_export_download_log(uuid),
  public.accounts_tally_exports(integer)
  to authenticated;

commit;
