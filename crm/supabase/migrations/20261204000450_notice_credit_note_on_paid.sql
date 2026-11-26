-- TripNavigate CRM - Accounts phase 2, Track D (6): notice 32 on payment.
-- Contract: accounts-phase2-2026-11-11/contract.md Addendum L7 item 2
-- (independent backend review 2): credit_note_to_release (32) for credit-note
-- source case 2 (7.6: no Invoice, payout paid, released Advance Invoices) was
-- never written, because the payout insert ran before the request was
-- 'paid' and the status -> paid branch did not check the source.
-- Replaced (20261204000430 bodies, same signatures):
--   authz.notices_on_refund_request: + 32 when the request moves to 'paid';
--   authz.notices_on_refund_payout: no longer checks 32 (29 unchanged).
-- Refusal tokens: none. Rollback (forward-only): a new migration restoring the
-- 20261204000430 bodies.

begin;
set local lock_timeout = '15s';

create or replace function authz.notices_on_refund_request() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_old text := case when tg_op = 'UPDATE' then old.status end;
  v_entity_rule boolean;
begin
  -- 38 resolved: a request exists for the cancellation.
  if tg_op = 'INSERT' and new.cancellation_id is not null then
    perform authz.notice_resolve('cancel:' || new.cancellation_id || ':refund', 'acted');
  end if;
  -- 26 resolved when the request leaves "requested".
  if v_old = 'requested' and new.status <> 'requested' then
    perform authz.notice_resolve('refund:' || new.id || ':approve', 'acted');
  end if;
  -- 26 waiting for approval (create or resubmit).
  if new.status = 'requested' and v_old is distinct from 'requested' then
    v_entity_rule := new.requested_as = 'manager';
    perform authz.notice_write('refund_to_approve',
      array_remove(case when v_entity_rule then array(select authz.notice_entity_m_recipients(new.legal_entity_id))
                        else array(select authz.notice_branch_m_recipients(new.legal_entity_id, new.branch_id)) end,
                   new.requested_by),
      new.legal_entity_id, new.branch_id, new.deal_id, null, 'refund_request', new.id,
      jsonb_build_object('refNo', new.ref_no, 'status', case when v_entity_rule then 'entity' end),
      'refund:' || new.id || ':approve:' || new.row_version, 'refund:' || new.id || ':approve');
  end if;
  if tg_op = 'UPDATE' and new.status in ('approved', 'returned') and v_old is distinct from new.status then
    -- 27 decided -> the requester.
    perform authz.notice_write('refund_decided', array[new.requested_by], new.legal_entity_id, new.branch_id, new.deal_id,
      null, 'refund_request', new.id, jsonb_build_object('refNo', new.ref_no, 'status', new.status),
      'refund:' || new.id || ':' || new.status || ':' || new.row_version, null);
  end if;
  if tg_op = 'UPDATE' and new.status = 'approved' and v_old is distinct from 'approved' then
    -- 28 pay it out (Accounts, not the requester or the approver).
    if new.outcome = 'payout' then
      perform authz.notice_write('refund_payout_due',
        array_remove(array_remove(array(select authz.notice_accounts_recipients(new.legal_entity_id)), new.requested_by),
                     new.decided_by),
        new.legal_entity_id, new.branch_id, new.deal_id, null, 'refund_request', new.id,
        jsonb_build_object('refNo', new.ref_no), 'refund:' || new.id || ':payout', 'refund:' || new.id || ':payout');
    end if;
    -- 32 credit note source after approval (7.6 case 1).
    if new.kind = 'cancellation' then
      perform authz.notice_credit_note(new);
    end if;
  end if;
  -- 28 resolved when paid or withdrawn.
  if tg_op = 'UPDATE' and new.status in ('paid', 'withdrawn') and v_old is distinct from new.status then
    perform authz.notice_resolve('refund:' || new.id || ':payout', case when new.status = 'paid' then 'acted' else 'superseded' end);
  end if;
  -- Addendum L7 (20261204000450): 32 credit note source once the request is paid (7.6 case 2).
  if tg_op = 'UPDATE' and new.status = 'paid' and v_old is distinct from 'paid' then
    perform authz.notice_credit_note(new);
  end if;
  return null;
end;
$$;

create or replace function authz.notices_on_refund_payout() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v public.customer_refund_requests%rowtype;
begin
  select * into v from public.customer_refund_requests q where q.id = new.refund_request_id;
  if v.id is null then
    return null;
  end if;
  -- 29 paid -> the requester and SO*.
  perform authz.notice_write('refund_paid', array[v.requested_by], v.legal_entity_id, v.branch_id, v.deal_id, null,
    'refund_request', v.id, jsonb_build_object('refNo', v.ref_no, 'status', 'requester'), 'refund:' || v.id || ':paid', null);
  perform authz.notice_write('refund_paid', array_remove(array(select authz.notice_so_star_recipients(v.deal_id)), v.requested_by),
    v.legal_entity_id, v.branch_id, v.deal_id, null, 'refund_request', v.id, jsonb_build_object('refNo', v.ref_no),
    'refund:' || v.id || ':paid', null);
  -- Addendum L7 (20261204000450): notice 32 moved to the request's move to 'paid'
  -- (authz.notices_on_refund_request); at this insert the request is not paid yet.
  return null;
end;
$$;

commit;
