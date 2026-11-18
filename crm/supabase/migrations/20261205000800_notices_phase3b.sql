-- TripNavigate CRM - Accounts phase 3, track N: Release B notices (kinds
-- 50-60, 53 and 55 unused) and the two widened kinds (3 booking_changed,
-- 19 cost_over_budget).
-- Contract: accounts-phase3-2026-11-12/contract.md sections 12, 13, 14
-- (Purchase, Flight and Visa never see selling price, customer money or
-- write-offs in any notice, push body or audit), 16.1 N, 19 (N after D, same
-- owner; N adds notices_on_outbox and notices_on_cost_approval), 21 LD34;
-- Addenda L2, L5, L7, L8, L9 (closed tasks are not open work). Notice rows
-- carry template keys and references only (refNo = CR-... / RC-...); never
-- names, amounts, PAN, phone, e-mail, PNR, ticket numbers or message text.
-- Push (8.2) follows by itself: D's staff_notices trigger queues a job for
-- every urgent notice; the body is the bell text built in TypeScript.
--
-- Kinds (recipients exclude the actor, Phase 1 R16.7; none is a money kind
-- except 19):
--   50 change_to_approve  booking_change_requests insert / resubmit
--      (returned -> requested); for a booked removal (route cancellation)
--      only once every supplier charge is entered (written then by the charge
--      tables' triggers) -> Approvers: branch Managers of the Deal (no
--      Purchase / Flight / Visa) except the requester; none -> every other
--      active Manager of the entity (LD37; params.status 'entity'); never a
--      person who entered a current charge. Urgent. Shared
--      cr:<id>:approve:<rv>, resolved when the status leaves requested.
--   51 change_decided  requested -> approved / returned -> the requester.
--      Returned urgent, approved normal. Dedup cr:<id>:<status>:<rv>.
--   52 reconfirm_supplier  task_reconfirmations insert -> the task assignee,
--      else Purchase holders. Urgent. Shared reconf:<id>, resolved when the
--      status leaves pending.
--   54 change_not_possible  request -> not_possible -> the requester and SO*.
--      Urgent. Dedup cr:<id>:not_possible.
--   56 reconfirm_undo  reconfirmation recorded -> void (a withdrawal, or
--      another supplier refused, R4) -> its recorder and the task assignee.
--      Urgent. Dedup reconf:<id>:void.
--   57 removal_charges_to_enter  remove_service request, route cancellation,
--      with charges still to enter -> per service task: the assignee, else
--      the department holders. Urgent. Shared cr:<id>:charges, resolved when
--      the charges are complete or the request ends.
--   58 contract_to_approve  rate_contracts -> pending_approval -> Managers of
--      the entity without Purchase / Flight / Visa (Addendum L2), not the
--      enterer. Normal. Shared rc:<id>:approve:<rv>, resolved when the status
--      leaves pending_approval.
--   59 contract_decided  pending_approval -> active / returned -> the
--      enterer. Returned urgent, else normal. Dedup rc:<id>:<status>:<rv>
--      (the row version keeps a second return of the same contract visible).
--   60 contract_ending  rate_contract_alerts insert -> Purchase holders and
--      Managers of the entity (no Purchase / Flight / Visa). Normal. Dedup
--      rc:<id>:ending:<days>; params.status carries the days (30 | 7).
--   3 (widened) booking_changed  also to Accounts of the entity (task null,
--      dedup booking_changed:<version>:accounts) when the revised version was
--      applied by a change request (booking_versions.change_request_id).
--      Urgent, as today. Task rows skip closed tasks.
--   19 (widened) cost_over_budget  task_reconfirmations -> recorded with
--      over_budget -> branch Managers of the Deal (the over-budget approver
--      needs can_manage_purchase_task) except the recorder. Urgent, money.
--      Shared reconf:<id>:budget, resolved when approved, refused, void or
--      applied (and by the cost approval row that names the reconfirmation).
-- Closed tasks (Addendum L9): a task closing (closed_state set) resolves its
-- open notices; the bell reads, the access re-check and the push re-check
-- hide work notices of a closed task; the cancellation and change fan-outs
-- skip closed tasks.
--
-- Replaced (latest bodies re-confirmed with the sorted grep, same signatures;
-- changed lines marked "Accounts phase 3 (20261205000800)"):
--   authz.notice_kinds, authz.notice_write, authz.notice_link,
--   authz.notice_row_visible, authz.staff_notice_visible,
--   authz.notice_visible_unread, public.notice_inbox, public.notice_history
--   (20261205000410, track D);
--   authz.notices_on_outbox, authz.notices_on_cost_approval
--   (20261203000450); authz.notices_on_cancellation (20261204000430).
-- staff_notices.subject_kind check adds change_request, reconfirmation,
-- rate_contract. Params keys unchanged.
-- New trigger functions on booking_change_requests, task_reconfirmations,
-- purchase_cancellation_charges, flight_cancellation_charges,
-- visa_cancellation_fees, rate_contracts, rate_contract_alerts and
-- fulfilment_tasks (closed_state). Writers do nothing while notices are off;
-- resolutions always run. No trigger catches errors (Phase 1 R1).
--
-- Refusal tokens: none.
-- Rollback (forward-only): a NEW migration dropping the new triggers and
-- functions and restoring the replaced bodies (20261205000410, 20261203000450,
-- 20261204000430). Never delete notice rows.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Kinds, subject kinds, priority, links
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
               'boarding_pass_due', 'timer_stalled',
               -- Accounts phase 3 (20261205000800): 50-60 (53 and 55 unused).
               'change_to_approve', 'change_decided', 'reconfirm_supplier', 'change_not_possible', 'reconfirm_undo',
               'removal_charges_to_enter', 'contract_to_approve', 'contract_decided', 'contract_ending']
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
  'write_off', 'customer_message', 'flight_alert', 'timer',
  -- Accounts phase 3 (20261205000800)
  'change_request', 'reconfirmation', 'rate_contract'));

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
    -- Accounts phase 3 (20261205000800): 50, 52, 54, 56, 57 urgent; 51 and 59 urgent when returned.
    when p_kind in ('change_to_approve', 'reconfirm_supplier', 'change_not_possible', 'reconfirm_undo',
                    'removal_charges_to_enter') then 'urgent'
    when p_kind in ('change_decided', 'contract_decided') and v_params ->> 'status' = 'returned' then 'urgent'
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
    -- Accounts phase 3 (20261205000800): the Accounts row of a change applied by a change request (no task)
    -- opens the Deal's changes card.
    when p_kind = 'booking_changed' and p_task is null then
      return jsonb_build_object('kind', 'deal_changes', 'id', p_deal);
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
    -- Accounts phase 3 (20261205000800): 19 of a reconfirmation is approved on the Purchase task
    -- ("Reconfirm with supplier", R-G3).
    when p_kind = 'cost_over_budget' and p_subject_kind = 'reconfirmation' and p_task is not null then
      return jsonb_build_object('kind', 'task', 'id', p_task);
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
    -- Accounts phase 3 (20261205000800): 50 and 58 the Manager's Approvals page; 51 and 54 the Deal's changes
    -- card; 52, 56 and 57 the department task; 59 and 60 the rate contract.
    when p_kind in ('change_to_approve', 'contract_to_approve') then
      return jsonb_build_object('kind', 'approvals', 'id', p_subject_id);
    when p_kind in ('change_decided', 'change_not_possible') then
      return jsonb_build_object('kind', 'deal_changes', 'id', p_deal);
    when p_kind in ('reconfirm_supplier', 'reconfirm_undo', 'removal_charges_to_enter') then
      return case when p_task is null then null else jsonb_build_object('kind', 'task', 'id', p_task) end;
    when p_kind in ('contract_decided', 'contract_ending') then
      return jsonb_build_object('kind', 'rate_contract', 'id', p_subject_id);
    else
      return null;
  end case;
end;
$$;

-- Accounts phase 3 (20261205000800, Addendum L9): kinds that are work on their task. A notice of one of these
-- kinds about a closed task (closed_state set) is not shown, re-checked or pushed. Inlined (no SET, no table).
create function authz.notice_task_work_kind(p_kind text) returns boolean
language sql immutable as $$
  select p_kind in ('task_new', 'task_assigned', 'booking_changed', 'trip_cancelled', 'expense_returned',
                    'supplier_bill_returned', 'payment_decided', 'go_ahead_decided', 'cost_over_budget',
                    'flight_charges_to_enter', 'visa_cancel_decide', 'boarding_pass_due',
                    'reconfirm_supplier', 'reconfirm_undo', 'removal_charges_to_enter')
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
    -- Accounts phase 3 (20261205000800): 3 widened - the Accounts row of a change applied by a change request
    -- (no task): still Accounts of the entity (A + Purchase is not A).
    when p_kind = 'booking_changed' and not coalesce(p_has_task, false) then
      p_entity = any (c.acc)
    when p_kind in ('task_assigned', 'booking_changed') then
      p_has_task and p_task_assignee = p_user and (p_entity::text || ':' || p_task_dept) = any (c.dept)
    -- Accounts phase 3 (20261205000800): + 52, 57 (the task assignee, or the department queue while unassigned).
    when p_kind in ('expense_returned', 'supplier_bill_returned', 'flight_charges_to_enter', 'visa_cancel_decide',
                    'reconfirm_supplier', 'removal_charges_to_enter') then
      p_has_task and (p_task_assignee = p_user or p_task_assignee is null)
      and (p_entity::text || ':' || p_task_dept) = any (c.dept)
    -- Accounts phase 3 (20261205000800): + 56 (its recorder or the assignee: still in the task's department).
    when p_kind in ('payment_decided', 'go_ahead_decided', 'reconfirm_undo') then
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
    -- Accounts phase 3 (20261205000800): + 51, 54 (the requester and SO* of a change request).
    when p_kind in ('refund_decided', 'refund_paid', 'change_decided', 'change_not_possible') then
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
    -- Accounts phase 3 (20261205000800): + 50 (still an Approver: a branch Manager of the Deal's branch, or - marker
    -- 'entity', LD37 - a Manager of the entity; never with Purchase / Flight / Visa).
    when p_kind in ('refund_to_approve', 'change_to_approve') then
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
    -- Accounts phase 3 (20261205000800): rate contracts (P, M, A only; Addendum L2: a Manager with Flight or Visa
    -- does not read or approve them).
    -- 58: still a Manager of the entity without Purchase / Flight / Visa.
    when p_kind = 'contract_to_approve' then
      (p_entity::text || ':manager') = any (c.dept) and not (p_entity = any (c.pfv))
    -- 59: the enterer, still Purchase of the entity.
    when p_kind = 'contract_decided' then
      (p_entity::text || ':purchase') = any (c.dept)
    -- 60: still Purchase, or a Manager without Purchase / Flight / Visa.
    when p_kind = 'contract_ending' then
      (p_entity::text || ':purchase') = any (c.dept)
      or ((p_entity::text || ':manager') = any (c.dept) and not (p_entity = any (c.pfv)))
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
    -- Accounts phase 3 (20261205000800, Addendum L9): no work notice for a closed task.
    if v_task.closed_state is not null and authz.notice_task_work_kind(p_kind) then
      return false;
    end if;
  end if;
  if p_subject_kind = 'supplier_payment' then
    select r.route into v_route from public.supplier_payment_requests r where r.id = p_subject_id;
  elsif p_subject_kind = 'funding' then
    select f.route into v_route from public.company_funding_requests f where f.id = p_subject_id;
  elsif p_kind in ('refund_to_approve', 'refund_paid', 'write_off_to_approve',
                   'change_to_approve') then  -- Accounts phase 3 (20261205000800): + 50
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
    -- Accounts phase 3 (20261205000800, Addendum L9): no work notice for a closed task.
    and (t.closed_state is null or not authz.notice_task_work_kind(n.kind))
    and authz.notice_row_visible(c.v, p_user, n.kind, n.legal_entity_id,
          n.deal_id is null or (d.id is not null and d.removed_at is null),
          d.branch_id, d.owner_user_id, t.id is not null, t.department, t.assignee_user_id,
          coalesce(authz.notice_route(n.kind, n.params, sp.route, cf.route),
                   case when n.kind in ('write_off_to_approve', 'change_to_approve')  -- Accounts phase 3 (20261205000800): + 50
                        then n.params ->> 'status' end),
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
      -- Accounts phase 3 (20261205000800, Addendum L9): no work notice for a closed task.
      and (t.closed_state is null or not authz.notice_task_work_kind(n.kind))
      and authz.notice_row_visible(v_ctx, v_uid, n.kind, n.legal_entity_id,
            n.deal_id is null or (d.id is not null and d.removed_at is null),
            d.branch_id, d.owner_user_id, t.id is not null, t.department, t.assignee_user_id,
            coalesce(authz.notice_route(n.kind, n.params, sp.route, cf.route),
                     case when n.kind in ('write_off_to_approve', 'change_to_approve')  -- Accounts phase 3 (20261205000800): + 50
                          then n.params ->> 'status' end),
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
          -- Accounts phase 3 (20261205000800, Addendum L9): no work notice for a closed task.
          and (t.closed_state is null or not authz.notice_task_work_kind(n.kind))
          and authz.notice_row_visible(v_ctx, v_uid, n.kind, n.legal_entity_id,
                n.deal_id is null or (d.id is not null and d.removed_at is null),
                d.branch_id, d.owner_user_id, t.id is not null, t.department, t.assignee_user_id,
                coalesce(authz.notice_route(n.kind, n.params, sp.route, cf.route),
                         case when n.kind in ('write_off_to_approve', 'change_to_approve')  -- Accounts phase 3 (20261205000800): + 50
                              then n.params ->> 'status' end),
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
-- 3. Widened 3 (booking_changed to Accounts) and the outbox fan-out
-- ===========================================================================

-- Replaces 20261203000450_notices_review_fixes.sql:327 (latest body; changed lines marked).
create or replace function authz.notices_on_outbox() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_deal uuid;
  v_version uuid;
  v_version_no integer;
  v_change_request uuid;  -- Accounts phase 3 (20261205000800)
  v_entity uuid;
  v_branch uuid;
  r record;
begin
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
    select v.deal_id, v.version_no, v.change_request_id, v.legal_entity_id
    into v_deal, v_version_no, v_change_request, v_entity
    from public.booking_versions v where v.id = v_version;
    if v_deal is null then
      return null;
    end if;
    for r in
      select t.* from public.fulfilment_tasks t
      where authz.notices_enabled() and t.deal_id = v_deal and t.status = 'in_progress' and t.assignee_user_id is not null
        and t.closed_state is null  -- Accounts phase 3 (20261205000800, Addendum L9): a closed task is not open work
        and exists (select 1 from public.service_item_facts f
                    where f.service_item_id = t.service_item_id and f.booking_version_id = v_version)
        -- Accounts phase (20261203000450, L1 review 4): only items whose facts or
        -- participants changed; a Purchase task only when its banner is not empty.
        and authz.notice_item_changed(t.service_item_id, (new.payload ->> 'base_version_id')::uuid, v_version)
        and (t.department <> 'purchase' or authz.purchase_booking_diff(t.id) is not null)
      order by t.id
    loop
      perform authz.notice_write('booking_changed', array[r.assignee_user_id], r.legal_entity_id, r.branch_id,
        r.deal_id, r.id, 'task', r.id,
        jsonb_build_object('department', r.department, 'serviceType', r.service_purpose, 'versionNo', v_version_no),
        'booking_changed:' || v_version || ':' || r.id, null);
    end loop;
    -- Accounts phase 3 (20261205000800, contract 12 kind 3, R5): a version applied by a change request moved dues,
    -- bills and supplier payment gates without an Accounts step - Accounts of the entity are told (no task).
    if v_change_request is not null then
      select d.branch_id into v_branch from public.deals d where d.id = v_deal;
      perform authz.notice_write('booking_changed', array(select authz.notice_accounts_recipients(v_entity)),
        v_entity, v_branch, v_deal, null, 'booking_version', v_version, jsonb_build_object('versionNo', v_version_no),
        'booking_changed:' || v_version || ':accounts', null);
    end if;
    perform authz.notice_resolve('review_returned:' || v_deal, 'revised');
  end if;
  return null;
end;
$$;

-- Replaces 20261203000450_notices_review_fixes.sql:621 (latest body; changed lines marked).
create or replace function authz.notices_on_cost_approval() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform authz.notice_resolve('cost:' || new.task_id, 'acted');
  -- Accounts phase 3 (20261205000800): the approval row of a reconfirmation (written at apply) also resolves 19.
  if new.reconfirmation_id is not null then
    perform authz.notice_resolve('reconf:' || new.reconfirmation_id || ':budget', 'acted');
  end if;
  return null;
end;
$$;

-- ===========================================================================
-- 4. Trip cancellation skips closed tasks (Addendum L9)
-- ===========================================================================

-- Replaces 20261204000430_notices_phase2.sql:530 (latest body; changed lines marked).
create or replace function authz.notices_on_cancellation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  -- Every open task: the assignee, or the department queue while unassigned.
  for r in
    select t.* from public.fulfilment_tasks t
    where t.deal_id = new.deal_id and t.status in ('not_started', 'in_progress', 'supplier_confirmed')
      and t.closed_state is null  -- Accounts phase 3 (20261205000800, Addendum L9): a closed task is not open work
    order by t.id
  loop
    perform authz.notice_write('trip_cancelled', authz.notice_task_or_queue(r.id), r.legal_entity_id, r.branch_id,
      r.deal_id, r.id, 'cancellation', new.id,
      jsonb_build_object('department', r.department, 'serviceType', r.service_purpose),
      'cancel:' || new.id || ':' || r.id, null);
  end loop;
  -- The Sales owner (SO*) and Accounts of the entity.
  perform authz.notice_write('trip_cancelled',
    array(select authz.notice_so_star_recipients(new.deal_id))
      || array(select authz.notice_accounts_recipients(new.legal_entity_id)),
    new.legal_entity_id, new.branch_id, new.deal_id, null, 'cancellation', new.id, '{}'::jsonb,
    'cancel:' || new.id || ':deal', null);
  -- 36: per ticket batch, the cost task assignee or the Flight queue.
  for r in
    select b.* from public.flight_ticket_batches b
    join public.fulfilment_tasks ct on ct.id = b.cost_task_id
      and ct.closed_state is null  -- Accounts phase 3 (20261205000800): as authz.cancellation_charges_missing (20261205000730)
    where b.deal_id = new.deal_id order by b.batch_no, b.id
  loop
    perform authz.notice_write('flight_charges_to_enter', authz.notice_task_or_queue(r.cost_task_id), r.legal_entity_id,
      r.branch_id, r.deal_id, r.cost_task_id, 'flight_batch', r.id,
      jsonb_build_object('department', 'flight', 'serviceType', 'flight'),
      'cancel:' || new.id || ':flight:' || r.id, 'cancel:' || new.id || ':flight:' || r.id);
  end loop;
  return null;
end;
$$;

-- A task closed by a service removal: its open notices are resolved (they are no longer work).
create function authz.notices_on_task_closed() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_count integer;
  v_kinds text[];
begin
  with target as (
    select n.id from public.staff_notices n
    where n.task_id = new.id and n.resolved_at is null
    order by n.id for update),
  done as (
    update public.staff_notices n set resolved_at = now(), resolved_reason = 'superseded'
    from target where n.id = target.id returning n.kind)
  select count(*), array_agg(distinct done.kind) into v_count, v_kinds from done;
  if v_count > 0 then
    perform authz.write_audit('notice.resolved', new.legal_entity_id, new.branch_id, 'task', new.id, null,
      jsonb_build_object('kind', case when cardinality(v_kinds) = 1 then v_kinds[1] else 'several' end,
                         'reason', 'superseded', 'count', v_count));
  end if;
  return null;
end;
$$;
create trigger fulfilment_tasks_notices_closed after update of closed_state on public.fulfilment_tasks
  for each row when (old.closed_state is null and new.closed_state is not null)
  execute function authz.notices_on_task_closed();

-- ===========================================================================
-- 5. 50, 51, 54, 57 change requests
-- ===========================================================================

-- 57: a booked removal still has supplier charges to enter (track H's charge list).
create function authz.notice_removal_charges_open(p_change_request uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from authz.cr_removal_charges(p_change_request) c where not c.complete)
$$;

-- 50 to the Approvers of a request still waiting for a decision.
create function authz.notice_change_to_approve(p_change_request uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.booking_change_requests%rowtype;
  v_to uuid[];
  v_entity_rule boolean := false;
  v_key text;
begin
  select * into v from public.booking_change_requests r where r.id = p_change_request;
  if v.id is null or v.status <> 'requested' or not authz.notices_enabled() then
    return;
  end if;
  -- Approver (contract 4, LD37; authz.cr_is_approver): a branch Manager of the Deal's branch without
  -- Purchase / Flight / Visa, not the requester; none -> any other active Manager of the entity.
  v_to := array(select u from authz.notice_branch_m_recipients(v.legal_entity_id, v.branch_id) as u
                where u is distinct from v.requested_by order by 1);
  if cardinality(v_to) = 0 then
    v_entity_rule := true;
    v_to := array(select u from authz.notice_entity_m_recipients(v.legal_entity_id) as u
                  where u is distinct from v.requested_by order by 1);
  end if;
  -- A person who entered a current charge of a booked removal never approves it (track H, not_self_approval).
  if v.kind = 'remove_service' and v.removal_route = 'cancellation' then
    v_to := array(select u from unnest(v_to) as u
                  where not exists (select 1 from authz.cr_removal_charges(v.id) c where c.entered_by = u));
  end if;
  v_key := 'cr:' || v.id || ':approve:' || v.row_version;
  perform authz.notice_write('change_to_approve', v_to, v.legal_entity_id, v.branch_id, v.deal_id, null,
    'change_request', v.id, jsonb_build_object('refNo', v.ref_no, 'status', case when v_entity_rule then 'entity' end),
    v_key, v_key);
end;
$$;

-- 57 per service task with a charge still to enter: the assignee, else the department queue.
create function authz.notice_removal_charges(p_change_request uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  r record;
  v_key text := 'cr:' || p_change_request || ':charges';
begin
  if not authz.notices_enabled() then
    return;
  end if;
  for r in
    select t.* from public.fulfilment_tasks t
    where t.id in (select c.task_id from authz.cr_removal_charges(p_change_request) c where not c.complete)
      and t.closed_state is null
    order by t.id
  loop
    perform authz.notice_write('removal_charges_to_enter', authz.notice_task_or_queue(r.id), r.legal_entity_id,
      r.branch_id, r.deal_id, r.id, 'change_request', p_change_request,
      jsonb_build_object('department', r.department, 'serviceType', r.service_purpose), v_key, v_key);
  end loop;
end;
$$;

create function authz.notices_on_change_request() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old text := case when tg_op = 'UPDATE' then old.status end;
begin
  -- 50 resolved when the status leaves "requested".
  if v_old = 'requested' and new.status <> 'requested' then
    perform authz.notice_resolve_subject('change_to_approve', 'change_request', new.id, 'acted');
  end if;
  -- 57 resolved when the request ends.
  if new.status in ('applied', 'not_possible', 'withdrawn') then
    perform authz.notice_resolve('cr:' || new.id || ':charges', 'superseded');
  end if;
  if not authz.notices_enabled() then
    return null;
  end if;
  -- 50 on insert and on resubmit; a booked removal first asks the departments for the supplier charges (57).
  if new.status = 'requested' and (tg_op = 'INSERT' or v_old is distinct from 'requested') then
    if new.kind = 'remove_service' and new.removal_route = 'cancellation' and authz.notice_removal_charges_open(new.id) then
      perform authz.notice_removal_charges(new.id);
    else
      perform authz.notice_change_to_approve(new.id);
    end if;
  end if;
  -- 51 to the requester.
  if v_old = 'requested' and new.status in ('approved', 'returned') then
    perform authz.notice_write('change_decided', array[new.requested_by], new.legal_entity_id, new.branch_id,
      new.deal_id, null, 'change_request', new.id, jsonb_build_object('refNo', new.ref_no, 'status', new.status),
      'cr:' || new.id || ':' || new.status || ':' || new.row_version, null);
  end if;
  -- 54 to the requester and SO*.
  if new.status = 'not_possible' and v_old is distinct from 'not_possible' then
    perform authz.notice_write('change_not_possible',
      array[new.requested_by] || array(select authz.notice_so_star_recipients(new.deal_id)),
      new.legal_entity_id, new.branch_id, new.deal_id, null, 'change_request', new.id,
      jsonb_build_object('refNo', new.ref_no), 'cr:' || new.id || ':not_possible', null);
  end if;
  return null;
end;
$$;
create trigger booking_change_requests_notices_insert after insert on public.booking_change_requests
  for each row execute function authz.notices_on_change_request();
create trigger booking_change_requests_notices_status after update on public.booking_change_requests
  for each row when (old.status is distinct from new.status)
  execute function authz.notices_on_change_request();

-- A supplier charge of a booked removal entered: when none is missing, 57 is resolved and 50 goes to the Approvers.
create function authz.notices_on_removal_charge() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.change_request_id is null or authz.notice_removal_charges_open(new.change_request_id) then
    return null;
  end if;
  perform authz.notice_resolve('cr:' || new.change_request_id || ':charges', 'acted');
  perform authz.notice_change_to_approve(new.change_request_id);
  return null;
end;
$$;
create trigger purchase_cancellation_charges_notices_removal after insert on public.purchase_cancellation_charges
  for each row when (new.change_request_id is not null)
  execute function authz.notices_on_removal_charge();
create trigger flight_cancellation_charges_notices_removal after insert on public.flight_cancellation_charges
  for each row when (new.change_request_id is not null)
  execute function authz.notices_on_removal_charge();
create trigger visa_cancellation_fees_notices_removal after insert on public.visa_cancellation_fees
  for each row when (new.change_request_id is not null)
  execute function authz.notices_on_removal_charge();

-- ===========================================================================
-- 6. 52, 56 reconfirmations; 19 widened
-- ===========================================================================

create function authz.notices_on_reconfirmation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old text := case when tg_op = 'UPDATE' then old.status end;
  v_task public.fulfilment_tasks%rowtype;
  v_key text := 'reconf:' || new.id;
begin
  -- 52 resolved when the status leaves "pending".
  if v_old = 'pending' and new.status <> 'pending' then
    perform authz.notice_resolve(v_key, case when new.status = 'void' then 'superseded' else 'acted' end);
  end if;
  -- 19 resolved when approved, refused, void or applied.
  if tg_op = 'UPDATE'
     and ((old.over_budget_approved_by is null and new.over_budget_approved_by is not null)
          or new.status in ('refused', 'void', 'applied')) then
    perform authz.notice_resolve(v_key || ':budget', case when new.status = 'void' then 'superseded' else 'acted' end);
  end if;
  if not authz.notices_enabled() then
    return null;
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = new.task_id and t.closed_state is null;
  if v_task.id is null then
    return null;
  end if;
  -- 52 to the task assignee, else the Purchase queue.
  if tg_op = 'INSERT' and new.status = 'pending' then
    perform authz.notice_write('reconfirm_supplier', authz.notice_task_or_queue(v_task.id), v_task.legal_entity_id,
      v_task.branch_id, v_task.deal_id, v_task.id, 'reconfirmation', new.id,
      jsonb_build_object('department', v_task.department, 'serviceType', v_task.service_purpose), v_key, v_key);
  end if;
  -- 19 to the branch Managers of the Deal (the over-budget approver), never the recorder.
  if new.status = 'recorded' and v_old is distinct from 'recorded' and new.over_budget
     and new.over_budget_approved_by is null then
    perform authz.notice_write('cost_over_budget',
      array(select u from authz.notice_branch_m_recipients(v_task.legal_entity_id, v_task.branch_id) as u
            where u is distinct from new.recorded_by order by 1),
      v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, 'reconfirmation', new.id,
      jsonb_build_object('department', v_task.department), v_key || ':budget', v_key || ':budget');
  end if;
  -- 56 a recorded reconfirmation is void: tell the supplier to keep the earlier booking.
  if v_old = 'recorded' and new.status = 'void' then
    perform authz.notice_write('reconfirm_undo', array[new.recorded_by, v_task.assignee_user_id], v_task.legal_entity_id,
      v_task.branch_id, v_task.deal_id, v_task.id, 'reconfirmation', new.id,
      jsonb_build_object('department', v_task.department, 'serviceType', v_task.service_purpose), v_key || ':void', null);
  end if;
  return null;
end;
$$;
create trigger task_reconfirmations_notices_insert after insert on public.task_reconfirmations
  for each row execute function authz.notices_on_reconfirmation();
create trigger task_reconfirmations_notices_status after update on public.task_reconfirmations
  for each row when (old.status is distinct from new.status
                     or old.over_budget_approved_by is distinct from new.over_budget_approved_by)
  execute function authz.notices_on_reconfirmation();

-- ===========================================================================
-- 7. 58, 59, 60 rate contracts
-- ===========================================================================

create function authz.notices_on_rate_contract() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_key text;
begin
  -- 58 resolved when the status leaves "pending_approval".
  if old.status = 'pending_approval' and new.status <> 'pending_approval' then
    perform authz.notice_resolve_subject('contract_to_approve', 'rate_contract', new.id, 'acted');
  end if;
  if not authz.notices_enabled() then
    return null;
  end if;
  -- 58 to the Managers of the entity (no Purchase / Flight / Visa, Addendum L2), not the enterer.
  if new.status = 'pending_approval' then
    v_key := 'rc:' || new.id || ':approve:' || new.row_version;
    perform authz.notice_write('contract_to_approve',
      array(select u from authz.notice_entity_m_recipients(new.legal_entity_id) as u
            where u is distinct from new.entered_by order by 1),
      new.legal_entity_id, null, null, null, 'rate_contract', new.id, jsonb_build_object('refNo', new.contract_no),
      v_key, v_key);
  end if;
  -- 59 to the enterer.
  if old.status = 'pending_approval' and new.status in ('active', 'returned') then
    perform authz.notice_write('contract_decided', array[new.entered_by], new.legal_entity_id, null, null, null,
      'rate_contract', new.id,
      jsonb_build_object('refNo', new.contract_no, 'status', case when new.status = 'active' then 'approved' else 'returned' end),
      'rc:' || new.id || ':' || new.status || ':' || new.row_version, null);
  end if;
  return null;
end;
$$;
create trigger rate_contracts_notices_status after update on public.rate_contracts
  for each row when (old.status is distinct from new.status)
  execute function authz.notices_on_rate_contract();

-- 60 an active contract ends in 30 or 7 days: Purchase holders and Managers of the entity.
create function authz.notices_on_rate_contract_alert() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v public.rate_contracts%rowtype;
begin
  if not authz.notices_enabled() then
    return null;
  end if;
  select * into v from public.rate_contracts c where c.id = new.contract_id;
  if v.id is null then
    return null;
  end if;
  perform authz.notice_write('contract_ending',
    array(select authz.notice_department_recipients(v.legal_entity_id, 'purchase'))
      || array(select authz.notice_entity_m_recipients(v.legal_entity_id)),
    v.legal_entity_id, null, null, null, 'rate_contract', v.id,
    jsonb_build_object('refNo', v.contract_no, 'status', new.days_left::text),
    'rc:' || v.id || ':ending:' || new.days_left, null);
  return null;
end;
$$;
create trigger rate_contract_alerts_notices after insert on public.rate_contract_alerts
  for each row execute function authz.notices_on_rate_contract_alert();

-- ===========================================================================
-- 8. Grants
-- ===========================================================================

revoke all on function
  authz.notice_task_work_kind(text),
  authz.notices_on_task_closed(),
  authz.notice_removal_charges_open(uuid),
  authz.notice_change_to_approve(uuid),
  authz.notice_removal_charges(uuid),
  authz.notices_on_change_request(),
  authz.notices_on_removal_charge(),
  authz.notices_on_reconfirmation(),
  authz.notices_on_rate_contract(),
  authz.notices_on_rate_contract_alert()
from public, anon, authenticated, service_role;
-- staff_notice_visible keeps its execute grant to authenticated (the select policy calls it); the replaced
-- functions keep their grants (CREATE OR REPLACE).

commit;
