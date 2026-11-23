-- Accounts phase 2, Track C (contract section 7.2, 7.3 C1-C6 and C12, LD5,
-- LD8, LD27, LD28, LD30, LD31, LD32; owner Q5-Q8): customer refund requests,
-- the Manager decision, refund proof files and the one-person payout.
--
-- Rules (7.2):
-- * Requester: the Deal's Sales owner (active Sales, no Purchase/Flight/Visa
--   or Accounts role), or a branch Manager (no P/F/V/Accounts role) when the
--   Deal has no active Sales owner. Never Accounts, Purchase, Flight or Visa.
-- * Approver: a branch Manager of the Deal (no P/F/V role) who is not the
--   requester; a Manager-requested refund: any other active Manager of the
--   entity (LD32). The decision binds the exact amount and charge.
-- * Payout: one Accounts person of the entity who is neither the requester
--   nor the approver records and verifies it in one step (Q6) with a stored
--   proof file; it posts refund_bank / refund_cash (20261204000320).
-- * Money: payout / keep_credit 1 <= amount <= held - charge (cancellation);
--   amount <= held - basis total (overpayment); charge_only amount 0. Held =
--   the Deal's customer_advances balance (authz.refund_money_held). Limits
--   are re-checked at approval and at payout.
-- * Concurrency: every command takes authz.finance_lock_deal first, then the
--   request row (13.1); the one-live index is the backstop.
--
-- Refusal tokens: refunds_off (55000), not_ready (55000), refund_open_exists
-- (23505), refund_exceeds_money (22023, hint amountPaise), evidence_missing
-- (55000), duplicate_file (23505), not_self_approval (42501), wrong_state,
-- version_changed, invalid_input (hint = field), not_authorized, not_found,
-- request_conflict, and the finance gate tokens (environment_unset,
-- not_configured).
-- Audit: refund.requested|resubmitted|withdrawn|approved|returned|paid,
-- accounts.refund_evidence.downloaded (Addendum L5), settings.accounts_changed.
--
-- Rollback (forward-only): a NEW migration dropping these functions.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Helpers
-- ===========================================================================

-- Section 4: the Deal's verified customer money (net of reversals and posted refunds).
create function authz.refund_money_held(p_deal uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(l.credit_paise - l.debit_paise), 0)::bigint
  from public.finance_journal_lines l
  where l.deal_id = p_deal and l.account = 'customer_advances'
$$;

-- Section 4: the Deal's trip cancellation is approved.
create function authz.deal_cancellation_approved(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.deal_cancellations c where c.deal_id = p_deal and c.status = 'approved')
$$;

-- LD28: refunds switch per entity (default Off).
create function authz.refunds_enabled(p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.refunds_enabled from public.accounts_settings s where s.legal_entity_id = p_entity), false)
$$;

-- The caller holds an active Purchase, Flight or Visa membership in the entity.
create function authz.refund_pfv(p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m
                 where m.user_id = (select auth.uid()) and m.legal_entity_id = p_entity
                   and m.role_code in ('purchase', 'flight', 'visa') and m.status = 'active')
$$;

-- SO: the caller owns the Deal, holds active Sales and no P/F/V role.
create function authz.refund_is_so(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and exists (
    select 1 from public.deals d
    where d.id = p_deal and d.owner_user_id = (select auth.uid())
      and authz.is_active_department_person(d.owner_user_id, d.legal_entity_id, 'sales')
      and not authz.refund_pfv(d.legal_entity_id))
$$;

-- M: an active branch Manager of the Deal without P/F/V membership (AL7).
create function authz.refund_is_m(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and authz.is_branch_sales_manager(p_deal)
    and not authz.refund_pfv((select d.legal_entity_id from public.deals d where d.id = p_deal))
$$;

-- LD32: an active Manager of the entity (any branch) without P/F/V membership.
create function authz.refund_entity_manager(p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and not authz.refund_pfv(p_entity) and exists (
    select 1 from public.memberships m
    join public.legal_entities e on e.id = m.legal_entity_id
    join public.branches b on b.id = m.branch_id
    where m.user_id = (select auth.uid()) and m.legal_entity_id = p_entity and m.role_code = 'manager'
      and m.status = 'active' and e.status = 'enabled' and b.status = 'enabled')
$$;

-- How the caller may ask for a refund on the Deal: 'sales_owner', 'manager' or null (7.2).
create function authz.refund_requester_role(p_deal uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when d.id is null or authz.holds_role('accounts', d.legal_entity_id) then null
    when authz.refund_is_so(d.id) then 'sales_owner'
    when authz.refund_is_m(d.id) and not authz.flight_has_active_sales_owner(d.id) then 'manager'
  end
  from (select 1) one left join public.deals d on d.id = p_deal
$$;

-- The caller may decide (approve / return) this request, ignoring self-approval.
create function authz.refund_decider(p_request uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select authz.refund_is_m(r.deal_id) or (r.requested_as = 'manager' and authz.refund_entity_manager(r.legal_entity_id))
    from public.customer_refund_requests r where r.id = p_request), false)
$$;

-- The latest approved (or paid) cancellation settlement of the Deal.
create function authz.refund_settlement(p_deal uuid) returns public.customer_refund_requests
language sql stable security definer set search_path = '' as $$
  select r.* from public.customer_refund_requests r
  where r.deal_id = p_deal and r.kind = 'cancellation' and r.status in ('approved', 'paid')
  order by r.decided_at desc, r.id desc limit 1
$$;

-- The amount the customer owes (dues total): the settlement's charge, else the
-- dues basis selling total; null without a confirmed booking version.
create function authz.refund_basis_total(p_deal uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select case
    when s.id is not null then s.customer_charge_paise
    else (select coalesce(bc.selling_total_paise, 0)::bigint
          from authz.dues_basis(p_deal) b
          left join public.booking_version_commercials bc on bc.version_id = b.version_id
          limit 1)
  end
  from (select 1) one left join lateral (select * from authz.refund_settlement(p_deal)) s on true
$$;

create function authz.refund_invalid(p_hint text) returns void
language plpgsql volatile set search_path = '' as $$
begin
  raise exception 'invalid_input' using errcode = '22023', hint = p_hint;
end;
$$;

-- The finance gate (LD27) as a refusal.
create function authz.refund_gate(p_entity uuid, p_synthetic boolean) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v text := authz.finance_gate_issue(p_entity, p_synthetic);
begin
  if v is not null then
    raise exception '%', v using errcode = '55000';
  end if;
end;
$$;

-- A text field ('' and JSON null -> null); non-string -> invalid_input hint key.
create function authz.refund_text(p_fields jsonb, p_key text, p_min integer, p_max integer, p_multiline boolean) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v jsonb := p_fields -> p_key;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v) <> 'string' then
    perform authz.refund_invalid(p_key);
  end if;
  begin
    return authz.finance_text(v #>> '{}', p_min, p_max, p_multiline);
  exception when sqlstate '22023' then
    perform authz.refund_invalid(p_key);
  end;
  return null;
end;
$$;

-- Whole paise from a JSON string or integer ('' / null -> null); else invalid_input hint key.
create function authz.refund_paise(p_fields jsonb, p_key text) returns bigint
language plpgsql immutable set search_path = '' as $$
declare
  v jsonb := p_fields -> p_key;
  t text;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v) not in ('string', 'number') then
    perform authz.refund_invalid(p_key);
  end if;
  t := btrim(v #>> '{}');
  if t = '' then
    return null;
  end if;
  if t !~ '^(0|[1-9][0-9]{0,14})$' then
    perform authz.refund_invalid(p_key);
  end if;
  return t::bigint;
end;
$$;

create function authz.refund_uuid(p_fields jsonb, p_key text) returns uuid
language plpgsql immutable set search_path = '' as $$
declare
  t text := authz.refund_text(p_fields, p_key, 1, 60, false);
begin
  if t is null then
    return null;
  end if;
  if t !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    perform authz.refund_invalid(p_key);
  end if;
  return t::uuid;
end;
$$;

-- Validates request fields (C1/C2) and the money limits (7.2) for the Deal
-- (locked by the caller). Returns the normalized request facts.
create function authz.refund_validate(p_deal uuid, p_fields jsonb) returns jsonb
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

-- Re-check of an existing request's money limit (approval and payout).
create function authz.refund_limit_ok(r public.customer_refund_requests) returns boolean
language sql stable security definer set search_path = '' as $$
  select case
    when r.outcome = 'charge_only' then true
    when r.kind = 'cancellation' then r.amount_paise <= authz.refund_money_held(r.deal_id) - r.customer_charge_paise
    else coalesce(r.amount_paise <= authz.refund_money_held(r.deal_id) - authz.refund_basis_total(r.deal_id), false)
  end
$$;

-- RF-YYYY-NNNNNN (IST calendar year), counter row locked.
create function authz.refund_next_ref(p_entity uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_year integer := extract(year from authz.finance_today())::integer;
  v_no integer;
begin
  insert into public.customer_refund_counters (legal_entity_id, year) values (p_entity, v_year)
  on conflict (legal_entity_id, year) do nothing;
  update public.customer_refund_counters c set last_no = c.last_no + 1
  where c.legal_entity_id = p_entity and c.year = v_year
  returning c.last_no into v_no;
  return 'RF-' || v_year::text || '-' || lpad(v_no::text, 6, '0');
end;
$$;

create function authz.refund_result(p_id uuid, p_outcome text) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('outcome', p_outcome, 'refundRequestId', r.id, 'refNo', r.ref_no, 'status', r.status,
    'rowVersion', r.row_version)
  from public.customer_refund_requests r where r.id = p_id
$$;

-- Loads a request for a command: session first, then the Deal, the finance
-- gate and the Deal lock (13.1 order), then the request row for update.
create function authz.refund_for_command(p_id uuid) returns public.customer_refund_requests
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.customer_refund_requests%rowtype;
  v_deal public.deals%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into r from public.customer_refund_requests x where x.id = p_id;
  if r.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_deal from public.deals d where d.id = r.deal_id;
  perform authz.refund_gate(v_deal.legal_entity_id, v_deal.is_synthetic);
  perform authz.finance_lock_deal(r.deal_id);
  select * into r from public.customer_refund_requests x where x.id = p_id for update;
  return r;
end;
$$;

-- ===========================================================================
-- 2. C1 customer_refund_request_create
-- ===========================================================================

create function public.customer_refund_request_create(p_deal_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
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
      payee_reason, reason, requested_by, request_id)
    values (v_id, v_deal.legal_entity_id, v_deal.branch_id, v_deal.id, authz.refund_next_ref(v_deal.legal_entity_id),
      v ->> 'kind', v ->> 'outcome', (v ->> 'cancellationId')::uuid, v_role, (v ->> 'heldPaise')::bigint,
      (v ->> 'chargePaise')::bigint, (v ->> 'amountPaise')::bigint, v ->> 'payeeKind', v ->> 'payeeName',
      (v ->> 'payeeReceiptId')::uuid, v ->> 'payeeReason', v ->> 'reason', (select auth.uid()), p_request_id);
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

-- ===========================================================================
-- 3. C2 customer_refund_request_resubmit
-- ===========================================================================

create function public.customer_refund_request_resubmit(p_id uuid, p_expected_row_version integer, p_fields jsonb,
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

-- ===========================================================================
-- 4. C3 customer_refund_request_withdraw (LD31)
-- ===========================================================================

create function public.customer_refund_request_withdraw(p_id uuid, p_expected_row_version integer, p_reason text,
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
    when r.status = 'approved' and r.outcome = 'payout' then authz.refund_is_m(r.deal_id)
      or (r.decided_by = v_uid and authz.refund_entity_manager(r.legal_entity_id))
    else r.requested_by = v_uid or r.decided_by = v_uid or authz.refund_is_m(r.deal_id) end;
  if not v_allowed then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_result := authz.finance_replay(r.legal_entity_id, p_request_id, 'customer_refund_request_withdraw', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if not (r.status in ('requested', 'returned') or (r.status = 'approved' and r.outcome = 'payout')) then
    raise exception 'wrong_state' using errcode = '55000';
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

-- ===========================================================================
-- 5. C4 customer_refund_decide
-- ===========================================================================

create function public.customer_refund_decide(p_id uuid, p_decision text, p_expected_amount_paise bigint,
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

-- ===========================================================================
-- 6. C5 refund proof files (bucket finance-evidence)
-- ===========================================================================

create function public.refund_evidence_begin(p_subject_kind text, p_subject_id uuid, p_file_name text, p_mime text,
  p_size_bytes integer, p_sha256 text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_req public.customer_refund_requests%rowtype;
  v_c public.deal_cancellations%rowtype;
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
    select * into v_deal from public.deals d where d.id = v_c.deal_id;
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
  if p_subject_kind = 'supplier_refund' and v_c.status <> 'approved' then
    raise exception 'not_ready' using errcode = '55000', hint = 'cancellation';
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
  if (select count(*) from public.refund_evidence e
      where e.subject_kind = p_subject_kind and e.subject_id = p_subject_id and e.status <> 'removed') >= 10 then
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

create function public.refund_evidence_finish(p_evidence_id uuid, p_ok boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.refund_evidence%rowtype;
  v_deal public.deals%rowtype;
  v_status text;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v from public.refund_evidence e where e.id = p_evidence_id for update;
  if v.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_deal from public.deals d where d.id = v.deal_id;
  perform authz.finance_require_accounts(v.legal_entity_id, v_deal.is_synthetic);
  if v.uploaded_by is distinct from (select auth.uid()) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_ok is null then
    perform authz.refund_invalid('ok');
  end if;
  v_status := case when p_ok then 'stored' else 'failed' end;
  if v.status <> 'pending_upload' then
    if v.status = v_status or (p_ok and v.status = 'failed') then
      return jsonb_build_object('outcome', 'existing', 'evidenceId', v.id, 'status', v.status);
    end if;
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  -- 'stored' only when Storage holds the object at the generated path with the declared size.
  if p_ok and (to_regclass('storage.objects') is null or not exists (
       select 1 from storage.objects o
       where o.bucket_id = 'finance-evidence' and o.name = v.object_path
         and (o.metadata ->> 'size') ~ '^[0-9]{1,18}$'
         and (o.metadata ->> 'size')::bigint = v.size_bytes)) then
    v_status := 'failed';
  end if;
  update public.refund_evidence e
  set status = v_status, stored_at = case when v_status = 'stored' then now() end, updated_at = now()
  where e.id = v.id;
  return jsonb_build_object('outcome', 'updated', 'evidenceId', v.id, 'status', v_status);
end;
$$;

-- Download: Accounts of the entity, or a branch Manager of the Deal (M); audited.
create function public.refund_evidence_authorize_download(p_evidence_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.refund_evidence%rowtype;
  v_deal public.deals%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v from public.refund_evidence e where e.id = p_evidence_id;
  if v.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_deal from public.deals d where d.id = v.deal_id;
  if not ((authz.can_accounts(v.legal_entity_id) and authz.finance_gate_issue(v.legal_entity_id, v_deal.is_synthetic) is null)
          or (authz.refund_is_m(v.deal_id) and authz.finance_gate_issue(v.legal_entity_id, v_deal.is_synthetic) is null)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v.status <> 'stored' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.write_audit('accounts.refund_evidence.downloaded', v.legal_entity_id, v_deal.branch_id, 'refund_evidence', v.id, null,
    jsonb_build_object('evidenceId', v.id, 'subjectKind', v.subject_kind, 'subjectId', v.subject_id));
  return jsonb_build_object('objectPath', v.object_path, 'fileName', v.file_name, 'mime', v.mime);
end;
$$;

-- ===========================================================================
-- 7. C6 customer_refund_payout_record (Q6: one person records and verifies)
-- ===========================================================================

create function public.customer_refund_payout_record(p_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.customer_refund_requests%rowtype;
  v_deal public.deals%rowtype;
  v_uid uuid := (select auth.uid());
  v_payload jsonb := jsonb_build_object('refundRequestId', p_id, 'expectedRowVersion', p_expected_row_version, 'fields', p_fields);
  v_result jsonb;
  v_key text;
  v_mode text;
  v_on_text text;
  v_on date;
  v_ref text;
  v_evidence uuid;
  v_payout uuid := gen_random_uuid();
  v_entry uuid;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into r from public.customer_refund_requests x where x.id = p_id;
  if r.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_deal from public.deals d where d.id = r.deal_id;
  perform authz.finance_require_accounts(v_deal.legal_entity_id, v_deal.is_synthetic);
  if v_uid = r.requested_by or v_uid is not distinct from r.decided_by then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if p_request_id is null then
    perform authz.refund_invalid('requestId');
  end if;
  perform authz.finance_lock_deal(r.deal_id);
  select * into r from public.customer_refund_requests x where x.id = p_id for update;
  v_result := authz.finance_replay(r.legal_entity_id, p_request_id, 'customer_refund_payout_record', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_uid is not distinct from r.decided_by then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if not authz.refunds_enabled(r.legal_entity_id) then
    raise exception 'refunds_off' using errcode = '55000';
  end if;
  if r.status <> 'approved' or r.outcome <> 'payout' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, r.row_version);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    perform authz.refund_invalid('fields');
  end if;
  for v_key in select k from jsonb_object_keys(p_fields) k order by k loop
    if v_key <> all (array['mode', 'paidOn', 'reference', 'evidenceId']) then
      perform authz.refund_invalid(v_key);
    end if;
  end loop;
  v_mode := authz.refund_text(p_fields, 'mode', 1, 20, false);
  if v_mode is null or v_mode not in ('bank_transfer', 'upi', 'cash', 'cheque') then
    perform authz.refund_invalid('mode');
  end if;
  v_on_text := authz.refund_text(p_fields, 'paidOn', 10, 10, false);
  if v_on_text is null or v_on_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    perform authz.refund_invalid('paidOn');
  end if;
  begin
    v_on := v_on_text::date;
  exception when others then
    perform authz.refund_invalid('paidOn');
  end;
  if v_on < (r.decided_at at time zone 'Asia/Kolkata')::date or v_on > authz.finance_today() then
    perform authz.refund_invalid('paidOn');
  end if;
  v_ref := authz.refund_text(p_fields, 'reference', 1, 40, false);
  if (v_ref is null and v_mode <> 'cash') or (v_ref is not null and v_ref !~ '^[A-Za-z0-9/-]{4,40}$') then
    perform authz.refund_invalid('reference');
  end if;
  v_evidence := authz.refund_uuid(p_fields, 'evidenceId');
  if v_evidence is null or not exists (
       select 1 from public.refund_evidence e
       where e.id = v_evidence and e.legal_entity_id = r.legal_entity_id and e.subject_kind = 'customer_refund'
         and e.subject_id = r.id and e.status = 'stored')
     or exists (select 1 from public.customer_refund_payouts p where p.evidence_id = v_evidence) then
    raise exception 'evidence_missing' using errcode = '55000';
  end if;
  -- Re-check: held may have fallen since approval (a reversal, another refund).
  if not authz.refund_limit_ok(r) then
    raise exception 'refund_exceeds_money' using errcode = '22023', hint = 'amountPaise';
  end if;

  -- The entry first (its payout link is a deferred key), then the payout row.
  v_entry := authz.finance_post(case when v_mode = 'cash' then 'refund_cash' else 'refund_bank' end, r.legal_entity_id, null, null,
    r.deal_id, r.branch_id, v_on, null, r.amount_paise, v_payout);
  insert into public.customer_refund_payouts (id, legal_entity_id, branch_id, deal_id, refund_request_id, amount_paise, mode, paid_on,
    reference, evidence_id, journal_entry_id, recorded_by, request_id)
  values (v_payout, r.legal_entity_id, r.branch_id, r.deal_id, r.id, r.amount_paise, v_mode, v_on, v_ref, v_evidence, v_entry,
    v_uid, p_request_id);
  update public.customer_refund_requests x
  set status = 'paid', paid_at = now(), row_version = x.row_version + 1, updated_at = now()
  where x.id = r.id;
  v_result := authz.refund_result(r.id, 'created') || jsonb_build_object('payoutId', v_payout, 'journalEntryId', v_entry);
  perform authz.finance_remember(r.legal_entity_id, p_request_id, 'customer_refund_payout_record', v_payload, v_result);
  perform authz.write_audit('refund.paid', r.legal_entity_id, r.branch_id, 'customer_refund_request', r.id, null,
    jsonb_build_object('refundRequestId', r.id, 'payoutId', v_payout, 'journalEntryId', v_entry, 'mode', v_mode));
  return v_result;
end;
$$;

-- ===========================================================================
-- 8. C12 admin_set_refunds_enabled
-- ===========================================================================

create function public.admin_set_refunds_enabled(p_entity uuid, p_enabled boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before boolean;
  v_after public.accounts_settings%rowtype;
  v_reason text;
  v_prev text[];
begin
  if p_entity is null or not authz.can_manage_finance_policy(p_entity) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  begin
    v_reason := authz.finance_reason(p_reason);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end;
  if p_enabled is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'enabled';
  end if;
  select s.refunds_enabled into v_before from public.accounts_settings s where s.legal_entity_id = p_entity for update;
  v_prev := authz.settings_begin_change('admin_set_refunds_enabled', v_reason);
  insert into public.accounts_settings as s (legal_entity_id, refunds_enabled, updated_by)
  values (p_entity, p_enabled, (select auth.uid()))
  on conflict (legal_entity_id) do update
    set refunds_enabled = excluded.refunds_enabled, updated_by = excluded.updated_by, updated_at = now(),
        row_version = s.row_version + 1
    where s.refunds_enabled is distinct from excluded.refunds_enabled
  returning * into v_after;
  perform authz.settings_end_change(v_prev);
  if v_after.legal_entity_id is null then
    select * into v_after from public.accounts_settings s where s.legal_entity_id = p_entity;
  end if;
  return jsonb_build_object('changed', coalesce(v_before, false) is distinct from p_enabled,
    'refundsEnabled', v_after.refunds_enabled, 'rowVersion', v_after.row_version, 'updatedAt', v_after.updated_at);
end;
$$;

-- ===========================================================================
-- 9. Grants
-- ===========================================================================

revoke all on function
  authz.refund_money_held(uuid), authz.deal_cancellation_approved(uuid), authz.refunds_enabled(uuid), authz.refund_pfv(uuid),
  authz.refund_is_so(uuid), authz.refund_is_m(uuid), authz.refund_entity_manager(uuid), authz.refund_requester_role(uuid),
  authz.refund_decider(uuid), authz.refund_settlement(uuid), authz.refund_basis_total(uuid), authz.refund_invalid(text),
  authz.refund_gate(uuid, boolean), authz.refund_text(jsonb, text, integer, integer, boolean), authz.refund_paise(jsonb, text),
  authz.refund_uuid(jsonb, text), authz.refund_validate(uuid, jsonb), authz.refund_limit_ok(public.customer_refund_requests),
  authz.refund_next_ref(uuid), authz.refund_result(uuid, text), authz.refund_for_command(uuid)
from public, anon, authenticated, service_role;

revoke all on function
  public.customer_refund_request_create(uuid, jsonb, uuid),
  public.customer_refund_request_resubmit(uuid, integer, jsonb, uuid),
  public.customer_refund_request_withdraw(uuid, integer, text, uuid),
  public.customer_refund_decide(uuid, text, bigint, bigint, text, integer, uuid),
  public.refund_evidence_begin(text, uuid, text, text, integer, text, uuid),
  public.refund_evidence_finish(uuid, boolean),
  public.refund_evidence_authorize_download(uuid),
  public.customer_refund_payout_record(uuid, integer, jsonb, uuid),
  public.admin_set_refunds_enabled(uuid, boolean, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.customer_refund_request_create(uuid, jsonb, uuid),
  public.customer_refund_request_resubmit(uuid, integer, jsonb, uuid),
  public.customer_refund_request_withdraw(uuid, integer, text, uuid),
  public.customer_refund_decide(uuid, text, bigint, bigint, text, integer, uuid),
  public.refund_evidence_begin(text, uuid, text, text, integer, text, uuid),
  public.refund_evidence_finish(uuid, boolean),
  public.refund_evidence_authorize_download(uuid),
  public.customer_refund_payout_record(uuid, integer, jsonb, uuid),
  public.admin_set_refunds_enabled(uuid, boolean, text)
to authenticated;

commit;
