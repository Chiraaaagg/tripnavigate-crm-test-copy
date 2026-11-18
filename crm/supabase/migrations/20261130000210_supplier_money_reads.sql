-- Purchase build, Track B (2 of 2): supplier money reads and Home counts.
-- Shapes: crm/src/modules/supplier-money/contracts.ts (frozen 2 Nov 2026).
--
-- Reads (security definer; execute granted to authenticated only):
--   purchase_payment_requests(text)  Purchase: own or all requests of the
--     entity. Never a funding amount or reason, never a payment proof file,
--     never customer money amounts.
--   purchase_payment_context(uuid)   Purchase (and the branch Manager,
--     read-only): the Supplier payments card, drawer and Files section of
--     one task. No customer money or company funding signal (review F1).
--   accounts_supplier_payments(text), accounts_supplier_documents(text),
--   accounts_company_funding(text)   Accounts, through the finance gate.
--   manager_approvals()              the manager's branches (costs above
--     budget, payments, funding, bank details, suppliers to verify, trip
--     cancellations sent to the Manager).
--   supplier_money_home_counts()     the supplier money Home rows (Purchase,
--     Accounts, Manager; null = not applicable).
--   my_work_counts()                 replaces 20261123000100 with the same
--     keys; requestsToApprove now counts real items for Accounts (go-ahead,
--     payments, funding to approve) and Managers (manager_approvals rows).
--
-- Rollback (forward-only): a NEW migration restoring my_work_counts from
-- 20261123000100 and revoking execute on the new reads.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Row shapes
-- ===========================================================================

-- PurchasePaymentRequestView. Viewer-dependent flags use auth.uid().
create function authz.sm_purchase_payment_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id,
    'refNo', p.ref_no,
    'dealId', p.deal_id,
    'dealReference', d.reference,
    'taskId', p.task_id,
    'serviceTitle', coalesce(authz.sm_task_title(p.task_id), 'Service'),
    'serviceType', coalesce(authz.sm_task_type(p.task_id), 'hotel'),
    'supplierId', p.supplier_id,
    'supplierName', s.name,
    'part', p.part,
    'amountPaise', p.amount_paise::text,
    'dueDate', to_char(p.due_date, 'YYYY-MM-DD'),
    'note', p.note,
    'route', p.route,
    'status', p.status,
    'costVersionNo', p.cost_version_no,
    'proformaEvidenceId', p.proforma_evidence_id,
    'returnReason', p.return_reason,
    'requestedAt', p.requested_at,
    'requestedByName', rp.display_name,
    'decidedAt', p.decided_at,
    'decidedByName', dp.display_name
  ) || jsonb_build_object(
    'paidOn', to_char(p.paid_on, 'YYYY-MM-DD'),
    'paymentMode', p.payment_mode,
    'bankReference', p.bank_reference,
    'verifiedAt', p.verified_at,
    -- Review F1: no customer money or company funding signal for Purchase;
    -- only the bank detail hold (supplier data).
    'onHold', coalesce(h.reason = 'bank_details_on_hold', false),
    'holdReason', case when h.reason = 'bank_details_on_hold' then h.reason end,
    'resubmittedAs', (select n.ref_no from public.supplier_payment_requests n where n.resubmits_id = p.id),
    'resubmitsRefNo', o.ref_no,
    'canCancel', p.status = 'pending' and p.requested_by = (select auth.uid())
                 and authz.holds_active_role('purchase', p.legal_entity_id),
    'canResubmit', p.status = 'returned'
                   and not exists (select 1 from public.supplier_payment_requests n where n.resubmits_id = p.id)
                   and coalesce(authz.can_work_purchase_task(p.task_id), false))
  from public.supplier_payment_requests p
  join public.deals d on d.id = p.deal_id
  join public.suppliers s on s.id = p.supplier_id
  left join public.staff_profiles rp on rp.user_id = p.requested_by
  left join public.staff_profiles dp on dp.user_id = p.decided_by
  left join public.supplier_payment_requests o on o.id = p.resubmits_id
  cross join lateral (select authz.sm_hold_reason(p.id) as reason) h
  where p.id = p_id
$$;

-- SupplierDocumentView.
create function authz.sm_document_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', x.id,
    'kind', x.kind,
    'taskId', x.task_id,
    'dealReference', d.reference,
    'serviceTitle', coalesce(authz.sm_task_title(x.task_id), 'Service'),
    'supplierId', x.supplier_id,
    'supplierName', s.name,
    'number', x.number,
    'docDate', to_char(x.doc_date, 'YYYY-MM-DD'),
    'totalPaise', x.total_paise::text,
    'gstIncluded', x.gst_included,
    'evidenceId', x.evidence_id,
    'status', x.status,
    'returnReason', x.return_reason,
    'uploadedAt', x.uploaded_at,
    'uploadedByName', up.display_name,
    'reviewedAt', x.reviewed_at,
    'reviewedByName', rv.display_name,
    'rowVersion', x.row_version)
  from public.supplier_documents x
  join public.deals d on d.id = x.deal_id
  join public.suppliers s on s.id = x.supplier_id
  left join public.staff_profiles up on up.user_id = x.uploaded_by
  left join public.staff_profiles rv on rv.user_id = x.reviewed_by
  where x.id = p_id
$$;

-- BankDetailsSummary of the supplier's latest revision (last 4 digits only).
create function authz.sm_bank_json(p_supplier uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'revisionNo', r.revision_no,
    'accountHolder', r.account_holder,
    'bankName', r.bank_name,
    'ifsc', r.ifsc,
    'accountLast4', right(r.account_number, 4),
    'status', r.status)
  from public.supplier_beneficiary_revisions r
  where r.supplier_id = p_supplier
  order by r.revision_no desc limit 1
$$;

-- AccountsSupplierPaymentRow (Accounts and the branch Manager).
create function authz.sm_accounts_payment_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id,
    'refNo', p.ref_no,
    'dealId', p.deal_id,
    'dealReference', d.reference,
    'branchName', b.name,
    'taskId', p.task_id,
    'serviceTitle', coalesce(authz.sm_task_title(p.task_id), 'Service'),
    'serviceType', coalesce(authz.sm_task_type(p.task_id), 'hotel'),
    'supplierId', p.supplier_id,
    'supplierName', s.name,
    'part', p.part,
    'amountPaise', p.amount_paise::text,
    'customerMoneyPaise', p.customer_money_paise::text,
    'dueDate', to_char(p.due_date, 'YYYY-MM-DD'),
    'note', p.note,
    'route', p.route,
    'status', p.status,
    'costVersionNo', p.cost_version_no,
    'agreedCostPaise', (select c.amount_paise::text from public.purchase_cost_versions c
                        where c.task_id = p.task_id and c.version_no = p.cost_version_no),
    'proformaEvidenceId', p.proforma_evidence_id,
    'returnReason', p.return_reason,
    'requestedAt', p.requested_at,
    'requestedByName', rp.display_name,
    'decidedAt', p.decided_at,
    'decidedByName', dp.display_name
  ) || jsonb_build_object(
    'paidOn', to_char(p.paid_on, 'YYYY-MM-DD'),
    'paymentMode', p.payment_mode,
    'bankReference', p.bank_reference,
    'paymentProofEvidenceId', p.payment_proof_evidence_id,
    'bankRevisionNo', p.bank_revision_no,
    'recordedAt', p.recorded_at,
    'recordedByName', cp.display_name,
    'verifiedAt', p.verified_at,
    'verifiedByName', vp.display_name,
    'bankDetails', authz.sm_bank_json(p.supplier_id),
    'funding', case when f.id is null then null else jsonb_build_object(
      'id', f.id, 'amountPaise', f.amount_paise::text, 'reason', f.reason, 'route', f.route, 'status', f.status) end,
    'onHold', h.reason is not null,
    'holdReason', h.reason,
    'rowVersion', p.row_version,
    'canDecide', p.status = 'pending' and p.requested_by <> (select auth.uid())
                 and authz.sm_can_decide_route(p.route, p.legal_entity_id, p.deal_id, d.is_synthetic),
    'canRecord', p.status = 'approved' and h.reason is null and authz.sm_accounts_sees(p.legal_entity_id, d.is_synthetic),
    'canVerify', p.status = 'paid' and p.recorded_by <> (select auth.uid())
                 and authz.sm_accounts_sees(p.legal_entity_id, d.is_synthetic))
  from public.supplier_payment_requests p
  join public.deals d on d.id = p.deal_id
  join public.branches b on b.id = p.branch_id
  join public.suppliers s on s.id = p.supplier_id
  left join public.company_funding_requests f on f.payment_request_id = p.id
  left join public.staff_profiles rp on rp.user_id = p.requested_by
  left join public.staff_profiles dp on dp.user_id = p.decided_by
  left join public.staff_profiles cp on cp.user_id = p.recorded_by
  left join public.staff_profiles vp on vp.user_id = p.verified_by
  cross join lateral (select authz.sm_hold_reason(p.id) as reason) h
  where p.id = p_id
$$;

-- CompanyFundingRow (Accounts and the branch Manager; never Purchase).
create function authz.sm_funding_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', f.id,
    'paymentRequestId', p.id,
    'paymentRefNo', p.ref_no,
    'paymentStatus', p.status,
    'dealId', f.deal_id,
    'dealReference', d.reference,
    'branchName', b.name,
    'supplierName', s.name,
    'serviceTitle', coalesce(authz.sm_task_title(p.task_id), 'Service'),
    'amountPaise', f.amount_paise::text,
    'reason', f.reason,
    'route', f.route,
    'status', f.status,
    'returnReason', f.return_reason,
    'requestedAt', f.requested_at,
    'requestedByName', rp.display_name,
    'decidedAt', f.decided_at,
    'decidedByName', dp.display_name,
    'recoveredAt', f.recovered_at,
    'recoveredByName', cp.display_name,
    'recoveryNote', f.recovery_note,
    'rowVersion', f.row_version,
    'canDecide', f.status = 'pending' and p.status not in ('returned', 'cancelled')
                 and f.requested_by <> (select auth.uid())
                 and authz.sm_can_decide_route(f.route, f.legal_entity_id, f.deal_id, d.is_synthetic),
    'canMarkRecovered', f.status = 'approved' and p.status in ('paid', 'verified')
                        and authz.sm_accounts_sees(f.legal_entity_id, d.is_synthetic))
  from public.company_funding_requests f
  join public.supplier_payment_requests p on p.id = f.payment_request_id
  join public.deals d on d.id = f.deal_id
  join public.branches b on b.id = f.branch_id
  join public.suppliers s on s.id = p.supplier_id
  left join public.staff_profiles rp on rp.user_id = f.requested_by
  left join public.staff_profiles dp on dp.user_id = f.decided_by
  left join public.staff_profiles cp on cp.user_id = f.recovered_by
  where f.id = p_id
$$;

revoke all on function
  authz.sm_purchase_payment_json(uuid), authz.sm_document_json(uuid), authz.sm_bank_json(uuid),
  authz.sm_accounts_payment_json(uuid), authz.sm_funding_json(uuid)
from public, anon, authenticated;

-- ===========================================================================
-- 2. Purchase reads
-- ===========================================================================

create function public.purchase_payment_requests(p_scope text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_scope is null or p_scope not in ('mine', 'all') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(authz.sm_purchase_payment_json(x.id) order by x.requested_at desc, x.id)
    from (
      select p.id, p.requested_at
      from public.supplier_payment_requests p
      join public.fulfilment_tasks t on t.id = p.task_id
      where t.department = 'purchase'
        and authz.holds_active_role('purchase', p.legal_entity_id)
        and (p_scope = 'all' or p.requested_by = v_uid or t.assignee_user_id = v_uid)
      order by p.requested_at desc, p.id
      limit 500
    ) x), '[]'::jsonb);
end;
$$;

-- One task: null when the viewer cannot read the Purchase workspace.
create function public.purchase_payment_context(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_cost public.purchase_cost_versions;
  v_supplier uuid;
  v_supplier_name text;
  v_quote_status text;
  v_confirmed boolean;
  v_gate text;
  v_live bigint := 0;
  v_remaining bigint := 0;
  v_budget bigint;
  v_blockers text[] := '{}'::text[];
  v_needed boolean;
  v_valid boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or v_task.department is distinct from 'purchase'
     or not authz.can_read_purchase_workspace(v_task.id) then
    return null;
  end if;
  v_confirmed := authz.sm_task_confirmed(v_task.status);
  v_cost := authz.purchase_agreed_cost(v_task.id);
  if v_cost.id is not null then
    select q.supplier_id, s.name, q.status into v_supplier, v_supplier_name, v_quote_status
    from public.purchase_quotes q join public.suppliers s on s.id = q.supplier_id where q.id = v_cost.quote_id;
    select coalesce(sum(p.amount_paise), 0) into v_live from public.supplier_payment_requests p
    where p.task_id = v_task.id and p.status in ('pending', 'approved', 'paid', 'verified');
    v_remaining := greatest(v_cost.amount_paise - v_live, 0);
  end if;
  v_needed := authz.purchase_go_ahead_needed(v_task.id);
  v_valid := authz.purchase_go_ahead_valid(v_task.id);

  -- Blockers in the order the create command checks them.
  v_gate := authz.procurement_gate_issue(v_task.id);
  if v_gate is not null then
    v_blockers := v_blockers || v_gate;
  end if;
  if authz.deal_trip_cancelled(v_task.deal_id) then
    v_blockers := v_blockers || 'trip_cancelled'::text;
  end if;
  if v_cost.id is null then
    v_blockers := v_blockers || 'not_ready'::text;
  elsif not v_confirmed then
    if v_quote_status is distinct from 'open' then
      v_blockers := v_blockers || 'not_ready'::text;
    end if;
    v_budget := authz.task_budget(v_task.id);
    if (v_budget is null or v_cost.amount_paise > v_budget)
       and not authz.cost_version_approved(v_task.id, v_cost.version_no) then
      v_blockers := v_blockers || 'over_budget'::text;
    end if;
    if v_needed and not v_valid then
      v_blockers := v_blockers || 'go_ahead_missing'::text;
    end if;
  end if;
  if v_cost.id is not null and v_remaining = 0 then
    v_blockers := v_blockers || 'over_agreed_cost'::text;
  end if;

  return jsonb_build_object(
    'taskId', v_task.id,
    'dealId', v_task.deal_id,
    'dealReference', (select d.reference from public.deals d where d.id = v_task.deal_id),
    'serviceType', coalesce(authz.sm_task_type(v_task.id), 'hotel'),
    'serviceTitle', coalesce(authz.sm_task_title(v_task.id), 'Service'),
    'taskStatus', v_task.status,
    'supplierId', v_supplier,
    'supplierName', v_supplier_name,
    'costVersionNo', v_cost.version_no,
    'agreedCostPaise', v_cost.amount_paise::text,
    'requestedPaise', v_live::text,
    'remainingPaise', v_remaining::text,
    'goAheadState', authz.purchase_go_ahead_state(v_task.id),
    'goAheadNeeded', v_needed,
    'goAheadValid', v_valid,
    'allowedParts', case when v_confirmed then '["deposit", "balance", "full"]'::jsonb else '["deposit"]'::jsonb end,
    'blockers', to_jsonb(array(select u.b from unnest(v_blockers) with ordinality u(b, n) group by u.b order by min(u.n))),
    'canRequest', coalesce(authz.can_work_purchase_task(v_task.id), false)
  ) || jsonb_build_object(
    'canUploadDocuments', coalesce(authz.holds_active_role('purchase', v_task.legal_entity_id), false)
                          and authz.procurement_gate_issue(v_task.id) is null,
    'routeRunningTotalPaise', case when v_supplier is null then '0'
                                   else authz.sm_supplier_running_total(v_task.deal_id, v_supplier)::text end,
    'approvalLimitPaise', '5000000',
    'bankDetailsApproved', v_supplier is not null and authz.sm_bank_approved(v_supplier),
    'invoiceMissing', coalesce(authz.sm_invoice_missing(v_task.id), false),
    'requests', coalesce((
      select jsonb_agg(authz.sm_purchase_payment_json(p.id) order by p.requested_at desc, p.id)
      from public.supplier_payment_requests p where p.task_id = v_task.id), '[]'::jsonb),
    'documents', coalesce((
      select jsonb_agg(authz.sm_document_json(x.id) order by x.uploaded_at desc, x.id)
      from public.supplier_documents x where x.task_id = v_task.id), '[]'::jsonb),
    'files', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id,
        'kind', e.kind,
        'fileName', e.file_name,
        'mime', e.mime,
        'sizeBytes', e.size_bytes,
        'status', e.status,
        'createdAt', e.created_at,
        'uploadedByName', p.display_name) order by e.created_at, e.id)
      from public.supplier_money_evidence e
      left join public.staff_profiles p on p.user_id = e.uploaded_by
      where e.task_id = v_task.id and e.kind <> 'payment_proof' and e.status <> 'removed'), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- 3. Accounts reads
-- ===========================================================================

create function public.accounts_supplier_payments(p_tab text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  perform authz.finance_require_accounts_anywhere();
  if p_tab is null or p_tab not in ('to_approve', 'to_record', 'to_verify', 'all') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(authz.sm_accounts_payment_json(x.id) order by x.ord)
    from (
      select p.id, row_number() over (order by
          case when p_tab = 'all' then null else coalesce(p.due_date, date '2100-12-31') end,
          case when p_tab = 'all' then p.requested_at end desc,
          p.requested_at, p.id) as ord
      from public.supplier_payment_requests p
      join public.deals d on d.id = p.deal_id
      where authz.sm_accounts_sees(p.legal_entity_id, d.is_synthetic)
        and case p_tab
          when 'to_approve' then p.status = 'pending' and p.route = 'accounts' and p.requested_by <> v_uid
          when 'to_record' then p.status = 'approved'
          when 'to_verify' then p.status = 'paid' and p.recorded_by <> v_uid
          else true end
      order by 2
      limit 500
    ) x), '[]'::jsonb);
end;
$$;

create function public.accounts_supplier_documents(p_tab text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  perform authz.finance_require_accounts_anywhere();
  if p_tab is null or p_tab not in ('to_review', 'missing', 'all') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  return jsonb_build_object(
    'documents', case when p_tab = 'missing' then '[]'::jsonb else coalesce((
      select jsonb_agg(authz.sm_document_json(x.id) || jsonb_build_object(
               'branchName', x.branch_name,
               'canReview', x.status = 'uploaded' and x.uploaded_by <> v_uid) order by x.ord)
      from (
        select s.id, s.status, s.uploaded_by, b.name as branch_name,
          row_number() over (order by s.uploaded_at desc, s.id) as ord
        from public.supplier_documents s
        join public.deals d on d.id = s.deal_id
        join public.branches b on b.id = s.branch_id
        where authz.sm_accounts_sees(s.legal_entity_id, d.is_synthetic)
          and (p_tab = 'all' or s.status = 'uploaded')
        order by s.uploaded_at desc, s.id
        limit 500
      ) x), '[]'::jsonb) end,
    'missingInvoices', case when p_tab = 'to_review' then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
               'taskId', y.id,
               'dealReference', y.reference,
               'serviceTitle', coalesce(authz.sm_task_title(y.id), 'Service'),
               'supplierId', y.supplier_id,
               'supplierName', y.supplier_name,
               'tripEnd', to_char(y.trip_end, 'YYYY-MM-DD'),
               'assigneeName', y.assignee_name) order by y.trip_end, y.id)
      from (
        select t.id, d.reference, q.supplier_id, s.name as supplier_name, authz.sm_trip_end(t.id) as trip_end,
          ap.display_name as assignee_name
        from public.fulfilment_tasks t
        join public.deals d on d.id = t.deal_id
        left join public.purchase_quotes q on q.id = t.selected_quote_id
        left join public.suppliers s on s.id = q.supplier_id
        left join public.staff_profiles ap on ap.user_id = t.assignee_user_id
        where t.department = 'purchase' and t.status in ('supplier_confirmed', 'completed')
          and authz.sm_accounts_sees(t.legal_entity_id, d.is_synthetic)
          and authz.sm_invoice_missing(t.id)
        limit 500
      ) y), '[]'::jsonb) end);
end;
$$;

create function public.accounts_company_funding(p_tab text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  perform authz.finance_require_accounts_anywhere();
  if p_tab is null or p_tab not in ('to_approve', 'to_recover', 'all') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(authz.sm_funding_json(x.id) order by x.requested_at desc, x.id)
    from (
      select f.id, f.requested_at
      from public.company_funding_requests f
      join public.supplier_payment_requests p on p.id = f.payment_request_id
      join public.deals d on d.id = f.deal_id
      where authz.sm_accounts_sees(f.legal_entity_id, d.is_synthetic)
        and case p_tab
          when 'to_approve' then f.status = 'pending' and f.route = 'accounts' and f.requested_by <> v_uid
                                 and p.status not in ('returned', 'cancelled')
          when 'to_recover' then f.status = 'approved'
          else true end
      order by f.requested_at desc, f.id
      limit 500
    ) x), '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- 4. Manager approvals (one predicate source for the page and Home)
-- ===========================================================================

create function authz.sm_manager_cost_rows()
returns table (task_id uuid, version_no integer, since timestamptz, created_by uuid)
language sql stable security definer set search_path = '' as $$
  select t.id, c.version_no, c.created_at, c.created_by
  from public.fulfilment_tasks t
  cross join lateral (select * from authz.purchase_latest_cost(t.id)) c
  where t.department = 'purchase' and t.status = 'in_progress'
    and authz.is_branch_sales_manager(t.deal_id)
    and c.id is not null and c.stage = 'proposed'
    and (authz.task_budget(t.id) is null or c.amount_paise > authz.task_budget(t.id))
    and not authz.cost_version_approved(t.id, c.version_no)
$$;

create function authz.sm_manager_bank_rows()
returns table (supplier_id uuid, revision_no integer, created_by uuid, created_at timestamptz)
language sql stable security definer set search_path = '' as $$
  select s.id, r.revision_no, r.created_by, r.created_at
  from public.suppliers s
  cross join lateral (select * from public.supplier_beneficiary_revisions x
                      where x.supplier_id = s.id order by x.revision_no desc limit 1) r
  where r.status = 'unverified' and authz.can_verify_suppliers(s.legal_entity_id)
$$;

create function authz.sm_manager_supplier_rows()
returns table (supplier_id uuid, can_verify boolean)
language sql stable security definer set search_path = '' as $$
  select s.id, s.created_by <> (select auth.uid()) and s.updated_by <> (select auth.uid())
  from public.suppliers s
  where s.verification_status = 'unverified' and s.status = 'active' and authz.can_verify_suppliers(s.legal_entity_id)
$$;

-- Trip cancellations sent to the Manager of the Deal's branch. Charges are
-- the latest revision per task. plpgsql: Track A owns these tables.
create function authz.sm_manager_cancellations_json() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'cancellationId', c.id,
      'dealId', c.deal_id,
      'dealReference', d.reference,
      'reason', c.reason,
      'status', c.status,
      'sentAt', c.sent_at,
      'sentByName', sp.display_name,
      'chargeCount', coalesce(ch.n, 0),
      'supplierKeepsPaise', coalesce(ch.keeps, 0)::text,
      'supplierRefundPaise', coalesce(ch.refund, 0)::text,
      'rowVersion', c.row_version,
      'canDecide', not coalesce(ch.mine, false)) order by c.sent_at, c.id)
    from public.deal_cancellations c
    join public.deals d on d.id = c.deal_id
    left join public.staff_profiles sp on sp.user_id = c.sent_by
    left join lateral (
      select count(*)::integer as n, sum(l.supplier_keeps_paise) as keeps, sum(l.supplier_refund_paise) as refund,
             bool_or(l.entered_by = (select auth.uid())) as mine
      from (select distinct on (x.task_id) x.*
            from public.purchase_cancellation_charges x
            where x.cancellation_id = c.id
            order by x.task_id, x.revision_no desc) l) ch on true
    where c.status = 'sent_to_manager' and authz.is_branch_sales_manager(c.deal_id)), '[]'::jsonb);
end;
$$;

revoke all on function authz.sm_manager_cost_rows(), authz.sm_manager_bank_rows(), authz.sm_manager_supplier_rows(),
  authz.sm_manager_cancellations_json()
from public, anon, authenticated;

create function public.manager_approvals() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if not coalesce(authz.session_ok(), false) or not exists (
       select 1 from public.memberships m
       where m.user_id = v_uid and m.status = 'active' and m.role_code = 'manager'
         and authz.holds_active_role('manager', m.legal_entity_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'costsAboveBudget', coalesce((
      select jsonb_agg(jsonb_build_object(
        'taskId', r.task_id,
        'dealReference', d.reference,
        'serviceTitle', coalesce(authz.sm_task_title(r.task_id), 'Service'),
        'supplierName', s.name,
        'versionNo', r.version_no,
        'amountPaise', c.amount_paise::text,
        'budgetPaise', coalesce(authz.task_budget(r.task_id), 0)::text,
        'proposedAt', r.since,
        'proposedByName', p.display_name,
        'canApprove', r.created_by <> v_uid) order by r.since, r.task_id)
      from authz.sm_manager_cost_rows() r
      join public.fulfilment_tasks t on t.id = r.task_id
      join public.deals d on d.id = t.deal_id
      join public.purchase_cost_versions c on c.task_id = r.task_id and c.version_no = r.version_no
      left join public.purchase_quotes q on q.id = c.quote_id
      left join public.suppliers s on s.id = q.supplier_id
      left join public.staff_profiles p on p.user_id = r.created_by), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(authz.sm_accounts_payment_json(p.id) order by coalesce(p.due_date, date '2100-12-31'), p.requested_at, p.id)
      from public.supplier_payment_requests p
      where p.route = 'manager' and p.status = 'pending' and authz.is_branch_sales_manager(p.deal_id)
        -- Review F5: a manager who also holds Purchase never sees customer money or funding.
        and not authz.holds_role('purchase', p.legal_entity_id)), '[]'::jsonb),
    'funding', coalesce((
      select jsonb_agg(authz.sm_funding_json(f.id) order by f.requested_at, f.id)
      from public.company_funding_requests f
      join public.supplier_payment_requests p on p.id = f.payment_request_id
      where f.route = 'manager' and f.status = 'pending' and p.status not in ('returned', 'cancelled')
        and authz.is_branch_sales_manager(f.deal_id) and not authz.holds_role('purchase', f.legal_entity_id)), '[]'::jsonb),
    'bankDetails', coalesce((
      select jsonb_agg(jsonb_build_object(
        'supplierId', s.id,
        'supplierName', s.name,
        'revisionNo', x.revision_no,
        'accountHolder', x.account_holder,
        'bankName', x.bank_name,
        'ifsc', x.ifsc,
        'accountLast4', right(x.account_number, 4),
        'createdAt', x.created_at,
        'createdByName', p.display_name,
        'canApprove', x.created_by <> v_uid) order by x.created_at, s.id)
      from authz.sm_manager_bank_rows() r
      join public.suppliers s on s.id = r.supplier_id
      join public.supplier_beneficiary_revisions x on x.supplier_id = r.supplier_id and x.revision_no = r.revision_no
      left join public.staff_profiles p on p.user_id = x.created_by), '[]'::jsonb),
    'suppliersToVerify', coalesce((
      select jsonb_agg(jsonb_build_object(
        'supplierId', s.id,
        'name', s.name,
        'city', s.city,
        'serviceTypes', to_jsonb(s.service_types),
        'rowVersion', s.row_version,
        'updatedAt', s.updated_at,
        'canVerify', r.can_verify) order by lower(s.name), s.id)
      from authz.sm_manager_supplier_rows() r
      join public.suppliers s on s.id = r.supplier_id), '[]'::jsonb),
    'cancellations', authz.sm_manager_cancellations_json());
end;
$$;

-- ===========================================================================
-- 5. Home
-- ===========================================================================

-- Every supplier money Home count of the caller (SupplierMoneyHomeCounts);
-- null = not applicable to the caller's roles. One predicate source for
-- my_work_counts.requestsToApprove and supplier_money_home_counts().
create function authz.sm_home_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_manager boolean;
  v_purchase boolean;
  v_accounts boolean;
  v_requests integer;
  v_p_not_taken integer;
  v_p_go_ahead integer;
  v_p_costs integer;
  v_p_returned integer;
  v_p_invoices integer;
  v_a_go_ahead integer;
  v_a_approve integer;
  v_a_record integer;
  v_a_verify integer;
  v_a_documents integer;
  v_a_funding integer;
  v_a_recover integer;
  v_m_approvals integer;
begin
  select
    bool_or(m.role_code = 'manager' and authz.holds_active_role('manager', m.legal_entity_id)),
    bool_or(m.role_code = 'purchase' and authz.holds_active_role('purchase', m.legal_entity_id)),
    bool_or(m.role_code = 'accounts' and authz.holds_active_role('accounts', m.legal_entity_id)
            and not authz.holds_role('purchase', m.legal_entity_id))
  into v_manager, v_purchase, v_accounts
  from public.memberships m where m.user_id = v_uid and m.status = 'active';

  -- Purchase: own tasks and own requests.
  if coalesce(v_purchase, false) then
    select count(*) into v_p_not_taken from public.fulfilment_tasks t
    where t.department = 'purchase' and t.status = 'not_started' and authz.can_read_purchase_task(t.id);
    select count(*) filter (where authz.purchase_go_ahead_state(t.id) = 'pending'),
           count(*) filter (where c.id is not null and c.stage = 'proposed'
                              and (authz.task_budget(t.id) is null or c.amount_paise > authz.task_budget(t.id))
                              and not authz.cost_version_approved(t.id, c.version_no))
    into v_p_go_ahead, v_p_costs
    from public.fulfilment_tasks t
    left join lateral (select * from authz.purchase_latest_cost(t.id)) c on true
    where t.department = 'purchase' and t.status = 'in_progress' and t.assignee_user_id = v_uid;
    select count(*) into v_p_returned
    from public.supplier_payment_requests p
    where p.requested_by = v_uid and p.status = 'returned'
      and authz.holds_active_role('purchase', p.legal_entity_id)
      and not exists (select 1 from public.supplier_payment_requests n where n.resubmits_id = p.id);
    select count(*) into v_p_invoices
    from public.fulfilment_tasks t
    where t.department = 'purchase' and t.status in ('supplier_confirmed', 'completed') and t.assignee_user_id = v_uid
      and authz.holds_active_role('purchase', t.legal_entity_id)
      and authz.sm_invoice_missing(t.id);
  end if;

  -- Accounts: the rows of accounts_go_ahead_list / accounts_supplier_payments /
  -- accounts_supplier_documents / accounts_company_funding, over the finance
  -- gate (entity x synthetic flag).
  if coalesce(v_accounts, false) then
    with gate as materialized (
      select e.id as legal_entity_id, s.is_synthetic
      from public.legal_entities e
      cross join (values (true), (false)) as s(is_synthetic)
      where authz.can_accounts(e.id)
        and authz.finance_gate_issue(e.id, s.is_synthetic) is null
    )
    select
      (select count(*)
       from public.purchase_go_ahead_requests r
       join public.deals d on d.id = r.deal_id
       join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
       where r.status = 'pending' and r.requested_by <> v_uid),
      (select count(*)
       from public.supplier_payment_requests p
       join public.deals d on d.id = p.deal_id
       join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
       where p.status = 'pending' and p.route = 'accounts' and p.requested_by <> v_uid
         and not authz.finance_deal_conflict(p.deal_id)),
      (select count(*)
       from public.supplier_payment_requests p
       join public.deals d on d.id = p.deal_id
       join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
       where p.status = 'approved'),
      (select count(*)
       from public.supplier_payment_requests p
       join public.deals d on d.id = p.deal_id
       join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
       where p.status = 'paid' and p.recorded_by <> v_uid),
      (select count(*)
       from public.supplier_documents s
       join public.deals d on d.id = s.deal_id
       join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
       where s.status = 'uploaded' and s.uploaded_by <> v_uid),
      (select count(*)
       from public.company_funding_requests f
       join public.supplier_payment_requests p on p.id = f.payment_request_id
       join public.deals d on d.id = f.deal_id
       join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
       where f.status = 'pending' and f.route = 'accounts' and f.requested_by <> v_uid
         and p.status not in ('returned', 'cancelled') and not authz.finance_deal_conflict(f.deal_id)),
      (select count(*)
       from public.company_funding_requests f
       join public.deals d on d.id = f.deal_id
       join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
       where f.status = 'approved')
    into v_a_go_ahead, v_a_approve, v_a_record, v_a_verify, v_a_documents, v_a_funding, v_a_recover;
    v_requests := v_a_go_ahead + v_a_approve + v_a_funding;
  end if;

  -- Manager: exactly the actionable rows of manager_approvals().
  if coalesce(v_manager, false) then
    select
      (select count(*) from authz.sm_manager_cost_rows() r where r.created_by <> v_uid)
      + (select count(*) from public.supplier_payment_requests p
         where p.route = 'manager' and p.status = 'pending' and p.requested_by <> v_uid
           and authz.is_branch_sales_manager(p.deal_id) and not authz.holds_role('purchase', p.legal_entity_id)
           and not authz.finance_deal_conflict(p.deal_id))
      + (select count(*) from public.company_funding_requests f
         join public.supplier_payment_requests p on p.id = f.payment_request_id
         where f.route = 'manager' and f.status = 'pending' and f.requested_by <> v_uid
           and p.status not in ('returned', 'cancelled') and authz.is_branch_sales_manager(f.deal_id)
           and not authz.holds_role('purchase', f.legal_entity_id) and not authz.finance_deal_conflict(f.deal_id))
      + (select count(*) from authz.sm_manager_bank_rows() r where r.created_by <> v_uid)
      + (select count(*) from authz.sm_manager_supplier_rows() r where r.can_verify)
      + (select count(*) from jsonb_array_elements(authz.sm_manager_cancellations_json()) c
         where (c ->> 'canDecide')::boolean)
    into v_m_approvals;
    v_requests := coalesce(v_requests, 0) + v_m_approvals;
  end if;

  return jsonb_build_object(
    'requestsToApprove', v_requests,
    'purchaseTasksNotTaken', v_p_not_taken,
    'purchaseWaitingForGoAhead', v_p_go_ahead,
    'purchaseCostsWaitingForManager', v_p_costs,
    'paymentRequestsReturned', v_p_returned,
    'supplierInvoicesMissing', v_p_invoices,
    'goAheadToApprove', v_a_go_ahead,
    'supplierPaymentsToApprove', v_a_approve,
    'supplierPaymentsToRecord', v_a_record,
    'supplierPaymentsToVerify', v_a_verify,
    'supplierDocumentsToReview', v_a_documents,
    'fundingToApprove', v_a_funding,
    'fundingToRecover', v_a_recover,
    'managerApprovals', v_m_approvals);
end;
$$;
revoke all on function authz.sm_home_counts() from public, anon, authenticated;

-- Supplier money Home rows (SupplierMoneyHomeCounts). my_work_counts keeps
-- its earlier key set; Home reads these rows here.
create function public.supplier_money_home_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return authz.sm_home_counts();
end;
$$;

create or replace function public.my_work_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_sales boolean;
  v_manager boolean;
  v_purchase boolean;
  v_flight boolean;
  -- B1.1c
  v_visa boolean;
  v_visa_waiting integer;
  v_accounts boolean;
  v_waiting integer := 0;
  v_returned integer := 0;
  v_missing integer := 0;
  v_intake integer := 0;
  v_receipts integer;
  v_requests integer;
  -- Batch 1 B1-3
  v_drafts integer;
  v_n integer;
  -- Batch 3
  v_to_finish integer;
  v_to_link integer;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select
    bool_or(m.role_code = 'sales' and authz.holds_active_role('sales', m.legal_entity_id)),
    bool_or(m.role_code = 'manager' and authz.holds_active_role('manager', m.legal_entity_id)),
    bool_or(m.role_code = 'purchase' and authz.holds_active_role('purchase', m.legal_entity_id)),
    bool_or(m.role_code = 'flight' and authz.holds_active_role('flight', m.legal_entity_id)),
    bool_or(m.role_code = 'visa' and authz.holds_active_role('visa', m.legal_entity_id)),
    bool_or(m.role_code = 'accounts' and authz.holds_active_role('accounts', m.legal_entity_id)
            and not authz.holds_role('purchase', m.legal_entity_id))
  into v_sales, v_manager, v_purchase, v_flight, v_visa, v_accounts
  from public.memberships m where m.user_id = v_uid and m.status = 'active';

  -- Sales / Manager: drafts the caller may edit, their repair subset,
  -- returned reviews, and (while the prompt is on) confirmed Bitrix Deals
  -- without a booking.
  if coalesce(v_sales, false) or coalesce(v_manager, false) then
    -- Batch 1 B1-3 (Echo L7): one scan gives the existing counts and the
    -- drafts the caller may continue, exactly the rows of
    -- my_work_list('drafts') (Deals removed by the sync are left out; the
    -- deals join is one-to-one, so waitingForMe and missingDetails keep
    -- their values).
    select count(*), count(*) filter (where cardinality(authz.booking_issues(v.id)) > 0),
           count(*) filter (where d.removed_at is null)
    into v_waiting, v_missing, v_drafts
    from public.booking_versions v
    join public.deals d on d.id = v.deal_id
    where v.status = 'draft' and authz.can_edit_booking_draft(v.deal_id);
    select count(distinct d.id) into v_returned
    from public.deals d
    join public.booking_versions v on v.deal_id = d.id and v.status = 'confirmed'
    join public.accounts_booking_reviews rv on rv.booking_version_id = v.id and rv.status = 'returned'
    where d.removed_at is null
      and ((d.owner_user_id = v_uid and authz.holds_active_role('sales', d.legal_entity_id))
           or authz.is_branch_sales_manager(d.id));
    -- Batch 3 (FP-081): exactly the rows of my_work_list('quotation_drafts' / 'accepted_to_link').
    select count(*) filter (where w.to_finish), count(*) filter (where w.accepted_not_linked)
    into v_to_finish, v_to_link
    from authz.work_quotation_rows() w;
    if coalesce((select s.intake_prompt_enabled from public.workflow_settings s where s.id), false) then
      select count(*) into v_intake
      from public.deals d
      where d.source_system = 'bitrix' and d.removed_at is null
        and authz.deal_in_trigger_stage(d.id)
        and not exists (select 1 from public.booking_versions v where v.deal_id = d.id)
        and ((d.owner_user_id = v_uid and authz.holds_active_role('sales', d.legal_entity_id))
             or authz.is_branch_sales_manager(d.id));
    end if;
  end if;

  -- Purchase: readable not-started purchase tasks plus own in-progress tasks.
  if coalesce(v_purchase, false) then
    select count(*) into v_n from public.fulfilment_tasks t
    where ((t.department = 'purchase' and t.status = 'not_started' and authz.can_read_purchase_task(t.id))
        or (t.status = 'in_progress' and t.assignee_user_id = v_uid and t.department = 'purchase'));
    v_waiting := v_waiting + v_n;
  end if;
  -- Flight: the same for the flight department.
  if coalesce(v_flight, false) then
    select count(*) into v_n from public.fulfilment_tasks t
    where ((t.department = 'flight' and t.status = 'not_started' and authz.can_read_flight_task(t.id))
        or (t.status = 'in_progress' and t.assignee_user_id = v_uid and t.department = 'flight'));
    v_waiting := v_waiting + v_n;
  end if;

  -- B1.1c Visa & Passport desk: readable not-started desk tasks plus own in-progress ones.
  if coalesce(v_visa, false) then
    select count(*) into v_visa_waiting from public.fulfilment_tasks t
    where ((t.department = 'visa' and t.status = 'not_started' and authz.can_read_visa_task(t.id))
        or (t.status = 'in_progress' and t.assignee_user_id = v_uid and t.department = 'visa'));
    v_waiting := v_waiting + v_visa_waiting;
  end if;

  -- Accounts: accounts_queue('needs_review') row count and recorded receipts
  -- by someone else, over the queue's gate (entity x synthetic flag).
  if coalesce(v_accounts, false) then
    with gate as materialized (
      select e.id as legal_entity_id, s.is_synthetic
      from public.legal_entities e
      cross join (values (true), (false)) as s(is_synthetic)
      where authz.can_accounts(e.id)
        and authz.finance_gate_issue(e.id, s.is_synthetic) is null
    )
    select
      (select count(*)
       from public.deals d
       join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
       join public.booking_versions v on v.deal_id = d.id and v.status = 'confirmed'
       left join public.accounts_booking_reviews rv on rv.booking_version_id = v.id
       where coalesce(rv.status, 'pending') = 'pending'),
      (select count(*)
       from public.customer_receipts r
       join public.deals d on d.id = r.deal_id
       join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
       where r.status = 'recorded' and r.recorded_by <> v_uid)
    into v_n, v_receipts;
    v_waiting := v_waiting + v_n;
  end if;

  -- Purchase build, Track B: real items waiting for the caller's approval
  -- (Accounts and Manager); null without either role.
  v_requests := (authz.sm_home_counts() ->> 'requestsToApprove')::integer;

  return jsonb_build_object(
    'waitingForMe', v_waiting,
    'returnedToMe', v_returned,
    'missingDetails', v_missing,
    'intakeNeeded', v_intake,
    'receiptsToVerify', v_receipts,
    'requestsToApprove', v_requests,
    -- B1.1c (freeze note 3.1): null when not applicable.
    'visaTasksWaiting', v_visa_waiting,
    'claimsToProcess', authz.finance_claims_to_process_count(),
    'expensesToReview', authz.finance_expenses_to_review_count(),
    -- Batch 1 B1-3: null when the caller holds no active Sales or Manager role.
    'draftsToContinue', v_drafts,
    -- Batch 3 (FP-081): null when the caller holds no active Sales or Manager role.
    'quotationDraftsToFinish', v_to_finish,
    'acceptedQuotesToLink', v_to_link);
end;
$$;

-- ===========================================================================
-- 6. Grants
-- ===========================================================================

revoke all on function
  public.purchase_payment_requests(text),
  public.purchase_payment_context(uuid),
  public.accounts_supplier_payments(text),
  public.accounts_supplier_documents(text),
  public.accounts_company_funding(text),
  public.manager_approvals(),
  public.supplier_money_home_counts()
from public, anon, authenticated, service_role;

grant execute on function
  public.purchase_payment_requests(text),
  public.purchase_payment_context(uuid),
  public.accounts_supplier_payments(text),
  public.accounts_supplier_documents(text),
  public.accounts_company_funding(text),
  public.manager_approvals(),
  public.supplier_money_home_counts()
to authenticated;

commit;
