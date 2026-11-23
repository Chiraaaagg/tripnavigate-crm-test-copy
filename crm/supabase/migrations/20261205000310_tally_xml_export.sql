-- TripNavigate CRM - Accounts phase 3, track C (2 of 3): the Tally import file.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 7.1, 7.3, 7.4
-- (reads R-C1..R-C3), 13, 14, 17.1, 17.3, 21 LD17, LD18.
-- Owner rules: money vouchers only (receipts, deposits, customer refunds,
-- verified supplier payments, verified supplier refunds, approved
-- write-offs); never customer or supplier documents or GST invoice
-- references (DEC-22). A record goes in only when its voucher type, every
-- ledger the mapping gives and the party ledger are named: the file never
-- invents a ledger (LD18). The CRM never contacts Tally; the XML text is made
-- by the app from the frozen lines (S/modules/accounts-desk/tally-xml.ts).
--
-- What this file adds:
--   authz.tally_file_candidates(entity, from, to, kinds, branches, include_again, synthetic)
--     every record of the period with its verdict: 'line' or a left-out reason
--     (kind_not_in_file > already_in_file / changed_since_file >
--     voucher_type_missing > ledger_not_mapped > party_not_mapped) and, for
--     lines, the ledgers of the frozen voucher. Set-based (one call of
--     tally_source_set / tally_service_set per kind; no per-row definer call).
--     Vouchers per kind (party ledger = the Tally name of the Deal's billing
--     party, or of the supplier):
--       receipt_bank / receipt_cash   Dr mapping debit (bank / cash)   Cr customer
--       deposit (Contra)              Dr mapping debit (bank)          Cr mapping credit (cash)
--       refund_bank / refund_cash     Dr customer                      Cr mapping credit (bank / cash)
--       supplier_payment              Dr supplier                      Cr mapping credit (bank)
--       supplier_refund               Dr mapping debit (bank)          Cr supplier
--       write_off due (Journal)       Dr mapping debit (write-off)     Cr customer
--       write_off excess (Journal)    Dr customer                      Cr mapping credit (write-off)
--     Receipt reversals and company-paid expenses: kind_not_in_file.
--     A record already in an XML file: already_in_file (unchanged) or
--     changed_since_file (changed, or no longer live), unless included again
--     with a reason (live and still only exported). Matched or excepted
--     records never go in again.
--   C3 public.accounts_tally_file_create(p_entity, p_from, p_to, p_kinds,
--      p_branch_ids, p_include_again, p_include_reason, p_request_id)  A
--      tally_xml_off when the switch is off; Tally entity lock exclusive first
--      (never a source row lock); a tally_exports row (format 'xml', next TE-
--      number, company name frozen), tally_export_lines (CSV columns of the
--      evidence pack with the party ledger as party and no PAN / mobile,
--      + recordKind, amountPaise, partyLedger, entries and the frozen
--      voucher the XML is written from; narration
--      "Deal <Bitrix Deal ID or CRM reference> | <CRM Deal reference> |
--      <record type> <CRM reference> | TN:<export_no>/<line_no>"), the
--      left-out rows; included records become exported (never matched) with
--      xml_export_id / xml_exported_at / xml_line_no. nothing_to_export (hint
--      leftOut=<n>) when no line is included; export_too_large over 10,000.
--      Audit accounts.tally_file.created {exportId, lines, leftOut, kinds,
--      includeAgain} (the include-again reason in the reason column).
--   R-C1 public.accounts_tally_exports (replace 20261204000410:824, additive):
--      items gain format, leftOutCount, includeReason (and fileName
--      TE-....xml for XML files); entities gain xmlEnabled.
--   R-C2 public.accounts_tally_file_preview(p_entity, p_from, p_to, p_kinds,
--      p_branch_ids)  A; else null. Not audited. First 200 lines / left-out
--      rows, full counts, truncated flag.
--   R-C3 public.accounts_tally_export_left_out(p_export_id, p_after, p_limit)  A; else null.
--   public.accounts_tally_file_download_log(p_export_id)  A; one audit row
--      accounts.tally_file.downloaded {exportId, lines} per download; returns
--      the header with the frozen company name. Lines are read with the
--      existing accounts_tally_export_lines.
--
-- Refusal tokens: tally_xml_off (55000), nothing_to_export (55000),
-- export_too_large (22023), invalid_input (22023, hint = field),
-- not_authorized (42501), not_found (P0002), request_conflict (40001).
-- Rollback (forward-only): a NEW migration restoring accounts_tally_exports
-- (20261204000410) and revoking the new functions. Never delete files, lines
-- or left-out rows.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Arguments
-- ===========================================================================

-- Kinds a Tally file may be asked for (7.1). Expenses are accepted only to be
-- listed as kind_not_in_file.
create function authz.tally_file_kinds() returns text[]
language sql immutable set search_path = '' as $$
  select array['journal_entry', 'supplier_payment', 'supplier_refund', 'write_off', 'expense']
$$;

-- Validates the period, kinds and branches of a file or preview; returns the
-- sorted distinct kinds and the branch list (null = every branch).
create function authz.tally_file_args(p_entity uuid, p_from date, p_to date, p_kinds text[], p_branch_ids uuid[])
returns table (kinds text[], branches uuid[])
language plpgsql stable security definer set search_path = '' as $$
declare
  v_kinds text[];
  v_branches uuid[];
begin
  if p_from is null or p_from < date '2000-01-01' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'from';
  end if;
  -- No 366-day cap for a Tally file (bounded by 10,000 lines).
  if p_to is null or p_to < p_from or p_to > authz.finance_today() then
    raise exception 'invalid_input' using errcode = '22023', hint = 'to';
  end if;
  -- null = every kind a file may be asked for.
  if p_kinds is not null and (cardinality(p_kinds) = 0 or array_position(p_kinds, null) is not null
     or not (p_kinds <@ authz.tally_file_kinds())) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kinds';
  end if;
  select array_agg(distinct k order by k) into v_kinds from unnest(coalesce(p_kinds, authz.tally_file_kinds())) k;
  if p_branch_ids is not null and cardinality(p_branch_ids) > 0 then
    if cardinality(p_branch_ids) > 50 or array_position(p_branch_ids, null) is not null
       or exists (select 1 from unnest(p_branch_ids) x(id)
                  where not exists (select 1 from public.branches b where b.id = x.id and b.legal_entity_id = p_entity)) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'branchIds';
    end if;
    select array_agg(distinct x order by x) into v_branches from unnest(p_branch_ids) x;
  end if;
  return query select v_kinds, v_branches;
end;
$$;

-- ===========================================================================
-- 2. Candidates
-- ===========================================================================

create function authz.tally_file_candidates(p_entity uuid, p_from date, p_to date, p_kinds text[], p_branches uuid[],
  p_include_again boolean, p_syn boolean)
returns table (kind text, record_id uuid, branch_id uuid, deal_id uuid, tr_id uuid, prev_at timestamptz, prev_hash text,
  rec_date date, reference text, deal_ref text, bitrix_deal_id text, record_type text, amount_paise bigint, source jsonb,
  hash text, service text, voucher_type text, debit_ledger text, credit_ledger text, party_ledger text, verdict text, detail text)
language plpgsql stable security definer set search_path = '' as $$
begin
  return query
  with b as (
    -- Journal entries (receipts, deposits, refunds; reversals are listed as kind_not_in_file).
    select 'journal_entry'::text as kind, e.id, e.kind as sub, coalesce(d.branch_id, e.branch_id) as branch_id, e.deal_id,
           e.business_date as rec_date,
           coalesce((select sum(l.debit_paise) from public.finance_journal_lines l where l.entry_id = e.id), 0)::bigint as amount,
           true as live, null::uuid as supplier_id
    from public.finance_journal_entries e
    left join public.deals d on d.id = e.deal_id
    where 'journal_entry' = any(p_kinds) and e.legal_entity_id = p_entity and e.business_date between p_from and p_to
      and (d.id is null or d.is_synthetic = p_syn)
    union all
    select 'supplier_payment', p.id, 'supplier_payment', d.branch_id, p.deal_id, p.paid_on, p.amount_paise,
           p.status = 'verified', p.supplier_id
    from public.supplier_payment_requests p
    join public.deals d on d.id = p.deal_id
    where 'supplier_payment' = any(p_kinds) and p.legal_entity_id = p_entity and p.paid_on between p_from and p_to
      and d.is_synthetic = p_syn
      and (p.status = 'verified' or exists (select 1 from public.tally_records t
                                            where t.record_kind = 'supplier_payment' and t.record_id = p.id and t.xml_export_id is not null))
    union all
    select 'supplier_refund', x.id, 'supplier_refund', d.branch_id, x.deal_id, x.received_on, x.amount_paise,
           x.status = 'verified', x.supplier_id
    from public.supplier_refund_receipts x
    join public.deals d on d.id = x.deal_id
    where 'supplier_refund' = any(p_kinds) and x.legal_entity_id = p_entity and x.received_on between p_from and p_to
      and d.is_synthetic = p_syn
      and (x.status = 'verified' or exists (select 1 from public.tally_records t
                                            where t.record_kind = 'supplier_refund' and t.record_id = x.id and t.xml_export_id is not null))
    union all
    select 'write_off', w.id, w.direction, w.branch_id, w.deal_id, (timezone('Asia/Kolkata', w.decided_at))::date, w.amount_paise,
           w.status = 'approved', null::uuid
    from public.deal_write_offs w
    join public.deals d on d.id = w.deal_id
    where 'write_off' = any(p_kinds) and w.legal_entity_id = p_entity and w.status in ('approved', 'undone')
      and (timezone('Asia/Kolkata', w.decided_at))::date between p_from and p_to and d.is_synthetic = p_syn
      and (w.status = 'approved' or exists (select 1 from public.tally_records t
                                            where t.record_kind = 'write_off' and t.record_id = w.id and t.xml_export_id is not null))
    union all
    select 'expense', c.id, 'expense', d.branch_id, c.deal_id, coalesce(c.paid_on, (timezone('Asia/Kolkata', c.created_at))::date),
           c.amount_paise, true, c.supplier_id
    from public.department_cost_entries c
    join public.deals d on d.id = c.deal_id
    where 'expense' = any(p_kinds) and c.legal_entity_id = p_entity and c.paid_by = 'company' and c.expense_status = 'accepted'
      and coalesce(c.paid_on, (timezone('Asia/Kolkata', c.created_at))::date) between p_from and p_to and d.is_synthetic = p_syn
  ),
  f as (
    select b.*, tr.id as tr_id, tr.status as tr_status, tr.last_export_hash, tr.last_exported_at, tr.xml_export_id,
           xe.export_no as prev_no
    from b
    left join public.tally_records tr on tr.record_kind = b.kind and tr.record_id = b.id
    left join public.tally_exports xe on xe.id = tr.xml_export_id
    where (p_branches is null or b.branch_id = any(p_branches))
      -- Matched or excepted outside a file, or no longer live and never in a file: not a candidate.
      and not (tr.xml_export_id is null and (coalesce(tr.status in ('matched', 'exception'), false) or not b.live))
  ),
  src as (
    select 'journal_entry'::text as kind, s.record_id, s.source, s.ids
    from authz.tally_source_set('journal_entry', array(select f.id from f where f.kind = 'journal_entry')) s
    union all
    select 'supplier_payment', s.record_id, s.source, s.ids
    from authz.tally_source_set('supplier_payment', array(select f.id from f where f.kind = 'supplier_payment')) s
    union all
    select 'supplier_refund', s.record_id, s.source, s.ids
    from authz.tally_source_set('supplier_refund', array(select f.id from f where f.kind = 'supplier_refund')) s
    union all
    select 'write_off', s.record_id, s.source, s.ids
    from authz.tally_source_set('write_off', array(select f.id from f where f.kind = 'write_off')) s
    union all
    select 'expense', s.record_id, s.source, s.ids
    from authz.tally_source_set('expense', array(select f.id from f where f.kind = 'expense')) s
  ),
  svc as (
    select 'journal_entry'::text as kind, s.record_id, s.row_kind, s.service_class
    from authz.tally_service_set('journal_entry', array(select f.id from f where f.kind = 'journal_entry')) s
    union all
    select 'supplier_payment', s.record_id, s.row_kind, s.service_class
    from authz.tally_service_set('supplier_payment', array(select f.id from f where f.kind = 'supplier_payment')) s
    union all
    select 'supplier_refund', s.record_id, s.row_kind, s.service_class
    from authz.tally_service_set('supplier_refund', array(select f.id from f where f.kind = 'supplier_refund')) s
  ),
  g as (
    select f.*, src.source, authz.tally_hash(src.source, src.ids) as hash,
           case when f.kind = 'write_off' then 'write_off_' || f.sub when f.kind = 'expense' then 'expense' else svc.row_kind end as row_kind,
           case when f.kind in ('write_off', 'expense') then 'any' else svc.service_class end as service,
           case when f.kind = 'write_off' or f.sub in ('receipt_bank', 'receipt_cash', 'refund_bank', 'refund_cash') then 'customer'
                when f.kind in ('supplier_payment', 'supplier_refund') then 'supplier' end as party_side,
           -- Which side the mapping names (the other side is the party ledger).
           f.sub in ('receipt_bank', 'receipt_cash', 'deposit', 'supplier_refund', 'due') as map_debit,
           f.sub in ('deposit', 'refund_bank', 'refund_cash', 'supplier_payment', 'excess') as map_credit
    from f
    join src on src.kind = f.kind and src.record_id = f.id
    left join svc on svc.kind = f.kind and svc.record_id = f.id
  ),
  h as (
    select g.*,
           case when m1.id is not null then m1.voucher_type else m0.voucher_type end as vt,
           case when m1.id is not null then m1.debit_ledger else m0.debit_ledger end as mdeb,
           case when m1.id is not null then m1.credit_ledger else m0.credit_ledger end as mcred,
           case g.party_side when 'customer' then cp.tally_ledger_name when 'supplier' then s.tally_ledger_name end as party,
           left(coalesce(g.source ->> 'reference', g.source ->> 'bankReference'), 60) as ref
    from g
    left join public.tally_ledger_mappings m1
      on m1.legal_entity_id = p_entity and m1.row_kind = g.row_kind and m1.service_class = g.service
    left join public.tally_ledger_mappings m0
      on m0.legal_entity_id = p_entity and m0.row_kind = g.row_kind and m0.service_class = 'any'
    left join public.customer_billing_profiles bp on g.party_side = 'customer' and bp.deal_id = g.deal_id
    left join public.customer_parties cp on cp.id = bp.party_id
    left join public.suppliers s on g.party_side = 'supplier' and s.id = g.supplier_id
  ),
  v as (
    select h.*,
      case
        when h.kind = 'expense' or h.sub like 'reversal%' then 'kind_not_in_file'
        when h.xml_export_id is not null and h.tr_status in ('matched', 'exception') then 'already_in_file'
        when h.xml_export_id is not null and not h.live then 'changed_since_file'
        when h.xml_export_id is not null and not coalesce(p_include_again, false) then
          case when h.last_export_hash is distinct from h.hash then 'changed_since_file' else 'already_in_file' end
        when h.vt is null then 'voucher_type_missing'
        when (h.map_debit and h.mdeb is null) or (h.map_credit and h.mcred is null) then 'ledger_not_mapped'
        when h.party_side is not null and h.party is null then 'party_not_mapped'
        else 'line' end as verdict
    from h
  )
  select v.kind, v.id, v.branch_id, v.deal_id, v.tr_id, v.last_exported_at, v.last_export_hash, v.rec_date, v.ref,
         v.source ->> 'deal', v.source ->> 'bitrixDealId', v.source ->> 'recordType', v.amount, v.source, v.hash, v.service, v.vt,
         case when v.map_debit then v.mdeb else v.party end,
         case when v.map_credit then v.mcred else v.party end,
         v.party,
         v.verdict,
         left(case v.verdict
           when 'kind_not_in_file' then v.source ->> 'recordType'
           when 'already_in_file' then v.prev_no
           when 'changed_since_file' then v.prev_no
           when 'voucher_type_missing' then v.row_kind || ' (' || coalesce(v.service, 'any') || '): voucher type'
           when 'ledger_not_mapped' then v.row_kind || ' (' || coalesce(v.service, 'any') || '): '
             || case when v.map_debit and v.mdeb is null then 'debit ledger' else 'credit ledger' end
           when 'party_not_mapped' then case v.party_side when 'customer' then 'customer party' else 'supplier' end
           end, 100)
  from v
  order by v.rec_date, v.kind, v.id;
end;
$$;

-- The frozen voucher of one line (dates ISO; the app writes YYYYMMDD).
create function authz.tally_file_voucher(p_date date, p_voucher_type text, p_narration text, p_reference text, p_party text,
  p_debit text, p_credit text, p_amount bigint) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'date', to_char(p_date, 'YYYY-MM-DD'),
    'voucherType', p_voucher_type,
    'narration', p_narration,
    'reference', p_reference,
    'partyLedger', p_party,
    'entries', jsonb_build_array(
      jsonb_build_object('ledger', p_debit, 'debitPaise', p_amount::text),
      jsonb_build_object('ledger', p_credit, 'creditPaise', p_amount::text)))
$$;

-- Narration (frozen, 7.3): references only, never names.
create function authz.tally_file_narration(p_deal text, p_bitrix text, p_record_type text, p_reference text, p_export_no text,
  p_line integer) returns text
language sql immutable set search_path = '' as $$
  select case when p_deal is not null
           then 'Deal ' || coalesce(p_bitrix, p_deal) || ' | ' || p_deal || ' | '
           else '' end
         || coalesce(p_record_type, '') || coalesce(' ' || p_reference, '')
         || ' | TN:' || p_export_no || '/' || p_line::text
$$;

-- ===========================================================================
-- 3. R-C2 preview
-- ===========================================================================

create function public.accounts_tally_file_preview(p_entity uuid, p_from date, p_to date, p_kinds text[], p_branch_ids uuid[])
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  a record;
  v_out jsonb;
  c_limit constant integer := 200;
begin
  if p_entity is null or not coalesce(authz.session_ok(), false) or not (p_entity = any(authz.acct_a_entities())) then
    return null;
  end if;
  select * into a from authz.tally_file_args(p_entity, p_from, p_to, p_kinds, p_branch_ids) x;
  with c as materialized (
    select * from authz.tally_file_candidates(p_entity, p_from, p_to, a.kinds, a.branches, false, authz.acct_synthetic())
  ),
  n as (select count(*) filter (where c.verdict = 'line')::int as lines, count(*) filter (where c.verdict <> 'line')::int as left_out from c)
  select jsonb_build_object(
    'lines', coalesce((select jsonb_agg(jsonb_build_object('recordKind', l.kind, 'recordId', l.record_id, 'reference', l.reference,
        'dealReference', l.deal_ref, 'voucherType', l.voucher_type, 'date', to_char(l.rec_date, 'YYYY-MM-DD'),
        'amountPaise', l.amount_paise::text) order by l.rec_date, l.kind, l.record_id)
      from (select * from c where c.verdict = 'line' order by c.rec_date, c.kind, c.record_id limit c_limit) l), '[]'::jsonb),
    'leftOut', coalesce((select jsonb_agg(jsonb_build_object('recordKind', l.kind, 'recordId', l.record_id, 'reference', l.reference,
        'reason', l.verdict, 'detail', l.detail) order by l.kind, l.record_id)
      from (select * from c where c.verdict <> 'line' order by c.kind, c.record_id limit c_limit) l), '[]'::jsonb),
    'counts', jsonb_build_object('lines', n.lines, 'leftOut', n.left_out,
      'byReason', coalesce((select jsonb_object_agg(r.verdict, r.cnt) from (
        select c.verdict, count(*)::int as cnt from c where c.verdict <> 'line' group by c.verdict) r), '{}'::jsonb)),
    'truncated', n.lines > c_limit or n.left_out > c_limit)
  into v_out
  from n;
  return v_out;
end;
$$;

-- ===========================================================================
-- 4. C3 make the file
-- ===========================================================================

create function public.accounts_tally_file_create(p_entity uuid, p_from date, p_to date, p_kinds text[], p_branch_ids uuid[],
  p_include_again boolean, p_include_reason text, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_payload jsonb := jsonb_build_object('entityId', p_entity, 'from', p_from, 'to', p_to, 'kinds', to_jsonb(p_kinds),
    'branchIds', to_jsonb(p_branch_ids), 'includeAgain', p_include_again, 'includeReason', p_include_reason);
  v_result jsonb;
  a record;
  v_reason text;
  v_company text;
  v_syn boolean;
  v_lines integer;
  v_left integer;
  v_year integer;
  v_no integer;
  v_export public.tally_exports%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_entity is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'entityId';
  end if;
  perform authz.finance_require_accounts(p_entity, null);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(p_entity, p_request_id, 'accounts_tally_file_create', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  select s.tally_company_name into v_company from public.accounts_settings s
  where s.legal_entity_id = p_entity and s.tally_xml_enabled;
  if v_company is null then
    raise exception 'tally_xml_off' using errcode = '55000';
  end if;
  select * into a from authz.tally_file_args(p_entity, p_from, p_to, p_kinds, p_branch_ids) x;
  if p_include_again is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'includeAgain';
  end if;
  if p_include_again then
    begin
      v_reason := authz.finance_reason(p_include_reason);
    exception when sqlstate '22023' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'includeReason';
    end;
  end if;
  v_syn := authz.acct_synthetic();

  -- Lock order 17.1 (4): the file maker holds the Tally entity lock exclusive
  -- and never locks a source row.
  perform authz.tally_entity_lock(p_entity, true);
  drop table if exists pg_temp.tally_file_work;
  create temporary table tally_file_work on commit drop as
    select c.*, null::integer as line_no
    from authz.tally_file_candidates(p_entity, p_from, p_to, a.kinds, a.branches, p_include_again, v_syn) c;
  update pg_temp.tally_file_work w set line_no = n.line_no
  from (select x.kind, x.record_id, row_number() over (order by x.rec_date, x.kind, x.record_id)::integer as line_no
        from pg_temp.tally_file_work x where x.verdict = 'line') n
  where n.kind = w.kind and n.record_id = w.record_id;
  select count(*) filter (where w.verdict = 'line')::int, count(*) filter (where w.verdict <> 'line')::int
  into v_lines, v_left from pg_temp.tally_file_work w;
  if v_lines = 0 then
    raise exception 'nothing_to_export' using errcode = '55000', hint = 'leftOut=' || v_left::text;
  end if;
  if v_lines > 10000 then
    raise exception 'export_too_large' using errcode = '22023', hint = 'from';
  end if;
  perform 1 from public.tally_records r
  where r.id in (select w.tr_id from pg_temp.tally_file_work w where w.verdict = 'line' and w.tr_id is not null)
  order by r.id for no key update;

  v_year := extract(year from authz.finance_today())::integer;
  insert into public.tally_export_counters as c (legal_entity_id, year, last_no) values (p_entity, v_year, 1)
  on conflict (legal_entity_id, year) do update set last_no = c.last_no + 1
  returning c.last_no into v_no;
  insert into public.tally_exports (legal_entity_id, export_no, period_from, period_to, kinds, include_exported, branch_ids,
    row_count, created_by, request_id, format, include_reason, company_name)
  values (p_entity, 'TE-' || v_year::text || '-' || lpad(v_no::text, 6, '0'), p_from, p_to, a.kinds, p_include_again, a.branches,
    v_lines, (select auth.uid()), p_request_id, 'xml', v_reason, v_company)
  returning * into v_export;

  with ins as (
    insert into public.tally_records (legal_entity_id, branch_id, deal_id, record_kind, record_id, status, export_count,
      last_export_id, last_exported_at, last_export_hash, xml_export_id, xml_exported_at, xml_line_no, updated_by)
    select p_entity, w.branch_id, w.deal_id, w.kind, w.record_id, 'exported', 1, v_export.id, now(), w.hash,
      v_export.id, now(), w.line_no, (select auth.uid())
    from pg_temp.tally_file_work w where w.verdict = 'line' and w.tr_id is null
    returning id, record_kind, record_id)
  update pg_temp.tally_file_work w set tr_id = ins.id from ins where ins.record_kind = w.kind and ins.record_id = w.record_id;
  update public.tally_records r
  set status = 'exported', export_count = r.export_count + 1, last_export_id = v_export.id, last_exported_at = now(),
      last_export_hash = w.hash, xml_export_id = v_export.id, xml_exported_at = now(), xml_line_no = w.line_no,
      row_version = r.row_version + 1, updated_at = now(), updated_by = (select auth.uid())
  from pg_temp.tally_file_work w
  where w.verdict = 'line' and r.id = w.tr_id and r.last_export_id is distinct from v_export.id;

  insert into public.tally_export_lines (export_id, line_no, legal_entity_id, record_kind, record_id, tally_record_id, "values",
    source_hash, previously_exported_at)
  select v_export.id, w.line_no, p_entity, w.kind, w.record_id, w.tr_id,
    authz.tally_line_values(w.source || jsonb_build_object(
        'service', authz.tally_service_word(w.service),
        'tallyDebitLedger', w.debit_ledger, 'tallyCreditLedger', w.credit_ledger, 'tallyVoucherType', w.voucher_type,
        'mappingMissing', 'no'),
      v_export.export_no, w.line_no, w.prev_at, w.prev_hash is not null and w.prev_hash <> w.hash)
    || jsonb_build_object(
      'narration', authz.tally_file_narration(w.deal_ref, w.bitrix_deal_id, w.record_type, w.reference, v_export.export_no, w.line_no),
      -- No payer name, PAN or mobile in a Tally file line: the party is its Tally ledger.
      'party', w.party_ledger, 'pan', null, 'mobile', null,
      'reference', w.reference,
      'recordKind', w.kind,
      'amountPaise', w.amount_paise::text,
      'partyLedger', w.party_ledger,
      'entries', jsonb_build_array(
        jsonb_build_object('ledger', w.debit_ledger, 'debitPaise', w.amount_paise::text),
        jsonb_build_object('ledger', w.credit_ledger, 'creditPaise', w.amount_paise::text)),
      'voucher', authz.tally_file_voucher(w.rec_date, w.voucher_type,
        authz.tally_file_narration(w.deal_ref, w.bitrix_deal_id, w.record_type, w.reference, v_export.export_no, w.line_no),
        w.reference, w.party_ledger, w.debit_ledger, w.credit_ledger, w.amount_paise)),
    w.hash, w.prev_at
  from pg_temp.tally_file_work w
  where w.verdict = 'line';

  insert into public.tally_export_left_out (export_id, legal_entity_id, record_kind, record_id, reason, detail, reference)
  select v_export.id, p_entity, w.kind, w.record_id, w.verdict, w.detail, w.reference
  from pg_temp.tally_file_work w where w.verdict <> 'line';

  perform authz.write_audit('accounts.tally_file.created', p_entity, null, 'tally_export', v_export.id,
    case when p_include_again then v_reason end,
    jsonb_build_object('exportId', v_export.id, 'lines', v_lines, 'leftOut', v_left, 'kinds', to_jsonb(a.kinds),
      'includeAgain', p_include_again));
  v_result := jsonb_build_object('outcome', 'created', 'exportId', v_export.id, 'exportNo', v_export.export_no,
    'lines', v_lines, 'leftOut', v_left);
  return authz.finance_remember(p_entity, p_request_id, 'accounts_tally_file_create', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 5. R-C1 file list (additive)
-- ===========================================================================

-- Replaces 20261204000410:824 (additive): items + format, leftOutCount,
-- includeReason (fileName TE-....xml for XML files); entities + xmlEnabled.
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
        'mappingMissingCount', (select count(*)::int from public.tally_ledger_mappings m
                                where m.legal_entity_id = e.id
                                  and authz.tally_mapping_missing(m.debit_ledger, m.credit_ledger, m.voucher_type)),
        -- Accounts phase 3 (20261205000310)
        'xmlEnabled', coalesce(s.tally_xml_enabled, false))
        order by e.legal_name)
      from public.legal_entities e left join public.accounts_settings s on s.legal_entity_id = e.id
      where e.id = any(v_a)), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(authz.tally_export_json(x.id) || jsonb_build_object(
          -- Accounts phase 3 (20261205000310)
          'format', x.format,
          'leftOutCount', (select count(*)::int from public.tally_export_left_out o where o.export_id = x.id),
          'includeReason', x.include_reason)
        || case when x.format = 'xml' then jsonb_build_object('fileName', x.export_no || '.xml') else '{}'::jsonb end
        order by x.created_at desc, x.id)
                       from (select t.id, t.created_at, t.format, t.include_reason, t.export_no from public.tally_exports t
                             where t.legal_entity_id = any(v_a)
                             order by t.created_at desc, t.id limit v_limit) x), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- 6. R-C3 left-out list
-- ===========================================================================

-- p_after: the last row's "<record kind>|<record id>" (keyset).
create function public.accounts_tally_export_left_out(p_export_id uuid, p_after text default null, p_limit integer default 100)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_export public.tally_exports%rowtype;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_kind text;
  v_id uuid;
  v_items jsonb;
  v_count integer;
  v_last text;
begin
  if p_export_id is null or not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v_export from public.tally_exports x where x.id = p_export_id;
  if v_export.id is null or not (v_export.legal_entity_id = any(authz.acct_a_entities())) then
    return null;
  end if;
  if p_after is not null then
    if p_after !~ '^[a-z_]{1,40}\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end if;
    v_kind := split_part(p_after, '|', 1);
    v_id := split_part(p_after, '|', 2)::uuid;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('recordKind', o.record_kind, 'recordId', o.record_id, 'reference', o.reference,
           'reason', o.reason, 'detail', o.detail) order by o.record_kind, o.record_id) filter (where o.rn <= v_limit), '[]'::jsonb),
         count(*)::int,
         max(o.record_kind || '|' || o.record_id::text) filter (where o.rn = v_limit)
  into v_items, v_count, v_last
  from (select x.*, row_number() over (order by x.record_kind, x.record_id) as rn
        from public.tally_export_left_out x
        where x.export_id = v_export.id
          and (v_kind is null or (x.record_kind, x.record_id) > (v_kind, v_id))
        order by x.record_kind, x.record_id
        limit v_limit + 1) o;
  return jsonb_build_object('exportId', v_export.id, 'exportNo', v_export.export_no, 'items', v_items,
    'nextAfter', case when v_count > v_limit then v_last end, 'hasMore', v_count > v_limit);
end;
$$;

-- ===========================================================================
-- 7. XML download log
-- ===========================================================================

create function public.accounts_tally_file_download_log(p_export_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_export public.tally_exports%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_export from public.tally_exports x where x.id = p_export_id;
  if v_export.id is null or v_export.format <> 'xml' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.finance_require_accounts(v_export.legal_entity_id, null);
  perform authz.write_audit('accounts.tally_file.downloaded', v_export.legal_entity_id, null, 'tally_export', v_export.id, null,
    jsonb_build_object('exportId', v_export.id, 'lines', v_export.row_count));
  return jsonb_build_object('exportId', v_export.id, 'exportNo', v_export.export_no, 'companyName', v_export.company_name,
    'rowCount', v_export.row_count, 'fileName', v_export.export_no || '.xml');
end;
$$;

-- ===========================================================================
-- 8. Grants
-- ===========================================================================

revoke all on function authz.tally_file_kinds(), authz.tally_file_args(uuid, date, date, text[], uuid[]),
  authz.tally_file_candidates(uuid, date, date, text[], uuid[], boolean, boolean),
  authz.tally_file_voucher(date, text, text, text, text, text, text, bigint),
  authz.tally_file_narration(text, text, text, text, text, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.accounts_tally_file_preview(uuid, date, date, text[], uuid[]),
  public.accounts_tally_file_create(uuid, date, date, text[], uuid[], boolean, text, uuid),
  public.accounts_tally_export_left_out(uuid, text, integer),
  public.accounts_tally_file_download_log(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.accounts_tally_file_preview(uuid, date, date, text[], uuid[]),
  public.accounts_tally_file_create(uuid, date, date, text[], uuid[], boolean, text, uuid),
  public.accounts_tally_export_left_out(uuid, text, integer),
  public.accounts_tally_file_download_log(uuid)
  to authenticated;

commit;
