-- TripNavigate CRM - Book now v2 (owner-approved prototype, 26 October 2026),
-- part 1: schema.
--
-- Frozen contract: docs/implementation/booking-form-v2-2026-10-26/contract.md
-- and build-plan.md section 5.2 (Agent B, migrations 20261129000100-0190).
--
-- What changes:
--   1. service_item_cost_estimates gains the flight fare per person (adult,
--      child, infant; cost side only, unknown = null). fare_total_paise stays
--      for items saved before Book now v2 (never written by the v2 form).
--   2. booking_version_flight_fares (new): the typed total fare per person
--      for all flights of one booking version (one ticket with a layover).
--      Cost side only. Same readers as the estimates (commercial readers and
--      the Flight assignee), through definer functions only: RLS on, no
--      policy, no privilege. Immutable once the version is not a draft;
--      any change refreshes the draft's content hash.
--   3. service_item_facts.purchase_budget_auto (owner decision D2, 26
--      October 2026, option a): true while the item's Purchase budget is set
--      automatically from its "Our cost" estimate (the v2 form never asks for
--      a budget). False = typed by staff (kept as stored). Existing rows
--      default to false; a stored budget of 0 counts as "never typed"
--      (20261129000110, booking_service_save).
--
-- Never: no selling value, no money received, no Bitrix write.
--
-- Rollback (forward-only): the columns are nullable (or defaulted) and the
-- table is read only through the functions of 20261129000110/0120. Emergency:
-- a NEW migration revoking execute on booking_flight_fares_save and
-- booking_flight_returns_add; the rows stay.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Flight fare per person on the item estimate
-- ===========================================================================

alter table public.service_item_cost_estimates
  add column fare_adult_paise bigint check (fare_adult_paise between 0 and 99999999999),
  add column fare_child_paise bigint check (fare_child_paise between 0 and 99999999999),
  add column fare_infant_paise bigint check (fare_infant_paise between 0 and 99999999999);
comment on column public.service_item_cost_estimates.fare_adult_paise is
  'Book now v2: estimated flight fare per adult (cost side only; null = not priced).';
comment on column public.service_item_cost_estimates.fare_child_paise is
  'Book now v2: estimated flight fare per child (cost side only; null = not priced).';
comment on column public.service_item_cost_estimates.fare_infant_paise is
  'Book now v2: estimated flight fare per infant (cost side only; null = not priced).';
comment on column public.service_item_cost_estimates.fare_total_paise is
  'Estimated flight fare, total, of items saved before Book now v2. Read only; the v2 form writes the fare per person.';

-- ===========================================================================
-- 2. Typed total fare per person, all flights of a version
-- ===========================================================================

create table public.booking_version_flight_fares (
  booking_version_id uuid primary key,
  legal_entity_id uuid not null,
  adult_paise bigint check (adult_paise between 0 and 99999999999),
  child_paise bigint check (child_paise between 0 and 99999999999),
  infant_paise bigint check (infant_paise between 0 and 99999999999),
  updated_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, booking_version_id) references public.booking_versions (legal_entity_id, id) on delete cascade,
  -- A row with no amount is never kept (the save command deletes it).
  constraint booking_version_flight_fares_some_check check (coalesce(adult_paise, child_paise, infant_paise) is not null)
);
create index booking_version_flight_fares_entity_idx on public.booking_version_flight_fares (legal_entity_id);
create index booking_version_flight_fares_updated_by_idx on public.booking_version_flight_fares (updated_by);
comment on table public.booking_version_flight_fares is
  'Book now v2: typed total fare per person (adult, child, infant) for all flights of one booking version, used only for a traveller type no flight prices (one ticket with a layover). Cost side only: never a selling value, never the purchase budget. Readers: commercial readers and the Flight assignee, through definer functions only. Immutable once the version is not a draft.';

create trigger booking_version_flight_fares_a_guard
  before insert or update or delete on public.booking_version_flight_fares
  for each row execute function authz.b11_version_child_guard();
create trigger booking_version_flight_fares_a_touch before update on public.booking_version_flight_fares
  for each row execute function authz.b11_touch();
create trigger booking_version_flight_fares_b_rehash
  after insert or update or delete on public.booking_version_flight_fares
  for each row execute function authz.b11_rehash_version();

alter table public.booking_version_flight_fares enable row level security;
create policy require_valid_session on public.booking_version_flight_fares as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.booking_version_flight_fares from public, anon, authenticated, service_role;

-- ===========================================================================
-- 3. Purchase budget set from the estimate (owner decision D2)
-- ===========================================================================

alter table public.service_item_facts
  add column purchase_budget_auto boolean not null default false;
comment on column public.service_item_facts.purchase_budget_auto is
  'Book now v2 (owner decision D2, 26 October 2026): true while purchase_budget_paise is set automatically from the item''s supplier estimate ("Our cost"; no estimate = 0 = no budget). False = typed by staff, kept as stored.';

commit;
