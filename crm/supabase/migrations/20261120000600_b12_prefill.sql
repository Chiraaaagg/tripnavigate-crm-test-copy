-- TripNavigate CRM - B1.2: Bitrix prefill landing (DEC-36; freeze note part 2
-- section 4; Q-E1).
--
-- Uses Nova's read helper authz.bitrix_prefill_json (20261120000400), which
-- checks nothing: every command and read below authorizes the caller first
-- (booking editors for a booking draft, quotation editors for a quotation).
--
-- What changes:
--   * public.prefill_marks: which booking/quotation field took its value from
--     Bitrix, and whether staff checked it (from_bitrix -> checked) or changed
--     it afterwards (changed). No Data API read.
--   * Commands booking_prefill_apply, quotation_prefill_apply (values are
--     copied by the server from the stored snapshot, never from the browser)
--     and prefill_mark_checked.
--   * Booking Notes are display-only on Book now and copied into a quotation's
--     requirements note only on request. Customer Type is shown as its code;
--     DEC-45: any known Customer Type (B2D, Corporate, Travel Agent) fills
--     "booking for: business" on request (field contacts.bookingFor); an
--     unknown or absent type fills nothing. A contact from
--     Bitrix stays unconfirmed (contact_not_confirmed remains the blocking check).
--   * prefill_unchecked is a warning (intake_checklist), never a blocker.
--   * Reads: booking_form_get and quotation_get (copies of 20261120000200) add
--     a prefill block (available = false while the read switch is off);
--     intake_checklist (copy of 20261120000200) adds prefill_unchecked.
--
-- Refusal tokens added: 55000 prefill_unavailable. Existing tokens unchanged.
--
-- Any later migration that replaces booking_form_get, intake_checklist or
-- quotation_get must copy the bodies in THIS file.
--
-- Rollback (forward-only): a NEW migration revokes execute on the three
-- commands and restores the three reads from 20261120000200. Marks are kept.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Marks
-- ===========================================================================

create table public.prefill_marks (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  target_kind text not null check (target_kind in ('booking_version', 'quotation_version')),
  target_id uuid not null,
  field_code text not null check (field_code in ('trip.start', 'trip.end', 'requirementsNote', 'contacts.contactName',
    'contacts.mobile', 'contacts.email', 'contacts.companyName', 'contacts.bookingFor')),
  source_object text not null check (source_object in ('deal', 'lead')),
  source_modified_at timestamptz,
  state text not null check (state in ('from_bitrix', 'checked', 'changed')),
  applied_by uuid not null references public.staff_profiles (user_id),
  applied_at timestamptz not null default now(),
  checked_by uuid references public.staff_profiles (user_id),
  checked_at timestamptz,
  constraint prefill_marks_unique unique (target_kind, target_id, field_code),
  check ((checked_at is null) = (checked_by is null)),
  check (state <> 'checked' or checked_at is not null)
);
create index prefill_marks_target_idx on public.prefill_marks (target_id);
create index prefill_marks_entity_idx on public.prefill_marks (legal_entity_id);
create index prefill_marks_applied_by_idx on public.prefill_marks (applied_by);
create index prefill_marks_checked_by_idx on public.prefill_marks (checked_by) where checked_by is not null;
comment on table public.prefill_marks is
  'Which booking/quotation field was filled from Bitrix (DEC-36) and whether staff checked or changed it. No values or value hashes. No Data API read.';

alter table public.prefill_marks enable row level security;
create policy require_valid_session on public.prefill_marks as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.prefill_marks from public, anon, authenticated, service_role;

-- ===========================================================================
-- 2. Helpers
-- ===========================================================================

-- Indian mobile from a Bitrix phone: digits only, leading 91 / 0 dropped.
create function authz.prefill_mobile(p_phone text) returns text
language sql immutable set search_path = '' as $$
  select case when m ~ '^[6-9][0-9]{9}$' then m end
  from (select regexp_replace(regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g'), '^(91|0)(?=[0-9]{10}$)', '') as m) x
$$;

-- DEC-45: every known Bitrix Customer Type is a business booking; unknown or absent -> null.
create function authz.prefill_booking_for(p_fields jsonb) returns text
language sql immutable set search_path = '' as $$
  select case when (p_fields -> 'customerType' ->> 'code') in ('b2d', 'corporate', 'travel_agent') then 'business' end
$$;

-- Review E5-1: no value or value hash is stored. A marked field written by
-- anything other than the prefill apply of that same row turns 'changed'
-- (OLD/NEW comparison in the row triggers below). The apply commands set
-- tripnavigate.prefill_apply to the target id for their own writes.
create function authz.prefill_mark_changed(p_kind text, p_target uuid, p_fields text[]) returns void
language sql volatile security definer set search_path = '' as $$
  update public.prefill_marks m set state = 'changed'
  where m.target_kind = p_kind and m.target_id = p_target and m.field_code = any (p_fields) and m.state <> 'changed'
    and coalesce(current_setting('tripnavigate.prefill_apply', true), '') is distinct from p_target::text
$$;

create function authz.prefill_watch_booking_version() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform authz.prefill_mark_changed('booking_version', new.id, array_remove(array[
    case when new.trip_start is distinct from old.trip_start then 'trip.start' end,
    case when new.trip_end is distinct from old.trip_end then 'trip.end' end], null));
  return null;
end;
$$;
create function authz.prefill_watch_booking_contacts() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform authz.prefill_mark_changed('booking_version', new.booking_version_id, array_remove(array[
    case when tg_op = 'INSERT' or new.contact_name is distinct from old.contact_name then 'contacts.contactName' end,
    case when tg_op = 'INSERT' or new.mobile is distinct from old.mobile then 'contacts.mobile' end,
    case when tg_op = 'INSERT' or new.email is distinct from old.email then 'contacts.email' end,
    case when tg_op = 'INSERT' or new.booking_for is distinct from old.booking_for then 'contacts.bookingFor' end], null));
  return null;
end;
$$;
create function authz.prefill_watch_quotation_version() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform authz.prefill_mark_changed('quotation_version', new.id, array_remove(array[
    case when new.trip_start is distinct from old.trip_start then 'trip.start' end,
    case when new.trip_end is distinct from old.trip_end then 'trip.end' end,
    case when new.requirements_note is distinct from old.requirements_note then 'requirementsNote' end], null));
  return null;
end;
$$;
create function authz.prefill_watch_quotation_contacts() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform authz.prefill_mark_changed('quotation_version', new.quotation_version_id, array_remove(array[
    case when tg_op = 'INSERT' or new.contact_name is distinct from old.contact_name then 'contacts.contactName' end,
    case when tg_op = 'INSERT' or new.mobile is distinct from old.mobile then 'contacts.mobile' end,
    case when tg_op = 'INSERT' or new.email is distinct from old.email then 'contacts.email' end,
    case when tg_op = 'INSERT' or new.company_name is distinct from old.company_name then 'contacts.companyName' end,
    case when tg_op = 'INSERT' or new.booking_for is distinct from old.booking_for then 'contacts.bookingFor' end], null));
  return null;
end;
$$;
create trigger booking_versions_z_prefill after update of trip_start, trip_end on public.booking_versions
  for each row execute function authz.prefill_watch_booking_version();
create trigger booking_version_contacts_z_prefill after insert or update on public.booking_version_contacts
  for each row execute function authz.prefill_watch_booking_contacts();
create trigger quotation_versions_z_prefill after update of trip_start, trip_end, requirements_note on public.quotation_versions
  for each row execute function authz.prefill_watch_quotation_version();
create trigger quotation_version_contacts_z_prefill after insert or update on public.quotation_version_contacts
  for each row execute function authz.prefill_watch_quotation_contacts();

-- Records (or re-arms) a mark after a field was filled from Bitrix.
create function authz.prefill_mark(p_entity uuid, p_kind text, p_target uuid, p_field text, p_source text,
  p_modified timestamptz) returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.prefill_marks as m (legal_entity_id, target_kind, target_id, field_code, source_object, source_modified_at,
    state, applied_by)
  values (p_entity, p_kind, p_target, p_field, p_source, p_modified, 'from_bitrix', (select auth.uid()))
  on conflict (target_kind, target_id, field_code) do update
    set source_object = excluded.source_object, source_modified_at = excluded.source_modified_at,
        state = 'from_bitrix', applied_by = excluded.applied_by, applied_at = now(), checked_by = null, checked_at = null
$$;

-- The prefill block; the caller has authorized. Customer Type as code only.
-- Review E5-3: Booking Notes only for callers with commercial scope.
create function authz.prefill_view(p_subject_kind text, p_subject_id uuid, p_target_kind text, p_target uuid, p_show_notes boolean)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v jsonb;
begin
  if p_subject_id is null then
    return null;
  end if;
  v := authz.bitrix_prefill_json(p_subject_kind, p_subject_id);
  return jsonb_build_object(
    'available', coalesce((v ->> 'available')::boolean, false),
    'sourceModifiedAt', v -> 'sourceModifiedAt',
    'lastVerifiedAt', v -> 'lastVerifiedAt',
    'issues', coalesce(v -> 'issues', '[]'::jsonb),
    'notesHidden', not coalesce(p_show_notes, false),
    'fields', (v -> 'fields') - 'customerType' - 'bookingNotes' || jsonb_build_object(
      'bookingNotes', case when coalesce(p_show_notes, false) then v -> 'fields' -> 'bookingNotes' end,
      'customerType', case when jsonb_typeof(v -> 'fields' -> 'customerType') = 'object'
                           then jsonb_build_object('code', v -> 'fields' -> 'customerType' -> 'code') end),
    'marks', coalesce((select jsonb_agg(jsonb_build_object('fieldCode', m.field_code, 'state', m.state,
                         'appliedAt', m.applied_at, 'checkedAt', m.checked_at) order by m.field_code)
                       from public.prefill_marks m where m.target_kind = p_target_kind and m.target_id = p_target), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- 3. Commands
-- ===========================================================================

-- Review E5-2: the values go through the same rules as the screen saves
-- (booking_trip_save, authz.b11_contacts_write); their audit rows are written
-- too, plus booking.prefill_applied.
create function public.booking_prefill_apply(p_version_id uuid, p_expected_row_version integer, p_fields text[]) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v jsonb;
  f jsonb;
  v_allowed constant text[] := array['trip.start', 'trip.end', 'contacts.contactName', 'contacts.mobile', 'contacts.email',
    'contacts.bookingFor'];
  v_booking_for text;
  v_field text;
  v_applied text[] := '{}'::text[];
  v_skipped jsonb := '[]'::jsonb;
  v_start date;
  v_end date;
  v_trip text[] := '{}'::text[];
  v_contact public.booking_version_contacts%rowtype;
  v_name text;
  v_mobile text;
  v_email text;
  v_contact_fields text[] := '{}'::text[];
begin
  v_ver := authz.lock_package_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_fields is null or cardinality(p_fields) = 0 or exists (select 1 from unnest(p_fields) x where x <> all (v_allowed)) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v := authz.bitrix_prefill_json('deal', v_ver.deal_id);
  if not coalesce((v ->> 'available')::boolean, false) then
    raise exception 'prefill_unavailable' using errcode = '55000';
  end if;
  f := v -> 'fields';
  perform set_config('tripnavigate.prefill_apply', v_ver.id::text, true);

  -- Trip dates (through booking_trip_save: same rules and audit as the screen).
  v_start := case when 'trip.start' = any (p_fields) and f ->> 'tourStart' is not null then (f ->> 'tourStart')::date else v_ver.trip_start end;
  v_end := case when 'trip.end' = any (p_fields) and f ->> 'tourEnd' is not null then (f ->> 'tourEnd')::date else v_ver.trip_end end;
  foreach v_field in array array['trip.start', 'trip.end'] loop
    if v_field = any (p_fields) then
      if f ->> (case v_field when 'trip.start' then 'tourStart' else 'tourEnd' end) is null then
        v_skipped := v_skipped || jsonb_build_object('field', v_field, 'reason', 'no_value');
      elsif v_start is not null and v_end is not null and v_end < v_start then
        v_skipped := v_skipped || jsonb_build_object('field', v_field, 'reason', 'date_order');
      else
        v_trip := v_trip || v_field;
      end if;
    end if;
  end loop;
  if cardinality(v_trip) > 0 then
    perform public.booking_trip_save(v_ver.id, v_ver.row_version, jsonb_build_object(
      'destination', v_ver.trip_destination, 'scope', v_ver.trip_scope,
      'start', to_char(v_start, 'YYYY-MM-DD'), 'end', to_char(v_end, 'YYYY-MM-DD')));
    v_applied := v_applied || v_trip;
    select * into v_ver from public.booking_versions b where b.id = v_ver.id;
  end if;

  -- Contact (stays unconfirmed; through authz.b11_contacts_write).
  if p_fields && array['contacts.contactName', 'contacts.mobile', 'contacts.email', 'contacts.bookingFor'] then
    select * into v_contact from public.booking_version_contacts c where c.booking_version_id = v_ver.id;
    v_name := v_contact.contact_name;
    v_mobile := v_contact.mobile;
    v_email := v_contact.email;
    v_booking_for := v_contact.booking_for;
    if 'contacts.bookingFor' = any (p_fields) then
      if authz.prefill_booking_for(f) is null then
        v_skipped := v_skipped || jsonb_build_object('field', 'contacts.bookingFor', 'reason', 'no_value');
      else
        v_booking_for := authz.prefill_booking_for(f);
        v_contact_fields := v_contact_fields || 'contacts.bookingFor'::text;
      end if;
    end if;
    if 'contacts.contactName' = any (p_fields) then
      if nullif(btrim(coalesce(f -> 'contact' ->> 'name', '')), '') is null then
        v_skipped := v_skipped || jsonb_build_object('field', 'contacts.contactName', 'reason', 'no_value');
      else
        v_name := left(btrim(f -> 'contact' ->> 'name'), 120);
        v_contact_fields := v_contact_fields || 'contacts.contactName'::text;
      end if;
    end if;
    if 'contacts.mobile' = any (p_fields) then
      if f -> 'contact' ->> 'mobile' is null then
        v_skipped := v_skipped || jsonb_build_object('field', 'contacts.mobile', 'reason', 'no_value');
      elsif authz.prefill_mobile(f -> 'contact' ->> 'mobile') is null then
        v_skipped := v_skipped || jsonb_build_object('field', 'contacts.mobile', 'reason', 'mobile_format');
      else
        v_mobile := authz.prefill_mobile(f -> 'contact' ->> 'mobile');
        v_contact_fields := v_contact_fields || 'contacts.mobile'::text;
      end if;
    end if;
    if 'contacts.email' = any (p_fields) then
      if f -> 'contact' ->> 'email' is null
         or length(f -> 'contact' ->> 'email') > 254 or (f -> 'contact' ->> 'email') !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
        v_skipped := v_skipped || jsonb_build_object('field', 'contacts.email', 'reason', 'no_value');
      else
        v_email := f -> 'contact' ->> 'email';
        v_contact_fields := v_contact_fields || 'contacts.email'::text;
      end if;
    end if;
    if cardinality(v_contact_fields) > 0 then
      if v_name is null then
        v_skipped := v_skipped || (select jsonb_agg(jsonb_build_object('field', x, 'reason', 'contact_name_missing')) from unnest(v_contact_fields) x);
      elsif v_mobile is null and v_email is null then
        v_skipped := v_skipped || (select jsonb_agg(jsonb_build_object('field', x, 'reason', 'contact_needs_mobile_or_email')) from unnest(v_contact_fields) x);
      else
        -- "Booking for": DEC-45 value when requested, else the saved value; a new contact row needs one ('individual').
        perform authz.b11_contacts_write(v_ver, jsonb_build_object('contactName', v_name, 'mobile', v_mobile, 'email', v_email,
          'contactConfirmed', false, 'bookingFor', coalesce(v_booking_for, 'individual'),
          'payerDifferent', coalesce(v_contact.payer_different, false), 'payerName', v_contact.payer_name));
        v_applied := v_applied || v_contact_fields;
      end if;
    end if;
  end if;

  foreach v_field in array v_applied loop
    perform authz.prefill_mark(v_ver.legal_entity_id, 'booking_version', v_ver.id, v_field, 'deal', (v ->> 'sourceModifiedAt')::timestamptz);
  end loop;
  v_ver := authz.bump_package_version(v_ver.id);
  perform set_config('tripnavigate.prefill_apply', '', true);
  perform authz.write_audit('booking.prefill_applied', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'fields', to_jsonb(v_applied), 'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash, 'applied', to_jsonb(v_applied),
    'skipped', v_skipped);
end;
$$;

-- Review E5-2: through quotation_version_save and quotation_contacts_save (same rules and audit).
create function public.quotation_prefill_apply(p_version_id uuid, p_expected_row_version integer, p_fields text[]) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_q public.quotations%rowtype;
  v_kind text;
  v jsonb;
  f jsonb;
  v_allowed constant text[] := array['trip.start', 'trip.end', 'requirementsNote', 'contacts.contactName', 'contacts.mobile',
    'contacts.email', 'contacts.companyName', 'contacts.bookingFor'];
  v_booking_for text;
  v_field text;
  v_applied text[] := '{}'::text[];
  v_skipped jsonb := '[]'::jsonb;
  v_start date;
  v_end date;
  v_save jsonb := '{}'::jsonb;
  v_rv integer;
  v_contact public.quotation_version_contacts%rowtype;
  v_name text;
  v_mobile text;
  v_email text;
  v_company text;
  v_contact_fields text[] := '{}'::text[];
begin
  v_ver := authz.lock_quotation_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_fields is null or cardinality(p_fields) = 0 or exists (select 1 from unnest(p_fields) x where x <> all (v_allowed)) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  select * into v_q from public.quotations q where q.id = v_ver.quotation_id;
  v_kind := case when v_q.deal_id is not null then 'deal' else 'lead' end;
  v := authz.bitrix_prefill_json(v_kind, coalesce(v_q.deal_id, v_q.lead_id));
  if not coalesce((v ->> 'available')::boolean, false) then
    raise exception 'prefill_unavailable' using errcode = '55000';
  end if;
  f := v -> 'fields';
  perform set_config('tripnavigate.prefill_apply', v_ver.id::text, true);
  v_rv := v_ver.row_version;

  v_start := case when 'trip.start' = any (p_fields) and f ->> 'tourStart' is not null then (f ->> 'tourStart')::date else v_ver.trip_start end;
  v_end := case when 'trip.end' = any (p_fields) and f ->> 'tourEnd' is not null then (f ->> 'tourEnd')::date else v_ver.trip_end end;
  foreach v_field in array array['trip.start', 'trip.end'] loop
    if v_field = any (p_fields) then
      if f ->> (case v_field when 'trip.start' then 'tourStart' else 'tourEnd' end) is null then
        v_skipped := v_skipped || jsonb_build_object('field', v_field, 'reason', 'no_value');
      elsif v_start is not null and v_end is not null and v_end < v_start then
        v_skipped := v_skipped || jsonb_build_object('field', v_field, 'reason', 'date_order');
      else
        v_save := v_save || jsonb_build_object(case v_field when 'trip.start' then 'start' else 'end' end,
          to_char(case v_field when 'trip.start' then v_start else v_end end, 'YYYY-MM-DD'));
        v_applied := v_applied || v_field;
      end if;
    end if;
  end loop;
  if 'requirementsNote' = any (p_fields) then
    -- Review E5-3: Booking Notes only for callers with commercial scope.
    if not authz.quotation_money_can_read(v_q.id) then
      v_skipped := v_skipped || jsonb_build_object('field', 'requirementsNote', 'reason', 'not_allowed');
    elsif f ->> 'bookingNotes' is null then
      v_skipped := v_skipped || jsonb_build_object('field', 'requirementsNote', 'reason', 'no_value');
    else
      v_save := v_save || jsonb_build_object('requirementsNote', left(f ->> 'bookingNotes', 4000));
      v_applied := v_applied || 'requirementsNote'::text;
    end if;
  end if;
  if v_save <> '{}'::jsonb then
    v_rv := (public.quotation_version_save(v_ver.id, v_rv, v_save) ->> 'rowVersion')::integer;
  end if;

  if p_fields && array['contacts.contactName', 'contacts.mobile', 'contacts.email', 'contacts.companyName', 'contacts.bookingFor'] then
    select * into v_contact from public.quotation_version_contacts c where c.quotation_version_id = v_ver.id;
    v_name := v_contact.contact_name;
    v_mobile := v_contact.mobile;
    v_email := v_contact.email;
    v_company := v_contact.company_name;
    if 'contacts.bookingFor' = any (p_fields) then
      if authz.prefill_booking_for(f) is null then
        v_skipped := v_skipped || jsonb_build_object('field', 'contacts.bookingFor', 'reason', 'no_value');
      else
        v_booking_for := authz.prefill_booking_for(f);
        v_contact_fields := v_contact_fields || 'contacts.bookingFor'::text;
      end if;
    end if;
    if 'contacts.contactName' = any (p_fields) then
      if nullif(btrim(coalesce(f -> 'contact' ->> 'name', '')), '') is null then
        v_skipped := v_skipped || jsonb_build_object('field', 'contacts.contactName', 'reason', 'no_value');
      else
        v_name := left(btrim(f -> 'contact' ->> 'name'), 120);
        v_contact_fields := v_contact_fields || 'contacts.contactName'::text;
      end if;
    end if;
    if 'contacts.mobile' = any (p_fields) then
      if f -> 'contact' ->> 'mobile' is null then
        v_skipped := v_skipped || jsonb_build_object('field', 'contacts.mobile', 'reason', 'no_value');
      elsif authz.prefill_mobile(f -> 'contact' ->> 'mobile') is null then
        v_skipped := v_skipped || jsonb_build_object('field', 'contacts.mobile', 'reason', 'mobile_format');
      else
        v_mobile := authz.prefill_mobile(f -> 'contact' ->> 'mobile');
        v_contact_fields := v_contact_fields || 'contacts.mobile'::text;
      end if;
    end if;
    if 'contacts.email' = any (p_fields) then
      if f -> 'contact' ->> 'email' is null
         or length(f -> 'contact' ->> 'email') > 254 or (f -> 'contact' ->> 'email') !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then
        v_skipped := v_skipped || jsonb_build_object('field', 'contacts.email', 'reason', 'no_value');
      else
        v_email := f -> 'contact' ->> 'email';
        v_contact_fields := v_contact_fields || 'contacts.email'::text;
      end if;
    end if;
    if 'contacts.companyName' = any (p_fields) then
      if nullif(btrim(coalesce(f -> 'company' ->> 'name', '')), '') is null then
        v_skipped := v_skipped || jsonb_build_object('field', 'contacts.companyName', 'reason', 'no_value');
      else
        v_company := left(btrim(f -> 'company' ->> 'name'), 200);
        v_contact_fields := v_contact_fields || 'contacts.companyName'::text;
      end if;
    end if;
    if cardinality(v_contact_fields) > 0 then
      if v_name is null then
        v_skipped := v_skipped || (select jsonb_agg(jsonb_build_object('field', x, 'reason', 'contact_name_missing')) from unnest(v_contact_fields) x);
      elsif v_mobile is null and v_email is null then
        v_skipped := v_skipped || (select jsonb_agg(jsonb_build_object('field', x, 'reason', 'contact_needs_mobile_or_email')) from unnest(v_contact_fields) x);
      else
        v_rv := (public.quotation_contacts_save(v_ver.id, v_rv, jsonb_build_object('contactName', v_name, 'mobile', v_mobile,
          'email', v_email, 'companyName', v_company)
          || case when v_booking_for is not null then jsonb_build_object('bookingFor', v_booking_for) else '{}'::jsonb end)
          ->> 'rowVersion')::integer;
        v_applied := v_applied || v_contact_fields;
      end if;
    end if;
  end if;

  foreach v_field in array v_applied loop
    perform authz.prefill_mark(v_ver.legal_entity_id, 'quotation_version', v_ver.id, v_field, v_kind, (v ->> 'sourceModifiedAt')::timestamptz);
  end loop;
  v_ver := authz.bump_quotation_version(v_ver.id);
  perform set_config('tripnavigate.prefill_apply', '', true);
  perform authz.write_audit('quotation.prefill_applied', v_ver.legal_entity_id, v_q.branch_id, 'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_q.id, 'versionId', v_ver.id, 'fields', to_jsonb(v_applied), 'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'applied', to_jsonb(v_applied), 'skipped', v_skipped);
end;
$$;

create function public.prefill_mark_checked(p_target_kind text, p_target_id uuid, p_expected_row_version integer, p_fields text[])
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entity uuid;
  v_branch uuid;
  v_rv integer;
  v_checked text[];
begin
  if p_target_kind = 'booking_version' then
    declare
      v_ver public.booking_versions%rowtype;
    begin
      v_ver := authz.lock_package_draft(p_target_id);
      v_entity := v_ver.legal_entity_id;
      v_branch := v_ver.branch_id;
      v_rv := v_ver.row_version;
    end;
  elsif p_target_kind = 'quotation_version' then
    declare
      v_ver public.quotation_versions%rowtype;
    begin
      v_ver := authz.lock_quotation_version(p_target_id);
      if v_ver.status not in ('draft', 'ready') then
        raise exception 'wrong_state' using errcode = '55000';
      end if;
      v_entity := v_ver.legal_entity_id;
      v_branch := (select q.branch_id from public.quotations q where q.id = v_ver.quotation_id);
      v_rv := v_ver.row_version;
    end;
  else
    raise exception 'invalid_input' using errcode = '22023', hint = 'targetKind';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_rv);
  if p_fields is null or cardinality(p_fields) = 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  with u as (
    update public.prefill_marks m set state = 'checked', checked_by = (select auth.uid()), checked_at = now()
    where m.target_kind = p_target_kind and m.target_id = p_target_id and m.field_code = any (p_fields) and m.state = 'from_bitrix'
    returning m.field_code)
  select coalesce(array_agg(u.field_code order by u.field_code), '{}'::text[]) into v_checked from u;
  perform authz.write_audit('prefill.checked', v_entity, v_branch, p_target_kind, p_target_id, null,
    jsonb_build_object('targetKind', p_target_kind, 'targetId', p_target_id, 'fields', to_jsonb(v_checked)));
  return jsonb_build_object('checked', to_jsonb(v_checked));
end;
$$;

-- ===========================================================================
-- 4. Reads (mechanical copies of the 20261120000200 bodies plus the lines
--    marked "B1.2 0600")
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
      'confirmedAt', v_ver.confirmed_at) end,
    'trip', jsonb_build_object('destination', v_ver.trip_destination, 'scope', v_ver.trip_scope,
      'start', to_char(v_ver.trip_start, 'YYYY-MM-DD'), 'end', to_char(v_ver.trip_end, 'YYYY-MM-DD')),
    'contacts', (select jsonb_build_object('contactName', c.contact_name, 'mobile', c.mobile, 'email', c.email,
        'contactConfirmed', c.contact_confirmed, 'confirmedAt', c.confirmed_at,
        'confirmedByName', (select p.display_name from public.staff_profiles p where p.user_id = c.confirmed_by),
        'bookingFor', c.booking_for, 'payerDifferent', c.payer_different, 'payerName', c.payer_name)
      from public.booking_version_contacts c where c.booking_version_id = v_ver.id),
    'billing', case when v_billing.deal_id is null
      then jsonb_build_object('status', 'none', 'prefillSource', null, 'rowVersion', 0)
      else jsonb_build_object('status', v_billing.status, 'prefillSource', v_billing.prefill_source,
        'rowVersion', v_billing.row_version, 'billingName', v_billing.billing_name,
        'addressLine1', v_billing.address_line1, 'addressLine2', v_billing.address_line2, 'city', v_billing.city,
        'stateCode', v_billing.state_code, 'postalCode', v_billing.postal_code, 'gstin', v_billing.gstin) end,
    'travellers', coalesce((
      select jsonb_agg(jsonb_build_object('travellerId', t.id, 'seq', t.seq, 'fullName', t.full_name, 'type', t.traveller_type,
          'ageYears', t.age_years, 'specialNeeds', t.special_needs,
          'identity', case when authz.can_read_traveller_identity(p_deal_id, t.seq)
                           then authz.booking_identity_json(p_deal_id, t.seq, null) end)
          -- B1.2: identity proofs of this traveller, only for identity-proof viewers (DEC-41).
          || case when v_id_proof_view
                  then jsonb_build_object('idProofs', authz.traveller_id_proofs_json(t.id)) else '{}'::jsonb end
          order by t.seq)
      from public.deal_travellers t where t.deal_id = p_deal_id), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(authz.service_item_json(i.id, v_ver.id, true)
          || jsonb_build_object('participants', to_jsonb(authz.item_participant_seqs(i.id, v_ver.id))) order by i.item_no)
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
           from public.booking_version_instalments p where p.booking_version_id = v_ver.id), '[]'::jsonb));
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
    elsif v_contact.booking_for = 'business' and v_billing.gstin is null then
      v_items := v_items || jsonb_build_object('code', 'gstin_missing', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb);
    end if;
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
  if v_ver.id is not null and v_ver.status = 'draft' and exists (
       select 1 from public.prefill_marks m
       where m.target_kind = 'booking_version' and m.target_id = v_ver.id and m.state = 'from_bitrix') then
    v_items := v_items || jsonb_build_object('code', 'prefill_unchecked', 'blocking', false, 'owner', 'sales', 'itemNos', '[]'::jsonb,
      'fields', (select jsonb_agg(m.field_code order by m.field_code) from public.prefill_marks m
                 where m.target_kind = 'booking_version' and m.target_id = v_ver.id and m.state = 'from_bitrix'));
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
    if cardinality(v_nos) > 0 then
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

create or replace function public.quotation_get(p_version_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions;
  v_q public.quotations;
  v_result jsonb;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_ver from public.quotation_versions v where v.id = p_version_id;
  select * into v_q from public.quotations q where q.id = v_ver.quotation_id;
  if v_q.id is null or not authz.quotation_can_edit(v_q.id) or authz.quotation_deal_removed(v_q.id) then
    return null;
  end if;
  v_result := jsonb_build_object(
    'quotationId', v_q.id, 'reference', v_q.reference, 'title', v_q.title, 'rowVersion', v_q.row_version,
    'subject', jsonb_build_object('kind', case when v_q.lead_id is not null then 'lead' else 'deal' end,
      'leadId', v_q.lead_id, 'dealId', v_q.deal_id, 'linkedDealId', v_q.linked_deal_id,
      'reference', coalesce((select l.reference from public.crm_leads l where l.id = v_q.lead_id),
                            (select d.reference from public.deals d where d.id = v_q.deal_id)),
      'title', coalesce((select l.title from public.crm_leads l where l.id = v_q.lead_id),
                        (select d.title from public.deals d where d.id = v_q.deal_id))),
    'version', authz.quotation_version_json(v_ver),
    'trip', jsonb_build_object('destination', v_ver.trip_destination, 'scope', v_ver.trip_scope,
      'start', to_char(v_ver.trip_start, 'YYYY-MM-DD'), 'end', to_char(v_ver.trip_end, 'YYYY-MM-DD')),
    'pax', jsonb_build_object('adults', v_ver.adults, 'childrenWithBed', v_ver.children_with_bed,
      'childrenNoBed', v_ver.children_no_bed, 'infants', v_ver.infants, 'remarks', v_ver.pax_remarks),
    'requirementsNote', v_ver.requirements_note,
    'content', v_ver.content,
    'tiers', coalesce((select jsonb_agg(jsonb_build_object('tierKey', t.tier_key, 'label', t.label) order by t.tier_key)
                       from public.quotation_version_tiers t where t.quotation_version_id = v_ver.id), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object('itemId', i.id, 'itemNo', i.item_no, 'serviceType', i.service_type,
                         'tierKey', i.tier_key,
                         'title', coalesce(nullif(authz.service_item_title(i.service_type, i.facts), ''), initcap(i.service_type)),
                         'facts', i.facts,
                         'factsValid', cardinality(authz.validate_service_facts(i.service_type, i.facts)) = 0) order by i.item_no)
                       from public.quotation_version_items i where i.quotation_version_id = v_ver.id), '[]'::jsonb),
    'contacts', (select jsonb_build_object('contactName', c.contact_name, 'mobile', c.mobile, 'email', c.email,
                   'companyName', c.company_name, 'bookingFor', c.booking_for)
                 from public.quotation_version_contacts c where c.quotation_version_id = v_ver.id),
    'evidence', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'fileName', e.file_name, 'mime', e.mime,
                            'sizeBytes', e.size_bytes, 'status', e.status, 'createdAt', e.created_at, 'storedAt', e.stored_at,
                            'uploadedByYou', e.uploaded_by = (select auth.uid())) order by e.created_at, e.id)
                          from public.quotation_evidence e where e.quotation_version_id = v_ver.id and e.status <> 'removed'), '[]'::jsonb),
    'issues', case when v_ver.status = 'draft' then to_jsonb(authz.quotation_issues(v_ver.id)) else '[]'::jsonb end,
    'canEdit', v_ver.status in ('draft', 'ready') and v_q.converted_at is null,
    'conversion', (select jsonb_build_object('bookingVersionId', c.booking_version_id, 'dealId', c.deal_id, 'createdAt', c.created_at)
                   from public.quotation_conversions c where c.quotation_version_id = v_ver.id));
  -- B1.2 0600: Bitrix values of the quotation's Deal or Lead (DEC-36); the caller is an editor.
  v_result := v_result || jsonb_build_object('prefill',
    authz.prefill_view(case when v_q.deal_id is not null then 'deal' else 'lead' end, coalesce(v_q.deal_id, v_q.lead_id),
      'quotation_version', v_ver.id, authz.quotation_money_can_read(v_q.id))
    || jsonb_build_object('unchecked', coalesce((select jsonb_agg(m.field_code order by m.field_code) from public.prefill_marks m
         where m.target_kind = 'quotation_version' and m.target_id = v_ver.id and m.state = 'from_bitrix'), '[]'::jsonb)));
  if authz.quotation_money_can_read(v_q.id) then
    v_result := v_result || jsonb_build_object('money', authz.quotation_money_json(v_ver.id));
  end if;
  return v_result;
end;
$$;

-- ===========================================================================
-- 5. Grants
-- ===========================================================================

revoke all on function
  authz.prefill_mobile(text), authz.prefill_booking_for(jsonb), authz.prefill_mark_changed(text, uuid, text[]),
  authz.prefill_watch_booking_version(), authz.prefill_watch_booking_contacts(),
  authz.prefill_watch_quotation_version(), authz.prefill_watch_quotation_contacts(),
  authz.prefill_mark(uuid, text, uuid, text, text, timestamptz), authz.prefill_view(text, uuid, text, uuid, boolean)
from public, anon, authenticated, service_role;

revoke all on function
  public.booking_prefill_apply(uuid, integer, text[]),
  public.quotation_prefill_apply(uuid, integer, text[]),
  public.prefill_mark_checked(text, uuid, integer, text[]),
  public.booking_form_get(uuid),
  public.intake_checklist(uuid),
  public.quotation_get(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.booking_prefill_apply(uuid, integer, text[]),
  public.quotation_prefill_apply(uuid, integer, text[]),
  public.prefill_mark_checked(text, uuid, integer, text[]),
  public.booking_form_get(uuid),
  public.intake_checklist(uuid),
  public.quotation_get(uuid)
to authenticated;

commit;
