-- TripNavigate CRM - Accounts phase 3, lead fix-forward to track B: the Sales
-- "Still to pay (based on checked money)" figure follows an approved write-off.
-- Contract: accounts-phase3-2026-11-12/contract.md section 6.6 (effect: the
-- balance becomes zero), 21 LD15 (the adjusted total).
--
-- Defect: after an approved 'due' write-off, deal_dues showed a zero balance
-- but the Deal page Money tab (deal_payment_claims.balancePaise) still showed
-- the written-off amount as "Still to pay".
--
-- Replaced (latest body re-confirmed with the sorted grep; same signature,
-- same keys; changed lines marked "Accounts phase 3 (20261205000250)"):
--   public.deal_payment_claims (20261119000200:863): balancePaise = selling
--     total - an approved 'due' write-off + an approved 'excess' write-off -
--     confirmed money. sellingTotalPaise and every other key are unchanged;
--     with no approved write-off the result is identical. Readers unchanged
--     (the Deal owner's Sales projection; never Purchase, Flight or Visa).
--   Grants are kept by create or replace (authenticated only).
--
-- Refusal tokens: none new.
-- Rollback (forward-only): a NEW migration restoring the 20261119000200 body.

begin;
set local lock_timeout = '15s';

create or replace function public.deal_payment_claims(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_version uuid;
  v_total bigint;
  v_confirmed bigint;
  v_block text;
  -- Accounts phase 3 (20261205000250)
  v_wo_due bigint;
  v_wo_excess bigint;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_deal_id is null or not authz.finance_claim_sales_ok(p_deal_id) then
    return null;
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  v_version := authz.finance_claim_version(v_deal.id);
  select c.selling_total_paise into v_total from public.booking_version_commercials c where c.version_id = v_version;
  v_confirmed := (authz.finance_money_json(v_deal.id) ->> 'availablePaise')::bigint;
  -- Accounts phase 3 (20261205000250): approved write-offs of the Deal (due: minus; excess: plus).
  select coalesce(sum(w.amount_paise) filter (where w.direction = 'due'), 0)::bigint,
         coalesce(sum(w.amount_paise) filter (where w.direction = 'excess'), 0)::bigint
    into v_wo_due, v_wo_excess
  from public.deal_write_offs w where w.deal_id = v_deal.id and w.status = 'approved';
  v_block := case
    when authz.finance_gate_issue(v_deal.legal_entity_id, v_deal.is_synthetic) is not null then 'finance_not_ready'
    when not authz.service_items_enabled() then 'service_items_disabled'
    when authz.deal_not_active(v_deal.id) then 'deal_not_active'
    when v_version is null then 'no_booking'
    else null end;

  return jsonb_build_object(
    'dealId', v_deal.id,
    'sellingTotalPaise', v_total::text,
    'reportedPaise', (select coalesce(sum(c.amount_paise), 0)::text from public.customer_payment_claims c
                      where c.deal_id = v_deal.id and c.status in ('reported', 'linked')),
    'confirmedPaise', v_confirmed::text,
    -- Accounts phase 3 (20261205000250, LD15): the adjusted total (an approved write-off).
    'balancePaise', (v_total - v_wo_due + v_wo_excess - v_confirmed)::text,
    'canReport', v_block is null,
    'reportBlock', v_block,
    'destinations', case when v_block is not null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
          'versionId', v.id, 'kind', d.kind, 'label', d.label, 'bankName', v.bank_name,
          'accountMasked', authz.destination_mask_account(v.account_number),
          'upiMasked', authz.destination_mask_upi(v.upi_id))
        order by d.kind, lower(d.label), d.id)
      from public.company_destinations d
      join public.company_destination_versions v on v.id = d.current_version_id
      where d.legal_entity_id = v_deal.legal_entity_id and d.retired_at is null and v.status = 'approved'
        and d.is_synthetic = v_deal.is_synthetic), '[]'::jsonb) end,
    'claims', coalesce((
      select jsonb_agg(authz.finance_claim_sales_json(c.id) order by c.reported_at desc, c.id)
      from public.customer_payment_claims c where c.deal_id = v_deal.id), '[]'::jsonb));
end;
$$;

commit;
