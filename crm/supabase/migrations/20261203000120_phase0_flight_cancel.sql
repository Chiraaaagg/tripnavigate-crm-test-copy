-- TripNavigate CRM - Accounts phase, Phase 0 item 3 (track A): a pending
-- Flight supplier payment request can be cancelled by its requester or by the
-- current owner of the batch's cost task.
--
-- Frozen contract: docs/implementation/accounts-phase-2026-11-10/contract.md
-- sections 1.1 (item 3), 5.3 and 5.4; owner answer H9; lead decision AL4
-- (Purchase requests stay requester-only). Every replaced function keeps its
-- signature and starts from its latest body; changed lines are marked
-- "Accounts phase (20261203000120)".
--
-- What changes:
--   1. authz.sm_payment_for_command (replaces 20261201000210): new actor
--      'canceller'. Flight request (flight_batch_id set): the requester holding
--      an active Flight role, or authz.flight_owns_task of the batch's cost
--      task (current assignee, active Flight role, task in progress or
--      completed). Purchase request: exactly the 'requester' rule. Other
--      actors unchanged; still finance_lock_deal, then the row FOR UPDATE.
--   2. public.supplier_payment_request_cancel (replaces 20261201000210): uses
--      'canceller'; already_decided and version_changed checks unchanged; the
--      flight.payment_cancelled audit details gain byTaskOwner (true when the
--      caller is not the requester).
--   3. public.flight_money (replaces 20261201000270): the batch payment object
--      of the Flight assignee view gains canCancel (request pending and the
--      caller is its requester or the cost task's current owner).
--
-- Refusal tokens: unchanged (42501 not_authorized for anyone else; 55000
-- already_decided; 40001 version_changed).
-- Data: none changed. No new table, grant or switch.
-- Rollback (forward-only): a NEW migration restoring the previous bodies
-- (20261201000210 for both functions, 20261201000270).

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Payment row for a command (replaces 20261201000210; lines marked Accounts phase)
-- ===========================================================================

create or replace function authz.sm_payment_for_command(p_payment uuid, p_actor text) returns public.supplier_payment_requests
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.supplier_payment_requests%rowtype;
  v_synthetic boolean;
  v_department text;
begin
  select * into v from public.supplier_payment_requests p where p.id = p_payment;
  if v.id is null then
    if coalesce(authz.session_ok(), false) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = v.deal_id;
  if p_actor = 'decider' then
    perform authz.sm_require_decider(v.route, v.legal_entity_id, v.deal_id, v_synthetic);
  elsif p_actor = 'accounts' then
    perform authz.finance_require_accounts(v.legal_entity_id, v_synthetic);
  -- Accounts phase (20261203000120): 'canceller' on a Purchase request is the requester (AL4).
  elsif p_actor = 'requester' or (p_actor = 'canceller' and v.flight_batch_id is null) then
    select coalesce(t.department, 'purchase') into v_department from public.fulfilment_tasks t where t.id = v.task_id;
    if not coalesce(authz.session_ok(), false) or v.requested_by is distinct from (select auth.uid())
       or not authz.holds_active_role(coalesce(v_department, 'purchase'), v.legal_entity_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
  -- Accounts phase (20261203000120): a Flight request is cancelled by its
  -- requester (holding Flight) or the current owner of the batch's cost task (H9).
  elsif p_actor = 'canceller' then
    if not coalesce(authz.session_ok(), false) or not coalesce(
         (v.requested_by = (select auth.uid()) and authz.holds_active_role('flight', v.legal_entity_id))
         or authz.flight_owns_task((select b.cost_task_id from public.flight_ticket_batches b
                                    where b.id = v.flight_batch_id)), false) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
  else
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.finance_lock_deal(v.deal_id);
  select * into v from public.supplier_payment_requests p where p.id = p_payment for update;
  return v;
end;
$$;

-- ===========================================================================
-- 2. Cancel a payment request (replaces 20261201000210; lines marked Accounts phase)
-- ===========================================================================

create or replace function public.supplier_payment_request_cancel(p_payment_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.supplier_payment_requests%rowtype;
  v_payload jsonb := jsonb_build_object('paymentId', p_payment_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  -- Accounts phase (20261203000120): the requester or (Flight) the current cost-task owner.
  v := authz.sm_payment_for_command(p_payment_id, 'canceller');
  v_result := authz.sm_replay(v.legal_entity_id, p_request_id, 'supplier_payment_request_cancel', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v.status <> 'pending' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  update public.supplier_payment_requests p
  set status = 'cancelled', cancelled_by = (select auth.uid()), cancelled_at = now(),
      row_version = p.row_version + 1, updated_at = now()
  where p.id = v.id returning * into v;
  if v.flight_batch_id is not null then
    perform authz.write_audit('flight.payment_cancelled', v.legal_entity_id, v.branch_id, 'fulfilment_task', v.task_id,
      null, jsonb_build_object('dealId', v.deal_id, 'paymentRequestId', v.id, 'refNo', v.ref_no, 'batchId', v.flight_batch_id,
        -- Accounts phase (20261203000120)
        'byTaskOwner', v.requested_by is distinct from (select auth.uid())));
  else
    perform authz.write_audit('purchase.payment_cancelled', v.legal_entity_id, v.branch_id, 'fulfilment_task', v.task_id,
      null, jsonb_build_object('paymentRequestId', v.id, 'refNo', v.ref_no));
  end if;
  v_result := jsonb_build_object('outcome', 'created', 'id', v.id, 'status', v.status, 'rowVersion', v.row_version);
  return authz.sm_remember(v.legal_entity_id, p_request_id, 'supplier_payment_request_cancel', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 3. Flight money read (replaces 20261201000270; + payment.canCancel)
-- ===========================================================================

create or replace function public.flight_money(p_deal_id uuid) returns jsonb
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
  v_sell boolean;
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
  -- 20261201000250 (lead): a holder of Purchase never gets selling-side values.
  v_sell := not authz.holds_role('purchase', v_deal.legal_entity_id);
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
    -- 20261201000270: true only on flight-only Deals for a caller who may see
    -- and enter markup and discount (never a holder of Purchase).
    'marginsAllowed', v_fo and v_sell,
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
              'paymentRowVersion', x.payment_row_version,
              -- Accounts phase (20261203000120): a pending request is cancelled by its
              -- requester or the current owner of the batch's cost task (H9).
              'canCancel', x.state = 'request_pending' and x.payment_id is not null
                           and (exists (select 1 from public.supplier_payment_requests p
                                        where p.id = x.payment_id and p.requested_by = v_uid)
                                or authz.flight_owns_task(b.cost_task_id))) else '{}'::jsonb end
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
              || case when b.deal_kind = 'flight_only' and v_sell then jsonb_build_object(
                'markupPaise', f.markup_paise::text,
                'discountPaise', f.discount_paise::text,
                'totalPerPersonPaise', f.total_per_person_paise::text,
                'customerAmountPaise', (f.total_per_person_paise * f.pax_count)::text) else '{}'::jsonb end
              order by case f.pax_type when 'adult' then 1 when 'child' then 2 else 3 end)
            from public.flight_batch_fares f where f.batch_id = b.id), '[]'::jsonb),
          'supplierCostPaise', b.supplier_cost_paise::text,
          -- 20261201000250 (L18): covered by old-form payments, and still to pay.
          'legacyPaidPaise', authz.flight_batch_legacy_paid(b.id)::text,
          'duePaise', authz.flight_batch_due(b.id)::text) else '{}'::jsonb end
        || case when b.deal_kind = 'flight_only' and v_sell then jsonb_build_object('customerTotalPaise', b.customer_total_paise::text)
                else '{}'::jsonb end
        || case when v_full then jsonb_build_object(
          'routePreview', case when rt.total + authz.flight_batch_due(b.id) <= 5000000 then 'direct' else 'manager' end)
                else '{}'::jsonb end
        -- Actions: the Flight person only.
        || case when v_fa then jsonb_build_object(
          'canPayDirect', authz.flight_owns_task(b.cost_task_id) and not v_cancelled and authz.flight_batch_due(b.id) > 0
                          and x.state in ('unpaid', 'direct_returned', 'request_returned', 'request_cancelled')
                          and rt.total + authz.flight_batch_due(b.id) <= 5000000,
          'canRequest', authz.flight_owns_task(b.cost_task_id) and not v_cancelled and authz.flight_batch_due(b.id) > 0
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
  || case when v_fo and v_sell then jsonb_build_object('customerTotalPaise', (
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

commit;
