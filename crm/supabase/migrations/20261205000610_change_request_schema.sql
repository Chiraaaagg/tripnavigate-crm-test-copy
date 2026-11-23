-- TripNavigate CRM - Accounts phase 3, track G (2 of 6): change after a
-- supplier confirmed - data.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 10.2, 10.4 (step 4
-- schema), 14, 17.1, 17.2, 21 LD23-LD29, LD36, LD37, Addendum O1.
--
-- New tables (RLS on, restrictive require_valid_session, all privileges
-- revoked; read only through definer reads):
--   1. booking_change_settings (single row): changes_enabled (Off),
--      service_changes_enabled (Off; written by track H's setter). Audit
--      settings.booking_changes_changed (trigger, column names and values of
--      the two switches only).
--   2. booking_change_counters: CR-YYYY-NNNNNN per entity and year.
--   3. booking_change_requests (LD23): one table for change / add_service /
--      remove_service; one live request per Deal (requested | returned |
--      approved | submitted). Guard: no DELETE; ref, Deal, base and requester
--      immutable; the request facts change only on resubmit (returned ->
--      requested); terminal states (applied, not_possible, withdrawn) are final.
--   4. task_confirmations: confirmation history per task (append-only);
--      confirmation 1 is backfilled here for every supplier-confirmed task from
--      the task row and its committed cost.
--   5. task_reconfirmations: the new rate, fee, reference and proof wait here
--      until the change is applied (LD25). Guard: no DELETE; identity
--      immutable; pending -> recorded | refused | void; recorded -> applied |
--      refused | void (+ the Manager's over-budget approval, once).
-- Changed tables:
--   6. booking_versions.change_request_id (FK; only on a revision).
--   7. accounts_booking_reviews.approval_source ('accounts' | 'change_request',
--      default 'accounts') and change_request_id (set exactly for
--      change_request): the Manager's approval stands in for the Accounts
--      review (LD24, Addendum O1).
--   8. purchase_cost_versions.confirmation_no (default 1) and change_fee_paise;
--      purchase_cost_versions_one_committed (20261005000100:200, one committed
--      row per task) becomes unique (task_id, confirmation_no) where committed.
--      Every reader of committed costs takes the highest version
--      (authz.purchase_latest_cost / purchase_agreed_cost); see the report.
--   9. purchase_cost_approvals.reconfirmation_id gets its FK and index;
--      purchase_evidence.reconfirmation_id (the reconfirmation proof, Addendum L5).
--  10. supplier_refund_receipts: cancellation_id nullable, new change_request_id,
--      source_kind gains 'reconfirmation'; exactly one of the two ids (LD29).
--
-- Refusal tokens: none raised here; guards raise 42501 with a plain message.
-- Rollback (forward-only): a NEW migration restoring
-- purchase_cost_versions_one_committed is impossible once a second committed
-- row exists; otherwise drop the new tables after their rows are archived and
-- restore the receipts checks. Never delete history rows.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Switches (10.2, G1; H1 writes service_changes_enabled)
-- ===========================================================================

create table public.booking_change_settings (
  id boolean primary key default true check (id),
  changes_enabled boolean not null default false,
  service_changes_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.booking_change_settings (id) values (true);
comment on table public.booking_change_settings is
  'Accounts phase 3 (10.2, 11.1): change after a supplier confirmed (G1) and add or remove services (H1). Both Off. Written only by admin_set_booking_changes_enabled / admin_set_service_changes_enabled.';

create function authz.booking_change_settings_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'booking change settings cannot be deleted' using errcode = '42501';
end;
$$;
create trigger booking_change_settings_a_guard before delete on public.booking_change_settings
  for each row execute function authz.booking_change_settings_guard();
create trigger booking_change_settings_no_truncate before truncate on public.booking_change_settings
  for each statement execute function authz.refuse_settings_truncate();
create trigger booking_change_settings_audit
  after insert or update or delete on public.booking_change_settings
  for each row execute function authz.audit_settings_change(
    'settings.booking_changes_changed', 'changes_enabled', 'service_changes_enabled');

-- ===========================================================================
-- 2. CR numbers
-- ===========================================================================

create table public.booking_change_counters (
  legal_entity_id uuid not null references public.legal_entities (id),
  year integer not null check (year between 2000 and 2100),
  last_no integer not null default 0 check (last_no between 0 and 999999),
  primary key (legal_entity_id, year)
);

-- ===========================================================================
-- 3. Change requests (LD23)
-- ===========================================================================

create table public.booking_change_requests (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  deal_id uuid not null,
  ref_no text not null unique check (ref_no ~ '^CR-[0-9]{4}-[0-9]{6}$'),
  kind text not null check (kind in ('change', 'add_service', 'remove_service')),
  base_version_id uuid not null,
  item_ids uuid[] not null default '{}'::uuid[],
  change_summary text not null check (length(change_summary) between 10 and 500),
  reason text not null check (length(reason) between 10 and 500),
  status text not null default 'requested'
    check (status in ('requested', 'returned', 'approved', 'submitted', 'applied', 'not_possible', 'withdrawn')),
  change_version_id uuid,
  -- Track H (11.3).
  removal_route text check (removal_route in ('simple', 'cancellation')),
  customer_charge_paise bigint check (customer_charge_paise between 0 and 999999999999),
  -- How the requester asked: the Sales owner, or a branch Manager (LD37 decides who may approve).
  requested_as text not null check (requested_as in ('sales_owner', 'manager')),
  requested_by uuid not null references public.staff_profiles (user_id),
  requested_at timestamptz not null default now(),
  request_id uuid not null,
  decided_by uuid references public.staff_profiles (user_id),
  decided_at timestamptz,
  decision_request_id uuid,
  return_reason text check (return_reason is null or length(return_reason) between 10 and 500),
  submitted_by uuid references public.staff_profiles (user_id),
  submitted_at timestamptz,
  -- Recorded at submit for the history view (weakest allowed class).
  changed_fields text[],
  change_class text check (change_class in ('format_only', 'internal_only', 'customer_material')),
  applied_at timestamptz,
  closed_by uuid references public.staff_profiles (user_id),
  closed_at timestamptz,
  close_reason text check (close_reason is null or length(close_reason) between 10 and 500),
  row_version integer not null default 1 check (row_version >= 1),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  foreign key (legal_entity_id, branch_id) references public.branches (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id, base_version_id) references public.booking_versions (legal_entity_id, deal_id, id),
  foreign key (legal_entity_id, deal_id, change_version_id) references public.booking_versions (legal_entity_id, deal_id, id),
  unique (legal_entity_id, request_id),
  unique (legal_entity_id, id),
  check (decided_by is distinct from requested_by),
  check ((decided_by is null) = (decided_at is null)),
  check (kind <> 'change' or cardinality(item_ids) between 1 and 20),
  check (kind <> 'add_service' or cardinality(item_ids) <= 20),
  check (kind <> 'remove_service' or cardinality(item_ids) = 1),
  check (status not in ('approved', 'submitted', 'applied') or decided_by is not null),
  check (status <> 'returned' or return_reason is not null),
  check (status not in ('submitted', 'applied') or (submitted_by is not null and submitted_at is not null and change_version_id is not null)),
  check ((status = 'applied') = (applied_at is not null)),
  check (status not in ('not_possible', 'withdrawn') or (closed_at is not null and close_reason is not null))
);
create unique index booking_change_requests_one_live on public.booking_change_requests (deal_id)
  where status in ('requested', 'returned', 'approved', 'submitted');
create index booking_change_requests_deal_idx on public.booking_change_requests (legal_entity_id, deal_id, requested_at desc);
create index booking_change_requests_base_idx on public.booking_change_requests (legal_entity_id, deal_id, base_version_id);
create index booking_change_requests_version_idx on public.booking_change_requests (legal_entity_id, deal_id, change_version_id)
  where change_version_id is not null;
create index booking_change_requests_branch_idx on public.booking_change_requests (legal_entity_id, branch_id);
create index booking_change_requests_list_idx on public.booking_change_requests (legal_entity_id, requested_at desc, id desc);
create index booking_change_requests_status_idx on public.booking_change_requests (status, requested_at desc, id desc)
  where status in ('requested', 'returned', 'approved', 'submitted');
create index booking_change_requests_requested_by_idx on public.booking_change_requests (requested_by);
create index booking_change_requests_decided_by_idx on public.booking_change_requests (decided_by) where decided_by is not null;
create index booking_change_requests_submitted_by_idx on public.booking_change_requests (submitted_by) where submitted_by is not null;
create index booking_change_requests_closed_by_idx on public.booking_change_requests (closed_by) where closed_by is not null;
comment on table public.booking_change_requests is
  'Accounts phase 3 (10.2, LD23): a change after a supplier confirmed, or (track H) adding or removing a service. One live request per Deal. Approved only by the branch Manager (G4). No table grant.';

create function authz.booking_change_requests_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'change requests cannot be deleted' using errcode = '42501';
  end if;
  if new.id <> old.id or new.legal_entity_id <> old.legal_entity_id or new.branch_id <> old.branch_id
     or new.deal_id <> old.deal_id or new.ref_no <> old.ref_no or new.kind <> old.kind
     or new.base_version_id <> old.base_version_id or new.requested_by <> old.requested_by
     or new.requested_at <> old.requested_at or new.request_id <> old.request_id or new.requested_as <> old.requested_as then
    raise exception 'change request identity is immutable' using errcode = '42501';
  end if;
  if old.status in ('applied', 'not_possible', 'withdrawn') then
    raise exception 'a finished change request is final' using errcode = '42501';
  end if;
  -- The request facts change only on resubmit (returned -> requested).
  if (new.change_summary, new.reason, new.removal_route, new.customer_charge_paise)
     is distinct from (old.change_summary, old.reason, old.removal_route, old.customer_charge_paise)
     and not (old.status = 'returned' and new.status = 'requested') then
    raise exception 'change request facts change only when it is sent again' using errcode = '42501';
  end if;
  -- Items: on resubmit, or (track H) items added to an approved add_service request.
  if new.item_ids is distinct from old.item_ids
     and not (old.status = 'returned' and new.status = 'requested')
     and not (old.kind = 'add_service' and old.status = 'approved' and new.status in ('approved', 'submitted')) then
    raise exception 'change request items change only when it is sent again' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'requested' and new.status in ('approved', 'returned', 'withdrawn'))
    or (old.status = 'returned' and new.status in ('requested', 'withdrawn'))
    or (old.status = 'approved' and new.status in ('submitted', 'withdrawn'))
    or (old.status = 'submitted' and new.status in ('applied', 'not_possible', 'withdrawn'))) then
    raise exception 'change request status cannot move this way' using errcode = '42501';
  end if;
  if old.change_version_id is not null and new.change_version_id is distinct from old.change_version_id then
    raise exception 'the change version of a request is fixed once opened' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger booking_change_requests_a_guard
  before update or delete on public.booking_change_requests
  for each row execute function authz.booking_change_requests_guard();

-- ===========================================================================
-- 6. Booking versions: the change version names its request
-- ===========================================================================

alter table public.booking_versions
  add column change_request_id uuid references public.booking_change_requests (id),
  add constraint booking_versions_change_request_revision check (change_request_id is null or revises_version_id is not null);
create index booking_versions_change_request_idx on public.booking_versions (change_request_id) where change_request_id is not null;
comment on column public.booking_versions.change_request_id is
  'Accounts phase 3 (10.2): the change request this revision belongs to (a change version). Confirmed only through the change flow (booking_confirm refuses it: use_change_flow).';

-- ===========================================================================
-- 7. Accounts review stands in (LD24)
-- ===========================================================================

alter table public.accounts_booking_reviews
  add column approval_source text not null default 'accounts' check (approval_source in ('accounts', 'change_request')),
  add column change_request_id uuid references public.booking_change_requests (id),
  add constraint accounts_booking_reviews_change_request_source
    check ((approval_source = 'change_request') = (change_request_id is not null));
create index accounts_booking_reviews_change_request_idx on public.accounts_booking_reviews (change_request_id)
  where change_request_id is not null;
comment on column public.accounts_booking_reviews.approval_source is
  'Accounts phase 3 (LD24): change_request = approved by the branch Manager''s approval of the change request (no Accounts step).';

-- ===========================================================================
-- 8. Cost history: several committed rows per task (one per confirmation)
-- ===========================================================================

alter table public.purchase_cost_versions
  add column confirmation_no integer not null default 1 check (confirmation_no >= 1),
  add column change_fee_paise bigint check (change_fee_paise between 0 and 999999999999);
comment on column public.purchase_cost_versions.confirmation_no is
  'Accounts phase 3 (10.2): the supplier confirmation a row belongs to (1 = first confirmation; +1 per reconfirmation).';
comment on column public.purchase_cost_versions.change_fee_paise is
  'Accounts phase 3 (LD25): the supplier change or cancellation fee included in amount_paise (shown apart).';
drop index public.purchase_cost_versions_one_committed;
create unique index purchase_cost_versions_one_committed on public.purchase_cost_versions (task_id, confirmation_no)
  where stage = 'committed';

-- ===========================================================================
-- 4. Confirmation history (append-only)
-- ===========================================================================

create table public.task_confirmations (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  task_id uuid not null,
  confirmation_no integer not null check (confirmation_no >= 1),
  quote_id uuid not null,
  committed_version_no integer not null,
  amount_paise bigint not null check (amount_paise > 0),
  change_fee_paise bigint check (change_fee_paise >= 0),
  supplier_reference text not null check (length(supplier_reference) between 1 and 120),
  evidence_ids uuid[] not null default '{}'::uuid[],
  booking_version_id uuid not null references public.booking_versions (id),
  change_request_id uuid references public.booking_change_requests (id),
  confirmed_by uuid not null references public.staff_profiles (user_id),
  confirmed_at timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (task_id, quote_id) references public.purchase_quotes (task_id, id),
  foreign key (task_id, committed_version_no) references public.purchase_cost_versions (task_id, version_no),
  unique (task_id, confirmation_no)
);
create index task_confirmations_entity_task_idx on public.task_confirmations (legal_entity_id, task_id);
create index task_confirmations_booking_version_idx on public.task_confirmations (booking_version_id);
create index task_confirmations_change_request_idx on public.task_confirmations (change_request_id) where change_request_id is not null;
create index task_confirmations_confirmed_by_idx on public.task_confirmations (confirmed_by);
create index task_confirmations_cost_idx on public.task_confirmations (task_id, committed_version_no);
create index task_confirmations_quote_idx on public.task_confirmations (task_id, quote_id);
comment on table public.task_confirmations is
  'Accounts phase 3 (10.2): every supplier confirmation of a task, in order (1 = first confirmation, +1 per applied reconfirmation). Append-only. No table grant.';
create trigger task_confirmations_a_append_only
  before update or delete on public.task_confirmations
  for each row execute function authz.procurement_append_only();

-- Confirmation 1 for every task supplier-confirmed today (task row + committed cost).
insert into public.task_confirmations (legal_entity_id, task_id, confirmation_no, quote_id, committed_version_no, amount_paise,
  supplier_reference, evidence_ids, booking_version_id, confirmed_by, confirmed_at)
select t.legal_entity_id, t.id, 1, c.quote_id, c.version_no, c.amount_paise, t.supplier_reference,
  coalesce((select array_agg(e.id order by e.created_at, e.id) from public.purchase_evidence e
            where e.task_id = t.id and e.kind = 'supplier_confirmation' and e.status = 'stored'), '{}'::uuid[]),
  authz.task_current_version(t.id), t.supplier_confirmed_by, t.supplier_confirmed_at
from public.fulfilment_tasks t
cross join lateral (select x.* from public.purchase_cost_versions x
                    where x.task_id = t.id and x.stage = 'committed' order by x.version_no desc limit 1) c
where t.status = 'supplier_confirmed'
order by t.id;

-- ===========================================================================
-- 5. Reconfirmations (LD25)
-- ===========================================================================

create table public.task_reconfirmations (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  change_request_id uuid not null,
  task_id uuid not null,
  -- The change version.
  booking_version_id uuid not null references public.booking_versions (id),
  status text not null default 'pending' check (status in ('pending', 'recorded', 'refused', 'applied', 'void')),
  new_rate_paise bigint check (new_rate_paise between 1 and 999999999999),
  supplier_fee_paise bigint check (supplier_fee_paise between 0 and 999999999999),
  new_reference text check (length(new_reference) between 1 and 120 and new_reference !~ '[[:cntrl:]]'),
  evidence_id uuid references public.purchase_evidence (id),
  budget_paise bigint,
  over_budget boolean not null default false,
  over_budget_approved_by uuid references public.staff_profiles (user_id),
  over_budget_approved_at timestamptz,
  refused_reason text check (refused_reason is null or length(refused_reason) between 10 and 500),
  note text check (note is null or length(note) between 1 and 500),
  recorded_by uuid references public.staff_profiles (user_id),
  recorded_at timestamptz,
  request_id uuid,
  row_version integer not null default 1 check (row_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, change_request_id) references public.booking_change_requests (legal_entity_id, id),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  unique (change_request_id, task_id),
  check (status not in ('recorded', 'applied')
         or (new_rate_paise is not null and supplier_fee_paise is not null and new_reference is not null
             and evidence_id is not null and recorded_by is not null and recorded_at is not null)),
  check (status <> 'refused' or refused_reason is not null),
  check ((over_budget_approved_by is null) = (over_budget_approved_at is null)),
  check (over_budget_approved_by is null or over_budget),
  check (over_budget_approved_by is null or over_budget_approved_by is distinct from recorded_by)
);
create unique index task_reconfirmations_evidence_key on public.task_reconfirmations (evidence_id) where evidence_id is not null;
create index task_reconfirmations_task_idx on public.task_reconfirmations (task_id, status);
create index task_reconfirmations_entity_task_idx on public.task_reconfirmations (legal_entity_id, task_id);
create index task_reconfirmations_request_idx on public.task_reconfirmations (legal_entity_id, change_request_id);
create index task_reconfirmations_version_idx on public.task_reconfirmations (booking_version_id);
create index task_reconfirmations_recorded_by_idx on public.task_reconfirmations (recorded_by) where recorded_by is not null;
create index task_reconfirmations_approved_by_idx on public.task_reconfirmations (over_budget_approved_by)
  where over_budget_approved_by is not null;
comment on table public.task_reconfirmations is
  'Accounts phase 3 (10.2, LD25): the supplier reconfirmation of one changed Purchase service. The new rate, fee, reference and proof wait here; the task, its costs and its confirmation are untouched until the change is applied. No table grant.';

create function authz.task_reconfirmations_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'reconfirmations cannot be deleted' using errcode = '42501';
  end if;
  if new.id <> old.id or new.legal_entity_id <> old.legal_entity_id or new.change_request_id <> old.change_request_id
     or new.task_id <> old.task_id or new.booking_version_id <> old.booking_version_id or new.created_at <> old.created_at then
    raise exception 'reconfirmation identity is immutable' using errcode = '42501';
  end if;
  if old.status in ('refused', 'applied', 'void') then
    raise exception 'a finished reconfirmation is final' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'pending' and new.status in ('recorded', 'refused', 'void'))
    or (old.status = 'recorded' and new.status in ('applied', 'refused', 'void'))) then
    raise exception 'reconfirmation status cannot move this way' using errcode = '42501';
  end if;
  -- What the supplier said is recorded once (pending -> recorded).
  if old.status = 'recorded'
     and (new.new_rate_paise, new.supplier_fee_paise, new.new_reference, new.evidence_id, new.budget_paise, new.over_budget,
          new.note, new.recorded_by, new.recorded_at, new.request_id)
         is distinct from (old.new_rate_paise, old.supplier_fee_paise, old.new_reference, old.evidence_id, old.budget_paise,
          old.over_budget, old.note, old.recorded_by, old.recorded_at, old.request_id) then
    raise exception 'a recorded reconfirmation keeps what the supplier said' using errcode = '42501';
  end if;
  if old.over_budget_approved_by is not null
     and (new.over_budget_approved_by, new.over_budget_approved_at) is distinct from (old.over_budget_approved_by, old.over_budget_approved_at) then
    raise exception 'an over-budget approval is given once' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger task_reconfirmations_a_guard
  before update or delete on public.task_reconfirmations
  for each row execute function authz.task_reconfirmations_guard();

-- The supplier's reconfirmation proof names its reconfirmation (Addendum L5;
-- set only by purchase_evidence_begin, 20261205000670; immutable by the guard).
alter table public.purchase_evidence
  add column reconfirmation_id uuid references public.task_reconfirmations (id);
create index purchase_evidence_reconfirmation_idx on public.purchase_evidence (reconfirmation_id)
  where reconfirmation_id is not null;

-- ===========================================================================
-- 9. Cost approvals name their reconfirmation
-- ===========================================================================

alter table public.purchase_cost_approvals
  add constraint purchase_cost_approvals_reconfirmation_fk
  foreign key (reconfirmation_id) references public.task_reconfirmations (id);
create index purchase_cost_approvals_reconfirmation_idx on public.purchase_cost_approvals (reconfirmation_id)
  where reconfirmation_id is not null;

-- ===========================================================================
-- 10. Supplier refunds after a lower rate (LD29)
-- ===========================================================================

alter table public.supplier_refund_receipts
  alter column cancellation_id drop not null,
  add column change_request_id uuid references public.booking_change_requests (id);
do $$
declare
  c record;
begin
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.supplier_refund_receipts'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%purchase_charge%'
  loop
    execute format('alter table public.supplier_refund_receipts drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table public.supplier_refund_receipts
  add constraint supplier_refund_receipts_source_kind_check
    check (source_kind in ('purchase_charge', 'flight_charge', 'visa_fee', 'reconfirmation')),
  add constraint supplier_refund_receipts_one_case
    check ((cancellation_id is null) <> (change_request_id is null)),
  add constraint supplier_refund_receipts_reconfirmation_case
    check (source_kind <> 'reconfirmation' or change_request_id is not null);
create index supplier_refund_receipts_change_request_idx on public.supplier_refund_receipts (change_request_id)
  where change_request_id is not null;

-- ===========================================================================
-- Row level security and grants
-- ===========================================================================

do $$
declare
  t text;
begin
  foreach t in array array['booking_change_settings', 'booking_change_counters', 'booking_change_requests',
                           'task_confirmations', 'task_reconfirmations'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

revoke all on function authz.booking_change_settings_guard(), authz.booking_change_requests_guard(),
  authz.task_reconfirmations_guard()
from public, anon, authenticated, service_role;

commit;
