-- TripNavigate CRM - Book now v2 (owner-approved prototype, 26 October 2026),
-- part 3: readiness and reads.
--
-- Frozen contract: docs/implementation/booking-form-v2-2026-10-26/contract.md
-- and build-plan.md section 5.2 (Agent B).
--
-- What changes (every replaced function keeps its signature; lines marked BF2):
--   1. authz.bf2_screenshot_missing_nos (new): screenshot flights of a version
--      with no stored screenshot (files belong to the item).
--   2. authz.bf_form_codes (replaces 20261124000120): + the blocking code
--      flight_screenshot_missing ("Flight {n}: attach at least one
--      screenshot, or type the details."). Readiness (authz.booking_issues)
--      and booking_confirm therefore refuse such a draft.
--   3. public.intake_checklist (replaces 20261124000120): the new code with
--      its item numbers; owner decision D2: budget_missing no longer fires for
--      drafts of the booking form (form rules 2), whose budget comes from the
--      estimate; older drafts keep the warning.
--   4. authz.bf_estimate_json (replaces 20261124000120): + the fare per person.
--   5. authz.bf2_flight_fare_totals_json (new) and authz.flight_task_json
--      (replaces 20261124000120): the Flight assignee also receives
--      'fareTotals' (typed total fare per person of all flights; cost side).
--   6. public.booking_form_get (replaces 20261128000130): + 'flightFareTotals'
--      (commercial readers only), 'bitrixDealHref' (the Deal's page in
--      Bitrix, from the intake configuration; null for a Deal not from Bitrix)
--      and 'idProofCopyApplies' (the ID-proof copy to Bitrix would run for an
--      upload now); items carry the Purchase budget for commercial readers only.
--
-- Never: Purchase never receives fares, selling price, margin or payment
-- proof (authz.purchase_task_json is unchanged).
--
-- Rollback (forward-only): a NEW migration restoring the previous bodies.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Screenshot flights without a stored screenshot
-- ===========================================================================

create function authz.bf2_screenshot_missing_nos(p_version uuid) returns integer[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(i.item_no order by i.item_no), '{}'::integer[])
  from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
  where f.booking_version_id = p_version and i.service_type = 'flight' and i.state <> 'cancelled'
    and f.facts ->> 'entryMode' = 'screenshot'
    and not exists (select 1 from public.service_item_files x
                    where x.service_item_id = i.id and x.kind = 'flight_screenshot' and x.status = 'stored')
$$;

-- ===========================================================================
-- 2. Form codes (replaces 20261124000120; lines marked BF2)
-- ===========================================================================

create or replace function authz.bf_form_codes(p_version uuid) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.booking_versions%rowtype;
  v_required boolean;
  v_in_use boolean;
  v_adults integer;
  v_hotels boolean;
  v_cov jsonb;
  v_q jsonb;
begin
  select * into v from public.booking_versions x where x.id = p_version;
  if v.id is null or v.service_type <> 'package' then
    return '{}'::text[];
  end if;
  v_required := authz.bf_lines_required(v.id);
  v_in_use := authz.prices_in_use(v.id);
  v_adults := v.pax_total - coalesce(v.children_count, 0) - coalesce(v.infants_count, 0);
  select coalesce(jsonb_object_agg(l.category, l.quantity), '{}'::jsonb) into v_q
  from public.booking_version_price_lines l where l.booking_version_id = v.id;
  v_hotels := exists (select 1 from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
                      where f.booking_version_id = v.id and i.service_type = 'hotel' and i.state <> 'cancelled');
  if v.form_rules = 2 and v_hotels then
    v_cov := authz.bf_hotel_coverage(v.id);
  end if;
  return array_remove(array[
    case when v.form_rules = 2 and v.pax_total is null then 'pax_missing' end,
    case when v.form_rules = 2 and v.pax_total is not null and (
           (select count(*) from public.deal_travellers t where t.deal_id = v.deal_id) > v.pax_total
           or (select count(*) from public.deal_travellers t where t.deal_id = v.deal_id and t.traveller_type = 'adult') > v_adults
           or (select count(*) from public.deal_travellers t where t.deal_id = v.deal_id and t.traveller_type = 'child')
              > coalesce(v.children_count, 0)
           or (select count(*) from public.deal_travellers t where t.deal_id = v.deal_id and t.traveller_type = 'infant')
              > coalesce(v.infants_count, 0)) then 'pax_types_exceeded' end,
    case when (v_required and not v_in_use)
           or (v_in_use and exists (select 1 from public.booking_version_price_lines l
                                    where l.booking_version_id = v.id and l.quantity > 0 and l.sale_paise is null))
      then 'price_missing' end,
    -- Review A L2: only once a line exists (price_missing covers an empty table).
    case when (v_required or v_in_use) and v.pax_total is not null and v_q <> '{}'::jsonb and (
           coalesce((v_q ->> 'adult')::integer, 0) <> v_adults
           or coalesce((v_q ->> 'infant')::integer, 0) <> coalesce(v.infants_count, 0)
           or coalesce((v_q ->> 'child_bed')::integer, 0) + coalesce((v_q ->> 'child_no_bed')::integer, 0)
              <> coalesce(v.children_count, 0)) then 'price_count_mismatch' end,
    case when exists (select 1 from public.booking_version_price_lines l
                      where l.booking_version_id = v.id and l.quantity > 0 and l.markup_paise < 0)
      then 'price_below_purchase' end,
    case when v_cov is not null and coalesce((v_cov ->> 'nights')::integer, 0) > 0
          and jsonb_array_length(v_cov -> 'missing') > 0 then 'hotel_nights_missing' end,
    case when v_cov is not null and jsonb_array_length(v_cov -> 'outside') > 0 then 'hotel_outside_trip' end,
    case when v.form_rules = 2 and v_hotels and v.trip_start is not null and v.trip_start = v.trip_end
      then 'hotel_same_day_trip' end,
    case when v.form_rules = 2 and cardinality(authz.bf_dates_outside_nos(v.id)) > 0 then 'service_dates_outside_trip' end,
    -- BF2: a screenshot flight needs at least one stored screenshot.
    case when cardinality(authz.bf2_screenshot_missing_nos(v.id)) > 0 then 'flight_screenshot_missing' end
  ], null);
end;
$$;

-- ===========================================================================
-- 3. Checklist (replaces 20261124000120; lines marked BF2)
-- ===========================================================================

create or replace function public.intake_checklist(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ver public.booking_versions;
  v_items jsonb := '[]'::jsonb;
  v_needed integer := 0;
  v_travellers integer := 0;
  v_nos integer[];
  v_seqs integer[];
  v_text text;
  v_contact public.booking_version_contacts;
  v_billing public.customer_billing_profiles;
  v_total bigint;
  v_plan bigint;
  v_commercial boolean;
  v_form text[];  -- booking form
begin
  -- Booking readers who hold no department role (review E1).
  if p_deal_id is null or not authz.can_read_service_rows(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_ver := authz.deal_current_version(p_deal_id);
  if v_ver.service_type is distinct from 'package' then
    v_ver := null;
  end if;

  -- B1.1 revision: a revision needs neither the trigger stage nor (for
  -- format-only and internal-only changes) a new acceptance message.
  if v_ver.revises_version_id is null and not authz.deal_in_trigger_stage(p_deal_id) then
    v_items := v_items || jsonb_build_object('code', 'stage_not_confirmed', 'blocking', true, 'owner', 'bitrix', 'itemNos', '[]'::jsonb);
  end if;
  if v_ver.id is null or not exists (select 1 from public.service_item_facts f where f.booking_version_id = v_ver.id) then
    v_items := v_items || jsonb_build_object('code', 'no_services', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
  end if;
  -- B1.1: customer, billing and trip.
  select * into v_billing from public.customer_billing_profiles b where b.deal_id = p_deal_id;
  if v_ver.id is not null then
    select * into v_contact from public.booking_version_contacts c where c.booking_version_id = v_ver.id;
    if v_contact.booking_version_id is null then
      v_items := v_items || jsonb_build_object('code', 'contact_missing', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
    elsif not v_contact.contact_confirmed then
      v_items := v_items || jsonb_build_object('code', 'contact_not_confirmed', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
    end if;
    if v_billing.deal_id is null then
      v_items := v_items || jsonb_build_object('code', 'billing_missing', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
    end if;
    -- Booking form: Bill To codes (gstin_missing keeps today's rule for profiles saved before it).
    v_items := v_items || coalesce((
      select jsonb_agg(jsonb_build_object('code', x, 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb) order by n)
      from unnest(authz.bf_billing_codes(p_deal_id, v_ver.id)) with ordinality as u(x, n)
      where x <> 'billing_missing'), '[]'::jsonb);
    if v_ver.trip_destination is null or v_ver.trip_scope is null or v_ver.trip_start is null or v_ver.trip_end is null then
      v_items := v_items || jsonb_build_object('code', 'trip_missing', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
    end if;
  end if;
  if v_ver.id is not null and (v_ver.revises_version_id is null or v_ver.change_class = 'customer_material') and not exists (
       select 1 from public.booking_evidence e
       where e.version_id = v_ver.id and e.kind = 'acceptance_message' and e.status = 'stored')
     -- B1.2: a draft converted from an accepted quotation carries the customer's written acceptance.
     and not (v_ver.revises_version_id is null and authz.booking_quote_acceptance_ok(v_ver.id)) then
    v_items := v_items || jsonb_build_object('code', 'acceptance_missing', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
  end if;
  if v_ver.revises_version_id is not null then
    if cardinality(authz.revision_changed_fields(v_ver.id)) = 0 then
      v_items := v_items || jsonb_build_object('code', 'no_changes', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
    elsif v_ver.change_class is null or v_ver.changed_fields is distinct from authz.revision_changed_fields(v_ver.id)
          or not (v_ver.change_class = any (authz.revision_allowed_classes(authz.revision_changed_fields(v_ver.id)))) then
      -- Review R1: missing, stale or no longer allowed.
      v_items := v_items || jsonb_build_object('code', 'revision_class_missing', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
    end if;
  end if;
  if v_ver.id is not null then
    v_needed := authz.version_travellers_needed(v_ver.id);
  end if;
  select count(*) into v_travellers from public.deal_travellers t where t.deal_id = p_deal_id;
  if v_travellers < v_needed then
    v_items := v_items || jsonb_build_object('code', 'traveller_missing', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
  end if;
  if exists (select 1 from public.deal_travellers t where t.deal_id = p_deal_id and btrim(t.full_name, E' \t\r\n') = '') then
    v_items := v_items || jsonb_build_object('code', 'traveller_name_incomplete', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
  end if;
  -- B1.1: child ages.
  select coalesce(array_agg(t.seq order by t.seq), '{}'::integer[]) into v_seqs
  from public.deal_travellers t where t.deal_id = p_deal_id and t.traveller_type in ('child', 'infant') and t.age_years is null;
  if cardinality(v_seqs) > 0 then
    v_items := v_items || jsonb_build_object('code', 'child_age_missing', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb,
      'travellerSeqs', to_jsonb(v_seqs));
  end if;
  -- B1.2 (DEC-38): travellers without a stored identity proof. Adults block
  -- submission; children and infants are a warning. Package drafts only (a
  -- confirmed version is not re-checked).
  if v_ver.status = 'draft' then
  select coalesce(array_agg(t.seq order by t.seq), '{}'::integer[]) into v_seqs
  from public.deal_travellers t
  where t.deal_id = p_deal_id and t.traveller_type = 'adult'
    and not exists (select 1 from public.traveller_id_proofs f where f.traveller_id = t.id and f.status = 'stored');
  if cardinality(v_seqs) > 0 then
    v_items := v_items || jsonb_build_object('code', 'id_proof_missing', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb,
      'travellerSeqs', to_jsonb(v_seqs));
  end if;
  select coalesce(array_agg(t.seq order by t.seq), '{}'::integer[]) into v_seqs
  from public.deal_travellers t
  where t.deal_id = p_deal_id and t.traveller_type in ('child', 'infant')
    and not exists (select 1 from public.traveller_id_proofs f where f.traveller_id = t.id and f.status = 'stored');
  if cardinality(v_seqs) > 0 then
    v_items := v_items || jsonb_build_object('code', 'id_proof_missing_child', 'blocking', false, 'owner', 'sales', 'itemNos', '[]'::jsonb,
      'travellerSeqs', to_jsonb(v_seqs));
  end if;
  end if;
  -- B1.2 0600: values taken from Bitrix and not yet checked (warning only).
  -- Batch 2 (F.2 item 4): kept still counts until a genuine check.
  if v_ver.id is not null and v_ver.status = 'draft' and exists (
       select 1 from public.prefill_marks m
       where m.target_kind = 'booking_version' and m.target_id = v_ver.id and m.state in ('from_bitrix', 'kept')) then
    v_items := v_items || jsonb_build_object('code', 'prefill_unchecked', 'blocking', false, 'owner', 'sales', 'itemNos', '[]'::jsonb,
      'fields', (select jsonb_agg(m.field_code order by m.field_code) from public.prefill_marks m
                 where m.target_kind = 'booking_version' and m.target_id = v_ver.id and m.state in ('from_bitrix', 'kept')));
  end if;
  -- B1.2 (freeze part 2 section 2.8/2.9): changes since the quotation was converted.
  if v_ver.id is not null then
    if authz.booking_quote_change(v_ver.id) = 'stale' then
      v_items := v_items || jsonb_build_object('code', 'quote_acceptance_stale', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
    elsif authz.booking_quote_change(v_ver.id) = 'details' then
      v_items := v_items || jsonb_build_object('code', 'quote_details_changed', 'blocking', false, 'owner', 'sales', 'itemNos', '[]'::jsonb);
    end if;
    -- Review E5-6: named travellers differ from the accepted party (warning while typing;
    -- readiness blocks with quote_acceptance_stale).
    if authz.booking_quote_party_stale(v_ver.id) then
      v_items := v_items || jsonb_build_object('code', 'quote_party_differs', 'blocking', false, 'owner', 'sales', 'itemNos', '[]'::jsonb);
    end if;
  end if;
  if v_ver.id is not null then
    v_nos := authz.service_item_invalid_nos(v_ver.id);
    if cardinality(v_nos) > 0 then
      v_items := v_items || jsonb_build_object('code', 'service_facts_invalid', 'blocking', true, 'owner', 'sales', 'itemNos', to_jsonb(v_nos));
    end if;
    -- B1.1: participation and identity.
    v_nos := authz.b11_participation_missing_nos(v_ver.id);
    if cardinality(v_nos) > 0 then
      v_items := v_items || jsonb_build_object('code', 'participation_missing', 'blocking', true, 'owner', 'sales', 'itemNos', to_jsonb(v_nos));
    end if;
    v_seqs := authz.b11_identity_missing_seqs(v_ver.id);
    if cardinality(v_seqs) > 0 then
      v_items := v_items || jsonb_build_object('code', 'identity_missing', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb,
        'travellerSeqs', to_jsonb(v_seqs));
    end if;
    -- B1.1: selling total and plan.
    select c.selling_total_paise into v_total from public.booking_version_commercials c where c.version_id = v_ver.id;
    select sum(p.amount_paise) into v_plan from public.booking_version_instalments p where p.booking_version_id = v_ver.id;
    -- Review A3: without commercial scope the codes read "ask the owner".
    v_commercial := authz.can_read_deal_commercial(p_deal_id);
    if v_total is null then
      v_items := v_items || jsonb_build_object('code', case when v_commercial then 'selling_total_missing' else 'selling_total_ask_owner' end,
        'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
    end if;
    if v_plan is null or (v_total is not null and v_plan <> v_total) then
      v_items := v_items || jsonb_build_object('code', case when not v_commercial then 'plan_ask_owner'
                                                            when v_plan is null then 'plan_missing' else 'plan_total_mismatch' end,
        'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
    end if;
    -- Booking form (20261124000120): party, prices, hotel nights and service dates.
    v_form := authz.bf_form_codes(v_ver.id);
    if not v_commercial then
      v_form := array_replace(array_replace(array_replace(v_form, 'price_missing', 'prices_ask_owner'),
        'price_count_mismatch', 'prices_ask_owner'), 'price_below_purchase', 'prices_ask_owner');
    end if;
    v_items := v_items || coalesce((
      select jsonb_agg(jsonb_build_object('code', x, 'blocking', true, 'owner', 'sales',
          'itemNos', case x when 'hotel_outside_trip' then to_jsonb(authz.bf_hotel_outside_nos(v_ver.id))
                            when 'service_dates_outside_trip' then to_jsonb(authz.bf_dates_outside_nos(v_ver.id))
                            -- BF2
                            when 'flight_screenshot_missing' then to_jsonb(authz.bf2_screenshot_missing_nos(v_ver.id))
                            else '[]'::jsonb end) order by n)
      from (select x, min(n) as n from unnest(v_form) with ordinality as u(x, n) group by x) s), '[]'::jsonb);
    -- An item whose dates fall more than a day outside the trip dates (when
    -- set), else outside the other items' dates.
    with d as (
      select i.item_no, authz.sf_date(x.d) as day
      from public.service_item_facts f
      join public.service_items i on i.id = f.service_item_id
      cross join lateral (
        select f.facts -> 'checkIn' as d union all select f.facts -> 'checkOut'
        union all select f.facts -> 'date'
        union all select s -> 'date' from jsonb_array_elements(
          case when jsonb_typeof(f.facts -> 'segments') = 'array' then f.facts -> 'segments' else '[]'::jsonb end) s
      ) x
      where f.booking_version_id = v_ver.id and authz.sf_date(x.d) is not null
    )
    select coalesce(array_agg(distinct a.item_no order by a.item_no), '{}'::integer[]) into v_nos
    from d a
    where case when v_ver.trip_start is not null and v_ver.trip_end is not null
      then a.day < v_ver.trip_start - 1 or a.day > v_ver.trip_end + 1
      else exists (select 1 from d b where b.item_no <> a.item_no)
        and (a.day < (select min(b.day) from d b where b.item_no <> a.item_no) - 1
          or a.day > (select max(b.day) from d b where b.item_no <> a.item_no) + 1) end;
    -- Booking form: form-rules-2 drafts block instead (service_dates_outside_trip).
    if cardinality(v_nos) > 0 and v_ver.form_rules = 1 then
      v_items := v_items || jsonb_build_object('code', 'dates_outside_trip', 'blocking', false, 'owner', 'sales', 'itemNos', to_jsonb(v_nos));
    end if;
    select coalesce(array_agg(i.item_no order by i.item_no), '{}'::integer[]) into v_nos
    from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
    where f.booking_version_id = v_ver.id and f.purchase_budget_paise = 0;
    -- BF2 (owner decision D2): booking-form drafts take the budget from the
    -- estimate (no estimate = no budget), so the warning stays for older drafts only.
    if cardinality(v_nos) > 0 and v_ver.form_rules = 1 then
      v_items := v_items || jsonb_build_object('code', 'budget_missing', 'blocking', false, 'owner', 'sales', 'itemNos', to_jsonb(v_nos));
    end if;
    -- B1.1 warnings.
    select coalesce(array_agg(i.item_no order by i.item_no), '{}'::integer[]) into v_nos
    from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
    where f.booking_version_id = v_ver.id
      and authz.service_item_travellers_needed(i.service_type, f.facts) > 0
      and cardinality(authz.item_participant_seqs(i.id, v_ver.id)) > 0
      and cardinality(authz.item_participant_seqs(i.id, v_ver.id)) <> authz.service_item_travellers_needed(i.service_type, f.facts);
    if cardinality(v_nos) > 0 then
      v_items := v_items || jsonb_build_object('code', 'participation_count_mismatch', 'blocking', false, 'owner', 'sales', 'itemNos', to_jsonb(v_nos));
    end if;
    select coalesce(array_agg(s order by s), '{}'::integer[]) into v_seqs
    from unnest(authz.b11_identity_needed_seqs(v_ver.id)) s
    where not exists (select 1 from authz.b11_identity_row(v_ver.id, s) r
                      where r.passport_number is not null and r.passport_expiry is not null);
    if cardinality(v_seqs) > 0 then
      v_items := v_items || jsonb_build_object('code', 'passport_details_later', 'blocking', false, 'owner', 'sales', 'itemNos', '[]'::jsonb,
        'travellerSeqs', to_jsonb(v_seqs));
    end if;
    if v_ver.trip_end is not null then
      select coalesce(array_agg(s order by s), '{}'::integer[]) into v_seqs
      from unnest(authz.b11_identity_needed_seqs(v_ver.id)) s
      where exists (select 1 from authz.b11_identity_row(v_ver.id, s) r where r.passport_expiry <= v_ver.trip_end);
      if cardinality(v_seqs) > 0 then
        v_items := v_items || jsonb_build_object('code', 'passport_expiry_before_trip_end', 'blocking', false, 'owner', 'sales',
          'itemNos', '[]'::jsonb, 'travellerSeqs', to_jsonb(v_seqs));
      end if;
    end if;
    if not authz.visa_passport_tasks_enabled() then
      select coalesce(array_agg(i.item_no order by i.item_no), '{}'::integer[]) into v_nos
      from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
      where f.booking_version_id = v_ver.id and i.service_type in ('visa', 'passport');
      if cardinality(v_nos) > 0 then
        v_items := v_items || jsonb_build_object('code', 'visa_waiting_for_launch', 'blocking', false, 'owner', 'admin', 'itemNos', to_jsonb(v_nos));
      end if;
    end if;
    if v_billing.deal_id is not null and v_billing.status <> 'verified' then
      v_items := v_items || jsonb_build_object('code', 'billing_unverified', 'blocking', false, 'owner', 'accounts', 'itemNos', '[]'::jsonb);
    end if;
    select string_agg(coalesce(f.facts ->> 'notes', '') || ' ' || coalesce(f.facts ->> 'specialRequests', '')
      || ' ' || coalesce(f.facts ->> 'inclusions', ''), ' ') into v_text
    from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
    -- B1.1: a sold visa/passport item's own notes do not count as a mention.
    where f.booking_version_id = v_ver.id and i.service_type not in ('visa', 'passport');
  end if;
  v_text := coalesce(v_text, '') || ' ' || coalesce((select d.title from public.deals d where d.id = p_deal_id), '');
  if v_text ~* '\m(visa|passport|train)\M'
     and not (v_text !~* '\mtrain\M' and v_ver.id is not null and exists (
       select 1 from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
       where f.booking_version_id = v_ver.id and i.service_type in ('visa', 'passport'))) then
    v_items := v_items || jsonb_build_object('code', 'visa_mentioned', 'blocking', false, 'owner', 'sales', 'itemNos', '[]'::jsonb);
  end if;

  return jsonb_build_object(
    'items', v_items,
    'canConfirm', coalesce(v_ver.status = 'draft', false) and authz.can_confirm_booking(p_deal_id)
      and not exists (select 1 from jsonb_array_elements(v_items) e where (e ->> 'blocking')::boolean));
end;
$$;


-- ===========================================================================
-- 4. Estimate read (replaces 20261124000120; lines marked BF2)
-- ===========================================================================

-- Supplier estimate of an item in a version (cost only; null = none stored
-- or a service type without estimates). The caller authorizes.
create or replace function authz.bf_estimate_json(p_item uuid, p_version uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when e.service_item_id is null then null
    else case i.service_type
      when 'hotel' then jsonb_build_object('kind', 'hotel', 'roomRatePaise', e.room_rate_paise::text,
        'extraBedRatePaise', e.extra_bed_rate_paise::text, 'noBedRatePaise', e.no_bed_rate_paise::text)
      when 'transfer' then jsonb_build_object('kind', 'transfer', 'vehicleRatePaise', e.vehicle_rate_paise::text)
      -- BF2: fare per person.
      when 'flight' then jsonb_build_object('kind', 'flight', 'fareTotalPaise', e.fare_total_paise::text,
        'fareAdultPaise', e.fare_adult_paise::text, 'fareChildPaise', e.fare_child_paise::text,
        'fareInfantPaise', e.fare_infant_paise::text)
    end end
  from public.service_items i
  left join public.service_item_cost_estimates e on e.service_item_id = i.id and e.booking_version_id = p_version
  where i.id = p_item
$$;


-- ===========================================================================
-- 5. Flight task (replaces 20261124000120; lines marked BF2)
-- ===========================================================================

-- Typed total fare per person of all flights of a version, or null when none
-- is stored (cost side only; the caller authorizes).
create function authz.bf2_flight_fare_totals_json(p_version uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('adultPaise', x.adult_paise::text, 'childPaise', x.child_paise::text,
    'infantPaise', x.infant_paise::text)
  from public.booking_version_flight_fares x where x.booking_version_id = p_version
$$;

-- Replaces 20261124000120 (line marked BF2): estimate and screenshots for the assignee (booking form).
create or replace function authz.flight_task_json(p_task uuid, p_detail boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'taskId', t.id,
    'dealReference', d.reference,
    'itemTitle', coalesce(nullif(authz.service_item_title('flight', f.facts), ''), 'Flight ' || i.item_no::text),
    'facts', coalesce(f.facts, '{}'::jsonb),
    'purchaseBudgetPaise', coalesce(f.purchase_budget_paise, 0)::text,
    'status', t.status,
    'assigneeName', ap.display_name,
    'assignedToYou', t.assignee_user_id is not distinct from (select auth.uid()),
    'branchName', b.name,
    'createdAt', t.created_at,
    'supplierConfirmedAt', t.supplier_confirmed_at
  ) || case when p_detail then jsonb_build_object(
    'confirmedAt', v.confirmed_at,
    'confirmedByName', cp.display_name,
    'versionNo', v.version_no,
    'canClaim', authz.can_claim_flight_task(t.id) and t.assignee_user_id is null,
    'travellerCount', (select count(*) from public.booking_version_travellers s where s.booking_version_id = v.id),
    -- B1.1
    'tripScope', v.trip_scope,
    'changedFields', to_jsonb(authz.revision_department_fields(v.id)),
    'participants', authz.task_participants_json(t.id,
      t.assignee_user_id is not distinct from (select auth.uid()) and v.trip_scope = 'international')
  )
  -- Booking form: estimate and flight screenshots for the assignee.
  || case when t.assignee_user_id is not distinct from (select auth.uid())
          then jsonb_build_object('estimate', authz.bf_estimate_json(t.service_item_id, v.id),
                                  -- BF2: typed total fare per person of all flights (null = none typed).
                                  'fareTotals', authz.bf2_flight_fare_totals_json(v.id),
                                  'files', case when authz.service_item_file_viewer(t.service_item_id) is not null
                                                then authz.service_item_files_json(t.service_item_id) else '[]'::jsonb end)
          else '{}'::jsonb end
  else '{}'::jsonb end
  from public.fulfilment_tasks t
  join public.service_items i on i.id = t.service_item_id
  join public.booking_versions v on v.id = authz.task_current_version(t.id)
  left join public.service_item_facts f on f.service_item_id = t.service_item_id and f.booking_version_id = v.id
  join public.deals d on d.id = t.deal_id
  join public.branches b on b.id = t.branch_id
  left join public.staff_profiles ap on ap.user_id = t.assignee_user_id
  left join public.staff_profiles cp on cp.user_id = v.confirmed_by
  where t.id = p_task
$$;

-- ===========================================================================
-- 6. Booking form read (replaces 20261128000130; lines marked BF2)
-- ===========================================================================

create or replace function public.booking_form_get(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ver public.booking_versions;
  v_result jsonb;
  v_billing public.customer_billing_profiles;
  v_id_proof_view boolean;  -- B1.2
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_deal_id is null or not (authz.can_edit_booking_draft(p_deal_id) or authz.can_confirm_booking(p_deal_id)) then
    return null;
  end if;
  v_ver := authz.deal_current_version(p_deal_id);
  select * into v_billing from public.customer_billing_profiles b where b.deal_id = p_deal_id;
  -- B1.2: identity-proof viewer (DEC-41), never on a Deal removed by the sync (review D3-4, D3-8).
  v_id_proof_view := authz.id_proof_viewer_role(p_deal_id) is not null
    and not exists (select 1 from public.deals d where d.id = p_deal_id and d.removed_at is not null);

  v_result := jsonb_build_object(
    'dealId', p_deal_id,
    'canEdit', coalesce(v_ver.status, 'draft') = 'draft' and authz.can_edit_booking_draft(p_deal_id),
    'canConfirm', v_ver.status = 'draft' and authz.can_confirm_booking(p_deal_id),
    -- Review A3: may see and edit the selling price and payment plan.
    'canEditCommercials', authz.can_read_deal_commercial(p_deal_id),
    'serviceItemsEnabled', authz.service_items_enabled(),
    'visaPassportTasksEnabled', authz.visa_passport_tasks_enabled(),
    'dealNotActive', authz.deal_not_active(p_deal_id),
    'version', case when v_ver.id is null then null else jsonb_build_object(
      'versionId', v_ver.id, 'versionNo', v_ver.version_no, 'status', v_ver.status, 'serviceType', v_ver.service_type,
      'rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash, 'updatedAt', v_ver.updated_at,
      'updatedByName', (select p.display_name from public.staff_profiles p where p.user_id = v_ver.updated_by),
      'confirmedAt', v_ver.confirmed_at,
      'formRules', v_ver.form_rules) end,
    -- Booking form: party counts.
    'party', case when v_ver.id is null then null
                  else jsonb_build_object('total', v_ver.pax_total, 'children', v_ver.children_count,
                                          'infants', v_ver.infants_count,
                                          'adults', v_ver.adults_count) end,  -- VN
    'coverage', case when v_ver.id is null then null else authz.bf_hotel_coverage(v_ver.id) end,
    'itemFilesCanEdit', authz.id_proof_can_edit(p_deal_id),
    'trip', jsonb_build_object('destination', v_ver.trip_destination, 'scope', v_ver.trip_scope,
      'start', to_char(v_ver.trip_start, 'YYYY-MM-DD'), 'end', to_char(v_ver.trip_end, 'YYYY-MM-DD')),
    'contacts', (select jsonb_build_object('contactName', c.contact_name, 'mobile', c.mobile, 'email', c.email,
        'contactConfirmed', c.contact_confirmed, 'confirmedAt', c.confirmed_at,
        'confirmedByName', (select p.display_name from public.staff_profiles p where p.user_id = c.confirmed_by),
        'bookingFor', c.booking_for, 'payerDifferent', c.payer_different, 'payerName', c.payer_name,
        'customerType', c.customer_type, 'market', c.market)
      from public.booking_version_contacts c where c.booking_version_id = v_ver.id),
    'billing', case when v_billing.deal_id is null
      then jsonb_build_object('status', 'none', 'prefillSource', null, 'rowVersion', 0)
      else jsonb_build_object('status', v_billing.status, 'prefillSource', v_billing.prefill_source,
        'rowVersion', v_billing.row_version, 'billingName', v_billing.billing_name,
        'addressLine1', v_billing.address_line1, 'addressLine2', v_billing.address_line2, 'city', v_billing.city,
        'stateCode', v_billing.state_code, 'postalCode', v_billing.postal_code, 'gstin', v_billing.gstin,
        -- Booking form: Bill To.
        'billToType', v_billing.bill_to_type, 'contactPerson', v_billing.contact_person, 'phone', v_billing.phone,
        'email', v_billing.email, 'gstStatus', v_billing.gst_status, 'gstReason', v_billing.gst_reason,
        'verifiedByName', (select p.display_name from public.staff_profiles p where p.user_id = v_billing.verified_by),
        'verifiedAt', v_billing.verified_at,
        -- VN: the bill-to party this billing was copied from (reference) and its current check state.
        'partyId', v_billing.party_id,
        'partyCheckStatus', (select cp.check_status from public.customer_parties cp where cp.id = v_billing.party_id)) end,
    'travellers', coalesce((
      select jsonb_agg(jsonb_build_object('travellerId', t.id, 'seq', t.seq, 'fullName', t.full_name, 'type', t.traveller_type,
          'ageYears', t.age_years, 'specialNeeds', t.special_needs,
          'specialRequests', to_jsonb(t.special_requests),  -- VN
          'identity', case when authz.can_read_traveller_identity(p_deal_id, t.seq)
                           then authz.booking_identity_json(p_deal_id, t.seq, null)
                                -- Booking form: passenger extras (live identity row); VN extraPhones.
                                || coalesce((select jsonb_build_object('dateOfMarriage', to_char(x.date_of_marriage, 'YYYY-MM-DD'),
                                               'phone', x.phone, 'email', x.email, 'extraPhones', to_jsonb(x.extra_phones))
                                             from public.traveller_identities x where x.traveller_id = t.id),
                                            jsonb_build_object('dateOfMarriage', null, 'phone', null, 'email', null,
                                                               'extraPhones', '[]'::jsonb)) end)
          -- B1.2: identity proofs of this traveller, only for identity-proof viewers (DEC-41).
          || case when v_id_proof_view
                  then jsonb_build_object('idProofs', authz.traveller_id_proofs_json(t.id)) else '{}'::jsonb end
          order by t.seq)
      from public.deal_travellers t where t.deal_id = p_deal_id), '[]'::jsonb),
    'items', coalesce((
      -- BF2 (review round 1): the Purchase budget for commercial readers only.
      select jsonb_agg(authz.service_item_json(i.id, v_ver.id, authz.can_read_deal_commercial(p_deal_id))
          || jsonb_build_object('participants', to_jsonb(authz.item_participant_seqs(i.id, v_ver.id)))
          -- Booking form: supplier estimate (commercial readers) and item files (file viewers).
          || case when authz.can_read_deal_commercial(p_deal_id)
                  then jsonb_build_object('estimate', authz.bf_estimate_json(i.id, v_ver.id)) else '{}'::jsonb end
          || case when i.service_type = 'flight' and authz.service_item_file_viewer(i.id) is not null
                  then jsonb_build_object('files', authz.service_item_files_json(i.id)) else '{}'::jsonb end
          order by i.item_no)
      from public.service_items i where i.deal_id = p_deal_id), '[]'::jsonb),
    'evidence', coalesce((
      select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'fileName', e.file_name, 'mime', e.mime,
          'sizeBytes', e.size_bytes, 'status', e.status, 'uploadedByYou', e.uploaded_by = (select auth.uid()),
          'createdAt', e.created_at, 'storedAt', e.stored_at) order by e.created_at, e.id)
      from public.booking_evidence e where e.version_id = v_ver.id and e.status <> 'removed'), '[]'::jsonb));

  if authz.can_read_deal_commercial(p_deal_id) then
    v_result := v_result
      || jsonb_build_object('commercials', (select jsonb_build_object(
           'listPricePaise', c.list_price_paise::text, 'discountPaise', c.discount_paise::text,
           'sellingTotalPaise', c.selling_total_paise::text)
         from public.booking_version_commercials c where c.version_id = v_ver.id))
      || jsonb_build_object('plan', coalesce((
           select jsonb_agg(jsonb_build_object('seq', p.seq, 'label', p.label, 'amountPaise', p.amount_paise::text,
             'dueDate', to_char(p.due_date, 'YYYY-MM-DD')) order by p.seq)
           from public.booking_version_instalments p where p.booking_version_id = v_ver.id), '[]'::jsonb))
      -- Booking form: per-person prices (commercial readers only; absent otherwise).
      || case when v_ver.id is null then '{}'::jsonb else jsonb_build_object('prices', authz.bf_prices_json(v_ver.id)) end
      -- BF2: typed total fare per person of all flights (commercial readers only; null = none typed).
      || case when v_ver.id is null then '{}'::jsonb
              else jsonb_build_object('flightFareTotals', authz.bf2_flight_fare_totals_json(v_ver.id)) end;
  end if;
  -- B1.2: identity-proof limits as the commands enforce them, and whether the
  -- caller may attach or remove proofs now (also after submission).
  v_result := v_result || jsonb_build_object('idProofLimits',
    jsonb_build_object('maxFilesPerTraveller', 4, 'maxBytes', authz.id_proof_max_bytes()),
    'idProofCanEdit', authz.id_proof_can_edit(p_deal_id),
    'idProofCanRemove', authz.id_proof_can_remove(p_deal_id));
  -- B1.2 (quotations): the accepted quotation version this draft came from (null otherwise).
  v_result := v_result || jsonb_build_object('sourceQuotation', (
    select jsonb_build_object('quotationId', q.id, 'reference', q.reference, 'versionId', qv.id, 'versionNo', qv.version_no,
      'acceptedAt', qv.accepted_at, 'acceptedTierKey', qv.accepted_tier, 'acceptanceEvidenceId', qv.acceptance_evidence_id)
    from public.quotation_versions qv join public.quotations q on q.id = qv.quotation_id
    where qv.id = v_ver.source_quotation_version_id));
  -- B1.2 0600: Bitrix values for "Use Bitrix values" (DEC-36); the caller is a booking editor or acceptor.
  v_result := v_result || jsonb_build_object('prefill', authz.prefill_view('deal', p_deal_id, 'booking_version', v_ver.id,
    authz.can_read_deal_commercial(p_deal_id)));
  -- VN: trip facts from Bitrix and their source per field.
  v_result := v_result || jsonb_build_object('tripFacts', authz.vn_trip_facts_json(p_deal_id, v_ver.id));
  -- BF2: the Deal's page in Bitrix ("Open the Deal in Bitrix"); null for a Deal not imported from Bitrix.
  v_result := v_result || jsonb_build_object('bitrixDealHref', (
    select 'https://' || c.portal_domain || '/crm/deal/details/' || d.source_deal_id::text || '/'
    from public.deals d
    join public.integration_intake_config c on c.portal_member_id = d.source_portal
    where d.id = p_deal_id and d.source_system = 'bitrix' and d.source_deal_id is not null));
  -- BF2 (ruling D5, review round 1): an ID proof stored now would also be copied to
  -- the Bitrix Deal (same rule as authz.id_proof_copy_enqueue, 20261120000700).
  v_result := v_result || jsonb_build_object('idProofCopyApplies', exists (
    select 1 from public.deals d
    join public.integration_intake_config c on c.portal_member_id = d.source_portal and c.enabled and c.bitrix_id_proof_copy
    where d.id = p_deal_id and d.source_system = 'bitrix' and d.source_deal_id is not null and d.removed_at is null));
  return v_result;
end;
$$;

-- ===========================================================================
-- 7. Privileges
-- ===========================================================================

revoke all on function authz.bf2_screenshot_missing_nos(uuid), authz.bf2_flight_fare_totals_json(uuid)
from public, anon, authenticated, service_role;

commit;
