-- TripNavigate CRM - Stage 6b: scope-mode Lead intake accepts Bitrix
-- open-channel source codes and long titles.
--
-- Found on the first live sync (9 October 2026): Leads were held as
-- invalid_source_data because Bitrix SOURCE_ID values from open channels
-- contain "|" (for example "1|WHATSAPP") or titles exceed 200 characters.
-- In Lead scope mode only, the stored source code is normalised to the stored
-- format and a longer title is cut to 200 characters (the CRM copy is display
-- only; Bitrix keeps the original). Manifest mode is unchanged.
--
-- Replaces public.integration_apply_bitrix_lead (20261111000100); the body is
-- copied unchanged except the lines marked "Stage 6b". Same signature and grants.
-- Rollback: forward-only (restore the 20261111000100 body).

begin;
set local lock_timeout = '15s';

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
         -- Stage 6b: scope mode keeps the first 200 characters of a longer title.
         or length(btrim(p_lead ->> 'title')) not between 1 and (case when v_scope then 100000 else 200 end)
         or (p_lead ->> 'statusId') !~ '^[A-Za-z0-9_:.-]{1,50}$'
         or (p_lead ->> 'assignedById') !~ '^[1-9][0-9]{0,17}$'
         or (p_lead ->> 'dateCreate') !~ v_iso
         or (p_lead ->> 'dateModify') !~ v_iso then
        v_invalid := true;
      else
        v_title := btrim(p_lead ->> 'title');
        if v_scope and length(v_title) > 200 then
          v_title := left(v_title, 197) || '...';  -- Stage 6b: display copy only; Bitrix keeps the full title.
        end if;
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
      -- Stage 6b: Bitrix open-channel sources look like "1|WHATSAPP"; keep the
      -- code readable in the stored format ("|" and other characters become ":"
      -- or "_", at most 50 characters) instead of holding the Lead for review.
      v_source_code := left(regexp_replace(replace(v_source_code, '|', ':'), '[^A-Za-z0-9_:.-]', '_', 'g'), 50);
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


revoke all on function public.integration_apply_bitrix_lead(uuid, uuid, jsonb) from public, anon, authenticated, service_role;
grant execute on function public.integration_apply_bitrix_lead(uuid, uuid, jsonb) to service_role;

commit;
