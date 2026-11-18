-- TripNavigate CRM - Accounts phase 3, track H (1 of 4): add or remove
-- services after the booking was submitted - data and guards.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 11.1, 11.3, 14,
-- 17.1, 19, 21 LD30, LD31, LD32, Addendum O1, Addendum L7.
--
-- Changed tables:
--   1. fulfilment_tasks: closed_state ('withdrawn' | 'cancelled'), closed_at,
--      closed_by, closed_change_request_id - all set together, once, by an
--      applied remove_service request (LD31). The status column and its
--      checks are unchanged: a closed task keeps its status (a removed booked
--      hotel stays supplier_confirmed) and is simply not open work any more.
--   2. purchase_cancellation_charges, flight_cancellation_charges,
--      visa_cancellation_fees: cancellation_id becomes nullable and
--      change_request_id is added (exactly one of the two). A booked service
--      being removed records its supplier charges in the existing tables,
--      keyed by the remove_service request; no deal_cancellations row is ever
--      written for it (LD30: every existing reader treats one as a whole-trip
--      cancellation). Revisions per request: partial unique indexes.
-- Replaced (latest bodies, same signatures; changed lines marked
-- "Accounts phase 3 (20261205000700)"):
--   authz.fulfilment_tasks_state_guard (20261205000630, track G): the closed
--     columns are set once under authz.task_transition = 'close', nothing else
--     changes with them, and they never change again.
--   authz.service_items_guard (20261118000100): an item moves to 'cancelled'
--     (from planned or active) only when the removal names it in the
--     transaction setting tripnavigate.service_item_cancel. Not in the
--     contract's H list; needed by 11.1 "service_items.state -> cancelled"
--     (reported to the lead).
--
-- Refusal tokens: none (guards raise 42501 with a plain message).
-- Rollback (forward-only): a NEW migration restoring the two cited bodies;
-- the new columns stay (nullable, unused when the switch is Off).

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Closed tasks (LD31)
-- ===========================================================================

alter table public.fulfilment_tasks
  add column closed_state text check (closed_state in ('withdrawn', 'cancelled')),
  add column closed_at timestamptz,
  add column closed_by uuid references public.staff_profiles (user_id),
  add column closed_change_request_id uuid,
  add constraint fulfilment_tasks_closed_change_request_fk
    foreign key (legal_entity_id, closed_change_request_id) references public.booking_change_requests (legal_entity_id, id),
  add constraint fulfilment_tasks_closed_together check (
    (closed_state is null) = (closed_at is null)
    and (closed_state is null) = (closed_by is null)
    and (closed_state is null) = (closed_change_request_id is null));
create index fulfilment_tasks_closed_change_request_idx on public.fulfilment_tasks (legal_entity_id, closed_change_request_id)
  where closed_change_request_id is not null;
create index fulfilment_tasks_closed_by_idx on public.fulfilment_tasks (closed_by) where closed_by is not null;
comment on column public.fulfilment_tasks.closed_state is
  'Accounts phase 3 (11.1, LD31): withdrawn (a service removed before anything was booked) or cancelled (a booked service removed through supplier charges). Set once by the applied remove_service request; a closed task is not open work.';

-- ===========================================================================
-- 2. Supplier charges of a booked service being removed (11.3, LD30)
-- ===========================================================================

alter table public.purchase_cancellation_charges
  alter column cancellation_id drop not null,
  add column change_request_id uuid,
  add constraint purchase_cancellation_charges_change_request_fk
    foreign key (legal_entity_id, change_request_id) references public.booking_change_requests (legal_entity_id, id),
  add constraint purchase_cancellation_charges_one_case check ((cancellation_id is null) <> (change_request_id is null));
create unique index purchase_cancellation_charges_change_request_key
  on public.purchase_cancellation_charges (change_request_id, task_id, revision_no) where change_request_id is not null;

alter table public.flight_cancellation_charges
  alter column cancellation_id drop not null,
  add column change_request_id uuid,
  add constraint flight_cancellation_charges_change_request_fk
    foreign key (legal_entity_id, change_request_id) references public.booking_change_requests (legal_entity_id, id),
  add constraint flight_cancellation_charges_one_case check ((cancellation_id is null) <> (change_request_id is null));
create unique index flight_cancellation_charges_change_request_key
  on public.flight_cancellation_charges (change_request_id, batch_id, revision_no) where change_request_id is not null;

alter table public.visa_cancellation_fees
  alter column cancellation_id drop not null,
  add column change_request_id uuid,
  add constraint visa_cancellation_fees_change_request_fk
    foreign key (legal_entity_id, change_request_id) references public.booking_change_requests (legal_entity_id, id),
  add constraint visa_cancellation_fees_one_case check ((cancellation_id is null) <> (change_request_id is null));
create unique index visa_cancellation_fees_change_request_key
  on public.visa_cancellation_fees (change_request_id, entry_id, revision_no) where change_request_id is not null;

comment on column public.purchase_cancellation_charges.change_request_id is
  'Accounts phase 3 (11.3): the remove_service request this charge belongs to (then cancellation_id is null).';
comment on column public.flight_cancellation_charges.change_request_id is
  'Accounts phase 3 (11.3): the remove_service request this charge belongs to (then cancellation_id is null).';
comment on column public.visa_cancellation_fees.change_request_id is
  'Accounts phase 3 (11.3): the remove_service request this fee refund belongs to (then cancellation_id is null).';

-- ===========================================================================
-- 3. Guards
-- ===========================================================================

-- Replaces 20261205000630_change_apply.sql:351 (latest body; changed lines marked).
create or replace function authz.fulfilment_tasks_state_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_transition text := coalesce(current_setting('authz.task_transition', true), '');
begin
  -- Accounts phase 3 (20261205000700): closing a task (LD31) sets the four closed columns together, once,
  -- under authz.task_transition = 'close' (an applied service removal), and
  -- changes nothing else - whatever the task's status. They never change again.
  if old.closed_state is null and new.closed_state is not null then
    if v_transition = 'close'
       and (to_jsonb(new) - array['closed_state', 'closed_at', 'closed_by', 'closed_change_request_id', 'updated_at'])
           = (to_jsonb(old) - array['closed_state', 'closed_at', 'closed_by', 'closed_change_request_id', 'updated_at']) then
      return new;
    end if;
    raise exception 'fulfilment tasks are closed only by an applied service removal' using errcode = '42501';
  end if;
  if (new.closed_state, new.closed_at, new.closed_by, new.closed_change_request_id)
     is distinct from (old.closed_state, old.closed_at, old.closed_by, old.closed_change_request_id) then
    raise exception 'a closed task stays closed' using errcode = '42501';
  end if;
  if old.status = 'supplier_confirmed' then
    -- Accounts phase 3 (20261205000630): an applied reconfirmation moves the
    -- supplier reference and the confirming person / time, nothing else.
    if v_transition = 'reconfirm'
       and (to_jsonb(new) - array['supplier_reference', 'supplier_confirmed_by', 'supplier_confirmed_at', 'updated_at'])
           = (to_jsonb(old) - array['supplier_reference', 'supplier_confirmed_by', 'supplier_confirmed_at', 'updated_at']) then
      return new;
    end if;
    raise exception 'supplier-confirmed tasks are immutable' using errcode = '42501';
  end if;
  -- B1.1c: completed visa work is final; only in_progress -> completed.
  if old.status = 'completed' then
    raise exception 'completed tasks are immutable' using errcode = '42501';
  end if;
  if new.status = 'completed' and (old.status <> 'in_progress' or new.assignee_user_id is distinct from old.assignee_user_id) then
    raise exception 'fulfilment task status cannot move this way' using errcode = '42501';
  end if;
  if old.status = 'not_started' and new.status = 'supplier_confirmed' then
    raise exception 'fulfilment task status cannot move this way' using errcode = '42501';
  end if;
  if old.status = 'in_progress' and new.status = 'not_started' and v_transition <> 'release' then
    raise exception 'fulfilment task status cannot move this way' using errcode = '42501';
  end if;
  -- Review L1: the assignee may change only by reassignment (in_progress -> in_progress);
  -- never together with supplier confirmation.
  if old.status = 'in_progress' and new.status = 'supplier_confirmed'
     and new.assignee_user_id is distinct from old.assignee_user_id then
    raise exception 'fulfilment task assignee cannot change at supplier confirmation' using errcode = '42501';
  end if;
  if old.status = 'in_progress' and new.status = 'in_progress'
     and new.assignee_user_id is distinct from old.assignee_user_id and v_transition <> 'reassign' then
    raise exception 'fulfilment task assignee changes only through reassignment' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Replaces 20261118000100_b1_service_items.sql:474 (latest body; changed lines marked).
create or replace function authz.service_items_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.state <> 'planned'
       or coalesce(current_setting('tripnavigate.service_item_remove', true), '') <> old.id::text then
      raise exception 'service items are removed only through service_item_remove while planned' using errcode = '42501';
    end if;
    return old;
  end if;
  if new.id is distinct from old.id or new.deal_id is distinct from old.deal_id
     or new.legal_entity_id is distinct from old.legal_entity_id or new.branch_id is distinct from old.branch_id
     or new.item_no is distinct from old.item_no or new.service_type is distinct from old.service_type
     or new.department is distinct from old.department or new.request_id is distinct from old.request_id
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'service item identity columns are immutable' using errcode = '42501';
  end if;
  if new.state is distinct from old.state and not (old.state = 'planned' and new.state = 'active')
     -- Accounts phase 3 (20261205000700): an applied service removal cancels the item (it names the row).
     and not (old.state in ('planned', 'active') and new.state = 'cancelled'
              and coalesce(current_setting('tripnavigate.service_item_cancel', true), '') = old.id::text) then
    raise exception 'service item state cannot move this way' using errcode = '42501';
  end if;
  return new;
end;
$$;

commit;
