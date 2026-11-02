-- Created with the pinned CLI, then ordered after the existing future-dated
-- November product chain BEFORE application. No historical file is modified.
begin;

create or replace function authz.recovery_case_json(p_case_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'caseId', c.id,
    'userId', c.user_id,
    'status', c.status,
    'providerAttempts', c.provider_attempts,
    'lastProviderError', c.last_provider_error,
    'openedAt', c.opened_at,
    'openedBy', c.opened_by,
    'completedAt', c.completed_at,
    'cleanupCompletedAt', c.cleanup_completed_at,
    'cleanupError', c.cleanup_error)
  from public.mfa_recovery_cases c where c.id = p_case_id
$$;


-- Administrators already have row-scoped recovery visibility. Grant only the
-- two status columns, never confirmation codes or factor identities.
grant select (cleanup_completed_at, cleanup_error) on public.mfa_recovery_cases to authenticated;

-- A completed case can retry cleanup without inventing a verification method
-- or asking for a consumed code. The existing command supplies authorization.
create function public.retry_mfa_recovery_cleanup(p_case_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_result jsonb;
begin
  v_result := public.confirm_mfa_recovery(p_case_id, null, null, null);
  if exists (select 1 from public.mfa_recovery_cases c
    join public.mfa_recovery_cases target on target.id = p_case_id
    where c.user_id = target.user_id and c.id <> target.id
      and (c.status <> 'completed' or c.opened_at >= target.opened_at or c.completed_at >= target.completed_at)) then
    raise exception 'recovery case is superseded' using errcode = '22023';
  end if;
  perform authz.audit_for_user('staff.mfa_recovery_cleanup_retry_requested',
    (v_result->>'userId')::uuid, 'mfa_recovery_case', p_case_id, null, '{}'::jsonb);
  return v_result;
end;
$$;
revoke all on function public.retry_mfa_recovery_cleanup(uuid) from public, anon, authenticated;
grant execute on function public.retry_mfa_recovery_cleanup(uuid) to authenticated;

-- Service only, after the caller's authorized begin/confirm/retry command.
-- Snapshot IDs while the case is locked. Never list fresh factors in the
-- provider worker: another attempt may have completed and enrolled a new one.
create function public.get_mfa_recovery_deletion_plan(p_case_id uuid, p_phase text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_case public.mfa_recovery_cases%rowtype;
  v_plan jsonb;
begin
  select * into v_case from public.mfa_recovery_cases where id = p_case_id for update;
  if v_case.id is null or p_phase is null or p_phase not in ('provider', 'cleanup') then
    raise exception 'invalid recovery deletion plan' using errcode = '22023';
  end if;
  if p_phase = 'provider' and v_case.status not in ('provider_pending', 'provider_failed') then
    raise exception 'recovery no longer needs provider removal' using errcode = '22023';
  end if;
  if p_phase = 'cleanup' and (v_case.status <> 'completed' or v_case.new_factor_id is null) then
    raise exception 'recovery is not ready for cleanup' using errcode = '22023';
  end if;
  -- The latest-case check and factor snapshot share one statement snapshot.
  -- A new recovery beginning after this snapshot cannot add IDs to this plan.
  select jsonb_build_object('caseId', v_case.id, 'userId', v_case.user_id,
    'keepFactorId', case when p_phase = 'cleanup' then v_case.new_factor_id else null end,
    'factorIds', case when p_phase = 'cleanup' and v_case.cleanup_completed_at is not null
        and v_case.cleanup_error is null then '[]'::jsonb else
      coalesce((select jsonb_agg(f.id order by f.id) from auth.mfa_factors f
        where f.user_id = v_case.user_id and (p_phase = 'provider' or f.id <> v_case.new_factor_id)), '[]'::jsonb) end)
    into v_plan
  where not exists (select 1 from public.mfa_recovery_cases c
    where c.user_id = v_case.user_id and c.id <> v_case.id
      and (c.status <> 'completed' or c.opened_at >= v_case.opened_at or c.completed_at >= v_case.completed_at))
    and (p_phase = 'provider' or exists (select 1 from auth.mfa_factors f
      where f.user_id = v_case.user_id and f.id = v_case.new_factor_id and f.status = 'verified'));
  if v_plan is null then
    raise exception 'recovery case is superseded or its registered factor is missing' using errcode = '22023';
  end if;
  perform authz.audit_for_user('staff.mfa_recovery_deletion_plan', v_case.user_id,
    'mfa_recovery_case', v_case.id, null, jsonb_build_object('phase', p_phase));
  return v_plan;
end;
$$;
revoke all on function public.get_mfa_recovery_deletion_plan(uuid, text) from public, anon, authenticated;
grant execute on function public.get_mfa_recovery_deletion_plan(uuid, text) to service_role;

create or replace function public.record_mfa_recovery_cleanup_result(p_case_id uuid, p_ok boolean, p_error_code text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_case public.mfa_recovery_cases%rowtype;
  v_error text := authz.clean_error_code(p_error_code);
begin
  if p_ok is null then
    raise exception 'outcome is required' using errcode = '22023';
  end if;
  select * into v_case from public.mfa_recovery_cases where id = p_case_id for update;
  if v_case.id is null or v_case.status <> 'completed' then
    raise exception 'recovery case is not completed' using errcode = '22023';
  end if;
  -- Successful cleanup is monotonic: a late failed worker cannot re-block it.
  if v_case.cleanup_completed_at is not null and v_case.cleanup_error is null then
    return authz.recovery_case_json(v_case.id);
  end if;
  if exists (select 1 from public.mfa_recovery_cases c where c.user_id = v_case.user_id
      and c.id <> v_case.id and (c.status <> 'completed' or c.completed_at >= v_case.completed_at)) then
    raise exception 'recovery case is superseded' using errcode = '22023';
  end if;
  if p_ok and not exists (select 1 from auth.mfa_factors f
      where f.user_id = v_case.user_id and f.id = v_case.new_factor_id and f.status = 'verified') then
    raise exception 'registered recovery factor is missing' using errcode = '22023';
  end if;
  update public.mfa_recovery_cases
  set cleanup_completed_at = case when p_ok then now() else cleanup_completed_at end,
      cleanup_error = case when p_ok then null else coalesce(v_error, 'unknown') end,
      updated_at = now()
  where id = v_case.id;
  perform authz.audit_for_user(
    case when p_ok then 'staff.mfa_recovery_cleanup_ok' else 'staff.mfa_recovery_cleanup_failed' end,
    v_case.user_id, 'mfa_recovery_case', v_case.id, null,
    jsonb_build_object('user_id', v_case.user_id, 'error_code', case when p_ok then null else coalesce(v_error, 'unknown') end));
  return authz.recovery_case_json(v_case.id);
end;
$$;


commit;
