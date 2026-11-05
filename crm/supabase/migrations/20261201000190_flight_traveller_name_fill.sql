-- TripNavigate CRM - Flight build, track A: fill a blank traveller name on
-- the accepted booking (owner decision R3, contract Addendum 2, 5 Nov 2026).
--
-- Model. An unnamed traveller has no row at all: the party (pax_total,
-- adults/children/infants counts or a flight's passenger count) is larger
-- than the named travellers. Filling a blank therefore ADDS one traveller
-- (a free seq, name, type) to the Deal:
--   * deal_travellers gets the row (the CRM's live traveller list, which
--     later revision drafts start from, so no revision sees a spurious change);
--   * booking_version_travellers of the confirmed version gets the same row
--     (insert only; the snapshot rows that exist are never changed). The
--     version's stored content hash stays the accepted one;
--   * participation: every flight item of the version that has a missing
--     name gets the traveller (an explicit participant list gets a row; an
--     item that follows "every traveller" needs none). Every other item that
--     follows "every traveller" first gets its current list written out, so
--     its participants do not change (hotels, cars, visas are untouched);
--   * the Deal's taken flight tasks whose itinerary reflects this version
--     put the traveller on every active booking / screenshot sector, so the
--     "N travellers not named yet" block clears and the tickets are pending.
-- Nothing else changes: no booking version, no counts, items, prices, ID
-- proofs or existing names. Works also on a committed Deal (that is the way
-- out of the R3 deadlock).
--
-- Caller: the Deal's active Sales owner; the branch Manager only when the
-- Deal has no active Sales owner (same rule as flight changes, 0160).
-- Command: public.deal_traveller_name_fill(deal, version, seq, full name,
-- type, request id). Idempotent by request id; group lock and the version
-- row lock; one audit row booking.traveller_name_filled per fill (ids, seq
-- and type only; never the name).
-- Refusals (message = token): 42501 not_authorized | 55000 name_already_set
-- (the seq is taken or no name is missing any more), deal_removed,
-- environment_unset | 22023 invalid_input (hint fullName | type | seq |
-- versionId) | 40001 version_changed (the confirmed version is no longer the
-- one shown), duplicate_request.
-- Reads: deal_flight_summary gains nameFill {versionId, slots [{seq, type}]}
-- (null unless the caller may fill); flight_home_counts gains
-- flightTravellersNamed. The shared guard authz.b11_version_child_guard
-- (body of 20261119000100_b11_book_now.sql) gains one bypass, used only inside this command.
-- Rollback (forward-only): a new migration revoking the command and
-- restoring the guard, summary and Home count bodies. Rows are kept.

begin;
set local lock_timeout = '15s';

create table public.deal_traveller_fills (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  deal_id uuid not null,
  booking_version_id uuid not null,
  traveller_seq integer not null check (traveller_seq between 1 and 100),
  traveller_type text not null check (traveller_type in ('adult', 'child', 'infant')),
  filled_by uuid not null references public.staff_profiles (user_id),
  filled_at timestamptz not null default now(),
  request_id uuid not null,
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id, booking_version_id) references public.booking_versions (legal_entity_id, deal_id, id),
  unique (booking_version_id, traveller_seq),
  unique (legal_entity_id, request_id)
);
create index deal_traveller_fills_deal_idx on public.deal_traveller_fills (deal_id);
create index deal_traveller_fills_filled_by_idx on public.deal_traveller_fills (filled_by);
comment on table public.deal_traveller_fills is
  'Owner decision R3 (5 Nov 2026): a blank traveller name filled on the accepted booking without a revision. The name lives in deal_travellers and booking_version_travellers; this row records who filled which seq. Append-only. No table grant.';
create trigger deal_traveller_fills_a_append_only before update or delete on public.deal_traveller_fills
  for each row execute function authz.flight_append_only();
alter table public.deal_traveller_fills enable row level security;
create policy require_valid_session on public.deal_traveller_fills as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.deal_traveller_fills from public, anon, authenticated, service_role;

create or replace function authz.b11_version_child_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- 20261201000190 (owner decision R3): only public.deal_traveller_name_fill
  -- (security definer) sets this transaction-local flag, bound to the current
  -- transaction id, around its own inserts. API roles have no INSERT grant on
  -- service_item_travellers and cannot call set_config (pg_catalog is not an
  -- exposed schema), so the bypass is reachable only from that command.
  if tg_op = 'INSERT' and tg_table_name = 'service_item_travellers'
     and coalesce(current_setting('authz.traveller_fill', true), '') = 'fill:' || txid_current()::text then
    return new;
  end if;
  if exists (
    select 1 from public.booking_versions v
    where v.status <> 'draft'
      and v.id in (case when tg_op = 'INSERT' then null else old.booking_version_id end,
                   case when tg_op = 'DELETE' then null else new.booking_version_id end)
  ) then
    raise exception '% rows of a confirmed booking version are immutable', tg_table_name using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.booking_version_id is distinct from old.booking_version_id then
    raise exception '% identity columns are immutable', tg_table_name using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- The caller may fill blank names on this Deal (Addendum 2).
create function authz.flight_can_fill_names(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and (
    authz.flight_is_sales_owner(p_deal)
    or (not authz.flight_has_active_sales_owner(p_deal) and authz.is_branch_sales_manager(p_deal)
        and not exists (select 1 from public.deals d where d.id = p_deal and authz.holds_role('flight', d.legal_entity_id))))
$$;

-- Blank names of the Deal's confirmed version: as many as the largest
-- "not named yet" count of its flights, each with the next free seq and,
-- when the party counts are recorded, the type still missing (else null).
create function authz.flight_name_slots(p_deal uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.booking_versions%rowtype;
  v_n integer;
  v_types text[] := '{}'::text[];
  v_slots jsonb := '[]'::jsonb;
  v_seq integer := 0;
  i integer := 0;
begin
  select * into v from public.booking_versions x where x.deal_id = p_deal and x.status = 'confirmed';
  if v.id is null then
    return '[]'::jsonb;
  end if;
  select coalesce(max(authz.flight_unnamed_count(t.id)), 0) into v_n
  from public.fulfilment_tasks t
  where t.deal_id = p_deal and t.department = 'flight' and t.status <> 'completed'
    and authz.task_current_version(t.id) = v.id;
  -- Adults recorded, or the party total less children and infants (Book now v2).
  if coalesce(v.adults_count, v.pax_total) is not null then
    select array_cat(array_cat(
             array_fill('adult'::text, array[greatest(coalesce(v.adults_count, v.pax_total - coalesce(v.children_count, 0)
                                                               - coalesce(v.infants_count, 0)) - count(*) filter (where s.traveller_type = 'adult'), 0)::integer]),
             array_fill('child'::text, array[greatest(coalesce(v.children_count, 0) - count(*) filter (where s.traveller_type = 'child'), 0)::integer])),
             array_fill('infant'::text, array[greatest(coalesce(v.infants_count, 0) - count(*) filter (where s.traveller_type = 'infant'), 0)::integer]))
    into v_types
    from public.booking_version_travellers s where s.booking_version_id = v.id;
  end if;
  while i < v_n and v_seq < 100 loop
    v_seq := v_seq + 1;
    continue when exists (select 1 from public.booking_version_travellers s where s.booking_version_id = v.id and s.seq = v_seq)
               or exists (select 1 from public.deal_travellers t where t.deal_id = p_deal and t.seq = v_seq);
    i := i + 1;
    v_slots := v_slots || jsonb_build_object('seq', v_seq, 'type', v_types[i]);
  end loop;
  return v_slots;
end;
$$;

create function public.deal_traveller_name_fill(
  p_deal_id uuid, p_version_id uuid, p_seq integer, p_full_name text, p_traveller_type text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_ver public.booking_versions%rowtype;
  v_uid uuid := (select auth.uid());
  v_name text := btrim(coalesce(p_full_name, ''), E' \t\r\n');
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_slots jsonb;
  v_flight_items uuid[];
  v_item record;
  v_task record;
  v_sectors integer := 0;
  v_n integer;
  v_cap integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null or not authz.flight_can_fill_names(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_refuse_gate(p_deal_id);
  -- Book now's traveller name rule (authz.sf_text_ok, 120 characters, trimmed).
  if p_full_name is null or not authz.sf_text_ok(to_jsonb(p_full_name), 120, true) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fullName';
  end if;
  if p_traveller_type is null or p_traveller_type not in ('adult', 'child', 'infant') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'type';
  end if;
  if p_seq is null or p_seq not between 1 and 100 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'seq';
  end if;
  if p_version_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'versionId';
  end if;
  v_payload := jsonb_build_object('dealId', p_deal_id, 'versionId', p_version_id, 'seq', p_seq, 'fullName', v_name,
    'type', p_traveller_type);
  v_replay := authz.flight_replay(v_deal.legal_entity_id, p_request_id, 'deal_traveller_name_fill', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  perform authz.flight_lock_group(p_deal_id);
  v_replay := authz.flight_replay(v_deal.legal_entity_id, p_request_id, 'deal_traveller_name_fill', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  select * into v_ver from public.booking_versions v where v.deal_id = p_deal_id and v.status = 'confirmed' for update;
  if v_ver.id is distinct from p_version_id then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  -- Only a blank: the seq is free and a name is still missing.
  if exists (select 1 from public.booking_version_travellers s where s.booking_version_id = v_ver.id and s.seq = p_seq)
     or exists (select 1 from public.deal_travellers t where t.deal_id = p_deal_id and t.seq = p_seq) then
    raise exception 'name_already_set' using errcode = '55000';
  end if;
  v_slots := authz.flight_name_slots(p_deal_id);
  if jsonb_array_length(v_slots) = 0 then
    raise exception 'name_already_set' using errcode = '55000';
  end if;
  if not exists (select 1 from jsonb_array_elements(v_slots) e where (e ->> 'seq')::integer = p_seq) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'seq';
  end if;
  -- The type must still be missing when the party counts are recorded.
  if coalesce(v_ver.adults_count, v_ver.pax_total) is not null then
    select count(*) into v_n from public.booking_version_travellers s
    where s.booking_version_id = v_ver.id and s.traveller_type = p_traveller_type;
    v_cap := case p_traveller_type
                  when 'adult' then coalesce(v_ver.adults_count,
                                             v_ver.pax_total - coalesce(v_ver.children_count, 0) - coalesce(v_ver.infants_count, 0))
                  when 'child' then coalesce(v_ver.children_count, 0)
                  else coalesce(v_ver.infants_count, 0) end;
    if v_n >= v_cap then
      raise exception 'invalid_input' using errcode = '22023', hint = 'type';
    end if;
  end if;

  -- Flight items that miss a name get the traveller.
  select coalesce(array_agg(t.service_item_id), '{}'::uuid[]) into v_flight_items
  from public.fulfilment_tasks t
  where t.deal_id = p_deal_id and t.department = 'flight' and t.status <> 'completed'
    and authz.task_current_version(t.id) = v_ver.id and authz.flight_unnamed_count(t.id) > 0;

  perform set_config('authz.traveller_fill', 'fill:' || txid_current()::text, true);
  -- Every other item that follows "every traveller" keeps exactly its current participants.
  for v_item in
    select f.service_item_id, f.legal_entity_id from public.service_item_facts f
    where f.booking_version_id = v_ver.id and not (f.service_item_id = any (v_flight_items))
      and not exists (select 1 from public.service_item_travellers p
                      where p.booking_version_id = v_ver.id and p.service_item_id = f.service_item_id)
  loop
    insert into public.service_item_travellers (booking_version_id, service_item_id, legal_entity_id, traveller_seq)
    select v_ver.id, v_item.service_item_id, v_item.legal_entity_id, s.seq
    from public.booking_version_travellers s where s.booking_version_id = v_ver.id;
  end loop;
  insert into public.deal_travellers (deal_id, legal_entity_id, seq, full_name, traveller_type)
  values (p_deal_id, v_deal.legal_entity_id, p_seq, v_name, p_traveller_type);
  insert into public.booking_version_travellers (booking_version_id, legal_entity_id, seq, full_name, traveller_type)
  values (v_ver.id, v_ver.legal_entity_id, p_seq, v_name, p_traveller_type);
  insert into public.service_item_travellers (booking_version_id, service_item_id, legal_entity_id, traveller_seq)
  select v_ver.id, p.service_item_id, p.legal_entity_id, p_seq
  from (select distinct pp.service_item_id, pp.legal_entity_id from public.service_item_travellers pp
        where pp.booking_version_id = v_ver.id and pp.service_item_id = any (v_flight_items)) p;
  perform set_config('authz.traveller_fill', '', true);

  -- Taken flights whose itinerary reflects this version: on every active booking / screenshot sector.
  for v_task in
    select t.id, t.legal_entity_id, t.deal_id, t.service_item_id from public.fulfilment_tasks t
    join public.flight_task_state s on s.task_id = t.id and s.basis_version_id = v_ver.id
    where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'in_progress'
      and p_seq = any (authz.item_participant_seqs(t.service_item_id, v_ver.id))
  loop
    insert into public.flight_sector_passengers (legal_entity_id, deal_id, task_id, sector_id, traveller_seq, created_by)
    select v_task.legal_entity_id, v_task.deal_id, v_task.id, x.id, p_seq, v_uid
    from public.flight_sectors x
    where x.task_id = v_task.id and x.status = 'active' and x.origin in ('booking', 'screenshot')
      and not exists (select 1 from public.flight_sector_passengers p
                      where p.sector_id = x.id and p.traveller_seq = p_seq and p.ended_at is null);
    get diagnostics v_n = row_count;
    v_sectors := v_sectors + v_n;
  end loop;

  insert into public.deal_traveller_fills (legal_entity_id, deal_id, booking_version_id, traveller_seq, traveller_type, filled_by,
    request_id)
  values (v_deal.legal_entity_id, p_deal_id, v_ver.id, p_seq, p_traveller_type, v_uid, p_request_id);
  perform authz.write_audit('booking.traveller_name_filled', v_deal.legal_entity_id, v_deal.branch_id,
    'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', p_deal_id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no, 'seq', p_seq,
      'type', p_traveller_type, 'flightItemCount', cardinality(v_flight_items), 'sectorCount', v_sectors));
  v_result := jsonb_build_object('dealId', p_deal_id, 'versionId', v_ver.id, 'seq', p_seq, 'type', p_traveller_type,
    'flightItemCount', cardinality(v_flight_items), 'outcome', 'created');
  return authz.flight_remember(v_deal.legal_entity_id, p_request_id, 'deal_traveller_name_fill', v_payload, v_result);
end;
$$;

-- deal_flight_summary
create or replace function public.deal_flight_summary(p_deal_id uuid) returns jsonb
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
    -- 20261201000190 (R3): blank traveller names the caller may fill on the accepted booking.
    'nameFill', case when authz.flight_can_fill_names(p_deal_id) and v_confirmed is not null then jsonb_build_object(
        'versionId', v_confirmed, 'slots', authz.flight_name_slots(p_deal_id)) end,
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
    -- 20261201000190 (R3): travellers Sales named after the booking who have no ticket yet on the caller's flights.
    'flightTravellersNamed', case when v_f then (
        select count(*)::integer from public.deal_traveller_fills x
        where x.deal_id = any (v_mine)
          and not exists (select 1 from public.flight_ticket_revisions r
                          where r.deal_id = x.deal_id and r.traveller_seq = x.traveller_seq)) end,
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

revoke all on function authz.flight_can_fill_names(uuid), authz.flight_name_slots(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.deal_traveller_name_fill(uuid, uuid, integer, text, text, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.deal_traveller_name_fill(uuid, uuid, integer, text, text, uuid) to authenticated;
-- The guard, deal_flight_summary and flight_home_counts keep their ACLs (CREATE OR REPLACE).

commit;
