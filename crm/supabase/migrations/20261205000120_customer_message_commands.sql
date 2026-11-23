-- TripNavigate CRM - Accounts phase 3, track A: customer message commands.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 5.3 (A1, A2),
-- 5.6 (A5, evidence kinds), 5.8 (W-A1), 5.9 (W-A2, W-A3, A6, A7-A10), 13, 14.
--
-- Replaced (latest bodies, same signatures; changed lines marked
-- "Accounts phase 3 (20261205000120)"):
--   authz.purchase_evidence_guard            (20261005000100:256)
--   public.purchase_evidence_begin           (20261005000100:903)
--   public.purchase_evidence_finish          (20261005000100:940)  *
--   public.department_evidence_begin         (20261202000140:53)
--   public.department_evidence_finish        (20261202000140:110)
--   public.department_evidence_authorize_download (20261201000130:89) *
--   * not named in contract section 19 for track A, but needed by 5.6 (a
--     customer voucher is finished on a confirmed task; boarding passes are
--     readable like e-tickets). No other track replaces them.
-- New: deal_message_prefs_set, customer_whatsapp_restart,
--   purchase_voucher_mark_ready, customer_message_event_record (service_role),
--   customer_message_claim (service_role), customer_message_complete
--   (service_role), customer_message_resend, admin_set_customer_message_switch,
--   admin_set_customer_message_pilot, customer_message_pilot_set,
--   admin_set_whatsapp_template_status.
--
-- Refusal tokens: not_authorized (42501), invalid_input (22023, hint names the
-- field), version_changed (40001), not_ready (55000, hint file | not_confirmed),
-- wrong_state (55000), template_not_approved (55000), not_found (P0002), and
-- the existing evidence tokens (evidence_rejected, already_confirmed, task_closed).
--
-- Rollback (forward-only): a NEW migration restoring the cited bodies and
-- dropping the new commands.

begin;
set local lock_timeout = '15s';

-- WhatsApp numbers are looked up by mobile on STOP replies.
create index booking_version_contacts_mobile_idx on public.booking_version_contacts (mobile)
  where contact_confirmed and mobile is not null;

-- ===========================================================================
-- 1. Purchase customer voucher (5.6)
-- ===========================================================================

create or replace function authz.purchase_evidence_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'purchase evidence rows cannot be deleted' using errcode = '42501';
  end if;
  -- Accounts phase 3 (20261205000120): the customer-ready mark is also mutable, once.
  if (to_jsonb(new) - array['status', 'updated_at', 'stored_at', 'customer_ready_at', 'customer_ready_by']) is distinct from
     (to_jsonb(old) - array['status', 'updated_at', 'stored_at', 'customer_ready_at', 'customer_ready_by']) then
    raise exception 'purchase evidence identity is immutable' using errcode = '42501';
  end if;
  if old.customer_ready_at is not null
     and (new.customer_ready_at, new.customer_ready_by, new.status) is distinct from (old.customer_ready_at, old.customer_ready_by, old.status) then
    raise exception 'a voucher marked ready for the customer is frozen' using errcode = '42501';
  end if;
  -- Accounts phase 3 (20261205000120): a customer voucher is the one exception
  -- to the freeze of a supplier-confirmed task's evidence.
  if old.kind <> 'customer_voucher'
     and exists (select 1 from public.fulfilment_tasks t where t.id = old.task_id and t.status = 'supplier_confirmed') then
    raise exception 'evidence of a supplier-confirmed task is frozen' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace function public.purchase_evidence_begin(
  p_task_id uuid, p_kind text, p_file_name text, p_mime text, p_size_bytes integer, p_sha256 text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_name text := btrim(coalesce(p_file_name, ''));
  v_sha text := lower(coalesce(p_sha256, ''));
  v_max integer := coalesce((select s.evidence_max_bytes from public.booking_settings s where s.id), 4194304);
  v_gate text;
begin
  if p_kind = 'customer_voucher' then
    -- Accounts phase 3 (20261205000120): the customer voucher of a supplier-confirmed hotel task.
    select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
    if v_task.id is null or v_task.department is distinct from 'purchase' or not authz.can_work_purchase_task(v_task.id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    if v_task.status <> 'supplier_confirmed' then
      raise exception 'not_ready' using errcode = '55000', hint = 'not_confirmed';
    end if;
    perform 1 from public.deals d where d.id = v_task.deal_id for key share;
    v_gate := authz.procurement_gate_issue(v_task.id);
    if v_gate is not null then
      raise exception '%', v_gate using errcode = '55000';
    end if;
  else
    v_task := authz.lock_workable_task(p_task_id);
  end if;
  if p_kind is null or p_kind not in ('quote', 'supplier_confirmation', 'other', 'customer_voucher')
     or p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes not between 1 and least(v_max, 4194304)
     or v_sha !~ '^[0-9a-f]{64}$'
     or length(v_name) not between 1 and 120 or v_name !~ '^[A-Za-z0-9._ -]+$' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  if (select count(*) from public.purchase_evidence e where e.task_id = v_task.id and e.status <> 'removed') >= 10 then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  v_path := v_task.legal_entity_id::text || '/' || v_task.id::text || '/' || v_id::text;
  insert into public.purchase_evidence (id, task_id, legal_entity_id, kind, object_path, file_name, mime,
    size_bytes, sha256, uploaded_by)
  values (v_id, v_task.id, v_task.legal_entity_id, p_kind, v_path, v_name, p_mime, p_size_bytes, v_sha,
    (select auth.uid()));

  perform authz.write_audit('purchase.evidence_started', v_task.legal_entity_id, v_task.branch_id,
    'purchase_evidence', v_id, null,
    jsonb_build_object('taskId', v_task.id, 'kind', p_kind, 'mime', p_mime, 'sizeBytes', p_size_bytes));
  return jsonb_build_object('evidenceId', v_id, 'objectPath', v_path);
end;
$$;

create or replace function public.purchase_evidence_finish(p_evidence_id uuid, p_ok boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_ev public.purchase_evidence%rowtype;
  v_status text;
  v_missing boolean := false;
begin
  -- Lock order everywhere: task, then evidence.
  select * into v_task from public.fulfilment_tasks t
  where t.id = (select e.task_id from public.purchase_evidence e where e.id = p_evidence_id)
  for update;
  select * into v_ev from public.purchase_evidence e where e.id = p_evidence_id for update;
  if v_ev.id is null or v_task.id is null or v_ev.uploaded_by is distinct from (select auth.uid())
     or not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Accounts phase 3 (20261205000120): a customer voucher is finished on a confirmed task.
  if v_task.status = 'supplier_confirmed' and v_ev.kind <> 'customer_voucher' then
    raise exception 'already_confirmed' using errcode = '55000';
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

  -- 'stored' only when Storage holds the object at the generated path with the declared size.
  if p_ok and (to_regclass('storage.objects') is null or not exists (
       select 1 from storage.objects o
       where o.bucket_id = 'purchase-evidence' and o.name = v_ev.object_path
         and (o.metadata ->> 'size') ~ '^[0-9]{1,18}$'
         and (o.metadata ->> 'size')::bigint = v_ev.size_bytes)) then
    v_status := 'failed';
    v_missing := true;
  end if;

  update public.purchase_evidence e
  set status = v_status, stored_at = case when v_status = 'stored' then now() else null end, updated_at = now()
  where e.id = v_ev.id;

  perform authz.write_audit(case when v_status = 'stored' then 'purchase.evidence_stored' else 'purchase.evidence_failed' end,
    v_task.legal_entity_id, v_task.branch_id, 'purchase_evidence', v_ev.id, null,
    jsonb_build_object('taskId', v_task.id, 'objectMissing', v_missing));
  return jsonb_build_object('evidenceId', v_ev.id, 'status', v_status);
end;
$$;

-- Hotel facts of a task for the voucher message (format only).
create function authz.cmsg_hotel_params(p_task uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_strip_nulls(jsonb_build_object(
    'hotelName', coalesce(nullif(f.facts ->> 'hotelName', ''), v.hotel_name),
    'checkIn', authz.cmsg_date(coalesce(case when (f.facts ->> 'checkIn') ~ '^\d{4}-\d{2}-\d{2}$' then (f.facts ->> 'checkIn')::date end, v.check_in)),
    'checkOut', authz.cmsg_date(coalesce(case when (f.facts ->> 'checkOut') ~ '^\d{4}-\d{2}-\d{2}$' then (f.facts ->> 'checkOut')::date end, v.check_out))))
  from public.fulfilment_tasks t
  join public.booking_versions v on v.id = t.booking_version_id
  left join public.service_item_facts f on f.service_item_id = t.service_item_id and f.booking_version_id = t.booking_version_id
  where t.id = p_task
$$;

-- A5: the task's Purchase assignee marks a stored voucher "ready for customer"
-- (once); queues hotel_voucher.
create function public.purchase_voucher_mark_ready(p_evidence_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_ev public.purchase_evidence%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into v_task from public.fulfilment_tasks t
  where t.id = (select e.task_id from public.purchase_evidence e where e.id = p_evidence_id) for update;
  select * into v_ev from public.purchase_evidence e where e.id = p_evidence_id for update;
  if v_ev.id is null or v_task.id is null or not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ev.customer_ready_at is not null then
    return jsonb_build_object('outcome', 'existing', 'evidenceId', v_ev.id, 'readyAt', v_ev.customer_ready_at);
  end if;
  if v_ev.kind <> 'customer_voucher' or v_ev.status <> 'stored' then
    raise exception 'not_ready' using errcode = '55000', hint = 'file';
  end if;
  if v_task.status <> 'supplier_confirmed' then
    raise exception 'not_ready' using errcode = '55000', hint = 'not_confirmed';
  end if;
  update public.purchase_evidence e set customer_ready_at = now(), customer_ready_by = (select auth.uid()), updated_at = now()
  where e.id = v_ev.id;
  perform authz.cmsg_enqueue(v_task.deal_id, 'hotel_voucher', 'voucher:' || v_ev.id::text, authz.cmsg_hotel_params(v_task.id),
    jsonb_build_object('source', 'purchase_evidence', 'id', v_ev.id));
  perform authz.write_audit('messages.voucher_ready', v_task.legal_entity_id, v_task.branch_id, 'purchase_evidence', v_ev.id, null,
    jsonb_build_object('taskId', v_task.id, 'evidenceId', v_ev.id));
  return jsonb_build_object('outcome', 'created', 'evidenceId', v_ev.id, 'readyAt', now());
end;
$$;

-- ===========================================================================
-- 2. Flight boarding pass (5.6)
-- ===========================================================================

-- At least one ticket batch for the Flight task (its own cost, or one of its sectors).
create function authz.flight_task_has_batch(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.flight_ticket_batches b where b.cost_task_id = p_task)
      or exists (select 1 from public.flight_ticket_batches b join public.flight_sectors s on s.id = any (b.sector_ids)
                 where s.task_id = p_task)
$$;

-- The Flight task's assignee (in progress or completed) may upload boarding passes.
create function authz.flight_can_upload_boarding_pass(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task and t.department = 'flight' and t.status in ('in_progress', 'completed')
      and t.assignee_user_id = (select auth.uid()) and authz.holds_active_role('flight', t.legal_entity_id))
$$;

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
  if p_kind = 'boarding_pass' then
    -- Accounts phase 3 (20261205000120): boarding passes from the Flight task's
    -- assignee, also after completion, once a ticket batch exists.
    if v_task.department <> 'flight' or not authz.flight_can_upload_boarding_pass(v_task.id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    if p_application_id is not null or not authz.flight_task_has_batch(v_task.id) then
      raise exception 'evidence_rejected' using errcode = '22023';
    end if;
  else
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
  end if;
  if p_kind is null
     or (v_task.department = 'visa' and p_kind not in ('applicant_document', 'fee_receipt', 'authority_outcome', 'other'))
     -- Flight build (20261201000130): e-tickets; Accounts phase 3: boarding passes.
     or (v_task.department = 'flight' and p_kind not in ('e_ticket', 'direct_payment_proof', 'other', 'boarding_pass'))
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
             or (v_ev.kind = 'fee_receipt' and authz.visa_can_manage_fees(v_task.id))
             -- Accounts phase 3 (20261205000120): boarding passes after completion.
             or (v_ev.kind = 'boarding_pass' and authz.flight_can_upload_boarding_pass(v_task.id))) then
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
    -- Flight build (20261201000130, D9, L14); Accounts phase 3 (20261205000120): boarding passes too.
    or (v_ev.kind in ('e_ticket', 'boarding_pass') and v_task.department = 'flight' and coalesce(authz.session_ok(), false) and (
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

-- ===========================================================================
-- 3. Deal preferences (A1) and WhatsApp restart (A2)
-- ===========================================================================

-- Readers of a Deal's customer messages (contract 14, LD9): Accounts of the
-- entity, the branch Manager, the Deal's Sales owner. A person holding
-- Purchase, Flight or Visa in the entity is never a reader (except Accounts,
-- which already excludes Purchase holders). Returns accounts | manager | sales | null.
create function authz.cmsg_viewer(p_deal uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when d.id is null or not coalesce(authz.session_ok(), false) then null
    when authz.can_accounts(d.legal_entity_id) then 'accounts'
    when exists (select 1 from public.memberships m
                 where m.user_id = (select auth.uid()) and m.legal_entity_id = d.legal_entity_id
                   and m.role_code in ('purchase', 'flight', 'visa') and m.status = 'active') then null
    when authz.is_branch_sales_manager(d.id) then 'manager'
    when d.owner_user_id = (select auth.uid()) and authz.holds_active_role('sales', d.legal_entity_id) then 'sales'
  end
  from (select 1) one left join public.deals d on d.id = p_deal
$$;

-- Sales owner or branch Manager of the Deal: may act (prefs, restart, Send again).
create function authz.cmsg_can_act(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.cmsg_viewer(p_deal) in ('sales', 'manager'), false)
$$;

create function public.deal_message_prefs_set(p_deal_id uuid, p_expected_row_version integer, p_fields jsonb, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_row public.deal_message_prefs%rowtype;
  v_old public.deal_message_prefs%rowtype;
  v_created boolean := false;
  v_key text;
  v_text text;
  v_changed text[] := '{}';
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null
     or not (authz.cmsg_can_act(v_deal.id)
             or (not exists (select 1 from public.booking_versions v where v.deal_id = v_deal.id and v.status in ('confirmed', 'superseded'))
                 and coalesce(authz.can_edit_booking_draft(v_deal.id), false))) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  for v_key in select jsonb_object_keys(p_fields) loop
    if v_key not in ('language', 'whatsappMobile', 'whatsappSameAsMobile', 'emailOverride', 'whatsappOff', 'emailOff', 'offReason') then
      raise exception 'invalid_input' using errcode = '22023', hint = v_key;
    end if;
  end loop;

  insert into public.deal_message_prefs (deal_id, legal_entity_id, branch_id, updated_by)
  values (v_deal.id, v_deal.legal_entity_id, v_deal.branch_id, (select auth.uid()))
  on conflict (deal_id) do nothing;
  v_created := found;
  select * into v_row from public.deal_message_prefs p where p.deal_id = v_deal.id for update;
  if not v_created then
    if v_row.last_request_id = p_request_id then
      return jsonb_build_object('outcome', 'existing', 'dealId', v_deal.id, 'rowVersion', v_row.row_version);
    end if;
    if p_expected_row_version is distinct from v_row.row_version then
      raise exception 'version_changed' using errcode = '40001';
    end if;
  elsif coalesce(p_expected_row_version, 0) <> 0 then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_old := v_row;

  if p_fields ? 'language' then
    if p_fields ->> 'language' not in ('en', 'hi') then
      raise exception 'invalid_input' using errcode = '22023', hint = 'language';
    end if;
    v_row.language := p_fields ->> 'language';
  end if;
  if p_fields ? 'whatsappSameAsMobile' then
    if jsonb_typeof(p_fields -> 'whatsappSameAsMobile') <> 'boolean' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'whatsappSameAsMobile';
    end if;
    if (p_fields ->> 'whatsappSameAsMobile')::boolean then
      v_row.whatsapp_mobile := null;
    end if;
  end if;
  if p_fields ? 'whatsappMobile' and not coalesce((p_fields ->> 'whatsappSameAsMobile')::boolean, false) then
    v_text := nullif(regexp_replace(coalesce(p_fields ->> 'whatsappMobile', ''), '[\s-]', '', 'g'), '');
    if v_text is not null and v_text !~ '^[6-9][0-9]{9}$' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'whatsappMobile';
    end if;
    v_row.whatsapp_mobile := v_text;
  end if;
  if p_fields ? 'emailOverride' then
    v_text := nullif(lower(btrim(coalesce(p_fields ->> 'emailOverride', ''))), '');
    if v_text is not null and (length(v_text) > 254 or v_text !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
      raise exception 'invalid_input' using errcode = '22023', hint = 'emailOverride';
    end if;
    v_row.email_override := v_text;
  end if;
  foreach v_key in array array['whatsappOff', 'emailOff'] loop
    if p_fields ? v_key then
      if jsonb_typeof(p_fields -> v_key) <> 'boolean' then
        raise exception 'invalid_input' using errcode = '22023', hint = v_key;
      end if;
      if v_key = 'whatsappOff' then v_row.whatsapp_off := (p_fields ->> v_key)::boolean;
      else v_row.email_off := (p_fields ->> v_key)::boolean; end if;
    end if;
  end loop;
  if p_fields ? 'offReason' then
    v_row.off_reason := nullif(btrim(coalesce(p_fields ->> 'offReason', ''), E' \t\r\n'), '');
  end if;
  if not (v_row.whatsapp_off or v_row.email_off) then
    v_row.off_reason := null;
  elsif v_row.off_reason is null or length(v_row.off_reason) not between 10 and 300 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'offReason';
  end if;

  if v_row.language is distinct from v_old.language then v_changed := array_append(v_changed, 'language'); end if;
  if v_row.whatsapp_mobile is distinct from v_old.whatsapp_mobile then v_changed := array_append(v_changed, 'whatsappMobile'); end if;
  if v_row.email_override is distinct from v_old.email_override then v_changed := array_append(v_changed, 'emailOverride'); end if;
  if v_row.whatsapp_off is distinct from v_old.whatsapp_off then v_changed := array_append(v_changed, 'whatsappOff'); end if;
  if v_row.email_off is distinct from v_old.email_off then v_changed := array_append(v_changed, 'emailOff'); end if;
  if v_row.off_reason is distinct from v_old.off_reason then v_changed := array_append(v_changed, 'offReason'); end if;

  update public.deal_message_prefs p
  set language = v_row.language, whatsapp_mobile = v_row.whatsapp_mobile, email_override = v_row.email_override,
      whatsapp_off = v_row.whatsapp_off, email_off = v_row.email_off, off_reason = v_row.off_reason,
      last_request_id = p_request_id,
      row_version = case when v_created then p.row_version else p.row_version + 1 end,
      updated_by = (select auth.uid()), updated_at = now()
  where p.deal_id = v_deal.id
  returning * into v_row;

  if v_created or cardinality(v_changed) > 0 then
    -- Field names only, never the values (contract 5.3).
    perform authz.write_audit('messages.prefs_changed', v_deal.legal_entity_id, v_deal.branch_id, 'deal', v_deal.id, null,
      jsonb_build_object('dealId', v_deal.id, 'fields', to_jsonb(v_changed)));
  end if;
  return jsonb_build_object('outcome', case when v_created then 'created' else 'updated' end, 'dealId', v_deal.id,
    'rowVersion', v_row.row_version);
end;
$$;

create function public.customer_whatsapp_restart(p_deal_id uuid, p_reason text, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_reason text := btrim(coalesce(p_reason, ''), E' \t\r\n');
  v_mobile text;
  v_id uuid;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null or not authz.cmsg_can_act(v_deal.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if length(v_reason) not between 10 and 300 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select c.mobile into v_mobile from authz.cmsg_contact(v_deal.id) c;
  if v_mobile is null then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  update public.customer_whatsapp_optouts o
  set restarted_at = now(), restart_source = 'staff', restarted_by = (select auth.uid()), updated_at = now()
  where o.legal_entity_id = v_deal.legal_entity_id and o.mobile = v_mobile and o.restarted_at is null
  returning o.id into v_id;
  if v_id is null then
    return jsonb_build_object('outcome', 'existing', 'dealId', v_deal.id);
  end if;
  perform authz.write_audit('messages.opt_in', v_deal.legal_entity_id, v_deal.branch_id, 'deal', v_deal.id, v_reason,
    jsonb_build_object('dealId', v_deal.id));
  return jsonb_build_object('outcome', 'updated', 'dealId', v_deal.id);
end;
$$;

-- ===========================================================================
-- 4. Worker: delivery reports and STOP (W-A1), claim (W-A2), complete (W-A3)
-- ===========================================================================

-- One alert per failed message (track D: notice 43).
create function authz.cmsg_alert_failed(p_message uuid) returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.customer_message_alerts (legal_entity_id, branch_id, deal_id, kind, message_id)
  select m.legal_entity_id, m.branch_id, m.deal_id, 'message_failed', m.id from public.customer_messages m where m.id = p_message
  on conflict do nothing
$$;

create function public.customer_message_event_record(
  p_provider text, p_provider_event_id text, p_message_ref text, p_kind text, p_error_code text, p_mobile text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_msg public.customer_messages%rowtype;
  v_event uuid;
  v_code text;
  v_deals uuid[];
  v_entities uuid[];
  v_entity uuid;
  v_new_entities uuid[] := '{}';
  v_id uuid;
  v_n integer := 0;
begin
  if p_provider is null or p_provider not in ('resend', 'interakt') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'provider';
  end if;
  if p_provider_event_id is null or length(p_provider_event_id) not between 1 and 200 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'providerEventId';
  end if;
  if p_kind is null or p_kind not in ('sent', 'delivered', 'read', 'failed', 'bounced', 'complained', 'inbound_stop',
                                      'inbound_start', 'inbound_other') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  if p_kind in ('inbound_stop', 'inbound_start') and (p_mobile is null or p_mobile !~ '^[6-9][0-9]{9}$') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'mobile';
  end if;
  v_code := case
    when p_kind = 'bounced' then 'bounced'
    when p_error_code in ('rejected', 'provider_error', 'bounced', 'invalid_number', 'expired') then p_error_code
    when p_kind = 'failed' then 'provider_error' end;

  if p_kind not like 'inbound_%' and p_message_ref is not null then
    if p_message_ref ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      select * into v_msg from public.customer_messages m where m.id = p_message_ref::uuid for update;
    end if;
    if v_msg.id is null then
      select * into v_msg from public.customer_messages m
      where m.provider_message_id = p_message_ref and m.channel = case p_provider when 'resend' then 'email' else 'whatsapp' end
      for update;
    end if;
  end if;

  insert into public.customer_message_events (provider, provider_event_id, message_id, kind, error_code)
  values (p_provider, p_provider_event_id, v_msg.id, p_kind, v_code)
  on conflict (provider, provider_event_id) do nothing
  returning id into v_event;
  if v_event is null then
    return jsonb_build_object('outcome', 'existing');
  end if;

  if v_msg.id is not null then
    if p_kind in ('sent', 'delivered', 'read') and v_msg.status = 'sending' then
      update public.customer_messages m
      set status = 'sent', sent_at = coalesce(m.sent_at, now()), lease_owner = null, lease_until = null
      where m.id = v_msg.id returning * into v_msg;
    end if;
    if p_kind = 'delivered' and v_msg.status = 'sent' then
      update public.customer_messages m set status = 'delivered', delivered_at = now() where m.id = v_msg.id;
    elsif p_kind = 'read' and v_msg.status in ('sent', 'delivered') then
      update public.customer_messages m set status = 'read', read_at = now(),
        delivered_at = coalesce(m.delivered_at, now()) where m.id = v_msg.id;
    elsif p_kind in ('failed', 'bounced') and v_msg.status in ('queued', 'sending', 'sent') then
      -- Bounced or invalid: failed at once, no retry.
      update public.customer_messages m
      set status = 'failed', failed_at = now(), last_error_code = v_code, lease_owner = null, lease_until = null
      where m.id = v_msg.id;
      perform authz.cmsg_alert_failed(v_msg.id);
      perform authz.write_system_audit('messages.failed', v_msg.legal_entity_id, v_msg.branch_id, 'customer_message', v_msg.id,
        'customer_message_dispatch', jsonb_build_object('messageId', v_msg.id, 'type', v_msg.message_type,
          'channel', v_msg.channel, 'dealId', v_msg.deal_id, 'errorCode', v_code));
    end if;
    return jsonb_build_object('outcome', 'recorded', 'kind', p_kind, 'messageId', v_msg.id);
  end if;

  if p_kind in ('inbound_stop', 'inbound_start') then
    -- Deals whose WhatsApp number this is (Deal setting, else the confirmed booking contact).
    select coalesce(array_agg(distinct d.id), '{}'), coalesce(array_agg(distinct d.legal_entity_id), '{}')
      into v_deals, v_entities
    from public.deals d
    cross join lateral authz.cmsg_contact(d.id) c
    where d.id in (select p.deal_id from public.deal_message_prefs p where p.whatsapp_mobile = p_mobile
                   union
                   select bc.deal_id from public.booking_version_contacts bc
                   join public.booking_versions v on v.id = bc.booking_version_id and v.status = 'confirmed'
                   where bc.mobile = p_mobile and bc.contact_confirmed)
      and c.mobile = p_mobile;
    if cardinality(v_entities) = 0 then
      select coalesce(array_agg(s.legal_entity_id), '{}') into v_entities from public.customer_message_settings s;
    end if;

    if p_kind = 'inbound_stop' then
      foreach v_entity in array v_entities loop
        v_id := null;
        insert into public.customer_whatsapp_optouts (legal_entity_id, mobile, source, event_id)
        values (v_entity, p_mobile, 'stop_reply', v_event)
        on conflict (legal_entity_id, mobile) do update
          set opted_out_at = now(), source = 'stop_reply', event_id = excluded.event_id, restarted_at = null,
              restart_source = null, restarted_by = null, restart_event_id = null, updated_at = now()
          where public.customer_whatsapp_optouts.restarted_at is not null
        returning id into v_id;
        if v_id is not null then
          v_new_entities := v_new_entities || v_entity;
        end if;
      end loop;
      update public.customer_messages m set status = 'stopped', skip_reason = 'opted_out'
      where m.deal_id = any (v_deals) and m.channel = 'whatsapp' and m.status = 'queued';
      insert into public.customer_message_alerts (legal_entity_id, branch_id, deal_id, kind, event_id)
      select d.legal_entity_id, d.branch_id, d.id, 'whatsapp_stopped', v_event
      from public.deals d
      where d.id = any (v_deals)
        -- A repeated STOP while already opted out tells nobody again.
        and d.legal_entity_id = any (v_new_entities)
        and coalesce((select v.trip_end from public.booking_versions v where v.deal_id = d.id and v.status = 'confirmed'
                       order by v.version_no desc limit 1), authz.finance_today()) >= authz.finance_today()
      on conflict do nothing;
      get diagnostics v_n = row_count;
    else
      update public.customer_whatsapp_optouts o
      set restarted_at = now(), restart_source = 'start_reply', restart_event_id = v_event, updated_at = now()
      where o.mobile = p_mobile and o.restarted_at is null and o.legal_entity_id = any (v_entities);
    end if;
    return jsonb_build_object('outcome', 'recorded', 'kind', p_kind, 'deals', cardinality(v_deals), 'alerts', v_n);
  end if;
  return jsonb_build_object('outcome', 'recorded', 'kind', p_kind);
end;
$$;

-- Reply-to (LD10): the Deal's active Sales owner, else the first active branch Manager, else none.
create function authz.cmsg_reply_to(p_deal uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select sp.work_email from public.deals d
     join public.staff_profiles sp on sp.user_id = d.owner_user_id and sp.status = 'active'
     where d.id = p_deal and exists (select 1 from public.memberships m
       where m.user_id = d.owner_user_id and m.legal_entity_id = d.legal_entity_id and m.role_code = 'sales' and m.status = 'active')),
    (select sp.work_email from public.deals d
     join public.memberships m on m.legal_entity_id = d.legal_entity_id and m.branch_id = d.branch_id
       and m.role_code = 'manager' and m.status = 'active'
     join public.staff_profiles sp on sp.user_id = m.user_id and sp.status = 'active'
     where d.id = p_deal order by m.created_at, sp.work_email limit 1))
$$;

-- The file of a message (null when it is no longer available).
create function authz.cmsg_attachment_file(p_attachment jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case p_attachment ->> 'source'
    when 'purchase_evidence' then (
      select jsonb_build_object('source', 'purchase_evidence', 'id', e.id, 'bucket', 'purchase-evidence',
        'objectPath', e.object_path, 'fileName', e.file_name, 'mime', e.mime)
      from public.purchase_evidence e
      where e.id = (p_attachment ->> 'id')::uuid and e.status = 'stored' and e.customer_ready_at is not null)
    when 'department_evidence' then (
      select jsonb_build_object('source', 'department_evidence', 'id', e.id, 'bucket', 'department-evidence',
        'objectPath', e.object_path, 'fileName', e.file_name, 'mime', e.mime)
      from public.department_evidence e
      where e.id = (p_attachment ->> 'id')::uuid and e.status = 'stored')
  end
$$;

-- W-A2: due rows, skip rules re-checked now (a STOP or a switch-off wins),
-- the recipient resolved now: the only place an address leaves the database.
create function public.customer_message_claim(p_worker text, p_limit integer, p_lease_seconds integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_msg public.customer_messages%rowtype;
  v_reason text;
  v_file jsonb;
  c record;
  v_out jsonb := '[]'::jsonb;
begin
  if p_worker is null or length(p_worker) not between 1 and 60 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'worker';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'limit';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 10 and 600 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'leaseSeconds';
  end if;
  for v_msg in
    select * from public.customer_messages m
    where m.status in ('queued', 'sending') and m.next_attempt_at <= now() and m.not_before <= now()
      and (m.status = 'queued' or m.lease_until < now())
    order by m.next_attempt_at, m.id
    limit p_limit
    for update skip locked
  loop
    -- A lease that ran out after the last allowed attempt: failed.
    if v_msg.status = 'sending' and v_msg.attempts >= 4 then
      update public.customer_messages m set status = 'failed', failed_at = now(), last_error_code = 'expired',
        lease_owner = null, lease_until = null where m.id = v_msg.id;
      perform authz.cmsg_alert_failed(v_msg.id);
      continue;
    end if;
    -- A switch turned Off after queueing wins: the message is not sent.
    v_reason := case when not authz.cmsg_switch_on(v_msg.legal_entity_id, v_msg.message_type, v_msg.channel) then 'switched_off'
                     else authz.cmsg_skip_reason(v_msg.deal_id, v_msg.message_type, v_msg.channel) end;
    v_file := null;
    if v_reason is null and v_msg.attachment is not null then
      v_file := authz.cmsg_attachment_file(v_msg.attachment);
      if v_file is null then
        v_reason := 'file_missing';
      end if;
    end if;
    if v_reason is not null then
      update public.customer_messages m
      set status = case when v_reason = 'opted_out' then 'stopped' else 'skipped' end, skip_reason = v_reason,
          lease_owner = null, lease_until = null
      where m.id = v_msg.id;
      continue;
    end if;
    select * into c from authz.cmsg_contact(v_msg.deal_id);
    update public.customer_messages m
    set status = 'sending', attempts = least(m.attempts + 1, 4), lease_owner = p_worker,
        lease_until = now() + make_interval(secs => p_lease_seconds),
        to_masked = case m.channel when 'email' then authz.cmsg_mask_email(c.email) else authz.cmsg_mask_mobile(c.mobile) end
    where m.id = v_msg.id;
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'id', v_msg.id, 'channel', v_msg.channel, 'type', v_msg.message_type, 'language', v_msg.language,
      'templateCode', v_msg.template_code, 'params', v_msg.params, 'attachment', v_file, 'dealId', v_msg.deal_id,
      'to', case v_msg.channel when 'email' then c.email else c.mobile end,
      'replyTo', case v_msg.channel when 'email' then authz.cmsg_reply_to(v_msg.deal_id) end));
  end loop;
  return v_out;
end;
$$;

-- W-A3: sent, or the retry schedule (+5, +20, +60 minutes), then failed with one alert.
create function public.customer_message_complete(
  p_id uuid, p_worker text, p_ok boolean, p_provider_message_id text, p_error_code text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_msg public.customer_messages%rowtype;
  v_code text;
  v_final boolean;
begin
  if p_ok is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'ok';
  end if;
  select * into v_msg from public.customer_messages m where m.id = p_id for update;
  if v_msg.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_msg.status <> 'sending' or v_msg.lease_owner is distinct from p_worker then
    if p_ok and v_msg.provider_message_id is not distinct from p_provider_message_id and v_msg.status in ('sent', 'delivered', 'read') then
      return jsonb_build_object('outcome', 'existing', 'status', v_msg.status);
    end if;
    -- A delivery report arrived before the worker finished: keep the provider id.
    if p_ok and v_msg.provider_message_id is null and v_msg.status in ('sent', 'delivered')
       and length(coalesce(p_provider_message_id, '')) between 1 and 200 then
      update public.customer_messages m set provider_message_id = p_provider_message_id, lease_owner = null, lease_until = null
      where m.id = v_msg.id;
      return jsonb_build_object('outcome', 'existing', 'status', v_msg.status);
    end if;
    -- The lease was lost (or a delivery report came first): nothing to do.
    return jsonb_build_object('outcome', 'stale', 'status', v_msg.status);
  end if;

  if p_ok then
    if p_provider_message_id is null or length(p_provider_message_id) not between 1 and 200 then
      raise exception 'invalid_input' using errcode = '22023', hint = 'providerMessageId';
    end if;
    update public.customer_messages m
    set status = 'sent', sent_at = now(), provider_message_id = p_provider_message_id, last_error_code = null,
        lease_owner = null, lease_until = null
    where m.id = v_msg.id;
    perform authz.write_system_audit('messages.sent', v_msg.legal_entity_id, v_msg.branch_id, 'customer_message', v_msg.id,
      'customer_message_dispatch', jsonb_build_object('messageId', v_msg.id, 'type', v_msg.message_type,
        'channel', v_msg.channel, 'dealId', v_msg.deal_id));
    return jsonb_build_object('outcome', 'updated', 'status', 'sent');
  end if;

  v_code := case when p_error_code in ('not_configured', 'rejected', 'provider_error', 'network', 'bad_response', 'bounced',
                                         'invalid_number', 'expired') then p_error_code else 'provider_error' end;
  v_final := v_code in ('not_configured', 'rejected', 'bounced', 'invalid_number', 'expired') or v_msg.attempts >= 4;
  if not v_final then
    update public.customer_messages m
    set status = 'queued', last_error_code = v_code, lease_owner = null, lease_until = null,
        next_attempt_at = now() + make_interval(mins => case m.attempts when 1 then 5 when 2 then 20 else 60 end)
    where m.id = v_msg.id;
    return jsonb_build_object('outcome', 'updated', 'status', 'queued', 'attempts', v_msg.attempts);
  end if;
  update public.customer_messages m
  set status = 'failed', failed_at = now(), last_error_code = v_code, lease_owner = null, lease_until = null
  where m.id = v_msg.id;
  -- A missing provider key is shown honestly on the Deal, without a notice per message.
  if v_code <> 'not_configured' then
    perform authz.cmsg_alert_failed(v_msg.id);
  end if;
  perform authz.write_system_audit('messages.failed', v_msg.legal_entity_id, v_msg.branch_id, 'customer_message', v_msg.id,
    'customer_message_dispatch', jsonb_build_object('messageId', v_msg.id, 'type', v_msg.message_type,
      'channel', v_msg.channel, 'dealId', v_msg.deal_id, 'errorCode', v_code));
  return jsonb_build_object('outcome', 'updated', 'status', 'failed');
end;
$$;

-- ===========================================================================
-- 5. "Send again" (A6)
-- ===========================================================================

create function authz.cmsg_can_resend(p_msg public.customer_messages) returns boolean
language sql stable security definer set search_path = '' as $$
  select (p_msg.status = 'failed'
          or (p_msg.status = 'skipped' and p_msg.skip_reason = 'no_contact')
          or (p_msg.status = 'stopped' and not authz.cmsg_opted_out(p_msg.legal_entity_id,
                (select c.mobile from authz.cmsg_contact(p_msg.deal_id) c))))
$$;

create function public.customer_message_resend(p_message_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_msg public.customer_messages%rowtype;
  v_new public.customer_messages%rowtype;
  v_key text;
  v_n integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_msg from public.customer_messages m where m.id = p_message_id;
  if v_msg.id is null or not authz.cmsg_can_act(v_msg.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into v_new from public.customer_messages m where m.deal_id = v_msg.deal_id and m.request_id = p_request_id;
  if v_new.id is not null then
    return jsonb_build_object('outcome', 'existing', 'messageId', v_new.id, 'status', v_new.status, 'skipReason', v_new.skip_reason);
  end if;
  select * into v_msg from public.customer_messages m where m.id = p_message_id for update;
  if not authz.cmsg_can_resend(v_msg)
     or not authz.cmsg_switch_on(v_msg.legal_entity_id, v_msg.message_type, v_msg.channel) then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  select count(*) + 1 into v_n from public.customer_messages r where r.resend_of = v_msg.id;
  v_key := v_msg.event_key || ':r' || v_n::text;
  if length(v_key) > 120 then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  -- All rules re-checked; base params (contact name, trip) read again.
  perform authz.cmsg_enqueue_core(v_msg.deal_id, v_msg.message_type, v_key,
    v_msg.params - array['customerName', 'dealReference', 'destination', 'tripStart', 'tripEnd', 'travellerCount'],
    v_msg.attachment, array[v_msg.channel], 'resend', v_msg.id, (select auth.uid()), p_request_id);
  select * into v_new from public.customer_messages m
  where m.deal_id = v_msg.deal_id and m.message_type = v_msg.message_type and m.channel = v_msg.channel and m.event_key = v_key;
  if v_new.id is null then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.write_audit('messages.resent', v_msg.legal_entity_id, v_msg.branch_id, 'customer_message', v_new.id, null,
    jsonb_build_object('messageId', v_new.id, 'resendOf', v_msg.id, 'type', v_msg.message_type, 'channel', v_msg.channel,
      'dealId', v_msg.deal_id));
  return jsonb_build_object('outcome', 'created', 'messageId', v_new.id, 'status', v_new.status, 'skipReason', v_new.skip_reason);
end;
$$;

-- ===========================================================================
-- 6. Super Admin settings (A7-A10)
-- ===========================================================================

create function authz.cmsg_admin_check(p_entity uuid, p_reason text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_reason text := btrim(coalesce(p_reason, ''), E' \t\r\n');
begin
  if p_entity is null or not authz.can_switch_live_settings(p_entity) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if char_length(v_reason) < 10 or char_length(v_reason) > 500 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  return v_reason;
end;
$$;

create function public.admin_set_customer_message_switch(
  p_entity uuid, p_type text, p_channel text, p_enabled boolean, p_reason text, p_expected_row_version integer
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_reason text := authz.cmsg_admin_check(p_entity, p_reason);
  v_row public.customer_message_switches%rowtype;
  v_prev text[];
begin
  if p_type is null or not (p_type = any (authz.cmsg_types())) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'type';
  end if;
  if p_channel is null or p_channel not in ('email', 'whatsapp') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'channel';
  end if;
  if p_enabled is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'enabled';
  end if;
  select * into v_row from public.customer_message_switches s
  where s.legal_entity_id = p_entity and s.message_type = p_type and s.channel = p_channel for update;
  if v_row.legal_entity_id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_expected_row_version is distinct from v_row.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if v_row.enabled = p_enabled then
    return jsonb_build_object('changed', false, 'enabled', v_row.enabled, 'rowVersion', v_row.row_version);
  end if;
  if p_enabled and p_channel = 'whatsapp' and exists (
       select 1 from unnest(array['en', 'hi']) l(l)
       where coalesce((select t.status from public.whatsapp_templates t
                       where t.legal_entity_id = p_entity and t.template_code = authz.cmsg_template_code(p_type, l.l)), '') <> 'approved') then
    raise exception 'template_not_approved' using errcode = '55000';
  end if;
  v_prev := authz.settings_begin_change('admin_set_customer_message_switch', v_reason);
  update public.customer_message_switches s
  set enabled = p_enabled, updated_by = (select auth.uid()), updated_at = now(), row_version = s.row_version + 1
  where s.legal_entity_id = p_entity and s.message_type = p_type and s.channel = p_channel
  returning * into v_row;
  perform authz.settings_end_change(v_prev);
  return jsonb_build_object('changed', true, 'enabled', v_row.enabled, 'rowVersion', v_row.row_version);
end;
$$;

create function public.admin_set_customer_message_pilot(p_entity uuid, p_pilot_only boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_reason text := authz.cmsg_admin_check(p_entity, p_reason);
  v_before boolean;
  v_prev text[];
begin
  if p_pilot_only is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'pilotOnly';
  end if;
  select s.pilot_only into v_before from public.customer_message_settings s where s.legal_entity_id = p_entity for update;
  if not found then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_prev := authz.settings_begin_change('admin_set_customer_message_pilot', v_reason);
  update public.customer_message_settings s set pilot_only = p_pilot_only, updated_by = (select auth.uid()), updated_at = now()
  where s.legal_entity_id = p_entity and s.pilot_only is distinct from p_pilot_only;
  perform authz.settings_end_change(v_prev);
  return jsonb_build_object('changed', v_before is distinct from p_pilot_only, 'pilotOnly', p_pilot_only);
end;
$$;

create function public.customer_message_pilot_set(p_entity uuid, p_deal_id uuid, p_in boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_reason text := authz.cmsg_admin_check(p_entity, p_reason);
  v_deal public.deals%rowtype;
  v_n integer;
begin
  if p_in is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'in';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id and d.legal_entity_id = p_entity;
  if v_deal.id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'dealId';
  end if;
  if p_in then
    insert into public.customer_message_pilot (legal_entity_id, deal_id, added_by)
    values (p_entity, v_deal.id, (select auth.uid()))
    on conflict do nothing;
  else
    update public.customer_message_pilot p set removed_at = now(), removed_by = (select auth.uid())
    where p.deal_id = v_deal.id and p.removed_at is null;
  end if;
  get diagnostics v_n = row_count;
  if v_n > 0 then
    perform authz.write_audit('settings.messages_changed', p_entity, v_deal.branch_id, 'customer_message_pilot', v_deal.id, v_reason,
      jsonb_build_object('operation', case when p_in then 'pilot_add' else 'pilot_remove' end, 'dealId', v_deal.id));
  end if;
  return jsonb_build_object('changed', v_n > 0, 'inPilot', p_in);
end;
$$;

create function public.admin_set_whatsapp_template_status(p_entity uuid, p_template_code text, p_status text, p_reason text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_reason text := authz.cmsg_admin_check(p_entity, p_reason);
  v_before text;
  v_prev text[];
begin
  if p_status is null or p_status not in ('not_submitted', 'submitted', 'approved', 'rejected') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'status';
  end if;
  select t.status into v_before from public.whatsapp_templates t
  where t.legal_entity_id = p_entity and t.template_code = p_template_code for update;
  if not found then
    raise exception 'invalid_input' using errcode = '22023', hint = 'templateCode';
  end if;
  v_prev := authz.settings_begin_change('admin_set_whatsapp_template_status', v_reason);
  update public.whatsapp_templates t
  set status = p_status, updated_by = (select auth.uid()), updated_at = now(), row_version = t.row_version + 1
  where t.legal_entity_id = p_entity and t.template_code = p_template_code and t.status is distinct from p_status;
  perform authz.settings_end_change(v_prev);
  return jsonb_build_object('changed', v_before is distinct from p_status, 'status', p_status);
end;
$$;

-- ===========================================================================
-- 7. Privileges
-- ===========================================================================

revoke all on function
  authz.cmsg_hotel_params(uuid), authz.flight_task_has_batch(uuid), authz.flight_can_upload_boarding_pass(uuid),
  authz.cmsg_viewer(uuid), authz.cmsg_can_act(uuid), authz.cmsg_alert_failed(uuid), authz.cmsg_reply_to(uuid), authz.cmsg_attachment_file(jsonb),
  authz.cmsg_can_resend(public.customer_messages), authz.cmsg_admin_check(uuid, text),
  public.purchase_voucher_mark_ready(uuid, uuid),
  public.deal_message_prefs_set(uuid, integer, jsonb, uuid),
  public.customer_whatsapp_restart(uuid, text, uuid),
  public.customer_message_event_record(text, text, text, text, text, text),
  public.customer_message_claim(text, integer, integer),
  public.customer_message_complete(uuid, text, boolean, text, text),
  public.customer_message_resend(uuid, uuid),
  public.admin_set_customer_message_switch(uuid, text, text, boolean, text, integer),
  public.admin_set_customer_message_pilot(uuid, boolean, text),
  public.customer_message_pilot_set(uuid, uuid, boolean, text),
  public.admin_set_whatsapp_template_status(uuid, text, text, text)
from public, anon, authenticated, service_role;

grant execute on function
  public.purchase_voucher_mark_ready(uuid, uuid),
  public.deal_message_prefs_set(uuid, integer, jsonb, uuid),
  public.customer_whatsapp_restart(uuid, text, uuid),
  public.customer_message_resend(uuid, uuid),
  public.admin_set_customer_message_switch(uuid, text, text, boolean, text, integer),
  public.admin_set_customer_message_pilot(uuid, boolean, text),
  public.customer_message_pilot_set(uuid, uuid, boolean, text),
  public.admin_set_whatsapp_template_status(uuid, text, text, text)
to authenticated;

grant execute on function
  public.customer_message_event_record(text, text, text, text, text, text),
  public.customer_message_claim(text, integer, integer),
  public.customer_message_complete(uuid, text, boolean, text, text)
to service_role;

commit;
