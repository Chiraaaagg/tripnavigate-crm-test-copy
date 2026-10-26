-- TripNavigate CRM - Stage 6 sync completion: live Lead intake (scope mode),
-- the Lead link on the Deal, the worker run trigger and sync-stopped incidents.
--
-- Contract: docs/implementation/next/sync-completion-contract-2026-10-08.md
-- (frozen 8 October 2026), sections 2, 3, 4 and 7. Every change below is
-- marked "Stage 6"; replaced function bodies are otherwise copied unchanged
-- from the source migration named in their section header.
--
-- What changes:
--   1. Live Lead intake (contract section 2)
--      * integration_intake_config.lead_intake_mode 'manifest' (default, today's
--        behaviour exactly) | 'scope'. Changed only through
--        integration_update_sync_settings (new last argument
--        p_lead_intake_mode text default null; null keeps the current value).
--      * Scope mode: the receiver records Lead events without a manifest
--        (authz.intake_manifest_allows), Lead reconcile enqueues without a
--        manifest, and the Lead apply accepts a Lead when the portal matches,
--        Bitrix DATE_CREATE is on/after cutoff_at (entry rule; a stored Lead keeps
--        following Bitrix) and the Bitrix responsible maps to an eligible Sales
--        member of the pilot branch (authz.bitrix_owner_for /
--        authz.is_eligible_deal_owner). Otherwise (lead decision) the inbox row
--        ends ignored / owner_not_eligible (new reason) and nothing is written:
--        a new Lead is not stored, a stored Lead stays exactly as it is (other
--        branches' Leads must not flood "needs attention"). An empty or absent
--        SOURCE_ID is stored as 'NONE'.
--      * integration_intake_config.lead_reconciled_at: the scope-mode Lead
--        list watermark (null = from the sync date), advanced only by
--        integration_record_lead_reconcile_run (same rules as the Deal
--        watermark), reset by the settings command when Lead intake switches to
--        scope or the sync date changes.
--      * crm_leads.intake_mode 'manifest' | 'scope' records the mode of the last
--        write; crm_leads.manifest_id may be null only when intake_mode = 'scope'
--        (constraint crm_leads_manifest_required). A manifest Lead later updated
--        in scope mode keeps its manifest_id.
--   1b. Deal scope mode (lead decision, 8 October 2026, night)
--      * integration_intake_config.deal_intake_mode 'manifest' (default, today's
--        behaviour exactly) | 'scope'; integration_update_sync_settings gains
--        p_deal_intake_mode text default null (null keeps the current value).
--      * Scope mode: Deal events are recorded and Deal reconcile enqueues
--        without a manifest; the Deal apply skips only the manifest membership,
--        source code and interval checks. Every other gate is unchanged
--        (portal and environment, pipeline, entry stage for new Deals, sync
--        date, Sales owner hold (I01), soft removal/restore, scope_changed,
--        stale rule).
--      * Review M1: changing either intake mode counts as a settings change
--        (full resync queued); switching an object type to scope re-queues its
--        not_in_manifest inbox rows recorded on/after the sync date (newest row
--        per record, at most 5000 records per type; counts audited/returned).
--   2. Lead link on the Deal (contract section 3)
--      * deals.source_lead_id bigint null check (> 0), written only by the Deal
--        apply from the snapshot key leadId (digits = the Lead; empty, absent,
--        JSON null or 0 = none; anything else = invalid_source_data). Every
--        non-stale apply sets the current value; a changed leadId alone is a
--        change (not stale_ignored).
--   3. Worker run trigger (contract sections 1 and 7)
--      * integration_worker_runs.run_trigger 'manual' | 'cron' | 'event' (null
--        for older rows); integration_record_worker_run accepts the optional
--        key "trigger" (it refuses unknown keys, so the live runs need it).
--   4. Sync-stopped incidents (contract sections 4 and 7)
--      * public.integration_sync_incidents: one open incident per portal;
--        append and close only (no deletes, guarded by a trigger); RLS on, no
--        API grants.
--      * public.integration_sync_alert_check() and
--        public.integration_sync_alert_mark_sent(uuid, text), service role only.
--        Review L1: each notice is handed out under a 2-minute send lease
--        (open_sending_until / recovery_sending_until), so overlapping checks
--        never return the same notice twice; marking it sent clears the lease.
--        Stopped = the admin page rule (autoSyncState in
--        src/modules/integration/auto-sync-state.ts): with the schedule switch
--        on, no successful reconcile run (ok/partial) for more than 3 x 30 s, or
--        the pg_cron job 'bitrix-sync' missing or inactive. Switch off = paused:
--        no incident is opened. The same facts as
--        public.integration_auto_sync_status().
--
-- Replaced functions (same signature unless noted):
--   authz.intake_manifest_allows(uuid, text, bigint)            from 20261007000100
--   public.integration_enqueue_reconcile_lead(text, bigint, bigint)
--                                                               from 20261007000101
--   public.integration_enqueue_reconcile(text, bigint, bigint)  from 20261007000101
--   public.integration_apply_bitrix_lead(uuid, uuid, jsonb)     from 20261007000200
--   public.intake_scope_status()                                from 20261007000200
-- New function: public.integration_record_lead_reconcile_run(text, timestamptz, boolean)
--     (review I2: adds "scopeIntake" only when a scope mode is on)
--   public.integration_update_sync_settings                     from 20261107000100 (line 1601)
--     (bigint[], text[], timestamptz, boolean) is DROPPED and re-created as
--     (bigint[], text[], timestamptz, boolean, text default null, text default null);
--     grants as before
--   public.integration_apply_bitrix_deal(uuid, uuid, jsonb)     from 20261107000100
--     (section 10, line 2373: the last definition, with the manifest gate)
--   public.integration_record_worker_run(jsonb)                 from 20261003000100
-- Constraint replaced: integration_inbox_reason_code_check (20261007000200)
-- gains 'owner_not_eligible'.
--
-- Safe whatever the database holds: no extension is installed, no cron job is
-- created, nothing calls Bitrix, nothing is deleted. Existing Leads keep
-- intake_mode 'manifest' (their manifest_id is set); existing Deals get
-- source_lead_id null until their next apply.
--
-- Stop switches: integration_update_sync_settings(..., 'manifest', 'manifest')
-- returns Lead and Deal intake to manifest mode; update public.integration_intake_config set enabled
-- = false stops all intake.
--
-- Rollback (forward-only): a NEW migration that sets lead_intake_mode and
-- deal_intake_mode = 'manifest' everywhere and re-creates the replaced bodies from their source
-- migrations (the 4-argument integration_update_sync_settings with its grants).
-- Never delete Leads, Deals, incidents, inbox or audit rows; the new columns and
-- the incidents table may stay.

begin;

-- Do not queue behind long transactions on a live database.
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Live Lead intake: scope mode (contract section 2)
-- ===========================================================================

alter table public.integration_intake_config
  add column lead_intake_mode text not null default 'manifest'
    check (lead_intake_mode in ('manifest', 'scope'));
-- Lead decision (8 October 2026, night): the same switch for Deals.
alter table public.integration_intake_config
  add column deal_intake_mode text not null default 'manifest'
    check (deal_intake_mode in ('manifest', 'scope'));
comment on column public.integration_intake_config.deal_intake_mode is
  'manifest = Deals only from the active Deal manifest (default); scope = no manifest, every other Deal gate unchanged (pipeline, entry stage, sync date, Sales owner, removal, stale). Changed only through integration_update_sync_settings.';
-- Scope-mode Lead list watermark (start of the last successful pass); null =
-- no pass finished yet (the app lists from the sync date).
alter table public.integration_intake_config add column lead_reconciled_at timestamptz;
comment on column public.integration_intake_config.lead_reconciled_at is
  'Scope-mode Lead reconcile watermark: start of the last successful Lead list pass (never backwards). Null = list from cutoff_at. Written by integration_record_lead_reconcile_run; reset by integration_update_sync_settings.';
comment on column public.integration_intake_config.lead_intake_mode is
  'manifest = Leads only from the active Lead manifest (default); scope = every Lead created on/after cutoff_at whose Bitrix responsible is an eligible pilot Sales member. Changed only through integration_update_sync_settings.';

-- Mode of the last write; a manifest is required unless the Lead came in by scope.
alter table public.crm_leads
  add column intake_mode text not null default 'manifest' check (intake_mode in ('manifest', 'scope'));
alter table public.crm_leads alter column manifest_id drop not null;
alter table public.crm_leads add constraint crm_leads_manifest_required
  check (manifest_id is not null or intake_mode = 'scope');
comment on column public.crm_leads.intake_mode is
  'Intake mode of the last write (manifest | scope). manifest_id is null only for Leads that entered in scope mode.';

-- Held Leads in scope mode: the responsible is not an eligible pilot Sales member.
alter table public.integration_inbox drop constraint integration_inbox_reason_code_check;
alter table public.integration_inbox add constraint integration_inbox_reason_code_check check (reason_code in (
  'not_configured', 'environment_unset', 'not_eligible_category', 'not_eligible_stage',
  'before_cutoff', 'unmapped_owner', 'owner_not_in_pilot_branch', 'invalid_source_data',
  'source_deal_not_found', 'stale_ignored', 'reference_conflict',
  'not_in_manifest', 'outside_manifest_scope', 'scope_changed',
  -- Stage 6
  'owner_not_eligible'));

-- ---------------------------------------------------------------------------
-- Receiver gate (replaces 20261007000100; same signature)
-- ---------------------------------------------------------------------------

-- Stage 6: in scope mode every Lead (lead_intake_mode) or Deal
-- (deal_intake_mode) event of the config is recorded (the apply decides);
-- manifest mode is unchanged.
create or replace function authz.intake_manifest_allows(p_config_id uuid, p_source_object text, p_source_id bigint)
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
  -- Stage 6
  or (p_source_object = 'lead' and exists (
    select 1 from public.integration_intake_config c
    where c.id = p_config_id and c.lead_intake_mode = 'scope'))
  or (p_source_object = 'deal' and exists (
    select 1 from public.integration_intake_config c
    where c.id = p_config_id and c.deal_intake_mode = 'scope'))
$$;

revoke all on function authz.intake_manifest_allows(uuid, text, bigint) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Lead reconcile (replaces 20261007000101; same signature, same grants)
-- ---------------------------------------------------------------------------

create or replace function public.integration_enqueue_reconcile_lead(
  p_member_id text, p_lead_id bigint, p_source_modified bigint
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_config uuid;
  v_cfg public.integration_intake_config%rowtype;
  v_manifest public.intake_manifests%rowtype;
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
  -- Keep config identity and manifest authorization stable until the
  -- timestamp update or enqueue commits. Closing the manifest takes FOR
  -- UPDATE and cannot finish while this authorized operation holds FOR SHARE.
  select c.* into v_cfg from public.integration_intake_config c
  where c.portal_member_id = p_member_id and c.enabled for share;
  v_config := v_cfg.id;
  select m.* into v_manifest from public.intake_manifests m
  where m.config_id = v_config and m.source_object = 'lead' and m.status = 'active'
  for share;
  -- Stage 6: scope mode needs no manifest (the Lead apply decides).
  if v_cfg.lead_intake_mode is distinct from 'scope' and (v_manifest.id is null or not exists (
    select 1 from public.intake_manifest_items i
    where i.manifest_id = v_manifest.id and i.source_object = 'lead' and i.source_id = p_lead_id
  )) then
    return jsonb_build_object('inboxId', null, 'duplicate', false, 'upToDate', false,
      'ignored', true, 'reasonCode', 'not_in_manifest');
  end if;

  update public.crm_leads l
  set last_verified_at = now()
  where l.source_system = 'bitrix' and l.source_portal = p_member_id and l.source_lead_id = p_lead_id
    and l.legal_entity_id = v_cfg.pilot_legal_entity_id
    and l.branch_id = v_cfg.pilot_branch_id
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
-- Deal reconcile (replaces 20261007000101; same signature, same grants)
-- ---------------------------------------------------------------------------

create or replace function public.integration_enqueue_reconcile(
  p_member_id text, p_deal_id bigint, p_source_modified bigint
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_config uuid;
  v_cfg public.integration_intake_config%rowtype;
  v_manifest public.intake_manifests%rowtype;
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
  -- Keep config identity and manifest authorization stable until the
  -- timestamp update or enqueue commits. Closing the manifest takes FOR
  -- UPDATE and cannot finish while this authorized operation holds FOR SHARE.
  select c.* into v_cfg from public.integration_intake_config c
  where c.portal_member_id = p_member_id and c.enabled for share;
  v_config := v_cfg.id;
  select m.* into v_manifest from public.intake_manifests m
  where m.config_id = v_config and m.source_object = 'deal' and m.status = 'active'
  for share;
  -- Stage 6: scope mode needs no manifest (the Deal apply decides).
  if v_cfg.deal_intake_mode is distinct from 'scope' and (v_manifest.id is null or not exists (
    select 1 from public.intake_manifest_items i
    where i.manifest_id = v_manifest.id and i.source_object = 'deal' and i.source_id = p_deal_id
  )) then
    return jsonb_build_object('inboxId', null, 'duplicate', false, 'upToDate', false,
      'ignored', true, 'reasonCode', 'not_in_manifest');
  end if;

  update public.deals d
  set last_verified_at = now()
  where d.source_system = 'bitrix' and d.source_portal = p_member_id and d.source_deal_id = p_deal_id
    and d.legal_entity_id = v_cfg.pilot_legal_entity_id
    and d.branch_id = v_cfg.pilot_branch_id
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

revoke all on function public.integration_enqueue_reconcile(text, bigint, bigint)
from public, anon, authenticated, service_role;
grant execute on function public.integration_enqueue_reconcile(text, bigint, bigint) to service_role;

-- ---------------------------------------------------------------------------
-- Lead apply (replaces 20261007000200; same signature, same grants)
-- ---------------------------------------------------------------------------

create or replace function public.integration_apply_bitrix_lead(p_inbox_id uuid, p_lock_token uuid, p_lead jsonb)
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
  -- Stage 6: scope mode (integration_intake_config.lead_intake_mode).
  v_scope boolean;
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
    where c.portal_member_id = v_inbox.portal_member_id and c.enabled for share;
    if v_cfg.id is null or not authz.intake_portal_allowed(v_cfg.portal_domain) then
      v_outcome := 'needs_review'; v_reason := 'not_configured';
      exit checks;
    end if;

    -- Stage 6: scope mode takes no manifest (v_manifest stays null). The
    -- config row is held FOR SHARE, so the mode cannot change mid-apply.
    v_scope := v_cfg.lead_intake_mode = 'scope';
    if not v_scope then
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

    if v_scope then
      -- Stage 6: an empty or absent SOURCE_ID is stored as NONE; any other code
      -- must fit the stored code format.
      v_source_code := coalesce(nullif(v_source_code, ''), 'NONE');
      if v_source_code !~ '^[A-Za-z0-9_:.-]{1,50}$' then
        v_outcome := 'needs_review'; v_reason := 'invalid_source_data';
        exit checks;
      end if;
    else
    -- Manifest scope: verified source code and creation interval.
    if v_source_code is distinct from v_manifest.source_code
       or v_created < v_manifest.interval_from or v_created >= v_manifest.interval_to then
      v_outcome := 'needs_review'; v_reason := 'outside_manifest_scope';
      exit checks;
    end if;
    end if;

    select * into v_existing from public.crm_leads l
    where l.source_system = 'bitrix' and l.source_portal = v_cfg.portal_member_id
      and l.source_lead_id = v_inbox.source_deal_id
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

    if v_existing.id is not null and v_modified < v_existing.source_modified_at then
      v_outcome := 'stale_ignored'; v_reason := 'stale_ignored'; v_lead_id := v_existing.id;
      exit checks;
    end if;

    if v_scope then
      -- Stage 6 entry rule: a new Lead must be CREATED on/after the sync date.
      -- A stored Lead keeps following Bitrix (DATE_CREATE does not change).
      if v_existing.id is null and v_created < v_cfg.cutoff_at then
        v_outcome := 'ignored'; v_reason := 'before_cutoff';
        exit checks;
      end if;
      -- Stage 6 owner rule: the Bitrix responsible maps to an active Sales
      -- member of the pilot branch (authz.is_eligible_deal_owner). Otherwise
      -- (lead decision) the Lead is outside the pilot: ignored, nothing is
      -- written (a stored Lead stays exactly as it is). Not held for review.
      v_owner := authz.bitrix_owner_for(v_cfg.portal_member_id, v_cfg.pilot_legal_entity_id, v_assigned);
      if v_owner is null then
        v_outcome := 'ignored'; v_reason := 'owner_not_eligible'; v_lead_id := v_existing.id;
        exit checks;
      end if;
    else
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
    end if;

    if v_existing.id is null then
      begin
        insert into public.crm_leads
          (legal_entity_id, branch_id, reference, title, owner_user_id, source_system, source_portal,
           source_lead_id, source_status_id, source_id_code, source_created_at, source_modified_at,
           last_synced_at, last_verified_at, intake_inbox_id, manifest_id,
           -- Stage 6
           intake_mode)
        values
          (v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'BXL-' || v_inbox.source_deal_id::text,
           v_title, v_owner, 'bitrix', v_cfg.portal_member_id,
           v_inbox.source_deal_id, v_status, v_source_code, v_created, v_modified,
           now(), now(), v_inbox.id, v_manifest.id,
           -- Stage 6
           v_cfg.lead_intake_mode)
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
        -- Stage 6: scope mode keeps the Lead's earlier manifest (if any).
        manifest_id = coalesce(v_manifest.id, l.manifest_id),
        intake_mode = v_cfg.lead_intake_mode
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
        'manifestId', v_manifest.id,
        -- Stage 6
        'intakeMode', v_cfg.lead_intake_mode));
  elsif v_outcome = 'needs_review' then
    perform authz.write_audit('integration.lead_needs_review',
      v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'integration_inbox', v_inbox.id, null,
      jsonb_build_object('inboxId', v_inbox.id, 'origin', v_inbox.origin, 'reasonCode', v_reason));
  end if;

  return jsonb_build_object('outcome', v_outcome, 'leadId', v_lead_id, 'reasonCode', v_reason);
end;
$$;

revoke all on function
  public.integration_enqueue_reconcile_lead(text, bigint, bigint),
  public.integration_apply_bitrix_lead(uuid, uuid, jsonb)
from public, anon, authenticated, service_role;
grant execute on function
  public.integration_enqueue_reconcile_lead(text, bigint, bigint),
  public.integration_apply_bitrix_lead(uuid, uuid, jsonb)
to service_role;

-- ---------------------------------------------------------------------------
-- Lead reconcile watermark (new; same rules as integration_record_reconcile_run,
-- 20261003000100). On success the watermark moves to the run's START (never
-- backwards); a failed run leaves it unchanged.
-- Returns {portalMemberId, leadReconciledAt, advanced}.
-- ---------------------------------------------------------------------------

create function public.integration_record_lead_reconcile_run(
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
  if p_ok and (v_cfg.lead_reconciled_at is null or p_started_at > v_cfg.lead_reconciled_at) then
    update public.integration_intake_config c
    set lead_reconciled_at = p_started_at, updated_at = now()
    where c.id = v_cfg.id;
    v_cfg.lead_reconciled_at := p_started_at;
    v_advanced := true;
  end if;
  return jsonb_build_object('portalMemberId', p_member_id, 'leadReconciledAt', v_cfg.lead_reconciled_at,
    'advanced', v_advanced);
end;
$$;

revoke all on function public.integration_record_lead_reconcile_run(text, timestamptz, boolean)
from public, anon, authenticated, service_role;
grant execute on function public.integration_record_lead_reconcile_run(text, timestamptz, boolean) to service_role;

-- ---------------------------------------------------------------------------
-- Import-scope panel (replaces 20261007000200; same signature, same grants).
-- Stage 6 (review I2): when Lead or Deal intake is in scope mode the result
-- also carries "scopeIntake" (modes, sync date and scope-mode Lead counts:
-- Leads stored without a manifest, and Leads never stored whose latest inbox
-- row is held, failed or ignored as owner_not_eligible). In manifest mode the
-- result is exactly as before.
-- ---------------------------------------------------------------------------

create or replace function public.intake_scope_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_manifest public.intake_manifests%rowtype;
  v_last timestamptz;
  v_imported integer;
  v_held integer;
  v_failed integer;
  v_excluded integer;
  -- Stage 6 (review I2): scope-mode summary ('{}' in manifest mode).
  v_scope_view jsonb := '{}'::jsonb;
begin
  -- Purchase in any entity is refused (same rule as authz.can_read_lead).
  if not authz.session_ok() or exists (
    select 1 from public.memberships p
    where p.user_id = (select auth.uid()) and p.role_code = 'purchase' and p.status = 'active'
  ) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select * into v_cfg
  from public.integration_intake_config c
  order by c.enabled desc, c.updated_at desc, c.id
  limit 1;

  if v_cfg.id is null then
    -- No configuration at all: still an administrator-only answer.
    if not authz.can_admin_any('integration.manage') then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
  elsif not authz.can_admin('integration.manage', v_cfg.pilot_legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select max(r.finished_at) into v_last
  from public.integration_worker_runs r
  where r.outcome = 'ok';

  -- Stage 6 (review I2): scope-mode intake has no manifest; count it here.
  if v_cfg.id is not null and (v_cfg.lead_intake_mode = 'scope' or v_cfg.deal_intake_mode = 'scope') then
    v_scope_view := jsonb_build_object('scopeIntake', jsonb_build_object(
      'leadMode', v_cfg.lead_intake_mode,
      'dealMode', v_cfg.deal_intake_mode,
      'since', to_char(v_cfg.cutoff_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'leads', case when v_cfg.lead_intake_mode = 'scope' then (
        select jsonb_build_object(
          -- Leads stored without a manifest.
          'imported', (select count(*)::integer from public.crm_leads l
                       where l.source_system = 'bitrix' and l.source_portal = v_cfg.portal_member_id
                         and l.manifest_id is null),
          -- Latest inbox row per Lead never stored: held or failed.
          'heldForReview', count(*) filter (where x.status = 'needs_review')::integer,
          'failed', count(*) filter (where x.status in ('failed', 'dead_letter'))::integer,
          -- Outside the pilot (owner not an eligible pilot Sales member): ignored, not held.
          'ownerNotEligible', count(*) filter (where x.status = 'ignored' and x.reason_code = 'owner_not_eligible')::integer)
        from (
          select distinct on (b.source_deal_id) b.status, b.reason_code
          from public.integration_inbox b
          where b.portal_member_id = v_cfg.portal_member_id and b.source_object = 'lead'
            and not exists (
              select 1 from public.crm_leads l
              where l.source_system = 'bitrix' and l.source_portal = v_cfg.portal_member_id
                and l.source_lead_id = b.source_deal_id)
          order by b.source_deal_id, b.received_at desc, b.updated_at desc, b.id desc
        ) x) end));
  end if;

  if v_cfg.id is not null then
    -- The single active manifest (newest if a Lead and a Deal list are both
    -- active), else the most recently closed one.
    select * into v_manifest
    from public.intake_manifests m
    where m.config_id = v_cfg.id
    order by (m.status = 'active') desc, m.closed_at desc nulls last, m.created_at desc, m.id
    limit 1;
  end if;

  if v_manifest.id is null then
    return jsonb_build_object(
      'manifest', null,
      'lastSuccessfulSyncAt', to_char(v_last at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
      -- Stage 6
      || v_scope_view;
  end if;

  -- Items with a CRM row of the same object and portal identity.
  if v_manifest.source_object = 'lead' then
    select count(*)::integer into v_imported
    from public.intake_manifest_items i
    where i.manifest_id = v_manifest.id
      and exists (
        select 1 from public.crm_leads l
        where l.source_system = 'bitrix' and l.source_portal = v_cfg.portal_member_id
          and l.source_lead_id = i.source_id);
  else
    select count(*)::integer into v_imported
    from public.intake_manifest_items i
    where i.manifest_id = v_manifest.id
      and exists (
        select 1 from public.deals d
        where d.source_system = 'bitrix' and d.source_portal = v_cfg.portal_member_id
          and d.source_deal_id = i.source_id);
  end if;

  -- Latest inbox row per manifest item that has NO CRM row yet: held or
  -- failed means "not copied". An imported record whose later update is held
  -- stays counted as imported only.
  select
    count(*) filter (where x.status = 'needs_review')::integer,
    count(*) filter (where x.status in ('failed', 'dead_letter'))::integer
  into v_held, v_failed
  from public.intake_manifest_items i
  cross join lateral (
    select b.status
    from public.integration_inbox b
    where b.portal_member_id = v_cfg.portal_member_id
      and b.source_object = v_manifest.source_object
      and b.source_deal_id = i.source_id
    order by b.received_at desc, b.updated_at desc, b.id desc
    limit 1
  ) x
  where i.manifest_id = v_manifest.id
    and not (
      (v_manifest.source_object = 'lead' and exists (
        select 1 from public.crm_leads l
        where l.source_system = 'bitrix' and l.source_portal = v_cfg.portal_member_id
          and l.source_lead_id = i.source_id))
      or (v_manifest.source_object = 'deal' and exists (
        select 1 from public.deals d
        where d.source_system = 'bitrix' and d.source_portal = v_cfg.portal_member_id
          and d.source_deal_id = i.source_id)));

  -- Distinct records outside the list that arrived while it was active.
  select count(distinct b.source_deal_id)::integer into v_excluded
  from public.integration_inbox b
  where b.portal_member_id = v_cfg.portal_member_id
    and b.source_object = v_manifest.source_object
    and b.status = 'ignored' and b.reason_code = 'not_in_manifest'
    and b.received_at >= v_manifest.created_at
    and (v_manifest.closed_at is null or b.received_at < v_manifest.closed_at);

  return jsonb_build_object(
    'manifest', jsonb_build_object(
      'status', v_manifest.status,
      'sourceObject', v_manifest.source_object,
      'sourceCode', v_manifest.source_code,
      -- No verified portal label is stored; the view shows the raw code.
      'sourceCodeLabel', null,
      'businessDate', to_char(v_manifest.business_date, 'YYYY-MM-DD'),
      'intervalFrom', to_char(v_manifest.interval_from at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'intervalTo', to_char(v_manifest.interval_to at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'expectedCount', v_manifest.expected_count,
      'createdByOperator', v_manifest.created_by_operator,
      'createdAt', to_char(v_manifest.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'closedAt', to_char(v_manifest.closed_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'counts', jsonb_build_object(
        'imported', v_imported,
        'heldForReview', coalesce(v_held, 0),
        'failed', coalesce(v_failed, 0),
        'excluded', v_excluded)),
    'lastSuccessfulSyncAt', to_char(v_last at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
    -- Stage 6
    || v_scope_view;
end;
$$;

revoke all on function public.intake_scope_status() from public, anon, authenticated, service_role;
grant execute on function public.intake_scope_status() to authenticated;

-- ---------------------------------------------------------------------------
-- Settings (replaces 20261107000100 line 1601). Stage 6: new last arguments
-- p_lead_intake_mode and p_deal_intake_mode (text default null), so the
-- 4-argument function is dropped (no overload stays behind) and re-created
-- with the same grants. 4- and 5-argument calls resolve to it.
-- ---------------------------------------------------------------------------

drop function public.integration_update_sync_settings(bigint[], text[], timestamptz, boolean);

create function public.integration_update_sync_settings(
  p_category_ids bigint[], p_stage_ids text[], p_cutoff_at timestamptz, p_sync_enabled boolean,
  -- Stage 6: 'manifest' | 'scope'; null keeps the current Lead intake mode.
  p_lead_intake_mode text default null,
  -- Stage 6 (lead decision): the same for Deals.
  p_deal_intake_mode text default null
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
  -- Stage 6: intake mode changes (review M1).
  v_lead_mode text;
  v_deal_mode text;
  v_scope_requeued_leads integer := 0;
  v_scope_requeued_deals integer := 0;
  v_scope_requeue_cap constant integer := 5000;
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
  -- Stage 6
  if p_lead_intake_mode is not null and p_lead_intake_mode not in ('manifest', 'scope') then
    raise exception 'invalid Lead intake mode' using errcode = '22023';
  end if;
  if p_deal_intake_mode is not null and p_deal_intake_mode not in ('manifest', 'scope') then
    raise exception 'invalid Deal intake mode' using errcode = '22023';
  end if;
  -- Sync date = 00:00 India time of that day.
  v_cutoff := authz.ist_midnight(p_cutoff_at);

  select * into v_cfg from public.integration_intake_config c where c.id = v_cfg.id for update;
  -- Stage 6
  v_lead_mode := coalesce(p_lead_intake_mode, v_cfg.lead_intake_mode);
  v_deal_mode := coalesce(p_deal_intake_mode, v_cfg.deal_intake_mode);
  v_changed := authz.intake_categories(v_cfg) is distinct from p_category_ids
    or v_cfg.eligible_stage_ids is distinct from p_stage_ids
    or v_cfg.cutoff_at is distinct from v_cutoff
    -- Stage 6 (review M1): an intake mode change is a scope change too.
    or v_lead_mode is distinct from v_cfg.lead_intake_mode
    or v_deal_mode is distinct from v_cfg.deal_intake_mode;

  update public.integration_intake_config c
  set eligible_category_ids = p_category_ids, category_id = p_category_ids[1],
      eligible_stage_ids = p_stage_ids, cutoff_at = v_cutoff,
      -- Stage 6
      lead_intake_mode = coalesce(p_lead_intake_mode, c.lead_intake_mode),
      deal_intake_mode = coalesce(p_deal_intake_mode, c.deal_intake_mode),
      -- Lead watermark: a new scope pass or a new sync date lists from the start.
      lead_reconciled_at = case
        when (v_lead_mode = 'scope' and c.lead_intake_mode is distinct from 'scope')
             or c.cutoff_at is distinct from v_cutoff then null
        else c.lead_reconciled_at end,
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

    -- Stage 6 (review M1): switching an object type to scope evaluates again
    -- the events refused as not_in_manifest that were recorded on/after the
    -- sync date: the newest row per Bitrix record, none already queued, at
    -- most v_scope_requeue_cap records per object type.
    if v_lead_mode = 'scope' and v_cfg.lead_intake_mode is distinct from 'scope' then
      with picked as (
        select distinct on (i.source_deal_id) i.id
        from public.integration_inbox i
        where i.portal_member_id = v_cfg.portal_member_id and i.source_object = 'lead'
          and i.status = 'ignored' and i.reason_code = 'not_in_manifest' and i.received_at >= v_cutoff
          and not exists (select 1 from public.integration_inbox q
                          where q.portal_member_id = i.portal_member_id and q.source_object = 'lead'
                            and q.source_deal_id = i.source_deal_id and q.status in ('pending', 'processing', 'failed'))
        order by i.source_deal_id, i.received_at desc, i.id
        limit v_scope_requeue_cap
      )
      update public.integration_inbox i
      set status = 'pending', attempts = 0, next_attempt_at = now(), reason_code = null,
          origin = 'manual_retry', updated_at = now()
      from picked where i.id = picked.id;
      get diagnostics v_scope_requeued_leads = row_count;
    end if;
    if v_deal_mode = 'scope' and v_cfg.deal_intake_mode is distinct from 'scope' then
      with picked as (
        select distinct on (i.source_deal_id) i.id
        from public.integration_inbox i
        where i.portal_member_id = v_cfg.portal_member_id and i.source_object = 'deal'
          and i.status = 'ignored' and i.reason_code = 'not_in_manifest' and i.received_at >= v_cutoff
          and not exists (select 1 from public.integration_inbox q
                          where q.portal_member_id = i.portal_member_id and q.source_object = 'deal'
                            and q.source_deal_id = i.source_deal_id and q.status in ('pending', 'processing', 'failed'))
        order by i.source_deal_id, i.received_at desc, i.id
        limit v_scope_requeue_cap
      )
      update public.integration_inbox i
      set status = 'pending', attempts = 0, next_attempt_at = now(), reason_code = null,
          origin = 'manual_retry', updated_at = now()
      from picked where i.id = picked.id;
      get diagnostics v_scope_requeued_deals = row_count;
    end if;

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
      'requeued', v_requeued, 'removed', v_removed, 'restored', v_restored, 'resyncJobId', v_job,
      -- Stage 6
      'leadIntakeMode', coalesce(p_lead_intake_mode, v_cfg.lead_intake_mode),
      'previousLeadIntakeMode', v_cfg.lead_intake_mode,
      'dealIntakeMode', coalesce(p_deal_intake_mode, v_cfg.deal_intake_mode),
      'previousDealIntakeMode', v_cfg.deal_intake_mode,
      'scopeRequeuedLeads', v_scope_requeued_leads, 'scopeRequeuedDeals', v_scope_requeued_deals));
  return jsonb_build_object('requeued', v_requeued, 'removed', v_removed, 'restored', v_restored,
    'resyncQueued', v_job is not null, 'cutoffAt', v_cutoff,
    -- Stage 6
    'leadIntakeMode', coalesce(p_lead_intake_mode, v_cfg.lead_intake_mode),
    'dealIntakeMode', coalesce(p_deal_intake_mode, v_cfg.deal_intake_mode),
    'scopeRequeuedLeads', v_scope_requeued_leads, 'scopeRequeuedDeals', v_scope_requeued_deals);
end;
$$;

revoke all on function
  public.integration_update_sync_settings(bigint[], text[], timestamptz, boolean, text, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.integration_update_sync_settings(bigint[], text[], timestamptz, boolean, text, text)
to authenticated;

-- ===========================================================================
-- 2. Lead link on the Deal (contract section 3)
-- ===========================================================================

-- Bitrix LEAD_ID of the Deal; written only by integration_apply_bitrix_deal.
alter table public.deals add column source_lead_id bigint check (source_lead_id > 0);
comment on column public.deals.source_lead_id is
  'Bitrix LEAD_ID of an imported Deal (null = none). Set by integration_apply_bitrix_deal on every non-stale apply; the Lead is matched by (source_portal, source_lead_id) only.';

-- ---------------------------------------------------------------------------
-- Deal apply (replaces 20261107000100 section 10, line 2373; same signature,
-- same grants)
-- ---------------------------------------------------------------------------

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
  -- Stage 6: Bitrix LEAD_ID (snapshot key leadId), null = none.
  v_lead bigint;
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

    -- Stage 6 (lead decision): Deal scope mode takes no manifest (v_manifest
    -- stays null); every other gate below applies unchanged. The config row
    -- is held FOR SHARE, so the mode cannot change mid-apply.
    if v_cfg.deal_intake_mode is distinct from 'scope' then
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
        -- Stage 6: leadId digits = the Lead; empty, absent, JSON null or 0 = none;
        -- anything else is invalid source data.
        if coalesce(jsonb_typeof(p_deal -> 'leadId'), 'null') = 'null' or (p_deal ->> 'leadId') ~ '^0*$' then
          v_lead := null;
        elsif jsonb_typeof(p_deal -> 'leadId') = 'string' and (p_deal ->> 'leadId') ~ '^[0-9]{1,18}$' then
          v_lead := (p_deal ->> 'leadId')::bigint;
        else
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

    -- Stage 6: manifest mode only.
    if v_cfg.deal_intake_mode is distinct from 'scope' then
    -- Manifest scope: verified source code and creation interval.
    if jsonb_typeof(p_deal -> 'sourceId') is distinct from 'string'
       or (p_deal ->> 'sourceId') is distinct from v_manifest.source_code
       or v_created < v_manifest.interval_from or v_created >= v_manifest.interval_to then
      v_outcome := 'needs_review'; v_reason := 'outside_manifest_scope';
      exit checks;
    end if;
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
           source_assigned_by_id,
           -- Stage 6
           source_lead_id)
        values
          (v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'BX-' || v_inbox.source_deal_id::text,
           v_title, v_owner, false,
           'bitrix', v_cfg.portal_member_id, v_inbox.source_deal_id, v_stage, v_category,
           v_created, v_modified, now(), now(), v_inbox.id, v_assigned,
           -- Stage 6
           v_lead)
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
       -- Stage 6
       and v_existing.source_lead_id is not distinct from v_lead
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
        -- Stage 6
        source_lead_id = v_lead,
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
        'manifestId', v_manifest.id, 'waitingForOwner', v_owner is null,
        -- Stage 6
        'intakeMode', v_cfg.deal_intake_mode));
  elsif v_outcome = 'needs_review' then
    perform authz.write_audit('integration.deal_needs_review',
      v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'integration_inbox', v_inbox.id, null,
      jsonb_build_object('inboxId', v_inbox.id, 'origin', v_inbox.origin, 'reasonCode', v_reason));
  end if;

  return jsonb_build_object('outcome', v_outcome, 'dealId', v_deal_id, 'reasonCode', v_reason);
end;
$function$;

-- ===========================================================================
-- 3. Worker run trigger (contract sections 1 and 7)
-- ===========================================================================

-- How the run was started: manual (POST, also pg_cron + pg_net), cron (GET,
-- Vercel Cron) or event (a Bitrix push event, live run). Null for older rows.
alter table public.integration_worker_runs
  add column run_trigger text check (run_trigger in ('manual', 'cron', 'event'));

-- ---------------------------------------------------------------------------
-- Heartbeat (replaces 20261003000100; same signature, same grants)
-- ---------------------------------------------------------------------------

-- Stage 6: optional key "trigger" ('manual' | 'cron' | 'event'; absent or JSON
-- null = not recorded). Every other rule is unchanged.
create or replace function public.integration_record_worker_run(p_run jsonb) returns jsonb
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
    -- Stage 6: 'trigger'
    where k <> all (array['kind', 'startedAt', 'finishedAt', 'outcome', 'trigger'] || v_count_keys)
  ) then
    raise exception 'unknown run field' using errcode = '22023';
  end if;
  -- Stage 6
  if coalesce(jsonb_typeof(p_run -> 'trigger'), 'null') <> 'null'
     and (jsonb_typeof(p_run -> 'trigger') <> 'string' or (p_run ->> 'trigger') not in ('manual', 'cron', 'event')) then
    raise exception 'invalid run trigger' using errcode = '22023';
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
     failed, dead_lettered, enqueued,
     -- Stage 6
     run_trigger)
  values (p_run ->> 'kind', v_started, v_finished, p_run ->> 'outcome', v_counts[1], v_counts[2],
     v_counts[3], v_counts[4], v_counts[5], v_counts[6], v_counts[7], v_counts[8],
     -- Stage 6
     p_run ->> 'trigger')
  returning id into v_id;
  return jsonb_build_object('runId', v_id);
end;
$$;

revoke all on function public.integration_record_worker_run(jsonb) from public, anon, authenticated, service_role;
grant execute on function public.integration_record_worker_run(jsonb) to service_role;

-- ===========================================================================
-- 4. Sync-stopped incidents (contract sections 4 and 7)
-- ===========================================================================

-- One row per stop of the automatic sync. Opened by
-- integration_sync_alert_check() when the sync becomes stopped, closed
-- (recovered_at) when a successful run follows. Each notice is recorded once.
create table public.integration_sync_incidents (
  id uuid primary key default gen_random_uuid(),
  portal_member_id text not null references public.integration_intake_config (portal_member_id),
  opened_at timestamptz not null default now(),
  -- Why the sync counts as stopped when the incident opened (codes only).
  reason_code text not null check (reason_code in (
    'job_missing', 'job_inactive', 'call_failed', 'no_scheduler_calls', 'sync_incomplete', 'waiting_for_answer')),
  recovered_at timestamptz,
  open_notified_at timestamptz,
  recovery_notified_at timestamptz,
  -- Review L1: short send leases. A notice handed to one caller is not handed
  -- to another until the lease ends (the email is sent outside this
  -- transaction); marking it sent clears the lease.
  open_sending_until timestamptz,
  recovery_sending_until timestamptz,
  check (recovered_at is null or recovered_at >= opened_at),
  -- The recovery notice follows a stopped notice of a recovered incident.
  check (recovery_notified_at is null or (recovered_at is not null and open_notified_at is not null))
);
create unique index integration_sync_incidents_one_open
  on public.integration_sync_incidents (portal_member_id) where recovered_at is null;
create index integration_sync_incidents_recent
  on public.integration_sync_incidents (portal_member_id, opened_at desc);
comment on table public.integration_sync_incidents is
  'Automatic Bitrix sync stops: one open incident per portal, append and close only. Codes and times only.';

-- Append and close only: an update may only set recovered_at,
-- open_notified_at and recovery_notified_at once each (the send leases may
-- change freely); nothing is deleted.
create function authz.integration_sync_incident_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'sync incidents are never deleted' using errcode = '23514';
  end if;
  if (new.id, new.portal_member_id, new.opened_at, new.reason_code)
       is distinct from (old.id, old.portal_member_id, old.opened_at, old.reason_code)
     or (old.recovered_at is not null and new.recovered_at is distinct from old.recovered_at)
     or (old.open_notified_at is not null and new.open_notified_at is distinct from old.open_notified_at)
     or (old.recovery_notified_at is not null and new.recovery_notified_at is distinct from old.recovery_notified_at) then
    raise exception 'a sync incident can only be closed or marked notified once' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger integration_sync_incident_guard
  before update or delete on public.integration_sync_incidents
  for each row execute function authz.integration_sync_incident_guard();

alter table public.integration_sync_incidents enable row level security;
create policy require_valid_session on public.integration_sync_incidents as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
-- No API access: the service-role commands below are the only way in.
revoke all on public.integration_sync_incidents from public, anon, authenticated, service_role;

-- Opens or closes incidents from the facts integration_auto_sync_status()
-- uses (pg_cron job 'bitrix-sync', the schedule switch, the last scheduler
-- calls) plus the last successful reconcile heartbeat, with the admin page
-- rule (autoSyncState): switch off = paused (no incident); otherwise running
-- only when the last ok/partial reconcile run finished at most 3 x 30 s ago and
-- the job exists and is active. Returns the notices still to send:
-- {"send": [{incidentId, kind: stopped|recovered, openedAt, recoveredAt,
-- reasonCode, recipients: [email]}], "emailRecipientsCount": int}.
-- A stopped notice is offered while the incident is open and unmarked; a
-- recovered notice once the incident is closed, its stopped notice was marked
-- and its own notice is unmarked (an incident that recovered before anyone was
-- told sends nothing). Review L1: a notice is handed out with a 2-minute send
-- lease (item key sendingUntil) and not offered again until the lease ends or
-- it is marked sent.
create function public.integration_sync_alert_check() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_interval constant interval := interval '30 seconds';
  v_intervals constant integer := 3;
  -- Review L1: send lease per notice.
  v_lease constant interval := interval '2 minutes';
  v_job jsonb := null;
  v_enabled boolean;
  v_last_ok timestamptz;
  v_running boolean;
  v_reason text;
  v_failed record;
  v_answered record;
  v_calls integer;
  v_recipients jsonb;
  v_send jsonb;
  r record;
begin
  -- Facts (as public.integration_auto_sync_status()).
  if to_regclass('cron.job') is not null then
    execute $q$select jsonb_build_object('schedule', j.schedule, 'active', j.active)
               from cron.job j where j.jobname = 'bitrix-sync'$q$ into v_job;
  end if;
  select s.enabled into v_enabled from public.integration_sync_schedule s where s.id;
  select max(w.finished_at) into v_last_ok from public.integration_worker_runs w
  where w.kind = 'reconcile' and w.outcome in ('ok', 'partial');

  v_running := v_last_ok is not null and now() - v_last_ok <= v_interval * v_intervals
    and v_job is not null and coalesce((v_job ->> 'active')::boolean, false);

  if not v_running and v_enabled is distinct from false then
    -- Stopped: the same order of reasons as the admin page.
    if v_job is null then
      v_reason := 'job_missing';
    elsif not coalesce((v_job ->> 'active')::boolean, false) then
      v_reason := 'job_inactive';
    else
      select count(*) into v_calls from (
        select 1 from public.integration_sync_dispatches d order by d.dispatched_at desc limit 5) x;
      select d.ok, d.reason into v_answered from (
        select * from public.integration_sync_dispatches order by dispatched_at desc limit 5) d
      where d.ok is not null order by d.dispatched_at desc limit 1;
      select d.reason into v_failed from (
        select * from public.integration_sync_dispatches order by dispatched_at desc limit 5) d
      where d.ok = false order by d.dispatched_at desc limit 1;
      v_reason := case
        when v_answered.ok is false and v_failed.reason is not null then 'call_failed'
        when v_calls = 0 then 'no_scheduler_calls'
        when v_answered.ok then 'sync_incomplete'
        else 'waiting_for_answer'
      end;
    end if;

    -- One open incident per portal with intake switched on.
    for r in
      select c.portal_member_id, c.pilot_legal_entity_id, c.id from public.integration_intake_config c
      where c.enabled order by c.portal_member_id
    loop
      insert into public.integration_sync_incidents (portal_member_id, reason_code)
      values (r.portal_member_id, v_reason)
      on conflict (portal_member_id) where recovered_at is null do nothing;
      if found then
        perform authz.write_audit('integration.sync_incident_opened', r.pilot_legal_entity_id, null,
          'integration_intake_config', r.id, null, jsonb_build_object('reasonCode', v_reason));
      end if;
    end loop;
  elsif v_running then
    -- Recovered: a successful run finished after the incident opened.
    for r in
      update public.integration_sync_incidents i
      set recovered_at = now()
      where i.recovered_at is null and i.opened_at < v_last_ok
      returning i.id, i.portal_member_id, i.opened_at
    loop
      perform authz.write_audit('integration.sync_incident_recovered', c.pilot_legal_entity_id, null,
          'integration_intake_config', c.id, null,
          jsonb_build_object('incidentId', r.id, 'openedAt', r.opened_at))
      from public.integration_intake_config c where c.portal_member_id = r.portal_member_id;
    end loop;
  end if;

  -- Recipients: Auth emails of active staff with an active Super Admin membership.
  select coalesce(jsonb_agg(e.email order by e.email), '[]'::jsonb) into v_recipients
  from (
    select distinct u.email
    from auth.users u
    join public.staff_profiles p on p.user_id = u.id and p.status = 'active'
    where u.email is not null and btrim(u.email) <> ''
      and exists (
        select 1 from public.memberships m
        where m.user_id = u.id and m.role_code = 'super_admin' and m.status = 'active')
  ) e;

  -- Review L1: each notice is claimed with a 2-minute lease (row locks make a
  -- concurrent check wait and then skip it), so overlapping checks never hand
  -- out the same notice twice. An unmarked notice comes back after its lease.
  with stopped as (
    update public.integration_sync_incidents i
    set open_sending_until = now() + v_lease
    where i.recovered_at is null and i.open_notified_at is null
      and (i.open_sending_until is null or i.open_sending_until <= now())
    returning i.id, i.opened_at, i.recovered_at, i.reason_code, i.open_sending_until sending_until
  ), recovered as (
    update public.integration_sync_incidents i
    set recovery_sending_until = now() + v_lease
    where i.recovered_at is not null and i.open_notified_at is not null and i.recovery_notified_at is null
      and (i.recovery_sending_until is null or i.recovery_sending_until <= now())
    returning i.id, i.opened_at, i.recovered_at, i.reason_code, i.recovery_sending_until sending_until
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'incidentId', x.id, 'kind', x.kind, 'openedAt', x.opened_at, 'recoveredAt', x.recovered_at,
           'reasonCode', x.reason_code, 'recipients', v_recipients, 'sendingUntil', x.sending_until)
         order by x.opened_at, x.kind_order), '[]'::jsonb)
    into v_send
  from (
    select st.id, 'stopped' kind, 1 kind_order, st.opened_at, st.recovered_at, st.reason_code, st.sending_until from stopped st
    union all
    select rc.id, 'recovered', 2, rc.opened_at, rc.recovered_at, rc.reason_code, rc.sending_until from recovered rc
  ) x;

  return jsonb_build_object('send', v_send, 'emailRecipientsCount', jsonb_array_length(v_recipients));
end;
$$;

-- Records that one notice was sent. Idempotent: marking again changes nothing.
-- p_kind 'stopped' sets open_notified_at; 'recovered' sets recovery_notified_at
-- (only for a recovered incident whose stopped notice was marked).
create function public.integration_sync_alert_mark_sent(p_incident uuid, p_kind text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_incident public.integration_sync_incidents%rowtype;
begin
  if p_kind is null or p_kind not in ('stopped', 'recovered') then
    raise exception 'invalid notice kind' using errcode = '22023';
  end if;
  select * into v_incident from public.integration_sync_incidents i where i.id = p_incident for update;
  if v_incident.id is null then
    raise exception 'unknown sync incident' using errcode = '22023';
  end if;
  if p_kind = 'stopped' then
    update public.integration_sync_incidents i set open_notified_at = now(), open_sending_until = null
    where i.id = v_incident.id and i.open_notified_at is null;
    return;
  end if;
  if v_incident.recovery_notified_at is not null then
    return;
  end if;
  if v_incident.recovered_at is null or v_incident.open_notified_at is null then
    raise exception 'no recovery notice is due for this incident' using errcode = '22023';
  end if;
  update public.integration_sync_incidents i set recovery_notified_at = now(), recovery_sending_until = null
  where i.id = v_incident.id;
end;
$$;

revoke all on function
  authz.integration_sync_incident_guard(),
  public.integration_sync_alert_check(),
  public.integration_sync_alert_mark_sent(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.integration_sync_alert_check(),
  public.integration_sync_alert_mark_sent(uuid, text)
to service_role;

commit;
