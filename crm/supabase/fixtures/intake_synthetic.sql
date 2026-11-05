-- SYNTHETIC FIXTURES - BITRIX INTAKE. NOT BUSINESS POLICY, NOT A REAL PORTAL.
--
-- Loaded only into local databases and automated tests, after
-- synthetic_fixtures.sql. The portal domain uses the reserved .test TLD; the
-- member id, category, stages, cutoff and Bitrix user ids are invented. The
-- real pilot branch, category/stage map, cutoff and staff map are owner inputs
-- that do not exist yet (contract section 0). Never copy these rows to staging
-- or production.

insert into public.integration_intake_config
  (id, portal_domain, portal_member_id, category_id, eligible_stage_ids, cutoff_at,
   pilot_legal_entity_id, pilot_branch_id, enabled)
select 'c0000000-0000-4000-8000-000000000001', 'synthetic-portal.example.test', 'SYNTHETIC_MEMBER_0001',
       7, array['C7:NEW', 'C7:PREPARATION'], '2026-09-01T00:00:00Z', b.legal_entity_id, b.id, true
from public.branches b
join public.legal_entities e on e.id = b.legal_entity_id
where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL';

-- Synthetic Bitrix user ids -> synthetic staff. The pilot branch above is Delhi.
insert into public.bitrix_user_mappings (portal_member_id, bitrix_user_id, staff_user_id, active) values
  -- Delhi Sales A: valid owner.
  ('SYNTHETIC_MEMBER_0001', 101, 'a0000000-0000-4000-8000-000000000001', true),
  -- Delhi Sales B: valid owner (owner-change tests).
  ('SYNTHETIC_MEMBER_0001', 102, 'a0000000-0000-4000-8000-000000000002', true),
  -- Ahmedabad Sales: active staff, but not in the pilot branch.
  ('SYNTHETIC_MEMBER_0001', 104, 'a0000000-0000-4000-8000-000000000004', true),
  -- Former staff (inactive profile).
  ('SYNTHETIC_MEMBER_0001', 108, 'a0000000-0000-4000-8000-000000000008', true),
  -- Moved staff: active profile, no active membership.
  ('SYNTHETIC_MEMBER_0001', 109, 'a0000000-0000-4000-8000-000000000009', true),
  -- Deactivated mapping row.
  ('SYNTHETIC_MEMBER_0001', 199, 'a0000000-0000-4000-8000-000000000001', false);

-- Phase 6: synthetic ACTIVE Deal manifest for the synthetic portal (business
-- date 2026-09-15 Asia/Kolkata; the suites create deals on that day). Without an
-- active manifest nothing is imported (contract 2.4). Created through the
-- audited operator command; source code, interval and ids are invented and
-- cover the deal ids used by the PGlite suites (5000-9999). Real-stack suites
-- close it and create their own run manifest. No Lead manifest is seeded:
-- Lead tests create theirs.
select public.integration_manifest_create(
  'c0000000-0000-4000-8000-000000000001', 'deal', 'SYNTHETIC_SRC', date '2026-09-15',
  timestamptz '2026-09-15T00:00:00+05:30', timestamptz '2026-09-16T00:00:00+05:30',
  array(select generate_series(5000, 9999)::bigint), 'synthetic-fixture');
