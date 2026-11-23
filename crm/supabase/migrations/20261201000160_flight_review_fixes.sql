-- TripNavigate CRM - Flight build, track A (review fixes): money fence for
-- dual roles, decider at decision time, queue bounds and raced retries.
-- Contract: Flight department build contract sections 4, 6, 9.1, 9.2; lead
-- decisions on the independent backend review (5 November 2026).
--
-- What changes (same signatures; bodies = the previous ones plus the noted lines):
--   1. Money fence (Review F5 rule, as flight_money / manager_approvals):
--      flight_queue.budgetPaise is null for a branch Manager who also holds
--      Purchase in the entity (Flight people keep it, also with Purchase:
--      supplier-side). flight_workspace.flights[].salesFare is null for anyone
--      holding Purchase in the entity (Manager or Flight).
--   3. Package change decider at decision time: the Deal's active Sales owner
--      (active Sales role, no Flight role) decides; otherwise the branch Manager
--      (no Flight role). authz.flight_has_active_sales_owner and
--      authz.flight_can_decide_change replaced; flight_change_submit uses the
--      same predicate for the stored decider_kind (a hint only now);
--      authz.flight_change_json names the owner only while they decide.
--   4. flight_queue leaves out Deals removed by the sync, and shows a Deal
--      whose flights are all done only for 90 days after the last completion.
--   5. Every Flight command with a request id checks the stored result again
--      after the group lock, so a duplicate that raced the first call returns
--      outcome 'existing' instead of a unique-key error.
-- No refusal tokens change.
-- Rollback (forward-only): a new migration restoring the bodies from
-- 20261201000100 / 0110 / 0120 / 0140.

begin;
set local lock_timeout = '15s';

-- flight_has_active_sales_owner
create or replace function authz.flight_has_active_sales_owner(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  -- 20261201000160 (lead decision): the owner holds an active Sales role and no Flight role in the entity.
  select exists (select 1 from public.deals d
                 where d.id = p_deal
                   and authz.is_active_department_person(d.owner_user_id, d.legal_entity_id, 'sales')
                   and not exists (select 1 from public.memberships m
                                   where m.user_id = d.owner_user_id and m.legal_entity_id = d.legal_entity_id
                                     and m.role_code = 'flight' and m.status = 'active'))
$$;

-- flight_can_decide_change
create or replace function authz.flight_can_decide_change(p_change uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  -- 20261201000160 (lead decision): a package change is decided by whoever decides NOW: the Deal's
  -- active Sales owner (not holding Flight), else the branch Manager (not holding Flight).
  select coalesce(authz.session_ok(), false) and coalesce((
    select case
      when c.decider_kind = 'flight_owner' then t.assignee_user_id = (select auth.uid()) and t.status = 'in_progress'
                                               and authz.holds_active_role('flight', c.legal_entity_id)
      when authz.flight_has_active_sales_owner(c.deal_id) then authz.flight_is_sales_owner(c.deal_id)
      else authz.is_branch_sales_manager(c.deal_id) and not authz.holds_role('flight', c.legal_entity_id)
    end
    from public.flight_changes c join public.fulfilment_tasks t on t.id = c.task_id
    where c.id = p_change), false)
$$;

-- flight_group_claim
create or replace function public.flight_group_claim(p_deal_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_ids uuid[];
  v_claimed uuid[] := '{}'::uuid[];
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id);
  v_replay jsonb;
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null or not authz.holds_active_role('flight', v_deal.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_refuse_gate(p_deal_id);
  v_replay := authz.flight_replay(v_deal.legal_entity_id, p_request_id, 'flight_group_claim', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  perform authz.flight_lock_group(p_deal_id);
  -- 20261201000160: a duplicate that raced the first call returns its stored result.
  v_replay := authz.flight_replay(v_deal.legal_entity_id, p_request_id, 'flight_group_claim', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  select array_agg(t.id order by i.item_no, t.id) into v_ids
  from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
  where t.deal_id = p_deal_id and t.department = 'flight';
  if v_ids is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from public.fulfilment_tasks t
             where t.deal_id = p_deal_id and t.department = 'flight' and t.status in ('in_progress', 'completed')
               and t.assignee_user_id is distinct from v_uid) then
    raise exception 'task_conflict' using errcode = '40001';
  end if;

  for v_task in
    select t.* from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
    where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'not_started'
    order by i.item_no, t.id
  loop
    update public.fulfilment_tasks t set assignee_user_id = v_uid, status = 'in_progress', updated_at = now()
    where t.id = v_task.id;
    v_claimed := v_claimed || v_task.id;
    perform authz.write_audit('fulfilment.task_claimed', v_task.legal_entity_id, v_task.branch_id,
      'fulfilment_task', v_task.id, null,
      jsonb_build_object('dealId', v_task.deal_id, 'versionId', authz.task_current_version(v_task.id),
        'serviceItemId', v_task.service_item_id, 'department', 'flight', 'group', true));
  end loop;

  -- Every task of the caller without a state (claimed now, or earlier with the
  -- old per-task command) gets its itinerary from its current version.
  for v_task in
    select t.* from public.fulfilment_tasks t
    where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'in_progress' and t.assignee_user_id = v_uid
      and not exists (select 1 from public.flight_task_state s where s.task_id = t.id)
  loop
    insert into public.flight_task_state (task_id, legal_entity_id, deal_id, service_item_id, basis_version_id, built_by)
    values (v_task.id, v_task.legal_entity_id, v_task.deal_id, v_task.service_item_id,
            authz.task_current_version(v_task.id), v_uid);
    perform authz.flight_build_sectors(v_task.id);
  end loop;

  if cardinality(v_claimed) > 0 then
    insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
    values (p_deal_id, v_deal.legal_entity_id, v_uid, 'flight', v_uid)
    on conflict (deal_id, user_id, assignment_kind) where ended_at is null do nothing;
    perform authz.write_audit('flight.group_claimed', v_deal.legal_entity_id, v_deal.branch_id,
      'fulfilment_task', v_ids[1], null, jsonb_build_object('dealId', p_deal_id, 'taskIds', to_jsonb(v_claimed)));
  end if;

  v_result := jsonb_build_object('dealId', p_deal_id, 'taskIds', to_jsonb(v_ids), 'claimedTaskIds', to_jsonb(v_claimed),
    'outcome', case when cardinality(v_claimed) = 0 then 'existing' else 'created' end);
  return authz.flight_remember(v_deal.legal_entity_id, p_request_id, 'flight_group_claim', v_payload, v_result);
end;
$$;

-- flight_group_reassign
create or replace function public.flight_group_reassign(
  p_deal_id uuid, p_expected_assignee uuid, p_to_user_id uuid, p_reason text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_uid uuid := (select auth.uid());
  v_reason text := authz.flight_norm_text(p_reason);
  v_task public.fulfilment_tasks%rowtype;
  v_moved uuid[] := '{}'::uuid[];
  v_from uuid[] := '{}'::uuid[];
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_first uuid;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null or not authz.is_branch_sales_manager(p_deal_id) or authz.holds_role('flight', v_deal.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_refuse_gate(p_deal_id);
  if p_expected_assignee is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedAssignee';
  end if;
  if p_to_user_id is null or not authz.is_active_department_person(p_to_user_id, v_deal.legal_entity_id, 'flight') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'toUserId';
  end if;
  if v_reason is null or length(v_reason) not between 10 and 300 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  v_payload := jsonb_build_object('dealId', p_deal_id, 'expectedAssignee', p_expected_assignee, 'toUserId', p_to_user_id,
    'reason', v_reason);
  v_replay := authz.flight_replay(v_deal.legal_entity_id, p_request_id, 'flight_group_reassign', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  perform authz.flight_lock_group(p_deal_id);
  -- 20261201000160: a duplicate that raced the first call returns its stored result.
  v_replay := authz.flight_replay(v_deal.legal_entity_id, p_request_id, 'flight_group_reassign', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  if not exists (select 1 from public.fulfilment_tasks t
                 where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'in_progress') then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  -- Every in-progress task is held by the expected person (or already by the
  -- new one: a group split by the old per-task claims is joined this way).
  if exists (select 1 from public.fulfilment_tasks t
             where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'in_progress'
               and t.assignee_user_id not in (p_expected_assignee, p_to_user_id)) then
    raise exception 'task_conflict' using errcode = '40001';
  end if;
  select t.id into v_first from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
  where t.deal_id = p_deal_id and t.department = 'flight' order by i.item_no, t.id limit 1;

  perform set_config('authz.task_transition', 'reassign', true);
  for v_task in
    select t.* from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
    where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'in_progress'
      and t.assignee_user_id is distinct from p_to_user_id
    order by i.item_no, t.id
  loop
    update public.fulfilment_tasks t set assignee_user_id = p_to_user_id, updated_at = now() where t.id = v_task.id;
    v_moved := v_moved || v_task.id;
    if not (v_task.assignee_user_id = any (v_from)) then
      v_from := v_from || v_task.assignee_user_id;
    end if;
    perform authz.write_audit('fulfilment.task_reassigned', v_task.legal_entity_id, v_task.branch_id,
      'fulfilment_task', v_task.id, v_reason,
      jsonb_build_object('dealId', p_deal_id, 'fromUserId', v_task.assignee_user_id, 'toUserId', p_to_user_id,
        'group', true));
  end loop;
  perform set_config('authz.task_transition', '', true);

  if cardinality(v_moved) > 0 then
    update public.deal_assignments a set ended_at = now()
    where a.deal_id = p_deal_id and a.assignment_kind = 'flight' and a.user_id = any (v_from) and a.ended_at is null
      and not exists (select 1 from public.fulfilment_tasks t
                      where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'in_progress'
                        and t.assignee_user_id = a.user_id);
    insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
    values (p_deal_id, v_deal.legal_entity_id, p_to_user_id, 'flight', v_uid)
    on conflict (deal_id, user_id, assignment_kind) where ended_at is null do nothing;
    perform authz.write_audit('flight.group_reassigned', v_deal.legal_entity_id, v_deal.branch_id,
      'fulfilment_task', v_first, v_reason,
      jsonb_build_object('dealId', p_deal_id, 'taskIds', to_jsonb(v_moved), 'fromUserIds', to_jsonb(v_from),
        'toUserId', p_to_user_id));
  end if;

  v_result := jsonb_build_object('dealId', p_deal_id, 'taskIds', to_jsonb(v_moved), 'toUserId', p_to_user_id,
    'outcome', case when cardinality(v_moved) = 0 then 'existing' else 'updated' end);
  return authz.flight_remember(v_deal.legal_entity_id, p_request_id, 'flight_group_reassign', v_payload, v_result);
end;
$$;

-- flight_booking_change_apply
create or replace function public.flight_booking_change_apply(
  p_task_id uuid, p_expected_basis_version_id uuid, p_target_version_id uuid, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_state public.flight_task_state%rowtype;
  v_uid uuid := (select auth.uid());
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_diff jsonb;
  v_facts jsonb;
  v_new_legs jsonb;
  v_seqs integer[];
  v_old_seqs integer[];
  v_e jsonb;
  v_c record;
  v_superseded uuid[] := '{}'::uuid[];
  v_removed uuid[] := '{}'::uuid[];
  v_kept integer := 0;
  v_added integer := 0;
  v_new_ids uuid[] := '{}'::uuid[];
  v_id uuid;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or v_task.department <> 'flight' or not authz.flight_can_work(v_task.deal_id)
     or v_task.assignee_user_id is distinct from v_uid then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_refuse_gate(v_task.deal_id);
  if p_expected_basis_version_id is null or p_target_version_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'versionId';
  end if;
  v_payload := jsonb_build_object('taskId', p_task_id, 'expectedBasisVersionId', p_expected_basis_version_id,
    'targetVersionId', p_target_version_id);
  v_replay := authz.flight_replay(v_task.legal_entity_id, p_request_id, 'flight_booking_change_apply', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  perform authz.flight_lock_group(v_task.deal_id);
  -- 20261201000160: a duplicate that raced the first call returns its stored result.
  v_replay := authz.flight_replay(v_task.legal_entity_id, p_request_id, 'flight_booking_change_apply', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.status <> 'in_progress' then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  select * into v_state from public.flight_task_state s where s.task_id = p_task_id;
  if v_state.task_id is null then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if v_state.basis_version_id <> p_expected_basis_version_id
     or p_target_version_id <> authz.task_current_version(p_task_id) then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if v_state.basis_version_id = p_target_version_id then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  v_diff := authz.flight_booking_diff(p_task_id);
  select f.facts into v_facts from public.service_item_facts f
  where f.service_item_id = v_task.service_item_id and f.booking_version_id = p_target_version_id;
  v_new_legs := authz.flight_facts_legs(v_facts);
  v_seqs := authz.item_participant_seqs(v_task.service_item_id, p_target_version_id);
  v_old_seqs := authz.item_participant_seqs(v_task.service_item_id, v_state.basis_version_id);

  perform set_config('authz.flight_transition', 'booking_apply', true);

  -- 1. Pending changes of the task are superseded (holds cleared).
  for v_c in select c.id, c.row_version from public.flight_changes c where c.task_id = p_task_id and c.status = 'pending' order by c.change_no loop
    perform authz.flight_change_close(v_c.id, 'superseded', 'change_superseded');
    update public.flight_changes c set status = 'superseded', ended_by = v_uid, ended_at = now(),
      row_version = c.row_version + 1, updated_at = now()
    where c.id = v_c.id;
    v_superseded := v_superseded || v_c.id;
  end loop;

  -- 2. Legs. Unchanged legs keep their sector (and tickets) under the new basis.
  for v_e in select e from jsonb_array_elements(v_diff #> '{legs,unchanged}') e loop
    update public.flight_sectors s
    set basis_version_id = p_target_version_id, booking_leg_no = (v_e ->> 'newLegNo')::smallint,
        row_version = s.row_version + 1, updated_at = now()
    where s.task_id = p_task_id and s.origin = 'booking' and s.status = 'active'
      and s.basis_version_id = v_state.basis_version_id and s.booking_leg_no = (v_e ->> 'oldLegNo')::smallint;
    v_kept := v_kept + 1;
  end loop;
  -- Changed and removed legs (and typed screenshot sectors when the flight is
  -- no longer a screenshot flight) end; their tickets stay in history.
  select coalesce(array_agg(s.id), '{}'::uuid[]) into v_removed
  from public.flight_sectors s
  where s.task_id = p_task_id and s.status = 'active'
    and ((s.origin = 'booking' and s.basis_version_id = v_state.basis_version_id
          and s.booking_leg_no in (select (e ->> 'oldLegNo')::integer
                                   from jsonb_array_elements((v_diff #> '{legs,changed}') || (v_diff #> '{legs,removed}')) e))
         or (s.origin = 'screenshot' and v_diff #>> '{entryMode,new}' <> 'screenshot'));
  perform authz.flight_end_sector_passengers(v_removed, 'booking_changed');
  update public.flight_sectors s
  set status = 'booking_removed', ended_at = now(), ended_by = v_uid, row_version = s.row_version + 1, updated_at = now()
  where s.id = any (v_removed);
  -- New and changed legs get new booking sectors with every participant.
  for v_e in select e from jsonb_array_elements((v_diff #> '{legs,changed}') || (v_diff #> '{legs,added}')) e loop
    v_id := authz.flight_insert_booking_sector(p_task_id, p_target_version_id,
      v_new_legs -> (((v_e ->> 'newLegNo')::integer) - 1), v_facts ->> 'cabin', v_seqs);
    v_new_ids := v_new_ids || v_id;
    v_added := v_added + 1;
  end loop;

  -- 3. Travellers no longer on the item leave every sector of the task.
  update public.flight_sector_passengers p
  set held_by_change_id = null, ended_at = now(), ended_by = v_uid, ended_reason = 'traveller_removed'
  where p.task_id = p_task_id and p.ended_at is null and not (p.traveller_seq = any (v_seqs));
  -- New travellers join every active booking (and screenshot) sector.
  insert into public.flight_sector_passengers (legal_entity_id, deal_id, task_id, sector_id, traveller_seq, created_by)
  select v_task.legal_entity_id, v_task.deal_id, v_task.id, s.id, q, v_uid
  from public.flight_sectors s cross join unnest(v_seqs) q
  where s.task_id = p_task_id and s.status = 'active' and s.origin in ('booking', 'screenshot')
    and not (q = any (v_old_seqs))
    and not exists (select 1 from public.flight_sector_passengers p
                    where p.sector_id = s.id and p.traveller_seq = q and p.ended_at is null);

  -- 4. The itinerary now reflects the target version.
  update public.flight_task_state s
  set basis_version_id = p_target_version_id, row_version = s.row_version + 1, updated_at = now()
  where s.task_id = p_task_id;

  perform authz.write_audit('flight.booking_change_applied', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('dealId', v_task.deal_id, 'fromVersionId', v_state.basis_version_id, 'toVersionId', p_target_version_id,
      'keptSectors', v_kept, 'removedSectors', cardinality(v_removed), 'addedSectors', v_added,
      'supersededChangeIds', to_jsonb(v_superseded)));
  v_result := jsonb_build_object('taskId', v_task.id,
    'fromVersionNo', v_diff -> 'fromVersionNo', 'toVersionNo', v_diff -> 'toVersionNo',
    'keptSectors', v_kept, 'removedSectors', cardinality(v_removed), 'addedSectors', v_added,
    'flaggedTickets', coalesce((v_diff #>> '{impact,ticketsOnRemoved}')::integer, 0)
                      + coalesce((v_diff #>> '{impact,ticketsOfRemovedTravellers}')::integer, 0),
    'stateRowVersion', v_state.row_version + 1, 'outcome', 'updated');
  return authz.flight_remember(v_task.legal_entity_id, p_request_id, 'flight_booking_change_apply', v_payload, v_result);
end;
$$;

-- flight_screenshot_sectors_save
create or replace function public.flight_screenshot_sectors_save(
  p_task_id uuid, p_expected_state_row_version integer, p_sectors jsonb, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_state public.flight_task_state%rowtype;
  v_uid uuid := (select auth.uid());
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_rows jsonb := '[]'::jsonb;
  v_row jsonb;
  v_e jsonb;
  v_i integer := 0;
  v_prev date;
  v_listed uuid[] := '{}'::uuid[];
  v_drop uuid[];
  v_seqs integer[];
  v_ids uuid[] := '{}'::uuid[];
  v_sid uuid;
  v_facts jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or v_task.department <> 'flight' or not authz.flight_can_work(v_task.deal_id)
     or v_task.assignee_user_id is distinct from v_uid then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_refuse_gate(v_task.deal_id);
  if p_sectors is null or jsonb_typeof(p_sectors) <> 'array' or jsonb_array_length(p_sectors) not between 1 and 8 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'sectors';
  end if;
  for v_e in select e from jsonb_array_elements(p_sectors) e loop
    v_row := authz.flight_sector_input(v_e, 'sectors[' || v_i || ']');
    if v_prev is not null and (v_row ->> 'departDate')::date < v_prev then
      raise exception 'invalid_input' using errcode = '22023', hint = 'sectors[' || v_i || '].departDate';
    end if;
    if v_row ->> 'sectorId' is not null then
      if (v_row ->> 'sectorId')::uuid = any (v_listed) then
        raise exception 'invalid_input' using errcode = '22023', hint = 'sectors[' || v_i || '].sectorId';
      end if;
      v_listed := v_listed || (v_row ->> 'sectorId')::uuid;
    end if;
    v_prev := (v_row ->> 'departDate')::date;
    v_rows := v_rows || v_row;
    v_i := v_i + 1;
  end loop;
  v_payload := jsonb_build_object('taskId', p_task_id, 'expectedStateRowVersion', p_expected_state_row_version, 'sectors', v_rows);
  v_replay := authz.flight_replay(v_task.legal_entity_id, p_request_id, 'flight_screenshot_sectors_save', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  perform authz.flight_lock_group(v_task.deal_id);
  -- 20261201000160: a duplicate that raced the first call returns its stored result.
  v_replay := authz.flight_replay(v_task.legal_entity_id, p_request_id, 'flight_screenshot_sectors_save', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.status <> 'in_progress' then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  v_state := authz.flight_require_basis(p_task_id);
  perform authz.require_row_version(p_expected_state_row_version, v_state.row_version);
  select f.facts into v_facts from public.service_item_facts f
  where f.service_item_id = v_task.service_item_id and f.booking_version_id = v_state.basis_version_id;
  if coalesce(v_facts ->> 'entryMode', 'typed') <> 'screenshot' then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if exists (select 1 from unnest(v_listed) l
             where not exists (select 1 from public.flight_sectors s
                               where s.id = l and s.task_id = p_task_id and s.origin = 'screenshot' and s.status = 'active')) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select coalesce(array_agg(s.id), '{}'::uuid[]) into v_drop from public.flight_sectors s
  where s.task_id = p_task_id and s.origin = 'screenshot' and s.status = 'active' and not (s.id = any (v_listed));
  -- Ticketed sectors cannot be replaced or changed (correct the ticket or add an alternative).
  if exists (select 1 from public.flight_ticket_revisions r where r.sector_id = any (v_drop))
     or exists (select 1 from jsonb_array_elements(v_rows) e
                where e ->> 'sectorId' is not null
                  and authz.flight_sector_shape((e ->> 'sectorId')::uuid) is distinct from (e - 'sectorId')
                  and exists (select 1 from public.flight_ticket_revisions r where r.sector_id = (e ->> 'sectorId')::uuid)) then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;

  perform set_config('authz.flight_transition', 'screenshot_save', true);
  perform authz.flight_end_sector_passengers(v_drop, 'screenshot_replaced');
  update public.flight_sectors s
  set status = 'withdrawn', ended_at = now(), ended_by = v_uid, row_version = s.row_version + 1, updated_at = now()
  where s.id = any (v_drop);
  v_seqs := authz.item_participant_seqs(v_task.service_item_id, v_state.basis_version_id);
  for v_e in select e from jsonb_array_elements(v_rows) e loop
    if v_e ->> 'sectorId' is null then
      v_sid := authz.flight_insert_typed_sector(p_task_id, 'screenshot', v_state.basis_version_id, null, 'active', v_e, v_seqs);
    else
      v_sid := (v_e ->> 'sectorId')::uuid;
      if authz.flight_sector_shape(v_sid) is distinct from (v_e - 'sectorId') then
        update public.flight_sectors s
        set from_place = v_e ->> 'from', to_place = v_e ->> 'to', depart_date = (v_e ->> 'departDate')::date,
            depart_time = v_e ->> 'departTime', arrive_date = (v_e ->> 'arriveDate')::date, arrive_time = v_e ->> 'arriveTime',
            airline = v_e ->> 'airline', flight_no = v_e ->> 'flightNo', cabin = v_e ->> 'cabin',
            row_version = s.row_version + 1, updated_at = now()
        where s.id = v_sid;
      end if;
    end if;
    v_ids := v_ids || v_sid;
  end loop;
  update public.flight_task_state s set row_version = s.row_version + 1, updated_at = now() where s.task_id = p_task_id;

  perform authz.write_audit('flight.screenshot_sectors_saved', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('dealId', v_task.deal_id, 'sectorIds', to_jsonb(v_ids), 'withdrawnSectorIds', to_jsonb(v_drop)));
  v_result := jsonb_build_object('taskId', v_task.id, 'sectorIds', to_jsonb(v_ids), 'stateRowVersion', v_state.row_version + 1,
    'outcome', 'updated');
  return authz.flight_remember(v_task.legal_entity_id, p_request_id, 'flight_screenshot_sectors_save', v_payload, v_result);
end;
$$;

-- flight_sector_fill_blanks
create or replace function public.flight_sector_fill_blanks(
  p_sector_id uuid, p_expected_row_version integer, p_fields jsonb, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_sector public.flight_sectors%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_uid uuid := (select auth.uid());
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_keys text[];
  v_airline text;
  v_fn text;
  v_dt text;
  v_at text;
  v_ad date;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_sector from public.flight_sectors s where s.id = p_sector_id;
  select * into v_task from public.fulfilment_tasks t where t.id = v_sector.task_id;
  if v_sector.id is null or not authz.flight_can_work(v_task.deal_id) or v_task.assignee_user_id is distinct from v_uid then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_refuse_gate(v_task.deal_id);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_fields) k
                where k not in ('airline', 'flightNo', 'departTime', 'arriveTime', 'arriveDate')) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  select coalesce(array_agg(k order by k), '{}'::text[]) into v_keys
  from jsonb_object_keys(p_fields) k where coalesce(jsonb_typeof(p_fields -> k), 'null') <> 'null';
  if cardinality(v_keys) = 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  if 'airline' = any (v_keys) then
    if not authz.sf_text_ok(p_fields -> 'airline', 60, true) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'airline';
    end if;
    v_airline := authz.flight_norm_text(p_fields ->> 'airline');
  end if;
  if 'flightNo' = any (v_keys) then
    v_fn := case when jsonb_typeof(p_fields -> 'flightNo') = 'string' then authz.flight_norm_flight_no(p_fields ->> 'flightNo') end;
    if v_fn is null or v_fn !~ '^[A-Z0-9 -]{1,12}$' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'flightNo';
    end if;
  end if;
  if 'departTime' = any (v_keys) then
    if not authz.sf_time_ok(p_fields -> 'departTime', true) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'departTime';
    end if;
    v_dt := p_fields ->> 'departTime';
  end if;
  if 'arriveTime' = any (v_keys) then
    if not authz.sf_time_ok(p_fields -> 'arriveTime', true) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'arriveTime';
    end if;
    v_at := p_fields ->> 'arriveTime';
  end if;
  if 'arriveDate' = any (v_keys) then
    v_ad := authz.sf_date(p_fields -> 'arriveDate');
    if v_ad is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'arriveDate';
    end if;
  end if;
  v_payload := jsonb_build_object('sectorId', p_sector_id, 'expectedRowVersion', p_expected_row_version,
    'airline', v_airline, 'flightNo', v_fn, 'departTime', v_dt, 'arriveTime', v_at, 'arriveDate', v_ad);
  v_replay := authz.flight_replay(v_task.legal_entity_id, p_request_id, 'flight_sector_fill_blanks', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  perform authz.flight_lock_group(v_task.deal_id);
  -- 20261201000160: a duplicate that raced the first call returns its stored result.
  v_replay := authz.flight_replay(v_task.legal_entity_id, p_request_id, 'flight_sector_fill_blanks', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = v_sector.task_id;
  if v_task.status <> 'in_progress' then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  perform authz.flight_require_basis(v_task.id);
  select * into v_sector from public.flight_sectors s where s.id = p_sector_id;
  perform authz.require_row_version(p_expected_row_version, v_sector.row_version);
  if v_sector.origin not in ('booking', 'screenshot') or v_sector.status <> 'active' then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  -- Changing a filled value is an alternative (L11).
  if v_airline is not null and v_sector.airline is not null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'airline_already_set';
  end if;
  if v_fn is not null and v_sector.flight_no is not null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'flightNo_already_set';
  end if;
  if v_dt is not null and v_sector.depart_time is not null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'departTime_already_set';
  end if;
  if v_at is not null and v_sector.arrive_time is not null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'arriveTime_already_set';
  end if;
  if v_ad is not null and v_sector.arrive_date is not null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'arriveDate_already_set';
  end if;
  if v_ad is not null and v_ad < v_sector.depart_date then
    raise exception 'invalid_input' using errcode = '22023', hint = 'arriveDate';
  end if;

  perform set_config('authz.flight_transition', 'fill_blanks', true);
  update public.flight_sectors s
  set airline = coalesce(v_airline, s.airline), flight_no = coalesce(v_fn, s.flight_no),
      depart_time = coalesce(v_dt, s.depart_time), arrive_time = coalesce(v_at, s.arrive_time),
      arrive_date = coalesce(v_ad, s.arrive_date), row_version = s.row_version + 1, updated_at = now()
  where s.id = p_sector_id;
  perform authz.write_audit('flight.sector_details_filled', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('dealId', v_task.deal_id, 'sectorId', p_sector_id, 'fields', to_jsonb(v_keys)));
  v_result := jsonb_build_object('sectorId', p_sector_id, 'rowVersion', v_sector.row_version + 1, 'fields', to_jsonb(v_keys),
    'outcome', 'updated');
  return authz.flight_remember(v_task.legal_entity_id, p_request_id, 'flight_sector_fill_blanks', v_payload, v_result);
end;
$$;

-- flight_change_submit
create or replace function public.flight_change_submit(p_task_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_state public.flight_task_state%rowtype;
  v_uid uuid := (select auth.uid());
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_kind text;
  v_remark text;
  v_seqs integer[];
  v_from uuid[] := '{}'::uuid[];
  v_rows jsonb := '[]'::jsonb;
  v_row jsonb;
  v_e jsonb;
  v_i integer := 0;
  v_prev date;
  v_max integer;
  v_part integer[];
  v_change uuid;
  v_no integer;
  v_deal_kind text;
  v_decider text;
  v_new_ids uuid[] := '{}'::uuid[];
  v_sid uuid;
  v_status text := 'pending';
  v_rv integer := 1;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or v_task.department <> 'flight' or not authz.flight_can_work(v_task.deal_id)
     or v_task.assignee_user_id is distinct from v_uid then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_refuse_gate(v_task.deal_id);

  -- Shape.
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_fields) k
                where k not in ('kind', 'fromSectorIds', 'travellerSeqs', 'remark', 'sectors')) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_kind := case when jsonb_typeof(p_fields -> 'kind') = 'string' then p_fields ->> 'kind' end;
  if v_kind is null or v_kind not in ('alternative', 'added_instead', 'added_extra', 'passenger_itinerary') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  v_remark := case when jsonb_typeof(p_fields -> 'remark') = 'string' then authz.flight_norm_text(p_fields ->> 'remark') end;
  if v_remark is null or length(v_remark) not between 3 and 300 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'remark';
  end if;
  if jsonb_typeof(p_fields -> 'travellerSeqs') <> 'array'
     or exists (select 1 from jsonb_array_elements(p_fields -> 'travellerSeqs') s
                where jsonb_typeof(s) <> 'number' or (s #>> '{}') !~ '^[0-9]{1,3}$') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'travellerSeqs';
  end if;
  select array_agg((s #>> '{}')::integer order by (s #>> '{}')::integer) into v_seqs
  from jsonb_array_elements(p_fields -> 'travellerSeqs') s;
  if not authz.flight_seqs_ok(v_seqs) or (v_kind = 'passenger_itinerary' and cardinality(v_seqs) <> 1) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'travellerSeqs';
  end if;
  if v_kind in ('alternative', 'added_instead') then
    if jsonb_typeof(p_fields -> 'fromSectorIds') <> 'array'
       or exists (select 1 from jsonb_array_elements(p_fields -> 'fromSectorIds') s
                  where jsonb_typeof(s) <> 'string'
                     or (s #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      raise exception 'invalid_input' using errcode = '22023', hint = 'fromSectorIds';
    end if;
    select coalesce(array_agg(distinct (s #>> '{}')::uuid), '{}'::uuid[]) into v_from
    from jsonb_array_elements(p_fields -> 'fromSectorIds') s;
    if cardinality(v_from) <> jsonb_array_length(p_fields -> 'fromSectorIds')
       or (v_kind = 'alternative' and cardinality(v_from) <> 1)
       or (v_kind = 'added_instead' and cardinality(v_from) not between 1 and 8) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'fromSectorIds';
    end if;
  elsif coalesce(jsonb_typeof(p_fields -> 'fromSectorIds'), 'null') not in ('null', 'array')
        or (v_kind = 'added_extra' and jsonb_typeof(p_fields -> 'fromSectorIds') = 'array'
            and jsonb_array_length(p_fields -> 'fromSectorIds') > 0) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fromSectorIds';
  end if;
  v_max := case when v_kind = 'passenger_itinerary' then 8 else 1 end;
  if jsonb_typeof(p_fields -> 'sectors') <> 'array' or jsonb_array_length(p_fields -> 'sectors') not between 1 and v_max then
    raise exception 'invalid_input' using errcode = '22023', hint = 'sectors';
  end if;
  for v_e in select e from jsonb_array_elements(p_fields -> 'sectors') e loop
    v_row := authz.flight_sector_input(v_e, 'sectors[' || v_i || ']') - 'sectorId';
    if v_prev is not null and (v_row ->> 'departDate')::date < v_prev then
      raise exception 'invalid_input' using errcode = '22023', hint = 'sectors[' || v_i || '].departDate';
    end if;
    v_prev := (v_row ->> 'departDate')::date;
    v_rows := v_rows || v_row;
    v_i := v_i + 1;
  end loop;

  v_payload := jsonb_build_object('taskId', p_task_id, 'kind', v_kind, 'fromSectorIds', to_jsonb(v_from),
    'travellerSeqs', to_jsonb(v_seqs), 'remark', v_remark, 'sectors', v_rows);
  v_replay := authz.flight_replay(v_task.legal_entity_id, p_request_id, 'flight_change_submit', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  perform authz.flight_lock_group(v_task.deal_id);
  -- 20261201000160: a duplicate that raced the first call returns its stored result.
  v_replay := authz.flight_replay(v_task.legal_entity_id, p_request_id, 'flight_change_submit', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.status <> 'in_progress' then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  v_state := authz.flight_require_basis(p_task_id);
  v_part := authz.item_participant_seqs(v_task.service_item_id, v_state.basis_version_id);

  if exists (select 1 from unnest(v_from) f
             where not exists (select 1 from public.flight_sectors s where s.id = f and s.task_id = p_task_id and s.status = 'active')) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if not (v_seqs <@ v_part) then
    raise exception 'traveller_not_on_sector' using errcode = '22023';
  end if;
  if v_kind = 'passenger_itinerary' then
    select coalesce(array_agg(distinct p.sector_id), '{}'::uuid[]) into v_from
    from public.flight_sector_passengers p join public.flight_sectors s on s.id = p.sector_id and s.status = 'active'
    where p.task_id = p_task_id and p.traveller_seq = v_seqs[1] and p.ended_at is null;
  end if;
  -- A traveller a pending change will move off a from-sector cannot be moved again.
  if exists (select 1 from public.flight_sector_passengers p
             where p.task_id = p_task_id and p.sector_id = any (v_from) and p.traveller_seq = any (v_seqs)
               and p.ended_at is null and p.held_by_change_id is not null) then
    raise exception 'held_by_change' using errcode = '55000';
  end if;
  if exists (select 1 from unnest(v_from) f cross join unnest(v_seqs) q
             where not exists (select 1 from public.flight_sector_passengers p
                               where p.sector_id = f and p.traveller_seq = q and p.ended_at is null
                                 and p.held_by_change_id is null)) then
    raise exception 'traveller_not_on_sector' using errcode = '22023';
  end if;
  if exists (select 1 from unnest(v_from) f cross join unnest(v_seqs) q
             where exists (select 1 from public.flight_ticket_revisions r where r.sector_id = f and r.traveller_seq = q)) then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  if exists (select 1 from jsonb_array_elements(v_rows) e
             join public.flight_sectors s on s.task_id = p_task_id and s.status = 'active' and not (s.id = any (v_from))
               and s.from_place = e ->> 'from' and s.to_place = e ->> 'to' and s.depart_date = (e ->> 'departDate')::date
               and s.flight_no is not distinct from e ->> 'flightNo'
             where v_seqs <@ coalesce((select array_agg(p.traveller_seq) from public.flight_sector_passengers p
                                       where p.sector_id = s.id and p.ended_at is null), '{}'::integer[])) then
    raise exception 'duplicate_flight' using errcode = '22023';
  end if;
  if v_kind = 'alternative' and authz.flight_sector_compare_shape(authz.flight_sector_shape(v_from[1]))
                                 = authz.flight_sector_compare_shape(v_rows -> 0) then
    raise exception 'no_difference' using errcode = '22023';
  end if;

  v_deal_kind := authz.flight_deal_kind(v_task.deal_id);
  v_decider := case when v_deal_kind = 'flight_only' then 'flight_owner'
                    when authz.flight_has_active_sales_owner(v_task.deal_id) then 'sales_owner'
                    else 'branch_manager' end;
  select coalesce(max(c.change_no), 0) + 1 into v_no from public.flight_changes c where c.deal_id = v_task.deal_id;
  insert into public.flight_changes (legal_entity_id, branch_id, deal_id, task_id, service_item_id, change_no, kind,
    basis_version_id, deal_kind, decider_kind, from_sector_ids, traveller_seqs, remark, requested_by, request_id)
  values (v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, v_task.service_item_id, v_no, v_kind,
    v_state.basis_version_id, v_deal_kind, v_decider, v_from, v_seqs, v_remark, v_uid, p_request_id)
  returning id into v_change;
  for v_e in select e from jsonb_array_elements(v_rows) e loop
    v_sid := authz.flight_insert_typed_sector(p_task_id, 'change', v_state.basis_version_id, v_change, 'pending', v_e, v_seqs);
    v_new_ids := v_new_ids || v_sid;
  end loop;
  update public.flight_sector_passengers p set held_by_change_id = v_change
  where p.task_id = p_task_id and p.sector_id = any (v_from) and p.traveller_seq = any (v_seqs) and p.ended_at is null;
  perform authz.write_audit('flight.change_submitted', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('dealId', v_task.deal_id, 'changeId', v_change, 'changeNo', v_no, 'kind', v_kind,
      'travellerSeqs', to_jsonb(v_seqs), 'fromSectorIds', to_jsonb(v_from), 'newSectorIds', to_jsonb(v_new_ids)));

  -- Flight-only Deal: "Save and apply" (L12), decided by the Flight owner.
  if v_decider = 'flight_owner' then
    perform authz.flight_change_apply_approval(v_change);
    update public.flight_changes c
    set status = 'approved', decided_by = v_uid, decided_at = now(), flight_seen_at = now(),
        row_version = c.row_version + 1, updated_at = now()
    where c.id = v_change;
    v_status := 'approved';
    v_rv := 2;
    perform authz.write_audit('flight.change_approved', v_task.legal_entity_id, v_task.branch_id,
      'fulfilment_task', v_task.id, null,
      jsonb_build_object('dealId', v_task.deal_id, 'changeId', v_change, 'changeNo', v_no, 'deciderKind', v_decider));
  end if;

  v_result := jsonb_build_object('changeId', v_change, 'changeNo', v_no, 'status', v_status, 'deciderKind', v_decider,
    'sectorIds', to_jsonb(v_new_ids), 'rowVersion', v_rv, 'outcome', 'created');
  return authz.flight_remember(v_task.legal_entity_id, p_request_id, 'flight_change_submit', v_payload, v_result);
end;
$$;

-- flight_change_decide
create or replace function public.flight_change_decide(
  p_change_id uuid, p_decision text, p_reason text, p_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_change public.flight_changes%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_uid uuid := (select auth.uid());
  v_reason text := authz.flight_norm_text(p_reason);
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_change from public.flight_changes c where c.id = p_change_id;
  if v_change.id is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_change.decider_kind <> 'flight_owner' and v_change.requested_by = v_uid then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if not authz.flight_can_decide_change(p_change_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_refuse_gate(v_change.deal_id);
  if p_decision is null or p_decision not in ('approve', 'reject') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'decision';
  end if;
  if p_decision = 'reject' and (v_reason is null or length(v_reason) not between 10 and 500) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  v_payload := jsonb_build_object('changeId', p_change_id, 'decision', p_decision,
    'reason', case when p_decision = 'reject' then v_reason end, 'expectedRowVersion', p_expected_row_version);
  v_replay := authz.flight_replay(v_change.legal_entity_id, p_request_id, 'flight_change_decide', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  perform authz.flight_lock_group(v_change.deal_id);
  -- 20261201000160: a duplicate that raced the first call returns its stored result.
  v_replay := authz.flight_replay(v_change.legal_entity_id, p_request_id, 'flight_change_decide', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  select * into v_change from public.flight_changes c where c.id = p_change_id;
  select * into v_task from public.fulfilment_tasks t where t.id = v_change.task_id;
  if v_change.status <> 'pending' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_change.row_version);
  if v_change.basis_version_id <> authz.task_current_version(v_change.task_id) then
    raise exception 'version_changed' using errcode = '40001';
  end if;

  if p_decision = 'approve' then
    perform authz.flight_change_apply_approval(p_change_id);
    update public.flight_changes c
    set status = 'approved', decided_by = v_uid, decided_at = now(),
        flight_seen_at = case when c.decider_kind = 'flight_owner' then now() end,
        row_version = c.row_version + 1, updated_at = now()
    where c.id = p_change_id;
    perform authz.write_audit('flight.change_approved', v_task.legal_entity_id, v_task.branch_id,
      'fulfilment_task', v_task.id, null,
      jsonb_build_object('dealId', v_task.deal_id, 'changeId', p_change_id, 'changeNo', v_change.change_no,
        'deciderKind', v_change.decider_kind));
  else
    perform authz.flight_change_close(p_change_id, 'rejected', 'change_rejected');
    update public.flight_changes c
    set status = 'rejected', decided_by = v_uid, decided_at = now(), reject_reason = v_reason,
        row_version = c.row_version + 1, updated_at = now()
    where c.id = p_change_id;
    perform authz.write_audit('flight.change_rejected', v_task.legal_entity_id, v_task.branch_id,
      'fulfilment_task', v_task.id, v_reason,
      jsonb_build_object('dealId', v_task.deal_id, 'changeId', p_change_id, 'changeNo', v_change.change_no,
        'deciderKind', v_change.decider_kind));
  end if;
  v_result := jsonb_build_object('changeId', p_change_id, 'changeNo', v_change.change_no,
    'status', case when p_decision = 'approve' then 'approved' else 'rejected' end,
    'rowVersion', v_change.row_version + 1, 'outcome', 'updated');
  return authz.flight_remember(v_change.legal_entity_id, p_request_id, 'flight_change_decide', v_payload, v_result);
end;
$$;

-- flight_change_withdraw
create or replace function public.flight_change_withdraw(p_change_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_change public.flight_changes%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_uid uuid := (select auth.uid());
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_change from public.flight_changes c where c.id = p_change_id;
  select * into v_task from public.fulfilment_tasks t where t.id = v_change.task_id;
  if v_change.id is null or not authz.flight_can_work(v_change.deal_id) or v_task.assignee_user_id is distinct from v_uid then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_refuse_gate(v_change.deal_id);
  v_payload := jsonb_build_object('changeId', p_change_id, 'expectedRowVersion', p_expected_row_version);
  v_replay := authz.flight_replay(v_change.legal_entity_id, p_request_id, 'flight_change_withdraw', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  perform authz.flight_lock_group(v_change.deal_id);
  -- 20261201000160: a duplicate that raced the first call returns its stored result.
  v_replay := authz.flight_replay(v_change.legal_entity_id, p_request_id, 'flight_change_withdraw', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  select * into v_change from public.flight_changes c where c.id = p_change_id;
  if v_change.status <> 'pending' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_change.row_version);
  perform authz.flight_change_close(p_change_id, 'withdrawn', 'change_withdrawn');
  update public.flight_changes c
  set status = 'withdrawn', ended_by = v_uid, ended_at = now(), row_version = c.row_version + 1, updated_at = now()
  where c.id = p_change_id;
  perform authz.write_audit('flight.change_withdrawn', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('dealId', v_task.deal_id, 'changeId', p_change_id, 'changeNo', v_change.change_no));
  v_result := jsonb_build_object('changeId', p_change_id, 'changeNo', v_change.change_no, 'status', 'withdrawn',
    'rowVersion', v_change.row_version + 1, 'outcome', 'updated');
  return authz.flight_remember(v_change.legal_entity_id, p_request_id, 'flight_change_withdraw', v_payload, v_result);
end;
$$;

-- flight_ticket_correct
create or replace function public.flight_ticket_correct(
  p_sector_id uuid, p_traveller_seq integer, p_expected_revision_no integer, p_fields jsonb, p_reason text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_sector public.flight_sectors%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_cur public.flight_ticket_revisions%rowtype;
  v_uid uuid := (select auth.uid());
  v_reason text := authz.flight_norm_text(p_reason);
  v_norm jsonb;
  v_issue text;
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_id uuid;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_sector from public.flight_sectors s where s.id = p_sector_id;
  select * into v_task from public.fulfilment_tasks t where t.id = v_sector.task_id;
  if v_sector.id is null
     or not ((v_task.assignee_user_id = v_uid and v_task.status in ('in_progress', 'completed')
              and authz.holds_active_role('flight', v_task.legal_entity_id))
             or authz.is_branch_sales_manager(v_task.deal_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_refuse_gate(v_task.deal_id);
  if p_traveller_seq is null or p_traveller_seq not between 1 and 100 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'travellerSeq';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_fields) k where k not in ('crsType', 'crsPnr', 'airlinePnr', 'ticketNumber')) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_issue := authz.flight_ticket_fields_issue(p_fields);
  if v_issue is not null then
    raise exception 'invalid_input' using errcode = '22023', hint = v_issue;
  end if;
  if v_reason is null or length(v_reason) not between 10 and 300 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  v_norm := authz.flight_ticket_fields_normalize(p_fields);
  v_payload := jsonb_build_object('sectorId', p_sector_id, 'travellerSeq', p_traveller_seq,
    'expectedRevisionNo', p_expected_revision_no, 'fields', v_norm, 'reason', v_reason);
  v_replay := authz.flight_replay(v_task.legal_entity_id, p_request_id, 'flight_ticket_correct', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  perform authz.flight_lock_group(v_task.deal_id);
  -- 20261201000160: a duplicate that raced the first call returns its stored result.
  v_replay := authz.flight_replay(v_task.legal_entity_id, p_request_id, 'flight_ticket_correct', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  select * into v_cur from public.flight_ticket_revisions r
  where r.sector_id = p_sector_id and r.traveller_seq = p_traveller_seq order by r.revision_no desc limit 1;
  if v_cur.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_expected_revision_no is null or p_expected_revision_no <> v_cur.revision_no then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if (v_cur.crs_type, v_cur.crs_pnr, v_cur.airline_pnr, v_cur.ticket_number)
     is not distinct from (v_norm ->> 'crsType', v_norm ->> 'crsPnr', v_norm ->> 'airlinePnr', v_norm ->> 'ticketNumber')
     and exists (select 1 from public.booking_version_travellers s
                 where s.booking_version_id = authz.task_current_version(v_task.id) and s.seq = p_traveller_seq
                   and s.full_name = v_cur.traveller_name and s.traveller_type = v_cur.traveller_type) then
    raise exception 'no_difference' using errcode = '22023';
  end if;
  v_id := authz.flight_insert_ticket_revision(p_sector_id, p_traveller_seq, v_cur.batch_id, v_norm, v_reason, p_request_id);
  perform authz.write_audit('flight.ticket_corrected', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, v_reason,
    jsonb_build_object('dealId', v_task.deal_id, 'sectorId', p_sector_id, 'travellerSeq', p_traveller_seq,
      'revisionNo', v_cur.revision_no + 1));
  v_result := jsonb_build_object('revisionId', v_id, 'sectorId', p_sector_id, 'travellerSeq', p_traveller_seq,
    'revisionNo', v_cur.revision_no + 1, 'outcome', 'created');
  return authz.flight_remember(v_task.legal_entity_id, p_request_id, 'flight_ticket_correct', v_payload, v_result);
end;
$$;

-- flight_group_complete
create or replace function public.flight_group_complete(p_deal_id uuid, p_expected_task_ids uuid[], p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_uid uuid := (select auth.uid());
  v_ids uuid[];
  v_issues text[];
  v_task public.fulfilment_tasks%rowtype;
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null or not authz.holds_active_role('flight', v_deal.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_expected_task_ids is null or cardinality(p_expected_task_ids) = 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'taskIds';
  end if;
  v_payload := jsonb_build_object('dealId', p_deal_id,
    'taskIds', (select to_jsonb(array_agg(x order by x)) from (select distinct unnest(p_expected_task_ids) x) q));
  -- An exact retry by the same person returns the stored result (the tasks
  -- are completed by then, so the work check below no longer holds).
  v_replay := authz.flight_replay(v_deal.legal_entity_id, p_request_id, 'flight_group_complete', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  if not authz.flight_can_work(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_refuse_gate(p_deal_id);
  perform authz.flight_lock_group(p_deal_id);
  -- 20261201000160: a duplicate that raced the first call returns its stored result.
  v_replay := authz.flight_replay(v_deal.legal_entity_id, p_request_id, 'flight_group_complete', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  if not authz.flight_can_work(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select array_agg(t.id order by t.id) into v_ids from public.fulfilment_tasks t
  where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'in_progress';
  if v_ids is distinct from (select array_agg(x order by x) from (select distinct unnest(p_expected_task_ids) x) q) then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_issues := authz.flight_done_issues(p_deal_id);
  if cardinality(v_issues) > 0 then
    raise exception 'not_ready' using errcode = '55000', hint = array_to_string(v_issues, ',');
  end if;
  for v_task in select t.* from public.fulfilment_tasks t where t.id = any (v_ids) order by t.id loop
    update public.fulfilment_tasks t set status = 'completed', completed_by = v_uid, completed_at = now(), updated_at = now()
    where t.id = v_task.id;
    insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
    values (v_task.legal_entity_id, 'fulfilment_task', v_task.id, 'fulfilment.task_completed',
      jsonb_build_object('task_id', v_task.id, 'deal_id', v_task.deal_id, 'service_item_id', v_task.service_item_id,
        'service_type', v_task.service_purpose))
    on conflict (event_type, aggregate_id) do nothing;
    perform authz.write_audit('fulfilment.task_completed', v_task.legal_entity_id, v_task.branch_id, 'fulfilment_task',
      v_task.id, null, jsonb_build_object('dealId', v_task.deal_id, 'serviceItemId', v_task.service_item_id,
        'department', 'flight', 'group', true));
  end loop;
  perform authz.write_audit('flight.group_completed', v_deal.legal_entity_id, v_deal.branch_id, 'fulfilment_task',
    v_ids[1], null, jsonb_build_object('dealId', p_deal_id, 'taskIds', to_jsonb(v_ids)));
  v_result := jsonb_build_object('dealId', p_deal_id, 'taskIds', to_jsonb(v_ids), 'status', 'completed', 'outcome', 'updated');
  return authz.flight_remember(v_deal.legal_entity_id, p_request_id, 'flight_group_complete', v_payload, v_result);
end;
$$;

-- flight_change_json
create or replace function authz.flight_change_json(p_change uuid, p_can_work boolean, p_assignee uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'changeId', c.id, 'changeNo', c.change_no, 'kind', c.kind, 'status', c.status, 'deciderKind', c.decider_kind,
    'deciderName', case when c.decided_by is not null then authz.flight_staff_name(c.decided_by)
                        when c.decider_kind <> 'flight_owner' and authz.flight_has_active_sales_owner(c.deal_id)
                          then authz.flight_staff_name(d.owner_user_id)
                        when c.decider_kind = 'flight_owner' then authz.flight_staff_name(p_assignee) end,
    'remark', c.remark,
    'travellers', (select coalesce(jsonb_agg(jsonb_build_object('seq', q.seq, 'name', s.full_name) order by q.seq), '[]'::jsonb)
                   from unnest(c.traveller_seqs) q(seq)
                   left join public.booking_version_travellers s on s.booking_version_id = c.basis_version_id and s.seq = q.seq),
    'fromSectorIds', to_jsonb(c.from_sector_ids),
    'newSectorIds', (select coalesce(jsonb_agg(x.id order by x.depart_date, x.depart_time nulls last, x.created_at, x.id), '[]'::jsonb)
                     from public.flight_sectors x where x.change_id = c.id),
    'basisVersionNo', v.version_no,
    'requestedAt', c.requested_at, 'requestedByName', authz.flight_staff_name(c.requested_by),
    'decidedAt', c.decided_at, 'decidedByName', authz.flight_staff_name(c.decided_by),
    'rejectReason', c.reject_reason, 'rowVersion', c.row_version,
    'canWithdraw', p_can_work and c.status = 'pending',
    'needsAck', p_can_work and t.assignee_user_id = (select auth.uid()) and c.status in ('approved', 'rejected')
                and c.flight_seen_at is null)
  from public.flight_changes c
  join public.fulfilment_tasks t on t.id = c.task_id
  join public.deals d on d.id = c.deal_id
  join public.booking_versions v on v.id = c.basis_version_id
  where c.id = p_change
$$;

-- flight_queue
create or replace function public.flight_queue() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return jsonb_build_object('groups', coalesce((
    select jsonb_agg(g.j order by g.first_date nulls last, g.reference, g.deal_id)
    from (
      select d.id as deal_id, d.reference, fd.first_date,
        jsonb_build_object(
          'dealId', d.id, 'dealReference', d.reference, 'branchName', b.name,
          'status', authz.flight_group_status_json(d.id),
          'assigneeName', authz.flight_staff_name(a.assignee),
          'assignedToYou', a.assignee is not distinct from v_uid and a.assignee is not null,
          'canTake', x.is_f and (a.assignee is null or a.assignee = v_uid)
                     and exists (select 1 from public.fulfilment_tasks t
                                 where t.deal_id = d.id and t.department = 'flight' and t.status = 'not_started')
                     and not exists (select 1 from public.fulfilment_tasks t
                                     where t.deal_id = d.id and t.department = 'flight' and t.status in ('in_progress', 'completed')
                                       and t.assignee_user_id is distinct from v_uid),
          'firstDate', to_char(fd.first_date, 'YYYY-MM-DD'),
          'chips', jsonb_build_object(
            'bookingChanged', exists (select 1 from public.fulfilment_tasks t join public.flight_task_state s on s.task_id = t.id
                                      where t.deal_id = d.id and t.department = 'flight' and t.status <> 'completed'
                                        and s.basis_version_id <> authz.task_current_version(t.id)),
            'unnamed', (select coalesce(sum(authz.flight_unnamed_count(t.id)), 0)::integer from public.fulfilment_tasks t
                        where t.deal_id = d.id and t.department = 'flight' and t.status <> 'completed'),
            'changesWaiting', (select count(*)::integer from public.flight_changes c where c.deal_id = d.id and c.status = 'pending'),
            'faresWaiting', 'fare_approval_pending' = any (m.issues),
            'paymentNeeded', 'payment_missing' = any (m.issues) or 'payment_returned' = any (m.issues)),
          -- 20261201000160 (Review F5): no amount for a branch Manager who also holds Purchase.
          'budgetPaise', case when x.is_f or (x.is_m and not authz.holds_role('purchase', d.legal_entity_id))
                              then authz.flight_group_budget(d.id)::text end,
          -- Travellers on the Deal's flights (named and not named yet).
          'travellerCount', (select coalesce(max(cardinality(authz.item_participant_seqs(t.service_item_id, authz.task_current_version(t.id)))
                                                 + authz.flight_unnamed_count(t.id)), 0)::integer
                             from public.fulfilment_tasks t where t.deal_id = d.id and t.department = 'flight'),
          'flights', (select jsonb_agg(jsonb_build_object(
                         'taskId', t.id, 'itemNo', i.item_no, 'title', authz.flight_task_title(t.id),
                         'route', authz.flight_route_text(t.id),
                         'firstDate', to_char(authz.flight_first_date(t.id), 'YYYY-MM-DD'),
                         'status', authz.flight_task_status_json(t.id),
                         'entryMode', coalesce(f.facts ->> 'entryMode', 'typed'))
                         order by i.item_no, t.id)
                      from public.fulfilment_tasks t
                      join public.service_items i on i.id = t.service_item_id
                      left join public.service_item_facts f on f.service_item_id = t.service_item_id
                        and f.booking_version_id = authz.flight_display_version(t.id)
                      where t.deal_id = d.id and t.department = 'flight')) as j
      from public.deals d
      join public.branches b on b.id = d.branch_id
      cross join lateral (select authz.holds_active_role('flight', d.legal_entity_id) as is_f,
                                 authz.is_branch_sales_manager(d.id) as is_m) x
      cross join lateral (select authz.flight_group_assignee(d.id) as assignee) a
      cross join lateral (select coalesce(authz.flight_money_issues(d.id), '{}'::text[]) as issues) m
      cross join lateral (select min(authz.flight_first_date(t.id)) as first_date from public.fulfilment_tasks t
                          where t.deal_id = d.id and t.department = 'flight') fd
      where (x.is_f or x.is_m)
        and exists (select 1 from public.fulfilment_tasks t where t.deal_id = d.id and t.department = 'flight')
        -- 20261201000160: no Deals removed by the sync; done groups only for 90 days after completion.
        and d.removed_at is null
        and (exists (select 1 from public.fulfilment_tasks t
                     where t.deal_id = d.id and t.department = 'flight' and t.status <> 'completed')
             or (select max(t.completed_at) from public.fulfilment_tasks t
                 where t.deal_id = d.id and t.department = 'flight') >= now() - interval '90 days')
    ) g), '[]'::jsonb));
end;
$$;

-- flight_workspace
create or replace function public.flight_workspace(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_deal public.deals%rowtype;
  v_is_f boolean;
  v_is_m boolean;
  v_assignee uuid;
  v_can_work boolean;
  v_can_correct boolean;
  v_can_reassign boolean;
  v_first_version uuid;
  v_issues text[];
  v_flights jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null then
    return null;
  end if;
  v_is_f := authz.holds_active_role('flight', v_deal.legal_entity_id);
  v_is_m := authz.is_branch_sales_manager(p_deal_id);
  if not (v_is_f or v_is_m)
     or not exists (select 1 from public.fulfilment_tasks t where t.deal_id = p_deal_id and t.department = 'flight') then
    return null;
  end if;
  v_assignee := authz.flight_group_assignee(p_deal_id);
  v_can_work := authz.flight_can_work(p_deal_id);
  v_can_correct := coalesce(v_is_f and v_assignee = v_uid, false) or v_is_m;
  v_can_reassign := v_is_m and not authz.holds_role('flight', v_deal.legal_entity_id)
                    and exists (select 1 from public.fulfilment_tasks t
                                where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'in_progress');
  select authz.task_current_version(t.id) into v_first_version
  from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
  where t.deal_id = p_deal_id and t.department = 'flight' order by i.item_no, t.id limit 1;
  v_issues := case when v_can_work then authz.flight_done_issues(p_deal_id) end;

  select coalesce(jsonb_agg(x.j order by x.item_no, x.task_id), '[]'::jsonb) into v_flights
  from (
    select t.id as task_id, i.item_no, jsonb_build_object(
      'taskId', t.id, 'itemNo', i.item_no, 'title', authz.flight_task_title(t.id),
      'status', authz.flight_task_status_json(t.id),
      'entryMode', coalesce(f.facts ->> 'entryMode', 'typed'),
      'screenshotNote', f.facts ->> 'screenshotNote',
      'screenshots', case when (v_is_f and t.assignee_user_id = v_uid) or v_is_m then (
          select coalesce(jsonb_agg(jsonb_build_object('fileId', sf.id, 'fileName', sf.file_name, 'mime', sf.mime,
                   'sizeBytes', sf.size_bytes) order by sf.created_at, sf.id), '[]'::jsonb)
          from public.service_item_files sf
          where sf.service_item_id = t.service_item_id and sf.booking_version_id = dv.vid and sf.status = 'stored')
        else '[]'::jsonb end,
      'basisVersionNo', bv.version_no,
      'currentVersionNo', cv.version_no,
      'stateRowVersion', s.row_version,
      'bookingChanged', authz.flight_booking_diff(t.id),
      'booked', jsonb_build_object(
        'legs', authz.flight_facts_legs(f.facts), 'cabin', f.facts ->> 'cabin', 'preferredTime', f.facts ->> 'preferredTime',
        'notes', f.facts ->> 'notes', 'preferences', f.facts ->> 'preferences', 'assistance', f.facts ->> 'assistance',
        'tripType', f.facts ->> 'tripType',
        'isReturn', case when jsonb_typeof(f.facts -> 'isReturn') = 'boolean' then (f.facts ->> 'isReturn')::boolean end),
      'travellers', authz.flight_travellers_json(t.id, dv.vid,
                      coalesce(v_is_f and t.assignee_user_id = v_uid and t.status = 'in_progress' and cv.trip_scope = 'international', false)),
      'unnamedCount', authz.flight_unnamed_count(t.id),
      -- 20261201000140: the Sales fare estimate of this flight (Details "Sales fare breakup").
      -- 20261201000160: the Sales estimate is selling-side for Purchase holders: never to anyone holding Purchase.
      'salesFare', case when not authz.holds_role('purchase', v_deal.legal_entity_id)
                        then authz.flight_sales_fare_json(t.id, dv.vid) end,
      'sectors', (select coalesce(jsonb_agg(authz.flight_sector_json(x.id,
                     coalesce(v_can_work and t.status = 'in_progress' and t.assignee_user_id = v_uid
                       and s.basis_version_id = authz.task_current_version(t.id), false),
                     v_can_correct, v_assignee)
                     order by x.depart_date, x.depart_time nulls last, x.created_at, x.id), '[]'::jsonb)
                  from public.flight_sectors x where x.task_id = t.id),
      'changes', (select coalesce(jsonb_agg(authz.flight_change_json(c.id, coalesce(v_can_work and t.assignee_user_id = v_uid, false), v_assignee)
                     order by c.change_no), '[]'::jsonb)
                  from public.flight_changes c where c.task_id = t.id)) as j
    from public.fulfilment_tasks t
    join public.service_items i on i.id = t.service_item_id
    left join public.flight_task_state s on s.task_id = t.id
    cross join lateral (select authz.flight_display_version(t.id) as vid) dv
    left join public.service_item_facts f on f.service_item_id = t.service_item_id and f.booking_version_id = dv.vid
    left join public.booking_versions bv on bv.id = s.basis_version_id
    join public.booking_versions cv on cv.id = authz.task_current_version(t.id)
    where t.deal_id = p_deal_id and t.department = 'flight'
  ) x;

  return jsonb_build_object(
    'dealId', v_deal.id, 'dealReference', v_deal.reference,
    'branchName', (select b.name from public.branches b where b.id = v_deal.branch_id),
    'dealKind', authz.flight_deal_kind(p_deal_id),
    'tripScope', (select v.trip_scope from public.booking_versions v where v.id = v_first_version),
    'assignee', jsonb_build_object('name', authz.flight_staff_name(v_assignee), 'isYou', v_assignee is not distinct from v_uid
                                   and v_assignee is not null),
    'canWork', v_can_work,
    'canTake', v_is_f
               and exists (select 1 from public.fulfilment_tasks t
                           where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'not_started')
               and not exists (select 1 from public.fulfilment_tasks t
                               where t.deal_id = p_deal_id and t.department = 'flight' and t.status in ('in_progress', 'completed')
                                 and t.assignee_user_id is distinct from v_uid),
    'canReassign', v_can_reassign,
    -- 20261201000140: the current Flight person, for the Manager's reassign form only.
    'assigneeUserId', case when v_can_reassign then v_assignee end,
    'reassignCandidates', case when v_can_reassign then (
        select coalesce(jsonb_agg(jsonb_build_object('userId', p.user_id, 'name', p.display_name) order by p.display_name, p.user_id),
                        '[]'::jsonb)
        from public.staff_profiles p
        where p.user_id is distinct from v_assignee
          and authz.is_active_department_person(p.user_id, v_deal.legal_entity_id, 'flight'))
      else '[]'::jsonb end,
    'status', authz.flight_group_status_json(p_deal_id),
    'progress', authz.flight_progress_json(p_deal_id),
    'doneIssues', to_jsonb(v_issues),
    'canComplete', v_can_work and cardinality(v_issues) = 0,
    'completedAt', (select max(t.completed_at) from public.fulfilment_tasks t
                    where t.deal_id = p_deal_id and t.department = 'flight'
                      and not exists (select 1 from public.fulfilment_tasks o
                                      where o.deal_id = p_deal_id and o.department = 'flight' and o.status <> 'completed')),
    'completedByName', (select authz.flight_staff_name(t.completed_by) from public.fulfilment_tasks t
                        where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'completed'
                          and not exists (select 1 from public.fulfilment_tasks o
                                          where o.deal_id = p_deal_id and o.department = 'flight' and o.status <> 'completed')
                        order by t.completed_at desc limit 1),
    'flights', v_flights,
    'ticketsByPnr', (
      with cur as (
        select distinct on (r.sector_id, r.traveller_seq) r.*
        from public.flight_ticket_revisions r where r.deal_id = p_deal_id
        order by r.sector_id, r.traveller_seq, r.revision_no desc
      ), x as (
        select cur.*, s.depart_date, s.depart_time, s.flight_no, s.from_place, s.to_place,
               (s.status = 'active' and exists (select 1 from public.flight_sector_passengers p
                                                where p.sector_id = cur.sector_id and p.traveller_seq = cur.traveller_seq
                                                  and p.ended_at is null)) as active,
               (select r1.created_at from public.flight_ticket_revisions r1
                where r1.sector_id = cur.sector_id and r1.traveller_seq = cur.traveller_seq and r1.revision_no = 1) as first_at
        from cur join public.flight_sectors s on s.id = cur.sector_id
      ), grp as (
        -- One group per Airline PNR (active / no longer active); CRS type and
        -- CRS PNR of its first confirmed ticket.
        select x.airline_pnr, x.active,
               (array_agg(x.crs_type order by x.first_at, x.sector_id, x.traveller_seq))[1] as crs_type,
               (array_agg(x.crs_pnr order by x.first_at, x.sector_id, x.traveller_seq))[1] as crs_pnr,
               min(x.first_at) as confirmed_at, min(x.depart_date) as first_date,
               jsonb_agg(distinct jsonb_build_object('sectorId', x.sector_id, 'departDate', to_char(x.depart_date, 'YYYY-MM-DD'),
                 'departTime', x.depart_time, 'flightNo', x.flight_no, 'from', x.from_place, 'to', x.to_place)) as sectors
        from x group by x.airline_pnr, x.active
      )
      select coalesce(jsonb_agg(jsonb_build_object(
          'airlinePnr', g.airline_pnr, 'crsType', g.crs_type, 'crsPnr', g.crs_pnr, 'active', g.active,
          'sectors', (select jsonb_agg(e order by e ->> 'departDate', e ->> 'departTime' nulls last, e ->> 'sectorId')
                      from jsonb_array_elements(g.sectors) e),
          'confirmedAt', g.confirmed_at,
          'travellers', (select jsonb_agg(jsonb_build_object('seq', tr.traveller_seq, 'name', tr.name, 'type', tr.type,
                            'ticketNumbers', tr.numbers) order by tr.traveller_seq)
                         from (select y.traveller_seq,
                                      (array_agg(y.traveller_name order by y.created_at desc))[1] as name,
                                      (array_agg(y.traveller_type order by y.created_at desc))[1] as type,
                                      to_jsonb(array(select distinct on (z.ticket_number) z.ticket_number from x z
                                                     where z.airline_pnr = g.airline_pnr and z.active = g.active
                                                       and z.traveller_seq = y.traveller_seq
                                                     order by z.ticket_number)) as numbers
                               from x y
                               where y.airline_pnr = g.airline_pnr and y.active = g.active
                               group by y.traveller_seq) tr))
          order by g.active desc, g.first_date, g.airline_pnr), '[]'::jsonb)
      from grp g),
    'eTickets', (select coalesce(jsonb_agg(jsonb_build_object('evidenceId', e.id, 'taskId', e.task_id, 'fileName', e.file_name,
                    'mime', e.mime, 'sizeBytes', e.size_bytes, 'storedAt', e.stored_at,
                    'uploadedByName', case when e.uploaded_by = v_assignee then authz.flight_staff_name(e.uploaded_by) end)
                    order by e.stored_at, e.id), '[]'::jsonb)
                 from public.department_evidence e join public.fulfilment_tasks t on t.id = e.task_id
                 where t.deal_id = p_deal_id and t.department = 'flight' and e.kind = 'e_ticket' and e.status = 'stored'),
    'canUploadETicket', v_can_work);
end;
$$;

-- Every replaced function keeps its ACL (CREATE OR REPLACE).

commit;
