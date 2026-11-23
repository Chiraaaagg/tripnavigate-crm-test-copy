-- TripNavigate CRM - booking form (22 October 2026): commands.
--
-- Contract: docs/implementation/booking-form-2026-10-22/contract.md section 3
--   (frozen 22 Oct 2026) and booking-form-contract.ts. Depends on
--   20261124000100_booking_form_schema.sql.
--
-- New commands:
--   * booking_form_start(deal)            booking_start_draft + form rules 2 on a NEW draft
--   * booking_prices_save(version, rv, lines, request)   per-person prices; total derived here
--   * booking_service_save(version, rv, item|null, type, facts, budget|null,
--                          estimate|null, participants|null, request)
--                                         item add/save + estimate + participation, one transaction
--   * service_item_file_begin / _finish / _remove / _authorize_download   flight screenshot
-- Replaced (same signatures; latest bodies copied, booking-form lines marked):
--   * booking_trip_save (20261122000100): party keys paxTotal, children, infants
--     (absent = unchanged, so older callers never wipe them).
--   * authz.b11_contacts_write (20261122000100): customerType, market (absent = unchanged).
--   * traveller_identity_save (20261119000100): dateOfMarriage, phone, email (absent = unchanged).
--   * authz.b11_billing_propose (20261119000100) and accounts_billing_save
--     (20261101000100): billToType, contactPerson, phone, email, gstStatus,
--     gstReason (absent = unchanged). Sales never verifies; an Accounts edit
--     still resets verification.
--   * booking_commercials_save (20261119000100) and the legacy selling path
--     booking_save_draft (20261119000300): refuse priced_per_person while
--     per-person prices are in use.
--
-- Refusal tokens (message is exactly the token): existing invalid_input
-- (22023, hint names the field, never a value), not_authorized (42501),
-- version_changed / request_conflict (40001), wrong_state, deal_removed,
-- service_items_disabled, deal_not_active, billing_verified (55000),
-- evidence_rejected (22023), not_found (P0002). New:
--   55000 priced_per_person   booking_commercials_save / booking_save_draft selling total while prices are in use
--   55000 item_file_limit     a sixth live file on one service item
--
-- Amended 22 October 2026 after independent review A (Echo, before this file
-- ran on any kept database):
--   H1  booking_trip_save refuses a trip over 365 nights (hint end).
--   M4  booking_prices_save removes the selling total only where per-person
--       prices are required (new-form drafts and their revisions); converted
--       and older drafts keep their total until complete prices give a
--       positive total.
--   L6  accounts_billing_save lists the Bill To names on a first save.
--   L7  service_item_file_remove refuses with the switch off and on a lost
--       Deal, as service_item_file_begin does.
--   L8  booking_prices_save stores no amount in finance_command_results; an
--       exact retry re-reads the total (the caller passed the commercial check).
--
-- Rollback (forward-only): a NEW migration revoking execute on the new
-- commands and restoring the replaced bodies. Rows are kept.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Start (form rules 2)
-- ===========================================================================

-- booking_start_draft (unchanged behaviour: creation fill while the switch is
-- on) with form rules 2 on a draft this call creates. An existing draft keeps
-- its rules; versions started before the booking form stay 1.
create function public.booking_form_start(p_deal_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_res jsonb;
begin
  perform set_config('tripnavigate.booking_form_rules', '2', true);
  v_res := public.booking_start_draft(p_deal_id);
  perform set_config('tripnavigate.booking_form_rules', '', true);
  return v_res || jsonb_build_object('formRules',
    (select v.form_rules from public.booking_versions v where v.id = (v_res ->> 'versionId')::uuid));
end;
$$;

-- ===========================================================================
-- 2. Trip and party
-- ===========================================================================

-- Replaces 20261122000100: party counts (booking form). destination, scope,
-- start and end keep their meaning (absent = cleared, as today); the party
-- keys are optional (absent = unchanged).
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
begin
  v_ver := authz.lock_package_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'trip';
  end if;
  v_bad := authz.b11_unknown_keys(p_fields, array['destination', 'scope', 'start', 'end',
    'paxTotal', 'children', 'infants']);  -- booking form
  if not authz.sf_text_ok(p_fields -> 'destination', 200, false) then v_bad := v_bad || 'destination'::text; end if;
  v_dest := authz.b11_text(p_fields -> 'destination');
  v_scope := authz.b11_text(p_fields -> 'scope');
  if (p_fields ? 'scope' and jsonb_typeof(p_fields -> 'scope') not in ('string', 'null'))
     or (v_scope is not null and v_scope not in ('domestic', 'international')) then
    v_bad := v_bad || 'scope'::text;
  end if;
  v_start := authz.sf_date(p_fields -> 'start');
  if p_fields ? 'start' and jsonb_typeof(p_fields -> 'start') <> 'null' and v_start is null then v_bad := v_bad || 'start'::text; end if;
  v_end := authz.sf_date(p_fields -> 'end');
  if (p_fields ? 'end' and jsonb_typeof(p_fields -> 'end') <> 'null' and v_end is null) or v_end < v_start
     -- Booking form (review A H1): at most 365 nights.
     or v_end - v_start > 365 then
    v_bad := v_bad || 'end'::text;
  end if;
  -- Booking form: party counts (absent key = unchanged).
  v_pax := case when p_fields ? 'paxTotal' then authz.sf_int_value(p_fields -> 'paxTotal') else v_ver.pax_total end;
  v_children := case when p_fields ? 'children' then authz.sf_int_value(p_fields -> 'children') else v_ver.children_count end;
  v_infants := case when p_fields ? 'infants' then authz.sf_int_value(p_fields -> 'infants') else v_ver.infants_count end;
  if not authz.sf_int_ok(p_fields -> 'paxTotal', 1, 100, false) then v_bad := v_bad || 'paxTotal'::text; end if;
  if not authz.sf_int_ok(p_fields -> 'children', 0, 100, false) then
    v_bad := v_bad || 'children'::text;
  elsif coalesce(v_children, 0) + coalesce(v_infants, 0) > coalesce(v_pax, 100) and not ('paxTotal' = any (v_bad)) then
    v_bad := v_bad || 'children'::text;
  end if;
  if not authz.sf_int_ok(p_fields -> 'infants', 0, 100, false) then
    v_bad := v_bad || 'infants'::text;
  elsif coalesce(v_children, 0) + coalesce(v_infants, 0) > coalesce(v_pax, 100) and not ('paxTotal' = any (v_bad))
        and not ('children' = any (v_bad)) then
    v_bad := v_bad || 'infants'::text;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  update public.booking_versions v
  set trip_destination = v_dest, trip_scope = v_scope, trip_start = v_start, trip_end = v_end,
      pax_total = v_pax, children_count = v_children, infants_count = v_infants  -- booking form
  where v.id = v_ver.id;
  v_kept := authz.prefill_mark_kept('booking_version', v_ver.id, array['trip.start', 'trip.end']);  -- Batch 2 (BC-A8)
  v_ver := authz.bump_package_version(v_ver.id);
  perform authz.write_audit('booking.trip_saved', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'rowVersion', v_ver.row_version)
    || case when authz.prefill_auto_fill_enabled() then jsonb_build_object('keptFields', to_jsonb(v_kept)) else '{}'::jsonb end);
  return jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;

-- ===========================================================================
-- 3. Contacts: customer type and market
-- ===========================================================================

-- authz.b11_contacts_write (replaces 20261122000100): customerType and market
-- (booking form; absent = unchanged).
create or replace function authz.b11_contacts_write(p_ver public.booking_versions, p_fields jsonb) returns text[]
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_old public.booking_version_contacts%rowtype;
  v_bad text[];
  v_name text;
  v_mobile text;
  v_email text;
  v_confirmed boolean;
  v_for text;
  v_payer_diff boolean;
  v_payer text;
  v_by uuid;
  v_at timestamptz;
  v_ticked text[];  -- Batch 2
  v_type text;      -- booking form
  v_market text;    -- booking form
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'contact';
  end if;
  v_bad := authz.b11_unknown_keys(p_fields, array['contactName', 'mobile', 'email', 'contactConfirmed', 'bookingFor',
    'payerDifferent', 'payerName', 'customerType', 'market']);
  if not authz.sf_text_ok(p_fields -> 'contactName', 120, true) then v_bad := v_bad || 'contactName'::text; end if;
  v_name := authz.b11_text(p_fields -> 'contactName');
  v_mobile := regexp_replace(coalesce(authz.b11_text(p_fields -> 'mobile'), ''), '[ -]', '', 'g');
  v_mobile := nullif(v_mobile, '');
  if (p_fields ? 'mobile' and jsonb_typeof(p_fields -> 'mobile') not in ('string', 'null'))
     or (v_mobile is not null and v_mobile !~ '^[6-9][0-9]{9}$') then
    v_bad := v_bad || 'mobile'::text;
  end if;
  v_email := lower(authz.b11_text(p_fields -> 'email'));
  if (p_fields ? 'email' and jsonb_typeof(p_fields -> 'email') not in ('string', 'null'))
     or (v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')) then
    v_bad := v_bad || 'email'::text;
  end if;
  if v_mobile is null and v_email is null and not ('mobile' = any (v_bad)) and not ('email' = any (v_bad)) then
    v_bad := v_bad || array['mobile', 'email'];
  end if;
  v_confirmed := authz.b11_bool(p_fields -> 'contactConfirmed', false);
  if v_confirmed is null then v_bad := v_bad || 'contactConfirmed'::text; end if;
  v_for := authz.b11_text(p_fields -> 'bookingFor');
  if v_for is null or v_for not in ('individual', 'business') then v_bad := v_bad || 'bookingFor'::text; end if;
  v_payer_diff := authz.b11_bool(p_fields -> 'payerDifferent', false);
  if v_payer_diff is null then
    v_bad := v_bad || 'payerDifferent'::text;
  elsif v_payer_diff then
    if not authz.sf_text_ok(p_fields -> 'payerName', 200, true) then v_bad := v_bad || 'payerName'::text; end if;
    v_payer := authz.b11_text(p_fields -> 'payerName');
  end if;

  select * into v_old from public.booking_version_contacts c where c.booking_version_id = p_ver.id for update;
  -- Booking form: plain labels (absent = unchanged).
  v_type := case when p_fields ? 'customerType' then authz.b11_text(p_fields -> 'customerType') else v_old.customer_type end;
  if (p_fields ? 'customerType' and jsonb_typeof(p_fields -> 'customerType') not in ('string', 'null'))
     or (v_type is not null and v_type not in ('individual', 'b2d', 'corporate', 'travel_agent')) then
    v_bad := v_bad || 'customerType'::text;
  end if;
  v_market := case when p_fields ? 'market' then authz.b11_text(p_fields -> 'market') else v_old.market end;
  if (p_fields ? 'market' and jsonb_typeof(p_fields -> 'market') not in ('string', 'null'))
     or (v_market is not null and v_market not in ('india', 'uae', 'other')) then
    v_bad := v_bad || 'market'::text;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;

  -- Confirmation names who confirmed the channel; a changed channel needs a
  -- fresh confirmation (kept only while the mobile and email are unchanged).
  if v_confirmed then
    if v_old.contact_confirmed and v_old.mobile is not distinct from v_mobile and v_old.email is not distinct from v_email then
      v_by := v_old.confirmed_by;
      v_at := v_old.confirmed_at;
    else
      v_by := (select auth.uid());
      v_at := now();
    end if;
  end if;

  insert into public.booking_version_contacts as c (booking_version_id, legal_entity_id, deal_id, contact_name, mobile,
    email, contact_confirmed, confirmed_by, confirmed_at, booking_for, payer_different, payer_name, updated_by,
    customer_type, market)
  values (p_ver.id, p_ver.legal_entity_id, p_ver.deal_id, v_name, v_mobile, v_email, v_confirmed, v_by, v_at, v_for,
    v_payer_diff, v_payer, (select auth.uid()), v_type, v_market)
  on conflict (booking_version_id) do update
    set contact_name = excluded.contact_name, mobile = excluded.mobile, email = excluded.email,
        contact_confirmed = excluded.contact_confirmed, confirmed_by = excluded.confirmed_by,
        confirmed_at = excluded.confirmed_at, booking_for = excluded.booking_for,
        payer_different = excluded.payer_different, payer_name = excluded.payer_name, updated_by = excluded.updated_by,
        customer_type = excluded.customer_type, market = excluded.market;

  -- Batch 2 (BC-A8b, contracts F.2 item 5; switch on only).
  if v_confirmed and authz.prefill_auto_fill_enabled()
     and coalesce(current_setting('tripnavigate.prefill_apply', true), '') is distinct from p_ver.id::text
     and not (coalesce(v_old.contact_confirmed, false) and v_old.mobile is not distinct from v_mobile
              and v_old.email is not distinct from v_email) then
    with u as (
      update public.prefill_marks m set state = 'checked', checked_by = (select auth.uid()), checked_at = now()
      where m.target_kind = 'booking_version' and m.target_id = p_ver.id
        and m.field_code in ('contacts.mobile', 'contacts.email') and m.state in ('from_bitrix', 'kept')
      returning m.field_code)
    select coalesce(array_agg(u.field_code order by u.field_code), '{}'::text[]) into v_ticked from u;
    if cardinality(v_ticked) > 0 then
      perform authz.write_audit('prefill.checked', p_ver.legal_entity_id, p_ver.branch_id, 'booking_version', p_ver.id, null,
        jsonb_build_object('targetKind', 'booking_version', 'targetId', p_ver.id, 'fields', to_jsonb(v_ticked),
          'via', 'contact_confirmation'));
    end if;
  end if;

  return array_remove(array[
    case when v_old.contact_name is distinct from v_name then 'contactName' end,
    case when v_old.mobile is distinct from v_mobile then 'mobile' end,
    case when v_old.email is distinct from v_email then 'email' end,
    case when v_old.contact_confirmed is distinct from v_confirmed then 'contactConfirmed' end,
    case when v_old.booking_for is distinct from v_for then 'bookingFor' end,
    case when v_old.payer_different is distinct from v_payer_diff then 'payerDifferent' end,
    case when v_old.payer_name is distinct from v_payer then 'payerName' end,
    case when v_old.customer_type is distinct from v_type then 'customerType' end,
    case when v_old.market is distinct from v_market then 'market' end], null);
end;
$$;

-- ===========================================================================
-- 4. Passenger extras
-- ===========================================================================

-- Phone as stored for billing and passengers: spaces, hyphens and brackets
-- removed; an Indian mobile or an E.164 number, else null (caller refuses).
create function authz.bf_phone(p_value text) returns text
language sql immutable set search_path = '' as $$
  select case when x ~ '^[6-9][0-9]{9}$' or x ~ '^\+[1-9][0-9]{6,14}$' then x end
  from (select regexp_replace(btrim(coalesce(p_value, '')), '[ ()-]', '', 'g') as x) s
$$;

-- Replaces 20261119000100: dateOfMarriage, phone, email (booking form;
-- absent = unchanged). Same gate (authz.b11_can_edit_identity).
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
    'dateOfMarriage', 'phone', 'email']);
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
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;

  if v_dob is null and v_nat is null and v_pass is null and v_exp is null
     and v_dom is null and v_phone is null and v_email is null then
    delete from public.traveller_identities x where x.traveller_id = v_trav.id;
    v_row := 0;
  elsif v_old.traveller_id is null then
    insert into public.traveller_identities (traveller_id, deal_id, legal_entity_id, date_of_birth, nationality,
      passport_number, passport_expiry, date_of_marriage, phone, email, updated_by)
    values (v_trav.id, p_deal_id, v_trav.legal_entity_id, v_dob, v_nat, v_pass, v_exp, v_dom, v_phone, v_email,
      (select auth.uid()))
    returning row_version into v_row;
  else
    update public.traveller_identities x
    set date_of_birth = v_dob, nationality = v_nat, passport_number = v_pass, passport_expiry = v_exp,
        date_of_marriage = v_dom, phone = v_phone, email = v_email,
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
      case when v_old.email is distinct from v_email then 'email' end], null)), 'rowVersion', v_row));
  return jsonb_build_object('seq', p_seq, 'rowVersion', v_row);
end;
$$;

-- ===========================================================================
-- 5. Bill To
-- ===========================================================================

-- The Bill To extras of a billing save (absent key = the stored value).
-- Returns the effective values and the invalid keys; never raises. A
-- personal Bill To carries no contact person, GST status or reason; a reason
-- is kept only for an unregistered business.
create function authz.bf_bill_to(p_fields jsonb, p_old public.customer_billing_profiles, p_gstin text)
returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_bad text[] := '{}'::text[];
  v_type text;
  v_contact text;
  v_phone text;
  v_email text;
  v_status text;
  v_reason text;
  v_raw text;
begin
  v_type := case when p_fields ? 'billToType' then authz.b11_text(p_fields -> 'billToType') else p_old.bill_to_type end;
  if (p_fields ? 'billToType' and jsonb_typeof(p_fields -> 'billToType') not in ('string', 'null'))
     or (v_type is not null and v_type not in ('personal', 'business')) then
    v_bad := v_bad || 'billToType'::text;
  end if;
  if p_fields ? 'contactPerson' then
    v_contact := authz.b11_text(p_fields -> 'contactPerson');
    if not authz.sf_text_ok(p_fields -> 'contactPerson', 120, false) then v_bad := v_bad || 'contactPerson'::text; end if;
  else
    v_contact := p_old.contact_person;
  end if;
  if p_fields ? 'phone' then
    v_raw := authz.b11_text(p_fields -> 'phone');
    v_phone := authz.bf_phone(v_raw);
    if jsonb_typeof(p_fields -> 'phone') not in ('string', 'null') or (v_raw is not null and v_phone is null) then
      v_bad := v_bad || 'phone'::text;
    end if;
  else
    v_phone := p_old.phone;
  end if;
  if p_fields ? 'email' then
    v_email := lower(authz.b11_text(p_fields -> 'email'));
    if jsonb_typeof(p_fields -> 'email') not in ('string', 'null')
       or (v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')) then
      v_bad := v_bad || 'email'::text;
    end if;
  else
    v_email := p_old.email;
  end if;
  v_status := case when p_fields ? 'gstStatus' then authz.b11_text(p_fields -> 'gstStatus') else p_old.gst_status end;
  if (p_fields ? 'gstStatus' and jsonb_typeof(p_fields -> 'gstStatus') not in ('string', 'null'))
     or (v_status is not null and v_status not in ('registered', 'unregistered')) then
    v_bad := v_bad || 'gstStatus'::text;
  end if;
  if p_fields ? 'gstReason' then
    v_reason := authz.b11_text(p_fields -> 'gstReason');
    if jsonb_typeof(p_fields -> 'gstReason') not in ('string', 'null')
       or (v_reason is not null and (length(v_reason) not between 10 and 500 or v_reason ~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]')) then
      v_bad := v_bad || 'gstReason'::text;
    end if;
  else
    v_reason := p_old.gst_reason;
  end if;
  if v_type = 'personal' then
    v_contact := null;
    v_status := null;
    v_reason := null;
  end if;
  if v_status is distinct from 'unregistered' then
    v_reason := null;
  elsif p_gstin is not null then
    -- An unregistered business has no GSTIN.
    v_bad := v_bad || 'gstin'::text;
  end if;
  return jsonb_build_object('bad', to_jsonb(v_bad), 'type', v_type, 'contactPerson', v_contact, 'phone', v_phone,
    'email', v_email, 'gstStatus', v_status, 'gstReason', v_reason);
end;
$$;

-- Replaces 20261119000100: Bill To extras (booking form). A verified profile is
-- still refused (billing_verified); Sales never verifies.
create or replace function authz.b11_billing_propose(p_deal uuid, p_expected_row_version integer, p_fields jsonb, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_old public.customer_billing_profiles%rowtype;
  v_payload jsonb := jsonb_build_object('dealId', p_deal, 'expectedRowVersion', p_expected_row_version, 'fields', p_fields);
  v_result jsonb;
  v_name text; v_line1 text; v_line2 text; v_city text; v_state text; v_postal text; v_gstin text;
  v_changed text[] := '{}';
  v_row integer;
  v_x jsonb;        -- booking form
  v_bad text[];     -- booking form
begin
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_deal := authz.finance_lock_deal(p_deal);
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'booking_billing_propose', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['billingName', 'addressLine1', 'addressLine2', 'city', 'stateCode', 'postalCode', 'gstin',
                          'billToType', 'contactPerson', 'phone', 'email', 'gstStatus', 'gstReason']) <> '{}'::jsonb
     or p_expected_row_version is null or p_expected_row_version < 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'billing';
  end if;
  -- Text fields must be strings (the finance helpers raise without a hint).
  if exists (select 1 from unnest(array['billingName', 'addressLine1', 'addressLine2', 'city', 'stateCode', 'postalCode', 'gstin']) k
             where p_fields ? k and jsonb_typeof(p_fields -> k) not in ('string', 'null')) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'billing';
  end if;
  v_name := btrim(coalesce(p_fields ->> 'billingName', ''), E' \t\r\n');
  v_name := case when v_name = '' or length(v_name) > 200 or v_name ~ E'[\\x01-\\x1f\\x7f]' then null else v_name end;
  v_line1 := btrim(coalesce(p_fields ->> 'addressLine1', ''), E' \t\r\n');
  v_line1 := case when v_line1 = '' or length(v_line1) > 200 or v_line1 ~ E'[\\x01-\\x1f\\x7f]' then null else v_line1 end;
  v_line2 := nullif(btrim(coalesce(p_fields ->> 'addressLine2', ''), E' \t\r\n'), '');
  v_city := btrim(coalesce(p_fields ->> 'city', ''), E' \t\r\n');
  v_city := case when v_city = '' or length(v_city) > 120 or v_city ~ E'[\\x01-\\x1f\\x7f]' then null else v_city end;
  v_state := nullif(btrim(coalesce(p_fields ->> 'stateCode', ''), E' \t\r\n'), '');
  v_postal := nullif(btrim(coalesce(p_fields ->> 'postalCode', ''), E' \t\r\n'), '');
  v_gstin := nullif(upper(btrim(coalesce(p_fields ->> 'gstin', ''), E' \t\r\n')), '');

  select * into v_old from public.customer_billing_profiles b where b.deal_id = v_deal.id for update;
  v_x := authz.bf_bill_to(p_fields, v_old, v_gstin);
  v_bad := array_remove(array[
      case when v_name is null then 'billingName' end,
      case when v_line1 is null then 'addressLine1' end,
      case when v_line2 is not null and (length(v_line2) > 200 or v_line2 ~ E'[\\x01-\\x1f\\x7f]') then 'addressLine2' end,
      case when v_city is null then 'city' end,
      case when v_state is null or v_state !~ '^(0[1-9]|[12][0-9]|3[0-8]|97)$' then 'stateCode' end,
      case when v_postal is null or v_postal !~ '^[1-9][0-9]{5}$' then 'postalCode' end,
      case when v_gstin is not null and (v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$'
                                        or left(v_gstin, 2) is distinct from v_state) then 'gstin' end], null)
    || array(select jsonb_array_elements_text(v_x -> 'bad'));
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023',
      hint = array_to_string(array(select distinct b from unnest(v_bad) b order by b), ',');
  end if;

  if coalesce(v_old.row_version, 0) <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if v_old.status = 'verified' then
    raise exception 'billing_verified' using errcode = '55000';
  end if;

  if v_old.deal_id is null then
    insert into public.customer_billing_profiles (deal_id, legal_entity_id, billing_name, address_line1, address_line2,
      city, state_code, postal_code, gstin, status, prefill_source, updated_by,
      bill_to_type, contact_person, phone, email, gst_status, gst_reason)
    values (v_deal.id, v_deal.legal_entity_id, v_name, v_line1, v_line2, v_city, v_state, v_postal, v_gstin, 'draft',
      'sales', (select auth.uid()),
      v_x ->> 'type', v_x ->> 'contactPerson', v_x ->> 'phone', v_x ->> 'email', v_x ->> 'gstStatus', v_x ->> 'gstReason')
    returning row_version into v_row;
    v_changed := array['billingName', 'addressLine1', 'addressLine2', 'city', 'stateCode', 'postalCode', 'gstin',
      'billToType', 'contactPerson', 'phone', 'email', 'gstStatus', 'gstReason'];
  else
    v_changed := array_remove(array[
      case when v_old.billing_name is distinct from v_name then 'billingName' end,
      case when v_old.address_line1 is distinct from v_line1 then 'addressLine1' end,
      case when v_old.address_line2 is distinct from v_line2 then 'addressLine2' end,
      case when v_old.city is distinct from v_city then 'city' end,
      case when v_old.state_code is distinct from v_state then 'stateCode' end,
      case when v_old.postal_code is distinct from v_postal then 'postalCode' end,
      case when v_old.gstin is distinct from v_gstin then 'gstin' end,
      case when v_old.bill_to_type is distinct from v_x ->> 'type' then 'billToType' end,
      case when v_old.contact_person is distinct from v_x ->> 'contactPerson' then 'contactPerson' end,
      case when v_old.phone is distinct from v_x ->> 'phone' then 'phone' end,
      case when v_old.email is distinct from v_x ->> 'email' then 'email' end,
      case when v_old.gst_status is distinct from v_x ->> 'gstStatus' then 'gstStatus' end,
      case when v_old.gst_reason is distinct from v_x ->> 'gstReason' then 'gstReason' end], null);
    update public.customer_billing_profiles b
    set billing_name = v_name, address_line1 = v_line1, address_line2 = v_line2, city = v_city,
        state_code = v_state, postal_code = v_postal, gstin = v_gstin, prefill_source = 'sales',
        bill_to_type = v_x ->> 'type', contact_person = v_x ->> 'contactPerson', phone = v_x ->> 'phone',
        email = v_x ->> 'email', gst_status = v_x ->> 'gstStatus', gst_reason = v_x ->> 'gstReason',
        row_version = b.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
    where b.deal_id = v_deal.id
    returning row_version into v_row;
  end if;

  v_result := jsonb_build_object('outcome', case when v_old.deal_id is null then 'created' else 'updated' end,
    'status', 'draft', 'rowVersion', v_row);
  perform authz.finance_remember(v_deal.legal_entity_id, p_request_id, 'booking_billing_propose', v_payload, v_result);
  perform authz.write_audit('booking.billing_proposed', v_deal.legal_entity_id, v_deal.branch_id, 'deal', v_deal.id, null,
    jsonb_build_object('changedFields', to_jsonb(v_changed), 'rowVersion', v_row));
  return v_result;
end;
$$;

-- Replaces 20261101000100: Bill To extras (booking form). Accounts may edit a
-- verified profile; the edit resets it to draft (verification is a separate
-- step, accounts_billing_verify, unchanged).
create or replace function public.accounts_billing_save(
  p_deal_id uuid, p_expected_row_version integer, p_fields jsonb, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_old public.customer_billing_profiles%rowtype;
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id, 'expectedRowVersion', p_expected_row_version, 'fields', p_fields);
  v_result jsonb;
  v_name text;
  v_line1 text;
  v_line2 text;
  v_city text;
  v_state text;
  v_postal text;
  v_gstin text;
  v_changed text[] := '{}';
  v_row integer;
  v_review public.accounts_booking_reviews%rowtype;
  v_x jsonb;  -- booking form
begin
  select * into v_deal from public.deals d where d.id = p_deal_id;
  perform authz.finance_require_accounts(v_deal.legal_entity_id, v_deal.is_synthetic);
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  perform authz.finance_lock_deal(v_deal.id);
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'accounts_billing_save', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['billingName', 'addressLine1', 'addressLine2', 'city', 'stateCode', 'postalCode', 'gstin',
                          'billToType', 'contactPerson', 'phone', 'email', 'gstStatus', 'gstReason']) <> '{}'::jsonb
     or p_expected_row_version is null or p_expected_row_version < 0 then
    perform authz.finance_invalid();
  end if;
  v_name := authz.finance_text(authz.finance_field(p_fields, 'billingName'), 1, 200, false);
  v_line1 := authz.finance_text(authz.finance_field(p_fields, 'addressLine1'), 1, 200, false);
  v_line2 := authz.finance_text(authz.finance_field(p_fields, 'addressLine2'), 1, 200, false);
  v_city := authz.finance_text(authz.finance_field(p_fields, 'city'), 1, 120, false);
  v_state := authz.finance_text(authz.finance_field(p_fields, 'stateCode'), 1, 2, false);
  v_postal := authz.finance_text(authz.finance_field(p_fields, 'postalCode'), 1, 6, false);
  v_gstin := upper(authz.finance_text(authz.finance_field(p_fields, 'gstin'), 1, 15, false));
  if v_name is null or v_line1 is null or v_city is null or v_state is null or v_postal is null
     or v_state !~ '^(0[1-9]|[12][0-9]|3[0-8]|97)$' or v_postal !~ '^[1-9][0-9]{5}$'
     or (v_gstin is not null and (v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' or left(v_gstin, 2) <> v_state)) then
    perform authz.finance_invalid();
  end if;

  select * into v_old from public.customer_billing_profiles b where b.deal_id = v_deal.id for update;
  if coalesce(v_old.row_version, 0) <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  -- Booking form: Bill To extras (absent = unchanged).
  v_x := authz.bf_bill_to(p_fields, v_old, v_gstin);
  if jsonb_array_length(v_x -> 'bad') > 0 then
    raise exception 'invalid_input' using errcode = '22023',
      hint = array_to_string(array(select jsonb_array_elements_text(v_x -> 'bad')), ',');
  end if;

  if v_old.deal_id is null then
    insert into public.customer_billing_profiles (deal_id, legal_entity_id, billing_name, address_line1, address_line2,
      city, state_code, postal_code, gstin, status, updated_by,
      bill_to_type, contact_person, phone, email, gst_status, gst_reason)
    values (v_deal.id, v_deal.legal_entity_id, v_name, v_line1, v_line2, v_city, v_state, v_postal, v_gstin, 'draft',
      (select auth.uid()),
      v_x ->> 'type', v_x ->> 'contactPerson', v_x ->> 'phone', v_x ->> 'email', v_x ->> 'gstStatus', v_x ->> 'gstReason')
    returning row_version into v_row;
    -- Review A L6: the Bill To names too.
    v_changed := array['billingName', 'addressLine1', 'addressLine2', 'city', 'stateCode', 'postalCode', 'gstin',
      'billToType', 'contactPerson', 'phone', 'email', 'gstStatus', 'gstReason'];
  else
    v_changed := array_remove(array[
      case when v_old.billing_name is distinct from v_name then 'billingName' end,
      case when v_old.address_line1 is distinct from v_line1 then 'addressLine1' end,
      case when v_old.address_line2 is distinct from v_line2 then 'addressLine2' end,
      case when v_old.city is distinct from v_city then 'city' end,
      case when v_old.state_code is distinct from v_state then 'stateCode' end,
      case when v_old.postal_code is distinct from v_postal then 'postalCode' end,
      case when v_old.gstin is distinct from v_gstin then 'gstin' end,
      case when v_old.bill_to_type is distinct from v_x ->> 'type' then 'billToType' end,
      case when v_old.contact_person is distinct from v_x ->> 'contactPerson' then 'contactPerson' end,
      case when v_old.phone is distinct from v_x ->> 'phone' then 'phone' end,
      case when v_old.email is distinct from v_x ->> 'email' then 'email' end,
      case when v_old.gst_status is distinct from v_x ->> 'gstStatus' then 'gstStatus' end,
      case when v_old.gst_reason is distinct from v_x ->> 'gstReason' then 'gstReason' end], null);
    update public.customer_billing_profiles b
    set billing_name = v_name, address_line1 = v_line1, address_line2 = v_line2, city = v_city,
        state_code = v_state, postal_code = v_postal, gstin = v_gstin, status = 'draft',
        bill_to_type = v_x ->> 'type', contact_person = v_x ->> 'contactPerson', phone = v_x ->> 'phone',
        email = v_x ->> 'email', gst_status = v_x ->> 'gstStatus', gst_reason = v_x ->> 'gstReason',
        verified_by = null, verified_at = null, row_version = b.row_version + 1,
        updated_by = (select auth.uid()), updated_at = now()
    where b.deal_id = v_deal.id
    returning row_version into v_row;
  end if;

  -- An approved review of the deal's confirmed booking returns to pending.
  select rv.* into v_review
  from public.accounts_booking_reviews rv
  join public.booking_versions v on v.id = rv.booking_version_id
  where v.deal_id = v_deal.id and v.status = 'confirmed'
  for update of rv;
  if v_review.status = 'approved' then
    update public.accounts_booking_reviews rv
    set status = 'pending', row_version = rv.row_version + 1, updated_at = now()
    where rv.id = v_review.id;
    perform authz.write_audit('finance.review_reset', v_deal.legal_entity_id, v_deal.branch_id, 'booking_version',
      v_review.booking_version_id, null, jsonb_build_object('cause', 'billing_saved'));
  end if;

  v_result := jsonb_build_object('outcome', case when v_old.deal_id is null then 'created' else 'updated' end,
    'id', v_deal.id, 'status', 'draft', 'rowVersion', v_row);
  perform authz.finance_remember(v_deal.legal_entity_id, p_request_id, 'accounts_billing_save', v_payload, v_result);
  perform authz.write_audit('finance.billing_saved', v_deal.legal_entity_id, v_deal.branch_id, 'deal', v_deal.id, null,
    jsonb_build_object('changedFields', to_jsonb(v_changed), 'rowVersion', v_row));
  return v_result;
end;
$$;

-- ===========================================================================
-- 6. Per-person prices
-- ===========================================================================

-- Per-person prices are in use on a version: at least one line has amounts.
create function authz.prices_in_use(p_version uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.booking_version_price_lines l
                 where l.booking_version_id = p_version and l.sale_paise is not null)
$$;

-- Σ quantity × sale when every line with people is priced, else null.
create function authz.prices_total(p_version uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select case when count(*) filter (where l.quantity > 0) > 0
                   and bool_and(l.sale_paise is not null) filter (where l.quantity > 0)
              then sum(l.quantity::bigint * l.sale_paise) filter (where l.quantity > 0) end
  from public.booking_version_price_lines l
  where l.booking_version_id = p_version
$$;

-- Per-person prices are required before submit: drafts started in the
-- booking form (not converted from a quotation); a revision when its base
-- used them.
create function authz.bf_lines_required(p_version uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case when v.revises_version_id is not null then authz.prices_in_use(v.revises_version_id)
                else v.form_rules = 2 and v.source_quotation_version_id is null end
    from public.booking_versions v where v.id = p_version), false)
$$;

-- Paise amount of a price input: a JSON string of digits (or a negative one
-- when p_signed), within the bound; null when absent or JSON null. Returns
-- -1 as "invalid" marker through p_ok = false.
create function authz.bf_paise(p_value jsonb, p_signed boolean) returns table (ok boolean, amount bigint)
language sql immutable set search_path = '' as $$
  select case
           when p_value is null or jsonb_typeof(p_value) = 'null' then true
           when jsonb_typeof(p_value) <> 'string' then false
           when (p_value #>> '{}') ~ (case when p_signed then '^-?[0-9]{1,12}$' else '^[0-9]{1,11}$' end)
             then abs((p_value #>> '{}')::bigint) <= 99999999999
           else false end,
         case when p_value is not null and jsonb_typeof(p_value) = 'string'
                   and (p_value #>> '{}') ~ (case when p_signed then '^-?[0-9]{1,12}$' else '^[0-9]{1,11}$' end)
              then (p_value #>> '{}')::bigint end
$$;

-- Replaces the four category lines of a draft. p_lines: exactly the four
-- categories once each: {category, quantity 0..100, purchasePaise, markupPaise,
-- salePaise} (paise as digit strings, markup may be negative, all null =
-- not priced yet). Quantities follow the party: adult = total - children -
-- infants, infant = infants, child with bed + child without bed <= children
-- (fewer is a readiness mismatch, more or a hidden category is refused).
-- purchase + markup must equal sale. The server stores purchase and sale,
-- derives markup and writes the selling total (Σ quantity × sale) in the same
-- transaction when every line with people is priced and the total is > 0;
-- list price and discount are cleared. Commercial readers who may edit.
create function public.booking_prices_save(p_version_id uuid, p_expected_row_version integer, p_lines jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_payload jsonb := jsonb_build_object('versionId', p_version_id, 'expectedRowVersion', p_expected_row_version,
    'lines', p_lines);
  v_result jsonb;
  v_line jsonb;
  v_cat text;
  v_qty integer;
  v_p record;
  v_m record;
  v_s record;
  v_bad text[] := '{}'::text[];
  v_seen text[] := '{}'::text[];
  v_children integer;
  v_infants integer;
  v_child_qty integer := 0;
  v_rows jsonb := '[]'::jsonb;
  v_total bigint;
  v_in_use boolean;
  v_complete boolean;
  v_priced integer := 0;
begin
  v_ver := authz.lock_package_draft(p_version_id);
  if not authz.can_read_deal_commercial(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_ver.legal_entity_id, p_request_id, 'booking_prices_save', v_payload);
  if v_result is not null then
    -- Review A L8: the stored result has no amount; the caller passed the
    -- commercial check above, so the total is read again here.
    v_total := authz.prices_total(v_ver.id);
    return v_result || jsonb_build_object('sellingTotalPaise',
      case when authz.prices_in_use(v_ver.id) and v_total > 0 then v_total::text end);
  end if;
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) <> 4 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'lines';
  end if;
  v_children := coalesce(v_ver.children_count, 0);
  v_infants := coalesce(v_ver.infants_count, 0);

  for v_line in select e from jsonb_array_elements(p_lines) e loop
    if jsonb_typeof(v_line) <> 'object'
       or cardinality(authz.b11_unknown_keys(v_line, array['category', 'quantity', 'purchasePaise', 'markupPaise', 'salePaise'])) > 0
       or jsonb_typeof(v_line -> 'category') is distinct from 'string'
       or (v_line ->> 'category') not in ('adult', 'child_bed', 'child_no_bed', 'infant')
       or (v_line ->> 'category') = any (v_seen) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'lines';
    end if;
    v_cat := v_line ->> 'category';
    v_seen := v_seen || v_cat;
    if not authz.sf_int_ok(v_line -> 'quantity', 0, 100, true) then
      v_bad := v_bad || ('lines[' || v_cat || '].quantity');
      continue;
    end if;
    v_qty := (v_line #>> '{quantity}')::integer;
    -- Quantities follow the party (a hidden or stale category is refused).
    if (v_qty > 0 and v_ver.pax_total is null)
       or (v_cat = 'adult' and v_ver.pax_total is not null and v_qty <> v_ver.pax_total - v_children - v_infants)
       or (v_cat = 'infant' and v_qty <> v_infants) then
      v_bad := v_bad || ('lines[' || v_cat || '].quantity');
    end if;
    if v_cat in ('child_bed', 'child_no_bed') then
      v_child_qty := v_child_qty + v_qty;
    end if;
    select * into v_p from authz.bf_paise(v_line -> 'purchasePaise', false);
    select * into v_m from authz.bf_paise(v_line -> 'markupPaise', true);
    select * into v_s from authz.bf_paise(v_line -> 'salePaise', false);
    if not v_p.ok then v_bad := v_bad || ('lines[' || v_cat || '].purchasePaise'); end if;
    if not v_m.ok then v_bad := v_bad || ('lines[' || v_cat || '].markupPaise'); end if;
    if not v_s.ok then v_bad := v_bad || ('lines[' || v_cat || '].salePaise'); end if;
    if v_p.ok and v_m.ok and v_s.ok then
      if v_qty = 0 and (v_p.amount is not null or v_m.amount is not null or v_s.amount is not null) then
        -- No amounts for a category without people.
        v_bad := v_bad || ('lines[' || v_cat || '].quantity');
      elsif (v_p.amount is null) <> (v_s.amount is null) or (v_m.amount is null) <> (v_s.amount is null) then
        -- Either all three amounts or none.
        v_bad := v_bad || ('lines[' || v_cat || '].' ||
          case when v_p.amount is null then 'purchasePaise' when v_m.amount is null then 'markupPaise' else 'salePaise' end);
      elsif v_s.amount is not null and v_p.amount + v_m.amount <> v_s.amount then
        v_bad := v_bad || ('lines[' || v_cat || '].salePaise');
      end if;
    end if;
    v_rows := v_rows || jsonb_build_object('category', v_cat, 'quantity', v_qty,
      'purchase', v_p.amount, 'sale', v_s.amount);
  end loop;
  if v_child_qty > v_children then
    v_bad := v_bad || 'lines[child_bed].quantity'::text;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023',
      hint = array_to_string(array(select distinct b from unnest(v_bad) b order by b), ',');
  end if;

  insert into public.booking_version_price_lines as l (booking_version_id, legal_entity_id, deal_id, category, quantity,
    purchase_paise, sale_paise, updated_by)
  select v_ver.id, v_ver.legal_entity_id, v_ver.deal_id, r ->> 'category', (r ->> 'quantity')::smallint,
    (r ->> 'purchase')::bigint, (r ->> 'sale')::bigint, (select auth.uid())
  from jsonb_array_elements(v_rows) r
  on conflict (booking_version_id, category) do update
    set quantity = excluded.quantity, purchase_paise = excluded.purchase_paise, sale_paise = excluded.sale_paise,
        updated_by = excluded.updated_by
    where (l.quantity, l.purchase_paise, l.sale_paise)
          is distinct from (excluded.quantity, excluded.purchase_paise, excluded.sale_paise);

  v_in_use := authz.prices_in_use(v_ver.id);
  v_total := authz.prices_total(v_ver.id);
  v_complete := v_total is not null;
  select count(*) into v_priced from public.booking_version_price_lines l
  where l.booking_version_id = v_ver.id and l.quantity > 0 and l.sale_paise is not null;
  if v_in_use and v_complete and v_total > 0 then
    insert into public.booking_version_commercials as c (version_id, legal_entity_id, selling_total_paise,
      list_price_paise, discount_paise)
    values (v_ver.id, v_ver.legal_entity_id, v_total, null, null)
    on conflict (version_id) do update
      set selling_total_paise = excluded.selling_total_paise, list_price_paise = null, discount_paise = null,
          updated_at = now()
      where (c.selling_total_paise, c.list_price_paise, c.discount_paise) is distinct from (excluded.selling_total_paise, null, null);
  elsif v_in_use and authz.bf_lines_required(v_ver.id) then
    -- Worked out as zero, or not worked out yet, where per-person prices are
    -- required (new-form drafts): no selling total.
    delete from public.booking_version_commercials c where c.version_id = v_ver.id;
  end if;
  -- Otherwise (prices not in use, or zero or incomplete on a converted or
  -- older draft) the existing total stays as it is (review A M4: never the
  -- accepted total).

  v_ver := authz.bump_package_version(v_ver.id);
  -- Counts only: never an amount.
  perform authz.write_audit('booking.prices_saved', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'pricedCategories', v_priced,
      'complete', v_complete and v_total > 0, 'rowVersion', v_ver.row_version));
  v_result := jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
  -- Review A L8: no amount in finance_command_results.
  perform authz.finance_remember(v_ver.legal_entity_id, p_request_id, 'booking_prices_save', v_payload, v_result);
  return v_result || jsonb_build_object('sellingTotalPaise',
    case when v_in_use and v_complete and v_total > 0 then v_total::text end);
end;
$$;

-- Replaces 20261119000100: refused while per-person prices are in use (the
-- total follows from them).
create or replace function public.booking_commercials_save(p_version_id uuid, p_expected_row_version integer,
  p_list_paise bigint, p_discount_paise bigint, p_total_paise bigint)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
begin
  v_ver := authz.lock_package_draft(p_version_id);
  if not authz.can_read_deal_commercial(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  -- Booking form.
  if authz.prices_in_use(v_ver.id) then
    raise exception 'priced_per_person' using errcode = '55000';
  end if;
  if p_total_paise is null or p_total_paise <= 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'totalPaise';
  end if;
  if p_discount_paise is not null and (p_discount_paise < 0 or p_list_paise is null) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'discountPaise';
  end if;
  if p_list_paise is not null and (p_list_paise < 0 or p_list_paise - coalesce(p_discount_paise, 0) <> p_total_paise) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'listPaise';
  end if;
  insert into public.booking_version_commercials (version_id, legal_entity_id, selling_total_paise, list_price_paise, discount_paise)
  values (v_ver.id, v_ver.legal_entity_id, p_total_paise, p_list_paise, p_discount_paise)
  on conflict (version_id) do update
    set selling_total_paise = excluded.selling_total_paise, list_price_paise = excluded.list_price_paise,
        discount_paise = excluded.discount_paise, updated_at = now();
  v_ver := authz.bump_package_version(v_ver.id);
  -- No amounts in the audit record.
  perform authz.write_audit('booking.commercials_saved', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id,
    null, jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;

-- Replaces 20261119000300: the legacy selling path refuses priced_per_person while
-- per-person prices are in use (same rule as booking_commercials_save).
create or replace function public.booking_save_draft(
  p_version_id uuid, p_expected_row_version integer, p_facts jsonb, p_selling_total_paise bigint,
  p_selling_total_provided boolean
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_keys constant text[] := array['hotelName', 'city', 'checkIn', 'checkOut', 'rooms', 'roomType', 'mealPlan',
    'adults', 'children', 'inclusions', 'specialRequests', 'purchaseBudgetPaise'];
  v_hotel text; v_city text; v_in date; v_out date; v_rooms integer; v_room_type text; v_meal text;
  v_adults integer; v_children integer; v_incl text; v_req text; v_budget bigint;
begin
  select * into v_ver from public.booking_versions v where v.id = p_version_id for update;
  -- Stage 0: a Deal removed by the Bitrix sync takes no new booking work.
  perform authz.refuse_removed_deal(v_ver.deal_id);
  if v_ver.id is null or not authz.can_edit_booking_draft(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ver.status <> 'draft' then  -- B1.1 revision: superseded and discarded too
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  if p_expected_row_version is null or p_expected_row_version <> v_ver.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if p_facts is null or jsonb_typeof(p_facts) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_facts) k where k <> all (v_keys))
     or exists (select 1 from unnest(v_keys) k where not (p_facts ? k)) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_selling_total_provided is null
     or (p_selling_total_provided and p_selling_total_paise is not null and p_selling_total_paise < 0) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- A4 M3: only a caller who may read the commercial value may send it.
  if p_selling_total_provided and not authz.can_read_deal_commercial(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Booking form: the total follows from per-person prices while they are in use.
  if p_selling_total_provided and authz.prices_in_use(v_ver.id) then
    raise exception 'priced_per_person' using errcode = '55000';
  end if;

  v_hotel := authz.booking_fact_text(p_facts, 'hotelName', 200, false);
  v_city := authz.booking_fact_text(p_facts, 'city', 120, false);
  v_in := authz.booking_fact_date(p_facts, 'checkIn');
  v_out := authz.booking_fact_date(p_facts, 'checkOut');
  v_rooms := authz.booking_fact_int(p_facts, 'rooms', 1, 50);
  v_room_type := authz.booking_fact_text(p_facts, 'roomType', 120, false);
  v_meal := authz.booking_fact_text(p_facts, 'mealPlan', 60, false);
  v_adults := authz.booking_fact_int(p_facts, 'adults', 1, 100);
  v_children := authz.booking_fact_int(p_facts, 'children', 0, 100);
  v_incl := authz.booking_fact_text(p_facts, 'inclusions', 2000, true);
  v_req := authz.booking_fact_text(p_facts, 'specialRequests', 2000, true);
  v_budget := authz.booking_fact_paise(p_facts, 'purchaseBudgetPaise');

  -- A4 M3 (supersedes A1): not provided -> the commercial row is untouched;
  -- provided -> null clears, a value sets (authorization checked above).
  if p_selling_total_provided then
    if p_selling_total_paise is null then
      delete from public.booking_version_commercials c where c.version_id = v_ver.id;
    else
      insert into public.booking_version_commercials (version_id, legal_entity_id, selling_total_paise)
      values (v_ver.id, v_ver.legal_entity_id, p_selling_total_paise)
      on conflict (version_id) do update
        set selling_total_paise = excluded.selling_total_paise, updated_at = now();
    end if;
  end if;

  update public.booking_versions v
  set hotel_name = v_hotel, city = v_city, check_in = v_in, check_out = v_out, rooms = v_rooms,
      room_type = v_room_type, meal_plan = v_meal, adults = v_adults, children = v_children,
      inclusions = v_incl, special_requests = v_req, purchase_budget_paise = v_budget,
      row_version = v.row_version + 1, updated_at = now()
  where v.id = v_ver.id
  returning * into v_ver;

  -- No amounts or customer content in the audit record.
  perform authz.write_audit('booking.draft_saved', v_ver.legal_entity_id, v_ver.branch_id,
    'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('versionId', v_ver.id, 'rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;

-- ===========================================================================
-- 7. Service save with supplier estimate and participation
-- ===========================================================================

-- Writes (or clears) the supplier estimate of one item in a draft. p_estimate:
--   hotel    {roomRatePaise, extraBedRatePaise, noBedRatePaise}
--   transfer {vehicleRatePaise}
--   flight   {fareTotalPaise}
-- (optional "kind" equal to the service type; digit strings or null; all null
-- removes the row). Other service types take no estimate. Returns true when
-- the stored row changed.
create function authz.bf_estimate_write(p_ver public.booking_versions, p_item public.service_items, p_estimate jsonb)
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
begin
  v_keys := case p_item.service_type
    when 'hotel' then array['roomRatePaise', 'extraBedRatePaise', 'noBedRatePaise']
    when 'transfer' then array['vehicleRatePaise']
    when 'flight' then array['fareTotalPaise'] end;
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
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  v_room := (v_vals ->> 'roomRatePaise')::bigint;
  v_extra := (v_vals ->> 'extraBedRatePaise')::bigint;
  v_nobed := (v_vals ->> 'noBedRatePaise')::bigint;
  v_vehicle := (v_vals ->> 'vehicleRatePaise')::bigint;
  v_fare := (v_vals ->> 'fareTotalPaise')::bigint;
  select * into v_old from public.service_item_cost_estimates e
  where e.booking_version_id = p_ver.id and e.service_item_id = p_item.id for update;
  if coalesce(v_room, v_extra, v_nobed, v_vehicle, v_fare) is null then
    if v_old.service_item_id is null then
      return false;
    end if;
    delete from public.service_item_cost_estimates e where e.booking_version_id = p_ver.id and e.service_item_id = p_item.id;
    return true;
  end if;
  if v_old.service_item_id is not null
     and (v_old.room_rate_paise, v_old.extra_bed_rate_paise, v_old.no_bed_rate_paise, v_old.vehicle_rate_paise, v_old.fare_total_paise)
         is not distinct from (v_room, v_extra, v_nobed, v_vehicle, v_fare) then
    return false;
  end if;
  insert into public.service_item_cost_estimates as e (booking_version_id, service_item_id, legal_entity_id,
    room_rate_paise, extra_bed_rate_paise, no_bed_rate_paise, vehicle_rate_paise, fare_total_paise, updated_by)
  values (p_ver.id, p_item.id, p_ver.legal_entity_id, v_room, v_extra, v_nobed, v_vehicle, v_fare, (select auth.uid()))
  on conflict (booking_version_id, service_item_id) do update
    set room_rate_paise = excluded.room_rate_paise, extra_bed_rate_paise = excluded.extra_bed_rate_paise,
        no_bed_rate_paise = excluded.no_bed_rate_paise, vehicle_rate_paise = excluded.vehicle_rate_paise,
        fare_total_paise = excluded.fare_total_paise, updated_by = excluded.updated_by;
  return true;
end;
$$;

-- One transaction for a service editor save (no partial save): add (p_item_id
-- null) or save the item facts and purchase budget (null budget: 0 on add,
-- unchanged on save), then the supplier estimate (null: unchanged; commercial
-- readers only) and participation (null: unchanged). An exact retry (same
-- request id, actor and payload) returns the stored result.
create function public.booking_service_save(p_version_id uuid, p_expected_row_version integer, p_item_id uuid,
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

  if p_item_id is null then
    v_res := public.service_item_add(v_ver.id, v_rv, p_service_type, p_facts, coalesce(p_purchase_budget_paise, 0),
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
    v_res := public.service_item_save(v_item.id, v_ver.id, v_rv, p_facts, v_budget);
  end if;
  v_rv := (v_res ->> 'rowVersion')::integer;

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
-- 8. Item files (flight screenshot)
-- ===========================================================================

-- Why the caller may view the files of a service item (null = not allowed):
-- booking editors and acceptors, and the Flight assignee of that item's task
-- (active Flight role). Never Purchase, Accounts or Super Admin by role.
create function authz.service_item_file_viewer(p_item uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when p_item is null or not coalesce(authz.session_ok(), false) or d.removed_at is not null then null
    when authz.can_edit_booking_draft(d.id) or authz.can_confirm_booking(d.id) then
      case when d.owner_user_id = (select auth.uid()) then 'sales_owner'
           when authz.is_branch_sales_manager(d.id) then 'manager'
           else 'sales_assignee' end
    when exists (select 1 from public.fulfilment_tasks t
                 where t.service_item_id = i.id and t.department = 'flight'
                   and t.assignee_user_id = (select auth.uid())
                   and authz.holds_active_role('flight', t.legal_entity_id)) then 'flight_assignee'
    end
  from public.service_items i join public.deals d on d.id = i.deal_id
  where i.id = p_item
$$;

-- Live files (pending_upload, stored) of one item, for the form and the Flight task.
create function authz.service_item_files_json(p_item uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'fileId', f.id, 'kind', f.kind, 'fileName', f.file_name, 'mime', f.mime, 'sizeBytes', f.size_bytes,
      'status', f.status, 'rowVersion', f.row_version,
      'uploadedByYou', f.uploaded_by = (select auth.uid()),
      'createdAt', f.created_at, 'storedAt', f.stored_at) order by f.created_at, f.id), '[]'::jsonb)
  from public.service_item_files f
  where f.service_item_id = p_item and f.status in ('pending_upload', 'stored')
$$;

-- Starts one upload. p_file: {fileName, mime, sizeBytes, sha256}. Booking
-- editors on an active Deal with the switch on; the item must be a flight of
-- that Deal with facts in p_version_id. An exact retry returns the row as it is
-- now (object path only while it waits for its upload).
create function public.service_item_file_begin(p_item_id uuid, p_version_id uuid, p_kind text, p_file jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_item public.service_items%rowtype;
  v_deal public.deals%rowtype;
  v_existing public.service_item_files%rowtype;
  v_name text;
  v_mime text;
  v_size integer;
  v_sha text;
  v_id uuid := gen_random_uuid();
  v_path text;
begin
  select * into v_item from public.service_items i where i.id = p_item_id;
  perform authz.refuse_removed_deal(v_item.deal_id);
  select * into v_deal from public.deals d where d.id = v_item.deal_id for no key update;
  if v_deal.id is null or not authz.can_edit_booking_draft(v_deal.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not authz.service_items_enabled() then
    raise exception 'service_items_disabled' using errcode = '55000';
  end if;
  if authz.deal_not_active(v_deal.id) then
    raise exception 'deal_not_active' using errcode = '55000';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if p_kind is distinct from 'flight_screenshot' or v_item.service_type <> 'flight' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  if not exists (select 1 from public.service_item_facts f join public.booking_versions v on v.id = f.booking_version_id
                 where f.service_item_id = v_item.id and f.booking_version_id = p_version_id and v.deal_id = v_deal.id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if p_file is null or jsonb_typeof(p_file) <> 'object'
     or cardinality(authz.b11_unknown_keys(p_file, array['fileName', 'mime', 'sizeBytes', 'sha256'])) > 0
     or jsonb_typeof(p_file -> 'fileName') is distinct from 'string'
     or jsonb_typeof(p_file -> 'mime') is distinct from 'string'
     or not authz.sf_int_ok(p_file -> 'sizeBytes', 1, 2147483647, true)
     or jsonb_typeof(p_file -> 'sha256') is distinct from 'string' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  v_name := btrim(left(btrim(regexp_replace(p_file ->> 'fileName', '[^A-Za-z0-9._ -]', '_', 'g')), 120));
  v_mime := p_file ->> 'mime';
  v_size := (p_file #>> '{sizeBytes}')::integer;
  v_sha := lower(btrim(p_file ->> 'sha256'));

  select * into v_existing from public.service_item_files f where f.deal_id = v_deal.id and f.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.uploaded_by is distinct from (select auth.uid()) or v_existing.service_item_id is distinct from v_item.id
       or v_existing.booking_version_id is distinct from p_version_id
       or v_existing.file_name is distinct from v_name or v_existing.mime is distinct from v_mime
       or v_existing.size_bytes is distinct from v_size or v_existing.sha256 is distinct from v_sha then
      raise exception 'request_conflict' using errcode = '40001';
    end if;
    return jsonb_build_object('fileId', v_existing.id, 'outcome', 'existing', 'status', v_existing.status,
      'rowVersion', v_existing.row_version,
      'objectPath', case when v_existing.status = 'pending_upload' then v_existing.object_path end);
  end if;

  if v_name = '' or v_name ~ '^[. ]+$'
     or v_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or v_size > authz.id_proof_max_bytes() or v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  if (select count(*) from public.service_item_files f
      where f.service_item_id = v_item.id and f.status in ('pending_upload', 'stored')) >= 5 then
    raise exception 'item_file_limit' using errcode = '55000';
  end if;

  v_path := v_deal.legal_entity_id::text || '/' || v_deal.id::text || '/' || v_item.id::text || '/' || v_id::text;
  insert into public.service_item_files (id, deal_id, legal_entity_id, service_item_id, booking_version_id, kind,
    request_id, object_path, file_name, mime, size_bytes, sha256, uploaded_by)
  values (v_id, v_deal.id, v_deal.legal_entity_id, v_item.id, p_version_id, p_kind, p_request_id, v_path, v_name,
    v_mime, v_size, v_sha, (select auth.uid()));
  -- No file name in the audit record.
  perform authz.write_audit('booking.item_file_started', v_deal.legal_entity_id, v_deal.branch_id, 'service_item_file', v_id,
    null, jsonb_build_object('dealId', v_deal.id, 'itemNo', v_item.item_no, 'fileId', v_id, 'kind', p_kind,
      'mime', v_mime, 'sizeBytes', v_size));
  return jsonb_build_object('fileId', v_id, 'outcome', 'created', 'status', 'pending_upload', 'rowVersion', 1,
    'objectPath', v_path);
end;
$$;

-- Records the upload outcome ('stored' only when Storage holds the object at
-- the server path with the declared size). Only the uploader, while a booking
-- editor. Repeats report the recorded outcome.
create function public.service_item_file_finish(p_file_id uuid, p_ok boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal uuid := (select f.deal_id from public.service_item_files f where f.id = p_file_id);
  v_file public.service_item_files%rowtype;
  v_status text;
  v_missing boolean := false;
begin
  perform authz.refuse_removed_deal(v_deal);
  perform 1 from public.deals d where d.id = v_deal for no key update;
  select * into v_file from public.service_item_files f where f.id = p_file_id for update;
  if v_file.id is null or v_file.uploaded_by is distinct from (select auth.uid())
     or not authz.can_edit_booking_draft(v_file.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_ok is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_status := case when p_ok then 'stored' else 'failed' end;
  if v_file.status <> 'pending_upload' then
    if v_file.status = v_status or (p_ok and v_file.status = 'failed') then
      return jsonb_build_object('fileId', v_file.id, 'status', v_file.status, 'rowVersion', v_file.row_version);
    end if;
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_ok and (to_regclass('storage.objects') is null or not exists (
       select 1 from storage.objects o
       where o.bucket_id = 'service-item-files' and o.name = v_file.object_path
         and (o.metadata ->> 'size') ~ '^[0-9]{1,18}$'
         and (o.metadata ->> 'size')::bigint = v_file.size_bytes)) then
    v_status := 'failed';
    v_missing := true;
  end if;
  update public.service_item_files f
  set status = v_status, stored_at = case when v_status = 'stored' then now() else null end
  where f.id = v_file.id
  returning * into v_file;
  perform authz.write_audit(
    case when v_status = 'stored' then 'booking.item_file_stored' else 'booking.item_file_failed' end,
    v_file.legal_entity_id, (select d.branch_id from public.deals d where d.id = v_file.deal_id),
    'service_item_file', v_file.id, null,
    jsonb_build_object('dealId', v_file.deal_id, 'fileId', v_file.id, 'objectMissing', v_missing));
  return jsonb_build_object('fileId', v_file.id, 'status', v_status, 'rowVersion', v_file.row_version);
end;
$$;

-- Soft removal (the storage object is kept). Any booking editor; the file row
-- version guards a stale screen.
create function public.service_item_file_remove(p_file_id uuid, p_expected_row_version integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal uuid := (select f.deal_id from public.service_item_files f where f.id = p_file_id);
  v_file public.service_item_files%rowtype;
  v_previous text;
begin
  perform authz.refuse_removed_deal(v_deal);
  perform 1 from public.deals d where d.id = v_deal for no key update;
  select * into v_file from public.service_item_files f where f.id = p_file_id for update;
  if v_file.id is null or not authz.can_edit_booking_draft(v_file.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Review A L7: the same switch and lost-Deal checks as begin.
  if not authz.service_items_enabled() then
    raise exception 'service_items_disabled' using errcode = '55000';
  end if;
  if authz.deal_not_active(v_file.deal_id) then
    raise exception 'deal_not_active' using errcode = '55000';
  end if;
  if v_file.status = 'removed' then
    return jsonb_build_object('fileId', v_file.id, 'status', 'removed', 'rowVersion', v_file.row_version);
  end if;
  perform authz.require_row_version(p_expected_row_version, v_file.row_version);
  v_previous := v_file.status;
  update public.service_item_files f
  set status = 'removed', removed_at = now(), removed_by = (select auth.uid())
  where f.id = v_file.id
  returning * into v_file;
  perform authz.write_audit('booking.item_file_removed', v_file.legal_entity_id,
    (select d.branch_id from public.deals d where d.id = v_file.deal_id), 'service_item_file', v_file.id, null,
    jsonb_build_object('dealId', v_file.deal_id, 'fileId', v_file.id, 'previousStatus', v_previous));
  return jsonb_build_object('fileId', v_file.id, 'status', 'removed', 'rowVersion', v_file.row_version);
end;
$$;

-- Authorizes one download (the server then signs a short URL). Every view is
-- audited with the viewer's role.
create function public.service_item_file_authorize_download(p_file_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_file public.service_item_files%rowtype;
  v_role text;
begin
  select * into v_file from public.service_item_files f where f.id = p_file_id;
  perform authz.refuse_removed_deal(v_file.deal_id);
  v_role := authz.service_item_file_viewer(v_file.service_item_id);
  if v_file.id is null or v_role is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_file.status <> 'stored' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.write_audit('booking.item_file_viewed', v_file.legal_entity_id,
    (select d.branch_id from public.deals d where d.id = v_file.deal_id), 'service_item_file', v_file.id, null,
    jsonb_build_object('dealId', v_file.deal_id, 'fileId', v_file.id, 'viewerRole', v_role));
  return jsonb_build_object('objectPath', v_file.object_path, 'fileName', v_file.file_name, 'mime', v_file.mime);
end;
$$;

-- ===========================================================================
-- 9. Privileges
-- ===========================================================================

revoke all on function
  authz.bf_phone(text),
  authz.bf_bill_to(jsonb, public.customer_billing_profiles, text),
  authz.b11_billing_propose(uuid, integer, jsonb, uuid),
  authz.b11_contacts_write(public.booking_versions, jsonb),
  authz.prices_in_use(uuid),
  authz.prices_total(uuid),
  authz.bf_lines_required(uuid),
  authz.bf_paise(jsonb, boolean),
  authz.bf_estimate_write(public.booking_versions, public.service_items, jsonb),
  authz.service_item_file_viewer(uuid),
  authz.service_item_files_json(uuid)
from public, anon, authenticated, service_role;

revoke all on function
  public.booking_form_start(uuid),
  public.booking_save_draft(uuid, integer, jsonb, bigint, boolean),
  public.booking_trip_save(uuid, integer, jsonb),
  public.traveller_identity_save(uuid, integer, integer, jsonb),
  public.accounts_billing_save(uuid, integer, jsonb, uuid),
  public.booking_prices_save(uuid, integer, jsonb, uuid),
  public.booking_commercials_save(uuid, integer, bigint, bigint, bigint),
  public.booking_service_save(uuid, integer, uuid, text, jsonb, bigint, jsonb, integer[], uuid),
  public.service_item_file_begin(uuid, uuid, text, jsonb, uuid),
  public.service_item_file_finish(uuid, boolean),
  public.service_item_file_remove(uuid, integer),
  public.service_item_file_authorize_download(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.booking_form_start(uuid),
  public.booking_save_draft(uuid, integer, jsonb, bigint, boolean),
  public.booking_trip_save(uuid, integer, jsonb),
  public.traveller_identity_save(uuid, integer, integer, jsonb),
  public.accounts_billing_save(uuid, integer, jsonb, uuid),
  public.booking_prices_save(uuid, integer, jsonb, uuid),
  public.booking_commercials_save(uuid, integer, bigint, bigint, bigint),
  public.booking_service_save(uuid, integer, uuid, text, jsonb, bigint, jsonb, integer[], uuid),
  public.service_item_file_begin(uuid, uuid, text, jsonb, uuid),
  public.service_item_file_finish(uuid, boolean),
  public.service_item_file_remove(uuid, integer),
  public.service_item_file_authorize_download(uuid)
to authenticated;

commit;
