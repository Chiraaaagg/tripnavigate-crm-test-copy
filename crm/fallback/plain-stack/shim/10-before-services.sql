-- Plain-stack shim, part 1 of 2: runs as the database superuser on a fresh
-- official postgres:17 database, BEFORE GoTrue and storage-api start
-- (contract file 12, sections 3.2 and 3.5). Synthetic CI stack only.
--
-- psql variable (generated per run, never committed or printed):
--   :svc_password  login password of authenticator, supabase_auth_admin and
--                  supabase_storage_admin
--
-- Source of each statement: the Supabase Postgres image 17.11.0.002
-- (migrations/db/init-scripts/*.sql and migrations/db/migrations/*.sql of
-- github.com/supabase/postgres) and the Supabase CLI 2.119.0 role dump
-- (apps/cli/src/command-internal/db-bootstrap/templates/db-globals.sql.ts).
-- What the baseline job reads from the CLI stack is compared with what this
-- produces; every difference is a gap-report row. Idempotent.

\set ON_ERROR_STOP on

-- G1: the three API roles every grant in the CRM migrations names.
do $$
begin
  if not exists (select from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
  -- G1b: login roles of the three services (not named in the CRM SQL).
  if not exists (select from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit;
  end if;
  if not exists (select from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin login noinherit createrole;
  end if;
  if not exists (select from pg_roles where rolname = 'supabase_storage_admin') then
    create role supabase_storage_admin login noinherit createrole;
  end if;
end;
$$;

alter role authenticator with password :'svc_password';
alter role supabase_auth_admin with password :'svc_password';
alter role supabase_storage_admin with password :'svc_password';

-- PostgREST switches from authenticator to the role in the token.
grant anon, authenticated, service_role to authenticator;
-- storage-api switches to the caller's role per request.
grant anon, authenticated, service_role to supabase_storage_admin;
grant authenticator to supabase_storage_admin;

-- Per-role settings as in the Supabase image. Not reproduced (gap G15):
-- authenticator session_preload_libraries = supautils, safeupdate (neither
-- library is in the official image).
alter role anon set statement_timeout = '3s';
alter role authenticated set statement_timeout = '8s';
alter role authenticator set statement_timeout = '8s';
alter role authenticator set lock_timeout = '8s';
alter role supabase_auth_admin set search_path = auth;
alter role supabase_auth_admin set idle_in_transaction_session_timeout = '60000';
alter role supabase_storage_admin set search_path = storage;
alter role postgres set search_path = "$user", public, extensions;

grant create on database postgres to supabase_auth_admin, supabase_storage_admin;

-- G8: extensions schema and pg_stat_statements (contrib; preloaded by the
-- compose command line). pgcrypto, uuid-ossp, pg_graphql, pgsodium and Vault
-- are deliberately absent (G6: unused by the CRM).
create schema if not exists extensions;
create extension if not exists pg_stat_statements with schema extensions;
grant usage on schema extensions to postgres, anon, authenticated, service_role;

-- public: what Supabase grants to the API roles on every object the database
-- owner creates (the CRM migrations then revoke and grant per object).
grant usage on schema public to postgres, anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges for role postgres in schema public grant all on sequences to anon, authenticated, service_role;

-- G2: an empty auth schema owned by the auth service; GoTrue's own migrations
-- create the tables and auth.uid() / auth.jwt() (checked in part 2).
create schema if not exists auth authorization supabase_auth_admin;
grant usage on schema auth to anon, authenticated, service_role;
alter default privileges for role supabase_auth_admin in schema auth grant all on tables to postgres;
alter default privileges for role supabase_auth_admin in schema auth grant all on sequences to postgres;
alter default privileges for role supabase_auth_admin in schema auth grant all on routines to postgres;

-- G3: an empty storage schema owned by the storage service; storage-api's own
-- migrations create buckets, objects and their grants. It must exist before
-- the CRM migrations, which insert the private buckets only when
-- storage.buckets exists.
create schema if not exists storage authorization supabase_storage_admin;
grant usage on schema storage to postgres, anon, authenticated, service_role;

-- G7: the empty Realtime publication (the CRM adds tables under if-exists guards).
do $$
begin
  if not exists (select from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end;
$$;

-- G14: PostgREST reloads its schema cache after DDL. These are PostgREST's own
-- documented event triggers, installed by the Supabase image as
-- extensions.pgrst_ddl_watch / pgrst_drop_watch.
create or replace function extensions.pgrst_ddl_watch() returns event_trigger
language plpgsql as $$
declare
  cmd record;
begin
  for cmd in select * from pg_event_trigger_ddl_commands()
  loop
    if cmd.command_tag in (
      'CREATE SCHEMA', 'ALTER SCHEMA',
      'CREATE TABLE', 'CREATE TABLE AS', 'SELECT INTO', 'ALTER TABLE',
      'CREATE FOREIGN TABLE', 'ALTER FOREIGN TABLE',
      'CREATE VIEW', 'ALTER VIEW',
      'CREATE MATERIALIZED VIEW', 'ALTER MATERIALIZED VIEW',
      'CREATE FUNCTION', 'ALTER FUNCTION',
      'CREATE TRIGGER',
      'CREATE TYPE', 'ALTER TYPE',
      'CREATE RULE',
      'COMMENT'
    ) and cmd.schema_name is distinct from 'pg_temp' then
      notify pgrst, 'reload schema';
    end if;
  end loop;
end;
$$;

create or replace function extensions.pgrst_drop_watch() returns event_trigger
language plpgsql as $$
declare
  obj record;
begin
  for obj in select * from pg_event_trigger_dropped_objects()
  loop
    if obj.object_type in (
      'schema', 'table', 'foreign table', 'view', 'materialized view',
      'function', 'trigger', 'type', 'rule'
    ) and obj.is_temporary is false then
      notify pgrst, 'reload schema';
    end if;
  end loop;
end;
$$;

drop event trigger if exists pgrst_ddl_watch;
create event trigger pgrst_ddl_watch on ddl_command_end execute procedure extensions.pgrst_ddl_watch();
drop event trigger if exists pgrst_drop_watch;
create event trigger pgrst_drop_watch on sql_drop execute procedure extensions.pgrst_drop_watch();
