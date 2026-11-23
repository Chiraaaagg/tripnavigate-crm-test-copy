-- TripNavigate CRM - Flight build, track A (round 3): Home counts without
-- double-counted flight work.
-- Contract: Flight department build contract section 9.4 (flight_home_counts
-- is the Home source for flight work; decision D12), lead round 3, 4 Nov 2026.
--
-- What changes: public.my_work_counts() (same signature, body of
-- 20261130000210) no longer adds not-taken and own in-progress flight tasks to
-- waitingForMe; Home shows them through flight_home_counts() (flightDealsNotTaken,
-- flightDealsMine). Every other key and count is unchanged. No other combined
-- count of my_work_counts includes flight tasks (requestsToApprove comes from
-- authz.sm_home_counts and keeps Track B's flight fare approvals by design).
--
-- No refusal tokens change.
-- Rollback (forward-only): a new migration restoring my_work_counts from
-- 20261130000210.

begin;
set local lock_timeout = '15s';

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
  -- Flight build (20261201000150): flight work is counted only by
  -- flight_home_counts() (its own Home rows), never in waitingForMe.

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
-- my_work_counts keeps its ACL (CREATE OR REPLACE).

commit;
