-- TripNavigate CRM - Accounts phase 3, track H (7): supplier paperwork of a
-- removed booked service (lead correction to Addendum L9).
-- Contract: accounts-phase3-2026-11-12/contract.md sections 11.1, 11.3, LD30,
-- LD31; Phase 2 supplier originals (Accounts review).
--
-- New internal helper (no grant): authz.removed_paperwork_ok(p_task, p_kind):
--   true for a supplier invoice or credit note on a closed Purchase task that
--   was supplier-confirmed (or completed) or had a supplier payment request
--   (pending, approved, paid or verified) - the cancellation invoice for the
--   charge kept and any credit note.
-- Replaced (latest bodies, same signatures; changed lines marked
-- "Accounts phase 3 (20261205000760)"):
--   public.supplier_money_evidence_begin (20261205000750),
--   public.supplier_document_upload, public.supplier_document_link_task
--     (20261203000210): the service_removed gate does not apply to that
--     paperwork; a proforma (a new payment) stays refused.
--   authz.lock_workable_task (20261127000100): the assignee of a closed task
--     hears service_removed (quotes, costs, booking requests stay blocked).
--
-- Refusal tokens: service_removed (55000).
-- Rollback (forward-only): a NEW migration restoring the cited bodies.

begin;
set local lock_timeout = '15s';

create function authz.removed_paperwork_ok(p_task uuid, p_kind text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(p_kind in ('invoice', 'credit_note'), false) and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task and t.department = 'purchase' and t.closed_state is not null
      and (t.status in ('supplier_confirmed', 'completed')
           or exists (select 1 from public.supplier_payment_requests p
                      where p.task_id = t.id and p.status in ('pending', 'approved', 'paid', 'verified'))))
$$;
revoke all on function authz.removed_paperwork_ok(uuid, text) from public, anon, authenticated, service_role;

-- Replaces 20261205000750_closed_tasks_work_lists.sql:878 (latest body; changed lines marked).
create or replace function public.supplier_money_evidence_begin(
  p_kind text, p_target_id uuid, p_file_name text, p_mime text, p_size_bytes integer, p_sha256 text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_pay public.supplier_payment_requests%rowtype;
  v_synthetic boolean;
  v_gate text;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_name text := btrim(coalesce(p_file_name, ''));
  v_sha text := lower(coalesce(p_sha256, ''));
  v_payload jsonb := jsonb_build_object('kind', p_kind, 'targetId', p_target_id, 'fileName', p_file_name,
    'mime', p_mime, 'sizeBytes', p_size_bytes, 'sha256', p_sha256);
  v_result jsonb;
begin
  if p_kind = 'payment_proof' then
    select * into v_pay from public.supplier_payment_requests p where p.id = p_target_id;
    if v_pay.id is null then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    select d.is_synthetic into v_synthetic from public.deals d where d.id = v_pay.deal_id;
    perform authz.finance_require_accounts(v_pay.legal_entity_id, v_synthetic);
    select * into v_task from public.fulfilment_tasks t where t.id = v_pay.task_id;
  elsif p_kind in ('proforma', 'invoice')
        and exists (select 1 from public.fulfilment_tasks t where t.id = p_target_id and t.department = 'flight') then
    -- Flight build (20261201000210): the task's Flight person, also after done.
    select * into v_task from public.fulfilment_tasks t where t.id = p_target_id;
    if not authz.flight_owns_task(v_task.id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    v_gate := authz.flight_gate_issue(v_task.deal_id);
    if v_gate is not null then
      raise exception '%', v_gate using errcode = '55000';
    end if;
  elsif p_kind in ('proforma', 'invoice', 'credit_note') then
    select * into v_task from public.fulfilment_tasks t where t.id = p_target_id;
    -- Accounts phase 3 (20261205000750): the assignee of a removed service hears service_removed
    -- (can_work_purchase_task is false for a closed task).
    if p_kind = 'proforma'  -- Accounts phase 3 (20261205000760): only a new payment's proforma; supplier paperwork stays allowed
       and v_task.closed_state is not null and v_task.department = 'purchase' and v_task.assignee_user_id = (select auth.uid())
       and authz.holds_active_role('purchase', v_task.legal_entity_id) then
      raise exception 'service_removed' using errcode = '55000';
    end if;
    if v_task.id is null or v_task.department is distinct from 'purchase'
       or not authz.holds_active_role('purchase', v_task.legal_entity_id)
       or (p_kind = 'proforma' and not authz.can_work_purchase_task(v_task.id)) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    v_gate := authz.procurement_gate_issue(v_task.id);
    -- Accounts phase 3 (20261205000760): the supplier's paperwork of a removed booked service.
    if v_gate = 'service_removed' and authz.removed_paperwork_ok(v_task.id, p_kind) then
      v_gate := null;
    end if;
    if v_gate is not null then
      raise exception '%', v_gate using errcode = '55000';
    end if;
  else
    if not coalesce(authz.session_ok(), false) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  v_result := authz.sm_replay(v_task.legal_entity_id, p_request_id, 'supplier_money_evidence_begin', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  if p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes not between 1 and 4194304
     or v_sha !~ '^[0-9a-f]{64}$'
     or length(v_name) not between 1 and 120 or v_name !~ '^[A-Za-z0-9._ -]+$' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  if p_kind = 'payment_proof' and v_pay.status <> 'approved' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if (select count(*) from public.supplier_money_evidence e
      where e.task_id = v_task.id and e.status <> 'removed') >= 40 then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  v_path := v_task.legal_entity_id::text || '/' || v_task.id::text || '/' || v_id::text;
  insert into public.supplier_money_evidence (id, legal_entity_id, task_id, payment_request_id, kind, object_path,
    file_name, mime, size_bytes, sha256, uploaded_by, request_id)
  values (v_id, v_task.legal_entity_id, v_task.id, v_pay.id, p_kind, v_path, v_name, p_mime, p_size_bytes, v_sha,
    (select auth.uid()), p_request_id);

  v_result := jsonb_build_object('outcome', 'created', 'evidenceId', v_id, 'objectPath', v_path);
  perform authz.sm_remember(v_task.legal_entity_id, p_request_id, 'supplier_money_evidence_begin', v_payload, v_result);
  perform authz.write_audit('purchase.money_file_started', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('evidenceId', v_id, 'kind', p_kind, 'mime', p_mime, 'sizeBytes', p_size_bytes));
  return v_result;
end;
$$;
-- Replaces 20261203000210_supplier_document_rules.sql:338 (latest body; changed lines marked).
create or replace function public.supplier_document_upload(p_task_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_cost public.purchase_cost_versions;
  v_supplier uuid;
  v_gate text;
  v_kind text;
  v_number text;
  v_date date;
  v_total bigint;
  v_evidence uuid;
  v_credits uuid;
  v_id uuid := gen_random_uuid();
  v_payload jsonb := jsonb_build_object('taskId', p_task_id, 'fields', p_fields);
  v_result jsonb;
  v_constraint text;
begin
  -- Flight build (20261201000210).
  if exists (select 1 from public.fulfilment_tasks t where t.id = p_task_id and t.department = 'flight') then
    return authz.sm_document_upload_flight(p_task_id, p_fields, p_request_id);
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or v_task.department is distinct from 'purchase'
     or not coalesce(authz.session_ok(), false) or not authz.holds_active_role('purchase', v_task.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_gate := authz.procurement_gate_issue(v_task.id);
  -- Accounts phase 3 (20261205000760): the supplier's paperwork of a removed booked service.
  if v_gate = 'service_removed' and jsonb_typeof(p_fields) = 'object' and authz.removed_paperwork_ok(v_task.id, p_fields ->> 'kind') then
    v_gate := null;
  end if;
  if v_gate is not null then
    raise exception '%', v_gate using errcode = '55000';
  end if;
  v_result := authz.sm_replay(v_task.legal_entity_id, p_request_id, 'supplier_document_upload', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['kind', 'number', 'docDate', 'totalPaise', 'gstIncluded', 'evidenceId',
                          'creditsDocumentId']) <> '{}'::jsonb  -- Accounts phase (20261203000210)
     or jsonb_typeof(p_fields -> 'gstIncluded') is distinct from 'boolean' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_kind := authz.finance_field(p_fields, 'kind');
  v_number := authz.finance_text(authz.finance_field(p_fields, 'number'), 1, 60, false);
  v_date := authz.finance_date(authz.finance_field(p_fields, 'docDate'));
  v_total := authz.finance_paise(p_fields, 'totalPaise', 1);
  v_evidence := authz.finance_uuid(authz.finance_field(p_fields, 'evidenceId'));
  if v_kind is null or v_kind not in ('invoice', 'credit_note') or v_number is null or v_date is null
     or v_date not between date '2000-01-01' and authz.finance_today() + 1
     or v_total is null or v_total > 999999999999999 or v_evidence is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- Accounts phase (20261203000210): optional credit link (credit notes only).
  begin
    v_credits := authz.finance_uuid(authz.finance_field(p_fields, 'creditsDocumentId'));
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'creditsDocumentId';
  end;
  if v_credits is not null and v_kind <> 'credit_note' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'creditsDocumentId';
  end if;
  v_cost := authz.purchase_agreed_cost(v_task.id);
  if v_cost.id is null then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  select q.supplier_id into v_supplier from public.purchase_quotes q where q.id = v_cost.quote_id;
  if v_credits is not null and not authz.sm_credit_target(v_task.legal_entity_id, v_supplier, v_credits) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'creditsDocumentId';
  end if;
  -- Accounts phase (20261203000210): duplicate refusal.
  perform authz.sm_document_refuse_duplicate(v_task.legal_entity_id, v_supplier, v_kind, v_number, v_date);
  if not exists (select 1 from public.supplier_money_evidence e
                 where e.id = v_evidence and e.task_id = v_task.id and e.kind = v_kind and e.status = 'stored')
     or exists (select 1 from public.supplier_documents s where s.evidence_id = v_evidence) then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  begin
    insert into public.supplier_documents (id, legal_entity_id, branch_id, deal_id, task_id, supplier_id, kind, number,
      doc_date, total_paise, gst_included, evidence_id, uploaded_by, request_id, credits_document_id)
    values (v_id, v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, v_supplier, v_kind, v_number,
      v_date, v_total, (p_fields ->> 'gstIncluded')::boolean, v_evidence, (select auth.uid()), p_request_id, v_credits);
  exception when unique_violation then
    -- Accounts phase (20261203000210): the race backstop.
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'supplier_documents_no_duplicate' then
      raise exception 'duplicate_supplier_document' using errcode = '23505', hint = 'number';
    end if;
    raise;
  end;
  perform authz.write_audit('purchase.supplier_document_uploaded', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null, jsonb_build_object('documentId', v_id, 'kind', v_kind));
  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'status', 'uploaded', 'rowVersion', 1);
  return authz.sm_remember(v_task.legal_entity_id, p_request_id, 'supplier_document_upload', v_payload, v_result);
end;
$$;
-- Replaces 20261203000210_supplier_document_rules.sql:455 (latest body; changed lines marked).
create or replace function public.supplier_document_link_task(p_document_id uuid, p_task_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_doc public.supplier_documents%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_synthetic boolean;
  v_is_accounts boolean;
  v_gate text;
  v_link public.supplier_document_tasks%rowtype;
  v_payload jsonb := jsonb_build_object('documentId', p_document_id, 'taskId', p_task_id);
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if p_document_id is null or p_task_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = case when p_document_id is null then 'documentId' else 'taskId' end;
  end if;
  select * into v_doc from public.supplier_documents s where s.id = p_document_id;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_doc.id is null or v_task.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = v_doc.deal_id;
  v_is_accounts := authz.sm_accounts_sees(v_doc.legal_entity_id, v_synthetic);
  if not v_is_accounts then
    if v_task.legal_entity_id <> v_doc.legal_entity_id or v_doc.status <> 'uploaded' then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    if v_task.department = 'purchase' then
      if v_task.assignee_user_id is distinct from (select auth.uid())
         or v_task.status not in ('in_progress', 'supplier_confirmed', 'completed')
         or not authz.holds_active_role('purchase', v_task.legal_entity_id) then
        raise exception 'not_authorized' using errcode = '42501';
      end if;
      v_gate := authz.procurement_gate_issue(v_task.id);
      -- Accounts phase 3 (20261205000760): the supplier's paperwork of a removed booked service.
      if v_gate = 'service_removed' and authz.removed_paperwork_ok(v_task.id, v_doc.kind) then
        v_gate := null;
      end if;
    elsif v_task.department = 'flight' then
      if not authz.flight_owns_task(v_task.id) then
        raise exception 'not_authorized' using errcode = '42501';
      end if;
      v_gate := authz.flight_gate_issue(v_task.deal_id);
    else
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    if v_gate is not null then
      raise exception '%', v_gate using errcode = '55000';
    end if;
  end if;

  perform authz.finance_lock_deal(v_task.deal_id);
  select * into v_doc from public.supplier_documents s where s.id = p_document_id for update;
  v_result := authz.sm_replay(v_doc.legal_entity_id, p_request_id, 'supplier_document_link_task', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_doc.status = 'returned' or (not v_is_accounts and v_doc.status <> 'uploaded') then
    raise exception 'link_not_allowed' using errcode = '55000', hint = 'documentId';
  end if;
  if v_task.legal_entity_id <> v_doc.legal_entity_id or v_task.id = v_doc.task_id
     or v_task.department not in ('purchase', 'flight')
     or not authz.sm_link_eligible(v_task.id, v_doc.supplier_id) then
    raise exception 'link_not_allowed' using errcode = '55000', hint = 'taskId';
  end if;

  select * into v_link from public.supplier_document_tasks l
  where l.document_id = v_doc.id and l.task_id = v_task.id and l.unlinked_at is null;
  if v_link.id is not null then
    v_result := jsonb_build_object('outcome', 'existing', 'linkId', v_link.id, 'documentId', v_doc.id,
      'taskId', v_task.id, 'dealId', v_task.deal_id);
    return authz.sm_remember(v_doc.legal_entity_id, p_request_id, 'supplier_document_link_task', v_payload, v_result);
  end if;

  insert into public.supplier_document_tasks (legal_entity_id, document_id, task_id, deal_id, branch_id, linked_by, request_id)
  values (v_doc.legal_entity_id, v_doc.id, v_task.id, v_task.deal_id, v_task.branch_id, (select auth.uid()), p_request_id)
  returning * into v_link;
  perform authz.write_audit('supplier.document_linked', v_doc.legal_entity_id, v_task.branch_id, 'supplier_document', v_doc.id,
    null, jsonb_build_object('documentId', v_doc.id, 'taskId', v_task.id, 'dealId', v_task.deal_id, 'linkId', v_link.id));
  v_result := jsonb_build_object('outcome', 'created', 'linkId', v_link.id, 'documentId', v_doc.id,
    'taskId', v_task.id, 'dealId', v_task.deal_id);
  return authz.sm_remember(v_doc.legal_entity_id, p_request_id, 'supplier_document_link_task', v_payload, v_result);
end;
$$;
-- Replaces 20261127000100_purchase_department_check.sql:106 (latest body; changed lines marked).
create or replace function authz.lock_workable_task(p_task uuid) returns public.fulfilment_tasks
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_gate text;
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task for update;
  -- Batch 6: Purchase work only on Purchase department tasks.
  -- Accounts phase 3 (20261205000760): the assignee of a removed service hears service_removed
  -- (quote, cost, booking request, ...; can_work_purchase_task is false for it).
  if v_task.closed_state is not null and v_task.department = 'purchase' and v_task.assignee_user_id = (select auth.uid())
     and authz.holds_active_role('purchase', v_task.legal_entity_id) then
    raise exception 'service_removed' using errcode = '55000';
  end if;
  if v_task.id is null or v_task.department is distinct from 'purchase' or not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_task.status = 'supplier_confirmed' then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  -- Stage 0: wait for an in-flight removal of the Deal (it holds FOR UPDATE)
  -- so the gate below reads its committed result.
  perform 1 from public.deals d where d.id = v_task.deal_id for key share;
  v_gate := authz.procurement_gate_issue(v_task.id);
  if v_gate is not null then
    raise exception '%', v_gate using errcode = '55000';
  end if;
  return v_task;
end;
$$;

commit;
