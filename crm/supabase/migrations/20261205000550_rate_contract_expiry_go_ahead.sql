-- TripNavigate CRM - Accounts phase 3, track E (fix-forward): contract
-- Addendum L2 (lead, 13 November 2026).
--
-- 1. Expiry alerts keep the 09:00 India time rule (9.1); the logic moves to
--    authz.rate_contract_expiry_at(p_now timestamptz) so tests can call it with
--    a fixed time. authz.rate_contract_expiry() (the registered timer task,
--    unchanged name and registration) is a thin wrapper calling it with now().
--    Both are granted to nobody.
-- 2. public.accounts_go_ahead_list (M/20261130000120:263, same signature):
--    each row gains contractState, contractTotalPaise, contractDeviationReason
--    of the request's quote (additive keys), so Accounts sees "differs from
--    contract" on the go-ahead row (9.3).
--
-- Rollback (forward-only): a new migration restoring the 20261205000520 body
-- of authz.rate_contract_expiry and the 20261130000120 body of
-- accounts_go_ahead_list.

begin;
set local lock_timeout = '15s';

-- p_now: the moment to act for (India date and time are taken from it).
create function authz.rate_contract_expiry_at(p_now timestamptz) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_local timestamp := p_now at time zone 'Asia/Kolkata';
  v_today date := (p_now at time zone 'Asia/Kolkata')::date;
  v_n integer := 0;
begin
  if p_now is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'now';
  end if;
  -- 9.1: the day's alerts are written from 09:00 India time (the task runs hourly).
  if v_local::time < time '09:00' then
    return jsonb_build_object('inserted', 0, 'waiting', 1);
  end if;
  insert into public.rate_contract_alerts (legal_entity_id, contract_id, days_left)
  select c.legal_entity_id, c.id, (c.valid_to - v_today)
  from public.rate_contracts c
  where c.status = 'active' and c.valid_to in (v_today + 30, v_today + 7)
    and not exists (select 1 from public.rate_contracts x
                    where x.supplier_id = c.supplier_id and x.hotel_id = c.hotel_id and x.status = 'active'
                      and x.valid_to > c.valid_to)
  on conflict (contract_id, days_left) do nothing;
  get diagnostics v_n = row_count;
  return jsonb_build_object('inserted', v_n, 'waiting', 0);
end;
$$;

create or replace function authz.rate_contract_expiry() returns jsonb
language sql volatile security definer set search_path = '' as $$
  select authz.rate_contract_expiry_at(now())
$$;

revoke all on function authz.rate_contract_expiry_at(timestamptz), authz.rate_contract_expiry()
from public, anon, authenticated, service_role;

create or replace function public.accounts_go_ahead_list() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if not coalesce(authz.session_ok(), false) or not exists (
       select 1 from public.memberships m
       where m.user_id = v_uid and m.status = 'active' and m.role_code = 'accounts'
         and authz.holds_active_role('accounts', m.legal_entity_id)
         and not authz.holds_role('purchase', m.legal_entity_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(x.row order by x.pending desc, x.requested_at desc, x.id desc)
    from (
      select r.id, r.requested_at, r.status = 'pending' as pending,
        jsonb_build_object(
          'requestId', r.id,
          'status', r.status,
          'current', authz.purchase_go_ahead_request_current(r.id),
          'dealId', r.deal_id,
          'dealReference', d.reference,
          'branchName', b.name,
          'taskId', r.task_id,
          'itemTitle', coalesce(tjx.tj ->> 'itemTitle', tjx.tj ->> 'hotelName', 'Hotel'),
          'checkIn', tjx.tj ->> 'checkIn',
          'checkOut', tjx.tj ->> 'checkOut',
          'supplierName', s.name,
          'amountPaise', r.amount_paise::text,
          'costVersionNo', r.cost_version_no,
          'requestedAt', r.requested_at,
          'requestedByName', rp.display_name,
          'decidedAt', r.decided_at,
          'decidedByName', dp.display_name,
          'returnReason', r.return_reason,
          'rowVersion', r.row_version,
          'bookingReviewStatus', coalesce(abr.status, 'missing'),
          -- Accounts phase 3 (20261205000550, Addendum L2): the offer against the rate contract (9.3).
          'contractState', q.contract_state,
          'contractTotalPaise', q.contract_total_paise::text,
          'contractDeviationReason', q.contract_deviation_reason,
          'canDecide', r.status = 'pending' and r.requested_by <> v_uid
            and authz.purchase_go_ahead_request_current(r.id)
            and exists (select 1 from public.purchase_supplier_emails e
                        where e.id = r.email_id and e.status in ('sent', 'marked_sent'))
            and not authz.finance_deal_conflict(r.deal_id)
            and authz.finance_gate_issue(r.legal_entity_id, d.is_synthetic) is null) as row
      from public.purchase_go_ahead_requests r
      join public.deals d on d.id = r.deal_id
      join public.branches b on b.id = r.branch_id
      join public.purchase_quotes q on q.id = r.quote_id
      join public.suppliers s on s.id = q.supplier_id
      cross join lateral (select authz.purchase_task_json(r.task_id, false) as tj) tjx
      left join public.staff_profiles rp on rp.user_id = r.requested_by
      left join public.staff_profiles dp on dp.user_id = r.decided_by
      left join public.accounts_booking_reviews abr on abr.booking_version_id = r.booking_version_id
      where r.status <> 'superseded'
        and authz.holds_active_role('accounts', r.legal_entity_id)
        and not authz.holds_role('purchase', r.legal_entity_id)
      order by (r.status = 'pending') desc, r.requested_at desc, r.id desc
      limit 500
    ) x
  ), '[]'::jsonb);
end;
$$;

commit;
