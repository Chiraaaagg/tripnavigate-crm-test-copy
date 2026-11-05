-- TripNavigate CRM - B1.1d: Won-only Deal intake and the prune command.
--
-- Contract: docs/implementation/frontend-first-plan-2026-10-10/b1.1/
--   b1.1-contract-2026-10-11.md section 3 (DEC-27, frozen 11 Oct 2026).
-- Shapes:  b1.1-freeze-note.md section 3.3 and freeze/appendix-c-won-only-0400.md.
--
-- What changes:
--   1. public.integration_intake_config.deal_entry_stage_ids text[] (null =
--      today's behaviour). This column IS the switch: the contract's
--      "deal_intake_won_only" is the derived read deal_entry_stage_ids is not
--      null. It is written only by the audited Super Admin command
--      public.integration_set_deal_entry_stages (never by
--      integration_update_sync_settings), and the settings audit trigger now
--      watches it.
--   2. Entry rule (integration_apply_bitrix_deal): when the list is set, a NEW
--      Deal enters, and a removed Deal comes back, only in a stage of that list
--      ("replace, not intersect": the list replaces the ticked-stage check; the
--      pipeline, sync-date, manifest/scope and owner rules still apply). The
--      refusal keeps reason not_eligible_stage. A stored Deal is unchanged: its
--      header keeps updating and leaving Won never removes it.
--   3. integration_update_sync_settings: its restore brings back only Deals in
--      an entry stage while the list is set (and, with it off, a Deal the
--      prune removed in any stage); its "stage just unticked" removal never
--      removes a Deal sitting in an entry stage; and while the list is set it
--      refuses a pipeline list that leaves an entry stage's pipeline unticked
--      (entry_stage_pipeline_required). It never writes the list.
--   4. authz.queue_resync snapshots the entry list (when set) as the job's
--      stage filter, so the full resync lists Won Deals only: a pruned Deal
--      still outside Won is never listed or re-created, and the finish counts
--      stay honest (stored non-Won Deals count as kept after a stage move).
--   5. Removal reason 'outside_entry_stage' (deals, deal_removal_participants,
--      authz.remove_bitrix_deals).
--   6. public.integration_prune_deals_outside_entry_stages(p_reason, p_dry_run)
--      (Super Admin of the pilot company at aal2, reason 10-500): soft-removes
--      stored Bitrix Deals outside the entry stages that have no CRM work
--      (authz.deal_crm_work) and no sync waiting. The dry run changes nothing
--      except one audit row (a record of the check). Reversible: a pruned Deal
--      comes back when it reaches an entry stage; changing or clearing the
--      list brings back every pruned Deal in a ticked pipeline created on or
--      after the sync date, whatever its stage.
--
-- Replaced (latest bodies copied unchanged except lines marked "B1.1d"):
--   public.integration_apply_bitrix_deal(uuid, uuid, jsonb)   from 20261111000100
--   public.integration_update_sync_settings(bigint[], text[], timestamptz, boolean, text, text)
--                                                            from 20261111000100
--   authz.queue_resync(text, text, uuid)                       from 20261107000100
--   authz.remove_bitrix_deals(uuid[], text)                    from 20261107000100
-- Same signatures, same grants.
--
-- Refusal tokens (message is exactly the token):
--   42501 not_authorized
--   22023 invalid_input (hint names the field), entry_stage_outside_pipelines,
--         entry_stage_pipeline_required (integration_update_sync_settings)
--   55000 entry_stages_not_set
--   The reason rule keeps its message (authz.settings_change_reason) and
--   'intake is not configured' (55000) is unchanged.
--
-- Switch behaviour: while deal_entry_stage_ids is null every replaced function
-- behaves exactly as before (coalesce falls back to eligible_stage_ids). Leads
-- are untouched (contract section 7 question 1 is open).
--
-- Rollback (forward-only): clear the list with
-- integration_set_deal_entry_stages(null, reason); every Deal the prune
-- removed that is in a ticked pipeline and created on or after the sync date
-- comes back (whatever its stage), skipped events are evaluated again and a
-- full check runs. A pruned Deal in a pipeline unticked meanwhile comes back
-- when its pipeline is ticked again (settings restore). Emergency: a new
-- migration revoking execute on the two new commands from authenticated.
-- Never delete Deals, removal participants or audit rows.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. The entry list (the switch)
-- ===========================================================================

alter table public.integration_intake_config
  add column deal_entry_stage_ids text[]
    constraint integration_intake_config_deal_entry_stage_ids_check
    check (deal_entry_stage_ids is null
           or (cardinality(deal_entry_stage_ids) between 1 and 20
               and array_position(deal_entry_stage_ids, null) is null));
comment on column public.integration_intake_config.deal_entry_stage_ids is
  'B1.1d Won-only Deal intake (DEC-27). Null = today (new Deals enter at the ticked stages). Set = new Deals enter, and removed Deals come back, only at these Bitrix stages; stored Deals keep updating. Written only by public.integration_set_deal_entry_stages (Super Admin, reason, audited).';

-- The settings audit trigger watches the new column (watched columns are
-- trigger arguments, so the trigger is recreated with the same function).
drop trigger integration_intake_config_audit on public.integration_intake_config;
create trigger integration_intake_config_audit
  after insert or update or delete on public.integration_intake_config
  for each row execute function authz.audit_settings_change(
    'settings.intake_config_changed', 'enabled', 'portal_domain', 'portal_member_id', 'category_id',
    'eligible_category_ids', 'eligible_stage_ids', 'cutoff_at', 'pilot_legal_entity_id', 'pilot_branch_id',
    'lead_intake_mode', 'deal_intake_mode',
    -- B1.1d
    'deal_entry_stage_ids');

-- ===========================================================================
-- 2. Removal reason 'outside_entry_stage'
-- ===========================================================================

alter table public.deals drop constraint deals_removed_reason_check;
alter table public.deals add constraint deals_removed_reason_check
  check (removed_reason in ('before_sync_date', 'pipeline_not_eligible', 'stage_not_eligible', 'outside_entry_stage'));
alter table public.deal_removal_participants drop constraint deal_removal_participants_removed_reason_check;
alter table public.deal_removal_participants add constraint deal_removal_participants_removed_reason_check
  check (removed_reason in ('before_sync_date', 'pipeline_not_eligible', 'stage_not_eligible', 'outside_entry_stage'));

-- Removal primitive (replaces 20261107000100; same signature).
create or replace function authz.remove_bitrix_deals(p_ids uuid[], p_reason text) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ids uuid[];
  v_entity uuid;
begin
  if p_reason is null or p_reason not in ('before_sync_date', 'pipeline_not_eligible', 'stage_not_eligible',
                                         -- B1.1d
                                         'outside_entry_stage') then
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

-- ===========================================================================
-- 3. Deal apply (replaces 20261111000100; same signature, same grants)
-- ===========================================================================

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
      -- B1.1d: when the entry list is set it replaces the ticked stages for
      -- new Deals and for bringing back a removed Deal (null = today's rule).
      when not (v_stage = any (coalesce(v_cfg.deal_entry_stage_ids, v_cfg.eligible_stage_ids))) then 'not_eligible_stage'
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
    elsif v_entry_reason is null
          -- B1.1d: with Won-only intake off, a Deal the prune removed comes back
          -- in any stage (it was stored and active when pruned; today's rule
          -- never removes a stored Deal for its stage).
          or (v_cfg.deal_entry_stage_ids is null and v_existing.removed_reason = 'outside_entry_stage'
              and v_entry_reason = 'not_eligible_stage') then
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
-- 4. Settings (replaces 20261111000100; same 6-argument signature, same grants)
-- ===========================================================================

create or replace function public.integration_update_sync_settings(
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
  -- B1.1d: while Won-only intake is on, every entry stage's pipeline stays
  -- ticked (unticking it would stop new Deals silently).
  if v_cfg.deal_entry_stage_ids is not null and exists (
       select 1 from unnest(v_cfg.deal_entry_stage_ids) s
       where not (authz.bitrix_stage_category(s) = any (p_category_ids))) then
    raise exception 'entry_stage_pipeline_required' using errcode = '22023';
  end if;
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
               or (d.source_stage_id = any (v_cfg.eligible_stage_ids) and not (d.source_stage_id = any (p_stage_ids))
                   -- B1.1d: never a Deal sitting in an entry stage (Won-only on)
                   and not (d.source_stage_id = any (coalesce(v_cfg.deal_entry_stage_ids, '{}'::text[])))))
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
      -- B1.1d: with the entry list set, only Deals in an entry stage come back
      -- (null = the ticked stages, today's rule); with it off, a Deal the prune
      -- removed comes back in any stage.
      and (d.source_stage_id = any (coalesce(v_cfg.deal_entry_stage_ids, p_stage_ids))
           or (v_cfg.deal_entry_stage_ids is null and d.removed_reason = 'outside_entry_stage'));
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

-- ===========================================================================
-- 5. Resync queue (replaces 20261107000100; same signature)
-- ===========================================================================

create or replace function authz.queue_resync(p_member_id text, p_reason text, p_actor uuid) returns uuid
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
  -- B1.1d: the job lists the entry stages when the entry list is set.
  values (p_member_id, p_reason, v_cfg.cutoff_at, authz.intake_categories(v_cfg),
          coalesce(v_cfg.deal_entry_stage_ids, v_cfg.eligible_stage_ids), p_actor)
  on conflict do nothing
  returning id into v_id;
  if v_id is null then
    select j.id into v_id from public.integration_resync_jobs j
    where j.portal_member_id = p_member_id and j.status in ('queued', 'running');
  end if;
  return v_id;
end;
$$;

-- ===========================================================================
-- 6. Helpers
-- ===========================================================================

-- Bitrix pipeline (CATEGORY_ID) of a Deal stage id: 'C<n>:...' is pipeline n,
-- an id without that prefix belongs to the default pipeline 0.
create function authz.bitrix_stage_category(p_stage_id text) returns bigint
language sql immutable set search_path = '' as $$
  select case when p_stage_id ~ '^C[0-9]{1,18}:' then substring(p_stage_id from '^C([0-9]{1,18}):')::bigint else 0 end
$$;
revoke all on function authz.bitrix_stage_category(text) from public, anon, authenticated, service_role;

-- CRM work on a Deal (contract DEC-27 list plus the conservative kinds accepted
-- at the freeze). Empty array = no CRM work. Tables created by other B1.1
-- migrations are read only when they exist and carry a deal_id column, so this
-- helper never fails on a database without them.
create function authz.deal_crm_work(p_deal uuid) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v_work text[] := '{}';
  v_has boolean;
  r record;
begin
  if exists (select 1 from public.booking_versions v where v.deal_id = p_deal) then
    v_work := v_work || 'booking_version'::text;
  end if;
  if exists (select 1 from public.fulfilment_tasks t where t.deal_id = p_deal) then
    v_work := v_work || 'task'::text;
  end if;
  if exists (select 1 from public.customer_receipts c where c.deal_id = p_deal) then
    v_work := v_work || 'receipt'::text;
  end if;
  if exists (select 1 from public.customer_billing_profiles b where b.deal_id = p_deal) then
    v_work := v_work || 'billing_profile'::text;
  end if;
  if exists (select 1 from public.booking_evidence e where e.deal_id = p_deal) then
    v_work := v_work || 'evidence'::text;
  end if;
  if exists (select 1 from public.finance_deal_heads h where h.deal_id = p_deal)
     or exists (select 1 from public.finance_journal_entries j where j.deal_id = p_deal) then
    v_work := v_work || 'finance_record'::text;
  end if;
  -- The owner sync creates and ends 'sales' assignments itself; any other
  -- active assignment was made by a person.
  if exists (select 1 from public.deal_assignments a
             where a.deal_id = p_deal and a.ended_at is null and a.assignment_kind <> 'sales') then
    v_work := v_work || 'assignment'::text;
  end if;
  for r in
    select * from (values
      ('claim', 'customer_payment_claims'),
      ('contact', 'booking_version_contacts'),
      ('cost_entry', 'department_cost_entries'),
      ('visa_application', 'visa_applications'),
      ('traveller_identity', 'traveller_identities'),
      ('service_item', 'service_items'),
      ('traveller', 'deal_travellers')
    ) k (kind, tbl)
  loop
    if exists (select 1 from pg_catalog.pg_attribute a
               where a.attrelid = to_regclass('public.' || r.tbl) and a.attname = 'deal_id'
                 and a.attnum > 0 and not a.attisdropped) then
      execute format('select exists (select 1 from public.%I x where x.deal_id = $1)', r.tbl) into v_has using p_deal;
      if v_has then
        v_work := v_work || r.kind::text;
      end if;
    end if;
  end loop;
  return v_work;
end;
$$;
revoke all on function authz.deal_crm_work(uuid) from public, anon, authenticated, service_role;

-- ===========================================================================
-- 7. Setting the entry list (Super Admin, reason, audited)
-- ===========================================================================

-- p_stage_ids null = switch off (today's rule). Otherwise 1-20 distinct Bitrix
-- stage ids, each in a ticked pipeline. Never removes a Deal. When the list
-- changes, every Deal the prune removed ('outside_entry_stage') that is in a
-- ticked pipeline and created on or after the sync date comes back, whatever
-- its stage (a prune belongs to the list it ran under; after a change, run a
-- new dry run and prune again). Ignored Deal events are evaluated again (as a
-- settings save does) and a full resync with the new filter is queued.
-- Returns {changed, before, after, restored, requeued, resyncQueued}.
create function public.integration_set_deal_entry_stages(p_stage_ids text[], p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_n integer;
  v_reason text;
  v_prev text[];
  v_before text[];
  v_changed boolean;
  v_ids uuid[];
  v_restored integer := 0;
  v_requeued integer := 0;
  v_job uuid;
  r record;
begin
  select count(*) into v_n from public.integration_intake_config;
  if v_n <> 1 then
    raise exception 'intake is not configured' using errcode = '55000';
  end if;
  select * into v_cfg from public.integration_intake_config;
  if not authz.can_switch_live_settings(v_cfg.pilot_legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_reason := authz.settings_change_reason(p_reason);
  if p_stage_ids is not null and (
       cardinality(p_stage_ids) not between 1 and 20
       or array_position(p_stage_ids, null) is not null
       or exists (select 1 from unnest(p_stage_ids) s where s !~ '^[A-Za-z0-9_:.-]{1,50}$')
       or (select count(distinct s) from unnest(p_stage_ids) s) <> cardinality(p_stage_ids)) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'stage_ids';
  end if;

  -- Lock order: the config row, then Deals in id order (as the Deal apply).
  select * into v_cfg from public.integration_intake_config c where c.id = v_cfg.id for update;
  if p_stage_ids is not null and exists (
       select 1 from unnest(p_stage_ids) s
       where not (authz.bitrix_stage_category(s) = any (authz.intake_categories(v_cfg)))) then
    raise exception 'entry_stage_outside_pipelines' using errcode = '22023';
  end if;
  v_before := v_cfg.deal_entry_stage_ids;
  v_changed := (select array_agg(s order by s) from unnest(v_before) s)
               is distinct from (select array_agg(s order by s) from unnest(p_stage_ids) s);
  if not v_changed then
    return jsonb_build_object('changed', false, 'before', to_jsonb(v_before), 'after', to_jsonb(v_before),
      'restored', 0, 'requeued', 0, 'resyncQueued', false);
  end if;

  v_prev := authz.settings_begin_change('integration_set_deal_entry_stages', v_reason);
  update public.integration_intake_config c
  set deal_entry_stage_ids = p_stage_ids, updated_at = now(), updated_by = auth.uid()
  where c.id = v_cfg.id;
  perform authz.settings_end_change(v_prev);

  -- Every Deal the prune removed that is in a ticked pipeline and created on or
  -- after the sync date comes back, whatever its stage: owner mapping
  -- re-applied, then a fresh crm.deal.get (inbox row) confirms it.
  select array_agg(x.id order by x.id) into v_ids from (
    select d.id from public.deals d
    where d.source_system = 'bitrix' and d.source_portal = v_cfg.portal_member_id
      and d.legal_entity_id = v_cfg.pilot_legal_entity_id and d.branch_id = v_cfg.pilot_branch_id
      and d.removed_reason = 'outside_entry_stage'
      and d.source_category_id = any (authz.intake_categories(v_cfg))
      and d.source_created_at >= v_cfg.cutoff_at
    order by d.id
    for update of d
  ) x;
  if v_ids is not null then
    update public.deals d set removed_at = null, removed_reason = null where d.id = any (v_ids);
    for r in select d.id, d.source_assigned_by_id, d.source_deal_id from public.deals d where d.id = any (v_ids) order by d.id loop
      perform authz.set_deal_owner(r.id,
        authz.bitrix_owner_for(v_cfg.portal_member_id, v_cfg.pilot_legal_entity_id, r.source_assigned_by_id));
      insert into public.integration_inbox (portal_member_id, event_type, source_deal_id, source_ts, dedupe_key, origin)
      select v_cfg.portal_member_id, 'RECONCILE', r.source_deal_id, extract(epoch from now())::bigint,
        authz.intake_dedupe_key(v_cfg.portal_member_id, 'RESTORE:' || gen_random_uuid()::text, r.source_deal_id, 0),
        'manual_retry'
      where not exists (select 1 from public.integration_inbox i
                        where i.portal_member_id = v_cfg.portal_member_id and i.source_object = 'deal'
                          and i.source_deal_id = r.source_deal_id
                          and i.status in ('pending', 'processing', 'failed'));
      perform authz.write_audit('integration.deal_restored', v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id,
        'deal', r.id, v_reason, jsonb_build_object('cause', 'entry_stages_changed'));
    end loop;
    v_restored := cardinality(v_ids);
    perform authz.touch_deal_list(v_cfg.pilot_legal_entity_id, 0, v_restored);
  end if;

  -- Deal events skipped before are evaluated again (as integration_update_sync_settings).
  update public.integration_inbox i
  set status = 'pending', attempts = 0, next_attempt_at = now(), reason_code = null,
      origin = 'manual_retry', updated_at = now()
  where i.portal_member_id = v_cfg.portal_member_id and i.source_object = 'deal' and i.status = 'ignored'
    and i.reason_code in ('not_eligible_category', 'not_eligible_stage', 'before_cutoff');
  get diagnostics v_requeued = row_count;

  -- Full resync with the new filter (the scheduler runs it to the end).
  update public.integration_resync_jobs j set status = 'superseded', lock_token = null, locked_until = null
  where j.portal_member_id = v_cfg.portal_member_id and j.status in ('queued', 'running');
  v_job := authz.queue_resync(v_cfg.portal_member_id, 'settings_changed', auth.uid());

  perform authz.write_audit('integration.deal_entry_stages_set', v_cfg.pilot_legal_entity_id, null,
    'integration_intake_config', v_cfg.id, v_reason,
    jsonb_build_object('before', to_jsonb(v_before), 'after', to_jsonb(p_stage_ids),
      'restored', v_restored, 'requeued', v_requeued, 'resyncJobId', v_job));
  return jsonb_build_object('changed', true, 'before', to_jsonb(v_before), 'after', to_jsonb(p_stage_ids),
    'restored', v_restored, 'requeued', v_requeued, 'resyncQueued', v_job is not null);
end;
$$;

-- ===========================================================================
-- 8. Prune command (Super Admin, reason, audited; dry run first)
-- ===========================================================================

-- Stored Bitrix Deals of the pilot branch whose stage is not in the entry list:
--   * keptWithWork: CRM work exists (authz.deal_crm_work) - never removed;
--   * keptSyncPending: an inbox row for the Deal is waiting - its apply decides;
--   * pruned: everything else - soft-removed with reason 'outside_entry_stage'
--     (dry run: would be removed; nothing changes except one audit row).
-- Synthetic and CRM-native Deals, other branches and Leads are never read.
-- Lists hold at most 2000 entries per bucket ("truncated" says so); counts
-- are always complete.
create function public.integration_prune_deals_outside_entry_stages(p_reason text, p_dry_run boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_n integer;
  v_reason text;
  v_ids uuid[];
  v_work text[];
  v_kind text;
  v_prune uuid[] := '{}';
  v_stored integer;
  v_at_entry integer;
  v_removed integer := 0;
  v_pruned jsonb := '[]';
  v_kept jsonb := '[]';
  v_pending jsonb := '[]';
  v_pruned_n integer := 0;
  v_kept_n integer := 0;
  v_pending_n integer := 0;
  v_truncated boolean := false;
  v_cap constant integer := 2000;
  v_by_kind jsonb := jsonb_build_object(
    'booking_version', '[]'::jsonb, 'task', '[]'::jsonb, 'receipt', '[]'::jsonb, 'claim', '[]'::jsonb,
    'billing_profile', '[]'::jsonb, 'evidence', '[]'::jsonb, 'contact', '[]'::jsonb, 'cost_entry', '[]'::jsonb,
    'visa_application', '[]'::jsonb, 'traveller_identity', '[]'::jsonb, 'service_item', '[]'::jsonb,
    'traveller', '[]'::jsonb, 'finance_record', '[]'::jsonb, 'assignment', '[]'::jsonb);
  v_result jsonb;
  r record;
begin
  select count(*) into v_n from public.integration_intake_config;
  if v_n <> 1 then
    raise exception 'intake is not configured' using errcode = '55000';
  end if;
  select * into v_cfg from public.integration_intake_config;
  if not authz.can_switch_live_settings(v_cfg.pilot_legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_reason := authz.settings_change_reason(p_reason);
  if p_dry_run is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'dry_run';
  end if;
  -- The list cannot change while this command runs (the set command locks the row FOR UPDATE).
  select * into v_cfg from public.integration_intake_config c where c.id = v_cfg.id for share;
  if v_cfg.deal_entry_stage_ids is null then
    raise exception 'entry_stages_not_set' using errcode = '55000';
  end if;

  select count(*), count(*) filter (where d.source_stage_id = any (v_cfg.deal_entry_stage_ids))
  into v_stored, v_at_entry
  from public.deals d
  where d.source_system = 'bitrix' and d.source_portal = v_cfg.portal_member_id
    and d.legal_entity_id = v_cfg.pilot_legal_entity_id and d.branch_id = v_cfg.pilot_branch_id
    and d.removed_at is null and not d.is_synthetic;

  -- Real run: lock the candidates in id order BEFORE checking their work, so no
  -- booking draft, task, receipt or claim (all key-share lock the Deal row) can
  -- appear between the check and the removal. The dry run takes no lock.
  if p_dry_run then
    select array_agg(d.id order by d.id) into v_ids from public.deals d
    where d.source_system = 'bitrix' and d.source_portal = v_cfg.portal_member_id
      and d.legal_entity_id = v_cfg.pilot_legal_entity_id and d.branch_id = v_cfg.pilot_branch_id
      and d.removed_at is null and not d.is_synthetic
      and not (coalesce(d.source_stage_id, '') = any (v_cfg.deal_entry_stage_ids));
  else
    select array_agg(x.id order by x.id) into v_ids from (
      select d.id from public.deals d
      where d.source_system = 'bitrix' and d.source_portal = v_cfg.portal_member_id
        and d.legal_entity_id = v_cfg.pilot_legal_entity_id and d.branch_id = v_cfg.pilot_branch_id
        and d.removed_at is null and not d.is_synthetic
        and not (coalesce(d.source_stage_id, '') = any (v_cfg.deal_entry_stage_ids))
      order by d.id
      for update of d
    ) x;
  end if;

  for r in
    select d.id, d.reference, d.source_stage_id, d.source_deal_id
    from public.deals d where d.id = any (coalesce(v_ids, '{}'::uuid[])) order by d.id
  loop
    v_work := authz.deal_crm_work(r.id);
    if cardinality(v_work) > 0 then
      v_kept_n := v_kept_n + 1;
      if v_kept_n <= v_cap then
        v_kept := v_kept || jsonb_build_array(jsonb_build_object(
          'id', r.id, 'reference', r.reference, 'stageId', r.source_stage_id, 'work', to_jsonb(v_work)));
        foreach v_kind in array v_work loop
          v_by_kind := jsonb_set(v_by_kind, array[v_kind], coalesce(v_by_kind -> v_kind, '[]'::jsonb) || to_jsonb(r.id), true);
        end loop;
      end if;
    elsif exists (select 1 from public.integration_inbox i
                  where i.portal_member_id = v_cfg.portal_member_id and i.source_object = 'deal'
                    and i.source_deal_id = r.source_deal_id and i.status in ('pending', 'processing', 'failed')) then
      v_pending_n := v_pending_n + 1;
      if v_pending_n <= v_cap then
        v_pending := v_pending || jsonb_build_array(jsonb_build_object(
          'id', r.id, 'reference', r.reference, 'stageId', r.source_stage_id));
      end if;
    else
      v_prune := v_prune || r.id;
      v_pruned_n := v_pruned_n + 1;
      if v_pruned_n <= v_cap then
        v_pruned := v_pruned || jsonb_build_array(jsonb_build_object(
          'id', r.id, 'reference', r.reference, 'stageId', r.source_stage_id));
      end if;
    end if;
  end loop;
  v_truncated := v_kept_n > v_cap or v_pending_n > v_cap or v_pruned_n > v_cap;

  if not p_dry_run and cardinality(v_prune) > 0 then
    v_removed := authz.remove_bitrix_deals(v_prune, 'outside_entry_stage');
    for r in select unnest(v_prune) as id loop
      perform authz.write_audit('integration.deal_removed', v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id,
        'deal', r.id, v_reason,
        jsonb_build_object('reason', 'outside_entry_stage', 'command', 'integration_prune_deals_outside_entry_stages'));
    end loop;
  end if;

  v_result := jsonb_build_object(
    'dryRun', p_dry_run,
    'entryStageIds', to_jsonb(v_cfg.deal_entry_stage_ids),
    'storedActive', v_stored,
    'atEntryStage', v_at_entry,
    'pruned', jsonb_build_object('count', case when p_dry_run then v_pruned_n else v_removed end, 'deals', v_pruned),
    'keptWithWork', jsonb_build_object('count', v_kept_n, 'byKind', v_by_kind, 'deals', v_kept),
    'keptSyncPending', jsonb_build_object('count', v_pending_n, 'deals', v_pending),
    'truncated', v_truncated);

  perform authz.write_audit(
    case when p_dry_run then 'integration.deals_prune_previewed' else 'integration.deals_pruned' end,
    v_cfg.pilot_legal_entity_id, v_cfg.pilot_branch_id, 'integration_intake_config', v_cfg.id, v_reason,
    jsonb_build_object('dryRun', p_dry_run, 'entryStageIds', to_jsonb(v_cfg.deal_entry_stage_ids),
      'storedActive', v_stored, 'atEntryStage', v_at_entry,
      'pruned', case when p_dry_run then v_pruned_n else v_removed end,
      'prunedIds', to_jsonb(v_prune),
      'keptWithWork', v_kept_n, 'keptByKind', v_by_kind, 'keptSyncPending', v_pending_n));
  return v_result;
end;
$$;

-- ===========================================================================
-- 9. Grants
-- ===========================================================================

revoke all on function public.integration_set_deal_entry_stages(text[], text)
  from public, anon, authenticated, service_role;
grant execute on function public.integration_set_deal_entry_stages(text[], text) to authenticated;
revoke all on function public.integration_prune_deals_outside_entry_stages(text, boolean)
  from public, anon, authenticated, service_role;
grant execute on function public.integration_prune_deals_outside_entry_stages(text, boolean) to authenticated;

commit;
