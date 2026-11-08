-- TripNavigate CRM - audited live switches and a database safety net for
-- every change to the live settings rows.
--
-- Background (docs/implementation/next/settings-records-2026-10-09.md): on
-- 9 October 2026 real booking and all four finance receipt modes were switched
-- on by owner-run SQL in the Supabase SQL Editor, and the Bitrix sync scope was
-- changed by operator SQL. None of those changes left an audit row that names
-- the person and the approval, and the finance update did not move
-- finance_live_settings.updated_at.
--
-- This migration adds:
--   1. Commands (Data API RPC, Super Admin at aal2, reason required):
--        public.admin_set_finance_live_modes(p_entity uuid, p_modes jsonb, p_reason text)
--        public.admin_set_booking_live(p_enabled boolean, p_reason text)
--        public.admin_set_supplier_confirmation_live(p_enabled boolean, p_reason text)
--      Each locks the row, applies the change and returns before/after. The
--      audit row is written by the trigger below (one row per real change),
--      carrying auth.uid(), the reason and the command name.
--   2. A trigger on booking_settings, finance_live_settings,
--      procurement_settings and integration_intake_config that writes one
--      audit_events row for ANY insert, delete, or update that changes a
--      watched column, whoever runs it (command, service role, dashboard SQL
--      as postgres). It records the database role, the JWT role, auth.uid()
--      (when present), the transaction id, and an optional approval reason
--      read from the transaction setting tripnavigate.change_reason.
--      Operator SQL names its approval like this (one SQL Editor run is one
--      transaction):
--        select set_config('tripnavigate.change_reason', 'Owner approval "4 YES", 9 Oct 2026', true);
--        update public.booking_settings set real_booking_enabled = true where id;
--      Watermark columns of integration_intake_config (last_reconciled_at,
--      lead_reconciled_at, last_reconcile_requested_at, updated_at,
--      updated_by) are not watched, so the worker does not flood the log.
--   3. updated_at is set automatically when a watched column of
--      booking_settings, finance_live_settings or procurement_settings
--      changes (the 9 October finance update left it at 6 October).
--   4. TRUNCATE is refused on these four tables and on audit_events (a
--      statement TRUNCATE bypasses row triggers).
--   5. Read path: Super Admins (audit.read in any company) can read the
--      company-less settings rows (settings.booking_changed,
--      settings.procurement_changed); company rows stay under
--      audit_admin_read.
--   6. Privileges: the secret-key server role (service_role) loses INSERT and
--      UPDATE on integration_intake_config (the app only reads it; every write
--      goes through SECURITY DEFINER commands or owner SQL) and loses INSERT,
--      UPDATE, DELETE and TRUNCATE on audit_events (Supabase default
--      privileges had granted them; the app writes audit rows only through
--      SECURITY DEFINER commands). SELECT stays.
--
-- Not changed: integration_update_sync_settings keeps its own
-- integration.settings_updated row; the trigger adds a
-- settings.intake_config_changed row next to it.
--
-- Rollback (forward-only): a new migration that
--   * drops the triggers booking_settings_audit, finance_live_settings_audit,
--     procurement_settings_audit, integration_intake_config_audit,
--     booking_settings_touch, finance_live_settings_touch,
--     procurement_settings_touch, booking_settings_no_truncate,
--     finance_live_settings_no_truncate, procurement_settings_no_truncate,
--     integration_intake_config_no_truncate and audit_events_no_truncate;
--   * drops the policy audit_settings_global_read on public.audit_events;
--   * drops public.admin_set_finance_live_modes(uuid, jsonb, text),
--     public.admin_set_booking_live(boolean, text),
--     public.admin_set_supplier_confirmation_live(boolean, text) and the
--     authz helpers can_switch_live_settings(uuid),
--     settings_change_reason(text), audit_settings_change(),
--     touch_settings_updated_at(), refuse_settings_truncate(),
--     settings_begin_change(text, text), settings_end_change(text[]);
--   * re-grants insert, update on public.integration_intake_config to
--     service_role.
-- Never delete audit_events rows.

begin;
set local lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Helpers
-- ---------------------------------------------------------------------------

-- Super Admin with a valid aal2 session. p_entity null = Super Admin in any
-- enabled company (the booking and procurement switches are global rows).
create function authz.can_switch_live_settings(p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok() and case
    when p_entity is null then exists (
      select 1 from public.memberships m
      where m.user_id = (select auth.uid()) and m.status = 'active' and m.role_code = 'super_admin'
        and authz.holds_active_role('super_admin', m.legal_entity_id))
    else authz.holds_active_role('super_admin', p_entity)
  end, false)
$$;

-- Required reason for a live switch: 10 to 500 characters after trimming.
create function authz.settings_change_reason(p_reason text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  -- Spaces, tabs and line breaks alone are not a reason.
  v text := btrim(coalesce(p_reason, ''), E' \t\r\n');
begin
  if char_length(v) < 10 or char_length(v) > 500 then
    raise exception 'a reason of 10 to 500 characters is required' using errcode = '22023';
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Safety-net audit trigger (any writer)
-- ---------------------------------------------------------------------------
-- TG_ARGV[0] = audit action; TG_ARGV[1..] = watched columns. An UPDATE that
-- changes no watched column writes nothing.
create function authz.audit_settings_change() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old jsonb := case when tg_op in ('UPDATE', 'DELETE') then to_jsonb(old) end;
  v_new jsonb := case when tg_op in ('INSERT', 'UPDATE') then to_jsonb(new) end;
  v_row jsonb := coalesce(to_jsonb(new), to_jsonb(old));
  v_changes jsonb := '{}'::jsonb;
  v_col text;
  v_reason text := left(nullif(btrim(coalesce(current_setting('tripnavigate.change_reason', true), ''), E' \t\r\n'), ''), 500);
  v_command text := left(nullif(btrim(coalesce(current_setting('tripnavigate.change_command', true), ''), E' \t\r\n'), ''), 100);
  -- SECURITY DEFINER changes current_user, not the SET ROLE setting: 'role'
  -- still names the role the statement ran as (authenticated, service_role)
  -- or 'none' for a direct login role such as postgres.
  v_role text := nullif(current_setting('role', true), 'none');
  v_jwt_role text := (select auth.jwt()) ->> 'role';
  v_via text;
  v_entity uuid;
  v_target uuid;
begin
  foreach v_col in array tg_argv[1:] loop
    if (v_old -> v_col) is distinct from (v_new -> v_col) then
      v_changes := v_changes || jsonb_build_object(v_col, jsonb_build_object('from', v_old -> v_col, 'to', v_new -> v_col));
    end if;
  end loop;
  if tg_op = 'UPDATE' and v_changes = '{}'::jsonb then
    return null;
  end if;

  -- command = one of the admin_set_* commands (label from the transaction
  -- setting); api = any other write made during a Data API request (a
  -- definer command such as integration_update_sync_settings, called as
  -- authenticated, anon or service_role); direct_sql = owner or dashboard SQL.
  v_via := case
    when v_command is not null then 'command'
    when v_role in ('authenticated', 'anon', 'service_role') or v_jwt_role is not null then 'api'
    else 'direct_sql' end;

  v_entity := coalesce(v_row ->> 'legal_entity_id', v_row ->> 'pilot_legal_entity_id')::uuid;
  v_target := coalesce(case when jsonb_typeof(v_row -> 'id') = 'string' then (v_row ->> 'id')::uuid end,
                       (v_row ->> 'legal_entity_id')::uuid);

  perform authz.write_audit(tg_argv[0], v_entity, null, tg_table_name, v_target, v_reason,
    jsonb_build_object(
      'operation', lower(tg_op),
      'changes', v_changes,
      'via', v_via,
      'command', v_command,
      'dbRole', coalesce(v_role, session_user::text),
      'sessionUser', session_user::text,
      'jwtRole', v_jwt_role,
      'reasonGiven', v_reason is not null,
      'transactionId', txid_current()::text));
  return null;
end;
$$;

create trigger booking_settings_audit
  after insert or update or delete on public.booking_settings
  for each row execute function authz.audit_settings_change(
    'settings.booking_changed', 'real_booking_enabled', 'evidence_max_bytes');
create trigger finance_live_settings_audit
  after insert or update or delete on public.finance_live_settings
  for each row execute function authz.audit_settings_change(
    'settings.finance_live_changed', 'bank_transfer_live', 'upi_live', 'cash_live', 'cheque_live');
create trigger procurement_settings_audit
  after insert or update or delete on public.procurement_settings
  for each row execute function authz.audit_settings_change(
    'settings.procurement_changed', 'live_supplier_confirmation_enabled');
create trigger integration_intake_config_audit
  after insert or update or delete on public.integration_intake_config
  for each row execute function authz.audit_settings_change(
    'settings.intake_config_changed', 'enabled', 'portal_domain', 'portal_member_id', 'category_id',
    'eligible_category_ids', 'eligible_stage_ids', 'cutoff_at', 'pilot_legal_entity_id', 'pilot_branch_id',
    'lead_intake_mode', 'deal_intake_mode');

-- ---------------------------------------------------------------------------
-- 3. updated_at follows a real change
-- ---------------------------------------------------------------------------
create function authz.touch_settings_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  if (to_jsonb(new) - 'updated_at') is distinct from (to_jsonb(old) - 'updated_at') then
    new.updated_at := now();
  end if;
  return new;
end;
$$;

create trigger booking_settings_touch before update on public.booking_settings
  for each row execute function authz.touch_settings_updated_at();
create trigger finance_live_settings_touch before update on public.finance_live_settings
  for each row execute function authz.touch_settings_updated_at();
create trigger procurement_settings_touch before update on public.procurement_settings
  for each row execute function authz.touch_settings_updated_at();

-- ---------------------------------------------------------------------------
-- 4. No TRUNCATE (bypasses row triggers)
-- ---------------------------------------------------------------------------
create function authz.refuse_settings_truncate() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% cannot be truncated; change rows with an audited update', tg_table_name using errcode = '42501';
end;
$$;

create trigger booking_settings_no_truncate before truncate on public.booking_settings
  for each statement execute function authz.refuse_settings_truncate();
create trigger finance_live_settings_no_truncate before truncate on public.finance_live_settings
  for each statement execute function authz.refuse_settings_truncate();
create trigger procurement_settings_no_truncate before truncate on public.procurement_settings
  for each statement execute function authz.refuse_settings_truncate();
create trigger integration_intake_config_no_truncate before truncate on public.integration_intake_config
  for each statement execute function authz.refuse_settings_truncate();
create trigger audit_events_no_truncate before truncate on public.audit_events
  for each statement execute function authz.forbid_audit_mutation();

-- ---------------------------------------------------------------------------
-- 5. Commands
-- ---------------------------------------------------------------------------

-- Sets the transaction settings the audit trigger reads, runs nothing else.
-- Returns the previous values so the caller can restore them.
create function authz.settings_begin_change(p_command text, p_reason text) returns text[]
language plpgsql volatile set search_path = '' as $$
declare
  v_prev text[] := array[current_setting('tripnavigate.change_command', true), current_setting('tripnavigate.change_reason', true)];
begin
  perform set_config('tripnavigate.change_command', p_command, true);
  perform set_config('tripnavigate.change_reason', p_reason, true);
  return v_prev;
end;
$$;

create function authz.settings_end_change(p_prev text[]) returns void
language plpgsql volatile set search_path = '' as $$
begin
  perform set_config('tripnavigate.change_command', coalesce(p_prev[1], ''), true);
  perform set_config('tripnavigate.change_reason', coalesce(p_prev[2], ''), true);
end;
$$;

-- p_modes: object with any of bank_transfer, upi, cash, cheque -> boolean.
-- Super Admin of that company at aal2; refused while the person also holds
-- Accounts there (same separation as finance_policy_update).
create function public.admin_set_finance_live_modes(p_entity uuid, p_modes jsonb, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before public.finance_live_settings%rowtype;
  v_after public.finance_live_settings%rowtype;
  v_reason text;
  v_prev text[];
  v_key text;
begin
  if p_entity is null or not authz.can_switch_live_settings(p_entity) or authz.holds_role('accounts', p_entity) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  v_reason := authz.settings_change_reason(p_reason);
  if p_modes is null or jsonb_typeof(p_modes) <> 'object' or p_modes = '{}'::jsonb then
    raise exception 'choose at least one payment mode' using errcode = '22023';
  end if;
  for v_key in select jsonb_object_keys(p_modes) loop
    if v_key not in ('bank_transfer', 'upi', 'cash', 'cheque') or jsonb_typeof(p_modes -> v_key) <> 'boolean' then
      raise exception 'invalid payment mode switch' using errcode = '22023';
    end if;
  end loop;

  select * into v_before from public.finance_live_settings s where s.legal_entity_id = p_entity for update;
  if v_before.legal_entity_id is null then
    raise exception 'finance is not enabled for this company' using errcode = '55000';
  end if;

  v_prev := authz.settings_begin_change('admin_set_finance_live_modes', v_reason);
  update public.finance_live_settings s
  set bank_transfer_live = coalesce((p_modes ->> 'bank_transfer')::boolean, s.bank_transfer_live),
      upi_live = coalesce((p_modes ->> 'upi')::boolean, s.upi_live),
      cash_live = coalesce((p_modes ->> 'cash')::boolean, s.cash_live),
      cheque_live = coalesce((p_modes ->> 'cheque')::boolean, s.cheque_live)
  where s.legal_entity_id = p_entity
  returning * into v_after;
  perform authz.settings_end_change(v_prev);

  return jsonb_build_object(
    'legalEntityId', p_entity,
    'changed', (v_before.bank_transfer_live, v_before.upi_live, v_before.cash_live, v_before.cheque_live)
               is distinct from (v_after.bank_transfer_live, v_after.upi_live, v_after.cash_live, v_after.cheque_live),
    'before', jsonb_build_object('bank_transfer', v_before.bank_transfer_live, 'upi', v_before.upi_live,
                                 'cash', v_before.cash_live, 'cheque', v_before.cheque_live),
    'after', jsonb_build_object('bank_transfer', v_after.bank_transfer_live, 'upi', v_after.upi_live,
                                'cash', v_after.cash_live, 'cheque', v_after.cheque_live),
    'updatedAt', v_after.updated_at);
end;
$$;

create function public.admin_set_booking_live(p_enabled boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before boolean;
  v_after public.booking_settings%rowtype;
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
  select s.real_booking_enabled into v_before from public.booking_settings s where s.id for update;
  if not found then
    raise exception 'settings row missing' using errcode = '55000';
  end if;

  v_prev := authz.settings_begin_change('admin_set_booking_live', v_reason);
  update public.booking_settings s set real_booking_enabled = p_enabled where s.id returning * into v_after;
  perform authz.settings_end_change(v_prev);

  return jsonb_build_object('changed', v_before is distinct from v_after.real_booking_enabled,
    'before', v_before, 'after', v_after.real_booking_enabled, 'updatedAt', v_after.updated_at);
end;
$$;

create function public.admin_set_supplier_confirmation_live(p_enabled boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before boolean;
  v_after public.procurement_settings%rowtype;
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
  select s.live_supplier_confirmation_enabled into v_before from public.procurement_settings s where s.id for update;
  if not found then
    raise exception 'settings row missing' using errcode = '55000';
  end if;

  v_prev := authz.settings_begin_change('admin_set_supplier_confirmation_live', v_reason);
  update public.procurement_settings s set live_supplier_confirmation_enabled = p_enabled where s.id returning * into v_after;
  perform authz.settings_end_change(v_prev);

  return jsonb_build_object('changed', v_before is distinct from v_after.live_supplier_confirmation_enabled,
    'before', v_before, 'after', v_after.live_supplier_confirmation_enabled, 'updatedAt', v_after.updated_at);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Read path for company-less settings audit rows
-- ---------------------------------------------------------------------------
-- audit_admin_read needs a company (legal_entity_id); the booking and
-- procurement switches are global, so their rows have none. A Super Admin
-- (audit.read in any company, valid session) may read exactly those rows.
-- The require_mfa_aal2 / session restrictive policies still apply.
create policy audit_settings_global_read on public.audit_events
  for select to authenticated
  using (legal_entity_id is null and sensitivity = 'standard'
    and action in ('settings.booking_changed', 'settings.procurement_changed')
    and (select authz.can_admin_any('audit.read')));

-- ---------------------------------------------------------------------------
-- 7. Privileges
-- ---------------------------------------------------------------------------

revoke all on function
  authz.can_switch_live_settings(uuid), authz.settings_change_reason(text), authz.audit_settings_change(),
  authz.touch_settings_updated_at(), authz.refuse_settings_truncate(),
  authz.settings_begin_change(text, text), authz.settings_end_change(text[])
from public, anon, authenticated, service_role;

revoke all on function
  public.admin_set_finance_live_modes(uuid, jsonb, text), public.admin_set_booking_live(boolean, text),
  public.admin_set_supplier_confirmation_live(boolean, text)
from public, anon, authenticated, service_role;
grant execute on function
  public.admin_set_finance_live_modes(uuid, jsonb, text), public.admin_set_booking_live(boolean, text),
  public.admin_set_supplier_confirmation_live(boolean, text)
to authenticated;

revoke insert, update on public.integration_intake_config from service_role;
revoke insert, update, delete, truncate on public.audit_events from service_role;

comment on table public.booking_settings is
  'Single-row booking gate. Real (Bitrix) deals confirm only when real_booking_enabled. Changed through public.admin_set_booking_live (Super Admin, reason) or owner SQL; every change is audited by trigger (settings.booking_changed).';
comment on table public.finance_live_settings is
  'Finance is enabled only for entities with a row. Mode switches change through public.admin_set_finance_live_modes (Super Admin, reason) or owner SQL; every change is audited by trigger (settings.finance_live_changed).';
comment on table public.procurement_settings is
  'Single row. live_supplier_confirmation_enabled changes through public.admin_set_supplier_confirmation_live (Super Admin, reason) or owner SQL; every change is audited by trigger (settings.procurement_changed).';

commit;
