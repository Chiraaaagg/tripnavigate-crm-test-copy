-- TripNavigate CRM - Accounts phase 3, track H (3 of 5): add or remove
-- services - the change version, submit and apply.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 11.1, 11.2, 11.3,
-- 10.4, 13, 17.1, 17.3, 19, 21 LD28, LD30, LD31, LD32, Addendum O1.
--
-- New internal helper (no grant):
--   authz.booking_create_item_tasks(p_version uuid, p_item_ids uuid[]) returns
--     uuid[]: the task-creation loop of booking_confirm, moved here unchanged
--     and used by both booking_confirm (all items) and the change apply (the
--     services an add_service request added, 11.2).
-- Replaced (latest bodies, same signatures; changed lines marked
-- "Accounts phase 3 (20261205000720)"):
--   public.booking_confirm (20261205000630, track G): calls the helper; same
--     behaviour (proved by the unchanged booking suites).
--   authz.service_items_revision_guard (20261119000300): a new service may be
--     added only into the change version of an approved add_service request
--     (recorded in its item_ids); everything else stays revision_items_fixed.
--   public.service_item_remove (20261118000100) - NOT in the contract's H list;
--     needed by 11.3 (reported to the lead): in a remove_service change version
--     the named service leaves that version only; a service added in an
--     add_service change version may be taken out again (item_ids follow).
--     Everything else is unchanged (item_locked).
--   public.booking_change_submit (20261205000640, track G): service switch;
--     add - the request's item_ids become exactly the services added (at least
--     one, hint no_service_added) and no existing service may change
--     (change_outside_request); remove - the service must be absent (hint
--     service_not_removed) and a simple removal still simple (hint
--     service_booked); reconfirmation rows only for a change.
--   authz.booking_change_apply (20261205000630, track G): add - one task per
--     new service (outbox fulfilment.task_created, the existing task_new
--     notice); remove - the service's open tasks close withdrawn | cancelled
--     under authz.task_transition = 'close' (audit fulfilment.task_closed),
--     the service is cancelled; audit booking.change_applied gains kind,
--     addedTaskIds, closedTaskIds (ids only). Lock order 17.1: finance head,
--     Deal, base, change version, the removed service's tasks by id, then the
--     request (via authz.cr_lock_apply).
--
-- Refusal tokens: revision_items_fixed (55000), service_changes_off,
-- change_outside_request (22023), not_ready (55000, hints no_service_added,
-- service_not_removed, service_booked, no_changes, first readiness code),
-- version_changed, wrong_state, item_locked, not_found.
-- Audit: fulfilment.task_closed {taskId, dealId, changeRequestId,
-- closedState, department, serviceItemId}; booking.service_item_removed.
-- Rollback (forward-only): a NEW migration restoring the cited bodies and
-- dropping the helper (no data is changed by this file).

begin;
set local lock_timeout = '15s';

-- The task-creation loop of booking_confirm (20261119000300:1370-1415, latest
-- body 20261205000630), moved here unchanged: exactly one task per item for its
-- department (visa / passport wait for the desk launch), outbox
-- fulfilment.task_created and audit fulfilment.task_created per task.
-- p_item_ids null = every item of the version (booking_confirm); otherwise only
-- those items (the services an applied add_service request added, 11.2).
-- The caller holds the version locked. Returns the tasks in item order.
create function authz.booking_create_item_tasks(p_version uuid, p_item_ids uuid[]) returns uuid[]
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_item record;
  v_key text;
  v_task uuid;
  v_task_version uuid;
  v_tasks uuid[] := '{}'::uuid[];
begin
  select * into v_ver from public.booking_versions v where v.id = p_version;
    -- Review V3: read the desk switch under a share lock so a concurrent
    -- switch-on either sees this version's items or is seen here.
    perform 1 from public.workflow_settings s where s.id for share;
    update public.service_items i set state = 'active', updated_at = now()
    where i.state = 'planned'
      and i.id in (select f.service_item_id from public.service_item_facts f where f.booking_version_id = v_ver.id)
      and (p_item_ids is null or i.id = any (p_item_ids));
    for v_item in
      select i.id, i.item_no, i.service_type, i.department
      from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
      where f.booking_version_id = v_ver.id
        and (p_item_ids is null or i.id = any (p_item_ids))
        -- B1.1: visa/passport tasks wait for the desk launch.
        and (i.service_type not in ('visa', 'passport') or authz.visa_passport_tasks_enabled())
      order by i.item_no
    loop
      v_key := 'item:' || v_item.id::text || ':' || v_item.service_type;
      v_task := null;
      insert into public.fulfilment_tasks
        (deal_id, legal_entity_id, branch_id, booking_version_id, service_purpose, task_key, created_by,
         service_item_id, department)
      values (v_ver.deal_id, v_ver.legal_entity_id, v_ver.branch_id, v_ver.id, v_item.service_type, v_key,
        (select auth.uid()), v_item.id, v_item.department)
      on conflict (task_key) do nothing
      returning id into v_task;
      if v_task is null then
        select t.id, t.booking_version_id into v_task, v_task_version
        from public.fulfilment_tasks t where t.task_key = v_key;
        if v_task_version is distinct from v_ver.id then
          raise exception 'task_conflict' using errcode = '40001';
        end if;
      end if;
      v_tasks := v_tasks || v_task;
      -- 9. Outbox per task (ids and types only).
      insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
      values (v_ver.legal_entity_id, 'fulfilment_task', v_task, 'fulfilment.task_created',
        jsonb_build_object('task_id', v_task, 'version_id', v_ver.id, 'deal_id', v_ver.deal_id,
          'version_no', v_ver.version_no, 'service_purpose', v_item.service_type,
          'service_item_id', v_item.id, 'service_type', v_item.service_type))
      on conflict (event_type, aggregate_id) do nothing;
      -- 10. Audit per task.
      perform authz.write_audit('fulfilment.task_created', v_ver.legal_entity_id, v_ver.branch_id,
        'fulfilment_task', v_task, null,
        jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no,
          'serviceItemId', v_item.id, 'serviceType', v_item.service_type));
    end loop;
  return v_tasks;
end;
$$;

-- Replaces 20261205000630_change_apply.sql:135 (latest body; changed lines marked).
create or replace function public.booking_confirm(p_version_id uuid, p_expected_content_hash text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_deal public.deals%rowtype;
  v_task uuid;
  v_task_version uuid;
  v_key text;
  v_env text;
  v_item record;
  v_hotel_item uuid;
  v_tasks uuid[] := '{}'::uuid[];
  -- B1.1 revision
  v_base public.booking_versions%rowtype;
  v_review text;
begin
  -- 1. Row lock: a concurrent confirmation waits here, then sees 'confirmed'.
  select * into v_ver from public.booking_versions v where v.id = p_version_id for update;
  -- Stage 0: a Deal removed by the Bitrix sync takes no new booking work.
  perform authz.refuse_removed_deal(v_ver.deal_id);
  -- 2. Existence is not revealed.
  if v_ver.id is null or not authz.can_confirm_booking(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- 3. Repeat / concurrent confirmation: every task of the version, item order.
  if v_ver.status = 'confirmed' then
    -- B1.1 revision: a package version's tasks are its items' tasks (a revision creates none).
    select coalesce(array_agg(t.id order by i.item_no, t.created_at), '{}'::uuid[]) into v_tasks
    from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
    where t.booking_version_id = v_ver.id
       or (v_ver.service_type = 'package' and t.service_item_id in (
             select f.service_item_id from public.service_item_facts f where f.booking_version_id = v_ver.id));
    if cardinality(v_tasks) > 0 or v_ver.service_type = 'package' then
      return jsonb_build_object('outcome', 'existing', 'taskId', v_tasks[1], 'versionId', v_ver.id,
        'taskIds', to_jsonb(v_tasks));
    end if;
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  -- Accounts phase 3 (20261205000630): a change version is confirmed only by the change flow.
  if v_ver.change_request_id is not null then
    raise exception 'use_change_flow' using errcode = '55000';
  end if;
  -- B1: a package version confirms only while the switch is on.
  if v_ver.service_type = 'package' and not authz.service_items_enabled() then
    raise exception 'service_items_disabled' using errcode = '55000';
  end if;
  -- 4. Optimistic check against the live hash.
  if p_expected_content_hash is null or p_expected_content_hash <> authz.booking_content_hash(v_ver.id) then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  -- 5. Gate.
  select * into v_deal from public.deals d where d.id = v_ver.deal_id;
  v_env := authz.deployment_environment();
  if v_env = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if not v_deal.is_synthetic
     and not coalesce((select s.real_booking_enabled from public.booking_settings s where s.id), false) then
    raise exception 'booking_disabled' using errcode = '55000';
  end if;
  if v_deal.is_synthetic and v_env <> 'test' then
    raise exception 'booking_disabled' using errcode = '55000';
  end if;
  -- B1.1 revision: the base must still be the accepted version, returned by
  -- Accounts, with no supplier-confirmed or completed work on the Deal.
  if v_ver.revises_version_id is not null then
    select * into v_base from public.booking_versions b where b.id = v_ver.revises_version_id for update;
    if v_base.status <> 'confirmed' then
      raise exception 'version_superseded' using errcode = '55000';
    end if;
    select rv.status into v_review from public.accounts_booking_reviews rv where rv.booking_version_id = v_base.id for update;
    if v_review is distinct from 'returned' then
      raise exception 'revision_not_allowed' using errcode = '55000';
    end if;
    if authz.deal_committed(v_ver.deal_id) then
      raise exception 'already_committed' using errcode = '55000';
    end if;
    -- Review R1: the recorded class must still match the actual changes.
    if v_ver.change_class is null or v_ver.changed_fields is distinct from authz.revision_changed_fields(v_ver.id)
       or not (v_ver.change_class = any (authz.revision_allowed_classes(authz.revision_changed_fields(v_ver.id)))) then
      raise exception 'not_ready' using errcode = '55000';
    end if;
  end if;
  -- 6. Readiness (package versions: includes stage_not_confirmed, no_services, ...).
  if cardinality(authz.booking_issues(v_ver.id)) > 0 then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if v_ver.service_type <> 'package' then
    -- Legacy hotel version: the Deal's hotel item and its facts snapshot.
    v_hotel_item := authz.hotel_item_for_deal(v_ver.deal_id, v_ver.created_by, v_ver.created_at);
    perform authz.hotel_facts_sync(v_ver.id, v_hotel_item);
  end if;
  -- Accounts phase 3 (20261205000630): traveller snapshot, supersede and freeze moved to authz.booking_version_freeze.
  v_ver := authz.booking_version_freeze(v_ver.id, case when v_ver.revises_version_id is not null then v_base.id end);
  -- B1.1 revision: no new task; the items' existing tasks continue.
  if v_ver.revises_version_id is not null then
    select coalesce(array_agg(t.id order by i.item_no, t.created_at), '{}'::uuid[]) into v_tasks
    from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
    where t.service_item_id in (select f.service_item_id from public.service_item_facts f where f.booking_version_id = v_ver.id);
    insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
    values (v_ver.legal_entity_id, 'booking_version', v_ver.id, 'booking.version_revised',
      jsonb_build_object('version_id', v_ver.id, 'deal_id', v_ver.deal_id, 'version_no', v_ver.version_no,
        'base_version_id', v_base.id))
    on conflict (event_type, aggregate_id) do nothing;
    perform authz.write_audit('booking.version_superseded', v_base.legal_entity_id, v_base.branch_id, 'booking_version',
      v_base.id, null, jsonb_build_object('dealId', v_base.deal_id, 'versionNo', v_base.version_no,
        'supersededByVersionId', v_ver.id));
    perform authz.write_audit('booking.version_revised', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version',
      v_ver.id, null, jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'baseVersionId', v_base.id,
        'changeClass', v_ver.change_class, 'changedFields', to_jsonb(coalesce(v_ver.changed_fields, '{}'::text[])),
        'taskIds', to_jsonb(v_tasks)));
    return jsonb_build_object('outcome', 'revised', 'versionId', v_ver.id, 'supersededVersionId', v_base.id,
      'taskId', v_tasks[1], 'taskIds', to_jsonb(v_tasks));
  end if;
  -- 8. Exactly one task per item (hotel path: one task, legacy key).
  if v_ver.service_type = 'package' then
    -- Accounts phase 3 (20261205000720): the task-creation loop moved unchanged to
    -- authz.booking_create_item_tasks (used by the change apply too, 11.2).
    v_tasks := authz.booking_create_item_tasks(v_ver.id, null);
    insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
    values (v_ver.legal_entity_id, 'booking_version', v_ver.id, 'booking.version_confirmed',
      jsonb_strip_nulls(jsonb_build_object('version_id', v_ver.id, 'deal_id', v_ver.deal_id, 'task_id', v_tasks[1],
        'version_no', v_ver.version_no, 'service_purpose', 'package')))
    on conflict (event_type, aggregate_id) do nothing;
    perform authz.write_audit('booking.version_confirmed', v_ver.legal_entity_id, v_ver.branch_id,
      'booking_version', v_ver.id, null,
      jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'taskId', v_tasks[1],
        'taskIds', to_jsonb(v_tasks), 'serviceType', 'package'));
    return jsonb_build_object('outcome', 'created', 'taskId', v_tasks[1], 'versionId', v_ver.id,
      'taskIds', to_jsonb(v_tasks));
  end if;

  v_key := 'booking:' || v_ver.id::text || ':hotel';
  insert into public.fulfilment_tasks
    (deal_id, legal_entity_id, branch_id, booking_version_id, service_purpose, task_key, created_by, service_item_id)
  values (v_ver.deal_id, v_ver.legal_entity_id, v_ver.branch_id, v_ver.id, 'hotel', v_key, (select auth.uid()),
    v_hotel_item)
  on conflict (task_key) do nothing
  returning id into v_task;
  if v_task is null then
    select t.id, t.booking_version_id into v_task, v_task_version
    from public.fulfilment_tasks t where t.task_key = v_key;
    if v_task_version is distinct from v_ver.id then
      raise exception 'task_conflict' using errcode = '40001';
    end if;
  end if;
  update public.service_items i set state = 'active', updated_at = now()
  where i.id = v_hotel_item and i.state = 'planned';
  -- 9. Outbox (ids only).
  insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
  values
    (v_ver.legal_entity_id, 'booking_version', v_ver.id, 'booking.version_confirmed',
     jsonb_build_object('version_id', v_ver.id, 'deal_id', v_ver.deal_id, 'task_id', v_task,
       'version_no', v_ver.version_no, 'service_purpose', 'hotel')),
    (v_ver.legal_entity_id, 'fulfilment_task', v_task, 'fulfilment.task_created',
     jsonb_build_object('task_id', v_task, 'version_id', v_ver.id, 'deal_id', v_ver.deal_id,
       'version_no', v_ver.version_no, 'service_purpose', 'hotel'))
  on conflict (event_type, aggregate_id) do nothing;
  -- 10. Audit: ids and version_no only.
  perform authz.write_audit('booking.version_confirmed', v_ver.legal_entity_id, v_ver.branch_id,
    'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'taskId', v_task));
  perform authz.write_audit('fulfilment.task_created', v_ver.legal_entity_id, v_ver.branch_id,
    'fulfilment_task', v_task, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no));
  -- 11.
  return jsonb_build_object('outcome', 'created', 'taskId', v_task, 'versionId', v_ver.id,
    'taskIds', jsonb_build_array(v_task));
end;
$$;

-- Replaces 20261119000300_b11_revision.sql:277 (latest body; changed lines marked).
create or replace function authz.service_items_revision_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
begin
  select * into v_ver from public.booking_versions v
  where v.deal_id = new.deal_id and v.status = 'draft' and v.revises_version_id is not null
  limit 1;
  if v_ver.id is not null then
    -- Accounts phase 3 (20261205000720): the change version of an approved add_service request
    -- takes new services; each is recorded in the request's item_ids (11.2).
    if v_ver.change_request_id is not null and exists (
         select 1 from public.booking_change_requests r
         where r.id = v_ver.change_request_id and r.kind = 'add_service' and r.status = 'approved') then
      update public.booking_change_requests r set item_ids = r.item_ids || new.id
      where r.id = v_ver.change_request_id and not (new.id = any (r.item_ids));
      return new;
    end if;
    raise exception 'revision_items_fixed' using errcode = '55000';
  end if;
  return new;
end;
$$;

-- Replaces 20261118000100_b1_service_items.sql:1456 (latest body; changed lines marked).
create or replace function public.service_item_remove(p_item_id uuid, p_version_id uuid, p_expected_row_version integer)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_item public.service_items%rowtype;
  v_cr public.booking_change_requests%rowtype;  -- Accounts phase 3 (20261205000720)
begin
  v_ver := authz.lock_package_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  -- Accounts phase 3 (20261205000720): in the change version of a remove_service request the
  -- named service leaves this version only (it stays in the accepted versions;
  -- the apply closes its task). booking_change_open_version already left it out.
  if v_ver.change_request_id is not null then
    select * into v_cr from public.booking_change_requests r where r.id = v_ver.change_request_id;
    if v_cr.kind = 'remove_service' and p_item_id = any (v_cr.item_ids) and v_cr.status = 'approved' then
      select i.* into v_item from public.service_items i where i.id = p_item_id and i.deal_id = v_ver.deal_id;
      if exists (select 1 from public.service_item_facts f where f.service_item_id = p_item_id and f.booking_version_id = v_ver.id) then
        delete from public.service_item_facts f where f.service_item_id = p_item_id and f.booking_version_id = v_ver.id;
        v_ver := authz.bump_package_version(v_ver.id);
        perform authz.write_audit('booking.service_item_removed', v_ver.legal_entity_id, v_ver.branch_id,
          'service_item', v_item.id, null,
          jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no,
            'itemNo', v_item.item_no, 'serviceType', v_item.service_type, 'rowVersion', v_ver.row_version,
            'changeRequestId', v_cr.id));
      end if;
      return jsonb_build_object('removed', true, 'rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
    end if;
  end if;
  select i.* into v_item from public.service_items i where i.id = p_item_id and i.deal_id = v_ver.deal_id for update;
  if v_item.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_item.state <> 'planned' or exists (
       select 1 from public.service_item_facts f join public.booking_versions v on v.id = f.booking_version_id
       where f.service_item_id = v_item.id and v.status = 'confirmed') then
    raise exception 'item_locked' using errcode = '55000';
  end if;

  delete from public.service_item_facts f where f.service_item_id = v_item.id;
  perform set_config('tripnavigate.service_item_remove', v_item.id::text, true);
  delete from public.service_items i where i.id = v_item.id;
  perform set_config('tripnavigate.service_item_remove', '', true);
  -- Accounts phase 3 (20261205000720): a service added in an add_service change version and taken out again.
  if v_cr.kind = 'add_service' then
    update public.booking_change_requests r set item_ids = array_remove(r.item_ids, v_item.id)
    where r.id = v_cr.id and v_item.id = any (r.item_ids);
  end if;
  v_ver := authz.bump_package_version(v_ver.id);

  perform authz.write_audit('booking.service_item_removed', v_ver.legal_entity_id, v_ver.branch_id,
    'service_item', v_item.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no,
      'itemNo', v_item.item_no, 'serviceType', v_item.service_type, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('removed', true, 'rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;

-- Replaces 20261205000640_change_reconfirmation.sql:405 (latest body; changed lines marked).
create or replace function public.booking_change_submit(p_change_request_id uuid, p_expected_content_hash text,
  p_expected_changed_item_ids uuid[], p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.booking_change_requests%rowtype;
  v_payload jsonb := jsonb_build_object('changeRequestId', p_change_request_id, 'contentHash', p_expected_content_hash,
    'changedItemIds', to_jsonb(p_expected_changed_item_ids));
  v_result jsonb;
  v_ver public.booking_versions%rowtype;
  v_fields text[];
  v_changed uuid[];
  v_outside text;
  v_expected uuid[];
  v_class text;
  v_issues text[];
  v_n integer := 0;
  v_applied boolean := false;
  v_added uuid[];  -- Accounts phase 3 (20261205000720)
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_row from public.booking_change_requests r where r.id = p_change_request_id;
  if v_row.id is null
     or not ((v_row.requested_by = v_uid and authz.cr_requester_role(v_row.deal_id) is not null)
             or authz.refund_is_so(v_row.deal_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.refuse_removed_deal(v_row.deal_id);
  if p_request_id is null then
    perform authz.cr_invalid('requestId');
  end if;
  v_row := authz.cr_lock_apply(p_change_request_id);
  v_result := authz.finance_replay(v_row.legal_entity_id, p_request_id, 'booking_change_submit', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_row.status <> 'approved' or v_row.change_version_id is null then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if v_row.kind = 'change' and not authz.booking_changes_enabled() then
    raise exception 'changes_off' using errcode = '55000';
  end if;
  -- Accounts phase 3 (20261205000720): adding or removing a service needs its own switch.
  if v_row.kind <> 'change' and not authz.service_changes_enabled() then
    raise exception 'service_changes_off' using errcode = '55000';
  end if;
  if not exists (select 1 from public.booking_versions b where b.id = v_row.base_version_id and b.status = 'confirmed') then
    raise exception 'version_superseded' using errcode = '55000';
  end if;
  select * into v_ver from public.booking_versions v where v.id = v_row.change_version_id;
  if v_ver.status <> 'draft' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_expected_content_hash is null or p_expected_content_hash <> authz.booking_content_hash(v_ver.id) then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_fields := authz.revision_changed_fields(v_ver.id);
  if cardinality(v_fields) = 0 then
    raise exception 'not_ready' using errcode = '55000', hint = 'no_changes';
  end if;
  -- LD28: every service whose facts changed is named in the approved request.
  v_changed := authz.cr_changed_item_ids(v_ver.id);
  -- Accounts phase 3 (20261205000720): add - the request names exactly the services added
  -- in the change version (no existing service may change, 11.2); remove - the
  -- service is gone from the version, and a simple removal must still be simple.
  if v_row.kind = 'add_service' then
    select coalesce(array_agg(f.service_item_id order by f.service_item_id), '{}'::uuid[]) into v_added
    from public.service_item_facts f
    where f.booking_version_id = v_ver.id
      and not exists (select 1 from public.service_item_facts b
                      where b.booking_version_id = v_row.base_version_id and b.service_item_id = f.service_item_id);
    if cardinality(v_added) = 0 then
      raise exception 'not_ready' using errcode = '55000', hint = 'no_service_added';
    end if;
    if v_added is distinct from v_row.item_ids then
      update public.booking_change_requests r set item_ids = v_added where r.id = v_row.id
      returning * into v_row;
    end if;
  elsif v_row.kind = 'remove_service' then
    if exists (select 1 from public.service_item_facts f
               where f.booking_version_id = v_ver.id and f.service_item_id = any (v_row.item_ids)) then
      raise exception 'not_ready' using errcode = '55000', hint = 'service_not_removed';
    end if;
    if v_row.removal_route = 'simple' and authz.cr_removal_route(v_row.item_ids[1]) = 'cancellation' then
      raise exception 'not_ready' using errcode = '55000', hint = 'service_booked';
    end if;
  end if;
  select string_agg(i.item_no::text, ',' order by i.item_no) into v_outside
  from public.service_items i
  where i.id = any (v_changed) and not (i.id = any (v_row.item_ids));
  if v_outside is not null then
    raise exception 'change_outside_request' using errcode = '22023', hint = v_outside;
  end if;
  -- The set the screen showed.
  select coalesce(array_agg(distinct x order by x), '{}'::uuid[]) into v_expected
  from unnest(coalesce(p_expected_changed_item_ids, '{}'::uuid[])) x;
  if v_expected is distinct from v_changed then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  -- The weakest allowed class, for the history view.
  v_class := (authz.revision_allowed_classes(v_fields))[1];
  update public.booking_versions v set change_class = v_class, changed_fields = v_fields, updated_at = now(),
    updated_by = v_uid
  where v.id = v_ver.id
  returning * into v_ver;
  v_issues := authz.booking_issues(v_ver.id);
  if cardinality(v_issues) > 0 then
    raise exception 'not_ready' using errcode = '55000', hint = v_issues[1];
  end if;

  -- One pending reconfirmation per changed Purchase service whose supplier confirmed (LD27: Flight and Visa keep their own steps).
  insert into public.task_reconfirmations (legal_entity_id, change_request_id, task_id, booking_version_id, budget_paise)
  select t.legal_entity_id, v_row.id, t.id, v_ver.id, f.purchase_budget_paise
  from public.fulfilment_tasks t
  left join public.service_item_facts f on f.service_item_id = t.service_item_id and f.booking_version_id = v_ver.id
  where t.deal_id = v_row.deal_id and t.service_item_id = any (v_changed)
    and t.department = 'purchase' and t.status = 'supplier_confirmed'
    -- Accounts phase 3 (20261205000720): only a change is reconfirmed (an added service is
    -- booked afresh; a removed one ends through the apply).
    and v_row.kind = 'change' and t.closed_state is null
  order by t.id;
  get diagnostics v_n = row_count;

  update public.booking_change_requests r
  set status = 'submitted', submitted_by = v_uid, submitted_at = now(), changed_fields = v_fields, change_class = v_class,
      row_version = r.row_version + 1
  where r.id = v_row.id
  returning * into v_row;
  perform authz.write_audit('booking.change_submitted', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request', v_row.id,
    null, jsonb_build_object('changeRequestId', v_row.id, 'dealId', v_row.deal_id, 'versionId', v_ver.id,
      'reconfirmations', v_n, 'changedItemCount', cardinality(v_changed)));
  if v_n = 0 then
    v_applied := authz.cr_apply_if_ready(v_row.id);
  end if;
  select * into v_row from public.booking_change_requests r where r.id = v_row.id;
  v_result := authz.cr_json(v_row) || jsonb_build_object('outcome', 'updated', 'reconfirmations', v_n, 'applied', v_applied);
  return authz.finance_remember(v_row.legal_entity_id, p_request_id, 'booking_change_submit', v_payload, v_result);
end;
$$;

-- Replaces 20261205000630_change_apply.sql:553 (latest body; changed lines marked).
create or replace function authz.booking_change_apply(p_change_request uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.booking_change_requests%rowtype;
  v_base public.booking_versions%rowtype;
  v_ver public.booking_versions%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_cost public.purchase_cost_versions;
  r public.task_reconfirmations%rowtype;
  v_next integer;
  v_conf integer;
  v_tasks uuid[] := '{}'::uuid[];
  v_pre public.booking_change_requests%rowtype;  -- Accounts phase 3 (20261205000720)
  v_added uuid[] := '{}'::uuid[];
  v_closed uuid[] := '{}'::uuid[];
  v_t public.fulfilment_tasks%rowtype;
  v_state text;
begin
  -- Accounts phase 3 (20261205000720): lock order 17.1 for a removal - the removed service's
  -- tasks (by id) are locked after the versions and before the request row
  -- (authz.cr_lock_apply then takes the same locks again and the rest).
  select * into v_pre from public.booking_change_requests q where q.id = p_change_request;
  if v_pre.kind = 'remove_service' then
    perform authz.finance_lock_deal(v_pre.deal_id);
    perform 1 from public.deals d where d.id = v_pre.deal_id for no key update;
    perform 1 from public.booking_versions b where b.id = v_pre.base_version_id for update;
    perform 1 from public.booking_versions b where b.id = v_pre.change_version_id for update;
    perform 1 from public.fulfilment_tasks t
    where t.deal_id = v_pre.deal_id and t.service_item_id = any (v_pre.item_ids) order by t.id for update;
  end if;
  v_row := authz.cr_lock_apply(p_change_request);
  if v_row.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_row.status <> 'submitted' or v_row.change_version_id is null then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if exists (select 1 from public.task_reconfirmations x
             where x.change_request_id = v_row.id
               and (x.status = 'pending' or (x.status = 'recorded' and x.over_budget and x.over_budget_approved_by is null))) then
    raise exception 'not_ready' using errcode = '55000', hint = 'reconfirmation_open';
  end if;
  select * into v_base from public.booking_versions b where b.id = v_row.base_version_id;
  select * into v_ver from public.booking_versions b where b.id = v_row.change_version_id;
  if v_base.status <> 'confirmed' then
    raise exception 'version_superseded' using errcode = '55000';
  end if;
  if v_ver.status <> 'draft' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;

  -- 5 (first, so the automatic bill checks below see no live change).
  update public.booking_change_requests q set status = 'applied', applied_at = now(), row_version = q.row_version + 1
  where q.id = v_row.id
  returning * into v_row;

  -- 1. Freeze the change version and supersede the base.
  perform set_config('tripnavigate.change_apply', v_ver.id::text, true);
  v_ver := authz.booking_version_freeze(v_ver.id, v_base.id);
  perform set_config('tripnavigate.change_apply', '', true);

  -- 2. The Manager's approval stands in for the Accounts review (LD24).
  insert into public.accounts_booking_reviews (booking_version_id, deal_id, legal_entity_id, status, approval_source,
    change_request_id)
  values (v_ver.id, v_ver.deal_id, v_ver.legal_entity_id, 'approved', 'change_request', v_row.id);

  -- 3. Recorded reconfirmations become the task's new committed cost and confirmation.
  for r in
    select * from public.task_reconfirmations x
    where x.change_request_id = v_row.id and x.status = 'recorded' order by x.task_id
  loop
    select * into v_task from public.fulfilment_tasks t where t.id = r.task_id;
    v_cost := authz.purchase_latest_cost(v_task.id);
    select coalesce(max(c.version_no), 0) into v_next from public.purchase_cost_versions c where c.task_id = v_task.id;
    select coalesce(max(c.confirmation_no), 0) + 1 into v_conf from public.task_confirmations c where c.task_id = v_task.id;
    insert into public.purchase_cost_versions (task_id, legal_entity_id, version_no, quote_id, request_id, stage,
      amount_paise, due_date, note, created_by, confirmation_no, change_fee_paise)
    values (v_task.id, v_task.legal_entity_id, v_next + 1, v_task.selected_quote_id, gen_random_uuid(), 'proposed',
      r.new_rate_paise + r.supplier_fee_paise, v_cost.due_date, null, r.recorded_by, v_conf, r.supplier_fee_paise);
    insert into public.purchase_cost_versions (task_id, legal_entity_id, version_no, quote_id, request_id, stage,
      amount_paise, due_date, note, created_by, confirmation_no, change_fee_paise)
    values (v_task.id, v_task.legal_entity_id, v_next + 2, v_task.selected_quote_id, gen_random_uuid(), 'committed',
      r.new_rate_paise + r.supplier_fee_paise, v_cost.due_date, null, coalesce(v_uid, r.recorded_by), v_conf, r.supplier_fee_paise);
    if r.over_budget then
      -- The agreed (proposed) cost carries the approval, bound to the new version.
      insert into public.purchase_cost_approvals (task_id, legal_entity_id, version_no, approved_by, approved_at,
        booking_version_id, reconfirmation_id)
      values (v_task.id, v_task.legal_entity_id, v_next + 1, r.over_budget_approved_by, r.over_budget_approved_at,
        v_ver.id, r.id);
    end if;
    perform set_config('authz.task_transition', 'reconfirm', true);
    update public.fulfilment_tasks t
    set supplier_reference = r.new_reference, supplier_confirmed_by = r.recorded_by, supplier_confirmed_at = r.recorded_at,
        updated_at = now()
    where t.id = v_task.id;
    perform set_config('authz.task_transition', '', true);
    insert into public.task_confirmations (legal_entity_id, task_id, confirmation_no, quote_id, committed_version_no, amount_paise,
      change_fee_paise, supplier_reference, evidence_ids, booking_version_id, change_request_id, confirmed_by, confirmed_at)
    values (v_task.legal_entity_id, v_task.id, v_conf, v_task.selected_quote_id, v_next + 2, r.new_rate_paise + r.supplier_fee_paise,
      r.supplier_fee_paise, r.new_reference, array[r.evidence_id], v_ver.id, v_row.id, r.recorded_by, r.recorded_at);
    -- The Purchase person reconfirmed against the change version: that is their new basis.
    insert into public.purchase_task_basis (task_id, legal_entity_id, deal_id, basis_version_id, seen_by, seen_at)
    values (v_task.id, v_task.legal_entity_id, v_task.deal_id, v_ver.id, r.recorded_by, now())
    on conflict (task_id) do update
      set basis_version_id = excluded.basis_version_id, seen_by = excluded.seen_by, seen_at = excluded.seen_at,
          row_version = public.purchase_task_basis.row_version + 1, updated_at = now();
    update public.task_reconfirmations x set status = 'applied', row_version = x.row_version + 1 where x.id = r.id;
  end loop;

  -- Accounts phase 3 (20261205000720): add a service - one task per new service for its
  -- department (the task-creation loop of booking_confirm, 11.2).
  if v_row.kind = 'add_service' then
    v_added := authz.booking_create_item_tasks(v_ver.id, v_row.item_ids);
  end if;
  -- Accounts phase 3 (20261205000720): remove a service - its open task(s) close (withdrawn for
  -- a simple removal, cancelled for a booked one; status unchanged, LD31) and
  -- the service is cancelled. Supplier refunds expected follow from the charge
  -- rows of this request (authz.supplier_refund_sources); no deal_cancellations
  -- row is written (LD30).
  if v_row.kind = 'remove_service' then
    v_state := case when v_row.removal_route = 'cancellation' then 'cancelled' else 'withdrawn' end;
    for v_t in
      select t.* from public.fulfilment_tasks t
      where t.deal_id = v_row.deal_id and t.service_item_id = any (v_row.item_ids) and t.closed_state is null
      order by t.id
    loop
      perform set_config('authz.task_transition', 'close', true);
      update public.fulfilment_tasks t
      set closed_state = v_state, closed_at = now(), closed_by = coalesce(v_uid, v_row.decided_by),
          closed_change_request_id = v_row.id, updated_at = now()
      where t.id = v_t.id;
      perform set_config('authz.task_transition', '', true);
      perform authz.write_audit('fulfilment.task_closed', v_t.legal_entity_id, v_t.branch_id, 'fulfilment_task', v_t.id, null,
        jsonb_build_object('taskId', v_t.id, 'dealId', v_t.deal_id, 'changeRequestId', v_row.id, 'closedState', v_state,
          'department', v_t.department, 'serviceItemId', v_t.service_item_id));
      v_closed := v_closed || v_t.id;
    end loop;
    perform set_config('tripnavigate.service_item_cancel', v_row.item_ids[1]::text, true);
    update public.service_items i set state = 'cancelled', updated_at = now()
    where i.id = v_row.item_ids[1] and i.state <> 'cancelled';
    perform set_config('tripnavigate.service_item_cancel', '', true);
  end if;

  -- Every task of the new version's services (the history and notices name them).
  select coalesce(array_agg(t.id order by i.item_no, t.created_at), '{}'::uuid[]) into v_tasks
  from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
  where t.service_item_id in (select f.service_item_id from public.service_item_facts f where f.booking_version_id = v_ver.id);

  -- 4. Supplier money: a supplier refund expected is computed from verified
  -- payments and the new committed cost (authz.supplier_refund_sources).

  -- 5. Outbox and audit.
  insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
  values (v_ver.legal_entity_id, 'booking_version', v_ver.id, 'booking.version_revised',
    jsonb_build_object('version_id', v_ver.id, 'deal_id', v_ver.deal_id, 'version_no', v_ver.version_no,
      'base_version_id', v_base.id))
  on conflict (event_type, aggregate_id) do nothing;
  perform authz.write_audit('booking.version_superseded', v_base.legal_entity_id, v_base.branch_id, 'booking_version',
    v_base.id, null, jsonb_build_object('dealId', v_base.deal_id, 'versionNo', v_base.version_no,
      'supersededByVersionId', v_ver.id, 'changeRequestId', v_row.id));
  perform authz.write_audit('booking.change_applied', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request', v_row.id,
    null, jsonb_build_object('changeRequestId', v_row.id, 'versionId', v_ver.id, 'baseVersionId', v_base.id,
      'taskIds', to_jsonb(v_tasks),
      -- Accounts phase 3 (20261205000720): ids only.
      'kind', v_row.kind, 'addedTaskIds', to_jsonb(v_added), 'closedTaskIds', to_jsonb(v_closed)));

  -- 6. Bills and the customer message (never fail this transaction).
  perform authz.cdoc_auto_run(v_row.deal_id, 'inv_replace_on_change');
  perform authz.cmsg_enqueue(v_row.deal_id, 'booking_changed', 'cr:' || v_row.id::text, '{}'::jsonb, null);

  return jsonb_build_object('changeRequestId', v_row.id, 'status', v_row.status, 'versionId', v_ver.id,
    'baseVersionId', v_base.id, 'taskIds', to_jsonb(v_tasks),
    'addedTaskIds', to_jsonb(v_added), 'closedTaskIds', to_jsonb(v_closed));  -- Accounts phase 3 (20261205000720)
end;
$$;

revoke all on function authz.booking_create_item_tasks(uuid, uuid[]) from public, anon, authenticated, service_role;
-- The replaced functions keep their grants (CREATE OR REPLACE).

commit;
