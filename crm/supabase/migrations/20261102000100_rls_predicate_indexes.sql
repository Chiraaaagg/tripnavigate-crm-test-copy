-- AUDIT-030: indexes for columns used in RLS predicates on every read.
--
-- Without an index whose first column is the predicate column, each policy
-- check scans the table:
--   deals.owner_user_id                deals scoped_read (owner path)
--   fulfilment_tasks.assignee_user_id  authz.can_work_purchase_task
--   booking_evidence.deal_id           authz.can_read_booking_evidence(deal_id)
--
-- First written as 20261009000100 on the audit branch (never applied to the
-- hosted business database). Renumbered 20261102000100 in the combined
-- release so it sorts after 20261101000100_accounts_receipts, which the hosted
-- database already applied, and after the reverted local-bitrix-live set
-- (20261008000500). Forward-only; no data changes.

begin;

create index if not exists deals_owner_user_idx
  on public.deals (owner_user_id);

create index if not exists fulfilment_tasks_assignee_idx
  on public.fulfilment_tasks (assignee_user_id)
  where assignee_user_id is not null;

create index if not exists booking_evidence_deal_idx
  on public.booking_evidence (deal_id);

commit;
