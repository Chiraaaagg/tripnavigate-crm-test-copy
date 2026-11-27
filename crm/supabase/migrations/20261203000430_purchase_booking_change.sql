-- TripNavigate CRM - Accounts phase, track C (5 of 5): Purchase booking-changed
-- signal.
-- Contract: accounts-phase-2026-11-10/contract.md sections 6.3.4, 7.6, 8.5;
-- AL17, AL18 (frozen 10 November 2026).
--
-- What this file adds:
--   1. public.purchase_task_basis: the booking version a Purchase task's
--      assignee last worked from. Inserted (on conflict do nothing) when a
--      Purchase task first gets an assignee (trigger on fulfilment_tasks,
--      independent of the notices switch); backfilled at the current version
--      for every Purchase task already in progress or supplier confirmed
--      (no banner for changes made before release, AL17). Moves only through
--      P1. No grants; no delete; task, Deal and entity immutable.
--   2. authz.purchase_booking_diff(task) (pattern of authz.flight_booking_diff):
--      facts of the task's item basis vs current (every key, arrays as a
--      whole) except money keys (anything named like paise, price, cost,
--      estimate, budget, amount, discount, selling, margin, total, fare) and
--      participants; travellers of the item added / removed / renamed / type
--      changed (names and types only); trip destination / start / end; a
--      budgetChanged flag only (AL18, never amounts). Nothing from commercial
--      tables, contacts, billing or identity.
--   3. public.purchase_booking_change(task) read (Purchase people, the branch
--      Manager read-only); null when not readable or not changed. Field
--      labels come from the frozen TS map (S/modules/procurement/booking-change.ts).
--   4. P1 public.purchase_booking_change_ack(task, expected_basis, request_id):
--      the assignee moves the basis to the current version ("OK, seen"); the
--      caller's open booking_changed notices of the task are marked done.
--      Audit purchase.booking_change_seen.
--   5. public.purchase_home_counts(): {purchaseBookingChanged,
--      purchaseBookingChangedTaskId} for Purchase holders (else null).
--
-- Refusal tokens: not_authorized (42501), invalid_input (22023, hint
-- requestId), version_changed (40001), request_conflict (40001, replay with
-- another payload).
-- Rollback (forward-only): a new migration revoking execute on the three
-- public functions and dropping the basis trigger. Never delete basis rows.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Basis table
-- ===========================================================================

create table public.purchase_task_basis (
  task_id uuid primary key,
  legal_entity_id uuid not null,
  deal_id uuid not null,
  basis_version_id uuid not null,
  seen_by uuid references public.staff_profiles (user_id),
  seen_at timestamptz,
  row_version integer not null default 1 check (row_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id, basis_version_id) references public.booking_versions (legal_entity_id, deal_id, id),
  check ((seen_at is null) = (seen_by is null))
);
create index purchase_task_basis_entity_task_idx on public.purchase_task_basis (legal_entity_id, task_id);
create index purchase_task_basis_deal_idx on public.purchase_task_basis (legal_entity_id, deal_id);
create index purchase_task_basis_version_idx on public.purchase_task_basis (legal_entity_id, deal_id, basis_version_id);
create index purchase_task_basis_seen_by_idx on public.purchase_task_basis (seen_by) where seen_by is not null;
comment on table public.purchase_task_basis is
  'Booking version a Purchase task assignee last worked from (Accounts phase 6.3.4). Moves only through public.purchase_booking_change_ack. No table grant.';

create function authz.purchase_task_basis_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'purchase task basis rows cannot be deleted' using errcode = '42501';
  end if;
  if new.task_id <> old.task_id or new.deal_id <> old.deal_id or new.legal_entity_id <> old.legal_entity_id
     or new.created_at <> old.created_at then
    raise exception 'a purchase task basis keeps its task, Deal and entity' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger purchase_task_basis_a_guard
  before update or delete on public.purchase_task_basis
  for each row execute function authz.purchase_task_basis_guard();

alter table public.purchase_task_basis enable row level security;
create policy require_valid_session on public.purchase_task_basis as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.purchase_task_basis from public, anon, authenticated, service_role;

-- First assignee of a Purchase task: remember the version it starts from.
create function authz.purchase_task_basis_on_assign() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.purchase_task_basis (task_id, legal_entity_id, deal_id, basis_version_id)
  values (new.id, new.legal_entity_id, new.deal_id, authz.task_current_version(new.id))
  on conflict (task_id) do nothing;
  return null;
end;
$$;
create trigger fulfilment_tasks_purchase_basis_insert
  after insert on public.fulfilment_tasks
  for each row when (new.department = 'purchase' and new.assignee_user_id is not null)
  execute function authz.purchase_task_basis_on_assign();
create trigger fulfilment_tasks_purchase_basis_assignee
  after update of assignee_user_id on public.fulfilment_tasks
  for each row when (new.department = 'purchase' and new.assignee_user_id is not null and old.assignee_user_id is null)
  execute function authz.purchase_task_basis_on_assign();

-- Backfill (AL17): tasks already taken start from their current version.
insert into public.purchase_task_basis (task_id, legal_entity_id, deal_id, basis_version_id)
select t.id, t.legal_entity_id, t.deal_id, authz.task_current_version(t.id)
from public.fulfilment_tasks t
where t.department = 'purchase' and t.status in ('in_progress', 'supplier_confirmed')
order by t.id
on conflict (task_id) do nothing;

-- ===========================================================================
-- 2. Diff (no money)
-- ===========================================================================

create function authz.purchase_money_key(p_key text) returns boolean
language sql immutable set search_path = '' as $$
  select p_key ~* '(paise|price|cost|estimate|budget|amount|discount|selling|margin|total|fare)'
      or p_key in ('participants')
$$;

create function authz.purchase_booking_diff(p_task uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_basis public.purchase_task_basis%rowtype;
  v_current uuid;
  v_old_facts jsonb;
  v_new_facts jsonb;
  v_old_budget bigint;
  v_new_budget bigint;
  v_old_v public.booking_versions%rowtype;
  v_new_v public.booking_versions%rowtype;
  v_old_seqs integer[];
  v_new_seqs integer[];
  v_fields jsonb;
  v_travellers jsonb;
  v_trip jsonb := '{}'::jsonb;
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task;
  select * into v_basis from public.purchase_task_basis b where b.task_id = p_task;
  if v_task.id is null or v_basis.task_id is null then
    return null;
  end if;
  v_current := authz.task_current_version(p_task);
  if v_current is null or v_current = v_basis.basis_version_id then
    return null;
  end if;
  select * into v_old_v from public.booking_versions v where v.id = v_basis.basis_version_id;
  select * into v_new_v from public.booking_versions v where v.id = v_current;
  select f.facts, coalesce(f.purchase_budget_paise, v_old_v.purchase_budget_paise) into v_old_facts, v_old_budget
  from public.service_item_facts f
  where f.service_item_id = v_task.service_item_id and f.booking_version_id = v_basis.basis_version_id;
  select f.facts, coalesce(f.purchase_budget_paise, v_new_v.purchase_budget_paise) into v_new_facts, v_new_budget
  from public.service_item_facts f
  where f.service_item_id = v_task.service_item_id and f.booking_version_id = v_current;
  v_old_facts := coalesce(v_old_facts, '{}'::jsonb);
  v_new_facts := coalesce(v_new_facts, '{}'::jsonb);
  v_old_budget := coalesce(v_old_budget, v_old_v.purchase_budget_paise);
  v_new_budget := coalesce(v_new_budget, v_new_v.purchase_budget_paise);

  select coalesce(jsonb_agg(jsonb_build_object('key', k.key, 'before', v_old_facts -> k.key, 'after', v_new_facts -> k.key)
                            order by k.key), '[]'::jsonb)
  into v_fields
  from (select jsonb_object_keys(v_old_facts) as key union select jsonb_object_keys(v_new_facts)) k
  where not authz.purchase_money_key(k.key)
    and (v_old_facts -> k.key) is distinct from (v_new_facts -> k.key)
    and not (coalesce(v_old_facts -> k.key, 'null'::jsonb) = 'null'::jsonb
             and coalesce(v_new_facts -> k.key, 'null'::jsonb) = 'null'::jsonb);

  v_old_seqs := authz.item_participant_seqs(v_task.service_item_id, v_basis.basis_version_id);
  v_new_seqs := authz.item_participant_seqs(v_task.service_item_id, v_current);
  select jsonb_build_object(
    'added', coalesce((select jsonb_agg(jsonb_build_object('seq', n.seq, 'name', n.full_name, 'type', n.traveller_type) order by n.seq)
                       from public.booking_version_travellers n
                       where n.booking_version_id = v_current and n.seq = any (v_new_seqs)
                         and not (n.seq = any (v_old_seqs))), '[]'::jsonb),
    'removed', coalesce((select jsonb_agg(jsonb_build_object('seq', o.seq, 'name', o.full_name, 'type', o.traveller_type) order by o.seq)
                         from public.booking_version_travellers o
                         where o.booking_version_id = v_basis.basis_version_id and o.seq = any (v_old_seqs)
                           and not (o.seq = any (v_new_seqs))), '[]'::jsonb),
    'renamed', coalesce((select jsonb_agg(jsonb_build_object('seq', o.seq, 'before', o.full_name, 'after', n.full_name) order by o.seq)
                         from public.booking_version_travellers o
                         join public.booking_version_travellers n on n.booking_version_id = v_current and n.seq = o.seq
                         where o.booking_version_id = v_basis.basis_version_id and o.seq = any (v_old_seqs)
                           and n.seq = any (v_new_seqs) and o.full_name is distinct from n.full_name), '[]'::jsonb),
    'typeChanged', coalesce((select jsonb_agg(jsonb_build_object('seq', o.seq, 'before', o.traveller_type, 'after', n.traveller_type) order by o.seq)
                             from public.booking_version_travellers o
                             join public.booking_version_travellers n on n.booking_version_id = v_current and n.seq = o.seq
                             where o.booking_version_id = v_basis.basis_version_id and o.seq = any (v_old_seqs)
                               and n.seq = any (v_new_seqs) and o.traveller_type is distinct from n.traveller_type), '[]'::jsonb))
  into v_travellers;

  if v_old_v.trip_destination is distinct from v_new_v.trip_destination then
    v_trip := v_trip || jsonb_build_object('destination', jsonb_build_object('before', v_old_v.trip_destination, 'after', v_new_v.trip_destination));
  end if;
  if v_old_v.trip_start is distinct from v_new_v.trip_start then
    v_trip := v_trip || jsonb_build_object('start', jsonb_build_object('before', v_old_v.trip_start, 'after', v_new_v.trip_start));
  end if;
  if v_old_v.trip_end is distinct from v_new_v.trip_end then
    v_trip := v_trip || jsonb_build_object('end', jsonb_build_object('before', v_old_v.trip_end, 'after', v_new_v.trip_end));
  end if;

  return jsonb_build_object(
    'taskId', p_task,
    'basisVersionId', v_basis.basis_version_id,
    'basisVersionNo', v_old_v.version_no,
    'currentVersionId', v_current,
    'currentVersionNo', v_new_v.version_no,
    'changedAt', v_new_v.confirmed_at,
    'fields', v_fields,
    'travellers', v_travellers,
    'tripChanged', case when v_trip = '{}'::jsonb then null else v_trip end,
    'budgetChanged', v_old_budget is distinct from v_new_budget);
end;
$$;

-- ===========================================================================
-- 3. Read, command, Home count
-- ===========================================================================

create function public.purchase_booking_change(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_diff jsonb;
begin
  if not coalesce(authz.session_ok(), false) or p_task_id is null
     or not exists (select 1 from public.fulfilment_tasks t where t.id = p_task_id and t.department = 'purchase')
     or not authz.can_read_purchase_workspace(p_task_id) then
    return null;
  end if;
  v_diff := authz.purchase_booking_diff(p_task_id);
  if v_diff is null then
    return null;
  end if;
  return v_diff || jsonb_build_object('canAck', coalesce(authz.can_work_purchase_task(p_task_id), false));
end;
$$;

create function public.purchase_booking_change_ack(p_task_id uuid, p_expected_basis_version_id uuid, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_basis public.purchase_task_basis%rowtype;
  v_current uuid;
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_payload := jsonb_build_object('taskId', p_task_id, 'expectedBasisVersionId', p_expected_basis_version_id);
  v_replay := authz.finance_replay(v_task.legal_entity_id, p_request_id, 'purchase_booking_change_ack', v_payload);
  if v_replay is not null then
    return v_replay;
  end if;
  v_current := authz.task_current_version(v_task.id);

  select * into v_basis from public.purchase_task_basis b where b.task_id = v_task.id for update;
  if v_basis.task_id is null then
    insert into public.purchase_task_basis (task_id, legal_entity_id, deal_id, basis_version_id)
    values (v_task.id, v_task.legal_entity_id, v_task.deal_id, v_current)
    returning * into v_basis;
    return jsonb_build_object('outcome', 'existing', 'taskId', v_task.id, 'basisVersionId', v_basis.basis_version_id,
                              'rowVersion', v_basis.row_version);
  end if;
  if p_expected_basis_version_id is distinct from v_basis.basis_version_id then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if v_current = v_basis.basis_version_id then
    return jsonb_build_object('outcome', 'existing', 'taskId', v_task.id, 'basisVersionId', v_basis.basis_version_id,
                              'rowVersion', v_basis.row_version);
  end if;

  update public.purchase_task_basis b
  set basis_version_id = v_current, seen_by = (select auth.uid()), seen_at = now(),
      row_version = b.row_version + 1, updated_at = now()
  where b.task_id = v_task.id
  returning * into v_basis;
  update public.staff_notices n set read_at = coalesce(n.read_at, now()), done_at = now()
  where n.recipient_user_id = (select auth.uid()) and n.task_id = v_task.id and n.kind = 'booking_changed'
    and n.done_at is null and n.resolved_at is null;
  perform authz.write_audit('purchase.booking_change_seen', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('fromVersionId', p_expected_basis_version_id, 'toVersionId', v_current,
                       'rowVersion', v_basis.row_version));
  v_result := jsonb_build_object('outcome', 'updated', 'taskId', v_task.id, 'basisVersionId', v_basis.basis_version_id,
                                 'rowVersion', v_basis.row_version);
  return authz.finance_remember(v_task.legal_entity_id, p_request_id, 'purchase_booking_change_ack', v_payload, v_result);
end;
$$;

create function public.purchase_home_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_count integer;
  v_oldest uuid;
begin
  if not coalesce(authz.session_ok(), false) or not exists (
       select 1 from public.memberships m
       where m.user_id = v_uid and m.role_code = 'purchase' and m.status = 'active'
         and authz.holds_active_role('purchase', m.legal_entity_id)) then
    return null;
  end if;
  with changed as (
    select t.id, v.confirmed_at
    from public.fulfilment_tasks t
    join public.purchase_task_basis b on b.task_id = t.id
    join public.booking_versions v on v.id = authz.task_current_version(t.id)
    where t.assignee_user_id = v_uid and t.department = 'purchase' and t.status = 'in_progress'
      and authz.holds_active_role('purchase', t.legal_entity_id)
      and b.basis_version_id <> v.id)
  select count(*)::integer, (select c.id from changed c order by c.confirmed_at nulls last, c.id limit 1)
  into v_count, v_oldest from changed;
  return jsonb_build_object('purchaseBookingChanged', v_count, 'purchaseBookingChangedTaskId', v_oldest);
end;
$$;

-- ===========================================================================
-- 4. Grants
-- ===========================================================================

revoke all on function authz.purchase_task_basis_guard(), authz.purchase_task_basis_on_assign(),
  authz.purchase_money_key(text), authz.purchase_booking_diff(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.purchase_booking_change(uuid), public.purchase_booking_change_ack(uuid, uuid, uuid),
  public.purchase_home_counts()
from public, anon, authenticated, service_role;
grant execute on function public.purchase_booking_change(uuid), public.purchase_booking_change_ack(uuid, uuid, uuid),
  public.purchase_home_counts()
to authenticated;

commit;
