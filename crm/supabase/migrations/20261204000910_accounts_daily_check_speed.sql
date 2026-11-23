-- Accounts phase 2, lead fix-forward (speed, final verification 12 Nov 2026):
-- the Accounts daily check measured 762 ms p95 under load against the
-- 300 ms target (Phase 1 contract 12.7 / Phase 2 section 13). On the speed
-- seed the two costs were:
--   * supplierRefundsDue: authz.notice_supplier_refund_open(c.id) for every
--     approved cancellation, each running authz.supplier_refund_sources over
--     its Deal (2,005 cancellations: about 315 ms);
--   * urgentNoticesUnopenedOverOneWorkingDay: authz.finance_add_working_days
--     once per open urgent notice (about 50 ms).
-- Replaced (same signature, same keys and values): public.accounts_daily_check
-- (body of 20261204000410). supplierRefundsDue is computed set-based with the
-- same rules (authz.notice_supplier_refund_open stays for notice kind 33);
-- the working-day rule runs once per (branch, India date). Nothing else changes.
--
-- Rollback (forward-only): a NEW migration restoring the 20261204000410 body.

begin;
set local lock_timeout = '15s';

-- Replaces 20261204000410 (speed only; results identical).
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
    'filters', jsonb_build_object(
      'exceptionsOpen', jsonb_build_object('tallyStatus', 'exception'),
      'changedAfterExport', jsonb_build_object('changedSinceExport', true),
      'originalsMissing', jsonb_build_object('originals', 'missing'),
      'receiptsAwaitingVerificationOverOneWorkingDay', jsonb_build_object('overdueCheck', 'receipts_unverified'),
      'paymentsApprovedNotRecordedOverOneWorkingDay', jsonb_build_object('overdueCheck', 'payments_unrecorded')));
end;
$$;


commit;
