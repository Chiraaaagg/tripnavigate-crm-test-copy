-- TripNavigate CRM - Purchase build, track A (2 of 3): commands for rates,
-- supplier e-mails, the booking request with its hotel go-ahead, and trip
-- cancellation charges. Schema and helpers: 20261130000100.
--
-- New commands (SECURITY DEFINER, search_path '', execute to authenticated,
-- one transaction each with its audit row; audit rows carry no amounts, bank
-- values or e-mail text):
--   purchase_email_record            rate request e-mail (assignee)
--   purchase_email_mark_result       provider result of a queued e-mail (service_role only)
--   purchase_booking_request_send    booking request + hotel go-ahead request (assignee)
--   purchase_go_ahead_decide         Accounts approves or returns
--   deal_cancellation_open           branch Manager: "Trip cancelled"
--   purchase_cancellation_charge_set Purchase: supplier keeps / refunds
--   deal_cancellation_send           Purchase: send charges to the Manager
--   deal_cancellation_decide         branch Manager approves or returns
-- Replaced (latest bodies copied; changed lines marked "Purchase build"):
--   purchase_quote_add      (20261005000100) per-room-night rate, note, transfer/activity suppliers
--   purchase_cost_propose   (20261005000100) refuses payment_in_progress and trip_cancelled
--   purchase_supplier_confirm (20261107000300) names trip_cancelled,
--                            booking_request_not_sent and go_ahead_missing
--
-- Refusal tokens (message = token): not_authorized 42501, not_self_approval
-- 42501, not_found P0002, version_changed 40001, task_conflict 40001,
-- invalid_input 22023, duplicate_request 23505, and 55000 for not_ready,
-- over_budget, already_confirmed, already_decided, trip_cancelled,
-- payment_in_progress, booking_not_approved, go_ahead_missing,
-- booking_request_not_sent, environment_unset, procurement_disabled,
-- deal_removed, not_configured.
--
-- Rollback (forward-only): a new migration revoking execute on the new
-- functions and restoring the three replaced bodies.

begin;
set local lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- Offers (replaces 20261005000100)
-- ---------------------------------------------------------------------------

create or replace function public.purchase_quote_add(p_task_id uuid, p_request_id uuid, p_fields jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_existing uuid;
  v_supplier public.suppliers%rowtype;
  v_cost bigint;
  v_per_night bigint;
  v_id uuid;
begin
  v_task := authz.lock_workable_task(p_task_id);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select q.id into v_existing from public.purchase_quotes q where q.task_id = v_task.id and q.request_id = p_request_id;
  if v_existing is not null then
    return jsonb_build_object('quoteId', v_existing, 'created', false);
  end if;
  -- Purchase build: perRoomNightPaise and note are accepted.
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['supplierId', 'hotelName', 'roomType', 'mealPlan', 'quotedCostPaise', 'holdUntil',
                          'cancellationTerms', 'perRoomNightPaise', 'note']) <> '{}'::jsonb
     or jsonb_typeof(p_fields -> 'supplierId') is distinct from 'string'
     or (p_fields ->> 'supplierId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into v_supplier from public.suppliers s
  where s.id = (p_fields ->> 'supplierId')::uuid and s.legal_entity_id = v_task.legal_entity_id;
  -- Purchase build: the supplier offers the task's service type (hotel, transfer or activity).
  if v_supplier.id is null or v_supplier.status <> 'active' or not (v_task.service_purpose = any (v_supplier.service_types)) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_cost := authz.booking_fact_paise(p_fields, 'quotedCostPaise');
  if v_cost is null or v_cost <= 0 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_per_night := authz.booking_fact_paise(p_fields, 'perRoomNightPaise');
  if v_per_night is not null and (v_per_night <= 0 or v_task.service_purpose <> 'hotel') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  begin
    insert into public.purchase_quotes (task_id, legal_entity_id, supplier_id, request_id, hotel_name, room_type,
      meal_plan, quoted_cost_paise, hold_until, cancellation_terms, per_room_night_paise, note, created_by)
    values (v_task.id, v_task.legal_entity_id, v_supplier.id, p_request_id,
      authz.booking_fact_text(p_fields, 'hotelName', 200, false),
      authz.booking_fact_text(p_fields, 'roomType', 120, false),
      authz.booking_fact_text(p_fields, 'mealPlan', 60, false),
      v_cost,
      authz.booking_fact_date(p_fields, 'holdUntil'),
      authz.booking_fact_text(p_fields, 'cancellationTerms', 2000, true),
      v_per_night,
      authz.booking_fact_text(p_fields, 'note', 300, true),
      (select auth.uid()))
    returning id into v_id;
  exception when check_violation or not_null_violation then
    raise exception 'invalid_input' using errcode = '22023';
  end;

  perform authz.write_audit('purchase.quote_added', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null, jsonb_build_object('quoteId', v_id, 'supplierId', v_supplier.id));
  return jsonb_build_object('quoteId', v_id, 'created', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Final rate (replaces 20261005000100)
-- ---------------------------------------------------------------------------

create or replace function public.purchase_cost_propose(
  p_task_id uuid, p_quote_id uuid, p_expected_version_no integer, p_amount_paise bigint, p_due_date date,
  p_note text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_existing public.purchase_cost_versions%rowtype;
  v_latest integer;
  v_note text;
begin
  v_task := authz.lock_workable_task(p_task_id);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into v_existing from public.purchase_cost_versions c
  where c.task_id = v_task.id and c.request_id = p_request_id;
  if v_existing.id is not null then
    return jsonb_build_object('versionNo', v_existing.version_no, 'created', false);
  end if;
  -- Purchase build: a cancelled trip takes no new rate; an open supplier
  -- payment request freezes the rate it was made for.
  if authz.deal_trip_cancelled(v_task.deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  if authz.purchase_has_live_payment(v_task.id) then
    raise exception 'payment_in_progress' using errcode = '55000';
  end if;
  select coalesce(max(c.version_no), 0) into v_latest from public.purchase_cost_versions c where c.task_id = v_task.id;
  if p_expected_version_no is distinct from v_latest then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if not exists (select 1 from public.purchase_quotes q
                 where q.id = p_quote_id and q.task_id = v_task.id and q.status = 'open') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_amount_paise is null or p_amount_paise <= 0 or p_amount_paise > 999999999999999999
     or (p_due_date is not null and p_due_date not between date '2000-01-01' and date '2100-12-31') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_note := authz.booking_fact_text(jsonb_build_object('note', p_note), 'note', 500, true);

  insert into public.purchase_cost_versions (task_id, legal_entity_id, version_no, quote_id, request_id, stage,
    amount_paise, due_date, note, created_by)
  values (v_task.id, v_task.legal_entity_id, v_latest + 1, p_quote_id, p_request_id, 'proposed',
    p_amount_paise, p_due_date, v_note, (select auth.uid()));

  -- Amounts stay out of the audit trail.
  perform authz.write_audit('purchase.cost_proposed', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null, jsonb_build_object('versionNo', v_latest + 1, 'quoteId', p_quote_id));
  return jsonb_build_object('versionNo', v_latest + 1, 'created', true);
end;
$$;

-- ---------------------------------------------------------------------------
-- Supplier confirmation (replaces 20261107000300)
-- ---------------------------------------------------------------------------

create or replace function public.purchase_supplier_confirm(p_task_id uuid, p_expected_version_no integer, p_reference text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_cost public.purchase_cost_versions;
  v_proposal public.purchase_cost_versions;
  v_ref text := btrim(coalesce(p_reference, ''));
  v_issues text[];
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Stage 0: wait for an in-flight removal of the Deal (it holds FOR UPDATE)
  -- so the gate below reads its committed result.
  perform 1 from public.deals d where d.id = v_task.deal_id for key share;
  -- The first confirmation already stores its identity in immutable cost history.
  -- The committed version is NEW: retries must name the accepted PROPOSED
  -- version, not the current committed version. That proposal also fixes the offer.
  if v_task.status = 'supplier_confirmed' then
    v_cost := authz.purchase_latest_cost(v_task.id);
    select * into v_proposal from public.purchase_cost_versions c
      where c.task_id = v_task.id and c.version_no = p_expected_version_no;
    if v_task.supplier_reference = v_ref
       and v_cost.stage = 'committed'
       and p_expected_version_no = v_cost.version_no - 1
       and v_proposal.stage = 'proposed'
       and v_proposal.quote_id = v_cost.quote_id
       and v_proposal.quote_id = v_task.selected_quote_id then
      return jsonb_build_object('outcome', 'existing', 'taskId', v_task.id);
    end if;
    raise exception 'task_conflict' using errcode = '40001';
  end if;
  if length(v_ref) not between 1 and 120 or v_ref ~ E'[\\x01-\\x1f\\x7f]' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_cost := authz.purchase_latest_cost(v_task.id);
  if v_cost.id is not null and p_expected_version_no is distinct from v_cost.version_no then
    raise exception 'version_changed' using errcode = '40001';
  end if;

  v_issues := authz.procurement_issues(v_task.id);
  if 'environment_unset' = any (v_issues) then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  -- Stage 0: a Deal removed by the Bitrix sync takes no new commitment.
  if 'deal_removed' = any (v_issues) then
    raise exception 'deal_removed' using errcode = '55000';
  end if;
  if 'procurement_disabled' = any (v_issues) then
    raise exception 'procurement_disabled' using errcode = '55000';
  end if;
  -- Purchase build: a cancelled trip takes no new commitment.
  if 'trip_cancelled' = any (v_issues) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  if v_issues = array['over_budget'] then
    raise exception 'over_budget' using errcode = '55000';
  end if;
  -- Purchase build: when only the booking request or the Accounts go-ahead is
  -- missing, name it (booking request first: it starts the go-ahead).
  if cardinality(v_issues) > 0 and v_issues <@ array['booking_request_not_sent', 'go_ahead_missing'] then
    if 'booking_request_not_sent' = any (v_issues) then
      raise exception 'booking_request_not_sent' using errcode = '55000';
    end if;
    raise exception 'go_ahead_missing' using errcode = '55000';
  end if;
  if cardinality(v_issues) > 0 then
    raise exception 'not_ready' using errcode = '55000';
  end if;

  insert into public.purchase_cost_versions (task_id, legal_entity_id, version_no, quote_id, request_id, stage,
    amount_paise, due_date, note, created_by)
  values (v_task.id, v_task.legal_entity_id, v_cost.version_no + 1, v_cost.quote_id, gen_random_uuid(), 'committed',
    v_cost.amount_paise, v_cost.due_date, v_cost.note, (select auth.uid()));
  update public.purchase_quotes q set status = 'selected', updated_at = now() where q.id = v_cost.quote_id;
  update public.fulfilment_tasks t
  set status = 'supplier_confirmed', selected_quote_id = v_cost.quote_id, supplier_reference = v_ref,
      supplier_confirmed_by = (select auth.uid()), supplier_confirmed_at = now(), updated_at = now()
  where t.id = v_task.id;

  insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
  values (v_task.legal_entity_id, 'fulfilment_task', v_task.id, 'fulfilment.supplier_confirmed',
    jsonb_build_object('task_id', v_task.id, 'deal_id', v_task.deal_id, 'service_purpose', v_task.service_purpose))
  on conflict (event_type, aggregate_id) do nothing;

  perform authz.write_audit('purchase.supplier_confirmed', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('quoteId', v_cost.quote_id, 'committedVersionNo', v_cost.version_no + 1));
  return jsonb_build_object('outcome', 'created', 'taskId', v_task.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Rate request e-mail (owner decision 5)
-- ---------------------------------------------------------------------------

-- Records a rate request to a supplier of the task's service type. Switch
-- off: status marked_sent (the person sent it from their own e-mail app).
-- Switch on: status queued; the server then calls the provider and records
-- the result with purchase_email_mark_result. Allowed before the go-ahead.
create function public.purchase_email_record(
  p_task_id uuid, p_kind text, p_supplier_id uuid, p_to text, p_cc text[], p_subject text, p_body text,
  p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_existing public.purchase_supplier_emails%rowtype;
  v_supplier public.suppliers%rowtype;
  v_mail jsonb;
  v_status text;
  v_id uuid;
begin
  v_task := authz.lock_workable_task(p_task_id);
  if p_request_id is null or p_kind is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into v_existing from public.purchase_supplier_emails e
  where e.legal_entity_id = v_task.legal_entity_id and e.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.task_id = v_task.id and v_existing.kind = p_kind and v_existing.supplier_id = p_supplier_id
       and v_existing.sent_by = (select auth.uid()) then
      return jsonb_build_object('emailId', v_existing.id, 'status', v_existing.status, 'outcome', 'existing');
    end if;
    raise exception 'duplicate_request' using errcode = '23505';
  end if;
  -- Booking requests go through purchase_booking_request_send (go-ahead).
  if p_kind <> 'rate_request' or p_supplier_id is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into v_supplier from public.suppliers s
  where s.id = p_supplier_id and s.legal_entity_id = v_task.legal_entity_id;
  if v_supplier.id is null or v_supplier.status <> 'active' or not (v_task.service_purpose = any (v_supplier.service_types)) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_mail := authz.supplier_email_normalize(p_to, p_cc, p_subject, p_body);
  v_status := case when authz.supplier_email_sending_enabled() then 'queued' else 'marked_sent' end;

  insert into public.purchase_supplier_emails (legal_entity_id, task_id, deal_id, kind, supplier_id, to_email,
    cc_emails, subject, body, status, sent_by, request_id)
  values (v_task.legal_entity_id, v_task.id, v_task.deal_id, 'rate_request', v_supplier.id, v_mail ->> 'to',
    array(select jsonb_array_elements_text(v_mail -> 'cc')), v_mail ->> 'subject', v_mail ->> 'body', v_status,
    (select auth.uid()), p_request_id)
  returning id into v_id;

  perform authz.write_audit('purchase.rate_request_recorded', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('emailId', v_id, 'supplierId', v_supplier.id, 'status', v_status));
  return jsonb_build_object('emailId', v_id, 'status', v_status, 'outcome', 'created');
end;
$$;

-- Server follow-up after the provider call for a queued e-mail. Executable
-- by service_role only: the server action calls it with the privileged
-- client, only after purchase_email_record / purchase_booking_request_send
-- queued the e-mail under the person's own session and only with the real
-- provider response (modules README rule 3). No API role may mark an e-mail
-- sent. The provider id must have the provider's id shape (a UUID).
create function public.purchase_email_mark_result(
  p_email_id uuid, p_status text, p_provider_id text, p_failure text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_e public.purchase_supplier_emails%rowtype;
  v_branch uuid;
  v_provider text := nullif(btrim(coalesce(p_provider_id, '')), '');
  v_failure text;
begin
  select * into v_e from public.purchase_supplier_emails e where e.id = p_email_id for update;
  if v_e.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_status is null or p_status not in ('sent', 'failed') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if v_e.status = p_status then
    return jsonb_build_object('emailId', v_e.id, 'status', v_e.status, 'outcome', 'existing');
  end if;
  if v_e.status <> 'queued' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_status = 'sent' then
    if v_provider is null
       or v_provider !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid_input' using errcode = '22023';
    end if;
  else
    -- A short reason code (never shown to staff as provider text).
    v_failure := left(btrim(regexp_replace(coalesce(p_failure, ''), E'[\\x01-\\x1f\\x7f]+', ' ', 'g')), 500);
    if v_failure = '' then
      v_failure := 'send_failed';
    end if;
    v_provider := null;
  end if;

  update public.purchase_supplier_emails e
  set status = p_status, provider_message_id = v_provider, failure = v_failure, result_at = now()
  where e.id = v_e.id;

  select t.branch_id into v_branch from public.fulfilment_tasks t where t.id = v_e.task_id;
  perform authz.write_audit(case when p_status = 'sent' then 'purchase.supplier_email_sent' else 'purchase.supplier_email_failed' end,
    v_e.legal_entity_id, v_branch, 'fulfilment_task', v_e.task_id, null,
    jsonb_build_object('emailId', v_e.id, 'kind', v_e.kind, 'sentBy', v_e.sent_by));
  return jsonb_build_object('emailId', v_e.id, 'status', p_status, 'outcome', 'created');
end;
$$;

-- ---------------------------------------------------------------------------
-- Booking request + hotel go-ahead request (owner decision 1)
-- ---------------------------------------------------------------------------

-- "Send booking request": in one transaction records the booking request
-- e-mail for the latest final rate and, for a hotel task, a pending go-ahead
-- request to Accounts bound to {task, current accepted booking version,
-- offer, cost version, amount} unless a pending or approved request for the
-- same binding exists. A stale pending request is superseded.
create function public.purchase_booking_request_send(
  p_task_id uuid, p_expected_cost_version_no integer, p_to text, p_cc text[], p_subject text, p_body text,
  p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_existing public.purchase_supplier_emails%rowtype;
  v_cost public.purchase_cost_versions;
  v_quote public.purchase_quotes%rowtype;
  v_budget bigint;
  v_mail jsonb;
  v_status text;
  v_email uuid;
  v_version uuid;
  v_req uuid;
  v_superseded uuid[];
begin
  v_task := authz.lock_workable_task(p_task_id);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into v_existing from public.purchase_supplier_emails e
  where e.legal_entity_id = v_task.legal_entity_id and e.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.task_id = v_task.id and v_existing.kind = 'booking_request' and v_existing.sent_by = v_uid
       and v_existing.cost_version_no is not distinct from p_expected_cost_version_no then
      return jsonb_build_object('emailId', v_existing.id, 'status', v_existing.status, 'outcome', 'existing',
        'goAheadRequestId', (select r.id from public.purchase_go_ahead_requests r
                             where r.task_id = v_task.id and r.email_id = v_existing.id),
        'goAheadState', authz.purchase_go_ahead_state(v_task.id));
    end if;
    raise exception 'duplicate_request' using errcode = '23505';
  end if;
  if authz.deal_trip_cancelled(v_task.deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  v_cost := authz.purchase_latest_cost(v_task.id);
  if v_cost.id is null then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if p_expected_cost_version_no is distinct from v_cost.version_no then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  select * into v_quote from public.purchase_quotes q where q.id = v_cost.quote_id;
  if v_cost.stage <> 'proposed' or v_quote.status <> 'open' then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  v_budget := authz.task_budget(v_task.id);
  if (v_budget is null or v_cost.amount_paise > v_budget)
     and not authz.cost_version_approved(v_task.id, v_cost.version_no) then
    raise exception 'over_budget' using errcode = '55000';
  end if;
  v_mail := authz.supplier_email_normalize(p_to, p_cc, p_subject, p_body);
  v_status := case when authz.supplier_email_sending_enabled() then 'queued' else 'marked_sent' end;

  insert into public.purchase_supplier_emails (legal_entity_id, task_id, deal_id, kind, supplier_id, to_email,
    cc_emails, subject, body, quote_id, cost_version_no, amount_paise, status, sent_by, request_id)
  values (v_task.legal_entity_id, v_task.id, v_task.deal_id, 'booking_request', v_quote.supplier_id, v_mail ->> 'to',
    array(select jsonb_array_elements_text(v_mail -> 'cc')), v_mail ->> 'subject', v_mail ->> 'body',
    v_cost.quote_id, v_cost.version_no, v_cost.amount_paise, v_status, v_uid, p_request_id)
  returning id into v_email;

  if authz.purchase_go_ahead_needed(v_task.id) then
    v_version := authz.task_current_version(v_task.id);
    -- An approved request whose booking review was since returned no longer
    -- counts (authz.purchase_go_ahead_valid): a new pending request is made.
    -- A pending request whose booking e-mail is still queued or failed is
    -- superseded below by a new pending request linked to this e-mail, so
    -- Accounts always decides on a booking request that went out.
    select r.id into v_req from public.purchase_go_ahead_requests r
    where r.task_id = v_task.id
      and ((r.status = 'pending' and exists (select 1 from public.purchase_supplier_emails e
                                             where e.id = r.email_id and e.status in ('sent', 'marked_sent')))
           or (r.status = 'approved' and exists (select 1 from public.accounts_booking_reviews b
                                                 where b.booking_version_id = r.booking_version_id and b.status = 'approved')))
      and r.booking_version_id = v_version and r.cost_version_no = v_cost.version_no and r.quote_id = v_cost.quote_id
    order by (r.status = 'pending') desc, r.requested_at desc, r.id desc limit 1;
    if v_req is null then
      with s as (
        update public.purchase_go_ahead_requests r set status = 'superseded', row_version = r.row_version + 1
        where r.task_id = v_task.id and r.status = 'pending'
        returning r.id)
      select coalesce(array_agg(s.id), '{}'::uuid[]) into v_superseded from s;
      insert into public.purchase_go_ahead_requests (legal_entity_id, branch_id, deal_id, task_id, booking_version_id,
        quote_id, cost_version_no, amount_paise, requested_by, email_id, request_id)
      values (v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, v_version,
        v_cost.quote_id, v_cost.version_no, v_cost.amount_paise, v_uid, v_email, p_request_id)
      returning id into v_req;
      perform authz.write_audit('purchase.go_ahead_requested', v_task.legal_entity_id, v_task.branch_id,
        'fulfilment_task', v_task.id, null,
        jsonb_build_object('goAheadRequestId', v_req, 'costVersionNo', v_cost.version_no,
          'bookingVersionId', v_version, 'supersededRequestIds', to_jsonb(v_superseded)));
    end if;
  end if;

  perform authz.write_audit('purchase.booking_request_recorded', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('emailId', v_email, 'supplierId', v_quote.supplier_id, 'costVersionNo', v_cost.version_no,
      'status', v_status, 'goAheadRequestId', v_req));
  return jsonb_build_object('emailId', v_email, 'status', v_status, 'outcome', 'created',
    'goAheadRequestId', v_req, 'goAheadState', authz.purchase_go_ahead_state(v_task.id));
end;
$$;

-- Accounts approves or returns a hotel go-ahead. Accounts of the entity
-- (authz.finance_require_accounts: never a Purchase holder), never the
-- requester or a Sales person of the Deal. Approve needs the request to be
-- current and the Accounts booking review of that version approved.
create function public.purchase_go_ahead_decide(
  p_request uuid, p_decision text, p_reason text, p_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_r public.purchase_go_ahead_requests%rowtype;
  v_task_id uuid;
  v_synthetic boolean;
  v_reason text;
  v_status text;
begin
  select * into v_r from public.purchase_go_ahead_requests r where r.id = p_request;
  if v_r.id is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = v_r.deal_id;
  perform authz.finance_require_accounts(v_r.legal_entity_id, v_synthetic);
  -- Review F2: the Deal's finance lock first (the lock accounts_review_approve
  -- and accounts_review_return take), so the booking review cannot change
  -- between the check below and this decision. Then the task, then the request.
  perform authz.finance_lock_deal(v_r.deal_id);
  v_task_id := v_r.task_id;
  perform 1 from public.fulfilment_tasks t where t.id = v_task_id for share;
  select * into v_r from public.purchase_go_ahead_requests r where r.id = p_request for update;
  if p_request_id is null or p_decision is null or p_decision not in ('approve', 'return') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_status := case p_decision when 'approve' then 'approved' else 'returned' end;
  if v_r.status in ('approved', 'returned') then
    if v_r.decision_request_id = p_request_id and v_r.decided_by = v_uid and v_r.status = v_status then
      return jsonb_build_object('requestId', v_r.id, 'status', v_r.status, 'outcome', 'existing');
    end if;
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if v_r.status = 'superseded' or p_expected_row_version is distinct from v_r.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if v_r.requested_by = v_uid or authz.finance_deal_conflict(v_r.deal_id) then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if not authz.purchase_go_ahead_request_current(v_r.id) then
    raise exception 'version_changed' using errcode = '40001';
  end if;

  if p_decision = 'approve' then
    if authz.deal_trip_cancelled(v_r.deal_id) then
      raise exception 'trip_cancelled' using errcode = '55000';
    end if;
    if not exists (select 1 from public.accounts_booking_reviews b
                   where b.booking_version_id = v_r.booking_version_id and b.status = 'approved') then
      raise exception 'booking_not_approved' using errcode = '55000';
    end if;
    -- Review F7: the linked booking request must have gone out (sent by the
    -- CRM or marked as sent); a queued or failed e-mail does not count.
    if not exists (select 1 from public.purchase_supplier_emails e
                   where e.id = v_r.email_id and e.status in ('sent', 'marked_sent')) then
      raise exception 'booking_request_not_sent' using errcode = '55000';
    end if;
    update public.purchase_go_ahead_requests r
    set status = 'approved', decided_by = v_uid, decided_at = now(), decision_request_id = p_request_id,
        row_version = r.row_version + 1
    where r.id = v_r.id;
  else
    v_reason := authz.purchase_reason(p_reason);
    update public.purchase_go_ahead_requests r
    set status = 'returned', decided_by = v_uid, decided_at = now(), decision_request_id = p_request_id,
        return_reason = v_reason, row_version = r.row_version + 1
    where r.id = v_r.id;
  end if;

  perform authz.write_audit(case when p_decision = 'approve' then 'purchase.go_ahead_approved' else 'purchase.go_ahead_returned' end,
    v_r.legal_entity_id, v_r.branch_id, 'fulfilment_task', v_r.task_id, v_reason,
    jsonb_build_object('goAheadRequestId', v_r.id, 'costVersionNo', v_r.cost_version_no,
      'bookingVersionId', v_r.booking_version_id));
  return jsonb_build_object('requestId', v_r.id, 'status', v_status, 'outcome', 'created');
end;
$$;

-- ---------------------------------------------------------------------------
-- Trip cancellation (owner decision 4)
-- ---------------------------------------------------------------------------

-- Branch Manager of the Deal: "Trip cancelled". One case per Deal.
create function public.deal_cancellation_open(p_deal_id uuid, p_reason text, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_deal public.deals%rowtype;
  v_c public.deal_cancellations%rowtype;
  v_reason text;
begin
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null or not coalesce(authz.session_ok(), false) or not authz.is_branch_sales_manager(v_deal.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- Serialize with booking requests and supplier confirmations, which lock
  -- the task row first: they either finish before or see the cancellation.
  perform 1 from public.fulfilment_tasks t where t.deal_id = v_deal.id order by t.id for update;
  select * into v_c from public.deal_cancellations c where c.deal_id = v_deal.id;
  if v_c.id is not null then
    if v_c.request_id = p_request_id and v_c.opened_by = v_uid then
      return jsonb_build_object('cancellationId', v_c.id, 'status', v_c.status, 'rowVersion', v_c.row_version,
        'outcome', 'existing');
    end if;
    raise exception 'already_decided' using errcode = '55000';
  end if;
  v_reason := authz.purchase_reason(p_reason);

  insert into public.deal_cancellations (legal_entity_id, branch_id, deal_id, reason, opened_by, request_id)
  values (v_deal.legal_entity_id, v_deal.branch_id, v_deal.id, v_reason, v_uid, p_request_id)
  returning * into v_c;

  perform authz.write_audit('deal.trip_cancelled', v_deal.legal_entity_id, v_deal.branch_id,
    'deal', v_deal.id, v_reason, jsonb_build_object('cancellationId', v_c.id));
  return jsonb_build_object('cancellationId', v_c.id, 'status', v_c.status, 'rowVersion', v_c.row_version,
    'outcome', 'created');
end;
$$;

-- Purchase: what the supplier keeps and refunds on one task (a new revision
-- each time). The task's assignee, or any active Purchase person of the
-- entity when the task is not taken. A change after sending puts the case
-- back to charges_entered.
create function public.purchase_cancellation_charge_set(
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
  if v_c.id is null then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  select * into v_existing from public.purchase_cancellation_charges x
  where x.legal_entity_id = v_task.legal_entity_id and x.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.task_id = v_task.id and v_existing.cancellation_id = v_c.id and v_existing.entered_by = v_uid then
      return jsonb_build_object('cancellationId', v_c.id, 'revisionNo', v_existing.revision_no, 'status', v_c.status,
        'outcome', 'existing');
    end if;
    raise exception 'duplicate_request' using errcode = '23505';
  end if;
  if v_c.status = 'approved' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  select coalesce(max(x.revision_no), 0) into v_rev from public.purchase_cancellation_charges x
  where x.cancellation_id = v_c.id and x.task_id = v_task.id;
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
    committed_cost_paise, supplier_keeps_paise, supplier_refund_paise, note, credit_note_evidence_id, entered_by, request_id)
  values (v_c.id, v_task.legal_entity_id, v_task.id, v_rev + 1, v_supplier, v_cost.amount_paise, p_keeps_paise,
    p_refund_paise, v_note, p_credit_note_evidence_id, v_uid, p_request_id);

  update public.deal_cancellations c
  set status = 'charges_entered', row_version = c.row_version + 1, updated_at = now()
  where c.id = v_c.id;

  perform authz.write_audit('purchase.cancellation_charge_set', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('cancellationId', v_c.id, 'revisionNo', v_rev + 1, 'previousStatus', v_c.status,
      'creditNote', p_credit_note_evidence_id is not null));
  return jsonb_build_object('cancellationId', v_c.id, 'revisionNo', v_rev + 1, 'status', 'charges_entered',
    'outcome', 'created');
end;
$$;

-- Purchase: "Send charges to the Manager". Refused (not_ready) until every
-- Purchase task of the Deal with an agreed or committed cost has a charge.
create function public.deal_cancellation_send(p_cancellation_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_c public.deal_cancellations%rowtype;
begin
  select * into v_c from public.deal_cancellations c where c.id = p_cancellation_id for update;
  if v_c.id is null or not coalesce(authz.session_ok(), false)
     or not authz.holds_active_role('purchase', v_c.legal_entity_id) then
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

-- Branch Manager approves or returns the charges; never a person who entered
-- any charge revision of this cancellation or sent it.
create function public.deal_cancellation_decide(
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
  if v_c.status <> 'sent_to_manager' then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  -- Review F8: nobody who entered any charge revision of this case, or sent
  -- it to the Manager, decides it.
  if v_c.sent_by = v_uid or exists (
    select 1 from public.purchase_cancellation_charges x
    where x.cancellation_id = v_c.id and x.entered_by = v_uid) then
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

-- ---------------------------------------------------------------------------
-- Privileges (replaced functions keep their ACL)
-- ---------------------------------------------------------------------------

revoke all on function
  public.purchase_email_record(uuid, text, uuid, text, text[], text, text, uuid),
  public.purchase_email_mark_result(uuid, text, text, text),
  public.purchase_booking_request_send(uuid, integer, text, text[], text, text, uuid),
  public.purchase_go_ahead_decide(uuid, text, text, integer, uuid),
  public.deal_cancellation_open(uuid, text, uuid),
  public.purchase_cancellation_charge_set(uuid, bigint, bigint, text, uuid, integer, uuid),
  public.deal_cancellation_send(uuid, integer, uuid),
  public.deal_cancellation_decide(uuid, text, text, integer, uuid)
from public, anon, authenticated, service_role;
grant execute on function
  public.purchase_email_record(uuid, text, uuid, text, text[], text, text, uuid),
  public.purchase_booking_request_send(uuid, integer, text, text[], text, text, uuid),
  public.purchase_go_ahead_decide(uuid, text, text, integer, uuid),
  public.deal_cancellation_open(uuid, text, uuid),
  public.purchase_cancellation_charge_set(uuid, bigint, bigint, text, uuid, integer, uuid),
  public.deal_cancellation_send(uuid, integer, uuid),
  public.deal_cancellation_decide(uuid, text, text, integer, uuid)
to authenticated;
-- Review F4: the provider result is recorded only by the server (privileged client).
grant execute on function public.purchase_email_mark_result(uuid, text, text, text) to service_role;

commit;
