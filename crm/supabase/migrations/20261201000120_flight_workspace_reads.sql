-- TripNavigate CRM - Flight build, track A (3 of 4): Flight workspace reads,
-- Home counts, Deal page reads and task History.
-- Contract: Flight department build contract (frozen 4 November 2026),
-- sections 7 (status words, progress), 9.1, 9.2, 9.4 (deal_flight_summary,
-- deal_flight_history, flight_home_counts, department_task_history) and 9.5;
-- owner decisions D1, D7, D9, D10, D12.
--
-- Reads (security definer, search_path '', session_ok first, execute to
-- authenticated only; null when the caller may not read; never a money key):
--   flight_queue()                     Flight people of the entity; branch Manager (own branch Deals)
--   flight_workspace(deal)             same readers; the Flight assignee gets canWork
--   deal_flight_summary(deal)          readers with full Deal-services scope (Sales, Manager, Accounts)
--   deal_flight_history(deal)          Sales owner, branch Manager, Accounts
--   flight_home_counts()               Home rows (null = not applicable to the caller)
--   department_task_history(task)      replaced: flight kinds; branch Manager reads flight history
--   authz.can_read_task_history(task)  replaced: flight tasks also for the branch Manager
--
-- Names of other staff: the Flight assignee, change requesters and deciders
-- are named; anyone else is left unnamed (null), as in department_task_history.
-- No amount, PNR or ticket number is read from audit rows.
--
-- Rollback (forward-only): a new migration revoking execute on the new reads
-- and restoring department_task_history (20261130000120) and
-- authz.can_read_task_history (20261125000100).

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Shared read helpers
-- ===========================================================================

create function authz.flight_staff_name(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select s.display_name from public.staff_profiles s where s.user_id = p_user
$$;

-- The Deal's Flight person: the assignee of its taken flight tasks.
create function authz.flight_group_assignee(p_deal uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select t.assignee_user_id
  from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
  where t.deal_id = p_deal and t.department = 'flight' and t.status in ('in_progress', 'completed')
  order by (t.status = 'in_progress') desc, i.item_no, t.id
  limit 1
$$;

-- The version the itinerary of a task shows: its basis once taken, else current.
create function authz.flight_display_version(p_task uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.basis_version_id from public.flight_task_state s where s.task_id = p_task),
                  authz.task_current_version(p_task))
$$;

create function authz.flight_status_text(p_code text, p_confirmed integer, p_required integer) returns text
language sql immutable set search_path = '' as $$
  select case p_code
    when 'waiting' then 'Waiting'
    when 'in_progress' then 'In progress · ' || coalesce(p_confirmed, 0) || ' of ' || coalesce(p_required, 0) || ' tickets'
    when 'all_confirmed' then 'All tickets confirmed'
    when 'done' then 'Done · ticket issued' end
$$;

create function authz.flight_task_status_json(p_task uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('code', c.code, 'text', authz.flight_status_text(c.code, k.confirmed, k.required),
                            'confirmed', k.confirmed, 'required', k.required)
  from public.fulfilment_tasks t
  cross join lateral authz.flight_ticket_counts(t.id) k
  cross join lateral (select case when t.status = 'not_started' then 'waiting'
                                  when t.status = 'completed' then 'done'
                                  when k.required > 0 and k.confirmed = k.required then 'all_confirmed'
                                  else 'in_progress' end as code) c
  where t.id = p_task
$$;

-- Group words (section 7): the not-completed tasks' sums; done when all are completed.
create function authz.flight_group_status_json(p_deal uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with k as (
    select t.status, c.confirmed, c.required
    from public.fulfilment_tasks t cross join lateral authz.flight_ticket_counts(t.id) c
    where t.deal_id = p_deal and t.department = 'flight'
  ), open as (
    select coalesce(sum(k.confirmed), 0)::integer as confirmed, coalesce(sum(k.required), 0)::integer as required,
           count(*) as n, count(*) filter (where k.status = 'not_started') as waiting
    from k where k.status <> 'completed'
  ), allk as (
    select coalesce(sum(k.confirmed), 0)::integer as confirmed, coalesce(sum(k.required), 0)::integer as required from k
  ), c as (
    select case when o.n = 0 then 'done'
                when o.waiting = o.n then 'waiting'
                when o.required > 0 and o.confirmed = o.required then 'all_confirmed'
                else 'in_progress' end as code,
           case when o.n = 0 then a.confirmed else o.confirmed end as confirmed,
           case when o.n = 0 then a.required else o.required end as required
    from open o cross join allk a
  )
  select jsonb_build_object('code', c.code, 'text', authz.flight_status_text(c.code, c.confirmed, c.required),
                            'confirmed', c.confirmed, 'required', c.required)
  from c
$$;

create function authz.flight_task_title(p_task uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(authz.service_item_title('flight', f.facts), ''), 'Flight ' || i.item_no::text)
  from public.fulfilment_tasks t
  join public.service_items i on i.id = t.service_item_id
  left join public.service_item_facts f on f.service_item_id = t.service_item_id
    and f.booking_version_id = authz.flight_display_version(t.id)
  where t.id = p_task
$$;

-- Sectors people actually fly on (active with a current passenger), by time.
create function authz.flight_flown_sectors(p_task uuid) returns setof public.flight_sectors
language sql stable security definer set search_path = '' as $$
  select s.* from public.flight_sectors s
  where s.task_id = p_task and s.status = 'active'
    and exists (select 1 from public.flight_sector_passengers p where p.sector_id = s.id and p.ended_at is null)
  order by s.depart_date, s.depart_time nulls last, s.created_at, s.id
$$;

-- 'JDH → DEL → GOX' from the flown sectors, else the booking legs, else 'From screenshot'.
create function authz.flight_route_text(p_task uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_route text;
  v_last text;
  r record;
begin
  for r in
    select x.from_place as f, x.to_place as t from authz.flight_flown_sectors(p_task) x
  loop
    if v_route is null then
      v_route := r.f;
    elsif r.f is distinct from v_last then
      v_route := v_route || ' → ' || r.f;
    end if;
    v_route := v_route || ' → ' || r.t;
    v_last := r.t;
  end loop;
  if v_route is null then
    for r in
      select e ->> 'from' as f, e ->> 'to' as t
      from public.fulfilment_tasks t2
      join public.service_item_facts fa on fa.service_item_id = t2.service_item_id
        and fa.booking_version_id = authz.flight_display_version(t2.id)
      cross join lateral jsonb_array_elements(authz.flight_facts_legs(fa.facts)) e
      where t2.id = p_task
      order by (e ->> 'legNo')::integer
    loop
      if v_route is null then
        v_route := r.f;
      elsif r.f is distinct from v_last then
        v_route := v_route || ' → ' || r.f;
      end if;
      v_route := v_route || ' → ' || r.t;
      v_last := r.t;
    end loop;
  end if;
  return coalesce(v_route, 'From screenshot');
end;
$$;

create function authz.flight_first_date(p_task uuid) returns date
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select min(x.depart_date) from authz.flight_flown_sectors(p_task) x),
    (select min((e ->> 'date')::date)
     from public.fulfilment_tasks t
     join public.service_item_facts f on f.service_item_id = t.service_item_id
       and f.booking_version_id = authz.flight_display_version(t.id)
     cross join lateral jsonb_array_elements(authz.flight_facts_legs(f.facts)) e
     where t.id = p_task))
$$;

-- Deal flight budget: sum of task budgets; null when any task has none.
create function authz.flight_group_budget(p_deal uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select case when bool_and(b.budget_paise is not null) then sum(b.budget_paise)::bigint end
  from public.fulfilment_tasks t cross join lateral authz.flight_task_budget(t.id) b
  where t.deal_id = p_deal and t.department = 'flight'
$$;

create function authz.flight_sector_summary_json(p_sector uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('sectorId', s.id, 'from', s.from_place, 'to', s.to_place,
    'departDate', to_char(s.depart_date, 'YYYY-MM-DD'), 'departTime', s.depart_time,
    'arriveDate', to_char(s.arrive_date, 'YYYY-MM-DD'), 'arriveTime', s.arrive_time,
    'airline', s.airline, 'flightNo', s.flight_no, 'cabin', s.cabin)
  from public.flight_sectors s where s.id = p_sector
$$;

-- Travellers of a flight task on a version: [{seq, fullName, type, ageYears,
-- specialNeeds} + identity keys when p_identity and the identity rule allows].
create function authz.flight_travellers_json(p_task uuid, p_version uuid, p_identity boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('seq', s.seq, 'fullName', s.full_name, 'type', s.traveller_type,
      'ageYears', s.age_years, 'specialNeeds', s.special_needs)
    || case when p_identity and authz.can_read_traveller_identity(t.deal_id, s.seq) then coalesce((
         select jsonb_build_object('identity', jsonb_build_object('dateOfBirth', to_char(x.date_of_birth, 'YYYY-MM-DD'),
           'nationality', x.nationality, 'passportNumber', x.passport_number,
           'passportExpiry', to_char(x.passport_expiry, 'YYYY-MM-DD')))
         from public.deal_travellers dt join public.traveller_identities x on x.traveller_id = dt.id
         where dt.deal_id = t.deal_id and dt.seq = s.seq),
         jsonb_build_object('identity', jsonb_build_object('dateOfBirth', null, 'nationality', null, 'passportNumber', null,
           'passportExpiry', null)))
       else '{}'::jsonb end
    order by s.seq), '[]'::jsonb)
  from public.fulfilment_tasks t
  join public.booking_version_travellers s on s.booking_version_id = p_version
  where t.id = p_task and s.seq = any (authz.item_participant_seqs(t.service_item_id, p_version))
$$;

create function authz.flight_ticket_json(p_sector uuid, p_seq integer, p_can_correct boolean, p_assignee uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when r.id is null then null else jsonb_build_object(
    'revisionNo', r.revision_no, 'crsType', r.crs_type, 'crsPnr', r.crs_pnr, 'airlinePnr', r.airline_pnr,
    'ticketNumber', r.ticket_number, 'batchNo', authz.flight_batch_no(r.batch_id),
    'confirmedAt', r1.created_at,
    'confirmedByName', case when r1.created_by = p_assignee then authz.flight_staff_name(r1.created_by) end,
    'travellerChanged', not exists (
      select 1 from public.booking_version_travellers s
      where s.booking_version_id = authz.task_current_version(r.task_id) and s.seq = r.traveller_seq
        and s.full_name = r.traveller_name and s.traveller_type = r.traveller_type),
    'canCorrect', p_can_correct,
    'history', (select coalesce(jsonb_agg(jsonb_build_object('revisionNo', h.revision_no, 'crsType', h.crs_type,
                   'crsPnr', h.crs_pnr, 'airlinePnr', h.airline_pnr, 'ticketNumber', h.ticket_number, 'reason', h.reason,
                   'at', h.created_at,
                   'byName', case when h.created_by = p_assignee then authz.flight_staff_name(h.created_by) end)
                   order by h.revision_no desc), '[]'::jsonb)
                from public.flight_ticket_revisions h where h.sector_id = p_sector and h.traveller_seq = p_seq)) end
  from (select 1) one
  left join lateral (select x.* from public.flight_ticket_revisions x
                     where x.sector_id = p_sector and x.traveller_seq = p_seq
                     order by x.revision_no desc limit 1) r on true
  left join public.flight_ticket_revisions r1 on r1.sector_id = p_sector and r1.traveller_seq = p_seq and r1.revision_no = 1
$$;

create function authz.flight_sector_json(p_sector uuid, p_editable boolean, p_can_correct boolean, p_assignee uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'sectorId', s.id, 'origin', s.origin, 'status', s.status,
    'displayState', case
      when s.status = 'active' and not exists (select 1 from public.flight_sector_passengers p where p.sector_id = s.id and p.ended_at is null)
           and exists (select 1 from public.flight_sector_passengers p where p.sector_id = s.id)
           and not exists (select 1 from public.flight_sector_passengers p
                           where p.sector_id = s.id and p.ended_reason is distinct from 'change_approved')
        then 'replaced'
      else s.status end,
    'changeId', s.change_id, 'changeNo', c.change_no,
    'from', s.from_place, 'to', s.to_place, 'departDate', to_char(s.depart_date, 'YYYY-MM-DD'), 'departTime', s.depart_time,
    'arriveDate', to_char(s.arrive_date, 'YYYY-MM-DD'), 'arriveTime', s.arrive_time, 'airline', s.airline,
    'flightNo', s.flight_no, 'cabin', s.cabin, 'rowVersion', s.row_version,
    'canFillBlanks', p_editable and s.status = 'active' and s.origin in ('booking', 'screenshot')
                     and (s.airline is null or s.flight_no is null or s.depart_time is null or s.arrive_time is null
                          or s.arrive_date is null),
    'canAlternate', p_editable and s.status = 'active' and exists (
                      select 1 from public.flight_sector_passengers p
                      where p.sector_id = s.id and p.ended_at is null and p.held_by_change_id is null
                        and not exists (select 1 from public.flight_ticket_revisions r
                                        where r.sector_id = s.id and r.traveller_seq = p.traveller_seq)
                        and not exists (select 1 from public.flight_changes pc
                                        where pc.task_id = s.task_id and pc.status = 'pending'
                                          and p.traveller_seq = any (pc.traveller_seqs))),
    'canEditScreenshot', p_editable and s.status = 'active' and s.origin = 'screenshot'
                         and not exists (select 1 from public.flight_ticket_revisions r where r.sector_id = s.id),
    'travellers', (select coalesce(jsonb_agg(jsonb_build_object(
                     'seq', p.traveller_seq, 'held', p.held_by_change_id is not null, 'heldByChangeNo', hc.change_no,
                     'ticket', authz.flight_ticket_json(s.id, p.traveller_seq, p_can_correct, p_assignee))
                     order by p.traveller_seq), '[]'::jsonb)
                   from public.flight_sector_passengers p
                   left join public.flight_changes hc on hc.id = p.held_by_change_id
                   where p.sector_id = s.id and p.ended_at is null),
    'endedTravellers', (select coalesce(jsonb_agg(jsonb_build_object('seq', p.traveller_seq, 'reason', p.ended_reason,
                          'at', p.ended_at) order by p.ended_at, p.traveller_seq), '[]'::jsonb)
                        from public.flight_sector_passengers p where p.sector_id = s.id and p.ended_at is not null))
  from public.flight_sectors s
  left join public.flight_changes c on c.id = s.change_id
  where s.id = p_sector
$$;

create function authz.flight_change_json(p_change uuid, p_can_work boolean, p_assignee uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'changeId', c.id, 'changeNo', c.change_no, 'kind', c.kind, 'status', c.status, 'deciderKind', c.decider_kind,
    'deciderName', case when c.decided_by is not null then authz.flight_staff_name(c.decided_by)
                        when c.decider_kind = 'sales_owner' then authz.flight_staff_name(d.owner_user_id)
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

-- Progress bar (section 7): Take · [Approvals] · Confirm tickets · Pay supplier · Attach e-tickets · Flight done.
create function authz.flight_progress_json(p_deal uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_status jsonb := authz.flight_group_status_json(p_deal);
  v_money text[] := coalesce(authz.flight_money_issues(p_deal), '{}'::text[]);
  v_steps jsonb := '[]'::jsonb;
  v_current boolean := false;
  v_taken boolean;
  v_has_approvals boolean;
  v_approvals_pending boolean;
  v_paid integer;
  v_total integer;
  v_etickets boolean;
  v_done boolean;
  r record;
begin
  v_taken := exists (select 1 from public.fulfilment_tasks t
                     where t.deal_id = p_deal and t.department = 'flight' and t.status in ('in_progress', 'completed'));
  v_approvals_pending := exists (select 1 from public.flight_changes c where c.deal_id = p_deal and c.status = 'pending')
                         or 'fare_approval_pending' = any (v_money);
  v_has_approvals := v_approvals_pending or exists (select 1 from public.flight_changes c
                                                    where c.deal_id = p_deal and c.decider_kind <> 'flight_owner');
  if not v_has_approvals and to_regclass('public.flight_fare_approvals') is not null then
    execute 'select exists (select 1 from public.flight_fare_approvals a where a.deal_id = $1)' into v_has_approvals using p_deal;
  end if;
  select k.paid, k.total into v_paid, v_total from authz.flight_batch_payment_counts(p_deal) k;
  v_etickets := exists (select 1 from public.department_evidence e join public.fulfilment_tasks t on t.id = e.task_id
                        where t.deal_id = p_deal and t.department = 'flight' and e.kind = 'e_ticket' and e.status = 'stored');
  v_done := not exists (select 1 from public.fulfilment_tasks t
                        where t.deal_id = p_deal and t.department = 'flight' and t.status <> 'completed');
  for r in
    select * from (values
      (1, 'take', v_taken or v_done, null::text, true),
      (2, 'approvals', v_done or not v_approvals_pending, case when v_approvals_pending then 'Waiting' end, v_has_approvals),
      (3, 'tickets', v_done or v_status ->> 'code' in ('all_confirmed', 'done'),
         (v_status ->> 'confirmed') || ' of ' || (v_status ->> 'required'), true),
      (4, 'payment', v_done or (v_total > 0 and v_paid = v_total
                                and not ('payment_missing' = any (v_money)) and not ('payment_returned' = any (v_money))),
         case when v_total > 0 then v_paid || ' of ' || v_total || ' batches' end, true),
      (5, 'etickets', v_done or v_etickets, null::text, true),
      (6, 'done', v_done, null::text, true)) s(n, key, done, sub, shown)
    order by n
  loop
    continue when not r.shown;
    v_steps := v_steps || jsonb_build_object('key', r.key,
      'state', case when r.done then 'done' when not v_current then 'current' else 'todo' end, 'sub', r.sub);
    if not r.done then
      v_current := true;
    end if;
  end loop;
  return v_steps;
end;
$$;

-- ===========================================================================
-- 2. flight_queue (section 9.1)
-- ===========================================================================

create function public.flight_queue() returns jsonb
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
          'budgetPaise', authz.flight_group_budget(d.id)::text,
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
    ) g), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- 3. flight_workspace (section 9.2) - no money keys at all
-- ===========================================================================

create function public.flight_workspace(p_deal_id uuid) returns jsonb
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

-- ===========================================================================
-- 4. Deal page reads (section 9.4)
-- ===========================================================================

create function public.deal_flight_summary(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_files boolean;
  v_assignee uuid;
  v_confirmed uuid;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  -- Readers with the full Deal-services scope only (Purchase, Flight and Visa never).
  if v_deal.id is null or authz.deal_services_scope(p_deal_id) is not null then
    return null;
  end if;
  v_files := authz.flight_is_sales_owner(p_deal_id) or authz.is_branch_sales_manager(p_deal_id)
             or authz.can_accounts(v_deal.legal_entity_id);
  v_assignee := authz.flight_group_assignee(p_deal_id);
  select v.id into v_confirmed from public.booking_versions v where v.deal_id = p_deal_id and v.status = 'confirmed';
  return jsonb_build_object(
    'flights', (select coalesce(jsonb_agg(jsonb_build_object(
        'taskId', t.id, 'itemNo', i.item_no, 'title', authz.flight_task_title(t.id),
        'status', authz.flight_task_status_json(t.id),
        'assigneeName', authz.flight_staff_name(case when t.status <> 'not_started' then t.assignee_user_id end),
        'unnamedCount', authz.flight_unnamed_count(t.id),
        'bookingChanged', s.task_id is not null and s.basis_version_id <> authz.task_current_version(t.id),
        'current', case when s.task_id is null then (
            select coalesce(jsonb_agg(jsonb_build_object('from', e ->> 'from', 'to', e ->> 'to', 'departDate', e ->> 'date',
                     'departTime', e ->> 'departTime', 'arriveDate', e ->> 'arrivalDate', 'arriveTime', e ->> 'arriveTime',
                     'flightNo', e ->> 'flightNo', 'cabin', f.facts ->> 'cabin',
                     'travellers', (select coalesce(jsonb_agg(bt.full_name order by bt.seq), '[]'::jsonb)
                                    from public.booking_version_travellers bt
                                    where bt.booking_version_id = authz.task_current_version(t.id)
                                      and bt.seq = any (authz.item_participant_seqs(t.service_item_id, authz.task_current_version(t.id)))))
                     order by (e ->> 'legNo')::integer), '[]'::jsonb)
            from public.service_item_facts f
            cross join lateral jsonb_array_elements(authz.flight_facts_legs(f.facts)) e
            where f.service_item_id = t.service_item_id and f.booking_version_id = authz.task_current_version(t.id))
          else (
            select coalesce(jsonb_agg((authz.flight_sector_summary_json(x.id) - 'sectorId' - 'airline')
                     || jsonb_build_object('travellers', (
                          select coalesce(jsonb_agg(coalesce(bt.full_name, 'Traveller ' || p.traveller_seq) order by p.traveller_seq), '[]'::jsonb)
                          from public.flight_sector_passengers p
                          left join public.booking_version_travellers bt on bt.booking_version_id = s.basis_version_id
                            and bt.seq = p.traveller_seq
                          where p.sector_id = x.id and p.ended_at is null))
                     order by x.depart_date, x.depart_time nulls last, x.created_at, x.id), '[]'::jsonb)
            from authz.flight_flown_sectors(t.id) x) end,
        'pending', (select coalesce(jsonb_agg(jsonb_build_object(
                       'changeId', c.id, 'changeNo', c.change_no, 'kind', c.kind, 'remark', c.remark,
                       'travellers', (select coalesce(jsonb_agg(coalesce(bt.full_name, 'Traveller ' || q.seq) order by q.seq), '[]'::jsonb)
                                      from unnest(c.traveller_seqs) q(seq)
                                      left join public.booking_version_travellers bt
                                        on bt.booking_version_id = c.basis_version_id and bt.seq = q.seq),
                       'from', (select coalesce(jsonb_agg(authz.flight_sector_summary_json(fs.id)
                                   order by fs.depart_date, fs.depart_time nulls last, fs.id), '[]'::jsonb)
                                from public.flight_sectors fs where fs.id = any (c.from_sector_ids)),
                       'to', (select coalesce(jsonb_agg(authz.flight_sector_summary_json(ns.id)
                                 order by ns.depart_date, ns.depart_time nulls last, ns.id), '[]'::jsonb)
                              from public.flight_sectors ns where ns.change_id = c.id),
                       'requestedAt', c.requested_at, 'requestedByName', authz.flight_staff_name(c.requested_by),
                       'rowVersion', c.row_version,
                       'canDecide', authz.flight_can_decide_change(c.id) and c.requested_by is distinct from (select auth.uid()))
                       order by c.change_no), '[]'::jsonb)
                    from public.flight_changes c where c.task_id = t.id and c.status = 'pending'),
        'eTickets', case when v_files then (
            select coalesce(jsonb_agg(jsonb_build_object('evidenceId', e.id, 'fileName', e.file_name) order by e.stored_at, e.id),
                            '[]'::jsonb)
            from public.department_evidence e where e.task_id = t.id and e.kind = 'e_ticket' and e.status = 'stored')
          else '[]'::jsonb end)
        order by i.item_no, t.id), '[]'::jsonb)
      from public.fulfilment_tasks t
      join public.service_items i on i.id = t.service_item_id
      left join public.flight_task_state s on s.task_id = t.id
      where t.deal_id = p_deal_id and t.department = 'flight'),
    -- D5: a transfer that meets a flight shows that flight's current sectors.
    'transfers', (select coalesce(jsonb_agg(jsonb_build_object(
        'transferItemId', ti.id,
        'transferTitle', coalesce(nullif(authz.service_item_title('transfer', tf.facts), ''), 'Car ' || ti.item_no::text),
        'flightTaskId', ft.id,
        'flightCurrent', (
            select coalesce(jsonb_agg(authz.flight_sector_summary_json(x.id)
                     order by x.depart_date, x.depart_time nulls last, x.created_at, x.id), '[]'::jsonb)
            from authz.flight_flown_sectors(ft.id) x))
        order by ti.item_no), '[]'::jsonb)
      from public.service_items ti
      join public.service_item_facts tf on tf.service_item_id = ti.id and tf.booking_version_id = v_confirmed
      join public.fulfilment_tasks ft on ft.department = 'flight' and ft.deal_id = p_deal_id
        and ft.service_item_id::text = tf.facts ->> 'flightItemId'
      where ti.deal_id = p_deal_id and ti.service_type = 'transfer'
        and jsonb_typeof(tf.facts -> 'flightItemId') = 'string'));
end;
$$;

-- Audit action -> History kind for flight work (section 9.5). Group events
-- (group_claimed, group_reassigned, group_completed) belong to the Deal
-- history; a task's History shows the per-task fulfilment events instead.
create function authz.flight_history_kind(p_action text) returns text
language sql immutable set search_path = '' as $$
  select case p_action
    when 'flight.group_claimed' then 'taken'
    when 'flight.group_reassigned' then 'reassigned'
    when 'flight.group_completed' then 'completed'
    when 'flight.booking_change_applied' then 'booking_change_applied'
    when 'flight.screenshot_sectors_saved' then 'sectors_entered'
    when 'flight.sector_details_filled' then 'sector_details_filled'
    when 'flight.change_submitted' then 'change_submitted'
    when 'flight.change_approved' then 'change_approved'
    when 'flight.change_rejected' then 'change_rejected'
    when 'flight.change_withdrawn' then 'change_withdrawn'
    when 'flight.tickets_confirmed' then 'tickets_confirmed'
    when 'flight.ticket_corrected' then 'ticket_corrected'
    when 'flight.fare_approval_requested' then 'fare_approval_requested'
    when 'flight.fare_approval_approved' then 'fare_approval_approved'
    when 'flight.fare_approval_returned' then 'fare_approval_returned'
    when 'flight.fare_approval_withdrawn' then 'fare_approval_withdrawn'
    when 'flight.direct_payment_recorded' then 'direct_payment_recorded'
    when 'flight.payment_requested' then 'payment_requested'
    when 'flight.payment_resubmitted' then 'payment_resubmitted'
    when 'flight.payment_cancelled' then 'payment_cancelled'
    when 'finance.supplier_payment_approved' then 'payment_approved'
    when 'finance.supplier_payment_returned' then 'payment_returned'
    when 'finance.supplier_payment_recorded' then 'payment_recorded'
    when 'finance.supplier_payment_verified' then 'payment_verified'
    when 'fulfilment.task_created' then 'created'
    when 'fulfilment.task_claimed' then 'taken'
    when 'fulfilment.task_released' then 'released'
    when 'fulfilment.task_reassigned' then 'reassigned'
    when 'fulfilment.task_completed' then 'completed'
    when 'department.evidence_stored' then 'file_added'
    when 'department.evidence_removed' then 'file_removed'
    when 'department.cost_saved' then 'cost_recorded'
    when 'department.cost_submitted' then 'sent_to_accounts'
    when 'finance.expense_record_accepted' then 'accounts_accepted'
    when 'finance.expense_record_returned' then 'accounts_returned'
  end
$$;

create function public.deal_flight_history(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_uid uuid := (select auth.uid());
  v_assignee uuid;
  v_events jsonb;
  v_n integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null or not (authz.flight_is_sales_owner(p_deal_id) or authz.is_branch_sales_manager(p_deal_id)
                               or authz.can_accounts(v_deal.legal_entity_id)) then
    return null;
  end if;
  v_assignee := authz.flight_group_assignee(p_deal_id);
  with targets (target_type, target_id, task_id) as (
    select 'fulfilment_task', t.id, t.id from public.fulfilment_tasks t where t.deal_id = p_deal_id and t.department = 'flight'
    union all
    select 'department_evidence', e.id, e.task_id from public.department_evidence e
    join public.fulfilment_tasks t on t.id = e.task_id where t.deal_id = p_deal_id and t.department = 'flight'
    union all
    select 'department_cost_entry', c.id, c.task_id from public.department_cost_entries c
    join public.fulfilment_tasks t on t.id = c.task_id where t.deal_id = p_deal_id and t.department = 'flight'
  ), picked as (
    select a.id, a.occurred_at, a.actor_user_id, a.action, a.reason, a.details, g.task_id,
           authz.flight_history_kind(a.action) as kind
    from targets g
    join public.audit_events a on a.target_type = g.target_type and a.target_id = g.target_id
    where authz.flight_history_kind(a.action) is not null
      -- Per-task events written together with a group event are shown once (the group event).
      and not (a.action in ('fulfilment.task_claimed', 'fulfilment.task_reassigned', 'fulfilment.task_completed')
               and a.details ->> 'group' = 'true')
    order by a.occurred_at desc, a.id desc
    limit 201
  )
  select count(*)::integer,
         coalesce(jsonb_agg(jsonb_build_object(
           'at', p.occurred_at, 'kind', p.kind, 'taskId', p.task_id, 'flightTitle', authz.flight_task_title(p.task_id),
           'byName', case when p.actor_user_id is not null and p.actor_user_id = v_assignee
                          then authz.flight_staff_name(p.actor_user_id) end,
           'byYou', p.actor_user_id is not null and p.actor_user_id = v_uid,
           'note', case when p.kind in ('change_rejected', 'ticket_corrected', 'fare_approval_returned', 'accounts_returned',
                                        'payment_returned', 'reassigned') then p.reason end,
           'changeNo', case when jsonb_typeof(p.details -> 'changeNo') = 'number' then (p.details ->> 'changeNo')::integer end)
           order by p.occurred_at desc, p.id desc) filter (where p.rn <= 200), '[]'::jsonb)
  into v_n, v_events
  from (select x.*, row_number() over (order by x.occurred_at desc, x.id desc) rn from picked x) p;
  return jsonb_build_object('events', v_events, 'truncated', v_n > 200);
end;
$$;

-- ===========================================================================
-- 5. Home counts (section 9.4, D12)
-- ===========================================================================

create function public.flight_home_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_f boolean;
  v_sales boolean;
  v_manager boolean;
  v_mine uuid[];
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select bool_or(m.role_code = 'flight'), bool_or(m.role_code = 'sales'), bool_or(m.role_code = 'manager')
  into v_f, v_sales, v_manager
  from public.memberships m
  join public.legal_entities e on e.id = m.legal_entity_id and e.status = 'enabled'
  join public.branches b on b.id = m.branch_id and b.status = 'enabled'
  where m.user_id = v_uid and m.status = 'active';
  v_f := coalesce(v_f, false);
  v_sales := coalesce(v_sales, false);
  v_manager := coalesce(v_manager, false);
  if v_f then
    select coalesce(array_agg(distinct t.deal_id), '{}'::uuid[]) into v_mine
    from public.fulfilment_tasks t join public.deals d on d.id = t.deal_id
    where t.department = 'flight' and t.status = 'in_progress' and t.assignee_user_id = v_uid and d.removed_at is null
      and authz.holds_active_role('flight', t.legal_entity_id);
  end if;
  return jsonb_build_object(
    'flightDealsNotTaken', case when v_f then (
        select count(*)::integer from public.deals d
        where d.removed_at is null and authz.holds_active_role('flight', d.legal_entity_id)
          and exists (select 1 from public.fulfilment_tasks t where t.deal_id = d.id and t.department = 'flight' and t.status = 'not_started')
          and not exists (select 1 from public.fulfilment_tasks t
                          where t.deal_id = d.id and t.department = 'flight' and t.status in ('in_progress', 'completed'))) end,
    'flightDealsMine', case when v_f then cardinality(v_mine) end,
    'flightBookingChanged', case when v_f then (
        select count(distinct t.deal_id)::integer from public.fulfilment_tasks t join public.flight_task_state s on s.task_id = t.id
        where t.deal_id = any (v_mine) and t.department = 'flight' and t.status = 'in_progress'
          and s.basis_version_id <> authz.task_current_version(t.id)) end,
    'flightChangesDecided', case when v_f then (
        select count(*)::integer from public.flight_changes c join public.fulfilment_tasks t on t.id = c.task_id
        where t.assignee_user_id = v_uid and t.status in ('in_progress', 'completed')
          and c.status in ('approved', 'rejected') and c.flight_seen_at is null
          and authz.holds_active_role('flight', t.legal_entity_id)) end,
    'flightReadyToFinish', case when v_f then (
        select count(*)::integer from unnest(v_mine) dm(id)
        where authz.flight_can_work(dm.id) and cardinality(authz.flight_done_issues(dm.id)) = 0) end,
    'salesFlightChangesToDecide', case when v_sales or v_manager then (
        select count(*)::integer from public.flight_changes c join public.deals d on d.id = c.deal_id
        where c.status = 'pending' and c.decider_kind <> 'flight_owner' and d.removed_at is null
          and c.requested_by is distinct from v_uid and authz.flight_can_decide_change(c.id)) end,
    'salesTravellersToName', case when v_sales then (
        select count(*)::integer from public.deals d
        where d.owner_user_id = v_uid and d.removed_at is null and authz.flight_is_sales_owner(d.id)
          and exists (select 1 from public.fulfilment_tasks t
                      where t.deal_id = d.id and t.department = 'flight' and t.status <> 'completed'
                        and authz.flight_unnamed_count(t.id) > 0)) end);
end;
$$;

-- ===========================================================================
-- 6. Task History (replaces 20261130000120 / 20261125000100)
-- ===========================================================================

create or replace function authz.can_read_task_history(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task
      and case t.department
            when 'purchase' then authz.can_read_purchase_task(t.id)
                                 and (authz.holds_active_role('purchase', t.legal_entity_id)
                                      or authz.is_branch_sales_manager(t.deal_id))
            -- Flight build: the branch Manager reads flight History too.
            when 'flight' then authz.can_read_flight_task(t.id) or authz.is_branch_sales_manager(t.deal_id)
            when 'visa' then authz.can_read_visa_task(t.id)
            else false end)
$$;

create or replace function public.department_task_history(p_task_id uuid) returns jsonb
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
           ('visa.application_withdrawn_by_revision', 'applicant_withdrawn'),
           -- Purchase build (20261130000120).
           ('purchase.rate_request_recorded', 'rate_request_sent'),
           ('purchase.booking_request_recorded', 'booking_request_sent'),
           ('purchase.supplier_email_sent', 'email_sent'),
           ('purchase.supplier_email_failed', 'email_failed'),
           ('purchase.go_ahead_requested', 'go_ahead_requested'),
           ('purchase.go_ahead_approved', 'go_ahead_approved'),
           ('purchase.go_ahead_returned', 'go_ahead_returned'),
           ('purchase.cancellation_charge_set', 'cancellation_charge_saved')
  ), flight_kinds (action, kind) as (
    -- Flight build (20261201000120), flight tasks only.
    values ('flight.booking_change_applied', 'booking_change_applied'),
           ('flight.screenshot_sectors_saved', 'sectors_entered'),
           ('flight.sector_details_filled', 'sector_details_filled'),
           ('flight.change_submitted', 'change_submitted'), ('flight.change_approved', 'change_approved'),
           ('flight.change_rejected', 'change_rejected'), ('flight.change_withdrawn', 'change_withdrawn'),
           ('flight.tickets_confirmed', 'tickets_confirmed'), ('flight.ticket_corrected', 'ticket_corrected'),
           ('flight.fare_approval_requested', 'fare_approval_requested'),
           ('flight.fare_approval_approved', 'fare_approval_approved'),
           ('flight.fare_approval_returned', 'fare_approval_returned'),
           ('flight.fare_approval_withdrawn', 'fare_approval_withdrawn'),
           ('flight.direct_payment_recorded', 'direct_payment_recorded'),
           ('flight.payment_requested', 'payment_requested'), ('flight.payment_resubmitted', 'payment_resubmitted'),
           ('flight.payment_cancelled', 'payment_cancelled'),
           ('finance.supplier_payment_approved', 'payment_approved'),
           ('finance.supplier_payment_returned', 'payment_returned'),
           ('finance.supplier_payment_recorded', 'payment_recorded'),
           ('finance.supplier_payment_verified', 'payment_verified')
  ), all_kinds (action, kind) as (
    select k.action, k.kind from kinds k
    union all
    select f.action, f.kind from flight_kinds f where v_task.department = 'flight'
  ), picked as (
    select a.id, a.occurred_at, a.actor_user_id, a.action, a.reason, a.details, k.kind
    from targets t
    join public.audit_events a
      on a.target_id = t.target_id and a.target_type = t.target_type
     and a.target_type in ('fulfilment_task', 'purchase_evidence', 'department_evidence', 'department_cost_entry',
                           'visa_application')
    join all_kinds k on k.action = a.action
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
           'note', case when p.kind in ('accounts_returned', 'applicant_withdrawn', 'go_ahead_returned',
                                        -- Flight build: reasons of rejected changes, corrections and returns.
                                        'change_rejected', 'ticket_corrected', 'fare_approval_returned', 'payment_returned')
                          or (p.kind = 'reassigned' and v_task.department = 'flight')
                        then p.reason end)
           -- Flight build: flight tasks also carry the change number of change events.
           || case when v_task.department = 'flight' then jsonb_build_object('changeNo',
                case when p.kind like 'change\_%' and jsonb_typeof(p.details -> 'changeNo') = 'number'
                     then p.details -> 'changeNo' end) else '{}'::jsonb end
           order by p.occurred_at desc, p.id desc) filter (where p.rn <= 200), '[]'::jsonb)
  into v_n, v_events
  from (select x.*, row_number() over (order by x.occurred_at desc, x.id desc) rn from picked x) p;

  return jsonb_build_object('taskId', v_task.id, 'department', v_task.department,
    'events', v_events, 'truncated', v_n > 200);
end;
$$;

-- ===========================================================================
-- 7. Grants
-- ===========================================================================

revoke all on function
  authz.flight_staff_name(uuid), authz.flight_group_assignee(uuid), authz.flight_display_version(uuid),
  authz.flight_status_text(text, integer, integer), authz.flight_task_status_json(uuid), authz.flight_group_status_json(uuid),
  authz.flight_task_title(uuid), authz.flight_flown_sectors(uuid), authz.flight_route_text(uuid), authz.flight_first_date(uuid),
  authz.flight_group_budget(uuid), authz.flight_sector_summary_json(uuid), authz.flight_travellers_json(uuid, uuid, boolean),
  authz.flight_ticket_json(uuid, integer, boolean, uuid), authz.flight_sector_json(uuid, boolean, boolean, uuid),
  authz.flight_change_json(uuid, boolean, uuid), authz.flight_progress_json(uuid), authz.flight_history_kind(text)
from public, anon, authenticated, service_role;

revoke all on function
  public.flight_queue(), public.flight_workspace(uuid), public.deal_flight_summary(uuid), public.deal_flight_history(uuid),
  public.flight_home_counts()
from public, anon, authenticated, service_role;
grant execute on function
  public.flight_queue(), public.flight_workspace(uuid), public.deal_flight_summary(uuid), public.deal_flight_history(uuid),
  public.flight_home_counts()
to authenticated;
-- department_task_history and authz.can_read_task_history keep their ACLs (CREATE OR REPLACE).

commit;
