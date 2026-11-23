-- TripNavigate CRM - Accounts phase 2, Track D (5): notice kind refund_shortfall.
-- Contract: accounts-phase2-2026-11-11/contract.md Addendum L6 (11 Nov 2026):
-- a receipt reversed after a refund was paid out may leave money held below
-- zero; Track C's trigger authz.notices_on_refund_shortfall
-- (20261204000370, finance_journal_lines) writes kind 'refund_shortfall'
-- (subject 'deal', dedup refund_shortfall:<entry>) to the Accounts exception
-- owner and SO*, and wrote nothing until the kind existed. This file
-- registers the kind:
--   authz.notice_kinds (+ refund_shortfall), authz.notice_money_kind (money
--   kind: Purchase holders never receive it), authz.notice_write (urgent),
--   authz.notice_link ('deal': the Deal page dues card), authz.notice_so_kind
--   and authz.notice_row_visible (re-check: still Accounts of the entity, or
--   SO* of the Deal). Replaces the 20261204000430 bodies, same signatures.
-- Text (S/modules/notices/contracts.ts): "{BX}: a reversed payment leaves the
-- customer owing after a refund" (references only); urgent tone and pop-up.
-- The reversal itself is never refused because of the negative balance.
-- Refusal tokens: none.
-- Rollback (forward-only): a new migration restoring the 20261204000430 bodies
-- (Track C's trigger then writes nothing again). Never delete notice rows.

begin;
set local lock_timeout = '15s';

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
               'refund_shortfall']
$$;

create or replace function authz.notice_money_kind(p_kind text) returns boolean
language sql immutable set search_path = '' as $$
  select p_kind in ('payment_reported', 'receipt_to_verify', 'payment_to_approve', 'payment_to_record',
                    'payment_to_verify', 'funding_to_approve', 'go_ahead_to_approve', 'fare_to_approve',
                    'tally_exception',
                    -- Accounts phase 2 (20261204000430)
                    'refund_to_approve', 'refund_decided', 'refund_payout_due', 'refund_paid', 'document_to_release',
                    'document_to_check', 'credit_note_to_release', 'supplier_refund_due', 'refund_to_request',
                    'refund_shortfall')  -- Addendum L6 (20261204000440)
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
                    'refund_paid', 'refund_to_request', 'trip_cancelled', 'refund_shortfall')
$$;

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
    else false
  end, false)
$$;

commit;
