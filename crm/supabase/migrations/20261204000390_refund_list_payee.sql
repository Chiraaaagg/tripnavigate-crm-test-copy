-- Accounts phase 2, Track C fix-forward (UI review, 11 Nov 2026).
--
-- * public.refund_requests_list (replaces 20261204000380, same signature):
--   for Accounts of the entity and the branch Manager (the people who pay out
--   or approve) each row adds reason, payeeKind, payeeName, payeeReason and
--   payeeReceiptNo (the original payer's R- number); null for the Sales owner
--   (contract Q7: the Manager sees the other-payee reason).
-- Refusal tokens unchanged.
-- Rollback (forward-only): a NEW migration restoring the 20261204000380 body.

begin;
set local lock_timeout = '15s';

create or replace function public.refund_requests_list(p_filter jsonb, p_after text default null, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_a uuid[];
  v_m uuid[];
  v_syn boolean;
  v_sales boolean;
  v_so uuid[];
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
  -- Accounts phase 2 (20261204000380, Addendum L7, review 9): every scope passes the same finance gate as deal_refunds.
  v_m := array(select b.id from public.branches b
               where b.id = any(authz.acct_m_branches()) and authz.finance_gate_issue(b.legal_entity_id, v_syn) is null);
  -- 20261204000360: the Sales-owner scope once per call (entities where the
  -- caller is an active Sales person without P/F/V), not a definer call per row.
  v_so := array(select distinct m.legal_entity_id from public.memberships m
                join public.staff_profiles p on p.user_id = m.user_id and p.status = 'active'
                join public.legal_entities e on e.id = m.legal_entity_id and e.status = 'enabled'
                join public.branches b on b.id = m.branch_id and b.status = 'enabled'
                where m.user_id = v_uid and m.role_code = 'sales' and m.status = 'active'
                  and not exists (select 1 from public.memberships x
                                  where x.user_id = v_uid and x.legal_entity_id = m.legal_entity_id
                                    and x.role_code in ('purchase', 'flight', 'visa') and x.status = 'active'));
  v_so := array(select e from unnest(v_so) e
                where authz.finance_enabled(e) and authz.finance_gate_issue(e, v_syn) is null);
  v_sales := cardinality(v_so) > 0;
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
           or (d.owner_user_id = v_uid and q.legal_entity_id = any(v_so)))
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
    select r.*, row_number() over (order by r.requested_at desc, r.id desc) as n,
      -- Accounts phase 2 (20261204000370): decider check only on requested rows of the page.
      coalesce(r.status = 'requested' and r.requested_by <> v_uid and authz.refunds_enabled(r.legal_entity_id)
               and authz.refund_decider(r.id), false) as can_decide,
      (r.legal_entity_id = any(v_a) or r.branch_id = any(v_m)) as am_reader,
      coalesce(r.status = 'approved' and r.outcome = 'payout' and r.legal_entity_id = any(v_a) and r.requested_by <> v_uid
               and r.decided_by is distinct from v_uid and authz.refunds_enabled(r.legal_entity_id), false) as can_payout
    from rows r
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', x.id, 'refNo', x.ref_no, 'dealId', x.deal_id, 'dealReference', x.deal_reference, 'branchName', x.branch_name,
      'kind', x.kind, 'outcome', x.outcome, 'status', x.status, 'amountPaise', x.amount_paise::text,
      'customerChargePaise', x.customer_charge_paise::text, 'requestedByName', sp.display_name, 'requestedAt', x.requested_at,
      'ageWorkingDays', authz.refund_working_days((x.requested_at at time zone 'Asia/Kolkata')::date, authz.finance_today()),
      -- Accounts phase 2 (20261204000370): act from the queue without reading each Deal.
      'rowVersion', x.row_version,
      'can', jsonb_build_object('approve', x.can_decide, 'return', x.can_decide, 'payout', x.can_payout),
      -- The exact amounts a decision or payout binds to; only where the viewer may act.
      'expectedAmountPaise', case when x.can_decide or x.can_payout then x.amount_paise::text end,
      'expectedChargePaise', case when x.can_decide or x.can_payout then x.customer_charge_paise::text end,
      -- 20261204000380 (Addendum L7, review 4): warning for the requester and the approving Manager.
      'useKeptCredit', x.use_kept_credit,
      -- Accounts phase 2 (20261204000390, Q7 UI review): what the approver / payer checks, for Accounts and the branch Manager only (null for the Sales owner).
      'reason', case when x.am_reader then x.reason end,
      'payeeKind', case when x.am_reader then x.payee_kind end,
      'payeeName', case when x.am_reader then x.payee_name end,
      'payeeReason', case when x.am_reader then x.payee_reason end,
      'payeeReceiptNo', case when x.am_reader then (select pr.receipt_no from public.customer_receipts pr where pr.id = x.payee_receipt_id) end,
      'warnings', case when x.kind = 'cancellation' and x.cancellation_id is not null
                         and x.customer_charge_paise < authz.cancellation_charges_kept(x.cancellation_id)
                       then '["charge_below_costs_kept"]'::jsonb else '[]'::jsonb end,
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

commit;
