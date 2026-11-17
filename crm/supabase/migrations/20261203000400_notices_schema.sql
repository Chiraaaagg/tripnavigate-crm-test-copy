-- TripNavigate CRM - Accounts phase, track C (1 of 5): staff notices schema.
-- Contract: accounts-phase-2026-11-10/contract.md sections 6.3.1-6.3.3, 8.4,
-- 9.1 and the Lead decisions of 10 November 2026 (frozen).
--
-- What this file adds:
--   1. public.notice_settings (single row, notices_enabled default false) and
--      authz.notices_enabled(); setter public.admin_set_notices_enabled
--      (Super Admin, reason 10..500, mirrors admin_set_supplier_email_sending);
--      every change audited by trigger (settings.notices_changed). While the
--      switch is off nothing writes notices and the bell is hidden (AL13).
--   2. public.staff_notices: one row per recipient and notice. Template keys
--      and references only (params allowlist dealReference, department,
--      refNo, serviceType, versionNo, status): never names, amounts, PAN,
--      phone, e-mail, PNR or ticket numbers. Unique (recipient, dedup_key).
--      Only read_at, done_at and resolved_at/resolved_reason change, each once;
--      nothing is deleted.
--   3. public.staff_notice_preferences (sound_on, default off).
--   4. Per-user role helpers (authz.notice_user_*) used by the recipient sets
--      and by the access re-check authz.staff_notice_visible(...), which hides
--      a notice whose recipient no longer qualifies (inactive staff, removed
--      Deal, task no longer held, lost Accounts/Manager/Sales-owner standing).
--   5. Grant exception (contract 6.3.1): select on staff_notices to
--      authenticated through the permissive policy notice_own_rows =
--      own rows AND the same access re-check (Lead decision on AL15), plus the
--      restrictive session policy. No insert/update/delete grant. The table is
--      added to the supabase_realtime publication when that exists (Realtime
--      payloads are ignored; the bell re-reads through notice_inbox).
--
-- Interpretation (reported to the lead): the contract's "Deal no longer
-- readable (authz.can_read_deal)" re-check is applied as the role rule of
-- each kind (task holder, department role, Accounts, branch Manager, the
-- Deal's Sales owner or fallback Manager) plus deals.removed_at, because
-- deal.read is 'own' scope for Accounts, Purchase and Manager: can_read_deal
-- would hide every queue and money notice from its intended recipients.
--
-- Refusal tokens: not_authorized (42501), invalid switch / reason (22023).
-- Rollback (forward-only): a new migration that revokes select on
-- staff_notices and the setter from authenticated and sets notices_enabled
-- false. Never delete notice rows.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Switch
-- ===========================================================================

create table public.notice_settings (
  id boolean primary key default true check (id),
  notices_enabled boolean not null default false,
  updated_by uuid references public.staff_profiles (user_id),
  updated_at timestamptz not null default now()
);
create index notice_settings_updated_by_idx on public.notice_settings (updated_by) where updated_by is not null;
insert into public.notice_settings (id, notices_enabled) values (true, false);
comment on table public.notice_settings is
  'Single row. notices_enabled changes through public.admin_set_notices_enabled (Super Admin, reason) or owner SQL; every change is audited by trigger (settings.notices_changed). Off = no notice is written and the bell is hidden.';

create trigger notice_settings_audit
  after insert or update or delete on public.notice_settings
  for each row execute function authz.audit_settings_change('settings.notices_changed', 'notices_enabled');
create trigger notice_settings_touch
  before update on public.notice_settings
  for each row execute function authz.touch_settings_updated_at();

create function authz.notice_settings_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'notice settings cannot be deleted' using errcode = '42501';
end;
$$;
create trigger notice_settings_a_guard
  before delete on public.notice_settings
  for each row execute function authz.notice_settings_guard();

create function authz.notices_enabled() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.notices_enabled from public.notice_settings s where s.id), false)
$$;

-- Mirrors admin_set_supplier_email_sending (20261130000100).
create function public.admin_set_notices_enabled(p_enabled boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before boolean;
  v_after public.notice_settings%rowtype;
  v_reason text;
  v_prev text[];
begin
  if not authz.can_switch_live_settings(null) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v_reason := authz.settings_change_reason(p_reason);
  if p_enabled is null then
    raise exception 'invalid switch' using errcode = '22023';
  end if;
  select s.notices_enabled into v_before from public.notice_settings s where s.id for update;
  if not found then
    raise exception 'settings row missing' using errcode = '55000';
  end if;

  v_prev := authz.settings_begin_change('admin_set_notices_enabled', v_reason);
  update public.notice_settings s set notices_enabled = p_enabled, updated_by = (select auth.uid())
  where s.id returning * into v_after;
  perform authz.settings_end_change(v_prev);

  return jsonb_build_object('changed', v_before is distinct from v_after.notices_enabled,
    'before', v_before, 'after', v_after.notices_enabled, 'updatedAt', v_after.updated_at);
end;
$$;

-- ===========================================================================
-- 2. staff_notices
-- ===========================================================================

create function authz.notice_kinds() returns text[]
language sql immutable set search_path = '' as $$
  select array['task_new', 'task_assigned', 'booking_changed', 'review_returned', 'review_approved',
               'supplier_confirmed', 'task_completed', 'trip_cancelled', 'payment_reported', 'receipt_to_verify',
               'payment_to_approve', 'payment_to_record', 'payment_to_verify', 'payment_decided',
               'funding_to_approve', 'bank_details_to_approve', 'go_ahead_to_approve', 'go_ahead_decided',
               'cost_over_budget', 'fare_to_approve', 'fare_decided', 'expense_returned', 'supplier_bill_returned',
               'visa_result', 'tally_exception']
$$;

-- Params: template keys only, short reference-like values (strings of
-- letters, digits, spaces and - _ / . ; or whole numbers).
create function authz.notice_params_ok(p jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p) = 'object'
    and (p - array['dealReference', 'department', 'refNo', 'serviceType', 'versionNo', 'status']) = '{}'::jsonb
    and not exists (
      select 1 from jsonb_each(p) e
      where not ((jsonb_typeof(e.value) = 'string' and length(e.value #>> '{}') between 1 and 60
                  and (e.value #>> '{}') ~ '^[A-Za-z0-9 _./-]+$')
                 or (jsonb_typeof(e.value) = 'number' and (e.value #>> '{}') ~ '^[0-9]{1,6}$')))
    and (not (p ? 'department') or (p ->> 'department') in ('purchase', 'flight', 'visa'))
$$;

create table public.staff_notices (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity unique,
  legal_entity_id uuid not null references public.legal_entities (id),
  branch_id uuid,
  recipient_user_id uuid not null references public.staff_profiles (user_id),
  kind text not null check (kind = any (authz.notice_kinds())),
  priority text not null check (priority in ('urgent', 'normal')),
  deal_id uuid,
  task_id uuid,
  subject_kind text not null check (subject_kind in ('task', 'deal', 'claim', 'receipt', 'supplier_payment', 'funding',
    'go_ahead', 'cost_version', 'fare_approval', 'bank_revision', 'expense', 'supplier_document', 'cancellation',
    'visa_notice', 'tally_record', 'booking_version')),
  subject_id uuid not null,
  params jsonb not null default '{}'::jsonb check (authz.notice_params_ok(params)),
  dedup_key text not null check (length(dedup_key) between 1 and 200),
  shared_key text check (shared_key is null or length(shared_key) between 1 and 200),
  actor_user_id uuid references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  done_at timestamptz,
  resolved_at timestamptz,
  resolved_reason text check (resolved_reason in ('acted', 'taken', 'handled_by_other', 'reassigned', 'revised', 'superseded')),
  foreign key (legal_entity_id, branch_id) references public.branches (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  unique (recipient_user_id, dedup_key),
  check ((resolved_at is null) = (resolved_reason is null)),
  check (done_at is null or read_at is not null),
  check (recipient_user_id is distinct from actor_user_id)
);
create index staff_notices_recipient_seq_idx on public.staff_notices (recipient_user_id, seq desc);
create index staff_notices_unread_idx on public.staff_notices (recipient_user_id, seq)
  where resolved_at is null and done_at is null;
create index staff_notices_shared_open_idx on public.staff_notices (shared_key) where resolved_at is null;
create index staff_notices_task_idx on public.staff_notices (task_id) where task_id is not null;
create index staff_notices_deal_idx on public.staff_notices (deal_id) where deal_id is not null;
create index staff_notices_subject_open_idx on public.staff_notices (subject_kind, subject_id) where resolved_at is null;
create index staff_notices_entity_idx on public.staff_notices (legal_entity_id, branch_id);
create index staff_notices_entity_deal_idx on public.staff_notices (legal_entity_id, deal_id) where deal_id is not null;
create index staff_notices_entity_task_idx on public.staff_notices (legal_entity_id, task_id) where task_id is not null;
create index staff_notices_actor_idx on public.staff_notices (actor_user_id) where actor_user_id is not null;
comment on table public.staff_notices is
  'Per-person staff notices (Accounts phase 6.3.1). Template keys and references only. Written only by authz.notice_write (fan-out triggers); read through public.notice_inbox / notice_history / notice_unread_count; own-row select (with the access re-check) exists for Realtime only. Never deleted.';

create function authz.staff_notices_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'staff notices cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['read_at', 'done_at', 'resolved_at', 'resolved_reason'])
       <> (to_jsonb(old) - array['read_at', 'done_at', 'resolved_at', 'resolved_reason'])
     or (old.read_at is not null and new.read_at is distinct from old.read_at)
     or (old.done_at is not null and new.done_at is distinct from old.done_at)
     or (old.resolved_at is not null and (new.resolved_at is distinct from old.resolved_at
                                          or new.resolved_reason is distinct from old.resolved_reason)) then
    raise exception 'a staff notice changes only its read, done and resolved marks, each once' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger staff_notices_a_guard
  before update or delete on public.staff_notices
  for each row execute function authz.staff_notices_guard();

-- ===========================================================================
-- 3. Sound preferences
-- ===========================================================================

create table public.staff_notice_preferences (
  user_id uuid primary key references public.staff_profiles (user_id),
  sound_on boolean not null default false,
  updated_at timestamptz not null default now()
);
comment on table public.staff_notice_preferences is
  'Per-person bell preferences (sound off by default). Written only by public.notice_preferences_set.';

create function authz.staff_notice_preferences_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'notice preferences cannot be deleted' using errcode = '42501';
  end if;
  if new.user_id <> old.user_id then
    raise exception 'notice preferences keep their owner' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger staff_notice_preferences_a_guard
  before update or delete on public.staff_notice_preferences
  for each row execute function authz.staff_notice_preferences_guard();

-- ===========================================================================
-- 4. Per-user role helpers (recipients at write time, re-check at read time)
-- ===========================================================================

-- Kinds whose recipients exclude anyone holding Purchase in the entity
-- (customer money and supplier payment queues; standing rule section 9).
create function authz.notice_money_kind(p_kind text) returns boolean
language sql immutable set search_path = '' as $$
  select p_kind in ('payment_reported', 'receipt_to_verify', 'payment_to_approve', 'payment_to_record',
                    'payment_to_verify', 'funding_to_approve', 'go_ahead_to_approve', 'fare_to_approve',
                    'tally_exception')
$$;

create function authz.notice_user_holds(p_user uuid, p_entity uuid, p_roles text[]) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m
                 where m.user_id = p_user and m.legal_entity_id = p_entity
                   and m.role_code = any (p_roles) and m.status = 'active')
$$;

-- "Accounts of the entity" (contract 9.1): active Accounts person, no
-- Purchase membership, finance enabled for the entity.
create function authz.notice_user_is_accounts(p_user uuid, p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.is_active_department_person(p_user, p_entity, 'accounts')
     and not authz.notice_user_holds(p_user, p_entity, array['purchase'])
     and authz.finance_enabled(p_entity)
$$;

-- Active manager membership in the branch (entity and branch enabled, staff active).
create function authz.notice_user_is_branch_manager(p_user uuid, p_entity uuid, p_branch uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    join public.staff_profiles p on p.user_id = m.user_id
    join public.legal_entities e on e.id = m.legal_entity_id
    join public.branches b on b.id = m.branch_id
    where m.user_id = p_user and m.legal_entity_id = p_entity and m.branch_id = p_branch
      and m.role_code = 'manager' and m.status = 'active'
      and p.status = 'active' and e.status = 'enabled' and b.status = 'enabled')
$$;

-- SO* (contract 4.3; the Visa notice reader rule of 20261202000110 for any
-- user): the Deal's owner holding active Sales and no Purchase/Flight/Visa
-- membership; else, when the Deal has no active Sales owner, an active
-- Manager of the Deal's branch without a Purchase/Flight/Visa membership.
create function authz.notice_user_is_so_star(p_user uuid, p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case
      when d.owner_user_id = p_user then
        authz.is_active_department_person(p_user, d.legal_entity_id, 'sales')
        and not authz.notice_user_holds(p_user, d.legal_entity_id, array['purchase', 'flight', 'visa'])
      else authz.notice_user_is_branch_manager(p_user, d.legal_entity_id, d.branch_id)
        and not authz.notice_user_holds(p_user, d.legal_entity_id, array['purchase', 'flight', 'visa'])
        and not authz.flight_has_active_sales_owner(d.id)
    end
    from public.deals d where d.id = p_deal), false)
$$;

-- ===========================================================================
-- 5. Access re-check (every read, every row; also the Realtime select policy)
-- ===========================================================================

create function authz.staff_notice_visible(p_user uuid, p_kind text, p_entity uuid, p_deal uuid, p_task uuid,
  p_subject_kind text, p_subject_id uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_route text;
begin
  if p_user is null or not exists (select 1 from public.staff_profiles p where p.user_id = p_user and p.status = 'active') then
    return false;
  end if;
  if p_deal is not null then
    select * into v_deal from public.deals d where d.id = p_deal;
    if v_deal.id is null or v_deal.removed_at is not null then
      return false;
    end if;
  end if;
  if p_task is not null then
    select * into v_task from public.fulfilment_tasks t where t.id = p_task;
  end if;

  case
    when p_kind = 'task_new' then
      return v_task.id is not null and authz.is_active_department_person(p_user, p_entity, v_task.department);
    when p_kind in ('task_assigned', 'booking_changed', 'trip_cancelled') then
      return v_task.id is not null and v_task.assignee_user_id = p_user
         and authz.is_active_department_person(p_user, p_entity, v_task.department);
    when p_kind in ('expense_returned', 'supplier_bill_returned') then
      -- Sent to the assignee, or to the creator/uploader of an unassigned task.
      return v_task.id is not null and (v_task.assignee_user_id = p_user or v_task.assignee_user_id is null)
         and authz.is_active_department_person(p_user, p_entity, v_task.department);
    when p_kind in ('payment_decided', 'go_ahead_decided') then
      return v_task.id is not null and authz.is_active_department_person(p_user, p_entity, v_task.department);
    when p_kind = 'fare_decided' then
      return authz.is_active_department_person(p_user, p_entity, 'flight');
    when p_kind in ('review_returned', 'review_approved', 'supplier_confirmed', 'task_completed', 'visa_result') then
      return p_deal is not null and authz.notice_user_is_so_star(p_user, p_deal);
    when p_kind in ('payment_reported', 'receipt_to_verify', 'payment_to_record', 'payment_to_verify',
                    'go_ahead_to_approve', 'tally_exception') then
      return authz.notice_user_is_accounts(p_user, p_entity);
    when p_kind in ('payment_to_approve', 'funding_to_approve') then
      if p_subject_kind = 'supplier_payment' then
        select r.route into v_route from public.supplier_payment_requests r where r.id = p_subject_id;
      else
        select f.route into v_route from public.company_funding_requests f where f.id = p_subject_id;
      end if;
      if v_route = 'manager' then
        return v_deal.id is not null
           and authz.notice_user_is_branch_manager(p_user, p_entity, v_deal.branch_id)
           and not authz.notice_user_holds(p_user, p_entity, array['purchase']);
      end if;
      return authz.notice_user_is_accounts(p_user, p_entity);
    when p_kind = 'bank_details_to_approve' then
      return authz.is_active_department_person(p_user, p_entity, 'manager');
    when p_kind = 'cost_over_budget' then
      return v_deal.id is not null and authz.notice_user_is_branch_manager(p_user, p_entity, v_deal.branch_id);
    when p_kind = 'fare_to_approve' then
      return v_deal.id is not null and authz.notice_user_is_branch_manager(p_user, p_entity, v_deal.branch_id)
         and not authz.notice_user_holds(p_user, p_entity, array['purchase']);
    else
      return false;
  end case;
end;
$$;

-- ===========================================================================
-- 6. Row level security, grants, Realtime
-- ===========================================================================

alter table public.notice_settings enable row level security;
alter table public.staff_notices enable row level security;
alter table public.staff_notice_preferences enable row level security;
create policy require_valid_session on public.notice_settings as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
create policy require_valid_session on public.staff_notices as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
create policy require_valid_session on public.staff_notice_preferences as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.notice_settings, public.staff_notices, public.staff_notice_preferences
from public, anon, authenticated, service_role;

-- Grant exception (contract 6.3.1, Lead decision on AL15): own rows only, and
-- only while the access re-check passes, so a direct or Realtime read sees
-- exactly what the bell would show.
grant select on public.staff_notices to authenticated;
create policy notice_own_rows on public.staff_notices for select to authenticated
  using (recipient_user_id = (select auth.uid())
         and authz.staff_notice_visible(recipient_user_id, kind, legal_entity_id, deal_id, task_id, subject_kind, subject_id));

do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (
       select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'staff_notices') then
    alter publication supabase_realtime add table public.staff_notices;
  end if;
end;
$$;

revoke all on function
  authz.notice_settings_guard(), authz.notices_enabled(), authz.notice_kinds(), authz.notice_params_ok(jsonb),
  authz.staff_notices_guard(), authz.staff_notice_preferences_guard(), authz.notice_money_kind(text),
  authz.notice_user_holds(uuid, uuid, text[]), authz.notice_user_is_accounts(uuid, uuid),
  authz.notice_user_is_branch_manager(uuid, uuid, uuid), authz.notice_user_is_so_star(uuid, uuid),
  authz.staff_notice_visible(uuid, text, uuid, uuid, uuid, text, uuid)
from public, anon, authenticated, service_role;
-- The select policy calls the re-check as the invoker.
grant execute on function authz.staff_notice_visible(uuid, text, uuid, uuid, uuid, text, uuid) to authenticated;

revoke all on function public.admin_set_notices_enabled(boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.admin_set_notices_enabled(boolean, text) to authenticated;

commit;
