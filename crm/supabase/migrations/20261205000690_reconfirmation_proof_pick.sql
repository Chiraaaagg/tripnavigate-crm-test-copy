-- TripNavigate CRM - Accounts phase 3, track G (9): the Purchase person picks
-- the right reconfirmation proof (lead UI review, 13 Nov 2026).
--
-- Replaced (latest bodies, same signatures; changed lines marked
-- "Accounts phase 3 (20261205000690)"):
--   public.purchase_workspace (20261204000130:310): each evidence row gains
--     reconfirmationId (purchase_evidence.reconfirmation_id; null for files
--     not uploaded for a reconfirmation). Additive key; nothing else changes.
--   public.task_reconfirmation_get (20261205000660): can.uploadProof - the
--     caller may upload the reconfirmation proof now (the task's Purchase
--     assignee, task supplier-confirmed, this reconfirmation pending, request
--     submitted: the rule of purchase_evidence_begin, 20261205000670).
--
-- Rollback (forward-only): a NEW migration restoring both earlier bodies.

begin;
set local lock_timeout = '15s';

create or replace function public.purchase_workspace(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_uid uuid := (select auth.uid());
  v_manager boolean;
  v_latest public.purchase_cost_versions;
  v_budget bigint;
  v_hotel_id uuid;  -- Accounts phase 2
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or not authz.can_read_purchase_workspace(v_task.id) then
    return null;
  end if;
  v_manager := authz.can_manage_purchase_task(v_task.id);
  v_latest := authz.purchase_latest_cost(v_task.id);
  v_budget := authz.task_budget(v_task.id);
  -- Accounts phase 2: hotel tasks carry the booking's catalogue hotel (service_item_facts column).
  if v_task.service_purpose = 'hotel' then
    select f.catalogue_hotel_id into v_hotel_id from public.service_item_facts f
    where f.service_item_id = v_task.service_item_id and f.booking_version_id = authz.task_current_version(v_task.id);
  end if;
  return jsonb_build_object(
    'task', authz.purchase_task_json(v_task.id, true),
    'canWork', authz.can_work_purchase_task(v_task.id) and v_task.status = 'in_progress',
    'canRelease', authz.can_work_purchase_task(v_task.id) and v_task.status = 'in_progress',
    'canReassign', v_manager and v_task.status = 'in_progress',
    'canApproveOverBudget', v_manager and v_task.status = 'in_progress' and v_latest.id is not null
      and v_latest.stage = 'proposed' and (v_budget is null or v_latest.amount_paise > v_budget)
      and not authz.cost_version_approved(v_task.id, v_latest.version_no)
      and v_latest.created_by is distinct from v_uid
      and authz.procurement_gate_issue(v_task.id) is null,
    'assigneeUserId', v_task.assignee_user_id,
    'reassignCandidates', case when v_manager and v_task.status = 'in_progress' then coalesce((
      select jsonb_agg(jsonb_build_object('userId', p.user_id, 'name', p.display_name) order by p.display_name, p.user_id)
      from public.staff_profiles p
      where p.user_id is distinct from v_task.assignee_user_id
        -- Batch 6: candidates of the task's department (same rule as purchase_task_reassign).
        and authz.is_active_department_person(p.user_id, v_task.legal_entity_id, v_task.department)), '[]'::jsonb)
      else '[]'::jsonb end,
    'gateIssue', authz.procurement_gate_issue(v_task.id),
    'issues', case when v_task.status = 'in_progress' then to_jsonb(authz.procurement_issues(v_task.id))
                   else '[]'::jsonb end,
    'supplierReference', v_task.supplier_reference,
    'selectedQuoteId', v_task.selected_quote_id,
    'supplierConfirmedByName', (select p.display_name from public.staff_profiles p
                                where p.user_id = v_task.supplier_confirmed_by),
    'quotes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'quoteId', q.id,
        'supplierId', q.supplier_id,
        'supplierName', s.name,
        'supplierVerification', s.verification_status,
        'hotelName', q.hotel_name,
        'roomType', q.room_type,
        'mealPlan', q.meal_plan,
        'quotedCostPaise', q.quoted_cost_paise::text,
        'holdUntil', to_char(q.hold_until, 'YYYY-MM-DD'),
        'cancellationTerms', q.cancellation_terms,
        'status', q.status,
        'createdAt', q.created_at,
        'createdByName', p.display_name,
        -- Purchase build.
        'perRoomNightPaise', q.per_room_night_paise::text,
        'note', q.note) order by q.created_at, q.id)
      from public.purchase_quotes q
      join public.suppliers s on s.id = q.supplier_id
      left join public.staff_profiles p on p.user_id = q.created_by
      where q.task_id = v_task.id), '[]'::jsonb),
    'costVersions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'versionNo', c.version_no,
        'quoteId', c.quote_id,
        'stage', c.stage,
        'amountPaise', c.amount_paise::text,
        'dueDate', to_char(c.due_date, 'YYYY-MM-DD'),
        'note', c.note,
        'payableStatus', c.payable_status,
        'createdAt', c.created_at,
        'createdByName', p.display_name,
        'overBudgetApprovedAt', a.approved_at,
        'overBudgetApprovedByName', ap.display_name) order by c.version_no desc)
      from public.purchase_cost_versions c
      left join public.staff_profiles p on p.user_id = c.created_by
      left join public.purchase_cost_approvals a on a.task_id = c.task_id and a.version_no = c.version_no
      left join public.staff_profiles ap on ap.user_id = a.approved_by
      where c.task_id = v_task.id), '[]'::jsonb),
    'evidence', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', e.id,
        'kind', e.kind,
        'fileName', e.file_name,
        'mime', e.mime,
        'sizeBytes', e.size_bytes,
        'status', e.status,
        'createdAt', e.created_at,
        'uploadedByName', p.display_name,
        -- Accounts phase 3 (20261205000690): the reconfirmation a proof was uploaded for (null = any other file).
        'reconfirmationId', e.reconfirmation_id) order by e.created_at, e.id)
      from public.purchase_evidence e
      left join public.staff_profiles p on p.user_id = e.uploaded_by
      where e.task_id = v_task.id and e.status <> 'removed'), '[]'::jsonb),
    -- Purchase build: go-ahead, e-mails (no provider details), trip cancellation, e-mail switch.
    'goAhead', authz.purchase_go_ahead_json(v_task.id),
    'emails', coalesce((
      select jsonb_agg(jsonb_build_object(
        'emailId', m.id,
        'kind', m.kind,
        'supplierId', m.supplier_id,
        'supplierName', s.name,
        'toEmail', m.to_email,
        'ccEmails', to_jsonb(m.cc_emails),
        'subject', m.subject,
        'body', m.body,
        'status', m.status,
        'costVersionNo', m.cost_version_no,
        'sentAt', m.sent_at,
        'sentByName', p.display_name,
        'failed', m.status = 'failed') order by m.sent_at desc, m.id desc)
      from public.purchase_supplier_emails m
      join public.suppliers s on s.id = m.supplier_id
      left join public.staff_profiles p on p.user_id = m.sent_by
      where m.task_id = v_task.id), '[]'::jsonb),
    'cancellation', authz.task_cancellation_json(v_task.id),
    'emailSendingEnabled', authz.supplier_email_sending_enabled())
    -- Accounts phase 2 (20261204000130, 13.4): the booking's catalogue hotel and who sells it.
    || jsonb_build_object(
      'catalogueHotelId', v_hotel_id,
      'catalogueHotelName', (select h.name from public.hotel_catalogue h where h.id = v_hotel_id),
      'hotelSuppliers', case when v_hotel_id is null then '[]'::jsonb
                             else coalesce(authz.hotel_supplier_rows(v_hotel_id), '[]'::jsonb) end);
end;
$$;


create or replace function public.task_reconfirmation_get(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_x public.task_reconfirmations%rowtype;
  v_r public.booking_change_requests%rowtype;
  v_cost public.purchase_cost_versions;
  v_work boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  -- Purchase holders of the entity (not also a branch Manager of the Deal), or
  -- the branch Manager without Purchase / Flight / Visa (section 4, Addendum L5).
  if v_task.id is null or v_task.department is distinct from 'purchase' or not authz.session_ok()
     or not ((authz.holds_active_role('purchase', v_task.legal_entity_id) and not authz.is_branch_sales_manager(v_task.deal_id))
             or authz.refund_is_m(v_task.deal_id)) then
    return null;
  end if;
  select * into v_x from public.task_reconfirmations x where x.task_id = v_task.id order by x.created_at desc, x.id desc limit 1;
  if v_x.id is null then
    return null;
  end if;
  select * into v_r from public.booking_change_requests r where r.id = v_x.change_request_id;
  select c.* into v_cost from public.purchase_cost_versions c
  where c.task_id = v_task.id and c.stage = 'committed' order by c.version_no desc limit 1;
  v_work := authz.can_work_purchase_task(v_task.id);
  return jsonb_build_object(
    'taskId', v_task.id,
    'changeRequest', jsonb_build_object('refNo', v_r.ref_no, 'status', v_r.status),
    'old', jsonb_build_object(
      'details', authz.cr_safe_facts(v_task.service_item_id, v_r.base_version_id),
      'ratePaise', v_cost.amount_paise::text,
      'reference', v_task.supplier_reference,
      'confirmedAt', v_task.supplier_confirmed_at),
    'new', jsonb_build_object(
      'details', authz.cr_safe_facts(v_task.service_item_id, v_x.booking_version_id),
      'changedFields', to_jsonb(authz.revision_department_fields(v_x.booking_version_id))),
    'reconfirmation', jsonb_build_object(
      'id', v_x.id, 'status', v_x.status, 'newRatePaise', v_x.new_rate_paise::text, 'supplierFeePaise', v_x.supplier_fee_paise::text,
      'newReference', v_x.new_reference, 'evidenceId', v_x.evidence_id, 'overBudget', v_x.over_budget,
      'budgetPaise', v_x.budget_paise::text, 'refusedReason', v_x.refused_reason, 'rowVersion', v_x.row_version),
    'can', jsonb_build_object(
      'record', v_work and v_x.status = 'pending' and v_r.status = 'submitted',
      -- Accounts phase 3 (20261205000690): purchase_evidence_begin accepts the proof now (same rule as 20261205000670).
      'uploadProof', v_work and v_task.status = 'supplier_confirmed' and v_x.status = 'pending' and v_r.status = 'submitted',
      'refuse', v_work and v_x.status in ('pending', 'recorded') and v_r.status = 'submitted',
      'approveOverBudget', v_x.status = 'recorded' and v_x.over_budget and v_x.over_budget_approved_by is null
                           and v_r.status = 'submitted' and v_x.recorded_by is distinct from v_uid
                           and authz.can_manage_purchase_task(v_task.id) and authz.cr_is_approver(v_r.id)));
end;
$$;

commit;
