-- TripNavigate CRM - Accounts phase, track C (2 of 5): notice fan-out.
-- Contract: accounts-phase-2026-11-10/contract.md sections 9.1-9.3 (frozen
-- 10 November 2026, Lead decisions: notice writes stay in the same
-- transaction as the action, "both or neither", no swallowed errors).
--
-- What this file adds:
--   1. Recipient sets authz.notice_*_recipients(...) (setof uuid; the user is
--      never taken from auth.uid()).
--   2. The one writer authz.notice_write(...): returns 0 at once while
--      notices are off; drops the actor, duplicates, inactive staff and, for
--      money kinds, anyone holding Purchase in the entity; inserts in user id
--      order with on conflict (recipient, dedup_key) do nothing; priority
--      from the kind (bank details urgent when params.status = 'on_hold').
--   3. Resolvers authz.notice_resolve(shared_key, reason) and
--      authz.notice_resolve_task_for_others(task, except, reason): one audit
--      row notice.resolved per call that changed rows (target = subject,
--      details {kind, reason, count}); none when nothing changed or off.
--   4. Triggers (after insert / after update of the watched column, for each
--      row, with a when clause): outbox_events (kinds 1, 3 + resolve 4, 6, 7),
--      fulfilment_tasks (2, resolves 1 and the old assignee's task notices),
--      accounts_booking_reviews (4, 5), deal_cancellations (8),
--      customer_payment_claims (9), customer_receipts (10),
--      supplier_payment_requests (11-14), company_funding_requests (15),
--      supplier_beneficiary_revisions (16), purchase_go_ahead_requests (17,
--      18), purchase_cost_versions (19), purchase_cost_approvals (resolve 19),
--      flight_fare_approvals (20, 21), department_cost_entries (22),
--      supplier_documents (23), visa_result_notices (24). Kind 25 (Tally
--      exception) is in 20261203000415.
--   No trigger catches errors: a failing notice write fails the command (R1;
--   the switch is the operational fallback). Every trigger returns at once
--   while notices are off.
--
-- Rollback (forward-only): a new migration dropping these triggers (the
-- commands are unchanged by this file). Never delete notice or audit rows.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Recipient sets
-- ===========================================================================

-- Dept holders: active members of the department role in the entity (as the queues).
create function authz.notice_department_recipients(p_entity uuid, p_department text) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct m.user_id from public.memberships m
  where m.legal_entity_id = p_entity and m.role_code = p_department and m.status = 'active'
    and authz.is_active_department_person(m.user_id, p_entity, p_department)
$$;

create function authz.notice_accounts_recipients(p_entity uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct m.user_id from public.memberships m
  where m.legal_entity_id = p_entity and m.role_code = 'accounts' and m.status = 'active'
    and authz.notice_user_is_accounts(m.user_id, p_entity)
$$;

create function authz.notice_branch_manager_recipients(p_entity uuid, p_branch uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct m.user_id from public.memberships m
  where m.legal_entity_id = p_entity and m.branch_id = p_branch and m.role_code = 'manager' and m.status = 'active'
    and authz.notice_user_is_branch_manager(m.user_id, p_entity, p_branch)
$$;

-- Active Managers of the entity (the beneficiary-approval rule, can_verify_suppliers).
create function authz.notice_entity_manager_recipients(p_entity uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct m.user_id from public.memberships m
  where m.legal_entity_id = p_entity and m.role_code = 'manager' and m.status = 'active'
    and authz.is_active_department_person(m.user_id, p_entity, 'manager')
$$;

-- SO*: the Deal's Sales owner, else the branch Managers (Visa build rule).
create function authz.notice_so_star_recipients(p_deal uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select x.u from (
    select d.owner_user_id as u from public.deals d where d.id = p_deal and d.owner_user_id is not null
    union
    select m.user_id from public.deals d
    join public.memberships m on m.legal_entity_id = d.legal_entity_id and m.branch_id = d.branch_id
     and m.role_code = 'manager' and m.status = 'active'
    where d.id = p_deal) x
  where authz.notice_user_is_so_star(x.u, p_deal)
$$;

-- ===========================================================================
-- 2. Writer and resolvers
-- ===========================================================================

create function authz.notice_write(p_kind text, p_recipients uuid[], p_entity uuid, p_branch uuid, p_deal uuid,
  p_task uuid, p_subject_kind text, p_subject_id uuid, p_params jsonb, p_dedup_prefix text, p_shared_key text)
returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_params jsonb := jsonb_strip_nulls(coalesce(p_params, '{}'::jsonb));
  v_priority text;
  v_count integer;
begin
  if not authz.notices_enabled() or p_recipients is null or cardinality(p_recipients) = 0 then
    return 0;
  end if;
  if p_deal is not null and not (v_params ? 'dealReference') then
    select v_params || jsonb_build_object('dealReference', d.reference) into v_params
    from public.deals d where d.id = p_deal;
  end if;
  v_priority := case
    when p_kind in ('booking_changed', 'review_returned', 'trip_cancelled', 'cost_over_budget', 'fare_to_approve') then 'urgent'
    when p_kind = 'bank_details_to_approve' and v_params ->> 'status' = 'on_hold' then 'urgent'
    else 'normal' end;
  insert into public.staff_notices (legal_entity_id, branch_id, recipient_user_id, kind, priority, deal_id, task_id,
    subject_kind, subject_id, params, dedup_key, shared_key, actor_user_id)
  select p_entity, p_branch, r.u, p_kind, v_priority, p_deal, p_task, p_subject_kind, p_subject_id, v_params,
         p_dedup_prefix, p_shared_key,
         -- Kept only when the actor is a staff profile (a service call has none).
         (select p.user_id from public.staff_profiles p where p.user_id = v_actor)
  from (select distinct u from unnest(p_recipients) as u where u is not null) r
  where r.u is distinct from v_actor
    and exists (select 1 from public.staff_profiles p where p.user_id = r.u and p.status = 'active')
    and (not authz.notice_money_kind(p_kind) or not authz.notice_user_holds(r.u, p_entity, array['purchase']))
  order by r.u
  on conflict (recipient_user_id, dedup_key) do nothing;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- Shared resolution: every open row with the shared key, for every recipient.
create function authz.notice_resolve(p_shared_key text, p_reason text) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_count integer;
  v_first public.staff_notices%rowtype;
begin
  if not authz.notices_enabled() or p_shared_key is null then
    return 0;
  end if;
  with target as (
    select n.id from public.staff_notices n
    where n.shared_key = p_shared_key and n.resolved_at is null
    order by n.id for update),
  done as (
    update public.staff_notices n set resolved_at = now(), resolved_reason = p_reason
    from target where n.id = target.id returning n.id)
  select count(*) into v_count from done;
  if v_count > 0 then
    select * into v_first from public.staff_notices n where n.shared_key = p_shared_key order by n.seq limit 1;
    perform authz.write_audit('notice.resolved', v_first.legal_entity_id, v_first.branch_id, v_first.subject_kind,
      v_first.subject_id, null, jsonb_build_object('kind', v_first.kind, 'reason', p_reason, 'count', v_count));
  end if;
  return v_count;
end;
$$;

-- Reassignment: the task-holder notices of the task for anyone but the new
-- assignee (never the Sales owner's or approvers' notices that carry the task).
create function authz.notice_resolve_task_for_others(p_task uuid, p_except uuid, p_reason text) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_count integer;
  v_kinds text[];
  v_task public.fulfilment_tasks%rowtype;
begin
  if not authz.notices_enabled() or p_task is null then
    return 0;
  end if;
  with target as (
    select n.id from public.staff_notices n
    where n.task_id = p_task and n.resolved_at is null and n.recipient_user_id is distinct from p_except
      and n.kind in ('task_assigned', 'booking_changed', 'trip_cancelled', 'expense_returned', 'supplier_bill_returned')
    order by n.id for update),
  done as (
    update public.staff_notices n set resolved_at = now(), resolved_reason = p_reason
    from target where n.id = target.id returning n.kind)
  select count(*), array_agg(distinct done.kind) into v_count, v_kinds from done;
  if v_count > 0 then
    select * into v_task from public.fulfilment_tasks t where t.id = p_task;
    perform authz.write_audit('notice.resolved', v_task.legal_entity_id, v_task.branch_id, 'task', p_task, null,
      jsonb_build_object('kind', case when cardinality(v_kinds) = 1 then v_kinds[1] else 'several' end,
                         'reason', p_reason, 'count', v_count));
  end if;
  return v_count;
end;
$$;

-- ===========================================================================
-- 3. Outbox fan-out (kinds 1, 3, 6, 7; resolves 4 on a confirmed revision)
-- ===========================================================================

create function authz.notices_on_outbox() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_deal uuid;
  v_version uuid;
  v_version_no integer;
  r record;
begin
  if not authz.notices_enabled() then
    return null;
  end if;
  if new.event_type in ('fulfilment.task_created', 'fulfilment.supplier_confirmed', 'fulfilment.task_completed') then
    select * into v_task from public.fulfilment_tasks t where t.id = new.aggregate_id;
    if v_task.id is null then
      return null;
    end if;
  end if;

  if new.event_type = 'fulfilment.task_created' then
    perform authz.notice_write('task_new',
      array(select authz.notice_department_recipients(v_task.legal_entity_id, v_task.department)),
      v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, 'task', v_task.id,
      jsonb_build_object('department', v_task.department, 'serviceType', v_task.service_purpose),
      'task_new:' || v_task.id, 'task_new:' || v_task.id);
  elsif new.event_type = 'fulfilment.supplier_confirmed' then
    perform authz.notice_write('supplier_confirmed', array(select authz.notice_so_star_recipients(v_task.deal_id)),
      v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, 'task', v_task.id,
      jsonb_build_object('department', v_task.department, 'serviceType', v_task.service_purpose),
      'supplier_confirmed:' || v_task.id, null);
  elsif new.event_type = 'fulfilment.task_completed' then
    perform authz.notice_write('task_completed', array(select authz.notice_so_star_recipients(v_task.deal_id)),
      v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, 'task', v_task.id,
      jsonb_build_object('department', v_task.department, 'serviceType', v_task.service_purpose),
      'task_completed:' || v_task.id, null);
  elsif new.event_type = 'booking.version_revised' then
    v_version := (new.payload ->> 'version_id')::uuid;
    select v.deal_id, v.version_no into v_deal, v_version_no from public.booking_versions v where v.id = v_version;
    if v_deal is null then
      return null;
    end if;
    for r in
      select t.* from public.fulfilment_tasks t
      where t.deal_id = v_deal and t.status = 'in_progress' and t.assignee_user_id is not null
        and exists (select 1 from public.service_item_facts f
                    where f.service_item_id = t.service_item_id and f.booking_version_id = v_version)
      order by t.id
    loop
      perform authz.notice_write('booking_changed', array[r.assignee_user_id], r.legal_entity_id, r.branch_id,
        r.deal_id, r.id, 'task', r.id,
        jsonb_build_object('department', r.department, 'serviceType', r.service_purpose, 'versionNo', v_version_no),
        'booking_changed:' || v_version || ':' || r.id, null);
    end loop;
    perform authz.notice_resolve('review_returned:' || v_deal, 'revised');
  end if;
  return null;
end;
$$;
create trigger outbox_events_notices
  after insert on public.outbox_events
  for each row
  when (new.event_type in ('fulfilment.task_created', 'fulfilment.supplier_confirmed', 'fulfilment.task_completed',
                           'booking.version_revised'))
  execute function authz.notices_on_outbox();

-- ===========================================================================
-- 4. Task assignment (kind 2; resolves 1 and the old assignee's notices)
-- ===========================================================================

create function authz.notices_on_task_assignee() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not authz.notices_enabled() then
    return null;
  end if;
  perform authz.notice_resolve('task_new:' || new.id, 'taken');
  perform authz.notice_resolve_task_for_others(new.id, new.assignee_user_id, 'reassigned');
  perform authz.notice_write('task_assigned', array[new.assignee_user_id], new.legal_entity_id, new.branch_id,
    new.deal_id, new.id, 'task', new.id,
    jsonb_build_object('department', new.department, 'serviceType', new.service_purpose),
    'task_assigned:' || new.id || ':' || new.assignee_user_id || ':' || pg_current_xact_id()::text, null);
  return null;
end;
$$;
create trigger fulfilment_tasks_notices_insert
  after insert on public.fulfilment_tasks
  for each row when (new.assignee_user_id is not null)
  execute function authz.notices_on_task_assignee();
create trigger fulfilment_tasks_notices_assignee
  after update of assignee_user_id on public.fulfilment_tasks
  for each row when (new.assignee_user_id is not null and new.assignee_user_id is distinct from old.assignee_user_id)
  execute function authz.notices_on_task_assignee();

-- ===========================================================================
-- 5. Accounts booking review (kinds 4, 5)
-- ===========================================================================

create function authz.notices_on_review() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_version_no integer;
begin
  if not authz.notices_enabled() then
    return null;
  end if;
  select * into v_deal from public.deals d where d.id = new.deal_id;
  select v.version_no into v_version_no from public.booking_versions v where v.id = new.booking_version_id;
  if new.status = 'returned' then
    perform authz.notice_write('review_returned', array(select authz.notice_so_star_recipients(new.deal_id)),
      new.legal_entity_id, v_deal.branch_id, new.deal_id, null, 'booking_version', new.booking_version_id,
      jsonb_build_object('versionNo', v_version_no),
      'review:' || new.id || ':returned:' || new.row_version, 'review_returned:' || new.deal_id);
  elsif new.status = 'approved' then
    perform authz.notice_write('review_approved', array(select authz.notice_so_star_recipients(new.deal_id)),
      new.legal_entity_id, v_deal.branch_id, new.deal_id, null, 'booking_version', new.booking_version_id,
      jsonb_build_object('versionNo', v_version_no),
      'review:' || new.id || ':approved:' || new.row_version, null);
  end if;
  return null;
end;
$$;
create trigger accounts_booking_reviews_notices_insert
  after insert on public.accounts_booking_reviews
  for each row when (new.status in ('returned', 'approved'))
  execute function authz.notices_on_review();
create trigger accounts_booking_reviews_notices_status
  after update of status on public.accounts_booking_reviews
  for each row when (new.status in ('returned', 'approved') and new.status is distinct from old.status)
  execute function authz.notices_on_review();

-- ===========================================================================
-- 6. Trip cancelled (kind 8)
-- ===========================================================================

create function authz.notices_on_cancellation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  if not authz.notices_enabled() then
    return null;
  end if;
  for r in
    select t.* from public.fulfilment_tasks t
    where t.deal_id = new.deal_id and t.status = 'in_progress' and t.assignee_user_id is not null
    order by t.id
  loop
    perform authz.notice_write('trip_cancelled', array[r.assignee_user_id], r.legal_entity_id, r.branch_id,
      r.deal_id, r.id, 'cancellation', new.id,
      jsonb_build_object('department', r.department, 'serviceType', r.service_purpose),
      'cancel:' || new.id || ':' || r.id, null);
  end loop;
  return null;
end;
$$;
create trigger deal_cancellations_notices
  after insert on public.deal_cancellations
  for each row execute function authz.notices_on_cancellation();

-- ===========================================================================
-- 7. Customer money (kinds 9, 10)
-- ===========================================================================

create function authz.notices_on_claim() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_branch uuid;
begin
  if not authz.notices_enabled() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    select d.branch_id into v_branch from public.deals d where d.id = new.deal_id;
    perform authz.notice_write('payment_reported', array(select authz.notice_accounts_recipients(new.legal_entity_id)),
      new.legal_entity_id, v_branch, new.deal_id, null, 'claim', new.id, '{}'::jsonb,
      'claim:' || new.id, 'claim:' || new.id);
  else
    perform authz.notice_resolve('claim:' || new.id, 'acted');
  end if;
  return null;
end;
$$;
create trigger customer_payment_claims_notices_insert
  after insert on public.customer_payment_claims
  for each row when (new.status = 'reported')
  execute function authz.notices_on_claim();
create trigger customer_payment_claims_notices_status
  after update of status on public.customer_payment_claims
  for each row when (old.status = 'reported' and new.status <> 'reported')
  execute function authz.notices_on_claim();

create function authz.notices_on_receipt() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_branch uuid;
begin
  if not authz.notices_enabled() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    -- The Deal's branch (a receipt collected elsewhere still belongs to the Deal).
    select d.branch_id into v_branch from public.deals d where d.id = new.deal_id;
    perform authz.notice_write('receipt_to_verify',
      array_remove(array(select authz.notice_accounts_recipients(new.legal_entity_id)), new.recorded_by),
      new.legal_entity_id, v_branch, new.deal_id, null, 'receipt', new.id,
      jsonb_build_object('refNo', new.receipt_no), 'receipt:' || new.id || ':verify', 'receipt:' || new.id || ':verify');
  else
    perform authz.notice_resolve('receipt:' || new.id || ':verify', 'acted');
  end if;
  return null;
end;
$$;
create trigger customer_receipts_notices_insert
  after insert on public.customer_receipts
  for each row when (new.status = 'recorded')
  execute function authz.notices_on_receipt();
create trigger customer_receipts_notices_status
  after update of status on public.customer_receipts
  for each row when (old.status = 'recorded' and new.status <> 'recorded')
  execute function authz.notices_on_receipt();

-- ===========================================================================
-- 8. Supplier payments and company funding (kinds 11-15)
-- ===========================================================================

create function authz.notices_on_supplier_payment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_branch uuid;
  v_department text;
  v_params jsonb;
  v_route uuid[];
begin
  if not authz.notices_enabled() then
    return null;
  end if;
  select d.branch_id into v_branch from public.deals d where d.id = new.deal_id;
  select t.department into v_department from public.fulfilment_tasks t where t.id = new.task_id;
  v_params := jsonb_build_object('refNo', new.ref_no, 'department', v_department);

  if tg_op = 'UPDATE' then
    if old.status = 'pending' then
      perform authz.notice_resolve('sp:' || new.id || ':approve', 'acted');
    elsif old.status = 'approved' then
      perform authz.notice_resolve('sp:' || new.id || ':record', 'acted');
    elsif old.status = 'paid' then
      perform authz.notice_resolve('sp:' || new.id || ':verify', 'acted');
    end if;
  end if;

  if new.status = 'pending' and tg_op = 'INSERT' then
    v_route := case when new.route = 'manager'
                    then array(select authz.notice_branch_manager_recipients(new.legal_entity_id, v_branch))
                    else array(select authz.notice_accounts_recipients(new.legal_entity_id)) end;
    perform authz.notice_write('payment_to_approve', v_route, new.legal_entity_id, v_branch, new.deal_id, new.task_id,
      'supplier_payment', new.id, v_params, 'sp:' || new.id || ':approve', 'sp:' || new.id || ':approve');
  elsif new.status = 'approved' and tg_op = 'UPDATE' then
    perform authz.notice_write('payment_to_record', array(select authz.notice_accounts_recipients(new.legal_entity_id)),
      new.legal_entity_id, v_branch, new.deal_id, new.task_id, 'supplier_payment', new.id, v_params,
      'sp:' || new.id || ':record', 'sp:' || new.id || ':record');
  elsif new.status = 'paid' and tg_op = 'UPDATE' then
    perform authz.notice_write('payment_to_verify',
      array_remove(array(select authz.notice_accounts_recipients(new.legal_entity_id)), new.recorded_by),
      new.legal_entity_id, v_branch, new.deal_id, new.task_id, 'supplier_payment', new.id, v_params,
      'sp:' || new.id || ':verify', 'sp:' || new.id || ':verify');
  end if;

  if tg_op = 'UPDATE' and old.status = 'pending' and new.status in ('approved', 'returned') then
    perform authz.notice_write('payment_decided', array[new.requested_by], new.legal_entity_id, v_branch, new.deal_id,
      new.task_id, 'supplier_payment', new.id, v_params || jsonb_build_object('status', new.status),
      'sp:' || new.id || ':' || new.status, null);
  end if;
  return null;
end;
$$;
create trigger supplier_payment_requests_notices_insert
  after insert on public.supplier_payment_requests
  for each row when (new.status = 'pending')
  execute function authz.notices_on_supplier_payment();
create trigger supplier_payment_requests_notices_status
  after update of status on public.supplier_payment_requests
  for each row when (new.status is distinct from old.status)
  execute function authz.notices_on_supplier_payment();

create function authz.notices_on_funding() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_branch uuid;
  v_ref text;
begin
  if not authz.notices_enabled() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    select d.branch_id into v_branch from public.deals d where d.id = new.deal_id;
    select p.ref_no into v_ref from public.supplier_payment_requests p where p.id = new.payment_request_id;
    perform authz.notice_write('funding_to_approve',
      case when new.route = 'manager'
           then array(select authz.notice_branch_manager_recipients(new.legal_entity_id, v_branch))
           else array(select authz.notice_accounts_recipients(new.legal_entity_id)) end,
      new.legal_entity_id, v_branch, new.deal_id, null, 'funding', new.id, jsonb_build_object('refNo', v_ref),
      'funding:' || new.id, 'funding:' || new.id);
  else
    perform authz.notice_resolve('funding:' || new.id, 'acted');
  end if;
  return null;
end;
$$;
create trigger company_funding_requests_notices_insert
  after insert on public.company_funding_requests
  for each row when (new.status = 'pending')
  execute function authz.notices_on_funding();
create trigger company_funding_requests_notices_status
  after update of status on public.company_funding_requests
  for each row when (old.status = 'pending' and new.status <> 'pending')
  execute function authz.notices_on_funding();

-- ===========================================================================
-- 9. Bank details (kind 16)
-- ===========================================================================

create function authz.notices_on_bank_revision() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_on_hold boolean;
begin
  if not authz.notices_enabled() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    -- A newer revision supersedes the open notices of the older ones.
    for r in
      select x.id from public.supplier_beneficiary_revisions x
      where x.supplier_id = new.supplier_id and x.id <> new.id and x.revision_no < new.revision_no
        and exists (select 1 from public.staff_notices n where n.shared_key = 'bank:' || x.id and n.resolved_at is null)
      order by x.revision_no
    loop
      perform authz.notice_resolve('bank:' || r.id, 'superseded');
    end loop;
    v_on_hold := exists (select 1 from public.supplier_payment_requests p
                         where p.supplier_id = new.supplier_id and p.status in ('pending', 'approved'));
    perform authz.notice_write('bank_details_to_approve',
      array_remove(array(select authz.notice_entity_manager_recipients(new.legal_entity_id)), new.created_by),
      new.legal_entity_id, null, null, null, 'bank_revision', new.id,
      case when v_on_hold then jsonb_build_object('status', 'on_hold') else '{}'::jsonb end,
      'bank:' || new.id, 'bank:' || new.id);
  else
    perform authz.notice_resolve('bank:' || new.id, 'acted');
  end if;
  return null;
end;
$$;
create trigger supplier_beneficiary_revisions_notices_insert
  after insert on public.supplier_beneficiary_revisions
  for each row when (new.status = 'unverified')
  execute function authz.notices_on_bank_revision();
create trigger supplier_beneficiary_revisions_notices_status
  after update of status on public.supplier_beneficiary_revisions
  for each row when (old.status = 'unverified' and new.status = 'approved')
  execute function authz.notices_on_bank_revision();

-- ===========================================================================
-- 10. Purchase go-ahead (kinds 17, 18) and cost above budget (kind 19)
-- ===========================================================================

create function authz.notices_on_go_ahead() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not authz.notices_enabled() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    perform authz.notice_write('go_ahead_to_approve', array(select authz.notice_accounts_recipients(new.legal_entity_id)),
      new.legal_entity_id, new.branch_id, new.deal_id, new.task_id, 'go_ahead', new.id,
      jsonb_build_object('department', 'purchase'), 'go_ahead:' || new.id, 'go_ahead:' || new.id);
  else
    perform authz.notice_resolve('go_ahead:' || new.id, 'acted');
    if new.status in ('approved', 'returned') then
      perform authz.notice_write('go_ahead_decided', array[new.requested_by], new.legal_entity_id, new.branch_id,
        new.deal_id, new.task_id, 'go_ahead', new.id, jsonb_build_object('department', 'purchase', 'status', new.status),
        'go_ahead:' || new.id || ':' || new.status, null);
    end if;
  end if;
  return null;
end;
$$;
create trigger purchase_go_ahead_requests_notices_insert
  after insert on public.purchase_go_ahead_requests
  for each row when (new.status = 'pending')
  execute function authz.notices_on_go_ahead();
create trigger purchase_go_ahead_requests_notices_status
  after update of status on public.purchase_go_ahead_requests
  for each row when (old.status = 'pending' and new.status <> 'pending')
  execute function authz.notices_on_go_ahead();

-- The Manager approvals predicate (authz.sm_manager_cost_rows, 20261130000210):
-- a proposed cost on an in-progress Purchase task above its budget (or with
-- no budget) that is not yet approved.
create function authz.notices_on_cost_version() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_budget bigint;
begin
  if not authz.notices_enabled() then
    return null;
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = new.task_id;
  -- Any newer cost version supersedes the open notice of an older one.
  perform authz.notice_resolve('cost:' || new.task_id, 'superseded');
  if new.stage <> 'proposed' or v_task.department is distinct from 'purchase' or v_task.status <> 'in_progress' then
    return null;
  end if;
  v_budget := authz.task_budget(new.task_id);
  if (v_budget is null or new.amount_paise > v_budget) and not authz.cost_version_approved(new.task_id, new.version_no) then
    perform authz.notice_write('cost_over_budget',
      array(select authz.notice_branch_manager_recipients(v_task.legal_entity_id, v_task.branch_id)),
      v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, 'cost_version', new.id,
      jsonb_build_object('department', 'purchase', 'versionNo', new.version_no),
      'cost:' || new.task_id || ':' || new.version_no, 'cost:' || new.task_id);
  end if;
  return null;
end;
$$;
create trigger purchase_cost_versions_notices
  after insert on public.purchase_cost_versions
  for each row execute function authz.notices_on_cost_version();

create function authz.notices_on_cost_approval() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not authz.notices_enabled() then
    return null;
  end if;
  perform authz.notice_resolve('cost:' || new.task_id, 'acted');
  return null;
end;
$$;
create trigger purchase_cost_approvals_notices
  after insert on public.purchase_cost_approvals
  for each row execute function authz.notices_on_cost_approval();

-- ===========================================================================
-- 11. Flight fares above budget (kinds 20, 21)
-- ===========================================================================

create function authz.notices_on_fare_approval() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not authz.notices_enabled() then
    return null;
  end if;
  if tg_op = 'INSERT' then
    perform authz.notice_write('fare_to_approve',
      array(select authz.notice_branch_manager_recipients(new.legal_entity_id, new.branch_id)),
      new.legal_entity_id, new.branch_id, new.deal_id, null, 'fare_approval', new.id,
      jsonb_build_object('department', 'flight'), 'fare:' || new.id, 'fare:' || new.id);
  else
    perform authz.notice_resolve('fare:' || new.id, 'acted');
    if new.status in ('approved', 'returned') then
      perform authz.notice_write('fare_decided', array[new.requested_by], new.legal_entity_id, new.branch_id,
        new.deal_id, null, 'fare_approval', new.id, jsonb_build_object('department', 'flight', 'status', new.status),
        'fare:' || new.id || ':' || new.status, null);
    end if;
  end if;
  return null;
end;
$$;
create trigger flight_fare_approvals_notices_insert
  after insert on public.flight_fare_approvals
  for each row when (new.status = 'pending')
  execute function authz.notices_on_fare_approval();
create trigger flight_fare_approvals_notices_status
  after update of status on public.flight_fare_approvals
  for each row when (old.status = 'pending' and new.status <> 'pending')
  execute function authz.notices_on_fare_approval();

-- ===========================================================================
-- 12. Returned expense records and supplier bills (kinds 22, 23)
-- ===========================================================================

create function authz.notices_on_expense() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
begin
  if not authz.notices_enabled() then
    return null;
  end if;
  if new.expense_status = 'returned' then
    select * into v_task from public.fulfilment_tasks t where t.id = new.task_id;
    perform authz.notice_write('expense_returned', array[coalesce(v_task.assignee_user_id, new.created_by)],
      new.legal_entity_id, new.branch_id, new.deal_id, new.task_id, 'expense', new.id,
      jsonb_build_object('department', new.department),
      'expense:' || new.id || ':returned:' || new.row_version, 'expense:' || new.id || ':returned');
  elsif old.expense_status = 'returned' then
    perform authz.notice_resolve('expense:' || new.id || ':returned', 'acted');
  end if;
  return null;
end;
$$;
create trigger department_cost_entries_notices
  after update of expense_status on public.department_cost_entries
  for each row when (new.expense_status is distinct from old.expense_status
                     and (new.expense_status = 'returned' or old.expense_status = 'returned'))
  execute function authz.notices_on_expense();

create function authz.notices_on_supplier_document() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
begin
  if not authz.notices_enabled() then
    return null;
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = new.task_id;
  perform authz.notice_write('supplier_bill_returned', array[coalesce(v_task.assignee_user_id, new.uploaded_by)],
    new.legal_entity_id, new.branch_id, new.deal_id, new.task_id, 'supplier_document', new.id,
    jsonb_build_object('department', v_task.department), 'sdoc:' || new.id || ':returned', null);
  return null;
end;
$$;
create trigger supplier_documents_notices
  after update of status on public.supplier_documents
  for each row when (new.status = 'returned' and old.status is distinct from 'returned')
  execute function authz.notices_on_supplier_document();

-- ===========================================================================
-- 13. Visa results into the bell (kind 24)
-- ===========================================================================

create function authz.notices_on_visa_result() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not authz.notices_enabled() then
    return null;
  end if;
  perform authz.notice_write('visa_result', array(select authz.notice_so_star_recipients(new.deal_id)),
    new.legal_entity_id, new.branch_id, new.deal_id, new.task_id, 'visa_notice', new.id,
    jsonb_build_object('department', 'visa', 'status', new.outcome), 'visa_result:' || new.id, null);
  return null;
end;
$$;
create trigger visa_result_notices_bell
  after insert on public.visa_result_notices
  for each row execute function authz.notices_on_visa_result();

-- ===========================================================================
-- 14. Grants: helpers and trigger functions are internal
-- ===========================================================================

revoke all on function
  authz.notice_department_recipients(uuid, text), authz.notice_accounts_recipients(uuid),
  authz.notice_branch_manager_recipients(uuid, uuid), authz.notice_entity_manager_recipients(uuid),
  authz.notice_so_star_recipients(uuid),
  authz.notice_write(text, uuid[], uuid, uuid, uuid, uuid, text, uuid, jsonb, text, text),
  authz.notice_resolve(text, text), authz.notice_resolve_task_for_others(uuid, uuid, text),
  authz.notices_on_outbox(), authz.notices_on_task_assignee(), authz.notices_on_review(),
  authz.notices_on_cancellation(), authz.notices_on_claim(), authz.notices_on_receipt(),
  authz.notices_on_supplier_payment(), authz.notices_on_funding(), authz.notices_on_bank_revision(),
  authz.notices_on_go_ahead(), authz.notices_on_cost_version(), authz.notices_on_cost_approval(),
  authz.notices_on_fare_approval(), authz.notices_on_expense(), authz.notices_on_supplier_document(),
  authz.notices_on_visa_result()
from public, anon, authenticated, service_role;

commit;
