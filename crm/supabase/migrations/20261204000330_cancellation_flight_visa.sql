-- Accounts phase 2, Track C (contract sections 7.3 C9-C11, 7.4, LD11-LD14,
-- owner Q11): Flight and Visa handling of a trip cancellation.
--
-- * Flight: per ticket batch an append-only charge revision (airline charge,
--   refund expected, Flight-reported refund) entered by the batch's cost-task
--   owner, or any active Flight person while that task has no assignee (C9).
--   After approval only the reported refund may change (LD13). Counted as
--   missing until entered; Flight may send the case; the Manager approving it
--   never entered a Flight revision. flight_money shows the charge per batch
--   and "tickets cancelled" after approval (tickets stay immutable).
-- * Visa (LD12): from approval new or edited Visa costs, fee sends,
--   applications and re-applications refuse trip_cancelled; each submitted /
--   decision-pending application gets a choice withdraw | finish (C10,
--   withdraw = the effects of visa_application_withdraw); a company-paid fee
--   may carry an expected refund (C11, no row = not refundable).
-- * LD14: a case with nothing to charge (no Purchase task with a cost, no
--   ticket batch) is approved by the Manager straight from open.
-- * Readers: deal_cancellation_summary / manager_cancellation_list add
--   flightCharges and chargesKeptPaise for the Manager (Purchase shape unchanged).
--
-- Replaced (latest bodies, same signatures): authz.cancellation_charges_missing
-- (20261130000100), deal_cancellation_send / deal_cancellation_decide
-- (20261130000110), manager_cancellation_list / deal_cancellation_summary
-- (20261130000120), flight_money (20261203000130), department_cost_save /
-- visa_fee_send / visa_applications_apply / visa_application_reapply /
-- visa_workspace (20261202000140).
-- Refusal tokens: trip_cancelled (55000, Visa), not_ready, already_decided,
-- already_recorded, version_changed, invalid_input (hint = field),
-- not_authorized, duplicate_request.
-- Audit: flight.cancellation_charge_set, visa.cancellation_choice,
-- visa.cancellation_fee_set (+ visa.application_withdrawn / _closed on withdraw).
-- Lock order (13.1): finance_lock_deal -> Flight tasks (flight_lock_group) ->
-- cancellation row; Visa: finance_lock_deal -> task -> application.
--
-- Rollback (forward-only): a NEW migration restoring the cited bodies and
-- dropping the new functions.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Helpers
-- ===========================================================================

-- Purchase tasks with a cost and ticket batches of the Deal without a charge in this case.
create or replace function authz.cancellation_charges_missing(p_cancellation uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select (
    select count(*)::integer
    from public.deal_cancellations c
    join public.fulfilment_tasks t on t.deal_id = c.deal_id and t.department = 'purchase'
    where c.id = p_cancellation
      and exists (select 1 from public.purchase_cost_versions v where v.task_id = t.id)
      and not exists (select 1 from public.purchase_cancellation_charges x
                      where x.cancellation_id = c.id and x.task_id = t.id))
  -- Accounts phase 2 (20261204000330): ticket batches need a Flight charge too.
  + (
    select count(*)::integer
    from public.deal_cancellations c
    join public.flight_ticket_batches b on b.deal_id = c.deal_id
    where c.id = p_cancellation
      and not exists (select 1 from public.flight_cancellation_charges y
                      where y.cancellation_id = c.id and y.batch_id = b.id))
$$;

-- LD14: the case has something to charge (a Purchase task with a cost or a ticket batch).
create function authz.cancellation_needs_charges(p_cancellation uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
      select 1 from public.deal_cancellations c
      join public.fulfilment_tasks t on t.deal_id = c.deal_id and t.department = 'purchase'
      where c.id = p_cancellation and exists (select 1 from public.purchase_cost_versions v where v.task_id = t.id))
    or exists (
      select 1 from public.deal_cancellations c
      join public.flight_ticket_batches b on b.deal_id = c.deal_id
      where c.id = p_cancellation)
$$;

-- Latest Flight charge revision per ticket batch of the Deal (missing ones with null amounts).
create function authz.flight_cancellation_charges_json(p_cancellation uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'batchId', b.id, 'batchNo', b.batch_no, 'supplierName', s.name,
      'supplierCostPaise', coalesce(y.supplier_cost_paise, b.supplier_cost_paise)::text,
      'airlineChargePaise', y.airline_charge_paise::text, 'refundExpectedPaise', y.refund_expected_paise::text,
      'refundReportedPaise', y.refund_reported_paise::text, 'revisionNo', coalesce(y.revision_no, 0),
      'enteredByName', ep.display_name) order by b.batch_no), '[]'::jsonb)
  from public.deal_cancellations c
  join public.flight_ticket_batches b on b.deal_id = c.deal_id
  join public.suppliers s on s.id = b.supplier_id
  left join lateral (select x.* from public.flight_cancellation_charges x
                     where x.cancellation_id = c.id and x.batch_id = b.id
                     order by x.revision_no desc limit 1) y on true
  left join public.staff_profiles ep on ep.user_id = y.entered_by
  where c.id = p_cancellation
$$;

-- LD11: supplier and airline charges kept (latest revisions), one combined figure.
create function authz.cancellation_charges_kept(p_cancellation uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(cur.supplier_keeps_paise) from (
           select distinct on (x.task_id) x.supplier_keeps_paise from public.purchase_cancellation_charges x
           where x.cancellation_id = p_cancellation order by x.task_id, x.revision_no desc) cur), 0)::bigint
       + coalesce((select sum(cur.airline_charge_paise) from (
           select distinct on (y.batch_id) y.airline_charge_paise from public.flight_cancellation_charges y
           where y.cancellation_id = p_cancellation order by y.batch_id, y.revision_no desc) cur), 0)::bigint
$$;

-- C9 caller: the batch's cost-task owner, or any active Flight person while the task has no assignee.
create function authz.flight_can_enter_charge(p_batch uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and exists (
    select 1 from public.flight_ticket_batches b
    join public.fulfilment_tasks t on t.id = b.cost_task_id
    where b.id = p_batch
      and exists (select 1 from public.deal_cancellations c where c.deal_id = b.deal_id)
      and (authz.flight_owns_task(t.id)
           or (t.assignee_user_id is null and authz.holds_active_role('flight', t.legal_entity_id))))
$$;

-- ===========================================================================
-- 2. C9 flight_cancellation_charge_set
-- ===========================================================================

create function public.flight_cancellation_charge_set(p_batch_id uuid, p_fields jsonb, p_expected_revision integer,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_batch public.flight_ticket_batches%rowtype;
  v_c public.deal_cancellations%rowtype;
  v_prev public.flight_cancellation_charges%rowtype;
  v_existing public.flight_cancellation_charges%rowtype;
  v_key text;
  v_airline bigint;
  v_expected bigint;
  v_reported bigint;
  v_note text;
  v_rev integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_batch from public.flight_ticket_batches b where b.id = p_batch_id;
  if v_batch.id is null or not authz.holds_active_role('flight', v_batch.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_request_id is null then
    perform authz.refund_invalid('requestId');
  end if;
  perform authz.refuse_removed_deal(v_batch.deal_id);
  -- Lock order (13.1): finance head, the Deal's Flight tasks, the cancellation row.
  perform authz.finance_lock_deal(v_batch.deal_id);
  perform 1 from authz.flight_lock_group(v_batch.deal_id);
  select * into v_c from public.deal_cancellations c where c.deal_id = v_batch.deal_id for update;
  if v_c.id is null then
    raise exception 'not_ready' using errcode = '55000', hint = 'cancellation';
  end if;
  if not authz.flight_can_enter_charge(v_batch.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_existing from public.flight_cancellation_charges x
  where x.legal_entity_id = v_batch.legal_entity_id and x.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.batch_id = v_batch.id and v_existing.cancellation_id = v_c.id and v_existing.entered_by = v_uid then
      return jsonb_build_object('outcome', 'existing', 'cancellationId', v_c.id, 'batchId', v_batch.id,
        'revisionNo', v_existing.revision_no, 'status', v_c.status);
    end if;
    raise exception 'duplicate_request' using errcode = '23505';
  end if;
  select * into v_prev from public.flight_cancellation_charges x
  where x.cancellation_id = v_c.id and x.batch_id = v_batch.id order by x.revision_no desc limit 1;
  v_rev := coalesce(v_prev.revision_no, 0);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    perform authz.refund_invalid('fields');
  end if;
  for v_key in select k from jsonb_object_keys(p_fields) k order by k loop
    if v_key <> all (array['airlineChargePaise', 'refundExpectedPaise', 'refundReportedPaise', 'note']) then
      perform authz.refund_invalid(v_key);
    end if;
  end loop;
  v_airline := authz.refund_paise(p_fields, 'airlineChargePaise');
  if v_airline is null or v_airline > 999999999999 then
    perform authz.refund_invalid('airlineChargePaise');
  end if;
  v_expected := authz.refund_paise(p_fields, 'refundExpectedPaise');
  if v_expected is null or v_expected > 999999999999 then
    perform authz.refund_invalid('refundExpectedPaise');
  end if;
  v_reported := authz.refund_paise(p_fields, 'refundReportedPaise');
  if v_reported > 999999999999 then
    perform authz.refund_invalid('refundReportedPaise');
  end if;
  v_note := authz.refund_text(p_fields, 'note', 1, 500, true);
  -- LD13: after approval only the Flight-reported refund may change.
  if v_c.status = 'approved'
     and (v_prev.id is null or v_airline is distinct from v_prev.airline_charge_paise
          or v_expected is distinct from v_prev.refund_expected_paise) then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_revision is distinct from v_rev then
    raise exception 'version_changed' using errcode = '40001';
  end if;

  insert into public.flight_cancellation_charges (cancellation_id, legal_entity_id, deal_id, batch_id, cost_task_id, supplier_id,
    revision_no, supplier_cost_paise, airline_charge_paise, refund_expected_paise, refund_reported_paise, note, entered_by, request_id)
  values (v_c.id, v_batch.legal_entity_id, v_batch.deal_id, v_batch.id, v_batch.cost_task_id, v_batch.supplier_id, v_rev + 1,
    v_batch.supplier_cost_paise, v_airline, v_expected, v_reported, v_note, v_uid, p_request_id);
  -- Purchase rule: a change before approval (also after sending) puts the case back to charges_entered.
  if v_c.status <> 'approved' then
    update public.deal_cancellations c
    set status = 'charges_entered', row_version = c.row_version + 1, updated_at = now()
    where c.id = v_c.id;
  end if;
  perform authz.write_audit('flight.cancellation_charge_set', v_batch.legal_entity_id, v_batch.branch_id,
    'flight_ticket_batch', v_batch.id, null,
    jsonb_build_object('cancellationId', v_c.id, 'batchId', v_batch.id, 'revisionNo', v_rev + 1, 'previousStatus', v_c.status));
  return jsonb_build_object('outcome', 'created', 'cancellationId', v_c.id, 'batchId', v_batch.id, 'revisionNo', v_rev + 1,
    'status', case when v_c.status = 'approved' then 'approved' else 'charges_entered' end);
end;
$$;

-- ===========================================================================
-- 3. C10 visa_application_cancellation_choice
-- ===========================================================================

create function public.visa_application_cancellation_choice(p_application_id uuid, p_expected_row_version integer,
  p_choice text, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_app public.visa_applications%rowtype;
  v_command text := 'visa_application_cancellation_choice';
  v_payload jsonb := jsonb_build_object('applicationId', p_application_id, 'expectedRowVersion', p_expected_row_version,
    'choice', p_choice, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
  v_done boolean := false;
  v_deal uuid;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select a.deal_id into v_deal from public.visa_applications a where a.id = p_application_id;
  if v_deal is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  -- Lock order: deal head, task, application (as the Visa fee commands).
  perform authz.finance_lock_deal(v_deal);
  v_app := authz.visa_lock_application(p_application_id);
  v_result := authz.visa_replay(v_app.legal_entity_id, p_request_id, v_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.visa_require_open(v_app, false, false);
  if not authz.deal_cancellation_approved(v_app.deal_id) or v_app.state not in ('submitted', 'decision_pending') then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if v_app.cancellation_choice is not null then
    raise exception 'already_recorded' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_app.row_version);
  if p_choice is null or p_choice not in ('withdraw', 'finish') then
    perform authz.refund_invalid('choice');
  end if;
  begin
    v_reason := authz.finance_text(p_reason, 10, 300, true);
  exception when sqlstate '22023' then
    perform authz.refund_invalid('reason');
  end;
  if v_reason is null then
    perform authz.refund_invalid('reason');
  end if;
  update public.visa_applications a
  set cancellation_choice = p_choice, cancellation_choice_by = (select auth.uid()), cancellation_choice_at = now(),
      cancellation_choice_reason = v_reason,
      -- withdraw: the effects of visa_application_withdraw (the customer cancelled the trip).
      state = case when p_choice = 'withdraw' then 'withdrawn' else a.state end,
      withdraw_reason = case when p_choice = 'withdraw' then v_reason else a.withdraw_reason end,
      customer_informed_at = case when p_choice = 'withdraw' then now() else a.customer_informed_at end,
      row_version = a.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
  where a.id = v_app.id;
  perform authz.visa_audit('visa.cancellation_choice', v_app.id, v_reason,
    jsonb_build_object('applicationId', v_app.id, 'choice', p_choice, 'rowVersion', v_app.row_version + 1));
  if p_choice = 'withdraw' then
    perform authz.visa_audit('visa.application_withdrawn', v_app.id, v_reason, jsonb_build_object('rowVersion', v_app.row_version + 1));
    perform authz.visa_close(v_app.id, 'customer_informed');
    v_done := authz.visa_task_complete_if_done(v_app.task_id);
  end if;
  v_result := authz.visa_app_result(v_app.id, 'updated', v_done) || jsonb_build_object('cancellationChoice', p_choice);
  return authz.visa_remember(v_app.legal_entity_id, p_request_id, v_command, v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 4. C11 visa_cancellation_fee_set
-- ===========================================================================

create function public.visa_cancellation_fee_set(p_entry_id uuid, p_refund_expected_paise bigint, p_note text,
  p_expected_revision integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_entry public.department_cost_entries%rowtype;
  v_c public.deal_cancellations%rowtype;
  v_existing public.visa_cancellation_fees%rowtype;
  v_rev integer;
  v_note text;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_entry from public.department_cost_entries c where c.id = p_entry_id;
  if v_entry.id is null or v_entry.department <> 'visa' or not authz.visa_can_manage_fees(v_entry.task_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    perform authz.refund_invalid('requestId');
  end if;
  perform authz.refuse_removed_deal(v_entry.deal_id);
  perform authz.finance_lock_deal(v_entry.deal_id);
  perform 1 from public.fulfilment_tasks t where t.id = v_entry.task_id for update;
  select * into v_c from public.deal_cancellations c where c.deal_id = v_entry.deal_id;
  if v_c.id is null or v_entry.paid_by <> 'company' then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  select * into v_existing from public.visa_cancellation_fees x
  where x.legal_entity_id = v_entry.legal_entity_id and x.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.entry_id = v_entry.id and v_existing.entered_by = v_uid then
      return jsonb_build_object('outcome', 'existing', 'entryId', v_entry.id, 'revisionNo', v_existing.revision_no);
    end if;
    raise exception 'duplicate_request' using errcode = '23505';
  end if;
  select coalesce(max(x.revision_no), 0) into v_rev from public.visa_cancellation_fees x
  where x.cancellation_id = v_c.id and x.entry_id = v_entry.id;
  if p_expected_revision is distinct from v_rev then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if p_refund_expected_paise is null or p_refund_expected_paise < 0 or p_refund_expected_paise > v_entry.amount_paise then
    perform authz.refund_invalid('refundExpectedPaise');
  end if;
  begin
    v_note := authz.finance_text(p_note, 1, 500, true);
  exception when sqlstate '22023' then
    perform authz.refund_invalid('note');
  end;
  insert into public.visa_cancellation_fees (cancellation_id, legal_entity_id, deal_id, task_id, entry_id, revision_no,
    refund_expected_paise, note, entered_by, request_id)
  values (v_c.id, v_entry.legal_entity_id, v_entry.deal_id, v_entry.task_id, v_entry.id, v_rev + 1, p_refund_expected_paise,
    v_note, v_uid, p_request_id);
  perform authz.write_audit('visa.cancellation_fee_set', v_entry.legal_entity_id, v_entry.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('cancellationId', v_c.id, 'entryId', v_entry.id, 'revisionNo', v_rev + 1));
  return jsonb_build_object('outcome', 'created', 'entryId', v_entry.id, 'cancellationId', v_c.id, 'revisionNo', v_rev + 1);
end;
$$;

-- ===========================================================================
-- 5. Replaced cancellation, Flight and Visa functions
-- ===========================================================================

create or replace function public.deal_cancellation_send(p_cancellation_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_c public.deal_cancellations%rowtype;
begin
  select * into v_c from public.deal_cancellations c where c.id = p_cancellation_id for update;
  if v_c.id is null or not coalesce(authz.session_ok(), false)
     -- Accounts phase 2 (20261204000330): Purchase or Flight sends the charges.
     or not (authz.holds_active_role('purchase', v_c.legal_entity_id) or authz.holds_active_role('flight', v_c.legal_entity_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if v_c.status = 'sent_to_manager' and v_c.sent_request_id = p_request_id and v_c.sent_by = v_uid then
    return jsonb_build_object('cancellationId', v_c.id, 'status', v_c.status, 'rowVersion', v_c.row_version,
      'outcome', 'existing');
  end if;
  if v_c.status in ('sent_to_manager', 'approved') then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v_c.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if authz.cancellation_charges_missing(v_c.id) > 0 then
    raise exception 'not_ready' using errcode = '55000';
  end if;

  update public.deal_cancellations c
  set status = 'sent_to_manager', sent_by = v_uid, sent_at = now(), sent_request_id = p_request_id,
      return_reason = null, row_version = c.row_version + 1, updated_at = now()
  where c.id = v_c.id
  returning * into v_c;

  perform authz.write_audit('deal.cancellation_charges_sent', v_c.legal_entity_id, v_c.branch_id,
    'deal_cancellation', v_c.id, null, jsonb_build_object('dealId', v_c.deal_id));
  return jsonb_build_object('cancellationId', v_c.id, 'status', v_c.status, 'rowVersion', v_c.row_version,
    'outcome', 'created');
end;
$$;

create or replace function public.deal_cancellation_decide(
  p_cancellation_id uuid, p_decision text, p_reason text, p_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_c public.deal_cancellations%rowtype;
  v_reason text;
  v_status text;
begin
  select * into v_c from public.deal_cancellations c where c.id = p_cancellation_id for update;
  if v_c.id is null or not coalesce(authz.session_ok(), false) or not authz.is_branch_sales_manager(v_c.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null or p_decision is null or p_decision not in ('approve', 'return') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_status := case p_decision when 'approve' then 'approved' else 'charges_entered' end;
  if v_c.decision_request_id = p_request_id and v_c.decided_by = v_uid and v_c.status = v_status then
    return jsonb_build_object('cancellationId', v_c.id, 'status', v_c.status, 'rowVersion', v_c.row_version,
      'outcome', 'existing');
  end if;
  if v_c.status = 'approved' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v_c.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  -- Accounts phase 2 (20261204000330, LD14): with nothing to charge (no Purchase task with a
  -- cost, no ticket batch) the Manager approves straight from open.
  if v_c.status <> 'sent_to_manager'
     and not (p_decision = 'approve' and v_c.status in ('open', 'charges_entered')
              and not authz.cancellation_needs_charges(v_c.id)) then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  -- Review F8: nobody who entered any charge revision of this case, or sent
  -- it to the Manager, decides it.
  if v_c.sent_by = v_uid or exists (
    select 1 from public.purchase_cancellation_charges x
    where x.cancellation_id = v_c.id and x.entered_by = v_uid)
    -- Accounts phase 2 (20261204000330): nor anyone who entered a Flight charge revision.
    or exists (select 1 from public.flight_cancellation_charges y
               where y.cancellation_id = v_c.id and y.entered_by = v_uid) then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if p_decision = 'return' then
    v_reason := authz.purchase_reason(p_reason);
  end if;

  update public.deal_cancellations c
  set status = v_status, decided_by = v_uid, decided_at = now(), decision_request_id = p_request_id,
      return_reason = v_reason, row_version = c.row_version + 1, updated_at = now()
  where c.id = v_c.id
  returning * into v_c;

  perform authz.write_audit(case when p_decision = 'approve' then 'deal.cancellation_approved' else 'deal.cancellation_returned' end,
    v_c.legal_entity_id, v_c.branch_id, 'deal_cancellation', v_c.id, v_reason, jsonb_build_object('dealId', v_c.deal_id));
  return jsonb_build_object('cancellationId', v_c.id, 'status', v_c.status, 'rowVersion', v_c.row_version,
    'outcome', 'created');
end;
$$;

create or replace function public.manager_cancellation_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'cancellationId', c.id,
        'dealId', c.deal_id,
        'dealReference', d.reference,
        'branchName', b.name,
        'status', c.status,
        'reason', c.reason,
        'openedAt', c.opened_at,
        'openedByName', op.display_name,
        'sentAt', c.sent_at,
        'sentByName', sp.display_name,
        'decidedAt', c.decided_at,
        'decidedByName', dp.display_name,
        'returnReason', c.return_reason,
        'rowVersion', c.row_version,
        'charges', authz.cancellation_charges_json(c.id),
        'totalKeepsPaise', coalesce((select sum(cur.supplier_keeps_paise) from (
            select distinct on (x.task_id) x.supplier_keeps_paise from public.purchase_cancellation_charges x
            where x.cancellation_id = c.id order by x.task_id, x.revision_no desc) cur), 0)::text,
        'totalRefundPaise', coalesce((select sum(cur.supplier_refund_paise) from (
            select distinct on (x.task_id) x.supplier_refund_paise from public.purchase_cancellation_charges x
            where x.cancellation_id = c.id order by x.task_id, x.revision_no desc) cur), 0)::text,
        -- Accounts phase 2 (20261204000330): Flight charges and the combined kept charges.
        'flightCharges', authz.flight_cancellation_charges_json(c.id),
        'chargesKeptPaise', authz.cancellation_charges_kept(c.id)::text,
        'canDecide', (c.status = 'sent_to_manager'
                      or (c.status in ('open', 'charges_entered') and not authz.cancellation_needs_charges(c.id)))
          and c.sent_by is distinct from v_uid
          and not exists (select 1 from public.purchase_cancellation_charges x
                          where x.cancellation_id = c.id and x.entered_by = v_uid)
          and not exists (select 1 from public.flight_cancellation_charges y
                          where y.cancellation_id = c.id and y.entered_by = v_uid))
        order by (c.status = 'sent_to_manager') desc, c.opened_at desc, c.id desc)
    from public.deal_cancellations c
    join public.deals d on d.id = c.deal_id
    join public.branches b on b.id = c.branch_id
    left join public.staff_profiles op on op.user_id = c.opened_by
    left join public.staff_profiles sp on sp.user_id = c.sent_by
    left join public.staff_profiles dp on dp.user_id = c.decided_by
    where authz.is_branch_sales_manager(c.deal_id)
  ), '[]'::jsonb);
end;
$$;

create or replace function public.deal_cancellation_summary(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_manager boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_deal_id is null or not exists (select 1 from public.deals d where d.id = p_deal_id) then
    return null;
  end if;
  v_manager := authz.is_branch_sales_manager(p_deal_id);
  if not v_manager and not authz.can_read_deal(p_deal_id) then
    return null;
  end if;
  return jsonb_build_object(
    'canOpen', v_manager and not authz.deal_trip_cancelled(p_deal_id) and authz.deployment_environment() <> 'unset',
    'cancellation', (
      select jsonb_build_object(
        'cancellationId', c.id,
        'status', c.status,
        'reason', c.reason,
        'openedAt', c.opened_at,
        'openedByName', op.display_name,
        'decidedAt', case when c.status = 'approved' then c.decided_at end)
        -- Accounts phase 2 (20261204000330): Flight charges and kept charges for M only;
        -- Purchase, Flight and Sales readers keep their shape.
        || case when authz.refund_is_m(p_deal_id) then jsonb_build_object(
             'flightCharges', authz.flight_cancellation_charges_json(c.id),
             'chargesKeptPaise', authz.cancellation_charges_kept(c.id)::text) else '{}'::jsonb end
      from public.deal_cancellations c
      left join public.staff_profiles op on op.user_id = c.opened_by
      where c.deal_id = p_deal_id));
end;
$$;

create or replace function public.department_cost_save(p_task_id uuid, p_entry_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_old public.department_cost_entries%rowtype;
  v_entry public.department_cost_entries%rowtype;
  v_bad text[];
  v_kind text;
  v_amount bigint;
  v_paid text;
  v_mode text;
  v_on date;
  v_ref text;
  v_receipt uuid;
  v_status text;
  v_app uuid;  -- Visa build
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  perform authz.refuse_removed_deal(v_task.deal_id);
  if v_task.id is null or not (authz.can_work_department_task(v_task.id)
                                -- Visa build (20261202000140): "other" costs after completion.
                                or authz.visa_can_manage_fees(v_task.id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- B1.1c: Purchase gets the read-only placeholder only (B2/B3 build its costs).
  if v_task.department = 'purchase' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'department';
  end if;
-- Accounts phase 2 (20261204000330, LD12): no new or edited Visa-task cost once the
  -- trip cancellation is approved.
  if v_task.department = 'visa' and authz.deal_cancellation_approved(v_task.deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  -- Flight build (20261201000210, owner D3): the per-passenger fare breakup
  -- is the only flight cost record; manual flight entries end here.
  if v_task.department = 'flight' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'flightFares';
  end if;
  -- Visa build (20261202000110, VL18 as changed by lead decision 16): only an
  -- "other" cost of one current passenger (applicationId); fees come from Applied.
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or jsonb_typeof(p_fields -> 'applicationId') is distinct from 'string'
     or (p_fields ->> 'applicationId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or not exists (select 1 from public.visa_applications a
                    where a.id = (p_fields ->> 'applicationId')::uuid and a.task_id = v_task.id and a.superseded_at is null)
     or authz.b11_text(p_fields -> 'costKind') is distinct from 'other' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'visaFees';
  end if;
  v_app := (p_fields ->> 'applicationId')::uuid;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if p_entry_id is null then
    select * into v_old from public.department_cost_entries c where c.task_id = v_task.id and c.request_id = p_request_id;
    if v_old.id is not null then
      return jsonb_build_object('entryId', v_old.id, 'rowVersion', v_old.row_version, 'expenseStatus', v_old.expense_status);
    end if;
  else
    select * into v_old from public.department_cost_entries c where c.id = p_entry_id and c.task_id = v_task.id for update;
    if v_old.id is null then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    perform authz.require_row_version(p_expected_row_version, v_old.row_version);
    if v_old.expense_status in ('submitted', 'accepted') then
      raise exception 'cost_locked' using errcode = '55000';
    end if;
    -- Visa build: only an "other" cost of the same passenger is edited here.
    if v_old.application_id is distinct from v_app or v_old.cost_kind <> 'other' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'visaFees';
    end if;
  end if;

  v_bad := authz.b11_unknown_keys(p_fields, array['costKind', 'amountPaise', 'paidBy', 'paymentMode', 'paidOn', 'reference',
    'receiptEvidenceId', 'applicationId']);
  v_kind := authz.b11_text(p_fields -> 'costKind');
  if jsonb_typeof(p_fields -> 'amountPaise') in ('string', 'number') and (p_fields ->> 'amountPaise') ~ '^[1-9][0-9]{0,14}$' then
    v_amount := (p_fields ->> 'amountPaise')::bigint;
  else
    v_bad := v_bad || 'amountPaise'::text;
  end if;
  v_paid := authz.b11_text(p_fields -> 'paidBy');
  -- Visa build: same paid-by choices as the Applied fees.
  if v_paid is null or v_paid not in ('company', 'customer_direct') then v_bad := v_bad || 'paidBy'::text; end if;
  v_mode := authz.b11_text(p_fields -> 'paymentMode');
  v_on := authz.sf_date(p_fields -> 'paidOn');
  if v_paid is not null then
    if (v_paid = 'company' and (v_mode is null or v_mode not in ('bank_transfer', 'upi', 'card', 'cash', 'other')))
       or (v_paid = 'customer_direct' and v_mode is not null and v_mode not in ('bank_transfer', 'upi', 'card', 'cash', 'other')) then
      v_bad := v_bad || 'paymentMode'::text;
    end if;
    -- Business date in IST, as the finance commands (review E3).
    if v_on is null or v_on > authz.finance_today() then v_bad := v_bad || 'paidOn'::text; end if;
  end if;
  if not authz.sf_text_ok(p_fields -> 'reference', 120, false) then v_bad := v_bad || 'reference'::text; end if;
  v_ref := authz.b11_text(p_fields -> 'reference');
  if p_fields ? 'receiptEvidenceId' and jsonb_typeof(p_fields -> 'receiptEvidenceId') <> 'null' then
    begin
      v_receipt := (p_fields ->> 'receiptEvidenceId')::uuid;
    exception when others then
      v_bad := v_bad || 'receiptEvidenceId'::text;
    end;
    if v_receipt is not null and not exists (
         select 1 from public.department_evidence e where e.id = v_receipt and e.task_id = v_task.id
           and e.kind = 'fee_receipt' and e.status <> 'removed') then
      v_bad := v_bad || 'receiptEvidenceId'::text;
    end if;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  v_status := case when v_paid = 'company' then coalesce(case when v_old.expense_status = 'returned' then 'returned' end, 'draft') end;

  if v_old.id is null then
    insert into public.department_cost_entries (task_id, deal_id, legal_entity_id, branch_id, department, cost_kind,
      amount_paise, paid_by, payment_mode, paid_on, reference, receipt_evidence_id, expense_status, request_id, created_by,
      application_id)
    values (v_task.id, v_task.deal_id, v_task.legal_entity_id, v_task.branch_id, v_task.department, v_kind, v_amount, v_paid,
      v_mode, v_on, v_ref, v_receipt, v_status, p_request_id, (select auth.uid()), v_app)
    returning * into v_entry;
  else
    update public.department_cost_entries c
    set cost_kind = v_kind, amount_paise = v_amount, paid_by = v_paid, payment_mode = v_mode, paid_on = v_on,
        reference = v_ref, receipt_evidence_id = v_receipt, expense_status = v_status,
        submitted_by = case when v_status = 'returned' then c.submitted_by end,
        submitted_at = case when v_status = 'returned' then c.submitted_at end,
        reviewed_by = case when v_status = 'returned' then c.reviewed_by end,
        reviewed_at = case when v_status = 'returned' then c.reviewed_at end,
        return_reason = case when v_status = 'returned' then c.return_reason end,
        row_version = c.row_version + 1, updated_at = now()
    where c.id = v_old.id
    returning * into v_entry;
  end if;
  -- No amount in the audit record.
  perform authz.write_audit('department.cost_saved', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('taskId', v_task.id, 'department', v_task.department, 'costKind', v_kind,
      'paidBy', v_paid, 'rowVersion', v_entry.row_version));
  return jsonb_build_object('entryId', v_entry.id, 'rowVersion', v_entry.row_version, 'expenseStatus', v_entry.expense_status);
end;
$$;

create or replace function public.visa_fee_send(p_entry_id uuid, p_expected_row_version integer, p_fields jsonb, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entry public.department_cost_entries%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_command text := 'visa_fee_send';
  v_payload jsonb := jsonb_build_object('entryId', p_entry_id, 'expectedRowVersion', p_expected_row_version, 'fields', p_fields);
  v_result jsonb;
  v_bad text[] := '{}';
  v_amount bigint;
  v_receipt uuid;
  v_remark text;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_entry from public.department_cost_entries c where c.id = p_entry_id;
  if v_entry.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.refuse_removed_deal(v_entry.deal_id);
  -- Lock order: deal head, task, entry (as Accounts review).
  perform authz.finance_lock_deal(v_entry.deal_id);
  select * into v_task from public.fulfilment_tasks t where t.id = v_entry.task_id for update;
  select * into v_entry from public.department_cost_entries c where c.id = p_entry_id for update;
  v_result := authz.visa_replay(v_entry.legal_entity_id, p_request_id, v_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_entry.department <> 'visa' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- 20261202000140: also after the task completed (money follows separately).
  if not authz.visa_can_manage_fees(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
-- Accounts phase 2 (20261204000330, LD12): no fee sent after the cancellation is approved.
  if authz.deal_cancellation_approved(v_entry.deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_entry.row_version);
  if v_entry.expense_status in ('submitted', 'accepted') then
    raise exception 'cost_locked' using errcode = '55000';
  end if;
  if v_entry.paid_by <> 'company' or v_entry.expense_status is null or v_entry.expense_status not in ('draft', 'returned') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_bad := authz.b11_unknown_keys(p_fields, array['amountPaise', 'receiptEvidenceId', 'remark']);
  v_amount := v_entry.amount_paise;
  if p_fields ? 'amountPaise' then
    if jsonb_typeof(p_fields -> 'amountPaise') in ('string', 'number') and (p_fields ->> 'amountPaise') ~ '^[1-9][0-9]{0,14}$' then
      v_amount := (p_fields ->> 'amountPaise')::bigint;
    else
      v_bad := v_bad || 'amountPaise'::text;
    end if;
  end if;
  v_receipt := v_entry.receipt_evidence_id;
  if coalesce(jsonb_typeof(p_fields -> 'receiptEvidenceId'), 'null') <> 'null' then
    if jsonb_typeof(p_fields -> 'receiptEvidenceId') <> 'string'
       or (p_fields ->> 'receiptEvidenceId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not exists (select 1 from public.department_evidence e
                      where e.id = (p_fields ->> 'receiptEvidenceId')::uuid and e.task_id = v_task.id
                        and e.kind = 'fee_receipt' and e.status = 'stored') then
      v_bad := v_bad || 'receiptEvidenceId'::text;
    else
      v_receipt := (p_fields ->> 'receiptEvidenceId')::uuid;
    end if;
  end if;
  if not authz.sf_text_ok(p_fields -> 'remark', 300, false) then
    v_bad := v_bad || 'remark'::text;
  end if;
  v_remark := authz.b11_text(p_fields -> 'remark');
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  if v_receipt is null or not exists (select 1 from public.department_evidence e
                                      where e.id = v_receipt and e.task_id = v_task.id and e.kind = 'fee_receipt'
                                        and e.status = 'stored') then
    raise exception 'receipt_required' using errcode = '55000';
  end if;
  update public.department_cost_entries c
  set amount_paise = v_amount, receipt_evidence_id = v_receipt, expense_status = 'submitted',
      submitted_by = (select auth.uid()), submitted_at = now(), reviewed_by = null, reviewed_at = null, return_reason = null,
      row_version = c.row_version + 1, updated_at = now()
  where c.id = v_entry.id
  returning * into v_entry;
  perform authz.write_audit('department.cost_saved', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('taskId', v_task.id, 'department', 'visa', 'costKind', v_entry.cost_kind,
      'paidBy', v_entry.paid_by, 'rowVersion', v_entry.row_version));
  perform authz.write_audit('department.cost_submitted', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('taskId', v_task.id, 'department', 'visa', 'costKind', v_entry.cost_kind,
      'rowVersion', v_entry.row_version));
  perform authz.write_audit('visa.fee_sent', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry', v_entry.id,
    v_remark, jsonb_build_object('taskId', v_task.id, 'entryId', v_entry.id, 'applicationId', v_entry.application_id,
      'costKind', v_entry.cost_kind, 'seq', (select a.traveller_seq from public.visa_applications a where a.id = v_entry.application_id)));
  v_result := jsonb_build_object('outcome', 'updated', 'entryId', v_entry.id, 'rowVersion', v_entry.row_version,
    'expenseStatus', v_entry.expense_status, 'taskCompleted', false);
  return authz.visa_remember(v_entry.legal_entity_id, p_request_id, v_command, v_payload, v_result);
end;
$$;

create or replace function public.visa_applications_apply(p_task_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_command text := 'visa_applications_apply';
  v_payload jsonb := jsonb_build_object('taskId', p_task_id, 'fields', p_fields);
  v_result jsonb;
  v_facts jsonb;
  v_passport boolean;
  v_list jsonb;
  v_n integer;
  v_i integer;
  v_x jsonb;
  v_ids uuid[] := '{}';
  v_app public.visa_applications%rowtype;
  v_bad text[] := '{}';
  v_not text[];
  v_kind_post text;
  v_kind_needed boolean := false;
  v_jpost boolean := false;
  v_jreq boolean;
  v_jplace text;
  v_taken boolean := false;
  v_paid text;
  v_mode text;
  v_receipt uuid;
  v_remark text;
  v_club uuid;
  v_today date := authz.finance_today();
  v_ref text;
  v_on date;
  v_gov bigint;
  v_svc bigint;
  v_kind text;
  v_entry uuid;
  v_entries uuid[];
  v_all_entries uuid[] := '{}';
  v_apps jsonb := '[]'::jsonb;
  v_status text;
  v_k text;
  v_amount bigint;
  v_done boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or v_task.department <> 'visa' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.refuse_removed_deal(v_task.deal_id);
  -- Lock order: deal head (fees, as Accounts review), task, applications by id.
  perform authz.finance_lock_deal(v_task.deal_id);
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  v_result := authz.visa_replay(v_task.legal_entity_id, p_request_id, v_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;
  -- Accounts phase 2 (20261204000330, LD12): no new applications after the cancellation is approved.
  if authz.deal_cancellation_approved(v_task.deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  perform authz.visa_require_work(v_task.id);
  -- 20261202000140 (finding 3): follow the booking first, so a removed traveller is never applied.
  perform authz.visa_sync_task(v_task.id, null);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_facts := authz.visa_task_facts(v_task.id);
  v_passport := v_task.service_purpose = 'passport';
  v_bad := authz.b11_unknown_keys(p_fields, array['applicants', 'visaKind', 'jurisdiction', 'jurisdictionPlace',
    'passportTaken', 'paidBy', 'paymentMode', 'receiptEvidenceId', 'remark']);
  v_list := p_fields -> 'applicants';
  if jsonb_typeof(v_list) is distinct from 'array' or jsonb_array_length(v_list) not between 1 and 100
     or exists (select 1 from jsonb_array_elements(v_list) x
                where jsonb_typeof(x) <> 'object' or jsonb_typeof(x -> 'applicationId') is distinct from 'string'
                   or (x ->> 'applicationId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   or jsonb_typeof(x -> 'expectedRowVersion') is distinct from 'number')
     or (select count(distinct x ->> 'applicationId') from jsonb_array_elements(v_list) x) <> jsonb_array_length(v_list) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'applicants';
  end if;
  v_n := jsonb_array_length(v_list);
  v_ids := array(select (x ->> 'applicationId')::uuid from jsonb_array_elements(v_list) x);
  -- 20261202000140 (finding 6): this task's rows only.
  perform 1 from public.visa_applications a where a.id = any (v_ids) and a.task_id = v_task.id order by a.id for update;

  -- Per-applicant state checks (in posted order).
  for v_i in 0 .. v_n - 1 loop
    v_x := v_list -> v_i;
    select * into v_app from public.visa_applications a
    where a.id = (v_x ->> 'applicationId')::uuid and a.task_id = v_task.id;
    if v_app.id is null then
      raise exception 'invalid_input' using errcode = '22023', hint = format('applicants[%s].applicationId', v_i);
    end if;
    perform authz.require_row_version((v_x ->> 'expectedRowVersion')::integer, v_app.row_version);
    if v_app.superseded_at is not null or v_app.closed_at is not null then
      raise exception 'application_closed' using errcode = '55000';
    end if;
    if v_app.removed_at is not null then
      raise exception 'applicant_removed' using errcode = '55000';
    end if;
    if v_app.state <> 'docs_pending' then
      raise exception 'wrong_state' using errcode = '55000';
    end if;
    if authz.visa_traveller_changed(v_app) then
      raise exception 'traveller_changed' using errcode = '55000';
    end if;
    v_not := authz.visa_not_ready(v_app, v_facts);
    if cardinality(v_not) > 0 then
      raise exception 'not_ready' using errcode = '55000', hint = format('applicants[%s]:%s', v_i, v_not[1]);
    end if;
    if not v_passport and authz.visa_effective_kind(v_app, v_facts) is null then
      v_kind_needed := true;
    end if;
  end loop;

  -- Shared fields.
  if p_fields ? 'visaKind' then
    v_kind_post := authz.b11_text(p_fields -> 'visaKind');
    if jsonb_typeof(p_fields -> 'visaKind') not in ('string', 'null') or (v_passport and v_kind_post is not null)
       or (v_kind_post is not null and v_kind_post not in ('e_visa', 'sticker')) then
      v_bad := v_bad || 'visaKind'::text;
    end if;
  end if;
  if v_kind_needed and v_kind_post is null and not ('visaKind' = any (v_bad)) then
    v_bad := v_bad || 'visaKind'::text;
  end if;
  if p_fields ?| array['jurisdiction', 'jurisdictionPlace'] then
    v_jpost := true;
    if v_passport or authz.visa_sales_jurisdiction(v_facts) is not null then
      v_bad := v_bad || 'jurisdiction'::text;
    else
      if jsonb_typeof(p_fields -> 'jurisdiction') = 'string' and (p_fields ->> 'jurisdiction') in ('yes', 'no') then
        v_jreq := (p_fields ->> 'jurisdiction') = 'yes';
      elsif coalesce(jsonb_typeof(p_fields -> 'jurisdiction'), 'null') <> 'null' then
        v_bad := v_bad || 'jurisdiction'::text;
      end if;
      if not authz.sf_text_ok(p_fields -> 'jurisdictionPlace', 120, false) then
        v_bad := v_bad || 'jurisdictionPlace'::text;
      end if;
      v_jplace := regexp_replace(authz.b11_text(p_fields -> 'jurisdictionPlace'), '\s+', ' ', 'g');
      if (v_jreq is true) <> (v_jplace is not null) and not ('jurisdictionPlace' = any (v_bad)) then
        v_bad := v_bad || 'jurisdictionPlace'::text;
      end if;
    end if;
  end if;
  if p_fields ? 'passportTaken' then
    if jsonb_typeof(p_fields -> 'passportTaken') not in ('boolean', 'null') then
      v_bad := v_bad || 'passportTaken'::text;
    else
      v_taken := coalesce((p_fields ->> 'passportTaken')::boolean, false);
    end if;
  end if;
  if v_taken and (v_passport or exists (
       select 1 from public.visa_applications a where a.id = any (v_ids)
         and coalesce(authz.visa_effective_kind(a, v_facts), v_kind_post) is distinct from 'sticker')) then
    v_bad := v_bad || 'passportTaken'::text;
  end if;
  v_paid := authz.b11_text(p_fields -> 'paidBy');
  if v_paid is null or v_paid not in ('company', 'customer_direct') then
    v_bad := v_bad || 'paidBy'::text;
  end if;
  v_mode := authz.b11_text(p_fields -> 'paymentMode');
  if (v_paid = 'company' and (v_mode is null or v_mode not in ('bank_transfer', 'upi', 'card', 'cash', 'other')))
     or (v_paid is distinct from 'company' and v_mode is not null and v_mode not in ('bank_transfer', 'upi', 'card', 'cash', 'other'))
     or (p_fields ? 'paymentMode' and jsonb_typeof(p_fields -> 'paymentMode') not in ('string', 'null')) then
    v_bad := v_bad || 'paymentMode'::text;
  end if;
  if p_fields ? 'receiptEvidenceId' and jsonb_typeof(p_fields -> 'receiptEvidenceId') <> 'null' then
    if jsonb_typeof(p_fields -> 'receiptEvidenceId') <> 'string'
       or (p_fields ->> 'receiptEvidenceId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_bad := v_bad || 'receiptEvidenceId'::text;
    else
      v_receipt := (p_fields ->> 'receiptEvidenceId')::uuid;
      if not exists (select 1 from public.department_evidence e
                     where e.id = v_receipt and e.task_id = v_task.id and e.kind = 'fee_receipt' and e.status = 'stored'
                       and (e.application_id is null or e.application_id = any (v_ids))) then
        v_bad := v_bad || 'receiptEvidenceId'::text;
      end if;
    end if;
  end if;
  if not authz.sf_text_ok(p_fields -> 'remark', 300, false) then
    v_bad := v_bad || 'remark'::text;
  end if;
  v_remark := authz.b11_text(p_fields -> 'remark');
  -- Per-applicant fields.
  for v_i in 0 .. v_n - 1 loop
    v_x := v_list -> v_i;
    v_bad := v_bad || array(select format('applicants[%s].%s', v_i, k)
                            from unnest(authz.b11_unknown_keys(v_x, array['applicationId', 'expectedRowVersion', 'reference',
                              'appliedOn', 'governmentFeePaise', 'serviceFeePaise'])) k);
    if not authz.sf_text_ok(v_x -> 'reference', 120, true) then
      v_bad := v_bad || format('applicants[%s].reference', v_i);
    end if;
    if authz.sf_date(v_x -> 'appliedOn') is null then
      v_bad := v_bad || format('applicants[%s].appliedOn', v_i);
    end if;
    if not (jsonb_typeof(v_x -> 'governmentFeePaise') in ('string', 'number')
            and (v_x ->> 'governmentFeePaise') ~ '^[1-9][0-9]{0,14}$') then
      v_bad := v_bad || format('applicants[%s].governmentFeePaise', v_i);
    end if;
    if coalesce(jsonb_typeof(v_x -> 'serviceFeePaise'), 'null') <> 'null'
       and not (jsonb_typeof(v_x -> 'serviceFeePaise') in ('string', 'number')
                and (v_x ->> 'serviceFeePaise') ~ '^[1-9][0-9]{0,14}$') then
      v_bad := v_bad || format('applicants[%s].serviceFeePaise', v_i);
    end if;
  end loop;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  -- V11: applied date never after today (IST).
  if exists (select 1 from jsonb_array_elements(v_list) x where authz.sf_date(x -> 'appliedOn') > v_today) then
    raise exception 'applied_date_in_future' using errcode = '22023';
  end if;
  -- QB10: references unique per task ignoring case (superseded rows included).
  for v_i in 0 .. v_n - 1 loop
    v_ref := authz.b11_text(v_list -> v_i -> 'reference');
    if exists (select 1 from generate_series(0, v_i - 1) j
               where lower(authz.b11_text(v_list -> j -> 'reference')) = lower(v_ref))
       or exists (select 1 from public.visa_applications a
                  where a.task_id = v_task.id and a.reference is not null and lower(a.reference) = lower(v_ref)
                    and a.id <> (v_list -> v_i ->> 'applicationId')::uuid) then
      raise exception 'duplicate_reference' using errcode = '23505', hint = format('applicants[%s].reference', v_i);
    end if;
  end loop;

  v_club := case when v_n > 1 then gen_random_uuid() end;
  v_status := case when v_paid = 'company' then case when v_receipt is not null then 'submitted' else 'draft' end end;
  for v_i in 0 .. v_n - 1 loop
    v_x := v_list -> v_i;
    select * into v_app from public.visa_applications a where a.id = (v_x ->> 'applicationId')::uuid;
    v_ref := authz.b11_text(v_x -> 'reference');
    v_on := authz.sf_date(v_x -> 'appliedOn');
    v_gov := (v_x ->> 'governmentFeePaise')::bigint;
    v_svc := case when coalesce(jsonb_typeof(v_x -> 'serviceFeePaise'), 'null') <> 'null' then (v_x ->> 'serviceFeePaise')::bigint end;
    v_kind := case when v_passport then null else coalesce(authz.visa_effective_kind(v_app, v_facts), v_kind_post) end;
    update public.visa_applications a
    set state = 'decision_pending', reference = v_ref, applied_on = v_on, submitted_at = now(), visa_kind = v_kind,
        jurisdiction_required = case when v_kind = 'sticker' then
            case when authz.visa_sales_jurisdiction(v_facts) is not null
                 then authz.visa_sales_jurisdiction(v_facts) = 'yes'
                 when v_jpost then v_jreq else a.jurisdiction_required end end,
        jurisdiction_place = case when v_kind = 'sticker' then
            case when authz.visa_sales_jurisdiction(v_facts) is not null
                 then (authz.visa_jurisdiction_json(a, v_facts) ->> 'place')
                 when v_jpost then v_jplace else a.jurisdiction_place end end,
        -- 20261202000140 (finding 2): custody as posted at Applied.
        passport_taken_at = case when v_taken then coalesce(a.passport_taken_at, now()) end,
        passport_taken_by = case when v_taken then coalesce(a.passport_taken_by, v_uid) end,
        applied_remark = v_remark, club_id = v_club, club_size = case when v_club is not null then v_n end,
        row_version = a.row_version + 1, updated_by = v_uid, updated_at = now()
    where a.id = v_app.id
    returning * into v_app;
    v_entries := '{}';
    foreach v_k in array array['government_fee', 'service_fee'] loop
      v_amount := case when v_k = 'government_fee' then v_gov else v_svc end;
      continue when v_amount is null;
      insert into public.department_cost_entries (task_id, deal_id, legal_entity_id, branch_id, department, cost_kind,
        amount_paise, paid_by, payment_mode, paid_on, reference, receipt_evidence_id, expense_status, submitted_by,
        submitted_at, request_id, created_by, application_id)
      values (v_task.id, v_task.deal_id, v_task.legal_entity_id, v_task.branch_id, 'visa', v_k, v_amount, v_paid,
        v_mode, v_on, v_ref, v_receipt, v_status,
        case when v_status = 'submitted' then v_uid end, case when v_status = 'submitted' then now() end,
        md5(p_request_id::text || v_app.id::text || v_k)::uuid, v_uid, v_app.id)
      returning id into v_entry;
      v_entries := v_entries || v_entry;
      perform authz.write_audit('department.cost_saved', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry',
        v_entry, null, jsonb_build_object('taskId', v_task.id, 'department', 'visa', 'costKind', v_k,
          'paidBy', v_paid, 'rowVersion', 1));
      if v_status = 'submitted' then
        perform authz.write_audit('department.cost_submitted', v_task.legal_entity_id, v_task.branch_id,
          'department_cost_entry', v_entry, null, jsonb_build_object('taskId', v_task.id, 'department', 'visa',
            'costKind', v_k, 'rowVersion', 1));
      end if;
    end loop;
    v_all_entries := v_all_entries || v_entries;
    perform authz.visa_audit('visa.application_applied', v_app.id, null, jsonb_build_object('clubId', v_club,
      'clubSize', case when v_club is not null then v_n end, 'visaKind', v_kind, 'passportTaken', v_taken,
      'paidBy', v_paid, 'entryIds', to_jsonb(v_entries), 'rowVersion', v_app.row_version));
    v_apps := v_apps || jsonb_build_object('applicationId', v_app.id, 'rowVersion', v_app.row_version, 'state', v_app.state);
  end loop;
  v_done := authz.visa_task_complete_if_done(v_task.id);
  v_result := jsonb_build_object('outcome', 'updated', 'clubId', v_club, 'applications', v_apps,
    'entryIds', to_jsonb(v_all_entries), 'taskCompleted', v_done);
  return authz.visa_remember(v_task.legal_entity_id, p_request_id, v_command, v_payload, v_result);
end;
$$;

create or replace function public.visa_application_reapply(p_application_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_app public.visa_applications%rowtype;
  v_command text := 'visa_application_reapply';
  v_payload jsonb := jsonb_build_object('applicationId', p_application_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_facts jsonb;
  v_new uuid := gen_random_uuid();
  v_was_closed boolean;
  v_cur public.booking_version_travellers%rowtype;
begin
  v_app := authz.visa_lock_application(p_application_id);
  v_result := authz.visa_replay(v_app.legal_entity_id, p_request_id, v_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.visa_require_open(v_app, false, true);
  -- Accounts phase 2 (20261204000330, LD12): no re-application after the cancellation is approved.
  if authz.deal_cancellation_approved(v_app.deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_app.row_version);
  if v_app.state <> 'refused' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  v_facts := authz.visa_task_facts(v_app.task_id);
  v_was_closed := v_app.closed_at is not null;
  if not v_was_closed then
    perform authz.visa_close(v_app.id, 'reapplied');
  end if;
  update public.visa_applications a
  set superseded_at = now(), superseded_by_id = v_new, row_version = a.row_version + 1,
      updated_by = (select auth.uid()), updated_at = now()
  where a.id = v_app.id;
  v_cur := authz.visa_current_traveller(v_app);
  insert into public.visa_applications (id, task_id, service_item_id, deal_id, legal_entity_id, traveller_seq, updated_by,
    traveller_name_snapshot, traveller_type_snapshot, reapplication_of_id, visa_kind, jurisdiction_required,
    jurisdiction_place, passport_taken_at, passport_taken_by)
  values (v_new, v_app.task_id, v_app.service_item_id, v_app.deal_id, v_app.legal_entity_id, v_app.traveller_seq,
    (select auth.uid()), v_cur.full_name, v_cur.traveller_type, v_app.id,
    case when authz.visa_sales_kind(v_facts) is null then v_app.visa_kind end,
    case when authz.visa_sales_jurisdiction(v_facts) is null then v_app.jurisdiction_required end,
    case when authz.visa_sales_jurisdiction(v_facts) is null then v_app.jurisdiction_place end,
    -- 20261202000140 (finding 2): custody carries over only while the passport is still with us.
    case when v_app.handover_method is null and v_app.documents_returned_at is null then v_app.passport_taken_at end,
    case when v_app.handover_method is null and v_app.documents_returned_at is null then v_app.passport_taken_by end);
  insert into public.visa_application_documents (legal_entity_id, task_id, application_id, catalogue_code, label, source,
    status, received_at, received_by, remark, added_by)
  select d.legal_entity_id, d.task_id, v_new, d.catalogue_code, d.label, 'copied', d.status, d.received_at, d.received_by,
         d.remark, (select auth.uid())
  from public.visa_application_documents d
  where d.application_id = v_app.id and d.removed_at is null
  order by d.created_at, d.id;
  perform authz.visa_audit('visa.application_reapplied', v_app.id, null, jsonb_build_object('newApplicationId', v_new));
  v_result := jsonb_build_object('outcome', 'created', 'applicationId', v_new, 'rowVersion', 1,
    'previousApplicationId', v_app.id, 'state', 'docs_pending', 'closed', false, 'taskCompleted', false);
  return authz.visa_remember(v_app.legal_entity_id, p_request_id, v_command, v_payload, v_result);
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

-- ===========================================================================
-- 6. Grants
-- ===========================================================================

revoke all on function
  authz.cancellation_needs_charges(uuid), authz.flight_cancellation_charges_json(uuid), authz.cancellation_charges_kept(uuid),
  authz.flight_can_enter_charge(uuid)
from public, anon, authenticated, service_role;
revoke all on function
  public.flight_cancellation_charge_set(uuid, jsonb, integer, uuid),
  public.visa_application_cancellation_choice(uuid, integer, text, text, uuid),
  public.visa_cancellation_fee_set(uuid, bigint, text, integer, uuid)
from public, anon, authenticated, service_role;
grant execute on function
  public.flight_cancellation_charge_set(uuid, jsonb, integer, uuid),
  public.visa_application_cancellation_choice(uuid, integer, text, text, uuid),
  public.visa_cancellation_fee_set(uuid, bigint, text, integer, uuid)
to authenticated;

commit;
