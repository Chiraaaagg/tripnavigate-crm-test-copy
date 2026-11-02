-- TripNavigate CRM - Direction A Batch 1, B1-1 follow-up (owner DEC-55, plan.md
-- section 12c): the "Show Bitrix names" control on the Bitrix sync page needs
-- the current state and "last changed by / when", read by the server.
--
-- Fix-forward in the Batch 1 range (20261121000140). The switch command
-- public.integration_set_bitrix_name_read and its audit (the settings trigger
-- integration_intake_config_audit plus integration.bitrix_name_read_set) come
-- from 20261121000100 and are unchanged here.
--
-- What changes:
--   1. Read public.bitrix_name_read_state(): integration administrators
--      (integration.manage) and Super Admins of the configuration's entity at
--      aal2. Answers {enabled, connectionEnabled, effective, canSwitch,
--      lastChange}. enabled is the switch itself; connectionEnabled is the
--      Bitrix connection (integration_intake_config.enabled); effective is
--      both, exactly when bitrix_name_map() shows names (Echo L1: the card
--      never says On while every screen shows codes). lastChange is the newest
--      settings audit UPDATE row of the configuration whose changes name
--      bitrix_name_read (any writer: the command, the Data API or direct SQL;
--      the row written when a configuration is first created is not a change):
--      {at, byName (display name, null for a database-level change), via
--      (command | api | direct_sql), to (the new value), reason (null when
--      none was given)}; null when the switch was never changed.
--      A missing or ambiguous configuration raises 55000 'intake is not
--      configured' (the screen shows Unknown, never Off).
--   2. Partial index audit_events (target_id, occurred_at desc) for the
--      configuration's settings rows, so the read stays one short index scan.
--
-- Refusal tokens: 42501 not_authorized; 55000 intake is not configured.
-- Reads write nothing. Rollback (forward-only): a new migration revoking
-- execute on public.bitrix_name_read_state(); the index can stay.
--
-- Apply history: this file has run only on disposable local and CI stacks.
-- It was amended in place on 19 October 2026 after the Echo-A review
-- (echo-redesign-batch1-data.md: M1, L1-L3, L5, L7) before any kept or live
-- database applied it.

begin;
set local lock_timeout = '15s';

create index audit_events_intake_config_changes_idx
  on public.audit_events (target_id, occurred_at desc)
  where action = 'settings.intake_config_changed';

create function public.bitrix_name_read_state() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_n integer;
  v_last public.audit_events%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select count(*) into v_n from public.integration_intake_config;
  if v_n <> 1 then
    raise exception 'intake is not configured' using errcode = '55000';
  end if;
  select * into v_cfg from public.integration_intake_config;
  if not (coalesce(authz.can_admin('integration.manage', v_cfg.pilot_legal_entity_id), false)
          or authz.can_switch_live_settings(v_cfg.pilot_legal_entity_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select a.* into v_last
  from public.audit_events a
  where a.action = 'settings.intake_config_changed' and a.target_id = v_cfg.id
    and a.details ->> 'operation' = 'update' and (a.details -> 'changes') ? 'bitrix_name_read'
  order by a.occurred_at desc, a.id desc
  limit 1;
  return jsonb_build_object(
    'enabled', v_cfg.bitrix_name_read,
    'connectionEnabled', v_cfg.enabled,
    'effective', v_cfg.enabled and v_cfg.bitrix_name_read,
    'canSwitch', authz.can_switch_live_settings(v_cfg.pilot_legal_entity_id),
    'lastChange', case when v_last.id is null then null else jsonb_build_object(
      'at', v_last.occurred_at,
      'byName', (select p.display_name from public.staff_profiles p where p.user_id = v_last.actor_user_id),
      'via', v_last.details ->> 'via',
      'to', v_last.details -> 'changes' -> 'bitrix_name_read' -> 'to',
      'reason', v_last.reason) end);
end;
$$;

comment on function public.bitrix_name_read_state() is
  'Direction A B1-1 / DEC-55: state of the switch bitrix_name_read, whether the caller may change it, and who changed it last and when (from the settings audit row). Integration administrators and Super Admins only.';

revoke all on function public.bitrix_name_read_state() from public, anon, authenticated, service_role;
grant execute on function public.bitrix_name_read_state() to authenticated;

commit;
