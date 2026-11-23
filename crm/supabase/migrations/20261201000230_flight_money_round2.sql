-- Flight build, Track B (4): integration fixes after Track C's wiring.
-- Contract: flight build contract (frozen 4 Nov 2026) sections 6.2, 9.3, R9.
--
--   * public.flight_fare_approval_sets(uuid): the exact fare set of every
--     pending or approved fare approval of a Deal (sectors, supplier,
--     travellers with their type, per type: basic, K, YQ, YR, other,
--     markup/discount on flight-only Deals, passenger count), so the Confirm
--     tickets popup can show the fares the Manager approved after a reload.
--     Same fence as flight_money's approvals: Flight of the entity, the
--     branch Manager and Accounts (never a holder of Purchase); null for
--     everyone else. No PNRs or ticket numbers exist in an approval.
--   * public.supplier_update (replaces 20261005000200): Purchase can no
--     longer change a supplier that serves flights (Flight owns those
--     suppliers; retyping one would drop it from Flight's list). Refusal
--     not_authorized; every other supplier exactly as before.
--
-- Rollback (forward-only): a NEW migration restoring supplier_update from
-- 20261005000200 and revoking flight_fare_approval_sets.

begin;
set local lock_timeout = '15s';

create function public.flight_fare_approval_sets(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null
     or not exists (select 1 from public.fulfilment_tasks t where t.deal_id = v_deal.id and t.department = 'flight')
     or not (authz.holds_active_role('flight', v_deal.legal_entity_id)
             or (authz.is_branch_sales_manager(v_deal.id) and not authz.holds_role('purchase', v_deal.legal_entity_id))
             or (authz.can_accounts(v_deal.legal_entity_id) and not authz.holds_role('purchase', v_deal.legal_entity_id)
                 and authz.finance_gate_issue(v_deal.legal_entity_id, v_deal.is_synthetic) is null)) then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'approvalId', a.id,
      'approvalNo', a.approval_no,
      'status', a.status,
      'rowVersion', a.row_version,
      'fareHash', a.fare_hash,
      'supplierId', a.payload ->> 'supplierId',
      'supplierName', s.name,
      'sectorIds', coalesce(a.payload -> 'sectorIds', '[]'::jsonb),
      'travellers', coalesce(a.payload -> 'travellers', '[]'::jsonb),
      'fares', coalesce((
        select jsonb_agg(jsonb_build_object(
            'paxType', f ->> 'paxType',
            'basicPaise', f ->> 'basicPaise',
            'kPaise', f ->> 'kPaise',
            'yqPaise', f ->> 'yqPaise',
            'yrPaise', f ->> 'yrPaise',
            'otherPaise', f ->> 'otherPaise',
            'paxCount', (select count(*) from jsonb_array_elements(a.payload -> 'travellers') t
                         where t ->> 'type' = f ->> 'paxType'))
          -- Markup and discount exist only on flight-only Deals (null in package payloads).
          || case when f ->> 'markupPaise' is not null then jsonb_build_object(
               'markupPaise', f ->> 'markupPaise', 'discountPaise', f ->> 'discountPaise') else '{}'::jsonb end
          order by f ->> 'paxType')
        from jsonb_array_elements(a.payload -> 'fares') f), '[]'::jsonb)) order by a.approval_no desc)
    from public.flight_fare_approvals a
    left join public.suppliers s on s.id::text = a.payload ->> 'supplierId'
    where a.deal_id = v_deal.id and a.status in ('pending', 'approved')), '[]'::jsonb);
end;
$$;

revoke all on function public.flight_fare_approval_sets(uuid) from public, anon, authenticated, service_role;
grant execute on function public.flight_fare_approval_sets(uuid) to authenticated;

-- Replaces 20261005000200: suppliers serving flights are refused (R9).
create or replace function public.supplier_update(p_supplier_id uuid, p_expected_row_version integer, p_fields jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_s public.suppliers%rowtype;
  v_name text;
  v_status text;
  v_types text[];
  v_city text;
  v_contact text;
  v_phone text;
  v_email text;
  v_terms text;
  v_details_changed boolean;
  v_reset boolean;
  v_changed text[];
begin
  select * into v_s from public.suppliers s where s.id = p_supplier_id for update;
  if v_s.id is null or not authz.can_manage_suppliers(v_s.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Flight build (20261201000230): Flight owns its airline/consolidator suppliers.
  if 'flight' = any (v_s.service_types) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v_s.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  perform authz.supplier_fields_check(p_fields);
  v_name := authz.booking_fact_text(p_fields, 'name', 200, false);
  v_status := coalesce(authz.booking_fact_text(p_fields, 'status', 20, false), v_s.status);
  if v_name is null or v_status not in ('active', 'archived') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if exists (select 1 from public.suppliers s
             where s.legal_entity_id = v_s.legal_entity_id and lower(s.name) = lower(v_name) and s.id <> v_s.id) then
    raise exception 'supplier_exists' using errcode = '23505';
  end if;
  v_types := authz.supplier_service_types(p_fields);
  v_city := authz.booking_fact_text(p_fields, 'city', 120, false);
  v_contact := authz.booking_fact_text(p_fields, 'contactName', 120, false);
  v_phone := authz.booking_fact_text(p_fields, 'contactPhone', 40, false);
  v_email := authz.booking_fact_text(p_fields, 'contactEmail', 254, false);
  v_terms := authz.booking_fact_text(p_fields, 'paymentTerms', 1000, true);
  v_details_changed := (v_name, v_types, v_city, v_contact, v_phone, v_email, v_terms)
    is distinct from (v_s.name, v_s.service_types, v_s.city, v_s.contact_name, v_s.contact_phone, v_s.contact_email,
                      v_s.payment_terms);
  v_reset := v_details_changed and v_s.verification_status = 'verified';

  begin
    update public.suppliers s set
      name = v_name,
      service_types = v_types,
      city = v_city,
      contact_name = v_contact,
      contact_phone = v_phone,
      contact_email = v_email,
      payment_terms = v_terms,
      status = v_status,
      verification_status = case when v_details_changed then 'unverified' else s.verification_status end,
      verified_by = case when v_details_changed then null else s.verified_by end,
      verified_at = case when v_details_changed then null else s.verified_at end,
      row_version = s.row_version + 1,
      updated_by = case when v_details_changed then (select auth.uid()) else s.updated_by end,
      updated_at = now()
    where s.id = v_s.id
    returning * into v_s;
  exception
    when unique_violation then
      raise exception 'supplier_exists' using errcode = '23505';
    when check_violation then
      raise exception 'invalid_input' using errcode = '22023';
  end;

  -- Field names only; contact values are not copied into the audit trail.
  select coalesce(array_agg(k order by k), '{}') into v_changed from jsonb_object_keys(p_fields) k;
  perform authz.write_audit('supplier.updated', v_s.legal_entity_id, null, 'supplier', v_s.id, null,
    jsonb_build_object('fields', to_jsonb(v_changed), 'rowVersion', v_s.row_version, 'status', v_s.status,
      'detailsChanged', v_details_changed, 'verificationReset', v_reset));
  return jsonb_build_object('supplierId', v_s.id, 'rowVersion', v_s.row_version);
end;
$$;

commit;
