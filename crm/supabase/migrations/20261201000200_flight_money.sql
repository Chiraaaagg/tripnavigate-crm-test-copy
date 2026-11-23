-- Flight build, Track B (1 of 3): flight money schema.
-- Contract: flight build contract (frozen 4 Nov 2026) sections 4, 5.2, 5.3;
-- owner decisions D2, D3, D4 and conflict note C1 (accepted, lead L1).
-- Runs after Track A's 20261201000100..0199 (flight_sectors,
-- flight_ticket_revisions and the authz.flight_* helpers).
--
-- Adds:
--   * flight_fare_approvals: the branch Manager approves one exact fare set
--     (sha256 of the canonical fare JSON, authz.flight_fare_hash) when the
--     Deal's flight supplier cost goes above the Deal's flight budget.
--   * flight_ticket_batches + flight_batch_fares: one append-only row per
--     "Confirm tickets" with the per-type fare breakup (generated supplier
--     cost per person and total per person). Markup and discount exist only
--     on flight-only Deals (both null on package Deals, trigger checked).
--   * department_cost_entries.supplier_id / flight_batch_id: a direct
--     payment of a batch is its one company-paid fare entry.
--   * supplier_payment_requests.flight_batch_id: a flight payment request
--     is bound to its batch (no cost version, optional proforma).
--   * suppliers.service_types may include 'flight'.
--   * FK flight_ticket_revisions.batch_id -> flight_ticket_batches.
--
-- Existing rows are not touched: every existing payment request keeps its
-- cost version and proforma; every existing cost entry has no supplier and
-- no batch.
--
-- Rollback (forward-only): a NEW migration that revokes the flight money
-- commands (20261201000210). The tables, columns and constraints stay; rows
-- are never deleted.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Suppliers may serve flights
-- ===========================================================================

do $$
declare
  c record;
begin
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.suppliers'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%service_types%'
  loop
    execute format('alter table public.suppliers drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table public.suppliers add constraint suppliers_service_types_check
  check (cardinality(service_types) between 1 and 4
         and service_types <@ array['hotel', 'transfer', 'activity', 'flight']);

-- ===========================================================================
-- 2. Tables
-- ===========================================================================

create table public.flight_fare_approvals (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  deal_id uuid not null,
  approval_no integer not null check (approval_no >= 1),
  fare_hash text not null check (fare_hash ~ '^[0-9a-f]{64}$'),
  -- The canonical fare JSON the hash was computed from (no PNRs or numbers).
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  -- Deal flight supplier cost after this batch, and of this batch alone.
  projected_supplier_cost_paise bigint not null check (projected_supplier_cost_paise between 0 and 999999999999999),
  batch_supplier_cost_paise bigint not null check (batch_supplier_cost_paise between 0 and 999999999999),
  -- Deal flight budget at request time; null = not set.
  budget_paise bigint check (budget_paise is null or budget_paise >= 0),
  status text not null default 'pending' check (status in ('pending', 'approved', 'returned', 'withdrawn', 'used')),
  requested_by uuid not null references public.staff_profiles (user_id),
  requested_at timestamptz not null default now(),
  decided_by uuid references public.staff_profiles (user_id),
  decided_at timestamptz,
  return_reason text check (return_reason is null or length(return_reason) between 10 and 500),
  used_by_batch_id uuid,
  request_id uuid not null,
  row_version integer not null default 1 check (row_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, branch_id, deal_id) references public.deals (legal_entity_id, branch_id, id),
  unique (legal_entity_id, id),
  unique (deal_id, approval_no),
  unique (legal_entity_id, request_id),
  check (batch_supplier_cost_paise <= projected_supplier_cost_paise),
  check ((status in ('approved', 'returned', 'used')) = (decided_by is not null and decided_at is not null)),
  check ((status = 'returned') = (return_reason is not null)),
  check ((status = 'used') = (used_by_batch_id is not null)),
  check (decided_by is null or decided_by <> requested_by)
);
create unique index flight_fare_approvals_one_pending on public.flight_fare_approvals (deal_id) where status = 'pending';
create index flight_fare_approvals_deal_idx on public.flight_fare_approvals (deal_id, status);
create index flight_fare_approvals_status_idx on public.flight_fare_approvals (legal_entity_id, status, requested_at);
create index flight_fare_approvals_requested_by_idx on public.flight_fare_approvals (requested_by);
create index flight_fare_approvals_decided_by_idx on public.flight_fare_approvals (decided_by) where decided_by is not null;
create index flight_fare_approvals_used_by_idx on public.flight_fare_approvals (used_by_batch_id) where used_by_batch_id is not null;
comment on table public.flight_fare_approvals is
  'Branch Manager approval of one exact flight fare set above the Deal''s flight budget (fare_hash). Valid for one confirm while approved and the Deal''s other batches are unchanged. No table grant.';

create table public.flight_ticket_batches (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  deal_id uuid not null,
  batch_no integer not null check (batch_no >= 1),
  -- All of the batch's cost and payment belong to this task (lead L8).
  cost_task_id uuid not null,
  supplier_id uuid not null,
  deal_kind text not null check (deal_kind in ('package', 'flight_only')),
  sector_ids uuid[] not null check (cardinality(sector_ids) between 1 and 16 and array_position(sector_ids, null) is null),
  fare_approval_id uuid references public.flight_fare_approvals (id),
  supplier_cost_paise bigint not null check (supplier_cost_paise between 0 and 999999999999),
  customer_total_paise bigint check (customer_total_paise is null or customer_total_paise between 0 and 999999999999),
  -- Deal flight budget at confirmation; null = not set.
  budget_paise bigint check (budget_paise is null or budget_paise >= 0),
  over_budget boolean not null,
  confirmed_by uuid not null references public.staff_profiles (user_id),
  confirmed_at timestamptz not null default now(),
  request_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, branch_id, deal_id) references public.deals (legal_entity_id, branch_id, id),
  foreign key (legal_entity_id, cost_task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (legal_entity_id, supplier_id) references public.suppliers (legal_entity_id, id),
  unique (legal_entity_id, id),
  unique (deal_id, batch_no),
  unique (legal_entity_id, request_id),
  check ((deal_kind = 'flight_only') = (customer_total_paise is not null)),
  check (not over_budget or fare_approval_id is not null)
);
create unique index flight_ticket_batches_approval_key on public.flight_ticket_batches (fare_approval_id)
  where fare_approval_id is not null;
create index flight_ticket_batches_deal_idx on public.flight_ticket_batches (deal_id);
create index flight_ticket_batches_cost_task_idx on public.flight_ticket_batches (cost_task_id);
create index flight_ticket_batches_supplier_idx on public.flight_ticket_batches (supplier_id);
create index flight_ticket_batches_confirmed_by_idx on public.flight_ticket_batches (confirmed_by);
comment on table public.flight_ticket_batches is
  'One successful "Confirm tickets": supplier, sectors, supplier cost (and customer total on flight-only Deals). Append-only. No table grant.';

alter table public.flight_fare_approvals
  add constraint flight_fare_approvals_used_by_fk foreign key (used_by_batch_id) references public.flight_ticket_batches (id);

create table public.flight_batch_fares (
  batch_id uuid not null,
  legal_entity_id uuid not null,
  pax_type text not null check (pax_type in ('adult', 'child', 'infant')),
  basic_paise bigint not null check (basic_paise between 0 and 99999999999),
  k_paise bigint not null check (k_paise between 0 and 99999999999),
  yq_paise bigint not null check (yq_paise between 0 and 99999999999),
  yr_paise bigint not null check (yr_paise between 0 and 99999999999),
  other_paise bigint not null check (other_paise between 0 and 99999999999),
  -- Flight-only Deals only (both set); package Deals: both null (trigger).
  markup_paise bigint check (markup_paise is null or markup_paise between 0 and 99999999999),
  discount_paise bigint check (discount_paise is null or discount_paise between 0 and 99999999999),
  pax_count integer not null check (pax_count between 1 and 100),
  supplier_per_person_paise bigint generated always as (basic_paise + k_paise + yq_paise + yr_paise + other_paise) stored,
  total_per_person_paise bigint generated always as (
    basic_paise + k_paise + yq_paise + yr_paise + other_paise + coalesce(markup_paise, 0) - coalesce(discount_paise, 0)) stored,
  created_at timestamptz not null default now(),
  primary key (batch_id, pax_type),
  foreign key (legal_entity_id, batch_id) references public.flight_ticket_batches (legal_entity_id, id),
  check ((markup_paise is null) = (discount_paise is null)),
  check (total_per_person_paise >= 0)
);
create index flight_batch_fares_entity_batch_idx on public.flight_batch_fares (legal_entity_id, batch_id);
comment on table public.flight_batch_fares is
  'Per passenger type fare breakup of a ticket batch (the only flight cost record, owner D3). Append-only. No table grant.';

-- Track A created the column; the batch it names now must exist.
alter table public.flight_ticket_revisions
  add constraint flight_ticket_revisions_batch_fk
  foreign key (legal_entity_id, batch_id) references public.flight_ticket_batches (legal_entity_id, id);
create index if not exists flight_ticket_revisions_batch_fk_idx on public.flight_ticket_revisions (legal_entity_id, batch_id);

-- A direct payment of a batch: its one company-paid fare entry.
alter table public.department_cost_entries
  add column supplier_id uuid,
  add column flight_batch_id uuid,
  add constraint department_cost_entries_supplier_fk
    foreign key (legal_entity_id, supplier_id) references public.suppliers (legal_entity_id, id),
  add constraint department_cost_entries_flight_batch_fk
    foreign key (legal_entity_id, flight_batch_id) references public.flight_ticket_batches (legal_entity_id, id),
  add constraint department_cost_entries_batch_supplier check ((flight_batch_id is null) = (supplier_id is null)),
  add constraint department_cost_entries_batch_shape check (flight_batch_id is null
    or (department = 'flight' and cost_kind = 'fare' and paid_by = 'company'));
create unique index department_cost_entries_flight_batch_key on public.department_cost_entries (flight_batch_id)
  where flight_batch_id is not null;
create index department_cost_entries_supplier_idx on public.department_cost_entries (deal_id, supplier_id)
  where supplier_id is not null;
create index department_cost_entries_supplier_fk_idx on public.department_cost_entries (legal_entity_id, supplier_id)
  where supplier_id is not null;
create index department_cost_entries_batch_fk_idx on public.department_cost_entries (legal_entity_id, flight_batch_id)
  where flight_batch_id is not null;

-- A flight payment request is bound to its batch.
alter table public.supplier_payment_requests
  add column flight_batch_id uuid,
  alter column cost_version_no drop not null,
  alter column proforma_evidence_id drop not null,
  add constraint supplier_payment_requests_flight_batch_fk
    foreign key (legal_entity_id, flight_batch_id) references public.flight_ticket_batches (legal_entity_id, id),
  add constraint supplier_payment_requests_cost_basis check ((flight_batch_id is null) = (cost_version_no is not null)),
  add constraint supplier_payment_requests_proforma_basis check (flight_batch_id is not null or proforma_evidence_id is not null),
  add constraint supplier_payment_requests_flight_shape check (flight_batch_id is null
    or (part = 'full' and go_ahead_request_id is null));
create unique index supplier_payment_requests_flight_live_key on public.supplier_payment_requests (flight_batch_id)
  where flight_batch_id is not null and status in ('pending', 'approved', 'paid', 'verified');
create index supplier_payment_requests_flight_batch_idx on public.supplier_payment_requests (legal_entity_id, flight_batch_id)
  where flight_batch_id is not null;
create index supplier_payment_requests_proforma_idx on public.supplier_payment_requests (proforma_evidence_id)
  where proforma_evidence_id is not null;

-- ===========================================================================
-- 3. Integrity triggers
-- ===========================================================================

create function authz.flight_money_append_only() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception '% rows are append-only', tg_table_name using errcode = '42501';
end;
$$;

-- Facts are fixed at create; only the decision and use columns move, forward.
create function authz.flight_fare_approvals_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_mutable text[] := array['status', 'decided_by', 'decided_at', 'return_reason', 'used_by_batch_id',
    'row_version', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    raise exception 'flight fare approvals cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    raise exception 'flight fare approval facts are immutable' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'pending' and new.status in ('approved', 'returned', 'withdrawn'))
    or (old.status = 'approved' and new.status = 'used')) then
    raise exception 'flight fare approval status cannot move this way' using errcode = '42501';
  end if;
  if new.status = old.status and (new.decided_by is distinct from old.decided_by
       or new.decided_at is distinct from old.decided_at or new.return_reason is distinct from old.return_reason
       or new.used_by_batch_id is distinct from old.used_by_batch_id) then
    raise exception 'flight fare approval decisions are final' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Markup and discount follow the batch's Deal kind (owner D4).
create function authz.flight_batch_fares_kind_check() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_kind text;
begin
  select b.deal_kind into v_kind from public.flight_ticket_batches b where b.id = new.batch_id;
  if v_kind = 'package' and (new.markup_paise is not null or new.discount_paise is not null) then
    raise exception 'package flight fares carry no markup or discount' using errcode = '23514';
  end if;
  if v_kind = 'flight_only' and (new.markup_paise is null or new.discount_paise is null) then
    raise exception 'flight-only fares need markup and discount' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger flight_fare_approvals_a_guard before update or delete on public.flight_fare_approvals
  for each row execute function authz.flight_fare_approvals_guard();
create trigger flight_ticket_batches_a_append_only before update or delete on public.flight_ticket_batches
  for each row execute function authz.flight_money_append_only();
create trigger flight_batch_fares_a_append_only before update or delete on public.flight_batch_fares
  for each row execute function authz.flight_money_append_only();
create trigger flight_batch_fares_b_kind before insert on public.flight_batch_fares
  for each row execute function authz.flight_batch_fares_kind_check();

-- Replaces 20261119000500: the new supplier and batch columns are immutable
-- too; everything else is unchanged.
create or replace function authz.department_cost_entries_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'cost entries cannot be deleted' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.task_id is distinct from old.task_id or new.deal_id is distinct from old.deal_id
     or new.legal_entity_id is distinct from old.legal_entity_id or new.department is distinct from old.department
     or new.request_id is distinct from old.request_id or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     -- Flight build (20261201000200): the batch a direct payment belongs to.
     or new.supplier_id is distinct from old.supplier_id or new.flight_batch_id is distinct from old.flight_batch_id then
    raise exception 'cost entry identity columns are immutable' using errcode = '42501';
  end if;
  if old.expense_status = 'accepted' then
    raise exception 'accepted expense records are immutable' using errcode = '42501';
  end if;
  if old.expense_status = 'submitted' and new.expense_status not in ('accepted', 'returned', 'submitted') then
    raise exception 'a submitted expense record changes only by review' using errcode = '42501';
  end if;
  if old.expense_status = 'submitted'
     and (to_jsonb(new) - array['expense_status', 'reviewed_by', 'reviewed_at', 'return_reason', 'row_version', 'updated_at'])
         <> (to_jsonb(old) - array['expense_status', 'reviewed_by', 'reviewed_at', 'return_reason', 'row_version', 'updated_at']) then
    raise exception 'a submitted expense record changes only by review' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function authz.flight_money_append_only(), authz.flight_fare_approvals_guard(),
  authz.flight_batch_fares_kind_check(), authz.department_cost_entries_guard()
from public, anon, authenticated, service_role;

-- ===========================================================================
-- 4. Row level security: no permissive policy, no table privilege.
-- ===========================================================================

do $$
declare
  t text;
begin
  foreach t in array array['flight_fare_approvals', 'flight_ticket_batches', 'flight_batch_fares'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

-- ===========================================================================
-- 5. Permission catalogue (documentation of who acts)
-- ===========================================================================

insert into public.permissions (code, description, is_grantable) values
  ('flight.fares_confirm', 'Confirm flight tickets with the per-passenger fare breakup on the Deal you work on; ask the Manager to approve fares above budget.', false),
  ('flight.fares_approve', 'Approve or return flight fares above the Deal''s flight budget (branch Manager; never the requester or the Deal''s Flight person).', false),
  ('flight.supplier_pay', 'Record a direct flight payment with proof (cumulative up to INR 50,000 per Deal and supplier) or ask for a supplier payment.', false)
on conflict (code) do nothing;

insert into public.role_permissions (role_code, permission_code, scope, policy_status, note) values
  ('flight', 'flight.fares_confirm', 'own', 'confirmed', 'Flight build 4 Nov 2026 (D3, D4): markup and discount on flight-only Deals only'),
  ('manager', 'flight.fares_approve', 'own', 'confirmed', 'Flight build 4 Nov 2026 (D3): manager of the Deal''s branch'),
  ('flight', 'flight.supplier_pay', 'own', 'confirmed', 'Flight build 4 Nov 2026 (D2, C1): cap counts direct payments and live requests per Deal and supplier'),
  ('flight', 'supplier.payment_request', 'own', 'confirmed', 'Flight build 4 Nov 2026 (D2): above INR 50,000 per Deal and supplier')
on conflict do nothing;

commit;
