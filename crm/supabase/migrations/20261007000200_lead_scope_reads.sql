-- Phase 6 lead screens: read-only import-scope status for the integration
-- admin page (docs/implementation/phase-6/lead-screens-contract.md section 3).
--
-- Adds public.intake_scope_status() returning the IntakeScopeView JSON shape
-- used by crm/src/views/integration-views.tsx:
--   { manifest: IntakeManifestSummary | null, lastSuccessfulSyncAt: string | null }
-- Only aggregate counts and manifest metadata leave the function: no manifest
-- id, config id, record ids, titles, staff names or e-mail addresses.
--
-- Lead visibility (authz.can_read_lead, used by the crm_leads scoped_read
-- policy) is tightened: an active Purchase membership in ANY entity now hides
-- every Lead (previously only Purchase in the Lead's own entity). Owner,
-- branch manager and integration.manage rules, and the session gate, are
-- unchanged. Signature and grants are unchanged.
--
-- PR 6 review L4: integration_apply_bitrix_deal / _lead hold an existing
-- record whose entity or branch differs from the current pilot configuration
-- with the new reason 'scope_changed' (added to the inbox reason check).
--
-- No table column or RLS policy definition changes. Earlier migrations are
-- unchanged. Not applied to any hosted project.
--
-- Everything this migration changes:
--   1. new function public.intake_scope_status() (grant: authenticated);
--   2. authz.can_read_lead(uuid) body (Purchase in any entity hides Leads);
--   3. integration_inbox_reason_code_check gains 'scope_changed';
--   4. public.integration_apply_bitrix_deal(uuid, uuid, jsonb) and
--      public.integration_apply_bitrix_lead(uuid, uuid, jsonb) replaced
--      (scope hold reason 'scope_changed').
-- Rollback is forward-only, in a new migration, with intake stopped first
-- (config enabled = false or manifest closed):
--   a. drop function public.intake_scope_status() (nothing in the database
--      depends on it; the admin page then shows its unavailable state);
--   b. re-create authz.can_read_lead from 20261007000100 if the per-entity
--      Purchase rule is wanted again;
--   c. re-create both apply functions from 20261007000101;
--   d. update integration_inbox rows with reason 'scope_changed' to
--      'owner_not_in_pilot_branch', then restore the reason check without
--      'scope_changed' (order matters: rows first, constraint second).

begin;

-- Lead visibility: a Purchase role holder in ANY entity reads no Lead (page and
-- navigation rule, lead-screens contract section 1). Before this migration the
-- exclusion applied only to the Lead's own entity. Otherwise unchanged: the
-- mapped owner with an active Sales membership in the Lead's enabled branch,
-- the branch manager, or an integration.manage admin of the entity.
create or replace function authz.can_read_lead(p_lead uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok()
    and not exists (
      select 1 from public.memberships p
      where p.user_id = (select auth.uid()) and p.role_code = 'purchase' and p.status = 'active')
    and exists (
    select 1 from public.crm_leads l
    where l.id = p_lead
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
revoke all on function authz.can_read_lead(uuid) from public, anon, authenticated, service_role;
grant execute on function authz.can_read_lead(uuid) to authenticated;

-- Configuration whose scope the panel shows: the enabled one first, then the
-- most recently updated. Read-only; no row lock.
create function public.intake_scope_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_manifest public.intake_manifests%rowtype;
  v_last timestamptz;
  v_imported integer;
  v_held integer;
  v_failed integer;
  v_excluded integer;
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
      'lastSuccessfulSyncAt', to_char(v_last at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
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
    'lastSuccessfulSyncAt', to_char(v_last at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
end;
$$;

comment on function public.intake_scope_status() is
  'Import-scope panel: active (else latest closed) manifest summary with aggregate counts and the last ok worker run. integration.manage admins of the config entity only; no ids, titles or names.';

revoke all on function public.intake_scope_status() from public, anon, authenticated, service_role;
grant execute on function public.intake_scope_status() to authenticated;

-- ---------------------------------------------------------------------------
-- PR 6 review L4: a scope change has its own reason code
-- ---------------------------------------------------------------------------
-- An existing Deal or Lead whose legal entity or branch differs from the
-- current pilot configuration is held needs_review with reason
-- 'scope_changed' (was 'owner_not_in_pilot_branch'). owner_not_in_pilot_branch
-- now means only that the mapped owner lacks an active membership in the
-- pilot branch. Both apply commands are copied unchanged from
-- 20261007000101 except for that one reason; signatures, search_path,
-- SECURITY DEFINER and grants (service_role only) are unchanged.

alter table public.integration_inbox drop constraint integration_inbox_reason_code_check;
alter table public.integration_inbox add constraint integration_inbox_reason_code_check check (reason_code in (
  'not_configured', 'environment_unset', 'not_eligible_category', 'not_eligible_stage',
  'before_cutoff', 'unmapped_owner', 'owner_not_in_pilot_branch', 'invalid_source_data',
  'source_deal_not_found', 'stale_ignored', 'reference_conflict',
  'not_in_manifest', 'outside_manifest_scope', 'scope_changed'));

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
      v_outcome := 'needs_review'; v_reason := 'scope_changed';
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
      v_outcome := 'needs_review'; v_reason := 'scope_changed';
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

commit;
