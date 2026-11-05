-- TripNavigate CRM - Phase 3: accepted hotel booking version -> one Purchase task.
--
-- Contract: docs/implementation/phase-3/contract.md (sections 3-7, 11).
--
-- What changes:
--   * public.booking_settings: single row, real_booking_enabled default false,
--     evidence_max_bytes 4 MiB (A2). Staff read it; no API grant writes it (P3-D5).
--   * public.booking_versions (facts; draft|confirmed; one draft and one
--     confirmed per deal), public.booking_version_commercials (selling total,
--     never readable by Purchase), public.booking_evidence (proof files),
--     public.fulfilment_tasks (no commercial columns), public.outbox_events
--     (ids only; service_role select only).
--   * Immutability triggers: a confirmed version, its commercial row and its
--     evidence rows refuse UPDATE/DELETE (and INSERT for children) with 42501,
--     whoever runs the statement (commands, definer code, the table owner).
--   * authz.booking_content_hash(version) = sha256 hex of the jsonb of every
--     fact column (budget included) + commercial_revision + the id-sorted
--     [evidence id, sha256] pairs of stored evidence (contract 3.1 as amended
--     by A4 H1/L1). The selling total is NOT hashed: commercial_revision, a
--     random uuid redrawn whenever the selling total changes, stands in for it
--     and is never readable (column grant excludes it; no read function
--     returns it). Stored in booking_versions.content_hash and recomputed by
--     trigger on every version, commercial or evidence change.
--   * Authorization helpers (contract 4), commands (contract 5), read functions.
--   * Permissions booking.manage_draft, booking.confirm, purchase_task.read
--     (role-derived, not grantable). permissions.code check is widened so a
--     first segment may contain '_' (purchase_task.read).
--   * Private Storage bucket booking-evidence (4 MiB per A2, pdf/jpeg/png/webp).
--     No storage.objects policy is created, so anon/authenticated have no
--     direct object access; the server uploads/signs with the secret key only
--     after the database authorized the caller.
--   * deals gains unique (legal_entity_id, branch_id, id) as the composite FK
--     target that pins booking rows and tasks to the deal's entity AND branch.
--
-- Error contract (message is exactly the token; contract section 5):
--   42501 not_authorized | 40001 version_changed, task_conflict |
--   55000 booking_disabled, not_ready, environment_unset, already_confirmed |
--   22023 invalid_input, evidence_rejected | P0002 not_found
--
-- Commands (security definer, search_path '', execute granted to authenticated
-- only; every command audits in the same transaction; audit details never hold
-- amounts):
--   booking_open_draft(p_deal_id uuid)
--     -> {versionId, versionNo, rowVersion, created}
--   booking_save_draft(p_version_id uuid, p_expected_row_version int,
--                      p_facts jsonb, p_selling_total_paise bigint,
--                      p_selling_total_provided boolean)            (A4 M3; no 4-arg overload)
--     -> {versionId, rowVersion, contentHash}
--     p_facts must be an object with EXACTLY the 12 BookingFacts keys
--     (hotelName, city, checkIn, checkOut, rooms, roomType, mealPlan, adults,
--     children, inclusions, specialRequests, purchaseBudgetPaise); each value
--     may be null. Strings are trimmed ('' -> null). Dates 'YYYY-MM-DD'.
--     purchaseBudgetPaise: decimal string (or JSON integer). Unknown or missing
--     keys, wrong types, out-of-range values -> invalid_input.
--     p_selling_total_provided (A4 M3, supersedes A1): false -> the commercial
--     row is untouched (p_selling_total_paise ignored); true -> requires
--     authz.can_read_deal_commercial (else not_authorized), then null clears
--     and a value (>= 0) sets it; null flag -> invalid_input.
--   booking_begin_evidence(p_version_id uuid, p_kind text, p_file_name text,
--                          p_mime text, p_size_bytes int, p_sha256 text)
--     -> {evidenceId, objectPath}   (objectPath = <entity>/<deal>/<version>/<evidence>)
--   booking_finish_evidence(p_evidence_id uuid, p_ok boolean) -> {evidenceId, status}
--     A4 H2: p_ok=true stores only if storage.objects has bucket_id
--     'booking-evidence', name = object_path and metadata.size = size_bytes;
--     otherwise the row becomes 'failed' and status 'failed' is returned.
--   booking_remove_evidence(p_evidence_id uuid) -> {evidenceId, status:'removed'}
--   booking_authorize_evidence_download(p_evidence_id uuid) -> {objectPath, fileName, mime}
--     A4 M2: requires authz.can_read_booking_evidence = can_edit_booking_draft
--     OR can_confirm_booking.
--   booking_readiness(p_version_id uuid) -> {ready, issues[], contentHash}   (no audit; read-only)
--     A4 L4: callers without commercial scope get 'missing_selling_total_ask_owner'
--     instead of 'missing_selling_total' (also in booking_panel). Confirmation
--     and booking_health use the real check.
--   booking_confirm(p_version_id uuid, p_expected_content_hash text)
--     -> {outcome:'created'|'existing', taskId, versionId}
--   purchase_task_claim(p_task_id uuid) -> {taskId, status, assignedToYou:true, alreadyYours}
--
-- Read functions (security definer, stable, authenticated only; raise
-- not_authorized without a valid staff session):
--   booking_panel(p_deal_id uuid) -> jsonb | null
--     null unless authz.can_read_booking (deal reader without the purchase role;
--     Purchase uses purchase_task_*).
--     {
--       dealId, canEdit, canConfirm,
--       gate: {realBookingEnabled, environment},
--       version: null | {versionId, versionNo, status, rowVersion, contentHash,
--                        facts: {<12 BookingFacts keys>; purchaseBudgetPaise as string},
--                        sellingTotalPaise   -- key PRESENT only when
--                                            -- authz.can_read_deal_commercial;
--                                            -- decimal string or null
--                        confirmedAt, confirmedByName},
--       readiness: null | {ready, issues[], contentHash}   -- null for none/confirmed
--       evidence: [{id, kind, fileName, mime, sizeBytes, status, uploadedByYou,
--                   createdAt, storedAt}]                  -- 'removed' rows omitted;
--                                                          -- [] unless can_read_booking_evidence (A4 M2)
--       task: null | {taskId, status, assigneeName}
--     }
--     canEdit: no confirmed version and authz.can_edit_booking_draft.
--     canConfirm: a draft exists and authz.can_confirm_booking (readiness not
--     considered). When canEdit && !canConfirm the UI uses
--     ERROR_TEXT.not_authorized wording as the blocked reason.
--   purchase_task_list() -> jsonb array (never null) of
--     {taskId, dealReference, hotelName, city, checkIn, checkOut, nights, rooms,
--      adults, children, purchaseBudgetPaise (string), status, assigneeName,
--      assignedToYou, branchName, createdAt}
--     ordered newest first; rows = tasks where authz.can_read_purchase_task.
--   purchase_task_get(p_task_id uuid) -> jsonb | null (null = not found or not visible)
--     the list keys plus {roomType, mealPlan, inclusions, specialRequests,
--     confirmedAt, confirmedByName, versionNo, canClaim}
--     canClaim = authz.can_claim_purchase_task and the task has no assignee.
--   booking_health() -> {realBookingEnabled, environment, drafts,
--     draftsNeedingRepair, confirmed, tasksNotStarted, tasksInProgress,
--     pendingOutboxEvents}
--     Caller needs integration.manage (entity scope); counts cover the
--     entities the caller administers.
--   None of the read functions returns a selling price to Purchase, and the
--   Purchase functions never return selling price, margin or evidence.
--
-- Rollback / recovery (forward-only):
--   Not reversed in place. Fastest safe stop: keep booking_settings
--   .real_booking_enabled = false (default) and/or set
--   deployment_settings.environment = 'unset'; confirmation then refuses.
--   An emergency rollback is a NEW migration that revokes execute on the
--   booking_* / purchase_task_* functions from authenticated. Confirmed
--   versions, tasks, outbox rows and audit_events are kept (export, never
--   delete); never relax a Phase 1/1.5/2 policy as rollback.

begin;

-- ---------------------------------------------------------------------------
-- Settings
-- ---------------------------------------------------------------------------

create table public.booking_settings (
  id boolean primary key default true check (id),
  real_booking_enabled boolean not null default false,
  evidence_max_bytes integer not null default 4194304 check (evidence_max_bytes between 1 and 4194304),
  updated_at timestamptz not null default now()
);
comment on table public.booking_settings is
  'Single-row booking gate. Real (Bitrix) deals confirm only when real_booking_enabled (owner SQL only; no API write).';
insert into public.booking_settings (id, real_booking_enabled, evidence_max_bytes) values (true, false, 4194304);

-- Composite FK target: entity + branch + deal.
alter table public.deals add constraint deals_entity_branch_id_unique unique (legal_entity_id, branch_id, id);

-- ---------------------------------------------------------------------------
-- Booking versions and commercials
-- ---------------------------------------------------------------------------

create table public.booking_versions (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null,
  legal_entity_id uuid not null,
  branch_id uuid not null,
  version_no integer not null check (version_no >= 1),
  status text not null default 'draft' check (status in ('draft', 'confirmed')),
  service_type text not null default 'hotel' check (service_type = 'hotel'),
  row_version integer not null default 1 check (row_version >= 1),
  hotel_name text check (length(hotel_name) between 1 and 200),
  city text check (length(city) between 1 and 120),
  check_in date check (check_in between date '2000-01-01' and date '2100-12-31'),
  check_out date check (check_out between date '2000-01-01' and date '2100-12-31'),
  rooms integer check (rooms between 1 and 50),
  room_type text check (length(room_type) between 1 and 120),
  meal_plan text check (length(meal_plan) between 1 and 60),
  adults integer check (adults between 1 and 100),
  children integer check (children between 0 and 100),
  inclusions text check (length(inclusions) between 1 and 2000),
  special_requests text check (length(special_requests) between 1 and 2000),
  purchase_budget_paise bigint check (purchase_budget_paise >= 0),
  -- A4 H1: random token regenerated whenever the selling total changes. It is
  -- hashed instead of the selling total and is never readable (no column grant,
  -- no read function), so the hash cannot be brute-forced for the amount.
  commercial_revision uuid not null default gen_random_uuid(),
  content_hash text not null check (content_hash ~ '^[0-9a-f]{64}$'),
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  confirmed_by uuid references public.staff_profiles (user_id),
  confirmed_at timestamptz,
  confirmed_deal_source_modified_at timestamptz,
  foreign key (legal_entity_id, branch_id, deal_id) references public.deals (legal_entity_id, branch_id, id),
  unique (deal_id, version_no),
  unique (legal_entity_id, id),
  unique (legal_entity_id, deal_id, id),
  check ((status = 'confirmed') = (confirmed_at is not null)),
  check ((confirmed_at is null) = (confirmed_by is null))
);
create unique index booking_versions_one_draft on public.booking_versions (deal_id) where status = 'draft';
create unique index booking_versions_one_confirmed on public.booking_versions (deal_id) where status = 'confirmed';
create index booking_versions_entity_status_idx on public.booking_versions (legal_entity_id, status);
comment on table public.booking_versions is
  'Hotel booking facts per deal. Draft is editable through commands; confirmed is immutable.';

create table public.booking_version_commercials (
  version_id uuid primary key,
  legal_entity_id uuid not null,
  selling_total_paise bigint not null check (selling_total_paise >= 0),
  currency char(3) not null default 'INR' check (currency = 'INR'),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, version_id) references public.booking_versions (legal_entity_id, id)
);
comment on table public.booking_version_commercials is
  'Selling total of a booking version. Readable only with deal.read_commercial; Purchase never reads it.';

-- Canonical hash (contract 3.1 as amended by A4 H1): every fact column
-- (budget included) + commercial_revision + the id-sorted [evidence id, sha256]
-- pairs of STORED evidence. The selling total itself is not hashed.
-- Key order is jsonb's own.
create function authz.booking_hash(
  p_hotel_name text, p_city text, p_check_in date, p_check_out date, p_rooms integer,
  p_room_type text, p_meal_plan text, p_adults integer, p_children integer, p_inclusions text,
  p_special_requests text, p_purchase_budget_paise bigint, p_commercial_revision uuid, p_stored_evidence jsonb
) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'hotel_name', p_hotel_name,
    'city', p_city,
    'check_in', p_check_in,
    'check_out', p_check_out,
    'rooms', p_rooms,
    'room_type', p_room_type,
    'meal_plan', p_meal_plan,
    'adults', p_adults,
    'children', p_children,
    'inclusions', p_inclusions,
    'special_requests', p_special_requests,
    'purchase_budget_paise', p_purchase_budget_paise,
    'commercial_revision', p_commercial_revision,
    'stored_evidence', coalesce(p_stored_evidence, '[]'::jsonb)
  )::text, 'UTF8')), 'hex')
$$;

-- Trigger "a": confirmed rows are immutable; identity columns never change.
create function authz.booking_versions_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status = 'confirmed' then
      raise exception 'confirmed booking versions are immutable' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if old.status = 'confirmed' then
      raise exception 'confirmed booking versions are immutable' using errcode = '42501';
    end if;
    if new.id is distinct from old.id or new.deal_id is distinct from old.deal_id
       or new.legal_entity_id is distinct from old.legal_entity_id
       or new.branch_id is distinct from old.branch_id or new.version_no is distinct from old.version_no
       or new.service_type is distinct from old.service_type or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at then
      raise exception 'booking version identity columns are immutable' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- Trigger "b": recompute content_hash (plpgsql: booking_stored_evidence is defined below).
create function authz.booking_versions_hash() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.content_hash := authz.booking_hash(new.hotel_name, new.city, new.check_in, new.check_out, new.rooms,
    new.room_type, new.meal_plan, new.adults, new.children, new.inclusions, new.special_requests,
    new.purchase_budget_paise, new.commercial_revision, authz.booking_stored_evidence(new.id));
  return new;
end;
$$;

create trigger booking_versions_a_guard
  before update or delete on public.booking_versions
  for each row execute function authz.booking_versions_guard();
create trigger booking_versions_b_hash
  before insert or update on public.booking_versions
  for each row execute function authz.booking_versions_hash();

-- Commercial rows follow their version: refused once it is confirmed.
create function authz.booking_commercials_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_version uuid := case when tg_op = 'DELETE' then old.version_id else new.version_id end;
begin
  if exists (select 1 from public.booking_versions v where v.id = v_version and v.status = 'confirmed')
     or (tg_op = 'UPDATE' and exists (
       select 1 from public.booking_versions v where v.id = old.version_id and v.status = 'confirmed')) then
    raise exception 'commercials of a confirmed booking version are immutable' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.version_id is distinct from old.version_id
     or new.legal_entity_id is distinct from old.legal_entity_id) then
    raise exception 'booking commercial identity columns are immutable' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- After the selling total changes (insert, delete or a different value), a
-- new commercial_revision is drawn, which recomputes content_hash.
create function authz.booking_commercials_rehash() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and new.selling_total_paise = old.selling_total_paise then
    return null;
  end if;
  update public.booking_versions v set commercial_revision = gen_random_uuid()
  where v.id = case when tg_op = 'DELETE' then old.version_id else new.version_id end
    and v.status = 'draft';
  return null;
end;
$$;

create trigger booking_commercials_a_guard
  before insert or update or delete on public.booking_version_commercials
  for each row execute function authz.booking_commercials_guard();
create trigger booking_commercials_b_rehash
  after insert or update or delete on public.booking_version_commercials
  for each row execute function authz.booking_commercials_rehash();

-- ---------------------------------------------------------------------------
-- Evidence
-- ---------------------------------------------------------------------------

create table public.booking_evidence (
  id uuid primary key default gen_random_uuid(),
  version_id uuid not null,
  deal_id uuid not null,
  legal_entity_id uuid not null,
  kind text not null check (kind in ('acceptance_message', 'ticket', 'bill', 'payment_proof', 'other')),
  object_path text not null unique,
  file_name text not null check (length(file_name) between 1 and 120 and file_name ~ '^[A-Za-z0-9._ -]+$'),
  mime text not null check (mime in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 4194304),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending_upload' check (status in ('pending_upload', 'stored', 'failed', 'removed')),
  uploaded_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  stored_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, deal_id, version_id) references public.booking_versions (legal_entity_id, deal_id, id),
  -- Server-generated path; never taken from input.
  check (object_path = legal_entity_id::text || '/' || deal_id::text || '/' || version_id::text || '/' || id::text),
  check (status <> 'stored' or stored_at is not null)
);
create index booking_evidence_version_idx on public.booking_evidence (version_id, status);

create function authz.booking_evidence_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.booking_versions v
    where v.status = 'confirmed'
      and v.id in (case when tg_op = 'INSERT' then null else old.version_id end,
                   case when tg_op = 'DELETE' then null else new.version_id end)
  ) then
    raise exception 'evidence of a confirmed booking version is immutable' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (
       new.id is distinct from old.id or new.version_id is distinct from old.version_id
       or new.deal_id is distinct from old.deal_id or new.legal_entity_id is distinct from old.legal_entity_id
       or new.kind is distinct from old.kind or new.object_path is distinct from old.object_path
       or new.file_name is distinct from old.file_name or new.mime is distinct from old.mime
       or new.size_bytes is distinct from old.size_bytes or new.sha256 is distinct from old.sha256
       or new.uploaded_by is distinct from old.uploaded_by or new.created_at is distinct from old.created_at) then
    raise exception 'booking evidence identity columns are immutable' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;
create trigger booking_evidence_a_guard
  before insert or update or delete on public.booking_evidence
  for each row execute function authz.booking_evidence_guard();

-- Stored evidence set of a version, as hashed (A4 H1 / L1).
create function authz.booking_stored_evidence(p_version uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_array(e.id, e.sha256) order by e.id), '[]'::jsonb)
  from public.booking_evidence e
  where e.version_id = p_version and e.status = 'stored'
$$;

create function authz.booking_content_hash(p_version uuid) returns text
language sql stable security definer set search_path = '' as $$
  select authz.booking_hash(v.hotel_name, v.city, v.check_in, v.check_out, v.rooms, v.room_type,
    v.meal_plan, v.adults, v.children, v.inclusions, v.special_requests, v.purchase_budget_paise,
    v.commercial_revision, authz.booking_stored_evidence(v.id))
  from public.booking_versions v
  where v.id = p_version
$$;

-- Any evidence change refreshes the draft's content_hash (the stored set is hashed).
create function authz.booking_evidence_rehash() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  update public.booking_versions v set content_hash = v.content_hash
  where v.id = case when tg_op = 'DELETE' then old.version_id else new.version_id end
    and v.status = 'draft';
  return null;
end;
$$;
create trigger booking_evidence_b_rehash
  after insert or update or delete on public.booking_evidence
  for each row execute function authz.booking_evidence_rehash();

-- ---------------------------------------------------------------------------
-- Fulfilment tasks (no commercial columns) and outbox
-- ---------------------------------------------------------------------------

create table public.fulfilment_tasks (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null,
  legal_entity_id uuid not null,
  branch_id uuid not null,
  booking_version_id uuid not null,
  service_purpose text not null default 'hotel' check (service_purpose = 'hotel'),
  task_key text not null unique,
  status text not null default 'not_started' check (status in ('not_started', 'in_progress')),
  assignee_user_id uuid references public.staff_profiles (user_id),
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, branch_id, deal_id) references public.deals (legal_entity_id, branch_id, id),
  foreign key (legal_entity_id, deal_id, booking_version_id)
    references public.booking_versions (legal_entity_id, deal_id, id),
  unique (booking_version_id, service_purpose),
  check (task_key = 'booking:' || booking_version_id::text || ':' || service_purpose),
  check ((status = 'in_progress') = (assignee_user_id is not null))
);
create index fulfilment_tasks_entity_status_idx on public.fulfilment_tasks (legal_entity_id, status, created_at desc);
create index fulfilment_tasks_deal_idx on public.fulfilment_tasks (deal_id);
comment on table public.fulfilment_tasks is
  'Internal Purchase work created by a confirmed booking version. Never carries selling price or margin.';

create function authz.fulfilment_tasks_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'fulfilment tasks cannot be deleted' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.deal_id is distinct from old.deal_id
     or new.legal_entity_id is distinct from old.legal_entity_id or new.branch_id is distinct from old.branch_id
     or new.booking_version_id is distinct from old.booking_version_id
     or new.service_purpose is distinct from old.service_purpose or new.task_key is distinct from old.task_key
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'fulfilment task identity columns are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger fulfilment_tasks_a_guard
  before update or delete on public.fulfilment_tasks
  for each row execute function authz.fulfilment_tasks_guard();

create table public.outbox_events (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  aggregate_type text not null check (aggregate_type in ('booking_version', 'fulfilment_task')),
  aggregate_id uuid not null,
  event_type text not null check (event_type in ('booking.version_confirmed', 'fulfilment.task_created')),
  -- Identifiers, version_no and service_purpose only. Never amounts.
  payload jsonb not null check (
    jsonb_typeof(payload) = 'object'
    and (payload - array['version_id', 'deal_id', 'task_id', 'version_no', 'service_purpose']) = '{}'::jsonb),
  status text not null default 'pending' check (status = 'pending'),
  attempts integer not null default 0 check (attempts >= 0),
  created_at timestamptz not null default now(),
  unique (event_type, aggregate_id)
);
comment on table public.outbox_events is
  'Transactional outbox. No dispatcher in Phase 3. service_role may read; no API writes.';

-- ---------------------------------------------------------------------------
-- Permission catalogue (role-derived, not grantable)
-- ---------------------------------------------------------------------------

alter table public.permissions drop constraint permissions_code_check;
alter table public.permissions add constraint permissions_code_check
  check (code ~ '^[a-z][a-z_]*(\.[a-z_]+)+$');

insert into public.permissions (code, description, is_grantable) values
  ('booking.manage_draft', 'Create and edit the draft hotel booking of an owned/assigned deal; upload proof files.', false),
  ('booking.confirm', 'Confirm an accepted booking version and create the Purchase task (deal owner or branch Sales Manager).', false),
  ('purchase_task.read', 'See Purchase hotel tasks (service scope and approved budget only).', false);

insert into public.role_permissions (role_code, permission_code, scope, policy_status, note) values
  ('sales', 'booking.manage_draft', 'own', 'confirmed', 'P3-D1: owner or active Sales assignee'),
  ('manager', 'booking.manage_draft', 'own', 'confirmed', 'P3-D3a: Sales Manager of the deal''s branch'),
  ('sales', 'booking.confirm', 'own', 'confirmed', 'P3-D3: deal owner only'),
  ('manager', 'booking.confirm', 'own', 'confirmed', 'P3-D3a: Sales Manager of the deal''s branch'),
  ('purchase', 'purchase_task.read', 'entity', 'confirmed', 'P3-D4: centralised Purchase sees every hotel task in the entity');

-- ---------------------------------------------------------------------------
-- Authorization helpers (contract 4). All require a valid staff session.
-- ---------------------------------------------------------------------------

-- Active membership with p_role in an enabled entity and branch.
create function authz.holds_active_role(p_role text, p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.memberships m
    join public.legal_entities e on e.id = m.legal_entity_id
    join public.branches b on b.id = m.branch_id
    where m.user_id = (select auth.uid())
      and m.legal_entity_id = p_entity
      and m.role_code = p_role
      and m.status = 'active'
      and e.status = 'enabled'
      and b.status = 'enabled'
  )
$$;

-- P3-D3a (confirmed by owner, 2 Oct 2026): manager role with an active membership in the deal's branch.
create function authz.is_branch_sales_manager(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.deals d
    join public.memberships m on m.legal_entity_id = d.legal_entity_id and m.branch_id = d.branch_id
    join public.legal_entities e on e.id = m.legal_entity_id
    join public.branches b on b.id = m.branch_id
    where d.id = p_deal
      and m.user_id = (select auth.uid())
      and m.role_code = 'manager'
      and m.status = 'active'
      and e.status = 'enabled'
      and b.status = 'enabled'
  )
$$;

create function authz.can_edit_booking_draft(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.can_read_deal(p_deal) and exists (
    select 1 from public.deals d
    where d.id = p_deal
      and not authz.holds_role('purchase', d.legal_entity_id)
      and (
        ((d.owner_user_id = (select auth.uid())
          or exists (
            select 1 from public.deal_assignments a
            where a.deal_id = d.id and a.user_id = (select auth.uid())
              and a.assignment_kind = 'sales' and a.ended_at is null))
         and authz.holds_active_role('sales', d.legal_entity_id))
        or authz.is_branch_sales_manager(d.id)
      )
  )
$$;

create function authz.can_confirm_booking(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.can_read_deal(p_deal) and exists (
    select 1 from public.deals d
    where d.id = p_deal
      and not authz.holds_role('purchase', d.legal_entity_id)
      and (
        (d.owner_user_id = (select auth.uid()) and authz.holds_active_role('sales', d.legal_entity_id))
        or authz.is_branch_sales_manager(d.id)
      )
  )
$$;

-- Booking facts (booking_versions rows, booking_panel): deal readers who do
-- not hold the purchase role.
create function authz.can_read_booking(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.can_read_deal(p_deal) and exists (
    select 1 from public.deals d
    where d.id = p_deal and not authz.holds_role('purchase', d.legal_entity_id)
  )
$$;

-- A4 M2: proof files are listed/downloaded only by people who may edit or
-- confirm the booking (owner/assignee Sales, branch Sales Manager). Both
-- rules already exclude Purchase.
create function authz.can_read_booking_evidence(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.can_edit_booking_draft(p_deal) or authz.can_confirm_booking(p_deal)
$$;

-- RLS helper for booking_version_commercials (keyed by version).
create function authz.can_read_booking_commercial(p_version uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.booking_versions v
    where v.id = p_version and authz.can_read_deal_commercial(v.deal_id)
  )
$$;

create function authz.can_read_purchase_task(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task
      and (
        authz.holds_active_role('purchase', t.legal_entity_id)
        or (authz.can_read_deal(t.deal_id) and not authz.holds_role('purchase', t.legal_entity_id))
      )
  )
$$;

create function authz.can_claim_purchase_task(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task and authz.holds_active_role('purchase', t.legal_entity_id)
  )
$$;

-- Gate refusal for a deal: 'environment_unset', 'booking_disabled' or null.
create function authz.booking_gate_issue(p_deal uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when authz.deployment_environment() = 'unset' then 'environment_unset'
    when not d.is_synthetic
      and not coalesce((select s.real_booking_enabled from public.booking_settings s where s.id), false)
      then 'booking_disabled'
    when d.is_synthetic and authz.deployment_environment() <> 'test' then 'booking_disabled'
    else null
  end
  from public.deals d where d.id = p_deal
$$;

-- Readiness issue codes (contract 6), in contract order.
create function authz.booking_issues(p_version uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select array_remove(array[
    case when v.hotel_name is null then 'missing_hotel_name' end,
    case when v.city is null then 'missing_city' end,
    case when v.check_in is null or v.check_out is null then 'missing_dates' end,
    case when v.check_out <= v.check_in then 'check_out_not_after_check_in' end,
    case when v.rooms is null then 'missing_rooms' end,
    case when v.adults is null then 'missing_travellers' end,
    case when v.purchase_budget_paise is null then 'missing_purchase_budget' end,
    case when not exists (select 1 from public.booking_version_commercials c where c.version_id = v.id)
      then 'missing_selling_total' end,
    case when not exists (select 1 from public.booking_evidence e where e.version_id = v.id and e.status = 'stored')
      then 'missing_acceptance_proof' end,
    case when exists (select 1 from public.booking_evidence e where e.version_id = v.id and e.status = 'pending_upload')
      then 'evidence_upload_incomplete' end,
    -- STALE_SYNC_HOURS_PROPOSED = 24
    case when not d.is_synthetic
      and (d.last_verified_at is null or d.last_verified_at < now() - interval '24 hours')
      then 'source_not_recently_verified' end,
    case when authz.booking_gate_issue(d.id) = 'booking_disabled' then 'booking_disabled' end,
    case when authz.booking_gate_issue(d.id) = 'environment_unset' then 'environment_unset' end
  ], null)
  from public.booking_versions v
  join public.deals d on d.id = v.deal_id
  where v.id = p_version
$$;

-- A4 L4: what the CALLER sees. Without commercial scope the selling-total
-- item becomes 'missing_selling_total_ask_owner'. Confirmation and
-- booking_health use the raw authz.booking_issues.
create function authz.booking_issues_for_viewer(p_version uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select case when authz.can_read_deal_commercial(v.deal_id) then authz.booking_issues(v.id)
              else array_replace(authz.booking_issues(v.id), 'missing_selling_total', 'missing_selling_total_ask_owner')
         end
  from public.booking_versions v where v.id = p_version
$$;

-- Fact parsing for booking_save_draft. Every refusal is invalid_input (22023).
create function authz.booking_fact_text(p_facts jsonb, p_key text, p_max integer, p_multiline boolean)
returns text
language plpgsql immutable set search_path = '' as $$
declare
  v_value jsonb := p_facts -> p_key;
  v_text text;
begin
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v_value) <> 'string' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_text := btrim(v_value #>> '{}', E' \t\r\n');
  if v_text = '' then
    return null;
  end if;
  if length(v_text) > p_max
     or (p_multiline and v_text ~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]')
     or (not p_multiline and v_text ~ E'[\\x01-\\x1f\\x7f]') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  return v_text;
end;
$$;

create function authz.booking_fact_int(p_facts jsonb, p_key text, p_min integer, p_max integer)
returns integer
language plpgsql immutable set search_path = '' as $$
declare
  v_value jsonb := p_facts -> p_key;
begin
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v_value) <> 'number' or (v_value #>> '{}') !~ '^-?[0-9]{1,9}$'
     or (v_value #>> '{}')::integer not between p_min and p_max then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  return (v_value #>> '{}')::integer;
end;
$$;

create function authz.booking_fact_date(p_facts jsonb, p_key text) returns date
language plpgsql stable set search_path = '' as $$
declare
  v_value jsonb := p_facts -> p_key;
  v_date date;
begin
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v_value) <> 'string' or (v_value #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  begin
    v_date := (v_value #>> '{}')::date;
  exception when data_exception then
    raise exception 'invalid_input' using errcode = '22023';
  end;
  if to_char(v_date, 'YYYY-MM-DD') <> (v_value #>> '{}')
     or v_date not between date '2000-01-01' and date '2100-12-31' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  return v_date;
end;
$$;

create function authz.booking_fact_paise(p_facts jsonb, p_key text) returns bigint
language plpgsql immutable set search_path = '' as $$
declare
  v_value jsonb := p_facts -> p_key;
begin
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v_value) not in ('string', 'number') or (v_value #>> '{}') !~ '^(0|[1-9][0-9]{0,17})$' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  return (v_value #>> '{}')::bigint;
end;
$$;

-- JSON shapes shared by the read functions.
create function authz.booking_facts_json(p_version uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'hotelName', v.hotel_name,
    'city', v.city,
    'checkIn', to_char(v.check_in, 'YYYY-MM-DD'),
    'checkOut', to_char(v.check_out, 'YYYY-MM-DD'),
    'rooms', v.rooms,
    'roomType', v.room_type,
    'mealPlan', v.meal_plan,
    'adults', v.adults,
    'children', v.children,
    'inclusions', v.inclusions,
    'specialRequests', v.special_requests,
    'purchaseBudgetPaise', v.purchase_budget_paise::text)
  from public.booking_versions v where v.id = p_version
$$;

-- Purchase task DTO: task + non-commercial facts + purchase budget. NEVER the
-- selling total, margin or evidence.
create function authz.purchase_task_json(p_task uuid, p_detail boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'taskId', t.id,
    'dealReference', d.reference,
    'hotelName', v.hotel_name,
    'city', v.city,
    'checkIn', to_char(v.check_in, 'YYYY-MM-DD'),
    'checkOut', to_char(v.check_out, 'YYYY-MM-DD'),
    'nights', v.check_out - v.check_in,
    'rooms', v.rooms,
    'adults', v.adults,
    'children', coalesce(v.children, 0),
    'purchaseBudgetPaise', v.purchase_budget_paise::text,
    'status', t.status,
    'assigneeName', ap.display_name,
    'assignedToYou', t.assignee_user_id is not distinct from (select auth.uid()),
    'branchName', b.name,
    'createdAt', t.created_at
  ) || case when p_detail then jsonb_build_object(
    'roomType', v.room_type,
    'mealPlan', v.meal_plan,
    'inclusions', v.inclusions,
    'specialRequests', v.special_requests,
    'confirmedAt', v.confirmed_at,
    'confirmedByName', cp.display_name,
    'versionNo', v.version_no,
    'canClaim', authz.can_claim_purchase_task(t.id) and t.assignee_user_id is null
  ) else '{}'::jsonb end
  from public.fulfilment_tasks t
  join public.booking_versions v on v.id = t.booking_version_id
  join public.deals d on d.id = t.deal_id
  join public.branches b on b.id = t.branch_id
  left join public.staff_profiles ap on ap.user_id = t.assignee_user_id
  left join public.staff_profiles cp on cp.user_id = v.confirmed_by
  where t.id = p_task
$$;

revoke all on function
  authz.booking_hash(text, text, date, date, integer, text, text, integer, integer, text, text, bigint, uuid, jsonb),
  authz.booking_stored_evidence(uuid), authz.booking_evidence_rehash(),
  authz.booking_content_hash(uuid),
  authz.booking_versions_guard(), authz.booking_versions_hash(),
  authz.booking_commercials_guard(), authz.booking_commercials_rehash(),
  authz.booking_evidence_guard(), authz.fulfilment_tasks_guard(),
  authz.holds_active_role(text, uuid), authz.is_branch_sales_manager(uuid),
  authz.can_edit_booking_draft(uuid), authz.can_confirm_booking(uuid),
  authz.can_read_booking(uuid), authz.can_read_booking_evidence(uuid), authz.can_read_booking_commercial(uuid),
  authz.can_read_purchase_task(uuid), authz.can_claim_purchase_task(uuid),
  authz.booking_gate_issue(uuid), authz.booking_issues(uuid), authz.booking_issues_for_viewer(uuid),
  authz.booking_fact_text(jsonb, text, integer, boolean), authz.booking_fact_int(jsonb, text, integer, integer),
  authz.booking_fact_date(jsonb, text), authz.booking_fact_paise(jsonb, text),
  authz.booking_facts_json(uuid), authz.purchase_task_json(uuid, boolean)
from public, anon, authenticated;

-- RLS policies call these as the invoker.
grant execute on function
  authz.holds_active_role(text, uuid), authz.is_branch_sales_manager(uuid),
  authz.can_edit_booking_draft(uuid), authz.can_confirm_booking(uuid),
  authz.can_read_booking(uuid), authz.can_read_booking_evidence(uuid), authz.can_read_booking_commercial(uuid),
  authz.can_read_purchase_task(uuid), authz.can_claim_purchase_task(uuid)
to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security and grants
-- ---------------------------------------------------------------------------

alter table public.booking_settings enable row level security;
alter table public.booking_versions enable row level security;
alter table public.booking_version_commercials enable row level security;
alter table public.booking_evidence enable row level security;
alter table public.fulfilment_tasks enable row level security;
alter table public.outbox_events enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'booking_settings', 'booking_versions', 'booking_version_commercials', 'booking_evidence',
    'fulfilment_tasks', 'outbox_events'
  ] loop
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
  end loop;
end;
$$;

create policy staff_read on public.booking_settings
  for select to authenticated using ((select authz.is_active_staff()));
-- Booking facts: deal readers who do not hold the purchase role.
create policy scoped_read on public.booking_versions
  for select to authenticated using (authz.can_read_booking(deal_id));
create policy commercial_read on public.booking_version_commercials
  for select to authenticated using (authz.can_read_booking_commercial(version_id));
create policy scoped_read on public.booking_evidence
  for select to authenticated using (authz.can_read_booking_evidence(deal_id));
create policy scoped_read on public.fulfilment_tasks
  for select to authenticated using (authz.can_read_purchase_task(id));
-- outbox_events: no permissive policy for authenticated (and no grant).

revoke all on public.booking_settings, public.booking_versions, public.booking_version_commercials,
  public.booking_evidence, public.fulfilment_tasks, public.outbox_events
from public, anon, authenticated, service_role;
grant select on public.booking_settings, public.booking_version_commercials,
  public.booking_evidence, public.fulfilment_tasks
to authenticated;
-- A4 H1: column grant WITHOUT commercial_revision (select * is refused; name the columns).
grant select (id, deal_id, legal_entity_id, branch_id, version_no, status, service_type, row_version,
  hotel_name, city, check_in, check_out, rooms, room_type, meal_plan, adults, children, inclusions,
  special_requests, purchase_budget_paise, content_hash, created_by, created_at, updated_at,
  confirmed_by, confirmed_at, confirmed_deal_source_modified_at)
on public.booking_versions to authenticated, service_role;
-- Server-side operator reads only; every write goes through the commands.
grant select on public.booking_settings, public.booking_version_commercials,
  public.booking_evidence, public.fulfilment_tasks, public.outbox_events
to service_role;

-- ---------------------------------------------------------------------------
-- Commands (contract 5)
-- ---------------------------------------------------------------------------

create function public.booking_open_draft(p_deal_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_ver public.booking_versions%rowtype;
begin
  if p_deal_id is null or not authz.can_edit_booking_draft(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  -- Serializes concurrent opens for one deal.
  select * into v_deal from public.deals d where d.id = p_deal_id for no key update;
  if exists (select 1 from public.booking_versions v where v.deal_id = p_deal_id and v.status = 'confirmed') then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  select * into v_ver from public.booking_versions v where v.deal_id = p_deal_id and v.status = 'draft';
  if v_ver.id is not null then
    return jsonb_build_object('versionId', v_ver.id, 'versionNo', v_ver.version_no,
      'rowVersion', v_ver.row_version, 'created', false);
  end if;

  insert into public.booking_versions (deal_id, legal_entity_id, branch_id, version_no, created_by)
  values (v_deal.id, v_deal.legal_entity_id, v_deal.branch_id,
    coalesce((select max(v.version_no) from public.booking_versions v where v.deal_id = v_deal.id), 0) + 1,
    (select auth.uid()))
  returning * into v_ver;

  perform authz.write_audit('booking.draft_opened', v_deal.legal_entity_id, v_deal.branch_id,
    'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_deal.id, 'versionNo', v_ver.version_no));
  return jsonb_build_object('versionId', v_ver.id, 'versionNo', v_ver.version_no,
    'rowVersion', v_ver.row_version, 'created', true);
end;
$$;

create function public.booking_save_draft(
  p_version_id uuid, p_expected_row_version integer, p_facts jsonb, p_selling_total_paise bigint,
  p_selling_total_provided boolean
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_keys constant text[] := array['hotelName', 'city', 'checkIn', 'checkOut', 'rooms', 'roomType', 'mealPlan',
    'adults', 'children', 'inclusions', 'specialRequests', 'purchaseBudgetPaise'];
  v_hotel text; v_city text; v_in date; v_out date; v_rooms integer; v_room_type text; v_meal text;
  v_adults integer; v_children integer; v_incl text; v_req text; v_budget bigint;
begin
  select * into v_ver from public.booking_versions v where v.id = p_version_id for update;
  if v_ver.id is null or not authz.can_edit_booking_draft(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ver.status = 'confirmed' then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  if p_expected_row_version is null or p_expected_row_version <> v_ver.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if p_facts is null or jsonb_typeof(p_facts) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_facts) k where k <> all (v_keys))
     or exists (select 1 from unnest(v_keys) k where not (p_facts ? k)) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_selling_total_provided is null
     or (p_selling_total_provided and p_selling_total_paise is not null and p_selling_total_paise < 0) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- A4 M3: only a caller who may read the commercial value may send it.
  if p_selling_total_provided and not authz.can_read_deal_commercial(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  v_hotel := authz.booking_fact_text(p_facts, 'hotelName', 200, false);
  v_city := authz.booking_fact_text(p_facts, 'city', 120, false);
  v_in := authz.booking_fact_date(p_facts, 'checkIn');
  v_out := authz.booking_fact_date(p_facts, 'checkOut');
  v_rooms := authz.booking_fact_int(p_facts, 'rooms', 1, 50);
  v_room_type := authz.booking_fact_text(p_facts, 'roomType', 120, false);
  v_meal := authz.booking_fact_text(p_facts, 'mealPlan', 60, false);
  v_adults := authz.booking_fact_int(p_facts, 'adults', 1, 100);
  v_children := authz.booking_fact_int(p_facts, 'children', 0, 100);
  v_incl := authz.booking_fact_text(p_facts, 'inclusions', 2000, true);
  v_req := authz.booking_fact_text(p_facts, 'specialRequests', 2000, true);
  v_budget := authz.booking_fact_paise(p_facts, 'purchaseBudgetPaise');

  -- A4 M3 (supersedes A1): not provided -> the commercial row is untouched;
  -- provided -> null clears, a value sets (authorization checked above).
  if p_selling_total_provided then
    if p_selling_total_paise is null then
      delete from public.booking_version_commercials c where c.version_id = v_ver.id;
    else
      insert into public.booking_version_commercials (version_id, legal_entity_id, selling_total_paise)
      values (v_ver.id, v_ver.legal_entity_id, p_selling_total_paise)
      on conflict (version_id) do update
        set selling_total_paise = excluded.selling_total_paise, updated_at = now();
    end if;
  end if;

  update public.booking_versions v
  set hotel_name = v_hotel, city = v_city, check_in = v_in, check_out = v_out, rooms = v_rooms,
      room_type = v_room_type, meal_plan = v_meal, adults = v_adults, children = v_children,
      inclusions = v_incl, special_requests = v_req, purchase_budget_paise = v_budget,
      row_version = v.row_version + 1, updated_at = now()
  where v.id = v_ver.id
  returning * into v_ver;

  -- No amounts or customer content in the audit record.
  perform authz.write_audit('booking.draft_saved', v_ver.legal_entity_id, v_ver.branch_id,
    'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('versionId', v_ver.id, 'rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;

create function public.booking_begin_evidence(
  p_version_id uuid, p_kind text, p_file_name text, p_mime text, p_size_bytes integer, p_sha256 text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_name text;
  v_sha text := lower(btrim(coalesce(p_sha256, '')));
  v_max integer;
  v_id uuid := gen_random_uuid();
  v_path text;
begin
  select * into v_ver from public.booking_versions v where v.id = p_version_id for update;
  if v_ver.id is null or not authz.can_edit_booking_draft(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ver.status = 'confirmed' then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  if p_kind is null or p_kind not in ('acceptance_message', 'ticket', 'bill', 'payment_proof', 'other') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_name := btrim(left(btrim(regexp_replace(coalesce(p_file_name, ''), '[^A-Za-z0-9._ -]', '_', 'g')), 120));
  select s.evidence_max_bytes into v_max from public.booking_settings s where s.id;
  if v_name = '' or v_name ~ '^[. ]+$'
     or p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > coalesce(v_max, 0)
     or v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  if (select count(*) from public.booking_evidence e where e.version_id = v_ver.id and e.status <> 'removed') >= 10 then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  v_path := v_ver.legal_entity_id::text || '/' || v_ver.deal_id::text || '/' || v_ver.id::text || '/' || v_id::text;
  insert into public.booking_evidence
    (id, version_id, deal_id, legal_entity_id, kind, object_path, file_name, mime, size_bytes, sha256, uploaded_by)
  values (v_id, v_ver.id, v_ver.deal_id, v_ver.legal_entity_id, p_kind, v_path, v_name, p_mime, p_size_bytes,
    v_sha, (select auth.uid()));

  perform authz.write_audit('booking.evidence_started', v_ver.legal_entity_id, v_ver.branch_id,
    'booking_evidence', v_id, null,
    jsonb_build_object('versionId', v_ver.id, 'kind', p_kind, 'mime', p_mime, 'sizeBytes', p_size_bytes));
  return jsonb_build_object('evidenceId', v_id, 'objectPath', v_path);
end;
$$;

create function public.booking_finish_evidence(p_evidence_id uuid, p_ok boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ev public.booking_evidence%rowtype;
  v_ver public.booking_versions%rowtype;
  v_status text;
  v_missing boolean := false;
begin
  -- Lock order everywhere: version, then evidence.
  select * into v_ver from public.booking_versions v
  where v.id = (select e.version_id from public.booking_evidence e where e.id = p_evidence_id)
  for update;
  select * into v_ev from public.booking_evidence e where e.id = p_evidence_id for update;
  if v_ev.id is null or v_ver.id is null or v_ev.uploaded_by is distinct from (select auth.uid())
     or not authz.can_edit_booking_draft(v_ev.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ver.status = 'confirmed' then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  if p_ok is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_status := case when p_ok then 'stored' else 'failed' end;
  if v_ev.status <> 'pending_upload' then
    -- Repeats report the recorded outcome (finish(true) on a row that failed,
    -- e.g. object missing, stays 'failed'); stored -> failed is refused.
    if v_ev.status = v_status or (p_ok and v_ev.status = 'failed') then
      return jsonb_build_object('evidenceId', v_ev.id, 'status', v_ev.status);
    end if;
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  -- A4 H2: 'stored' only when Storage really holds the object at the
  -- server-generated path with the declared size. Otherwise the row fails.
  if p_ok and (to_regclass('storage.objects') is null or not exists (
       select 1 from storage.objects o
       where o.bucket_id = 'booking-evidence' and o.name = v_ev.object_path
         and (o.metadata ->> 'size') ~ '^[0-9]{1,18}$'
         and (o.metadata ->> 'size')::bigint = v_ev.size_bytes)) then
    v_status := 'failed';
    v_missing := true;
  end if;

  update public.booking_evidence e
  set status = v_status, stored_at = case when v_status = 'stored' then now() else null end, updated_at = now()
  where e.id = v_ev.id;

  perform authz.write_audit(case when v_status = 'stored' then 'booking.evidence_stored' else 'booking.evidence_failed' end,
    v_ver.legal_entity_id, v_ver.branch_id, 'booking_evidence', v_ev.id, null,
    jsonb_build_object('versionId', v_ver.id, 'objectMissing', v_missing));
  return jsonb_build_object('evidenceId', v_ev.id, 'status', v_status);
end;
$$;

create function public.booking_remove_evidence(p_evidence_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ev public.booking_evidence%rowtype;
  v_ver public.booking_versions%rowtype;
begin
  select * into v_ver from public.booking_versions v
  where v.id = (select e.version_id from public.booking_evidence e where e.id = p_evidence_id)
  for update;
  select * into v_ev from public.booking_evidence e where e.id = p_evidence_id for update;
  if v_ev.id is null or v_ver.id is null or not authz.can_edit_booking_draft(v_ev.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ver.status = 'confirmed' then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  if v_ev.status = 'removed' then
    return jsonb_build_object('evidenceId', v_ev.id, 'status', 'removed');
  end if;

  update public.booking_evidence e set status = 'removed', updated_at = now() where e.id = v_ev.id;

  perform authz.write_audit('booking.evidence_removed', v_ver.legal_entity_id, v_ver.branch_id,
    'booking_evidence', v_ev.id, null,
    jsonb_build_object('versionId', v_ver.id, 'previousStatus', v_ev.status));
  return jsonb_build_object('evidenceId', v_ev.id, 'status', 'removed');
end;
$$;

create function public.booking_authorize_evidence_download(p_evidence_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ev public.booking_evidence%rowtype;
  v_branch uuid;
begin
  select * into v_ev from public.booking_evidence e where e.id = p_evidence_id;
  if v_ev.id is null or not authz.can_read_booking_evidence(v_ev.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ev.status <> 'stored' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select d.branch_id into v_branch from public.deals d where d.id = v_ev.deal_id;
  perform authz.write_audit('booking.evidence_viewed', v_ev.legal_entity_id, v_branch,
    'booking_evidence', v_ev.id, null, jsonb_build_object('versionId', v_ev.version_id));
  return jsonb_build_object('objectPath', v_ev.object_path, 'fileName', v_ev.file_name, 'mime', v_ev.mime);
end;
$$;

-- Read-only and side-effect free.
create function public.booking_readiness(p_version_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_issues text[];
begin
  select * into v_ver from public.booking_versions v where v.id = p_version_id;
  if v_ver.id is null
     or not (authz.can_edit_booking_draft(v_ver.deal_id) or authz.can_confirm_booking(v_ver.deal_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_issues := authz.booking_issues_for_viewer(v_ver.id);
  return jsonb_build_object('ready', cardinality(v_issues) = 0, 'issues', to_jsonb(v_issues),
    'contentHash', authz.booking_content_hash(v_ver.id));
end;
$$;

-- Contract 5.1: one transaction.
create function public.booking_confirm(p_version_id uuid, p_expected_content_hash text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_deal public.deals%rowtype;
  v_task uuid;
  v_task_version uuid;
  v_key text;
  v_env text;
begin
  -- 1. Row lock: a concurrent confirmation waits here, then sees 'confirmed'.
  select * into v_ver from public.booking_versions v where v.id = p_version_id for update;
  -- 2. Existence is not revealed.
  if v_ver.id is null or not authz.can_confirm_booking(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- 3. Repeat / concurrent confirmation.
  if v_ver.status = 'confirmed' then
    select t.id into v_task from public.fulfilment_tasks t
    where t.booking_version_id = v_ver.id and t.service_purpose = 'hotel';
    if v_task is not null then
      return jsonb_build_object('outcome', 'existing', 'taskId', v_task, 'versionId', v_ver.id);
    end if;
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  -- 4. Optimistic check against the live hash.
  if p_expected_content_hash is null or p_expected_content_hash <> authz.booking_content_hash(v_ver.id) then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  -- 5. Gate.
  select * into v_deal from public.deals d where d.id = v_ver.deal_id;
  v_env := authz.deployment_environment();
  if v_env = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if not v_deal.is_synthetic
     and not coalesce((select s.real_booking_enabled from public.booking_settings s where s.id), false) then
    raise exception 'booking_disabled' using errcode = '55000';
  end if;
  if v_deal.is_synthetic and v_env <> 'test' then
    raise exception 'booking_disabled' using errcode = '55000';
  end if;
  -- 6. Readiness.
  if cardinality(authz.booking_issues(v_ver.id)) > 0 then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  -- 7. Freeze.
  update public.booking_versions v
  set status = 'confirmed', confirmed_by = (select auth.uid()), confirmed_at = now(),
      confirmed_deal_source_modified_at = v_deal.source_modified_at, updated_at = now()
  where v.id = v_ver.id
  returning * into v_ver;
  -- 8. Exactly one task per version.
  v_key := 'booking:' || v_ver.id::text || ':hotel';
  insert into public.fulfilment_tasks
    (deal_id, legal_entity_id, branch_id, booking_version_id, service_purpose, task_key, created_by)
  values (v_ver.deal_id, v_ver.legal_entity_id, v_ver.branch_id, v_ver.id, 'hotel', v_key, (select auth.uid()))
  on conflict (task_key) do nothing
  returning id into v_task;
  if v_task is null then
    select t.id, t.booking_version_id into v_task, v_task_version
    from public.fulfilment_tasks t where t.task_key = v_key;
    if v_task_version is distinct from v_ver.id then
      raise exception 'task_conflict' using errcode = '40001';
    end if;
  end if;
  -- 9. Outbox (ids only).
  insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
  values
    (v_ver.legal_entity_id, 'booking_version', v_ver.id, 'booking.version_confirmed',
     jsonb_build_object('version_id', v_ver.id, 'deal_id', v_ver.deal_id, 'task_id', v_task,
       'version_no', v_ver.version_no, 'service_purpose', 'hotel')),
    (v_ver.legal_entity_id, 'fulfilment_task', v_task, 'fulfilment.task_created',
     jsonb_build_object('task_id', v_task, 'version_id', v_ver.id, 'deal_id', v_ver.deal_id,
       'version_no', v_ver.version_no, 'service_purpose', 'hotel'))
  on conflict (event_type, aggregate_id) do nothing;
  -- 10. Audit: ids and version_no only.
  perform authz.write_audit('booking.version_confirmed', v_ver.legal_entity_id, v_ver.branch_id,
    'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'taskId', v_task));
  perform authz.write_audit('fulfilment.task_created', v_ver.legal_entity_id, v_ver.branch_id,
    'fulfilment_task', v_task, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no));
  -- 11.
  return jsonb_build_object('outcome', 'created', 'taskId', v_task, 'versionId', v_ver.id);
end;
$$;

create function public.purchase_task_claim(p_task_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_uid uuid := (select auth.uid());
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or not authz.can_claim_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_task.assignee_user_id = v_uid then
    return jsonb_build_object('taskId', v_task.id, 'status', v_task.status, 'assignedToYou', true,
      'alreadyYours', true);
  end if;
  if v_task.assignee_user_id is not null then
    raise exception 'task_conflict' using errcode = '40001';
  end if;

  update public.fulfilment_tasks t
  set assignee_user_id = v_uid, status = 'in_progress', updated_at = now()
  where t.id = v_task.id;
  insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
  values (v_task.deal_id, v_task.legal_entity_id, v_uid, 'purchase', v_uid)
  on conflict (deal_id, user_id, assignment_kind) where ended_at is null do nothing;

  perform authz.write_audit('fulfilment.task_claimed', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('dealId', v_task.deal_id, 'versionId', v_task.booking_version_id));
  return jsonb_build_object('taskId', v_task.id, 'status', 'in_progress', 'assignedToYou', true,
    'alreadyYours', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Read functions
-- ---------------------------------------------------------------------------

create function public.booking_panel(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_version jsonb;
  v_readiness jsonb;
  v_issues text[];
  v_evidence jsonb;
  v_task jsonb;
  v_can_edit boolean;
  v_can_confirm boolean;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Purchase role holders and non-readers get null (Purchase uses purchase_task_*).
  if p_deal_id is null or not authz.can_read_booking(p_deal_id) then
    return null;
  end if;

  select * into v_ver from public.booking_versions v
  where v.deal_id = p_deal_id
  order by (v.status = 'confirmed') desc, v.version_no desc
  limit 1;

  if v_ver.id is not null then
    v_version := jsonb_build_object(
      'versionId', v_ver.id,
      'versionNo', v_ver.version_no,
      'status', v_ver.status,
      'rowVersion', v_ver.row_version,
      'contentHash', v_ver.content_hash,
      'facts', authz.booking_facts_json(v_ver.id),
      'confirmedAt', v_ver.confirmed_at,
      'confirmedByName', (select p.display_name from public.staff_profiles p where p.user_id = v_ver.confirmed_by));
    if authz.can_read_deal_commercial(p_deal_id) then
      v_version := v_version || jsonb_build_object('sellingTotalPaise',
        (select c.selling_total_paise::text from public.booking_version_commercials c where c.version_id = v_ver.id));
    end if;
    if v_ver.status = 'draft' then
      v_issues := authz.booking_issues_for_viewer(v_ver.id);
      v_readiness := jsonb_build_object('ready', cardinality(v_issues) = 0, 'issues', to_jsonb(v_issues),
        'contentHash', v_ver.content_hash);
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', e.id,
        'kind', e.kind,
        'fileName', e.file_name,
        'mime', e.mime,
        'sizeBytes', e.size_bytes,
        'status', e.status,
        'uploadedByYou', e.uploaded_by = (select auth.uid()),
        'createdAt', e.created_at,
        'storedAt', e.stored_at) order by e.created_at, e.id), '[]'::jsonb)
    into v_evidence
    from public.booking_evidence e
    where e.version_id = v_ver.id and e.status <> 'removed'
      and authz.can_read_booking_evidence(p_deal_id);  -- A4 M2
    select jsonb_build_object('taskId', t.id, 'status', t.status, 'assigneeName', p.display_name)
    into v_task
    from public.fulfilment_tasks t
    left join public.staff_profiles p on p.user_id = t.assignee_user_id
    where t.booking_version_id = v_ver.id;
  end if;

  v_can_edit := coalesce(v_ver.status, 'draft') = 'draft' and authz.can_edit_booking_draft(p_deal_id);
  v_can_confirm := v_ver.status = 'draft' and authz.can_confirm_booking(p_deal_id);

  return jsonb_build_object(
    'dealId', p_deal_id,
    'canEdit', coalesce(v_can_edit, false),
    'canConfirm', coalesce(v_can_confirm, false),
    'gate', jsonb_build_object(
      'realBookingEnabled', coalesce((select s.real_booking_enabled from public.booking_settings s where s.id), false),
      'environment', authz.deployment_environment()),
    'version', v_version,
    'readiness', v_readiness,
    'evidence', coalesce(v_evidence, '[]'::jsonb),
    -- Re-review M-NEW-1: tells the UI the list was withheld, not empty.
    'evidenceVisible', authz.can_read_booking_evidence(p_deal_id),
    'task', v_task);
end;
$$;

create function public.purchase_task_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(authz.purchase_task_json(t.id, false) order by t.created_at desc, t.id)
    from public.fulfilment_tasks t
    where authz.can_read_purchase_task(t.id)
  ), '[]'::jsonb);
end;
$$;

create function public.purchase_task_get(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_task_id is null or not authz.can_read_purchase_task(p_task_id) then
    return null;
  end if;
  return authz.purchase_task_json(p_task_id, true);
end;
$$;

create function public.booking_health() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_entities uuid[];
  v_drafts integer;
  v_repair integer;
begin
  if not authz.can_admin_any('integration.manage') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select coalesce(array_agg(distinct m.legal_entity_id), '{}') into v_entities
  from public.memberships m
  where m.user_id = (select auth.uid()) and m.status = 'active'
    and authz.can_admin('integration.manage', m.legal_entity_id);

  select count(*), count(*) filter (where cardinality(authz.booking_issues(v.id)) > 0)
  into v_drafts, v_repair
  from public.booking_versions v
  where v.status = 'draft' and v.legal_entity_id = any (v_entities);

  return jsonb_build_object(
    'realBookingEnabled', coalesce((select s.real_booking_enabled from public.booking_settings s where s.id), false),
    'environment', authz.deployment_environment(),
    'drafts', v_drafts,
    'draftsNeedingRepair', v_repair,
    'confirmed', (select count(*) from public.booking_versions v
                  where v.status = 'confirmed' and v.legal_entity_id = any (v_entities)),
    'tasksNotStarted', (select count(*) from public.fulfilment_tasks t
                        where t.status = 'not_started' and t.legal_entity_id = any (v_entities)),
    'tasksInProgress', (select count(*) from public.fulfilment_tasks t
                        where t.status = 'in_progress' and t.legal_entity_id = any (v_entities)),
    'pendingOutboxEvents', (select count(*) from public.outbox_events o
                            where o.status = 'pending' and o.legal_entity_id = any (v_entities)));
end;
$$;

revoke all on function
  public.booking_open_draft(uuid),
  public.booking_save_draft(uuid, integer, jsonb, bigint, boolean),
  public.booking_begin_evidence(uuid, text, text, text, integer, text),
  public.booking_finish_evidence(uuid, boolean),
  public.booking_remove_evidence(uuid),
  public.booking_authorize_evidence_download(uuid),
  public.booking_readiness(uuid),
  public.booking_confirm(uuid, text),
  public.purchase_task_claim(uuid),
  public.booking_panel(uuid),
  public.purchase_task_list(),
  public.purchase_task_get(uuid),
  public.booking_health()
from public, anon, authenticated, service_role;

grant execute on function
  public.booking_open_draft(uuid),
  public.booking_save_draft(uuid, integer, jsonb, bigint, boolean),
  public.booking_begin_evidence(uuid, text, text, text, integer, text),
  public.booking_finish_evidence(uuid, boolean),
  public.booking_remove_evidence(uuid),
  public.booking_authorize_evidence_download(uuid),
  public.booking_readiness(uuid),
  public.booking_confirm(uuid, text),
  public.purchase_task_claim(uuid),
  public.booking_panel(uuid),
  public.purchase_task_list(),
  public.purchase_task_get(uuid),
  public.booking_health()
to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: private evidence bucket (contract 7). Guarded so a database
-- without the Storage schema (the PGlite test shim stubs it) still migrates.
-- No storage.objects policy is created: anon/authenticated get no direct
-- access; the server uses the secret key after DB authorization.
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('booking-evidence', 'booking-evidence', false, 4194304,
      array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;

commit;
