-- TripNavigate CRM - Accounts phase, track C fix-forward: bell read speed
-- (contract 12.7: unread count <= 150 ms, inbox first page <= 300 ms; Track E
-- measured 1166/3070 ms and 3819/4732 ms median/p95 on the speed seed).
--
-- Cause: the access re-check authz.staff_notice_visible ran once per row as a
-- plpgsql SECURITY DEFINER function with its own staff, Deal, task, route and
-- membership lookups (about 70 us a row); the busiest seeded person has 6,667
-- unread rows, all hidden, and notice_inbox scanned them three times.
--
-- Fix (same rule, "re-check access on read", now set-based):
--   * authz.notice_context(user): the caller's facts computed ONCE per read
--     (staff active; active department roles as 'entity:role'; Accounts
--     entities; Manager branches; entities where Purchase, or any of
--     Purchase/Flight/Visa, is held).
--   * authz.notice_row_visible(context, user, kind, ...joined columns): a pure
--     SQL predicate over the row and its joined Deal / task / payment route,
--     with no lookups of its own. The one remaining lookup (does the Deal have
--     an active Sales owner, for the Manager fallback of SO* kinds) runs only
--     for rows where the caller is a branch Manager and not the owner.
--   * authz.staff_notice_visible (the select policy and notice_mark) now
--     evaluates the same predicate, so the bell, the counts and a direct or
--     Realtime read apply one rule.
--   * notice_counts, notice_inbox, notice_history and notice_mark_all_read
--     join the Deal, task and route once and filter with the predicate while
--     walking the (recipient, seq) indexes, so the LIMIT stops the scan as soon
--     as enough visible rows are found (no per-row function lookups).
--   * authz.notice_escalated computes the working-day step only for
--     receipt_to_verify rows.
-- Behaviour and result shapes are unchanged (latest bodies 20261203000420 and
-- 20261203000400, same signatures).
--
-- Rollback (forward-only): a new migration restoring the 20261203000420 read
-- bodies and the 20261203000400 staff_notice_visible body.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Caller context and the pure predicate
-- ===========================================================================

create type authz.notice_context as (
  active boolean,
  dept text[],
  acc uuid[],
  mgr_branches uuid[],
  purchase uuid[],
  pfv uuid[]
);

create function authz.notice_context(p_user uuid) returns authz.notice_context
language sql stable security definer set search_path = '' as $$
  select row(
    exists (select 1 from public.staff_profiles p where p.user_id = p_user and p.status = 'active'),
    -- is_active_department_person(user, entity, role) for every role held.
    coalesce((select array_agg(distinct m.legal_entity_id::text || ':' || m.role_code)
              from public.memberships m
              join public.staff_profiles p on p.user_id = m.user_id
              join public.legal_entities e on e.id = m.legal_entity_id
              join public.branches b on b.id = m.branch_id
              where m.user_id = p_user and m.status = 'active' and p.status = 'active'
                and e.status = 'enabled' and b.status = 'enabled'), '{}'::text[]),
    coalesce((select array_agg(distinct m.legal_entity_id) from public.memberships m
              where m.user_id = p_user and m.role_code = 'accounts' and m.status = 'active'
                and authz.notice_user_is_accounts(p_user, m.legal_entity_id)), '{}'::uuid[]),
    coalesce((select array_agg(distinct m.branch_id) from public.memberships m
              where m.user_id = p_user and m.role_code = 'manager' and m.status = 'active'
                and authz.notice_user_is_branch_manager(p_user, m.legal_entity_id, m.branch_id)), '{}'::uuid[]),
    coalesce((select array_agg(distinct m.legal_entity_id) from public.memberships m
              where m.user_id = p_user and m.role_code = 'purchase' and m.status = 'active'), '{}'::uuid[]),
    coalesce((select array_agg(distinct m.legal_entity_id) from public.memberships m
              where m.user_id = p_user and m.role_code in ('purchase', 'flight', 'visa') and m.status = 'active'), '{}'::uuid[])
  )::authz.notice_context
$$;

-- The rule of authz.staff_notice_visible (20261203000400, SO* per
-- 20261203000450) over values the caller's query already joined.
--   p_deal_live      the row has no Deal, or its Deal exists and is not removed
--   p_owner_qualifies  authz.notice_deal_has_sales_owner(deal); needed only for
--                      SO* kinds when the caller is a branch Manager, not the owner
create function authz.notice_row_visible(c authz.notice_context, p_user uuid, p_kind text, p_entity uuid,
  p_deal_live boolean, p_deal_branch uuid, p_deal_owner uuid, p_has_task boolean, p_task_dept text,
  p_task_assignee uuid, p_route text, p_owner_qualifies boolean) returns boolean
-- No SET clause on purpose: a SQL function with SET is never inlined. The body
-- reads no table and calls no function (only built-in operators, which resolve
-- in pg_catalog first); every caller is SECURITY DEFINER with search_path ''.
language sql immutable as $$
  select coalesce(c.active, false) and coalesce(p_deal_live, false) and coalesce(case
    when p_kind = 'task_new' then
      p_has_task and (p_entity::text || ':' || p_task_dept) = any (c.dept)
    when p_kind in ('task_assigned', 'booking_changed', 'trip_cancelled') then
      p_has_task and p_task_assignee = p_user and (p_entity::text || ':' || p_task_dept) = any (c.dept)
    when p_kind in ('expense_returned', 'supplier_bill_returned') then
      p_has_task and (p_task_assignee = p_user or p_task_assignee is null)
      and (p_entity::text || ':' || p_task_dept) = any (c.dept)
    when p_kind in ('payment_decided', 'go_ahead_decided') then
      p_has_task and (p_entity::text || ':' || p_task_dept) = any (c.dept)
    when p_kind = 'fare_decided' then
      (p_entity::text || ':flight') = any (c.dept)
    when p_kind in ('review_returned', 'review_approved', 'supplier_confirmed', 'task_completed', 'visa_result') then
      p_deal_branch is not null and not (p_entity = any (c.pfv)) and case
        when p_deal_owner = p_user then
          -- The owner qualifies, or (not qualifying) falls back to the Manager rule.
          (p_entity::text || ':sales') = any (c.dept) or p_deal_branch = any (c.mgr_branches)
        else p_deal_branch = any (c.mgr_branches) and not coalesce(p_owner_qualifies, false) end
    when p_kind in ('payment_reported', 'receipt_to_verify', 'payment_to_record', 'payment_to_verify',
                    'go_ahead_to_approve', 'tally_exception') then
      p_entity = any (c.acc)
    when p_kind in ('payment_to_approve', 'funding_to_approve') then
      case when p_route = 'manager'
           then p_deal_branch = any (c.mgr_branches) and not (p_entity = any (c.purchase))
           else p_entity = any (c.acc) end
    when p_kind = 'bank_details_to_approve' then
      (p_entity::text || ':manager') = any (c.dept)
    when p_kind = 'cost_over_budget' then
      p_deal_branch = any (c.mgr_branches)
    when p_kind = 'fare_to_approve' then
      p_deal_branch = any (c.mgr_branches) and not (p_entity = any (c.purchase))
    else false
  end, false)
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
  end if;
  return authz.notice_row_visible(v_ctx, p_user, p_kind, p_entity,
    p_deal is null or (v_deal.id is not null and v_deal.removed_at is null),
    v_deal.branch_id, v_deal.owner_user_id, v_task.id is not null, v_task.department, v_task.assignee_user_id, v_route,
    case when p_kind in ('review_returned', 'review_approved', 'supplier_confirmed', 'task_completed', 'visa_result')
              and v_deal.owner_user_id is distinct from p_user and v_deal.branch_id = any (v_ctx.mgr_branches)
         then authz.notice_deal_has_sales_owner(v_deal.id) end);
end;
$$;

create or replace function authz.notice_escalated(p_kind text, p_created timestamptz, p_done timestamptz, p_resolved timestamptz)
returns boolean
-- No SET clause so it can be inlined; the only function it calls is schema-qualified.
language sql stable as $$
  select case when p_kind = 'receipt_to_verify' and p_done is null and p_resolved is null
              then authz.finance_add_working_days((p_created at time zone 'Asia/Kolkata')::date, 1) < authz.finance_today()
              else false end
$$;

-- ===========================================================================
-- 2. Visible rows of one user, set-based
-- ===========================================================================

-- Every visible notice of the user, with the joins the predicate needs. The
-- callers add their own range / state filters, order and limit. Not inlined
-- (security definer), so it is used only where the whole set is needed
-- (counts); paged reads repeat the join inline so their LIMIT stops the scan.
create function authz.notice_visible_unread(p_user uuid) returns setof public.staff_notices
language sql stable security definer set search_path = '' as $$
  -- Materialized: the context is computed once, never per row.
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
          d.branch_id, d.owner_user_id, t.id is not null, t.department, t.assignee_user_id, coalesce(sp.route, cf.route),
          case when n.kind in ('review_returned', 'review_approved', 'supplier_confirmed', 'task_completed', 'visa_result')
                    and d.owner_user_id is distinct from p_user and d.branch_id = any ((c.v).mgr_branches)
               then authz.notice_deal_has_sales_owner(d.id) end)
$$;

create or replace function authz.notice_counts(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'unreadCount', count(*),
    'urgentCount', count(*) filter (where n.priority = 'urgent'
                                       or authz.notice_escalated(n.kind, n.created_at, n.done_at, n.resolved_at)))
  from authz.notice_visible_unread(p_user) n
$$;

-- ===========================================================================
-- 3. Reads and mark-all (same results as 20261203000420)
-- ===========================================================================

create or replace function public.notice_inbox(p_after_seq bigint default null, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_ctx authz.notice_context;
  v_sound boolean;
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
  v_sound := coalesce((select p.sound_on from public.staff_notice_preferences p where p.user_id = v_uid), false);
  if not authz.notices_enabled() then
    return jsonb_build_object('enabled', false, 'unreadCount', 0, 'urgentCount', 0, 'latestSeq', null,
                              'soundOn', v_sound, 'items', '[]'::jsonb);
  end if;
  v_ctx := authz.notice_context(v_uid);
  select max(n.seq) into v_latest from public.staff_notices n where n.recipient_user_id = v_uid;

  with urgent as (
    -- Open urgent (and escalated) rows first: they are unread, so they come from the unread set.
    select n, 0 as grp from authz.notice_visible_unread(v_uid) n
    where p_after_seq is null
      and (n.priority = 'urgent' or authz.notice_escalated(n.kind, n.created_at, n.done_at, n.resolved_at))
    order by n.seq desc limit p_limit),
  rest as (
    -- Everything else by seq desc; the visibility filter runs while walking the
    -- (recipient, seq) index, so the LIMIT stops the scan early.
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
            d.branch_id, d.owner_user_id, t.id is not null, t.department, t.assignee_user_id, coalesce(sp.route, cf.route),
            case when n.kind in ('review_returned', 'review_approved', 'supplier_confirmed', 'task_completed', 'visa_result')
                      and d.owner_user_id is distinct from v_uid and d.branch_id = any (v_ctx.mgr_branches)
                 then authz.notice_deal_has_sales_owner(d.id) end)
    order by n.seq desc limit p_limit),
  page as (
    select y.n, y.grp from (select * from urgent union all select * from rest) y
    order by y.grp, (y.n).seq desc limit p_limit)
  select coalesce(jsonb_agg(authz.notice_item_json(p.n) order by p.grp, (p.n).seq desc), '[]'::jsonb) into v_items
  from page p;

  return jsonb_build_object('enabled', true, 'latestSeq', v_latest, 'soundOn', v_sound, 'items', v_items)
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
                d.branch_id, d.owner_user_id, t.id is not null, t.department, t.assignee_user_id, coalesce(sp.route, cf.route),
                case when n.kind in ('review_returned', 'review_approved', 'supplier_confirmed', 'task_completed', 'visa_result')
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

create or replace function public.notice_mark_all_read() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_count integer;
  r record;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  with target as (
    select n.id from public.staff_notices n
    where n.id in (select v.id from authz.notice_visible_unread(v_uid) v
                   where v.priority = 'normal' and not authz.notice_escalated(v.kind, v.created_at, v.done_at, v.resolved_at))
    order by n.id for update),
  marked as (
    update public.staff_notices n set read_at = coalesce(n.read_at, now()), done_at = now()
    from target where n.id = target.id returning n.id)
  select count(*) into v_count from marked;
  for r in
    select n.subject_id from public.staff_notices n
    join public.visa_result_notices x on x.id = n.subject_id and x.seen_at is null
    where n.recipient_user_id = v_uid and n.kind = 'visa_result' and n.done_at is not null
    order by n.subject_id
  loop
    perform authz.notice_visa_seen(r.subject_id);
  end loop;
  return jsonb_build_object('count', v_count);
end;
$$;

-- ===========================================================================
-- 4. Grants
-- ===========================================================================

revoke all on function authz.notice_context(uuid), authz.notice_visible_unread(uuid)
from public, anon, authenticated, service_role;
revoke all on function authz.notice_row_visible(authz.notice_context, uuid, text, uuid, boolean, uuid, uuid, boolean, text, uuid, text, boolean)
from public, anon, authenticated, service_role;
revoke all on type authz.notice_context from public;
-- staff_notice_visible keeps its execute grant to authenticated (the select policy calls it).

commit;
