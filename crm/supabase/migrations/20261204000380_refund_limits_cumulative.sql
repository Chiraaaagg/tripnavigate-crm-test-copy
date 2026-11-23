-- Accounts phase 2, Track C fix-forward: contract Addendum L7 (independent
-- backend review), items "Refund limits are cumulative" (review 1),
-- "Charges below costs kept" (review 4) and "Refund list fence" (review 9).
--
-- * customer_refund_requests.use_kept_credit (payout only; a request fact).
-- * Charge floor: the highest charge of any approved / paid cancellation
--   settlement counts (authz.refund_approved_charge; ties decided_at,
--   requested_at, id desc). A new or resubmitted request below it is refused
--   charge_below_approved (22023, hint approvedChargePaise); approval
--   re-checks it. Lowering needs the Manager to withdraw the earlier approval:
--   approved keep_credit / charge_only settlements are now withdrawable by a
--   branch Manager or the approver (not kept credit already used).
-- * Kept credit reserved: limit = held - charge - unused kept credit, unless
--   the payout names useKeptCredit (then held - charge). A paid useKeptCredit
--   payout uses that credit (authz.refund_kept_unused = approved keep_credit
--   amounts - paid useKeptCredit payouts, never below 0).
-- * Dues: the settlement with the highest charge sets the total; deal_dues
--   refunds.keptAsCreditPaise = unused kept credit only.
-- * Reads: deal_refunds adds approvedChargePaise, keptCreditUnusedPaise and per
--   request useKeptCredit, warnings ['charge_below_costs_kept'] (review 4);
--   refund_requests_list rows add useKeptCredit and warnings, and every viewer
--   scope (A, M, SO) passes the finance gate (review 9).
-- Replaced (latest bodies, same signatures): customer_refund_requests_guard (20261204000300), refund_settlement (20261204000310), refund_validate (20261204000370), refund_limit_ok (20261204000310), customer_refund_request_create (20261204000310), customer_refund_request_resubmit (20261204000310), customer_refund_decide (20261204000310), customer_refund_request_withdraw (20261204000310), dues_compute (20261204000370), deal_dues (20261204000370), deal_refunds (20261204000370), refund_requests_list (20261204000370).
-- Refusal tokens: charge_below_approved (new, 22023), wrong_state (hint
-- keptCreditUsed), refund_exceeds_money as before.
-- Rollback (forward-only): a NEW migration restoring the cited bodies and
-- dropping the column and helpers (only while no request uses kept credit).

begin;
set local lock_timeout = '15s';

alter table public.customer_refund_requests
  add column use_kept_credit boolean not null default false,
  add constraint customer_refund_requests_use_kept_credit_check check (not use_kept_credit or outcome = 'payout');

-- Highest charge of the Deal's approved / paid cancellation settlements (excluding p_except); null when none.
create function authz.refund_approved_charge(p_deal uuid, p_except uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select max(r.customer_charge_paise) from public.customer_refund_requests r
  where r.deal_id = p_deal and r.kind = 'cancellation' and r.status in ('approved', 'paid') and r.id is distinct from p_except
$$;

-- Approved keep-as-credit amounts of the Deal.
create function authz.refund_kept_total(p_deal uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(r.amount_paise), 0)::bigint from public.customer_refund_requests r
  where r.deal_id = p_deal and r.outcome = 'keep_credit' and r.status = 'approved'
$$;

-- Kept credit used by paid payouts that named useKeptCredit.
create function authz.refund_kept_used(p_deal uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(r.amount_paise), 0)::bigint from public.customer_refund_requests r
  where r.deal_id = p_deal and r.use_kept_credit and r.status = 'paid'
$$;

-- Unused kept credit (never below 0): reserved from new refunds unless used on purpose.
create function authz.refund_kept_unused(p_deal uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select greatest(authz.refund_kept_total(p_deal) - authz.refund_kept_used(p_deal), 0)::bigint
$$;

create or replace function authz.customer_refund_requests_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_facts text[] := array['kind', 'outcome', 'cancellation_id', 'held_at_request_paise', 'customer_charge_paise', 'amount_paise',
    'payee_kind', 'payee_name', 'payee_receipt_id', 'payee_reason', 'reason', 'resubmitted_at',
    'use_kept_credit'];  -- Accounts phase 2 (20261204000380, Addendum L7)
  v_identity text[] := array['id', 'legal_entity_id', 'branch_id', 'deal_id', 'ref_no', 'requested_as', 'requested_by',
    'requested_at', 'request_id'];
  k text;
begin
  if tg_op = 'DELETE' then
    raise exception 'refund requests cannot be deleted' using errcode = '42501';
  end if;
  foreach k in array v_identity loop
    if (to_jsonb(new) -> k) is distinct from (to_jsonb(old) -> k) then
      raise exception 'refund request identity is immutable' using errcode = '42501';
    end if;
  end loop;
  if new.row_version <> old.row_version + 1 then
    raise exception 'refund request changes bump row_version' using errcode = '42501';
  end if;
  if old.status in ('paid', 'withdrawn')
     or not ((old.status = 'requested' and new.status in ('approved', 'returned', 'withdrawn'))
          or (old.status = 'returned' and new.status in ('requested', 'withdrawn'))
          or (old.status = 'approved' and new.status in ('paid', 'withdrawn'))) then
    raise exception 'refund request status move not allowed' using errcode = '42501';
  end if;
  -- Facts change only on a resubmission (returned -> requested).
  if not (old.status = 'returned' and new.status = 'requested') then
    foreach k in array v_facts loop
      if (to_jsonb(new) -> k) is distinct from (to_jsonb(old) -> k) then
        raise exception 'refund request facts change only on resubmission' using errcode = '42501';
      end if;
    end loop;
  end if;
  -- After approval only the paid / withdrawn columns move.
  if old.status = 'approved'
     and (new.decided_by is distinct from old.decided_by or new.decided_at is distinct from old.decided_at
          or new.decision_request_id is distinct from old.decision_request_id) then
    raise exception 'an approved refund decision is final' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function authz.refund_settlement(p_deal uuid) returns public.customer_refund_requests
language sql stable security definer set search_path = '' as $$
  select r.* from public.customer_refund_requests r
  where r.deal_id = p_deal and r.kind = 'cancellation' and r.status in ('approved', 'paid')
  -- Accounts phase 2 (20261204000380, Addendum L7): the highest approved charge counts; ties by decided, created, id.
  order by r.customer_charge_paise desc, r.decided_at desc, r.requested_at desc, r.id desc limit 1
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
  v_use_kept boolean := false;
  v_approved_charge bigint;
  v_kept bigint;
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    perform authz.refund_invalid('fields');
  end if;
  for v_key in select k from jsonb_object_keys(p_fields) k order by k loop
    if v_key <> all (array['kind', 'outcome', 'customerChargePaise', 'amountPaise', 'payeeKind', 'payeeReceiptId', 'payeeName',
                           'payeeReason', 'reason', 'useKeptCredit']) then
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
  -- Accounts phase 2 (20261204000380, Addendum L7): a payout may use the Deal's unused kept credit when it says so.
  if jsonb_typeof(p_fields -> 'useKeptCredit') = 'boolean' then
    v_use_kept := (p_fields ->> 'useKeptCredit')::boolean;
  elsif coalesce(jsonb_typeof(p_fields -> 'useKeptCredit'), 'null') <> 'null' then
    perform authz.refund_invalid('useKeptCredit');
  end if;
  if v_use_kept and v_outcome <> 'payout' then
    perform authz.refund_invalid('useKeptCredit');
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
  -- Accounts phase 2 (20261204000380, Addendum L7): the charge never goes below an approved settlement's charge.
  v_approved_charge := authz.refund_approved_charge(p_deal, null);
  if v_kind = 'cancellation' and v_approved_charge is not null and v_charge < v_approved_charge then
    raise exception 'charge_below_approved' using errcode = '22023', hint = 'approvedChargePaise';
  end if;
  -- Approved kept credit stays reserved unless this payout uses it.
  v_kept := case when v_use_kept then 0 else authz.refund_kept_unused(p_deal) end;
  if v_kind = 'cancellation' then
    if v_outcome <> 'charge_only' and v_amount > v_held - v_charge - v_kept then
      raise exception 'refund_exceeds_money' using errcode = '22023', hint = 'amountPaise';
    end if;
  else
    v_total := authz.refund_basis_total(p_deal);
    if v_total is null then
      raise exception 'not_ready' using errcode = '55000', hint = 'booking';
    end if;
    if v_amount > v_held - v_total - v_kept then
      raise exception 'refund_exceeds_money' using errcode = '22023', hint = 'amountPaise';
    end if;
  end if;
  return jsonb_build_object('kind', v_kind, 'outcome', v_outcome, 'cancellationId', v_cancellation,
    'chargePaise', v_charge, 'amountPaise', v_amount, 'payeeKind', v_payee_kind, 'payeeReceiptId', v_receipt,
    'payeeName', v_payee_name, 'payeeReason', v_payee_reason, 'reason', v_reason, 'heldPaise', v_held,
    'useKeptCredit', v_use_kept);
end;
$$;

create or replace function authz.refund_limit_ok(r public.customer_refund_requests) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when r.outcome = 'charge_only' then true
    -- Accounts phase 2 (20261204000380, Addendum L7): unused kept credit stays reserved unless the request uses it.
    when r.kind = 'cancellation' then r.amount_paise <= authz.refund_money_held(r.deal_id) - r.customer_charge_paise
      - case when r.use_kept_credit then 0 else authz.refund_kept_unused(r.deal_id) end
    else coalesce(r.amount_paise <= authz.refund_money_held(r.deal_id) - authz.refund_basis_total(r.deal_id)
      - case when r.use_kept_credit then 0 else authz.refund_kept_unused(r.deal_id) end, false)
  end
$$;

create or replace function public.customer_refund_request_create(p_deal_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_role text;
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id, 'fields', p_fields);
  v_result jsonb;
  v jsonb;
  v_id uuid := gen_random_uuid();
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  v_role := authz.refund_requester_role(v_deal.id);
  if v_deal.id is null or v_role is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.refund_gate(v_deal.legal_entity_id, v_deal.is_synthetic);
  if p_request_id is null then
    perform authz.refund_invalid('requestId');
  end if;
  perform authz.finance_lock_deal(v_deal.id);
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'customer_refund_request_create', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if not authz.refunds_enabled(v_deal.legal_entity_id) then
    raise exception 'refunds_off' using errcode = '55000';
  end if;
  if exists (select 1 from public.customer_refund_requests r
             where r.deal_id = v_deal.id and (r.status in ('requested', 'returned') or (r.status = 'approved' and r.outcome = 'payout'))) then
    raise exception 'refund_open_exists' using errcode = '23505';
  end if;
  v := authz.refund_validate(v_deal.id, p_fields);
  begin
    insert into public.customer_refund_requests (id, legal_entity_id, branch_id, deal_id, ref_no, kind, outcome, cancellation_id,
      requested_as, held_at_request_paise, customer_charge_paise, amount_paise, payee_kind, payee_name, payee_receipt_id,
      payee_reason, reason, requested_by, request_id, use_kept_credit)
    values (v_id, v_deal.legal_entity_id, v_deal.branch_id, v_deal.id, authz.refund_next_ref(v_deal.legal_entity_id),
      v ->> 'kind', v ->> 'outcome', (v ->> 'cancellationId')::uuid, v_role, (v ->> 'heldPaise')::bigint,
      (v ->> 'chargePaise')::bigint, (v ->> 'amountPaise')::bigint, v ->> 'payeeKind', v ->> 'payeeName',
      (v ->> 'payeeReceiptId')::uuid, v ->> 'payeeReason', v ->> 'reason', (select auth.uid()), p_request_id,
      coalesce((v ->> 'useKeptCredit')::boolean, false));
  exception when unique_violation then
    raise exception 'refund_open_exists' using errcode = '23505';
  end;
  v_result := authz.refund_result(v_id, 'created');
  perform authz.finance_remember(v_deal.legal_entity_id, p_request_id, 'customer_refund_request_create', v_payload, v_result);
  perform authz.write_audit('refund.requested', v_deal.legal_entity_id, v_deal.branch_id, 'customer_refund_request', v_id,
    v ->> 'reason', jsonb_build_object('refundRequestId', v_id, 'dealId', v_deal.id, 'kind', v ->> 'kind',
      'outcome', v ->> 'outcome', 'requestedAs', v_role));
  return v_result;
end;
$$;

create or replace function public.customer_refund_request_resubmit(p_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.customer_refund_requests%rowtype;
  v_payload jsonb := jsonb_build_object('refundRequestId', p_id, 'expectedRowVersion', p_expected_row_version, 'fields', p_fields);
  v_result jsonb;
  v jsonb;
begin
  if p_request_id is null then
    perform authz.refund_invalid('requestId');
  end if;
  r := authz.refund_for_command(p_id);
  if r.requested_by is distinct from (select auth.uid()) or authz.refund_requester_role(r.deal_id) is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_result := authz.finance_replay(r.legal_entity_id, p_request_id, 'customer_refund_request_resubmit', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if not authz.refunds_enabled(r.legal_entity_id) then
    raise exception 'refunds_off' using errcode = '55000';
  end if;
  if r.status <> 'returned' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, r.row_version);
  v := authz.refund_validate(r.deal_id, p_fields);
  update public.customer_refund_requests x
  set kind = v ->> 'kind', outcome = v ->> 'outcome', cancellation_id = (v ->> 'cancellationId')::uuid,
      held_at_request_paise = (v ->> 'heldPaise')::bigint, customer_charge_paise = (v ->> 'chargePaise')::bigint,
      amount_paise = (v ->> 'amountPaise')::bigint, payee_kind = v ->> 'payeeKind', payee_name = v ->> 'payeeName',
      payee_receipt_id = (v ->> 'payeeReceiptId')::uuid, payee_reason = v ->> 'payeeReason', reason = v ->> 'reason',
      use_kept_credit = coalesce((v ->> 'useKeptCredit')::boolean, false),
      status = 'requested', resubmitted_at = now(), decided_by = null, decided_at = null, decision_request_id = null,
      return_reason = null, row_version = x.row_version + 1, updated_at = now()
  where x.id = r.id;
  v_result := authz.refund_result(r.id, 'updated');
  perform authz.finance_remember(r.legal_entity_id, p_request_id, 'customer_refund_request_resubmit', v_payload, v_result);
  perform authz.write_audit('refund.resubmitted', r.legal_entity_id, r.branch_id, 'customer_refund_request', r.id,
    v ->> 'reason', jsonb_build_object('refundRequestId', r.id, 'dealId', r.deal_id, 'kind', v ->> 'kind',
      'outcome', v ->> 'outcome', 'rowVersion', r.row_version + 1));
  return v_result;
end;
$$;

create or replace function public.customer_refund_decide(p_id uuid, p_decision text, p_expected_amount_paise bigint,
  p_expected_charge_paise bigint, p_reason text, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.customer_refund_requests%rowtype;
  v_uid uuid := (select auth.uid());
  v_payload jsonb := jsonb_build_object('refundRequestId', p_id, 'decision', p_decision, 'expectedAmountPaise', p_expected_amount_paise,
    'expectedChargePaise', p_expected_charge_paise, 'reason', p_reason, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_reason text;
  v_status text;
begin
  if p_request_id is null then
    perform authz.refund_invalid('requestId');
  end if;
  r := authz.refund_for_command(p_id);
  if not authz.refund_decider(r.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if r.requested_by = v_uid then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  v_result := authz.finance_replay(r.legal_entity_id, p_request_id, 'customer_refund_decide', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_decision is null or p_decision not in ('approve', 'return') then
    perform authz.refund_invalid('decision');
  end if;
  if not authz.refunds_enabled(r.legal_entity_id) then
    raise exception 'refunds_off' using errcode = '55000';
  end if;
  if r.status <> 'requested' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, r.row_version);
  -- The decision binds the exact amounts the Manager saw.
  if p_expected_amount_paise is distinct from r.amount_paise or p_expected_charge_paise is distinct from r.customer_charge_paise then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if p_decision = 'approve' then
    if r.kind = 'cancellation' and not authz.deal_cancellation_approved(r.deal_id) then
      raise exception 'not_ready' using errcode = '55000', hint = 'cancellation';
    end if;
    -- Accounts phase 2 (20261204000380, Addendum L7): another settlement approved meanwhile with a higher charge.
    if r.kind = 'cancellation' and r.customer_charge_paise < coalesce(authz.refund_approved_charge(r.deal_id, r.id), 0) then
      raise exception 'charge_below_approved' using errcode = '22023', hint = 'approvedChargePaise';
    end if;
    if not authz.refund_limit_ok(r) then
      raise exception 'refund_exceeds_money' using errcode = '22023', hint = 'amountPaise';
    end if;
    v_status := 'approved';
  else
    begin
      v_reason := authz.finance_reason(p_reason);
    exception when sqlstate '22023' then
      perform authz.refund_invalid('reason');
    end;
    if v_reason is null then
      perform authz.refund_invalid('reason');
    end if;
    v_status := 'returned';
  end if;
  update public.customer_refund_requests x
  set status = v_status, decided_by = v_uid, decided_at = now(), decision_request_id = p_request_id,
      return_reason = v_reason, row_version = x.row_version + 1, updated_at = now()
  where x.id = r.id;
  v_result := authz.refund_result(r.id, 'updated');
  perform authz.finance_remember(r.legal_entity_id, p_request_id, 'customer_refund_decide', v_payload, v_result);
  perform authz.write_audit(case when v_status = 'approved' then 'refund.approved' else 'refund.returned' end,
    r.legal_entity_id, r.branch_id, 'customer_refund_request', r.id, v_reason,
    jsonb_build_object('refundRequestId', r.id, 'dealId', r.deal_id, 'kind', r.kind, 'outcome', r.outcome,
      'rowVersion', r.row_version + 1));
  return v_result;
end;
$$;

create or replace function public.customer_refund_request_withdraw(p_id uuid, p_expected_row_version integer, p_reason text,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.customer_refund_requests%rowtype;
  v_uid uuid := (select auth.uid());
  v_payload jsonb := jsonb_build_object('refundRequestId', p_id, 'expectedRowVersion', p_expected_row_version, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
  v_allowed boolean;
begin
  if p_request_id is null then
    perform authz.refund_invalid('requestId');
  end if;
  r := authz.refund_for_command(p_id);
  v_allowed := case
    when r.status in ('requested', 'returned') then r.requested_by = v_uid
    -- Accounts phase 2 (20261204000380, Addendum L7): approved settlements too, so a lower charge can follow.
    when r.status = 'approved' then authz.refund_is_m(r.deal_id)
      or (r.decided_by = v_uid and authz.refund_entity_manager(r.legal_entity_id))
    else r.requested_by = v_uid or r.decided_by = v_uid or authz.refund_is_m(r.deal_id) end;
  if not v_allowed then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_result := authz.finance_replay(r.legal_entity_id, p_request_id, 'customer_refund_request_withdraw', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if r.status not in ('requested', 'returned', 'approved') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  -- Kept credit already used by a paid payout cannot be withdrawn.
  if r.status = 'approved' and r.outcome = 'keep_credit'
     and authz.refund_kept_used(r.deal_id) > authz.refund_kept_total(r.deal_id) - r.amount_paise then
    raise exception 'wrong_state' using errcode = '55000', hint = 'keptCreditUsed';
  end if;
  perform authz.require_row_version(p_expected_row_version, r.row_version);
  begin
    v_reason := authz.finance_reason(p_reason);
  exception when sqlstate '22023' then
    perform authz.refund_invalid('reason');
  end;
  update public.customer_refund_requests x
  set status = 'withdrawn', withdrawn_by = v_uid, withdrawn_at = now(), withdraw_reason = v_reason,
      row_version = x.row_version + 1, updated_at = now()
  where x.id = r.id;
  v_result := authz.refund_result(r.id, 'updated');
  perform authz.finance_remember(r.legal_entity_id, p_request_id, 'customer_refund_request_withdraw', v_payload, v_result);
  perform authz.write_audit('refund.withdrawn', r.legal_entity_id, r.branch_id, 'customer_refund_request', r.id, v_reason,
    jsonb_build_object('refundRequestId', r.id, 'dealId', r.deal_id, 'previousStatus', r.status));
  return v_result;
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
    -- Accounts phase 2 (20261204000380, Addendum L7): the highest approved charge counts.
    order by r.deal_id, r.customer_charge_paise desc, r.decided_at desc, r.requested_at desc, r.id desc
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
      -- Accounts phase 2 (20261204000380, Addendum L7): only unused kept credit.
      'keptAsCreditPaise', authz.refund_kept_unused(v_deal.id)::text,
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
  v_kept_charges bigint;
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
  v_kept_charges := case when v_c.id is not null then authz.cancellation_charges_kept(v_c.id) end;
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
    -- Accounts phase 2 (20261204000380, Addendum L7): approved charge floor and unused kept credit.
    'approvedChargePaise', authz.refund_approved_charge(v_deal.id, null)::text,
    'keptCreditUnusedPaise', authz.refund_kept_unused(v_deal.id)::text,
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
          'useKeptCredit', q.use_kept_credit,
          -- Review 4: the charge is below what suppliers and airlines keep (warning, never a block).
          'warnings', case when q.kind = 'cancellation' and v_kept_charges is not null and q.customer_charge_paise < v_kept_charges
                           then '["charge_below_costs_kept"]'::jsonb else '[]'::jsonb end,
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
  -- Accounts phase 2 (20261204000380, Addendum L7, review 9): every scope passes the same finance gate as deal_refunds.
  v_m := array(select b.id from public.branches b
               where b.id = any(authz.acct_m_branches()) and authz.finance_gate_issue(b.legal_entity_id, v_syn) is null);
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
  v_so := array(select e from unnest(v_so) e
                where authz.finance_enabled(e) and authz.finance_gate_issue(e, v_syn) is null);
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
      -- 20261204000380 (Addendum L7, review 4): warning for the requester and the approving Manager.
      'useKeptCredit', x.use_kept_credit,
      'warnings', case when x.kind = 'cancellation' and x.cancellation_id is not null
                         and x.customer_charge_paise < authz.cancellation_charges_kept(x.cancellation_id)
                       then '["charge_below_costs_kept"]'::jsonb else '[]'::jsonb end,
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

revoke all on function authz.refund_approved_charge(uuid, uuid), authz.refund_kept_total(uuid), authz.refund_kept_used(uuid),
  authz.refund_kept_unused(uuid)
from public, anon, authenticated, service_role;

commit;
