-- TripNavigate CRM - Accounts phase 3, track B (4 of 4): write-off in dues,
-- refunds and the daily check.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 6.5 (daily check),
-- 6.6 (effect), 20 R7, 21 LD15, LD16.
--
-- Replaced (latest bodies re-confirmed with the sorted grep; same signatures
-- and output columns; changed lines marked "Accounts phase 3 (20261205000230)"):
--   authz.dues_compute (20261204000380:498): the total is the ADJUSTED total =
--     basis total - the approved 'due' write-off + the approved 'excess'
--     write-off, so the balance (due) or the credit (excess) becomes zero; a
--     waived amount also covers the instalment plan. Money held is unchanged.
--     With no write-off rows the results are identical (risk R7).
--   public.deal_dues (20261204000380:625): adds writeOff {refNo, direction,
--     amountPaise, status, reason, proposedByName, decidedByName, decidedAt} |
--     null (the active write-off: proposed or approved) and writeOffNeedsReview
--     (an approved write-off and a balance or credit again); the instalment
--     coverage counts a waived amount. Readers unchanged (A, M, SO money card;
--     never Purchase, Flight or Visa).
--   authz.refund_basis_total (20261204000310:125): returns the adjusted total,
--     so a kept excess can never be refunded.
--   public.accounts_daily_check (20261204000910:21, additive):
--     billsHeldOverOneWorkingDay, customerMessagesFailedOverOneWorkingDay,
--     tallyFileUnmatchedOverOneWorkingDay (null until track C's tables exist),
--     messageQueueOldestMinutes (null when nothing waits), writeOffsToReview.
-- public.accounts_dues is not replaced (it reads authz.dues_compute).
--
-- Refusal tokens: none new.
-- Rollback (forward-only): a NEW migration restoring the four cited bodies.

begin;
set local lock_timeout = '15s';

create or replace function authz.dues_compute(p_a uuid[], p_m uuid[], p_so_entities uuid[], p_syn boolean, p_deal uuid, p_force boolean)
returns table (
  deal_id uuid, reference text, branch_id uuid, owner_user_id uuid, legal_entity_id uuid,
  version_id uuid, version_no integer, basis text, last_approved_at timestamptz, newer_pending boolean,
  total bigint, money bigint, balance bigint, overdue bigint, due_now bigint, next_due_date date, next_due_open bigint,
  oldest_open date, reported bigint, awaiting bigint, credit bigint, has_plan boolean, status text, rank integer,
  cancellation text, is_a boolean, is_m boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  -- Accounts phase 2 (20261204000320): basis 'cancelled' after an approved
  -- cancellation settlement (total = the customer charge, no plan); money as before.
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
  ), settle as (
    -- Accounts phase 2 (20261204000320, LD10): the latest approved (or paid)
    -- cancellation settlement replaces the total and the plan.
    select distinct on (r.deal_id) r.deal_id, r.customer_charge_paise
    from public.customer_refund_requests r join basis b on b.id = r.deal_id
    where r.kind = 'cancellation' and r.status in ('approved', 'paid')
    -- Accounts phase 2 (20261204000380, Addendum L7): the highest approved charge counts.
    order by r.deal_id, r.customer_charge_paise desc, r.decided_at desc, r.requested_at desc, r.id desc
  ), wo as (
    -- Accounts phase 3 (20261205000230, LD15): the approved write-off adjusts the total
    -- (due: minus; excess: plus); money held never changes.
    select w.deal_id,
      coalesce(sum(w.amount_paise) filter (where w.direction = 'due'), 0)::bigint as wo_due,
      coalesce(sum(w.amount_paise) filter (where w.direction = 'excess'), 0)::bigint as wo_excess
    from public.deal_write_offs w join basis b on b.id = w.deal_id
    where w.status = 'approved'
    group by w.deal_id
  ), money as (
    select l.deal_id, sum(l.credit_paise - l.debit_paise)::bigint as m
    from public.finance_journal_lines l join basis b on b.id = l.deal_id
    where l.account = 'customer_advances'
    group by l.deal_id
  ), charged as (
    select b.*, st.deal_id is not null as settled,
      -- Accounts phase 2 (20261204000320): settled total = the approved customer charge.
      -- Accounts phase 3 (20261205000230): the adjusted total (basis total - due + excess write-off).
      (coalesce(st.customer_charge_paise, bc.selling_total_paise, 0) - coalesce(wo.wo_due, 0) + coalesce(wo.wo_excess, 0))::bigint as total,
      coalesce(mo.m, 0)::bigint as money,
      greatest(coalesce(mo.m, 0), 0)::bigint as mpos,
      coalesce(wo.wo_due, 0)::bigint as wo_due
    from basis b
    left join public.booking_version_commercials bc on bc.version_id = b.version_id
    left join money mo on mo.deal_id = b.id
    left join settle st on st.deal_id = b.id
    left join wo on wo.deal_id = b.id
  ), inst as (
    select c.id as deal_id, i.seq, i.due_date, i.amount_paise,
      -- Accounts phase 3 (20261205000230): a waived (due) write-off covers the instalments like money.
      least(i.amount_paise, greatest(c.mpos + c.wo_due - coalesce(sum(i.amount_paise) over (
        partition by i.booking_version_id order by i.due_date, i.seq rows between unbounded preceding and 1 preceding), 0), 0))::bigint as covered
    from charged c join public.booking_version_instalments i on i.booking_version_id = c.version_id
    -- Accounts phase 2 (20261204000320): instalments are ignored after a settlement.
    where not c.settled
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
    select c.*, coalesce(ia.n, 0) > 0 as has_plan, coalesce(ia.overdue, 0) as overdue,
      -- After an approved settlement there is no plan: the unpaid charge is owed now (Addendum L6, lead).
      (coalesce(ia.due_now, 0) + greatest(-c.money, 0)
       + case when c.settled then c.total - least(c.mpos, c.total) else 0 end)::bigint as due_now,
      ia.oldest_open, ia.next_date, ia.next_open, e.reported, e.awaiting, e.cancellation,
      -- Accounts phase 2 (20261204000370, Addendum L6): a reversal after a paid-out refund can leave money below
      -- zero; the shortfall is owed now, on top of the total.
      greatest(-c.money, 0)::bigint as shortfall,
      (c.total - least(c.mpos, c.total) + greatest(-c.money, 0))::bigint as balance,
      greatest(c.mpos - c.total, 0)::bigint as credit,
      case
        when c.mpos > c.total then 'credit'
        when coalesce(ia.overdue, 0) > 0 then 'overdue'
        when coalesce(ia.due_now, 0) + greatest(-c.money, 0)
             + case when c.settled then c.total - least(c.mpos, c.total) else 0 end > 0 then 'due_now'
        when coalesce(ia.n, 0) = 0 and c.mpos > 0 and c.mpos < c.total then 'unallocated'
        when coalesce(ia.n, 0) = 0 and c.mpos = 0 and c.total > 0 then 'no_plan'
        when c.total - least(c.mpos, c.total) > 0 then 'upcoming'
        else 'paid' end as status
    from charged c
    left join inst_agg ia on ia.deal_id = c.id
    join extra e on e.id = c.id
  )
  select x.id, x.reference, x.branch_id, x.owner_user_id, x.legal_entity_id,
    x.version_id, x.version_no, case when x.settled then 'cancelled' else x.basis end, x.last_approved_at, x.newer_pending,
    x.total, x.money, x.balance, x.overdue, x.due_now, x.next_date, x.next_open,
    x.oldest_open, x.reported, x.awaiting, x.credit, x.has_plan, x.status,
    case x.status when 'overdue' then 1 when 'due_now' then 2 when 'upcoming' then 3 when 'unallocated' then 4
                  when 'no_plan' then 5 when 'credit' then 6 else 7 end,
    x.cancellation, x.is_a, x.is_m
  from computed x
  $q$ using p_a, p_m, p_so_entities, p_syn, p_deal, p_force;
end;
$$;

create or replace function public.deal_dues(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_a uuid[]; v_m uuid[]; v_syn boolean;
  v_sales boolean := false;
  r record;
  v_row jsonb;
  v_wo public.deal_write_offs%rowtype;
  v_wo_due bigint;
begin
  if p_deal_id is null or not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null then
    return null;
  end if;
  v_a := authz.acct_a_entities();
  v_m := authz.acct_m_branches();
  v_syn := authz.acct_synthetic();
  if v_syn is null or v_deal.is_synthetic is distinct from v_syn then
    return null;
  end if;
  if not (v_deal.legal_entity_id = any(v_a)) and not (v_deal.branch_id = any(v_m)) then
    -- AL5: the existing Sales money-card readers; never Purchase, Flight or Visa.
    v_sales := coalesce(authz.finance_claim_sales_ok(v_deal.id), false)
      and authz.finance_gate_issue(v_deal.legal_entity_id, v_deal.is_synthetic) is null
      and not exists (select 1 from public.memberships m
                      where m.user_id = (select auth.uid()) and m.legal_entity_id = v_deal.legal_entity_id
                        and m.role_code in ('purchase', 'flight', 'visa') and m.status = 'active');
    if not v_sales then
      return null;
    end if;
  end if;

  select * into r from authz.dues_compute(v_a, v_m, array[]::uuid[], v_syn, v_deal.id, true) c limit 1;
  if r.deal_id is null then
    -- No confirmed version: the Deal is not in dues.
    return null;
  end if;
  -- Accounts phase 3 (20261205000230): the active write-off (proposed or approved).
  select * into v_wo from public.deal_write_offs w where w.deal_id = v_deal.id and w.status in ('proposed', 'approved');
  v_wo_due := case when v_wo.status = 'approved' and v_wo.direction = 'due' then v_wo.amount_paise else 0 end;
  v_row := authz.dues_row_json(r.deal_id, r.reference, r.branch_id, r.owner_user_id, r.version_no, r.basis, r.last_approved_at,
    r.newer_pending, r.total, r.money, r.balance, r.overdue, r.due_now, r.next_due_date, r.next_due_open, r.reported,
    r.awaiting, r.credit, r.status, r.cancellation);
  return v_row || jsonb_build_object(
    'instalments', coalesce((
      select jsonb_agg(jsonb_build_object(
          'seq', x.seq, 'label', x.label, 'dueDate', to_char(x.due_date, 'YYYY-MM-DD'),
          'amountPaise', x.amount_paise::text, 'coveredPaise', x.covered::text, 'openPaise', (x.amount_paise - x.covered)::text,
          'status', case when x.amount_paise = x.covered then 'paid' when x.due_date < authz.finance_today() then 'overdue'
                         when x.due_date = authz.finance_today() then 'due_now' else 'upcoming' end,
          'partlyPaid', x.covered > 0 and x.covered < x.amount_paise) order by x.due_date, x.seq)
      from (select i.seq, i.label, i.due_date, i.amount_paise,
              least(i.amount_paise, greatest(greatest(r.money, 0) + v_wo_due - coalesce(sum(i.amount_paise) over (
                order by i.due_date, i.seq rows between unbounded preceding and 1 preceding), 0), 0))::bigint as covered
            from public.booking_version_instalments i
            -- Accounts phase 2 (20261204000320): no plan after a cancellation settlement.
            where i.booking_version_id = r.version_id and r.basis <> 'cancelled') x), '[]'::jsonb),
    'tallyInvoices', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'invoiceRef', g.invoice_ref, 'invoiceDate', to_char(g.invoice_date, 'YYYY-MM-DD'),
          'status', g.status, 'rowVersion', g.row_version,
          'tallyStatus', case when g.status = 'withdrawn' then 'not_applicable' else coalesce(tr.status, 'matched') end)
        order by g.invoice_date, g.created_at)
      from public.deal_tally_invoices g
      left join public.tally_records tr on tr.record_kind = 'tally_gst_invoice' and tr.record_id = g.id
      where g.deal_id = v_deal.id), '[]'::jsonb),
    'supplierPayables', case when r.is_a or r.is_m then authz.dues_supplier_payables(v_deal.id) end,
    -- Accounts phase (20261203000260): explicit viewer mode for the Deal money card.
    'viewer', case when r.is_a then 'accounts' when r.is_m then 'manager' else 'sales' end,
    -- Addition to 8.3 (lead OK needed): the caller is Accounts of the Deal's entity (T4 allowed).
    'canAddTallyInvoice', r.is_a,
    -- Accounts phase 2 (20261204000320, 7.2): refunds of the Deal (amounts only; no payee).
    'refunds', jsonb_build_object(
      'live', (select jsonb_build_object('refNo', q.ref_no, 'status', q.status, 'amountPaise', q.amount_paise::text)
               from public.customer_refund_requests q
               where q.deal_id = v_deal.id and (q.status in ('requested', 'returned') or (q.status = 'approved' and q.outcome = 'payout'))
               limit 1),
      'paidPaise', (select coalesce(sum(p.amount_paise), 0)::text from public.customer_refund_payouts p where p.deal_id = v_deal.id),
      -- Accounts phase 2 (20261204000380, Addendum L7): only unused kept credit.
      'keptAsCreditPaise', authz.refund_kept_unused(v_deal.id)::text,
      -- Accounts phase 2 (20261204000370, Addendum L6): "Customer owes after a reversed payment" (included in dueNowPaise).
      'shortfallPaise', greatest(-r.money, 0)::text),
    -- Accounts phase 3 (20261205000230, 6.6): the write-off line and the review flag
    -- (an approved write-off and a balance or credit again; nothing is undone automatically).
    'writeOff', case when v_wo.id is not null then jsonb_build_object(
        'refNo', v_wo.ref_no, 'direction', v_wo.direction, 'amountPaise', v_wo.amount_paise::text, 'status', v_wo.status,
        'reason', v_wo.reason, 'proposedByName', authz.finance_name(v_wo.proposed_by),
        'decidedByName', authz.finance_name(v_wo.decided_by), 'decidedAt', v_wo.decided_at) end,
    'writeOffNeedsReview', v_wo.status is not distinct from 'approved' and (r.balance > 0 or r.credit > 0));
end;
$$;

-- Accounts phase 3 (20261205000230): the adjusted total (LD15): basis total minus
-- an approved 'due' write-off, plus an approved 'excess' write-off. Replaces
-- 20261204000310:125 (same signature).
create or replace function authz.refund_basis_total(p_deal uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select case
    when s.id is not null then s.customer_charge_paise
    else (select coalesce(bc.selling_total_paise, 0)::bigint
          from authz.dues_basis(p_deal) b
          left join public.booking_version_commercials bc on bc.version_id = b.version_id
          limit 1)
  end
  - coalesce((select sum(w.amount_paise) from public.deal_write_offs w
              where w.deal_id = p_deal and w.status = 'approved' and w.direction = 'due'), 0)
  + coalesce((select sum(w.amount_paise) from public.deal_write_offs w
              where w.deal_id = p_deal and w.status = 'approved' and w.direction = 'excess'), 0)
  from (select 1) one left join lateral (select * from authz.refund_settlement(p_deal)) s on true
$$;

-- Replaces 20261204000910:21 (additive keys only).
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
  v_docs uuid[];
  -- Accounts phase 3 (20261205000230)
  v_msgs_failed integer := 0;
  v_queue_minutes integer;
  v_tally_unmatched integer;
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

  v_changed := cardinality(authz.tally_changed_ids(v_a));

  if to_regclass('public.staff_notices') is not null then
    execute $q$
      select coalesce(jsonb_agg(jsonb_build_object('branchName', g.name, 'count', g.n) order by g.name), '[]'::jsonb)
      from (select b.name, sum(x.n)::int as n
            -- 20261204000910: the working-day rule once per (branch, India date), not per notice.
            from (select s.branch_id, (timezone('Asia/Kolkata', s.created_at))::date as d, count(*) as n
                  from public.staff_notices s
                  where s.legal_entity_id = any($1) and s.priority = 'urgent' and s.done_at is null and s.resolved_at is null
                  group by 1, 2) x
            join public.branches b on b.id = x.branch_id
            where authz.finance_add_working_days(x.d, 1) < $2
            group by b.name) g$q$
    into v_urgent using v_a, v_today;
  end if;
  -- Accounts phase 2 (20261204000410): entities with customer documents on.
  select coalesce(array_agg(s.legal_entity_id), array[]::uuid[]) into v_docs
  from public.accounts_settings s where s.legal_entity_id = any(v_a) and s.customer_documents_enabled;

  -- Accounts phase 3 (20261205000230): track A's message queue and track C's
  -- XML file, read only once their tables exist (no hard dependency on file order).
  if to_regclass('public.customer_messages') is not null then
    execute $q$
      select count(*) filter (where m.status = 'failed' and m.failed_at is not null
                                and authz.finance_add_working_days((timezone('Asia/Kolkata', m.failed_at))::date, 1) < $3)::integer,
             (extract(epoch from (now() - min(greatest(m.not_before, coalesce(m.next_attempt_at, m.not_before)))
                filter (where m.status in ('queued', 'sending')
                          and greatest(m.not_before, coalesce(m.next_attempt_at, m.not_before)) <= now()))) / 60)::integer
      from public.customer_messages m join public.deals d on d.id = m.deal_id
      where m.legal_entity_id = any($1) and d.is_synthetic = $2 and m.status in ('failed', 'queued', 'sending')$q$
    into v_msgs_failed, v_queue_minutes using v_a, v_syn, v_today;
  end if;
  if to_regclass('public.tally_match_batches') is not null then
    execute $q$
      select count(*)::integer from public.tally_records t
      where t.legal_entity_id = any($1) and t.xml_export_id is not null and t.status = 'exported'
        and authz.finance_add_working_days((timezone('Asia/Kolkata', t.xml_exported_at))::date, 1) < $2$q$
    into v_tally_unmatched using v_a, v_today;
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
    'originalsMissing', (select count(*) from unnest(v_a) e(id) cross join lateral authz.acct_original_items(e.id, null, 'missing') o
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
    -- Accounts phase 2 (20261204000410): drafts waiting plus verified payments
    -- without an Advance Invoice (documents switched on).
    'documentsToRelease', (
      (select count(*) from public.customer_documents x join public.deals d on d.id = x.deal_id
       where x.legal_entity_id = any(v_docs) and d.is_synthetic = v_syn and x.status = 'draft')
      + (select count(*) from public.customer_receipts r join public.deals d on d.id = r.deal_id
         where r.legal_entity_id = any(v_docs) and d.is_synthetic = v_syn and r.status in ('verified', 'cleared')
           and not exists (select 1 from public.customer_documents x
                           where x.receipt_id = r.id and x.kind = 'advance_invoice' and x.status in ('draft', 'released')))),
    -- Released documents whose last PDF job failed (no file, nothing queued).
    'pdfFailed', (
      select count(distinct j.document_id) from public.customer_document_render_jobs j
      join public.customer_documents x on x.id = j.document_id
      join public.deals d on d.id = x.deal_id
      where j.legal_entity_id = any(v_a) and d.is_synthetic = v_syn and j.status = 'failed'
        and x.status in ('released', 'replaced', 'cancelled')
        and not exists (select 1 from public.customer_document_files f where f.document_id = j.document_id)
        and not exists (select 1 from public.customer_document_render_jobs q
                        where q.document_id = j.document_id and q.status in ('queued', 'running', 'succeeded'))),
    'refundPayoutsDueOverOneWorkingDay', (
      select count(*) from public.customer_refund_requests q join public.deals d on d.id = q.deal_id
      where q.legal_entity_id = any(v_a) and d.is_synthetic = v_syn and q.status = 'approved' and q.outcome = 'payout'
        and authz.finance_add_working_days((timezone('Asia/Kolkata', q.decided_at))::date, 1) < v_today),
    -- Addendum L1: supplier refunds are verified when recorded; nothing waits for a second person.
    'supplierRefundsToVerify', 0,
    -- 20261204000910: authz.notice_supplier_refund_open(c.id) per cancellation
    -- (authz.supplier_refund_sources per Deal) computed once for all candidate
    -- Deals: the same latest revision per task / ticket batch / Visa entry
    -- within each Deal, the same verified receipts per source group, the same
    -- "expected > 0 and received < expected" over the cancellation's sources.
    'supplierRefundsDue', (
      with cand as (
        select c.id, c.deal_id from public.deal_cancellations c join public.deals d on d.id = c.deal_id
        where c.legal_entity_id = any(v_a) and d.is_synthetic = v_syn and c.status = 'approved'),
      allc as (
        select x.id, x.deal_id from public.deal_cancellations x where x.deal_id in (select cand.deal_id from cand)),
      src as (
        select distinct on (allc.deal_id, pc.task_id) allc.deal_id, pc.cancellation_id, 'purchase_charge'::text as source_kind,
          pc.task_id as source_group_id, pc.supplier_refund_paise as expected_paise
        from public.purchase_cancellation_charges pc join allc on allc.id = pc.cancellation_id
        order by allc.deal_id, pc.task_id, pc.revision_no desc),
      fsrc as (
        select distinct on (allc.deal_id, fc.batch_id) allc.deal_id, fc.cancellation_id, 'flight_charge'::text, fc.batch_id,
          fc.refund_expected_paise
        from public.flight_cancellation_charges fc join allc on allc.id = fc.cancellation_id
        order by allc.deal_id, fc.batch_id, fc.revision_no desc),
      vsrc as (
        select distinct on (allc.deal_id, vf.entry_id) allc.deal_id, vf.cancellation_id, 'visa_fee'::text, vf.entry_id,
          vf.refund_expected_paise
        from public.visa_cancellation_fees vf join allc on allc.id = vf.cancellation_id
        order by allc.deal_id, vf.entry_id, vf.revision_no desc),
      u as (select * from src union all select * from fsrc union all select * from vsrc),
      rec as (
        select r.deal_id, r.source_kind, r.source_group_id, sum(r.amount_paise) as received_paise
        from public.supplier_refund_receipts r
        where r.status = 'verified' and r.deal_id in (select cand.deal_id from cand)
        group by r.deal_id, r.source_kind, r.source_group_id),
      per as (
        select u.cancellation_id, coalesce(sum(u.expected_paise), 0) as expected,
          coalesce(sum(coalesce(rec.received_paise, 0)), 0) as received
        from u left join rec on rec.deal_id = u.deal_id and rec.source_kind = u.source_kind
                            and rec.source_group_id = u.source_group_id
        group by u.cancellation_id)
      select count(*) from cand join per on per.cancellation_id = cand.id
      where per.expected > 0 and per.received < per.expected),
    -- Accounts phase 3 (20261205000230, 6.5): automatic bills held for more than one working day.
    'billsHeldOverOneWorkingDay', (
      select count(*) from public.customer_documents x join public.deals d on d.id = x.deal_id
      where x.legal_entity_id = any(v_a) and d.is_synthetic = v_syn and x.status = 'draft' and x.auto_state = 'held'
        and authz.finance_add_working_days((timezone('Asia/Kolkata', x.created_at))::date, 1) < v_today),
    'customerMessagesFailedOverOneWorkingDay', v_msgs_failed,
    -- null until track C's XML file exists.
    'tallyFileUnmatchedOverOneWorkingDay', v_tally_unmatched,
    -- Minutes the oldest due customer message has waited (null: none waiting).
    'messageQueueOldestMinutes', v_queue_minutes,
    -- Approved write-offs whose Deal has a balance or credit again (needs review), plus proposals waiting for a decision.
    'writeOffsToReview', (
      with w as (
        select w.deal_id, w.status, w.direction, w.amount_paise
        from public.deal_write_offs w join public.deals d on d.id = w.deal_id
        where w.legal_entity_id = any(v_a) and d.is_synthetic = v_syn and w.status in ('proposed', 'approved')),
      appr as (
        select w.deal_id, w.direction, w.amount_paise,
          coalesce((select max(q.customer_charge_paise) from public.customer_refund_requests q
                    where q.deal_id = w.deal_id and q.kind = 'cancellation' and q.status in ('approved', 'paid')),
                   (select bc.selling_total_paise from public.booking_versions v
                    join public.accounts_booking_reviews rv on rv.booking_version_id = v.id
                    join public.booking_version_commercials bc on bc.version_id = v.id
                    where v.deal_id = w.deal_id and v.status in ('confirmed', 'superseded') and rv.last_approved_at is not null
                    order by v.version_no desc limit 1),
                   (select bc.selling_total_paise from public.booking_versions v
                    join public.booking_version_commercials bc on bc.version_id = v.id
                    where v.deal_id = w.deal_id and v.status = 'confirmed'), 0)::bigint as total,
          coalesce((select sum(l.credit_paise - l.debit_paise) from public.finance_journal_lines l
                    where l.deal_id = w.deal_id and l.account = 'customer_advances'), 0)::bigint as money
        from w where w.status = 'approved')
      select (select count(*) from w where w.status = 'proposed')::integer
        + (select count(*) from appr a
           where a.money < 0
              or greatest(a.money, 0) <> a.total - case when a.direction = 'due' then a.amount_paise else -a.amount_paise end)::integer),
    'filters', jsonb_build_object(
      'exceptionsOpen', jsonb_build_object('tallyStatus', 'exception'),
      'changedAfterExport', jsonb_build_object('changedSinceExport', true),
      'originalsMissing', jsonb_build_object('originals', 'missing'),
      'receiptsAwaitingVerificationOverOneWorkingDay', jsonb_build_object('overdueCheck', 'receipts_unverified'),
      'paymentsApprovedNotRecordedOverOneWorkingDay', jsonb_build_object('overdueCheck', 'payments_unrecorded')));
end;
$$;

commit;
