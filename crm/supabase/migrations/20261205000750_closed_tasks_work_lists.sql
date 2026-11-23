-- TripNavigate CRM - Accounts phase 3, track H (6): closed tasks out of the
-- remaining work lists; no Purchase work on a removed service.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 11.1, 11.3, 20 R12,
-- 21 LD31; Addendum L9 (lead, 13 November 2026).
--
-- Replaced (latest bodies, same signatures; changed lines marked
-- "Accounts phase 3 (20261205000750)"):
--   public.flight_queue, public.flight_task_list, public.visa_queue,
--   public.visa_task_list, public.my_work_counts, authz.sm_home_counts: every
--     task read reads open tasks only (closed_state is null). sm_home_counts
--     keeps counting a missing supplier invoice of a closed booked task
--     (money housekeeping; the supplier may still bill the charge kept).
--   authz.flight_boarding_pass_due (track A, 20261205000130): no boarding-pass
--     alert for a removed flight. public.flight_group_claim (20261201000160):
--     never assigns a closed task (Addendum L9).
--   authz.can_work_purchase_task (20261127000100): false for a closed task.
--   authz.sm_payment_create (20261205000730): the assignee of a closed task
--     still hears service_removed (checked before can_work_purchase_task).
--   public.supplier_money_evidence_begin (20261201000210): likewise for a
--     Purchase file on a closed task (checked before can_work_purchase_task).
--   authz.procurement_gate_issue: service_removed for a closed task, so every
--     Purchase command behind the gate (quote, cost, booking request,
--     evidence, documents, payments, workspace issues) refuses it.
--   public.purchase_task_claim, public.purchase_supplier_confirm (track G's
--     body): service_removed while a remove_service request names the service
--     or once it is closed. Charges for a booked removal need no claim.
-- Left to track N: notice_inbox, notices_on_cancellation.
--
-- Refusal tokens: service_removed (55000).
-- Rollback (forward-only): a NEW migration restoring the cited bodies.

begin;
set local lock_timeout = '15s';

-- Replaces 20261201000180_flight_home_links.sql:23 (latest body; changed lines marked).
create or replace function public.flight_queue() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
  -- Accounts phase 3 (20261205000750): a task closed by a service removal (LD31) is not open work;
  -- every task read below reads open tasks only.
declare
  v_uid uuid := (select auth.uid());
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return jsonb_build_object('groups', coalesce((
    select jsonb_agg(g.j order by g.first_date nulls last, g.reference, g.deal_id)
    from (
      select d.id as deal_id, d.reference, fd.first_date,
        jsonb_build_object(
          'dealId', d.id, 'dealReference', d.reference, 'branchName', b.name,
          'status', authz.flight_group_status_json(d.id),
          'assigneeName', authz.flight_staff_name(a.assignee),
          'assignedToYou', a.assignee is not distinct from v_uid and a.assignee is not null,
          'canTake', x.is_f and (a.assignee is null or a.assignee = v_uid)
                     and exists (select 1 from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
                                 where t.deal_id = d.id and t.department = 'flight' and t.status = 'not_started')
                     and not exists (select 1 from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
                                     where t.deal_id = d.id and t.department = 'flight' and t.status in ('in_progress', 'completed')
                                       and t.assignee_user_id is distinct from v_uid),
          'firstDate', to_char(fd.first_date, 'YYYY-MM-DD'),
          -- 20261201000180: the same rows flight_home_counts counts for the caller.
          'hasChangeDecision', exists (select 1 from public.flight_changes c join (select x.* from public.fulfilment_tasks x where x.closed_state is null) t on t.id = c.task_id
                                       where c.deal_id = d.id and t.assignee_user_id = v_uid
                                         and t.status in ('in_progress', 'completed')
                                         and c.status in ('approved', 'rejected') and c.flight_seen_at is null
                                         and x.is_f),
          'readyToFinish', x.is_f and exists (select 1 from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
                                              where t.deal_id = d.id and t.department = 'flight' and t.status = 'in_progress'
                                                and t.assignee_user_id = v_uid)
                           and authz.flight_can_work(d.id) and cardinality(authz.flight_done_issues(d.id)) = 0,
          'chips', jsonb_build_object(
            'bookingChanged', exists (select 1 from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t join public.flight_task_state s on s.task_id = t.id
                                      where t.deal_id = d.id and t.department = 'flight' and t.status <> 'completed'
                                        and s.basis_version_id <> authz.task_current_version(t.id)),
            'unnamed', (select coalesce(sum(authz.flight_unnamed_count(t.id)), 0)::integer from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
                        where t.deal_id = d.id and t.department = 'flight' and t.status <> 'completed'),
            'changesWaiting', (select count(*)::integer from public.flight_changes c where c.deal_id = d.id and c.status = 'pending'),
            'faresWaiting', 'fare_approval_pending' = any (m.issues),
            'paymentNeeded', 'payment_missing' = any (m.issues) or 'payment_returned' = any (m.issues)),
          -- 20261201000160 (Review F5): no amount for a branch Manager who also holds Purchase.
          'budgetPaise', case when x.is_f or (x.is_m and not authz.holds_role('purchase', d.legal_entity_id))
                              then authz.flight_group_budget(d.id)::text end,
          -- Travellers on the Deal's flights (named and not named yet).
          'travellerCount', (select coalesce(max(cardinality(authz.item_participant_seqs(t.service_item_id, authz.task_current_version(t.id)))
                                                 + authz.flight_unnamed_count(t.id)), 0)::integer
                             from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t where t.deal_id = d.id and t.department = 'flight'),
          'flights', (select jsonb_agg(jsonb_build_object(
                         'taskId', t.id, 'itemNo', i.item_no, 'title', authz.flight_task_title(t.id),
                         'route', authz.flight_route_text(t.id),
                         'firstDate', to_char(authz.flight_first_date(t.id), 'YYYY-MM-DD'),
                         'status', authz.flight_task_status_json(t.id),
                         'entryMode', coalesce(f.facts ->> 'entryMode', 'typed'))
                         order by i.item_no, t.id)
                      from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
                      join public.service_items i on i.id = t.service_item_id
                      left join public.service_item_facts f on f.service_item_id = t.service_item_id
                        and f.booking_version_id = authz.flight_display_version(t.id)
                      where t.deal_id = d.id and t.department = 'flight')) as j
      from public.deals d
      join public.branches b on b.id = d.branch_id
      cross join lateral (select authz.holds_active_role('flight', d.legal_entity_id) as is_f,
                                 authz.is_branch_sales_manager(d.id) as is_m) x
      cross join lateral (select authz.flight_group_assignee(d.id) as assignee) a
      cross join lateral (select coalesce(authz.flight_money_issues(d.id), '{}'::text[]) as issues) m
      cross join lateral (select min(authz.flight_first_date(t.id)) as first_date from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
                          where t.deal_id = d.id and t.department = 'flight') fd
      where (x.is_f or x.is_m)
        and exists (select 1 from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t where t.deal_id = d.id and t.department = 'flight')
        -- 20261201000160: no Deals removed by the sync; done groups only for 90 days after completion.
        and d.removed_at is null
        and (exists (select 1 from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
                     where t.deal_id = d.id and t.department = 'flight' and t.status <> 'completed')
             or (select max(t.completed_at) from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
                 where t.deal_id = d.id and t.department = 'flight') >= now() - interval '90 days')
    ) g), '[]'::jsonb));
end;
$$;
-- Replaces 20261118000100_b1_service_items.sql:1800 (latest body; changed lines marked).
create or replace function public.flight_task_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
  -- Accounts phase 3 (20261205000750): a task closed by a service removal (LD31) is not open work;
  -- every task read below reads open tasks only.
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(authz.flight_task_json(t.id, false) order by t.created_at desc, t.id)
    from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
    where t.department = 'flight' and authz.can_read_flight_task(t.id)
  ), '[]'::jsonb);
end;
$$;
-- Replaces 20261202000140_visa_review_fixes.sql:1132 (latest body; changed lines marked).
create or replace function public.visa_queue() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
  -- Accounts phase 3 (20261205000750): a task closed by a service removal (LD31) is not open work;
  -- every task read below reads open tasks only.
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
      from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
      join public.deals d on d.id = t.deal_id
      join public.branches b on b.id = t.branch_id
      left join public.staff_profiles ap on ap.user_id = t.assignee_user_id
      cross join lateral (select authz.visa_task_progress(t.id) as j) p
      where t.department = 'visa' and authz.can_read_visa_task(t.id)), '[]'::jsonb));
end;
$$;
-- Replaces 20261119000500_b11_department_forms.sql:544 (latest body; changed lines marked).
create or replace function public.visa_task_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
  -- Accounts phase 3 (20261205000750): a task closed by a service removal (LD31) is not open work;
  -- every task read below reads open tasks only.
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(authz.visa_task_json(t.id, false) order by t.created_at desc, t.id)
    from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
    where t.department = 'visa' and authz.can_read_visa_task(t.id)
  ), '[]'::jsonb);
end;
$$;
-- Replaces 20261201000150_flight_home_counts_split.sql:20 (latest body; changed lines marked).
create or replace function public.my_work_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
  -- Accounts phase 3 (20261205000750): a task closed by a service removal (LD31) is not open work;
  -- every task read below reads open tasks only.
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
    select count(*) into v_n from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
    where ((t.department = 'purchase' and t.status = 'not_started' and authz.can_read_purchase_task(t.id))
        or (t.status = 'in_progress' and t.assignee_user_id = v_uid and t.department = 'purchase'));
    v_waiting := v_waiting + v_n;
  end if;
  -- Flight build (20261201000150): flight work is counted only by
  -- flight_home_counts() (its own Home rows), never in waitingForMe.

  -- B1.1c Visa & Passport desk: readable not-started desk tasks plus own in-progress ones.
  if coalesce(v_visa, false) then
    select count(*) into v_visa_waiting from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
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
-- Replaces 20261201000220_flight_money_reads.sql:565 (latest body; changed lines marked).
create or replace function authz.sm_home_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
  -- Accounts phase 3 (20261205000750): a task closed by a service removal (LD31) is not open work;
  -- every task read below reads open tasks only.
declare
  v_uid uuid := (select auth.uid());
  v_manager boolean;
  v_purchase boolean;
  v_accounts boolean;
  v_flight boolean;
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
  -- Flight build (20261201000220)
  v_m_fares integer;
  v_f_returned integer;
  v_f_missing integer;
begin
  select
    bool_or(m.role_code = 'manager' and authz.holds_active_role('manager', m.legal_entity_id)),
    bool_or(m.role_code = 'purchase' and authz.holds_active_role('purchase', m.legal_entity_id)),
    bool_or(m.role_code = 'accounts' and authz.holds_active_role('accounts', m.legal_entity_id)
            and not authz.holds_role('purchase', m.legal_entity_id)),
    bool_or(m.role_code = 'flight' and authz.holds_active_role('flight', m.legal_entity_id))
  into v_manager, v_purchase, v_accounts, v_flight
  from public.memberships m where m.user_id = v_uid and m.status = 'active';

  -- Purchase: own tasks and own requests.
  if coalesce(v_purchase, false) then
    select count(*) into v_p_not_taken from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
    where t.department = 'purchase' and t.status = 'not_started' and authz.can_read_purchase_task(t.id);
    select count(*) filter (where authz.purchase_go_ahead_state(t.id) = 'pending'),
           count(*) filter (where c.id is not null and c.stage = 'proposed'
                              and (authz.task_budget(t.id) is null or c.amount_paise > authz.task_budget(t.id))
                              and not authz.cost_version_approved(t.id, c.version_no))
    into v_p_go_ahead, v_p_costs
    from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
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
    select count(*) into v_m_fares from authz.flight_manager_fare_rows() r where r.can_approve;
    select
      (select count(*) from authz.sm_manager_cost_rows() r where r.created_by <> v_uid)
      + (select count(*) from public.supplier_payment_requests p
         where p.route = 'manager' and p.status = 'pending' and p.requested_by <> v_uid
           and authz.is_branch_sales_manager(p.deal_id) and not authz.holds_role('purchase', p.legal_entity_id)
           and not authz.finance_deal_conflict(p.deal_id)
           and not (p.flight_batch_id is not null and authz.flight_is_deal_assignee(p.deal_id)))
      + (select count(*) from public.company_funding_requests f
         join public.supplier_payment_requests p on p.id = f.payment_request_id
         where f.route = 'manager' and f.status = 'pending' and f.requested_by <> v_uid
           and p.status not in ('returned', 'cancelled') and authz.is_branch_sales_manager(f.deal_id)
           and not authz.holds_role('purchase', f.legal_entity_id) and not authz.finance_deal_conflict(f.deal_id))
      + (select count(*) from authz.sm_manager_bank_rows() r where r.created_by <> v_uid)
      + (select count(*) from authz.sm_manager_supplier_rows() r where r.can_verify)
      + (select count(*) from jsonb_array_elements(authz.sm_manager_cancellations_json()) c
         where (c ->> 'canDecide')::boolean)
      + v_m_fares
    into v_m_approvals;
    v_requests := coalesce(v_requests, 0) + v_m_approvals;
  end if;

  -- Flight: batches of the caller's own flight tasks (nothing to pay = paid).
  -- A request still waiting for approval needs nothing from Flight: not counted.
  if coalesce(v_flight, false) then
    select count(*) filter (where x.state in ('direct_returned', 'request_returned')),
           count(*) filter (where x.state in ('unpaid', 'request_cancelled'))
    into v_f_returned, v_f_missing
    from public.flight_ticket_batches b
    join (select x.* from public.fulfilment_tasks x where x.closed_state is null) t on t.id = b.cost_task_id
    cross join lateral authz.flight_batch_payment(b.id) x
    where t.assignee_user_id = v_uid and t.status in ('in_progress', 'completed')
      and authz.holds_active_role('flight', t.legal_entity_id)
      and b.supplier_cost_paise > 0 and not x.paid;
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
    'managerApprovals', v_m_approvals,
    'flightFaresToApprove', v_m_fares,
    'flightPaymentsReturned', v_f_returned,
    'flightPaymentsMissing', v_f_missing);
end;
$$;
-- Replaces 20261205000130_customer_message_triggers.sql:226 (latest body; changed lines marked).
create or replace function authz.flight_boarding_pass_due() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
  -- Accounts phase 3 (20261205000750): a task closed by a service removal (LD31) is not open work;
  -- every task read below reads open tasks only.
declare
  v_n integer;
  v_today date := authz.finance_today();
begin
  insert into public.flight_boarding_pass_alerts (legal_entity_id, branch_id, deal_id, task_id, sector_id, departure_date)
  select s.legal_entity_id, s.branch_id, s.deal_id, s.task_id, s.id, s.depart_date
  from public.flight_sectors s
  join (select x.* from public.fulfilment_tasks x where x.closed_state is null) t on t.id = s.task_id and t.department = 'flight'
  cross join lateral (
    select max(b.confirmed_at) as last_batch from public.flight_ticket_batches b
    where b.cost_task_id = t.id
       or exists (select 1 from public.flight_sectors s2 where s2.task_id = t.id and s2.id = any (b.sector_ids))) lb
  where s.status = 'active'
    and s.depart_date between v_today and v_today + 1
    and ((s.depart_date + coalesce(s.depart_time, '00:00')::time) at time zone 'Asia/Kolkata')
        between now() - interval '1 hour' and now() + interval '24 hours'
    and lb.last_batch is not null
    and not authz.deal_trip_cancelled(s.deal_id)
    and not exists (select 1 from public.department_evidence e
                    where e.task_id = t.id and e.kind = 'boarding_pass' and e.status = 'stored' and e.stored_at > lb.last_batch)
  on conflict (task_id, sector_id, departure_date) do nothing;
  get diagnostics v_n = row_count;
  return jsonb_build_object('alerts', v_n);
end;
$$;
-- Replaces 20261201000160_flight_review_fixes.sql:59 (latest body; changed lines marked).
create or replace function public.flight_group_claim(p_deal_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
  -- Accounts phase 3 (20261205000750): a task closed by a service removal (LD31) is not open work;
  -- every task read below reads open tasks only.
declare
  v_deal public.deals%rowtype;
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_ids uuid[];
  v_claimed uuid[] := '{}'::uuid[];
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id);
  v_replay jsonb;
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null or not authz.holds_active_role('flight', v_deal.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.flight_refuse_gate(p_deal_id);
  v_replay := authz.flight_replay(v_deal.legal_entity_id, p_request_id, 'flight_group_claim', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  perform authz.flight_lock_group(p_deal_id);
  -- 20261201000160: a duplicate that raced the first call returns its stored result.
  v_replay := authz.flight_replay(v_deal.legal_entity_id, p_request_id, 'flight_group_claim', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  select array_agg(t.id order by i.item_no, t.id) into v_ids
  from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t join public.service_items i on i.id = t.service_item_id
  where t.deal_id = p_deal_id and t.department = 'flight';
  if v_ids is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if exists (select 1 from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
             where t.deal_id = p_deal_id and t.department = 'flight' and t.status in ('in_progress', 'completed')
               and t.assignee_user_id is distinct from v_uid) then
    raise exception 'task_conflict' using errcode = '40001';
  end if;

  for v_task in
    select t.* from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t join public.service_items i on i.id = t.service_item_id
    where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'not_started'
    order by i.item_no, t.id
  loop
    update public.fulfilment_tasks t set assignee_user_id = v_uid, status = 'in_progress', updated_at = now()
    where t.id = v_task.id;
    v_claimed := v_claimed || v_task.id;
    perform authz.write_audit('fulfilment.task_claimed', v_task.legal_entity_id, v_task.branch_id,
      'fulfilment_task', v_task.id, null,
      jsonb_build_object('dealId', v_task.deal_id, 'versionId', authz.task_current_version(v_task.id),
        'serviceItemId', v_task.service_item_id, 'department', 'flight', 'group', true));
  end loop;

  -- Every task of the caller without a state (claimed now, or earlier with the
  -- old per-task command) gets its itinerary from its current version.
  for v_task in
    select t.* from (select x.* from public.fulfilment_tasks x where x.closed_state is null) t
    where t.deal_id = p_deal_id and t.department = 'flight' and t.status = 'in_progress' and t.assignee_user_id = v_uid
      and not exists (select 1 from public.flight_task_state s where s.task_id = t.id)
  loop
    insert into public.flight_task_state (task_id, legal_entity_id, deal_id, service_item_id, basis_version_id, built_by)
    values (v_task.id, v_task.legal_entity_id, v_task.deal_id, v_task.service_item_id,
            authz.task_current_version(v_task.id), v_uid);
    perform authz.flight_build_sectors(v_task.id);
  end loop;

  if cardinality(v_claimed) > 0 then
    insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
    values (p_deal_id, v_deal.legal_entity_id, v_uid, 'flight', v_uid)
    on conflict (deal_id, user_id, assignment_kind) where ended_at is null do nothing;
    perform authz.write_audit('flight.group_claimed', v_deal.legal_entity_id, v_deal.branch_id,
      'fulfilment_task', v_ids[1], null, jsonb_build_object('dealId', p_deal_id, 'taskIds', to_jsonb(v_claimed)));
  end if;

  v_result := jsonb_build_object('dealId', p_deal_id, 'taskIds', to_jsonb(v_ids), 'claimedTaskIds', to_jsonb(v_claimed),
    'outcome', case when cardinality(v_claimed) = 0 then 'existing' else 'created' end);
  return authz.flight_remember(v_deal.legal_entity_id, p_request_id, 'flight_group_claim', v_payload, v_result);
end;
$$;
-- Replaces 20261107000300_removed_deal_work_pause.sql:88 (latest body; changed lines marked).
create or replace function authz.procurement_gate_issue(p_task uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when authz.deployment_environment() = 'unset' then 'environment_unset'
    -- Stage 0: a Deal removed by the Bitrix sync takes no new purchase work.
    when d.removed_at is not null then 'deal_removed'
    -- Accounts phase 3 (20261205000750): a removed service takes no new purchase work (11.1).
    when t.closed_state is not null then 'service_removed'
    when not d.is_synthetic
      and not coalesce((select s.live_supplier_confirmation_enabled from public.procurement_settings s where s.id), false)
      then 'procurement_disabled'
    when d.is_synthetic and authz.deployment_environment() <> 'test' then 'procurement_disabled'
    else null
  end
  from public.fulfilment_tasks t join public.deals d on d.id = t.deal_id
  where t.id = p_task
$$;
-- Replaces 20261127000100_purchase_department_check.sql:93 (latest body; changed lines marked).
create or replace function authz.can_work_purchase_task(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task
      and t.department = 'purchase'
      and t.closed_state is null  -- Accounts phase 3 (20261205000750): a removed service is not Purchase work
      and t.assignee_user_id = (select auth.uid())
      and authz.holds_active_role('purchase', t.legal_entity_id)
  )
$$;
-- Replaces 20261205000730_service_removal_charges.sql:369 (latest body; changed lines marked).
create or replace function authz.sm_payment_create(p_task_id uuid, p_fields jsonb, p_request_id uuid, p_resubmits uuid, p_command text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_old public.supplier_payment_requests%rowtype;
  v_cost public.purchase_cost_versions;
  v_supplier uuid;
  v_quote_status text;
  v_gate text;
  v_payload jsonb;
  v_result jsonb;
  v_part text;
  v_amount bigint;
  v_due date;
  v_note text;
  v_proforma uuid;
  v_reason text;
  v_expected integer;
  v_budget bigint;
  v_live bigint;
  v_available bigint;
  v_funding bigint;
  v_route text;
  v_funding_route text;
  v_go_ahead uuid;
  v_id uuid := gen_random_uuid();
  v_ref text;
begin
  -- Flight build (20261201000210): flight tasks pay per ticket batch.
  if exists (select 1 from public.fulfilment_tasks t where t.id = p_task_id and t.department = 'flight') then
    -- Accounts phase 3 (20261205000730): a removed Flight service takes no new payment.
    if exists (select 1 from public.fulfilment_tasks t where t.id = p_task_id and t.closed_state is not null)
       and authz.flight_owns_task(p_task_id) then
      raise exception 'service_removed' using errcode = '55000';
    end if;
    return authz.sm_payment_create_flight(p_task_id, p_fields, p_request_id, p_resubmits, p_command);
  end if;

  -- 1. Who: the assignee of this Purchase task (unlocked read, then locks).
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  -- Accounts phase 3 (20261205000750): its assignee hears service_removed (can_work_purchase_task
  -- is false for a closed task, so this is checked first).
  if v_task.closed_state is not null and v_task.department = 'purchase' and v_task.assignee_user_id = (select auth.uid())
     and authz.holds_active_role('purchase', v_task.legal_entity_id) then
    raise exception 'service_removed' using errcode = '55000';
  end if;
  if v_task.id is null or v_task.department is distinct from 'purchase' or not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.finance_lock_deal(v_task.deal_id);
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  -- Wait for an in-flight removal of the Deal so the gate reads its result.
  perform 1 from public.deals d where d.id = v_task.deal_id for key share;
  if not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Accounts phase 3 (20261205000730): a removed service takes no new payment (11.1); one
  -- being removed waits until the removal is settled.
  if v_task.closed_state is not null then
    raise exception 'service_removed' using errcode = '55000';
  end if;
  if exists (select 1 from public.booking_change_requests r
             where r.deal_id = v_task.deal_id and r.kind = 'remove_service' and v_task.service_item_id = any (r.item_ids)
               and r.status in ('requested', 'returned', 'approved', 'submitted')) then
    raise exception 'change_in_progress' using errcode = '55000';
  end if;
  v_gate := authz.procurement_gate_issue(v_task.id);
  if v_gate is not null then
    raise exception '%', v_gate using errcode = '55000';
  end if;

  v_payload := jsonb_build_object('taskId', p_task_id, 'resubmitsId', p_resubmits, 'fields', p_fields);
  v_result := authz.sm_replay(v_task.legal_entity_id, p_request_id, p_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;

  -- 2. Input.
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['expectedCostVersionNo', 'part', 'amountPaise', 'dueDate', 'note', 'proformaEvidenceId',
                          'askFunding', 'fundingReason']) <> '{}'::jsonb
     or jsonb_typeof(p_fields -> 'expectedCostVersionNo') is distinct from 'number'
     or (p_fields ->> 'expectedCostVersionNo') !~ '^[0-9]{1,9}$'
     or (p_fields ? 'askFunding' and jsonb_typeof(p_fields -> 'askFunding') not in ('boolean', 'null')) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_expected := (p_fields ->> 'expectedCostVersionNo')::integer;
  v_part := authz.finance_field(p_fields, 'part');
  v_amount := authz.finance_paise(p_fields, 'amountPaise', 1);
  v_due := authz.finance_date(authz.finance_field(p_fields, 'dueDate'));
  v_note := authz.finance_text(authz.finance_field(p_fields, 'note'), 1, 500, true);
  v_proforma := authz.finance_uuid(authz.finance_field(p_fields, 'proformaEvidenceId'));
  -- Optional note for Accounts (10-500), stored as the company funding
  -- reason only when funding is needed. askFunding is accepted and ignored
  -- (earlier clients): Purchase gets no customer money signal at all.
  v_reason := authz.finance_text(authz.finance_field(p_fields, 'fundingReason'), 10, 500, true);
  if v_part is null or v_part not in ('deposit', 'balance', 'full') or v_amount is null
     or v_amount > 999999999999999 or v_proforma is null
     or (v_due is not null and v_due not between date '2000-01-01' and date '2100-12-31') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  -- 3. The returned request being sent again.
  if p_resubmits is not null then
    select * into v_old from public.supplier_payment_requests p where p.id = p_resubmits for update;
    if v_old.id is null or v_old.task_id <> v_task.id then
      raise exception 'invalid_input' using errcode = '22023';
    end if;
    if v_old.status <> 'returned'
       or exists (select 1 from public.supplier_payment_requests p where p.resubmits_id = v_old.id) then
      raise exception 'already_decided' using errcode = '55000';
    end if;
  end if;

  -- 4. Business checks, in contract order.
  if authz.deal_trip_cancelled(v_task.deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  -- Accounts phase 3 (20261205000640): a change waiting for this supplier
  -- (pending or recorded reconfirmation) takes no new payment request.
  if exists (select 1 from public.task_reconfirmations x
             where x.task_id = v_task.id and x.status in ('pending', 'recorded')) then
    raise exception 'change_in_progress' using errcode = '55000';
  end if;
  v_cost := authz.purchase_agreed_cost(v_task.id);
  if v_cost.id is null then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if v_expected is distinct from v_cost.version_no then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  select q.supplier_id, q.status into v_supplier, v_quote_status
  from public.purchase_quotes q where q.id = v_cost.quote_id;
  if v_part in ('balance', 'full') and not authz.sm_task_confirmed(v_task.status) then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if not authz.sm_task_confirmed(v_task.status) then
    if v_quote_status is distinct from 'open' then
      raise exception 'not_ready' using errcode = '55000';
    end if;
    v_budget := authz.task_budget(v_task.id);
    if (v_budget is null or v_cost.amount_paise > v_budget)
       and not authz.cost_version_approved(v_task.id, v_cost.version_no) then
      raise exception 'over_budget' using errcode = '55000';
    end if;
    if authz.purchase_go_ahead_needed(v_task.id) then
      -- The booking request e-mail must have gone (sent or marked sent), not
      -- merely be queued or failed.
      if not authz.purchase_booking_request_sent(v_task.id) then
        raise exception 'booking_request_not_sent' using errcode = '55000';
      end if;
      if not authz.purchase_go_ahead_valid(v_task.id) then
        raise exception 'go_ahead_missing' using errcode = '55000';
      end if;
    end if;
  end if;
  if not exists (select 1 from public.supplier_money_evidence e
                 where e.id = v_proforma and e.task_id = v_task.id and e.kind = 'proforma' and e.status = 'stored') then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  select coalesce(sum(p.amount_paise), 0) into v_live from public.supplier_payment_requests p
  where p.task_id = v_task.id and p.status in ('pending', 'approved', 'paid', 'verified');
  if v_live + v_amount > v_cost.amount_paise then
    raise exception 'over_agreed_cost' using errcode = '55000';
  end if;
  -- Customer money (lead decision, review F1): Purchase gets no signal and
  -- no refusal. When the Deal's available customer money does not cover the
  -- amount, the company funding request for the difference is created here
  -- automatically; nothing in the reply depends on it.
  v_available := greatest(authz.sm_customer_money_available(v_task.deal_id, null), 0);
  v_funding := greatest(v_amount - v_available, 0);

  -- 5. Route: every live request for this supplier on this Deal, this one included.
  v_route := authz.sm_route(authz.sm_supplier_running_total(v_task.deal_id, v_supplier) + v_amount);
  select g.id into v_go_ahead from public.purchase_go_ahead_requests g
  where g.task_id = v_task.id and g.status = 'approved'
  order by g.decided_at desc nulls last, g.requested_at desc limit 1;

  v_ref := authz.sm_next_ref(v_task.legal_entity_id);
  insert into public.supplier_payment_requests (id, legal_entity_id, branch_id, deal_id, task_id, supplier_id, ref_no,
    cost_version_no, go_ahead_request_id, part, amount_paise, customer_money_paise, due_date, note,
    proforma_evidence_id, route, resubmits_id, request_id, requested_by)
  values (v_id, v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, v_supplier, v_ref,
    v_cost.version_no, v_go_ahead, v_part, v_amount, v_amount - v_funding, v_due, v_note,
    v_proforma, v_route, p_resubmits, p_request_id, v_uid);

  if v_funding > 0 then
    v_funding_route := authz.sm_route(authz.sm_funding_running_total(v_task.deal_id) + v_funding);
    insert into public.company_funding_requests (legal_entity_id, branch_id, deal_id, payment_request_id, amount_paise,
      reason, route, requested_by)
    values (v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_id, v_funding,
      coalesce(v_reason, 'No note from Purchase'), v_funding_route, v_uid);
  end if;

  perform authz.write_audit(case when p_resubmits is null then 'purchase.payment_requested' else 'purchase.payment_resubmitted' end,
    v_task.legal_entity_id, v_task.branch_id, 'fulfilment_task', v_task.id, null,
    jsonb_build_object('paymentRequestId', v_id, 'refNo', v_ref, 'part', v_part, 'route', v_route,
      'costVersionNo', v_cost.version_no, 'resubmitsId', p_resubmits));

  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'refNo', v_ref, 'route', v_route,
    'status', 'pending');
  return authz.sm_remember(v_task.legal_entity_id, p_request_id, p_command, v_payload, v_result);
end;
$$;
-- Replaces 20261201000210_flight_money_commands.sql:1060 (latest body; changed lines marked).
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
    if v_task.closed_state is not null and v_task.department = 'purchase' and v_task.assignee_user_id = (select auth.uid())
       and authz.holds_active_role('purchase', v_task.legal_entity_id) then
      raise exception 'service_removed' using errcode = '55000';
    end if;
    if v_task.id is null or v_task.department is distinct from 'purchase'
       or not authz.holds_active_role('purchase', v_task.legal_entity_id)
       or (p_kind = 'proforma' and not authz.can_work_purchase_task(v_task.id)) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    v_gate := authz.procurement_gate_issue(v_task.id);
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
-- Replaces 20261004000100_booking_purchase_task.sql:1270 (latest body; changed lines marked).
create or replace function public.purchase_task_claim(p_task_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_uid uuid := (select auth.uid());
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or not authz.can_claim_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Accounts phase 3 (20261205000750): a service removed, or being removed, is not taken (11.1, 11.3).
  if exists (select 1 from public.fulfilment_tasks t2 where t2.id = v_task.id and (t2.closed_state is not null or exists (
         select 1 from public.booking_change_requests r
         where r.deal_id = t2.deal_id and r.kind = 'remove_service' and t2.service_item_id = any (r.item_ids)
           and r.status in ('requested', 'returned', 'approved', 'submitted')))) then
    raise exception 'service_removed' using errcode = '55000';
  end if;
  if v_task.assignee_user_id = v_uid then
    return jsonb_build_object('taskId', v_task.id, 'status', v_task.status, 'assignedToYou', true,
      'alreadyYours', true);
  end if;
  if v_task.assignee_user_id is not null then
    raise exception 'task_conflict' using errcode = '40001';
  end if;

  update public.fulfilment_tasks t
  set assignee_user_id = v_uid, status = 'in_progress', updated_at = now()
  where t.id = v_task.id;
  insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
  values (v_task.deal_id, v_task.legal_entity_id, v_uid, 'purchase', v_uid)
  on conflict (deal_id, user_id, assignment_kind) where ended_at is null do nothing;

  perform authz.write_audit('fulfilment.task_claimed', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('dealId', v_task.deal_id, 'versionId', v_task.booking_version_id));
  return jsonb_build_object('taskId', v_task.id, 'status', 'in_progress', 'assignedToYou', true,
    'alreadyYours', false);
end;
$$;
-- Replaces 20261205000630_change_apply.sql:418 (latest body; changed lines marked).
create or replace function public.purchase_supplier_confirm(p_task_id uuid, p_expected_version_no integer, p_reference text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_cost public.purchase_cost_versions;
  v_proposal public.purchase_cost_versions;
  v_ref text := btrim(coalesce(p_reference, ''));
  v_issues text[];
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Stage 0: wait for an in-flight removal of the Deal (it holds FOR UPDATE)
  -- so the gate below reads its committed result.
  perform 1 from public.deals d where d.id = v_task.deal_id for key share;
  -- The first confirmation already stores its identity in immutable cost history.
  -- The committed version is NEW: retries must name the accepted PROPOSED
  -- version, not the current committed version. That proposal also fixes the offer.
  if v_task.status = 'supplier_confirmed' then
    v_cost := authz.purchase_latest_cost(v_task.id);
    select * into v_proposal from public.purchase_cost_versions c
      where c.task_id = v_task.id and c.version_no = p_expected_version_no;
    if v_task.supplier_reference = v_ref
       and v_cost.stage = 'committed'
       and p_expected_version_no = v_cost.version_no - 1
       and v_proposal.stage = 'proposed'
       and v_proposal.quote_id = v_cost.quote_id
       and v_proposal.quote_id = v_task.selected_quote_id then
      return jsonb_build_object('outcome', 'existing', 'taskId', v_task.id);
    end if;
    raise exception 'task_conflict' using errcode = '40001';
  end if;
  -- Accounts phase 3 (20261205000750): a service removed, or being removed, is not confirmed (11.1, 11.3).
  if exists (select 1 from public.fulfilment_tasks t2 where t2.id = v_task.id and (t2.closed_state is not null or exists (
         select 1 from public.booking_change_requests r
         where r.deal_id = t2.deal_id and r.kind = 'remove_service' and t2.service_item_id = any (r.item_ids)
           and r.status in ('requested', 'returned', 'approved', 'submitted')))) then
    raise exception 'service_removed' using errcode = '55000';
  end if;
  if length(v_ref) not between 1 and 120 or v_ref ~ E'[\\x01-\\x1f\\x7f]' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_cost := authz.purchase_latest_cost(v_task.id);
  if v_cost.id is not null and p_expected_version_no is distinct from v_cost.version_no then
    raise exception 'version_changed' using errcode = '40001';
  end if;

  v_issues := authz.procurement_issues(v_task.id);
  if 'environment_unset' = any (v_issues) then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  -- Stage 0: a Deal removed by the Bitrix sync takes no new commitment.
  if 'deal_removed' = any (v_issues) then
    raise exception 'deal_removed' using errcode = '55000';
  end if;
  if 'procurement_disabled' = any (v_issues) then
    raise exception 'procurement_disabled' using errcode = '55000';
  end if;
  -- Purchase build: a cancelled trip takes no new commitment.
  if 'trip_cancelled' = any (v_issues) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  if v_issues = array['over_budget'] then
    raise exception 'over_budget' using errcode = '55000';
  end if;
  -- Purchase build: when only the booking request or the Accounts go-ahead is
  -- missing, name it (booking request first: it starts the go-ahead).
  if cardinality(v_issues) > 0 and v_issues <@ array['booking_request_not_sent', 'go_ahead_missing'] then
    if 'booking_request_not_sent' = any (v_issues) then
      raise exception 'booking_request_not_sent' using errcode = '55000';
    end if;
    raise exception 'go_ahead_missing' using errcode = '55000';
  end if;
  if cardinality(v_issues) > 0 then
    raise exception 'not_ready' using errcode = '55000';
  end if;

  insert into public.purchase_cost_versions (task_id, legal_entity_id, version_no, quote_id, request_id, stage,
    amount_paise, due_date, note, created_by)
  values (v_task.id, v_task.legal_entity_id, v_cost.version_no + 1, v_cost.quote_id, gen_random_uuid(), 'committed',
    v_cost.amount_paise, v_cost.due_date, v_cost.note, (select auth.uid()));
  update public.purchase_quotes q set status = 'selected', updated_at = now() where q.id = v_cost.quote_id;
  update public.fulfilment_tasks t
  set status = 'supplier_confirmed', selected_quote_id = v_cost.quote_id, supplier_reference = v_ref,
      supplier_confirmed_by = (select auth.uid()), supplier_confirmed_at = now(), updated_at = now()
  where t.id = v_task.id;
  -- Accounts phase 3 (20261205000630): confirmation 1 of the task's history.
  insert into public.task_confirmations (legal_entity_id, task_id, confirmation_no, quote_id, committed_version_no, amount_paise,
    supplier_reference, evidence_ids, booking_version_id, confirmed_by, confirmed_at)
  values (v_task.legal_entity_id, v_task.id, 1, v_cost.quote_id, v_cost.version_no + 1, v_cost.amount_paise, v_ref,
    coalesce((select array_agg(e.id order by e.created_at, e.id) from public.purchase_evidence e
              where e.task_id = v_task.id and e.kind = 'supplier_confirmation' and e.status = 'stored'), '{}'::uuid[]),
    authz.task_current_version(v_task.id), (select auth.uid()), now())
  on conflict (task_id, confirmation_no) do nothing;

  insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
  values (v_task.legal_entity_id, 'fulfilment_task', v_task.id, 'fulfilment.supplier_confirmed',
    jsonb_build_object('task_id', v_task.id, 'deal_id', v_task.deal_id, 'service_purpose', v_task.service_purpose))
  on conflict (event_type, aggregate_id) do nothing;

  perform authz.write_audit('purchase.supplier_confirmed', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('quoteId', v_cost.quote_id, 'committedVersionNo', v_cost.version_no + 1));
  return jsonb_build_object('outcome', 'created', 'taskId', v_task.id);
end;
$$;

commit;
