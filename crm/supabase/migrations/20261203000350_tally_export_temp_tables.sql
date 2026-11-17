-- Accounts phase, Track B (16): hardening of the export's temporary work
-- tables (20261203000340).
--
-- public.accounts_tally_export_create (replaces 20261203000340, otherwise
-- unchanged): its two work tables are dropped if present and created fresh
-- with ON COMMIT DROP, and every reference is pg_temp-qualified, so a
-- same-name temporary table made earlier in the session can never be used,
-- two exports in one transaction each start empty, and nothing outlives the
-- transaction (safe with PostgREST / transaction pooling). The tables are
-- created by the function owner (security definer): callers need no TEMP
-- privilege.
--
-- Rollback (forward-only): a NEW migration restoring the 20261203000340 body.

begin;
set local lock_timeout = '15s';

-- Replaces 20261203000340: fresh, pg_temp-qualified work tables.
create or replace function public.accounts_tally_export_create(p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c_kinds constant text[] := array['journal_entry', 'supplier_payment', 'supplier_document', 'expense', 'tally_gst_invoice'];
  v_payload jsonb := jsonb_build_object('fields', p_fields);
  v_result jsonb;
  v_entity uuid;
  v_from date;
  v_to date;
  v_kinds text[];
  v_include boolean;
  v_branches uuid[];
  v_syn boolean;
  v_count integer;
  v_kind text;  -- Accounts phase (20261203000340)
  v_skipped integer := 0;
  v_already integer := 0;
  v_year integer;
  v_no integer;
  v_export public.tally_exports%rowtype;
begin
  perform authz.finance_require_accounts_anywhere();
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['entityId', 'from', 'to', 'kinds', 'includeExported', 'branchIds']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  begin
    v_entity := authz.finance_uuid(authz.finance_field(p_fields, 'entityId'));
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'entityId';
  end;
  if v_entity is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'entityId';
  end if;
  perform authz.finance_require_accounts(v_entity, null);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_entity, p_request_id, 'accounts_tally_export_create', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if not coalesce((select s.tally_export_enabled from public.accounts_settings s where s.legal_entity_id = v_entity), false) then
    raise exception 'tally_export_off' using errcode = '55000';
  end if;
  begin
    v_from := authz.finance_date(authz.finance_field(p_fields, 'from'));
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'from'; end;
  begin
    v_to := authz.finance_date(authz.finance_field(p_fields, 'to'));
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'to'; end;
  if v_from is null or v_from < date '2000-01-01' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'from';
  end if;
  if v_to is null or v_to < v_from or v_to > authz.finance_today() or v_to - v_from > 366 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'to';
  end if;
  if jsonb_typeof(p_fields -> 'kinds') is distinct from 'array' or jsonb_array_length(p_fields -> 'kinds') = 0
     or exists (select 1 from jsonb_array_elements(p_fields -> 'kinds') e
                where jsonb_typeof(e) <> 'string' or not ((e #>> '{}') = any(c_kinds))) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kinds';
  end if;
  select array_agg(distinct e order by e) into v_kinds from jsonb_array_elements_text(p_fields -> 'kinds') e;
  if jsonb_typeof(p_fields -> 'includeExported') is distinct from 'boolean' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'includeExported';
  end if;
  v_include := (p_fields ->> 'includeExported')::boolean;
  if p_fields ? 'branchIds' and jsonb_typeof(p_fields -> 'branchIds') <> 'null' then
    if jsonb_typeof(p_fields -> 'branchIds') <> 'array' or jsonb_array_length(p_fields -> 'branchIds') not between 1 and 50
       or exists (select 1 from jsonb_array_elements(p_fields -> 'branchIds') e
                  where jsonb_typeof(e) <> 'string'
                     or (e #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     or not exists (select 1 from public.branches b where b.id = (e #>> '{}')::uuid and b.legal_entity_id = v_entity)) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'branchIds';
    end if;
    select array_agg(distinct (e #>> '{}')::uuid) into v_branches from jsonb_array_elements(p_fields -> 'branchIds') e;
  end if;
  v_syn := authz.acct_synthetic();

  -- Accounts phase (20261203000300, Addendum L1): one exclusive lock per
  -- entity (single-record Tally commands hold it shared), then FOR UPDATE on
  -- the Tally rows changed; everything below is set-based.
  perform authz.tally_entity_lock(v_entity, true);
  -- Accounts phase (20261203000350): always a fresh work table of this
  -- function's shape, schema-qualified (a same-name temporary table made
  -- earlier in the session is replaced, never used), dropped at commit.
  drop table if exists pg_temp.tally_export_work;
  create temporary table tally_export_work (
    kind text, id uuid, line integer, branch_id uuid, deal_id uuid, tr_id uuid, prev_at timestamptz, prev_hash text,
    source jsonb, hash text) on commit drop;
  insert into pg_temp.tally_export_work (kind, id, line, branch_id, deal_id, tr_id, prev_at, prev_hash)
  select c.kind, c.id, row_number() over (order by c.kind, c.id), c.branch_id, c.deal_id, c.tr_id, c.prev_at, c.prev_hash
  from (
      select 'journal_entry'::text as kind, e.id, coalesce(d.branch_id, e.branch_id) as branch_id, tr.status as stored, 'ready'::text as computed, coalesce(d.id, null::uuid) as deal_id, tr.id as tr_id, tr.last_exported_at as prev_at, tr.last_export_hash as prev_hash
      from public.finance_journal_entries e
      left join public.deals d on d.id = e.deal_id
      left join public.tally_records tr on tr.record_kind = 'journal_entry' and tr.record_id = e.id
      where 'journal_entry' = any(v_kinds) and e.legal_entity_id = v_entity and e.business_date between v_from and v_to
        and (d.id is null or d.is_synthetic = v_syn)
      union all
      select 'supplier_payment', p.id, d.branch_id, tr.status, 'ready', d.id, tr.id, tr.last_exported_at, tr.last_export_hash
      from public.supplier_payment_requests p
      join public.deals d on d.id = p.deal_id
      left join public.tally_records tr on tr.record_kind = 'supplier_payment' and tr.record_id = p.id
      where 'supplier_payment' = any(v_kinds) and p.legal_entity_id = v_entity and p.status = 'verified'
        and p.paid_on between v_from and v_to and d.is_synthetic = v_syn
      union all
      select 'supplier_document', x.id, d.branch_id, tr.status, 'ready', d.id, tr.id, tr.last_exported_at, tr.last_export_hash
      from public.supplier_documents x
      join public.deals d on d.id = x.deal_id
      left join public.tally_records tr on tr.record_kind = 'supplier_document' and tr.record_id = x.id
      where 'supplier_document' = any(v_kinds) and x.legal_entity_id = v_entity and x.status = 'accepted'
        and x.doc_date between v_from and v_to and d.is_synthetic = v_syn
      union all
      select 'expense', c.id, d.branch_id, tr.status, 'ready', d.id, tr.id, tr.last_exported_at, tr.last_export_hash
      from public.department_cost_entries c
      join public.deals d on d.id = c.deal_id
      left join public.tally_records tr on tr.record_kind = 'expense' and tr.record_id = c.id
      where 'expense' = any(v_kinds) and c.legal_entity_id = v_entity and c.paid_by = 'company' and c.expense_status = 'accepted'
        and coalesce(c.paid_on, (timezone('Asia/Kolkata', c.created_at))::date) between v_from and v_to and d.is_synthetic = v_syn
      union all
      select 'tally_gst_invoice', g.id, g.branch_id, tr.status, 'matched', d.id, tr.id, tr.last_exported_at, tr.last_export_hash
      from public.deal_tally_invoices g
      join public.deals d on d.id = g.deal_id
      left join public.tally_records tr on tr.record_kind = 'tally_gst_invoice' and tr.record_id = g.id
      where 'tally_gst_invoice' = any(v_kinds) and g.legal_entity_id = v_entity and g.status = 'active'
        and g.invoice_date between v_from and v_to and d.is_synthetic = v_syn
    ) c
  where (v_branches is null or c.branch_id = any(v_branches))
    and (authz.tally_effective(c.computed, c.stored) = 'ready'
         or (v_include and authz.tally_effective(c.computed, c.stored) = 'exported'))
  order by c.kind, c.id
  limit 10001;
  select count(*)::int into v_count from pg_temp.tally_export_work;
  if v_count > 10000 then
    raise exception 'export_too_large' using errcode = '22023', hint = 'from';
  end if;
  if v_count = 0 then
    raise exception 'nothing_to_export' using errcode = '55000';
  end if;
  perform 1 from public.tally_records r where r.id in (select w.tr_id from pg_temp.tally_export_work w where w.tr_id is not null)
  order by r.id for no key update;  -- Accounts phase (20261203000330)

  -- Source values and hashes: one pass per kind.
  -- Accounts phase (20261203000340): the source set is computed once per kind
  -- into a work table (the planner had put the function scan on the inner
  -- side of a nested loop and ran it once per exported row).
  drop table if exists pg_temp.tally_export_src;
  create temporary table tally_export_src (kind text, record_id uuid, source jsonb, ids jsonb) on commit drop;
  for v_kind in select distinct w2.kind from pg_temp.tally_export_work w2 loop
    insert into pg_temp.tally_export_src (kind, record_id, source, ids)
    select v_kind, s.record_id, s.source, s.ids
    from authz.tally_source_set(v_kind, array(select w3.id from pg_temp.tally_export_work w3 where w3.kind = v_kind)) s;
  end loop;
  update pg_temp.tally_export_work w set source = s.source, hash = authz.tally_hash(s.source, s.ids)
  from pg_temp.tally_export_src s
  where s.kind = w.kind and s.record_id = w.id;
  select count(*)::int into v_already from pg_temp.tally_export_work w where w.prev_at is not null;

  v_year := extract(year from authz.finance_today())::integer;
  insert into public.tally_export_counters as c (legal_entity_id, year, last_no) values (v_entity, v_year, 1)
  on conflict (legal_entity_id, year) do update set last_no = c.last_no + 1
  returning c.last_no into v_no;
  insert into public.tally_exports (legal_entity_id, export_no, period_from, period_to, kinds, include_exported, branch_ids,
    row_count, created_by, request_id)
  values (v_entity, 'TE-' || v_year::text || '-' || lpad(v_no::text, 6, '0'), v_from, v_to, v_kinds, v_include, v_branches,
    v_count, (select auth.uid()), p_request_id)
  returning * into v_export;

  -- New Tally rows (records exported for the first time).
  with ins as (
    insert into public.tally_records (legal_entity_id, branch_id, deal_id, record_kind, record_id, status, export_count,
      last_export_id, last_exported_at, last_export_hash, updated_by)
    select v_entity, w.branch_id, w.deal_id, w.kind, w.id, 'exported', 1, v_export.id, now(), w.hash, (select auth.uid())
    from pg_temp.tally_export_work w where w.tr_id is null
    returning id, record_kind, record_id)
  update pg_temp.tally_export_work w set tr_id = ins.id from ins where ins.record_kind = w.kind and ins.record_id = w.id;
  -- Lines (snapshots, masked) with the previous export state.
  insert into public.tally_export_lines (export_id, line_no, legal_entity_id, record_kind, record_id, tally_record_id, "values",
    source_hash, previously_exported_at)
  select v_export.id, w.line, v_entity, w.kind, w.id, w.tr_id,
    authz.tally_line_values(w.source, v_export.export_no, w.line, w.prev_at, w.prev_hash is not null and w.prev_hash <> w.hash),
    w.hash, w.prev_at
  from pg_temp.tally_export_work w;
  -- Rows exported before (or back at ready).
  update public.tally_records r
  set status = 'exported', export_count = r.export_count + 1, last_export_id = v_export.id, last_exported_at = now(),
      last_export_hash = w.hash, row_version = r.row_version + 1, updated_at = now(), updated_by = (select auth.uid())
  from pg_temp.tally_export_work w
  where r.id = w.tr_id and r.last_export_id is distinct from v_export.id;

  perform authz.write_audit('accounts.tally_export_created', v_entity, null, 'tally_export', v_export.id, null,
    jsonb_build_object('exportId', v_export.id, 'rowCount', v_count, 'kinds', to_jsonb(v_kinds),
      'alreadyExportedCount', v_already, 'skippedCount', v_skipped));
  v_result := jsonb_build_object('outcome', 'created', 'exportId', v_export.id, 'exportNo', v_export.export_no,
    'rowCount', v_count, 'alreadyExportedCount', v_already, 'skippedCount', v_skipped);
  return authz.finance_remember(v_entity, p_request_id, 'accounts_tally_export_create', v_payload, v_result);
end;
$$;

commit;
