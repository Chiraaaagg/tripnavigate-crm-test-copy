-- Phase 6 security review: preserve imported branch/entity boundaries and
-- bind the active manifest to its Bitrix portal identity.
--
-- A pilot configuration change is not a CRM record transfer. Existing Leads
-- and Deals outside the current pilot branch/entity are held for review.
-- Reconcile locks the active manifest while marking a matching record fresh
-- or queuing work, so closing it remains a stop switch for both operations.
-- Active-manifest JSON now includes portalDomain, memberId and configId;
-- comparator callers can verify that a private list belongs to this portal.
-- Existing RPC signatures, grants, RLS and table schemas remain unchanged.
-- Earlier migrations remain unchanged. This migration is not applied to any
-- hosted project by the review. Rollback requires a new forward migration;
-- stop intake before changing these guards.

begin;

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
      v_outcome := 'needs_review'; v_reason := 'owner_not_in_pilot_branch';
      exit checks;
    end if;


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
    -- A config change does not transfer an existing CRM record across a
    -- branch or legal entity. Hold the snapshot for an explicit transfer.
    if v_existing.id is not null and (
      v_existing.legal_entity_id is distinct from v_cfg.pilot_legal_entity_id
      or v_existing.branch_id is distinct from v_cfg.pilot_branch_id
    ) then
      v_outcome := 'needs_review'; v_reason := 'owner_not_in_pilot_branch';
      exit checks;
    end if;

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
  if v_manifest.id is null or not exists (
    select 1 from public.intake_manifest_items i
    where i.manifest_id = v_manifest.id and i.source_object = 'deal' and i.source_id = p_deal_id
  ) then
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
  if v_manifest.id is null or not exists (
    select 1 from public.intake_manifest_items i
    where i.manifest_id = v_manifest.id and i.source_object = 'lead' and i.source_id = p_lead_id
  ) then
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

create or replace function public.integration_active_manifest(p_member_id text, p_source_object text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_manifest public.intake_manifests%rowtype;
  v_cfg public.integration_intake_config%rowtype;
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
  select * into v_cfg from public.integration_intake_config c where c.id = v_manifest.config_id;
  return jsonb_build_object(
    'portalDomain', v_cfg.portal_domain,
    'memberId', v_cfg.portal_member_id,
    'configId', v_cfg.id,
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

commit;
