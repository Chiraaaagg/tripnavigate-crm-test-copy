-- TripNavigate CRM - Accounts phase, track C fix-forward after the independent
-- backend review (contract Addendum L1, 10 November 2026, items 2, 4, 6, 7, 8).
--
--   L1-2  authz.notice_resolve / notice_resolve_task_for_others keep running
--         while notices are off (they only close existing rows); every
--         notices_on_* trigger function is replaced without its early return,
--         so resolutions happen while off; writers stay off (authz.notice_write
--         returns 0; the recipient sets return nothing while off, so no
--         recipient work is done).
--   L1-4  booking changed: new authz.notice_item_changed(item, old, new) =
--         facts_hash or participants differ. The urgent booking_changed notice
--         (outbox trigger) fires only for such items, and for a Purchase task
--         only when its banner is not empty; authz.purchase_booking_diff
--         returns null for an unchanged item or an empty diff (no fields, no
--         traveller or trip change, budget unchanged) and never lists
--         catalogueHotelId; purchase_home_counts counts the same rule.
--   L1-6  Tally exception raised by the exception owner: the other Accounts
--         people of the entity are told instead.
--   L1-7  SO*: one predicate authz.notice_deal_has_sales_owner(deal) (owner
--         holds active Sales and no Purchase/Flight/Visa membership) for both
--         the owner branch and the Manager fallback, so no Deal sends SO*
--         notices to nobody.
--   L1-8  staff_notices.actor_user_id is not selectable by authenticated: the
--         table grant becomes a column grant of every other column (direct
--         select and Realtime payloads leave it out; Realtime still delivers
--         change events for the bell, which re-reads through notice_inbox).
--
-- Replaced (latest bodies 20261203000410 / 0415 / 0400 / 0430, same
-- signatures): the notices_on_* trigger functions, notice_resolve,
-- notice_resolve_task_for_others, the five recipient sets,
-- notice_user_is_so_star, purchase_booking_diff, purchase_home_counts.
-- Rollback (forward-only): a new migration restoring those bodies and
-- `grant select on public.staff_notices to authenticated`.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- L1-7 one "active Sales owner" predicate
-- ===========================================================================

create function authz.notice_deal_has_sales_owner(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select d.owner_user_id is not null
       and authz.is_active_department_person(d.owner_user_id, d.legal_entity_id, 'sales')
       and not authz.notice_user_holds(d.owner_user_id, d.legal_entity_id, array['purchase', 'flight', 'visa'])
    from public.deals d where d.id = p_deal), false)
$$;

create or replace function authz.notice_user_is_so_star(p_user uuid, p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case
      when authz.notice_deal_has_sales_owner(d.id) then d.owner_user_id = p_user
      else authz.notice_user_is_branch_manager(p_user, d.legal_entity_id, d.branch_id)
        and not authz.notice_user_holds(p_user, d.legal_entity_id, array['purchase', 'flight', 'visa'])
    end
    from public.deals d where d.id = p_deal), false)
$$;

-- ===========================================================================
-- L1-2 recipient sets return nothing while off (no recipient work); resolvers always run
-- ===========================================================================

create or replace function authz.notice_department_recipients(p_entity uuid, p_department text) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct m.user_id from public.memberships m
  where authz.notices_enabled()
    and m.legal_entity_id = p_entity and m.role_code = p_department and m.status = 'active'
    and authz.is_active_department_person(m.user_id, p_entity, p_department)
$$;

create or replace function authz.notice_accounts_recipients(p_entity uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct m.user_id from public.memberships m
  where authz.notices_enabled()
    and m.legal_entity_id = p_entity and m.role_code = 'accounts' and m.status = 'active'
    and authz.notice_user_is_accounts(m.user_id, p_entity)
$$;

create or replace function authz.notice_branch_manager_recipients(p_entity uuid, p_branch uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct m.user_id from public.memberships m
  where authz.notices_enabled()
    and m.legal_entity_id = p_entity and m.branch_id = p_branch and m.role_code = 'manager' and m.status = 'active'
    and authz.notice_user_is_branch_manager(m.user_id, p_entity, p_branch)
$$;

create or replace function authz.notice_entity_manager_recipients(p_entity uuid) returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct m.user_id from public.memberships m
  where authz.notices_enabled()
    and m.legal_entity_id = p_entity and m.role_code = 'manager' and m.status = 'active'
    and authz.is_active_department_person(m.user_id, p_entity, 'manager')
$$;

-- The AL14 backfill (20261203000420) ran with the switch off and still needs
-- this set, so it is not gated: callers gate it (notice_write returns 0 while off).
create or replace function authz.notice_so_star_recipients(p_deal uuid) returns setof uuid
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
-- L1-2 resolvers
-- ===========================================================================

create or replace function authz.notice_resolve(p_shared_key text, p_reason text) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_count integer;
  v_first public.staff_notices%rowtype;
begin
  -- 20261203000450 (L1 review 2): resolvers run while notices are off too.
  if p_shared_key is null then
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

create or replace function authz.notice_resolve_task_for_others(p_task uuid, p_except uuid, p_reason text) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_count integer;
  v_kinds text[];
  v_task public.fulfilment_tasks%rowtype;
begin
  -- 20261203000450 (L1 review 2): resolvers run while notices are off too.
  if p_task is null then
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
-- L1-4 changed items only
-- ===========================================================================

-- The item's facts (facts_hash) or its participants differ between two versions.
create function authz.notice_item_changed(p_item uuid, p_old uuid, p_new uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_old is null or p_new is null
      or (select f.facts_hash from public.service_item_facts f where f.service_item_id = p_item and f.booking_version_id = p_old)
         is distinct from
         (select f.facts_hash from public.service_item_facts f where f.service_item_id = p_item and f.booking_version_id = p_new)
      or authz.item_participant_seqs(p_item, p_old) is distinct from authz.item_participant_seqs(p_item, p_new)
$$;

create or replace function authz.purchase_booking_diff(p_task uuid) returns jsonb
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
  -- Accounts phase (20261203000450, L1 review 4): nothing for an item whose
  -- facts and participants are unchanged (revisions copy every item).
  if not authz.notice_item_changed(v_task.service_item_id, v_basis.basis_version_id, v_current) then
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
  where not authz.purchase_money_key(k.key) and k.key <> 'catalogueHotelId'
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

  -- An empty diff never shows (20261203000450).
  if v_fields = '[]'::jsonb and v_trip = '{}'::jsonb and v_old_budget is not distinct from v_new_budget
     and v_travellers = jsonb_build_object('added', '[]'::jsonb, 'removed', '[]'::jsonb, 'renamed', '[]'::jsonb,
                                           'typeChanged', '[]'::jsonb) then
    return null;
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

create or replace function public.purchase_home_counts() returns jsonb
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
      and b.basis_version_id <> v.id
      -- 20261203000450: the same rule as the banner (changed item, non-empty diff).
      and authz.purchase_booking_diff(t.id) is not null)
  select count(*)::integer, (select c.id from changed c order by c.confirmed_at nulls last, c.id limit 1)
  into v_count, v_oldest from changed;
  return jsonb_build_object('purchaseBookingChanged', v_count, 'purchaseBookingChangedTaskId', v_oldest);
end;
$$;

-- ===========================================================================
-- L1-2 / L1-4 / L1-6 trigger functions (latest bodies without the early return)
-- ===========================================================================

create or replace function authz.notices_on_outbox() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_deal uuid;
  v_version uuid;
  v_version_no integer;
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
    select v.deal_id, v.version_no into v_deal, v_version_no from public.booking_versions v where v.id = v_version;
    if v_deal is null then
      return null;
    end if;
    for r in
      select t.* from public.fulfilment_tasks t
      where authz.notices_enabled() and t.deal_id = v_deal and t.status = 'in_progress' and t.assignee_user_id is not null
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
    perform authz.notice_resolve('review_returned:' || v_deal, 'revised');
  end if;
  return null;
end;
$$;

create or replace function authz.notices_on_task_assignee() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform authz.notice_resolve('task_new:' || new.id, 'taken');
  perform authz.notice_resolve_task_for_others(new.id, new.assignee_user_id, 'reassigned');
  perform authz.notice_write('task_assigned', array[new.assignee_user_id], new.legal_entity_id, new.branch_id,
    new.deal_id, new.id, 'task', new.id,
    jsonb_build_object('department', new.department, 'serviceType', new.service_purpose),
    'task_assigned:' || new.id || ':' || new.assignee_user_id || ':' || pg_current_xact_id()::text, null);
  return null;
end;
$$;

create or replace function authz.notices_on_review() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_version_no integer;
begin
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

create or replace function authz.notices_on_cancellation() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
begin
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

create or replace function authz.notices_on_claim() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_branch uuid;
begin
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

create or replace function authz.notices_on_receipt() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_branch uuid;
begin
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

create or replace function authz.notices_on_supplier_payment() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_branch uuid;
  v_department text;
  v_params jsonb;
  v_route uuid[];
begin
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

create or replace function authz.notices_on_funding() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_branch uuid;
  v_ref text;
begin
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

create or replace function authz.notices_on_bank_revision() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_on_hold boolean;
begin
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

create or replace function authz.notices_on_go_ahead() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
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

create or replace function authz.notices_on_cost_version() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_budget bigint;
begin
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

create or replace function authz.notices_on_cost_approval() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform authz.notice_resolve('cost:' || new.task_id, 'acted');
  return null;
end;
$$;

create or replace function authz.notices_on_fare_approval() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
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

create or replace function authz.notices_on_expense() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
begin
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

create or replace function authz.notices_on_supplier_document() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
begin
  select * into v_task from public.fulfilment_tasks t where t.id = new.task_id;
  perform authz.notice_write('supplier_bill_returned', array[coalesce(v_task.assignee_user_id, new.uploaded_by)],
    new.legal_entity_id, new.branch_id, new.deal_id, new.task_id, 'supplier_document', new.id,
    jsonb_build_object('department', v_task.department), 'sdoc:' || new.id || ':returned', null);
  return null;
end;
$$;

create or replace function authz.notices_on_visa_result() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform authz.notice_write('visa_result', array(select authz.notice_so_star_recipients(new.deal_id)),
    new.legal_entity_id, new.branch_id, new.deal_id, new.task_id, 'visa_notice', new.id,
    jsonb_build_object('department', 'visa', 'status', new.outcome), 'visa_result:' || new.id, null);
  return null;
end;
$$;

create or replace function authz.notices_on_tally_record() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_owner uuid;
begin
  if new.status = 'exception' then
    v_owner := authz.acct_exception_owner(new.legal_entity_id);
    -- Accounts phase (20261203000450, L1 review 6): raised by the owner -> the other Accounts people.
    perform authz.notice_write('tally_exception',
      case when v_owner is not null and v_owner is distinct from (select auth.uid()) then array[v_owner]
           else array(select authz.notice_accounts_recipients(new.legal_entity_id)) end,
      new.legal_entity_id, new.branch_id, new.deal_id, null, 'tally_record', new.id,
      jsonb_build_object('status', new.record_kind),
      'tally_exc:' || new.id || ':' || new.row_version, 'tally_exc:' || new.id);
  else
    perform authz.notice_resolve('tally_exc:' || new.id, 'acted');
  end if;
  return null;
end;
$$;

-- ===========================================================================
-- L1-8 actor not selectable by recipients
-- ===========================================================================

revoke select on public.staff_notices from authenticated;
grant select (id, seq, legal_entity_id, branch_id, recipient_user_id, kind, priority, deal_id, task_id, subject_kind,
              subject_id, params, dedup_key, shared_key, created_at, read_at, done_at, resolved_at, resolved_reason)
  on public.staff_notices to authenticated;

revoke all on function authz.notice_deal_has_sales_owner(uuid), authz.notice_item_changed(uuid, uuid, uuid)
from public, anon, authenticated, service_role;

commit;
