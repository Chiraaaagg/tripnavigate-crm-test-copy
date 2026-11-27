-- TripNavigate CRM - Flight build, track A (UI review): data for precise
-- Home links.
-- Contract: Flight department build contract sections 9.1 and 9.4 (D12);
-- lead UI review, 5 November 2026.
--
-- What changes (same signatures and ACLs; bodies = 20261201000160_flight_review_fixes.sql / 20261201000120_flight_workspace_reads.sql plus keys):
--   1. flight_queue groups gain two booleans, true exactly for the Deals
--      flight_home_counts counts for the caller:
--        hasChangeDecision  a change on the caller's flights was approved or
--                           rejected and not yet seen (flightChangesDecided)
--        readyToFinish      the caller works the Deal and the done checklist
--                           passes (flightReadyToFinish)
--   2. flight_home_counts gains salesFlightChangesToDecideDealId and
--      salesTravellersToNameDealId: the Deal when exactly one Deal feeds that
--      row, else null (null too when the row itself is not applicable).
-- No money, no refusal tokens.
-- Rollback (forward-only): a new migration restoring both bodies.

begin;
set local lock_timeout = '15s';

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
          -- 20261201000180: the same rows flight_home_counts counts for the caller.
          'hasChangeDecision', exists (select 1 from public.flight_changes c join public.fulfilment_tasks t on t.id = c.task_id
                                       where c.deal_id = d.id and t.assignee_user_id = v_uid
                                         and t.status in ('in_progress', 'completed')
                                         and c.status in ('approved', 'rejected') and c.flight_seen_at is null
                                         and x.is_f),
          'readyToFinish', x.is_f and exists (select 1 from public.fulfilment_tasks t
                                              where t.deal_id = d.id and t.department = 'flight' and t.status = 'in_progress'
                                                and t.assignee_user_id = v_uid)
                           and authz.flight_can_work(d.id) and cardinality(authz.flight_done_issues(d.id)) = 0,
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

-- flight_home_counts
create or replace function public.flight_home_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_f boolean;
  v_sales boolean;
  v_manager boolean;
  v_mine uuid[];
  v_decide uuid[] := '{}'::uuid[];
  v_decide_deals uuid[] := '{}'::uuid[];
  v_name_deals uuid[] := '{}'::uuid[];
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
  if v_sales or v_manager then
    select coalesce(array_agg(c.id), '{}'::uuid[]), coalesce(array_agg(c.deal_id), '{}'::uuid[])
    into v_decide, v_decide_deals
    from public.flight_changes c join public.deals d on d.id = c.deal_id
    where c.status = 'pending' and c.decider_kind <> 'flight_owner' and d.removed_at is null
      and c.requested_by is distinct from v_uid and authz.flight_can_decide_change(c.id);
  end if;
  if v_sales then
    select coalesce(array_agg(d.id), '{}'::uuid[]) into v_name_deals
    from public.deals d
    where d.owner_user_id = v_uid and d.removed_at is null and authz.flight_is_sales_owner(d.id)
      and exists (select 1 from public.fulfilment_tasks t
                  where t.deal_id = d.id and t.department = 'flight' and t.status <> 'completed'
                    and authz.flight_unnamed_count(t.id) > 0);
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
    'salesFlightChangesToDecide', case when v_sales or v_manager then cardinality(v_decide) end,
    -- 20261201000180: the Deal when exactly one Deal feeds the row (Home links straight to it), else null.
    'salesFlightChangesToDecideDealId', case when (v_sales or v_manager)
                                                  and (select count(distinct x) from unnest(v_decide_deals) x) = 1
                                             then v_decide_deals[1] end,
    'salesTravellersToName', case when v_sales then cardinality(v_name_deals) end,
    'salesTravellersToNameDealId', case when v_sales and cardinality(v_name_deals) = 1 then v_name_deals[1] end);
end;
$$;

-- Both keep their ACLs (CREATE OR REPLACE).

commit;
