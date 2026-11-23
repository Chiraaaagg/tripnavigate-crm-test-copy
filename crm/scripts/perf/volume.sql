-- SYNTHETIC production-sized volume for local speed measurements only.
-- Run after scripts/seed-local.mjs on a disposable LOCAL stack:
--   psql "$TEST_DATABASE_URL" -v ON_ERROR_STOP=1 -f scripts/perf/volume.sql
-- Adds 2 000 imported-style deals and 3 000 Leads (about the hosted volume in
-- October 2026) in the fixture pilot branch, with one processed intake row each
-- and 200 open intake rows. Synthetic portal and names only; never run it on a
-- hosted database (the guard below refuses anything not labelled 'test').
do $$
begin
  if (select environment from public.deployment_settings limit 1) is distinct from 'test' then
    raise exception 'volume.sql runs only on a synthetic (test) database';
  end if;
  -- Fixture markers from scripts/seed-local.mjs: the synthetic second entity, the
  -- synthetic intake config and the fixture Sales users this script assigns.
  if not exists (select 1 from public.legal_entities where code = 'SYNTHETIC_B' and is_synthetic)
     or not exists (select 1 from public.integration_intake_config
                    where id = 'c0000000-0000-4000-8000-000000000001' and portal_domain = 'synthetic-portal.example.test')
     or (select count(*) from public.staff_profiles
         where (user_id, work_email) in (('a0000000-0000-4000-8000-000000000001'::uuid, 'sales.delhi.a@example.test'),
                                         ('a0000000-0000-4000-8000-000000000002'::uuid, 'sales.delhi.b@example.test'))) <> 2 then
    raise exception 'volume.sql runs only on a database seeded with the synthetic fixtures (scripts/seed-local.mjs)';
  end if;
end $$;

begin;
-- Entity and branch ids differ per database reset: look them up by code.
create temporary table perf_ctx as
select e.id as entity_id, b.id as branch_id
from public.legal_entities e join public.branches b on b.legal_entity_id = e.id
where e.code = 'HOLIDAY_CHACHA' and b.code = 'DEL';

create temporary table perf_ids as
select g as n,
       gen_random_uuid() as deal_id,
       gen_random_uuid() as deal_inbox,
       gen_random_uuid() as lead_id,
       gen_random_uuid() as lead_inbox
from generate_series(1, 3000) g;

insert into public.integration_inbox (id, portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, status, next_attempt_at, processed_at, origin, source_object)
select deal_inbox, 'SYNTHETIC_MEMBER_0001', 'ONCRMDEALADD', 900000 + n, 1790000000 + n,
       encode(sha256(('perf-deal-' || n)::bytea), 'hex'), 'processed', null, now(), 'event', 'deal'
from perf_ids where n <= 2000;

insert into public.deals (id, legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic,
  source_system, source_portal, source_deal_id, source_stage_id, source_category_id, source_created_at,
  source_modified_at, last_synced_at, last_verified_at, intake_inbox_id, source_assigned_by_id, created_at)
select deal_id, (select entity_id from perf_ctx), (select branch_id from perf_ctx),
       'BX-' || (900000 + n), 'Synthetic perf deal ' || n,
       case when n % 2 = 0 then 'a0000000-0000-4000-8000-000000000001'::uuid else 'a0000000-0000-4000-8000-000000000002'::uuid end,
       false, 'bitrix', 'synthetic-portal.example.test', 900000 + n, 'C7:NEW', 7,
       now() - (n || ' hours')::interval, now() - (n || ' minutes')::interval, now(), now(), deal_inbox, 1,
       now() - (n || ' hours')::interval
from perf_ids where n <= 2000;

update public.integration_inbox i set processed_deal_id = p.deal_id from perf_ids p where i.id = p.deal_inbox;

insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind)
select deal_id, (select entity_id from perf_ctx),
       case when n % 2 = 0 then 'a0000000-0000-4000-8000-000000000001'::uuid else 'a0000000-0000-4000-8000-000000000002'::uuid end, 'sales'
from perf_ids where n <= 2000;
insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind)
select deal_id, (select entity_id from perf_ctx), 'a0000000-0000-4000-8000-000000000011', 'visa'
from perf_ids where n <= 2000 and n % 10 = 0;

insert into public.integration_inbox (id, portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, status, next_attempt_at, processed_at, origin, source_object)
select lead_inbox, 'SYNTHETIC_MEMBER_0001', 'ONCRMLEADADD', 700000 + n, 1790000000 + n,
       encode(sha256(('perf-lead-' || n)::bytea), 'hex'), 'processed', null, now(), 'event', 'lead'
from perf_ids;

insert into public.crm_leads (id, legal_entity_id, branch_id, reference, title, owner_user_id, source_portal,
  source_lead_id, source_status_id, source_id_code, source_created_at, source_modified_at, last_synced_at,
  last_verified_at, intake_inbox_id, intake_mode)
select lead_id, (select entity_id from perf_ctx), (select branch_id from perf_ctx),
       'BXL-' || (700000 + n), 'Synthetic perf lead ' || n,
       case when n % 2 = 0 then 'a0000000-0000-4000-8000-000000000001'::uuid else 'a0000000-0000-4000-8000-000000000002'::uuid end,
       'synthetic-portal.example.test', 700000 + n, 'NEW', 'WEB',
       now() - (n || ' hours')::interval, now() - (n || ' minutes')::interval, now(), now(), lead_inbox, 'scope'
from perf_ids;

update public.integration_inbox i set processed_lead_id = p.lead_id from perf_ids p where i.id = p.lead_inbox;

insert into public.integration_inbox (portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, status, next_attempt_at, origin, source_object, reason_code)
select 'SYNTHETIC_MEMBER_0001', 'ONCRMDEALUPDATE', 950000 + g, 1790000000 + g,
       encode(sha256(('perf-open-' || g)::bytea), 'hex'),
       case when g % 4 = 0 then 'needs_review' when g % 4 = 1 then 'ignored' else 'pending' end,
       now(), 'event', 'deal', case when g % 4 in (0, 1) then 'not_eligible_stage' end
from generate_series(1, 200) g;
commit;
analyze public.deals, public.deal_assignments, public.crm_leads, public.integration_inbox;
