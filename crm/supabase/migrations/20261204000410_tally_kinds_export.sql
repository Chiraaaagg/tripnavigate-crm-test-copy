-- TripNavigate CRM - Accounts phase 2, Track D (2 of 4): new Tally kinds,
-- mapped CSV columns and the daily check counts.
-- Contract: accounts-phase2-2026-11-11/contract.md sections 8.2, 13 (daily
-- check), 13.1 (lock order), LD19, LD20, Addendum L1 (frozen 11 Nov 2026).
-- Owner rules: the CRM never posts to Tally and makes no XML; the export is
-- a CSV evidence file and never marks anything matched.
--
-- What this file changes:
--   1. tally_records.record_kind, tally_export_lines.record_kind and
--      tally_exports.kinds accept 'customer_document' and 'supplier_refund'
--      (kinds 1..7). Refund journal entries (kinds refund_bank, refund_cash,
--      track C) are 'journal_entry' records, ready when posted.
--   2. authz.tally_target / authz.tally_prelude (replace 20261203000250 /
--      20261203000300, same signatures): readiness of the new kinds.
--        customer_document: released -> ready; draft -> not ready; discarded
--          -> not applicable; replaced or cancelled -> exported state kept
--          when it was exported (then "changed since export"), else not
--          applicable.
--        supplier_refund: verified -> ready; rejected -> exported state kept
--          when it was exported, else not applicable (Addendum L1).
--   3. authz.tally_source_set (replace 20261203000300, same signature):
--      refund journal entries ("Customer refund", RF number, payout mode
--      and reference, payee as party), customer documents (number, issue
--      date, billing name as party, credited document, linked Tally GST
--      invoice number as tallyNumber; status in the hash ids) and supplier
--      refunds (status in the hash ids). Source values of the Phase 1 kinds
--      are unchanged, so their stored hashes stay equal.
--   4. authz.tally_touch_source (replace 20261203000330) and touch triggers
--      (Phase 1 B6 rule, shared Tally entity lock first) on
--      customer_documents (status, number, total, issue date, Tally link,
--      credited document, kind, Deal, branch, content),
--      supplier_refund_receipts (status, amount, date, mode, reference,
--      supplier, source, Deal, branch), customer_refund_requests (RF number,
--      payee), customer_refund_payouts (append-only; for completeness),
--      finance_journal_entries (refund_payout_id) and deal_tally_invoices
--      (documents printing the GST invoice number).
--   5. authz.tally_changed_ids (replace 20261203000340): every kind.
--   6. authz.tally_line_values (replace 20261203000250, same signature): +
--      narration "Deal <Bitrix Deal ID or CRM reference> | <CRM reference> |
--      <record type> <reference>" (no names; a row without a Deal gives
--      "<record type> <reference>").
--   7. public.accounts_tally_export_create (replace 20261203000350, same
--      locks, temp-table rule and result): new kinds; every line gains
--      service, tallyDebitLedger, tallyCreditLedger, tallyVoucherType,
--      mappingMissing ('yes'|'no') from public.tally_ledger_mappings
--      (row kind x service class, falling back to 'any'). The mapping is
--      not hashed (LD19): changing it never flags "changed since export".
--   8. public.accounts_tally_exports (replace 20261203000250, additive):
--      entities[].mappingMissingCount.
--   9. public.accounts_daily_check (replace 20261203000310, additive):
--      documentsToRelease, pdfFailed, refundPayoutsDueOverOneWorkingDay,
--      supplierRefundsToVerify (always 0 under Addendum L1: supplier refunds
--      are verified when recorded) and supplierRefundsDue (approved
--      cancellations whose expected supplier refunds are not yet received).
--
-- Lock order unchanged (contract 13.1): touch triggers take the Tally
-- entity lock shared; the export takes it exclusive first and never locks a
-- source row.
-- Refusal tokens: unchanged (Phase 1 7.7).
-- Rollback (forward-only): a new migration restoring the replaced bodies and
-- dropping the new touch triggers; the widened checks stay.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Kind checks
-- ===========================================================================

do $$
declare
  c record;
begin
  for c in
    select con.conrelid::regclass::text as tbl, con.conname from pg_catalog.pg_constraint con
    where con.contype = 'c'
      and con.conrelid in ('public.tally_records'::regclass, 'public.tally_export_lines'::regclass, 'public.tally_exports'::regclass)
      and pg_catalog.pg_get_constraintdef(con.oid) like '%tally_gst_invoice%'
  loop
    execute format('alter table %s drop constraint %I', c.tbl, c.conname);
  end loop;
end;
$$;
alter table public.tally_records add constraint tally_records_record_kind_check check (record_kind in ('journal_entry',
  'supplier_payment', 'supplier_document', 'expense', 'tally_gst_invoice', 'customer_document', 'supplier_refund'));
alter table public.tally_export_lines add constraint tally_export_lines_record_kind_check check (record_kind in ('journal_entry',
  'supplier_payment', 'supplier_document', 'expense', 'tally_gst_invoice', 'customer_document', 'supplier_refund'));
alter table public.tally_exports add constraint tally_exports_kinds_check check (cardinality(kinds) between 1 and 7
  and array_position(kinds, null) is null
  and kinds <@ array['journal_entry', 'supplier_payment', 'supplier_document', 'expense', 'tally_gst_invoice',
                     'customer_document', 'supplier_refund']);

create function authz.tally_kinds() returns text[]
language sql immutable set search_path = '' as $$
  select array['journal_entry', 'supplier_payment', 'supplier_document', 'expense', 'tally_gst_invoice',
               'customer_document', 'supplier_refund']
$$;

-- ===========================================================================
-- 2. Target and prelude
-- ===========================================================================

-- Replaces 20261203000250: + customer_document, supplier_refund.
create or replace function authz.tally_target(p_kind text, p_id uuid)
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
  -- Accounts phase 2 (20261204000410)
  elsif p_kind = 'customer_document' then
    return query select x.legal_entity_id, d.branch_id, x.deal_id, d.is_synthetic,
        case when x.status = 'released' then 'ready'
             when x.status = 'draft' then 'not_ready'
             when x.status in ('replaced', 'cancelled') and exists (
               select 1 from public.tally_records t
               where t.record_kind = 'customer_document' and t.record_id = x.id and t.last_export_id is not null) then 'ready'
             else 'not_applicable' end
      from public.customer_documents x join public.deals d on d.id = x.deal_id where x.id = p_id;
  elsif p_kind = 'supplier_refund' then
    return query select x.legal_entity_id, d.branch_id, x.deal_id, d.is_synthetic,
        case when x.status = 'verified' then 'ready'
             when exists (
               select 1 from public.tally_records t
               where t.record_kind = 'supplier_refund' and t.record_id = x.id and t.last_export_id is not null) then 'ready'
             else 'not_applicable' end
      from public.supplier_refund_receipts x join public.deals d on d.id = x.deal_id where x.id = p_id;
  end if;
end;
$$;

-- Replaces 20261203000300: kind list from authz.tally_kinds().
create or replace function authz.tally_prelude(p_kind text, p_id uuid, p_request uuid)
returns table (entity uuid, branch_id uuid, deal_id uuid, synthetic boolean, computed text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  t record;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_kind is null or not (p_kind = any(authz.tally_kinds())) then  -- Accounts phase 2 (20261204000410)
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
  perform authz.tally_entity_lock(t.entity, false);
  perform authz.tally_lock(p_kind, p_id);
  return query select t.entity, t.branch_id, t.deal_id, t.synthetic, t.computed;
end;
$$;

-- ===========================================================================
-- 3. Source values
-- ===========================================================================

create function authz.tally_supplier_refund_mode(p text) returns text
language sql immutable set search_path = '' as $$
  select case p when 'card_reversal' then 'card reversal' else authz.acct_mode_word(p) end
$$;

-- Replaces 20261203000300 (same signature): + refund journal entries,
-- customer documents, supplier refunds. Phase 1 kinds give the same values.
create or replace function authz.tally_source_set(p_kind text, p_ids uuid[]) returns table (record_id uuid, source jsonb, ids jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_kind = 'journal_entry' then
    return query select e.id, jsonb_build_object(
      'recordType', case when e.kind in ('receipt_bank', 'receipt_cash') then 'Receipt'
                         when e.kind = 'deposit' then 'Cash deposit'
                         when e.kind in ('refund_bank', 'refund_cash') then 'Customer refund'  -- Accounts phase 2
                         else 'Receipt reversal' end,
      'voucherType', case when e.kind in ('receipt_bank', 'receipt_cash') then 'Receipt'
                          when e.kind = 'deposit' then 'Contra'
                          when e.kind in ('refund_bank', 'refund_cash') then 'Payment'  -- Accounts phase 2
                          else 'Journal' end,
      'date', to_char(e.business_date, 'YYYY-MM-DD'),
      'reference', coalesce(r.receipt_no, rf.ref_no),
      'deal', d.reference,
      'bitrixDealId', d.source_deal_id::text,
      'branch', b.name,
      'party', coalesce(r.payer_name, rf.payee_name),
      'debitLedger', (select authz.acct_ledger_word(l.account) from public.finance_journal_lines l
                      where l.entry_id = e.id and l.debit_paise > 0 order by l.id limit 1),
      'creditLedger', (select authz.acct_ledger_word(l.account) from public.finance_journal_lines l
                       where l.entry_id = e.id and l.credit_paise > 0 order by l.id limit 1),
      'amount', authz.acct_amount_text((select sum(l.debit_paise)::bigint from public.finance_journal_lines l where l.entry_id = e.id)),
      'mode', authz.acct_mode_word(case when e.kind = 'deposit' then 'cash'
                                        when e.kind in ('refund_bank', 'refund_cash') then po.mode else r.mode end),
      'bankReference', coalesce(r.reference, r.cheque_number, dep.bank_reference, po.reference),
      'pan', r.payer_pan,
      'mobile', r.payer_mobile,
      'gstIncluded', null, 'creditNoteFor', null, 'linkedTasks', null,
      'crmRecordId', e.id::text),
      jsonb_build_object('branchId', b.id, 'dealId', d.id, 'supplierId', null)
    from public.finance_journal_entries e
    left join public.customer_receipts r on r.id = e.receipt_id
    left join public.cash_deposits dep on dep.id = e.deposit_id
    left join public.customer_refund_payouts po on po.id = e.refund_payout_id
    left join public.customer_refund_requests rf on rf.id = po.refund_request_id
    left join public.deals d on d.id = e.deal_id
    join public.branches b on b.id = coalesce(d.branch_id, e.branch_id)
    where e.id in (select unnest(p_ids));
  elsif p_kind = 'supplier_payment' then
    return query select p.id, jsonb_build_object(
      'recordType', 'Supplier payment', 'voucherType', 'Payment',
      'date', to_char(p.paid_on, 'YYYY-MM-DD'),
      'reference', p.ref_no, 'deal', d.reference, 'bitrixDealId', d.source_deal_id::text, 'branch', b.name,
      'party', s.name, 'debitLedger', 'Supplier', 'creditLedger', 'Bank',
      'amount', authz.acct_amount_text(p.amount_paise),
      'mode', authz.acct_mode_word(p.payment_mode), 'bankReference', p.bank_reference,
      'pan', null, 'mobile', null, 'gstIncluded', null, 'creditNoteFor', null, 'linkedTasks', null,
      'crmRecordId', p.id::text),
      jsonb_build_object('branchId', b.id, 'dealId', d.id, 'supplierId', s.id)
    from public.supplier_payment_requests p
    join public.deals d on d.id = p.deal_id
    join public.branches b on b.id = d.branch_id
    join public.suppliers s on s.id = p.supplier_id
    where p.id in (select unnest(p_ids));
  elsif p_kind = 'supplier_document' then
    return query select x.id, jsonb_build_object(
      'recordType', case when x.kind = 'invoice' then 'Supplier invoice' else 'Supplier credit note' end,
      'voucherType', case when x.kind = 'invoice' then 'Purchase' else 'Debit note' end,
      'date', to_char(x.doc_date, 'YYYY-MM-DD'),
      'reference', x.number, 'deal', d.reference, 'bitrixDealId', d.source_deal_id::text, 'branch', b.name,
      'party', s.name,
      'debitLedger', case when x.kind = 'invoice'
                          then case when t.department = 'flight' then 'Expense – Flight' else 'Expense – other' end
                          else 'Supplier' end,
      'creditLedger', case when x.kind = 'invoice' then 'Supplier'
                           else case when t.department = 'flight' then 'Expense – Flight' else 'Expense – other' end end,
      'amount', authz.acct_amount_text(x.total_paise),
      'mode', null, 'bankReference', null, 'pan', null, 'mobile', null,
      'gstIncluded', case when x.gst_included then 'yes' else 'no' end,
      'creditNoteFor', (select c.number from public.supplier_documents c where c.id = x.credits_document_id),
      'linkedTasks', (select count(*)::text from public.supplier_document_tasks l
                      where l.document_id = x.id and l.unlinked_at is null),
      'crmRecordId', x.id::text),
      jsonb_build_object('branchId', b.id, 'dealId', d.id, 'supplierId', s.id)
    from public.supplier_documents x
    join public.deals d on d.id = x.deal_id
    join public.branches b on b.id = d.branch_id
    join public.suppliers s on s.id = x.supplier_id
    join public.fulfilment_tasks t on t.id = x.task_id
    where x.id in (select unnest(p_ids));
  elsif p_kind = 'expense' then
    return query select c.id, jsonb_build_object(
      'recordType', 'Expense', 'voucherType', 'Payment',
      'date', to_char(coalesce(c.paid_on, (timezone('Asia/Kolkata', c.created_at))::date), 'YYYY-MM-DD'),
      'reference', null, 'deal', d.reference, 'bitrixDealId', d.source_deal_id::text, 'branch', b.name,
      'party', s.name,
      'debitLedger', case c.department when 'visa' then 'Expense – Visa fees' when 'flight' then 'Expense – Flight'
                                       else 'Expense – other' end,
      'creditLedger', case when c.payment_mode = 'cash' then 'Cash in hand' else 'Bank' end,
      'amount', authz.acct_amount_text(c.amount_paise),
      'mode', authz.acct_mode_word(c.payment_mode), 'bankReference', c.reference,
      'pan', null, 'mobile', null, 'gstIncluded', null, 'creditNoteFor', null, 'linkedTasks', null,
      'crmRecordId', c.id::text),
      jsonb_build_object('branchId', b.id, 'dealId', d.id, 'supplierId', s.id)
    from public.department_cost_entries c
    join public.deals d on d.id = c.deal_id
    join public.branches b on b.id = d.branch_id
    left join public.suppliers s on s.id = c.supplier_id
    where c.id in (select unnest(p_ids));
  elsif p_kind = 'tally_gst_invoice' then
    return query select g.id, jsonb_build_object(
      'recordType', 'GST invoice reference', 'voucherType', 'Sales',
      'date', to_char(g.invoice_date, 'YYYY-MM-DD'),
      'reference', g.invoice_ref, 'deal', d.reference, 'bitrixDealId', d.source_deal_id::text, 'branch', b.name,
      'party', null, 'debitLedger', 'Customer advances', 'creditLedger', null, 'amount', null,
      'mode', null, 'bankReference', null, 'pan', null, 'mobile', null, 'gstIncluded', null,
      'creditNoteFor', null, 'linkedTasks', null, 'crmRecordId', g.id::text),
      jsonb_build_object('branchId', b.id, 'dealId', d.id, 'supplierId', null)
    from public.deal_tally_invoices g
    join public.deals d on d.id = g.deal_id
    join public.branches b on b.id = g.branch_id
    where g.id in (select unnest(p_ids));
  -- Accounts phase 2 (20261204000410): customer documents. The status is in
  -- the hash ids, so a document replaced or cancelled after export reads as
  -- "changed since export".
  elsif p_kind = 'customer_document' then
    return query select cd.id, jsonb_build_object(
      'recordType', case cd.kind when 'advance_invoice' then 'Customer advance invoice'
                                when 'invoice' then 'Customer invoice' else 'Customer credit note' end,
      'voucherType', case cd.kind when 'advance_invoice' then 'Receipt' when 'invoice' then 'Sales' else 'Credit note' end,
      'date', to_char(cd.issue_date, 'YYYY-MM-DD'),
      'reference', cd.number, 'deal', d.reference, 'bitrixDealId', d.source_deal_id::text, 'branch', b.name,
      'party', cd.content #>> '{customer,billingName}',
      'debitLedger', case cd.kind when 'invoice' then 'Customer' when 'credit_note' then 'Sales' else null end,
      'creditLedger', case cd.kind when 'invoice' then 'Sales' when 'credit_note' then 'Customer' else 'Customer advances' end,
      'amount', authz.acct_amount_text(cd.total_paise),
      'mode', null, 'bankReference', null, 'pan', null, 'mobile', null, 'gstIncluded', null,
      'creditNoteFor', (select cc.number from public.customer_documents cc where cc.id = cd.credits_document_id),
      'linkedTasks', null,
      'tallyNumber', g.invoice_ref,
      'crmRecordId', cd.id::text),
      jsonb_build_object('branchId', b.id, 'dealId', d.id, 'supplierId', null, 'status', cd.status)
    from public.customer_documents cd
    join public.deals d on d.id = cd.deal_id
    join public.branches b on b.id = d.branch_id
    left join public.deal_tally_invoices g on g.id = cd.tally_invoice_id
    where cd.id in (select unnest(p_ids));
  elsif p_kind = 'supplier_refund' then
    return query select sr.id, jsonb_build_object(
      'recordType', 'Supplier refund', 'voucherType', 'Receipt',
      'date', to_char(sr.received_on, 'YYYY-MM-DD'),
      'reference', sr.reference, 'deal', d.reference, 'bitrixDealId', d.source_deal_id::text, 'branch', b.name,
      'party', s.name,
      'debitLedger', 'Bank',
      'creditLedger', case when sr.source_kind = 'visa_fee' then 'Expense – Visa fees' else 'Supplier' end,
      'amount', authz.acct_amount_text(sr.amount_paise),
      'mode', authz.tally_supplier_refund_mode(sr.mode), 'bankReference', null,
      'pan', null, 'mobile', null, 'gstIncluded', null, 'creditNoteFor', null, 'linkedTasks', null,
      'crmRecordId', sr.id::text),
      jsonb_build_object('branchId', b.id, 'dealId', d.id, 'supplierId', s.id, 'status', sr.status)
    from public.supplier_refund_receipts sr
    join public.deals d on d.id = sr.deal_id
    join public.branches b on b.id = d.branch_id
    left join public.suppliers s on s.id = sr.supplier_id
    where sr.id in (select unnest(p_ids));
  end if;
end;
$$;

-- ===========================================================================
-- 4. Touch triggers (new hashed tables and columns)
-- ===========================================================================

-- Replaces 20261203000330 (same body plus the phase 2 tables). Aliases of
-- authz.tally_source_set: cd/cc customer_documents, sr supplier_refund_receipts,
-- po customer_refund_payouts, rf customer_refund_requests.
create or replace function authz.tally_touch_source() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_ids uuid[];
  v_entity uuid;
begin
  -- Wait for a running export of the entity (it holds this lock exclusive).
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
      perform authz.tally_touch_kind('supplier_document',
        v_ids || array(select s.id from public.supplier_documents s where s.credits_document_id = any(v_ids)));
    when 'fulfilment_tasks' then
      perform authz.tally_touch_kind('supplier_document',
        array(select s.id from public.supplier_documents s where s.task_id = any(v_ids)));
    when 'department_cost_entries' then
      perform authz.tally_touch_kind('expense', v_ids);
    when 'deal_tally_invoices' then
      perform authz.tally_touch_kind('tally_gst_invoice', v_ids);
      -- Accounts phase 2 (20261204000410): documents that print this GST invoice number.
      perform authz.tally_touch_kind('customer_document',
        array(select x.id from public.customer_documents x where x.tally_invoice_id = any(v_ids)));
    when 'supplier_document_tasks' then
      perform authz.tally_touch_kind('supplier_document',
        array_remove(array[(v_old ->> 'document_id')::uuid, (v_new ->> 'document_id')::uuid], null));
    when 'deals' then
      perform authz.tally_touch_rows(array(select t.id from public.tally_records t
                                           where t.deal_id = any(v_ids) and t.last_export_hash is not null));
    -- Accounts phase 2 (20261204000410)
    when 'customer_documents' then
      -- The document and the credit notes that print its number.
      perform authz.tally_touch_kind('customer_document',
        v_ids || array(select x.id from public.customer_documents x where x.credits_document_id = any(v_ids)));
    when 'supplier_refund_receipts' then
      perform authz.tally_touch_kind('supplier_refund', v_ids);
    when 'customer_refund_payouts' then
      perform authz.tally_touch_kind('journal_entry',
        array(select e.id from public.finance_journal_entries e where e.refund_payout_id = any(v_ids)));
    when 'customer_refund_requests' then
      perform authz.tally_touch_kind('journal_entry',
        array(select e.id from public.customer_refund_payouts po
              join public.finance_journal_entries e on e.refund_payout_id = po.id
              where po.refund_request_id = any(v_ids)));
    else
      null;
  end case;
  return null;
end;
$$;

create trigger customer_documents_tally_touch after update on public.customer_documents
  for each row when (old.status is distinct from new.status or old.number is distinct from new.number
    or old.total_paise is distinct from new.total_paise or old.issue_date is distinct from new.issue_date
    or old.tally_invoice_id is distinct from new.tally_invoice_id or old.credits_document_id is distinct from new.credits_document_id
    or old.kind is distinct from new.kind or old.deal_id is distinct from new.deal_id or old.branch_id is distinct from new.branch_id
    or old.content is distinct from new.content)
  execute function authz.tally_touch_source();
create trigger customer_documents_tally_touch_delete after delete on public.customer_documents
  for each row execute function authz.tally_touch_source();

create trigger supplier_refund_receipts_tally_touch after update on public.supplier_refund_receipts
  for each row when (old.status is distinct from new.status or old.amount_paise is distinct from new.amount_paise
    or old.received_on is distinct from new.received_on or old.mode is distinct from new.mode
    or old.reference is distinct from new.reference or old.supplier_id is distinct from new.supplier_id
    or old.source_kind is distinct from new.source_kind or old.deal_id is distinct from new.deal_id
    or old.branch_id is distinct from new.branch_id)
  execute function authz.tally_touch_source();
create trigger supplier_refund_receipts_tally_touch_delete after delete on public.supplier_refund_receipts
  for each row execute function authz.tally_touch_source();

-- Payouts are append-only (their guard refuses updates); the trigger keeps the coverage rule complete.
create trigger customer_refund_payouts_tally_touch after update on public.customer_refund_payouts
  for each row when (old.mode is distinct from new.mode or old.reference is distinct from new.reference
    or old.refund_request_id is distinct from new.refund_request_id)
  execute function authz.tally_touch_source();
create trigger customer_refund_requests_tally_touch after update on public.customer_refund_requests
  for each row when (old.ref_no is distinct from new.ref_no or old.payee_name is distinct from new.payee_name)
  execute function authz.tally_touch_source();

create trigger finance_journal_entries_tally_touch_refund after update on public.finance_journal_entries
  for each row when (old.refund_payout_id is distinct from new.refund_payout_id)
  execute function authz.tally_touch_source();

-- ===========================================================================
-- 5. Changed since export
-- ===========================================================================

-- Replaces 20261203000340: every kind (authz.tally_kinds()).
create or replace function authz.tally_changed_ids(p_entities uuid[]) returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v uuid[] := array[]::uuid[];
  k text;
  v_ids uuid[];
begin
  foreach k in array authz.tally_kinds() loop  -- Accounts phase 2 (20261204000410)
    select array_agg(t.record_id) into v_ids
    from public.tally_source_touches x
    join public.tally_records t on t.id = x.tally_record_id
    where x.legal_entity_id = any(p_entities) and t.record_kind = k and t.last_export_hash is not null
      and x.touched_at >= t.last_exported_at;
    continue when v_ids is null;
    v := v || coalesce((
      with s as materialized (select * from authz.tally_source_set(k, v_ids))
      select array_agg(t.record_id)
      from public.tally_records t
      join s on s.record_id = t.record_id
      where t.record_kind = k and t.last_export_hash is not null
        and t.last_export_hash <> authz.tally_hash(s.source, s.ids)), array[]::uuid[]);
  end loop;
  return v;
end;
$$;

-- ===========================================================================
-- 6. Service class and mapping row kind (not hashed, LD19)
-- ===========================================================================

-- Per-row service class of a supplier-side row: the task's service purpose,
-- flight split by the task version's trip scope.
create function authz.tally_task_service(p_task uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case t.service_purpose
    when 'flight' then case when v.trip_scope = 'international' then 'flight_international' else 'flight_domestic' end
    else t.service_purpose end
  from public.fulfilment_tasks t
  left join public.booking_versions v on v.id = t.booking_version_id
  where t.id = p_task
$$;

-- The Deal's service class (track B's authz.deal_service_class of the dues basis version).
create function authz.tally_deal_service(p_deal uuid, p_version uuid) returns text
language sql stable security definer set search_path = '' as $$
  select authz.deal_service_class(coalesce(p_version, (select b.version_id from authz.dues_basis(p_deal) b limit 1)))
  where p_deal is not null
$$;

-- Mapping row kind and service class of each record of one kind.
create function authz.tally_service_set(p_kind text, p_ids uuid[]) returns table (record_id uuid, row_kind text, service_class text)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_kind = 'journal_entry' then
    return query
      with e as (select x.id, x.kind, x.deal_id from public.finance_journal_entries x where x.id in (select unnest(p_ids))),
      cls as materialized (select y.deal_id, authz.tally_deal_service(y.deal_id, null) as svc
                           from (select distinct e.deal_id from e where e.deal_id is not null) y)
      select e.id, case when e.kind in ('receipt_bank', 'receipt_cash') then e.kind
                        when e.kind = 'deposit' then 'cash_deposit'
                        when e.kind = 'refund_bank' then 'customer_refund_bank'
                        when e.kind = 'refund_cash' then 'customer_refund_cash'
                        else 'receipt_reversal' end,
             cls.svc
      from e left join cls on cls.deal_id = e.deal_id;
  elsif p_kind = 'supplier_payment' then
    return query select p.id, 'supplier_payment'::text, authz.tally_task_service(p.task_id)
      from public.supplier_payment_requests p where p.id in (select unnest(p_ids));
  elsif p_kind = 'supplier_document' then
    return query select x.id, case when x.kind = 'invoice' then 'supplier_invoice' else 'supplier_credit_note' end,
        authz.tally_task_service(x.task_id)
      from public.supplier_documents x where x.id in (select unnest(p_ids));
  elsif p_kind = 'expense' then
    return query select c.id, 'expense'::text, authz.tally_task_service(c.task_id)
      from public.department_cost_entries c where c.id in (select unnest(p_ids));
  elsif p_kind = 'tally_gst_invoice' then
    return query select g.id, 'tally_gst_invoice'::text, authz.tally_deal_service(g.deal_id, null)
      from public.deal_tally_invoices g where g.id in (select unnest(p_ids));
  elsif p_kind = 'customer_document' then
    return query select x.id, case x.kind when 'advance_invoice' then 'customer_advance_invoice'
                                          when 'invoice' then 'customer_invoice' else 'customer_credit_note' end,
        authz.tally_deal_service(x.deal_id, x.basis_version_id)
      from public.customer_documents x where x.id in (select unnest(p_ids));
  elsif p_kind = 'supplier_refund' then
    return query select x.id, 'supplier_refund'::text,
        authz.tally_task_service(x.task_id)
      from public.supplier_refund_receipts x where x.id in (select unnest(p_ids));
  end if;
end;
$$;

-- The words of the CSV "Service" column.
create function authz.tally_service_word(p text) returns text
language sql immutable set search_path = '' as $$
  select case p when 'hotel' then 'Hotel' when 'transfer' then 'Transfer' when 'activity' then 'Activity'
    when 'flight_domestic' then 'Flight (domestic)' when 'flight_international' then 'Flight (international)'
    when 'package_domestic' then 'Package (domestic)' when 'package_overseas' then 'Package (overseas)'
    when 'visa' then 'Visa' when 'passport' then 'Passport' when 'misc' then 'Miscellaneous' else null end
$$;

-- ===========================================================================
-- 7. Line values (+ narration)
-- ===========================================================================

-- Replaces 20261203000250 (same signature): + narration (Deal ID always
-- present when the row has a Deal; references only, never names).
create or replace function authz.tally_line_values(p_source jsonb, p_export_no text, p_line integer, p_previous timestamptz, p_changed boolean)
returns jsonb
language sql immutable set search_path = '' as $$
  select (p_source - array['pan', 'mobile'])
    || jsonb_build_object(
      'exportNo', p_export_no,
      'line', p_line::text,
      'pan', authz.acct_mask_pan(p_source ->> 'pan'),
      'mobile', authz.acct_mask_mobile(p_source ->> 'mobile'),
      'alreadyExportedOn', case when p_previous is null then null else to_char(timezone('Asia/Kolkata', p_previous), 'YYYY-MM-DD') end,
      'changedSinceLastExport', case when p_changed then 'yes' else 'no' end,
      -- Accounts phase 2 (20261204000410)
      'narration', case when p_source ->> 'deal' is not null
        then 'Deal ' || coalesce(p_source ->> 'bitrixDealId', p_source ->> 'deal') || ' | ' || (p_source ->> 'deal') || ' | '
             || coalesce(p_source ->> 'recordType', '') || coalesce(' ' || (p_source ->> 'reference'), '')
        else coalesce(p_source ->> 'recordType', '') || coalesce(' ' || (p_source ->> 'reference'), '') end)
$$;

-- ===========================================================================
-- 8. Export
-- ===========================================================================

-- Replaces 20261203000350: + customer_document, supplier_refund; mapped
-- columns (not hashed). Locks, temp-table rule and result unchanged.
create or replace function public.accounts_tally_export_create(p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c_kinds constant text[] := authz.tally_kinds();  -- Accounts phase 2 (20261204000410)
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
  v_kind text;
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

  perform authz.tally_entity_lock(v_entity, true);
  drop table if exists pg_temp.tally_export_work;
  create temporary table tally_export_work (
    kind text, id uuid, line integer, branch_id uuid, deal_id uuid, tr_id uuid, prev_at timestamptz, prev_hash text,
    source jsonb, hash text, mapped jsonb) on commit drop;
  insert into pg_temp.tally_export_work (kind, id, line, branch_id, deal_id, tr_id, prev_at, prev_hash)
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
      -- Accounts phase 2 (20261204000410): released documents by issue date;
      -- replaced / cancelled ones only when exported before (then exported state).
      union all
      select 'customer_document', x.id, d.branch_id, tr.status,
             case when x.status = 'released' or tr.last_export_id is not null then 'ready' else 'not_applicable' end,
             d.id, tr.id, tr.last_exported_at, tr.last_export_hash
      from public.customer_documents x
      join public.deals d on d.id = x.deal_id
      left join public.tally_records tr on tr.record_kind = 'customer_document' and tr.record_id = x.id
      where 'customer_document' = any(v_kinds) and x.legal_entity_id = v_entity
        and x.status in ('released', 'replaced', 'cancelled')
        and x.issue_date between v_from and v_to and d.is_synthetic = v_syn
      union all
      select 'supplier_refund', x.id, d.branch_id, tr.status,
             case when x.status = 'verified' or tr.last_export_id is not null then 'ready' else 'not_applicable' end,
             d.id, tr.id, tr.last_exported_at, tr.last_export_hash
      from public.supplier_refund_receipts x
      join public.deals d on d.id = x.deal_id
      left join public.tally_records tr on tr.record_kind = 'supplier_refund' and tr.record_id = x.id
      where 'supplier_refund' = any(v_kinds) and x.legal_entity_id = v_entity
        and x.received_on between v_from and v_to and d.is_synthetic = v_syn
    ) c
  where (v_branches is null or c.branch_id = any(v_branches))
    and (authz.tally_effective(c.computed, c.stored) = 'ready'
         or (v_include and authz.tally_effective(c.computed, c.stored) = 'exported'))
  order by c.kind, c.id
  limit 10001;
  select count(*)::int into v_count from pg_temp.tally_export_work;
  if v_count > 10000 then
    raise exception 'export_too_large' using errcode = '22023', hint = 'from';
  end if;
  if v_count = 0 then
    raise exception 'nothing_to_export' using errcode = '55000';
  end if;
  perform 1 from public.tally_records r where r.id in (select w.tr_id from pg_temp.tally_export_work w where w.tr_id is not null)
  order by r.id for no key update;

  -- Source values and hashes, then the mapped columns: one pass per kind.
  drop table if exists pg_temp.tally_export_src;
  create temporary table tally_export_src (kind text, record_id uuid, source jsonb, ids jsonb, row_kind text, service text)
    on commit drop;
  for v_kind in select distinct w2.kind from pg_temp.tally_export_work w2 loop
    insert into pg_temp.tally_export_src (kind, record_id, source, ids)
    select v_kind, s.record_id, s.source, s.ids
    from authz.tally_source_set(v_kind, array(select w3.id from pg_temp.tally_export_work w3 where w3.kind = v_kind)) s;
    update pg_temp.tally_export_src s set row_kind = x.row_kind, service = x.service_class
    from authz.tally_service_set(v_kind, array(select w3.id from pg_temp.tally_export_work w3 where w3.kind = v_kind)) x
    where s.kind = v_kind and s.record_id = x.record_id;
  end loop;
  -- The mapping is not part of the hash (LD19).
  update pg_temp.tally_export_work w set source = s.source, hash = authz.tally_hash(s.source, s.ids),
    mapped = jsonb_build_object(
      'service', authz.tally_service_word(s.service),
      'tallyDebitLedger', m.debit_ledger,
      'tallyCreditLedger', m.credit_ledger,
      'tallyVoucherType', m.voucher_type,
      'mappingMissing', case when authz.tally_mapping_missing(m.debit_ledger, m.credit_ledger, m.voucher_type) then 'yes' else 'no' end)
  from pg_temp.tally_export_src s
  left join lateral authz.tally_mapping_for(v_entity, s.row_kind, s.service) m on true
  where s.kind = w.kind and s.record_id = w.id;
  select count(*)::int into v_already from pg_temp.tally_export_work w where w.prev_at is not null;

  v_year := extract(year from authz.finance_today())::integer;
  insert into public.tally_export_counters as c (legal_entity_id, year, last_no) values (v_entity, v_year, 1)
  on conflict (legal_entity_id, year) do update set last_no = c.last_no + 1
  returning c.last_no into v_no;
  insert into public.tally_exports (legal_entity_id, export_no, period_from, period_to, kinds, include_exported, branch_ids,
    row_count, created_by, request_id)
  values (v_entity, 'TE-' || v_year::text || '-' || lpad(v_no::text, 6, '0'), v_from, v_to, v_kinds, v_include, v_branches,
    v_count, (select auth.uid()), p_request_id)
  returning * into v_export;

  with ins as (
    insert into public.tally_records (legal_entity_id, branch_id, deal_id, record_kind, record_id, status, export_count,
      last_export_id, last_exported_at, last_export_hash, updated_by)
    select v_entity, w.branch_id, w.deal_id, w.kind, w.id, 'exported', 1, v_export.id, now(), w.hash, (select auth.uid())
    from pg_temp.tally_export_work w where w.tr_id is null
    returning id, record_kind, record_id)
  update pg_temp.tally_export_work w set tr_id = ins.id from ins where ins.record_kind = w.kind and ins.record_id = w.id;
  insert into public.tally_export_lines (export_id, line_no, legal_entity_id, record_kind, record_id, tally_record_id, "values",
    source_hash, previously_exported_at)
  select v_export.id, w.line, v_entity, w.kind, w.id, w.tr_id,
    authz.tally_line_values(w.source || coalesce(w.mapped, '{}'::jsonb), v_export.export_no, w.line, w.prev_at,
      w.prev_hash is not null and w.prev_hash <> w.hash),
    w.hash, w.prev_at
  from pg_temp.tally_export_work w;
  update public.tally_records r
  set status = 'exported', export_count = r.export_count + 1, last_export_id = v_export.id, last_exported_at = now(),
      last_export_hash = w.hash, row_version = r.row_version + 1, updated_at = now(), updated_by = (select auth.uid())
  from pg_temp.tally_export_work w
  where r.id = w.tr_id and r.last_export_id is distinct from v_export.id;

  perform authz.write_audit('accounts.tally_export_created', v_entity, null, 'tally_export', v_export.id, null,
    jsonb_build_object('exportId', v_export.id, 'rowCount', v_count, 'kinds', to_jsonb(v_kinds),
      'alreadyExportedCount', v_already, 'skippedCount', v_skipped));
  v_result := jsonb_build_object('outcome', 'created', 'exportId', v_export.id, 'exportNo', v_export.export_no,
    'rowCount', v_count, 'alreadyExportedCount', v_already, 'skippedCount', v_skipped);
  return authz.finance_remember(v_entity, p_request_id, 'accounts_tally_export_create', v_payload, v_result);
end;
$$;

-- Replaces 20261203000250 (additive): entities[].mappingMissingCount.
create or replace function public.accounts_tally_exports(p_limit integer default 50) returns jsonb
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
                              from public.branches b where b.legal_entity_id = e.id and b.status = 'enabled'), '[]'::jsonb),
        -- Accounts phase 2 (20261204000410)
        'mappingMissingCount', (select count(*)::int from public.tally_ledger_mappings m
                                where m.legal_entity_id = e.id
                                  and authz.tally_mapping_missing(m.debit_ledger, m.credit_ledger, m.voucher_type)))
        order by e.legal_name)
      from public.legal_entities e left join public.accounts_settings s on s.legal_entity_id = e.id
      where e.id = any(v_a)), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(authz.tally_export_json(x.id) order by x.created_at desc, x.id)
                       from (select t.id, t.created_at from public.tally_exports t where t.legal_entity_id = any(v_a)
                             order by t.created_at desc, t.id limit v_limit) x), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- 9. Daily check (contract 13, additive)
-- ===========================================================================

-- Replaces 20261203000310 (additive keys only).
create or replace function public.accounts_daily_check() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_a uuid[];
  v_syn boolean;
  v_today date := authz.finance_today();
  v_owner uuid;
  v_entity uuid;
  v_urgent jsonb := '[]'::jsonb;
  v_changed integer;
  v_docs uuid[];
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  v_a := authz.acct_a_entities();
  v_syn := authz.acct_synthetic();
  if cardinality(v_a) = 0 or v_syn is null then
    return null;
  end if;
  select e.id into v_entity from public.legal_entities e where e.id = any(v_a) order by e.legal_name, e.id limit 1;
  v_owner := authz.acct_exception_owner(v_entity);

  v_changed := cardinality(authz.tally_changed_ids(v_a));

  if to_regclass('public.staff_notices') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object('branchName', g.name, 'count', g.n) order by g.name), '[]'::jsonb)
      from (select b.name, count(*)::int as n
            from public.staff_notices s join public.branches b on b.id = s.branch_id
            where s.legal_entity_id = any($1) and s.priority = 'urgent' and s.done_at is null and s.resolved_at is null
              and authz.finance_add_working_days((timezone('Asia/Kolkata', s.created_at))::date, 1) < $2
            group by b.name) g$q$
    into v_urgent using v_a, v_today;
  end if;
  -- Accounts phase 2 (20261204000410): entities with customer documents on.
  select coalesce(array_agg(s.legal_entity_id), array[]::uuid[]) into v_docs
  from public.accounts_settings s where s.legal_entity_id = any(v_a) and s.customer_documents_enabled;

  return jsonb_build_object(
    'exceptionOwner', jsonb_build_object(
      'userId', v_owner,
      'name', (select p.display_name from public.staff_profiles p where p.user_id = v_owner),
      'isYou', v_owner is not null and v_owner = (select auth.uid()),
      'set', v_owner is not null),
    'exceptionsOpen', (select jsonb_build_object('count', count(*), 'oldestAt', min(t.exception_at))
                       from public.tally_records t where t.legal_entity_id = any(v_a) and t.status = 'exception'),
    'changedAfterExport', v_changed,
    'originalsMissing', (select count(*) from unnest(v_a) e(id) cross join lateral authz.acct_original_items(e.id, null, 'missing') o
                         where o.state = 'missing' and o.is_synthetic = v_syn),
    'receiptsAwaitingVerificationOverOneWorkingDay', (
      select count(*) from public.customer_receipts r join public.deals d on d.id = r.deal_id
      where r.legal_entity_id = any(v_a) and d.is_synthetic = v_syn and r.status = 'recorded'
        and authz.finance_add_working_days((timezone('Asia/Kolkata', r.recorded_at))::date, 1) < v_today),
    'paymentsApprovedNotRecordedOverOneWorkingDay', (
      select count(*) from public.supplier_payment_requests p join public.deals d on d.id = p.deal_id
      where p.legal_entity_id = any(v_a) and d.is_synthetic = v_syn and p.status = 'approved'
        and authz.finance_add_working_days((timezone('Asia/Kolkata', p.approved_at))::date, 1) < v_today),
    'urgentNoticesUnopenedOverOneWorkingDay', v_urgent,
    -- Accounts phase 2 (20261204000410): drafts waiting plus verified payments
    -- without an Advance Invoice (documents switched on).
    'documentsToRelease', (
      (select count(*) from public.customer_documents x join public.deals d on d.id = x.deal_id
       where x.legal_entity_id = any(v_docs) and d.is_synthetic = v_syn and x.status = 'draft')
      + (select count(*) from public.customer_receipts r join public.deals d on d.id = r.deal_id
         where r.legal_entity_id = any(v_docs) and d.is_synthetic = v_syn and r.status in ('verified', 'cleared')
           and not exists (select 1 from public.customer_documents x
                           where x.receipt_id = r.id and x.kind = 'advance_invoice' and x.status in ('draft', 'released')))),
    -- Released documents whose last PDF job failed (no file, nothing queued).
    'pdfFailed', (
      select count(distinct j.document_id) from public.customer_document_render_jobs j
      join public.customer_documents x on x.id = j.document_id
      join public.deals d on d.id = x.deal_id
      where j.legal_entity_id = any(v_a) and d.is_synthetic = v_syn and j.status = 'failed'
        and x.status in ('released', 'replaced', 'cancelled')
        and not exists (select 1 from public.customer_document_files f where f.document_id = j.document_id)
        and not exists (select 1 from public.customer_document_render_jobs q
                        where q.document_id = j.document_id and q.status in ('queued', 'running', 'succeeded'))),
    'refundPayoutsDueOverOneWorkingDay', (
      select count(*) from public.customer_refund_requests q join public.deals d on d.id = q.deal_id
      where q.legal_entity_id = any(v_a) and d.is_synthetic = v_syn and q.status = 'approved' and q.outcome = 'payout'
        and authz.finance_add_working_days((timezone('Asia/Kolkata', q.decided_at))::date, 1) < v_today),
    -- Addendum L1: supplier refunds are verified when recorded; nothing waits for a second person.
    'supplierRefundsToVerify', 0,
    'supplierRefundsDue', (
      select count(*) from public.deal_cancellations c join public.deals d on d.id = c.deal_id
      where c.legal_entity_id = any(v_a) and d.is_synthetic = v_syn and c.status = 'approved'
        and authz.notice_supplier_refund_open(c.id)),
    'filters', jsonb_build_object(
      'exceptionsOpen', jsonb_build_object('tallyStatus', 'exception'),
      'changedAfterExport', jsonb_build_object('changedSinceExport', true),
      'originalsMissing', jsonb_build_object('originals', 'missing'),
      'receiptsAwaitingVerificationOverOneWorkingDay', jsonb_build_object('overdueCheck', 'receipts_unverified'),
      'paymentsApprovedNotRecordedOverOneWorkingDay', jsonb_build_object('overdueCheck', 'payments_unrecorded')));
end;
$$;

-- ===========================================================================
-- 10. Supplier refunds expected vs received (shared with notices 33)
-- ===========================================================================

-- Expected supplier, airline and Visa-fee refunds of one cancellation and
-- whether verified receipts have not yet reached them (track C's
-- authz.supplier_refund_sources: latest revision per refund group).
create function authz.supplier_refunds_expected(p_cancellation uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(s.expected_paise), 0)::bigint
  from public.deal_cancellations c
  cross join lateral authz.supplier_refund_sources(c.deal_id) s
  where c.id = p_cancellation and s.cancellation_id = c.id
$$;

create function authz.notice_supplier_refund_open(p_cancellation uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(s.expected_paise), 0) > 0 and coalesce(sum(s.received_paise), 0) < coalesce(sum(s.expected_paise), 0)
  from public.deal_cancellations c
  cross join lateral authz.supplier_refund_sources(c.deal_id) s
  where c.id = p_cancellation and s.cancellation_id = c.id
$$;

-- ===========================================================================
-- 11. Grants
-- ===========================================================================

revoke all on function authz.tally_kinds(), authz.tally_supplier_refund_mode(text),
  authz.tally_task_service(uuid), authz.tally_deal_service(uuid, uuid), authz.tally_service_set(text, uuid[]),
  authz.tally_service_word(text), authz.supplier_refunds_expected(uuid), authz.notice_supplier_refund_open(uuid)
  from public, anon, authenticated, service_role;

commit;
