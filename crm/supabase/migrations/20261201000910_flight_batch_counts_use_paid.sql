-- TripNavigate CRM - Flight build, lead fix-forward (file granted to track A):
-- the progress bar's "n of m batches" uses Track B's single "is this batch
-- paid" rule.
-- Contract: Flight department build contract section 4 ("Batch paid") and 7
-- (progress bar); Track B 20261201000250 made authz.flight_batch_paid(batch)
-- the one truth (zero-cost batches and old-form costs that fully cover a batch
-- count as paid).
--
-- What changes: authz.flight_batch_payment_counts(p_deal) (same signature,
-- same ACL: revoked from every API role) counts paid batches with
-- authz.flight_batch_paid instead of its own copy of the rule. The done
-- checklist and the Home counts already go through authz.flight_money_issues
-- (Track B) and need no change.
--
-- No refusal tokens. Rollback (forward-only): a new migration restoring the
-- body from 20261201000100.

begin;
set local lock_timeout = '15s';

create or replace function authz.flight_batch_payment_counts(p_deal uuid) returns table(paid integer, total integer)
language sql stable security definer set search_path = '' as $$
  select (count(*) filter (where authz.flight_batch_paid(b.id)))::integer, count(*)::integer
  from public.flight_ticket_batches b where b.deal_id = p_deal
$$;
-- Keeps its ACL (CREATE OR REPLACE).

commit;
