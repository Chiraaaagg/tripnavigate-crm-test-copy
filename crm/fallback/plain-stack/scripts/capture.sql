-- Step 0 capture, database part (contract file 12, section 3.3). Read-only.
-- Run by scripts/capture-baseline.sh on the Supabase CLI stack (job baseline)
-- and, for comparison, on the plain stack. Names and non-secret values only:
-- any setting whose name looks secret (secret, password, key, token, jwt) is
-- reported as "(redacted)".
with
redact as (
  select '(secret|password|passwd|key|token|jwt)' as re
),
role_rows as (
  select r.rolname, jsonb_build_object(
    'super', r.rolsuper, 'inherit', r.rolinherit, 'createrole', r.rolcreaterole, 'createdb', r.rolcreatedb,
    'login', r.rolcanlogin, 'replication', r.rolreplication, 'bypassrls', r.rolbypassrls,
    'config', coalesce((
      select jsonb_agg(case when split_part(c, '=', 1) ~* (select re from redact)
                            then split_part(c, '=', 1) || '=(redacted)' else c end order by c)
      from unnest(r.rolconfig) c), '[]'::jsonb),
    'member_of', coalesce((
      select jsonb_agg(g.rolname || case when m.admin_option then ' (admin)' else '' end order by g.rolname)
      from pg_auth_members m join pg_roles g on g.oid = m.roleid where m.member = r.oid), '[]'::jsonb)
  ) as info
  from pg_roles r
  where r.rolname !~ '^pg_'
),
schema_rows as (
  select n.nspname, jsonb_build_object('owner', pg_get_userbyid(n.nspowner), 'acl', n.nspacl::text) as info
  from pg_namespace n
  where n.nspname !~ '^(pg_|information_schema)'
),
grant_rows as (
  select n.nspname || '.' || c.relname as name,
         jsonb_build_object('kind', c.relkind, 'owner', pg_get_userbyid(c.relowner), 'acl', c.relacl::text,
                            'rls', c.relrowsecurity) as info
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname in ('auth', 'storage', 'extensions') and c.relkind in ('r', 'p', 'v', 'm', 'S')
),
routine_rows as (
  select p.oid::regprocedure::text as name,
         jsonb_build_object('owner', pg_get_userbyid(p.proowner), 'acl', p.proacl::text, 'secdef', p.prosecdef) as info
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
  where n.nspname in ('auth', 'storage')
),
default_acl as (
  select jsonb_agg(jsonb_build_object(
    'role', pg_get_userbyid(d.defaclrole), 'schema', coalesce(n.nspname, '(all)'),
    'objtype', d.defaclobjtype, 'acl', d.defaclacl::text) order by pg_get_userbyid(d.defaclrole), n.nspname, d.defaclobjtype) as v
  from pg_default_acl d left join pg_namespace n on n.oid = d.defaclnamespace
),
db_settings as (
  select jsonb_agg(case when split_part(c, '=', 1) ~* (select re from redact)
                        then split_part(c, '=', 1) || '=(redacted)' else c end order by c) as v
  from pg_db_role_setting s, unnest(s.setconfig) c
  where s.setdatabase = (select oid from pg_database where datname = current_database()) and s.setrole = 0
)
select jsonb_pretty(jsonb_build_object(
  'server_version', current_setting('server_version'),
  'server_version_num', current_setting('server_version_num')::int,
  'current_user', current_user,
  'current_user_is_superuser', (select rolsuper from pg_roles where rolname = current_user),
  'database', (select jsonb_build_object('encoding', pg_encoding_to_char(d.encoding), 'collate', d.datcollate,
                 'ctype', d.datctype, 'locale_provider', d.datlocprovider, 'owner', pg_get_userbyid(d.datdba),
                 'icu_locale', d.datlocale, 'acl', d.datacl::text)
               from pg_database d where d.datname = current_database()),
  'database_settings', (select v from db_settings),
  'settings', (select jsonb_object_agg(name, case when name ~* (select re from redact) then '(redacted)' else setting end)
               from pg_settings
               where name in ('TimeZone', 'DateStyle', 'IntervalStyle', 'lc_messages', 'lc_monetary', 'lc_numeric', 'lc_time',
                              'default_text_search_config', 'search_path', 'statement_timeout', 'lock_timeout',
                              'idle_in_transaction_session_timeout', 'max_connections', 'shared_preload_libraries',
                              'session_preload_libraries', 'wal_level', 'max_wal_senders', 'shared_buffers', 'work_mem',
                              'standard_conforming_strings', 'check_function_bodies', 'password_encryption',
                              'row_security', 'default_transaction_isolation', 'jit', 'log_statement')),
  'roles', (select jsonb_object_agg(rolname, info) from role_rows),
  'schemas', (select jsonb_object_agg(nspname, info) from schema_rows),
  'relations_auth_storage_extensions', (select jsonb_object_agg(name, info) from grant_rows),
  'routines_auth_storage', (select jsonb_object_agg(name, info) from routine_rows),
  'default_privileges', (select v from default_acl),
  'extensions', (select jsonb_object_agg(e.extname, jsonb_build_object('version', e.extversion, 'schema', n.nspname))
                 from pg_extension e join pg_namespace n on n.oid = e.extnamespace),
  'available_extensions_of_interest', (select jsonb_object_agg(name, default_version) from pg_available_extensions
                 where name in ('pg_cron', 'pg_net', 'supabase_vault', 'pgsodium', 'pg_graphql', 'pgcrypto', 'uuid-ossp',
                                'pg_stat_statements', 'pgjwt', 'supautils', 'safeupdate', 'pg_safeupdate', 'pgaudit', 'vector')),
  'publications', (select jsonb_object_agg(p.pubname, jsonb_build_object(
                     'all_tables', p.puballtables,
                     'tables', (select coalesce(jsonb_agg(t.schemaname || '.' || t.tablename order by t.schemaname, t.tablename), '[]'::jsonb)
                                from pg_publication_tables t where t.pubname = p.pubname)))
                   from pg_publication p),
  'event_triggers', (select jsonb_object_agg(e.evtname, jsonb_build_object('event', e.evtevent,
                       'function', e.evtfoid::regproc::text, 'owner', pg_get_userbyid(e.evtowner), 'enabled', e.evtenabled))
                     from pg_event_trigger e),
  'auth_tables', (select coalesce(jsonb_agg(tablename order by tablename), '[]'::jsonb) from pg_tables where schemaname = 'auth'),
  'auth_migrations', (select count(*) from auth.schema_migrations),
  'storage_tables', (select coalesce(jsonb_agg(tablename order by tablename), '[]'::jsonb) from pg_tables where schemaname = 'storage'),
  'storage_migrations', (select count(*) from storage.migrations),
  'buckets', (select coalesce(jsonb_agg(id order by id), '[]'::jsonb) from storage.buckets),
  'auth_functions', (select coalesce(jsonb_agg(p.oid::regprocedure::text || ' ' || l.lanname order by p.oid::regprocedure::text), '[]'::jsonb)
                     from pg_proc p join pg_namespace n on n.oid = p.pronamespace join pg_language l on l.oid = p.prolang
                     where n.nspname = 'auth')
));
