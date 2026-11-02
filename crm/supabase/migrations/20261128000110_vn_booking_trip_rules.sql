-- TripNavigate CRM - voice-note booking form batch (24 October 2026), part 2:
-- booking trip facts from Bitrix (server authoritative), the count rule, the
-- hotel adults default, passenger special requests and extra phones.
--
-- Owner table of 24 October 2026 (lead brief lead-voice-notes.md, scope items
-- 1-4; owner answers 2, 3 and 5). Shapes: Atlas notes atlas-vn-shapes.md
-- sections (b)-(e). Depends on 20261128000100.
--
-- What changes:
--   1. booking_versions.adults_count (0..100) with the count rule as a
--      constraint: when set, adults + children + infants = pax_total. Every
--      existing row has null (rule not applied), so older versions read, save
--      and pass readiness exactly as before.
--   2. Trip facts from Bitrix: authz.vn_trip_bitrix(deal) answers the stored
--      Bitrix values and the subset the server USES, only while
--      bitrix_trip_details_read is on (with only bitrix_trip_facts_read on, the
--      dates and total stay prefill suggestions exactly as before): tour start
--      / end and the total travellers when bitrix_trip_facts_read is also on (dates only when
--      readable together: an end before the start or more than 365 nights uses
--      neither); destination (option label from bitrix_name_lists), adults,
--      children and infants while bitrix_trip_details_read is on (the split
--      only when all three are known and, with a Bitrix total, add up to it;
--      otherwise staff enter the split); the scope only when the Bitrix
--      destination option is classified (bitrix_destination_scopes); never
--      guessed.
--   3. public.booking_trip_save (replaces 20261124000110; lines marked VN):
--      new optional key adults; the values the server uses from Bitrix replace
--      the input for those keys before the usual checks (server authoritative);
--      the count rule refuses party_count_mismatch; lowering a count below the
--      named travellers of that type refuses traveller_count_exceeded (nothing
--      is deleted); hotels whose adults came from the booking follow the new
--      party. Answer adds bitrixFields.
--   4. public.booking_trip_facts(deal) and booking_form_get key tripFacts: per
--      field the Bitrix value, the booking value, the source (bitrix | booking
--      | missing) and whether they differ.
--   5. Hotel adults: authz.validate_service_facts (replaces 20261124000120)
--      makes hotel adults optional (1..100 when given; child ages still match
--      children) and accepts catalogueHotelId (a catalogue row id, format
--      only). public.booking_service_save (replaces 20261124000110) fills an
--      absent hotel adults from the booking (adults_count, else total minus
--      children and infants, else the number of adult travellers) and marks
--      the row service_item_facts.adults_from_booking so trip saves keep it in
--      step. Readiness and every reader keep reading facts.adults.
--      Amended 25 October 2026 (release-order review, before any kept
--      database applied this file): a hotel is never stored without adults
--      (refused invalid_input, hint paxTotal from booking_service_save, hint
--      adults from any other path), and catalogueHotelId is checked but never
--      stored in the facts, so the current and the previous app both read
--      every hotel.
--   6. Passengers: deal_travellers.special_requests (fixed codes, frozen in
--      fulfilment/contracts.ts) through public.deal_travellers_save (replaces
--      20261119000300; key specialRequests, absent = unchanged; on a draft
--      with adults_count set, rows of a type above the declared count refuse
--      traveller_count_exceeded); traveller_identities.extra_phones (0..3, the
--      identity phone rule, private as the identity row) through
--      public.traveller_identity_save (replaces 20261124000110; key
--      extraPhones, absent = unchanged). Extra phones are never hashed
--      (private contact details); special request codes are hashed from hash
--      schema 4 (section 9).
--   7. The Book now read (booking_form_get: party.adults,
--      travellers[].specialRequests, identity.extraPhones, tripFacts) is
--      replaced in 20261128000130, which also adds the bill-to party reference.
--
--   8. Lead rulings (24 Oct): Q5 a trigger before the facts guard gives every
--      hotel saved without adults (any command) the booking adults, and trip
--      and traveller saves keep following hotels in step
--      (authz.vn_refresh_hotel_adults); Q1 booking_version_travellers.
--      special_requests filled at confirmation and hash schema 4 (default for
--      new versions; existing versions keep their schema and hashes) adds the
--      codes; Q4 quotation_convert_to_booking (replaces 20261124000120)
--      records the quote's adults when its split is consistent and no named
--      travellers of a type exceed it. Revisions: travellers.specialRequests
--      joins the change list (class choice, like special needs); a revision's
--      copy of a hotel keeps following the booking adults when its base did.
--
-- Fix round (Echo-A review of 24 Oct; this file had run on disposable local
-- stacks only, so it is amended in place): L1 an explicit adults null is
-- refused once adults are recorded; L9 readiness lists a hotel with no adults
-- among the invalid items (authz.service_item_invalid_nos, replaces
-- 20261118000100); L10 a Bitrix value that would fail the trip checks is
-- treated as missing.
--
-- Pricing, per-person maths and price editing are unchanged.
--
-- Refusal tokens (message is exactly the token): new 22023
-- party_count_mismatch (hint adults,children,infants,paxTotal) and 22023
-- traveller_count_exceeded (hint the traveller types: adult, child, infant);
-- existing tokens unchanged.
--
-- Rollback (forward-only): a NEW migration restoring the replaced bodies.
-- Columns stay (nullable or defaulted); nothing is deleted.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Columns
-- ===========================================================================

alter table public.booking_versions
  add column adults_count smallint check (adults_count between 0 and 100),
  add constraint booking_versions_count_rule check (
    adults_count is null
    or (pax_total is not null and adults_count + coalesce(children_count, 0) + coalesce(infants_count, 0) = pax_total));
comment on column public.booking_versions.adults_count is
  'Voice-note batch: adults of the booking. When set, adults + children + infants = pax_total (count rule). Null on every version saved before this batch (rule not applied).';

-- Fixed special request codes (frozen in crm/src/modules/fulfilment/contracts.ts).
create function authz.vn_special_request_codes() returns text[]
language sql immutable set search_path = '' as $$
  select array['vegetarian_meals', 'jain_meals', 'wheelchair_help', 'honeymoon_decoration', 'early_check_in',
               'late_check_out', 'adjoining_rooms', 'ground_floor_room', 'baby_cot', 'senior_citizen_help']
$$;

create function authz.vn_codes_ok(p_codes text[]) returns boolean
language sql immutable set search_path = '' as $$
  select p_codes is not null and cardinality(p_codes) <= 10
    and p_codes <@ authz.vn_special_request_codes()
    and cardinality(p_codes) = (select count(distinct c) from unnest(p_codes) c)
$$;

-- The identity phone rule (traveller_identities.phone) for each extra phone.
create function authz.vn_phones_ok(p_phones text[]) returns boolean
language sql immutable set search_path = '' as $$
  select p_phones is not null and cardinality(p_phones) <= 3
    and not exists (select 1 from unnest(p_phones) x
                    where x is null or not (x ~ '^[6-9][0-9]{9}$' or x ~ '^\+[1-9][0-9]{6,14}$'))
$$;

alter table public.deal_travellers
  add column special_requests text[] not null default '{}' check (authz.vn_codes_ok(special_requests));
comment on column public.deal_travellers.special_requests is
  'Voice-note batch: special request codes (fixed list, authz.vn_special_request_codes) next to the free-text special_needs. Not hashed.';

alter table public.traveller_identities
  add column extra_phones text[] not null default '{}' check (authz.vn_phones_ok(extra_phones));
comment on column public.traveller_identities.extra_phones is
  'Voice-note batch: up to three additional passenger phone numbers (same rule as phone). Restricted like the rest of the row; not hashed.';

alter table public.service_item_facts
  add column adults_from_booking boolean not null default false;
comment on column public.service_item_facts.adults_from_booking is
  'Voice-note batch: hotel adults were not entered on the hotel and follow the booking adults (filled by booking_service_save, kept in step by booking_trip_save).';

-- ===========================================================================
-- 2. Bitrix values the booking uses
-- ===========================================================================

-- Adults of a version for the hotel default: adults_count, else total minus
-- children and infants, else the number of adult travellers; null when none
-- is at least 1.
create function authz.vn_version_adults(p_version uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select case when x.n between 1 and 100 then x.n end
  from (
    select coalesce(v.adults_count::integer,
      case when v.pax_total is not null then v.pax_total - coalesce(v.children_count, 0) - coalesce(v.infants_count, 0) end,
      (select count(*)::integer from public.deal_travellers t where t.deal_id = v.deal_id and t.traveller_type = 'adult')) as n
    from public.booking_versions v where v.id = p_version
  ) x
$$;

-- The stored Bitrix values of a Deal (raw) and the subset the server uses
-- (use: keys of booking_trip_save: destination, scope, start, end, paxTotal,
-- adults, children, infants). Groups follow their own switch on the Deal's
-- enabled configuration. Callers have already authorized the reader.
create function authz.vn_trip_bitrix(p_deal uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_portal text;
  v_entity uuid;
  v_cfg public.integration_intake_config%rowtype;
  v_f public.deal_source_trip_facts%rowtype;
  v_facts_on boolean;
  v_details_on boolean;
  v_list text;
  v_label text;
  v_scope text;
  v_use jsonb := '{}'::jsonb;
  v_raw jsonb;
  v_consistent boolean;
  v_total integer;
  v_sum integer;
  v_issues text[] := '{}'::text[];
begin
  select d.source_portal, d.legal_entity_id into v_portal, v_entity from public.deals d where d.id = p_deal;
  -- The Deal's portal configuration; a Deal without a portal (synthetic
  -- fixtures) reads its entity's configuration. Stored facts exist only for
  -- Deals the sync wrote.
  select * into v_cfg from public.integration_intake_config c
  where c.enabled and (c.portal_member_id = v_portal or (v_portal is null and c.pilot_legal_entity_id = v_entity))
  order by (c.portal_member_id = v_portal) desc nulls last, c.id
  limit 1;
  v_facts_on := coalesce(v_cfg.bitrix_trip_facts_read, false);
  v_details_on := coalesce(v_cfg.bitrix_trip_details_read, false);
  select * into v_f from public.deal_source_trip_facts f where f.deal_id = p_deal;

  -- The server uses Bitrix values only while the details switch is on (with
  -- only bitrix_trip_facts_read on, the dates and total stay suggestions for
  -- the prefill, exactly as before).
  if v_facts_on and v_details_on and v_f.deal_id is not null then
    v_issues := v_issues || v_f.read_issues;
    -- Dates: each when present, neither when both are present and out of order or over 365 nights.
    -- Echo-A L10: a value that would fail the trip checks is treated as missing.
    if not (v_f.tour_start is not null and v_f.tour_end is not null
            and (v_f.tour_end < v_f.tour_start or v_f.tour_end - v_f.tour_start > 365)) then
      if v_f.tour_start is not null then
        v_use := v_use || jsonb_build_object('start', to_char(v_f.tour_start, 'YYYY-MM-DD'));
      end if;
      if v_f.tour_end is not null then
        v_use := v_use || jsonb_build_object('end', to_char(v_f.tour_end, 'YYYY-MM-DD'));
      end if;
    end if;
    if v_f.traveller_total between 1 and 100 then
      v_total := v_f.traveller_total;
      v_use := v_use || jsonb_build_object('paxTotal', v_total);
    end if;
  end if;

  if v_details_on and v_f.deal_id is not null then
    v_issues := v_issues || v_f.details_issues;
    if v_f.adults is not null and v_f.children is not null and v_f.infants is not null then
      v_sum := v_f.adults + v_f.children + v_f.infants;
      if v_total is not null then
        v_consistent := v_sum = v_total;
      else
        v_consistent := v_sum between 1 and 100;
      end if;
      -- Echo-A L10: the split is used only when it also passes the trip checks
      -- (total 1-100, children and infants within it).
      if v_consistent and v_sum between 1 and 100 then
        v_use := v_use || jsonb_build_object('paxTotal', v_sum, 'adults', v_f.adults::integer,
          'children', v_f.children::integer, 'infants', v_f.infants::integer);
      end if;
    end if;
    if v_f.destination_option_id is not null then
      v_list := case v_f.destination_field when 'single' then 'DEAL_DESTINATION' else 'DEAL_DESTINATION_MULTI' end;
      select l.name into v_label from public.bitrix_name_lists l
      where l.source_portal = v_cfg.portal_member_id and l.entity_id = v_list and l.code = v_f.destination_option_id;
      select s.scope into v_scope from public.bitrix_destination_scopes s
      where s.source_portal = v_cfg.portal_member_id and s.list_entity_id = v_list and s.option_id = v_f.destination_option_id;
      -- Echo-A L10: only a label that passes the destination check (1-200, no control characters).
      if v_label is not null and authz.sf_text_ok(to_jsonb(v_label), 200, true) then
        v_use := v_use || jsonb_build_object('destination', v_label);
        if v_scope is not null then
          v_use := v_use || jsonb_build_object('scope', v_scope);
        end if;
      end if;
    end if;
  end if;

  v_raw := jsonb_build_object(
    'destination', case when v_details_on and v_f.destination_option_id is not null then jsonb_build_object(
      'listId', v_list, 'optionId', v_f.destination_option_id, 'label', v_label) end,
    'scope', case when v_details_on and v_label is not null then v_scope end,
    'start', case when v_facts_on then to_char(v_f.tour_start, 'YYYY-MM-DD') end,
    'end', case when v_facts_on then to_char(v_f.tour_end, 'YYYY-MM-DD') end,
    'total', case when v_facts_on then v_f.traveller_total end,
    'adults', case when v_details_on then v_f.adults end,
    'children', case when v_details_on then v_f.children end,
    'infants', case when v_details_on then v_f.infants end);
  return jsonb_build_object(
    'factsOn', v_facts_on, 'detailsOn', v_details_on,
    'readAt', case when v_f.deal_id is null or not (v_facts_on or v_details_on) then null
                   when v_details_on and v_f.details_read_at is not null then greatest(v_f.read_at, v_f.details_read_at)
                   else v_f.read_at end,
    'raw', v_raw, 'use', v_use, 'countsConsistent', v_consistent,
    'issues', to_jsonb(array(select distinct x from unnest(v_issues) x order by x)));
end;
$$;

-- One field of the trip facts read.
create function authz.vn_fact_field(p_bitrix jsonb, p_used jsonb, p_booking jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object(
    'bitrix', coalesce(p_bitrix, 'null'::jsonb),
    'booking', coalesce(p_booking, 'null'::jsonb),
    'source', case when p_used is not null and jsonb_typeof(p_used) <> 'null' then 'bitrix'
                   when p_booking is not null and jsonb_typeof(p_booking) <> 'null' then 'booking'
                   else 'missing' end,
    'differs', p_used is not null and jsonb_typeof(p_used) <> 'null'
               and p_booking is not null and jsonb_typeof(p_booking) <> 'null' and p_used <> p_booking)
$$;

-- The booking trip facts read (shape: atlas-vn-shapes.md section b). The
-- caller has already authorized the reader.
create function authz.vn_trip_facts_json(p_deal uuid, p_version uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_bx jsonb := authz.vn_trip_bitrix(p_deal);
  v_raw jsonb;
  v_use jsonb;
  v_ver public.booking_versions%rowtype;
begin
  v_raw := v_bx -> 'raw';
  v_use := v_bx -> 'use';
  select * into v_ver from public.booking_versions v where v.id = p_version;
  return jsonb_build_object(
    'enabled', (v_bx ->> 'detailsOn')::boolean,
    'factsEnabled', (v_bx ->> 'factsOn')::boolean,
    'readAt', v_bx -> 'readAt',
    'fields', jsonb_build_object(
      'destination', authz.vn_fact_field(v_raw -> 'destination', v_use -> 'destination', to_jsonb(v_ver.trip_destination))
                     || jsonb_build_object('differs', v_use ? 'destination' and v_ver.trip_destination is not null
                                                      and v_ver.trip_destination is distinct from (v_use ->> 'destination')),
      'scope', authz.vn_fact_field(v_raw -> 'scope', v_use -> 'scope', to_jsonb(v_ver.trip_scope))
               || jsonb_build_object('classified', v_use ? 'scope'),
      'start', authz.vn_fact_field(v_raw -> 'start', v_use -> 'start', to_jsonb(to_char(v_ver.trip_start, 'YYYY-MM-DD'))),
      'end', authz.vn_fact_field(v_raw -> 'end', v_use -> 'end', to_jsonb(to_char(v_ver.trip_end, 'YYYY-MM-DD'))),
      'total', authz.vn_fact_field(v_raw -> 'total', v_use -> 'paxTotal', to_jsonb(v_ver.pax_total::integer)),
      'adults', authz.vn_fact_field(v_raw -> 'adults', v_use -> 'adults', to_jsonb(v_ver.adults_count::integer)),
      'children', authz.vn_fact_field(v_raw -> 'children', v_use -> 'children', to_jsonb(v_ver.children_count::integer)),
      'infants', authz.vn_fact_field(v_raw -> 'infants', v_use -> 'infants', to_jsonb(v_ver.infants_count::integer))),
    'countsConsistent', v_bx -> 'countsConsistent',
    'issues', v_bx -> 'issues');
end;
$$;

-- Same gate as booking_form_get (booking editors and acceptors); null otherwise.
create function public.booking_trip_facts(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_deal_id is null or not (authz.can_edit_booking_draft(p_deal_id) or authz.can_confirm_booking(p_deal_id))
     or exists (select 1 from public.deals d where d.id = p_deal_id and d.removed_at is not null) then
    return null;
  end if;
  return authz.vn_trip_facts_json(p_deal_id, (authz.deal_current_version(p_deal_id)).id);
end;
$$;

-- ===========================================================================
-- 3. Trip save (replaces 20261124000110; lines marked VN)
-- ===========================================================================

create or replace function public.booking_trip_save(p_version_id uuid, p_expected_row_version integer, p_fields jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_bad text[];
  v_dest text;
  v_scope text;
  v_start date;
  v_end date;
  v_kept text[];  -- Batch 2
  -- Booking form
  v_pax integer;
  v_children integer;
  v_infants integer;
  -- VN
  v_fields jsonb;
  v_use jsonb;
  v_adults integer;
  v_over text[];
  v_def integer;
begin
  v_ver := authz.lock_package_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'trip';
  end if;
  -- VN: the values the server uses from Bitrix replace the input for those
  -- keys (server authoritative); every key then passes the usual checks.
  v_use := coalesce(authz.vn_trip_bitrix(v_ver.deal_id) -> 'use', '{}'::jsonb);
  v_fields := (p_fields - array(select jsonb_object_keys(v_use))) || v_use;
  v_bad := authz.b11_unknown_keys(v_fields, array['destination', 'scope', 'start', 'end',
    'paxTotal', 'children', 'infants', 'adults']);  -- booking form; VN adults
  if not authz.sf_text_ok(v_fields -> 'destination', 200, false) then v_bad := v_bad || 'destination'::text; end if;
  v_dest := authz.b11_text(v_fields -> 'destination');
  v_scope := authz.b11_text(v_fields -> 'scope');
  if (v_fields ? 'scope' and jsonb_typeof(v_fields -> 'scope') not in ('string', 'null'))
     or (v_scope is not null and v_scope not in ('domestic', 'international')) then
    v_bad := v_bad || 'scope'::text;
  end if;
  v_start := authz.sf_date(v_fields -> 'start');
  if v_fields ? 'start' and jsonb_typeof(v_fields -> 'start') <> 'null' and v_start is null then v_bad := v_bad || 'start'::text; end if;
  v_end := authz.sf_date(v_fields -> 'end');
  if (v_fields ? 'end' and jsonb_typeof(v_fields -> 'end') <> 'null' and v_end is null) or v_end < v_start
     -- Booking form (review A H1): at most 365 nights.
     or v_end - v_start > 365 then
    v_bad := v_bad || 'end'::text;
  end if;
  -- Booking form: party counts (absent key = unchanged).
  v_pax := case when v_fields ? 'paxTotal' then authz.sf_int_value(v_fields -> 'paxTotal') else v_ver.pax_total end;
  v_children := case when v_fields ? 'children' then authz.sf_int_value(v_fields -> 'children') else v_ver.children_count end;
  v_infants := case when v_fields ? 'infants' then authz.sf_int_value(v_fields -> 'infants') else v_ver.infants_count end;
  if not authz.sf_int_ok(v_fields -> 'paxTotal', 1, 100, false) then v_bad := v_bad || 'paxTotal'::text; end if;
  if not authz.sf_int_ok(v_fields -> 'children', 0, 100, false) then
    v_bad := v_bad || 'children'::text;
  elsif coalesce(v_children, 0) + coalesce(v_infants, 0) > coalesce(v_pax, 100) and not ('paxTotal' = any (v_bad)) then
    v_bad := v_bad || 'children'::text;
  end if;
  if not authz.sf_int_ok(v_fields -> 'infants', 0, 100, false) then
    v_bad := v_bad || 'infants'::text;
  elsif coalesce(v_children, 0) + coalesce(v_infants, 0) > coalesce(v_pax, 100) and not ('paxTotal' = any (v_bad))
        and not ('children' = any (v_bad)) then
    v_bad := v_bad || 'infants'::text;
  end if;
  -- VN: adults (absent key = unchanged).
  v_adults := case when v_fields ? 'adults' then authz.sf_int_value(v_fields -> 'adults') else v_ver.adults_count end;
  if not authz.sf_int_ok(v_fields -> 'adults', 0, 100, false)
     -- Echo-A L1: once recorded, adults cannot be cleared (the count rule stays on).
     or (v_ver.adults_count is not null and v_adults is null) then
    v_bad := v_bad || 'adults'::text;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  -- VN: count rule (only where adults are recorded; older versions keep today's rules).
  if v_adults is not null
     and (v_pax is null or v_adults + coalesce(v_children, 0) + coalesce(v_infants, 0) <> v_pax) then
    raise exception 'party_count_mismatch' using errcode = '22023', hint = 'adults,children,infants,paxTotal';
  end if;
  -- VN: a count never drops below the named travellers of that type (nothing is deleted here).
  if v_adults is not null then
    select array_remove(array[
      case when count(*) filter (where t.traveller_type = 'adult') > v_adults then 'adult' end,
      case when count(*) filter (where t.traveller_type = 'child') > coalesce(v_children, 0) then 'child' end,
      case when count(*) filter (where t.traveller_type = 'infant') > coalesce(v_infants, 0) then 'infant' end], null)
    into v_over
    from public.deal_travellers t where t.deal_id = v_ver.deal_id;
    if cardinality(v_over) > 0 then
      raise exception 'traveller_count_exceeded' using errcode = '22023', hint = array_to_string(v_over, ',');
    end if;
  end if;
  update public.booking_versions v
  set trip_destination = v_dest, trip_scope = v_scope, trip_start = v_start, trip_end = v_end,
      pax_total = v_pax, children_count = v_children, infants_count = v_infants,  -- booking form
      adults_count = v_adults  -- VN
  where v.id = v_ver.id;
  -- VN: hotels whose adults follow the booking.
  v_def := authz.vn_refresh_hotel_adults(v_ver.id);
  v_kept := authz.prefill_mark_kept('booking_version', v_ver.id, array['trip.start', 'trip.end']);  -- Batch 2 (BC-A8)
  v_ver := authz.bump_package_version(v_ver.id);
  perform authz.write_audit('booking.trip_saved', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'rowVersion', v_ver.row_version)
    || case when authz.prefill_auto_fill_enabled() then jsonb_build_object('keptFields', to_jsonb(v_kept)) else '{}'::jsonb end
    -- VN: names of the fields taken from Bitrix (never values).
    || case when v_use <> '{}'::jsonb
            then jsonb_build_object('bitrixFields', to_jsonb(array(select k from jsonb_object_keys(v_use) k order by k)))
            else '{}'::jsonb end);
  -- VN: bitrixFields only when the server took a value from Bitrix (older answers unchanged).
  return jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash)
    || case when v_use <> '{}'::jsonb
            then jsonb_build_object('bitrixFields', to_jsonb(array(select k from jsonb_object_keys(v_use) k order by k)))
            else '{}'::jsonb end;
end;
$$;

-- ===========================================================================
-- 4. Hotel facts (replaces 20261124000120; lines marked VN)
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
                            'catalogueHotelId']
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

-- ===========================================================================
-- 5. Service save: hotel adults default (replaces 20261124000110; lines marked VN)
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
  -- (authz.vn_hotel_adults_default fills the value on every save path.)
  if v_type = 'hotel' and jsonb_typeof(p_facts) = 'object'
     and coalesce(jsonb_typeof(p_facts -> 'adults'), 'null') = 'null' then
    v_defaulted := true;
    v_def := authz.vn_version_adults(v_ver.id);
    -- A hotel is never stored without adults (every reader requires them):
    -- with no counts and no adult passengers yet, staff enter the counts first.
    if v_def is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'paxTotal';
    end if;
    v_facts := (p_facts - 'adults') || jsonb_build_object('adults', v_def);
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
-- 6. Travellers: special request codes, count limit (replaces 20261119000300;
--    lines marked VN)
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
-- 7. Passenger extra phones (replaces 20261124000110; lines marked VN)
-- ===========================================================================

create or replace function public.traveller_identity_save(p_deal_id uuid, p_seq integer, p_expected_row_version integer, p_fields jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_trav public.deal_travellers%rowtype;
  v_old public.traveller_identities%rowtype;
  v_bad text[];
  v_dob date;
  v_nat text;
  v_pass text;
  v_exp date;
  v_row integer;
  v_branch uuid;
  -- Booking form
  v_dom date;
  v_phone text;
  v_email text;
  v_extra text[];  -- VN
begin
  perform authz.refuse_removed_deal(p_deal_id);
  if p_deal_id is null or not authz.b11_can_edit_identity(p_deal_id, p_seq) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not authz.service_items_enabled() then
    raise exception 'service_items_disabled' using errcode = '55000';
  end if;
  if authz.deal_not_active(p_deal_id) then
    raise exception 'deal_not_active' using errcode = '55000';
  end if;
  select * into v_trav from public.deal_travellers t where t.deal_id = p_deal_id and t.seq = p_seq for update;
  if v_trav.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_old from public.traveller_identities x where x.traveller_id = v_trav.id for update;
  perform authz.require_row_version(p_expected_row_version, coalesce(v_old.row_version, 0));
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'identity';
  end if;
  v_bad := authz.b11_unknown_keys(p_fields, array['dateOfBirth', 'nationality', 'passportNumber', 'passportExpiry',
    'dateOfMarriage', 'phone', 'email', 'extraPhones']);  -- VN extraPhones
  v_dob := authz.b11_date(p_fields -> 'dateOfBirth', date '1900-01-01', current_date - 1);
  if p_fields ? 'dateOfBirth' and jsonb_typeof(p_fields -> 'dateOfBirth') <> 'null' and v_dob is null then
    v_bad := v_bad || 'dateOfBirth'::text;
  end if;
  v_nat := authz.b11_text(p_fields -> 'nationality');
  if not authz.sf_text_ok(p_fields -> 'nationality', 60, false) or length(v_nat) < 2 then
    v_bad := v_bad || 'nationality'::text;
  end if;
  v_pass := nullif(upper(regexp_replace(coalesce(authz.b11_text(p_fields -> 'passportNumber'), ''), '[ -]', '', 'g')), '');
  if (p_fields ? 'passportNumber' and jsonb_typeof(p_fields -> 'passportNumber') not in ('string', 'null'))
     or (v_pass is not null and v_pass !~ '^[A-Z0-9]{6,15}$') then
    v_bad := v_bad || 'passportNumber'::text;
  end if;
  v_exp := authz.sf_date(p_fields -> 'passportExpiry');
  if p_fields ? 'passportExpiry' and jsonb_typeof(p_fields -> 'passportExpiry') <> 'null' and v_exp is null then
    v_bad := v_bad || 'passportExpiry'::text;
  end if;
  -- Booking form: extras (absent = unchanged).
  if p_fields ? 'dateOfMarriage' then
    v_dom := authz.b11_date(p_fields -> 'dateOfMarriage', date '1900-01-01', current_date);
    if (jsonb_typeof(p_fields -> 'dateOfMarriage') <> 'null' and v_dom is null) or v_dom < v_dob then
      v_bad := v_bad || 'dateOfMarriage'::text;
    end if;
  else
    v_dom := v_old.date_of_marriage;
    if v_dom < v_dob then v_bad := v_bad || 'dateOfMarriage'::text; end if;
  end if;
  if p_fields ? 'phone' then
    v_phone := authz.bf_phone(authz.b11_text(p_fields -> 'phone'));
    if jsonb_typeof(p_fields -> 'phone') not in ('string', 'null')
       or (authz.b11_text(p_fields -> 'phone') is not null and v_phone is null) then
      v_bad := v_bad || 'phone'::text;
    end if;
  else
    v_phone := v_old.phone;
  end if;
  if p_fields ? 'email' then
    v_email := lower(authz.b11_text(p_fields -> 'email'));
    if jsonb_typeof(p_fields -> 'email') not in ('string', 'null')
       or (v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')) then
      v_bad := v_bad || 'email'::text;
    end if;
  else
    v_email := v_old.email;
  end if;
  -- VN: extra phones (absent = unchanged; null or [] = none), each by the phone rule, at most 3.
  if p_fields ? 'extraPhones' then
    if jsonb_typeof(p_fields -> 'extraPhones') = 'null' then
      v_extra := '{}'::text[];
    elsif jsonb_typeof(p_fields -> 'extraPhones') <> 'array'
          or exists (select 1 from jsonb_array_elements(p_fields -> 'extraPhones') x where jsonb_typeof(x) <> 'string') then
      v_bad := v_bad || 'extraPhones'::text;
    else
      v_extra := array(select authz.bf_phone(x) from jsonb_array_elements_text(p_fields -> 'extraPhones') x
                       where btrim(x) <> '');
      if not authz.vn_phones_ok(v_extra) then
        v_bad := v_bad || 'extraPhones'::text;
      end if;
    end if;
  else
    v_extra := coalesce(v_old.extra_phones, '{}'::text[]);
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;

  if v_dob is null and v_nat is null and v_pass is null and v_exp is null
     and v_dom is null and v_phone is null and v_email is null and cardinality(v_extra) = 0 then  -- VN extra phones
    delete from public.traveller_identities x where x.traveller_id = v_trav.id;
    v_row := 0;
  elsif v_old.traveller_id is null then
    insert into public.traveller_identities (traveller_id, deal_id, legal_entity_id, date_of_birth, nationality,
      passport_number, passport_expiry, date_of_marriage, phone, email, updated_by, extra_phones)
    values (v_trav.id, p_deal_id, v_trav.legal_entity_id, v_dob, v_nat, v_pass, v_exp, v_dom, v_phone, v_email,
      (select auth.uid()), v_extra)
    returning row_version into v_row;
  else
    update public.traveller_identities x
    set date_of_birth = v_dob, nationality = v_nat, passport_number = v_pass, passport_expiry = v_exp,
        date_of_marriage = v_dom, phone = v_phone, email = v_email, extra_phones = v_extra,  -- VN
        row_version = x.row_version + 1, updated_by = (select auth.uid())
    where x.traveller_id = v_trav.id
    returning row_version into v_row;
  end if;

  select d.branch_id into v_branch from public.deals d where d.id = p_deal_id;
  -- Field names only; never the values.
  perform authz.write_audit('booking.traveller_identity_saved', v_trav.legal_entity_id, v_branch, 'deal', p_deal_id, null,
    jsonb_build_object('seq', p_seq, 'changedFields', to_jsonb(array_remove(array[
      case when v_old.date_of_birth is distinct from v_dob then 'dateOfBirth' end,
      case when v_old.nationality is distinct from v_nat then 'nationality' end,
      case when v_old.passport_number is distinct from v_pass then 'passportNumber' end,
      case when v_old.passport_expiry is distinct from v_exp then 'passportExpiry' end,
      case when v_old.date_of_marriage is distinct from v_dom then 'dateOfMarriage' end,
      case when v_old.phone is distinct from v_phone then 'phone' end,
      case when v_old.email is distinct from v_email then 'email' end,
      case when coalesce(v_old.extra_phones, '{}'::text[]) is distinct from v_extra then 'extraPhones' end], null)),
      'rowVersion', v_row));
  return jsonb_build_object('seq', p_seq, 'rowVersion', v_row);
end;
$$;

-- ===========================================================================
-- 8. Hotel adults on every save path (lead ruling Q5)
-- ===========================================================================

-- Before the facts guard (trigger name sorts first): a hotel saved without
-- adults (any command) takes the booking adults and follows them; an edit
-- that changes adults by hand stops following (except the refresh below).
create function authz.vn_hotel_adults_default() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_def integer;
begin
  if not exists (select 1 from public.service_items i where i.id = new.service_item_id and i.service_type = 'hotel') then
    return new;
  end if;
  -- The catalogue row id is checked by validate_service_facts but never
  -- stored in the facts: readers (and the previous app) parse hotel facts
  -- with a fixed key list.
  new.facts := new.facts - 'catalogueHotelId';
  if coalesce(jsonb_typeof(new.facts -> 'adults'), 'null') = 'null' then
    v_def := authz.vn_version_adults(new.booking_version_id);
    if v_def is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'adults';
    end if;
    new.facts := (new.facts - 'adults') || jsonb_build_object('adults', v_def);
    new.adults_from_booking := true;
  elsif tg_op = 'UPDATE' and (new.facts -> 'adults') is distinct from (old.facts -> 'adults')
        and coalesce(current_setting('tripnavigate.vn_adults_refresh', true), '') <> 'on' then
    new.adults_from_booking := false;
  elsif tg_op = 'INSERT' then
    -- A revision copies the base version's facts: the copy keeps following
    -- the booking when the base row did (same item, same adults).
    new.adults_from_booking := coalesce((
      select f.adults_from_booking
      from public.booking_versions v
      join public.service_item_facts f on f.booking_version_id = v.revises_version_id
      where v.id = new.booking_version_id and f.service_item_id = new.service_item_id
        and (f.facts -> 'adults') = (new.facts -> 'adults')), new.adults_from_booking);
  end if;
  return new;
end;
$$;
create trigger service_item_facts_0_vn_adults
  before insert or update on public.service_item_facts
  for each row execute function authz.vn_hotel_adults_default();

-- Puts the booking adults into the hotels of a draft that follow them (trip
-- and traveller saves). Answers the number of hotels changed.
create function authz.vn_refresh_hotel_adults(p_version uuid) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_def integer := authz.vn_version_adults(p_version);
  v_n integer := 0;
begin
  if v_def is null then
    return 0;
  end if;
  perform set_config('tripnavigate.vn_adults_refresh', 'on', true);
  update public.service_item_facts f
  set facts = jsonb_set(f.facts, '{adults}', to_jsonb(v_def)), updated_at = now()
  from public.service_items i
  where f.booking_version_id = p_version and f.adults_from_booking and i.id = f.service_item_id
    and i.service_type = 'hotel' and (f.facts -> 'adults') is distinct from to_jsonb(v_def)
    and exists (select 1 from public.booking_versions v where v.id = p_version and v.status = 'draft');
  get diagnostics v_n = row_count;
  perform set_config('tripnavigate.vn_adults_refresh', '', true);
  return v_n;
end;
$$;

-- ===========================================================================
-- 9. Special requests in the snapshot and the hash (lead ruling Q1)
-- ===========================================================================

-- Snapshot column, filled from the live traveller at confirmation (any
-- command that writes the snapshot; the snapshot stays immutable).
alter table public.booking_version_travellers
  add column special_requests text[] not null default '{}' check (authz.vn_codes_ok(special_requests));
comment on column public.booking_version_travellers.special_requests is
  'Voice-note batch: special request codes frozen at confirmation (hash schema 4 and later include them).';

create function authz.vn_snapshot_special_requests() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.special_requests := coalesce((
    select t.special_requests from public.deal_travellers t
    join public.booking_versions v on v.deal_id = t.deal_id
    where v.id = new.booking_version_id and t.seq = new.seq), '{}'::text[]);
  return new;
end;
$$;
create trigger booking_version_travellers_0_vn_requests
  before insert on public.booking_version_travellers
  for each row execute function authz.vn_snapshot_special_requests();

-- Hash schema 4 for versions created from now on; every existing version
-- keeps its schema (and so its stored and accepted hashes).
alter table public.booking_versions drop constraint booking_versions_hash_schema_check;
alter table public.booking_versions
  add constraint booking_versions_hash_schema_check check (hash_schema in (1, 2, 3, 4));
alter table public.booking_versions alter column hash_schema set default 4;

-- Replaces 20261124000100 (lines marked VN).
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
             e.vehicle_rate_paise, e.fare_total_paise) order by i.item_no)
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
  || case when v.revises_version_id is not null
         then jsonb_build_object('revision', jsonb_build_array(v.revises_version_id, v.change_class))
         else '{}'::jsonb end end::text, 'UTF8')), 'hex')
$$;

-- ===========================================================================
-- 10. Quotation conversion records the adults (lead ruling Q4; replaces
--     20261124000120, lines marked VN)
-- ===========================================================================

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
                                      'infants', v_ver.infants) end
      -- VN (lead ruling Q4): the quote's adults when its split is consistent
      -- and no named travellers of a type exceed it; else not recorded.
      || case when v_party is not null and v_ver.adults between 0 and 100
                   and not exists (
                     select 1 from public.deal_travellers t where t.deal_id = v_deal
                     group by t.traveller_type
                     having count(*) > case t.traveller_type when 'adult' then v_ver.adults
                                                             when 'child' then v_ver.children_with_bed + v_ver.children_no_bed
                                                             else v_ver.infants end)
              then jsonb_build_object('adults', v_ver.adults) else '{}'::jsonb end) ->> 'rowVersion')::integer;
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

-- ===========================================================================
-- 11. Revisions: special request codes in the change list (lead ruling;
--     replaces 20261124000120, lines marked VN)
-- ===========================================================================

create or replace function authz.revision_field_class(p_field text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_field ~ '^items\.[0-9]+\.purchaseBudgetPaise$' then 'internal'
    -- Booking form: supplier estimates and per-person purchase are internal; the
    -- final sale (prices.sale) stays material.
    when p_field ~ '^items\.[0-9]+\.estimate$' or p_field = 'prices.cost' then 'internal'
    when p_field ~ '^items\.[0-9]+\.(hotelName|city|area|roomType|mealPlan|inclusions|exclusions|specialRequests|preferences|notes|bedRemarks|route|pickup|drop|vehicleType|name|cabin|preferredTime|assistance|purpose|officeCity|vendor)$'
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
    where (ev.room_rate_paise, ev.extra_bed_rate_paise, ev.no_bed_rate_paise, ev.vehicle_rate_paise, ev.fare_total_paise)
          is distinct from
          (eb.room_rate_paise, eb.extra_bed_rate_paise, eb.no_bed_rate_paise, eb.vehicle_rate_paise, eb.fare_total_paise)
  )
  select coalesce(array_agg(distinct f order by f), '{}'::text[]) from fields
$$;

-- ===========================================================================
-- 12. Readiness: a hotel needs adults (Echo-A L9; replaces 20261118000100)
-- ===========================================================================

-- Items whose facts fail the save rule, plus (VN) hotels with no adults at
-- all (no adults typed and none derivable from the booking): readiness
-- answers service_facts_invalid until the adults are known.
create or replace function authz.service_item_invalid_nos(p_version uuid) returns integer[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(i.item_no order by i.item_no), '{}'::integer[])
  from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
  where f.booking_version_id = p_version
    and (cardinality(authz.validate_service_facts(i.service_type, f.facts)) > 0
         -- VN
         or (i.service_type = 'hotel' and coalesce(authz.sf_int_value(f.facts -> 'adults'), 0) < 1))
$$;

-- ===========================================================================
-- 13. Privileges
-- ===========================================================================

revoke all on function authz.vn_hotel_adults_default(), authz.vn_refresh_hotel_adults(uuid),
  authz.vn_snapshot_special_requests()
from public, anon, authenticated, service_role;
revoke all on function authz.vn_special_request_codes(), authz.vn_codes_ok(text[]), authz.vn_phones_ok(text[]),
  authz.vn_version_adults(uuid), authz.vn_trip_bitrix(uuid), authz.vn_fact_field(jsonb, jsonb, jsonb),
  authz.vn_trip_facts_json(uuid, uuid)
from public, anon, authenticated, service_role;
revoke all on function public.booking_trip_facts(uuid) from public, anon, authenticated, service_role;
grant execute on function public.booking_trip_facts(uuid) to authenticated;

commit;
