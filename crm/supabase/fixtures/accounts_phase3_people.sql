-- seed-local: rerun-safe
-- SYNTHETIC FIXTURES - ACCOUNTS PHASE 3 PEOPLE. NOT BUSINESS POLICY, NOT REAL
-- STAFF. Loaded only into local databases and automated tests, after
-- synthetic_fixtures.sql. Every person uses an @example.test address.
--
-- Accounts phase 3 contract (12 Nov 2026) section 19, lead fixtures: a second
-- Manager per branch, so the approver rule (contract section 4: a branch
-- Manager who is not the requester, proposer or enterer; Phase 2 LD32) can be
-- exercised in every branch without giving other fixture users extra roles:
--   manager.delhi.2         second Manager of Delhi (DEL)
--   manager.ahmedabad.2     second Manager of Ahmedabad (AMD)
-- Jodhpur (JDH) already has two Managers (accounts_phase2_people.sql:
-- manager.jodhpur and manager.jodhpur.2). Both people are pure Managers: no
-- Purchase, Flight or Visa membership (they count as "M", contract 4).
--
-- No Deal, assignment, grant or business row is added here on purpose: the
-- policy-parity suites pin the exact fixture Deals and their readers. The
-- Phase 3 business scenarios live in phase3/acc3_scenarios.sql (opt-in).
--
-- The memberships start INACTIVE (opt-in), exactly like the Accounts phase 2
-- people: existing suites pin the exact recipients of notices to "the branch
-- Managers", so a permanently active extra Manager would change them. A suite
-- turns them on inside its own rolled-back transaction with
-- activateAcc3People (tests/helpers/db.ts), or on a disposable real stack with:
--   update public.memberships set status = 'active', deactivated_at = null
--   where user_id in ('a0000000-0000-4000-8000-000000000021',
--                     'a0000000-0000-4000-8000-000000000022');
--
-- Rerun-safe (first line): every insert skips rows that already exist, so
-- scripts/seed-local.mjs can load this file into a stack that was seeded
-- before these people existed, without a reset. It never changes an existing
-- row (an activated membership stays as it is).
--
-- Auth users: the test harness (tests/helpers/db.ts) and the local seed
-- script create them; the insert below only fills a gap.

insert into auth.users (id, email)
select u.id::uuid, u.email
from (values
  ('a0000000-0000-4000-8000-000000000021', 'manager.delhi.2@example.test'),
  ('a0000000-0000-4000-8000-000000000022', 'manager.ahmedabad.2@example.test')
) as u (id, email)
where not exists (select 1 from auth.users x where x.id = u.id::uuid);

insert into public.staff_profiles (user_id, display_name, work_email, status, activated_at)
select p.user_id::uuid, p.display_name, p.work_email, 'active', now()
from (values
  ('a0000000-0000-4000-8000-000000000021', 'Synthetic Manager Delhi 2', 'manager.delhi.2@example.test'),
  ('a0000000-0000-4000-8000-000000000022', 'Synthetic Manager Ahmedabad 2', 'manager.ahmedabad.2@example.test')
) as p (user_id, display_name, work_email)
where not exists (select 1 from public.staff_profiles x where x.user_id = p.user_id::uuid);

insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status, deactivated_at)
select m.user_id::uuid, b.legal_entity_id, b.id, m.role_code, 'inactive', now()
from (values
  ('a0000000-0000-4000-8000-000000000021', 'DEL', 'manager'),
  ('a0000000-0000-4000-8000-000000000022', 'AMD', 'manager')
) as m (user_id, branch_code, role_code)
join public.legal_entities e on e.code = 'HOLIDAY_CHACHA'
join public.branches b on b.legal_entity_id = e.id and b.code = m.branch_code
where not exists (select 1 from public.memberships x
                  where x.user_id = m.user_id::uuid and x.branch_id = b.id and x.role_code = m.role_code);
