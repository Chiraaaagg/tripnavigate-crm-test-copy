-- Flight build, Track B (7): input rule for Flight + Purchase holders (lead
-- decision, 5 Nov 2026). On a FLIGHT-ONLY Deal markup and discount are
-- selling-side values, so a caller who also holds Purchase in the entity may
-- not enter them: flight_fare_preview, flight_fare_approval_request and
-- flight_tickets_confirm refuse such a caller with not_authorized (42501),
-- hint 'purchase_holder_margin', before anything is written (the check runs
-- in authz.flight_fare_check, which all three call first after their locks
-- and gates). Package Deals (no markup or discount) are unchanged.
--
-- Replaced (same signature): authz.flight_fare_check (body of
-- 20261201000210 plus the check).
--
-- Rollback (forward-only): a NEW migration restoring the 20261201000210 body.

begin;
set local lock_timeout = '15s';

create or replace function authz.flight_fare_check(p_deal uuid, p_fields jsonb, p_mode text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_sector_ids uuid[] := '{}';
  v_raw jsonb;
  v_el jsonb;
  v_i integer;
  v_id uuid;
  v_supplier uuid;
  v_kind text;
  v_task_ids uuid[];
  v_cost_task uuid;
  v_travellers jsonb := '[]'::jsonb;
  v_seq integer;
  v_seqs integer[] := '{}';
  v_type text;
  v_name text;
  v_covered uuid[];
  v_types text[] := '{}';
  v_fares jsonb := '[]'::jsonb;
  v_fare_types text[] := '{}';
  v_basic bigint; v_k bigint; v_yq bigint; v_yr bigint; v_other bigint; v_markup bigint; v_discount bigint;
  v_count integer;
  v_supplier_pp bigint;
  v_total_pp bigint;
  v_batch_cost numeric := 0;
  v_batch_customer numeric := 0;
  v_before bigint;
  v_budget bigint;
  v_over boolean;
  v_payload jsonb;
  v_max bigint := 99999999999;
  v_ticket_keys text[] := array['seq', 'crsType', 'crsPnr', 'airlinePnr', 'ticketNumber'];
begin
  select * into v_deal from public.deals d where d.id = p_deal;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  if (p_fields - array['sectorIds', 'supplierId', 'fareApprovalId', 'fares', 'travellers']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023',
      hint = (select string_agg(k, ',' order by k) from jsonb_object_keys(p_fields - array['sectorIds', 'supplierId',
        'fareApprovalId', 'fares', 'travellers']) k);
  end if;

  -- Sectors: 1..16 distinct active sectors of this Deal.
  v_raw := p_fields -> 'sectorIds';
  if v_raw is null or jsonb_typeof(v_raw) <> 'array' or jsonb_array_length(v_raw) not between 1 and 16 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'sectorIds';
  end if;
  for v_el in select x from jsonb_array_elements(v_raw) x loop
    if jsonb_typeof(v_el) <> 'string'
       or (v_el #>> '{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'sectorIds';
    end if;
    v_id := (v_el #>> '{}')::uuid;
    if v_id = any (v_sector_ids) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'sectorIds';
    end if;
    v_sector_ids := v_sector_ids || v_id;
  end loop;
  if (select count(*) from public.flight_sectors s
      join public.fulfilment_tasks t on t.id = s.task_id
      where s.id = any (v_sector_ids) and s.deal_id = p_deal and s.status = 'active'
        and t.department = 'flight' and t.status = 'in_progress') <> cardinality(v_sector_ids) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'sectorIds';
  end if;
  select array_agg(distinct s.task_id) into v_task_ids from public.flight_sectors s where s.id = any (v_sector_ids);
  if exists (select 1 from public.flight_task_state st
             where st.task_id = any (v_task_ids) and st.basis_version_id is distinct from authz.task_current_version(st.task_id))
     or exists (select 1 from unnest(v_task_ids) x(t)
                where not exists (select 1 from public.flight_task_state st where st.task_id = x.t)) then
    raise exception 'booking_changed' using errcode = '55000';
  end if;
  -- The task of the earliest ticked sector carries the whole batch (L8).
  select s.task_id into v_cost_task from public.flight_sectors s
  where s.id = any (v_sector_ids)
  order by s.depart_date, s.depart_time nulls last, s.id limit 1;

  -- Supplier: active, serves flights, same entity.
  v_raw := p_fields -> 'supplierId';
  if v_raw is null or jsonb_typeof(v_raw) <> 'string'
     or (v_raw #>> '{}') !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'supplierId';
  end if;
  v_supplier := (v_raw #>> '{}')::uuid;
  if not exists (select 1 from public.suppliers s
                 where s.id = v_supplier and s.legal_entity_id = v_deal.legal_entity_id and s.status = 'active'
                   and s.service_types @> array['flight']) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'supplierId';
  end if;

  v_kind := authz.flight_deal_kind(p_deal);
  -- 20261201000260 (lead): markup and discount are selling-side; a caller who
  -- also holds Purchase in the entity may not enter them (flight-only Deals).
  if v_kind = 'flight_only' and authz.holds_role('purchase', v_deal.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501', hint = 'purchase_holder_margin';
  end if;

  -- Travellers: named, on at least one ticked sector (current, not held), no ticket there yet.
  v_raw := p_fields -> 'travellers';
  if v_raw is null or jsonb_typeof(v_raw) <> 'array' or jsonb_array_length(v_raw) not between 1 and 100 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'travellers';
  end if;
  v_i := 0;
  for v_el in select x from jsonb_array_elements(v_raw) x loop
    if jsonb_typeof(v_el) <> 'object' or (v_el - v_ticket_keys) <> '{}'::jsonb
       or jsonb_typeof(v_el -> 'seq') is distinct from 'number' or (v_el ->> 'seq') !~ '^[0-9]{1,3}$'
       or (v_el ->> 'seq')::integer not between 1 and 100 then
      raise exception 'invalid_input' using errcode = '22023', hint = 'travellers[' || v_i || '].seq';
    end if;
    v_seq := (v_el ->> 'seq')::integer;
    if v_seq = any (v_seqs) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'travellers[' || v_i || '].seq';
    end if;
    v_seqs := v_seqs || v_seq;
    select array_agg(p.sector_id order by p.sector_id) into v_covered
    from public.flight_sector_passengers p
    where p.sector_id = any (v_sector_ids) and p.traveller_seq = v_seq
      and p.ended_at is null and p.held_by_change_id is null;
    if v_covered is null then
      raise exception 'traveller_not_on_sector' using errcode = '22023', hint = 'travellers[' || v_i || '].seq';
    end if;
    if exists (select 1 from public.flight_ticket_revisions r
               where r.sector_id = any (v_covered) and r.traveller_seq = v_seq) then
      raise exception 'already_confirmed' using errcode = '55000', hint = 'travellers[' || v_i || '].seq';
    end if;
    select bt.traveller_type, bt.full_name into v_type, v_name
    from public.booking_version_travellers bt
    where bt.booking_version_id = authz.task_current_version(v_cost_task) and bt.seq = v_seq;
    if v_type is null then
      -- Not named in the accepted booking: cannot get a ticket (owner D7).
      raise exception 'traveller_not_on_sector' using errcode = '22023', hint = 'travellers[' || v_i || '].seq';
    end if;
    v_types := v_types || v_type;
    v_travellers := v_travellers || jsonb_build_array(jsonb_build_object(
      'seq', v_seq, 'type', v_type, 'name', v_name, 'line', v_el, 'sectorIds', to_jsonb(v_covered)));
    v_i := v_i + 1;
  end loop;

  -- Fares: exactly one per traveller type present.
  v_raw := p_fields -> 'fares';
  if v_raw is null or jsonb_typeof(v_raw) <> 'array' or jsonb_array_length(v_raw) not between 1 and 3 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fares';
  end if;
  v_i := 0;
  for v_el in select x from jsonb_array_elements(v_raw) x loop
    if jsonb_typeof(v_el) <> 'object'
       or (v_el - array['paxType', 'basicPaise', 'kPaise', 'yqPaise', 'yrPaise', 'otherPaise', 'markupPaise', 'discountPaise'])
          <> '{}'::jsonb
       or jsonb_typeof(v_el -> 'paxType') is distinct from 'string'
       or (v_el ->> 'paxType') not in ('adult', 'child', 'infant')
       or (v_el ->> 'paxType') = any (v_fare_types) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'fares[' || v_i || '].paxType';
    end if;
    v_type := v_el ->> 'paxType';
    v_fare_types := v_fare_types || v_type;
    v_basic := authz.flight_paise(v_el -> 'basicPaise', 'fares[' || v_i || '].basicPaise', v_max);
    if v_basic is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'fares[' || v_i || '].basicPaise';
    end if;
    v_k := coalesce(authz.flight_paise(v_el -> 'kPaise', 'fares[' || v_i || '].kPaise', v_max), 0);
    v_yq := coalesce(authz.flight_paise(v_el -> 'yqPaise', 'fares[' || v_i || '].yqPaise', v_max), 0);
    v_yr := coalesce(authz.flight_paise(v_el -> 'yrPaise', 'fares[' || v_i || '].yrPaise', v_max), 0);
    v_other := coalesce(authz.flight_paise(v_el -> 'otherPaise', 'fares[' || v_i || '].otherPaise', v_max), 0);
    v_markup := authz.flight_paise(v_el -> 'markupPaise', 'fares[' || v_i || '].markupPaise', v_max);
    v_discount := authz.flight_paise(v_el -> 'discountPaise', 'fares[' || v_i || '].discountPaise', v_max);
    if v_kind = 'package' then
      -- Owner D4: no markup or discount on package Deals.
      if v_markup is not null then
        raise exception 'invalid_input' using errcode = '22023', hint = 'fares[' || v_i || '].markupPaise';
      end if;
      if v_discount is not null then
        raise exception 'invalid_input' using errcode = '22023', hint = 'fares[' || v_i || '].discountPaise';
      end if;
    else
      if v_markup is null then
        raise exception 'invalid_input' using errcode = '22023', hint = 'fares[' || v_i || '].markupPaise';
      end if;
      if v_discount is null then
        raise exception 'invalid_input' using errcode = '22023', hint = 'fares[' || v_i || '].discountPaise';
      end if;
    end if;
    v_supplier_pp := v_basic + v_k + v_yq + v_yr + v_other;
    v_total_pp := v_supplier_pp + coalesce(v_markup, 0) - coalesce(v_discount, 0);
    if v_total_pp < 0 then
      raise exception 'discount_over_fare' using errcode = '22023', hint = 'fares[' || v_i || '].discountPaise';
    end if;
    select count(*) into v_count from unnest(v_types) t where t = v_type;
    if v_count = 0 then
      -- Confirm: exactly the types among the posted travellers. Preview and
      -- approval drop a line for a type nobody has (the popup may keep it), so
      -- the approved hash is the hash of the fare set a confirm posts.
      if p_mode = 'confirm' then
        raise exception 'invalid_input' using errcode = '22023', hint = 'fares[' || v_i || '].paxType';
      end if;
      v_i := v_i + 1;
      continue;
    end if;
    v_batch_cost := v_batch_cost + v_supplier_pp::numeric * v_count;
    v_batch_customer := v_batch_customer + v_total_pp::numeric * v_count;
    v_fares := v_fares || jsonb_build_array(jsonb_build_object(
      'paxType', v_type, 'basic', v_basic, 'k', v_k, 'yq', v_yq, 'yr', v_yr, 'other', v_other,
      'markup', v_markup, 'discount', v_discount, 'supplierPerPerson', v_supplier_pp, 'totalPerPerson', v_total_pp,
      'paxCount', v_count));
    v_i := v_i + 1;
  end loop;
  if exists (select 1 from unnest(v_types) t where not (t = any (v_fare_types))) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fares';
  end if;
  if v_batch_cost > 999999999999 or v_batch_customer > 999999999999 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fares';
  end if;

  v_before := authz.flight_deal_supplier_cost(p_deal);
  v_budget := authz.flight_deal_budget(p_deal);
  v_over := v_budget is null or v_before + v_batch_cost::bigint > v_budget;

  v_payload := jsonb_build_object(
    'sectorIds', (select jsonb_agg(x::text order by x::text) from unnest(v_sector_ids) x),
    'travellers', (select jsonb_agg(jsonb_build_object('seq', (t ->> 'seq')::integer, 'type', t ->> 'type')
                                    order by (t ->> 'seq')::integer)
                   from jsonb_array_elements(v_travellers) t),
    'supplierId', v_supplier::text,
    'fares', (select jsonb_agg(jsonb_build_object(
                'paxType', f ->> 'paxType',
                'basicPaise', f ->> 'basic', 'kPaise', f ->> 'k', 'yqPaise', f ->> 'yq', 'yrPaise', f ->> 'yr',
                'otherPaise', f ->> 'other', 'markupPaise', f ->> 'markup', 'discountPaise', f ->> 'discount')
              order by f ->> 'paxType')
              from jsonb_array_elements(v_fares) f));

  return jsonb_build_object(
    'payload', v_payload,
    'fareHash', authz.flight_fare_hash(v_payload),
    'dealKind', v_kind,
    'costTaskId', v_cost_task,
    'supplierId', v_supplier,
    'sectorIds', to_jsonb(v_sector_ids),
    'taskIds', to_jsonb(v_task_ids),
    'travellers', v_travellers,
    'fares', v_fares,
    'batchSupplierCost', v_batch_cost::bigint,
    'batchCustomerTotal', case when v_kind = 'flight_only' then v_batch_customer::bigint end,
    'dealCostBefore', v_before,
    'dealCostAfter', v_before + v_batch_cost::bigint,
    'dealBudget', v_budget,
    'overBudget', v_over);
end;
$$;

revoke all on function authz.flight_fare_check(uuid, jsonb, text) from public, anon, authenticated, service_role;

commit;
