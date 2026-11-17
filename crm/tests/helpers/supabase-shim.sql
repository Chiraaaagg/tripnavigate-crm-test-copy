-- Minimal stand-in for the parts of a Supabase database that the migrations
-- depend on, used ONLY by the PGlite-backed policy tests. CI also runs the same
-- tests against a real local Supabase stack (see .github/workflows/ci.yml).
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;

create schema auth;
create table auth.users (
  id uuid primary key,
  email text unique
);

-- Same semantics as Supabase's auth.uid() / auth.jwt(): read PostgREST claims.
create function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;
create function auth.uid() returns uuid language sql stable as $$
  select nullif(
    coalesce(
      current_setting('request.jwt.claim.sub', true),
      (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
    ), ''
  )::uuid
$$;

grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.jwt(), auth.uid() to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;

-- Subset of Supabase's auth.mfa_factors (real columns use enum types
-- auth.factor_type / auth.factor_status; text compares the same way).
create table auth.mfa_factors (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  friendly_name text,
  factor_type text not null check (factor_type in ('totp', 'webauthn', 'phone')),
  status text not null check (status in ('unverified', 'verified')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Subset of Supabase's auth.sessions. Supabase sets factor_id (and aal) when
-- the session verifies an MFA factor; the JWT carries the id as session_id.
create table auth.sessions (
  id uuid primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  factor_id uuid,
  aal text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Subset of Supabase Storage: the bucket catalogue the Phase 3 migration
-- writes to, and the objects table (RLS on, no policies, as in Supabase until
-- a migration adds some).
create schema storage;
grant usage on schema storage to anon, authenticated, service_role;
create table storage.buckets (
  id text primary key,
  name text not null unique,
  public boolean not null default false,
  file_size_limit bigint,
  allowed_mime_types text[],
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table storage.objects (
  id uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets (id),
  name text,
  owner uuid,
  metadata jsonb,
  created_at timestamptz not null default now()
);
alter table storage.objects enable row level security;
alter table storage.buckets enable row level security;
grant select, insert, update, delete on storage.objects, storage.buckets to anon, authenticated, service_role;
