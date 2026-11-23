-- Accounts phase 2, lead fix-forward (speed, final verification 12 Nov 2026):
-- Manager › Approvals took 2.6 s and returned 1.8 MB on the speed seed
-- (3,333 costs above budget, 3,000 unverified suppliers; the owner's supplier
-- import will create about 1,800 unverified suppliers in real life).
--
-- 1. authz.sm_manager_cost_rows, authz.sm_manager_bank_rows and
--    authz.sm_manager_supplier_rows (20261130000210) are rewritten set-based
--    with the SAME rows and rules: the per-row definer calls
--    (authz.is_branch_sales_manager, authz.purchase_latest_cost,
--    authz.task_budget / authz.task_current_version,
--    authz.cost_version_approved, authz.can_verify_suppliers) are replaced by
--    their bodies, evaluated once per call (the viewer's Manager branches; the
--    entities where authz.can_verify_suppliers holds) or joined per row.
--    Home counts (supplier_money_home_counts) use the same helpers and get
--    the same speed-up with unchanged numbers.
-- 2. public.manager_approvals() (same signature; body of 20261201000290)
--    returns at most 50 rows per list, in the unchanged order, and the full
--    count of each list in additive keys: costsAboveBudgetTotal,
--    paymentsTotal, fundingTotal, bankDetailsTotal, suppliersToVerifyTotal,
--    cancellationsTotal, flightFaresTotal. The 50 rows are picked first; the
--    per-row JSON helpers (authz.sm_task_title, authz.task_budget,
--    authz.sm_accounts_payment_json, authz.sm_funding_json) run for those rows
--    only. Authorization (Manager gate, branch fences, Purchase-holder
--    exclusion) and every canApprove / canVerify / canDecide self-check are
--    unchanged.
--
-- Rollback (forward-only): a NEW migration restoring the 20261130000210
-- helper bodies and the 20261201000290 body of manager_approvals.

begin;
set local lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Set-based Manager predicates (same signatures, same rows)
-- ---------------------------------------------------------------------------

-- Was: per task authz.is_branch_sales_manager(t.deal_id), purchase_latest_cost,
-- task_budget (twice) and cost_version_approved.
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
  -- authz.task_budget over authz.task_current_version (b11 revision).
  left join lateral (
    select coalesce(f.purchase_budget_paise, v.purchase_budget_paise) as budget
    from public.booking_versions v
    left join public.service_item_facts f on f.service_item_id = t.service_item_id and f.booking_version_id = v.id
    where v.id = coalesce((select v2.id from public.booking_versions v2
                           join public.service_item_facts f2 on f2.booking_version_id = v2.id and f2.service_item_id = t.service_item_id
                           where v2.deal_id = t.deal_id and v2.status = 'confirmed'), t.booking_version_id)) bu on true
  where t.department = 'purchase' and t.status = 'in_progress'
    and exists (select 1 from mb where mb.legal_entity_id = d.legal_entity_id and mb.branch_id = d.branch_id)
    and c.stage = 'proposed'
    and (bu.budget is null or c.amount_paise > bu.budget)
    -- authz.cost_version_approved
    and not exists (select 1 from public.purchase_cost_approvals a where a.task_id = t.id and a.version_no = c.version_no)
$$;

-- Was: authz.can_verify_suppliers(s.legal_entity_id) per supplier.
create or replace function authz.sm_manager_bank_rows()
returns table (supplier_id uuid, revision_no integer, created_by uuid, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.id, r.revision_no, r.created_by, r.created_at
  from public.suppliers s
  cross join lateral (select x.revision_no, x.created_by, x.created_at, x.status
                      from public.supplier_beneficiary_revisions x
                      where x.supplier_id = s.id order by x.revision_no desc limit 1) r
  where r.status = 'unverified'
    and s.legal_entity_id in (select e.id from public.legal_entities e where authz.can_verify_suppliers(e.id))
$$;

create or replace function authz.sm_manager_supplier_rows()
returns table (supplier_id uuid, can_verify boolean)
language sql stable security definer set search_path = '' as $$
  select s.id, s.created_by <> (select auth.uid()) and s.updated_by <> (select auth.uid())
  from public.suppliers s
  where s.verification_status = 'unverified' and s.status = 'active'
    and s.legal_entity_id in (select e.id from public.legal_entities e where authz.can_verify_suppliers(e.id))
$$;

-- ---------------------------------------------------------------------------
-- 2. manager_approvals: 50 rows per list + totals (additive keys)
-- ---------------------------------------------------------------------------

create or replace function public.manager_approvals() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  c_cap constant integer := 50;
  v_costs jsonb; v_costs_n bigint;
  v_payments jsonb; v_payments_n bigint;
  v_funding jsonb; v_funding_n bigint;
  v_bank jsonb; v_bank_n bigint;
  v_suppliers jsonb; v_suppliers_n bigint;
  v_cancel_all jsonb; v_cancel jsonb;
  v_fares jsonb; v_fares_n bigint;
begin
  if not coalesce(authz.session_ok(), false) or not exists (
       select 1 from public.memberships m
       where m.user_id = v_uid and m.status = 'active' and m.role_code = 'manager'
         and authz.holds_active_role('manager', m.legal_entity_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'taskId', r.task_id,
      'dealReference', d.reference,
      'serviceTitle', coalesce(authz.sm_task_title(r.task_id), 'Service'),
      'supplierName', s.name,
      'versionNo', r.version_no,
      'amountPaise', c.amount_paise::text,
      'budgetPaise', coalesce(authz.task_budget(r.task_id), 0)::text,
      'proposedAt', r.since,
      'proposedByName', p.display_name,
      'canApprove', r.created_by <> v_uid) order by r.since, r.task_id), '[]'::jsonb),
    coalesce(max(r.total), 0)
  into v_costs, v_costs_n
  from (select x.*, count(*) over () as total from authz.sm_manager_cost_rows() x
        order by x.since, x.task_id limit c_cap) r
  join public.fulfilment_tasks t on t.id = r.task_id
  join public.deals d on d.id = t.deal_id
  join public.purchase_cost_versions c on c.task_id = r.task_id and c.version_no = r.version_no
  left join public.purchase_quotes q on q.id = c.quote_id
  left join public.suppliers s on s.id = q.supplier_id
  left join public.staff_profiles p on p.user_id = r.created_by;

  select coalesce(jsonb_agg(authz.sm_accounts_payment_json(x.id) order by x.due_key, x.requested_at, x.id), '[]'::jsonb),
         coalesce(max(x.total), 0)
  into v_payments, v_payments_n
  from (select p.id, coalesce(p.due_date, date '2100-12-31') as due_key, p.requested_at, count(*) over () as total
        from public.supplier_payment_requests p
        where p.route = 'manager' and p.status = 'pending' and authz.is_branch_sales_manager(p.deal_id)
          -- Review F5: a manager who also holds Purchase never sees customer money or funding.
          and not authz.holds_role('purchase', p.legal_entity_id)
        order by coalesce(p.due_date, date '2100-12-31'), p.requested_at, p.id
        limit c_cap) x;

  select coalesce(jsonb_agg(authz.sm_funding_json(x.id) order by x.requested_at, x.id), '[]'::jsonb),
         coalesce(max(x.total), 0)
  into v_funding, v_funding_n
  from (select f.id, f.requested_at, count(*) over () as total
        from public.company_funding_requests f
        join public.supplier_payment_requests p on p.id = f.payment_request_id
        where f.route = 'manager' and f.status = 'pending' and p.status not in ('returned', 'cancelled')
          and authz.is_branch_sales_manager(f.deal_id) and not authz.holds_role('purchase', f.legal_entity_id)
        order by f.requested_at, f.id
        limit c_cap) x;

  select coalesce(jsonb_agg(jsonb_build_object(
      'supplierId', s.id,
      'supplierName', s.name,
      -- 20261201000290: so screens can tell flight-only suppliers apart.
      'serviceTypes', to_jsonb(s.service_types),
      'revisionNo', x.revision_no,
      'accountHolder', x.account_holder,
      'bankName', x.bank_name,
      'ifsc', x.ifsc,
      'accountLast4', right(x.account_number, 4),
      'createdAt', x.created_at,
      'createdByName', p.display_name,
      'canApprove', x.created_by <> v_uid) order by x.created_at, s.id), '[]'::jsonb),
    coalesce(max(r.total), 0)
  into v_bank, v_bank_n
  from (select b.*, count(*) over () as total from authz.sm_manager_bank_rows() b
        order by b.created_at, b.supplier_id limit c_cap) r
  join public.suppliers s on s.id = r.supplier_id
  join public.supplier_beneficiary_revisions x on x.supplier_id = r.supplier_id and x.revision_no = r.revision_no
  left join public.staff_profiles p on p.user_id = x.created_by;

  select coalesce(jsonb_agg(jsonb_build_object(
      'supplierId', s.id,
      'name', s.name,
      'city', s.city,
      'serviceTypes', to_jsonb(s.service_types),
      'rowVersion', s.row_version,
      'updatedAt', s.updated_at,
      'canVerify', r.can_verify) order by lower(s.name), s.id), '[]'::jsonb),
    coalesce(max(r.total), 0)
  into v_suppliers, v_suppliers_n
  from (select y.supplier_id, y.can_verify, count(*) over () as total
        from authz.sm_manager_supplier_rows() y
        join public.suppliers z on z.id = y.supplier_id
        order by lower(z.name), z.id limit c_cap) r
  join public.suppliers s on s.id = r.supplier_id;

  -- The helper is shared with Home counts (which count canDecide over the whole list): slice here.
  v_cancel_all := coalesce(authz.sm_manager_cancellations_json(), '[]'::jsonb);
  select coalesce(jsonb_agg(a.e order by a.o), '[]'::jsonb) into v_cancel
  from jsonb_array_elements(v_cancel_all) with ordinality a(e, o)
  where a.o <= c_cap;

  -- Flight build (20261201000220): fares above the Deal's flight budget.
  select coalesce(jsonb_agg(jsonb_build_object(
      'approvalId', a.id,
      'dealId', a.deal_id,
      'dealReference', d.reference,
      'flightTitles', coalesce((
        select jsonb_agg(y.title order by y.item_no, y.id)
        from (select distinct t.id, i.item_no, coalesce(authz.sm_task_title(t.id), 'Flight') as title
              from public.flight_sectors fs
              join public.fulfilment_tasks t on t.id = fs.task_id
              join public.service_items i on i.id = t.service_item_id
              where fs.id::text in (select jsonb_array_elements_text(a.payload -> 'sectorIds'))) y), '[]'::jsonb),
      'supplierName', s.name,
      'batchSupplierCostPaise', a.batch_supplier_cost_paise::text,
      'projectedSupplierCostPaise', a.projected_supplier_cost_paise::text,
      'budgetPaise', a.budget_paise::text,
      'requestedAt', a.requested_at,
      'requestedByName', rp.display_name,
      'rowVersion', a.row_version,
      'canApprove', r.can_approve) order by a.requested_at, a.id), '[]'::jsonb),
    coalesce(max(r.total), 0)
  into v_fares, v_fares_n
  from (select fr.approval_id, fr.can_approve, count(*) over () as total
        from authz.flight_manager_fare_rows() fr
        join public.flight_fare_approvals z on z.id = fr.approval_id
        order by z.requested_at, z.id limit c_cap) r
  join public.flight_fare_approvals a on a.id = r.approval_id
  join public.deals d on d.id = a.deal_id
  left join public.suppliers s on s.id::text = a.payload ->> 'supplierId'
  left join public.staff_profiles rp on rp.user_id = a.requested_by;

  return jsonb_build_object(
    'costsAboveBudget', v_costs,
    'costsAboveBudgetTotal', v_costs_n,
    'payments', v_payments,
    'paymentsTotal', v_payments_n,
    'funding', v_funding,
    'fundingTotal', v_funding_n,
    'bankDetails', v_bank,
    'bankDetailsTotal', v_bank_n,
    'suppliersToVerify', v_suppliers,
    'suppliersToVerifyTotal', v_suppliers_n,
    'cancellations', v_cancel,
    'cancellationsTotal', jsonb_array_length(v_cancel_all),
    'flightFares', v_fares,
    'flightFaresTotal', v_fares_n);
end;
$$;

commit;
