-- TripNavigate CRM - Accounts phase 3, track G (1 of 6): over-budget cost
-- approvals bound to the booking version (the gap fix; always on).
-- Contract: accounts-phase3-2026-11-12/contract.md section 10.1, LD26, 17.2
-- ("except the cost-approval fix of 10.1, which is always on once Release B's
-- migrations are applied"), 19 (track G owns cost_version_approved and
-- purchase_cost_approve_over_budget).
--
-- What changes:
--   1. public.purchase_cost_approvals gains booking_version_id (uuid null, FK
--      booking_versions, indexed) and reconfirmation_id (uuid null; its FK to
--      task_reconfirmations is added by 20261205000610, indexed there). The
--      unique key (task_id, version_no) becomes
--      unique (task_id, version_no, booking_version_id): the same cost version
--      may be approved again for a newer booking version. No existing row is
--      changed (legacy rows keep booking_version_id null).
--   2. authz.cost_version_approved(p_task, p_version) (replaces
--      20261005000200:190, same signature; the one check every caller uses):
--      true only when an approval row exists for that cost version AND either
--      its booking_version_id is the task's current booking version
--      (authz.task_current_version) or - a row written before this migration,
--      booking_version_id null - no booking version holding the task's service
--      item was confirmed after approved_at. An approval for an earlier booking
--      version therefore stops counting by itself (as the Accounts go-ahead).
--   3. public.purchase_cost_approve_over_budget (replaces 20261005000200:526,
--      same signature): stores booking_version_id = the task's current
--      version; "already approved" (outcome existing) uses the new rule, so a
--      re-approval after a newer version is a new row.
--   4. authz.sm_manager_cost_rows (replaces 20261204000900:39, same signature;
--      contract Addendum L2): its inline, set-based copy of the approval check
--      gets the same booking-version binding. Same set-based shape; the
--      50-row cap stays in public.manager_approvals (unchanged).
--
-- Refusal tokens: unchanged (not_authorized, already_confirmed, invalid_input,
-- version_changed, the procurement gate tokens).
-- Rollback (forward-only): a NEW migration restoring the two 20261005000200
-- bodies and the 20261204000900 body of authz.sm_manager_cost_rows. The new columns stay (older code never reads them); the old unique
-- key cannot come back once a second approval of one cost version exists.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Columns and key
-- ===========================================================================

alter table public.purchase_cost_approvals
  add column booking_version_id uuid references public.booking_versions (id),
  add column reconfirmation_id uuid;
create index purchase_cost_approvals_booking_version_idx on public.purchase_cost_approvals (booking_version_id)
  where booking_version_id is not null;
comment on column public.purchase_cost_approvals.booking_version_id is
  'Accounts phase 3 (10.1): the booking version the approval was given for; null for rows written before 20261205000600 (they count only while no newer version holding the item was confirmed after approved_at).';
comment on column public.purchase_cost_approvals.reconfirmation_id is
  'Accounts phase 3 (10.4): the reconfirmation (change after a supplier confirmed) whose over-budget cost this row approves.';

-- The auto-named unique (task_id, version_no) of 20261005000200:97.
do $$
declare
  c record;
begin
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.purchase_cost_approvals'::regclass and con.contype = 'u'
      and pg_get_constraintdef(con.oid) = 'UNIQUE (task_id, version_no)'
  loop
    execute format('alter table public.purchase_cost_approvals drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table public.purchase_cost_approvals
  add constraint purchase_cost_approvals_task_version_booking_key unique (task_id, version_no, booking_version_id);

-- ===========================================================================
-- 2. The shared check (replaces 20261005000200:190)
-- ===========================================================================

create or replace function authz.cost_version_approved(p_task uuid, p_version integer) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.purchase_cost_approvals a
    join public.fulfilment_tasks t on t.id = a.task_id
    where a.task_id = p_task and a.version_no = p_version
      and (
        -- Accounts phase 3 (20261205000600): bound to the task's current booking version.
        a.booking_version_id = authz.task_current_version(p_task)
        -- Rows written before 20261205000600: only while no booking version
        -- holding the task's item was confirmed after the approval.
        or (a.booking_version_id is null and not exists (
              select 1 from public.booking_versions v
              join public.service_item_facts f on f.booking_version_id = v.id and f.service_item_id = t.service_item_id
              where v.deal_id = t.deal_id and v.confirmed_at is not null and v.confirmed_at > a.approved_at))))
$$;

-- ===========================================================================
-- 3. The Manager's approval (replaces 20261005000200:526)
-- ===========================================================================

create or replace function public.purchase_cost_approve_over_budget(p_task_id uuid, p_version_no integer) returns jsonb
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
  -- Accounts phase 3 (20261205000600): only an approval for the current booking version counts.
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
  -- Accounts phase 3 (20261205000600): bound to the task's current booking version.
  insert into public.purchase_cost_approvals (task_id, legal_entity_id, version_no, approved_by, booking_version_id)
  values (v_task.id, v_task.legal_entity_id, v_cost.version_no, v_uid, authz.task_current_version(v_task.id));
  -- Amounts stay out of the audit trail.
  perform authz.write_audit('purchase.cost_over_budget_approved', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null, jsonb_build_object('versionNo', v_cost.version_no));
  return jsonb_build_object('taskId', v_task.id, 'versionNo', v_cost.version_no, 'outcome', 'created');
end;
$$;

-- ===========================================================================
-- 4. Manager approvals list (replaces 20261204000900:39; Addendum L2)
-- ===========================================================================

create or replace function authz.sm_manager_cost_rows()
returns table (task_id uuid, version_no integer, since timestamptz, created_by uuid)
language sql stable security definer set search_path = '' as $$
  -- authz.is_branch_sales_manager: an active Manager membership of the Deal's
  -- entity and branch, both enabled.
  with mb as materialized (
    select m.legal_entity_id, m.branch_id
    from public.memberships m
    join public.legal_entities e on e.id = m.legal_entity_id
    join public.branches b on b.id = m.branch_id
    where m.user_id = (select auth.uid()) and m.role_code = 'manager' and m.status = 'active'
      and e.status = 'enabled' and b.status = 'enabled')
  select t.id, c.version_no, c.created_at, c.created_by
  from public.fulfilment_tasks t
  join public.deals d on d.id = t.deal_id
  -- authz.purchase_latest_cost: the task's highest cost version.
  cross join lateral (
    select x.version_no, x.created_at, x.created_by, x.stage, x.amount_paise
    from public.purchase_cost_versions x
    where x.task_id = t.id order by x.version_no desc limit 1) c
  -- authz.task_current_version (b11 revision).
  cross join lateral (
    select coalesce((select v2.id from public.booking_versions v2
                     join public.service_item_facts f2 on f2.booking_version_id = v2.id and f2.service_item_id = t.service_item_id
                     where v2.deal_id = t.deal_id and v2.status = 'confirmed'), t.booking_version_id) as id) cv
  -- authz.task_budget over authz.task_current_version.
  left join lateral (
    select coalesce(f.purchase_budget_paise, v.purchase_budget_paise) as budget
    from public.booking_versions v
    left join public.service_item_facts f on f.service_item_id = t.service_item_id and f.booking_version_id = v.id
    where v.id = cv.id) bu on true
  where t.department = 'purchase' and t.status = 'in_progress'
    and exists (select 1 from mb where mb.legal_entity_id = d.legal_entity_id and mb.branch_id = d.branch_id)
    and c.stage = 'proposed'
    and (bu.budget is null or c.amount_paise > bu.budget)
    -- authz.cost_version_approved (Accounts phase 3, 20261205000600: bound to the booking version)
    and not exists (
      select 1 from public.purchase_cost_approvals a
      where a.task_id = t.id and a.version_no = c.version_no
        and (a.booking_version_id = cv.id
             or (a.booking_version_id is null and not exists (
                   select 1 from public.booking_versions v3
                   join public.service_item_facts f3 on f3.booking_version_id = v3.id and f3.service_item_id = t.service_item_id
                   where v3.deal_id = t.deal_id and v3.confirmed_at is not null and v3.confirmed_at > a.approved_at))))
$$;

commit;
