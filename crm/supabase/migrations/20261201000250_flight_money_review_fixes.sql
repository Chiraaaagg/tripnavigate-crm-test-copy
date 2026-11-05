-- Flight build, Track B (6): independent backend review fixes.
-- Contract: flight build contract (frozen 4 Nov 2026) sections 6.2, 9.3,
-- lead L18; lead decisions of 5 Nov 2026 on the review.
--
-- 1. Money fence (lead): a person who holds Flight AND Purchase in the
--    entity sees supplier-side fares (basic, K, YQ, YR, other, supplier
--    cost, budget) but never selling-side values (markup, discount, total
--    per person, customer amounts and totals): those keys are left out of
--    flight_money and flight_fare_approval_sets and the customer total of
--    flight_fare_preview is null for them. (Managers and Accounts holding
--    Purchase stay refused, as before.)
-- 2. Old-form flight costs (L18): live flight tasks may hold company-paid
--    department_cost_entries made with the old manual form (no supplier, no
--    batch). Design:
--      * When tickets are confirmed, every such entry on the tasks of the
--        ticked sectors that is not linked yet is linked to the new batch
--        (new append-only table flight_batch_legacy_costs; the entry itself
--        is not changed).
--      * Linked entries that Accounts has (submitted or accepted) cover the
--        batch: still to pay = supplier cost - that sum (never below 0).
--        A direct payment or payment request of the batch is for the amount
--        still to pay only; when nothing is left, the batch counts as paid
--        directly (state direct_submitted / direct_accepted) and the done
--        checklist accepts it.
--      * Linked entries that are not returned count in the C1 running total
--        of (Deal, batch supplier), drafts included.
--      * A linked draft or returned entry goes back to Accounts
--        (department_cost_submit) only while the batch has no other live
--        payment: refused payment_in_progress, so nothing is paid twice.
--      * Purchase is unaffected (Purchase entries never link; Purchase
--        suppliers have no flight batches).
--    Limitation: a linked amount above the batch cost is not carried to a
--    later batch (flight_money shows legacyPaidPaise beside the cost).
-- 6. Fare approval: valid for a confirm only while the Deal's flight budget
--    is the one it was approved against (approval.budget_paise).
--
-- Replaced (same signatures): authz.flight_batch_payment,
-- authz.flight_batch_paid, authz.sm_supplier_running_total,
-- authz.sm_payment_create_flight, public.department_cost_submit,
-- public.flight_tickets_confirm, public.flight_direct_payment_save,
-- public.flight_fare_preview, public.flight_money,
-- public.flight_payment_context, public.flight_fare_approval_sets.
-- New: table flight_batch_legacy_costs; authz.flight_batch_legacy_paid,
-- authz.flight_batch_due. Read shapes: flight_money batches gain
-- legacyPaidPaise and duePaise (same fence as supplierCostPaise);
-- flight_payment_context amountPaise = still to pay, plus supplierCostPaise
-- and legacyPaidPaise.
--
-- Rollback (forward-only): a NEW migration restoring the bodies from
-- 20261201000210 / 0220 / 0230. Link rows are never deleted.

begin;
set local lock_timeout = '15s';

create table public.flight_batch_legacy_costs (
  entry_id uuid primary key references public.department_cost_entries (id),
  batch_id uuid not null,
  legal_entity_id uuid not null,
  deal_id uuid not null,
  linked_by uuid not null references public.staff_profiles (user_id),
  linked_at timestamptz not null default now(),
  foreign key (legal_entity_id, batch_id) references public.flight_ticket_batches (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id)
);
create index flight_batch_legacy_costs_batch_idx on public.flight_batch_legacy_costs (batch_id);
create index flight_batch_legacy_costs_batch_fk_idx on public.flight_batch_legacy_costs (legal_entity_id, batch_id);
create index flight_batch_legacy_costs_deal_idx on public.flight_batch_legacy_costs (deal_id);
create index flight_batch_legacy_costs_deal_fk_idx on public.flight_batch_legacy_costs (legal_entity_id, deal_id);
create index flight_batch_legacy_costs_linked_by_idx on public.flight_batch_legacy_costs (linked_by);
comment on table public.flight_batch_legacy_costs is
  'Old-form company-paid flight cost entries (before the fare breakup) linked to the first ticket batch of their task, so the same tickets are never paid twice (lead L18). Append-only. No table grant.';
create trigger flight_batch_legacy_costs_a_append_only before update or delete on public.flight_batch_legacy_costs
  for each row execute function authz.flight_money_append_only();
alter table public.flight_batch_legacy_costs enable row level security;
create policy require_valid_session on public.flight_batch_legacy_costs as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.flight_batch_legacy_costs from public, anon, authenticated, service_role;

-- Old-form payments with Accounts (submitted or accepted) linked to the batch.
create function authz.flight_batch_legacy_paid(p_batch uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(c.amount_paise), 0)::bigint
  from public.flight_batch_legacy_costs l
  join public.department_cost_entries c on c.id = l.entry_id
  where l.batch_id = p_batch and c.expense_status in ('submitted', 'accepted')
$$;

-- What is still to pay on a batch.
create function authz.flight_batch_due(p_batch uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select greatest(b.supplier_cost_paise - authz.flight_batch_legacy_paid(b.id), 0)::bigint
  from public.flight_ticket_batches b where b.id = p_batch
$$;

-- Replaces 20261201000210: a batch whose cost old-form payments cover counts
-- as paid directly.
create or replace function authz.flight_batch_payment(p_batch uuid)
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
  ), legacy as (
    select case when bool_and(c.expense_status = 'accepted') then 'direct_accepted' else 'direct_submitted' end as state,
           max(l.linked_at) as at
    from public.flight_batch_legacy_costs l
    join public.department_cost_entries c on c.id = l.entry_id
    where l.batch_id = p_batch and c.expense_status in ('submitted', 'accepted')
    having authz.flight_batch_due(p_batch) = 0 and count(*) > 0
  ), pick as (
    select 'request' as src, l.id, 'request_' || l.status as state, 1 as rank, l.requested_at as at from live l
    union all
    select 'entry', e.id, 'direct_' || e.expense_status, 2, e.updated_at from e where e.expense_status in ('submitted', 'accepted')
    union all
    select 'legacy', null::uuid, g.state, 2, g.at from legacy g
    union all
    select 'entry', e.id, 'direct_returned', 3, coalesce(e.reviewed_at, e.updated_at) from e where e.expense_status = 'returned'
    union all
    select 'request', r.id, 'request_' || r.status, 3, coalesce(r.decided_at, r.cancelled_at, r.requested_at) from last_req r
  ), top as (
    select * from pick order by rank, at desc limit 1
  )
  select coalesce(t.state, 'unpaid'),
         case when t.src in ('entry', 'legacy') then 'direct' when t.src = 'request' then p.route end,
         p.ref_no,
         case when t.src = 'entry' then e.return_reason else p.return_reason end,
         (select e2.id from e e2 limit 1),
         (select e2.row_version from e e2 limit 1),
         case when t.src = 'request' then p.id end,
         case when t.src = 'request' then p.row_version end,
         case when t.src = 'request' and p.status in ('pending', 'approved') then authz.sm_hold_reason(p.id) is not null end,
         case when t.src = 'request' and p.status in ('pending', 'approved') then authz.sm_hold_reason(p.id) end,
         coalesce(t.src = 'legacy'
           or t.state in ('request_approved', 'request_paid', 'request_verified')
           or (t.state in ('direct_submitted', 'direct_accepted') and authz.expense_receipt_ok(e.id)), false)
  from (select 1) one
  left join top t on true
  left join public.supplier_payment_requests p on t.src = 'request' and p.id = t.id
  left join e on t.src = 'entry' and e.id = t.id
$$;

-- Replaces 20261201000210: nothing left to pay counts as paid.
create or replace function authz.flight_batch_paid(p_batch uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select b.supplier_cost_paise = 0 or authz.flight_batch_due(b.id) = 0
                   from public.flight_ticket_batches b where b.id = p_batch), false)
      or coalesce((select x.paid from authz.flight_batch_payment(p_batch) x), false)
$$;

revoke all on function authz.flight_batch_legacy_paid(uuid), authz.flight_batch_due(uuid),
  authz.flight_batch_payment(uuid), authz.flight_batch_paid(uuid)
from public, anon, authenticated, service_role;

create or replace function authz.sm_supplier_running_total(p_deal uuid, p_supplier uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select (coalesce((select sum(p.amount_paise) from public.supplier_payment_requests p
                    where p.deal_id = p_deal and p.supplier_id = p_supplier
                      and p.status in ('pending', 'approved', 'paid', 'verified')), 0)
        + coalesce((select sum(c.amount_paise) from public.department_cost_entries c
                    where c.deal_id = p_deal and c.supplier_id = p_supplier and c.department = 'flight'
                      and c.paid_by = 'company' and c.expense_status is distinct from 'returned'), 0)
        -- 20261201000250: old-form flight payments linked to a batch of this supplier.
        + coalesce((select sum(c.amount_paise) from public.flight_batch_legacy_costs l
                    join public.flight_ticket_batches b on b.id = l.batch_id
                    join public.department_cost_entries c on c.id = l.entry_id
                    where b.deal_id = p_deal and b.supplier_id = p_supplier
                      and c.expense_status is distinct from 'returned'), 0))::bigint
$$;

create or replace function authz.sm_payment_create_flight(p_task_id uuid, p_fields jsonb, p_request_id uuid, p_resubmits uuid,
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
  -- 20261201000250: less what old-form payments linked to the batch already cover.
  v_amount := authz.flight_batch_due(v_batch.id);
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
  -- 20261201000250: an old-form entry linked to a ticket batch goes back to
  -- Accounts only while the batch has no other payment (never paid twice).
  if exists (select 1 from public.flight_batch_legacy_costs l
             where l.entry_id = v_entry.id
               and (exists (select 1 from public.supplier_payment_requests p
                            where p.flight_batch_id = l.batch_id and p.status in ('pending', 'approved', 'paid', 'verified'))
                    or exists (select 1 from public.department_cost_entries c
                               where c.flight_batch_id = l.batch_id and c.expense_status is distinct from 'returned'))) then
    raise exception 'payment_in_progress' using errcode = '55000';
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

create or replace function public.flight_tickets_confirm(p_deal_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
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
  v_legacy jsonb;
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
       or v_approval.projected_supplier_cost_paise - v_approval.batch_supplier_cost_paise <> (v_check ->> 'dealCostBefore')::bigint
       -- 20261201000250: a change of the Deal's flight budget invalidates the approval.
       or v_approval.budget_paise is distinct from (v_check ->> 'dealBudget')::bigint then
      raise exception 'fare_approval_mismatch' using errcode = '55000';
    end if;
    v_approval_id := v_approval.id;
  elsif v_approval.id is not null and v_approval.status = 'approved' and v_approval.fare_hash = (v_check ->> 'fareHash')
        and v_approval.projected_supplier_cost_paise - v_approval.batch_supplier_cost_paise = (v_check ->> 'dealCostBefore')::bigint
        and v_approval.budget_paise is not distinct from (v_check ->> 'dealBudget')::bigint then
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
  -- 20261201000250 (L18): company-paid flight costs recorded with the old form
  -- on the tasks of these tickets, not yet linked, become this batch's earlier
  -- payment (counted in the cap and in what is still to pay).
  with linked as (
    insert into public.flight_batch_legacy_costs (entry_id, batch_id, legal_entity_id, deal_id, linked_by)
    select c.id, v_batch_id, c.legal_entity_id, c.deal_id, v_uid
    from public.department_cost_entries c
    where c.deal_id = p_deal_id and c.department = 'flight' and c.flight_batch_id is null and c.paid_by = 'company'
      and c.task_id in (select s.task_id from public.flight_sectors s
                        where s.id = any (array(select jsonb_array_elements_text(v_check -> 'sectorIds')::uuid)))
      and not exists (select 1 from public.flight_batch_legacy_costs l where l.entry_id = c.id)
    returning entry_id
  )
  select coalesce(jsonb_agg(entry_id), '[]'::jsonb) into v_legacy from linked;

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
      'ticketCount', v_tickets, 'fareApprovalId', v_approval_id, 'legacyEntryIds', v_legacy));
  v_result := jsonb_build_object('outcome', 'created', 'batchId', v_batch_id, 'batchNo', v_batch_no,
    'ticketCount', v_tickets, 'travellersConfirmed', jsonb_array_length(v_check -> 'travellers'), 'stillPending', v_still);
  return authz.flight_remember(v_deal.legal_entity_id, p_request_id, 'flight_tickets_confirm', v_payload, v_result);
end;
$$;

create or replace function public.flight_direct_payment_save(p_batch_id uuid, p_expected_row_version integer, p_fields jsonb,
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
  v_due bigint;
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
  -- 20261201000250: less what old-form payments linked to the batch already cover.
  v_due := authz.flight_batch_due(v_batch.id);
  if v_due <= 0 then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if v_proof is null or not exists (
       select 1 from public.department_evidence e
       where e.id = v_proof and e.task_id = v_task.id and e.kind = 'direct_payment_proof' and e.status = 'stored') then
    raise exception 'receipt_required' using errcode = '55000';
  end if;
  -- C1: cumulative per (Deal, supplier), this payment included; exactly INR 50,000 is direct.
  if authz.sm_supplier_running_total(v_batch.deal_id, v_batch.supplier_id) + v_due > 5000000 then
    raise exception 'direct_payment_over_limit' using errcode = '22023';
  end if;

  if v_old.id is null then
    insert into public.department_cost_entries (task_id, deal_id, legal_entity_id, branch_id, department, cost_kind,
      amount_paise, paid_by, payment_mode, paid_on, reference, receipt_evidence_id, expense_status, submitted_by,
      submitted_at, request_id, created_by, supplier_id, flight_batch_id)
    values (v_task.id, v_batch.deal_id, v_batch.legal_entity_id, v_batch.branch_id, 'flight', 'fare',
      v_due, 'company', v_mode, v_on, v_ref, v_proof, 'submitted', v_uid,
      now(), p_request_id, v_uid, v_batch.supplier_id, v_batch.id)
    returning * into v_entry;
    v_outcome := 'created';
  else
    update public.department_cost_entries c
    set amount_paise = v_due, payment_mode = v_mode, paid_on = v_on, reference = v_ref,
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

create or replace function public.flight_fare_preview(p_deal_id uuid, p_fields jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_check jsonb;
  v_approval public.flight_fare_approvals%rowtype;
begin
  if not coalesce(authz.session_ok(), false) or p_deal_id is null or not coalesce(authz.flight_can_work(p_deal_id), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_check := authz.flight_fare_check(p_deal_id, p_fields, 'preview');
  -- The approval of exactly these fares on exactly the current other batches.
  select * into v_approval from public.flight_fare_approvals a
  where a.deal_id = p_deal_id and a.fare_hash = v_check ->> 'fareHash'
    and a.status in ('pending', 'approved', 'returned')
    and a.projected_supplier_cost_paise - a.batch_supplier_cost_paise = (v_check ->> 'dealCostBefore')::bigint
    and a.budget_paise is not distinct from (v_check ->> 'dealBudget')::bigint
  order by a.approval_no desc limit 1;
  return jsonb_build_object(
    'fareHash', v_check ->> 'fareHash',
    'batchSupplierCostPaise', v_check ->> 'batchSupplierCost',
    -- 20261201000250: never a selling-side value for a holder of Purchase.
    'batchCustomerTotalPaise', case when not authz.holds_role('purchase', (select d.legal_entity_id from public.deals d where d.id = p_deal_id))
                                    then v_check ->> 'batchCustomerTotal' end,
    'dealSupplierCostAfterPaise', v_check ->> 'dealCostAfter',
    'dealBudgetPaise', v_check ->> 'dealBudget',
    'overBudget', (v_check ->> 'overBudget')::boolean,
    'approval', case when v_approval.id is null then null
                     else jsonb_build_object('approvalId', v_approval.id, 'status', v_approval.status) end,
    'costTaskId', v_check ->> 'costTaskId');
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
              'paymentRowVersion', x.payment_row_version) else '{}'::jsonb end
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

create or replace function public.flight_payment_context(p_batch_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_batch public.flight_ticket_batches%rowtype;
  v_state text;
  v_running bigint;
  v_due bigint;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_batch from public.flight_ticket_batches b where b.id = p_batch_id;
  if v_batch.id is null or not authz.flight_owns_task(v_batch.cost_task_id) then
    return null;
  end if;
  select x.state into v_state from authz.flight_batch_payment(v_batch.id) x;
  v_running := authz.sm_supplier_running_total(v_batch.deal_id, v_batch.supplier_id);
  -- 20261201000250 (L18): what is still to pay after old-form payments.
  v_due := authz.flight_batch_due(v_batch.id);
  return jsonb_build_object(
    'batchId', v_batch.id,
    'batchNo', v_batch.batch_no,
    'costTaskId', v_batch.cost_task_id,
    'amountPaise', v_due::text,
    'supplierCostPaise', v_batch.supplier_cost_paise::text,
    'legacyPaidPaise', authz.flight_batch_legacy_paid(v_batch.id)::text,
    'supplierId', v_batch.supplier_id,
    'supplierName', (select s.name from public.suppliers s where s.id = v_batch.supplier_id),
    'runningTotalPaise', v_running::text,
    'routePreview', case when v_running + v_due <= 5000000 then 'direct' else 'manager' end,
    'directAllowed', v_due > 0 and not authz.deal_trip_cancelled(v_batch.deal_id)
                     and v_state in ('unpaid', 'direct_returned', 'request_returned', 'request_cancelled')
                     and v_running + v_due <= 5000000,
    'directLimitPaise', '5000000',
    'proofs', coalesce((
      select jsonb_agg(jsonb_build_object('evidenceId', e.id, 'fileName', e.file_name) order by e.created_at, e.id)
      from public.department_evidence e
      where e.task_id = v_batch.cost_task_id and e.kind = 'direct_payment_proof' and e.status = 'stored'), '[]'::jsonb));
end;
$$;

create or replace function public.flight_fare_approval_sets(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null
     or not exists (select 1 from public.fulfilment_tasks t where t.deal_id = v_deal.id and t.department = 'flight')
     or not (authz.holds_active_role('flight', v_deal.legal_entity_id)
             or (authz.is_branch_sales_manager(v_deal.id) and not authz.holds_role('purchase', v_deal.legal_entity_id))
             or (authz.can_accounts(v_deal.legal_entity_id) and not authz.holds_role('purchase', v_deal.legal_entity_id)
                 and authz.finance_gate_issue(v_deal.legal_entity_id, v_deal.is_synthetic) is null)) then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'approvalId', a.id,
      'approvalNo', a.approval_no,
      'status', a.status,
      'rowVersion', a.row_version,
      'fareHash', a.fare_hash,
      'supplierId', a.payload ->> 'supplierId',
      'supplierName', s.name,
      'sectorIds', coalesce(a.payload -> 'sectorIds', '[]'::jsonb),
      'travellers', coalesce(a.payload -> 'travellers', '[]'::jsonb),
      'fares', coalesce((
        select jsonb_agg(jsonb_build_object(
            'paxType', f ->> 'paxType',
            'basicPaise', f ->> 'basicPaise',
            'kPaise', f ->> 'kPaise',
            'yqPaise', f ->> 'yqPaise',
            'yrPaise', f ->> 'yrPaise',
            'otherPaise', f ->> 'otherPaise',
            'paxCount', (select count(*) from jsonb_array_elements(a.payload -> 'travellers') t
                         where t ->> 'type' = f ->> 'paxType'))
          -- Markup and discount exist only on flight-only Deals (null in package payloads).
          -- 20261201000250: never for a holder of Purchase.
          || case when f ->> 'markupPaise' is not null and not authz.holds_role('purchase', v_deal.legal_entity_id) then jsonb_build_object(
               'markupPaise', f ->> 'markupPaise', 'discountPaise', f ->> 'discountPaise') else '{}'::jsonb end
          order by f ->> 'paxType')
        from jsonb_array_elements(a.payload -> 'fares') f), '[]'::jsonb)) order by a.approval_no desc)
    from public.flight_fare_approvals a
    left join public.suppliers s on s.id::text = a.payload ->> 'supplierId'
    where a.deal_id = v_deal.id and a.status in ('pending', 'approved')), '[]'::jsonb);
end;
$$;

commit;
