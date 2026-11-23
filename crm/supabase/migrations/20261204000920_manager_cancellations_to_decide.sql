-- Accounts phase 2, lead fix-forward round 2 (speed, 12 Nov 2026): the
-- Manager › Approvals page read public.manager_cancellation_list() (every
-- cancellation of the Manager's branches, any status, with charges and Flight
-- charges per row): 690 KB / 221 ms with 2,000 approved cancellations. The page
-- only shows details for the cancellations waiting for the Manager
-- (manager_approvals().cancellations: status sent_to_manager, branch Manager,
-- oldest sent first, at most 50 since 20261204000900).
--
-- New: public.manager_cancellations_to_decide() — the SAME row shape and
-- per-row values (canDecide included) as manager_cancellation_list
-- (20261204000330 body), for exactly those cancellations, in that order.
-- The gate is unchanged (session; rows only for the Deal's branch Manager).
-- manager_cancellation_list stays as it is for any other reader.
--
-- Rollback (forward-only): a NEW migration dropping the function (the
-- Approvals loader goes back to manager_cancellation_list).

begin;
set local lock_timeout = '15s';

create function public.manager_cancellations_to_decide() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'cancellationId', c.id,
        'dealId', c.deal_id,
        'dealReference', d.reference,
        'branchName', b.name,
        'status', c.status,
        'reason', c.reason,
        'openedAt', c.opened_at,
        'openedByName', op.display_name,
        'sentAt', c.sent_at,
        'sentByName', sp.display_name,
        'decidedAt', c.decided_at,
        'decidedByName', dp.display_name,
        'returnReason', c.return_reason,
        'rowVersion', c.row_version,
        'charges', authz.cancellation_charges_json(c.id),
        'totalKeepsPaise', coalesce((select sum(cur.supplier_keeps_paise) from (
            select distinct on (x.task_id) x.supplier_keeps_paise from public.purchase_cancellation_charges x
            where x.cancellation_id = c.id order by x.task_id, x.revision_no desc) cur), 0)::text,
        'totalRefundPaise', coalesce((select sum(cur.supplier_refund_paise) from (
            select distinct on (x.task_id) x.supplier_refund_paise from public.purchase_cancellation_charges x
            where x.cancellation_id = c.id order by x.task_id, x.revision_no desc) cur), 0)::text,
        -- Accounts phase 2 (20261204000330): Flight charges and the combined kept charges.
        'flightCharges', authz.flight_cancellation_charges_json(c.id),
        'chargesKeptPaise', authz.cancellation_charges_kept(c.id)::text,
        'canDecide', (c.status = 'sent_to_manager'
                      or (c.status in ('open', 'charges_entered') and not authz.cancellation_needs_charges(c.id)))
          and c.sent_by is distinct from v_uid
          and not exists (select 1 from public.purchase_cancellation_charges x
                          where x.cancellation_id = c.id and x.entered_by = v_uid)
          and not exists (select 1 from public.flight_cancellation_charges y
                          where y.cancellation_id = c.id and y.entered_by = v_uid))
        order by c.sent_at, c.id)
    -- The Approvals list (authz.sm_manager_cancellations_json): sent to the
    -- Manager of the Deal's branch, oldest sent first, the same first 50 that
    -- manager_approvals().cancellations shows (its cancellationsTotal is the count).
    from (select x.* from public.deal_cancellations x
          where x.status = 'sent_to_manager' and authz.is_branch_sales_manager(x.deal_id)
          order by x.sent_at, x.id limit 50) c
    join public.deals d on d.id = c.deal_id
    join public.branches b on b.id = c.branch_id
    left join public.staff_profiles op on op.user_id = c.opened_by
    left join public.staff_profiles sp on sp.user_id = c.sent_by
    left join public.staff_profiles dp on dp.user_id = c.decided_by
  ), '[]'::jsonb);
end;
$$;

revoke all on function public.manager_cancellations_to_decide() from public, anon, authenticated, service_role;
grant execute on function public.manager_cancellations_to_decide() to authenticated;

commit;
