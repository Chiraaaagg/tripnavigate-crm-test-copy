-- TripNavigate CRM - Direction A Batch 1, item B1-3: Home work lists (the rows
-- behind the Home counts that have no list today).
--
-- Contract: docs/implementation/frontend-redesign-2026-10-15/batch-1-backend-contract.md
-- item B1-3 with the Echo ruling M4 (my_work_counts gains draftsToContinue).
--
-- What changes:
--   1. public.my_work_counts() is replaced. The body is the LATEST definition
--      (20261119000500_b11_department_forms.sql) copied unchanged except the
--      lines marked "Batch 1 B1-3": one new key, draftsToContinue = the booking
--      drafts the caller may edit on Deals not removed by the sync (null when
--      the caller holds no active Sales or Manager role). Every existing key
--      keeps its value and meaning; waitingForMe stays the combined number.
--      Same signature and grants (create or replace keeps them).
--   2. New read public.my_work_list(p_kind, p_after, p_limit), definer, stable:
--        drafts           booking drafts the caller may edit (= draftsToContinue)
--        missing_details  the drafts among them with booking issues
--        returned         Deals whose confirmed version Accounts returned
--                         (= returnedToMe)
--        needs_booking    Bitrix Deals in the trigger stage with no booking
--                         version, only while workflow_settings.intake_prompt_enabled
--                         (= intakeNeeded)
--      Predicates are copied from my_work_counts. Removed Deals never appear
--      (the drafts kinds also test removed_at explicitly; the existing keys
--      already leave such drafts out because they are no longer editable).
--
-- Callers without an active Sales or Manager role get {applies: false} and no
-- rows. needs_booking while the prompt switch is off answers
-- {applies: true, available: false, reason: 'switched_off'}.
--
-- Row allowlist: dealId, reference, title, branchId, versionNo (draft kinds),
-- since. No money, contact, billing, traveller, return reason or staff identity.
-- Keyset pagination on (since desc, dealId asc); p_limit 1-50 (default 20);
-- reply {applies, available, rows, hasMore, next}; next = {since, dealId} of the
-- last row when hasMore. No total: the screen shows the existing count.
--
-- Refusal tokens: 42501 not_authorized; 22023 invalid_input (hint kind, limit
-- or after).
--
-- Reads write nothing. Rollback (forward-only): a new migration restoring the
-- previous my_work_counts body and revoking execute on my_work_list.
--
-- Apply history: this file has run only on disposable local and CI stacks.
-- It was amended in place on 19 October 2026 after the Echo-A review
-- (echo-redesign-batch1-data.md: M1, L1-L3, L5, L7) before any kept or live
-- database applied it.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. my_work_counts (replaces 20261119000500; lines marked "Batch 1 B1-3")
-- ===========================================================================

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

  if coalesce(v_manager, false) then
    v_requests := 0; -- B3
  end if;

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
    'draftsToContinue', v_drafts);
end;
$$;

-- ===========================================================================
-- 2. my_work_list
-- ===========================================================================

create function public.my_work_list(p_kind text, p_after jsonb, p_limit integer) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_sales boolean;
  v_manager boolean;
  v_limit integer := coalesce(p_limit, 20);
  v_after_since timestamptz;
  v_after_deal uuid;
  v_page jsonb;
  v_n integer;
  v_last jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('drafts', 'missing_details', 'returned', 'needs_booking') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  if v_limit not between 1 and 50 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'limit';
  end if;
  if p_after is not null and jsonb_typeof(p_after) <> 'null' then
    begin
      if jsonb_typeof(p_after) <> 'object' or jsonb_typeof(p_after -> 'since') is distinct from 'string'
         or jsonb_typeof(p_after -> 'dealId') is distinct from 'string'
         or exists (select 1 from jsonb_object_keys(p_after) k where k not in ('since', 'dealId')) then
        raise exception 'bad cursor';
      end if;
      v_after_since := (p_after ->> 'since')::timestamptz;
      v_after_deal := (p_after ->> 'dealId')::uuid;
    exception when others then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end;
  end if;

  -- The same role booleans as my_work_counts.
  select
    bool_or(m.role_code = 'sales' and authz.holds_active_role('sales', m.legal_entity_id)),
    bool_or(m.role_code = 'manager' and authz.holds_active_role('manager', m.legal_entity_id))
  into v_sales, v_manager
  from public.memberships m where m.user_id = v_uid and m.status = 'active';
  if not (coalesce(v_sales, false) or coalesce(v_manager, false)) then
    return jsonb_build_object('applies', false);
  end if;

  if p_kind in ('drafts', 'missing_details') then
    select coalesce(jsonb_agg(jsonb_build_object('dealId', r.deal_id, 'versionNo', r.version_no, 'since', r.since)
                              order by r.since desc, r.deal_id), '[]'::jsonb)
    into v_page
    from (
      select v.deal_id, v.version_no, v.updated_at as since
      from public.booking_versions v
      join public.deals d on d.id = v.deal_id
      where v.status = 'draft' and d.removed_at is null
        and (v_after_since is null or v.updated_at < v_after_since
             or (v.updated_at = v_after_since and v.deal_id > v_after_deal))
        and authz.can_edit_booking_draft(v.deal_id)
        and (p_kind = 'drafts' or cardinality(authz.booking_issues(v.id)) > 0)
      order by v.updated_at desc, v.deal_id
      limit v_limit + 1
    ) r;
  elsif p_kind = 'returned' then
    select coalesce(jsonb_agg(jsonb_build_object('dealId', r.deal_id, 'since', r.since)
                              order by r.since desc, r.deal_id), '[]'::jsonb)
    into v_page
    from (
      select x.deal_id, x.since from (
        select d.id as deal_id, max(coalesce(rv.reviewed_at, rv.updated_at)) as since
        from public.deals d
        join public.booking_versions v on v.deal_id = d.id and v.status = 'confirmed'
        join public.accounts_booking_reviews rv on rv.booking_version_id = v.id and rv.status = 'returned'
        where d.removed_at is null
          and ((d.owner_user_id = v_uid and authz.holds_active_role('sales', d.legal_entity_id))
               or authz.is_branch_sales_manager(d.id))
        group by d.id
      ) x
      where v_after_since is null or x.since < v_after_since or (x.since = v_after_since and x.deal_id > v_after_deal)
      order by x.since desc, x.deal_id
      limit v_limit + 1
    ) r;
  else
    if not coalesce((select s.intake_prompt_enabled from public.workflow_settings s where s.id), false) then
      return jsonb_build_object('applies', true, 'available', false, 'reason', 'switched_off');
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('dealId', r.deal_id, 'since', r.since)
                              order by r.since desc, r.deal_id), '[]'::jsonb)
    into v_page
    from (
      select d.id as deal_id, coalesce(d.source_modified_at, d.created_at) as since
      from public.deals d
      where d.source_system = 'bitrix' and d.removed_at is null
        and authz.deal_in_trigger_stage(d.id)
        and not exists (select 1 from public.booking_versions v where v.deal_id = d.id)
        and ((d.owner_user_id = v_uid and authz.holds_active_role('sales', d.legal_entity_id))
             or authz.is_branch_sales_manager(d.id))
        and (v_after_since is null or coalesce(d.source_modified_at, d.created_at) < v_after_since
             or (coalesce(d.source_modified_at, d.created_at) = v_after_since and d.id > v_after_deal))
      order by coalesce(d.source_modified_at, d.created_at) desc, d.id
      limit v_limit + 1
    ) r;
  end if;

  v_n := jsonb_array_length(v_page);
  if v_n > v_limit then
    v_last := v_page -> (v_limit - 1);
  end if;
  return jsonb_build_object(
    'applies', true,
    'available', true,
    'rows', coalesce((
      select jsonb_agg(
               jsonb_build_object('dealId', d.id, 'reference', d.reference, 'title', d.title, 'branchId', d.branch_id,
                                  'since', e.x -> 'since')
               || case when p_kind in ('drafts', 'missing_details')
                       then jsonb_build_object('versionNo', e.x -> 'versionNo') else '{}'::jsonb end
               order by e.ord)
      from jsonb_array_elements(v_page) with ordinality as e(x, ord)
      join public.deals d on d.id = (e.x ->> 'dealId')::uuid
      where e.ord <= v_limit), '[]'::jsonb),
    'hasMore', v_n > v_limit,
    'next', case when v_n > v_limit
                 then jsonb_build_object('since', v_last -> 'since', 'dealId', v_last -> 'dealId') end);
end;
$$;

comment on function public.my_work_list(text, jsonb, integer) is
  'Direction A B1-3: Home work rows (drafts, missing_details, returned, needs_booking) with the predicates of my_work_counts; Sales and Manager only; keyset pages; no money, contact, reason or staff identity.';

revoke all on function public.my_work_list(text, jsonb, integer) from public, anon, authenticated, service_role;
grant execute on function public.my_work_list(text, jsonb, integer) to authenticated;

commit;
