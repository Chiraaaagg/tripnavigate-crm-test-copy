-- SYNTHETIC FIXTURE - NOT BUSINESS POLICY, NOT REAL STAFF, NOT REAL CUSTOMERS.
--
-- Phase 5B Milestone A section 8: the real Accounts browser journey
-- (tests/e2e/accounts.real.e2e.ts). Loaded ONLY by that journey, on the
-- disposable CI stack (or a local stack), after scripts/seed-local.mjs. It is
-- in a subdirectory on purpose: the seed loader and the database test harness
-- read only the top-level fixture files, so policy and finance suites keep
-- their exact expectations (finance enabled for HOLIDAY_CHACHA only).
--
-- Precondition: deployment_settings.environment = 'test' (synthetic_fixtures.sql)
-- and auth.users rows with the three IDs below (created by the journey through
-- the Auth admin API). The journey loads this file once per database.
--
-- What it creates:
--   * a separate, enabled synthetic legal entity with finance switched on, two
--     branches and its own legal limits and policy. In the 'test' environment
--     every payment mode is allowed (authz.finance_mode_allowed); the owner
--     live switches stay false, as for every entity.
--   * two distinct Accounts people (A records, B checks) and one Sales owner;
--   * a policy version in force since 400 days ago (so obligations for old
--     business dates exist) and one cash receipt received 75 days ago that is
--     still unverified and has no cash count: a reconciliation obligation
--     older than 60 days that must stay outstanding until resolved.
-- Payment caps: one receipt at most Rs 1,00,00,000; cash at most Rs 49,999 per
-- payer per day and per trip; deposit within 1 working day; daily count required.

-- Guard: synthetic data only ever goes into a database labelled 'test'.
do $$
begin
  if coalesce((select s.environment from public.deployment_settings s where s.id), 'missing') <> 'test' then
    raise exception 'accounts_journey.sql loads only into a database whose deployment environment is test';
  end if;
end;
$$;

insert into public.legal_entities (id, code, legal_name, status, is_synthetic) values
  ('e0000000-0000-4000-8000-0000000000f0', 'SYNTHETIC_FIN',
   'Synthetic Finance Test Entity (not a real company)', 'enabled', true);

insert into public.branches (id, legal_entity_id, code, name, state_name, is_head_office) values
  ('b0000000-0000-4000-8000-0000000000f1', 'e0000000-0000-4000-8000-0000000000f0',
   'FHQ', 'Synthetic Finance Head Office', 'Not applicable (synthetic)', true),
  ('b0000000-0000-4000-8000-0000000000f2', 'e0000000-0000-4000-8000-0000000000f0',
   'FBR', 'Synthetic Finance Branch', 'Not applicable (synthetic)', false);

insert into public.staff_profiles (user_id, display_name, work_email, status, activated_at) values
  ('a0000000-0000-4000-8000-000000000101', 'Synthetic Accounts Finance A', 'accounts.fin.a@example.test', 'active', now()),
  ('a0000000-0000-4000-8000-000000000102', 'Synthetic Accounts Finance B', 'accounts.fin.b@example.test', 'active', now()),
  ('a0000000-0000-4000-8000-000000000103', 'Synthetic Sales Finance', 'sales.fin@example.test', 'active', now());

insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status) values
  ('a0000000-0000-4000-8000-000000000101', 'e0000000-0000-4000-8000-0000000000f0', 'b0000000-0000-4000-8000-0000000000f1', 'accounts', 'active'),
  ('a0000000-0000-4000-8000-000000000102', 'e0000000-0000-4000-8000-0000000000f0', 'b0000000-0000-4000-8000-0000000000f2', 'accounts', 'active'),
  ('a0000000-0000-4000-8000-000000000103', 'e0000000-0000-4000-8000-0000000000f0', 'b0000000-0000-4000-8000-0000000000f2', 'sales', 'active');

-- Finance enablement as authz.finance_enable_entity does it, but with the
-- policy in force since well before the dated cash activity below.
insert into public.finance_live_settings (legal_entity_id) values ('e0000000-0000-4000-8000-0000000000f0');
insert into public.finance_legal_limits (legal_entity_id) values ('e0000000-0000-4000-8000-0000000000f0');
insert into public.finance_policy_heads (legal_entity_id, current_version_no) values ('e0000000-0000-4000-8000-0000000000f0', 1);
insert into public.finance_policy_versions
  (id, legal_entity_id, version_no, effective_at, receipt_max_paise, cash_payer_day_cap_paise, cash_trip_cap_paise,
   cash_deposit_days, reconciliation_required, reason)
values
  ('f0000000-0000-4000-8000-0000000000f1', 'e0000000-0000-4000-8000-0000000000f0', 1, now() - interval '400 days',
   1000000000, 4999900, 4999900, 1, true,
   'SYNTHETIC FIXTURE: Accounts journey policy (not company policy).');

-- A synthetic deal with old cash activity.
insert into public.deals (id, legal_entity_id, branch_id, reference, title, owner_user_id) values
  ('d0000000-0000-4000-8000-0000000000f9', 'e0000000-0000-4000-8000-0000000000f0', 'b0000000-0000-4000-8000-0000000000f2',
   'SYN-FIN-OLD-001', 'Synthetic old cash deal (Accounts journey)', 'a0000000-0000-4000-8000-000000000103');

-- Cash received 75 IST days ago at the branch, recorded by Accounts A and never
-- verified, with no daily cash count: its business date stays an outstanding
-- reconciliation obligation (Milestone A section 2), however old it is.
insert into public.customer_receipts
  (id, legal_entity_id, deal_id, branch_id, receipt_no, fiscal_year, mode, status, amount_paise, received_on,
   collector_user_id, payer_name, payer_pan, policy_version_id, request_id, recorded_by, recorded_at, note)
select
  'c0000000-0000-4000-8000-0000000000f9', 'e0000000-0000-4000-8000-0000000000f0', 'd0000000-0000-4000-8000-0000000000f9',
  'b0000000-0000-4000-8000-0000000000f2',
  'R-' || authz.finance_fiscal_year(d.d) || '-900001', authz.finance_fiscal_year(d.d), 'cash', 'recorded', 100000, d.d,
  'a0000000-0000-4000-8000-000000000101', 'Synthetic Old Cash Payer', 'SYNOC0001Z', 'f0000000-0000-4000-8000-0000000000f1',
  'c0000000-0000-4000-8000-0000000000fa', 'a0000000-0000-4000-8000-000000000101', now() - interval '75 days',
  'SYNTHETIC FIXTURE: dated cash activity for the reconciliation journey.'
from (select authz.finance_today() - 75 as d) d;
