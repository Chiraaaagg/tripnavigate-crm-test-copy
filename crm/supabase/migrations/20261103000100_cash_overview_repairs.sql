-- TripNavigate CRM - Phase 5B Milestone A: cash overview repairs and Accounts
-- queue bounds.
--
-- Contract: docs/implementation/next/phase-5b-milestone-a.md sections 2 and 3
-- (FROZEN 7 Oct 2026); audit findings 6, 7 and 12 in
-- docs/implementation/next/2026-10-07-audit-and-decisions.md.
-- Shared result shapes: crm/src/modules/finance/contracts.ts.
--
-- 20261101000100_accounts_receipts is applied to the hosted database and is
-- never edited; this forward-only migration replaces only the functions whose
-- behaviour changes. No table, index, policy or data row is touched.
--
-- What changes:
--   * authz.finance_unresolved_json(uuid, uuid) now returns an object
--     { unresolved, unresolvedTotals, oldestUnresolvedDate, unresolvedTruncated }
--     instead of a bare array, and builds reconciliation obligations as:
--       - an obligation for IST business date D (up to yesterday) when the
--         policy in force at the end of D requires reconciliation and the
--         branch had cash activity on D, held a non-zero posted cash_in_hand
--         balance at the end of D, or still has recorded-unverified cash
--         received on or before D (contract section 11). A branch holding no
--         cash has no daily obligation. Dates before the first policy version
--         use the first version. Obligations never expire with age (the old
--         60-day window is gone).
--       - state per obligation: missing (no row), awaiting_verification
--         (current row recorded), stale (every row for D is stale) or verified
--         (current row verified). Only verified clears the obligation.
--       - a stale reconciliation for a date that is not (yet) an obligation,
--         for example today, is still listed as stale, as before.
--     Display is bounded to 50 items per kind (oldest first); the totals,
--     the oldest date per kind and the truncated flag cover every item.
--   * authz.finance_cash_branch_json(uuid, uuid) merges those four keys into
--     each branch. accounts_cash_overview(uuid) itself is unchanged.
--   * New helper authz.finance_reconciliation_obligations(uuid) (set-based,
--     no API grant), used by both the overview and the record command.
--   * public.cash_reconciliation_record(uuid, date, bigint, text, uuid)
--     (same signature): a second current (non-stale) reconciliation for a
--     date is refused with wrong_state before any other date check, for every
--     date. A business date older than 90 days is accepted when it is an
--     obligation for the branch or every existing row for it is stale, so no
--     listed item is left without a way to clear it. Every other rule is
--     unchanged.
--   * public.accounts_queue(text) is replaced by
--     public.accounts_queue(p_filter text, p_after text default null,
--     p_limit integer default 50) returning
--     { items, hasMore, nextAfter, totalCount }, ordered by deal reference
--     then deal id, p_limit clamped to 1..100 (null = 50). p_after is the
--     opaque cursor "<dealId>:<dealReference>" of the previous page's last
--     item; a malformed cursor is invalid_input (22023). The old one-argument
--     function is dropped so a call with only p_filter is not ambiguous.
--
-- Grants: the new accounts_queue gets exactly the old grant (execute to
-- authenticated only). Replaced authz functions keep their privileges.
--
-- Rollback (forward-only): a NEW migration that restores the previous
-- function bodies from 20261101000100 (and recreates accounts_queue(text)).
-- Late reconciliations recorded under the extension stay valid rows.
-- No data depends on these functions.

begin;

-- ---------------------------------------------------------------------------
-- Reconciliation obligations (contract sections 2 and 11)
-- ---------------------------------------------------------------------------

-- Every IST business date D, up to yesterday, that is a reconciliation
-- obligation for the branch, whatever its state. D is an obligation when the
-- policy in force at the end of D (the IST midnight that ends it) requires
-- reconciliation and, on D, the branch
--   * had cash activity (a cash receipt received on D or a cash_in_hand
--     posting with business date D), or
--   * held a non-zero posted cash_in_hand balance at the end of D, or
--   * still has recorded-unverified cash received on or before D.
-- A branch holding no cash creates no daily obligation. Dates before the
-- entity's first policy version use the first version; no policy at all
-- counts as required (fail towards showing work). Set-based: one pass over
-- the generated days with a range join to the policy versions.
create function authz.finance_reconciliation_obligations(p_branch uuid) returns table (business_date date)
language sql stable security definer set search_path = '' as $$
  with branch as (
    select b.id, b.legal_entity_id from public.branches b where b.id = p_branch
  ), activity as (
    select r.received_on as d from public.customer_receipts r where r.branch_id = p_branch and r.mode = 'cash'
    union
    select e.business_date from public.finance_journal_entries e
    join public.finance_journal_lines l on l.entry_id = e.id
    where l.branch_id = p_branch and l.account = 'cash_in_hand'
  ), net as (
    select e.business_date as d, sum(l.debit_paise - l.credit_paise) as net
    from public.finance_journal_entries e
    join public.finance_journal_lines l on l.entry_id = e.id
    where l.branch_id = p_branch and l.account = 'cash_in_hand'
    group by e.business_date
  ), pending as (
    select min(r.received_on) as first_d from public.customer_receipts r
    where r.branch_id = p_branch and r.mode = 'cash' and r.status = 'recorded'
  ), days as (
    -- Every date from the first cash activity up to yesterday (IST). Every
    -- posting date is an activity date, so the running sum is the balance.
    select g.d::date as d
    from (select min(a.d) as first_d from activity a) f,
         generate_series(f.first_d::timestamp, (authz.finance_today() - 1)::timestamp, interval '1 day') g(d)
    where f.first_d is not null
  ), daily as (
    select x.d, a.d is not null as active,
           sum(coalesce(n.net, 0)) over (order by x.d) as balance
    from days x
    left join activity a on a.d = x.d
    left join net n on n.d = x.d
  ), versions as (
    select v.reconciliation_required as required, v.effective_at as from_at,
           lead(v.effective_at) over (order by v.effective_at, v.version_no) as to_at,
           row_number() over (order by v.effective_at, v.version_no) as rn
    from public.finance_policy_versions v, branch
    where v.legal_entity_id = branch.legal_entity_id
  )
  select dl.d
  from daily dl
  cross join pending
  left join versions pv
    on pv.from_at < ((dl.d + 1)::timestamp at time zone 'Asia/Kolkata')
   and (pv.to_at is null or pv.to_at >= ((dl.d + 1)::timestamp at time zone 'Asia/Kolkata'))
  where (dl.active or dl.balance <> 0 or pending.first_d <= dl.d)
    and coalesce(pv.required, (select f.required from versions f where f.rn = 1), true)
$$;

revoke all on function authz.finance_reconciliation_obligations(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Unresolved cash work per branch (contract section 2)
-- ---------------------------------------------------------------------------

create or replace function authz.finance_unresolved_json(p_branch uuid, p_policy uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with pol as (
    select v.cash_deposit_days from public.finance_policy_versions v where v.id = p_policy
  ), today as (
    select authz.finance_today() as d
  ), required as (
    select o.business_date as d from authz.finance_reconciliation_obligations(p_branch) o
  ), recs as (
    -- At most one current (non-stale) row per date (unique index).
    select c.business_date as d,
           bool_or(not c.stale) as has_current,
           bool_or(not c.stale and c.status = 'verified') as verified
    from public.cash_reconciliations c where c.branch_id = p_branch
    group by c.business_date
  ), obligations as (
    select q.d, case
        when rc.d is null then 'reconciliation_missing'
        when not rc.has_current then 'reconciliation_stale'
        when rc.verified then null
        else 'reconciliation_awaiting_verification' end as kind
    from required q left join recs rc on rc.d = q.d
    union all
    -- Stale reconciliations outside the obligation dates stay listed.
    select rc.d, 'reconciliation_stale'
    from recs rc
    where not rc.has_current and not exists (select 1 from required q where q.d = rc.d)
  ), items as (
    select 'deposit_overdue'::text as kind, r.id as receipt_id, r.receipt_no, r.received_on as business_date,
           r.amount_paise, 1 as ord
    from public.customer_receipts r, pol, today
    where r.branch_id = p_branch and r.mode = 'cash' and r.status = 'verified'
      and authz.finance_receipt_deposit_status(r.id) is distinct from 'verified'
      and today.d > authz.finance_add_working_days(r.received_on, pol.cash_deposit_days)
    union all
    select 'verification_overdue', r.id, r.receipt_no, r.received_on, r.amount_paise, 2
    from public.customer_receipts r, pol, today
    where r.branch_id = p_branch and r.mode = 'cash' and r.status = 'recorded'
      and today.d > authz.finance_add_working_days(r.received_on, pol.cash_deposit_days)
    union all
    select 'reversed_undeposited', r.id, r.receipt_no, e.business_date, r.amount_paise, 3
    from public.customer_receipts r
    join public.finance_journal_entries e on e.receipt_id = r.id and e.kind = 'reversal_cash_undeposited'
    where r.branch_id = p_branch
    union all
    select o.kind, null, null, o.d, null,
           case o.kind when 'reconciliation_missing' then 4 when 'reconciliation_awaiting_verification' then 5 else 6 end
    from obligations o where o.kind is not null
  ), ranked as (
    select i.*, row_number() over (partition by i.kind order by i.business_date, i.receipt_no) as n from items i
  ), counts as (
    select i.kind, count(*) as total, min(i.business_date) as oldest from items i group by i.kind
  )
  select jsonb_build_object(
    'unresolved', coalesce((
      select jsonb_agg(jsonb_build_object(
          'kind', i.kind, 'receiptId', i.receipt_id, 'receiptNo', i.receipt_no,
          'businessDate', to_char(i.business_date, 'YYYY-MM-DD'), 'amountPaise', i.amount_paise::text)
        order by i.ord, i.business_date, i.receipt_no)
      from ranked i where i.n <= 50), '[]'::jsonb),
    'unresolvedTotals', (
      select jsonb_object_agg(k.kind, coalesce(c.total, 0))
      from (values ('deposit_overdue'), ('verification_overdue'), ('reversed_undeposited'), ('reconciliation_missing'),
                   ('reconciliation_awaiting_verification'), ('reconciliation_stale')) k(kind)
      left join counts c on c.kind = k.kind),
    'oldestUnresolvedDate', coalesce((
      select jsonb_object_agg(c.kind, to_char(c.oldest, 'YYYY-MM-DD')) from counts c), '{}'::jsonb),
    'unresolvedTruncated', exists (select 1 from counts c where c.total > 50))
$$;

create or replace function authz.finance_cash_branch_json(p_branch uuid, p_policy uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'branchId', b.id,
    'branchName', b.name,
    'cashInHandPaise', (select coalesce(sum(l.debit_paise - l.credit_paise), 0)::text from public.finance_journal_lines l
                        where l.branch_id = b.id and l.account = 'cash_in_hand'),
    'recordedUnverifiedCashPaise', (select coalesce(sum(r.amount_paise), 0)::text from public.customer_receipts r
                                    where r.branch_id = b.id and r.mode = 'cash' and r.status = 'recorded'),
    'undepositedVerified', coalesce((
      select jsonb_agg(jsonb_build_object('receiptId', r.id, 'receiptNo', r.receipt_no, 'amountPaise', r.amount_paise::text,
          'receivedOn', to_char(r.received_on, 'YYYY-MM-DD'), 'dealReference', d.reference)
        order by r.received_on, r.receipt_no)
      from public.customer_receipts r join public.deals d on d.id = r.deal_id
      where r.branch_id = b.id and r.mode = 'cash' and r.status = 'verified'
        and authz.finance_receipt_deposit_status(r.id) is null), '[]'::jsonb),
    'deposits', coalesce((
      select jsonb_agg(authz.finance_deposit_json(x.id) order by x.deposited_on desc, x.recorded_at desc)
      from (select dp.id, dp.deposited_on, dp.recorded_at from public.cash_deposits dp where dp.branch_id = b.id
            order by dp.deposited_on desc, dp.recorded_at desc limit 100) x), '[]'::jsonb),
    'reconciliations', coalesce((
      select jsonb_agg(authz.finance_reconciliation_json(x.id) order by x.business_date desc, x.recorded_at desc)
      from (select c.id, c.business_date, c.recorded_at from public.cash_reconciliations c where c.branch_id = b.id
            order by c.business_date desc, c.recorded_at desc limit 100) x), '[]'::jsonb))
    -- unresolved, unresolvedTotals, oldestUnresolvedDate, unresolvedTruncated
    || authz.finance_unresolved_json(b.id, p_policy)
  from public.branches b where b.id = p_branch
$$;

-- ---------------------------------------------------------------------------
-- Late reconciliation (lead decisions, contract sections 2 and 11): an
-- obligation never expires, so it must stay clearable. A business date older
-- than 90 days is accepted only when it is an obligation for the branch
-- (authz.finance_reconciliation_obligations, the same rule the overview uses)
-- or every existing row for it is stale. A second current (non-stale) row is
-- wrong_state for every date, checked first. The 90-day rule is unchanged for
-- every other date; every other check (future dates, note on a difference,
-- branch lock, replay identity) is as in 20261101000100.
-- ---------------------------------------------------------------------------

create or replace function public.cash_reconciliation_record(
  p_branch_id uuid, p_business_date date, p_counted_paise bigint, p_note text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_branch public.branches%rowtype;
  v_payload jsonb := jsonb_build_object('branchId', p_branch_id, 'businessDate', p_business_date,
    'countedPaise', p_counted_paise::text, 'note', p_note);
  v_result jsonb;
  v_note text;
  v_expected bigint;
  v_unverified bigint;
  v_id uuid := gen_random_uuid();
  v_today date := authz.finance_today();
begin
  select * into v_branch from public.branches b where b.id = p_branch_id;
  perform authz.finance_require_accounts(v_branch.legal_entity_id, null);
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  -- Serialises with cash postings for this branch (see authz.finance_post),
  -- and with an exact retry of this command.
  perform pg_advisory_xact_lock(hashtextextended('cash-branch|' || v_branch.id::text, 0));
  v_result := authz.finance_replay(v_branch.legal_entity_id, p_request_id, 'cash_reconciliation_record', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  -- One current (non-stale) reconciliation per branch and date: a second one
  -- is wrong_state for every date, before any age or obligation check.
  if exists (select 1 from public.cash_reconciliations c
             where c.branch_id = v_branch.id and c.business_date = p_business_date and not c.stale) then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_business_date is null or p_business_date > v_today
     or p_counted_paise is null or p_counted_paise < 0 or v_branch.status <> 'enabled' then
    perform authz.finance_invalid();
  end if;
  -- Older than 90 days: only an obligation, or a date whose every row is
  -- stale (it is listed as stale and must be clearable).
  if p_business_date < v_today - 90
     and not exists (select 1 from authz.finance_reconciliation_obligations(v_branch.id) o
                     where o.business_date = p_business_date)
     and not exists (select 1 from public.cash_reconciliations c
                     where c.branch_id = v_branch.id and c.business_date = p_business_date) then
    perform authz.finance_invalid();
  end if;
  v_note := authz.finance_text(p_note, 10, 500, true);

  select coalesce(sum(l.debit_paise - l.credit_paise), 0) into v_expected
  from public.finance_journal_lines l
  join public.finance_journal_entries e on e.id = l.entry_id
  where l.branch_id = v_branch.id and l.account = 'cash_in_hand' and e.business_date <= p_business_date;
  select coalesce(sum(r.amount_paise), 0) into v_unverified
  from public.customer_receipts r
  where r.branch_id = v_branch.id and r.mode = 'cash' and r.status = 'recorded' and r.received_on <= p_business_date;
  if p_counted_paise <> v_expected and v_note is null then
    perform authz.finance_invalid();
  end if;

  begin
    insert into public.cash_reconciliations (id, legal_entity_id, branch_id, business_date, counted_paise, expected_paise,
      unverified_cash_paise, note, request_id, recorded_by)
    values (v_id, v_branch.legal_entity_id, v_branch.id, p_business_date, p_counted_paise, v_expected, v_unverified, v_note,
      p_request_id, (select auth.uid()));
  exception when unique_violation then
    raise exception 'wrong_state' using errcode = '55000';
  end;

  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'status', 'recorded');
  perform authz.finance_remember(v_branch.legal_entity_id, p_request_id, 'cash_reconciliation_record', v_payload, v_result);
  perform authz.write_audit('finance.reconciliation_recorded', v_branch.legal_entity_id, v_branch.id, 'cash_reconciliation',
    v_id, null, jsonb_build_object('businessDate', p_business_date, 'balanced', p_counted_paise = v_expected,
      'late', p_business_date < v_today - 90));
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Accounts queue pages (contract section 3)
-- ---------------------------------------------------------------------------

drop function public.accounts_queue(text);

create function public.accounts_queue(p_filter text, p_after text default null, p_limit integer default 50)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_after_id uuid;
  v_after_ref text;
  v_result jsonb;
begin
  perform authz.finance_require_accounts_anywhere();
  if p_filter is null or p_filter not in ('all', 'needs_review', 'returned', 'awaiting_verification', 'cheques_pending') then
    perform authz.finance_invalid();
  end if;
  if p_after is not null then
    -- "<dealId>:<dealReference>" of the previous page's last item.
    if length(p_after) < 38 or substr(p_after, 37, 1) <> ':'
       or substr(p_after, 1, 36) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      perform authz.finance_invalid();
    end if;
    v_after_id := substr(p_after, 1, 36)::uuid;
    v_after_ref := substr(p_after, 38);
  end if;

  with matched as (
    select d.id, d.reference
    from public.deals d
    left join public.booking_versions v on v.deal_id = d.id and v.status = 'confirmed'
    left join public.accounts_booking_reviews rv on rv.booking_version_id = v.id
    where authz.can_accounts(d.legal_entity_id)
      and authz.finance_gate_issue(d.legal_entity_id, d.is_synthetic) is null
      and (v.id is not null or exists (select 1 from public.customer_receipts r where r.deal_id = d.id))
      and case p_filter
        when 'all' then true
        when 'needs_review' then v.id is not null and coalesce(rv.status, 'pending') = 'pending'
        when 'returned' then rv.status is not distinct from 'returned'
        when 'awaiting_verification' then exists (
          select 1 from public.customer_receipts r where r.deal_id = d.id and r.status = 'recorded')
        else exists (
          select 1 from public.customer_receipts r
          where r.deal_id = d.id and r.mode = 'cheque' and r.status in ('recorded', 'pending_clearance'))
      end
  ), page as (
    -- One extra row tells whether another page exists.
    select m.id, m.reference, row_number() over (order by m.reference, m.id) as n
    from (select m.id, m.reference from matched m
          where v_after_id is null or (m.reference, m.id) > (v_after_ref, v_after_id)
          order by m.reference, m.id
          limit v_limit + 1) m
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(authz.finance_queue_item_json(p.id) order by p.n) from page p where p.n <= v_limit),
                      '[]'::jsonb),
    'hasMore', exists (select 1 from page p where p.n > v_limit),
    'nextAfter', case when exists (select 1 from page p where p.n > v_limit)
      then (select p.id::text || ':' || p.reference from page p where p.n = v_limit) end,
    'totalCount', (select count(*) from matched))
  into v_result;
  return v_result;
end;
$$;

revoke all on function public.accounts_queue(text, text, integer) from public, anon, authenticated, service_role;
grant execute on function public.accounts_queue(text, text, integer) to authenticated;

commit;
