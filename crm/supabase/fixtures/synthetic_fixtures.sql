-- SYNTHETIC FIXTURES - NOT BUSINESS POLICY, NOT REAL STAFF, NOT REAL CUSTOMERS.
--
-- Loaded only into local databases and automated tests. Never apply to staging
-- with real staff, and never to production. Every person uses an
-- @example.test address (reserved, undeliverable), every deal is flagged
-- is_synthetic and every grant reason starts with "SYNTHETIC FIXTURE".
--
-- The grants below exist to exercise the access model (A01-A03). They do not
-- represent approved Manager, Accounts or branch access policy.
--
-- Precondition: auth.users rows with the IDs below already exist (created by
-- scripts/seed-local.mjs through the Auth admin API, or by the test harness).

-- SYNTHETIC FIXTURE: this database is a test deployment. Intake commands
-- refuse while the environment is 'unset' (the migration default).
update public.deployment_settings set environment = 'test', updated_at = now() where id;

-- Synthetic second legal entity used only for cross-entity denial tests. It is
-- disabled, like the real second group entity will be until an approved rollout.
insert into public.legal_entities (id, code, legal_name, status, is_synthetic) values
  ('e0000000-0000-4000-8000-0000000000b0', 'SYNTHETIC_B',
   'Synthetic Test Entity B (not a real company)', 'disabled', true);

insert into public.branches (id, legal_entity_id, code, name, state_name) values
  ('b0000000-0000-4000-8000-0000000000b1', 'e0000000-0000-4000-8000-0000000000b0',
   'SB1', 'Synthetic Branch B1', 'Not applicable (synthetic)');

insert into public.staff_profiles (user_id, display_name, work_email, status, activated_at) values
  ('a0000000-0000-4000-8000-000000000001', 'Synthetic Sales Delhi A', 'sales.delhi.a@example.test', 'active', now()),
  ('a0000000-0000-4000-8000-000000000002', 'Synthetic Sales Delhi B', 'sales.delhi.b@example.test', 'active', now()),
  ('a0000000-0000-4000-8000-000000000003', 'Synthetic Purchase Jodhpur', 'purchase.jodhpur@example.test', 'active', now()),
  ('a0000000-0000-4000-8000-000000000004', 'Synthetic Sales Ahmedabad', 'sales.ahmedabad@example.test', 'active', now()),
  ('a0000000-0000-4000-8000-000000000005', 'Synthetic Manager Delhi', 'manager.delhi@example.test', 'active', now()),
  ('a0000000-0000-4000-8000-000000000006', 'Synthetic Accounts Jodhpur', 'accounts.jodhpur@example.test', 'active', now()),
  ('a0000000-0000-4000-8000-000000000007', 'Synthetic Admin Jodhpur', 'admin.jodhpur@example.test', 'active', now()),
  ('a0000000-0000-4000-8000-000000000008', 'Synthetic Former Staff', 'former.staff@example.test', 'active', now()),
  ('a0000000-0000-4000-8000-000000000009', 'Synthetic Moved Staff', 'moved.staff@example.test', 'active', now()),
  ('a0000000-0000-4000-8000-000000000010', 'Synthetic Entity B Sales', 'sales.entityb@example.test', 'active', now()),
  ('a0000000-0000-4000-8000-000000000011', 'Synthetic Visa Jodhpur', 'visa.jodhpur@example.test', 'active', now()),
  ('a0000000-0000-4000-8000-000000000012', 'Synthetic Invited Staff', 'invited.staff@example.test', 'invited', null),
  ('a0000000-0000-4000-8000-000000000013', 'Synthetic Manager Ahmedabad', 'manager.ahmedabad@example.test', 'active', now());

insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
select m.user_id::uuid, b.legal_entity_id, b.id, m.role_code, m.status
from (values
  ('a0000000-0000-4000-8000-000000000001', 'HOLIDAY_CHACHA', 'DEL', 'sales', 'active'),
  ('a0000000-0000-4000-8000-000000000002', 'HOLIDAY_CHACHA', 'DEL', 'sales', 'active'),
  ('a0000000-0000-4000-8000-000000000003', 'HOLIDAY_CHACHA', 'JDH', 'purchase', 'active'),
  ('a0000000-0000-4000-8000-000000000004', 'HOLIDAY_CHACHA', 'AMD', 'sales', 'active'),
  ('a0000000-0000-4000-8000-000000000005', 'HOLIDAY_CHACHA', 'DEL', 'manager', 'active'),
  ('a0000000-0000-4000-8000-000000000006', 'HOLIDAY_CHACHA', 'JDH', 'accounts', 'active'),
  ('a0000000-0000-4000-8000-000000000007', 'HOLIDAY_CHACHA', 'JDH', 'super_admin', 'active'),
  ('a0000000-0000-4000-8000-000000000008', 'HOLIDAY_CHACHA', 'DEL', 'sales', 'active'),
  ('a0000000-0000-4000-8000-000000000009', 'HOLIDAY_CHACHA', 'DEL', 'sales', 'active'),
  ('a0000000-0000-4000-8000-000000000010', 'SYNTHETIC_B', 'SB1', 'sales', 'active'),
  ('a0000000-0000-4000-8000-000000000011', 'HOLIDAY_CHACHA', 'JDH', 'visa', 'active'),
  ('a0000000-0000-4000-8000-000000000012', 'HOLIDAY_CHACHA', 'DEL', 'sales', 'invited'),
  ('a0000000-0000-4000-8000-000000000013', 'HOLIDAY_CHACHA', 'AMD', 'manager', 'active')
) as m (user_id, entity_code, branch_code, role_code, status)
join public.legal_entities e on e.code = m.entity_code
join public.branches b on b.legal_entity_id = e.id and b.code = m.branch_code;

insert into public.deals (id, legal_entity_id, branch_id, reference, title, owner_user_id)
select d.id::uuid, b.legal_entity_id, b.id, d.reference, d.title, d.owner::uuid
from (values
  ('d0000000-0000-4000-8000-000000000001', 'HOLIDAY_CHACHA', 'DEL', 'SYN-DEL-001', 'Synthetic package A (Delhi)', 'a0000000-0000-4000-8000-000000000001'),
  ('d0000000-0000-4000-8000-000000000002', 'HOLIDAY_CHACHA', 'DEL', 'SYN-DEL-002', 'Synthetic package B (Delhi)', 'a0000000-0000-4000-8000-000000000002'),
  ('d0000000-0000-4000-8000-000000000003', 'HOLIDAY_CHACHA', 'AMD', 'SYN-AMD-001', 'Synthetic package C (Ahmedabad)', 'a0000000-0000-4000-8000-000000000004'),
  ('d0000000-0000-4000-8000-000000000004', 'HOLIDAY_CHACHA', 'DEL', 'SYN-DEL-003', 'Synthetic package D (former staff)', 'a0000000-0000-4000-8000-000000000008'),
  ('d0000000-0000-4000-8000-000000000005', 'HOLIDAY_CHACHA', 'DEL', 'SYN-DEL-004', 'Synthetic package E (moved staff)', 'a0000000-0000-4000-8000-000000000009'),
  ('d0000000-0000-4000-8000-000000000006', 'SYNTHETIC_B', 'SB1', 'SYN-B-001', 'Synthetic package F (entity B)', 'a0000000-0000-4000-8000-000000000010')
) as d (id, entity_code, branch_code, reference, title, owner)
join public.legal_entities e on e.code = d.entity_code
join public.branches b on b.legal_entity_id = e.id and b.code = d.branch_code;

insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by, ended_at)
select a.deal_id::uuid, d.legal_entity_id, a.user_id::uuid, a.kind, 'a0000000-0000-4000-8000-000000000007', a.ended_at
from (values
  -- Purchase at head office assigned to a Delhi deal (cross-branch, same entity).
  ('d0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000003', 'purchase', null::timestamptz),
  -- Ended assignment: must no longer grant access.
  ('d0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000011', 'visa', now() - interval '1 day')
) as a (deal_id, user_id, kind, ended_at)
join public.deals d on d.id = a.deal_id::uuid;

-- Placeholder figures in paise. They carry no tax meaning.
insert into public.deal_commercials (deal_id, legal_entity_id, selling_total_paise, estimated_margin_paise)
select d.id, d.legal_entity_id, c.selling, c.margin
from (values
  ('d0000000-0000-4000-8000-000000000001', 12345600::bigint, 1111100::bigint),
  ('d0000000-0000-4000-8000-000000000002', 22222200, 2020200),
  ('d0000000-0000-4000-8000-000000000003', 33333300, 3030300),
  ('d0000000-0000-4000-8000-000000000004', 44444400, 4040400),
  ('d0000000-0000-4000-8000-000000000005', 55555500, 5050500),
  ('d0000000-0000-4000-8000-000000000006', 66666600, 6060600)
) as c (deal_id, selling, margin)
join public.deals d on d.id = c.deal_id::uuid;

insert into public.access_grants
  (user_id, permission_code, legal_entity_id, branch_id, reason, granted_by, starts_at, expires_at, revoked_at, revoked_by, revocation_reason)
select g.user_id::uuid, g.permission, e.id, b.id, g.reason, 'a0000000-0000-4000-8000-000000000007',
       g.starts_at, g.expires_at, g.revoked_at,
       case when g.revoked_at is null then null else 'a0000000-0000-4000-8000-000000000007'::uuid end,
       case when g.revoked_at is null then null else 'SYNTHETIC FIXTURE revoked' end
from (values
  ('a0000000-0000-4000-8000-000000000005', 'deal.read', 'DEL',
   'SYNTHETIC FIXTURE: Delhi branch read scope for tests', now() - interval '1 day', null::timestamptz, null::timestamptz),
  ('a0000000-0000-4000-8000-000000000006', 'deal.read', null,
   'SYNTHETIC FIXTURE: entity-wide read scope for tests', now() - interval '1 day', null, null),
  ('a0000000-0000-4000-8000-000000000006', 'deal.read_commercial', null,
   'SYNTHETIC FIXTURE: entity-wide commercial scope for tests', now() - interval '1 day', null, null),
  ('a0000000-0000-4000-8000-000000000013', 'deal.read', 'DEL',
   'SYNTHETIC FIXTURE: expired grant for tests', now() - interval '10 days', now() - interval '1 day', null),
  ('a0000000-0000-4000-8000-000000000013', 'deal.read', 'AMD',
   'SYNTHETIC FIXTURE: revoked grant for tests', now() - interval '10 days', null, now() - interval '1 day'),
  ('a0000000-0000-4000-8000-000000000009', 'deal.read', null,
   'SYNTHETIC FIXTURE: grant left behind after a move', now() - interval '10 days', null, null)
) as g (user_id, permission, branch_code, reason, starts_at, expires_at, revoked_at)
join public.legal_entities e on e.code = 'HOLIDAY_CHACHA'
left join public.branches b on b.legal_entity_id = e.id and b.code = g.branch_code;

insert into public.audit_events (actor_user_id, legal_entity_id, action, target_type, target_id, sensitivity, details)
select 'a0000000-0000-4000-8000-000000000001', e.id, a.action, 'deal', 'd0000000-0000-4000-8000-000000000001', a.sensitivity, a.details::jsonb
from (values
  ('deal.synthetic_viewed', 'standard', '{"fixture": true}'),
  ('deal.synthetic_price_changed', 'commercial', '{"fixture": true, "selling_total_paise": 12345600}')
) as a (action, sensitivity, details)
join public.legal_entities e on e.code = 'HOLIDAY_CHACHA';

-- Offboarding states are applied after the deals exist, because deal owners must
-- be entity members when the deal is created.
update public.staff_profiles
set status = 'inactive', deactivated_at = now(), deactivation_reason = 'SYNTHETIC FIXTURE: left the company'
where user_id = 'a0000000-0000-4000-8000-000000000008';
update public.memberships set status = 'inactive', deactivated_at = now()
where user_id = 'a0000000-0000-4000-8000-000000000008';
-- Moved staff: profile still active, but their only membership ended.
update public.memberships set status = 'inactive', deactivated_at = now()
where user_id = 'a0000000-0000-4000-8000-000000000009';

-- SYNTHETIC FIXTURE - NOT POLICY. A recovery verification method that exists
-- only so local and CI tests can complete MFA recovery. Production has no
-- approved method until the owner decides O06; never copy this row there.
insert into public.recovery_verification_methods (code, label, active) values
  ('SYNTHETIC_TEST_CALLBACK', 'SYNTHETIC FIXTURE - test-only callback (not an approved method)', true);
