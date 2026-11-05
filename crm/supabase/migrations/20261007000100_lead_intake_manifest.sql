-- TripNavigate CRM - Phase 6: manifest-contained Lead intake and universal
-- intake isolation.
--
-- Contract: docs/implementation/phase-6/contract.md (sections 1, 2 and 3).
-- Not applied to any hosted database by this change. Earlier migrations are
-- unchanged; every existing RPC keeps its signature (functions below that
-- already existed are replaced with CREATE OR REPLACE and identical argument
-- lists). New behaviour is reached through new functions.
--
-- What changes:
--   * public.intake_manifests / public.intake_manifest_items: the owner's
--     approved scope. One manifest = one portal config, one source object
--     (deal|lead), one verified Bitrix SOURCE_ID code, one half-open creation
--     interval and an exact id list (count = expected_count). At most one
--     ACTIVE manifest per config and source object. Written only by the
--     service-role operator commands integration_manifest_create /
--     integration_manifest_close (both audited). Items are immutable; a
--     manifest only moves active -> closed. No grant to anon/authenticated.
--   * authz.intake_manifest_allows(config, object, id): true only when an
--     active manifest for that config and object contains the id. No active
--     manifest = nothing is imported.
--   * authz.intake_portal_allowed(domain): environment isolation for every
--     intake path. operational = real domains only (reserved .test refused);
--     test = only an enabled reserved .test portal; staging/unset = refuse.
--     Refusals raise SQLSTATE 55000 with the exact message 'environment_unset'
--     (environment unset) or 'not_configured' (anything else) (review L1/L2).
--   * public.crm_leads: Bitrix Lead header only (no contact, phone, email,
--     comments, amounts or files). Reference BXL-<lead id>. Readable by the
--     mapped owner with an active Sales membership in the lead's branch, the
--     branch manager and integration.manage admins; never by a Purchase role
--     holder. No write grants: only integration_apply_bitrix_lead writes.
--   * public.integration_inbox gains source_object (deal|lead, default deal)
--     and processed_lead_id. Lead events ONCRMLEADADD / ONCRMLEADUPDATE are
--     accepted. New rows use a dedupe key that includes the source object:
--     sha256(member|object|event|id|ts). Rows recorded before this migration
--     keep their old key (unchanged); a redelivery of such an event coalesces
--     into its pending row or is re-applied idempotently (stale_ignored).
--   * Events outside the active manifest are acknowledged with the same
--     {inboxId, duplicate} shape and stored as status 'ignored', reason
--     'not_in_manifest', attempts 0 (dedupe still applies).
--   * Replaced (same signatures): authz.require_intake_portal,
--     integration_record_bitrix_event, integration_receive_bitrix_event,
--     integration_enqueue_reconcile, integration_claim_inbox,
--     integration_apply_bitrix_deal, integration_request_reconcile.
--   * Both apply commands lock the active manifest row FOR SHARE before any
--     write; integration_manifest_close locks it FOR UPDATE.
--   * New service-role commands: integration_apply_bitrix_lead,
--     integration_enqueue_reconcile_lead, integration_manifest_create,
--     integration_manifest_close, integration_active_manifest.
--   * Deal snapshots passed to integration_apply_bitrix_deal must now carry
--     "sourceId" (Bitrix SOURCE_ID, string or null); it must equal the active
--     manifest's source code and dateCreate must fall inside the manifest
--     interval, else needs_review / outside_manifest_scope.
--
-- SQLSTATEs (unchanged codes, exact L1 messages):
--   55000 'environment_unset'  deployment environment unset
--   55000 'not_configured'     staging, wrong portal class for the environment,
--                              no enabled config, more than one (receiver)
--   42501 'portal not recognised' / not authorized
--   22023 invalid argument; 'source object mismatch' when a Lead inbox row is
--         passed to the Deal apply command or the reverse
--
-- Stop switches (any one stops further CRM row writes):
--   select public.integration_manifest_close('<manifest id>', '<operator>');
--   update public.integration_intake_config set enabled = false;
--   update public.deployment_settings set environment = 'unset';
--
-- Rollback (forward-only): a NEW migration that closes every active manifest
-- (intake then imports nothing), revokes EXECUTE on the new commands and, if
-- wanted, drops them. crm_leads, manifests, inbox rows and audit rows are kept.
-- Restoring the earlier function bodies would remove the manifest gate and the
-- .test isolation; do that only with intake stopped.

begin;

-- ---------------------------------------------------------------------------
-- Manifests (owner-controlled scope)
-- ---------------------------------------------------------------------------

create table public.intake_manifests (
  id uuid primary key default gen_random_uuid(),
  config_id uuid not null references public.integration_intake_config (id),
  source_object text not null check (source_object in ('deal', 'lead')),
  -- Verified Bitrix SOURCE_ID code, e.g. WEBFORM.
  source_code text not null check (source_code ~ '^[A-Za-z0-9_:.-]{1,50}$'),
  business_date date not null,
  -- Half-open creation interval [interval_from, interval_to).
  interval_from timestamptz not null,
  interval_to timestamptz not null,
  expected_count integer not null check (expected_count between 1 and 10000),
  status text not null default 'active' check (status in ('active', 'closed')),
  created_by_operator text not null check (created_by_operator ~ '^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,99}$'),
  created_at timestamptz not null default now(),
  closed_by_operator text check (closed_by_operator ~ '^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,99}$'),
  closed_at timestamptz,
  check (interval_to > interval_from),
  check ((status = 'closed') = (closed_at is not null and closed_by_operator is not null)),
  unique (id, source_object)
);
create unique index intake_manifests_one_active_idx
  on public.intake_manifests (config_id, source_object) where status = 'active';
comment on table public.intake_manifests is
  'Owner-approved intake scope: one config, one source object, one source code, one interval, an exact id list. Operator commands only.';

create table public.intake_manifest_items (
  manifest_id uuid not null,
  source_object text not null check (source_object in ('deal', 'lead')),
  source_id bigint not null check (source_id > 0),
  primary key (manifest_id, source_object, source_id),
  foreign key (manifest_id, source_object) references public.intake_manifests (id, source_object)
);
create index intake_manifest_items_lookup_idx on public.intake_manifest_items (source_object, source_id);
comment on table public.intake_manifest_items is
  'Bitrix ids contained in a manifest. Immutable; count always equals the manifest expected_count.';

-- Items never change after creation; the manifest only moves active -> closed.
create function authz.intake_manifest_items_immutable() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'manifest items are immutable' using errcode = '23514';
end;
$$;
create trigger intake_manifest_items_immutable
  before update or delete on public.intake_manifest_items
  for each row execute function authz.intake_manifest_items_immutable();

create function authz.intake_manifest_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'manifests are never deleted; close them' using errcode = '23514';
  end if;
  if old.status <> 'active' or new.status <> 'closed'
     or (new.id, new.config_id, new.source_object, new.source_code, new.business_date, new.interval_from,
         new.interval_to, new.expected_count, new.created_by_operator, new.created_at)
        is distinct from
        (old.id, old.config_id, old.source_object, old.source_code, old.business_date, old.interval_from,
         old.interval_to, old.expected_count, old.created_by_operator, old.created_at) then
    raise exception 'a manifest can only be closed' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger intake_manifest_guard
  before update or delete on public.intake_manifests
  for each row execute function authz.intake_manifest_guard();

-- count(items) = expected_count, checked at commit for every manifest touched
-- (the create command also checks it immediately).
create function authz.intake_manifest_assert_count(p_manifest uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_expected integer;
  v_count integer;
begin
  select m.expected_count into v_expected from public.intake_manifests m where m.id = p_manifest;
  if v_expected is null then
    return;
  end if;
  select count(*)::integer into v_count from public.intake_manifest_items i where i.manifest_id = p_manifest;
  if v_count <> v_expected then
    raise exception 'manifest item count does not match expected_count' using errcode = '23514';
  end if;
end;
$$;

create function authz.intake_manifest_count_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_table_name = 'intake_manifests' then
    perform authz.intake_manifest_assert_count(new.id);
  else
    perform authz.intake_manifest_assert_count(new.manifest_id);
  end if;
  return null;
end;
$$;
create constraint trigger intake_manifests_count
  after insert on public.intake_manifests deferrable initially deferred
  for each row execute function authz.intake_manifest_count_trigger();
create constraint trigger intake_manifest_items_count
  after insert on public.intake_manifest_items deferrable initially deferred
  for each row execute function authz.intake_manifest_count_trigger();

-- ---------------------------------------------------------------------------
-- CRM Lead header (Bitrix owns every field)
-- ---------------------------------------------------------------------------

create table public.crm_leads (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  reference text not null unique check (reference ~ '^BXL-[1-9][0-9]{0,17}$'),
  title text not null check (length(title) between 1 and 200),
  owner_user_id uuid not null references public.staff_profiles (user_id),
  source_system text not null default 'bitrix' check (source_system = 'bitrix'),
  -- Portal member id (same convention as deals.source_portal).
  source_portal text not null,
  source_lead_id bigint not null check (source_lead_id > 0),
  source_status_id text not null check (source_status_id ~ '^[A-Za-z0-9_:.-]{1,50}$'),
  source_id_code text not null check (source_id_code ~ '^[A-Za-z0-9_:.-]{1,50}$'),
  source_created_at timestamptz not null,
  source_modified_at timestamptz not null,
  last_synced_at timestamptz not null,
  last_verified_at timestamptz not null,
  intake_inbox_id uuid not null references public.integration_inbox (id),
  manifest_id uuid not null references public.intake_manifests (id),
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, branch_id) references public.branches (legal_entity_id, id),
  constraint crm_leads_source_identity_unique unique (source_system, source_portal, source_lead_id),
  check (reference = 'BXL-' || source_lead_id::text),
  check (source_modified_at >= source_created_at)
);
create index crm_leads_branch_idx on public.crm_leads (legal_entity_id, branch_id);
create index crm_leads_owner_idx on public.crm_leads (owner_user_id);
create index crm_leads_inbox_idx on public.crm_leads (intake_inbox_id);
create index crm_leads_manifest_idx on public.crm_leads (manifest_id);
comment on table public.crm_leads is
  'Bitrix Lead header only (no contact, phone, email, comments, amounts or files). Written only by integration_apply_bitrix_lead.';

-- ---------------------------------------------------------------------------
-- Inbox: source object
-- ---------------------------------------------------------------------------

alter table public.integration_inbox
  add column source_object text not null default 'deal' check (source_object in ('deal', 'lead')),
  add column processed_lead_id uuid references public.crm_leads (id);

alter table public.integration_inbox drop constraint integration_inbox_event_type_check;
alter table public.integration_inbox add constraint integration_inbox_event_type_check check (event_type in (
  'ONCRMDEALADD', 'ONCRMDEALUPDATE', 'ONCRMLEADADD', 'ONCRMLEADUPDATE', 'RECONCILE'));
-- Lead and Deal identities never mix.
alter table public.integration_inbox add constraint integration_inbox_event_object_check check (
  event_type = 'RECONCILE'
  or (source_object = 'lead') = (event_type in ('ONCRMLEADADD', 'ONCRMLEADUPDATE')));
alter table public.integration_inbox add constraint integration_inbox_processed_object_check check (
  (source_object = 'deal' and processed_lead_id is null)
  or (source_object = 'lead' and processed_deal_id is null));

alter table public.integration_inbox drop constraint integration_inbox_reason_code_check;
alter table public.integration_inbox add constraint integration_inbox_reason_code_check check (reason_code in (
  'not_configured', 'environment_unset', 'not_eligible_category', 'not_eligible_stage',
  'before_cutoff', 'unmapped_owner', 'owner_not_in_pilot_branch', 'invalid_source_data',
  'source_deal_not_found', 'stale_ignored', 'reference_conflict',
  'not_in_manifest', 'outside_manifest_scope'));

create index integration_inbox_object_idx on public.integration_inbox (portal_member_id, source_object, source_deal_id);
create index integration_inbox_processed_lead_idx on public.integration_inbox (processed_lead_id)
  where processed_lead_id is not null;
comment on column public.integration_inbox.source_deal_id is
  'Bitrix source record id: a Deal id when source_object = deal, a Lead id when source_object = lead.';

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Environment isolation for every intake path (contract 2.5).
create function authz.intake_portal_allowed(p_portal_domain text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    case authz.deployment_environment()
      when 'operational' then
        authz.normalise_portal_domain(p_portal_domain) !~ '\.test$'
      when 'test' then
        authz.normalise_portal_domain(p_portal_domain) ~ '\.test$'
        and exists (
          select 1 from public.integration_intake_config c
          where c.enabled and c.portal_domain = authz.normalise_portal_domain(p_portal_domain))
      else false
    end,
    false)
$$;

-- Raises the L1 refusal for a portal the environment does not allow.
create function authz.require_intake_environment(p_portal_domain text) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if not authz.intake_portal_allowed(p_portal_domain) then
    raise exception 'not_configured' using errcode = '55000';
  end if;
end;
$$;

create function authz.intake_manifest_allows(p_config_id uuid, p_source_object text, p_source_id bigint)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.intake_manifests m
    join public.intake_manifest_items i
      on i.manifest_id = m.id and i.source_object = m.source_object
    where m.config_id = p_config_id
      and m.source_object = p_source_object
      and m.status = 'active'
      and i.source_id = p_source_id
  )
$$;

create function authz.intake_dedupe_key_object(
  p_member_id text, p_source_object text, p_event_type text, p_source_id bigint, p_ts bigint
) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(
    p_member_id || '|' || p_source_object || '|' || p_event_type || '|' || p_source_id::text || '|' || p_ts::text,
    'UTF8')), 'hex')
$$;

-- Same signature as before. 55000 environment_unset / not_configured,
-- 42501 when the member id does not match the enabled config.
create or replace function authz.require_intake_portal(p_member_id text) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_domain text;
begin
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if authz.deployment_environment() not in ('operational', 'test') then
    raise exception 'not_configured' using errcode = '55000';
  end if;
  select c.portal_domain into v_domain from public.integration_intake_config c
  where c.portal_member_id = p_member_id and c.enabled;
  if v_domain is not null then
    perform authz.require_intake_environment(v_domain);
    return;
  end if;
  if not exists (select 1 from public.integration_intake_config c where c.enabled) then
    raise exception 'not_configured' using errcode = '55000';
  end if;
  raise exception 'portal not recognised' using errcode = '42501';
end;
$$;

-- Lead visibility (contract 2.2). Never a Purchase role holder.
create function authz.can_read_lead(p_lead uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.crm_leads l
    where l.id = p_lead
      and not authz.holds_role('purchase', l.legal_entity_id)
      and (
        (l.owner_user_id = (select auth.uid()) and exists (
          select 1
          from public.memberships m
          join public.legal_entities e on e.id = m.legal_entity_id
          join public.branches b on b.id = m.branch_id
          where m.user_id = (select auth.uid())
            and m.legal_entity_id = l.legal_entity_id and m.branch_id = l.branch_id
            and m.role_code = 'sales' and m.status = 'active'
            and e.status = 'enabled' and b.status = 'enabled'))
        or exists (
          select 1
          from public.memberships m
          join public.legal_entities e on e.id = m.legal_entity_id
          join public.branches b on b.id = m.branch_id
          where m.user_id = (select auth.uid())
            and m.legal_entity_id = l.legal_entity_id and m.branch_id = l.branch_id
            and m.role_code = 'manager' and m.status = 'active'
            and e.status = 'enabled' and b.status = 'enabled')
        or authz.can_admin('integration.manage', l.legal_entity_id)
      )
  )
$$;

revoke all on function
  authz.intake_manifest_items_immutable(), authz.intake_manifest_guard(),
  authz.intake_manifest_assert_count(uuid), authz.intake_manifest_count_trigger(),
  authz.intake_portal_allowed(text), authz.require_intake_environment(text),
  authz.intake_manifest_allows(uuid, text, bigint),
  authz.intake_dedupe_key_object(text, text, text, bigint, bigint),
  authz.can_read_lead(uuid)
from public, anon, authenticated, service_role;
grant execute on function authz.can_read_lead(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security and grants
-- ---------------------------------------------------------------------------

alter table public.intake_manifests enable row level security;
alter table public.intake_manifest_items enable row level security;
alter table public.crm_leads enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array['intake_manifests', 'intake_manifest_items', 'crm_leads'] loop
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
  end loop;
end;
$$;

create policy scoped_read on public.crm_leads
  for select to authenticated using (authz.can_read_lead(id));

revoke all on public.intake_manifests, public.intake_manifest_items, public.crm_leads
from public, anon, authenticated, service_role;
grant select on public.crm_leads to authenticated;
-- Server-side reads (sync page, comparator). Writes only through commands.
grant select on public.intake_manifests, public.intake_manifest_items, public.crm_leads to service_role;

-- ---------------------------------------------------------------------------
-- Commands: record / receive (same signatures)
-- ---------------------------------------------------------------------------

-- Receiver: store one notification. The event type decides the source object
-- (ONCRMDEAL* = deal, ONCRMLEAD* = lead; p_deal_id carries the source id).
-- Returns {inboxId, duplicate}. Outside the active manifest: an 'ignored'
-- row with reason not_in_manifest (same response shape).
create or replace function public.integration_record_bitrix_event(
  p_member_id text, p_event_type text, p_deal_id bigint, p_source_ts bigint
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_object text;
  v_config uuid;
  v_key text;
  v_id uuid;
begin
  perform authz.require_intake_portal(p_member_id);
  if p_event_type in ('ONCRMDEALADD', 'ONCRMDEALUPDATE') then
    v_object := 'deal';
  elsif p_event_type in ('ONCRMLEADADD', 'ONCRMLEADUPDATE') then
    v_object := 'lead';
  else
    raise exception 'unsupported event type' using errcode = '22023';
  end if;
  if p_deal_id is null or p_deal_id <= 0 then
    raise exception 'invalid % id', v_object using errcode = '22023';
  end if;
  if p_source_ts is null or p_source_ts < 0 or p_source_ts > 32503680000 then
    raise exception 'invalid event timestamp' using errcode = '22023';
  end if;
  select c.id into v_config from public.integration_intake_config c
  where c.portal_member_id = p_member_id and c.enabled;

  v_key := authz.intake_dedupe_key_object(p_member_id, v_object, p_event_type, p_deal_id, p_source_ts);
  -- Exact redelivery.
  select i.id into v_id from public.integration_inbox i where i.dedupe_key = v_key;
  if v_id is not null then
    return jsonb_build_object('inboxId', v_id, 'duplicate', true);
  end if;

  if not authz.intake_manifest_allows(v_config, v_object, p_deal_id) then
    insert into public.integration_inbox
      (portal_member_id, source_object, event_type, source_deal_id, source_ts, dedupe_key, origin,
       status, reason_code, attempts, next_attempt_at, processed_at)
    values (p_member_id, v_object, p_event_type, p_deal_id, p_source_ts, v_key, 'event',
       'ignored', 'not_in_manifest', 0, null, now())
    on conflict (dedupe_key) do nothing
    returning id into v_id;
    if v_id is not null then
      return jsonb_build_object('inboxId', v_id, 'duplicate', false);
    end if;
    select i.id into v_id from public.integration_inbox i where i.dedupe_key = v_key;
    return jsonb_build_object('inboxId', v_id, 'duplicate', true);
  end if;

  -- Coalesce into an unclaimed pending row for the same record (L6).
  select i.id into v_id from public.integration_inbox i
  where i.portal_member_id = p_member_id and i.source_object = v_object
    and i.source_deal_id = p_deal_id and i.status = 'pending'
  order by i.received_at
  limit 1;
  if v_id is not null then
    return jsonb_build_object('inboxId', v_id, 'duplicate', true);
  end if;

  insert into public.integration_inbox
    (portal_member_id, source_object, event_type, source_deal_id, source_ts, dedupe_key, origin)
  values (p_member_id, v_object, p_event_type, p_deal_id, p_source_ts, v_key, 'event')
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('inboxId', v_id, 'duplicate', false);
  end if;
  select i.id into v_id from public.integration_inbox i where i.dedupe_key = v_key;
  return jsonb_build_object('inboxId', v_id, 'duplicate', true);
end;
$$;

-- Public receiver (anon + receiver credential). Credential first, then
-- environment (L1 messages), single enabled config, portal identity, portal
-- class for the environment (L2), then the durable record above.
create or replace function public.integration_receive_bitrix_event(
  p_credential text, p_member_id text, p_domain text, p_event_type text, p_deal_id bigint, p_source_ts bigint
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_enabled integer;
  v_match boolean;
  v_domain text;
  v_result jsonb;
begin
  -- 1. Receiver credential first: nothing else is read for an unknown caller.
  if not authz.intake_receiver_authorized(p_credential) then
    raise exception 'receiver not authorized' using errcode = '28000';
  end if;

  -- 2. Environment (L1: unset keeps its own refusal).
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if authz.deployment_environment() not in ('operational', 'test') then
    raise exception 'not_configured' using errcode = '55000';
  end if;

  -- 3. Exactly one enabled config; member_id AND domain must match it.
  select count(*)::integer,
         bool_or(c.portal_member_id = p_member_id
                 and c.portal_domain = authz.normalise_portal_domain(p_domain)),
         min(c.portal_domain)
    into v_enabled, v_match, v_domain
  from public.integration_intake_config c
  where c.enabled;
  if v_enabled <> 1 then
    raise exception 'not_configured' using errcode = '55000';
  end if;
  if p_member_id is null or p_domain is null or length(p_domain) > 253 or not coalesce(v_match, false) then
    raise exception 'portal not recognised' using errcode = '42501';
  end if;

  -- 4. Portal class for this environment (operational: real only; test: .test only).
  perform authz.require_intake_environment(v_domain);

  -- 5. Durable record (dedupe, manifest gate, coalescing, argument checks).
  v_result := public.integration_record_bitrix_event(p_member_id, p_event_type, p_deal_id, p_source_ts);
  return jsonb_build_object('inboxId', v_result -> 'inboxId', 'duplicate', v_result -> 'duplicate');
end;
$$;

-- ---------------------------------------------------------------------------
-- Reconcile enqueue
-- ---------------------------------------------------------------------------

-- Deal reconcile (same signature). Outside the active manifest nothing is
-- written: {inboxId: null, duplicate: false, upToDate: false, ignored: true,
-- reasonCode: 'not_in_manifest'}. Otherwise as before plus ignored: false.
create or replace function public.integration_enqueue_reconcile(
  p_member_id text, p_deal_id bigint, p_source_modified bigint
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_config uuid;
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
  select c.id into v_config from public.integration_intake_config c
  where c.portal_member_id = p_member_id and c.enabled;
  if not authz.intake_manifest_allows(v_config, 'deal', p_deal_id) then
    return jsonb_build_object('inboxId', null, 'duplicate', false, 'upToDate', false,
      'ignored', true, 'reasonCode', 'not_in_manifest');
  end if;

  update public.deals d
  set last_verified_at = now()
  where d.source_system = 'bitrix' and d.source_portal = p_member_id and d.source_deal_id = p_deal_id
    and d.source_modified_at >= to_timestamp(p_source_modified::double precision);
  if found then
    return jsonb_build_object('inboxId', null, 'duplicate', true, 'upToDate', true, 'ignored', false);
  end if;

  select i.id into v_id from public.integration_inbox i
  where i.portal_member_id = p_member_id and i.source_object = 'deal' and i.source_deal_id = p_deal_id
    and i.status in ('pending', 'processing', 'failed')
  order by i.received_at
  limit 1;
  if v_id is not null then
    return jsonb_build_object('inboxId', v_id, 'duplicate', true, 'upToDate', false, 'ignored', false);
  end if;

  v_key := authz.intake_dedupe_key_object(p_member_id, 'deal', 'RECONCILE', p_deal_id, p_source_modified);
  insert into public.integration_inbox
    (portal_member_id, source_object, event_type, source_deal_id, source_ts, dedupe_key, origin)
  values (p_member_id, 'deal', 'RECONCILE', p_deal_id, p_source_modified, v_key, 'reconcile')
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('inboxId', v_id, 'duplicate', false, 'upToDate', false, 'ignored', false);
  end if;
  select i.id into v_id from public.integration_inbox i where i.dedupe_key = v_key;
  return jsonb_build_object('inboxId', v_id, 'duplicate', true, 'upToDate', false, 'ignored', false);
end;
$$;

-- Lead reconcile. Same result shape as the deal command.
create function public.integration_enqueue_reconcile_lead(
  p_member_id text, p_lead_id bigint, p_source_modified bigint
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_config uuid;
  v_key text;
  v_id uuid;
begin
  perform authz.require_intake_portal(p_member_id);
  if p_lead_id is null or p_lead_id <= 0 then
    raise exception 'invalid lead id' using errcode = '22023';
  end if;
  if p_source_modified is null or p_source_modified < 0 or p_source_modified > 32503680000 then
    raise exception 'invalid source modification time' using errcode = '22023';
  end if;
  select c.id into v_config from public.integration_intake_config c
  where c.portal_member_id = p_member_id and c.enabled;
  if not authz.intake_manifest_allows(v_config, 'lead', p_lead_id) then
    return jsonb_build_object('inboxId', null, 'duplicate', false, 'upToDate', false,
      'ignored', true, 'reasonCode', 'not_in_manifest');
  end if;

  update public.crm_leads l
  set last_verified_at = now()
  where l.source_system = 'bitrix' and l.source_portal = p_member_id and l.source_lead_id = p_lead_id
    and l.source_modified_at >= to_timestamp(p_source_modified::double precision);
  if found then
    return jsonb_build_object('inboxId', null, 'duplicate', true, 'upToDate', true, 'ignored', false);
  end if;

  select i.id into v_id from public.integration_inbox i
  where i.portal_member_id = p_member_id and i.source_object = 'lead' and i.source_deal_id = p_lead_id
    and i.status in ('pending', 'processing', 'failed')
  order by i.received_at
  limit 1;
  if v_id is not null then
    return jsonb_build_object('inboxId', v_id, 'duplicate', true, 'upToDate', false, 'ignored', false);
  end if;

  v_key := authz.intake_dedupe_key_object(p_member_id, 'lead', 'RECONCILE', p_lead_id, p_source_modified);
  insert into public.integration_inbox
    (portal_member_id, source_object, event_type, source_deal_id, source_ts, dedupe_key, origin)
  values (p_member_id, 'lead', 'RECONCILE', p_lead_id, p_source_modified, v_key, 'reconcile')
  on conflict (dedupe_key) do nothing
  returning id into v_id;
  if v_id is not null then
    return jsonb_build_object('inboxId', v_id, 'duplicate', false, 'upToDate', false, 'ignored', false);
  end if;
  select i.id into v_id from public.integration_inbox i where i.dedupe_key = v_key;
  return jsonb_build_object('inboxId', v_id, 'duplicate', true, 'upToDate', false, 'ignored', false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Claim (same signature): adds sourceObject and sourceId to each item.
-- ---------------------------------------------------------------------------

create or replace function public.integration_claim_inbox(p_limit integer, p_lease_seconds integer)
returns setof jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if authz.deployment_environment() not in ('operational', 'test') then
    raise exception 'not_configured' using errcode = '55000';
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
          and authz.intake_portal_allowed(c.portal_domain)
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
    'sourceObject', i.source_object,
    'sourceId', i.source_deal_id::text,
    'sourceDealId', i.source_deal_id::text,
    'eventType', i.event_type,
    'origin', i.origin,
    'attempts', i.attempts);
end;
$$;

-- ---------------------------------------------------------------------------
-- Apply Deal (same signature): object check, portal isolation, manifest gate
-- and manifest scope added before any CRM write.
-- ---------------------------------------------------------------------------

create or replace function public.integration_apply_bitrix_deal(p_inbox_id uuid, p_lock_token uuid, p_deal jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_inbox public.integration_inbox%rowtype;
  v_cfg public.integration_intake_config%rowtype;
  v_manifest public.intake_manifests%rowtype;
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
  -- A Lead is never passed to the Deal command.
  if v_inbox.source_object <> 'deal' then
    raise exception 'source object mismatch' using errcode = '22023';
  end if;

  <<checks>>
  begin
    if authz.deployment_environment() = 'unset' then
      v_outcome := 'needs_review'; v_reason := 'environment_unset';
      exit checks;
    end if;

    select * into v_cfg from public.integration_intake_config c
    where c.portal_member_id = v_inbox.portal_member_id and c.enabled;
    if v_cfg.id is null or not authz.intake_portal_allowed(v_cfg.portal_domain) then
      v_outcome := 'needs_review'; v_reason := 'not_configured';
      exit checks;
    end if;

    -- Manifest gate: nothing outside the active manifest is written.
    -- Lock the active manifest row (FOR SHARE) for the rest of this command:
    -- integration_manifest_close takes FOR UPDATE, so a close either commits
    -- before this read (nothing is written here) or waits until this
    -- command has finished. Membership is checked against the locked row.
    select * into v_manifest from public.intake_manifests m
    where m.config_id = v_cfg.id and m.source_object = 'deal' and m.status = 'active'
    for share;
    if v_manifest.id is null or not exists (
      select 1 from public.intake_manifest_items i
      where i.manifest_id = v_manifest.id and i.source_object = 'deal' and i.source_id = v_inbox.source_deal_id
    ) then
      v_outcome := 'ignored'; v_reason := 'not_in_manifest';
      exit checks;
    end if;

    if p_deal is null or jsonb_typeof(p_deal) = 'null' then
      v_outcome := 'needs_review'; v_reason := 'source_deal_not_found';
      exit checks;
    end if;

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

    -- Manifest scope: verified source code and creation interval.
    if jsonb_typeof(p_deal -> 'sourceId') is distinct from 'string'
       or (p_deal ->> 'sourceId') is distinct from v_manifest.source_code
       or v_created < v_manifest.interval_from or v_created >= v_manifest.interval_to then
      v_outcome := 'needs_review'; v_reason := 'outside_manifest_scope';
      exit checks;
    end if;

    select * into v_existing from public.deals d
    where d.source_system = 'bitrix' and d.source_portal = v_cfg.portal_member_id
      and d.source_deal_id = v_inbox.source_deal_id
    for update;

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
        get stacked diagnostics v_constraint = constraint_name;
        if v_constraint is distinct from 'deals_legal_entity_id_reference_key' then
          raise;
        end if;
        v_ref_conflict := true;
      end;
      if v_ref_conflict then
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
      select * into v_existing from public.deals d
      where d.source_system = 'bitrix' and d.source_portal = v_cfg.portal_member_id
        and d.source_deal_id = v_inbox.source_deal_id
      for update;
      if v_modified < v_existing.source_modified_at then
        v_outcome := 'stale_ignored'; v_reason := 'stale_ignored'; v_deal_id := v_existing.id;
        exit checks;
      end if;
    end if;

    if v_modified = v_existing.source_modified_at
       and v_existing.title = v_title and v_existing.source_stage_id = v_stage
       and v_existing.source_category_id = v_category and v_existing.owner_user_id = v_owner then
      v_outcome := 'stale_ignored'; v_reason := 'stale_ignored'; v_deal_id := v_existing.id;
      exit checks;
    end if;

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

  if v_outcome in ('created', 'updated') then
    perform authz.write_audit(
      case when v_outcome = 'created' then 'integration.deal_created' else 'integration.deal_updated' end,
      v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'deal', v_deal_id, null,
      jsonb_build_object('inboxId', v_inbox.id, 'origin', v_inbox.origin, 'ownerChanged', v_owner_changed,
        'manifestId', v_manifest.id));
  elsif v_outcome = 'needs_review' then
    perform authz.write_audit('integration.deal_needs_review',
      v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'integration_inbox', v_inbox.id, null,
      jsonb_build_object('inboxId', v_inbox.id, 'origin', v_inbox.origin, 'reasonCode', v_reason));
  end if;

  return jsonb_build_object('outcome', v_outcome, 'dealId', v_deal_id, 'reasonCode', v_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- Apply Lead (new). p_lead is the record re-read with crm.lead.get:
--   {id, title, statusId, sourceId, assignedById, dateCreate, dateModify}
-- (strings; sourceId may be null). JSON null = source lead not found.
-- Returns {outcome, leadId, reasonCode}; outcomes as for deals.
-- ---------------------------------------------------------------------------

create function public.integration_apply_bitrix_lead(p_inbox_id uuid, p_lock_token uuid, p_lead jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_inbox public.integration_inbox%rowtype;
  v_cfg public.integration_intake_config%rowtype;
  v_manifest public.intake_manifests%rowtype;
  v_existing public.crm_leads%rowtype;
  v_outcome text;
  v_reason text;
  v_lead_id uuid;
  v_owner uuid;
  v_title text;
  v_status text;
  v_source_code text;
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
  -- A Deal is never passed to the Lead command.
  if v_inbox.source_object <> 'lead' then
    raise exception 'source object mismatch' using errcode = '22023';
  end if;

  <<checks>>
  begin
    if authz.deployment_environment() = 'unset' then
      v_outcome := 'needs_review'; v_reason := 'environment_unset';
      exit checks;
    end if;

    select * into v_cfg from public.integration_intake_config c
    where c.portal_member_id = v_inbox.portal_member_id and c.enabled;
    if v_cfg.id is null or not authz.intake_portal_allowed(v_cfg.portal_domain) then
      v_outcome := 'needs_review'; v_reason := 'not_configured';
      exit checks;
    end if;

    -- Lock the active manifest row (FOR SHARE) for the rest of this command:
    -- integration_manifest_close takes FOR UPDATE, so a close either commits
    -- before this read (nothing is written here) or waits until this
    -- command has finished. Membership is checked against the locked row.
    select * into v_manifest from public.intake_manifests m
    where m.config_id = v_cfg.id and m.source_object = 'lead' and m.status = 'active'
    for share;
    if v_manifest.id is null or not exists (
      select 1 from public.intake_manifest_items i
      where i.manifest_id = v_manifest.id and i.source_object = 'lead' and i.source_id = v_inbox.source_deal_id
    ) then
      v_outcome := 'ignored'; v_reason := 'not_in_manifest';
      exit checks;
    end if;

    if p_lead is null or jsonb_typeof(p_lead) = 'null' then
      v_outcome := 'needs_review'; v_reason := 'source_deal_not_found';
      exit checks;
    end if;

    if jsonb_typeof(p_lead) <> 'object' or exists (
         select 1 from unnest(array['id', 'title', 'statusId', 'assignedById', 'dateCreate', 'dateModify']) k
         where jsonb_typeof(p_lead -> k) is distinct from 'string')
       or coalesce(jsonb_typeof(p_lead -> 'sourceId'), 'null') not in ('string', 'null') then
      v_outcome := 'needs_review'; v_reason := 'invalid_source_data';
      exit checks;
    end if;
    begin
      if (p_lead ->> 'id') !~ '^[1-9][0-9]{0,17}$'
         or length(btrim(p_lead ->> 'title')) not between 1 and 200
         or (p_lead ->> 'statusId') !~ '^[A-Za-z0-9_:.-]{1,50}$'
         or (p_lead ->> 'assignedById') !~ '^[1-9][0-9]{0,17}$'
         or (p_lead ->> 'dateCreate') !~ v_iso
         or (p_lead ->> 'dateModify') !~ v_iso then
        v_invalid := true;
      else
        v_title := btrim(p_lead ->> 'title');
        v_status := p_lead ->> 'statusId';
        v_source_code := p_lead ->> 'sourceId';
        v_assigned := (p_lead ->> 'assignedById')::bigint;
        v_created := (p_lead ->> 'dateCreate')::timestamptz;
        v_modified := (p_lead ->> 'dateModify')::timestamptz;
        if (p_lead ->> 'id')::bigint <> v_inbox.source_deal_id or v_modified < v_created then
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

    -- Manifest scope: verified source code and creation interval.
    if v_source_code is distinct from v_manifest.source_code
       or v_created < v_manifest.interval_from or v_created >= v_manifest.interval_to then
      v_outcome := 'needs_review'; v_reason := 'outside_manifest_scope';
      exit checks;
    end if;

    select * into v_existing from public.crm_leads l
    where l.source_system = 'bitrix' and l.source_portal = v_cfg.portal_member_id
      and l.source_lead_id = v_inbox.source_deal_id
    for update;
    if v_existing.id is not null and v_modified < v_existing.source_modified_at then
      v_outcome := 'stale_ignored'; v_reason := 'stale_ignored'; v_lead_id := v_existing.id;
      exit checks;
    end if;

    select m.staff_user_id into v_owner
    from public.bitrix_user_mappings m
    join public.staff_profiles p on p.user_id = m.staff_user_id and p.status = 'active'
    where m.portal_member_id = v_cfg.portal_member_id and m.bitrix_user_id = v_assigned and m.active;
    if v_owner is null then
      v_outcome := 'needs_review'; v_reason := 'unmapped_owner';
      exit checks;
    end if;
    -- Lead owners must hold an active Sales membership in the pilot branch
    -- (the same rule that makes the lead visible to them).
    if not exists (
      select 1 from public.memberships ms
      where ms.user_id = v_owner and ms.legal_entity_id = v_cfg.pilot_legal_entity_id
        and ms.branch_id = v_cfg.pilot_branch_id and ms.role_code = 'sales' and ms.status = 'active'
    ) then
      v_outcome := 'needs_review'; v_reason := 'owner_not_in_pilot_branch';
      exit checks;
    end if;

    if v_existing.id is null then
      begin
        insert into public.crm_leads
          (legal_entity_id, branch_id, reference, title, owner_user_id, source_system, source_portal,
           source_lead_id, source_status_id, source_id_code, source_created_at, source_modified_at,
           last_synced_at, last_verified_at, intake_inbox_id, manifest_id)
        values
          (v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'BXL-' || v_inbox.source_deal_id::text,
           v_title, v_owner, 'bitrix', v_cfg.portal_member_id,
           v_inbox.source_deal_id, v_status, v_source_code, v_created, v_modified,
           now(), now(), v_inbox.id, v_manifest.id)
        on conflict on constraint crm_leads_source_identity_unique do nothing
        returning id into v_lead_id;
      exception when unique_violation then
        get stacked diagnostics v_constraint = constraint_name;
        if v_constraint is distinct from 'crm_leads_reference_key' then
          raise;
        end if;
        v_ref_conflict := true;
      end;
      if v_ref_conflict then
        select * into v_existing from public.crm_leads l
        where l.source_system = 'bitrix' and l.source_portal = v_cfg.portal_member_id
          and l.source_lead_id = v_inbox.source_deal_id
        for update;
        if v_existing.id is null then
          v_outcome := 'needs_review'; v_reason := 'reference_conflict';
          exit checks;
        end if;
      end if;
      if v_lead_id is not null then
        v_outcome := 'created';
        exit checks;
      end if;
      select * into v_existing from public.crm_leads l
      where l.source_system = 'bitrix' and l.source_portal = v_cfg.portal_member_id
        and l.source_lead_id = v_inbox.source_deal_id
      for update;
      if v_modified < v_existing.source_modified_at then
        v_outcome := 'stale_ignored'; v_reason := 'stale_ignored'; v_lead_id := v_existing.id;
        exit checks;
      end if;
    end if;

    if v_modified = v_existing.source_modified_at
       and v_existing.title = v_title and v_existing.source_status_id = v_status
       and v_existing.source_id_code = v_source_code and v_existing.owner_user_id = v_owner then
      v_outcome := 'stale_ignored'; v_reason := 'stale_ignored'; v_lead_id := v_existing.id;
      exit checks;
    end if;

    v_owner_changed := v_existing.owner_user_id <> v_owner;
    update public.crm_leads l
    set title = v_title,
        owner_user_id = v_owner,
        source_status_id = v_status,
        source_id_code = v_source_code,
        source_created_at = v_created,
        source_modified_at = v_modified,
        last_synced_at = now(),
        last_verified_at = now(),
        intake_inbox_id = v_inbox.id,
        manifest_id = v_manifest.id
    where l.id = v_existing.id;
    v_lead_id := v_existing.id;
    v_outcome := 'updated';
  end checks;

  if v_outcome = 'stale_ignored' then
    update public.crm_leads l set last_verified_at = now() where l.id = v_lead_id;
  end if;

  update public.integration_inbox i
  set status = case v_outcome
                 when 'created' then 'processed'
                 when 'updated' then 'processed'
                 when 'needs_review' then 'needs_review'
                 else 'ignored'
               end,
      reason_code = v_reason,
      processed_lead_id = v_lead_id,
      processed_at = now(),
      lock_token = null,
      locked_until = null,
      next_attempt_at = null,
      updated_at = now()
  where i.id = v_inbox.id;

  if v_outcome in ('created', 'updated') then
    perform authz.write_audit(
      case when v_outcome = 'created' then 'integration.lead_created' else 'integration.lead_updated' end,
      v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'crm_lead', v_lead_id, null,
      jsonb_build_object('inboxId', v_inbox.id, 'origin', v_inbox.origin, 'ownerChanged', v_owner_changed,
        'manifestId', v_manifest.id));
  elsif v_outcome = 'needs_review' then
    perform authz.write_audit('integration.lead_needs_review',
      v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'integration_inbox', v_inbox.id, null,
      jsonb_build_object('inboxId', v_inbox.id, 'origin', v_inbox.origin, 'reasonCode', v_reason));
  end if;

  return jsonb_build_object('outcome', v_outcome, 'leadId', v_lead_id, 'reasonCode', v_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- Operator commands (service role only, audited)
-- ---------------------------------------------------------------------------

-- Creates an ACTIVE manifest. The interval must be the business date in
-- Asia/Kolkata: interval_from = business date 00:00 IST, interval_to =
-- interval_from + 1 day. Refusals: 22023 invalid argument, interval or ids
-- (empty, null, non-positive, duplicate, more than 10000); 55000
-- environment_unset / not_configured for a portal the environment does not
-- allow, 'manifest already active' when one is active for the config and
-- object (close it first; widening = a new manifest). Unknown config 22023.
-- Returns {manifestId, status: 'active', expectedCount}.
create function public.integration_manifest_create(
  p_config_id uuid, p_source_object text, p_source_code text, p_business_date date,
  p_interval_from timestamptz, p_interval_to timestamptz, p_ids bigint[], p_operator text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_id uuid;
  v_count integer;
begin
  select * into v_cfg from public.integration_intake_config c where c.id = p_config_id for update;
  if v_cfg.id is null then
    raise exception 'unknown intake config' using errcode = '22023';
  end if;
  perform authz.require_intake_environment(v_cfg.portal_domain);
  if p_source_object is null or p_source_object not in ('deal', 'lead') then
    raise exception 'invalid source object' using errcode = '22023';
  end if;
  if p_source_code is null or p_source_code !~ '^[A-Za-z0-9_:.-]{1,50}$' then
    raise exception 'invalid source code' using errcode = '22023';
  end if;
  -- The interval is exactly the business date in Asia/Kolkata: [00:00, +1 day).
  if p_business_date is null or p_interval_from is null or p_interval_to is null
     or p_interval_from <> (p_business_date::timestamp at time zone 'Asia/Kolkata')
     or p_interval_to <> p_interval_from + interval '1 day' then
    raise exception 'invalid manifest interval' using errcode = '22023';
  end if;
  if p_operator is null or p_operator !~ '^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,99}$' then
    raise exception 'invalid operator' using errcode = '22023';
  end if;
  v_count := coalesce(cardinality(p_ids), 0);
  if v_count < 1 or v_count > 10000
     or array_position(p_ids, null) is not null
     or exists (select 1 from unnest(p_ids) x where x <= 0)
     or (select count(distinct x) from unnest(p_ids) x) <> v_count then
    raise exception 'invalid manifest ids' using errcode = '22023';
  end if;
  if exists (
    select 1 from public.intake_manifests m
    where m.config_id = v_cfg.id and m.source_object = p_source_object and m.status = 'active'
  ) then
    raise exception 'manifest already active' using errcode = '55000';
  end if;

  insert into public.intake_manifests
    (config_id, source_object, source_code, business_date, interval_from, interval_to, expected_count,
     status, created_by_operator)
  values (v_cfg.id, p_source_object, p_source_code, p_business_date, p_interval_from, p_interval_to, v_count,
     'active', p_operator)
  returning id into v_id;
  insert into public.intake_manifest_items (manifest_id, source_object, source_id)
  select v_id, p_source_object, x from unnest(p_ids) x;
  -- Activation check (also enforced at commit by a deferred constraint trigger).
  perform authz.intake_manifest_assert_count(v_id);

  perform authz.write_audit('integration.manifest_created', v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id,
    'intake_manifest', v_id, null,
    jsonb_build_object('manifestId', v_id, 'configId', v_cfg.id, 'sourceObject', p_source_object,
      'sourceCode', p_source_code, 'businessDate', p_business_date, 'intervalFrom', p_interval_from,
      'intervalTo', p_interval_to, 'expectedCount', v_count, 'operator', p_operator));
  return jsonb_build_object('manifestId', v_id, 'status', 'active', 'expectedCount', v_count);
end;
$$;

-- Closes a manifest (a stop switch; works in every environment). Repeat
-- answers outcome 'existing' with no write. Returns {manifestId, status, outcome}.
create function public.integration_manifest_close(p_manifest_id uuid, p_operator text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_manifest public.intake_manifests%rowtype;
  v_cfg public.integration_intake_config%rowtype;
begin
  if p_operator is null or p_operator !~ '^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,99}$' then
    raise exception 'invalid operator' using errcode = '22023';
  end if;
  select * into v_manifest from public.intake_manifests m where m.id = p_manifest_id for update;
  if v_manifest.id is null then
    raise exception 'unknown manifest' using errcode = '22023';
  end if;
  if v_manifest.status = 'closed' then
    return jsonb_build_object('manifestId', v_manifest.id, 'status', 'closed', 'outcome', 'existing');
  end if;
  update public.intake_manifests m
  set status = 'closed', closed_at = now(), closed_by_operator = p_operator
  where m.id = v_manifest.id;
  select * into v_cfg from public.integration_intake_config c where c.id = v_manifest.config_id;
  perform authz.write_audit('integration.manifest_closed', v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id,
    'intake_manifest', v_manifest.id, null,
    jsonb_build_object('manifestId', v_manifest.id, 'configId', v_cfg.id, 'sourceObject', v_manifest.source_object,
      'operator', p_operator));
  return jsonb_build_object('manifestId', v_manifest.id, 'status', 'closed', 'outcome', 'closed');
end;
$$;

-- Reconcile scope: the active manifest for the enabled portal and object, or
-- null when there is none (then nothing is imported and nothing is listed).
-- Returns {manifestId, sourceObject, sourceCode, businessDate, intervalFrom,
-- intervalTo, expectedCount, ids: [string, ...]} with ids ascending.
create function public.integration_active_manifest(p_member_id text, p_source_object text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_manifest public.intake_manifests%rowtype;
begin
  perform authz.require_intake_portal(p_member_id);
  if p_source_object is null or p_source_object not in ('deal', 'lead') then
    raise exception 'invalid source object' using errcode = '22023';
  end if;
  select m.* into v_manifest
  from public.intake_manifests m
  join public.integration_intake_config c on c.id = m.config_id
  where c.portal_member_id = p_member_id and c.enabled
    and m.source_object = p_source_object and m.status = 'active';
  if v_manifest.id is null then
    return null;
  end if;
  return jsonb_build_object(
    'manifestId', v_manifest.id,
    'sourceObject', v_manifest.source_object,
    'sourceCode', v_manifest.source_code,
    'businessDate', v_manifest.business_date,
    'intervalFrom', v_manifest.interval_from,
    'intervalTo', v_manifest.interval_to,
    'expectedCount', v_manifest.expected_count,
    'ids', coalesce((
      select jsonb_agg(i.source_id::text order by i.source_id)
      from public.intake_manifest_items i
      where i.manifest_id = v_manifest.id and i.source_object = v_manifest.source_object), '[]'::jsonb));
end;
$$;

-- ---------------------------------------------------------------------------
-- Administrator "check now" (same signature): the same environment isolation
-- as every other intake path (L1 messages) before the cooldown and audit.
-- ---------------------------------------------------------------------------

create or replace function public.integration_request_reconcile() returns jsonb
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
  if v_enabled <> 1 then
    if authz.deployment_environment() = 'unset' then
      raise exception 'environment_unset' using errcode = '55000';
    end if;
    raise exception 'not_configured' using errcode = '55000';
  end if;
  select * into v_cfg from public.integration_intake_config c where c.enabled for update;
  if not authz.can_admin('integration.manage', v_cfg.pilot_legal_entity_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- unset -> environment_unset; staging, test with a real portal, operational
  -- with a reserved .test portal -> not_configured.
  perform authz.require_intake_portal(v_cfg.portal_member_id);

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
-- Grants (explicit; nothing for anon except the receiver, unchanged)
-- ---------------------------------------------------------------------------

revoke all on function
  public.integration_enqueue_reconcile_lead(text, bigint, bigint),
  public.integration_apply_bitrix_lead(uuid, uuid, jsonb),
  public.integration_manifest_create(uuid, text, text, date, timestamptz, timestamptz, bigint[], text),
  public.integration_manifest_close(uuid, text),
  public.integration_active_manifest(text, text)
from public, anon, authenticated, service_role;

grant execute on function
  public.integration_enqueue_reconcile_lead(text, bigint, bigint),
  public.integration_apply_bitrix_lead(uuid, uuid, jsonb),
  public.integration_manifest_create(uuid, text, text, date, timestamptz, timestamptz, bigint[], text),
  public.integration_manifest_close(uuid, text),
  public.integration_active_manifest(text, text)
to service_role;

commit;
