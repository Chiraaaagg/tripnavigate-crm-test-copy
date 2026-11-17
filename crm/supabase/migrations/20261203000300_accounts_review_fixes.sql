-- Accounts phase, Track B (11): fixes after the independent reviews
-- (contract.md Addendum L1, 10 Nov 2026, and the UI review of Track B).
--
-- 1. Tally dead ends (L1 review 1). tally_records.status may also be
--    'ready' (back to its computed state). T3 reopen
--    (public.accounts_tally_reopen, replaces 20261203000250):
--      exception (before: matched)                 -> matched (voucher kept)
--      exception (before: exported, or ready after an export) -> exported
--      exception (before: ready, never exported)    -> ready
--      matched, exported before                     -> exported (voucher cleared)
--      matched, never exported                      -> ready (voucher cleared)
--    A GST invoice reference is never reopened from matched (withdraw it).
--    acct_row_json's can.reopen is true exactly where T3 succeeds.
-- 2. Export locks (L1 review 3). public.accounts_tally_export_create
--    (replaces 20261203000250) takes one exclusive transaction lock per
--    entity and FOR UPDATE on the Tally rows it changes; T1-T3
--    (authz.tally_prelude, replaces 20261203000250) take the same lock
--    shared, so a match and an export of the entity serialise without a lock
--    per record. Lines are built set-based (one source pass per kind).
--    skippedCount is always 0 now (nothing can change under the lock).
-- 3. Link picker (L1 review 5). public.supplier_document_link_targets
--    (replaces 20261203000260): filters inside the subquery, ordered by task
--    creation, then limit 200.
-- 4. Changed since export (L1 review 9). The source hash uses ids (branch,
--    Deal, supplier) instead of display names: authz.tally_source_set gains
--    an ids column (dropped and recreated), new authz.tally_hash(source,
--    ids); tally_source_json, tally_source_hash and tally_changed_ids
--    follow. Hashes stored before this migration read as changed (nothing
--    is live).
-- 5. Workspace links per viewer (UI review). link {kind, id, dealId, ref}:
--    Accounts get a screen they can open (the Accounts Deal page, or the
--    record's list with its reference); the branch Manager gets the Deal
--    page dues card (kind 'deal_dues') or no link (kind 'none').
--    authz.acct_row_json replaces 20261203000290.
-- 6. Daily check links (UI review). New workspace filter key overdueCheck
--    ('receipts_unverified' | 'payments_unrecorded') selecting exactly the
--    rows the daily check counts; the daily check returns the filter of each
--    count (key filters). authz.acct_rows replaces 20261203000290,
--    public.accounts_daily_check replaces 20261203000280.
--
-- Rollback (forward-only): a NEW migration restoring the replaced bodies;
-- the widened status check stays (no row needs it removed).

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Stored status 'ready'
-- ===========================================================================

do $$
declare
  c text;
begin
  select conname into c from pg_catalog.pg_constraint
  where conrelid = 'public.tally_records'::regclass and contype = 'c'
    and pg_catalog.pg_get_constraintdef(oid) like '%status = ANY%exported%matched%exception%'
    and pg_catalog.pg_get_constraintdef(oid) not like '%status_before_exception%';
  if c is null then
    raise exception 'tally_records status check not found';
  end if;
  execute format('alter table public.tally_records drop constraint %I', c);
end;
$$;
alter table public.tally_records
  add constraint tally_records_status_check check (status in ('ready', 'exported', 'matched', 'exception'));

-- Per-entity Tally lock: exports exclusive, single-record commands shared.
create function authz.tally_entity_lock(p_entity uuid, p_exclusive boolean) returns void
language plpgsql volatile set search_path = '' as $$
begin
  if p_exclusive then
    perform pg_advisory_xact_lock(hashtextextended('tally_entity:' || p_entity::text, 0));
  else
    perform pg_advisory_xact_lock_shared(hashtextextended('tally_entity:' || p_entity::text, 0));
  end if;
end;
$$;

-- Replaces 20261203000250: + the shared entity lock.
create or replace function authz.tally_prelude(p_kind text, p_id uuid, p_request uuid)
returns table (entity uuid, branch_id uuid, deal_id uuid, synthetic boolean, computed text)
language plpgsql volatile security definer set search_path = '' as $$
declare
  t record;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('journal_entry', 'supplier_payment', 'supplier_document', 'expense', 'tally_gst_invoice') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  if p_request is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into t from authz.tally_target(p_kind, p_id) x limit 1;
  if t.entity is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.finance_require_accounts(t.entity, t.synthetic);
  -- Accounts phase (20261203000300): shared entity lock (an export holds it exclusive).
  perform authz.tally_entity_lock(t.entity, false);
  perform authz.tally_lock(p_kind, p_id);
  return query select t.entity, t.branch_id, t.deal_id, t.synthetic, t.computed;
end;
$$;

-- Replaces 20261203000250: reopen rules of Addendum L1.
create or replace function public.accounts_tally_reopen(p_kind text, p_record_id uuid, p_expected_row_version integer, p_reason text,
  p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  t record;
  v_tr public.tally_records%rowtype;
  v_payload jsonb := jsonb_build_object('kind', p_kind, 'recordId', p_record_id, 'expectedRowVersion', p_expected_row_version,
    'reason', p_reason);
  v_result jsonb;
  v_reason text;
  v_from text;
  v_to text;
begin
  select * into t from authz.tally_prelude(p_kind, p_record_id, p_request_id) x limit 1;
  select * into v_tr from public.tally_records r where r.record_kind = p_kind and r.record_id = p_record_id for update;
  v_result := authz.finance_replay(t.entity, p_request_id, 'accounts_tally_reopen', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_expected_row_version is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  begin
    v_reason := authz.finance_reason(p_reason);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end;
  if coalesce(v_tr.row_version, 0) <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_from := authz.tally_effective(t.computed, v_tr.status);
  -- Accounts phase (20261203000300, Addendum L1): no dead ends.
  v_to := case
    when v_from = 'exception' and v_tr.status_before_exception = 'matched' and v_tr.voucher_ref is not null then 'matched'
    when v_from = 'exception' and (v_tr.status_before_exception = 'exported'
                                   or (v_tr.status_before_exception = 'ready' and v_tr.export_count > 0)) then 'exported'
    when v_from = 'exception' and v_tr.status_before_exception = 'ready' and v_tr.export_count = 0 then 'ready'
    when v_from = 'matched' and p_kind <> 'tally_gst_invoice' and v_tr.export_count > 0 then 'exported'
    when v_from = 'matched' and p_kind <> 'tally_gst_invoice' and v_tr.id is not null and v_tr.export_count = 0 then 'ready'
    else null end;
  if v_to is null then
    raise exception 'wrong_state' using errcode = '55000', hint = 'notReopenable';
  end if;

  update public.tally_records r
  set status = v_to,
      voucher_ref = case when v_to = 'matched' then r.voucher_ref end,
      voucher_date = case when v_to = 'matched' then r.voucher_date end,
      matched_by = case when v_to = 'matched' then (select auth.uid()) end,
      matched_at = case when v_to = 'matched' then now() end,
      exception_reason = null, exception_tally_amount_paise = null, exception_by = null, exception_at = null,
      status_before_exception = null,
      row_version = r.row_version + 1, updated_at = now(), updated_by = (select auth.uid())
  where r.id = v_tr.id
  returning * into v_tr;
  perform authz.write_audit('accounts.tally_reopened', t.entity, t.branch_id, p_kind, p_record_id, v_reason,
    jsonb_build_object('tallyRecordId', v_tr.id, 'rowVersion', v_tr.row_version, 'fromStatus', v_from, 'toStatus', v_to));
  v_result := jsonb_build_object('outcome', 'updated', 'tallyRecordId', v_tr.id, 'status', v_tr.status, 'rowVersion', v_tr.row_version);
  return authz.finance_remember(t.entity, p_request_id, 'accounts_tally_reopen', v_payload, v_result);
end;
$$;

-- Replaces 20261203000250: entity lock and set-based lines (Addendum L1).
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
  create temporary table if not exists tally_export_work (
    kind text, id uuid, line integer, branch_id uuid, deal_id uuid, tr_id uuid, prev_at timestamptz, prev_hash text,
    source jsonb, hash text) on commit drop;
  truncate tally_export_work;
  insert into tally_export_work (kind, id, line, branch_id, deal_id, tr_id, prev_at, prev_hash)
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
  select count(*)::int into v_count from tally_export_work;
  if v_count > 10000 then
    raise exception 'export_too_large' using errcode = '22023', hint = 'from';
  end if;
  if v_count = 0 then
    raise exception 'nothing_to_export' using errcode = '55000';
  end if;
  perform 1 from public.tally_records r where r.id in (select w.tr_id from tally_export_work w where w.tr_id is not null)
  order by r.id for update;

  -- Source values and hashes: one pass per kind.
  update tally_export_work w set source = s.source, hash = authz.tally_hash(s.source, s.ids)
  from (select k.kind, x.record_id, x.source, x.ids
        from (select distinct w2.kind from tally_export_work w2) k
        cross join lateral authz.tally_source_set(k.kind, (select array_agg(w3.id) from tally_export_work w3 where w3.kind = k.kind)) x) s
  where s.kind = w.kind and s.record_id = w.id;
  select count(*)::int into v_already from tally_export_work w where w.prev_at is not null;

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
    from tally_export_work w where w.tr_id is null
    returning id, record_kind, record_id)
  update tally_export_work w set tr_id = ins.id from ins where ins.record_kind = w.kind and ins.record_id = w.id;
  -- Lines (snapshots, masked) with the previous export state.
  insert into public.tally_export_lines (export_id, line_no, legal_entity_id, record_kind, record_id, tally_record_id, "values",
    source_hash, previously_exported_at)
  select v_export.id, w.line, v_entity, w.kind, w.id, w.tr_id,
    authz.tally_line_values(w.source, v_export.export_no, w.line, w.prev_at, w.prev_hash is not null and w.prev_hash <> w.hash),
    w.hash, w.prev_at
  from tally_export_work w;
  -- Rows exported before (or back at ready).
  update public.tally_records r
  set status = 'exported', export_count = r.export_count + 1, last_export_id = v_export.id, last_exported_at = now(),
      last_export_hash = w.hash, row_version = r.row_version + 1, updated_at = now(), updated_by = (select auth.uid())
  from tally_export_work w
  where r.id = w.tr_id and r.last_export_id is distinct from v_export.id;

  perform authz.write_audit('accounts.tally_export_created', v_entity, null, 'tally_export', v_export.id, null,
    jsonb_build_object('exportId', v_export.id, 'rowCount', v_count, 'kinds', to_jsonb(v_kinds),
      'alreadyExportedCount', v_already, 'skippedCount', v_skipped));
  v_result := jsonb_build_object('outcome', 'created', 'exportId', v_export.id, 'exportNo', v_export.export_no,
    'rowCount', v_count, 'alreadyExportedCount', v_already, 'skippedCount', v_skipped);
  return authz.finance_remember(v_entity, p_request_id, 'accounts_tally_export_create', v_payload, v_result);
end;
$$;

-- Replaces 20261203000260: filters inside, task creation order, then limit (Addendum L1).
create or replace function public.supplier_document_link_targets(p_document_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_doc public.supplier_documents%rowtype;
  v_synthetic boolean;
  v_is_a boolean;
  v_uid uuid := (select auth.uid());
begin
  if p_document_id is null or not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v_doc from public.supplier_documents s where s.id = p_document_id;
  if v_doc.id is null or v_doc.status = 'returned' then
    return null;
  end if;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = v_doc.deal_id;
  v_is_a := authz.sm_accounts_sees(v_doc.legal_entity_id, v_synthetic);
  if not v_is_a and (v_doc.status <> 'uploaded'
     or not (authz.holds_active_role('purchase', v_doc.legal_entity_id) or authz.holds_active_role('flight', v_doc.legal_entity_id))) then
    return null;
  end if;
  return jsonb_build_object(
    'documentId', v_doc.id,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
          'taskId', c.id, 'dealId', c.deal_id, 'dealReference', c.reference, 'department', c.department,
          'serviceLabel', (select replace(initcap(i.service_type), '_', ' ') || ' ' || i.item_no::text
                           from public.service_items i where i.id = c.service_item_id),
          'alreadyLinked', exists (select 1 from public.supplier_document_tasks l
                                   where l.document_id = v_doc.id and l.task_id = c.id and l.unlinked_at is null))
        order by c.created_at, c.id)
      from (
        -- Accounts phase (20261203000300, Addendum L1): every filter here, then order, then limit.
        select t.id, t.deal_id, t.department, t.service_item_id, t.created_at, d.reference
        from public.fulfilment_tasks t
        join public.deals d on d.id = t.deal_id
        where t.legal_entity_id = v_doc.legal_entity_id and t.id <> v_doc.task_id
          and d.is_synthetic = v_synthetic
          and t.id in (select q.task_id from public.purchase_quotes q
                       where q.legal_entity_id = v_doc.legal_entity_id and q.supplier_id = v_doc.supplier_id
                       union
                       select b.cost_task_id from public.flight_ticket_batches b
                       where b.legal_entity_id = v_doc.legal_entity_id and b.supplier_id = v_doc.supplier_id)
          and (v_is_a or (t.assignee_user_id = v_uid
                          and ((t.department = 'purchase' and t.status in ('in_progress', 'supplier_confirmed', 'completed')
                                and authz.holds_active_role('purchase', t.legal_entity_id))
                               or (t.department = 'flight' and authz.flight_owns_task(t.id)))))
          and authz.sm_link_eligible(t.id, v_doc.supplier_id)
        order by t.created_at, t.id
        limit 200
      ) c), '[]'::jsonb),
    'links', case when v_is_a then coalesce((
      select jsonb_agg(jsonb_build_object('linkId', l.id, 'taskId', l.task_id, 'dealId', l.deal_id, 'dealReference', d.reference,
          'linkedAt', l.linked_at, 'linkedByName', p.display_name) order by l.linked_at, l.id)
      from public.supplier_document_tasks l
      join public.deals d on d.id = l.deal_id
      left join public.staff_profiles p on p.user_id = l.linked_by
      where l.document_id = v_doc.id and l.unlinked_at is null), '[]'::jsonb) else '[]'::jsonb end);
end;
$$;

-- ===========================================================================
-- 4. Source hash on ids (Addendum L1 review 9)
-- ===========================================================================

drop function authz.tally_source_set(text, uuid[]);
-- Replaces 20261203000280: + ids (branchId, dealId, supplierId) for the hash.
create function authz.tally_source_set(p_kind text, p_ids uuid[]) returns table (record_id uuid, source jsonb, ids jsonb)
language plpgsql stable security definer set search_path = '' as $$
begin
  if p_kind = 'journal_entry' then
    return query select e.id, jsonb_build_object(
      'recordType', case when e.kind in ('receipt_bank', 'receipt_cash') then 'Receipt'
                         when e.kind = 'deposit' then 'Cash deposit' else 'Receipt reversal' end,
      'voucherType', case when e.kind in ('receipt_bank', 'receipt_cash') then 'Receipt'
                          when e.kind = 'deposit' then 'Contra' else 'Journal' end,
      'date', to_char(e.business_date, 'YYYY-MM-DD'),
      'reference', r.receipt_no,
      'deal', d.reference,
      'bitrixDealId', d.source_deal_id::text,
      'branch', b.name,
      'party', r.payer_name,
      'debitLedger', (select authz.acct_ledger_word(l.account) from public.finance_journal_lines l
                      where l.entry_id = e.id and l.debit_paise > 0 order by l.id limit 1),
      'creditLedger', (select authz.acct_ledger_word(l.account) from public.finance_journal_lines l
                       where l.entry_id = e.id and l.credit_paise > 0 order by l.id limit 1),
      'amount', authz.acct_amount_text((select sum(l.debit_paise)::bigint from public.finance_journal_lines l where l.entry_id = e.id)),
      'mode', authz.acct_mode_word(case when e.kind = 'deposit' then 'cash' else r.mode end),
      'bankReference', coalesce(r.reference, r.cheque_number, dep.bank_reference),
      'pan', r.payer_pan,
      'mobile', r.payer_mobile,
      'gstIncluded', null, 'creditNoteFor', null, 'linkedTasks', null,
      'crmRecordId', e.id::text),
      jsonb_build_object('branchId', b.id, 'dealId', d.id, 'supplierId', null)
    from public.finance_journal_entries e
    left join public.customer_receipts r on r.id = e.receipt_id
    left join public.cash_deposits dep on dep.id = e.deposit_id
    left join public.deals d on d.id = e.deal_id
    join public.branches b on b.id = coalesce(d.branch_id, e.branch_id)
    where e.id in (select unnest(p_ids));
  elsif p_kind = 'supplier_payment' then
    return query select p.id, jsonb_build_object(
      'recordType', 'Supplier payment', 'voucherType', 'Payment',
      'date', to_char(p.paid_on, 'YYYY-MM-DD'),
      'reference', p.ref_no, 'deal', d.reference, 'bitrixDealId', d.source_deal_id::text, 'branch', b.name,
      'party', s.name, 'debitLedger', 'Supplier', 'creditLedger', 'Bank',
      'amount', authz.acct_amount_text(p.amount_paise),
      'mode', authz.acct_mode_word(p.payment_mode), 'bankReference', p.bank_reference,
      'pan', null, 'mobile', null, 'gstIncluded', null, 'creditNoteFor', null, 'linkedTasks', null,
      'crmRecordId', p.id::text),
      jsonb_build_object('branchId', b.id, 'dealId', d.id, 'supplierId', s.id)
    from public.supplier_payment_requests p
    join public.deals d on d.id = p.deal_id
    join public.branches b on b.id = d.branch_id
    join public.suppliers s on s.id = p.supplier_id
    where p.id in (select unnest(p_ids));
  elsif p_kind = 'supplier_document' then
    return query select x.id, jsonb_build_object(
      'recordType', case when x.kind = 'invoice' then 'Supplier invoice' else 'Supplier credit note' end,
      'voucherType', case when x.kind = 'invoice' then 'Purchase' else 'Debit note' end,
      'date', to_char(x.doc_date, 'YYYY-MM-DD'),
      'reference', x.number, 'deal', d.reference, 'bitrixDealId', d.source_deal_id::text, 'branch', b.name,
      'party', s.name,
      'debitLedger', case when x.kind = 'invoice'
                          then case when t.department = 'flight' then 'Expense – Flight' else 'Expense – other' end
                          else 'Supplier' end,
      'creditLedger', case when x.kind = 'invoice' then 'Supplier'
                           else case when t.department = 'flight' then 'Expense – Flight' else 'Expense – other' end end,
      'amount', authz.acct_amount_text(x.total_paise),
      'mode', null, 'bankReference', null, 'pan', null, 'mobile', null,
      'gstIncluded', case when x.gst_included then 'yes' else 'no' end,
      'creditNoteFor', (select c.number from public.supplier_documents c where c.id = x.credits_document_id),
      'linkedTasks', (select count(*)::text from public.supplier_document_tasks l
                      where l.document_id = x.id and l.unlinked_at is null),
      'crmRecordId', x.id::text),
      jsonb_build_object('branchId', b.id, 'dealId', d.id, 'supplierId', s.id)
    from public.supplier_documents x
    join public.deals d on d.id = x.deal_id
    join public.branches b on b.id = d.branch_id
    join public.suppliers s on s.id = x.supplier_id
    join public.fulfilment_tasks t on t.id = x.task_id
    where x.id in (select unnest(p_ids));
  elsif p_kind = 'expense' then
    return query select c.id, jsonb_build_object(
      'recordType', 'Expense', 'voucherType', 'Payment',
      'date', to_char(coalesce(c.paid_on, (timezone('Asia/Kolkata', c.created_at))::date), 'YYYY-MM-DD'),
      'reference', null, 'deal', d.reference, 'bitrixDealId', d.source_deal_id::text, 'branch', b.name,
      'party', s.name,
      'debitLedger', case c.department when 'visa' then 'Expense – Visa fees' when 'flight' then 'Expense – Flight'
                                       else 'Expense – other' end,
      'creditLedger', case when c.payment_mode = 'cash' then 'Cash in hand' else 'Bank' end,
      'amount', authz.acct_amount_text(c.amount_paise),
      'mode', authz.acct_mode_word(c.payment_mode), 'bankReference', c.reference,
      'pan', null, 'mobile', null, 'gstIncluded', null, 'creditNoteFor', null, 'linkedTasks', null,
      'crmRecordId', c.id::text),
      jsonb_build_object('branchId', b.id, 'dealId', d.id, 'supplierId', s.id)
    from public.department_cost_entries c
    join public.deals d on d.id = c.deal_id
    join public.branches b on b.id = d.branch_id
    left join public.suppliers s on s.id = c.supplier_id
    where c.id in (select unnest(p_ids));
  elsif p_kind = 'tally_gst_invoice' then
    return query select g.id, jsonb_build_object(
      'recordType', 'GST invoice reference', 'voucherType', 'Sales',
      'date', to_char(g.invoice_date, 'YYYY-MM-DD'),
      'reference', g.invoice_ref, 'deal', d.reference, 'bitrixDealId', d.source_deal_id::text, 'branch', b.name,
      'party', null, 'debitLedger', 'Customer advances', 'creditLedger', null, 'amount', null,
      'mode', null, 'bankReference', null, 'pan', null, 'mobile', null, 'gstIncluded', null,
      'creditNoteFor', null, 'linkedTasks', null, 'crmRecordId', g.id::text),
      jsonb_build_object('branchId', b.id, 'dealId', d.id, 'supplierId', null)
    from public.deal_tally_invoices g
    join public.deals d on d.id = g.deal_id
    join public.branches b on b.id = g.branch_id
    where g.id in (select unnest(p_ids));
  end if;
end;
$$;

-- The hash of a record's source: display names (branch, Deal reference,
-- supplier name as party) replaced by their ids.
create function authz.tally_hash(p_source jsonb, p_ids jsonb) returns text
language sql immutable set search_path = '' as $$
  select authz.finance_payload_hash(
    (p_source - array['branch', 'deal']
              - (case when p_ids ->> 'supplierId' is not null then array['party'] else array[]::text[] end))
    || coalesce(p_ids, '{}'::jsonb))
$$;

create or replace function authz.tally_source_json(p_kind text, p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select s.source from authz.tally_source_set(p_kind, array[p_id]) s limit 1
$$;

create or replace function authz.tally_source_hash(p_kind text, p_id uuid) returns text
language sql stable security definer set search_path = '' as $$
  select authz.tally_hash(s.source, s.ids) from authz.tally_source_set(p_kind, array[p_id]) s limit 1
$$;

-- Replaces 20261203000280: hash on ids.
create or replace function authz.tally_changed_ids(p_entities uuid[]) returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v uuid[] := array[]::uuid[];
  k text;
  v_ids uuid[];
begin
  foreach k in array array['journal_entry', 'supplier_payment', 'supplier_document', 'expense', 'tally_gst_invoice'] loop
    select array_agg(t.record_id) into v_ids from public.tally_records t
    where t.record_kind = k and t.legal_entity_id = any(p_entities) and t.last_export_hash is not null;
    continue when v_ids is null;
    v := v || coalesce((
      select array_agg(t.record_id)
      from public.tally_records t
      join authz.tally_source_set(k, v_ids) s on s.record_id = t.record_id
      where t.record_kind = k and t.last_export_hash is not null
        and t.last_export_hash <> authz.tally_hash(s.source, s.ids)), array[]::uuid[]);
  end loop;
  return v;
end;
$$;

-- Replaces 20261203000290: links per viewer, can.reopen per Addendum L1.
create or replace function authz.acct_row_json(p authz.acct_row) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_tr public.tally_records%rowtype;
  v_deal public.deals%rowtype;
  v_files jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_other jsonb := '[]'::jsonb;
  v_link jsonb;
  v_original jsonb;
  v_changed boolean := false;
  v_service text;
  v_can jsonb;
  v_tally_status text := p.tally_status;
begin
  if p.tally_kind is not null then
    select * into v_tr from public.tally_records t where t.record_kind = p.tally_kind and t.record_id = p.tally_id;
    if v_tr.id is not null and v_tr.last_export_hash is not null then
      v_changed := v_tr.last_export_hash <> coalesce(authz.tally_source_hash(v_tr.record_kind, v_tr.record_id), '');
    end if;
  end if;
  if p.deal_id is not null then
    select * into v_deal from public.deals d where d.id = p.deal_id;
  end if;
  if p.task_id is not null then
    select replace(initcap(i.service_type), '_', ' ') || ' ' || i.item_no::text into v_service
    from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
    where t.id = p.task_id;
  end if;

  -- Files: links only for A (existing Accounts download routes), counts for M.
  if p.kind = 'receipt' then
    select count(*)::int, coalesce(jsonb_agg(jsonb_build_object('kind', 'finance', 'evidenceId', e.id, 'fileName', e.file_name)
                                             order by e.seq), '[]'::jsonb)
    into v_count, v_files
    from public.finance_evidence e where e.receipt_id = p.record_id and e.status = 'stored';
  elsif p.kind = 'cash_deposit' then
    select count(*)::int, coalesce(jsonb_agg(jsonb_build_object('kind', 'finance', 'evidenceId', e.id, 'fileName', e.file_name)
                                             order by e.seq), '[]'::jsonb)
    into v_count, v_files
    from public.finance_evidence e where e.deposit_id = p.record_id and e.status = 'stored';
  elsif p.kind = 'supplier_payment' then
    select count(*)::int, coalesce(jsonb_agg(jsonb_build_object('kind', 'supplier_money', 'evidenceId', e.id, 'fileName', e.file_name)
                                             order by e.created_at), '[]'::jsonb)
    into v_count, v_files
    from public.supplier_payment_requests x
    join public.supplier_money_evidence e on e.id in (x.proforma_evidence_id, x.payment_proof_evidence_id)
    where x.id = p.record_id and e.status = 'stored';
  elsif p.kind in ('supplier_invoice', 'supplier_credit_note') then
    select count(*)::int, coalesce(jsonb_agg(jsonb_build_object('kind', 'supplier_money', 'evidenceId', e.id, 'fileName', e.file_name)), '[]'::jsonb)
    into v_count, v_files
    from public.supplier_documents x join public.supplier_money_evidence e on e.id = x.evidence_id
    where x.id = p.record_id and e.status = 'stored';
    select coalesce(jsonb_agg(c.number), '[]'::jsonb) into v_other
    from public.supplier_documents x join public.supplier_documents c on c.id = x.credits_document_id
    where x.id = p.record_id;
  elsif p.kind = 'expense' then
    select count(*)::int, coalesce(jsonb_agg(jsonb_build_object('kind', 'department', 'evidenceId', e.id, 'fileName', e.file_name)), '[]'::jsonb)
    into v_count, v_files
    from public.department_cost_entries x join public.department_evidence e on e.id = x.receipt_evidence_id
    where x.id = p.record_id and e.status = 'stored';
  elsif p.kind = 'flight_ticket_batch' then
    with t as (
      select tr.airline_pnr, tr.crs_pnr, tr.ticket_number
      from public.flight_ticket_revisions tr where tr.batch_id = p.record_id)
    select coalesce((select jsonb_agg(x.v order by x.v) from (
             select distinct airline_pnr as v from t union select distinct crs_pnr from t where crs_pnr is not null) x), '[]'::jsonb)
        || coalesce((select jsonb_build_array(case when min(ticket_number) = max(ticket_number) then min(ticket_number)
                                                  else min(ticket_number) || ' – ' || max(ticket_number) end)
                     from t having count(*) > 0), '[]'::jsonb)
    into v_other;
  elsif p.kind = 'company_funding' then
    v_other := '[]'::jsonb;
  end if;
  if not p.is_a then
    v_files := '[]'::jsonb;
  end if;

  -- Accounts phase (20261203000300): a screen the viewer can open.
  if not p.is_a then
    -- Branch Manager: the Deal page dues card, or nothing.
    v_link := case when p.deal_id is not null then jsonb_build_object('kind', 'deal_dues', 'id', p.deal_id)
                   else jsonb_build_object('kind', 'none', 'id', null) end;
  else
    v_link := case p.kind
      when 'claim' then jsonb_build_object('kind', 'claim', 'id', p.record_id)
      when 'cash_deposit' then jsonb_build_object('kind', 'cash', 'id', p.record_id)
      when 'cash_count' then jsonb_build_object('kind', 'cash', 'id', p.record_id)
      when 'supplier_payment' then jsonb_build_object('kind', 'supplier_payment', 'id', p.record_id)
      when 'company_funding' then jsonb_build_object('kind', 'supplier_payment',
        'id', (select f.payment_request_id from public.company_funding_requests f where f.id = p.record_id))
      when 'supplier_invoice' then jsonb_build_object('kind', 'supplier_document', 'id', p.record_id)
      when 'supplier_credit_note' then jsonb_build_object('kind', 'supplier_document', 'id', p.record_id)
      when 'expense' then jsonb_build_object('kind', 'expense', 'id', p.record_id)
      else case when p.deal_id is not null then jsonb_build_object('kind', 'accounts_deal', 'id', p.deal_id)
                else jsonb_build_object('kind', 'none', 'id', null) end
    end;
  end if;
  v_link := v_link || jsonb_build_object('dealId', p.deal_id,
    'ref', case when p.kind = 'original' then null else p.reference end);

  if p.kind = 'original' then
    v_original := jsonb_build_object('what', p.orig_what, 'state', p.orig_state, 'since', to_char(p.orig_since, 'YYYY-MM-DD'),
      'ownerRole', p.owner_role, 'ownerName', (select s.display_name from public.staff_profiles s where s.user_id = p.owner_user));
  end if;

  v_can := jsonb_build_object(
    'match', p.is_a and p.tally_kind is not null and v_tally_status in ('ready', 'exported'),
    'exception', p.is_a and p.tally_kind is not null and v_tally_status in ('ready', 'exported', 'matched'),
    -- Accounts phase (20261203000300): exactly where T3 succeeds (Addendum L1).
    'reopen', p.is_a and p.tally_kind is not null and v_tr.id is not null
              and (v_tally_status = 'exception' or (v_tally_status = 'matched' and p.tally_kind <> 'tally_gst_invoice')),
    'linkTask', p.is_a and p.kind in ('supplier_invoice', 'supplier_credit_note') and p.status_code <> 'returned');

  return jsonb_build_object(
    'rowId', p.kind || ':' || p.record_id::text,
    'kind', p.kind,
    'recordId', p.record_id,
    'recordDate', to_char(p.rd, 'YYYY-MM-DD'),
    'createdAt', p.ca,
    -- Accounts phase (20261203000290): an original's reference is filled here, for page rows only.
    'reference', case when p.kind <> 'original' then p.reference
                      when p.orig_what = 'bank_proof' then (select r.receipt_no from public.customer_receipts r where r.id = p.record_id)
                      else v_deal.reference end,
    'otherReferences', v_other,
    'dealId', p.deal_id,
    'dealReference', v_deal.reference,
    'bitrixDealId', v_deal.source_deal_id::text,
    'branchName', (select b.name from public.branches b where b.id = p.branch_id),
    'collectingBranchName', case when p.kind in ('receipt', 'receipt_reversal')
      then (select b.name from public.branches b where b.id = p.coll_branch_id) end,
    'department', p.department,
    'taskId', p.task_id,
    'serviceLabel', v_service,
    'supplierId', p.supplier_id,
    'supplierName', (select s.name from public.suppliers s where s.id = p.supplier_id),
    'amountPaise', p.amount::text,
    'direction', p.direction,
    'statusCode', p.status_code,
    'stage', p.stage,
    'reviewStatus', p.review,
    'tally', jsonb_build_object(
      'status', v_tally_status,
      'rowVersion', coalesce(v_tr.row_version, 0),
      'recordKind', p.tally_kind,
      'recordId', p.tally_id,
      'changedSinceExport', v_changed,
      'lastExportedAt', v_tr.last_exported_at,
      'exportCount', coalesce(v_tr.export_count, 0),
      'voucherRef', case when p.is_a then v_tr.voucher_ref end,
      'voucherDate', case when p.is_a then to_char(v_tr.voucher_date, 'YYYY-MM-DD') end,
      'exceptionReason', case when p.is_a then v_tr.exception_reason end),
    'files', jsonb_build_object('count', v_count, 'links', v_files),
    'original', v_original,
    'link', v_link,
    'can', v_can);
end;
$$;

-- Replaces 20261203000290: + filter key overdueCheck.
create or replace function authz.acct_rows(p_filter jsonb, p_a uuid[], p_m uuid[], p_syn boolean, p_after text, p_limit integer)
returns setof authz.acct_row
language plpgsql stable security definer set search_path = '' as $$
declare
  c_kinds constant text[] := array['receipt', 'receipt_reversal', 'claim', 'cash_deposit', 'cash_count', 'supplier_payment',
    'company_funding', 'supplier_invoice', 'supplier_credit_note', 'expense', 'flight_ticket_batch', 'visa_application',
    'tally_gst_invoice', 'original'];
  c_min constant uuid := '00000000-0000-0000-0000-000000000000';
  c_max constant uuid := 'ffffffff-ffff-ffff-ffff-ffffffffffff';
  v_f jsonb := coalesce(p_filter, '{}'::jsonb);
  v_entities uuid[];
  v_kinds text[];
  v_from date; v_to date; v_dep text; v_sup uuid; v_stage text; v_review text; v_tally text; v_changed boolean;
  v_amin bigint; v_amax bigint; v_branch uuid; v_deals uuid[]; v_orig text;
  v_ad date; v_ac timestamptz; v_ak text; v_ai uuid;
  v_q text; v_qn text; v_digits text;
  q_receipts uuid[]; q_payments uuid[]; q_batches uuid[]; q_docs uuid[]; q_visa uuid[]; q_gst uuid[]; q_deals uuid[];
  v_search boolean := false;
  v_today date := authz.finance_today();
  v_pred text := '';
  v_sql text := '';
  v_parts text[] := array[]::text[];
  v_branch_sql text;
  k text;
  v_lim integer := case when p_limit is null then null else p_limit + 1 end;
  v_changed_ids uuid[] := array[]::uuid[];  -- Accounts phase (20261203000280)
  v_orig_deals uuid[];
  v_check text;  -- Accounts phase (20261203000300): daily check selections  -- Accounts phase (20261203000290): originals of these Deals only (search / dealReference)
begin
  if jsonb_typeof(v_f) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'filter';
  end if;
  if (v_f - array['from', 'to', 'kinds', 'department', 'dealReference', 'supplierId', 'stage', 'reviewStatus', 'tallyStatus',
                  'changedSinceExport', 'originals', 'amountMin', 'amountMax', 'branchId', 'q',
                  'overdueCheck']) <> '{}'::jsonb then  -- Accounts phase (20261203000300)
    raise exception 'invalid_input' using errcode = '22023', hint = 'filter';
  end if;
  select coalesce(array_agg(distinct x), array[]::uuid[]) into v_entities
  from (select unnest(p_a) as x union select b.legal_entity_id from public.branches b where b.id = any(p_m)) s;

  -- ---- parse ----
  begin
    v_from := authz.finance_date(authz.finance_field(v_f, 'from'));
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'from'; end;
  begin
    v_to := authz.finance_date(authz.finance_field(v_f, 'to'));
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'to'; end;
  if v_from is not null and v_to is not null and v_from > v_to then
    raise exception 'invalid_input' using errcode = '22023', hint = 'to';
  end if;
  if v_f ? 'kinds' and jsonb_typeof(v_f -> 'kinds') <> 'null' then
    if jsonb_typeof(v_f -> 'kinds') <> 'array' or jsonb_array_length(v_f -> 'kinds') = 0
       or exists (select 1 from jsonb_array_elements(v_f -> 'kinds') e
                  where jsonb_typeof(e) <> 'string' or not ((e #>> '{}') = any(c_kinds))) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'kinds';
    end if;
    select array_agg(distinct e) into v_kinds from jsonb_array_elements_text(v_f -> 'kinds') e;
  end if;
  begin
    v_dep := authz.finance_field(v_f, 'department');
    v_stage := authz.finance_field(v_f, 'stage');
    v_review := authz.finance_field(v_f, 'reviewStatus');
    v_tally := authz.finance_field(v_f, 'tallyStatus');
    v_orig := authz.finance_field(v_f, 'originals');
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'filter'; end;
  if v_dep is not null and v_dep not in ('sales', 'accounts', 'purchase', 'flight', 'visa') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'department';
  end if;
  if v_stage is not null and v_stage not in ('open', 'done', 'returned', 'cancelled') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'stage';
  end if;
  if v_review is not null and v_review not in ('waiting', 'done', 'returned', 'not_needed') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reviewStatus';
  end if;
  if v_tally is not null and v_tally not in ('not_ready', 'ready', 'exported', 'matched', 'exception', 'not_applicable') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'tallyStatus';
  end if;
  if v_orig is not null and v_orig not in ('missing', 'expected', 'any') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'originals';
  end if;
  if v_f ? 'changedSinceExport' and jsonb_typeof(v_f -> 'changedSinceExport') <> 'null' then
    if jsonb_typeof(v_f -> 'changedSinceExport') <> 'boolean' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'changedSinceExport';
    end if;
    v_changed := (v_f ->> 'changedSinceExport')::boolean;
  end if;
  begin
    v_amin := authz.finance_paise(v_f, 'amountMin', 0);
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'amountMin'; end;
  begin
    v_amax := authz.finance_paise(v_f, 'amountMax', 0);
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'amountMax'; end;
  if v_amin is not null and v_amax is not null and v_amin > v_amax then
    raise exception 'invalid_input' using errcode = '22023', hint = 'amountMax';
  end if;
  begin
    v_sup := authz.finance_uuid(authz.finance_field(v_f, 'supplierId'));
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'supplierId'; end;
  begin
    v_branch := authz.finance_uuid(authz.finance_field(v_f, 'branchId'));
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'branchId'; end;
  if v_branch is not null and not (v_branch = any(p_m))
     and not exists (select 1 from public.branches b where b.id = v_branch and b.legal_entity_id = any(p_a)) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'branchId';
  end if;
  begin
    v_q := authz.finance_text(authz.finance_field(v_f, 'q'), 1, 60, false);
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'q'; end;
  if authz.finance_field(v_f, 'dealReference') is not null then
    select coalesce(array_agg(d.id), array[]::uuid[]) into v_deals from public.deals d
    where d.legal_entity_id = any(v_entities)
      and d.reference = btrim(authz.finance_field(v_f, 'dealReference'), E' \t\r\n');
  end if;

  -- ---- cursor ----
  if p_after is not null then
    if p_after !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}\|[^|]+\|[a-z_]+\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not (split_part(p_after, '|', 3) = any(c_kinds)) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end if;
    begin
      v_ad := split_part(p_after, '|', 1)::date;
      v_ac := split_part(p_after, '|', 2)::timestamptz;
    exception when others then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end;
    v_ak := split_part(p_after, '|', 3);
    v_ai := split_part(p_after, '|', 4)::uuid;
  end if;

  -- ---- exact search (ignores every other filter except branchId) ----
  if v_q is not null then
    v_search := true;
    v_kinds := null; v_from := null; v_to := null; v_dep := null; v_sup := null; v_stage := null; v_review := null;
    v_tally := null; v_changed := null; v_amin := null; v_amax := null; v_deals := null; v_orig := null;
    v_q := upper(v_q);
    v_qn := authz.sm_number_norm(v_q);
    if v_q ~ '^R-' then
      select coalesce(array_agg(r.id), array[]::uuid[]) into q_receipts from public.customer_receipts r
      where r.legal_entity_id = any(v_entities) and r.receipt_no = v_q;
    end if;
    if v_q ~ '^SP-' then
      select coalesce(array_agg(p.id), array[]::uuid[]) into q_payments from public.supplier_payment_requests p
      where p.legal_entity_id = any(v_entities) and p.ref_no = v_q;
    end if;
    select coalesce(array_agg(d.id), array[]::uuid[]) into q_deals from public.deals d
    where d.legal_entity_id = any(v_entities) and (d.reference = v_q or upper(d.reference) = v_q);
    v_digits := replace(v_q, '-', '');
    if v_q ~ '^[0-9][0-9-]{4,22}[0-9]$' and v_digits ~ '^[0-9]{6,20}$' then
      select coalesce(array_agg(distinct tr.batch_id), array[]::uuid[]) into q_batches
      from public.flight_ticket_numbers n
      join public.flight_ticket_revisions tr on tr.deal_id = n.deal_id and tr.ticket_digits = n.ticket_digits
      where n.legal_entity_id = any(v_entities) and n.ticket_digits = v_digits;
    end if;
    if v_q ~ '^[A-Z0-9]{5,8}$' then
      select coalesce(q_batches, array[]::uuid[]) || coalesce(array_agg(distinct tr.batch_id), array[]::uuid[]) into q_batches
      from public.flight_ticket_revisions tr
      where tr.legal_entity_id = any(v_entities) and (tr.airline_pnr = v_q or tr.crs_pnr = v_q);
    end if;
    if v_qn <> '' then
      select coalesce(array_agg(x.id), array[]::uuid[]) into q_docs from public.supplier_documents x
      where x.legal_entity_id = any(v_entities) and x.number_norm = v_qn;
      select coalesce(array_agg(g.id), array[]::uuid[]) into q_gst from public.deal_tally_invoices g
      where g.legal_entity_id = any(v_entities) and g.ref_norm = v_qn;
    end if;
    select coalesce(array_agg(a.id), array[]::uuid[]) into q_visa from public.visa_applications a
    where a.legal_entity_id = any(v_entities) and a.reference is not null and lower(a.reference) = lower(v_q);
    q_receipts := coalesce(q_receipts, array[]::uuid[]);
    q_payments := coalesce(q_payments, array[]::uuid[]);
    q_batches := coalesce(q_batches, array[]::uuid[]);
  end if;
  if v_orig is not null then
    v_kinds := array['original'];
  end if;
  -- Accounts phase (20261203000300): the rows a daily check count counts.
  begin
    v_check := authz.finance_field(v_f, 'overdueCheck');
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'overdueCheck'; end;
  if v_check is not null and v_check not in ('receipts_unverified', 'payments_unrecorded') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'overdueCheck';
  end if;
  if v_check is not null and not v_search then
    v_kinds := array[case v_check when 'receipts_unverified' then 'receipt' else 'supplier_payment' end];
  end if;
  -- Accounts phase (20261203000290): the originals list is computed for these Deals only.
  if v_search then
    select coalesce(array_agg(distinct x), array[]::uuid[]) into v_orig_deals
    from (select unnest(q_deals) as x union select r.deal_id from public.customer_receipts r where r.id = any(q_receipts)) z;
  elsif v_deals is not null then
    v_orig_deals := v_deals;
  end if;

  -- ---- common predicate on the standard columns (alias s) ----
  if v_from is not null then v_pred := v_pred || ' and s.rd >= $4'; end if;
  if v_to is not null then v_pred := v_pred || ' and s.rd <= $5'; end if;
  if v_dep is not null then v_pred := v_pred || ' and s.department = $6'; end if;
  if v_sup is not null then v_pred := v_pred || ' and s.supplier_id = $7'; end if;
  if v_stage is not null then v_pred := v_pred || ' and s.stage = $8'; end if;
  if v_review is not null then v_pred := v_pred || ' and s.review = $9'; end if;
  if v_tally is not null then v_pred := v_pred || ' and s.tally_status = $10'; end if;
  if v_changed is not null then
    -- Accounts phase (20261203000280): one set-based hash pass over the exported rows, not one per scanned row.
    v_changed_ids := authz.tally_changed_ids(v_entities);
    v_pred := v_pred || ' and (s.tally_id is not null and s.tally_id = any($33)) = $11';
  end if;
  if v_amin is not null then v_pred := v_pred || ' and s.amount >= $12'; end if;
  if v_amax is not null then v_pred := v_pred || ' and s.amount <= $13'; end if;
  if v_branch is not null then v_pred := v_pred || ' and (s.branch_id = $14 or s.coll_branch_id = $14)'; end if;
  if v_deals is not null then v_pred := v_pred || ' and s.deal_id = any($15)'; end if;
  if v_orig is not null and v_orig <> 'any' then v_pred := v_pred || ' and s.orig_state = $16'; end if;
  if p_after is not null then
    v_pred := v_pred || ' and (s.rd, s.ca, s.record_id) < ($17, $18, case when s.kind > $19 then $31 when s.kind = $19 then $20 else $32 end)';
  end if;

  -- ---- branches ----
  foreach k in array c_kinds loop
    continue when v_kinds is not null and not (k = any(v_kinds));
    v_branch_sql := case k
    when 'receipt' then $q$
      select 'receipt'::text as kind, r.id as record_id, r.received_on as rd, r.recorded_at as ca, r.legal_entity_id as entity,
        d.branch_id, r.branch_id as coll_branch_id, r.deal_id, 'accounts'::text as department, null::uuid as task_id,
        null::uuid as supplier_id, r.amount_paise as amount, 'in'::text as direction, r.status as status_code,
        case when r.status in ('recorded', 'pending_clearance', 'bounced') then 'open' when r.status in ('verified', 'cleared') then 'done'
             when r.status = 'rejected' then 'returned' else 'cancelled' end as stage,
        case when r.status in ('recorded', 'pending_clearance', 'bounced') then 'waiting' when r.status in ('verified', 'cleared') then 'done'
             when r.status = 'rejected' then 'returned' else 'not_needed' end as review,
        r.receipt_no as reference,
        case when je.id is null then null else 'journal_entry' end as tally_kind, je.id as tally_id,
        case when je.id is not null then coalesce(tr.status, 'ready')
             when r.status in ('recorded', 'pending_clearance', 'bounced') then 'not_ready' else 'not_applicable' end as tally_status,
        null::text as orig_what, null::text as orig_state, null::date as orig_since, null::text as owner_role, null::uuid as owner_user,
        r.legal_entity_id = any($1) as is_a
      from public.customer_receipts r
      join public.deals d on d.id = r.deal_id
      left join public.finance_journal_entries je on je.receipt_id = r.id and je.kind in ('receipt_bank', 'receipt_cash')
      left join public.tally_records tr on tr.record_kind = 'journal_entry' and tr.record_id = je.id
      where r.legal_entity_id = any($30) and d.is_synthetic = $3
        and (r.legal_entity_id = any($1) or d.branch_id = any($2) or r.branch_id = any($2))$q$
      || case when v_search then ' and (r.id = any($22) or r.deal_id = any($28))' else '' end
    when 'receipt_reversal' then $q$
      select 'receipt_reversal'::text, e.id, e.business_date, e.posted_at, e.legal_entity_id,
        d.branch_id, e.branch_id, e.deal_id, 'accounts'::text, null::uuid, null::uuid,
        (select sum(l.debit_paise)::bigint from public.finance_journal_lines l where l.entry_id = e.id), 'out'::text, e.kind,
        'done'::text, 'not_needed'::text, r.receipt_no,
        'journal_entry'::text, e.id, coalesce(tr.status, 'ready'),
        null::text, null::text, null::date, null::text, null::uuid, e.legal_entity_id = any($1)
      from public.finance_journal_entries e
      join public.customer_receipts r on r.id = e.receipt_id
      join public.deals d on d.id = e.deal_id
      left join public.tally_records tr on tr.record_kind = 'journal_entry' and tr.record_id = e.id
      where e.kind like 'reversal%' and e.legal_entity_id = any($30) and d.is_synthetic = $3
        and (e.legal_entity_id = any($1) or d.branch_id = any($2) or e.branch_id = any($2))$q$
      || case when v_search then ' and (e.receipt_id = any($22) or e.deal_id = any($28))' else '' end
    when 'claim' then $q$
      select 'claim'::text, c.id, c.paid_on, c.reported_at, c.legal_entity_id,
        d.branch_id, null::uuid, c.deal_id, 'sales'::text, null::uuid, null::uuid, c.amount_paise, 'info'::text, c.status,
        case c.status when 'reported' then 'open' when 'linked' then 'done' when 'not_received' then 'returned' else 'cancelled' end,
        case c.status when 'reported' then 'waiting' when 'linked' then 'done' when 'not_received' then 'returned' else 'not_needed' end,
        null::text, null::text, null::uuid, 'not_applicable'::text,
        null::text, null::text, null::date, null::text, null::uuid, c.legal_entity_id = any($1)
      from public.customer_payment_claims c
      join public.deals d on d.id = c.deal_id
      where c.legal_entity_id = any($30) and d.is_synthetic = $3
        and (c.legal_entity_id = any($1) or d.branch_id = any($2))$q$
      || case when v_search then ' and c.deal_id = any($28)' else '' end
    when 'cash_deposit' then $q$
      select 'cash_deposit'::text, x.id, x.deposited_on, x.recorded_at, x.legal_entity_id,
        x.branch_id, null::uuid, null::uuid, 'accounts'::text, null::uuid, null::uuid, x.total_paise, 'contra'::text, x.status,
        case x.status when 'recorded' then 'open' when 'verified' then 'done' else 'returned' end,
        case x.status when 'recorded' then 'waiting' when 'verified' then 'done' else 'returned' end,
        x.bank_reference,
        case when je.id is null then null else 'journal_entry' end, je.id,
        case when je.id is not null then coalesce(tr.status, 'ready') when x.status = 'recorded' then 'not_ready' else 'not_applicable' end,
        null::text, null::text, null::date, null::text, null::uuid, x.legal_entity_id = any($1)
      from public.cash_deposits x
      left join public.finance_journal_entries je on je.deposit_id = x.id and je.kind = 'deposit'
      left join public.tally_records tr on tr.record_kind = 'journal_entry' and tr.record_id = je.id
      where x.legal_entity_id = any($30)
        and (x.legal_entity_id = any($1) or x.branch_id = any($2))$q$
      || case when v_search then ' and false' else '' end
    when 'cash_count' then $q$
      select 'cash_count'::text, x.id, x.business_date, x.recorded_at, x.legal_entity_id,
        x.branch_id, null::uuid, null::uuid, 'accounts'::text, null::uuid, null::uuid, x.counted_paise, 'info'::text, x.status,
        case x.status when 'recorded' then 'open' else 'done' end,
        case x.status when 'recorded' then 'waiting' else 'done' end,
        null::text, null::text, null::uuid, 'not_applicable'::text,
        null::text, null::text, null::date, null::text, null::uuid, x.legal_entity_id = any($1)
      from public.cash_reconciliations x
      where x.legal_entity_id = any($30)
        and (x.legal_entity_id = any($1) or x.branch_id = any($2))$q$
      || case when v_search then ' and false' else '' end
    when 'supplier_payment' then $q$
      select 'supplier_payment'::text, p.id, (timezone('Asia/Kolkata', p.requested_at))::date, p.requested_at, p.legal_entity_id,
        d.branch_id, null::uuid, p.deal_id, t.department, p.task_id, p.supplier_id, p.amount_paise, 'out'::text, p.status,
        case when p.status in ('pending', 'approved', 'paid') then 'open' when p.status = 'verified' then 'done'
             when p.status = 'returned' then 'returned' else 'cancelled' end,
        case when p.status in ('pending', 'approved', 'paid') then 'waiting' when p.status = 'verified' then 'done'
             when p.status = 'returned' then 'returned' else 'not_needed' end,
        p.ref_no, 'supplier_payment'::text, p.id,
        case when p.status in ('returned', 'cancelled') then 'not_applicable'
             else coalesce(tr.status, case when p.status = 'verified' then 'ready' else 'not_ready' end) end,
        null::text, null::text, null::date, null::text, null::uuid, p.legal_entity_id = any($1)
      from public.supplier_payment_requests p
      join public.deals d on d.id = p.deal_id
      join public.fulfilment_tasks t on t.id = p.task_id
      left join public.tally_records tr on tr.record_kind = 'supplier_payment' and tr.record_id = p.id
      where p.legal_entity_id = any($30) and d.is_synthetic = $3
        and (p.legal_entity_id = any($1) or d.branch_id = any($2))$q$
      || case when v_search then ' and (p.id = any($23) or p.deal_id = any($28))' else '' end
    when 'company_funding' then $q$
      select 'company_funding'::text, f.id, (timezone('Asia/Kolkata', f.requested_at))::date, f.requested_at, f.legal_entity_id,
        d.branch_id, null::uuid, f.deal_id, t.department, p.task_id, p.supplier_id, f.amount_paise, 'info'::text, f.status,
        case f.status when 'pending' then 'open' when 'approved' then 'open' when 'recovered' then 'done' else 'returned' end,
        case f.status when 'pending' then 'waiting' when 'returned' then 'returned' else 'done' end,
        p.ref_no, null::text, null::uuid, 'not_applicable'::text,
        null::text, null::text, null::date, null::text, null::uuid, f.legal_entity_id = any($1)
      from public.company_funding_requests f
      join public.supplier_payment_requests p on p.id = f.payment_request_id
      join public.deals d on d.id = f.deal_id
      join public.fulfilment_tasks t on t.id = p.task_id
      where f.legal_entity_id = any($30) and d.is_synthetic = $3
        and (f.legal_entity_id = any($1) or d.branch_id = any($2))$q$
      || case when v_search then ' and (f.payment_request_id = any($23) or f.deal_id = any($28))' else '' end
    when 'supplier_invoice' then $q$
      select 'supplier_invoice'::text, x.id, x.doc_date, x.uploaded_at, x.legal_entity_id,
        d.branch_id, null::uuid, x.deal_id, t.department, x.task_id, x.supplier_id, x.total_paise, 'bill'::text, x.status,
        case x.status when 'uploaded' then 'open' when 'accepted' then 'done' else 'returned' end,
        case x.status when 'uploaded' then 'waiting' when 'accepted' then 'done' else 'returned' end,
        x.number, 'supplier_document'::text, x.id,
        case when x.status = 'returned' then 'not_applicable'
             else coalesce(tr.status, case when x.status = 'accepted' then 'ready' else 'not_ready' end) end,
        null::text, null::text, null::date, null::text, null::uuid, x.legal_entity_id = any($1)
      from public.supplier_documents x
      join public.deals d on d.id = x.deal_id
      join public.fulfilment_tasks t on t.id = x.task_id
      left join public.tally_records tr on tr.record_kind = 'supplier_document' and tr.record_id = x.id
      where x.kind = 'invoice' and x.legal_entity_id = any($30) and d.is_synthetic = $3
        and (x.legal_entity_id = any($1) or d.branch_id = any($2))$q$
      || case when v_search then ' and (x.id = any($25) or x.deal_id = any($28))' else '' end
    when 'supplier_credit_note' then $q$
      select 'supplier_credit_note'::text, x.id, x.doc_date, x.uploaded_at, x.legal_entity_id,
        d.branch_id, null::uuid, x.deal_id, t.department, x.task_id, x.supplier_id, x.total_paise, 'credit'::text, x.status,
        case x.status when 'uploaded' then 'open' when 'accepted' then 'done' else 'returned' end,
        case x.status when 'uploaded' then 'waiting' when 'accepted' then 'done' else 'returned' end,
        x.number, 'supplier_document'::text, x.id,
        case when x.status = 'returned' then 'not_applicable'
             else coalesce(tr.status, case when x.status = 'accepted' then 'ready' else 'not_ready' end) end,
        null::text, null::text, null::date, null::text, null::uuid, x.legal_entity_id = any($1)
      from public.supplier_documents x
      join public.deals d on d.id = x.deal_id
      join public.fulfilment_tasks t on t.id = x.task_id
      left join public.tally_records tr on tr.record_kind = 'supplier_document' and tr.record_id = x.id
      where x.kind = 'credit_note' and x.legal_entity_id = any($30) and d.is_synthetic = $3
        and (x.legal_entity_id = any($1) or d.branch_id = any($2))$q$
      || case when v_search then ' and (x.id = any($25) or x.deal_id = any($28))' else '' end
    when 'expense' then $q$
      select 'expense'::text, c.id, coalesce(c.paid_on, (timezone('Asia/Kolkata', c.created_at))::date), c.created_at, c.legal_entity_id,
        d.branch_id, null::uuid, c.deal_id, c.department, c.task_id, c.supplier_id, c.amount_paise, 'out'::text, c.expense_status,
        case c.expense_status when 'accepted' then 'done' when 'returned' then 'returned' else 'open' end,
        case c.expense_status when 'submitted' then 'waiting' when 'accepted' then 'done' when 'returned' then 'returned' else 'not_needed' end,
        c.reference, 'expense'::text, c.id,
        coalesce(tr.status, case when c.expense_status = 'accepted' then 'ready' else 'not_ready' end),
        null::text, null::text, null::date, null::text, null::uuid, c.legal_entity_id = any($1)
      from public.department_cost_entries c
      join public.deals d on d.id = c.deal_id
      left join public.tally_records tr on tr.record_kind = 'expense' and tr.record_id = c.id
      where c.paid_by = 'company' and c.legal_entity_id = any($30) and d.is_synthetic = $3
        and not (c.department = 'visa' and c.expense_status = 'draft' and c.receipt_evidence_id is null)
        and (c.legal_entity_id = any($1) or d.branch_id = any($2))$q$
      || case when v_search then ' and c.deal_id = any($28)' else '' end
    when 'flight_ticket_batch' then $q$
      select 'flight_ticket_batch'::text, b.id, (timezone('Asia/Kolkata', b.confirmed_at))::date, b.confirmed_at, b.legal_entity_id,
        d.branch_id, null::uuid, b.deal_id, 'flight'::text, b.cost_task_id, b.supplier_id, b.supplier_cost_paise, 'info'::text,
        'confirmed'::text, 'done'::text, 'not_needed'::text,
        d.reference || ' batch ' || b.batch_no::text, null::text, null::uuid, 'not_applicable'::text,
        null::text, null::text, null::date, null::text, null::uuid, b.legal_entity_id = any($1)
      from public.flight_ticket_batches b
      join public.deals d on d.id = b.deal_id
      where b.legal_entity_id = any($30) and d.is_synthetic = $3
        and (b.legal_entity_id = any($1) or d.branch_id = any($2))$q$
      || case when v_search then ' and (b.id = any($24) or b.deal_id = any($28))' else '' end
    when 'visa_application' then $q$
      select 'visa_application'::text, a.id, coalesce(a.applied_on, (timezone('Asia/Kolkata', a.submitted_at))::date), a.submitted_at,
        a.legal_entity_id, d.branch_id, null::uuid, a.deal_id, 'visa'::text, a.task_id, null::uuid, null::bigint, 'info'::text, a.state,
        case when a.state in ('issued', 'refused') then 'done' when a.state = 'withdrawn' then 'cancelled' else 'open' end,
        'not_needed'::text, a.reference, null::text, null::uuid, 'not_applicable'::text,
        null::text, null::text, null::date, null::text, null::uuid, a.legal_entity_id = any($1)
      from public.visa_applications a
      join public.deals d on d.id = a.deal_id
      where a.submitted_at is not null and a.legal_entity_id = any($30) and d.is_synthetic = $3
        and (a.legal_entity_id = any($1) or d.branch_id = any($2))$q$
      || case when v_search then ' and (a.id = any($26) or a.deal_id = any($28))' else '' end
    when 'tally_gst_invoice' then $q$
      select 'tally_gst_invoice'::text, g.id, g.invoice_date, g.created_at, g.legal_entity_id,
        g.branch_id, null::uuid, g.deal_id, 'accounts'::text, null::uuid, null::uuid, null::bigint, 'info'::text, g.status,
        case g.status when 'active' then 'done' else 'cancelled' end, 'not_needed'::text,
        g.invoice_ref, 'tally_gst_invoice'::text, g.id,
        case when g.status = 'withdrawn' then 'not_applicable' else coalesce(tr.status, 'matched') end,
        null::text, null::text, null::date, null::text, null::uuid, g.legal_entity_id = any($1)
      from public.deal_tally_invoices g
      join public.deals d on d.id = g.deal_id
      left join public.tally_records tr on tr.record_kind = 'tally_gst_invoice' and tr.record_id = g.id
      where g.legal_entity_id = any($30) and d.is_synthetic = $3
        and (g.legal_entity_id = any($1) or g.branch_id = any($2))$q$
      || case when v_search then ' and (g.id = any($27) or g.deal_id = any($28))' else '' end
    when 'original' then $q$
      select 'original'::text, o.record_id, o.since, (o.since::timestamp at time zone 'Asia/Kolkata'), e.id,
        o.branch_id, null::uuid, o.deal_id, o.department, o.task_id, o.supplier_id, null::bigint, 'info'::text, o.state,
        'open'::text, 'not_needed'::text,
        null::text,  -- Accounts phase (20261203000290): filled for the page rows only (acct_row_json)
        null::text, null::uuid, 'not_applicable'::text,
        o.what, o.state, o.since, o.owner_role, o.owner_user_id, e.id = any($1)
      from unnest($30) e(id)
      cross join lateral authz.acct_original_items(e.id, $35) o
      where o.is_synthetic = $3 and (e.id = any($1) or o.branch_id = any($2))$q$
      || case when v_search then ' and (o.deal_id = any($28) or (o.what = ''bank_proof'' and o.record_id = any($22)))' else '' end
    end;
    if v_check = 'receipts_unverified' and k = 'receipt' and not v_search then
      v_branch_sql := v_branch_sql || ' and r.status = ''recorded'''
        || ' and authz.finance_add_working_days((timezone(''Asia/Kolkata'', r.recorded_at))::date, 1) < $29';
    elsif v_check = 'payments_unrecorded' and k = 'supplier_payment' and not v_search then
      v_branch_sql := v_branch_sql || ' and p.status = ''approved'''
        || ' and authz.finance_add_working_days((timezone(''Asia/Kolkata'', p.approved_at))::date, 1) < $29';
    end if;
    -- Accounts phase (20261203000290): one entity -> plain equality, so the (entity, date desc, ...) order indexes apply.
    if cardinality(v_entities) = 1 then
      v_branch_sql := replace(v_branch_sql, ' = any($30)', ' = $34');
    end if;
    v_parts := v_parts || format('(select s.* from (%s) s(kind, record_id, rd, ca, entity, branch_id, coll_branch_id, deal_id,'
      || ' department, task_id, supplier_id, amount, direction, status_code, stage, review, reference, tally_kind, tally_id,'
      || ' tally_status, orig_what, orig_state, orig_since, owner_role, owner_user, is_a)'
      || ' where true%s order by s.rd desc, s.ca desc, s.record_id desc limit $21)', v_branch_sql, v_pred);
  end loop;

  if cardinality(v_parts) = 0 or cardinality(v_entities) = 0 or p_syn is null then
    return;
  end if;
  v_sql := 'select u.kind, u.record_id, u.rd, u.ca, u.entity, u.branch_id, u.coll_branch_id, u.deal_id, u.department, u.task_id,'
    || ' u.supplier_id, u.amount, u.direction, u.status_code, u.stage, u.review, u.reference, u.tally_kind, u.tally_id,'
    || ' u.tally_status, u.orig_what, u.orig_state, u.orig_since, u.owner_role, u.owner_user, u.is_a from ('
    || array_to_string(v_parts, ' union all ')
    || ') u order by u.rd desc, u.ca desc, u.kind asc, u.record_id desc limit $21';
  return query execute v_sql
    using p_a, p_m, p_syn, v_from, v_to, v_dep, v_sup, v_stage, v_review, v_tally, v_changed, v_amin, v_amax, v_branch,
          v_deals, v_orig, v_ad, v_ac, v_ak, v_ai, v_lim,
          q_receipts, q_payments, q_batches, q_docs, q_visa, q_gst, q_deals, v_today, v_entities, c_max, c_min, v_changed_ids, v_entities[1], v_orig_deals;
end;
$$;

-- Replaces 20261203000280: + filters.
create or replace function public.accounts_daily_check() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_a uuid[];
  v_syn boolean;
  v_today date := authz.finance_today();
  v_owner uuid;
  v_entity uuid;
  v_urgent jsonb := '[]'::jsonb;
  v_changed integer;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  v_a := authz.acct_a_entities();
  v_syn := authz.acct_synthetic();
  if cardinality(v_a) = 0 or v_syn is null then
    return null;
  end if;
  select e.id into v_entity from public.legal_entities e where e.id = any(v_a) order by e.legal_name, e.id limit 1;
  v_owner := authz.acct_exception_owner(v_entity);

  -- Accounts phase (20261203000280): set-based hash pass.
  v_changed := cardinality(authz.tally_changed_ids(v_a));

  -- Track C's notice table (20261203000400..0499) may not exist yet.
  if to_regclass('public.staff_notices') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object('branchName', g.name, 'count', g.n) order by g.name), '[]'::jsonb)
      from (select b.name, count(*)::int as n
            from public.staff_notices s join public.branches b on b.id = s.branch_id
            where s.legal_entity_id = any($1) and s.priority = 'urgent' and s.done_at is null and s.resolved_at is null
              and authz.finance_add_working_days((timezone('Asia/Kolkata', s.created_at))::date, 1) < $2
            group by b.name) g$q$
    into v_urgent using v_a, v_today;
  end if;

  return jsonb_build_object(
    'exceptionOwner', jsonb_build_object(
      'userId', v_owner,
      'name', (select p.display_name from public.staff_profiles p where p.user_id = v_owner),
      'isYou', v_owner is not null and v_owner = (select auth.uid()),
      'set', v_owner is not null),
    'exceptionsOpen', (select jsonb_build_object('count', count(*), 'oldestAt', min(t.exception_at))
                       from public.tally_records t where t.legal_entity_id = any(v_a) and t.status = 'exception'),
    'changedAfterExport', v_changed,
    'originalsMissing', (select count(*) from unnest(v_a) e(id) cross join lateral authz.acct_original_items(e.id) o
                         where o.state = 'missing' and o.is_synthetic = v_syn),
    'receiptsAwaitingVerificationOverOneWorkingDay', (
      select count(*) from public.customer_receipts r join public.deals d on d.id = r.deal_id
      where r.legal_entity_id = any(v_a) and d.is_synthetic = v_syn and r.status = 'recorded'
        and authz.finance_add_working_days((timezone('Asia/Kolkata', r.recorded_at))::date, 1) < v_today),
    'paymentsApprovedNotRecordedOverOneWorkingDay', (
      select count(*) from public.supplier_payment_requests p join public.deals d on d.id = p.deal_id
      where p.legal_entity_id = any(v_a) and d.is_synthetic = v_syn and p.status = 'approved'
        and authz.finance_add_working_days((timezone('Asia/Kolkata', p.approved_at))::date, 1) < v_today),
    'urgentNoticesUnopenedOverOneWorkingDay', v_urgent,
    -- Accounts phase (20261203000300): the workspace filter showing exactly each count's rows.
    'filters', jsonb_build_object(
      'exceptionsOpen', jsonb_build_object('tallyStatus', 'exception'),
      'changedAfterExport', jsonb_build_object('changedSinceExport', true),
      'originalsMissing', jsonb_build_object('originals', 'missing'),
      'receiptsAwaitingVerificationOverOneWorkingDay', jsonb_build_object('overdueCheck', 'receipts_unverified'),
      'paymentsApprovedNotRecordedOverOneWorkingDay', jsonb_build_object('overdueCheck', 'payments_unrecorded')));
end;
$$;

revoke all on function authz.tally_entity_lock(uuid, boolean), authz.tally_source_set(text, uuid[]),
  authz.tally_hash(jsonb, jsonb)
  from public, anon, authenticated, service_role;

commit;
