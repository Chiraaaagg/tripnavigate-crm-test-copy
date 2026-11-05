-- TripNavigate CRM - Flight build, track A (UI review): status words for a
-- flight with no ticket pairs yet.
-- Contract: Flight department build contract section 7 (status words),
-- lead UI review 5 November 2026.
--
-- What changes: authz.flight_status_text (same signature and ACL) says
-- "In progress · flight details not typed yet" instead of
-- "In progress · 0 of 0 tickets" when nothing is ticketable yet (a screenshot
-- flight whose sectors Flight has not typed). Task and group words both use
-- it (flight_task_status_json, flight_group_status_json), so a group whose
-- open flights have no ticket pairs at all shows the same words. Every other
-- word is unchanged.
--
-- No refusal tokens. Rollback (forward-only): a new migration restoring the
-- body from 20261201000120.

begin;
set local lock_timeout = '15s';

create or replace function authz.flight_status_text(p_code text, p_confirmed integer, p_required integer) returns text
language sql immutable set search_path = '' as $$
  select case p_code
    when 'waiting' then 'Waiting'
    when 'in_progress' then case when coalesce(p_required, 0) = 0 then 'In progress · flight details not typed yet'
                                 else 'In progress · ' || coalesce(p_confirmed, 0) || ' of ' || p_required || ' tickets' end
    when 'all_confirmed' then 'All tickets confirmed'
    when 'done' then 'Done · ticket issued' end
$$;
-- Keeps its ACL (CREATE OR REPLACE).

commit;
