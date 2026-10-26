-- TripNavigate CRM - Book now v2 (owner-approved prototype, 26 October 2026),
-- part 2: commands.
--
-- Frozen contract: docs/implementation/booking-form-v2-2026-10-26/contract.md
-- and build-plan.md section 5.2 (Agent B). Owner decisions of 26 October 2026
-- relayed by the lead: D2 option (a) (Purchase budget set from the "Our cost"
-- estimate) and D4 (only named passengers are chosen on services; hotel adults
-- and children follow the chosen people).
--
-- What changes (every replaced function keeps its signature; lines marked BF2):
--   1. authz.validate_service_facts (replaces 20261128000110):
--      hotel + requestItems; flight + entryMode, screenshotNote, requestItems,
--      isReturn, and 0..8 segments when entryMode = 'screenshot' (else 1..8);
--      transfer + carKind, flightItemId (uuid format only).
--   2. authz.service_item_title (replaces 20261119000100): "From screenshot"
--      for a screenshot flight.
--   3. authz.bf_estimate_write (replaces 20261124000110): flight fare per
--      person (fareAdultPaise, fareChildPaise, fareInfantPaise);
--      fareTotalPaise is accepted only unchanged and is never written.
--   4. authz.bf2_estimate_total (new): the item's estimate total as the form
--      shows it (hotel, car); the source of the automatic Purchase budget.
--   5. public.booking_service_save (replaces 20261128000110):
--      a. keys the v2 drawers no longer show are kept from the stored facts
--         when the post leaves them out (a key posted as null clears it):
--         hotel area, exclusions, preferences, bedRemarks, childAges (dropped
--         when it no longer matches the children count), mode (only while no
--         hotel name is posted); transfer includedKms, vendor; flight
--         assistance, tripType, isReturn and legs 2..8 (a typed post with one
--         leg keeps the stored later legs, lead ruling D7); visa applyBy;
--         passport neededBy. Requests: when neither requestItems nor the
--         readable text is posted, both stay as stored.
--      b. requestItems ("for whom"): each forSeq must be a participant of the
--         item; the server writes the readable text into specialRequests
--         (hotel) or preferences (flight), e.g. "Wheelchair help (Child C),
--         Vegetarian meal".
--      c. D4: a hotel posted without adults and with chosen participants takes
--         adults = chosen adults and children = chosen children + infants
--         (no adult chosen: the booking adults, as before).
--      d. a screenshot flight's passengers = its participant count.
--      e. D2: while staff never typed a budget (a v2 post sends none; a stored
--         0 counts as never typed), a hotel, car or activity's Purchase budget
--         is set from its estimate on every save of a first draft (no
--         estimate = 0 = no budget); a revision draft keeps the copied budget.
--         A posted budget is kept as typed.
--      f. review round 1: hotel children stay unless travellers are chosen;
--         kept requests are re-checked against the item's travellers (someone
--         no longer on the item = for everyone) and their text written again;
--         a car's flightItemId must be a flight of the same booking version.
--   6. public.booking_flight_fares_save (new): the typed total fare per
--      person of all flights (commercial readers who may edit the draft).
--   7. public.booking_flight_returns_add (new): one transaction adding every
--      typed onward flight reversed, dated to the trip end, isReturn true,
--      no fares, same travellers.
--   8. public.booking_open_revision (replaces 20261124000120): copies the
--      fare columns, the flight fares row and the automatic budget flag.
--   9. authz.booking_package_hash_row (replaces 20261128000110): a version's
--      hash also covers the fare per person and the typed flight totals,
--      only when such values exist (every existing hash is unchanged; no new
--      hash schema).
--  10. authz.revision_field_class / authz.revision_changed_fields (replace
--      20261128000110): the new keys, the fare per person and the typed
--      flight totals (internal, like the estimates).
--
-- Never: no selling value in facts, estimates or audit details (ids only);
-- Purchase never receives fares, selling price, margin or payment proof.
--
-- Refusal tokens (message is exactly the token): 42501 not_authorized;
-- 22023 invalid_input (hint names the field); 40001 version_changed /
-- request_conflict; P0002 not_found; 55000 already_confirmed,
-- service_items_disabled, deal_not_active, revision_items_fixed;
-- 22023 too_many_items.
--
-- Rollback (forward-only): a NEW migration restoring the previous bodies
-- (20261128000110, 20261124000110, 20261124000120, 20261119000100) and
-- revoking execute on the two new commands; stored rows stay valid.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Requests "for whom" (helpers; no table writes)
-- ===========================================================================

-- Shape of requestItems: an array of at most 20 {text, forSeq}; text 1..80
-- characters, already trimmed, no control characters, unique ignoring case;
-- forSeq null (everyone) or a traveller seq 1..100.
create function authz.bf2_request_items_ok(p_items jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select case
    when p_items is null or jsonb_typeof(p_items) = 'null' then true
    when jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 20 then false
    else not exists (
           select 1 from jsonb_array_elements(p_items) e
           where jsonb_typeof(e) <> 'object'
              or exists (select 1 from jsonb_object_keys(e) k where k not in ('text', 'forSeq'))
              or jsonb_typeof(e -> 'text') is distinct from 'string'
              or length(e ->> 'text') not between 1 and 80
              or (e ->> 'text') <> btrim(e ->> 'text', E' \t\r\n')
              or (e ->> 'text') ~ E'[\\x01-\\x1f\\x7f]'
              or not (coalesce(jsonb_typeof(e -> 'forSeq'), 'null') = 'null'
                      or authz.sf_int_ok(e -> 'forSeq', 1, 100, true)))
         and (select count(*) from jsonb_array_elements(p_items) e)
             = (select count(distinct lower(e ->> 'text')) from jsonb_array_elements(p_items) e)
  end
$$;

-- Readable text of requestItems, in their order: "Baby cot (Asha Rao), Early
-- check-in". The name is the traveller's name at save time. Null when empty.
create function authz.bf2_request_text(p_deal uuid, p_items jsonb) returns text
language sql stable security definer set search_path = '' as $$
  select nullif(string_agg(
           (e.v ->> 'text') || coalesce(' (' || t.full_name || ')', ''), ', ' order by e.n), '')
  from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end)
       with ordinality as e(v, n)
  left join public.deal_travellers t
    on t.deal_id = p_deal and t.seq = authz.sf_int_value(e.v -> 'forSeq')
$$;

-- ===========================================================================
-- 2. Facts rule (replaces 20261128000110; lines marked BF2)
-- ===========================================================================

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
  v_entry text;  -- BF2
  v_min_legs integer;  -- BF2
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
                            'extraBeds', 'childrenWithoutBed', 'bedRemarks',
                            -- VN: hotel catalogue row (format only).
                            'catalogueHotelId',
                            -- BF2: requests "for whom".
                            'requestItems']
    when 'transfer' then array['route', 'date', 'vehicleType', 'passengers', 'pickupTime', 'notes', 'pickup', 'drop',
                               -- Booking form: car end date, vehicles, included kilometres, preferred vendor.
                               'endDate', 'quantity', 'includedKms', 'vendor',
                               -- BF2: car type and the flight it meets.
                               'carKind', 'flightItemId']
    when 'activity' then array['name', 'city', 'date', 'participants', 'time', 'notes', 'inclusions']
    when 'flight' then array['segments', 'passengers', 'preferredTime', 'cabin', 'notes', 'tripType', 'preferences', 'assistance',
                             -- BF2
                             'entryMode', 'screenshotNote', 'requestItems', 'isReturn']
    when 'visa' then array['country', 'purpose', 'travelDate', 'applyBy', 'feePaidBy', 'notes']
    else array['applicationType', 'officeCity', 'neededBy', 'notes'] end;
  for v_key in select k from jsonb_object_keys(p_facts) k loop
    if v_key <> all (v_allowed) then
      v_bad := v_bad || v_key;
    end if;
  end loop;

  -- BF2: requests "for whom" (hotel and flight).
  if p_type in ('hotel', 'flight') and not authz.bf2_request_items_ok(p_facts -> 'requestItems') then
    v_bad := v_bad || 'requestItems'::text;
  end if;

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
    -- VN: adults optional (booking_service_save fills them from the booking).
    if not authz.sf_int_ok(p_facts -> 'adults', 1, 100, false) then v_bad := v_bad || 'adults'::text; end if;
    if p_facts ? 'catalogueHotelId' and jsonb_typeof(p_facts -> 'catalogueHotelId') <> 'null'
       and (jsonb_typeof(p_facts -> 'catalogueHotelId') <> 'string'
            or (p_facts ->> 'catalogueHotelId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      v_bad := v_bad || 'catalogueHotelId'::text;
    end if;
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
    -- BF2: car type (fixed list) and the flight it meets (format only).
    if p_facts ? 'carKind' and jsonb_typeof(p_facts -> 'carKind') <> 'null'
       and (jsonb_typeof(p_facts -> 'carKind') <> 'string'
            or (p_facts ->> 'carKind') not in ('airport_pickup', 'airport_drop', 'full_trip', 'point_to_point')) then
      v_bad := v_bad || 'carKind'::text;
    end if;
    if p_facts ? 'flightItemId' and jsonb_typeof(p_facts -> 'flightItemId') <> 'null'
       and (jsonb_typeof(p_facts -> 'flightItemId') <> 'string'
            or (p_facts ->> 'flightItemId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') then
      v_bad := v_bad || 'flightItemId'::text;
    end if;
  elsif p_type = 'activity' then
    if not authz.sf_text_ok(p_facts -> 'name', 200, true) then v_bad := v_bad || 'name'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'city', 120, true) then v_bad := v_bad || 'city'::text; end if;
    if authz.sf_date(p_facts -> 'date') is null then v_bad := v_bad || 'date'::text; end if;
    if not authz.sf_int_ok(p_facts -> 'participants', 1, 100, true) then v_bad := v_bad || 'participants'::text; end if;
    if not authz.sf_time_ok(p_facts -> 'time', false) then v_bad := v_bad || 'time'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'notes', 2000, false) then v_bad := v_bad || 'notes'::text; end if;
    if not authz.sf_text_ok(p_facts -> 'inclusions', 2000, false) then v_bad := v_bad || 'inclusions'::text; end if;
  elsif p_type = 'flight' then
    -- BF2: entry mode (absent = typed).
    v_entry := case when coalesce(jsonb_typeof(p_facts -> 'entryMode'), 'null') = 'null' then 'typed'
                    when jsonb_typeof(p_facts -> 'entryMode') = 'string' then p_facts ->> 'entryMode' end;
    if v_entry is null or v_entry not in ('typed', 'screenshot') then
      v_bad := v_bad || 'entryMode'::text;
    end if;
    v_min_legs := case when v_entry = 'screenshot' then 0 else 1 end;
    if p_facts -> 'segments' is null or jsonb_typeof(p_facts -> 'segments') <> 'array'
       -- BF2: a screenshot flight may have no typed leg.
       or jsonb_array_length(p_facts -> 'segments') not between v_min_legs and 8 then
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
    -- BF2: the note for the Flight team belongs to a screenshot flight only.
    if not authz.sf_text_ok(p_facts -> 'screenshotNote', 200, false)
       or (coalesce(jsonb_typeof(p_facts -> 'screenshotNote'), 'null') <> 'null' and v_entry is distinct from 'screenshot') then
      v_bad := v_bad || 'screenshotNote'::text;
    end if;
    if p_facts ? 'isReturn' and jsonb_typeof(p_facts -> 'isReturn') not in ('boolean', 'null') then
      v_bad := v_bad || 'isReturn'::text;
    end if;
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

-- Replaces 20261119000100 (line marked BF2).
create or replace function authz.service_item_title(p_type text, p_facts jsonb) returns text
language sql immutable set search_path = '' as $$
  select case p_type
    when 'hotel' then concat_ws(' · ', coalesce(nullif(p_facts ->> 'hotelName', ''), nullif(left(p_facts ->> 'preferences', 60), '')),
                                nullif(p_facts ->> 'city', ''))
    when 'transfer' then coalesce(nullif(p_facts ->> 'route', ''),
                                  nullif(concat_ws(' to ', nullif(p_facts ->> 'pickup', ''), nullif(p_facts ->> 'drop', '')), ''))
    when 'activity' then concat_ws(' · ', nullif(p_facts ->> 'name', ''), nullif(p_facts ->> 'city', ''))
    when 'visa' then concat_ws(' · ', nullif(p_facts ->> 'country', ''), nullif(p_facts ->> 'purpose', ''))
    when 'passport' then concat_ws(' · ', nullif(initcap(p_facts ->> 'applicationType'), ''), nullif(p_facts ->> 'officeCity', ''))
    -- BF2: a flight added from a screenshot.
    when 'flight' then case when p_facts ->> 'entryMode' = 'screenshot' then 'From screenshot'
      else (select string_agg(concat_ws(' to ', s ->> 'from', s ->> 'to'), ', ')
            from jsonb_array_elements(case when jsonb_typeof(p_facts -> 'segments') = 'array'
                                           then p_facts -> 'segments' else '[]'::jsonb end) s) end
    else (select string_agg(concat_ws(' to ', s ->> 'from', s ->> 'to'), ', ')
          from jsonb_array_elements(case when jsonb_typeof(p_facts -> 'segments') = 'array'
                                         then p_facts -> 'segments' else '[]'::jsonb end) s)
  end
$$;

-- ===========================================================================
-- 3. Estimates (replaces 20261124000110 bf_estimate_write; lines marked BF2)
-- ===========================================================================

create or replace function authz.bf_estimate_write(p_ver public.booking_versions, p_item public.service_items, p_estimate jsonb)
returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_keys text[];
  v_bad text[] := '{}'::text[];
  v_k text;
  v_a record;
  v_vals jsonb := '{}'::jsonb;
  v_old public.service_item_cost_estimates%rowtype;
  v_room bigint; v_extra bigint; v_nobed bigint; v_vehicle bigint; v_fare bigint;
  v_adult bigint; v_child bigint; v_infant bigint;  -- BF2
begin
  v_keys := case p_item.service_type
    when 'hotel' then array['roomRatePaise', 'extraBedRatePaise', 'noBedRatePaise']
    when 'transfer' then array['vehicleRatePaise']
    -- BF2: fare per person; the older total is accepted only unchanged.
    when 'flight' then array['fareTotalPaise', 'fareAdultPaise', 'fareChildPaise', 'fareInfantPaise'] end;
  if v_keys is null or jsonb_typeof(p_estimate) <> 'object'
     or cardinality(authz.b11_unknown_keys(p_estimate, v_keys || 'kind'::text)) > 0
     or (p_estimate ? 'kind' and (p_estimate ->> 'kind') is distinct from p_item.service_type) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'estimate';
  end if;
  foreach v_k in array v_keys loop
    select * into v_a from authz.bf_paise(p_estimate -> v_k, false);
    if not v_a.ok then
      v_bad := v_bad || ('estimate.' || v_k);
    else
      v_vals := v_vals || jsonb_build_object(v_k, v_a.amount);
    end if;
  end loop;
  select * into v_old from public.service_item_cost_estimates e
  where e.booking_version_id = p_ver.id and e.service_item_id = p_item.id for update;
  -- BF2: the v2 form never writes the older flight total.
  if p_item.service_type = 'flight' and p_estimate ? 'fareTotalPaise'
     and (v_vals ->> 'fareTotalPaise')::bigint is distinct from v_old.fare_total_paise
     and not ('estimate.fareTotalPaise' = any (v_bad)) then
    v_bad := v_bad || 'estimate.fareTotalPaise'::text;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  v_room := (v_vals ->> 'roomRatePaise')::bigint;
  v_extra := (v_vals ->> 'extraBedRatePaise')::bigint;
  v_nobed := (v_vals ->> 'noBedRatePaise')::bigint;
  v_vehicle := (v_vals ->> 'vehicleRatePaise')::bigint;
  -- BF2
  v_fare := v_old.fare_total_paise;
  v_adult := (v_vals ->> 'fareAdultPaise')::bigint;
  v_child := (v_vals ->> 'fareChildPaise')::bigint;
  v_infant := (v_vals ->> 'fareInfantPaise')::bigint;
  if coalesce(v_room, v_extra, v_nobed, v_vehicle, v_fare, v_adult, v_child, v_infant) is null then
    if v_old.service_item_id is null then
      return false;
    end if;
    delete from public.service_item_cost_estimates e where e.booking_version_id = p_ver.id and e.service_item_id = p_item.id;
    return true;
  end if;
  if v_old.service_item_id is not null
     and (v_old.room_rate_paise, v_old.extra_bed_rate_paise, v_old.no_bed_rate_paise, v_old.vehicle_rate_paise, v_old.fare_total_paise,
          v_old.fare_adult_paise, v_old.fare_child_paise, v_old.fare_infant_paise)
         is not distinct from (v_room, v_extra, v_nobed, v_vehicle, v_fare, v_adult, v_child, v_infant) then
    return false;
  end if;
  insert into public.service_item_cost_estimates as e (booking_version_id, service_item_id, legal_entity_id,
    room_rate_paise, extra_bed_rate_paise, no_bed_rate_paise, vehicle_rate_paise, fare_total_paise,
    fare_adult_paise, fare_child_paise, fare_infant_paise, updated_by)
  values (p_ver.id, p_item.id, p_ver.legal_entity_id, v_room, v_extra, v_nobed, v_vehicle, v_fare,
    v_adult, v_child, v_infant, (select auth.uid()))
  on conflict (booking_version_id, service_item_id) do update
    set room_rate_paise = excluded.room_rate_paise, extra_bed_rate_paise = excluded.extra_bed_rate_paise,
        no_bed_rate_paise = excluded.no_bed_rate_paise, vehicle_rate_paise = excluded.vehicle_rate_paise,
        fare_total_paise = excluded.fare_total_paise,
        fare_adult_paise = excluded.fare_adult_paise, fare_child_paise = excluded.fare_child_paise,
        fare_infant_paise = excluded.fare_infant_paise, updated_by = excluded.updated_by;
  return true;
end;
$$;

-- Estimate total of one item in one version, the rule the form shows
-- (booking-form-model.ts): hotel = nights x (rooms x room rate + extra beds x
-- extra-bed rate + no-bed guests x no-bed rate), a rate needed only when its
-- count is above 0; car = vehicles (default 1) x rate per vehicle. Null =
-- unknown (no estimate, a missing rate, or another service type). The caller
-- authorizes; never returned to a client.
create function authz.bf2_estimate_total(p_item uuid, p_version uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select case i.service_type
    when 'hotel' then case
      when (authz.sf_date(f.facts -> 'checkOut') - authz.sf_date(f.facts -> 'checkIn')) not between 1 and 365 then null
      when coalesce(authz.sf_int_value(f.facts -> 'rooms'), 0) < 1 or e.room_rate_paise is null then null
      when coalesce(authz.sf_int_value(f.facts -> 'extraBeds'), 0) > 0 and e.extra_bed_rate_paise is null then null
      when coalesce(authz.sf_int_value(f.facts -> 'childrenWithoutBed'), 0) > 0 and e.no_bed_rate_paise is null then null
      else (authz.sf_date(f.facts -> 'checkOut') - authz.sf_date(f.facts -> 'checkIn'))::bigint
           * (authz.sf_int_value(f.facts -> 'rooms')::bigint * e.room_rate_paise
              + coalesce(authz.sf_int_value(f.facts -> 'extraBeds'), 0)::bigint * coalesce(e.extra_bed_rate_paise, 0)
              + coalesce(authz.sf_int_value(f.facts -> 'childrenWithoutBed'), 0)::bigint * coalesce(e.no_bed_rate_paise, 0)) end
    when 'transfer' then case
      when e.vehicle_rate_paise is null or coalesce(authz.sf_int_value(f.facts -> 'quantity'), 1) < 1 then null
      else coalesce(authz.sf_int_value(f.facts -> 'quantity'), 1)::bigint * e.vehicle_rate_paise end
  end
  from public.service_items i
  join public.service_item_facts f on f.service_item_id = i.id and f.booking_version_id = p_version
  left join public.service_item_cost_estimates e on e.service_item_id = i.id and e.booking_version_id = p_version
  where i.id = p_item
$$;

-- ===========================================================================
-- 4. Service save (replaces 20261128000110; lines marked BF2)
-- ===========================================================================

create or replace function public.booking_service_save(p_version_id uuid, p_expected_row_version integer, p_item_id uuid,
  p_service_type text, p_facts jsonb, p_purchase_budget_paise bigint, p_estimate jsonb, p_participants integer[],
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_item public.service_items%rowtype;
  v_payload jsonb := jsonb_build_object('versionId', p_version_id, 'expectedRowVersion', p_expected_row_version,
    'itemId', p_item_id, 'serviceType', p_service_type, 'facts', p_facts, 'budget', p_purchase_budget_paise,
    'estimate', p_estimate, 'participants', to_jsonb(p_participants));
  v_result jsonb;
  v_res jsonb;
  v_rv integer;
  v_budget bigint;
  -- VN
  v_facts jsonb := p_facts;
  v_defaulted boolean := false;
  v_type text;
  v_def integer;
  -- BF2
  v_old public.service_item_facts%rowtype;
  v_k text;
  v_seqs integer[];
  v_adults integer;
  v_kids integer;
  v_text text;
  v_target text;
  v_auto boolean := false;
  v_new_budget bigint;
begin
  v_ver := authz.lock_package_draft(p_version_id);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_ver.legal_entity_id, p_request_id, 'booking_service_save', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_estimate is not null and jsonb_typeof(p_estimate) <> 'null' and not authz.can_read_deal_commercial(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_rv := v_ver.row_version;

  -- VN: hotel adults absent = the booking adults (followed by trip saves).
  v_type := case when p_item_id is null then p_service_type
                 else (select i.service_type from public.service_items i where i.id = p_item_id and i.deal_id = v_ver.deal_id) end;

  -- BF2: the stored row of an edit, and the participants the item will have
  -- (posted, else the stored ones on an edit, else every traveller on an add).
  if p_item_id is not null then
    select f.* into v_old from public.service_item_facts f
    where f.service_item_id = p_item_id and f.booking_version_id = v_ver.id;
  end if;
  v_seqs := coalesce(p_participants,
    case when p_item_id is not null then authz.item_participant_seqs(p_item_id, v_ver.id)
         else (select coalesce(array_agg(t.seq order by t.seq), '{}'::integer[]) from public.deal_travellers t
               where t.deal_id = v_ver.deal_id
                 and (v_type <> 'passport'
                      or t.seq = (select min(t2.seq) from public.deal_travellers t2 where t2.deal_id = v_ver.deal_id))) end);

  if jsonb_typeof(p_facts) = 'object' then
    -- BF2 (a): keys the v2 drawers no longer show stay as stored when the post
    -- leaves them out; a key posted as null clears it.
    if v_old.id is not null then
      foreach v_k in array case v_type
          -- Children too: only chosen travellers recount them (D4, below).
          when 'hotel' then array['area', 'exclusions', 'preferences', 'bedRemarks', 'childAges', 'children']
          when 'transfer' then array['includedKms', 'vendor']
          when 'flight' then array['assistance', 'tripType', 'isReturn']
          when 'visa' then array['applyBy']
          when 'passport' then array['neededBy']
          else '{}'::text[] end
      loop
        if not (p_facts ? v_k) and (v_old.facts ? v_k) then
          v_facts := v_facts || jsonb_build_object(v_k, v_old.facts -> v_k);
        end if;
      end loop;
      -- A preference-mode hotel stays one until a hotel name is posted.
      if v_type = 'hotel' and not (p_facts ? 'mode') and (v_old.facts ? 'mode')
         and not authz.sf_text_ok(p_facts -> 'hotelName', 200, true) then
        v_facts := v_facts || jsonb_build_object('mode', v_old.facts -> 'mode');
      end if;
      -- Requests: kept together when neither the items nor the text is posted.
      v_target := case v_type when 'hotel' then 'specialRequests' when 'flight' then 'preferences' end;
      if v_target is not null and not (p_facts ? 'requestItems') and not (p_facts ? v_target) then
        if v_old.facts ? 'requestItems' then
          v_facts := v_facts || jsonb_build_object('requestItems', v_old.facts -> 'requestItems');
        end if;
        if v_old.facts ? v_target then
          v_facts := v_facts || jsonb_build_object(v_target, v_old.facts -> v_target);
        end if;
      end if;
      -- D7: a typed post with one leg keeps the stored legs 2..8.
      if v_type = 'flight' and coalesce(v_facts ->> 'entryMode', 'typed') = 'typed'
         and jsonb_typeof(v_facts -> 'segments') = 'array' and jsonb_array_length(v_facts -> 'segments') = 1
         and coalesce(v_old.facts ->> 'entryMode', 'typed') = 'typed'
         and jsonb_typeof(v_old.facts -> 'segments') = 'array' and jsonb_array_length(v_old.facts -> 'segments') > 1 then
        v_facts := jsonb_set(v_facts, '{segments}',
          (v_facts -> 'segments') || ((v_old.facts -> 'segments') - 0));
      end if;
    end if;

    -- BF2 (c), D4: hotel adults and children follow the chosen people.
    if v_type = 'hotel' and coalesce(jsonb_typeof(p_facts -> 'adults'), 'null') = 'null'
       and p_participants is not null and cardinality(p_participants) > 0 then
      select count(*) filter (where t.traveller_type = 'adult'), count(*) filter (where t.traveller_type in ('child', 'infant'))
      into v_adults, v_kids
      from public.deal_travellers t where t.deal_id = v_ver.deal_id and t.seq = any (p_participants);
      if v_adults > 0 then
        v_facts := (v_facts - 'adults' - 'children') || jsonb_build_object('adults', v_adults)
          || case when v_kids > 0 then jsonb_build_object('children', v_kids) else '{}'::jsonb end;
      end if;
    end if;
    -- A kept childAges list that no longer matches the children count is dropped.
    if v_type = 'hotel' and jsonb_typeof(v_facts -> 'childAges') = 'array' and not (p_facts ? 'childAges')
       and jsonb_array_length(v_facts -> 'childAges') <> coalesce(authz.sf_int_value(v_facts -> 'children'), 0) then
      v_facts := v_facts - 'childAges';
    end if;

    -- BF2 (d): a screenshot flight has as many passengers as participants.
    if v_type = 'flight' then
      if v_facts ->> 'entryMode' = 'screenshot' then
        if not (v_facts ? 'segments') or jsonb_typeof(v_facts -> 'segments') = 'null' then
          v_facts := v_facts || jsonb_build_object('segments', '[]'::jsonb);
        end if;
        if cardinality(v_seqs) > 0 then
          v_facts := v_facts || jsonb_build_object('passengers', cardinality(v_seqs));
        end if;
      end if;
      -- Only a return flight carries the flag.
      if jsonb_typeof(v_facts -> 'isReturn') = 'boolean' and not (v_facts ->> 'isReturn')::boolean then
        v_facts := v_facts - 'isReturn';
      end if;
    end if;

    -- BF2 (review round 1): kept requests are re-checked against the item's
    -- travellers; one for someone no longer on the item becomes "for
    -- everyone"; the text is written again (also picks up a renamed traveller).
    if v_type in ('hotel', 'flight') and not (p_facts ? 'requestItems')
       and jsonb_typeof(v_facts -> 'requestItems') = 'array' then
      v_target := case v_type when 'hotel' then 'specialRequests' else 'preferences' end;
      v_facts := jsonb_set(v_facts, '{requestItems}', coalesce((
        select jsonb_agg(case when coalesce(jsonb_typeof(e.v -> 'forSeq'), 'null') <> 'null'
                                   and not (authz.sf_int_value(e.v -> 'forSeq') = any (v_seqs))
                              then e.v || jsonb_build_object('forSeq', null) else e.v end order by e.n)
        from jsonb_array_elements(v_facts -> 'requestItems') with ordinality as e(v, n)), '[]'::jsonb));
      v_text := authz.bf2_request_text(v_ver.deal_id, v_facts -> 'requestItems');
      v_facts := v_facts - v_target - 'requestItems'
        || case when v_text is null or length(v_text) > (case v_type when 'hotel' then 2000 else 500 end) then '{}'::jsonb
                else jsonb_build_object(v_target, v_text, 'requestItems', v_facts -> 'requestItems') end;
    end if;

    -- BF2 (review round 1): a car meets a flight of this same booking version, or none.
    if v_type = 'transfer' and jsonb_typeof(v_facts -> 'flightItemId') = 'string' and not exists (
         select 1 from public.service_items i
         join public.service_item_facts f on f.service_item_id = i.id and f.booking_version_id = v_ver.id
         where i.deal_id = v_ver.deal_id and i.service_type = 'flight'
           and i.id::text = lower(v_facts ->> 'flightItemId')) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'flightItemId';
    end if;

    -- BF2 (b): requests "for whom" render the readable text.
    if v_type in ('hotel', 'flight') and p_facts ? 'requestItems' then
      v_target := case v_type when 'hotel' then 'specialRequests' else 'preferences' end;
      if not authz.bf2_request_items_ok(v_facts -> 'requestItems')
         or exists (select 1 from jsonb_array_elements(case when jsonb_typeof(v_facts -> 'requestItems') = 'array'
                                                            then v_facts -> 'requestItems' else '[]'::jsonb end) e
                    where coalesce(jsonb_typeof(e -> 'forSeq'), 'null') <> 'null'
                      and not (authz.sf_int_value(e -> 'forSeq') = any (v_seqs))) then
        raise exception 'invalid_input' using errcode = '22023', hint = 'requestItems';
      end if;
      v_text := authz.bf2_request_text(v_ver.deal_id, v_facts -> 'requestItems');
      if v_text is not null and length(v_text) > (case v_type when 'hotel' then 2000 else 500 end) then
        raise exception 'invalid_input' using errcode = '22023', hint = 'requestItems';
      end if;
      v_facts := v_facts - v_target - 'requestItems'
        || case when v_text is null then '{}'::jsonb
                else jsonb_build_object(v_target, v_text, 'requestItems', v_facts -> 'requestItems') end;
    end if;
  end if;

  -- (authz.vn_hotel_adults_default fills the value on every save path.)
  if v_type = 'hotel' and jsonb_typeof(v_facts) = 'object'
     and coalesce(jsonb_typeof(v_facts -> 'adults'), 'null') = 'null' then
    v_defaulted := true;
    v_def := authz.vn_version_adults(v_ver.id);
    -- A hotel is never stored without adults (every reader requires them):
    -- with no counts and no adult passengers yet, staff enter the counts first.
    if v_def is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'paxTotal';
    end if;
    v_facts := (v_facts - 'adults') || jsonb_build_object('adults', v_def);
  end if;

  if p_item_id is null then
    v_res := public.service_item_add(v_ver.id, v_rv, p_service_type, v_facts, coalesce(p_purchase_budget_paise, 0),
      md5(p_request_id::text || ':item')::uuid);
    select * into v_item from public.service_items i where i.id = (v_res ->> 'itemId')::uuid;
  else
    select * into v_item from public.service_items i where i.id = p_item_id and i.deal_id = v_ver.deal_id;
    if v_item.id is null or not exists (
         select 1 from public.service_item_facts f where f.service_item_id = v_item.id and f.booking_version_id = v_ver.id) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    if p_service_type is not null and p_service_type <> v_item.service_type then
      raise exception 'invalid_input' using errcode = '22023', hint = 'serviceType';
    end if;
    v_budget := coalesce(p_purchase_budget_paise, (select f.purchase_budget_paise from public.service_item_facts f
                                                   where f.service_item_id = v_item.id and f.booking_version_id = v_ver.id));
    v_res := public.service_item_save(v_item.id, v_ver.id, v_rv, v_facts, v_budget);
  end if;
  v_rv := (v_res ->> 'rowVersion')::integer;
  -- VN: remember whether the hotel adults follow the booking.
  update public.service_item_facts f set adults_from_booking = v_defaulted
  where f.service_item_id = v_item.id and f.booking_version_id = v_ver.id and f.adults_from_booking <> v_defaulted;

  if p_estimate is not null and jsonb_typeof(p_estimate) <> 'null' then
    select * into v_ver from public.booking_versions v where v.id = v_ver.id;
    if authz.bf_estimate_write(v_ver, v_item, p_estimate) then
      v_ver := authz.bump_package_version(v_ver.id);
      v_rv := v_ver.row_version;
      -- Ids only: never an amount.
      perform authz.write_audit('booking.estimate_saved', v_ver.legal_entity_id, v_ver.branch_id, 'service_item', v_item.id,
        null, jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'itemNo', v_item.item_no,
          'rowVersion', v_ver.row_version));
    end if;
  end if;

  -- BF2 (e), owner decision D2: the Purchase budget follows the estimate
  -- while staff never typed one (a stored 0 counts as never typed).
  if v_item.service_type in ('hotel', 'transfer', 'activity') then
    if p_purchase_budget_paise is not null then
      update public.service_item_facts f set purchase_budget_auto = false
      where f.service_item_id = v_item.id and f.booking_version_id = v_ver.id and f.purchase_budget_auto;
    else
      -- Review round 1: a revision draft keeps the budget as copied.
      v_auto := v_ver.revises_version_id is null
        and (p_item_id is null or v_old.purchase_budget_auto or v_old.purchase_budget_paise = 0);
    end if;
  end if;
  if v_auto then
    -- ==== D2 rule: budget = the item's estimate total; no estimate = 0 (no budget). ====
    v_new_budget := coalesce(authz.bf2_estimate_total(v_item.id, v_ver.id), 0);
    update public.service_item_facts f set purchase_budget_auto = true
    where f.service_item_id = v_item.id and f.booking_version_id = v_ver.id and not f.purchase_budget_auto;
    if exists (select 1 from public.service_item_facts f
               where f.service_item_id = v_item.id and f.booking_version_id = v_ver.id
                 and f.purchase_budget_paise <> v_new_budget) then
      update public.service_item_facts f set purchase_budget_paise = v_new_budget, updated_at = now()
      where f.service_item_id = v_item.id and f.booking_version_id = v_ver.id;
      v_ver := authz.bump_package_version(v_ver.id);
      v_rv := v_ver.row_version;
      -- Ids only: never an amount.
      perform authz.write_audit('booking.purchase_budget_from_estimate', v_ver.legal_entity_id, v_ver.branch_id,
        'service_item', v_item.id, null, jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id,
          'itemNo', v_item.item_no, 'rowVersion', v_ver.row_version));
    end if;
  end if;

  if p_participants is not null then
    v_res := public.service_item_travellers_save(v_item.id, v_ver.id, v_rv, p_participants);
    v_rv := (v_res ->> 'rowVersion')::integer;
  end if;

  select * into v_ver from public.booking_versions v where v.id = v_ver.id;
  v_result := jsonb_build_object('itemId', v_item.id, 'itemNo', v_item.item_no, 'rowVersion', v_ver.row_version,
    'contentHash', v_ver.content_hash);
  perform authz.finance_remember(v_ver.legal_entity_id, p_request_id, 'booking_service_save', v_payload, v_result);
  return v_result;
end;
$$;

-- ===========================================================================
-- 5. Typed total fare per person, all flights (new)
-- ===========================================================================

-- p_fares: {adultPaise, childPaise, infantPaise}, each a digit string (paise,
-- 0..99,999,999,999) or null; all null removes the row. Commercial readers who
-- may edit the draft. An exact retry returns the stored result.
create function public.booking_flight_fares_save(p_version_id uuid, p_expected_row_version integer, p_fares jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_payload jsonb := jsonb_build_object('versionId', p_version_id, 'expectedRowVersion', p_expected_row_version,
    'fares', p_fares);
  v_result jsonb;
  v_old public.booking_version_flight_fares%rowtype;
  v_bad text[] := '{}'::text[];
  v_k text;
  v_a record;
  v_vals jsonb := '{}'::jsonb;
  v_adult bigint; v_child bigint; v_infant bigint;
  v_changed boolean := false;
begin
  v_ver := authz.lock_package_draft(p_version_id);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if not authz.can_read_deal_commercial(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_result := authz.finance_replay(v_ver.legal_entity_id, p_request_id, 'booking_flight_fares_save', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_fares is null or jsonb_typeof(p_fares) <> 'object'
     or cardinality(authz.b11_unknown_keys(p_fares, array['adultPaise', 'childPaise', 'infantPaise'])) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fares';
  end if;
  foreach v_k in array array['adultPaise', 'childPaise', 'infantPaise'] loop
    select * into v_a from authz.bf_paise(p_fares -> v_k, false);
    if not v_a.ok then
      v_bad := v_bad || ('fares.' || v_k);
    else
      v_vals := v_vals || jsonb_build_object(v_k, v_a.amount);
    end if;
  end loop;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  v_adult := (v_vals ->> 'adultPaise')::bigint;
  v_child := (v_vals ->> 'childPaise')::bigint;
  v_infant := (v_vals ->> 'infantPaise')::bigint;

  select * into v_old from public.booking_version_flight_fares x where x.booking_version_id = v_ver.id for update;
  if coalesce(v_adult, v_child, v_infant) is null then
    if v_old.booking_version_id is not null then
      delete from public.booking_version_flight_fares x where x.booking_version_id = v_ver.id;
      v_changed := true;
    end if;
  elsif v_old.booking_version_id is null
        or (v_old.adult_paise, v_old.child_paise, v_old.infant_paise) is distinct from (v_adult, v_child, v_infant) then
    insert into public.booking_version_flight_fares as x (booking_version_id, legal_entity_id, adult_paise, child_paise,
      infant_paise, updated_by)
    values (v_ver.id, v_ver.legal_entity_id, v_adult, v_child, v_infant, (select auth.uid()))
    on conflict (booking_version_id) do update
      set adult_paise = excluded.adult_paise, child_paise = excluded.child_paise, infant_paise = excluded.infant_paise,
          updated_by = excluded.updated_by;
    v_changed := true;
  end if;
  if v_changed then
    v_ver := authz.bump_package_version(v_ver.id);
    -- Ids only: never an amount.
    perform authz.write_audit('booking.flight_fares_saved', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id,
      null, jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'rowVersion', v_ver.row_version));
  end if;
  v_result := jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
  perform authz.finance_remember(v_ver.legal_entity_id, p_request_id, 'booking_flight_fares_save', v_payload, v_result);
  return v_result;
end;
$$;

-- ===========================================================================
-- 6. Add return flights (new)
-- ===========================================================================

-- One transaction: every typed onward flight of the draft (entry mode typed,
-- not a return flight, at least one leg), latest first, becomes a new flight
-- with its legs reversed (from and to swapped), every leg dated to the trip
-- end, airline kept, no flight number, times or arrival date, the same
-- travellers, cabin and requests, isReturn true and no fares. Answers
-- 'already_added' when the draft has a return flight, 'no_typed_flights' when
-- nothing can be reversed (the screen then opens a screenshot flight marked
-- return). A revision draft refuses revision_items_fixed (items are fixed).
create function public.booking_flight_returns_add(p_version_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_payload jsonb := jsonb_build_object('versionId', p_version_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_rv integer;
  v_src record;
  v_facts jsonb;
  v_res jsonb;
  v_ids uuid[] := '{}'::uuid[];
  v_nos integer[] := '{}'::integer[];
  v_outcome text;
  v_end jsonb;
begin
  v_ver := authz.lock_package_draft(p_version_id);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_ver.legal_entity_id, p_request_id, 'booking_flight_returns_add', v_payload);
  if v_result is not null then
    -- An exact retry answers the first call's outcome (the replay marks it 'existing').
    return (v_result - 'addOutcome') || jsonb_build_object('outcome', v_result -> 'addOutcome', 'replayed', true);
  end if;
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  v_rv := v_ver.row_version;

  if exists (select 1 from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
             where f.booking_version_id = v_ver.id and i.service_type = 'flight'
               and coalesce((f.facts ->> 'isReturn')::boolean, false)) then
    v_outcome := 'already_added';
  elsif not exists (
      select 1 from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
      where f.booking_version_id = v_ver.id and i.service_type = 'flight'
        and coalesce(f.facts ->> 'entryMode', 'typed') = 'typed'
        and jsonb_typeof(f.facts -> 'segments') = 'array' and jsonb_array_length(f.facts -> 'segments') > 0) then
    v_outcome := 'no_typed_flights';
  else
    if v_ver.trip_end is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'tripEnd';
    end if;
    v_end := to_jsonb(to_char(v_ver.trip_end, 'YYYY-MM-DD'));
    v_outcome := 'added';
    for v_src in
      select i.id, i.item_no, f.facts
      from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
      where f.booking_version_id = v_ver.id and i.service_type = 'flight'
        and coalesce(f.facts ->> 'entryMode', 'typed') = 'typed'
        and jsonb_typeof(f.facts -> 'segments') = 'array' and jsonb_array_length(f.facts -> 'segments') > 0
      order by i.item_no desc
    loop
      v_facts := jsonb_build_object(
        'segments', (select jsonb_agg(jsonb_build_object('from', s.v -> 'to', 'to', s.v -> 'from', 'date', v_end)
                                      || case when coalesce(jsonb_typeof(s.v -> 'airline'), 'null') = 'null' then '{}'::jsonb
                                              else jsonb_build_object('airline', s.v -> 'airline') end
                                      order by s.n desc)
                     from jsonb_array_elements(v_src.facts -> 'segments') with ordinality as s(v, n)),
        'passengers', v_src.facts -> 'passengers',
        'isReturn', true)
        || case when v_src.facts ? 'cabin' then jsonb_build_object('cabin', v_src.facts -> 'cabin') else '{}'::jsonb end
        || case when v_src.facts ? 'preferences' then jsonb_build_object('preferences', v_src.facts -> 'preferences') else '{}'::jsonb end
        || case when v_src.facts ? 'requestItems' then jsonb_build_object('requestItems', v_src.facts -> 'requestItems') else '{}'::jsonb end
        || case when v_src.facts ? 'assistance' then jsonb_build_object('assistance', v_src.facts -> 'assistance') else '{}'::jsonb end;
      v_res := public.service_item_add(v_ver.id, v_rv, 'flight', v_facts, 0::bigint,
        md5(p_request_id::text || ':return:' || v_src.id::text)::uuid);
      v_rv := (v_res ->> 'rowVersion')::integer;
      v_ids := v_ids || (v_res ->> 'itemId')::uuid;
      v_nos := v_nos || (v_res ->> 'itemNo')::integer;
      v_res := public.service_item_travellers_save((v_res ->> 'itemId')::uuid, v_ver.id, v_rv,
        authz.item_participant_seqs(v_src.id, v_ver.id));
      v_rv := (v_res ->> 'rowVersion')::integer;
    end loop;
    select * into v_ver from public.booking_versions v where v.id = v_ver.id;
    -- Ids only.
    perform authz.write_audit('booking.flight_returns_added', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id,
      null, jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'itemIds', to_jsonb(v_ids),
        'itemNos', to_jsonb(v_nos), 'rowVersion', v_ver.row_version));
  end if;

  v_result := jsonb_build_object('outcome', v_outcome, 'itemIds', to_jsonb(v_ids), 'itemNos', to_jsonb(v_nos),
    'rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
  perform authz.finance_remember(v_ver.legal_entity_id, p_request_id, 'booking_flight_returns_add', v_payload,
    v_result || jsonb_build_object('addOutcome', v_outcome));
  return v_result;
end;
$$;

-- ===========================================================================
-- 7. Revision copy (replaces 20261124000120; lines marked BF2)
-- ===========================================================================

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
  -- BF2: the automatic budget flag is copied too.
  insert into public.service_item_facts (service_item_id, booking_version_id, legal_entity_id, facts, purchase_budget_paise, facts_hash,
    purchase_budget_auto)
  select f.service_item_id, v_ver.id, f.legal_entity_id, f.facts, f.purchase_budget_paise, f.facts_hash, f.purchase_budget_auto
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
  -- BF2: fare per person.
  insert into public.service_item_cost_estimates (booking_version_id, service_item_id, legal_entity_id, room_rate_paise,
    extra_bed_rate_paise, no_bed_rate_paise, vehicle_rate_paise, fare_total_paise,
    fare_adult_paise, fare_child_paise, fare_infant_paise, updated_by)
  select v_ver.id, e.service_item_id, e.legal_entity_id, e.room_rate_paise, e.extra_bed_rate_paise, e.no_bed_rate_paise,
    e.vehicle_rate_paise, e.fare_total_paise, e.fare_adult_paise, e.fare_child_paise, e.fare_infant_paise, e.updated_by
  from public.service_item_cost_estimates e where e.booking_version_id = v_base.id;
  -- BF2: typed total fare per person of all flights.
  insert into public.booking_version_flight_fares (booking_version_id, legal_entity_id, adult_paise, child_paise, infant_paise,
    updated_by)
  select v_ver.id, x.legal_entity_id, x.adult_paise, x.child_paise, x.infant_paise, x.updated_by
  from public.booking_version_flight_fares x where x.booking_version_id = v_base.id;
  select * into v_ver from public.booking_versions v where v.id = v_ver.id;

  perform authz.write_audit('booking.revision_opened', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id,
    null, jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'baseVersionId', v_base.id,
      'baseVersionNo', v_base.version_no));
  return jsonb_build_object('versionId', v_ver.id, 'versionNo', v_ver.version_no, 'rowVersion', v_ver.row_version,
    'revisesVersionId', v_base.id, 'created', true);
end;
$$;

-- ===========================================================================
-- 8. Content hash (replaces 20261128000110; lines marked BF2)
-- ===========================================================================

-- The fare per person and the typed flight totals join the hash only when a
-- version has them, so every hash stored before this migration (no such
-- values) stays exactly the same; no new hash schema.
create or replace function authz.booking_package_hash_row(v public.booking_versions) returns text
language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(case when v.hash_schema = 1 then jsonb_build_object(
    'items', coalesce((
      select jsonb_agg(jsonb_build_array(i.item_no, i.service_type, f.facts, f.purchase_budget_paise) order by i.item_no)
      from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
      where f.booking_version_id = v.id), '[]'::jsonb),
    'travellers', case when v.status = 'draft' then coalesce((
        select jsonb_agg(jsonb_build_array(t.seq, t.full_name, t.traveller_type) order by t.seq)
        from public.deal_travellers t where t.deal_id = v.deal_id), '[]'::jsonb)
      else coalesce((
        select jsonb_agg(jsonb_build_array(s.seq, s.full_name, s.traveller_type) order by s.seq)
        from public.booking_version_travellers s where s.booking_version_id = v.id), '[]'::jsonb) end,
    'commercial_revision', v.commercial_revision,
    'stored_evidence', authz.booking_stored_evidence(v.id)
  ) else jsonb_build_object(
    'schema', 2,
    'items', coalesce((
      select jsonb_agg(jsonb_build_array(i.item_no, i.service_type, f.facts, f.purchase_budget_paise,
        coalesce((select jsonb_agg(p.traveller_seq order by p.traveller_seq) from public.service_item_travellers p
                  where p.booking_version_id = v.id and p.service_item_id = i.id), '[]'::jsonb)) order by i.item_no)
      from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
      where f.booking_version_id = v.id), '[]'::jsonb),
    'travellers', case when v.status = 'draft' then coalesce((
        select jsonb_agg(jsonb_build_array(t.seq, t.full_name, t.traveller_type, t.age_years, t.special_needs) order by t.seq)
        from public.deal_travellers t where t.deal_id = v.deal_id), '[]'::jsonb)
      else coalesce((
        select jsonb_agg(jsonb_build_array(s.seq, s.full_name, s.traveller_type, s.age_years, s.special_needs) order by s.seq)
        from public.booking_version_travellers s where s.booking_version_id = v.id), '[]'::jsonb) end,
    'identities', case when v.status = 'draft' then coalesce((
        select jsonb_agg(jsonb_build_array(t.seq, x.date_of_birth, x.nationality, x.passport_number, x.passport_expiry) order by t.seq)
        from public.traveller_identities x join public.deal_travellers t on t.id = x.traveller_id
        where t.deal_id = v.deal_id
          and t.seq in (select p.traveller_seq from public.service_item_travellers p
                        join public.service_items i on i.id = p.service_item_id
                        where p.booking_version_id = v.id
                          and (i.service_type in ('visa', 'passport') or (i.service_type = 'flight' and v.trip_scope = 'international')))),
        '[]'::jsonb)
      else coalesce((
        select jsonb_agg(jsonb_build_array(s.seq, s.date_of_birth, s.nationality, s.passport_number, s.passport_expiry) order by s.seq)
        from public.booking_version_traveller_identities s where s.booking_version_id = v.id), '[]'::jsonb) end,
    'trip', jsonb_build_array(v.trip_destination, v.trip_scope, v.trip_start, v.trip_end),
    'contacts', (select jsonb_build_array(c.contact_name, c.mobile, c.email, c.contact_confirmed, c.booking_for,
                   c.payer_different, c.payer_name)
                 from public.booking_version_contacts c where c.booking_version_id = v.id),
    'commercial_revision', v.commercial_revision,
    'stored_evidence', authz.booking_stored_evidence(v.id)
  )
  -- Booking form: hash schema 3.
  || case when v.hash_schema >= 3 then jsonb_build_object(
       'schema', 3,
       'party', jsonb_build_array(v.pax_total, v.children_count, v.infants_count),
       'contactLabels', (select jsonb_build_array(c.customer_type, c.market)
                         from public.booking_version_contacts c where c.booking_version_id = v.id),
       'estimates', coalesce((
         select jsonb_agg(jsonb_build_array(i.item_no, e.room_rate_paise, e.extra_bed_rate_paise, e.no_bed_rate_paise,
             e.vehicle_rate_paise, e.fare_total_paise)
             -- BF2: fare per person, only when the item has one (older hashes unchanged).
             || case when coalesce(e.fare_adult_paise, e.fare_child_paise, e.fare_infant_paise) is null then '[]'::jsonb
                     else jsonb_build_array(e.fare_adult_paise, e.fare_child_paise, e.fare_infant_paise) end
             order by i.item_no)
         from public.service_item_cost_estimates e join public.service_items i on i.id = e.service_item_id
         where e.booking_version_id = v.id), '[]'::jsonb))
     else '{}'::jsonb end
  -- VN (lead ruling Q1): hash schema 4 adds the special request codes per
  -- traveller (live rows for a draft, the snapshot once confirmed).
  || case when v.hash_schema >= 4 then jsonb_build_object(
       'schema', 4,
       'specialRequests', case when v.status = 'draft' then coalesce((
           select jsonb_agg(jsonb_build_array(t.seq, to_jsonb(t.special_requests)) order by t.seq)
           from public.deal_travellers t where t.deal_id = v.deal_id), '[]'::jsonb)
         else coalesce((
           select jsonb_agg(jsonb_build_array(s.seq, to_jsonb(s.special_requests)) order by s.seq)
           from public.booking_version_travellers s where s.booking_version_id = v.id), '[]'::jsonb) end)
     else '{}'::jsonb end
  -- BF2: typed total fare per person of all flights, only when stored.
  || coalesce((select jsonb_build_object('flightFareTotals', jsonb_build_array(x.adult_paise, x.child_paise, x.infant_paise))
               from public.booking_version_flight_fares x where x.booking_version_id = v.id), '{}'::jsonb)
  || case when v.revises_version_id is not null
         then jsonb_build_object('revision', jsonb_build_array(v.revises_version_id, v.change_class))
         else '{}'::jsonb end end::text, 'UTF8')), 'hex')
$$;

-- ===========================================================================
-- 9. Revisions (replace 20261128000110; lines marked BF2)
-- ===========================================================================

create or replace function authz.revision_field_class(p_field text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_field ~ '^items\.[0-9]+\.purchaseBudgetPaise$' then 'internal'
    -- Booking form: supplier estimates and per-person purchase are internal; the
    -- final sale (prices.sale) stays material.
    when p_field ~ '^items\.[0-9]+\.estimate$' or p_field = 'prices.cost' then 'internal'
    -- BF2: the typed total fare per person (cost side) and the return-flight flag.
    when p_field = 'flightFares' or p_field ~ '^items\.[0-9]+\.isReturn$' then 'internal'
    when p_field ~ '^items\.[0-9]+\.(hotelName|city|area|roomType|mealPlan|inclusions|exclusions|specialRequests|preferences|notes|bedRemarks|route|pickup|drop|vehicleType|name|cabin|preferredTime|assistance|purpose|officeCity|vendor|requestItems|screenshotNote|carKind|flightItemId|entryMode)$'
      then 'choice'
    when p_field in ('travellers.specialNeeds', 'travellers.specialRequests' /* VN */, 'trip.destination', 'contacts.contactName', 'contacts.mobile',
                     'contacts.email', 'contacts.contactConfirmed',
                     -- Booking form: plain labels.
                     'contacts.customerType', 'contacts.market') then 'choice'
    else 'material' end
$$;

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
    -- VN (lead ruling): special request codes, classified like special needs.
    select 'travellers.specialRequests' from v cross join b
    where (select coalesce(jsonb_agg(jsonb_build_array(t.seq, to_jsonb(t.special_requests)) order by t.seq), '[]'::jsonb)
           from public.deal_travellers t where t.deal_id = v.deal_id)
       is distinct from
          (select coalesce(jsonb_agg(jsonb_build_array(s.seq, to_jsonb(s.special_requests)) order by s.seq), '[]'::jsonb)
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
    where (ev.room_rate_paise, ev.extra_bed_rate_paise, ev.no_bed_rate_paise, ev.vehicle_rate_paise, ev.fare_total_paise,
           ev.fare_adult_paise, ev.fare_child_paise, ev.fare_infant_paise)  -- BF2
          is distinct from
          (eb.room_rate_paise, eb.extra_bed_rate_paise, eb.no_bed_rate_paise, eb.vehicle_rate_paise, eb.fare_total_paise,
           eb.fare_adult_paise, eb.fare_child_paise, eb.fare_infant_paise)
    union all
    -- BF2: typed total fare per person of all flights (internal).
    select 'flightFares' from v cross join b
    left join public.booking_version_flight_fares xv on xv.booking_version_id = v.id
    left join public.booking_version_flight_fares xb on xb.booking_version_id = b.id
    where (xv.adult_paise, xv.child_paise, xv.infant_paise) is distinct from (xb.adult_paise, xb.child_paise, xb.infant_paise)
  )
  select coalesce(array_agg(distinct f order by f), '{}'::text[]) from fields
$$;

-- ===========================================================================
-- 10. Privileges
-- ===========================================================================

revoke all on function authz.bf2_request_items_ok(jsonb), authz.bf2_request_text(uuid, jsonb),
  authz.bf2_estimate_total(uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function public.booking_flight_fares_save(uuid, integer, jsonb, uuid),
  public.booking_flight_returns_add(uuid, integer, uuid)
from public, anon, authenticated, service_role;
grant execute on function public.booking_flight_fares_save(uuid, integer, jsonb, uuid),
  public.booking_flight_returns_add(uuid, integer, uuid)
to authenticated;

commit;
