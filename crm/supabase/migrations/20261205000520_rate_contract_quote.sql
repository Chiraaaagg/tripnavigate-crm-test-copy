-- TripNavigate CRM - Accounts phase 3, track E (3 of 5): contract price on the
-- Purchase offer, the Manager's and Accounts' flags, and the expiry alerts.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 9.1 (alerts),
-- 9.2 (price lookup), 9.3 E9 and the sm_manager_cost_rows /
-- purchase_go_ahead_json notes, 19 (E's shared functions), LD21.
--
-- New:
--   authz.rate_contract_price(p_entity, p_supplier, p_hotel, p_room_type,
--     p_meal_plan, p_check_in, p_check_out, p_rooms) returns jsonb (stable):
--     night by night from the ACTIVE contract covering each night (a stay
--     across two seasons or two contracts uses each night's own line; the
--     weekend rate on Friday and Saturday nights when the line has one):
--     {state ok | no_contract | partial | blackout | ended, contractIds (in
--     night order), nights [{date, ratePaise, lineId, weekend}],
--     perRoomTotalPaise, totalPaise (x rooms; both only when ok), endedOn}.
--     blackout = a night with a matching line falls on a blackout date;
--     partial = some nights priced; ended = no active contract covers any
--     night and one of the supplier + hotel ended (end of validity, or the day
--     it was ended) before check-in (endedOn = the latest such day).
--   authz.rc_task_stay(p_task): checkIn, checkOut, rooms of the task's
--     current booking facts (never typed again).
--   authz.rate_contract_expiry() (timer task 'rate_contract_expiry', every 60
--     minutes; acts from 09:00 India time, so the day's rows appear at about
--     09:00): one rate_contract_alerts row when an active contract has
--     exactly 30 or 7 days left (India date) and no later active contract of
--     the same supplier and hotel exists. Idempotent (unique contract + days).
--     Returns {inserted, waiting} (counts only).
-- Replaced (latest bodies, changed lines marked "Accounts phase 3 (20261205000520)"):
--   public.purchase_quote_add (M/20261204000110:923, same signature): allowlist
--     + roomTypeId, mealPlanCode, contractDeviationReason. With the switch On,
--     a hotel task with a catalogue hotel and both pick-list values is priced
--     by authz.rate_contract_price from the task's stay: rate_contract_id (the
--     first night's contract), contract_total_paise and contract_state
--     matches | differs (reason 10..300 required: invalid_input hint
--     contractDeviationReason) | ended | none. Free-text roomType / mealPlan
--     default to the room type name and the meal plan label. Switch Off: the
--     three keys are ignored and every quote is 'none' (behaviour as before).
--   public.manager_approvals (M/20261204000900:101, same signature): each
--     costsAboveBudget row gains contractState, contractTotalPaise,
--     contractDeviationReason of the cost's quote (additive keys).
--     authz.sm_manager_cost_rows (M/20261204000900:39) is NOT changed: it
--     returns keys only (task, version, since, created_by); the JSON is built
--     here, where the quote is already joined.
--   authz.purchase_go_ahead_json (M/20261130000120:33, same signature): the
--     go-ahead object gains contractState, contractTotalPaise,
--     contractDeviationReason of the request's quote (additive keys).
--
-- Refusal tokens: invalid_input (22023, hints roomTypeId, mealPlanCode,
-- contractDeviationReason); the rest of purchase_quote_add is unchanged.
-- Rollback (forward-only): a new migration restoring the three replaced bodies
-- and disabling the timer task (timer_tasks.enabled = false).

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Price lookup (9.2)
-- ===========================================================================

create function authz.rate_contract_price(p_entity uuid, p_supplier uuid, p_hotel uuid, p_room_type uuid, p_meal_plan text,
  p_check_in date, p_check_out date, p_rooms integer) returns jsonb
language sql stable security definer set search_path = '' as $$
  with nights as (
    select d::date as night
    from generate_series(p_check_in, p_check_out - 1, interval '1 day') d
    where p_entity is not null and p_supplier is not null and p_hotel is not null and p_room_type is not null
      and p_meal_plan is not null and p_check_in is not null and p_check_out > p_check_in and p_check_out - p_check_in <= 366
  ),
  cov as (
    select n.night, c.id as contract_id
    from nights n
    left join lateral (
      select x.id from public.rate_contracts x
      where x.legal_entity_id = p_entity and x.supplier_id = p_supplier and x.hotel_id = p_hotel and x.status = 'active'
        and n.night between x.valid_from and x.valid_to
      order by x.valid_from desc, x.id
      limit 1) c on true
  ),
  priced as (
    select v.night, v.contract_id, l.id as line_id,
      extract(isodow from v.night) in (5, 6) as weekend,
      case when extract(isodow from v.night) in (5, 6) and l.weekend_rate_paise is not null then l.weekend_rate_paise
           else l.rate_paise end as rate,
      l.id is not null and exists (select 1 from public.rate_contract_blackouts b
                                   where b.contract_id = v.contract_id and v.night between b.from_date and b.to_date) as blackout
    from cov v
    left join lateral (
      select y.id, y.rate_paise, y.weekend_rate_paise from public.rate_contract_lines y
      where y.contract_id = v.contract_id and y.room_type_id = p_room_type and y.meal_plan = p_meal_plan
        and v.night between y.season_from and y.season_to
      order by y.season_from desc, y.id
      limit 1) l on true
  ),
  agg as (
    select count(*) as total,
      count(*) filter (where p.contract_id is not null) as covered,
      count(*) filter (where p.line_id is not null and not p.blackout) as ok_n,
      coalesce(bool_or(p.blackout), false) as any_blackout,
      sum(p.rate) filter (where p.line_id is not null and not p.blackout) as per_room
    from priced p
  ),
  ended as (
    select max(case when x.status = 'ended' then least(x.valid_to, (x.ended_at at time zone 'Asia/Kolkata')::date)
                    else x.valid_to end) as d
    from public.rate_contracts x
    where x.legal_entity_id = p_entity and x.supplier_id = p_supplier and x.hotel_id = p_hotel
      and x.status in ('active', 'ended')
      and case when x.status = 'ended' then least(x.valid_to, (x.ended_at at time zone 'Asia/Kolkata')::date)
               else x.valid_to end < p_check_in
  ),
  st as (
    select case
      when a.total = 0 then 'no_contract'
      when a.any_blackout then 'blackout'
      when a.ok_n = a.total then 'ok'
      when a.ok_n > 0 then 'partial'
      when a.covered = 0 and e.d is not null then 'ended'
      else 'no_contract' end as state,
      a.per_room, e.d as ended_on
    from agg a cross join ended e
  )
  select jsonb_build_object(
    'state', st.state,
    'contractIds', coalesce((
      select jsonb_agg(k.contract_id order by k.first_night)
      from (select p.contract_id, min(p.night) as first_night from priced p
            where p.line_id is not null and not p.blackout group by p.contract_id) k), '[]'::jsonb),
    'nights', coalesce((
      select jsonb_agg(jsonb_build_object('date', to_char(p.night, 'YYYY-MM-DD'), 'ratePaise', p.rate::text, 'lineId', p.line_id,
          'weekend', p.weekend) order by p.night)
      from priced p where p.line_id is not null and not p.blackout), '[]'::jsonb),
    'perRoomTotalPaise', case when st.state = 'ok' then st.per_room::text end,
    'totalPaise', case when st.state = 'ok' then (st.per_room * greatest(coalesce(p_rooms, 1), 1))::text end,
    'endedOn', case when st.state = 'ended' then to_char(st.ended_on, 'YYYY-MM-DD') end)
  from st
$$;

-- The stay of a task's current booking facts (hotel tasks; nulls otherwise).
create function authz.rc_task_stay(p_task uuid, out check_in date, out check_out date, out rooms integer)
language sql stable security definer set search_path = '' as $$
  select authz.rc_date(case when jsonb_typeof(f.facts -> 'checkIn') = 'string' then f.facts ->> 'checkIn' end),
         authz.rc_date(case when jsonb_typeof(f.facts -> 'checkOut') = 'string' then f.facts ->> 'checkOut' end),
         case when jsonb_typeof(f.facts -> 'rooms') = 'number' and (f.facts ->> 'rooms') ~ '^[1-9][0-9]{0,2}$'
              then (f.facts ->> 'rooms')::integer end
  from public.fulfilment_tasks t
  join public.service_item_facts f on f.service_item_id = t.service_item_id
   and f.booking_version_id = authz.task_current_version(t.id)
  where t.id = p_task
$$;

-- ===========================================================================
-- 2. E9 purchase_quote_add (replaces 20261204000110)
-- ===========================================================================

create or replace function public.purchase_quote_add(p_task_id uuid, p_request_id uuid, p_fields jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_existing uuid;
  v_supplier public.suppliers%rowtype;
  v_cost bigint;
  v_per_night bigint;
  v_id uuid;
  v_hotel uuid;          -- Accounts phase 2 (20261204000110)
  v_link uuid;
  -- Accounts phase 3 (20261205000520)
  v_rt public.hotel_room_types%rowtype;
  v_meal text;
  v_stay record;
  v_price jsonb;
  v_state text := 'none';
  v_contract uuid;
  v_total bigint;
  v_reason text;
begin
  v_task := authz.lock_workable_task(p_task_id);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select q.id into v_existing from public.purchase_quotes q where q.task_id = v_task.id and q.request_id = p_request_id;
  if v_existing is not null then
    return jsonb_build_object('quoteId', v_existing, 'created', false);
  end if;
  -- Purchase build: perRoomNightPaise and note are accepted. Accounts phase 2: catalogueHotelId.
  -- Accounts phase 3 (20261205000520): roomTypeId, mealPlanCode, contractDeviationReason.
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['supplierId', 'hotelName', 'roomType', 'mealPlan', 'quotedCostPaise', 'holdUntil',
                          'cancellationTerms', 'perRoomNightPaise', 'note', 'catalogueHotelId',
                          'roomTypeId', 'mealPlanCode', 'contractDeviationReason']) <> '{}'::jsonb
     or jsonb_typeof(p_fields -> 'supplierId') is distinct from 'string'
     or (p_fields ->> 'supplierId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into v_supplier from public.suppliers s
  where s.id = (p_fields ->> 'supplierId')::uuid and s.legal_entity_id = v_task.legal_entity_id;
  -- Purchase build: the supplier offers the task's service type (hotel, transfer or activity).
  if v_supplier.id is null or v_supplier.status <> 'active' or not (v_task.service_purpose = any (v_supplier.service_types)) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_cost := authz.booking_fact_paise(p_fields, 'quotedCostPaise');
  if v_cost is null or v_cost <= 0 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_per_night := authz.booking_fact_paise(p_fields, 'perRoomNightPaise');
  if v_per_night is not null and (v_per_night <= 0 or v_task.service_purpose <> 'hotel') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- Accounts phase 2: an active catalogue hotel of the entity, hotel tasks only.
  if p_fields ? 'catalogueHotelId' and jsonb_typeof(p_fields -> 'catalogueHotelId') <> 'null' then
    if jsonb_typeof(p_fields -> 'catalogueHotelId') <> 'string'
       or (p_fields ->> 'catalogueHotelId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or v_task.service_purpose <> 'hotel'
       or not exists (select 1 from public.hotel_catalogue h
                      where h.id = (p_fields ->> 'catalogueHotelId')::uuid
                        and h.legal_entity_id = v_task.legal_entity_id and h.status = 'active') then
      raise exception 'invalid_input' using errcode = '22023', hint = 'catalogueHotelId';
    end if;
    v_hotel := (p_fields ->> 'catalogueHotelId')::uuid;
  end if;

  -- Accounts phase 3 (20261205000520): the pick-lists and the contract
  -- comparison (E9), only while rate contracts are switched on.
  if authz.rate_contracts_enabled() then
    if p_fields ? 'roomTypeId' and jsonb_typeof(p_fields -> 'roomTypeId') <> 'null' then
      select * into v_rt from public.hotel_room_types t
      where t.id = authz.rc_uuid(p_fields -> 'roomTypeId') and t.hotel_id = v_hotel and t.status = 'active';
      if v_rt.id is null or v_task.service_purpose <> 'hotel' then
        raise exception 'invalid_input' using errcode = '22023', hint = 'roomTypeId';
      end if;
    end if;
    if p_fields ? 'mealPlanCode' and jsonb_typeof(p_fields -> 'mealPlanCode') <> 'null' then
      v_meal := case when jsonb_typeof(p_fields -> 'mealPlanCode') = 'string'
                      and (p_fields ->> 'mealPlanCode') in ('EP', 'CP', 'MAP', 'AP', 'AI') then p_fields ->> 'mealPlanCode' end;
      if v_meal is null or v_task.service_purpose <> 'hotel' then
        raise exception 'invalid_input' using errcode = '22023', hint = 'mealPlanCode';
      end if;
    end if;
    if v_rt.id is not null and v_meal is not null then
      select * into v_stay from authz.rc_task_stay(v_task.id);
      if v_stay.check_in is not null and v_stay.check_out is not null then
        v_price := authz.rate_contract_price(v_task.legal_entity_id, v_supplier.id, v_hotel, v_rt.id, v_meal,
          v_stay.check_in, v_stay.check_out, coalesce(v_stay.rooms, 1));
        if v_price ->> 'state' = 'ok' then
          v_total := (v_price ->> 'totalPaise')::bigint;
          v_contract := (v_price -> 'contractIds' ->> 0)::uuid;
          v_state := case when v_cost = v_total then 'matches' else 'differs' end;
        elsif v_price ->> 'state' = 'ended' then
          v_state := 'ended';
        end if;
      end if;
    end if;
    if v_state = 'differs' then
      v_reason := authz.rc_text_field(p_fields, 'contractDeviationReason', 300, false);
      if v_reason is null or char_length(v_reason) < 10 then
        raise exception 'invalid_input' using errcode = '22023', hint = 'contractDeviationReason';
      end if;
    end if;
  end if;

  begin
    insert into public.purchase_quotes (task_id, legal_entity_id, supplier_id, request_id, hotel_name, room_type,
      meal_plan, quoted_cost_paise, hold_until, cancellation_terms, per_room_night_paise, note, catalogue_hotel_id, created_by,
      -- Accounts phase 3 (20261205000520)
      room_type_id, meal_plan_code, rate_contract_id, contract_total_paise, contract_state, contract_deviation_reason)
    values (v_task.id, v_task.legal_entity_id, v_supplier.id, p_request_id,
      authz.booking_fact_text(p_fields, 'hotelName', 200, false),
      -- Accounts phase 3: free text defaults to the pick-list words.
      coalesce(authz.booking_fact_text(p_fields, 'roomType', 120, false), v_rt.name),
      coalesce(authz.booking_fact_text(p_fields, 'mealPlan', 60, false), authz.rc_meal_label(v_meal)),
      v_cost,
      authz.booking_fact_date(p_fields, 'holdUntil'),
      authz.booking_fact_text(p_fields, 'cancellationTerms', 2000, true),
      v_per_night,
      authz.booking_fact_text(p_fields, 'note', 300, true),
      v_hotel,
      (select auth.uid()),
      v_rt.id, v_meal, v_contract, v_total, v_state, v_reason)
    returning id into v_id;
  exception when check_violation or not_null_violation then
    raise exception 'invalid_input' using errcode = '22023';
  end;

  -- Accounts phase 2: the supplier sells this hotel (first quote wins; nothing when already linked).
  if v_hotel is not null and 'hotel' = any (v_supplier.service_types) then
    insert into public.supplier_hotels (legal_entity_id, supplier_id, hotel_id, source, first_quote_id, created_by)
    values (v_task.legal_entity_id, v_supplier.id, v_hotel, 'quote', v_id, (select auth.uid()))
    on conflict (supplier_id, hotel_id) where status = 'active' do nothing
    returning id into v_link;
    if v_link is not null then
      insert into public.supplier_changes (legal_entity_id, supplier_id, changed_by, source, field, old_value, new_value)
      values (v_task.legal_entity_id, v_supplier.id, (select auth.uid()), 'hotel_link', 'hotel:' || v_hotel, null,
        left('linked (quote): ' || (select h.name || ', ' || h.city from public.hotel_catalogue h where h.id = v_hotel), 1000));
    end if;
  end if;

  perform authz.write_audit('purchase.quote_added', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null, jsonb_build_object('quoteId', v_id, 'supplierId', v_supplier.id,
      -- Accounts phase 3 (20261205000520): the comparison state only (never an amount).
      'contractState', v_state));
  return jsonb_build_object('quoteId', v_id, 'created', true,
    -- Accounts phase 3 (20261205000520): additive keys.
    'contractState', v_state, 'contractTotalPaise', v_total::text);
end;
$$;

-- ===========================================================================
-- 3. Manager approvals: contract flags on costs above budget (replaces 20261204000900)
-- ===========================================================================

create or replace function public.manager_approvals() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  c_cap constant integer := 50;
  v_costs jsonb; v_costs_n bigint;
  v_payments jsonb; v_payments_n bigint;
  v_funding jsonb; v_funding_n bigint;
  v_bank jsonb; v_bank_n bigint;
  v_suppliers jsonb; v_suppliers_n bigint;
  v_cancel_all jsonb; v_cancel jsonb;
  v_fares jsonb; v_fares_n bigint;
begin
  if not coalesce(authz.session_ok(), false) or not exists (
       select 1 from public.memberships m
       where m.user_id = v_uid and m.status = 'active' and m.role_code = 'manager'
         and authz.holds_active_role('manager', m.legal_entity_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  select coalesce(jsonb_agg(jsonb_build_object(
      'taskId', r.task_id,
      'dealReference', d.reference,
      'serviceTitle', coalesce(authz.sm_task_title(r.task_id), 'Service'),
      'supplierName', s.name,
      'versionNo', r.version_no,
      'amountPaise', c.amount_paise::text,
      'budgetPaise', coalesce(authz.task_budget(r.task_id), 0)::text,
      'proposedAt', r.since,
      'proposedByName', p.display_name,
      'canApprove', r.created_by <> v_uid,
      -- Accounts phase 3 (20261205000520): the offer against the rate contract (9.3).
      'contractState', coalesce(q.contract_state, 'none'),
      'contractTotalPaise', q.contract_total_paise::text,
      'contractDeviationReason', q.contract_deviation_reason) order by r.since, r.task_id), '[]'::jsonb),
    coalesce(max(r.total), 0)
  into v_costs, v_costs_n
  from (select x.*, count(*) over () as total from authz.sm_manager_cost_rows() x
        order by x.since, x.task_id limit c_cap) r
  join public.fulfilment_tasks t on t.id = r.task_id
  join public.deals d on d.id = t.deal_id
  join public.purchase_cost_versions c on c.task_id = r.task_id and c.version_no = r.version_no
  left join public.purchase_quotes q on q.id = c.quote_id
  left join public.suppliers s on s.id = q.supplier_id
  left join public.staff_profiles p on p.user_id = r.created_by;

  select coalesce(jsonb_agg(authz.sm_accounts_payment_json(x.id) order by x.due_key, x.requested_at, x.id), '[]'::jsonb),
         coalesce(max(x.total), 0)
  into v_payments, v_payments_n
  from (select p.id, coalesce(p.due_date, date '2100-12-31') as due_key, p.requested_at, count(*) over () as total
        from public.supplier_payment_requests p
        where p.route = 'manager' and p.status = 'pending' and authz.is_branch_sales_manager(p.deal_id)
          -- Review F5: a manager who also holds Purchase never sees customer money or funding.
          and not authz.holds_role('purchase', p.legal_entity_id)
        order by coalesce(p.due_date, date '2100-12-31'), p.requested_at, p.id
        limit c_cap) x;

  select coalesce(jsonb_agg(authz.sm_funding_json(x.id) order by x.requested_at, x.id), '[]'::jsonb),
         coalesce(max(x.total), 0)
  into v_funding, v_funding_n
  from (select f.id, f.requested_at, count(*) over () as total
        from public.company_funding_requests f
        join public.supplier_payment_requests p on p.id = f.payment_request_id
        where f.route = 'manager' and f.status = 'pending' and p.status not in ('returned', 'cancelled')
          and authz.is_branch_sales_manager(f.deal_id) and not authz.holds_role('purchase', f.legal_entity_id)
        order by f.requested_at, f.id
        limit c_cap) x;

  select coalesce(jsonb_agg(jsonb_build_object(
      'supplierId', s.id,
      'supplierName', s.name,
      -- 20261201000290: so screens can tell flight-only suppliers apart.
      'serviceTypes', to_jsonb(s.service_types),
      'revisionNo', x.revision_no,
      'accountHolder', x.account_holder,
      'bankName', x.bank_name,
      'ifsc', x.ifsc,
      'accountLast4', right(x.account_number, 4),
      'createdAt', x.created_at,
      'createdByName', p.display_name,
      'canApprove', x.created_by <> v_uid) order by x.created_at, s.id), '[]'::jsonb),
    coalesce(max(r.total), 0)
  into v_bank, v_bank_n
  from (select b.*, count(*) over () as total from authz.sm_manager_bank_rows() b
        order by b.created_at, b.supplier_id limit c_cap) r
  join public.suppliers s on s.id = r.supplier_id
  join public.supplier_beneficiary_revisions x on x.supplier_id = r.supplier_id and x.revision_no = r.revision_no
  left join public.staff_profiles p on p.user_id = x.created_by;

  select coalesce(jsonb_agg(jsonb_build_object(
      'supplierId', s.id,
      'name', s.name,
      'city', s.city,
      'serviceTypes', to_jsonb(s.service_types),
      'rowVersion', s.row_version,
      'updatedAt', s.updated_at,
      'canVerify', r.can_verify) order by lower(s.name), s.id), '[]'::jsonb),
    coalesce(max(r.total), 0)
  into v_suppliers, v_suppliers_n
  from (select y.supplier_id, y.can_verify, count(*) over () as total
        from authz.sm_manager_supplier_rows() y
        join public.suppliers z on z.id = y.supplier_id
        order by lower(z.name), z.id limit c_cap) r
  join public.suppliers s on s.id = r.supplier_id;

  -- The helper is shared with Home counts (which count canDecide over the whole list): slice here.
  v_cancel_all := coalesce(authz.sm_manager_cancellations_json(), '[]'::jsonb);
  select coalesce(jsonb_agg(a.e order by a.o), '[]'::jsonb) into v_cancel
  from jsonb_array_elements(v_cancel_all) with ordinality a(e, o)
  where a.o <= c_cap;

  -- Flight build (20261201000220): fares above the Deal's flight budget.
  select coalesce(jsonb_agg(jsonb_build_object(
      'approvalId', a.id,
      'dealId', a.deal_id,
      'dealReference', d.reference,
      'flightTitles', coalesce((
        select jsonb_agg(y.title order by y.item_no, y.id)
        from (select distinct t.id, i.item_no, coalesce(authz.sm_task_title(t.id), 'Flight') as title
              from public.flight_sectors fs
              join public.fulfilment_tasks t on t.id = fs.task_id
              join public.service_items i on i.id = t.service_item_id
              where fs.id::text in (select jsonb_array_elements_text(a.payload -> 'sectorIds'))) y), '[]'::jsonb),
      'supplierName', s.name,
      'batchSupplierCostPaise', a.batch_supplier_cost_paise::text,
      'projectedSupplierCostPaise', a.projected_supplier_cost_paise::text,
      'budgetPaise', a.budget_paise::text,
      'requestedAt', a.requested_at,
      'requestedByName', rp.display_name,
      'rowVersion', a.row_version,
      'canApprove', r.can_approve) order by a.requested_at, a.id), '[]'::jsonb),
    coalesce(max(r.total), 0)
  into v_fares, v_fares_n
  from (select fr.approval_id, fr.can_approve, count(*) over () as total
        from authz.flight_manager_fare_rows() fr
        join public.flight_fare_approvals z on z.id = fr.approval_id
        order by z.requested_at, z.id limit c_cap) r
  join public.flight_fare_approvals a on a.id = r.approval_id
  join public.deals d on d.id = a.deal_id
  left join public.suppliers s on s.id::text = a.payload ->> 'supplierId'
  left join public.staff_profiles rp on rp.user_id = a.requested_by;

  return jsonb_build_object(
    'costsAboveBudget', v_costs,
    'costsAboveBudgetTotal', v_costs_n,
    'payments', v_payments,
    'paymentsTotal', v_payments_n,
    'funding', v_funding,
    'fundingTotal', v_funding_n,
    'bankDetails', v_bank,
    'bankDetailsTotal', v_bank_n,
    'suppliersToVerify', v_suppliers,
    'suppliersToVerifyTotal', v_suppliers_n,
    'cancellations', v_cancel,
    'cancellationsTotal', jsonb_array_length(v_cancel_all),
    'flightFares', v_fares,
    'flightFaresTotal', v_fares_n);
end;
$$;

-- ===========================================================================
-- 4. Go-ahead flags (replaces 20261130000120)
-- ===========================================================================

create or replace function authz.purchase_go_ahead_json(p_task uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('state', authz.purchase_go_ahead_state(p_task))
    || coalesce((
      select jsonb_build_object(
        'requestId', r.id,
        'costVersionNo', r.cost_version_no,
        'requestedAt', r.requested_at,
        'requestedByName', rp.display_name,
        'decidedAt', r.decided_at,
        'decidedByName', dp.display_name,
        'returnReason', r.return_reason,
        -- Accounts phase 3 (20261205000520): the request's offer against the rate contract.
        'contractState', coalesce(q.contract_state, 'none'),
        'contractTotalPaise', q.contract_total_paise::text,
        'contractDeviationReason', q.contract_deviation_reason)
      from public.purchase_go_ahead_requests r
      left join public.purchase_quotes q on q.id = r.quote_id
      left join public.staff_profiles rp on rp.user_id = r.requested_by
      left join public.staff_profiles dp on dp.user_id = r.decided_by
      where r.task_id = p_task and r.status <> 'superseded'
      order by (r.status = 'pending') desc, r.requested_at desc, r.id desc limit 1),
      jsonb_build_object('requestId', null, 'costVersionNo', null, 'requestedAt', null, 'requestedByName', null,
        'decidedAt', null, 'decidedByName', null, 'returnReason', null,
        -- Accounts phase 3 (20261205000520)
        'contractState', 'none', 'contractTotalPaise', null, 'contractDeviationReason', null))
$$;

-- ===========================================================================
-- 5. Expiry alerts (timer task rate_contract_expiry)
-- ===========================================================================

create function authz.rate_contract_expiry() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_now timestamp := now() at time zone 'Asia/Kolkata';
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_n integer := 0;
begin
  -- 9.1: the day's alerts are written from 09:00 India time (the task runs hourly).
  if v_now::time < time '09:00' then
    return jsonb_build_object('inserted', 0, 'waiting', 1);
  end if;
  insert into public.rate_contract_alerts (legal_entity_id, contract_id, days_left)
  select c.legal_entity_id, c.id, (c.valid_to - v_today)
  from public.rate_contracts c
  where c.status = 'active' and c.valid_to in (v_today + 30, v_today + 7)
    and not exists (select 1 from public.rate_contracts x
                    where x.supplier_id = c.supplier_id and x.hotel_id = c.hotel_id and x.status = 'active'
                      and x.valid_to > c.valid_to)
  on conflict (contract_id, days_left) do nothing;
  get diagnostics v_n = row_count;
  return jsonb_build_object('inserted', v_n, 'waiting', 0);
end;
$$;

revoke all on function authz.rate_contract_price(uuid, uuid, uuid, uuid, text, date, date, integer), authz.rc_task_stay(uuid),
  authz.rate_contract_expiry()
from public, anon, authenticated, service_role;

select authz.timer_task_register('rate_contract_expiry', 'authz.rate_contract_expiry', 60);

commit;
