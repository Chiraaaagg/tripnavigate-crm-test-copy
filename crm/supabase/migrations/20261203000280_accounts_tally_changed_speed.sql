-- Accounts phase, Track B (9): speed of "changed since export" (contract
-- 6.2.1, 8.1 filter changedSinceExport, 8.2 changedAfterExport; plan 17.3).
--
-- On the speed seed (PGlite) the changedSinceExport filter took about 4 s
-- and the daily check about 8 s: the source hash was computed by a
-- security definer function once per row (each re-reading the record and
-- its Deal, branch and supplier).
--
-- Adds authz.tally_source_set(kind, ids): the canonical CSV source values of
-- many records of one kind in one statement (the same expressions as
-- 20261203000230); authz.tally_source_json now reads from it, so stored
-- hashes keep matching (jsonb output is canonical). authz.tally_changed_ids
-- (entities) returns the records whose source changed after their last
-- export with one pass per kind.
-- Replaced (same signatures): authz.tally_source_json, authz.acct_rows
-- (changedSinceExport predicate only), public.accounts_daily_check
-- (changedAfterExport only).
--
-- Rollback (forward-only): a NEW migration restoring the 20261203000230
-- bodies of the three replaced functions.

begin;
set local lock_timeout = '15s';

create function authz.tally_source_set(p_kind text, p_ids uuid[]) returns table (record_id uuid, source jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_kind = 'journal_entry' then
    return query select e.id, jsonb_build_object(
      'recordType', case when e.kind in ('receipt_bank', 'receipt_cash') then 'Receipt'
                         when e.kind = 'deposit' then 'Cash deposit' else 'Receipt reversal' end,
      'voucherType', case when e.kind in ('receipt_bank', 'receipt_cash') then 'Receipt'
                          when e.kind = 'deposit' then 'Contra' else 'Journal' end,
      'date', to_char(e.business_date, 'YYYY-MM-DD'),
      'reference', r.receipt_no,
      'deal', d.reference,
      'bitrixDealId', d.source_deal_id::text,
      'branch', b.name,
      'party', r.payer_name,
      'debitLedger', (select authz.acct_ledger_word(l.account) from public.finance_journal_lines l
                      where l.entry_id = e.id and l.debit_paise > 0 order by l.id limit 1),
      'creditLedger', (select authz.acct_ledger_word(l.account) from public.finance_journal_lines l
                       where l.entry_id = e.id and l.credit_paise > 0 order by l.id limit 1),
      'amount', authz.acct_amount_text((select sum(l.debit_paise)::bigint from public.finance_journal_lines l where l.entry_id = e.id)),
      'mode', authz.acct_mode_word(case when e.kind = 'deposit' then 'cash' else r.mode end),
      'bankReference', coalesce(r.reference, r.cheque_number, dep.bank_reference),
      'pan', r.payer_pan,
      'mobile', r.payer_mobile,
      'gstIncluded', null, 'creditNoteFor', null, 'linkedTasks', null,
      'crmRecordId', e.id::text)
    from public.finance_journal_entries e
    left join public.customer_receipts r on r.id = e.receipt_id
    left join public.cash_deposits dep on dep.id = e.deposit_id
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
      'crmRecordId', p.id::text)
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
      'crmRecordId', x.id::text)
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
      'crmRecordId', c.id::text)
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
      'creditNoteFor', null, 'linkedTasks', null, 'crmRecordId', g.id::text)
    from public.deal_tally_invoices g
    join public.deals d on d.id = g.deal_id
    join public.branches b on b.id = g.branch_id
    where g.id in (select unnest(p_ids));
  end if;
end;
$$;

-- Replaces 20261203000230: one record through the set-based form (same values).
create or replace function authz.tally_source_json(p_kind text, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select s.source from authz.tally_source_set(p_kind, array[p_id]) s limit 1
$$;

-- Records of the entities whose source changed after their last export.
create function authz.tally_changed_ids(p_entities uuid[]) returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v uuid[] := array[]::uuid[];
  k text;
  v_ids uuid[];
begin
  foreach k in array array['journal_entry', 'supplier_payment', 'supplier_document', 'expense', 'tally_gst_invoice'] loop
    select array_agg(t.record_id) into v_ids from public.tally_records t
    where t.record_kind = k and t.legal_entity_id = any(p_entities) and t.last_export_hash is not null;
    continue when v_ids is null;
    v := v || coalesce((
      select array_agg(t.record_id)
      from public.tally_records t
      join authz.tally_source_set(k, v_ids) s on s.record_id = t.record_id
      where t.record_kind = k and t.last_export_hash is not null
        and t.last_export_hash <> authz.finance_payload_hash(s.source)), array[]::uuid[]);
  end loop;
  return v;
end;
$$;

-- Replaces 20261203000230: changedSinceExport predicate (Accounts phase 20261203000280).
create or replace function authz.acct_rows(p_filter jsonb, p_a uuid[], p_m uuid[], p_syn boolean, p_after text, p_limit integer)
returns setof authz.acct_row
language plpgsql stable security definer set search_path = '' as $$
declare
  c_kinds constant text[] := array['receipt', 'receipt_reversal', 'claim', 'cash_deposit', 'cash_count', 'supplier_payment',
    'company_funding', 'supplier_invoice', 'supplier_credit_note', 'expense', 'flight_ticket_batch', 'visa_application',
    'tally_gst_invoice', 'original'];
  c_min constant uuid := '00000000-0000-0000-0000-000000000000';
  c_max constant uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  v_f jsonb := coalesce(p_filter, '{}'::jsonb);
  v_entities uuid[];
  v_kinds text[];
  v_from date; v_to date; v_dep text; v_sup uuid; v_stage text; v_review text; v_tally text; v_changed boolean;
  v_amin bigint; v_amax bigint; v_branch uuid; v_deals uuid[]; v_orig text;
  v_ad date; v_ac timestamptz; v_ak text; v_ai uuid;
  v_q text; v_qn text; v_digits text;
  q_receipts uuid[]; q_payments uuid[]; q_batches uuid[]; q_docs uuid[]; q_visa uuid[]; q_gst uuid[]; q_deals uuid[];
  v_search boolean := false;
  v_today date := authz.finance_today();
  v_pred text := '';
  v_sql text := '';
  v_parts text[] := array[]::text[];
  v_branch_sql text;
  k text;
  v_lim integer := case when p_limit is null then null else p_limit + 1 end;
  v_changed_ids uuid[] := array[]::uuid[];  -- Accounts phase (20261203000280)
begin
  if jsonb_typeof(v_f) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'filter';
  end if;
  if (v_f - array['from', 'to', 'kinds', 'department', 'dealReference', 'supplierId', 'stage', 'reviewStatus', 'tallyStatus',
                  'changedSinceExport', 'originals', 'amountMin', 'amountMax', 'branchId', 'q']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'filter';
  end if;
  select coalesce(array_agg(distinct x), array[]::uuid[]) into v_entities
  from (select unnest(p_a) as x union select b.legal_entity_id from public.branches b where b.id = any(p_m)) s;

  -- ---- parse ----
  begin
    v_from := authz.finance_date(authz.finance_field(v_f, 'from'));
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'from'; end;
  begin
    v_to := authz.finance_date(authz.finance_field(v_f, 'to'));
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'to'; end;
  if v_from is not null and v_to is not null and v_from > v_to then
    raise exception 'invalid_input' using errcode = '22023', hint = 'to';
  end if;
  if v_f ? 'kinds' and jsonb_typeof(v_f -> 'kinds') <> 'null' then
    if jsonb_typeof(v_f -> 'kinds') <> 'array' or jsonb_array_length(v_f -> 'kinds') = 0
       or exists (select 1 from jsonb_array_elements(v_f -> 'kinds') e
                  where jsonb_typeof(e) <> 'string' or not ((e #>> '{}') = any(c_kinds))) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'kinds';
    end if;
    select array_agg(distinct e) into v_kinds from jsonb_array_elements_text(v_f -> 'kinds') e;
  end if;
  begin
    v_dep := authz.finance_field(v_f, 'department');
    v_stage := authz.finance_field(v_f, 'stage');
    v_review := authz.finance_field(v_f, 'reviewStatus');
    v_tally := authz.finance_field(v_f, 'tallyStatus');
    v_orig := authz.finance_field(v_f, 'originals');
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'filter'; end;
  if v_dep is not null and v_dep not in ('sales', 'accounts', 'purchase', 'flight', 'visa') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'department';
  end if;
  if v_stage is not null and v_stage not in ('open', 'done', 'returned', 'cancelled') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'stage';
  end if;
  if v_review is not null and v_review not in ('waiting', 'done', 'returned', 'not_needed') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reviewStatus';
  end if;
  if v_tally is not null and v_tally not in ('not_ready', 'ready', 'exported', 'matched', 'exception', 'not_applicable') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'tallyStatus';
  end if;
  if v_orig is not null and v_orig not in ('missing', 'expected', 'any') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'originals';
  end if;
  if v_f ? 'changedSinceExport' and jsonb_typeof(v_f -> 'changedSinceExport') <> 'null' then
    if jsonb_typeof(v_f -> 'changedSinceExport') <> 'boolean' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'changedSinceExport';
    end if;
    v_changed := (v_f ->> 'changedSinceExport')::boolean;
  end if;
  begin
    v_amin := authz.finance_paise(v_f, 'amountMin', 0);
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'amountMin'; end;
  begin
    v_amax := authz.finance_paise(v_f, 'amountMax', 0);
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'amountMax'; end;
  if v_amin is not null and v_amax is not null and v_amin > v_amax then
    raise exception 'invalid_input' using errcode = '22023', hint = 'amountMax';
  end if;
  begin
    v_sup := authz.finance_uuid(authz.finance_field(v_f, 'supplierId'));
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'supplierId'; end;
  begin
    v_branch := authz.finance_uuid(authz.finance_field(v_f, 'branchId'));
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'branchId'; end;
  if v_branch is not null and not (v_branch = any(p_m))
     and not exists (select 1 from public.branches b where b.id = v_branch and b.legal_entity_id = any(p_a)) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'branchId';
  end if;
  begin
    v_q := authz.finance_text(authz.finance_field(v_f, 'q'), 1, 60, false);
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'q'; end;
  if authz.finance_field(v_f, 'dealReference') is not null then
    select coalesce(array_agg(d.id), array[]::uuid[]) into v_deals from public.deals d
    where d.legal_entity_id = any(v_entities)
      and d.reference = btrim(authz.finance_field(v_f, 'dealReference'), E' \t\r\n');
  end if;

  -- ---- cursor ----
  if p_after is not null then
    if p_after !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}\|[^|]+\|[a-z_]+\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not (split_part(p_after, '|', 3) = any(c_kinds)) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end if;
    begin
      v_ad := split_part(p_after, '|', 1)::date;
      v_ac := split_part(p_after, '|', 2)::timestamptz;
    exception when others then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end;
    v_ak := split_part(p_after, '|', 3);
    v_ai := split_part(p_after, '|', 4)::uuid;
  end if;

  -- ---- exact search (ignores every other filter except branchId) ----
  if v_q is not null then
    v_search := true;
    v_kinds := null; v_from := null; v_to := null; v_dep := null; v_sup := null; v_stage := null; v_review := null;
    v_tally := null; v_changed := null; v_amin := null; v_amax := null; v_deals := null; v_orig := null;
    v_q := upper(v_q);
    v_qn := authz.sm_number_norm(v_q);
    if v_q ~ '^R-' then
      select coalesce(array_agg(r.id), array[]::uuid[]) into q_receipts from public.customer_receipts r
      where r.legal_entity_id = any(v_entities) and r.receipt_no = v_q;
    end if;
    if v_q ~ '^SP-' then
      select coalesce(array_agg(p.id), array[]::uuid[]) into q_payments from public.supplier_payment_requests p
      where p.legal_entity_id = any(v_entities) and p.ref_no = v_q;
    end if;
    select coalesce(array_agg(d.id), array[]::uuid[]) into q_deals from public.deals d
    where d.legal_entity_id = any(v_entities) and (d.reference = v_q or upper(d.reference) = v_q);
    v_digits := replace(v_q, '-', '');
    if v_q ~ '^[0-9][0-9-]{4,22}[0-9]$' and v_digits ~ '^[0-9]{6,20}$' then
      select coalesce(array_agg(distinct tr.batch_id), array[]::uuid[]) into q_batches
      from public.flight_ticket_numbers n
      join public.flight_ticket_revisions tr on tr.deal_id = n.deal_id and tr.ticket_digits = n.ticket_digits
      where n.legal_entity_id = any(v_entities) and n.ticket_digits = v_digits;
    end if;
    if v_q ~ '^[A-Z0-9]{5,8}$' then
      select coalesce(q_batches, array[]::uuid[]) || coalesce(array_agg(distinct tr.batch_id), array[]::uuid[]) into q_batches
      from public.flight_ticket_revisions tr
      where tr.legal_entity_id = any(v_entities) and (tr.airline_pnr = v_q or tr.crs_pnr = v_q);
    end if;
    if v_qn <> '' then
      select coalesce(array_agg(x.id), array[]::uuid[]) into q_docs from public.supplier_documents x
      where x.legal_entity_id = any(v_entities) and x.number_norm = v_qn;
      select coalesce(array_agg(g.id), array[]::uuid[]) into q_gst from public.deal_tally_invoices g
      where g.legal_entity_id = any(v_entities) and g.ref_norm = v_qn;
    end if;
    select coalesce(array_agg(a.id), array[]::uuid[]) into q_visa from public.visa_applications a
    where a.legal_entity_id = any(v_entities) and a.reference is not null and lower(a.reference) = lower(v_q);
    q_receipts := coalesce(q_receipts, array[]::uuid[]);
    q_payments := coalesce(q_payments, array[]::uuid[]);
    q_batches := coalesce(q_batches, array[]::uuid[]);
  end if;
  if v_orig is not null then
    v_kinds := array['original'];
  end if;

  -- ---- common predicate on the standard columns (alias s) ----
  if v_from is not null then v_pred := v_pred || ' and s.rd >= $4'; end if;
  if v_to is not null then v_pred := v_pred || ' and s.rd <= $5'; end if;
  if v_dep is not null then v_pred := v_pred || ' and s.department = $6'; end if;
  if v_sup is not null then v_pred := v_pred || ' and s.supplier_id = $7'; end if;
  if v_stage is not null then v_pred := v_pred || ' and s.stage = $8'; end if;
  if v_review is not null then v_pred := v_pred || ' and s.review = $9'; end if;
  if v_tally is not null then v_pred := v_pred || ' and s.tally_status = $10'; end if;
  if v_changed is not null then
    -- Accounts phase (20261203000280): one set-based hash pass over the exported rows, not one per scanned row.
    v_changed_ids := authz.tally_changed_ids(v_entities);
    v_pred := v_pred || ' and (s.tally_id is not null and s.tally_id = any($33)) = $11';
  end if;
  if v_amin is not null then v_pred := v_pred || ' and s.amount >= $12'; end if;
  if v_amax is not null then v_pred := v_pred || ' and s.amount <= $13'; end if;
  if v_branch is not null then v_pred := v_pred || ' and (s.branch_id = $14 or s.coll_branch_id = $14)'; end if;
  if v_deals is not null then v_pred := v_pred || ' and s.deal_id = any($15)'; end if;
  if v_orig is not null and v_orig <> 'any' then v_pred := v_pred || ' and s.orig_state = $16'; end if;
  if p_after is not null then
    v_pred := v_pred || ' and (s.rd, s.ca, s.record_id) < ($17, $18, case when s.kind > $19 then $31 when s.kind = $19 then $20 else $32 end)';
  end if;

  -- ---- branches ----
  foreach k in array c_kinds loop
    continue when v_kinds is not null and not (k = any(v_kinds));
    v_branch_sql := case k
    when 'receipt' then $q$
      select 'receipt'::text as kind, r.id as record_id, r.received_on as rd, r.recorded_at as ca, r.legal_entity_id as entity,
        d.branch_id, r.branch_id as coll_branch_id, r.deal_id, 'accounts'::text as department, null::uuid as task_id,
        null::uuid as supplier_id, r.amount_paise as amount, 'in'::text as direction, r.status as status_code,
        case when r.status in ('recorded', 'pending_clearance', 'bounced') then 'open' when r.status in ('verified', 'cleared') then 'done'
             when r.status = 'rejected' then 'returned' else 'cancelled' end as stage,
        case when r.status in ('recorded', 'pending_clearance', 'bounced') then 'waiting' when r.status in ('verified', 'cleared') then 'done'
             when r.status = 'rejected' then 'returned' else 'not_needed' end as review,
        r.receipt_no as reference,
        case when je.id is null then null else 'journal_entry' end as tally_kind, je.id as tally_id,
        case when je.id is not null then coalesce(tr.status, 'ready')
             when r.status in ('recorded', 'pending_clearance', 'bounced') then 'not_ready' else 'not_applicable' end as tally_status,
        null::text as orig_what, null::text as orig_state, null::date as orig_since, null::text as owner_role, null::uuid as owner_user,
        r.legal_entity_id = any($1) as is_a
      from public.customer_receipts r
      join public.deals d on d.id = r.deal_id
      left join public.finance_journal_entries je on je.receipt_id = r.id and je.kind in ('receipt_bank', 'receipt_cash')
      left join public.tally_records tr on tr.record_kind = 'journal_entry' and tr.record_id = je.id
      where r.legal_entity_id = any($30) and d.is_synthetic = $3
        and (r.legal_entity_id = any($1) or d.branch_id = any($2) or r.branch_id = any($2))$q$
      || case when v_search then ' and (r.id = any($22) or r.deal_id = any($28))' else '' end
    when 'receipt_reversal' then $q$
      select 'receipt_reversal'::text, e.id, e.business_date, e.posted_at, e.legal_entity_id,
        d.branch_id, e.branch_id, e.deal_id, 'accounts'::text, null::uuid, null::uuid,
        (select sum(l.debit_paise)::bigint from public.finance_journal_lines l where l.entry_id = e.id), 'out'::text, e.kind,
        'done'::text, 'not_needed'::text, r.receipt_no,
        'journal_entry'::text, e.id, coalesce(tr.status, 'ready'),
        null::text, null::text, null::date, null::text, null::uuid, e.legal_entity_id = any($1)
      from public.finance_journal_entries e
      join public.customer_receipts r on r.id = e.receipt_id
      join public.deals d on d.id = e.deal_id
      left join public.tally_records tr on tr.record_kind = 'journal_entry' and tr.record_id = e.id
      where e.kind like 'reversal%' and e.legal_entity_id = any($30) and d.is_synthetic = $3
        and (e.legal_entity_id = any($1) or d.branch_id = any($2) or e.branch_id = any($2))$q$
      || case when v_search then ' and (e.receipt_id = any($22) or e.deal_id = any($28))' else '' end
    when 'claim' then $q$
      select 'claim'::text, c.id, c.paid_on, c.reported_at, c.legal_entity_id,
        d.branch_id, null::uuid, c.deal_id, 'sales'::text, null::uuid, null::uuid, c.amount_paise, 'info'::text, c.status,
        case c.status when 'reported' then 'open' when 'linked' then 'done' when 'not_received' then 'returned' else 'cancelled' end,
        case c.status when 'reported' then 'waiting' when 'linked' then 'done' when 'not_received' then 'returned' else 'not_needed' end,
        null::text, null::text, null::uuid, 'not_applicable'::text,
        null::text, null::text, null::date, null::text, null::uuid, c.legal_entity_id = any($1)
      from public.customer_payment_claims c
      join public.deals d on d.id = c.deal_id
      where c.legal_entity_id = any($30) and d.is_synthetic = $3
        and (c.legal_entity_id = any($1) or d.branch_id = any($2))$q$
      || case when v_search then ' and c.deal_id = any($28)' else '' end
    when 'cash_deposit' then $q$
      select 'cash_deposit'::text, x.id, x.deposited_on, x.recorded_at, x.legal_entity_id,
        x.branch_id, null::uuid, null::uuid, 'accounts'::text, null::uuid, null::uuid, x.total_paise, 'contra'::text, x.status,
        case x.status when 'recorded' then 'open' when 'verified' then 'done' else 'returned' end,
        case x.status when 'recorded' then 'waiting' when 'verified' then 'done' else 'returned' end,
        x.bank_reference,
        case when je.id is null then null else 'journal_entry' end, je.id,
        case when je.id is not null then coalesce(tr.status, 'ready') when x.status = 'recorded' then 'not_ready' else 'not_applicable' end,
        null::text, null::text, null::date, null::text, null::uuid, x.legal_entity_id = any($1)
      from public.cash_deposits x
      left join public.finance_journal_entries je on je.deposit_id = x.id and je.kind = 'deposit'
      left join public.tally_records tr on tr.record_kind = 'journal_entry' and tr.record_id = je.id
      where x.legal_entity_id = any($30)
        and (x.legal_entity_id = any($1) or x.branch_id = any($2))$q$
      || case when v_search then ' and false' else '' end
    when 'cash_count' then $q$
      select 'cash_count'::text, x.id, x.business_date, x.recorded_at, x.legal_entity_id,
        x.branch_id, null::uuid, null::uuid, 'accounts'::text, null::uuid, null::uuid, x.counted_paise, 'info'::text, x.status,
        case x.status when 'recorded' then 'open' else 'done' end,
        case x.status when 'recorded' then 'waiting' else 'done' end,
        null::text, null::text, null::uuid, 'not_applicable'::text,
        null::text, null::text, null::date, null::text, null::uuid, x.legal_entity_id = any($1)
      from public.cash_reconciliations x
      where x.legal_entity_id = any($30)
        and (x.legal_entity_id = any($1) or x.branch_id = any($2))$q$
      || case when v_search then ' and false' else '' end
    when 'supplier_payment' then $q$
      select 'supplier_payment'::text, p.id, (timezone('Asia/Kolkata', p.requested_at))::date, p.requested_at, p.legal_entity_id,
        d.branch_id, null::uuid, p.deal_id, t.department, p.task_id, p.supplier_id, p.amount_paise, 'out'::text, p.status,
        case when p.status in ('pending', 'approved', 'paid') then 'open' when p.status = 'verified' then 'done'
             when p.status = 'returned' then 'returned' else 'cancelled' end,
        case when p.status in ('pending', 'approved', 'paid') then 'waiting' when p.status = 'verified' then 'done'
             when p.status = 'returned' then 'returned' else 'not_needed' end,
        p.ref_no, 'supplier_payment'::text, p.id,
        case when p.status in ('returned', 'cancelled') then 'not_applicable'
             else coalesce(tr.status, case when p.status = 'verified' then 'ready' else 'not_ready' end) end,
        null::text, null::text, null::date, null::text, null::uuid, p.legal_entity_id = any($1)
      from public.supplier_payment_requests p
      join public.deals d on d.id = p.deal_id
      join public.fulfilment_tasks t on t.id = p.task_id
      left join public.tally_records tr on tr.record_kind = 'supplier_payment' and tr.record_id = p.id
      where p.legal_entity_id = any($30) and d.is_synthetic = $3
        and (p.legal_entity_id = any($1) or d.branch_id = any($2))$q$
      || case when v_search then ' and (p.id = any($23) or p.deal_id = any($28))' else '' end
    when 'company_funding' then $q$
      select 'company_funding'::text, f.id, (timezone('Asia/Kolkata', f.requested_at))::date, f.requested_at, f.legal_entity_id,
        d.branch_id, null::uuid, f.deal_id, t.department, p.task_id, p.supplier_id, f.amount_paise, 'info'::text, f.status,
        case f.status when 'pending' then 'open' when 'approved' then 'open' when 'recovered' then 'done' else 'returned' end,
        case f.status when 'pending' then 'waiting' when 'returned' then 'returned' else 'done' end,
        p.ref_no, null::text, null::uuid, 'not_applicable'::text,
        null::text, null::text, null::date, null::text, null::uuid, f.legal_entity_id = any($1)
      from public.company_funding_requests f
      join public.supplier_payment_requests p on p.id = f.payment_request_id
      join public.deals d on d.id = f.deal_id
      join public.fulfilment_tasks t on t.id = p.task_id
      where f.legal_entity_id = any($30) and d.is_synthetic = $3
        and (f.legal_entity_id = any($1) or d.branch_id = any($2))$q$
      || case when v_search then ' and (f.payment_request_id = any($23) or f.deal_id = any($28))' else '' end
    when 'supplier_invoice' then $q$
      select 'supplier_invoice'::text, x.id, x.doc_date, x.uploaded_at, x.legal_entity_id,
        d.branch_id, null::uuid, x.deal_id, t.department, x.task_id, x.supplier_id, x.total_paise, 'bill'::text, x.status,
        case x.status when 'uploaded' then 'open' when 'accepted' then 'done' else 'returned' end,
        case x.status when 'uploaded' then 'waiting' when 'accepted' then 'done' else 'returned' end,
        x.number, 'supplier_document'::text, x.id,
        case when x.status = 'returned' then 'not_applicable'
             else coalesce(tr.status, case when x.status = 'accepted' then 'ready' else 'not_ready' end) end,
        null::text, null::text, null::date, null::text, null::uuid, x.legal_entity_id = any($1)
      from public.supplier_documents x
      join public.deals d on d.id = x.deal_id
      join public.fulfilment_tasks t on t.id = x.task_id
      left join public.tally_records tr on tr.record_kind = 'supplier_document' and tr.record_id = x.id
      where x.kind = 'invoice' and x.legal_entity_id = any($30) and d.is_synthetic = $3
        and (x.legal_entity_id = any($1) or d.branch_id = any($2))$q$
      || case when v_search then ' and (x.id = any($25) or x.deal_id = any($28))' else '' end
    when 'supplier_credit_note' then $q$
      select 'supplier_credit_note'::text, x.id, x.doc_date, x.uploaded_at, x.legal_entity_id,
        d.branch_id, null::uuid, x.deal_id, t.department, x.task_id, x.supplier_id, x.total_paise, 'credit'::text, x.status,
        case x.status when 'uploaded' then 'open' when 'accepted' then 'done' else 'returned' end,
        case x.status when 'uploaded' then 'waiting' when 'accepted' then 'done' else 'returned' end,
        x.number, 'supplier_document'::text, x.id,
        case when x.status = 'returned' then 'not_applicable'
             else coalesce(tr.status, case when x.status = 'accepted' then 'ready' else 'not_ready' end) end,
        null::text, null::text, null::date, null::text, null::uuid, x.legal_entity_id = any($1)
      from public.supplier_documents x
      join public.deals d on d.id = x.deal_id
      join public.fulfilment_tasks t on t.id = x.task_id
      left join public.tally_records tr on tr.record_kind = 'supplier_document' and tr.record_id = x.id
      where x.kind = 'credit_note' and x.legal_entity_id = any($30) and d.is_synthetic = $3
        and (x.legal_entity_id = any($1) or d.branch_id = any($2))$q$
      || case when v_search then ' and (x.id = any($25) or x.deal_id = any($28))' else '' end
    when 'expense' then $q$
      select 'expense'::text, c.id, coalesce(c.paid_on, (timezone('Asia/Kolkata', c.created_at))::date), c.created_at, c.legal_entity_id,
        d.branch_id, null::uuid, c.deal_id, c.department, c.task_id, c.supplier_id, c.amount_paise, 'out'::text, c.expense_status,
        case c.expense_status when 'accepted' then 'done' when 'returned' then 'returned' else 'open' end,
        case c.expense_status when 'submitted' then 'waiting' when 'accepted' then 'done' when 'returned' then 'returned' else 'not_needed' end,
        c.reference, 'expense'::text, c.id,
        coalesce(tr.status, case when c.expense_status = 'accepted' then 'ready' else 'not_ready' end),
        null::text, null::text, null::date, null::text, null::uuid, c.legal_entity_id = any($1)
      from public.department_cost_entries c
      join public.deals d on d.id = c.deal_id
      left join public.tally_records tr on tr.record_kind = 'expense' and tr.record_id = c.id
      where c.paid_by = 'company' and c.legal_entity_id = any($30) and d.is_synthetic = $3
        and not (c.department = 'visa' and c.expense_status = 'draft' and c.receipt_evidence_id is null)
        and (c.legal_entity_id = any($1) or d.branch_id = any($2))$q$
      || case when v_search then ' and c.deal_id = any($28)' else '' end
    when 'flight_ticket_batch' then $q$
      select 'flight_ticket_batch'::text, b.id, (timezone('Asia/Kolkata', b.confirmed_at))::date, b.confirmed_at, b.legal_entity_id,
        d.branch_id, null::uuid, b.deal_id, 'flight'::text, b.cost_task_id, b.supplier_id, b.supplier_cost_paise, 'info'::text,
        'confirmed'::text, 'done'::text, 'not_needed'::text,
        d.reference || ' batch ' || b.batch_no::text, null::text, null::uuid, 'not_applicable'::text,
        null::text, null::text, null::date, null::text, null::uuid, b.legal_entity_id = any($1)
      from public.flight_ticket_batches b
      join public.deals d on d.id = b.deal_id
      where b.legal_entity_id = any($30) and d.is_synthetic = $3
        and (b.legal_entity_id = any($1) or d.branch_id = any($2))$q$
      || case when v_search then ' and (b.id = any($24) or b.deal_id = any($28))' else '' end
    when 'visa_application' then $q$
      select 'visa_application'::text, a.id, coalesce(a.applied_on, (timezone('Asia/Kolkata', a.submitted_at))::date), a.submitted_at,
        a.legal_entity_id, d.branch_id, null::uuid, a.deal_id, 'visa'::text, a.task_id, null::uuid, null::bigint, 'info'::text, a.state,
        case when a.state in ('issued', 'refused') then 'done' when a.state = 'withdrawn' then 'cancelled' else 'open' end,
        'not_needed'::text, a.reference, null::text, null::uuid, 'not_applicable'::text,
        null::text, null::text, null::date, null::text, null::uuid, a.legal_entity_id = any($1)
      from public.visa_applications a
      join public.deals d on d.id = a.deal_id
      where a.submitted_at is not null and a.legal_entity_id = any($30) and d.is_synthetic = $3
        and (a.legal_entity_id = any($1) or d.branch_id = any($2))$q$
      || case when v_search then ' and (a.id = any($26) or a.deal_id = any($28))' else '' end
    when 'tally_gst_invoice' then $q$
      select 'tally_gst_invoice'::text, g.id, g.invoice_date, g.created_at, g.legal_entity_id,
        g.branch_id, null::uuid, g.deal_id, 'accounts'::text, null::uuid, null::uuid, null::bigint, 'info'::text, g.status,
        case g.status when 'active' then 'done' else 'cancelled' end, 'not_needed'::text,
        g.invoice_ref, 'tally_gst_invoice'::text, g.id,
        case when g.status = 'withdrawn' then 'not_applicable' else coalesce(tr.status, 'matched') end,
        null::text, null::text, null::date, null::text, null::uuid, g.legal_entity_id = any($1)
      from public.deal_tally_invoices g
      join public.deals d on d.id = g.deal_id
      left join public.tally_records tr on tr.record_kind = 'tally_gst_invoice' and tr.record_id = g.id
      where g.legal_entity_id = any($30) and d.is_synthetic = $3
        and (g.legal_entity_id = any($1) or g.branch_id = any($2))$q$
      || case when v_search then ' and (g.id = any($27) or g.deal_id = any($28))' else '' end
    when 'original' then $q$
      select 'original'::text, o.record_id, o.since, (o.since::timestamp at time zone 'Asia/Kolkata'), e.id,
        o.branch_id, null::uuid, o.deal_id, o.department, o.task_id, o.supplier_id, null::bigint, 'info'::text, o.state,
        'open'::text, 'not_needed'::text,
        case when o.what = 'bank_proof' then (select r.receipt_no from public.customer_receipts r where r.id = o.record_id)
             else (select d.reference from public.deals d where d.id = o.deal_id) end,
        null::text, null::uuid, 'not_applicable'::text,
        o.what, o.state, o.since, o.owner_role, o.owner_user_id, e.id = any($1)
      from unnest($30) e(id)
      cross join lateral authz.acct_original_items(e.id) o
      where o.is_synthetic = $3 and (e.id = any($1) or o.branch_id = any($2))$q$
      || case when v_search then ' and (o.deal_id = any($28) or (o.what = ''bank_proof'' and o.record_id = any($22)))' else '' end
    end;
    v_parts := v_parts || format('(select s.* from (%s) s(kind, record_id, rd, ca, entity, branch_id, coll_branch_id, deal_id,'
      || ' department, task_id, supplier_id, amount, direction, status_code, stage, review, reference, tally_kind, tally_id,'
      || ' tally_status, orig_what, orig_state, orig_since, owner_role, owner_user, is_a)'
      || ' where true%s order by s.rd desc, s.ca desc, s.record_id desc limit $21)', v_branch_sql, v_pred);
  end loop;

  if cardinality(v_parts) = 0 or cardinality(v_entities) = 0 or p_syn is null then
    return;
  end if;
  v_sql := 'select u.kind, u.record_id, u.rd, u.ca, u.entity, u.branch_id, u.coll_branch_id, u.deal_id, u.department, u.task_id,'
    || ' u.supplier_id, u.amount, u.direction, u.status_code, u.stage, u.review, u.reference, u.tally_kind, u.tally_id,'
    || ' u.tally_status, u.orig_what, u.orig_state, u.orig_since, u.owner_role, u.owner_user, u.is_a from ('
    || array_to_string(v_parts, ' union all ')
    || ') u order by u.rd desc, u.ca desc, u.kind asc, u.record_id desc limit $21';
  return query execute v_sql
    using p_a, p_m, p_syn, v_from, v_to, v_dep, v_sup, v_stage, v_review, v_tally, v_changed, v_amin, v_amax, v_branch,
          v_deals, v_orig, v_ad, v_ac, v_ak, v_ai, v_lim,
          q_receipts, q_payments, q_batches, q_docs, q_visa, q_gst, q_deals, v_today, v_entities, c_max, c_min, v_changed_ids;
end;
$$;

-- Replaces 20261203000230: changedAfterExport (Accounts phase 20261203000280).
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

  -- Accounts phase (20261203000280): set-based hash pass.
  v_changed := cardinality(authz.tally_changed_ids(v_a));

  -- Track C's notice table (20261203000400..0499) may not exist yet.
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

  return jsonb_build_object(
    'exceptionOwner', jsonb_build_object(
      'userId', v_owner,
      'name', (select p.display_name from public.staff_profiles p where p.user_id = v_owner),
      'isYou', v_owner is not null and v_owner = (select auth.uid()),
      'set', v_owner is not null),
    'exceptionsOpen', (select jsonb_build_object('count', count(*), 'oldestAt', min(t.exception_at))
                       from public.tally_records t where t.legal_entity_id = any(v_a) and t.status = 'exception'),
    'changedAfterExport', v_changed,
    'originalsMissing', (select count(*) from unnest(v_a) e(id) cross join lateral authz.acct_original_items(e.id) o
                         where o.state = 'missing' and o.is_synthetic = v_syn),
    'receiptsAwaitingVerificationOverOneWorkingDay', (
      select count(*) from public.customer_receipts r join public.deals d on d.id = r.deal_id
      where r.legal_entity_id = any(v_a) and d.is_synthetic = v_syn and r.status = 'recorded'
        and authz.finance_add_working_days((timezone('Asia/Kolkata', r.recorded_at))::date, 1) < v_today),
    'paymentsApprovedNotRecordedOverOneWorkingDay', (
      select count(*) from public.supplier_payment_requests p join public.deals d on d.id = p.deal_id
      where p.legal_entity_id = any(v_a) and d.is_synthetic = v_syn and p.status = 'approved'
        and authz.finance_add_working_days((timezone('Asia/Kolkata', p.approved_at))::date, 1) < v_today),
    'urgentNoticesUnopenedOverOneWorkingDay', v_urgent);
end;
$$;

revoke all on function authz.tally_source_set(text, uuid[]), authz.tally_changed_ids(uuid[])
  from public, anon, authenticated, service_role;

commit;
