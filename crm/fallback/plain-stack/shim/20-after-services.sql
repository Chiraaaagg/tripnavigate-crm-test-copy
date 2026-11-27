-- Plain-stack shim, part 2 of 2: runs as the database superuser AFTER GoTrue
-- and storage-api have run their own migrations and BEFORE the CRM migrations
-- (contract file 12, section 3.2). Synthetic CI stack only. Idempotent.
--
-- It checks what the services created and adds only what is missing; every
-- addition is reported with a NOTICE line (read by scripts/up.sh into
-- shim-notices.txt, a gap-report input).

\set ON_ERROR_STOP on

do $$
declare
  missing text[] := array[]::text[];
  t text;
begin
  -- G2: tables the CRM reads (staff_profiles references auth.users; the
  -- session and factor checks read auth.sessions and auth.mfa_factors).
  foreach t in array array['auth.users', 'auth.sessions', 'auth.mfa_factors', 'auth.identities', 'auth.refresh_tokens']
  loop
    if to_regclass(t) is null then
      missing := missing || t;
    end if;
  end loop;
  if cardinality(missing) > 0 then
    raise exception 'GoTrue did not create %', array_to_string(missing, ', ') using errcode = 'P0001';
  end if;

  -- G3: storage-api must have created the bucket and object catalogue.
  if to_regclass('storage.buckets') is null or to_regclass('storage.objects') is null then
    raise exception 'storage-api did not create storage.buckets / storage.objects' using errcode = 'P0001';
  end if;

  -- G2: auth.uid() and auth.jwt() come from GoTrue's migrations. The fallback
  -- below is the definition of tests/helpers/supabase-shim.sql (same semantics).
  if to_regprocedure('auth.jwt()') is null then
    raise notice 'shim-added: auth.jwt()';
    execute $f$
      create function auth.jwt() returns jsonb language sql stable as $b$
        select coalesce(
          nullif(current_setting('request.jwt.claim', true), ''),
          nullif(current_setting('request.jwt.claims', true), '')
        )::jsonb
      $b$
    $f$;
  end if;
  if to_regprocedure('auth.uid()') is null then
    raise notice 'shim-added: auth.uid()';
    execute $f$
      create function auth.uid() returns uuid language sql stable as $b$
        select nullif(
          coalesce(
            current_setting('request.jwt.claim.sub', true),
            (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
          ), ''
        )::uuid
      $b$
    $f$;
  end if;
end;
$$;

grant execute on function auth.uid(), auth.jwt() to anon, authenticated, service_role;

-- Tables GoTrue created before the default privileges of part 1 applied (none
-- expected): give the database owner the access the Supabase image gives it.
grant all on all tables in schema auth to postgres;
grant all on all sequences in schema auth to postgres;
grant all on all routines in schema auth to postgres;

-- Report what the services created (counts only).
do $$
declare
  n_auth integer;
  n_auth_mig integer;
  n_storage integer;
  n_storage_mig integer;
begin
  select count(*) into n_auth from pg_tables where schemaname = 'auth';
  select count(*) into n_auth_mig from auth.schema_migrations;
  select count(*) into n_storage from pg_tables where schemaname = 'storage';
  select count(*) into n_storage_mig from storage.migrations;
  raise notice 'services: auth tables=% auth migrations=% storage tables=% storage migrations=%',
    n_auth, n_auth_mig, n_storage, n_storage_mig;
end;
$$;
