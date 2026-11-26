-- TripNavigate CRM - Flight build, track A (2 of 4): Flight workspace commands.
-- Contract: Flight department build contract (frozen 4 November 2026),
-- section 6.1 (A1-A10, A12, A13) and section 8; owner decisions D1, D5-D8,
-- D10, D11; lead decisions L3, L7, L11-L13, L20 (section 17).
--
-- Commands (security definer, search_path '', session_ok first, actor from
-- auth.uid(), execute to authenticated only; one transaction per change with
-- its audit rows; idempotent by p_request_id through finance_command_results):
--   flight_group_claim, flight_task_claim (replaced: claims the Deal's group),
--   flight_group_reassign, purchase_task_reassign (replaced: refuses flight
--   tasks), flight_booking_change_apply, flight_screenshot_sectors_save,
--   flight_sector_fill_blanks, flight_change_submit, flight_change_decide,
--   flight_change_withdraw, flight_change_acknowledge, flight_ticket_correct,
--   flight_group_complete.
-- Deprecated (kept one release, unchanged): flight_task_list, flight_task_get.
--
-- Data step: every flight task already in progress before this migration
-- (claimed with the old per-task command) gets its task state and booking
-- sectors, built from its current booking version, so its Flight person can
-- keep working in the new workspace.
--
-- Refusal tokens (message is exactly the token):
--   42501 not_authorized, not_self_approval | P0002 not_found |
--   40001 version_changed, duplicate_request, task_conflict |
--   22023 invalid_input (hint = field), traveller_not_on_sector, no_difference,
--         duplicate_flight |
--   55000 not_ready (hint = done issues for flight_group_complete),
--         booking_changed, held_by_change, already_confirmed, already_decided,
--         environment_unset, deal_removed |
--   23505 ticket_number_taken.
--
-- Rollback (forward-only): a new migration revoking execute on the new
-- commands and restoring flight_task_claim and purchase_task_reassign from
-- 20261118000100 / 20261127000100. Rows are never deleted.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Command helpers
-- ===========================================================================

-- not_ready when the task has no state; booking_changed when Sales sent a
-- newer booking version than the itinerary reflects.
create function authz.flight_require_basis(p_task uuid) returns public.flight_task_state
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.flight_task_state%rowtype;
begin
  select * into v from public.flight_task_state s where s.task_id = p_task;
  if v.task_id is null then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if v.basis_version_id <> authz.task_current_version(p_task) then
    raise exception 'booking_changed' using errcode = '55000';
  end if;
  return v;
end;
$$;

-- One typed sector (A4 / A6), validated and normalized; raises invalid_input
-- with hint '<path>.<field>'. arriveDate defaults to departDate, or the next
-- day when the arrival time is earlier than the departure time.
create function authz.flight_sector_input(p_sector jsonb, p_path text) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_from text;
  v_to text;
  v_dd date;
  v_ad date;
  v_dt text;
  v_at text;
  v_fn text;
  v_cabin text;
begin
  if p_sector is null or jsonb_typeof(p_sector) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_sector) k
                where k not in ('sectorId', 'from', 'to', 'departDate', 'departTime', 'arriveDate', 'arriveTime',
                                'flightNo', 'airline', 'cabin')) then
    raise exception 'invalid_input' using errcode = '22023', hint = p_path;
  end if;
  if p_sector ? 'sectorId' and coalesce(jsonb_typeof(p_sector -> 'sectorId'), 'null') <> 'null'
     and (jsonb_typeof(p_sector -> 'sectorId') <> 'string'
          or (p_sector ->> 'sectorId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
    raise exception 'invalid_input' using errcode = '22023', hint = p_path || '.sectorId';
  end if;
  if jsonb_typeof(p_sector -> 'from') <> 'string' or not authz.b11_place_ok(to_jsonb(btrim(p_sector ->> 'from'))) then
    raise exception 'invalid_input' using errcode = '22023', hint = p_path || '.from';
  end if;
  if jsonb_typeof(p_sector -> 'to') <> 'string' or not authz.b11_place_ok(to_jsonb(btrim(p_sector ->> 'to'))) then
    raise exception 'invalid_input' using errcode = '22023', hint = p_path || '.to';
  end if;
  v_from := authz.flight_norm_place(p_sector ->> 'from');
  v_to := authz.flight_norm_place(p_sector ->> 'to');
  if lower(v_from) = lower(v_to) then
    raise exception 'invalid_input' using errcode = '22023', hint = p_path || '.to';
  end if;
  v_dd := authz.sf_date(p_sector -> 'departDate');
  if v_dd is null then
    raise exception 'invalid_input' using errcode = '22023', hint = p_path || '.departDate';
  end if;
  if not authz.sf_time_ok(p_sector -> 'departTime', true) then
    raise exception 'invalid_input' using errcode = '22023', hint = p_path || '.departTime';
  end if;
  v_dt := p_sector ->> 'departTime';
  if not authz.sf_time_ok(p_sector -> 'arriveTime', true) then
    raise exception 'invalid_input' using errcode = '22023', hint = p_path || '.arriveTime';
  end if;
  v_at := p_sector ->> 'arriveTime';
  v_fn := case when jsonb_typeof(p_sector -> 'flightNo') = 'string' then authz.flight_norm_flight_no(p_sector ->> 'flightNo') end;
  if v_fn is null or v_fn !~ '^[A-Z0-9 -]{1,12}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = p_path || '.flightNo';
  end if;
  if not authz.sf_text_ok(p_sector -> 'airline', 60, false) then
    raise exception 'invalid_input' using errcode = '22023', hint = p_path || '.airline';
  end if;
  v_cabin := case lower(btrim(coalesce(p_sector ->> 'cabin', '')))
    when 'economy' then 'Economy' when 'premium economy' then 'Premium Economy'
    when 'business' then 'Business' when 'first' then 'First' end;
  if v_cabin is null or jsonb_typeof(p_sector -> 'cabin') <> 'string' then
    raise exception 'invalid_input' using errcode = '22023', hint = p_path || '.cabin';
  end if;
  if coalesce(jsonb_typeof(p_sector -> 'arriveDate'), 'null') = 'null' then
    v_ad := case when v_at < v_dt then v_dd + 1 else v_dd end;
  else
    v_ad := authz.sf_date(p_sector -> 'arriveDate');
    if v_ad is null or v_ad < v_dd then
      raise exception 'invalid_input' using errcode = '22023', hint = p_path || '.arriveDate';
    end if;
  end if;
  return jsonb_build_object(
    'sectorId', case when jsonb_typeof(p_sector -> 'sectorId') = 'string' then p_sector ->> 'sectorId' end,
    'from', v_from, 'to', v_to, 'departDate', to_char(v_dd, 'YYYY-MM-DD'), 'departTime', v_dt,
    'arriveDate', to_char(v_ad, 'YYYY-MM-DD'), 'arriveTime', v_at, 'flightNo', v_fn,
    'airline', authz.flight_norm_text(p_sector ->> 'airline'), 'cabin', v_cabin);
end;
$$;

-- A sector row as the same normalized shape (for "no difference" checks).
create function authz.flight_sector_shape(p_sector uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('from', s.from_place, 'to', s.to_place, 'departDate', to_char(s.depart_date, 'YYYY-MM-DD'),
    'departTime', s.depart_time, 'arriveDate', to_char(s.arrive_date, 'YYYY-MM-DD'), 'arriveTime', s.arrive_time,
    'flightNo', s.flight_no, 'airline', s.airline, 'cabin', s.cabin)
  from public.flight_sectors s where s.id = p_sector
$$;

-- Comparable form of a sector shape: a blank arrival date is the departure
-- date (next day when the arrival time is earlier); cabin and airline ignore case.
create function authz.flight_sector_compare_shape(p_shape jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select p_shape
    || jsonb_build_object(
      'arriveDate', coalesce(p_shape ->> 'arriveDate',
                             case when p_shape ->> 'departDate' is null then null
                                  when p_shape ->> 'arriveTime' < p_shape ->> 'departTime'
                                    then to_char((p_shape ->> 'departDate')::date + 1, 'YYYY-MM-DD')
                                  else p_shape ->> 'departDate' end),
      'cabin', lower(p_shape ->> 'cabin'),
      'airline', lower(p_shape ->> 'airline'))
$$;

-- Inserts a typed (screenshot or change) sector with its passengers.
create function authz.flight_insert_typed_sector(
  p_task uuid, p_origin text, p_basis uuid, p_change uuid, p_status text, p_sector jsonb, p_seqs integer[]
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_id uuid;
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task;
  insert into public.flight_sectors (legal_entity_id, branch_id, deal_id, task_id, service_item_id, origin, basis_version_id,
    change_id, from_place, to_place, depart_date, depart_time, arrive_date, arrive_time, airline, flight_no, cabin, status,
    created_by)
  values (v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, v_task.service_item_id, p_origin, p_basis,
    p_change, p_sector ->> 'from', p_sector ->> 'to', (p_sector ->> 'departDate')::date, p_sector ->> 'departTime',
    (p_sector ->> 'arriveDate')::date, p_sector ->> 'arriveTime', p_sector ->> 'airline', p_sector ->> 'flightNo',
    p_sector ->> 'cabin', p_status, (select auth.uid()))
  returning id into v_id;
  insert into public.flight_sector_passengers (legal_entity_id, deal_id, task_id, sector_id, traveller_seq, added_by_change_id,
    created_by)
  select v_task.legal_entity_id, v_task.deal_id, v_task.id, v_id, s, p_change, (select auth.uid()) from unnest(p_seqs) s;
  return v_id;
end;
$$;

-- Approval of a pending change (A7 approve branch; also "Save and apply" of a
-- flight-only change): the held passengers must still be on their sectors
-- without a ticket; pending sectors become active; held assignments end.
create function authz.flight_change_apply_approval(p_change uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.flight_changes%rowtype;
begin
  select * into v from public.flight_changes c where c.id = p_change;
  if v.kind <> 'added_extra' and exists (
       select 1 from unnest(v.from_sector_ids) fs cross join unnest(v.traveller_seqs) sq
       where not exists (select 1 from public.flight_sector_passengers p
                         join public.flight_sectors x on x.id = p.sector_id and x.status = 'active'
                         where p.sector_id = fs and p.traveller_seq = sq and p.ended_at is null
                           and p.held_by_change_id = v.id)) then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if exists (select 1 from public.flight_sector_passengers p
             where p.held_by_change_id = v.id and p.ended_at is null
               and exists (select 1 from public.flight_ticket_revisions r
                           where r.sector_id = p.sector_id and r.traveller_seq = p.traveller_seq)) then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  perform set_config('authz.flight_transition', 'change_decide', true);
  update public.flight_sectors s
  set status = 'active', row_version = s.row_version + 1, updated_at = now()
  where s.change_id = v.id and s.status = 'pending';
  update public.flight_sector_passengers p
  set held_by_change_id = null, ended_at = now(), ended_by = (select auth.uid()), ended_by_change_id = v.id,
      ended_reason = 'change_approved'
  where p.held_by_change_id = v.id and p.ended_at is null;
end;
$$;

-- Reject / withdraw / supersede a pending change: its pending sectors end with
-- p_sector_status, their passengers end with p_reason, holds are cleared (the
-- passengers stay on their previous sectors).
create function authz.flight_change_close(p_change uuid, p_sector_status text, p_reason text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if authz.flight_transition() <> 'booking_apply' then
    perform set_config('authz.flight_transition', 'change_decide', true);
  end if;
  update public.flight_sector_passengers p
  set ended_at = now(), ended_by = (select auth.uid()), ended_by_change_id = p_change, ended_reason = p_reason
  where p.ended_at is null
    and p.sector_id in (select s.id from public.flight_sectors s where s.change_id = p_change and s.status = 'pending');
  update public.flight_sectors s
  set status = p_sector_status, ended_at = now(), ended_by = (select auth.uid()), row_version = s.row_version + 1, updated_at = now()
  where s.change_id = p_change and s.status = 'pending';
  update public.flight_sector_passengers p set held_by_change_id = null
  where p.held_by_change_id = p_change and p.ended_at is null;
end;
$$;

-- Ends every current passenger row of the given sectors.
create function authz.flight_end_sector_passengers(p_sectors uuid[], p_reason text) returns void
language sql volatile security definer set search_path = '' as $$
  update public.flight_sector_passengers p
  set held_by_change_id = null, ended_at = now(), ended_by = (select auth.uid()), ended_reason = p_reason
  where p.sector_id = any (p_sectors) and p.ended_at is null
$$;

-- ===========================================================================
-- 2. A1 group claim
-- ===========================================================================

create function public.flight_group_claim(p_deal_id uuid, p_request_id uuid) returns jsonb
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

-- Replaces 20261118000100: taking one flight task takes the Deal's whole
-- flight group (D1). Return shape unchanged plus taskIds.
create or replace function public.flight_task_claim(p_task_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_result jsonb;
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  perform authz.refuse_removed_deal(v_task.deal_id);
  if v_task.id is null or v_task.department <> 'flight' or not authz.can_claim_flight_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_result := public.flight_group_claim(v_task.deal_id, gen_random_uuid());
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  return jsonb_build_object('taskId', v_task.id, 'status', v_task.status, 'assignedToYou', true,
    'alreadyYours', not ((v_result -> 'claimedTaskIds') ? v_task.id::text), 'taskIds', v_result -> 'taskIds');
end;
$$;

-- ===========================================================================
-- 3. A2 group reassignment (branch Manager)
-- ===========================================================================

create function public.flight_group_reassign(
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

-- Replaces 20261127000100 (same body) with one added rule: flight tasks move
-- only together, through flight_group_reassign (contract A2).
create or replace function public.purchase_task_reassign(p_task_id uuid, p_expected_assignee uuid, p_to_user_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_from uuid;
  v_uid uuid := (select auth.uid());
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or not authz.can_manage_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Flight build (20261201000110): flight groups move through flight_group_reassign.
  if v_task.department = 'flight' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if v_task.status = 'supplier_confirmed' then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  if p_to_user_id is null or p_expected_assignee is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if v_task.status = 'in_progress' and v_task.assignee_user_id = p_to_user_id then
    return jsonb_build_object('taskId', v_task.id, 'outcome', 'existing');
  end if;
  if v_task.status <> 'in_progress' or v_task.assignee_user_id is distinct from p_expected_assignee then
    raise exception 'task_conflict' using errcode = '40001';
  end if;
  -- Batch 6: the new assignee holds the active role of the task's department
  -- (for a Purchase task the same rule as authz.is_active_purchase_person).
  if not authz.is_active_department_person(p_to_user_id, v_task.legal_entity_id, v_task.department) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  v_from := v_task.assignee_user_id;
  perform set_config('authz.task_transition', 'reassign', true);
  update public.fulfilment_tasks t set assignee_user_id = p_to_user_id, updated_at = now() where t.id = v_task.id;
  perform set_config('authz.task_transition', '', true);
  -- Batch 6: the Deal assignment follows the task's department (kind
  -- 'purchase', 'flight' or 'visa', as purchase_task_claim, flight_task_claim
  -- and visa_task_claim record it). A Purchase task keeps the previous call.
  if v_task.department = 'purchase' then
    perform authz.end_purchase_assignment(v_task.deal_id, v_from);
  else
    -- The previous assignee's assignment of this department ends unless they
    -- still hold another in-progress task of the same department on the Deal.
    update public.deal_assignments a set ended_at = now()
    where a.deal_id = v_task.deal_id and a.user_id = v_from and a.assignment_kind = v_task.department
      and a.ended_at is null
      and not exists (
        select 1 from public.fulfilment_tasks t
        where t.deal_id = v_task.deal_id and t.assignee_user_id = v_from and t.status = 'in_progress'
          and t.department = v_task.department
      );
  end if;
  insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
  values (v_task.deal_id, v_task.legal_entity_id, p_to_user_id, v_task.department, v_uid)
  on conflict (deal_id, user_id, assignment_kind) where ended_at is null do nothing;

  perform authz.write_audit('fulfilment.task_reassigned', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('dealId', v_task.deal_id, 'fromUserId', v_from, 'toUserId', p_to_user_id));
  return jsonb_build_object('taskId', v_task.id, 'outcome', 'created');
end;
$$;

-- ===========================================================================
-- 4. A3 booking change apply (D6, section 8)
-- ===========================================================================

create function public.flight_booking_change_apply(
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

-- ===========================================================================
-- 5. A4 screenshot sectors (D11) and A5 fill blank booking details (L11)
-- ===========================================================================

create function public.flight_screenshot_sectors_save(
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

create function public.flight_sector_fill_blanks(
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

-- ===========================================================================
-- 6. A6-A9 changes (D5)
-- ===========================================================================

create function public.flight_change_submit(p_task_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
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

create function public.flight_change_decide(
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

create function public.flight_change_withdraw(p_change_id uuid, p_expected_row_version integer, p_request_id uuid)
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

-- A9: Flight saw the decision (view state; no audit; clears the Home row).
create function public.flight_change_acknowledge(p_change_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_change public.flight_changes%rowtype;
  v_task public.fulfilment_tasks%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_change from public.flight_changes c where c.id = p_change_id;
  select * into v_task from public.fulfilment_tasks t where t.id = v_change.task_id;
  if v_change.id is null or v_task.assignee_user_id is distinct from (select auth.uid())
     or not authz.holds_active_role('flight', v_task.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_change from public.flight_changes c where c.id = p_change_id for update;
  if v_change.status not in ('approved', 'rejected') or v_change.flight_seen_at is not null then
    return jsonb_build_object('changeId', v_change.id, 'status', v_change.status, 'outcome', 'existing');
  end if;
  update public.flight_changes c set flight_seen_at = now(), updated_at = now() where c.id = p_change_id;
  return jsonb_build_object('changeId', v_change.id, 'status', v_change.status, 'outcome', 'updated');
end;
$$;

-- ===========================================================================
-- 7. A10 correct ticket (D8, L13)
-- ===========================================================================

create function public.flight_ticket_correct(
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

-- ===========================================================================
-- 8. A12 mark flight done (D10)
-- ===========================================================================

create function public.flight_group_complete(p_deal_id uuid, p_expected_task_ids uuid[], p_request_id uuid) returns jsonb
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

-- ===========================================================================
-- 9. A13 deprecated reads (kept one release, unchanged)
-- ===========================================================================

comment on function public.flight_task_list() is
  'Deprecated by the Flight build (20261201000110): the UI reads flight_queue(). Kept unchanged for one release.';
comment on function public.flight_task_get(uuid) is
  'Deprecated by the Flight build (20261201000110): the UI reads flight_workspace(). Kept unchanged for one release.';

-- ===========================================================================
-- 10. Tasks already in progress get their itinerary (data step)
-- ===========================================================================

insert into public.flight_task_state (task_id, legal_entity_id, deal_id, service_item_id, basis_version_id, built_by)
select t.id, t.legal_entity_id, t.deal_id, t.service_item_id, authz.task_current_version(t.id), t.assignee_user_id
from public.fulfilment_tasks t
where t.department = 'flight' and t.status = 'in_progress'
  and not exists (select 1 from public.flight_task_state s where s.task_id = t.id);
select authz.flight_build_sectors(t.id)
from public.fulfilment_tasks t
where t.department = 'flight' and t.status = 'in_progress';

-- ===========================================================================
-- 11. Grants
-- ===========================================================================

revoke all on function
  authz.flight_require_basis(uuid), authz.flight_sector_input(jsonb, text), authz.flight_sector_shape(uuid),
  authz.flight_sector_compare_shape(jsonb),
  authz.flight_insert_typed_sector(uuid, text, uuid, uuid, text, jsonb, integer[]),
  authz.flight_change_apply_approval(uuid), authz.flight_change_close(uuid, text, text),
  authz.flight_end_sector_passengers(uuid[], text)
from public, anon, authenticated, service_role;

revoke all on function
  public.flight_group_claim(uuid, uuid), public.flight_group_reassign(uuid, uuid, uuid, text, uuid),
  public.flight_booking_change_apply(uuid, uuid, uuid, uuid), public.flight_screenshot_sectors_save(uuid, integer, jsonb, uuid),
  public.flight_sector_fill_blanks(uuid, integer, jsonb, uuid), public.flight_change_submit(uuid, jsonb, uuid),
  public.flight_change_decide(uuid, text, text, integer, uuid), public.flight_change_withdraw(uuid, integer, uuid),
  public.flight_change_acknowledge(uuid), public.flight_ticket_correct(uuid, integer, integer, jsonb, text, uuid),
  public.flight_group_complete(uuid, uuid[], uuid)
from public, anon, authenticated, service_role;
grant execute on function
  public.flight_group_claim(uuid, uuid), public.flight_group_reassign(uuid, uuid, uuid, text, uuid),
  public.flight_booking_change_apply(uuid, uuid, uuid, uuid), public.flight_screenshot_sectors_save(uuid, integer, jsonb, uuid),
  public.flight_sector_fill_blanks(uuid, integer, jsonb, uuid), public.flight_change_submit(uuid, jsonb, uuid),
  public.flight_change_decide(uuid, text, text, integer, uuid), public.flight_change_withdraw(uuid, integer, uuid),
  public.flight_change_acknowledge(uuid), public.flight_ticket_correct(uuid, integer, integer, jsonb, text, uuid),
  public.flight_group_complete(uuid, uuid[], uuid)
to authenticated;
-- flight_task_claim and purchase_task_reassign keep their ACLs (CREATE OR REPLACE).

commit;
