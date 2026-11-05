-- TripNavigate CRM - Stage 0 integration transition (combined release, 8 October 2026).
--
-- What this is: main's ten Bitrix integration migrations 20261009000100 ...
-- 20261009001000 (PR #13), moved AFTER the product chain 20261101000100 ...
-- 20261105000100 and applied as ONE transaction, with the Stage 0 corrections
-- marked "Stage 0" below. The eleventh, 20261009001100_rls_predicate_indexes,
-- moves byte for byte to 20261107000200 (it duplicates product 20261102000100;
-- 20261107000400 asserts the single definition).
--
-- Why: the hosted database (inventory 8 October 2026, 14:11 UTC) applied the
-- foundation chain and 20261101000100 but none of 20261009*; only a local
-- Docker copy that is being retired ever ran them. Sorting them after the
-- product chain lets the hosted database apply 20261102 ... 20261105 and then
-- this file, and a fresh replay runs the same files in the same order.
--
-- Section order and content follow the original files; each section header
-- names its source file and its corrections. To review the corrections only,
-- concatenate main's ten files (dc7ab32) in version order, drop their
-- "begin;" and "commit;" lines, and diff the result against this file: every
-- difference is a Stage 0 correction or addition.
--
-- Safe whatever the database holds at apply time:
--   * no extension is installed and no pg_cron job is created (scheduling is an
--     approved operator step: authz.provision_bitrix_sync_jobs(), jobs PAUSED);
--   * existing imported Deals get recovered provenance or the migration stops
--     with a count before anything is applied;
--   * the one-time settings step soft-removes (never deletes) and records the
--     removed Deals' owner and assignees first; no resync is queued unless it
--     removed something;
--   * Bitrix stays read-only: nothing here calls Bitrix. The only outbound call
--     (authz.dispatch_bitrix_sync, pg_net) targets the CRM worker URL in Vault
--     and runs only from a provisioned, activated job.
--
-- Rollback: forward-only. Never delete Deals, assignments, removal history or
-- audit rows.

begin;

-- Do not queue behind long transactions on a live database.
set local lock_timeout = '15s';

-- ===========================================================================
-- Section 1 of 10: main 20261009000100_bitrix_auto_sync.sql (was 20261006000100)
-- Stage 0 corrections: no extension is created and no job is scheduled (see the scheduler provisioning at the end).
-- ===========================================================================

-- TripNavigate CRM - automatic Bitrix sync (scheduler inside Supabase) and
-- live deal updates (Supabase Realtime).
--
-- What changes:
--   * Uses pg_cron and pg_net (Supabase built-ins). No third party.
--     Stage 0: this migration does not install them (operator step).
--   * public.integration_sync_schedule: single row, enabled default FALSE, plus
--     the last dispatched pg_net request (used to avoid piling up requests while
--     the app is still answering the previous one). Owner/operator writes only.
--   * authz.dispatch_bitrix_sync(url_secret_name, bearer_secret_name,
--     bypass_secret_name): reads the CRM sync URL, the worker bearer secret and
--     an optional Vercel "Protection Bypass for Automation" secret from SUPABASE
--     VAULT by name and sends POST <url>?task=sync with net.http_post.
--     Nothing in this file contains a URL or a secret: local and hosted differ
--     only by the Vault values (see supabase/snippets/local-bitrix-schedule.sql).
--   * authz.run_scheduled_bitrix_sync(): the cron entry point. Does nothing
--     unless the schedule row is enabled and both Vault values exist.
--   * pg_cron job 'bitrix-sync' every 30 seconds (pg_cron >= 1.5 interval
--     syntax), and 'bitrix-sync-heartbeat-cleanup' daily (heartbeat rows older
--     than 14 days; counts only, never deals). Stage 0: created PAUSED only by
--     authz.provision_bitrix_sync_jobs() (operator step), never by a migration.
--   * public.deals joins the supabase_realtime publication. Realtime evaluates
--     the existing deals RLS policy (scoped_read) for each subscriber, and the
--     app never renders the payload: clients only call router.refresh().
--     deal_commercials is NOT published.
--
-- Pause: update public.integration_sync_schedule set enabled = false;
--        (or select cron.unschedule('bitrix-sync');)
-- Rollback (forward-only): a new migration that unschedules both jobs and drops
-- deals from the publication. No deal or inbox row is ever deleted.
--
-- Every extension-dependent step is guarded, so the migration also loads in
-- the PGlite policy-test harness, which has none of these extensions.


-- Stage 0 correction: no extension is created here. pg_cron and pg_net
-- (outbound HTTP from the database) are installed by an approved operator
-- step; see authz.provision_bitrix_sync_jobs() at the end of this migration.

-- ---------------------------------------------------------------------------
-- Schedule switch (single row, off by default)
-- ---------------------------------------------------------------------------

create table public.integration_sync_schedule (
  id boolean primary key default true check (id),
  enabled boolean not null default false,
  -- Last pg_net request id and when it was sent (overlap guard, no content).
  last_request_id bigint,
  last_dispatched_at timestamptz,
  updated_at timestamptz not null default now()
);
comment on table public.integration_sync_schedule is
  'Supabase-side Bitrix sync scheduler switch. URL and bearer secret live in Vault, never here.';
insert into public.integration_sync_schedule (id, enabled) values (true, false);

alter table public.integration_sync_schedule enable row level security;
revoke all on public.integration_sync_schedule from public, anon, authenticated, service_role;
grant select on public.integration_sync_schedule to service_role;

-- ---------------------------------------------------------------------------
-- Dispatch (plpgsql: references to vault/net/cron resolve at call time only)
-- ---------------------------------------------------------------------------

-- Sends one sync request. Returns the pg_net request id, or null when a Vault
-- value is missing (nothing is sent). Secret values never leave this function
-- except inside the outgoing request headers.
create function authz.dispatch_bitrix_sync(
  p_url_secret text default 'bitrix_sync_url',
  p_bearer_secret text default 'bitrix_sync_bearer',
  p_bypass_secret text default 'vercel_protection_bypass'
) returns bigint
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_url text;
  v_bearer text;
  v_bypass text;
  v_headers jsonb;
begin
  select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = p_url_secret;
  select s.decrypted_secret into v_bearer from vault.decrypted_secrets s where s.name = p_bearer_secret;
  select s.decrypted_secret into v_bypass from vault.decrypted_secrets s where s.name = p_bypass_secret;
  v_url := nullif(btrim(v_url), '');
  v_bearer := nullif(btrim(v_bearer), '');
  if v_url is null or v_bearer is null or v_url !~ '^https?://[^\s?#]+$' then
    return null;
  end if;

  v_headers := jsonb_build_object(
    'Authorization', 'Bearer ' || v_bearer,
    'Content-Type', 'application/json');
  if nullif(btrim(v_bypass), '') is not null then
    v_headers := v_headers || jsonb_build_object('x-vercel-protection-bypass', btrim(v_bypass));
  end if;

  return net.http_post(
    url := v_url,
    params := jsonb_build_object('task', 'sync'),
    headers := v_headers,
    body := '{}'::jsonb,
    -- A sync run is bounded to ~45 s by the app; allow for one slow item.
    timeout_milliseconds := 90000);
end;
$$;

-- Cron entry point. Skips while paused, and while the previous request is
-- still unanswered and younger than 2 minutes (no pile-up if the app is slow).
create function authz.run_scheduled_bitrix_sync() returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_schedule public.integration_sync_schedule%rowtype;
  v_id bigint;
begin
  select * into v_schedule from public.integration_sync_schedule s where s.id for update skip locked;
  if v_schedule.id is null or not v_schedule.enabled then
    return;
  end if;
  if v_schedule.last_request_id is not null
     and v_schedule.last_dispatched_at > now() - interval '2 minutes'
     and not exists (select 1 from net._http_response r where r.id = v_schedule.last_request_id) then
    return;
  end if;
  v_id := authz.dispatch_bitrix_sync();
  if v_id is not null then
    update public.integration_sync_schedule s
    set last_request_id = v_id, last_dispatched_at = now()
    where s.id;
  end if;
end;
$$;

revoke all on function
  authz.dispatch_bitrix_sync(text, text, text),
  authz.run_scheduled_bitrix_sync()
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Jobs: Stage 0 correction - none here, whatever extensions the database has.
-- authz.provision_bitrix_sync_jobs() (end of this migration) creates them PAUSED.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- Realtime: deals only (RLS-filtered per subscriber; payload never rendered)
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'deals') then
    alter publication supabase_realtime add table public.deals;
  end if;
end;
$$;

-- ===========================================================================
-- Section 2 of 10: main 20261009000200_bitrix_staff_access.sql (was 20261007000100)
-- Stage 0 corrections: imported-Deal provenance backfill instead of failing on existing rows; no Super Admin deal.read row; one Sales-owner rule (I01) for bitrix_owner_for and set_deal_owner.
-- ===========================================================================

-- TripNavigate CRM - Bitrix deals: store every eligible deal, admin-granted ownership.
--
-- Decisions (docs/implementation/local-build-log.md):
--   * Imported (non-synthetic) deals may have NO CRM owner ("waiting for owner")
--     when their Bitrix responsible is not linked to an active staff member.
--     Synthetic deals still require an owner. deals_provenance is unchanged.
--   * deals.source_assigned_by_id keeps the Bitrix ASSIGNED_BY_ID so ownership
--     can be recomputed in the database when access is granted or revoked.
--   * Owner rule: active bitrix_user_mappings row + active staff profile +
--     active membership in the pilot LEGAL ENTITY. The owner also gets an
--     active 'sales' deal_assignments row; any other sales assignment ends.
--   * Super Admin reads every deal (role_permissions super_admin/deal.read/
--     entity). Explicit grants (Manager branch view) cover owned deals only, so
--     ownerless deals are visible to entity-scope readers (admin) only.
--   * Grant = integration_link_bitrix_user, revoke = integration_unlink_bitrix_user
--     or the existing deactivate_staff_member. Both recompute ownership in the
--     same transaction (trigger on memberships.status covers deactivation and
--     invitation acceptance) and are audited. Deals are never deleted.
--   * One Bitrix user -> one staff member (existing unique key) and one active
--     Bitrix user per staff member (new partial unique index).
--   * Sync settings editable by the admin: several pipelines
--     (eligible_category_ids), stages, cutoff (a deal enters when CREATED OR
--     MODIFIED on/after the cutoff) and the scheduler switch.
--   * deal_assignments joins the Realtime publication (RLS-filtered, payload
--     never rendered by the app).
--
-- Rollback (forward-only): a new migration that restores the previous
-- functions. Ownerless deals must first get an owner (or the NOT NULL is not
-- restored); never delete deals or audit rows.


-- ---------------------------------------------------------------------------
-- Deals: optional owner for imported deals, Bitrix responsible kept
-- ---------------------------------------------------------------------------

alter table public.deals alter column owner_user_id drop not null;
alter table public.deals add constraint deals_owner_required_for_synthetic
  check (owner_user_id is not null or not is_synthetic);
alter table public.deals add column source_assigned_by_id bigint check (source_assigned_by_id > 0);
-- Every imported deal carries its Bitrix responsible.
-- Stage 0 correction (was: "fails loudly if one does"). Imported Deals stored
-- before this migration took their owner from the ACTIVE mapping of their
-- Bitrix responsible (20261007000200), so that mapping is their recorded
-- provenance: a Deal whose owner has exactly one active mapping on the Deal's
-- portal gets that Bitrix user. Every later sync of the Deal overwrites it with
-- the source value (the resync re-reads every stored Deal). A Deal whose
-- provenance cannot be recovered this way stops the migration with a count and
-- nothing is applied; link the owner's Bitrix user first. The hosted database
-- held no Deals at the 8 October 2026 inventory.
update public.deals d
set source_assigned_by_id = (
  select m.bitrix_user_id from public.bitrix_user_mappings m
  where m.portal_member_id = d.source_portal and m.staff_user_id = d.owner_user_id and m.active)
where not d.is_synthetic and d.source_assigned_by_id is null
  and (select count(*) from public.bitrix_user_mappings m
       where m.portal_member_id = d.source_portal and m.staff_user_id = d.owner_user_id and m.active) = 1;
do $$
declare
  v_n integer;
begin
  select count(*) into v_n from public.deals d where not d.is_synthetic and d.source_assigned_by_id is null;
  if v_n > 0 then
    raise exception 'integration transition: % imported deal(s) have no recoverable Bitrix responsible; link each owner''s Bitrix user and apply again', v_n
      using errcode = '55000';
  end if;
end;
$$;
alter table public.deals add constraint deals_source_assigned_by_provenance
  check (is_synthetic = (source_assigned_by_id is null));
create index deals_source_assignee_idx on public.deals (source_portal, source_assigned_by_id)
  where source_system = 'bitrix';
create index deals_ownerless_idx on public.deals (legal_entity_id) where owner_user_id is null;

-- The owner must be an entity member; an ownerless imported deal has none.
create or replace function authz.require_entity_member() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  if tg_table_name = 'deals' then
    v_user := new.owner_user_id;
    if v_user is null then
      return new;
    end if;
  else
    v_user := new.user_id;
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.user_id = v_user
      and m.legal_entity_id = new.legal_entity_id
      and m.status in ('invited', 'active')
  ) then
    raise exception 'user % has no membership in legal entity %', v_user, new.legal_entity_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Visibility: admin reads all deals; grants cover owned deals only
-- ---------------------------------------------------------------------------

-- Stage 0 correction: the Super Admin deal.read/entity row is not inserted
-- (section 10 deletes it: the access matrix gives Super Admin no Deal
-- visibility, AUDIT-007). The admin sees Deals waiting for an owner as counts
-- through public.integration_waiting_for_owner() (end of this migration).

create or replace function authz.can_read_deal(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.deals d
    where d.id = p_deal
      and (
        (authz.is_owner_or_assignee(d.id)
          and authz.has_role_permission('deal.read', d.legal_entity_id, 'own'))
        or authz.has_role_permission('deal.read', d.legal_entity_id, 'entity')
        or (d.owner_user_id is not null
          and authz.has_grant('deal.read', d.legal_entity_id, d.branch_id))
      )
  )
$$;

-- ---------------------------------------------------------------------------
-- Intake settings: several pipelines; scheduler switch readable by the admin
-- ---------------------------------------------------------------------------

-- Null = only category_id (rows created before this migration / fixtures).
alter table public.integration_intake_config add column eligible_category_ids bigint[]
  check (eligible_category_ids is null or (
    cardinality(eligible_category_ids) between 1 and 50
    and array_position(eligible_category_ids, null) is null
    and 0 <= all (eligible_category_ids)));

create function authz.intake_categories(p_cfg public.integration_intake_config) returns bigint[]
language sql immutable set search_path = '' as $$
  select coalesce(p_cfg.eligible_category_ids, array[p_cfg.category_id])
$$;

create policy integration_admin_read on public.integration_sync_schedule
  for select to authenticated using ((select authz.can_admin_any('integration.manage')));
create policy require_valid_session on public.integration_sync_schedule as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
grant select (id, enabled, last_dispatched_at, updated_at) on public.integration_sync_schedule to authenticated;

-- ---------------------------------------------------------------------------
-- Mapping: at most one active Bitrix user per staff member
-- ---------------------------------------------------------------------------

create unique index bitrix_user_mappings_one_active_per_staff
  on public.bitrix_user_mappings (portal_member_id, staff_user_id) where active;

-- ---------------------------------------------------------------------------
-- Ownership helpers
-- ---------------------------------------------------------------------------

-- Stage 0 (audit I01): the one Sales-owner rule for every Deal owner entry
-- point (intake apply, link/unlink, staff (de)activation, settings restore).
-- An eligible owner is active staff with an ACTIVE SALES membership in the
-- Deal's legal entity and branch - the rule Lead intake already applies
-- (20261007000200). Anyone else leaves the Deal waiting for an owner.
create function authz.is_eligible_deal_owner(p_user uuid, p_entity uuid, p_branch uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_user is not null and exists (
    select 1 from public.staff_profiles p
    join public.memberships ms on ms.user_id = p.user_id
    where p.user_id = p_user and p.status = 'active'
      and ms.legal_entity_id = p_entity and ms.branch_id = p_branch
      and ms.role_code = 'sales' and ms.status = 'active')
$$;

-- CRM owner for a Bitrix responsible, or null (waiting for owner): the staff
-- member of the active mapping when eligible in the portal's pilot branch.
create function authz.bitrix_owner_for(p_member_id text, p_entity uuid, p_bitrix_user bigint) returns uuid
language sql stable security definer set search_path = '' as $$
  select m.staff_user_id
  from public.bitrix_user_mappings m
  join public.integration_intake_config c on c.portal_member_id = m.portal_member_id
  where m.portal_member_id = p_member_id and m.bitrix_user_id = p_bitrix_user and m.active
    and authz.is_eligible_deal_owner(m.staff_user_id, p_entity, c.pilot_branch_id)
  limit 1
$$;

-- Sets the owner of one deal and keeps exactly one active 'sales' assignment
-- (for the owner). Returns true when anything changed.
create function authz.set_deal_owner(p_deal_id uuid, p_owner uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entity uuid;
  v_changed boolean := false;
  v_n integer;
begin
  -- Stage 0 (I01): never a non-Sales owner. An owner who is not eligible in
  -- the Deal's own legal entity and branch leaves it waiting for an owner.
  if p_owner is not null and not exists (
    select 1 from public.deals d
    where d.id = p_deal_id and authz.is_eligible_deal_owner(p_owner, d.legal_entity_id, d.branch_id)
  ) then
    p_owner := null;
  end if;

  update public.deals d set owner_user_id = p_owner
  where d.id = p_deal_id and d.owner_user_id is distinct from p_owner
  returning d.legal_entity_id into v_entity;
  v_changed := found;
  if v_entity is null then
    select d.legal_entity_id into v_entity from public.deals d where d.id = p_deal_id;
  end if;

  update public.deal_assignments a set ended_at = now()
  where a.deal_id = p_deal_id and a.assignment_kind = 'sales' and a.ended_at is null
    and (p_owner is null or a.user_id <> p_owner);
  get diagnostics v_n = row_count;
  v_changed := v_changed or v_n > 0;

  if p_owner is not null and not exists (
    select 1 from public.deal_assignments a
    where a.deal_id = p_deal_id and a.user_id = p_owner and a.assignment_kind = 'sales' and a.ended_at is null
  ) then
    insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind)
    values (p_deal_id, v_entity, p_owner, 'sales');
    v_changed := true;
  end if;
  return v_changed;
end;
$$;

-- Recomputes the owner of every stored deal whose Bitrix responsible is
-- p_bitrix_user. One audit event (counts only). Returns the number changed.
create function authz.reassign_bitrix_user_deals(p_member_id text, p_bitrix_user bigint, p_cause text)
returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_owner uuid;
  v_count integer := 0;
  r record;
begin
  select * into v_cfg from public.integration_intake_config c where c.portal_member_id = p_member_id;
  if v_cfg.id is null then
    return 0;
  end if;
  v_owner := authz.bitrix_owner_for(p_member_id, v_cfg.pilot_legal_entity_id, p_bitrix_user);
  for r in
    select d.id from public.deals d
    where d.source_system = 'bitrix' and d.source_portal = p_member_id and d.source_assigned_by_id = p_bitrix_user
    order by d.id
    for update
  loop
    if authz.set_deal_owner(r.id, v_owner) then
      v_count := v_count + 1;
    end if;
  end loop;
  if v_count > 0 then
    perform authz.write_audit('integration.deal_owners_recomputed', v_cfg.pilot_legal_entity_id, null,
      'staff_profile', v_owner, null,
      jsonb_build_object('bitrixUserId', p_bitrix_user, 'ownerUserId', v_owner, 'dealsChanged', v_count,
        'cause', p_cause));
  end if;
  return v_count;
end;
$$;

-- Activation / deactivation of a membership (accept_my_invitation,
-- deactivate_staff_member) recomputes the person's Bitrix deals at once.
-- Deactivation also ends every active assignment of that person.
create function authz.on_membership_status_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  if new.status = 'inactive' then
    update public.deal_assignments a set ended_at = now()
    where a.user_id = new.user_id and a.ended_at is null;
  end if;
  for r in
    select m.portal_member_id, m.bitrix_user_id from public.bitrix_user_mappings m
    where m.staff_user_id = new.user_id and m.active
  loop
    perform authz.reassign_bitrix_user_deals(r.portal_member_id, r.bitrix_user_id,
      case when new.status = 'inactive' then 'staff_deactivated' else 'staff_activated' end);
  end loop;
  return null;
end;
$$;

create trigger memberships_recompute_bitrix_owners
  after update of status on public.memberships
  for each row when (old.status is distinct from new.status)
  execute function authz.on_membership_status_change();

-- ---------------------------------------------------------------------------
-- Admin commands (own session; integration.manage + staff.manage; audited)
-- ---------------------------------------------------------------------------

-- The single intake configuration the admin may manage, or an exception.
create function authz.require_manageable_intake() returns public.integration_intake_config
language plpgsql stable security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_n integer;
begin
  select count(*) into v_n from public.integration_intake_config;
  if v_n <> 1 then
    raise exception 'intake is not configured' using errcode = '55000';
  end if;
  select * into v_cfg from public.integration_intake_config;
  if not authz.can_admin('integration.manage', v_cfg.pilot_legal_entity_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  return v_cfg;
end;
$$;

-- Grant: link staff member <-> Bitrix user and give them that user's deals.
-- Returns {dealsChanged}.
create function public.integration_link_bitrix_user(p_staff_user_id uuid, p_bitrix_user_id bigint)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_status text;
  v_other uuid;
  v_count integer;
begin
  v_cfg := authz.require_manageable_intake();
  if not authz.can_admin_user('staff.manage', p_staff_user_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_bitrix_user_id is null or p_bitrix_user_id <= 0 then
    raise exception 'invalid Bitrix user' using errcode = '22023';
  end if;
  select p.status into v_status from public.staff_profiles p where p.user_id = p_staff_user_id for update;
  if v_status is null or v_status = 'inactive' then
    raise exception 'staff member is not active or invited' using errcode = '22023';
  end if;

  select m.staff_user_id into v_other from public.bitrix_user_mappings m
  where m.portal_member_id = v_cfg.portal_member_id and m.bitrix_user_id = p_bitrix_user_id and m.active;
  if v_other is not null and v_other <> p_staff_user_id then
    raise exception 'this Bitrix user is already linked to another staff member' using errcode = '23505';
  end if;
  if exists (
    select 1 from public.bitrix_user_mappings m
    where m.portal_member_id = v_cfg.portal_member_id and m.staff_user_id = p_staff_user_id and m.active
      and m.bitrix_user_id <> p_bitrix_user_id
  ) then
    raise exception 'this staff member is already linked to another Bitrix user' using errcode = '23505';
  end if;

  insert into public.bitrix_user_mappings (portal_member_id, bitrix_user_id, staff_user_id, active, created_by, updated_by)
  values (v_cfg.portal_member_id, p_bitrix_user_id, p_staff_user_id, true, auth.uid(), auth.uid())
  on conflict (portal_member_id, bitrix_user_id) do update
    set staff_user_id = excluded.staff_user_id, active = true, updated_at = now(), updated_by = auth.uid();

  perform authz.write_audit('integration.bitrix_user_linked', v_cfg.pilot_legal_entity_id, null,
    'staff_profile', p_staff_user_id, null, jsonb_build_object('bitrixUserId', p_bitrix_user_id));
  v_count := authz.reassign_bitrix_user_deals(v_cfg.portal_member_id, p_bitrix_user_id, 'linked');
  return jsonb_build_object('dealsChanged', v_count);
end;
$$;

-- Revoke: unlink; that Bitrix user's deals go back to "waiting for owner".
-- Returns {bitrixUserId, dealsChanged} (bitrixUserId null when nothing was linked).
create function public.integration_unlink_bitrix_user(p_staff_user_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_bitrix bigint;
  v_count integer := 0;
begin
  v_cfg := authz.require_manageable_intake();
  if not authz.can_admin_user('staff.manage', p_staff_user_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  update public.bitrix_user_mappings m
  set active = false, updated_at = now(), updated_by = auth.uid()
  where m.portal_member_id = v_cfg.portal_member_id and m.staff_user_id = p_staff_user_id and m.active
  returning m.bitrix_user_id into v_bitrix;
  if v_bitrix is null then
    return jsonb_build_object('bitrixUserId', null, 'dealsChanged', 0);
  end if;
  perform authz.write_audit('integration.bitrix_user_unlinked', v_cfg.pilot_legal_entity_id, null,
    'staff_profile', p_staff_user_id, null, jsonb_build_object('bitrixUserId', v_bitrix));
  v_count := authz.reassign_bitrix_user_deals(v_cfg.portal_member_id, v_bitrix, 'unlinked');
  return jsonb_build_object('bitrixUserId', v_bitrix, 'dealsChanged', v_count);
end;
$$;

-- Sync settings from the admin page. Broadening eligibility re-queues the
-- deals that were ignored as not eligible and restarts the change watermark,
-- so the next sync re-evaluates them. Returns {requeued}.
create function public.integration_update_sync_settings(
  p_category_ids bigint[], p_stage_ids text[], p_cutoff_at timestamptz, p_sync_enabled boolean
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_changed boolean;
  v_requeued integer := 0;
begin
  v_cfg := authz.require_manageable_intake();
  if p_category_ids is null or cardinality(p_category_ids) not between 1 and 50
     or array_position(p_category_ids, null) is not null or not (0 <= all (p_category_ids)) then
    raise exception 'choose at least one pipeline' using errcode = '22023';
  end if;
  if p_stage_ids is null or cardinality(p_stage_ids) not between 1 and 50
     or array_position(p_stage_ids, null) is not null
     or exists (select 1 from unnest(p_stage_ids) s where s !~ '^[A-Za-z0-9_:.-]{1,50}$') then
    raise exception 'choose at least one stage' using errcode = '22023';
  end if;
  if p_cutoff_at is null or p_cutoff_at > now() or p_cutoff_at < now() - interval '10 years' then
    raise exception 'the start date must be in the past' using errcode = '22023';
  end if;
  if p_sync_enabled is null then
    raise exception 'invalid sync switch' using errcode = '22023';
  end if;

  v_changed := authz.intake_categories(v_cfg) is distinct from p_category_ids
    or v_cfg.eligible_stage_ids is distinct from p_stage_ids
    or v_cfg.cutoff_at is distinct from p_cutoff_at;

  update public.integration_intake_config c
  set eligible_category_ids = p_category_ids, category_id = p_category_ids[1],
      eligible_stage_ids = p_stage_ids, cutoff_at = p_cutoff_at,
      last_reconciled_at = case when v_changed then null else c.last_reconciled_at end,
      updated_at = now(), updated_by = auth.uid()
  where c.id = v_cfg.id;

  if v_changed then
    update public.integration_inbox i
    set status = 'pending', attempts = 0, next_attempt_at = now(), reason_code = null,
        origin = 'manual_retry', updated_at = now()
    where i.portal_member_id = v_cfg.portal_member_id and i.status = 'ignored'
      and i.reason_code in ('not_eligible_category', 'not_eligible_stage', 'before_cutoff');
    get diagnostics v_requeued = row_count;
  end if;

  update public.integration_sync_schedule s set enabled = p_sync_enabled, updated_at = now() where s.id;

  perform authz.write_audit('integration.settings_updated', v_cfg.pilot_legal_entity_id, null,
    'integration_intake_config', v_cfg.id, null,
    jsonb_build_object('categoryIds', p_category_ids, 'stageCount', cardinality(p_stage_ids),
      'cutoffAt', p_cutoff_at, 'syncEnabled', p_sync_enabled, 'requeued', v_requeued));
  return jsonb_build_object('requeued', v_requeued);
end;
$$;

-- ---------------------------------------------------------------------------
-- Apply: store every eligible deal; owner from the mapping or none
-- (replaces 20261003000100 version; same signature, same inbox semantics)
-- ---------------------------------------------------------------------------

create or replace function public.integration_apply_bitrix_deal(p_inbox_id uuid, p_lock_token uuid, p_deal jsonb)
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

    -- Eligibility. Pipeline always; stage and cutoff decide ENTRY only (an
    -- imported deal keeps following Bitrix stage changes). A deal enters when
    -- it was created OR modified on/after the cutoff.
    if not (v_category = any (authz.intake_categories(v_cfg))) then
      v_outcome := 'ignored'; v_reason := 'not_eligible_category';
      exit checks;
    end if;
    if v_existing.id is null then
      if not (v_stage = any (v_cfg.eligible_stage_ids)) then
        v_outcome := 'ignored'; v_reason := 'not_eligible_stage';
        exit checks;
      end if;
      if v_created < v_cfg.cutoff_at and v_modified < v_cfg.cutoff_at then
        v_outcome := 'ignored'; v_reason := 'before_cutoff';
        exit checks;
      end if;
    elsif v_modified < v_existing.source_modified_at then
      v_outcome := 'stale_ignored'; v_reason := 'stale_ignored'; v_deal_id := v_existing.id;
      exit checks;
    end if;

    -- Owner from the mapping, or none ("waiting for owner"). Never a fallback person.
    v_owner := authz.bitrix_owner_for(v_cfg.portal_member_id, v_cfg.pilot_legal_entity_id, v_assigned);

    if v_existing.id is null then
      begin
        insert into public.deals
          (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic,
           source_system, source_portal, source_deal_id, source_stage_id, source_category_id,
           source_created_at, source_modified_at, last_synced_at, last_verified_at, intake_inbox_id,
           source_assigned_by_id)
        values
          (v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'BX-' || v_inbox.source_deal_id::text,
           v_title, v_owner, false,
           'bitrix', v_cfg.portal_member_id, v_inbox.source_deal_id, v_stage, v_category,
           v_created, v_modified, now(), now(), v_inbox.id, v_assigned)
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
        perform authz.set_deal_owner(v_deal_id, v_owner);
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

    -- Equal version and identical Bitrix-owned content: nothing to change.
    if v_modified = v_existing.source_modified_at
       and v_existing.title = v_title and v_existing.source_stage_id = v_stage
       and v_existing.source_category_id = v_category
       and v_existing.source_assigned_by_id is not distinct from v_assigned
       and v_existing.owner_user_id is not distinct from v_owner then
      v_outcome := 'stale_ignored'; v_reason := 'stale_ignored'; v_deal_id := v_existing.id;
      exit checks;
    end if;

    -- Bitrix-owned header fields; the owner follows the (re)mapped responsible.
    v_owner_changed := v_existing.owner_user_id is distinct from v_owner;
    update public.deals d
    set title = v_title,
        source_stage_id = v_stage,
        source_category_id = v_category,
        source_created_at = v_created,
        source_modified_at = v_modified,
        source_assigned_by_id = v_assigned,
        last_synced_at = now(),
        last_verified_at = now(),
        intake_inbox_id = v_inbox.id
    where d.id = v_existing.id;
    perform authz.set_deal_owner(v_existing.id, v_owner);
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
        'waitingForOwner', v_owner is null));
  elsif v_outcome = 'needs_review' then
    perform authz.write_audit('integration.deal_needs_review',
      v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'integration_inbox', v_inbox.id, null,
      jsonb_build_object('inboxId', v_inbox.id, 'origin', v_inbox.origin, 'reasonCode', v_reason));
  end if;

  return jsonb_build_object('outcome', v_outcome, 'dealId', v_deal_id, 'reasonCode', v_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function
  authz.intake_categories(public.integration_intake_config),
  authz.is_eligible_deal_owner(uuid, uuid, uuid),
  authz.bitrix_owner_for(text, uuid, bigint),
  authz.set_deal_owner(uuid, uuid),
  authz.reassign_bitrix_user_deals(text, bigint, text),
  authz.on_membership_status_change(),
  authz.require_manageable_intake(),
  public.integration_link_bitrix_user(uuid, bigint),
  public.integration_unlink_bitrix_user(uuid),
  public.integration_update_sync_settings(bigint[], text[], timestamptz, boolean)
from public, anon, authenticated, service_role;

grant execute on function
  public.integration_link_bitrix_user(uuid, bigint),
  public.integration_unlink_bitrix_user(uuid),
  public.integration_update_sync_settings(bigint[], text[], timestamptz, boolean)
to authenticated;

-- ---------------------------------------------------------------------------
-- Realtime: assignments too (RLS-filtered per subscriber)
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'deal_assignments') then
    alter publication supabase_realtime add table public.deal_assignments;
  end if;
end;
$$;

-- ===========================================================================
-- Section 3 of 10: main 20261009000300_deal_read_policy_performance.sql (was 20261007000200)
-- Stage 0 corrections: none.
-- ===========================================================================

-- TripNavigate CRM - deal read policy performance (same rule, evaluated once per query).
--
-- Problem (measured locally with 1 838 imported deals): the deals policy
-- `using (authz.can_read_deal(id))` re-ran the session check and every
-- permission lookup for EACH row: ~4 s for an administrator's count(*), close
-- to PostgREST's 8 s statement_timeout for `authenticated` when several queries
-- run at once (the admin Deals page failed intermittently).
--
-- Fix: the viewer-specific parts (session, entities with deal.read own/entity,
-- explicit grants, assigned deal ids) are computed ONCE per statement as
-- uncorrelated sub-selects (InitPlans); each row is then compared against them.
-- The rule is unchanged (authz.can_read_deal, 20261007000100):
--   session_ok AND (
--     (owner or active assignee) AND deal.read own-or-entity role permission
--     OR deal.read entity role permission
--     OR (deal has an owner AND explicit deal.read grant for its entity/branch,
--         while still an active member of that entity))
-- deal_assignments reuses the deals policy through `deal_id = any(array(select id
-- from deals))` (RLS applies to that sub-select), which is exactly
-- can_read_deal(deal_id). authz.can_read_deal stays for commands and
-- deal_commercials. The policy-parity and RLS suites cover the equivalence.


-- Entities where the viewer holds p_permission through an active membership in
-- an enabled entity/branch. p_scope 'own' is satisfied by own or entity rows.
create function authz.my_permission_entities(p_permission text, p_scope text) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct m.legal_entity_id), '{}')
  from public.memberships m
  join public.role_permissions rp on rp.role_code = m.role_code
  join public.legal_entities e on e.id = m.legal_entity_id
  join public.branches b on b.id = m.branch_id
  where m.user_id = (select auth.uid())
    and m.status = 'active' and e.status = 'enabled' and b.status = 'enabled'
    and rp.permission_code = p_permission
    and (p_scope = 'own' or rp.scope = 'entity')
$$;

-- Live explicit grants of p_permission whose entity the viewer is still an
-- active member of. Entity-wide grants -> entity ids; branch grants -> branch ids.
create function authz.my_grant_entities(p_permission text) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct g.legal_entity_id), '{}')
  from public.access_grants g
  where g.user_id = (select auth.uid()) and g.permission_code = p_permission and g.branch_id is null
    and g.revoked_at is null and g.starts_at <= now() and (g.expires_at is null or g.expires_at > now())
    and authz.is_entity_member(g.legal_entity_id)
$$;

create function authz.my_grant_branches(p_permission text) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct g.branch_id), '{}')
  from public.access_grants g
  where g.user_id = (select auth.uid()) and g.permission_code = p_permission and g.branch_id is not null
    and g.revoked_at is null and g.starts_at <= now() and (g.expires_at is null or g.expires_at > now())
    and authz.is_entity_member(g.legal_entity_id)
$$;

create function authz.my_assigned_deal_ids() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct a.deal_id), '{}')
  from public.deal_assignments a
  where a.user_id = (select auth.uid()) and a.ended_at is null
$$;

revoke all on function
  authz.my_permission_entities(text, text), authz.my_grant_entities(text),
  authz.my_grant_branches(text), authz.my_assigned_deal_ids()
from public, anon, authenticated, service_role;
grant execute on function
  authz.my_permission_entities(text, text), authz.my_grant_entities(text),
  authz.my_grant_branches(text), authz.my_assigned_deal_ids()
to authenticated;

drop policy scoped_read on public.deals;
create policy scoped_read on public.deals
  for select to authenticated using (
    (select authz.session_ok())
    and (
      legal_entity_id = any ((select authz.my_permission_entities('deal.read', 'entity'))::uuid[])
      or (
        legal_entity_id = any ((select authz.my_permission_entities('deal.read', 'own'))::uuid[])
        and (owner_user_id = (select auth.uid()) or id = any ((select authz.my_assigned_deal_ids())::uuid[]))
      )
      or (
        owner_user_id is not null
        and (
          legal_entity_id = any ((select authz.my_grant_entities('deal.read'))::uuid[])
          or branch_id = any ((select authz.my_grant_branches('deal.read'))::uuid[])
        )
      )
    )
  );

drop policy scoped_read on public.deal_assignments;
create policy scoped_read on public.deal_assignments
  for select to authenticated using (deal_id = any (array(select d.id from public.deals d)));

-- ===========================================================================
-- Section 4 of 10: main 20261009000400_intake_read_policy_performance.sql (was 20261007000300)
-- Stage 0 corrections: none.
-- ===========================================================================

-- TripNavigate CRM - intake read policies evaluated once per query (same rule).
--
-- integration_inbox and bitrix_user_mappings were readable through
-- `using (authz.can_manage_portal(portal_member_id))`, re-checked for EACH row:
-- ~3 s per inbox query with 1 838 rows, and the Bitrix sync page runs about ten
-- of them at once (PostgREST statement_timeout for authenticated is 8 s).
-- The portals the viewer may manage are now computed once (InitPlan); the rule
-- is unchanged: a config row for the portal whose legal entity the viewer
-- administers with integration.manage (authz.can_admin, incl. session_ok).


create function authz.my_managed_portals() returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(c.portal_member_id), '{}')
  from public.integration_intake_config c
  where authz.can_admin('integration.manage', c.pilot_legal_entity_id)
$$;
revoke all on function authz.my_managed_portals() from public, anon, authenticated, service_role;
grant execute on function authz.my_managed_portals() to authenticated;

drop policy integration_admin_read on public.integration_inbox;
create policy integration_admin_read on public.integration_inbox
  for select to authenticated using (portal_member_id = any ((select authz.my_managed_portals())::text[]));

drop policy integration_admin_read on public.bitrix_user_mappings;
create policy integration_admin_read on public.bitrix_user_mappings
  for select to authenticated using (portal_member_id = any ((select authz.my_managed_portals())::text[]));

-- ===========================================================================
-- Section 5 of 10: main 20261009000500_deal_soft_removal.sql (was 20261008000100)
-- Stage 0 corrections: removal records who was on the Deal (deal_removal_participants) before it clears the owner and ends assignments.
-- ===========================================================================

-- TripNavigate CRM - imported deals can be REMOVED from the CRM (soft, audited).
--
-- Owner rule (docs/implementation/audits/superadmin-count-syncdate.md):
-- moving the sync date later, unticking a pipeline or unticking a stage
-- removes the stored Bitrix deals that no longer belong, for EVERY role
-- (Super Admin included): not listed, not counted, no detail page, no
-- assignments. Removal is soft so the audit trail stays and moving the date
-- back restores the deal (20261008000200).
--
--   * deals.removed_at / removed_reason (imported deals only).
--   * Restrictive SELECT policy on deals: removed rows are invisible to every
--     authenticated reader. deal_assignments (policy reads deals), deal
--     commercials (authz.can_read_deal) and Realtime (RLS per subscriber)
--     follow automatically.
--   * authz.remove_bitrix_deals(): one place that removes (owner cleared,
--     active assignments ended) and pings deal_list_changes. Stage 0: it first
--     records the owner and the active assignees in deal_removal_participants
--     so historical approval conflicts survive the removal.
--   * public.deal_list_changes: one row per legal entity, touched on every
--     removal/restore, published to Realtime so open deal pages refresh even
--     though the removed row itself is no longer visible to them.
--   * Link/unlink never re-assigns a removed deal.
--
-- Super Admin visibility is unchanged and already in RLS: role permission
-- super_admin/deal.read/entity (20261007000100) through the entity path of
-- the deals policy (20261007000200) - every branch, every owner, ownerless.
--
-- Rollback (forward-only): a migration that drops policy hide_removed and
-- clears removed_at. Never delete deals or audit rows.


alter table public.deals
  add column removed_at timestamptz,
  add column removed_reason text
    check (removed_reason in ('before_sync_date', 'pipeline_not_eligible', 'stage_not_eligible'));
alter table public.deals add constraint deals_removed_consistent
  check ((removed_at is null) = (removed_reason is null));
alter table public.deals add constraint deals_removed_imported_only
  check (removed_at is null or not is_synthetic);
create index deals_removed_idx on public.deals (source_portal, removed_at) where source_system = 'bitrix';
create index deals_source_created_idx on public.deals (source_portal, source_created_at) where source_system = 'bitrix';

-- Every role, every path: a removed deal is not readable.
create policy hide_removed on public.deals
  as restrictive for select to authenticated using (removed_at is null);

create or replace function authz.can_read_deal(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.deals d
    where d.id = p_deal
      and d.removed_at is null
      and (
        (authz.is_owner_or_assignee(d.id)
          and authz.has_role_permission('deal.read', d.legal_entity_id, 'own'))
        or authz.has_role_permission('deal.read', d.legal_entity_id, 'entity')
        or (d.owner_user_id is not null
          and authz.has_grant('deal.read', d.legal_entity_id, d.branch_id))
      )
  )
$$;

-- ---------------------------------------------------------------------------
-- List-change signal (Realtime). Counts only; no deal content.
-- ---------------------------------------------------------------------------

create table public.deal_list_changes (
  legal_entity_id uuid primary key references public.legal_entities (id),
  changed_at timestamptz not null default now(),
  removed integer not null default 0 check (removed >= 0),
  restored integer not null default 0 check (restored >= 0)
);
comment on table public.deal_list_changes is
  'Touched whenever imported deals are removed or restored, so open deal pages refresh (Realtime).';
alter table public.deal_list_changes enable row level security;
revoke all on public.deal_list_changes from public, anon, authenticated, service_role;
grant select on public.deal_list_changes to authenticated, service_role;
create policy require_valid_session on public.deal_list_changes as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
create policy member_read on public.deal_list_changes for select to authenticated using (
  (select authz.session_ok())
  and legal_entity_id = any ((select authz.my_permission_entities('deal.read', 'own'))::uuid[])
);

create function authz.touch_deal_list(p_entity uuid, p_removed integer, p_restored integer) returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.deal_list_changes as c (legal_entity_id, changed_at, removed, restored)
  values (p_entity, now(), greatest(p_removed, 0), greatest(p_restored, 0))
  on conflict (legal_entity_id) do update
    set changed_at = now(), removed = excluded.removed, restored = excluded.restored
$$;

-- Stage 0 (owner rule, 8 October 2026): who was on a Deal when the sync
-- removed it. Removal clears the owner and ends the assignments; this
-- append-only record keeps those people in approval-conflict checks
-- (authz.finance_deal_conflict), also after the Deal is restored. Ids only;
-- read only by security-definer functions (no API grant).
create table public.deal_removal_participants (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null,
  legal_entity_id uuid not null,
  user_id uuid not null references public.staff_profiles (user_id),
  participation text not null
    check (participation in ('owner', 'sales', 'purchase', 'flight', 'visa', 'accounts')),
  removed_at timestamptz not null,
  removed_reason text not null
    check (removed_reason in ('before_sync_date', 'pipeline_not_eligible', 'stage_not_eligible')),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  constraint deal_removal_participants_once unique (deal_id, user_id, participation, removed_at)
);
create index deal_removal_participants_user_idx on public.deal_removal_participants (user_id, deal_id);
comment on table public.deal_removal_participants is
  'Owner and active assignees of a Deal at each sync removal (append-only; approval-conflict history).';
alter table public.deal_removal_participants enable row level security;
revoke all on public.deal_removal_participants from public, anon, authenticated, service_role;
create policy require_valid_session on public.deal_removal_participants as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
create trigger deal_removal_participants_append_only before update or delete on public.deal_removal_participants
  for each row execute function authz.finance_append_only();

-- Removes the given imported deals (those not removed yet): participants
-- recorded, owner cleared, active assignments ended, list-change signal.
-- Returns the number removed.
create function authz.remove_bitrix_deals(p_ids uuid[], p_reason text) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ids uuid[];
  v_entity uuid;
begin
  if p_reason is null or p_reason not in ('before_sync_date', 'pipeline_not_eligible', 'stage_not_eligible') then
    raise exception 'invalid removal reason' using errcode = '22023';
  end if;
  -- Lock the Deals in id order before reading their owner and assignees.
  select array_agg(x.id order by x.id), min(x.legal_entity_id::text)::uuid into v_ids, v_entity
  from (
    select d.id, d.legal_entity_id from public.deals d
    where d.id = any (p_ids) and d.removed_at is null and not d.is_synthetic
    order by d.id
    for update
  ) x;
  if v_ids is null then
    return 0;
  end if;
  insert into public.deal_removal_participants
    (deal_id, legal_entity_id, user_id, participation, removed_at, removed_reason)
  select d.id, d.legal_entity_id, d.owner_user_id, 'owner', now(), p_reason
  from public.deals d
  where d.id = any (v_ids) and d.owner_user_id is not null
  union
  select a.deal_id, a.legal_entity_id, a.user_id, a.assignment_kind, now(), p_reason
  from public.deal_assignments a
  where a.deal_id = any (v_ids) and a.ended_at is null
  on conflict do nothing;
  update public.deals d
  set removed_at = now(), removed_reason = p_reason, owner_user_id = null
  where d.id = any (v_ids);
  update public.deal_assignments a set ended_at = now()
  where a.deal_id = any (v_ids) and a.ended_at is null;
  perform authz.touch_deal_list(v_entity, cardinality(v_ids), 0);
  return cardinality(v_ids);
end;
$$;

-- Link / unlink / (de)activation never touch removed deals (replaces 20261007000100).
create or replace function authz.reassign_bitrix_user_deals(p_member_id text, p_bitrix_user bigint, p_cause text)
returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_owner uuid;
  v_count integer := 0;
  r record;
begin
  select * into v_cfg from public.integration_intake_config c where c.portal_member_id = p_member_id;
  if v_cfg.id is null then
    return 0;
  end if;
  v_owner := authz.bitrix_owner_for(p_member_id, v_cfg.pilot_legal_entity_id, p_bitrix_user);
  for r in
    select d.id from public.deals d
    where d.source_system = 'bitrix' and d.source_portal = p_member_id and d.source_assigned_by_id = p_bitrix_user
      and d.removed_at is null
    order by d.id
    for update
  loop
    if authz.set_deal_owner(r.id, v_owner) then
      v_count := v_count + 1;
    end if;
  end loop;
  if v_count > 0 then
    perform authz.write_audit('integration.deal_owners_recomputed', v_cfg.pilot_legal_entity_id, null,
      'staff_profile', v_owner, null,
      jsonb_build_object('bitrixUserId', p_bitrix_user, 'ownerUserId', v_owner, 'dealsChanged', v_count,
        'cause', p_cause));
  end if;
  return v_count;
end;
$$;

revoke all on function
  authz.touch_deal_list(uuid, integer, integer),
  authz.remove_bitrix_deals(uuid[], text)
from public, anon, authenticated, service_role;

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'deal_list_changes') then
    alter publication supabase_realtime add table public.deal_list_changes;
  end if;
end;
$$;

-- ===========================================================================
-- Section 6 of 10: main 20261009000600_sync_date_resync.sql (was 20261008000200)
-- Stage 0 corrections: none.
-- ===========================================================================

-- TripNavigate CRM - the sync date, pipelines and stages apply to stored deals;
-- full resync with a cursor (no truncation) and a Bitrix vs CRM count check.
--
-- Rules (docs/implementation/audits/superadmin-count-syncdate.md):
--   * Sync date = Bitrix DATE_CREATE on/after 00:00 Asia/Kolkata of the chosen
--     day (cutoff_at is normalised to IST midnight). Was: created OR modified.
--   * Pipelines always apply: a stored deal in an unticked pipeline is removed;
--     back in a ticked pipeline it is restored.
--   * Stages decide ENTRY (Phase 2 contract): a deal that later moves to a
--     won/lost/unticked stage stays. Unticking a stage in the settings removes
--     the stored deals currently in that stage (explicit admin instruction).
--   * Saving settings (integration_update_sync_settings, one transaction):
--     removes / restores stored deals, ends assignments of removed deals,
--     re-applies the owner mapping of restored deals and queues them for a
--     fresh crm.deal.get, supersedes any open resync job and queues a new one,
--     writes one audit event.
--   * Resync job: the scheduled sync lists Bitrix with exactly the configured
--     filter, ID-cursor paging (>ID, order ID), a few pages per run, until
--     complete; every listed deal goes through integration_enqueue_reconcile.
--     When listing is done and the inbox has drained, the job records
--     Bitrix vs CRM counts and re-reads every stored deal Bitrix did not list.
--     A daily job is queued automatically (replaces the capped entry pass).
--
-- Rollback (forward-only): restore the previous function bodies; drop the job
-- tables. Never delete deals or audit rows.


-- ---------------------------------------------------------------------------
-- Sync date helper
-- ---------------------------------------------------------------------------

-- 00:00 Asia/Kolkata of the IST calendar day containing p_at.
create function authz.ist_midnight(p_at timestamptz) returns timestamptz
language sql immutable set search_path = '' as $$
  select (date_trunc('day', p_at at time zone 'Asia/Kolkata')) at time zone 'Asia/Kolkata'
$$;

-- ---------------------------------------------------------------------------
-- Resync jobs
-- ---------------------------------------------------------------------------

create table public.integration_resync_jobs (
  id uuid primary key default gen_random_uuid(),
  portal_member_id text not null references public.integration_intake_config (portal_member_id),
  reason text not null check (reason in ('settings_changed', 'manual', 'daily')),
  status text not null default 'queued' check (status in ('queued', 'running', 'done', 'superseded')),
  -- Filter snapshot (the config at queue time).
  cutoff_at timestamptz not null,
  category_ids bigint[] not null,
  stage_ids text[] not null,
  -- Listing progress: last Bitrix ID listed, Bitrix `total` from the first page.
  cursor_id bigint not null default 0 check (cursor_id >= 0),
  listing_done boolean not null default false,
  bitrix_total integer check (bitrix_total >= 0),
  scanned integer not null default 0 check (scanned >= 0),
  enqueued integer not null default 0 check (enqueued >= 0),
  lock_token uuid,
  locked_until timestamptz,
  -- {bitrix, crm, missing, extra, keptAfterStageMove, reRead} when done.
  result jsonb,
  created_at timestamptz not null default now(),
  created_by uuid references public.staff_profiles (user_id),
  started_at timestamptz,
  finished_at timestamptz,
  check ((status = 'done') = (finished_at is not null and result is not null) or status = 'superseded')
);
create unique index integration_resync_jobs_one_open
  on public.integration_resync_jobs (portal_member_id) where status in ('queued', 'running');
create index integration_resync_jobs_recent on public.integration_resync_jobs (portal_member_id, created_at desc);
comment on table public.integration_resync_jobs is
  'Full Bitrix -> CRM resync with an ID cursor; progress and the Bitrix vs CRM count check (counts only).';

-- IDs Bitrix listed for a job (deleted when the job finishes).
create table public.integration_resync_seen (
  job_id uuid not null references public.integration_resync_jobs (id) on delete cascade,
  source_deal_id bigint not null check (source_deal_id > 0),
  primary key (job_id, source_deal_id)
);

alter table public.integration_resync_jobs enable row level security;
alter table public.integration_resync_seen enable row level security;
revoke all on public.integration_resync_jobs, public.integration_resync_seen from public, anon, authenticated, service_role;
grant select on public.integration_resync_jobs to authenticated, service_role;
create policy require_valid_session on public.integration_resync_jobs as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
create policy integration_admin_read on public.integration_resync_jobs
  for select to authenticated using (portal_member_id = any ((select authz.my_managed_portals())::text[]));

-- Queues a job for the portal unless one is open. Returns the open job id.
create function authz.queue_resync(p_member_id text, p_reason text, p_actor uuid) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_id uuid;
begin
  select * into v_cfg from public.integration_intake_config c where c.portal_member_id = p_member_id;
  if v_cfg.id is null then
    raise exception 'intake is not configured' using errcode = '55000';
  end if;
  select j.id into v_id from public.integration_resync_jobs j
  where j.portal_member_id = p_member_id and j.status in ('queued', 'running');
  if v_id is not null then
    return v_id;
  end if;
  insert into public.integration_resync_jobs (portal_member_id, reason, cutoff_at, category_ids, stage_ids, created_by)
  values (p_member_id, p_reason, v_cfg.cutoff_at, authz.intake_categories(v_cfg), v_cfg.eligible_stage_ids, p_actor)
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
    select j.id into v_id from public.integration_resync_jobs j
    where j.portal_member_id = p_member_id and j.status in ('queued', 'running');
  end if;
  return v_id;
end;
$$;

-- Service role (admin "Sync now"): queue a manual resync. Returns {jobId}.
create function public.integration_queue_resync(p_member_id text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform authz.require_intake_portal(p_member_id);
  return jsonb_build_object('jobId', authz.queue_resync(p_member_id, 'manual', null));
end;
$$;

-- Scheduler: the open job leased for p_lease_seconds, or null. Queues the
-- daily job when none is open and none was queued in the last 24 hours.
-- Returns {jobId, lockToken, cutoffAt, categoryIds, stageIds, cursorId,
-- listingDone, bitrixTotal, scanned}.
create function public.integration_resync_next(p_member_id text, p_lease_seconds integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.integration_resync_jobs%rowtype;
begin
  perform authz.require_intake_portal(p_member_id);
  if p_lease_seconds is null or p_lease_seconds < 30 or p_lease_seconds > 900 then
    raise exception 'lease must be between 30 and 900 seconds' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.integration_resync_jobs j
    where j.portal_member_id = p_member_id
      and (j.status in ('queued', 'running') or j.created_at > now() - interval '24 hours')
  ) then
    perform authz.queue_resync(p_member_id, 'daily', null);
  end if;

  select * into v_job from public.integration_resync_jobs j
  where j.portal_member_id = p_member_id and j.status in ('queued', 'running')
    and (j.locked_until is null or j.locked_until <= now())
  for update skip locked;
  if v_job.id is null then
    return null;
  end if;
  update public.integration_resync_jobs j
  set status = 'running', lock_token = gen_random_uuid(),
      locked_until = now() + make_interval(secs => p_lease_seconds),
      started_at = coalesce(j.started_at, now())
  where j.id = v_job.id
  returning * into v_job;
  return jsonb_build_object('jobId', v_job.id, 'lockToken', v_job.lock_token, 'cutoffAt', v_job.cutoff_at,
    'categoryIds', to_jsonb(v_job.category_ids), 'stageIds', to_jsonb(v_job.stage_ids),
    'cursorId', v_job.cursor_id, 'listingDone', v_job.listing_done, 'bitrixTotal', v_job.bitrix_total,
    'scanned', v_job.scanned);
end;
$$;

create function authz.require_resync_lease(p_job uuid, p_token uuid) returns public.integration_resync_jobs
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.integration_resync_jobs%rowtype;
begin
  select * into v_job from public.integration_resync_jobs j where j.id = p_job for update;
  if v_job.id is null or v_job.status <> 'running' or v_job.lock_token is distinct from p_token
     or v_job.locked_until <= now() then
    raise exception 'resync lease not held' using errcode = '55P03';
  end if;
  return v_job;
end;
$$;

-- One listed Bitrix page: p_deals = [{id, modified (unix s)}], ascending IDs.
-- Every deal is enqueued through integration_enqueue_reconcile (dedupe,
-- up-to-date confirmation). p_last = true when Bitrix has no further page.
-- Returns {enqueued, scanned, cursorId}.
create function public.integration_resync_page(
  p_job uuid, p_token uuid, p_deals jsonb, p_total integer, p_last boolean
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.integration_resync_jobs%rowtype;
  v_item jsonb;
  v_id bigint;
  v_max bigint;
  v_enqueued integer := 0;
  v_n integer := 0;
  v_res jsonb;
begin
  v_job := authz.require_resync_lease(p_job, p_token);
  if p_deals is null or jsonb_typeof(p_deals) <> 'array' or jsonb_array_length(p_deals) > 500 or p_last is null then
    raise exception 'invalid resync page' using errcode = '22023';
  end if;
  v_max := v_job.cursor_id;
  for v_item in select * from jsonb_array_elements(p_deals) loop
    v_id := (v_item ->> 'id')::bigint;
    if v_id is null or v_id <= v_job.cursor_id then
      raise exception 'resync page out of order' using errcode = '22023';
    end if;
    insert into public.integration_resync_seen (job_id, source_deal_id) values (v_job.id, v_id)
    on conflict do nothing;
    v_res := public.integration_enqueue_reconcile(v_job.portal_member_id, v_id, (v_item ->> 'modified')::bigint);
    if not (v_res ->> 'duplicate')::boolean then
      v_enqueued := v_enqueued + 1;
    end if;
    v_max := greatest(v_max, v_id);
    v_n := v_n + 1;
  end loop;
  update public.integration_resync_jobs j
  set cursor_id = v_max, scanned = j.scanned + v_n, enqueued = j.enqueued + v_enqueued,
      bitrix_total = coalesce(j.bitrix_total, case when v_job.cursor_id = 0 then p_total end),
      listing_done = p_last,
      locked_until = greatest(j.locked_until, now() + interval '60 seconds')
  where j.id = v_job.id;
  return jsonb_build_object('enqueued', v_enqueued, 'scanned', v_job.scanned + v_n, 'cursorId', v_max);
end;
$$;

-- Completes a fully listed job once the inbox has drained. Stored deals that
-- Bitrix did not list are re-read (their state decides: removed, kept after a
-- stage move, or needs review when deleted in Bitrix).
-- Returns {done, waiting} or {done, result}.
create function public.integration_resync_finish(p_job uuid, p_token uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.integration_resync_jobs%rowtype;
  v_cfg public.integration_intake_config%rowtype;
  v_waiting integer;
  v_bitrix integer;
  v_crm integer;
  v_missing integer;
  v_kept integer;
  v_extra integer;
  v_reread integer := 0;
  v_result jsonb;
  r record;
begin
  v_job := authz.require_resync_lease(p_job, p_token);
  if not v_job.listing_done then
    raise exception 'resync listing not complete' using errcode = '22023';
  end if;
  select count(*) into v_waiting from public.integration_inbox i
  where i.portal_member_id = v_job.portal_member_id and i.status in ('pending', 'processing', 'failed');
  if v_waiting > 0 then
    update public.integration_resync_jobs j set lock_token = null, locked_until = null where j.id = v_job.id;
    return jsonb_build_object('done', false, 'waiting', v_waiting);
  end if;
  select * into v_cfg from public.integration_intake_config c where c.portal_member_id = v_job.portal_member_id;

  select count(*) into v_bitrix from public.integration_resync_seen s where s.job_id = v_job.id;
  select count(*) into v_crm from public.deals d
  where d.source_system = 'bitrix' and d.source_portal = v_job.portal_member_id and d.removed_at is null;
  select count(*) into v_missing from public.integration_resync_seen s
  where s.job_id = v_job.id and not exists (
    select 1 from public.deals d
    where d.source_system = 'bitrix' and d.source_portal = v_job.portal_member_id
      and d.source_deal_id = s.source_deal_id and d.removed_at is null);
  -- Stored, not listed, but still in a ticked pipeline and created on/after the
  -- date: it moved to a stage outside the list after import (kept by design).
  select count(*) into v_kept from public.deals d
  where d.source_system = 'bitrix' and d.source_portal = v_job.portal_member_id and d.removed_at is null
    and d.source_category_id = any (v_job.category_ids) and d.source_created_at >= v_job.cutoff_at
    and not (d.source_stage_id = any (v_job.stage_ids))
    and not exists (select 1 from public.integration_resync_seen s
                    where s.job_id = v_job.id and s.source_deal_id = d.source_deal_id);
  v_extra := v_crm - (v_bitrix - v_missing) - v_kept;

  -- Everything else stored but not listed: read it again from Bitrix.
  for r in
    select d.source_deal_id from public.deals d
    where d.source_system = 'bitrix' and d.source_portal = v_job.portal_member_id and d.removed_at is null
      and not exists (select 1 from public.integration_resync_seen s
                      where s.job_id = v_job.id and s.source_deal_id = d.source_deal_id)
      and not (d.source_category_id = any (v_job.category_ids) and d.source_created_at >= v_job.cutoff_at
               and not (d.source_stage_id = any (v_job.stage_ids)))
  loop
    insert into public.integration_inbox (portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, origin)
    values (v_job.portal_member_id, 'RECONCILE', r.source_deal_id, extract(epoch from now())::bigint,
      authz.intake_dedupe_key(v_job.portal_member_id, 'RESYNC:' || v_job.id::text, r.source_deal_id, 0), 'reconcile')
    on conflict (dedupe_key) do nothing;
    v_reread := v_reread + 1;
  end loop;

  v_result := jsonb_build_object('bitrix', v_bitrix, 'bitrixTotal', v_job.bitrix_total, 'crm', v_crm,
    'missing', v_missing, 'extra', v_extra, 'keptAfterStageMove', v_kept, 'reRead', v_reread,
    'inSync', v_missing = 0 and v_extra = 0);
  update public.integration_resync_jobs j
  set status = 'done', finished_at = now(), result = v_result, lock_token = null, locked_until = null
  where j.id = v_job.id;
  delete from public.integration_resync_seen s where s.job_id = v_job.id;
  perform authz.write_audit('integration.resync_completed', v_cfg.pilot_legal_entity_id, null,
    'integration_intake_config', v_cfg.id, null, v_result || jsonb_build_object('jobId', v_job.id, 'reason', v_job.reason));
  return jsonb_build_object('done', true, 'result', v_result);
end;
$$;

-- Releases the lease without finishing (time budget used up, Bitrix failed).
create function public.integration_resync_release(p_job uuid, p_token uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.integration_resync_jobs j set lock_token = null, locked_until = null
  where j.id = p_job and j.lock_token = p_token and j.status = 'running';
end;
$$;

-- ---------------------------------------------------------------------------
-- Settings (replaces 20261007000100; same signature)
-- ---------------------------------------------------------------------------

create or replace function public.integration_update_sync_settings(
  p_category_ids bigint[], p_stage_ids text[], p_cutoff_at timestamptz, p_sync_enabled boolean
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_cutoff timestamptz;
  v_changed boolean;
  v_requeued integer := 0;
  v_removed integer := 0;
  v_restored integer := 0;
  v_ids uuid[];
  v_job uuid;
  r record;
begin
  v_cfg := authz.require_manageable_intake();
  if p_category_ids is null or cardinality(p_category_ids) not between 1 and 50
     or array_position(p_category_ids, null) is not null or not (0 <= all (p_category_ids)) then
    raise exception 'choose at least one pipeline' using errcode = '22023';
  end if;
  if p_stage_ids is null or cardinality(p_stage_ids) not between 1 and 50
     or array_position(p_stage_ids, null) is not null
     or exists (select 1 from unnest(p_stage_ids) s where s !~ '^[A-Za-z0-9_:.-]{1,50}$') then
    raise exception 'choose at least one stage' using errcode = '22023';
  end if;
  if p_cutoff_at is null or p_cutoff_at > now() or p_cutoff_at < now() - interval '10 years' then
    raise exception 'the start date must be in the past' using errcode = '22023';
  end if;
  if p_sync_enabled is null then
    raise exception 'invalid sync switch' using errcode = '22023';
  end if;
  -- Sync date = 00:00 India time of that day.
  v_cutoff := authz.ist_midnight(p_cutoff_at);

  select * into v_cfg from public.integration_intake_config c where c.id = v_cfg.id for update;
  v_changed := authz.intake_categories(v_cfg) is distinct from p_category_ids
    or v_cfg.eligible_stage_ids is distinct from p_stage_ids
    or v_cfg.cutoff_at is distinct from v_cutoff;

  update public.integration_intake_config c
  set eligible_category_ids = p_category_ids, category_id = p_category_ids[1],
      eligible_stage_ids = p_stage_ids, cutoff_at = v_cutoff,
      updated_at = now(), updated_by = auth.uid()
  where c.id = v_cfg.id;

  if v_changed then
    -- Remove stored deals that no longer belong.
    for r in
      select reason, array_agg(id) ids from (
        select d.id,
               case when not (d.source_category_id = any (p_category_ids)) then 'pipeline_not_eligible'
                    when d.source_created_at < v_cutoff then 'before_sync_date'
                    else 'stage_not_eligible' end reason
        from public.deals d
        where d.source_system = 'bitrix' and d.source_portal = v_cfg.portal_member_id and d.removed_at is null
          and (not (d.source_category_id = any (p_category_ids))
               or d.source_created_at < v_cutoff
               -- a stage the admin just unticked (deals already in other stages stay)
               or (d.source_stage_id = any (v_cfg.eligible_stage_ids) and not (d.source_stage_id = any (p_stage_ids))))
        for update of d
      ) x group by reason
    loop
      v_removed := v_removed + authz.remove_bitrix_deals(r.ids, r.reason);
    end loop;

    -- Restore removed deals that belong again: owner mapping re-applied,
    -- then a fresh crm.deal.get (inbox row) confirms the current state.
    select array_agg(d.id) into v_ids from public.deals d
    where d.source_system = 'bitrix' and d.source_portal = v_cfg.portal_member_id and d.removed_at is not null
      and d.source_category_id = any (p_category_ids) and d.source_created_at >= v_cutoff
      and d.source_stage_id = any (p_stage_ids);
    if v_ids is not null then
      update public.deals d set removed_at = null, removed_reason = null where d.id = any (v_ids);
      for r in select d.id, d.source_assigned_by_id, d.source_deal_id from public.deals d where d.id = any (v_ids) loop
        perform authz.set_deal_owner(r.id,
          authz.bitrix_owner_for(v_cfg.portal_member_id, v_cfg.pilot_legal_entity_id, r.source_assigned_by_id));
        insert into public.integration_inbox (portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, origin)
        select v_cfg.portal_member_id, 'RECONCILE', r.source_deal_id, extract(epoch from now())::bigint,
          authz.intake_dedupe_key(v_cfg.portal_member_id, 'RESTORE:' || gen_random_uuid()::text, r.source_deal_id, 0),
          'manual_retry'
        where not exists (select 1 from public.integration_inbox i
                          where i.portal_member_id = v_cfg.portal_member_id and i.source_deal_id = r.source_deal_id
                            and i.status in ('pending', 'processing', 'failed'));
      end loop;
      v_restored := cardinality(v_ids);
      perform authz.touch_deal_list(v_cfg.pilot_legal_entity_id, 0, v_restored);
    end if;

    -- Deals skipped before are evaluated again.
    update public.integration_inbox i
    set status = 'pending', attempts = 0, next_attempt_at = now(), reason_code = null,
        origin = 'manual_retry', updated_at = now()
    where i.portal_member_id = v_cfg.portal_member_id and i.status = 'ignored'
      and i.reason_code in ('not_eligible_category', 'not_eligible_stage', 'before_cutoff');
    get diagnostics v_requeued = row_count;

    -- Full resync with the new filter (the 30 s scheduler runs it to the end).
    update public.integration_resync_jobs j set status = 'superseded', lock_token = null, locked_until = null
    where j.portal_member_id = v_cfg.portal_member_id and j.status in ('queued', 'running');
    v_job := authz.queue_resync(v_cfg.portal_member_id, 'settings_changed', auth.uid());
  end if;

  update public.integration_sync_schedule s set enabled = p_sync_enabled, updated_at = now() where s.id;

  perform authz.write_audit('integration.settings_updated', v_cfg.pilot_legal_entity_id, null,
    'integration_intake_config', v_cfg.id, null,
    jsonb_build_object('categoryIds', p_category_ids, 'stageCount', cardinality(p_stage_ids),
      'cutoffAt', v_cutoff, 'previousCutoffAt', v_cfg.cutoff_at, 'syncEnabled', p_sync_enabled,
      'requeued', v_requeued, 'removed', v_removed, 'restored', v_restored, 'resyncJobId', v_job));
  return jsonb_build_object('requeued', v_requeued, 'removed', v_removed, 'restored', v_restored,
    'resyncQueued', v_job is not null, 'cutoffAt', v_cutoff);
end;
$$;

-- ---------------------------------------------------------------------------
-- Apply (replaces 20261007000100; same signature, same inbox semantics)
-- ---------------------------------------------------------------------------

create or replace function public.integration_apply_bitrix_deal(p_inbox_id uuid, p_lock_token uuid, p_deal jsonb)
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
  v_cat_ok boolean;
  v_entry_reason text;
  v_remove_reason text;
  v_restore boolean := false;
  v_keep_removed boolean := false;
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

    -- Entry rule: ticked pipeline, ticked stage, CREATED on/after the sync date
    -- (00:00 IST). The first failing check names the reason.
    v_cat_ok := v_category = any (authz.intake_categories(v_cfg));
    v_entry_reason := case
      when not v_cat_ok then 'not_eligible_category'
      when not (v_stage = any (v_cfg.eligible_stage_ids)) then 'not_eligible_stage'
      when v_created < v_cfg.cutoff_at then 'before_cutoff'
    end;

    select * into v_existing from public.deals d
    where d.source_system = 'bitrix' and d.source_portal = v_cfg.portal_member_id
      and d.source_deal_id = v_inbox.source_deal_id
    for update;

    if v_existing.id is null then
      if v_entry_reason is not null then
        v_outcome := 'ignored'; v_reason := v_entry_reason;
        exit checks;
      end if;
      v_owner := authz.bitrix_owner_for(v_cfg.portal_member_id, v_cfg.pilot_legal_entity_id, v_assigned);
      begin
        insert into public.deals
          (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic,
           source_system, source_portal, source_deal_id, source_stage_id, source_category_id,
           source_created_at, source_modified_at, last_synced_at, last_verified_at, intake_inbox_id,
           source_assigned_by_id)
        values
          (v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'BX-' || v_inbox.source_deal_id::text,
           v_title, v_owner, false,
           'bitrix', v_cfg.portal_member_id, v_inbox.source_deal_id, v_stage, v_category,
           v_created, v_modified, now(), now(), v_inbox.id, v_assigned)
        on conflict on constraint deals_source_identity_unique do nothing
        returning id into v_deal_id;
      exception when unique_violation then
        get stacked diagnostics v_constraint = constraint_name;
        if v_constraint is distinct from 'deals_legal_entity_id_reference_key' then
          raise;
        end if;
        v_ref_conflict := true;
      end;
      if v_deal_id is not null then
        perform authz.set_deal_owner(v_deal_id, v_owner);
        v_outcome := 'created';
        exit checks;
      end if;
      -- Lost a concurrent insert (or a reference conflict): continue as an update.
      select * into v_existing from public.deals d
      where d.source_system = 'bitrix' and d.source_portal = v_cfg.portal_member_id
        and d.source_deal_id = v_inbox.source_deal_id
      for update;
      if v_existing.id is null then
        v_outcome := 'needs_review'; v_reason := 'reference_conflict';
        exit checks;
      end if;
    end if;

    if v_modified < v_existing.source_modified_at then
      v_outcome := 'stale_ignored'; v_reason := 'stale_ignored'; v_deal_id := v_existing.id;
      exit checks;
    end if;

    -- Stored deal: pipelines and the sync date always apply; stages only at
    -- entry (a stored deal follows later stage moves). A removed deal comes
    -- back only when it passes the full entry rule again.
    if v_existing.removed_at is null then
      v_remove_reason := case
        when not v_cat_ok then 'pipeline_not_eligible'
        when v_created < v_cfg.cutoff_at then 'before_sync_date'
      end;
    elsif v_entry_reason is null then
      v_restore := true;
    else
      v_keep_removed := true;
    end if;
    v_owner := case when v_remove_reason is not null or v_keep_removed then null
                    else authz.bitrix_owner_for(v_cfg.portal_member_id, v_cfg.pilot_legal_entity_id, v_assigned) end;

    -- Equal version and identical Bitrix-owned content: nothing to change.
    if v_modified = v_existing.source_modified_at
       and v_existing.title = v_title and v_existing.source_stage_id = v_stage
       and v_existing.source_category_id = v_category
       and v_existing.source_created_at = v_created
       and v_existing.source_assigned_by_id is not distinct from v_assigned
       and v_existing.owner_user_id is not distinct from v_owner
       and v_remove_reason is null and not v_restore then
      if v_keep_removed then
        v_outcome := 'ignored'; v_reason := v_entry_reason; v_deal_id := v_existing.id;
      else
        v_outcome := 'stale_ignored'; v_reason := 'stale_ignored'; v_deal_id := v_existing.id;
      end if;
      exit checks;
    end if;

    -- Bitrix-owned header fields (kept current for removed deals too).
    update public.deals d
    set title = v_title,
        source_stage_id = v_stage,
        source_category_id = v_category,
        source_created_at = v_created,
        source_modified_at = v_modified,
        source_assigned_by_id = v_assigned,
        last_synced_at = now(),
        last_verified_at = now(),
        intake_inbox_id = v_inbox.id
    where d.id = v_existing.id;
    v_deal_id := v_existing.id;

    if v_keep_removed then
      v_outcome := 'ignored'; v_reason := v_entry_reason;
      exit checks;
    end if;
    if v_remove_reason is not null then
      perform authz.remove_bitrix_deals(array[v_existing.id], v_remove_reason);
      perform authz.write_audit('integration.deal_removed', v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id,
        'deal', v_existing.id, null, jsonb_build_object('inboxId', v_inbox.id, 'reason', v_remove_reason));
      v_outcome := 'updated';
      exit checks;
    end if;
    if v_restore then
      update public.deals d set removed_at = null, removed_reason = null where d.id = v_existing.id;
      perform authz.touch_deal_list(v_cfg.pilot_legal_entity_id, 0, 1);
      perform authz.write_audit('integration.deal_restored', v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id,
        'deal', v_existing.id, null, jsonb_build_object('inboxId', v_inbox.id));
    end if;
    v_owner_changed := v_existing.owner_user_id is distinct from v_owner;
    perform authz.set_deal_owner(v_existing.id, v_owner);
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
        'waitingForOwner', v_owner is null));
  elsif v_outcome = 'needs_review' then
    perform authz.write_audit('integration.deal_needs_review',
      v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'integration_inbox', v_inbox.id, null,
      jsonb_build_object('inboxId', v_inbox.id, 'origin', v_inbox.origin, 'reasonCode', v_reason));
  end if;

  return jsonb_build_object('outcome', v_outcome, 'dealId', v_deal_id, 'reasonCode', v_reason);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function
  authz.ist_midnight(timestamptz),
  authz.queue_resync(text, text, uuid),
  authz.require_resync_lease(uuid, uuid),
  public.integration_queue_resync(text),
  public.integration_resync_next(text, integer),
  public.integration_resync_page(uuid, uuid, jsonb, integer, boolean),
  public.integration_resync_finish(uuid, uuid),
  public.integration_resync_release(uuid, uuid)
from public, anon, authenticated, service_role;
grant execute on function
  public.integration_queue_resync(text),
  public.integration_resync_next(text, integer),
  public.integration_resync_page(uuid, uuid, jsonb, integer, boolean),
  public.integration_resync_finish(uuid, uuid),
  public.integration_resync_release(uuid, uuid)
to service_role;

-- ===========================================================================
-- Section 7 of 10: main 20261009000700_apply_current_sync_settings.sql (was 20261008000300)
-- Stage 0 corrections: the one-time step queues a resync only when it removed Deals; audit names this migration.
-- ===========================================================================

-- TripNavigate CRM - one-time: apply the CURRENT sync settings to deals stored
-- before 20261008000200 (until then a settings change never touched stored
-- deals, so a database can hold deals created before its sync date or in an
-- unticked pipeline).
--
-- For every intake config: the sync date is normalised to 00:00 IST, stored
-- Bitrix deals created before it or in an unticked pipeline are soft-removed
-- (authz.remove_bitrix_deals: owner cleared, assignments ended), one audit
-- event per portal (counts only), and a full resync job is queued so the
-- count check runs. Stages are entry-only, so the stage list removes nothing
-- here. Idempotent: already removed deals are not touched again.
-- Stage 0 corrections: removal records the Deal's participants first
-- (deal_removal_participants), and a resync is queued only when Deals were
-- removed (with none removed the scheduler's daily job covers the count check
-- once sync is switched on).
--
-- Rollback (forward-only): restore via the settings page (moving the date
-- earlier restores removed deals). Never delete deals or audit rows.


do $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_cutoff timestamptz;
  v_by_date uuid[];
  v_by_pipeline uuid[];
  v_removed integer;
begin
  for v_cfg in select * from public.integration_intake_config c order by c.portal_member_id loop
    v_cutoff := authz.ist_midnight(v_cfg.cutoff_at);
    if v_cutoff is distinct from v_cfg.cutoff_at then
      update public.integration_intake_config c set cutoff_at = v_cutoff, updated_at = now() where c.id = v_cfg.id;
    end if;

    select array_agg(d.id) filter (where not (d.source_category_id = any (authz.intake_categories(v_cfg)))),
           array_agg(d.id) filter (where d.source_category_id = any (authz.intake_categories(v_cfg))
                                     and d.source_created_at < v_cutoff)
      into v_by_pipeline, v_by_date
    from public.deals d
    where d.source_system = 'bitrix' and d.source_portal = v_cfg.portal_member_id and d.removed_at is null;

    v_removed := coalesce(authz.remove_bitrix_deals(v_by_pipeline, 'pipeline_not_eligible'), 0)
               + coalesce(authz.remove_bitrix_deals(v_by_date, 'before_sync_date'), 0);

    perform authz.write_audit('integration.settings_applied_to_stored_deals', v_cfg.pilot_legal_entity_id, null,
      'integration_intake_config', v_cfg.id, null,
      jsonb_build_object('cutoffAt', v_cutoff, 'removed', v_removed, 'migration', '20261107000100'));
    if v_removed > 0 then
      perform authz.queue_resync(v_cfg.portal_member_id, 'settings_changed', null);
    end if;
  end loop;
end;
$$;

-- ===========================================================================
-- Section 8 of 10: main 20261009000800_deal_id_order.sql (was 20261008000400)
-- Stage 0 corrections: none.
-- ===========================================================================

-- TripNavigate CRM - deals ordered by Bitrix deal ID (owner request 5 Oct 2026).
--
-- source_deal_id is already bigint (20261003000100), so ordering is numeric
-- (999 before 1000). This migration only adds:
--   * an index matching the list order (source_deal_id desc, id) so the Deals
--     page sorts without a full scan as the table grows;
--   * deal-ID order as the tiebreak when the worker claims inbox rows. A resync
--     page enqueues up to 50 rows in one transaction (same next_attempt_at and
--     received_at), so their processing order was arbitrary. Due time still
--     comes first, so retries and back-off behave exactly as before.
--
-- Rollback (forward-only): drop the index; restore the previous
-- integration_claim_inbox body (20261003000100).


create index deals_source_deal_id_order_idx on public.deals (source_deal_id desc nulls last, id);

create or replace function public.integration_claim_inbox(p_limit integer, p_lease_seconds integer)
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
    order by coalesce(i.next_attempt_at, i.received_at), i.received_at, i.source_deal_id
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

-- ===========================================================================
-- Section 9 of 10: main 20261009000900_auto_sync_health.sql (was 20261008000500)
-- Stage 0 corrections: no cleanup job is scheduled (see the scheduler provisioning at the end).
-- ===========================================================================

-- TripNavigate CRM - the automatic sync can no longer stop silently
-- (docs/implementation/audits/auto-sync-stopped.md).
--
-- Root cause on 5 Oct 2026: another process answered the scheduler on port
-- 3000 with HTTP 401 for 30 minutes. The app's heartbeat
-- (integration_worker_runs) is written only after authentication, so nothing
-- recorded the failures.
--
--   * integration_sync_dispatches: one row per scheduled call (pg_net request
--     id, time), completed on the next tick from net._http_response with the
--     HTTP status and a short plain-language reason (no secrets, no URLs).
--   * authz.run_scheduled_bitrix_sync(): settles earlier calls first, then
--     dispatches as before (same pause switch and overlap guard).
--   * public.integration_auto_sync_status(): admin-only summary (cron job
--     present/active, schedule, last calls), because cron/net are not exposed
--     to the Data API.
--   * Daily cleanup of dispatch rows older than 14 days (Stage 0: job created
--     PAUSED only by authz.provision_bitrix_sync_jobs(), never by a migration).
--
-- Rollback (forward-only): restore the previous run_scheduled_bitrix_sync
-- body (20261006000100), drop the table, function and cleanup job.


create table public.integration_sync_dispatches (
  request_id bigint primary key,
  dispatched_at timestamptz not null default now(),
  answered_at timestamptz,
  status_code integer,
  ok boolean,
  -- Plain language, built here from the status (never the response body text).
  reason text check (length(reason) <= 300)
);
create index integration_sync_dispatches_time_idx on public.integration_sync_dispatches (dispatched_at desc);
comment on table public.integration_sync_dispatches is
  'Every scheduled Bitrix sync call and its outcome (status + plain reason). Counts/codes only.';

alter table public.integration_sync_dispatches enable row level security;
revoke all on public.integration_sync_dispatches from public, anon, authenticated, service_role;
grant select on public.integration_sync_dispatches to authenticated, service_role;
create policy require_valid_session on public.integration_sync_dispatches as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
create policy integration_admin_read on public.integration_sync_dispatches
  for select to authenticated using ((select authz.can_admin_any('integration.manage')));

-- Plain-language reason for one scheduler call (null = success).
create function authz.sync_dispatch_reason(p_status integer, p_timed_out boolean, p_error text, p_code text)
returns text
language sql immutable set search_path = '' as $$
  select case
    when p_timed_out then 'The CRM did not answer within 90 seconds.'
    when p_status is null and p_error is not null then
      'The CRM could not be reached (is the CRM server running on port 3000?).'
    when p_status between 200 and 299 then null
    when p_status = 401 then
      'The CRM refused the scheduler''s secret (HTTP 401): the secret in Vault does not match INTAKE_WORKER_SECRET, or another program answers on port 3000.'
    when p_status = 503 then
      'The CRM could not sync (HTTP 503' || coalesce(', ' || p_code, '') || '): intake not configured or Bitrix not readable.'
    when p_status = 404 then 'The scheduler URL is wrong (HTTP 404).'
    when p_status >= 500 then 'The CRM failed while syncing (HTTP ' || p_status || '); see the CRM server log.'
    else 'Unexpected answer from the CRM (HTTP ' || coalesce(p_status::text, '?') || ').'
  end
$$;

-- JSON error code of a response body, or null (never raises on odd bodies).
create function authz.response_error_code(p_body text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  if p_body is null or p_body !~ '^\s*\{' then
    return null;
  end if;
  return left(coalesce(p_body::jsonb ->> 'error', p_body::jsonb ->> 'reconcileError'), 40);
exception when others then
  return null;
end;
$$;

-- Completes earlier calls from pg_net's response table. Calls without an
-- answer after 3 minutes (or whose response was already purged) count as failed.
create function authz.settle_sync_dispatches() returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n integer := 0;
  v_m integer := 0;
begin
  if to_regclass('net._http_response') is not null then
    execute $q$
      update public.integration_sync_dispatches d
      set answered_at = r.created,
          status_code = r.status_code,
          ok = coalesce(r.status_code between 200 and 299, false) and not coalesce(r.timed_out, false),
          reason = authz.sync_dispatch_reason(r.status_code, coalesce(r.timed_out, false), r.error_msg,
            authz.response_error_code(r.content))
      from net._http_response r
      where r.id = d.request_id and d.answered_at is null
    $q$;
    get diagnostics v_n = row_count;
  end if;
  update public.integration_sync_dispatches d
  set answered_at = now(), ok = false, reason = 'No answer from the CRM within 3 minutes.'
  where d.answered_at is null and d.dispatched_at < now() - interval '3 minutes';
  get diagnostics v_m = row_count;
  return v_n + v_m;
end;
$$;

-- Cron entry point (replaces 20261006000100): settle earlier calls, then the
-- same pause switch, overlap guard and dispatch as before; record the call.
create or replace function authz.run_scheduled_bitrix_sync() returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_schedule public.integration_sync_schedule%rowtype;
  v_id bigint;
begin
  perform authz.settle_sync_dispatches();
  select * into v_schedule from public.integration_sync_schedule s where s.id for update skip locked;
  if v_schedule.id is null or not v_schedule.enabled then
    return;
  end if;
  if v_schedule.last_request_id is not null
     and v_schedule.last_dispatched_at > now() - interval '2 minutes'
     and not exists (select 1 from net._http_response r where r.id = v_schedule.last_request_id) then
    return;
  end if;
  v_id := authz.dispatch_bitrix_sync();
  if v_id is not null then
    update public.integration_sync_schedule s
    set last_request_id = v_id, last_dispatched_at = now()
    where s.id;
    insert into public.integration_sync_dispatches (request_id) values (v_id) on conflict do nothing;
  end if;
end;
$$;

-- Admin-only: cron job state and the last scheduler calls (no URL, no secret).
create function public.integration_auto_sync_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_job jsonb := null;
begin
  if not authz.can_admin_any('integration.manage') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if to_regclass('cron.job') is not null then
    execute $q$select jsonb_build_object('schedule', j.schedule, 'active', j.active)
               from cron.job j where j.jobname = 'bitrix-sync'$q$ into v_job;
  end if;
  return jsonb_build_object(
    'cronInstalled', to_regclass('cron.job') is not null,
    'job', v_job,
    'enabled', (select s.enabled from public.integration_sync_schedule s where s.id),
    'lastCalls', coalesce((
      select jsonb_agg(jsonb_build_object('at', d.dispatched_at, 'answeredAt', d.answered_at,
               'statusCode', d.status_code, 'ok', d.ok, 'reason', d.reason) order by d.dispatched_at desc)
      from (select * from public.integration_sync_dispatches order by dispatched_at desc limit 5) d), '[]'::jsonb),
    'lastOkCallAt', (select max(d.dispatched_at) from public.integration_sync_dispatches d where d.ok),
    'failingSince', (select min(d.dispatched_at) from public.integration_sync_dispatches d
                     where d.ok = false and d.dispatched_at > coalesce(
                       (select max(x.dispatched_at) from public.integration_sync_dispatches x where x.ok), '-infinity')));
end;
$$;

revoke all on function
  authz.sync_dispatch_reason(integer, boolean, text, text),
  authz.response_error_code(text),
  authz.settle_sync_dispatches(),
  authz.run_scheduled_bitrix_sync(),
  public.integration_auto_sync_status()
from public, anon, authenticated, service_role;
grant execute on function public.integration_auto_sync_status() to authenticated;

-- Stage 0 correction: the dispatch cleanup job is not scheduled here; see
-- authz.provision_bitrix_sync_jobs() at the end of this migration.

-- ===========================================================================
-- Section 10 of 10: main 20261009001000_restore_manifest_intake_guards.sql (was PR #13 review fix 1)
-- Stage 0 corrections: intake_owner_issue uses the Sales-owner rule (I01).
-- ===========================================================================

-- PR #13 review fix 1: restore main's intake guards on top of the restored Bitrix work.
--
-- The local-bitrix-live migrations (renumbered 20261009000100-0900 so they no longer
-- share versions with main's 20261006000100 / 20261007000100 / 20261007000200) replace
-- several of main's Phase 5/6 definitions. Computed by loading main's migration set and
-- the merged set into PGlite and diffing every function, policy and check constraint:
--
--   integration_apply_bitrix_deal  Bitrix body kept (soft removal and restore, owner
--     provenance via source_assigned_by_id, several pipelines, set_deal_owner) and main's
--     guards restored: the Deal-only object check, FOR SHARE config lock with
--     intake_portal_allowed (environment isolation), the manifest gate under a FOR SHARE
--     manifest lock (not_in_manifest), outside_manifest_scope, the scope_changed hold, and
--     needs_review for an unmapped owner or one outside the pilot branch (no guessed or
--     missing owner).
--   integration_claim_inbox  main's version (staging / unset refusal, intake_portal_allowed
--     filter, sourceObject and sourceId keys) with the Bitrix deal-ID tie-break.
--   role_permissions  the Bitrix row super_admin / deal.read / entity is removed: the access
--     matrix (03-access-matrix.md) gives Super Admin no deal visibility (AUDIT-007).
--   integration_resync_page  a manifest refusal is no longer counted as enqueued (AUDIT-020).
--   authz.can_read_purchase_task  Purchase no longer sees tasks of soft-removed deals (AUDIT-019).
--   integration_resync_seen  gets the restrictive require_valid_session policy every table
--     has (AUDIT-025).
--
-- can_read_deal, require_entity_member and the four rewritten read policies keep their
-- Bitrix versions: they are equivalent rewrites (performance, nullable owner) plus the
-- soft-removal filter, and do not widen access. Forward-only; no existing migration edited.


delete from public.role_permissions
where role_code = 'super_admin' and permission_code = 'deal.read' and scope = 'entity';

create or replace function authz.intake_owner_issue(p_cfg public.integration_intake_config, p_bitrix_user bigint)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  -- main's owner rule (20261007000200): an active mapping to active staff.
  -- Stage 0 (I01): the owner must also be eligible under the Sales-owner rule
  -- (authz.is_eligible_deal_owner: active Sales membership in the pilot branch).
  -- Null = the owner is usable.
  select case
    when not exists (
      select 1 from public.bitrix_user_mappings bm
      join public.staff_profiles p on p.user_id = bm.staff_user_id and p.status = 'active'
      where bm.portal_member_id = p_cfg.portal_member_id and bm.bitrix_user_id = p_bitrix_user and bm.active
    ) then 'unmapped_owner'
    when not exists (
      select 1 from public.bitrix_user_mappings bm
      where bm.portal_member_id = p_cfg.portal_member_id and bm.bitrix_user_id = p_bitrix_user and bm.active
        and authz.is_eligible_deal_owner(bm.staff_user_id, p_cfg.pilot_legal_entity_id, p_cfg.pilot_branch_id)
    ) then 'owner_not_in_pilot_branch'
  end
$$;

revoke all on function authz.intake_owner_issue(public.integration_intake_config, bigint) from public;

CREATE OR REPLACE FUNCTION public.integration_apply_bitrix_deal(p_inbox_id uuid, p_lock_token uuid, p_deal jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
  v_cat_ok boolean;
  v_entry_reason text;
  v_remove_reason text;
  v_restore boolean := false;
  v_keep_removed boolean := false;
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
    where c.portal_member_id = v_inbox.portal_member_id and c.enabled for share;
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

    -- Entry rule: ticked pipeline, ticked stage, CREATED on/after the sync date
    -- (00:00 IST). The first failing check names the reason.
    v_cat_ok := v_category = any (authz.intake_categories(v_cfg));
    v_entry_reason := case
      when not v_cat_ok then 'not_eligible_category'
      when not (v_stage = any (v_cfg.eligible_stage_ids)) then 'not_eligible_stage'
      when v_created < v_cfg.cutoff_at then 'before_cutoff'
    end;

    select * into v_existing from public.deals d
    where d.source_system = 'bitrix' and d.source_portal = v_cfg.portal_member_id
      and d.source_deal_id = v_inbox.source_deal_id
    for update;
    -- A config change does not transfer an existing CRM record across a
    -- branch or legal entity. Hold the snapshot for an explicit transfer.
    if v_existing.id is not null and (
      v_existing.legal_entity_id is distinct from v_cfg.pilot_legal_entity_id
      or v_existing.branch_id is distinct from v_cfg.pilot_branch_id
    ) then
      v_outcome := 'needs_review'; v_reason := 'scope_changed';
      exit checks;
    end if;

    if v_existing.id is null then
      if v_entry_reason is not null then
        v_outcome := 'ignored'; v_reason := v_entry_reason;
        exit checks;
      end if;
      -- No guessed owner: the Bitrix responsible must map to active staff in the pilot branch.
      v_reason := authz.intake_owner_issue(v_cfg, v_assigned);
      if v_reason is not null then
        v_outcome := 'needs_review';
        exit checks;
      end if;
      v_owner := authz.bitrix_owner_for(v_cfg.portal_member_id, v_cfg.pilot_legal_entity_id, v_assigned);
      begin
        insert into public.deals
          (legal_entity_id, branch_id, reference, title, owner_user_id, is_synthetic,
           source_system, source_portal, source_deal_id, source_stage_id, source_category_id,
           source_created_at, source_modified_at, last_synced_at, last_verified_at, intake_inbox_id,
           source_assigned_by_id)
        values
          (v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'BX-' || v_inbox.source_deal_id::text,
           v_title, v_owner, false,
           'bitrix', v_cfg.portal_member_id, v_inbox.source_deal_id, v_stage, v_category,
           v_created, v_modified, now(), now(), v_inbox.id, v_assigned)
        on conflict on constraint deals_source_identity_unique do nothing
        returning id into v_deal_id;
      exception when unique_violation then
        get stacked diagnostics v_constraint = constraint_name;
        if v_constraint is distinct from 'deals_legal_entity_id_reference_key' then
          raise;
        end if;
        v_ref_conflict := true;
      end;
      if v_deal_id is not null then
        perform authz.set_deal_owner(v_deal_id, v_owner);
        v_outcome := 'created';
        exit checks;
      end if;
      -- Lost a concurrent insert (or a reference conflict): continue as an update.
      select * into v_existing from public.deals d
      where d.source_system = 'bitrix' and d.source_portal = v_cfg.portal_member_id
        and d.source_deal_id = v_inbox.source_deal_id
      for update;
      if v_existing.id is null then
        v_outcome := 'needs_review'; v_reason := 'reference_conflict';
        exit checks;
      end if;
    end if;

    if v_modified < v_existing.source_modified_at then
      v_outcome := 'stale_ignored'; v_reason := 'stale_ignored'; v_deal_id := v_existing.id;
      exit checks;
    end if;

    -- Stored deal: pipelines and the sync date always apply; stages only at
    -- entry (a stored deal follows later stage moves). A removed deal comes
    -- back only when it passes the full entry rule again.
    if v_existing.removed_at is null then
      v_remove_reason := case
        when not v_cat_ok then 'pipeline_not_eligible'
        when v_created < v_cfg.cutoff_at then 'before_sync_date'
      end;
    elsif v_entry_reason is null then
      v_restore := true;
    else
      v_keep_removed := true;
    end if;
    -- A deal that stays (or comes back) needs a mapped owner in the pilot branch.
    if v_remove_reason is null and not v_keep_removed then
      v_reason := authz.intake_owner_issue(v_cfg, v_assigned);
      if v_reason is not null then
        v_outcome := 'needs_review';
        exit checks;
      end if;
    end if;
    v_owner := case when v_remove_reason is not null or v_keep_removed then null
                    else authz.bitrix_owner_for(v_cfg.portal_member_id, v_cfg.pilot_legal_entity_id, v_assigned) end;

    -- Equal version and identical Bitrix-owned content: nothing to change.
    if v_modified = v_existing.source_modified_at
       and v_existing.title = v_title and v_existing.source_stage_id = v_stage
       and v_existing.source_category_id = v_category
       and v_existing.source_created_at = v_created
       and v_existing.source_assigned_by_id is not distinct from v_assigned
       and v_existing.owner_user_id is not distinct from v_owner
       and v_remove_reason is null and not v_restore then
      if v_keep_removed then
        v_outcome := 'ignored'; v_reason := v_entry_reason; v_deal_id := v_existing.id;
      else
        v_outcome := 'stale_ignored'; v_reason := 'stale_ignored'; v_deal_id := v_existing.id;
      end if;
      exit checks;
    end if;

    -- Bitrix-owned header fields (kept current for removed deals too).
    update public.deals d
    set title = v_title,
        source_stage_id = v_stage,
        source_category_id = v_category,
        source_created_at = v_created,
        source_modified_at = v_modified,
        source_assigned_by_id = v_assigned,
        last_synced_at = now(),
        last_verified_at = now(),
        intake_inbox_id = v_inbox.id
    where d.id = v_existing.id;
    v_deal_id := v_existing.id;

    if v_keep_removed then
      v_outcome := 'ignored'; v_reason := v_entry_reason;
      exit checks;
    end if;
    if v_remove_reason is not null then
      perform authz.remove_bitrix_deals(array[v_existing.id], v_remove_reason);
      perform authz.write_audit('integration.deal_removed', v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id,
        'deal', v_existing.id, null, jsonb_build_object('inboxId', v_inbox.id, 'reason', v_remove_reason));
      v_outcome := 'updated';
      exit checks;
    end if;
    if v_restore then
      update public.deals d set removed_at = null, removed_reason = null where d.id = v_existing.id;
      perform authz.touch_deal_list(v_cfg.pilot_legal_entity_id, 0, 1);
      perform authz.write_audit('integration.deal_restored', v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id,
        'deal', v_existing.id, null, jsonb_build_object('inboxId', v_inbox.id));
    end if;
    v_owner_changed := v_existing.owner_user_id is distinct from v_owner;
    perform authz.set_deal_owner(v_existing.id, v_owner);
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
        'manifestId', v_manifest.id, 'waitingForOwner', v_owner is null));
  elsif v_outcome = 'needs_review' then
    perform authz.write_audit('integration.deal_needs_review',
      v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'integration_inbox', v_inbox.id, null,
      jsonb_build_object('inboxId', v_inbox.id, 'origin', v_inbox.origin, 'reasonCode', v_reason));
  end if;

  return jsonb_build_object('outcome', v_outcome, 'dealId', v_deal_id, 'reasonCode', v_reason);
end;
$function$;

CREATE OR REPLACE FUNCTION public.integration_claim_inbox(p_limit integer, p_lease_seconds integer)
 RETURNS SETOF jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
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
    order by coalesce(i.next_attempt_at, i.received_at), i.received_at, i.source_deal_id
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
$function$;

CREATE OR REPLACE FUNCTION public.integration_resync_page(p_job uuid, p_token uuid, p_deals jsonb, p_total integer, p_last boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_job public.integration_resync_jobs%rowtype;
  v_item jsonb;
  v_id bigint;
  v_max bigint;
  v_enqueued integer := 0;
  v_n integer := 0;
  v_res jsonb;
begin
  v_job := authz.require_resync_lease(p_job, p_token);
  if p_deals is null or jsonb_typeof(p_deals) <> 'array' or jsonb_array_length(p_deals) > 500 or p_last is null then
    raise exception 'invalid resync page' using errcode = '22023';
  end if;
  v_max := v_job.cursor_id;
  for v_item in select * from jsonb_array_elements(p_deals) loop
    v_id := (v_item ->> 'id')::bigint;
    if v_id is null or v_id <= v_job.cursor_id then
      raise exception 'resync page out of order' using errcode = '22023';
    end if;
    insert into public.integration_resync_seen (job_id, source_deal_id) values (v_job.id, v_id)
    on conflict do nothing;
    v_res := public.integration_enqueue_reconcile(v_job.portal_member_id, v_id, (v_item ->> 'modified')::bigint);
    -- Only a new queue row counts; a manifest refusal (ignored) or a duplicate is not progress.
    if not coalesce((v_res ->> 'duplicate')::boolean, false) and not coalesce((v_res ->> 'ignored')::boolean, false) then
      v_enqueued := v_enqueued + 1;
    end if;
    v_max := greatest(v_max, v_id);
    v_n := v_n + 1;
  end loop;
  update public.integration_resync_jobs j
  set cursor_id = v_max, scanned = j.scanned + v_n, enqueued = j.enqueued + v_enqueued,
      bitrix_total = coalesce(j.bitrix_total, case when v_job.cursor_id = 0 then p_total end),
      listing_done = p_last,
      locked_until = greatest(j.locked_until, now() + interval '60 seconds')
  where j.id = v_job.id;
  return jsonb_build_object('enqueued', v_enqueued, 'scanned', v_job.scanned + v_n, 'cursorId', v_max);
end;
$function$;

CREATE OR REPLACE FUNCTION authz.can_read_purchase_task(p_task uuid)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select authz.session_ok() and exists (
    select 1 from public.fulfilment_tasks t
    join public.deals d on d.id = t.deal_id and d.removed_at is null
    where t.id = p_task
      and (
        authz.holds_active_role('purchase', t.legal_entity_id)
        or (authz.can_read_deal(t.deal_id) and not authz.holds_role('purchase', t.legal_entity_id))
      )
  )
$function$;

create policy require_valid_session on public.integration_resync_seen as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));

-- ===========================================================================
-- Stage 0 additions
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Scheduler provisioning: an approved operator step, never automatic
-- ---------------------------------------------------------------------------
--
-- No migration installs pg_cron / pg_net or schedules a job (the hosted
-- database has neither extension). This creates the three jobs of sections 1
-- and 9 PAUSED (cron.job.active = false, set in the same transaction, so a
-- job is never visible to the scheduler as active). A job that already exists
-- under the same name is left exactly as it is. Requires pg_cron; owner only.
-- Returns [{jobname, schedule, active}] for the bitrix-sync* jobs.
--
-- Operator sequence; each step needs the owner's approval for the exact database:
--   1. create extension if not exists pg_cron;
--      create extension if not exists pg_net with schema extensions;
--   2. select authz.provision_bitrix_sync_jobs();            -- jobs exist, paused
--   3. Vault values: supabase/snippets/local-bitrix-schedule.sql, step 1
--   4. select cron.alter_job(j.jobid, active := true) from cron.job j
--      where j.jobname like 'bitrix-sync%';
--   5. update public.integration_sync_schedule set enabled = true, updated_at = now() where id;
-- Pause again with step 5 (enabled = false) or cron.alter_job(..., active := false).
create function authz.provision_bitrix_sync_jobs() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_jobs constant text[][] := array[
    array['bitrix-sync', '30 seconds', 'select authz.run_scheduled_bitrix_sync()'],
    array['bitrix-sync-heartbeat-cleanup', '17 3 * * *',
      $job$delete from public.integration_worker_runs where finished_at < now() - interval '14 days'$job$],
    array['bitrix-sync-dispatch-cleanup', '23 3 * * *',
      $job$delete from public.integration_sync_dispatches where dispatched_at < now() - interval '14 days'$job$]
  ];
  v_id bigint;
  v_result jsonb;
  i integer;
begin
  if to_regclass('cron.job') is null then
    raise exception 'pg_cron is not installed' using errcode = '55000';
  end if;
  for i in 1 .. array_length(v_jobs, 1) loop
    v_id := null;
    execute 'select j.jobid from cron.job j where j.jobname = $1' into v_id using v_jobs[i][1];
    if v_id is null then
      execute 'select cron.schedule($1, $2, $3)' into v_id using v_jobs[i][1], v_jobs[i][2], v_jobs[i][3];
      execute 'select cron.alter_job($1, active := false)' using v_id;
    end if;
  end loop;
  execute $q$
    select coalesce(jsonb_agg(jsonb_build_object('jobname', j.jobname, 'schedule', j.schedule, 'active', j.active)
                              order by j.jobname), '[]'::jsonb)
    from cron.job j where j.jobname like 'bitrix-sync%'
  $q$ into v_result;
  return v_result;
end;
$$;

revoke all on function authz.provision_bitrix_sync_jobs() from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Deals waiting for an owner stay visible to the integration admin (I01)
-- ---------------------------------------------------------------------------
--
-- A Bitrix responsible who does not map to an eligible Sales owner never gets
-- a guessed owner: a new Deal is held in the inbox (needs_review), a stored
-- Deal waits with no owner. The access matrix gives Super Admin no Deal
-- visibility (section 10), so RLS hides the waiting Deals from them; this
-- admin-only summary shows counts per Bitrix responsible (no Deal content).
-- Removed Deals are not counted. Returns {total, byBitrixUser: [{bitrixUserId, deals}]}.
create function public.integration_waiting_for_owner() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
begin
  v_cfg := authz.require_manageable_intake();
  return jsonb_build_object(
    'total', (
      select count(*) from public.deals d
      where d.source_system = 'bitrix' and d.source_portal = v_cfg.portal_member_id
        and d.removed_at is null and d.owner_user_id is null),
    'byBitrixUser', coalesce((
      select jsonb_agg(jsonb_build_object('bitrixUserId', x.source_assigned_by_id, 'deals', x.n)
                       order by x.n desc, x.source_assigned_by_id)
      from (
        select d.source_assigned_by_id, count(*) n from public.deals d
        where d.source_system = 'bitrix' and d.source_portal = v_cfg.portal_member_id
          and d.removed_at is null and d.owner_user_id is null
        group by d.source_assigned_by_id
      ) x), '[]'::jsonb));
end;
$$;

revoke all on function public.integration_waiting_for_owner() from public, anon, authenticated, service_role;
grant execute on function public.integration_waiting_for_owner() to authenticated;

commit;
