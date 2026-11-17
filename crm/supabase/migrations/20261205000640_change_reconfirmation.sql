-- TripNavigate CRM - Accounts phase 3, track G (5 of 6): submit and
-- reconfirmation commands G6-G9; readiness and supplier payment gates.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 10.3 (G6-G9),
-- 10.4, 13, 14, 17.1, 17.3, 21 LD25, LD27, LD28, Addendum O1.
--
-- New commands (security definer, session first, execute to authenticated):
--   G6 public.booking_change_submit(p_change_request_id, p_expected_content_hash,
--      p_expected_changed_item_ids uuid[], p_request_id) - requester or SO.
--   G7 public.task_reconfirm_record(p_reconfirmation_id, p_expected_row_version,
--      p_fields {newRatePaise, supplierFeePaise, newReference, evidenceId, note},
--      p_request_id) - the task's Purchase assignee.
--   G8 public.task_reconfirm_approve_over_budget(p_reconfirmation_id,
--      p_expected_row_version, p_request_id) - Approver holding
--      can_manage_purchase_task, not the recorder.
--   G9 public.task_reconfirm_refuse(p_reconfirmation_id, p_expected_row_version,
--      p_reason, p_request_id) - the task's Purchase assignee.
-- New internal helpers (no grant): authz.cr_changed_item_ids (services whose
-- facts, budget or participants differ from the base), authz.cr_apply_if_ready,
-- authz.reconf_json.
-- Replaced (latest bodies, same signatures; changed lines marked
-- "Accounts phase 3 (20261205000640)"):
--   authz.booking_issues (20261203000100:57): for a change version
--     customer_acceptance_required, revision_class_missing (the class is set by
--     submit) and base_no_longer_returned (the base stays approved; the change
--     flow checks it is still confirmed) are not raised.
--   authz.sm_payment_create (20261201000210:752): change_in_progress while the
--     Purchase task has a pending or recorded reconfirmation.
--
-- Refusal tokens: change_outside_request (22023, hint = item numbers),
-- version_changed (40001), not_ready (55000, hint no_changes or the first
-- readiness code), wrong_state (55000), changes_off, version_superseded,
-- payment_in_progress (55000), evidence_missing (55000), not_self_approval
-- (42501), change_in_progress (55000), invalid_input (22023, hint = field),
-- request_conflict, not_authorized, deal_removed.
-- Audit: booking.change_submitted {changeRequestId, reconfirmations};
-- purchase.reconfirm_recorded {reconfirmationId, taskId, overBudget};
-- purchase.reconfirm_over_budget_approved; purchase.reconfirm_refused;
-- booking.change_not_possible. No amounts, references or names in details.
-- Rollback (forward-only): a NEW migration restoring booking_issues
-- (20261203000100) and sm_payment_create (20261201000210) and revoking the
-- four commands.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Readiness (replaces 20261203000100:57; lines marked)
-- ===========================================================================

create or replace function authz.booking_issues(p_version uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select case when v.service_type = 'package' then array_remove(array[
    -- B1.1 revision: a revision does not need the trigger stage (tasks exist already).
    case when v.revises_version_id is null and not authz.deal_in_trigger_stage(d.id) then 'stage_not_confirmed' end,
    case when not exists (select 1 from public.service_item_facts f where f.booking_version_id = v.id) then 'no_services' end,
    case when cardinality(authz.service_item_invalid_nos(v.id)) > 0 then 'service_facts_invalid' end,
    -- B1.1: customer and billing.
    case when not exists (select 1 from public.booking_version_contacts c where c.booking_version_id = v.id)
      then 'contact_missing' end,
    case when exists (select 1 from public.booking_version_contacts c where c.booking_version_id = v.id and not c.contact_confirmed)
      then 'contact_not_confirmed' end,
    case when not exists (select 1 from public.customer_billing_profiles b where b.deal_id = d.id) then 'billing_missing' end,
    -- Booking form: a GST-registered business needs its GSTIN; an
    -- unregistered one does not (its reason is checked below). Profiles saved
    -- before the booking form keep today's rule (business without GSTIN).
    case when 'gstin_missing' = any (authz.bf_billing_codes(d.id, v.id)) then 'gstin_missing' end,
    -- B1.1: trip.
    case when v.trip_destination is null or v.trip_scope is null or v.trip_start is null or v.trip_end is null
      then 'trip_missing' end,
    case when authz.version_travellers_needed(v.id) > 0
          and not exists (select 1 from public.deal_travellers t where t.deal_id = d.id) then 'traveller_missing' end,
    case when exists (select 1 from public.deal_travellers t where t.deal_id = d.id)
          and (select count(*) from public.deal_travellers t where t.deal_id = d.id) < authz.version_travellers_needed(v.id)
          then 'traveller_count_mismatch' end,
    -- B1.1: travellers, participation, identity.
    case when exists (select 1 from public.deal_travellers t
                      where t.deal_id = d.id and t.traveller_type in ('child', 'infant') and t.age_years is null)
      then 'child_age_missing' end,
    case when cardinality(authz.b11_participation_missing_nos(v.id)) > 0 then 'participation_missing' end,
    case when cardinality(authz.b11_identity_missing_seqs(v.id)) > 0 then 'identity_missing' end,
    -- B1.2 (DEC-38): every adult traveller needs a stored identity proof; drafts
    -- only (first and revision drafts), so confirmed versions are not re-checked.
    -- Accounts phase (20261203000100): a flight-only version needs no ID proof.
    case when v.status = 'draft' and not authz.version_flight_only(v.id) and exists (
           select 1 from public.deal_travellers t
           where t.deal_id = d.id and t.traveller_type = 'adult'
             and not exists (select 1 from public.traveller_id_proofs f where f.traveller_id = t.id and f.status = 'stored'))
      then 'id_proof_missing' end,
    case when not exists (select 1 from public.booking_version_commercials c where c.version_id = v.id)
      then 'missing_selling_total' end,
    -- B1.1: payment plan (DEC-29).
    case when not exists (select 1 from public.booking_version_instalments p where p.booking_version_id = v.id)
      then 'plan_missing' end,
    case when exists (select 1 from public.booking_version_instalments p where p.booking_version_id = v.id)
          and exists (select 1 from public.booking_version_commercials c where c.version_id = v.id)
          and (select sum(p.amount_paise) from public.booking_version_instalments p where p.booking_version_id = v.id)
              <> (select c.selling_total_paise from public.booking_version_commercials c where c.version_id = v.id)
      then 'plan_total_mismatch' end,
    -- Package versions need the customer's acceptance message itself (contract section 5.1 and 9; review E5).
    case when v.revises_version_id is null and not exists (select 1 from public.booking_evidence e
                          where e.version_id = v.id and e.kind = 'acceptance_message' and e.status = 'stored')
          -- B1.2: a draft converted from an accepted quotation carries the customer's written acceptance.
          and not authz.booking_quote_acceptance_ok(v.id)
      then 'missing_acceptance_proof' end,
    -- B1.2 (freeze part 2 section 2.8/2.9): money or material facts changed since conversion.
    case when authz.booking_quote_change(v.id) = 'stale' or authz.booking_quote_party_stale(v.id) then 'quote_acceptance_stale' end,
    -- B1.1 revision (Stage 3 section 8.2).
    -- Review R1: a class is valid only for the changes it was recorded for and
    -- only when the live changes allow it (any later change needs a new class).
    -- Accounts phase 3 (20261205000640): a change version's class is set by booking_change_submit.
    case when v.revises_version_id is not null and v.change_request_id is null
          and (v.change_class is null
               or v.changed_fields is distinct from authz.revision_changed_fields(v.id)
               or not (v.change_class = any (authz.revision_allowed_classes(authz.revision_changed_fields(v.id)))))
      then 'revision_class_missing' end,
    -- Accounts phase 3 (20261205000640): a change version needs no fresh customer acceptance (Q7).
    case when v.revises_version_id is not null and v.change_request_id is null and v.change_class = 'customer_material'
          and not exists (select 1 from public.booking_evidence e
                          where e.version_id = v.id and e.kind = 'acceptance_message' and e.status = 'stored')
      then 'customer_acceptance_required' end,
    case when v.revises_version_id is not null and cardinality(authz.revision_changed_fields(v.id)) = 0 then 'no_changes' end,
    -- Accounts phase 3 (20261205000640): a change version's base stays approved (checked by the change flow).
    case when v.revises_version_id is not null and v.change_request_id is null and not exists (
           select 1 from public.booking_versions b
           join public.accounts_booking_reviews rv on rv.booking_version_id = b.id and rv.status = 'returned'
           where b.id = v.revises_version_id and b.status = 'confirmed')
      then 'base_no_longer_returned' end,
    case when exists (select 1 from public.booking_evidence e where e.version_id = v.id and e.status = 'pending_upload')
      then 'evidence_upload_incomplete' end,
    case when not d.is_synthetic
      and (d.last_verified_at is null or d.last_verified_at < now() - interval '24 hours')
      then 'source_not_recently_verified' end,
    case when authz.booking_gate_issue(d.id) = 'booking_disabled' then 'booking_disabled' end,
    case when authz.booking_gate_issue(d.id) = 'environment_unset' then 'environment_unset' end
  ], null)
  -- Booking form (20261124000120): Bill To and form checks.
  || array_remove(array_remove(authz.bf_billing_codes(d.id, v.id), 'gstin_missing'), 'billing_missing')
  || authz.bf_form_codes(v.id)
  else array_remove(array[
    case when v.hotel_name is null then 'missing_hotel_name' end,
    case when v.city is null then 'missing_city' end,
    case when v.check_in is null or v.check_out is null then 'missing_dates' end,
    case when v.check_out <= v.check_in then 'check_out_not_after_check_in' end,
    case when v.rooms is null then 'missing_rooms' end,
    case when v.adults is null then 'missing_travellers' end,
    case when v.purchase_budget_paise is null then 'missing_purchase_budget' end,
    case when not exists (select 1 from public.booking_version_commercials c where c.version_id = v.id)
      then 'missing_selling_total' end,
    case when not exists (select 1 from public.booking_evidence e where e.version_id = v.id and e.status = 'stored')
      then 'missing_acceptance_proof' end,
    case when exists (select 1 from public.booking_evidence e where e.version_id = v.id and e.status = 'pending_upload')
      then 'evidence_upload_incomplete' end,
    -- STALE_SYNC_HOURS_PROPOSED = 24
    case when not d.is_synthetic
      and (d.last_verified_at is null or d.last_verified_at < now() - interval '24 hours')
      then 'source_not_recently_verified' end,
    case when authz.booking_gate_issue(d.id) = 'booking_disabled' then 'booking_disabled' end,
    case when authz.booking_gate_issue(d.id) = 'environment_unset' then 'environment_unset' end
  ], null) end
  from public.booking_versions v
  join public.deals d on d.id = v.deal_id
  where v.id = p_version
$$;

-- ===========================================================================
-- 2. Supplier payment gate (replaces 20261201000210:752; lines marked)
-- ===========================================================================

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

-- ===========================================================================
-- 3. Helpers
-- ===========================================================================

-- Services whose facts, budget or participants differ between the change
-- version and its base (also a service present in only one of them).
create function authz.cr_changed_item_ids(p_version uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
  with v as (select x.* from public.booking_versions x where x.id = p_version and x.revises_version_id is not null),
  items as (
    select i.id, fv.facts as vf, fb.facts as bf, fv.purchase_budget_paise as vb, fb.purchase_budget_paise as bb,
      fv.id as fv_id, fb.id as fb_id
    from v
    join public.service_items i on i.deal_id = v.deal_id
    left join public.service_item_facts fv on fv.service_item_id = i.id and fv.booking_version_id = v.id
    left join public.service_item_facts fb on fb.service_item_id = i.id and fb.booking_version_id = v.revises_version_id
    where fv.id is not null or fb.id is not null)
  select coalesce(array_agg(it.id order by it.id), '{}'::uuid[])
  from items it cross join v
  where it.fv_id is null or it.fb_id is null or it.vf is distinct from it.bf or it.vb is distinct from it.bb
     or authz.item_participant_seqs(it.id, v.id) is distinct from authz.item_participant_seqs(it.id, v.revises_version_id)
$$;

-- Applies the request when nothing waits any more (no pending reconfirmation,
-- no recorded one over budget without the Manager's approval).
create function authz.cr_apply_if_ready(p_change_request uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  if exists (select 1 from public.booking_change_requests r where r.id = p_change_request and r.status = 'submitted')
     and not exists (select 1 from public.task_reconfirmations x
                     where x.change_request_id = p_change_request
                       and (x.status = 'pending' or (x.status = 'recorded' and x.over_budget and x.over_budget_approved_by is null))) then
    perform authz.booking_change_apply(p_change_request);
    return true;
  end if;
  return false;
end;
$$;

create function authz.reconf_json(p public.task_reconfirmations) returns jsonb
language sql stable set search_path = '' as $$
  select jsonb_build_object('reconfirmationId', p.id, 'taskId', p.task_id, 'changeRequestId', p.change_request_id,
    'status', p.status, 'overBudget', p.over_budget, 'rowVersion', p.row_version,
    'changeRequestStatus', (select r.status from public.booking_change_requests r where r.id = p.change_request_id))
$$;

-- ===========================================================================
-- 4. G6 submit
-- ===========================================================================

create function public.booking_change_submit(p_change_request_id uuid, p_expected_content_hash text,
  p_expected_changed_item_ids uuid[], p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.booking_change_requests%rowtype;
  v_payload jsonb := jsonb_build_object('changeRequestId', p_change_request_id, 'contentHash', p_expected_content_hash,
    'changedItemIds', to_jsonb(p_expected_changed_item_ids));
  v_result jsonb;
  v_ver public.booking_versions%rowtype;
  v_fields text[];
  v_changed uuid[];
  v_outside text;
  v_expected uuid[];
  v_class text;
  v_issues text[];
  v_n integer := 0;
  v_applied boolean := false;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_row from public.booking_change_requests r where r.id = p_change_request_id;
  if v_row.id is null
     or not ((v_row.requested_by = v_uid and authz.cr_requester_role(v_row.deal_id) is not null)
             or authz.refund_is_so(v_row.deal_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.refuse_removed_deal(v_row.deal_id);
  if p_request_id is null then
    perform authz.cr_invalid('requestId');
  end if;
  v_row := authz.cr_lock_apply(p_change_request_id);
  v_result := authz.finance_replay(v_row.legal_entity_id, p_request_id, 'booking_change_submit', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_row.status <> 'approved' or v_row.change_version_id is null then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if v_row.kind = 'change' and not authz.booking_changes_enabled() then
    raise exception 'changes_off' using errcode = '55000';
  end if;
  if not exists (select 1 from public.booking_versions b where b.id = v_row.base_version_id and b.status = 'confirmed') then
    raise exception 'version_superseded' using errcode = '55000';
  end if;
  select * into v_ver from public.booking_versions v where v.id = v_row.change_version_id;
  if v_ver.status <> 'draft' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_expected_content_hash is null or p_expected_content_hash <> authz.booking_content_hash(v_ver.id) then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_fields := authz.revision_changed_fields(v_ver.id);
  if cardinality(v_fields) = 0 then
    raise exception 'not_ready' using errcode = '55000', hint = 'no_changes';
  end if;
  -- LD28: every service whose facts changed is named in the approved request.
  v_changed := authz.cr_changed_item_ids(v_ver.id);
  select string_agg(i.item_no::text, ',' order by i.item_no) into v_outside
  from public.service_items i
  where i.id = any (v_changed) and not (i.id = any (v_row.item_ids));
  if v_outside is not null then
    raise exception 'change_outside_request' using errcode = '22023', hint = v_outside;
  end if;
  -- The set the screen showed.
  select coalesce(array_agg(distinct x order by x), '{}'::uuid[]) into v_expected
  from unnest(coalesce(p_expected_changed_item_ids, '{}'::uuid[])) x;
  if v_expected is distinct from v_changed then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  -- The weakest allowed class, for the history view.
  v_class := (authz.revision_allowed_classes(v_fields))[1];
  update public.booking_versions v set change_class = v_class, changed_fields = v_fields, updated_at = now(),
    updated_by = v_uid
  where v.id = v_ver.id
  returning * into v_ver;
  v_issues := authz.booking_issues(v_ver.id);
  if cardinality(v_issues) > 0 then
    raise exception 'not_ready' using errcode = '55000', hint = v_issues[1];
  end if;

  -- One pending reconfirmation per changed Purchase service whose supplier confirmed (LD27: Flight and Visa keep their own steps).
  insert into public.task_reconfirmations (legal_entity_id, change_request_id, task_id, booking_version_id, budget_paise)
  select t.legal_entity_id, v_row.id, t.id, v_ver.id, f.purchase_budget_paise
  from public.fulfilment_tasks t
  left join public.service_item_facts f on f.service_item_id = t.service_item_id and f.booking_version_id = v_ver.id
  where t.deal_id = v_row.deal_id and t.service_item_id = any (v_changed)
    and t.department = 'purchase' and t.status = 'supplier_confirmed'
  order by t.id;
  get diagnostics v_n = row_count;

  update public.booking_change_requests r
  set status = 'submitted', submitted_by = v_uid, submitted_at = now(), changed_fields = v_fields, change_class = v_class,
      row_version = r.row_version + 1
  where r.id = v_row.id
  returning * into v_row;
  perform authz.write_audit('booking.change_submitted', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request', v_row.id,
    null, jsonb_build_object('changeRequestId', v_row.id, 'dealId', v_row.deal_id, 'versionId', v_ver.id,
      'reconfirmations', v_n, 'changedItemCount', cardinality(v_changed)));
  if v_n = 0 then
    v_applied := authz.cr_apply_if_ready(v_row.id);
  end if;
  select * into v_row from public.booking_change_requests r where r.id = v_row.id;
  v_result := authz.cr_json(v_row) || jsonb_build_object('outcome', 'updated', 'reconfirmations', v_n, 'applied', v_applied);
  return authz.finance_remember(v_row.legal_entity_id, p_request_id, 'booking_change_submit', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 5. G7 record what the supplier said
-- ===========================================================================

create function public.task_reconfirm_record(p_reconfirmation_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_x public.task_reconfirmations%rowtype;
  v_row public.booking_change_requests%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_payload jsonb := jsonb_build_object('reconfirmationId', p_reconfirmation_id, 'expectedRowVersion', p_expected_row_version,
    'fields', p_fields);
  v_result jsonb;
  v_key text;
  v_rate bigint;
  v_fee bigint;
  v_ref text;
  v_note text;
  v_evidence uuid;
  v_budget bigint;
  v_over boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_x from public.task_reconfirmations x where x.id = p_reconfirmation_id;
  if v_x.id is null or not authz.can_work_purchase_task(v_x.task_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    perform authz.cr_invalid('requestId');
  end if;
  v_row := authz.cr_lock_apply(v_x.change_request_id);
  select * into v_x from public.task_reconfirmations x where x.id = p_reconfirmation_id;
  v_result := authz.finance_replay(v_x.legal_entity_id, p_request_id, 'task_reconfirm_record', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_x.status <> 'pending' or v_row.status <> 'submitted' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_x.row_version);
  select * into v_task from public.fulfilment_tasks t where t.id = v_x.task_id;
  -- A live supplier payment request on the task is settled first.
  if exists (select 1 from public.supplier_payment_requests p
             where p.task_id = v_task.id and p.status in ('pending', 'approved', 'paid')) then
    raise exception 'payment_in_progress' using errcode = '55000';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    perform authz.cr_invalid('fields');
  end if;
  for v_key in select k from jsonb_object_keys(p_fields) k order by k loop
    if v_key <> all (array['newRatePaise', 'supplierFeePaise', 'newReference', 'evidenceId', 'note']) then
      perform authz.cr_invalid(v_key);
    end if;
  end loop;
  if jsonb_typeof(p_fields -> 'newRatePaise') not in ('string', 'number')
     or (p_fields ->> 'newRatePaise') !~ '^[1-9][0-9]{0,11}$' then
    perform authz.cr_invalid('newRatePaise');
  end if;
  v_rate := (p_fields ->> 'newRatePaise')::bigint;
  if p_fields -> 'supplierFeePaise' is null or jsonb_typeof(p_fields -> 'supplierFeePaise') = 'null' then
    v_fee := 0;
  elsif jsonb_typeof(p_fields -> 'supplierFeePaise') not in ('string', 'number')
        or (p_fields ->> 'supplierFeePaise') !~ '^(0|[1-9][0-9]{0,11})$' then
    perform authz.cr_invalid('supplierFeePaise');
  else
    v_fee := (p_fields ->> 'supplierFeePaise')::bigint;
  end if;
  v_ref := authz.cr_text(p_fields, 'newReference', 1, 120, false);
  if v_ref ~ '[[:cntrl:]]' then
    perform authz.cr_invalid('newReference');
  end if;
  v_note := authz.cr_text(p_fields, 'note', 1, 500, true);
  if p_fields -> 'evidenceId' is not null and jsonb_typeof(p_fields -> 'evidenceId') = 'string'
     and (p_fields ->> 'evidenceId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    v_evidence := (p_fields ->> 'evidenceId')::uuid;
  elsif p_fields -> 'evidenceId' is not null and jsonb_typeof(p_fields -> 'evidenceId') <> 'null' then
    perform authz.cr_invalid('evidenceId');
  end if;
  -- The supplier's proof: a stored supplier confirmation of this task uploaded for this reconfirmation
  -- (purchase_evidence_begin links it, 20261205000670), not used before.
  if v_evidence is null or not exists (
       select 1 from public.purchase_evidence e
       where e.id = v_evidence and e.task_id = v_task.id and e.kind = 'supplier_confirmation' and e.status = 'stored'
         and e.reconfirmation_id = v_x.id and e.created_at >= v_row.decided_at)
     or exists (select 1 from public.task_reconfirmations y where y.evidence_id = v_evidence and y.id <> v_x.id)
     or exists (select 1 from public.task_confirmations c where c.task_id = v_task.id and v_evidence = any (c.evidence_ids)) then
    raise exception 'evidence_missing' using errcode = '55000';
  end if;
  select f.purchase_budget_paise into v_budget from public.service_item_facts f
  where f.service_item_id = v_task.service_item_id and f.booking_version_id = v_x.booking_version_id;
  v_over := v_budget is null or v_rate + v_fee > v_budget;

  update public.task_reconfirmations x
  set status = 'recorded', new_rate_paise = v_rate, supplier_fee_paise = v_fee, new_reference = v_ref, evidence_id = v_evidence,
      note = v_note, budget_paise = v_budget, over_budget = v_over, recorded_by = v_uid, recorded_at = now(),
      request_id = p_request_id, row_version = x.row_version + 1
  where x.id = v_x.id
  returning * into v_x;
  -- Amounts and references stay out of the audit trail.
  perform authz.write_audit('purchase.reconfirm_recorded', v_x.legal_entity_id, v_task.branch_id, 'fulfilment_task', v_task.id,
    null, jsonb_build_object('reconfirmationId', v_x.id, 'taskId', v_task.id, 'changeRequestId', v_x.change_request_id,
      'overBudget', v_over));
  perform authz.cr_apply_if_ready(v_x.change_request_id);
  select * into v_x from public.task_reconfirmations x where x.id = v_x.id;
  v_result := authz.reconf_json(v_x) || jsonb_build_object('outcome', 'updated');
  return authz.finance_remember(v_x.legal_entity_id, p_request_id, 'task_reconfirm_record', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 6. G8 the Manager approves a reconfirmed cost above budget
-- ===========================================================================

create function public.task_reconfirm_approve_over_budget(p_reconfirmation_id uuid, p_expected_row_version integer,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_x public.task_reconfirmations%rowtype;
  v_row public.booking_change_requests%rowtype;
  v_payload jsonb := jsonb_build_object('reconfirmationId', p_reconfirmation_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_x from public.task_reconfirmations x where x.id = p_reconfirmation_id;
  if v_x.id is null or not authz.cr_is_approver(v_x.change_request_id) or not authz.can_manage_purchase_task(v_x.task_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_x.recorded_by = v_uid then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if p_request_id is null then
    perform authz.cr_invalid('requestId');
  end if;
  v_row := authz.cr_lock_apply(v_x.change_request_id);
  select * into v_x from public.task_reconfirmations x where x.id = p_reconfirmation_id;
  v_result := authz.finance_replay(v_x.legal_entity_id, p_request_id, 'task_reconfirm_approve_over_budget', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_x.status <> 'recorded' or not v_x.over_budget or v_x.over_budget_approved_by is not null or v_row.status <> 'submitted' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_x.row_version);
  update public.task_reconfirmations x
  set over_budget_approved_by = v_uid, over_budget_approved_at = now(), row_version = x.row_version + 1
  where x.id = v_x.id
  returning * into v_x;
  perform authz.write_audit('purchase.reconfirm_over_budget_approved', v_x.legal_entity_id, v_row.branch_id, 'fulfilment_task',
    v_x.task_id, null, jsonb_build_object('reconfirmationId', v_x.id, 'taskId', v_x.task_id, 'changeRequestId', v_x.change_request_id));
  perform authz.cr_apply_if_ready(v_x.change_request_id);
  select * into v_x from public.task_reconfirmations x where x.id = v_x.id;
  v_result := authz.reconf_json(v_x) || jsonb_build_object('outcome', 'updated');
  return authz.finance_remember(v_x.legal_entity_id, p_request_id, 'task_reconfirm_approve_over_budget', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 7. G9 the supplier said no: nothing else changes
-- ===========================================================================

create function public.task_reconfirm_refuse(p_reconfirmation_id uuid, p_expected_row_version integer, p_reason text,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_x public.task_reconfirmations%rowtype;
  v_row public.booking_change_requests%rowtype;
  v_payload jsonb := jsonb_build_object('reconfirmationId', p_reconfirmation_id, 'expectedRowVersion', p_expected_row_version,
    'reason', p_reason);
  v_result jsonb;
  v_reason text;
  v_voided integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_x from public.task_reconfirmations x where x.id = p_reconfirmation_id;
  if v_x.id is null or not authz.can_work_purchase_task(v_x.task_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    perform authz.cr_invalid('requestId');
  end if;
  v_row := authz.cr_lock_apply(v_x.change_request_id);
  select * into v_x from public.task_reconfirmations x where x.id = p_reconfirmation_id;
  v_result := authz.finance_replay(v_x.legal_entity_id, p_request_id, 'task_reconfirm_refuse', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_x.status not in ('pending', 'recorded') or v_row.status <> 'submitted' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_x.row_version);
  v_reason := authz.cr_reason(p_reason, 'reason');
  update public.task_reconfirmations x set status = 'refused', refused_reason = v_reason, row_version = x.row_version + 1
  where x.id = v_x.id
  returning * into v_x;
  select count(*)::integer into v_voided from public.task_reconfirmations y
  where y.change_request_id = v_row.id and y.status = 'recorded';
  -- Other reconfirmations void, the change version discarded, the request not_possible.
  v_row := authz.cr_close(v_row, 'not_possible', v_reason);
  perform authz.write_audit('purchase.reconfirm_refused', v_x.legal_entity_id, v_row.branch_id, 'fulfilment_task', v_x.task_id,
    v_reason, jsonb_build_object('reconfirmationId', v_x.id, 'taskId', v_x.task_id, 'changeRequestId', v_row.id));
  perform authz.write_audit('booking.change_not_possible', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request',
    v_row.id, v_reason, jsonb_build_object('changeRequestId', v_row.id, 'dealId', v_row.deal_id,
      'refusedReconfirmationId', v_x.id, 'voidedReconfirmations', v_voided));
  select * into v_x from public.task_reconfirmations x where x.id = v_x.id;
  v_result := authz.reconf_json(v_x) || jsonb_build_object('outcome', 'updated');
  return authz.finance_remember(v_x.legal_entity_id, p_request_id, 'task_reconfirm_refuse', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 8. Grants
-- ===========================================================================

revoke all on function authz.cr_changed_item_ids(uuid), authz.cr_apply_if_ready(uuid),
  authz.reconf_json(public.task_reconfirmations)
from public, anon, authenticated, service_role;
revoke all on function public.booking_change_submit(uuid, text, uuid[], uuid),
  public.task_reconfirm_record(uuid, integer, jsonb, uuid),
  public.task_reconfirm_approve_over_budget(uuid, integer, uuid),
  public.task_reconfirm_refuse(uuid, integer, text, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.booking_change_submit(uuid, text, uuid[], uuid),
  public.task_reconfirm_record(uuid, integer, jsonb, uuid),
  public.task_reconfirm_approve_over_budget(uuid, integer, uuid),
  public.task_reconfirm_refuse(uuid, integer, text, uuid)
to authenticated;

commit;
