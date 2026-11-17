-- TripNavigate CRM - Accounts phase 2, Track D (4 of 4): new notice kinds
-- 26-38 (34 dropped by Addendum L1), widened trip_cancelled, the access
-- re-check of the new kinds and the bell reads with popupsOn.
-- Contract: accounts-phase2-2026-11-11/contract.md sections 8.3, 10, 13.5,
-- Addendum L1 (frozen 11 Nov 2026). Notice rows carry template keys and
-- references only (refNo = RF-... or a document number); never names,
-- amounts, PAN, phone, e-mail, PNR or ticket numbers.
--
-- Kinds (recipients exclude the actor; money kinds 26-33, 38 exclude anyone
-- holding Purchase in the entity, as Phase 1):
--   8  trip_cancelled (widened)  cancellation opened: every open task
--      (not_started, in_progress, supplier_confirmed) -> its assignee, or the
--      department holders while unassigned (dedup cancel:<c>:<task>); the
--      Sales owner (SO*) and Accounts of the entity (cancel:<c>:deal). Urgent.
--   26 refund_to_approve  request created / resubmitted -> branch Managers of
--      the Deal (no Purchase/Flight/Visa role) except the requester; when the
--      requester is a Manager, every other active Manager of the entity
--      (LD32; params.status 'entity'). Urgent. Shared refund:<id>:approve,
--      resolved when the status leaves requested.
--   27 refund_decided  approved (normal) / returned (urgent) -> requester.
--   28 refund_payout_due  approved with outcome payout -> Accounts except
--      requester and approver. Shared refund:<id>:payout, resolved when paid
--      or withdrawn.
--   29 refund_paid  payout recorded -> requester (params.status 'requester')
--      and SO*.
--   30 document_to_release  review approved (no live Invoice) / receipt
--      verified or cleared (no live Advance Invoice), documents switch on ->
--      Accounts. Shared cdoc:<deal>:inv:<version> / cdoc:<receipt>:adv,
--      resolved when a document from that source is released or discarded.
--   31 document_to_check  receipt no longer money with a released Advance
--      Invoice / review approved on a later version with a released Invoice
--      -> Accounts. Shared cdoc:<document>:check:<n>, resolved when the
--      document is cancelled or replaced.
--   32 credit_note_to_release  authz.cdoc_credit_note_source(request) becomes
--      available (after approval, after payout), documents switch on ->
--      Accounts. Shared cdoc:<refund>:cn, resolved at the credit note release.
--   33 supplier_refund_due  cancellation approved with expected refunds > 0
--      -> Accounts. Shared srefund:<c>, resolved when verified >= expected.
--   35 cancellation_to_approve  cancellation sent to the Manager -> branch
--      Managers except the sender and the charge enterers. Urgent. Shared
--      cancel:<c>:approve:<rv>, resolved when the status leaves sent_to_manager.
--   36 flight_charges_to_enter  cancellation opened on a Deal with ticket
--      batches -> per batch the cost task assignee, else Flight holders.
--      Urgent. cancel:<c>:flight:<batch>, resolved when the batch has a charge.
--   37 visa_cancel_decide  cancellation approved with submitted /
--      decision_pending applications -> Visa task assignee, else Visa
--      holders. Urgent. cancel:<c>:visa:<task>, resolved when every such
--      application has a choice.
--   38 refund_to_request  cancellation approved and money held > 0 -> SO*.
--      cancel:<c>:refund, resolved when a refund request for that
--      cancellation exists.
--
-- Replaced (latest bodies, same signatures): authz.notice_kinds,
-- authz.notice_money_kind (20261203000400), authz.notice_write
-- (20261203000410), authz.notice_link (20261203000420),
-- authz.notice_row_visible, authz.staff_notice_visible,
-- authz.notice_visible_unread, public.notice_inbox, public.notice_history
-- (20261203000470), authz.notices_on_cancellation (20261203000450). New
-- trigger functions on deal_cancellations (status), customer_refund_requests,
-- customer_refund_payouts, customer_documents, accounts_booking_reviews,
-- customer_receipts, flight_cancellation_charges, visa_applications and
-- supplier_refund_receipts. No trigger catches errors (Phase 1 R1); writers
-- return at once while notices are off; resolutions always run.
--
-- Rollback (forward-only): a new migration dropping the new triggers and
-- restoring the replaced bodies. Never delete notice rows.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Kinds, subject kinds, money kinds, priority
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
               'flight_charges_to_enter', 'visa_cancel_decide', 'refund_to_request']
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
  'refund_request', 'customer_document', 'supplier_refund', 'flight_batch'));

create or replace function authz.notice_money_kind(p_kind text) returns boolean
language sql immutable set search_path = '' as $$
  select p_kind in ('payment_reported', 'receipt_to_verify', 'payment_to_approve', 'payment_to_record',
                    'payment_to_verify', 'funding_to_approve', 'go_ahead_to_approve', 'fare_to_approve',
                    'tally_exception',
                    -- Accounts phase 2 (20261204000430)
                    'refund_to_approve', 'refund_decided', 'refund_payout_due', 'refund_paid', 'document_to_release',
                    'document_to_check', 'credit_note_to_release', 'supplier_refund_due', 'refund_to_request')
$$;

-- Replaces 20261203000410: priority map + the phase 2 urgent kinds (contract 13.5).
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

-- ===========================================================================
-- 2. Links
-- ===========================================================================

-- Replaces 20261203000420: + refund, customer_document, supplier_refund, cancellation.
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
    when p_kind = 'cancellation_to_approve' then
      return jsonb_build_object('kind', 'cancellation', 'id', p_subject_id);
    else
      return null;
  end case;
end;
$$;

-- ===========================================================================
-- 3. Access re-check (same rule for the bell, counts, Realtime and notice_mark)
-- ===========================================================================

-- Replaces 20261203000470 (same signature): + the phase 2 kinds.
--   p_route  supplier payment / funding route; for refund_to_approve and
--            refund_paid the row's params.status ('entity' / 'requester').
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

-- Kinds whose rule needs "does the Deal have an active Sales owner" (SO* Manager fallback).
create function authz.notice_so_kind(p_kind text) returns boolean
language sql immutable as $$
  select p_kind in ('review_returned', 'review_approved', 'supplier_confirmed', 'task_completed', 'visa_result',
                    'refund_paid', 'refund_to_request', 'trip_cancelled')
$$;

-- The p_route value of a row (payment route, or the params marker of 26 / 29).
create function authz.notice_route(p_kind text, p_params jsonb, p_sp_route text, p_cf_route text) returns text
language sql immutable as $$
  select coalesce(p_sp_route, p_cf_route,
                  case when p_kind in ('refund_to_approve', 'refund_paid') then p_params ->> 'status' end)
$$;

-- Same signature; one rule with the bell reads (used by the select policy and notice_mark).
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
  elsif p_kind in ('refund_to_approve', 'refund_paid') then
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

-- Replaces 20261203000470: route marker and SO* kind list.
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
          authz.notice_route(n.kind, n.params, sp.route, cf.route),
          case when authz.notice_so_kind(n.kind)
                    and d.owner_user_id is distinct from p_user and d.branch_id = any ((c.v).mgr_branches)
               then authz.notice_deal_has_sales_owner(d.id) end)
$$;

-- ===========================================================================
-- 4. Bell reads (same shapes; inbox + popupsOn, sound and pop-ups ON without a row)
-- ===========================================================================

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
                              'soundOn', v_sound, 'popupsOn', v_popups, 'items', '[]'::jsonb);
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
            authz.notice_route(n.kind, n.params, sp.route, cf.route),
            case when authz.notice_so_kind(n.kind)
                      and d.owner_user_id is distinct from v_uid and d.branch_id = any (v_ctx.mgr_branches)
                 then authz.notice_deal_has_sales_owner(d.id) end)
    order by n.seq desc limit p_limit),
  page as (
    select y.n, y.grp from (select * from urgent union all select * from rest) y
    order by y.grp, (y.n).seq desc limit p_limit)
  select coalesce(jsonb_agg(authz.notice_item_json(p.n) order by p.grp, (p.n).seq desc), '[]'::jsonb) into v_items
  from page p;

  return jsonb_build_object('enabled', true, 'latestSeq', v_latest, 'soundOn', v_sound, 'popupsOn', v_popups, 'items', v_items)
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
                authz.notice_route(n.kind, n.params, sp.route, cf.route),
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
-- 5. Recipient helpers
-- ===========================================================================

-- Branch Managers of the Deal (M: no Purchase/Flight/Visa membership, AL7).
create function authz.notice_branch_m_recipients(p_entity uuid, p_branch uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select r.u from authz.notice_branch_manager_recipients(p_entity, p_branch) as r(u)
  where not authz.notice_user_holds(r.u, p_entity, array['purchase', 'flight', 'visa'])
$$;

-- Active Managers of the entity without Purchase/Flight/Visa (LD32).
create function authz.notice_entity_m_recipients(p_entity uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select r.u from authz.notice_entity_manager_recipients(p_entity) as r(u)
  where not authz.notice_user_holds(r.u, p_entity, array['purchase', 'flight', 'visa'])
$$;

-- A task's assignee, else the holders of its department (the queue).
create function authz.notice_task_or_queue(p_task uuid) returns uuid[]
language sql stable security definer set search_path = '' as $$
  select case when t.assignee_user_id is not null then array[t.assignee_user_id]
              else array(select authz.notice_department_recipients(t.legal_entity_id, t.department)) end
  from public.fulfilment_tasks t where t.id = p_task
$$;

create function authz.notice_documents_on(p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.customer_documents_enabled from public.accounts_settings s where s.legal_entity_id = p_entity), false)
$$;

-- Resolve every open notice of one kind about one subject (shared keys that carry a counter).
create function authz.notice_resolve_subject(p_kind text, p_subject_kind text, p_subject uuid, p_reason text) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  k text;
  v integer := 0;
begin
  for k in
    select distinct n.shared_key from public.staff_notices n
    where n.subject_kind = p_subject_kind and n.subject_id = p_subject and n.resolved_at is null
      and n.kind = p_kind and n.shared_key is not null
    order by 1
  loop
    v := v + authz.notice_resolve(k, p_reason);
  end loop;
  return v;
end;
$$;

-- ===========================================================================
-- 6. Trip cancellation (8 widened, 36 on insert; 35, 33, 37, 38 on status)
-- ===========================================================================

-- Replaces 20261203000450 (trigger deal_cancellations_notices, after insert).
create or replace function authz.notices_on_cancellation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  -- Every open task: the assignee, or the department queue while unassigned.
  for r in
    select t.* from public.fulfilment_tasks t
    where t.deal_id = new.deal_id and t.status in ('not_started', 'in_progress', 'supplier_confirmed')
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
    select b.* from public.flight_ticket_batches b where b.deal_id = new.deal_id order by b.batch_no, b.id
  loop
    perform authz.notice_write('flight_charges_to_enter', authz.notice_task_or_queue(r.cost_task_id), r.legal_entity_id,
      r.branch_id, r.deal_id, r.cost_task_id, 'flight_batch', r.id,
      jsonb_build_object('department', 'flight', 'serviceType', 'flight'),
      'cancel:' || new.id || ':flight:' || r.id, 'cancel:' || new.id || ':flight:' || r.id);
  end loop;
  return null;
end;
$$;

create function authz.notices_on_cancellation_status() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
  -- 35 resolved when the case leaves the Manager.
  if old.status = 'sent_to_manager' and new.status <> 'sent_to_manager' then
    perform authz.notice_resolve_subject('cancellation_to_approve', 'cancellation', new.id, 'acted');
  end if;
  if new.status = 'sent_to_manager' and old.status <> 'sent_to_manager' then
    perform authz.notice_write('cancellation_to_approve',
      array(select u from authz.notice_branch_m_recipients(new.legal_entity_id, new.branch_id) as u
            where u is distinct from new.sent_by
              and not exists (select 1 from public.purchase_cancellation_charges c where c.cancellation_id = new.id and c.entered_by = u)
              and not exists (select 1 from public.flight_cancellation_charges f where f.cancellation_id = new.id and f.entered_by = u)),
      new.legal_entity_id, new.branch_id, new.deal_id, null, 'cancellation', new.id, '{}'::jsonb,
      'cancel:' || new.id || ':approve:' || new.row_version, 'cancel:' || new.id || ':approve:' || new.row_version);
  end if;
  if new.status = 'approved' and old.status <> 'approved' then
    -- 33 supplier, airline and Visa-fee refunds expected.
    if authz.supplier_refunds_expected(new.id) > 0 then
      perform authz.notice_write('supplier_refund_due', array(select authz.notice_accounts_recipients(new.legal_entity_id)),
        new.legal_entity_id, new.branch_id, new.deal_id, null, 'cancellation', new.id, '{}'::jsonb,
        'srefund:' || new.id, 'srefund:' || new.id);
    end if;
    -- 37 per Visa task with submitted / decision-pending applications.
    for r in
      select t.* from public.fulfilment_tasks t
      where t.deal_id = new.deal_id and t.department = 'visa'
        and exists (select 1 from public.visa_applications a where a.task_id = t.id
                    and a.state in ('submitted', 'decision_pending') and a.cancellation_choice is null)
      order by t.id
    loop
      perform authz.notice_write('visa_cancel_decide', authz.notice_task_or_queue(r.id), r.legal_entity_id, r.branch_id,
        r.deal_id, r.id, 'cancellation', new.id, jsonb_build_object('department', 'visa', 'serviceType', r.service_purpose),
        'cancel:' || new.id || ':visa:' || r.id, 'cancel:' || new.id || ':visa:' || r.id);
    end loop;
    -- 38 money held: the Sales owner asks for the refund.
    if authz.refund_money_held(new.deal_id) > 0
       and not exists (select 1 from public.customer_refund_requests q where q.cancellation_id = new.id) then
      perform authz.notice_write('refund_to_request', array(select authz.notice_so_star_recipients(new.deal_id)),
        new.legal_entity_id, new.branch_id, new.deal_id, null, 'cancellation', new.id, '{}'::jsonb,
        'cancel:' || new.id || ':refund', 'cancel:' || new.id || ':refund');
    end if;
  end if;
  return null;
end;
$$;
create trigger deal_cancellations_notices_status after update on public.deal_cancellations
  for each row when (old.status is distinct from new.status)
  execute function authz.notices_on_cancellation_status();

-- 36 resolved when the batch has a charge.
create function authz.notices_on_flight_charge() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform authz.notice_resolve('cancel:' || new.cancellation_id || ':flight:' || new.batch_id, 'acted');
  return null;
end;
$$;
create trigger flight_cancellation_charges_notices after insert on public.flight_cancellation_charges
  for each row execute function authz.notices_on_flight_charge();

-- 37 resolved when every submitted / decision-pending application of the task has a choice.
create function authz.notices_on_visa_choice() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_c uuid;
begin
  select c.id into v_c from public.deal_cancellations c where c.deal_id = new.deal_id;
  if v_c is not null and not exists (
       select 1 from public.visa_applications a where a.task_id = new.task_id
       and a.state in ('submitted', 'decision_pending') and a.cancellation_choice is null) then
    perform authz.notice_resolve('cancel:' || v_c || ':visa:' || new.task_id, 'acted');
  end if;
  return null;
end;
$$;
create trigger visa_applications_notices_choice after update on public.visa_applications
  for each row when (old.cancellation_choice is distinct from new.cancellation_choice or old.state is distinct from new.state)
  execute function authz.notices_on_visa_choice();

-- 33 resolved when verified receipts reach the expected refunds.
create function authz.notices_on_supplier_refund() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not authz.notice_supplier_refund_open(new.cancellation_id) then
    perform authz.notice_resolve('srefund:' || new.cancellation_id, 'acted');
  end if;
  return null;
end;
$$;
create trigger supplier_refund_receipts_notices after insert or update of status, amount_paise on public.supplier_refund_receipts
  for each row execute function authz.notices_on_supplier_refund();

-- ===========================================================================
-- 7. Refund requests and payouts (26-29, 32; resolves 38)
-- ===========================================================================

-- Credit note available for this request (7.6), documents switched on.
create function authz.notice_credit_note(p_request public.customer_refund_requests) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if authz.notice_documents_on(p_request.legal_entity_id)
     and authz.cdoc_credit_note_source(p_request.id) is not null
     and not exists (select 1 from public.customer_documents x where x.refund_request_id = p_request.id
                     and x.kind = 'credit_note' and x.status = 'released') then
    perform authz.notice_write('credit_note_to_release', array(select authz.notice_accounts_recipients(p_request.legal_entity_id)),
      p_request.legal_entity_id, p_request.branch_id, p_request.deal_id, null, 'refund_request', p_request.id,
      jsonb_build_object('refNo', p_request.ref_no), 'cdoc:' || p_request.id || ':cn', 'cdoc:' || p_request.id || ':cn');
  end if;
end;
$$;

create function authz.notices_on_refund_request() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old text := case when tg_op = 'UPDATE' then old.status end;
  v_entity_rule boolean;
begin
  -- 38 resolved: a request exists for the cancellation.
  if tg_op = 'INSERT' and new.cancellation_id is not null then
    perform authz.notice_resolve('cancel:' || new.cancellation_id || ':refund', 'acted');
  end if;
  -- 26 resolved when the request leaves "requested".
  if v_old = 'requested' and new.status <> 'requested' then
    perform authz.notice_resolve('refund:' || new.id || ':approve', 'acted');
  end if;
  -- 26 waiting for approval (create or resubmit).
  if new.status = 'requested' and v_old is distinct from 'requested' then
    v_entity_rule := new.requested_as = 'manager';
    perform authz.notice_write('refund_to_approve',
      array_remove(case when v_entity_rule then array(select authz.notice_entity_m_recipients(new.legal_entity_id))
                        else array(select authz.notice_branch_m_recipients(new.legal_entity_id, new.branch_id)) end,
                   new.requested_by),
      new.legal_entity_id, new.branch_id, new.deal_id, null, 'refund_request', new.id,
      jsonb_build_object('refNo', new.ref_no, 'status', case when v_entity_rule then 'entity' end),
      'refund:' || new.id || ':approve:' || new.row_version, 'refund:' || new.id || ':approve');
  end if;
  if tg_op = 'UPDATE' and new.status in ('approved', 'returned') and v_old is distinct from new.status then
    -- 27 decided -> the requester.
    perform authz.notice_write('refund_decided', array[new.requested_by], new.legal_entity_id, new.branch_id, new.deal_id,
      null, 'refund_request', new.id, jsonb_build_object('refNo', new.ref_no, 'status', new.status),
      'refund:' || new.id || ':' || new.status || ':' || new.row_version, null);
  end if;
  if tg_op = 'UPDATE' and new.status = 'approved' and v_old is distinct from 'approved' then
    -- 28 pay it out (Accounts, not the requester or the approver).
    if new.outcome = 'payout' then
      perform authz.notice_write('refund_payout_due',
        array_remove(array_remove(array(select authz.notice_accounts_recipients(new.legal_entity_id)), new.requested_by),
                     new.decided_by),
        new.legal_entity_id, new.branch_id, new.deal_id, null, 'refund_request', new.id,
        jsonb_build_object('refNo', new.ref_no), 'refund:' || new.id || ':payout', 'refund:' || new.id || ':payout');
    end if;
    -- 32 credit note source after approval (7.6 case 1).
    if new.kind = 'cancellation' then
      perform authz.notice_credit_note(new);
    end if;
  end if;
  -- 28 resolved when paid or withdrawn.
  if tg_op = 'UPDATE' and new.status in ('paid', 'withdrawn') and v_old is distinct from new.status then
    perform authz.notice_resolve('refund:' || new.id || ':payout', case when new.status = 'paid' then 'acted' else 'superseded' end);
  end if;
  return null;
end;
$$;
create trigger customer_refund_requests_notices_insert after insert on public.customer_refund_requests
  for each row execute function authz.notices_on_refund_request();
create trigger customer_refund_requests_notices_status after update on public.customer_refund_requests
  for each row when (old.status is distinct from new.status or old.row_version is distinct from new.row_version)
  execute function authz.notices_on_refund_request();

create function authz.notices_on_refund_payout() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v public.customer_refund_requests%rowtype;
begin
  select * into v from public.customer_refund_requests q where q.id = new.refund_request_id;
  if v.id is null then
    return null;
  end if;
  -- 29 paid -> the requester and SO*.
  perform authz.notice_write('refund_paid', array[v.requested_by], v.legal_entity_id, v.branch_id, v.deal_id, null,
    'refund_request', v.id, jsonb_build_object('refNo', v.ref_no, 'status', 'requester'), 'refund:' || v.id || ':paid', null);
  perform authz.notice_write('refund_paid', array_remove(array(select authz.notice_so_star_recipients(v.deal_id)), v.requested_by),
    v.legal_entity_id, v.branch_id, v.deal_id, null, 'refund_request', v.id, jsonb_build_object('refNo', v.ref_no),
    'refund:' || v.id || ':paid', null);
  -- 32 credit note source after payout (7.6 case 2).
  perform authz.notice_credit_note(v);
  return null;
end;
$$;
create trigger customer_refund_payouts_notices after insert on public.customer_refund_payouts
  for each row execute function authz.notices_on_refund_payout();

-- ===========================================================================
-- 8. Customer documents (30, 31; resolves 30, 31, 32)
-- ===========================================================================

create function authz.notices_on_review_document() returns trigger
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
                    and x.status in ('draft', 'released')) then
    -- 30 an Invoice is ready to draft and release.
    perform authz.notice_write('document_to_release', array(select authz.notice_accounts_recipients(new.legal_entity_id)),
      new.legal_entity_id, v_deal.branch_id, new.deal_id, null, 'booking_version', new.booking_version_id,
      jsonb_build_object('versionNo', v_version_no),
      'cdoc:' || new.deal_id || ':inv:' || new.booking_version_id, 'cdoc:' || new.deal_id || ':inv:' || new.booking_version_id);
  end if;
  return null;
end;
$$;
create trigger accounts_booking_reviews_notices_document after update on public.accounts_booking_reviews
  for each row when (new.status = 'approved' and old.status is distinct from new.status)
  execute function authz.notices_on_review_document();

create function authz.notices_on_receipt_document() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_branch uuid;
  r record;
begin
  select d.branch_id into v_branch from public.deals d where d.id = new.deal_id;
  if new.status in ('verified', 'cleared') and old.status not in ('verified', 'cleared') then
    -- 30 an Advance Invoice can be made for this payment.
    if authz.notice_documents_on(new.legal_entity_id)
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
create trigger customer_receipts_notices_document after update on public.customer_receipts
  for each row when (old.status is distinct from new.status)
  execute function authz.notices_on_receipt_document();

create function authz.notices_on_customer_document() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status in ('released', 'discarded') and old.status = 'draft' then
    -- 30 resolved: a document from that source was released or discarded.
    if new.kind = 'advance_invoice' and new.receipt_id is not null then
      perform authz.notice_resolve('cdoc:' || new.receipt_id || ':adv', 'acted');
    elsif new.kind = 'invoice' and new.basis_version_id is not null then
      perform authz.notice_resolve('cdoc:' || new.deal_id || ':inv:' || new.basis_version_id, 'acted');
    end if;
  end if;
  -- 32 resolved at the credit note release.
  if new.status = 'released' and old.status = 'draft' and new.kind = 'credit_note' and new.refund_request_id is not null then
    perform authz.notice_resolve('cdoc:' || new.refund_request_id || ':cn', 'acted');
  end if;
  -- 31 resolved when the document is cancelled or replaced.
  if new.status in ('cancelled', 'replaced') and old.status = 'released' then
    perform authz.notice_resolve_subject('document_to_check', 'customer_document', new.id, 'acted');
  end if;
  return null;
end;
$$;
create trigger customer_documents_notices after update on public.customer_documents
  for each row when (old.status is distinct from new.status)
  execute function authz.notices_on_customer_document();

-- ===========================================================================
-- 9. Grants
-- ===========================================================================

revoke all on function authz.notice_so_kind(text), authz.notice_route(text, jsonb, text, text),
  authz.notice_branch_m_recipients(uuid, uuid), authz.notice_entity_m_recipients(uuid), authz.notice_task_or_queue(uuid),
  authz.notice_documents_on(uuid), authz.notice_resolve_subject(text, text, uuid, text),
  authz.notices_on_cancellation_status(), authz.notices_on_flight_charge(), authz.notices_on_visa_choice(),
  authz.notices_on_supplier_refund(), authz.notice_credit_note(public.customer_refund_requests),
  authz.notices_on_refund_request(), authz.notices_on_refund_payout(), authz.notices_on_review_document(),
  authz.notices_on_receipt_document(), authz.notices_on_customer_document()
  from public, anon, authenticated, service_role;
-- staff_notice_visible keeps its execute grant to authenticated (the select policy calls it).

commit;
