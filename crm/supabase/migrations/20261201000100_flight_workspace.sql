-- TripNavigate CRM - Flight build, track A (1 of 4): Flight workspace schema
-- and shared helpers.
-- Contract: Flight department build contract (frozen 4 November 2026),
-- sections 4, 5.1, 5.3, 7 and 8; owner decisions D1, D5-D8, D10 and D11.
--
-- What this file adds:
--   1. fulfilment_tasks: fulfilment_tasks_completed_visa_only is replaced by
--      fulfilment_tasks_completed_department (completed allowed for visa and
--      flight). Flight never uses supplier_confirmed (commands never set it).
--   2. Tables (definer functions only; RLS on, restrictive session policy,
--      no grants; DELETE refused everywhere):
--        flight_task_state         one per flight task once taken (basis version)
--        flight_changes            alternatives, added sectors, passenger itineraries
--        flight_sectors            the working itinerary per task
--        flight_sector_passengers  who flies on which sector (end once, holds)
--        flight_ticket_revisions   append-only ticket details per passenger and sector
--        flight_ticket_numbers     ticket number registry (uniqueness per entity)
--      batch_id on flight_ticket_revisions has no foreign key here; track B
--      adds it to flight_ticket_batches in its own migration.
--   3. Helpers (authz, revoked from every API role): flight_lock_group,
--      flight_gate_issue, flight_can_work, flight_deal_kind,
--      flight_is_sales_owner, flight_task_budget, flight_unnamed_count,
--      flight_ticket_counts, flight_ticket_fields_issue,
--      flight_register_ticket_number, flight_insert_ticket_revision,
--      flight_money_issues (stub returning '{}'; track B replaces it),
--      flight_done_issues, flight_booking_diff, flight_build_sectors,
--      flight_replay / flight_remember and small normalizers.
--
-- Guards check the transaction-local setting authz.flight_transition
-- (screenshot_save | fill_blanks | booking_apply | change_decide) that the
-- commands set before they move a sector or the task state.
--
-- Refusal tokens raised by helpers here (message is exactly the token):
--   55000 environment_unset, deal_removed | 40001 duplicate_request |
--   23505 ticket_number_taken | 22023 invalid_input (hint = field) |
--   P0002 not_found.
--
-- Rollback (forward-only): a new migration restoring
-- fulfilment_tasks_completed_visa_only (only while no flight task is
-- completed) and revoking the track A commands. Flight rows are never deleted.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Task completion for flights (D10)
-- ===========================================================================

alter table public.fulfilment_tasks
  drop constraint fulfilment_tasks_completed_visa_only,
  add constraint fulfilment_tasks_completed_department check (status <> 'completed' or department in ('visa', 'flight'));

-- ===========================================================================
-- 2. Tables
-- ===========================================================================

create table public.flight_task_state (
  task_id uuid primary key,
  legal_entity_id uuid not null,
  deal_id uuid not null,
  service_item_id uuid not null,
  -- The booking version the itinerary currently reflects. "Booking changed" =
  -- basis_version_id <> authz.task_current_version(task_id).
  basis_version_id uuid not null,
  built_at timestamptz not null default now(),
  built_by uuid not null references public.staff_profiles (user_id),
  row_version integer not null default 1 check (row_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  foreign key (legal_entity_id, service_item_id) references public.service_items (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id, basis_version_id) references public.booking_versions (legal_entity_id, deal_id, id)
);
create index flight_task_state_deal_idx on public.flight_task_state (deal_id);
create index flight_task_state_item_idx on public.flight_task_state (service_item_id);
create index flight_task_state_basis_idx on public.flight_task_state (basis_version_id);
create index flight_task_state_built_by_idx on public.flight_task_state (built_by);
comment on table public.flight_task_state is
  'Flight build: one row per flight task once taken. basis_version_id is the booking version the working itinerary reflects; only flight_booking_change_apply moves it. No table grant.';

-- Seqs of a change: 1..100 each, distinct, at least one.
create function authz.flight_seqs_ok(p_seqs integer[]) returns boolean
language sql immutable set search_path = '' as $$
  select p_seqs is not null and cardinality(p_seqs) between 1 and 100
    and not exists (select 1 from unnest(p_seqs) s where s is null or s not between 1 and 100)
    and (select count(distinct s) from unnest(p_seqs) s) = cardinality(p_seqs)
$$;

create table public.flight_changes (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  deal_id uuid not null,
  task_id uuid not null,
  service_item_id uuid not null,
  change_no integer not null check (change_no >= 1),
  kind text not null check (kind in ('alternative', 'added_instead', 'added_extra', 'passenger_itinerary')),
  basis_version_id uuid not null,
  deal_kind text not null check (deal_kind in ('package', 'flight_only')),
  decider_kind text not null check (decider_kind in ('sales_owner', 'branch_manager', 'flight_owner')),
  from_sector_ids uuid[] not null,
  traveller_seqs integer[] not null check (authz.flight_seqs_ok(traveller_seqs)),
  remark text not null check (length(remark) between 3 and 300),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn', 'superseded')),
  requested_by uuid not null references public.staff_profiles (user_id),
  requested_at timestamptz not null default now(),
  decided_by uuid references public.staff_profiles (user_id),
  decided_at timestamptz,
  reject_reason text check (reject_reason is null or length(reject_reason) between 10 and 500),
  ended_by uuid references public.staff_profiles (user_id),
  ended_at timestamptz,
  flight_seen_at timestamptz,
  request_id uuid not null,
  row_version integer not null default 1 check (row_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, branch_id, deal_id) references public.deals (legal_entity_id, branch_id, id),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (legal_entity_id, service_item_id) references public.service_items (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id, basis_version_id) references public.booking_versions (legal_entity_id, deal_id, id),
  unique (deal_id, change_no),
  unique (legal_entity_id, request_id),
  unique (task_id, id),
  check (case kind
           when 'alternative' then cardinality(from_sector_ids) = 1
           when 'added_instead' then cardinality(from_sector_ids) between 1 and 8
           when 'added_extra' then cardinality(from_sector_ids) = 0
           else cardinality(from_sector_ids) between 0 and 40 end),
  check (kind <> 'passenger_itinerary' or cardinality(traveller_seqs) = 1),
  check ((status in ('approved', 'rejected')) = (decided_by is not null and decided_at is not null)),
  check ((status = 'rejected') = (reject_reason is not null)),
  check ((status in ('withdrawn', 'superseded')) = (ended_at is not null)),
  check ((decider_kind = 'flight_owner') = (deal_kind = 'flight_only')),
  check (decider_kind = 'flight_owner' or decided_by is distinct from requested_by),
  check (flight_seen_at is null or status in ('approved', 'rejected'))
);
create index flight_changes_task_idx on public.flight_changes (task_id, status);
create index flight_changes_deal_idx on public.flight_changes (deal_id, status);
create index flight_changes_item_idx on public.flight_changes (service_item_id);
create index flight_changes_basis_idx on public.flight_changes (basis_version_id);
create index flight_changes_requested_by_idx on public.flight_changes (requested_by);
create index flight_changes_decided_by_idx on public.flight_changes (decided_by) where decided_by is not null;
create index flight_changes_ended_by_idx on public.flight_changes (ended_by) where ended_by is not null;
comment on table public.flight_changes is
  'Flight build (D5): an alternative, an added sector (instead of / extra) or a passenger itinerary with its passenger choice and decision. Package Deals: the Sales owner (fallback branch Manager) decides; flight-only Deals: the Flight task owner (owner-approved exception). Bound to the basis booking version; no booking version is created. No table grant.';

create table public.flight_sectors (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  deal_id uuid not null,
  task_id uuid not null,
  service_item_id uuid not null,
  origin text not null check (origin in ('booking', 'screenshot', 'change')),
  basis_version_id uuid not null,
  booking_leg_no smallint check (booking_leg_no between 1 and 8),
  change_id uuid,
  from_place text not null check (authz.b11_place_ok(to_jsonb(from_place)) and (from_place !~ '^[A-Za-z]{3}$' or from_place ~ '^[A-Z]{3}$')),
  to_place text not null check (authz.b11_place_ok(to_jsonb(to_place)) and (to_place !~ '^[A-Za-z]{3}$' or to_place ~ '^[A-Z]{3}$')),
  depart_date date not null,
  depart_time text check (depart_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  arrive_date date,
  arrive_time text check (arrive_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  airline text check (length(airline) between 1 and 60),
  flight_no text check (flight_no ~ '^[A-Z0-9 -]{1,12}$' and flight_no !~ '  ' and flight_no = btrim(flight_no)),
  cabin text check (length(cabin) between 1 and 40),
  status text not null check (status in ('active', 'pending', 'rejected', 'withdrawn', 'superseded', 'booking_removed')),
  ended_at timestamptz,
  ended_by uuid references public.staff_profiles (user_id),
  created_by uuid not null references public.staff_profiles (user_id),
  row_version integer not null default 1 check (row_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, branch_id, deal_id) references public.deals (legal_entity_id, branch_id, id),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (legal_entity_id, service_item_id) references public.service_items (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id, basis_version_id) references public.booking_versions (legal_entity_id, deal_id, id),
  foreign key (task_id, change_id) references public.flight_changes (task_id, id),
  unique (task_id, id),
  check ((origin = 'booking') = (booking_leg_no is not null)),
  check ((origin = 'change') = (change_id is not null)),
  -- Booking legs are copied as Sales typed them (validated by the booking form).
  check (origin = 'booking' or lower(from_place) <> lower(to_place)),
  check (arrive_date is null or arrive_date >= depart_date),
  check (origin = 'change' or status <> 'pending'),
  check ((status in ('active', 'pending')) = (ended_at is null))
);
create unique index flight_sectors_booking_leg_key on public.flight_sectors (task_id, basis_version_id, booking_leg_no)
  where origin = 'booking' and status = 'active';
create index flight_sectors_task_idx on public.flight_sectors (task_id, status);
create index flight_sectors_deal_idx on public.flight_sectors (deal_id);
create index flight_sectors_item_idx on public.flight_sectors (service_item_id);
create index flight_sectors_basis_idx on public.flight_sectors (basis_version_id);
create index flight_sectors_change_idx on public.flight_sectors (change_id) where change_id is not null;
create index flight_sectors_created_by_idx on public.flight_sectors (created_by);
create index flight_sectors_ended_by_idx on public.flight_sectors (ended_by) where ended_by is not null;
comment on table public.flight_sectors is
  'Flight build: the working itinerary of a flight task (booking legs, sectors typed from a screenshot, sectors of a change). Rows are never deleted; status moves and field updates follow authz.flight_sectors_guard. No table grant.';

create table public.flight_sector_passengers (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  deal_id uuid not null,
  task_id uuid not null,
  sector_id uuid not null,
  traveller_seq integer not null check (traveller_seq between 1 and 100),
  added_by_change_id uuid,
  held_by_change_id uuid,
  ended_at timestamptz,
  ended_by uuid references public.staff_profiles (user_id),
  ended_by_change_id uuid,
  ended_reason text check (ended_reason in ('change_approved', 'change_rejected', 'change_withdrawn', 'change_superseded',
                                            'booking_changed', 'traveller_removed', 'screenshot_replaced')),
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (task_id, sector_id) references public.flight_sectors (task_id, id),
  foreign key (task_id, added_by_change_id) references public.flight_changes (task_id, id),
  foreign key (task_id, held_by_change_id) references public.flight_changes (task_id, id),
  foreign key (task_id, ended_by_change_id) references public.flight_changes (task_id, id),
  check ((ended_at is null) = (ended_reason is null)),
  check (held_by_change_id is null or ended_at is null)
);
create unique index flight_sector_passengers_current_key on public.flight_sector_passengers (sector_id, traveller_seq)
  where ended_at is null;
create index flight_sector_passengers_task_idx on public.flight_sector_passengers (task_id, traveller_seq);
create index flight_sector_passengers_deal_idx on public.flight_sector_passengers (deal_id);
create index flight_sector_passengers_sector_idx on public.flight_sector_passengers (sector_id);
create index flight_sector_passengers_added_idx on public.flight_sector_passengers (added_by_change_id) where added_by_change_id is not null;
create index flight_sector_passengers_held_idx on public.flight_sector_passengers (held_by_change_id) where held_by_change_id is not null;
create index flight_sector_passengers_ended_change_idx on public.flight_sector_passengers (ended_by_change_id) where ended_by_change_id is not null;
create index flight_sector_passengers_created_by_idx on public.flight_sector_passengers (created_by);
create index flight_sector_passengers_ended_by_idx on public.flight_sector_passengers (ended_by) where ended_by is not null;
comment on table public.flight_sector_passengers is
  'Flight build (D7): a Deal traveller (by seq) on a flight sector. Current = ended_at is null; held = a pending change will move this passenger. Ends once with a reason; never deleted. No table grant.';

create table public.flight_ticket_revisions (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  deal_id uuid not null,
  task_id uuid not null,
  sector_id uuid not null,
  traveller_seq integer not null check (traveller_seq between 1 and 100),
  revision_no integer not null check (revision_no >= 1),
  -- Foreign key to flight_ticket_batches added by track B.
  batch_id uuid not null,
  traveller_name text not null check (length(traveller_name) between 1 and 120),
  traveller_type text not null check (traveller_type in ('adult', 'child', 'infant')),
  crs_type text not null check (crs_type in ('amadeus', 'galileo', 'sabre', 'airline_direct', 'other')),
  crs_pnr text check (crs_pnr ~ '^[A-Z0-9]{5,8}$'),
  airline_pnr text not null check (airline_pnr ~ '^[A-Z0-9]{5,8}$'),
  ticket_number text not null check (ticket_number ~ '^[0-9][0-9-]{4,18}[0-9]$' and ticket_number !~ '--'),
  ticket_digits text generated always as (replace(ticket_number, '-', '')) stored,
  reason text check (length(reason) between 10 and 300),
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  request_id uuid not null,
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (task_id, sector_id) references public.flight_sectors (task_id, id),
  unique (sector_id, traveller_seq, revision_no),
  unique (legal_entity_id, request_id, sector_id, traveller_seq),
  check ((crs_type = 'airline_direct') = (crs_pnr is null)),
  check ((revision_no = 1) = (reason is null)),
  check (ticket_digits ~ '^[0-9]{6,20}$')
);
create index flight_ticket_revisions_task_idx on public.flight_ticket_revisions (task_id);
create index flight_ticket_revisions_deal_idx on public.flight_ticket_revisions (deal_id);
create index flight_ticket_revisions_batch_idx on public.flight_ticket_revisions (batch_id);
create index flight_ticket_revisions_created_by_idx on public.flight_ticket_revisions (created_by);
comment on table public.flight_ticket_revisions is
  'Flight build (D8, D13): confirmed ticket details per passenger and sector, append-only. The current ticket of a pair is the highest revision_no; corrections add a revision with a reason. These are the stored details a later customer invoice reads. No table grant.';

create table public.flight_ticket_numbers (
  legal_entity_id uuid not null references public.legal_entities (id),
  ticket_digits text not null check (ticket_digits ~ '^[0-9]{6,20}$'),
  deal_id uuid not null,
  traveller_seq integer not null check (traveller_seq between 1 and 100),
  first_revision_id uuid not null references public.flight_ticket_revisions (id),
  created_at timestamptz not null default now(),
  primary key (legal_entity_id, ticket_digits),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id)
);
create index flight_ticket_numbers_deal_idx on public.flight_ticket_numbers (deal_id);
create index flight_ticket_numbers_revision_idx on public.flight_ticket_numbers (first_revision_id);
comment on table public.flight_ticket_numbers is
  'Flight build (D8): ticket number registry. A number belongs to one (Deal, traveller) within the entity for ever (also after a correction). Insert-only. No table grant.';

-- ===========================================================================
-- 3. Guards
-- ===========================================================================

create function authz.flight_transition() returns text
language sql stable set search_path = '' as $$
  select coalesce(current_setting('authz.flight_transition', true), '')
$$;

create function authz.flight_task_state_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'flight task state cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['basis_version_id', 'row_version', 'updated_at'])
       is distinct from (to_jsonb(old) - array['basis_version_id', 'row_version', 'updated_at'])
     or (new.basis_version_id is distinct from old.basis_version_id and authz.flight_transition() <> 'booking_apply')
     or authz.flight_transition() not in ('booking_apply', 'screenshot_save') then
    raise exception 'flight task state moves only through the booking change command' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger flight_task_state_a_guard
  before update or delete on public.flight_task_state
  for each row execute function authz.flight_task_state_guard();

create function authz.flight_changes_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_decision text[] := array['status', 'decided_by', 'decided_at', 'reject_reason', 'ended_by', 'ended_at',
                             'flight_seen_at', 'row_version', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    raise exception 'flight changes cannot be deleted' using errcode = '42501';
  end if;
  if old.status = 'pending' then
    if new.status = 'pending' or (to_jsonb(new) - v_decision) is distinct from (to_jsonb(old) - v_decision) then
      raise exception 'a flight change is decided once; its facts are immutable' using errcode = '42501';
    end if;
  elsif old.status in ('approved', 'rejected') then
    if (to_jsonb(new) - array['flight_seen_at', 'updated_at']) is distinct from (to_jsonb(old) - array['flight_seen_at', 'updated_at'])
       or old.flight_seen_at is not null or new.flight_seen_at is null then
      raise exception 'a decided flight change only records that Flight saw the decision' using errcode = '42501';
    end if;
  else
    raise exception 'a withdrawn or superseded flight change is final' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger flight_changes_a_guard
  before update or delete on public.flight_changes
  for each row execute function authz.flight_changes_guard();

create function authz.flight_sectors_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_tr text := authz.flight_transition();
  v_fields text[] := array['from_place', 'to_place', 'depart_date', 'depart_time', 'arrive_date', 'arrive_time',
                           'airline', 'flight_no', 'cabin'];
  v_movable text[] := array['from_place', 'to_place', 'depart_date', 'depart_time', 'arrive_date', 'arrive_time',
                            'airline', 'flight_no', 'cabin', 'basis_version_id', 'booking_leg_no', 'status',
                            'ended_at', 'ended_by', 'row_version', 'updated_at'];
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
  f text;
begin
  if tg_op = 'DELETE' then
    raise exception 'flight sectors cannot be deleted' using errcode = '42501';
  end if;
  if (v_new - v_movable) is distinct from (v_old - v_movable) then
    raise exception 'flight sector identity is immutable' using errcode = '42501';
  end if;
  if new.status is distinct from old.status then
    if not ((old.status = 'pending' and new.status in ('active', 'rejected', 'withdrawn', 'superseded')
             and v_tr in ('change_decide', 'booking_apply'))
         or (old.status = 'active' and new.status = 'booking_removed' and v_tr = 'booking_apply')
         or (old.status = 'active' and new.status = 'withdrawn' and old.origin = 'screenshot' and v_tr = 'screenshot_save')) then
      raise exception 'flight sector status cannot move this way' using errcode = '42501';
    end if;
  elsif new.ended_at is distinct from old.ended_at or new.ended_by is distinct from old.ended_by then
    raise exception 'flight sector end is set with its status' using errcode = '42501';
  end if;
  if (new.basis_version_id, new.booking_leg_no) is distinct from (old.basis_version_id, old.booking_leg_no)
     and (v_tr <> 'booking_apply' or old.status <> 'active' or old.origin <> 'booking') then
    raise exception 'flight sector basis moves only when a booking change is applied' using errcode = '42501';
  end if;
  foreach f in array v_fields loop
    if v_new -> f is distinct from v_old -> f then
      if v_tr = 'screenshot_save' and old.origin = 'screenshot' and old.status = 'active'
         and not exists (select 1 from public.flight_ticket_revisions r where r.sector_id = old.id) then
        continue;
      end if;
      if v_tr = 'fill_blanks' and old.origin in ('booking', 'screenshot') and old.status = 'active'
         and coalesce(jsonb_typeof(v_old -> f), 'null') = 'null'
         and f in ('airline', 'flight_no', 'depart_time', 'arrive_time', 'arrive_date') then
        continue;
      end if;
      raise exception 'flight sector details change only through an alternative' using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;
create trigger flight_sectors_a_guard
  before update or delete on public.flight_sectors
  for each row execute function authz.flight_sectors_guard();

create function authz.flight_sector_passengers_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_end text[] := array['ended_at', 'ended_by', 'ended_by_change_id', 'ended_reason', 'held_by_change_id'];
begin
  if tg_op = 'DELETE' then
    raise exception 'flight passengers cannot be deleted' using errcode = '42501';
  end if;
  if old.ended_at is not null
     or (to_jsonb(new) - v_end) is distinct from (to_jsonb(old) - v_end)
     or (new.ended_at is null and (new.ended_by, new.ended_by_change_id, new.ended_reason)
                                  is distinct from (old.ended_by, old.ended_by_change_id, old.ended_reason)) then
    raise exception 'a flight passenger row only changes its hold or ends once' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger flight_sector_passengers_a_guard
  before update or delete on public.flight_sector_passengers
  for each row execute function authz.flight_sector_passengers_guard();

create function authz.flight_append_only() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception '% rows are append-only', tg_table_name using errcode = '42501';
end;
$$;
create trigger flight_ticket_revisions_a_append_only
  before update or delete on public.flight_ticket_revisions
  for each row execute function authz.flight_append_only();
create trigger flight_ticket_numbers_a_append_only
  before update or delete on public.flight_ticket_numbers
  for each row execute function authz.flight_append_only();

-- ===========================================================================
-- 4. Row level security: definer functions only
-- ===========================================================================

alter table public.flight_task_state enable row level security;
alter table public.flight_changes enable row level security;
alter table public.flight_sectors enable row level security;
alter table public.flight_sector_passengers enable row level security;
alter table public.flight_ticket_revisions enable row level security;
alter table public.flight_ticket_numbers enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['flight_task_state', 'flight_changes', 'flight_sectors', 'flight_sector_passengers',
                           'flight_ticket_revisions', 'flight_ticket_numbers'] loop
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
  end loop;
end;
$$;

revoke all on public.flight_task_state, public.flight_changes, public.flight_sectors, public.flight_sector_passengers,
  public.flight_ticket_revisions, public.flight_ticket_numbers
from public, anon, authenticated, service_role;

-- ===========================================================================
-- 5. Helpers
-- ===========================================================================

-- Group lock (contract 5.3): every flight task of the Deal FOR UPDATE in id
-- order, then the Deal FOR KEY SHARE. Money commands take
-- authz.finance_lock_deal first.
create function authz.flight_lock_group(p_deal uuid) returns setof public.fulfilment_tasks
language plpgsql volatile security definer set search_path = '' as $$
begin
  return query
    select t.* from public.fulfilment_tasks t
    where t.deal_id = p_deal and t.department = 'flight'
    order by t.id
    for update;
  perform 1 from public.deals d where d.id = p_deal for key share;
end;
$$;

create function authz.flight_gate_issue(p_deal uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when authz.deployment_environment() = 'unset' then 'environment_unset'
    when exists (select 1 from public.deals d where d.id = p_deal and d.removed_at is not null) then 'deal_removed'
    else null end
$$;

create function authz.flight_refuse_gate(p_deal uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_issue text := authz.flight_gate_issue(p_deal);
begin
  if v_issue is not null then
    raise exception '%', v_issue using errcode = '55000';
  end if;
end;
$$;

-- The caller holds the active Flight role in the Deal's entity and is the
-- assignee of every in_progress flight task of the Deal (at least one).
create function authz.flight_can_work(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false)
    and exists (select 1 from public.deals d where d.id = p_deal and authz.holds_active_role('flight', d.legal_entity_id))
    and exists (select 1 from public.fulfilment_tasks t
                where t.deal_id = p_deal and t.department = 'flight' and t.status = 'in_progress')
    and not exists (select 1 from public.fulfilment_tasks t
                    where t.deal_id = p_deal and t.department = 'flight' and t.status = 'in_progress'
                      and t.assignee_user_id is distinct from (select auth.uid()))
$$;

-- Contract section 4 (L2): package when the current version came from a
-- quotation or the Deal has a hotel, transfer or activity item in it.
create function authz.flight_deal_kind(p_deal uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when v.source_quotation_version_id is not null or exists (
           select 1 from public.service_items i
           join public.service_item_facts f on f.service_item_id = i.id and f.booking_version_id = v.id
           where i.deal_id = p_deal and i.service_type in ('hotel', 'transfer', 'activity'))
         then 'package' else 'flight_only' end
  from (select authz.task_current_version(t.id) as vid
        from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
        where t.deal_id = p_deal and t.department = 'flight'
        order by i.item_no, t.id limit 1) x
  join public.booking_versions v on v.id = x.vid
$$;

create function authz.flight_is_sales_owner(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select d.owner_user_id = (select auth.uid())
       and authz.holds_active_role('sales', d.legal_entity_id)
       and not authz.holds_role('flight', d.legal_entity_id)
    from public.deals d where d.id = p_deal), false)
$$;

-- L3: the Deal has an owner who still holds an active Sales role.
create function authz.flight_has_active_sales_owner(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.deals d
                 where d.id = p_deal and authz.is_active_department_person(d.owner_user_id, d.legal_entity_id, 'sales'))
$$;

-- Who may decide a change (contract section 4, L3, D5).
create function authz.flight_can_decide_change(p_change uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and coalesce((
    select case c.decider_kind
      when 'flight_owner' then t.assignee_user_id = (select auth.uid()) and t.status = 'in_progress'
                               and authz.holds_active_role('flight', c.legal_entity_id)
      when 'sales_owner' then authz.flight_is_sales_owner(c.deal_id)
                              or (not authz.flight_has_active_sales_owner(c.deal_id)
                                  and authz.is_branch_sales_manager(c.deal_id)
                                  and not authz.holds_role('flight', c.legal_entity_id))
      when 'branch_manager' then authz.is_branch_sales_manager(c.deal_id) and not authz.holds_role('flight', c.legal_entity_id)
    end
    from public.flight_changes c join public.fulfilment_tasks t on t.id = c.task_id
    where c.id = p_change), false)
$$;

-- Contract section 4 (L4): the typed item budget when > 0, else the Sales fare
-- estimate per participant type, else none.
create function authz.flight_task_budget(p_task uuid) returns table(budget_paise bigint, source text)
language sql stable security definer set search_path = '' as $$
  with x as (
    select t.id, t.service_item_id, authz.task_current_version(t.id) as vid, authz.task_budget(t.id) as typed
    from public.fulfilment_tasks t where t.id = p_task and t.department = 'flight'
  ), est as (
    select sum(case s.traveller_type when 'adult' then fa when 'child' then fc else fi end)::bigint as total,
           count(case s.traveller_type when 'adult' then fa when 'child' then fc else fi end)::integer as n
    from x
    join public.booking_version_travellers s on s.booking_version_id = x.vid
    left join public.service_item_cost_estimates ce on ce.booking_version_id = x.vid and ce.service_item_id = x.service_item_id
    left join public.booking_version_flight_fares vf on vf.booking_version_id = x.vid
    cross join lateral (
      select case when coalesce(ce.fare_adult_paise, ce.fare_child_paise, ce.fare_infant_paise) is not null
                  then ce.fare_adult_paise else vf.adult_paise end as fa,
             case when coalesce(ce.fare_adult_paise, ce.fare_child_paise, ce.fare_infant_paise) is not null
                  then ce.fare_child_paise else vf.child_paise end as fc,
             case when coalesce(ce.fare_adult_paise, ce.fare_child_paise, ce.fare_infant_paise) is not null
                  then ce.fare_infant_paise else vf.infant_paise end as fi) f
    where s.seq = any (authz.item_participant_seqs(x.service_item_id, x.vid))
  )
  select case when x.typed > 0 then x.typed when coalesce(est.n, 0) > 0 then est.total end,
         case when x.typed > 0 then 'typed' when coalesce(est.n, 0) > 0 then 'estimate' else 'none' end
  from x left join est on true
$$;

-- Contract section 4 (L6).
create function authz.flight_unnamed_count(p_task uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select greatest(0, case
      when coalesce(f.facts ->> 'entryMode', 'typed') <> 'screenshot' then
        coalesce(case when jsonb_typeof(f.facts -> 'passengers') = 'number' then (f.facts ->> 'passengers')::integer end,
                 v.pax_total, cardinality(p.seqs))
      when p.seqs = coalesce((select array_agg(s.seq order by s.seq) from public.booking_version_travellers s
                              where s.booking_version_id = v.id), '{}'::integer[])
        then coalesce(v.pax_total, cardinality(p.seqs))
      else cardinality(p.seqs) end - cardinality(p.seqs))
  from public.fulfilment_tasks t
  join public.booking_versions v on v.id = authz.task_current_version(t.id)
  left join public.service_item_facts f on f.service_item_id = t.service_item_id and f.booking_version_id = v.id
  cross join lateral (select authz.item_participant_seqs(t.service_item_id, v.id) as seqs) p
  where t.id = p_task
$$;

-- Contract section 4: ticket pairs of a task.
create function authz.flight_ticket_counts(p_task uuid) returns table(confirmed integer, required integer)
language sql stable security definer set search_path = '' as $$
  select
    case when s.task_id is null then 0 else (
      select count(*)::integer
      from public.flight_sector_passengers p join public.flight_sectors x on x.id = p.sector_id
      where p.task_id = t.id and p.ended_at is null and p.held_by_change_id is null and x.status = 'active'
        and exists (select 1 from public.flight_ticket_revisions r
                    where r.sector_id = p.sector_id and r.traveller_seq = p.traveller_seq)) end,
    case when s.task_id is null then (
      select coalesce(jsonb_array_length(case when jsonb_typeof(f.facts -> 'segments') = 'array' then f.facts -> 'segments' end), 0)
             * cardinality(authz.item_participant_seqs(t.service_item_id, authz.task_current_version(t.id)))
      from public.service_item_facts f
      where f.service_item_id = t.service_item_id and f.booking_version_id = authz.task_current_version(t.id))
    else (
      select count(*)::integer
      from public.flight_sector_passengers p join public.flight_sectors x on x.id = p.sector_id
      where p.task_id = t.id and p.ended_at is null and p.held_by_change_id is null
        and x.status in ('active', 'pending')) end
  from public.fulfilment_tasks t
  left join public.flight_task_state s on s.task_id = t.id
  where t.id = p_task and t.department = 'flight'
$$;

-- --- Normalizers --------------------------------------------------------------

create function authz.flight_norm_place(p_value text) returns text
language sql immutable set search_path = '' as $$
  select case when btrim(p_value) ~ '^[A-Za-z]{3}$' then upper(btrim(p_value)) else nullif(btrim(p_value), '') end
$$;

create function authz.flight_norm_flight_no(p_value text) returns text
language sql immutable set search_path = '' as $$
  select nullif(upper(regexp_replace(btrim(p_value), '\s+', ' ', 'g')), '')
$$;

create function authz.flight_norm_text(p_value text) returns text
language sql immutable set search_path = '' as $$
  select nullif(btrim(p_value, E' \t\r\n'), '')
$$;

create function authz.flight_norm_pnr(p_value text) returns text
language sql immutable set search_path = '' as $$
  select nullif(upper(btrim(p_value)), '')
$$;

create function authz.flight_norm_ticket(p_value text) returns text
language sql immutable set search_path = '' as $$
  select nullif(regexp_replace(p_value, '\s', '', 'g'), '')
$$;

-- Ticket identifiers of one passenger line, normalized:
-- {crsType, crsPnr|null, airlinePnr, ticketNumber}. Unknown keys are ignored.
create function authz.flight_ticket_fields_normalize(p_fields jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'crsType', case when jsonb_typeof(p_fields -> 'crsType') = 'string' then p_fields ->> 'crsType' end,
    'crsPnr', case when jsonb_typeof(p_fields -> 'crsPnr') = 'string' then authz.flight_norm_pnr(p_fields ->> 'crsPnr') end,
    'airlinePnr', case when jsonb_typeof(p_fields -> 'airlinePnr') = 'string' then authz.flight_norm_pnr(p_fields ->> 'airlinePnr') end,
    'ticketNumber', case when jsonb_typeof(p_fields -> 'ticketNumber') = 'string' then authz.flight_norm_ticket(p_fields ->> 'ticketNumber') end)
$$;

-- Contract B8 / A10: the first invalid field name of one passenger line after
-- normalization (crsType | crsPnr | airlinePnr | ticketNumber), or null.
create function authz.flight_ticket_fields_issue(p_fields jsonb) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_fields is null or jsonb_typeof(p_fields) <> 'object' then 'crsType'
    when n ->> 'crsType' is null or n ->> 'crsType' not in ('amadeus', 'galileo', 'sabre', 'airline_direct', 'other') then 'crsType'
    when p_fields ? 'crsPnr' and coalesce(jsonb_typeof(p_fields -> 'crsPnr'), 'null') not in ('string', 'null') then 'crsPnr'
    when n ->> 'crsType' = 'airline_direct' and n ->> 'crsPnr' is not null then 'crsPnr'
    when n ->> 'crsType' <> 'airline_direct' and coalesce(n ->> 'crsPnr', '') !~ '^[A-Z0-9]{5,8}$' then 'crsPnr'
    when coalesce(n ->> 'airlinePnr', '') !~ '^[A-Z0-9]{5,8}$' then 'airlinePnr'
    when coalesce(n ->> 'ticketNumber', '') !~ '^[0-9][0-9-]{4,18}[0-9]$' or n ->> 'ticketNumber' ~ '--'
         or replace(n ->> 'ticketNumber', '-', '') !~ '^[0-9]{6,20}$' then 'ticketNumber'
    else null end
  from (select authz.flight_ticket_fields_normalize(p_fields) as n) x
$$;

-- D8: a ticket number belongs to one (Deal, traveller) within the entity.
create function authz.flight_register_ticket_number(p_entity uuid, p_digits text, p_deal uuid, p_seq integer, p_revision uuid)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.flight_ticket_numbers%rowtype;
begin
  insert into public.flight_ticket_numbers (legal_entity_id, ticket_digits, deal_id, traveller_seq, first_revision_id)
  values (p_entity, p_digits, p_deal, p_seq, p_revision)
  on conflict (legal_entity_id, ticket_digits) do nothing;
  select * into v from public.flight_ticket_numbers n where n.legal_entity_id = p_entity and n.ticket_digits = p_digits;
  if v.deal_id is distinct from p_deal or v.traveller_seq is distinct from p_seq then
    raise exception 'ticket_number_taken' using errcode = '23505';
  end if;
end;
$$;

-- Inserts the next ticket revision of (sector, seq) with the CURRENT traveller
-- name/type snapshot of the task's version (the latest snapshot when the seq
-- left the booking), normalized fields and the given batch, and registers its
-- number (authz.flight_register_ticket_number; calling that again is harmless).
-- Callers validate first (authz.flight_ticket_fields_issue) and hold the group lock.
-- p_reason null for revision 1, 10..300 characters for a correction.
create function authz.flight_insert_ticket_revision(
  p_sector_id uuid, p_traveller_seq integer, p_batch_id uuid, p_fields jsonb, p_reason text, p_request_id uuid
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_sector public.flight_sectors%rowtype;
  v_n jsonb := authz.flight_ticket_fields_normalize(p_fields);
  v_name text;
  v_type text;
  v_no integer;
  v_id uuid;
  v_digits text;
begin
  select * into v_sector from public.flight_sectors s where s.id = p_sector_id;
  if v_sector.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if authz.flight_ticket_fields_issue(p_fields) is not null then
    raise exception 'invalid_input' using errcode = '22023', hint = authz.flight_ticket_fields_issue(p_fields);
  end if;
  select s.full_name, s.traveller_type into v_name, v_type
  from public.booking_version_travellers s
  where s.booking_version_id = authz.task_current_version(v_sector.task_id) and s.seq = p_traveller_seq;
  if v_name is null then
    select r.traveller_name, r.traveller_type into v_name, v_type
    from public.flight_ticket_revisions r
    where r.sector_id = p_sector_id and r.traveller_seq = p_traveller_seq
    order by r.revision_no desc limit 1;
  end if;
  if v_name is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select coalesce(max(r.revision_no), 0) + 1 into v_no
  from public.flight_ticket_revisions r where r.sector_id = p_sector_id and r.traveller_seq = p_traveller_seq;
  insert into public.flight_ticket_revisions (legal_entity_id, deal_id, task_id, sector_id, traveller_seq, revision_no, batch_id,
    traveller_name, traveller_type, crs_type, crs_pnr, airline_pnr, ticket_number, reason, created_by, request_id)
  values (v_sector.legal_entity_id, v_sector.deal_id, v_sector.task_id, v_sector.id, p_traveller_seq, v_no, p_batch_id,
    v_name, v_type, v_n ->> 'crsType', v_n ->> 'crsPnr', v_n ->> 'airlinePnr', v_n ->> 'ticketNumber',
    case when v_no = 1 then null else p_reason end, (select auth.uid()), p_request_id)
  returning id, ticket_digits into v_id, v_digits;
  perform authz.flight_register_ticket_number(v_sector.legal_entity_id, v_digits, v_sector.deal_id, p_traveller_seq, v_id);
  return v_id;
end;
$$;

-- Track B replaces this (create or replace) with the real money check:
-- fare_approval_pending, payment_missing, payment_returned.
create function authz.flight_money_issues(p_deal uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select '{}'::text[]
$$;

-- Ticket batches of the Deal and how many are paid (contract section 4,
-- "Batch paid"). Reads track B's tables only when they exist.
create function authz.flight_batch_payment_counts(p_deal uuid) returns table(paid integer, total integer)
language plpgsql stable security definer set search_path = '' as $$
begin
  if to_regclass('public.flight_ticket_batches') is null then
    return query select 0, 0;
    return;
  end if;
  -- Track B's definition when installed (a batch with no supplier cost is paid).
  if to_regprocedure('authz.flight_batch_paid(uuid)') is not null then
    return query execute
      'select (count(*) filter (where authz.flight_batch_paid(b.id)))::integer, count(*)::integer
       from public.flight_ticket_batches b where b.deal_id = $1'
      using p_deal;
    return;
  end if;
  return query execute
    'select count(*) filter (where
              exists (select 1 from public.department_cost_entries c
                      join public.department_evidence e on e.id = c.receipt_evidence_id
                      where c.flight_batch_id = b.id and c.expense_status in (''submitted'', ''accepted'')
                        and e.kind = ''direct_payment_proof'' and e.status = ''stored'')
              or exists (select 1 from public.supplier_payment_requests r
                         where r.flight_batch_id = b.id and r.status in (''approved'', ''paid'', ''verified'')))::integer,
            count(*)::integer
     from public.flight_ticket_batches b where b.deal_id = $1'
    using p_deal;
end;
$$;

-- Batch number of a ticket batch (track B's table; null before it exists).
create function authz.flight_batch_no(p_batch uuid) returns integer
language plpgsql stable security definer set search_path = '' as $$
declare
  v integer;
begin
  if p_batch is null or to_regclass('public.flight_ticket_batches') is null then
    return null;
  end if;
  execute 'select b.batch_no from public.flight_ticket_batches b where b.id = $1' into v using p_batch;
  return v;
end;
$$;

-- --- Idempotency (contract section 6) -------------------------------------

create function authz.flight_replay(p_entity uuid, p_request uuid, p_command text, p_payload jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_request is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  begin
    return authz.finance_replay(p_entity, p_request, p_command, p_payload);
  exception when sqlstate '40001' then
    raise exception 'duplicate_request' using errcode = '40001';
  end;
end;
$$;

create function authz.flight_remember(p_entity uuid, p_request uuid, p_command text, p_payload jsonb, p_result jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  begin
    return authz.finance_remember(p_entity, p_request, p_command, p_payload, p_result);
  exception when sqlstate '40001' then
    raise exception 'duplicate_request' using errcode = '40001';
  end;
end;
$$;

-- --- Booking legs and sector building ---------------------------------------

-- Booking legs of flight facts: [{legNo, from, to, date, arrivalDate, airline,
-- flightNo, departTime, arriveTime}] (values as Sales typed them, blanks null).
create function authz.flight_facts_legs(p_facts jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'legNo', o.n,
      'from', s ->> 'from', 'to', s ->> 'to', 'date', s ->> 'date',
      'arrivalDate', nullif(s ->> 'arrivalDate', ''),
      'airline', authz.flight_norm_text(s ->> 'airline'),
      'flightNo', authz.flight_norm_text(s ->> 'flightNo'),
      'departTime', nullif(s ->> 'departTime', ''),
      'arriveTime', nullif(s ->> 'arriveTime', '')) order by o.n), '[]'::jsonb)
  from jsonb_array_elements(case when jsonb_typeof(p_facts -> 'segments') = 'array' then p_facts -> 'segments'
                                 else '[]'::jsonb end) with ordinality o(s, n)
$$;

-- Inserts one booking sector for a leg (and every participant of the version).
create function authz.flight_insert_booking_sector(p_task uuid, p_version uuid, p_leg jsonb, p_cabin text, p_seqs integer[])
returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_id uuid;
  v_uid uuid;
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task;
  v_uid := coalesce((select auth.uid()), v_task.assignee_user_id);
  insert into public.flight_sectors (legal_entity_id, branch_id, deal_id, task_id, service_item_id, origin, basis_version_id,
    booking_leg_no, from_place, to_place, depart_date, depart_time, arrive_date, arrive_time, airline, flight_no, cabin,
    status, created_by)
  values (v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, v_task.service_item_id, 'booking', p_version,
    (p_leg ->> 'legNo')::smallint, authz.flight_norm_place(p_leg ->> 'from'), authz.flight_norm_place(p_leg ->> 'to'),
    (p_leg ->> 'date')::date, p_leg ->> 'departTime', (p_leg ->> 'arrivalDate')::date, p_leg ->> 'arriveTime',
    left(p_leg ->> 'airline', 60), authz.flight_norm_flight_no(p_leg ->> 'flightNo'),
    left(authz.flight_norm_text(p_cabin), 40), 'active', v_uid)
  returning id into v_id;
  insert into public.flight_sector_passengers (legal_entity_id, deal_id, task_id, sector_id, traveller_seq, created_by)
  select v_task.legal_entity_id, v_task.deal_id, v_task.id, v_id, s, v_uid from unnest(p_seqs) s;
  return v_id;
end;
$$;

-- A1: the booking sectors of a freshly created task state (basis version):
-- one per facts segment, every participant on every sector. Screenshot
-- flights without typed legs get none. Returns the number of sectors.
create function authz.flight_build_sectors(p_task uuid) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_state public.flight_task_state%rowtype;
  v_facts jsonb;
  v_leg jsonb;
  v_seqs integer[];
  v_n integer := 0;
begin
  select * into v_state from public.flight_task_state s where s.task_id = p_task;
  if v_state.task_id is null or exists (select 1 from public.flight_sectors x where x.task_id = p_task) then
    return 0;
  end if;
  select f.facts into v_facts from public.service_item_facts f
  where f.service_item_id = v_state.service_item_id and f.booking_version_id = v_state.basis_version_id;
  v_seqs := authz.item_participant_seqs(v_state.service_item_id, v_state.basis_version_id);
  for v_leg in select e from jsonb_array_elements(authz.flight_facts_legs(v_facts)) e loop
    perform authz.flight_insert_booking_sector(p_task, v_state.basis_version_id, v_leg, v_facts ->> 'cabin', v_seqs);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- --- Booking change diff (contract section 8) --------------------------------

-- Pure read. null when the task has no state or follows its current version.
create function authz.flight_booking_diff(p_task uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_state public.flight_task_state%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_new_version uuid;
  v_old_facts jsonb;
  v_new_facts jsonb;
  v_old jsonb;
  v_new jsonb;
  v_old_n integer;
  v_new_n integer;
  v_old_used boolean[];
  v_new_used boolean[];
  v_new_match integer[];
  i integer;
  j integer;
  v_unchanged jsonb := '[]'::jsonb;
  v_changed jsonb := '[]'::jsonb;
  v_removed jsonb := '[]'::jsonb;
  v_added jsonb := '[]'::jsonb;
  v_removed_sectors uuid[] := '{}'::uuid[];
  v_old_seqs integer[];
  v_new_seqs integer[];
  v_pass jsonb;
  v_removed_seqs integer[];
  v_renamed_seqs integer[];
  v_old_mode text;
  v_new_mode text;
  v_item_no integer;
  v_other text[];
  v_impact jsonb;
begin
  select * into v_state from public.flight_task_state s where s.task_id = p_task;
  if v_state.task_id is null then
    return null;
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task;
  v_new_version := authz.task_current_version(p_task);
  if v_new_version = v_state.basis_version_id then
    return null;
  end if;
  select f.facts into v_old_facts from public.service_item_facts f
  where f.service_item_id = v_task.service_item_id and f.booking_version_id = v_state.basis_version_id;
  select f.facts into v_new_facts from public.service_item_facts f
  where f.service_item_id = v_task.service_item_id and f.booking_version_id = v_new_version;
  v_old := authz.flight_facts_legs(v_old_facts);
  v_new := authz.flight_facts_legs(v_new_facts);
  v_old_n := jsonb_array_length(v_old);
  v_new_n := jsonb_array_length(v_new);
  v_old_used := array_fill(false, array[greatest(v_old_n, 1)]);
  v_new_used := array_fill(false, array[greatest(v_new_n, 1)]);
  v_new_match := array_fill(null::integer, array[greatest(v_new_n, 1)]);

  -- 1. Identical legs (every leg field and the item cabin): each new leg takes
  --    the first unmatched identical old leg.
  for i in 1 .. v_new_n loop
    for j in 1 .. v_old_n loop
      if not v_old_used[j]
         and ((v_new -> (i - 1)) - 'legNo') = ((v_old -> (j - 1)) - 'legNo')
         and (v_new_facts ->> 'cabin') is not distinct from (v_old_facts ->> 'cabin') then
        v_old_used[j] := true;
        v_new_used[i] := true;
        v_new_match[i] := j;
        exit;
      end if;
    end loop;
  end loop;
  for i in 1 .. v_new_n loop
    if v_new_used[i] then
      v_unchanged := v_unchanged || jsonb_build_object('oldLegNo', v_new_match[i], 'newLegNo', i, 'leg', v_new -> (i - 1));
    end if;
  end loop;
  -- 2. Remaining legs at the same position are changed; the rest removed / added.
  for i in 1 .. greatest(v_old_n, v_new_n) loop
    if i <= v_old_n and i <= v_new_n and not v_old_used[i] and not v_new_used[i] then
      v_changed := v_changed || jsonb_build_object('oldLegNo', i, 'newLegNo', i, 'old', v_old -> (i - 1), 'new', v_new -> (i - 1));
      v_old_used[i] := true;
      v_new_used[i] := true;
    end if;
  end loop;
  for i in 1 .. v_old_n loop
    if not v_old_used[i] then
      v_removed := v_removed || jsonb_build_object('oldLegNo', i, 'old', v_old -> (i - 1));
    end if;
  end loop;
  for i in 1 .. v_new_n loop
    if not v_new_used[i] then
      v_added := v_added || jsonb_build_object('newLegNo', i, 'new', v_new -> (i - 1));
    end if;
  end loop;

  v_old_mode := coalesce(v_old_facts ->> 'entryMode', 'typed');
  v_new_mode := coalesce(v_new_facts ->> 'entryMode', 'typed');

  -- Sectors that apply would end: booking sectors of changed/removed legs and,
  -- when the flight is no longer a screenshot flight, the typed screenshot sectors.
  select coalesce(array_agg(x.id), '{}'::uuid[]) into v_removed_sectors
  from public.flight_sectors x
  where x.task_id = p_task and x.status = 'active'
    and ((x.origin = 'booking' and x.basis_version_id = v_state.basis_version_id
          and x.booking_leg_no in (select (e ->> 'oldLegNo')::integer from jsonb_array_elements(v_changed || v_removed) e))
         or (x.origin = 'screenshot' and v_new_mode <> 'screenshot'));

  -- Passengers.
  v_old_seqs := authz.item_participant_seqs(v_task.service_item_id, v_state.basis_version_id);
  v_new_seqs := authz.item_participant_seqs(v_task.service_item_id, v_new_version);
  select jsonb_build_object(
    'added', coalesce((select jsonb_agg(jsonb_build_object('seq', n.seq, 'name', n.full_name, 'type', n.traveller_type) order by n.seq)
                       from public.booking_version_travellers n
                       where n.booking_version_id = v_new_version and n.seq = any (v_new_seqs) and not (n.seq = any (v_old_seqs))), '[]'::jsonb),
    'removed', coalesce((select jsonb_agg(jsonb_build_object('seq', o.seq, 'name', o.full_name, 'type', o.traveller_type) order by o.seq)
                         from public.booking_version_travellers o
                         where o.booking_version_id = v_state.basis_version_id and o.seq = any (v_old_seqs)
                           and not (o.seq = any (v_new_seqs))), '[]'::jsonb),
    'renamed', coalesce((select jsonb_agg(jsonb_build_object('seq', o.seq, 'oldName', o.full_name, 'newName', n.full_name,
                                                             'oldType', o.traveller_type, 'newType', n.traveller_type) order by o.seq)
                         from public.booking_version_travellers o
                         join public.booking_version_travellers n on n.booking_version_id = v_new_version and n.seq = o.seq
                         where o.booking_version_id = v_state.basis_version_id and o.seq = any (v_old_seqs) and n.seq = any (v_new_seqs)
                           and (o.full_name, o.traveller_type) is distinct from (n.full_name, n.traveller_type)), '[]'::jsonb))
  into v_pass;
  select coalesce(array_agg((e ->> 'seq')::integer), '{}'::integer[]) into v_removed_seqs from jsonb_array_elements(v_pass -> 'removed') e;
  select coalesce(array_agg((e ->> 'seq')::integer), '{}'::integer[]) into v_renamed_seqs from jsonb_array_elements(v_pass -> 'renamed') e;

  -- Other changed fields of this item (names only).
  select i.item_no into v_item_no from public.service_items i where i.id = v_task.service_item_id;
  select coalesce(array_agg(distinct k order by k), '{}'::text[]) into v_other
  from (select substr(f, length('items.' || v_item_no::text || '.') + 1) as k
        from unnest(authz.revision_department_fields(v_new_version)) f
        where f like 'items.' || v_item_no::text || '.%') x
  where k <> 'segments';

  select jsonb_build_object(
    'ticketsOnRemoved', (select count(*) from public.flight_sector_passengers p
                         where p.sector_id = any (v_removed_sectors) and p.ended_at is null
                           and exists (select 1 from public.flight_ticket_revisions r
                                       where r.sector_id = p.sector_id and r.traveller_seq = p.traveller_seq)),
    'ticketsOfRemovedTravellers', (select count(*) from public.flight_sector_passengers p join public.flight_sectors x on x.id = p.sector_id
                                   where p.task_id = p_task and p.ended_at is null and x.status = 'active'
                                     and not (p.sector_id = any (v_removed_sectors))
                                     and p.traveller_seq = any (v_removed_seqs)
                                     and exists (select 1 from public.flight_ticket_revisions r
                                                 where r.sector_id = p.sector_id and r.traveller_seq = p.traveller_seq)),
    'ticketsRenamed', (select count(*) from public.flight_sector_passengers p join public.flight_sectors x on x.id = p.sector_id
                       where p.task_id = p_task and p.ended_at is null and x.status = 'active'
                         and p.traveller_seq = any (v_renamed_seqs)
                         and exists (select 1 from public.flight_ticket_revisions r
                                     where r.sector_id = p.sector_id and r.traveller_seq = p.traveller_seq)),
    'pendingChangesSuperseded', (select count(*) from public.flight_changes c where c.task_id = p_task and c.status = 'pending'),
    'approvedChangesOnChangedLegs', coalesce((select jsonb_agg(jsonb_build_object('changeNo', c.change_no) order by c.change_no)
                                              from public.flight_changes c
                                              where c.task_id = p_task and c.status = 'approved'
                                                and c.from_sector_ids && v_removed_sectors), '[]'::jsonb))
  into v_impact;

  return jsonb_build_object(
    'fromVersionId', v_state.basis_version_id,
    'toVersionId', v_new_version,
    'fromVersionNo', (select v.version_no from public.booking_versions v where v.id = v_state.basis_version_id),
    'toVersionNo', (select v.version_no from public.booking_versions v where v.id = v_new_version),
    'legs', jsonb_build_object('unchanged', v_unchanged, 'changed', v_changed, 'removed', v_removed, 'added', v_added),
    'cabin', jsonb_build_object('old', v_old_facts ->> 'cabin', 'new', v_new_facts ->> 'cabin'),
    'entryMode', jsonb_build_object('old', v_old_mode, 'new', v_new_mode),
    'screenshots', jsonb_build_object(
      'oldCount', (select count(*) from public.service_item_files f
                   where f.service_item_id = v_task.service_item_id and f.booking_version_id = v_state.basis_version_id
                     and f.status = 'stored'),
      'newCount', (select count(*) from public.service_item_files f
                   where f.service_item_id = v_task.service_item_id and f.booking_version_id = v_new_version
                     and f.status = 'stored')),
    'passengers', v_pass,
    'otherFields', to_jsonb(v_other),
    'impact', v_impact);
end;
$$;

-- --- Mark done checklist (contract section 7) --------------------------------

create function authz.flight_done_issues(p_deal uuid) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v_issues text[] := '{}'::text[];
  v_money text[];
begin
  -- Tasks not yet completed are the ones a "Mark flight done" completes.
  if exists (select 1 from public.fulfilment_tasks t join public.flight_task_state s on s.task_id = t.id
             where t.deal_id = p_deal and t.department = 'flight' and t.status <> 'completed'
               and s.basis_version_id <> authz.task_current_version(t.id)) then
    v_issues := v_issues || 'booking_changed'::text;
  end if;
  if exists (select 1 from public.fulfilment_tasks t
             where t.deal_id = p_deal and t.department = 'flight' and t.status <> 'completed'
               and authz.flight_unnamed_count(t.id) > 0) then
    v_issues := v_issues || 'travellers_unnamed'::text;
  end if;
  if exists (select 1 from public.fulfilment_tasks t
             cross join lateral unnest(authz.item_participant_seqs(t.service_item_id, authz.task_current_version(t.id))) p(seq)
             where t.deal_id = p_deal and t.department = 'flight' and t.status <> 'completed'
               and not exists (select 1 from public.flight_sector_passengers a join public.flight_sectors x on x.id = a.sector_id
                               where a.task_id = t.id and a.traveller_seq = p.seq and a.ended_at is null
                                 and x.status = 'active')) then
    v_issues := v_issues || 'traveller_without_flight'::text;
  end if;
  if exists (select 1 from public.flight_changes c where c.deal_id = p_deal and c.status = 'pending') then
    v_issues := v_issues || 'change_pending'::text;
  end if;
  if exists (select 1 from public.fulfilment_tasks t cross join lateral authz.flight_ticket_counts(t.id) k
             where t.deal_id = p_deal and t.department = 'flight' and t.status <> 'completed'
               and (k.required = 0 or k.confirmed < k.required)) then
    v_issues := v_issues || 'tickets_pending'::text;
  end if;
  if exists (select 1 from public.fulfilment_tasks t
             join public.flight_sector_passengers a on a.task_id = t.id and a.ended_at is null
             join public.flight_sectors x on x.id = a.sector_id and x.status = 'active'
             cross join lateral (select r.traveller_name, r.traveller_type from public.flight_ticket_revisions r
                                 where r.sector_id = a.sector_id and r.traveller_seq = a.traveller_seq
                                 order by r.revision_no desc limit 1) r
             left join public.booking_version_travellers s
               on s.booking_version_id = authz.task_current_version(t.id) and s.seq = a.traveller_seq
             where t.deal_id = p_deal and t.department = 'flight' and t.status <> 'completed'
               and (r.traveller_name, r.traveller_type) is distinct from (s.full_name, s.traveller_type)) then
    v_issues := v_issues || 'traveller_changed'::text;
  end if;
  v_money := coalesce(authz.flight_money_issues(p_deal), '{}'::text[]);
  v_issues := v_issues || array(select m from unnest(array['fare_approval_pending', 'payment_missing', 'payment_returned']) m
                                where m = any (v_money));
  if not exists (select 1 from public.department_evidence e join public.fulfilment_tasks t on t.id = e.task_id
                 where t.deal_id = p_deal and t.department = 'flight' and e.kind = 'e_ticket' and e.status = 'stored') then
    v_issues := v_issues || 'eticket_missing'::text;
  end if;
  return v_issues;
end;
$$;

revoke all on function
  authz.flight_seqs_ok(integer[]), authz.flight_transition(), authz.flight_task_state_guard(), authz.flight_changes_guard(),
  authz.flight_sectors_guard(), authz.flight_sector_passengers_guard(), authz.flight_append_only(),
  authz.flight_lock_group(uuid), authz.flight_gate_issue(uuid), authz.flight_refuse_gate(uuid), authz.flight_can_work(uuid),
  authz.flight_deal_kind(uuid), authz.flight_is_sales_owner(uuid), authz.flight_has_active_sales_owner(uuid),
  authz.flight_can_decide_change(uuid), authz.flight_task_budget(uuid), authz.flight_unnamed_count(uuid),
  authz.flight_ticket_counts(uuid), authz.flight_norm_place(text), authz.flight_norm_flight_no(text),
  authz.flight_norm_text(text), authz.flight_norm_pnr(text), authz.flight_norm_ticket(text),
  authz.flight_ticket_fields_normalize(jsonb), authz.flight_ticket_fields_issue(jsonb),
  authz.flight_register_ticket_number(uuid, text, uuid, integer, uuid),
  authz.flight_insert_ticket_revision(uuid, integer, uuid, jsonb, text, uuid),
  authz.flight_money_issues(uuid), authz.flight_batch_payment_counts(uuid), authz.flight_batch_no(uuid),
  authz.flight_replay(uuid, uuid, text, jsonb), authz.flight_remember(uuid, uuid, text, jsonb, jsonb),
  authz.flight_facts_legs(jsonb), authz.flight_insert_booking_sector(uuid, uuid, jsonb, text, integer[]),
  authz.flight_build_sectors(uuid), authz.flight_booking_diff(uuid), authz.flight_done_issues(uuid)
from public, anon, authenticated, service_role;

commit;
