-- ROLLBACK ONLY - not a migration. Undo stage 1b (20261206000110): require_row_version raises 40001 again. The handlers may keep accepting both codes.
-- Restores the function text that was live before the named migration.
-- Apply only with the owner's approval, as a fix-forward migration copied
-- into the lead's spare range (20261206000900-990). Generated with the
-- migrations in supabase/migrations/20261206000*_conflict_code_*.sql.

begin;

-- authz.require_row_version(integer, integer)
create or replace function authz.require_row_version(p_expected integer, p_actual integer) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_expected is null or p_expected <> p_actual then
    raise exception 'version_changed' using errcode = '40001';
  end if;
end;
$$;

commit;
