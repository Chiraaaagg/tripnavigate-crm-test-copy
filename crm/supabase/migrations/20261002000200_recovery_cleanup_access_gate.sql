-- Forward-only Phase 1.5 completion fix. Created using the pinned CLI, then
-- ordered after the existing future-dated 20261002000100 migration.
-- Confirmation alone must not restore access if provider cleanup failed.
-- Even after cleanup, a surviving Auth token must not regain CRM access by
-- enrolling an unapproved factor: recovered accounts use the approved factor
-- until a subsequent administrator-assisted recovery approves another one.
begin;

create function authz.recovered_session_allowed() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_case public.mfa_recovery_cases%rowtype;
  v_session uuid := authz.jwt_session_id();
begin
  if v_uid is null then return false; end if;
  select * into v_case from public.mfa_recovery_cases
  where user_id = v_uid and status = 'completed'
  order by completed_at desc, id desc limit 1;
  if v_case.id is null then return true; end if;
  if v_case.cleanup_completed_at is null or v_case.cleanup_error is not null
     or v_case.new_factor_id is null or v_session is null then
    return false;
  end if;
  return authz.session_factor(v_session, v_uid) = v_case.new_factor_id
    and v_case.new_factor_id = any(authz.verified_factors_after(v_uid, v_case.provider_completed_at));
end;
$$;
revoke all on function authz.recovered_session_allowed() from public, anon, authenticated;

create or replace function authz.session_valid() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_fresh()
    and not authz.has_open_recovery((select auth.uid()))
    and authz.recovered_session_allowed(), false)
$$;

commit;
