-- TripNavigate CRM - Direction A Batch 6, item 1: Purchase work, the Purchase
-- workspace read, reassignment and its candidates follow the task's department.
--
-- Gap: authz.can_work_purchase_task (20261005000100, never replaced since)
-- checks that the caller is the task's assignee and holds an active Purchase
-- role in the task's legal entity, but not that the task belongs to the
-- Purchase department. Since B1 (20261118000100) a fulfilment task carries
-- department 'purchase' or 'flight' (visa since 20261119000500). A person
-- holding both the Flight and the Purchase role who took a flight task could
-- therefore drive it through the Purchase commands (quote, cost, supplier
-- confirmation file, supplier confirmation) to supplier_confirmed.
--
-- What changes:
--   1. authz.can_work_purchase_task(uuid): adds t.department = 'purchase'.
--      This one predicate gates authz.lock_workable_task (purchase_quote_add,
--      purchase_quote_withdraw, purchase_cost_propose, purchase_evidence_begin),
--      purchase_supplier_confirm, purchase_evidence_finish,
--      purchase_evidence_remove and the canWork / canRelease flags of
--      purchase_workspace. A non-Purchase task now gets not_authorized (42501)
--      from every one of them.
--   2. authz.lock_workable_task(uuid): the same department condition, stated
--      again in the work gate itself (defence in depth, so a future
--      replacement of the predicate cannot reopen the gap for the four gated
--      commands). Body copied unchanged from its latest definition
--      (20261107000300) except the line marked "Batch 6".
--   3. authz.can_read_purchase_workspace(uuid): the Purchase-role branch now
--      also requires t.department = 'purchase'; the branch-manager branch is
--      unchanged. Before, a Purchase holder could read any flight or visa task
--      of the entity through purchase_workspace (flight facts, the item
--      budget and the travellers' full names), although B1 (20261118000100)
--      already limited authz.can_read_purchase_task to Purchase tasks. The
--      same predicate drives the select policies on purchase_quotes,
--      purchase_cost_versions, purchase_evidence and purchase_cost_approvals,
--      purchase_evidence_authorize_download and the purchase files of
--      deal_documents_list; for Purchase tasks nothing changes. No screen or
--      command loads purchase_workspace for a flight task for a Purchase
--      holder: the Purchase task page first needs purchase_task_get, which
--      already refuses non-Purchase tasks to Purchase holders, and flight
--      tasks link to the Flight page.
--   4. New helper authz.is_active_department_person(p_user, p_entity,
--      p_department): active staff with an active membership in the
--      department's role in the entity, entity and branch enabled. For
--      'purchase' it is exactly authz.is_active_purchase_person. Definer,
--      stable, search_path = '', no execute for public, anon or authenticated
--      (as authz.is_active_purchase_person).
--   5. public.purchase_task_reassign(uuid, uuid, uuid): the new assignee must
--      pass authz.is_active_department_person for the task's department
--      (before: always the Purchase role), and the Deal assignment follows the
--      department: the new assignee gets an assignment of the department's
--      kind ('purchase', 'flight' or 'visa', exactly as purchase_task_claim,
--      flight_task_claim and visa_task_claim record it); for a flight or visa
--      task the previous assignee's assignment of that kind ends unless they
--      still hold another in-progress task of that department on the Deal
--      (a Purchase task keeps authz.end_purchase_assignment unchanged).
--      Before, a reassigned flight task gave the new person a 'purchase'
--      assignment and left the old Flight person's assignment open, so the old
--      person kept reading the Deal. Flight and visa have no reassign or
--      release command of their own, and a branch manager can open such a
--      task on the Purchase task page (purchase_task_list lists every task of
--      the manager's Deals), so this stays the manager's only way to move a
--      stuck flight or visa task and is not refused. Refusal unchanged:
--      invalid_input (22023). Body copied unchanged from its latest definition
--      (20261005000200) except the lines marked "Batch 6".
--   6. public.purchase_workspace(uuid): reassignCandidates uses the same
--      helper with the task's department, so the manager is offered exactly
--      the people purchase_task_reassign accepts (before: Purchase people only,
--      whom a flight or visa reassign now refuses). Body copied unchanged from
--      its latest definition (20261005000200) except the line marked
--      "Batch 6". Same signature and jsonb return, so the generated database
--      types do not change.
--
-- Unchanged: signatures, return types, volatility (stable / volatile),
-- security definer, search_path = '', owners and grants (CREATE OR REPLACE
-- keeps the ACL; the original revokes and grants are restated below and
-- change nothing). No Flight, Visa or department command uses
-- can_work_purchase_task or lock_workable_task: the Flight desk works through
-- flight_task_claim and the department_* commands, which use
-- authz.can_work_department_task.
--
-- Rollback (forward-only): a new migration restoring the previous bodies of
-- the five replaced functions (20261005000100, 20261005000200 and
-- 20261107000300); the new helper may stay (nothing else uses it).
--
-- Apply history: written 24 October 2026 and amended in place the same day
-- after the Echo Batch 6 review (M1 candidates, L1 assignment kind); run only
-- on disposable local test databases. Not applied to any hosted project.

begin;
set local lock_timeout = '15s';

-- Replaces 20261005000100: the caller is the assignee, holds an active
-- Purchase role in the task's entity, and the task is a Purchase task.
create or replace function authz.can_work_purchase_task(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task
      and t.department = 'purchase'
      and t.assignee_user_id = (select auth.uid())
      and authz.holds_active_role('purchase', t.legal_entity_id)
  )
$$;
revoke all on function authz.can_work_purchase_task(uuid) from public, anon, authenticated;

-- Replaces 20261107000300: unchanged except the department condition.
create or replace function authz.lock_workable_task(p_task uuid) returns public.fulfilment_tasks
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_gate text;
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task for update;
  -- Batch 6: Purchase work only on Purchase department tasks.
  if v_task.id is null or v_task.department is distinct from 'purchase' or not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_task.status = 'supplier_confirmed' then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  -- Stage 0: wait for an in-flight removal of the Deal (it holds FOR UPDATE)
  -- so the gate below reads its committed result.
  perform 1 from public.deals d where d.id = v_task.deal_id for key share;
  v_gate := authz.procurement_gate_issue(v_task.id);
  if v_gate is not null then
    raise exception '%', v_gate using errcode = '55000';
  end if;
  return v_task;
end;
$$;
revoke all on function authz.lock_workable_task(uuid) from public, anon, authenticated;

-- Replaces 20261005000200: the Purchase-role branch reads Purchase tasks only;
-- the branch manager (read-only) branch is unchanged.
create or replace function authz.can_read_purchase_workspace(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task
      and ((t.department = 'purchase' and authz.holds_active_role('purchase', t.legal_entity_id))
           or authz.is_branch_sales_manager(t.deal_id))
  )
$$;
revoke all on function authz.can_read_purchase_workspace(uuid) from public, anon, authenticated;
-- RLS policies call it as the invoker.
grant execute on function authz.can_read_purchase_workspace(uuid) to authenticated;

-- Batch 6: another person who could take a task of this department: active
-- staff, active membership in the department's role in the entity, entity and
-- branch enabled. For 'purchase' this is exactly
-- authz.is_active_purchase_person (20261005000200).
create function authz.is_active_department_person(p_user uuid, p_entity uuid, p_department text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.memberships m
    join public.staff_profiles p on p.user_id = m.user_id
    join public.legal_entities e on e.id = m.legal_entity_id
    join public.branches b on b.id = m.branch_id
    where m.user_id = p_user and m.legal_entity_id = p_entity and m.role_code = p_department
      and m.status = 'active' and p.status = 'active' and e.status = 'enabled' and b.status = 'enabled'
  )
$$;
revoke all on function authz.is_active_department_person(uuid, uuid, text) from public, anon, authenticated;

-- Replaces 20261005000200: unchanged except the new assignee's role check and
-- the Deal assignment kind (lines marked "Batch 6").
create or replace function public.purchase_task_reassign(p_task_id uuid, p_expected_assignee uuid, p_to_user_id uuid)
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
  -- Batch 6: the new assignee holds the active role of the task's department
  -- (for a Purchase task the same rule as authz.is_active_purchase_person).
  if not authz.is_active_department_person(p_to_user_id, v_task.legal_entity_id, v_task.department) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  v_from := v_task.assignee_user_id;
  perform set_config('authz.task_transition', 'reassign', true);
  update public.fulfilment_tasks t set assignee_user_id = p_to_user_id, updated_at = now() where t.id = v_task.id;
  perform set_config('authz.task_transition', '', true);
  -- Batch 6: the Deal assignment follows the task's department (kind
  -- 'purchase', 'flight' or 'visa', as purchase_task_claim, flight_task_claim
  -- and visa_task_claim record it). A Purchase task keeps the previous call.
  if v_task.department = 'purchase' then
    perform authz.end_purchase_assignment(v_task.deal_id, v_from);
  else
    -- The previous assignee's assignment of this department ends unless they
    -- still hold another in-progress task of the same department on the Deal.
    update public.deal_assignments a set ended_at = now()
    where a.deal_id = v_task.deal_id and a.user_id = v_from and a.assignment_kind = v_task.department
      and a.ended_at is null
      and not exists (
        select 1 from public.fulfilment_tasks t
        where t.deal_id = v_task.deal_id and t.assignee_user_id = v_from and t.status = 'in_progress'
          and t.department = v_task.department
      );
  end if;
  insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
  values (v_task.deal_id, v_task.legal_entity_id, p_to_user_id, v_task.department, v_uid)
  on conflict (deal_id, user_id, assignment_kind) where ended_at is null do nothing;

  perform authz.write_audit('fulfilment.task_reassigned', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('dealId', v_task.deal_id, 'fromUserId', v_from, 'toUserId', p_to_user_id));
  return jsonb_build_object('taskId', v_task.id, 'outcome', 'created');
end;
$$;
revoke all on function public.purchase_task_reassign(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.purchase_task_reassign(uuid, uuid, uuid) to authenticated;

-- Replaces 20261005000200: unchanged except the reassign candidates, which now
-- follow the task's department (line marked "Batch 6"). Same signature and
-- return type (jsonb), so the generated database types do not change.
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
        -- Batch 6: candidates of the task's department (same rule as purchase_task_reassign).
        and authz.is_active_department_person(p.user_id, v_task.legal_entity_id, v_task.department)), '[]'::jsonb)
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
revoke all on function public.purchase_workspace(uuid) from public, anon, authenticated, service_role;
grant execute on function public.purchase_workspace(uuid) to authenticated;

commit;
