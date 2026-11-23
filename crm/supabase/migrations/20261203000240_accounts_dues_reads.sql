-- Accounts phase, Track B (5 of 6): dues and supplier payables reads.
-- Contract: implementation/accounts-phase-2026-11-10/contract.md sections
-- 4.4, 8.3, R16.1, R16.3, R16.9, R16.11, AL3, AL5, AL8 (frozen 10 Nov 2026;
-- lead decision: a Deal never approved by Accounts is labelled
-- "Provisional - booking not yet approved by Accounts").
--
-- Rules (the database is the authority; crm/src/modules/accounts-desk/dues.ts
-- mirrors them for display and unit tests):
--   * Basis: the most recently confirmed version (confirmed or superseded)
--     whose review has last_approved_at (approved basis); otherwise the
--     current confirmed version (awaiting_review, provisional). No confirmed
--     version: the Deal is not in dues. newerVersionPending = the current
--     confirmed version is later than the approved basis.
--   * Charges: selling_total_paise of the basis version and its instalments
--     ordered (due_date, seq).
--   * Money: the customer_advances journal balance of the Deal (verified
--     receipts, cleared cheques, minus reversals) - never
--     authz.sm_customer_money_available, so a supplier payment or company
--     funding never changes dues. Allocation uses greatest(money, 0).
--   * Not money: reported claims (status 'reported' only), receipts awaiting
--     verification; shown, never subtracted.
--   * Allocation oldest due first; instalment status paid / overdue (due
--     before today IST) / due_now (due today) / upcoming; Deal status, first
--     match: credit, overdue, due_now, unallocated, no_plan, upcoming, paid.
--   * Dues belong to the Deal's branch (a receipt collected elsewhere still
--     counts on the Deal).
--   * Supplier payables: requested (pending + approved), paid (paid +
--     verified requests + accepted flight direct payments), verified,
--     invoiced (accepted), credit notes (accepted), invoices uploaded -
--     side by side, never a difference (H10).
--
-- New reads (security definer, execute to authenticated):
--   public.accounts_dues(p_filter jsonb, p_after text, p_limit integer)   A, M (own branches), SO (own Deals)
--   public.deal_dues(p_deal_id uuid)                                       A, M (branch), Sales money-card readers
--   public.accounts_supplier_payables(p_deal_id uuid)                      A, M (branch)
-- Each returns null when the caller may not read it. Purchase, Flight and
-- Visa holders never read dues.
--
-- Refusal tokens: 22023 invalid_input (hint = filter key or 'after').
-- Rollback (forward-only): a NEW migration revoking execute on the three reads.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Readers
-- ===========================================================================

-- SO: entities where the caller holds an active Sales role and no purchase,
-- flight or visa membership, and the finance gate passes.
create function authz.dues_so_entities() returns uuid[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(e.id), array[]::uuid[])
  from public.legal_entities e
  where coalesce(authz.session_ok(), false)
    and authz.holds_active_role('sales', e.id)
    and authz.finance_enabled(e.id)
    and authz.finance_gate_issue(e.id, null) is null
    and not exists (select 1 from public.memberships m
                    where m.user_id = (select auth.uid()) and m.legal_entity_id = e.id
                      and m.role_code in ('purchase', 'flight', 'visa') and m.status = 'active')
$$;

-- Basis version of one Deal (contract 4.4).
create function authz.dues_basis(p_deal uuid) returns table (version_id uuid, basis text)
language sql stable security definer set search_path = '' as $$
  select coalesce(a.id, c.id), case when a.id is not null then 'approved' else 'awaiting_review' end
  from (select v.id, v.version_no from public.booking_versions v where v.deal_id = p_deal and v.status = 'confirmed') c
  left join lateral (
    select v.id, v.version_no from public.booking_versions v
    join public.accounts_booking_reviews rv on rv.booking_version_id = v.id
    where v.deal_id = p_deal and v.status in ('confirmed', 'superseded') and rv.last_approved_at is not null
    order by v.version_no desc limit 1) a on true
$$;

-- ===========================================================================
-- 2. Set-based computation over the scoped Deals
-- ===========================================================================

create function authz.dues_compute(p_a uuid[], p_m uuid[], p_so_entities uuid[], p_syn boolean, p_deal uuid, p_force boolean)
returns table (
  deal_id uuid, reference text, branch_id uuid, owner_user_id uuid, legal_entity_id uuid,
  version_id uuid, version_no integer, basis text, last_approved_at timestamptz, newer_pending boolean,
  total bigint, money bigint, balance bigint, overdue bigint, due_now bigint, next_due_date date, next_due_open bigint,
  oldest_open date, reported bigint, awaiting bigint, credit bigint, has_plan boolean, status text, rank integer,
  cancellation text, is_a boolean, is_m boolean)
language sql stable security definer set search_path = '' as $$
  with scope as (
    select d.id, d.reference, d.branch_id, d.owner_user_id, d.legal_entity_id,
      d.legal_entity_id = any(p_a) as is_a, d.branch_id = any(p_m) as is_m
    from public.deals d
    where d.is_synthetic = p_syn
      and (p_deal is null or d.id = p_deal)
      and ((p_deal is not null and p_force)
           or d.legal_entity_id = any(p_a)
           or d.branch_id = any(p_m)
           or (d.owner_user_id = (select auth.uid()) and d.legal_entity_id = any(p_so_entities)))
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
    select c.id,
      coalesce((select sum(cl.amount_paise) from public.customer_payment_claims cl
                where cl.deal_id = c.id and cl.status = 'reported'), 0)::bigint as reported,
      coalesce((select sum(r.amount_paise) from public.customer_receipts r
                where r.deal_id = c.id and r.status = 'recorded' and r.mode <> 'cheque'), 0)::bigint as awaiting,
      (select case when bool_or(dc.status <> 'approved') then 'open' when bool_or(dc.status = 'approved') then 'approved' end
       from public.deal_cancellations dc where dc.deal_id = c.id) as cancellation
    from charged c
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
$$;

-- Row JSON of one computed Deal (contract 8.3 row).
create function authz.dues_row_json(
  p_deal uuid, p_reference text, p_branch uuid, p_owner uuid, p_version_no integer, p_basis text, p_last_approved timestamptz,
  p_newer boolean, p_total bigint, p_money bigint, p_balance bigint, p_overdue bigint, p_due_now bigint, p_next_date date,
  p_next_open bigint, p_reported bigint, p_awaiting bigint, p_credit bigint, p_status text, p_cancellation text)
returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'dealId', p_deal,
    'dealReference', p_reference,
    'branchName', (select b.name from public.branches b where b.id = p_branch),
    'ownerName', (select s.display_name from public.staff_profiles s where s.user_id = p_owner),
    'basis', jsonb_build_object('versionNo', p_version_no, 'kind', p_basis, 'newerVersionPending', p_newer,
      'provisional', p_basis = 'awaiting_review', 'lastApprovedAt', p_last_approved),
    'totalPaise', p_total::text,
    'verifiedPaise', p_money::text,
    'balancePaise', p_balance::text,
    'overduePaise', p_overdue::text,
    'dueNowPaise', p_due_now::text,
    'nextDue', case when p_next_date is null then null
      else jsonb_build_object('date', to_char(p_next_date, 'YYYY-MM-DD'), 'openPaise', p_next_open::text) end,
    'reportedPaise', p_reported::text,
    'awaitingVerificationPaise', p_awaiting::text,
    'creditPaise', p_credit::text,
    'status', p_status,
    'reported', p_reported > 0,
    'cancellation', p_cancellation)
$$;

-- Supplier payables of one Deal, per supplier, side by side (no difference).
create function authz.dues_supplier_payables(p_deal uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'supplierId', s.id, 'supplierName', s.name,
      'requestedLivePaise', x.requested::text, 'paidPaise', x.paid::text, 'verifiedPaise', x.verified::text,
      'invoicedAcceptedPaise', x.invoiced::text, 'creditNotesAcceptedPaise', x.credits::text,
      'invoicesUploadedPaise', x.uploaded::text) order by s.name, s.id), '[]'::jsonb)
  from (
    select u.supplier_id,
      coalesce(sum(u.requested), 0)::bigint as requested, coalesce(sum(u.paid), 0)::bigint as paid,
      coalesce(sum(u.verified), 0)::bigint as verified, coalesce(sum(u.invoiced), 0)::bigint as invoiced,
      coalesce(sum(u.credits), 0)::bigint as credits, coalesce(sum(u.uploaded), 0)::bigint as uploaded
    from (
      select p.supplier_id,
        case when p.status in ('pending', 'approved') then p.amount_paise end as requested,
        case when p.status in ('paid', 'verified') then p.amount_paise end as paid,
        case when p.status = 'verified' then p.amount_paise end as verified,
        null::bigint as invoiced, null::bigint as credits, null::bigint as uploaded
      from public.supplier_payment_requests p where p.deal_id = p_deal
      union all
      select c.supplier_id, null, c.amount_paise, null, null, null, null
      from public.department_cost_entries c
      where c.deal_id = p_deal and c.department = 'flight' and c.paid_by = 'company' and c.supplier_id is not null
        and c.expense_status = 'accepted'
      union all
      select x.supplier_id, null, null, null,
        case when x.kind = 'invoice' and x.status = 'accepted' then x.total_paise end,
        case when x.kind = 'credit_note' and x.status = 'accepted' then x.total_paise end,
        case when x.kind = 'invoice' and x.status = 'uploaded' then x.total_paise end
      from public.supplier_documents x where x.deal_id = p_deal
    ) u group by u.supplier_id
  ) x
  join public.suppliers s on s.id = x.supplier_id
$$;

-- ===========================================================================
-- 3. Public reads
-- ===========================================================================

create function public.accounts_dues(p_filter jsonb, p_after text default null, p_limit integer default 50) returns jsonb
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

  with rows as (
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

create function public.deal_dues(p_deal_id uuid) returns jsonb
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
            from public.booking_version_instalments i where i.booking_version_id = r.version_id) x), '[]'::jsonb),
    'tallyInvoices', coalesce((
      select jsonb_agg(jsonb_build_object('id', g.id, 'invoiceRef', g.invoice_ref, 'invoiceDate', to_char(g.invoice_date, 'YYYY-MM-DD'),
          'status', g.status, 'rowVersion', g.row_version,
          'tallyStatus', case when g.status = 'withdrawn' then 'not_applicable' else coalesce(tr.status, 'matched') end)
        order by g.invoice_date, g.created_at)
      from public.deal_tally_invoices g
      left join public.tally_records tr on tr.record_kind = 'tally_gst_invoice' and tr.record_id = g.id
      where g.deal_id = v_deal.id), '[]'::jsonb),
    'supplierPayables', case when r.is_a or r.is_m then authz.dues_supplier_payables(v_deal.id) end,
    -- Addition to 8.3 (lead OK needed): the caller is Accounts of the Deal's entity (T4 allowed).
    'canAddTallyInvoice', r.is_a);
end;
$$;

create function public.accounts_supplier_payables(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_syn boolean;
begin
  if p_deal_id is null or not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  v_syn := authz.acct_synthetic();
  if v_deal.id is null or v_syn is null or v_deal.is_synthetic is distinct from v_syn
     or not (v_deal.legal_entity_id = any(authz.acct_a_entities()) or v_deal.branch_id = any(authz.acct_m_branches())) then
    return null;
  end if;
  return jsonb_build_object('dealId', v_deal.id, 'dealReference', v_deal.reference,
    'suppliers', authz.dues_supplier_payables(v_deal.id));
end;
$$;

revoke all on function authz.dues_so_entities(), authz.dues_basis(uuid),
  authz.dues_compute(uuid[], uuid[], uuid[], boolean, uuid, boolean),
  authz.dues_row_json(uuid, text, uuid, uuid, integer, text, timestamptz, boolean, bigint, bigint, bigint, bigint, bigint, date,
    bigint, bigint, bigint, bigint, text, text),
  authz.dues_supplier_payables(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.accounts_dues(jsonb, text, integer), public.deal_dues(uuid), public.accounts_supplier_payables(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.accounts_dues(jsonb, text, integer), public.deal_dues(uuid), public.accounts_supplier_payables(uuid)
  to authenticated;

commit;
