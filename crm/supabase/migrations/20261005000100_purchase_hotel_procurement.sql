-- Phase 4: local Purchase hotel procurement slice.
-- Contract: docs/implementation/phase-4/contract.md (frozen 3 Oct 2026).
--
-- Adds: supplier register (with append-only, unverified beneficiary revisions),
-- supplier quotes, append-only proposed/committed cost versions, private
-- Purchase evidence, and the supplier-confirmed task state. A claimed task is
-- not a booked hotel; only purchase_supplier_confirm moves a task to
-- 'supplier_confirmed', and only for synthetic tasks in the 'test'
-- environment until procurement_settings.live_supplier_confirmation_enabled
-- is turned on by a later, owner-approved change (no API grant writes it).
--
-- Never exposed to Purchase: selling price, margin, commercial revision or
-- booking acceptance proof. Never exposed to Sales: suppliers, quotes, costs,
-- beneficiary details or Purchase files (cost + selling price reveals margin).
-- Nothing here creates a payable, payment or invoice.
--
-- Open business decisions (implemented as safe defaults): P4-D1 supplier
-- verification, P4-D2 over-budget approval, P4-D3 supplier proof standard,
-- P4-D4 beneficiary approval, P4-D5 release/reassignment, P4-D6 Sales view.
--
-- Rollback / recovery (forward-only): keep the procurement gate off and/or set
-- deployment_settings.environment = 'unset'; every write command then refuses.
-- An emergency rollback is a NEW migration revoking execute on the supplier_*
-- and purchase_* functions from authenticated. Never delete cost versions,
-- beneficiary revisions or audit rows.

begin;

-- ---------------------------------------------------------------------------
-- Settings (P4-D7)
-- ---------------------------------------------------------------------------

create table public.procurement_settings (
  id boolean primary key default true check (id),
  live_supplier_confirmation_enabled boolean not null default false,
  updated_at timestamptz not null default now()
);
insert into public.procurement_settings (id) values (true);
comment on table public.procurement_settings is
  'Single row. live_supplier_confirmation_enabled stays false until the owner approves P4-D1..D4; no API role writes it.';

-- ---------------------------------------------------------------------------
-- Suppliers
-- ---------------------------------------------------------------------------

create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  name text not null check (length(name) between 1 and 200),
  service_types text[] not null
    check (cardinality(service_types) between 1 and 3 and service_types <@ array['hotel', 'transfer', 'activity']),
  city text check (city is null or length(city) between 1 and 120),
  contact_name text check (contact_name is null or length(contact_name) between 1 and 120),
  contact_phone text check (contact_phone is null or contact_phone ~ '^[0-9+() -]{6,40}$'),
  contact_email text check (contact_email is null
    or (length(contact_email) <= 254 and contact_email ~ '^[^@[:space:]]{1,64}@[^@[:space:]]+\.[^@[:space:]]{2,}$')),
  payment_terms text check (payment_terms is null or length(payment_terms) between 1 and 1000),
  -- P4-D1 open: no command sets 'verified'.
  verification_status text not null default 'unverified' check (verification_status in ('unverified', 'verified')),
  status text not null default 'active' check (status in ('active', 'archived')),
  row_version integer not null default 1 check (row_version >= 1),
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_by uuid not null references public.staff_profiles (user_id),
  updated_at timestamptz not null default now(),
  unique (legal_entity_id, id)
);
create unique index suppliers_entity_name_key on public.suppliers (legal_entity_id, lower(name));
comment on table public.suppliers is
  'Purchase supplier register. Details stay unverified until P4-D1 is decided.';

create table public.supplier_beneficiary_revisions (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null,
  legal_entity_id uuid not null,
  revision_no integer not null check (revision_no >= 1),
  request_id uuid not null,
  account_holder text not null check (length(account_holder) between 1 and 120),
  bank_name text not null check (length(bank_name) between 1 and 120),
  ifsc text not null check (ifsc ~ '^[A-Z]{4}0[A-Z0-9]{6}$'),
  account_number text not null check (account_number ~ '^[0-9]{6,18}$'),
  -- P4-D4 open: revisions are recorded, never approved, never paid from.
  status text not null default 'unverified' check (status = 'unverified'),
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, supplier_id) references public.suppliers (legal_entity_id, id),
  unique (supplier_id, revision_no),
  unique (supplier_id, request_id)
);
comment on table public.supplier_beneficiary_revisions is
  'Append-only bank detail revisions. No table grant to authenticated; read only through supplier_get (last 4 digits).';

-- ---------------------------------------------------------------------------
-- Task state (contract 2)
-- ---------------------------------------------------------------------------

alter table public.fulfilment_tasks add constraint fulfilment_tasks_entity_id_key unique (legal_entity_id, id);

do $$
declare
  c record;
begin
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.fulfilment_tasks'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%status%'
  loop
    execute format('alter table public.fulfilment_tasks drop constraint %I', c.conname);
  end loop;
end;
$$;

alter table public.fulfilment_tasks
  add column selected_quote_id uuid,
  add column supplier_reference text check (supplier_reference is null or length(supplier_reference) between 1 and 120),
  add column supplier_confirmed_by uuid references public.staff_profiles (user_id),
  add column supplier_confirmed_at timestamptz,
  add constraint fulfilment_tasks_status_check
    check (status in ('not_started', 'in_progress', 'supplier_confirmed')),
  add constraint fulfilment_tasks_assignee_matches_status
    check ((status <> 'not_started') = (assignee_user_id is not null)),
  add constraint fulfilment_tasks_supplier_confirmation_complete
    check ((status = 'supplier_confirmed') = (selected_quote_id is not null and supplier_reference is not null
      and supplier_confirmed_by is not null and supplier_confirmed_at is not null));

create function authz.fulfilment_tasks_state_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.status = 'supplier_confirmed' then
    raise exception 'supplier-confirmed tasks are immutable' using errcode = '42501';
  end if;
  if (old.status = 'in_progress' and new.status = 'not_started')
     or (old.status = 'not_started' and new.status = 'supplier_confirmed') then
    raise exception 'fulfilment task status cannot move this way' using errcode = '42501';
  end if;
  if old.status = 'in_progress' and new.assignee_user_id is distinct from old.assignee_user_id then
    raise exception 'fulfilment task assignee cannot change (P4-D5 open)' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger fulfilment_tasks_b_state_guard
  before update on public.fulfilment_tasks
  for each row execute function authz.fulfilment_tasks_state_guard();

-- ---------------------------------------------------------------------------
-- Quotes, cost versions, evidence
-- ---------------------------------------------------------------------------

create table public.purchase_quotes (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  legal_entity_id uuid not null,
  supplier_id uuid not null,
  request_id uuid not null,
  hotel_name text not null check (length(hotel_name) between 1 and 200),
  room_type text check (room_type is null or length(room_type) between 1 and 120),
  meal_plan text check (meal_plan is null or length(meal_plan) between 1 and 60),
  quoted_cost_paise bigint not null check (quoted_cost_paise > 0),
  currency text not null default 'INR' check (currency = 'INR'),
  hold_until date,
  cancellation_terms text check (cancellation_terms is null or length(cancellation_terms) between 1 and 2000),
  status text not null default 'open' check (status in ('open', 'withdrawn', 'selected')),
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (legal_entity_id, supplier_id) references public.suppliers (legal_entity_id, id),
  unique (task_id, request_id),
  unique (task_id, id)
);
create index purchase_quotes_task_idx on public.purchase_quotes (task_id, created_at);

alter table public.fulfilment_tasks
  add constraint fulfilment_tasks_selected_quote_fk
  foreign key (id, selected_quote_id) references public.purchase_quotes (task_id, id);

create table public.purchase_cost_versions (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  legal_entity_id uuid not null,
  version_no integer not null check (version_no >= 1),
  quote_id uuid not null,
  request_id uuid not null,
  stage text not null check (stage in ('proposed', 'committed')),
  amount_paise bigint not null check (amount_paise > 0),
  currency text not null default 'INR' check (currency = 'INR'),
  due_date date,
  note text check (note is null or length(note) between 1 and 500),
  -- Prepared for a later payment-request model. Never changes in this phase:
  -- entering or committing a cost does not create a payable.
  payable_status text not null default 'not_requested' check (payable_status = 'not_requested'),
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (task_id, quote_id) references public.purchase_quotes (task_id, id),
  unique (task_id, version_no),
  unique (task_id, request_id)
);
create unique index purchase_cost_versions_one_committed on public.purchase_cost_versions (task_id)
  where stage = 'committed';

create table public.purchase_evidence (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null,
  legal_entity_id uuid not null,
  kind text not null check (kind in ('quote', 'supplier_confirmation', 'other')),
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
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  check (object_path = legal_entity_id::text || '/' || task_id::text || '/' || id::text)
);
create index purchase_evidence_task_idx on public.purchase_evidence (task_id, status);

-- Append-only / frozen rows: refused even for the table owner outside commands.
create function authz.procurement_append_only() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception '% rows are append-only', tg_table_name using errcode = '42501';
end;
$$;
create trigger supplier_beneficiary_revisions_a_append_only
  before update or delete on public.supplier_beneficiary_revisions
  for each row execute function authz.procurement_append_only();
create trigger purchase_cost_versions_a_append_only
  before update or delete on public.purchase_cost_versions
  for each row execute function authz.procurement_append_only();

create function authz.purchase_quotes_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'quotes cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['status', 'updated_at']) is distinct from (to_jsonb(old) - array['status', 'updated_at']) then
    raise exception 'quote facts are immutable; add a new quote' using errcode = '42501';
  end if;
  if old.status <> 'open' and new.status is distinct from old.status then
    raise exception 'quote status is final' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger purchase_quotes_a_guard
  before update or delete on public.purchase_quotes
  for each row execute function authz.purchase_quotes_guard();

create function authz.purchase_evidence_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'purchase evidence rows cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['status', 'updated_at', 'stored_at']) is distinct from
     (to_jsonb(old) - array['status', 'updated_at', 'stored_at']) then
    raise exception 'purchase evidence identity is immutable' using errcode = '42501';
  end if;
  if exists (select 1 from public.fulfilment_tasks t where t.id = old.task_id and t.status = 'supplier_confirmed') then
    raise exception 'evidence of a supplier-confirmed task is frozen' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger purchase_evidence_a_guard
  before update or delete on public.purchase_evidence
  for each row execute function authz.purchase_evidence_guard();

-- Outbox: one more event type, same id-only payload rule.
alter table public.outbox_events drop constraint outbox_events_event_type_check;
alter table public.outbox_events add constraint outbox_events_event_type_check
  check (event_type in ('booking.version_confirmed', 'fulfilment.task_created', 'fulfilment.supplier_confirmed'));

-- ---------------------------------------------------------------------------
-- Permission catalogue (role-derived)
-- ---------------------------------------------------------------------------

insert into public.permissions (code, description, is_grantable) values
  ('supplier.manage', 'Create and edit suppliers and record unverified beneficiary revisions.', false),
  ('purchase_task.work', 'Record quotes, costs, Purchase files and supplier confirmation on a task you claimed.', false);

insert into public.role_permissions (role_code, permission_code, scope, policy_status, note) values
  ('purchase', 'supplier.manage', 'entity', 'proposed', 'Phase 4: Purchase keeps the supplier register; verification rule P4-D1 open'),
  ('purchase', 'purchase_task.work', 'own', 'proposed', 'Phase 4: only the assignee works a claimed task; release/reassign P4-D5 open');

-- ---------------------------------------------------------------------------
-- Authorization helpers (contract 4)
-- ---------------------------------------------------------------------------

create function authz.can_manage_suppliers(p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and authz.holds_active_role('purchase', p_entity)
$$;

create function authz.can_read_purchase_workspace(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task and authz.holds_active_role('purchase', t.legal_entity_id)
  )
$$;

create function authz.can_work_purchase_task(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task
      and t.assignee_user_id = (select auth.uid())
      and authz.holds_active_role('purchase', t.legal_entity_id)
  )
$$;

-- P4-D7 gate: 'environment_unset', 'procurement_disabled' or null.
create function authz.procurement_gate_issue(p_task uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when authz.deployment_environment() = 'unset' then 'environment_unset'
    when not d.is_synthetic
      and not coalesce((select s.live_supplier_confirmation_enabled from public.procurement_settings s where s.id), false)
      then 'procurement_disabled'
    when d.is_synthetic and authz.deployment_environment() <> 'test' then 'procurement_disabled'
    else null
  end
  from public.fulfilment_tasks t join public.deals d on d.id = t.deal_id
  where t.id = p_task
$$;

-- Latest cost version of a task (null when none).
create function authz.purchase_latest_cost(p_task uuid) returns public.purchase_cost_versions
language sql stable security definer set search_path = '' as $$
  select c.* from public.purchase_cost_versions c
  where c.task_id = p_task order by c.version_no desc limit 1
$$;

-- Readiness for supplier confirmation (contract 7), in contract order.
create function authz.procurement_issues(p_task uuid) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v_issues text[] := '{}'::text[];
  v_gate text := authz.procurement_gate_issue(p_task);
  v_cost public.purchase_cost_versions;
  v_budget bigint;
begin
  if v_gate is not null then
    v_issues := v_issues || v_gate;
  end if;
  if not exists (select 1 from public.purchase_quotes q where q.task_id = p_task and q.status = 'open') then
    v_issues := v_issues || 'missing_quote'::text;
  end if;
  v_cost := authz.purchase_latest_cost(p_task);
  if v_cost.id is null then
    v_issues := v_issues || 'missing_cost'::text;
  else
    if not exists (select 1 from public.purchase_quotes q where q.id = v_cost.quote_id and q.status = 'open') then
      v_issues := v_issues || 'cost_not_for_quote'::text;
    end if;
    select v.purchase_budget_paise into v_budget
    from public.fulfilment_tasks t join public.booking_versions v on v.id = t.booking_version_id
    where t.id = p_task;
    if v_budget is null or v_cost.amount_paise > v_budget then
      v_issues := v_issues || 'over_budget'::text;
    end if;
  end if;
  if not exists (select 1 from public.purchase_evidence e
                 where e.task_id = p_task and e.kind = 'supplier_confirmation' and e.status = 'stored') then
    v_issues := v_issues || 'missing_supplier_confirmation_proof'::text;
  end if;
  if exists (select 1 from public.purchase_evidence e where e.task_id = p_task and e.status = 'pending_upload') then
    v_issues := v_issues || 'evidence_upload_incomplete'::text;
  end if;
  return v_issues;
end;
$$;

-- Supplier field parsing (keys = SupplierFields, camelCase). Unknown keys refused.
create function authz.supplier_fields_check(p_fields jsonb) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['name', 'serviceTypes', 'city', 'contactName', 'contactPhone', 'contactEmail',
                          'paymentTerms', 'status']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
end;
$$;

create function authz.supplier_service_types(p_fields jsonb) returns text[]
language plpgsql immutable set search_path = '' as $$
declare
  v jsonb := p_fields -> 'serviceTypes';
  v_types text[];
begin
  if v is null or jsonb_typeof(v) <> 'array' or jsonb_array_length(v) not between 1 and 3 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_array_elements(v) e where jsonb_typeof(e) <> 'string') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select array_agg(distinct e order by e) into v_types from jsonb_array_elements_text(v) e;
  if not v_types <@ array['hotel', 'transfer', 'activity'] then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  return v_types;
end;
$$;

revoke all on function
  authz.fulfilment_tasks_state_guard(), authz.procurement_append_only(), authz.purchase_quotes_guard(),
  authz.purchase_evidence_guard(),
  authz.can_manage_suppliers(uuid), authz.can_read_purchase_workspace(uuid), authz.can_work_purchase_task(uuid),
  authz.procurement_gate_issue(uuid), authz.purchase_latest_cost(uuid), authz.procurement_issues(uuid),
  authz.supplier_fields_check(jsonb), authz.supplier_service_types(jsonb)
from public, anon, authenticated;

-- RLS policies call these as the invoker.
grant execute on function authz.can_manage_suppliers(uuid), authz.can_read_purchase_workspace(uuid)
to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security and grants
-- ---------------------------------------------------------------------------

alter table public.procurement_settings enable row level security;
alter table public.suppliers enable row level security;
alter table public.supplier_beneficiary_revisions enable row level security;
alter table public.purchase_quotes enable row level security;
alter table public.purchase_cost_versions enable row level security;
alter table public.purchase_evidence enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'procurement_settings', 'suppliers', 'supplier_beneficiary_revisions', 'purchase_quotes',
    'purchase_cost_versions', 'purchase_evidence'
  ] loop
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
  end loop;
end;
$$;

create policy staff_read on public.procurement_settings
  for select to authenticated using ((select authz.is_active_staff()));
create policy purchase_read on public.suppliers
  for select to authenticated using (authz.can_manage_suppliers(legal_entity_id));
create policy purchase_read on public.purchase_quotes
  for select to authenticated using (authz.can_read_purchase_workspace(task_id));
create policy purchase_read on public.purchase_cost_versions
  for select to authenticated using (authz.can_read_purchase_workspace(task_id));
create policy purchase_read on public.purchase_evidence
  for select to authenticated using (authz.can_read_purchase_workspace(task_id));
-- supplier_beneficiary_revisions: no permissive policy and no grant.

revoke all on public.procurement_settings, public.suppliers, public.supplier_beneficiary_revisions,
  public.purchase_quotes, public.purchase_cost_versions, public.purchase_evidence
from public, anon, authenticated, service_role;
grant select on public.procurement_settings, public.suppliers, public.purchase_quotes,
  public.purchase_cost_versions, public.purchase_evidence
to authenticated, service_role;

-- P4-D6 / P4-10: deal readers (Sales) select fulfilment_tasks rows directly.
-- Phase 3 granted the whole table; narrow it to a column grant so the new
-- supplier reference, selected quote and confirming person stay out of the
-- Data API (status and supplier_confirmed_at only). Purchase reads them via
-- purchase_workspace. select * is refused; name the columns.
revoke select on public.fulfilment_tasks from authenticated;
grant select (id, deal_id, legal_entity_id, branch_id, booking_version_id, service_purpose, task_key, status,
  assignee_user_id, created_by, created_at, updated_at, supplier_confirmed_at)
on public.fulfilment_tasks to authenticated;

-- ---------------------------------------------------------------------------
-- Read shapes
-- ---------------------------------------------------------------------------

-- Phase 3 task DTO plus the supplier-confirmed time (Sales may see it, P4-D6).
-- Still NEVER the selling total, margin, evidence, supplier or cost.
create or replace function authz.purchase_task_json(p_task uuid, p_detail boolean) returns jsonb
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
    'createdAt', t.created_at,
    'supplierConfirmedAt', t.supplier_confirmed_at
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

create function authz.supplier_json(p_supplier uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'supplierId', s.id,
    'legalEntityId', s.legal_entity_id,
    'name', s.name,
    'serviceTypes', to_jsonb(s.service_types),
    'city', s.city,
    'contactName', s.contact_name,
    'contactPhone', s.contact_phone,
    'contactEmail', s.contact_email,
    'paymentTerms', s.payment_terms,
    'verificationStatus', s.verification_status,
    'status', s.status,
    'rowVersion', s.row_version,
    'updatedAt', s.updated_at)
  from public.suppliers s where s.id = p_supplier
$$;

revoke all on function authz.supplier_json(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Supplier commands
-- ---------------------------------------------------------------------------

create function public.supplier_create(p_entity_id uuid, p_fields jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid;
  v_name text;
begin
  if p_entity_id is null or not authz.can_manage_suppliers(p_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  perform authz.supplier_fields_check(p_fields);
  if p_fields ? 'status' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_name := authz.booking_fact_text(p_fields, 'name', 200, false);
  if v_name is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if exists (select 1 from public.suppliers s where s.legal_entity_id = p_entity_id and lower(s.name) = lower(v_name)) then
    raise exception 'supplier_exists' using errcode = '23505';
  end if;

  begin
    insert into public.suppliers (legal_entity_id, name, service_types, city, contact_name, contact_phone,
      contact_email, payment_terms, created_by, updated_by)
    values (p_entity_id, v_name, authz.supplier_service_types(p_fields),
      authz.booking_fact_text(p_fields, 'city', 120, false),
      authz.booking_fact_text(p_fields, 'contactName', 120, false),
      authz.booking_fact_text(p_fields, 'contactPhone', 40, false),
      authz.booking_fact_text(p_fields, 'contactEmail', 254, false),
      authz.booking_fact_text(p_fields, 'paymentTerms', 1000, true),
      (select auth.uid()), (select auth.uid()))
    returning id into v_id;
  exception
    when unique_violation then
      raise exception 'supplier_exists' using errcode = '23505';
    when check_violation then
      raise exception 'invalid_input' using errcode = '22023';
  end;

  perform authz.write_audit('supplier.created', p_entity_id, null, 'supplier', v_id, null,
    jsonb_build_object('serviceTypes', p_fields -> 'serviceTypes'));
  return jsonb_build_object('supplierId', v_id, 'rowVersion', 1);
end;
$$;

create function public.supplier_update(p_supplier_id uuid, p_expected_row_version integer, p_fields jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_s public.suppliers%rowtype;
  v_name text;
  v_status text;
  v_changed text[];
begin
  select * into v_s from public.suppliers s where s.id = p_supplier_id for update;
  if v_s.id is null or not authz.can_manage_suppliers(v_s.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v_s.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  perform authz.supplier_fields_check(p_fields);
  v_name := authz.booking_fact_text(p_fields, 'name', 200, false);
  v_status := coalesce(authz.booking_fact_text(p_fields, 'status', 20, false), v_s.status);
  if v_name is null or v_status not in ('active', 'archived') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if exists (select 1 from public.suppliers s
             where s.legal_entity_id = v_s.legal_entity_id and lower(s.name) = lower(v_name) and s.id <> v_s.id) then
    raise exception 'supplier_exists' using errcode = '23505';
  end if;

  begin
    update public.suppliers s set
      name = v_name,
      service_types = authz.supplier_service_types(p_fields),
      city = authz.booking_fact_text(p_fields, 'city', 120, false),
      contact_name = authz.booking_fact_text(p_fields, 'contactName', 120, false),
      contact_phone = authz.booking_fact_text(p_fields, 'contactPhone', 40, false),
      contact_email = authz.booking_fact_text(p_fields, 'contactEmail', 254, false),
      payment_terms = authz.booking_fact_text(p_fields, 'paymentTerms', 1000, true),
      status = v_status,
      row_version = s.row_version + 1,
      updated_by = (select auth.uid()),
      updated_at = now()
    where s.id = v_s.id
    returning * into v_s;
  exception
    when unique_violation then
      raise exception 'supplier_exists' using errcode = '23505';
    when check_violation then
      raise exception 'invalid_input' using errcode = '22023';
  end;

  -- Field names only; contact values are not copied into the audit trail.
  select coalesce(array_agg(k order by k), '{}') into v_changed from jsonb_object_keys(p_fields) k;
  perform authz.write_audit('supplier.updated', v_s.legal_entity_id, null, 'supplier', v_s.id, null,
    jsonb_build_object('fields', to_jsonb(v_changed), 'rowVersion', v_s.row_version, 'status', v_s.status));
  return jsonb_build_object('supplierId', v_s.id, 'rowVersion', v_s.row_version);
end;
$$;

create function public.supplier_add_beneficiary(p_supplier_id uuid, p_request_id uuid, p_fields jsonb)
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
  if v_s.id is null or not authz.can_manage_suppliers(v_s.legal_entity_id) then
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

create function public.supplier_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(authz.supplier_json(s.id) order by s.status, lower(s.name), s.id)
    from public.suppliers s
    where authz.can_manage_suppliers(s.legal_entity_id)
  ), '[]'::jsonb);
end;
$$;

create function public.supplier_get(p_supplier_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_entity uuid;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select s.legal_entity_id into v_entity from public.suppliers s where s.id = p_supplier_id;
  if v_entity is null or not authz.can_manage_suppliers(v_entity) then
    return null;
  end if;
  return authz.supplier_json(p_supplier_id) || jsonb_build_object(
    'beneficiaries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'revisionNo', r.revision_no,
        'accountHolder', r.account_holder,
        'bankName', r.bank_name,
        'ifsc', r.ifsc,
        'accountLast4', right(r.account_number, 4),
        'status', r.status,
        'createdAt', r.created_at,
        'createdByName', p.display_name) order by r.revision_no desc)
      from public.supplier_beneficiary_revisions r
      left join public.staff_profiles p on p.user_id = r.created_by
      where r.supplier_id = p_supplier_id), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- Task work commands (assignee only, gate checked, task row locked first)
-- ---------------------------------------------------------------------------

-- Locks the task and enforces assignee + state + gate. Returns the task row.
create function authz.lock_workable_task(p_task uuid) returns public.fulfilment_tasks
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_gate text;
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task for update;
  if v_task.id is null or not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_task.status = 'supplier_confirmed' then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  v_gate := authz.procurement_gate_issue(v_task.id);
  if v_gate is not null then
    raise exception '%', v_gate using errcode = '55000';
  end if;
  return v_task;
end;
$$;
revoke all on function authz.lock_workable_task(uuid) from public, anon, authenticated;

create function public.purchase_quote_add(p_task_id uuid, p_request_id uuid, p_fields jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_existing uuid;
  v_supplier public.suppliers%rowtype;
  v_cost bigint;
  v_id uuid;
begin
  v_task := authz.lock_workable_task(p_task_id);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select q.id into v_existing from public.purchase_quotes q where q.task_id = v_task.id and q.request_id = p_request_id;
  if v_existing is not null then
    return jsonb_build_object('quoteId', v_existing, 'created', false);
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['supplierId', 'hotelName', 'roomType', 'mealPlan', 'quotedCostPaise', 'holdUntil',
                          'cancellationTerms']) <> '{}'::jsonb
     or jsonb_typeof(p_fields -> 'supplierId') is distinct from 'string'
     or (p_fields ->> 'supplierId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into v_supplier from public.suppliers s
  where s.id = (p_fields ->> 'supplierId')::uuid and s.legal_entity_id = v_task.legal_entity_id;
  if v_supplier.id is null or v_supplier.status <> 'active' or not ('hotel' = any (v_supplier.service_types)) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_cost := authz.booking_fact_paise(p_fields, 'quotedCostPaise');
  if v_cost is null or v_cost <= 0 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  begin
    insert into public.purchase_quotes (task_id, legal_entity_id, supplier_id, request_id, hotel_name, room_type,
      meal_plan, quoted_cost_paise, hold_until, cancellation_terms, created_by)
    values (v_task.id, v_task.legal_entity_id, v_supplier.id, p_request_id,
      authz.booking_fact_text(p_fields, 'hotelName', 200, false),
      authz.booking_fact_text(p_fields, 'roomType', 120, false),
      authz.booking_fact_text(p_fields, 'mealPlan', 60, false),
      v_cost,
      authz.booking_fact_date(p_fields, 'holdUntil'),
      authz.booking_fact_text(p_fields, 'cancellationTerms', 2000, true),
      (select auth.uid()))
    returning id into v_id;
  exception when check_violation or not_null_violation then
    raise exception 'invalid_input' using errcode = '22023';
  end;

  perform authz.write_audit('purchase.quote_added', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null, jsonb_build_object('quoteId', v_id, 'supplierId', v_supplier.id));
  return jsonb_build_object('quoteId', v_id, 'created', true);
end;
$$;

create function public.purchase_quote_withdraw(p_quote_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_quote public.purchase_quotes%rowtype;
begin
  v_task := authz.lock_workable_task((select q.task_id from public.purchase_quotes q where q.id = p_quote_id));
  select * into v_quote from public.purchase_quotes q where q.id = p_quote_id for update;
  if v_quote.status = 'withdrawn' then
    return jsonb_build_object('quoteId', v_quote.id, 'status', 'withdrawn');
  end if;
  update public.purchase_quotes q set status = 'withdrawn', updated_at = now() where q.id = v_quote.id;
  perform authz.write_audit('purchase.quote_withdrawn', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null, jsonb_build_object('quoteId', v_quote.id));
  return jsonb_build_object('quoteId', v_quote.id, 'status', 'withdrawn');
end;
$$;

create function public.purchase_cost_propose(
  p_task_id uuid, p_quote_id uuid, p_expected_version_no integer, p_amount_paise bigint, p_due_date date,
  p_note text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_existing public.purchase_cost_versions%rowtype;
  v_latest integer;
  v_note text;
begin
  v_task := authz.lock_workable_task(p_task_id);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into v_existing from public.purchase_cost_versions c
  where c.task_id = v_task.id and c.request_id = p_request_id;
  if v_existing.id is not null then
    return jsonb_build_object('versionNo', v_existing.version_no, 'created', false);
  end if;
  select coalesce(max(c.version_no), 0) into v_latest from public.purchase_cost_versions c where c.task_id = v_task.id;
  if p_expected_version_no is distinct from v_latest then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if not exists (select 1 from public.purchase_quotes q
                 where q.id = p_quote_id and q.task_id = v_task.id and q.status = 'open') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_amount_paise is null or p_amount_paise <= 0 or p_amount_paise > 999999999999999999
     or (p_due_date is not null and p_due_date not between date '2000-01-01' and date '2100-12-31') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_note := authz.booking_fact_text(jsonb_build_object('note', p_note), 'note', 500, true);

  insert into public.purchase_cost_versions (task_id, legal_entity_id, version_no, quote_id, request_id, stage,
    amount_paise, due_date, note, created_by)
  values (v_task.id, v_task.legal_entity_id, v_latest + 1, p_quote_id, p_request_id, 'proposed',
    p_amount_paise, p_due_date, v_note, (select auth.uid()));

  -- Amounts stay out of the audit trail.
  perform authz.write_audit('purchase.cost_proposed', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null, jsonb_build_object('versionNo', v_latest + 1, 'quoteId', p_quote_id));
  return jsonb_build_object('versionNo', v_latest + 1, 'created', true);
end;
$$;

create function public.purchase_evidence_begin(
  p_task_id uuid, p_kind text, p_file_name text, p_mime text, p_size_bytes integer, p_sha256 text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_name text := btrim(coalesce(p_file_name, ''));
  v_sha text := lower(coalesce(p_sha256, ''));
  v_max integer := coalesce((select s.evidence_max_bytes from public.booking_settings s where s.id), 4194304);
begin
  v_task := authz.lock_workable_task(p_task_id);
  if p_kind is null or p_kind not in ('quote', 'supplier_confirmation', 'other')
     or p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes not between 1 and least(v_max, 4194304)
     or v_sha !~ '^[0-9a-f]{64}$'
     or length(v_name) not between 1 and 120 or v_name !~ '^[A-Za-z0-9._ -]+$' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  if (select count(*) from public.purchase_evidence e where e.task_id = v_task.id and e.status <> 'removed') >= 10 then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  v_path := v_task.legal_entity_id::text || '/' || v_task.id::text || '/' || v_id::text;
  insert into public.purchase_evidence (id, task_id, legal_entity_id, kind, object_path, file_name, mime,
    size_bytes, sha256, uploaded_by)
  values (v_id, v_task.id, v_task.legal_entity_id, p_kind, v_path, v_name, p_mime, p_size_bytes, v_sha,
    (select auth.uid()));

  perform authz.write_audit('purchase.evidence_started', v_task.legal_entity_id, v_task.branch_id,
    'purchase_evidence', v_id, null,
    jsonb_build_object('taskId', v_task.id, 'kind', p_kind, 'mime', p_mime, 'sizeBytes', p_size_bytes));
  return jsonb_build_object('evidenceId', v_id, 'objectPath', v_path);
end;
$$;

create function public.purchase_evidence_finish(p_evidence_id uuid, p_ok boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_ev public.purchase_evidence%rowtype;
  v_status text;
  v_missing boolean := false;
begin
  -- Lock order everywhere: task, then evidence.
  select * into v_task from public.fulfilment_tasks t
  where t.id = (select e.task_id from public.purchase_evidence e where e.id = p_evidence_id)
  for update;
  select * into v_ev from public.purchase_evidence e where e.id = p_evidence_id for update;
  if v_ev.id is null or v_task.id is null or v_ev.uploaded_by is distinct from (select auth.uid())
     or not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_task.status = 'supplier_confirmed' then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  if p_ok is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_status := case when p_ok then 'stored' else 'failed' end;
  if v_ev.status <> 'pending_upload' then
    if v_ev.status = v_status or (p_ok and v_ev.status = 'failed') then
      return jsonb_build_object('evidenceId', v_ev.id, 'status', v_ev.status);
    end if;
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  -- 'stored' only when Storage holds the object at the generated path with the declared size.
  if p_ok and (to_regclass('storage.objects') is null or not exists (
       select 1 from storage.objects o
       where o.bucket_id = 'purchase-evidence' and o.name = v_ev.object_path
         and (o.metadata ->> 'size') ~ '^[0-9]{1,18}$'
         and (o.metadata ->> 'size')::bigint = v_ev.size_bytes)) then
    v_status := 'failed';
    v_missing := true;
  end if;

  update public.purchase_evidence e
  set status = v_status, stored_at = case when v_status = 'stored' then now() else null end, updated_at = now()
  where e.id = v_ev.id;

  perform authz.write_audit(case when v_status = 'stored' then 'purchase.evidence_stored' else 'purchase.evidence_failed' end,
    v_task.legal_entity_id, v_task.branch_id, 'purchase_evidence', v_ev.id, null,
    jsonb_build_object('taskId', v_task.id, 'objectMissing', v_missing));
  return jsonb_build_object('evidenceId', v_ev.id, 'status', v_status);
end;
$$;

create function public.purchase_evidence_remove(p_evidence_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_ev public.purchase_evidence%rowtype;
begin
  select * into v_task from public.fulfilment_tasks t
  where t.id = (select e.task_id from public.purchase_evidence e where e.id = p_evidence_id)
  for update;
  select * into v_ev from public.purchase_evidence e where e.id = p_evidence_id for update;
  if v_ev.id is null or v_task.id is null or not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_task.status = 'supplier_confirmed' then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  if v_ev.status = 'removed' then
    return jsonb_build_object('evidenceId', v_ev.id, 'status', 'removed');
  end if;
  update public.purchase_evidence e set status = 'removed', updated_at = now() where e.id = v_ev.id;
  perform authz.write_audit('purchase.evidence_removed', v_task.legal_entity_id, v_task.branch_id,
    'purchase_evidence', v_ev.id, null, jsonb_build_object('taskId', v_task.id, 'previousStatus', v_ev.status));
  return jsonb_build_object('evidenceId', v_ev.id, 'status', 'removed');
end;
$$;

create function public.purchase_evidence_authorize_download(p_evidence_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ev public.purchase_evidence%rowtype;
  v_branch uuid;
begin
  select * into v_ev from public.purchase_evidence e where e.id = p_evidence_id;
  if v_ev.id is null or not authz.can_read_purchase_workspace(v_ev.task_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ev.status <> 'stored' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select t.branch_id into v_branch from public.fulfilment_tasks t where t.id = v_ev.task_id;
  perform authz.write_audit('purchase.evidence_viewed', v_ev.legal_entity_id, v_branch,
    'purchase_evidence', v_ev.id, null, jsonb_build_object('taskId', v_ev.task_id));
  return jsonb_build_object('objectPath', v_ev.object_path, 'fileName', v_ev.file_name, 'mime', v_ev.mime);
end;
$$;

create function public.purchase_supplier_confirm(p_task_id uuid, p_expected_version_no integer, p_reference text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_cost public.purchase_cost_versions;
  v_ref text := btrim(coalesce(p_reference, ''));
  v_issues text[];
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Repeat (or a concurrent loser of the row lock): same reference = existing.
  if v_task.status = 'supplier_confirmed' then
    if v_task.supplier_reference = v_ref then
      return jsonb_build_object('outcome', 'existing', 'taskId', v_task.id);
    end if;
    raise exception 'task_conflict' using errcode = '40001';
  end if;
  if length(v_ref) not between 1 and 120 or v_ref ~ E'[\\x01-\\x1f\\x7f]' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_cost := authz.purchase_latest_cost(v_task.id);
  if v_cost.id is not null and p_expected_version_no is distinct from v_cost.version_no then
    raise exception 'version_changed' using errcode = '40001';
  end if;

  v_issues := authz.procurement_issues(v_task.id);
  if 'environment_unset' = any (v_issues) then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if 'procurement_disabled' = any (v_issues) then
    raise exception 'procurement_disabled' using errcode = '55000';
  end if;
  if v_issues = array['over_budget'] then
    raise exception 'over_budget' using errcode = '55000';
  end if;
  if cardinality(v_issues) > 0 then
    raise exception 'not_ready' using errcode = '55000';
  end if;

  insert into public.purchase_cost_versions (task_id, legal_entity_id, version_no, quote_id, request_id, stage,
    amount_paise, due_date, note, created_by)
  values (v_task.id, v_task.legal_entity_id, v_cost.version_no + 1, v_cost.quote_id, gen_random_uuid(), 'committed',
    v_cost.amount_paise, v_cost.due_date, v_cost.note, (select auth.uid()));
  update public.purchase_quotes q set status = 'selected', updated_at = now() where q.id = v_cost.quote_id;
  update public.fulfilment_tasks t
  set status = 'supplier_confirmed', selected_quote_id = v_cost.quote_id, supplier_reference = v_ref,
      supplier_confirmed_by = (select auth.uid()), supplier_confirmed_at = now(), updated_at = now()
  where t.id = v_task.id;

  insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
  values (v_task.legal_entity_id, 'fulfilment_task', v_task.id, 'fulfilment.supplier_confirmed',
    jsonb_build_object('task_id', v_task.id, 'deal_id', v_task.deal_id, 'service_purpose', v_task.service_purpose))
  on conflict (event_type, aggregate_id) do nothing;

  perform authz.write_audit('purchase.supplier_confirmed', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('quoteId', v_cost.quote_id, 'committedVersionNo', v_cost.version_no + 1));
  return jsonb_build_object('outcome', 'created', 'taskId', v_task.id);
end;
$$;

create function public.purchase_workspace(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or not authz.can_read_purchase_workspace(v_task.id) then
    return null;
  end if;
  return jsonb_build_object(
    'task', authz.purchase_task_json(v_task.id, true),
    'canWork', authz.can_work_purchase_task(v_task.id) and v_task.status = 'in_progress',
    'gateIssue', authz.procurement_gate_issue(v_task.id),
    'issues', case when v_task.status = 'in_progress' then to_jsonb(authz.procurement_issues(v_task.id))
                   else '[]'::jsonb end,
    'supplierReference', v_task.supplier_reference,
    'selectedQuoteId', v_task.selected_quote_id,
    'supplierConfirmedByName', (select p.display_name from public.staff_profiles p
                                where p.user_id = v_task.supplier_confirmed_by),
    'quotes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'quoteId', q.id,
        'supplierId', q.supplier_id,
        'supplierName', s.name,
        'supplierVerification', s.verification_status,
        'hotelName', q.hotel_name,
        'roomType', q.room_type,
        'mealPlan', q.meal_plan,
        'quotedCostPaise', q.quoted_cost_paise::text,
        'holdUntil', to_char(q.hold_until, 'YYYY-MM-DD'),
        'cancellationTerms', q.cancellation_terms,
        'status', q.status,
        'createdAt', q.created_at,
        'createdByName', p.display_name) order by q.created_at, q.id)
      from public.purchase_quotes q
      join public.suppliers s on s.id = q.supplier_id
      left join public.staff_profiles p on p.user_id = q.created_by
      where q.task_id = v_task.id), '[]'::jsonb),
    'costVersions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'versionNo', c.version_no,
        'quoteId', c.quote_id,
        'stage', c.stage,
        'amountPaise', c.amount_paise::text,
        'dueDate', to_char(c.due_date, 'YYYY-MM-DD'),
        'note', c.note,
        'payableStatus', c.payable_status,
        'createdAt', c.created_at,
        'createdByName', p.display_name) order by c.version_no desc)
      from public.purchase_cost_versions c
      left join public.staff_profiles p on p.user_id = c.created_by
      where c.task_id = v_task.id), '[]'::jsonb),
    'evidence', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id,
        'kind', e.kind,
        'fileName', e.file_name,
        'mime', e.mime,
        'sizeBytes', e.size_bytes,
        'status', e.status,
        'createdAt', e.created_at,
        'uploadedByName', p.display_name) order by e.created_at, e.id)
      from public.purchase_evidence e
      left join public.staff_profiles p on p.user_id = e.uploaded_by
      where e.task_id = v_task.id and e.status <> 'removed'), '[]'::jsonb));
end;
$$;

revoke all on function
  public.supplier_create(uuid, jsonb),
  public.supplier_update(uuid, integer, jsonb),
  public.supplier_add_beneficiary(uuid, uuid, jsonb),
  public.supplier_list(),
  public.supplier_get(uuid),
  public.purchase_quote_add(uuid, uuid, jsonb),
  public.purchase_quote_withdraw(uuid),
  public.purchase_cost_propose(uuid, uuid, integer, bigint, date, text, uuid),
  public.purchase_evidence_begin(uuid, text, text, text, integer, text),
  public.purchase_evidence_finish(uuid, boolean),
  public.purchase_evidence_remove(uuid),
  public.purchase_evidence_authorize_download(uuid),
  public.purchase_supplier_confirm(uuid, integer, text),
  public.purchase_workspace(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.supplier_create(uuid, jsonb),
  public.supplier_update(uuid, integer, jsonb),
  public.supplier_add_beneficiary(uuid, uuid, jsonb),
  public.supplier_list(),
  public.supplier_get(uuid),
  public.purchase_quote_add(uuid, uuid, jsonb),
  public.purchase_quote_withdraw(uuid),
  public.purchase_cost_propose(uuid, uuid, integer, bigint, date, text, uuid),
  public.purchase_evidence_begin(uuid, text, text, text, integer, text),
  public.purchase_evidence_finish(uuid, boolean),
  public.purchase_evidence_remove(uuid),
  public.purchase_evidence_authorize_download(uuid),
  public.purchase_supplier_confirm(uuid, integer, text),
  public.purchase_workspace(uuid)
to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: private Purchase evidence bucket (no storage.objects policies).
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('purchase-evidence', 'purchase-evidence', false, 4194304,
      array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;

commit;
