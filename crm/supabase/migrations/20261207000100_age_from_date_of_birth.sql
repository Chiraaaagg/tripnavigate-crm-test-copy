-- TripNavigate CRM - Booking reliability fix batch 2, item B2-1 (BR-08):
-- the age of a child or infant comes from the date of birth on the trip start.
--
-- Build contract: booking-reliability-2026-11-19/build-contract.md section 6
-- (B2-1), section 3.3 (C0-batch2) and addendum 1 (owner Q4: a date of birth
-- that does not fit the passenger type is warned on screen and allowed).
-- Every replaced function keeps its signature, starts from its latest body
-- and keeps its attributes; changed lines are marked "B2-1".
--
-- What changes:
--   1. authz.age_on(date, date) (new, internal): whole years on a date; -1
--      when the date of birth is after it. Immutable.
--   2. authz.traveller_age_derived(uuid, uuid) (new, internal): the age of a
--      traveller on the trip start of the Deal's open package draft, from the
--      saved date of birth; null when there is no date of birth, no draft,
--      no trip start, or the number falls outside 0 to 17.
--   3. authz.traveller_age_sync(p_deal_id uuid, p_seq integer default null)
--      (new, internal): sets deal_travellers.age_years of the child and
--      infant rows to the derived number; returns how many rows changed.
--      Never touches booking_version_travellers (confirmed snapshots).
--   4. Triggers, so every writer is covered without restating large functions:
--      - deal_travellers_a_age (before insert or update of age_years,
--        traveller_type): a child or infant with a derived age keeps the
--        derived age; a typed age counts only without one.
--      - traveller_identities_c_age (after insert or update of date_of_birth).
--      - booking_versions_c_age_insert / booking_versions_c_age_trip (after
--        insert, or update of trip_start, of a draft package version).
--      The existing rehash triggers keep the draft hash in step.
--   5. authz.child_age_missing_seqs(uuid) / authz.child_age_missing(uuid)
--      (new, internal): a child or infant without a stored age, and either no
--      saved date of birth or a trip start on the draft. With a date of birth
--      and no trip dates the checklist asks for the trip dates (trip_missing),
--      not for an age.
--   6. public.traveller_identity_save (replaces 20261128000110:888): locks the
--      open draft first; when the save changed the stored age it bumps the
--      draft through authz.bump_package_version and answers ageYears and
--      draftRowVersion {from, to}; the audit detail gains ageDerived: true.
--      Otherwise the answer and behaviour are as before.
--   7. authz.booking_issues (replaces 20261205000640:50) and
--      public.intake_checklist (replaces 20261203000100:173): the child age
--      predicate is authz.child_age_missing / _seqs. Nothing else changes.
--
-- Contract difference, owner Q4 (warn and allow), reported to the lead: a
-- derived number outside 0 to 17 is not stored and nothing is refused; the
-- stored (typed) age stays and the screen warns (W10d, W10e). The column
-- check (0 to 17) is not loosened.
--
-- Attributes restated exactly as today: traveller_identity_save plpgsql
-- volatile security definer, search_path ''; booking_issues sql stable
-- security definer, search_path ''; intake_checklist plpgsql stable security
-- definer, search_path ''. Their grants are kept as they are (create or
-- replace keeps them: the two commands execute to authenticated; booking_issues
-- none for the API roles). Every new function: security definer, search_path
-- '', execute revoked from public, anon, authenticated and service_role.
-- No new table, column, read, grant, switch or refusal token. The date of
-- birth reaches no one new: only the number is stored.
-- Data: none here (the one-time fill of open drafts is the separate migration
-- 20261207000290, a live data write named in the approval request).
-- Rollback (forward-only): a NEW migration dropping the four triggers and
-- restoring the previous bodies (20261128000110:888, 20261205000640:50,
-- 20261203000100:173), then dropping the new functions. Stored ages stay
-- valid; nothing is removed.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Age on a date (new)
-- ===========================================================================

create function authz.age_on(p_date_of_birth date, p_on date) returns integer
language sql immutable security definer set search_path = '' as $$
  select case when p_date_of_birth is null or p_on is null then null
              when p_date_of_birth > p_on then -1
              else extract(year from age(p_on::timestamp, p_date_of_birth::timestamp))::integer end
$$;

-- ===========================================================================
-- 2. Derived age of one traveller (new)
-- ===========================================================================

create function authz.traveller_age_derived(p_traveller_id uuid, p_deal_id uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select s.age from (
    select authz.age_on(x.date_of_birth, v.trip_start) as age
    from public.traveller_identities x
    join public.booking_versions v on v.deal_id = p_deal_id and v.status = 'draft' and v.service_type = 'package'
    where x.traveller_id = p_traveller_id and x.date_of_birth is not null and v.trip_start is not null
  ) s
  where s.age between 0 and 17
$$;

-- ===========================================================================
-- 3. Re-derive the stored ages of a Deal (new)
-- ===========================================================================

create function authz.traveller_age_sync(p_deal_id uuid, p_seq integer default null) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n integer;
begin
  update public.deal_travellers t set age_years = d.age
  from (
    select t2.id, authz.traveller_age_derived(t2.id, t2.deal_id) as age
    from public.deal_travellers t2
    where t2.deal_id = p_deal_id and (p_seq is null or t2.seq = p_seq) and t2.traveller_type in ('child', 'infant')
  ) d
  where t.id = d.id and d.age is not null and t.age_years is distinct from d.age;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- ===========================================================================
-- 4. Triggers (new)
-- ===========================================================================

-- Every writer of a passenger row (passengers save, flight name fill, revision
-- copy): a derived age wins over a posted one.
create function authz.deal_travellers_age_from_dob() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_age integer;
begin
  if new.traveller_type in ('child', 'infant') then
    v_age := authz.traveller_age_derived(new.id, new.deal_id);
    if v_age is not null then
      new.age_years := v_age;
    end if;
  end if;
  return new;
end;
$$;
create trigger deal_travellers_a_age
  before insert or update of age_years, traveller_type on public.deal_travellers
  for each row execute function authz.deal_travellers_age_from_dob();

-- A saved or changed date of birth.
create function authz.traveller_identities_age_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform authz.traveller_age_sync(t.deal_id, t.seq) from public.deal_travellers t where t.id = new.traveller_id;
  return null;
end;
$$;
create trigger traveller_identities_c_age
  after insert or update of date_of_birth on public.traveller_identities
  for each row execute function authz.traveller_identities_age_sync();

-- A new draft (revision, conversion) or a moved trip start.
create function authz.booking_versions_age_sync() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform authz.traveller_age_sync(new.deal_id);
  return null;
end;
$$;
create trigger booking_versions_c_age_insert
  after insert on public.booking_versions
  for each row when (new.status = 'draft' and new.service_type = 'package' and new.trip_start is not null)
  execute function authz.booking_versions_age_sync();
create trigger booking_versions_c_age_trip
  after update of trip_start on public.booking_versions
  for each row when (new.status = 'draft' and new.service_type = 'package' and new.trip_start is distinct from old.trip_start)
  execute function authz.booking_versions_age_sync();

-- ===========================================================================
-- 5. Readiness predicate (new)
-- ===========================================================================

create function authz.child_age_missing_seqs(p_deal_id uuid) returns integer[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(t.seq order by t.seq), '{}'::integer[])
  from public.deal_travellers t
  where t.deal_id = p_deal_id and t.traveller_type in ('child', 'infant') and t.age_years is null
    and (not exists (select 1 from public.traveller_identities x where x.traveller_id = t.id and x.date_of_birth is not null)
         or exists (select 1 from public.booking_versions v
                    where v.deal_id = p_deal_id and v.status = 'draft' and v.service_type = 'package' and v.trip_start is not null))
$$;

create function authz.child_age_missing(p_deal_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select cardinality(authz.child_age_missing_seqs(p_deal_id)) > 0
$$;

-- ===========================================================================
-- 6. Identity save (replaces 20261128000110:888; lines marked B2-1)
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
  -- Booking reliability B2-1 (20261207000100)
  v_draft public.booking_versions%rowtype;
  v_draft_from integer;
  v_age_before integer;
  v_age_after integer;
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
  -- B2-1: the open package draft first (the lock order of the other saves); its version moves when the stored age does.
  select * into v_draft from public.booking_versions v
  where v.deal_id = p_deal_id and v.status = 'draft' and v.service_type = 'package' for update;
  select * into v_trav from public.deal_travellers t where t.deal_id = p_deal_id and t.seq = p_seq for update;
  if v_trav.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_age_before := v_trav.age_years;  -- B2-1
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
  -- B2-1: the identity trigger re-derived a child's or infant's age from the date of birth
  -- on the trip start; a changed stored age moves the draft's version (its hash already follows).
  select t.age_years into v_age_after from public.deal_travellers t where t.id = v_trav.id;
  if v_draft.id is not null and v_age_after is distinct from v_age_before then
    v_draft_from := v_draft.row_version;
    v_draft := authz.bump_package_version(v_draft.id);
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
      'rowVersion', v_row)
    || case when v_draft_from is not null then jsonb_build_object('ageDerived', true) else '{}'::jsonb end);  -- B2-1
  return jsonb_build_object('seq', p_seq, 'rowVersion', v_row)
    -- B2-1: only when this save changed the stored age.
    || case when v_draft_from is not null
            then jsonb_build_object('ageYears', v_age_after,
                   'draftRowVersion', jsonb_build_object('from', v_draft_from, 'to', v_draft.row_version))
            else '{}'::jsonb end;
end;
$$;

-- ===========================================================================
-- 7. Readiness (replaces 20261205000640:50; one predicate marked B2-1)
-- ===========================================================================

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
    -- Booking reliability B2-1 (20261207000100): a saved date of birth counts as the age source.
    case when authz.child_age_missing(d.id) then 'child_age_missing' end,
    case when cardinality(authz.b11_participation_missing_nos(v.id)) > 0 then 'participation_missing' end,
    case when cardinality(authz.b11_identity_missing_seqs(v.id)) > 0 then 'identity_missing' end,
    -- B1.2 (DEC-38): every adult traveller needs a stored identity proof; drafts
    -- only (first and revision drafts), so confirmed versions are not re-checked.
    -- Accounts phase (20261203000100): a flight-only version needs no ID proof.
    case when v.status = 'draft' and not authz.version_flight_only(v.id) and exists (
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
    -- Accounts phase 3 (20261205000640): a change version's class is set by booking_change_submit.
    case when v.revises_version_id is not null and v.change_request_id is null
          and (v.change_class is null
               or v.changed_fields is distinct from authz.revision_changed_fields(v.id)
               or not (v.change_class = any (authz.revision_allowed_classes(authz.revision_changed_fields(v.id)))))
      then 'revision_class_missing' end,
    -- Accounts phase 3 (20261205000640): a change version needs no fresh customer acceptance (Q7).
    case when v.revises_version_id is not null and v.change_request_id is null and v.change_class = 'customer_material'
          and not exists (select 1 from public.booking_evidence e
                          where e.version_id = v.id and e.kind = 'acceptance_message' and e.status = 'stored')
      then 'customer_acceptance_required' end,
    case when v.revises_version_id is not null and cardinality(authz.revision_changed_fields(v.id)) = 0 then 'no_changes' end,
    -- Accounts phase 3 (20261205000640): a change version's base stays approved (checked by the change flow).
    case when v.revises_version_id is not null and v.change_request_id is null and not exists (
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

-- ===========================================================================
-- 8. Checklist (replaces 20261203000100:173; one predicate marked B2-1)
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
  -- Booking reliability B2-1 (20261207000100): a saved date of birth counts as the age source.
  v_seqs := authz.child_age_missing_seqs(p_deal_id);
  if cardinality(v_seqs) > 0 then
    v_items := v_items || jsonb_build_object('code', 'child_age_missing', 'blocking', true, 'owner', 'sales', 'itemNos', '[]'::jsonb,
      'travellerSeqs', to_jsonb(v_seqs));
  end if;
  -- B1.2 (DEC-38): travellers without a stored identity proof. Adults block
  -- submission; children and infants are a warning. Package drafts only (a
  -- confirmed version is not re-checked).
  -- Accounts phase (20261203000100): neither the adult block nor the child
  -- warning on a flight-only version (AL2).
  if v_ver.status = 'draft' and not authz.version_flight_only(v_ver.id) then
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
-- 9. Grants
-- ===========================================================================

revoke all on function authz.age_on(date, date), authz.traveller_age_derived(uuid, uuid),
  authz.traveller_age_sync(uuid, integer), authz.deal_travellers_age_from_dob(),
  authz.traveller_identities_age_sync(), authz.booking_versions_age_sync(),
  authz.child_age_missing_seqs(uuid), authz.child_age_missing(uuid)
from public, anon, authenticated, service_role;
-- The three replaced functions keep their grants (create or replace keeps them).

commit;
