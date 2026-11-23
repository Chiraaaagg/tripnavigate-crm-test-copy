-- TripNavigate CRM - Batch 1: identity and access foundation.
--
-- Scope: legal entities, branches, staff profiles, roles/permissions, memberships,
-- explicit access grants, staff invitations, synthetic deal/assignment fixtures
-- tables, and an append-only audit log.
--
-- Security model (see docs/implementation/02-access-model.md):
--   * Every exposed table has RLS enabled plus a RESTRICTIVE policy that requires
--     an `aal2` (MFA-verified) session. Enrollment UI alone is not relied on.
--   * Authorization helpers live in the private `authz` schema, which is not
--     exposed through the Data API.
--   * `authenticated` receives SELECT only. All writes go through SECURITY DEFINER
--     command functions that derive the actor from auth.uid(), re-check
--     permissions and MFA, and write the audit event in the same transaction.
--   * No money posting, tax configuration, GSTIN or production staff data here.

-- ---------------------------------------------------------------------------
-- Schemas and default privileges
-- ---------------------------------------------------------------------------

create schema if not exists authz;
revoke all on schema authz from public;
grant usage on schema authz to authenticated, service_role;

-- Supabase grants broad default privileges on new public objects. This project
-- opts out: each table/function grant below is explicit.
alter default privileges in schema public revoke all on tables from anon, authenticated;
alter default privileges in schema public revoke all on sequences from anon, authenticated;
alter default privileges in schema public revoke execute on functions from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Organization
-- ---------------------------------------------------------------------------

create table public.legal_entities (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  legal_name text not null check (length(btrim(legal_name)) > 0),
  -- Only enabled entities grant any access. The second group entity stays
  -- absent/disabled until an approved rollout (D03).
  status text not null default 'disabled' check (status in ('enabled', 'disabled')),
  is_synthetic boolean not null default false,
  created_at timestamptz not null default now()
);
comment on table public.legal_entities is
  'Legal entities. Tax registrations (GSTIN/state mapping) are intentionally not modelled until validated by the CA (D03a, D09).';

create table public.branches (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  code text not null check (code ~ '^[A-Z][A-Z0-9_]{1,15}$'),
  name text not null,
  state_name text not null,
  is_head_office boolean not null default false,
  status text not null default 'enabled' check (status in ('enabled', 'disabled')),
  created_at timestamptz not null default now(),
  unique (legal_entity_id, code),
  -- Target of composite foreign keys so a child row cannot pair a branch with
  -- a different legal entity (A03).
  unique (legal_entity_id, id)
);
create unique index branches_one_head_office_per_entity
  on public.branches (legal_entity_id) where is_head_office;

-- ---------------------------------------------------------------------------
-- Staff identity
-- ---------------------------------------------------------------------------

create table public.staff_profiles (
  user_id uuid primary key references auth.users (id) on delete restrict,
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  work_email text not null unique check (work_email = lower(work_email)),
  -- invited: auth user exists, MFA not yet completed. inactive: offboarded.
  status text not null default 'invited' check (status in ('invited', 'active', 'inactive')),
  activated_at timestamptz,
  deactivated_at timestamptz,
  deactivation_reason text,
  created_at timestamptz not null default now(),
  check ((status = 'inactive') = (deactivated_at is not null))
);

create table public.roles (
  code text primary key check (code ~ '^[a-z][a-z_]{1,31}$'),
  name text not null,
  description text not null,
  policy_status text not null check (policy_status in ('confirmed', 'proposed'))
);

create table public.permissions (
  code text primary key check (code ~ '^[a-z]+(\.[a-z_]+)+$'),
  description text not null,
  -- Grantable permissions may be widened per user with an explicit access grant.
  is_grantable boolean not null default false
);

create table public.role_permissions (
  role_code text not null references public.roles (code),
  permission_code text not null references public.permissions (code),
  -- own: only owned/assigned records. entity: all records in the membership's entity.
  scope text not null check (scope in ('own', 'entity')),
  policy_status text not null check (policy_status in ('confirmed', 'proposed')),
  note text,
  primary key (role_code, permission_code)
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.staff_profiles (user_id),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  role_code text not null references public.roles (code),
  status text not null default 'invited' check (status in ('invited', 'active', 'inactive')),
  created_by uuid references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  deactivated_at timestamptz,
  foreign key (legal_entity_id, branch_id) references public.branches (legal_entity_id, id),
  unique (user_id, branch_id, role_code)
);
create index memberships_user_idx on public.memberships (user_id) where status = 'active';

create table public.access_grants (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.staff_profiles (user_id),
  permission_code text not null references public.permissions (code),
  legal_entity_id uuid not null references public.legal_entities (id),
  -- null branch = whole legal entity. Never spans entities.
  branch_id uuid,
  reason text not null check (length(btrim(reason)) >= 10),
  granted_by uuid not null references public.staff_profiles (user_id),
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid references public.staff_profiles (user_id),
  revocation_reason text,
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, branch_id) references public.branches (legal_entity_id, id),
  check (expires_at is null or expires_at > starts_at),
  check (granted_by <> user_id),
  check ((revoked_at is null) = (revoked_by is null))
);
create index access_grants_user_idx on public.access_grants (user_id) where revoked_at is null;

create table public.staff_invitations (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  role_code text not null references public.roles (code),
  email text not null check (email = lower(email) and email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  display_name text not null check (length(btrim(display_name)) between 1 and 120),
  invited_by uuid not null references public.staff_profiles (user_id),
  -- pending: recorded, auth invite not yet sent. sent: auth user linked.
  status text not null default 'pending' check (status in ('pending', 'sent', 'accepted', 'cancelled')),
  user_id uuid references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  accepted_at timestamptz,
  foreign key (legal_entity_id, branch_id) references public.branches (legal_entity_id, id)
);
create unique index staff_invitations_open_unique
  on public.staff_invitations (legal_entity_id, email)
  where status in ('pending', 'sent');

-- ---------------------------------------------------------------------------
-- Deals (Batch 1: synthetic fixtures only)
-- ---------------------------------------------------------------------------

create table public.deals (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  reference text not null,
  title text not null,
  owner_user_id uuid not null references public.staff_profiles (user_id),
  is_synthetic boolean not null default true,
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, branch_id) references public.branches (legal_entity_id, id),
  unique (legal_entity_id, reference),
  unique (legal_entity_id, id),
  -- Batch 1 permits synthetic fixtures only. A later, reviewed migration drops
  -- this constraint when the Bitrix handoff (Batch 2/3) creates real deals.
  constraint deals_batch1_synthetic_only check (is_synthetic)
);
comment on table public.deals is
  'Deal header without commercial values. Sales stages remain owned by Bitrix (D05).';

create table public.deal_assignments (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null,
  legal_entity_id uuid not null,
  user_id uuid not null references public.staff_profiles (user_id),
  assignment_kind text not null
    check (assignment_kind in ('sales', 'purchase', 'flight', 'visa', 'accounts')),
  assigned_by uuid references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  ended_at timestamptz,
  -- Composite key: an assignment cannot point at a deal in another entity (A03).
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id)
);
create unique index deal_assignments_active_unique
  on public.deal_assignments (deal_id, user_id, assignment_kind) where ended_at is null;
create index deal_assignments_user_idx on public.deal_assignments (user_id) where ended_at is null;

-- Selling-side values live in a separate table so column hiding does not depend
-- on RLS (which filters rows, not columns). Purchase never reads this table (A02).
create table public.deal_commercials (
  deal_id uuid primary key,
  legal_entity_id uuid not null,
  currency char(3) not null default 'INR' check (currency = 'INR'),
  -- Integer paise; placeholder figures only. No tax treatment is implied.
  selling_total_paise bigint not null check (selling_total_paise >= 0),
  estimated_margin_paise bigint not null,
  is_synthetic boolean not null default true,
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  constraint deal_commercials_batch1_synthetic_only check (is_synthetic)
);

-- ---------------------------------------------------------------------------
-- Audit (append-only for application actors)
-- ---------------------------------------------------------------------------

create table public.audit_events (
  id bigint generated always as identity primary key,
  occurred_at timestamptz not null default now(),
  actor_user_id uuid,
  legal_entity_id uuid references public.legal_entities (id),
  branch_id uuid,
  action text not null check (action ~ '^[a-z]+(\.[a-z_]+)+$'),
  target_type text not null,
  target_id uuid,
  -- commercial rows are not readable through the API in Batch 1 (A02).
  sensitivity text not null default 'standard' check (sensitivity in ('standard', 'commercial')),
  reason text,
  -- Redacted details only: never passwords, tokens, TOTP secrets or documents.
  details jsonb not null default '{}'::jsonb
);
create index audit_events_entity_time_idx on public.audit_events (legal_entity_id, occurred_at desc);

create function authz.forbid_audit_mutation() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_events is append-only' using errcode = '42501';
end;
$$;
create trigger audit_events_no_update_delete
  before update or delete on public.audit_events
  for each row execute function authz.forbid_audit_mutation();

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

-- Deal owners and assignees must belong to the deal's legal entity (A03).
create function authz.require_entity_member() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid;
begin
  if tg_table_name = 'deals' then
    v_user := new.owner_user_id;
  else
    v_user := new.user_id;
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.user_id = v_user
      and m.legal_entity_id = new.legal_entity_id
      and m.status in ('invited', 'active')
  ) then
    raise exception 'user % has no membership in legal entity %', v_user, new.legal_entity_id
      using errcode = '23514';
  end if;
  return new;
end;
$$;

create trigger deals_owner_is_entity_member
  before insert or update of owner_user_id, legal_entity_id on public.deals
  for each row execute function authz.require_entity_member();

create trigger deal_assignments_user_is_entity_member
  before insert or update of user_id, legal_entity_id on public.deal_assignments
  for each row execute function authz.require_entity_member();

-- ---------------------------------------------------------------------------
-- Authorization helpers (private schema; SECURITY DEFINER where they must read
-- RLS-protected tables). All pin search_path.
-- ---------------------------------------------------------------------------

create function authz.is_aal2() returns boolean
language sql stable set search_path = '' as $$
  select coalesce((select auth.jwt()) ->> 'aal', '') = 'aal2'
$$;

create function authz.is_active_staff() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.staff_profiles p
    where p.user_id = (select auth.uid()) and p.status = 'active'
  )
$$;

-- Base gate for every data read: MFA-verified session and active staff profile.
create function authz.session_ok() returns boolean
language sql stable set search_path = '' as $$
  select authz.is_aal2() and authz.is_active_staff()
$$;

-- Active membership in an enabled entity/branch.
create function authz.is_entity_member(p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.memberships m
    join public.legal_entities e on e.id = m.legal_entity_id
    join public.branches b on b.id = m.branch_id
    where m.user_id = (select auth.uid())
      and m.legal_entity_id = p_entity
      and m.status = 'active'
      and e.status = 'enabled'
      and b.status = 'enabled'
  )
$$;

create function authz.holds_role(p_role text, p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.memberships m
    where m.user_id = (select auth.uid())
      and m.legal_entity_id = p_entity
      and m.role_code = p_role
      and m.status = 'active'
  )
$$;

-- Role-derived permission. p_scope = 'own' is satisfied by own or entity rows;
-- p_scope = 'entity' requires an entity-scope role permission.
create function authz.has_role_permission(p_permission text, p_entity uuid, p_scope text)
returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.memberships m
    join public.role_permissions rp on rp.role_code = m.role_code
    join public.legal_entities e on e.id = m.legal_entity_id
    join public.branches b on b.id = m.branch_id
    where m.user_id = (select auth.uid())
      and m.legal_entity_id = p_entity
      and m.status = 'active'
      and e.status = 'enabled'
      and b.status = 'enabled'
      and rp.permission_code = p_permission
      and (p_scope = 'own' or rp.scope = 'entity')
  )
$$;

-- Explicit wider scope. Inert unless the user still has an active membership in
-- the same enabled entity, so offboarding or entity disablement removes it.
create function authz.has_grant(p_permission text, p_entity uuid, p_branch uuid)
returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.is_entity_member(p_entity) and exists (
    select 1 from public.access_grants g
    where g.user_id = (select auth.uid())
      and g.permission_code = p_permission
      and g.legal_entity_id = p_entity
      and (g.branch_id is null or g.branch_id = p_branch)
      and g.revoked_at is null
      and g.starts_at <= now()
      and (g.expires_at is null or g.expires_at > now())
  )
$$;

create function authz.is_owner_or_assignee(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.deals d
    where d.id = p_deal and d.owner_user_id = (select auth.uid())
  ) or exists (
    select 1 from public.deal_assignments a
    where a.deal_id = p_deal and a.user_id = (select auth.uid()) and a.ended_at is null
  )
$$;

create function authz.can_read_deal(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.deals d
    where d.id = p_deal
      and (
        (authz.is_owner_or_assignee(d.id)
          and authz.has_role_permission('deal.read', d.legal_entity_id, 'own'))
        or authz.has_role_permission('deal.read', d.legal_entity_id, 'entity')
        or authz.has_grant('deal.read', d.legal_entity_id, d.branch_id)
      )
  )
$$;

-- Selling price / margin. Requires deal visibility AND the commercial permission.
-- Confirmed rule: Purchase cannot see selling prices or margins. A user holding
-- the purchase role in the entity is denied even if another role or a grant
-- would allow it (conservative; see access matrix).
create function authz.can_read_deal_commercial(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.can_read_deal(p_deal) and exists (
    select 1 from public.deals d
    where d.id = p_deal
      and not authz.holds_role('purchase', d.legal_entity_id)
      and (
        (authz.is_owner_or_assignee(d.id)
          and authz.has_role_permission('deal.read_commercial', d.legal_entity_id, 'own'))
        or authz.has_role_permission('deal.read_commercial', d.legal_entity_id, 'entity')
        or authz.has_grant('deal.read_commercial', d.legal_entity_id, d.branch_id)
      )
  )
$$;

create function authz.can_admin(p_permission text, p_entity uuid) returns boolean
language sql stable set search_path = '' as $$
  select authz.session_ok() and authz.has_role_permission(p_permission, p_entity, 'entity')
$$;

create function authz.write_audit(
  p_action text, p_entity uuid, p_branch uuid, p_target_type text, p_target_id uuid,
  p_reason text, p_details jsonb
) returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.audit_events
    (actor_user_id, legal_entity_id, branch_id, action, target_type, target_id, reason, details)
  values
    ((select auth.uid()), p_entity, p_branch, p_action, p_target_type, p_target_id, p_reason,
     coalesce(p_details, '{}'::jsonb));
$$;

revoke all on all functions in schema authz from public;
grant execute on function
  authz.is_aal2(), authz.is_active_staff(), authz.session_ok(),
  authz.is_entity_member(uuid), authz.holds_role(text, uuid),
  authz.has_role_permission(text, uuid, text), authz.has_grant(text, uuid, uuid),
  authz.is_owner_or_assignee(uuid), authz.can_read_deal(uuid),
  authz.can_read_deal_commercial(uuid), authz.can_admin(text, uuid)
to authenticated;

-- ---------------------------------------------------------------------------
-- Row level security
-- ---------------------------------------------------------------------------

alter table public.legal_entities enable row level security;
alter table public.branches enable row level security;
alter table public.staff_profiles enable row level security;
alter table public.roles enable row level security;
alter table public.permissions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.memberships enable row level security;
alter table public.access_grants enable row level security;
alter table public.staff_invitations enable row level security;
alter table public.deals enable row level security;
alter table public.deal_assignments enable row level security;
alter table public.deal_commercials enable row level security;
alter table public.audit_events enable row level security;

-- MFA gate: RESTRICTIVE, so it is AND-ed with every permissive policy.
do $$
declare
  t text;
begin
  foreach t in array array[
    'legal_entities', 'branches', 'staff_profiles', 'roles', 'permissions',
    'role_permissions', 'memberships', 'access_grants', 'staff_invitations',
    'deals', 'deal_assignments', 'deal_commercials', 'audit_events'
  ] loop
    execute format(
      'create policy require_mfa_aal2 on public.%I as restrictive for all to authenticated
         using ((select authz.is_aal2())) with check ((select authz.is_aal2()))', t);
  end loop;
end;
$$;

create policy entity_members_read on public.legal_entities
  for select to authenticated
  using ((select authz.is_active_staff()) and authz.is_entity_member(id));

create policy entity_members_read on public.branches
  for select to authenticated
  using ((select authz.is_active_staff()) and authz.is_entity_member(legal_entity_id));

create policy reference_read on public.roles
  for select to authenticated using ((select authz.is_active_staff()));
create policy reference_read on public.permissions
  for select to authenticated using ((select authz.is_active_staff()));
create policy reference_read on public.role_permissions
  for select to authenticated using ((select authz.is_active_staff()));

-- Own profile is readable while invited so onboarding can complete.
create policy own_profile_read on public.staff_profiles
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy staff_admin_read on public.staff_profiles
  for select to authenticated
  using (exists (
    select 1 from public.memberships m
    where m.user_id = staff_profiles.user_id
      and authz.can_admin('staff.manage', m.legal_entity_id)
  ));

create policy own_memberships_read on public.memberships
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy staff_admin_read on public.memberships
  for select to authenticated
  using (authz.can_admin('staff.manage', legal_entity_id));

create policy own_grants_read on public.access_grants
  for select to authenticated
  using (user_id = (select auth.uid()) and (select authz.is_active_staff()));
create policy grant_admin_read on public.access_grants
  for select to authenticated
  using (authz.can_admin('access.grant', legal_entity_id));

create policy staff_admin_read on public.staff_invitations
  for select to authenticated
  using (authz.can_admin('staff.invite', legal_entity_id));

create policy scoped_read on public.deals
  for select to authenticated using (authz.can_read_deal(id));

create policy scoped_read on public.deal_assignments
  for select to authenticated using (authz.can_read_deal(deal_id));

create policy commercial_read on public.deal_commercials
  for select to authenticated using (authz.can_read_deal_commercial(deal_id));

create policy audit_admin_read on public.audit_events
  for select to authenticated
  using (sensitivity = 'standard' and authz.can_admin('audit.read', legal_entity_id));

-- Table privileges: read-only for signed-in staff, nothing for anon.
revoke all on all tables in schema public from anon, authenticated;
grant select on
  public.legal_entities, public.branches, public.staff_profiles, public.roles,
  public.permissions, public.role_permissions, public.memberships, public.access_grants,
  public.staff_invitations, public.deals, public.deal_assignments, public.deal_commercials,
  public.audit_events
to authenticated;

-- ---------------------------------------------------------------------------
-- Commands (Data API RPC). Actor always comes from auth.uid(); never from args.
-- ---------------------------------------------------------------------------

create function public.create_staff_invitation(
  p_email text, p_display_name text, p_branch_id uuid, p_role_code text
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entity uuid;
  v_email text := lower(btrim(p_email));
  v_id uuid;
begin
  select b.legal_entity_id into v_entity from public.branches b where b.id = p_branch_id;
  if v_entity is null or not authz.can_admin('staff.invite', v_entity) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if exists (select 1 from public.staff_profiles p where p.work_email = v_email) then
    raise exception 'staff member already exists' using errcode = '23505';
  end if;

  -- Idempotent: a repeated submit returns the open invitation unchanged.
  select i.id into v_id from public.staff_invitations i
  where i.legal_entity_id = v_entity and i.email = v_email and i.status in ('pending', 'sent');
  if v_id is not null then
    if not exists (
      select 1 from public.staff_invitations i
      where i.id = v_id and i.branch_id = p_branch_id and i.role_code = p_role_code
    ) then
      raise exception 'an open invitation with different access exists' using errcode = '23505';
    end if;
    return v_id;
  end if;

  insert into public.staff_invitations
    (legal_entity_id, branch_id, role_code, email, display_name, invited_by)
  values (v_entity, p_branch_id, p_role_code, v_email, btrim(p_display_name), auth.uid())
  returning id into v_id;

  perform authz.write_audit('staff.invitation_created', v_entity, p_branch_id,
    'staff_invitation', v_id, null,
    jsonb_build_object('role_code', p_role_code, 'email_domain', split_part(v_email, '@', 2)));
  return v_id;
end;
$$;

-- Called by the server with the service-role key only, after create_staff_invitation
-- succeeded under the inviting administrator's own session.
create function public.link_invitation_user(p_invitation_id uuid, p_user_id uuid)
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

  insert into public.audit_events
    (actor_user_id, legal_entity_id, branch_id, action, target_type, target_id, details)
  values (v_inv.invited_by, v_inv.legal_entity_id, v_inv.branch_id, 'staff.invitation_sent',
    'staff_invitation', v_inv.id, jsonb_build_object('user_id', p_user_id));
end;
$$;

-- Invited user completes onboarding. Requires aal2: MFA must be enrolled and
-- verified before any membership becomes active.
create function public.accept_my_invitation() returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := auth.uid();
  v_status text;
  r record;
begin
  if v_uid is null or not authz.is_aal2() then
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

create function public.grant_access_scope(
  p_user_id uuid, p_permission text, p_legal_entity_id uuid, p_branch_id uuid,
  p_reason text, p_expires_at timestamptz default null
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  if not authz.can_admin('access.grant', p_legal_entity_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if p_user_id = auth.uid() then
    raise exception 'staff cannot widen their own access' using errcode = '42501';
  end if;
  if not exists (select 1 from public.permissions where code = p_permission and is_grantable) then
    raise exception 'permission is not grantable' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.memberships m
    where m.user_id = p_user_id and m.legal_entity_id = p_legal_entity_id and m.status = 'active'
  ) then
    raise exception 'target has no active membership in this legal entity' using errcode = '22023';
  end if;
  if p_permission = 'deal.read_commercial' and exists (
    select 1 from public.memberships m
    where m.user_id = p_user_id and m.legal_entity_id = p_legal_entity_id
      and m.role_code = 'purchase' and m.status = 'active'
  ) then
    raise exception 'purchase staff cannot receive selling price or margin access' using errcode = '42501';
  end if;

  insert into public.access_grants
    (user_id, permission_code, legal_entity_id, branch_id, reason, granted_by, expires_at)
  values (p_user_id, p_permission, p_legal_entity_id, p_branch_id, btrim(p_reason), auth.uid(), p_expires_at)
  returning id into v_id;

  perform authz.write_audit('access.grant_created', p_legal_entity_id, p_branch_id,
    'access_grant', v_id, btrim(p_reason),
    jsonb_build_object('user_id', p_user_id, 'permission', p_permission,
      'scope', case when p_branch_id is null then 'entity' else 'branch' end,
      'expires_at', p_expires_at));
  return v_id;
end;
$$;

create function public.revoke_access_grant(p_grant_id uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_grant public.access_grants%rowtype;
begin
  select * into v_grant from public.access_grants where id = p_grant_id for update;
  if v_grant.id is null or not authz.can_admin('access.grant', v_grant.legal_entity_id) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if v_grant.revoked_at is not null then
    return;
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a revocation reason of at least 10 characters is required' using errcode = '22023';
  end if;
  update public.access_grants
  set revoked_at = now(), revoked_by = auth.uid(), revocation_reason = btrim(p_reason)
  where id = p_grant_id;
  perform authz.write_audit('access.grant_revoked', v_grant.legal_entity_id, v_grant.branch_id,
    'access_grant', p_grant_id, btrim(p_reason), jsonb_build_object('user_id', v_grant.user_id));
end;
$$;

-- Offboarding. The server additionally bans the Auth user so no new session can
-- be issued; this function makes data access stop on the very next request.
create function public.deactivate_staff_member(p_user_id uuid, p_reason text) returns void
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
  -- The administrator must hold staff.manage in every entity the target belongs to.
  if not exists (select 1 from public.memberships where user_id = p_user_id)
     or exists (
       select 1 from public.memberships m
       where m.user_id = p_user_id and not authz.can_admin('staff.manage', m.legal_entity_id)
     ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;

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

-- Administrator-assisted MFA recovery. Authorizes and audits; the server then
-- removes the factors with the Auth admin API. Never self-service.
create function public.authorize_mfa_reset(p_user_id uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  r record;
begin
  if p_user_id = auth.uid() then
    raise exception 'staff cannot reset their own MFA' using errcode = '42501';
  end if;
  if length(btrim(coalesce(p_reason, ''))) < 10 then
    raise exception 'a reason of at least 10 characters is required' using errcode = '22023';
  end if;
  if not exists (select 1 from public.memberships where user_id = p_user_id)
     or exists (
       select 1 from public.memberships m
       where m.user_id = p_user_id and not authz.can_admin('staff.manage', m.legal_entity_id)
     ) then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  for r in select distinct legal_entity_id from public.memberships where user_id = p_user_id loop
    perform authz.write_audit('staff.mfa_reset_authorized', r.legal_entity_id, null,
      'staff_profile', p_user_id, btrim(p_reason), '{}'::jsonb);
  end loop;
end;
$$;

revoke all on function
  public.create_staff_invitation(text, text, uuid, text),
  public.link_invitation_user(uuid, uuid),
  public.accept_my_invitation(),
  public.grant_access_scope(uuid, text, uuid, uuid, text, timestamptz),
  public.revoke_access_grant(uuid, text),
  public.deactivate_staff_member(uuid, text),
  public.authorize_mfa_reset(uuid, text)
from public, anon, authenticated;

grant execute on function
  public.create_staff_invitation(text, text, uuid, text),
  public.accept_my_invitation(),
  public.grant_access_scope(uuid, text, uuid, uuid, text, timestamptz),
  public.revoke_access_grant(uuid, text),
  public.deactivate_staff_member(uuid, text),
  public.authorize_mfa_reset(uuid, text)
to authenticated;

grant execute on function public.link_invitation_user(uuid, uuid) to service_role;
