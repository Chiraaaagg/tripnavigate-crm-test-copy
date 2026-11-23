-- TripNavigate CRM - Accounts phase, Phase 0 item 2 (track A): Accounts can
-- no longer return a booking once the Deal is committed.
--
-- Frozen contract: docs/implementation/accounts-phase-2026-11-10/contract.md
-- sections 1.1 (item 2), 4.2, 5.2 and 5.4; owner answer H6. Every replaced
-- function keeps its signature and starts from its latest body; changed lines
-- are marked "Accounts phase (20261203000110)".
--
-- What changes:
--   1. authz.deal_return_blocked(uuid) (new, internal, no grant): 'committed'
--      when authz.deal_committed (a supplier confirmed or a non-visa task
--      completed; visa completion never blocks, QB3), else 'tickets_issued'
--      when any flight_ticket_batches row exists on the Deal, else null.
--   2. authz.deal_commitment_lock(uuid) (new, internal, no grant): every task
--      of the Deal FOR UPDATE in id order, then the Deal FOR KEY SHARE - the
--      shape supplier confirmation (task -> Deal key share) and the Flight
--      group lock take. Inside the return the order is finance_deal_heads ->
--      tasks -> Deal, the same as the Flight money commands, so it cannot
--      cycle with supplier confirmation.
--   3. public.accounts_review_return (replaces 20261101000100): after the
--      finance lock and the replay check (an exact retry of an earlier
--      successful return still returns its stored result), the commitment
--      lock, then refusal review_return_committed (55000, hint 'committed' or
--      'tickets_issued'). The reason, state and write steps are unchanged.
--   4. public.accounts_deal_detail (replaces 20261124000120): booking gains
--      'canReturn' (review not returned and no block) and 'returnBlock'
--      ('committed' | 'tickets_issued' | null).
--
-- New refusal token: 55000 review_return_committed ("This booking cannot be
-- returned: a supplier has already confirmed it or flight tickets are issued.
-- To stop or change the trip, ask the branch Manager to start a
-- cancellation."). Refusals are not audited (as today).
-- Data: none changed. No new table, grant or switch.
-- Rollback (forward-only): a NEW migration restoring the previous bodies
-- (20261101000100, 20261124000120) and then dropping the two helpers.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Return block and commitment lock (new; contract 4.2)
-- ===========================================================================

create function authz.deal_return_blocked(p_deal uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when authz.deal_committed(p_deal) then 'committed'
    when exists (select 1 from public.flight_ticket_batches b where b.deal_id = p_deal) then 'tickets_issued'
  end
$$;
comment on function authz.deal_return_blocked(uuid) is
  'Accounts phase (contract 4.2): why the Accounts booking review can no longer be returned (committed | tickets_issued), else null. Internal; no grant.';

create function authz.deal_commitment_lock(p_deal uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform 1 from public.fulfilment_tasks t where t.deal_id = p_deal order by t.id for update;
  perform 1 from public.deals d where d.id = p_deal for key share;
end;
$$;
comment on function authz.deal_commitment_lock(uuid) is
  'Accounts phase (contract 4.2): every task of the Deal FOR UPDATE in id order, then the Deal FOR KEY SHARE. Take after authz.finance_lock_deal. Internal; no grant.';

revoke all on function authz.deal_return_blocked(uuid), authz.deal_commitment_lock(uuid)
from public, anon, authenticated, service_role;

-- ===========================================================================
-- 2. Accounts review return (replaces 20261101000100; lines marked Accounts phase)
-- ===========================================================================

create or replace function public.accounts_review_return(p_booking_version_id uuid, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_review public.accounts_booking_reviews%rowtype;
  v_payload jsonb := jsonb_build_object('bookingVersionId', p_booking_version_id, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
  v_block text;  -- Accounts phase (20261203000110)
begin
  v_ver := authz.finance_confirmed_version(p_booking_version_id);
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  perform authz.finance_lock_deal(v_ver.deal_id);
  v_result := authz.finance_replay(v_ver.legal_entity_id, p_request_id, 'accounts_review_return', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  -- Accounts phase (20261203000110): the Deal's tasks (by id) and the Deal, the
  -- lock supplier confirmation and ticket confirmation take; then no return
  -- once a supplier confirmed, a non-visa task completed or tickets exist (H6).
  perform authz.deal_commitment_lock(v_ver.deal_id);
  v_block := authz.deal_return_blocked(v_ver.deal_id);
  if v_block is not null then
    raise exception 'review_return_committed' using errcode = '55000', hint = v_block;
  end if;
  v_reason := authz.finance_reason(p_reason);

  select * into v_review from public.accounts_booking_reviews rv where rv.booking_version_id = v_ver.id for update;
  if v_review.status = 'returned' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if v_review.id is null then
    insert into public.accounts_booking_reviews (booking_version_id, deal_id, legal_entity_id, status, return_reason,
      reviewed_by, reviewed_at)
    values (v_ver.id, v_ver.deal_id, v_ver.legal_entity_id, 'returned', v_reason, (select auth.uid()), now())
    returning * into v_review;
  else
    update public.accounts_booking_reviews rv
    set status = 'returned', return_reason = v_reason, reviewed_by = (select auth.uid()), reviewed_at = now(),
        row_version = rv.row_version + 1, updated_at = now()
    where rv.id = v_review.id
    returning * into v_review;
  end if;

  v_result := jsonb_build_object('outcome', 'updated', 'id', v_review.id, 'status', 'returned', 'rowVersion', v_review.row_version);
  perform authz.finance_remember(v_ver.legal_entity_id, p_request_id, 'accounts_review_return', v_payload, v_result);
  perform authz.write_audit('finance.review_returned', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id,
    v_reason, jsonb_build_object('reviewId', v_review.id));
  return v_result;
end;
$$;

-- ===========================================================================
-- 3. Accounts Deal detail (replaces 20261124000120; + canReturn, returnBlock)
-- ===========================================================================

create or replace function public.accounts_deal_detail(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_policy public.finance_policy_versions%rowtype;
  v_entity uuid;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  v_entity := v_deal.legal_entity_id;
  -- Not found and not visible look the same.
  if v_deal.id is null or not authz.holds_active_role('accounts', v_entity) or authz.holds_role('purchase', v_entity) then
    return null;
  end if;
  perform authz.finance_require_accounts(v_entity, v_deal.is_synthetic);
  v_policy := authz.finance_policy_at(v_entity, now());

  return jsonb_build_object(
    'dealId', v_deal.id,
    'dealReference', v_deal.reference,
    'dealTitle', v_deal.title,
    'legalEntityId', v_entity,
    'branchId', v_deal.branch_id,
    'branchName', (select b.name from public.branches b where b.id = v_deal.branch_id),
    'isSynthetic', v_deal.is_synthetic,
    'booking', (
      select jsonb_build_object(
        'bookingVersionId', v.id,
        'versionNo', v.version_no,
        'hotelName', v.hotel_name,
        'city', v.city,
        'checkIn', to_char(v.check_in, 'YYYY-MM-DD'),
        'checkOut', to_char(v.check_out, 'YYYY-MM-DD'),
        'rooms', v.rooms,
        'adults', v.adults,
        'children', v.children,
        'sellingTotalPaise', c.selling_total_paise::text,
        'confirmedAt', v.confirmed_at,
        'confirmedByName', authz.finance_name(v.confirmed_by),
        'reviewStatus', coalesce(rv.status, 'pending'),
        'reviewRowVersion', coalesce(rv.row_version, 0),
        -- Kept in history; shown only while the review is returned.
        'returnReason', case when rv.status = 'returned' then rv.return_reason end,
        'reviewedByName', authz.finance_name(rv.reviewed_by),
        'reviewedAt', rv.reviewed_at,
        'canApprove', authz.finance_approve_block(v.id) is null,
        'approveBlock', authz.finance_approve_block(v.id),
        -- Accounts phase (20261203000110): no return after commitment or tickets (H6).
        'canReturn', coalesce(rv.status, 'pending') <> 'returned' and authz.deal_return_blocked(v.deal_id) is null,
        'returnBlock', authz.deal_return_blocked(v.deal_id),
        -- B1.1 (DEC-29): what Accounts reviews with the booking.
        'serviceType', v.service_type,
        'listPricePaise', c.list_price_paise::text,
        'discountPaise', c.discount_paise::text,
        -- Booking form: the selling side of per-person prices (review A M1: never purchase or markup).
        'prices', authz.bf_prices_sale_json(v.id),
        'paymentPlan', (
          select jsonb_build_object(
            'instalments', jsonb_agg(jsonb_build_object(
                'seq', i.seq, 'label', i.label, 'amountPaise', i.amount_paise::text,
                'dueDate', to_char(i.due_date, 'YYYY-MM-DD'))
              order by i.seq),
            'totalPaise', sum(i.amount_paise)::text,
            'matchesSellingTotal', c.selling_total_paise is not null and sum(i.amount_paise) = c.selling_total_paise)
          from public.booking_version_instalments i
          where i.booking_version_id = v.id
          having count(*) > 0),
        'services', case when v.service_type = 'package' then coalesce((
          select jsonb_agg(jsonb_build_object('itemNo', s.item_no, 'serviceType', s.service_type) order by s.item_no)
          from public.service_items s
          where exists (select 1 from public.service_item_facts f
                        where f.service_item_id = s.id and f.booking_version_id = v.id)), '[]'::jsonb)
          else '[]'::jsonb end,
        'contact', (
          select jsonb_build_object(
            'name', k.contact_name, 'mobile', k.mobile, 'email', k.email, 'bookingFor', k.booking_for,
            'payerName', k.payer_name)
          from public.booking_version_contacts k where k.booking_version_id = v.id),
        -- B1.1 revision (freeze note 3.1): what changed against the returned version.
        'revision', case when v.revises_version_id is not null then jsonb_build_object(
          'revisesVersionNo', (select b.version_no from public.booking_versions b where b.id = v.revises_version_id),
          'changeClass', v.change_class,
          'changedFields', to_jsonb(coalesce(v.changed_fields, '{}'::text[])),
          'sellingDeltaPaise', (c.selling_total_paise - (select cb.selling_total_paise from public.booking_version_commercials cb
                                                        where cb.version_id = v.revises_version_id))::text) end,
        'earlierVersions', coalesce((
          select jsonb_agg(jsonb_build_object('versionNo', e.version_no, 'reviewStatus', coalesce(er.status, 'pending'),
              'returnReason', case when er.status = 'returned' then er.return_reason end) order by e.version_no)
          from public.booking_versions e
          left join public.accounts_booking_reviews er on er.booking_version_id = e.id
          where e.deal_id = v.deal_id and e.status = 'superseded'), '[]'::jsonb))
      from public.booking_versions v
      left join public.booking_version_commercials c on c.version_id = v.id
      left join public.accounts_booking_reviews rv on rv.booking_version_id = v.id
      where v.id = authz.current_accepted_version(v_deal.id)),
    'billing', (
      select jsonb_build_object(
        'billingName', bp.billing_name,
        'addressLine1', bp.address_line1,
        'addressLine2', bp.address_line2,
        'city', bp.city,
        'stateCode', bp.state_code,
        'postalCode', bp.postal_code,
        'gstin', bp.gstin,
        'status', bp.status,
        'rowVersion', bp.row_version,
        'updatedByName', authz.finance_name(bp.updated_by),
        'updatedAt', bp.updated_at,
        'verifiedByName', authz.finance_name(bp.verified_by),
        'verifiedAt', bp.verified_at,
        'prefillSource', bp.prefill_source,
        -- Booking form: Bill To.
        'billToType', bp.bill_to_type, 'contactPerson', bp.contact_person, 'phone', bp.phone, 'email', bp.email,
        'gstStatus', bp.gst_status, 'gstReason', bp.gst_reason)
      from public.customer_billing_profiles bp where bp.deal_id = v_deal.id),
    'money', authz.finance_money_json(v_deal.id),
    'receipts', coalesce((
      select jsonb_agg(authz.finance_receipt_json(r.id) order by r.recorded_at desc, r.receipt_no desc)
      from public.customer_receipts r where r.deal_id = v_deal.id), '[]'::jsonb),
    'liveModes', (
      select jsonb_build_object('bank_transfer', s.bank_transfer_live, 'upi', s.upi_live, 'cash', s.cash_live,
        'cheque', s.cheque_live)
      from public.finance_live_settings s where s.legal_entity_id = v_entity),
    'modesAllowed', jsonb_build_object(
      'bank_transfer', authz.finance_mode_allowed(v_entity, 'bank_transfer'),
      'upi', authz.finance_mode_allowed(v_entity, 'upi'),
      'cash', authz.finance_mode_allowed(v_entity, 'cash'),
      'cheque', authz.finance_mode_allowed(v_entity, 'cheque')),
    'branches', coalesce((
      select jsonb_agg(jsonb_build_object('id', b.id, 'name', b.name) order by b.is_head_office desc, b.name)
      from public.branches b where b.legal_entity_id = v_entity and b.status = 'enabled'), '[]'::jsonb),
    'collectors', coalesce((
      select jsonb_agg(jsonb_build_object('userId', p.user_id, 'name', p.display_name) order by p.display_name, p.user_id)
      from public.staff_profiles p
      where p.status = 'active' and exists (
        select 1 from public.memberships m
        where m.user_id = p.user_id and m.legal_entity_id = v_entity and m.status = 'active')), '[]'::jsonb),
    'policy', authz.finance_policy_json(v_policy.id),
    -- B1.1b: Sales-reported payments, newest first. Never money.
    'claims', coalesce((
      select jsonb_agg(authz.finance_claim_accounts_json(x.id) order by x.reported_at desc, x.id)
      from public.customer_payment_claims x where x.deal_id = v_deal.id), '[]'::jsonb),
    'claimsReportedPaise', (select coalesce(sum(x.amount_paise), 0)::text from public.customer_payment_claims x
                            where x.deal_id = v_deal.id and x.status in ('reported', 'linked')));
end;
$$;

commit;
