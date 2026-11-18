-- TripNavigate CRM - Accounts phase 3, track E: switch-state read for the
-- screens (track U). Contract 9.1 / 14 / 17.2.
--
-- New: public.rate_contracts_state() -> {enabled, canSwitch} for Purchase,
-- Managers and Accounts of an entity (section 14 readers) and Super Admins
-- (the switch owners); null for everyone else. Writes nothing.
-- Rollback (forward-only): a new migration revoking execute on it.

begin;
set local lock_timeout = '15s';

create function public.rate_contracts_state() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_switch boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_switch := coalesce(authz.can_switch_live_settings(null), false);
  if not v_switch and not exists (select 1 from unnest(authz.vn_member_entities()) e where authz.rc_can_read(e)) then
    return null;
  end if;
  return jsonb_build_object('enabled', authz.rate_contracts_enabled(), 'canSwitch', v_switch);
end;
$$;

revoke all on function public.rate_contracts_state() from public, anon, authenticated, service_role;
grant execute on function public.rate_contracts_state() to authenticated;

commit;
