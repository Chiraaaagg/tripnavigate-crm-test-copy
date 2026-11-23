-- TripNavigate CRM - Visa and Passport desk build, track A: independent
-- review fixes (lead, 8 November 2026).
--
-- Contract: implementation/visa-build-2026-11-07/contract.md (frozen) plus
-- the lead's review decisions of 8 November 2026. Every replaced function
-- starts from its latest body (20261202000100 / 0110 / 0120, or
-- 20261119000500 for department_evidence_finish); changed lines are marked
-- "20261202000140".
--
-- What changes:
--   1. Money follows separately from completion: on a COMPLETED visa task its
--      assignee who still holds the Visa role may upload fee receipts
--      (department_evidence_begin / finish), send or fix fees (visa_fee_send)
--      and record "other" costs per passenger (department_cost_save). Nothing
--      else reopens. Home rows visaFeesReturned / visaFeesWithoutReceipt
--      count completed tasks too. visa_workspace adds canManageFees.
--   2. Re-application copies passport custody only while the old application
--      has no handover and no documents returned; Applied sets custody from
--      the posted passportTaken flag.
--   3. The revision trigger locks the Deal's not-started and in-progress
--      visa tasks and re-checks their status (claim race); Applied and the
--      row save run the sync first (a removed traveller cannot be applied).
--   4. visa_workspace.costSummary.travellers[].otherPaise ("other" costs).
--   5. A closed removed passenger who comes back loses the removed flag
--      (narrow guard exception).
--   6. visa_applications_apply locks only this task's applications.
--   7. visa_queue tasks[] carry canTake and isManagerView per task (by the
--      task's entity); the top-level keys stay.
--
-- Refusal tokens unchanged. Rollback (forward-only): a new migration
-- restoring the bodies of 20261202000100 / 0110 / 0120 / 20261119000500.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Fees after completion (finding 1, lead decision: money follows
--    separately from completion)
-- ===========================================================================

-- The task's assignee holding the Visa role, task in progress or completed:
-- may upload fee receipts, send / fix fees and record "other" costs.
create function authz.visa_can_manage_fees(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task and t.department = 'visa' and t.status in ('in_progress', 'completed')
      and t.assignee_user_id = (select auth.uid()) and authz.holds_active_role('visa', t.legal_entity_id))
$$;
revoke all on function authz.visa_can_manage_fees(uuid) from public, anon, authenticated, service_role;

-- Replaces 20261202000110: fee receipts on a completed visa task (finding 1).
create or replace function public.department_evidence_begin(
  p_task_id uuid, p_application_id uuid, p_kind text, p_file_name text, p_mime text, p_size_bytes integer, p_sha256 text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_name text := btrim(coalesce(p_file_name, ''));
  v_sha text := lower(coalesce(p_sha256, ''));
  v_max integer := coalesce((select s.evidence_max_bytes from public.booking_settings s where s.id), 4194304);
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  perform authz.refuse_removed_deal(v_task.deal_id);
  if v_task.id is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- 20261202000140: a completed visa task still takes fee receipts from its assignee.
  if v_task.status = 'supplier_confirmed'
     or (v_task.status = 'completed'
         and not (v_task.department = 'visa' and p_kind = 'fee_receipt' and authz.visa_can_manage_fees(v_task.id))) then
    raise exception 'task_closed' using errcode = '55000';
  end if;
  if not (authz.can_work_department_task(v_task.id) or authz.visa_can_manage_fees(v_task.id))
     or v_task.department = 'purchase' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_kind is null
     or (v_task.department = 'visa' and p_kind not in ('applicant_document', 'fee_receipt', 'authority_outcome', 'other'))
     -- Flight build (20261201000130): e-tickets.
     or (v_task.department = 'flight' and p_kind not in ('e_ticket', 'direct_payment_proof', 'other'))
     or (p_application_id is not null and not exists (
           select 1 from public.visa_applications a where a.id = p_application_id and a.task_id = v_task.id))
     or p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes not between 1 and least(v_max, 4194304)
     or v_sha !~ '^[0-9a-f]{64}$'
     or length(v_name) not between 1 and 120 or v_name !~ '^[A-Za-z0-9._ -]+$' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  -- Visa build (20261202000110, VL25): 200 files per visa task.
  if (select count(*) from public.department_evidence e where e.task_id = v_task.id and e.status <> 'removed')
     >= (case when v_task.department = 'visa' then 200 else 50 end) then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  v_path := v_task.legal_entity_id::text || '/' || v_task.id::text || '/' || v_id::text;
  insert into public.department_evidence (id, task_id, application_id, legal_entity_id, kind, object_path, file_name, mime,
    size_bytes, sha256, uploaded_by)
  values (v_id, v_task.id, p_application_id, v_task.legal_entity_id, p_kind, v_path, v_name, p_mime, p_size_bytes, v_sha,
    (select auth.uid()));
  perform authz.write_audit('department.evidence_started', v_task.legal_entity_id, v_task.branch_id,
    'department_evidence', v_id, null,
    jsonb_build_object('taskId', v_task.id, 'kind', p_kind, 'mime', p_mime, 'sizeBytes', p_size_bytes));
  return jsonb_build_object('evidenceId', v_id, 'objectPath', v_path);
end;
$$;

-- Replaces 20261119000500: a fee receipt begun on a completed visa task can be finished (finding 1).
create or replace function public.department_evidence_finish(p_evidence_id uuid, p_ok boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_ev public.department_evidence%rowtype;
  v_status text;
  v_missing boolean := false;
begin
  -- Lock order everywhere: task, then evidence.
  select * into v_task from public.fulfilment_tasks t
  where t.id = (select e.task_id from public.department_evidence e where e.id = p_evidence_id) for update;
  select * into v_ev from public.department_evidence e where e.id = p_evidence_id for update;
  if v_ev.id is null or v_task.id is null or v_ev.uploaded_by is distinct from (select auth.uid())
     or not (authz.can_work_department_task(v_task.id)
             -- Visa build (20261202000140): fee receipts after completion.
             or (v_ev.kind = 'fee_receipt' and authz.visa_can_manage_fees(v_task.id))) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_ok is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_status := case when p_ok then 'stored' else 'failed' end;
  if v_ev.status <> 'pending_upload' then
    if v_ev.status = v_status or (p_ok and v_ev.status = 'failed') then
      return jsonb_build_object('evidenceId', v_ev.id, 'status', v_ev.status);
    end if;
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_ok and (to_regclass('storage.objects') is null or not exists (
       select 1 from storage.objects o
       where o.bucket_id = 'department-evidence' and o.name = v_ev.object_path
         and (o.metadata ->> 'size') ~ '^[0-9]{1,18}$'
         and (o.metadata ->> 'size')::bigint = v_ev.size_bytes)) then
    v_status := 'failed';
    v_missing := true;
  end if;
  update public.department_evidence e
  set status = v_status, stored_at = case when v_status = 'stored' then now() else null end, updated_at = now()
  where e.id = v_ev.id;
  perform authz.write_audit(case when v_status = 'stored' then 'department.evidence_stored' else 'department.evidence_failed' end,
    v_task.legal_entity_id, v_task.branch_id, 'department_evidence', v_ev.id, null,
    jsonb_build_object('taskId', v_task.id, 'objectMissing', v_missing));
  return jsonb_build_object('evidenceId', v_ev.id, 'status', v_status);
end;
$$;

-- Replaces 20261202000110: works on a completed task too (finding 1).
create or replace function public.visa_fee_send(p_entry_id uuid, p_expected_row_version integer, p_fields jsonb, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entry public.department_cost_entries%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_command text := 'visa_fee_send';
  v_payload jsonb := jsonb_build_object('entryId', p_entry_id, 'expectedRowVersion', p_expected_row_version, 'fields', p_fields);
  v_result jsonb;
  v_bad text[] := '{}';
  v_amount bigint;
  v_receipt uuid;
  v_remark text;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_entry from public.department_cost_entries c where c.id = p_entry_id;
  if v_entry.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.refuse_removed_deal(v_entry.deal_id);
  -- Lock order: deal head, task, entry (as Accounts review).
  perform authz.finance_lock_deal(v_entry.deal_id);
  select * into v_task from public.fulfilment_tasks t where t.id = v_entry.task_id for update;
  select * into v_entry from public.department_cost_entries c where c.id = p_entry_id for update;
  v_result := authz.visa_replay(v_entry.legal_entity_id, p_request_id, v_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_entry.department <> 'visa' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- 20261202000140: also after the task completed (money follows separately).
  if not authz.visa_can_manage_fees(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_entry.row_version);
  if v_entry.expense_status in ('submitted', 'accepted') then
    raise exception 'cost_locked' using errcode = '55000';
  end if;
  if v_entry.paid_by <> 'company' or v_entry.expense_status is null or v_entry.expense_status not in ('draft', 'returned') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_bad := authz.b11_unknown_keys(p_fields, array['amountPaise', 'receiptEvidenceId', 'remark']);
  v_amount := v_entry.amount_paise;
  if p_fields ? 'amountPaise' then
    if jsonb_typeof(p_fields -> 'amountPaise') in ('string', 'number') and (p_fields ->> 'amountPaise') ~ '^[1-9][0-9]{0,14}$' then
      v_amount := (p_fields ->> 'amountPaise')::bigint;
    else
      v_bad := v_bad || 'amountPaise'::text;
    end if;
  end if;
  v_receipt := v_entry.receipt_evidence_id;
  if coalesce(jsonb_typeof(p_fields -> 'receiptEvidenceId'), 'null') <> 'null' then
    if jsonb_typeof(p_fields -> 'receiptEvidenceId') <> 'string'
       or (p_fields ->> 'receiptEvidenceId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not exists (select 1 from public.department_evidence e
                      where e.id = (p_fields ->> 'receiptEvidenceId')::uuid and e.task_id = v_task.id
                        and e.kind = 'fee_receipt' and e.status = 'stored') then
      v_bad := v_bad || 'receiptEvidenceId'::text;
    else
      v_receipt := (p_fields ->> 'receiptEvidenceId')::uuid;
    end if;
  end if;
  if not authz.sf_text_ok(p_fields -> 'remark', 300, false) then
    v_bad := v_bad || 'remark'::text;
  end if;
  v_remark := authz.b11_text(p_fields -> 'remark');
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  if v_receipt is null or not exists (select 1 from public.department_evidence e
                                      where e.id = v_receipt and e.task_id = v_task.id and e.kind = 'fee_receipt'
                                        and e.status = 'stored') then
    raise exception 'receipt_required' using errcode = '55000';
  end if;
  update public.department_cost_entries c
  set amount_paise = v_amount, receipt_evidence_id = v_receipt, expense_status = 'submitted',
      submitted_by = (select auth.uid()), submitted_at = now(), reviewed_by = null, reviewed_at = null, return_reason = null,
      row_version = c.row_version + 1, updated_at = now()
  where c.id = v_entry.id
  returning * into v_entry;
  perform authz.write_audit('department.cost_saved', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('taskId', v_task.id, 'department', 'visa', 'costKind', v_entry.cost_kind,
      'paidBy', v_entry.paid_by, 'rowVersion', v_entry.row_version));
  perform authz.write_audit('department.cost_submitted', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('taskId', v_task.id, 'department', 'visa', 'costKind', v_entry.cost_kind,
      'rowVersion', v_entry.row_version));
  perform authz.write_audit('visa.fee_sent', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry', v_entry.id,
    v_remark, jsonb_build_object('taskId', v_task.id, 'entryId', v_entry.id, 'applicationId', v_entry.application_id,
      'costKind', v_entry.cost_kind, 'seq', (select a.traveller_seq from public.visa_applications a where a.id = v_entry.application_id)));
  v_result := jsonb_build_object('outcome', 'updated', 'entryId', v_entry.id, 'rowVersion', v_entry.row_version,
    'expenseStatus', v_entry.expense_status, 'taskCompleted', false);
  return authz.visa_remember(v_entry.legal_entity_id, p_request_id, v_command, v_payload, v_result);
end;
$$;

-- Replaces 20261202000110: visa "other" costs on a completed task too (finding 1).
create or replace function public.department_cost_save(p_task_id uuid, p_entry_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_old public.department_cost_entries%rowtype;
  v_entry public.department_cost_entries%rowtype;
  v_bad text[];
  v_kind text;
  v_amount bigint;
  v_paid text;
  v_mode text;
  v_on date;
  v_ref text;
  v_receipt uuid;
  v_status text;
  v_app uuid;  -- Visa build
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  perform authz.refuse_removed_deal(v_task.deal_id);
  if v_task.id is null or not (authz.can_work_department_task(v_task.id)
                                -- Visa build (20261202000140): "other" costs after completion.
                                or authz.visa_can_manage_fees(v_task.id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- B1.1c: Purchase gets the read-only placeholder only (B2/B3 build its costs).
  if v_task.department = 'purchase' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'department';
  end if;
  -- Flight build (20261201000210, owner D3): the per-passenger fare breakup
  -- is the only flight cost record; manual flight entries end here.
  if v_task.department = 'flight' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'flightFares';
  end if;
  -- Visa build (20261202000110, VL18 as changed by lead decision 16): only an
  -- "other" cost of one current passenger (applicationId); fees come from Applied.
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or jsonb_typeof(p_fields -> 'applicationId') is distinct from 'string'
     or (p_fields ->> 'applicationId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or not exists (select 1 from public.visa_applications a
                    where a.id = (p_fields ->> 'applicationId')::uuid and a.task_id = v_task.id and a.superseded_at is null)
     or authz.b11_text(p_fields -> 'costKind') is distinct from 'other' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'visaFees';
  end if;
  v_app := (p_fields ->> 'applicationId')::uuid;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if p_entry_id is null then
    select * into v_old from public.department_cost_entries c where c.task_id = v_task.id and c.request_id = p_request_id;
    if v_old.id is not null then
      return jsonb_build_object('entryId', v_old.id, 'rowVersion', v_old.row_version, 'expenseStatus', v_old.expense_status);
    end if;
  else
    select * into v_old from public.department_cost_entries c where c.id = p_entry_id and c.task_id = v_task.id for update;
    if v_old.id is null then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    perform authz.require_row_version(p_expected_row_version, v_old.row_version);
    if v_old.expense_status in ('submitted', 'accepted') then
      raise exception 'cost_locked' using errcode = '55000';
    end if;
    -- Visa build: only an "other" cost of the same passenger is edited here.
    if v_old.application_id is distinct from v_app or v_old.cost_kind <> 'other' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'visaFees';
    end if;
  end if;

  v_bad := authz.b11_unknown_keys(p_fields, array['costKind', 'amountPaise', 'paidBy', 'paymentMode', 'paidOn', 'reference',
    'receiptEvidenceId', 'applicationId']);
  v_kind := authz.b11_text(p_fields -> 'costKind');
  if jsonb_typeof(p_fields -> 'amountPaise') in ('string', 'number') and (p_fields ->> 'amountPaise') ~ '^[1-9][0-9]{0,14}$' then
    v_amount := (p_fields ->> 'amountPaise')::bigint;
  else
    v_bad := v_bad || 'amountPaise'::text;
  end if;
  v_paid := authz.b11_text(p_fields -> 'paidBy');
  -- Visa build: same paid-by choices as the Applied fees.
  if v_paid is null or v_paid not in ('company', 'customer_direct') then v_bad := v_bad || 'paidBy'::text; end if;
  v_mode := authz.b11_text(p_fields -> 'paymentMode');
  v_on := authz.sf_date(p_fields -> 'paidOn');
  if v_paid is not null then
    if (v_paid = 'company' and (v_mode is null or v_mode not in ('bank_transfer', 'upi', 'card', 'cash', 'other')))
       or (v_paid = 'customer_direct' and v_mode is not null and v_mode not in ('bank_transfer', 'upi', 'card', 'cash', 'other')) then
      v_bad := v_bad || 'paymentMode'::text;
    end if;
    -- Business date in IST, as the finance commands (review E3).
    if v_on is null or v_on > authz.finance_today() then v_bad := v_bad || 'paidOn'::text; end if;
  end if;
  if not authz.sf_text_ok(p_fields -> 'reference', 120, false) then v_bad := v_bad || 'reference'::text; end if;
  v_ref := authz.b11_text(p_fields -> 'reference');
  if p_fields ? 'receiptEvidenceId' and jsonb_typeof(p_fields -> 'receiptEvidenceId') <> 'null' then
    begin
      v_receipt := (p_fields ->> 'receiptEvidenceId')::uuid;
    exception when others then
      v_bad := v_bad || 'receiptEvidenceId'::text;
    end;
    if v_receipt is not null and not exists (
         select 1 from public.department_evidence e where e.id = v_receipt and e.task_id = v_task.id
           and e.kind = 'fee_receipt' and e.status <> 'removed') then
      v_bad := v_bad || 'receiptEvidenceId'::text;
    end if;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  v_status := case when v_paid = 'company' then coalesce(case when v_old.expense_status = 'returned' then 'returned' end, 'draft') end;

  if v_old.id is null then
    insert into public.department_cost_entries (task_id, deal_id, legal_entity_id, branch_id, department, cost_kind,
      amount_paise, paid_by, payment_mode, paid_on, reference, receipt_evidence_id, expense_status, request_id, created_by,
      application_id)
    values (v_task.id, v_task.deal_id, v_task.legal_entity_id, v_task.branch_id, v_task.department, v_kind, v_amount, v_paid,
      v_mode, v_on, v_ref, v_receipt, v_status, p_request_id, (select auth.uid()), v_app)
    returning * into v_entry;
  else
    update public.department_cost_entries c
    set cost_kind = v_kind, amount_paise = v_amount, paid_by = v_paid, payment_mode = v_mode, paid_on = v_on,
        reference = v_ref, receipt_evidence_id = v_receipt, expense_status = v_status,
        submitted_by = case when v_status = 'returned' then c.submitted_by end,
        submitted_at = case when v_status = 'returned' then c.submitted_at end,
        reviewed_by = case when v_status = 'returned' then c.reviewed_by end,
        reviewed_at = case when v_status = 'returned' then c.reviewed_at end,
        return_reason = case when v_status = 'returned' then c.return_reason end,
        row_version = c.row_version + 1, updated_at = now()
    where c.id = v_old.id
    returning * into v_entry;
  end if;
  -- No amount in the audit record.
  perform authz.write_audit('department.cost_saved', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('taskId', v_task.id, 'department', v_task.department, 'costKind', v_kind,
      'paidBy', v_paid, 'rowVersion', v_entry.row_version));
  return jsonb_build_object('entryId', v_entry.id, 'rowVersion', v_entry.row_version, 'expenseStatus', v_entry.expense_status);
end;
$$;

-- ===========================================================================
-- 2. Guard: a closed removed passenger may come back (finding 5)
-- ===========================================================================

-- Replaces 20261202000100.
create or replace function authz.visa_applications_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'visa applications cannot be deleted' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.task_id is distinct from old.task_id
     or new.service_item_id is distinct from old.service_item_id or new.deal_id is distinct from old.deal_id
     or new.legal_entity_id is distinct from old.legal_entity_id or new.created_at is distinct from old.created_at
     or new.reapplication_of_id is distinct from old.reapplication_of_id then
    raise exception 'visa application identity columns are immutable' using errcode = '42501';
  end if;
  if new.traveller_seq is distinct from old.traveller_seq
     and coalesce(current_setting('authz.visa_transition', true), '') <> 'relink' then
    raise exception 'a visa application keeps its traveller' using errcode = '42501';
  end if;
  -- 20261202000140: a closed row may also lose its removed flag (back on the booking).
  if old.closed_at is not null
     and (to_jsonb(new) - array['superseded_at', 'superseded_by_id', 'row_version', 'updated_at', 'updated_by']
          - case when old.removed_at is not null and new.removed_at is null and new.removed_version_id is null
                 then array['removed_at', 'removed_version_id'] else '{}'::text[] end)
         <> (to_jsonb(old) - array['superseded_at', 'superseded_by_id', 'row_version', 'updated_at', 'updated_by']
          - case when old.removed_at is not null and new.removed_at is null and new.removed_version_id is null
                 then array['removed_at', 'removed_version_id'] else '{}'::text[] end) then
    raise exception 'a closed visa application changes only by re-application' using errcode = '42501';
  end if;
  if (old.closed_at is not null and new.closed_at is distinct from old.closed_at)
     or (old.superseded_at is not null
         and (new.superseded_at is distinct from old.superseded_at or new.superseded_by_id is distinct from old.superseded_by_id)) then
    raise exception 'closure and supersession are final' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ===========================================================================
-- 3. Sync: closed rows come back; trigger locks the Deal's open visa tasks
--    (findings 3 and 5)
-- ===========================================================================

-- Replaces 20261202000110.
create or replace function authz.visa_sync_task(p_task uuid, p_version uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_ver uuid;
  v_prev uuid;
  v_seqs integer[];
  v_facts jsonb;
  v_labels text[];
  v_passport boolean;
  v_added integer[] := '{}';
  v_removed integer[] := '{}';
  v_back integer[] := '{}';
  v_renamed integer[] := '{}';
  v_docs integer := 0;
  v_n integer;
  v_seq integer;
  v_id uuid;
  r record;
begin
  -- Lock order: task, then applications by id.
  select * into v_task from public.fulfilment_tasks t where t.id = p_task for update;
  if v_task.id is null or v_task.department <> 'visa' or v_task.status <> 'in_progress' then
    return;
  end if;
  perform 1 from public.visa_applications a where a.task_id = v_task.id order by a.id for update;
  v_ver := authz.task_current_version(v_task.id);
  v_seqs := authz.item_participant_seqs(v_task.service_item_id, v_ver);
  v_facts := authz.visa_task_facts(v_task.id);
  v_passport := v_task.service_purpose = 'passport';
  v_labels := case when v_passport then '{}'::text[] else authz.visa_sales_document_labels(v_facts) end;

  -- Removed: open current applications whose seq no longer takes part.
  for r in
    update public.visa_applications a
    set removed_at = now(), removed_version_id = v_ver, row_version = a.row_version + 1,
        updated_by = (select auth.uid()), updated_at = now()
    where a.task_id = v_task.id and a.superseded_at is null and a.removed_at is null and a.closed_at is null
      and not (a.traveller_seq = any (v_seqs))
    returning a.traveller_seq
  loop
    v_removed := v_removed || r.traveller_seq;
  end loop;
  -- The same traveller (same seq) back on the item.
  for r in
    update public.visa_applications a
    set removed_at = null, removed_version_id = null, row_version = a.row_version + 1,
        updated_by = (select auth.uid()), updated_at = now()
    -- 20261202000140: closed rows too (finding 5).
    where a.task_id = v_task.id and a.superseded_at is null and a.removed_at is not null
      and a.traveller_seq = any (v_seqs)
    returning a.traveller_seq
  loop
    v_back := v_back || r.traveller_seq;
  end loop;
  -- Added: a participant without a current application gets a new one.
  foreach v_seq in array v_seqs loop
    if not exists (select 1 from public.visa_applications a
                   where a.task_id = v_task.id and a.traveller_seq = v_seq and a.superseded_at is null) then
      insert into public.visa_applications (task_id, service_item_id, deal_id, legal_entity_id, traveller_seq, updated_by,
        traveller_name_snapshot, traveller_type_snapshot)
      select v_task.id, v_task.service_item_id, v_task.deal_id, v_task.legal_entity_id, v_seq, (select auth.uid()),
             s.full_name, s.traveller_type
      from (select 1) x
      left join public.booking_version_travellers s on s.booking_version_id = v_ver and s.seq = v_seq
      returning id into v_id;
      perform authz.visa_add_sales_documents(v_id, v_labels);
      v_added := v_added || v_seq;
    end if;
  end loop;
  -- Blank -> named: the snapshot is filled silently (not a change).
  update public.visa_applications a
  set traveller_name_snapshot = s.full_name, traveller_type_snapshot = s.traveller_type,
      updated_at = now()
  from public.booking_version_travellers s
  where a.task_id = v_task.id and a.superseded_at is null and a.closed_at is null and a.traveller_name_snapshot is null
    and s.booking_version_id = v_ver and s.seq = a.traveller_seq;
  -- New Sales documents only for passengers not applied yet; nothing removed.
  if cardinality(v_labels) > 0 then
    for r in
      select a.id from public.visa_applications a
      where a.task_id = v_task.id and a.superseded_at is null and a.removed_at is null and a.closed_at is null
        and a.state = 'docs_pending' and not (a.traveller_seq = any (v_added))
      order by a.id
    loop
      v_n := authz.visa_add_sales_documents(r.id, v_labels);
      if v_n > 0 then
        update public.visa_applications a set row_version = a.row_version + 1, updated_at = now() where a.id = r.id;
        v_docs := v_docs + v_n;
      end if;
    end loop;
  end if;

  if p_version is not null then
    select v.revises_version_id into v_prev from public.booking_versions v where v.id = p_version;
    -- Renamed in this revision (same seq, other name or type).
    select coalesce(array_agg(a.traveller_seq order by a.traveller_seq), '{}') into v_renamed
    from public.visa_applications a
    join public.booking_version_travellers n on n.booking_version_id = v_ver and n.seq = a.traveller_seq
    join public.booking_version_travellers o on o.booking_version_id = v_prev and o.seq = a.traveller_seq
    where a.task_id = v_task.id and a.superseded_at is null and a.removed_at is null
      and (n.full_name, n.traveller_type) is distinct from (o.full_name, o.traveller_type);
    if cardinality(v_added) + cardinality(v_removed) + cardinality(v_back) + cardinality(v_renamed) + v_docs > 0 then
      perform authz.write_audit('visa.booking_synced', v_task.legal_entity_id, v_task.branch_id, 'fulfilment_task', v_task.id,
        null, jsonb_build_object('versionId', p_version,
          'versionNo', (select v.version_no from public.booking_versions v where v.id = p_version),
          'addedSeqs', to_jsonb(v_added), 'removedSeqs', to_jsonb(v_removed), 'backSeqs', to_jsonb(v_back),
          'renamedSeqs', to_jsonb(v_renamed), 'documentsAdded', v_docs));
    end if;
  end if;
end;
$$;

-- Replaces 20261202000110 (trigger body).
create or replace function authz.visa_sync_after_revision() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_task uuid;
  v_ids uuid[];
begin
  -- 20261202000140 (finding 3): lock the Deal's not-started and in-progress
  -- visa tasks first (a claim running now finishes, or waits), then re-check
  -- the status of each under the lock.
  select coalesce(array_agg(t.id order by t.id), '{}') into v_ids
  from (select x.id from public.fulfilment_tasks x
        where x.deal_id = new.deal_id and x.department = 'visa' and x.status in ('not_started', 'in_progress')
        order by x.id for update) t;
  foreach v_task in array v_ids loop
    if exists (select 1 from public.fulfilment_tasks t where t.id = v_task and t.status = 'in_progress') then
      perform authz.visa_sync_task(v_task, new.id);
      perform authz.visa_task_complete_if_done(v_task);
    end if;
  end loop;
  return null;
end;
$$;

-- ===========================================================================
-- 4. Commands: sync before Applied and row save; custody from the posted
--    flag; lock only this task's rows; re-application custody (2, 3, 6)
-- ===========================================================================

-- Replaces 20261202000110.
create or replace function public.visa_application_set_row(p_application_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_app public.visa_applications%rowtype;
  v_facts jsonb;
  v_passport boolean;
  v_command text := 'visa_application_set_row';
  v_payload jsonb := jsonb_build_object('applicationId', p_application_id, 'expectedRowVersion', p_expected_row_version,
                                        'fields', p_fields);
  v_result jsonb;
  v_bad text[] := '{}';
  v_date date;
  v_time text;
  v_remark text;
  v_kind text;
  v_jreq boolean;
  v_jplace text;
  v_docs jsonb := '[]'::jsonb;
  v_doc jsonb;
  v_pass text;
  v_trav public.deal_travellers%rowtype;
  v_ident public.traveller_identities%rowtype;
  v_changed text[];
  v_not text[];
begin
  v_app := authz.visa_lock_application(p_application_id);
  v_result := authz.visa_replay(v_app.legal_entity_id, p_request_id, v_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;
  -- 20261202000140 (finding 3): follow the booking first, so a removed traveller is never edited.
  perform authz.visa_require_open(v_app, false, false);
  perform authz.visa_sync_task(v_app.task_id, null);
  select * into v_app from public.visa_applications a where a.id = p_application_id;
  perform authz.visa_require_open(v_app, false, false);
  perform authz.require_row_version(p_expected_row_version, v_app.row_version);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_facts := authz.visa_task_facts(v_app.task_id);
  v_passport := authz.visa_is_passport_task(v_app.task_id);
  v_bad := authz.b11_unknown_keys(p_fields, array['appointmentDate', 'appointmentTime', 'remark', 'documents',
    'passportNumber', 'visaKind', 'jurisdiction', 'jurisdictionPlace']);
  if v_app.state <> 'docs_pending' and (p_fields ?| array['appointmentDate', 'appointmentTime', 'documents', 'visaKind',
                                                          'jurisdiction', 'jurisdictionPlace']) then
    raise exception 'wrong_state' using errcode = '55000';
  end if;

  -- Appointment date and time.
  v_date := v_app.appointment_date;
  if p_fields ? 'appointmentDate' then
    v_date := authz.sf_date(p_fields -> 'appointmentDate');
    if jsonb_typeof(p_fields -> 'appointmentDate') <> 'null' and v_date is null then
      v_bad := v_bad || 'appointmentDate'::text;
    end if;
  end if;
  v_time := v_app.appointment_time;
  if p_fields ? 'appointmentTime' then
    v_time := authz.b11_text(p_fields -> 'appointmentTime');
    if jsonb_typeof(p_fields -> 'appointmentTime') not in ('string', 'null')
       or (v_time is not null and v_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
      v_bad := v_bad || 'appointmentTime'::text;
    end if;
  end if;
  if v_time is not null and v_date is null and not ('appointmentTime' = any (v_bad)) then
    v_bad := v_bad || 'appointmentTime'::text;
  end if;
  -- Remark.
  v_remark := v_app.remark;
  if p_fields ? 'remark' then
    if not authz.sf_text_ok(p_fields -> 'remark', 300, false) then
      v_bad := v_bad || 'remark'::text;
    end if;
    v_remark := authz.b11_text(p_fields -> 'remark');
  end if;
  -- Documents: [{documentId, received}] of this application, not removed.
  if p_fields ? 'documents' then
    if jsonb_typeof(p_fields -> 'documents') <> 'array'
       or exists (select 1 from jsonb_array_elements(p_fields -> 'documents') x
                  where jsonb_typeof(x) <> 'object'
                     or cardinality(authz.b11_unknown_keys(x, array['documentId', 'received'])) > 0
                     or jsonb_typeof(x -> 'received') is distinct from 'boolean'
                     or jsonb_typeof(x -> 'documentId') is distinct from 'string'
                     or (x ->> 'documentId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     or not exists (select 1 from public.visa_application_documents d
                                    where d.id = (x ->> 'documentId')::uuid and d.application_id = v_app.id
                                      and d.removed_at is null))
       or (select count(*) from jsonb_array_elements(p_fields -> 'documents'))
          <> (select count(distinct x ->> 'documentId') from jsonb_array_elements(p_fields -> 'documents') x) then
      v_bad := v_bad || 'documents'::text;
    else
      v_docs := p_fields -> 'documents';
    end if;
  end if;
  -- Kind: visa task only, only while Sales left it blank.
  v_kind := v_app.visa_kind;
  if p_fields ? 'visaKind' then
    v_kind := authz.b11_text(p_fields -> 'visaKind');
    if v_passport or authz.visa_sales_kind(v_facts) is not null
       or jsonb_typeof(p_fields -> 'visaKind') not in ('string', 'null')
       or (v_kind is not null and v_kind not in ('e_visa', 'sticker')) then
      v_bad := v_bad || 'visaKind'::text;
    end if;
  end if;
  -- Jurisdiction: sticker visa (effective), Sales blank.
  v_jreq := v_app.jurisdiction_required;
  v_jplace := v_app.jurisdiction_place;
  if p_fields ?| array['jurisdiction', 'jurisdictionPlace'] then
    if v_passport or authz.visa_sales_jurisdiction(v_facts) is not null
       or coalesce(authz.visa_sales_kind(v_facts), v_kind) is distinct from 'sticker' then
      v_bad := v_bad || 'jurisdiction'::text;
    else
      if p_fields ? 'jurisdiction' then
        if jsonb_typeof(p_fields -> 'jurisdiction') = 'null' then
          v_jreq := null;
        elsif jsonb_typeof(p_fields -> 'jurisdiction') = 'string' and (p_fields ->> 'jurisdiction') in ('yes', 'no') then
          v_jreq := (p_fields ->> 'jurisdiction') = 'yes';
        else
          v_bad := v_bad || 'jurisdiction'::text;
        end if;
      end if;
      if p_fields ? 'jurisdictionPlace' then
        if not authz.sf_text_ok(p_fields -> 'jurisdictionPlace', 120, false) then
          v_bad := v_bad || 'jurisdictionPlace'::text;
        end if;
        v_jplace := regexp_replace(authz.b11_text(p_fields -> 'jurisdictionPlace'), '\s+', ' ', 'g');
      elsif v_jreq is not true then
        v_jplace := null;
      end if;
      if (v_jreq is true) <> (v_jplace is not null) and not ('jurisdictionPlace' = any (v_bad)) then
        v_bad := v_bad || 'jurisdictionPlace'::text;
      end if;
    end if;
  end if;
  if coalesce(authz.visa_sales_kind(v_facts), v_kind) is distinct from 'sticker' and authz.visa_sales_jurisdiction(v_facts) is null then
    -- Jurisdiction belongs to sticker visas only.
    v_jreq := null;
    v_jplace := null;
  end if;
  -- Passport number (V2): written to the traveller identity record only.
  if p_fields ? 'passportNumber' then
    v_pass := nullif(upper(regexp_replace(coalesce(authz.b11_text(p_fields -> 'passportNumber'), ''), '[ -]', '', 'g')), '');
    select * into v_trav from public.deal_travellers t where t.deal_id = v_app.deal_id and t.seq = v_app.traveller_seq;
    if jsonb_typeof(p_fields -> 'passportNumber') not in ('string', 'null')
       or (v_pass is not null and v_pass !~ '^[A-Z0-9]{6,15}$') or v_trav.id is null then
      v_bad := v_bad || 'passportNumber'::text;
    end if;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;

  update public.visa_applications a
  set appointment_date = v_date, appointment_time = v_time, remark = v_remark, visa_kind = v_kind,
      jurisdiction_required = v_jreq, jurisdiction_place = v_jplace,
      row_version = a.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
  where a.id = v_app.id
  returning * into v_app;
  for v_doc in select x from jsonb_array_elements(v_docs) x loop
    update public.visa_application_documents d
    set status = case when (v_doc ->> 'received')::boolean then 'received' else 'not_received' end,
        received_at = case when (v_doc ->> 'received')::boolean then coalesce(d.received_at, now()) end,
        received_by = case when (v_doc ->> 'received')::boolean then coalesce(d.received_by, (select auth.uid())) end,
        updated_at = now()
    where d.id = (v_doc ->> 'documentId')::uuid
      and d.status is distinct from case when (v_doc ->> 'received')::boolean then 'received' else 'not_received' end;
  end loop;
  if p_fields ? 'passportNumber' then
    select * into v_ident from public.traveller_identities x where x.traveller_id = v_trav.id;
    if v_ident.passport_number is distinct from v_pass then
      -- Same rules and audit row as the booking form (traveller_identity_save).
      perform public.traveller_identity_save(v_app.deal_id, v_app.traveller_seq, coalesce(v_ident.row_version, 0),
        jsonb_strip_nulls(jsonb_build_object(
          'dateOfBirth', to_char(v_ident.date_of_birth, 'YYYY-MM-DD'), 'nationality', v_ident.nationality,
          'passportExpiry', to_char(v_ident.passport_expiry, 'YYYY-MM-DD')))
        || jsonb_build_object('passportNumber', v_pass));
    end if;
  end if;

  v_changed := array(select k from jsonb_object_keys(p_fields) k order by k);
  perform authz.visa_audit('visa.application_row_saved', v_app.id, null, jsonb_build_object(
    'changedFields', to_jsonb(v_changed),
    'documentsReceived', (select count(*) from public.visa_application_documents d
                          where d.application_id = v_app.id and d.removed_at is null and d.status = 'received'),
    'documentsTotal', (select count(*) from public.visa_application_documents d
                       where d.application_id = v_app.id and d.removed_at is null),
    'rowVersion', v_app.row_version));
  v_not := authz.visa_not_ready(v_app, v_facts);
  v_result := jsonb_build_object('outcome', 'updated', 'applicationId', v_app.id, 'rowVersion', v_app.row_version,
    'state', v_app.state, 'ready', cardinality(v_not) = 0, 'notReady', to_jsonb(v_not), 'closed', false,
    'taskCompleted', false);
  return authz.visa_remember(v_app.legal_entity_id, p_request_id, v_command, v_payload, v_result);
end;
$$;

-- Replaces 20261202000110.
create or replace function public.visa_applications_apply(p_task_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_command text := 'visa_applications_apply';
  v_payload jsonb := jsonb_build_object('taskId', p_task_id, 'fields', p_fields);
  v_result jsonb;
  v_facts jsonb;
  v_passport boolean;
  v_list jsonb;
  v_n integer;
  v_i integer;
  v_x jsonb;
  v_ids uuid[] := '{}';
  v_app public.visa_applications%rowtype;
  v_bad text[] := '{}';
  v_not text[];
  v_kind_post text;
  v_kind_needed boolean := false;
  v_jpost boolean := false;
  v_jreq boolean;
  v_jplace text;
  v_taken boolean := false;
  v_paid text;
  v_mode text;
  v_receipt uuid;
  v_remark text;
  v_club uuid;
  v_today date := authz.finance_today();
  v_ref text;
  v_on date;
  v_gov bigint;
  v_svc bigint;
  v_kind text;
  v_entry uuid;
  v_entries uuid[];
  v_all_entries uuid[] := '{}';
  v_apps jsonb := '[]'::jsonb;
  v_status text;
  v_k text;
  v_amount bigint;
  v_done boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or v_task.department <> 'visa' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.refuse_removed_deal(v_task.deal_id);
  -- Lock order: deal head (fees, as Accounts review), task, applications by id.
  perform authz.finance_lock_deal(v_task.deal_id);
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  v_result := authz.visa_replay(v_task.legal_entity_id, p_request_id, v_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.visa_require_work(v_task.id);
  -- 20261202000140 (finding 3): follow the booking first, so a removed traveller is never applied.
  perform authz.visa_sync_task(v_task.id, null);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_facts := authz.visa_task_facts(v_task.id);
  v_passport := v_task.service_purpose = 'passport';
  v_bad := authz.b11_unknown_keys(p_fields, array['applicants', 'visaKind', 'jurisdiction', 'jurisdictionPlace',
    'passportTaken', 'paidBy', 'paymentMode', 'receiptEvidenceId', 'remark']);
  v_list := p_fields -> 'applicants';
  if jsonb_typeof(v_list) is distinct from 'array' or jsonb_array_length(v_list) not between 1 and 100
     or exists (select 1 from jsonb_array_elements(v_list) x
                where jsonb_typeof(x) <> 'object' or jsonb_typeof(x -> 'applicationId') is distinct from 'string'
                   or (x ->> 'applicationId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   or jsonb_typeof(x -> 'expectedRowVersion') is distinct from 'number')
     or (select count(distinct x ->> 'applicationId') from jsonb_array_elements(v_list) x) <> jsonb_array_length(v_list) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'applicants';
  end if;
  v_n := jsonb_array_length(v_list);
  v_ids := array(select (x ->> 'applicationId')::uuid from jsonb_array_elements(v_list) x);
  -- 20261202000140 (finding 6): this task's rows only.
  perform 1 from public.visa_applications a where a.id = any (v_ids) and a.task_id = v_task.id order by a.id for update;

  -- Per-applicant state checks (in posted order).
  for v_i in 0 .. v_n - 1 loop
    v_x := v_list -> v_i;
    select * into v_app from public.visa_applications a
    where a.id = (v_x ->> 'applicationId')::uuid and a.task_id = v_task.id;
    if v_app.id is null then
      raise exception 'invalid_input' using errcode = '22023', hint = format('applicants[%s].applicationId', v_i);
    end if;
    perform authz.require_row_version((v_x ->> 'expectedRowVersion')::integer, v_app.row_version);
    if v_app.superseded_at is not null or v_app.closed_at is not null then
      raise exception 'application_closed' using errcode = '55000';
    end if;
    if v_app.removed_at is not null then
      raise exception 'applicant_removed' using errcode = '55000';
    end if;
    if v_app.state <> 'docs_pending' then
      raise exception 'wrong_state' using errcode = '55000';
    end if;
    if authz.visa_traveller_changed(v_app) then
      raise exception 'traveller_changed' using errcode = '55000';
    end if;
    v_not := authz.visa_not_ready(v_app, v_facts);
    if cardinality(v_not) > 0 then
      raise exception 'not_ready' using errcode = '55000', hint = format('applicants[%s]:%s', v_i, v_not[1]);
    end if;
    if not v_passport and authz.visa_effective_kind(v_app, v_facts) is null then
      v_kind_needed := true;
    end if;
  end loop;

  -- Shared fields.
  if p_fields ? 'visaKind' then
    v_kind_post := authz.b11_text(p_fields -> 'visaKind');
    if jsonb_typeof(p_fields -> 'visaKind') not in ('string', 'null') or (v_passport and v_kind_post is not null)
       or (v_kind_post is not null and v_kind_post not in ('e_visa', 'sticker')) then
      v_bad := v_bad || 'visaKind'::text;
    end if;
  end if;
  if v_kind_needed and v_kind_post is null and not ('visaKind' = any (v_bad)) then
    v_bad := v_bad || 'visaKind'::text;
  end if;
  if p_fields ?| array['jurisdiction', 'jurisdictionPlace'] then
    v_jpost := true;
    if v_passport or authz.visa_sales_jurisdiction(v_facts) is not null then
      v_bad := v_bad || 'jurisdiction'::text;
    else
      if jsonb_typeof(p_fields -> 'jurisdiction') = 'string' and (p_fields ->> 'jurisdiction') in ('yes', 'no') then
        v_jreq := (p_fields ->> 'jurisdiction') = 'yes';
      elsif coalesce(jsonb_typeof(p_fields -> 'jurisdiction'), 'null') <> 'null' then
        v_bad := v_bad || 'jurisdiction'::text;
      end if;
      if not authz.sf_text_ok(p_fields -> 'jurisdictionPlace', 120, false) then
        v_bad := v_bad || 'jurisdictionPlace'::text;
      end if;
      v_jplace := regexp_replace(authz.b11_text(p_fields -> 'jurisdictionPlace'), '\s+', ' ', 'g');
      if (v_jreq is true) <> (v_jplace is not null) and not ('jurisdictionPlace' = any (v_bad)) then
        v_bad := v_bad || 'jurisdictionPlace'::text;
      end if;
    end if;
  end if;
  if p_fields ? 'passportTaken' then
    if jsonb_typeof(p_fields -> 'passportTaken') not in ('boolean', 'null') then
      v_bad := v_bad || 'passportTaken'::text;
    else
      v_taken := coalesce((p_fields ->> 'passportTaken')::boolean, false);
    end if;
  end if;
  if v_taken and (v_passport or exists (
       select 1 from public.visa_applications a where a.id = any (v_ids)
         and coalesce(authz.visa_effective_kind(a, v_facts), v_kind_post) is distinct from 'sticker')) then
    v_bad := v_bad || 'passportTaken'::text;
  end if;
  v_paid := authz.b11_text(p_fields -> 'paidBy');
  if v_paid is null or v_paid not in ('company', 'customer_direct') then
    v_bad := v_bad || 'paidBy'::text;
  end if;
  v_mode := authz.b11_text(p_fields -> 'paymentMode');
  if (v_paid = 'company' and (v_mode is null or v_mode not in ('bank_transfer', 'upi', 'card', 'cash', 'other')))
     or (v_paid is distinct from 'company' and v_mode is not null and v_mode not in ('bank_transfer', 'upi', 'card', 'cash', 'other'))
     or (p_fields ? 'paymentMode' and jsonb_typeof(p_fields -> 'paymentMode') not in ('string', 'null')) then
    v_bad := v_bad || 'paymentMode'::text;
  end if;
  if p_fields ? 'receiptEvidenceId' and jsonb_typeof(p_fields -> 'receiptEvidenceId') <> 'null' then
    if jsonb_typeof(p_fields -> 'receiptEvidenceId') <> 'string'
       or (p_fields ->> 'receiptEvidenceId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_bad := v_bad || 'receiptEvidenceId'::text;
    else
      v_receipt := (p_fields ->> 'receiptEvidenceId')::uuid;
      if not exists (select 1 from public.department_evidence e
                     where e.id = v_receipt and e.task_id = v_task.id and e.kind = 'fee_receipt' and e.status = 'stored'
                       and (e.application_id is null or e.application_id = any (v_ids))) then
        v_bad := v_bad || 'receiptEvidenceId'::text;
      end if;
    end if;
  end if;
  if not authz.sf_text_ok(p_fields -> 'remark', 300, false) then
    v_bad := v_bad || 'remark'::text;
  end if;
  v_remark := authz.b11_text(p_fields -> 'remark');
  -- Per-applicant fields.
  for v_i in 0 .. v_n - 1 loop
    v_x := v_list -> v_i;
    v_bad := v_bad || array(select format('applicants[%s].%s', v_i, k)
                            from unnest(authz.b11_unknown_keys(v_x, array['applicationId', 'expectedRowVersion', 'reference',
                              'appliedOn', 'governmentFeePaise', 'serviceFeePaise'])) k);
    if not authz.sf_text_ok(v_x -> 'reference', 120, true) then
      v_bad := v_bad || format('applicants[%s].reference', v_i);
    end if;
    if authz.sf_date(v_x -> 'appliedOn') is null then
      v_bad := v_bad || format('applicants[%s].appliedOn', v_i);
    end if;
    if not (jsonb_typeof(v_x -> 'governmentFeePaise') in ('string', 'number')
            and (v_x ->> 'governmentFeePaise') ~ '^[1-9][0-9]{0,14}$') then
      v_bad := v_bad || format('applicants[%s].governmentFeePaise', v_i);
    end if;
    if coalesce(jsonb_typeof(v_x -> 'serviceFeePaise'), 'null') <> 'null'
       and not (jsonb_typeof(v_x -> 'serviceFeePaise') in ('string', 'number')
                and (v_x ->> 'serviceFeePaise') ~ '^[1-9][0-9]{0,14}$') then
      v_bad := v_bad || format('applicants[%s].serviceFeePaise', v_i);
    end if;
  end loop;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  -- V11: applied date never after today (IST).
  if exists (select 1 from jsonb_array_elements(v_list) x where authz.sf_date(x -> 'appliedOn') > v_today) then
    raise exception 'applied_date_in_future' using errcode = '22023';
  end if;
  -- QB10: references unique per task ignoring case (superseded rows included).
  for v_i in 0 .. v_n - 1 loop
    v_ref := authz.b11_text(v_list -> v_i -> 'reference');
    if exists (select 1 from generate_series(0, v_i - 1) j
               where lower(authz.b11_text(v_list -> j -> 'reference')) = lower(v_ref))
       or exists (select 1 from public.visa_applications a
                  where a.task_id = v_task.id and a.reference is not null and lower(a.reference) = lower(v_ref)
                    and a.id <> (v_list -> v_i ->> 'applicationId')::uuid) then
      raise exception 'duplicate_reference' using errcode = '23505', hint = format('applicants[%s].reference', v_i);
    end if;
  end loop;

  v_club := case when v_n > 1 then gen_random_uuid() end;
  v_status := case when v_paid = 'company' then case when v_receipt is not null then 'submitted' else 'draft' end end;
  for v_i in 0 .. v_n - 1 loop
    v_x := v_list -> v_i;
    select * into v_app from public.visa_applications a where a.id = (v_x ->> 'applicationId')::uuid;
    v_ref := authz.b11_text(v_x -> 'reference');
    v_on := authz.sf_date(v_x -> 'appliedOn');
    v_gov := (v_x ->> 'governmentFeePaise')::bigint;
    v_svc := case when coalesce(jsonb_typeof(v_x -> 'serviceFeePaise'), 'null') <> 'null' then (v_x ->> 'serviceFeePaise')::bigint end;
    v_kind := case when v_passport then null else coalesce(authz.visa_effective_kind(v_app, v_facts), v_kind_post) end;
    update public.visa_applications a
    set state = 'decision_pending', reference = v_ref, applied_on = v_on, submitted_at = now(), visa_kind = v_kind,
        jurisdiction_required = case when v_kind = 'sticker' then
            case when authz.visa_sales_jurisdiction(v_facts) is not null
                 then authz.visa_sales_jurisdiction(v_facts) = 'yes'
                 when v_jpost then v_jreq else a.jurisdiction_required end end,
        jurisdiction_place = case when v_kind = 'sticker' then
            case when authz.visa_sales_jurisdiction(v_facts) is not null
                 then (authz.visa_jurisdiction_json(a, v_facts) ->> 'place')
                 when v_jpost then v_jplace else a.jurisdiction_place end end,
        -- 20261202000140 (finding 2): custody as posted at Applied.
        passport_taken_at = case when v_taken then coalesce(a.passport_taken_at, now()) end,
        passport_taken_by = case when v_taken then coalesce(a.passport_taken_by, v_uid) end,
        applied_remark = v_remark, club_id = v_club, club_size = case when v_club is not null then v_n end,
        row_version = a.row_version + 1, updated_by = v_uid, updated_at = now()
    where a.id = v_app.id
    returning * into v_app;
    v_entries := '{}';
    foreach v_k in array array['government_fee', 'service_fee'] loop
      v_amount := case when v_k = 'government_fee' then v_gov else v_svc end;
      continue when v_amount is null;
      insert into public.department_cost_entries (task_id, deal_id, legal_entity_id, branch_id, department, cost_kind,
        amount_paise, paid_by, payment_mode, paid_on, reference, receipt_evidence_id, expense_status, submitted_by,
        submitted_at, request_id, created_by, application_id)
      values (v_task.id, v_task.deal_id, v_task.legal_entity_id, v_task.branch_id, 'visa', v_k, v_amount, v_paid,
        v_mode, v_on, v_ref, v_receipt, v_status,
        case when v_status = 'submitted' then v_uid end, case when v_status = 'submitted' then now() end,
        md5(p_request_id::text || v_app.id::text || v_k)::uuid, v_uid, v_app.id)
      returning id into v_entry;
      v_entries := v_entries || v_entry;
      perform authz.write_audit('department.cost_saved', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry',
        v_entry, null, jsonb_build_object('taskId', v_task.id, 'department', 'visa', 'costKind', v_k,
          'paidBy', v_paid, 'rowVersion', 1));
      if v_status = 'submitted' then
        perform authz.write_audit('department.cost_submitted', v_task.legal_entity_id, v_task.branch_id,
          'department_cost_entry', v_entry, null, jsonb_build_object('taskId', v_task.id, 'department', 'visa',
            'costKind', v_k, 'rowVersion', 1));
      end if;
    end loop;
    v_all_entries := v_all_entries || v_entries;
    perform authz.visa_audit('visa.application_applied', v_app.id, null, jsonb_build_object('clubId', v_club,
      'clubSize', case when v_club is not null then v_n end, 'visaKind', v_kind, 'passportTaken', v_taken,
      'paidBy', v_paid, 'entryIds', to_jsonb(v_entries), 'rowVersion', v_app.row_version));
    v_apps := v_apps || jsonb_build_object('applicationId', v_app.id, 'rowVersion', v_app.row_version, 'state', v_app.state);
  end loop;
  v_done := authz.visa_task_complete_if_done(v_task.id);
  v_result := jsonb_build_object('outcome', 'updated', 'clubId', v_club, 'applications', v_apps,
    'entryIds', to_jsonb(v_all_entries), 'taskCompleted', v_done);
  return authz.visa_remember(v_task.legal_entity_id, p_request_id, v_command, v_payload, v_result);
end;
$$;

-- Replaces 20261202000110.
create or replace function public.visa_application_reapply(p_application_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_app public.visa_applications%rowtype;
  v_command text := 'visa_application_reapply';
  v_payload jsonb := jsonb_build_object('applicationId', p_application_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_facts jsonb;
  v_new uuid := gen_random_uuid();
  v_was_closed boolean;
  v_cur public.booking_version_travellers%rowtype;
begin
  v_app := authz.visa_lock_application(p_application_id);
  v_result := authz.visa_replay(v_app.legal_entity_id, p_request_id, v_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.visa_require_open(v_app, false, true);
  perform authz.require_row_version(p_expected_row_version, v_app.row_version);
  if v_app.state <> 'refused' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  v_facts := authz.visa_task_facts(v_app.task_id);
  v_was_closed := v_app.closed_at is not null;
  if not v_was_closed then
    perform authz.visa_close(v_app.id, 'reapplied');
  end if;
  update public.visa_applications a
  set superseded_at = now(), superseded_by_id = v_new, row_version = a.row_version + 1,
      updated_by = (select auth.uid()), updated_at = now()
  where a.id = v_app.id;
  v_cur := authz.visa_current_traveller(v_app);
  insert into public.visa_applications (id, task_id, service_item_id, deal_id, legal_entity_id, traveller_seq, updated_by,
    traveller_name_snapshot, traveller_type_snapshot, reapplication_of_id, visa_kind, jurisdiction_required,
    jurisdiction_place, passport_taken_at, passport_taken_by)
  values (v_new, v_app.task_id, v_app.service_item_id, v_app.deal_id, v_app.legal_entity_id, v_app.traveller_seq,
    (select auth.uid()), v_cur.full_name, v_cur.traveller_type, v_app.id,
    case when authz.visa_sales_kind(v_facts) is null then v_app.visa_kind end,
    case when authz.visa_sales_jurisdiction(v_facts) is null then v_app.jurisdiction_required end,
    case when authz.visa_sales_jurisdiction(v_facts) is null then v_app.jurisdiction_place end,
    -- 20261202000140 (finding 2): custody carries over only while the passport is still with us.
    case when v_app.handover_method is null and v_app.documents_returned_at is null then v_app.passport_taken_at end,
    case when v_app.handover_method is null and v_app.documents_returned_at is null then v_app.passport_taken_by end);
  insert into public.visa_application_documents (legal_entity_id, task_id, application_id, catalogue_code, label, source,
    status, received_at, received_by, remark, added_by)
  select d.legal_entity_id, d.task_id, v_new, d.catalogue_code, d.label, 'copied', d.status, d.received_at, d.received_by,
         d.remark, (select auth.uid())
  from public.visa_application_documents d
  where d.application_id = v_app.id and d.removed_at is null
  order by d.created_at, d.id;
  perform authz.visa_audit('visa.application_reapplied', v_app.id, null, jsonb_build_object('newApplicationId', v_new));
  v_result := jsonb_build_object('outcome', 'created', 'applicationId', v_new, 'rowVersion', 1,
    'previousApplicationId', v_app.id, 'state', 'docs_pending', 'closed', false, 'taskCompleted', false);
  return authz.visa_remember(v_app.legal_entity_id, p_request_id, v_command, v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 5. Reads: queue per entity, workspace fee keys, Home fee rows (1, 4, 7)
-- ===========================================================================

-- Replaces 20261202000120.
create or replace function public.visa_queue() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_visa boolean;
  v_manager boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select coalesce(bool_or(m.role_code = 'visa'), false), coalesce(bool_or(m.role_code = 'manager'), false)
  into v_visa, v_manager
  from public.memberships m
  join public.legal_entities e on e.id = m.legal_entity_id and e.status = 'enabled'
  join public.branches b on b.id = m.branch_id and b.status = 'enabled'
  where m.user_id = v_uid and m.status = 'active';
  -- Readers: the Visa desk and branch Managers only.
  if not (v_visa or v_manager) then
    return null;
  end if;
  return jsonb_build_object(
    'isManagerView', not v_visa,
    'canTake', v_visa,
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
          'taskId', t.id, 'serviceType', t.service_purpose, 'dealReference', d.reference, 'branchName', b.name,
          'title', authz.visa_task_title(t.id),
          'factsLine', authz.visa_facts_line(t.service_purpose, authz.visa_task_facts(t.id)),
          'travelDate', to_char(authz.sf_date(case when t.service_purpose = 'passport' then authz.visa_task_facts(t.id) -> 'neededBy'
                                                    else authz.visa_task_facts(t.id) -> 'travelDate' end), 'YYYY-MM-DD'),
          'status', p.j -> 'status',
          'applicantCount', case when t.status = 'not_started'
                                 then cardinality(authz.item_participant_seqs(t.service_item_id, authz.task_current_version(t.id)))
                                 else (p.j ->> 'applicantCount')::integer end,
          'readyCount', (p.j ->> 'readyCount')::integer, 'appliedCount', (p.j ->> 'appliedCount')::integer,
          'decidedCount', (p.j ->> 'decidedCount')::integer, 'closedCount', (p.j ->> 'closedCount')::integer,
          'assigneeName', ap.display_name,
          'assignedToYou', t.assignee_user_id is not distinct from v_uid and t.assignee_user_id is not null,
          -- 20261202000140 (finding 7): per task, by the task's entity.
          'canTake', t.status = 'not_started' and t.assignee_user_id is null and authz.holds_active_role('visa', t.legal_entity_id),
          'isManagerView', not authz.holds_active_role('visa', t.legal_entity_id),
          'createdAt', t.created_at)
        order by t.created_at desc, t.id)
      from public.fulfilment_tasks t
      join public.deals d on d.id = t.deal_id
      join public.branches b on b.id = t.branch_id
      left join public.staff_profiles ap on ap.user_id = t.assignee_user_id
      cross join lateral (select authz.visa_task_progress(t.id) as j) p
      where t.department = 'visa' and authz.can_read_visa_task(t.id)), '[]'::jsonb));
end;
$$;

-- Replaces 20261202000120.
create or replace function public.visa_workspace(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_ver public.booking_versions%rowtype;
  v_facts jsonb;
  v_va boolean;
  v_visa boolean;
  v_progress jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_task_id is null or not authz.can_read_visa_task(p_task_id) then
    return null;
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  select * into v_ver from public.booking_versions v where v.id = authz.task_current_version(v_task.id);
  v_facts := authz.visa_task_facts(v_task.id);
  v_va := authz.can_work_department_task(v_task.id);
  v_visa := authz.holds_active_role('visa', v_task.legal_entity_id);
  v_progress := authz.visa_task_progress(v_task.id);
  return jsonb_build_object(
    'taskId', v_task.id, 'serviceType', v_task.service_purpose, 'dealId', v_task.deal_id,
    'dealReference', (select d.reference from public.deals d where d.id = v_task.deal_id),
    'branchName', (select b.name from public.branches b where b.id = v_task.branch_id),
    'title', authz.visa_task_title(v_task.id),
    'status', v_progress -> 'status',
    'assignee', jsonb_build_object(
      'name', (select s.display_name from public.staff_profiles s where s.user_id = v_task.assignee_user_id),
      'isYou', v_task.assignee_user_id is not distinct from v_uid and v_task.assignee_user_id is not null,
      'takenAt', case when v_task.assignee_user_id is not null then (
          select a.occurred_at from public.audit_events a
          where a.target_type = 'fulfilment_task' and a.target_id = v_task.id
            and a.action in ('fulfilment.task_claimed', 'fulfilment.task_reassigned')
          order by a.occurred_at desc, a.id desc limit 1) end),
    'canClaim', v_visa and v_task.status = 'not_started' and v_task.assignee_user_id is null,
    'canWork', v_va,
    'isManagerView', not v_visa,
    'versionNo', v_ver.version_no, 'confirmedAt', v_ver.confirmed_at,
    'facts', case when v_task.service_purpose = 'passport' then jsonb_build_object('passport', jsonb_build_object(
        'applicationType', v_facts ->> 'applicationType', 'officeCity', v_facts ->> 'officeCity',
        'neededBy', v_facts ->> 'neededBy', 'notes', v_facts ->> 'notes'))
      else jsonb_build_object('visa', jsonb_build_object(
        'country', v_facts ->> 'country', 'purpose', v_facts ->> 'purpose', 'travelDate', v_facts ->> 'travelDate',
        'applyBy', v_facts ->> 'applyBy', 'feePaidBy', v_facts ->> 'feePaidBy', 'notes', v_facts ->> 'notes',
        'visaKind', authz.visa_sales_kind(v_facts), 'jurisdiction', authz.visa_sales_jurisdiction(v_facts),
        'jurisdictionPlace', case when authz.visa_sales_jurisdiction(v_facts) = 'yes' then v_facts ->> 'jurisdictionPlace' end,
        'documentsNeeded', to_jsonb(authz.visa_sales_document_labels(v_facts)))) end,
    'steps', v_progress -> 'steps',
    'bookingChange', authz.visa_booking_change_json(v_task.id),
    'addedAfterCompletion', authz.visa_added_after_completion(v_task.id),
    'applicants', (select coalesce(jsonb_agg(authz.visa_applicant_json(a.id, v_va, v_facts)
                                             order by (a.removed_at is not null), a.traveller_seq, a.created_at), '[]'::jsonb)
                   from public.visa_applications a where a.task_id = v_task.id and a.superseded_at is null),
    'previousApplications', (select coalesce(jsonb_agg(jsonb_build_object(
        'applicationId', a.id, 'seq', a.traveller_seq, 'reference', a.reference, 'state', a.state,
        'closed', a.closed_at is not null,
        'decision', case a.state when 'issued' then 'approved' when 'refused' then 'rejected' when 'withdrawn' then 'withdrawn' end)
        order by a.traveller_seq, a.created_at), '[]'::jsonb)
      from public.visa_applications a where a.task_id = v_task.id and a.superseded_at is not null),
    'readyCount', (v_progress ->> 'readyCount')::integer, 'appliedCount', (v_progress ->> 'appliedCount')::integer,
    'costSummary', jsonb_build_object(
      'travellers', (select coalesce(jsonb_agg(jsonb_build_object(
          'seq', a.traveller_seq, 'name', authz.visa_app_name(a),
          'governmentFeePaise', (g.e).amount_paise::text, 'serviceFeePaise', (sv.e).amount_paise::text,
          -- 20261202000140 (finding 4): "other" costs of the passenger, summed as recorded.
          'otherPaise', (select sum(o.amount_paise)::text from public.department_cost_entries o
                         where o.application_id = a.id and o.cost_kind = 'other'),
          'paidBy', coalesce((g.e).paid_by, (sv.e).paid_by), 'expenseStatus', coalesce((g.e).expense_status, (sv.e).expense_status),
          'state', a.state) order by a.traveller_seq), '[]'::jsonb)
        from public.visa_applications a
        left join lateral (select c as e from public.department_cost_entries c
                           where c.application_id = a.id and c.cost_kind = 'government_fee'
                           order by c.created_at desc, c.id desc limit 1) g on true
        left join lateral (select c as e from public.department_cost_entries c
                           where c.application_id = a.id and c.cost_kind = 'service_fee'
                           order by c.created_at desc, c.id desc limit 1) sv on true
        where a.task_id = v_task.id and a.superseded_at is null),
      'taskLevel', (select coalesce(jsonb_agg(jsonb_build_object('entryId', c.id, 'costKind', c.cost_kind,
          'amountPaise', c.amount_paise::text, 'paidBy', c.paid_by, 'expenseStatus', c.expense_status)
          order by c.created_at, c.id), '[]'::jsonb)
        from public.department_cost_entries c where c.task_id = v_task.id and c.application_id is null),
      'companyTotalPaise', (select coalesce(sum(c.amount_paise), 0)::text from public.department_cost_entries c
                            where c.task_id = v_task.id and c.paid_by = 'company'),
      'customerDirectTotalPaise', (select coalesce(sum(c.amount_paise), 0)::text from public.department_cost_entries c
                                   where c.task_id = v_task.id and c.paid_by = 'customer_direct')),
    'returnedFees', (select coalesce(jsonb_agg(jsonb_build_object(
        'entryId', c.id, 'applicantName', (select authz.visa_app_name(a) from public.visa_applications a where a.id = c.application_id),
        'costKind', c.cost_kind, 'amountPaise', c.amount_paise::text, 'returnReason', c.return_reason, 'rowVersion', c.row_version)
        order by c.reviewed_at, c.id), '[]'::jsonb)
      from public.department_cost_entries c where c.task_id = v_task.id and c.expense_status = 'returned'),
    'catalogue', case when v_va then (select jsonb_agg(jsonb_build_object('code', c.code, 'label', c.label) order by c.ord)
                                      from authz.visa_document_catalogue() c) else '[]'::jsonb end,
    'files', (select coalesce(jsonb_agg(jsonb_build_object(
        'evidenceId', e.id, 'kind', e.kind, 'applicationId', e.application_id, 'fileName', e.file_name, 'mime', e.mime,
        'sizeBytes', e.size_bytes, 'status', e.status, 'uploadedByYou', e.uploaded_by = v_uid,
        'uploadedByName', authz.visa_staff_name(v_task.id, e.uploaded_by), 'createdAt', e.created_at, 'storedAt', e.stored_at,
        'visaDocumentId', e.visa_document_id,
        'applicantSeq', (select a.traveller_seq from public.visa_applications a where a.id = e.application_id))
        order by e.created_at, e.id), '[]'::jsonb)
      from public.department_evidence e where e.task_id = v_task.id and e.status <> 'removed'),
    'canUpload', v_va,
    -- 20261202000140 (finding 1): fee receipts, Send / Fix fee and "other" costs, also after completion.
    'canManageFees', authz.visa_can_manage_fees(v_task.id));
end;
$$;

-- Replaces 20261202000120.
create or replace function public.visa_home_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_visa boolean;
  v_sales boolean;
  v_mine uuid[];
  v_waiting uuid[];
  v_handover uuid[];
  v_returned uuid[];
  v_noreceipt uuid[];
  v_changed uuid[];
  v_notice_deals uuid[];
  v_fee_tasks uuid[];
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- SO* rows only for Sales / Manager people without a department role (who read Deals with the full scope).
  select coalesce(bool_or(m.role_code = 'visa'), false),
         coalesce(bool_or(m.role_code in ('sales', 'manager')), false)
           and not coalesce(bool_or(m.role_code in ('purchase', 'flight', 'visa')), false)
  into v_visa, v_sales
  from public.memberships m
  join public.legal_entities e on e.id = m.legal_entity_id and e.status = 'enabled'
  join public.branches b on b.id = m.branch_id and b.status = 'enabled'
  where m.user_id = v_uid and m.status = 'active';
  if v_visa then
    select coalesce(array_agg(t.id order by t.created_at, t.id), '{}') into v_mine
    from public.fulfilment_tasks t join public.deals d on d.id = t.deal_id
    where t.department = 'visa' and t.status = 'in_progress' and t.assignee_user_id = v_uid and d.removed_at is null
      and authz.holds_active_role('visa', t.legal_entity_id);
    -- 20261202000140 (finding 1): fee rows also count my completed tasks.
    select coalesce(array_agg(t.id order by t.created_at, t.id), '{}') into v_fee_tasks
    from public.fulfilment_tasks t join public.deals d on d.id = t.deal_id
    where t.department = 'visa' and t.status in ('in_progress', 'completed') and t.assignee_user_id = v_uid
      and d.removed_at is null and authz.holds_active_role('visa', t.legal_entity_id);
    -- One task id per matching row, in task order (first = link target).
    select coalesce(array_agg(a.task_id order by array_position(v_mine, a.task_id), a.id), '{}') into v_waiting
    from public.visa_applications a
    where a.task_id = any (v_mine) and a.superseded_at is null and a.closed_at is null and a.state in ('submitted', 'decision_pending');
    select coalesce(array_agg(a.task_id order by array_position(v_mine, a.task_id), a.id), '{}') into v_handover
    from public.visa_applications a
    where a.task_id = any (v_mine) and a.superseded_at is null and a.closed_at is null and a.state in ('issued', 'refused');
    select coalesce(array_agg(c.task_id order by array_position(v_fee_tasks, c.task_id), c.id), '{}') into v_returned
    from public.department_cost_entries c where c.task_id = any (v_fee_tasks) and c.expense_status = 'returned';
    select coalesce(array_agg(c.task_id order by array_position(v_fee_tasks, c.task_id), c.id), '{}') into v_noreceipt
    from public.department_cost_entries c
    where c.task_id = any (v_fee_tasks) and c.paid_by = 'company' and c.expense_status = 'draft' and not authz.expense_receipt_ok(c.id);
    select coalesce(array_agg(a.task_id order by array_position(v_mine, a.task_id), a.id), '{}') into v_changed
    from public.visa_applications a where a.task_id = any (v_mine) and authz.visa_traveller_changed(a);
  end if;
  if v_sales then
    select coalesce(array_agg(n.deal_id order by n.created_at desc, n.id), '{}') into v_notice_deals
    from public.visa_result_notices n join public.deals d on d.id = n.deal_id
    where n.seen_at is null and d.removed_at is null and authz.visa_notice_reader(n.deal_id);
  end if;
  return jsonb_build_object(
    'visaApplicantsWaitingResult', case when v_visa then cardinality(v_waiting) end,
    'visaApplicantsWaitingResultTaskId', case when v_visa then v_waiting[1] end,
    'visaHandoverPending', case when v_visa then cardinality(v_handover) end,
    'visaHandoverPendingTaskId', case when v_visa then v_handover[1] end,
    'visaFeesReturned', case when v_visa then cardinality(v_returned) end,
    'visaFeesReturnedTaskId', case when v_visa then v_returned[1] end,
    'visaFeesWithoutReceipt', case when v_visa then cardinality(v_noreceipt) end,
    'visaFeesWithoutReceiptTaskId', case when v_visa then v_noreceipt[1] end,
    'visaTravellerChanged', case when v_visa then cardinality(v_changed) end,
    'visaTravellerChangedTaskId', case when v_visa then v_changed[1] end,
    'salesVisaResultsToSee', case when v_sales then cardinality(v_notice_deals) end,
    'salesVisaResultsDealId', case when v_sales then v_notice_deals[1] end);
end;
$$;

-- Replaced functions keep their ACLs (CREATE OR REPLACE).

commit;
