-- Row counts of every public table plus auth.users, storage.objects and
-- storage.buckets. Read-only. Run before and after hosted verification; the
-- two results must be identical (zero residue).
select jsonb_object_agg(t, n order by t) as counts from (
  select format('%I.%I', schemaname, relname) as t,
         (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', schemaname, relname), false, true, '')))[1]::text::bigint as n
  from pg_stat_user_tables where schemaname = 'public'
  union all select 'auth.users', (select count(*) from auth.users)
  union all select 'storage.objects', (select count(*) from storage.objects)
  union all select 'storage.buckets', (select count(*) from storage.buckets)
  union all select 'max(public.audit_events.id)', (select coalesce(max(id), 0) from public.audit_events)
) s;
