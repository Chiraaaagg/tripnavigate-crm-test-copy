-- TripNavigate CRM - voice-note booking form batch (24 October 2026), part 4:
-- customer (bill-to party) master.
--
-- Owner table of 24 October 2026 items 5, 9 and 10, owner answer 4 (lead
-- brief lead-voice-notes.md). Shapes: Atlas notes atlas-vn-shapes.md section
-- (g). Check states frozen by the lead: not_checked | checked | returned.
--
-- What changes:
--   1. public.customer_parties: personal or business bill-to parties of one
--      legal entity (branch, or the whole entity when branch_id is null):
--      name, contact person (business), phone, email, address (India state
--      code and PIN, the billing rules), GST status / GSTIN / reason for no
--      GSTIN (the billing rules), Accounts check state (not_checked | checked |
--      returned with a reason), source reference (imports; unique per entity),
--      created_by. Never deleted. No Data API access. Purchase never reads it.
--   2. public.customer_party_documents + private bucket
--      customer-party-documents (the traveller_id_proofs pattern): personal
--      ID file (consent required) or other; business GST certificate or
--      other; at most 6 live files per party; soft removal only.
--   3. customer_billing_profiles.party_id / party_copied_at: the party a
--      Deal's billing was copied from (reference only). The billing profile
--      keeps its own copy: a later party edit never changes it.
--   4. Commands and reads (all definer, authorization first):
--        customer_party_search, customer_party_get, customer_party_create
--        (booking editor of a Deal; entity and branch from the Deal),
--        customer_party_save (Sales / Manager; refused when checked),
--        customer_party_accounts_save (Accounts; back to not_checked),
--        customer_party_check (Accounts: checked | returned with a reason),
--        customer_party_accounts_list (Accounts list),
--        booking_bill_to_select_party (copies the party into the Deal's
--        billing through the same Bill To rules as booking_customer_save and
--        keeps the party reference),
--        customer_party_document_begin / _finish / _remove /
--        _authorize_download.
--   5. public.booking_form_get (replaces 20261124000120; the voice-note keys
--      of 20261128000110 too): billing.partyId and billing.partyCheckStatus.
--   customer_party_get answers the party's history (actions, field names,
--   reasons; never values) and the Deals it was copied into that the caller
--   may open (reference, title, branch; no money).
--   Lead ruling Q10: a document stored on a checked party sends it back to
--   not_checked (audited party.check_reset); Deal billing copies are untouched.
--   Readers: Accounts of the entity, and active Sales / Manager members of the
--   party's branch (any branch of the entity when the party has none); never
--   a Purchase role holder of the entity; never Super Admin by role. A new or
--   imported party is never checked automatically. The same Accounts person
--   may edit and check (owner answer 4).
--
-- Refusal tokens (message is exactly the token): 42501 not_authorized; 22023
-- invalid_input (hint = keys), party_incomplete (hint = billing keys),
-- consent_required, evidence_rejected; 55000 party_checked, party_returned,
-- party_doc_limit, billing_verified, deal_removed, service_items_disabled,
-- deal_not_active, already_confirmed; 40001 version_changed,
-- request_conflict; P0002 not_found.
--
-- Fix round (Echo-A review of 24 Oct; this file had run on disposable local
-- stacks only, so it is amended in place): L5 formula text refused in the
-- field rule; L7 removing a stored document from a checked party also sends it
-- back to not_checked (audit party.check_reset, cause document_removed).
--
-- Rollback (forward-only): a new migration revoking execute on the public
-- functions. Rows, files and the billing references are kept.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Tables
-- ===========================================================================

create table public.customer_parties (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  branch_id uuid references public.branches (id),
  party_type text not null check (party_type in ('personal', 'business')),
  name text not null check (char_length(name) between 1 and 200 and name = btrim(name) and name !~ '[[:cntrl:]]'),
  name_key text generated always as (lower(name)) stored,
  contact_person text check (char_length(contact_person) between 1 and 120 and contact_person !~ '[[:cntrl:]]'),
  phone text check (phone ~ '^[6-9][0-9]{9}$' or phone ~ '^\+[1-9][0-9]{6,14}$'),
  phone_digits text generated always as (regexp_replace(coalesce(phone, ''), '[^0-9]', '', 'g')) stored,
  email text check (length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  address_line1 text check (char_length(address_line1) between 1 and 200 and address_line1 !~ '[[:cntrl:]]'),
  address_line2 text check (char_length(address_line2) between 1 and 200 and address_line2 !~ '[[:cntrl:]]'),
  city text check (char_length(city) between 1 and 120 and city !~ '[[:cntrl:]]'),
  state_code text check (state_code ~ '^(0[1-9]|[12][0-9]|3[0-8]|97)$'),
  postal_code text check (postal_code ~ '^[1-9][0-9]{5}$'),
  gst_status text check (gst_status in ('registered', 'unregistered')),
  gstin text check (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' and left(gstin, 2) = state_code),
  gst_reason text check (char_length(gst_reason) between 10 and 500),
  check_status text not null default 'not_checked' check (check_status in ('not_checked', 'checked', 'returned')),
  check_reason text check (char_length(check_reason) between 10 and 500),
  checked_by uuid references public.staff_profiles (user_id),
  checked_at timestamptz,
  source_ref text check (source_ref ~ '^[A-Za-z0-9._:/-]{1,80}$'),
  import_batch_id uuid,
  row_version integer not null default 1 check (row_version >= 1),
  created_by uuid not null references public.staff_profiles (user_id),
  updated_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint customer_parties_personal_no_gst
    check (party_type = 'business' or (contact_person is null and gst_status is null and gstin is null and gst_reason is null)),
  constraint customer_parties_registered_gstin check (gst_status is distinct from 'registered' or gstin is not null),
  constraint customer_parties_unregistered check (gst_status is distinct from 'unregistered' or (gstin is null and gst_reason is not null)),
  constraint customer_parties_reason_unregistered check (gst_reason is null or gst_status = 'unregistered'),
  constraint customer_parties_returned_reason check ((check_status = 'returned') = (check_reason is not null)),
  constraint customer_parties_checked_by check ((check_status = 'not_checked') = (checked_at is null and checked_by is null))
);
create unique index customer_parties_source_ref_key on public.customer_parties (legal_entity_id, source_ref)
  where source_ref is not null;
create index customer_parties_name_idx on public.customer_parties (legal_entity_id, name_key text_pattern_ops);
create index customer_parties_status_idx on public.customer_parties (legal_entity_id, check_status, updated_at desc);
create index customer_parties_branch_idx on public.customer_parties (branch_id) where branch_id is not null;
create index customer_parties_checked_by_idx on public.customer_parties (checked_by) where checked_by is not null;
create index customer_parties_created_by_idx on public.customer_parties (created_by);
create index customer_parties_updated_by_idx on public.customer_parties (updated_by);
create index customer_parties_import_batch_idx on public.customer_parties (import_batch_id) where import_batch_id is not null;
comment on table public.customer_parties is
  'Voice-note batch: bill-to parties (personal or business) of one legal entity, scoped to a branch or the whole entity. Personal data: readers are Accounts of the entity and active Sales / Manager members of the party''s branch; never Purchase; never Super Admin by role. Accounts check / return with a reason; new and imported parties start not_checked. Selecting a party copies it into the Deal''s customer_billing_profiles (snapshot); later party edits never change that copy. Matching by source reference only. Never deleted. No Data API access.';

create trigger customer_parties_no_delete before delete on public.customer_parties
  for each row execute function authz.vn_no_delete();

create table public.customer_party_documents (
  id uuid primary key default gen_random_uuid(),
  party_id uuid not null references public.customer_parties (id),
  legal_entity_id uuid not null references public.legal_entities (id),
  kind text not null check (kind in ('id_proof', 'gst_certificate', 'other')),
  request_id uuid not null,
  -- The consent tick for an ID file ("Customer agreed to share this ID").
  consent_by uuid references public.staff_profiles (user_id),
  consent_at timestamptz,
  object_path text not null unique,
  file_name text not null check (length(file_name) between 1 and 120 and file_name ~ '^[A-Za-z0-9._ -]+$'),
  mime text not null check (mime in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 4194304),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending_upload' check (status in ('pending_upload', 'stored', 'failed', 'removed')),
  row_version integer not null default 1 check (row_version >= 1),
  uploaded_by uuid not null references public.staff_profiles (user_id),
  removed_by uuid references public.staff_profiles (user_id),
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  stored_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint customer_party_documents_path_check
    check (object_path = legal_entity_id::text || '/' || party_id::text || '/' || id::text),
  constraint customer_party_documents_consent_check
    check (kind <> 'id_proof' or (consent_by is not null and consent_at is not null)),
  constraint customer_party_documents_stored_check check (status <> 'stored' or stored_at is not null),
  constraint customer_party_documents_removed_check check ((status = 'removed') = (removed_at is not null and removed_by is not null)),
  constraint customer_party_documents_request_unique unique (party_id, request_id)
);
create index customer_party_documents_entity_idx on public.customer_party_documents (legal_entity_id);
create index customer_party_documents_uploaded_by_idx on public.customer_party_documents (uploaded_by);
create index customer_party_documents_consent_by_idx on public.customer_party_documents (consent_by) where consent_by is not null;
create index customer_party_documents_removed_by_idx on public.customer_party_documents (removed_by) where removed_by is not null;
comment on table public.customer_party_documents is
  'Voice-note batch: private files of a bill-to party (personal ID with the consent tick, GST certificate, other). Readers and writers follow the party (Accounts of the entity, Sales / Manager of the party''s branch); never Purchase; never Super Admin by role. No typed ID number. Soft removal only; rows and objects kept. No Data API access.';

-- Rows never deleted; identity columns never change; status moves
-- pending_upload -> stored | failed and any open state -> removed (final).
create function authz.customer_party_documents_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'customer party documents are never deleted' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'pending_upload' or new.row_version <> 1 or new.removed_at is not null then
      raise exception 'a customer party document starts as pending_upload' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id or new.party_id is distinct from old.party_id
     or new.legal_entity_id is distinct from old.legal_entity_id or new.kind is distinct from old.kind
     or new.request_id is distinct from old.request_id or new.object_path is distinct from old.object_path
     or new.file_name is distinct from old.file_name or new.mime is distinct from old.mime
     or new.size_bytes is distinct from old.size_bytes or new.sha256 is distinct from old.sha256
     or new.consent_by is distinct from old.consent_by or new.consent_at is distinct from old.consent_at
     or new.uploaded_by is distinct from old.uploaded_by or new.created_at is distinct from old.created_at then
    raise exception 'customer party document identity columns are immutable' using errcode = '42501';
  end if;
  if old.status = 'removed'
     or (new.status is distinct from old.status and not (
           (old.status = 'pending_upload' and new.status in ('stored', 'failed'))
           or new.status = 'removed')) then
    raise exception 'customer party document status change not allowed' using errcode = '42501';
  end if;
  new.row_version := old.row_version + 1;
  new.updated_at := now();
  return new;
end;
$$;
create trigger customer_party_documents_a_guard
  before insert or update or delete on public.customer_party_documents
  for each row execute function authz.customer_party_documents_guard();

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('customer-party-documents', 'customer-party-documents', false, 4194304,
      array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;

alter table public.customer_billing_profiles
  add column party_id uuid references public.customer_parties (id),
  add column party_copied_at timestamptz,
  add constraint customer_billing_profiles_party_pair check ((party_id is null) = (party_copied_at is null));
create index customer_billing_profiles_party_idx on public.customer_billing_profiles (party_id) where party_id is not null;
-- Party history read (customer_party_get).
create index audit_events_party_history_idx on public.audit_events (target_id, occurred_at desc)
  where target_type in ('customer_party', 'customer_party_document');
comment on column public.customer_billing_profiles.party_id is
  'Voice-note batch: the bill-to party this billing was last copied from (reference only). The billing columns are this Deal''s own copy; a later party edit never changes them.';

do $$
declare
  t text;
begin
  foreach t in array array['customer_parties', 'customer_party_documents'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

-- ===========================================================================
-- 2. Field rule (commands and the customer import)
-- ===========================================================================

-- p_fields keys: partyType, name, contactPerson, phone, email, addressLine1,
-- addressLine2, city, stateCode, postalCode, gstStatus, gstin, gstReason,
-- sourceRef (each a string or null). p_require_gst: a business needs a GST
-- status (commands); the import accepts it unknown. A GSTIN with no status
-- reads as registered (a GSTIN is a registration). A one-digit state code is
-- padded ("7" -> "07", as Excel drops the zero). Answers {reasons: [codes],
-- keys: [input keys], values: {...cleaned}, notes: [gst_status_assumed_registered,
-- state_code_padded] (what was assumed; shown per row by the import dry run)}.
create function authz.vn_party_check(p_fields jsonb, p_require_gst boolean) returns jsonb
language plpgsql stable set search_path = '' as $$
declare
  v_r text[] := '{}'::text[];
  v_k text[] := '{}'::text[];
  v_t record;
  v_v jsonb := '{}'::jsonb;
  v_type text;
  v_state text;
  v_gstin text;
  v_status text;
  v_phone text;
  v_notes text[] := '{}'::text[];  -- lead ruling Q8: what the rule assumed
  k text;
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    return jsonb_build_object('reasons', jsonb_build_array('not_text'), 'keys', jsonb_build_array('fields'), 'values', '{}'::jsonb,
      'notes', '[]'::jsonb);
  end if;
  for k in select jsonb_object_keys(p_fields) loop
    if k not in ('partyType', 'name', 'contactPerson', 'phone', 'email', 'addressLine1', 'addressLine2', 'city',
                 'stateCode', 'postalCode', 'gstStatus', 'gstin', 'gstReason', 'sourceRef') then
      v_r := v_r || 'unknown_column'::text; v_k := v_k || k;
    end if;
  end loop;
  -- Echo-A L5: formula text is refused.
  if cardinality(authz.vn_formula_keys(p_fields)) > 0 then
    v_r := v_r || 'formula_text'::text;
    v_k := v_k || authz.vn_formula_keys(p_fields);
  end if;

  select * into v_t from authz.vn_text(p_fields -> 'partyType', 20);
  v_type := lower(v_t.value);
  if not v_t.ok or v_type is null or v_type not in ('personal', 'business') then
    v_r := v_r || 'party_type_invalid'::text; v_k := v_k || 'partyType'::text; v_type := null;
  end if;
  v_v := v_v || jsonb_build_object('partyType', v_type);

  select * into v_t from authz.vn_text(p_fields -> 'name', 200);
  if not v_t.ok then v_r := v_r || 'name_too_long'::text; v_k := v_k || 'name'::text;
  elsif v_t.value is null then v_r := v_r || 'name_missing'::text; v_k := v_k || 'name'::text;
  else v_v := v_v || jsonb_build_object('name', v_t.value); end if;

  select * into v_t from authz.vn_text(p_fields -> 'contactPerson', 120);
  if not v_t.ok then v_r := v_r || 'contact_person_too_long'::text; v_k := v_k || 'contactPerson'::text;
  elsif v_t.value is not null and v_type = 'personal' then
    v_r := v_r || 'contact_person_not_allowed'::text; v_k := v_k || 'contactPerson'::text;
  else v_v := v_v || jsonb_build_object('contactPerson', v_t.value); end if;

  select * into v_t from authz.vn_text(p_fields -> 'phone', 40);
  v_phone := authz.bf_phone(v_t.value);
  if not v_t.ok or (v_t.value is not null and v_phone is null) then
    v_r := v_r || 'phone_invalid'::text; v_k := v_k || 'phone'::text;
  else v_v := v_v || jsonb_build_object('phone', v_phone); end if;

  select * into v_t from authz.vn_text(p_fields -> 'email', 254);
  if not v_t.ok or (v_t.value is not null and lower(v_t.value) !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$') then
    v_r := v_r || 'email_invalid'::text; v_k := v_k || 'email'::text;
  else v_v := v_v || jsonb_build_object('email', lower(v_t.value)); end if;

  select * into v_t from authz.vn_text(p_fields -> 'addressLine1', 200);
  if not v_t.ok then v_r := v_r || 'address_too_long'::text; v_k := v_k || 'addressLine1'::text;
  else v_v := v_v || jsonb_build_object('addressLine1', v_t.value); end if;
  select * into v_t from authz.vn_text(p_fields -> 'addressLine2', 200);
  if not v_t.ok then v_r := v_r || 'address_too_long'::text; v_k := v_k || 'addressLine2'::text;
  else v_v := v_v || jsonb_build_object('addressLine2', v_t.value); end if;
  select * into v_t from authz.vn_text(p_fields -> 'city', 120);
  if not v_t.ok then v_r := v_r || 'city_too_long'::text; v_k := v_k || 'city'::text;
  else v_v := v_v || jsonb_build_object('city', v_t.value); end if;

  select * into v_t from authz.vn_text(p_fields -> 'stateCode', 2);
  v_state := case when v_t.value ~ '^[0-9]$' then '0' || v_t.value else v_t.value end;
  if v_t.value ~ '^[0-9]$' then
    v_notes := v_notes || 'state_code_padded'::text;
  end if;
  if not v_t.ok or (v_state is not null and v_state !~ '^(0[1-9]|[12][0-9]|3[0-8]|97)$') then
    v_r := v_r || 'state_code_invalid'::text; v_k := v_k || 'stateCode'::text; v_state := null;
  else v_v := v_v || jsonb_build_object('stateCode', v_state); end if;

  select * into v_t from authz.vn_text(p_fields -> 'postalCode', 6);
  if not v_t.ok or (v_t.value is not null and v_t.value !~ '^[1-9][0-9]{5}$') then
    v_r := v_r || 'postal_code_invalid'::text; v_k := v_k || 'postalCode'::text;
  else v_v := v_v || jsonb_build_object('postalCode', v_t.value); end if;

  -- GST (business only; the billing rules of authz.bf_bill_to and b11_billing_propose).
  select * into v_t from authz.vn_text(p_fields -> 'gstStatus', 20);
  v_status := lower(v_t.value);
  if not v_t.ok or (v_status is not null and v_status not in ('registered', 'unregistered')) then
    v_r := v_r || 'gst_status_invalid'::text; v_k := v_k || 'gstStatus'::text; v_status := null;
  end if;
  select * into v_t from authz.vn_text(p_fields -> 'gstin', 20);
  v_gstin := upper(replace(v_t.value, ' ', ''));
  if not v_t.ok then
    v_r := v_r || 'gstin_invalid'::text; v_k := v_k || 'gstin'::text; v_gstin := null;
  end if;
  select * into v_t from authz.vn_text(p_fields -> 'gstReason', 500);
  if v_type = 'personal' then
    if v_status is not null or v_gstin is not null or v_t.value is not null then
      v_r := v_r || 'gst_not_allowed'::text; v_k := v_k || 'gstStatus'::text;
    end if;
    v_v := v_v || jsonb_build_object('gstStatus', null, 'gstin', null, 'gstReason', null);
  elsif v_type = 'business' then
    if v_status is null and v_gstin is not null then
      v_status := 'registered';
      v_notes := v_notes || 'gst_status_assumed_registered'::text;
    end if;
    if v_status is null and coalesce(p_require_gst, true) then
      v_r := v_r || 'gst_status_missing'::text; v_k := v_k || 'gstStatus'::text;
    end if;
    if v_status = 'registered' then
      if v_gstin is null then
        v_r := v_r || 'gstin_missing'::text; v_k := v_k || 'gstin'::text;
      elsif v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' then
        v_r := v_r || 'gstin_invalid'::text; v_k := v_k || 'gstin'::text;
      elsif v_state is null then
        v_r := v_r || 'state_code_missing'::text; v_k := v_k || 'stateCode'::text;
      elsif left(v_gstin, 2) <> v_state then
        v_r := v_r || 'gstin_state_mismatch'::text; v_k := v_k || 'gstin'::text;
      end if;
      v_v := v_v || jsonb_build_object('gstStatus', 'registered', 'gstin', v_gstin, 'gstReason', null);
    elsif v_status = 'unregistered' then
      if v_gstin is not null then
        v_r := v_r || 'gstin_not_allowed'::text; v_k := v_k || 'gstin'::text;
      end if;
      if not v_t.ok or (v_t.value is not null and char_length(v_t.value) < 10) then
        v_r := v_r || 'gst_reason_invalid'::text; v_k := v_k || 'gstReason'::text;
      elsif v_t.value is null then
        v_r := v_r || 'gst_reason_missing'::text; v_k := v_k || 'gstReason'::text;
      end if;
      v_v := v_v || jsonb_build_object('gstStatus', 'unregistered', 'gstin', null, 'gstReason', v_t.value);
    else
      v_v := v_v || jsonb_build_object('gstStatus', null, 'gstin', null, 'gstReason', null);
    end if;
  end if;

  select * into v_t from authz.vn_text(p_fields -> 'sourceRef', 80);
  if not v_t.ok or (v_t.value is not null and v_t.value !~ '^[A-Za-z0-9._:/-]{1,80}$') then
    v_r := v_r || 'source_ref_invalid'::text; v_k := v_k || 'sourceRef'::text;
  else v_v := v_v || jsonb_build_object('sourceRef', v_t.value); end if;

  return jsonb_build_object('reasons', to_jsonb(array(select distinct x from unnest(v_r) x order by x)),
    'keys', to_jsonb(array(select distinct x from unnest(v_k) x order by x)), 'values', v_v,
    'notes', to_jsonb(array(select distinct x from unnest(v_notes) x order by x)));
end;
$$;

-- The stored party as field input (for merges: absent key = stored value).
create function authz.vn_party_fields(p public.customer_parties) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('partyType', p.party_type, 'name', p.name, 'contactPerson', p.contact_person,
    'phone', p.phone, 'email', p.email, 'addressLine1', p.address_line1, 'addressLine2', p.address_line2,
    'city', p.city, 'stateCode', p.state_code, 'postalCode', p.postal_code, 'gstStatus', p.gst_status,
    'gstin', p.gstin, 'gstReason', p.gst_reason)
$$;

-- ===========================================================================
-- 3. Access helpers
-- ===========================================================================

-- Accounts of the entity (no Purchase role there).
create function authz.vn_party_accounts(p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and p_entity is not null
    and authz.holds_active_role('accounts', p_entity) and not authz.holds_role('purchase', p_entity)
$$;

-- Active Sales or Manager member of the branch (any branch of the entity
-- when p_branch is null); no Purchase role in the entity.
create function authz.vn_party_sales(p_entity uuid, p_branch uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and p_entity is not null
    and not authz.holds_role('purchase', p_entity)
    and exists (
      select 1 from public.memberships m
      join public.legal_entities e on e.id = m.legal_entity_id
      join public.branches b on b.id = m.branch_id
      where m.user_id = (select auth.uid()) and m.legal_entity_id = p_entity and m.status = 'active'
        and m.role_code in ('sales', 'manager') and e.status = 'enabled' and b.status = 'enabled'
        and (p_branch is null or m.branch_id = p_branch))
$$;

create function authz.vn_party_can_read(p public.customer_parties) returns boolean
language sql stable security definer set search_path = '' as $$
  select p.id is not null and (authz.vn_party_accounts(p.legal_entity_id) or authz.vn_party_sales(p.legal_entity_id, p.branch_id))
$$;

-- Document writers: party editors (Sales / Manager) and Accounts.
create function authz.vn_party_doc_writer(p public.customer_parties) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.vn_party_can_read(p)
$$;

create function authz.vn_party_json(p public.customer_parties) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id', p.id, 'partyType', p.party_type, 'name', p.name, 'contactPerson', p.contact_person,
    'phone', p.phone, 'email', p.email, 'addressLine1', p.address_line1, 'addressLine2', p.address_line2,
    'city', p.city, 'stateCode', p.state_code, 'postalCode', p.postal_code, 'gstStatus', p.gst_status,
    'gstin', p.gstin, 'gstReason', p.gst_reason, 'checkStatus', p.check_status, 'checkReason', p.check_reason,
    'checkedByName', (select s.display_name from public.staff_profiles s where s.user_id = p.checked_by),
    'checkedAt', p.checked_at, 'sourceRef', p.source_ref, 'branchId', p.branch_id,
    'branchName', (select b.name from public.branches b where b.id = p.branch_id),
    'rowVersion', p.row_version,
    'createdByName', (select s.display_name from public.staff_profiles s where s.user_id = p.created_by),
    'createdAt', p.created_at, 'updatedAt', p.updated_at)
$$;

-- ===========================================================================
-- 4. Reads
-- ===========================================================================

-- 2+ characters over the name (prefix first, then contains), the phone digits
-- (4+ digits) or the GSTIN prefix. With p_deal_id: the caller must edit or
-- accept that Deal's booking; parties of the Deal's entity in its branch or
-- entity-wide. Without: every party the caller may read.
create function public.customer_party_search(p_query text, p_deal_id uuid default null, p_limit integer default 20,
  p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_q text := lower(btrim(coalesce(p_query, '')));
  v_like text;
  v_digits text;
  v_gst text;
  v_limit integer := least(greatest(coalesce(p_limit, 20), 1), 50);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 1000);
  v_rows jsonb;
  v_n integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_deal_id is not null then
    select * into v_deal from public.deals d where d.id = p_deal_id;
    if v_deal.id is null or v_deal.removed_at is not null
       or not (authz.can_edit_booking_draft(p_deal_id) or authz.can_confirm_booking(p_deal_id))
       or authz.holds_role('purchase', v_deal.legal_entity_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
  end if;
  if char_length(v_q) < 2 or char_length(v_q) > 100 then
    return jsonb_build_object('items', '[]'::jsonb, 'hasMore', false);
  end if;
  v_like := authz.vn_like_escape(v_q);
  v_digits := regexp_replace(v_q, '[^0-9]', '', 'g');
  v_digits := case when char_length(v_digits) >= 4 then v_digits end;
  v_gst := case when upper(v_q) ~ '^[0-9]{2}[A-Z0-9]{0,13}$' then upper(v_q) end;
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'partyType', x.party_type, 'name', x.name, 'city', x.city,
           'stateCode', x.state_code, 'gstin', x.gstin, 'checkStatus', x.check_status,
           'branchName', (select b.name from public.branches b where b.id = x.branch_id))
           order by x.prefix desc, x.name_key, x.id), '[]'::jsonb), count(*)::integer
  into v_rows, v_n
  from (
    select p.*, (p.name_key like v_like || '%') as prefix
    from public.customer_parties p
    where (case when v_deal.id is not null
                then p.legal_entity_id = v_deal.legal_entity_id and (p.branch_id is null or p.branch_id = v_deal.branch_id)
                else authz.vn_party_can_read(p) end)
      and (p.name_key like '%' || v_like || '%'
           or (v_digits is not null and p.phone_digits like '%' || v_digits || '%')
           or (v_gst is not null and p.gstin like v_gst || '%'))
    order by (p.name_key like v_like || '%') desc, p.name_key, p.id
    limit v_limit + 1 offset v_offset
  ) x;
  return jsonb_build_object('items', case when v_n > v_limit then v_rows - v_limit else v_rows end,
    'hasMore', v_n > v_limit);
end;
$$;

-- One party with its documents (metadata only) and what the caller may do;
-- null when the caller may not read it.
create function public.customer_party_get(p_party_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.customer_parties%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v from public.customer_parties p where p.id = p_party_id;
  if v.id is null or not authz.vn_party_can_read(v) then
    return null;
  end if;
  return authz.vn_party_json(v) || jsonb_build_object(
    'documents', coalesce((
      select jsonb_agg(jsonb_build_object('id', d.id, 'kind', d.kind, 'fileName', d.file_name, 'mime', d.mime,
          'sizeBytes', d.size_bytes, 'status', d.status, 'rowVersion', d.row_version, 'createdAt', d.created_at,
          'uploadedByYou', d.uploaded_by = (select auth.uid()))
        order by d.created_at, d.id)
      from public.customer_party_documents d where d.party_id = v.id and d.status <> 'removed'), '[]'::jsonb),
    -- History of the party and its documents (names of actions, fields and
    -- reasons; never values), newest first, at most 50.
    'history', coalesce((
      select jsonb_agg(jsonb_build_object('action', a.action, 'at', a.occurred_at,
          'byName', (select s.display_name from public.staff_profiles s where s.user_id = a.actor_user_id),
          'byYou', a.actor_user_id is not null and a.actor_user_id = (select auth.uid()),
          'reason', a.reason,
          'changedFields', coalesce(a.details -> 'changedFields', a.details -> 'fields', '[]'::jsonb),
          'previousStatus', a.details -> 'previousStatus')
        order by a.occurred_at desc, a.id desc)
      from (select x.* from public.audit_events x
            where x.target_type in ('customer_party', 'customer_party_document')
              and (x.target_id = v.id
                   or x.target_id in (select d.id from public.customer_party_documents d where d.party_id = v.id))
            order by x.occurred_at desc, x.id desc limit 50) a), '[]'::jsonb),
    -- Deals whose billing was copied from this party and that the caller may
    -- open (reference, title, branch; no money).
    'usedOn', coalesce((
      select jsonb_agg(jsonb_build_object('dealId', d.id, 'reference', d.reference, 'title', d.title,
          'branchName', (select b.name from public.branches b where b.id = d.branch_id), 'copiedAt', bp.party_copied_at)
        order by bp.party_copied_at desc, d.id)
      from public.customer_billing_profiles bp join public.deals d on d.id = bp.deal_id
      where bp.party_id = v.id and d.removed_at is null
        and (authz.can_read_deal(d.id) or authz.accounts_sees_deal(d.id))), '[]'::jsonb),
    'canEdit', authz.vn_party_sales(v.legal_entity_id, v.branch_id) and v.check_status <> 'checked',
    'canAccountsEdit', authz.vn_party_accounts(v.legal_entity_id),
    'canCheck', authz.vn_party_accounts(v.legal_entity_id));
end;
$$;

-- Accounts list by check state (every entity where the caller is Accounts).
create function public.customer_party_accounts_list(p_status text default 'not_checked', p_limit integer default 50,
  p_offset integer default 0) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_entities uuid[];
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_offset integer := least(greatest(coalesce(p_offset, 0), 0), 10000);
  v_rows jsonb;
  v_n integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select coalesce(array_agg(e), '{}') into v_entities
  from unnest(authz.vn_member_entities()) e where authz.vn_party_accounts(e);
  if cardinality(v_entities) = 0 then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_status is not null and p_status not in ('not_checked', 'checked', 'returned') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'status';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', x.id, 'partyType', x.party_type, 'name', x.name, 'city', x.city,
           'gstin', x.gstin, 'checkStatus', x.check_status,
           'branchName', (select b.name from public.branches b where b.id = x.branch_id),
           'createdByName', (select s.display_name from public.staff_profiles s where s.user_id = x.created_by),
           'createdAt', x.created_at, 'updatedAt', x.updated_at)
           order by x.updated_at desc, x.id), '[]'::jsonb), count(*)::integer
  into v_rows, v_n
  from (
    select p.* from public.customer_parties p
    where p.legal_entity_id = any (v_entities) and (p_status is null or p.check_status = p_status)
    order by p.updated_at desc, p.id
    limit v_limit + 1 offset v_offset
  ) x;
  return jsonb_build_object('items', case when v_n > v_limit then v_rows - v_limit else v_rows end,
    'hasMore', v_n > v_limit);
end;
$$;

-- ===========================================================================
-- 5. Party commands
-- ===========================================================================

-- A booking editor of the Deal creates a party in the Deal's entity and
-- branch (never checked). Idempotent by request id.
create function public.customer_party_create(p_deal_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id, 'fields', p_fields);
  v_result jsonb;
  v_chk jsonb;
  v_v jsonb;
  v_id uuid;
begin
  perform authz.refuse_removed_deal(p_deal_id);
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null or not authz.can_edit_booking_draft(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'customer_party_create', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' or p_fields ? 'sourceRef' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_chk := authz.vn_party_check(p_fields, true);
  if jsonb_array_length(v_chk -> 'keys') > 0 then
    raise exception 'invalid_input' using errcode = '22023',
      hint = array_to_string(array(select jsonb_array_elements_text(v_chk -> 'keys')), ',');
  end if;
  v_v := v_chk -> 'values';
  insert into public.customer_parties (legal_entity_id, branch_id, party_type, name, contact_person, phone, email,
    address_line1, address_line2, city, state_code, postal_code, gst_status, gstin, gst_reason, created_by, updated_by)
  values (v_deal.legal_entity_id, v_deal.branch_id, v_v ->> 'partyType', v_v ->> 'name', v_v ->> 'contactPerson',
    v_v ->> 'phone', v_v ->> 'email', v_v ->> 'addressLine1', v_v ->> 'addressLine2', v_v ->> 'city',
    v_v ->> 'stateCode', v_v ->> 'postalCode', v_v ->> 'gstStatus', v_v ->> 'gstin', v_v ->> 'gstReason',
    (select auth.uid()), (select auth.uid()))
  returning id into v_id;
  v_result := jsonb_build_object('partyId', v_id, 'rowVersion', 1, 'checkStatus', 'not_checked', 'outcome', 'created');
  perform authz.finance_remember(v_deal.legal_entity_id, p_request_id, 'customer_party_create', v_payload, v_result);
  -- Field names only (personal data stays out of the audit).
  perform authz.write_audit('party.created', v_deal.legal_entity_id, v_deal.branch_id, 'customer_party', v_id, null,
    jsonb_build_object('dealId', v_deal.id, 'partyType', v_v ->> 'partyType',
      'fields', to_jsonb(array(select k from jsonb_object_keys(p_fields) k order by k))));
  return v_result;
end;
$$;

-- Changed field names between the stored party and new values.
create function authz.vn_party_changed(p public.customer_parties, p_v jsonb) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(k order by k), '{}')
  from jsonb_each(authz.vn_party_fields(p)) s(k, old_value)
  where coalesce(p_v -> k, 'null'::jsonb) is distinct from s.old_value
$$;

-- Sales / Manager edit (absent key = stored value). Refused on a checked
-- party (party_checked); a returned party goes back to not_checked.
create function public.customer_party_save(p_party_id uuid, p_expected_row_version integer, p_fields jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_old public.customer_parties%rowtype;
  v_chk jsonb;
  v_v jsonb;
  v_changed text[];
  v_row integer;
begin
  select * into v_old from public.customer_parties p where p.id = p_party_id for update;
  if v_old.id is null or not authz.vn_party_sales(v_old.legal_entity_id, v_old.branch_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_old.row_version);
  if v_old.check_status = 'checked' then
    raise exception 'party_checked' using errcode = '55000';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' or p_fields ? 'sourceRef' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_chk := authz.vn_party_check(authz.vn_party_fields(v_old) || p_fields, true);
  if jsonb_array_length(v_chk -> 'keys') > 0 then
    raise exception 'invalid_input' using errcode = '22023',
      hint = array_to_string(array(select jsonb_array_elements_text(v_chk -> 'keys')), ',');
  end if;
  v_v := v_chk -> 'values';
  v_changed := authz.vn_party_changed(v_old, v_v);
  if cardinality(v_changed) = 0 then
    return jsonb_build_object('rowVersion', v_old.row_version, 'checkStatus', v_old.check_status, 'outcome', 'unchanged');
  end if;
  update public.customer_parties p
  set party_type = v_v ->> 'partyType', name = v_v ->> 'name', contact_person = v_v ->> 'contactPerson',
      phone = v_v ->> 'phone', email = v_v ->> 'email', address_line1 = v_v ->> 'addressLine1',
      address_line2 = v_v ->> 'addressLine2', city = v_v ->> 'city', state_code = v_v ->> 'stateCode',
      postal_code = v_v ->> 'postalCode', gst_status = v_v ->> 'gstStatus', gstin = v_v ->> 'gstin',
      gst_reason = v_v ->> 'gstReason',
      check_status = 'not_checked', check_reason = null, checked_by = null, checked_at = null,
      row_version = p.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
  where p.id = v_old.id
  returning row_version into v_row;
  perform authz.write_audit('party.updated', v_old.legal_entity_id, v_old.branch_id, 'customer_party', v_old.id, null,
    jsonb_build_object('changedFields', to_jsonb(v_changed), 'previousStatus', v_old.check_status, 'rowVersion', v_row));
  return jsonb_build_object('rowVersion', v_row, 'checkStatus', 'not_checked', 'outcome', 'updated');
end;
$$;

-- Accounts edit (absent key = stored value); the party goes back to
-- not_checked (checking is a separate step; the same person may do both).
create function public.customer_party_accounts_save(p_party_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_old public.customer_parties%rowtype;
  v_chk jsonb;
  v_v jsonb;
  v_changed text[];
  v_row integer;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
begin
  select * into v_old from public.customer_parties p where p.id = p_party_id for update;
  if v_old.id is null or not authz.vn_party_accounts(v_old.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_old.row_version);
  if v_reason is not null and (char_length(v_reason) > 500 or v_reason ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' or p_fields ? 'sourceRef' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_chk := authz.vn_party_check(authz.vn_party_fields(v_old) || p_fields, true);
  if jsonb_array_length(v_chk -> 'keys') > 0 then
    raise exception 'invalid_input' using errcode = '22023',
      hint = array_to_string(array(select jsonb_array_elements_text(v_chk -> 'keys')), ',');
  end if;
  v_v := v_chk -> 'values';
  v_changed := authz.vn_party_changed(v_old, v_v);
  if cardinality(v_changed) = 0 then
    return jsonb_build_object('rowVersion', v_old.row_version, 'checkStatus', v_old.check_status, 'outcome', 'unchanged');
  end if;
  update public.customer_parties p
  set party_type = v_v ->> 'partyType', name = v_v ->> 'name', contact_person = v_v ->> 'contactPerson',
      phone = v_v ->> 'phone', email = v_v ->> 'email', address_line1 = v_v ->> 'addressLine1',
      address_line2 = v_v ->> 'addressLine2', city = v_v ->> 'city', state_code = v_v ->> 'stateCode',
      postal_code = v_v ->> 'postalCode', gst_status = v_v ->> 'gstStatus', gstin = v_v ->> 'gstin',
      gst_reason = v_v ->> 'gstReason',
      check_status = 'not_checked', check_reason = null, checked_by = null, checked_at = null,
      row_version = p.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
  where p.id = v_old.id
  returning row_version into v_row;
  perform authz.write_audit('party.accounts_updated', v_old.legal_entity_id, v_old.branch_id, 'customer_party', v_old.id,
    v_reason, jsonb_build_object('changedFields', to_jsonb(v_changed), 'previousStatus', v_old.check_status,
      'rowVersion', v_row));
  return jsonb_build_object('rowVersion', v_row, 'checkStatus', 'not_checked', 'outcome', 'updated');
end;
$$;

-- Accounts: checked (the party must pass the full field rule) or returned
-- with a reason of 10-500 characters. Audited with the reason.
create function public.customer_party_check(p_party_id uuid, p_expected_row_version integer, p_decision text,
  p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_old public.customer_parties%rowtype;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_chk jsonb;
  v_row integer;
begin
  select * into v_old from public.customer_parties p where p.id = p_party_id for update;
  if v_old.id is null or not authz.vn_party_accounts(v_old.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_old.row_version);
  if p_decision is null or p_decision not in ('checked', 'returned') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'decision';
  end if;
  if v_reason is not null and (char_length(v_reason) not between 10 and 500
                               or v_reason ~ '[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  if p_decision = 'returned' and v_reason is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  if p_decision = 'checked' then
    v_chk := authz.vn_party_check(authz.vn_party_fields(v_old), true);
    if jsonb_array_length(v_chk -> 'keys') > 0 then
      raise exception 'party_incomplete' using errcode = '22023',
        hint = array_to_string(array(select jsonb_array_elements_text(v_chk -> 'keys')), ',');
    end if;
  end if;
  if v_old.check_status = p_decision and (p_decision = 'checked' or v_old.check_reason is not distinct from v_reason) then
    return jsonb_build_object('rowVersion', v_old.row_version, 'checkStatus', v_old.check_status, 'outcome', 'unchanged');
  end if;
  update public.customer_parties p
  set check_status = p_decision, check_reason = case when p_decision = 'returned' then v_reason end,
      checked_by = (select auth.uid()), checked_at = now(),
      row_version = p.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
  where p.id = v_old.id
  returning row_version into v_row;
  perform authz.write_audit(case when p_decision = 'checked' then 'party.checked' else 'party.returned' end,
    v_old.legal_entity_id, v_old.branch_id, 'customer_party', v_old.id, v_reason,
    jsonb_build_object('previousStatus', v_old.check_status, 'rowVersion', v_row));
  return jsonb_build_object('rowVersion', v_row, 'checkStatus', p_decision, 'outcome', 'updated');
end;
$$;

-- ===========================================================================
-- 6. Select a party into a booking's Bill To
-- ===========================================================================

-- Copies the party into the Deal's customer_billing_profiles through
-- authz.b11_billing_propose (the booking_customer_save billing rules: Sales
-- never verifies; a verified profile refuses billing_verified) and records
-- the party reference. The billing row is this Deal's own copy. Idempotent by
-- request id (finance_command_results).
create function public.booking_bill_to_select_party(p_version_id uuid, p_expected_row_version integer, p_party_id uuid,
  p_billing_expected_row_version integer, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_deal public.deals%rowtype;
  v_party public.customer_parties%rowtype;
  v_payload jsonb := jsonb_build_object('versionId', p_version_id, 'expectedRowVersion', p_expected_row_version,
    'partyId', p_party_id, 'billingExpectedRowVersion', p_billing_expected_row_version);
  v_result jsonb;
  v_missing text[];
  v_billing jsonb;
begin
  v_ver := authz.lock_package_draft(p_version_id);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_ver.legal_entity_id, p_request_id, 'booking_bill_to_select_party', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  select * into v_deal from public.deals d where d.id = v_ver.deal_id;
  select * into v_party from public.customer_parties p where p.id = p_party_id for share;
  if v_party.id is null or v_party.legal_entity_id <> v_deal.legal_entity_id
     or (v_party.branch_id is not null and v_party.branch_id <> v_deal.branch_id)
     or authz.holds_role('purchase', v_deal.legal_entity_id) then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_party.check_status = 'returned' then
    raise exception 'party_returned' using errcode = '55000';
  end if;
  v_missing := array_remove(array[
    case when v_party.address_line1 is null then 'addressLine1' end,
    case when v_party.city is null then 'city' end,
    case when v_party.state_code is null then 'stateCode' end,
    case when v_party.postal_code is null then 'postalCode' end,
    case when v_party.party_type = 'business' and v_party.gst_status is null then 'gstStatus' end], null);
  if cardinality(v_missing) > 0 then
    raise exception 'party_incomplete' using errcode = '22023', hint = array_to_string(v_missing, ',');
  end if;

  v_billing := authz.b11_billing_propose(v_deal.id, p_billing_expected_row_version, jsonb_build_object(
      'billingName', v_party.name, 'addressLine1', v_party.address_line1, 'addressLine2', v_party.address_line2,
      'city', v_party.city, 'stateCode', v_party.state_code, 'postalCode', v_party.postal_code, 'gstin', v_party.gstin,
      'billToType', v_party.party_type, 'contactPerson', v_party.contact_person, 'phone', v_party.phone,
      'email', v_party.email, 'gstStatus', v_party.gst_status, 'gstReason', v_party.gst_reason),
    md5(p_request_id::text || ':billing')::uuid);
  update public.customer_billing_profiles b set party_id = v_party.id, party_copied_at = now()
  where b.deal_id = v_deal.id;
  v_ver := authz.bump_package_version(v_ver.id);
  v_result := jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash,
    'partyId', v_party.id, 'billing', jsonb_build_object('outcome', v_billing ->> 'outcome',
      'status', v_billing ->> 'status', 'rowVersion', (v_billing ->> 'rowVersion')::integer));
  perform authz.finance_remember(v_ver.legal_entity_id, p_request_id, 'booking_bill_to_select_party', v_payload, v_result);
  perform authz.write_audit('booking.bill_to_party_selected', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version',
    v_ver.id, null, jsonb_build_object('dealId', v_deal.id, 'partyId', v_party.id,
      'partyCheckStatus', v_party.check_status, 'billingRowVersion', (v_billing ->> 'rowVersion')::integer,
      'rowVersion', v_ver.row_version));
  return v_result;
end;
$$;

-- ===========================================================================
-- 7. Party documents (the traveller_id_proofs pattern)
-- ===========================================================================

create function public.customer_party_document_begin(p_party_id uuid, p_kind text, p_request_id uuid, p_consent boolean,
  p_file_name text, p_mime text, p_size_bytes integer, p_sha256 text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_party public.customer_parties%rowtype;
  v_existing public.customer_party_documents%rowtype;
  v_name text := btrim(left(btrim(regexp_replace(coalesce(p_file_name, ''), '[^A-Za-z0-9._ -]', '_', 'g')), 120));
  v_sha text := lower(btrim(coalesce(p_sha256, '')));
  v_id uuid := gen_random_uuid();
  v_path text;
begin
  select * into v_party from public.customer_parties p where p.id = p_party_id for no key update;
  if v_party.id is null or not authz.vn_party_doc_writer(v_party) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if p_kind is null or p_kind not in (case when v_party.party_type = 'personal' then 'id_proof' else 'gst_certificate' end, 'other') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  if p_kind = 'id_proof' and p_consent is distinct from true then
    raise exception 'consent_required' using errcode = '22023';
  end if;
  select * into v_existing from public.customer_party_documents f where f.party_id = p_party_id and f.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.uploaded_by is distinct from (select auth.uid()) or v_existing.kind is distinct from p_kind
       or v_existing.file_name is distinct from v_name or v_existing.mime is distinct from p_mime
       or v_existing.size_bytes is distinct from p_size_bytes or v_existing.sha256 is distinct from v_sha then
      raise exception 'request_conflict' using errcode = '40001';
    end if;
    return jsonb_build_object('fileId', v_existing.id, 'outcome', 'existing', 'status', v_existing.status,
      'rowVersion', v_existing.row_version,
      'objectPath', case when v_existing.status = 'pending_upload' then v_existing.object_path end);
  end if;
  if v_name = '' or v_name ~ '^[. ]+$'
     or p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > 4194304
     or v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  if (select count(*) from public.customer_party_documents f
      where f.party_id = v_party.id and f.status in ('pending_upload', 'stored')) >= 6 then
    raise exception 'party_doc_limit' using errcode = '55000';
  end if;
  v_path := v_party.legal_entity_id::text || '/' || v_party.id::text || '/' || v_id::text;
  insert into public.customer_party_documents (id, party_id, legal_entity_id, kind, request_id, consent_by, consent_at,
    object_path, file_name, mime, size_bytes, sha256, uploaded_by)
  values (v_id, v_party.id, v_party.legal_entity_id, p_kind, p_request_id,
    case when p_kind = 'id_proof' then (select auth.uid()) end, case when p_kind = 'id_proof' then now() end,
    v_path, v_name, p_mime, p_size_bytes, v_sha, (select auth.uid()));
  -- No file name in the audit record (it may carry a person's name).
  perform authz.write_audit('party.document_started', v_party.legal_entity_id, v_party.branch_id,
    'customer_party_document', v_id, null,
    jsonb_build_object('partyId', v_party.id, 'kind', p_kind, 'mime', p_mime, 'sizeBytes', p_size_bytes,
      'consent', p_kind = 'id_proof'));
  return jsonb_build_object('fileId', v_id, 'outcome', 'created', 'status', 'pending_upload', 'rowVersion', 1,
    'objectPath', v_path);
end;
$$;

create function public.customer_party_document_finish(p_file_id uuid, p_ok boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_file public.customer_party_documents%rowtype;
  v_party public.customer_parties%rowtype;
  v_status text;
  v_missing boolean := false;
begin
  select * into v_party from public.customer_parties p
  where p.id = (select f.party_id from public.customer_party_documents f where f.id = p_file_id) for no key update;
  select * into v_file from public.customer_party_documents f where f.id = p_file_id for update;
  if v_file.id is null or v_file.uploaded_by is distinct from (select auth.uid()) or not authz.vn_party_doc_writer(v_party) then
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
       where o.bucket_id = 'customer-party-documents' and o.name = v_file.object_path
         and (o.metadata ->> 'size') ~ '^[0-9]{1,18}$'
         and (o.metadata ->> 'size')::bigint = v_file.size_bytes)) then
    v_status := 'failed';
    v_missing := true;
  end if;
  update public.customer_party_documents f
  set status = v_status, stored_at = case when v_status = 'stored' then now() else null end
  where f.id = v_file.id
  returning * into v_file;
  perform authz.write_audit(case when v_status = 'stored' then 'party.document_stored' else 'party.document_failed' end,
    v_party.legal_entity_id, v_party.branch_id, 'customer_party_document', v_file.id, null,
    jsonb_build_object('partyId', v_party.id, 'objectMissing', v_missing));
  -- Lead ruling Q10: a new document on a checked party sends it back to
  -- Accounts (not_checked, audited). Deal billing copies are not touched.
  if v_status = 'stored' and v_party.check_status = 'checked' then
    update public.customer_parties p
    set check_status = 'not_checked', check_reason = null, checked_by = null, checked_at = null,
        row_version = p.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
    where p.id = v_party.id;
    perform authz.write_audit('party.check_reset', v_party.legal_entity_id, v_party.branch_id, 'customer_party', v_party.id,
      null, jsonb_build_object('cause', 'document_added', 'fileId', v_file.id, 'kind', v_file.kind,
        'previousStatus', 'checked'));
  end if;
  return jsonb_build_object('fileId', v_file.id, 'status', v_status, 'rowVersion', v_file.row_version);
end;
$$;

create function public.customer_party_document_remove(p_file_id uuid, p_expected_row_version integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_file public.customer_party_documents%rowtype;
  v_party public.customer_parties%rowtype;
  v_previous text;
begin
  select * into v_party from public.customer_parties p
  where p.id = (select f.party_id from public.customer_party_documents f where f.id = p_file_id) for no key update;
  select * into v_file from public.customer_party_documents f where f.id = p_file_id for update;
  if v_file.id is null or not authz.vn_party_doc_writer(v_party) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_file.status = 'removed' then
    return jsonb_build_object('fileId', v_file.id, 'status', 'removed', 'rowVersion', v_file.row_version);
  end if;
  perform authz.require_row_version(p_expected_row_version, v_file.row_version);
  v_previous := v_file.status;
  update public.customer_party_documents f
  set status = 'removed', removed_at = now(), removed_by = (select auth.uid())
  where f.id = v_file.id
  returning * into v_file;
  perform authz.write_audit('party.document_removed', v_party.legal_entity_id, v_party.branch_id,
    'customer_party_document', v_file.id, null, jsonb_build_object('partyId', v_party.id, 'previousStatus', v_previous));
  -- Echo-A L7: removing a stored document from a checked party sends it back
  -- to Accounts too (Accounts may have relied on it). Deal billing copies are not touched.
  if v_previous = 'stored' and v_party.check_status = 'checked' then
    update public.customer_parties p
    set check_status = 'not_checked', check_reason = null, checked_by = null, checked_at = null,
        row_version = p.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
    where p.id = v_party.id;
    perform authz.write_audit('party.check_reset', v_party.legal_entity_id, v_party.branch_id, 'customer_party', v_party.id,
      null, jsonb_build_object('cause', 'document_removed', 'fileId', v_file.id, 'kind', v_file.kind,
        'previousStatus', 'checked'));
  end if;
  return jsonb_build_object('fileId', v_file.id, 'status', 'removed', 'rowVersion', v_file.row_version);
end;
$$;

-- Authorizes one download (the server then signs a short URL). Party readers
-- only; every view audited with the viewer's role.
create function public.customer_party_document_authorize_download(p_file_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_file public.customer_party_documents%rowtype;
  v_party public.customer_parties%rowtype;
begin
  select * into v_file from public.customer_party_documents f where f.id = p_file_id;
  select * into v_party from public.customer_parties p where p.id = v_file.party_id;
  if v_file.id is null or not authz.vn_party_can_read(v_party) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_file.status <> 'stored' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.write_audit('party.document_viewed', v_party.legal_entity_id, v_party.branch_id,
    'customer_party_document', v_file.id, null,
    jsonb_build_object('partyId', v_party.id, 'kind', v_file.kind,
      'viewerRole', case when authz.vn_party_accounts(v_party.legal_entity_id) then 'accounts' else 'sales' end));
  return jsonb_build_object('objectPath', v_file.object_path, 'fileName', v_file.file_name, 'mime', v_file.mime);
end;
$$;

-- ===========================================================================
-- 8. Book now read (replaces 20261124000120; lines marked VN): party.adults,
--    travellers[].specialRequests, identity.extraPhones and tripFacts
--    (20261128000110), billing.partyId and billing.partyCheckStatus
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
  -- VN: trip facts from Bitrix and their source per field.
  v_result := v_result || jsonb_build_object('tripFacts', authz.vn_trip_facts_json(p_deal_id, v_ver.id));
  return v_result;
end;
$$;

-- ===========================================================================
-- 9. Privileges
-- ===========================================================================

revoke all on function authz.customer_party_documents_guard(), authz.vn_party_check(jsonb, boolean),
  authz.vn_party_fields(public.customer_parties), authz.vn_party_accounts(uuid), authz.vn_party_sales(uuid, uuid),
  authz.vn_party_can_read(public.customer_parties), authz.vn_party_doc_writer(public.customer_parties),
  authz.vn_party_json(public.customer_parties), authz.vn_party_changed(public.customer_parties, jsonb)
from public, anon, authenticated, service_role;

revoke all on function public.customer_party_search(text, uuid, integer, integer), public.customer_party_get(uuid),
  public.customer_party_accounts_list(text, integer, integer), public.customer_party_create(uuid, jsonb, uuid),
  public.customer_party_save(uuid, integer, jsonb), public.customer_party_accounts_save(uuid, integer, jsonb, text),
  public.customer_party_check(uuid, integer, text, text),
  public.booking_bill_to_select_party(uuid, integer, uuid, integer, uuid),
  public.customer_party_document_begin(uuid, text, uuid, boolean, text, text, integer, text),
  public.customer_party_document_finish(uuid, boolean), public.customer_party_document_remove(uuid, integer),
  public.customer_party_document_authorize_download(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.customer_party_search(text, uuid, integer, integer), public.customer_party_get(uuid),
  public.customer_party_accounts_list(text, integer, integer), public.customer_party_create(uuid, jsonb, uuid),
  public.customer_party_save(uuid, integer, jsonb), public.customer_party_accounts_save(uuid, integer, jsonb, text),
  public.customer_party_check(uuid, integer, text, text),
  public.booking_bill_to_select_party(uuid, integer, uuid, integer, uuid),
  public.customer_party_document_begin(uuid, text, uuid, boolean, text, text, integer, text),
  public.customer_party_document_finish(uuid, boolean), public.customer_party_document_remove(uuid, integer),
  public.customer_party_document_authorize_download(uuid)
to authenticated;

commit;
