-- Purchase build, Track B (3): PurchasePaymentRequestView gains rowVersion
-- (the expected version supplier_payment_request_cancel needs). Additive:
-- replaces authz.sm_purchase_payment_json from 20261130000210 with one more
-- key; nothing else changes. Shapes: crm/src/modules/supplier-money/contracts.ts.
--
-- Rollback (forward-only): a new migration restoring the 20261130000210 body.

begin;
set local lock_timeout = '15s';

create or replace function authz.sm_purchase_payment_json(p_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', p.id,
    'refNo', p.ref_no,
    'dealId', p.deal_id,
    'dealReference', d.reference,
    'taskId', p.task_id,
    'serviceTitle', coalesce(authz.sm_task_title(p.task_id), 'Service'),
    'serviceType', coalesce(authz.sm_task_type(p.task_id), 'hotel'),
    'supplierId', p.supplier_id,
    'supplierName', s.name,
    'part', p.part,
    'amountPaise', p.amount_paise::text,
    'dueDate', to_char(p.due_date, 'YYYY-MM-DD'),
    'note', p.note,
    'route', p.route,
    'status', p.status,
    'costVersionNo', p.cost_version_no,
    'proformaEvidenceId', p.proforma_evidence_id,
    'returnReason', p.return_reason,
    'requestedAt', p.requested_at,
    'requestedByName', rp.display_name,
    'decidedAt', p.decided_at,
    'decidedByName', dp.display_name
  ) || jsonb_build_object(
    'paidOn', to_char(p.paid_on, 'YYYY-MM-DD'),
    'paymentMode', p.payment_mode,
    'bankReference', p.bank_reference,
    'verifiedAt', p.verified_at,
    -- Review F1: no customer money or company funding signal for Purchase;
    -- only the bank detail hold (supplier data).
    'onHold', coalesce(h.reason = 'bank_details_on_hold', false),
    'holdReason', case when h.reason = 'bank_details_on_hold' then h.reason end,
    'resubmittedAs', (select n.ref_no from public.supplier_payment_requests n where n.resubmits_id = p.id),
    'resubmitsRefNo', o.ref_no,
    'canCancel', p.status = 'pending' and p.requested_by = (select auth.uid())
                 and authz.holds_active_role('purchase', p.legal_entity_id),
    'canResubmit', p.status = 'returned'
                   and not exists (select 1 from public.supplier_payment_requests n where n.resubmits_id = p.id)
                   and coalesce(authz.can_work_purchase_task(p.task_id), false),
    -- 20261130000220: optimistic version for cancel.
    'rowVersion', p.row_version)
  from public.supplier_payment_requests p
  join public.deals d on d.id = p.deal_id
  join public.suppliers s on s.id = p.supplier_id
  left join public.staff_profiles rp on rp.user_id = p.requested_by
  left join public.staff_profiles dp on dp.user_id = p.decided_by
  left join public.supplier_payment_requests o on o.id = p.resubmits_id
  cross join lateral (select authz.sm_hold_reason(p.id) as reason) h
  where p.id = p_id
$$;

revoke all on function authz.sm_purchase_payment_json(uuid) from public, anon, authenticated;

commit;
