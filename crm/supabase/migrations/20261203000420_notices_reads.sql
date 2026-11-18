-- TripNavigate CRM - Accounts phase, track C (4 of 5): bell reads, commands
-- and the Visa result sync.
-- Contract: accounts-phase-2026-11-10/contract.md sections 7.5 (N1-N3, C14),
-- 8.4 and 9.4; AL13, AL14 (frozen 10 November 2026).
--
-- Reads (caller's own rows only; every row passes authz.staff_notice_visible,
-- hidden rows are neither returned nor counted; null without a valid session):
--   public.notice_inbox(p_after_seq, p_limit)  first page (open urgent rows
--     first, then the rest by seq desc) or the rows after a seq (30 s poll);
--     {enabled, unreadCount, urgentCount, latestSeq, soundOn, items[]}.
--   public.notice_history(p_before_seq, p_limit)  read/done/resolved rows of
--     the last 30 days, {items[], nextBefore}.
--   public.notice_unread_count()  {unreadCount, urgentCount}.
--   public.notice_preferences_get()  {soundOn}.
-- Item: {noticeId, seq, kind, priority, escalated, createdAt, readAt, doneAt,
--   resolvedAt, resolvedReason, dealId, dealReference, taskId, department,
--   params, link {kind, id}}. escalated = receipt_to_verify still open after
--   one working day (shown and counted as urgent; never a sound).
-- Commands (no audit: reading is view state):
--   N1 public.notice_mark(p_notice_id, p_action read|done|open)
--   N2 public.notice_mark_all_read()  unread normal rows only (urgent and
--     escalated untouched)
--   N3 public.notice_preferences_set(p_fields {soundOn})
--   C14 public.visa_result_notice_ack (replaced, same signature): unchanged
--     behaviour plus the caller's bell rows of that notice become read/done.
--   A bell action on a visa_result row marks the Visa notice seen when the
--   caller is SO* of the Deal (authz.visa_notice_reader).
-- Backfill (AL14): one bell row per existing visa_result_notices row for the
-- current SO*, read/done = seen_at when seen (written directly; the switch
-- stays off).
--
-- Refusal tokens: not_authorized (42501), not_found (P0002), invalid_input
-- (22023, hint names the field).
-- Rollback (forward-only): a new migration revoking execute on the new
-- functions and restoring visa_result_notice_ack from 20261202000110.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Item shape
-- ===========================================================================

create function authz.notice_escalated(p_kind text, p_created timestamptz, p_done timestamptz, p_resolved timestamptz)
returns boolean
language sql stable set search_path = '' as $$
  select p_kind = 'receipt_to_verify' and p_done is null and p_resolved is null
     and authz.finance_add_working_days((p_created at time zone 'Asia/Kolkata')::date, 1) < authz.finance_today()
$$;

create function authz.notice_link(p_kind text, p_deal uuid, p_task uuid, p_subject_kind text, p_subject_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_route text;
begin
  case
    when p_kind in ('task_new', 'task_assigned', 'booking_changed', 'trip_cancelled', 'payment_decided',
                    'go_ahead_decided', 'expense_returned', 'supplier_bill_returned') then
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
    else
      return null;
  end case;
end;
$$;

create function authz.notice_item_json(n public.staff_notices) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'noticeId', n.id,
    'seq', n.seq,
    'kind', n.kind,
    'priority', n.priority,
    'escalated', authz.notice_escalated(n.kind, n.created_at, n.done_at, n.resolved_at),
    'createdAt', n.created_at,
    'readAt', n.read_at,
    'doneAt', n.done_at,
    'resolvedAt', n.resolved_at,
    'resolvedReason', n.resolved_reason,
    'dealId', n.deal_id,
    'dealReference', n.params ->> 'dealReference',
    'taskId', n.task_id,
    'department', n.params ->> 'department',
    'params', n.params,
    'link', authz.notice_link(n.kind, n.deal_id, n.task_id, n.subject_kind, n.subject_id))
$$;

-- Unread (and urgent-or-escalated unread) visible rows of one user.
create function authz.notice_counts(p_user uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'unreadCount', count(*),
    'urgentCount', count(*) filter (where n.priority = 'urgent'
                                       or authz.notice_escalated(n.kind, n.created_at, n.done_at, n.resolved_at)))
  from public.staff_notices n
  where n.recipient_user_id = p_user and n.resolved_at is null and n.done_at is null
    and authz.staff_notice_visible(n.recipient_user_id, n.kind, n.legal_entity_id, n.deal_id, n.task_id,
                                   n.subject_kind, n.subject_id)
$$;

-- ===========================================================================
-- 2. Reads
-- ===========================================================================

create function public.notice_inbox(p_after_seq bigint default null, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
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
  select max(n.seq) into v_latest from public.staff_notices n where n.recipient_user_id = v_uid;

  if p_after_seq is null then
    -- Open urgent (and escalated) rows first, then everything else by seq desc.
    select coalesce(jsonb_agg(authz.notice_item_json(x.n) order by x.grp, (x.n).seq desc), '[]'::jsonb) into v_items
    from (
      select y.n, y.grp from (
        (select n, 0 as grp from public.staff_notices n
         where n.recipient_user_id = v_uid and n.resolved_at is null and n.done_at is null
           and (n.priority = 'urgent' or authz.notice_escalated(n.kind, n.created_at, n.done_at, n.resolved_at))
           and authz.staff_notice_visible(n.recipient_user_id, n.kind, n.legal_entity_id, n.deal_id, n.task_id,
                                          n.subject_kind, n.subject_id)
         order by n.seq desc limit p_limit)
        union all
        (select n, 1 as grp from public.staff_notices n
         where n.recipient_user_id = v_uid
           and not (n.resolved_at is null and n.done_at is null
                    and (n.priority = 'urgent' or authz.notice_escalated(n.kind, n.created_at, n.done_at, n.resolved_at)))
           and authz.staff_notice_visible(n.recipient_user_id, n.kind, n.legal_entity_id, n.deal_id, n.task_id,
                                          n.subject_kind, n.subject_id)
         order by n.seq desc limit p_limit)) y
      order by y.grp, (y.n).seq desc
      limit p_limit) x;
  else
    select coalesce(jsonb_agg(authz.notice_item_json(x) order by x.seq desc), '[]'::jsonb) into v_items
    from (select n.* from public.staff_notices n
          where n.recipient_user_id = v_uid and n.seq > p_after_seq
            and authz.staff_notice_visible(n.recipient_user_id, n.kind, n.legal_entity_id, n.deal_id, n.task_id,
                                           n.subject_kind, n.subject_id)
          order by n.seq desc limit p_limit) x;
  end if;

  return jsonb_build_object('enabled', true, 'latestSeq', v_latest, 'soundOn', v_sound, 'items', v_items)
         || authz.notice_counts(v_uid);
end;
$$;

create function public.notice_history(p_before_seq bigint default null, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
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
  select coalesce(array_agg(x order by x.seq desc), '{}') into v_rows
  from (select n.* from public.staff_notices n
        where n.recipient_user_id = v_uid and (p_before_seq is null or n.seq < p_before_seq)
          and (n.read_at is not null or n.done_at is not null or n.resolved_at is not null)
          and n.created_at >= now() - interval '30 days'
          and authz.staff_notice_visible(n.recipient_user_id, n.kind, n.legal_entity_id, n.deal_id, n.task_id,
                                         n.subject_kind, n.subject_id)
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

create function public.notice_unread_count() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  if not authz.notices_enabled() then
    return jsonb_build_object('unreadCount', 0, 'urgentCount', 0);
  end if;
  return authz.notice_counts((select auth.uid()));
end;
$$;

create function public.notice_preferences_get() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  return jsonb_build_object('soundOn',
    coalesce((select p.sound_on from public.staff_notice_preferences p where p.user_id = (select auth.uid())), false));
end;
$$;

-- ===========================================================================
-- 3. Commands
-- ===========================================================================

-- A bell action on a Visa result marks the Visa notice seen (SO* only; once).
create function authz.notice_visa_seen(p_visa_notice uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.visa_result_notices%rowtype;
begin
  select * into v from public.visa_result_notices n where n.id = p_visa_notice for update;
  if v.id is not null and v.seen_at is null and authz.visa_notice_reader(v.deal_id) then
    update public.visa_result_notices n set seen_at = now(), seen_by = (select auth.uid()) where n.id = v.id;
  end if;
end;
$$;

create function public.notice_mark(p_notice_id uuid, p_action text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v public.staff_notices%rowtype;
  v_read timestamptz;
  v_done timestamptz;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_action is null or p_action not in ('read', 'done', 'open') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'action';
  end if;
  select * into v from public.staff_notices n where n.id = p_notice_id and n.recipient_user_id = v_uid for update;
  if v.id is null or not authz.staff_notice_visible(v.recipient_user_id, v.kind, v.legal_entity_id, v.deal_id, v.task_id,
                                                     v.subject_kind, v.subject_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_read := coalesce(v.read_at, now());
  -- Urgent rows stay open on "read"; "done" and "open" close them.
  v_done := case when p_action = 'read' and v.priority = 'urgent' then v.done_at else coalesce(v.done_at, now()) end;
  if v_read is distinct from v.read_at or v_done is distinct from v.done_at then
    update public.staff_notices n set read_at = v_read, done_at = v_done where n.id = v.id;
  end if;
  if v.kind = 'visa_result' then
    perform authz.notice_visa_seen(v.subject_id);
  end if;
  return jsonb_build_object('noticeId', v.id, 'readAt', v_read, 'doneAt', v_done);
end;
$$;

create function public.notice_mark_all_read() returns jsonb
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
    where n.recipient_user_id = v_uid and n.resolved_at is null and n.done_at is null and n.priority = 'normal'
      and not authz.notice_escalated(n.kind, n.created_at, n.done_at, n.resolved_at)
      and authz.staff_notice_visible(n.recipient_user_id, n.kind, n.legal_entity_id, n.deal_id, n.task_id,
                                     n.subject_kind, n.subject_id)
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

create function public.notice_preferences_set(p_fields jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_on boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' or (p_fields - 'soundOn') <> '{}'::jsonb
     or jsonb_typeof(p_fields -> 'soundOn') is distinct from 'boolean' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'soundOn';
  end if;
  v_on := (p_fields ->> 'soundOn')::boolean;
  insert into public.staff_notice_preferences (user_id, sound_on, updated_at) values (v_uid, v_on, now())
  on conflict (user_id) do update set sound_on = excluded.sound_on, updated_at = excluded.updated_at;
  return jsonb_build_object('soundOn', v_on);
end;
$$;

-- C14 (replaces 20261202000110): unchanged, plus the caller's bell rows of the
-- notice become read/done (Accounts phase 20261203000420).
create or replace function public.visa_result_notice_ack(p_notice_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_notice public.visa_result_notices%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_notice from public.visa_result_notices n where n.id = p_notice_id for update;
  if v_notice.id is null or not authz.visa_notice_reader(v_notice.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Accounts phase (20261203000420): the caller's bell rows follow the card.
  update public.staff_notices n set read_at = coalesce(n.read_at, now()), done_at = coalesce(n.done_at, now())
  where n.recipient_user_id = (select auth.uid()) and n.kind = 'visa_result' and n.subject_id = v_notice.id
    and n.done_at is null;
  if v_notice.seen_at is not null then
    return jsonb_build_object('outcome', 'existing', 'noticeId', v_notice.id, 'seenAt', v_notice.seen_at);
  end if;
  update public.visa_result_notices n set seen_at = now(), seen_by = (select auth.uid()) where n.id = v_notice.id
  returning * into v_notice;
  return jsonb_build_object('outcome', 'updated', 'noticeId', v_notice.id, 'seenAt', v_notice.seen_at);
end;
$$;

-- ===========================================================================
-- 4. Backfill (AL14): existing Visa results into the bell for the current SO*
-- ===========================================================================

insert into public.staff_notices (legal_entity_id, branch_id, recipient_user_id, kind, priority, deal_id, task_id,
  subject_kind, subject_id, params, dedup_key, shared_key, actor_user_id, created_at, read_at, done_at)
select x.legal_entity_id, x.branch_id, r.u, 'visa_result', 'normal', x.deal_id, x.task_id, 'visa_notice', x.id,
       jsonb_build_object('dealReference', d.reference, 'department', 'visa', 'status', x.outcome),
       'visa_result:' || x.id, null, null, x.created_at, x.seen_at, x.seen_at
from public.visa_result_notices x
join public.deals d on d.id = x.deal_id
cross join lateral authz.notice_so_star_recipients(x.deal_id) as r(u)
where exists (select 1 from public.staff_profiles p where p.user_id = r.u and p.status = 'active')
order by x.created_at, x.id, r.u
on conflict (recipient_user_id, dedup_key) do nothing;

-- ===========================================================================
-- 5. Grants
-- ===========================================================================

revoke all on function
  authz.notice_escalated(text, timestamptz, timestamptz, timestamptz),
  authz.notice_link(text, uuid, uuid, text, uuid), authz.notice_item_json(public.staff_notices),
  authz.notice_counts(uuid), authz.notice_visa_seen(uuid)
from public, anon, authenticated, service_role;

revoke all on function
  public.notice_inbox(bigint, integer), public.notice_history(bigint, integer), public.notice_unread_count(),
  public.notice_preferences_get(), public.notice_mark(uuid, text), public.notice_mark_all_read(),
  public.notice_preferences_set(jsonb)
from public, anon, authenticated, service_role;
grant execute on function
  public.notice_inbox(bigint, integer), public.notice_history(bigint, integer), public.notice_unread_count(),
  public.notice_preferences_get(), public.notice_mark(uuid, text), public.notice_mark_all_read(),
  public.notice_preferences_set(jsonb)
to authenticated;

commit;
