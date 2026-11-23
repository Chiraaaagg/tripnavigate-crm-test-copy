-- TripNavigate CRM - Accounts phase 3, track G (6a of 6): the supplier owes
-- money back after a lower rate (LD29).
-- Contract: accounts-phase3-2026-11-12/contract.md section 10.4 step 4, 19,
-- 21 LD29. Schema: 20261205000610 (supplier_refund_receipts.change_request_id,
-- source_kind 'reconfirmation').
--
-- Replaced (latest bodies, same signatures; changed lines marked
-- "Accounts phase 3 (20261205000650)"):
--   authz.supplier_refund_sources (20261204000340:33): + one 'reconfirmation'
--     source per Purchase task whose latest applied reconfirmation left the
--     verified supplier payments above the new committed cost: source_id = the
--     reconfirmation, source_group_id = the task, cancellation_id null,
--     expected = verified payments - committed cost (computed, never stored),
--     received = verified receipts of the group. Listed only while expected or
--     received is above zero, so existing readers see nothing new for Deals
--     without such a change.
--   public.supplier_refund_record (20261204000340:67): accepts sourceKind
--     'reconfirmation' (the change request must be applied; the proof is a
--     refund_evidence row with subject_kind 'supplier_refund' and subject_id =
--     the change request; the receipt carries change_request_id, no
--     cancellation).
--   public.supplier_refunds_due (20261204000350:265): + rows for those sources
--     (approvedAt = the change's applied time); additive keys changeRequestId
--     and changeRefNo (null for cancellation rows).
--
-- Refusal tokens: unchanged (not_ready hint sourceId when the change is not
-- applied or nothing is expected).
-- Rollback (forward-only): a NEW migration restoring the three cited bodies.

begin;
set local lock_timeout = '15s';

create or replace function authz.supplier_refund_sources(p_deal uuid)
returns table (cancellation_id uuid, source_kind text, source_id uuid, source_group_id uuid, task_id uuid, supplier_id uuid,
               expected_paise bigint, received_paise bigint)
language sql stable security definer set search_path = '' as $$
  with c as (select x.id from public.deal_cancellations x where x.deal_id = p_deal),
  src as (
    select distinct on (pc.task_id) pc.cancellation_id, 'purchase_charge'::text as source_kind, pc.id as source_id,
      pc.task_id as source_group_id, pc.task_id, pc.supplier_id, pc.supplier_refund_paise as expected_paise
    from public.purchase_cancellation_charges pc join c on c.id = pc.cancellation_id
    order by pc.task_id, pc.revision_no desc
  ), fsrc as (
    select distinct on (fc.batch_id) fc.cancellation_id, 'flight_charge'::text, fc.id, fc.batch_id, fc.cost_task_id, fc.supplier_id,
      fc.refund_expected_paise
    from public.flight_cancellation_charges fc join c on c.id = fc.cancellation_id
    order by fc.batch_id, fc.revision_no desc
  ), vsrc as (
    select distinct on (vf.entry_id) vf.cancellation_id, 'visa_fee'::text, vf.entry_id, vf.entry_id, vf.task_id, null::uuid,
      vf.refund_expected_paise
    from public.visa_cancellation_fees vf join c on c.id = vf.cancellation_id
    order by vf.entry_id, vf.revision_no desc
  -- Accounts phase 3 (20261205000650): the latest applied reconfirmation per task (LD29).
  ), rsrc as (
    select distinct on (x.task_id) null::uuid, 'reconfirmation'::text, x.id, x.task_id, x.task_id, q.supplier_id,
      greatest(
        coalesce((select sum(p.amount_paise) from public.supplier_payment_requests p
                  where p.task_id = x.task_id and p.status = 'verified'), 0)
        - coalesce((select k.amount_paise from public.purchase_cost_versions k
                    where k.task_id = x.task_id and k.stage = 'committed' order by k.version_no desc limit 1), 0),
        0)::bigint
    from public.task_reconfirmations x
    join public.booking_change_requests r on r.id = x.change_request_id and r.status = 'applied'
    join public.fulfilment_tasks t on t.id = x.task_id
    left join public.purchase_quotes q on q.id = t.selected_quote_id
    where r.deal_id = p_deal and x.status = 'applied'
    order by x.task_id, r.applied_at desc, x.id desc
  ), u as (
    select * from src union all select * from fsrc union all select * from vsrc union all select * from rsrc
  )
  select v.* from (
    select u.cancellation_id, u.source_kind, u.source_id, u.source_group_id, u.task_id, u.supplier_id, u.expected_paise,
      coalesce((select sum(r.amount_paise) from public.supplier_refund_receipts r
                where r.deal_id = p_deal and r.source_kind = u.source_kind and r.source_group_id = u.source_group_id
                  and r.status = 'verified'), 0)::bigint as received_paise
    from u) v
  where v.source_kind <> 'reconfirmation' or v.expected_paise > 0 or v.received_paise > 0
$$;

create or replace function public.supplier_refund_record(p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_payload jsonb := jsonb_build_object('fields', p_fields);
  v_result jsonb;
  v_key text;
  v_kind text;
  v_source uuid;
  v_deal public.deals%rowtype;
  v_src record;
  v_c public.deal_cancellations%rowtype;
  v_amount bigint;
  v_on_text text;
  v_on date;
  v_mode text;
  v_ref text;
  v_evidence uuid;
  v_over text;
  v_id uuid := gen_random_uuid();
  v_deal_id uuid;
  v_cr public.booking_change_requests%rowtype;  -- Accounts phase 3 (20261205000650)
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    perform authz.refund_invalid('fields');
  end if;
  v_kind := authz.refund_text(p_fields, 'sourceKind', 1, 30, false);
  -- Accounts phase 3 (20261205000650): + reconfirmation (a lower rate after a change, LD29).
  if v_kind is null or v_kind not in ('purchase_charge', 'flight_charge', 'visa_fee', 'reconfirmation') then
    perform authz.refund_invalid('sourceKind');
  end if;
  v_source := authz.refund_uuid(p_fields, 'sourceId');
  if v_source is null then
    perform authz.refund_invalid('sourceId');
  end if;
  v_deal_id := case v_kind
    when 'purchase_charge' then (select t.deal_id from public.purchase_cancellation_charges x
                                 join public.fulfilment_tasks t on t.id = x.task_id where x.id = v_source)
    when 'flight_charge' then (select x.deal_id from public.flight_cancellation_charges x where x.id = v_source)
    -- Accounts phase 3 (20261205000650)
    when 'reconfirmation' then (select t.deal_id from public.task_reconfirmations x
                                join public.fulfilment_tasks t on t.id = x.task_id where x.id = v_source)
    else (select e.deal_id from public.department_cost_entries e where e.id = v_source and e.department = 'visa') end;
  if v_deal_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_deal from public.deals d where d.id = v_deal_id;
  perform authz.finance_require_accounts(v_deal.legal_entity_id, v_deal.is_synthetic);
  if p_request_id is null then
    perform authz.refund_invalid('requestId');
  end if;
  perform authz.finance_lock_deal(v_deal.id);
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'supplier_refund_record', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  for v_key in select k from jsonb_object_keys(p_fields) k order by k loop
    if v_key <> all (array['sourceKind', 'sourceId', 'amountPaise', 'receivedOn', 'mode', 'reference', 'evidenceId',
                           'overExpectedReason']) then
      perform authz.refund_invalid(v_key);
    end if;
  end loop;
  -- Accounts phase 3 (20261205000650): a reconfirmation source belongs to its applied change request, not to a cancellation.
  if v_kind = 'reconfirmation' then
    select r.* into v_cr from public.booking_change_requests r
    join public.task_reconfirmations x on x.change_request_id = r.id
    where x.id = v_source and r.status = 'applied' for share of r;
    if v_cr.id is null then
      raise exception 'not_ready' using errcode = '55000', hint = 'sourceId';
    end if;
  else
  select * into v_c from public.deal_cancellations c where c.deal_id = v_deal.id for share;
  if v_c.id is null or v_c.status <> 'approved' then
    raise exception 'not_ready' using errcode = '55000', hint = 'cancellation';
  end if;
  end if;
  -- The source must be the current one (latest revision; a Visa fee entry).
  select s.* into v_src from authz.supplier_refund_sources(v_deal.id) s
  where s.source_kind = v_kind and s.source_id = v_source;
  if v_src.source_id is null then
    if v_kind = 'visa_fee' then
      raise exception 'not_ready' using errcode = '55000', hint = 'sourceId';
    end if;
    perform authz.refund_invalid('sourceId');
  end if;
  if coalesce(v_src.expected_paise, 0) <= 0 then
    raise exception 'not_ready' using errcode = '55000', hint = 'sourceId';
  end if;
  v_amount := authz.refund_paise(p_fields, 'amountPaise');
  if v_amount is null or v_amount < 1 or v_amount > 999999999999 then
    perform authz.refund_invalid('amountPaise');
  end if;
  v_on_text := authz.refund_text(p_fields, 'receivedOn', 10, 10, false);
  if v_on_text is null or v_on_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    perform authz.refund_invalid('receivedOn');
  end if;
  begin
    v_on := v_on_text::date;
  exception when others then
    perform authz.refund_invalid('receivedOn');
  end;
  if v_on > authz.finance_today()
     or v_on < (coalesce(v_c.opened_at, v_cr.applied_at) at time zone 'Asia/Kolkata')::date then  -- Accounts phase 3 (20261205000650)
    perform authz.refund_invalid('receivedOn');
  end if;
  v_mode := authz.refund_text(p_fields, 'mode', 1, 20, false);
  if v_mode is null or v_mode not in ('bank_transfer', 'upi', 'cheque', 'card_reversal', 'other') then
    perform authz.refund_invalid('mode');
  end if;
  v_ref := authz.refund_text(p_fields, 'reference', 1, 40, false);
  if v_ref is null or v_ref !~ '^[A-Za-z0-9/-]{4,40}$' then
    perform authz.refund_invalid('reference');
  end if;
  v_over := authz.refund_text(p_fields, 'overExpectedReason', 10, 500, true);
  v_evidence := authz.refund_uuid(p_fields, 'evidenceId');
  if v_evidence is null or not exists (
       select 1 from public.refund_evidence e
       where e.id = v_evidence and e.legal_entity_id = v_deal.legal_entity_id and e.subject_kind = 'supplier_refund'
         and e.subject_id = coalesce(v_c.id, v_cr.id) and e.status = 'stored')  -- Accounts phase 3 (20261205000650)
     or exists (select 1 from public.supplier_refund_receipts x where x.evidence_id = v_evidence) then
    raise exception 'evidence_missing' using errcode = '55000';
  end if;
  if v_src.received_paise + v_amount > v_src.expected_paise and v_over is null then
    raise exception 'over_expected' using errcode = '22023', hint = 'overExpectedReason';
  end if;

  insert into public.supplier_refund_receipts (id, legal_entity_id, branch_id, deal_id, cancellation_id, source_kind, source_id,
    task_id, source_group_id, supplier_id, amount_paise, received_on, mode, reference, evidence_id, over_expected_reason,
    status, recorded_by, recorded_at, verified_by, verified_at, request_id,
    change_request_id)  -- Accounts phase 3 (20261205000650)
  values (v_id, v_deal.legal_entity_id, v_deal.branch_id, v_deal.id, v_c.id, v_kind, v_source, v_src.task_id,
    v_src.source_group_id, v_src.supplier_id, v_amount, v_on, v_mode, v_ref, v_evidence,
    case when v_src.received_paise + v_amount > v_src.expected_paise then v_over end,
    'verified', v_uid, now(), v_uid, now(), p_request_id, v_cr.id);
  v_result := jsonb_build_object('outcome', 'created', 'supplierRefundId', v_id, 'status', 'verified', 'rowVersion', 1);
  perform authz.finance_remember(v_deal.legal_entity_id, p_request_id, 'supplier_refund_record', v_payload, v_result);
  perform authz.write_audit('accounts.supplier_refund.verified', v_deal.legal_entity_id, v_deal.branch_id, 'supplier_refund_receipt',
    v_id, null, jsonb_build_object('supplierRefundId', v_id, 'dealId', v_deal.id, 'cancellationId', v_c.id,
      'changeRequestId', v_cr.id,
      'sourceKind', v_kind, 'sourceId', v_source, 'mode', v_mode, 'overExpected', v_src.received_paise + v_amount > v_src.expected_paise));
  return v_result;
end;
$$;

create or replace function public.supplier_refunds_due(p_filter jsonb, p_after text default null, p_limit integer default 50) returns jsonb
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
    select k.*, s.source_kind, s.source_id, s.source_group_id, s.task_id, s.supplier_id, s.expected_paise, s.received_paise,
      null::uuid as change_request_id, null::text as change_ref_no
    from cases k cross join lateral authz.supplier_refund_sources(k.deal_id) s
    where s.expected_paise > 0 and (v_state = 'all' or s.received_paise < s.expected_paise)
      and s.source_kind <> 'reconfirmation'
    -- Accounts phase 3 (20261205000650): lower rates after an applied change (LD29).
    union all
    select null::uuid, r.deal_id, r.applied_at, d.reference, b.name, s.source_kind, s.source_id, s.source_group_id, s.task_id,
      s.supplier_id, s.expected_paise, s.received_paise, r.id, r.ref_no
    from (select distinct q.deal_id from public.booking_change_requests q
          where q.status = 'applied' and q.legal_entity_id = any(v_a)
            and exists (select 1 from public.task_reconfirmations x where x.change_request_id = q.id and x.status = 'applied')) cd
    join public.deals d on d.id = cd.deal_id
    cross join lateral authz.supplier_refund_sources(cd.deal_id) s
    join public.task_reconfirmations x on x.id = s.source_id
    join public.booking_change_requests r on r.id = x.change_request_id
    join public.branches b on b.id = r.branch_id
    where s.source_kind = 'reconfirmation' and d.is_synthetic = v_syn
      and (v_ref is null or d.reference = v_ref)
      and (v_branch is null or r.branch_id = v_branch)
      and s.expected_paise > 0 and (v_state = 'all' or s.received_paise < s.expected_paise)
  ), page as (
    select * from src
    where v_after_ts is null or (decided_at, source_id) < (v_after_ts, v_after_id)
    order by decided_at desc, source_id desc
    limit v_limit + 1
  ), numbered as (
    select p.*, row_number() over (order by p.decided_at desc, p.source_id desc) as n from page p
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'cancellationId', x.id, 'changeRequestId', x.change_request_id, 'changeRefNo', x.change_ref_no, 'dealId', x.deal_id, 'dealReference', x.reference, 'branchName', x.branch_name,
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

commit;
