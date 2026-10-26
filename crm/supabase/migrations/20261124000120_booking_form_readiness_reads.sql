-- TripNavigate CRM - booking form (22 October 2026): readiness and reads.
--
-- Contract: docs/implementation/booking-form-2026-10-22/contract.md section 3
--   (frozen 22 Oct 2026, lead rulings of 22 Oct: conversion follows form
--   rules 2) and booking-form-contract.ts. Depends on 20261124000100 and
--   20261124000110.
--
-- Replaced (latest bodies copied; booking-form lines marked):
--   * authz.validate_service_facts (20261120000200): car endDate, quantity,
--     includedKms, vendor; flight segment arrivalDate, airline, flightNo,
--     departTime, arriveTime.
--   * authz.revision_field_class, revision_changed_fields,
--     revision_department_fields, booking_open_revision: party counts,
--     contact labels, prices (prices.sale material, prices.cost internal),
--     estimates (internal); department field lists never name prices or billing.
--   * authz.booking_issues (20261120000200) and intake_checklist
--     (20261122000100): the booking-form codes (pax_missing, pax_types_exceeded,
--     price_missing, price_count_mismatch, price_below_purchase,
--     hotel_nights_missing, hotel_outside_trip, hotel_same_day_trip,
--     service_dates_outside_trip, gst_status_missing, gst_reason_missing,
--     billing_contact_missing, billing_reach_missing). Party, hotel, date and
--     Bill To contact/GST-status/reach codes apply to form rules 2 only; price
--     codes apply wherever per-person prices are required or in use;
--     gstin_missing applies to a registered business, and keeps today's rule
--     for profiles saved before the booking form; gst_reason_missing to an
--     unregistered business. booking_confirm already re-runs booking_issues
--     under the version lock, so every code is enforced atomically there.
--   * authz.booking_issues_for_viewer: price codes read prices_ask_owner
--     without commercial scope.
--   * booking_form_get (20261120000600), accounts_deal_detail
--     (20261119000300), authz.purchase_task_json / flight_task_json
--     (20261119000300): booking-form keys (prices only for commercial readers;
--     estimates for commercial readers and the item's task assignee; flight
--     screenshots for their viewers).
--   * quotation_convert_to_booking (20261122000100): form rules 2, the
--     accepted party counts into the version and into per-person line
--     quantities (never amounts; the accepted total stays).
--
-- Amended 22 October 2026 after independent review A (Echo, before this file
-- ran on any kept database):
--   H1  hotel coverage lists nights only when a hotel exists, at most 366.
--   M1  accounts_deal_detail gets the selling side of per-person prices only
--       (authz.bf_prices_sale_json: category, people, final sale).
--   L1  booking_version_history (20261119000300) hides price, plan and
--       billing field names from viewers without commercial scope.
--   L2  price_count_mismatch only once a price line exists.
--   L3  authz.booking_quote_pax_differs (20261120000200) also compares the
--       version's party counts with the accepted quotation.
--   authz.bf_lines_required moved to 20261124000110 (used there).
--
-- Rollback (forward-only): a NEW migration restoring the replaced bodies.

begin;
set local lock_timeout = '15s';


-- Replaces 20261120000200: car (transfer) and flight segment keys of the booking form.
create or replace function authz.validate_service_facts(p_type text, p_facts jsonb) returns text[]
language plpgsql stable set search_path = '' as $$
declare
  v_bad text[] := '{}'::text[];
  v_allowed text[];
  v_key text;
  v_seg jsonb;
  v_prev date;
  v_date date;
  v_n integer := 0;
  v_seg_ok boolean := true;
  v_mode text;
  v_ages jsonb;
begin
  -- B1.1: visa and passport.
  if p_type is null or p_type not in ('hotel', 'transfer', 'activity', 'flight', 'visa', 'passport') then
    return array['type'];
  end if;
  if p_facts is null or jsonb_typeof(p_facts) <> 'object' then
    return array['facts'];
  end if;
  v_allowed := case p_type
    when 'hotel' then array['hotelName', 'city', 'checkIn', 'checkOut', 'rooms', 'adults', 'roomType', 'mealPlan',
                            'children', 'inclusions', 'specialRequests',
                            'mode', 'preferences', 'area', 'childAges', 'exclusions',
                            -- B1.2 (freeze part 2 section 1): extra beds and children without a bed.
                            'extraBeds', 'childrenWithoutBed', 'bedRemarks']
    when 'transfer' then array['route', 'date', 'vehicleType', 'passengers', 'pickupTime', 'notes', 'pickup', 'drop',
                               -- Booking form: car end date, vehicles, included kilometres, preferred vendor.
                               'endDate', 'quantity', 'includedKms', 'vendor']
    when 'activity' then array['name', 'city', 'date', 'participants', 'time', 'notes', 'inclusions']
    when 'flight' then array['segments', 'passengers', 'preferredTime', 'cabin', 'notes', 'tripType', 'preferences', 'assistance']
    when 'visa' then array['country', 'purpose', 'travelDate', 'applyBy', 'feePaidBy', 'notes']
    else array['applicationType', 'officeCity', 'neededBy', 'notes'] end;
  for v_key in select k from jsonb_object_keys(p_facts) k loop
    if v_key <> all (v_allowed) then
      v_bad := v_bad || v_key;
    end if;
  end loop;

  if p_type = 'hotel' then
    v_mode := case when jsonb_typeof(p_facts -> 'mode') = 'string' then p_facts ->> 'mode' end;
    if p_facts ? 'mode' and jsonb_typeof(p_facts -> 'mode') <> 'null'
       and (v_mode is null or v_mode not in ('specific', 'preferences')) then
      v_bad := v_bad || 'mode'::text;
    end if;
    -- mode absent or 'specific': a named hotel (B1 rule); 'preferences': the
    -- acceptable options instead.
    if not authz.sf_text_ok(p_facts -> 'hotelName', 200, coalesce(v_mode, 'specific') <> 'preferences') then
      v_bad := v_bad || 'hotelName'::text;
    end if;
    if not authz.sf_text_ok(p_facts -> 'preferences', 2000, coalesce(v_mode = 'preferences', false)) then
      v_bad := v_bad || 'preferences'::text;
    end if;
    if not authz.sf_text_ok(p_facts -> 'city', 120, true) then v_bad := v_bad || 'city'::text; end if;
    if authz.sf_date(p_facts -> 'checkIn') is null then v_bad := v_bad || 'checkIn'::text; end if;
    if authz.sf_date(p_facts -> 'checkOut') is null
       or (authz.sf_date(p_facts -> 'checkIn') is not null
           and authz.sf_date(p_facts -> 'checkOut') <= authz.sf_date(p_facts -> 'checkIn')) then
      v_bad := v_bad || 'checkOut'::text;
    end if;
    if not authz.sf_int_ok(p_facts -> 'rooms', 1, 50, true) then v_bad := v_bad || 'rooms'::text; end if;
    if not authz.sf_int_ok(p_facts -> 'adults', 1, 100, true) then v_bad := v_bad || 'adults'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'roomType', 120, false) then v_bad := v_bad || 'roomType'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'mealPlan', 60, false) then v_bad := v_bad || 'mealPlan'::text; end if;
    if not authz.sf_int_ok(p_facts -> 'children', 0, 100, false) then v_bad := v_bad || 'children'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'inclusions', 2000, false) then v_bad := v_bad || 'inclusions'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'specialRequests', 2000, false) then v_bad := v_bad || 'specialRequests'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'area', 120, false) then v_bad := v_bad || 'area'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'exclusions', 2000, false) then v_bad := v_bad || 'exclusions'::text; end if;
    v_ages := p_facts -> 'childAges';
    if v_ages is not null and jsonb_typeof(v_ages) <> 'null' and (
         jsonb_typeof(v_ages) <> 'array'
         or jsonb_array_length(v_ages) <> coalesce(authz.sf_int_value(p_facts -> 'children'), 0)
         or exists (select 1 from jsonb_array_elements(v_ages) a where not authz.sf_int_ok(a, 0, 17, true))) then
      v_bad := v_bad || 'childAges'::text;
    end if;
    -- B1.2: counts and a remark only; never priced or multiplied here (DEC-33).
    if not authz.sf_int_ok(p_facts -> 'extraBeds', 0, 20, false) then v_bad := v_bad || 'extraBeds'::text; end if;
    if not authz.sf_int_ok(p_facts -> 'childrenWithoutBed', 0, 20, false) then v_bad := v_bad || 'childrenWithoutBed'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'bedRemarks', 300, false) then v_bad := v_bad || 'bedRemarks'::text; end if;
  elsif p_type = 'transfer' then
    -- B1.1: route optional when pickup and drop are given; vehicle type and
    -- passengers optional (plan section 3f).
    if not authz.sf_text_ok(p_facts -> 'route', 200,
         not (authz.sf_text_ok(p_facts -> 'pickup', 200, true) and authz.sf_text_ok(p_facts -> 'drop', 200, true))) then
      v_bad := v_bad || 'route'::text;
    end if;
    if not authz.sf_text_ok(p_facts -> 'pickup', 200, false) then v_bad := v_bad || 'pickup'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'drop', 200, false) then v_bad := v_bad || 'drop'::text; end if;
    if authz.sf_date(p_facts -> 'date') is null then v_bad := v_bad || 'date'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'vehicleType', 60, false) then v_bad := v_bad || 'vehicleType'::text; end if;
    if not authz.sf_int_ok(p_facts -> 'passengers', 1, 100, false) then v_bad := v_bad || 'passengers'::text; end if;
    if not authz.sf_time_ok(p_facts -> 'pickupTime', false) then v_bad := v_bad || 'pickupTime'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'notes', 2000, false) then v_bad := v_bad || 'notes'::text; end if;
    -- Booking form.
    if p_facts ? 'endDate' and jsonb_typeof(p_facts -> 'endDate') <> 'null'
       and (authz.sf_date(p_facts -> 'endDate') is null
            or authz.sf_date(p_facts -> 'endDate') < authz.sf_date(p_facts -> 'date')) then
      v_bad := v_bad || 'endDate'::text;
    end if;
    if not authz.sf_int_ok(p_facts -> 'quantity', 1, 100, false) then v_bad := v_bad || 'quantity'::text; end if;
    if not authz.sf_int_ok(p_facts -> 'includedKms', 0, 100000, false) then v_bad := v_bad || 'includedKms'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'vendor', 150, false) then v_bad := v_bad || 'vendor'::text; end if;
  elsif p_type = 'activity' then
    if not authz.sf_text_ok(p_facts -> 'name', 200, true) then v_bad := v_bad || 'name'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'city', 120, true) then v_bad := v_bad || 'city'::text; end if;
    if authz.sf_date(p_facts -> 'date') is null then v_bad := v_bad || 'date'::text; end if;
    if not authz.sf_int_ok(p_facts -> 'participants', 1, 100, true) then v_bad := v_bad || 'participants'::text; end if;
    if not authz.sf_time_ok(p_facts -> 'time', false) then v_bad := v_bad || 'time'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'notes', 2000, false) then v_bad := v_bad || 'notes'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'inclusions', 2000, false) then v_bad := v_bad || 'inclusions'::text; end if;
  elsif p_type = 'flight' then
    if p_facts -> 'segments' is null or jsonb_typeof(p_facts -> 'segments') <> 'array'
       or jsonb_array_length(p_facts -> 'segments') not between 1 and 8 then
      v_seg_ok := false;
    else
      for v_seg in select s from jsonb_array_elements(p_facts -> 'segments') s loop
        v_n := v_n + 1;
        -- B1.1: IATA code or place name; optional flexibility per leg.
        if jsonb_typeof(v_seg) <> 'object'
           or exists (select 1 from jsonb_object_keys(v_seg) k
                      where k not in ('from', 'to', 'date', 'flex',
                                      -- Booking form: arrival date, airline, flight number, local times.
                                      'arrivalDate', 'airline', 'flightNo', 'departTime', 'arriveTime'))
           or not authz.b11_place_ok(v_seg -> 'from') or not authz.b11_place_ok(v_seg -> 'to')
           or not authz.sf_text_ok(v_seg -> 'flex', 60, false)
           -- Booking form. Local clock times are never compared across time zones.
           or (v_seg ? 'arrivalDate' and jsonb_typeof(v_seg -> 'arrivalDate') <> 'null'
               and (authz.sf_date(v_seg -> 'arrivalDate') is null
                    or authz.sf_date(v_seg -> 'arrivalDate') < authz.sf_date(v_seg -> 'date')))
           or not authz.sf_text_ok(v_seg -> 'airline', 60, false)
           or (not authz.sf_text_ok(v_seg -> 'flightNo', 12, false)
               or (jsonb_typeof(v_seg -> 'flightNo') = 'string' and (v_seg ->> 'flightNo') !~ '^[A-Za-z0-9 -]{1,12}$'))
           or not authz.sf_time_ok(v_seg -> 'departTime', false)
           or not authz.sf_time_ok(v_seg -> 'arriveTime', false) then
          v_seg_ok := false;
        end if;
        v_date := authz.sf_date(v_seg -> 'date');
        if v_date is null or (v_prev is not null and v_date < v_prev) then
          v_seg_ok := false;
        end if;
        v_prev := coalesce(v_date, v_prev);
      end loop;
    end if;
    if not v_seg_ok then v_bad := v_bad || 'segments'::text; end if;
    if not authz.sf_int_ok(p_facts -> 'passengers', 1, 100, true) then v_bad := v_bad || 'passengers'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'preferredTime', 60, false) then v_bad := v_bad || 'preferredTime'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'cabin', 40, false) then v_bad := v_bad || 'cabin'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'notes', 2000, false) then v_bad := v_bad || 'notes'::text; end if;
    if p_facts ? 'tripType' and jsonb_typeof(p_facts -> 'tripType') <> 'null'
       and (jsonb_typeof(p_facts -> 'tripType') <> 'string'
            or (p_facts ->> 'tripType') not in ('one_way', 'return', 'multi_city')) then
      v_bad := v_bad || 'tripType'::text;
    end if;
    if not authz.sf_text_ok(p_facts -> 'preferences', 500, false) then v_bad := v_bad || 'preferences'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'assistance', 500, false) then v_bad := v_bad || 'assistance'::text; end if;
  elsif p_type = 'visa' then
    if not authz.sf_text_ok(p_facts -> 'country', 60, true) then v_bad := v_bad || 'country'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'purpose', 60, true) then v_bad := v_bad || 'purpose'::text; end if;
    if authz.sf_date(p_facts -> 'travelDate') is null then v_bad := v_bad || 'travelDate'::text; end if;
    if p_facts ? 'applyBy' and jsonb_typeof(p_facts -> 'applyBy') <> 'null'
       and (authz.sf_date(p_facts -> 'applyBy') is null
            or (authz.sf_date(p_facts -> 'travelDate') is not null
                and authz.sf_date(p_facts -> 'applyBy') > authz.sf_date(p_facts -> 'travelDate'))) then
      v_bad := v_bad || 'applyBy'::text;
    end if;
    if jsonb_typeof(p_facts -> 'feePaidBy') is distinct from 'string'
       or (p_facts ->> 'feePaidBy') not in ('customer', 'company', 'not_decided') then
      v_bad := v_bad || 'feePaidBy'::text;
    end if;
    if not authz.sf_text_ok(p_facts -> 'notes', 2000, false) then v_bad := v_bad || 'notes'::text; end if;
  else
    if jsonb_typeof(p_facts -> 'applicationType') is distinct from 'string'
       or (p_facts ->> 'applicationType') not in ('fresh', 'renewal', 'tatkaal', 'minor') then
      v_bad := v_bad || 'applicationType'::text;
    end if;
    if not authz.sf_text_ok(p_facts -> 'officeCity', 120, true) then v_bad := v_bad || 'officeCity'::text; end if;
    if p_facts ? 'neededBy' and jsonb_typeof(p_facts -> 'neededBy') <> 'null' and authz.sf_date(p_facts -> 'neededBy') is null then
      v_bad := v_bad || 'neededBy'::text;
    end if;
    if not authz.sf_text_ok(p_facts -> 'notes', 2000, false) then v_bad := v_bad || 'notes'::text; end if;
  end if;
  return v_bad;
end;
$$;

-- Replaces 20261120000200: booking form fields.
create or replace function authz.revision_field_class(p_field text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_field ~ '^items\.[0-9]+\.purchaseBudgetPaise$' then 'internal'
    -- Booking form: supplier estimates and per-person purchase are internal; the
    -- final sale (prices.sale) stays material.
    when p_field ~ '^items\.[0-9]+\.estimate$' or p_field = 'prices.cost' then 'internal'
    when p_field ~ '^items\.[0-9]+\.(hotelName|city|area|roomType|mealPlan|inclusions|exclusions|specialRequests|preferences|notes|bedRemarks|route|pickup|drop|vehicleType|name|cabin|preferredTime|assistance|purpose|officeCity|vendor)$'
      then 'choice'
    when p_field in ('travellers.specialNeeds', 'trip.destination', 'contacts.contactName', 'contacts.mobile',
                     'contacts.email', 'contacts.contactConfirmed',
                     -- Booking form: plain labels.
                     'contacts.customerType', 'contacts.market') then 'choice'
    else 'material' end
$$;

-- Replaces 20261119000300: party, labels, prices and estimates.
create or replace function authz.revision_changed_fields(p_version uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  with v as (
    select x.* from public.booking_versions x where x.id = p_version and x.revises_version_id is not null
  ), b as (
    select x.* from public.booking_versions x join v on x.id = v.revises_version_id
  ), items as (
    select i.id, i.item_no, fv.facts as vf, fb.facts as bf, fv.purchase_budget_paise as vb, fb.purchase_budget_paise as bb
    from public.service_items i
    cross join v cross join b
    left join public.service_item_facts fv on fv.service_item_id = i.id and fv.booking_version_id = v.id
    left join public.service_item_facts fb on fb.service_item_id = i.id and fb.booking_version_id = b.id
    where i.deal_id = v.deal_id and (fv.id is not null or fb.id is not null)
  ), fields as (
    select 'items.' || it.item_no || '.' || k as f
    from items it
    cross join lateral (select jsonb_object_keys(coalesce(it.vf, '{}'::jsonb)) union select jsonb_object_keys(coalesce(it.bf, '{}'::jsonb))) as kk(k)
    where it.vf -> k is distinct from it.bf -> k
    union all
    select 'items.' || it.item_no || '.purchaseBudgetPaise' from items it where it.vb is distinct from it.bb
    union all
    select 'participation.' || it.item_no from items it cross join v cross join b
    where authz.item_participant_seqs(it.id, v.id) is distinct from authz.item_participant_seqs(it.id, b.id)
    union all
    select 'travellers' from v cross join b
    where (select coalesce(jsonb_agg(jsonb_build_array(t.seq, t.full_name, t.traveller_type, t.age_years) order by t.seq), '[]'::jsonb)
           from public.deal_travellers t where t.deal_id = v.deal_id)
       is distinct from
          (select coalesce(jsonb_agg(jsonb_build_array(s.seq, s.full_name, s.traveller_type, s.age_years) order by s.seq), '[]'::jsonb)
           from public.booking_version_travellers s where s.booking_version_id = b.id)
    union all
    select 'travellers.specialNeeds' from v cross join b
    where (select coalesce(jsonb_agg(jsonb_build_array(t.seq, t.special_needs) order by t.seq), '[]'::jsonb)
           from public.deal_travellers t where t.deal_id = v.deal_id)
       is distinct from
          (select coalesce(jsonb_agg(jsonb_build_array(s.seq, s.special_needs) order by s.seq), '[]'::jsonb)
           from public.booking_version_travellers s where s.booking_version_id = b.id)
    union all
    select 'travellers.' || t.seq || '.identity'
    from v cross join b
    join public.deal_travellers t on t.deal_id = v.deal_id
    left join public.traveller_identities x on x.traveller_id = t.id
    left join public.booking_version_traveller_identities s on s.booking_version_id = b.id and s.seq = t.seq
    where t.seq = any (authz.b11_identity_needed_seqs(v.id) || authz.b11_identity_needed_seqs(b.id))
      and (x.date_of_birth, x.nationality) is distinct from (s.date_of_birth, s.nationality)
    union all
    select 'trip.' || k from v cross join b
    cross join lateral (values
      ('destination', v.trip_destination is distinct from b.trip_destination),
      ('scope', v.trip_scope is distinct from b.trip_scope),
      ('start', v.trip_start is distinct from b.trip_start),
      ('end', v.trip_end is distinct from b.trip_end),
      -- Booking form: party counts.
      ('paxTotal', v.pax_total is distinct from b.pax_total),
      ('children', v.children_count is distinct from b.children_count),
      ('infants', v.infants_count is distinct from b.infants_count)) as t(k, changed)
    where changed
    union all
    select 'contacts.' || k from v cross join b
    left join public.booking_version_contacts cv on cv.booking_version_id = v.id
    left join public.booking_version_contacts cb on cb.booking_version_id = b.id
    cross join lateral (values
      ('contactName', cv.contact_name is distinct from cb.contact_name),
      ('mobile', cv.mobile is distinct from cb.mobile),
      ('email', cv.email is distinct from cb.email),
      ('contactConfirmed', cv.contact_confirmed is distinct from cb.contact_confirmed),
      ('bookingFor', cv.booking_for is distinct from cb.booking_for),
      ('payerDifferent', cv.payer_different is distinct from cb.payer_different),
      ('payerName', cv.payer_name is distinct from cb.payer_name),
      -- Booking form: plain labels.
      ('customerType', cv.customer_type is distinct from cb.customer_type),
      ('market', cv.market is distinct from cb.market)) as t(k, changed)
    where changed
    union all
    select k from v cross join b
    left join public.booking_version_commercials cv on cv.version_id = v.id
    left join public.booking_version_commercials cb on cb.version_id = b.id
    cross join lateral (values
      ('sellingTotal', cv.selling_total_paise is distinct from cb.selling_total_paise),
      ('listPrice', cv.list_price_paise is distinct from cb.list_price_paise),
      ('discount', cv.discount_paise is distinct from cb.discount_paise)) as t(k, changed)
    where changed
    union all
    select 'plan' from v cross join b
    where (select coalesce(jsonb_agg(jsonb_build_array(p.seq, p.label, p.amount_paise, p.due_date) order by p.seq), '[]'::jsonb)
           from public.booking_version_instalments p where p.booking_version_id = v.id)
       is distinct from
          (select coalesce(jsonb_agg(jsonb_build_array(p.seq, p.label, p.amount_paise, p.due_date) order by p.seq), '[]'::jsonb)
           from public.booking_version_instalments p where p.booking_version_id = b.id)
    -- Booking form: per-person prices (sale side material, purchase internal)
    -- and supplier estimates (internal).
    union all
    select 'prices.sale' from v cross join b
    where (select coalesce(jsonb_agg(jsonb_build_array(l.category, l.quantity, l.sale_paise) order by l.category), '[]'::jsonb)
           from public.booking_version_price_lines l where l.booking_version_id = v.id and l.sale_paise is not null)
       is distinct from
          (select coalesce(jsonb_agg(jsonb_build_array(l.category, l.quantity, l.sale_paise) order by l.category), '[]'::jsonb)
           from public.booking_version_price_lines l where l.booking_version_id = b.id and l.sale_paise is not null)
    union all
    select 'prices.cost' from v cross join b
    where (select coalesce(jsonb_agg(jsonb_build_array(l.category, l.purchase_paise) order by l.category), '[]'::jsonb)
           from public.booking_version_price_lines l where l.booking_version_id = v.id and l.purchase_paise is not null)
       is distinct from
          (select coalesce(jsonb_agg(jsonb_build_array(l.category, l.purchase_paise) order by l.category), '[]'::jsonb)
           from public.booking_version_price_lines l where l.booking_version_id = b.id and l.purchase_paise is not null)
    union all
    select 'items.' || it.item_no || '.estimate'
    from items it cross join v cross join b
    left join public.service_item_cost_estimates ev on ev.booking_version_id = v.id and ev.service_item_id = it.id
    left join public.service_item_cost_estimates eb on eb.booking_version_id = b.id and eb.service_item_id = it.id
    where (ev.room_rate_paise, ev.extra_bed_rate_paise, ev.no_bed_rate_paise, ev.vehicle_rate_paise, ev.fare_total_paise)
          is distinct from
          (eb.room_rate_paise, eb.extra_bed_rate_paise, eb.no_bed_rate_paise, eb.vehicle_rate_paise, eb.fare_total_paise)
  )
  select coalesce(array_agg(distinct f order by f), '{}'::text[]) from fields
$$;

-- Replaces 20261119000300: never prices or billing names (booking form).
create or replace function authz.revision_department_fields(p_version uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(f order by f), '{}'::text[])
  from public.booking_versions v cross join unnest(coalesce(v.changed_fields, '{}'::text[])) f
  where v.id = p_version
    and f !~ '^(sellingTotal|listPrice|discount|plan|contacts\.|travellers\.[0-9]+\.identity|prices|billing)'
$$;

-- Replaces 20261119000300: party, labels, prices and estimates copied.
create or replace function public.booking_open_revision(p_base_version_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_base public.booking_versions%rowtype;
  v_ver public.booking_versions%rowtype;
  v_deal public.deals%rowtype;
  v_review text;
begin
  select * into v_base from public.booking_versions v where v.id = p_base_version_id;
  perform authz.refuse_removed_deal(v_base.deal_id);
  if v_base.id is null or not authz.can_edit_booking_draft(v_base.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not authz.service_items_enabled() then
    raise exception 'service_items_disabled' using errcode = '55000';
  end if;
  if authz.deal_not_active(v_base.deal_id) then
    raise exception 'deal_not_active' using errcode = '55000';
  end if;
  -- Lock order: Deal, base version, base review.
  select * into v_deal from public.deals d where d.id = v_base.deal_id for no key update;
  select * into v_base from public.booking_versions v where v.id = p_base_version_id for update;
  if v_base.status = 'superseded' then
    raise exception 'version_superseded' using errcode = '55000';
  end if;
  if v_base.status <> 'confirmed' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_base.service_type <> 'package' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'version';
  end if;
  select * into v_ver from public.booking_versions v
  where v.revises_version_id = v_base.id and v.status = 'draft';
  if v_ver.id is not null then
    return jsonb_build_object('versionId', v_ver.id, 'versionNo', v_ver.version_no, 'rowVersion', v_ver.row_version,
      'revisesVersionId', v_base.id, 'created', false);
  end if;
  select rv.status into v_review from public.accounts_booking_reviews rv where rv.booking_version_id = v_base.id for share;
  if v_review is distinct from 'returned' then
    raise exception 'revision_not_allowed' using errcode = '55000';
  end if;
  if authz.deal_committed(v_base.deal_id) then
    raise exception 'already_committed' using errcode = '55000';
  end if;

  -- Booking form: party counts copied; form rules follow the base (trigger).
  insert into public.booking_versions (deal_id, legal_entity_id, branch_id, version_no, created_by, service_type,
    trip_destination, trip_scope, trip_start, trip_end, revises_version_id, updated_by,
    pax_total, children_count, infants_count)
  values (v_base.deal_id, v_base.legal_entity_id, v_base.branch_id,
    (select max(v.version_no) from public.booking_versions v where v.deal_id = v_base.deal_id) + 1,
    (select auth.uid()), 'package', v_base.trip_destination, v_base.trip_scope, v_base.trip_start, v_base.trip_end,
    v_base.id, (select auth.uid()), v_base.pax_total, v_base.children_count, v_base.infants_count)
  returning * into v_ver;
  insert into public.service_item_facts (service_item_id, booking_version_id, legal_entity_id, facts, purchase_budget_paise, facts_hash)
  select f.service_item_id, v_ver.id, f.legal_entity_id, f.facts, f.purchase_budget_paise, f.facts_hash
  from public.service_item_facts f where f.booking_version_id = v_base.id;
  insert into public.service_item_travellers (booking_version_id, service_item_id, legal_entity_id, traveller_seq)
  select v_ver.id, f.service_item_id, f.legal_entity_id, s
  from public.service_item_facts f cross join unnest(authz.item_participant_seqs(f.service_item_id, v_base.id)) s
  where f.booking_version_id = v_base.id;
  insert into public.booking_version_contacts (booking_version_id, legal_entity_id, deal_id, contact_name, mobile, email,
    contact_confirmed, confirmed_by, confirmed_at, booking_for, payer_different, payer_name, updated_by,
    customer_type, market)
  select v_ver.id, c.legal_entity_id, c.deal_id, c.contact_name, c.mobile, c.email, c.contact_confirmed, c.confirmed_by,
    c.confirmed_at, c.booking_for, c.payer_different, c.payer_name, c.updated_by, c.customer_type, c.market
  from public.booking_version_contacts c where c.booking_version_id = v_base.id;
  insert into public.booking_version_commercials (version_id, legal_entity_id, selling_total_paise, list_price_paise, discount_paise)
  select v_ver.id, c.legal_entity_id, c.selling_total_paise, c.list_price_paise, c.discount_paise
  from public.booking_version_commercials c where c.version_id = v_base.id;
  insert into public.booking_version_instalments (booking_version_id, deal_id, legal_entity_id, seq, label, amount_paise, due_date)
  select v_ver.id, p.deal_id, p.legal_entity_id, p.seq, p.label, p.amount_paise, p.due_date
  from public.booking_version_instalments p where p.booking_version_id = v_base.id;
  -- Booking form: per-person prices and supplier estimates.
  insert into public.booking_version_price_lines (booking_version_id, legal_entity_id, deal_id, category, quantity,
    purchase_paise, sale_paise, updated_by)
  select v_ver.id, l.legal_entity_id, l.deal_id, l.category, l.quantity, l.purchase_paise, l.sale_paise, l.updated_by
  from public.booking_version_price_lines l where l.booking_version_id = v_base.id;
  insert into public.service_item_cost_estimates (booking_version_id, service_item_id, legal_entity_id, room_rate_paise,
    extra_bed_rate_paise, no_bed_rate_paise, vehicle_rate_paise, fare_total_paise, updated_by)
  select v_ver.id, e.service_item_id, e.legal_entity_id, e.room_rate_paise, e.extra_bed_rate_paise, e.no_bed_rate_paise,
    e.vehicle_rate_paise, e.fare_total_paise, e.updated_by
  from public.service_item_cost_estimates e where e.booking_version_id = v_base.id;
  select * into v_ver from public.booking_versions v where v.id = v_ver.id;

  perform authz.write_audit('booking.revision_opened', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id,
    null, jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'baseVersionId', v_base.id,
      'baseVersionNo', v_base.version_no));
  return jsonb_build_object('versionId', v_ver.id, 'versionNo', v_ver.version_no, 'rowVersion', v_ver.row_version,
    'revisesVersionId', v_base.id, 'created', true);
end;
$$;

-- ===========================================================================
-- Booking-form helpers (no table writes; callers authorize first)
-- ===========================================================================

-- Hotel night coverage of a version (shared rule with the browser model):
-- every calendar night from the trip start up to (excluding) the trip end
-- needs a hotel; parallel rooms count once; overlaps never hide a gap.
-- {nights, covered, missing [YYYY-MM-DD], outside [service item ids]}.
-- Review A H1: nights are listed only when the version has a hotel, and the
-- missing list holds at most the first 366 dates (never fails on a long trip).
create function authz.bf_hotel_coverage(p_version uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with v as (
    select x.trip_start, x.trip_end from public.booking_versions x where x.id = p_version
  ), h as (
    select i.id, i.item_no, authz.sf_date(f.facts -> 'checkIn') as ci, authz.sf_date(f.facts -> 'checkOut') as co
    from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
    where f.booking_version_id = p_version and i.service_type = 'hotel' and i.state <> 'cancelled'
  ), n as (
    select d::date as night
    from v cross join generate_series(v.trip_start, v.trip_end - 1, interval '1 day') d
    where v.trip_start is not null and v.trip_end is not null and v.trip_end > v.trip_start
      and exists (select 1 from h)
  )
  select jsonb_build_object(
    'nights', (select case when v.trip_start is not null and v.trip_end is not null and v.trip_end >= v.trip_start
                           then v.trip_end - v.trip_start end from v),
    'covered', (select count(*) from n where exists (select 1 from h where h.ci <= n.night and n.night < h.co)),
    'missing', coalesce((select jsonb_agg(to_char(m.night, 'YYYY-MM-DD') order by m.night)
                         from (select n.night from n
                               where not exists (select 1 from h where h.ci <= n.night and n.night < h.co)
                               order by n.night limit 366) m), '[]'::jsonb),
    'outside', coalesce((select jsonb_agg(h.id order by h.item_no) from h cross join v
                         where v.trip_start is not null and v.trip_end is not null
                           and (h.ci is null or h.co is null or h.ci < v.trip_start or h.co > v.trip_end)), '[]'::jsonb))
$$;

-- Item numbers of hotels outside the trip dates.
create function authz.bf_hotel_outside_nos(p_version uuid) returns integer[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(i.item_no order by i.item_no), '{}'::integer[])
  from public.booking_versions v
  join public.service_item_facts f on f.booking_version_id = v.id
  join public.service_items i on i.id = f.service_item_id
  where v.id = p_version and i.service_type = 'hotel' and i.state <> 'cancelled'
    and v.trip_start is not null and v.trip_end is not null
    and (authz.sf_date(f.facts -> 'checkIn') is null or authz.sf_date(f.facts -> 'checkOut') is null
         or authz.sf_date(f.facts -> 'checkIn') < v.trip_start or authz.sf_date(f.facts -> 'checkOut') > v.trip_end)
$$;

-- Item numbers of cars (date, endDate), activities (date) and flights
-- (segment date, arrivalDate) outside the trip dates. Visa and passport
-- preparation dates may fall outside the trip; hotels have their own codes.
create function authz.bf_dates_outside_nos(p_version uuid) returns integer[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(distinct i.item_no order by i.item_no), '{}'::integer[])
  from public.booking_versions v
  join public.service_item_facts f on f.booking_version_id = v.id
  join public.service_items i on i.id = f.service_item_id
  cross join lateral (
    select f.facts -> 'date' as d where i.service_type in ('transfer', 'activity')
    union all select f.facts -> 'endDate' where i.service_type = 'transfer'
    union all select s -> 'date' from jsonb_array_elements(
      case when i.service_type = 'flight' and jsonb_typeof(f.facts -> 'segments') = 'array' then f.facts -> 'segments'
           else '[]'::jsonb end) s
    union all select s -> 'arrivalDate' from jsonb_array_elements(
      case when i.service_type = 'flight' and jsonb_typeof(f.facts -> 'segments') = 'array' then f.facts -> 'segments'
           else '[]'::jsonb end) s
  ) x
  where v.id = p_version and i.state <> 'cancelled' and v.trip_start is not null and v.trip_end is not null
    and authz.sf_date(x.d) is not null
    and (authz.sf_date(x.d) < v.trip_start or authz.sf_date(x.d) > v.trip_end)
$$;

-- Bill To codes of a version's Deal. A profile without a type (saved before
-- the booking form) reads its type from the booking contact.
create function authz.bf_billing_codes(p_deal uuid, p_version uuid) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v_rules smallint;
  v_b public.customer_billing_profiles%rowtype;
  v_for text;
  v_business boolean;
begin
  select v.form_rules into v_rules from public.booking_versions v where v.id = p_version;
  select * into v_b from public.customer_billing_profiles b where b.deal_id = p_deal;
  if v_b.deal_id is null then
    return array['billing_missing'];
  end if;
  select c.booking_for into v_for from public.booking_version_contacts c where c.booking_version_id = p_version;
  v_business := coalesce(v_b.bill_to_type, case when v_for = 'business' then 'business' end) = 'business';
  return array_remove(array[
    case when v_business and v_b.gstin is null
          and (v_b.gst_status = 'registered' or (v_b.gst_status is null and coalesce(v_rules, 1) = 1)) then 'gstin_missing' end,
    case when v_rules = 2 and v_business and v_b.gst_status is null then 'gst_status_missing' end,
    case when v_business and v_b.gst_status = 'unregistered' and v_b.gst_reason is null then 'gst_reason_missing' end,
    case when v_rules = 2 and v_business and v_b.contact_person is null then 'billing_contact_missing' end,
    case when v_rules = 2 and v_b.phone is null and v_b.email is null then 'billing_reach_missing' end], null);
end;
$$;

-- Party, price, hotel and date codes of a package version (booking form).
create function authz.bf_form_codes(p_version uuid) returns text[]
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
    case when v.form_rules = 2 and cardinality(authz.bf_dates_outside_nos(v.id)) > 0 then 'service_dates_outside_trip' end
  ], null);
end;
$$;

-- Supplier estimate of an item in a version (cost only; null = none stored
-- or a service type without estimates). The caller authorizes.
create function authz.bf_estimate_json(p_item uuid, p_version uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when e.service_item_id is null then null
    else case i.service_type
      when 'hotel' then jsonb_build_object('kind', 'hotel', 'roomRatePaise', e.room_rate_paise::text,
        'extraBedRatePaise', e.extra_bed_rate_paise::text, 'noBedRatePaise', e.no_bed_rate_paise::text)
      when 'transfer' then jsonb_build_object('kind', 'transfer', 'vehicleRatePaise', e.vehicle_rate_paise::text)
      when 'flight' then jsonb_build_object('kind', 'flight', 'fareTotalPaise', e.fare_total_paise::text)
    end end
  from public.service_items i
  left join public.service_item_cost_estimates e on e.service_item_id = i.id and e.booking_version_id = p_version
  where i.id = p_item
$$;

-- Per-person prices of a version (commercial readers only; the caller authorizes).
create function authz.bf_prices_json(p_version uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object('category', l.category, 'quantity', l.quantity,
          'purchasePaise', l.purchase_paise::text, 'markupPaise', l.markup_paise::text, 'salePaise', l.sale_paise::text)
        order by array_position(array['adult', 'child_bed', 'child_no_bed', 'infant'], l.category))
      from public.booking_version_price_lines l where l.booking_version_id = v.id), '[]'::jsonb),
    'source', case when authz.prices_in_use(v.id) then 'per_person'
                   when v.source_quotation_version_id is not null then 'quotation_total'
                   when authz.bf_lines_required(v.id) then 'per_person'
                   else 'legacy_total' end,
    'linesRequired', authz.bf_lines_required(v.id),
    'complete', authz.prices_total(v.id) is not null,
    'sellingTotalPaise', (select c.selling_total_paise::text from public.booking_version_commercials c where c.version_id = v.id))
  from public.booking_versions v where v.id = p_version
$$;

-- Review A M1: the selling side of per-person prices (Accounts): category,
-- people and final sale per person; never purchase or markup.
create function authz.bf_prices_sale_json(p_version uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'lines', coalesce((
      select jsonb_agg(jsonb_build_object('category', l.category, 'quantity', l.quantity, 'salePaise', l.sale_paise::text)
        order by array_position(array['adult', 'child_bed', 'child_no_bed', 'infant'], l.category))
      from public.booking_version_price_lines l where l.booking_version_id = v.id and l.quantity > 0), '[]'::jsonb),
    'source', case when authz.prices_in_use(v.id) then 'per_person'
                   when v.source_quotation_version_id is not null then 'quotation_total'
                   when authz.bf_lines_required(v.id) then 'per_person'
                   else 'legacy_total' end,
    'sellingTotalPaise', (select c.selling_total_paise::text from public.booking_version_commercials c where c.version_id = v.id))
  from public.booking_versions v where v.id = p_version
$$;

-- Review A L3: the accepted party also differs when the version's party
-- counts differ from the quotation's (named travellers or not).
create or replace function authz.booking_quote_pax_differs(p_version uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select (exists (select 1 from public.deal_travellers t where t.deal_id = b.deal_id)
      and ((select count(*) from public.deal_travellers t where t.deal_id = b.deal_id and t.traveller_type = 'adult') <> q.adults
        or (select count(*) from public.deal_travellers t where t.deal_id = b.deal_id and t.traveller_type = 'child')
           <> q.children_with_bed + q.children_no_bed
        or (select count(*) from public.deal_travellers t where t.deal_id = b.deal_id and t.traveller_type = 'infant') <> q.infants))
      -- Booking form
      or (b.pax_total is not null and (b.pax_total <> q.adults + q.children_with_bed + q.children_no_bed + q.infants
          or coalesce(b.children_count, 0) <> q.children_with_bed + q.children_no_bed
          or coalesce(b.infants_count, 0) <> q.infants))
    from public.booking_versions b join public.quotation_versions q on q.id = b.source_quotation_version_id
    where b.id = p_version), false)
$$;


-- Replaces 20261120000200: booking form codes (contract section 3).
create or replace function authz.booking_issues(p_version uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select case when v.service_type = 'package' then array_remove(array[
    -- B1.1 revision: a revision does not need the trigger stage (tasks exist already).
    case when v.revises_version_id is null and not authz.deal_in_trigger_stage(d.id) then 'stage_not_confirmed' end,
    case when not exists (select 1 from public.service_item_facts f where f.booking_version_id = v.id) then 'no_services' end,
    case when cardinality(authz.service_item_invalid_nos(v.id)) > 0 then 'service_facts_invalid' end,
    -- B1.1: customer and billing.
    case when not exists (select 1 from public.booking_version_contacts c where c.booking_version_id = v.id)
      then 'contact_missing' end,
    case when exists (select 1 from public.booking_version_contacts c where c.booking_version_id = v.id and not c.contact_confirmed)
      then 'contact_not_confirmed' end,
    case when not exists (select 1 from public.customer_billing_profiles b where b.deal_id = d.id) then 'billing_missing' end,
    -- Booking form: a GST-registered business needs its GSTIN; an
    -- unregistered one does not (its reason is checked below). Profiles saved
    -- before the booking form keep today's rule (business without GSTIN).
    case when 'gstin_missing' = any (authz.bf_billing_codes(d.id, v.id)) then 'gstin_missing' end,
    -- B1.1: trip.
    case when v.trip_destination is null or v.trip_scope is null or v.trip_start is null or v.trip_end is null
      then 'trip_missing' end,
    case when authz.version_travellers_needed(v.id) > 0
          and not exists (select 1 from public.deal_travellers t where t.deal_id = d.id) then 'traveller_missing' end,
    case when exists (select 1 from public.deal_travellers t where t.deal_id = d.id)
          and (select count(*) from public.deal_travellers t where t.deal_id = d.id) < authz.version_travellers_needed(v.id)
          then 'traveller_count_mismatch' end,
    -- B1.1: travellers, participation, identity.
    case when exists (select 1 from public.deal_travellers t
                      where t.deal_id = d.id and t.traveller_type in ('child', 'infant') and t.age_years is null)
      then 'child_age_missing' end,
    case when cardinality(authz.b11_participation_missing_nos(v.id)) > 0 then 'participation_missing' end,
    case when cardinality(authz.b11_identity_missing_seqs(v.id)) > 0 then 'identity_missing' end,
    -- B1.2 (DEC-38): every adult traveller needs a stored identity proof; drafts
    -- only (first and revision drafts), so confirmed versions are not re-checked.
    case when v.status = 'draft' and exists (
           select 1 from public.deal_travellers t
           where t.deal_id = d.id and t.traveller_type = 'adult'
             and not exists (select 1 from public.traveller_id_proofs f where f.traveller_id = t.id and f.status = 'stored'))
      then 'id_proof_missing' end,
    case when not exists (select 1 from public.booking_version_commercials c where c.version_id = v.id)
      then 'missing_selling_total' end,
    -- B1.1: payment plan (DEC-29).
    case when not exists (select 1 from public.booking_version_instalments p where p.booking_version_id = v.id)
      then 'plan_missing' end,
    case when exists (select 1 from public.booking_version_instalments p where p.booking_version_id = v.id)
          and exists (select 1 from public.booking_version_commercials c where c.version_id = v.id)
          and (select sum(p.amount_paise) from public.booking_version_instalments p where p.booking_version_id = v.id)
              <> (select c.selling_total_paise from public.booking_version_commercials c where c.version_id = v.id)
      then 'plan_total_mismatch' end,
    -- Package versions need the customer's acceptance message itself (contract section 5.1 and 9; review E5).
    case when v.revises_version_id is null and not exists (select 1 from public.booking_evidence e
                          where e.version_id = v.id and e.kind = 'acceptance_message' and e.status = 'stored')
          -- B1.2: a draft converted from an accepted quotation carries the customer's written acceptance.
          and not authz.booking_quote_acceptance_ok(v.id)
      then 'missing_acceptance_proof' end,
    -- B1.2 (freeze part 2 section 2.8/2.9): money or material facts changed since conversion.
    case when authz.booking_quote_change(v.id) = 'stale' or authz.booking_quote_party_stale(v.id) then 'quote_acceptance_stale' end,
    -- B1.1 revision (Stage 3 section 8.2).
    -- Review R1: a class is valid only for the changes it was recorded for and
    -- only when the live changes allow it (any later change needs a new class).
    case when v.revises_version_id is not null
          and (v.change_class is null
               or v.changed_fields is distinct from authz.revision_changed_fields(v.id)
               or not (v.change_class = any (authz.revision_allowed_classes(authz.revision_changed_fields(v.id)))))
      then 'revision_class_missing' end,
    case when v.revises_version_id is not null and v.change_class = 'customer_material'
          and not exists (select 1 from public.booking_evidence e
                          where e.version_id = v.id and e.kind = 'acceptance_message' and e.status = 'stored')
      then 'customer_acceptance_required' end,
    case when v.revises_version_id is not null and cardinality(authz.revision_changed_fields(v.id)) = 0 then 'no_changes' end,
    case when v.revises_version_id is not null and not exists (
           select 1 from public.booking_versions b
           join public.accounts_booking_reviews rv on rv.booking_version_id = b.id and rv.status = 'returned'
           where b.id = v.revises_version_id and b.status = 'confirmed')
      then 'base_no_longer_returned' end,
    case when exists (select 1 from public.booking_evidence e where e.version_id = v.id and e.status = 'pending_upload')
      then 'evidence_upload_incomplete' end,
    case when not d.is_synthetic
      and (d.last_verified_at is null or d.last_verified_at < now() - interval '24 hours')
      then 'source_not_recently_verified' end,
    case when authz.booking_gate_issue(d.id) = 'booking_disabled' then 'booking_disabled' end,
    case when authz.booking_gate_issue(d.id) = 'environment_unset' then 'environment_unset' end
  ], null)
  -- Booking form (20261124000120): Bill To and form checks.
  || array_remove(array_remove(authz.bf_billing_codes(d.id, v.id), 'gstin_missing'), 'billing_missing')
  || authz.bf_form_codes(v.id)
  else array_remove(array[
    case when v.hotel_name is null then 'missing_hotel_name' end,
    case when v.city is null then 'missing_city' end,
    case when v.check_in is null or v.check_out is null then 'missing_dates' end,
    case when v.check_out <= v.check_in then 'check_out_not_after_check_in' end,
    case when v.rooms is null then 'missing_rooms' end,
    case when v.adults is null then 'missing_travellers' end,
    case when v.purchase_budget_paise is null then 'missing_purchase_budget' end,
    case when not exists (select 1 from public.booking_version_commercials c where c.version_id = v.id)
      then 'missing_selling_total' end,
    case when not exists (select 1 from public.booking_evidence e where e.version_id = v.id and e.status = 'stored')
      then 'missing_acceptance_proof' end,
    case when exists (select 1 from public.booking_evidence e where e.version_id = v.id and e.status = 'pending_upload')
      then 'evidence_upload_incomplete' end,
    -- STALE_SYNC_HOURS_PROPOSED = 24
    case when not d.is_synthetic
      and (d.last_verified_at is null or d.last_verified_at < now() - interval '24 hours')
      then 'source_not_recently_verified' end,
    case when authz.booking_gate_issue(d.id) = 'booking_disabled' then 'booking_disabled' end,
    case when authz.booking_gate_issue(d.id) = 'environment_unset' then 'environment_unset' end
  ], null) end
  from public.booking_versions v
  join public.deals d on d.id = v.deal_id
  where v.id = p_version
$$;

-- Replaces 20261119000100: price codes read "ask the owner" without commercial scope
-- (never the sign of the markup or the categories).
create or replace function authz.booking_issues_for_viewer(p_version uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select case when authz.can_read_deal_commercial(v.deal_id) then authz.booking_issues(v.id)
              else (select coalesce(array_agg(x order by n), '{}'::text[])
                    from (select x, min(n) as n
                          from unnest(array_replace(array_replace(array_replace(array_replace(array_replace(array_replace(
                                 authz.booking_issues(v.id),
                                 'missing_selling_total', 'missing_selling_total_ask_owner'),
                                 'plan_missing', 'plan_ask_owner'), 'plan_total_mismatch', 'plan_ask_owner'),
                                 -- Booking form
                                 'price_missing', 'prices_ask_owner'), 'price_count_mismatch', 'prices_ask_owner'),
                                 'price_below_purchase', 'prices_ask_owner')) with ordinality as u(x, n)
                          group by x) s)
         end
  from public.booking_versions v where v.id = p_version
$$;


-- Replaces 20261122000100: booking form codes.
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
    if cardinality(v_nos) > 0 then
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

-- Replaces 20261120000600: booking form keys.
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
                                          'infants', v_ver.infants_count) end,
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
        'verifiedAt', v_billing.verified_at) end,
    'travellers', coalesce((
      select jsonb_agg(jsonb_build_object('travellerId', t.id, 'seq', t.seq, 'fullName', t.full_name, 'type', t.traveller_type,
          'ageYears', t.age_years, 'specialNeeds', t.special_needs,
          'identity', case when authz.can_read_traveller_identity(p_deal_id, t.seq)
                           then authz.booking_identity_json(p_deal_id, t.seq, null)
                                -- Booking form: passenger extras (live identity row).
                                || coalesce((select jsonb_build_object('dateOfMarriage', to_char(x.date_of_marriage, 'YYYY-MM-DD'),
                                               'phone', x.phone, 'email', x.email)
                                             from public.traveller_identities x where x.traveller_id = t.id),
                                            jsonb_build_object('dateOfMarriage', null, 'phone', null, 'email', null)) end)
          -- B1.2: identity proofs of this traveller, only for identity-proof viewers (DEC-41).
          || case when v_id_proof_view
                  then jsonb_build_object('idProofs', authz.traveller_id_proofs_json(t.id)) else '{}'::jsonb end
          order by t.seq)
      from public.deal_travellers t where t.deal_id = p_deal_id), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(authz.service_item_json(i.id, v_ver.id, true)
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
      || case when v_ver.id is null then '{}'::jsonb else jsonb_build_object('prices', authz.bf_prices_json(v_ver.id)) end;
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
  return v_result;
end;
$$;

-- Replaces 20261119000300: estimate for the assignee (booking form).
create or replace function authz.purchase_task_json(p_task uuid, p_detail boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  with x as (
    select t.*, i.service_type, i.item_no,
      case when i.service_type = 'hotel'
        then coalesce(f.facts, authz.hotel_facts_of_version(v.id)) else coalesce(f.facts, '{}'::jsonb) end as facts
    from public.fulfilment_tasks t
    join public.service_items i on i.id = t.service_item_id
    join public.booking_versions v on v.id = authz.task_current_version(t.id)
    left join public.service_item_facts f on f.service_item_id = t.service_item_id and f.booking_version_id = v.id
    where t.id = p_task
  )
  select jsonb_build_object(
    'taskId', x.id,
    'dealReference', d.reference,
    'serviceType', x.service_type,
    'itemTitle', coalesce(nullif(authz.service_item_title(x.service_type, x.facts), ''),
                          initcap(x.service_type) || ' ' || x.item_no::text),
    'facts', jsonb_build_object('type', x.service_type, 'facts', x.facts),
    'department', x.department,
    'hotelName', case when x.service_type = 'hotel' then x.facts ->> 'hotelName' end,
    'city', case when x.service_type = 'hotel' then x.facts ->> 'city' end,
    'checkIn', case when x.service_type = 'hotel' then x.facts ->> 'checkIn' end,
    'checkOut', case when x.service_type = 'hotel' then x.facts ->> 'checkOut' end,
    'nights', case when x.service_type = 'hotel' and authz.sf_date(x.facts -> 'checkIn') is not null
                        and authz.sf_date(x.facts -> 'checkOut') is not null
                   then authz.sf_date(x.facts -> 'checkOut') - authz.sf_date(x.facts -> 'checkIn') else 0 end,
    'rooms', case when x.service_type = 'hotel' then coalesce(authz.sf_int_value(x.facts -> 'rooms'), 0) else 0 end,
    'adults', case x.service_type
      when 'hotel' then coalesce(authz.sf_int_value(x.facts -> 'adults'), 0)
      when 'activity' then coalesce(authz.sf_int_value(x.facts -> 'participants'), 0)
      else coalesce(authz.sf_int_value(x.facts -> 'passengers'), 0) end,
    'children', case when x.service_type = 'hotel' then coalesce(authz.sf_int_value(x.facts -> 'children'), 0) else 0 end,
    'purchaseBudgetPaise', coalesce(authz.task_budget(x.id), 0)::text,
    'status', x.status,
    'assigneeName', ap.display_name,
    'assignedToYou', x.assignee_user_id is not distinct from (select auth.uid()),
    'branchName', b.name,
    'createdAt', x.created_at,
    'supplierConfirmedAt', x.supplier_confirmed_at
  ) || case when p_detail then jsonb_build_object(
    'roomType', case when x.service_type = 'hotel' then x.facts ->> 'roomType' end,
    'mealPlan', case when x.service_type = 'hotel' then x.facts ->> 'mealPlan' end,
    'inclusions', case when x.service_type = 'hotel' then x.facts ->> 'inclusions' end,
    'specialRequests', case when x.service_type = 'hotel' then x.facts ->> 'specialRequests' end,
    'confirmedAt', v.confirmed_at,
    'confirmedByName', cp.display_name,
    'versionNo', v.version_no,
    'canClaim', authz.can_claim_purchase_task(x.id) and x.assignee_user_id is null,
    -- B1.1
    'participants', authz.task_participants_json(x.id, false),
    -- B1.1 revision: what changed in the current version (no commercial or contact names).
    'changedFields', to_jsonb(authz.revision_department_fields(v.id))
  )
  -- Booking form: the supplier estimate of this item for its assignee (cost only).
  || case when x.assignee_user_id is not distinct from (select auth.uid())
          then jsonb_build_object('estimate', authz.bf_estimate_json(x.service_item_id, v.id)) else '{}'::jsonb end
  else '{}'::jsonb end
  from x
  join public.booking_versions v on v.id = authz.task_current_version(x.id)
  join public.deals d on d.id = x.deal_id
  join public.branches b on b.id = x.branch_id
  left join public.staff_profiles ap on ap.user_id = x.assignee_user_id
  left join public.staff_profiles cp on cp.user_id = v.confirmed_by
$$;

-- Replaces 20261119000300: estimate and screenshots for the assignee (booking form).
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

-- Replaces 20261119000300: Bill To and per-person prices (booking form).
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

-- Replaces 20261119000300: field names for viewers without commercial scope (review A L1).
create or replace function public.booking_version_history(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_commercial boolean;
  v_editor boolean;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_deal_id is null or not authz.can_read_service_rows(p_deal_id) then
    return null;
  end if;
  v_commercial := authz.can_read_deal_commercial(p_deal_id);
  v_editor := authz.can_edit_booking_draft(p_deal_id) or authz.can_confirm_booking(p_deal_id);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'versionId', v.id, 'versionNo', v.version_no, 'status', v.status, 'serviceType', v.service_type,
        'confirmedAt', v.confirmed_at, 'revisesVersionId', v.revises_version_id, 'changeClass', v.change_class,
        -- Booking form (review A L1): no price, plan or billing names without commercial scope.
        'changedFields', to_jsonb(case when v_commercial then coalesce(v.changed_fields, '{}'::text[])
          else array(select f from unnest(coalesce(v.changed_fields, '{}'::text[])) f
                     where f !~ '^(sellingTotal|listPrice|discount|plan|prices|billing)') end),
        'supersededAt', v.superseded_at,
        'discardedAt', v.discarded_at,
        'reviewStatus', case when v.status in ('confirmed', 'superseded') then coalesce(rv.status, 'pending') end,
        'reviewReason', case when v_editor and rv.status = 'returned' and rv.reason_shared_with_sales then rv.return_reason end,
        'reviewReasonHidden', coalesce(rv.status = 'returned' and not (v_editor and rv.reason_shared_with_sales), false))
      || case when v_commercial then jsonb_build_object(
           'sellingTotalPaise', c.selling_total_paise::text,
           'sellingTotalDeltaPaise', case when v.revises_version_id is not null then (c.selling_total_paise - cb.selling_total_paise)::text end)
         else '{}'::jsonb end
      order by v.version_no)
    from public.booking_versions v
    left join public.accounts_booking_reviews rv on rv.booking_version_id = v.id
    left join public.booking_version_commercials c on c.version_id = v.id
    left join public.booking_version_commercials cb on cb.version_id = v.revises_version_id
    where v.deal_id = p_deal_id), '[]'::jsonb);
end;
$$;

-- Replaces 20261122000100: form rules 2, party counts and line quantities (booking form).
create or replace function public.quotation_convert_to_booking(p_version_id uuid, p_expected_content_hash text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_q public.quotations%rowtype;
  v_conv public.quotation_conversions%rowtype;
  v_deal uuid;
  v_opened jsonb;
  v_booking uuid;
  v_rv integer;
  v_added jsonb;
  v_item record;
  v_count integer := 0;
  v_contacts public.quotation_version_contacts%rowtype;
  v_auto text[];  -- Batch 2
  v_party integer;  -- booking form
begin
  v_ver := authz.lock_quotation_version(p_version_id);
  select * into v_q from public.quotations q where q.id = v_ver.quotation_id;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into v_conv from public.quotation_conversions c where c.quotation_version_id = v_ver.id;
  if v_conv.id is not null then
    return jsonb_build_object('outcome', 'existing', 'bookingVersionId', v_conv.booking_version_id, 'dealId', v_conv.deal_id,
      'itemsCreated', v_conv.items_created);
  end if;
  if v_ver.status <> 'accepted' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_expected_content_hash is distinct from v_ver.content_hash
     or v_ver.content_hash is distinct from authz.quotation_content_hash(v_ver.id) then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_deal := coalesce(v_q.deal_id, v_q.linked_deal_id);
  if v_deal is null then
    raise exception 'deal_link_required' using errcode = '55000';
  end if;
  perform authz.refuse_removed_deal(v_deal);
  if not authz.can_edit_booking_draft(v_deal) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not authz.service_items_enabled() then
    raise exception 'service_items_disabled' using errcode = '55000';
  end if;
  if authz.deal_not_active(v_deal) then
    raise exception 'deal_not_active' using errcode = '55000';
  end if;
  -- Opens (or reuses) the package draft; refuses already_confirmed.
  -- Booking form: the draft follows form rules 2 (a reused empty draft moves 1 -> 2).
  perform set_config('tripnavigate.booking_form_rules', '2', true);
  v_opened := public.booking_open_draft(v_deal);
  v_booking := (v_opened ->> 'versionId')::uuid;
  v_rv := (v_opened ->> 'rowVersion')::integer;
  -- Batch 2 (BC-A3, F.1.3, Echo L8): values written only by the creation
  -- fill (mark from_bitrix, applied_via auto_fill, no staff history) are not
  -- staff content; neither are the fill's unmarked contact defaults. Any
  -- other content still refuses draft_not_empty.
  if exists (select 1 from public.booking_versions b
             where b.id = v_booking
               and (b.service_type <> 'package' or b.revises_version_id is not null
                    or b.trip_destination is not null or b.trip_scope is not null
                    -- Booking form: party counts are staff content.
                    or b.pax_total is not null or b.children_count is not null or b.infants_count is not null
                    or (b.trip_start is not null and not authz.prefill_auto_untouched('booking_version', b.id, 'trip.start'))
                    or (b.trip_end is not null and not authz.prefill_auto_untouched('booking_version', b.id, 'trip.end'))))
     or exists (select 1 from public.service_item_facts f where f.booking_version_id = v_booking)
     -- Echo L3 (F.1.3): on a draft that received the creation fill, any staff
     -- history (typed or cleared) is staff content. Drafts without a creation
     -- fill keep today's rule exactly (switch off = today).
     or (exists (select 1 from public.prefill_marks m
                 where m.target_kind = 'booking_version' and m.target_id = v_booking and m.applied_via = 'auto_fill')
         and exists (select 1 from public.prefill_field_history h
                     where h.target_kind = 'booking_version' and h.target_id = v_booking))
     or exists (select 1 from public.booking_version_contacts c
                where c.booking_version_id = v_booking
                  and not (authz.prefill_auto_untouched('booking_version', v_booking, 'contacts.contactName')
                           and (c.mobile is null or authz.prefill_auto_untouched('booking_version', v_booking, 'contacts.mobile'))
                           and (c.email is null or authz.prefill_auto_untouched('booking_version', v_booking, 'contacts.email'))
                           and (c.booking_for = 'individual'
                                or authz.prefill_auto_untouched('booking_version', v_booking, 'contacts.bookingFor'))
                           and not c.payer_different and c.payer_name is null and not c.contact_confirmed
                           and not exists (select 1 from public.prefill_field_history h
                                           where h.target_kind = 'booking_version' and h.target_id = v_booking
                                             and h.field_code like 'contacts.%')))
     or exists (select 1 from public.booking_version_commercials c where c.version_id = v_booking)
     or exists (select 1 from public.booking_version_instalments p where p.booking_version_id = v_booking)
     -- Booking form.
     or exists (select 1 from public.booking_version_price_lines l where l.booking_version_id = v_booking) then
    raise exception 'draft_not_empty' using errcode = '55000';
  end if;
  update public.booking_versions b set form_rules = 2 where b.id = v_booking and b.form_rules = 1;
  perform set_config('tripnavigate.booking_form_rules', '', true);
  -- The quotation's party (never more than the booking form's limit).
  v_party := v_ver.adults + v_ver.children_with_bed + v_ver.children_no_bed + v_ver.infants;
  if v_party not between 1 and 100 then
    v_party := null;
  end if;
  select coalesce(array_agg(m.field_code order by m.field_code), '{}'::text[]) into v_auto
  from public.prefill_marks m
  where m.target_kind = 'booking_version' and m.target_id = v_booking
    and authz.prefill_auto_untouched('booking_version', v_booking, m.field_code);

  insert into public.quotation_conversions (quotation_version_id, quotation_id, legal_entity_id, deal_id, booking_version_id,
    accepted_tier, request_id, created_by)
  values (v_ver.id, v_q.id, v_q.legal_entity_id, v_deal, v_booking, v_ver.accepted_tier, p_request_id, (select auth.uid()))
  returning * into v_conv;

  if coalesce(v_ver.trip_destination, v_ver.trip_scope) is not null or coalesce(v_ver.trip_start, v_ver.trip_end) is not null
     or v_party is not null then
    v_rv := (public.booking_trip_save(v_booking, v_rv, jsonb_build_object('destination', v_ver.trip_destination,
      'scope', v_ver.trip_scope, 'start', to_char(v_ver.trip_start, 'YYYY-MM-DD'), 'end', to_char(v_ver.trip_end, 'YYYY-MM-DD'))
      -- Booking form: the accepted party counts.
      || case when v_party is null then '{}'::jsonb
              else jsonb_build_object('paxTotal', v_party, 'children', v_ver.children_with_bed + v_ver.children_no_bed,
                                      'infants', v_ver.infants) end) ->> 'rowVersion')::integer;
  end if;
  select * into v_contacts from public.quotation_version_contacts c where c.quotation_version_id = v_ver.id;
  if v_contacts.quotation_version_id is not null then
    -- "Booking for" from the quotation (DEC-45 via prefill), else individual; staff confirm the contact.
    v_rv := (public.booking_contacts_save(v_booking, v_rv, jsonb_build_object('contactName', v_contacts.contact_name,
      'mobile', v_contacts.mobile, 'email', v_contacts.email, 'contactConfirmed', false,
      'bookingFor', coalesce(v_contacts.booking_for, 'individual'),
      'payerDifferent', false, 'payerName', null)) ->> 'rowVersion')::integer;
  end if;
  for v_item in
    select i.id, i.service_type, i.facts from public.quotation_version_items i
    where i.quotation_version_id = v_ver.id and (i.tier_key is null or i.tier_key = v_ver.accepted_tier)
    order by i.item_no
  loop
    v_added := public.service_item_add(v_booking, v_rv, v_item.service_type, v_item.facts, 0::bigint,
      md5(p_request_id::text || ':' || v_item.id::text)::uuid);
    v_rv := (v_added ->> 'rowVersion')::integer;
    insert into public.quotation_conversion_items (conversion_id, quotation_item_id, service_item_id)
    values (v_conv.id, v_item.id, (v_added ->> 'itemId')::uuid);
    v_count := v_count + 1;
  end loop;
  perform authz.quotation_money_to_booking(v_ver.id, v_booking, v_ver.accepted_tier);
  -- Booking form: per-person line quantities only (never amounts; the accepted total stays).
  if v_party is not null then
    insert into public.booking_version_price_lines (booking_version_id, legal_entity_id, deal_id, category, quantity, updated_by)
    select v_booking, v_q.legal_entity_id, v_deal, c.category, c.quantity, (select auth.uid())
    from (values ('adult', v_ver.adults), ('child_bed', v_ver.children_with_bed),
                 ('child_no_bed', v_ver.children_no_bed), ('infant', v_ver.infants)) as c(category, quantity);
  end if;
  -- Batch 2 (BC-A3): accepted quotation facts replaced the automatic values.
  update public.prefill_marks m set state = 'replaced_by_quotation', checked_by = null, checked_at = null
  where m.target_kind = 'booking_version' and m.target_id = v_booking and m.field_code = any (v_auto);
  update public.booking_versions b
  set source_quotation_version_id = v_ver.id, source_quotation_hash = v_ver.content_hash, source_accepted_tier = v_ver.accepted_tier
  where b.id = v_booking;
  update public.quotation_conversions c
  set items_created = v_count,
      money_signature = authz.booking_quote_money_signature(v_booking),
      facts_signature = authz.booking_quote_facts_signature(v_booking),
      minor_signature = authz.booking_quote_minor_signature(v_booking)
  where c.id = v_conv.id;
  update public.quotations q set converted_at = now(), row_version = q.row_version + 1, updated_at = now() where q.id = v_q.id;
  perform authz.write_audit('quotation.converted', v_q.legal_entity_id, v_q.branch_id, 'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_q.id, 'dealId', v_deal, 'bookingVersionId', v_booking, 'itemsCreated', v_count,
      'tierKey', v_ver.accepted_tier)
    || case when cardinality(v_auto) > 0 then jsonb_build_object('replacedAutoFields', to_jsonb(v_auto)) else '{}'::jsonb end);
  return jsonb_build_object('outcome', 'created', 'bookingVersionId', v_booking, 'dealId', v_deal, 'itemsCreated', v_count);
end;
$$;

revoke all on function
  authz.bf_hotel_coverage(uuid),
  authz.bf_hotel_outside_nos(uuid),
  authz.bf_dates_outside_nos(uuid),
  authz.bf_billing_codes(uuid, uuid),
  authz.bf_form_codes(uuid),
  authz.bf_estimate_json(uuid, uuid),
  authz.bf_prices_json(uuid),
  authz.bf_prices_sale_json(uuid),
  authz.booking_quote_pax_differs(uuid)
from public, anon, authenticated, service_role;

revoke all on function
  public.booking_open_revision(uuid),
  public.booking_version_history(uuid),
  public.intake_checklist(uuid),
  public.booking_form_get(uuid),
  public.accounts_deal_detail(uuid),
  public.quotation_convert_to_booking(uuid, text, uuid)
from public, anon, authenticated, service_role;
grant execute on function
  public.booking_open_revision(uuid),
  public.booking_version_history(uuid),
  public.intake_checklist(uuid),
  public.booking_form_get(uuid),
  public.accounts_deal_detail(uuid),
  public.quotation_convert_to_booking(uuid, text, uuid)
to authenticated;

commit;
