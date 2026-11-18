-- Accounts phase 2, Track C (contract sections 4, 7.1 journal, 7.2 dues and
-- supplier-money, 7.6, LD3, LD6, LD10, LD30): the refund journal kinds, dues
-- after a settlement, supplier payments never spending refunded money, and
-- the credit-note sources (replaces Track B's stub).
--
-- * authz.finance_check_entry (replaces 20261101000100): refund branch -- the
--   payout exists and points back at the entry, same entity / Deal / branch,
--   business_date = paid_on, refund_cash <=> mode cash, lines Dr
--   customer_advances / Cr bank (or cash_in_hand) for the payout amount.
--   Every other branch unchanged.
-- * authz.finance_post: the nine-argument form (20261101000100) is unchanged
--   for its kinds and refuses refund kinds; a NEW ten-argument overload adds
--   p_refund_payout (the refund entry needs its payout id at insert, and the
--   journal is append-only). refund_cash takes the cash-branch lock (LD30).
-- * authz.sm_customer_money_available (replaces 20261130000200): minus the
--   Deal's posted refund payouts.
-- * authz.dues_compute (replaces 20261203000290), public.deal_dues (replaces
--   20261203000260): after an approved cancellation settlement total = its
--   customer charge, plan ignored, basis 'cancelled' (LD10); deal_dues adds
--   refunds {live, paidPaise, keptAsCreditPaise}. Same signatures and columns.
-- * authz.cdoc_credit_note_source(p_refund_request uuid) returns jsonb
--   (replaces Track B's stub, 7.6): {amountPaise, creditsDocumentId,
--   reasonWords, creditedAdvanceNumbers} or null.
--
-- Refusal tokens: none new (journal_shape 23514 stays the shape refusal).
-- Rollback (forward-only): a NEW migration restoring the previous bodies
-- (20261101000100 finance_check_entry / finance_post, 20261130000200
-- sm_customer_money_available, 20261203000290 dues_compute, 20261203000260
-- deal_dues, Track B's stub) and dropping the ten-argument finance_post.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Journal shape check and posting
-- ===========================================================================

create or replace function authz.finance_check_entry(p_entry uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e public.finance_journal_entries%rowtype;
  r public.customer_receipts%rowtype;
  d public.cash_deposits%rowtype;
  p public.customer_refund_payouts%rowtype;
  v_amount bigint;
  v_expected jsonb;
  v_actual jsonb;
  v_ok boolean := true;
begin
  select * into e from public.finance_journal_entries j where j.id = p_entry;
  if e.id is null then
    raise exception 'journal_shape' using errcode = '23514';
  end if;
  if e.kind = 'deposit' then
    select * into d from public.cash_deposits x where x.id = e.deposit_id;
    v_ok := d.id is not null and d.status = 'verified' and e.deal_id is null and e.branch_id = d.branch_id
      and e.business_date = d.deposited_on and e.legal_entity_id = d.legal_entity_id;
    v_amount := d.total_paise;
  elsif e.kind in ('refund_bank', 'refund_cash') then
    -- Accounts phase 2 (20261204000320): a customer refund payout.
    select * into p from public.customer_refund_payouts x where x.id = e.refund_payout_id;
    v_ok := p.id is not null and p.journal_entry_id = e.id and e.receipt_id is null and e.deposit_id is null
      and e.reverses_entry_id is null and e.deal_id = p.deal_id and e.branch_id = p.branch_id
      and e.legal_entity_id = p.legal_entity_id and e.business_date = p.paid_on
      and ((e.kind = 'refund_cash') = (p.mode = 'cash'))
      and exists (select 1 from public.customer_refund_requests q
                  where q.id = p.refund_request_id and q.deal_id = p.deal_id and q.outcome = 'payout'
                    and q.amount_paise = p.amount_paise);
    v_amount := p.amount_paise;
  else
    select * into r from public.customer_receipts x where x.id = e.receipt_id;
    v_ok := r.id is not null and e.deal_id = r.deal_id and e.branch_id = r.branch_id
      and e.legal_entity_id = r.legal_entity_id;
    v_amount := r.amount_paise;
    if v_ok and e.kind in ('receipt_bank', 'receipt_cash') then
      v_ok := e.business_date = r.received_on and e.reverses_entry_id is null
        and ((e.kind = 'receipt_cash' and r.mode = 'cash') or (e.kind = 'receipt_bank' and r.mode <> 'cash'));
    elsif v_ok then
      -- Reverses this receipt's own receipt entry, on the IST date of the
      -- reversal, with the custody path its deposit membership implies.
      v_ok := exists (
        select 1 from public.finance_journal_entries o
        where o.id = e.reverses_entry_id and o.receipt_id = e.receipt_id
          and o.kind = case when e.kind = 'reversal_bank' then 'receipt_bank' else 'receipt_cash' end)
        and e.business_date = (e.posted_at at time zone 'Asia/Kolkata')::date
        and r.status = 'reversed'
        and case e.kind
          when 'reversal_bank' then r.mode <> 'cash'
          when 'reversal_cash_deposited' then r.mode = 'cash'
            and authz.finance_receipt_deposit_status(r.id) is not distinct from 'verified'
          else r.mode = 'cash' and authz.finance_receipt_deposit_status(r.id) is null
        end;
    end if;
  end if;
  if not v_ok or v_amount is null then
    raise exception 'journal_shape' using errcode = '23514';
  end if;

  v_expected := case e.kind
    when 'receipt_bank' then jsonb_build_array(jsonb_build_array('bank', v_amount, 0), jsonb_build_array('customer_advances', 0, v_amount))
    when 'receipt_cash' then jsonb_build_array(jsonb_build_array('cash_in_hand', v_amount, 0), jsonb_build_array('customer_advances', 0, v_amount))
    when 'deposit' then jsonb_build_array(jsonb_build_array('bank', v_amount, 0), jsonb_build_array('cash_in_hand', 0, v_amount))
    when 'reversal_cash_undeposited' then jsonb_build_array(jsonb_build_array('cash_in_hand', 0, v_amount), jsonb_build_array('customer_advances', v_amount, 0))
    -- Accounts phase 2 (20261204000320): money leaves cash in hand for a cash refund.
    when 'refund_cash' then jsonb_build_array(jsonb_build_array('cash_in_hand', 0, v_amount), jsonb_build_array('customer_advances', v_amount, 0))
    -- reversal_bank, reversal_cash_deposited and refund_bank: Dr customer advances, Cr bank.
    else jsonb_build_array(jsonb_build_array('bank', 0, v_amount), jsonb_build_array('customer_advances', v_amount, 0))
  end;
  select jsonb_agg(jsonb_build_array(l.account, l.debit_paise, l.credit_paise) order by l.account, l.debit_paise, l.credit_paise)
  into v_actual
  from public.finance_journal_lines l
  where l.entry_id = e.id;
  if v_actual is distinct from v_expected
     or exists (select 1 from public.finance_journal_lines l
                where l.entry_id = e.id and (l.deal_id is distinct from e.deal_id or l.branch_id <> e.branch_id)) then
    raise exception 'journal_shape' using errcode = '23514';
  end if;
end;
$$;

-- Ten-argument form (new): every kind; refund kinds carry their payout id.
create function authz.finance_post(
  p_kind text, p_entity uuid, p_receipt uuid, p_deposit uuid, p_deal uuid, p_branch uuid,
  p_business_date date, p_reverses uuid, p_amount bigint, p_refund_payout uuid
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid;
  v_debit text;
  v_credit text;
begin
  -- Accounts phase 2 (20261204000320, LD30): a cash refund takes the branch cash lock too.
  if p_kind in ('receipt_cash', 'deposit', 'reversal_cash_undeposited', 'refund_cash') then
    perform pg_advisory_xact_lock(hashtextextended('cash-branch|' || p_branch::text, 0));
  end if;
  insert into public.finance_journal_entries (legal_entity_id, kind, receipt_id, deposit_id, deal_id, branch_id,
    business_date, reverses_entry_id, posted_by, refund_payout_id)
  values (p_entity, p_kind, p_receipt, p_deposit, p_deal, p_branch, p_business_date, p_reverses, (select auth.uid()),
    p_refund_payout)
  returning id into v_id;
  select x.debit, x.credit into v_debit, v_credit from (values
    ('receipt_bank', 'bank', 'customer_advances'),
    ('receipt_cash', 'cash_in_hand', 'customer_advances'),
    ('deposit', 'bank', 'cash_in_hand'),
    ('reversal_bank', 'customer_advances', 'bank'),
    ('reversal_cash_deposited', 'customer_advances', 'bank'),
    ('reversal_cash_undeposited', 'customer_advances', 'cash_in_hand'),
    ('refund_bank', 'customer_advances', 'bank'),
    ('refund_cash', 'customer_advances', 'cash_in_hand')
  ) as x (kind, debit, credit) where x.kind = p_kind;
  insert into public.finance_journal_lines (entry_id, account, deal_id, branch_id, debit_paise, credit_paise) values
    (v_id, v_debit, p_deal, p_branch, p_amount, 0),
    (v_id, v_credit, p_deal, p_branch, 0, p_amount);
  return v_id;
end;
$$;

-- Nine-argument form (20261101000100 signature): unchanged kinds; refunds need the ten-argument form.
create or replace function authz.finance_post(
  p_kind text, p_entity uuid, p_receipt uuid, p_deposit uuid, p_deal uuid, p_branch uuid,
  p_business_date date, p_reverses uuid, p_amount bigint
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_kind like 'refund%' then
    raise exception 'journal_shape' using errcode = '23514';
  end if;
  return authz.finance_post(p_kind, p_entity, p_receipt, p_deposit, p_deal, p_branch, p_business_date, p_reverses, p_amount,
    null::uuid);
end;
$$;

-- ===========================================================================
-- 2. Supplier payments never spend money already returned (7.2)
-- ===========================================================================

create or replace function authz.sm_customer_money_available(p_deal uuid, p_exclude uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(r.amount_paise) from public.customer_receipts r
                   where r.deal_id = p_deal and r.status in ('verified', 'cleared')), 0)
       - coalesce((select sum(p.customer_money_paise) from public.supplier_payment_requests p
                   where p.deal_id = p_deal and p.status in ('pending', 'approved', 'paid', 'verified')
                     and p.id is distinct from p_exclude), 0)
       - coalesce((select sum(f.amount_paise) from public.company_funding_requests f
                   where f.deal_id = p_deal and f.status = 'recovered'), 0)
       -- Accounts phase 2 (20261204000320): posted customer refunds.
       - coalesce((select sum(x.amount_paise) from public.customer_refund_payouts x where x.deal_id = p_deal), 0)
$$;

-- ===========================================================================
-- 3. Dues after a settlement (LD10)
-- ===========================================================================

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
    order by r.deal_id, r.decided_at desc, r.id desc
  ), money as (
    select l.deal_id, sum(l.credit_paise - l.debit_paise)::bigint as m
    from public.finance_journal_lines l join basis b on b.id = l.deal_id
    where l.account = 'customer_advances'
    group by l.deal_id
  ), charged as (
    select b.*, st.deal_id is not null as settled,
      -- Accounts phase 2 (20261204000320): settled total = the approved customer charge.
      coalesce(st.customer_charge_paise, bc.selling_total_paise, 0)::bigint as total, coalesce(mo.m, 0)::bigint as money,
      greatest(coalesce(mo.m, 0), 0)::bigint as mpos
    from basis b
    left join public.booking_version_commercials bc on bc.version_id = b.version_id
    left join money mo on mo.deal_id = b.id
    left join settle st on st.deal_id = b.id
  ), inst as (
    select c.id as deal_id, i.seq, i.due_date, i.amount_paise,
      least(i.amount_paise, greatest(c.mpos - coalesce(sum(i.amount_paise) over (
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
              least(i.amount_paise, greatest(greatest(r.money, 0) - coalesce(sum(i.amount_paise) over (
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
      'keptAsCreditPaise', (select coalesce(sum(q.amount_paise), 0)::text from public.customer_refund_requests q
                            where q.deal_id = v_deal.id and q.outcome = 'keep_credit' and q.status = 'approved')));
end;
$$;
-- ===========================================================================
-- 4. Credit-note sources (7.6, LD3, LD6; replaces Track B's stub)
-- ===========================================================================

-- 1. An approved cancellation settlement (any outcome) and a released Invoice:
--    invoice total - customer charge - released credit notes on that Invoice,
--    offered when > 0 (also without a refund: charge_only, keep_credit).
-- 2. No released Invoice, a paid payout and released Advance Invoices: the
--    refund amount, crediting those Advance Invoices.
-- 3. An overpayment refund with an Invoice: none (the Invoice is right).
-- Null once a credit note for this request is released, or for any other case.
-- Dropped first: Track B's stub may name its parameter differently (a rename
-- is refused by create or replace); plpgsql callers bind at run time.
drop function if exists authz.cdoc_credit_note_source(uuid);
create function authz.cdoc_credit_note_source(p_refund_request uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r public.customer_refund_requests%rowtype;
  v_invoice uuid;
  v_invoice_total bigint;
  v_credited bigint;
  v_amount bigint;
  v_advances jsonb;
begin
  select * into r from public.customer_refund_requests x where x.id = p_refund_request;
  if r.id is null or r.status not in ('approved', 'paid') or to_regclass('public.customer_documents') is null then
    return null;
  end if;
  if exists (select 1 from public.customer_documents c
             where c.refund_request_id = r.id and c.kind = 'credit_note' and c.status = 'released') then
    return null;
  end if;
  select c.id, c.total_paise into v_invoice, v_invoice_total from public.customer_documents c
  where c.deal_id = r.deal_id and c.kind = 'invoice' and c.status = 'released'
  order by c.released_at desc, c.id desc limit 1;
  if v_invoice is not null then
    if r.kind <> 'cancellation' then
      return null;
    end if;
    select coalesce(sum(c.total_paise), 0)::bigint into v_credited from public.customer_documents c
    where c.credits_document_id = v_invoice and c.kind = 'credit_note' and c.status = 'released';
    v_amount := v_invoice_total - r.customer_charge_paise - v_credited;
    if v_amount <= 0 then
      return null;
    end if;
    return jsonb_build_object('amountPaise', v_amount::text, 'creditsDocumentId', v_invoice,
      'reasonWords', 'trip cancellation', 'creditedAdvanceNumbers', '[]'::jsonb);
  end if;
  if r.outcome <> 'payout' or r.status <> 'paid' then
    return null;
  end if;
  select jsonb_agg(c.number order by c.seq, c.number) into v_advances from public.customer_documents c
  where c.deal_id = r.deal_id and c.kind = 'advance_invoice' and c.status = 'released' and c.number is not null;
  if v_advances is null then
    return null;
  end if;
  return jsonb_build_object('amountPaise', r.amount_paise::text, 'creditsDocumentId', null,
    'reasonWords', case when r.kind = 'cancellation' then 'trip cancellation refund' else 'refund of excess payment' end,
    'creditedAdvanceNumbers', v_advances);
end;
$$;

revoke all on function
  authz.finance_post(text, uuid, uuid, uuid, uuid, uuid, date, uuid, bigint, uuid),
  authz.cdoc_credit_note_source(uuid)
from public, anon, authenticated, service_role;

commit;
