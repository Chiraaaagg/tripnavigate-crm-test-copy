-- TripNavigate CRM - Batch 1 reference data.
--
-- This migration contains ONLY owner-confirmed organization facts and the
-- role/permission catalogue. It creates no staff, no memberships, no grants and
-- no deals: real staff and grants stay unconfigured until the business supplies
-- them. Synthetic test data lives in supabase/fixtures and supabase/seed.sql and
-- is never part of a migration.
--
-- policy_status:
--   confirmed = traceable to an owner decision in docs/04-decisions-and-questions.md
--   proposed  = engineering proposal awaiting owner/department approval

-- Confirmed: D03 legal name, launch entity, three branches, Jodhpur head office.
-- No GSTIN or registration mapping is recorded (D03a / D09 open).
insert into public.legal_entities (code, legal_name, status)
values ('HOLIDAY_CHACHA', 'Holiday Chacha Pvt LTD', 'enabled');

insert into public.branches (legal_entity_id, code, name, state_name, is_head_office)
select e.id, b.code, b.name, b.state_name, b.is_head_office
from public.legal_entities e
cross join (values
  ('DEL', 'Delhi', 'Delhi', false),
  ('AMD', 'Ahmedabad', 'Gujarat', false),
  ('JDH', 'Jodhpur', 'Rajasthan', true)
) as b (code, name, state_name, is_head_office)
where e.code = 'HOLIDAY_CHACHA';

-- Role catalogue from the PRD role set (P p2). The set itself still needs owner
-- confirmation (source assessment, "Roles"), so every role is proposed.
insert into public.roles (code, name, description, policy_status) values
  ('sales', 'Sales', 'Works owned/assigned deals; Sales stages remain in Bitrix (D05).', 'proposed'),
  ('accounts', 'Accounts', 'Reviews bills and records actual money (D11). No posting in Batch 1.', 'proposed'),
  ('purchase', 'Purchase', 'Hotels, transfers and activities (D13). Never sees selling price or margin.', 'proposed'),
  ('flight', 'Flight', 'Flight fulfilment for assigned deals.', 'proposed'),
  ('visa', 'Visa', 'Visa fulfilment for assigned deals.', 'proposed'),
  ('manager', 'Manager', 'Approvals and wider oversight only through explicit grants. No self-approval (D07).', 'proposed'),
  ('super_admin', 'Super Admin', 'Staff and access administration. Business data and money permissions are not implied.', 'proposed');

insert into public.permissions (code, description, is_grantable) values
  ('deal.read', 'View deal header for owned/assigned deals, or within an explicit wider scope.', true),
  ('deal.read_commercial', 'View selling price and margin values.', true),
  ('staff.invite', 'Invite staff into a branch and role.', false),
  ('staff.manage', 'View staff, deactivate staff and authorize MFA recovery.', false),
  ('access.grant', 'Create and revoke explicit wider-scope access grants.', false),
  ('audit.read', 'Read standard (non-commercial) audit events.', false);

insert into public.role_permissions (role_code, permission_code, scope, policy_status, note) values
  -- Confirmed: ordinary staff see owned/assigned deals; broader rights are explicit.
  ('sales', 'deal.read', 'own', 'confirmed', 'Owned/assigned only'),
  ('accounts', 'deal.read', 'own', 'confirmed', 'Owned/assigned only; wider Accounts scope needs an explicit grant'),
  ('purchase', 'deal.read', 'own', 'confirmed', 'Assigned only'),
  ('flight', 'deal.read', 'own', 'confirmed', 'Assigned only'),
  ('visa', 'deal.read', 'own', 'confirmed', 'Assigned only'),
  ('manager', 'deal.read', 'own', 'confirmed', 'Wider branch/entity view needs an explicit grant'),
  -- Proposed: which roles see selling-side values on their own deals.
  ('sales', 'deal.read_commercial', 'own', 'proposed', 'Sales prepares quotes'),
  ('accounts', 'deal.read_commercial', 'own', 'proposed', 'Needed for bill review'),
  ('manager', 'deal.read_commercial', 'own', 'proposed', null),
  -- Proposed: administration is entity-wide but excludes business data.
  ('super_admin', 'staff.invite', 'entity', 'proposed', null),
  ('super_admin', 'staff.manage', 'entity', 'proposed', null),
  ('super_admin', 'access.grant', 'entity', 'proposed', null),
  ('super_admin', 'audit.read', 'entity', 'proposed', 'Standard events only; commercial events hidden');
-- Deliberately absent (confirmed): purchase -> deal.read_commercial.
