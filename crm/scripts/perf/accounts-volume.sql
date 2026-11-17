-- SYNTHETIC Accounts-phase volume for local speed measurements only
-- (contract accounts-phase-2026-11-10, section 12.7; plan 17.3).
-- Run after scripts/seed-local.mjs on a disposable LOCAL stack:
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/perf/accounts-volume.sql
-- Optional smaller run (validation): psql ... -c "set perf.scale = '0.01'" is
-- not kept across files, so pass PGOPTIONS='-c perf.scale=0.01' instead.
--
-- About three years of expected volume: 10,000 Deals (three branches);
-- 30,000 service items and tasks (hotel, flight, visa per Deal); 50,000 money
-- records (15,000 receipts with journal entries, 5,000 claims, 9,000 supplier
-- payment requests, 7,000 supplier documents, 9,000 expense records, 3,000
-- cash deposits, 2,000 cash counts); 20,000 tickets; 5,000 visa
-- applications; 200,000 notices across 30 synthetic staff
-- (perf.staff.NN@example.test); Tally rows for 20,000 records and 60 exports.
-- Synthetic references only (SYN-PERF-…, @example.test). The notices switch is
-- off while seeding; notices are inserted directly. Never run it on a hosted
-- database: the guard below refuses anything not labelled 'test' or missing
-- the fixture markers of scripts/seed-local.mjs (same guard as volume.sql).
do $$
begin
  if (select environment from public.deployment_settings limit 1) is distinct from 'test' then
    raise exception 'accounts-volume.sql runs only on a synthetic (test) database';
  end if;
  if not exists (select 1 from public.legal_entities where code = 'SYNTHETIC_B' and is_synthetic)
     or not exists (select 1 from public.integration_intake_config
                    where id = 'c0000000-0000-4000-8000-000000000001' and portal_domain = 'synthetic-portal.example.test')
     or (select count(*) from public.staff_profiles
         where (user_id, work_email) in (('a0000000-0000-4000-8000-000000000001'::uuid, 'sales.delhi.a@example.test'),
                                         ('a0000000-0000-4000-8000-000000000002'::uuid, 'sales.delhi.b@example.test'))) <> 2 then
    raise exception 'accounts-volume.sql runs only on a database seeded with the synthetic fixtures (scripts/seed-local.mjs)';
  end if;
  if exists (select 1 from public.deals where reference like 'SYN-PERF-%') then
    raise exception 'accounts-volume.sql already ran on this database (SYN-PERF- Deals exist); reset the local stack first';
  end if;
end $$;

begin;
set local lock_timeout = '15s';
select set_config('perf.scale', coalesce(nullif(current_setting('perf.scale', true), ''), '1'), true);
create function pg_temp.n(p integer) returns integer language sql immutable as
  $$ select greatest(1, (p * current_setting('perf.scale')::numeric)::integer) $$;

-- Notices off while seeding (direct inserts below); restored at the end.
create temporary table perf_switch on commit drop as select notices_enabled from public.notice_settings where id;
update public.notice_settings set notices_enabled = false where id;

create temporary table perf_ctx on commit drop as
select e.id as entity_id,
       (select id from public.branches where legal_entity_id = e.id and code = 'DEL') as del,
       (select id from public.branches where legal_entity_id = e.id and code = 'JDH') as jdh,
       (select id from public.branches where legal_entity_id = e.id and code = 'AMD') as amd,
       (select id from public.finance_policy_versions p where p.legal_entity_id = e.id order by p.effective_at desc limit 1) as policy
from public.legal_entities e where e.code = 'HOLIDAY_CHACHA';

-- ---------------------------------------------------------------------------
-- 30 synthetic staff across the three branches and the roles
-- ---------------------------------------------------------------------------
create temporary table perf_staff on commit drop as
select g as n,
       ('b0000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid as user_id,
       'perf.staff.' || lpad(g::text, 2, '0') || '@example.test' as email,
       case when g <= 10 then 'sales' when g <= 15 then 'accounts' when g <= 18 then 'manager'
            when g <= 22 then 'purchase' when g <= 26 then 'flight' else 'visa' end as role,
       case g % 3 when 0 then 'DEL' when 1 then 'JDH' else 'AMD' end as branch
from generate_series(1, 30) g;
-- Managers: one per branch.
update perf_staff set branch = case n when 16 then 'DEL' when 17 then 'JDH' else 'AMD' end where role = 'manager';

insert into auth.users (id, email) select user_id, email from perf_staff on conflict (id) do nothing;
insert into public.staff_profiles (user_id, display_name, work_email, status, activated_at)
select user_id, 'Synthetic Perf Staff ' || lpad(n::text, 2, '0'), email, 'active', now() from perf_staff
on conflict (user_id) do nothing;
insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
select s.user_id, c.entity_id, b.id, s.role, 'active'
from perf_staff s cross join perf_ctx c join public.branches b on b.legal_entity_id = c.entity_id and b.code = s.branch
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- 10,000 Deals, one confirmed package version each, plan of two instalments
-- ---------------------------------------------------------------------------
create temporary table perf_deals on commit drop as
select g as n, gen_random_uuid() as deal_id, gen_random_uuid() as version_id,
       -- Every tenth Deal belongs to a fixture Sales user, so the signed-in load (accounts-load.mjs) reports claims on its own Deals.
       case g % 10 when 1 then 'a0000000-0000-4000-8000-000000000001'::uuid when 2 then 'a0000000-0000-4000-8000-000000000002'::uuid
                   when 3 then 'a0000000-0000-4000-8000-000000000004'::uuid
                   else (select user_id from perf_staff where role = 'sales' order by n offset (g % 10) limit 1) end as owner_id,
       case g % 3 when 0 then (select del from perf_ctx) when 1 then (select jdh from perf_ctx) else (select amd from perf_ctx) end as branch_id,
       -- At least 12 days old, so every derived date (receipt +2, bill +10, fees +8 days) is in the past.
       (now() - (((g % 1095) + 12) || ' days')::interval) as created_at,
       (1000000 + (g % 97) * 10000)::bigint as selling
from generate_series(1, pg_temp.n(10000)) g;

insert into public.deals (id, legal_entity_id, branch_id, reference, title, owner_user_id, created_at)
select deal_id, (select entity_id from perf_ctx), branch_id, 'SYN-PERF-' || lpad(n::text, 5, '0'), 'Synthetic perf booking ' || n, owner_id, created_at
from perf_deals;

-- Drafts first (commercials and plan are immutable once confirmed), confirmed after the plan below.
insert into public.booking_versions (id, deal_id, legal_entity_id, branch_id, version_no, service_type, status, content_hash, created_by, created_at)
select version_id, deal_id, (select entity_id from perf_ctx), branch_id, 1, 'package', 'draft', encode(sha256(('perf-v-' || n)::bytea), 'hex'),
       owner_id, created_at
from perf_deals;
analyze public.deals, public.booking_versions;
insert into public.booking_version_commercials (version_id, legal_entity_id, selling_total_paise)
select version_id, (select entity_id from perf_ctx), selling from perf_deals;
analyze public.booking_version_commercials;
insert into public.booking_version_instalments (booking_version_id, deal_id, legal_entity_id, seq, label, amount_paise, due_date)
select d.version_id, d.deal_id, (select entity_id from perf_ctx), i.seq, case i.seq when 1 then 'Advance' else 'Balance' end,
       case i.seq when 1 then d.selling / 2 else d.selling - d.selling / 2 end,
       (d.created_at + (case i.seq when 1 then 7 else 45 end || ' days')::interval)::date
from perf_deals d cross join (values (1), (2)) i(seq);
update public.booking_versions v set status = 'confirmed', confirmed_at = d.created_at + interval '1 hour', confirmed_by = d.owner_id
from perf_deals d where v.id = d.version_id;
insert into public.accounts_booking_reviews (booking_version_id, deal_id, legal_entity_id, status, reviewed_by, reviewed_at)
select version_id, deal_id, (select entity_id from perf_ctx), 'approved', (select user_id from perf_staff where role = 'accounts' limit 1), created_at + interval '1 day'
from perf_deals where n % 10 < 7;

-- ---------------------------------------------------------------------------
-- 30,000 service items and tasks (hotel / flight / visa per Deal)
-- ---------------------------------------------------------------------------
analyze perf_deals;
create temporary table perf_items on commit drop as
select d.n, d.deal_id, d.version_id, d.branch_id, d.created_at, d.owner_id, t.item_no, t.service_type, t.department,
       gen_random_uuid() as item_id, gen_random_uuid() as task_id,
       (select user_id from perf_staff s where s.role = t.department order by s.n offset (d.n % 4) limit 1) as assignee
from perf_deals d cross join (values (1, 'hotel', 'purchase'), (2, 'flight', 'flight'), (3, 'visa', 'visa')) t(item_no, service_type, department);

insert into public.service_items (id, deal_id, legal_entity_id, branch_id, item_no, service_type, department, created_by, request_id)
select item_id, deal_id, (select entity_id from perf_ctx), branch_id, item_no, service_type, department, owner_id, gen_random_uuid() from perf_items;
insert into public.fulfilment_tasks (id, deal_id, legal_entity_id, branch_id, booking_version_id, task_key, created_by, service_item_id, department,
  service_purpose, status, assignee_user_id, created_at)
select task_id, deal_id, (select entity_id from perf_ctx), branch_id, version_id, 'item:' || item_id || ':' || service_type, owner_id, item_id, department, service_type,
       'in_progress', assignee, created_at
from perf_items;
analyze public.service_items, public.fulfilment_tasks;

-- One approved synthetic company bank destination for the bank receipts.
create temporary table perf_dest on commit drop as select gen_random_uuid() as dest_id, gen_random_uuid() as version_id;
insert into public.company_destinations (id, legal_entity_id, kind, label, is_synthetic, created_by)
select dest_id, (select entity_id from perf_ctx), 'bank', 'Synthetic perf destination', true, 'a0000000-0000-4000-8000-000000000006' from perf_dest;
insert into public.company_destination_versions (id, legal_entity_id, destination_id, version_no, holder_name, bank_name, account_number, ifsc, status,
  maker, request_id, decided_by, decided_at)
select version_id, (select entity_id from perf_ctx), dest_id, 1, 'Synthetic Holder', 'Synthetic Bank', '000123456789', 'SYNB0000001', 'approved',
       'a0000000-0000-4000-8000-000000000006', gen_random_uuid(), 'a0000000-0000-4000-8000-000000000011', now() from perf_dest;
update public.company_destinations d set current_version_id = p.version_id from perf_dest p where d.id = p.dest_id;

-- ---------------------------------------------------------------------------
-- 15,000 receipts (verified bank, posted) with journal entries and lines
-- ---------------------------------------------------------------------------
create temporary table perf_receipts on commit drop as
select g as n, gen_random_uuid() as id, d.deal_id, d.branch_id, d.created_at, (100000 + (g % 50) * 1000)::bigint as amount
from generate_series(1, pg_temp.n(15000)) g join perf_deals d on d.n = 1 + (g % (select count(*) from perf_deals));

insert into public.customer_receipts (id, legal_entity_id, deal_id, branch_id, receipt_no, fiscal_year, mode, status, amount_paise, received_on,
  payer_name, payer_pan, reference, reference_norm, destination_version_id, destination_snapshot, policy_version_id, request_id, recorded_by, recorded_at, verified_by, verified_at)
select r.id, c.entity_id, r.deal_id, r.branch_id, 'R-2025-26-' || lpad((700000 + r.n)::text, 6, '0'), '2025-26', 'bank_transfer', 'verified', r.amount,
       (r.created_at + interval '2 days')::date, 'Synthetic Perf Payer ' || r.n, 'ABCDE1234F', 'SYNPERF' || lpad(r.n::text, 8, '0'),
       'SYNPERF' || lpad(r.n::text, 8, '0'), (select version_id from perf_dest),
       -- The shape public.receipt_record stores (20261110000100 / 20261119000300): versionNo is always present.
       (select jsonb_build_object('destinationId', pd.dest_id, 'versionId', pd.version_id, 'versionNo', 1, 'kind', 'bank',
          'label', 'Synthetic perf destination', 'holderName', 'Synthetic Holder', 'bankName', 'Synthetic Bank',
          'accountNumber', '000123456789', 'ifsc', 'SYNB0000001', 'payeeName', null, 'upiId', null) from perf_dest pd), c.policy, gen_random_uuid(), (select user_id from perf_staff where role = 'accounts' order by n limit 1),
       r.created_at + interval '2 days', (select user_id from perf_staff where role = 'accounts' order by n offset 1 limit 1), r.created_at + interval '3 days'
from perf_receipts r cross join perf_ctx c;
analyze public.customer_receipts;
insert into public.finance_journal_entries (id, legal_entity_id, kind, receipt_id, deal_id, branch_id, business_date, posted_by, posted_at)
select r.id, c.entity_id, 'receipt_bank', r.id, r.deal_id, r.branch_id, (r.created_at + interval '2 days')::date,
       (select user_id from perf_staff where role = 'accounts' order by n offset 1 limit 1), r.created_at + interval '3 days'
from perf_receipts r cross join perf_ctx c;
analyze public.finance_journal_entries;
insert into public.finance_journal_lines (entry_id, account, deal_id, branch_id, debit_paise, credit_paise)
select r.id, x.account, r.deal_id, r.branch_id, case x.account when 'bank' then r.amount else 0 end, case x.account when 'bank' then 0 else r.amount end
from perf_receipts r cross join (values ('bank'), ('customer_advances')) x(account);

-- 5,000 claims (reported / linked / withdrawn)
insert into public.customer_payment_claims (legal_entity_id, deal_id, booking_version_id, mode, status, amount_paise, paid_on, payer_name, reported_by,
  request_id, reported_at)
select (select entity_id from perf_ctx), d.deal_id, d.version_id, 'cash', 'reported', 50000 + g, (d.created_at + interval '1 day')::date,
       'Synthetic Perf Claimant ' || g, d.owner_id, gen_random_uuid(), d.created_at + interval '1 day'
from generate_series(1, pg_temp.n(5000)) g join perf_deals d on d.n = 1 + (g % (select count(*) from perf_deals));

-- 3,000 cash deposits and 2,000 cash counts (one per branch and day)
insert into public.cash_deposits (legal_entity_id, branch_id, deposited_on, bank_reference, total_paise, request_id, recorded_by, recorded_at)
select c.entity_id, case g % 3 when 0 then c.del when 1 then c.jdh else c.amd end, (current_date - (g % 1000))::date, 'SYNSLIP' || g, 100000 + g,
       gen_random_uuid(), (select user_id from perf_staff where role = 'accounts' order by n limit 1), now() - ((g % 1000) || ' days')::interval
from generate_series(1, pg_temp.n(3000)) g cross join perf_ctx c;
insert into public.cash_reconciliations (legal_entity_id, branch_id, business_date, counted_paise, expected_paise, unverified_cash_paise, request_id,
  recorded_by, recorded_at)
select c.entity_id, case g % 3 when 0 then c.del when 1 then c.jdh else c.amd end, (current_date - 1 - (g / 3))::date, 0, 0, 0, gen_random_uuid(),
       (select user_id from perf_staff where role = 'accounts' order by n limit 1), now() - ((g / 3) || ' days')::interval
from generate_series(1, pg_temp.n(2000)) g cross join perf_ctx c;

-- ---------------------------------------------------------------------------
-- Purchase money: suppliers, quotes, cost versions, evidence, 9,000 payment
-- requests (pending .. verified) and 7,000 supplier documents
-- ---------------------------------------------------------------------------
create temporary table perf_suppliers on commit drop as
select g as n, gen_random_uuid() as id from generate_series(1, 50) g;
insert into public.suppliers (id, legal_entity_id, name, service_types, created_by, updated_by)
select s.id, c.entity_id, 'Synthetic Perf Supplier ' || s.n, array['hotel'], (select user_id from perf_staff where role = 'purchase' limit 1),
       (select user_id from perf_staff where role = 'purchase' limit 1)
from perf_suppliers s cross join perf_ctx c;

create temporary table perf_hotel on commit drop as
select i.*, s.id as supplier_id, gen_random_uuid() as quote_id
from perf_items i join perf_suppliers s on s.n = 1 + (i.n % 50) where i.department = 'purchase';
insert into public.purchase_quotes (id, task_id, legal_entity_id, supplier_id, request_id, hotel_name, quoted_cost_paise, created_by)
select quote_id, task_id, (select entity_id from perf_ctx), supplier_id, gen_random_uuid(), 'Synthetic Perf Hotel', 800000, assignee from perf_hotel;
insert into public.purchase_cost_versions (task_id, legal_entity_id, version_no, quote_id, request_id, stage, amount_paise, created_by)
select task_id, (select entity_id from perf_ctx), 1, quote_id, gen_random_uuid(), 'proposed', 800000, assignee from perf_hotel;
analyze public.purchase_quotes, public.purchase_cost_versions;

create temporary table perf_evidence on commit drop as
select h.*, gen_random_uuid() as evidence_id, k.kind, row_number() over () as n2
from perf_hotel h cross join (values ('proforma'), ('invoice')) k(kind);
insert into public.supplier_money_evidence (id, legal_entity_id, task_id, kind, object_path, file_name, mime, size_bytes, sha256, uploaded_by, request_id, status)
select evidence_id, (select entity_id from perf_ctx), task_id, kind, (select entity_id from perf_ctx)::text || '/' || task_id::text || '/' || evidence_id::text, kind || '.pdf', 'application/pdf', 2048,
       encode(sha256(evidence_id::text::bytea), 'hex'), assignee, gen_random_uuid(), 'stored'
from perf_evidence;
analyze public.supplier_money_evidence;

insert into public.supplier_payment_requests (legal_entity_id, branch_id, deal_id, task_id, supplier_id, ref_no, part, amount_paise, customer_money_paise,
  route, request_id, requested_by, requested_at, cost_version_no, proforma_evidence_id, status)
select (select entity_id from perf_ctx), e.branch_id, e.deal_id, e.task_id, e.supplier_id, 'SP-2025-' || lpad((300000 + g)::text, 6, '0'), 'deposit',
       100000 + (g % 40) * 1000, 0, 'accounts', gen_random_uuid(), e.assignee, e.created_at + interval '5 days', 1, e.evidence_id, 'pending'
from generate_series(1, pg_temp.n(9000)) g
join perf_evidence e on e.kind = 'proforma' and e.n = 1 + (g % (select count(*) from perf_hotel));
analyze public.supplier_payment_requests;

insert into public.supplier_documents (legal_entity_id, branch_id, deal_id, task_id, supplier_id, kind, number, doc_date, total_paise, gst_included,
  evidence_id, uploaded_by, request_id)
select (select entity_id from perf_ctx), e.branch_id, e.deal_id, e.task_id, e.supplier_id, 'invoice', 'SYN-PERF-INV-' || e.n, (e.created_at + interval '10 days')::date,
       800000, true, e.evidence_id, e.assignee, gen_random_uuid()
from perf_evidence e where e.kind = 'invoice' and e.n <= pg_temp.n(7000);

-- ---------------------------------------------------------------------------
-- Flight: one sector and one batch per flight task, 20,000 tickets; 9,000
-- company-paid expense records (Flight direct payments and Visa fees)
-- ---------------------------------------------------------------------------
create temporary table perf_flight on commit drop as
select i.*, gen_random_uuid() as sector_id, gen_random_uuid() as batch_id, s.id as supplier_id
from perf_items i join perf_suppliers s on s.n = 1 + (i.n % 50) where i.department = 'flight';
insert into public.flight_sectors (id, legal_entity_id, branch_id, deal_id, task_id, service_item_id, origin, booking_leg_no, basis_version_id, from_place, to_place,
  depart_date, status, created_by)
select sector_id, (select entity_id from perf_ctx), branch_id, deal_id, task_id, item_id, 'booking', 1, version_id, 'DEL', 'JDH', (created_at + interval '30 days')::date,
       'active', assignee
from perf_flight;
insert into public.flight_ticket_batches (id, legal_entity_id, branch_id, deal_id, batch_no, cost_task_id, supplier_id, deal_kind, sector_ids,
  supplier_cost_paise, over_budget, confirmed_by, request_id, confirmed_at)
select batch_id, (select entity_id from perf_ctx), branch_id, deal_id, 1, task_id, supplier_id, 'package', array[sector_id], 1200000, false, assignee,
       gen_random_uuid(), created_at + interval '6 days'
from perf_flight;
analyze public.flight_sectors, public.flight_ticket_batches;
create temporary table perf_tickets on commit drop as
select f.*, t.seq, gen_random_uuid() as revision_id,
       lpad((2410000000 + f.n * 2 + t.seq)::text, 10, '0') as digits,
       upper(substr(md5('pnr' || (f.n % 7000)), 1, 6)) as pnr
from perf_flight f cross join (values (1), (2)) t(seq)
where f.n <= pg_temp.n(10000);
insert into public.flight_ticket_revisions (id, legal_entity_id, deal_id, task_id, sector_id, traveller_seq, revision_no, batch_id, traveller_name,
  traveller_type, crs_type, airline_pnr, crs_pnr, ticket_number, created_by, request_id)
select revision_id, (select entity_id from perf_ctx), deal_id, task_id, sector_id, seq, 1, batch_id, 'Synthetic Perf Traveller ' || seq, 'adult', 'amadeus',
       pnr, pnr, '098-' || digits, assignee, gen_random_uuid()
from perf_tickets;
analyze public.flight_ticket_revisions;
insert into public.flight_ticket_numbers (legal_entity_id, ticket_digits, deal_id, traveller_seq, first_revision_id)
select (select entity_id from perf_ctx), '098' || digits, deal_id, seq, revision_id from perf_tickets;

insert into public.department_cost_entries (task_id, deal_id, legal_entity_id, branch_id, department, cost_kind, amount_paise, paid_by, payment_mode, paid_on,
  supplier_id, flight_batch_id, expense_status, submitted_by, submitted_at, request_id, created_by)
select f.task_id, f.deal_id, (select entity_id from perf_ctx), f.branch_id, 'flight', 'fare', 1200000, 'company', 'card', (f.created_at + interval '6 days')::date,
       f.supplier_id, f.batch_id, 'submitted', f.assignee, f.created_at + interval '6 days', gen_random_uuid(), f.assignee
from perf_flight f where f.n <= pg_temp.n(6000);
insert into public.department_cost_entries (task_id, deal_id, legal_entity_id, branch_id, department, cost_kind, amount_paise, paid_by, payment_mode, paid_on,
  expense_status, request_id, created_by)
select v.task_id, v.deal_id, (select entity_id from perf_ctx), v.branch_id, 'visa', 'government_fee', 650000, 'company', 'upi', (v.created_at + interval '8 days')::date,
       'draft', gen_random_uuid(), v.assignee
from perf_items v where v.department = 'visa' and v.n <= pg_temp.n(3000);

-- 5,000 visa applications (applied)
insert into public.visa_applications (task_id, service_item_id, deal_id, legal_entity_id, traveller_seq, state, reference, applied_on, submitted_at, documents)
select v.task_id, v.item_id, v.deal_id, (select entity_id from perf_ctx), 1, 'submitted', 'SYN-VFS-' || lpad(v.n::text, 6, '0'), (v.created_at + interval '8 days')::date,
       v.created_at + interval '8 days', '{}'::jsonb
from perf_items v where v.department = 'visa' and v.n <= pg_temp.n(5000);

-- ---------------------------------------------------------------------------
-- Tally rows for 20,000 records (receipt entries + supplier documents) and 60 exports
-- ---------------------------------------------------------------------------
create temporary table perf_exports on commit drop as
select g as n, gen_random_uuid() as id, now() - (30 * g || ' days')::interval as created_at from generate_series(1, 60) g;
insert into public.tally_exports (id, legal_entity_id, export_no, period_from, period_to, kinds, include_exported, row_count, created_by, request_id, created_at)
select e.id, (select entity_id from perf_ctx), 'TE-2025-' || lpad((900 + e.n)::text, 6, '0'), (e.created_at - interval '29 days')::date, e.created_at::date,
       array['journal_entry'], false, 1, (select user_id from perf_staff where role = 'accounts' limit 1), gen_random_uuid(), e.created_at
from perf_exports e;
analyze public.tally_exports;
insert into public.tally_records (legal_entity_id, branch_id, deal_id, record_kind, record_id, status, export_count, last_export_id, last_exported_at,
  last_export_hash, voucher_ref, voucher_date, matched_by, matched_at, row_version)
select (select entity_id from perf_ctx), r.branch_id, r.deal_id, 'journal_entry', r.id, case when r.n % 2 = 0 then 'matched' else 'exported' end, 1,
       -- Real source fingerprint at export; about 2% deliberately different ("changed since export").
       e.id, e.created_at, case when r.n % 50 = 0 then encode(sha256(r.id::text::bytea), 'hex') else authz.tally_source_hash('journal_entry', r.id) end,
       case when r.n % 2 = 0 then 'SYN-V-' || r.n end, case when r.n % 2 = 0 then e.created_at::date end,
       case when r.n % 2 = 0 then (select user_id from perf_staff where role = 'accounts' limit 1) end, case when r.n % 2 = 0 then e.created_at end, 1
from perf_receipts r join perf_exports e on e.n = 1 + (r.n % 60) where r.n <= pg_temp.n(13000);
insert into public.tally_records (legal_entity_id, branch_id, deal_id, record_kind, record_id, status, export_count, last_export_id, last_exported_at,
  last_export_hash, row_version)
select x.legal_entity_id, x.branch_id, x.deal_id, 'supplier_document', x.id, 'exported', 1, e.id, e.created_at,
       case when x.rn % 50 = 0 then encode(sha256(x.id::text::bytea), 'hex') else authz.tally_source_hash('supplier_document', x.id) end, 1
from (select s.*, row_number() over (order by s.uploaded_at, s.id) as rn from public.supplier_documents s join perf_deals d on d.deal_id = s.deal_id) x
join perf_exports e on e.n = 1 + (x.rn % 60) where x.rn <= pg_temp.n(7000);
insert into public.tally_export_lines (export_id, line_no, legal_entity_id, record_kind, record_id, tally_record_id, values, source_hash)
select t.last_export_id, 1, t.legal_entity_id, t.record_kind, t.record_id, t.id, jsonb_build_object('recordType', 'Receipt', 'pan', 'XXXXX1234X'),
       t.last_export_hash
from (select distinct on (last_export_id) * from public.tally_records where last_export_id in (select id from perf_exports) order by last_export_id, id) t;

-- ---------------------------------------------------------------------------
-- 200,000 notices across the 30 synthetic staff (direct inserts; switch off)
-- ---------------------------------------------------------------------------
insert into public.staff_notices (legal_entity_id, branch_id, recipient_user_id, kind, priority, deal_id, subject_kind, subject_id, params, dedup_key,
  created_at, read_at, done_at)
select (select entity_id from perf_ctx), d.branch_id, s.user_id,
       case when g % 20 = 0 then 'review_returned' else 'payment_reported' end,
       case when g % 20 = 0 then 'urgent' else 'normal' end,
       d.deal_id, 'deal', d.deal_id, jsonb_build_object('dealReference', 'SYN-PERF-' || lpad(d.n::text, 5, '0')), 'perf:' || g,
       now() - ((g % 2000) || ' minutes')::interval,
       case when g % 3 = 0 then now() end, case when g % 3 = 0 then now() end
from generate_series(1, pg_temp.n(200000)) g
join perf_staff s on s.n = 1 + (g % 30)
join perf_deals d on d.n = 1 + (g % (select count(*) from perf_deals));

update public.notice_settings set notices_enabled = (select notices_enabled from perf_switch) where id;
commit;

analyze public.deals, public.booking_versions, public.booking_version_instalments, public.service_items, public.fulfilment_tasks,
  public.customer_receipts, public.finance_journal_entries, public.finance_journal_lines, public.customer_payment_claims, public.cash_deposits,
  public.cash_reconciliations, public.supplier_payment_requests, public.supplier_documents, public.department_cost_entries,
  public.flight_ticket_batches, public.flight_ticket_revisions, public.flight_ticket_numbers, public.visa_applications, public.staff_notices,
  public.tally_records, public.tally_exports;
