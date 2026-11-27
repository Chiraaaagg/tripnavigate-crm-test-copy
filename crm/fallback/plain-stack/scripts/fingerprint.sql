-- Read-only schema fingerprint (contract file 12, section 3.6). Run with
--   psql "$DB" -X -At -f fingerprint.sql > fingerprint.json
-- after the migrations and before seeding, on BOTH the Supabase CLI stack
-- (job baseline) and the plain stack. Output: one JSON document with, per
-- category, the item count, an MD5 over the sorted item lines, and every item
-- as name -> md5 so the report job can list differences by object name.
-- Scope: schemas public and authz, plus the storage bucket rows and the
-- supabase_realtime publication members. No data rows are read except buckets.

with
scope as (
  select oid, nspname from pg_namespace where nspname in ('public', 'authz')
),
items as (
  -- Tables, views, sequences, materialized views: kind, owner, RLS flags.
  select 'relations' as cat, n.nspname || '.' || c.relname as name,
         concat_ws('|', c.relkind, pg_get_userbyid(c.relowner), c.relrowsecurity, c.relforcerowsecurity, c.relpersistence) as def
  from pg_class c join scope n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
  union all
  select 'columns', n.nspname || '.' || c.relname || '.' || a.attname,
         concat_ws('|', format_type(a.atttypid, a.atttypmod), a.attnotnull, a.attidentity, a.attgenerated,
                   pg_get_expr(d.adbin, d.adrelid), a.attnum)
  from pg_attribute a
  join pg_class c on c.oid = a.attrelid
  join scope n on n.oid = c.relnamespace
  left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
  where a.attnum > 0 and not a.attisdropped and c.relkind in ('r', 'p', 'v', 'm', 'f')
  union all
  select 'views', n.nspname || '.' || c.relname, pg_get_viewdef(c.oid, true)
  from pg_class c join scope n on n.oid = c.relnamespace
  where c.relkind in ('v', 'm')
  union all
  -- Functions and procedures: full definition (includes SECURITY DEFINER,
  -- search_path and volatility), owner and ACL.
  select 'functions', p.oid::regprocedure::text,
         concat_ws('|', pg_get_functiondef(p.oid), pg_get_userbyid(p.proowner), coalesce(p.proacl::text, '(default)'))
  from pg_proc p join scope n on n.oid = p.pronamespace
  where p.prokind in ('f', 'p', 'w')
  union all
  select 'aggregates', p.oid::regprocedure::text, pg_get_userbyid(p.proowner)
  from pg_proc p join scope n on n.oid = p.pronamespace
  where p.prokind = 'a'
  union all
  select 'triggers', n.nspname || '.' || c.relname || '.' || t.tgname,
         concat_ws('|', pg_get_triggerdef(t.oid, true), t.tgenabled)
  from pg_trigger t join pg_class c on c.oid = t.tgrelid join scope n on n.oid = c.relnamespace
  where not t.tgisinternal
  union all
  select 'policies', p.schemaname || '.' || p.tablename || '.' || p.policyname,
         concat_ws('|', p.permissive, array_to_string(p.roles, ','), p.cmd, p.qual, p.with_check)
  from pg_policies p where p.schemaname in ('public', 'authz')
  union all
  select 'indexes', i.schemaname || '.' || i.indexname, i.indexdef
  from pg_indexes i where i.schemaname in ('public', 'authz')
  union all
  select 'constraints', n.nspname || '.' || c.relname || '.' || k.conname,
         concat_ws('|', k.contype, pg_get_constraintdef(k.oid, true))
  from pg_constraint k join pg_class c on c.oid = k.conrelid join scope n on n.oid = c.relnamespace
  union all
  select 'types', n.nspname || '.' || t.typname,
         concat_ws('|', t.typtype, (select string_agg(e.enumlabel, ',' order by e.enumsortorder) from pg_enum e where e.enumtypid = t.oid),
                   pg_get_userbyid(t.typowner))
  from pg_type t join scope n on n.oid = t.typnamespace
  where t.typtype in ('e', 'd', 'c', 'r', 'm')
    and not exists (select 1 from pg_class c where c.reltype = t.oid and c.relkind <> 'c')
  union all
  -- Grants: table/view/sequence ACLs, column ACLs, schema ACLs.
  select 'grants', 'relation:' || n.nspname || '.' || c.relname, coalesce(c.relacl::text, '(default)')
  from pg_class c join scope n on n.oid = c.relnamespace
  where c.relkind in ('r', 'p', 'v', 'm', 'S', 'f')
  union all
  select 'grants', 'column:' || n.nspname || '.' || c.relname || '.' || a.attname, a.attacl::text
  from pg_attribute a join pg_class c on c.oid = a.attrelid join scope n on n.oid = c.relnamespace
  where a.attacl is not null and a.attnum > 0 and not a.attisdropped
  union all
  select 'grants', 'schema:' || n.nspname, coalesce(n.nspacl::text, '(default)') || '|' || pg_get_userbyid(n.nspowner)
  from pg_namespace n where n.nspname in ('public', 'authz')
  union all
  select 'buckets', b.id,
         concat_ws('|', b.name, b.public, b.file_size_limit, array_to_string(b.allowed_mime_types, ','))
  from storage.buckets b
  union all
  select 'publication', pt.schemaname || '.' || pt.tablename, pt.pubname
  from pg_publication_tables pt where pt.pubname = 'supabase_realtime'
),
hashed as (
  select cat, name, md5(coalesce(def, '')) as h from items
),
cats as (
  select cat, count(*) as n, md5(string_agg(name || '=' || h, E'\n' order by name)) as h,
         jsonb_object_agg(name, h) as members
  from hashed group by cat
)
select jsonb_pretty(jsonb_build_object(
  'server_version', current_setting('server_version'),
  'database', current_database(),
  'captured_at', now(),
  'overall_md5', (select md5(string_agg(cat || ':' || h, E'\n' order by cat)) from cats),
  'categories', (select jsonb_object_agg(cat, jsonb_build_object('count', n, 'md5', h)) from cats),
  'members', (select jsonb_object_agg(cat, members) from cats)
));
