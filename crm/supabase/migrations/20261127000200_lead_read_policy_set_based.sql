-- TripNavigate CRM - Direction A Batch 6: Lead read policy evaluated once per
-- query (same rule, set-based).
--
-- Problem (measured on a local stack and PGlite with 10,000 synthetic Leads,
-- Atlas Batch 5 notes): the crm_leads policy `using (authz.can_read_lead(id))`
-- calls a security definer function for EACH row. Every call repeats the
-- session check, the Purchase check, two membership joins and the
-- integration.manage permission lookup (about 115-350 microseconds per row), so
-- the Leads list count and the Lead search (public.crm_search, security
-- invoker) take 1-3.7 s for a Manager or a Sales person at 10,000 Leads.
--
-- Fix: the viewer's facts are computed ONCE per statement as uncorrelated
-- sub-selects (InitPlans), and each row is compared against them with a cheap
-- predicate on its own columns (owner_user_id, legal_entity_id, branch_id),
-- the same style as the Deals policy (20261107000100 section 3).
--
-- What changes:
--   1. New helper authz.my_purchase_anywhere(): true when the viewer holds an
--      active Purchase membership in any entity (status 'active'; entity and
--      branch status not considered), exactly the Purchase clause of
--      authz.can_read_lead. (authz.holds_purchase_anywhere, 20261125000100,
--      has the same body but no execute grant for authenticated, so a policy
--      cannot call it; it is left unchanged.)
--   2. New helper authz.my_active_role_branches(p_role): branch ids where the
--      viewer holds an active membership in p_role in an enabled entity and an
--      enabled branch.
--   3. Policy scoped_read on public.crm_leads dropped and re-created in
--      set-based form. The restrictive require_valid_session policy, the table
--      grants and authz.can_read_lead itself are unchanged (commands and reads
--      such as record_staff_names and the referral reads still call it).
--
-- The rule (unchanged). Old, authz.can_read_lead(id) per row (body from
-- 20261007000200_lead_scope_reads.sql):
--   session_ok
--   and no active Purchase membership of the viewer in any entity
--   and (
--     (owner_user_id = viewer and an active Sales membership of the viewer with
--        membership entity = Lead entity and membership branch = Lead branch,
--        entity enabled, branch enabled)
--     or an active Manager membership of the viewer with membership entity =
--        Lead entity and membership branch = Lead branch, entity and branch
--        enabled
--     or authz.can_admin('integration.manage', Lead entity)
--   )
-- New, per statement then per row:
--   (select authz.session_ok())
--   and not (select authz.my_purchase_anywhere())
--   and (
--     (owner_user_id = (select auth.uid())
--        and branch_id = any ((select authz.my_active_role_branches('sales'))))
--     or branch_id = any ((select authz.my_active_role_branches('manager')))
--     or legal_entity_id = any ((select authz.my_permission_entities('integration.manage', 'entity')))
--   )
--
-- Why this is exactly the same set of Leads:
--   - Entity and branch together: crm_leads (legal_entity_id, branch_id) and
--     memberships (legal_entity_id, branch_id) both reference
--     branches (legal_entity_id, id), all four columns not null, and the
--     helper also requires branches.legal_entity_id = memberships.legal_entity_id.
--     A branch id therefore names exactly one entity, so "membership branch =
--     Lead branch" implies "membership entity = Lead entity" and the pair is
--     matched exactly, as the old function did.
--   - Owner null: owner_user_id = auth.uid() is null, not true, in both forms;
--     such a Lead stays visible only through the Manager or admin clause, as
--     before.
--   - authz.can_admin('integration.manage', e) is session_ok and
--     authz.has_role_permission('integration.manage', e, 'entity'), whose
--     memberships/role_permissions/enabled-entity/enabled-branch conditions are
--     exactly the ones authz.my_permission_entities(p, 'entity') aggregates
--     (20261107000100 section 3, unchanged since).
--   - session_ok is already the first clause.
-- tests/db/batch6-lead-visibility.test.ts proves the parity per role against
-- authz.can_read_lead and against an explicit expected list.
--
-- Indexes: no new index. The plan is a sequential scan of crm_leads with a
-- cheap filter on the InitPlan results (EXPLAIN ANALYZE on a local stack at
-- 10,000 Leads: about 2 ms for Sales and Manager, where 40-90 % of the rows
-- match, so a sequential scan is the right plan). The existing
-- crm_leads_branch_idx leads with legal_entity_id, so `branch_id = any (...)`
-- alone cannot use it as an index condition.
--
-- Rollback (forward-only, in a new migration): drop policy scoped_read on
-- public.crm_leads and re-create it from 20261007000100_lead_intake_manifest.sql:
--   create policy scoped_read on public.crm_leads
--     for select to authenticated using (authz.can_read_lead(id));
-- then optionally drop the two helpers (nothing else uses them).
--
-- Apply history: written 24 October 2026; run only on disposable local test
-- databases. Not applied to any hosted project.

begin;
-- drop/create policy takes a brief exclusive lock on crm_leads.
set local lock_timeout = '15s';

-- Exactly the Purchase clause of authz.can_read_lead: any active Purchase
-- membership, whatever the entity or branch status.
create function authz.my_purchase_anywhere() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships p
    where p.user_id = (select auth.uid()) and p.role_code = 'purchase' and p.status = 'active')
$$;

-- Branches where the viewer holds an active p_role membership in an enabled
-- entity and an enabled branch. The branch join also matches the entity, so a
-- branch id in the result belongs to the membership's own entity.
create function authz.my_active_role_branches(p_role text) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct m.branch_id), '{}')
  from public.memberships m
  join public.legal_entities e on e.id = m.legal_entity_id
  join public.branches b on b.id = m.branch_id and b.legal_entity_id = m.legal_entity_id
  where m.user_id = (select auth.uid())
    and m.role_code = p_role and m.status = 'active'
    and e.status = 'enabled' and b.status = 'enabled'
$$;

revoke all on function authz.my_purchase_anywhere(), authz.my_active_role_branches(text)
from public, anon, authenticated, service_role;
grant execute on function authz.my_purchase_anywhere(), authz.my_active_role_branches(text)
to authenticated;

drop policy scoped_read on public.crm_leads;
create policy scoped_read on public.crm_leads
  for select to authenticated using (
    (select authz.session_ok())
    and not (select authz.my_purchase_anywhere())
    and (
      (
        owner_user_id = (select auth.uid())
        and branch_id = any ((select authz.my_active_role_branches('sales'))::uuid[])
      )
      or branch_id = any ((select authz.my_active_role_branches('manager'))::uuid[])
      or legal_entity_id = any ((select authz.my_permission_entities('integration.manage', 'entity'))::uuid[])
    )
  );

comment on policy scoped_read on public.crm_leads is
  'Same rule as authz.can_read_lead(id), evaluated once per statement (20261127000200).';

commit;
