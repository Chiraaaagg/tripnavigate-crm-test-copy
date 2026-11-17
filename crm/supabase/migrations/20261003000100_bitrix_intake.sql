-- TripNavigate CRM - Phase 2: Bitrix intake for eligible new deals.
--
-- Contract: docs/implementation/phase-2/contract.md (sections 2-5, 10).
--
-- What changes:
--   * public.deployment_settings: single row, environment in
--     unset|test|staging|operational, default 'unset'. Every intake command
--     refuses while 'unset'. Synthetic deal/commercial rows are refused by a
--     trigger while 'operational'. Only the database owner changes this row
--     (no API grant writes it). Synthetic fixtures set 'test'.
--   * public.integration_intake_config (one row per portal) and
--     public.bitrix_user_mappings are created EMPTY. Real values come from the
--     owner (pilot branch, category, stages, cutoff, staff map) and are entered
--     by an operator; nothing here invents them. enabled defaults to false.
--   * public.integration_inbox: bounded parsed event fields only. The raw
--     provider payload is never stored. Statuses pending|processing|processed|
--     ignored|needs_review|failed|dead_letter; one lease (lock_token,
--     locked_until) per row; exponential back-off (PROPOSED base 60 s, cap 1 h,
--     max_attempts default 8).
--   * public.deals gains source/provenance columns and a unique source identity
--     (source_system, source_portal, source_deal_id).
--   * deals_batch1_synthetic_only / deal_commercials_batch1_synthetic_only are
--     REPLACED by provenance checks: a deal is either synthetic with no source
--     fields, or a Bitrix-sourced non-synthetic row with every source field set.
--     deal_commercials stays synthetic-only and may only reference a synthetic
--     deal (composite foreign key). No non-synthetic commercial writer exists;
--     Phase 2 imports no amounts.
--   * Permission integration.manage (Super Admin, entity scope, PROPOSED).
--   * Commands (security definer, search_path ''):
--       service_role only: integration_record_bitrix_event,
--         integration_claim_inbox, integration_apply_bitrix_deal,
--         integration_fail_inbox, integration_enqueue_reconcile
--       staff (valid aal2 session + integration.manage in the config's entity):
--         integration_retry_inbox (audited)
--   * Review amendment (contract section 12, amended in place; never applied
--     to a shared database):
--       M1 equal DATE_MODIFY with different Bitrix-owned content updates;
--          deals.last_verified_at records every confirmation (incl. stale and
--          reconcile up-to-date); config.last_reconciled_at watermark via
--          integration_record_reconcile_run.
--       M2 integration_worker_runs heartbeat via integration_record_worker_run.
--       L1 integration_release_inbox returns a lease without using an attempt.
--       L2 any data_exception while parsing source data -> invalid_source_data.
--       L3 reference collision -> needs_review/reference_conflict; synthetic
--          deals may not use the BX- prefix.
--       L5 integration_request_reconcile: admin, audited, PROPOSED 300 s cooldown.
--       L6 an event for a deal with an unclaimed pending row coalesces into it.
--       L8 environment cannot become 'operational' while synthetic deals exist.
--   * SQLSTATEs raised to callers:
--       55000  intake not configured (environment 'unset', or no enabled
--              config row at all)            -> receiver answers 503
--       42501  portal member id does not match the enabled config, or caller
--              not authorized                -> receiver answers 401
--       22023  invalid argument (event type, ids, limits, error code)
--       55P03  inbox lease not held (wrong/stale lock_token, expired lease,
--              row not processing)
--   * Phase 1 / 1.5 policies are untouched; every new table carries the same
--     RESTRICTIVE require_valid_session policy.
--
-- Rollback / recovery (forward-only):
--   This migration is not reversed in place. Fastest safe stop: set
--   integration_intake_config.enabled = false (owner SQL) or
--   deployment_settings.environment = 'unset'; every intake command then
--   refuses and nothing new is written. An emergency rollback is a NEW
--   migration that, in one transaction:
--     1. keeps every imported deal and every integration_inbox / audit_events
--        row (no data deletion; export them for the record if tables must go);
--     2. revokes execute on the six integration_* commands from service_role
--        and authenticated (or drops the functions);
--     3. leaves the provenance checks in place while any non-synthetic deal
--        exists. Restoring deals_batch1_synthetic_only would fail on imported
--        rows and must not be attempted by deleting them;
--     4. may drop the synthetic-refusal trigger only if the deployment is not
--        operational.
--   Never delete audit_events, never relax a Phase 1/1.5 policy as rollback.

begin;

-- ---------------------------------------------------------------------------
-- Deployment environment
-- ---------------------------------------------------------------------------

create table public.deployment_settings (
  id boolean primary key default true check (id),
  environment text not null default 'unset'
    check (environment in ('unset', 'test', 'staging', 'operational')),
  updated_at timestamptz not null default now()
);
comment on table public.deployment_settings is
  'Single-row deployment environment. unset = intake refused; operational = synthetic rows refused. Owner-only writes.';
insert into public.deployment_settings (id, environment) values (true, 'unset');

create function authz.deployment_environment() returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.environment from public.deployment_settings s where s.id), 'unset')
$$;

create function authz.refuse_synthetic_when_operational() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.is_synthetic and authz.deployment_environment() = 'operational' then
    raise exception 'synthetic rows are refused in an operational deployment' using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger deals_refuse_synthetic_when_operational
  before insert or update of is_synthetic on public.deals
  for each row execute function authz.refuse_synthetic_when_operational();
create trigger deal_commercials_refuse_synthetic_when_operational
  before insert or update of is_synthetic on public.deal_commercials
  for each row execute function authz.refuse_synthetic_when_operational();

-- An operational deployment starts without synthetic deals (L8).
create function authz.refuse_operational_with_synthetic() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.environment = 'operational' and exists (select 1 from public.deals d where d.is_synthetic) then
    raise exception 'environment cannot be operational while synthetic deals exist' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger deployment_settings_refuse_operational_with_synthetic
  before insert or update of environment on public.deployment_settings
  for each row execute function authz.refuse_operational_with_synthetic();

-- ---------------------------------------------------------------------------
-- Intake configuration and staff mapping (no rows here)
-- ---------------------------------------------------------------------------

create table public.integration_intake_config (
  id uuid primary key default gen_random_uuid(),
  source_system text not null default 'bitrix' check (source_system = 'bitrix'),
  portal_domain text not null unique
    check (portal_domain ~ '^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$'
      and length(portal_domain) <= 253),
  portal_member_id text not null unique check (portal_member_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  category_id bigint not null check (category_id >= 0),
  eligible_stage_ids text[] not null
    check (cardinality(eligible_stage_ids) between 1 and 50
      and array_position(eligible_stage_ids, null) is null),
  cutoff_at timestamptz not null,
  pilot_legal_entity_id uuid not null,
  pilot_branch_id uuid not null,
  enabled boolean not null default false,
  -- Reconcile watermark: start time of the last successful reconcile run (M1).
  last_reconciled_at timestamptz,
  -- Last administrator "check now" request, for the PROPOSED cooldown (L5).
  last_reconcile_requested_at timestamptz,
  created_at timestamptz not null default now(),
  created_by uuid references public.staff_profiles (user_id),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.staff_profiles (user_id),
  -- Branch and entity of imported deals come only from here (never the payload).
  foreign key (pilot_legal_entity_id, pilot_branch_id) references public.branches (legal_entity_id, id)
);
create index integration_intake_config_entity_idx on public.integration_intake_config (pilot_legal_entity_id);
comment on table public.integration_intake_config is
  'Bitrix intake configuration, one row per portal. Created empty; values are owner-provided.';

create table public.bitrix_user_mappings (
  id uuid primary key default gen_random_uuid(),
  portal_member_id text not null references public.integration_intake_config (portal_member_id),
  bitrix_user_id bigint not null check (bitrix_user_id > 0),
  staff_user_id uuid not null references public.staff_profiles (user_id),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references public.staff_profiles (user_id),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.staff_profiles (user_id),
  unique (portal_member_id, bitrix_user_id)
);
create index bitrix_user_mappings_staff_idx on public.bitrix_user_mappings (staff_user_id);
comment on table public.bitrix_user_mappings is
  'Bitrix ASSIGNED_BY_ID -> CRM staff. Created empty; no administrator fallback owner exists.';

-- ---------------------------------------------------------------------------
-- Inbox (no raw payload)
-- ---------------------------------------------------------------------------

create table public.integration_inbox (
  id uuid primary key default gen_random_uuid(),
  source_system text not null default 'bitrix' check (source_system = 'bitrix'),
  portal_member_id text not null check (portal_member_id ~ '^[A-Za-z0-9_-]{1,64}$'),
  event_type text not null check (event_type in ('ONCRMDEALADD', 'ONCRMDEALUPDATE', 'RECONCILE')),
  source_deal_id bigint not null check (source_deal_id > 0),
  -- Event ts (seconds) or, for reconcile, the source DATE_MODIFY (seconds).
  source_ts bigint not null check (source_ts between 0 and 32503680000),
  dedupe_key text not null unique check (dedupe_key ~ '^[0-9a-f]{64}$'),
  received_at timestamptz not null default now(),
  status text not null default 'pending' check (status in (
    'pending', 'processing', 'processed', 'ignored', 'needs_review', 'failed', 'dead_letter')),
  attempts integer not null default 0 check (attempts >= 0),
  max_attempts integer not null default 8 check (max_attempts between 1 and 50),
  next_attempt_at timestamptz default now(),
  locked_until timestamptz,
  lock_token uuid,
  reason_code text check (reason_code in (
    'not_configured', 'environment_unset', 'not_eligible_category', 'not_eligible_stage',
    'before_cutoff', 'unmapped_owner', 'owner_not_in_pilot_branch', 'invalid_source_data',
    'source_deal_not_found', 'stale_ignored', 'reference_conflict')),
  last_error_code text check (last_error_code in (
    'provider_timeout', 'provider_unavailable', 'provider_rate_limited', 'provider_auth_failed',
    'provider_bad_response', 'internal_error')),
  last_error_at timestamptz,
  processed_deal_id uuid references public.deals (id),
  processed_at timestamptz,
  origin text not null default 'event' check (origin in ('event', 'reconcile', 'manual_retry')),
  updated_at timestamptz not null default now(),
  check ((status = 'processing') = (lock_token is not null and locked_until is not null)),
  check (status not in ('pending', 'failed') or next_attempt_at is not null),
  check (attempts <= max_attempts)
);
comment on table public.integration_inbox is
  'Bitrix intake work queue. Bounded parsed fields only: the raw provider payload is never stored.';
create index integration_inbox_due_idx on public.integration_inbox (next_attempt_at)
  where status in ('pending', 'failed');
create index integration_inbox_lease_idx on public.integration_inbox (locked_until)
  where status = 'processing';
create index integration_inbox_status_idx on public.integration_inbox (status, received_at desc);
create index integration_inbox_deal_idx on public.integration_inbox (portal_member_id, source_deal_id);
create index integration_inbox_processed_deal_idx on public.integration_inbox (processed_deal_id)
  where processed_deal_id is not null;

-- ---------------------------------------------------------------------------
-- Worker heartbeat (M2): counts and outcome codes only, no content.
-- ---------------------------------------------------------------------------

create table public.integration_worker_runs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('worker', 'reconcile')),
  started_at timestamptz not null,
  finished_at timestamptz not null,
  outcome text not null check (outcome in ('ok', 'partial', 'provider_error', 'internal_error')),
  claimed integer not null default 0 check (claimed between 0 and 1000000),
  created integer not null default 0 check (created between 0 and 1000000),
  updated integer not null default 0 check (updated between 0 and 1000000),
  ignored integer not null default 0 check (ignored between 0 and 1000000),
  needs_review integer not null default 0 check (needs_review between 0 and 1000000),
  failed integer not null default 0 check (failed between 0 and 1000000),
  dead_lettered integer not null default 0 check (dead_lettered between 0 and 1000000),
  enqueued integer not null default 0 check (enqueued between 0 and 1000000),
  recorded_at timestamptz not null default now(),
  check (finished_at >= started_at)
);
create index integration_worker_runs_kind_finished_idx on public.integration_worker_runs (kind, finished_at desc);
comment on table public.integration_worker_runs is
  'Durable heartbeat of worker and reconcile runs (counts only). Written by integration_record_worker_run.';

-- ---------------------------------------------------------------------------
-- Deals: provenance
-- ---------------------------------------------------------------------------

alter table public.deals
  add column source_system text check (source_system = 'bitrix'),
  add column source_portal text,
  add column source_deal_id bigint check (source_deal_id > 0),
  add column source_stage_id text,
  add column source_category_id bigint check (source_category_id >= 0),
  add column source_created_at timestamptz,
  add column source_modified_at timestamptz,
  add column last_synced_at timestamptz,
  -- Last time the source state was confirmed (apply incl. stale, reconcile up-to-date).
  add column last_verified_at timestamptz,
  add column intake_inbox_id uuid references public.integration_inbox (id);

alter table public.deals drop constraint deals_batch1_synthetic_only;
alter table public.deals add constraint deals_provenance check (
  (is_synthetic
    and source_system is null and source_portal is null and source_deal_id is null
    and source_stage_id is null and source_category_id is null and source_created_at is null
    and source_modified_at is null and last_synced_at is null and last_verified_at is null
    and intake_inbox_id is null)
  or
  (not is_synthetic
    and source_system = 'bitrix' and source_portal is not null and source_deal_id is not null
    and source_stage_id is not null and source_category_id is not null
    and source_created_at is not null and source_modified_at is not null
    and last_synced_at is not null and last_verified_at is not null and intake_inbox_id is not null)
);
-- The BX- reference prefix belongs to imported deals (L3).
alter table public.deals add constraint deals_synthetic_reference_prefix
  check (not (is_synthetic and reference like 'BX-%'));
alter table public.deals add constraint deals_source_identity_unique
  unique (source_system, source_portal, source_deal_id);
-- Target of the commercial provenance key below.
alter table public.deals add constraint deals_entity_id_synthetic_unique
  unique (legal_entity_id, id, is_synthetic);
create index deals_intake_inbox_idx on public.deals (intake_inbox_id) where intake_inbox_id is not null;

alter table public.deal_commercials drop constraint deal_commercials_batch1_synthetic_only;
-- Commercial rows remain synthetic only, and only for synthetic deals.
alter table public.deal_commercials add constraint deal_commercials_provenance check (is_synthetic);
alter table public.deal_commercials add constraint deal_commercials_synthetic_parent
  foreign key (legal_entity_id, deal_id, is_synthetic)
  references public.deals (legal_entity_id, id, is_synthetic);

-- ---------------------------------------------------------------------------
-- Permission (PROPOSED)
-- ---------------------------------------------------------------------------

insert into public.permissions (code, description, is_grantable) values
  ('integration.manage', 'View Bitrix intake configuration, staff mapping and review queue; retry inbox items.', false);
insert into public.role_permissions (role_code, permission_code, scope, policy_status, note) values
  ('super_admin', 'integration.manage', 'entity', 'proposed', 'Bitrix intake administration; no deal data implied');

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Valid session and integration.manage (entity scope) in the portal's entity.
create function authz.can_manage_portal(p_member_id text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.integration_intake_config c
    where c.portal_member_id = p_member_id
      and authz.can_admin('integration.manage', c.pilot_legal_entity_id)
  )
$$;

-- Valid session and p_permission (entity scope) in at least one entity.
create function authz.can_admin_any(p_permission text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.user_id = (select auth.uid()) and m.status = 'active'
      and authz.can_admin(p_permission, m.legal_entity_id)
  )
$$;

-- Raises 55000 when intake is not configured at all, 42501 when the portal
-- member id does not match an enabled config row.
create function authz.require_intake_portal(p_member_id text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if authz.deployment_environment() = 'unset' then
    raise exception 'intake is not configured (environment unset)' using errcode = '55000';
  end if;
  if exists (
    select 1 from public.integration_intake_config c
    where c.portal_member_id = p_member_id and c.enabled
  ) then
    return;
  end if;
  if not exists (select 1 from public.integration_intake_config c where c.enabled) then
    raise exception 'intake is not configured' using errcode = '55000';
  end if;
  raise exception 'portal not recognised' using errcode = '42501';
end;
$$;

create function authz.intake_dedupe_key(p_member_id text, p_event_type text, p_deal_id bigint, p_ts bigint)
returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(
    p_member_id || '|' || p_event_type || '|' || p_deal_id::text || '|' || p_ts::text, 'UTF8')), 'hex')
$$;

revoke all on function
  authz.deployment_environment(), authz.refuse_synthetic_when_operational(),
  authz.refuse_operational_with_synthetic(),
  authz.can_manage_portal(text), authz.can_admin_any(text), authz.require_intake_portal(text),
  authz.intake_dedupe_key(text, text, bigint, bigint)
from public, anon, authenticated;
grant execute on function authz.can_manage_portal(text), authz.can_admin_any(text) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.deployment_settings enable row level security;
alter table public.integration_intake_config enable row level security;
alter table public.bitrix_user_mappings enable row level security;
alter table public.integration_inbox enable row level security;
alter table public.integration_worker_runs enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'deployment_settings', 'integration_intake_config', 'bitrix_user_mappings', 'integration_inbox',
    'integration_worker_runs'
  ] loop
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
  end loop;
end;
$$;

create policy integration_admin_read on public.deployment_settings
  for select to authenticated using ((select authz.can_admin_any('integration.manage')));
create policy integration_admin_read on public.integration_intake_config
  for select to authenticated using (authz.can_admin('integration.manage', pilot_legal_entity_id));
create policy integration_admin_read on public.bitrix_user_mappings
  for select to authenticated using (authz.can_manage_portal(portal_member_id));
create policy integration_admin_read on public.integration_inbox
  for select to authenticated using (authz.can_manage_portal(portal_member_id));
create policy integration_admin_read on public.integration_worker_runs
  for select to authenticated using ((select authz.can_admin_any('integration.manage')));

revoke all on public.deployment_settings, public.integration_intake_config,
  public.bitrix_user_mappings, public.integration_inbox, public.integration_worker_runs
from public, anon, authenticated, service_role;
grant select on public.deployment_settings, public.integration_intake_config,
  public.bitrix_user_mappings, public.integration_inbox, public.integration_worker_runs
to authenticated;
-- Server-side operator access: reads everywhere; config and mapping rows are
-- maintained by an operator with the secret key. Inbox writes go through the
-- commands only; the environment row is owner-only.
grant select on public.deployment_settings, public.integration_intake_config,
  public.bitrix_user_mappings, public.integration_inbox, public.integration_worker_runs
to service_role;
grant insert, update on public.integration_intake_config, public.bitrix_user_mappings to service_role;

-- ---------------------------------------------------------------------------
-- Commands
-- ---------------------------------------------------------------------------

-- Receiver: store one notification. Returns {inboxId, duplicate}.
create function public.integration_record_bitrix_event(
  p_member_id text, p_event_type text, p_deal_id bigint, p_source_ts bigint
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_key text;
  v_id uuid;
begin
  perform authz.require_intake_portal(p_member_id);
  if p_event_type is null or p_event_type not in ('ONCRMDEALADD', 'ONCRMDEALUPDATE') then
    raise exception 'unsupported event type' using errcode = '22023';
  end if;
  if p_deal_id is null or p_deal_id <= 0 then
    raise exception 'invalid deal id' using errcode = '22023';
  end if;
  if p_source_ts is null or p_source_ts < 0 or p_source_ts > 32503680000 then
    raise exception 'invalid event timestamp' using errcode = '22023';
  end if;

  v_key := authz.intake_dedupe_key(p_member_id, p_event_type, p_deal_id, p_source_ts);
  -- Exact redelivery.
  select i.id into v_id from public.integration_inbox i where i.dedupe_key = v_key;
  if v_id is not null then
    return jsonb_build_object('inboxId', v_id, 'duplicate', true);
  end if;
  -- Coalesce into an unclaimed pending row for the same deal (L6): the worker
  -- re-reads current state, so no information is lost.
  select i.id into v_id from public.integration_inbox i
  where i.portal_member_id = p_member_id and i.source_deal_id = p_deal_id and i.status = 'pending'
  order by i.received_at
  limit 1;
  if v_id is not null then
    return jsonb_build_object('inboxId', v_id, 'duplicate', true);
  end if;

  insert into public.integration_inbox
    (portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, origin)
  values (p_member_id, p_event_type, p_deal_id, p_source_ts, v_key, 'event')
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('inboxId', v_id, 'duplicate', false);
  end if;
  select i.id into v_id from public.integration_inbox i where i.dedupe_key = v_key;
  return jsonb_build_object('inboxId', v_id, 'duplicate', true);
end;
$$;

-- Reconcile: enqueue a deal found by crm.deal.list unless CRM already holds
-- this version or an open inbox row exists. Returns {inboxId, duplicate, upToDate}.
create function public.integration_enqueue_reconcile(
  p_member_id text, p_deal_id bigint, p_source_modified bigint
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_key text;
  v_id uuid;
begin
  perform authz.require_intake_portal(p_member_id);
  if p_deal_id is null or p_deal_id <= 0 then
    raise exception 'invalid deal id' using errcode = '22023';
  end if;
  if p_source_modified is null or p_source_modified < 0 or p_source_modified > 32503680000 then
    raise exception 'invalid source modification time' using errcode = '22023';
  end if;

  -- CRM already holds this version: record the confirmation (M1), no work.
  update public.deals d
  set last_verified_at = now()
  where d.source_system = 'bitrix' and d.source_portal = p_member_id and d.source_deal_id = p_deal_id
    and d.source_modified_at >= to_timestamp(p_source_modified::double precision);
  if found then
    return jsonb_build_object('inboxId', null, 'duplicate', true, 'upToDate', true);
  end if;

  select i.id into v_id from public.integration_inbox i
  where i.portal_member_id = p_member_id and i.source_deal_id = p_deal_id
    and i.status in ('pending', 'processing', 'failed')
  order by i.received_at
  limit 1;
  if v_id is not null then
    return jsonb_build_object('inboxId', v_id, 'duplicate', true, 'upToDate', false);
  end if;

  v_key := authz.intake_dedupe_key(p_member_id, 'RECONCILE', p_deal_id, p_source_modified);
  insert into public.integration_inbox
    (portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, origin)
  values (p_member_id, 'RECONCILE', p_deal_id, p_source_modified, v_key, 'reconcile')
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('inboxId', v_id, 'duplicate', false, 'upToDate', false);
  end if;
  select i.id into v_id from public.integration_inbox i where i.dedupe_key = v_key;
  return jsonb_build_object('inboxId', v_id, 'duplicate', true, 'upToDate', false);
end;
$$;

-- Worker: lease up to p_limit due rows (pending, failed and due, or processing
-- with an expired lease) for p_lease_seconds. Each claim counts as an attempt;
-- an expired lease at max_attempts becomes dead_letter instead.
create function public.integration_claim_inbox(p_limit integer, p_lease_seconds integer)
returns setof jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if authz.deployment_environment() = 'unset' then
    raise exception 'intake is not configured (environment unset)' using errcode = '55000';
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'limit must be between 1 and 100' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'lease must be between 30 and 900 seconds' using errcode = '22023';
  end if;

  update public.integration_inbox i
  set status = 'dead_letter', lock_token = null, locked_until = null, next_attempt_at = null,
      last_error_code = coalesce(i.last_error_code, 'internal_error'), last_error_at = now(),
      updated_at = now()
  where i.status = 'processing' and i.locked_until <= now() and i.attempts >= i.max_attempts;

  return query
  with picked as (
    select i.id
    from public.integration_inbox i
    where (
        (i.status in ('pending', 'failed') and i.next_attempt_at <= now())
        or (i.status = 'processing' and i.locked_until <= now())
      )
      and i.attempts < i.max_attempts
      and exists (
        select 1 from public.integration_intake_config c
        where c.portal_member_id = i.portal_member_id and c.enabled
      )
    order by coalesce(i.next_attempt_at, i.received_at), i.received_at
    limit p_limit
    for update of i skip locked
  )
  update public.integration_inbox i
  set status = 'processing',
      lock_token = gen_random_uuid(),
      locked_until = now() + make_interval(secs => p_lease_seconds),
      attempts = i.attempts + 1,
      updated_at = now()
  from picked
  where i.id = picked.id
  returning jsonb_build_object(
    'inboxId', i.id,
    'lockToken', i.lock_token,
    'portalMemberId', i.portal_member_id,
    'sourceDealId', i.source_deal_id::text,
    'eventType', i.event_type,
    'origin', i.origin,
    'attempts', i.attempts);
end;
$$;

-- Worker: apply the deal re-read from crm.deal.get. p_deal null (or JSON null)
-- means the source deal was not found. Returns {outcome, dealId, reasonCode}.
--
-- Version rule (M1): an older DATE_MODIFY is stale_ignored; an EQUAL one
-- updates only when Bitrix-owned content (title, stage, category, mapped
-- owner) differs, else stale_ignored. Every confirmation sets last_verified_at.
create function public.integration_apply_bitrix_deal(p_inbox_id uuid, p_lock_token uuid, p_deal jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_inbox public.integration_inbox%rowtype;
  v_cfg public.integration_intake_config%rowtype;
  v_existing public.deals%rowtype;
  v_outcome text;
  v_reason text;
  v_deal_id uuid;
  v_owner uuid;
  v_title text;
  v_stage text;
  v_category bigint;
  v_assigned bigint;
  v_created timestamptz;
  v_modified timestamptz;
  v_owner_changed boolean := false;
  v_invalid boolean := false;
  v_ref_conflict boolean := false;
  v_constraint text;
  v_iso constant text :=
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:?[0-9]{2})$';
begin
  select * into v_inbox from public.integration_inbox where id = p_inbox_id for update;
  if v_inbox.id is null or v_inbox.status <> 'processing' or v_inbox.lock_token is distinct from p_lock_token
     or v_inbox.locked_until <= now() then
    raise exception 'inbox lease not held' using errcode = '55P03';
  end if;

  <<checks>>
  begin
    if authz.deployment_environment() = 'unset' then
      v_outcome := 'needs_review'; v_reason := 'environment_unset';
      exit checks;
    end if;

    select * into v_cfg from public.integration_intake_config c
    where c.portal_member_id = v_inbox.portal_member_id and c.enabled;
    if v_cfg.id is null then
      v_outcome := 'needs_review'; v_reason := 'not_configured';
      exit checks;
    end if;

    if p_deal is null or jsonb_typeof(p_deal) = 'null' then
      v_outcome := 'needs_review'; v_reason := 'source_deal_not_found';
      exit checks;
    end if;

    -- Required fields present, strings, bounded and well formed. Any
    -- data_exception while parsing (SQLSTATE class 22) is invalid source data
    -- (L2), never a worker failure.
    if jsonb_typeof(p_deal) <> 'object' or exists (
         select 1 from unnest(array['id', 'title', 'stageId', 'categoryId', 'assignedById',
                                    'dateCreate', 'dateModify']) k
         where jsonb_typeof(p_deal -> k) is distinct from 'string') then
      v_outcome := 'needs_review'; v_reason := 'invalid_source_data';
      exit checks;
    end if;
    begin
      if (p_deal ->> 'id') !~ '^[1-9][0-9]{0,17}$'
         or length(btrim(p_deal ->> 'title')) not between 1 and 300
         or (p_deal ->> 'stageId') !~ '^[A-Za-z0-9_:.-]{1,50}$'
         or (p_deal ->> 'categoryId') !~ '^[0-9]{1,18}$'
         or (p_deal ->> 'assignedById') !~ '^[1-9][0-9]{0,17}$'
         or (p_deal ->> 'dateCreate') !~ v_iso
         or (p_deal ->> 'dateModify') !~ v_iso then
        v_invalid := true;
      else
        v_title := btrim(p_deal ->> 'title');
        v_stage := p_deal ->> 'stageId';
        v_category := (p_deal ->> 'categoryId')::bigint;
        v_assigned := (p_deal ->> 'assignedById')::bigint;
        v_created := (p_deal ->> 'dateCreate')::timestamptz;
        v_modified := (p_deal ->> 'dateModify')::timestamptz;
        if (p_deal ->> 'id')::bigint <> v_inbox.source_deal_id or v_modified < v_created then
          v_invalid := true;
        end if;
      end if;
    exception when data_exception then
      v_invalid := true;
    end;
    if v_invalid then
      v_outcome := 'needs_review'; v_reason := 'invalid_source_data';
      exit checks;
    end if;

    select * into v_existing from public.deals d
    where d.source_system = 'bitrix' and d.source_portal = v_cfg.portal_member_id
      and d.source_deal_id = v_inbox.source_deal_id
    for update;

    -- Eligibility. Category always; stage and cutoff decide ENTRY only (an
    -- imported deal keeps following Bitrix stage changes).
    if v_category <> v_cfg.category_id then
      v_outcome := 'ignored'; v_reason := 'not_eligible_category';
      exit checks;
    end if;
    if v_existing.id is null then
      if not (v_stage = any (v_cfg.eligible_stage_ids)) then
        v_outcome := 'ignored'; v_reason := 'not_eligible_stage';
        exit checks;
      end if;
      if v_created < v_cfg.cutoff_at then
        v_outcome := 'ignored'; v_reason := 'before_cutoff';
        exit checks;
      end if;
    elsif v_modified < v_existing.source_modified_at then
      v_outcome := 'stale_ignored'; v_reason := 'stale_ignored'; v_deal_id := v_existing.id;
      exit checks;
    end if;

    -- Owner: active mapping -> active staff -> active membership in the pilot
    -- branch. No guessed branch, no administrator fallback.
    select m.staff_user_id into v_owner
    from public.bitrix_user_mappings m
    join public.staff_profiles p on p.user_id = m.staff_user_id and p.status = 'active'
    where m.portal_member_id = v_cfg.portal_member_id and m.bitrix_user_id = v_assigned and m.active;
    if v_owner is null then
      v_outcome := 'needs_review'; v_reason := 'unmapped_owner';
      exit checks;
    end if;
    if not exists (
      select 1 from public.memberships ms
      where ms.user_id = v_owner and ms.legal_entity_id = v_cfg.pilot_legal_entity_id
        and ms.branch_id = v_cfg.pilot_branch_id and ms.status = 'active'
    ) then
      v_outcome := 'needs_review'; v_reason := 'owner_not_in_pilot_branch';
      exit checks;
    end if;

    if v_existing.id is null then
      begin
        insert into public.deals
          (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic,
           source_system, source_portal, source_deal_id, source_stage_id, source_category_id,
           source_created_at, source_modified_at, last_synced_at, last_verified_at, intake_inbox_id)
        values
          (v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'BX-' || v_inbox.source_deal_id::text,
           v_title, v_owner, false,
           'bitrix', v_cfg.portal_member_id, v_inbox.source_deal_id, v_stage, v_category,
           v_created, v_modified, now(), now(), v_inbox.id)
        on conflict on constraint deals_source_identity_unique do nothing
        returning id into v_deal_id;
      exception when unique_violation then
        -- Only the (entity, reference) key can collide here; anything else is a bug.
        get stacked diagnostics v_constraint = constraint_name;
        if v_constraint is distinct from 'deals_legal_entity_id_reference_key' then
          raise;
        end if;
        v_ref_conflict := true;
      end;
      if v_ref_conflict then
        -- A concurrent insert for this same source can win both unique keys.
        -- ON CONFLICT above handles the source key, but Postgres may report
        -- the reference key instead. Recheck source identity after the losing
        -- insert has waited for its winner to commit. Only a different source
        -- holding the reference is a real review conflict.
        select * into v_existing from public.deals d
        where d.source_system = 'bitrix' and d.source_portal = v_cfg.portal_member_id
          and d.source_deal_id = v_inbox.source_deal_id
        for update;
        if v_existing.id is null then
          v_outcome := 'needs_review'; v_reason := 'reference_conflict';
          exit checks;
        end if;
      end if;
      if v_deal_id is not null then
        v_outcome := 'created';
        exit checks;
      end if;
      -- Lost an insert race: continue as an update under the version check.
      select * into v_existing from public.deals d
      where d.source_system = 'bitrix' and d.source_portal = v_cfg.portal_member_id
        and d.source_deal_id = v_inbox.source_deal_id
      for update;
      if v_modified < v_existing.source_modified_at then
        v_outcome := 'stale_ignored'; v_reason := 'stale_ignored'; v_deal_id := v_existing.id;
        exit checks;
      end if;
    end if;

    -- Equal version and identical Bitrix-owned content: nothing to change.
    if v_modified = v_existing.source_modified_at
       and v_existing.title = v_title and v_existing.source_stage_id = v_stage
       and v_existing.source_category_id = v_category and v_existing.owner_user_id = v_owner then
      v_outcome := 'stale_ignored'; v_reason := 'stale_ignored'; v_deal_id := v_existing.id;
      exit checks;
    end if;

    -- Update the Bitrix-owned header fields only. Entity, branch, reference and
    -- deal_assignments stay as they are; the owner follows the mapping.
    v_owner_changed := v_existing.owner_user_id <> v_owner;
    update public.deals d
    set title = v_title,
        owner_user_id = v_owner,
        source_stage_id = v_stage,
        source_category_id = v_category,
        source_created_at = v_created,
        source_modified_at = v_modified,
        last_synced_at = now(),
        last_verified_at = now(),
        intake_inbox_id = v_inbox.id
    where d.id = v_existing.id;
    v_deal_id := v_existing.id;
    v_outcome := 'updated';
  end checks;

  -- The source state was confirmed without a change (M1).
  if v_outcome = 'stale_ignored' then
    update public.deals d set last_verified_at = now() where d.id = v_deal_id;
  end if;

  update public.integration_inbox i
  set status = case v_outcome
                 when 'created' then 'processed'
                 when 'updated' then 'processed'
                 when 'needs_review' then 'needs_review'
                 else 'ignored'
               end,
      reason_code = v_reason,
      processed_deal_id = v_deal_id,
      processed_at = now(),
      lock_token = null,
      locked_until = null,
      next_attempt_at = null,
      updated_at = now()
  where i.id = v_inbox.id;

  -- Audit: identifiers and codes only, never customer content.
  if v_outcome in ('created', 'updated') then
    perform authz.write_audit(
      case when v_outcome = 'created' then 'integration.deal_created' else 'integration.deal_updated' end,
      v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'deal', v_deal_id, null,
      jsonb_build_object('inboxId', v_inbox.id, 'origin', v_inbox.origin, 'ownerChanged', v_owner_changed));
  elsif v_outcome = 'needs_review' then
    perform authz.write_audit('integration.deal_needs_review',
      v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'integration_inbox', v_inbox.id, null,
      jsonb_build_object('inboxId', v_inbox.id, 'origin', v_inbox.origin, 'reasonCode', v_reason));
  end if;

  return jsonb_build_object('outcome', v_outcome, 'dealId', v_deal_id, 'reasonCode', v_reason);
end;
$$;

-- Worker: record a failed attempt. Retryable errors back off exponentially
-- (PROPOSED: 60 s * 2^(attempts-1), capped at 3600 s); non-retryable errors and
-- the last allowed attempt become dead_letter.
create function public.integration_fail_inbox(
  p_inbox_id uuid, p_lock_token uuid, p_error_code text, p_retryable boolean
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_inbox public.integration_inbox%rowtype;
  v_dead boolean;
  v_next timestamptz;
begin
  if p_error_code is null or p_error_code not in (
    'provider_timeout', 'provider_unavailable', 'provider_rate_limited', 'provider_auth_failed',
    'provider_bad_response', 'internal_error') then
    raise exception 'unknown error code' using errcode = '22023';
  end if;
  select * into v_inbox from public.integration_inbox where id = p_inbox_id for update;
  if v_inbox.id is null or v_inbox.status <> 'processing' or v_inbox.lock_token is distinct from p_lock_token
     or v_inbox.locked_until <= now() then
    raise exception 'inbox lease not held' using errcode = '55P03';
  end if;

  v_dead := not coalesce(p_retryable, false) or v_inbox.attempts >= v_inbox.max_attempts;
  if not v_dead then
    v_next := now() + make_interval(secs => least(3600, 60 * power(2, greatest(v_inbox.attempts - 1, 0))));
  end if;

  update public.integration_inbox i
  set status = case when v_dead then 'dead_letter' else 'failed' end,
      last_error_code = p_error_code,
      last_error_at = now(),
      next_attempt_at = v_next,
      lock_token = null,
      locked_until = null,
      updated_at = now()
  where i.id = v_inbox.id;

  return jsonb_build_object(
    'inboxId', v_inbox.id,
    'status', case when v_dead then 'dead_letter' else 'failed' end,
    'attempts', v_inbox.attempts,
    'nextAttemptAt', v_next);
end;
$$;

-- Administrator: move needs_review|failed|dead_letter back to pending.
create function public.integration_retry_inbox(p_inbox_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_inbox public.integration_inbox%rowtype;
  v_cfg public.integration_intake_config%rowtype;
begin
  select * into v_inbox from public.integration_inbox where id = p_inbox_id for update;
  if v_inbox.id is not null then
    select * into v_cfg from public.integration_intake_config c
    where c.portal_member_id = v_inbox.portal_member_id;
  end if;
  if v_inbox.id is null or v_cfg.id is null
     or not authz.can_admin('integration.manage', v_cfg.pilot_legal_entity_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_inbox.status not in ('needs_review', 'failed', 'dead_letter') then
    raise exception 'only needs_review, failed or dead_letter items can be retried' using errcode = '22023';
  end if;

  update public.integration_inbox i
  set status = 'pending', origin = 'manual_retry', attempts = 0, next_attempt_at = now(),
      reason_code = null, lock_token = null, locked_until = null, updated_at = now()
  where i.id = v_inbox.id;

  perform authz.write_audit('integration.inbox_retried', v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id,
    'integration_inbox', v_inbox.id, null,
    jsonb_build_object('previousStatus', v_inbox.status, 'reasonCode', v_inbox.reason_code,
      'lastErrorCode', v_inbox.last_error_code));
  return jsonb_build_object('inboxId', v_inbox.id, 'status', 'pending', 'previousStatus', v_inbox.status);
end;
$$;

-- Worker: hand a leased row back to pending WITHOUT consuming an attempt (L1),
-- e.g. a run deadline overrun or a provider rate-limit deferral.
-- Returns {inboxId, status: 'pending', attempts}.
create function public.integration_release_inbox(p_inbox_id uuid, p_lock_token uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_inbox public.integration_inbox%rowtype;
begin
  select * into v_inbox from public.integration_inbox where id = p_inbox_id for update;
  if v_inbox.id is null or v_inbox.status <> 'processing' or v_inbox.lock_token is distinct from p_lock_token
     or v_inbox.locked_until <= now() then
    raise exception 'inbox lease not held' using errcode = '55P03';
  end if;
  update public.integration_inbox i
  set status = 'pending', attempts = greatest(i.attempts - 1, 0), next_attempt_at = now(),
      lock_token = null, locked_until = null, updated_at = now()
  where i.id = v_inbox.id;
  return jsonb_build_object('inboxId', v_inbox.id, 'status', 'pending',
    'attempts', greatest(v_inbox.attempts - 1, 0));
end;
$$;

-- Worker/reconcile heartbeat (M2). p_run keys (others refused):
--   kind 'worker'|'reconcile', startedAt, finishedAt (ISO 8601),
--   outcome 'ok'|'partial'|'provider_error'|'internal_error',
--   optional integer counts claimed, created, updated, ignored, needsReview,
--   failed, deadLettered, enqueued (default 0).
-- Returns {runId}.
create function public.integration_record_worker_run(p_run jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid;
  v_started timestamptz;
  v_finished timestamptz;
  v_counts integer[];
  v_count_keys constant text[] := array['claimed', 'created', 'updated', 'ignored', 'needsReview',
    'failed', 'deadLettered', 'enqueued'];
  v_key text;
  v_iso constant text :=
    '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:?[0-9]{2})$';
begin
  if p_run is null or jsonb_typeof(p_run) <> 'object' then
    raise exception 'run must be an object' using errcode = '22023';
  end if;
  if exists (
    select 1 from jsonb_object_keys(p_run) k
    where k <> all (array['kind', 'startedAt', 'finishedAt', 'outcome'] || v_count_keys)
  ) then
    raise exception 'unknown run field' using errcode = '22023';
  end if;
  if (p_run ->> 'kind') is null or (p_run ->> 'kind') not in ('worker', 'reconcile')
     or (p_run ->> 'outcome') is null
     or (p_run ->> 'outcome') not in ('ok', 'partial', 'provider_error', 'internal_error')
     or jsonb_typeof(p_run -> 'startedAt') is distinct from 'string'
     or jsonb_typeof(p_run -> 'finishedAt') is distinct from 'string'
     or (p_run ->> 'startedAt') !~ v_iso or (p_run ->> 'finishedAt') !~ v_iso then
    raise exception 'invalid run' using errcode = '22023';
  end if;
  foreach v_key in array v_count_keys loop
    if p_run ? v_key and (jsonb_typeof(p_run -> v_key) <> 'number'
       or (p_run ->> v_key) !~ '^[0-9]{1,7}$' or (p_run ->> v_key)::integer > 1000000) then
      raise exception 'invalid count %', v_key using errcode = '22023';
    end if;
    v_counts := v_counts || coalesce((p_run ->> v_key)::integer, 0);
  end loop;
  begin
    v_started := (p_run ->> 'startedAt')::timestamptz;
    v_finished := (p_run ->> 'finishedAt')::timestamptz;
  exception when data_exception then
    raise exception 'invalid run timestamps' using errcode = '22023';
  end;
  if v_finished < v_started or v_finished > now() + interval '5 minutes'
     or v_started < now() - interval '7 days' then
    raise exception 'invalid run timestamps' using errcode = '22023';
  end if;

  insert into public.integration_worker_runs
    (kind, started_at, finished_at, outcome, claimed, created, updated, ignored, needs_review,
     failed, dead_lettered, enqueued)
  values (p_run ->> 'kind', v_started, v_finished, p_run ->> 'outcome', v_counts[1], v_counts[2],
     v_counts[3], v_counts[4], v_counts[5], v_counts[6], v_counts[7], v_counts[8])
  returning id into v_id;
  return jsonb_build_object('runId', v_id);
end;
$$;

-- Reconcile watermark (M1). On success the watermark moves to the run's START
-- (never backwards), so deals modified during the run are listed again next
-- time. A failed run leaves it unchanged.
-- Returns {portalMemberId, lastReconciledAt, advanced}.
create function public.integration_record_reconcile_run(
  p_member_id text, p_started_at timestamptz, p_ok boolean
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_advanced boolean := false;
begin
  perform authz.require_intake_portal(p_member_id);
  if p_started_at is null or p_started_at > now() + interval '5 minutes' or p_ok is null then
    raise exception 'invalid reconcile run' using errcode = '22023';
  end if;
  select * into v_cfg from public.integration_intake_config c where c.portal_member_id = p_member_id for update;
  if p_ok and (v_cfg.last_reconciled_at is null or p_started_at > v_cfg.last_reconciled_at) then
    update public.integration_intake_config c
    set last_reconciled_at = p_started_at, updated_at = now()
    where c.id = v_cfg.id;
    v_cfg.last_reconciled_at := p_started_at;
    v_advanced := true;
  end if;
  return jsonb_build_object('portalMemberId', p_member_id, 'lastReconciledAt', v_cfg.last_reconciled_at,
    'advanced', v_advanced);
end;
$$;

-- Administrator "check Bitrix for missed deals now" (L5): authorizes against
-- the single enabled config, enforces a PROPOSED 300 s cooldown and audits
-- every attempt. The server lists Bitrix only when allowed = true.
-- Returns {portalMemberId, allowed, retryAfterSeconds}.
create function public.integration_request_reconcile() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_enabled integer;
  v_cooldown constant integer := 300; -- PROPOSED
  v_retry integer := 0;
begin
  if not authz.can_admin_any('integration.manage') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select count(*) into v_enabled from public.integration_intake_config c where c.enabled;
  if authz.deployment_environment() = 'unset' or v_enabled <> 1 then
    raise exception 'intake is not configured' using errcode = '55000';
  end if;
  select * into v_cfg from public.integration_intake_config c where c.enabled for update;
  if not authz.can_admin('integration.manage', v_cfg.pilot_legal_entity_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  if v_cfg.last_reconcile_requested_at is not null
     and v_cfg.last_reconcile_requested_at > now() - make_interval(secs => v_cooldown) then
    v_retry := greatest(1, ceil(extract(epoch from
      (v_cfg.last_reconcile_requested_at + make_interval(secs => v_cooldown) - now())))::integer);
  else
    update public.integration_intake_config c
    set last_reconcile_requested_at = now()
    where c.id = v_cfg.id;
  end if;

  perform authz.write_audit('integration.reconcile_requested', v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id,
    'integration_intake_config', v_cfg.id, null,
    jsonb_build_object('allowed', v_retry = 0, 'retryAfterSeconds', v_retry));
  return jsonb_build_object('portalMemberId', v_cfg.portal_member_id, 'allowed', v_retry = 0,
    'retryAfterSeconds', v_retry);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants (explicit; nothing for anon)
-- ---------------------------------------------------------------------------

revoke all on function
  public.integration_record_bitrix_event(text, text, bigint, bigint),
  public.integration_enqueue_reconcile(text, bigint, bigint),
  public.integration_claim_inbox(integer, integer),
  public.integration_apply_bitrix_deal(uuid, uuid, jsonb),
  public.integration_fail_inbox(uuid, uuid, text, boolean),
  public.integration_retry_inbox(uuid),
  public.integration_release_inbox(uuid, uuid),
  public.integration_record_worker_run(jsonb),
  public.integration_record_reconcile_run(text, timestamptz, boolean),
  public.integration_request_reconcile()
from public, anon, authenticated, service_role;

grant execute on function
  public.integration_record_bitrix_event(text, text, bigint, bigint),
  public.integration_enqueue_reconcile(text, bigint, bigint),
  public.integration_claim_inbox(integer, integer),
  public.integration_apply_bitrix_deal(uuid, uuid, jsonb),
  public.integration_fail_inbox(uuid, uuid, text, boolean),
  public.integration_release_inbox(uuid, uuid),
  public.integration_record_worker_run(jsonb),
  public.integration_record_reconcile_run(text, timestamptz, boolean)
to service_role;

grant execute on function
  public.integration_retry_inbox(uuid),
  public.integration_request_reconcile()
to authenticated;

commit;
