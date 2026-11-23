-- TripNavigate CRM - Accounts phase 3, track A fix-forward: "Send again" never
-- doubles a customer message (contract Addendum L4, item 2).
--
-- authz.cmsg_can_resend (replaces 20261205000120, same signature): besides the
-- 5.9 states (failed; skipped no_contact; stopped and no longer opted out), a
-- message may be sent again only while no earlier re-send of the same
-- original (the whole resend_of chain from its root) is live: queued, sending
-- (incl. waiting for a retry), sent, delivered or read. Once every such
-- re-send ended failed, skipped or stopped, "Send again" is allowed again.
-- customer_message_resend refuses wrong_state (55000) otherwise; its request
-- id replay (outcome existing) is unchanged and comes first. R-A1 can.resend
-- follows the same function.
--
-- Rollback (forward-only): a NEW migration restoring the 20261205000120 body.

begin;
set local lock_timeout = '15s';

create or replace function authz.cmsg_can_resend(p_msg public.customer_messages) returns boolean
language sql stable security definer set search_path = '' as $$
  with recursive up as (
    select m.id, m.resend_of from public.customer_messages m where m.id = p_msg.id
    union all
    select m.id, m.resend_of from public.customer_messages m join up on m.id = up.resend_of
  ),
  down as (
    select m.id, m.status from public.customer_messages m
    where m.resend_of = (select u.id from up u where u.resend_of is null limit 1)
    union all
    select m.id, m.status from public.customer_messages m join down d on m.resend_of = d.id
  )
  select (p_msg.status = 'failed'
          or (p_msg.status = 'skipped' and p_msg.skip_reason = 'no_contact')
          or (p_msg.status = 'stopped' and not authz.cmsg_opted_out(p_msg.legal_entity_id,
                (select c.mobile from authz.cmsg_contact(p_msg.deal_id) c))))
     -- Accounts phase 3 (20261205000150): no live earlier re-send of the same original.
     and not exists (select 1 from down d where d.status not in ('failed', 'skipped', 'stopped'))
$$;

revoke all on function authz.cmsg_can_resend(public.customer_messages) from public, anon, authenticated, service_role;

commit;
