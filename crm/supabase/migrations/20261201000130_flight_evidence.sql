-- TripNavigate CRM - Flight build, track A (4 of 4): e-tickets as a private
-- department file kind.
-- Contract: Flight department build contract (frozen 4 November 2026),
-- sections 5.1 (department_evidence) and 6.1 A11; owner decision D9; lead
-- decision L14 (Accounts may open e-tickets).
--
-- What changes:
--   1. department_evidence.kind gains 'e_ticket' (same bucket
--      department-evidence, same 4 MiB / pdf, jpeg, png, webp / sha256 rules).
--   2. department_evidence_begin (same signature): flight tasks may begin
--      e_ticket, direct_payment_proof and other. Every other rule is the body
--      of 20261119000500 unchanged (assignee of the in-progress task,
--      task_closed after completion, 50 files per task, file name pattern).
--   3. department_evidence_authorize_download (same signature): a stored
--      e_ticket may also be opened by the Deal's Sales owner, the branch
--      Manager and Accounts of the entity. Every download keeps writing the
--      department.evidence_viewed audit. Purchase and Visa never open it
--      (they hold neither the Flight role nor Accounts without Purchase).
--
-- Refusal tokens unchanged: 42501 not_authorized, 55000 task_closed,
-- 22023 evidence_rejected, P0002 not_found.
--
-- Rollback (forward-only): a new migration restoring both bodies from
-- 20261119000500; the kind check can only be narrowed again while no e_ticket
-- row exists. Files are never deleted.

begin;
set local lock_timeout = '15s';

alter table public.department_evidence drop constraint department_evidence_kind_check;
alter table public.department_evidence add constraint department_evidence_kind_check
  check (kind in ('applicant_document', 'fee_receipt', 'authority_outcome', 'direct_payment_proof', 'other', 'e_ticket'));
comment on table public.department_evidence is
  'Private files of a department task (applicant documents, fee receipts, authority outcomes, direct-payment proof, e-tickets). Desk and branch Manager only; Accounts sees receipts and payment proof of an expense record it reviews; e-tickets also the Sales owner and Accounts (Flight build). No Data API read.';

-- Replaces 20261119000500: flight kinds e_ticket, direct_payment_proof, other.
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
  if v_task.status in ('completed', 'supplier_confirmed') then
    raise exception 'task_closed' using errcode = '55000';
  end if;
  if not authz.can_work_department_task(v_task.id) or v_task.department = 'purchase' then
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
  if (select count(*) from public.department_evidence e where e.task_id = v_task.id and e.status <> 'removed') >= 50 then
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

-- Replaces 20261119000500: e-tickets also for the Sales owner, the branch
-- Manager (already a department-task reader) and Accounts of the entity.
create or replace function public.department_evidence_authorize_download(p_evidence_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ev public.department_evidence%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_ok boolean;
begin
  select * into v_ev from public.department_evidence e where e.id = p_evidence_id;
  select * into v_task from public.fulfilment_tasks t where t.id = v_ev.task_id;
  v_ok := v_ev.id is not null and (
    authz.can_read_department_task(v_task.id)
    or (v_ev.kind in ('fee_receipt', 'direct_payment_proof') and exists (
          select 1 from public.department_cost_entries c join public.deals d on d.id = c.deal_id
          where c.receipt_evidence_id = v_ev.id and c.expense_status in ('submitted', 'accepted', 'returned')
            and authz.can_accounts(c.legal_entity_id) and not authz.holds_role('purchase', c.legal_entity_id)
            and authz.finance_gate_issue(c.legal_entity_id, d.is_synthetic) is null))
    -- Flight build (20261201000130, D9, L14).
    or (v_ev.kind = 'e_ticket' and v_task.department = 'flight' and coalesce(authz.session_ok(), false) and (
          authz.flight_is_sales_owner(v_task.deal_id)
          or authz.is_branch_sales_manager(v_task.deal_id)
          or authz.can_accounts(v_task.legal_entity_id))));
  if not coalesce(v_ok, false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ev.status <> 'stored' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.write_audit('department.evidence_viewed', v_ev.legal_entity_id, v_task.branch_id,
    'department_evidence', v_ev.id, null, jsonb_build_object('taskId', v_ev.task_id, 'kind', v_ev.kind));
  return jsonb_build_object('objectPath', v_ev.object_path, 'fileName', v_ev.file_name, 'mime', v_ev.mime);
end;
$$;
-- Both functions keep their ACLs (CREATE OR REPLACE).

commit;
