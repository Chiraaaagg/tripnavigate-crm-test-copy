-- TripNavigate CRM - Phase 1.5: session barrier, MFA recovery, staff email
-- deliveries and first-administrator bootstrap.
--
-- Contract: docs/implementation/phase-1-5-contract.md (S1-S7, R1-R7, section 2).
--
-- What changes:
--   * One session rule, decided by the database: authz.session_valid() =
--       aal2
--       AND session auth time (minimum amr[].timestamp of the JWT) is present
--       AND auth time > date_trunc('second', staff_security_state.sessions_valid_after)
--           (same-second sign-in is denied: fail closed)
--       AND auth time > now() - security_policy.session_max_age_seconds
--       AND no open MFA recovery case for the user.
--   * The RESTRICTIVE policy require_mfa_aal2 on all 13 existing tables is
--     replaced by require_valid_session. authz.session_ok() becomes
--     session_valid() AND is_active_staff(), so every existing command inherits it.
--   * Barrier moves (sessions_valid_after = now()): begin_mfa_recovery,
--     record_mfa_recovery_provider_result (ok: barrier = provider completion,
--     so sessions opened while the provider step ran are denied),
--     confirm_mfa_recovery (completion: the staff member signs in again with
--     the new authenticator), deactivate_staff_member (replaced),
--     revoke_my_sessions (aal2 session only).
--   * MFA recovery binds the confirmation code to ONE new factor and to the
--     session that verified with it (auth.sessions.factor_id); the code is shown
--     only to that session. Definer functions read auth.mfa_factors and
--     auth.sessions as the migration owner and fail with SQLSTATE 55000 if those
--     tables are not readable (deployment misconfiguration).
--   * authorize_mfa_reset is dropped (replaced by begin_mfa_recovery).
--   * recovery_verification_methods is created EMPTY. Production recovery cannot
--     complete until the owner approves a method (O06). Synthetic fixtures add a
--     clearly labelled test-only row.
--   * Session max age 43 200 s (12 h) and email limits (60 s / 5 per 24 h) are
--     PROPOSED values, pending owner approval.
--
-- Rollback / recovery (forward-only):
--   This migration is not reversed in place. An emergency rollback is a NEW
--   migration that, in one transaction:
--     1. exports public.mfa_recovery_cases and public.staff_email_deliveries
--        (and the related audit_events) for the audit record;
--     2. for each of the 13 original tables:
--          drop policy require_valid_session on public.<t>;
--          create policy require_mfa_aal2 on public.<t> as restrictive for all
--            to authenticated using ((select authz.is_aal2()))
--            with check ((select authz.is_aal2()));
--     3. create or replace function authz.session_ok() ... as
--          select authz.is_aal2() and authz.is_active_staff();
--        and restores accept_my_invitation() / deactivate_staff_member() bodies
--        from 20261001000100 (and authorize_mfa_reset if the old UI returns);
--     4. drops the new commands, helpers and tables.
--   A faster "unblock everyone" lever that keeps the new model: raise
--   security_policy.session_max_age_seconds, or (owner-approved, audited by
--   hand) complete/close a stuck recovery case as the table owner. Never delete
--   audit_events.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table public.security_policy (
  id boolean primary key default true check (id),
  -- PROPOSED 12 h, owner approval pending (S5).
  session_max_age_seconds integer not null default 43200
    check (session_max_age_seconds between 300 and 604800),
  policy_status text not null default 'proposed' check (policy_status in ('proposed', 'confirmed')),
  updated_at timestamptz not null default now()
);
comment on table public.security_policy is
  'Single-row session policy. The only source of the absolute session lifetime (no env var).';
insert into public.security_policy (id, session_max_age_seconds, policy_status)
values (true, 43200, 'proposed');

create table public.staff_security_state (
  user_id uuid primary key references public.staff_profiles (user_id),
  -- Tokens whose session authenticated at or before this instant (second
  -- precision) are denied by the database.
  sessions_valid_after timestamptz not null default '-infinity',
  updated_at timestamptz not null default now()
);

insert into public.staff_security_state (user_id, sessions_valid_after)
select p.user_id, '-infinity'::timestamptz from public.staff_profiles p
on conflict (user_id) do nothing;

create function authz.create_staff_security_state() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.staff_security_state (user_id, sessions_valid_after)
  values (new.user_id, '-infinity')
  on conflict (user_id) do nothing;
  return new;
end;
$$;
create trigger staff_profiles_security_state
  after insert on public.staff_profiles
  for each row execute function authz.create_staff_security_state();

create table public.recovery_verification_methods (
  code text primary key check (code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  label text not null check (length(btrim(label)) between 1 and 200),
  active boolean not null default true,
  created_at timestamptz not null default now()
);
comment on table public.recovery_verification_methods is
  'Owner-approved identity verification methods for MFA recovery. Intentionally empty in migrations (O06 open).';

create table public.mfa_recovery_cases (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.staff_profiles (user_id),
  status text not null default 'provider_pending' check (status in (
    'provider_pending', 'provider_failed', 'awaiting_reenrollment',
    'awaiting_admin_confirmation', 'completed')),
  reason text not null check (length(btrim(reason)) between 10 and 500),
  provider_attempts integer not null default 0 check (provider_attempts >= 0),
  last_provider_error text,
  provider_completed_at timestamptz,
  new_factor_id uuid,
  -- auth.sessions id that verified with new_factor_id; only it sees the code.
  recovery_session_id uuid,
  -- Shown only to the staff member in the bound post-barrier aal2 session.
  confirmation_code text check (confirmation_code is null or confirmation_code ~ '^[0-9A-Z]{6}$'),
  confirm_failures integer not null default 0 check (confirm_failures >= 0),
  -- Codes issued after the first one (PROPOSED cap: 3).
  code_regenerations integer not null default 0 check (code_regenerations between 0 and 3),
  -- After completion the server removes every other Auth factor.
  cleanup_completed_at timestamptz,
  cleanup_error text,
  verification_method text references public.recovery_verification_methods (code),
  opened_by uuid not null references public.staff_profiles (user_id),
  completed_by uuid references public.staff_profiles (user_id),
  opened_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz,
  check ((status = 'completed') = (completed_at is not null)),
  check (status <> 'completed' or (completed_by is not null and verification_method is not null)),
  check (completed_by is null or completed_by <> user_id),
  check (opened_by <> user_id)
);
-- At most one open case per staff member (R1, T04).
create unique index mfa_recovery_cases_one_open
  on public.mfa_recovery_cases (user_id) where status <> 'completed';

create table public.staff_email_deliveries (
  id uuid primary key default gen_random_uuid(),
  -- Null only for a first invitation recorded before the Auth user exists;
  -- link_invitation_user() fills it in.
  user_id uuid references public.staff_profiles (user_id),
  invitation_id uuid references public.staff_invitations (id),
  kind text not null check (kind in ('invitation', 'invitation_resend', 'password_reset')),
  status text not null default 'pending' check (status in ('pending', 'handed_to_provider', 'failed')),
  attempt_no integer not null check (attempt_no >= 1),
  error_code text check (error_code is null or length(error_code) <= 100),
  created_by uuid references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  check ((status = 'pending') = (completed_at is null)),
  check (user_id is not null or invitation_id is not null),
  check (kind = 'invitation' or user_id is not null),
  check (kind <> 'invitation' or invitation_id is not null)
);
create index staff_email_deliveries_user_kind_idx
  on public.staff_email_deliveries (user_id, kind, created_at desc);
create index staff_email_deliveries_invitation_idx
  on public.staff_email_deliveries (invitation_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Session helpers
-- ---------------------------------------------------------------------------

-- Authentication time of the session = minimum amr[].timestamp (seconds since
-- epoch). NULL when amr is missing, empty or malformed in any element.
create function authz.session_auth_time() returns timestamptz
language plpgsql stable set search_path = '' as $$
declare
  v_amr jsonb := (select auth.jwt()) -> 'amr';
  v_min numeric;
begin
  if v_amr is null or jsonb_typeof(v_amr) <> 'array' or jsonb_array_length(v_amr) = 0 then
    return null;
  end if;
  if exists (
    select 1 from jsonb_array_elements(v_amr) e
    where jsonb_typeof(e) <> 'object' or jsonb_typeof(e -> 'timestamp') is distinct from 'number'
  ) then
    return null;
  end if;
  select min((e ->> 'timestamp')::numeric) into v_min from jsonb_array_elements(v_amr) e;
  -- Reject absurd values (non-positive or beyond year 3000).
  if v_min is null or v_min <= 0 or v_min > 32503680000 then
    return null;
  end if;
  return to_timestamp(v_min::double precision);
end;
$$;

create function authz.has_open_recovery(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.mfa_recovery_cases c
    where c.user_id = p_user and c.status <> 'completed'
  )
$$;

-- S2-S5 for the current JWT, without the recovery-case rule (S6).
create function authz.session_fresh() returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_auth timestamptz;
  v_after timestamptz;
  v_max integer;
begin
  if v_uid is null or not authz.is_aal2() then
    return false;
  end if;
  v_auth := authz.session_auth_time();
  if v_auth is null then
    return false;
  end if;
  select s.sessions_valid_after into v_after from public.staff_security_state s where s.user_id = v_uid;
  if v_after is null then
    return false;
  end if;
  if not (v_auth > date_trunc('second', v_after)) then
    return false;
  end if;
  select p.session_max_age_seconds into v_max from public.security_policy p where p.id;
  if v_max is null or not (v_auth > now() - make_interval(secs => v_max)) then
    return false;
  end if;
  return true;
end;
$$;

-- The single database session rule (S2-S6).
create function authz.session_valid() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(
    authz.session_fresh() and not authz.has_open_recovery((select auth.uid())),
    false)
$$;

create or replace function authz.session_ok() returns boolean
language sql stable set search_path = '' as $$
  select authz.session_valid() and authz.is_active_staff()
$$;

-- Administrator holds p_permission (entity scope) in every entity the target
-- belongs to, and the target has at least one membership.
create function authz.can_admin_user(p_permission text, p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.memberships m where m.user_id = p_user)
    and not exists (
      select 1 from public.memberships m
      where m.user_id = p_user and not authz.can_admin(p_permission, m.legal_entity_id)
    )
$$;

-- Audit once per legal entity of the target (null entity when none).
create function authz.audit_for_user(
  p_action text, p_user uuid, p_target_type text, p_target_id uuid, p_reason text, p_details jsonb
) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  r record;
  v_any boolean := false;
begin
  for r in select distinct m.legal_entity_id from public.memberships m where m.user_id = p_user loop
    v_any := true;
    perform authz.write_audit(p_action, r.legal_entity_id, null, p_target_type, p_target_id, p_reason, p_details);
  end loop;
  if not v_any then
    perform authz.write_audit(p_action, null, null, p_target_type, p_target_id, p_reason, p_details);
  end if;
end;
$$;

create function authz.move_session_barrier(p_user uuid) returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.staff_security_state as s (user_id, sessions_valid_after, updated_at)
  values (p_user, now(), now())
  -- Never moves backwards (e.g. after barrier move #2 in the same transaction).
  on conflict (user_id) do update
    set sessions_valid_after = greatest(s.sessions_valid_after, now()), updated_at = now()
$$;

create function authz.recovery_case_json(p_case_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'caseId', c.id,
    'userId', c.user_id,
    'status', c.status,
    'providerAttempts', c.provider_attempts,
    'lastProviderError', c.last_provider_error,
    'openedAt', c.opened_at,
    'openedBy', c.opened_by,
    'completedAt', c.completed_at)
  from public.mfa_recovery_cases c where c.id = p_case_id
$$;

create function authz.email_delivery_json(p_delivery_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'deliveryId', d.id,
    'userId', d.user_id,
    'invitationId', d.invitation_id,
    'kind', d.kind,
    'status', d.status,
    'attemptNo', d.attempt_no,
    'errorCode', d.error_code,
    'createdAt', d.created_at,
    'completedAt', d.completed_at)
  from public.staff_email_deliveries d where d.id = p_delivery_id
$$;

-- session_id claim of the current JWT (Supabase sets it), or null.
create function authz.jwt_session_id() returns uuid
language plpgsql stable set search_path = '' as $$
declare
  v text := (select auth.jwt()) ->> 'session_id';
begin
  if v is null or v !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return null;
  end if;
  return v::uuid;
end;
$$;

-- Verified Auth factors of a user created strictly after p_after (oldest first).
create function authz.verified_factors_after(p_user uuid, p_after timestamptz) returns uuid[]
language plpgsql stable security definer set search_path = '' as $$
begin
  return coalesce((
    select array_agg(f.id order by f.created_at)
    from auth.mfa_factors f
    where f.user_id = p_user and f.status::text = 'verified' and f.created_at > p_after
  ), '{}'::uuid[]);
exception when insufficient_privilege or undefined_table or undefined_column then
  raise exception 'auth.mfa_factors is not readable by the database owner' using errcode = '55000';
end;
$$;

-- Factor the given Auth session verified with (auth.sessions.factor_id), or null.
create function authz.session_factor(p_session uuid, p_user uuid) returns uuid
language plpgsql stable security definer set search_path = '' as $$
begin
  return (select s.factor_id from auth.sessions s where s.id = p_session and s.user_id = p_user);
exception when insufficient_privilege or undefined_table or undefined_column then
  raise exception 'auth.sessions is not readable by the database owner' using errcode = '55000';
end;
$$;

-- Provider error codes are stored redacted: short, token-like, never free text.
create function authz.clean_error_code(p_code text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_code is null or btrim(p_code) = '' then null
    else left(regexp_replace(btrim(p_code), '[^A-Za-z0-9_.:-]', '_', 'g'), 100)
  end
$$;

revoke all on function
  authz.create_staff_security_state(), authz.session_auth_time(), authz.has_open_recovery(uuid),
  authz.session_fresh(), authz.session_valid(), authz.can_admin_user(text, uuid),
  authz.audit_for_user(text, uuid, text, uuid, text, jsonb), authz.move_session_barrier(uuid),
  authz.recovery_case_json(uuid), authz.email_delivery_json(uuid), authz.clean_error_code(text),
  authz.jwt_session_id(), authz.verified_factors_after(uuid, timestamptz), authz.session_factor(uuid, uuid)
from public;
grant execute on function authz.session_auth_time(), authz.session_valid(), authz.session_fresh(),
  authz.has_open_recovery(uuid), authz.can_admin_user(text, uuid)
to authenticated;

-- ---------------------------------------------------------------------------
-- Policy swap: require_mfa_aal2 -> require_valid_session
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'legal_entities', 'branches', 'staff_profiles', 'roles', 'permissions',
    'role_permissions', 'memberships', 'access_grants', 'staff_invitations',
    'deals', 'deal_assignments', 'deal_commercials', 'audit_events'
  ] loop
    execute format('drop policy require_mfa_aal2 on public.%I', t);
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
  end loop;
end;
$$;

-- New tables: RLS, the same restrictive gate, admin reads, nothing for anon.
alter table public.security_policy enable row level security;
alter table public.staff_security_state enable row level security;
alter table public.recovery_verification_methods enable row level security;
alter table public.mfa_recovery_cases enable row level security;
alter table public.staff_email_deliveries enable row level security;

do $$
declare
  t text;
begin
  foreach t in array array[
    'security_policy', 'staff_security_state', 'recovery_verification_methods',
    'mfa_recovery_cases', 'staff_email_deliveries'
  ] loop
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
  end loop;
end;
$$;

create policy staff_read on public.security_policy
  for select to authenticated using ((select authz.is_active_staff()));

create policy staff_read on public.recovery_verification_methods
  for select to authenticated using ((select authz.is_active_staff()) and active);

create policy own_read on public.staff_security_state
  for select to authenticated using (user_id = (select auth.uid()));
create policy staff_admin_read on public.staff_security_state
  for select to authenticated
  using (exists (
    select 1 from public.memberships m
    where m.user_id = staff_security_state.user_id
      and authz.can_admin('staff.manage', m.legal_entity_id)
  ));

create policy staff_admin_read on public.mfa_recovery_cases
  for select to authenticated
  using (exists (
    select 1 from public.memberships m
    where m.user_id = mfa_recovery_cases.user_id
      and authz.can_admin('staff.manage', m.legal_entity_id)
  ));

create policy staff_admin_read on public.staff_email_deliveries
  for select to authenticated
  using (exists (
    select 1 from public.memberships m
    where m.user_id = staff_email_deliveries.user_id
      and (authz.can_admin('staff.manage', m.legal_entity_id)
        or authz.can_admin('staff.invite', m.legal_entity_id))
  ) or exists (
    select 1 from public.staff_invitations i
    where i.id = staff_email_deliveries.invitation_id
      and authz.can_admin('staff.invite', i.legal_entity_id)
  ));

revoke all on public.security_policy, public.staff_security_state, public.recovery_verification_methods,
  public.mfa_recovery_cases, public.staff_email_deliveries
from public, anon, authenticated;
grant select on public.security_policy, public.staff_security_state,
  public.recovery_verification_methods, public.staff_email_deliveries
to authenticated;
-- Column grant: administrators never read confirmation_code or new_factor_id.
grant select (id, user_id, status, reason, provider_attempts, last_provider_error, provider_completed_at,
  confirm_failures, verification_method, opened_by, completed_by, opened_at, updated_at, completed_at)
on public.mfa_recovery_cases to authenticated;

-- ---------------------------------------------------------------------------
-- Session commands
-- ---------------------------------------------------------------------------

-- The single session decision used by requireStaff(). Callable at any aal.
create function public.my_session_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_policy public.security_policy%rowtype;
  v_profile text;
  v_auth timestamptz;
  v_after timestamptz;
  v_case public.mfa_recovery_cases%rowtype;
  v_state text;
  v_recovery jsonb;
begin
  select * into v_policy from public.security_policy where id;
  if v_uid is null then
    v_state := 'no_session';
  else
    select p.status into v_profile from public.staff_profiles p where p.user_id = v_uid;
    select s.sessions_valid_after into v_after from public.staff_security_state s where s.user_id = v_uid;
    v_auth := authz.session_auth_time();
    if v_profile is null then
      v_state := 'no_membership';
    elsif v_profile = 'inactive' then
      v_state := 'inactive';
    elsif v_auth is null or v_policy.id is null
          or not (v_auth > now() - make_interval(secs => v_policy.session_max_age_seconds)) then
      v_state := 'session_expired';
    elsif v_after is null or not (v_auth > date_trunc('second', v_after)) then
      v_state := 'session_revoked';
    elsif not authz.is_aal2() then
      v_state := 'mfa_required';
    else
      select * into v_case from public.mfa_recovery_cases c
      where c.user_id = v_uid and c.status <> 'completed';
      if v_case.id is not null then
        v_state := 'recovery_pending';
        v_recovery := jsonb_build_object('caseId', v_case.id, 'status', v_case.status);
        if v_case.status = 'awaiting_admin_confirmation' and v_case.confirmation_code is not null
           and v_case.recovery_session_id is not null
           and v_case.recovery_session_id = authz.jwt_session_id() then
          v_recovery := v_recovery || jsonb_build_object('confirmationCode', v_case.confirmation_code);
        end if;
      elsif v_profile = 'invited' then
        v_state := 'onboarding_incomplete';
      elsif not exists (
        select 1 from public.memberships m
        join public.legal_entities e on e.id = m.legal_entity_id
        join public.branches b on b.id = m.branch_id
        where m.user_id = v_uid and m.status = 'active' and e.status = 'enabled' and b.status = 'enabled'
      ) then
        v_state := 'no_membership';
      elsif authz.session_ok() then
        v_state := 'ok';
      else
        v_state := 'session_expired'; -- unreachable by construction; fail closed
      end if;
    end if;
  end if;

  return jsonb_build_object(
    'state', v_state,
    'sessionMaxAgeSeconds', coalesce(v_policy.session_max_age_seconds, 0),
    'policyStatus', coalesce(v_policy.policy_status, 'proposed'))
    || case when v_recovery is null then '{}'::jsonb else jsonb_build_object('recovery', v_recovery) end;
end;
$$;

-- "Sign out of all devices": every token whose session authenticated up to now
-- is denied by the database at once. The server then calls signOut('global').
create function public.revoke_my_sessions() returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  -- Requires a fresh aal2 session (S2-S5; allowed during an open recovery
  -- case). A stolen password-only (aal1) token cannot sign the owner out
  -- everywhere; an old or revoked token has nothing left to revoke.
  if v_uid is null or not exists (select 1 from public.staff_profiles p where p.user_id = v_uid)
     or not authz.session_fresh() then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  perform authz.move_session_barrier(v_uid);
  perform authz.audit_for_user('staff.sessions_revoked', v_uid, 'staff_profile', v_uid, null,
    jsonb_build_object('initiator', 'self'));
end;
$$;

-- ---------------------------------------------------------------------------
-- MFA recovery commands (R1-R7)
-- ---------------------------------------------------------------------------

-- R1: runs BEFORE any provider call. Authorization, barrier move, case insert
-- and audit in one transaction. Repeat/concurrent calls return the same open
-- case (row lock on staff_security_state + unique partial index).
create function public.begin_mfa_recovery(p_user_id uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_profile text;
  v_case_id uuid;
begin
  if v_uid is null or p_user_id is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_user_id = v_uid then
    raise exception 'staff cannot reset their own MFA' using errcode = '42501';
  end if;
  if not authz.can_admin_user('staff.manage', p_user_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) not between 10 and 500 then
    raise exception 'a reason of 10 to 500 characters is required' using errcode = '22023';
  end if;
  select p.status into v_profile from public.staff_profiles p where p.user_id = p_user_id;
  if v_profile is distinct from 'active' then
    raise exception 'only active staff can be put through MFA recovery' using errcode = '22023';
  end if;

  -- Serializes concurrent begins for the same target.
  perform 1 from public.staff_security_state s where s.user_id = p_user_id for update;

  select c.id into v_case_id from public.mfa_recovery_cases c
  where c.user_id = p_user_id and c.status <> 'completed' for update;
  if v_case_id is not null then
    perform authz.audit_for_user('staff.mfa_recovery_resumed', p_user_id, 'mfa_recovery_case', v_case_id,
      null, jsonb_build_object('user_id', p_user_id));
    return authz.recovery_case_json(v_case_id);
  end if;

  perform authz.move_session_barrier(p_user_id);
  insert into public.mfa_recovery_cases (user_id, reason, opened_by)
  values (p_user_id, btrim(p_reason), v_uid)
  returning id into v_case_id;
  perform authz.audit_for_user('staff.mfa_recovery_started', p_user_id, 'mfa_recovery_case', v_case_id,
    btrim(p_reason), jsonb_build_object('user_id', p_user_id, 'barrier_moved', true));
  return authz.recovery_case_json(v_case_id);
end;
$$;

-- R3: service role only. Records the Auth admin API factor-deletion outcome.
create function public.record_mfa_recovery_provider_result(p_case_id uuid, p_ok boolean, p_error_code text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_case public.mfa_recovery_cases%rowtype;
  v_error text := authz.clean_error_code(p_error_code);
  v_done timestamptz;
begin
  if p_ok is null then
    raise exception 'outcome is required' using errcode = '22023';
  end if;
  select * into v_case from public.mfa_recovery_cases where id = p_case_id for update;
  if v_case.id is null then
    raise exception 'recovery case not found' using errcode = '22023';
  end if;
  if v_case.status = 'awaiting_reenrollment' and p_ok then
    return authz.recovery_case_json(v_case.id); -- idempotent retry
  end if;
  if v_case.status not in ('provider_pending', 'provider_failed') then
    raise exception 'recovery case is not waiting for the provider' using errcode = '22023';
  end if;

  if p_ok then
    v_done := clock_timestamp();
    update public.mfa_recovery_cases
    set status = 'awaiting_reenrollment', provider_attempts = provider_attempts + 1,
        provider_completed_at = v_done, last_provider_error = null, updated_at = now()
    where id = v_case.id;
    -- Barrier move #2: sessions that authenticated while the provider step ran
    -- (possibly with the old factor) are denied too.
    update public.staff_security_state
    set sessions_valid_after = greatest(sessions_valid_after, v_done), updated_at = now()
    where user_id = v_case.user_id;
  else
    update public.mfa_recovery_cases
    set status = 'provider_failed', provider_attempts = provider_attempts + 1,
        last_provider_error = coalesce(v_error, 'unknown'), updated_at = now()
    where id = v_case.id;
  end if;
  perform authz.audit_for_user(
    case when p_ok then 'staff.mfa_recovery_provider_ok' else 'staff.mfa_recovery_provider_failed' end,
    v_case.user_id, 'mfa_recovery_case', v_case.id, null,
    jsonb_build_object('user_id', v_case.user_id, 'error_code', case when p_ok then null else coalesce(v_error, 'unknown') end));
  return authz.recovery_case_json(v_case.id);
end;
$$;

-- R4: the staff member, in a post-barrier aal2 session with a NEW verified
-- factor, registers it and receives a confirmation code to read out.
create function public.register_my_recovery_factor() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_session uuid := authz.jwt_session_id();
  v_case public.mfa_recovery_cases%rowtype;
  v_factors uuid[];
  v_factor uuid;
  v_regen integer;
  v_code text;
begin
  if v_uid is null or not authz.session_fresh() or v_session is null then
    raise exception 'a new multi-factor sign-in is required' using errcode = '42501';
  end if;
  select * into v_case from public.mfa_recovery_cases c
  where c.user_id = v_uid and c.status <> 'completed' for update;
  if v_case.id is null then
    raise exception 'no open recovery case' using errcode = '22023';
  end if;
  if v_case.status not in ('awaiting_reenrollment', 'awaiting_admin_confirmation')
     or v_case.provider_completed_at is null then
    raise exception 'recovery case is not ready for a new authenticator' using errcode = '22023';
  end if;
  -- Explicit (also implied by barrier move #2): this session started after the provider step.
  if not (authz.session_auth_time() > date_trunc('second', v_case.provider_completed_at)) then
    raise exception 'a new multi-factor sign-in is required' using errcode = '42501';
  end if;
  -- Idempotent for the bound session.
  if v_case.status = 'awaiting_admin_confirmation' and v_case.recovery_session_id = v_session
     and v_case.confirm_failures < 5 then
    return jsonb_build_object('status', v_case.status, 'confirmation_code', v_case.confirmation_code);
  end if;

  v_factors := authz.verified_factors_after(v_uid, v_case.provider_completed_at);
  if cardinality(v_factors) = 0 then
    raise exception 'no new verified authenticator found' using errcode = '22023';
  end if;
  if cardinality(v_factors) > 1 then
    -- Refused WITHOUT raising so the audit row persists: more than one new
    -- authenticator means someone else may have enrolled one.
    perform authz.audit_for_user('staff.mfa_recovery_extra_factor', v_uid, 'mfa_recovery_case', v_case.id,
      null, jsonb_build_object('user_id', v_uid, 'new_factor_count', cardinality(v_factors)));
    return jsonb_build_object('status', v_case.status, 'confirmation_code', null, 'refused', 'extra_factor');
  end if;
  v_factor := v_factors[1];
  if authz.session_factor(v_session, v_uid) is distinct from v_factor then
    raise exception 'this session was not verified with the new authenticator' using errcode = '42501';
  end if;

  -- A code was already issued: re-issuing counts against the PROPOSED cap.
  v_regen := v_case.code_regenerations;
  if v_case.status = 'awaiting_admin_confirmation' then
    if v_regen >= 3 then
      raise exception 'too many new codes for this recovery; ask an administrator to deactivate and re-invite'
        using errcode = '54000';
    end if;
    v_regen := v_regen + 1;
  end if;

  -- Derived from the factor, case and session plus a random salt, so neither
  -- the administrator nor anyone who knows the factor id can compute it.
  v_code := upper(left(encode(sha256(convert_to(
    v_factor::text || ':' || v_case.id::text || ':' || v_session::text || ':' || gen_random_uuid()::text,
    'UTF8')), 'hex'), 6));

  update public.mfa_recovery_cases
  set status = 'awaiting_admin_confirmation', new_factor_id = v_factor, recovery_session_id = v_session,
      confirmation_code = v_code, confirm_failures = 0, code_regenerations = v_regen, updated_at = now()
  where id = v_case.id;
  perform authz.audit_for_user('staff.mfa_recovery_factor_registered', v_uid, 'mfa_recovery_case', v_case.id,
    null, jsonb_build_object('user_id', v_uid, 'code_regenerations', v_regen));
  return jsonb_build_object('status', 'awaiting_admin_confirmation', 'confirmation_code', v_code);
end;
$$;

-- R5: an administrator (not the target) confirms with an APPROVED verification
-- method and the code the staff member reads out. A mismatch changes no status
-- but is counted and audited (so it does not raise).
create function public.confirm_mfa_recovery(
  p_case_id uuid, p_method text, p_confirmation_code text, p_note text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_case public.mfa_recovery_cases%rowtype;
  v_note text := nullif(btrim(coalesce(p_note, '')), '');
begin
  select * into v_case from public.mfa_recovery_cases where id = p_case_id for update;
  if v_uid is null or v_case.id is null or not authz.can_admin_user('staff.manage', v_case.user_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_case.user_id = v_uid then
    raise exception 'staff cannot confirm their own recovery' using errcode = '42501';
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'note is too long' using errcode = '22023';
  end if;
  if v_case.status = 'completed' then
    return authz.recovery_case_json(v_case.id);
  end if;
  if v_case.status <> 'awaiting_admin_confirmation' then
    raise exception 'the staff member has not registered a new authenticator yet' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.recovery_verification_methods m where m.code = p_method and m.active
  ) then
    raise exception 'verification method is not approved' using errcode = '22023';
  end if;
  if v_case.new_factor_id is null or not (v_case.new_factor_id = any (
       authz.verified_factors_after(v_case.user_id, v_case.provider_completed_at))) then
    raise exception 'the new authenticator is no longer present; the staff member must register again'
      using errcode = '22023';
  end if;
  if v_case.confirm_failures >= 5 then
    raise exception 'too many wrong codes; the staff member must open the recovery page again for a new code'
      using errcode = '54000';
  end if;

  if v_case.confirmation_code is null
     or upper(btrim(coalesce(p_confirmation_code, ''))) <> v_case.confirmation_code then
    update public.mfa_recovery_cases
    set confirm_failures = confirm_failures + 1, updated_at = now()
    where id = v_case.id;
    perform authz.audit_for_user('staff.mfa_recovery_confirm_failed', v_case.user_id, 'mfa_recovery_case',
      v_case.id, v_note, jsonb_build_object('user_id', v_case.user_id, 'method', p_method,
        'failures', v_case.confirm_failures + 1));
    return authz.recovery_case_json(v_case.id);
  end if;

  update public.mfa_recovery_cases
  set status = 'completed', completed_at = now(), completed_by = v_uid, verification_method = p_method,
      confirmation_code = null, updated_at = now()
  where id = v_case.id;
  -- Barrier move on completion: every session, including the bound recovery
  -- session, ends; the staff member signs in again with the new authenticator.
  perform authz.move_session_barrier(v_case.user_id);
  perform authz.audit_for_user('staff.mfa_recovery_completed', v_case.user_id, 'mfa_recovery_case',
    v_case.id, v_note, jsonb_build_object('user_id', v_case.user_id, 'method', p_method, 'barrier_moved', true));
  return authz.recovery_case_json(v_case.id);
end;
$$;

-- Service role only: what the server needs to remove every OTHER Auth factor
-- after completion (the admin never sees new_factor_id).
create function public.get_mfa_recovery_cleanup(p_case_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_case public.mfa_recovery_cases%rowtype;
begin
  select * into v_case from public.mfa_recovery_cases where id = p_case_id;
  if v_case.id is null or v_case.status <> 'completed' or v_case.new_factor_id is null then
    raise exception 'recovery case is not completed' using errcode = '22023';
  end if;
  return jsonb_build_object('caseId', v_case.id, 'userId', v_case.user_id, 'keepFactorId', v_case.new_factor_id);
end;
$$;

-- Service role only: outcome of removing the other factors.
create function public.record_mfa_recovery_cleanup_result(p_case_id uuid, p_ok boolean, p_error_code text)
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

-- ---------------------------------------------------------------------------
-- Staff email deliveries (R03, N06)
-- ---------------------------------------------------------------------------

-- PROPOSED limits: one per 60 s and five per 24 h per user and kind.
create function public.request_staff_email(p_user_id uuid, p_kind text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_profile text;
  v_last timestamptz;
  v_day integer;
  v_total integer;
  v_id uuid;
  v_wait integer;
begin
  if v_uid is null or p_user_id is null then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('invitation_resend', 'password_reset') then
    raise exception 'unknown email kind (first invitations use request_invitation_email)' using errcode = '22023';
  end if;
  if not authz.can_admin_user(
       case when p_kind = 'password_reset' then 'staff.manage' else 'staff.invite' end, p_user_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_user_id = v_uid then
    raise exception 'use the sign-in page to reset your own password' using errcode = '42501';
  end if;

  -- Serializes concurrent requests for the same person.
  perform 1 from public.staff_security_state s where s.user_id = p_user_id for update;
  select p.status into v_profile from public.staff_profiles p where p.user_id = p_user_id;
  if p_kind = 'invitation_resend' then
    if v_profile is distinct from 'invited' or not exists (
      select 1 from public.staff_invitations i where i.user_id = p_user_id and i.status = 'sent'
    ) then
      raise exception 'this person has no open invitation' using errcode = '22023';
    end if;
  elsif v_profile is distinct from 'active' then
    raise exception 'password reset is only for active staff' using errcode = '22023';
  end if;

  select max(d.created_at),
         count(*) filter (where d.created_at > now() - interval '24 hours'),
         count(*)
  into v_last, v_day, v_total
  from public.staff_email_deliveries d
  where d.user_id = p_user_id and d.kind = p_kind;
  if v_last is not null and v_last > now() - interval '60 seconds' then
    v_wait := greatest(1, ceil(extract(epoch from (v_last + interval '60 seconds' - now())))::integer);
    raise exception 'too soon; retry after % seconds', v_wait
      using errcode = '54000', hint = format('retry_after_seconds=%s', v_wait);
  end if;
  if v_day >= 5 then
    raise exception 'daily limit reached for this email type'
      using errcode = '54000', hint = 'retry_after_seconds=86400';
  end if;

  insert into public.staff_email_deliveries (user_id, kind, attempt_no, created_by)
  values (p_user_id, p_kind, v_total + 1, v_uid)
  returning id into v_id;
  perform authz.audit_for_user('staff.email_requested', p_user_id, 'staff_email_delivery', v_id, null,
    jsonb_build_object('user_id', p_user_id, 'kind', p_kind, 'attempt_no', v_total + 1));
  return authz.email_delivery_json(v_id);
end;
$$;

-- First invitation email, recorded BEFORE the provider call (the Auth user
-- does not exist yet, so the row is keyed by the invitation). Same PROPOSED
-- limits, per invitation.
create function public.request_invitation_email(p_invitation_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_inv public.staff_invitations%rowtype;
  v_last timestamptz;
  v_day integer;
  v_total integer;
  v_id uuid;
  v_wait integer;
begin
  select * into v_inv from public.staff_invitations where id = p_invitation_id for update;
  if v_uid is null or v_inv.id is null or not authz.can_admin('staff.invite', v_inv.legal_entity_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_inv.status not in ('pending', 'sent') then
    raise exception 'invitation is not open' using errcode = '22023';
  end if;
  select max(d.created_at),
         count(*) filter (where d.created_at > now() - interval '24 hours'),
         count(*)
  into v_last, v_day, v_total
  from public.staff_email_deliveries d
  where d.invitation_id = p_invitation_id and d.kind = 'invitation';
  if v_last is not null and v_last > now() - interval '60 seconds' then
    v_wait := greatest(1, ceil(extract(epoch from (v_last + interval '60 seconds' - now())))::integer);
    raise exception 'too soon; retry after % seconds', v_wait
      using errcode = '54000', hint = format('retry_after_seconds=%s', v_wait);
  end if;
  if v_day >= 5 then
    raise exception 'daily limit reached for this email type'
      using errcode = '54000', hint = 'retry_after_seconds=86400';
  end if;
  insert into public.staff_email_deliveries (user_id, invitation_id, kind, attempt_no, created_by)
  values (v_inv.user_id, v_inv.id, 'invitation', v_total + 1, v_uid)
  returning id into v_id;
  perform authz.write_audit('staff.email_requested', v_inv.legal_entity_id, v_inv.branch_id,
    'staff_email_delivery', v_id, null,
    jsonb_build_object('invitation_id', v_inv.id, 'kind', 'invitation', 'attempt_no', v_total + 1));
  return authz.email_delivery_json(v_id);
end;
$$;

-- Service role only: what the mail provider said. "handed_to_provider" never
-- means delivered.
create function public.record_staff_email_result(p_delivery_id uuid, p_ok boolean, p_error_code text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_d public.staff_email_deliveries%rowtype;
  v_error text := authz.clean_error_code(p_error_code);
begin
  if p_ok is null then
    raise exception 'outcome is required' using errcode = '22023';
  end if;
  select * into v_d from public.staff_email_deliveries where id = p_delivery_id for update;
  if v_d.id is null then
    raise exception 'delivery not found' using errcode = '22023';
  end if;
  if v_d.status <> 'pending' then
    if v_d.status = (case when p_ok then 'handed_to_provider' else 'failed' end) then
      return authz.email_delivery_json(v_d.id); -- idempotent retry
    end if;
    raise exception 'delivery outcome already recorded' using errcode = '22023';
  end if;
  update public.staff_email_deliveries
  set status = case when p_ok then 'handed_to_provider' else 'failed' end,
      error_code = case when p_ok then null else coalesce(v_error, 'unknown') end,
      completed_at = now()
  where id = v_d.id;
  if v_d.user_id is not null then
    perform authz.audit_for_user(
      case when p_ok then 'staff.email_handed_to_provider' else 'staff.email_failed' end,
      v_d.user_id, 'staff_email_delivery', v_d.id, null,
      jsonb_build_object('user_id', v_d.user_id, 'kind', v_d.kind,
        'error_code', case when p_ok then null else coalesce(v_error, 'unknown') end));
  else
    perform authz.write_audit(
      case when p_ok then 'staff.email_handed_to_provider' else 'staff.email_failed' end,
      i.legal_entity_id, i.branch_id, 'staff_email_delivery', v_d.id, null,
      jsonb_build_object('invitation_id', v_d.invitation_id, 'kind', v_d.kind,
        'error_code', case when p_ok then null else coalesce(v_error, 'unknown') end))
    from public.staff_invitations i where i.id = v_d.invitation_id;
  end if;
  return authz.email_delivery_json(v_d.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- First administrator (service role only)
-- ---------------------------------------------------------------------------

-- p_operator: who ran the bootstrap (BOOTSTRAP_OPERATOR), recorded in the audit.
-- Creates an INVITED profile + super_admin membership; the administrator still
-- sets a password and enrols MFA through the normal invitation link, and
-- accept_my_invitation() activates them.
create function public.bootstrap_first_admin(
  p_user_id uuid, p_email text, p_display_name text, p_branch_code text, p_operator text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text := btrim(coalesce(p_display_name, ''));
  v_operator text := btrim(coalesce(p_operator, ''));
  v_branch public.branches%rowtype;
  v_existing record;
  v_count integer;
begin
  if p_user_id is null or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'
     or length(v_name) not between 1 and 120 or length(v_operator) not between 1 and 120 then
    raise exception 'user id, email, display name and operator are required' using errcode = '22023';
  end if;

  -- One bootstrap at a time.
  lock table public.memberships in share row exclusive mode;

  for v_existing in
    select m.user_id, p.work_email
    from public.memberships m join public.staff_profiles p on p.user_id = m.user_id
    where m.role_code = 'super_admin' and m.status <> 'inactive' and p.status <> 'inactive'
  loop
    if v_existing.user_id = p_user_id and v_existing.work_email = v_email then
      return jsonb_build_object('outcome', 'already_admin');
    end if;
    raise exception 'an administrator already exists; use the staff screen instead' using errcode = '42501';
  end loop;

  begin
    if not exists (select 1 from auth.users u where u.id = p_user_id and lower(u.email) = v_email) then
      raise exception 'auth user does not match the email' using errcode = '22023';
    end if;
  exception when insufficient_privilege or undefined_table or undefined_column then
    raise exception 'auth.users is not readable by the database owner' using errcode = '55000';
  end;
  select count(*) into v_count
  from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
  where b.code = p_branch_code and b.status = 'enabled' and e.status = 'enabled' and not e.is_synthetic;
  if v_count <> 1 then
    raise exception 'branch code must identify exactly one enabled branch' using errcode = '22023';
  end if;
  select b.* into v_branch
  from public.branches b join public.legal_entities e on e.id = b.legal_entity_id
  where b.code = p_branch_code and b.status = 'enabled' and e.status = 'enabled' and not e.is_synthetic;

  if exists (select 1 from public.staff_profiles p where p.user_id = p_user_id and (p.work_email <> v_email or p.status = 'inactive'))
     or exists (select 1 from public.staff_profiles p where p.work_email = v_email and p.user_id <> p_user_id) then
    raise exception 'a different or inactive staff profile exists for this person' using errcode = '23505';
  end if;

  insert into public.staff_profiles (user_id, display_name, work_email, status)
  values (p_user_id, v_name, v_email, 'invited')
  on conflict (user_id) do nothing;
  insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status)
  values (p_user_id, v_branch.legal_entity_id, v_branch.id, 'super_admin', 'invited')
  on conflict (user_id, branch_id, role_code) do update set status = 'invited', deactivated_at = null;

  perform authz.write_audit('staff.bootstrap_admin', v_branch.legal_entity_id, v_branch.id,
    'staff_profile', p_user_id, null,
    jsonb_build_object('operator', v_operator, 'email_domain', split_part(v_email, '@', 2)));
  return jsonb_build_object('outcome', 'created');
end;
$$;

-- ---------------------------------------------------------------------------
-- Replaced commands
-- ---------------------------------------------------------------------------

-- Invited user completes onboarding. Requires a fully valid session (aal2,
-- fresh, after the barrier, no open recovery case).
create or replace function public.accept_my_invitation() returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
  r record;
begin
  if v_uid is null or not authz.session_valid() then
    raise exception 'multi-factor authentication required' using errcode = '42501';
  end if;
  select status into v_status from public.staff_profiles where user_id = v_uid for update;
  if v_status is null or v_status = 'inactive' then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_status = 'active' then
    return;
  end if;

  update public.staff_profiles set status = 'active', activated_at = now() where user_id = v_uid;
  update public.memberships set status = 'active' where user_id = v_uid and status = 'invited';
  for r in
    update public.staff_invitations set status = 'accepted', accepted_at = now()
    where user_id = v_uid and status = 'sent'
    returning id, legal_entity_id, branch_id
  loop
    perform authz.write_audit('staff.invitation_accepted', r.legal_entity_id, r.branch_id,
      'staff_invitation', r.id, null, '{}'::jsonb);
  end loop;
end;
$$;

-- Offboarding. Also moves the session barrier so every open session of the
-- target is denied by the database at once (the server additionally bans).
create or replace function public.deactivate_staff_member(p_user_id uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  r record;
begin
  if p_user_id = auth.uid() then
    raise exception 'staff cannot deactivate themselves' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a deactivation reason of at least 10 characters is required' using errcode = '22023';
  end if;
  if not authz.can_admin_user('staff.manage', p_user_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

  perform authz.move_session_barrier(p_user_id);
  update public.staff_profiles
  set status = 'inactive', deactivated_at = now(), deactivation_reason = btrim(p_reason)
  where user_id = p_user_id and status <> 'inactive';
  update public.memberships
  set status = 'inactive', deactivated_at = now()
  where user_id = p_user_id and status <> 'inactive';
  update public.access_grants
  set revoked_at = now(), revoked_by = auth.uid(), revocation_reason = 'Staff member deactivated'
  where user_id = p_user_id and revoked_at is null;
  update public.staff_invitations set status = 'cancelled'
  where user_id = p_user_id and status in ('pending', 'sent');

  for r in select distinct legal_entity_id from public.memberships where user_id = p_user_id loop
    perform authz.write_audit('staff.deactivated', r.legal_entity_id, null,
      'staff_profile', p_user_id, btrim(p_reason), '{}'::jsonb);
  end loop;
end;
$$;

-- Same as 20261001000100, plus: the first-invitation delivery row (recorded
-- before the Auth user existed) gets the user id.
create or replace function public.link_invitation_user(p_invitation_id uuid, p_user_id uuid)
returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_inv public.staff_invitations%rowtype;
begin
  select * into v_inv from public.staff_invitations where id = p_invitation_id for update;
  if v_inv.id is null or v_inv.status not in ('pending', 'sent') then
    raise exception 'invitation is not open' using errcode = '22023';
  end if;
  if v_inv.status = 'sent' and v_inv.user_id = p_user_id then
    return; -- idempotent retry
  end if;

  insert into public.staff_profiles (user_id, display_name, work_email, status)
  values (p_user_id, v_inv.display_name, v_inv.email, 'invited')
  on conflict (user_id) do nothing;

  insert into public.memberships (user_id, legal_entity_id, branch_id, role_code, status, created_by)
  values (p_user_id, v_inv.legal_entity_id, v_inv.branch_id, v_inv.role_code, 'invited', v_inv.invited_by)
  on conflict (user_id, branch_id, role_code) do nothing;

  update public.staff_invitations
  set status = 'sent', user_id = p_user_id, sent_at = now()
  where id = p_invitation_id;

  update public.staff_email_deliveries
  set user_id = p_user_id
  where invitation_id = p_invitation_id and user_id is null;

  insert into public.audit_events
    (actor_user_id, legal_entity_id, branch_id, action, target_type, target_id, details)
  values (v_inv.invited_by, v_inv.legal_entity_id, v_inv.branch_id, 'staff.invitation_sent',
    'staff_invitation', v_inv.id, jsonb_build_object('user_id', p_user_id));
end;
$$;

drop function public.authorize_mfa_reset(uuid, text);

-- ---------------------------------------------------------------------------
-- Grants (explicit; nothing for anon)
-- ---------------------------------------------------------------------------

revoke all on function
  public.my_session_status(),
  public.revoke_my_sessions(),
  public.begin_mfa_recovery(uuid, text),
  public.record_mfa_recovery_provider_result(uuid, boolean, text),
  public.register_my_recovery_factor(),
  public.confirm_mfa_recovery(uuid, text, text, text),
  public.get_mfa_recovery_cleanup(uuid),
  public.record_mfa_recovery_cleanup_result(uuid, boolean, text),
  public.request_staff_email(uuid, text),
  public.request_invitation_email(uuid),
  public.record_staff_email_result(uuid, boolean, text),
  public.bootstrap_first_admin(uuid, text, text, text, text),
  public.accept_my_invitation(),
  public.deactivate_staff_member(uuid, text),
  public.link_invitation_user(uuid, uuid)
from public, anon, authenticated;

grant execute on function
  public.my_session_status(),
  public.revoke_my_sessions(),
  public.begin_mfa_recovery(uuid, text),
  public.register_my_recovery_factor(),
  public.confirm_mfa_recovery(uuid, text, text, text),
  public.request_staff_email(uuid, text),
  public.request_invitation_email(uuid),
  public.accept_my_invitation(),
  public.deactivate_staff_member(uuid, text)
to authenticated;

grant execute on function
  public.record_mfa_recovery_provider_result(uuid, boolean, text),
  public.record_staff_email_result(uuid, boolean, text),
  public.get_mfa_recovery_cleanup(uuid),
  public.record_mfa_recovery_cleanup_result(uuid, boolean, text),
  public.bootstrap_first_admin(uuid, text, text, text, text),
  public.link_invitation_user(uuid, uuid)
to service_role;
