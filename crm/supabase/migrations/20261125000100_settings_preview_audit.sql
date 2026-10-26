-- TripNavigate CRM - Direction A Batch 4: Settings backend (preview, reason,
-- audit, "last changed by") and the department task History read.
--
-- Sources: docs/implementation/frontend-redesign-2026-10-15/plan.md section 3
-- (M1 sync-scope preview and reason, M5 per-switch confirmation, last changed
-- by / when, Unknown never Off, Visa task count), money-privacy-settings.md
-- sections 4.3-4.4 and 6, approval-handoff-2026-10-19.md section 4 (Atlas owns
-- the settings preview/reason/audit backend; a client-only confirmation is not
-- a substitute), direction-a-screen-plan.md section 3 (History rule, Department
-- task rule) and DA-16. Shapes: Atlas notes atlas-batch4-shapes.md.
--
-- What changes:
--   1. Indexes: newest settings audit rows by action, and audit rows of a
--      department task and its child records (History read).
--   2. Read public.settings_switch_states(): every workflow switch, every
--      Bitrix switch, the sync settings and the read-only live switches, each
--      with its state (on / off / unknown, never unknown shown as off) and who
--      changed it last, when, how (command / api / direct_sql) and why, from
--      the settings audit trigger rows (any writer). Sections the caller may
--      not read are null; nothing readable at all is not_authorized.
--   3. Visa desk launch: authz.visa_desk_launch_items() is now the one
--      predicate source for public.admin_set_workflow_setting (body replaced
--      from its latest definition, 20261123000100; behaviour unchanged) and
--      for the new read public.workflow_visa_task_preview() (exact count of
--      tasks switching the desk on would create, shown before saving).
--   4. Sync settings in two phases (M1, enforced here, not on the screen):
--      public.integration_preview_sync_settings(...) validates the proposed
--      pipelines, stages, date, automatic updates and intake modes, counts
--      exactly the Deals that would be hidden (by reason, and how many of
--      them carry CRM work) and brought back, and stores a private preview
--      row (10 minutes, one use, the caller only). public.
--      integration_apply_sync_settings(p_preview_id, p_reason) requires a
--      reason of 10-500 characters, locks the configuration row (5 s, else
--      settings_busy), refuses a missing, foreign, used, expired or stale
--      preview (settings changed, or the Deal sets are no longer the same:
--      counts and a hash of the sorted Deal ids per action and reason, read
--      again with those Deals locked), and applies exactly the previewed
--      values and Deal sets with the body of
--      public.integration_update_sync_settings (latest definition
--      20261119000400). The settings trigger row and the
--      integration.settings_updated row carry the reason.
--      public.integration_update_sync_settings keeps its signature and grant
--      but, after authorization, refuses preview_required: no save without a
--      preview and a reason.
--   5. Read public.department_task_history(p_task_id): that task's events only
--      (the task and its offers/costs/files/applications), only for the people
--      who open that task page today (Purchase: Purchase role holders and the
--      branch Manager; Flight: Flight role; Visa: Visa role), from an allowlist
--      of event kinds, with no amount or money detail for anyone. A person is
--      named only when the task page already shows them to its readers (the
--      current assignee, "Taken by"); the reader's own events say byYou.
--
-- Refusal tokens: 42501 not_authorized; 55000 intake is not configured,
-- preview_required, preview_used; 40001 preview_stale (hint expired |
-- settings_changed | counts_changed); 55P03 settings_busy; 22023 the sync
-- validation messages of 20261119000400 and 'a reason of 10 to 500
-- characters is required'.
--
-- Reads write nothing. No switch changes value. Rollback (forward-only): a new
-- migration that drops the new public functions, restores
-- public.integration_update_sync_settings from 20261119000400 and
-- public.admin_set_workflow_setting from 20261123000100, and drops
-- public.integration_sync_previews and the two indexes (rows of that table are
-- previews only, never business records).

--
-- Apply history: this file has run only on disposable local stacks. It was
-- amended in place on 23 October 2026 after the Echo-A review
-- (echo-redesign-batch4-data.md), before any kept or live database applied it:
--   M1 integration_preview/apply_sync_settings (authz.sync_settings_manager)
--      refuse not_authorized for anyone holding an active Purchase membership
--      in any company, and settings_switch_states gives such a person no
--      Bitrix section (authz.holds_purchase_anywhere);
--   L1 the preview stores plan_hash (md5 of the sorted Deal ids per action and
--      reason); apply refuses preview_stale / counts_changed when the Deal set
--      differs even with equal counts;
--   L2 apply locks the planned Deals (id order, after the configuration row)
--      and reads the plan again under those locks before hiding or bringing
--      back anything;
--   L8 integration_sync_previews.config_id is on delete cascade;
--   L9 integration managers without a Purchase role read the workflow switch
--      states again (read only, canSwitch false), as workflow_settings_get let
--      them before.
--   M2 (lead ruling): Accounts accept/return events and the return reason stay
--      in the department task History (the same readers see that reason on
--      the cost card today; no amounts). No change.
--
-- Index build (Echo-A L7): the two audit_events indexes are built inside this
-- transaction, without CONCURRENTLY, so audit writes (every command) wait while
-- they build. The live audit_events table holds about 5,000 rows (23 October
-- 2026), so the build takes well under a second.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Indexes
-- ===========================================================================

-- Newest settings row per action (settings_switch_states). The intake rows use
-- audit_events_intake_config_changes_idx (20261121000140).
create index audit_events_settings_rows_idx
  on public.audit_events (action, occurred_at desc)
  where action in ('settings.workflow_changed', 'settings.booking_changed', 'settings.procurement_changed',
                   'settings.finance_live_changed', 'integration.settings_updated');

-- Audit rows of one department task and its child records (department_task_history).
create index audit_events_task_history_idx
  on public.audit_events (target_id, occurred_at desc)
  where target_type in ('fulfilment_task', 'purchase_evidence', 'department_evidence', 'department_cost_entry',
                        'visa_application');

-- ===========================================================================
-- 2. Per-switch state and "last changed by"
-- ===========================================================================

-- Newest UPDATE row of a settings audit action whose changes name one of
-- p_keys (insert rows are not changes). p_target / p_entity narrow it (null =
-- any). p_kind: 'bool' = from/to are the first key's booleans; 'not_null' =
-- from/to say whether the first key held a value; anything else = no from/to.
-- Null when nothing matching was recorded. The action is a literal in the
-- query so the partial indexes apply.
create function authz.settings_last_change(p_action text, p_target uuid, p_entity uuid, p_keys text[], p_kind text)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_row public.audit_events%rowtype;
  v_from jsonb;
  v_to jsonb;
begin
  execute format(
    'select a.* from public.audit_events a
     where a.action = %L
       and ($1::uuid is null or a.target_id = $1)
       and ($2::uuid is null or a.legal_entity_id = $2)
       and a.details ->> ''operation'' = ''update''
       and (a.details -> ''changes'') ?| $3
     order by a.occurred_at desc, a.id desc
     limit 1', p_action)
  into v_row using p_target, p_entity, p_keys;
  if v_row.id is null then
    return null;
  end if;
  v_from := v_row.details -> 'changes' -> p_keys[1] -> 'from';
  v_to := v_row.details -> 'changes' -> p_keys[1] -> 'to';
  return jsonb_build_object(
    'at', v_row.occurred_at,
    'byName', (select p.display_name from public.staff_profiles p where p.user_id = v_row.actor_user_id),
    'byYou', v_row.actor_user_id is not null and v_row.actor_user_id = (select auth.uid()),
    'via', v_row.details ->> 'via',
    'command', v_row.details ->> 'command',
    'from', case p_kind
              when 'bool' then case when jsonb_typeof(v_from) = 'boolean' then v_from else 'null'::jsonb end
              when 'not_null' then case when v_from is null then 'null'::jsonb
                                        else to_jsonb(jsonb_typeof(v_from) <> 'null') end
              else 'null'::jsonb end,
    'to', case p_kind
            when 'bool' then case when jsonb_typeof(v_to) = 'boolean' then v_to else 'null'::jsonb end
            when 'not_null' then case when v_to is null then 'null'::jsonb
                                      else to_jsonb(jsonb_typeof(v_to) <> 'null') end
            else 'null'::jsonb end,
    'fields', coalesce((select jsonb_agg(k order by k) from jsonb_object_keys(v_row.details -> 'changes') k
                        where k = any (p_keys)), '[]'::jsonb),
    'reason', v_row.reason);
end;
$$;

create function authz.switch_state(p_value boolean) returns text
language sql immutable set search_path = '' as $$
  select case when p_value is null then 'unknown' when p_value then 'on' else 'off' end
$$;

-- An active Purchase membership in any company (same rule as authz.can_read_lead):
-- such a person never reads or changes Bitrix connection settings (Echo-A M1).
create function authz.holds_purchase_anywhere() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships p
                 where p.user_id = (select auth.uid()) and p.role_code = 'purchase' and p.status = 'active')
$$;

create function public.settings_switch_states() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_super boolean;
  v_wf public.workflow_settings%rowtype;
  v_workflow jsonb;
  v_n integer;
  v_cfg public.integration_intake_config%rowtype;
  v_bitrix jsonb;
  v_sync boolean;
  v_saved public.audit_events%rowtype;
  v_live jsonb;
  v_booking boolean;
  v_procurement boolean;
  k text;
  v_items jsonb;
  v_purchase boolean;  -- Echo-A M1
  v_integration boolean;  -- Echo-A L9
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_super := authz.can_switch_live_settings(null);
  v_purchase := authz.holds_purchase_anywhere();
  v_integration := not v_purchase and coalesce(authz.can_admin_any('integration.manage'), false);

  -- Workflow switches: Super Admin at aal2 (may change), and integration
  -- managers who hold no Purchase role (read only, as workflow_settings_get
  -- showed them before; Echo-A L9).
  if v_super or v_integration then
    select * into v_wf from public.workflow_settings s where s.id;
    v_items := '[]'::jsonb;
    foreach k in array array['service_items_enabled', 'intake_prompt_enabled', 'visa_passport_tasks_enabled',
                             'prefill_auto_fill', 'referral_drafts'] loop
      v_items := v_items || jsonb_build_object(
        'key', k,
        'state', authz.switch_state(case when v_wf.id is null then null else (to_jsonb(v_wf) ->> k)::boolean end),
        'lastChange', authz.settings_last_change('settings.workflow_changed', null, null, array[k], 'bool'));
    end loop;
    v_workflow := jsonb_build_object('readable', v_wf.id is not null, 'canSwitch', v_super, 'switches', v_items);
  end if;

  -- Bitrix connection (integration.manage or Super Admin of the config's
  -- company); never a Purchase holder (Echo-A M1, money-privacy-settings 6.4).
  select count(*) into v_n from public.integration_intake_config;
  if v_n = 1 and not v_purchase then
    select * into v_cfg from public.integration_intake_config;
    if coalesce(authz.can_admin('integration.manage', v_cfg.pilot_legal_entity_id), false)
       or authz.can_switch_live_settings(v_cfg.pilot_legal_entity_id) then
      v_items := '[]'::jsonb;
      foreach k in array array['bitrix_trip_facts_read', 'lead_intake_unowned', 'bitrix_id_proof_copy',
                               'bitrix_name_read'] loop
        v_items := v_items || jsonb_build_object(
          'key', k,
          'state', authz.switch_state((to_jsonb(v_cfg) ->> k)::boolean),
          'lastChange', authz.settings_last_change('settings.intake_config_changed', v_cfg.id, null, array[k], 'bool'));
      end loop;
      v_items := v_items || jsonb_build_object(
        'key', 'won_only_intake',
        'state', authz.switch_state(v_cfg.deal_entry_stage_ids is not null),
        'lastChange', authz.settings_last_change('settings.intake_config_changed', v_cfg.id, null,
                                                 array['deal_entry_stage_ids'], 'not_null'));
      select s.enabled into v_sync from public.integration_sync_schedule s where s.id;
      select a.* into v_saved from public.audit_events a
      where a.action = 'integration.settings_updated' and a.target_id = v_cfg.id
      order by a.occurred_at desc, a.id desc limit 1;
      v_bitrix := jsonb_build_object(
        'readable', true,
        'canSwitch', authz.can_switch_live_settings(v_cfg.pilot_legal_entity_id),
        'canManageSync', coalesce(authz.can_admin('integration.manage', v_cfg.pilot_legal_entity_id), false),
        'connectionEnabled', v_cfg.enabled,
        'pilotLegalEntityId', v_cfg.pilot_legal_entity_id,
        'pilotBranchId', v_cfg.pilot_branch_id,
        'pilotBranchName', (select b.name from public.branches b where b.id = v_cfg.pilot_branch_id),
        'switches', v_items,
        'syncSettings', jsonb_build_object(
          'categoryIds', to_jsonb(authz.intake_categories(v_cfg)),
          'stageIds', to_jsonb(v_cfg.eligible_stage_ids),
          'cutoffAt', v_cfg.cutoff_at,
          'leadIntakeMode', v_cfg.lead_intake_mode,
          'dealIntakeMode', v_cfg.deal_intake_mode,
          'autoSync', authz.switch_state(v_sync),
          'lastScopeChange', authz.settings_last_change('settings.intake_config_changed', v_cfg.id, null,
            array['eligible_category_ids', 'category_id', 'eligible_stage_ids', 'cutoff_at', 'lead_intake_mode',
                  'deal_intake_mode'], null),
          'lastSaved', case when v_saved.id is null then null else jsonb_build_object(
            'at', v_saved.occurred_at,
            'byName', (select p.display_name from public.staff_profiles p where p.user_id = v_saved.actor_user_id),
            'byYou', v_saved.actor_user_id is not null and v_saved.actor_user_id = (select auth.uid()),
            'reason', v_saved.reason,
            'autoSync', case when jsonb_typeof(v_saved.details -> 'syncEnabled') = 'boolean'
                             then v_saved.details -> 'syncEnabled' else 'null'::jsonb end,
            'hidden', case when jsonb_typeof(v_saved.details -> 'removed') = 'number'
                           then v_saved.details -> 'removed' else 'null'::jsonb end,
            'broughtBack', case when jsonb_typeof(v_saved.details -> 'restored') = 'number'
                                then v_saved.details -> 'restored' else 'null'::jsonb end) end));
    end if;
  elsif v_n <> 1 and not v_purchase and (v_integration or v_super) then
    -- No or several configurations: everything Unknown, never Off.
    v_bitrix := jsonb_build_object(
      'readable', false, 'canSwitch', false, 'canManageSync', false, 'connectionEnabled', null,
      'pilotLegalEntityId', null, 'pilotBranchId', null, 'pilotBranchName', null,
      'switches', (select jsonb_agg(jsonb_build_object('key', x, 'state', 'unknown', 'lastChange', null) order by o)
                   from unnest(array['bitrix_trip_facts_read', 'lead_intake_unowned', 'bitrix_id_proof_copy',
                                     'bitrix_name_read', 'won_only_intake']) with ordinality u (x, o)),
      'syncSettings', jsonb_build_object('categoryIds', null, 'stageIds', null, 'cutoffAt', null,
        'leadIntakeMode', null, 'dealIntakeMode', null, 'autoSync', 'unknown', 'lastScopeChange', null,
        'lastSaved', null));
  end if;

  -- Read-only live switches (Super Admin at aal2; no control anywhere).
  if v_super then
    select s.real_booking_enabled into v_booking from public.booking_settings s where s.id;
    select s.live_supplier_confirmation_enabled into v_procurement from public.procurement_settings s where s.id;
    v_live := jsonb_build_object(
      'realBooking', jsonb_build_object('state', authz.switch_state(v_booking),
        'lastChange', authz.settings_last_change('settings.booking_changed', null, null,
                                                 array['real_booking_enabled'], 'bool')),
      'supplierConfirmation', jsonb_build_object('state', authz.switch_state(v_procurement),
        'lastChange', authz.settings_last_change('settings.procurement_changed', null, null,
                                                 array['live_supplier_confirmation_enabled'], 'bool')),
      'financeModes', coalesce((
        select jsonb_agg(jsonb_build_object(
          'legalEntityId', e.id, 'legalName', e.legal_name,
          'modes', (select jsonb_agg(jsonb_build_object(
                      'key', m.key,
                      'state', authz.switch_state((to_jsonb(f) ->> (m.key || '_live'))::boolean),
                      'lastChange', authz.settings_last_change('settings.finance_live_changed', e.id, e.id,
                                                               array[m.key || '_live'], 'bool'))
                      order by m.o)
                    from unnest(array['bank_transfer', 'upi', 'cash', 'cheque']) with ordinality m (key, o)))
          order by e.legal_name)
        from public.finance_live_settings f
        join public.legal_entities e on e.id = f.legal_entity_id
        where authz.holds_active_role('super_admin', e.id)), '[]'::jsonb));
  end if;

  if v_workflow is null and v_bitrix is null and v_live is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return jsonb_build_object('workflow', v_workflow, 'bitrix', v_bitrix, 'live', v_live);
end;
$$;

comment on function public.settings_switch_states() is
  'Direction A Batch 4 (M5, R4): state (on / off / unknown) and who changed it last, when, how and why, for every workflow switch, Bitrix switch, the sync settings and the read-only live switches. Sections the caller may not read are null. Reads write nothing.';

-- ===========================================================================
-- 3. Visa desk launch: one predicate source for the switch and its preview
-- ===========================================================================

-- Accepted visa/passport items of confirmed versions with no task yet (body of
-- the loop in admin_set_workflow_setting, 20261123000100); skip = the Deal is
-- removed or not active (counted, never given a task).
create function authz.visa_desk_launch_items()
returns table (id uuid, deal_id uuid, item_no integer, service_type text, department text, version_id uuid,
               version_no integer, legal_entity_id uuid, branch_id uuid, skip boolean)
language sql stable security definer set search_path = '' as $$
  select i.id, i.deal_id, i.item_no, i.service_type, i.department, v.id as version_id, v.version_no,
    v.legal_entity_id, v.branch_id,
    (d.removed_at is not null or authz.deal_not_active(d.id)) as skip
  from public.service_items i
  join public.booking_versions v on v.deal_id = i.deal_id and v.status = 'confirmed'
  join public.service_item_facts f on f.service_item_id = i.id and f.booking_version_id = v.id
  join public.deals d on d.id = i.deal_id
  where i.service_type in ('visa', 'passport') and i.state = 'active'
    and not exists (select 1 from public.fulfilment_tasks t where t.service_item_id = i.id)
$$;

create function public.workflow_visa_task_preview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_on boolean;
begin
  if not authz.can_switch_live_settings(null) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select s.visa_passport_tasks_enabled into v_on from public.workflow_settings s where s.id;
  return (
    select jsonb_build_object(
      'switchState', authz.switch_state(v_on),
      'wouldCreate', count(distinct x.id) filter (where not x.skip),
      'skipped', count(*) filter (where x.skip),
      'deals', count(distinct x.deal_id) filter (where not x.skip))
    from authz.visa_desk_launch_items() x);
end;
$$;

comment on function public.workflow_visa_task_preview() is
  'Direction A Batch 4 (M5): how many Visa desk tasks switching visa_passport_tasks_enabled on would create now (same set as admin_set_workflow_setting), and how many items are skipped (removed or lost Deals). Super Admin at aal2. Reads write nothing.';

-- public.admin_set_workflow_setting (replaces 20261123000100_referral_drafts.sql:1908). Batch 4: the
-- desk launch reads authz.visa_desk_launch_items(); nothing else changes.
create or replace function public.admin_set_workflow_setting(p_key text, p_value boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before public.workflow_settings%rowtype;
  v_after public.workflow_settings%rowtype;
  v_reason text;
  v_prev text[];
  v_was boolean;
  v_now boolean;
  -- B1.1c
  v_created integer := 0;
  v_skipped integer := 0;
  v_item record;
  v_task uuid;
  v_timeout text;  -- Batch 2
begin
  if not authz.can_switch_live_settings(null) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_reason := authz.settings_change_reason(p_reason);
  if p_key is null or p_key not in ('intake_prompt_enabled', 'service_items_enabled', 'visa_passport_tasks_enabled',
                                    'prefill_auto_fill', 'referral_drafts')  -- Batch 3
     or p_value is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- Batch 2 (Echo L11, F.6 N5): wait at most 5 s for the settings row only;
  -- a held row (55P03 here and only here) is settings_busy.
  v_timeout := current_setting('lock_timeout');
  begin
    perform set_config('lock_timeout', '5s', true);
    select * into v_before from public.workflow_settings s where s.id for update;
    perform set_config('lock_timeout', v_timeout, true);
  exception when lock_not_available then
    raise exception 'settings_busy' using errcode = '55P03';
  end;
  if v_before.id is null then
    raise exception 'settings row missing' using errcode = '55000';
  end if;

  v_prev := authz.settings_begin_change('admin_set_workflow_setting', v_reason);
  update public.workflow_settings s
  set intake_prompt_enabled = case when p_key = 'intake_prompt_enabled' then p_value else s.intake_prompt_enabled end,
      service_items_enabled = case when p_key = 'service_items_enabled' then p_value else s.service_items_enabled end,
      visa_passport_tasks_enabled = case when p_key = 'visa_passport_tasks_enabled' then p_value
                                         else s.visa_passport_tasks_enabled end,
      prefill_auto_fill = case when p_key = 'prefill_auto_fill' then p_value else s.prefill_auto_fill end,
      referral_drafts = case when p_key = 'referral_drafts' then p_value else s.referral_drafts end  -- Batch 3
  where s.id
  returning * into v_after;
  perform authz.settings_end_change(v_prev);

  v_was := case p_key when 'intake_prompt_enabled' then v_before.intake_prompt_enabled
                      when 'service_items_enabled' then v_before.service_items_enabled
                      when 'prefill_auto_fill' then v_before.prefill_auto_fill
                      when 'referral_drafts' then v_before.referral_drafts  -- Batch 3
                      else v_before.visa_passport_tasks_enabled end;
  v_now := case p_key when 'intake_prompt_enabled' then v_after.intake_prompt_enabled
                      when 'service_items_enabled' then v_after.service_items_enabled
                      when 'prefill_auto_fill' then v_after.prefill_auto_fill
                      when 'referral_drafts' then v_after.referral_drafts  -- Batch 3
                      else v_after.visa_passport_tasks_enabled end;
  -- B1.1c: switching the desk on creates each missing task once (accepted
  -- visa/passport items); removed and lost Deals are skipped and counted.
  -- Review V3: also when already on (repair: Deals active again, a confirm that
  -- raced the first switch-on). Idempotent by task key.
  if p_key = 'visa_passport_tasks_enabled' and v_now then
    for v_item in
      -- Batch 4: one predicate source with workflow_visa_task_preview().
      select x.id, x.deal_id, x.service_type, x.department, x.version_id, x.version_no, x.legal_entity_id,
        x.branch_id, x.skip
      from authz.visa_desk_launch_items() x
      order by x.deal_id, x.item_no
    loop
      if v_item.skip then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      v_task := null;
      insert into public.fulfilment_tasks (deal_id, legal_entity_id, branch_id, booking_version_id, service_purpose, task_key,
        created_by, service_item_id, department)
      values (v_item.deal_id, v_item.legal_entity_id, v_item.branch_id, v_item.version_id, v_item.service_type,
        'item:' || v_item.id::text || ':' || v_item.service_type, (select auth.uid()), v_item.id, 'visa')
      on conflict (task_key) do nothing
      returning id into v_task;
      if v_task is null then
        continue;
      end if;
      v_created := v_created + 1;
      insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
      values (v_item.legal_entity_id, 'fulfilment_task', v_task, 'fulfilment.task_created',
        jsonb_build_object('task_id', v_task, 'version_id', v_item.version_id, 'deal_id', v_item.deal_id,
          'version_no', v_item.version_no, 'service_purpose', v_item.service_type,
          'service_item_id', v_item.id, 'service_type', v_item.service_type))
      on conflict (event_type, aggregate_id) do nothing;
      perform authz.write_audit('fulfilment.task_created', v_item.legal_entity_id, v_item.branch_id,
        'fulfilment_task', v_task, null,
        jsonb_build_object('dealId', v_item.deal_id, 'versionId', v_item.version_id, 'versionNo', v_item.version_no,
          'serviceItemId', v_item.id, 'serviceType', v_item.service_type, 'cause', 'desk_launch'));
    end loop;
  end if;
  return jsonb_build_object('key', p_key, 'changed', v_was is distinct from v_now, 'before', v_was, 'after', v_now,
    'updatedAt', v_after.updated_at)
    || case when p_key = 'visa_passport_tasks_enabled' then jsonb_build_object('tasksCreated', v_created, 'skipped', v_skipped)
            else '{}'::jsonb end;
end;
$$;

-- ===========================================================================
-- 4. Sync settings: preview, then apply with a reason (M1)
-- ===========================================================================

create table public.integration_sync_previews (
  id uuid primary key default gen_random_uuid(),
  config_id uuid not null references public.integration_intake_config (id) on delete cascade,  -- Echo-A L8
  legal_entity_id uuid not null references public.legal_entities (id),
  actor_user_id uuid not null,
  category_ids bigint[] not null,
  stage_ids text[] not null,
  cutoff_at timestamptz not null,
  sync_enabled boolean not null,
  lead_intake_mode text check (lead_intake_mode in ('manifest', 'scope')),
  deal_intake_mode text check (deal_intake_mode in ('manifest', 'scope')),
  config_snapshot jsonb not null,
  counts jsonb not null,
  -- Echo-A L1: md5 of the sorted Deal ids per action and reason; apply refuses
  -- a different set even with equal counts.
  plan_hash text not null check (plan_hash ~ '^[0-9a-f]{32}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz,
  check (expires_at > created_at)
);
comment on table public.integration_sync_previews is
  'Batch 4 (M1): one row per sync settings preview (proposed values, exact counts shown, configuration snapshot). Written and read only by integration_preview_sync_settings / integration_apply_sync_settings; valid 10 minutes, one use, the previewing person only. Not a business record.';
create index integration_sync_previews_actor_idx on public.integration_sync_previews (actor_user_id, created_at desc);
alter table public.integration_sync_previews enable row level security;
create policy require_valid_session on public.integration_sync_previews as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.integration_sync_previews from public, anon, authenticated, service_role;

-- The integration administrator of the one configuration (aal2) who holds no
-- Purchase role anywhere (Echo-A M1), or a refusal.
create function authz.sync_settings_manager() returns public.integration_intake_config
language plpgsql stable security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_n integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select count(*) into v_n from public.integration_intake_config;
  if v_n <> 1 then
    raise exception 'intake is not configured' using errcode = '55000';
  end if;
  select * into v_cfg from public.integration_intake_config;
  -- Echo-A M1: never a Purchase holder, whatever else they hold.
  if not coalesce(authz.can_admin('integration.manage', v_cfg.pilot_legal_entity_id), false)
     or authz.holds_purchase_anywhere() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return v_cfg;
end;
$$;

-- Validation of 20261119000400 (same messages). Returns the sync date as
-- 00:00 India time of that day.
create function authz.sync_settings_validate(p_category_ids bigint[], p_stage_ids text[], p_cutoff_at timestamptz,
  p_sync_enabled boolean, p_lead_intake_mode text, p_deal_intake_mode text) returns timestamptz
language plpgsql stable set search_path = '' as $$
begin
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
  if p_lead_intake_mode is not null and p_lead_intake_mode not in ('manifest', 'scope') then
    raise exception 'invalid Lead intake mode' using errcode = '22023';
  end if;
  if p_deal_intake_mode is not null and p_deal_intake_mode not in ('manifest', 'scope') then
    raise exception 'invalid Deal intake mode' using errcode = '22023';
  end if;
  return authz.ist_midnight(p_cutoff_at);
end;
$$;

-- Everything a preview depends on: any change between preview and apply makes
-- the preview stale.
create function authz.sync_scope_snapshot(p_cfg public.integration_intake_config) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'portal', p_cfg.portal_member_id, 'entity', p_cfg.pilot_legal_entity_id,
    'categoryIds', to_jsonb(authz.intake_categories(p_cfg)), 'stageIds', to_jsonb(p_cfg.eligible_stage_ids),
    'cutoffAt', p_cfg.cutoff_at, 'leadIntakeMode', p_cfg.lead_intake_mode, 'dealIntakeMode', p_cfg.deal_intake_mode,
    'entryStageIds', to_jsonb(p_cfg.deal_entry_stage_ids),
    'autoSync', (select s.enabled from public.integration_sync_schedule s where s.id))
$$;

-- The one predicate source for the Deals a sync settings save hides
-- ('hide', with the removal reason and whether CRM work exists) and brings
-- back ('bring_back'); the removal and restore queries of 20261119000400.
-- Synthetic Deals are never hidden (authz.remove_bitrix_deals skips them).
-- Nothing when the scope does not change.
create function authz.sync_scope_plan(p_cfg public.integration_intake_config, p_category_ids bigint[],
  p_stage_ids text[], p_cutoff timestamptz, p_changed boolean)
returns table (deal_id uuid, action text, reason text, has_work boolean)
language sql stable security definer set search_path = '' as $$
  select x.id, 'hide', x.reason, cardinality(authz.deal_crm_work(x.id)) > 0
  from (
    select d.id,
           case when not (d.source_category_id = any (p_category_ids)) then 'pipeline_not_eligible'
                when d.source_created_at < p_cutoff then 'before_sync_date'
                else 'stage_not_eligible' end reason
    from public.deals d
    where p_changed
      and d.source_system = 'bitrix' and d.source_portal = p_cfg.portal_member_id and d.removed_at is null
      and not d.is_synthetic
      and (not (d.source_category_id = any (p_category_ids))
           or d.source_created_at < p_cutoff
           or (d.source_stage_id = any (p_cfg.eligible_stage_ids) and not (d.source_stage_id = any (p_stage_ids))
               and not (d.source_stage_id = any (coalesce(p_cfg.deal_entry_stage_ids, '{}'::text[])))))
  ) x
  union all
  select d.id, 'bring_back', null, false
  from public.deals d
  where p_changed
    and d.source_system = 'bitrix' and d.source_portal = p_cfg.portal_member_id and d.removed_at is not null
    and d.source_category_id = any (p_category_ids) and d.source_created_at >= p_cutoff
    and (d.source_stage_id = any (coalesce(p_cfg.deal_entry_stage_ids, p_stage_ids))
         or (p_cfg.deal_entry_stage_ids is null and d.removed_reason = 'outside_entry_stage'))
$$;

create function authz.sync_scope_counts(p_cfg public.integration_intake_config, p_category_ids bigint[],
  p_stage_ids text[], p_cutoff timestamptz, p_changed boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'hide', jsonb_build_object(
      'total', count(*) filter (where p.action = 'hide'),
      'beforeSyncDate', count(*) filter (where p.action = 'hide' and p.reason = 'before_sync_date'),
      'pipelineNotEligible', count(*) filter (where p.action = 'hide' and p.reason = 'pipeline_not_eligible'),
      'stageNotEligible', count(*) filter (where p.action = 'hide' and p.reason = 'stage_not_eligible'),
      'withCrmWork', count(*) filter (where p.action = 'hide' and p.has_work)),
    'bringBack', count(*) filter (where p.action = 'bring_back'))
  from authz.sync_scope_plan(p_cfg, p_category_ids, p_stage_ids, p_cutoff, p_changed) p
$$;

-- Echo-A L1: identity of the plan (which Deals, which action and reason).
create function authz.sync_scope_hash(p_cfg public.integration_intake_config, p_category_ids bigint[],
  p_stage_ids text[], p_cutoff timestamptz, p_changed boolean) returns text
language sql stable security definer set search_path = '' as $$
  select md5(coalesce(string_agg(p.action || ':' || coalesce(p.reason, '') || ':' || p.deal_id::text, ','
                                 order by p.action, p.reason, p.deal_id), ''))
  from authz.sync_scope_plan(p_cfg, p_category_ids, p_stage_ids, p_cutoff, p_changed) p
$$;

-- Same change test as 20261119000400.
create function authz.sync_scope_changed(p_cfg public.integration_intake_config, p_category_ids bigint[],
  p_stage_ids text[], p_cutoff timestamptz, p_lead_mode text, p_deal_mode text) returns boolean
language sql stable set search_path = '' as $$
  select authz.intake_categories(p_cfg) is distinct from p_category_ids
    or p_cfg.eligible_stage_ids is distinct from p_stage_ids
    or p_cfg.cutoff_at is distinct from p_cutoff
    or coalesce(p_lead_mode, p_cfg.lead_intake_mode) is distinct from p_cfg.lead_intake_mode
    or coalesce(p_deal_mode, p_cfg.deal_intake_mode) is distinct from p_cfg.deal_intake_mode
$$;

create function public.integration_preview_sync_settings(
  p_category_ids bigint[], p_stage_ids text[], p_cutoff_at timestamptz, p_sync_enabled boolean,
  p_lead_intake_mode text default null, p_deal_intake_mode text default null
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_cutoff timestamptz;
  v_changed boolean;
  v_counts jsonb;
  v_snapshot jsonb;
  v_sync boolean;
  v_lead_mode text;
  v_deal_mode text;
  v_recheck integer := 0;
  v_scope integer;
  v_id uuid;
  v_expires timestamptz := now() + interval '10 minutes';
begin
  v_cfg := authz.sync_settings_manager();
  v_cutoff := authz.sync_settings_validate(p_category_ids, p_stage_ids, p_cutoff_at, p_sync_enabled,
                                           p_lead_intake_mode, p_deal_intake_mode);
  -- B1.1d guard of 20261119000400 (checked again under the lock by apply).
  if v_cfg.deal_entry_stage_ids is not null and exists (
       select 1 from unnest(v_cfg.deal_entry_stage_ids) s
       where not (authz.bitrix_stage_category(s) = any (p_category_ids))) then
    raise exception 'entry_stage_pipeline_required' using errcode = '22023';
  end if;
  v_lead_mode := coalesce(p_lead_intake_mode, v_cfg.lead_intake_mode);
  v_deal_mode := coalesce(p_deal_intake_mode, v_cfg.deal_intake_mode);
  v_changed := authz.sync_scope_changed(v_cfg, p_category_ids, p_stage_ids, v_cutoff, p_lead_intake_mode,
                                        p_deal_intake_mode);
  v_counts := authz.sync_scope_counts(v_cfg, p_category_ids, p_stage_ids, v_cutoff, v_changed);
  v_snapshot := authz.sync_scope_snapshot(v_cfg);
  v_sync := (v_snapshot ->> 'autoSync')::boolean;

  -- Bitrix records whose skipped events apply would check again (they may
  -- come in later; Bitrix decides).
  if v_changed then
    select count(*)::integer into v_recheck from (
      select distinct i.source_object, i.source_deal_id from public.integration_inbox i
      where i.portal_member_id = v_cfg.portal_member_id and i.status = 'ignored'
        and i.reason_code in ('not_eligible_category', 'not_eligible_stage', 'before_cutoff')) x;
    if v_lead_mode = 'scope' and v_cfg.lead_intake_mode is distinct from 'scope' then
      select least(count(distinct i.source_deal_id), 5000)::integer into v_scope from public.integration_inbox i
      where i.portal_member_id = v_cfg.portal_member_id and i.source_object = 'lead'
        and i.status = 'ignored' and i.reason_code = 'not_in_manifest' and i.received_at >= v_cutoff;
      v_recheck := v_recheck + v_scope;
    end if;
    if v_deal_mode = 'scope' and v_cfg.deal_intake_mode is distinct from 'scope' then
      select least(count(distinct i.source_deal_id), 5000)::integer into v_scope from public.integration_inbox i
      where i.portal_member_id = v_cfg.portal_member_id and i.source_object = 'deal'
        and i.status = 'ignored' and i.reason_code = 'not_in_manifest' and i.received_at >= v_cutoff;
      v_recheck := v_recheck + v_scope;
    end if;
  end if;

  insert into public.integration_sync_previews (config_id, legal_entity_id, actor_user_id, category_ids, stage_ids,
    cutoff_at, sync_enabled, lead_intake_mode, deal_intake_mode, config_snapshot, counts, plan_hash, expires_at)
  values (v_cfg.id, v_cfg.pilot_legal_entity_id, (select auth.uid()), p_category_ids, p_stage_ids, v_cutoff,
    p_sync_enabled, p_lead_intake_mode, p_deal_intake_mode, v_snapshot, v_counts,
    authz.sync_scope_hash(v_cfg, p_category_ids, p_stage_ids, v_cutoff, v_changed),  -- Echo-A L1
    v_expires)
  returning id into v_id;

  return jsonb_build_object(
    'previewId', v_id,
    'expiresAt', v_expires,
    'changed', v_changed,
    'current', jsonb_build_object('categoryIds', to_jsonb(authz.intake_categories(v_cfg)),
      'stageIds', to_jsonb(v_cfg.eligible_stage_ids), 'cutoffAt', v_cfg.cutoff_at, 'autoSync', v_sync,
      'leadIntakeMode', v_cfg.lead_intake_mode, 'dealIntakeMode', v_cfg.deal_intake_mode),
    'proposed', jsonb_build_object('categoryIds', to_jsonb(p_category_ids), 'stageIds', to_jsonb(p_stage_ids),
      'cutoffAt', v_cutoff, 'autoSync', p_sync_enabled, 'leadIntakeMode', v_lead_mode, 'dealIntakeMode', v_deal_mode),
    'hide', v_counts -> 'hide',
    'bringBack', v_counts -> 'bringBack',
    'recheck', v_recheck,
    'autoSyncChange', case when v_sync is not distinct from p_sync_enabled then 'none'
                           when p_sync_enabled then 'on' else 'off' end);
end;
$$;

comment on function public.integration_preview_sync_settings(bigint[], text[], timestamptz, boolean, text, text) is
  'Direction A Batch 4 (M1): validates proposed sync settings and returns exact counts of Deals that saving would hide (by reason, with CRM work) and bring back, with a previewId (10 minutes, one use, caller only) that integration_apply_sync_settings requires. Writes only the preview row.';

-- Apply = the body of public.integration_update_sync_settings
-- (20261119000400_b11_won_only_intake.sql:506) on the previewed values, with
-- the lines marked "Batch 4".
create function public.integration_apply_sync_settings(p_preview_id uuid, p_reason text) returns jsonb
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
  -- Batch 4
  v_reason text;
  v_p public.integration_sync_previews%rowtype;
  v_timeout text;
  v_prev text[];
  v_counts jsonb;
  v_hide_before uuid[];
  v_hide_pipeline uuid[];
  v_hide_stage uuid[];
  v_back uuid[];
  v_category_ids bigint[];
  v_stage_ids text[];
  v_locked uuid[];     -- Echo-A L2
  v_unlocked boolean;  -- Echo-A L2
begin
  v_cfg := authz.sync_settings_manager();
  v_reason := authz.settings_change_reason(p_reason);
  if p_preview_id is null then
    raise exception 'preview_required' using errcode = '55000';
  end if;
  -- Wait at most 5 s for the configuration row only (settings_busy).
  v_timeout := current_setting('lock_timeout');
  begin
    perform set_config('lock_timeout', '5s', true);
    select * into v_cfg from public.integration_intake_config c where c.id = v_cfg.id for update;
    perform set_config('lock_timeout', v_timeout, true);
  exception when lock_not_available then
    raise exception 'settings_busy' using errcode = '55P03';
  end;
  select * into v_p from public.integration_sync_previews p where p.id = p_preview_id for update;
  if v_p.id is null or v_p.actor_user_id is distinct from (select auth.uid()) or v_p.config_id <> v_cfg.id then
    raise exception 'preview_required' using errcode = '55000';
  end if;
  if v_p.used_at is not null then
    raise exception 'preview_used' using errcode = '55000';
  end if;
  if v_p.expires_at <= now() then
    raise exception 'preview_stale' using errcode = '40001', hint = 'expired';
  end if;
  if authz.sync_scope_snapshot(v_cfg) is distinct from v_p.config_snapshot then
    raise exception 'preview_stale' using errcode = '40001', hint = 'settings_changed';
  end if;
  v_category_ids := v_p.category_ids;
  v_stage_ids := v_p.stage_ids;
  v_cutoff := v_p.cutoff_at;

  -- B1.1d: while Won-only intake is on, every entry stage's pipeline stays
  -- ticked (unticking it would stop new Deals silently).
  if v_cfg.deal_entry_stage_ids is not null and exists (
       select 1 from unnest(v_cfg.deal_entry_stage_ids) s
       where not (authz.bitrix_stage_category(s) = any (v_category_ids))) then
    raise exception 'entry_stage_pipeline_required' using errcode = '22023';
  end if;
  -- Stage 6
  v_lead_mode := coalesce(v_p.lead_intake_mode, v_cfg.lead_intake_mode);
  v_deal_mode := coalesce(v_p.deal_intake_mode, v_cfg.deal_intake_mode);
  v_changed := authz.sync_scope_changed(v_cfg, v_category_ids, v_stage_ids, v_cutoff, v_p.lead_intake_mode,
                                        v_p.deal_intake_mode);

  -- Batch 4: the exact Deal sets the preview showed. Echo-A L2: lock the
  -- planned Deals first (configuration row -> Deals in id order, as the old
  -- command), then read the plan again under those locks. Echo-A L1: its
  -- counts AND its identity (which Deals, which action and reason) must equal
  -- the preview; every planned Deal must be one this call holds locked.
  select array_agg(x.id) into v_locked from (
    select d.id from public.deals d
    where d.id = any (array(select p.deal_id
                            from authz.sync_scope_plan(v_cfg, v_category_ids, v_stage_ids, v_cutoff, v_changed) p))
    order by d.id
    for update of d
  ) x;
  v_counts := authz.sync_scope_counts(v_cfg, v_category_ids, v_stage_ids, v_cutoff, v_changed);
  if v_counts is distinct from v_p.counts
     or authz.sync_scope_hash(v_cfg, v_category_ids, v_stage_ids, v_cutoff, v_changed) is distinct from v_p.plan_hash then
    raise exception 'preview_stale' using errcode = '40001', hint = 'counts_changed';
  end if;
  select array_agg(p.deal_id order by p.deal_id) filter (where p.action = 'hide' and p.reason = 'before_sync_date'),
         array_agg(p.deal_id order by p.deal_id) filter (where p.action = 'hide' and p.reason = 'pipeline_not_eligible'),
         array_agg(p.deal_id order by p.deal_id) filter (where p.action = 'hide' and p.reason = 'stage_not_eligible'),
         array_agg(p.deal_id order by p.deal_id) filter (where p.action = 'bring_back'),
         bool_or(not (p.deal_id = any (coalesce(v_locked, '{}'::uuid[]))))
  into v_hide_before, v_hide_pipeline, v_hide_stage, v_back, v_unlocked
  from authz.sync_scope_plan(v_cfg, v_category_ids, v_stage_ids, v_cutoff, v_changed) p;
  if coalesce(v_unlocked, false) then
    raise exception 'preview_stale' using errcode = '40001', hint = 'counts_changed';
  end if;

  v_prev := authz.settings_begin_change('integration_apply_sync_settings', v_reason);  -- Batch 4
  update public.integration_intake_config c
  set eligible_category_ids = v_category_ids, category_id = v_category_ids[1],
      eligible_stage_ids = v_stage_ids, cutoff_at = v_cutoff,
      -- Stage 6
      lead_intake_mode = coalesce(v_p.lead_intake_mode, c.lead_intake_mode),
      deal_intake_mode = coalesce(v_p.deal_intake_mode, c.deal_intake_mode),
      -- Lead watermark: a new scope pass or a new sync date lists from the start.
      lead_reconciled_at = case
        when (v_lead_mode = 'scope' and c.lead_intake_mode is distinct from 'scope')
             or c.cutoff_at is distinct from v_cutoff then null
        else c.lead_reconciled_at end,
      updated_at = now(), updated_by = auth.uid()
  where c.id = v_cfg.id;
  perform authz.settings_end_change(v_prev);  -- Batch 4

  if v_changed then
    -- Remove stored deals that no longer belong (Batch 4: exactly the previewed sets).
    if v_hide_pipeline is not null then
      v_removed := v_removed + authz.remove_bitrix_deals(v_hide_pipeline, 'pipeline_not_eligible');
    end if;
    if v_hide_before is not null then
      v_removed := v_removed + authz.remove_bitrix_deals(v_hide_before, 'before_sync_date');
    end if;
    if v_hide_stage is not null then
      v_removed := v_removed + authz.remove_bitrix_deals(v_hide_stage, 'stage_not_eligible');
    end if;
    if v_removed <> (v_p.counts -> 'hide' ->> 'total')::integer then
      raise exception 'preview_stale' using errcode = '40001', hint = 'counts_changed';
    end if;

    -- Restore removed deals that belong again: owner mapping re-applied,
    -- then a fresh crm.deal.get (inbox row) confirms the current state.
    -- Batch 4: exactly the previewed set, each still matching.
    if v_back is not null then
      with restored as (
        update public.deals d set removed_at = null, removed_reason = null
        where d.id = any (v_back) and d.removed_at is not null
          and d.source_category_id = any (v_category_ids) and d.source_created_at >= v_cutoff
          and (d.source_stage_id = any (coalesce(v_cfg.deal_entry_stage_ids, v_stage_ids))
               or (v_cfg.deal_entry_stage_ids is null and d.removed_reason = 'outside_entry_stage'))
        returning d.id
      )
      select array_agg(x.id) into v_ids from restored x;
      if coalesce(cardinality(v_ids), 0) <> cardinality(v_back) then
        raise exception 'preview_stale' using errcode = '40001', hint = 'counts_changed';
      end if;
    end if;
    if v_ids is not null then
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

  update public.integration_sync_schedule s set enabled = v_p.sync_enabled, updated_at = now() where s.id;
  update public.integration_sync_previews p set used_at = now() where p.id = v_p.id;  -- Batch 4

  perform authz.write_audit('integration.settings_updated', v_cfg.pilot_legal_entity_id, null,
    'integration_intake_config', v_cfg.id, v_reason,  -- Batch 4: reason
    jsonb_build_object('categoryIds', v_category_ids, 'stageCount', cardinality(v_stage_ids),
      'cutoffAt', v_cutoff, 'previousCutoffAt', v_cfg.cutoff_at, 'syncEnabled', v_p.sync_enabled,
      'requeued', v_requeued, 'removed', v_removed, 'restored', v_restored, 'resyncJobId', v_job,
      -- Stage 6
      'leadIntakeMode', coalesce(v_p.lead_intake_mode, v_cfg.lead_intake_mode),
      'previousLeadIntakeMode', v_cfg.lead_intake_mode,
      'dealIntakeMode', coalesce(v_p.deal_intake_mode, v_cfg.deal_intake_mode),
      'previousDealIntakeMode', v_cfg.deal_intake_mode,
      'scopeRequeuedLeads', v_scope_requeued_leads, 'scopeRequeuedDeals', v_scope_requeued_deals,
      -- Batch 4
      'previewId', v_p.id, 'hiddenByReason', v_p.counts -> 'hide', 'previousSyncEnabled', v_p.config_snapshot -> 'autoSync'));
  return jsonb_build_object('requeued', v_requeued, 'removed', v_removed, 'restored', v_restored,
    'resyncQueued', v_job is not null, 'cutoffAt', v_cutoff,
    -- Stage 6
    'leadIntakeMode', coalesce(v_p.lead_intake_mode, v_cfg.lead_intake_mode),
    'dealIntakeMode', coalesce(v_p.deal_intake_mode, v_cfg.deal_intake_mode),
    'scopeRequeuedLeads', v_scope_requeued_leads, 'scopeRequeuedDeals', v_scope_requeued_deals,
    -- Batch 4
    'previewId', v_p.id, 'hidden', v_p.counts -> 'hide', 'broughtBack', v_restored);
end;
$$;

comment on function public.integration_apply_sync_settings(uuid, text) is
  'Direction A Batch 4 (M1): saves exactly the values of a fresh, unused preview of the caller (integration_preview_sync_settings) with a reason of 10-500 characters; refuses preview_required / preview_used / preview_stale; hides and brings back exactly the previewed Deals. Audited with the reason.';

-- public.integration_update_sync_settings (replaces 20261119000400_b11_won_only_intake.sql:506).
-- Batch 4: same signature and grant; after authorization it refuses
-- preview_required. Saving goes through preview + apply with a reason.
create or replace function public.integration_update_sync_settings(
  p_category_ids bigint[], p_stage_ids text[], p_cutoff_at timestamptz, p_sync_enabled boolean,
  p_lead_intake_mode text default null,
  p_deal_intake_mode text default null
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform authz.require_manageable_intake();
  raise exception 'preview_required' using errcode = '55000',
    hint = 'integration_preview_sync_settings then integration_apply_sync_settings(preview, reason)';
end;
$$;

-- ===========================================================================
-- 5. Department task History (DA-16, History rule)
-- ===========================================================================

-- The people who open the task page today (Department task rule): Purchase
-- tasks: Purchase role holders and the branch Manager (read-only); Flight:
-- the Flight role; Visa and passport: the Visa role. Never Sales, Accounts or
-- Super Admin by role.
create function authz.can_read_task_history(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task
      and case t.department
            when 'purchase' then authz.can_read_purchase_task(t.id)
                                 and (authz.holds_active_role('purchase', t.legal_entity_id)
                                      or authz.is_branch_sales_manager(t.deal_id))
            when 'flight' then authz.can_read_flight_task(t.id)
            when 'visa' then authz.can_read_visa_task(t.id)
            else false end)
$$;

-- Events of one task, newest first (at most 200). Kinds come from an
-- allowlist; no event carries an amount, a price or any money detail, so the
-- same rows are safe for every reader of the task.
create function public.department_task_history(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_uid uuid := (select auth.uid());
  v_events jsonb;
  v_n integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_task_id is null or not authz.can_read_task_history(p_task_id) then
    return null;
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;

  with targets (target_type, target_id) as (
    select 'fulfilment_task', p_task_id
    union all select 'purchase_evidence', e.id from public.purchase_evidence e where e.task_id = p_task_id
    union all select 'department_evidence', e.id from public.department_evidence e where e.task_id = p_task_id
    union all select 'department_cost_entry', c.id from public.department_cost_entries c where c.task_id = p_task_id
    union all select 'visa_application', a.id from public.visa_applications a where a.task_id = p_task_id
  ), kinds (action, kind) as (
    values ('fulfilment.task_created', 'created'), ('fulfilment.task_claimed', 'taken'),
           ('fulfilment.task_released', 'released'), ('fulfilment.task_reassigned', 'reassigned'),
           ('fulfilment.task_completed', 'completed'),
           ('purchase.quote_added', 'offer_added'), ('purchase.quote_withdrawn', 'offer_withdrawn'),
           ('purchase.cost_proposed', 'cost_recorded'), ('purchase.cost_over_budget_approved', 'over_budget_approved'),
           ('purchase.supplier_confirmed', 'supplier_confirmed'),
           ('purchase.evidence_stored', 'file_added'), ('purchase.evidence_removed', 'file_removed'),
           ('department.evidence_stored', 'file_added'), ('department.evidence_removed', 'file_removed'),
           ('department.cost_saved', 'cost_recorded'), ('department.cost_submitted', 'sent_to_accounts'),
           ('finance.expense_record_accepted', 'accounts_accepted'),
           ('finance.expense_record_returned', 'accounts_returned'),
           ('visa.application_updated', 'applicant_updated'),
           ('visa.application_state_changed', 'applicant_stage'),
           ('visa.application_withdrawn_by_revision', 'applicant_withdrawn')
  ), picked as (
    select a.id, a.occurred_at, a.actor_user_id, a.action, a.reason, a.details, k.kind
    from targets t
    join public.audit_events a
      on a.target_id = t.target_id and a.target_type = t.target_type
     and a.target_type in ('fulfilment_task', 'purchase_evidence', 'department_evidence', 'department_cost_entry',
                           'visa_application')
    join kinds k on k.action = a.action
    order by a.occurred_at desc, a.id desc
    limit 201
  )
  select count(*)::integer,
         coalesce(jsonb_agg(jsonb_build_object(
           'at', p.occurred_at,
           'kind', p.kind,
           -- Names only where the task page already shows that person to its
           -- readers ("Taken by": the current assignee); yourself = byYou.
           'byName', case when p.actor_user_id is not null and p.actor_user_id = v_task.assignee_user_id then
                       (select s.display_name from public.staff_profiles s where s.user_id = p.actor_user_id) end,
           'byYou', p.actor_user_id is not null and p.actor_user_id = v_uid,
           'toName', case when p.kind = 'reassigned' and v_task.assignee_user_id is not null
                           and p.details ->> 'toUserId' = v_task.assignee_user_id::text then
                       (select s.display_name from public.staff_profiles s where s.user_id = v_task.assignee_user_id) end,
           'toYou', p.kind = 'reassigned' and p.details ->> 'toUserId' = v_uid::text,
           'applicantSeq', case when p.kind like 'applicant\_%' and jsonb_typeof(p.details -> 'seq') = 'number'
                                then p.details -> 'seq' end,
           'state', case when p.kind = 'applicant_stage' and jsonb_typeof(p.details -> 'to') = 'string'
                         then p.details ->> 'to' end,
           'note', case when p.kind in ('accounts_returned', 'applicant_withdrawn') then p.reason end)
           order by p.occurred_at desc, p.id desc) filter (where p.rn <= 200), '[]'::jsonb)
  into v_n, v_events
  from (select x.*, row_number() over (order by x.occurred_at desc, x.id desc) rn from picked x) p;

  return jsonb_build_object('taskId', v_task.id, 'department', v_task.department,
    'events', v_events, 'truncated', v_n > 200);
end;
$$;

comment on function public.department_task_history(uuid) is
  'Direction A Batch 4 (DA-16, History rule): events of one department task (the task, its offers, costs, files and visa applicants) for the people who open that task page today; allowlisted kinds; never an amount or money detail. Null = not found or not readable. Reads write nothing.';

-- ===========================================================================
-- 6. Privileges
-- ===========================================================================

revoke all on function authz.settings_last_change(text, uuid, uuid, text[], text), authz.switch_state(boolean),
  authz.visa_desk_launch_items(), authz.sync_settings_manager(),
  authz.sync_settings_validate(bigint[], text[], timestamptz, boolean, text, text),
  authz.sync_scope_snapshot(public.integration_intake_config),
  authz.sync_scope_plan(public.integration_intake_config, bigint[], text[], timestamptz, boolean),
  authz.sync_scope_counts(public.integration_intake_config, bigint[], text[], timestamptz, boolean),
  authz.sync_scope_changed(public.integration_intake_config, bigint[], text[], timestamptz, text, text),
  authz.sync_scope_hash(public.integration_intake_config, bigint[], text[], timestamptz, boolean),
  authz.holds_purchase_anywhere(),
  authz.can_read_task_history(uuid)
from public, anon, authenticated, service_role;

revoke all on function public.settings_switch_states(), public.workflow_visa_task_preview(),
  public.integration_preview_sync_settings(bigint[], text[], timestamptz, boolean, text, text),
  public.integration_apply_sync_settings(uuid, text), public.department_task_history(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.settings_switch_states(), public.workflow_visa_task_preview(),
  public.integration_preview_sync_settings(bigint[], text[], timestamptz, boolean, text, text),
  public.integration_apply_sync_settings(uuid, text), public.department_task_history(uuid)
to authenticated;

commit;
