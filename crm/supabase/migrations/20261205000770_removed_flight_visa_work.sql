-- TripNavigate CRM - Accounts phase 3, track H (8): removed Flight and Visa
-- services are not work (independent review, lead 13 November 2026).
-- Contract: sections 11.1, 11.3, 20 R12, 21 LD13, LD30, LD31; Addendum L9.
--
-- New internal helper (no grant): authz.flight_owns_task_record(p_task) - the
--   pre-H rule of authz.flight_owns_task (the Flight assignee), kept for the
--   paperwork of a removed flight: supplier invoice / credit note and the
--   cancellation charge.
-- Replaced (latest bodies, same signatures; changed lines marked
-- "Accounts phase 3 (20261205000770)"):
--   authz.flight_done_issues, authz.flight_money_issues (a batch of a removed
--     flight is settled through its charges), public.flight_group_complete,
--     public.flight_workspace: the Deal's other flights can be marked done.
--   authz.can_work_department_task, authz.visa_can_manage_fees,
--     authz.flight_owns_task: false for a closed task; authz.visa_require_work,
--     public.flight_direct_payment_save, public.department_evidence_begin:
--     service_removed.
--   public.supplier_money_evidence_begin, public.supplier_document_link_task,
--     authz.sm_document_upload_flight, public.flight_cancellation_charge_set:
--     the paperwork exceptions keep working on a removed flight.
--   public.visa_cancellation_fee_set: already_decided once the removal is
--     approved (Visa fees have no reported-refund field).
-- Refusal tokens: service_removed (55000), already_decided (55000).
-- Rollback (forward-only): a NEW migration restoring the cited bodies.

begin;
set local lock_timeout = '15s';

create function authz.flight_owns_task_record(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task and t.department = 'flight' and t.status in ('in_progress', 'completed')
      and t.assignee_user_id = (select auth.uid()) and authz.holds_active_role('flight', t.legal_entity_id))
$$;
revoke all on function authz.flight_owns_task_record(uuid) from public, anon, authenticated, service_role;

-- Replaces 20261201000100_flight_workspace.sql:1090 (latest body; changed lines marked).
create or replace function authz.flight_done_issues(p_deal uuid) returns text[]
language plpgsql stable security definer set search_path = '' as $$
  -- Accounts phase 3 (20261205000770): a task closed by a service removal is not open work.
declare
  v_issues text[] := '{}'::text[];
  v_money text[];
begin
  -- Tasks not yet completed are the ones a "Mark flight done" completes.
  if exists (select 1 from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t join public.flight_task_state s on s.task_id = t.id
             where t.deal_id = p_deal and t.department = 'flight' and t.status <> 'completed'
               and s.basis_version_id <> authz.task_current_version(t.id)) then
    v_issues := v_issues || 'booking_changed'::text;
  end if;
  if exists (select 1 from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
             where t.deal_id = p_deal and t.department = 'flight' and t.status <> 'completed'
               and authz.flight_unnamed_count(t.id) > 0) then
    v_issues := v_issues || 'travellers_unnamed'::text;
  end if;
  if exists (select 1 from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
             cross join lateral unnest(authz.item_participant_seqs(t.service_item_id, authz.task_current_version(t.id))) p(seq)
             where t.deal_id = p_deal and t.department = 'flight' and t.status <> 'completed'
               and not exists (select 1 from public.flight_sector_passengers a join public.flight_sectors x on x.id = a.sector_id
                               where a.task_id = t.id and a.traveller_seq = p.seq and a.ended_at is null
                                 and x.status = 'active')) then
    v_issues := v_issues || 'traveller_without_flight'::text;
  end if;
  if exists (select 1 from public.flight_changes c where c.deal_id = p_deal and c.status = 'pending') then
    v_issues := v_issues || 'change_pending'::text;
  end if;
  if exists (select 1 from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t cross join lateral authz.flight_ticket_counts(t.id) k
             where t.deal_id = p_deal and t.department = 'flight' and t.status <> 'completed'
               and (k.required = 0 or k.confirmed < k.required)) then
    v_issues := v_issues || 'tickets_pending'::text;
  end if;
  if exists (select 1 from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
             join public.flight_sector_passengers a on a.task_id = t.id and a.ended_at is null
             join public.flight_sectors x on x.id = a.sector_id and x.status = 'active'
             cross join lateral (select r.traveller_name, r.traveller_type from public.flight_ticket_revisions r
                                 where r.sector_id = a.sector_id and r.traveller_seq = a.traveller_seq
                                 order by r.revision_no desc limit 1) r
             left join public.booking_version_travellers s
               on s.booking_version_id = authz.task_current_version(t.id) and s.seq = a.traveller_seq
             where t.deal_id = p_deal and t.department = 'flight' and t.status <> 'completed'
               and (r.traveller_name, r.traveller_type) is distinct from (s.full_name, s.traveller_type)) then
    v_issues := v_issues || 'traveller_changed'::text;
  end if;
  v_money := coalesce(authz.flight_money_issues(p_deal), '{}'::text[]);
  v_issues := v_issues || array(select m from unnest(array['fare_approval_pending', 'payment_missing', 'payment_returned']) m
                                where m = any (v_money));
  if not exists (select 1 from public.department_evidence e join (select x.* from public.fulfilment_tasks x where x.closed_state is null) t on t.id = e.task_id
                 where t.deal_id = p_deal and t.department = 'flight' and e.kind = 'e_ticket' and e.status = 'stored') then
    v_issues := v_issues || 'eticket_missing'::text;
  end if;
  return v_issues;
end;
$$;
-- Replaces 20261201000210_flight_money_commands.sql:455 (latest body; changed lines marked).
create or replace function authz.flight_money_issues(p_deal uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select array_remove(array[
    case when exists (select 1 from public.flight_fare_approvals a where a.deal_id = p_deal and a.status = 'pending')
         then 'fare_approval_pending' end,
    case when exists (select 1 from public.flight_ticket_batches b
                      cross join lateral authz.flight_batch_payment(b.id) x
                      where b.deal_id = p_deal and b.supplier_cost_paise > 0 and not x.paid
                        and x.state not in ('direct_returned', 'request_returned')
                        -- Accounts phase 3 (20261205000770): a batch of a removed flight is settled through its charges
                        and not exists (select 1 from public.fulfilment_tasks ct where ct.id = b.cost_task_id and ct.closed_state is not null))
         then 'payment_missing' end,
    case when exists (select 1 from public.flight_ticket_batches b
                      cross join lateral authz.flight_batch_payment(b.id) x
                      where b.deal_id = p_deal and b.supplier_cost_paise > 0 and not x.paid
                        and x.state in ('direct_returned', 'request_returned')
                        and not exists (select 1 from public.fulfilment_tasks ct where ct.id = b.cost_task_id and ct.closed_state is not null))  -- Accounts phase 3 (20261205000770)
         then 'payment_returned' end
  ]::text[], null)
$$;
-- Replaces 20261201000160_flight_review_fixes.sql:1052 (latest body; changed lines marked).
create or replace function public.flight_group_complete(p_deal_id uuid, p_expected_task_ids uuid[], p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
  -- Accounts phase 3 (20261205000770): a task closed by a service removal is not open work.
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
  select array_agg(t.id order by t.id) into v_ids from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
  where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'in_progress';
  if v_ids is distinct from (select array_agg(x order by x) from (select distinct unnest(p_expected_task_ids) x) q) then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_issues := authz.flight_done_issues(p_deal_id);
  if cardinality(v_issues) > 0 then
    raise exception 'not_ready' using errcode = '55000', hint = array_to_string(v_issues, ',');
  end if;
  for v_task in select t.* from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t where t.id = any (v_ids) order by t.id loop
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
-- Replaces 20261201000160_flight_review_fixes.sql:1227 (latest body; changed lines marked).
create or replace function public.flight_workspace(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
  -- Accounts phase 3 (20261205000770): a task closed by a service removal is not open work.
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
     or not exists (select 1 from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t where t.deal_id = p_deal_id and t.department = 'flight') then
    return null;
  end if;
  v_assignee := authz.flight_group_assignee(p_deal_id);
  v_can_work := authz.flight_can_work(p_deal_id);
  v_can_correct := coalesce(v_is_f and v_assignee = v_uid, false) or v_is_m;
  v_can_reassign := v_is_m and not authz.holds_role('flight', v_deal.legal_entity_id)
                    and exists (select 1 from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
                                where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'in_progress');
  select authz.task_current_version(t.id) into v_first_version
  from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t join public.service_items i on i.id = t.service_item_id
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
    from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
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
               and exists (select 1 from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
                           where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'not_started')
               and not exists (select 1 from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
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
    'completedAt', (select max(t.completed_at) from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
                    where t.deal_id = p_deal_id and t.department = 'flight'
                      and not exists (select 1 from (select x.* from public.fulfilment_tasks x where x.closed_state is null) o
                                      where o.deal_id = p_deal_id and o.department = 'flight' and o.status <> 'completed')),
    'completedByName', (select authz.flight_staff_name(t.completed_by) from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
                        where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'completed'
                          and not exists (select 1 from (select x.* from public.fulfilment_tasks x where x.closed_state is null) o
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
                 from public.department_evidence e join (select x.* from public.fulfilment_tasks x where x.closed_state is null) t on t.id = e.task_id
                 where t.deal_id = p_deal_id and t.department = 'flight' and e.kind = 'e_ticket' and e.status = 'stored'),
    'canUploadETicket', v_can_work);
end;
$$;
-- Replaces 20261119000500_b11_department_forms.sql:322 (latest body; changed lines marked).
create or replace function authz.can_work_department_task(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task and t.status = 'in_progress' and t.assignee_user_id = (select auth.uid())
      and t.closed_state is null  -- Accounts phase 3 (20261205000770)
      and authz.holds_active_role(t.department, t.legal_entity_id)
  )
$$;
-- Replaces 20261202000110_visa_desk_commands.sql:305 (latest body; changed lines marked).
create or replace function authz.visa_require_work(p_task uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task;
  if v_task.id is null or v_task.department <> 'visa' or v_task.assignee_user_id is distinct from (select auth.uid())
     or not authz.holds_active_role('visa', v_task.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_task.status = 'completed' then
    raise exception 'task_closed' using errcode = '55000';
  end if;
  -- Accounts phase 3 (20261205000770): a removed service takes no new work.
  if v_task.closed_state is not null then
    raise exception 'service_removed' using errcode = '55000';
  end if;
  if not authz.can_work_department_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
end;
$$;
-- Replaces 20261202000140_visa_review_fixes.sql:43 (latest body; changed lines marked).
create or replace function authz.visa_can_manage_fees(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task and t.department = 'visa' and t.status in ('in_progress', 'completed')
      and t.closed_state is null  -- Accounts phase 3 (20261205000770)
      and t.assignee_user_id = (select auth.uid()) and authz.holds_active_role('visa', t.legal_entity_id))
$$;
-- Replaces 20261201000210_flight_money_commands.sql:100 (latest body; changed lines marked).
create or replace function authz.flight_owns_task(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task and t.department = 'flight' and t.status in ('in_progress', 'completed')
      and t.closed_state is null  -- Accounts phase 3 (20261205000770): a removed flight is not Flight work
      and t.assignee_user_id = (select auth.uid()) and authz.holds_active_role('flight', t.legal_entity_id))
$$;
-- Replaces 20261201000250_flight_money_review_fixes.sql:527 (latest body; changed lines marked).
create or replace function public.flight_direct_payment_save(p_batch_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_batch public.flight_ticket_batches%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_old public.department_cost_entries%rowtype;
  v_entry public.department_cost_entries%rowtype;
  v_mode text;
  v_on date;
  v_ref text;
  v_proof uuid;
  v_payload jsonb := jsonb_build_object('batchId', p_batch_id, 'expectedRowVersion', p_expected_row_version,
    'fields', p_fields);
  v_result jsonb;
  v_outcome text;
  v_due bigint;
begin
  select * into v_batch from public.flight_ticket_batches b where b.id = p_batch_id;
  -- Accounts phase 3 (20261205000770): a removed flight takes no new payment (its assignee hears why).
  if exists (select 1 from public.fulfilment_tasks t where t.id = v_batch.cost_task_id and t.closed_state is not null)
     and authz.flight_owns_task_record(v_batch.cost_task_id) then
    raise exception 'service_removed' using errcode = '55000';
  end if;
  if v_batch.id is null or not authz.flight_owns_task(v_batch.cost_task_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.finance_lock_deal(v_batch.deal_id);
  perform authz.flight_lock_group(v_batch.deal_id);
  select * into v_task from public.fulfilment_tasks t where t.id = v_batch.cost_task_id;
  if not authz.flight_owns_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_money_gate(v_batch.deal_id);
  v_result := authz.flight_replay(v_batch.legal_entity_id, p_request_id, 'flight_direct_payment_save', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['paymentMode', 'paidOn', 'reference', 'proofEvidenceId']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  begin
    v_mode := authz.finance_field(p_fields, 'paymentMode');
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'paymentMode';
  end;
  if v_mode is null or v_mode not in ('bank_transfer', 'upi', 'card', 'cash', 'other') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'paymentMode';
  end if;
  begin
    v_on := authz.finance_date(authz.finance_field(p_fields, 'paidOn'));
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'paidOn';
  end;
  if v_on is null or v_on < date '2000-01-01' or v_on > authz.finance_today() then
    raise exception 'invalid_input' using errcode = '22023', hint = 'paidOn';
  end if;
  begin
    v_ref := authz.finance_text(authz.finance_field(p_fields, 'reference'), 1, 120, false);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reference';
  end;
  begin
    v_proof := authz.finance_uuid(authz.finance_field(p_fields, 'proofEvidenceId'));
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'proofEvidenceId';
  end;

  if authz.deal_trip_cancelled(v_batch.deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  if exists (select 1 from public.supplier_payment_requests p
             where p.flight_batch_id = v_batch.id and p.status in ('pending', 'approved', 'paid', 'verified')) then
    raise exception 'payment_in_progress' using errcode = '55000';
  end if;
  select * into v_old from public.department_cost_entries c where c.flight_batch_id = v_batch.id for update;
  if v_old.id is not null then
    if v_old.expense_status in ('submitted', 'accepted') then
      raise exception 'cost_locked' using errcode = '55000';
    end if;
    if p_expected_row_version is distinct from v_old.row_version then
      raise exception 'version_changed' using errcode = '40001';
    end if;
  end if;
  -- 20261201000250: less what old-form payments linked to the batch already cover.
  v_due := authz.flight_batch_due(v_batch.id);
  if v_due <= 0 then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if v_proof is null or not exists (
       select 1 from public.department_evidence e
       where e.id = v_proof and e.task_id = v_task.id and e.kind = 'direct_payment_proof' and e.status = 'stored') then
    raise exception 'receipt_required' using errcode = '55000';
  end if;
  -- C1: cumulative per (Deal, supplier), this payment included; exactly INR 50,000 is direct.
  if authz.sm_supplier_running_total(v_batch.deal_id, v_batch.supplier_id) + v_due > 5000000 then
    raise exception 'direct_payment_over_limit' using errcode = '22023';
  end if;

  if v_old.id is null then
    insert into public.department_cost_entries (task_id, deal_id, legal_entity_id, branch_id, department, cost_kind,
      amount_paise, paid_by, payment_mode, paid_on, reference, receipt_evidence_id, expense_status, submitted_by,
      submitted_at, request_id, created_by, supplier_id, flight_batch_id)
    values (v_task.id, v_batch.deal_id, v_batch.legal_entity_id, v_batch.branch_id, 'flight', 'fare',
      v_due, 'company', v_mode, v_on, v_ref, v_proof, 'submitted', v_uid,
      now(), p_request_id, v_uid, v_batch.supplier_id, v_batch.id)
    returning * into v_entry;
    v_outcome := 'created';
  else
    update public.department_cost_entries c
    set amount_paise = v_due, payment_mode = v_mode, paid_on = v_on, reference = v_ref,
        receipt_evidence_id = v_proof, expense_status = 'submitted', submitted_by = v_uid, submitted_at = now(),
        reviewed_by = null, reviewed_at = null, return_reason = null,
        row_version = c.row_version + 1, updated_at = now()
    where c.id = v_old.id
    returning * into v_entry;
    v_outcome := 'updated';
  end if;

  -- The existing cost audits (History, Accounts) plus the flight one; no amounts.
  perform authz.write_audit('department.cost_saved', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('taskId', v_task.id, 'department', 'flight', 'costKind', 'fare',
      'paidBy', 'company', 'rowVersion', v_entry.row_version));
  perform authz.write_audit('department.cost_submitted', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('taskId', v_task.id, 'department', 'flight', 'costKind', 'fare',
      'rowVersion', v_entry.row_version));
  perform authz.write_audit('flight.direct_payment_recorded', v_task.legal_entity_id, v_task.branch_id, 'fulfilment_task',
    v_task.id, null, jsonb_build_object('dealId', v_batch.deal_id, 'batchId', v_batch.id, 'entryId', v_entry.id));
  v_result := jsonb_build_object('outcome', v_outcome, 'batchId', v_batch.id, 'entryId', v_entry.id,
    'rowVersion', v_entry.row_version, 'expenseStatus', v_entry.expense_status);
  return authz.flight_remember(v_batch.legal_entity_id, p_request_id, 'flight_direct_payment_save', v_payload, v_result);
end;
$$;
-- Replaces 20261205000120_customer_message_commands.sql:247 (latest body; changed lines marked).
create or replace function public.department_evidence_begin(
  p_task_id uuid, p_application_id uuid, p_kind text, p_file_name text, p_mime text, p_size_bytes integer, p_sha256 text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_name text := btrim(coalesce(p_file_name, ''));
  v_sha text := lower(coalesce(p_sha256, ''));
  v_max integer := coalesce((select s.evidence_max_bytes from public.booking_settings s where s.id), 4194304);
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  perform authz.refuse_removed_deal(v_task.deal_id);
  if v_task.id is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Accounts phase 3 (20261205000770): no file (e-ticket, boarding pass, visa documents, receipts)
  -- on a removed service, so no customer message either.
  if v_task.closed_state is not null then
    raise exception 'service_removed' using errcode = '55000';
  end if;
  if p_kind = 'boarding_pass' then
    -- Accounts phase 3 (20261205000120): boarding passes from the Flight task's
    -- assignee, also after completion, once a ticket batch exists.
    if v_task.department <> 'flight' or not authz.flight_can_upload_boarding_pass(v_task.id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    if p_application_id is not null or not authz.flight_task_has_batch(v_task.id) then
      raise exception 'evidence_rejected' using errcode = '22023';
    end if;
  else
    -- 20261202000140: a completed visa task still takes fee receipts from its assignee.
    if v_task.status = 'supplier_confirmed'
       or (v_task.status = 'completed'
           and not (v_task.department = 'visa' and p_kind = 'fee_receipt' and authz.visa_can_manage_fees(v_task.id))) then
      raise exception 'task_closed' using errcode = '55000';
    end if;
    if not (authz.can_work_department_task(v_task.id) or authz.visa_can_manage_fees(v_task.id))
       or v_task.department = 'purchase' then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
  end if;
  if p_kind is null
     or (v_task.department = 'visa' and p_kind not in ('applicant_document', 'fee_receipt', 'authority_outcome', 'other'))
     -- Flight build (20261201000130): e-tickets; Accounts phase 3: boarding passes.
     or (v_task.department = 'flight' and p_kind not in ('e_ticket', 'direct_payment_proof', 'other', 'boarding_pass'))
     or (p_application_id is not null and not exists (
           select 1 from public.visa_applications a where a.id = p_application_id and a.task_id = v_task.id))
     or p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes not between 1 and least(v_max, 4194304)
     or v_sha !~ '^[0-9a-f]{64}$'
     or length(v_name) not between 1 and 120 or v_name !~ '^[A-Za-z0-9._ -]+$' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  -- Visa build (20261202000110, VL25): 200 files per visa task.
  if (select count(*) from public.department_evidence e where e.task_id = v_task.id and e.status <> 'removed')
     >= (case when v_task.department = 'visa' then 200 else 50 end) then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  v_path := v_task.legal_entity_id::text || '/' || v_task.id::text || '/' || v_id::text;
  insert into public.department_evidence (id, task_id, application_id, legal_entity_id, kind, object_path, file_name, mime,
    size_bytes, sha256, uploaded_by)
  values (v_id, v_task.id, p_application_id, v_task.legal_entity_id, p_kind, v_path, v_name, p_mime, p_size_bytes, v_sha,
    (select auth.uid()));
  perform authz.write_audit('department.evidence_started', v_task.legal_entity_id, v_task.branch_id,
    'department_evidence', v_id, null,
    jsonb_build_object('taskId', v_task.id, 'kind', p_kind, 'mime', p_mime, 'sizeBytes', p_size_bytes));
  return jsonb_build_object('evidenceId', v_id, 'objectPath', v_path);
end;
$$;
-- Replaces 20261205000760_removed_service_paperwork.sql:38 (latest body; changed lines marked).
create or replace function public.supplier_money_evidence_begin(
  p_kind text, p_target_id uuid, p_file_name text, p_mime text, p_size_bytes integer, p_sha256 text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_pay public.supplier_payment_requests%rowtype;
  v_synthetic boolean;
  v_gate text;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_name text := btrim(coalesce(p_file_name, ''));
  v_sha text := lower(coalesce(p_sha256, ''));
  v_payload jsonb := jsonb_build_object('kind', p_kind, 'targetId', p_target_id, 'fileName', p_file_name,
    'mime', p_mime, 'sizeBytes', p_size_bytes, 'sha256', p_sha256);
  v_result jsonb;
begin
  if p_kind = 'payment_proof' then
    select * into v_pay from public.supplier_payment_requests p where p.id = p_target_id;
    if v_pay.id is null then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    select d.is_synthetic into v_synthetic from public.deals d where d.id = v_pay.deal_id;
    perform authz.finance_require_accounts(v_pay.legal_entity_id, v_synthetic);
    select * into v_task from public.fulfilment_tasks t where t.id = v_pay.task_id;
  elsif p_kind in ('proforma', 'invoice')
        and exists (select 1 from public.fulfilment_tasks t where t.id = p_target_id and t.department = 'flight') then
    -- Flight build (20261201000210): the task's Flight person, also after done.
    select * into v_task from public.fulfilment_tasks t where t.id = p_target_id;
    if not (authz.flight_owns_task(v_task.id) or (p_kind = 'invoice' and authz.flight_owns_task_record(v_task.id))) then  -- Accounts phase 3 (20261205000770)
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    v_gate := authz.flight_gate_issue(v_task.deal_id);
    if v_gate is not null then
      raise exception '%', v_gate using errcode = '55000';
    end if;
  elsif p_kind in ('proforma', 'invoice', 'credit_note') then
    select * into v_task from public.fulfilment_tasks t where t.id = p_target_id;
    -- Accounts phase 3 (20261205000750): the assignee of a removed service hears service_removed
    -- (can_work_purchase_task is false for a closed task).
    if p_kind = 'proforma'  -- Accounts phase 3 (20261205000760): only a new payment's proforma; supplier paperwork stays allowed
       and v_task.closed_state is not null and v_task.department = 'purchase' and v_task.assignee_user_id = (select auth.uid())
       and authz.holds_active_role('purchase', v_task.legal_entity_id) then
      raise exception 'service_removed' using errcode = '55000';
    end if;
    if v_task.id is null or v_task.department is distinct from 'purchase'
       or not authz.holds_active_role('purchase', v_task.legal_entity_id)
       or (p_kind = 'proforma' and not authz.can_work_purchase_task(v_task.id)) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    v_gate := authz.procurement_gate_issue(v_task.id);
    -- Accounts phase 3 (20261205000760): the supplier's paperwork of a removed booked service.
    if v_gate = 'service_removed' and authz.removed_paperwork_ok(v_task.id, p_kind) then
      v_gate := null;
    end if;
    if v_gate is not null then
      raise exception '%', v_gate using errcode = '55000';
    end if;
  else
    if not coalesce(authz.session_ok(), false) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  v_result := authz.sm_replay(v_task.legal_entity_id, p_request_id, 'supplier_money_evidence_begin', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  if p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes not between 1 and 4194304
     or v_sha !~ '^[0-9a-f]{64}$'
     or length(v_name) not between 1 and 120 or v_name !~ '^[A-Za-z0-9._ -]+$' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  if p_kind = 'payment_proof' and v_pay.status <> 'approved' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if (select count(*) from public.supplier_money_evidence e
      where e.task_id = v_task.id and e.status <> 'removed') >= 40 then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  v_path := v_task.legal_entity_id::text || '/' || v_task.id::text || '/' || v_id::text;
  insert into public.supplier_money_evidence (id, legal_entity_id, task_id, payment_request_id, kind, object_path,
    file_name, mime, size_bytes, sha256, uploaded_by, request_id)
  values (v_id, v_task.legal_entity_id, v_task.id, v_pay.id, p_kind, v_path, v_name, p_mime, p_size_bytes, v_sha,
    (select auth.uid()), p_request_id);

  v_result := jsonb_build_object('outcome', 'created', 'evidenceId', v_id, 'objectPath', v_path);
  perform authz.sm_remember(v_task.legal_entity_id, p_request_id, 'supplier_money_evidence_begin', v_payload, v_result);
  perform authz.write_audit('purchase.money_file_started', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('evidenceId', v_id, 'kind', p_kind, 'mime', p_mime, 'sizeBytes', p_size_bytes));
  return v_result;
end;
$$;
-- Replaces 20261205000760_removed_service_paperwork.sql:237 (latest body; changed lines marked).
create or replace function public.supplier_document_link_task(p_document_id uuid, p_task_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_doc public.supplier_documents%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_synthetic boolean;
  v_is_accounts boolean;
  v_gate text;
  v_link public.supplier_document_tasks%rowtype;
  v_payload jsonb := jsonb_build_object('documentId', p_document_id, 'taskId', p_task_id);
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if p_document_id is null or p_task_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = case when p_document_id is null then 'documentId' else 'taskId' end;
  end if;
  select * into v_doc from public.supplier_documents s where s.id = p_document_id;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_doc.id is null or v_task.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = v_doc.deal_id;
  v_is_accounts := authz.sm_accounts_sees(v_doc.legal_entity_id, v_synthetic);
  if not v_is_accounts then
    if v_task.legal_entity_id <> v_doc.legal_entity_id or v_doc.status <> 'uploaded' then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    if v_task.department = 'purchase' then
      if v_task.assignee_user_id is distinct from (select auth.uid())
         or v_task.status not in ('in_progress', 'supplier_confirmed', 'completed')
         or not authz.holds_active_role('purchase', v_task.legal_entity_id) then
        raise exception 'not_authorized' using errcode = '42501';
      end if;
      v_gate := authz.procurement_gate_issue(v_task.id);
      -- Accounts phase 3 (20261205000760): the supplier's paperwork of a removed booked service.
      if v_gate = 'service_removed' and authz.removed_paperwork_ok(v_task.id, v_doc.kind) then
        v_gate := null;
      end if;
    elsif v_task.department = 'flight' then
      if not (authz.flight_owns_task(v_task.id)
              or (v_doc.kind in ('invoice', 'credit_note') and authz.flight_owns_task_record(v_task.id))) then  -- Accounts phase 3 (20261205000770)
        raise exception 'not_authorized' using errcode = '42501';
      end if;
      v_gate := authz.flight_gate_issue(v_task.deal_id);
    else
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    if v_gate is not null then
      raise exception '%', v_gate using errcode = '55000';
    end if;
  end if;

  perform authz.finance_lock_deal(v_task.deal_id);
  select * into v_doc from public.supplier_documents s where s.id = p_document_id for update;
  v_result := authz.sm_replay(v_doc.legal_entity_id, p_request_id, 'supplier_document_link_task', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_doc.status = 'returned' or (not v_is_accounts and v_doc.status <> 'uploaded') then
    raise exception 'link_not_allowed' using errcode = '55000', hint = 'documentId';
  end if;
  if v_task.legal_entity_id <> v_doc.legal_entity_id or v_task.id = v_doc.task_id
     or v_task.department not in ('purchase', 'flight')
     or not authz.sm_link_eligible(v_task.id, v_doc.supplier_id) then
    raise exception 'link_not_allowed' using errcode = '55000', hint = 'taskId';
  end if;

  select * into v_link from public.supplier_document_tasks l
  where l.document_id = v_doc.id and l.task_id = v_task.id and l.unlinked_at is null;
  if v_link.id is not null then
    v_result := jsonb_build_object('outcome', 'existing', 'linkId', v_link.id, 'documentId', v_doc.id,
      'taskId', v_task.id, 'dealId', v_task.deal_id);
    return authz.sm_remember(v_doc.legal_entity_id, p_request_id, 'supplier_document_link_task', v_payload, v_result);
  end if;

  insert into public.supplier_document_tasks (legal_entity_id, document_id, task_id, deal_id, branch_id, linked_by, request_id)
  values (v_doc.legal_entity_id, v_doc.id, v_task.id, v_task.deal_id, v_task.branch_id, (select auth.uid()), p_request_id)
  returning * into v_link;
  perform authz.write_audit('supplier.document_linked', v_doc.legal_entity_id, v_task.branch_id, 'supplier_document', v_doc.id,
    null, jsonb_build_object('documentId', v_doc.id, 'taskId', v_task.id, 'dealId', v_task.deal_id, 'linkId', v_link.id));
  v_result := jsonb_build_object('outcome', 'created', 'linkId', v_link.id, 'documentId', v_doc.id,
    'taskId', v_task.id, 'dealId', v_task.deal_id);
  return authz.sm_remember(v_doc.legal_entity_id, p_request_id, 'supplier_document_link_task', v_payload, v_result);
end;
$$;
-- Replaces 20261203000210_supplier_document_rules.sql:245 (latest body; changed lines marked).
create or replace function authz.sm_document_upload_flight(p_task_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_supplier uuid;
  v_kind text;
  v_number text;
  v_date date;
  v_total bigint;
  v_evidence uuid;
  v_id uuid := gen_random_uuid();
  v_payload jsonb := jsonb_build_object('taskId', p_task_id, 'fields', p_fields);
  v_result jsonb;
  v_gate text;
  v_constraint text;
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or not authz.flight_owns_task_record(v_task.id) then  -- Accounts phase 3 (20261205000770): supplier paperwork also on a removed flight
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_gate := authz.flight_gate_issue(v_task.deal_id);
  if v_gate is not null then
    raise exception '%', v_gate using errcode = '55000';
  end if;
  v_result := authz.sm_replay(v_task.legal_entity_id, p_request_id, 'supplier_document_upload', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['kind', 'number', 'docDate', 'totalPaise', 'gstIncluded', 'evidenceId', 'supplierId',
                          'creditsDocumentId']) <> '{}'::jsonb  -- Accounts phase (20261203000210)
     or jsonb_typeof(p_fields -> 'gstIncluded') is distinct from 'boolean' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_kind := authz.finance_field(p_fields, 'kind');
  v_number := authz.finance_text(authz.finance_field(p_fields, 'number'), 1, 60, false);
  v_date := authz.finance_date(authz.finance_field(p_fields, 'docDate'));
  v_total := authz.finance_paise(p_fields, 'totalPaise', 1);
  v_evidence := authz.finance_uuid(authz.finance_field(p_fields, 'evidenceId'));
  v_supplier := authz.finance_uuid(authz.finance_field(p_fields, 'supplierId'));
  if v_kind is distinct from 'invoice' or v_number is null or v_date is null
     or v_date not between date '2000-01-01' and authz.finance_today() + 1
     or v_total is null or v_total > 999999999999999 or v_evidence is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- Accounts phase (20261203000210): a credit link belongs to credit notes only.
  if authz.finance_field(p_fields, 'creditsDocumentId') is not null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'creditsDocumentId';
  end if;
  if not exists (select 1 from public.flight_ticket_batches b where b.cost_task_id = v_task.id) then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if v_supplier is null then
    if (select count(distinct b.supplier_id) from public.flight_ticket_batches b where b.cost_task_id = v_task.id) > 1 then
      raise exception 'invalid_input' using errcode = '22023', hint = 'supplierId';
    end if;
    select b.supplier_id into v_supplier from public.flight_ticket_batches b where b.cost_task_id = v_task.id limit 1;
  elsif not exists (select 1 from public.flight_ticket_batches b where b.cost_task_id = v_task.id and b.supplier_id = v_supplier) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'supplierId';
  end if;
  -- Accounts phase (20261203000210): duplicate refusal.
  perform authz.sm_document_refuse_duplicate(v_task.legal_entity_id, v_supplier, v_kind, v_number, v_date);
  if not exists (select 1 from public.supplier_money_evidence e
                 where e.id = v_evidence and e.task_id = v_task.id and e.kind = v_kind and e.status = 'stored')
     or exists (select 1 from public.supplier_documents s where s.evidence_id = v_evidence) then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  begin
    insert into public.supplier_documents (id, legal_entity_id, branch_id, deal_id, task_id, supplier_id, kind, number,
      doc_date, total_paise, gst_included, evidence_id, uploaded_by, request_id)
    values (v_id, v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, v_supplier, v_kind, v_number,
      v_date, v_total, (p_fields ->> 'gstIncluded')::boolean, v_evidence, (select auth.uid()), p_request_id);
  exception when unique_violation then
    -- Accounts phase (20261203000210): the race backstop.
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'supplier_documents_no_duplicate' then
      raise exception 'duplicate_supplier_document' using errcode = '23505', hint = 'number';
    end if;
    raise;
  end;
  perform authz.write_audit('purchase.supplier_document_uploaded', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null, jsonb_build_object('documentId', v_id, 'kind', v_kind, 'department', 'flight'));
  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'status', 'uploaded', 'rowVersion', 1);
  return authz.sm_remember(v_task.legal_entity_id, p_request_id, 'supplier_document_upload', v_payload, v_result);
end;
$$;
-- Replaces 20261205000730_service_removal_charges.sql:146 (latest body; changed lines marked).
create or replace function public.flight_cancellation_charge_set(p_batch_id uuid, p_fields jsonb, p_expected_revision integer,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_batch public.flight_ticket_batches%rowtype;
  v_c public.deal_cancellations%rowtype;
  v_prev public.flight_cancellation_charges%rowtype;
  v_existing public.flight_cancellation_charges%rowtype;
  v_key text;
  v_airline bigint;
  v_expected bigint;
  v_reported bigint;
  v_note text;
  v_rev integer;
  v_cr public.booking_change_requests%rowtype;  -- Accounts phase 3 (20261205000730)
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_batch from public.flight_ticket_batches b where b.id = p_batch_id;
  if v_batch.id is null or not authz.holds_active_role('flight', v_batch.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_request_id is null then
    perform authz.refund_invalid('requestId');
  end if;
  perform authz.refuse_removed_deal(v_batch.deal_id);
  -- Lock order (13.1): finance head, the Deal's Flight tasks, the cancellation row.
  perform authz.finance_lock_deal(v_batch.deal_id);
  perform 1 from authz.flight_lock_group(v_batch.deal_id);
  select * into v_c from public.deal_cancellations c where c.deal_id = v_batch.deal_id for update;
  -- Accounts phase 3 (20261205000730): without a trip cancellation, the charge belongs to the
  -- live remove_service request (route cancellation) whose service this batch
  -- serves (its cost task or one of its sectors, 11.3). Who: the batch's cost-task
  -- owner, or any active Flight person while that task has no assignee (C9).
  if v_c.id is null then
    select r.* into v_cr from public.booking_change_requests r
    where r.deal_id = v_batch.deal_id and r.kind = 'remove_service' and r.removal_route = 'cancellation'
      and r.status in ('requested', 'returned', 'approved', 'submitted')
      and (exists (select 1 from public.fulfilment_tasks t where t.id = v_batch.cost_task_id and t.service_item_id = any (r.item_ids))
           or exists (select 1 from public.flight_sectors s where s.id = any (v_batch.sector_ids) and s.service_item_id = any (r.item_ids)))
    for update;
    if v_cr.id is null then
      raise exception 'not_ready' using errcode = '55000', hint = 'cancellation';
    end if;
    if not exists (select 1 from public.fulfilment_tasks t
                   where t.id = v_batch.cost_task_id
                     and (authz.flight_owns_task_record(t.id)  -- Accounts phase 3 (20261205000770): also after the removal applied (LD13)
                          or (t.assignee_user_id is null and authz.holds_active_role('flight', t.legal_entity_id)))) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
  elsif not authz.flight_can_enter_charge(v_batch.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_existing from public.flight_cancellation_charges x
  where x.legal_entity_id = v_batch.legal_entity_id and x.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.batch_id = v_batch.id and v_existing.entered_by = v_uid
       and (v_existing.cancellation_id = v_c.id or v_existing.change_request_id = v_cr.id) then  -- Accounts phase 3 (20261205000730)
      return jsonb_build_object('outcome', 'existing', 'cancellationId', v_c.id, 'batchId', v_batch.id,
        'revisionNo', v_existing.revision_no, 'status', coalesce(v_c.status, 'charges_entered'), 'changeRequestId', v_cr.id);
    end if;
    raise exception 'duplicate_request' using errcode = '23505';
  end if;
  select * into v_prev from public.flight_cancellation_charges x
  where (x.cancellation_id = v_c.id or x.change_request_id = v_cr.id) and x.batch_id = v_batch.id  -- Accounts phase 3 (20261205000730)
  order by x.revision_no desc limit 1;
  v_rev := coalesce(v_prev.revision_no, 0);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    perform authz.refund_invalid('fields');
  end if;
  for v_key in select k from jsonb_object_keys(p_fields) k order by k loop
    if v_key <> all (array['airlineChargePaise', 'refundExpectedPaise', 'refundReportedPaise', 'note']) then
      perform authz.refund_invalid(v_key);
    end if;
  end loop;
  v_airline := authz.refund_paise(p_fields, 'airlineChargePaise');
  if v_airline is null or v_airline > 999999999999 then
    perform authz.refund_invalid('airlineChargePaise');
  end if;
  v_expected := authz.refund_paise(p_fields, 'refundExpectedPaise');
  if v_expected is null or v_expected > 999999999999 then
    perform authz.refund_invalid('refundExpectedPaise');
  end if;
  v_reported := authz.refund_paise(p_fields, 'refundReportedPaise');
  if v_reported > 999999999999 then
    perform authz.refund_invalid('refundReportedPaise');
  end if;
  v_note := authz.refund_text(p_fields, 'note', 1, 500, true);
  -- LD13: after approval only the Flight-reported refund may change.
  if (v_c.status = 'approved' or v_cr.status in ('approved', 'submitted'))  -- Accounts phase 3 (20261205000730): the same after the removal was approved
     and (v_prev.id is null or v_airline is distinct from v_prev.airline_charge_paise
          or v_expected is distinct from v_prev.refund_expected_paise) then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_revision is distinct from v_rev then
    raise exception 'version_changed' using errcode = '40001';
  end if;

  insert into public.flight_cancellation_charges (cancellation_id, legal_entity_id, deal_id, batch_id, cost_task_id, supplier_id,
    revision_no, supplier_cost_paise, airline_charge_paise, refund_expected_paise, refund_reported_paise, note, entered_by, request_id,
    change_request_id)  -- Accounts phase 3 (20261205000730)
  values (v_c.id, v_batch.legal_entity_id, v_batch.deal_id, v_batch.id, v_batch.cost_task_id, v_batch.supplier_id, v_rev + 1,
    v_batch.supplier_cost_paise, v_airline, v_expected, v_reported, v_note, v_uid, p_request_id, v_cr.id);
  -- Purchase rule: a change before approval (also after sending) puts the case back to charges_entered.
  if v_c.status <> 'approved' then
    update public.deal_cancellations c
    set status = 'charges_entered', row_version = c.row_version + 1, updated_at = now()
    where c.id = v_c.id;
  end if;
  perform authz.write_audit('flight.cancellation_charge_set', v_batch.legal_entity_id, v_batch.branch_id,
    'flight_ticket_batch', v_batch.id, null,
    jsonb_build_object('cancellationId', v_c.id, 'batchId', v_batch.id, 'revisionNo', v_rev + 1, 'previousStatus', v_c.status,
      'changeRequestId', v_cr.id));  -- Accounts phase 3 (20261205000730)
  return jsonb_build_object('outcome', 'created', 'cancellationId', v_c.id, 'batchId', v_batch.id, 'revisionNo', v_rev + 1,
    'status', case when v_c.status = 'approved' or v_cr.status in ('approved', 'submitted') then 'approved' else 'charges_entered' end,
    'changeRequestId', v_cr.id);
end;
$$;
-- Replaces 20261205000730_service_removal_charges.sql:272 (latest body; changed lines marked).
create or replace function public.visa_cancellation_fee_set(p_entry_id uuid, p_refund_expected_paise bigint, p_note text,
  p_expected_revision integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_entry public.department_cost_entries%rowtype;
  v_c public.deal_cancellations%rowtype;
  v_existing public.visa_cancellation_fees%rowtype;
  v_rev integer;
  v_note text;
  v_cr public.booking_change_requests%rowtype;  -- Accounts phase 3 (20261205000730)
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_entry from public.department_cost_entries c where c.id = p_entry_id;
  if v_entry.id is null or v_entry.department <> 'visa' or not authz.visa_can_manage_fees(v_entry.task_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    perform authz.refund_invalid('requestId');
  end if;
  perform authz.refuse_removed_deal(v_entry.deal_id);
  perform authz.finance_lock_deal(v_entry.deal_id);
  perform 1 from public.fulfilment_tasks t where t.id = v_entry.task_id for update;
  select * into v_c from public.deal_cancellations c where c.deal_id = v_entry.deal_id;
  -- Accounts phase 3 (20261205000730): without a trip cancellation, the fee refund belongs to the
  -- remove_service request (route cancellation) naming this Visa service, live or applied (11.3).
  if v_c.id is null then
    select r.* into v_cr from public.booking_change_requests r
    join public.fulfilment_tasks t on t.id = v_entry.task_id
    where r.deal_id = v_entry.deal_id and r.kind = 'remove_service' and r.removal_route = 'cancellation'
      and t.service_item_id = any (r.item_ids) and r.status in ('requested', 'returned', 'approved', 'submitted', 'applied')
    order by r.requested_at desc, r.id desc limit 1
    for share of r;
  end if;
  -- Accounts phase 3 (20261205000770): the fee refunds of a removal stand once the Manager approved it.
  if v_cr.id is not null and v_cr.status not in ('requested', 'returned') then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if (v_c.id is null and v_cr.id is null) or v_entry.paid_by <> 'company' then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  select * into v_existing from public.visa_cancellation_fees x
  where x.legal_entity_id = v_entry.legal_entity_id and x.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.entry_id = v_entry.id and v_existing.entered_by = v_uid then
      return jsonb_build_object('outcome', 'existing', 'entryId', v_entry.id, 'revisionNo', v_existing.revision_no);
    end if;
    raise exception 'duplicate_request' using errcode = '23505';
  end if;
  select coalesce(max(x.revision_no), 0) into v_rev from public.visa_cancellation_fees x
  where (x.cancellation_id = v_c.id or x.change_request_id = v_cr.id) and x.entry_id = v_entry.id;  -- Accounts phase 3 (20261205000730)
  if p_expected_revision is distinct from v_rev then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if p_refund_expected_paise is null or p_refund_expected_paise < 0 or p_refund_expected_paise > v_entry.amount_paise then
    perform authz.refund_invalid('refundExpectedPaise');
  end if;
  begin
    v_note := authz.finance_text(p_note, 1, 500, true);
  exception when sqlstate '22023' then
    perform authz.refund_invalid('note');
  end;
  insert into public.visa_cancellation_fees (cancellation_id, legal_entity_id, deal_id, task_id, entry_id, revision_no,
    refund_expected_paise, note, entered_by, request_id, change_request_id)  -- Accounts phase 3 (20261205000730)
  values (v_c.id, v_entry.legal_entity_id, v_entry.deal_id, v_entry.task_id, v_entry.id, v_rev + 1, p_refund_expected_paise,
    v_note, v_uid, p_request_id, v_cr.id);
  perform authz.write_audit('visa.cancellation_fee_set', v_entry.legal_entity_id, v_entry.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('cancellationId', v_c.id, 'entryId', v_entry.id, 'revisionNo', v_rev + 1,
      'changeRequestId', v_cr.id));  -- Accounts phase 3 (20261205000730)
  return jsonb_build_object('outcome', 'created', 'entryId', v_entry.id, 'cancellationId', v_c.id, 'revisionNo', v_rev + 1,
    'changeRequestId', v_cr.id);
end;
$$;

commit;
