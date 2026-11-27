-- Accounts phase 2, Track C (contract 7.5 R-C1..R-C3, section 10 fences,
-- LD11): refund reads.
--
-- * R-C1 public.deal_refunds(p_deal_id): A (entity), M (Deal branch, no
--   P/F/V), SO (own Deal); else null. Money held, combined charges kept
--   (LD11), maximum refund, payers, every request with its payout and credit
--   note, supplier refunds (A and M only).
-- * R-C2 public.refund_requests_list(p_filter, p_after, p_limit): A (entity;
--   preset payout_due), M (branch; preset to_approve), SO (own Deals);
--   keyset (requested_at desc, id desc), cursor '<ts>|<id>'.
-- * R-C3 public.supplier_refunds_due(p_filter, p_after, p_limit): A only;
--   approved cancellations with expected supplier / airline / visa refunds,
--   received (verified) sums and the receipts.
-- Purchase, Flight and Visa never read any of these (null). Reads are not audited.
--
-- Rollback (forward-only): a NEW migration dropping these functions.

begin;
set local lock_timeout = '15s';

-- Working days (Monday to Saturday) from p_from to p_to, p_from excluded.
create function authz.refund_working_days(p_from date, p_to date) returns integer
language sql immutable set search_path = '' as $$
  select coalesce((select count(*)::integer from generate_series(p_from + 1, p_to, interval '1 day') g
                   where extract(isodow from g) <> 7), 0)
$$;

-- The caller's reader kind for the Deal's refunds: 'accounts', 'manager', 'sales' or null.
create function authz.refund_viewer(p_deal uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when d.id is null or not coalesce(authz.session_ok(), false) or authz.acct_synthetic() is null
         or d.is_synthetic is distinct from authz.acct_synthetic()
         or authz.finance_gate_issue(d.legal_entity_id, d.is_synthetic) is not null then null
    when authz.can_accounts(d.legal_entity_id) then 'accounts'
    when authz.refund_is_m(d.id) then 'manager'
    when authz.refund_is_so(d.id) then 'sales'
  end
  from (select 1) one left join public.deals d on d.id = p_deal
$$;

-- ===========================================================================
-- R-C1 deal_refunds
-- ===========================================================================

create function public.deal_refunds(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_deal public.deals%rowtype;
  v_viewer text;
  v_am boolean;
  v_enabled boolean;
  v_held bigint;
  v_total bigint;
  v_c public.deal_cancellations%rowtype;
  v_live boolean;
  v_role text;
begin
  v_viewer := authz.refund_viewer(p_deal_id);
  if v_viewer is null then
    return null;
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  v_am := v_viewer in ('accounts', 'manager');
  v_enabled := authz.refunds_enabled(v_deal.legal_entity_id);
  v_held := authz.refund_money_held(v_deal.id);
  v_total := authz.refund_basis_total(v_deal.id);
  select * into v_c from public.deal_cancellations c where c.deal_id = v_deal.id;
  v_live := exists (select 1 from public.customer_refund_requests r
                    where r.deal_id = v_deal.id and (r.status in ('requested', 'returned') or (r.status = 'approved' and r.outcome = 'payout')));
  v_role := authz.refund_requester_role(v_deal.id);
  return jsonb_build_object(
    'dealId', v_deal.id,
    'dealReference', v_deal.reference,
    'viewer', v_viewer,
    'enabled', v_enabled,
    'heldPaise', v_held::text,
    'cancellation', case when v_c.id is not null then jsonb_build_object('id', v_c.id, 'status', v_c.status) end,
    -- LD11: one combined figure (never per supplier), also for the Sales owner.
    'chargesKeptPaise', case when v_c.id is not null then authz.cancellation_charges_kept(v_c.id)::text end,
    'basisTotalPaise', v_total::text,
    'maxRefundPaise', (case when v_c.status = 'approved' then greatest(v_held, 0)
                            else greatest(v_held - coalesce(v_total, v_held), 0) end)::text,
    'canRequest', v_enabled and v_role is not null and not v_live
                  and (v_c.status is not distinct from 'approved' or (v_total is not null and v_held > v_total)),
    'payers', coalesce((
      select jsonb_agg(jsonb_build_object('receiptId', r.id, 'receiptNo', r.receipt_no, 'payerName', r.payer_name,
          'amountPaise', r.amount_paise::text) order by r.received_on, r.receipt_no)
      from public.customer_receipts r where r.deal_id = v_deal.id and r.status in ('verified', 'cleared')), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', q.id, 'refNo', q.ref_no, 'kind', q.kind, 'outcome', q.outcome, 'status', q.status,
          'customerChargePaise', q.customer_charge_paise::text, 'amountPaise', q.amount_paise::text,
          'heldAtRequestPaise', q.held_at_request_paise::text,
          'payeeKind', q.payee_kind, 'payeeName', q.payee_name, 'payeeReason', q.payee_reason, 'payeeReceiptId', q.payee_receipt_id,
          'reason', q.reason, 'requestedByName', rp.display_name, 'requestedAt', q.requested_at, 'requestedAs', q.requested_as,
          'decidedByName', dp.display_name, 'decidedAt', q.decided_at, 'returnReason', q.return_reason,
          'withdrawnByName', wp.display_name, 'withdrawnAt', q.withdrawn_at, 'withdrawReason', q.withdraw_reason,
          'rowVersion', q.row_version,
          'payout', case when p.id is not null then jsonb_build_object('mode', p.mode, 'paidOn', to_char(p.paid_on, 'YYYY-MM-DD'),
              'reference', case when v_am then p.reference end, 'evidenceId', case when v_am then p.evidence_id end,
              'recordedByName', pp.display_name) end,
          'creditNote', (select jsonb_build_object('documentId', cn.id, 'number', cn.number, 'status', cn.status)
                         from public.customer_documents cn
                         where cn.refund_request_id = q.id and cn.kind = 'credit_note' and cn.status <> 'discarded'
                           and (v_viewer = 'accounts' or cn.status in ('released', 'replaced', 'cancelled'))
                         order by cn.created_at desc, cn.id desc limit 1),
          'can', jsonb_build_object(
            'resubmit', v_enabled and q.status = 'returned' and q.requested_by = v_uid and v_role is not null,
            'withdraw', case
              when q.status in ('requested', 'returned') then q.requested_by = v_uid
              when q.status = 'approved' and q.outcome = 'payout' then authz.refund_is_m(q.deal_id)
                   or (q.decided_by = v_uid and authz.refund_entity_manager(q.legal_entity_id))
              else false end,
            'approve', v_enabled and q.status = 'requested' and q.requested_by <> v_uid and authz.refund_decider(q.id),
            'return', v_enabled and q.status = 'requested' and q.requested_by <> v_uid and authz.refund_decider(q.id),
            'payout', v_enabled and v_viewer = 'accounts' and q.status = 'approved' and q.outcome = 'payout'
                      and q.requested_by <> v_uid and q.decided_by is distinct from v_uid
                      and not authz.holds_role('purchase', q.legal_entity_id)))
        order by q.requested_at desc, q.id desc)
      from public.customer_refund_requests q
      left join public.customer_refund_payouts p on p.refund_request_id = q.id
      left join public.staff_profiles rp on rp.user_id = q.requested_by
      left join public.staff_profiles dp on dp.user_id = q.decided_by
      left join public.staff_profiles wp on wp.user_id = q.withdrawn_by
      left join public.staff_profiles pp on pp.user_id = p.recorded_by
      where q.deal_id = v_deal.id), '[]'::jsonb))
  || case when v_am then jsonb_build_object('supplierRefunds', coalesce((
      select jsonb_agg(jsonb_build_object(
          'sourceKind', s.source_kind, 'sourceId', s.source_id, 'cancellationId', s.cancellation_id,
          'supplierId', s.supplier_id, 'supplierName', sp.name, 'taskId', s.task_id,
          'expectedPaise', s.expected_paise::text, 'receivedPaise', s.received_paise::text,
          'canRecord', v_viewer = 'accounts' and v_c.status = 'approved' and s.expected_paise > 0,
          'receipts', coalesce((
            select jsonb_agg(jsonb_build_object('id', x.id, 'amountPaise', x.amount_paise::text,
                'receivedOn', to_char(x.received_on, 'YYYY-MM-DD'), 'mode', x.mode, 'reference', x.reference,
                'evidenceId', x.evidence_id, 'status', x.status, 'rowVersion', x.row_version,
                'recordedByName', xp.display_name, 'rejectReason', x.reject_reason,
                'canCancel', v_viewer = 'accounts' and x.status = 'verified') order by x.recorded_at, x.id)
            from public.supplier_refund_receipts x
            left join public.staff_profiles xp on xp.user_id = x.recorded_by
            where x.deal_id = v_deal.id and x.source_kind = s.source_kind and x.source_group_id = s.source_group_id), '[]'::jsonb))
        order by s.source_kind, sp.name nulls last, s.source_id)
      from authz.supplier_refund_sources(v_deal.id) s
      left join public.suppliers sp on sp.id = s.supplier_id), '[]'::jsonb))
     else '{}'::jsonb end;
end;
$$;

-- ===========================================================================
-- R-C2 refund_requests_list
-- ===========================================================================

create function public.refund_requests_list(p_filter jsonb, p_after text default null, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_a uuid[];
  v_m uuid[];
  v_syn boolean;
  v_sales boolean;
  v_filter jsonb := coalesce(p_filter, '{}'::jsonb);
  v_preset text;
  v_status text[];
  v_outcome text[];
  v_ref text;
  v_branch uuid;
  v_from date;
  v_to date;
  v_after_ts timestamptz;
  v_after_id uuid;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_rows jsonb;
  v_n integer;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  v_syn := authz.acct_synthetic();
  if v_syn is null then
    return null;
  end if;
  v_a := array(select e from unnest(authz.acct_a_entities()) e where authz.finance_gate_issue(e, v_syn) is null);
  v_m := array(select b from unnest(authz.acct_m_branches()) b);
  v_sales := exists (select 1 from public.memberships m
                     where m.user_id = v_uid and m.role_code = 'sales' and m.status = 'active');
  if cardinality(v_a) = 0 and cardinality(v_m) = 0 and not v_sales then
    return null;
  end if;
  if jsonb_typeof(v_filter) <> 'object' then
    perform authz.refund_invalid('filter');
  end if;
  v_preset := v_filter ->> 'preset';
  if v_preset is not null and v_preset not in ('payout_due', 'to_approve') then
    perform authz.refund_invalid('preset');
  end if;
  begin
    v_status := case when jsonb_typeof(v_filter -> 'status') = 'array'
      then array(select jsonb_array_elements_text(v_filter -> 'status')) end;
    v_outcome := case when jsonb_typeof(v_filter -> 'outcome') = 'array'
      then array(select jsonb_array_elements_text(v_filter -> 'outcome')) end;
    v_ref := nullif(btrim(v_filter ->> 'dealReference'), '');
    v_branch := nullif(v_filter ->> 'branchId', '')::uuid;
    v_from := nullif(v_filter ->> 'from', '')::date;
    v_to := nullif(v_filter ->> 'to', '')::date;
    if p_after is not null then
      v_after_ts := split_part(p_after, '|', 1)::timestamptz;
      v_after_id := split_part(p_after, '|', 2)::uuid;
    end if;
  exception when others then
    perform authz.refund_invalid('filter');
  end;
  if v_status is not null and not (v_status <@ array['requested', 'returned', 'approved', 'paid', 'withdrawn']) then
    perform authz.refund_invalid('status');
  end if;
  if v_outcome is not null and not (v_outcome <@ array['payout', 'keep_credit', 'charge_only']) then
    perform authz.refund_invalid('outcome');
  end if;

  with rows as (
    select q.*, d.reference as deal_reference, b.name as branch_name
    from public.customer_refund_requests q
    join public.deals d on d.id = q.deal_id
    join public.branches b on b.id = q.branch_id
    where d.is_synthetic = v_syn
      and (q.legal_entity_id = any(v_a) or q.branch_id = any(v_m)
           or (d.owner_user_id = v_uid and authz.refund_is_so(d.id)))
      and (v_preset is null
           or (v_preset = 'payout_due' and q.legal_entity_id = any(v_a) and q.status = 'approved' and q.outcome = 'payout'
               and q.requested_by <> v_uid and q.decided_by is distinct from v_uid)
           or (v_preset = 'to_approve' and q.status = 'requested' and q.requested_by <> v_uid and authz.refund_decider(q.id)))
      and (v_status is null or q.status = any(v_status))
      and (v_outcome is null or q.outcome = any(v_outcome))
      and (v_ref is null or d.reference = v_ref or q.ref_no = v_ref)
      and (v_branch is null or q.branch_id = v_branch)
      and (v_from is null or (q.requested_at at time zone 'Asia/Kolkata')::date >= v_from)
      and (v_to is null or (q.requested_at at time zone 'Asia/Kolkata')::date <= v_to)
      and (v_after_ts is null or (q.requested_at, q.id) < (v_after_ts, v_after_id))
    order by q.requested_at desc, q.id desc
    limit v_limit + 1
  ), numbered as (
    select r.*, row_number() over (order by r.requested_at desc, r.id desc) as n from rows r
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'refNo', x.ref_no, 'dealId', x.deal_id, 'dealReference', x.deal_reference, 'branchName', x.branch_name,
      'kind', x.kind, 'outcome', x.outcome, 'status', x.status, 'amountPaise', x.amount_paise::text,
      'customerChargePaise', x.customer_charge_paise::text, 'requestedByName', sp.display_name, 'requestedAt', x.requested_at,
      'ageWorkingDays', authz.refund_working_days((x.requested_at at time zone 'Asia/Kolkata')::date, authz.finance_today()),
      'cursor', to_char(x.requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || x.id::text)
      order by x.n) filter (where x.n <= v_limit), '[]'::jsonb), count(*)::integer
  into v_rows, v_n
  from numbered x
  left join public.staff_profiles sp on sp.user_id = x.requested_by;
  return jsonb_build_object(
    'items', (select coalesce(jsonb_agg(e - 'cursor'), '[]'::jsonb) from jsonb_array_elements(v_rows) e),
    'nextAfter', case when v_n > v_limit then (v_rows -> (v_limit - 1)) ->> 'cursor' end);
end;
$$;

-- ===========================================================================
-- R-C3 supplier_refunds_due (Accounts only)
-- ===========================================================================

create function public.supplier_refunds_due(p_filter jsonb, p_after text default null, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_a uuid[];
  v_syn boolean;
  v_filter jsonb := coalesce(p_filter, '{}'::jsonb);
  v_state text;
  v_ref text;
  v_branch uuid;
  v_after_ts timestamptz;
  v_after_id uuid;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_rows jsonb;
  v_n integer;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  v_syn := authz.acct_synthetic();
  if v_syn is null then
    return null;
  end if;
  v_a := array(select e from unnest(authz.acct_a_entities()) e where authz.finance_gate_issue(e, v_syn) is null);
  if cardinality(v_a) = 0 then
    return null;
  end if;
  if jsonb_typeof(v_filter) <> 'object' then
    perform authz.refund_invalid('filter');
  end if;
  v_state := coalesce(nullif(v_filter ->> 'state', ''), 'open');
  if v_state not in ('open', 'all') then
    perform authz.refund_invalid('state');
  end if;
  begin
    v_ref := nullif(btrim(v_filter ->> 'dealReference'), '');
    v_branch := nullif(v_filter ->> 'branchId', '')::uuid;
    if p_after is not null then
      v_after_ts := split_part(p_after, '|', 1)::timestamptz;
      v_after_id := split_part(p_after, '|', 2)::uuid;
    end if;
  exception when others then
    perform authz.refund_invalid('filter');
  end;

  with cases as (
    select c.id, c.deal_id, c.decided_at, d.reference, b.name as branch_name
    from public.deal_cancellations c
    join public.deals d on d.id = c.deal_id
    join public.branches b on b.id = c.branch_id
    where c.status = 'approved' and c.legal_entity_id = any(v_a) and d.is_synthetic = v_syn
      and (v_ref is null or d.reference = v_ref)
      and (v_branch is null or c.branch_id = v_branch)
  ), src as (
    select k.*, s.source_kind, s.source_id, s.source_group_id, s.task_id, s.supplier_id, s.expected_paise, s.received_paise
    from cases k cross join lateral authz.supplier_refund_sources(k.deal_id) s
    where s.expected_paise > 0 and (v_state = 'all' or s.received_paise < s.expected_paise)
  ), page as (
    select * from src
    where v_after_ts is null or (decided_at, source_id) < (v_after_ts, v_after_id)
    order by decided_at desc, source_id desc
    limit v_limit + 1
  ), numbered as (
    select p.*, row_number() over (order by p.decided_at desc, p.source_id desc) as n from page p
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'cancellationId', x.id, 'dealId', x.deal_id, 'dealReference', x.reference, 'branchName', x.branch_name,
      'approvedAt', x.decided_at, 'sourceKind', x.source_kind, 'sourceId', x.source_id, 'taskId', x.task_id,
      'supplierId', x.supplier_id, 'supplierName', sp.name,
      'expectedPaise', x.expected_paise::text, 'receivedPaise', x.received_paise::text,
      'outstandingPaise', greatest(x.expected_paise - x.received_paise, 0)::text,
      'receipts', coalesce((
        select jsonb_agg(jsonb_build_object('id', r.id, 'amountPaise', r.amount_paise::text,
            'receivedOn', to_char(r.received_on, 'YYYY-MM-DD'), 'mode', r.mode, 'reference', r.reference, 'status', r.status,
            'rowVersion', r.row_version, 'recordedByName', rp.display_name) order by r.recorded_at, r.id)
        from public.supplier_refund_receipts r
        left join public.staff_profiles rp on rp.user_id = r.recorded_by
        where r.deal_id = x.deal_id and r.source_kind = x.source_kind and r.source_group_id = x.source_group_id), '[]'::jsonb),
      'cursor', to_char(x.decided_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || x.source_id::text)
      order by x.n) filter (where x.n <= v_limit), '[]'::jsonb), count(*)::integer
  into v_rows, v_n
  from numbered x
  left join public.suppliers sp on sp.id = x.supplier_id;
  return jsonb_build_object(
    'items', (select coalesce(jsonb_agg(e - 'cursor'), '[]'::jsonb) from jsonb_array_elements(v_rows) e),
    'nextAfter', case when v_n > v_limit then (v_rows -> (v_limit - 1)) ->> 'cursor' end);
end;
$$;

revoke all on function authz.refund_working_days(date, date), authz.refund_viewer(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.deal_refunds(uuid), public.refund_requests_list(jsonb, text, integer),
  public.supplier_refunds_due(jsonb, text, integer)
from public, anon, authenticated, service_role;
grant execute on function public.deal_refunds(uuid), public.refund_requests_list(jsonb, text, integer),
  public.supplier_refunds_due(jsonb, text, integer)
to authenticated;

commit;
