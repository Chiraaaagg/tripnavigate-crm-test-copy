-- Accounts phase, Track B (13): "changed since export" no longer relies on
-- which source columns are immutable (lead safety change on 0310).
--
-- Every table and column that authz.tally_source_set reads into the hash
-- now writes a touch (public.tally_source_touches) when it changes (IS
-- DISTINCT FROM) or its row is deleted. Row-level AFTER triggers with WHEN
-- clauses, so an update that changes no hashed column costs nothing (status
-- moves, reviews and payments never fire them). A touch only nominates a
-- record; changedSinceExport still compares the stored and current hash.
--
-- Hashed inputs covered (source alias in tally_source_set -> table: columns):
--   e  finance_journal_entries: kind, business_date, receipt_id, deposit_id, deal_id, branch_id
--   l  finance_journal_lines: account, debit_paise, credit_paise, entry_id
--   r  customer_receipts: receipt_no, payer_name, mode, reference, cheque_number, payer_pan, payer_mobile
--   dep cash_deposits: bank_reference
--   d  deals: branch_id, source_deal_id (trigger from 20261203000310) + delete
--   p  supplier_payment_requests: paid_on, ref_no, amount_paise, payment_mode, bank_reference, deal_id, supplier_id
--   x/c supplier_documents: kind, doc_date, number, total_paise, gst_included, credits_document_id, deal_id,
--      supplier_id, task_id (a credited invoice's number also touches its credit notes)
--   l  supplier_document_tasks: insert, update, delete (trigger from 20261203000310 + delete)
--   t  fulfilment_tasks: department
--   c  department_cost_entries: paid_on, created_at, department, payment_mode, amount_paise, reference,
--      supplier_id, deal_id
--   g  deal_tally_invoices: invoice_date, invoice_ref, deal_id, branch_id
-- Not hashed (no trigger): branches and suppliers (ids only; names are not
-- in the hash), deals.reference.
-- crm/tests/db/acc-b-touch.test.ts checks that every alias.column the hash
-- reads is covered by one of these triggers and that direct changes flag the
-- record.
--
-- Rollback (forward-only): a NEW migration dropping the triggers below.

begin;
set local lock_timeout = '15s';

-- Touch the exported Tally records of one kind.
create function authz.tally_touch_kind(p_kind text, p_ids uuid[]) returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.tally_source_touches (tally_record_id, legal_entity_id, touched_at)
  select t.id, t.legal_entity_id, clock_timestamp() from public.tally_records t
  where t.record_kind = p_kind and t.record_id = any(p_ids) and t.last_export_hash is not null
  on conflict (tally_record_id) do update set touched_at = excluded.touched_at
$$;

create function authz.tally_touch_source() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_ids uuid[];
begin
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

create trigger finance_journal_entries_tally_touch after update on public.finance_journal_entries
  for each row when (old.kind is distinct from new.kind or old.business_date is distinct from new.business_date
    or old.receipt_id is distinct from new.receipt_id or old.deposit_id is distinct from new.deposit_id
    or old.deal_id is distinct from new.deal_id or old.branch_id is distinct from new.branch_id)
  execute function authz.tally_touch_source();
create trigger finance_journal_entries_tally_touch_delete after delete on public.finance_journal_entries
  for each row execute function authz.tally_touch_source();

create trigger finance_journal_lines_tally_touch after update on public.finance_journal_lines
  for each row when (old.account is distinct from new.account or old.debit_paise is distinct from new.debit_paise
    or old.credit_paise is distinct from new.credit_paise or old.entry_id is distinct from new.entry_id)
  execute function authz.tally_touch_source();
create trigger finance_journal_lines_tally_touch_delete after delete on public.finance_journal_lines
  for each row execute function authz.tally_touch_source();

create trigger customer_receipts_tally_touch after update on public.customer_receipts
  for each row when (old.receipt_no is distinct from new.receipt_no or old.payer_name is distinct from new.payer_name
    or old.mode is distinct from new.mode or old.reference is distinct from new.reference
    or old.cheque_number is distinct from new.cheque_number or old.payer_pan is distinct from new.payer_pan
    or old.payer_mobile is distinct from new.payer_mobile)
  execute function authz.tally_touch_source();
create trigger customer_receipts_tally_touch_delete after delete on public.customer_receipts
  for each row execute function authz.tally_touch_source();

create trigger cash_deposits_tally_touch after update on public.cash_deposits
  for each row when (old.bank_reference is distinct from new.bank_reference)
  execute function authz.tally_touch_source();
create trigger cash_deposits_tally_touch_delete after delete on public.cash_deposits
  for each row execute function authz.tally_touch_source();

create trigger supplier_payment_requests_tally_touch after update on public.supplier_payment_requests
  for each row when (old.paid_on is distinct from new.paid_on or old.ref_no is distinct from new.ref_no
    or old.amount_paise is distinct from new.amount_paise or old.payment_mode is distinct from new.payment_mode
    or old.bank_reference is distinct from new.bank_reference or old.deal_id is distinct from new.deal_id
    or old.supplier_id is distinct from new.supplier_id)
  execute function authz.tally_touch_source();
create trigger supplier_payment_requests_tally_touch_delete after delete on public.supplier_payment_requests
  for each row execute function authz.tally_touch_source();

-- Replaces the credits_document_id-only trigger of 20261203000310.
drop trigger supplier_documents_tally_touch on public.supplier_documents;
create trigger supplier_documents_tally_touch after update on public.supplier_documents
  for each row when (old.kind is distinct from new.kind or old.doc_date is distinct from new.doc_date
    or old.number is distinct from new.number or old.total_paise is distinct from new.total_paise
    or old.gst_included is distinct from new.gst_included or old.credits_document_id is distinct from new.credits_document_id
    or old.deal_id is distinct from new.deal_id or old.supplier_id is distinct from new.supplier_id
    or old.task_id is distinct from new.task_id)
  execute function authz.tally_touch_source();
create trigger supplier_documents_tally_touch_delete after delete on public.supplier_documents
  for each row execute function authz.tally_touch_source();

create trigger supplier_document_tasks_tally_touch_delete after delete on public.supplier_document_tasks
  for each row execute function authz.tally_touch_source();

create trigger fulfilment_tasks_tally_touch after update on public.fulfilment_tasks
  for each row when (old.department is distinct from new.department)
  execute function authz.tally_touch_source();

create trigger department_cost_entries_tally_touch after update on public.department_cost_entries
  for each row when (old.paid_on is distinct from new.paid_on or old.created_at is distinct from new.created_at
    or old.department is distinct from new.department or old.payment_mode is distinct from new.payment_mode
    or old.amount_paise is distinct from new.amount_paise or old.reference is distinct from new.reference
    or old.supplier_id is distinct from new.supplier_id or old.deal_id is distinct from new.deal_id)
  execute function authz.tally_touch_source();
create trigger department_cost_entries_tally_touch_delete after delete on public.department_cost_entries
  for each row execute function authz.tally_touch_source();

create trigger deal_tally_invoices_tally_touch after update on public.deal_tally_invoices
  for each row when (old.invoice_date is distinct from new.invoice_date or old.invoice_ref is distinct from new.invoice_ref
    or old.deal_id is distinct from new.deal_id or old.branch_id is distinct from new.branch_id)
  execute function authz.tally_touch_source();
create trigger deal_tally_invoices_tally_touch_delete after delete on public.deal_tally_invoices
  for each row execute function authz.tally_touch_source();

create trigger deals_tally_touch_delete after delete on public.deals
  for each row execute function authz.tally_touch_source();

revoke all on function authz.tally_touch_kind(text, uuid[]), authz.tally_touch_source()
  from public, anon, authenticated, service_role;

commit;
