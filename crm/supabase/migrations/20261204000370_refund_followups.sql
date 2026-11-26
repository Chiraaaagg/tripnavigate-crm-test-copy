-- Accounts phase 2, Track C fix-forward (Track E follow-ups via the lead,
-- 11 Nov 2026): additive read keys only; no command, rule or fence changes.
--
-- * public.refund_requests_list (replaces 20261204000360, same signature):
--   each row adds rowVersion, can {approve, return, payout} and the binding
--   expectedAmountPaise / expectedChargePaise (null unless the viewer may act),
--   so the queue acts without reading each Deal.
-- * authz.flight_cancellation_charges_json (replaces 20261204000330): each
--   batch adds note (Manager readers of the cancellation list / summary).
-- * public.flight_money (replaces 20261204000330): batch cancellation adds
--   note (F, M, A only, as the rest of that object).
-- * public.visa_workspace (replaces 20261204000330): each applicant adds
--   cancellationChoiceReason (Visa desk and branch Manager readers).
-- * Addendum L6 (receipt reversed after a refund was paid out):
--   - authz.refund_validate (replaces 20261204000310): requests refuse
--     refund_exceeds_money (22023, hint heldPaise) while money held < 0;
--     deal_refunds (replaces 20261204000350) canRequest false then.
--   - authz.dues_compute / public.deal_dues (replace 20261204000320): the
--     shortfall (-money held) is added to balance and due now (status
--     due_now unless overdue); after an approved settlement the unpaid
--     customer charge is due now too (no plan); deal_dues refunds.shortfallPaise.
--   - authz.notices_on_refund_shortfall: AFTER INSERT trigger on
--     finance_journal_lines; a reversal leaving money held < 0 on a Deal with
--     a paid-out refund notifies the Accounts exception owner and SO* with
--     kind 'refund_shortfall' (registered by Track D; skipped until then).
-- Refusal tokens unchanged (refund_exceeds_money gains hint heldPaise).
-- Rollback (forward-only): a NEW migration restoring the 20261204000360 /
-- 20261204000330 bodies.

begin;
set local lock_timeout = '15s';

create or replace function public.refund_requests_list(p_filter jsonb, p_after text default null, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_a uuid[];
  v_m uuid[];
  v_syn boolean;
  v_sales boolean;
  v_so uuid[];
  v_filter jsonb := coalesce(p_filter, '{}'::jsonb);
  v_preset text;
  v_status text[];
  v_outcome text[];
  v_ref text;
  v_branch uuid;
  v_from date;
  v_to date;
  v_after_ts timestamptz;
  v_after_id uuid;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_rows jsonb;
  v_n integer;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  v_syn := authz.acct_synthetic();
  if v_syn is null then
    return null;
  end if;
  v_a := array(select e from unnest(authz.acct_a_entities()) e where authz.finance_gate_issue(e, v_syn) is null);
  v_m := array(select b from unnest(authz.acct_m_branches()) b);
  -- 20261204000360: the Sales-owner scope once per call (entities where the
  -- caller is an active Sales person without P/F/V), not a definer call per row.
  v_so := array(select distinct m.legal_entity_id from public.memberships m
                join public.staff_profiles p on p.user_id = m.user_id and p.status = 'active'
                join public.legal_entities e on e.id = m.legal_entity_id and e.status = 'enabled'
                join public.branches b on b.id = m.branch_id and b.status = 'enabled'
                where m.user_id = v_uid and m.role_code = 'sales' and m.status = 'active'
                  and not exists (select 1 from public.memberships x
                                  where x.user_id = v_uid and x.legal_entity_id = m.legal_entity_id
                                    and x.role_code in ('purchase', 'flight', 'visa') and x.status = 'active'));
  v_sales := cardinality(v_so) > 0;
  if cardinality(v_a) = 0 and cardinality(v_m) = 0 and not v_sales then
    return null;
  end if;
  if jsonb_typeof(v_filter) <> 'object' then
    perform authz.refund_invalid('filter');
  end if;
  v_preset := v_filter ->> 'preset';
  if v_preset is not null and v_preset not in ('payout_due', 'to_approve') then
    perform authz.refund_invalid('preset');
  end if;
  begin
    v_status := case when jsonb_typeof(v_filter -> 'status') = 'array'
      then array(select jsonb_array_elements_text(v_filter -> 'status')) end;
    v_outcome := case when jsonb_typeof(v_filter -> 'outcome') = 'array'
      then array(select jsonb_array_elements_text(v_filter -> 'outcome')) end;
    v_ref := nullif(btrim(v_filter ->> 'dealReference'), '');
    v_branch := nullif(v_filter ->> 'branchId', '')::uuid;
    v_from := nullif(v_filter ->> 'from', '')::date;
    v_to := nullif(v_filter ->> 'to', '')::date;
    if p_after is not null then
      v_after_ts := split_part(p_after, '|', 1)::timestamptz;
      v_after_id := split_part(p_after, '|', 2)::uuid;
    end if;
  exception when others then
    perform authz.refund_invalid('filter');
  end;
  if v_status is not null and not (v_status <@ array['requested', 'returned', 'approved', 'paid', 'withdrawn']) then
    perform authz.refund_invalid('status');
  end if;
  if v_outcome is not null and not (v_outcome <@ array['payout', 'keep_credit', 'charge_only']) then
    perform authz.refund_invalid('outcome');
  end if;

  with rows as (
    select q.*, d.reference as deal_reference, b.name as branch_name
    from public.customer_refund_requests q
    join public.deals d on d.id = q.deal_id
    join public.branches b on b.id = q.branch_id
    where d.is_synthetic = v_syn
      and (q.legal_entity_id = any(v_a) or q.branch_id = any(v_m)
           or (d.owner_user_id = v_uid and q.legal_entity_id = any(v_so)))
      and (v_preset is null
           or (v_preset = 'payout_due' and q.legal_entity_id = any(v_a) and q.status = 'approved' and q.outcome = 'payout'
               and q.requested_by <> v_uid and q.decided_by is distinct from v_uid)
           or (v_preset = 'to_approve' and q.status = 'requested' and q.requested_by <> v_uid and authz.refund_decider(q.id)))
      and (v_status is null or q.status = any(v_status))
      and (v_outcome is null or q.outcome = any(v_outcome))
      and (v_ref is null or d.reference = v_ref or q.ref_no = v_ref)
      and (v_branch is null or q.branch_id = v_branch)
      and (v_from is null or (q.requested_at at time zone 'Asia/Kolkata')::date >= v_from)
      and (v_to is null or (q.requested_at at time zone 'Asia/Kolkata')::date <= v_to)
      and (v_after_ts is null or (q.requested_at, q.id) < (v_after_ts, v_after_id))
    order by q.requested_at desc, q.id desc
    limit v_limit + 1
  ), numbered as (
    select r.*, row_number() over (order by r.requested_at desc, r.id desc) as n,
      -- Accounts phase 2 (20261204000370): decider check only on requested rows of the page.
      coalesce(r.status = 'requested' and r.requested_by <> v_uid and authz.refunds_enabled(r.legal_entity_id)
               and authz.refund_decider(r.id), false) as can_decide,
      coalesce(r.status = 'approved' and r.outcome = 'payout' and r.legal_entity_id = any(v_a) and r.requested_by <> v_uid
               and r.decided_by is distinct from v_uid and authz.refunds_enabled(r.legal_entity_id), false) as can_payout
    from rows r
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'refNo', x.ref_no, 'dealId', x.deal_id, 'dealReference', x.deal_reference, 'branchName', x.branch_name,
      'kind', x.kind, 'outcome', x.outcome, 'status', x.status, 'amountPaise', x.amount_paise::text,
      'customerChargePaise', x.customer_charge_paise::text, 'requestedByName', sp.display_name, 'requestedAt', x.requested_at,
      'ageWorkingDays', authz.refund_working_days((x.requested_at at time zone 'Asia/Kolkata')::date, authz.finance_today()),
      -- Accounts phase 2 (20261204000370): act from the queue without reading each Deal.
      'rowVersion', x.row_version,
      'can', jsonb_build_object('approve', x.can_decide, 'return', x.can_decide, 'payout', x.can_payout),
      -- The exact amounts a decision or payout binds to; only where the viewer may act.
      'expectedAmountPaise', case when x.can_decide or x.can_payout then x.amount_paise::text end,
      'expectedChargePaise', case when x.can_decide or x.can_payout then x.customer_charge_paise::text end,
      'cursor', to_char(x.requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || x.id::text)
      order by x.n) filter (where x.n <= v_limit), '[]'::jsonb), count(*)::integer
  into v_rows, v_n
  from numbered x
  left join public.staff_profiles sp on sp.user_id = x.requested_by;
  return jsonb_build_object(
    'items', (select coalesce(jsonb_agg(e - 'cursor'), '[]'::jsonb) from jsonb_array_elements(v_rows) e),
    'nextAfter', case when v_n > v_limit then (v_rows -> (v_limit - 1)) ->> 'cursor' end);
end;
$$;

create or replace function authz.flight_cancellation_charges_json(p_cancellation uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'batchId', b.id, 'batchNo', b.batch_no, 'supplierName', s.name,
      'supplierCostPaise', coalesce(y.supplier_cost_paise, b.supplier_cost_paise)::text,
      'airlineChargePaise', y.airline_charge_paise::text, 'refundExpectedPaise', y.refund_expected_paise::text,
      'refundReportedPaise', y.refund_reported_paise::text, 'revisionNo', coalesce(y.revision_no, 0),
      'enteredByName', ep.display_name,
      -- Accounts phase 2 (20261204000370): the Flight note of the latest revision.
      'note', y.note) order by b.batch_no), '[]'::jsonb)
  from public.deal_cancellations c
  join public.flight_ticket_batches b on b.deal_id = c.deal_id
  join public.suppliers s on s.id = b.supplier_id
  left join lateral (select x.* from public.flight_cancellation_charges x
                     where x.cancellation_id = c.id and x.batch_id = b.id
                     order by x.revision_no desc limit 1) y on true
  left join public.staff_profiles ep on ep.user_id = y.entered_by
  where c.id = p_cancellation
$$;

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
  v_c public.deal_cancellations%rowtype;
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
  select * into v_c from public.deal_cancellations c where c.deal_id = v_deal.id;

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
          -- Accounts phase 2 (20261204000330): tickets stay immutable; after approval they read cancelled.
          'ticketsCancelled', v_c.status is not distinct from 'approved',
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
                                or authz.flight_owns_task(b.cost_task_id)))
            -- Accounts phase (20261203000130): the requester of a pending request who
            -- is no longer a Flight assignee of the Deal can still cancel it.
            when v_f and x.state = 'request_pending' and x.payment_id is not null
                 and exists (select 1 from public.supplier_payment_requests p
                             where p.id = x.payment_id and p.requested_by = v_uid) then jsonb_build_object(
              'paymentId', x.payment_id,
              'paymentRowVersion', x.payment_row_version,
              'canCancel', true) else '{}'::jsonb end
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
        -- Accounts phase 2 (20261204000330, 2d): the batch's cancellation charge for F, M and A.
        || case when v_full and v_c.id is not null then jsonb_build_object('cancellation', jsonb_build_object(
          'state', case when v_c.status = 'approved' then 'approved' else 'open' end,
          'revisionNo', coalesce(fc.revision_no, 0),
          'airlineChargePaise', fc.airline_charge_paise::text,
          'refundExpectedPaise', fc.refund_expected_paise::text,
          'refundReportedPaise', fc.refund_reported_paise::text,
          -- Accounts phase 2 (20261204000370): the Flight note of the latest revision (F, M, A).
          'note', fc.note,
          'supplierRefundReceivedPaise', (select coalesce(sum(s2.amount_paise), 0)::text from public.supplier_refund_receipts s2
                                          where s2.source_kind = 'flight_charge' and s2.source_group_id = b.id and s2.status = 'verified'),
          'canEnter', authz.flight_can_enter_charge(b.id)))
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
      left join lateral (select y.* from public.flight_cancellation_charges y
                         where y.batch_id = b.id and y.cancellation_id = v_c.id
                         order by y.revision_no desc limit 1) fc on true
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

create or replace function public.visa_workspace(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_ver public.booking_versions%rowtype;
  v_facts jsonb;
  v_va boolean;
  v_visa boolean;
  v_progress jsonb;
  v_c public.deal_cancellations%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_task_id is null or not authz.can_read_visa_task(p_task_id) then
    return null;
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  select * into v_ver from public.booking_versions v where v.id = authz.task_current_version(v_task.id);
  v_facts := authz.visa_task_facts(v_task.id);
  v_va := authz.can_work_department_task(v_task.id);
  v_visa := authz.holds_active_role('visa', v_task.legal_entity_id);
  v_progress := authz.visa_task_progress(v_task.id);
  select * into v_c from public.deal_cancellations c where c.deal_id = v_task.deal_id;
  return jsonb_build_object(
    'taskId', v_task.id, 'serviceType', v_task.service_purpose, 'dealId', v_task.deal_id,
    'dealReference', (select d.reference from public.deals d where d.id = v_task.deal_id),
    'branchName', (select b.name from public.branches b where b.id = v_task.branch_id),
    'title', authz.visa_task_title(v_task.id),
    'status', v_progress -> 'status',
    'assignee', jsonb_build_object(
      'name', (select s.display_name from public.staff_profiles s where s.user_id = v_task.assignee_user_id),
      'isYou', v_task.assignee_user_id is not distinct from v_uid and v_task.assignee_user_id is not null,
      'takenAt', case when v_task.assignee_user_id is not null then (
          select a.occurred_at from public.audit_events a
          where a.target_type = 'fulfilment_task' and a.target_id = v_task.id
            and a.action in ('fulfilment.task_claimed', 'fulfilment.task_reassigned')
          order by a.occurred_at desc, a.id desc limit 1) end),
    'canClaim', v_visa and v_task.status = 'not_started' and v_task.assignee_user_id is null,
    'canWork', v_va,
    'isManagerView', not v_visa,
    'versionNo', v_ver.version_no, 'confirmedAt', v_ver.confirmed_at,
    'facts', case when v_task.service_purpose = 'passport' then jsonb_build_object('passport', jsonb_build_object(
        'applicationType', v_facts ->> 'applicationType', 'officeCity', v_facts ->> 'officeCity',
        'neededBy', v_facts ->> 'neededBy', 'notes', v_facts ->> 'notes'))
      else jsonb_build_object('visa', jsonb_build_object(
        'country', v_facts ->> 'country', 'purpose', v_facts ->> 'purpose', 'travelDate', v_facts ->> 'travelDate',
        'applyBy', v_facts ->> 'applyBy', 'feePaidBy', v_facts ->> 'feePaidBy', 'notes', v_facts ->> 'notes',
        'visaKind', authz.visa_sales_kind(v_facts), 'jurisdiction', authz.visa_sales_jurisdiction(v_facts),
        'jurisdictionPlace', case when authz.visa_sales_jurisdiction(v_facts) = 'yes' then v_facts ->> 'jurisdictionPlace' end,
        'documentsNeeded', to_jsonb(authz.visa_sales_document_labels(v_facts)))) end,
    'steps', v_progress -> 'steps',
    'bookingChange', authz.visa_booking_change_json(v_task.id),
    'addedAfterCompletion', authz.visa_added_after_completion(v_task.id),
    'applicants', (select coalesce(jsonb_agg(authz.visa_applicant_json(a.id, v_va, v_facts)
                                             -- Accounts phase 2 (20261204000330): per-application cancellation choice.
                                             || jsonb_build_object('cancellationChoice', a.cancellation_choice,
                                                  -- Accounts phase 2 (20261204000370): the reason given with the choice.
                                                  'cancellationChoiceReason', a.cancellation_choice_reason,
                                                  'canChooseCancellation', v_va and coalesce(v_c.status = 'approved', false)
                                                    and a.cancellation_choice is null and a.closed_at is null
                                                    and a.removed_at is null and a.state in ('submitted', 'decision_pending'))
                                             order by (a.removed_at is not null), a.traveller_seq, a.created_at), '[]'::jsonb)
                   from public.visa_applications a where a.task_id = v_task.id and a.superseded_at is null),
    'previousApplications', (select coalesce(jsonb_agg(jsonb_build_object(
        'applicationId', a.id, 'seq', a.traveller_seq, 'reference', a.reference, 'state', a.state,
        'closed', a.closed_at is not null,
        'decision', case a.state when 'issued' then 'approved' when 'refused' then 'rejected' when 'withdrawn' then 'withdrawn' end)
        order by a.traveller_seq, a.created_at), '[]'::jsonb)
      from public.visa_applications a where a.task_id = v_task.id and a.superseded_at is not null),
    'readyCount', (v_progress ->> 'readyCount')::integer, 'appliedCount', (v_progress ->> 'appliedCount')::integer,
    'costSummary', jsonb_build_object(
      'travellers', (select coalesce(jsonb_agg(jsonb_build_object(
          'seq', a.traveller_seq, 'name', authz.visa_app_name(a),
          'governmentFeePaise', (g.e).amount_paise::text, 'serviceFeePaise', (sv.e).amount_paise::text,
          -- 20261202000140 (finding 4): "other" costs of the passenger, summed as recorded.
          'otherPaise', (select sum(o.amount_paise)::text from public.department_cost_entries o
                         where o.application_id = a.id and o.cost_kind = 'other'),
          'paidBy', coalesce((g.e).paid_by, (sv.e).paid_by), 'expenseStatus', coalesce((g.e).expense_status, (sv.e).expense_status),
          'state', a.state) order by a.traveller_seq), '[]'::jsonb)
        from public.visa_applications a
        left join lateral (select c as e from public.department_cost_entries c
                           where c.application_id = a.id and c.cost_kind = 'government_fee'
                           order by c.created_at desc, c.id desc limit 1) g on true
        left join lateral (select c as e from public.department_cost_entries c
                           where c.application_id = a.id and c.cost_kind = 'service_fee'
                           order by c.created_at desc, c.id desc limit 1) sv on true
        where a.task_id = v_task.id and a.superseded_at is null),
      'taskLevel', (select coalesce(jsonb_agg(jsonb_build_object('entryId', c.id, 'costKind', c.cost_kind,
          'amountPaise', c.amount_paise::text, 'paidBy', c.paid_by, 'expenseStatus', c.expense_status)
          order by c.created_at, c.id), '[]'::jsonb)
        from public.department_cost_entries c where c.task_id = v_task.id and c.application_id is null),
      'companyTotalPaise', (select coalesce(sum(c.amount_paise), 0)::text from public.department_cost_entries c
                            where c.task_id = v_task.id and c.paid_by = 'company'),
      'customerDirectTotalPaise', (select coalesce(sum(c.amount_paise), 0)::text from public.department_cost_entries c
                                   where c.task_id = v_task.id and c.paid_by = 'customer_direct')),
    'returnedFees', (select coalesce(jsonb_agg(jsonb_build_object(
        'entryId', c.id, 'applicantName', (select authz.visa_app_name(a) from public.visa_applications a where a.id = c.application_id),
        'costKind', c.cost_kind, 'amountPaise', c.amount_paise::text, 'returnReason', c.return_reason, 'rowVersion', c.row_version)
        order by c.reviewed_at, c.id), '[]'::jsonb)
      from public.department_cost_entries c where c.task_id = v_task.id and c.expense_status = 'returned'),
    'catalogue', case when v_va then (select jsonb_agg(jsonb_build_object('code', c.code, 'label', c.label) order by c.ord)
                                      from authz.visa_document_catalogue() c) else '[]'::jsonb end,
    'files', (select coalesce(jsonb_agg(jsonb_build_object(
        'evidenceId', e.id, 'kind', e.kind, 'applicationId', e.application_id, 'fileName', e.file_name, 'mime', e.mime,
        'sizeBytes', e.size_bytes, 'status', e.status, 'uploadedByYou', e.uploaded_by = v_uid,
        'uploadedByName', authz.visa_staff_name(v_task.id, e.uploaded_by), 'createdAt', e.created_at, 'storedAt', e.stored_at,
        'visaDocumentId', e.visa_document_id,
        'applicantSeq', (select a.traveller_seq from public.visa_applications a where a.id = e.application_id))
        order by e.created_at, e.id), '[]'::jsonb)
      from public.department_evidence e where e.task_id = v_task.id and e.status <> 'removed'),
    'canUpload', v_va,
    -- 20261202000140 (finding 1): fee receipts, Send / Fix fee and "other" costs, also after completion.
    'canManageFees', authz.visa_can_manage_fees(v_task.id),
    -- Accounts phase 2 (20261204000330, LD12): banner while open; after approval new spending
    -- stops, each submitted application gets a choice, paid fees an expected refund.
    'cancellation', case when v_c.id is null then null else jsonb_build_object(
      'cancellationId', v_c.id, 'status', v_c.status, 'approved', v_c.status = 'approved',
      'fees', (select coalesce(jsonb_agg(jsonb_build_object(
          'entryId', c.id, 'applicationId', c.application_id, 'costKind', c.cost_kind, 'amountPaise', c.amount_paise::text,
          'refundExpectedPaise', f.refund_expected_paise::text, 'revisionNo', coalesce(f.revision_no, 0),
          'canSet', authz.visa_can_manage_fees(v_task.id)) order by c.created_at, c.id), '[]'::jsonb)
        from public.department_cost_entries c
        left join lateral (select x.refund_expected_paise, x.revision_no from public.visa_cancellation_fees x
                           where x.entry_id = c.id and x.cancellation_id = v_c.id
                           order by x.revision_no desc limit 1) f on true
        where c.task_id = v_task.id and c.paid_by = 'company')) end);
end;
$$;

create or replace function authz.refund_validate(p_deal uuid, p_fields jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_key text;
  v_kind text;
  v_outcome text;
  v_charge bigint;
  v_amount bigint;
  v_payee_kind text;
  v_receipt uuid;
  v_payee_name text;
  v_payee_reason text;
  v_reason text;
  v_cancellation uuid;
  v_held bigint;
  v_total bigint;
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    perform authz.refund_invalid('fields');
  end if;
  for v_key in select k from jsonb_object_keys(p_fields) k order by k loop
    if v_key <> all (array['kind', 'outcome', 'customerChargePaise', 'amountPaise', 'payeeKind', 'payeeReceiptId', 'payeeName',
                           'payeeReason', 'reason']) then
      perform authz.refund_invalid(v_key);
    end if;
  end loop;
  v_kind := authz.refund_text(p_fields, 'kind', 1, 20, false);
  if v_kind is null or v_kind not in ('cancellation', 'overpayment') then
    perform authz.refund_invalid('kind');
  end if;
  v_outcome := authz.refund_text(p_fields, 'outcome', 1, 20, false);
  if v_outcome is null or v_outcome not in ('payout', 'keep_credit', 'charge_only')
     or (v_kind = 'overpayment' and v_outcome = 'charge_only') then
    perform authz.refund_invalid('outcome');
  end if;
  v_charge := authz.refund_paise(p_fields, 'customerChargePaise');
  if v_kind = 'cancellation' and v_charge is null then
    perform authz.refund_invalid('customerChargePaise');
  end if;
  if v_kind = 'overpayment' and coalesce(v_charge, 0) <> 0 then
    perform authz.refund_invalid('customerChargePaise');
  end if;
  v_charge := coalesce(v_charge, 0);
  v_amount := authz.refund_paise(p_fields, 'amountPaise');
  if v_outcome = 'charge_only' then
    if coalesce(v_amount, 0) <> 0 then
      perform authz.refund_invalid('amountPaise');
    end if;
    v_amount := 0;
  elsif v_amount is null or v_amount < 1 then
    perform authz.refund_invalid('amountPaise');
  end if;
  v_reason := authz.refund_text(p_fields, 'reason', 10, 500, true);
  if v_reason is null then
    perform authz.refund_invalid('reason');
  end if;
  if v_outcome = 'payout' then
    v_payee_kind := authz.refund_text(p_fields, 'payeeKind', 1, 20, false);
    if v_payee_kind is null or v_payee_kind not in ('original_payer', 'other') then
      perform authz.refund_invalid('payeeKind');
    end if;
    if v_payee_kind = 'original_payer' then
      -- LD8 / Q7: the name is copied from a verified payment of this Deal, never typed.
      v_receipt := authz.refund_uuid(p_fields, 'payeeReceiptId');
      select r.payer_name into v_payee_name from public.customer_receipts r
      where r.id = v_receipt and r.deal_id = p_deal and r.status in ('verified', 'cleared');
      if v_receipt is null or v_payee_name is null then
        perform authz.refund_invalid('payeeReceiptId');
      end if;
    else
      if authz.refund_uuid(p_fields, 'payeeReceiptId') is not null then
        perform authz.refund_invalid('payeeReceiptId');
      end if;
      v_payee_name := authz.refund_text(p_fields, 'payeeName', 1, 200, false);
      if v_payee_name is null then
        perform authz.refund_invalid('payeeName');
      end if;
      v_payee_reason := authz.refund_text(p_fields, 'payeeReason', 10, 500, true);
      if v_payee_reason is null then
        perform authz.refund_invalid('payeeReason');
      end if;
    end if;
  end if;

  if v_kind = 'cancellation' then
    select c.id into v_cancellation from public.deal_cancellations c where c.deal_id = p_deal and c.status = 'approved';
    if v_cancellation is null then
      raise exception 'not_ready' using errcode = '55000', hint = 'cancellation';
    end if;
  end if;
  v_held := authz.refund_money_held(p_deal);
  -- Accounts phase 2 (20261204000370, Addendum L6): no new refund while a reversed payment left money held below zero.
  if v_held < 0 then
    raise exception 'refund_exceeds_money' using errcode = '22023', hint = 'heldPaise';
  end if;
  if v_kind = 'cancellation' then
    if v_outcome <> 'charge_only' and v_amount > v_held - v_charge then
      raise exception 'refund_exceeds_money' using errcode = '22023', hint = 'amountPaise';
    end if;
  else
    v_total := authz.refund_basis_total(p_deal);
    if v_total is null then
      raise exception 'not_ready' using errcode = '55000', hint = 'booking';
    end if;
    if v_amount > v_held - v_total then
      raise exception 'refund_exceeds_money' using errcode = '22023', hint = 'amountPaise';
    end if;
  end if;
  return jsonb_build_object('kind', v_kind, 'outcome', v_outcome, 'cancellationId', v_cancellation,
    'chargePaise', v_charge, 'amountPaise', v_amount, 'payeeKind', v_payee_kind, 'payeeReceiptId', v_receipt,
    'payeeName', v_payee_name, 'payeeReason', v_payee_reason, 'reason', v_reason, 'heldPaise', v_held);
end;
$$;

create or replace function authz.dues_compute(p_a uuid[], p_m uuid[], p_so_entities uuid[], p_syn boolean, p_deal uuid, p_force boolean)
returns table (
  deal_id uuid, reference text, branch_id uuid, owner_user_id uuid, legal_entity_id uuid,
  version_id uuid, version_no integer, basis text, last_approved_at timestamptz, newer_pending boolean,
  total bigint, money bigint, balance bigint, overdue bigint, due_now bigint, next_due_date date, next_due_open bigint,
  oldest_open date, reported bigint, awaiting bigint, credit bigint, has_plan boolean, status text, rank integer,
  cancellation text, is_a boolean, is_m boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  -- Accounts phase 2 (20261204000320): basis 'cancelled' after an approved
  -- cancellation settlement (total = the customer charge, no plan); money as before.
  -- Accounts phase (20261203000290): dynamic, planned with the values of
  -- each call. The cached generic plan of the SQL-language body (from the
  -- sixth call on PGlite) reran the per-Deal subqueries for minutes.
  return query execute $q$
  with scope as (
    select d.id, d.reference, d.branch_id, d.owner_user_id, d.legal_entity_id,
      d.legal_entity_id = any($1) as is_a, d.branch_id = any($2) as is_m
    from public.deals d
    where d.is_synthetic = $4
      and ($5 is null or d.id = $5)
      and (($5 is not null and $6)
           or d.legal_entity_id = any($1)
           or d.branch_id = any($2)
           or (d.owner_user_id = (select auth.uid()) and d.legal_entity_id = any($3)))
  ), cur as (
    select v.deal_id, v.id, v.version_no from public.booking_versions v
    join scope s on s.id = v.deal_id where v.status = 'confirmed'
  ), approved as (
    select distinct on (v.deal_id) v.deal_id, v.id, v.version_no, rv.last_approved_at
    from public.booking_versions v
    join scope s on s.id = v.deal_id
    join public.accounts_booking_reviews rv on rv.booking_version_id = v.id
    where v.status in ('confirmed', 'superseded') and rv.last_approved_at is not null
    order by v.deal_id, v.version_no desc
  ), basis as (
    select s.*, coalesce(a.id, c.id) as version_id, coalesce(a.version_no, c.version_no) as version_no,
      case when a.id is not null then 'approved' else 'awaiting_review' end as basis, a.last_approved_at,
      coalesce(a.id is not null and c.version_no > a.version_no, false) as newer_pending
    from scope s
    join cur c on c.deal_id = s.id
    left join approved a on a.deal_id = s.id
  ), settle as (
    -- Accounts phase 2 (20261204000320, LD10): the latest approved (or paid)
    -- cancellation settlement replaces the total and the plan.
    select distinct on (r.deal_id) r.deal_id, r.customer_charge_paise
    from public.customer_refund_requests r join basis b on b.id = r.deal_id
    where r.kind = 'cancellation' and r.status in ('approved', 'paid')
    order by r.deal_id, r.decided_at desc, r.id desc
  ), money as (
    select l.deal_id, sum(l.credit_paise - l.debit_paise)::bigint as m
    from public.finance_journal_lines l join basis b on b.id = l.deal_id
    where l.account = 'customer_advances'
    group by l.deal_id
  ), charged as (
    select b.*, st.deal_id is not null as settled,
      -- Accounts phase 2 (20261204000320): settled total = the approved customer charge.
      coalesce(st.customer_charge_paise, bc.selling_total_paise, 0)::bigint as total, coalesce(mo.m, 0)::bigint as money,
      greatest(coalesce(mo.m, 0), 0)::bigint as mpos
    from basis b
    left join public.booking_version_commercials bc on bc.version_id = b.version_id
    left join money mo on mo.deal_id = b.id
    left join settle st on st.deal_id = b.id
  ), inst as (
    select c.id as deal_id, i.seq, i.due_date, i.amount_paise,
      least(i.amount_paise, greatest(c.mpos - coalesce(sum(i.amount_paise) over (
        partition by i.booking_version_id order by i.due_date, i.seq rows between unbounded preceding and 1 preceding), 0), 0))::bigint as covered
    from charged c join public.booking_version_instalments i on i.booking_version_id = c.version_id
    -- Accounts phase 2 (20261204000320): instalments are ignored after a settlement.
    where not c.settled
  ), inst_agg as (
    select x.deal_id, count(*) as n,
      coalesce(sum(x.amount_paise - x.covered) filter (where x.amount_paise > x.covered and x.due_date < authz.finance_today()), 0)::bigint as overdue,
      coalesce(sum(x.amount_paise - x.covered) filter (where x.amount_paise > x.covered and x.due_date = authz.finance_today()), 0)::bigint as due_now,
      min(x.due_date) filter (where x.amount_paise > x.covered) as oldest_open,
      (array_agg(x.due_date order by x.due_date, x.seq) filter (where x.amount_paise > x.covered))[1] as next_date,
      (array_agg(x.amount_paise - x.covered order by x.due_date, x.seq) filter (where x.amount_paise > x.covered))[1] as next_open
    from inst x group by x.deal_id
  ), extra as (
    -- Accounts phase (20261203000290): grouped once instead of three lookups per Deal.
    select c.id, coalesce(cl.reported, 0)::bigint as reported, coalesce(rc.awaiting, 0)::bigint as awaiting, dc.cancellation
    from charged c
    left join (select x.deal_id, sum(x.amount_paise) as reported from public.customer_payment_claims x
               where x.status = 'reported' and x.deal_id in (select id from charged) group by x.deal_id) cl on cl.deal_id = c.id
    left join (select r.deal_id, sum(r.amount_paise) as awaiting from public.customer_receipts r
               where r.status = 'recorded' and r.mode <> 'cheque' and r.deal_id in (select id from charged) group by r.deal_id) rc
      on rc.deal_id = c.id
    left join (select y.deal_id, case when bool_or(y.status <> 'approved') then 'open' when bool_or(y.status = 'approved') then 'approved' end
                 as cancellation
               from public.deal_cancellations y where y.deal_id in (select id from charged) group by y.deal_id) dc on dc.deal_id = c.id
  ), computed as (
    select c.*, coalesce(ia.n, 0) > 0 as has_plan, coalesce(ia.overdue, 0) as overdue,
      -- After an approved settlement there is no plan: the unpaid charge is owed now (Addendum L6, lead).
      (coalesce(ia.due_now, 0) + greatest(-c.money, 0)
       + case when c.settled then c.total - least(c.mpos, c.total) else 0 end)::bigint as due_now,
      ia.oldest_open, ia.next_date, ia.next_open, e.reported, e.awaiting, e.cancellation,
      -- Accounts phase 2 (20261204000370, Addendum L6): a reversal after a paid-out refund can leave money below
      -- zero; the shortfall is owed now, on top of the total.
      greatest(-c.money, 0)::bigint as shortfall,
      (c.total - least(c.mpos, c.total) + greatest(-c.money, 0))::bigint as balance,
      greatest(c.mpos - c.total, 0)::bigint as credit,
      case
        when c.mpos > c.total then 'credit'
        when coalesce(ia.overdue, 0) > 0 then 'overdue'
        when coalesce(ia.due_now, 0) + greatest(-c.money, 0)
             + case when c.settled then c.total - least(c.mpos, c.total) else 0 end > 0 then 'due_now'
        when coalesce(ia.n, 0) = 0 and c.mpos > 0 and c.mpos < c.total then 'unallocated'
        when coalesce(ia.n, 0) = 0 and c.mpos = 0 and c.total > 0 then 'no_plan'
        when c.total - least(c.mpos, c.total) > 0 then 'upcoming'
        else 'paid' end as status
    from charged c
    left join inst_agg ia on ia.deal_id = c.id
    join extra e on e.id = c.id
  )
  select x.id, x.reference, x.branch_id, x.owner_user_id, x.legal_entity_id,
    x.version_id, x.version_no, case when x.settled then 'cancelled' else x.basis end, x.last_approved_at, x.newer_pending,
    x.total, x.money, x.balance, x.overdue, x.due_now, x.next_date, x.next_open,
    x.oldest_open, x.reported, x.awaiting, x.credit, x.has_plan, x.status,
    case x.status when 'overdue' then 1 when 'due_now' then 2 when 'upcoming' then 3 when 'unallocated' then 4
                  when 'no_plan' then 5 when 'credit' then 6 else 7 end,
    x.cancellation, x.is_a, x.is_m
  from computed x
  $q$ using p_a, p_m, p_so_entities, p_syn, p_deal, p_force;
end;
$$;

create or replace function public.deal_dues(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_a uuid[]; v_m uuid[]; v_syn boolean;
  v_sales boolean := false;
  r record;
  v_row jsonb;
begin
  if p_deal_id is null or not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null then
    return null;
  end if;
  v_a := authz.acct_a_entities();
  v_m := authz.acct_m_branches();
  v_syn := authz.acct_synthetic();
  if v_syn is null or v_deal.is_synthetic is distinct from v_syn then
    return null;
  end if;
  if not (v_deal.legal_entity_id = any(v_a)) and not (v_deal.branch_id = any(v_m)) then
    -- AL5: the existing Sales money-card readers; never Purchase, Flight or Visa.
    v_sales := coalesce(authz.finance_claim_sales_ok(v_deal.id), false)
      and authz.finance_gate_issue(v_deal.legal_entity_id, v_deal.is_synthetic) is null
      and not exists (select 1 from public.memberships m
                      where m.user_id = (select auth.uid()) and m.legal_entity_id = v_deal.legal_entity_id
                        and m.role_code in ('purchase', 'flight', 'visa') and m.status = 'active');
    if not v_sales then
      return null;
    end if;
  end if;

  select * into r from authz.dues_compute(v_a, v_m, array[]::uuid[], v_syn, v_deal.id, true) c limit 1;
  if r.deal_id is null then
    -- No confirmed version: the Deal is not in dues.
    return null;
  end if;
  v_row := authz.dues_row_json(r.deal_id, r.reference, r.branch_id, r.owner_user_id, r.version_no, r.basis, r.last_approved_at,
    r.newer_pending, r.total, r.money, r.balance, r.overdue, r.due_now, r.next_due_date, r.next_due_open, r.reported,
    r.awaiting, r.credit, r.status, r.cancellation);
  return v_row || jsonb_build_object(
    'instalments', coalesce((
      select jsonb_agg(jsonb_build_object(
          'seq', x.seq, 'label', x.label, 'dueDate', to_char(x.due_date, 'YYYY-MM-DD'),
          'amountPaise', x.amount_paise::text, 'coveredPaise', x.covered::text, 'openPaise', (x.amount_paise - x.covered)::text,
          'status', case when x.amount_paise = x.covered then 'paid' when x.due_date < authz.finance_today() then 'overdue'
                         when x.due_date = authz.finance_today() then 'due_now' else 'upcoming' end,
          'partlyPaid', x.covered > 0 and x.covered < x.amount_paise) order by x.due_date, x.seq)
      from (select i.seq, i.label, i.due_date, i.amount_paise,
              least(i.amount_paise, greatest(greatest(r.money, 0) - coalesce(sum(i.amount_paise) over (
                order by i.due_date, i.seq rows between unbounded preceding and 1 preceding), 0), 0))::bigint as covered
            from public.booking_version_instalments i
            -- Accounts phase 2 (20261204000320): no plan after a cancellation settlement.
            where i.booking_version_id = r.version_id and r.basis <> 'cancelled') x), '[]'::jsonb),
    'tallyInvoices', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'invoiceRef', g.invoice_ref, 'invoiceDate', to_char(g.invoice_date, 'YYYY-MM-DD'),
          'status', g.status, 'rowVersion', g.row_version,
          'tallyStatus', case when g.status = 'withdrawn' then 'not_applicable' else coalesce(tr.status, 'matched') end)
        order by g.invoice_date, g.created_at)
      from public.deal_tally_invoices g
      left join public.tally_records tr on tr.record_kind = 'tally_gst_invoice' and tr.record_id = g.id
      where g.deal_id = v_deal.id), '[]'::jsonb),
    'supplierPayables', case when r.is_a or r.is_m then authz.dues_supplier_payables(v_deal.id) end,
    -- Accounts phase (20261203000260): explicit viewer mode for the Deal money card.
    'viewer', case when r.is_a then 'accounts' when r.is_m then 'manager' else 'sales' end,
    -- Addition to 8.3 (lead OK needed): the caller is Accounts of the Deal's entity (T4 allowed).
    'canAddTallyInvoice', r.is_a,
    -- Accounts phase 2 (20261204000320, 7.2): refunds of the Deal (amounts only; no payee).
    'refunds', jsonb_build_object(
      'live', (select jsonb_build_object('refNo', q.ref_no, 'status', q.status, 'amountPaise', q.amount_paise::text)
               from public.customer_refund_requests q
               where q.deal_id = v_deal.id and (q.status in ('requested', 'returned') or (q.status = 'approved' and q.outcome = 'payout'))
               limit 1),
      'paidPaise', (select coalesce(sum(p.amount_paise), 0)::text from public.customer_refund_payouts p where p.deal_id = v_deal.id),
      'keptAsCreditPaise', (select coalesce(sum(q.amount_paise), 0)::text from public.customer_refund_requests q
                            where q.deal_id = v_deal.id and q.outcome = 'keep_credit' and q.status = 'approved'),
      -- Accounts phase 2 (20261204000370, Addendum L6): "Customer owes after a reversed payment" (included in dueNowPaise).
      'shortfallPaise', greatest(-r.money, 0)::text));
end;
$$;

create or replace function public.deal_refunds(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_deal public.deals%rowtype;
  v_viewer text;
  v_am boolean;
  v_enabled boolean;
  v_held bigint;
  v_total bigint;
  v_c public.deal_cancellations%rowtype;
  v_live boolean;
  v_role text;
begin
  v_viewer := authz.refund_viewer(p_deal_id);
  if v_viewer is null then
    return null;
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  v_am := v_viewer in ('accounts', 'manager');
  v_enabled := authz.refunds_enabled(v_deal.legal_entity_id);
  v_held := authz.refund_money_held(v_deal.id);
  v_total := authz.refund_basis_total(v_deal.id);
  select * into v_c from public.deal_cancellations c where c.deal_id = v_deal.id;
  v_live := exists (select 1 from public.customer_refund_requests r
                    where r.deal_id = v_deal.id and (r.status in ('requested', 'returned') or (r.status = 'approved' and r.outcome = 'payout')));
  v_role := authz.refund_requester_role(v_deal.id);
  return jsonb_build_object(
    'dealId', v_deal.id,
    'dealReference', v_deal.reference,
    'viewer', v_viewer,
    'enabled', v_enabled,
    'heldPaise', v_held::text,
    'cancellation', case when v_c.id is not null then jsonb_build_object('id', v_c.id, 'status', v_c.status) end,
    -- LD11: one combined figure (never per supplier), also for the Sales owner.
    'chargesKeptPaise', case when v_c.id is not null then authz.cancellation_charges_kept(v_c.id)::text end,
    'basisTotalPaise', v_total::text,
    'maxRefundPaise', (case when v_c.status = 'approved' then greatest(v_held, 0)
                            else greatest(v_held - coalesce(v_total, v_held), 0) end)::text,
    'canRequest', v_enabled and v_role is not null and not v_live and v_held >= 0
                  and (v_c.status is not distinct from 'approved' or (v_total is not null and v_held > v_total)),
    'payers', coalesce((
      select jsonb_agg(jsonb_build_object('receiptId', r.id, 'receiptNo', r.receipt_no, 'payerName', r.payer_name,
          'amountPaise', r.amount_paise::text) order by r.received_on, r.receipt_no)
      from public.customer_receipts r where r.deal_id = v_deal.id and r.status in ('verified', 'cleared')), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', q.id, 'refNo', q.ref_no, 'kind', q.kind, 'outcome', q.outcome, 'status', q.status,
          'customerChargePaise', q.customer_charge_paise::text, 'amountPaise', q.amount_paise::text,
          'heldAtRequestPaise', q.held_at_request_paise::text,
          'payeeKind', q.payee_kind, 'payeeName', q.payee_name, 'payeeReason', q.payee_reason, 'payeeReceiptId', q.payee_receipt_id,
          'reason', q.reason, 'requestedByName', rp.display_name, 'requestedAt', q.requested_at, 'requestedAs', q.requested_as,
          'decidedByName', dp.display_name, 'decidedAt', q.decided_at, 'returnReason', q.return_reason,
          'withdrawnByName', wp.display_name, 'withdrawnAt', q.withdrawn_at, 'withdrawReason', q.withdraw_reason,
          'rowVersion', q.row_version,
          'payout', case when p.id is not null then jsonb_build_object('mode', p.mode, 'paidOn', to_char(p.paid_on, 'YYYY-MM-DD'),
              'reference', case when v_am then p.reference end, 'evidenceId', case when v_am then p.evidence_id end,
              'recordedByName', pp.display_name) end,
          'creditNote', (select jsonb_build_object('documentId', cn.id, 'number', cn.number, 'status', cn.status)
                         from public.customer_documents cn
                         where cn.refund_request_id = q.id and cn.kind = 'credit_note' and cn.status <> 'discarded'
                           and (v_viewer = 'accounts' or cn.status in ('released', 'replaced', 'cancelled'))
                         order by cn.created_at desc, cn.id desc limit 1),
          'can', jsonb_build_object(
            'resubmit', v_enabled and q.status = 'returned' and q.requested_by = v_uid and v_role is not null,
            'withdraw', case
              when q.status in ('requested', 'returned') then q.requested_by = v_uid
              when q.status = 'approved' and q.outcome = 'payout' then authz.refund_is_m(q.deal_id)
                   or (q.decided_by = v_uid and authz.refund_entity_manager(q.legal_entity_id))
              else false end,
            'approve', v_enabled and q.status = 'requested' and q.requested_by <> v_uid and authz.refund_decider(q.id),
            'return', v_enabled and q.status = 'requested' and q.requested_by <> v_uid and authz.refund_decider(q.id),
            'payout', v_enabled and v_viewer = 'accounts' and q.status = 'approved' and q.outcome = 'payout'
                      and q.requested_by <> v_uid and q.decided_by is distinct from v_uid
                      and not authz.holds_role('purchase', q.legal_entity_id)))
        order by q.requested_at desc, q.id desc)
      from public.customer_refund_requests q
      left join public.customer_refund_payouts p on p.refund_request_id = q.id
      left join public.staff_profiles rp on rp.user_id = q.requested_by
      left join public.staff_profiles dp on dp.user_id = q.decided_by
      left join public.staff_profiles wp on wp.user_id = q.withdrawn_by
      left join public.staff_profiles pp on pp.user_id = p.recorded_by
      where q.deal_id = v_deal.id), '[]'::jsonb))
  || case when v_am then jsonb_build_object('supplierRefunds', coalesce((
      select jsonb_agg(jsonb_build_object(
          'sourceKind', s.source_kind, 'sourceId', s.source_id, 'cancellationId', s.cancellation_id,
          'supplierId', s.supplier_id, 'supplierName', sp.name, 'taskId', s.task_id,
          'expectedPaise', s.expected_paise::text, 'receivedPaise', s.received_paise::text,
          'canRecord', v_viewer = 'accounts' and v_c.status = 'approved' and s.expected_paise > 0,
          'receipts', coalesce((
            select jsonb_agg(jsonb_build_object('id', x.id, 'amountPaise', x.amount_paise::text,
                'receivedOn', to_char(x.received_on, 'YYYY-MM-DD'), 'mode', x.mode, 'reference', x.reference,
                'evidenceId', x.evidence_id, 'status', x.status, 'rowVersion', x.row_version,
                'recordedByName', xp.display_name, 'rejectReason', x.reject_reason,
                'canCancel', v_viewer = 'accounts' and x.status = 'verified') order by x.recorded_at, x.id)
            from public.supplier_refund_receipts x
            left join public.staff_profiles xp on xp.user_id = x.recorded_by
            where x.deal_id = v_deal.id and x.source_kind = s.source_kind and x.source_group_id = s.source_group_id), '[]'::jsonb))
        order by s.source_kind, sp.name nulls last, s.source_id)
      from authz.supplier_refund_sources(v_deal.id) s
      left join public.suppliers sp on sp.id = s.supplier_id), '[]'::jsonb))
     else '{}'::jsonb end;
end;
$$;

-- Addendum L6: a receipt reversal that leaves money held below zero on a Deal
-- with a paid-out refund tells the Accounts exception owner and the Sales
-- owner (SO*) at once. Kind 'refund_shortfall' (urgent) is added to the notice
-- registry by Track D; until it exists nothing is written (never blocks the reversal).
create function authz.notices_on_refund_shortfall() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  e public.finance_journal_entries%rowtype;
  v_held bigint;
begin
  if new.account <> 'customer_advances' or new.debit_paise = 0 or new.deal_id is null
     or not ('refund_shortfall' = any (authz.notice_kinds())) then
    return null;
  end if;
  select * into e from public.finance_journal_entries j where j.id = new.entry_id;
  if e.kind not like 'reversal%' or not exists (select 1 from public.customer_refund_payouts p where p.deal_id = new.deal_id) then
    return null;
  end if;
  v_held := authz.refund_money_held(new.deal_id);
  if v_held >= 0 then
    return null;
  end if;
  perform authz.notice_write('refund_shortfall',
    array(select authz.acct_exception_owner(e.legal_entity_id)
          union select u from authz.notice_so_star_recipients(new.deal_id) u),
    e.legal_entity_id, (select d.branch_id from public.deals d where d.id = new.deal_id), new.deal_id, null,
    'deal', new.deal_id, '{}'::jsonb, 'refund_shortfall:' || e.id::text, null);
  return null;
end;
$$;
create trigger finance_journal_lines_refund_shortfall after insert on public.finance_journal_lines
  for each row execute function authz.notices_on_refund_shortfall();
revoke all on function authz.notices_on_refund_shortfall() from public, anon, authenticated, service_role;


commit;
