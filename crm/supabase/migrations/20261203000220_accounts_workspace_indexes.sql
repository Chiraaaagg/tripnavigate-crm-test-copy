-- Accounts phase, Track B (3 of 6): ordering and search indexes for the
-- Accounts "Documents and money" workspace (public.accounts_records).
-- Contract: implementation/accounts-phase-2026-11-10/contract.md section
-- 6.2.8 (frozen 10 Nov 2026).
--
-- Ordering (each source: entity, record date desc, created timestamp desc,
-- id desc). Kinds that only have a timestamp (supplier payments, company
-- funding, ticket batches) order by that timestamp: the record date is its
-- IST date, so the order is the same. Company-paid expense records use the
-- IST date of created_at when paid_on is empty (timezone() with a fixed zone
-- is immutable, so the expression can be indexed).
--
-- Search: supplier_documents (legal_entity_id, number_norm) was created by
-- 20261203000210; existing unique indexes serve receipt_no, ref_no,
-- deals.reference and flight_ticket_numbers (legal_entity_id, ticket_digits).
--
-- No data changes. Rollback (forward-only): a NEW migration dropping these
-- indexes.

begin;
set local lock_timeout = '15s';

create index customer_receipts_ws_order_idx
  on public.customer_receipts (legal_entity_id, received_on desc, recorded_at desc, id desc);
create index finance_journal_entries_ws_reversal_idx
  on public.finance_journal_entries (legal_entity_id, business_date desc, posted_at desc, id desc)
  where kind like 'reversal%';
create index customer_payment_claims_ws_order_idx
  on public.customer_payment_claims (legal_entity_id, paid_on desc, reported_at desc, id desc);
create index cash_deposits_ws_order_idx
  on public.cash_deposits (legal_entity_id, deposited_on desc, recorded_at desc, id desc);
create index cash_reconciliations_ws_order_idx
  on public.cash_reconciliations (legal_entity_id, business_date desc, recorded_at desc, id desc);
create index supplier_payment_requests_ws_order_idx
  on public.supplier_payment_requests (legal_entity_id, requested_at desc, id desc);
create index company_funding_requests_ws_order_idx
  on public.company_funding_requests (legal_entity_id, requested_at desc, id desc);
create index supplier_documents_ws_order_idx
  on public.supplier_documents (legal_entity_id, doc_date desc, uploaded_at desc, id desc);
create index department_cost_entries_ws_order_idx
  on public.department_cost_entries (legal_entity_id,
    (coalesce(paid_on, (timezone('Asia/Kolkata', created_at))::date)) desc, created_at desc, id desc)
  where paid_by = 'company';
create index flight_ticket_batches_ws_order_idx
  on public.flight_ticket_batches (legal_entity_id, confirmed_at desc, id desc);
create index visa_applications_ws_order_idx
  on public.visa_applications (legal_entity_id, applied_on desc, submitted_at desc, id desc)
  where submitted_at is not null;
create index deal_tally_invoices_ws_order_idx
  on public.deal_tally_invoices (legal_entity_id, invoice_date desc, created_at desc, id desc);

-- Exact-reference search.
create index flight_ticket_revisions_airline_pnr_idx
  on public.flight_ticket_revisions (legal_entity_id, airline_pnr);
create index flight_ticket_revisions_crs_pnr_idx
  on public.flight_ticket_revisions (legal_entity_id, crs_pnr) where crs_pnr is not null;
create index visa_applications_reference_idx
  on public.visa_applications (legal_entity_id, lower(reference)) where reference is not null;
create index deal_tally_invoices_ref_norm_idx
  on public.deal_tally_invoices (legal_entity_id, ref_norm);

-- Dues: open claims per Deal (reportedPaise) and receipts awaiting verification.
create index customer_payment_claims_reported_deal_idx
  on public.customer_payment_claims (deal_id) where status = 'reported';

commit;
