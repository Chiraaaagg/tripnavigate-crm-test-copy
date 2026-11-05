-- Flight build, Track B (2 of 3): flight money helpers and commands, and the
-- supplier money replacements that add the flight branch.
-- Contract: flight build contract (frozen 4 Nov 2026) sections 4, 6.2, 6.3,
-- 9.4 and conflict note C1; shapes and messages:
-- crm/src/modules/flight/money-contracts.ts.
--
-- New commands (security definer, execute to authenticated only):
--   flight_supplier_create, flight_supplier_add_beneficiary (B2, B3)
--   flight_fare_approval_request / _decide / _withdraw (B5-B7)
--   flight_tickets_confirm (B8: tickets + fares in one transaction)
--   flight_direct_payment_save (B9), flight_payment_request_create (B10)
--
-- Replaced, same signatures (Purchase behaviour unchanged: every Purchase
-- path below is the previous body; the flight branch is added in front of
-- it or beside it):
--   authz.sm_payment_create, authz.sm_payment_still_valid,
--   authz.sm_payment_for_command, authz.sm_supplier_running_total,
--   authz.sm_trip_end, authz.sm_invoice_missing,
--   public.supplier_payment_request_cancel, public.supplier_payment_decide,
--   public.supplier_money_evidence_begin,
--   public.supplier_money_evidence_authorize_download,
--   public.supplier_document_upload,
--   public.department_cost_save (flight refused: hint flightFares, B13),
--   public.department_cost_submit (a batch's direct payment is resubmitted
--     only through flight_direct_payment_save),
--   authz.flight_money_issues (Track A's stub; B12).
--
-- Money rule (C1, lead L1): for one (Deal, supplier) the running total is
-- every live supplier payment request plus every flight direct payment that
-- is not returned. A direct payment is allowed while running total + amount
-- <= 5_000_000 paise (exactly INR 50,000 is direct). A request routes to
-- Accounts at or below that, to the branch Manager above.
--
-- Lock order (never reversed): finance_deal_heads (authz.finance_lock_deal)
-- -> the Deal's flight tasks (authz.flight_lock_group) -> approval / payment
-- request -> funding -> counter.
--
-- Refusal tokens (message is exactly the token): 42501 not_authorized,
-- not_self_approval | P0002 not_found | 40001 version_changed,
-- duplicate_request | 22023 invalid_input (hint = field), discount_over_fare,
-- traveller_not_on_sector, direct_payment_over_limit, evidence_rejected |
-- 23505 ticket_number_taken, duplicate_supplier | 55000 not_ready,
-- booking_changed, already_confirmed, already_decided, over_budget,
-- fare_approval_mismatch, not_over_budget, payment_in_progress,
-- receipt_required, cost_locked, trip_cancelled, deal_removed,
-- environment_unset, not_configured.
--
-- Audit rows never carry amounts, PNRs, ticket numbers, names or bank values.
--
-- Rollback (forward-only): a NEW migration restoring the replaced bodies
-- from 20261119000500 / 20261130000200 and revoking the new commands.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Helpers
-- ===========================================================================

-- sha256 of the canonical fare JSON (jsonb text output is canonical: keys in
-- a fixed order, no insignificant whitespace). The caller builds the payload
-- with sorted arrays (authz.flight_fare_check).
create function authz.flight_fare_hash(p_payload jsonb) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(coalesce(p_payload, 'null'::jsonb)::text, 'UTF8')), 'hex')
$$;

-- Whole paise from a JSON string or number, 0..p_max; null when absent.
create function authz.flight_paise(p_value jsonb, p_hint text, p_max bigint) returns bigint
language plpgsql immutable set search_path = '' as $$
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    return null;
  end if;
  if jsonb_typeof(p_value) not in ('string', 'number') or (p_value #>> '{}') !~ '^(0|[1-9][0-9]{0,17})$'
     or (p_value #>> '{}')::numeric > p_max then
    raise exception 'invalid_input' using errcode = '22023', hint = p_hint;
  end if;
  return (p_value #>> '{}')::bigint;
end;
$$;

-- Deal flight budget: the sum of the group's task budgets; null when any task
-- has none, or the Deal has no flight task (contract section 4, L4, L5).
create function authz.flight_deal_budget(p_deal uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select case when count(*) = 0 or bool_or(b.budget_paise is null) then null else sum(b.budget_paise)::bigint end
  from public.fulfilment_tasks t
  cross join lateral (select x.budget_paise from authz.flight_task_budget(t.id) x limit 1) b
  where t.deal_id = p_deal and t.department = 'flight'
$$;

-- Supplier cost of every confirmed batch of the Deal.
create function authz.flight_deal_supplier_cost(p_deal uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(b.supplier_cost_paise), 0)::bigint from public.flight_ticket_batches b where b.deal_id = p_deal
$$;

-- The caller is the Flight person of this flight task (open or done).
create function authz.flight_owns_task(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task and t.department = 'flight' and t.status in ('in_progress', 'completed')
      and t.assignee_user_id = (select auth.uid()) and authz.holds_active_role('flight', t.legal_entity_id))
$$;

-- The caller is the Flight person of any task of the Deal's flight group.
create function authz.flight_is_deal_assignee(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.fulfilment_tasks t
    where t.deal_id = p_deal and t.department = 'flight' and t.status in ('in_progress', 'completed')
      and t.assignee_user_id = (select auth.uid()))
    or exists (
      select 1 from public.deal_assignments a
      where a.deal_id = p_deal and a.user_id = (select auth.uid()) and a.assignment_kind = 'flight' and a.ended_at is null)
$$;

-- Flight gate plus the finance gate (test environment: synthetic Deals only).
create function authz.flight_money_gate(p_deal uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_issue text;
  v_deal public.deals%rowtype;
begin
  v_issue := authz.flight_gate_issue(p_deal);
  if v_issue is null then
    select * into v_deal from public.deals d where d.id = p_deal;
    v_issue := authz.finance_gate_issue(v_deal.legal_entity_id, v_deal.is_synthetic);
  end if;
  if v_issue is not null then
    raise exception '%', v_issue using errcode = '55000';
  end if;
end;
$$;

-- Payment state of one batch (contract 9.3 payment.state; "batch paid" of
-- section 4). A live request wins, then a direct entry that is not returned,
-- then the most recent returned/cancelled one.
create function authz.flight_batch_payment(p_batch uuid)
returns table (state text, route text, ref_no text, return_reason text, entry_id uuid, entry_row_version integer,
               payment_id uuid, payment_row_version integer, on_hold boolean, hold_reason text, paid boolean)
language sql stable security definer set search_path = '' as $$
  with e as (
    select c.* from public.department_cost_entries c where c.flight_batch_id = p_batch
  ), live as (
    select p.* from public.supplier_payment_requests p
    where p.flight_batch_id = p_batch and p.status in ('pending', 'approved', 'paid', 'verified')
  ), last_req as (
    select p.* from public.supplier_payment_requests p
    where p.flight_batch_id = p_batch and p.status in ('returned', 'cancelled')
    order by coalesce(p.decided_at, p.cancelled_at, p.requested_at) desc, p.requested_at desc limit 1
  ), pick as (
    select 'request' as src, l.id, 'request_' || l.status as state, 1 as rank, l.requested_at as at from live l
    union all
    select 'entry', e.id, 'direct_' || e.expense_status, 2, e.updated_at from e where e.expense_status in ('submitted', 'accepted')
    union all
    select 'entry', e.id, 'direct_returned', 3, coalesce(e.reviewed_at, e.updated_at) from e where e.expense_status = 'returned'
    union all
    select 'request', r.id, 'request_' || r.status, 3, coalesce(r.decided_at, r.cancelled_at, r.requested_at) from last_req r
  ), top as (
    select * from pick order by rank, at desc limit 1
  )
  select coalesce(t.state, 'unpaid'),
         case when t.src = 'entry' then 'direct' when t.src = 'request' then p.route end,
         p.ref_no,
         case when t.src = 'entry' then e.return_reason else p.return_reason end,
         (select e2.id from e e2 limit 1),
         (select e2.row_version from e e2 limit 1),
         case when t.src = 'request' then p.id end,
         case when t.src = 'request' then p.row_version end,
         case when t.src = 'request' and p.status in ('pending', 'approved') then authz.sm_hold_reason(p.id) is not null end,
         case when t.src = 'request' and p.status in ('pending', 'approved') then authz.sm_hold_reason(p.id) end,
         coalesce(t.state in ('request_approved', 'request_paid', 'request_verified')
           or (t.state in ('direct_submitted', 'direct_accepted') and authz.expense_receipt_ok(e.id)), false)
  from (select 1) one
  left join top t on true
  left join public.supplier_payment_requests p on t.src = 'request' and p.id = t.id
  left join e on t.src = 'entry' and e.id = t.id
$$;

-- A batch with nothing to pay (zero supplier cost) counts as paid.
create function authz.flight_batch_paid(p_batch uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select b.supplier_cost_paise = 0 from public.flight_ticket_batches b where b.id = p_batch), false)
      or coalesce((select x.paid from authz.flight_batch_payment(p_batch) x), false)
$$;

-- Validates a fare set (B4, B5, B8) and computes everything the commands
-- need. p_mode: 'preview' | 'approval' | 'confirm'. Ticket identifiers are
-- accepted (ignored) on preview and approval so the popup can post the same
-- object; on confirm they are checked by the caller with Track A's helpers.
-- Returns jsonb: payload (canonical), fareHash, dealKind, costTaskId,
-- supplierId, sectorIds, travellers [{seq, type, name, line, sectorIds}],
-- fares [{paxType, basic, k, yq, yr, other, markup, discount, supplierPerPerson,
-- totalPerPerson, paxCount}], batchSupplierCost, batchCustomerTotal,
-- dealCostBefore, dealCostAfter, dealBudget, overBudget, taskIds.
create function authz.flight_fare_check(p_deal uuid, p_fields jsonb, p_mode text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_sector_ids uuid[] := '{}';
  v_raw jsonb;
  v_el jsonb;
  v_i integer;
  v_id uuid;
  v_supplier uuid;
  v_kind text;
  v_task_ids uuid[];
  v_cost_task uuid;
  v_travellers jsonb := '[]'::jsonb;
  v_seq integer;
  v_seqs integer[] := '{}';
  v_type text;
  v_name text;
  v_covered uuid[];
  v_types text[] := '{}';
  v_fares jsonb := '[]'::jsonb;
  v_fare_types text[] := '{}';
  v_basic bigint; v_k bigint; v_yq bigint; v_yr bigint; v_other bigint; v_markup bigint; v_discount bigint;
  v_count integer;
  v_supplier_pp bigint;
  v_total_pp bigint;
  v_batch_cost numeric := 0;
  v_batch_customer numeric := 0;
  v_before bigint;
  v_budget bigint;
  v_over boolean;
  v_payload jsonb;
  v_max bigint := 99999999999;
  v_ticket_keys text[] := array['seq', 'crsType', 'crsPnr', 'airlinePnr', 'ticketNumber'];
begin
  select * into v_deal from public.deals d where d.id = p_deal;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  if (p_fields - array['sectorIds', 'supplierId', 'fareApprovalId', 'fares', 'travellers']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023',
      hint = (select string_agg(k, ',' order by k) from jsonb_object_keys(p_fields - array['sectorIds', 'supplierId',
        'fareApprovalId', 'fares', 'travellers']) k);
  end if;

  -- Sectors: 1..16 distinct active sectors of this Deal.
  v_raw := p_fields -> 'sectorIds';
  if v_raw is null or jsonb_typeof(v_raw) <> 'array' or jsonb_array_length(v_raw) not between 1 and 16 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'sectorIds';
  end if;
  for v_el in select x from jsonb_array_elements(v_raw) x loop
    if jsonb_typeof(v_el) <> 'string'
       or (v_el #>> '{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'sectorIds';
    end if;
    v_id := (v_el #>> '{}')::uuid;
    if v_id = any (v_sector_ids) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'sectorIds';
    end if;
    v_sector_ids := v_sector_ids || v_id;
  end loop;
  if (select count(*) from public.flight_sectors s
      join public.fulfilment_tasks t on t.id = s.task_id
      where s.id = any (v_sector_ids) and s.deal_id = p_deal and s.status = 'active'
        and t.department = 'flight' and t.status = 'in_progress') <> cardinality(v_sector_ids) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'sectorIds';
  end if;
  select array_agg(distinct s.task_id) into v_task_ids from public.flight_sectors s where s.id = any (v_sector_ids);
  if exists (select 1 from public.flight_task_state st
             where st.task_id = any (v_task_ids) and st.basis_version_id is distinct from authz.task_current_version(st.task_id))
     or exists (select 1 from unnest(v_task_ids) x(t)
                where not exists (select 1 from public.flight_task_state st where st.task_id = x.t)) then
    raise exception 'booking_changed' using errcode = '55000';
  end if;
  -- The task of the earliest ticked sector carries the whole batch (L8).
  select s.task_id into v_cost_task from public.flight_sectors s
  where s.id = any (v_sector_ids)
  order by s.depart_date, s.depart_time nulls last, s.id limit 1;

  -- Supplier: active, serves flights, same entity.
  v_raw := p_fields -> 'supplierId';
  if v_raw is null or jsonb_typeof(v_raw) <> 'string'
     or (v_raw #>> '{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'supplierId';
  end if;
  v_supplier := (v_raw #>> '{}')::uuid;
  if not exists (select 1 from public.suppliers s
                 where s.id = v_supplier and s.legal_entity_id = v_deal.legal_entity_id and s.status = 'active'
                   and s.service_types @> array['flight']) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'supplierId';
  end if;

  v_kind := authz.flight_deal_kind(p_deal);

  -- Travellers: named, on at least one ticked sector (current, not held), no ticket there yet.
  v_raw := p_fields -> 'travellers';
  if v_raw is null or jsonb_typeof(v_raw) <> 'array' or jsonb_array_length(v_raw) not between 1 and 100 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'travellers';
  end if;
  v_i := 0;
  for v_el in select x from jsonb_array_elements(v_raw) x loop
    if jsonb_typeof(v_el) <> 'object' or (v_el - v_ticket_keys) <> '{}'::jsonb
       or jsonb_typeof(v_el -> 'seq') is distinct from 'number' or (v_el ->> 'seq') !~ '^[0-9]{1,3}$'
       or (v_el ->> 'seq')::integer not between 1 and 100 then
      raise exception 'invalid_input' using errcode = '22023', hint = 'travellers[' || v_i || '].seq';
    end if;
    v_seq := (v_el ->> 'seq')::integer;
    if v_seq = any (v_seqs) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'travellers[' || v_i || '].seq';
    end if;
    v_seqs := v_seqs || v_seq;
    select array_agg(p.sector_id order by p.sector_id) into v_covered
    from public.flight_sector_passengers p
    where p.sector_id = any (v_sector_ids) and p.traveller_seq = v_seq
      and p.ended_at is null and p.held_by_change_id is null;
    if v_covered is null then
      raise exception 'traveller_not_on_sector' using errcode = '22023', hint = 'travellers[' || v_i || '].seq';
    end if;
    if exists (select 1 from public.flight_ticket_revisions r
               where r.sector_id = any (v_covered) and r.traveller_seq = v_seq) then
      raise exception 'already_confirmed' using errcode = '55000', hint = 'travellers[' || v_i || '].seq';
    end if;
    select bt.traveller_type, bt.full_name into v_type, v_name
    from public.booking_version_travellers bt
    where bt.booking_version_id = authz.task_current_version(v_cost_task) and bt.seq = v_seq;
    if v_type is null then
      -- Not named in the accepted booking: cannot get a ticket (owner D7).
      raise exception 'traveller_not_on_sector' using errcode = '22023', hint = 'travellers[' || v_i || '].seq';
    end if;
    v_types := v_types || v_type;
    v_travellers := v_travellers || jsonb_build_array(jsonb_build_object(
      'seq', v_seq, 'type', v_type, 'name', v_name, 'line', v_el, 'sectorIds', to_jsonb(v_covered)));
    v_i := v_i + 1;
  end loop;

  -- Fares: exactly one per traveller type present.
  v_raw := p_fields -> 'fares';
  if v_raw is null or jsonb_typeof(v_raw) <> 'array' or jsonb_array_length(v_raw) not between 1 and 3 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fares';
  end if;
  v_i := 0;
  for v_el in select x from jsonb_array_elements(v_raw) x loop
    if jsonb_typeof(v_el) <> 'object'
       or (v_el - array['paxType', 'basicPaise', 'kPaise', 'yqPaise', 'yrPaise', 'otherPaise', 'markupPaise', 'discountPaise'])
          <> '{}'::jsonb
       or jsonb_typeof(v_el -> 'paxType') is distinct from 'string'
       or (v_el ->> 'paxType') not in ('adult', 'child', 'infant')
       or (v_el ->> 'paxType') = any (v_fare_types) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'fares[' || v_i || '].paxType';
    end if;
    v_type := v_el ->> 'paxType';
    v_fare_types := v_fare_types || v_type;
    v_basic := authz.flight_paise(v_el -> 'basicPaise', 'fares[' || v_i || '].basicPaise', v_max);
    if v_basic is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'fares[' || v_i || '].basicPaise';
    end if;
    v_k := coalesce(authz.flight_paise(v_el -> 'kPaise', 'fares[' || v_i || '].kPaise', v_max), 0);
    v_yq := coalesce(authz.flight_paise(v_el -> 'yqPaise', 'fares[' || v_i || '].yqPaise', v_max), 0);
    v_yr := coalesce(authz.flight_paise(v_el -> 'yrPaise', 'fares[' || v_i || '].yrPaise', v_max), 0);
    v_other := coalesce(authz.flight_paise(v_el -> 'otherPaise', 'fares[' || v_i || '].otherPaise', v_max), 0);
    v_markup := authz.flight_paise(v_el -> 'markupPaise', 'fares[' || v_i || '].markupPaise', v_max);
    v_discount := authz.flight_paise(v_el -> 'discountPaise', 'fares[' || v_i || '].discountPaise', v_max);
    if v_kind = 'package' then
      -- Owner D4: no markup or discount on package Deals.
      if v_markup is not null then
        raise exception 'invalid_input' using errcode = '22023', hint = 'fares[' || v_i || '].markupPaise';
      end if;
      if v_discount is not null then
        raise exception 'invalid_input' using errcode = '22023', hint = 'fares[' || v_i || '].discountPaise';
      end if;
    else
      if v_markup is null then
        raise exception 'invalid_input' using errcode = '22023', hint = 'fares[' || v_i || '].markupPaise';
      end if;
      if v_discount is null then
        raise exception 'invalid_input' using errcode = '22023', hint = 'fares[' || v_i || '].discountPaise';
      end if;
    end if;
    v_supplier_pp := v_basic + v_k + v_yq + v_yr + v_other;
    v_total_pp := v_supplier_pp + coalesce(v_markup, 0) - coalesce(v_discount, 0);
    if v_total_pp < 0 then
      raise exception 'discount_over_fare' using errcode = '22023', hint = 'fares[' || v_i || '].discountPaise';
    end if;
    select count(*) into v_count from unnest(v_types) t where t = v_type;
    if v_count = 0 then
      -- Confirm: exactly the types among the posted travellers. Preview and
      -- approval drop a line for a type nobody has (the popup may keep it), so
      -- the approved hash is the hash of the fare set a confirm posts.
      if p_mode = 'confirm' then
        raise exception 'invalid_input' using errcode = '22023', hint = 'fares[' || v_i || '].paxType';
      end if;
      v_i := v_i + 1;
      continue;
    end if;
    v_batch_cost := v_batch_cost + v_supplier_pp::numeric * v_count;
    v_batch_customer := v_batch_customer + v_total_pp::numeric * v_count;
    v_fares := v_fares || jsonb_build_array(jsonb_build_object(
      'paxType', v_type, 'basic', v_basic, 'k', v_k, 'yq', v_yq, 'yr', v_yr, 'other', v_other,
      'markup', v_markup, 'discount', v_discount, 'supplierPerPerson', v_supplier_pp, 'totalPerPerson', v_total_pp,
      'paxCount', v_count));
    v_i := v_i + 1;
  end loop;
  if exists (select 1 from unnest(v_types) t where not (t = any (v_fare_types))) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fares';
  end if;
  if v_batch_cost > 999999999999 or v_batch_customer > 999999999999 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fares';
  end if;

  v_before := authz.flight_deal_supplier_cost(p_deal);
  v_budget := authz.flight_deal_budget(p_deal);
  v_over := v_budget is null or v_before + v_batch_cost::bigint > v_budget;

  v_payload := jsonb_build_object(
    'sectorIds', (select jsonb_agg(x::text order by x::text) from unnest(v_sector_ids) x),
    'travellers', (select jsonb_agg(jsonb_build_object('seq', (t ->> 'seq')::integer, 'type', t ->> 'type')
                                    order by (t ->> 'seq')::integer)
                   from jsonb_array_elements(v_travellers) t),
    'supplierId', v_supplier::text,
    'fares', (select jsonb_agg(jsonb_build_object(
                'paxType', f ->> 'paxType',
                'basicPaise', f ->> 'basic', 'kPaise', f ->> 'k', 'yqPaise', f ->> 'yq', 'yrPaise', f ->> 'yr',
                'otherPaise', f ->> 'other', 'markupPaise', f ->> 'markup', 'discountPaise', f ->> 'discount')
              order by f ->> 'paxType')
              from jsonb_array_elements(v_fares) f));

  return jsonb_build_object(
    'payload', v_payload,
    'fareHash', authz.flight_fare_hash(v_payload),
    'dealKind', v_kind,
    'costTaskId', v_cost_task,
    'supplierId', v_supplier,
    'sectorIds', to_jsonb(v_sector_ids),
    'taskIds', to_jsonb(v_task_ids),
    'travellers', v_travellers,
    'fares', v_fares,
    'batchSupplierCost', v_batch_cost::bigint,
    'batchCustomerTotal', case when v_kind = 'flight_only' then v_batch_customer::bigint end,
    'dealCostBefore', v_before,
    'dealCostAfter', v_before + v_batch_cost::bigint,
    'dealBudget', v_budget,
    'overBudget', v_over);
end;
$$;

revoke all on function
  authz.flight_fare_hash(jsonb), authz.flight_paise(jsonb, text, bigint), authz.flight_deal_budget(uuid),
  authz.flight_deal_supplier_cost(uuid), authz.flight_owns_task(uuid), authz.flight_is_deal_assignee(uuid),
  authz.flight_money_gate(uuid), authz.flight_batch_payment(uuid), authz.flight_batch_paid(uuid),
  authz.flight_fare_check(uuid, jsonb, text)
from public, anon, authenticated, service_role;

-- B12: the money part of the done checklist (replaces Track A's stub).
-- Ordered tokens: fare_approval_pending, payment_missing (a batch neither
-- paid nor returned), payment_returned (a batch whose latest direct entry or
-- request was returned).
create or replace function authz.flight_money_issues(p_deal uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select array_remove(array[
    case when exists (select 1 from public.flight_fare_approvals a where a.deal_id = p_deal and a.status = 'pending')
         then 'fare_approval_pending' end,
    case when exists (select 1 from public.flight_ticket_batches b
                      cross join lateral authz.flight_batch_payment(b.id) x
                      where b.deal_id = p_deal and b.supplier_cost_paise > 0 and not x.paid
                        and x.state not in ('direct_returned', 'request_returned'))
         then 'payment_missing' end,
    case when exists (select 1 from public.flight_ticket_batches b
                      cross join lateral authz.flight_batch_payment(b.id) x
                      where b.deal_id = p_deal and b.supplier_cost_paise > 0 and not x.paid
                        and x.state in ('direct_returned', 'request_returned'))
         then 'payment_returned' end
  ]::text[], null)
$$;
revoke all on function authz.flight_money_issues(uuid) from public, anon, authenticated, service_role;

-- ===========================================================================
-- 2. Supplier money replacements (shared helpers)
-- ===========================================================================

-- Replaces 20261130000200: flight direct payments that are not returned
-- count with the live requests (C1).
create or replace function authz.sm_supplier_running_total(p_deal uuid, p_supplier uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select (coalesce((select sum(p.amount_paise) from public.supplier_payment_requests p
                    where p.deal_id = p_deal and p.supplier_id = p_supplier
                      and p.status in ('pending', 'approved', 'paid', 'verified')), 0)
        + coalesce((select sum(c.amount_paise) from public.department_cost_entries c
                    where c.deal_id = p_deal and c.supplier_id = p_supplier and c.department = 'flight'
                      and c.paid_by = 'company' and c.expense_status is distinct from 'returned'), 0))::bigint
$$;

-- Replaces 20261130000200: a flight task's service ends on its last active
-- sector's departure date (else the trip end); other tasks unchanged.
create or replace function authz.sm_trip_end(p_task uuid) returns date
language sql stable security definer set search_path = '' as $$
  select case when t.department = 'flight'
              then coalesce((select max(s.depart_date) from public.flight_sectors s
                             where s.task_id = t.id and s.status = 'active'), v.trip_end)
              else coalesce(authz.sf_date(authz.sm_task_facts(t.id) -> 'checkOut'), v.trip_end) end
  from public.fulfilment_tasks t
  join public.booking_versions v on v.id = authz.task_current_version(t.id)
  where t.id = p_task
$$;

-- Replaces 20261130000200: flight tasks = done, carry a batch, last active
-- sector departed before today and no non-returned invoice on the task.
create or replace function authz.sm_invoice_missing(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select case when t.department = 'flight' then coalesce(
           t.status = 'completed'
           and exists (select 1 from public.flight_ticket_batches b where b.cost_task_id = t.id)
           and (select max(s.depart_date) from public.flight_sectors s
                where s.task_id = t.id and s.status = 'active') < authz.finance_today()
           and not exists (select 1 from public.supplier_documents s
                           where s.task_id = t.id and s.kind = 'invoice' and s.status <> 'returned'), false)
         else coalesce(authz.sm_task_confirmed(t.status)
           and authz.sm_trip_end(t.id) < authz.finance_today()
           and not exists (select 1 from public.supplier_documents s
                           where s.task_id = t.id and s.kind = 'invoice' and s.status <> 'returned'), false) end
  from public.fulfilment_tasks t where t.id = p_task
$$;

-- Replaces 20261130000200: a flight request stays valid while its batch has
-- no direct payment that is not returned and the trip is not cancelled.
create or replace function authz.sm_payment_still_valid(p_payment uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.supplier_payment_requests%rowtype;
  v_status text;
begin
  select * into v from public.supplier_payment_requests p where p.id = p_payment;
  if v.flight_batch_id is not null then
    if authz.deal_trip_cancelled(v.deal_id) then
      raise exception 'trip_cancelled' using errcode = '55000';
    end if;
    if not exists (select 1 from public.flight_ticket_batches b where b.id = v.flight_batch_id)
       or exists (select 1 from public.department_cost_entries c
                  where c.flight_batch_id = v.flight_batch_id and c.expense_status is distinct from 'returned') then
      raise exception 'version_changed' using errcode = '40001';
    end if;
    return;
  end if;
  if authz.deal_trip_cancelled(v.deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  if (authz.purchase_agreed_cost(v.task_id)).version_no is distinct from v.cost_version_no then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  select t.status into v_status from public.fulfilment_tasks t where t.id = v.task_id;
  if not authz.sm_task_confirmed(v_status)
     and authz.purchase_go_ahead_needed(v.task_id) and not authz.purchase_go_ahead_valid(v.task_id) then
    raise exception 'version_changed' using errcode = '40001';
  end if;
end;
$$;

-- Replaces 20261130000200: the requester holds the role of the task's
-- department (Purchase tasks: purchase, exactly as before).
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
  elsif p_actor = 'requester' then
    select coalesce(t.department, 'purchase') into v_department from public.fulfilment_tasks t where t.id = v.task_id;
    if not coalesce(authz.session_ok(), false) or v.requested_by is distinct from (select auth.uid())
       or not authz.holds_active_role(coalesce(v_department, 'purchase'), v.legal_entity_id) then
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

revoke all on function authz.sm_supplier_running_total(uuid, uuid), authz.sm_trip_end(uuid),
  authz.sm_invoice_missing(uuid), authz.sm_payment_still_valid(uuid), authz.sm_payment_for_command(uuid, text)
from public, anon, authenticated;

-- ===========================================================================
-- 3. Flight payment request (B10): the flight branch of sm_payment_create
-- ===========================================================================

-- Fields (camelCase, unknown keys refused): batchId (required on create;
-- on resubmit optional and must equal the returned request's batch),
-- dueDate, note, proformaEvidenceId (optional, lead L17). Amount = the
-- batch's supplier cost; part 'full'; no cost version.
create function authz.sm_payment_create_flight(p_task_id uuid, p_fields jsonb, p_request_id uuid, p_resubmits uuid,
  p_command text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_old public.supplier_payment_requests%rowtype;
  v_batch public.flight_ticket_batches%rowtype;
  v_payload jsonb;
  v_result jsonb;
  v_batch_id uuid;
  v_due date;
  v_note text;
  v_proforma uuid;
  v_amount bigint;
  v_available bigint;
  v_funding bigint;
  v_route text;
  v_funding_route text;
  v_id uuid := gen_random_uuid();
  v_ref text;
begin
  -- 1. Who: the Flight person of the batch's cost task (unlocked read, then locks).
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or not authz.flight_owns_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.finance_lock_deal(v_task.deal_id);
  perform authz.flight_lock_group(v_task.deal_id);
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if not authz.flight_owns_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_money_gate(v_task.deal_id);

  v_payload := jsonb_build_object('taskId', p_task_id, 'resubmitsId', p_resubmits, 'fields', p_fields);
  v_result := authz.sm_replay(v_task.legal_entity_id, p_request_id, p_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;

  -- 2. Input.
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['batchId', 'dueDate', 'note', 'proformaEvidenceId']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  begin
    v_batch_id := authz.finance_uuid(authz.finance_field(p_fields, 'batchId'));
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'batchId';
  end;
  begin
    v_due := authz.finance_date(authz.finance_field(p_fields, 'dueDate'));
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'dueDate';
  end;
  if v_due is not null and v_due not between date '2000-01-01' and date '2100-12-31' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'dueDate';
  end if;
  begin
    v_note := authz.finance_text(authz.finance_field(p_fields, 'note'), 1, 500, true);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'note';
  end;
  begin
    v_proforma := authz.finance_uuid(authz.finance_field(p_fields, 'proformaEvidenceId'));
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'proformaEvidenceId';
  end;

  -- 3. The returned request being sent again.
  if p_resubmits is not null then
    select * into v_old from public.supplier_payment_requests p where p.id = p_resubmits for update;
    if v_old.id is null or v_old.task_id <> v_task.id or v_old.flight_batch_id is null
       or (v_batch_id is not null and v_batch_id <> v_old.flight_batch_id) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'batchId';
    end if;
    if v_old.status <> 'returned'
       or exists (select 1 from public.supplier_payment_requests p where p.resubmits_id = v_old.id) then
      raise exception 'already_decided' using errcode = '55000';
    end if;
    v_batch_id := v_old.flight_batch_id;
  end if;
  if v_batch_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'batchId';
  end if;

  -- 4. Business checks.
  if authz.deal_trip_cancelled(v_task.deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  select * into v_batch from public.flight_ticket_batches b where b.id = v_batch_id;
  if v_batch.id is null or v_batch.cost_task_id <> v_task.id or v_batch.deal_id <> v_task.deal_id then
    raise exception 'invalid_input' using errcode = '22023', hint = 'batchId';
  end if;
  if exists (select 1 from public.supplier_payment_requests p
             where p.flight_batch_id = v_batch.id and p.status in ('pending', 'approved', 'paid', 'verified'))
     or exists (select 1 from public.department_cost_entries c
                where c.flight_batch_id = v_batch.id and c.expense_status is distinct from 'returned') then
    raise exception 'payment_in_progress' using errcode = '55000';
  end if;
  v_amount := v_batch.supplier_cost_paise;
  if v_amount is null or v_amount <= 0 then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if v_proforma is not null and not exists (
       select 1 from public.supplier_money_evidence e
       where e.id = v_proforma and e.task_id = v_task.id and e.kind = 'proforma' and e.status = 'stored') then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  -- Customer money exactly as for Purchase: Flight gets no signal; company
  -- funding for the difference is created here.
  v_available := greatest(authz.sm_customer_money_available(v_task.deal_id, null), 0);
  v_funding := greatest(v_amount - v_available, 0);

  -- 5. Route: every live request and direct payment for this supplier on this Deal, this one included.
  v_route := authz.sm_route(authz.sm_supplier_running_total(v_task.deal_id, v_batch.supplier_id) + v_amount);

  v_ref := authz.sm_next_ref(v_task.legal_entity_id);
  insert into public.supplier_payment_requests (id, legal_entity_id, branch_id, deal_id, task_id, supplier_id, ref_no,
    cost_version_no, go_ahead_request_id, part, amount_paise, customer_money_paise, due_date, note,
    proforma_evidence_id, route, resubmits_id, request_id, requested_by, flight_batch_id)
  values (v_id, v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, v_batch.supplier_id, v_ref,
    null, null, 'full', v_amount, v_amount - v_funding, v_due, v_note,
    v_proforma, v_route, p_resubmits, p_request_id, v_uid, v_batch.id);

  if v_funding > 0 then
    v_funding_route := authz.sm_route(authz.sm_funding_running_total(v_task.deal_id) + v_funding);
    insert into public.company_funding_requests (legal_entity_id, branch_id, deal_id, payment_request_id, amount_paise,
      reason, route, requested_by)
    values (v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_id, v_funding,
      'No note from Flight (flight ticket payment)', v_funding_route, v_uid);
  end if;

  perform authz.write_audit(case when p_resubmits is null then 'flight.payment_requested' else 'flight.payment_resubmitted' end,
    v_task.legal_entity_id, v_task.branch_id, 'fulfilment_task', v_task.id, null,
    jsonb_build_object('dealId', v_task.deal_id, 'paymentRequestId', v_id, 'refNo', v_ref, 'route', v_route,
      'batchId', v_batch.id, 'resubmitsId', p_resubmits));

  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'refNo', v_ref, 'route', v_route,
    'status', 'pending');
  return authz.sm_remember(v_task.legal_entity_id, p_request_id, p_command, v_payload, v_result);
end;
$$;
revoke all on function authz.sm_payment_create_flight(uuid, jsonb, uuid, uuid, text) from public, anon, authenticated, service_role;

-- Replaces 20261130000200: flight tasks take the flight branch above; the
-- rest of the body is the previous Purchase body, unchanged.
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
revoke all on function authz.sm_payment_create(uuid, jsonb, uuid, uuid, text) from public, anon, authenticated;

-- B10 entry point: the batch names its cost task.
create function public.flight_payment_request_create(p_batch_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task uuid;
begin
  select b.cost_task_id into v_task from public.flight_ticket_batches b where b.id = p_batch_id;
  if v_task is null or not authz.flight_owns_task(v_task) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  return authz.sm_payment_create(v_task, p_fields || jsonb_build_object('batchId', p_batch_id::text), p_request_id, null,
    'flight_payment_request_create');
end;
$$;

-- Replaces 20261130000200: flight requests audit with flight names.
create or replace function public.supplier_payment_request_cancel(p_payment_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.supplier_payment_requests%rowtype;
  v_payload jsonb := jsonb_build_object('paymentId', p_payment_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  v := authz.sm_payment_for_command(p_payment_id, 'requester');
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
      null, jsonb_build_object('dealId', v.deal_id, 'paymentRequestId', v.id, 'refNo', v.ref_no, 'batchId', v.flight_batch_id));
  else
    perform authz.write_audit('purchase.payment_cancelled', v.legal_entity_id, v.branch_id, 'fulfilment_task', v.task_id,
      null, jsonb_build_object('paymentRequestId', v.id, 'refNo', v.ref_no));
  end if;
  v_result := jsonb_build_object('outcome', 'created', 'id', v.id, 'status', v.status, 'rowVersion', v.row_version);
  return authz.sm_remember(v.legal_entity_id, p_request_id, 'supplier_payment_request_cancel', v_payload, v_result);
end;
$$;

-- Replaces 20261130000200: a flight request is never decided by the Deal's
-- Flight person. Everything else unchanged.
create or replace function public.supplier_payment_decide(
  p_payment_id uuid, p_decision text, p_reason text, p_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v public.supplier_payment_requests%rowtype;
  v_reason text;
  v_payload jsonb := jsonb_build_object('paymentId', p_payment_id, 'decision', p_decision, 'reason', p_reason,
    'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  v := authz.sm_payment_for_command(p_payment_id, 'decider');
  v_result := authz.sm_replay(v.legal_entity_id, p_request_id, 'supplier_payment_decide', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_decision is null or p_decision not in ('approve', 'return') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- Never the requester, the Deal's owner or its Sales assignee (review F6).
  if v.requested_by = v_uid or authz.finance_deal_conflict(v.deal_id) then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  -- Flight build: never the Deal's Flight person for a flight payment.
  if v.flight_batch_id is not null and authz.flight_is_deal_assignee(v.deal_id) then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  -- Decisions are final, except that an approved request still on hold
  -- (bank details or company funding) may be returned so it stops blocking.
  if not (v.status = 'pending'
          or (p_decision = 'return' and v.status = 'approved' and authz.sm_hold_reason(v.id) is not null)) then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;

  if p_decision = 'approve' then
    perform authz.sm_payment_still_valid(v.id);
    if v.customer_money_paise > authz.sm_customer_money_available(v.deal_id, v.id) then
      raise exception 'customer_money_short' using errcode = '55000';
    end if;
    update public.supplier_payment_requests p
    set status = 'approved', decided_by = v_uid, decided_at = now(), approved_by = v_uid, approved_at = now(),
        row_version = p.row_version + 1, updated_at = now()
    where p.id = v.id returning * into v;
  else
    v_reason := authz.finance_reason(p_reason);
    update public.supplier_payment_requests p
    set status = 'returned', return_reason = v_reason, decided_by = v_uid, decided_at = now(),
        approved_by = null, approved_at = null,
        row_version = p.row_version + 1, updated_at = now()
    where p.id = v.id returning * into v;
  end if;

  perform authz.write_audit(case when p_decision = 'approve' then 'finance.supplier_payment_approved'
                                 else 'finance.supplier_payment_returned' end,
    v.legal_entity_id, v.branch_id, 'fulfilment_task', v.task_id, null,
    jsonb_build_object('paymentRequestId', v.id, 'refNo', v.ref_no, 'route', v.route));
  v_result := jsonb_build_object('outcome', 'created', 'id', v.id, 'status', v.status, 'rowVersion', v.row_version);
  return authz.sm_remember(v.legal_entity_id, p_request_id, 'supplier_payment_decide', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 4. Supplier money files and invoices: the flight branch
-- ===========================================================================

-- Replaces 20261130000200: the Flight person of a flight task may also
-- upload a proforma or a supplier invoice (credit notes stay Purchase).
create or replace function public.supplier_money_evidence_begin(
  p_kind text, p_target_id uuid, p_file_name text, p_mime text, p_size_bytes integer, p_sha256 text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_pay public.supplier_payment_requests%rowtype;
  v_synthetic boolean;
  v_gate text;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_name text := btrim(coalesce(p_file_name, ''));
  v_sha text := lower(coalesce(p_sha256, ''));
  v_payload jsonb := jsonb_build_object('kind', p_kind, 'targetId', p_target_id, 'fileName', p_file_name,
    'mime', p_mime, 'sizeBytes', p_size_bytes, 'sha256', p_sha256);
  v_result jsonb;
begin
  if p_kind = 'payment_proof' then
    select * into v_pay from public.supplier_payment_requests p where p.id = p_target_id;
    if v_pay.id is null then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    select d.is_synthetic into v_synthetic from public.deals d where d.id = v_pay.deal_id;
    perform authz.finance_require_accounts(v_pay.legal_entity_id, v_synthetic);
    select * into v_task from public.fulfilment_tasks t where t.id = v_pay.task_id;
  elsif p_kind in ('proforma', 'invoice')
        and exists (select 1 from public.fulfilment_tasks t where t.id = p_target_id and t.department = 'flight') then
    -- Flight build (20261201000210): the task's Flight person, also after done.
    select * into v_task from public.fulfilment_tasks t where t.id = p_target_id;
    if not authz.flight_owns_task(v_task.id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    v_gate := authz.flight_gate_issue(v_task.deal_id);
    if v_gate is not null then
      raise exception '%', v_gate using errcode = '55000';
    end if;
  elsif p_kind in ('proforma', 'invoice', 'credit_note') then
    select * into v_task from public.fulfilment_tasks t where t.id = p_target_id;
    if v_task.id is null or v_task.department is distinct from 'purchase'
       or not authz.holds_active_role('purchase', v_task.legal_entity_id)
       or (p_kind = 'proforma' and not authz.can_work_purchase_task(v_task.id)) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    v_gate := authz.procurement_gate_issue(v_task.id);
    if v_gate is not null then
      raise exception '%', v_gate using errcode = '55000';
    end if;
  else
    if not coalesce(authz.session_ok(), false) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  v_result := authz.sm_replay(v_task.legal_entity_id, p_request_id, 'supplier_money_evidence_begin', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  if p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes not between 1 and 4194304
     or v_sha !~ '^[0-9a-f]{64}$'
     or length(v_name) not between 1 and 120 or v_name !~ '^[A-Za-z0-9._ -]+$' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  if p_kind = 'payment_proof' and v_pay.status <> 'approved' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if (select count(*) from public.supplier_money_evidence e
      where e.task_id = v_task.id and e.status <> 'removed') >= 40 then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  v_path := v_task.legal_entity_id::text || '/' || v_task.id::text || '/' || v_id::text;
  insert into public.supplier_money_evidence (id, legal_entity_id, task_id, payment_request_id, kind, object_path,
    file_name, mime, size_bytes, sha256, uploaded_by, request_id)
  values (v_id, v_task.legal_entity_id, v_task.id, v_pay.id, p_kind, v_path, v_name, p_mime, p_size_bytes, v_sha,
    (select auth.uid()), p_request_id);

  v_result := jsonb_build_object('outcome', 'created', 'evidenceId', v_id, 'objectPath', v_path);
  perform authz.sm_remember(v_task.legal_entity_id, p_request_id, 'supplier_money_evidence_begin', v_payload, v_result);
  perform authz.write_audit('purchase.money_file_started', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('evidenceId', v_id, 'kind', p_kind, 'mime', p_mime, 'sizeBytes', p_size_bytes));
  return v_result;
end;
$$;

-- Replaces 20261130000200: Flight people of the entity may also open the
-- proformas and invoices of flight tasks. Payment proofs stay Accounts only.
create or replace function public.supplier_money_evidence_authorize_download(p_evidence_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ev public.supplier_money_evidence%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_synthetic boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_ev from public.supplier_money_evidence e where e.id = p_evidence_id;
  if v_ev.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = v_ev.task_id;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = v_task.deal_id;
  if v_ev.kind = 'payment_proof' then
    if not authz.sm_accounts_sees(v_ev.legal_entity_id, v_synthetic) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
  elsif not ((v_task.department = 'purchase' and authz.holds_active_role('purchase', v_task.legal_entity_id))
             -- Flight build (20261201000210).
             or (v_task.department = 'flight' and authz.holds_active_role('flight', v_task.legal_entity_id))
             or authz.is_branch_sales_manager(v_task.deal_id)
             or authz.sm_accounts_sees(v_ev.legal_entity_id, v_synthetic)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ev.status <> 'stored' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.write_audit('purchase.money_file_viewed', v_ev.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_ev.task_id, null, jsonb_build_object('evidenceId', v_ev.id, 'kind', v_ev.kind));
  return jsonb_build_object('objectPath', v_ev.object_path, 'fileName', v_ev.file_name, 'mime', v_ev.mime);
end;
$$;

-- Flight supplier invoice: the task's Flight person (also after done); the
-- supplier is one of the task's batches (supplierId names it when the task's
-- batches have more than one supplier). Invoices only.
create function authz.sm_document_upload_flight(p_task_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_supplier uuid;
  v_kind text;
  v_number text;
  v_date date;
  v_total bigint;
  v_evidence uuid;
  v_id uuid := gen_random_uuid();
  v_payload jsonb := jsonb_build_object('taskId', p_task_id, 'fields', p_fields);
  v_result jsonb;
  v_gate text;
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or not authz.flight_owns_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_gate := authz.flight_gate_issue(v_task.deal_id);
  if v_gate is not null then
    raise exception '%', v_gate using errcode = '55000';
  end if;
  v_result := authz.sm_replay(v_task.legal_entity_id, p_request_id, 'supplier_document_upload', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['kind', 'number', 'docDate', 'totalPaise', 'gstIncluded', 'evidenceId', 'supplierId']) <> '{}'::jsonb
     or jsonb_typeof(p_fields -> 'gstIncluded') is distinct from 'boolean' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_kind := authz.finance_field(p_fields, 'kind');
  v_number := authz.finance_text(authz.finance_field(p_fields, 'number'), 1, 60, false);
  v_date := authz.finance_date(authz.finance_field(p_fields, 'docDate'));
  v_total := authz.finance_paise(p_fields, 'totalPaise', 1);
  v_evidence := authz.finance_uuid(authz.finance_field(p_fields, 'evidenceId'));
  v_supplier := authz.finance_uuid(authz.finance_field(p_fields, 'supplierId'));
  if v_kind is distinct from 'invoice' or v_number is null or v_date is null
     or v_date not between date '2000-01-01' and authz.finance_today() + 1
     or v_total is null or v_total > 999999999999999 or v_evidence is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if not exists (select 1 from public.flight_ticket_batches b where b.cost_task_id = v_task.id) then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if v_supplier is null then
    if (select count(distinct b.supplier_id) from public.flight_ticket_batches b where b.cost_task_id = v_task.id) > 1 then
      raise exception 'invalid_input' using errcode = '22023', hint = 'supplierId';
    end if;
    select b.supplier_id into v_supplier from public.flight_ticket_batches b where b.cost_task_id = v_task.id limit 1;
  elsif not exists (select 1 from public.flight_ticket_batches b where b.cost_task_id = v_task.id and b.supplier_id = v_supplier) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'supplierId';
  end if;
  if not exists (select 1 from public.supplier_money_evidence e
                 where e.id = v_evidence and e.task_id = v_task.id and e.kind = v_kind and e.status = 'stored')
     or exists (select 1 from public.supplier_documents s where s.evidence_id = v_evidence) then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  insert into public.supplier_documents (id, legal_entity_id, branch_id, deal_id, task_id, supplier_id, kind, number,
    doc_date, total_paise, gst_included, evidence_id, uploaded_by, request_id)
  values (v_id, v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, v_supplier, v_kind, v_number,
    v_date, v_total, (p_fields ->> 'gstIncluded')::boolean, v_evidence, (select auth.uid()), p_request_id);
  perform authz.write_audit('purchase.supplier_document_uploaded', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null, jsonb_build_object('documentId', v_id, 'kind', v_kind, 'department', 'flight'));
  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'status', 'uploaded', 'rowVersion', 1);
  return authz.sm_remember(v_task.legal_entity_id, p_request_id, 'supplier_document_upload', v_payload, v_result);
end;
$$;
revoke all on function authz.sm_document_upload_flight(uuid, jsonb, uuid) from public, anon, authenticated, service_role;

-- Replaces 20261130000200: flight tasks take the flight branch above; the
-- rest is the previous Purchase body, unchanged.
create or replace function public.supplier_document_upload(p_task_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_cost public.purchase_cost_versions;
  v_supplier uuid;
  v_gate text;
  v_kind text;
  v_number text;
  v_date date;
  v_total bigint;
  v_evidence uuid;
  v_id uuid := gen_random_uuid();
  v_payload jsonb := jsonb_build_object('taskId', p_task_id, 'fields', p_fields);
  v_result jsonb;
begin
  -- Flight build (20261201000210).
  if exists (select 1 from public.fulfilment_tasks t where t.id = p_task_id and t.department = 'flight') then
    return authz.sm_document_upload_flight(p_task_id, p_fields, p_request_id);
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or v_task.department is distinct from 'purchase'
     or not coalesce(authz.session_ok(), false) or not authz.holds_active_role('purchase', v_task.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_gate := authz.procurement_gate_issue(v_task.id);
  if v_gate is not null then
    raise exception '%', v_gate using errcode = '55000';
  end if;
  v_result := authz.sm_replay(v_task.legal_entity_id, p_request_id, 'supplier_document_upload', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['kind', 'number', 'docDate', 'totalPaise', 'gstIncluded', 'evidenceId']) <> '{}'::jsonb
     or jsonb_typeof(p_fields -> 'gstIncluded') is distinct from 'boolean' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_kind := authz.finance_field(p_fields, 'kind');
  v_number := authz.finance_text(authz.finance_field(p_fields, 'number'), 1, 60, false);
  v_date := authz.finance_date(authz.finance_field(p_fields, 'docDate'));
  v_total := authz.finance_paise(p_fields, 'totalPaise', 1);
  v_evidence := authz.finance_uuid(authz.finance_field(p_fields, 'evidenceId'));
  if v_kind is null or v_kind not in ('invoice', 'credit_note') or v_number is null or v_date is null
     or v_date not between date '2000-01-01' and authz.finance_today() + 1
     or v_total is null or v_total > 999999999999999 or v_evidence is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_cost := authz.purchase_agreed_cost(v_task.id);
  if v_cost.id is null then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  select q.supplier_id into v_supplier from public.purchase_quotes q where q.id = v_cost.quote_id;
  if not exists (select 1 from public.supplier_money_evidence e
                 where e.id = v_evidence and e.task_id = v_task.id and e.kind = v_kind and e.status = 'stored')
     or exists (select 1 from public.supplier_documents s where s.evidence_id = v_evidence) then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  insert into public.supplier_documents (id, legal_entity_id, branch_id, deal_id, task_id, supplier_id, kind, number,
    doc_date, total_paise, gst_included, evidence_id, uploaded_by, request_id)
  values (v_id, v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, v_supplier, v_kind, v_number,
    v_date, v_total, (p_fields ->> 'gstIncluded')::boolean, v_evidence, (select auth.uid()), p_request_id);
  perform authz.write_audit('purchase.supplier_document_uploaded', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null, jsonb_build_object('documentId', v_id, 'kind', v_kind));
  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'status', 'uploaded', 'rowVersion', 1);
  return authz.sm_remember(v_task.legal_entity_id, p_request_id, 'supplier_document_upload', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 5. The old manual flight cost form ends (B13)
-- ===========================================================================

-- Replaces 20261119000500: department 'flight' is refused (hint flightFares;
-- flight costs come from the confirmed fares). Visa unchanged; Purchase
-- refused as before.
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
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  perform authz.refuse_removed_deal(v_task.deal_id);
  if v_task.id is null or not authz.can_work_department_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- B1.1c: Purchase gets the read-only placeholder only (B2/B3 build its costs).
  if v_task.department = 'purchase' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'department';
  end if;
  -- Flight build (20261201000210, owner D3): the per-passenger fare breakup
  -- is the only flight cost record; manual flight entries end here.
  if v_task.department = 'flight' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'flightFares';
  end if;
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
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_bad := authz.b11_unknown_keys(p_fields, array['costKind', 'amountPaise', 'paidBy', 'paymentMode', 'paidOn', 'reference',
    'receiptEvidenceId']);
  v_kind := authz.b11_text(p_fields -> 'costKind');
  if v_kind is null or v_kind not in ('government_fee', 'service_fee', 'fare', 'other')
     or (v_task.department = 'flight' and v_kind not in ('fare', 'other')) then
    v_bad := v_bad || 'costKind'::text;
  end if;
  if jsonb_typeof(p_fields -> 'amountPaise') in ('string', 'number') and (p_fields ->> 'amountPaise') ~ '^[1-9][0-9]{0,14}$' then
    v_amount := (p_fields ->> 'amountPaise')::bigint;
  else
    v_bad := v_bad || 'amountPaise'::text;
  end if;
  v_paid := authz.b11_text(p_fields -> 'paidBy');
  if v_paid is null or v_paid not in ('company', 'customer_direct', 'not_yet') then v_bad := v_bad || 'paidBy'::text; end if;
  v_mode := authz.b11_text(p_fields -> 'paymentMode');
  v_on := authz.sf_date(p_fields -> 'paidOn');
  if v_paid = 'not_yet' then
    if v_mode is not null then v_bad := v_bad || 'paymentMode'::text; end if;
    if p_fields ? 'paidOn' and jsonb_typeof(p_fields -> 'paidOn') <> 'null' then v_bad := v_bad || 'paidOn'::text; end if;
  elsif v_paid is not null then
    if v_mode is null or v_mode not in ('bank_transfer', 'upi', 'card', 'cash', 'other') then v_bad := v_bad || 'paymentMode'::text; end if;
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
           and e.kind in ('fee_receipt', 'direct_payment_proof') and e.status <> 'removed') then
      v_bad := v_bad || 'receiptEvidenceId'::text;
    end if;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  -- DEC-21: a company-paid flight purchase above INR 50,000 goes through B3.
  -- Review V2: the cap is per purchase = every company-paid entry of the task
  -- (draft, submitted, accepted) together, under the task lock held above.
  if v_task.department = 'flight' and v_paid = 'company'
     and v_amount + coalesce((select sum(c.amount_paise) from public.department_cost_entries c
                              where c.task_id = v_task.id and c.paid_by = 'company'
                                and c.id is distinct from v_old.id
                                and c.expense_status in ('draft', 'submitted', 'accepted')), 0) > 5000000 then
    raise exception 'direct_payment_over_limit' using errcode = '22023';
  end if;
  v_status := case when v_paid = 'company' then coalesce(case when v_old.expense_status = 'returned' then 'returned' end, 'draft') end;

  if v_old.id is null then
    insert into public.department_cost_entries (task_id, deal_id, legal_entity_id, branch_id, department, cost_kind,
      amount_paise, paid_by, payment_mode, paid_on, reference, receipt_evidence_id, expense_status, request_id, created_by)
    values (v_task.id, v_task.deal_id, v_task.legal_entity_id, v_task.branch_id, v_task.department, v_kind, v_amount, v_paid,
      case when v_paid <> 'not_yet' then v_mode end, case when v_paid <> 'not_yet' then v_on end, v_ref, v_receipt, v_status,
      p_request_id, (select auth.uid()))
    returning * into v_entry;
  else
    update public.department_cost_entries c
    set cost_kind = v_kind, amount_paise = v_amount, paid_by = v_paid,
        payment_mode = case when v_paid <> 'not_yet' then v_mode end, paid_on = case when v_paid <> 'not_yet' then v_on end,
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

-- Replaces 20261119000500: a ticket batch's direct payment goes back to
-- Accounts only through flight_direct_payment_save (the cumulative cap of
-- C1). Earlier manual flight rows and visa rows: unchanged.
create or replace function public.department_cost_submit(p_entry_id uuid, p_expected_row_version integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_entry public.department_cost_entries%rowtype;
begin
  select * into v_task from public.fulfilment_tasks t
  where t.id = (select c.task_id from public.department_cost_entries c where c.id = p_entry_id) for update;
  select * into v_entry from public.department_cost_entries c where c.id = p_entry_id for update;
  perform authz.refuse_removed_deal(v_task.deal_id);
  if v_entry.id is null or not authz.can_work_department_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Flight build (20261201000210).
  if v_entry.flight_batch_id is not null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'flightFares';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_entry.row_version);
  if v_entry.expense_status is null or v_entry.expense_status not in ('draft', 'returned') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if not authz.expense_receipt_ok(v_entry.id) then
    raise exception 'receipt_required' using errcode = '55000';
  end if;
  -- Review V2: re-check the per-purchase cap (a returned entry may come back).
  if v_task.department = 'flight' and v_entry.amount_paise + coalesce((
       select sum(c.amount_paise) from public.department_cost_entries c
       where c.task_id = v_task.id and c.paid_by = 'company' and c.id <> v_entry.id
         and c.expense_status in ('draft', 'submitted', 'accepted')), 0) > 5000000 then
    raise exception 'direct_payment_over_limit' using errcode = '22023';
  end if;
  update public.department_cost_entries c
  set expense_status = 'submitted', submitted_by = (select auth.uid()), submitted_at = now(),
      reviewed_by = null, reviewed_at = null, return_reason = null, row_version = c.row_version + 1, updated_at = now()
  where c.id = v_entry.id
  returning * into v_entry;
  perform authz.write_audit('department.cost_submitted', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('taskId', v_task.id, 'department', v_task.department, 'costKind', v_entry.cost_kind,
      'rowVersion', v_entry.row_version));
  return jsonb_build_object('entryId', v_entry.id, 'rowVersion', v_entry.row_version, 'expenseStatus', v_entry.expense_status);
end;
$$;

-- ===========================================================================
-- 6. Flight suppliers (B2, B3)
-- ===========================================================================

-- The one entity where the caller holds an active Flight role.
create function authz.flight_caller_entity() returns uuid
language sql stable security definer set search_path = '' as $$
  select case when count(distinct m.legal_entity_id) = 1 then min(m.legal_entity_id::text)::uuid end
  from public.memberships m
  where m.user_id = (select auth.uid()) and m.status = 'active' and m.role_code = 'flight'
    and authz.holds_active_role('flight', m.legal_entity_id)
$$;
revoke all on function authz.flight_caller_entity() from public, anon, authenticated, service_role;

-- Fields: name (1..200, unique per entity ignoring case), city, contactName,
-- contactPhone, contactEmail. service_types = {flight}.
create function public.flight_supplier_create(p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entity uuid;
  v_id uuid;
  v_name text;
  v_payload jsonb := jsonb_build_object('fields', p_fields);
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_entity := authz.flight_caller_entity();
  if v_entity is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  v_result := authz.flight_replay(v_entity, p_request_id, 'flight_supplier_create', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['name', 'city', 'contactName', 'contactPhone', 'contactEmail']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  begin
    v_name := authz.booking_fact_text(p_fields, 'name', 200, false);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'name';
  end;
  if v_name is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'name';
  end if;
  if exists (select 1 from public.suppliers s where s.legal_entity_id = v_entity and lower(s.name) = lower(v_name)) then
    raise exception 'duplicate_supplier' using errcode = '23505';
  end if;
  begin
    insert into public.suppliers (legal_entity_id, name, service_types, city, contact_name, contact_phone,
      contact_email, payment_terms, created_by, updated_by)
    values (v_entity, v_name, array['flight'],
      authz.booking_fact_text(p_fields, 'city', 120, false),
      authz.booking_fact_text(p_fields, 'contactName', 120, false),
      authz.booking_fact_text(p_fields, 'contactPhone', 40, false),
      authz.booking_fact_text(p_fields, 'contactEmail', 254, false),
      null, (select auth.uid()), (select auth.uid()))
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'duplicate_supplier' using errcode = '23505';
    when check_violation or sqlstate '22023' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end;
  perform authz.write_audit('flight.supplier_created', v_entity, null, 'supplier', v_id, null,
    jsonb_build_object('serviceTypes', jsonb_build_array('flight')));
  v_result := jsonb_build_object('outcome', 'created', 'supplierId', v_id, 'rowVersion', 1);
  return authz.flight_remember(v_entity, p_request_id, 'flight_supplier_create', v_payload, v_result);
end;
$$;

-- supplier_add_beneficiary rules for flight-only suppliers, by Flight (L15).
-- Approval stays supplier_approve_beneficiary (never the recorder).
create function public.flight_supplier_add_beneficiary(p_supplier_id uuid, p_request_id uuid, p_fields jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_s public.suppliers%rowtype;
  v_existing public.supplier_beneficiary_revisions%rowtype;
  v_no integer;
  v_id uuid;
  v_ifsc text;
  v_account text;
begin
  select * into v_s from public.suppliers s where s.id = p_supplier_id for update;
  if v_s.id is null or not coalesce(authz.session_ok(), false)
     or not authz.holds_active_role('flight', v_s.legal_entity_id) or v_s.service_types <> array['flight'] then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into v_existing from public.supplier_beneficiary_revisions r
  where r.supplier_id = v_s.id and r.request_id = p_request_id;
  if v_existing.id is not null then
    return jsonb_build_object('revisionId', v_existing.id, 'revisionNo', v_existing.revision_no, 'created', false);
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['accountHolder', 'bankName', 'ifsc', 'accountNumber']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_ifsc := upper(authz.booking_fact_text(p_fields, 'ifsc', 11, false));
  v_account := authz.booking_fact_text(p_fields, 'accountNumber', 18, false);
  select coalesce(max(r.revision_no), 0) + 1 into v_no
  from public.supplier_beneficiary_revisions r where r.supplier_id = v_s.id;

  begin
    insert into public.supplier_beneficiary_revisions (supplier_id, legal_entity_id, revision_no, request_id,
      account_holder, bank_name, ifsc, account_number, created_by)
    values (v_s.id, v_s.legal_entity_id, v_no, p_request_id,
      authz.booking_fact_text(p_fields, 'accountHolder', 120, false),
      authz.booking_fact_text(p_fields, 'bankName', 120, false),
      v_ifsc, v_account, (select auth.uid()))
    returning id into v_id;
  exception when check_violation or not_null_violation then
    raise exception 'invalid_input' using errcode = '22023';
  end;

  -- No bank values in the audit trail.
  perform authz.write_audit('supplier.beneficiary_recorded', v_s.legal_entity_id, null, 'supplier', v_s.id, null,
    jsonb_build_object('revisionNo', v_no, 'status', 'unverified'));
  return jsonb_build_object('revisionId', v_id, 'revisionNo', v_no, 'created', true);
end;
$$;

-- ===========================================================================
-- 7. Fare approvals (B5-B7)
-- ===========================================================================

create function public.flight_fare_approval_request(p_deal_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_deal public.deals%rowtype;
  v_check jsonb;
  v_old public.flight_fare_approvals%rowtype;
  v_no integer;
  v_id uuid := gen_random_uuid();
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id, 'fields', p_fields);
  v_result jsonb;
  v_cost_task public.fulfilment_tasks%rowtype;
begin
  if p_deal_id is null or not coalesce(authz.flight_can_work(p_deal_id), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_deal := authz.finance_lock_deal(p_deal_id);
  perform authz.flight_lock_group(p_deal_id);
  if not coalesce(authz.flight_can_work(p_deal_id), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_money_gate(p_deal_id);
  v_result := authz.flight_replay(v_deal.legal_entity_id, p_request_id, 'flight_fare_approval_request', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if authz.deal_trip_cancelled(p_deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  v_check := authz.flight_fare_check(p_deal_id, p_fields, 'approval');
  if not (v_check ->> 'overBudget')::boolean then
    raise exception 'not_over_budget' using errcode = '55000';
  end if;
  select * into v_cost_task from public.fulfilment_tasks t where t.id = (v_check ->> 'costTaskId')::uuid;

  -- A new request replaces the Deal's pending one (named in this request's audit).
  update public.flight_fare_approvals a
  set status = 'withdrawn', row_version = a.row_version + 1, updated_at = now()
  where a.deal_id = p_deal_id and a.status = 'pending'
  returning * into v_old;

  select coalesce(max(a.approval_no), 0) + 1 into v_no from public.flight_fare_approvals a where a.deal_id = p_deal_id;
  insert into public.flight_fare_approvals (id, legal_entity_id, branch_id, deal_id, approval_no, fare_hash, payload,
    projected_supplier_cost_paise, batch_supplier_cost_paise, budget_paise, requested_by, request_id)
  values (v_id, v_deal.legal_entity_id, v_deal.branch_id, p_deal_id, v_no, v_check ->> 'fareHash', v_check -> 'payload',
    (v_check ->> 'dealCostAfter')::bigint, (v_check ->> 'batchSupplierCost')::bigint,
    (v_check ->> 'dealBudget')::bigint, v_uid, p_request_id);

  perform authz.write_audit('flight.fare_approval_requested', v_deal.legal_entity_id, v_deal.branch_id,
    'fulfilment_task', v_cost_task.id, null,
    jsonb_build_object('dealId', p_deal_id, 'approvalId', v_id, 'replacesApprovalId', v_old.id));
  v_result := jsonb_build_object('outcome', 'created', 'approvalId', v_id, 'approvalNo', v_no, 'status', 'pending',
    'rowVersion', 1, 'fareHash', v_check ->> 'fareHash');
  return authz.flight_remember(v_deal.legal_entity_id, p_request_id, 'flight_fare_approval_request', v_payload, v_result);
end;
$$;

-- approve | return by the manager of the Deal's branch; never the requester
-- or the Deal's Flight person.
create function public.flight_fare_approval_decide(
  p_approval_id uuid, p_decision text, p_reason text, p_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v public.flight_fare_approvals%rowtype;
  v_reason text;
  v_task uuid;
  v_payload jsonb := jsonb_build_object('approvalId', p_approval_id, 'decision', p_decision, 'reason', p_reason,
    'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  select * into v from public.flight_fare_approvals a where a.id = p_approval_id;
  if v.id is null then
    if coalesce(authz.session_ok(), false) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- A manager who also holds Purchase never decides (or sees) flight money.
  if not coalesce(authz.session_ok(), false) or not authz.is_branch_sales_manager(v.deal_id)
     or authz.holds_role('purchase', v.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.finance_lock_deal(v.deal_id);
  perform authz.flight_lock_group(v.deal_id);
  select * into v from public.flight_fare_approvals a where a.id = p_approval_id for update;
  perform authz.flight_money_gate(v.deal_id);
  v_result := authz.flight_replay(v.legal_entity_id, p_request_id, 'flight_fare_approval_decide', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_decision is null or p_decision not in ('approve', 'return') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'decision';
  end if;
  if v.requested_by = v_uid or authz.flight_is_deal_assignee(v.deal_id) then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if v.status <> 'pending' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if p_decision = 'approve' then
    update public.flight_fare_approvals a
    set status = 'approved', decided_by = v_uid, decided_at = now(), row_version = a.row_version + 1, updated_at = now()
    where a.id = v.id returning * into v;
  else
    begin
      v_reason := authz.finance_reason(p_reason);
    exception when sqlstate '22023' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
    end;
    update public.flight_fare_approvals a
    set status = 'returned', return_reason = v_reason, decided_by = v_uid, decided_at = now(),
        row_version = a.row_version + 1, updated_at = now()
    where a.id = v.id returning * into v;
  end if;
  select coalesce(
    (select s.task_id from public.flight_sectors s
     where s.id::text in (select jsonb_array_elements_text(v.payload -> 'sectorIds'))
     order by s.depart_date, s.depart_time nulls last, s.id limit 1),
    (select t.id from public.fulfilment_tasks t where t.deal_id = v.deal_id and t.department = 'flight' order by t.id limit 1))
  into v_task;
  perform authz.write_audit(case when p_decision = 'approve' then 'flight.fare_approval_approved' else 'flight.fare_approval_returned' end,
    v.legal_entity_id, v.branch_id, 'fulfilment_task', v_task, v_reason,
    jsonb_build_object('dealId', v.deal_id, 'approvalId', v.id));
  v_result := jsonb_build_object('outcome', 'updated', 'approvalId', v.id, 'status', v.status, 'rowVersion', v.row_version);
  return authz.flight_remember(v.legal_entity_id, p_request_id, 'flight_fare_approval_decide', v_payload, v_result);
end;
$$;

create function public.flight_fare_approval_withdraw(p_approval_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.flight_fare_approvals%rowtype;
  v_task uuid;
  v_payload jsonb := jsonb_build_object('approvalId', p_approval_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  select * into v from public.flight_fare_approvals a where a.id = p_approval_id;
  if v.id is null then
    if coalesce(authz.session_ok(), false) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not coalesce(authz.session_ok(), false) or v.requested_by is distinct from (select auth.uid())
     or not authz.holds_active_role('flight', v.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.finance_lock_deal(v.deal_id);
  perform authz.flight_lock_group(v.deal_id);
  select * into v from public.flight_fare_approvals a where a.id = p_approval_id for update;
  v_result := authz.flight_replay(v.legal_entity_id, p_request_id, 'flight_fare_approval_withdraw', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v.status <> 'pending' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  update public.flight_fare_approvals a
  set status = 'withdrawn', row_version = a.row_version + 1, updated_at = now()
  where a.id = v.id returning * into v;
  select coalesce(
    (select s.task_id from public.flight_sectors s
     where s.id::text in (select jsonb_array_elements_text(v.payload -> 'sectorIds'))
     order by s.depart_date, s.depart_time nulls last, s.id limit 1),
    (select t.id from public.fulfilment_tasks t where t.deal_id = v.deal_id and t.department = 'flight' order by t.id limit 1))
  into v_task;
  perform authz.write_audit('flight.fare_approval_withdrawn', v.legal_entity_id, v.branch_id, 'fulfilment_task', v_task,
    null, jsonb_build_object('dealId', v.deal_id, 'approvalId', v.id));
  v_result := jsonb_build_object('outcome', 'updated', 'approvalId', v.id, 'status', v.status, 'rowVersion', v.row_version);
  return authz.flight_remember(v.legal_entity_id, p_request_id, 'flight_fare_approval_withdraw', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 8. Confirm tickets (B8): tickets and fares in one transaction
-- ===========================================================================

create function public.flight_tickets_confirm(p_deal_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_deal public.deals%rowtype;
  v_check jsonb;
  v_approval public.flight_fare_approvals%rowtype;
  v_approval_id uuid;
  v_raw jsonb;
  v_batch_id uuid := gen_random_uuid();
  v_batch_no integer;
  v_tr jsonb;
  v_line jsonb;
  v_issue text;
  v_sector uuid;
  v_i integer := 0;
  v_tickets integer := 0;
  v_digits text;
  v_seen jsonb := '{}'::jsonb;
  v_still integer;
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id, 'fields', p_fields);
  v_result jsonb;
begin
  if p_deal_id is null or not coalesce(authz.flight_can_work(p_deal_id), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_deal := authz.finance_lock_deal(p_deal_id);
  perform authz.flight_lock_group(p_deal_id);
  if not coalesce(authz.flight_can_work(p_deal_id), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_money_gate(p_deal_id);
  v_result := authz.flight_replay(v_deal.legal_entity_id, p_request_id, 'flight_tickets_confirm', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if authz.deal_trip_cancelled(p_deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  v_check := authz.flight_fare_check(p_deal_id, p_fields, 'confirm');

  -- Ticket identifiers per traveller line (Track A's validator).
  for v_tr in select x from jsonb_array_elements(v_check -> 'travellers') x loop
    v_line := v_tr -> 'line';
    v_issue := authz.flight_ticket_fields_issue(v_line);
    if v_issue is not null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'travellers[' || v_i || '].' || v_issue;
    end if;
    v_digits := replace(authz.flight_ticket_fields_normalize(v_line) ->> 'ticketNumber', '-', '');
    -- One number per traveller in a batch (the same traveller's connecting coupons share it).
    if v_seen ? v_digits then
      raise exception 'ticket_number_taken' using errcode = '23505', hint = 'travellers[' || v_i || '].ticketNumber';
    end if;
    v_seen := v_seen || jsonb_build_object(v_digits, (v_tr ->> 'seq')::integer);
    v_i := v_i + 1;
  end loop;

  -- Budget (L5: Deal level). Over (or no budget) needs the Manager's approval
  -- of exactly these fares on exactly the current other batches.
  v_raw := p_fields -> 'fareApprovalId';
  if v_raw is not null and jsonb_typeof(v_raw) <> 'null' then
    if jsonb_typeof(v_raw) <> 'string'
       or (v_raw #>> '{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'fareApprovalId';
    end if;
    select * into v_approval from public.flight_fare_approvals a
    where a.id = (v_raw #>> '{}')::uuid and a.deal_id = p_deal_id for update;
  end if;
  if (v_check ->> 'overBudget')::boolean then
    if v_raw is null or jsonb_typeof(v_raw) = 'null' then
      raise exception 'over_budget' using errcode = '55000';
    end if;
    if v_approval.id is null or v_approval.status <> 'approved' or v_approval.fare_hash <> (v_check ->> 'fareHash')
       or v_approval.projected_supplier_cost_paise - v_approval.batch_supplier_cost_paise <> (v_check ->> 'dealCostBefore')::bigint then
      raise exception 'fare_approval_mismatch' using errcode = '55000';
    end if;
    v_approval_id := v_approval.id;
  elsif v_approval.id is not null and v_approval.status = 'approved' and v_approval.fare_hash = (v_check ->> 'fareHash')
        and v_approval.projected_supplier_cost_paise - v_approval.batch_supplier_cost_paise = (v_check ->> 'dealCostBefore')::bigint then
    v_approval_id := v_approval.id;
  end if;

  select coalesce(max(b.batch_no), 0) + 1 into v_batch_no from public.flight_ticket_batches b where b.deal_id = p_deal_id;
  insert into public.flight_ticket_batches (id, legal_entity_id, branch_id, deal_id, batch_no, cost_task_id, supplier_id,
    deal_kind, sector_ids, fare_approval_id, supplier_cost_paise, customer_total_paise, budget_paise, over_budget,
    confirmed_by, request_id)
  values (v_batch_id, v_deal.legal_entity_id, v_deal.branch_id, p_deal_id, v_batch_no, (v_check ->> 'costTaskId')::uuid,
    (v_check ->> 'supplierId')::uuid, v_check ->> 'dealKind',
    array(select jsonb_array_elements_text(v_check -> 'sectorIds')::uuid), v_approval_id,
    (v_check ->> 'batchSupplierCost')::bigint, (v_check ->> 'batchCustomerTotal')::bigint,
    (v_check ->> 'dealBudget')::bigint, (v_check ->> 'overBudget')::boolean, v_uid, p_request_id);
  insert into public.flight_batch_fares (batch_id, legal_entity_id, pax_type, basic_paise, k_paise, yq_paise, yr_paise,
    other_paise, markup_paise, discount_paise, pax_count)
  select v_batch_id, v_deal.legal_entity_id, f ->> 'paxType', (f ->> 'basic')::bigint, (f ->> 'k')::bigint,
    (f ->> 'yq')::bigint, (f ->> 'yr')::bigint, (f ->> 'other')::bigint, (f ->> 'markup')::bigint,
    (f ->> 'discount')::bigint, (f ->> 'paxCount')::integer
  from jsonb_array_elements(v_check -> 'fares') f;
  if v_approval_id is not null then
    update public.flight_fare_approvals a
    set status = 'used', used_by_batch_id = v_batch_id, row_version = a.row_version + 1, updated_at = now()
    where a.id = v_approval_id;
  end if;

  -- One revision 1 per traveller x covered sector; Track A's helper takes the
  -- name/type snapshot and registers the number to (Deal, traveller).
  for v_tr in select x from jsonb_array_elements(v_check -> 'travellers') x loop
    for v_sector in select jsonb_array_elements_text(v_tr -> 'sectorIds')::uuid loop
      perform authz.flight_insert_ticket_revision(v_sector, (v_tr ->> 'seq')::integer, v_batch_id, v_tr -> 'line',
        null, p_request_id);
      v_tickets := v_tickets + 1;
    end loop;
  end loop;

  select coalesce(sum(greatest(c.required - c.confirmed, 0)), 0)::integer into v_still
  from public.fulfilment_tasks t
  cross join lateral authz.flight_ticket_counts(t.id) c
  where t.deal_id = p_deal_id and t.department = 'flight' and t.status <> 'completed';

  -- No fares, PNRs or numbers in the audit trail.
  perform authz.write_audit('flight.tickets_confirmed', v_deal.legal_entity_id, v_deal.branch_id, 'fulfilment_task',
    (v_check ->> 'costTaskId')::uuid, null,
    jsonb_build_object('dealId', p_deal_id, 'batchId', v_batch_id, 'batchNo', v_batch_no, 'sectorIds', v_check -> 'sectorIds',
      'travellerSeqs', (select jsonb_agg((t ->> 'seq')::integer order by (t ->> 'seq')::integer)
                        from jsonb_array_elements(v_check -> 'travellers') t),
      'ticketCount', v_tickets, 'fareApprovalId', v_approval_id));
  v_result := jsonb_build_object('outcome', 'created', 'batchId', v_batch_id, 'batchNo', v_batch_no,
    'ticketCount', v_tickets, 'travellersConfirmed', jsonb_array_length(v_check -> 'travellers'), 'stillPending', v_still);
  return authz.flight_remember(v_deal.legal_entity_id, p_request_id, 'flight_tickets_confirm', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 9. Direct payment (B9): "Record direct payment"
-- ===========================================================================

-- Fields: paymentMode (bank_transfer|upi|card|cash|other), paidOn (<= today),
-- reference (optional, 1..120), proofEvidenceId (a stored direct_payment_proof
-- of the batch's cost task). Creates the batch's fare entry and submits it to
-- Accounts in one step; a returned entry is corrected and resubmitted
-- (p_expected_row_version required then).
create function public.flight_direct_payment_save(p_batch_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_batch public.flight_ticket_batches%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_old public.department_cost_entries%rowtype;
  v_entry public.department_cost_entries%rowtype;
  v_mode text;
  v_on date;
  v_ref text;
  v_proof uuid;
  v_payload jsonb := jsonb_build_object('batchId', p_batch_id, 'expectedRowVersion', p_expected_row_version,
    'fields', p_fields);
  v_result jsonb;
  v_outcome text;
begin
  select * into v_batch from public.flight_ticket_batches b where b.id = p_batch_id;
  if v_batch.id is null or not authz.flight_owns_task(v_batch.cost_task_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.finance_lock_deal(v_batch.deal_id);
  perform authz.flight_lock_group(v_batch.deal_id);
  select * into v_task from public.fulfilment_tasks t where t.id = v_batch.cost_task_id;
  if not authz.flight_owns_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_money_gate(v_batch.deal_id);
  v_result := authz.flight_replay(v_batch.legal_entity_id, p_request_id, 'flight_direct_payment_save', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['paymentMode', 'paidOn', 'reference', 'proofEvidenceId']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  begin
    v_mode := authz.finance_field(p_fields, 'paymentMode');
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'paymentMode';
  end;
  if v_mode is null or v_mode not in ('bank_transfer', 'upi', 'card', 'cash', 'other') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'paymentMode';
  end if;
  begin
    v_on := authz.finance_date(authz.finance_field(p_fields, 'paidOn'));
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'paidOn';
  end;
  if v_on is null or v_on < date '2000-01-01' or v_on > authz.finance_today() then
    raise exception 'invalid_input' using errcode = '22023', hint = 'paidOn';
  end if;
  begin
    v_ref := authz.finance_text(authz.finance_field(p_fields, 'reference'), 1, 120, false);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reference';
  end;
  begin
    v_proof := authz.finance_uuid(authz.finance_field(p_fields, 'proofEvidenceId'));
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'proofEvidenceId';
  end;

  if authz.deal_trip_cancelled(v_batch.deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  if exists (select 1 from public.supplier_payment_requests p
             where p.flight_batch_id = v_batch.id and p.status in ('pending', 'approved', 'paid', 'verified')) then
    raise exception 'payment_in_progress' using errcode = '55000';
  end if;
  select * into v_old from public.department_cost_entries c where c.flight_batch_id = v_batch.id for update;
  if v_old.id is not null then
    if v_old.expense_status in ('submitted', 'accepted') then
      raise exception 'cost_locked' using errcode = '55000';
    end if;
    if p_expected_row_version is distinct from v_old.row_version then
      raise exception 'version_changed' using errcode = '40001';
    end if;
  end if;
  if v_batch.supplier_cost_paise <= 0 then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if v_proof is null or not exists (
       select 1 from public.department_evidence e
       where e.id = v_proof and e.task_id = v_task.id and e.kind = 'direct_payment_proof' and e.status = 'stored') then
    raise exception 'receipt_required' using errcode = '55000';
  end if;
  -- C1: cumulative per (Deal, supplier), this payment included; exactly INR 50,000 is direct.
  if authz.sm_supplier_running_total(v_batch.deal_id, v_batch.supplier_id) + v_batch.supplier_cost_paise > 5000000 then
    raise exception 'direct_payment_over_limit' using errcode = '22023';
  end if;

  if v_old.id is null then
    insert into public.department_cost_entries (task_id, deal_id, legal_entity_id, branch_id, department, cost_kind,
      amount_paise, paid_by, payment_mode, paid_on, reference, receipt_evidence_id, expense_status, submitted_by,
      submitted_at, request_id, created_by, supplier_id, flight_batch_id)
    values (v_task.id, v_batch.deal_id, v_batch.legal_entity_id, v_batch.branch_id, 'flight', 'fare',
      v_batch.supplier_cost_paise, 'company', v_mode, v_on, v_ref, v_proof, 'submitted', v_uid,
      now(), p_request_id, v_uid, v_batch.supplier_id, v_batch.id)
    returning * into v_entry;
    v_outcome := 'created';
  else
    update public.department_cost_entries c
    set amount_paise = v_batch.supplier_cost_paise, payment_mode = v_mode, paid_on = v_on, reference = v_ref,
        receipt_evidence_id = v_proof, expense_status = 'submitted', submitted_by = v_uid, submitted_at = now(),
        reviewed_by = null, reviewed_at = null, return_reason = null,
        row_version = c.row_version + 1, updated_at = now()
    where c.id = v_old.id
    returning * into v_entry;
    v_outcome := 'updated';
  end if;

  -- The existing cost audits (History, Accounts) plus the flight one; no amounts.
  perform authz.write_audit('department.cost_saved', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('taskId', v_task.id, 'department', 'flight', 'costKind', 'fare',
      'paidBy', 'company', 'rowVersion', v_entry.row_version));
  perform authz.write_audit('department.cost_submitted', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('taskId', v_task.id, 'department', 'flight', 'costKind', 'fare',
      'rowVersion', v_entry.row_version));
  perform authz.write_audit('flight.direct_payment_recorded', v_task.legal_entity_id, v_task.branch_id, 'fulfilment_task',
    v_task.id, null, jsonb_build_object('dealId', v_batch.deal_id, 'batchId', v_batch.id, 'entryId', v_entry.id));
  v_result := jsonb_build_object('outcome', v_outcome, 'batchId', v_batch.id, 'entryId', v_entry.id,
    'rowVersion', v_entry.row_version, 'expenseStatus', v_entry.expense_status);
  return authz.flight_remember(v_batch.legal_entity_id, p_request_id, 'flight_direct_payment_save', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 10. Grants (new commands only; replaced functions keep their privileges)
-- ===========================================================================

revoke all on function
  public.flight_supplier_create(jsonb, uuid),
  public.flight_supplier_add_beneficiary(uuid, uuid, jsonb),
  public.flight_fare_approval_request(uuid, jsonb, uuid),
  public.flight_fare_approval_decide(uuid, text, text, integer, uuid),
  public.flight_fare_approval_withdraw(uuid, integer, uuid),
  public.flight_tickets_confirm(uuid, jsonb, uuid),
  public.flight_direct_payment_save(uuid, integer, jsonb, uuid),
  public.flight_payment_request_create(uuid, jsonb, uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.flight_supplier_create(jsonb, uuid),
  public.flight_supplier_add_beneficiary(uuid, uuid, jsonb),
  public.flight_fare_approval_request(uuid, jsonb, uuid),
  public.flight_fare_approval_decide(uuid, text, text, integer, uuid),
  public.flight_fare_approval_withdraw(uuid, integer, uuid),
  public.flight_tickets_confirm(uuid, jsonb, uuid),
  public.flight_direct_payment_save(uuid, integer, jsonb, uuid),
  public.flight_payment_request_create(uuid, jsonb, uuid)
to authenticated;

commit;
