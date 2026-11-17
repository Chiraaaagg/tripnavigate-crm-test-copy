-- SYNTHETIC FIXTURES - ACCOUNTS PHASE 2 PEOPLE. NOT BUSINESS POLICY, NOT REAL
-- STAFF. Loaded only into local databases and automated tests, after
-- synthetic_fixtures.sql. Every person uses an @example.test address.
--
-- Accounts phase 2 contract (11 Nov 2026) section 15: the extra people the
-- refund, document, supplier and cancellation tests need, so suites no longer
-- give existing fixture users extra roles inside their transactions:
--   accounts.jodhpur.2 / .3     second and third Accounts person (JDH)
--   manager.jodhpur / .2        Manager of Jodhpur, and a second Jodhpur Manager
--   manager.flight.delhi        a Delhi Manager who also holds Flight (not "M", AL7)
--   flight.jodhpur              a Flight person (JDH)
--   visa.jodhpur.2              a Visa person (JDH), Visa only
-- Delhi (Manager Delhi) and Ahmedabad (Manager Ahmedabad) already have a
-- Manager. A Deal without an active Sales owner already exists: SYN-DEL-003
-- (owner left the company) and SYN-DEL-004 (owner's membership ended).
--
-- No Deal, assignment, grant or business row is added here on purpose: the
-- policy-parity suites pin the exact fixture Deals and their readers.
--
-- The memberships start INACTIVE (opt-in): existing suites pin the exact
-- recipients of notices to "every Accounts person", "the branch Managers"
-- and "the department holders", so a permanently active extra person would
-- change them. A suite turns the people it needs on inside its own
-- rolled-back transaction with activateAcc2People (tests/helpers/db.ts), or
-- on a disposable real stack with:
--   update public.memberships set status = 'active', deactivated_at = null
--   where user_id in (<ids>);
--
-- Auth users: the test harness (tests/helpers/db.ts) and the local seed
-- script create them; the insert below only fills a gap (a real local stack
-- seeded before these users existed) and never changes an existing user.

insert into auth.users (id, email)
select u.id::uuid, u.email
from (values
  ('a0000000-0000-4000-8000-000000000014', 'accounts.jodhpur.2@example.test'),
  ('a0000000-0000-4000-8000-000000000015', 'accounts.jodhpur.3@example.test'),
  ('a0000000-0000-4000-8000-000000000016', 'manager.jodhpur@example.test'),
  ('a0000000-0000-4000-8000-000000000017', 'manager.jodhpur.2@example.test'),
  ('a0000000-0000-4000-8000-000000000018', 'manager.flight.delhi@example.test'),
  ('a0000000-0000-4000-8000-000000000019', 'flight.jodhpur@example.test'),
  ('a0000000-0000-4000-8000-000000000020', 'visa.jodhpur.2@example.test')
) as u (id, email)
where not exists (select 1 from auth.users x where x.id = u.id::uuid);

insert into public.staff_profiles (user_id, display_name, work_email, status, activated_at) values
  ('a0000000-0000-4000-8000-000000000014', 'Synthetic Accounts Jodhpur 2', 'accounts.jodhpur.2@example.test', 'active', now()),
  ('a0000000-0000-4000-8000-000000000015', 'Synthetic Accounts Jodhpur 3', 'accounts.jodhpur.3@example.test', 'active', now()),
  ('a0000000-0000-4000-8000-000000000016', 'Synthetic Manager Jodhpur', 'manager.jodhpur@example.test', 'active', now()),
  ('a0000000-0000-4000-8000-000000000017', 'Synthetic Manager Jodhpur 2', 'manager.jodhpur.2@example.test', 'active', now()),
  ('a0000000-0000-4000-8000-000000000018', 'Synthetic Manager with Flight', 'manager.flight.delhi@example.test', 'active', now()),
  ('a0000000-0000-4000-8000-000000000019', 'Synthetic Flight Jodhpur', 'flight.jodhpur@example.test', 'active', now()),
  ('a0000000-0000-4000-8000-000000000020', 'Synthetic Visa Jodhpur 2', 'visa.jodhpur.2@example.test', 'active', now());

insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status, deactivated_at)
select m.user_id::uuid, b.legal_entity_id, b.id, m.role_code, 'inactive', now()
from (values
  ('a0000000-0000-4000-8000-000000000014', 'JDH', 'accounts'),
  ('a0000000-0000-4000-8000-000000000015', 'JDH', 'accounts'),
  ('a0000000-0000-4000-8000-000000000016', 'JDH', 'manager'),
  ('a0000000-0000-4000-8000-000000000017', 'JDH', 'manager'),
  -- Manager of the Delhi Deals' branch who also holds Flight: never "M" (AL7).
  ('a0000000-0000-4000-8000-000000000018', 'DEL', 'manager'),
  ('a0000000-0000-4000-8000-000000000018', 'JDH', 'flight'),
  ('a0000000-0000-4000-8000-000000000019', 'JDH', 'flight'),
  ('a0000000-0000-4000-8000-000000000020', 'JDH', 'visa')
) as m (user_id, branch_code, role_code)
join public.legal_entities e on e.code = 'HOLIDAY_CHACHA'
join public.branches b on b.legal_entity_id = e.id and b.code = m.branch_code;
