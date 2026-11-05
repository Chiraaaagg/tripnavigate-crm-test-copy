-- TripNavigate CRM - Flight build, track A (round 2): workspace additions
-- requested by the screens (lead, 4 November 2026).
-- Contract: Flight department build contract section 9.2, extended by the
-- lead on 4 November 2026 (integration round 2).
--
-- What changes (flight_workspace keeps its signature; replaced body = the
-- 20261201000120 body plus two keys):
--   1. assigneeUserId: the Deal's Flight person, returned only when the
--      caller may reassign the group (branch Manager without a Flight role;
--      the same rule as canReassign), else null. Drives the reassign form's
--      expected assignee.
--   2. flights[].salesFare: the Sales fare estimate of that flight from the
--      booking (per person by type: adult, child, infant), with the
--      participants per type. Source 'item' = the flight's own estimate;
--      'all_flights' = the booking's typed fare per person for all flights
--      (used when the flight has none); null = no estimate. It is the Sales
--      estimate (cost side), never a selling price, markup or margin. The
--      workspace is read only by the Flight people of the entity and the
--      branch Manager; Purchase and Visa get null as before. (The Sales owner
--      and Accounts do not read the workspace.)
--
-- No new refusal tokens.
-- Rollback (forward-only): a new migration restoring flight_workspace from
-- 20261201000120; authz.flight_sales_fare_json may stay unused.

begin;
set local lock_timeout = '15s';

-- Sales fare estimate of a flight task on a version (paise as text).
create function authz.flight_sales_fare_json(p_task uuid, p_version uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with t as (
    select x.service_item_id from public.fulfilment_tasks x where x.id = p_task and x.department = 'flight'
  ), item as (
    select ce.fare_adult_paise as a, ce.fare_child_paise as c, ce.fare_infant_paise as i, ce.fare_total_paise as legacy
    from t join public.service_item_cost_estimates ce
      on ce.service_item_id = t.service_item_id and ce.booking_version_id = p_version
  ), booking as (
    select vf.adult_paise as a, vf.child_paise as c, vf.infant_paise as i
    from public.booking_version_flight_fares vf where vf.booking_version_id = p_version
  ), pax as (
    select count(*) filter (where s.traveller_type = 'adult')::integer as adults,
           count(*) filter (where s.traveller_type = 'child')::integer as children,
           count(*) filter (where s.traveller_type = 'infant')::integer as infants
    from t join public.booking_version_travellers s on s.booking_version_id = p_version
    where s.seq = any (authz.item_participant_seqs(t.service_item_id, p_version))
  ), pick as (
    select case when coalesce((select coalesce(a, c, i) from item), null) is not null then 'item'
                when exists (select 1 from booking) then 'all_flights' end as source
  )
  select case when pick.source is null then null else jsonb_build_object(
      'source', pick.source,
      'adultPaise', (case when pick.source = 'item' then (select a from item) else (select a from booking) end)::text,
      'childPaise', (case when pick.source = 'item' then (select c from item) else (select c from booking) end)::text,
      'infantPaise', (case when pick.source = 'item' then (select i from item) else (select i from booking) end)::text,
      'adults', pax.adults, 'children', pax.children, 'infants', pax.infants) end
  from pick cross join pax
$$;
revoke all on function authz.flight_sales_fare_json(uuid, uuid) from public, anon, authenticated, service_role;

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
      'salesFare', authz.flight_sales_fare_json(t.id, dv.vid),
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
-- flight_workspace keeps its ACL (CREATE OR REPLACE).

commit;
