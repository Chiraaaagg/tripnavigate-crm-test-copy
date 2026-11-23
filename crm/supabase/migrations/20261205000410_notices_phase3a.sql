-- TripNavigate CRM - Accounts phase 3, track D (2 of 2): Release A notices
-- (kinds 40-46) and notices 30 / 32 silent while automatic bills are on.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 8.5, 8.6, 14,
-- 16.1 D, 19 (D owns every notice function in Release A), 21 LD34;
-- Addendum L3 (silencing 30 and 32 is track D's). Notice rows carry template
-- keys and references only (refNo = WO-...); never names, amounts, PAN,
-- phone, e-mail, PNR, ticket numbers or message text.
--
-- Kinds (recipients exclude the actor; money kinds 40-42 exclude anyone
-- holding Purchase in the entity, as Phase 1):
--   40 bill_held  customer_documents.auto_state -> held (or its codes change
--      while no open notice is left) -> Accounts. Normal, money. Shared
--      cdoc:<document>:held, resolved when the draft leaves 'held' (released,
--      discarded or ready).
--   41 write_off_to_approve  deal_write_offs insert -> branch Managers of the
--      Deal (no Purchase / Flight / Visa) except the proposer; when there is
--      none, every other active Manager of the entity without an Accounts,
--      Purchase, Flight or Visa role (LD37; params.status 'entity'). Normal,
--      money. Shared wo:<id>:approve, resolved when the status leaves proposed.
--   42 write_off_decided  status -> approved / returned / undone -> the
--      proposer. Returned urgent, else normal; money. Dedup wo:<id>:<status>.
--   43 message_failed  customer_message_alerts kind message_failed -> SO*.
--      Normal. Shared cmsg:<message>, resolved when a re-send of it (or of a
--      re-send of it) is sent.
--   44 whatsapp_stopped  customer_message_alerts kind whatsapp_stopped -> SO*.
--      Normal. Dedup cmsg:stop:<deal> (contract 8.6: once per Deal).
--   45 boarding_pass_due  flight_boarding_pass_alerts insert -> the Flight
--      task assignee, else Flight holders. Urgent. Shared bp:<task>:<sector>,
--      resolved when a boarding pass of the task is stored.
--   46 timer_stalled  timer_alerts insert -> every active Super Admin, one row
--      each (written under each enabled entity they are Super Admin of; the
--      per-person dedup timer:<India date-hour> keeps one). Track D's choice
--      for an alert without an entity. Urgent. Shared timer:<date-hour>,
--      resolved at the next good tick: when public.timer_tick() records
--      last_ok_at in a later transaction, the timer is on time and no customer
--      message or push job has waited more than 15 minutes.
--   30, 32 (changed)  document_to_release and credit_note_to_release are not
--      written while accounts_settings.auto_bills_enabled is on (the CRM drafts
--      and checks the bills itself; 40 tells Accounts about held ones).
--
-- Replaced (latest bodies re-confirmed with the sorted grep, same signatures;
-- changed lines marked "Accounts phase 3 (20261205000410)"):
--   authz.notice_kinds, authz.notice_money_kind, authz.notice_write,
--   authz.notice_link, authz.notice_so_kind, authz.notice_row_visible
--   (20261204000440); authz.staff_notice_visible, authz.notice_visible_unread,
--   public.notice_history (20261204000430: the route marker of 41);
--   public.notice_inbox (20261204000430: + pushEnabled, contract 8.5);
--   authz.notices_on_review_document, authz.notices_on_receipt_document,
--   authz.notice_credit_note (20261204000430: 30 / 32 silence).
-- staff_notices.subject_kind check adds write_off, customer_message,
-- flight_alert, timer. Params keys unchanged.
-- New trigger functions on customer_documents, deal_write_offs,
-- customer_message_alerts, customer_messages, flight_boarding_pass_alerts,
-- department_evidence, timer_alerts and timer_settings. Writers return at once
-- while notices are off; resolutions always run. No trigger catches errors
-- (Phase 1 R1), except that the timer resolution can never fail the tick.
--
-- Refusal tokens: none.
-- Rollback (forward-only): a NEW migration dropping the new triggers and
-- functions and restoring the replaced bodies (20261204000440 / 0430). Never
-- delete notice rows.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Kinds, subject kinds, money kinds, priority, links
-- ===========================================================================

create or replace function authz.notice_kinds() returns text[]
language sql immutable set search_path = '' as $$
  select array['task_new', 'task_assigned', 'booking_changed', 'review_returned', 'review_approved',
               'supplier_confirmed', 'task_completed', 'trip_cancelled', 'payment_reported', 'receipt_to_verify',
               'payment_to_approve', 'payment_to_record', 'payment_to_verify', 'payment_decided',
               'funding_to_approve', 'bank_details_to_approve', 'go_ahead_to_approve', 'go_ahead_decided',
               'cost_over_budget', 'fare_to_approve', 'fare_decided', 'expense_returned', 'supplier_bill_returned',
               'visa_result', 'tally_exception',
               -- Accounts phase 2 (20261204000430): 26-38, 34 dropped (Addendum L1).
               'refund_to_approve', 'refund_decided', 'refund_payout_due', 'refund_paid', 'document_to_release',
               'document_to_check', 'credit_note_to_release', 'supplier_refund_due', 'cancellation_to_approve',
               'flight_charges_to_enter', 'visa_cancel_decide', 'refund_to_request',
               -- Addendum L6 (20261204000440)
               'refund_shortfall',
               -- Accounts phase 3 (20261205000410): 40-46.
               'bill_held', 'write_off_to_approve', 'write_off_decided', 'message_failed', 'whatsapp_stopped',
               'boarding_pass_due', 'timer_stalled']
$$;

do $$
declare
  c record;
begin
  for c in
    select con.conname from pg_catalog.pg_constraint con
    where con.conrelid = 'public.staff_notices'::regclass and con.contype = 'c'
      and pg_catalog.pg_get_constraintdef(con.oid) like '%subject_kind%booking_version%'
  loop
    execute format('alter table public.staff_notices drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table public.staff_notices add constraint staff_notices_subject_kind_check check (subject_kind in ('task', 'deal',
  'claim', 'receipt', 'supplier_payment', 'funding', 'go_ahead', 'cost_version', 'fare_approval', 'bank_revision',
  'expense', 'supplier_document', 'cancellation', 'visa_notice', 'tally_record', 'booking_version',
  'refund_request', 'customer_document', 'supplier_refund', 'flight_batch',
  -- Accounts phase 3 (20261205000410)
  'write_off', 'customer_message', 'flight_alert', 'timer'));

create or replace function authz.notice_money_kind(p_kind text) returns boolean
language sql immutable set search_path = '' as $$
  select p_kind in ('payment_reported', 'receipt_to_verify', 'payment_to_approve', 'payment_to_record',
                    'payment_to_verify', 'funding_to_approve', 'go_ahead_to_approve', 'fare_to_approve',
                    'tally_exception',
                    -- Accounts phase 2 (20261204000430)
                    'refund_to_approve', 'refund_decided', 'refund_payout_due', 'refund_paid', 'document_to_release',
                    'document_to_check', 'credit_note_to_release', 'supplier_refund_due', 'refund_to_request',
                    'refund_shortfall',  -- Addendum L6 (20261204000440)
                    -- Accounts phase 3 (20261205000410)
                    'bill_held', 'write_off_to_approve', 'write_off_decided')
$$;

create or replace function authz.notice_write(p_kind text, p_recipients uuid[], p_entity uuid, p_branch uuid, p_deal uuid,
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
    -- Accounts phase 2 (20261204000430)
    when p_kind in ('refund_to_approve', 'cancellation_to_approve', 'flight_charges_to_enter', 'visa_cancel_decide') then 'urgent'
    when p_kind = 'refund_decided' and v_params ->> 'status' = 'returned' then 'urgent'
    when p_kind = 'refund_shortfall' then 'urgent'  -- Addendum L6 (20261204000440)
    -- Accounts phase 3 (20261205000410)
    when p_kind = 'write_off_decided' and v_params ->> 'status' = 'returned' then 'urgent'
    when p_kind in ('boarding_pass_due', 'timer_stalled') then 'urgent'
    else 'normal' end;
  insert into public.staff_notices (legal_entity_id, branch_id, recipient_user_id, kind, priority, deal_id, task_id,
    subject_kind, subject_id, params, dedup_key, shared_key, actor_user_id)
  select p_entity, p_branch, r.u, p_kind, v_priority, p_deal, p_task, p_subject_kind, p_subject_id, v_params,
         p_dedup_prefix, p_shared_key,
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

create or replace function authz.notice_link(p_kind text, p_deal uuid, p_task uuid, p_subject_kind text, p_subject_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_route text;
begin
  case
    when p_kind = 'trip_cancelled' and p_task is null then
      return jsonb_build_object('kind', 'cancellation', 'id', p_deal);
    when p_kind in ('task_new', 'task_assigned', 'booking_changed', 'trip_cancelled', 'payment_decided',
                    'go_ahead_decided', 'expense_returned', 'supplier_bill_returned',
                    'flight_charges_to_enter', 'visa_cancel_decide') then
      return jsonb_build_object('kind', 'task', 'id', p_task);
    when p_kind in ('review_returned', 'review_approved', 'supplier_confirmed', 'task_completed', 'visa_result') then
      return jsonb_build_object('kind', 'deal', 'id', p_deal);
    when p_kind = 'payment_reported' then
      return jsonb_build_object('kind', 'claim', 'id', p_subject_id);
    when p_kind = 'receipt_to_verify' then
      return jsonb_build_object('kind', 'accounts_deal', 'id', p_deal);
    when p_kind in ('payment_to_approve', 'funding_to_approve') then
      if p_subject_kind = 'supplier_payment' then
        select r.route into v_route from public.supplier_payment_requests r where r.id = p_subject_id;
      else
        select f.route into v_route from public.company_funding_requests f where f.id = p_subject_id;
      end if;
      if v_route = 'manager' then
        return jsonb_build_object('kind', 'approvals', 'id', p_subject_id);
      end if;
      return jsonb_build_object('kind', case when p_kind = 'funding_to_approve' then 'funding' else 'supplier_payment' end,
                                'id', p_subject_id);
    when p_kind in ('payment_to_record', 'payment_to_verify') then
      return jsonb_build_object('kind', 'supplier_payment', 'id', p_subject_id);
    when p_kind in ('bank_details_to_approve', 'cost_over_budget', 'fare_to_approve') then
      return jsonb_build_object('kind', 'approvals', 'id', p_subject_id);
    when p_kind = 'go_ahead_to_approve' then
      return jsonb_build_object('kind', 'go_ahead', 'id', p_subject_id);
    when p_kind = 'fare_decided' then
      return jsonb_build_object('kind', 'flight_deal', 'id', p_deal);
    when p_kind = 'tally_exception' then
      return jsonb_build_object('kind', 'workspace_row', 'id', p_subject_id);
    -- Accounts phase 2 (20261204000430)
    when p_kind in ('refund_to_approve', 'refund_decided', 'refund_payout_due', 'refund_paid', 'refund_to_request') then
      return jsonb_build_object('kind', 'refund', 'id', p_subject_id);
    when p_kind in ('document_to_release', 'document_to_check', 'credit_note_to_release') then
      return jsonb_build_object('kind', 'customer_document', 'id', p_subject_id);
    when p_kind = 'supplier_refund_due' then
      return jsonb_build_object('kind', 'supplier_refund', 'id', p_subject_id);
    when p_kind = 'refund_shortfall' then  -- Addendum L6 (20261204000440): the Deal page dues card
      return jsonb_build_object('kind', 'deal', 'id', p_deal);
    -- Accounts phase 3 (20261205000410): 40 the Deal documents card, 41 / 42 small balances, 43 / 44 the Deal
    -- messages card, 45 the Flight task, 46 Settings > Customer messages (timer state).
    when p_kind = 'bill_held' then
      return jsonb_build_object('kind', 'deal_documents', 'id', p_deal);
    when p_kind in ('write_off_to_approve', 'write_off_decided') then
      return jsonb_build_object('kind', 'small_balances', 'id', p_subject_id);
    when p_kind in ('message_failed', 'whatsapp_stopped') then
      return jsonb_build_object('kind', 'deal_messages', 'id', p_deal);
    when p_kind = 'boarding_pass_due' then
      return jsonb_build_object('kind', 'task', 'id', p_task);
    when p_kind = 'timer_stalled' then
      return jsonb_build_object('kind', 'timer', 'id', p_subject_id);
    when p_kind = 'cancellation_to_approve' then
      return jsonb_build_object('kind', 'cancellation', 'id', p_subject_id);
    else
      return null;
  end case;
end;
$$;

create or replace function authz.notice_so_kind(p_kind text) returns boolean
language sql immutable as $$
  select p_kind in ('review_returned', 'review_approved', 'supplier_confirmed', 'task_completed', 'visa_result',
                    'refund_paid', 'refund_to_request', 'trip_cancelled', 'refund_shortfall',
                    -- Accounts phase 3 (20261205000410)
                    'message_failed', 'whatsapp_stopped')
$$;

-- ===========================================================================
-- 2. Access re-check and the bell reads
-- ===========================================================================

create or replace function authz.notice_row_visible(c authz.notice_context, p_user uuid, p_kind text, p_entity uuid,
  p_deal_live boolean, p_deal_branch uuid, p_deal_owner uuid, p_has_task boolean, p_task_dept text,
  p_task_assignee uuid, p_route text, p_owner_qualifies boolean) returns boolean
-- No SET clause on purpose (inlining); no table read, no function call.
language sql immutable as $$
  select coalesce(c.active, false) and coalesce(p_deal_live, false) and coalesce(case
    when p_kind = 'task_new' then
      p_has_task and (p_entity::text || ':' || p_task_dept) = any (c.dept)
    -- Accounts phase 2 (20261204000430): widened trip_cancelled; task rows also reach the
    -- department queue while unassigned; Deal rows go to SO* and Accounts.
    when p_kind = 'trip_cancelled' then
      case when p_has_task then
        (p_task_assignee = p_user or p_task_assignee is null) and (p_entity::text || ':' || p_task_dept) = any (c.dept)
      else p_entity = any (c.acc)
        or (p_deal_branch is not null and not (p_entity = any (c.pfv)) and case
              when p_deal_owner = p_user then (p_entity::text || ':sales') = any (c.dept) or p_deal_branch = any (c.mgr_branches)
              else p_deal_branch = any (c.mgr_branches) and not coalesce(p_owner_qualifies, false) end) end
    when p_kind in ('task_assigned', 'booking_changed') then
      p_has_task and p_task_assignee = p_user and (p_entity::text || ':' || p_task_dept) = any (c.dept)
    when p_kind in ('expense_returned', 'supplier_bill_returned', 'flight_charges_to_enter', 'visa_cancel_decide') then
      p_has_task and (p_task_assignee = p_user or p_task_assignee is null)
      and (p_entity::text || ':' || p_task_dept) = any (c.dept)
    when p_kind in ('payment_decided', 'go_ahead_decided') then
      p_has_task and (p_entity::text || ':' || p_task_dept) = any (c.dept)
    when p_kind = 'fare_decided' then
      (p_entity::text || ':flight') = any (c.dept)
    -- Addendum L6 (20261204000440): the Accounts exception owner (still Accounts of the entity) or SO*.
    when p_kind = 'refund_shortfall' then
      p_entity = any (c.acc)
      or (p_deal_branch is not null and not (p_entity = any (c.pfv)) and case
            when p_deal_owner = p_user then (p_entity::text || ':sales') = any (c.dept) or p_deal_branch = any (c.mgr_branches)
            else p_deal_branch = any (c.mgr_branches) and not coalesce(p_owner_qualifies, false) end)
    when p_kind in ('review_returned', 'review_approved', 'supplier_confirmed', 'task_completed', 'visa_result',
                    'refund_to_request')
         or (p_kind = 'refund_paid' and p_route is distinct from 'requester') then
      p_deal_branch is not null and not (p_entity = any (c.pfv)) and case
        when p_deal_owner = p_user then
          (p_entity::text || ':sales') = any (c.dept) or p_deal_branch = any (c.mgr_branches)
        else p_deal_branch = any (c.mgr_branches) and not coalesce(p_owner_qualifies, false) end
    -- The requester (the Sales owner, or the branch Manager of a Deal without one): still Sales or a branch Manager.
    when p_kind in ('refund_decided', 'refund_paid') then
      not (p_entity = any (c.pfv))
      and ((p_entity::text || ':sales') = any (c.dept) or p_deal_branch = any (c.mgr_branches))
    when p_kind in ('payment_reported', 'receipt_to_verify', 'payment_to_record', 'payment_to_verify',
                    'go_ahead_to_approve', 'tally_exception',
                    'refund_payout_due', 'document_to_release', 'document_to_check', 'credit_note_to_release',
                    'supplier_refund_due') then
      p_entity = any (c.acc)
    when p_kind in ('payment_to_approve', 'funding_to_approve') then
      case when p_route = 'manager'
           then p_deal_branch = any (c.mgr_branches) and not (p_entity = any (c.purchase))
           else p_entity = any (c.acc) end
    when p_kind = 'refund_to_approve' then
      not (p_entity = any (c.pfv))
      and (p_deal_branch = any (c.mgr_branches)
           or (p_route = 'entity' and (p_entity::text || ':manager') = any (c.dept)))
    when p_kind = 'cancellation_to_approve' then
      p_deal_branch = any (c.mgr_branches) and not (p_entity = any (c.pfv))
    when p_kind = 'bank_details_to_approve' then
      (p_entity::text || ':manager') = any (c.dept)
    when p_kind = 'cost_over_budget' then
      p_deal_branch = any (c.mgr_branches)
    when p_kind = 'fare_to_approve' then
      p_deal_branch = any (c.mgr_branches) and not (p_entity = any (c.purchase))
    -- Accounts phase 3 (20261205000410)
    -- 40, 42: still Accounts of the entity (A + Purchase is not A: c.acc excludes it).
    when p_kind in ('bill_held', 'write_off_decided') then
      p_entity = any (c.acc)
    -- 41: still an Approver - a branch Manager of the Deal's branch, or (marker 'entity', LD37) a Manager of the entity.
    when p_kind = 'write_off_to_approve' then
      not (p_entity = any (c.pfv))
      and (p_deal_branch = any (c.mgr_branches)
           or (p_route = 'entity' and (p_entity::text || ':manager') = any (c.dept)))
    -- 43, 44: still SO* of the Deal.
    when p_kind in ('message_failed', 'whatsapp_stopped') then
      p_deal_branch is not null and not (p_entity = any (c.pfv)) and case
        when p_deal_owner = p_user then (p_entity::text || ':sales') = any (c.dept) or p_deal_branch = any (c.mgr_branches)
        else p_deal_branch = any (c.mgr_branches) and not coalesce(p_owner_qualifies, false) end
    -- 45: still the Flight task assignee, or a Flight holder while the task is unassigned.
    when p_kind = 'boarding_pass_due' then
      p_has_task and (p_task_assignee = p_user or p_task_assignee is null)
      and (p_entity::text || ':flight') = any (c.dept)
    -- 46: still a Super Admin of the entity.
    when p_kind = 'timer_stalled' then
      (p_entity::text || ':super_admin') = any (c.dept)
    else false
  end, false)
$$;

create or replace function authz.staff_notice_visible(p_user uuid, p_kind text, p_entity uuid, p_deal uuid, p_task uuid,
  p_subject_kind text, p_subject_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ctx authz.notice_context := authz.notice_context(p_user);
  v_deal public.deals%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_route text;
begin
  if p_user is null or not coalesce(v_ctx.active, false) then
    return false;
  end if;
  if p_deal is not null then
    select * into v_deal from public.deals d where d.id = p_deal;
  end if;
  if p_task is not null then
    select * into v_task from public.fulfilment_tasks t where t.id = p_task;
  end if;
  if p_subject_kind = 'supplier_payment' then
    select r.route into v_route from public.supplier_payment_requests r where r.id = p_subject_id;
  elsif p_subject_kind = 'funding' then
    select f.route into v_route from public.company_funding_requests f where f.id = p_subject_id;
  elsif p_kind in ('refund_to_approve', 'refund_paid', 'write_off_to_approve') then  -- Accounts phase 3 (20261205000410): + 41
    -- Accounts phase 2 (20261204000430): the marker the row was written with.
    select n.params ->> 'status' into v_route from public.staff_notices n
    where n.recipient_user_id = p_user and n.kind = p_kind and n.subject_kind = p_subject_kind and n.subject_id = p_subject_id
    order by n.seq limit 1;
  end if;
  return authz.notice_row_visible(v_ctx, p_user, p_kind, p_entity,
    p_deal is null or (v_deal.id is not null and v_deal.removed_at is null),
    v_deal.branch_id, v_deal.owner_user_id, v_task.id is not null, v_task.department, v_task.assignee_user_id, v_route,
    case when authz.notice_so_kind(p_kind)
              and v_deal.owner_user_id is distinct from p_user and v_deal.branch_id = any (v_ctx.mgr_branches)
         then authz.notice_deal_has_sales_owner(v_deal.id) end);
end;
$$;

create or replace function authz.notice_visible_unread(p_user uuid) returns setof public.staff_notices
language sql stable security definer set search_path = '' as $$
  with c as materialized (select authz.notice_context(p_user) as v)
  select n.*
  from c, public.staff_notices n
  left join public.deals d on d.id = n.deal_id
  left join public.fulfilment_tasks t on t.id = n.task_id
  left join public.supplier_payment_requests sp on n.subject_kind = 'supplier_payment' and sp.id = n.subject_id
  left join public.company_funding_requests cf on n.subject_kind = 'funding' and cf.id = n.subject_id
  where n.recipient_user_id = p_user and n.resolved_at is null and n.done_at is null
    and authz.notice_row_visible(c.v, p_user, n.kind, n.legal_entity_id,
          n.deal_id is null or (d.id is not null and d.removed_at is null),
          d.branch_id, d.owner_user_id, t.id is not null, t.department, t.assignee_user_id,
          coalesce(authz.notice_route(n.kind, n.params, sp.route, cf.route),
                         case when n.kind = 'write_off_to_approve' then n.params ->> 'status' end),
          case when authz.notice_so_kind(n.kind)
                    and d.owner_user_id is distinct from p_user and d.branch_id = any ((c.v).mgr_branches)
               then authz.notice_deal_has_sales_owner(d.id) end)
$$;

create or replace function public.notice_inbox(p_after_seq bigint default null, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_ctx authz.notice_context;
  v_pref public.staff_notice_preferences%rowtype;
  v_sound boolean;
  v_popups boolean;
  v_latest bigint;
  v_items jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'limit';
  end if;
  if p_after_seq is not null and p_after_seq < 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'afterSeq';
  end if;
  -- Accounts phase 2 (20261204000430, contract 8.5): no row = ON.
  select * into v_pref from public.staff_notice_preferences p where p.user_id = v_uid;
  v_sound := coalesce(v_pref.sound_on, true);
  v_popups := coalesce(v_pref.popups_on, true);
  if not authz.notices_enabled() then
    return jsonb_build_object('enabled', false, 'unreadCount', 0, 'urgentCount', 0, 'latestSeq', null,
                              'soundOn', v_sound, 'popupsOn', v_popups, 'pushEnabled', false, 'items', '[]'::jsonb);
  end if;
  v_ctx := authz.notice_context(v_uid);
  select max(n.seq) into v_latest from public.staff_notices n where n.recipient_user_id = v_uid;

  with urgent as (
    select n, 0 as grp from authz.notice_visible_unread(v_uid) n
    where p_after_seq is null
      and (n.priority = 'urgent' or authz.notice_escalated(n.kind, n.created_at, n.done_at, n.resolved_at))
    order by n.seq desc limit p_limit),
  rest as (
    select n, case when p_after_seq is null then 1 else 0 end as grp
    from public.staff_notices n
    left join public.deals d on d.id = n.deal_id
    left join public.fulfilment_tasks t on t.id = n.task_id
    left join public.supplier_payment_requests sp on n.subject_kind = 'supplier_payment' and sp.id = n.subject_id
    left join public.company_funding_requests cf on n.subject_kind = 'funding' and cf.id = n.subject_id
    where n.recipient_user_id = v_uid and (p_after_seq is null or n.seq > p_after_seq)
      and (p_after_seq is not null
           or not (n.resolved_at is null and n.done_at is null
                   and (n.priority = 'urgent' or authz.notice_escalated(n.kind, n.created_at, n.done_at, n.resolved_at))))
      and authz.notice_row_visible(v_ctx, v_uid, n.kind, n.legal_entity_id,
            n.deal_id is null or (d.id is not null and d.removed_at is null),
            d.branch_id, d.owner_user_id, t.id is not null, t.department, t.assignee_user_id,
            coalesce(authz.notice_route(n.kind, n.params, sp.route, cf.route),
                         case when n.kind = 'write_off_to_approve' then n.params ->> 'status' end),
            case when authz.notice_so_kind(n.kind)
                      and d.owner_user_id is distinct from v_uid and d.branch_id = any (v_ctx.mgr_branches)
                 then authz.notice_deal_has_sales_owner(d.id) end)
    order by n.seq desc limit p_limit),
  page as (
    select y.n, y.grp from (select * from urgent union all select * from rest) y
    order by y.grp, (y.n).seq desc limit p_limit)
  select coalesce(jsonb_agg(authz.notice_item_json(p.n) order by p.grp, (p.n).seq desc), '[]'::jsonb) into v_items
  from page p;

  -- Accounts phase 3 (20261205000410): pushEnabled = the closed-browser alerts switch (8.5).
  return jsonb_build_object('enabled', true, 'latestSeq', v_latest, 'soundOn', v_sound, 'popupsOn', v_popups,
                            'pushEnabled', authz.push_enabled(), 'items', v_items)
         || authz.notice_counts(v_uid);
end;
$$;

create or replace function public.notice_history(p_before_seq bigint default null, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_ctx authz.notice_context;
  v_rows public.staff_notices[];
  v_more boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  if p_limit is null or p_limit < 1 or p_limit > 100 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'limit';
  end if;
  if not authz.notices_enabled() then
    return jsonb_build_object('enabled', false, 'items', '[]'::jsonb, 'nextBefore', null);
  end if;
  v_ctx := authz.notice_context(v_uid);
  select coalesce(array_agg(x.n order by (x.n).seq desc), '{}') into v_rows
  from (select n from public.staff_notices n
        left join public.deals d on d.id = n.deal_id
        left join public.fulfilment_tasks t on t.id = n.task_id
        left join public.supplier_payment_requests sp on n.subject_kind = 'supplier_payment' and sp.id = n.subject_id
        left join public.company_funding_requests cf on n.subject_kind = 'funding' and cf.id = n.subject_id
        where n.recipient_user_id = v_uid and (p_before_seq is null or n.seq < p_before_seq)
          and (n.read_at is not null or n.done_at is not null or n.resolved_at is not null)
          and n.created_at >= now() - interval '30 days'
          and authz.notice_row_visible(v_ctx, v_uid, n.kind, n.legal_entity_id,
                n.deal_id is null or (d.id is not null and d.removed_at is null),
                d.branch_id, d.owner_user_id, t.id is not null, t.department, t.assignee_user_id,
                coalesce(authz.notice_route(n.kind, n.params, sp.route, cf.route),
                         case when n.kind = 'write_off_to_approve' then n.params ->> 'status' end),
                case when authz.notice_so_kind(n.kind)
                          and d.owner_user_id is distinct from v_uid and d.branch_id = any (v_ctx.mgr_branches)
                     then authz.notice_deal_has_sales_owner(d.id) end)
        order by n.seq desc limit p_limit + 1) x;
  v_more := cardinality(v_rows) > p_limit;
  if v_more then
    v_rows := v_rows[1:p_limit];
  end if;
  return jsonb_build_object(
    'enabled', true,
    'items', coalesce((select jsonb_agg(authz.notice_item_json(r) order by r.seq desc) from unnest(v_rows) r), '[]'::jsonb),
    'nextBefore', case when v_more then v_rows[p_limit].seq end);
end;
$$;

-- ===========================================================================
-- 3. Notices 30 and 32 silent while automatic bills are on
-- ===========================================================================

create function authz.notice_auto_bills_on(p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.auto_bills_enabled from public.accounts_settings s where s.legal_entity_id = p_entity), false)
$$;

create or replace function authz.notices_on_review_document() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_version_no integer;
  r record;
begin
  if not authz.notice_documents_on(new.legal_entity_id) then
    return null;
  end if;
  select * into v_deal from public.deals d where d.id = new.deal_id;
  select v.version_no into v_version_no from public.booking_versions v where v.id = new.booking_version_id;
  if exists (select 1 from public.customer_documents x where x.deal_id = new.deal_id and x.kind = 'invoice'
             and x.status = 'released' and x.basis_version_id is distinct from new.booking_version_id) then
    -- 31 a released Invoice of an earlier version needs checking.
    for r in
      select x.* from public.customer_documents x where x.deal_id = new.deal_id and x.kind = 'invoice'
        and x.status = 'released' and x.basis_version_id is distinct from new.booking_version_id
      order by x.id
    loop
      perform authz.notice_write('document_to_check', array(select authz.notice_accounts_recipients(new.legal_entity_id)),
        new.legal_entity_id, v_deal.branch_id, new.deal_id, null, 'customer_document', r.id,
        jsonb_build_object('refNo', r.number, 'versionNo', v_version_no),
        'cdoc:' || r.id || ':check:' || v_version_no, 'cdoc:' || r.id || ':check:' || v_version_no);
    end loop;
  elsif not exists (select 1 from public.customer_documents x where x.deal_id = new.deal_id and x.kind = 'invoice'
                    and x.status in ('draft', 'released'))
        and not authz.notice_auto_bills_on(new.legal_entity_id) then  -- Accounts phase 3 (20261205000410): 30 silent while automatic bills are on
    -- 30 an Invoice is ready to draft and release.
    perform authz.notice_write('document_to_release', array(select authz.notice_accounts_recipients(new.legal_entity_id)),
      new.legal_entity_id, v_deal.branch_id, new.deal_id, null, 'booking_version', new.booking_version_id,
      jsonb_build_object('versionNo', v_version_no),
      'cdoc:' || new.deal_id || ':inv:' || new.booking_version_id, 'cdoc:' || new.deal_id || ':inv:' || new.booking_version_id);
  end if;
  return null;
end;
$$;

create or replace function authz.notices_on_receipt_document() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_branch uuid;
  r record;
begin
  select d.branch_id into v_branch from public.deals d where d.id = new.deal_id;
  if new.status in ('verified', 'cleared') and old.status not in ('verified', 'cleared') then
    -- 30 an Advance Invoice can be made for this payment.
    if authz.notice_documents_on(new.legal_entity_id)
       and not authz.notice_auto_bills_on(new.legal_entity_id)  -- Accounts phase 3 (20261205000410): 30 silent while automatic bills are on
       and not exists (select 1 from public.customer_documents x where x.receipt_id = new.id
                       and x.kind = 'advance_invoice' and x.status in ('draft', 'released')) then
      perform authz.notice_write('document_to_release', array(select authz.notice_accounts_recipients(new.legal_entity_id)),
        new.legal_entity_id, v_branch, new.deal_id, null, 'receipt', new.id, jsonb_build_object('refNo', new.receipt_no),
        'cdoc:' || new.id || ':adv', 'cdoc:' || new.id || ':adv');
    end if;
  elsif old.status in ('verified', 'cleared') and new.status not in ('verified', 'cleared') then
    -- No longer money: nothing to release; a released Advance Invoice needs checking (31, LD7).
    perform authz.notice_resolve('cdoc:' || new.id || ':adv', 'superseded');
    for r in
      select x.* from public.customer_documents x where x.receipt_id = new.id and x.kind = 'advance_invoice'
        and x.status = 'released' order by x.id
    loop
      perform authz.notice_write('document_to_check', array(select authz.notice_accounts_recipients(new.legal_entity_id)),
        new.legal_entity_id, v_branch, new.deal_id, null, 'customer_document', r.id, jsonb_build_object('refNo', r.number),
        'cdoc:' || r.id || ':check:payment', 'cdoc:' || r.id || ':check:payment');
    end loop;
  end if;
  return null;
end;
$$;

create or replace function authz.notice_credit_note(p_request public.customer_refund_requests) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if authz.notice_documents_on(p_request.legal_entity_id)
     and not authz.notice_auto_bills_on(p_request.legal_entity_id)  -- Accounts phase 3 (20261205000410): 32 silent while automatic bills are on
     and authz.cdoc_credit_note_source(p_request.id) is not null
     and not exists (select 1 from public.customer_documents x where x.refund_request_id = p_request.id
                     and x.kind = 'credit_note' and x.status = 'released') then
    perform authz.notice_write('credit_note_to_release', array(select authz.notice_accounts_recipients(p_request.legal_entity_id)),
      p_request.legal_entity_id, p_request.branch_id, p_request.deal_id, null, 'refund_request', p_request.id,
      jsonb_build_object('refNo', p_request.ref_no), 'cdoc:' || p_request.id || ':cn', 'cdoc:' || p_request.id || ':cn');
  end if;
end;
$$;

-- ===========================================================================
-- 4. 40 bill_held
-- ===========================================================================

create function authz.notices_on_bill_held() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_key text := 'cdoc:' || new.id || ':held';
  v_branch uuid;
begin
  -- Resolved when the automatic draft leaves 'held' (ready, released or discarded).
  if tg_op = 'UPDATE' and old.auto_state = 'held' and new.auto_state is distinct from 'held' then
    perform authz.notice_resolve(v_key, 'acted');
    return null;
  end if;
  if new.auto_state = 'held'
     and (tg_op = 'INSERT' or old.auto_state is distinct from 'held' or old.hold_reasons is distinct from new.hold_reasons)
     and not exists (select 1 from public.staff_notices n
                     where n.shared_key = v_key and n.resolved_at is null and n.done_at is null) then
    select d.branch_id into v_branch from public.deals d where d.id = new.deal_id;
    perform authz.notice_write('bill_held', array(select authz.notice_accounts_recipients(new.legal_entity_id)),
      new.legal_entity_id, v_branch, new.deal_id, null, 'customer_document', new.id, '{}'::jsonb,
      v_key || ':' || (extract(epoch from clock_timestamp()) * 1000000)::bigint, v_key);
  end if;
  return null;
end;
$$;
-- Plain UPDATE triggers with WHEN: track B's BEFORE trigger clears auto_state when a draft is released or
-- discarded without naming the column, so "UPDATE OF auto_state" would miss it.
create trigger customer_documents_notices_held_insert after insert on public.customer_documents
  for each row when (new.auto_state = 'held')
  execute function authz.notices_on_bill_held();
create trigger customer_documents_notices_held after update on public.customer_documents
  for each row when (old.auto_state is distinct from new.auto_state or old.hold_reasons is distinct from new.hold_reasons)
  execute function authz.notices_on_bill_held();

-- ===========================================================================
-- 5. 41, 42 write-offs
-- ===========================================================================

create function authz.notices_on_write_off() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old text := case when tg_op = 'UPDATE' then old.status end;
  v_to uuid[];
  v_entity_rule boolean := false;
begin
  -- 41 resolved when the status leaves "proposed".
  if v_old = 'proposed' and new.status <> 'proposed' then
    perform authz.notice_resolve('wo:' || new.id || ':approve', 'acted');
  end if;
  if tg_op = 'INSERT' and new.status = 'proposed' then
    v_to := array_remove(array(select authz.notice_branch_m_recipients(new.legal_entity_id, new.branch_id)), new.proposed_by);
    if cardinality(v_to) = 0 then
      -- LD37: the only branch Manager is the proposer (or there is none): any other Manager of the entity.
      v_entity_rule := true;
      v_to := array(select u from authz.notice_entity_m_recipients(new.legal_entity_id) as u
                    where u is distinct from new.proposed_by
                      and not authz.notice_user_holds(u, new.legal_entity_id, array['accounts']));
    end if;
    perform authz.notice_write('write_off_to_approve', v_to, new.legal_entity_id, new.branch_id, new.deal_id, null,
      'write_off', new.id, jsonb_build_object('refNo', new.ref_no, 'status', case when v_entity_rule then 'entity' end),
      'wo:' || new.id || ':approve', 'wo:' || new.id || ':approve');
  end if;
  if tg_op = 'UPDATE' and new.status in ('approved', 'returned', 'undone') and v_old is distinct from new.status then
    perform authz.notice_write('write_off_decided', array[new.proposed_by], new.legal_entity_id, new.branch_id,
      new.deal_id, null, 'write_off', new.id, jsonb_build_object('refNo', new.ref_no, 'status', new.status),
      'wo:' || new.id || ':' || new.status, null);
  end if;
  return null;
end;
$$;
create trigger deal_write_offs_notices_insert after insert on public.deal_write_offs
  for each row execute function authz.notices_on_write_off();
create trigger deal_write_offs_notices_status after update on public.deal_write_offs
  for each row when (old.status is distinct from new.status)
  execute function authz.notices_on_write_off();

-- ===========================================================================
-- 6. 43, 44 customer messages
-- ===========================================================================

create function authz.notices_on_message_alert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'message_failed' then
    perform authz.notice_write('message_failed', array(select authz.notice_so_star_recipients(new.deal_id)),
      new.legal_entity_id, new.branch_id, new.deal_id, null, 'customer_message', new.message_id, '{}'::jsonb,
      'cmsg:' || new.message_id, 'cmsg:' || new.message_id);
  elsif new.kind = 'whatsapp_stopped' then
    perform authz.notice_write('whatsapp_stopped', array(select authz.notice_so_star_recipients(new.deal_id)),
      new.legal_entity_id, new.branch_id, new.deal_id, null, 'customer_message', new.id, '{}'::jsonb,
      'cmsg:stop:' || new.deal_id, null);
  end if;
  return null;
end;
$$;
create trigger customer_message_alerts_notices after insert on public.customer_message_alerts
  for each row execute function authz.notices_on_message_alert();

-- 43 resolved when a re-send of the failed message (or of a re-send of it) is sent.
create function authz.notices_on_message_sent() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  for r in
    with recursive chain(id, resend_of, depth) as (
      select m.id, m.resend_of, 0 from public.customer_messages m where m.id = new.resend_of
      union all
      select m.id, m.resend_of, c.depth + 1 from public.customer_messages m join chain c on m.id = c.resend_of
      where c.depth < 20)
    select c.id from chain c order by c.depth
  loop
    perform authz.notice_resolve('cmsg:' || r.id, 'acted');
  end loop;
  return null;
end;
$$;
create trigger customer_messages_notices_sent after update on public.customer_messages
  for each row when (new.resend_of is not null and new.status in ('sent', 'delivered', 'read')
                     and old.status not in ('sent', 'delivered', 'read'))
  execute function authz.notices_on_message_sent();

-- ===========================================================================
-- 7. 45 boarding pass due
-- ===========================================================================

create function authz.notices_on_boarding_pass_alert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_key text := 'bp:' || new.task_id || ':' || new.sector_id;
begin
  select * into v_task from public.fulfilment_tasks t where t.id = new.task_id;
  if v_task.id is null then
    return null;
  end if;
  perform authz.notice_write('boarding_pass_due', authz.notice_task_or_queue(v_task.id), v_task.legal_entity_id,
    v_task.branch_id, v_task.deal_id, v_task.id, 'flight_alert', new.id,
    jsonb_build_object('department', 'flight', 'serviceType', 'flight'), v_key, v_key);
  return null;
end;
$$;
create trigger flight_boarding_pass_alerts_notices after insert on public.flight_boarding_pass_alerts
  for each row execute function authz.notices_on_boarding_pass_alert();

-- 45 resolved when a boarding pass of the task is stored.
create function authz.notices_on_boarding_pass_stored() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  k text;
begin
  for k in
    select distinct n.shared_key from public.staff_notices n
    where n.task_id = new.task_id and n.kind = 'boarding_pass_due' and n.resolved_at is null and n.shared_key is not null
    order by 1
  loop
    perform authz.notice_resolve(k, 'acted');
  end loop;
  return null;
end;
$$;
create trigger department_evidence_notices_boarding_pass_insert after insert on public.department_evidence
  for each row when (new.kind = 'boarding_pass' and new.status = 'stored')
  execute function authz.notices_on_boarding_pass_stored();
create trigger department_evidence_notices_boarding_pass after update on public.department_evidence
  for each row when (new.kind = 'boarding_pass' and new.status = 'stored' and old.status is distinct from 'stored')
  execute function authz.notices_on_boarding_pass_stored();

-- ===========================================================================
-- 8. 46 timer stalled
-- ===========================================================================

create function authz.notices_on_timer_alert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  e record;
  v_key text := 'timer:' || new.hour_key;
begin
  if not authz.notices_enabled() then
    return null;
  end if;
  for e in select le.id from public.legal_entities le where le.status = 'enabled' order by le.id loop
    perform authz.notice_write('timer_stalled',
      array(select distinct m.user_id from public.memberships m
            where m.legal_entity_id = e.id and m.role_code = 'super_admin' and m.status = 'active'
              and authz.is_active_department_person(m.user_id, e.id, 'super_admin')
            order by 1),
      e.id, null, null, null, 'timer', new.id, '{}'::jsonb, v_key, v_key);
  end loop;
  return null;
end;
$$;
create trigger timer_alerts_notices after insert on public.timer_alerts
  for each row execute function authz.notices_on_timer_alert();

-- The timer is healthy: on time, and no due customer message or push job waited more than 15 minutes.
create function authz.notice_timer_healthy() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.last_ok_at >= now() - interval '15 minutes' from public.timer_settings s where s.id), false)
    and not exists (select 1 from public.customer_messages m
                    where m.status = 'queued' and m.next_attempt_at <= now() - interval '15 minutes'
                      and m.not_before <= now() - interval '15 minutes')
    and not exists (select 1 from public.staff_push_jobs j
                    where j.status = 'queued' and j.available_at <= now() - interval '15 minutes')
$$;

-- 46 resolved at the next good tick (a notice written in this same tick stays open).
create function authz.notices_on_timer_ok() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  k text;
begin
  begin
    if not exists (select 1 from public.staff_notices n
                   where n.subject_kind = 'timer' and n.resolved_at is null and n.created_at < now()) then
      return null;
    end if;
    if not authz.notice_timer_healthy() then
      return null;
    end if;
    for k in
      select distinct n.shared_key from public.staff_notices n
      where n.subject_kind = 'timer' and n.kind = 'timer_stalled' and n.resolved_at is null
        and n.created_at < now() and n.shared_key is not null
      order by 1
    loop
      perform authz.notice_resolve(k, 'acted');
    end loop;
  exception when others then
    -- Never fails the tick; the next tick tries again.
    null;
  end;
  return null;
end;
$$;
create trigger timer_settings_notices_ok after update of last_ok_at on public.timer_settings
  for each row when (new.last_ok_at is distinct from old.last_ok_at)
  execute function authz.notices_on_timer_ok();

-- ===========================================================================
-- 9. Grants
-- ===========================================================================

revoke all on function
  authz.notice_auto_bills_on(uuid),
  authz.notices_on_bill_held(),
  authz.notices_on_write_off(),
  authz.notices_on_message_alert(),
  authz.notices_on_message_sent(),
  authz.notices_on_boarding_pass_alert(),
  authz.notices_on_boarding_pass_stored(),
  authz.notices_on_timer_alert(),
  authz.notice_timer_healthy(),
  authz.notices_on_timer_ok()
from public, anon, authenticated, service_role;
-- staff_notice_visible keeps its execute grant to authenticated (the select policy calls it).

commit;
