-- Phase 4 amendment A1: owner answers to P4-D1..P4-D6 (3 October 2026).
-- Contract: docs/implementation/phase-4/contract.md section 9.
--
-- Adds, on top of 20261005000100_purchase_hotel_procurement.sql:
--   P4-D1 supplier_verify: an active manager in the supplier's entity marks a
--         supplier verified; any later change of supplier details by Purchase
--         resets it to unverified.
--   P4-D2 purchase_cost_approve_over_budget: the manager of the deal's branch
--         approves one specific proposed cost version above the budget;
--         readiness then drops over_budget for that version only.
--   P4-D4 supplier_approve_beneficiary: an active manager in the entity
--         approves the latest bank detail revision; never the person who
--         recorded it. Still never used for payment.
--   P4-D5 purchase_task_release (assignee) and purchase_task_reassign
--         (manager of the deal's branch); offers, costs and files stay; the
--         old Purchase deal assignment ends.
--   Manager read: the manager of the deal's branch reads the Purchase
--         workspace (read-only, canWork false).
-- Unchanged: Sales sees status and supplier-confirmed time only (P4-D6); the
-- procurement gate stays off for real deals (P4-D7); no error tokens added;
-- nothing creates a payable, payment or invoice. Every action is audited
-- without amounts or bank values; every command is idempotent on repeat.
--
-- Rollback (forward-only): a NEW migration revoking execute on the five new
-- commands from authenticated. Never delete approvals or audit rows.

begin;

-- ---------------------------------------------------------------------------
-- Columns and tables
-- ---------------------------------------------------------------------------

alter table public.suppliers
  add column verified_by uuid references public.staff_profiles (user_id),
  add column verified_at timestamptz;
alter table public.suppliers
  add constraint suppliers_verification_recorded
    check ((verification_status = 'verified') = (verified_by is not null and verified_at is not null));

do $$
declare
  c record;
begin
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.supplier_beneficiary_revisions'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%status%'
  loop
    execute format('alter table public.supplier_beneficiary_revisions drop constraint %I', c.conname);
  end loop;
end;
$$;

alter table public.supplier_beneficiary_revisions
  add column approved_by uuid references public.staff_profiles (user_id),
  add column approved_at timestamptz;
alter table public.supplier_beneficiary_revisions
  add constraint supplier_beneficiary_revisions_status_check check (status in ('unverified', 'approved')),
  add constraint supplier_beneficiary_revisions_approval_recorded
    check ((status = 'approved') = (approved_by is not null and approved_at is not null)),
  add constraint supplier_beneficiary_revisions_approver_not_recorder
    check (approved_by is null or approved_by <> created_by);
comment on table public.supplier_beneficiary_revisions is
  'Append-only bank detail revisions; only unverified -> approved (manager, not the recorder). Never used for payment. No table grant to authenticated.';

-- Bank values stay immutable; the only allowed change is the approval.
drop trigger supplier_beneficiary_revisions_a_append_only on public.supplier_beneficiary_revisions;
create function authz.beneficiary_revisions_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'supplier_beneficiary_revisions rows are append-only' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['status', 'approved_by', 'approved_at'])
     is distinct from (to_jsonb(old) - array['status', 'approved_by', 'approved_at']) then
    raise exception 'supplier_beneficiary_revisions rows are append-only' using errcode = '42501';
  end if;
  if old.status <> 'unverified' or new.status <> 'approved' then
    raise exception 'only an unverified revision can be approved' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger supplier_beneficiary_revisions_a_guard
  before update or delete on public.supplier_beneficiary_revisions
  for each row execute function authz.beneficiary_revisions_guard();

create table public.purchase_cost_approvals (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  legal_entity_id uuid not null,
  version_no integer not null,
  approved_by uuid not null references public.staff_profiles (user_id),
  approved_at timestamptz not null default now(),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (task_id, version_no) references public.purchase_cost_versions (task_id, version_no),
  unique (task_id, version_no)
);
comment on table public.purchase_cost_approvals is
  'P4-D2: a branch manager approved one proposed cost version above the Purchase budget. Append-only; no amounts.';
create trigger purchase_cost_approvals_a_append_only
  before update or delete on public.purchase_cost_approvals
  for each row execute function authz.procurement_append_only();

alter table public.purchase_cost_approvals enable row level security;
create policy require_valid_session on public.purchase_cost_approvals as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
create policy purchase_read on public.purchase_cost_approvals
  for select to authenticated using (authz.can_read_purchase_workspace(task_id));
revoke all on public.purchase_cost_approvals from public, anon, authenticated, service_role;
grant select on public.purchase_cost_approvals to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Permission catalogue (role-derived)
-- ---------------------------------------------------------------------------

insert into public.permissions (code, description, is_grantable) values
  ('supplier.verify', 'Mark a supplier verified (resets when Purchase changes its details).', false),
  ('supplier.approve_beneficiary', 'Approve the latest bank detail revision recorded by someone else. Not a payment.', false),
  ('purchase_cost.approve_over_budget', 'Approve one proposed Purchase cost above the approved budget.', false),
  ('purchase_task.reassign', 'Reassign an in-progress Purchase task to another Purchase colleague.', false);

insert into public.role_permissions (role_code, permission_code, scope, policy_status, note) values
  ('manager', 'supplier.verify', 'entity', 'confirmed', 'P4-D1 owner answer 3 Oct 2026 (read as branch manager)'),
  ('manager', 'supplier.approve_beneficiary', 'entity', 'confirmed', 'P4-D4 owner answer: approver is never the recorder'),
  ('manager', 'purchase_cost.approve_over_budget', 'own', 'confirmed', 'P4-D2 owner answer: manager of the deal''s branch'),
  ('manager', 'purchase_task.reassign', 'own', 'confirmed', 'P4-D5 owner answer: manager of the deal''s branch');
update public.role_permissions set policy_status = 'confirmed',
  note = 'Phase 4: only the assignee works a claimed task; release by the assignee, reassignment by the branch manager (P4-D5)'
where role_code = 'purchase' and permission_code = 'purchase_task.work';

-- ---------------------------------------------------------------------------
-- Authorization helpers
-- ---------------------------------------------------------------------------

-- Purchase in the entity, or (read-only) the manager of the deal's branch.
create or replace function authz.can_read_purchase_workspace(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task
      and (authz.holds_active_role('purchase', t.legal_entity_id) or authz.is_branch_sales_manager(t.deal_id))
  )
$$;

create function authz.can_verify_suppliers(p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and authz.holds_active_role('manager', p_entity)
$$;

create function authz.can_review_suppliers(p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.can_manage_suppliers(p_entity) or authz.can_verify_suppliers(p_entity)
$$;

create function authz.can_manage_purchase_task(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.fulfilment_tasks t where t.id = p_task and authz.is_branch_sales_manager(t.deal_id)
  )
$$;

-- Another person who could take the task: active staff, active purchase membership in the entity.
create function authz.is_active_purchase_person(p_user uuid, p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.memberships m
    join public.staff_profiles p on p.user_id = m.user_id
    join public.legal_entities e on e.id = m.legal_entity_id
    join public.branches b on b.id = m.branch_id
    where m.user_id = p_user and m.legal_entity_id = p_entity and m.role_code = 'purchase'
      and m.status = 'active' and p.status = 'active' and e.status = 'enabled' and b.status = 'enabled'
  )
$$;

-- Ends a Purchase deal assignment unless the person still holds another
-- in-progress task on the same deal.
create function authz.end_purchase_assignment(p_deal uuid, p_user uuid) returns void
language sql volatile security definer set search_path = '' as $$
  update public.deal_assignments a set ended_at = now()
  where a.deal_id = p_deal and a.user_id = p_user and a.assignment_kind = 'purchase' and a.ended_at is null
    and not exists (
      select 1 from public.fulfilment_tasks t
      where t.deal_id = p_deal and t.assignee_user_id = p_user and t.status = 'in_progress'
    )
$$;

-- P4-D2: an approval exists for this exact cost version.
create function authz.cost_version_approved(p_task uuid, p_version integer) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.purchase_cost_approvals a where a.task_id = p_task and a.version_no = p_version)
$$;

create function authz.task_budget(p_task uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select v.purchase_budget_paise
  from public.fulfilment_tasks t join public.booking_versions v on v.id = t.booking_version_id
  where t.id = p_task
$$;

-- Readiness (contract 7): over_budget is not listed when the latest proposed
-- version carries a manager approval (amendment A1).
create or replace function authz.procurement_issues(p_task uuid) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v_issues text[] := '{}'::text[];
  v_gate text := authz.procurement_gate_issue(p_task);
  v_cost public.purchase_cost_versions;
  v_budget bigint;
begin
  if v_gate is not null then
    v_issues := v_issues || v_gate;
  end if;
  if not exists (select 1 from public.purchase_quotes q where q.task_id = p_task and q.status = 'open') then
    v_issues := v_issues || 'missing_quote'::text;
  end if;
  v_cost := authz.purchase_latest_cost(p_task);
  if v_cost.id is null then
    v_issues := v_issues || 'missing_cost'::text;
  else
    if not exists (select 1 from public.purchase_quotes q where q.id = v_cost.quote_id and q.status = 'open') then
      v_issues := v_issues || 'cost_not_for_quote'::text;
    end if;
    v_budget := authz.task_budget(p_task);
    if (v_budget is null or v_cost.amount_paise > v_budget)
       and not authz.cost_version_approved(p_task, v_cost.version_no) then
      v_issues := v_issues || 'over_budget'::text;
    end if;
  end if;
  if not exists (select 1 from public.purchase_evidence e
                 where e.task_id = p_task and e.kind = 'supplier_confirmation' and e.status = 'stored') then
    v_issues := v_issues || 'missing_supplier_confirmation_proof'::text;
  end if;
  if exists (select 1 from public.purchase_evidence e where e.task_id = p_task and e.status = 'pending_upload') then
    v_issues := v_issues || 'evidence_upload_incomplete'::text;
  end if;
  return v_issues;
end;
$$;

-- P4-D5: release and reassignment move the task only inside their commands,
-- which set a transaction-local marker; every other change stays refused.
create or replace function authz.fulfilment_tasks_state_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_transition text := coalesce(current_setting('authz.task_transition', true), '');
begin
  if old.status = 'supplier_confirmed' then
    raise exception 'supplier-confirmed tasks are immutable' using errcode = '42501';
  end if;
  if old.status = 'not_started' and new.status = 'supplier_confirmed' then
    raise exception 'fulfilment task status cannot move this way' using errcode = '42501';
  end if;
  if old.status = 'in_progress' and new.status = 'not_started' and v_transition <> 'release' then
    raise exception 'fulfilment task status cannot move this way' using errcode = '42501';
  end if;
  -- Review L1: the assignee may change only by reassignment (in_progress -> in_progress);
  -- never together with supplier confirmation.
  if old.status = 'in_progress' and new.status = 'supplier_confirmed'
     and new.assignee_user_id is distinct from old.assignee_user_id then
    raise exception 'fulfilment task assignee cannot change at supplier confirmation' using errcode = '42501';
  end if;
  if old.status = 'in_progress' and new.status = 'in_progress'
     and new.assignee_user_id is distinct from old.assignee_user_id and v_transition <> 'reassign' then
    raise exception 'fulfilment task assignee changes only through reassignment' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function
  authz.beneficiary_revisions_guard(), authz.can_verify_suppliers(uuid), authz.can_review_suppliers(uuid),
  authz.can_manage_purchase_task(uuid), authz.is_active_purchase_person(uuid, uuid),
  authz.end_purchase_assignment(uuid, uuid), authz.cost_version_approved(uuid, integer), authz.task_budget(uuid)
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Supplier reads (managers review; Purchase manages)
-- ---------------------------------------------------------------------------

create or replace function authz.supplier_json(p_supplier uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'supplierId', s.id,
    'legalEntityId', s.legal_entity_id,
    'name', s.name,
    'serviceTypes', to_jsonb(s.service_types),
    'city', s.city,
    'contactName', s.contact_name,
    'contactPhone', s.contact_phone,
    'contactEmail', s.contact_email,
    'paymentTerms', s.payment_terms,
    'verificationStatus', s.verification_status,
    'verifiedAt', s.verified_at,
    'verifiedByName', vp.display_name,
    'status', s.status,
    'rowVersion', s.row_version,
    'updatedAt', s.updated_at)
  from public.suppliers s
  left join public.staff_profiles vp on vp.user_id = s.verified_by
  where s.id = p_supplier
$$;

create or replace function public.supplier_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(authz.supplier_json(s.id) order by s.status, lower(s.name), s.id)
    from public.suppliers s
    where authz.can_review_suppliers(s.legal_entity_id)
  ), '[]'::jsonb);
end;
$$;

create or replace function public.supplier_get(p_supplier_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_s public.suppliers%rowtype;
  v_uid uuid := (select auth.uid());
  v_manager boolean;
  v_latest integer;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_s from public.suppliers s where s.id = p_supplier_id;
  if v_s.id is null or not authz.can_review_suppliers(v_s.legal_entity_id) then
    return null;
  end if;
  v_manager := authz.can_verify_suppliers(v_s.legal_entity_id);
  select max(r.revision_no) into v_latest from public.supplier_beneficiary_revisions r where r.supplier_id = v_s.id;
  return authz.supplier_json(v_s.id) || jsonb_build_object(
    'canEdit', authz.can_manage_suppliers(v_s.legal_entity_id),
    'canVerify', v_manager and v_s.status = 'active' and v_s.verification_status = 'unverified'
                 and v_s.updated_by is distinct from v_uid,
    'beneficiaries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'revisionNo', r.revision_no,
        'accountHolder', r.account_holder,
        'bankName', r.bank_name,
        'ifsc', r.ifsc,
        'accountLast4', right(r.account_number, 4),
        'status', r.status,
        'createdAt', r.created_at,
        'createdByName', p.display_name,
        'approvedAt', r.approved_at,
        'approvedByName', ap.display_name,
        'canApprove', v_manager and r.status = 'unverified' and r.revision_no = v_latest
                      and r.created_by is distinct from v_uid) order by r.revision_no desc)
      from public.supplier_beneficiary_revisions r
      left join public.staff_profiles p on p.user_id = r.created_by
      left join public.staff_profiles ap on ap.user_id = r.approved_by
      where r.supplier_id = v_s.id), '[]'::jsonb));
end;
$$;

-- Any change of supplier details by Purchase resets verification (P4-D1).
-- A status-only change (archive/restore) keeps it.
create or replace function public.supplier_update(p_supplier_id uuid, p_expected_row_version integer, p_fields jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_s public.suppliers%rowtype;
  v_name text;
  v_status text;
  v_types text[];
  v_city text;
  v_contact text;
  v_phone text;
  v_email text;
  v_terms text;
  v_details_changed boolean;
  v_reset boolean;
  v_changed text[];
begin
  select * into v_s from public.suppliers s where s.id = p_supplier_id for update;
  if v_s.id is null or not authz.can_manage_suppliers(v_s.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v_s.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  perform authz.supplier_fields_check(p_fields);
  v_name := authz.booking_fact_text(p_fields, 'name', 200, false);
  v_status := coalesce(authz.booking_fact_text(p_fields, 'status', 20, false), v_s.status);
  if v_name is null or v_status not in ('active', 'archived') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if exists (select 1 from public.suppliers s
             where s.legal_entity_id = v_s.legal_entity_id and lower(s.name) = lower(v_name) and s.id <> v_s.id) then
    raise exception 'supplier_exists' using errcode = '23505';
  end if;
  v_types := authz.supplier_service_types(p_fields);
  v_city := authz.booking_fact_text(p_fields, 'city', 120, false);
  v_contact := authz.booking_fact_text(p_fields, 'contactName', 120, false);
  v_phone := authz.booking_fact_text(p_fields, 'contactPhone', 40, false);
  v_email := authz.booking_fact_text(p_fields, 'contactEmail', 254, false);
  v_terms := authz.booking_fact_text(p_fields, 'paymentTerms', 1000, true);
  v_details_changed := (v_name, v_types, v_city, v_contact, v_phone, v_email, v_terms)
    is distinct from (v_s.name, v_s.service_types, v_s.city, v_s.contact_name, v_s.contact_phone, v_s.contact_email,
                      v_s.payment_terms);
  v_reset := v_details_changed and v_s.verification_status = 'verified';

  begin
    update public.suppliers s set
      name = v_name,
      service_types = v_types,
      city = v_city,
      contact_name = v_contact,
      contact_phone = v_phone,
      contact_email = v_email,
      payment_terms = v_terms,
      status = v_status,
      verification_status = case when v_details_changed then 'unverified' else s.verification_status end,
      verified_by = case when v_details_changed then null else s.verified_by end,
      verified_at = case when v_details_changed then null else s.verified_at end,
      row_version = s.row_version + 1,
      updated_by = case when v_details_changed then (select auth.uid()) else s.updated_by end,
      updated_at = now()
    where s.id = v_s.id
    returning * into v_s;
  exception
    when unique_violation then
      raise exception 'supplier_exists' using errcode = '23505';
    when check_violation then
      raise exception 'invalid_input' using errcode = '22023';
  end;

  -- Field names only; contact values are not copied into the audit trail.
  select coalesce(array_agg(k order by k), '{}') into v_changed from jsonb_object_keys(p_fields) k;
  perform authz.write_audit('supplier.updated', v_s.legal_entity_id, null, 'supplier', v_s.id, null,
    jsonb_build_object('fields', to_jsonb(v_changed), 'rowVersion', v_s.row_version, 'status', v_s.status,
      'detailsChanged', v_details_changed, 'verificationReset', v_reset));
  return jsonb_build_object('supplierId', v_s.id, 'rowVersion', v_s.row_version);
end;
$$;

-- ---------------------------------------------------------------------------
-- Manager commands
-- ---------------------------------------------------------------------------

create function public.supplier_verify(p_supplier_id uuid, p_expected_row_version integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_s public.suppliers%rowtype;
  v_uid uuid := (select auth.uid());
begin
  select * into v_s from public.suppliers s where s.id = p_supplier_id for update;
  if v_s.id is null or not authz.can_verify_suppliers(v_s.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if v_s.verification_status = 'verified' then
    return jsonb_build_object('supplierId', v_s.id, 'rowVersion', v_s.row_version, 'outcome', 'existing');
  end if;
  if p_expected_row_version is distinct from v_s.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  -- Separation of duties: the person who created the supplier or last entered the
  -- details does not verify them (review L2).
  if v_s.updated_by = v_uid or v_s.created_by = v_uid then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_s.status <> 'active' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  update public.suppliers s
  set verification_status = 'verified', verified_by = v_uid, verified_at = now(), row_version = s.row_version + 1
  where s.id = v_s.id
  returning * into v_s;
  perform authz.write_audit('supplier.verified', v_s.legal_entity_id, null, 'supplier', v_s.id, null,
    jsonb_build_object('rowVersion', v_s.row_version));
  return jsonb_build_object('supplierId', v_s.id, 'rowVersion', v_s.row_version, 'outcome', 'created');
end;
$$;

create function public.supplier_approve_beneficiary(p_supplier_id uuid, p_revision_no integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_s public.suppliers%rowtype;
  v_r public.supplier_beneficiary_revisions%rowtype;
  v_uid uuid := (select auth.uid());
  v_latest integer;
begin
  select * into v_s from public.suppliers s where s.id = p_supplier_id for update;
  if v_s.id is null or not authz.can_verify_suppliers(v_s.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  select * into v_r from public.supplier_beneficiary_revisions r
  where r.supplier_id = v_s.id and r.revision_no = p_revision_no for update;
  if v_r.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_r.status = 'approved' then
    return jsonb_build_object('revisionNo', v_r.revision_no, 'status', 'approved', 'outcome', 'existing');
  end if;
  if v_r.created_by = v_uid then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select max(r.revision_no) into v_latest from public.supplier_beneficiary_revisions r where r.supplier_id = v_s.id;
  if v_r.revision_no <> v_latest then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  update public.supplier_beneficiary_revisions r
  set status = 'approved', approved_by = v_uid, approved_at = now()
  where r.id = v_r.id;
  -- No bank values in the audit trail.
  perform authz.write_audit('supplier.beneficiary_approved', v_s.legal_entity_id, null, 'supplier', v_s.id, null,
    jsonb_build_object('revisionNo', v_r.revision_no));
  return jsonb_build_object('revisionNo', v_r.revision_no, 'status', 'approved', 'outcome', 'created');
end;
$$;

create function public.purchase_cost_approve_over_budget(p_task_id uuid, p_version_no integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_cost public.purchase_cost_versions%rowtype;
  v_latest public.purchase_cost_versions;
  v_gate text;
  v_budget bigint;
  v_uid uuid := (select auth.uid());
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or not authz.can_manage_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_task.status = 'supplier_confirmed' then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  select * into v_cost from public.purchase_cost_versions c where c.task_id = v_task.id and c.version_no = p_version_no;
  if v_cost.id is null or v_task.status <> 'in_progress' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- Review L9: a repeat answers 'existing' even after the gate closed.
  if authz.cost_version_approved(v_task.id, v_cost.version_no) then
    return jsonb_build_object('taskId', v_task.id, 'versionNo', v_cost.version_no, 'outcome', 'existing');
  end if;
  v_gate := authz.procurement_gate_issue(v_task.id);
  if v_gate is not null then
    raise exception '%', v_gate using errcode = '55000';
  end if;
  v_latest := authz.purchase_latest_cost(v_task.id);
  if v_latest.version_no <> v_cost.version_no then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_budget := authz.task_budget(v_task.id);
  if v_cost.stage <> 'proposed' or (v_budget is not null and v_cost.amount_paise <= v_budget) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if v_cost.created_by = v_uid then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  insert into public.purchase_cost_approvals (task_id, legal_entity_id, version_no, approved_by)
  values (v_task.id, v_task.legal_entity_id, v_cost.version_no, v_uid);
  -- Amounts stay out of the audit trail.
  perform authz.write_audit('purchase.cost_over_budget_approved', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null, jsonb_build_object('versionNo', v_cost.version_no));
  return jsonb_build_object('taskId', v_task.id, 'versionNo', v_cost.version_no, 'outcome', 'created');
end;
$$;

create function public.purchase_task_release(p_task_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_uid uuid := (select auth.uid());
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or not authz.can_claim_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if v_task.status = 'supplier_confirmed' then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  if v_task.assignee_user_id is null then
    return jsonb_build_object('taskId', v_task.id, 'status', 'not_started', 'outcome', 'existing');
  end if;
  if v_task.assignee_user_id <> v_uid then
    raise exception 'task_conflict' using errcode = '40001';
  end if;

  perform set_config('authz.task_transition', 'release', true);
  update public.fulfilment_tasks t set status = 'not_started', assignee_user_id = null, updated_at = now()
  where t.id = v_task.id;
  perform set_config('authz.task_transition', '', true);
  perform authz.end_purchase_assignment(v_task.deal_id, v_uid);

  perform authz.write_audit('fulfilment.task_released', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null, jsonb_build_object('dealId', v_task.deal_id, 'fromUserId', v_uid));
  return jsonb_build_object('taskId', v_task.id, 'status', 'not_started', 'outcome', 'created');
end;
$$;

create function public.purchase_task_reassign(p_task_id uuid, p_expected_assignee uuid, p_to_user_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_from uuid;
  v_uid uuid := (select auth.uid());
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or not authz.can_manage_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if v_task.status = 'supplier_confirmed' then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  if p_to_user_id is null or p_expected_assignee is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if v_task.status = 'in_progress' and v_task.assignee_user_id = p_to_user_id then
    return jsonb_build_object('taskId', v_task.id, 'outcome', 'existing');
  end if;
  if v_task.status <> 'in_progress' or v_task.assignee_user_id is distinct from p_expected_assignee then
    raise exception 'task_conflict' using errcode = '40001';
  end if;
  if not authz.is_active_purchase_person(p_to_user_id, v_task.legal_entity_id) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  v_from := v_task.assignee_user_id;
  perform set_config('authz.task_transition', 'reassign', true);
  update public.fulfilment_tasks t set assignee_user_id = p_to_user_id, updated_at = now() where t.id = v_task.id;
  perform set_config('authz.task_transition', '', true);
  perform authz.end_purchase_assignment(v_task.deal_id, v_from);
  insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
  values (v_task.deal_id, v_task.legal_entity_id, p_to_user_id, 'purchase', v_uid)
  on conflict (deal_id, user_id, assignment_kind) where ended_at is null do nothing;

  perform authz.write_audit('fulfilment.task_reassigned', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('dealId', v_task.deal_id, 'fromUserId', v_from, 'toUserId', p_to_user_id));
  return jsonb_build_object('taskId', v_task.id, 'outcome', 'created');
end;
$$;

-- ---------------------------------------------------------------------------
-- Workspace read: manager flags, approvals, release/reassign options
-- ---------------------------------------------------------------------------

create or replace function public.purchase_workspace(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_uid uuid := (select auth.uid());
  v_manager boolean;
  v_latest public.purchase_cost_versions;
  v_budget bigint;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or not authz.can_read_purchase_workspace(v_task.id) then
    return null;
  end if;
  v_manager := authz.can_manage_purchase_task(v_task.id);
  v_latest := authz.purchase_latest_cost(v_task.id);
  v_budget := authz.task_budget(v_task.id);
  return jsonb_build_object(
    'task', authz.purchase_task_json(v_task.id, true),
    'canWork', authz.can_work_purchase_task(v_task.id) and v_task.status = 'in_progress',
    'canRelease', authz.can_work_purchase_task(v_task.id) and v_task.status = 'in_progress',
    'canReassign', v_manager and v_task.status = 'in_progress',
    'canApproveOverBudget', v_manager and v_task.status = 'in_progress' and v_latest.id is not null
      and v_latest.stage = 'proposed' and (v_budget is null or v_latest.amount_paise > v_budget)
      and not authz.cost_version_approved(v_task.id, v_latest.version_no)
      and v_latest.created_by is distinct from v_uid
      and authz.procurement_gate_issue(v_task.id) is null,
    'assigneeUserId', v_task.assignee_user_id,
    'reassignCandidates', case when v_manager and v_task.status = 'in_progress' then coalesce((
      select jsonb_agg(jsonb_build_object('userId', p.user_id, 'name', p.display_name) order by p.display_name, p.user_id)
      from public.staff_profiles p
      where p.user_id is distinct from v_task.assignee_user_id
        and authz.is_active_purchase_person(p.user_id, v_task.legal_entity_id)), '[]'::jsonb)
      else '[]'::jsonb end,
    'gateIssue', authz.procurement_gate_issue(v_task.id),
    'issues', case when v_task.status = 'in_progress' then to_jsonb(authz.procurement_issues(v_task.id))
                   else '[]'::jsonb end,
    'supplierReference', v_task.supplier_reference,
    'selectedQuoteId', v_task.selected_quote_id,
    'supplierConfirmedByName', (select p.display_name from public.staff_profiles p
                                where p.user_id = v_task.supplier_confirmed_by),
    'quotes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'quoteId', q.id,
        'supplierId', q.supplier_id,
        'supplierName', s.name,
        'supplierVerification', s.verification_status,
        'hotelName', q.hotel_name,
        'roomType', q.room_type,
        'mealPlan', q.meal_plan,
        'quotedCostPaise', q.quoted_cost_paise::text,
        'holdUntil', to_char(q.hold_until, 'YYYY-MM-DD'),
        'cancellationTerms', q.cancellation_terms,
        'status', q.status,
        'createdAt', q.created_at,
        'createdByName', p.display_name) order by q.created_at, q.id)
      from public.purchase_quotes q
      join public.suppliers s on s.id = q.supplier_id
      left join public.staff_profiles p on p.user_id = q.created_by
      where q.task_id = v_task.id), '[]'::jsonb),
    'costVersions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'versionNo', c.version_no,
        'quoteId', c.quote_id,
        'stage', c.stage,
        'amountPaise', c.amount_paise::text,
        'dueDate', to_char(c.due_date, 'YYYY-MM-DD'),
        'note', c.note,
        'payableStatus', c.payable_status,
        'createdAt', c.created_at,
        'createdByName', p.display_name,
        'overBudgetApprovedAt', a.approved_at,
        'overBudgetApprovedByName', ap.display_name) order by c.version_no desc)
      from public.purchase_cost_versions c
      left join public.staff_profiles p on p.user_id = c.created_by
      left join public.purchase_cost_approvals a on a.task_id = c.task_id and a.version_no = c.version_no
      left join public.staff_profiles ap on ap.user_id = a.approved_by
      where c.task_id = v_task.id), '[]'::jsonb),
    'evidence', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id,
        'kind', e.kind,
        'fileName', e.file_name,
        'mime', e.mime,
        'sizeBytes', e.size_bytes,
        'status', e.status,
        'createdAt', e.created_at,
        'uploadedByName', p.display_name) order by e.created_at, e.id)
      from public.purchase_evidence e
      left join public.staff_profiles p on p.user_id = e.uploaded_by
      where e.task_id = v_task.id and e.status <> 'removed'), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function
  public.supplier_verify(uuid, integer),
  public.supplier_approve_beneficiary(uuid, integer),
  public.purchase_cost_approve_over_budget(uuid, integer),
  public.purchase_task_release(uuid),
  public.purchase_task_reassign(uuid, uuid, uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.supplier_verify(uuid, integer),
  public.supplier_approve_beneficiary(uuid, integer),
  public.purchase_cost_approve_over_budget(uuid, integer),
  public.purchase_task_release(uuid),
  public.purchase_task_reassign(uuid, uuid, uuid)
to authenticated;

commit;
