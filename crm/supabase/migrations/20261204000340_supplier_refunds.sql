-- Accounts phase 2, Track C (contract 7.1, 7.3 C7/C8 as changed by Addendum
-- L1 and L5, 7.4 accounts_supplier_payables): supplier refunds received.
--
-- * C7 supplier_refund_record: ONE Accounts person records and verifies the
--   money received back (status 'verified' at once, verified_by/at =
--   recorded_by/at) against the current source: the latest Purchase charge
--   revision of a task, the latest Flight charge revision of a ticket batch,
--   or a company-paid Visa fee with an expected refund. Needs an approved
--   cancellation, an expected refund > 0 on the source, the bank reference and
--   a stored proof (refund_evidence, subject = the cancellation case). More
--   than expected (live receipts of the source + this one) needs a reason.
-- * C8 supplier_refund_cancel: any Accounts person of the entity marks it
--   rejected with a reason (10..500).
-- * Never posts to the customer journal, never read by dues; supplier
--   payments are unchanged.
-- * accounts_supplier_payables (replaces 20261203000240): adds
--   supplierRefundsExpectedPaise / supplierRefundsReceivedPaise (verified)
--   and per supplier supplierRefunds (additive).
--
-- Refusal tokens: not_ready (55000), over_expected (22023, hint
-- overExpectedReason), evidence_missing (55000), wrong_state, version_changed,
-- invalid_input (hint = field), not_authorized, request_conflict.
-- Audit: accounts.supplier_refund.verified, accounts.supplier_refund.rejected.
--
-- Rollback (forward-only): a NEW migration restoring the 20261203000240
-- accounts_supplier_payables body and dropping the new functions.

begin;
set local lock_timeout = '15s';

-- Every current refund source of the Deal's cancellation case with its
-- expected refund and the verified money received against it.
create function authz.supplier_refund_sources(p_deal uuid)
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
  ), u as (
    select * from src union all select * from fsrc union all select * from vsrc
  )
  select u.cancellation_id, u.source_kind, u.source_id, u.source_group_id, u.task_id, u.supplier_id, u.expected_paise,
    coalesce((select sum(r.amount_paise) from public.supplier_refund_receipts r
              where r.deal_id = p_deal and r.source_kind = u.source_kind and r.source_group_id = u.source_group_id
                and r.status = 'verified'), 0)::bigint
  from u
$$;

-- ===========================================================================
-- C7 supplier_refund_record (Addendum L1: recorded and verified in one step)
-- ===========================================================================

create function public.supplier_refund_record(p_fields jsonb, p_request_id uuid) returns jsonb
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
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    perform authz.refund_invalid('fields');
  end if;
  v_kind := authz.refund_text(p_fields, 'sourceKind', 1, 30, false);
  if v_kind is null or v_kind not in ('purchase_charge', 'flight_charge', 'visa_fee') then
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
  select * into v_c from public.deal_cancellations c where c.deal_id = v_deal.id for share;
  if v_c.id is null or v_c.status <> 'approved' then
    raise exception 'not_ready' using errcode = '55000', hint = 'cancellation';
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
  if v_on > authz.finance_today() or v_on < (v_c.opened_at at time zone 'Asia/Kolkata')::date then
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
         and e.subject_id = v_c.id and e.status = 'stored')
     or exists (select 1 from public.supplier_refund_receipts x where x.evidence_id = v_evidence) then
    raise exception 'evidence_missing' using errcode = '55000';
  end if;
  if v_src.received_paise + v_amount > v_src.expected_paise and v_over is null then
    raise exception 'over_expected' using errcode = '22023', hint = 'overExpectedReason';
  end if;

  insert into public.supplier_refund_receipts (id, legal_entity_id, branch_id, deal_id, cancellation_id, source_kind, source_id,
    task_id, source_group_id, supplier_id, amount_paise, received_on, mode, reference, evidence_id, over_expected_reason,
    status, recorded_by, recorded_at, verified_by, verified_at, request_id)
  values (v_id, v_deal.legal_entity_id, v_deal.branch_id, v_deal.id, v_c.id, v_kind, v_source, v_src.task_id,
    v_src.source_group_id, v_src.supplier_id, v_amount, v_on, v_mode, v_ref, v_evidence,
    case when v_src.received_paise + v_amount > v_src.expected_paise then v_over end,
    'verified', v_uid, now(), v_uid, now(), p_request_id);
  v_result := jsonb_build_object('outcome', 'created', 'supplierRefundId', v_id, 'status', 'verified', 'rowVersion', 1);
  perform authz.finance_remember(v_deal.legal_entity_id, p_request_id, 'supplier_refund_record', v_payload, v_result);
  perform authz.write_audit('accounts.supplier_refund.verified', v_deal.legal_entity_id, v_deal.branch_id, 'supplier_refund_receipt',
    v_id, null, jsonb_build_object('supplierRefundId', v_id, 'dealId', v_deal.id, 'cancellationId', v_c.id,
      'sourceKind', v_kind, 'sourceId', v_source, 'mode', v_mode, 'overExpected', v_src.received_paise + v_amount > v_src.expected_paise));
  return v_result;
end;
$$;

-- ===========================================================================
-- C8 supplier_refund_cancel (Addendum L1)
-- ===========================================================================

create function public.supplier_refund_cancel(p_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  x public.supplier_refund_receipts%rowtype;
  v_deal public.deals%rowtype;
  v_payload jsonb := jsonb_build_object('supplierRefundId', p_id, 'expectedRowVersion', p_expected_row_version, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into x from public.supplier_refund_receipts r where r.id = p_id;
  if x.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_deal from public.deals d where d.id = x.deal_id;
  perform authz.finance_require_accounts(v_deal.legal_entity_id, v_deal.is_synthetic);
  if p_request_id is null then
    perform authz.refund_invalid('requestId');
  end if;
  perform authz.finance_lock_deal(x.deal_id);
  select * into x from public.supplier_refund_receipts r where r.id = p_id for update;
  v_result := authz.finance_replay(x.legal_entity_id, p_request_id, 'supplier_refund_cancel', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if x.status <> 'verified' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, x.row_version);
  begin
    v_reason := authz.finance_reason(p_reason);
  exception when sqlstate '22023' then
    perform authz.refund_invalid('reason');
  end;
  update public.supplier_refund_receipts r
  set status = 'rejected', reject_reason = v_reason, rejected_by = (select auth.uid()), rejected_at = now(),
      row_version = r.row_version + 1, updated_at = now()
  where r.id = x.id;
  v_result := jsonb_build_object('outcome', 'updated', 'supplierRefundId', x.id, 'status', 'rejected', 'rowVersion', x.row_version + 1);
  perform authz.finance_remember(x.legal_entity_id, p_request_id, 'supplier_refund_cancel', v_payload, v_result);
  perform authz.write_audit('accounts.supplier_refund.rejected', x.legal_entity_id, x.branch_id, 'supplier_refund_receipt', x.id,
    v_reason, jsonb_build_object('supplierRefundId', x.id, 'dealId', x.deal_id, 'rowVersion', x.row_version + 1));
  return v_result;
end;
$$;

-- ===========================================================================
-- accounts_supplier_payables (7.4): refunds expected and received side by side
-- ===========================================================================

create or replace function public.accounts_supplier_payables(p_deal_id uuid) returns jsonb
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
    'suppliers', authz.dues_supplier_payables(v_deal.id),
    -- Accounts phase 2 (20261204000340): supplier refunds after a cancellation (no difference shown).
    'supplierRefundsExpectedPaise', (select coalesce(sum(s.expected_paise), 0)::text from authz.supplier_refund_sources(v_deal.id) s),
    'supplierRefundsReceivedPaise', (select coalesce(sum(r.amount_paise), 0)::text from public.supplier_refund_receipts r
                                     where r.deal_id = v_deal.id and r.status = 'verified'),
    'supplierRefunds', coalesce((
      select jsonb_agg(jsonb_build_object('supplierId', g.supplier_id, 'supplierName', sp.name,
          'expectedPaise', g.expected::text, 'receivedPaise', g.received::text) order by sp.name nulls last, g.supplier_id)
      from (select s.supplier_id, sum(s.expected_paise)::bigint as expected, sum(s.received_paise)::bigint as received
            from authz.supplier_refund_sources(v_deal.id) s group by s.supplier_id) g
      left join public.suppliers sp on sp.id = g.supplier_id), '[]'::jsonb));
end;
$$;

revoke all on function authz.supplier_refund_sources(uuid) from public, anon, authenticated, service_role;
revoke all on function public.supplier_refund_record(jsonb, uuid), public.supplier_refund_cancel(uuid, integer, text, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.supplier_refund_record(jsonb, uuid), public.supplier_refund_cancel(uuid, integer, text, uuid)
to authenticated;

commit;
