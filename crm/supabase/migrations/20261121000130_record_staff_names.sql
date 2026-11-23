-- TripNavigate CRM - Direction A Batch 1, item B1-4: the owner's display name on
-- Deals and Leads the caller can already open.
--
-- Contract: docs/implementation/frontend-redesign-2026-10-15/batch-1-backend-contract.md
-- item B1-4. Owner answer DEC-52 (19 October 2026), scope confirmed by the
-- owner's "OK" relayed by the lead: the record OWNER's display name only, on
-- records the person can already open. Names of assignees or other colleagues
-- are NOT approved and are never returned (screens keep today's wording for
-- them).
--
-- What changes:
--   1. Deal readability uses the internal helper authz.deal_row_visible(p_deal)
--      (created in 20261121000110: exactly the deals policies scoped_read and
--      hide_removed; not granted to any API role; a database test keeps it
--      equal to the policy for every role fixture).
--   2. Read public.record_staff_names(p_user_ids uuid[]) returns
--      [{userId, displayName}] only for ids that own at least one Deal the
--      caller can read (same predicate as the policy) or own at least one Lead
--      the caller can read (authz.can_read_lead). At most 200 ids. Only
--      staff_profiles.display_name: never e-mail, phone, roles, memberships or
--      status. An id that owns nothing the caller can read returns nothing.
--
-- Refusal tokens: 42501 not_authorized; 22023 invalid_input (hint user_ids).
-- Reads write nothing. Rollback (forward-only): a new migration revoking
-- execute on public.record_staff_names(uuid[]); screens fall back to today's
-- wording.
--
-- Apply history: this file has run only on disposable local and CI stacks.
-- It was amended in place on 19 October 2026 after the Echo-A review
-- (echo-redesign-batch1-data.md: M1, L1-L3, L5, L7) before any kept or live
-- database applied it.

begin;
set local lock_timeout = '15s';

create function public.record_staff_names(p_user_ids uuid[]) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ids uuid[];
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_user_ids is null or cardinality(p_user_ids) > 200 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'user_ids';
  end if;
  select coalesce(array_agg(distinct u), '{}') into v_ids from unnest(p_user_ids) as u where u is not null;
  if cardinality(v_ids) = 0 then
    return '[]'::jsonb;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('userId', p.user_id, 'displayName', p.display_name) order by p.user_id)
    from public.staff_profiles p
    where p.user_id = any (v_ids)
      and (
        -- Echo L5: the one shared copy of the deals read policy.
        exists (
          select 1 from public.deals d
          where d.owner_user_id = p.user_id and d.removed_at is null and authz.deal_row_visible(d.id))
        or exists (
          select 1 from public.crm_leads l
          where l.owner_user_id = p.user_id and authz.can_read_lead(l.id))
      )), '[]'::jsonb);
end;
$$;

comment on function public.record_staff_names(uuid[]) is
  'Direction A B1-4 (DEC-52): display names of the OWNERS of Deals and Leads the caller can already read; display name only. Never assignee names, contact details, roles or status.';

revoke all on function public.record_staff_names(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.record_staff_names(uuid[]) to authenticated;

commit;
