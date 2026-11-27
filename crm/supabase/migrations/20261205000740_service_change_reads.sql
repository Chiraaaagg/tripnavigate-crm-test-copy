-- TripNavigate CRM - Accounts phase 3, track H (5 of 5): a closed task is
-- not open work; the reads of adding and removing services.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 11.1, 11.3, 14
-- (fences), 17.4, 19, 20 R12, 21 LD30, LD31.
--
-- New internal helpers (no grant):
--   authz.cr_charge_json(p_change_request, p_task): the latest Purchase charge
--     of a task keyed by a removal request (the shape of
--     authz.cancellation_charge_json).
--   authz.cr_visa_cancellation_json(p_task): the Visa fee panel of a booked
--     Visa service being removed (the shape of visa_workspace().cancellation,
--     + changeRequestId, cancellationId null).
-- New read (security definer, session first, execute to authenticated):
--   R-H1 public.service_removal_charges(p_change_request_id) - branch Manager
--     (and the LD37 Approver) and Accounts of the Deal (section 14 "Removal
--     charges": A read, M approve): per thing charged - department, label,
--     supplier, cost, supplier keeps, refund expected, who entered it,
--     complete - with the totals and the customer charge. Null for everyone
--     else (Sales owner, Purchase, Flight, Visa, other entities).
-- Replaced (latest bodies, same signatures; changed lines marked
-- "Accounts phase 3 (20261205000740)"):
--   authz.deal_committed (20261202000200), public.purchase_task_list
--     (20261130000120), public.purchase_home_counts (20261203000450),
--     public.flight_home_counts (20261201000190), public.visa_home_counts
--     (20261202000140): a closed task is not open work (R12). Visa fee rows of
--     a closed task still count (money housekeeping).
--   authz.task_cancellation_json (20261130000120): additive changeRequestId;
--     without a trip cancellation the removal of the booked service (Purchase
--     panel; no send step; no customer charge).
--   public.flight_money (20261204000370): additive changeRequestId on the
--     per-batch cancellation; a batch of a service being removed shows its
--     charge keyed by the request; no new payment on a closed cost task.
--   public.visa_workspace (20261204000370): additive changeRequestId; the fee
--     refund panel of a Visa service being removed.
--   public.deal_change_requests (20261205000660, track G): additive keys
--     removalRoute, customerChargePaise, charges [{department, enteredByName,
--     complete}] per request; addableTypes (the service types the caller may
--     add now, [] when not), and - not in the contract, reported -
--     serviceChangesEnabled, serviceBlockedBy (why adding or removing is not possible) and removable
--     [{itemId, itemNo, serviceTitle, department, route}].
--
-- Rollback (forward-only): a NEW migration restoring the cited bodies and
-- revoking the new read.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Helpers
-- ===========================================================================

create function authz.cr_charge_json(p_change_request uuid, p_task uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'taskId', x.task_id,
    'revisionNo', x.revision_no,
    'supplierId', x.supplier_id,
    'supplierName', s.name,
    'committedCostPaise', x.committed_cost_paise::text,
    'supplierKeepsPaise', x.supplier_keeps_paise::text,
    'supplierRefundPaise', x.supplier_refund_paise::text,
    'note', x.note,
    'creditNoteEvidenceId', x.credit_note_evidence_id,
    'enteredAt', x.entered_at,
    'enteredByName', p.display_name)
  from public.purchase_cancellation_charges x
  join public.suppliers s on s.id = x.supplier_id
  left join public.staff_profiles p on p.user_id = x.entered_by
  where x.change_request_id = p_change_request and x.task_id = p_task
  order by x.revision_no desc limit 1
$$;

create function authz.cr_visa_cancellation_json(p_task uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'changeRequestId', r.id,
    'cancellationId', null,
    'status', case when r.status in ('approved', 'submitted', 'applied') then 'approved'
                   when exists (select 1 from public.visa_cancellation_fees y where y.change_request_id = r.id and y.task_id = t.id)
                     then 'charges_entered' else 'open' end,
    'approved', r.status in ('approved', 'submitted', 'applied'),
    'fees', (select coalesce(jsonb_agg(jsonb_build_object(
        'entryId', c.id, 'applicationId', c.application_id, 'costKind', c.cost_kind, 'amountPaise', c.amount_paise::text,
        'refundExpectedPaise', f.refund_expected_paise::text, 'revisionNo', coalesce(f.revision_no, 0),
        'canSet', authz.visa_can_manage_fees(t.id)) order by c.created_at, c.id), '[]'::jsonb)
      from public.department_cost_entries c
      left join lateral (select x.refund_expected_paise, x.revision_no from public.visa_cancellation_fees x
                         where x.entry_id = c.id and x.change_request_id = r.id
                         order by x.revision_no desc limit 1) f on true
      where c.task_id = t.id and c.paid_by = 'company'))
  from public.fulfilment_tasks t
  join lateral (select q.* from public.booking_change_requests q
                where q.deal_id = t.deal_id and q.kind = 'remove_service' and q.removal_route = 'cancellation'
                  and t.service_item_id = any (q.item_ids) and q.status in ('requested', 'returned', 'approved', 'submitted', 'applied')
                order by q.requested_at desc, q.id desc limit 1) r on true
  where t.id = p_task
$$;

-- ===========================================================================
-- 2. A closed task is not open work (11.1, R12)
-- ===========================================================================

-- Replaces 20261202000200_visa_booking_form.sql:351 (latest body; changed lines marked).
create or replace function authz.deal_committed(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.fulfilment_tasks t
                 where t.deal_id = p_deal and t.status in ('supplier_confirmed', 'completed')
                   and t.department <> 'visa'  -- Visa build (20261202000200)
                   and t.closed_state is null)  -- Accounts phase 3 (20261205000740): a removed service is not open work
$$;

-- Replaces 20261130000120_purchase_workflow_reads.sql:239 (latest body; changed lines marked).
create or replace function public.purchase_task_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(authz.purchase_task_json(t.id, false)
      -- Purchase build: computed go-ahead state and the trip cancellation flag (no amounts).
      || jsonb_build_object('goAheadState', authz.purchase_go_ahead_state(t.id),
                            'tripCancelled', authz.deal_trip_cancelled(t.deal_id))
      order by t.created_at desc, t.id)
    from public.fulfilment_tasks t
    where t.closed_state is null  -- Accounts phase 3 (20261205000740): a removed service is not open work
      and authz.can_read_purchase_task(t.id)
  ), '[]'::jsonb);
end;
$$;

-- Replaces 20261203000450_notices_review_fixes.sql:294 (latest body; changed lines marked).
create or replace function public.purchase_home_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_count integer;
  v_oldest uuid;
begin
  if not coalesce(authz.session_ok(), false) or not exists (
       select 1 from public.memberships m
       where m.user_id = v_uid and m.role_code = 'purchase' and m.status = 'active'
         and authz.holds_active_role('purchase', m.legal_entity_id)) then
    return null;
  end if;
  with changed as (
    select t.id, v.confirmed_at
    from public.fulfilment_tasks t
    join public.purchase_task_basis b on b.task_id = t.id
    join public.booking_versions v on v.id = authz.task_current_version(t.id)
    where t.assignee_user_id = v_uid and t.department = 'purchase' and t.status = 'in_progress'
      and t.closed_state is null  -- Accounts phase 3 (20261205000740)
      and authz.holds_active_role('purchase', t.legal_entity_id)
      and b.basis_version_id <> v.id
      -- 20261203000450: the same rule as the banner (changed item, non-empty diff).
      and authz.purchase_booking_diff(t.id) is not null)
  select count(*)::integer, (select c.id from changed c order by c.confirmed_at nulls last, c.id limit 1)
  into v_count, v_oldest from changed;
  return jsonb_build_object('purchaseBookingChanged', v_count, 'purchaseBookingChangedTaskId', v_oldest);
end;
$$;

-- Replaces 20261201000190_flight_traveller_name_fill.sql:393 (latest body; changed lines marked).
create or replace function public.flight_home_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_f boolean;
  v_sales boolean;
  v_manager boolean;
  v_mine uuid[];
  v_decide uuid[] := '{}'::uuid[];
  v_decide_deals uuid[] := '{}'::uuid[];
  v_name_deals uuid[] := '{}'::uuid[];
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select bool_or(m.role_code = 'flight'), bool_or(m.role_code = 'sales'), bool_or(m.role_code = 'manager')
  into v_f, v_sales, v_manager
  from public.memberships m
  join public.legal_entities e on e.id = m.legal_entity_id and e.status = 'enabled'
  join public.branches b on b.id = m.branch_id and b.status = 'enabled'
  where m.user_id = v_uid and m.status = 'active';
  v_f := coalesce(v_f, false);
  v_sales := coalesce(v_sales, false);
  v_manager := coalesce(v_manager, false);
  if v_f then
    select coalesce(array_agg(distinct t.deal_id), '{}'::uuid[]) into v_mine
    from public.fulfilment_tasks t join public.deals d on d.id = t.deal_id
    where t.department = 'flight' and t.status = 'in_progress' and t.assignee_user_id = v_uid and d.removed_at is null
      and t.closed_state is null  -- Accounts phase 3 (20261205000740): a removed service is not open work
      and authz.holds_active_role('flight', t.legal_entity_id);
  end if;
  if v_sales or v_manager then
    select coalesce(array_agg(c.id), '{}'::uuid[]), coalesce(array_agg(c.deal_id), '{}'::uuid[])
    into v_decide, v_decide_deals
    from public.flight_changes c join public.deals d on d.id = c.deal_id
    where c.status = 'pending' and c.decider_kind <> 'flight_owner' and d.removed_at is null
      and c.requested_by is distinct from v_uid and authz.flight_can_decide_change(c.id);
  end if;
  if v_sales then
    select coalesce(array_agg(d.id), '{}'::uuid[]) into v_name_deals
    from public.deals d
    where d.owner_user_id = v_uid and d.removed_at is null and authz.flight_is_sales_owner(d.id)
      and exists (select 1 from public.fulfilment_tasks t
                  where t.deal_id = d.id and t.department = 'flight' and t.status <> 'completed' and t.closed_state is null  -- Accounts phase 3 (20261205000740)
                    and authz.flight_unnamed_count(t.id) > 0);
  end if;
  return jsonb_build_object(
    'flightDealsNotTaken', case when v_f then (
        select count(*)::integer from public.deals d
        where d.removed_at is null and authz.holds_active_role('flight', d.legal_entity_id)
          and exists (select 1 from public.fulfilment_tasks t where t.deal_id = d.id and t.department = 'flight' and t.status = 'not_started'
                        and t.closed_state is null)  -- Accounts phase 3 (20261205000740)
          and not exists (select 1 from public.fulfilment_tasks t
                          where t.deal_id = d.id and t.department = 'flight' and t.status in ('in_progress', 'completed')
                            and t.closed_state is null)) end,  -- Accounts phase 3 (20261205000740)
    'flightDealsMine', case when v_f then cardinality(v_mine) end,
    'flightBookingChanged', case when v_f then (
        select count(distinct t.deal_id)::integer from public.fulfilment_tasks t join public.flight_task_state s on s.task_id = t.id
        where t.deal_id = any (v_mine) and t.department = 'flight' and t.status = 'in_progress' and t.closed_state is null  -- Accounts phase 3 (20261205000740)
          and s.basis_version_id <> authz.task_current_version(t.id)) end,
    'flightChangesDecided', case when v_f then (
        select count(*)::integer from public.flight_changes c join public.fulfilment_tasks t on t.id = c.task_id
        where t.assignee_user_id = v_uid and t.status in ('in_progress', 'completed') and t.closed_state is null  -- Accounts phase 3 (20261205000740)
          and c.status in ('approved', 'rejected') and c.flight_seen_at is null
          and authz.holds_active_role('flight', t.legal_entity_id)) end,
    -- 20261201000190 (R3): travellers Sales named after the booking who have no ticket yet on the caller's flights.
    'flightTravellersNamed', case when v_f then (
        select count(*)::integer from public.deal_traveller_fills x
        where x.deal_id = any (v_mine)
          and not exists (select 1 from public.flight_ticket_revisions r
                          where r.deal_id = x.deal_id and r.traveller_seq = x.traveller_seq)) end,
    'flightReadyToFinish', case when v_f then (
        select count(*)::integer from unnest(v_mine) dm(id)
        where authz.flight_can_work(dm.id) and cardinality(authz.flight_done_issues(dm.id)) = 0) end,
    'salesFlightChangesToDecide', case when v_sales or v_manager then cardinality(v_decide) end,
    -- 20261201000180: the Deal when exactly one Deal feeds the row (Home links straight to it), else null.
    'salesFlightChangesToDecideDealId', case when (v_sales or v_manager)
                                                  and (select count(distinct x) from unnest(v_decide_deals) x) = 1
                                             then v_decide_deals[1] end,
    'salesTravellersToName', case when v_sales then cardinality(v_name_deals) end,
    'salesTravellersToNameDealId', case when v_sales and cardinality(v_name_deals) = 1 then v_name_deals[1] end);
end;
$$;

-- Replaces 20261202000140_visa_review_fixes.sql:1295 (latest body; changed lines marked).
create or replace function public.visa_home_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_visa boolean;
  v_sales boolean;
  v_mine uuid[];
  v_waiting uuid[];
  v_handover uuid[];
  v_returned uuid[];
  v_noreceipt uuid[];
  v_changed uuid[];
  v_notice_deals uuid[];
  v_fee_tasks uuid[];
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- SO* rows only for Sales / Manager people without a department role (who read Deals with the full scope).
  select coalesce(bool_or(m.role_code = 'visa'), false),
         coalesce(bool_or(m.role_code in ('sales', 'manager')), false)
           and not coalesce(bool_or(m.role_code in ('purchase', 'flight', 'visa')), false)
  into v_visa, v_sales
  from public.memberships m
  join public.legal_entities e on e.id = m.legal_entity_id and e.status = 'enabled'
  join public.branches b on b.id = m.branch_id and b.status = 'enabled'
  where m.user_id = v_uid and m.status = 'active';
  if v_visa then
    select coalesce(array_agg(t.id order by t.created_at, t.id), '{}') into v_mine
    from public.fulfilment_tasks t join public.deals d on d.id = t.deal_id
    where t.department = 'visa' and t.status = 'in_progress' and t.assignee_user_id = v_uid and d.removed_at is null
      and t.closed_state is null  -- Accounts phase 3 (20261205000740): a removed service is not open work (its fee rows still count below)
      and authz.holds_active_role('visa', t.legal_entity_id);
    -- 20261202000140 (finding 1): fee rows also count my completed tasks.
    select coalesce(array_agg(t.id order by t.created_at, t.id), '{}') into v_fee_tasks
    from public.fulfilment_tasks t join public.deals d on d.id = t.deal_id
    where t.department = 'visa' and t.status in ('in_progress', 'completed') and t.assignee_user_id = v_uid
      and d.removed_at is null and authz.holds_active_role('visa', t.legal_entity_id);
    -- One task id per matching row, in task order (first = link target).
    select coalesce(array_agg(a.task_id order by array_position(v_mine, a.task_id), a.id), '{}') into v_waiting
    from public.visa_applications a
    where a.task_id = any (v_mine) and a.superseded_at is null and a.closed_at is null and a.state in ('submitted', 'decision_pending');
    select coalesce(array_agg(a.task_id order by array_position(v_mine, a.task_id), a.id), '{}') into v_handover
    from public.visa_applications a
    where a.task_id = any (v_mine) and a.superseded_at is null and a.closed_at is null and a.state in ('issued', 'refused');
    select coalesce(array_agg(c.task_id order by array_position(v_fee_tasks, c.task_id), c.id), '{}') into v_returned
    from public.department_cost_entries c where c.task_id = any (v_fee_tasks) and c.expense_status = 'returned';
    select coalesce(array_agg(c.task_id order by array_position(v_fee_tasks, c.task_id), c.id), '{}') into v_noreceipt
    from public.department_cost_entries c
    where c.task_id = any (v_fee_tasks) and c.paid_by = 'company' and c.expense_status = 'draft' and not authz.expense_receipt_ok(c.id);
    select coalesce(array_agg(a.task_id order by array_position(v_mine, a.task_id), a.id), '{}') into v_changed
    from public.visa_applications a where a.task_id = any (v_mine) and authz.visa_traveller_changed(a);
  end if;
  if v_sales then
    select coalesce(array_agg(n.deal_id order by n.created_at desc, n.id), '{}') into v_notice_deals
    from public.visa_result_notices n join public.deals d on d.id = n.deal_id
    where n.seen_at is null and d.removed_at is null and authz.visa_notice_reader(n.deal_id);
  end if;
  return jsonb_build_object(
    'visaApplicantsWaitingResult', case when v_visa then cardinality(v_waiting) end,
    'visaApplicantsWaitingResultTaskId', case when v_visa then v_waiting[1] end,
    'visaHandoverPending', case when v_visa then cardinality(v_handover) end,
    'visaHandoverPendingTaskId', case when v_visa then v_handover[1] end,
    'visaFeesReturned', case when v_visa then cardinality(v_returned) end,
    'visaFeesReturnedTaskId', case when v_visa then v_returned[1] end,
    'visaFeesWithoutReceipt', case when v_visa then cardinality(v_noreceipt) end,
    'visaFeesWithoutReceiptTaskId', case when v_visa then v_noreceipt[1] end,
    'visaTravellerChanged', case when v_visa then cardinality(v_changed) end,
    'visaTravellerChangedTaskId', case when v_visa then v_changed[1] end,
    'salesVisaResultsToSee', case when v_sales then cardinality(v_notice_deals) end,
    'salesVisaResultsDealId', case when v_sales then v_notice_deals[1] end);
end;
$$;

-- ===========================================================================
-- 3. Department panels of a booked service being removed (11.3)
-- ===========================================================================

-- Replaces 20261130000120_purchase_workflow_reads.sql:77 (lines marked).
create or replace function authz.task_cancellation_json(p_task uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((
  select jsonb_build_object(
      'cancellationId', c.id,
      'status', c.status,
      'reason', c.reason,
      'openedAt', c.opened_at,
      'openedByName', op.display_name,
      'rowVersion', c.row_version,
      'returnReason', c.return_reason,
      'myCharge', authz.cancellation_charge_json(c.id, t.id),
      'canEnter', c.status <> 'approved' and t.department = 'purchase'
        and authz.holds_active_role('purchase', t.legal_entity_id)
        and (t.assignee_user_id is null or t.assignee_user_id = (select auth.uid()))
        and exists (select 1 from public.purchase_cost_versions v where v.task_id = t.id),
      'canSend', c.status in ('open', 'charges_entered')
        and authz.holds_active_role('purchase', c.legal_entity_id)
        and authz.cancellation_charges_missing(c.id) = 0,
      'chargesMissing', authz.cancellation_charges_missing(c.id))
    from public.fulfilment_tasks t
    join public.deal_cancellations c on c.deal_id = t.deal_id
    left join public.staff_profiles op on op.user_id = c.opened_by
    where t.id = p_task
  -- Accounts phase 3 (20261205000740): additive changeRequestId (null for a trip cancellation).
  ) || jsonb_build_object('changeRequestId', null), (
  -- Accounts phase 3 (20261205000740): without a trip cancellation, the removal of this booked
  -- service (route cancellation) keyed by its request: the same panel, no send step,
  -- never the customer charge (Purchase never sees selling data).
  select jsonb_build_object(
    'cancellationId', null,
    'changeRequestId', r.id,
    'status', case when r.status in ('approved', 'submitted', 'applied') then 'approved'
                   when x.id is not null then 'charges_entered' else 'open' end,
    'reason', r.reason,
    'openedAt', r.requested_at,
    'openedByName', op.display_name,
    'rowVersion', r.row_version,
    'returnReason', null,
    'myCharge', authz.cr_charge_json(r.id, t.id),
    'canEnter', r.status in ('requested', 'returned') and t.department = 'purchase' and t.closed_state is null
      and authz.holds_active_role('purchase', t.legal_entity_id)
      and (t.assignee_user_id is null or t.assignee_user_id = (select auth.uid()))
      and exists (select 1 from public.purchase_cost_versions v where v.task_id = t.id),
    'canSend', false,
    'chargesMissing', (select count(*)::integer from authz.cr_removal_charges(r.id) c where c.department = 'purchase' and not c.complete))
  from public.fulfilment_tasks t
  join lateral (select q.* from public.booking_change_requests q
                where q.deal_id = t.deal_id and q.kind = 'remove_service' and q.removal_route = 'cancellation'
                  and t.service_item_id = any (q.item_ids) and q.status in ('requested', 'returned', 'approved', 'submitted', 'applied')
                order by q.requested_at desc, q.id desc limit 1) r on true
  left join lateral (select y.id from public.purchase_cancellation_charges y
                     where y.change_request_id = r.id and y.task_id = t.id limit 1) x on true
  left join public.staff_profiles op on op.user_id = r.requested_by
  where t.id = p_task))
$$;

-- Replaces 20261204000370_refund_followups.sql:181 (latest body; changed lines marked).
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
          'changeRequestId', null,  -- Accounts phase 3 (20261205000740)
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
        -- Accounts phase 3 (20261205000740): a booked Flight service being removed (11.3) - the
        -- same per-batch charge, keyed by the remove_service request (F, M, A).
        || case when v_full and v_c.id is null and bcr.id is not null then jsonb_build_object('cancellation', jsonb_build_object(
          'changeRequestId', bcr.id,
          'state', case when bcr.status in ('approved', 'submitted', 'applied') then 'approved' else 'open' end,
          'revisionNo', coalesce(cfc.revision_no, 0),
          'airlineChargePaise', cfc.airline_charge_paise::text,
          'refundExpectedPaise', cfc.refund_expected_paise::text,
          'refundReportedPaise', cfc.refund_reported_paise::text,
          'note', cfc.note,
          'supplierRefundReceivedPaise', (select coalesce(sum(s2.amount_paise), 0)::text from public.supplier_refund_receipts s2
                                          where s2.source_kind = 'flight_charge' and s2.source_group_id = b.id and s2.status = 'verified'),
          'canEnter', bcr.status in ('requested', 'returned', 'approved', 'submitted')
                      and (authz.flight_owns_task(b.cost_task_id)
                           or (bct.assignee_user_id is null and authz.holds_active_role('flight', bct.legal_entity_id)))))
                else '{}'::jsonb end
        || case when v_full then jsonb_build_object(
          'routePreview', case when rt.total + authz.flight_batch_due(b.id) <= 5000000 then 'direct' else 'manager' end)
                else '{}'::jsonb end
        -- Actions: the Flight person only.
        || case when v_fa then jsonb_build_object(
          'canPayDirect', authz.flight_owns_task(b.cost_task_id) and not v_cancelled and authz.flight_batch_due(b.id) > 0
                          and bct.closed_state is null  -- Accounts phase 3 (20261205000740): a removed service takes no new payment
                          and x.state in ('unpaid', 'direct_returned', 'request_returned', 'request_cancelled')
                          and rt.total + authz.flight_batch_due(b.id) <= 5000000,
          'canRequest', authz.flight_owns_task(b.cost_task_id) and not v_cancelled and authz.flight_batch_due(b.id) > 0
                        and bct.closed_state is null  -- Accounts phase 3 (20261205000740)
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
      -- Accounts phase 3 (20261205000740): the batch's cost task and the removal request covering the batch.
      join public.fulfilment_tasks bct on bct.id = b.cost_task_id
      left join lateral (select q.* from public.booking_change_requests q
                         where q.deal_id = b.deal_id and q.kind = 'remove_service' and q.removal_route = 'cancellation'
                           and q.status in ('requested', 'returned', 'approved', 'submitted', 'applied')
                           and (bct.service_item_id = any (q.item_ids)
                                or exists (select 1 from public.flight_sectors fs
                                           where fs.id = any (b.sector_ids) and fs.service_item_id = any (q.item_ids)))
                         order by q.requested_at desc, q.id desc limit 1) bcr on true
      left join lateral (select y.* from public.flight_cancellation_charges y
                         where y.batch_id = b.id and y.change_request_id = bcr.id
                         order by y.revision_no desc limit 1) cfc on true
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

-- Replaces 20261204000370_refund_followups.sql:393 (latest body; changed lines marked).
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
    'cancellation', case when v_c.id is null then authz.cr_visa_cancellation_json(v_task.id) else jsonb_build_object(
      'changeRequestId', null,  -- Accounts phase 3 (20261205000740): additive; the removal of a booked Visa service otherwise
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

-- ===========================================================================
-- 4. R-G1 additive keys (11.3) and R-H1
-- ===========================================================================

-- Replaces 20261205000660_change_reads.sql:57 (latest body; changed lines marked).
create or replace function public.deal_change_requests(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_viewer text;
  v_am boolean;
  v_deal public.deals%rowtype;
  v_base public.booking_versions%rowtype;
  v_blocked text[] := '{}'::text[];
  v_role text;
  v_is_m boolean;
  v_is_so boolean;
  v_service_blocked text[] := '{}'::text[];  -- Accounts phase 3 (20261205000740)
  v_service_ok boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  v_viewer := authz.cr_viewer(p_deal_id);
  if v_viewer is null then
    return null;
  end if;
  v_am := v_viewer in ('accounts', 'manager');
  select * into v_deal from public.deals d where d.id = p_deal_id;
  select * into v_base from public.booking_versions v
  where v.deal_id = v_deal.id and v.status = 'confirmed' order by v.version_no desc limit 1;
  v_role := case when v_viewer in ('sales', 'manager') then authz.cr_requester_role(v_deal.id) end;
  v_is_m := authz.refund_is_m(v_deal.id);
  v_is_so := authz.refund_is_so(v_deal.id);
  if not authz.booking_changes_enabled() then
    v_blocked := array_append(v_blocked, 'changes_off');
  end if;
  if v_base.id is not null and v_base.service_type <> 'package' then
    v_blocked := array_append(v_blocked, 'change_not_supported');
  end if;
  if v_base.id is null or not authz.deal_committed(v_deal.id) then
    v_blocked := array_append(v_blocked, 'not_committed');
  end if;
  if authz.deal_trip_cancelled(v_deal.id) then
    v_blocked := array_append(v_blocked, 'trip_cancelled');
  end if;
  if exists (select 1 from public.customer_refund_requests r
             where r.deal_id = v_deal.id
               and (r.status in ('requested', 'returned') or (r.status = 'approved' and r.outcome = 'payout'))) then
    v_blocked := array_append(v_blocked, 'refund_open');
  end if;
  if authz.deal_change_open(v_deal.id) then
    v_blocked := array_append(v_blocked, 'change_open');
  end if;
  -- Accounts phase 3 (20261205000740): why a service cannot be added or removed now (11.1).
  v_service_blocked := array_remove(array[
    case when not authz.service_changes_enabled() then 'service_changes_off' end,
    case when v_base.id is not null and v_base.service_type <> 'package' then 'change_not_supported' end,
    case when v_base.id is null then 'not_submitted' end,
    case when 'trip_cancelled' = any (v_blocked) then 'trip_cancelled' end,
    case when 'refund_open' = any (v_blocked) then 'refund_open' end,
    case when 'change_open' = any (v_blocked) then 'change_open' end,
    case when exists (select 1 from public.booking_versions v where v.revises_version_id = v_base.id and v.status = 'draft')
      then 'revision_open' end], null);
  v_service_ok := v_role is not null and cardinality(v_service_blocked) = 0;

  return jsonb_build_object(
    'dealId', v_deal.id,
    'enabled', authz.booking_changes_enabled(),
    'canRequest', v_role is not null and cardinality(v_blocked) = 0,
    'blockedBy', to_jsonb(v_blocked),
    -- Accounts phase 3 (20261205000740): additive - adding or removing a service (11.1-11.3).
    'serviceChangesEnabled', authz.service_changes_enabled(),
    'serviceBlockedBy', to_jsonb(v_service_blocked),
    'addableTypes', case when v_service_ok then '["hotel", "transfer", "activity", "flight", "visa", "passport"]'::jsonb
                         else '[]'::jsonb end,
    'removable', case when v_service_ok and (select count(*) from public.service_item_facts f where f.booking_version_id = v_base.id) > 1
      then coalesce((
        select jsonb_agg(jsonb_build_object(
            'itemId', i.id, 'itemNo', i.item_no,
            'serviceTitle', coalesce(authz.service_item_title(i.service_type, f.facts), 'Service'),
            'department', i.department, 'route', authz.cr_removal_route(i.id))
          order by i.item_no)
        from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
        where f.booking_version_id = v_base.id), '[]'::jsonb)
      else '[]'::jsonb end,
    'confirmed', coalesce((
      select jsonb_agg(jsonb_build_object(
          'itemId', i.id, 'itemNo', i.item_no,
          'serviceTitle', coalesce(authz.service_item_title(i.service_type, f.facts), 'Service'),
          'department', t.department, 'taskStatus', t.status,
          'supplierName', case when v_am then s.name end,
          'reference', case when v_am then t.supplier_reference end)
        order by i.item_no)
      from public.service_item_facts f
      join public.service_items i on i.id = f.service_item_id
      join public.fulfilment_tasks t on t.service_item_id = i.id and t.deal_id = v_deal.id
      left join public.purchase_quotes q on q.id = t.selected_quote_id
      left join public.suppliers s on s.id = q.supplier_id
      where f.booking_version_id = v_base.id and t.status in ('supplier_confirmed', 'completed')), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', r.id, 'refNo', r.ref_no, 'kind', r.kind, 'status', r.status,
          'itemNos', coalesce((select jsonb_agg(i.item_no order by i.item_no) from public.service_items i where i.id = any (r.item_ids)),
                              '[]'::jsonb),
          'changeSummary', r.change_summary, 'reason', r.reason,
          'requestedByName', rp.display_name, 'requestedAt', r.requested_at,
          'decidedByName', dp.display_name, 'decidedAt', r.decided_at, 'returnReason', r.return_reason,
          'changeVersionId', r.change_version_id,
          'reconfirmations', coalesce((
            select jsonb_agg(jsonb_build_object(
                'taskId', x.task_id,
                'serviceTitle', coalesce(authz.service_item_title(xi.service_type, xf.facts), 'Service'),
                'status', x.status, 'overBudget', x.over_budget, 'refusedReason', x.refused_reason)
              order by xi.item_no)
            from public.task_reconfirmations x
            join public.fulfilment_tasks xt on xt.id = x.task_id
            join public.service_items xi on xi.id = xt.service_item_id
            left join public.service_item_facts xf on xf.service_item_id = xi.id and xf.booking_version_id = x.booking_version_id
            where x.change_request_id = r.id), '[]'::jsonb),
          'closeReason', r.close_reason, 'rowVersion', r.row_version,
          -- Accounts phase 3 (20261205000740): additive - the route and customer charge of a removal
          -- (the Sales owner sees the customer charge, never supplier amounts) and
          -- per department whether the supplier charges are entered.
          'removalRoute', r.removal_route,
          'customerChargePaise', r.customer_charge_paise::text,
          'charges', case when r.kind = 'remove_service' and r.removal_route = 'cancellation' then coalesce((
            select jsonb_agg(jsonb_build_object('department', g.department, 'enteredByName', g.entered_by_name, 'complete', g.complete)
              order by g.department)
            from (select c.department, bool_and(c.complete) as complete,
                    (select p.display_name from public.staff_profiles p
                     where p.user_id = (array_agg(c.entered_by order by c.entered_at desc nulls last))[1]) as entered_by_name
                  from authz.cr_removal_charges(r.id) c group by c.department) g), '[]'::jsonb)
            else '[]'::jsonb end,
          'can', jsonb_build_object(
            'resubmit', r.status = 'returned' and r.requested_by = v_uid and v_role is not null,
            'withdraw', r.status in ('requested', 'returned', 'approved', 'submitted')
                        and ((r.requested_by = v_uid and v_role is not null) or v_is_m),
            'openVersion', r.status = 'approved' and r.change_version_id is null
                           and ((r.requested_by = v_uid and v_role is not null) or v_is_so),
            'submit', r.status = 'approved' and r.change_version_id is not null
                      and ((r.requested_by = v_uid and v_role is not null) or v_is_so)))
        order by r.requested_at desc, r.id desc)
      from public.booking_change_requests r
      left join public.staff_profiles rp on rp.user_id = r.requested_by
      left join public.staff_profiles dp on dp.user_id = r.decided_by
      where r.deal_id = v_deal.id), '[]'::jsonb));
end;
$$;

create function public.service_removal_charges(p_change_request_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_r public.booking_change_requests%rowtype;
  v_viewer text;
  v_rows jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v_r from public.booking_change_requests r where r.id = p_change_request_id;
  if v_r.id is null or v_r.kind <> 'remove_service' then
    return null;
  end if;
  -- Section 14: the branch Manager (or the LD37 Approver) and Accounts; never
  -- a holder of Purchase, Flight or Visa (authz.cr_viewer / cr_is_approver).
  v_viewer := authz.cr_viewer(v_r.deal_id);
  if not (coalesce(v_viewer in ('manager', 'accounts'), false) or authz.cr_is_approver(v_r.id)) then
    return null;
  end if;
  with c as (select * from authz.cr_removal_charges(v_r.id)),
  rows as (
    select c.department, c.subject_id, c.revision_no, c.complete, c.entered_at, ep.display_name as entered_by_name,
      coalesce(authz.service_item_title(i.service_type, f.facts), 'Service') as label, s.name as supplier_name,
      (authz.purchase_latest_cost(c.task_id)).amount_paise as cost_paise,
      x.supplier_keeps_paise as keeps_paise, x.supplier_refund_paise as refund_paise
    from c
    join public.fulfilment_tasks t on t.id = c.task_id
    join public.service_items i on i.id = t.service_item_id
    left join public.service_item_facts f on f.service_item_id = i.id and f.booking_version_id = v_r.base_version_id
    left join public.purchase_cancellation_charges x on x.id = c.charge_id
    left join public.purchase_quotes q on q.id = t.selected_quote_id
    left join public.suppliers s on s.id = coalesce(x.supplier_id, q.supplier_id)
    left join public.staff_profiles ep on ep.user_id = c.entered_by
    where c.department = 'purchase'
    union all
    select c.department, c.subject_id, c.revision_no, c.complete, c.entered_at, ep.display_name,
      'Ticket batch ' || b.batch_no::text, s.name, b.supplier_cost_paise, y.airline_charge_paise, y.refund_expected_paise
    from c
    join public.flight_ticket_batches b on b.id = c.subject_id
    join public.suppliers s on s.id = b.supplier_id
    left join public.flight_cancellation_charges y on y.id = c.charge_id
    left join public.staff_profiles ep on ep.user_id = c.entered_by
    where c.department = 'flight'
    union all
    select c.department, c.subject_id, c.revision_no, c.complete, c.entered_at, ep.display_name,
      case e.cost_kind when 'government_fee' then 'Government fee' when 'service_fee' then 'Service fee' else 'Other fee' end,
      null::text, e.amount_paise, case when z.id is not null then e.amount_paise - z.refund_expected_paise end, z.refund_expected_paise
    from c
    join public.department_cost_entries e on e.id = c.subject_id
    left join public.visa_cancellation_fees z on z.id = c.charge_id
    left join public.staff_profiles ep on ep.user_id = c.entered_by
    where c.department = 'visa')
  select coalesce(jsonb_agg(jsonb_build_object(
      'department', w.department, 'subjectId', w.subject_id, 'label', w.label, 'supplierName', w.supplier_name,
      'costPaise', w.cost_paise::text, 'supplierKeepsPaise', w.keeps_paise::text, 'refundExpectedPaise', w.refund_paise::text,
      'revisionNo', coalesce(w.revision_no, 0), 'enteredByName', w.entered_by_name, 'enteredAt', w.entered_at,
      'complete', w.complete)
      order by w.department, w.label, w.subject_id), '[]'::jsonb)
  into v_rows from rows w;
  return jsonb_build_object(
    'changeRequestId', v_r.id, 'refNo', v_r.ref_no, 'dealId', v_r.deal_id, 'status', v_r.status,
    'removalRoute', v_r.removal_route,
    'customerChargePaise', v_r.customer_charge_paise::text,
    'itemNo', (select i.item_no from public.service_items i where i.id = v_r.item_ids[1]),
    'serviceTitle', (select coalesce(authz.service_item_title(i.service_type, f.facts), 'Service')
                     from public.service_items i
                     left join public.service_item_facts f on f.service_item_id = i.id and f.booking_version_id = v_r.base_version_id
                     where i.id = v_r.item_ids[1]),
    'complete', not exists (select 1 from jsonb_array_elements(v_rows) e where not (e ->> 'complete')::boolean),
    'charges', v_rows,
    'totals', jsonb_build_object(
      'supplierKeepsPaise', (select coalesce(sum((e ->> 'supplierKeepsPaise')::bigint), 0)::text from jsonb_array_elements(v_rows) e),
      'refundExpectedPaise', (select coalesce(sum((e ->> 'refundExpectedPaise')::bigint), 0)::text from jsonb_array_elements(v_rows) e)));
end;
$$;

revoke all on function authz.cr_charge_json(uuid, uuid), authz.cr_visa_cancellation_json(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.service_removal_charges(uuid) from public, anon, authenticated, service_role;
grant execute on function public.service_removal_charges(uuid) to authenticated;
-- The replaced functions keep their grants (CREATE OR REPLACE).

commit;
