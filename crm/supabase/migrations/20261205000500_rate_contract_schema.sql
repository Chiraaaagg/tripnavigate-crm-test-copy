-- TripNavigate CRM - Accounts phase 3, track E (1 of 5): rate contracts - schema.
-- Contract: accounts-phase3-2026-11-12/contract.md section 9.1 (LD21), 9.4
-- (import kind), 14 (rate contracts: Purchase, Manager and Accounts only),
-- 17.2 (switch Off), 17.3 (settings.procurement_changed). Release B.
--
-- What changes:
--   * procurement_settings.rate_contracts_enabled (Off). The settings audit
--     trigger now also watches it. E1 public.admin_set_rate_contracts_enabled
--     (Super Admin, reason 10..500; pattern of admin_set_supplier_email_sending).
--   * Meal plans: a fixed code list EP, CP, MAP, AP, AI (labels frozen in TS:
--     Room only, Breakfast, Breakfast and dinner, All meals, All inclusive),
--     mirrored by authz.rc_meal_code / authz.rc_meal_label.
--   * New tables: hotel_room_types (per catalogue hotel), rate_contracts (one
--     supplier + one hotel, RC-<year>-<6 digits>, version 1.. per supplier +
--     hotel), rate_contract_counters, rate_contract_lines, rate_contract_blackouts,
--     rate_contract_files (pattern of purchase_evidence, same private bucket,
--     path <entity>/rate-contracts/<contract>/<file>), rate_contract_alerts
--     (30 / 7 days before the end; written by the timer task in 0520; track N
--     turns them into notice 60).
--   * purchase_quotes: room_type_id, meal_plan_code, rate_contract_id,
--     contract_total_paise, contract_state (none | matches | differs | ended),
--     contract_deviation_reason (10..300, required exactly when differs).
--   * import_batches.kind gains 'rate_sheet' (no branch, never entity-wide).
--   * Helpers without side effects: authz.rc_date, authz.rc_rupees_paise,
--     authz.rc_paise, authz.rc_blackouts, authz.rate_contracts_enabled,
--     authz.rc_reader, authz.rc_lock_pair.
--
-- Database pattern: legal_entity_id + composite FKs, RLS on with the
-- restrictive require_valid_session policy, every privilege revoked from
-- public, anon, authenticated, service_role (reads and writes go through the
-- definer functions of 0510..0540), guard triggers (no DELETE except draft
-- lines and blackouts while their contract is draft or returned), an index on
-- every FK.
--
-- Refusal tokens (section 13): rate_contracts_off (55000), lines_overlap
-- (22023), in_use (55000); existing not_authorized (42501), invalid_input
-- (22023, hint), version_changed (40001), wrong_state, not_ready,
-- already_recorded, link_not_allowed (55000), not_self_approval (42501).
--
-- Rollback (forward-only): a new migration revoking execute on the track E
-- commands and dropping the procurement_settings column from the audit
-- trigger; tables and quote columns stay (data).

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Switch (E1)
-- ===========================================================================

alter table public.procurement_settings
  add column rate_contracts_enabled boolean not null default false;

drop trigger procurement_settings_audit on public.procurement_settings;
create trigger procurement_settings_audit
  after insert or update or delete on public.procurement_settings
  for each row execute function authz.audit_settings_change(
    'settings.procurement_changed', 'live_supplier_confirmation_enabled', 'supplier_email_sending_enabled',
    -- Accounts phase 3 (20261205000500)
    'rate_contracts_enabled');

create function authz.rate_contracts_enabled() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.rate_contracts_enabled from public.procurement_settings s where s.id), false)
$$;

-- Mirrors admin_set_supplier_email_sending (20261130000100).
create function public.admin_set_rate_contracts_enabled(p_enabled boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before boolean;
  v_after public.procurement_settings%rowtype;
  v_reason text;
  v_prev text[];
begin
  if not authz.can_switch_live_settings(null) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_enabled is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'enabled';
  end if;
  v_reason := authz.settings_change_reason(p_reason);
  select s.rate_contracts_enabled into v_before from public.procurement_settings s where s.id for update;
  if not found then
    raise exception 'settings row missing' using errcode = '55000';
  end if;
  v_prev := authz.settings_begin_change('admin_set_rate_contracts_enabled', v_reason);
  update public.procurement_settings s set rate_contracts_enabled = p_enabled, updated_at = now() where s.id returning * into v_after;
  perform authz.settings_end_change(v_prev);
  return jsonb_build_object('changed', v_before is distinct from v_after.rate_contracts_enabled,
    'before', v_before, 'after', v_after.rate_contracts_enabled, 'updatedAt', v_after.updated_at);
end;
$$;

-- ===========================================================================
-- 2. Value helpers (immutable; no exception blocks, so set-based imports stay fast)
-- ===========================================================================

-- A real ISO date (YYYY-MM-DD) in 2000..2100, else null.
create function authz.rc_date(p text) returns date
language sql immutable parallel safe set search_path = '' as $$
  select case when btrim(coalesce(p, '')) ~ '^(20[0-9]{2}|2100)-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])$' then
    case when substr(btrim(p), 9, 2)::integer
              <= extract(day from (make_date(substr(btrim(p), 1, 4)::integer, substr(btrim(p), 6, 2)::integer, 1)
                                   + interval '1 month' - interval '1 day'))::integer
         then btrim(p)::date end end
$$;

-- Rupees as typed in a sheet ("5000", "5,000.50") -> whole paise; null when
-- blank; -1 when not an amount (never a float).
create function authz.rc_rupees_paise(p text) returns bigint
language sql immutable parallel safe set search_path = '' as $$
  select case
    when nullif(btrim(coalesce(p, '')), '') is null then null
    when regexp_replace(btrim(p), '[ ,]', '', 'g') ~ '^[0-9]{1,13}(\.[0-9]{1,2})?$'
      then (regexp_replace(btrim(p), '[ ,]', '', 'g')::numeric * 100)::bigint
    else -1 end
$$;

-- Paise as a decimal string or JSON number -> bigint; null when absent or
-- null; -1 when not whole paise.
create function authz.rc_paise(p jsonb) returns bigint
language sql immutable parallel safe set search_path = '' as $$
  select case
    when p is null or jsonb_typeof(p) = 'null' then null
    when jsonb_typeof(p) in ('string', 'number') and (p #>> '{}') ~ '^(0|[1-9][0-9]{0,15})$' then (p #>> '{}')::bigint
    else -1 end
$$;

-- Meal plan code from a code or its frozen label (any case); null otherwise.
create function authz.rc_meal_code(p text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select x.code from (values ('EP', 'room only'), ('CP', 'breakfast'), ('MAP', 'breakfast and dinner'),
                             ('AP', 'all meals'), ('AI', 'all inclusive')) as x (code, label)
  where x.code = upper(btrim(coalesce(p, ''))) or x.label = lower(regexp_replace(btrim(coalesce(p, '')), '\s+', ' ', 'g'))
$$;

create function authz.rc_meal_label(p_code text) returns text
language sql immutable parallel safe set search_path = '' as $$
  select case p_code when 'EP' then 'Room only' when 'CP' then 'Breakfast' when 'MAP' then 'Breakfast and dinner'
                     when 'AP' then 'All meals' when 'AI' then 'All inclusive' end
$$;

-- Blackout dates as typed in a sheet: "2026-12-24..2026-12-31; 2027-01-01"
-- -> [{fromDate, toDate}] (sorted); null when blank; 'false' when any part is
-- not a date range.
create function authz.rc_blackouts(p text) returns jsonb
language sql immutable parallel safe set search_path = '' as $$
  select case when nullif(btrim(coalesce(p, '')), '') is null then null else (
    select case
      when count(*) = 0 then '[]'::jsonb
      when bool_and(d.f is not null and d.t is not null and d.f <= d.t and d.parts <= 2)
        then jsonb_agg(jsonb_build_object('fromDate', d.f, 'toDate', d.t) order by d.f, d.t)
      else 'false'::jsonb end
    from (select authz.rc_date(split_part(e.v, '..', 1)) as f,
                 authz.rc_date(case when strpos(e.v, '..') > 0 then split_part(e.v, '..', 2) else e.v end) as t,
                 cardinality(string_to_array(e.v, '..')) as parts
          from (select btrim(x) as v from regexp_split_to_table(p, ';') x) e
          where e.v <> '') d) end
$$;

-- ===========================================================================
-- 3. Room types (per catalogue hotel)
-- ===========================================================================

create table public.hotel_room_types (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  hotel_id uuid not null,
  name text not null check (char_length(name) between 1 and 120 and name = btrim(name) and name !~ '[[:cntrl:]]'),
  name_key text generated always as (lower(name)) stored,
  status text not null default 'active' check (status in ('active', 'removed')),
  row_version integer not null default 1 check (row_version >= 1),
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_by uuid not null references public.staff_profiles (user_id),
  updated_at timestamptz not null default now(),
  removed_by uuid references public.staff_profiles (user_id),
  removed_at timestamptz,
  remove_reason text check (remove_reason is null or char_length(remove_reason) between 10 and 300),
  import_batch_id uuid references public.import_batches (id),
  constraint hotel_room_types_removed check ((status = 'removed') = (removed_by is not null and removed_at is not null
                                                                      and remove_reason is not null)),
  foreign key (legal_entity_id, hotel_id) references public.hotel_catalogue (legal_entity_id, id),
  unique (legal_entity_id, id)
);
create unique index hotel_room_types_active_name_key on public.hotel_room_types (hotel_id, name_key) where status = 'active';
create index hotel_room_types_hotel_idx on public.hotel_room_types (legal_entity_id, hotel_id, status);
create index hotel_room_types_created_by_idx on public.hotel_room_types (created_by);
create index hotel_room_types_updated_by_idx on public.hotel_room_types (updated_by);
create index hotel_room_types_removed_by_idx on public.hotel_room_types (removed_by) where removed_by is not null;
create index hotel_room_types_import_batch_idx on public.hotel_room_types (import_batch_id) where import_batch_id is not null;
comment on table public.hotel_room_types is
  'Accounts phase 3 (LD21): room types of one catalogue hotel, the pick-list of rate lines and Purchase offers. One active name per hotel (any case). Never deleted; removed is final. No Data API access.';

create function authz.hotel_room_types_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'room types are never deleted' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.legal_entity_id is distinct from old.legal_entity_id
     or new.hotel_id is distinct from old.hotel_id or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at or new.import_batch_id is distinct from old.import_batch_id then
    raise exception 'room type identity is immutable' using errcode = '42501';
  end if;
  if old.status = 'removed' then
    raise exception 'a removed room type is final' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger hotel_room_types_a_guard before update or delete on public.hotel_room_types
  for each row execute function authz.hotel_room_types_guard();

-- ===========================================================================
-- 4. Rate contracts
-- ===========================================================================

create table public.rate_contract_counters (
  legal_entity_id uuid not null references public.legal_entities (id),
  year integer not null check (year between 2000 and 2100),
  last_no integer not null check (last_no between 1 and 999999),
  primary key (legal_entity_id, year)
);
comment on table public.rate_contract_counters is
  'Accounts phase 3: last RC-<year>-<6 digits> number per entity and India year. Rows are never deleted.';

create table public.rate_contracts (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  supplier_id uuid not null,
  hotel_id uuid not null,
  contract_no text not null check (contract_no ~ '^RC-[0-9]{4}-[0-9]{6}$'),
  version_no integer not null check (version_no >= 1),
  valid_from date not null,
  valid_to date not null,
  cancellation_terms text check (cancellation_terms is null or (char_length(cancellation_terms) between 1 and 2000)),
  note text check (note is null or (char_length(note) between 1 and 500)),
  status text not null default 'draft' check (status in ('draft', 'pending_approval', 'active', 'returned', 'ended')),
  source text not null default 'manual' check (source in ('manual', 'import')),
  import_batch_id uuid references public.import_batches (id),
  entered_by uuid not null references public.staff_profiles (user_id),
  entered_at timestamptz not null default now(),
  submitted_at timestamptz,
  decided_by uuid references public.staff_profiles (user_id),
  decided_at timestamptz,
  return_reason text check (return_reason is null or char_length(return_reason) between 10 and 500),
  ended_by uuid references public.staff_profiles (user_id),
  ended_at timestamptz,
  end_reason text check (end_reason is null or char_length(end_reason) between 10 and 500),
  row_version integer not null default 1 check (row_version >= 1),
  updated_at timestamptz not null default now(),
  constraint rate_contracts_validity check (valid_from <= valid_to and valid_to - valid_from <= 1100),
  constraint rate_contracts_not_self_approved check (decided_by is distinct from entered_by),
  constraint rate_contracts_import_source check ((source = 'import') = (import_batch_id is not null)),
  constraint rate_contracts_decided check (status in ('draft', 'pending_approval')
                                           or (status = 'returned' and decided_by is not null and return_reason is not null)
                                           or (status in ('active', 'ended') and decided_by is not null and decided_at is not null)),
  constraint rate_contracts_ended check ((status = 'ended') = (ended_by is not null and ended_at is not null and end_reason is not null)),
  foreign key (legal_entity_id, supplier_id) references public.suppliers (legal_entity_id, id),
  foreign key (legal_entity_id, hotel_id) references public.hotel_catalogue (legal_entity_id, id),
  unique (legal_entity_id, id),
  unique (legal_entity_id, contract_no),
  unique (supplier_id, hotel_id, version_no)
);
create index rate_contracts_supplier_idx on public.rate_contracts (legal_entity_id, supplier_id);
create index rate_contracts_hotel_idx on public.rate_contracts (legal_entity_id, hotel_id);
create index rate_contracts_pair_idx on public.rate_contracts (supplier_id, hotel_id, status, valid_from);
create index rate_contracts_list_idx on public.rate_contracts (legal_entity_id, status, valid_to, id);
create index rate_contracts_active_end_idx on public.rate_contracts (valid_to) where status = 'active';
create index rate_contracts_import_batch_idx on public.rate_contracts (import_batch_id) where import_batch_id is not null;
create index rate_contracts_entered_by_idx on public.rate_contracts (entered_by);
create index rate_contracts_decided_by_idx on public.rate_contracts (decided_by) where decided_by is not null;
create index rate_contracts_ended_by_idx on public.rate_contracts (ended_by) where ended_by is not null;
comment on table public.rate_contracts is
  'Accounts phase 3 (LD21): supplier rate contract for one catalogue hotel. Purchase enters (draft, returned), a Manager of the entity who did not enter it approves; approving ends any overlapping active contract of the same supplier and hotel. Active contracts are never edited: a new sheet makes a new version. Supplier costs: Purchase, Manager and Accounts only. No Data API access.';

-- Status moves and the columns each state may change. Lines, blackouts and
-- files are guarded separately.
create function authz.rate_contracts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_fixed text[] := array['id', 'legal_entity_id', 'supplier_id', 'hotel_id', 'contract_no', 'version_no', 'source',
                          'import_batch_id', 'entered_by', 'entered_at'];
  v_changed text[];
begin
  if tg_op = 'DELETE' then
    raise exception 'rate contracts are never deleted' using errcode = '42501';
  end if;
  select coalesce(array_agg(n.key), '{}') into v_changed
  from jsonb_each(to_jsonb(new)) n
  where n.value is distinct from (to_jsonb(old) -> n.key);
  if v_changed && v_fixed then
    raise exception 'rate contract identity is immutable' using errcode = '42501';
  end if;
  if old.status = 'ended' then
    raise exception 'an ended rate contract is final' using errcode = '42501';
  end if;
  if old.status = 'active' and not (new.status = 'ended'
       and v_changed <@ array['status', 'ended_by', 'ended_at', 'end_reason', 'row_version', 'updated_at']) then
    raise exception 'an active rate contract is never edited; end it or enter a new version' using errcode = '42501';
  end if;
  if old.status = 'pending_approval' and not (new.status in ('active', 'returned')
       and v_changed <@ array['status', 'decided_by', 'decided_at', 'return_reason', 'row_version', 'updated_at']) then
    raise exception 'a rate contract waiting for approval is only approved or returned' using errcode = '42501';
  end if;
  if old.status in ('draft', 'returned') and new.status not in (old.status, 'pending_approval') then
    raise exception 'a draft rate contract is only sent for approval' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger rate_contracts_a_guard before update or delete on public.rate_contracts
  for each row execute function authz.rate_contracts_guard();

create table public.rate_contract_lines (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  contract_id uuid not null,
  line_no integer not null check (line_no between 1 and 500),
  season_from date not null,
  season_to date not null,
  room_type_id uuid not null,
  meal_plan text not null check (meal_plan in ('EP', 'CP', 'MAP', 'AP', 'AI')),
  rate_paise bigint not null check (rate_paise > 0),
  weekend_rate_paise bigint check (weekend_rate_paise is null or weekend_rate_paise > 0),
  extra_adult_paise bigint check (extra_adult_paise is null or extra_adult_paise >= 0),
  child_with_bed_paise bigint check (child_with_bed_paise is null or child_with_bed_paise >= 0),
  child_without_bed_paise bigint check (child_without_bed_paise is null or child_without_bed_paise >= 0),
  note text check (note is null or char_length(note) between 1 and 300),
  created_at timestamptz not null default now(),
  constraint rate_contract_lines_season check (season_from <= season_to),
  foreign key (legal_entity_id, contract_id) references public.rate_contracts (legal_entity_id, id),
  foreign key (legal_entity_id, room_type_id) references public.hotel_room_types (legal_entity_id, id),
  unique (contract_id, line_no)
);
create index rate_contract_lines_contract_idx on public.rate_contract_lines (legal_entity_id, contract_id);
create index rate_contract_lines_price_idx on public.rate_contract_lines (contract_id, room_type_id, meal_plan, season_from);
create index rate_contract_lines_room_type_idx on public.rate_contract_lines (legal_entity_id, room_type_id);
comment on table public.rate_contract_lines is
  'Accounts phase 3: rate lines of a contract (per room per night; weekend rate = Friday and Saturday nights). Replaced as a whole while the contract is draft or returned; never changed afterwards. No Data API access.';

create table public.rate_contract_blackouts (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  contract_id uuid not null,
  from_date date not null,
  to_date date not null,
  created_at timestamptz not null default now(),
  constraint rate_contract_blackouts_range check (from_date <= to_date),
  foreign key (legal_entity_id, contract_id) references public.rate_contracts (legal_entity_id, id)
);
create index rate_contract_blackouts_contract_idx on public.rate_contract_blackouts (legal_entity_id, contract_id);
create index rate_contract_blackouts_dates_idx on public.rate_contract_blackouts (contract_id, from_date);
comment on table public.rate_contract_blackouts is
  'Accounts phase 3: blackout dates of a contract (no contract rate on those nights). Same rule as the lines. No Data API access.';

-- Lines and blackouts: insert and delete only while the contract is draft or
-- returned (the command replaces them as a whole); never updated.
create function authz.rate_contract_children_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_contract uuid := case when tg_op = 'DELETE' then old.contract_id else new.contract_id end;
begin
  if tg_op = 'UPDATE' then
    raise exception '% rows are never updated; replace them while the contract is a draft', tg_table_name using errcode = '42501';
  end if;
  if not exists (select 1 from public.rate_contracts c where c.id = v_contract and c.status in ('draft', 'returned')) then
    raise exception '% change only while the contract is a draft', tg_table_name using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger rate_contract_lines_a_guard before insert or update or delete on public.rate_contract_lines
  for each row execute function authz.rate_contract_children_guard();
create trigger rate_contract_blackouts_a_guard before insert or update or delete on public.rate_contract_blackouts
  for each row execute function authz.rate_contract_children_guard();

create table public.rate_contract_files (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  contract_id uuid not null,
  object_path text not null unique,
  file_name text not null check (length(file_name) between 1 and 120 and file_name ~ '^[A-Za-z0-9._ -]+$'),
  mime text not null check (mime in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 4194304),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending_upload' check (status in ('pending_upload', 'stored', 'failed', 'removed')),
  uploaded_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  stored_at timestamptz,
  foreign key (legal_entity_id, contract_id) references public.rate_contracts (legal_entity_id, id),
  check (object_path = legal_entity_id::text || '/rate-contracts/' || contract_id::text || '/' || id::text)
);
create index rate_contract_files_contract_idx on public.rate_contract_files (legal_entity_id, contract_id);
create index rate_contract_files_contract_status_idx on public.rate_contract_files (contract_id, status);
create index rate_contract_files_uploaded_by_idx on public.rate_contract_files (uploaded_by);
comment on table public.rate_contract_files is
  'Accounts phase 3: contract files (private bucket purchase-evidence, path <entity>/rate-contracts/<contract>/<file>; statuses as purchase_evidence). Never deleted. No Data API access.';

create function authz.rate_contract_files_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'rate contract files are never deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['status', 'updated_at', 'stored_at']) is distinct from
     (to_jsonb(old) - array['status', 'updated_at', 'stored_at']) then
    raise exception 'rate contract file identity is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger rate_contract_files_a_guard before update or delete on public.rate_contract_files
  for each row execute function authz.rate_contract_files_guard();

-- Expiry alerts (timer task rate_contract_expiry, 0520). Track N reads the
-- inserts (notice 60, contract_ending). Append-only.
create table public.rate_contract_alerts (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  contract_id uuid not null,
  days_left integer not null check (days_left in (30, 7)),
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, contract_id) references public.rate_contracts (legal_entity_id, id),
  unique (contract_id, days_left)
);
create index rate_contract_alerts_contract_idx on public.rate_contract_alerts (legal_entity_id, contract_id);
create index rate_contract_alerts_created_idx on public.rate_contract_alerts (created_at desc);
comment on table public.rate_contract_alerts is
  'Accounts phase 3: one row when an active contract has exactly 30 or 7 days left (India date) and no later active contract of the same supplier and hotel. Source of notice 60 (track N). Append-only.';

create function authz.rate_contract_alerts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'rate contract alerts are append-only' using errcode = '42501';
end;
$$;
create trigger rate_contract_alerts_a_guard before update or delete on public.rate_contract_alerts
  for each row execute function authz.rate_contract_alerts_guard();

create function authz.rate_contract_counters_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' or new.last_no < old.last_no or new.legal_entity_id <> old.legal_entity_id or new.year <> old.year then
    raise exception 'rate contract numbers only move forward' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger rate_contract_counters_a_guard before update or delete on public.rate_contract_counters
  for each row execute function authz.rate_contract_counters_guard();

do $$
declare
  t text;
begin
  foreach t in array array['hotel_room_types', 'rate_contract_counters', 'rate_contracts', 'rate_contract_lines',
                           'rate_contract_blackouts', 'rate_contract_files', 'rate_contract_alerts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    execute format('create trigger %I before truncate on public.%I for each statement execute function authz.refuse_settings_truncate()',
      t || '_no_truncate', t);
  end loop;
end;
$$;

-- ===========================================================================
-- 5. Purchase offers: room type, meal plan and the contract comparison (E9)
-- ===========================================================================

alter table public.purchase_quotes
  add column room_type_id uuid,
  add column meal_plan_code text check (meal_plan_code is null or meal_plan_code in ('EP', 'CP', 'MAP', 'AP', 'AI')),
  add column rate_contract_id uuid,
  add column contract_total_paise bigint check (contract_total_paise is null or contract_total_paise > 0),
  add column contract_state text not null default 'none' check (contract_state in ('none', 'matches', 'differs', 'ended')),
  add column contract_deviation_reason text
    check (contract_deviation_reason is null or char_length(contract_deviation_reason) between 10 and 300);
alter table public.purchase_quotes
  add constraint purchase_quotes_room_type_fkey foreign key (legal_entity_id, room_type_id)
    references public.hotel_room_types (legal_entity_id, id),
  add constraint purchase_quotes_rate_contract_fkey foreign key (legal_entity_id, rate_contract_id)
    references public.rate_contracts (legal_entity_id, id),
  add constraint purchase_quotes_contract_deviation check ((contract_state = 'differs') = (contract_deviation_reason is not null)),
  add constraint purchase_quotes_contract_total check (contract_state in ('matches', 'differs')
                                                       or (contract_total_paise is null and rate_contract_id is null));
create index purchase_quotes_room_type_idx on public.purchase_quotes (legal_entity_id, room_type_id) where room_type_id is not null;
create index purchase_quotes_rate_contract_idx on public.purchase_quotes (legal_entity_id, rate_contract_id)
  where rate_contract_id is not null;
comment on column public.purchase_quotes.contract_state is
  'Accounts phase 3 (E9): none | matches (quoted cost = contract total for the stay) | differs (contract_deviation_reason required) | ended (the contract ended before the stay). Set once by purchase_quote_add; quotes are immutable.';

-- ===========================================================================
-- 6. Import kind 'rate_sheet' (9.4)
-- ===========================================================================

alter table public.import_batches drop constraint import_batches_kind_check;
alter table public.import_batches
  add constraint import_batches_kind_check check (kind in ('hotel', 'customer', 'supplier', 'rate_sheet'));

-- ===========================================================================
-- 7. Readers and locks
-- ===========================================================================

-- Section 14: Purchase (enter, read), Manager (approve, end, read), Accounts
-- (read) of the entity. Flight and Visa never read rate contracts: a Manager or
-- Accounts person who also holds Flight or Visa in the entity counts only as
-- what else they hold (Phase 1 rule "M with P/F/V is not M", applied to A as
-- well; Purchase holders read as Purchase). Answers {p, m, a} for one entity.
create function authz.rc_reader(p_entity uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'p', coalesce(authz.session_ok() and authz.holds_active_role('purchase', p_entity), false),
    'm', coalesce(authz.session_ok() and authz.holds_active_role('manager', p_entity) and not x.fv, false),
    'a', coalesce(authz.session_ok() and authz.holds_active_role('accounts', p_entity) and not x.fv, false))
  from (select exists (select 1 from public.memberships m
                       where m.user_id = (select auth.uid()) and m.legal_entity_id = p_entity
                         and m.role_code in ('flight', 'visa') and m.status = 'active') as fv) x
$$;

create function authz.rc_can_read(p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (r ->> 'p')::boolean or (r ->> 'm')::boolean or (r ->> 'a')::boolean from (select authz.rc_reader(p_entity) as r) x
$$;

-- Approver of a rate contract (section 4): an active Manager of the entity who
-- holds neither Flight nor Visa there (the self check is the command's).
create function authz.rc_approver(p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select (authz.rc_reader(p_entity) ->> 'm')::boolean
$$;

-- Lock order 17.1 step 5: one supplier + hotel pair (transaction advisory lock).
create function authz.rc_lock_pair(p_supplier uuid, p_hotel uuid) returns void
language sql volatile set search_path = '' as $$
  select pg_advisory_xact_lock(hashtextextended('tripnavigate.rate_contract:' || p_supplier::text || ':' || p_hotel::text, 0))
$$;

revoke all on function authz.rate_contracts_enabled(), authz.rc_date(text), authz.rc_rupees_paise(text), authz.rc_paise(jsonb),
  authz.rc_meal_code(text), authz.rc_meal_label(text), authz.rc_blackouts(text), authz.hotel_room_types_guard(),
  authz.rate_contracts_guard(), authz.rate_contract_children_guard(), authz.rate_contract_files_guard(),
  authz.rate_contract_alerts_guard(), authz.rate_contract_counters_guard(), authz.rc_reader(uuid), authz.rc_can_read(uuid), authz.rc_approver(uuid),
  authz.rc_lock_pair(uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function public.admin_set_rate_contracts_enabled(boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.admin_set_rate_contracts_enabled(boolean, text) to authenticated;

commit;
