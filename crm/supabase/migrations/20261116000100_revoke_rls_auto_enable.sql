-- TripNavigate CRM - security: the dashboard-created event-trigger helper
-- public.rls_auto_enable() (Supabase "auto-enable RLS for new tables") was
-- executable by public, anon and authenticated through the Data API.
--
-- Owner approval: "APPROVE", 9 October 2026 (evening), applied with the next
-- release after GitHub CI runs again. Findings:
-- docs/implementation/current/security-findings-2026-10-09.md.
--
-- Event triggers call the function directly and the SECURITY DEFINER owner
-- (postgres) keeps EXECUTE, so automatic RLS on new tables keeps working.
-- The function does not exist on fresh local stacks: the revoke is guarded.
-- Rollback: grant execute on function public.rls_auto_enable() to public, anon, authenticated;

do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    execute 'revoke execute on function public.rls_auto_enable() from public, anon, authenticated';
  end if;
end;
$$;
