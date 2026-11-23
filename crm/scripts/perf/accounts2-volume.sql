-- SYNTHETIC Accounts phase 2 volume for local speed measurements only
-- (contract accounts-phase2-2026-11-11, section 12.5; plan C13).
-- Run AFTER scripts/perf/accounts-volume.sql (10,000 SYN-PERF Deals) on a
-- disposable LOCAL stack:
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/perf/accounts2-volume.sql
-- Smaller validation run: PGOPTIONS='-c perf.scale=0.01'.
--
-- Adds: 8,000 released customer Invoices with succeeded render jobs and
-- stored PDF files (plus their counters); 1,500 overpayment refund requests
-- paid out (refund evidence, refund_bank journal entries and lines,
-- payouts); 3,000 suppliers (kind direct/channel, GSTIN/PAN/state) with
-- 6,000 contacts, 3,000 catalogue hotels and 9,000 hotel links, 20,000
-- history rows; 2,000 approved trip cancellations with a Flight charge on
-- their ticket batch. Tally mapping: the migration pre-fills 51 rows per
-- entity (contract 8.1); 9 synthetic per-service supplier_payment rows copy
-- each entity's 'any' row (same ledgers and voucher type, so mapped export
-- columns are unchanged) to reach the 60 rows of section 12.5. Synthetic references only (SYN-PERF-…,
-- @example.test, SYNPERF GSTINs). The notices switch is off while seeding
-- (restored at the end). Same guards as accounts-volume.sql; refuses a
-- second run.
do $$
begin
  if (select environment from public.deployment_settings limit 1) is distinct from 'test' then
    raise exception 'accounts2-volume.sql runs only on a synthetic (test) database';
  end if;
  if not exists (select 1 from public.legal_entities where code = 'SYNTHETIC_B' and is_synthetic)
     or not exists (select 1 from public.integration_intake_config
                    where id = 'c0000000-0000-4000-8000-000000000001' and portal_domain = 'synthetic-portal.example.test') then
    raise exception 'accounts2-volume.sql runs only on a database seeded with the synthetic fixtures (scripts/seed-local.mjs)';
  end if;
  if (select count(*) from public.deals where reference like 'SYN-PERF-%') < 100 then
    raise exception 'run scripts/perf/accounts-volume.sql first (SYN-PERF Deals missing)';
  end if;
  if exists (select 1 from public.customer_documents where number like 'SYN-PERF-%') then
    raise exception 'accounts2-volume.sql already ran on this database; reset the local stack first';
  end if;
end $$;

begin;
set local lock_timeout = '15s';
select set_config('perf.scale', coalesce(nullif(current_setting('perf.scale', true), ''), '1'), true);
create or replace function pg_temp.n(p integer) returns integer language sql immutable as
  $$ select greatest(1, (p * current_setting('perf.scale')::numeric)::integer) $$;
create or replace function pg_temp.h(p text) returns text language sql immutable as $$ select encode(sha256(convert_to(p, 'UTF8')), 'hex') $$;

create temporary table perf2_switch on commit drop as select notices_enabled from public.notice_settings where id;
update public.notice_settings set notices_enabled = false where id;

create temporary table perf2_ctx on commit drop as
select e.id as entity_id,
       (select user_id from public.staff_profiles where work_email = 'perf.staff.11@example.test') as acc1,
       (select user_id from public.staff_profiles where work_email = 'perf.staff.12@example.test') as acc2,
       (select user_id from public.staff_profiles where work_email = 'perf.staff.19@example.test') as purchase,
       (select user_id from public.staff_profiles where work_email = 'perf.staff.23@example.test') as flight,
       (select user_id from public.staff_profiles where work_email = 'perf.staff.16@example.test') as manager
from public.legal_entities e where e.code = 'HOLIDAY_CHACHA';

-- The SYN-PERF Deals in seed order with their confirmed version.
create temporary table perf2_deals on commit drop as
select row_number() over (order by d.reference) as n, d.id as deal_id, d.branch_id, d.reference, d.created_at, v.id as version_id,
       c.selling_total_paise as selling
from public.deals d
join public.booking_versions v on v.deal_id = d.id and v.version_no = 1
join public.booking_version_commercials c on c.version_id = v.id
where d.reference like 'SYN-PERF-%';
analyze perf2_deals;

-- ---------------------------------------------------------------------------
-- 8,000 released Invoices (one per Deal), succeeded render job, stored file
-- ---------------------------------------------------------------------------
create temporary table perf2_docs on commit drop as
select d.n, d.deal_id, d.branch_id, d.reference, d.version_id, d.selling, d.created_at, gen_random_uuid() as doc_id, gen_random_uuid() as job_id,
       jsonb_build_object('schema', 'cdoc-1', 'kind', 'invoice', 'title', 'Invoice', 'number', d.reference || '-INV-1',
         'issueDate', (d.created_at + interval '5 days')::date,
         'company', jsonb_build_object('legalName', 'Holiday Chacha Pvt Ltd', 'registeredAddress', 'Synthetic registered address', 'pan', 'AAAAA0000A',
           'gstin', '08AAAAA0000A1Z5', 'gstinState', 'Rajasthan'),
         'branch', jsonb_build_object('code', null, 'name', null),
         'customer', jsonb_build_object('billingName', 'Synthetic Perf Billing ' || d.n, 'addressLine1', '1 Synthetic Road', 'addressLine2', null,
           'city', 'Jodhpur', 'stateCode', '08', 'postalCode', '342001', 'gstin', null),
         'deal', jsonb_build_object('reference', d.reference, 'dealNumber', null),
         'trip', jsonb_build_object('destination', 'Synthetic City', 'startDate', null, 'endDate', null, 'travellerCount', 2),
         'lines', jsonb_build_array(jsonb_build_object('label', 'Holiday package — Synthetic City', 'amountPaise', d.selling::text)),
         'totalPaise', d.selling::text, 'paidPaise', '0', 'balancePaise', d.selling::text, 'payment', null, 'credits', null,
         'gstInvoiceNumber', null, 'replaces', null) as content
from perf2_deals d where d.n <= pg_temp.n(8000);

insert into public.customer_documents (id, legal_entity_id, branch_id, deal_id, kind, status, number, seq, basis_version_id, content, content_sha256,
  source_hash, total_paise, issue_date, created_by, created_at, request_id, released_by, released_at, release_request_id)
select x.doc_id, c.entity_id, x.branch_id, x.deal_id, 'invoice', 'released', x.reference || '-INV-1', 1, x.version_id, x.content,
       pg_temp.h(x.content::text), pg_temp.h('src-' || x.n), x.selling, (x.created_at + interval '5 days')::date, c.acc1, x.created_at + interval '4 days',
       gen_random_uuid(), c.acc1, x.created_at + interval '5 days', gen_random_uuid()
from perf2_docs x cross join perf2_ctx c;
insert into public.customer_document_counters (deal_id, kind, last_no) select deal_id, 'invoice', 1 from perf2_docs;
insert into public.customer_document_render_jobs (id, legal_entity_id, document_id, content_sha256, template_version, status, attempts, requested_by,
  created_at, started_at, finished_at)
select x.job_id, c.entity_id, x.doc_id, pg_temp.h(x.content::text), 'customer-document-1', 'succeeded', 1, c.acc1, x.created_at + interval '5 days',
       x.created_at + interval '5 days', x.created_at + interval '5 days 10 seconds'
from perf2_docs x cross join perf2_ctx c;
insert into public.customer_document_files (legal_entity_id, document_id, render_job_id, object_path, sha256, size_bytes, page_count, created_at)
select c.entity_id, x.doc_id, x.job_id, c.entity_id::text || '/customer-documents/' || x.doc_id::text || '/' || x.job_id::text || '.pdf',
       pg_temp.h('pdf-' || x.n), 48000, 1, x.created_at + interval '5 days 10 seconds'
from perf2_docs x cross join perf2_ctx c;
analyze public.customer_documents, public.customer_document_render_jobs, public.customer_document_files, public.customer_document_counters;

-- ---------------------------------------------------------------------------
-- 1,500 paid overpayment refunds (original payer = a verified perf receipt)
-- ---------------------------------------------------------------------------
create temporary table perf2_refunds on commit drop as
select row_number() over (order by r.receipt_no) as n, r.id as receipt_id, r.deal_id, r.branch_id, r.payer_name, r.received_on,
       gen_random_uuid() as req_id, gen_random_uuid() as ev_id, gen_random_uuid() as entry_id, gen_random_uuid() as payout_id
from (select distinct on (r.deal_id) r.* from public.customer_receipts r join perf2_deals d on d.deal_id = r.deal_id
      where r.status = 'verified' order by r.deal_id, r.receipt_no) r
limit pg_temp.n(1500);

insert into public.customer_refund_requests (id, legal_entity_id, branch_id, deal_id, ref_no, kind, outcome, requested_as, held_at_request_paise,
  customer_charge_paise, amount_paise, payee_kind, payee_name, payee_receipt_id, reason, status, requested_by, requested_at, request_id, decided_by,
  decided_at, decision_request_id, paid_at, row_version)
select x.req_id, c.entity_id, x.branch_id, x.deal_id, 'RF-2026-' || lpad((800000 + x.n)::text, 6, '0'), 'overpayment', 'payout', 'manager', 1000, 0, 1000,
       'original_payer', x.payer_name, x.receipt_id, 'Synthetic perf refund: customer paid twice', 'paid', c.manager, now() - interval '3 days',
       gen_random_uuid(), (select user_id from public.staff_profiles where work_email = 'perf.staff.17@example.test'), now() - interval '2 days',
       gen_random_uuid(), now() - interval '1 day', 3
from perf2_refunds x cross join perf2_ctx c;
insert into public.refund_evidence (id, legal_entity_id, deal_id, subject_kind, subject_id, object_path, file_name, mime, size_bytes, sha256, status,
  uploaded_by, request_id, stored_at)
select x.ev_id, c.entity_id, x.deal_id, 'customer_refund', x.req_id, c.entity_id::text || '/refund/' || x.req_id::text || '/' || x.ev_id::text,
       'refund-proof.pdf', 'application/pdf', 2048, pg_temp.h('refund-proof-' || x.n), 'stored', c.acc1, gen_random_uuid(), now() - interval '1 day'
from perf2_refunds x cross join perf2_ctx c;
-- Journal entry first (its payout FK is deferred), then lines, then the payout.
insert into public.finance_journal_entries (id, legal_entity_id, kind, receipt_id, deal_id, branch_id, business_date, posted_by, posted_at, refund_payout_id)
select x.entry_id, c.entity_id, 'refund_bank', null, x.deal_id, x.branch_id, (now() - interval '1 day')::date, c.acc1, now() - interval '1 day', x.payout_id
from perf2_refunds x cross join perf2_ctx c;
insert into public.finance_journal_lines (entry_id, account, deal_id, branch_id, debit_paise, credit_paise)
select x.entry_id, a.account, x.deal_id, x.branch_id, case a.account when 'customer_advances' then 1000 else 0 end,
       case a.account when 'bank' then 1000 else 0 end
from perf2_refunds x cross join (values ('customer_advances'), ('bank')) a(account);
insert into public.customer_refund_payouts (id, legal_entity_id, branch_id, deal_id, refund_request_id, amount_paise, mode, paid_on, reference, evidence_id,
  journal_entry_id, recorded_by, recorded_at, request_id)
select x.payout_id, c.entity_id, x.branch_id, x.deal_id, x.req_id, 1000, 'bank_transfer', (now() - interval '1 day')::date, 'SYNRF' || lpad(x.n::text, 6, '0'),
       x.ev_id, x.entry_id, c.acc1, now() - interval '1 day', gen_random_uuid()
from perf2_refunds x cross join perf2_ctx c;
analyze public.customer_refund_requests, public.customer_refund_payouts, public.refund_evidence, public.finance_journal_entries, public.finance_journal_lines;

-- ---------------------------------------------------------------------------
-- 3,000 suppliers, 6,000 contacts, 3,000 hotels, 9,000 hotel links, 20,000 history rows
-- ---------------------------------------------------------------------------
create temporary table perf2_sup on commit drop as
select g as n, gen_random_uuid() as id, gen_random_uuid() as hotel_id,
       -- Synthetic GSTIN/PAN pairs: PAN SYNPx<4 digits>Z..., GSTIN 08 + PAN + 1Z + check char 5.
       'SYNP' || chr(65 + (g % 26)) || lpad((g % 10000)::text, 4, '0') || 'Z' as pan,
       (array['Jodhpur', 'Jaipur', 'Udaipur', 'Delhi', 'Ahmedabad', 'Jaisalmer'])[1 + g % 6] as city
from generate_series(1, pg_temp.n(3000)) g;
insert into public.suppliers (id, legal_entity_id, name, service_types, city, contact_name, contact_email, supplier_kind, gstin, pan, state_code,
  source_ref, created_by, updated_by)
select s.id, c.entity_id, 'Synthetic Perf Stays ' || lpad(s.n::text, 5, '0'), array['hotel', 'transfer'], s.city, 'Synthetic Desk ' || s.n,
       'desk' || s.n || '@example.test', case when s.n % 5 = 0 then 'channel' else 'direct' end,
       case when s.n % 3 = 0 then '08' || s.pan || '1Z5' end, s.pan, case when s.n % 3 = 0 then '08' end, 'PERF:S-' || s.n, c.purchase, c.purchase
from perf2_sup s cross join perf2_ctx c;
insert into public.supplier_contacts (legal_entity_id, supplier_id, name, role_label, phone, email, is_primary, created_by, updated_by)
select c.entity_id, s.id, 'Synthetic Desk ' || s.n || case k when 2 then ' (accounts)' else '' end, case k when 2 then 'Accounts' end,
       '+91 00000 ' || lpad(((s.n * 2 + k) % 100000)::text, 5, '0'), 'desk' || s.n || case k when 2 then '.acc' else '' end || '@example.test', k = 1,
       c.purchase, c.purchase
from perf2_sup s cross join perf2_ctx c cross join generate_series(1, 2) k;
insert into public.hotel_catalogue (id, legal_entity_id, name, city, source_ref, created_by, updated_by)
select s.hotel_id, c.entity_id, 'Synthetic Perf Hotel ' || lpad(s.n::text, 5, '0'), s.city, 'PERF:H-' || s.n, c.purchase, c.purchase
from perf2_sup s cross join perf2_ctx c;
insert into public.supplier_hotels (legal_entity_id, supplier_id, hotel_id, source, created_by)
select c.entity_id, s.id, h.hotel_id, 'manual', c.purchase
from perf2_sup s cross join perf2_ctx c cross join generate_series(0, 2) k
join perf2_sup h on h.n = 1 + ((s.n + k * 997) % (select count(*) from perf2_sup));
insert into public.supplier_changes (legal_entity_id, supplier_id, changed_at, changed_by, source, field, old_value, new_value)
select c.entity_id, s.id, now() - ((g % 700) || ' hours')::interval, c.purchase, case g % 4 when 0 then 'edit' when 1 then 'contact' when 2 then 'hotel_link'
       else 'import' end, case g % 4 when 0 then 'city' when 1 then 'contact:primary' when 2 then 'hotel' else 'payment_terms' end,
       'Synthetic old ' || g, 'Synthetic new ' || g
from generate_series(1, pg_temp.n(20000)) g join perf2_sup s on s.n = 1 + (g % (select count(*) from perf2_sup)) cross join perf2_ctx c;
analyze public.suppliers, public.supplier_contacts, public.hotel_catalogue, public.supplier_hotels, public.supplier_changes;

-- ---------------------------------------------------------------------------
-- 2,000 approved cancellations with one Flight charge on the Deal's batch
-- ---------------------------------------------------------------------------
create temporary table perf2_cx on commit drop as
select row_number() over (order by b.deal_id) as n, b.id as batch_id, b.deal_id, b.branch_id, b.cost_task_id, b.supplier_id, b.supplier_cost_paise,
       gen_random_uuid() as cancellation_id
from (select distinct on (b.deal_id) b.* from public.flight_ticket_batches b join perf2_deals d on d.deal_id = b.deal_id
      order by b.deal_id, b.batch_no) b
limit pg_temp.n(2000);
insert into public.deal_cancellations (id, legal_entity_id, branch_id, deal_id, reason, status, opened_by, opened_at, request_id, sent_by, sent_at,
  sent_request_id, decided_by, decided_at, decision_request_id)
select x.cancellation_id, c.entity_id, x.branch_id, x.deal_id, 'Synthetic perf: customer cancelled', 'approved', c.manager, now() - interval '4 days',
       gen_random_uuid(), c.flight, now() - interval '3 days', gen_random_uuid(), c.manager, now() - interval '2 days', gen_random_uuid()
from perf2_cx x cross join perf2_ctx c;
insert into public.flight_cancellation_charges (cancellation_id, legal_entity_id, deal_id, batch_id, cost_task_id, supplier_id, revision_no,
  supplier_cost_paise, airline_charge_paise, refund_expected_paise, note, entered_by, entered_at, request_id)
select x.cancellation_id, c.entity_id, x.deal_id, x.batch_id, x.cost_task_id, x.supplier_id, 1, x.supplier_cost_paise, 150000,
       greatest(x.supplier_cost_paise - 150000, 0), 'Synthetic perf airline charge', c.flight, now() - interval '3 days 1 hour', gen_random_uuid()
from perf2_cx x cross join perf2_ctx c;
analyze public.deal_cancellations, public.flight_cancellation_charges;

-- Contract 12.5: 60 Tally mapping rows per entity (51 pre-filled by 20261204000400 + 9 synthetic copies of the
-- entity's supplier_payment 'any' row; the export resolves exact class first, so its mapped values stay the same).
insert into public.tally_ledger_mappings (legal_entity_id, row_kind, service_class, debit_ledger, credit_ledger, voucher_type)
select m.legal_entity_id, m.row_kind, c.service_class, m.debit_ledger, m.credit_ledger, m.voucher_type
from public.tally_ledger_mappings m
cross join (values ('hotel'), ('transfer'), ('activity'), ('flight_domestic'), ('flight_international'), ('package_domestic'),
                   ('package_overseas'), ('visa'), ('passport')) c(service_class)
where m.row_kind = 'supplier_payment' and m.service_class = 'any'
on conflict (legal_entity_id, row_kind, service_class) do nothing;

update public.notice_settings set notices_enabled = (select notices_enabled from perf2_switch) where id;

do $$
declare
  v_mappings integer := (select count(*) from public.tally_ledger_mappings m join public.legal_entities e on e.id = m.legal_entity_id
                         where e.code = 'HOLIDAY_CHACHA');
begin
  raise notice 'accounts2-volume: documents %, refunds paid %, suppliers %, contacts %, hotel links %, history %, flight charges %, mapping rows %',
    (select count(*) from public.customer_documents where number like 'SYN-PERF-%'),
    (select count(*) from public.customer_refund_payouts where reference like 'SYNRF%'),
    (select count(*) from public.suppliers where source_ref like 'PERF:S-%'),
    (select count(*) from public.supplier_contacts c join public.suppliers s on s.id = c.supplier_id where s.source_ref like 'PERF:S-%'),
    (select count(*) from public.supplier_hotels h join public.suppliers s on s.id = h.supplier_id where s.source_ref like 'PERF:S-%'),
    (select count(*) from public.supplier_changes h join public.suppliers s on s.id = h.supplier_id where s.source_ref like 'PERF:S-%'),
    (select count(*) from public.flight_cancellation_charges where note = 'Synthetic perf airline charge'),
    v_mappings;
end $$;
commit;
