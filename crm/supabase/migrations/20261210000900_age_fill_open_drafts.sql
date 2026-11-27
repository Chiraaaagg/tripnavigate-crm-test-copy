-- TripNavigate CRM - Booking reliability fix batch 2, item B2-1 (BR-08), step 6:
-- one-time fill of the age of children and infants on OPEN DRAFTS.
--
-- LIVE DATA WRITE. Applied only with the owner's own APPROVE for this step,
-- separately from the schema migrations 20261210000100, 20261210000200 and
-- 20261210000300 (it is numbered last so those can be applied and this one
-- held).
--
-- What it writes: deal_travellers.age_years, only where all of these hold:
-- the traveller is a child or infant, has no stored age, has a saved date of
-- birth, and the Deal has an open package draft with a trip start; the number
-- is authz.traveller_age_derived (whole years on the trip start, 0 to 17).
-- Nothing else is written. Confirmed versions and their snapshots
-- (booking_version_travellers) are never touched; the date of birth is not
-- copied anywhere. The existing rehash triggers refresh each touched draft's
-- hash (its row version does not move); an open Book now page meets the usual
-- "changed" answer on Submit and reloads.
-- Report: two NOTICE lines: how many ages were filled, and how many stored
-- (typed) ages on open drafts differ from the date of birth (left as typed;
-- replaced by the derived number at the next passenger or trip save).
-- Needs: 20261210000100 (authz.traveller_age_derived and the triggers).
-- Rollback: none needed for safety (each number is what the trip start and
-- date of birth give; removing it would only bring back "Add the date of
-- birth, or the age" on the checklist). Nothing is deleted.

begin;
set local lock_timeout = '15s';

do $$
declare
  v_filled integer;
  v_differs integer;
begin
  with filled as (
    update public.deal_travellers t
    set age_years = authz.traveller_age_derived(t.id, t.deal_id)
    where t.traveller_type in ('child', 'infant') and t.age_years is null
      and authz.traveller_age_derived(t.id, t.deal_id) is not null
    returning t.id
  )
  select count(*) into v_filled from filled;
  select count(*) into v_differs
  from public.deal_travellers t
  where t.traveller_type in ('child', 'infant') and t.age_years is not null
    and authz.traveller_age_derived(t.id, t.deal_id) is not null
    and authz.traveller_age_derived(t.id, t.deal_id) <> t.age_years;
  raise notice 'B2-1 one-time fill: % child or infant ages filled on open drafts', v_filled;
  raise notice 'B2-1 one-time fill: % stored ages on open drafts differ from the date of birth (left as typed)', v_differs;
end;
$$;

commit;
