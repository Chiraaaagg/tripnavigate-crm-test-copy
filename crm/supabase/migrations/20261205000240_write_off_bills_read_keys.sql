-- TripNavigate CRM - Accounts phase 3, track B (5): additive read keys for the
-- screens (lead request, 13 Nov 2026).
-- Contract: accounts-phase3-2026-11-12/contract.md 6.5, 6.6, 15 screens 5-6.
--
-- Replaced (bodies of 20261205000220 / 0210, same signatures, additive keys):
--   public.small_balances_list: adds settings {enabled, limitPaise} (the
--     write-off switch and limit in the caller's scope).
--   public.customer_documents_list: adds autoBills {drafts, release} (the
--     automatic bill switches of the caller's Accounts entities).
-- Refusal tokens: none new.
-- Rollback (forward-only): a NEW migration restoring the 0220 / 0210 bodies.

begin;
set local lock_timeout = '15s';

create or replace function public.small_balances_list(p_filter jsonb, p_after text default null, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_f jsonb := coalesce(p_filter, '{}'::jsonb);
  v_a uuid[];
  v_m uuid[];
  v_syn boolean;
  v_key text;
  v_preset text;
  v_branch uuid;
  v_ref text;
  v_like text;
  v_after_d date;
  v_after_id uuid;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_today date := authz.finance_today();
  v_rows jsonb;
  v_count integer;
  v_next text;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  v_a := authz.acct_a_entities();
  v_m := authz.acct_m_branches();
  v_syn := authz.acct_synthetic();
  if v_syn is null or (cardinality(v_a) = 0 and cardinality(v_m) = 0) then
    return null;
  end if;
  if jsonb_typeof(v_f) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'filter';
  end if;
  for v_key in select jsonb_object_keys(v_f) loop
    if v_key not in ('preset', 'branchId', 'dealReference') then
      raise exception 'invalid_input' using errcode = '22023', hint = v_key;
    end if;
  end loop;
  if v_f ? 'preset' and jsonb_typeof(v_f -> 'preset') not in ('string', 'null') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'preset';
  end if;
  v_preset := v_f ->> 'preset';
  if v_preset is not null and v_preset not in ('to_propose', 'to_approve', 'needs_review') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'preset';
  end if;
  begin
    v_branch := authz.finance_uuid(authz.finance_field(v_f, 'branchId'));
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'branchId';
  end;
  begin
    v_ref := nullif(btrim(coalesce(authz.finance_field(v_f, 'dealReference'), '')), '');
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'dealReference';
  end;
  if v_ref is not null then
    if length(v_ref) > 60 then
      raise exception 'invalid_input' using errcode = '22023', hint = 'dealReference';
    end if;
    v_like := replace(replace(replace(lower(v_ref), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  if p_after is not null then
    begin
      v_after_d := split_part(p_after, '|', 1)::date;
      v_after_id := split_part(p_after, '|', 2)::uuid;
    exception when others then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end;
    if v_after_d is null or v_after_id is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end if;
  end if;

  with c as (
    select x.deal_id, x.reference, x.branch_id, x.legal_entity_id, x.basis, x.money, x.balance, x.credit, x.is_a, x.is_m
    from authz.dues_compute(v_a, v_m, array[]::uuid[], v_syn, null, false) x
    where (x.is_a or x.is_m)
      and (v_branch is null or x.branch_id = v_branch)
      and (v_like is null or lower(x.reference) like v_like)
  ), base as (
    select c.*, cv.trip_end, coalesce(cv.trip_end, date '1900-01-01') as sort_end,
      coalesce(s.write_off_limit_paise, 500000)::bigint as lim, coalesce(s.write_off_enabled, false) as enabled,
      (c.basis = 'cancelled' or coalesce(cv.trip_end < v_today, false)) as ended,
      w.id as w_id, w.ref_no as w_ref, w.status as w_status, w.direction as w_dir, w.amount_paise as w_amount,
      w.reason as w_reason, w.proposed_by as w_proposed_by, w.row_version as w_rv
    from c
    left join lateral (select coalesce(v.trip_end, v.check_out) as trip_end from public.booking_versions v
                       where v.deal_id = c.deal_id and v.status = 'confirmed' limit 1) cv on true
    left join public.accounts_settings s on s.legal_entity_id = c.legal_entity_id
    left join lateral (select w.* from public.deal_write_offs w where w.deal_id = c.deal_id
                       order by (w.status in ('proposed', 'approved')) desc, w.proposed_at desc, w.id desc limit 1) w on true
  ), picked as (
    select b.*,
      ((b.balance > 0 and b.balance <= b.lim) or (b.credit > 0 and b.credit <= b.lim)) as small,
      row_number() over (order by b.sort_end, b.deal_id) as rn
    from base b
    where ((b.ended and ((b.balance > 0 and b.balance <= b.lim) or (b.credit > 0 and b.credit <= b.lim))) or b.w_id is not null)
      and (v_preset is null
           or (v_preset = 'to_propose' and b.ended and coalesce(b.w_status, '') not in ('proposed', 'approved')
               and ((b.balance > 0 and b.balance <= b.lim) or (b.credit > 0 and b.credit <= b.lim)))
           or (v_preset = 'to_approve' and b.w_status = 'proposed')
           or (v_preset = 'needs_review' and b.w_status = 'approved' and (b.balance > 0 or b.credit > 0)))
      and (v_after_d is null or (b.sort_end, b.deal_id) > (v_after_d, v_after_id))
    order by b.sort_end, b.deal_id
    limit v_limit + 1
  ), page as (
    select p.*,
      case when p.balance > 0 then 'due' when p.credit > 0 then 'excess' else coalesce(p.w_dir, 'due') end as direction,
      case when p.balance > 0 then p.balance when p.credit > 0 then p.credit else 0 end::bigint as amount,
      array_remove(array[
        case when not p.enabled then 'write_off_off' end,
        case when not p.ended then 'trip_not_ended' end,
        case when exists (select 1 from public.customer_refund_requests q where q.deal_id = p.deal_id
                          and (q.status in ('requested', 'returned') or (q.status = 'approved' and q.outcome = 'payout')))
             then 'refund_open' end,
        case when exists (select 1 from public.deal_cancellations x where x.deal_id = p.deal_id and x.status <> 'approved')
             then 'cancellation_open' end,
        case when coalesce(authz.deal_change_open(p.deal_id), false) then 'change_open' end,
        case when exists (select 1 from public.customer_receipts r where r.deal_id = p.deal_id and r.status in ('recorded', 'pending_clearance'))
               or exists (select 1 from public.customer_payment_claims x where x.deal_id = p.deal_id and x.status = 'reported')
             then 'receipt_unverified' end,
        case when p.money < 0 then 'shortfall' end,
        case when greatest(p.balance, p.credit) > p.lim then 'over_limit' end]::text[], null) as blocked
    from picked p
    where p.rn <= v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'dealId', g.deal_id,
      'dealReference', g.reference,
      'branchName', br.name,
      'tripEnd', to_char(g.trip_end, 'YYYY-MM-DD'),
      'direction', g.direction,
      'balancePaise', g.amount::text,
      'limitPaise', g.lim::text,
      'writeOff', case when g.w_id is not null then jsonb_build_object(
          'id', g.w_id, 'refNo', g.w_ref, 'status', g.w_status, 'amountPaise', g.w_amount::text, 'reason', g.w_reason,
          'proposedByName', sp.display_name, 'rowVersion', g.w_rv) end,
      'blockedBy', to_jsonb(g.blocked),
      'can', jsonb_build_object(
        'propose', coalesce(g.is_a and g.enabled and coalesce(g.w_status, '') not in ('proposed', 'approved')
                   and cardinality(g.blocked) = 0 and g.amount > 0, false),
        'approve', coalesce(g.is_m and g.enabled and g.w_status = 'proposed' and g.w_proposed_by is distinct from v_uid
                   and cardinality(g.blocked) = 0 and g.w_dir = g.direction and g.w_amount = g.amount, false),
        'return', coalesce(g.is_m and g.w_status = 'proposed' and g.w_proposed_by is distinct from v_uid, false),
        'withdraw', coalesce(g.w_status = 'proposed' and g.w_proposed_by = v_uid, false),
        'undo', coalesce(g.is_m and g.w_status = 'approved', false)))
      order by g.sort_end, g.deal_id), '[]'::jsonb),
    (select count(*)::integer from picked),
    (select to_char(p.sort_end, 'YYYY-MM-DD') || '|' || p.deal_id::text from picked p where p.rn = v_limit)
    into v_rows, v_count, v_next
  from page g
  join public.branches br on br.id = g.branch_id
  left join public.staff_profiles sp on sp.user_id = g.w_proposed_by;

  -- Accounts phase 3 (20261205000240): the switch and limit in the caller's scope
  -- (on when on for every entity in scope; the lowest limit).
  return jsonb_build_object('items', v_rows, 'hasMore', v_count > v_limit,
    'nextAfter', case when v_count > v_limit then v_next end,
    'settings', (select jsonb_build_object('enabled', coalesce(bool_and(coalesce(s.write_off_enabled, false)), false),
                                           'limitPaise', coalesce(min(coalesce(s.write_off_limit_paise, 500000)), 500000)::text)
                 from (select unnest(v_a) as e union select b.legal_entity_id from public.branches b where b.id = any(v_m)) x
                 left join public.accounts_settings s on s.legal_entity_id = x.e));
end;
$$;

create or replace function public.customer_documents_list(p_filter jsonb, p_after text default null, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c_status constant text[] := array['draft', 'released', 'replaced', 'cancelled', 'discarded'];
  c_kind constant text[] := array['advance_invoice', 'invoice', 'credit_note'];
  c_pdf constant text[] := array['none', 'queued', 'ready', 'failed'];
  v_f jsonb := coalesce(p_filter, '{}'::jsonb);
  v_a uuid[];
  v_m uuid[];
  v_syn boolean;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_status text[];
  v_kind text[];
  v_stale boolean;
  v_changed boolean;
  v_reversed boolean;
  v_pdf text;
  v_tally boolean;
  v_ref text;
  v_like text;
  v_from date;
  v_to date;
  v_branch uuid;
  v_to_release boolean;
  v_auto_state text;
  v_preset text;
  v_dir text := 'desc';
  v_cmp text := '<';
  v_after_ts timestamptz;
  v_after_id uuid;
  v_key text;
  v_where text := '';
  v_ev text;
  v_charge text;
  v_sql text;
  v_rows jsonb;
  v_count integer;
  v_next text;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  v_a := authz.acct_a_entities();
  v_m := authz.acct_m_branches();
  v_syn := authz.acct_synthetic();
  if v_syn is null or (cardinality(v_a) = 0 and cardinality(v_m) = 0) then
    return null;
  end if;
  if jsonb_typeof(v_f) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'filter';
  end if;
  for v_key in select jsonb_object_keys(v_f) loop
    if v_key not in ('status', 'kind', 'stale', 'bookingChanged', 'paymentReversed', 'pdfState', 'tallyLinked', 'dealReference',
                     'from', 'to', 'branchId', 'toRelease', 'autoState', 'preset', 'toCheck') then
      raise exception 'invalid_input' using errcode = '22023', hint = v_key;
    end if;
  end loop;
  begin
    if v_f ? 'status' and jsonb_typeof(v_f -> 'status') <> 'null' then
      v_status := array(select jsonb_array_elements_text(v_f -> 'status'));
      if not v_status <@ c_status then raise exception 'bad'; end if;
    end if;
  exception when others then
    raise exception 'invalid_input' using errcode = '22023', hint = 'status';
  end;
  begin
    if v_f ? 'kind' and jsonb_typeof(v_f -> 'kind') <> 'null' then
      v_kind := array(select jsonb_array_elements_text(v_f -> 'kind'));
      if not v_kind <@ c_kind then raise exception 'bad'; end if;
    end if;
  exception when others then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end;
  foreach v_key in array array['stale', 'bookingChanged', 'paymentReversed', 'tallyLinked', 'toRelease'] loop
    if v_f ? v_key and jsonb_typeof(v_f -> v_key) not in ('boolean', 'null') then
      raise exception 'invalid_input' using errcode = '22023', hint = v_key;
    end if;
  end loop;
  v_stale := (v_f ->> 'stale')::boolean;
  v_changed := (v_f ->> 'bookingChanged')::boolean;
  v_reversed := (v_f ->> 'paymentReversed')::boolean;
  v_tally := (v_f ->> 'tallyLinked')::boolean;
  v_to_release := (v_f ->> 'toRelease')::boolean;
  v_pdf := v_f ->> 'pdfState';
  if v_pdf is not null and not (v_pdf = any(c_pdf)) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'pdfState';
  end if;
  -- Accounts phase 3 (20261205000210)
  if v_f ? 'autoState' and jsonb_typeof(v_f -> 'autoState') not in ('string', 'null') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'autoState';
  end if;
  v_auto_state := v_f ->> 'autoState';
  if v_auto_state is not null and v_auto_state not in ('ready', 'held') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'autoState';
  end if;
  if v_f ? 'preset' and jsonb_typeof(v_f -> 'preset') not in ('string', 'null') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'preset';
  end if;
  v_preset := v_f ->> 'preset';
  if v_preset is not null and v_preset <> 'toCheck' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'preset';
  end if;
  -- Boolean alias of the preset (like toRelease): {toCheck: true}.
  if v_f ? 'toCheck' and jsonb_typeof(v_f -> 'toCheck') not in ('boolean', 'null') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'toCheck';
  end if;
  if (v_f ->> 'toCheck')::boolean then
    v_preset := 'toCheck';
  end if;
  v_ref := nullif(btrim(coalesce(v_f ->> 'dealReference', '')), '');
  if v_ref is not null and length(v_ref) > 60 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'dealReference';
  end if;
  begin
    v_from := authz.finance_date(v_f ->> 'from');
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'from';
  end;
  begin
    v_to := authz.finance_date(v_f ->> 'to');
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'to';
  end;
  begin
    v_branch := authz.finance_uuid(v_f ->> 'branchId');
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'branchId';
  end;
  if p_after is not null then
    begin
      v_after_ts := split_part(p_after, '|', 1)::timestamptz;
      v_after_id := split_part(p_after, '|', 2)::uuid;
    exception when others then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end;
    if v_after_ts is null or v_after_id is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end if;
  end if;

  if v_status is not null then v_where := v_where || ' and c.status = any($4)'; end if;
  if v_kind is not null then v_where := v_where || ' and c.kind = any($5)'; end if;
  if v_branch is not null then v_where := v_where || ' and c.branch_id = $6'; end if;
  if v_ref is not null then
    v_like := replace(replace(replace(lower(v_ref), '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_where := v_where || ' and lower(d.reference) like $7';
  end if;
  if v_from is not null then v_where := v_where || ' and c.issue_date >= $8'; end if;
  if v_to is not null then v_where := v_where || ' and c.issue_date <= $9'; end if;
  if v_tally is not null then v_where := v_where || ' and (c.tally_invoice_id is not null) = $10'; end if;
  if v_to_release is not null then v_where := v_where || ' and (c.status = ''draft'') = $11'; end if;
  if v_reversed is not null then
    v_where := v_where || ' and (c.kind = ''advance_invoice'' and not exists (select 1 from public.customer_receipts r
      where r.id = c.receipt_id and r.status in (''verified'', ''cleared''))) = $12';
  end if;
  if v_pdf is not null then
    v_where := v_where || ' and (case when exists (select 1 from public.customer_document_files f where f.document_id = c.id) then ''ready''
      else coalesce((select case when j.status in (''queued'', ''running'') then ''queued'' when j.status = ''failed'' then ''failed'' else ''none'' end
                     from public.customer_document_render_jobs j where j.document_id = c.id order by j.created_at desc, j.id desc limit 1), ''none'') end) = $13';
  end if;
  if v_stale is true then
    v_where := v_where || ' and c.status = ''draft'' and authz.cdoc_source_hash(c.id) is distinct from c.source_hash';
  elsif v_stale is false then
    v_where := v_where || ' and (c.status <> ''draft'' or authz.cdoc_source_hash(c.id) is not distinct from c.source_hash)';
  end if;
  if v_changed is not null then
    v_ev := '(select v.id from public.booking_versions v join public.accounts_booking_reviews rv on rv.booking_version_id = v.id
      where v.deal_id = c.deal_id and v.status in (''confirmed'', ''superseded'') and rv.last_approved_at is not null
      order by v.version_no desc limit 1)';
    v_charge := case when to_regclass('public.customer_refund_requests') is null then 'null::bigint' else
      '(select max(r.customer_charge_paise) from public.customer_refund_requests r where r.deal_id = c.deal_id
         and r.kind = ''cancellation'' and r.status in (''approved'', ''paid''))' end;
    v_where := v_where || ' and (c.kind = ''invoice'' and c.status = ''released'' and (
        c.basis_version_id is distinct from coalesce(' || v_ev || ', (select v.id from public.booking_versions v
          where v.deal_id = c.deal_id and v.status = ''confirmed''))
        or c.total_paise is distinct from coalesce(' || v_charge || ', case
          when exists (select 1 from public.flight_ticket_batches t where t.deal_id = c.deal_id and t.deal_kind = ''flight_only'')
          then (select sum(t.customer_total_paise)::bigint from public.flight_ticket_batches t where t.deal_id = c.deal_id and t.deal_kind = ''flight_only'')
          else (select bc.selling_total_paise from public.booking_version_commercials bc where bc.version_id = ' || v_ev || ') end))) = $14';
  end if;
  -- Accounts phase 3 (20261205000210): automatic state and the "Bills to check" preset (oldest first).
  if v_auto_state is not null then
    v_where := v_where || ' and c.status = ''draft'' and c.auto_state = $18';
  end if;
  if v_preset = 'toCheck' then
    v_where := v_where || ' and c.status = ''draft'' and c.auto_rule is not null and c.auto_state = ''held''';
    v_dir := 'asc';
    v_cmp := '>';
  end if;
  if v_after_ts is not null then
    v_where := v_where || ' and (coalesce(c.released_at, c.created_at), c.id) ' || v_cmp || ' ($15, $16)';
  end if;

  v_sql := 'with page as (
    select c.id, c.legal_entity_id, c.deal_id, d.reference as deal_reference, b.name as branch_name,
      case when c.legal_entity_id = any($1) then ''accounts'' else ''manager'' end as viewer,
      coalesce(c.released_at, c.created_at) as sort_at
    from public.customer_documents c
    join public.deals d on d.id = c.deal_id
    join public.branches b on b.id = c.branch_id
    where d.is_synthetic = $3
      and (c.legal_entity_id = any($1) or (c.branch_id = any($2) and c.status in (''released'', ''replaced'', ''cancelled'')))'
    || v_where || '
    order by coalesce(c.released_at, c.created_at) ' || v_dir || ', c.id ' || v_dir || '
    limit $17 + 1
  ), numbered as (
    select p.*, row_number() over (order by p.sort_at ' || v_dir || ', p.id ' || v_dir || ') as rn from page p
  )
  select coalesce(jsonb_agg(
           authz.cdoc_doc_json(x, n.viewer, authz.cdoc_enabled(n.legal_entity_id),
             exists (select 1 from public.customer_billing_profiles bp where bp.deal_id = n.deal_id and bp.status = ''verified''))
           || jsonb_build_object(''dealId'', n.deal_id, ''dealReference'', n.deal_reference, ''branchName'', n.branch_name,
                ''autoRule'', x.auto_rule, ''autoState'', x.auto_state, ''holdReasons'', to_jsonb(x.hold_reasons),
                ''releasedByCrm'', x.release_rule is not null)
           order by n.rn) filter (where n.rn <= $17), ''[]''::jsonb),
         count(*)::integer,
         max(case when n.rn = $17 then to_char(n.sort_at at time zone ''UTC'', ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"'') || ''|'' || n.id::text end)
  from numbered n
  join public.customer_documents x on x.id = n.id';
  execute v_sql into v_rows, v_count, v_next
    using v_a, v_m, v_syn, v_status, v_kind, v_branch, v_like, v_from, v_to, v_tally, v_to_release, v_reversed, v_pdf, v_changed,
      v_after_ts, v_after_id, v_limit, v_auto_state;

  -- Accounts phase 3 (20261205000240): the automatic bill switches of the caller's
  -- Accounts entities (on when on for any of them; false for Managers).
  return jsonb_build_object('items', v_rows, 'hasMore', v_count > v_limit,
    'nextAfter', case when v_count > v_limit then v_next end,
    'autoBills', jsonb_build_object(
      'drafts', coalesce((select bool_or(authz.cdoc_auto_on(e)) from unnest(v_a) e), false),
      'release', coalesce((select bool_or(authz.cdoc_auto_release_on(e)) from unnest(v_a) e), false)));
end;
$$;

commit;
