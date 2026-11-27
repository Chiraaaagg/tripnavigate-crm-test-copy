-- TripNavigate CRM - Visa and Passport desk build, track A: table privileges.
--
-- Contract: implementation/visa-build-2026-11-07/contract.md (frozen 8 Nov
-- 2026), sections 0 ("Database pattern": no Data API access) and 12.1
-- (shape/privilege). Found by track E on a disposable Supabase stack: the
-- desk tables could still carry the stack's default table grants for anon /
-- authenticated. This migration locks them down the way the Flight tables are
-- (20261201000100 / 0200): every privilege revoked from public, anon,
-- authenticated and service_role, RLS on with the restrictive valid-session
-- policy, and the migration fails if any privilege is left.
--
-- Tables: visa_application_documents, visa_result_notices (new in
-- 20261202000100) and visa_applications (new columns in 20261202000100).
-- The visa build creates no sequence (all keys are uuid).
--
-- Note: History kind visa.application_relinked -> applicant_back
-- (department_task_history, 20261202000120) can no longer occur (lead
-- decision 16: nobody is matched by name); the mapping is harmless and kept.
--
-- No refusal tokens. Rollback (forward-only): none needed; granting table
-- access to API roles is never intended.

begin;
set local lock_timeout = '15s';

do $$
declare
  t text;
  r text;
begin
  foreach t in array array['visa_application_documents', 'visa_result_notices', 'visa_applications'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
    if not exists (select 1 from pg_catalog.pg_policies p
                   where p.schemaname = 'public' and p.tablename = t and p.policyname = 'require_valid_session'
                     and p.permissive = 'RESTRICTIVE') then
      raise exception 'public.% has no restrictive require_valid_session policy', t;
    end if;
    foreach r in array array['anon', 'authenticated', 'service_role'] loop
      if exists (select 1 from pg_catalog.pg_roles x where x.rolname = r)
         and (has_table_privilege(r, format('public.%I', t), 'select,insert,update,delete,truncate,references,trigger')
              or has_any_column_privilege(r, format('public.%I', t), 'select,insert,update,references')) then
        raise exception 'public.% still grants a privilege to %', t, r;
      end if;
    end loop;
  end loop;
end;
$$;

commit;
