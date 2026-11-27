-- TripNavigate CRM - Accounts phase 3, track E: fix-forward after the
-- independent backend review (MEDIUM): a Manager who also holds Purchase could
-- approve rates they edited or sent, because only entered_by was compared.
-- Contract section 4 (Approver: not the requester, proposer or enterer).
--
-- What changes:
--   * rate_contracts.last_edited_by (any edit of the header, lines or
--     blackouts while draft or returned) and submitted_by (who sent it for
--     approval), stamped by trigger rate_contracts_b_stamp from auth.uid()
--     (an owner SQL change keeps the previous value). New rows: last_edited_by
--     = entered_by. Backfill: last_edited_by = entered_by; submitted_by =
--     entered_by where submitted_at is set (the best record available).
--   * Check rate_contracts_not_self_decided: an active or ended contract was
--     approved by someone other than its enterer, last editor and sender.
--   * public.rate_contract_decide (0510 body): not_self_approval when the
--     decider entered, last edited or sent the contract.
--   * public.rate_contracts_list / rate_contract_get (0570 bodies): isMine,
--     canApprove, can.approve / can.return and the to_approve preset use the
--     same three people.
-- Refusal tokens: unchanged (not_self_approval 42501).
-- Rollback (forward-only): a new migration restoring the 0510 / 0570 bodies
-- and dropping the trigger and check (the columns stay).

begin;
set local lock_timeout = '15s';

alter table public.rate_contracts
  add column last_edited_by uuid references public.staff_profiles (user_id),
  add column submitted_by uuid references public.staff_profiles (user_id);
create index rate_contracts_last_edited_by_idx on public.rate_contracts (last_edited_by) where last_edited_by is not null;
create index rate_contracts_submitted_by_idx on public.rate_contracts (submitted_by) where submitted_by is not null;

-- Backfill: the guard refuses any change to active or ended rows, so it is
-- disabled for this one statement, which sets only the two new columns.
alter table public.rate_contracts disable trigger rate_contracts_a_guard;
update public.rate_contracts c
set last_edited_by = c.entered_by,
    submitted_by = case when c.submitted_at is not null then c.entered_by end;
alter table public.rate_contracts enable trigger rate_contracts_a_guard;

create function authz.rate_contracts_stamp() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if tg_op = 'INSERT' then
    new.last_edited_by := coalesce(new.last_edited_by, new.entered_by);
    return new;
  end if;
  if old.status in ('draft', 'returned') and new.status = old.status then
    new.last_edited_by := coalesce(v_uid, old.last_edited_by);
  elsif old.status in ('draft', 'returned') and new.status = 'pending_approval' then
    new.submitted_by := coalesce(v_uid, old.submitted_by);
  end if;
  return new;
end;
$$;
create trigger rate_contracts_b_stamp before insert or update on public.rate_contracts
  for each row execute function authz.rate_contracts_stamp();
revoke all on function authz.rate_contracts_stamp() from public, anon, authenticated, service_role;

alter table public.rate_contracts
  add constraint rate_contracts_not_self_decided check (status not in ('active', 'ended')
    or (decided_by is distinct from entered_by and decided_by is distinct from last_edited_by
        and decided_by is distinct from submitted_by));

create or replace function public.rate_contract_decide(p_contract_id uuid, p_decision text, p_reason text, p_expected_row_version integer,
  p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.rate_contracts%rowtype;
  o public.rate_contracts%rowtype;
  v_uid uuid := (select auth.uid());
  v_payload jsonb := jsonb_build_object('contractId', p_contract_id, 'decision', p_decision, 'reason', p_reason,
    'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_reason text;
  v_ended integer := 0;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  c := authz.rc_lock(p_contract_id);
  -- The enterer is told so (also when they hold Purchase as well as Manager).
  -- Accounts phase 3 (20261205000580): nobody approves rates they entered, edited or sent.
  if v_uid in (c.entered_by, c.last_edited_by, c.submitted_by) and authz.holds_active_role('manager', c.legal_entity_id) then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if not authz.rc_approver(c.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.rc_require_on();
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(c.legal_entity_id, p_request_id, 'rate_contract_decide', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if c.status <> 'pending_approval' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, c.row_version);
  if p_decision is null or p_decision not in ('approve', 'return') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'decision';
  end if;

  if p_decision = 'return' then
    v_reason := authz.rc_reason(p_reason, 500);
    update public.rate_contracts x
    set status = 'returned', decided_by = v_uid, decided_at = now(), return_reason = v_reason,
        row_version = x.row_version + 1, updated_at = now()
    where x.id = c.id
    returning * into c;
    perform authz.write_audit('purchase.rate_contract.returned', c.legal_entity_id, null, 'rate_contract', c.id, v_reason,
      jsonb_build_object('contractId', c.id, 'versionNo', c.version_no, 'rowVersion', c.row_version));
  else
    -- 17.1 step 5: the supplier + hotel pair, then the older contracts by id.
    perform authz.rc_lock_pair(c.supplier_id, c.hotel_id);
    for o in
      select * from public.rate_contracts x
      where x.supplier_id = c.supplier_id and x.hotel_id = c.hotel_id and x.status = 'active' and x.id <> c.id
        and x.valid_from <= c.valid_to and c.valid_from <= x.valid_to
      order by x.id
      for update
    loop
      update public.rate_contracts x
      set status = 'ended', ended_by = v_uid, ended_at = now(), end_reason = 'Replaced by ' || c.contract_no,
          row_version = x.row_version + 1, updated_at = now()
      where x.id = o.id;
      perform authz.write_audit('purchase.rate_contract.ended', o.legal_entity_id, null, 'rate_contract', o.id,
        'Replaced by ' || c.contract_no,
        jsonb_build_object('contractId', o.id, 'replacedBy', c.id, 'versionNo', o.version_no));
      v_ended := v_ended + 1;
    end loop;
    update public.rate_contracts x
    set status = 'active', decided_by = v_uid, decided_at = now(), return_reason = null,
        row_version = x.row_version + 1, updated_at = now()
    where x.id = c.id
    returning * into c;
    perform authz.write_audit('purchase.rate_contract.approved', c.legal_entity_id, null, 'rate_contract', c.id, null,
      jsonb_build_object('contractId', c.id, 'versionNo', c.version_no, 'endedOlder', v_ended, 'rowVersion', c.row_version));
  end if;
  v_result := authz.rc_result(c, 'updated') || jsonb_build_object('endedOlder', v_ended);
  return authz.finance_remember(c.legal_entity_id, p_request_id, 'rate_contract_decide', v_payload, v_result);
end;
$$;

create or replace function public.rate_contracts_list(p_filter jsonb, p_after text, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_filter jsonb := coalesce(p_filter, '{}'::jsonb);
  v_uid uuid := (select auth.uid());
  v_read uuid[] := '{}';
  v_mgr uuid[] := '{}';
  v_e uuid;
  v_r jsonb;
  v_limit integer := coalesce(p_limit, 50);
  v_after_rank integer;
  v_after_date date;
  v_after_id uuid;
  v_status text[];
  v_days integer;
  v_q text;
  v_preset text;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
  v_rows jsonb;
  v_n integer;
  v_last jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  foreach v_e in array authz.vn_member_entities() loop
    v_r := authz.rc_reader(v_e);
    if (v_r ->> 'p')::boolean or (v_r ->> 'm')::boolean or (v_r ->> 'a')::boolean then v_read := v_read || v_e; end if;
    if (v_r ->> 'm')::boolean then v_mgr := v_mgr || v_e; end if;
  end loop;
  if cardinality(v_read) = 0 then
    return null;
  end if;
  if jsonb_typeof(v_filter) <> 'object'
     or (v_filter - array['supplierId', 'hotelId', 'status', 'endingWithinDays', 'q', 'preset']) <> '{}'::jsonb
     or (v_filter ? 'supplierId' and jsonb_typeof(v_filter -> 'supplierId') <> 'null' and authz.rc_uuid(v_filter -> 'supplierId') is null)
     or (v_filter ? 'hotelId' and jsonb_typeof(v_filter -> 'hotelId') <> 'null' and authz.rc_uuid(v_filter -> 'hotelId') is null)
     or (v_filter ? 'status' and jsonb_typeof(v_filter -> 'status') not in ('array', 'null'))
     or (jsonb_typeof(v_filter -> 'status') = 'array' and exists (
           select 1 from jsonb_array_elements(v_filter -> 'status') x
           where jsonb_typeof(x) <> 'string' or (x #>> '{}') not in ('draft', 'pending_approval', 'active', 'returned', 'ended')))
     or (v_filter ? 'endingWithinDays' and jsonb_typeof(v_filter -> 'endingWithinDays') <> 'null'
         and (jsonb_typeof(v_filter -> 'endingWithinDays') <> 'number' or (v_filter ->> 'endingWithinDays') !~ '^[0-9]{1,3}$'
              or (v_filter ->> 'endingWithinDays')::integer > 366))
     or (v_filter ? 'q' and jsonb_typeof(v_filter -> 'q') not in ('string', 'null'))
     or char_length(coalesce(v_filter ->> 'q', '')) > 100
     or coalesce(v_filter ->> 'preset', 'to_approve') not in ('to_approve', 'ending_soon') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'filter';
  end if;
  if v_limit < 1 or v_limit > 100 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'limit';
  end if;
  if p_after is not null then
    if p_after !~ '^[0-4]\|[0-9]{4}-[0-9]{2}-[0-9]{2}\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or authz.rc_date(split_part(p_after, '|', 2)) is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end if;
    v_after_rank := split_part(p_after, '|', 1)::integer;
    v_after_date := split_part(p_after, '|', 2)::date;
    v_after_id := split_part(p_after, '|', 3)::uuid;
  end if;
  v_status := case when jsonb_typeof(v_filter -> 'status') = 'array'
                   then array(select jsonb_array_elements_text(v_filter -> 'status')) end;
  if cardinality(v_status) = 0 then
    v_status := null;
  end if;
  v_days := case when jsonb_typeof(v_filter -> 'endingWithinDays') = 'number' then (v_filter ->> 'endingWithinDays')::integer end;
  v_q := nullif(lower(btrim(coalesce(v_filter ->> 'q', ''))), '');
  v_preset := v_filter ->> 'preset';

  select coalesce(jsonb_agg(x.row order by x.rank, x.valid_to, x.id), '[]'::jsonb), count(*)::integer
  into v_rows, v_n
  from (
    select c.id, c.valid_to, k.rank, jsonb_build_object(
        'contractId', c.id, 'contractNo', c.contract_no, 'versionNo', c.version_no,
        'supplierId', c.supplier_id, 'supplierName', s.name, 'hotelId', c.hotel_id, 'hotelName', h.name, 'city', h.city,
        'validFrom', to_char(c.valid_from, 'YYYY-MM-DD'), 'validTo', to_char(c.valid_to, 'YYYY-MM-DD'),
        'daysLeft', c.valid_to - v_today, 'status', c.status, 'source', c.source,
        'lineCount', (select count(*) from public.rate_contract_lines l where l.contract_id = c.id),
        'enteredByName', ep.display_name, 'submittedAt', c.submitted_at, 'rowVersion', c.row_version,
        -- Accounts phase 3 (20261205000570): own entries cannot be approved (not_self_approval).
        -- Accounts phase 3 (20261205000580): entered, last edited or sent by the viewer.
        'isMine', v_uid in (c.entered_by, c.last_edited_by, c.submitted_by),
        'canApprove', c.status = 'pending_approval' and c.legal_entity_id = any (v_mgr)
                      and v_uid not in (c.entered_by, c.last_edited_by, c.submitted_by)
                      and authz.rate_contracts_enabled(),
        'cursor', k.rank || '|' || to_char(c.valid_to, 'YYYY-MM-DD') || '|' || c.id) as row
    from public.rate_contracts c
    cross join lateral (select case c.status when 'pending_approval' then 0 when 'returned' then 1 when 'draft' then 2
                                             when 'active' then 3 else 4 end as rank) k
    join public.suppliers s on s.id = c.supplier_id
    join public.hotel_catalogue h on h.id = c.hotel_id
    left join public.staff_profiles ep on ep.user_id = c.entered_by
    where c.legal_entity_id = any (v_read)
      and (authz.rc_uuid(v_filter -> 'supplierId') is null or c.supplier_id = authz.rc_uuid(v_filter -> 'supplierId'))
      and (authz.rc_uuid(v_filter -> 'hotelId') is null or c.hotel_id = authz.rc_uuid(v_filter -> 'hotelId'))
      and (v_status is null or c.status = any (v_status))
      and (v_days is null or (c.status = 'active' and c.valid_to between v_today and v_today + v_days))
      and (v_q is null or lower(c.contract_no) = v_q or lower(s.name) like '%' || authz.vn_like_escape(v_q) || '%'
           or h.name_key like '%' || authz.vn_like_escape(v_q) || '%')
      and (v_preset is null
           or (v_preset = 'to_approve' and c.status = 'pending_approval' and c.legal_entity_id = any (v_mgr)
               and v_uid not in (c.entered_by, c.last_edited_by, c.submitted_by))
           or (v_preset = 'ending_soon' and c.status = 'active' and c.valid_to between v_today and v_today + 30))
      and (v_after_id is null or (k.rank, c.valid_to, c.id) > (v_after_rank, v_after_date, v_after_id))
    order by k.rank, c.valid_to, c.id
    limit v_limit + 1
  ) x;
  if v_n > v_limit then
    v_rows := v_rows - v_limit;
    v_last := v_rows -> (v_limit - 1);
  end if;
  return jsonb_build_object(
    'items', coalesce((select jsonb_agg(e - 'cursor' order by o) from jsonb_array_elements(v_rows) with ordinality a(e, o)), '[]'::jsonb),
    'nextAfter', v_last ->> 'cursor',
    'hasMore', v_last is not null);
end;
$$;

create or replace function public.rate_contract_get(p_contract_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c public.rate_contracts%rowtype;
  v_r jsonb;
  v_uid uuid := (select auth.uid());
  v_on boolean := authz.rate_contracts_enabled();
  v_p boolean;
  v_m boolean;
  v_lines integer;
  v_today date := (now() at time zone 'Asia/Kolkata')::date;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into c from public.rate_contracts x where x.id = p_contract_id;
  if c.id is null then
    return null;
  end if;
  v_r := authz.rc_reader(c.legal_entity_id);
  v_p := (v_r ->> 'p')::boolean;
  v_m := (v_r ->> 'm')::boolean;
  if not (v_p or v_m or (v_r ->> 'a')::boolean) then
    return null;
  end if;
  select count(*) into v_lines from public.rate_contract_lines l where l.contract_id = c.id;
  return (
    select jsonb_build_object(
      'contractId', c.id, 'contractNo', c.contract_no, 'versionNo', c.version_no,
      'supplierId', c.supplier_id, 'supplierName', s.name, 'hotelId', c.hotel_id, 'hotelName', h.name, 'city', h.city,
      'validFrom', to_char(c.valid_from, 'YYYY-MM-DD'), 'validTo', to_char(c.valid_to, 'YYYY-MM-DD'),
      'daysLeft', c.valid_to - v_today, 'status', c.status, 'source', c.source, 'importBatchId', c.import_batch_id,
      'lineCount', v_lines, 'rowVersion', c.row_version,
      -- Accounts phase 3 (20261205000570)
      'isMine', v_uid in (c.entered_by, c.last_edited_by, c.submitted_by),
      'cancellationTerms', c.cancellation_terms, 'note', c.note,
      'enteredByName', (select p.display_name from public.staff_profiles p where p.user_id = c.entered_by),
      'enteredAt', c.entered_at, 'submittedAt', c.submitted_at,
      'decidedByName', (select p.display_name from public.staff_profiles p where p.user_id = c.decided_by),
      'decidedAt', c.decided_at, 'returnReason', c.return_reason,
      'endedByName', (select p.display_name from public.staff_profiles p where p.user_id = c.ended_by),
      'endedAt', c.ended_at, 'endReason', c.end_reason,
      'lines', coalesce((
        select jsonb_agg(jsonb_build_object('lineId', l.id, 'lineNo', l.line_no,
            'seasonFrom', to_char(l.season_from, 'YYYY-MM-DD'), 'seasonTo', to_char(l.season_to, 'YYYY-MM-DD'),
            'roomTypeId', l.room_type_id, 'roomTypeName', t.name, 'mealPlan', l.meal_plan,
            'ratePaise', l.rate_paise::text, 'weekendRatePaise', l.weekend_rate_paise::text,
            'extraAdultPaise', l.extra_adult_paise::text, 'childWithBedPaise', l.child_with_bed_paise::text,
            'childWithoutBedPaise', l.child_without_bed_paise::text, 'note', l.note) order by l.line_no)
        from public.rate_contract_lines l join public.hotel_room_types t on t.id = l.room_type_id
        where l.contract_id = c.id), '[]'::jsonb),
      'blackouts', coalesce((
        select jsonb_agg(jsonb_build_object('fromDate', to_char(b.from_date, 'YYYY-MM-DD'), 'toDate', to_char(b.to_date, 'YYYY-MM-DD'))
          order by b.from_date, b.to_date)
        from public.rate_contract_blackouts b where b.contract_id = c.id), '[]'::jsonb),
      'files', coalesce((
        select jsonb_agg(jsonb_build_object('fileId', f.id, 'fileName', f.file_name, 'mime', f.mime, 'sizeBytes', f.size_bytes,
            'status', f.status, 'uploadedAt', f.created_at,
            'uploadedByName', (select p.display_name from public.staff_profiles p where p.user_id = f.uploaded_by))
          order by f.created_at, f.id)
        from public.rate_contract_files f where f.contract_id = c.id and f.status <> 'removed'), '[]'::jsonb),
      'history', coalesce((
        select jsonb_agg(jsonb_build_object('contractId', o.id, 'contractNo', o.contract_no, 'versionNo', o.version_no,
            'validFrom', to_char(o.valid_from, 'YYYY-MM-DD'), 'validTo', to_char(o.valid_to, 'YYYY-MM-DD'), 'status', o.status,
            'decidedByName', (select p.display_name from public.staff_profiles p where p.user_id = o.decided_by),
            'decidedAt', o.decided_at, 'endReason', o.end_reason) order by o.version_no desc)
        from public.rate_contracts o
        where o.supplier_id = c.supplier_id and o.hotel_id = c.hotel_id and o.id <> c.id), '[]'::jsonb),
      'roomTypes', coalesce((
        select jsonb_agg(jsonb_build_object('roomTypeId', t.id, 'name', t.name, 'rowVersion', t.row_version,
            'inUse', exists (select 1 from public.rate_contract_lines l join public.rate_contracts x on x.id = l.contract_id
                             where l.room_type_id = t.id and x.status in ('active', 'pending_approval'))) order by t.name_key, t.id)
        from public.hotel_room_types t where t.hotel_id = c.hotel_id and t.status = 'active'), '[]'::jsonb),
      'enabled', v_on,
      'can', jsonb_build_object(
        'edit', v_on and v_p and c.status in ('draft', 'returned'),
        'submit', v_on and v_p and c.status in ('draft', 'returned') and v_lines > 0,
        'approve', v_on and v_m and c.status = 'pending_approval' and v_uid not in (c.entered_by, c.last_edited_by, c.submitted_by),
        'return', v_on and v_m and c.status = 'pending_approval' and v_uid not in (c.entered_by, c.last_edited_by, c.submitted_by),
        'end', v_on and v_m and c.status = 'active',
        'upload', v_on and v_p and c.status <> 'ended'))
    from public.suppliers s, public.hotel_catalogue h
    where s.id = c.supplier_id and h.id = c.hotel_id);
end;
$$;

commit;
