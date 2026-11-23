-- TripNavigate CRM - Accounts phase, track C fix-forward (lead decision after
-- Addendum L1 item 7, 10 November 2026).
--
-- authz.visa_notice_reader (replaces 20261202000110, same signature): the
-- Manager fallback now uses the same "Deal has an active Sales owner"
-- predicate as the bell's SO* rule (authz.notice_deal_has_sales_owner,
-- 20261203000450: the owner holds active Sales and no Purchase, Flight or Visa
-- membership) instead of authz.flight_has_active_sales_owner (which ignored
-- Purchase and Visa). A Deal whose owner holds Sales + Purchase therefore has
-- the branch Manager as its Visa notice reader, so marking the bell notice
-- also marks the Visa card seen, and the Deal card / Home rows show the
-- notices to that Manager. The Sales owner branch is unchanged.
--
-- Rollback (forward-only): a new migration restoring the 20261202000110 body.

begin;
set local lock_timeout = '15s';

create or replace function authz.visa_notice_reader(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and (
    authz.visa_is_sales_owner(p_deal)
    or (authz.is_branch_sales_manager(p_deal)
        and authz.deal_services_scope(p_deal) is null
        -- Accounts phase (20261203000460): one "active Sales owner" predicate with the bell (SO*).
        and not authz.notice_deal_has_sales_owner(p_deal)))
$$;

commit;
