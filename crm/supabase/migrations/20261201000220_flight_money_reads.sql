-- Flight build, Track B (3 of 3): flight money reads, Accounts and Manager
-- lists, Home counts.
-- Contract: flight build contract (frozen 4 Nov 2026) sections 9.3, 9.4;
-- shapes: crm/src/modules/flight/money-contracts.ts and
-- crm/src/modules/supplier-money/contracts.ts.
--
-- New reads (security definer; execute to authenticated only):
--   flight_supplier_list()          Flight: flight suppliers of the entity.
--   flight_fare_preview(uuid,jsonb) the Flight person: live fare totals,
--                                   budget line and the matching approval.
--   flight_money(uuid)              the money of one Deal's flight group, per
--                                   role (money fence, contract 9.3).
--   flight_payment_context(uuid)    the Flight person: one batch's payment
--                                   drawer.
-- Replaced (same signatures; Purchase rows keep every key and value, new
-- keys are added):
--   authz.sm_accounts_payment_json  + department, flightBatchNo; flight rows'
--                                   agreedCostPaise = the batch supplier cost.
--   public.accounts_supplier_documents  + department; flight tasks in
--                                   'missing'.
--   public.manager_approvals        + flightFares.
--   authz.sm_home_counts            + flightFaresToApprove,
--                                   flightPaymentsReturned,
--                                   flightPaymentsMissing; requestsToApprove
--                                   and managerApprovals count flight fares.
--
-- Money fence: Purchase and Visa get null from every flight read; a manager
-- or Accounts person who also holds Purchase gets nothing either. Flight
-- never sees customer money, company funding (amount, reason or a funding
-- hold), selling price, receipts or bank values. Package Deals carry no
-- markup, discount or customer amounts for anyone.
--
-- Rollback (forward-only): a NEW migration restoring the replaced bodies
-- from 20261130000210 and revoking the new reads.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Flight reads
-- ===========================================================================

create function public.flight_supplier_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'supplierId', s.id,
      'name', s.name,
      'city', s.city,
      'status', s.status,
      'bankDetailsApproved', authz.sm_bank_approved(s.id),
      'verification', s.verification_status) order by s.status, lower(s.name), s.id)
    from public.suppliers s
    where s.service_types @> array['flight'] and authz.holds_active_role('flight', s.legal_entity_id)), '[]'::jsonb);
end;
$$;

-- B4: live totals for the Confirm tickets popup. No write, no lock.
create function public.flight_fare_preview(p_deal_id uuid, p_fields jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_check jsonb;
  v_approval public.flight_fare_approvals%rowtype;
begin
  if not coalesce(authz.session_ok(), false) or p_deal_id is null or not coalesce(authz.flight_can_work(p_deal_id), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_check := authz.flight_fare_check(p_deal_id, p_fields, 'preview');
  -- The approval of exactly these fares on exactly the current other batches.
  select * into v_approval from public.flight_fare_approvals a
  where a.deal_id = p_deal_id and a.fare_hash = v_check ->> 'fareHash'
    and a.status in ('pending', 'approved', 'returned')
    and a.projected_supplier_cost_paise - a.batch_supplier_cost_paise = (v_check ->> 'dealCostBefore')::bigint
  order by a.approval_no desc limit 1;
  return jsonb_build_object(
    'fareHash', v_check ->> 'fareHash',
    'batchSupplierCostPaise', v_check ->> 'batchSupplierCost',
    'batchCustomerTotalPaise', v_check ->> 'batchCustomerTotal',
    'dealSupplierCostAfterPaise', v_check ->> 'dealCostAfter',
    'dealBudgetPaise', v_check ->> 'dealBudget',
    'overBudget', (v_check ->> 'overBudget')::boolean,
    'approval', case when v_approval.id is null then null
                     else jsonb_build_object('approvalId', v_approval.id, 'status', v_approval.status) end,
    'costTaskId', v_check ->> 'costTaskId');
end;
$$;

-- Contract 9.3. Roles: F (Flight role in the entity), FA (the Deal's Flight
-- person), M (branch Manager), A (Accounts through the finance gate), SO
-- (the Sales owner, reduced). Everyone else (Purchase, Visa, other Sales):
-- null. Never a partial object for a refused caller.
create function public.flight_money(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_deal public.deals%rowtype;
  v_f boolean;
  v_fa boolean;
  v_m boolean;
  v_a boolean;
  v_so boolean;
  v_full boolean;
  v_kind text;
  v_fo boolean;
  v_budget bigint;
  v_cost bigint;
  v_cancelled boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null or not exists (select 1 from public.fulfilment_tasks t where t.deal_id = v_deal.id and t.department = 'flight') then
    return null;
  end if;
  v_f := authz.holds_active_role('flight', v_deal.legal_entity_id);
  v_fa := v_f and exists (select 1 from public.fulfilment_tasks t
                          where t.deal_id = v_deal.id and t.department = 'flight'
                            and t.status in ('in_progress', 'completed') and t.assignee_user_id = v_uid);
  v_m := authz.is_branch_sales_manager(v_deal.id) and not authz.holds_role('purchase', v_deal.legal_entity_id);
  v_a := authz.can_accounts(v_deal.legal_entity_id) and not authz.holds_role('purchase', v_deal.legal_entity_id)
         and authz.finance_gate_issue(v_deal.legal_entity_id, v_deal.is_synthetic) is null;
  v_so := authz.flight_is_sales_owner(v_deal.id) and not authz.holds_role('purchase', v_deal.legal_entity_id)
          and not authz.holds_role('visa', v_deal.legal_entity_id);
  v_full := v_f or v_m or v_a;
  if not (v_full or v_so) then
    return null;
  end if;

  v_kind := authz.flight_deal_kind(v_deal.id);
  v_fo := v_kind = 'flight_only';
  v_budget := authz.flight_deal_budget(v_deal.id);
  v_cost := authz.flight_deal_supplier_cost(v_deal.id);
  v_cancelled := authz.deal_trip_cancelled(v_deal.id);

  -- Keys a role may not see are absent (contract 9.3 table), not null.
  return jsonb_build_object(
    'dealKind', v_kind,
    'budget', jsonb_build_object(
      'dealPaise', v_budget::text,
      'tasks', coalesce((
        select jsonb_agg(jsonb_build_object('taskId', t.id, 'budgetPaise', b.budget_paise::text, 'source', coalesce(b.source, 'none'))
                         order by i.item_no, t.id)
        from public.fulfilment_tasks t
        join public.service_items i on i.id = t.service_item_id
        left join lateral (select x.budget_paise, x.source from authz.flight_task_budget(t.id) x limit 1) b on true
        where t.deal_id = v_deal.id and t.department = 'flight'), '[]'::jsonb)),
    'supplierCostPaise', v_cost::text,
    'overBudget', v_cost > 0 and (v_budget is null or v_cost > v_budget),
    'batches', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'batchId', b.id,
          'batchNo', b.batch_no,
          'costTaskId', b.cost_task_id,
          'supplierId', b.supplier_id,
          'supplierName', s.name,
          'sectorIds', to_jsonb(b.sector_ids),
          'confirmedAt', b.confirmed_at,
          'confirmedByName', cp.display_name,
          -- Flight never gets a company funding signal (as Purchase, review F1).
          'payment', case when v_full then jsonb_build_object(
              'state', x.state,
              'route', x.route,
              'refNo', x.ref_no,
              'returnReason', x.return_reason,
              'onHold', case when v_m or v_a then x.on_hold else coalesce(x.hold_reason = 'bank_details_on_hold', false) end,
              'holdReason', case when v_m or v_a then x.hold_reason
                                 when x.hold_reason = 'bank_details_on_hold' then x.hold_reason end)
            || case when v_fa then jsonb_build_object(
              'entryId', x.entry_id,
              'entryRowVersion', x.entry_row_version,
              'paymentId', x.payment_id,
              'paymentRowVersion', x.payment_row_version) else '{}'::jsonb end
            else jsonb_build_object('state', x.state) end)
        -- Fares and supplier amounts: F, M, A; the Sales owner on flight-only Deals.
        || case when v_full or b.deal_kind = 'flight_only' then jsonb_build_object(
          'fares', coalesce((
            select jsonb_agg(jsonb_build_object(
                'paxType', f.pax_type,
                'basicPaise', f.basic_paise::text,
                'kPaise', f.k_paise::text,
                'yqPaise', f.yq_paise::text,
                'yrPaise', f.yr_paise::text,
                'otherPaise', f.other_paise::text,
                'supplierPerPersonPaise', f.supplier_per_person_paise::text,
                'paxCount', f.pax_count,
                'supplierAmountPaise', (f.supplier_per_person_paise * f.pax_count)::text)
              || case when b.deal_kind = 'flight_only' then jsonb_build_object(
                'markupPaise', f.markup_paise::text,
                'discountPaise', f.discount_paise::text,
                'totalPerPersonPaise', f.total_per_person_paise::text,
                'customerAmountPaise', (f.total_per_person_paise * f.pax_count)::text) else '{}'::jsonb end
              order by case f.pax_type when 'adult' then 1 when 'child' then 2 else 3 end)
            from public.flight_batch_fares f where f.batch_id = b.id), '[]'::jsonb),
          'supplierCostPaise', b.supplier_cost_paise::text) else '{}'::jsonb end
        || case when b.deal_kind = 'flight_only' then jsonb_build_object('customerTotalPaise', b.customer_total_paise::text)
                else '{}'::jsonb end
        || case when v_full then jsonb_build_object(
          'routePreview', case when rt.total + b.supplier_cost_paise <= 5000000 then 'direct' else 'manager' end)
                else '{}'::jsonb end
        -- Actions: the Flight person only.
        || case when v_fa then jsonb_build_object(
          'canPayDirect', authz.flight_owns_task(b.cost_task_id) and not v_cancelled and b.supplier_cost_paise > 0
                          and x.state in ('unpaid', 'direct_returned', 'request_returned', 'request_cancelled')
                          and rt.total + b.supplier_cost_paise <= 5000000,
          'canRequest', authz.flight_owns_task(b.cost_task_id) and not v_cancelled and b.supplier_cost_paise > 0
                        and x.state in ('unpaid', 'direct_returned', 'request_returned', 'request_cancelled'))
                else '{}'::jsonb end
        order by b.batch_no)
      from public.flight_ticket_batches b
      join public.suppliers s on s.id = b.supplier_id
      left join public.staff_profiles cp on cp.user_id = b.confirmed_by
      cross join lateral authz.flight_batch_payment(b.id) x
      cross join lateral (select authz.sm_supplier_running_total(b.deal_id, b.supplier_id) as total) rt
      where b.deal_id = v_deal.id), '[]'::jsonb))
  -- Customer total: flight-only Deals only (absent on package Deals).
  || case when v_fo then jsonb_build_object('customerTotalPaise', (
       select coalesce(sum(b.customer_total_paise), 0)::text from public.flight_ticket_batches b where b.deal_id = v_deal.id))
     else '{}'::jsonb end
  -- Supplier totals, approvals and invoices: F, M, A only.
  || case when v_full then jsonb_build_object(
    'supplierTotals', coalesce((
      select jsonb_agg(jsonb_build_object('supplierId', y.supplier_id, 'supplierName', y.name,
               'runningTotalPaise', authz.sm_supplier_running_total(v_deal.id, y.supplier_id)::text) order by lower(y.name), y.supplier_id)
      from (select distinct b.supplier_id, s.name from public.flight_ticket_batches b
            join public.suppliers s on s.id = b.supplier_id where b.deal_id = v_deal.id) y), '[]'::jsonb),
    'approvals', coalesce((
      select jsonb_agg(jsonb_build_object(
        'approvalId', a.id,
        'approvalNo', a.approval_no,
        'status', a.status,
        'batchSupplierCostPaise', a.batch_supplier_cost_paise::text,
        'projectedSupplierCostPaise', a.projected_supplier_cost_paise::text,
        'budgetPaise', a.budget_paise::text,
        'requestedAt', a.requested_at,
        'requestedByName', rp.display_name,
        'decidedAt', a.decided_at,
        'decidedByName', dp.display_name,
        'returnReason', a.return_reason,
        'rowVersion', a.row_version,
        'canDecide', v_m and a.status = 'pending' and a.requested_by <> v_uid and not authz.flight_is_deal_assignee(v_deal.id),
        'canWithdraw', v_fa and a.status = 'pending' and a.requested_by = v_uid) order by a.approval_no desc)
      from public.flight_fare_approvals a
      left join public.staff_profiles rp on rp.user_id = a.requested_by
      left join public.staff_profiles dp on dp.user_id = a.decided_by
      where a.deal_id = v_deal.id), '[]'::jsonb),
    'invoices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'documentId', x.id, 'supplierId', x.supplier_id, 'number', x.number, 'docDate', to_char(x.doc_date, 'YYYY-MM-DD'),
        'totalPaise', x.total_paise::text, 'status', x.status) order by x.uploaded_at, x.id)
      from public.supplier_documents x
      join public.fulfilment_tasks t on t.id = x.task_id
      where t.deal_id = v_deal.id and t.department = 'flight' and x.kind = 'invoice'), '[]'::jsonb),
    'invoiceMissing', coalesce((
      select bool_or(authz.sm_invoice_missing(t.id)) from public.fulfilment_tasks t
      where t.deal_id = v_deal.id and t.department = 'flight'), false)) else '{}'::jsonb end;
end;
$$;

-- 9.4: the payment drawer of one batch, for the Flight person of its cost task.
create function public.flight_payment_context(p_batch_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_batch public.flight_ticket_batches%rowtype;
  v_state text;
  v_running bigint;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_batch from public.flight_ticket_batches b where b.id = p_batch_id;
  if v_batch.id is null or not authz.flight_owns_task(v_batch.cost_task_id) then
    return null;
  end if;
  select x.state into v_state from authz.flight_batch_payment(v_batch.id) x;
  v_running := authz.sm_supplier_running_total(v_batch.deal_id, v_batch.supplier_id);
  return jsonb_build_object(
    'batchId', v_batch.id,
    'batchNo', v_batch.batch_no,
    'costTaskId', v_batch.cost_task_id,
    'amountPaise', v_batch.supplier_cost_paise::text,
    'supplierId', v_batch.supplier_id,
    'supplierName', (select s.name from public.suppliers s where s.id = v_batch.supplier_id),
    'runningTotalPaise', v_running::text,
    'routePreview', case when v_running + v_batch.supplier_cost_paise <= 5000000 then 'direct' else 'manager' end,
    'directAllowed', v_batch.supplier_cost_paise > 0 and not authz.deal_trip_cancelled(v_batch.deal_id)
                     and v_state in ('unpaid', 'direct_returned', 'request_returned', 'request_cancelled')
                     and v_running + v_batch.supplier_cost_paise <= 5000000,
    'directLimitPaise', '5000000',
    'proofs', coalesce((
      select jsonb_agg(jsonb_build_object('evidenceId', e.id, 'fileName', e.file_name) order by e.created_at, e.id)
      from public.department_evidence e
      where e.task_id = v_batch.cost_task_id and e.kind = 'direct_payment_proof' and e.status = 'stored'), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- 2. Accounts and Manager rows (replaced; Purchase rows keep their keys)
-- ===========================================================================

-- Replaces 20261130000210: + department, flightBatchNo; flight rows'
-- agreedCostPaise is the batch supplier cost.
create or replace function authz.sm_accounts_payment_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id,
    'refNo', p.ref_no,
    'dealId', p.deal_id,
    'dealReference', d.reference,
    'branchName', b.name,
    'taskId', p.task_id,
    'serviceTitle', coalesce(authz.sm_task_title(p.task_id), 'Service'),
    'serviceType', coalesce(authz.sm_task_type(p.task_id), 'hotel'),
    'supplierId', p.supplier_id,
    'supplierName', s.name,
    'part', p.part,
    'amountPaise', p.amount_paise::text,
    'customerMoneyPaise', p.customer_money_paise::text,
    'dueDate', to_char(p.due_date, 'YYYY-MM-DD'),
    'note', p.note,
    'route', p.route,
    'status', p.status,
    'costVersionNo', p.cost_version_no,
    'agreedCostPaise', case when p.flight_batch_id is not null then fb.supplier_cost_paise::text
                            else (select c.amount_paise::text from public.purchase_cost_versions c
                                  where c.task_id = p.task_id and c.version_no = p.cost_version_no) end,
    'proformaEvidenceId', p.proforma_evidence_id,
    'returnReason', p.return_reason,
    'requestedAt', p.requested_at,
    'requestedByName', rp.display_name,
    'decidedAt', p.decided_at,
    'decidedByName', dp.display_name
  ) || jsonb_build_object(
    'paidOn', to_char(p.paid_on, 'YYYY-MM-DD'),
    'paymentMode', p.payment_mode,
    'bankReference', p.bank_reference,
    'paymentProofEvidenceId', p.payment_proof_evidence_id,
    'bankRevisionNo', p.bank_revision_no,
    'recordedAt', p.recorded_at,
    'recordedByName', cp.display_name,
    'verifiedAt', p.verified_at,
    'verifiedByName', vp.display_name,
    'bankDetails', authz.sm_bank_json(p.supplier_id),
    'funding', case when f.id is null then null else jsonb_build_object(
      'id', f.id, 'amountPaise', f.amount_paise::text, 'reason', f.reason, 'route', f.route, 'status', f.status) end,
    'onHold', h.reason is not null,
    'holdReason', h.reason,
    'rowVersion', p.row_version,
    'canDecide', p.status = 'pending' and p.requested_by <> (select auth.uid())
                 and authz.sm_can_decide_route(p.route, p.legal_entity_id, p.deal_id, d.is_synthetic)
                 -- Flight build: never the Deal's Flight person for a flight payment.
                 and not (p.flight_batch_id is not null and authz.flight_is_deal_assignee(p.deal_id)),
    'canRecord', p.status = 'approved' and h.reason is null and authz.sm_accounts_sees(p.legal_entity_id, d.is_synthetic),
    'canVerify', p.status = 'paid' and p.recorded_by <> (select auth.uid())
                 and authz.sm_accounts_sees(p.legal_entity_id, d.is_synthetic),
    -- Flight build (20261201000220).
    'department', case when t.department = 'flight' then 'flight' else 'purchase' end,
    'flightBatchNo', fb.batch_no)
  from public.supplier_payment_requests p
  join public.deals d on d.id = p.deal_id
  join public.branches b on b.id = p.branch_id
  join public.suppliers s on s.id = p.supplier_id
  join public.fulfilment_tasks t on t.id = p.task_id
  left join public.flight_ticket_batches fb on fb.id = p.flight_batch_id
  left join public.company_funding_requests f on f.payment_request_id = p.id
  left join public.staff_profiles rp on rp.user_id = p.requested_by
  left join public.staff_profiles dp on dp.user_id = p.decided_by
  left join public.staff_profiles cp on cp.user_id = p.recorded_by
  left join public.staff_profiles vp on vp.user_id = p.verified_by
  cross join lateral (select authz.sm_hold_reason(p.id) as reason) h
  where p.id = p_id
$$;
revoke all on function authz.sm_accounts_payment_json(uuid) from public, anon, authenticated;

-- Replaces 20261130000210: rows gain department; 'missing' includes flight
-- tasks (done, with a batch, last flight departed, no invoice).
create or replace function public.accounts_supplier_documents(p_tab text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  perform authz.finance_require_accounts_anywhere();
  if p_tab is null or p_tab not in ('to_review', 'missing', 'all') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'documents', case when p_tab = 'missing' then '[]'::jsonb else coalesce((
      select jsonb_agg(authz.sm_document_json(x.id) || jsonb_build_object(
               'branchName', x.branch_name,
               'canReview', x.status = 'uploaded' and x.uploaded_by <> v_uid,
               'department', x.department) order by x.ord)
      from (
        select s.id, s.status, s.uploaded_by, b.name as branch_name,
          case when t.department = 'flight' then 'flight' else 'purchase' end as department,
          row_number() over (order by s.uploaded_at desc, s.id) as ord
        from public.supplier_documents s
        join public.deals d on d.id = s.deal_id
        join public.branches b on b.id = s.branch_id
        join public.fulfilment_tasks t on t.id = s.task_id
        where authz.sm_accounts_sees(s.legal_entity_id, d.is_synthetic)
          and (p_tab = 'all' or s.status = 'uploaded')
        order by s.uploaded_at desc, s.id
        limit 500
      ) x), '[]'::jsonb) end,
    'missingInvoices', case when p_tab = 'to_review' then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
               'taskId', y.id,
               'dealReference', y.reference,
               'serviceTitle', coalesce(authz.sm_task_title(y.id), 'Service'),
               'supplierId', y.supplier_id,
               'supplierName', y.supplier_name,
               'tripEnd', to_char(y.trip_end, 'YYYY-MM-DD'),
               'assigneeName', y.assignee_name,
               'department', y.department) order by y.trip_end, y.id)
      from (
        (select t.id, d.reference, q.supplier_id, s.name as supplier_name, authz.sm_trip_end(t.id) as trip_end,
          ap.display_name as assignee_name, 'purchase'::text as department
        from public.fulfilment_tasks t
        join public.deals d on d.id = t.deal_id
        left join public.purchase_quotes q on q.id = t.selected_quote_id
        left join public.suppliers s on s.id = q.supplier_id
        left join public.staff_profiles ap on ap.user_id = t.assignee_user_id
        where t.department = 'purchase' and t.status in ('supplier_confirmed', 'completed')
          and authz.sm_accounts_sees(t.legal_entity_id, d.is_synthetic)
          and authz.sm_invoice_missing(t.id)
        limit 500)
        union all
        (select t.id, d.reference, fb.supplier_id, s.name, authz.sm_trip_end(t.id),
          ap.display_name, 'flight'::text
        from public.fulfilment_tasks t
        join public.deals d on d.id = t.deal_id
        left join lateral (select b.supplier_id from public.flight_ticket_batches b
                           where b.cost_task_id = t.id order by b.batch_no limit 1) fb on true
        left join public.suppliers s on s.id = fb.supplier_id
        left join public.staff_profiles ap on ap.user_id = t.assignee_user_id
        where t.department = 'flight' and t.status = 'completed'
          and authz.sm_accounts_sees(t.legal_entity_id, d.is_synthetic)
          and authz.sm_invoice_missing(t.id)
        limit 500)
      ) y), '[]'::jsonb) end);
end;
$$;

-- Flight fares above budget the caller (branch Manager) may see.
create function authz.flight_manager_fare_rows()
returns table (approval_id uuid, can_approve boolean)
language sql stable security definer set search_path = '' as $$
  select a.id, a.requested_by <> (select auth.uid()) and not authz.flight_is_deal_assignee(a.deal_id)
  from public.flight_fare_approvals a
  where a.status = 'pending' and authz.is_branch_sales_manager(a.deal_id)
    and not authz.holds_role('purchase', a.legal_entity_id)
$$;
revoke all on function authz.flight_manager_fare_rows() from public, anon, authenticated, service_role;

-- Replaces 20261130000210: + flightFares. Everything else unchanged.
create or replace function public.manager_approvals() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if not coalesce(authz.session_ok(), false) or not exists (
       select 1 from public.memberships m
       where m.user_id = v_uid and m.status = 'active' and m.role_code = 'manager'
         and authz.holds_active_role('manager', m.legal_entity_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'costsAboveBudget', coalesce((
      select jsonb_agg(jsonb_build_object(
        'taskId', r.task_id,
        'dealReference', d.reference,
        'serviceTitle', coalesce(authz.sm_task_title(r.task_id), 'Service'),
        'supplierName', s.name,
        'versionNo', r.version_no,
        'amountPaise', c.amount_paise::text,
        'budgetPaise', coalesce(authz.task_budget(r.task_id), 0)::text,
        'proposedAt', r.since,
        'proposedByName', p.display_name,
        'canApprove', r.created_by <> v_uid) order by r.since, r.task_id)
      from authz.sm_manager_cost_rows() r
      join public.fulfilment_tasks t on t.id = r.task_id
      join public.deals d on d.id = t.deal_id
      join public.purchase_cost_versions c on c.task_id = r.task_id and c.version_no = r.version_no
      left join public.purchase_quotes q on q.id = c.quote_id
      left join public.suppliers s on s.id = q.supplier_id
      left join public.staff_profiles p on p.user_id = r.created_by), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(authz.sm_accounts_payment_json(p.id) order by coalesce(p.due_date, date '2100-12-31'), p.requested_at, p.id)
      from public.supplier_payment_requests p
      where p.route = 'manager' and p.status = 'pending' and authz.is_branch_sales_manager(p.deal_id)
        -- Review F5: a manager who also holds Purchase never sees customer money or funding.
        and not authz.holds_role('purchase', p.legal_entity_id)), '[]'::jsonb),
    'funding', coalesce((
      select jsonb_agg(authz.sm_funding_json(f.id) order by f.requested_at, f.id)
      from public.company_funding_requests f
      join public.supplier_payment_requests p on p.id = f.payment_request_id
      where f.route = 'manager' and f.status = 'pending' and p.status not in ('returned', 'cancelled')
        and authz.is_branch_sales_manager(f.deal_id) and not authz.holds_role('purchase', f.legal_entity_id)), '[]'::jsonb),
    'bankDetails', coalesce((
      select jsonb_agg(jsonb_build_object(
        'supplierId', s.id,
        'supplierName', s.name,
        'revisionNo', x.revision_no,
        'accountHolder', x.account_holder,
        'bankName', x.bank_name,
        'ifsc', x.ifsc,
        'accountLast4', right(x.account_number, 4),
        'createdAt', x.created_at,
        'createdByName', p.display_name,
        'canApprove', x.created_by <> v_uid) order by x.created_at, s.id)
      from authz.sm_manager_bank_rows() r
      join public.suppliers s on s.id = r.supplier_id
      join public.supplier_beneficiary_revisions x on x.supplier_id = r.supplier_id and x.revision_no = r.revision_no
      left join public.staff_profiles p on p.user_id = x.created_by), '[]'::jsonb),
    'suppliersToVerify', coalesce((
      select jsonb_agg(jsonb_build_object(
        'supplierId', s.id,
        'name', s.name,
        'city', s.city,
        'serviceTypes', to_jsonb(s.service_types),
        'rowVersion', s.row_version,
        'updatedAt', s.updated_at,
        'canVerify', r.can_verify) order by lower(s.name), s.id)
      from authz.sm_manager_supplier_rows() r
      join public.suppliers s on s.id = r.supplier_id), '[]'::jsonb),
    'cancellations', authz.sm_manager_cancellations_json(),
    -- Flight build (20261201000220): fares above the Deal's flight budget.
    'flightFares', coalesce((
      select jsonb_agg(jsonb_build_object(
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
        'canApprove', r.can_approve) order by a.requested_at, a.id)
      from authz.flight_manager_fare_rows() r
      join public.flight_fare_approvals a on a.id = r.approval_id
      join public.deals d on d.id = a.deal_id
      left join public.suppliers s on s.id::text = a.payload ->> 'supplierId'
      left join public.staff_profiles rp on rp.user_id = a.requested_by), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- 3. Home counts (replaced; Purchase and Accounts keys unchanged)
-- ===========================================================================

create or replace function authz.sm_home_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_manager boolean;
  v_purchase boolean;
  v_accounts boolean;
  v_flight boolean;
  v_requests integer;
  v_p_not_taken integer;
  v_p_go_ahead integer;
  v_p_costs integer;
  v_p_returned integer;
  v_p_invoices integer;
  v_a_go_ahead integer;
  v_a_approve integer;
  v_a_record integer;
  v_a_verify integer;
  v_a_documents integer;
  v_a_funding integer;
  v_a_recover integer;
  v_m_approvals integer;
  -- Flight build (20261201000220)
  v_m_fares integer;
  v_f_returned integer;
  v_f_missing integer;
begin
  select
    bool_or(m.role_code = 'manager' and authz.holds_active_role('manager', m.legal_entity_id)),
    bool_or(m.role_code = 'purchase' and authz.holds_active_role('purchase', m.legal_entity_id)),
    bool_or(m.role_code = 'accounts' and authz.holds_active_role('accounts', m.legal_entity_id)
            and not authz.holds_role('purchase', m.legal_entity_id)),
    bool_or(m.role_code = 'flight' and authz.holds_active_role('flight', m.legal_entity_id))
  into v_manager, v_purchase, v_accounts, v_flight
  from public.memberships m where m.user_id = v_uid and m.status = 'active';

  -- Purchase: own tasks and own requests.
  if coalesce(v_purchase, false) then
    select count(*) into v_p_not_taken from public.fulfilment_tasks t
    where t.department = 'purchase' and t.status = 'not_started' and authz.can_read_purchase_task(t.id);
    select count(*) filter (where authz.purchase_go_ahead_state(t.id) = 'pending'),
           count(*) filter (where c.id is not null and c.stage = 'proposed'
                              and (authz.task_budget(t.id) is null or c.amount_paise > authz.task_budget(t.id))
                              and not authz.cost_version_approved(t.id, c.version_no))
    into v_p_go_ahead, v_p_costs
    from public.fulfilment_tasks t
    left join lateral (select * from authz.purchase_latest_cost(t.id)) c on true
    where t.department = 'purchase' and t.status = 'in_progress' and t.assignee_user_id = v_uid;
    select count(*) into v_p_returned
    from public.supplier_payment_requests p
    where p.requested_by = v_uid and p.status = 'returned'
      and authz.holds_active_role('purchase', p.legal_entity_id)
      and not exists (select 1 from public.supplier_payment_requests n where n.resubmits_id = p.id);
    select count(*) into v_p_invoices
    from public.fulfilment_tasks t
    where t.department = 'purchase' and t.status in ('supplier_confirmed', 'completed') and t.assignee_user_id = v_uid
      and authz.holds_active_role('purchase', t.legal_entity_id)
      and authz.sm_invoice_missing(t.id);
  end if;

  -- Accounts: the rows of accounts_go_ahead_list / accounts_supplier_payments /
  -- accounts_supplier_documents / accounts_company_funding, over the finance
  -- gate (entity x synthetic flag).
  if coalesce(v_accounts, false) then
    with gate as materialized (
      select e.id as legal_entity_id, s.is_synthetic
      from public.legal_entities e
      cross join (values (true), (false)) as s(is_synthetic)
      where authz.can_accounts(e.id)
        and authz.finance_gate_issue(e.id, s.is_synthetic) is null
    )
    select
      (select count(*)
       from public.purchase_go_ahead_requests r
       join public.deals d on d.id = r.deal_id
       join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
       where r.status = 'pending' and r.requested_by <> v_uid),
      (select count(*)
       from public.supplier_payment_requests p
       join public.deals d on d.id = p.deal_id
       join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
       where p.status = 'pending' and p.route = 'accounts' and p.requested_by <> v_uid
         and not authz.finance_deal_conflict(p.deal_id)),
      (select count(*)
       from public.supplier_payment_requests p
       join public.deals d on d.id = p.deal_id
       join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
       where p.status = 'approved'),
      (select count(*)
       from public.supplier_payment_requests p
       join public.deals d on d.id = p.deal_id
       join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
       where p.status = 'paid' and p.recorded_by <> v_uid),
      (select count(*)
       from public.supplier_documents s
       join public.deals d on d.id = s.deal_id
       join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
       where s.status = 'uploaded' and s.uploaded_by <> v_uid),
      (select count(*)
       from public.company_funding_requests f
       join public.supplier_payment_requests p on p.id = f.payment_request_id
       join public.deals d on d.id = f.deal_id
       join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
       where f.status = 'pending' and f.route = 'accounts' and f.requested_by <> v_uid
         and p.status not in ('returned', 'cancelled') and not authz.finance_deal_conflict(f.deal_id)),
      (select count(*)
       from public.company_funding_requests f
       join public.deals d on d.id = f.deal_id
       join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
       where f.status = 'approved')
    into v_a_go_ahead, v_a_approve, v_a_record, v_a_verify, v_a_documents, v_a_funding, v_a_recover;
    v_requests := v_a_go_ahead + v_a_approve + v_a_funding;
  end if;

  -- Manager: exactly the actionable rows of manager_approvals().
  if coalesce(v_manager, false) then
    select count(*) into v_m_fares from authz.flight_manager_fare_rows() r where r.can_approve;
    select
      (select count(*) from authz.sm_manager_cost_rows() r where r.created_by <> v_uid)
      + (select count(*) from public.supplier_payment_requests p
         where p.route = 'manager' and p.status = 'pending' and p.requested_by <> v_uid
           and authz.is_branch_sales_manager(p.deal_id) and not authz.holds_role('purchase', p.legal_entity_id)
           and not authz.finance_deal_conflict(p.deal_id)
           and not (p.flight_batch_id is not null and authz.flight_is_deal_assignee(p.deal_id)))
      + (select count(*) from public.company_funding_requests f
         join public.supplier_payment_requests p on p.id = f.payment_request_id
         where f.route = 'manager' and f.status = 'pending' and f.requested_by <> v_uid
           and p.status not in ('returned', 'cancelled') and authz.is_branch_sales_manager(f.deal_id)
           and not authz.holds_role('purchase', f.legal_entity_id) and not authz.finance_deal_conflict(f.deal_id))
      + (select count(*) from authz.sm_manager_bank_rows() r where r.created_by <> v_uid)
      + (select count(*) from authz.sm_manager_supplier_rows() r where r.can_verify)
      + (select count(*) from jsonb_array_elements(authz.sm_manager_cancellations_json()) c
         where (c ->> 'canDecide')::boolean)
      + v_m_fares
    into v_m_approvals;
    v_requests := coalesce(v_requests, 0) + v_m_approvals;
  end if;

  -- Flight: batches of the caller's own flight tasks (nothing to pay = paid).
  -- A request still waiting for approval needs nothing from Flight: not counted.
  if coalesce(v_flight, false) then
    select count(*) filter (where x.state in ('direct_returned', 'request_returned')),
           count(*) filter (where x.state in ('unpaid', 'request_cancelled'))
    into v_f_returned, v_f_missing
    from public.flight_ticket_batches b
    join public.fulfilment_tasks t on t.id = b.cost_task_id
    cross join lateral authz.flight_batch_payment(b.id) x
    where t.assignee_user_id = v_uid and t.status in ('in_progress', 'completed')
      and authz.holds_active_role('flight', t.legal_entity_id)
      and b.supplier_cost_paise > 0 and not x.paid;
  end if;

  return jsonb_build_object(
    'requestsToApprove', v_requests,
    'purchaseTasksNotTaken', v_p_not_taken,
    'purchaseWaitingForGoAhead', v_p_go_ahead,
    'purchaseCostsWaitingForManager', v_p_costs,
    'paymentRequestsReturned', v_p_returned,
    'supplierInvoicesMissing', v_p_invoices,
    'goAheadToApprove', v_a_go_ahead,
    'supplierPaymentsToApprove', v_a_approve,
    'supplierPaymentsToRecord', v_a_record,
    'supplierPaymentsToVerify', v_a_verify,
    'supplierDocumentsToReview', v_a_documents,
    'fundingToApprove', v_a_funding,
    'fundingToRecover', v_a_recover,
    'managerApprovals', v_m_approvals,
    'flightFaresToApprove', v_m_fares,
    'flightPaymentsReturned', v_f_returned,
    'flightPaymentsMissing', v_f_missing);
end;
$$;
revoke all on function authz.sm_home_counts() from public, anon, authenticated;

-- ===========================================================================
-- 4. Grants (new reads only)
-- ===========================================================================

revoke all on function
  public.flight_supplier_list(),
  public.flight_fare_preview(uuid, jsonb),
  public.flight_money(uuid),
  public.flight_payment_context(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.flight_supplier_list(),
  public.flight_fare_preview(uuid, jsonb),
  public.flight_money(uuid),
  public.flight_payment_context(uuid)
to authenticated;

commit;
