-- TripNavigate CRM - Accounts phase 3, track G (4 of 6): applying a change
-- after a supplier confirmed (one transaction) and the shared functions it
-- needs.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 10.2
-- (task_confirmations from purchase_supplier_confirm), 10.4 (steps 1-6), 17.1
-- (lock order), 19 (track G's shared functions), 21 LD24, LD25, LD27, LD29,
-- Addendum O1.
--
-- New (internal, no grant):
--   authz.booking_version_freeze(p_version, p_base): the steps "traveller
--     snapshot", "supersede the base" and "freeze" of booking_confirm
--     (20261119000300:1315-1350) moved here unchanged; a change version takes
--     its base's acceptance (acceptance_from_version_id = base, Q7).
--   authz.cr_lock_apply(p_change_request): the 17.1 lock order - finance head,
--     the Deal row, base version, change version, the request's tasks by id,
--     its reconfirmation rows, then the request.
--   authz.booking_change_apply(p_change_request) (10.4; H replaces it after G):
--     freeze + supersede; the Accounts review of the new version written
--     'approved' with approval_source 'change_request' (no Accounts step,
--     LD24); per recorded reconfirmation a proposed cost (new rate + supplier
--     fee, change_fee_paise, same offer) and its committed copy with the next
--     confirmation_no, the over-budget approval bound to the new version when
--     it was over budget, the task's supplier reference / confirming person /
--     time under authz.task_transition = 'reconfirm', a task_confirmations row
--     and the Purchase basis moved to the new version; outbox
--     booking.version_revised; audit booking.change_applied; then
--     authz.cdoc_auto_run(deal, 'inv_replace_on_change') (track B) and
--     authz.cmsg_enqueue(deal, 'booking_changed', 'cr:<id>', '{}', null)
--     (track A), both never failing the transaction.
--   authz.booking_versions_change_guard (trigger): a change version is frozen
--     for editing once its request is submitted (only apply / discard touch it).
-- Replaced (latest bodies, same signatures; changed lines marked
-- "Accounts phase 3 (20261205000630)"):
--   public.booking_confirm (20261119000300:1230): calls
--     authz.booking_version_freeze (same behaviour, proved by the unchanged
--     booking suites) and refuses a change version (use_change_flow).
--   authz.fulfilment_tasks_state_guard (20261119000500:69): a
--     supplier-confirmed task may change exactly supplier_reference,
--     supplier_confirmed_by, supplier_confirmed_at (and updated_at) under
--     authz.task_transition = 'reconfirm'; nothing else.
--   authz.purchase_go_ahead_valid (20261130000100:393): also true when the
--     task's latest confirmation was made under an applied change request for
--     the task's current booking version (LD24, Addendum O1).
--   public.purchase_supplier_confirm (20261130000110:167): also inserts
--     task_confirmations row 1.
--
-- Refusal tokens: use_change_flow (55000, booking_confirm); wrong_state,
-- version_superseded, not_ready (hint reconfirmation_open) from apply when it
-- is called in the wrong state (internal callers check first).
-- Audit: booking.change_applied {changeRequestId, versionId, baseVersionId,
-- taskIds}; booking.version_superseded (as booking_confirm writes it).
-- Rollback (forward-only): a NEW migration restoring the four cited bodies,
-- dropping the trigger and the new helpers (no data is changed by this file).

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Freeze (moved out of booking_confirm, 20261119000300:1315-1350)
-- ===========================================================================

-- The caller holds the version row (and the base row) locked and has checked
-- readiness. Returns the frozen version.
create function authz.booking_version_freeze(p_version uuid, p_base uuid) returns public.booking_versions
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_deal public.deals%rowtype;
begin
  select * into v_ver from public.booking_versions v where v.id = p_version;
  select * into v_deal from public.deals d where d.id = v_ver.deal_id;
  -- B1 (before the freeze: facts rows of a confirmed version are immutable).
  if v_ver.service_type = 'package' then
    -- Traveller snapshot (B1.1: with age and special needs).
    insert into public.booking_version_travellers (booking_version_id, legal_entity_id, seq, full_name, traveller_type,
      age_years, special_needs)
    select v_ver.id, v_ver.legal_entity_id, t.seq, t.full_name, t.traveller_type, t.age_years, t.special_needs
    from public.deal_travellers t where t.deal_id = v_ver.deal_id;
    -- B1.1: identity snapshot (restricted).
    insert into public.booking_version_traveller_identities (booking_version_id, legal_entity_id, seq, date_of_birth,
      nationality, passport_number, passport_expiry)
    select v_ver.id, v_ver.legal_entity_id, t.seq, x.date_of_birth, x.nationality, x.passport_number, x.passport_expiry
    from public.traveller_identities x join public.deal_travellers t on t.id = x.traveller_id
    where t.deal_id = v_ver.deal_id
      -- Review A1: identities the trip needs only (same set as the draft hash).
      and t.seq = any (authz.b11_identity_needed_seqs(v_ver.id));
  end if;
  -- B1.1 revision: the base is superseded first (one accepted version per Deal).
  if p_base is not null then
    perform set_config('tripnavigate.booking_supersede', p_base::text, true);
    update public.booking_versions b
    set status = 'superseded', superseded_by_version_id = v_ver.id, superseded_at = now(), updated_at = now()
    where b.id = p_base;
    perform set_config('tripnavigate.booking_supersede', '', true);
  end if;
  -- 7. Freeze.
  update public.booking_versions v
  set status = 'confirmed', confirmed_by = (select auth.uid()), confirmed_at = now(),
      -- B1.1 revision: the base's acceptance stands for format-only and internal-only changes.
      -- Accounts phase 3 (20261205000630): and for every change version (Q7: no customer re-acceptance).
      acceptance_from_version_id = case when v.change_request_id is not null then v.revises_version_id
                                        when v.revises_version_id is not null and v.change_class <> 'customer_material'
                                        then v.revises_version_id end,
      confirmed_deal_source_modified_at = v_deal.source_modified_at, updated_at = now()
  where v.id = v_ver.id
  returning * into v_ver;
  return v_ver;
end;
$$;

-- ===========================================================================
-- 2. A submitted change version is not edited any more
-- ===========================================================================

create function authz.booking_versions_change_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.change_request_id is not null and old.status = 'draft'
     and coalesce(current_setting('tripnavigate.change_apply', true), '') <> old.id::text
     and exists (select 1 from public.booking_change_requests r
                 where r.id = old.change_request_id and r.status not in ('requested', 'returned', 'approved')) then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger booking_versions_c_change_guard
  before update on public.booking_versions
  for each row execute function authz.booking_versions_change_guard();

-- ===========================================================================
-- 3. booking_confirm (replaces 20261119000300:1230; lines marked)
-- ===========================================================================

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
    -- Review V3: read the desk switch under a share lock so a concurrent
    -- switch-on either sees this version's items or is seen here.
    perform 1 from public.workflow_settings s where s.id for share;
    update public.service_items i set state = 'active', updated_at = now()
    where i.state = 'planned'
      and i.id in (select f.service_item_id from public.service_item_facts f where f.booking_version_id = v_ver.id);
    for v_item in
      select i.id, i.item_no, i.service_type, i.department
      from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
      where f.booking_version_id = v_ver.id
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

-- ===========================================================================
-- 4. Task guard (replaces 20261119000500:69; lines marked)
-- ===========================================================================

create or replace function authz.fulfilment_tasks_state_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_transition text := coalesce(current_setting('authz.task_transition', true), '');
begin
  if old.status = 'supplier_confirmed' then
    -- Accounts phase 3 (20261205000630): an applied reconfirmation moves the
    -- supplier reference and the confirming person / time, nothing else.
    if v_transition = 'reconfirm'
       and (to_jsonb(new) - array['supplier_reference', 'supplier_confirmed_by', 'supplier_confirmed_at', 'updated_at'])
           = (to_jsonb(old) - array['supplier_reference', 'supplier_confirmed_by', 'supplier_confirmed_at', 'updated_at']) then
      return new;
    end if;
    raise exception 'supplier-confirmed tasks are immutable' using errcode = '42501';
  end if;
  -- B1.1c: completed visa work is final; only in_progress -> completed.
  if old.status = 'completed' then
    raise exception 'completed tasks are immutable' using errcode = '42501';
  end if;
  if new.status = 'completed' and (old.status <> 'in_progress' or new.assignee_user_id is distinct from old.assignee_user_id) then
    raise exception 'fulfilment task status cannot move this way' using errcode = '42501';
  end if;
  if old.status = 'not_started' and new.status = 'supplier_confirmed' then
    raise exception 'fulfilment task status cannot move this way' using errcode = '42501';
  end if;
  if old.status = 'in_progress' and new.status = 'not_started' and v_transition <> 'release' then
    raise exception 'fulfilment task status cannot move this way' using errcode = '42501';
  end if;
  -- Review L1: the assignee may change only by reassignment (in_progress -> in_progress);
  -- never together with supplier confirmation.
  if old.status = 'in_progress' and new.status = 'supplier_confirmed'
     and new.assignee_user_id is distinct from old.assignee_user_id then
    raise exception 'fulfilment task assignee cannot change at supplier confirmation' using errcode = '42501';
  end if;
  if old.status = 'in_progress' and new.status = 'in_progress'
     and new.assignee_user_id is distinct from old.assignee_user_id and v_transition <> 'reassign' then
    raise exception 'fulfilment task assignee changes only through reassignment' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ===========================================================================
-- 5. Go-ahead (replaces 20261130000100:393)
-- ===========================================================================

create or replace function authz.purchase_go_ahead_valid(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.purchase_go_ahead_requests r
    where r.task_id = p_task and r.status = 'approved' and authz.purchase_go_ahead_request_current(r.id)
      and exists (select 1 from public.accounts_booking_reviews b
                  where b.booking_version_id = r.booking_version_id and b.status = 'approved'))
  -- Accounts phase 3 (20261205000630): the Manager's approval of an applied
  -- change stands in for the go-ahead of the task's current version (LD24).
  or exists (
    select 1
    from (select c.change_request_id, c.booking_version_id from public.task_confirmations c
          where c.task_id = p_task order by c.confirmation_no desc limit 1) c
    join public.booking_change_requests q on q.id = c.change_request_id and q.status = 'applied'
    where c.booking_version_id = authz.task_current_version(p_task))
$$;

-- ===========================================================================
-- 6. Supplier confirmation (replaces 20261130000110:167; lines marked)
-- ===========================================================================

create or replace function public.purchase_supplier_confirm(p_task_id uuid, p_expected_version_no integer, p_reference text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_cost public.purchase_cost_versions;
  v_proposal public.purchase_cost_versions;
  v_ref text := btrim(coalesce(p_reference, ''));
  v_issues text[];
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Stage 0: wait for an in-flight removal of the Deal (it holds FOR UPDATE)
  -- so the gate below reads its committed result.
  perform 1 from public.deals d where d.id = v_task.deal_id for key share;
  -- The first confirmation already stores its identity in immutable cost history.
  -- The committed version is NEW: retries must name the accepted PROPOSED
  -- version, not the current committed version. That proposal also fixes the offer.
  if v_task.status = 'supplier_confirmed' then
    v_cost := authz.purchase_latest_cost(v_task.id);
    select * into v_proposal from public.purchase_cost_versions c
      where c.task_id = v_task.id and c.version_no = p_expected_version_no;
    if v_task.supplier_reference = v_ref
       and v_cost.stage = 'committed'
       and p_expected_version_no = v_cost.version_no - 1
       and v_proposal.stage = 'proposed'
       and v_proposal.quote_id = v_cost.quote_id
       and v_proposal.quote_id = v_task.selected_quote_id then
      return jsonb_build_object('outcome', 'existing', 'taskId', v_task.id);
    end if;
    raise exception 'task_conflict' using errcode = '40001';
  end if;
  if length(v_ref) not between 1 and 120 or v_ref ~ E'[\\x01-\\x1f\\x7f]' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_cost := authz.purchase_latest_cost(v_task.id);
  if v_cost.id is not null and p_expected_version_no is distinct from v_cost.version_no then
    raise exception 'version_changed' using errcode = '40001';
  end if;

  v_issues := authz.procurement_issues(v_task.id);
  if 'environment_unset' = any (v_issues) then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  -- Stage 0: a Deal removed by the Bitrix sync takes no new commitment.
  if 'deal_removed' = any (v_issues) then
    raise exception 'deal_removed' using errcode = '55000';
  end if;
  if 'procurement_disabled' = any (v_issues) then
    raise exception 'procurement_disabled' using errcode = '55000';
  end if;
  -- Purchase build: a cancelled trip takes no new commitment.
  if 'trip_cancelled' = any (v_issues) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  if v_issues = array['over_budget'] then
    raise exception 'over_budget' using errcode = '55000';
  end if;
  -- Purchase build: when only the booking request or the Accounts go-ahead is
  -- missing, name it (booking request first: it starts the go-ahead).
  if cardinality(v_issues) > 0 and v_issues <@ array['booking_request_not_sent', 'go_ahead_missing'] then
    if 'booking_request_not_sent' = any (v_issues) then
      raise exception 'booking_request_not_sent' using errcode = '55000';
    end if;
    raise exception 'go_ahead_missing' using errcode = '55000';
  end if;
  if cardinality(v_issues) > 0 then
    raise exception 'not_ready' using errcode = '55000';
  end if;

  insert into public.purchase_cost_versions (task_id, legal_entity_id, version_no, quote_id, request_id, stage,
    amount_paise, due_date, note, created_by)
  values (v_task.id, v_task.legal_entity_id, v_cost.version_no + 1, v_cost.quote_id, gen_random_uuid(), 'committed',
    v_cost.amount_paise, v_cost.due_date, v_cost.note, (select auth.uid()));
  update public.purchase_quotes q set status = 'selected', updated_at = now() where q.id = v_cost.quote_id;
  update public.fulfilment_tasks t
  set status = 'supplier_confirmed', selected_quote_id = v_cost.quote_id, supplier_reference = v_ref,
      supplier_confirmed_by = (select auth.uid()), supplier_confirmed_at = now(), updated_at = now()
  where t.id = v_task.id;
  -- Accounts phase 3 (20261205000630): confirmation 1 of the task's history.
  insert into public.task_confirmations (legal_entity_id, task_id, confirmation_no, quote_id, committed_version_no, amount_paise,
    supplier_reference, evidence_ids, booking_version_id, confirmed_by, confirmed_at)
  values (v_task.legal_entity_id, v_task.id, 1, v_cost.quote_id, v_cost.version_no + 1, v_cost.amount_paise, v_ref,
    coalesce((select array_agg(e.id order by e.created_at, e.id) from public.purchase_evidence e
              where e.task_id = v_task.id and e.kind = 'supplier_confirmation' and e.status = 'stored'), '{}'::uuid[]),
    authz.task_current_version(v_task.id), (select auth.uid()), now())
  on conflict (task_id, confirmation_no) do nothing;

  insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
  values (v_task.legal_entity_id, 'fulfilment_task', v_task.id, 'fulfilment.supplier_confirmed',
    jsonb_build_object('task_id', v_task.id, 'deal_id', v_task.deal_id, 'service_purpose', v_task.service_purpose))
  on conflict (event_type, aggregate_id) do nothing;

  perform authz.write_audit('purchase.supplier_confirmed', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('quoteId', v_cost.quote_id, 'committedVersionNo', v_cost.version_no + 1));
  return jsonb_build_object('outcome', 'created', 'taskId', v_task.id);
end;
$$;

-- ===========================================================================
-- 7. Locks and apply (10.4)
-- ===========================================================================

-- 17.1: finance head, the Deal row, base version, change version, the
-- request's tasks by id, its reconfirmation rows, then the request.
create function authz.cr_lock_apply(p_change_request uuid) returns public.booking_change_requests
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.booking_change_requests%rowtype;
begin
  select * into v from public.booking_change_requests r where r.id = p_change_request;
  if v.id is null then
    return null;
  end if;
  perform authz.finance_lock_deal(v.deal_id);
  perform 1 from public.deals d where d.id = v.deal_id for no key update;
  perform 1 from public.booking_versions b where b.id = v.base_version_id for update;
  -- The request row is read again below; its change version cannot change once set.
  select r.change_version_id into v.change_version_id from public.booking_change_requests r where r.id = p_change_request;
  if v.change_version_id is not null then
    perform 1 from public.booking_versions b where b.id = v.change_version_id for update;
  end if;
  perform 1 from public.fulfilment_tasks t
  where t.id in (select x.task_id from public.task_reconfirmations x where x.change_request_id = v.id)
  order by t.id for update;
  perform 1 from public.task_reconfirmations x where x.change_request_id = v.id order by x.id for update;
  select * into v from public.booking_change_requests r where r.id = p_change_request for update;
  return v;
end;
$$;

-- Internal (no grant). H replaces it after G (11.2, 11.3).
create function authz.booking_change_apply(p_change_request uuid) returns jsonb
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
begin
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
      'taskIds', to_jsonb(v_tasks)));

  -- 6. Bills and the customer message (never fail this transaction).
  perform authz.cdoc_auto_run(v_row.deal_id, 'inv_replace_on_change');
  perform authz.cmsg_enqueue(v_row.deal_id, 'booking_changed', 'cr:' || v_row.id::text, '{}'::jsonb, null);

  return jsonb_build_object('changeRequestId', v_row.id, 'status', v_row.status, 'versionId', v_ver.id,
    'baseVersionId', v_base.id, 'taskIds', to_jsonb(v_tasks));
end;
$$;

revoke all on function authz.booking_version_freeze(uuid, uuid), authz.booking_versions_change_guard(),
  authz.cr_lock_apply(uuid), authz.booking_change_apply(uuid)
from public, anon, authenticated, service_role;

commit;
