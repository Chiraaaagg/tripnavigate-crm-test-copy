-- TripNavigate CRM - Accounts phase 3, track C (fix): the 366-day period cap
-- applies to Tally import files too (contract Addendum L6, lead, 13 Nov 2026).
-- Replaces authz.tally_file_args (20261205000310, same signature) and restores
-- the Phase 1 period check of tally_exports for every format.
-- Refusal tokens: invalid_input (22023, hint 'to') - unchanged.
-- Rollback (forward-only): a NEW migration restoring the 20261205000300 check
-- and the 20261205000310 body.

begin;
set local lock_timeout = '15s';

alter table public.tally_exports drop constraint tally_exports_period_check;
alter table public.tally_exports add constraint tally_exports_period_check
  check (period_from <= period_to and period_to - period_from <= 366);

-- Replaces 20261205000310 (same signature): + the 366-day cap (Addendum L6).
create or replace function authz.tally_file_args(p_entity uuid, p_from date, p_to date, p_kinds text[], p_branch_ids uuid[])
returns table (kinds text[], branches uuid[])
language plpgsql stable security definer set search_path = '' as $$
declare
  v_kinds text[];
  v_branches uuid[];
begin
  if p_from is null or p_from < date '2000-01-01' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'from';
  end if;
  -- Accounts phase 3 (20261205000330): at most 366 days, like the CSV export.
  if p_to is null or p_to < p_from or p_to > authz.finance_today() or p_to - p_from > 366 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'to';
  end if;
  -- null = every kind a file may be asked for.
  if p_kinds is not null and (cardinality(p_kinds) = 0 or array_position(p_kinds, null) is not null
     or not (p_kinds <@ authz.tally_file_kinds())) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kinds';
  end if;
  select array_agg(distinct k order by k) into v_kinds from unnest(coalesce(p_kinds, authz.tally_file_kinds())) k;
  if p_branch_ids is not null and cardinality(p_branch_ids) > 0 then
    if cardinality(p_branch_ids) > 50 or array_position(p_branch_ids, null) is not null
       or exists (select 1 from unnest(p_branch_ids) x(id)
                  where not exists (select 1 from public.branches b where b.id = x.id and b.legal_entity_id = p_entity)) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'branchIds';
    end if;
    select array_agg(distinct x order by x) into v_branches from unnest(p_branch_ids) x;
  end if;
  return query select v_kinds, v_branches;
end;
$$;

revoke all on function authz.tally_file_args(uuid, date, date, text[], uuid[]) from public, anon, authenticated, service_role;

commit;
