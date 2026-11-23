-- Accounts phase, Track B (8): speed of the originals list (contract 4.5,
-- 12.7 / plan 17.3: workspace first page <= 300 ms at the database).
--
-- On the speed seed (scripts/perf/accounts-volume.sql, PGlite) the
-- "original" branch of accounts_records took about 1.7 s: it called
-- authz.sm_invoice_missing, authz.sm_trip_end and authz.sm_task_has_invoice
-- once or more per task (each a security definer function re-reading the
-- task, its version and its facts), and a lateral review lookup per Deal.
--
-- Replaces authz.acct_original_items (20261203000230), same signature and
-- the same rows: one set-based statement. The rules are unchanged and still
-- those of authz.sm_invoice_missing / authz.sm_trip_end:
--   * invoice exists = a non-returned invoice on the task or actively linked
--     to it (anti-joins);
--   * a task's service end = checkOut of its item's facts in the version the
--     task follows (authz.task_current_version: the confirmed version holding
--     facts for the item, else the task's own version; a legacy hotel item
--     without facts uses the version's check_out), else the version's
--     trip_end;
--   * missing = supplier confirmed or completed and that date before today.
--
-- Rollback (forward-only): a NEW migration restoring the 20261203000230 body.

begin;
set local lock_timeout = '15s';

create or replace function authz.acct_original_items(p_entity uuid)
returns table (what text, record_id uuid, deal_id uuid, task_id uuid, branch_id uuid, state text, since date,
               owner_role text, owner_user_id uuid, department text, supplier_id uuid, is_synthetic boolean)
language sql stable security definer set search_path = '' as $$
  with today as (select authz.finance_today() as d),
  -- The version each task follows and its service end date (sm_trip_end).
  task_end as (
    select t.id, t.deal_id, t.department, t.status, t.assignee_user_id, t.selected_quote_id, t.supplier_confirmed_at,
      coalesce(authz.sf_date(f.facts -> 'checkOut'),
               case when f.service_item_id is null and i.service_type = 'hotel' then v.check_out end,
               v.trip_end) as trip_end
    from public.fulfilment_tasks t
    left join public.service_items i on i.id = t.service_item_id
    left join lateral (
      select cv.id from public.booking_versions cv
      join public.service_item_facts f2 on f2.booking_version_id = cv.id and f2.service_item_id = t.service_item_id
      where cv.deal_id = t.deal_id and cv.status = 'confirmed' limit 1) cur on true
    join public.booking_versions v on v.id = coalesce(cur.id, t.booking_version_id)
    left join public.service_item_facts f on f.service_item_id = t.service_item_id and f.booking_version_id = v.id
    where t.legal_entity_id = p_entity and t.department in ('purchase', 'visa')
  ),
  paid as (
    select p.task_id, min(p.paid_on) as first_paid
    from public.supplier_payment_requests p
    where p.legal_entity_id = p_entity and p.status in ('paid', 'verified')
    group by p.task_id
  ),
  invoiced as (
    select s.task_id from public.supplier_documents s
    where s.legal_entity_id = p_entity and s.kind = 'invoice' and s.status <> 'returned'
    union
    select l.task_id from public.supplier_document_tasks l
    join public.supplier_documents s on s.id = l.document_id
    where l.legal_entity_id = p_entity and l.unlinked_at is null and s.kind = 'invoice' and s.status <> 'returned'
  ),
  approved as (
    select distinct on (rv.deal_id) rv.deal_id, coalesce(v.trip_end, v.check_out) as trip_end, rv.last_approved_at
    from public.accounts_booking_reviews rv
    join public.booking_versions v on v.id = rv.booking_version_id
    where rv.legal_entity_id = p_entity and rv.last_approved_at is not null and v.status in ('confirmed', 'superseded')
    order by rv.deal_id, v.version_no desc
  )
  -- Supplier invoice of a Purchase task.
  select 'supplier_invoice'::text, t.id, t.deal_id, t.id, d.branch_id,
    case when m.missing then 'missing' else 'expected' end,
    case when m.missing then t.trip_end + 1
         else coalesce((timezone('Asia/Kolkata', t.supplier_confirmed_at))::date, pp.first_paid) end,
    'purchase'::text, t.assignee_user_id, 'purchase'::text, q.supplier_id, d.is_synthetic
  from task_end t
  join public.deals d on d.id = t.deal_id
  left join paid pp on pp.task_id = t.id
  left join public.purchase_quotes q on q.id = t.selected_quote_id
  cross join today
  cross join lateral (select t.status in ('supplier_confirmed', 'completed') and t.trip_end < today.d as missing) m
  where t.department = 'purchase'
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
  where b.legal_entity_id = p_entity
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
    case when t.trip_end < today.d then 'missing' else 'expected' end,
    case when t.trip_end < today.d then t.trip_end + 1
         else coalesce(c.paid_on, (timezone('Asia/Kolkata', c.created_at))::date) end,
    'visa', t.assignee_user_id, 'visa', c.supplier_id, d.is_synthetic
  from public.department_cost_entries c
  join public.deals d on d.id = c.deal_id
  join task_end t on t.id = c.task_id
  cross join today
  where c.legal_entity_id = p_entity and c.department = 'visa' and c.paid_by = 'company'
    and c.receipt_evidence_id is null and c.expense_status in ('draft', 'submitted', 'returned')
  union all
  -- Bank proof of a bank/UPI receipt still waiting for verification.
  select 'bank_proof', r.id, r.deal_id, null::uuid, d.branch_id, 'missing', r.received_on,
    'accounts', r.recorded_by, 'accounts', null::uuid, d.is_synthetic
  from public.customer_receipts r
  join public.deals d on d.id = r.deal_id
  where r.legal_entity_id = p_entity and r.mode in ('bank_transfer', 'upi') and r.status = 'recorded'
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
$$;

-- Supporting indexes for the set-based statement.
create index if not exists accounts_booking_reviews_entity_approved_idx
  on public.accounts_booking_reviews (legal_entity_id, deal_id) where last_approved_at is not null;
create index if not exists supplier_payment_requests_paid_task_idx
  on public.supplier_payment_requests (legal_entity_id, task_id) where status in ('paid', 'verified');

commit;
