-- Flight build, Track B (10): Manager bank-detail rows carry the supplier's
-- service types (additive key serviceTypes, string array), so the Approvals
-- screen can leave out the Purchase supplier link for flight-only suppliers.
--
-- Replaced (same signature): public.manager_approvals (body of
-- 20261201000220 plus the key).
--
-- Rollback (forward-only): a NEW migration restoring the 20261201000220 body.

begin;
set local lock_timeout = '15s';

create or replace function public.manager_approvals() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if not coalesce(authz.session_ok(), false) or not exists (
       select 1 from public.memberships m
       where m.user_id = v_uid and m.status = 'active' and m.role_code = 'manager'
         and authz.holds_active_role('manager', m.legal_entity_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return jsonb_build_object(
    'costsAboveBudget', coalesce((
      select jsonb_agg(jsonb_build_object(
        'taskId', r.task_id,
        'dealReference', d.reference,
        'serviceTitle', coalesce(authz.sm_task_title(r.task_id), 'Service'),
        'supplierName', s.name,
        'versionNo', r.version_no,
        'amountPaise', c.amount_paise::text,
        'budgetPaise', coalesce(authz.task_budget(r.task_id), 0)::text,
        'proposedAt', r.since,
        'proposedByName', p.display_name,
        'canApprove', r.created_by <> v_uid) order by r.since, r.task_id)
      from authz.sm_manager_cost_rows() r
      join public.fulfilment_tasks t on t.id = r.task_id
      join public.deals d on d.id = t.deal_id
      join public.purchase_cost_versions c on c.task_id = r.task_id and c.version_no = r.version_no
      left join public.purchase_quotes q on q.id = c.quote_id
      left join public.suppliers s on s.id = q.supplier_id
      left join public.staff_profiles p on p.user_id = r.created_by), '[]'::jsonb),
    'payments', coalesce((
      select jsonb_agg(authz.sm_accounts_payment_json(p.id) order by coalesce(p.due_date, date '2100-12-31'), p.requested_at, p.id)
      from public.supplier_payment_requests p
      where p.route = 'manager' and p.status = 'pending' and authz.is_branch_sales_manager(p.deal_id)
        -- Review F5: a manager who also holds Purchase never sees customer money or funding.
        and not authz.holds_role('purchase', p.legal_entity_id)), '[]'::jsonb),
    'funding', coalesce((
      select jsonb_agg(authz.sm_funding_json(f.id) order by f.requested_at, f.id)
      from public.company_funding_requests f
      join public.supplier_payment_requests p on p.id = f.payment_request_id
      where f.route = 'manager' and f.status = 'pending' and p.status not in ('returned', 'cancelled')
        and authz.is_branch_sales_manager(f.deal_id) and not authz.holds_role('purchase', f.legal_entity_id)), '[]'::jsonb),
    'bankDetails', coalesce((
      select jsonb_agg(jsonb_build_object(
        'supplierId', s.id,
        'supplierName', s.name,
        -- 20261201000290: so screens can tell flight-only suppliers apart.
        'serviceTypes', to_jsonb(s.service_types),
        'revisionNo', x.revision_no,
        'accountHolder', x.account_holder,
        'bankName', x.bank_name,
        'ifsc', x.ifsc,
        'accountLast4', right(x.account_number, 4),
        'createdAt', x.created_at,
        'createdByName', p.display_name,
        'canApprove', x.created_by <> v_uid) order by x.created_at, s.id)
      from authz.sm_manager_bank_rows() r
      join public.suppliers s on s.id = r.supplier_id
      join public.supplier_beneficiary_revisions x on x.supplier_id = r.supplier_id and x.revision_no = r.revision_no
      left join public.staff_profiles p on p.user_id = x.created_by), '[]'::jsonb),
    'suppliersToVerify', coalesce((
      select jsonb_agg(jsonb_build_object(
        'supplierId', s.id,
        'name', s.name,
        'city', s.city,
        'serviceTypes', to_jsonb(s.service_types),
        'rowVersion', s.row_version,
        'updatedAt', s.updated_at,
        'canVerify', r.can_verify) order by lower(s.name), s.id)
      from authz.sm_manager_supplier_rows() r
      join public.suppliers s on s.id = r.supplier_id), '[]'::jsonb),
    'cancellations', authz.sm_manager_cancellations_json(),
    -- Flight build (20261201000220): fares above the Deal's flight budget.
    'flightFares', coalesce((
      select jsonb_agg(jsonb_build_object(
        'approvalId', a.id,
        'dealId', a.deal_id,
        'dealReference', d.reference,
        'flightTitles', coalesce((
          select jsonb_agg(y.title order by y.item_no, y.id)
          from (select distinct t.id, i.item_no, coalesce(authz.sm_task_title(t.id), 'Flight') as title
                from public.flight_sectors fs
                join public.fulfilment_tasks t on t.id = fs.task_id
                join public.service_items i on i.id = t.service_item_id
                where fs.id::text in (select jsonb_array_elements_text(a.payload -> 'sectorIds'))) y), '[]'::jsonb),
        'supplierName', s.name,
        'batchSupplierCostPaise', a.batch_supplier_cost_paise::text,
        'projectedSupplierCostPaise', a.projected_supplier_cost_paise::text,
        'budgetPaise', a.budget_paise::text,
        'requestedAt', a.requested_at,
        'requestedByName', rp.display_name,
        'rowVersion', a.row_version,
        'canApprove', r.can_approve) order by a.requested_at, a.id)
      from authz.flight_manager_fare_rows() r
      join public.flight_fare_approvals a on a.id = r.approval_id
      join public.deals d on d.id = a.deal_id
      left join public.suppliers s on s.id::text = a.payload ->> 'supplierId'
      left join public.staff_profiles rp on rp.user_id = a.requested_by), '[]'::jsonb));
end;
$$;

commit;
