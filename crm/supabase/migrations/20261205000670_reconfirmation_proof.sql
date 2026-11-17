-- TripNavigate CRM - Accounts phase 3, track G (7): the supplier's
-- reconfirmation proof on a supplier-confirmed task.
-- Contract: accounts-phase3-2026-11-12/contract.md section 10.2
-- (task_reconfirmations.evidence_id: purchase_evidence kind
-- supplier_confirmation, stored, uploaded after the request was approved) and
-- Addendum L5 (lead, 13 Nov 2026: track G replaces these once).
--
-- Replaced (track A's latest bodies in 20261205000120, same signatures;
-- changed lines marked "Accounts phase 3 (20261205000670)"):
--   authz.purchase_evidence_guard: a row linked to a reconfirmation
--     (purchase_evidence.reconfirmation_id, added by 20261205000610) may move
--     pending_upload -> stored on a supplier-confirmed task.
--   public.purchase_evidence_begin: kind supplier_confirmation on a
--     supplier-confirmed task is accepted for the task's Purchase assignee when
--     the task has a pending reconfirmation of a submitted change request; the
--     row is linked to that reconfirmation. Every other case is unchanged
--     (already_confirmed as before).
--   public.purchase_evidence_finish: finishes such a linked row.
-- task_reconfirm_record (20261205000640) accepts only a stored proof linked to
-- the reconfirmation being recorded.
--
-- Refusal tokens: unchanged (not_authorized, already_confirmed,
-- evidence_rejected, invalid_input, procurement gate tokens).
-- Rollback (forward-only): a NEW migration restoring the three
-- 20261205000120 bodies.

begin;
set local lock_timeout = '15s';

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
  -- Accounts phase 3 (20261205000670): so is a supplier's reconfirmation proof
  -- linked to an open reconfirmation (contract 10.2, Addendum L5).
  if old.kind <> 'customer_voucher' and old.reconfirmation_id is null
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
  v_reconf uuid;  -- Accounts phase 3 (20261205000670)
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
  -- Accounts phase 3 (20261205000670): the supplier's reconfirmation proof on a
  -- supplier-confirmed task with an open reconfirmation of a submitted change.
  elsif p_kind = 'supplier_confirmation'
        and exists (select 1 from public.fulfilment_tasks t where t.id = p_task_id and t.status = 'supplier_confirmed') then
    select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
    if v_task.id is null or v_task.department is distinct from 'purchase' or not authz.can_work_purchase_task(v_task.id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    select x.id into v_reconf from public.task_reconfirmations x
    join public.booking_change_requests r on r.id = x.change_request_id
    where x.task_id = v_task.id and x.status = 'pending' and r.status = 'submitted'
    order by x.created_at desc limit 1;
    if v_reconf is null then
      raise exception 'already_confirmed' using errcode = '55000';
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
    size_bytes, sha256, uploaded_by, reconfirmation_id)
  values (v_id, v_task.id, v_task.legal_entity_id, p_kind, v_path, v_name, p_mime, p_size_bytes, v_sha,
    (select auth.uid()), v_reconf);

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
  -- Accounts phase 3 (20261205000670): and a reconfirmation proof.
  if v_task.status = 'supplier_confirmed' and v_ev.kind <> 'customer_voucher' and v_ev.reconfirmation_id is null then
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

commit;
