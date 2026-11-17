-- Accounts phase 2, Track C fix-forward (contract 7.3 C5): refund proof
-- uploads per subject.
--
-- * public.refund_evidence_begin (replaces 20261204000310, same signature):
--   the limit of 10 proofs per subject counts only proofs not yet used by a
--   payout or a supplier refund (a cancellation case with many suppliers
--   needs more than 10 supplier-refund proofs). Found by the real-Postgres
--   concurrency suite (acc2c-concurrency, race 4).
-- * public.refund_requests_list (replaces 20261204000350, same signature and
--   rows): the Sales-owner scope is computed once per call instead of a
--   definer function per row (Phase 1 lesson E1).
-- Refusal tokens unchanged.
-- Rollback (forward-only): a NEW migration restoring the 20261204000310 body.

begin;
set local lock_timeout = '15s';

create or replace function public.refund_evidence_begin(p_subject_kind text, p_subject_id uuid, p_file_name text, p_mime text,
  p_size_bytes integer, p_sha256 text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_req public.customer_refund_requests%rowtype;
  v_c public.deal_cancellations%rowtype;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_name text := btrim(coalesce(p_file_name, ''));
  v_sha text := lower(coalesce(p_sha256, ''));
  v_payload jsonb := jsonb_build_object('subjectKind', p_subject_kind, 'subjectId', p_subject_id, 'fileName', p_file_name,
    'mime', p_mime, 'sizeBytes', p_size_bytes, 'sha256', p_sha256);
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_subject_kind = 'customer_refund' then
    select * into v_req from public.customer_refund_requests r where r.id = p_subject_id;
    select * into v_deal from public.deals d where d.id = v_req.deal_id;
  elsif p_subject_kind = 'supplier_refund' then
    select * into v_c from public.deal_cancellations c where c.id = p_subject_id;
    select * into v_deal from public.deals d where d.id = v_c.deal_id;
  else
    perform authz.refund_invalid('subjectKind');
  end if;
  if v_deal.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.finance_require_accounts(v_deal.legal_entity_id, v_deal.is_synthetic);
  if p_request_id is null then
    perform authz.refund_invalid('requestId');
  end if;
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'refund_evidence_begin', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_subject_kind = 'customer_refund' and (v_req.status <> 'approved' or v_req.outcome <> 'payout') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_subject_kind = 'supplier_refund' and v_c.status <> 'approved' then
    raise exception 'not_ready' using errcode = '55000', hint = 'cancellation';
  end if;
  if length(v_name) not between 1 and 120 or v_name !~ '^[A-Za-z0-9._ -]+$' then
    perform authz.refund_invalid('fileName');
  end if;
  if p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp') then
    perform authz.refund_invalid('mime');
  end if;
  if p_size_bytes is null or p_size_bytes not between 1 and 4194304 then
    perform authz.refund_invalid('sizeBytes');
  end if;
  if v_sha !~ '^[0-9a-f]{64}$' then
    perform authz.refund_invalid('sha256');
  end if;
  -- 20261204000360: at most 10 proofs not yet used by a payout or a supplier
  -- refund per subject (a cancellation case may need many supplier refunds).
  if (select count(*) from public.refund_evidence e
      where e.subject_kind = p_subject_kind and e.subject_id = p_subject_id and e.status in ('pending_upload', 'stored')
        and not exists (select 1 from public.customer_refund_payouts p where p.evidence_id = e.id)
        and not exists (select 1 from public.supplier_refund_receipts x where x.evidence_id = e.id)) >= 10 then
    perform authz.refund_invalid('file');
  end if;
  if exists (select 1 from public.refund_evidence e
             where e.legal_entity_id = v_deal.legal_entity_id and e.sha256 = v_sha and e.status in ('pending_upload', 'stored')) then
    raise exception 'duplicate_file' using errcode = '23505';
  end if;
  v_path := v_deal.legal_entity_id::text || '/refund/' || p_subject_id::text || '/' || v_id::text;
  begin
    insert into public.refund_evidence (id, legal_entity_id, deal_id, subject_kind, subject_id, object_path, file_name, mime,
      size_bytes, sha256, uploaded_by, request_id)
    values (v_id, v_deal.legal_entity_id, v_deal.id, p_subject_kind, p_subject_id, v_path, v_name, p_mime, p_size_bytes, v_sha,
      (select auth.uid()), p_request_id);
  exception when unique_violation then
    raise exception 'duplicate_file' using errcode = '23505';
  end;
  v_result := jsonb_build_object('outcome', 'created', 'evidenceId', v_id, 'objectPath', v_path);
  return authz.finance_remember(v_deal.legal_entity_id, p_request_id, 'refund_evidence_begin', v_payload, v_result);
end;
$$;

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
  v_m := array(select b from unnest(authz.acct_m_branches()) b);
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

commit;
