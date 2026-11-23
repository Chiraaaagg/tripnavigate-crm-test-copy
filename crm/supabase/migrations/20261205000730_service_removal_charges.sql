-- TripNavigate CRM - Accounts phase 3, track H (4 of 5): removing a booked
-- service - supplier charges, supplier refunds expected and payments.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 11.1, 11.3, 13,
-- 14, 17.1, 19, 21 LD29, LD30, LD32, Addendum L7.
--
-- Replaced (latest bodies, same signatures; changed lines marked
-- "Accounts phase 3 (20261205000730)"):
--   public.purchase_cancellation_charge_set (20261130000110),
--   public.flight_cancellation_charge_set (20261204000330),
--   public.visa_cancellation_fee_set (20261204000330): without a trip
--     cancellation a charge belongs to the remove_service request (route
--     cancellation) naming the service; the row carries change_request_id and
--     no cancellation_id (LD30: no deal_cancellations row). Purchase charges
--     stand once the Manager approved (already_decided); Flight keeps LD13
--     (afterwards only the reported refund changes); Visa as today. Results
--     gain changeRequestId (cancellationId null for a removal).
--   authz.cancellation_charges_missing (20261204000330): a closed task (and a
--     ticket batch of a closed cost task) needs no charge in a later trip
--     cancellation.
--   authz.sm_payment_create (20261205000640, track G): service_removed on a
--     closed task (Purchase and Flight); change_in_progress while a live
--     remove_service request names the service.
--   Track G's supplier-refund functions - NOT in the contract's H list, but
--     11.3 says the apply "writes supplier refund expectations from the charge
--     rows ... with change_request_id" (reported to the lead):
--   authz.supplier_refund_sources (20261205000650): + the charge rows of an
--     applied removal (source kinds purchase_charge / flight_charge / visa_fee,
--     cancellation_id null). Existing rows unchanged.
--   public.supplier_refund_record (20261205000650): such a source belongs to
--     its applied request (receipt change_request_id; proof subject = the
--     request; received on or after the request date).
--   public.supplier_refunds_due (20261205000650): + rows for those sources
--     (changeRequestId / changeRefNo); trip-cancellation rows only from the
--     cancellation's own sources.
--   public.refund_evidence_begin (20261205000680): the proof of such a refund
--     may be uploaded against the applied removal request.
--
-- Refusal tokens: service_removed (55000), change_in_progress (55000),
-- already_decided (55000), not_ready (55000, hint cancellation | sourceId),
-- version_changed, duplicate_request, invalid_input, not_authorized.
-- Audit: purchase.cancellation_charge_set, flight.cancellation_charge_set,
-- visa.cancellation_fee_set gain changeRequestId (ids only).
-- Rollback (forward-only): a NEW migration restoring the cited bodies.

begin;
set local lock_timeout = '15s';

-- Replaces 20261130000110_purchase_workflow_commands.sql:625 (latest body; changed lines marked).
create or replace function public.purchase_cancellation_charge_set(
  p_task_id uuid, p_keeps_paise bigint, p_refund_paise bigint, p_note text, p_credit_note_evidence_id uuid,
  p_expected_revision integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_c public.deal_cancellations%rowtype;
  v_existing public.purchase_cancellation_charges%rowtype;
  v_rev integer;
  v_cost public.purchase_cost_versions;
  v_supplier uuid;
  v_note text;
  v_cr public.booking_change_requests%rowtype;  -- Accounts phase 3 (20261205000730)
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or v_task.department is distinct from 'purchase' or not coalesce(authz.session_ok(), false)
     or not authz.holds_active_role('purchase', v_task.legal_entity_id)
     or (v_task.assignee_user_id is not null and v_task.assignee_user_id <> v_uid) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into v_c from public.deal_cancellations c where c.deal_id = v_task.deal_id for update;
  -- Accounts phase 3 (20261205000730): without a trip cancellation, the charge belongs to the
  -- live remove_service request (route cancellation) naming this service (11.3).
  -- Lock order 17.1: the task, then the request.
  if v_c.id is null then
    select r.* into v_cr from public.booking_change_requests r
    where r.deal_id = v_task.deal_id and r.kind = 'remove_service' and r.removal_route = 'cancellation'
      and v_task.service_item_id = any (r.item_ids) and r.status in ('requested', 'returned', 'approved', 'submitted')
    for update;
  end if;
  if v_c.id is null and v_cr.id is null then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  select * into v_existing from public.purchase_cancellation_charges x
  where x.legal_entity_id = v_task.legal_entity_id and x.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.task_id = v_task.id and v_existing.entered_by = v_uid
       and (v_existing.cancellation_id = v_c.id or v_existing.change_request_id = v_cr.id) then  -- Accounts phase 3 (20261205000730)
      return jsonb_build_object('cancellationId', v_c.id, 'revisionNo', v_existing.revision_no,
        'status', coalesce(v_c.status, 'charges_entered'), 'outcome', 'existing', 'changeRequestId', v_cr.id);
    end if;
    raise exception 'duplicate_request' using errcode = '23505';
  end if;
  if v_c.status = 'approved' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  -- Accounts phase 3 (20261205000730): the charges stand once the Manager approved the removal.
  if v_cr.id is not null and v_cr.status not in ('requested', 'returned') then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  select coalesce(max(x.revision_no), 0) into v_rev from public.purchase_cancellation_charges x
  where (x.cancellation_id = v_c.id or x.change_request_id = v_cr.id) and x.task_id = v_task.id;  -- Accounts phase 3 (20261205000730)
  if p_expected_revision is distinct from v_rev then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_cost := authz.purchase_latest_cost(v_task.id);
  if v_cost.id is null then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  select q.supplier_id into v_supplier from public.purchase_quotes q where q.id = v_cost.quote_id;
  if p_keeps_paise is null or p_refund_paise is null or p_keeps_paise < 0 or p_refund_paise < 0
     or p_keeps_paise > 999999999999999999 or p_refund_paise > 999999999999999999 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_note := authz.booking_fact_text(jsonb_build_object('note', p_note), 'note', 500, true);
  if p_credit_note_evidence_id is not null and not authz.cancellation_credit_note_ok(v_task.id, p_credit_note_evidence_id) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  insert into public.purchase_cancellation_charges (cancellation_id, legal_entity_id, task_id, revision_no, supplier_id,
    committed_cost_paise, supplier_keeps_paise, supplier_refund_paise, note, credit_note_evidence_id, entered_by, request_id,
    change_request_id)  -- Accounts phase 3 (20261205000730)
  values (v_c.id, v_task.legal_entity_id, v_task.id, v_rev + 1, v_supplier, v_cost.amount_paise, p_keeps_paise,
    p_refund_paise, v_note, p_credit_note_evidence_id, v_uid, p_request_id, v_cr.id);

  update public.deal_cancellations c
  set status = 'charges_entered', row_version = c.row_version + 1, updated_at = now()
  where c.id = v_c.id;

  perform authz.write_audit('purchase.cancellation_charge_set', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('cancellationId', v_c.id, 'revisionNo', v_rev + 1, 'previousStatus', v_c.status,
      'creditNote', p_credit_note_evidence_id is not null, 'changeRequestId', v_cr.id));  -- Accounts phase 3 (20261205000730)
  return jsonb_build_object('cancellationId', v_c.id, 'revisionNo', v_rev + 1, 'status', 'charges_entered',
    'outcome', 'created', 'changeRequestId', v_cr.id);
end;
$$;

-- Replaces 20261204000330_cancellation_flight_visa.sql:125 (latest body; changed lines marked).
create or replace function public.flight_cancellation_charge_set(p_batch_id uuid, p_fields jsonb, p_expected_revision integer,
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
  v_cr public.booking_change_requests%rowtype;  -- Accounts phase 3 (20261205000730)
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
  -- Accounts phase 3 (20261205000730): without a trip cancellation, the charge belongs to the
  -- live remove_service request (route cancellation) whose service this batch
  -- serves (its cost task or one of its sectors, 11.3). Who: the batch's cost-task
  -- owner, or any active Flight person while that task has no assignee (C9).
  if v_c.id is null then
    select r.* into v_cr from public.booking_change_requests r
    where r.deal_id = v_batch.deal_id and r.kind = 'remove_service' and r.removal_route = 'cancellation'
      and r.status in ('requested', 'returned', 'approved', 'submitted')
      and (exists (select 1 from public.fulfilment_tasks t where t.id = v_batch.cost_task_id and t.service_item_id = any (r.item_ids))
           or exists (select 1 from public.flight_sectors s where s.id = any (v_batch.sector_ids) and s.service_item_id = any (r.item_ids)))
    for update;
    if v_cr.id is null then
      raise exception 'not_ready' using errcode = '55000', hint = 'cancellation';
    end if;
    if not exists (select 1 from public.fulfilment_tasks t
                   where t.id = v_batch.cost_task_id
                     and (authz.flight_owns_task(t.id)
                          or (t.assignee_user_id is null and authz.holds_active_role('flight', t.legal_entity_id)))) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
  elsif not authz.flight_can_enter_charge(v_batch.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_existing from public.flight_cancellation_charges x
  where x.legal_entity_id = v_batch.legal_entity_id and x.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.batch_id = v_batch.id and v_existing.entered_by = v_uid
       and (v_existing.cancellation_id = v_c.id or v_existing.change_request_id = v_cr.id) then  -- Accounts phase 3 (20261205000730)
      return jsonb_build_object('outcome', 'existing', 'cancellationId', v_c.id, 'batchId', v_batch.id,
        'revisionNo', v_existing.revision_no, 'status', coalesce(v_c.status, 'charges_entered'), 'changeRequestId', v_cr.id);
    end if;
    raise exception 'duplicate_request' using errcode = '23505';
  end if;
  select * into v_prev from public.flight_cancellation_charges x
  where (x.cancellation_id = v_c.id or x.change_request_id = v_cr.id) and x.batch_id = v_batch.id  -- Accounts phase 3 (20261205000730)
  order by x.revision_no desc limit 1;
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
  if (v_c.status = 'approved' or v_cr.status in ('approved', 'submitted'))  -- Accounts phase 3 (20261205000730): the same after the removal was approved
     and (v_prev.id is null or v_airline is distinct from v_prev.airline_charge_paise
          or v_expected is distinct from v_prev.refund_expected_paise) then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_revision is distinct from v_rev then
    raise exception 'version_changed' using errcode = '40001';
  end if;

  insert into public.flight_cancellation_charges (cancellation_id, legal_entity_id, deal_id, batch_id, cost_task_id, supplier_id,
    revision_no, supplier_cost_paise, airline_charge_paise, refund_expected_paise, refund_reported_paise, note, entered_by, request_id,
    change_request_id)  -- Accounts phase 3 (20261205000730)
  values (v_c.id, v_batch.legal_entity_id, v_batch.deal_id, v_batch.id, v_batch.cost_task_id, v_batch.supplier_id, v_rev + 1,
    v_batch.supplier_cost_paise, v_airline, v_expected, v_reported, v_note, v_uid, p_request_id, v_cr.id);
  -- Purchase rule: a change before approval (also after sending) puts the case back to charges_entered.
  if v_c.status <> 'approved' then
    update public.deal_cancellations c
    set status = 'charges_entered', row_version = c.row_version + 1, updated_at = now()
    where c.id = v_c.id;
  end if;
  perform authz.write_audit('flight.cancellation_charge_set', v_batch.legal_entity_id, v_batch.branch_id,
    'flight_ticket_batch', v_batch.id, null,
    jsonb_build_object('cancellationId', v_c.id, 'batchId', v_batch.id, 'revisionNo', v_rev + 1, 'previousStatus', v_c.status,
      'changeRequestId', v_cr.id));  -- Accounts phase 3 (20261205000730)
  return jsonb_build_object('outcome', 'created', 'cancellationId', v_c.id, 'batchId', v_batch.id, 'revisionNo', v_rev + 1,
    'status', case when v_c.status = 'approved' or v_cr.status in ('approved', 'submitted') then 'approved' else 'charges_entered' end,
    'changeRequestId', v_cr.id);
end;
$$;

-- Replaces 20261204000330_cancellation_flight_visa.sql:303 (latest body; changed lines marked).
create or replace function public.visa_cancellation_fee_set(p_entry_id uuid, p_refund_expected_paise bigint, p_note text,
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
  v_cr public.booking_change_requests%rowtype;  -- Accounts phase 3 (20261205000730)
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
  -- Accounts phase 3 (20261205000730): without a trip cancellation, the fee refund belongs to the
  -- remove_service request (route cancellation) naming this Visa service, live or applied (11.3).
  if v_c.id is null then
    select r.* into v_cr from public.booking_change_requests r
    join public.fulfilment_tasks t on t.id = v_entry.task_id
    where r.deal_id = v_entry.deal_id and r.kind = 'remove_service' and r.removal_route = 'cancellation'
      and t.service_item_id = any (r.item_ids) and r.status in ('requested', 'returned', 'approved', 'submitted', 'applied')
    order by r.requested_at desc, r.id desc limit 1
    for share of r;
  end if;
  if (v_c.id is null and v_cr.id is null) or v_entry.paid_by <> 'company' then
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
  where (x.cancellation_id = v_c.id or x.change_request_id = v_cr.id) and x.entry_id = v_entry.id;  -- Accounts phase 3 (20261205000730)
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
    refund_expected_paise, note, entered_by, request_id, change_request_id)  -- Accounts phase 3 (20261205000730)
  values (v_c.id, v_entry.legal_entity_id, v_entry.deal_id, v_entry.task_id, v_entry.id, v_rev + 1, p_refund_expected_paise,
    v_note, v_uid, p_request_id, v_cr.id);
  perform authz.write_audit('visa.cancellation_fee_set', v_entry.legal_entity_id, v_entry.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('cancellationId', v_c.id, 'entryId', v_entry.id, 'revisionNo', v_rev + 1,
      'changeRequestId', v_cr.id));  -- Accounts phase 3 (20261205000730)
  return jsonb_build_object('outcome', 'created', 'entryId', v_entry.id, 'cancellationId', v_c.id, 'revisionNo', v_rev + 1,
    'changeRequestId', v_cr.id);
end;
$$;

-- Replaces 20261204000330_cancellation_flight_visa.sql:46 (latest body; changed lines marked).
create or replace function authz.cancellation_charges_missing(p_cancellation uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select (
    select count(*)::integer
    from public.deal_cancellations c
    join public.fulfilment_tasks t on t.deal_id = c.deal_id and t.department = 'purchase'
      and t.closed_state is null  -- Accounts phase 3 (20261205000730): a removed service is not open work
    where c.id = p_cancellation
      and exists (select 1 from public.purchase_cost_versions v where v.task_id = t.id)
      and not exists (select 1 from public.purchase_cancellation_charges x
                      where x.cancellation_id = c.id and x.task_id = t.id))
  -- Accounts phase 2 (20261204000330): ticket batches need a Flight charge too.
  + (
    select count(*)::integer
    from public.deal_cancellations c
    join public.flight_ticket_batches b on b.deal_id = c.deal_id
    join public.fulfilment_tasks ct on ct.id = b.cost_task_id and ct.closed_state is null  -- Accounts phase 3 (20261205000730)
    where c.id = p_cancellation
      and not exists (select 1 from public.flight_cancellation_charges y
                      where y.cancellation_id = c.id and y.batch_id = b.id))
$$;

-- Replaces 20261205000640_change_reconfirmation.sql:169 (latest body; changed lines marked).
create or replace function authz.sm_payment_create(p_task_id uuid, p_fields jsonb, p_request_id uuid, p_resubmits uuid, p_command text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_old public.supplier_payment_requests%rowtype;
  v_cost public.purchase_cost_versions;
  v_supplier uuid;
  v_quote_status text;
  v_gate text;
  v_payload jsonb;
  v_result jsonb;
  v_part text;
  v_amount bigint;
  v_due date;
  v_note text;
  v_proforma uuid;
  v_reason text;
  v_expected integer;
  v_budget bigint;
  v_live bigint;
  v_available bigint;
  v_funding bigint;
  v_route text;
  v_funding_route text;
  v_go_ahead uuid;
  v_id uuid := gen_random_uuid();
  v_ref text;
begin
  -- Flight build (20261201000210): flight tasks pay per ticket batch.
  if exists (select 1 from public.fulfilment_tasks t where t.id = p_task_id and t.department = 'flight') then
    -- Accounts phase 3 (20261205000730): a removed Flight service takes no new payment.
    if exists (select 1 from public.fulfilment_tasks t where t.id = p_task_id and t.closed_state is not null)
       and authz.flight_owns_task(p_task_id) then
      raise exception 'service_removed' using errcode = '55000';
    end if;
    return authz.sm_payment_create_flight(p_task_id, p_fields, p_request_id, p_resubmits, p_command);
  end if;

  -- 1. Who: the assignee of this Purchase task (unlocked read, then locks).
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or v_task.department is distinct from 'purchase' or not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.finance_lock_deal(v_task.deal_id);
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  -- Wait for an in-flight removal of the Deal so the gate reads its result.
  perform 1 from public.deals d where d.id = v_task.deal_id for key share;
  if not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Accounts phase 3 (20261205000730): a removed service takes no new payment (11.1); one
  -- being removed waits until the removal is settled.
  if v_task.closed_state is not null then
    raise exception 'service_removed' using errcode = '55000';
  end if;
  if exists (select 1 from public.booking_change_requests r
             where r.deal_id = v_task.deal_id and r.kind = 'remove_service' and v_task.service_item_id = any (r.item_ids)
               and r.status in ('requested', 'returned', 'approved', 'submitted')) then
    raise exception 'change_in_progress' using errcode = '55000';
  end if;
  v_gate := authz.procurement_gate_issue(v_task.id);
  if v_gate is not null then
    raise exception '%', v_gate using errcode = '55000';
  end if;

  v_payload := jsonb_build_object('taskId', p_task_id, 'resubmitsId', p_resubmits, 'fields', p_fields);
  v_result := authz.sm_replay(v_task.legal_entity_id, p_request_id, p_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;

  -- 2. Input.
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['expectedCostVersionNo', 'part', 'amountPaise', 'dueDate', 'note', 'proformaEvidenceId',
                          'askFunding', 'fundingReason']) <> '{}'::jsonb
     or jsonb_typeof(p_fields -> 'expectedCostVersionNo') is distinct from 'number'
     or (p_fields ->> 'expectedCostVersionNo') !~ '^[0-9]{1,9}$'
     or (p_fields ? 'askFunding' and jsonb_typeof(p_fields -> 'askFunding') not in ('boolean', 'null')) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_expected := (p_fields ->> 'expectedCostVersionNo')::integer;
  v_part := authz.finance_field(p_fields, 'part');
  v_amount := authz.finance_paise(p_fields, 'amountPaise', 1);
  v_due := authz.finance_date(authz.finance_field(p_fields, 'dueDate'));
  v_note := authz.finance_text(authz.finance_field(p_fields, 'note'), 1, 500, true);
  v_proforma := authz.finance_uuid(authz.finance_field(p_fields, 'proformaEvidenceId'));
  -- Optional note for Accounts (10-500), stored as the company funding
  -- reason only when funding is needed. askFunding is accepted and ignored
  -- (earlier clients): Purchase gets no customer money signal at all.
  v_reason := authz.finance_text(authz.finance_field(p_fields, 'fundingReason'), 10, 500, true);
  if v_part is null or v_part not in ('deposit', 'balance', 'full') or v_amount is null
     or v_amount > 999999999999999 or v_proforma is null
     or (v_due is not null and v_due not between date '2000-01-01' and date '2100-12-31') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  -- 3. The returned request being sent again.
  if p_resubmits is not null then
    select * into v_old from public.supplier_payment_requests p where p.id = p_resubmits for update;
    if v_old.id is null or v_old.task_id <> v_task.id then
      raise exception 'invalid_input' using errcode = '22023';
    end if;
    if v_old.status <> 'returned'
       or exists (select 1 from public.supplier_payment_requests p where p.resubmits_id = v_old.id) then
      raise exception 'already_decided' using errcode = '55000';
    end if;
  end if;

  -- 4. Business checks, in contract order.
  if authz.deal_trip_cancelled(v_task.deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  -- Accounts phase 3 (20261205000640): a change waiting for this supplier
  -- (pending or recorded reconfirmation) takes no new payment request.
  if exists (select 1 from public.task_reconfirmations x
             where x.task_id = v_task.id and x.status in ('pending', 'recorded')) then
    raise exception 'change_in_progress' using errcode = '55000';
  end if;
  v_cost := authz.purchase_agreed_cost(v_task.id);
  if v_cost.id is null then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if v_expected is distinct from v_cost.version_no then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  select q.supplier_id, q.status into v_supplier, v_quote_status
  from public.purchase_quotes q where q.id = v_cost.quote_id;
  if v_part in ('balance', 'full') and not authz.sm_task_confirmed(v_task.status) then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if not authz.sm_task_confirmed(v_task.status) then
    if v_quote_status is distinct from 'open' then
      raise exception 'not_ready' using errcode = '55000';
    end if;
    v_budget := authz.task_budget(v_task.id);
    if (v_budget is null or v_cost.amount_paise > v_budget)
       and not authz.cost_version_approved(v_task.id, v_cost.version_no) then
      raise exception 'over_budget' using errcode = '55000';
    end if;
    if authz.purchase_go_ahead_needed(v_task.id) then
      -- The booking request e-mail must have gone (sent or marked sent), not
      -- merely be queued or failed.
      if not authz.purchase_booking_request_sent(v_task.id) then
        raise exception 'booking_request_not_sent' using errcode = '55000';
      end if;
      if not authz.purchase_go_ahead_valid(v_task.id) then
        raise exception 'go_ahead_missing' using errcode = '55000';
      end if;
    end if;
  end if;
  if not exists (select 1 from public.supplier_money_evidence e
                 where e.id = v_proforma and e.task_id = v_task.id and e.kind = 'proforma' and e.status = 'stored') then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  select coalesce(sum(p.amount_paise), 0) into v_live from public.supplier_payment_requests p
  where p.task_id = v_task.id and p.status in ('pending', 'approved', 'paid', 'verified');
  if v_live + v_amount > v_cost.amount_paise then
    raise exception 'over_agreed_cost' using errcode = '55000';
  end if;
  -- Customer money (lead decision, review F1): Purchase gets no signal and
  -- no refusal. When the Deal's available customer money does not cover the
  -- amount, the company funding request for the difference is created here
  -- automatically; nothing in the reply depends on it.
  v_available := greatest(authz.sm_customer_money_available(v_task.deal_id, null), 0);
  v_funding := greatest(v_amount - v_available, 0);

  -- 5. Route: every live request for this supplier on this Deal, this one included.
  v_route := authz.sm_route(authz.sm_supplier_running_total(v_task.deal_id, v_supplier) + v_amount);
  select g.id into v_go_ahead from public.purchase_go_ahead_requests g
  where g.task_id = v_task.id and g.status = 'approved'
  order by g.decided_at desc nulls last, g.requested_at desc limit 1;

  v_ref := authz.sm_next_ref(v_task.legal_entity_id);
  insert into public.supplier_payment_requests (id, legal_entity_id, branch_id, deal_id, task_id, supplier_id, ref_no,
    cost_version_no, go_ahead_request_id, part, amount_paise, customer_money_paise, due_date, note,
    proforma_evidence_id, route, resubmits_id, request_id, requested_by)
  values (v_id, v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, v_supplier, v_ref,
    v_cost.version_no, v_go_ahead, v_part, v_amount, v_amount - v_funding, v_due, v_note,
    v_proforma, v_route, p_resubmits, p_request_id, v_uid);

  if v_funding > 0 then
    v_funding_route := authz.sm_route(authz.sm_funding_running_total(v_task.deal_id) + v_funding);
    insert into public.company_funding_requests (legal_entity_id, branch_id, deal_id, payment_request_id, amount_paise,
      reason, route, requested_by)
    values (v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_id, v_funding,
      coalesce(v_reason, 'No note from Purchase'), v_funding_route, v_uid);
  end if;

  perform authz.write_audit(case when p_resubmits is null then 'purchase.payment_requested' else 'purchase.payment_resubmitted' end,
    v_task.legal_entity_id, v_task.branch_id, 'fulfilment_task', v_task.id, null,
    jsonb_build_object('paymentRequestId', v_id, 'refNo', v_ref, 'part', v_part, 'route', v_route,
      'costVersionNo', v_cost.version_no, 'resubmitsId', p_resubmits));

  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'refNo', v_ref, 'route', v_route,
    'status', 'pending');
  return authz.sm_remember(v_task.legal_entity_id, p_request_id, p_command, v_payload, v_result);
end;
$$;

-- Replaces 20261205000650_change_supplier_refunds.sql:33 (latest body; changed lines marked).
create or replace function authz.supplier_refund_sources(p_deal uuid)
returns table (cancellation_id uuid, source_kind text, source_id uuid, source_group_id uuid, task_id uuid, supplier_id uuid,
               expected_paise bigint, received_paise bigint)
language sql stable security definer set search_path = '' as $$
  with c as (select x.id from public.deal_cancellations x where x.deal_id = p_deal),
  -- Accounts phase 3 (20261205000730): applied removals of a booked service (11.3, LD30).
  rm as (select x.id from public.booking_change_requests x
         where x.deal_id = p_deal and x.kind = 'remove_service' and x.removal_route = 'cancellation' and x.status = 'applied'),
  src as (
    select distinct on (pc.task_id) pc.cancellation_id, 'purchase_charge'::text as source_kind, pc.id as source_id,
      pc.task_id as source_group_id, pc.task_id, pc.supplier_id, pc.supplier_refund_paise as expected_paise
    from public.purchase_cancellation_charges pc join c on c.id = pc.cancellation_id
    order by pc.task_id, pc.revision_no desc
  ), fsrc as (
    select distinct on (fc.batch_id) fc.cancellation_id, 'flight_charge'::text, fc.id, fc.batch_id, fc.cost_task_id, fc.supplier_id,
      fc.refund_expected_paise
    from public.flight_cancellation_charges fc join c on c.id = fc.cancellation_id
    order by fc.batch_id, fc.revision_no desc
  ), vsrc as (
    select distinct on (vf.entry_id) vf.cancellation_id, 'visa_fee'::text, vf.entry_id, vf.entry_id, vf.task_id, null::uuid,
      vf.refund_expected_paise
    from public.visa_cancellation_fees vf join c on c.id = vf.cancellation_id
    order by vf.entry_id, vf.revision_no desc
  -- Accounts phase 3 (20261205000650): the latest applied reconfirmation per task (LD29).
  ), rsrc as (
    select distinct on (x.task_id) null::uuid, 'reconfirmation'::text, x.id, x.task_id, x.task_id, q.supplier_id,
      greatest(
        coalesce((select sum(p.amount_paise) from public.supplier_payment_requests p
                  where p.task_id = x.task_id and p.status = 'verified'), 0)
        - coalesce((select k.amount_paise from public.purchase_cost_versions k
                    where k.task_id = x.task_id and k.stage = 'committed' order by k.version_no desc limit 1), 0),
        0)::bigint
    from public.task_reconfirmations x
    join public.booking_change_requests r on r.id = x.change_request_id and r.status = 'applied'
    join public.fulfilment_tasks t on t.id = x.task_id
    left join public.purchase_quotes q on q.id = t.selected_quote_id
    where r.deal_id = p_deal and x.status = 'applied'
    order by x.task_id, r.applied_at desc, x.id desc
  -- Accounts phase 3 (20261205000730): the charge rows of an applied removal (cancellation_id null).
  ), csrc as (
    select distinct on (pc.task_id) null::uuid, 'purchase_charge'::text, pc.id, pc.task_id, pc.task_id, pc.supplier_id,
      pc.supplier_refund_paise
    from public.purchase_cancellation_charges pc join rm on rm.id = pc.change_request_id
    order by pc.task_id, pc.revision_no desc
  ), cfsrc as (
    select distinct on (fc.batch_id) null::uuid, 'flight_charge'::text, fc.id, fc.batch_id, fc.cost_task_id, fc.supplier_id,
      fc.refund_expected_paise
    from public.flight_cancellation_charges fc join rm on rm.id = fc.change_request_id
    order by fc.batch_id, fc.revision_no desc
  ), cvsrc as (
    select distinct on (vf.entry_id) null::uuid, 'visa_fee'::text, vf.entry_id, vf.entry_id, vf.task_id, null::uuid,
      vf.refund_expected_paise
    from public.visa_cancellation_fees vf join rm on rm.id = vf.change_request_id
    order by vf.entry_id, vf.revision_no desc
  ), u as (
    select * from src union all select * from fsrc union all select * from vsrc union all select * from rsrc
    union all select * from csrc union all select * from cfsrc union all select * from cvsrc
  )
  select v.* from (
    select u.cancellation_id, u.source_kind, u.source_id, u.source_group_id, u.task_id, u.supplier_id, u.expected_paise,
      coalesce((select sum(r.amount_paise) from public.supplier_refund_receipts r
                where r.deal_id = p_deal and r.source_kind = u.source_kind and r.source_group_id = u.source_group_id
                  and r.status = 'verified'), 0)::bigint as received_paise
    from u) v
  where v.source_kind <> 'reconfirmation' or v.expected_paise > 0 or v.received_paise > 0
$$;

-- Replaces 20261205000650_change_supplier_refunds.sql:80 (latest body; changed lines marked).
create or replace function public.supplier_refund_record(p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_payload jsonb := jsonb_build_object('fields', p_fields);
  v_result jsonb;
  v_key text;
  v_kind text;
  v_source uuid;
  v_deal public.deals%rowtype;
  v_src record;
  v_c public.deal_cancellations%rowtype;
  v_amount bigint;
  v_on_text text;
  v_on date;
  v_mode text;
  v_ref text;
  v_evidence uuid;
  v_over text;
  v_id uuid := gen_random_uuid();
  v_deal_id uuid;
  v_cr public.booking_change_requests%rowtype;  -- Accounts phase 3 (20261205000650)
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    perform authz.refund_invalid('fields');
  end if;
  v_kind := authz.refund_text(p_fields, 'sourceKind', 1, 30, false);
  -- Accounts phase 3 (20261205000650): + reconfirmation (a lower rate after a change, LD29).
  if v_kind is null or v_kind not in ('purchase_charge', 'flight_charge', 'visa_fee', 'reconfirmation') then
    perform authz.refund_invalid('sourceKind');
  end if;
  v_source := authz.refund_uuid(p_fields, 'sourceId');
  if v_source is null then
    perform authz.refund_invalid('sourceId');
  end if;
  v_deal_id := case v_kind
    when 'purchase_charge' then (select t.deal_id from public.purchase_cancellation_charges x
                                 join public.fulfilment_tasks t on t.id = x.task_id where x.id = v_source)
    when 'flight_charge' then (select x.deal_id from public.flight_cancellation_charges x where x.id = v_source)
    -- Accounts phase 3 (20261205000650)
    when 'reconfirmation' then (select t.deal_id from public.task_reconfirmations x
                                join public.fulfilment_tasks t on t.id = x.task_id where x.id = v_source)
    else (select e.deal_id from public.department_cost_entries e where e.id = v_source and e.department = 'visa') end;
  if v_deal_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_deal from public.deals d where d.id = v_deal_id;
  perform authz.finance_require_accounts(v_deal.legal_entity_id, v_deal.is_synthetic);
  if p_request_id is null then
    perform authz.refund_invalid('requestId');
  end if;
  perform authz.finance_lock_deal(v_deal.id);
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'supplier_refund_record', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  for v_key in select k from jsonb_object_keys(p_fields) k order by k loop
    if v_key <> all (array['sourceKind', 'sourceId', 'amountPaise', 'receivedOn', 'mode', 'reference', 'evidenceId',
                           'overExpectedReason']) then
      perform authz.refund_invalid(v_key);
    end if;
  end loop;
  -- Accounts phase 3 (20261205000650): a reconfirmation source belongs to its applied change request, not to a cancellation.
  if v_kind = 'reconfirmation' then
    select r.* into v_cr from public.booking_change_requests r
    join public.task_reconfirmations x on x.change_request_id = r.id
    where x.id = v_source and r.status = 'applied' for share of r;
    if v_cr.id is null then
      raise exception 'not_ready' using errcode = '55000', hint = 'sourceId';
    end if;
  else
  -- Accounts phase 3 (20261205000730): a charge of a removed booked service belongs to its applied
  -- remove_service request (cancellation_id null on the charge row, 11.3).
  select r.* into v_cr from public.booking_change_requests r
  where r.status = 'applied' and r.kind = 'remove_service'
    and r.id = case v_kind
      when 'purchase_charge' then (select x.change_request_id from public.purchase_cancellation_charges x where x.id = v_source)
      when 'flight_charge' then (select x.change_request_id from public.flight_cancellation_charges x where x.id = v_source)
      else (select t.closed_change_request_id from public.department_cost_entries e
            join public.fulfilment_tasks t on t.id = e.task_id
            where e.id = v_source
              and exists (select 1 from public.visa_cancellation_fees y
                          where y.entry_id = e.id and y.change_request_id = t.closed_change_request_id)) end
  for share of r;
  if v_cr.id is null then
  select * into v_c from public.deal_cancellations c where c.deal_id = v_deal.id for share;
  if v_c.id is null or v_c.status <> 'approved' then
    raise exception 'not_ready' using errcode = '55000', hint = 'cancellation';
  end if;
  end if;
  end if;
  -- The source must be the current one (latest revision; a Visa fee entry).
  select s.* into v_src from authz.supplier_refund_sources(v_deal.id) s
  where s.source_kind = v_kind and s.source_id = v_source
    and s.cancellation_id is not distinct from v_c.id  -- Accounts phase 3 (20261205000730): the case's own source
  limit 1;
  if v_src.source_id is null then
    if v_kind = 'visa_fee' then
      raise exception 'not_ready' using errcode = '55000', hint = 'sourceId';
    end if;
    perform authz.refund_invalid('sourceId');
  end if;
  if coalesce(v_src.expected_paise, 0) <= 0 then
    raise exception 'not_ready' using errcode = '55000', hint = 'sourceId';
  end if;
  v_amount := authz.refund_paise(p_fields, 'amountPaise');
  if v_amount is null or v_amount < 1 or v_amount > 999999999999 then
    perform authz.refund_invalid('amountPaise');
  end if;
  v_on_text := authz.refund_text(p_fields, 'receivedOn', 10, 10, false);
  if v_on_text is null or v_on_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    perform authz.refund_invalid('receivedOn');
  end if;
  begin
    v_on := v_on_text::date;
  exception when others then
    perform authz.refund_invalid('receivedOn');
  end;
  if v_on > authz.finance_today()
     or v_on < (coalesce(v_c.opened_at, case when v_kind = 'reconfirmation' then v_cr.applied_at else v_cr.requested_at end)
                at time zone 'Asia/Kolkata')::date then  -- Accounts phase 3 (20261205000730)  -- Accounts phase 3 (20261205000650)
    perform authz.refund_invalid('receivedOn');
  end if;
  v_mode := authz.refund_text(p_fields, 'mode', 1, 20, false);
  if v_mode is null or v_mode not in ('bank_transfer', 'upi', 'cheque', 'card_reversal', 'other') then
    perform authz.refund_invalid('mode');
  end if;
  v_ref := authz.refund_text(p_fields, 'reference', 1, 40, false);
  if v_ref is null or v_ref !~ '^[A-Za-z0-9/-]{4,40}$' then
    perform authz.refund_invalid('reference');
  end if;
  v_over := authz.refund_text(p_fields, 'overExpectedReason', 10, 500, true);
  v_evidence := authz.refund_uuid(p_fields, 'evidenceId');
  if v_evidence is null or not exists (
       select 1 from public.refund_evidence e
       where e.id = v_evidence and e.legal_entity_id = v_deal.legal_entity_id and e.subject_kind = 'supplier_refund'
         and e.subject_id = coalesce(v_c.id, v_cr.id) and e.status = 'stored')  -- Accounts phase 3 (20261205000650)
     or exists (select 1 from public.supplier_refund_receipts x where x.evidence_id = v_evidence) then
    raise exception 'evidence_missing' using errcode = '55000';
  end if;
  if v_src.received_paise + v_amount > v_src.expected_paise and v_over is null then
    raise exception 'over_expected' using errcode = '22023', hint = 'overExpectedReason';
  end if;

  insert into public.supplier_refund_receipts (id, legal_entity_id, branch_id, deal_id, cancellation_id, source_kind, source_id,
    task_id, source_group_id, supplier_id, amount_paise, received_on, mode, reference, evidence_id, over_expected_reason,
    status, recorded_by, recorded_at, verified_by, verified_at, request_id,
    change_request_id)  -- Accounts phase 3 (20261205000650)
  values (v_id, v_deal.legal_entity_id, v_deal.branch_id, v_deal.id, v_c.id, v_kind, v_source, v_src.task_id,
    v_src.source_group_id, v_src.supplier_id, v_amount, v_on, v_mode, v_ref, v_evidence,
    case when v_src.received_paise + v_amount > v_src.expected_paise then v_over end,
    'verified', v_uid, now(), v_uid, now(), p_request_id, v_cr.id);
  v_result := jsonb_build_object('outcome', 'created', 'supplierRefundId', v_id, 'status', 'verified', 'rowVersion', 1);
  perform authz.finance_remember(v_deal.legal_entity_id, p_request_id, 'supplier_refund_record', v_payload, v_result);
  perform authz.write_audit('accounts.supplier_refund.verified', v_deal.legal_entity_id, v_deal.branch_id, 'supplier_refund_receipt',
    v_id, null, jsonb_build_object('supplierRefundId', v_id, 'dealId', v_deal.id, 'cancellationId', v_c.id,
      'changeRequestId', v_cr.id,
      'sourceKind', v_kind, 'sourceId', v_source, 'mode', v_mode, 'overExpected', v_src.received_paise + v_amount > v_src.expected_paise));
  return v_result;
end;
$$;

-- Replaces 20261205000650_change_supplier_refunds.sql:227 (latest body; changed lines marked).
create or replace function public.supplier_refunds_due(p_filter jsonb, p_after text default null, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_a uuid[];
  v_syn boolean;
  v_filter jsonb := coalesce(p_filter, '{}'::jsonb);
  v_state text;
  v_ref text;
  v_branch uuid;
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
  if cardinality(v_a) = 0 then
    return null;
  end if;
  if jsonb_typeof(v_filter) <> 'object' then
    perform authz.refund_invalid('filter');
  end if;
  v_state := coalesce(nullif(v_filter ->> 'state', ''), 'open');
  if v_state not in ('open', 'all') then
    perform authz.refund_invalid('state');
  end if;
  begin
    v_ref := nullif(btrim(v_filter ->> 'dealReference'), '');
    v_branch := nullif(v_filter ->> 'branchId', '')::uuid;
    if p_after is not null then
      v_after_ts := split_part(p_after, '|', 1)::timestamptz;
      v_after_id := split_part(p_after, '|', 2)::uuid;
    end if;
  exception when others then
    perform authz.refund_invalid('filter');
  end;

  with cases as (
    select c.id, c.deal_id, c.decided_at, d.reference, b.name as branch_name
    from public.deal_cancellations c
    join public.deals d on d.id = c.deal_id
    join public.branches b on b.id = c.branch_id
    where c.status = 'approved' and c.legal_entity_id = any(v_a) and d.is_synthetic = v_syn
      and (v_ref is null or d.reference = v_ref)
      and (v_branch is null or c.branch_id = v_branch)
  ), src as (
    select k.*, s.source_kind, s.source_id, s.source_group_id, s.task_id, s.supplier_id, s.expected_paise, s.received_paise,
      null::uuid as change_request_id, null::text as change_ref_no
    from cases k cross join lateral authz.supplier_refund_sources(k.deal_id) s
    where s.expected_paise > 0 and (v_state = 'all' or s.received_paise < s.expected_paise)
      and s.cancellation_id = k.id  -- Accounts phase 3 (20261205000730): the trip cancellation's own sources
    -- Accounts phase 3 (20261205000650): lower rates after an applied change (LD29).
    union all
    select null::uuid, r.deal_id, r.applied_at, d.reference, b.name, s.source_kind, s.source_id, s.source_group_id, s.task_id,
      s.supplier_id, s.expected_paise, s.received_paise, r.id, r.ref_no
    -- Accounts phase 3 (20261205000730): + the charges of an applied removal of a booked service (11.3).
    from (select distinct q.deal_id from public.booking_change_requests q
          where q.status = 'applied' and q.legal_entity_id = any(v_a)
            and (exists (select 1 from public.task_reconfirmations x where x.change_request_id = q.id and x.status = 'applied')
                 or (q.kind = 'remove_service' and q.removal_route = 'cancellation'))) cd
    join public.deals d on d.id = cd.deal_id
    cross join lateral authz.supplier_refund_sources(cd.deal_id) s
    join public.booking_change_requests r on r.id = case s.source_kind
        when 'reconfirmation' then (select x.change_request_id from public.task_reconfirmations x where x.id = s.source_id)
        when 'purchase_charge' then (select x.change_request_id from public.purchase_cancellation_charges x where x.id = s.source_id)
        when 'flight_charge' then (select x.change_request_id from public.flight_cancellation_charges x where x.id = s.source_id)
        else (select t.closed_change_request_id from public.fulfilment_tasks t where t.id = s.task_id) end
    join public.branches b on b.id = r.branch_id
    where s.cancellation_id is null and d.is_synthetic = v_syn
      and (v_ref is null or d.reference = v_ref)
      and (v_branch is null or r.branch_id = v_branch)
      and s.expected_paise > 0 and (v_state = 'all' or s.received_paise < s.expected_paise)
  ), page as (
    select * from src
    where v_after_ts is null or (decided_at, source_id) < (v_after_ts, v_after_id)
    order by decided_at desc, source_id desc
    limit v_limit + 1
  ), numbered as (
    select p.*, row_number() over (order by p.decided_at desc, p.source_id desc) as n from page p
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'cancellationId', x.id, 'changeRequestId', x.change_request_id, 'changeRefNo', x.change_ref_no, 'dealId', x.deal_id, 'dealReference', x.reference, 'branchName', x.branch_name,
      'approvedAt', x.decided_at, 'sourceKind', x.source_kind, 'sourceId', x.source_id, 'taskId', x.task_id,
      'supplierId', x.supplier_id, 'supplierName', sp.name,
      'expectedPaise', x.expected_paise::text, 'receivedPaise', x.received_paise::text,
      'outstandingPaise', greatest(x.expected_paise - x.received_paise, 0)::text,
      'receipts', coalesce((
        select jsonb_agg(jsonb_build_object('id', r.id, 'amountPaise', r.amount_paise::text,
            'receivedOn', to_char(r.received_on, 'YYYY-MM-DD'), 'mode', r.mode, 'reference', r.reference, 'status', r.status,
            'rowVersion', r.row_version, 'recordedByName', rp.display_name) order by r.recorded_at, r.id)
        from public.supplier_refund_receipts r
        left join public.staff_profiles rp on rp.user_id = r.recorded_by
        where r.deal_id = x.deal_id and r.source_kind = x.source_kind and r.source_group_id = x.source_group_id), '[]'::jsonb),
      'cursor', to_char(x.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || x.source_id::text)
      order by x.n) filter (where x.n <= v_limit), '[]'::jsonb), count(*)::integer
  into v_rows, v_n
  from numbered x
  left join public.suppliers sp on sp.id = x.supplier_id;
  return jsonb_build_object(
    'items', (select coalesce(jsonb_agg(e - 'cursor'), '[]'::jsonb) from jsonb_array_elements(v_rows) e),
    'nextAfter', case when v_n > v_limit then (v_rows -> (v_limit - 1)) ->> 'cursor' end);
end;
$$;

-- Replaces 20261205000680_reconfirmation_refund_proof.sql:21 (latest body; changed lines marked).
create or replace function public.refund_evidence_begin(p_subject_kind text, p_subject_id uuid, p_file_name text, p_mime text,
  p_size_bytes integer, p_sha256 text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_req public.customer_refund_requests%rowtype;
  v_c public.deal_cancellations%rowtype;
  v_cr public.booking_change_requests%rowtype;  -- Accounts phase 3 (20261205000680)
  v_id uuid := gen_random_uuid();
  v_path text;
  v_name text := btrim(coalesce(p_file_name, ''));
  v_sha text := lower(coalesce(p_sha256, ''));
  v_payload jsonb := jsonb_build_object('subjectKind', p_subject_kind, 'subjectId', p_subject_id, 'fileName', p_file_name,
    'mime', p_mime, 'sizeBytes', p_size_bytes, 'sha256', p_sha256);
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_subject_kind = 'customer_refund' then
    select * into v_req from public.customer_refund_requests r where r.id = p_subject_id;
    select * into v_deal from public.deals d where d.id = v_req.deal_id;
  elsif p_subject_kind = 'supplier_refund' then
    select * into v_c from public.deal_cancellations c where c.id = p_subject_id;
    -- Accounts phase 3 (20261205000680): or an applied change request (a lower rate, LD29).
    if v_c.id is null then
      select * into v_cr from public.booking_change_requests r where r.id = p_subject_id;
    end if;
    select * into v_deal from public.deals d where d.id = coalesce(v_c.deal_id, v_cr.deal_id);
  else
    perform authz.refund_invalid('subjectKind');
  end if;
  if v_deal.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.finance_require_accounts(v_deal.legal_entity_id, v_deal.is_synthetic);
  if p_request_id is null then
    perform authz.refund_invalid('requestId');
  end if;
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'refund_evidence_begin', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_subject_kind = 'customer_refund' and (v_req.status <> 'approved' or v_req.outcome <> 'payout') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_subject_kind = 'supplier_refund' and v_c.id is not null and v_c.status <> 'approved' then
    raise exception 'not_ready' using errcode = '55000', hint = 'cancellation';
  end if;
  -- Accounts phase 3 (20261205000680): the change must be applied and leave a supplier refund expected.
  if p_subject_kind = 'supplier_refund' and v_c.id is null
     and (v_cr.status <> 'applied' or not (exists (
            select 1 from authz.supplier_refund_sources(v_cr.deal_id) s
            join public.task_reconfirmations x on x.id = s.source_id
            where s.source_kind = 'reconfirmation' and x.change_request_id = v_cr.id)
          -- Accounts phase 3 (20261205000730): or a removed booked service with a refund expected (11.3).
          or (v_cr.kind = 'remove_service' and (
                exists (select 1 from public.purchase_cancellation_charges x where x.change_request_id = v_cr.id and x.supplier_refund_paise > 0)
             or exists (select 1 from public.flight_cancellation_charges x where x.change_request_id = v_cr.id and x.refund_expected_paise > 0)
             or exists (select 1 from public.visa_cancellation_fees x where x.change_request_id = v_cr.id and x.refund_expected_paise > 0))))) then
    raise exception 'not_ready' using errcode = '55000', hint = 'sourceId';
  end if;
  if length(v_name) not between 1 and 120 or v_name !~ '^[A-Za-z0-9._ -]+$' then
    perform authz.refund_invalid('fileName');
  end if;
  if p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp') then
    perform authz.refund_invalid('mime');
  end if;
  if p_size_bytes is null or p_size_bytes not between 1 and 4194304 then
    perform authz.refund_invalid('sizeBytes');
  end if;
  if v_sha !~ '^[0-9a-f]{64}$' then
    perform authz.refund_invalid('sha256');
  end if;
  -- 20261204000360: at most 10 proofs not yet used by a payout or a supplier
  -- refund per subject (a cancellation case may need many supplier refunds).
  if (select count(*) from public.refund_evidence e
      where e.subject_kind = p_subject_kind and e.subject_id = p_subject_id and e.status in ('pending_upload', 'stored')
        and not exists (select 1 from public.customer_refund_payouts p where p.evidence_id = e.id)
        and not exists (select 1 from public.supplier_refund_receipts x where x.evidence_id = e.id)) >= 10 then
    perform authz.refund_invalid('file');
  end if;
  if exists (select 1 from public.refund_evidence e
             where e.legal_entity_id = v_deal.legal_entity_id and e.sha256 = v_sha and e.status in ('pending_upload', 'stored')) then
    raise exception 'duplicate_file' using errcode = '23505';
  end if;
  v_path := v_deal.legal_entity_id::text || '/refund/' || p_subject_id::text || '/' || v_id::text;
  begin
    insert into public.refund_evidence (id, legal_entity_id, deal_id, subject_kind, subject_id, object_path, file_name, mime,
      size_bytes, sha256, uploaded_by, request_id)
    values (v_id, v_deal.legal_entity_id, v_deal.id, p_subject_kind, p_subject_id, v_path, v_name, p_mime, p_size_bytes, v_sha,
      (select auth.uid()), p_request_id);
  exception when unique_violation then
    raise exception 'duplicate_file' using errcode = '23505';
  end;
  v_result := jsonb_build_object('outcome', 'created', 'evidenceId', v_id, 'objectPath', v_path);
  return authz.finance_remember(v_deal.legal_entity_id, p_request_id, 'refund_evidence_begin', v_payload, v_result);
end;
$$;

-- The replaced functions keep their grants (CREATE OR REPLACE).

commit;
