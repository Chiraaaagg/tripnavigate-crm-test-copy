-- TripNavigate CRM - Book now v2, review round 1 (26 October 2026): the
-- older item save and the quotation item rule.
--
-- Rulings: docs/implementation/booking-form-v2-2026-10-26/contract.md,
-- "Review round 1 rulings".
--
-- What changes (same signatures; lines marked BF2):
--   1. public.service_item_save (replaces 20261118000100): a budget that
--      changes through this command is a typed budget, so the automatic
--      budget flag (owner decision D2, 20261129000100) is cleared.
--      booking_service_save sets the flag again afterwards when it applies.
--   2. authz.quotation_item_facts (replaces 20261120000200): quotation items
--      refuse the Book now v2-only keys (flight entryMode, screenshotNote,
--      requestItems, isReturn; hotel requestItems; car flightItemId). They
--      belong to a booking draft only.
--
-- Rollback (forward-only): a NEW migration restoring the previous bodies.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Item save (replaces 20261118000100; line marked BF2)
-- ===========================================================================

create or replace function public.service_item_save(
  p_item_id uuid, p_version_id uuid, p_expected_row_version integer, p_facts jsonb, p_purchase_budget_paise bigint
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_item public.service_items%rowtype;
  v_facts jsonb;
  v_bad text[];
begin
  v_ver := authz.lock_package_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  select i.* into v_item from public.service_items i where i.id = p_item_id and i.deal_id = v_ver.deal_id for update;
  if v_item.id is null or not exists (
       select 1 from public.service_item_facts f where f.service_item_id = v_item.id and f.booking_version_id = v_ver.id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_purchase_budget_paise is null or p_purchase_budget_paise < 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'purchaseBudgetPaise';
  end if;
  v_facts := authz.normalize_service_facts(p_facts);
  v_bad := authz.validate_service_facts(v_item.service_type, v_facts);
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;

  update public.service_item_facts f
  set facts = v_facts, purchase_budget_paise = p_purchase_budget_paise, updated_at = now(),
      -- BF2: a budget changed here is a typed budget (D2 flag cleared).
      purchase_budget_auto = f.purchase_budget_auto and f.purchase_budget_paise = p_purchase_budget_paise
  where f.service_item_id = v_item.id and f.booking_version_id = v_ver.id;
  v_ver := authz.bump_package_version(v_ver.id);

  perform authz.write_audit('booking.service_item_saved', v_ver.legal_entity_id, v_ver.branch_id,
    'service_item', v_item.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no,
      'itemNo', v_item.item_no, 'serviceType', v_item.service_type, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;

-- ===========================================================================
-- 2. Quotation item rule (replaces 20261120000200; lines marked BF2)
-- ===========================================================================

create or replace function authz.quotation_item_facts(p_type text, p_tier text, p_facts jsonb, p_version uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_facts jsonb;
  v_bad text[];
begin
  if p_type = 'train' then
    raise exception 'service_on_hold' using errcode = '22023';
  end if;
  if p_tier is not null and (p_tier not in ('quoted', 'upgrade') or not exists (
       select 1 from public.quotation_version_tiers t where t.quotation_version_id = p_version and t.tier_key = p_tier)) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'tierKey';
  end if;
  v_facts := authz.normalize_service_facts(p_facts);
  v_bad := authz.validate_service_facts(p_type, v_facts);
  -- BF2: keys of a booking draft only (Book now v2), never on a quotation.
  if jsonb_typeof(v_facts) = 'object' then
    v_bad := v_bad || array(select k from jsonb_object_keys(v_facts) k
                            where (p_type = 'flight' and k in ('entryMode', 'screenshotNote', 'requestItems', 'isReturn'))
                               or (p_type = 'hotel' and k = 'requestItems')
                               or (p_type = 'transfer' and k = 'flightItemId'));
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  return v_facts;
end;
$$;

commit;
