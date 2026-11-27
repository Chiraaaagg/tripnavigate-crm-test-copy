-- TripNavigate CRM - Visa and Passport desk build, track C (Sales booking
-- form): visa facts, revision classes and "never reuse a traveller number".
--
-- Frozen contract: docs/implementation/visa-build-2026-11-07/contract.md
-- sections 5.5 and 5.6 (owner answers Q7, QB1, QB3, QB6; lead decision
-- VL22). Every replaced function keeps its signature and starts from its
-- latest body; changed lines are marked "Visa build (20261202000200)".
--
-- What changes:
--   1. authz.validate_service_facts (replaces 20261129000110): visa gains the
--      optional keys visaKind ('e_visa'|'sticker'|null), jurisdiction
--      ('yes'|'no'|null), jurisdictionPlace (1..120, required with 'yes',
--      absent or null otherwise) and documentsNeeded (0..30 labels, each
--      trimmed with single spaces, 1..120, distinct ignoring case). Refused
--      keys are reported as before (booking_service_save: invalid_input with
--      the keys as hint). Passport facts are unchanged.
--   2. authz.revision_field_class (replaces 20261129000110): items.N.
--      jurisdiction, jurisdictionPlace and documentsNeeded are 'choice' (no
--      fresh customer acceptance, QB6); items.N.visaKind stays 'material'.
--   3. authz.deal_committed (replaces 20261119000300): a finished visa or
--      passport task no longer commits the Deal (QB3). Flight completion and
--      Purchase supplier confirmation still do.
--   4. authz.deal_traveller_seq_high (new): the highest traveller number the
--      Deal ever used (current travellers, every booking version snapshot,
--      visa applications, blank-name fills, flight ticket revisions); 0 when
--      none. Internal helper; no grant.
--   5. public.deal_travellers_save (replaces 20261128000110): a posted seq
--      that is not a current traveller must be above that number, else
--      'traveller_seq_reused' (22023, hint travellers[i].seq).
--   6. public.booking_form_get (replaces 20261129000120): + top-level
--      'travellerSeqHigh' (integer).
--   7. authz.flight_name_slots (replaces 20261201000190): blank-name slots are
--      numbered above authz.deal_traveller_seq_high instead of from the lowest
--      free number (VL22, accepted one-line Flight change).
--
-- New refusal token: 22023 traveller_seq_reused ("Someone changed the
-- passengers meanwhile. Reload the page.").
-- Data: none changed. No new table, grant or switch.
-- Rollback (forward-only): a NEW migration restoring the previous bodies
-- (20261129000110, 20261119000300, 20261128000110, 20261129000120,
-- 20261201000190) and dropping authz.deal_traveller_seq_high after them.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Visa facts (replaces 20261129000110; lines marked Visa build)
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
  v_jur text;  -- Visa build (20261202000200)
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
    when 'visa' then array['country', 'purpose', 'travelDate', 'applyBy', 'feePaidBy', 'notes',
                           -- Visa build (20261202000200): kind, jurisdiction and the documents list.
                           'visaKind', 'jurisdiction', 'jurisdictionPlace', 'documentsNeeded']
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
    -- Visa build (20261202000200) (contract 5.5): all optional; absent or null = not decided yet.
    if p_facts ? 'visaKind' and jsonb_typeof(p_facts -> 'visaKind') <> 'null'
       and (jsonb_typeof(p_facts -> 'visaKind') <> 'string'
            or (p_facts ->> 'visaKind') not in ('e_visa', 'sticker')) then
      v_bad := v_bad || 'visaKind'::text;
    end if;
    v_jur := case when coalesce(jsonb_typeof(p_facts -> 'jurisdiction'), 'null') = 'null' then null
                  when jsonb_typeof(p_facts -> 'jurisdiction') = 'string' then p_facts ->> 'jurisdiction'
                  else '' end;
    if v_jur is not null and v_jur not in ('yes', 'no') then
      v_bad := v_bad || 'jurisdiction'::text;
    end if;
    -- The place is required with 'yes' and must be absent or null otherwise.
    if v_jur = 'yes' then
      if not authz.sf_text_ok(p_facts -> 'jurisdictionPlace', 120, true) then
        v_bad := v_bad || 'jurisdictionPlace'::text;
      end if;
    elsif coalesce(jsonb_typeof(p_facts -> 'jurisdictionPlace'), 'null') <> 'null' then
      v_bad := v_bad || 'jurisdictionPlace'::text;
    end if;
    -- Labels (not codes): 0..30, each trimmed with single spaces, 1..120
    -- characters, distinct by label key (lower case).
    if p_facts ? 'documentsNeeded' and jsonb_typeof(p_facts -> 'documentsNeeded') <> 'null'
       and (jsonb_typeof(p_facts -> 'documentsNeeded') <> 'array'
            or jsonb_array_length(p_facts -> 'documentsNeeded') > 30
            or exists (select 1 from jsonb_array_elements(p_facts -> 'documentsNeeded') d
                       where not authz.sf_text_ok(d, 120, true)
                          or (d #>> '{}') <> regexp_replace(btrim(d #>> '{}'), '\s+', ' ', 'g'))
            or (select count(distinct lower(d #>> '{}')) from jsonb_array_elements(p_facts -> 'documentsNeeded') d)
               <> jsonb_array_length(p_facts -> 'documentsNeeded')) then
      v_bad := v_bad || 'documentsNeeded'::text;
    end if;
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

-- ===========================================================================
-- 2. Revision field classes (replaces 20261129000110; QB6)
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
    -- Visa build (20261202000200) (QB6): the visa jurisdiction and documents list need no fresh
    -- acceptance; visaKind (e-visa or sticker) stays material (default branch).
    when p_field ~ '^items\.[0-9]+\.(jurisdiction|jurisdictionPlace|documentsNeeded)$' then 'choice'
    when p_field in ('travellers.specialNeeds', 'travellers.specialRequests' /* VN */, 'trip.destination', 'contacts.contactName', 'contacts.mobile',
                     'contacts.email', 'contacts.contactConfirmed',
                     -- Booking form: plain labels.
                     'contacts.customerType', 'contacts.market') then 'choice'
    else 'material' end
$$;

-- ===========================================================================
-- 3. Committed Deal (replaces 20261119000300; QB3)
-- ===========================================================================

-- Supplier-confirmed or completed work on the Deal (no revision after it).
-- Visa build (20261202000200): visa and passport tasks never commit the Deal.
create or replace function authz.deal_committed(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.fulfilment_tasks t
                 where t.deal_id = p_deal and t.status in ('supplier_confirmed', 'completed')
                   and t.department <> 'visa')  -- Visa build (20261202000200)
$$;

-- ===========================================================================
-- 4. Highest traveller number ever used on a Deal (new; QB1, VL22)
-- ===========================================================================

create function authz.deal_traveller_seq_high(p_deal uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select greatest(
    coalesce((select max(t.seq) from public.deal_travellers t where t.deal_id = p_deal), 0),
    coalesce((select max(s.seq) from public.booking_version_travellers s
              join public.booking_versions v on v.id = s.booking_version_id
              where v.deal_id = p_deal), 0),
    coalesce((select max(a.traveller_seq) from public.visa_applications a where a.deal_id = p_deal), 0),
    coalesce((select max(f.traveller_seq) from public.deal_traveller_fills f where f.deal_id = p_deal), 0),
    coalesce((select max(r.traveller_seq) from public.flight_ticket_revisions r where r.deal_id = p_deal), 0))
$$;
comment on function authz.deal_traveller_seq_high(uuid) is
  'Visa build (QB1): the highest traveller seq the Deal ever used; new travellers are numbered above it. Internal; no grant.';
revoke all on function authz.deal_traveller_seq_high(uuid) from public, anon, authenticated, service_role;

-- ===========================================================================
-- 5. Traveller save (replaces 20261128000110; lines marked Visa build)
-- ===========================================================================

create or replace function public.deal_travellers_save(p_deal_id uuid, p_expected_row_version integer, p_travellers jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_draft uuid;
  v_row jsonb;
  v_seq integer;
  v_seqs integer[] := '{}'::integer[];
  v_count integer := 0;
  v_removed integer := 0;
  v_over text[];  -- VN
  v_high integer;  -- Visa build (20261202000200)
  v_reused integer;  -- Visa build (20261202000200)
begin
  perform authz.refuse_removed_deal(p_deal_id);
  if p_deal_id is null or not authz.can_edit_booking_draft(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not authz.service_items_enabled() then
    raise exception 'service_items_disabled' using errcode = '55000';
  end if;
  if authz.deal_not_active(p_deal_id) then
    raise exception 'deal_not_active' using errcode = '55000';
  end if;
  select v.id into v_draft from public.booking_versions v
  where v.deal_id = p_deal_id and v.status = 'draft' and v.service_type = 'package';
  if v_draft is null then
    if exists (select 1 from public.booking_versions v where v.deal_id = p_deal_id and v.status = 'draft') then
      raise exception 'invalid_input' using errcode = '22023', hint = 'version';
    end if;
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_ver := authz.lock_package_draft(v_draft);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_travellers is null or jsonb_typeof(p_travellers) <> 'array' or jsonb_array_length(p_travellers) > 100 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'travellers';
  end if;

  -- Validate every row before writing anything.
  for v_row in select e from jsonb_array_elements(p_travellers) e loop
    v_count := v_count + 1;
    if jsonb_typeof(v_row) <> 'object'
       -- B1.1: ageYears, specialNeeds
       or exists (select 1 from jsonb_object_keys(v_row) k where k not in ('fullName', 'type', 'seq', 'ageYears', 'specialNeeds',
                                                                          'specialRequests'))  -- VN
       or not authz.sf_text_ok(v_row -> 'fullName', 120, true)
       or not authz.sf_int_ok(v_row -> 'seq', 1, 100, true)
       or jsonb_typeof(v_row -> 'type') <> 'string' or (v_row #>> '{type}') not in ('adult', 'child', 'infant')
       or not authz.sf_int_ok(v_row -> 'ageYears', 0, 17, false)
       or not authz.sf_text_ok(v_row -> 'specialNeeds', 500, false)
       -- VN: special request codes (absent = unchanged; null or [] = none).
       or (v_row ? 'specialRequests' and jsonb_typeof(v_row -> 'specialRequests') not in ('array', 'null'))
       or (jsonb_typeof(v_row -> 'specialRequests') = 'array' and (
             exists (select 1 from jsonb_array_elements(v_row -> 'specialRequests') c where jsonb_typeof(c) <> 'string')
             or not authz.vn_codes_ok(array(select jsonb_array_elements_text(v_row -> 'specialRequests'))))) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'travellers[' || v_count::text || ']';
    end if;
    v_seq := (v_row #>> '{seq}')::integer;
    if v_seq = any (v_seqs) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'travellers[' || v_count::text || '].seq';
    end if;
    v_seqs := v_seqs || v_seq;
  end loop;

  -- Visa build (20261202000200) (QB1): a traveller number is never reused on a Deal. A
  -- posted seq that is not a current traveller must be above every seq the
  -- Deal has ever used (computed before this save writes anything).
  v_high := authz.deal_traveller_seq_high(p_deal_id);
  select e.n into v_reused
  from jsonb_array_elements(p_travellers) with ordinality as e(v, n)
  where (e.v #>> '{seq}')::integer <= v_high
    and not exists (select 1 from public.deal_travellers t
                    where t.deal_id = p_deal_id and t.seq = (e.v #>> '{seq}')::integer)
  order by e.n limit 1;
  if found then
    raise exception 'traveller_seq_reused' using errcode = '22023', hint = 'travellers[' || v_reused::text || '].seq';
  end if;

  -- VN: on a draft with recorded adults, rows of a type never exceed the declared count.
  if v_ver.adults_count is not null then
    select array_remove(array[
      case when count(*) filter (where e #>> '{type}' = 'adult') > v_ver.adults_count then 'adult' end,
      case when count(*) filter (where e #>> '{type}' = 'child') > coalesce(v_ver.children_count, 0) then 'child' end,
      case when count(*) filter (where e #>> '{type}' = 'infant') > coalesce(v_ver.infants_count, 0) then 'infant' end], null)
    into v_over
    from jsonb_array_elements(p_travellers) e;
    if cardinality(v_over) > 0 then
      raise exception 'traveller_count_exceeded' using errcode = '22023', hint = array_to_string(v_over, ',');
    end if;
  end if;

  -- Names frozen in a confirmed version cannot change through this command
  -- (B1.1 revision: a revision draft may change them; customer_material).
  if v_ver.revises_version_id is null and exists (
    select 1 from public.booking_versions v
    join public.booking_version_travellers s on s.booking_version_id = v.id
    where v.deal_id = p_deal_id and v.status = 'confirmed'
      and not exists (
        select 1 from jsonb_array_elements(p_travellers) e
        where (e #>> '{seq}')::integer = s.seq and btrim(e #>> '{fullName}', E' \t\r\n') = s.full_name)
  ) then
    raise exception 'traveller_identity_locked' using errcode = '55000';
  end if;

  -- B1.1: upsert by seq.
  delete from public.service_item_travellers p
  where p.booking_version_id = v_ver.id and p.traveller_seq <> all (v_seqs);
  delete from public.deal_travellers t where t.deal_id = p_deal_id and t.seq <> all (v_seqs);
  get diagnostics v_removed = row_count;
  insert into public.deal_travellers as t (deal_id, legal_entity_id, seq, full_name, traveller_type, age_years, special_needs,
    special_requests)  -- VN
  select p_deal_id, v_ver.legal_entity_id, (e #>> '{seq}')::integer, btrim(e #>> '{fullName}', E' \t\r\n'), e #>> '{type}',
    authz.sf_int_value(e -> 'ageYears'), authz.b11_text(e -> 'specialNeeds'),
    -- VN: absent = the stored codes of that seq (none for a new row).
    case when e ? 'specialRequests'
         then case when jsonb_typeof(e -> 'specialRequests') = 'array'
                   then array(select c from jsonb_array_elements_text(e -> 'specialRequests') c order by c)
                   else '{}'::text[] end
         else coalesce((select o.special_requests from public.deal_travellers o
                        where o.deal_id = p_deal_id and o.seq = (e #>> '{seq}')::integer), '{}'::text[]) end
  from jsonb_array_elements(p_travellers) e
  on conflict (deal_id, seq) do update
    set full_name = excluded.full_name, traveller_type = excluded.traveller_type, age_years = excluded.age_years,
        special_needs = excluded.special_needs, special_requests = excluded.special_requests
    where (t.full_name, t.traveller_type, t.age_years, t.special_needs, t.special_requests)
          is distinct from (excluded.full_name, excluded.traveller_type, excluded.age_years, excluded.special_needs,
                            excluded.special_requests);
  -- VN (lead ruling Q5): hotels following the booking adults (adult travellers count when no party is recorded).
  perform authz.vn_refresh_hotel_adults(v_ver.id);
  v_ver := authz.bump_package_version(v_ver.id);

  -- Count only; no names.
  perform authz.write_audit('booking.travellers_saved', v_ver.legal_entity_id, v_ver.branch_id,
    'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', p_deal_id, 'versionNo', v_ver.version_no, 'travellerCount', v_count,
      'removedCount', v_removed, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;

-- ===========================================================================
-- 6. Booking form read (replaces 20261129000120; one line marked Visa build)
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
  -- Visa build (20261202000200) (QB1): the highest traveller number this Deal ever used;
  -- the form numbers new passengers above it.
  v_result := v_result || jsonb_build_object('travellerSeqHigh', authz.deal_traveller_seq_high(p_deal_id));
  return v_result;
end;
$$;

-- ===========================================================================
-- 7. Flight blank-name slots (replaces 20261201000190; lines marked Visa build)
-- ===========================================================================

create or replace function authz.flight_name_slots(p_deal uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.booking_versions%rowtype;
  v_n integer;
  v_types text[] := '{}'::text[];
  v_slots jsonb := '[]'::jsonb;
  v_seq integer;
  i integer := 0;
begin
  select * into v from public.booking_versions x where x.deal_id = p_deal and x.status = 'confirmed';
  if v.id is null then
    return '[]'::jsonb;
  end if;
  select coalesce(max(authz.flight_unnamed_count(t.id)), 0) into v_n
  from public.fulfilment_tasks t
  where t.deal_id = p_deal and t.department = 'flight' and t.status <> 'completed'
    and authz.task_current_version(t.id) = v.id;
  -- Adults recorded, or the party total less children and infants (Book now v2).
  if coalesce(v.adults_count, v.pax_total) is not null then
    select array_cat(array_cat(
             array_fill('adult'::text, array[greatest(coalesce(v.adults_count, v.pax_total - coalesce(v.children_count, 0)
                                                               - coalesce(v.infants_count, 0)) - count(*) filter (where s.traveller_type = 'adult'), 0)::integer]),
             array_fill('child'::text, array[greatest(coalesce(v.children_count, 0) - count(*) filter (where s.traveller_type = 'child'), 0)::integer])),
             array_fill('infant'::text, array[greatest(coalesce(v.infants_count, 0) - count(*) filter (where s.traveller_type = 'infant'), 0)::integer]))
    into v_types
    from public.booking_version_travellers s where s.booking_version_id = v.id;
  end if;
  -- Visa build (20261202000200) (QB1, VL22): slots are numbered above every seq the Deal
  -- ever used (was: the lowest free number).
  v_seq := authz.deal_traveller_seq_high(p_deal);
  while i < v_n and v_seq < 100 loop
    v_seq := v_seq + 1;
    continue when exists (select 1 from public.booking_version_travellers s where s.booking_version_id = v.id and s.seq = v_seq)
               or exists (select 1 from public.deal_travellers t where t.deal_id = p_deal and t.seq = v_seq);
    i := i + 1;
    v_slots := v_slots || jsonb_build_object('seq', v_seq, 'type', v_types[i]);
  end loop;
  return v_slots;
end;
$$;

commit;
