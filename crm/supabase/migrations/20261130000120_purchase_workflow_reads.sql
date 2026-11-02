-- TripNavigate CRM - Purchase build, track A (3 of 3): reads for the hotel
-- go-ahead, supplier e-mails and trip cancellation. Schema: 20261130000100;
-- commands: 20261130000110.
--
-- Replaced (latest bodies copied; changed lines marked "Purchase build"):
--   public.purchase_workspace (20261127000100): quotes gain perRoomNightPaise
--     and note; new keys goAhead, emails, cancellation, emailSendingEnabled.
--     Same signature and jsonb return.
--   public.purchase_task_list (20261004000100): each row gains goAheadState
--     and tripCancelled.
--   public.department_task_history (20261125000100): eight more allowlisted
--     kinds (rate_request_sent, booking_request_sent, email_sent, email_failed,
--     go_ahead_requested, go_ahead_approved, go_ahead_returned,
--     cancellation_charge_saved); go_ahead_returned carries Accounts' reason
--     as its note. The app drops kinds it does not know yet.
-- New reads:
--   public.accounts_go_ahead_list()            Accounts of the entity (never a Purchase holder)
--   public.manager_cancellation_list()          branch Manager of the Deal
--   public.deal_cancellation_summary(uuid)      anyone who reads the Deal (no amounts)
--
-- Purchase reads never carry selling price, margin, receipts, funding reasons
-- or customer-side cancellation amounts. Reads write nothing.
-- Rollback (forward-only): restore the three replaced bodies and revoke the
-- new reads.

begin;
set local lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- Shapes
-- ---------------------------------------------------------------------------

create function authz.purchase_go_ahead_json(p_task uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('state', authz.purchase_go_ahead_state(p_task))
    || coalesce((
      select jsonb_build_object(
        'requestId', r.id,
        'costVersionNo', r.cost_version_no,
        'requestedAt', r.requested_at,
        'requestedByName', rp.display_name,
        'decidedAt', r.decided_at,
        'decidedByName', dp.display_name,
        'returnReason', r.return_reason)
      from public.purchase_go_ahead_requests r
      left join public.staff_profiles rp on rp.user_id = r.requested_by
      left join public.staff_profiles dp on dp.user_id = r.decided_by
      where r.task_id = p_task and r.status <> 'superseded'
      order by (r.status = 'pending') desc, r.requested_at desc, r.id desc limit 1),
      jsonb_build_object('requestId', null, 'costVersionNo', null, 'requestedAt', null, 'requestedByName', null,
        'decidedAt', null, 'decidedByName', null, 'returnReason', null))
$$;

-- Latest charge revision of one task in one cancellation (null when none).
create function authz.cancellation_charge_json(p_cancellation uuid, p_task uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'taskId', x.task_id,
    'revisionNo', x.revision_no,
    'supplierId', x.supplier_id,
    'supplierName', s.name,
    'committedCostPaise', x.committed_cost_paise::text,
    'supplierKeepsPaise', x.supplier_keeps_paise::text,
    'supplierRefundPaise', x.supplier_refund_paise::text,
    'note', x.note,
    'creditNoteEvidenceId', x.credit_note_evidence_id,
    'enteredAt', x.entered_at,
    'enteredByName', p.display_name)
  from public.purchase_cancellation_charges x
  join public.suppliers s on s.id = x.supplier_id
  left join public.staff_profiles p on p.user_id = x.entered_by
  where x.cancellation_id = p_cancellation and x.task_id = p_task
  order by x.revision_no desc limit 1
$$;

-- The trip cancellation as a Purchase task sees it (null when none).
create function authz.task_cancellation_json(p_task uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'cancellationId', c.id,
    'status', c.status,
    'reason', c.reason,
    'openedAt', c.opened_at,
    'openedByName', op.display_name,
    'rowVersion', c.row_version,
    'returnReason', c.return_reason,
    'myCharge', authz.cancellation_charge_json(c.id, t.id),
    'canEnter', c.status <> 'approved' and t.department = 'purchase'
      and authz.holds_active_role('purchase', t.legal_entity_id)
      and (t.assignee_user_id is null or t.assignee_user_id = (select auth.uid()))
      and exists (select 1 from public.purchase_cost_versions v where v.task_id = t.id),
    'canSend', c.status in ('open', 'charges_entered')
      and authz.holds_active_role('purchase', c.legal_entity_id)
      and authz.cancellation_charges_missing(c.id) = 0,
    'chargesMissing', authz.cancellation_charges_missing(c.id))
  from public.fulfilment_tasks t
  join public.deal_cancellations c on c.deal_id = t.deal_id
  left join public.staff_profiles op on op.user_id = c.opened_by
  where t.id = p_task
$$;

revoke all on function authz.purchase_go_ahead_json(uuid), authz.cancellation_charge_json(uuid, uuid),
  authz.task_cancellation_json(uuid)
from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Purchase workspace (replaces 20261127000100)
-- ---------------------------------------------------------------------------

create or replace function public.purchase_workspace(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_uid uuid := (select auth.uid());
  v_manager boolean;
  v_latest public.purchase_cost_versions;
  v_budget bigint;
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
        'uploadedByName', p.display_name) order by e.created_at, e.id)
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
    'emailSendingEnabled', authz.supplier_email_sending_enabled());
end;
$$;
revoke all on function public.purchase_workspace(uuid) from public, anon, authenticated, service_role;
grant execute on function public.purchase_workspace(uuid) to authenticated;

-- ---------------------------------------------------------------------------
-- Purchase queue (replaces 20261004000100): two flags per row
-- ---------------------------------------------------------------------------

create or replace function public.purchase_task_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(authz.purchase_task_json(t.id, false)
      -- Purchase build: computed go-ahead state and the trip cancellation flag (no amounts).
      || jsonb_build_object('goAheadState', authz.purchase_go_ahead_state(t.id),
                            'tripCancelled', authz.deal_trip_cancelled(t.deal_id))
      order by t.created_at desc, t.id)
    from public.fulfilment_tasks t
    where authz.can_read_purchase_task(t.id)
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Accounts: hotel go-ahead requests
-- ---------------------------------------------------------------------------

-- Accounts people of the request's entity who do not also hold Purchase
-- there (the authz.finance_require_accounts rule). Newest 500, pending first.
create function public.accounts_go_ahead_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if not coalesce(authz.session_ok(), false) or not exists (
       select 1 from public.memberships m
       where m.user_id = v_uid and m.status = 'active' and m.role_code = 'accounts'
         and authz.holds_active_role('accounts', m.legal_entity_id)
         and not authz.holds_role('purchase', m.legal_entity_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(x.row order by x.pending desc, x.requested_at desc, x.id desc)
    from (
      select r.id, r.requested_at, r.status = 'pending' as pending,
        jsonb_build_object(
          'requestId', r.id,
          'status', r.status,
          'current', authz.purchase_go_ahead_request_current(r.id),
          'dealId', r.deal_id,
          'dealReference', d.reference,
          'branchName', b.name,
          'taskId', r.task_id,
          'itemTitle', coalesce(tjx.tj ->> 'itemTitle', tjx.tj ->> 'hotelName', 'Hotel'),
          'checkIn', tjx.tj ->> 'checkIn',
          'checkOut', tjx.tj ->> 'checkOut',
          'supplierName', s.name,
          'amountPaise', r.amount_paise::text,
          'costVersionNo', r.cost_version_no,
          'requestedAt', r.requested_at,
          'requestedByName', rp.display_name,
          'decidedAt', r.decided_at,
          'decidedByName', dp.display_name,
          'returnReason', r.return_reason,
          'rowVersion', r.row_version,
          'bookingReviewStatus', coalesce(abr.status, 'missing'),
          'canDecide', r.status = 'pending' and r.requested_by <> v_uid
            and authz.purchase_go_ahead_request_current(r.id)
            and exists (select 1 from public.purchase_supplier_emails e
                        where e.id = r.email_id and e.status in ('sent', 'marked_sent'))
            and not authz.finance_deal_conflict(r.deal_id)
            and authz.finance_gate_issue(r.legal_entity_id, d.is_synthetic) is null) as row
      from public.purchase_go_ahead_requests r
      join public.deals d on d.id = r.deal_id
      join public.branches b on b.id = r.branch_id
      join public.purchase_quotes q on q.id = r.quote_id
      join public.suppliers s on s.id = q.supplier_id
      cross join lateral (select authz.purchase_task_json(r.task_id, false) as tj) tjx
      left join public.staff_profiles rp on rp.user_id = r.requested_by
      left join public.staff_profiles dp on dp.user_id = r.decided_by
      left join public.accounts_booking_reviews abr on abr.booking_version_id = r.booking_version_id
      where r.status <> 'superseded'
        and authz.holds_active_role('accounts', r.legal_entity_id)
        and not authz.holds_role('purchase', r.legal_entity_id)
      order by (r.status = 'pending') desc, r.requested_at desc, r.id desc
      limit 500
    ) x
  ), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Manager: trip cancellations of the Manager's branches
-- ---------------------------------------------------------------------------

create function authz.cancellation_charges_json(p_cancellation uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(authz.cancellation_charge_json(p_cancellation, t.id)
      || jsonb_build_object('itemTitle', coalesce(authz.purchase_task_json(t.id, false) ->> 'itemTitle',
                                                  authz.purchase_task_json(t.id, false) ->> 'hotelName', 'Service'))
      order by t.created_at, t.id), '[]'::jsonb)
  from public.deal_cancellations c
  join public.fulfilment_tasks t on t.deal_id = c.deal_id and t.department = 'purchase'
  where c.id = p_cancellation
    and exists (select 1 from public.purchase_cancellation_charges x where x.cancellation_id = c.id and x.task_id = t.id)
$$;
revoke all on function authz.cancellation_charges_json(uuid) from public, anon, authenticated, service_role;

create function public.manager_cancellation_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'cancellationId', c.id,
        'dealId', c.deal_id,
        'dealReference', d.reference,
        'branchName', b.name,
        'status', c.status,
        'reason', c.reason,
        'openedAt', c.opened_at,
        'openedByName', op.display_name,
        'sentAt', c.sent_at,
        'sentByName', sp.display_name,
        'decidedAt', c.decided_at,
        'decidedByName', dp.display_name,
        'returnReason', c.return_reason,
        'rowVersion', c.row_version,
        'charges', authz.cancellation_charges_json(c.id),
        'totalKeepsPaise', coalesce((select sum(cur.supplier_keeps_paise) from (
            select distinct on (x.task_id) x.supplier_keeps_paise from public.purchase_cancellation_charges x
            where x.cancellation_id = c.id order by x.task_id, x.revision_no desc) cur), 0)::text,
        'totalRefundPaise', coalesce((select sum(cur.supplier_refund_paise) from (
            select distinct on (x.task_id) x.supplier_refund_paise from public.purchase_cancellation_charges x
            where x.cancellation_id = c.id order by x.task_id, x.revision_no desc) cur), 0)::text,
        'canDecide', c.status = 'sent_to_manager' and c.sent_by is distinct from v_uid and not exists (
            select 1 from public.purchase_cancellation_charges x
            where x.cancellation_id = c.id and x.entered_by = v_uid))
        order by (c.status = 'sent_to_manager') desc, c.opened_at desc, c.id desc)
    from public.deal_cancellations c
    join public.deals d on d.id = c.deal_id
    join public.branches b on b.id = c.branch_id
    left join public.staff_profiles op on op.user_id = c.opened_by
    left join public.staff_profiles sp on sp.user_id = c.sent_by
    left join public.staff_profiles dp on dp.user_id = c.decided_by
    where authz.is_branch_sales_manager(c.deal_id)
  ), '[]'::jsonb);
end;
$$;

-- Deal page: whether the trip is cancelled, and whether this viewer (branch
-- Manager) may mark it cancelled. No amounts. Null = Deal not readable.
create function public.deal_cancellation_summary(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_manager boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_deal_id is null or not exists (select 1 from public.deals d where d.id = p_deal_id) then
    return null;
  end if;
  v_manager := authz.is_branch_sales_manager(p_deal_id);
  if not v_manager and not authz.can_read_deal(p_deal_id) then
    return null;
  end if;
  return jsonb_build_object(
    'canOpen', v_manager and not authz.deal_trip_cancelled(p_deal_id) and authz.deployment_environment() <> 'unset',
    'cancellation', (
      select jsonb_build_object(
        'cancellationId', c.id,
        'status', c.status,
        'reason', c.reason,
        'openedAt', c.opened_at,
        'openedByName', op.display_name,
        'decidedAt', case when c.status = 'approved' then c.decided_at end)
      from public.deal_cancellations c
      left join public.staff_profiles op on op.user_id = c.opened_by
      where c.deal_id = p_deal_id));
end;
$$;

-- ---------------------------------------------------------------------------
-- Task History (replaces 20261125000100): Purchase build kinds
-- ---------------------------------------------------------------------------

create or replace function public.department_task_history(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_uid uuid := (select auth.uid());
  v_events jsonb;
  v_n integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_task_id is null or not authz.can_read_task_history(p_task_id) then
    return null;
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;

  with targets (target_type, target_id) as (
    select 'fulfilment_task', p_task_id
    union all select 'purchase_evidence', e.id from public.purchase_evidence e where e.task_id = p_task_id
    union all select 'department_evidence', e.id from public.department_evidence e where e.task_id = p_task_id
    union all select 'department_cost_entry', c.id from public.department_cost_entries c where c.task_id = p_task_id
    union all select 'visa_application', a.id from public.visa_applications a where a.task_id = p_task_id
  ), kinds (action, kind) as (
    values ('fulfilment.task_created', 'created'), ('fulfilment.task_claimed', 'taken'),
           ('fulfilment.task_released', 'released'), ('fulfilment.task_reassigned', 'reassigned'),
           ('fulfilment.task_completed', 'completed'),
           ('purchase.quote_added', 'offer_added'), ('purchase.quote_withdrawn', 'offer_withdrawn'),
           ('purchase.cost_proposed', 'cost_recorded'), ('purchase.cost_over_budget_approved', 'over_budget_approved'),
           ('purchase.supplier_confirmed', 'supplier_confirmed'),
           ('purchase.evidence_stored', 'file_added'), ('purchase.evidence_removed', 'file_removed'),
           ('department.evidence_stored', 'file_added'), ('department.evidence_removed', 'file_removed'),
           ('department.cost_saved', 'cost_recorded'), ('department.cost_submitted', 'sent_to_accounts'),
           ('finance.expense_record_accepted', 'accounts_accepted'),
           ('finance.expense_record_returned', 'accounts_returned'),
           ('visa.application_updated', 'applicant_updated'),
           ('visa.application_state_changed', 'applicant_stage'),
           ('visa.application_withdrawn_by_revision', 'applicant_withdrawn'),
           -- Purchase build (20261130000120).
           ('purchase.rate_request_recorded', 'rate_request_sent'),
           ('purchase.booking_request_recorded', 'booking_request_sent'),
           ('purchase.supplier_email_sent', 'email_sent'),
           ('purchase.supplier_email_failed', 'email_failed'),
           ('purchase.go_ahead_requested', 'go_ahead_requested'),
           ('purchase.go_ahead_approved', 'go_ahead_approved'),
           ('purchase.go_ahead_returned', 'go_ahead_returned'),
           ('purchase.cancellation_charge_set', 'cancellation_charge_saved')
  ), picked as (
    select a.id, a.occurred_at, a.actor_user_id, a.action, a.reason, a.details, k.kind
    from targets t
    join public.audit_events a
      on a.target_id = t.target_id and a.target_type = t.target_type
     and a.target_type in ('fulfilment_task', 'purchase_evidence', 'department_evidence', 'department_cost_entry',
                           'visa_application')
    join kinds k on k.action = a.action
    order by a.occurred_at desc, a.id desc
    limit 201
  )
  select count(*)::integer,
         coalesce(jsonb_agg(jsonb_build_object(
           'at', p.occurred_at,
           'kind', p.kind,
           -- Names only where the task page already shows that person to its
           -- readers ("Taken by": the current assignee); yourself = byYou.
           'byName', case when p.actor_user_id is not null and p.actor_user_id = v_task.assignee_user_id then
                       (select s.display_name from public.staff_profiles s where s.user_id = p.actor_user_id) end,
           'byYou', p.actor_user_id is not null and p.actor_user_id = v_uid,
           'toName', case when p.kind = 'reassigned' and v_task.assignee_user_id is not null
                           and p.details ->> 'toUserId' = v_task.assignee_user_id::text then
                       (select s.display_name from public.staff_profiles s where s.user_id = v_task.assignee_user_id) end,
           'toYou', p.kind = 'reassigned' and p.details ->> 'toUserId' = v_uid::text,
           'applicantSeq', case when p.kind like 'applicant\_%' and jsonb_typeof(p.details -> 'seq') = 'number'
                                then p.details -> 'seq' end,
           'state', case when p.kind = 'applicant_stage' and jsonb_typeof(p.details -> 'to') = 'string'
                         then p.details ->> 'to' end,
           'note', case when p.kind in ('accounts_returned', 'applicant_withdrawn', 'go_ahead_returned') then p.reason end)
           order by p.occurred_at desc, p.id desc) filter (where p.rn <= 200), '[]'::jsonb)
  into v_n, v_events
  from (select x.*, row_number() over (order by x.occurred_at desc, x.id desc) rn from picked x) p;

  return jsonb_build_object('taskId', v_task.id, 'department', v_task.department,
    'events', v_events, 'truncated', v_n > 200);
end;
$$;



-- ---------------------------------------------------------------------------
-- Privileges (replaced functions keep their ACL)
-- ---------------------------------------------------------------------------

revoke all on function public.accounts_go_ahead_list(), public.manager_cancellation_list(),
  public.deal_cancellation_summary(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.accounts_go_ahead_list(), public.manager_cancellation_list(),
  public.deal_cancellation_summary(uuid)
to authenticated;

commit;
