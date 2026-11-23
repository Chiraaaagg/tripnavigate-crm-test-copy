-- Accounts phase, Track B (10): workspace first-page speed (plan 17.3,
-- database <= 300 ms p95), measured on the speed seed (PGlite, indicative).
--
-- * authz.acct_original_items(p_entity, p_deals): new overload computing
--   originals only for the given Deals (null = all). The one-argument form
--   stays (daily check) and calls it with null. Same rows and rules as
--   20261203000270.
-- * authz.acct_rows (replaces 20261203000280): the originals branch passes
--   the Deals of an exact search or a dealReference filter; an original's
--   reference is no longer looked up for every candidate (filled for page
--   rows in acct_row_json); with one readable entity the branches use plain
--   equality so the (entity, date desc, created desc, id desc) indexes serve
--   the order.
-- * authz.acct_row_json (replaces 20261203000230): fills an original's
--   reference.
-- * authz.dues_compute (replaces 20261203000240): plpgsql with a dynamic
--   statement, planned per call (same rows).
-- * public.accounts_dues (replaces 20261203000240): its page query reads the
--   computed dues once (materialized CTE); the generic plan cached from the
--   sixth call otherwise reran the computation per row (minutes on the seed).
-- Rows, order, cursor, fences and refusals are unchanged.
--
-- Rollback (forward-only): a NEW migration restoring the 20261203000280
-- acct_rows body and the 20261203000230 acct_row_json body.

begin;
set local lock_timeout = '15s';

create function authz.acct_original_items(p_entity uuid, p_deals uuid[])
returns table (what text, record_id uuid, deal_id uuid, task_id uuid, branch_id uuid, state text, since date,
               owner_role text, owner_user_id uuid, department text, supplier_id uuid, is_synthetic boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  -- Dynamic so every call is planned with its values (a cached generic plan of
  -- this statement was several times slower on the speed seed).
  return query execute $q$
  with today as (select authz.finance_today() as d),
  paid as (
    select p.task_id, min(p.paid_on) as first_paid
    from public.supplier_payment_requests p
    where p.legal_entity_id = $1 and p.status in ('paid', 'verified')
    group by p.task_id
  ),
  invoiced as (
    select s.task_id from public.supplier_documents s
    where s.legal_entity_id = $1 and s.kind = 'invoice' and s.status <> 'returned'
    union
    select l.task_id from public.supplier_document_tasks l
    join public.supplier_documents s on s.id = l.document_id
    where l.legal_entity_id = $1 and l.unlinked_at is null and s.kind = 'invoice' and s.status <> 'returned'
  ),
  approved as (
    select distinct on (rv.deal_id) rv.deal_id, coalesce(v.trip_end, v.check_out) as trip_end, rv.last_approved_at
    from public.accounts_booking_reviews rv
    join public.booking_versions v on v.id = rv.booking_version_id
    where rv.legal_entity_id = $1 and rv.last_approved_at is not null and v.status in ('confirmed', 'superseded')
      and ($2 is null or rv.deal_id = any($2))
    order by rv.deal_id, v.version_no desc
  )
  -- Supplier invoice of a Purchase task.
  select 'supplier_invoice'::text, t.id, t.deal_id, t.id, d.branch_id,
    case when m.missing then 'missing' else 'expected' end,
    case when m.missing then te.trip_end + 1
         else coalesce((timezone('Asia/Kolkata', t.supplier_confirmed_at))::date, pp.first_paid) end,
    'purchase'::text, t.assignee_user_id, 'purchase'::text, q.supplier_id, d.is_synthetic
  from public.fulfilment_tasks t
  join public.deals d on d.id = t.deal_id
  left join paid pp on pp.task_id = t.id
  left join public.purchase_quotes q on q.id = t.selected_quote_id
  cross join today
  -- The service end (authz.sm_trip_end), only for the candidate tasks.
  cross join lateral (
    select coalesce(authz.sf_date(f.facts -> 'checkOut'),
                    case when f.service_item_id is null and i.service_type = 'hotel' then v.check_out end,
                    v.trip_end) as trip_end
    from public.fulfilment_tasks tt
    left join public.service_items i on i.id = tt.service_item_id
    left join lateral (
      select cv.id from public.booking_versions cv
      join public.service_item_facts f2 on f2.booking_version_id = cv.id and f2.service_item_id = tt.service_item_id
      where cv.deal_id = tt.deal_id and cv.status = 'confirmed' limit 1) cur on true
    join public.booking_versions v on v.id = coalesce(cur.id, tt.booking_version_id)
    left join public.service_item_facts f on f.service_item_id = tt.service_item_id and f.booking_version_id = v.id
    where tt.id = t.id) te
  cross join lateral (select t.status in ('supplier_confirmed', 'completed') and te.trip_end < today.d as missing) m
  where t.legal_entity_id = $1 and t.department = 'purchase'
    and ($2 is null or t.deal_id = any($2))
    and (t.status in ('supplier_confirmed', 'completed') or pp.first_paid is not null)
    and not exists (select 1 from invoiced x where x.task_id = t.id)
  union all
  -- Airline / portal bill of a Flight ticket batch.
  select 'airline_bill', b.id, b.deal_id, b.cost_task_id, d.branch_id,
    case when ct.status = 'completed' and sd.last_depart < today.d then 'missing' else 'expected' end,
    case when ct.status = 'completed' and sd.last_depart < today.d then sd.last_depart + 1
         else (timezone('Asia/Kolkata', b.confirmed_at))::date end,
    'flight', ct.assignee_user_id, 'flight', b.supplier_id, d.is_synthetic
  from public.flight_ticket_batches b
  join public.deals d on d.id = b.deal_id
  join public.fulfilment_tasks ct on ct.id = b.cost_task_id
  cross join today
  left join lateral (select max(s.depart_date) as last_depart from public.flight_sectors s
                     where s.task_id = ct.id and s.status = 'active') sd on true
  where b.legal_entity_id = $1 and ($2 is null or b.deal_id = any($2))
    and not exists (select 1 from public.supplier_documents x
                    where x.task_id = b.cost_task_id and x.supplier_id = b.supplier_id
                      and x.kind = 'invoice' and x.status <> 'returned')
    and not exists (select 1 from public.supplier_document_tasks l
                    join public.supplier_documents x on x.id = l.document_id
                    where l.task_id = b.cost_task_id and l.unlinked_at is null and x.supplier_id = b.supplier_id
                      and x.kind = 'invoice' and x.status <> 'returned')
  union all
  -- Fee receipt of a company-paid Visa fee or other Visa cost.
  select 'fee_receipt', c.id, c.deal_id, c.task_id, d.branch_id,
    case when te.trip_end < today.d then 'missing' else 'expected' end,
    case when te.trip_end < today.d then te.trip_end + 1
         else coalesce(c.paid_on, (timezone('Asia/Kolkata', c.created_at))::date) end,
    'visa', t.assignee_user_id, 'visa', c.supplier_id, d.is_synthetic
  from public.department_cost_entries c
  join public.deals d on d.id = c.deal_id
  join public.fulfilment_tasks t on t.id = c.task_id
  cross join today
  cross join lateral (
    select coalesce(authz.sf_date(f.facts -> 'checkOut'),
                    case when f.service_item_id is null and i.service_type = 'hotel' then v.check_out end,
                    v.trip_end) as trip_end
    from public.fulfilment_tasks tt
    left join public.service_items i on i.id = tt.service_item_id
    left join lateral (
      select cv.id from public.booking_versions cv
      join public.service_item_facts f2 on f2.booking_version_id = cv.id and f2.service_item_id = tt.service_item_id
      where cv.deal_id = tt.deal_id and cv.status = 'confirmed' limit 1) cur on true
    join public.booking_versions v on v.id = coalesce(cur.id, tt.booking_version_id)
    left join public.service_item_facts f on f.service_item_id = tt.service_item_id and f.booking_version_id = v.id
    where tt.id = c.task_id) te
  where c.legal_entity_id = $1 and ($2 is null or c.deal_id = any($2)) and c.department = 'visa' and c.paid_by = 'company'
    and c.receipt_evidence_id is null and c.expense_status in ('draft', 'submitted', 'returned')
  union all
  -- Bank proof of a bank/UPI receipt still waiting for verification.
  select 'bank_proof', r.id, r.deal_id, null::uuid, d.branch_id, 'missing', r.received_on,
    'accounts', r.recorded_by, 'accounts', null::uuid, d.is_synthetic
  from public.customer_receipts r
  join public.deals d on d.id = r.deal_id
  where r.legal_entity_id = $1 and ($2 is null or r.deal_id = any($2)) and r.mode in ('bank_transfer', 'upi') and r.status = 'recorded'
    and not exists (select 1 from public.finance_evidence e
                    where e.receipt_id = r.id and e.kind = 'bank_proof' and e.status = 'stored')
  union all
  -- Tally GST invoice reference of a Deal with an Accounts-approved basis.
  select 'gst_invoice_ref', d.id, d.id, null::uuid, d.branch_id,
    case when ap.trip_end < today.d then 'missing' else 'expected' end,
    case when ap.trip_end < today.d then ap.trip_end + 1
         else (timezone('Asia/Kolkata', ap.last_approved_at))::date end,
    'accounts', null::uuid, 'accounts', null::uuid, d.is_synthetic
  from approved ap
  join public.deals d on d.id = ap.deal_id
  cross join today
  where not exists (select 1 from public.deal_tally_invoices g where g.deal_id = d.id and g.status = 'active')
  $q$ using p_entity, p_deals;
end;
$$;

create or replace function authz.acct_original_items(p_entity uuid)
returns table (what text, record_id uuid, deal_id uuid, task_id uuid, branch_id uuid, state text, since date,
               owner_role text, owner_user_id uuid, department text, supplier_id uuid, is_synthetic boolean)
language sql stable security definer set search_path = '' as $$
  select * from authz.acct_original_items(p_entity, null::uuid[])
$$;

-- Replaces 20261203000280 (Accounts phase 20261203000290).
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
  v_orig_deals uuid[];  -- Accounts phase (20261203000290): originals of these Deals only (search / dealReference)
begin
  if jsonb_typeof(v_f) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'filter';
  end if;
  if (v_f - array['from', 'to', 'kinds', 'department', 'dealReference', 'supplierId', 'stage', 'reviewStatus', 'tallyStatus',
                  'changedSinceExport', 'originals', 'amountMin', 'amountMax', 'branchId', 'q']) <> '{}'::jsonb then
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

-- Replaces 20261203000230 (Accounts phase 20261203000290).
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

  v_link := case p.kind
    when 'receipt' then jsonb_build_object('kind', 'accounts_deal', 'id', p.deal_id)
    when 'receipt_reversal' then jsonb_build_object('kind', 'accounts_deal', 'id', p.deal_id)
    when 'claim' then jsonb_build_object('kind', 'claim', 'id', p.record_id)
    when 'cash_deposit' then jsonb_build_object('kind', 'cash', 'id', p.record_id)
    when 'cash_count' then jsonb_build_object('kind', 'cash', 'id', p.record_id)
    when 'supplier_payment' then jsonb_build_object('kind', 'supplier_payment', 'id', p.record_id)
    when 'company_funding' then jsonb_build_object('kind', 'supplier_payment',
      'id', (select f.payment_request_id from public.company_funding_requests f where f.id = p.record_id))
    when 'supplier_invoice' then jsonb_build_object('kind', 'supplier_document', 'id', p.record_id)
    when 'supplier_credit_note' then jsonb_build_object('kind', 'supplier_document', 'id', p.record_id)
    when 'expense' then jsonb_build_object('kind', 'expense', 'id', p.record_id)
    when 'flight_ticket_batch' then jsonb_build_object('kind', 'flight_deal', 'id', p.deal_id)
    when 'visa_application' then jsonb_build_object('kind', 'visa_task', 'id', p.task_id)
    when 'tally_gst_invoice' then jsonb_build_object('kind', 'accounts_deal', 'id', p.deal_id)
    else case p.orig_what
      when 'supplier_invoice' then jsonb_build_object('kind', 'purchase_task', 'id', p.task_id)
      when 'airline_bill' then jsonb_build_object('kind', 'flight_deal', 'id', p.deal_id)
      when 'fee_receipt' then jsonb_build_object('kind', 'visa_task', 'id', p.task_id)
      else jsonb_build_object('kind', 'accounts_deal', 'id', p.deal_id) end
  end;

  if p.kind = 'original' then
    v_original := jsonb_build_object('what', p.orig_what, 'state', p.orig_state, 'since', to_char(p.orig_since, 'YYYY-MM-DD'),
      'ownerRole', p.owner_role, 'ownerName', (select s.display_name from public.staff_profiles s where s.user_id = p.owner_user));
  end if;

  v_can := jsonb_build_object(
    'match', p.is_a and p.tally_kind is not null and v_tally_status in ('ready', 'exported'),
    'exception', p.is_a and p.tally_kind is not null and v_tally_status in ('ready', 'exported', 'matched'),
    'reopen', p.is_a and p.tally_kind is not null
              and (v_tally_status = 'exception' or (v_tally_status = 'matched' and coalesce(v_tr.export_count, 0) > 0)),
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

-- Replaces 20261203000240 (Accounts phase 20261203000290).
create or replace function authz.dues_compute(p_a uuid[], p_m uuid[], p_so_entities uuid[], p_syn boolean, p_deal uuid, p_force boolean)
returns table (
  deal_id uuid, reference text, branch_id uuid, owner_user_id uuid, legal_entity_id uuid,
  version_id uuid, version_no integer, basis text, last_approved_at timestamptz, newer_pending boolean,
  total bigint, money bigint, balance bigint, overdue bigint, due_now bigint, next_due_date date, next_due_open bigint,
  oldest_open date, reported bigint, awaiting bigint, credit bigint, has_plan boolean, status text, rank integer,
  cancellation text, is_a boolean, is_m boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  -- Accounts phase (20261203000290): dynamic, planned with the values of
  -- each call. The cached generic plan of the SQL-language body (from the
  -- sixth call on PGlite) reran the per-Deal subqueries for minutes.
  return query execute $q$
  with scope as (
    select d.id, d.reference, d.branch_id, d.owner_user_id, d.legal_entity_id,
      d.legal_entity_id = any($1) as is_a, d.branch_id = any($2) as is_m
    from public.deals d
    where d.is_synthetic = $4
      and ($5 is null or d.id = $5)
      and (($5 is not null and $6)
           or d.legal_entity_id = any($1)
           or d.branch_id = any($2)
           or (d.owner_user_id = (select auth.uid()) and d.legal_entity_id = any($3)))
  ), cur as (
    select v.deal_id, v.id, v.version_no from public.booking_versions v
    join scope s on s.id = v.deal_id where v.status = 'confirmed'
  ), approved as (
    select distinct on (v.deal_id) v.deal_id, v.id, v.version_no, rv.last_approved_at
    from public.booking_versions v
    join scope s on s.id = v.deal_id
    join public.accounts_booking_reviews rv on rv.booking_version_id = v.id
    where v.status in ('confirmed', 'superseded') and rv.last_approved_at is not null
    order by v.deal_id, v.version_no desc
  ), basis as (
    select s.*, coalesce(a.id, c.id) as version_id, coalesce(a.version_no, c.version_no) as version_no,
      case when a.id is not null then 'approved' else 'awaiting_review' end as basis, a.last_approved_at,
      coalesce(a.id is not null and c.version_no > a.version_no, false) as newer_pending
    from scope s
    join cur c on c.deal_id = s.id
    left join approved a on a.deal_id = s.id
  ), money as (
    select l.deal_id, sum(l.credit_paise - l.debit_paise)::bigint as m
    from public.finance_journal_lines l join basis b on b.id = l.deal_id
    where l.account = 'customer_advances'
    group by l.deal_id
  ), charged as (
    select b.*, coalesce(bc.selling_total_paise, 0)::bigint as total, coalesce(mo.m, 0)::bigint as money,
      greatest(coalesce(mo.m, 0), 0)::bigint as mpos
    from basis b
    left join public.booking_version_commercials bc on bc.version_id = b.version_id
    left join money mo on mo.deal_id = b.id
  ), inst as (
    select c.id as deal_id, i.seq, i.due_date, i.amount_paise,
      least(i.amount_paise, greatest(c.mpos - coalesce(sum(i.amount_paise) over (
        partition by i.booking_version_id order by i.due_date, i.seq rows between unbounded preceding and 1 preceding), 0), 0))::bigint as covered
    from charged c join public.booking_version_instalments i on i.booking_version_id = c.version_id
  ), inst_agg as (
    select x.deal_id, count(*) as n,
      coalesce(sum(x.amount_paise - x.covered) filter (where x.amount_paise > x.covered and x.due_date < authz.finance_today()), 0)::bigint as overdue,
      coalesce(sum(x.amount_paise - x.covered) filter (where x.amount_paise > x.covered and x.due_date = authz.finance_today()), 0)::bigint as due_now,
      min(x.due_date) filter (where x.amount_paise > x.covered) as oldest_open,
      (array_agg(x.due_date order by x.due_date, x.seq) filter (where x.amount_paise > x.covered))[1] as next_date,
      (array_agg(x.amount_paise - x.covered order by x.due_date, x.seq) filter (where x.amount_paise > x.covered))[1] as next_open
    from inst x group by x.deal_id
  ), extra as (
    -- Accounts phase (20261203000290): grouped once instead of three lookups per Deal.
    select c.id, coalesce(cl.reported, 0)::bigint as reported, coalesce(rc.awaiting, 0)::bigint as awaiting, dc.cancellation
    from charged c
    left join (select x.deal_id, sum(x.amount_paise) as reported from public.customer_payment_claims x
               where x.status = 'reported' and x.deal_id in (select id from charged) group by x.deal_id) cl on cl.deal_id = c.id
    left join (select r.deal_id, sum(r.amount_paise) as awaiting from public.customer_receipts r
               where r.status = 'recorded' and r.mode <> 'cheque' and r.deal_id in (select id from charged) group by r.deal_id) rc
      on rc.deal_id = c.id
    left join (select y.deal_id, case when bool_or(y.status <> 'approved') then 'open' when bool_or(y.status = 'approved') then 'approved' end
                 as cancellation
               from public.deal_cancellations y where y.deal_id in (select id from charged) group by y.deal_id) dc on dc.deal_id = c.id
  ), computed as (
    select c.*, coalesce(ia.n, 0) > 0 as has_plan, coalesce(ia.overdue, 0) as overdue, coalesce(ia.due_now, 0) as due_now,
      ia.oldest_open, ia.next_date, ia.next_open, e.reported, e.awaiting, e.cancellation,
      (c.total - least(c.mpos, c.total))::bigint as balance,
      greatest(c.mpos - c.total, 0)::bigint as credit,
      case
        when c.mpos > c.total then 'credit'
        when coalesce(ia.overdue, 0) > 0 then 'overdue'
        when coalesce(ia.due_now, 0) > 0 then 'due_now'
        when coalesce(ia.n, 0) = 0 and c.mpos > 0 and c.mpos < c.total then 'unallocated'
        when coalesce(ia.n, 0) = 0 and c.mpos = 0 and c.total > 0 then 'no_plan'
        when c.total - least(c.mpos, c.total) > 0 then 'upcoming'
        else 'paid' end as status
    from charged c
    left join inst_agg ia on ia.deal_id = c.id
    join extra e on e.id = c.id
  )
  select x.id, x.reference, x.branch_id, x.owner_user_id, x.legal_entity_id,
    x.version_id, x.version_no, x.basis, x.last_approved_at, x.newer_pending,
    x.total, x.money, x.balance, x.overdue, x.due_now, x.next_date, x.next_open,
    x.oldest_open, x.reported, x.awaiting, x.credit, x.has_plan, x.status,
    case x.status when 'overdue' then 1 when 'due_now' then 2 when 'upcoming' then 3 when 'unallocated' then 4
                  when 'no_plan' then 5 when 'credit' then 6 else 7 end,
    x.cancellation, x.is_a, x.is_m
  from computed x
  $q$ using p_a, p_m, p_so_entities, p_syn, p_deal, p_force;
end;
$$;

create or replace function public.accounts_dues(p_filter jsonb, p_after text default null, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c_status constant text[] := array['overdue', 'due_now', 'upcoming', 'paid', 'credit', 'unallocated', 'no_plan'];
  v_f jsonb := coalesce(p_filter, '{}'::jsonb);
  v_a uuid[]; v_m uuid[]; v_so uuid[]; v_syn boolean;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_status text[]; v_reported boolean; v_branch uuid; v_owner uuid; v_ref text; v_next_from date; v_next_to date;
  v_ar integer; v_ad date; v_aref text; v_aid uuid;
  v_items jsonb; v_has_more boolean; v_next text;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  v_a := authz.acct_a_entities();
  v_m := authz.acct_m_branches();
  v_so := authz.dues_so_entities();
  v_syn := authz.acct_synthetic();
  if (cardinality(v_a) = 0 and cardinality(v_m) = 0 and cardinality(v_so) = 0) or v_syn is null then
    return null;
  end if;
  if jsonb_typeof(v_f) <> 'object'
     or (v_f - array['status', 'reported', 'branchId', 'ownerUserId', 'dealReference', 'nextDueFrom', 'nextDueTo']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'filter';
  end if;
  if v_f ? 'status' and jsonb_typeof(v_f -> 'status') <> 'null' then
    if jsonb_typeof(v_f -> 'status') <> 'array' or jsonb_array_length(v_f -> 'status') = 0
       or exists (select 1 from jsonb_array_elements(v_f -> 'status') e
                  where jsonb_typeof(e) <> 'string' or not ((e #>> '{}') = any(c_status))) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'status';
    end if;
    select array_agg(distinct e) into v_status from jsonb_array_elements_text(v_f -> 'status') e;
  end if;
  if v_f ? 'reported' and jsonb_typeof(v_f -> 'reported') <> 'null' then
    if jsonb_typeof(v_f -> 'reported') <> 'boolean' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'reported';
    end if;
    v_reported := (v_f ->> 'reported')::boolean;
  end if;
  begin
    v_branch := authz.finance_uuid(authz.finance_field(v_f, 'branchId'));
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'branchId'; end;
  begin
    v_owner := authz.finance_uuid(authz.finance_field(v_f, 'ownerUserId'));
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'ownerUserId'; end;
  -- Branch and owner filters are for A and M only.
  if (v_branch is not null or v_owner is not null) and cardinality(v_a) = 0 and cardinality(v_m) = 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = case when v_branch is not null then 'branchId' else 'ownerUserId' end;
  end if;
  if v_branch is not null and not (v_branch = any(v_m))
     and not exists (select 1 from public.branches b where b.id = v_branch and b.legal_entity_id = any(v_a)) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'branchId';
  end if;
  begin
    v_ref := authz.finance_text(authz.finance_field(v_f, 'dealReference'), 1, 60, false);
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'dealReference'; end;
  begin
    v_next_from := authz.finance_date(authz.finance_field(v_f, 'nextDueFrom'));
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'nextDueFrom'; end;
  begin
    v_next_to := authz.finance_date(authz.finance_field(v_f, 'nextDueTo'));
  exception when sqlstate '22023' then raise exception 'invalid_input' using errcode = '22023', hint = 'nextDueTo'; end;

  if p_after is not null then
    if p_after !~ '^[1-7]\|([0-9]{4}-[0-9]{2}-[0-9]{2}|-)\|.+\|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end if;
    v_ar := split_part(p_after, '|', 1)::integer;
    begin
      v_ad := case when split_part(p_after, '|', 2) = '-' then date '9999-12-31' else split_part(p_after, '|', 2)::date end;
    exception when others then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end;
    v_aid := right(p_after, 36)::uuid;
    v_aref := substr(p_after, length(split_part(p_after, '|', 1)) + length(split_part(p_after, '|', 2)) + 3,
                     length(p_after) - 37 - length(split_part(p_after, '|', 1)) - length(split_part(p_after, '|', 2)) - 2);
  end if;

  -- Accounts phase (20261203000290): computed once per call. Without
  -- "materialized" the cached generic plan (from the sixth call) could put the
  -- function scan on the inner side of a nested loop and rerun it per row.
  with rows as materialized (
    select c.*, coalesce(c.oldest_open, date '9999-12-31') as od
    from authz.dues_compute(v_a, v_m, v_so, v_syn, null, false) c
    where (v_status is null or c.status = any(v_status))
      and (v_reported is null or (c.reported > 0) = v_reported)
      and (v_branch is null or c.branch_id = v_branch)
      and (v_owner is null or c.owner_user_id = v_owner)
      and (v_ref is null or c.reference = v_ref)
      and (v_next_from is null or c.next_due_date >= v_next_from)
      and (v_next_to is null or c.next_due_date <= v_next_to)
      -- A Sales owner sees own Deals only (A and M see their scope).
      and (c.is_a or c.is_m or c.owner_user_id = (select auth.uid()))
  ), page as (
    select r.*, row_number() over (order by r.rank, r.od, r.reference, r.deal_id) as n
    from (select * from rows r
          where p_after is null or (r.rank, r.od, r.reference, r.deal_id) > (v_ar, v_ad, v_aref, v_aid)
          order by r.rank, r.od, r.reference, r.deal_id
          limit v_limit + 1) r
  )
  select coalesce((select jsonb_agg(authz.dues_row_json(p.deal_id, p.reference, p.branch_id, p.owner_user_id, p.version_no,
             p.basis, p.last_approved_at, p.newer_pending, p.total, p.money, p.balance, p.overdue, p.due_now, p.next_due_date,
             p.next_due_open, p.reported, p.awaiting, p.credit, p.status, p.cancellation) order by p.n)
           from page p where p.n <= v_limit), '[]'::jsonb),
         exists (select 1 from page p where p.n > v_limit),
         (select p.rank::text || '|' || case when p.oldest_open is null then '-' else to_char(p.oldest_open, 'YYYY-MM-DD') end
                 || '|' || p.reference || '|' || p.deal_id::text
          from page p where p.n = v_limit and exists (select 1 from page q where q.n > v_limit))
  into v_items, v_has_more, v_next;

  return jsonb_build_object(
    'scope', jsonb_build_object('mode', case when cardinality(v_a) > 0 then 'accounts' when cardinality(v_m) > 0 then 'manager' else 'sales' end,
      'readOnly', cardinality(v_a) = 0),
    'items', v_items, 'hasMore', v_has_more, 'nextAfter', v_next);
end;
$$;

revoke all on function authz.acct_original_items(uuid, uuid[]) from public, anon, authenticated, service_role;

commit;
