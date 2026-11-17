-- TripNavigate CRM - Accounts phase 3, track C (1 of 3): Tally import file and
-- matching upload - schema, write-off kind, party names and the switch.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 7.1, 7.2, 13, 14,
-- 17.1, 17.2, 19 (shared functions of C), 21 LD17, LD18, Addenda O1 and L1.
-- Owner rules: money vouchers only; the CRM never contacts Tally, never opens
-- its port and never posts to it (DEC-22); a file never invents a ledger.
--
-- What this file changes:
--   1. customer_parties.tally_ledger_name (1..100, authz.tally_name_ok).
--   2. tally_exports: format ('csv' | 'xml', default 'csv'), include_reason
--      (10..500; required for an XML file that includes entries again) and
--      company_name (the Tally company of an XML file, frozen with the file so
--      a re-download gives the same bytes - an additive column the contract
--      implies by "frozen lines reproduce the same XML bytes"); kinds gain
--      'write_off'. tally_records and tally_export_lines kinds gain
--      'write_off'; tally_records gains xml_export_id, xml_exported_at,
--      xml_line_no (the XML file an entry went into, apart from CSV exports).
--   3. tally_export_left_out (append-only): what a file left out and why.
--   4. tally_match_batches / tally_match_rows: the matching upload staging
--      (LD17: not a master-data import).
--   5. tally_ledger_mappings row kinds gain write_off_due / write_off_excess
--      (voucher type "Journal", ledgers blank for Accounts);
--      authz.tally_mapping_defaults (replace 20261204000400:124) lists them
--      and every existing entity gets the two rows.
--   6. authz.tally_kinds (replace 20261204000410:93), authz.tally_target
--      (replace :104), authz.tally_source_set (replace :188),
--      authz.tally_touch_source (replace :356) + a touch trigger on
--      deal_write_offs (status): write_off approved -> ready; undone ->
--      exported state kept when it was exported (then "changed since export"),
--      else not applicable; proposed -> not ready; returned / withdrawn -> not
--      applicable. Source values of the other kinds are unchanged, so their
--      stored hashes stay equal.
--   7. C1 public.customer_party_tally_name_set(p_party_id, p_expected_row_version,
--      p_name, p_request_id)  A of the party's entity; audit
--      accounts.tally_party_named {partyId, rowVersion, cleared} (never the name).
--      Addition (screen 7 "Tally party name on the customer page"):
--      public.customer_party_tally_name(p_party_id) {partyId, name, rowVersion}
--      for A; else null.
--   8. C2 public.admin_set_tally_xml(p_entity, p_enabled, p_company_name, p_reason)
--      finance policy managers; turning on needs a company name; audit
--      settings.accounts_changed (trigger of track B).
--
-- Refusal tokens: not_authorized (42501), not_found (P0002), version_changed
-- (40001), request_conflict (40001), invalid_input (22023, hint = field).
-- Lock order (17.1): touch triggers take the Tally entity lock shared after
-- the write-off command's Deal and row locks.
-- Rollback (forward-only): a NEW migration restoring the four replaced bodies
-- (20261204000410 / 20261204000400), dropping the deal_write_offs touch
-- trigger and revoking C1 / C2; columns, tables and rows stay.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Party names
-- ===========================================================================

alter table public.customer_parties
  add column tally_ledger_name text
    constraint customer_parties_tally_ledger_name_check check (authz.tally_name_ok(tally_ledger_name, 100));
comment on column public.customer_parties.tally_ledger_name is
  'Accounts phase 3 (7.2): the Tally ledger name of this customer party, set by Accounts (C1). Used only to fill the party ledger of the Tally import file; never hashed.';

-- ===========================================================================
-- 2. Export, record and line columns; kind checks
-- ===========================================================================

alter table public.tally_exports drop constraint tally_exports_kinds_check;
alter table public.tally_exports add constraint tally_exports_kinds_check check (cardinality(kinds) between 1 and 8
  and array_position(kinds, null) is null
  and kinds <@ array['journal_entry', 'supplier_payment', 'supplier_document', 'expense', 'tally_gst_invoice',
                     'customer_document', 'supplier_refund', 'write_off']);
alter table public.tally_exports
  add column format text not null default 'csv' constraint tally_exports_format_check check (format in ('csv', 'xml')),
  add column include_reason text
    constraint tally_exports_include_reason_check check (include_reason is null or (char_length(include_reason) between 10 and 500)),
  add column company_name text
    constraint tally_exports_company_name_check check (company_name is null
      or (char_length(company_name) between 1 and 100 and company_name !~ '[[:cntrl:]]')),
  add constraint tally_exports_xml_fields check (format = 'xml' or (include_reason is null and company_name is null)),
  add constraint tally_exports_xml_company check (format = 'csv' or company_name is not null);
-- The 366-day period cap stays for CSV exports; an XML file is bounded by its
-- 10,000 lines instead (Accounts may file everything not yet in Tally at once).
do $$
declare
  c record;
begin
  for c in
    select con.conname from pg_catalog.pg_constraint con
    where con.contype = 'c' and con.conrelid = 'public.tally_exports'::regclass
      and pg_catalog.pg_get_constraintdef(con.oid) like '%366%'
  loop
    execute format('alter table public.tally_exports drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table public.tally_exports add constraint tally_exports_period_check
  check (period_from <= period_to and (format = 'xml' or period_to - period_from <= 366));
create index tally_exports_entity_format_idx on public.tally_exports (legal_entity_id, format, created_at desc);
-- The matching upload resolves "TN:<export_no>/<line>" within one entity.
create index tally_exports_entity_no_idx on public.tally_exports (legal_entity_id, export_no) where format = 'xml';

alter table public.tally_records drop constraint tally_records_record_kind_check;
alter table public.tally_records add constraint tally_records_record_kind_check check (record_kind in ('journal_entry',
  'supplier_payment', 'supplier_document', 'expense', 'tally_gst_invoice', 'customer_document', 'supplier_refund', 'write_off'));
alter table public.tally_export_lines drop constraint tally_export_lines_record_kind_check;
alter table public.tally_export_lines add constraint tally_export_lines_record_kind_check check (record_kind in ('journal_entry',
  'supplier_payment', 'supplier_document', 'expense', 'tally_gst_invoice', 'customer_document', 'supplier_refund', 'write_off'));

alter table public.tally_records
  add column xml_export_id uuid,
  add column xml_exported_at timestamptz,
  add column xml_line_no integer constraint tally_records_xml_line_no_check check (xml_line_no is null or xml_line_no between 1 and 10000),
  add constraint tally_records_xml_export_fk foreign key (legal_entity_id, xml_export_id)
    references public.tally_exports (legal_entity_id, id),
  add constraint tally_records_xml_trio check ((xml_export_id is null) = (xml_exported_at is null)
    and (xml_export_id is null) = (xml_line_no is null));
create index tally_records_xml_export_idx on public.tally_records (legal_entity_id, xml_export_id) where xml_export_id is not null;
-- Daily check "Tally file entries not matched after one working day" (track B).
create index tally_records_xml_unmatched_idx on public.tally_records (legal_entity_id, xml_exported_at)
  where xml_export_id is not null and status = 'exported';

-- ===========================================================================
-- 3. Left-out list
-- ===========================================================================

create table public.tally_export_left_out (
  export_id uuid not null,
  legal_entity_id uuid not null,
  record_kind text not null check (record_kind in ('journal_entry', 'supplier_payment', 'supplier_document', 'expense',
    'tally_gst_invoice', 'customer_document', 'supplier_refund', 'write_off')),
  record_id uuid not null,
  reason text not null check (reason in ('ledger_not_mapped', 'party_not_mapped', 'voucher_type_missing', 'already_in_file',
    'kind_not_in_file', 'changed_since_file')),
  -- The missing mapping row, or the earlier file number (never a name or an amount).
  detail text check (detail is null or (char_length(detail) between 1 and 100 and detail !~ '[[:cntrl:]]')),
  -- The CRM reference shown in the list (R-, SP-, RF-, WO-, supplier refund reference).
  reference text check (reference is null or (char_length(reference) between 1 and 60 and reference !~ '[[:cntrl:]]')),
  created_at timestamptz not null default now(),
  primary key (export_id, record_kind, record_id),
  foreign key (legal_entity_id, export_id) references public.tally_exports (legal_entity_id, id)
);
create index tally_export_left_out_export_fk_idx on public.tally_export_left_out (legal_entity_id, export_id);
comment on table public.tally_export_left_out is
  'Accounts phase 3 (7.2): records a Tally import file left out, with the reason (LD17, LD18). Append-only. No table grant.';
create trigger tally_export_left_out_append_only before update or delete on public.tally_export_left_out
  for each row execute function authz.finance_append_only();

-- ===========================================================================
-- 4. Matching upload staging (7.4)
-- ===========================================================================

create table public.tally_match_batches (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  file_name text not null check (char_length(file_name) between 1 and 200 and file_name !~ '[[:cntrl:]]'),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'staged' check (status in ('staged', 'applied', 'cancelled')),
  row_count integer not null check (row_count between 1 and 5000),
  summary jsonb not null check (jsonb_typeof(summary) = 'object'),
  proposal_hash text not null check (proposal_hash ~ '^[0-9a-f]{64}$'),
  staged_by uuid not null references public.staff_profiles (user_id),
  staged_at timestamptz not null default now(),
  request_id uuid not null,
  applied_by uuid references public.staff_profiles (user_id),
  applied_at timestamptz,
  apply_request_id uuid,
  cancelled_by uuid references public.staff_profiles (user_id),
  cancelled_at timestamptz,
  cancel_request_id uuid,
  row_version integer not null default 1 check (row_version >= 1),
  unique (legal_entity_id, request_id),
  unique (legal_entity_id, id),
  check ((status = 'applied') = (applied_at is not null and applied_by is not null and apply_request_id is not null)),
  check ((status = 'cancelled') = (cancelled_at is not null and cancelled_by is not null and cancel_request_id is not null))
);
create unique index tally_match_batches_file_key on public.tally_match_batches (legal_entity_id, file_sha256)
  where status <> 'cancelled';
create index tally_match_batches_entity_idx on public.tally_match_batches (legal_entity_id, staged_at desc);
create index tally_match_batches_staged_by_idx on public.tally_match_batches (staged_by);
create index tally_match_batches_applied_by_idx on public.tally_match_batches (applied_by) where applied_by is not null;
create index tally_match_batches_cancelled_by_idx on public.tally_match_batches (cancelled_by) where cancelled_by is not null;
comment on table public.tally_match_batches is
  'Accounts phase 3 (7.4): one uploaded Tally Day Book (matching upload). Staged, then applied or cancelled. No table grant.';

create function authz.tally_match_batches_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_mutable text[] := array['status', 'applied_by', 'applied_at', 'apply_request_id', 'cancelled_by', 'cancelled_at',
    'cancel_request_id', 'row_version'];
begin
  if tg_op = 'DELETE' then
    raise exception 'Tally matching uploads cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable)
     or old.status <> 'staged' or new.status not in ('applied', 'cancelled')
     or new.row_version <> old.row_version + 1 then
    raise exception 'Tally matching upload facts are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger tally_match_batches_a_guard before update or delete on public.tally_match_batches
  for each row execute function authz.tally_match_batches_guard();

create table public.tally_match_rows (
  batch_id uuid not null,
  legal_entity_id uuid not null,
  row_no integer not null check (row_no between 1 and 5000),
  tn_tag text check (tn_tag is null or tn_tag ~ '^TN:TE-[0-9]{4}-[0-9]{6}/[0-9]{1,5}$'),
  voucher_ref text not null check (char_length(voucher_ref) between 1 and 60 and voucher_ref !~ '[[:cntrl:]]'),
  voucher_date date not null check (voucher_date >= date '2000-01-01'),
  voucher_type text check (voucher_type is null or (char_length(voucher_type) between 1 and 60 and voucher_type !~ '[[:cntrl:]]')),
  amount_paise bigint not null check (amount_paise between 0 and 999999999999999),
  outcome text not null check (outcome in ('matched', 'amount_differs', 'not_found', 'already_matched', 'duplicate_in_file', 'no_tag')),
  tally_record_id uuid,
  crm_amount_paise bigint check (crm_amount_paise is null or crm_amount_paise >= 0),
  primary key (batch_id, row_no),
  foreign key (legal_entity_id, batch_id) references public.tally_match_batches (legal_entity_id, id),
  foreign key (legal_entity_id, tally_record_id) references public.tally_records (legal_entity_id, id),
  check (outcome not in ('matched', 'amount_differs') or (tally_record_id is not null and crm_amount_paise is not null))
);
create index tally_match_rows_batch_fk_idx on public.tally_match_rows (legal_entity_id, batch_id);
create index tally_match_rows_outcome_idx on public.tally_match_rows (batch_id, outcome, row_no);
create index tally_match_rows_record_idx on public.tally_match_rows (legal_entity_id, tally_record_id) where tally_record_id is not null;
comment on table public.tally_match_rows is
  'Accounts phase 3 (7.4): one voucher of an uploaded Tally Day Book and what matching does with it. No narration and no ledger names are kept. Append-only. No table grant.';
create trigger tally_match_rows_append_only before update or delete on public.tally_match_rows
  for each row execute function authz.finance_append_only();

do $$
declare
  t text;
begin
  foreach t in array array['tally_export_left_out', 'tally_match_batches', 'tally_match_rows'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

-- ===========================================================================
-- 5. Mapping rows for write-offs
-- ===========================================================================

do $$
declare
  c record;
begin
  for c in
    select con.conname from pg_catalog.pg_constraint con
    where con.contype = 'c' and con.conrelid = 'public.tally_ledger_mappings'::regclass
      and pg_catalog.pg_get_constraintdef(con.oid) like '%receipt_reversal%'
  loop
    execute format('alter table public.tally_ledger_mappings drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table public.tally_ledger_mappings add constraint tally_ledger_mappings_row_kind_check check (row_kind in ('receipt_bank',
  'receipt_cash', 'receipt_reversal', 'cash_deposit', 'customer_refund_bank', 'customer_refund_cash', 'supplier_payment',
  'supplier_invoice', 'supplier_credit_note', 'expense', 'customer_advance_invoice', 'customer_invoice', 'customer_credit_note',
  'supplier_refund', 'tally_gst_invoice', 'write_off_due', 'write_off_excess'));

-- Replaces 20261204000400:124 (same signature): + the two write-off rows
-- (voucher type Journal; ledgers left for Accounts to choose, LD20).
create or replace function authz.tally_mapping_defaults()
returns table (row_kind text, service_class text, debit_ledger text, credit_ledger text, voucher_type text)
language sql immutable set search_path = '' as $$
  values
    -- Customer invoices: sales ledger per service and the service's sales voucher type.
    ('customer_invoice', 'hotel', null, 'Hotel Booking', 'Hotel Invoice'),
    ('customer_invoice', 'flight_domestic', null, 'Domestic Air Ticket', 'Domestic Tkt'),
    ('customer_invoice', 'flight_international', null, 'International Air Ticket', 'International Tkt'),
    ('customer_invoice', 'package_domestic', null, 'Domestic Package', 'Package Invoice'),
    ('customer_invoice', 'package_overseas', null, 'Overseas Package', 'Package Invoice'),
    ('customer_invoice', 'visa', null, 'Visa', 'Visa Inv'),
    ('customer_invoice', 'passport', null, 'Passport', 'Passport Inv'),
    ('customer_invoice', 'transfer', null, 'Transport', 'Transport Inv'),
    ('customer_invoice', 'activity', null, 'Excursion', 'Misc Inv'),
    ('customer_invoice', 'misc', null, 'Miscellaneous', 'Misc Inv'),
    -- Customer credit notes: the same sales ledger (debited) and the credit-note voucher type.
    ('customer_credit_note', 'hotel', 'Hotel Booking', null, 'Hotel Cn'),
    ('customer_credit_note', 'flight_domestic', 'Domestic Air Ticket', null, 'Domestic CN'),
    ('customer_credit_note', 'flight_international', 'International Air Ticket', null, 'Int. Cn'),
    ('customer_credit_note', 'package_domestic', 'Domestic Package', null, 'Package Cn'),
    ('customer_credit_note', 'package_overseas', 'Overseas Package', null, 'Package Cn'),
    ('customer_credit_note', 'visa', 'Visa', null, 'VisaCn'),
    ('customer_credit_note', 'passport', 'Passport', null, 'Miscellaneous CN'),
    ('customer_credit_note', 'transfer', 'Transport', null, 'Miscellaneous CN'),
    ('customer_credit_note', 'activity', 'Excursion', null, 'Miscellaneous CN'),
    ('customer_credit_note', 'misc', 'Miscellaneous', null, 'Miscellaneous CN'),
    -- Supplier bills per service: purchase ledgers are for Accounts to fill (LD20).
    ('supplier_invoice', 'hotel', null, null, 'Purchase'),
    ('supplier_invoice', 'flight_domestic', null, null, 'Purchase'),
    ('supplier_invoice', 'flight_international', null, null, 'Purchase'),
    ('supplier_invoice', 'package_domestic', null, null, 'Purchase'),
    ('supplier_invoice', 'package_overseas', null, null, 'Purchase'),
    ('supplier_invoice', 'visa', null, null, 'Purchase'),
    ('supplier_invoice', 'passport', null, null, 'Purchase'),
    ('supplier_invoice', 'transfer', null, null, 'Purchase'),
    ('supplier_invoice', 'activity', null, null, 'Purchase'),
    ('supplier_invoice', 'misc', null, null, 'Purchase'),
    ('supplier_credit_note', 'hotel', null, null, 'Debit Note M'),
    ('supplier_credit_note', 'flight_domestic', null, null, 'Debit Note M'),
    ('supplier_credit_note', 'flight_international', null, null, 'Debit Note M'),
    ('supplier_credit_note', 'package_domestic', null, null, 'Debit Note M'),
    ('supplier_credit_note', 'package_overseas', null, null, 'Debit Note M'),
    ('supplier_credit_note', 'visa', null, null, 'Debit Note M'),
    ('supplier_credit_note', 'passport', null, null, 'Debit Note M'),
    ('supplier_credit_note', 'transfer', null, null, 'Debit Note M'),
    ('supplier_credit_note', 'activity', null, null, 'Debit Note M'),
    ('supplier_credit_note', 'misc', null, null, 'Debit Note M'),
    -- One row each (voucher types only; bank, cash and customer-advance ledgers for Accounts, LD20).
    ('receipt_bank', 'any', null, null, 'Receipt'),
    ('receipt_cash', 'any', null, null, 'Receipt'),
    ('receipt_reversal', 'any', null, null, 'Journal'),
    ('cash_deposit', 'any', null, null, 'Contra'),
    ('customer_refund_bank', 'any', null, null, 'Payment'),
    ('customer_refund_cash', 'any', null, null, 'Payment'),
    ('supplier_payment', 'any', null, null, 'Payment'),
    ('expense', 'any', null, null, 'Payment'),
    ('customer_advance_invoice', 'any', null, null, 'Receipt'),
    ('supplier_refund', 'any', null, null, 'Receipt'),
    ('tally_gst_invoice', 'any', null, null, null),
    -- Accounts phase 3 (20261205000300): write-offs (LD15); ledgers for Accounts to choose.
    ('write_off_due', 'any', null, null, 'Journal'),
    ('write_off_excess', 'any', null, null, 'Journal')
$$;

select authz.tally_mapping_seed(e.id) from public.legal_entities e order by e.id;

-- ===========================================================================
-- 6. Kinds, target, source values, touch
-- ===========================================================================

-- Replaces 20261204000410:93: + write_off.
create or replace function authz.tally_kinds() returns text[]
language sql immutable set search_path = '' as $$
  select array['journal_entry', 'supplier_payment', 'supplier_document', 'expense', 'tally_gst_invoice',
               'customer_document', 'supplier_refund', 'write_off']
$$;

-- Replaces 20261204000410:104: + write_off.
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
  -- Accounts phase 3 (20261205000300): write-offs. Approved -> ready; undone
  -- keeps the exported state when it was exported (changed since export),
  -- else not applicable; proposed -> not ready; returned / withdrawn -> n/a.
  elsif p_kind = 'write_off' then
    return query select w.legal_entity_id, w.branch_id, w.deal_id, d.is_synthetic,
        case when w.status = 'approved' then 'ready'
             when w.status = 'proposed' then 'not_ready'
             when w.status = 'undone' and exists (
               select 1 from public.tally_records t
               where t.record_kind = 'write_off' and t.record_id = w.id and t.last_export_id is not null) then 'ready'
             else 'not_applicable' end
      from public.deal_write_offs w join public.deals d on d.id = w.deal_id where w.id = p_id;
  end if;
end;
$$;

-- Replaces 20261204000410:188 (same signature): + write_off. The party is not
-- part of a write-off's source (the Tally party name is looked up when a file
-- is made, like the mapping); the status is in the hash ids, so an undo reads
-- as "changed since export".
create or replace function authz.tally_source_set(p_kind text, p_ids uuid[]) returns table (record_id uuid, source jsonb, ids jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_kind = 'journal_entry' then
    return query select e.id, jsonb_build_object(
      'recordType', case when e.kind in ('receipt_bank', 'receipt_cash') then 'Receipt'
                         when e.kind = 'deposit' then 'Cash deposit'
                         when e.kind in ('refund_bank', 'refund_cash') then 'Customer refund'
                         else 'Receipt reversal' end,
      'voucherType', case when e.kind in ('receipt_bank', 'receipt_cash') then 'Receipt'
                          when e.kind = 'deposit' then 'Contra'
                          when e.kind in ('refund_bank', 'refund_cash') then 'Payment'
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
  -- Accounts phase 3 (20261205000300): write-offs (dated on the approval day, India time).
  elsif p_kind = 'write_off' then
    return query select w.id, jsonb_build_object(
      'recordType', case w.direction when 'due' then 'Write-off (balance waived)' else 'Write-off (excess kept)' end,
      'voucherType', 'Journal',
      'date', to_char((timezone('Asia/Kolkata', w.decided_at))::date, 'YYYY-MM-DD'),
      'reference', w.ref_no, 'deal', d.reference, 'bitrixDealId', d.source_deal_id::text, 'branch', b.name,
      'party', null,
      'debitLedger', case w.direction when 'due' then 'Write-off' else 'Customer' end,
      'creditLedger', case w.direction when 'due' then 'Customer' else 'Write-off' end,
      'amount', authz.acct_amount_text(w.amount_paise),
      'mode', null, 'bankReference', null, 'pan', null, 'mobile', null, 'gstIncluded', null, 'creditNoteFor', null,
      'linkedTasks', null,
      'crmRecordId', w.id::text),
      jsonb_build_object('branchId', b.id, 'dealId', d.id, 'supplierId', null, 'status', w.status)
    from public.deal_write_offs w
    join public.deals d on d.id = w.deal_id
    join public.branches b on b.id = w.branch_id
    where w.id in (select unnest(p_ids));
  end if;
end;
$$;

-- Replaces 20261204000410:356 (same body plus deal_write_offs).
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
      perform authz.tally_touch_kind('customer_document',
        array(select x.id from public.customer_documents x where x.tally_invoice_id = any(v_ids)));
    when 'supplier_document_tasks' then
      perform authz.tally_touch_kind('supplier_document',
        array_remove(array[(v_old ->> 'document_id')::uuid, (v_new ->> 'document_id')::uuid], null));
    when 'deals' then
      perform authz.tally_touch_rows(array(select t.id from public.tally_records t
                                           where t.deal_id = any(v_ids) and t.last_export_hash is not null));
    when 'customer_documents' then
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
    -- Accounts phase 3 (20261205000300)
    when 'deal_write_offs' then
      perform authz.tally_touch_kind('write_off', v_ids);
    else
      null;
  end case;
  return null;
end;
$$;

-- Write-off facts are immutable (track B's guard); only the status moves.
create trigger deal_write_offs_tally_touch after update on public.deal_write_offs
  for each row when (old.status is distinct from new.status or old.decided_at is distinct from new.decided_at)
  execute function authz.tally_touch_source();

-- ===========================================================================
-- 7. C1: the Tally party name of a customer party
-- ===========================================================================

create function public.customer_party_tally_name_set(p_party_id uuid, p_expected_row_version integer, p_name text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.customer_parties%rowtype;
  v_payload jsonb := jsonb_build_object('partyId', p_party_id, 'expectedRowVersion', p_expected_row_version, 'name', p_name);
  v_result jsonb;
  v_name text;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_party_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'partyId';
  end if;
  select * into v from public.customer_parties c where c.id = p_party_id;
  if v.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.finance_require_accounts(v.legal_entity_id, null);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v.legal_entity_id, p_request_id, 'customer_party_tally_name_set', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_expected_row_version is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  v_name := nullif(btrim(coalesce(p_name, '')), '');
  if v_name is not null and not authz.tally_name_ok(v_name, 100) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'name';
  end if;
  select * into v from public.customer_parties c where c.id = p_party_id for update;
  if v.row_version <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if v.tally_ledger_name is not distinct from v_name then
    v_result := jsonb_build_object('outcome', 'existing', 'partyId', v.id, 'name', v.tally_ledger_name, 'rowVersion', v.row_version);
  else
    update public.customer_parties c
    set tally_ledger_name = v_name, row_version = c.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
    where c.id = v.id
    returning * into v;
    perform authz.write_audit('accounts.tally_party_named', v.legal_entity_id, v.branch_id, 'customer_party', v.id, null,
      jsonb_build_object('partyId', v.id, 'rowVersion', v.row_version, 'cleared', v_name is null));
    v_result := jsonb_build_object('outcome', 'updated', 'partyId', v.id, 'name', v.tally_ledger_name, 'rowVersion', v.row_version);
  end if;
  return authz.finance_remember(v.legal_entity_id, p_request_id, 'customer_party_tally_name_set', v_payload, v_result);
end;
$$;

-- Addition (screen 7): the Tally party name of one party. A of its entity; else null.
create function public.customer_party_tally_name(p_party_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.customer_parties%rowtype;
begin
  if p_party_id is null or not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v from public.customer_parties c where c.id = p_party_id;
  if v.id is null or not (v.legal_entity_id = any(authz.acct_a_entities())) then
    return null;
  end if;
  return jsonb_build_object('partyId', v.id, 'name', v.tally_ledger_name, 'rowVersion', v.row_version);
end;
$$;

-- ===========================================================================
-- 8. C2: the Tally file switch and company name
-- ===========================================================================

-- p_company_name: null keeps the saved name; text sets it (trimmed, 1..100,
-- no control characters). Turning on needs a name.
create function public.admin_set_tally_xml(p_entity uuid, p_enabled boolean, p_company_name text, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before public.accounts_settings%rowtype;
  v_after public.accounts_settings%rowtype;
  v_reason text;
  v_prev text[];
  v_name text;
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
  select * into v_before from public.accounts_settings s where s.legal_entity_id = p_entity for update;
  if p_company_name is null then
    v_name := v_before.tally_company_name;
  else
    v_name := btrim(p_company_name);
    if char_length(v_name) not between 1 and 100 or v_name ~ '[[:cntrl:]]' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'companyName';
    end if;
  end if;
  if p_enabled and v_name is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'companyName';
  end if;
  v_prev := authz.settings_begin_change('admin_set_tally_xml', v_reason);
  insert into public.accounts_settings as s (legal_entity_id, tally_xml_enabled, tally_company_name, updated_by)
  values (p_entity, p_enabled, v_name, (select auth.uid()))
  on conflict (legal_entity_id) do update
    set tally_xml_enabled = excluded.tally_xml_enabled, tally_company_name = excluded.tally_company_name,
        updated_by = excluded.updated_by, updated_at = now(), row_version = s.row_version + 1
    where s.tally_xml_enabled is distinct from excluded.tally_xml_enabled
       or s.tally_company_name is distinct from excluded.tally_company_name
  returning * into v_after;
  perform authz.settings_end_change(v_prev);
  if v_after.legal_entity_id is null then
    select * into v_after from public.accounts_settings s where s.legal_entity_id = p_entity;
  end if;
  return jsonb_build_object(
    'changed', coalesce(v_before.tally_xml_enabled, false) is distinct from p_enabled
               or v_before.tally_company_name is distinct from v_name,
    'tallyXmlEnabled', v_after.tally_xml_enabled, 'tallyCompanyName', v_after.tally_company_name,
    'rowVersion', v_after.row_version, 'updatedAt', v_after.updated_at);
end;
$$;

-- ===========================================================================
-- 9. Grants
-- ===========================================================================

revoke all on function authz.tally_match_batches_guard() from public, anon, authenticated, service_role;
revoke all on function public.customer_party_tally_name_set(uuid, integer, text, uuid), public.customer_party_tally_name(uuid),
  public.admin_set_tally_xml(uuid, boolean, text, text)
  from public, anon, authenticated, service_role;
grant execute on function public.customer_party_tally_name_set(uuid, integer, text, uuid), public.customer_party_tally_name(uuid),
  public.admin_set_tally_xml(uuid, boolean, text, text)
  to authenticated;

commit;
