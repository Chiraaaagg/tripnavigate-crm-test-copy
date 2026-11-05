-- Independent review of the recovery UI (8 October 2026): a retry posted from
-- a stale Staff page must never open a NEW recovery case. begin_mfa_recovery
-- opens a case (and moves the session barrier) whenever none is open, so a
-- retry for a case that completed meanwhile would block the person again and
-- delete the authenticator they had just enrolled. This command binds the
-- retry to the exact case the page showed. Forward-only; no applied file is
-- edited.
begin;

create function public.resume_mfa_recovery_provider(p_case_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_user uuid;
  v_status text;
begin
  select c.user_id into v_user from public.mfa_recovery_cases c where c.id = p_case_id;
  -- An unknown case looks exactly like a case the caller may not manage.
  if v_uid is null or v_user is null or v_user = v_uid
     or not authz.can_admin_user('staff.manage', v_user) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  -- Same lock order as begin_mfa_recovery: target security state, then case.
  perform 1 from public.staff_security_state s where s.user_id = v_user for update;
  select c.status into v_status from public.mfa_recovery_cases c where c.id = p_case_id for update;
  if v_status is null or v_status not in ('provider_pending', 'provider_failed') then
    raise exception 'this recovery case has moved on; reload the Staff page' using errcode = '22023';
  end if;
  -- The case is locked and still open, so begin resumes it (audited as
  -- resumed) and cannot open another one or move the barrier.
  return public.begin_mfa_recovery(v_user, 'Resume of the authenticator provider step for this recovery case');
end;
$$;
revoke all on function public.resume_mfa_recovery_provider(uuid) from public, anon, authenticated;
grant execute on function public.resume_mfa_recovery_provider(uuid) to authenticated;

commit;
