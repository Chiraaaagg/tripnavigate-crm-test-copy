-- TripNavigate CRM - B1.2 Phase E: quotations (header, versions, states,
-- acceptance, Lead -> Deal link, conversion into the booking draft).
--
-- Freeze: docs/implementation/frontend-first-plan-2026-10-10/b1.2/
--   b1.2-freeze-note-part-2.md sections 1 and 2 (DEC-35, DEC-37, Q-E2..Q-E6);
--   shapes for Mercury/Terra/Luna in the Atlas notes (atlas-b12-0200-shapes).
--
-- What changes:
--   * Tables quotation_counters, quotations, quotation_versions,
--     quotation_version_tiers (labels only), quotation_version_items (same
--     fact keys as booking items), quotation_version_contacts,
--     quotation_evidence (private bucket quotation-evidence),
--     quotation_conversions, quotation_conversion_items. RLS on, no permissive
--     policy, no privilege: definer commands and reads only. Nobody but the
--     quotation's editors reads it (Lead/Deal Sales owner or assignee, branch
--     Manager); never Purchase, Flight, the desk, Accounts or Super Admin.
--   * States draft -> ready -> sent -> accepted | declined | expired |
--     superseded; draft/ready -> discarded. One working, one sent and one
--     accepted version per quotation; a sent version never changes. Validity
--     defaults to IST today + 7 days, editable until sent; expiry is computed
--     on every read and persisted by the next command (no scheduled job).
--   * Acceptance needs the customer's written acceptance stored against that
--     exact version, the version's content hash and the accepted tier. One
--     accepted quotation per Deal.
--   * Lead quotations link to the Deal Sales created in Bitrix only when the
--     Deal's stored Bitrix Lead id and portal match (deal_not_from_lead) and the
--     branch matches (branch_mismatch). The CRM never converts a Lead.
--   * quotation_convert_to_booking: one transaction, idempotent per accepted
--     version; copies trip, contacts (unconfirmed), service items of the
--     accepted tier and, through Mercury's helper, the money. Traveller names
--     are never invented. booking_versions gains source_quotation_version_id,
--     source_quotation_hash and source_accepted_tier (not hashed).
--   * Hotel facts gain optional extraBeds, childrenWithoutBed and bedRemarks
--     (authz.validate_service_facts, copy of 20261119000100; bedRemarks is a
--     "choice" revision field: authz.revision_field_class, copy of
--     20261119000300).
--   * booking_form_get (copy of 20261120000100) adds sourceQuotation.
--   * Readiness (authz.booking_issues and intake_checklist, copies of
--     20261120000100): a draft converted from an accepted quotation needs no
--     separate acceptance message; quote_acceptance_stale (blocking) when its
--     money or material facts changed since conversion without a new
--     acceptance message on the booking; quote_details_changed (warning) for
--     extra beds, children without a bed, bed remarks and meal plan.
--   * Mercury's money helpers ship as stubs (same names and parameter names;
--     20261120000300 replaces them): authz.quotation_money_check,
--     authz.quotation_money_hash, authz.quotation_money_json,
--     authz.quotation_copy_lines, authz.quotation_money_to_booking,
--     authz.quotation_money_can_read, authz.quotation_money_can_edit.
--
-- Refusal tokens added (message is exactly the token):
--   55000 quotation_expired, acceptance_proof_required,
--         quotation_already_accepted, quotation_converted, deal_link_required,
--         draft_not_empty, deal_already_linked, quotation_already_linked
--   22023 valid_until_past, deal_not_from_lead, branch_mismatch
--   Existing tokens keep their SQLSTATEs (not_authorized, wrong_state,
--   not_ready, version_changed, version_superseded, request_conflict, ...).
--
-- Any later migration that replaces authz.booking_issues, intake_checklist,
-- authz.validate_service_facts or authz.revision_field_class must copy the
-- bodies in THIS file.
--
-- Rollback (forward-only): a NEW migration revokes execute on the quotation
-- commands and reads and restores the four replaced functions from
-- 20261120000100 / 20261119000100 / 20261119000300. Rows and files are kept.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Tables
-- ===========================================================================

create table public.quotation_counters (
  legal_entity_id uuid primary key references public.legal_entities (id),
  last_no integer not null default 0 check (last_no >= 0)
);

create table public.quotations (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  quote_no integer not null check (quote_no >= 1),
  reference text not null,
  lead_id uuid references public.crm_leads (id),
  deal_id uuid,
  title text not null check (length(title) between 1 and 200),
  owner_user_id uuid references public.staff_profiles (user_id),
  linked_deal_id uuid,
  linked_by uuid references public.staff_profiles (user_id),
  linked_at timestamptz,
  accepted_version_id uuid,
  converted_at timestamptz,
  request_id uuid not null,
  row_version integer not null default 1 check (row_version >= 1),
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, branch_id) references public.branches (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  foreign key (legal_entity_id, linked_deal_id) references public.deals (legal_entity_id, id),
  unique (legal_entity_id, id),
  constraint quotations_number_unique unique (legal_entity_id, quote_no),
  constraint quotations_request_unique unique (created_by, request_id),
  constraint quotations_reference_check check (reference = 'TQ-' || quote_no::text),
  constraint quotations_subject_check check (num_nonnulls(lead_id, deal_id) = 1),
  constraint quotations_link_lead_only check (linked_deal_id is null or lead_id is not null),
  constraint quotations_link_complete check ((linked_deal_id is null) = (linked_at is null) and (linked_at is null) = (linked_by is null))
);
create index quotations_lead_idx on public.quotations (lead_id) where lead_id is not null;
create index quotations_deal_idx on public.quotations (deal_id) where deal_id is not null;
create unique index quotations_linked_deal_unique on public.quotations (linked_deal_id) where linked_deal_id is not null;
create index quotations_branch_idx on public.quotations (legal_entity_id, branch_id);
create index quotations_owner_idx on public.quotations (owner_user_id) where owner_user_id is not null;
create index quotations_linked_by_idx on public.quotations (linked_by) where linked_by is not null;
create index quotations_accepted_version_idx on public.quotations (accepted_version_id) where accepted_version_id is not null;
comment on table public.quotations is
  'Quotation header on an imported Lead or an eligible Deal (B1.2). Editors only (Lead/Deal Sales owner or assignee, branch Manager); no Data API read.';

create table public.quotation_versions (
  id uuid primary key default gen_random_uuid(),
  quotation_id uuid not null,
  legal_entity_id uuid not null,
  version_no integer not null check (version_no between 1 and 999),
  status text not null default 'draft'
    check (status in ('draft', 'ready', 'sent', 'accepted', 'declined', 'expired', 'superseded', 'discarded')),
  row_version integer not null default 1 check (row_version >= 1),
  content_hash text check (content_hash ~ '^[0-9a-f]{64}$'),
  based_on_version_id uuid,
  trip_destination text check (length(trip_destination) between 1 and 200),
  trip_scope text check (trip_scope in ('domestic', 'international')),
  trip_start date check (trip_start between date '2000-01-01' and date '2100-12-31'),
  trip_end date check (trip_end between date '2000-01-01' and date '2100-12-31'),
  adults smallint not null default 0 check (adults between 0 and 100),
  children_with_bed smallint not null default 0 check (children_with_bed between 0 and 100),
  children_no_bed smallint not null default 0 check (children_no_bed between 0 and 100),
  infants smallint not null default 0 check (infants between 0 and 100),
  pax_remarks text check (length(pax_remarks) between 1 and 500),
  requirements_note text check (length(requirements_note) between 1 and 4000),
  content jsonb not null default '{}'::jsonb check (jsonb_typeof(content) = 'object'),
  valid_until date not null default ((now() at time zone 'Asia/Kolkata')::date + 7),
  sent_at timestamptz,
  sent_by uuid references public.staff_profiles (user_id),
  sent_channel text check (sent_channel in ('whatsapp', 'email', 'in_person', 'phone', 'other')),
  accepted_at timestamptz,
  accepted_by uuid references public.staff_profiles (user_id),
  accepted_tier text check (accepted_tier in ('quoted', 'upgrade')),
  acceptance_evidence_id uuid,
  declined_at timestamptz,
  declined_by uuid references public.staff_profiles (user_id),
  decline_reason text check (decline_reason in ('price', 'dates', 'changed_plans', 'chose_other', 'no_response', 'other')),
  expired_at timestamptz,
  superseded_at timestamptz,
  superseded_by_version_id uuid,
  discarded_at timestamptz,
  discarded_by uuid references public.staff_profiles (user_id),
  created_by uuid not null references public.staff_profiles (user_id),
  updated_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, quotation_id) references public.quotations (legal_entity_id, id),
  unique (legal_entity_id, id),
  constraint quotation_versions_number_unique unique (quotation_id, version_no),
  constraint quotation_versions_trip_order check (trip_end is null or trip_start is null or trip_end >= trip_start),
  constraint quotation_versions_ready_hash check (status not in ('ready', 'sent', 'accepted', 'declined', 'expired', 'superseded')
                                                  or content_hash is not null),
  constraint quotation_versions_sent_complete check ((sent_at is null) = (sent_by is null) and (sent_at is null) = (sent_channel is null)),
  constraint quotation_versions_sent_states check (status in ('draft', 'ready', 'discarded') or sent_at is not null),
  constraint quotation_versions_accepted_complete check ((status = 'accepted' or (status = 'superseded' and accepted_at is not null))
    = (accepted_at is not null) and (accepted_at is null) = (accepted_by is null)
    and (accepted_at is null) = (accepted_tier is null) and (accepted_at is null) = (acceptance_evidence_id is null)),
  constraint quotation_versions_declined_complete check ((status = 'declined') = (declined_at is not null)
    and (declined_at is null) = (declined_by is null) and (declined_at is null) = (decline_reason is null)),
  constraint quotation_versions_expired_complete check ((status = 'expired') = (expired_at is not null)),
  constraint quotation_versions_superseded_complete check ((status = 'superseded') = (superseded_at is not null)),
  constraint quotation_versions_discarded_complete check ((status = 'discarded') = (discarded_at is not null)
    and (discarded_at is null) = (discarded_by is null))
);
create unique index quotation_versions_one_working on public.quotation_versions (quotation_id) where status in ('draft', 'ready');
create unique index quotation_versions_one_sent on public.quotation_versions (quotation_id) where status = 'sent';
create unique index quotation_versions_one_accepted on public.quotation_versions (quotation_id) where status = 'accepted';
create index quotation_versions_sent_expiry_idx on public.quotation_versions (valid_until) where status = 'sent';
create index quotation_versions_based_on_idx on public.quotation_versions (based_on_version_id) where based_on_version_id is not null;
create index quotation_versions_superseded_by_idx on public.quotation_versions (superseded_by_version_id) where superseded_by_version_id is not null;
create index quotation_versions_evidence_idx on public.quotation_versions (acceptance_evidence_id) where acceptance_evidence_id is not null;
create index quotation_versions_created_by_idx on public.quotation_versions (created_by);
create index quotation_versions_updated_by_idx on public.quotation_versions (updated_by);
create index quotation_versions_sent_by_idx on public.quotation_versions (sent_by) where sent_by is not null;
create index quotation_versions_accepted_by_idx on public.quotation_versions (accepted_by) where accepted_by is not null;
create index quotation_versions_declined_by_idx on public.quotation_versions (declined_by) where declined_by is not null;
create index quotation_versions_discarded_by_idx on public.quotation_versions (discarded_by) where discarded_by is not null;
alter table public.quotations
  add constraint quotations_accepted_version_fk foreign key (legal_entity_id, accepted_version_id)
    references public.quotation_versions (legal_entity_id, id);
alter table public.quotation_versions
  add constraint quotation_versions_based_on_fk foreign key (legal_entity_id, based_on_version_id)
    references public.quotation_versions (legal_entity_id, id),
  add constraint quotation_versions_superseded_by_fk foreign key (legal_entity_id, superseded_by_version_id)
    references public.quotation_versions (legal_entity_id, id);
comment on table public.quotation_versions is
  'One version of a quotation. Content changes only while draft or ready; a sent version never changes (a change makes a new version). Effective status: sent past valid_until (IST) reads as expired.';

create table public.quotation_version_tiers (
  quotation_version_id uuid not null,
  legal_entity_id uuid not null,
  tier_key text not null check (tier_key in ('quoted', 'upgrade')),
  label text check (length(label) between 1 and 80),
  created_at timestamptz not null default now(),
  primary key (quotation_version_id, tier_key),
  foreign key (legal_entity_id, quotation_version_id) references public.quotation_versions (legal_entity_id, id)
);
create index quotation_version_tiers_entity_idx on public.quotation_version_tiers (legal_entity_id, quotation_version_id);

create table public.quotation_version_items (
  id uuid primary key default gen_random_uuid(),
  quotation_version_id uuid not null,
  legal_entity_id uuid not null,
  item_no integer not null check (item_no between 1 and 100),
  service_type text not null check (service_type in ('hotel', 'transfer', 'activity', 'flight', 'visa', 'passport')),
  tier_key text check (tier_key in ('quoted', 'upgrade')),
  facts jsonb not null check (jsonb_typeof(facts) = 'object'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, quotation_version_id) references public.quotation_versions (legal_entity_id, id),
  constraint quotation_version_items_no_unique unique (quotation_version_id, item_no),
  -- Mercury's lines reference (legal_entity_id, quotation_version_id, id).
  constraint quotation_version_items_ref_unique unique (legal_entity_id, quotation_version_id, id)
);
create index quotation_version_items_entity_idx on public.quotation_version_items (legal_entity_id, quotation_version_id);

create table public.quotation_version_contacts (
  quotation_version_id uuid primary key,
  legal_entity_id uuid not null,
  contact_name text not null check (length(contact_name) between 1 and 120),
  mobile text check (mobile ~ '^[6-9][0-9]{9}$'),
  email text check (length(email) <= 254 and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'),
  company_name text check (length(company_name) between 1 and 200),
  -- DEC-45: "booking for" (Bitrix Customer Type maps to business); carried into the booking draft.
  booking_for text check (booking_for in ('individual', 'business')),
  updated_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, quotation_version_id) references public.quotation_versions (legal_entity_id, id),
  check (mobile is not null or email is not null)
);
create index quotation_version_contacts_entity_idx on public.quotation_version_contacts (legal_entity_id, quotation_version_id);
create index quotation_version_contacts_updated_by_idx on public.quotation_version_contacts (updated_by);

create table public.quotation_evidence (
  id uuid primary key default gen_random_uuid(),
  quotation_version_id uuid not null,
  quotation_id uuid not null,
  legal_entity_id uuid not null,
  kind text not null check (kind in ('acceptance_message', 'other')),
  object_path text not null unique,
  file_name text not null check (length(file_name) between 1 and 120 and file_name ~ '^[A-Za-z0-9._ -]+$'),
  mime text not null check (mime in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 4194304),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending_upload' check (status in ('pending_upload', 'stored', 'failed', 'removed')),
  uploaded_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  stored_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, quotation_version_id) references public.quotation_versions (legal_entity_id, id),
  foreign key (legal_entity_id, quotation_id) references public.quotations (legal_entity_id, id),
  unique (legal_entity_id, id),
  check (object_path = legal_entity_id::text || '/' || quotation_id::text || '/' || quotation_version_id::text || '/' || id::text),
  check (status <> 'stored' or stored_at is not null)
);
create index quotation_evidence_version_idx on public.quotation_evidence (quotation_version_id, status);
create index quotation_evidence_quotation_idx on public.quotation_evidence (quotation_id);
create index quotation_evidence_entity_idx on public.quotation_evidence (legal_entity_id, quotation_version_id);
create index quotation_evidence_uploaded_by_idx on public.quotation_evidence (uploaded_by);
alter table public.quotation_versions
  add constraint quotation_versions_evidence_fk foreign key (legal_entity_id, acceptance_evidence_id)
    references public.quotation_evidence (legal_entity_id, id);

create table public.quotation_conversions (
  id uuid primary key default gen_random_uuid(),
  quotation_version_id uuid not null unique,
  quotation_id uuid not null,
  legal_entity_id uuid not null,
  deal_id uuid not null,
  booking_version_id uuid not null,
  accepted_tier text not null check (accepted_tier in ('quoted', 'upgrade')),
  request_id uuid not null,
  items_created integer not null default 0 check (items_created between 0 and 100),
  money_signature text check (money_signature ~ '^[0-9a-f]{32}$'),
  facts_signature text check (facts_signature ~ '^[0-9a-f]{32}$'),
  minor_signature text check (minor_signature ~ '^[0-9a-f]{32}$'),
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, quotation_version_id) references public.quotation_versions (legal_entity_id, id),
  foreign key (legal_entity_id, quotation_id) references public.quotations (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id, booking_version_id) references public.booking_versions (legal_entity_id, deal_id, id),
  constraint quotation_conversions_booking_unique unique (booking_version_id)
);
create index quotation_conversions_quotation_idx on public.quotation_conversions (quotation_id);
create index quotation_conversions_deal_idx on public.quotation_conversions (deal_id);
create index quotation_conversions_entity_idx on public.quotation_conversions (legal_entity_id, quotation_version_id);
create index quotation_conversions_created_by_idx on public.quotation_conversions (created_by);

-- Which booking service item each quotation item became (Mercury maps money by it).
create table public.quotation_conversion_items (
  conversion_id uuid not null references public.quotation_conversions (id),
  quotation_item_id uuid not null references public.quotation_version_items (id),
  service_item_id uuid not null references public.service_items (id),
  primary key (conversion_id, quotation_item_id),
  unique (service_item_id)
);
create index quotation_conversion_items_quotation_item_idx on public.quotation_conversion_items (quotation_item_id);

alter table public.booking_versions
  add column source_quotation_version_id uuid references public.quotation_versions (id),
  add column source_quotation_hash text check (source_quotation_hash ~ '^[0-9a-f]{64}$'),
  add column source_accepted_tier text check (source_accepted_tier in ('quoted', 'upgrade')),
  add constraint booking_versions_source_complete check (
    (source_quotation_version_id is null) = (source_quotation_hash is null)
    and (source_quotation_version_id is null) = (source_accepted_tier is null));
create unique index booking_versions_source_quotation_unique
  on public.booking_versions (deal_id, source_quotation_version_id) where source_quotation_version_id is not null;
create index booking_versions_source_quotation_idx
  on public.booking_versions (source_quotation_version_id) where source_quotation_version_id is not null;

-- ===========================================================================
-- 2. Guards (invoker trigger functions; they run inside the definer commands)
-- ===========================================================================

create function authz.quotations_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'quotations are never deleted' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.id is distinct from old.id or new.legal_entity_id is distinct from old.legal_entity_id
       or new.branch_id is distinct from old.branch_id or new.quote_no is distinct from old.quote_no
       or new.reference is distinct from old.reference or new.lead_id is distinct from old.lead_id
       or new.deal_id is distinct from old.deal_id or new.request_id is distinct from old.request_id
       or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at
       or (old.linked_deal_id is not null and new.linked_deal_id is distinct from old.linked_deal_id)
       or (old.converted_at is not null and new.converted_at is distinct from old.converted_at)) then
    raise exception 'quotation identity columns are immutable' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and new.lead_id is not null and not exists (
       select 1 from public.crm_leads l
       where l.id = new.lead_id and l.legal_entity_id = new.legal_entity_id and l.branch_id = new.branch_id) then
    raise exception 'quotation lead must belong to the same entity and branch' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' and new.deal_id is not null and not exists (
       select 1 from public.deals d where d.id = new.deal_id and d.branch_id = new.branch_id) then
    raise exception 'quotation deal must belong to the same branch' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger quotations_a_guard before insert or update or delete on public.quotations
  for each row execute function authz.quotations_guard();

-- Content changes only while draft or ready; transitions only along the
-- frozen state graph; identity never changes; never deleted.
create function authz.quotation_versions_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'quotation versions are never deleted' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'a quotation version starts as draft' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id or new.quotation_id is distinct from old.quotation_id
     or new.legal_entity_id is distinct from old.legal_entity_id or new.version_no is distinct from old.version_no
     or new.based_on_version_id is distinct from old.based_on_version_id
     or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
    raise exception 'quotation version identity columns are immutable' using errcode = '42501';
  end if;
  if old.status not in ('draft', 'ready') and (
       new.trip_destination is distinct from old.trip_destination or new.trip_scope is distinct from old.trip_scope
       or new.trip_start is distinct from old.trip_start or new.trip_end is distinct from old.trip_end
       or new.adults is distinct from old.adults or new.children_with_bed is distinct from old.children_with_bed
       or new.children_no_bed is distinct from old.children_no_bed or new.infants is distinct from old.infants
       or new.pax_remarks is distinct from old.pax_remarks or new.requirements_note is distinct from old.requirements_note
       or new.content is distinct from old.content or new.valid_until is distinct from old.valid_until
       or new.content_hash is distinct from old.content_hash) then
    raise exception 'a sent quotation version never changes' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'draft' and new.status in ('ready', 'discarded'))
       or (old.status = 'ready' and new.status in ('draft', 'sent', 'discarded'))
       or (old.status = 'sent' and new.status in ('accepted', 'declined', 'expired', 'superseded'))
       or (old.status = 'accepted' and new.status = 'superseded')) then
    raise exception 'quotation version status change not allowed' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger quotation_versions_a_guard before insert or update or delete on public.quotation_versions
  for each row execute function authz.quotation_versions_guard();

-- Tiers, items and contacts change only while their version is a draft.
create function authz.quotation_child_guard() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_version uuid := case when tg_op = 'DELETE' then old.quotation_version_id else new.quotation_version_id end;
begin
  if tg_op = 'UPDATE' and new.quotation_version_id is distinct from old.quotation_version_id then
    raise exception 'quotation rows never move to another version' using errcode = '42501';
  end if;
  if exists (select 1 from public.quotation_versions v where v.id = v_version and v.status <> 'draft') then
    raise exception 'quotation version is not a draft' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger quotation_version_tiers_a_guard before insert or update or delete on public.quotation_version_tiers
  for each row execute function authz.quotation_child_guard();
create trigger quotation_version_items_a_guard before insert or update or delete on public.quotation_version_items
  for each row execute function authz.quotation_child_guard();
create trigger quotation_version_contacts_a_guard before insert or update or delete on public.quotation_version_contacts
  for each row execute function authz.quotation_child_guard();

create function authz.quotation_evidence_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'quotation evidence is never deleted' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.id is distinct from old.id or new.quotation_version_id is distinct from old.quotation_version_id
       or new.quotation_id is distinct from old.quotation_id or new.legal_entity_id is distinct from old.legal_entity_id
       or new.kind is distinct from old.kind or new.object_path is distinct from old.object_path
       or new.file_name is distinct from old.file_name or new.mime is distinct from old.mime
       or new.size_bytes is distinct from old.size_bytes or new.sha256 is distinct from old.sha256
       or new.uploaded_by is distinct from old.uploaded_by or new.created_at is distinct from old.created_at) then
    raise exception 'quotation evidence identity columns are immutable' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and exists (
       select 1 from public.quotation_versions v
       where v.id = old.quotation_version_id and v.status in ('accepted', 'declined', 'expired', 'superseded', 'discarded')) then
    raise exception 'evidence of a closed quotation version is immutable' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger quotation_evidence_a_guard before insert or update or delete on public.quotation_evidence
  for each row execute function authz.quotation_evidence_guard();

create function authz.quotation_conversions_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'quotation conversions are never deleted' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.id is distinct from old.id or new.quotation_version_id is distinct from old.quotation_version_id
       or new.quotation_id is distinct from old.quotation_id or new.deal_id is distinct from old.deal_id
       or new.booking_version_id is distinct from old.booking_version_id or new.accepted_tier is distinct from old.accepted_tier
       or new.request_id is distinct from old.request_id or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at
       or (old.money_signature is not null and new.money_signature is distinct from old.money_signature)
       or (old.facts_signature is not null and new.facts_signature is distinct from old.facts_signature)
       or (old.minor_signature is not null and new.minor_signature is distinct from old.minor_signature)) then
    raise exception 'quotation conversions are immutable' using errcode = '42501';
  end if;
  return case when tg_op = 'DELETE' then old else new end;
end;
$$;
create trigger quotation_conversions_a_guard before update or delete on public.quotation_conversions
  for each row execute function authz.quotation_conversions_guard();

-- Review E2-6: the item map of a conversion never changes.
create function authz.quotation_conversion_items_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'quotation conversion items are immutable' using errcode = '42501';
end;
$$;
create trigger quotation_conversion_items_a_guard before update or delete on public.quotation_conversion_items
  for each row execute function authz.quotation_conversion_items_guard();

-- RLS: on, restrictive session policy, no permissive policy, no privilege.
do $$
declare
  t text;
begin
  foreach t in array array['quotation_counters', 'quotations', 'quotation_versions', 'quotation_version_tiers',
    'quotation_version_items', 'quotation_version_contacts', 'quotation_evidence', 'quotation_conversions',
    'quotation_conversion_items'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('quotation-evidence', 'quotation-evidence', false, 4194304,
      array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;

-- ===========================================================================
-- 3. Mercury stubs (20261120000300 replaces them; same names and parameters)
-- ===========================================================================

create function authz.quotation_money_check(p_version uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select '{}'::text[]
$$;

create function authz.quotation_money_hash(p_version uuid) returns text
language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to('[]', 'UTF8')), 'hex')
$$;

create function authz.quotation_money_json(p_version uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select null::jsonb
$$;

create function authz.quotation_copy_lines(p_from_version uuid, p_to_version uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform p_from_version, p_to_version;
end;
$$;

create function authz.quotation_money_to_booking(p_quotation_version uuid, p_booking_version uuid, p_tier_key text)
returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform p_quotation_version, p_booking_version, p_tier_key;
end;
$$;

-- ===========================================================================
-- 4. Access and state helpers
-- ===========================================================================

-- The Lead's Sales owner (active Sales membership in its enabled branch) or
-- that branch's Manager; never a Purchase role holder (same rule as Lead reads).
create function authz.quotation_lead_editor(p_lead uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false)
    and not exists (select 1 from public.memberships p
                    where p.user_id = (select auth.uid()) and p.role_code = 'purchase' and p.status = 'active')
    and exists (
      select 1 from public.crm_leads l
      join public.memberships m on m.legal_entity_id = l.legal_entity_id and m.branch_id = l.branch_id
      join public.legal_entities e on e.id = m.legal_entity_id
      join public.branches b on b.id = m.branch_id
      where l.id = p_lead and m.user_id = (select auth.uid()) and m.status = 'active'
        and e.status = 'enabled' and b.status = 'enabled'
        and ((m.role_code = 'sales' and l.owner_user_id = (select auth.uid())) or m.role_code = 'manager'))
$$;

create function authz.quotation_can_edit(p_quotation uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case when q.deal_id is not null then authz.can_edit_booking_draft(q.deal_id)
                else authz.quotation_lead_editor(q.lead_id)
                     or (q.linked_deal_id is not null and authz.can_edit_booking_draft(q.linked_deal_id)) end
    from public.quotations q where q.id = p_quotation), false)
$$;

create function authz.quotation_money_can_read(p_quotation uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.quotation_can_edit(p_quotation)
$$;

create function authz.quotation_money_can_edit(p_quotation uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.quotation_can_edit(p_quotation)
$$;

-- The Deal a quotation books into: its own Deal, or the linked Deal of a Lead quotation.
create function authz.quotation_deal(p_quotation uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce(q.deal_id, q.linked_deal_id) from public.quotations q where q.id = p_quotation
$$;

-- Review E2-5: the quotation's Deal (own or linked) was removed by the sync.
create function authz.quotation_deal_removed(p_quotation uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.deals d where d.id = authz.quotation_deal(p_quotation) and d.removed_at is not null)
$$;

-- Effective status: a sent version past its validity (IST) is expired.
create function authz.quotation_status(v public.quotation_versions) returns text
language sql stable set search_path = '' as $$
  select case when v.status = 'sent' and v.valid_until < authz.finance_today() then 'expired' else v.status end
$$;

-- Persists expiry for the quotation's sent version (called by every command).
create function authz.quotation_expire_due(p_quotation uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_row record;
begin
  for v_row in
    update public.quotation_versions v set status = 'expired', expired_at = now()
    where v.quotation_id = p_quotation and v.status = 'sent' and v.valid_until < authz.finance_today()
    returning v.id, v.legal_entity_id, v.version_no
  loop
    perform authz.write_audit('quotation.expired', v_row.legal_entity_id,
      (select q.branch_id from public.quotations q where q.id = p_quotation), 'quotation_version', v_row.id, null,
      jsonb_build_object('quotationId', p_quotation, 'versionNo', v_row.version_no));
  end loop;
end;
$$;

-- Content hash of a version: every customer-visible fact plus Mercury's money hash.
create function authz.quotation_content_hash(p_version uuid) returns text
language sql stable security definer set search_path = '' as $$
  select encode(sha256(convert_to(jsonb_build_object(
    'schema', 1,
    'trip', jsonb_build_array(v.trip_destination, v.trip_scope, v.trip_start, v.trip_end),
    'pax', jsonb_build_array(v.adults, v.children_with_bed, v.children_no_bed, v.infants, v.pax_remarks),
    'requirements', v.requirements_note,
    'content', v.content,
    'validUntil', v.valid_until,
    'contacts', (select jsonb_build_array(c.contact_name, c.mobile, c.email, c.company_name, c.booking_for)
                 from public.quotation_version_contacts c where c.quotation_version_id = v.id),
    'tiers', coalesce((select jsonb_agg(jsonb_build_array(t.tier_key, t.label) order by t.tier_key)
                       from public.quotation_version_tiers t where t.quotation_version_id = v.id), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_array(i.item_no, i.service_type, i.tier_key, i.facts) order by i.item_no)
                       from public.quotation_version_items i where i.quotation_version_id = v.id), '[]'::jsonb),
    'money', authz.quotation_money_hash(v.id))::text, 'UTF8')), 'hex')
  from public.quotation_versions v where v.id = p_version
$$;

-- Blocking issues before a version can be marked ready (drafts).
create function authz.quotation_issues(p_version uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select array_remove(array[
    case when v.trip_destination is null or v.trip_start is null or v.trip_end is null then 'trip_missing' end,
    case when v.adults + v.children_with_bed + v.children_no_bed + v.infants = 0 then 'pax_missing' end,
    case when not exists (select 1 from public.quotation_version_items i where i.quotation_version_id = v.id) then 'no_items' end,
    case when exists (select 1 from public.quotation_version_items i where i.quotation_version_id = v.id
                      and cardinality(authz.validate_service_facts(i.service_type, i.facts)) > 0) then 'item_facts_invalid' end,
    case when not exists (select 1 from public.quotation_version_contacts c where c.quotation_version_id = v.id) then 'contact_missing' end,
    case when not exists (select 1 from public.quotation_version_tiers t where t.quotation_version_id = v.id and t.tier_key = 'quoted')
      then 'tier_missing' end,
    case when v.valid_until < authz.finance_today() then 'valid_until_past' end
  ], null) || coalesce((
    select array_agg(c order by c) from unnest(authz.quotation_money_check(v.id)) c
    where c not in ('component_mismatch', 'cost_incomplete', 'margin_negative', 'extra_bed_not_priced',
                    'child_no_bed_not_priced', 'per_person_not_exact')), '{}'::text[])
  from public.quotation_versions v where v.id = p_version
$$;

-- Locks a working version for an edit (Mercury's money commands call it too):
-- removed Deal, rights, working state; a ready version goes back to draft.
create function authz.lock_quotation_draft(p_version_id uuid) returns public.quotation_versions
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_q public.quotations%rowtype;
begin
  select * into v_q from public.quotations q
  where q.id = (select v.quotation_id from public.quotation_versions v where v.id = p_version_id) for update;
  perform authz.refuse_removed_deal(coalesce(v_q.deal_id, v_q.linked_deal_id));
  if v_q.id is null or not authz.quotation_can_edit(v_q.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.quotation_expire_due(v_q.id);
  select * into v_ver from public.quotation_versions v where v.id = p_version_id for update;
  if v_q.converted_at is not null then
    raise exception 'quotation_converted' using errcode = '55000';
  end if;
  if v_ver.status not in ('draft', 'ready') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if v_ver.status = 'ready' then
    update public.quotation_versions v set status = 'draft', content_hash = null where v.id = v_ver.id
    returning * into v_ver;
  end if;
  return v_ver;
end;
$$;

create function authz.bump_quotation_version(p_version_id uuid) returns public.quotation_versions
language sql volatile security definer set search_path = '' as $$
  update public.quotation_versions v
  set row_version = v.row_version + 1, content_hash = null, updated_by = (select auth.uid())
  where v.id = p_version_id
  returning *
$$;

-- Booking items created from quotation items by a conversion (Mercury maps money by it).
create function authz.quotation_conversion_item_map(p_booking_version uuid)
returns table (quotation_item_id uuid, service_item_id uuid)
language sql stable security definer set search_path = '' as $$
  select m.quotation_item_id, m.service_item_id
  from public.quotation_conversion_items m
  join public.quotation_conversions c on c.id = m.conversion_id
  where c.booking_version_id = p_booking_version
$$;

-- Signatures of a booking draft as compared with conversion time (freeze 2.8/2.9).
create function authz.booking_quote_money_signature(p_version uuid) returns text
language sql stable security definer set search_path = '' as $$
  select md5(jsonb_build_array(
    (select c.selling_total_paise from public.booking_version_commercials c where c.version_id = p_version),
    coalesce((select jsonb_agg(jsonb_build_array(p.seq, p.label, p.amount_paise, p.due_date) order by p.seq)
              from public.booking_version_instalments p where p.booking_version_id = p_version), '[]'::jsonb))::text)
$$;

create function authz.booking_quote_facts_signature(p_version uuid) returns text
language sql stable security definer set search_path = '' as $$
  select md5(jsonb_build_array(
    (select jsonb_build_array(v.trip_start, v.trip_end) from public.booking_versions v where v.id = p_version),
    coalesce((
      select jsonb_agg(jsonb_build_array(i.service_type, case i.service_type
          when 'hotel' then (select coalesce(jsonb_object_agg(k, f.facts -> k), '{}'::jsonb)
                             from unnest(array['city', 'checkIn', 'checkOut', 'hotelName', 'roomType', 'rooms', 'adults', 'children']) k
                             where f.facts ? k)
          when 'transfer' then (select coalesce(jsonb_object_agg(k, f.facts -> k), '{}'::jsonb)
                                from unnest(array['vehicleType', 'date']) k where f.facts ? k)
          else '{}'::jsonb end) order by i.item_no)
      from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
      where f.booking_version_id = p_version), '[]'::jsonb))::text)
$$;

create function authz.booking_quote_minor_signature(p_version uuid) returns text
language sql stable security definer set search_path = '' as $$
  select md5(coalesce((
    select jsonb_agg(jsonb_build_array(i.item_no,
        (select coalesce(jsonb_object_agg(k, f.facts -> k), '{}'::jsonb)
         from unnest(array['extraBeds', 'childrenWithoutBed', 'bedRemarks', 'mealPlan']) k where f.facts ? k)) order by i.item_no)
    from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
    where f.booking_version_id = p_version and i.service_type = 'hotel'), '[]'::jsonb)::text)
$$;

-- Review E2-1 / E5-6: the Deal's named travellers by type differ from the
-- accepted party (adults; children with or without a bed; infants), in either
-- direction, once at least one traveller is named.
create function authz.booking_quote_pax_differs(p_version uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select exists (select 1 from public.deal_travellers t where t.deal_id = b.deal_id)
      and ((select count(*) from public.deal_travellers t where t.deal_id = b.deal_id and t.traveller_type = 'adult') <> q.adults
        or (select count(*) from public.deal_travellers t where t.deal_id = b.deal_id and t.traveller_type = 'child')
           <> q.children_with_bed + q.children_no_bed
        or (select count(*) from public.deal_travellers t where t.deal_id = b.deal_id and t.traveller_type = 'infant') <> q.infants)
    from public.booking_versions b join public.quotation_versions q on q.id = b.source_quotation_version_id
    where b.id = p_version), false)
$$;

-- The draft came from an accepted quotation version whose acceptance file is stored.
create function authz.booking_quote_acceptance_ok(p_version uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.booking_versions b
    join public.quotation_versions q on q.id = b.source_quotation_version_id
    join public.quotation_evidence e on e.id = q.acceptance_evidence_id
    where b.id = p_version and q.status in ('accepted', 'superseded') and q.accepted_at is not null
      and e.status = 'stored' and e.kind = 'acceptance_message')
$$;

-- quote_acceptance_stale / quote_details_changed (drafts converted from a quotation).
create function authz.booking_quote_change(p_version uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when c.id is null or b.status <> 'draft' then null
    when (authz.booking_quote_money_signature(b.id) is distinct from c.money_signature
          or authz.booking_quote_facts_signature(b.id) is distinct from c.facts_signature)
         and not exists (select 1 from public.booking_evidence e
                         where e.version_id = b.id and e.kind = 'acceptance_message' and e.status = 'stored')
      then 'stale'
    when authz.booking_quote_minor_signature(b.id) is distinct from c.minor_signature then 'details'
    else null end
  from public.booking_versions b
  left join public.quotation_conversions c on c.booking_version_id = b.id
  where b.id = p_version
$$;

-- Review E5-6: the converted draft's named party differs from the accepted one
-- and no new acceptance message was stored on the booking (warning while typing,
-- blocker in readiness).
create function authz.booking_quote_party_stale(p_version uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select b.status = 'draft' and authz.booking_quote_pax_differs(b.id)
      and not exists (select 1 from public.booking_evidence e
                      where e.version_id = b.id and e.kind = 'acceptance_message' and e.status = 'stored')
    from public.booking_versions b
    join public.quotation_conversions c on c.booking_version_id = b.id
    where b.id = p_version), false)
$$;

-- Content allowlist of a version's narrative (no money keys).
create function authz.quotation_content_ok(p_content jsonb) returns boolean
language sql immutable set search_path = '' as $$
  select jsonb_typeof(p_content) = 'object'
    and not exists (select 1 from jsonb_object_keys(p_content) k where k not in ('days', 'includes', 'excludes', 'terms', 'notes'))
    and (not p_content ? 'days' or (jsonb_typeof(p_content -> 'days') = 'array' and jsonb_array_length(p_content -> 'days') <= 60
         and not exists (select 1 from jsonb_array_elements(p_content -> 'days') d
                         where jsonb_typeof(d) <> 'object'
                            or exists (select 1 from jsonb_object_keys(d) k where k not in ('day', 'title', 'text'))
                            or jsonb_typeof(d -> 'day') <> 'number' or (d ->> 'day') !~ '^[0-9]{1,2}$'
                            or (d ->> 'day')::integer not between 1 and 60
                            or jsonb_typeof(d -> 'title') <> 'string' or length(d ->> 'title') not between 1 and 120
                            or (d ? 'text' and (jsonb_typeof(d -> 'text') <> 'string' or length(d ->> 'text') > 2000)))))
    and not exists (
      select 1 from unnest(array['includes', 'excludes', 'terms']) k
      where p_content ? k and (jsonb_typeof(p_content -> k) <> 'array' or jsonb_array_length(p_content -> k) > 40
            or exists (select 1 from jsonb_array_elements(p_content -> k) s
                       where jsonb_typeof(s) <> 'string' or length(s #>> '{}') not between 1 and 300)))
    and (not p_content ? 'notes' or (jsonb_typeof(p_content -> 'notes') = 'string' and length(p_content ->> 'notes') between 1 and 2000))
$$;

create function authz.quotation_version_json(v public.quotation_versions) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('versionId', v.id, 'versionNo', v.version_no, 'status', authz.quotation_status(v),
    'rowVersion', v.row_version, 'contentHash', v.content_hash, 'validUntil', to_char(v.valid_until, 'YYYY-MM-DD'),
    'basedOnVersionId', v.based_on_version_id, 'sentAt', v.sent_at, 'sentChannel', v.sent_channel,
    'acceptedAt', v.accepted_at, 'acceptedTier', v.accepted_tier, 'declinedAt', v.declined_at,
    'declineReason', v.decline_reason, 'updatedAt', v.updated_at)
$$;

-- Locks a quotation and its version for a transition command; rights; expiry persisted.
create function authz.lock_quotation_version(p_version_id uuid) returns public.quotation_versions
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_q public.quotations%rowtype;
  v_ver public.quotation_versions%rowtype;
begin
  select * into v_q from public.quotations q
  where q.id = (select v.quotation_id from public.quotation_versions v where v.id = p_version_id) for update;
  perform authz.refuse_removed_deal(coalesce(v_q.deal_id, v_q.linked_deal_id));
  if v_q.id is null or not authz.quotation_can_edit(v_q.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.quotation_expire_due(v_q.id);
  select * into v_ver from public.quotation_versions v where v.id = p_version_id for update;
  return v_ver;
end;
$$;

-- ===========================================================================
-- 5. Commands
-- ===========================================================================

create function public.quotation_create(p_subject_kind text, p_subject_id uuid, p_title text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entity uuid;
  v_branch uuid;
  v_owner uuid;
  v_title text := btrim(coalesce(p_title, ''), E' \t\r\n');
  v_existing public.quotations%rowtype;
  v_no integer;
  v_q public.quotations%rowtype;
  v_ver public.quotation_versions%rowtype;
begin
  if p_subject_kind is null or p_subject_kind not in ('lead', 'deal') or p_subject_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'subjectKind';
  end if;
  if p_subject_kind = 'deal' then
    perform authz.refuse_removed_deal(p_subject_id);
    if not authz.can_edit_booking_draft(p_subject_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    if authz.deal_not_active(p_subject_id) then
      raise exception 'deal_not_active' using errcode = '55000';
    end if;
    select d.legal_entity_id, d.branch_id, d.owner_user_id into v_entity, v_branch, v_owner
    from public.deals d where d.id = p_subject_id;
  else
    if not authz.quotation_lead_editor(p_subject_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    select l.legal_entity_id, l.branch_id, l.owner_user_id into v_entity, v_branch, v_owner
    from public.crm_leads l where l.id = p_subject_id;
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if length(v_title) not between 1 and 200 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'title';
  end if;

  select * into v_existing from public.quotations q where q.created_by = (select auth.uid()) and q.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.title is distinct from v_title
       or (p_subject_kind = 'deal' and v_existing.deal_id is distinct from p_subject_id)
       or (p_subject_kind = 'lead' and v_existing.lead_id is distinct from p_subject_id) then
      raise exception 'request_conflict' using errcode = '40001';
    end if;
    select * into v_ver from public.quotation_versions v where v.quotation_id = v_existing.id and v.version_no = 1;
    return jsonb_build_object('quotationId', v_existing.id, 'reference', v_existing.reference, 'versionId', v_ver.id,
      'versionNo', 1, 'rowVersion', v_ver.row_version, 'created', false);
  end if;

  insert into public.quotation_counters as c (legal_entity_id, last_no) values (v_entity, 1)
  on conflict (legal_entity_id) do update set last_no = c.last_no + 1
  returning c.last_no into v_no;
  insert into public.quotations (legal_entity_id, branch_id, quote_no, reference, lead_id, deal_id, title, owner_user_id,
    request_id, created_by)
  values (v_entity, v_branch, v_no, 'TQ-' || v_no::text,
    case when p_subject_kind = 'lead' then p_subject_id end, case when p_subject_kind = 'deal' then p_subject_id end,
    v_title, v_owner, p_request_id, (select auth.uid()))
  returning * into v_q;
  insert into public.quotation_versions (quotation_id, legal_entity_id, version_no, created_by, updated_by)
  values (v_q.id, v_entity, 1, (select auth.uid()), (select auth.uid()))
  returning * into v_ver;
  insert into public.quotation_version_tiers (quotation_version_id, legal_entity_id, tier_key) values (v_ver.id, v_entity, 'quoted');

  perform authz.write_audit('quotation.created', v_entity, v_branch, 'quotation', v_q.id, null,
    jsonb_build_object('subjectKind', p_subject_kind, 'subjectId', p_subject_id, 'reference', v_q.reference, 'versionId', v_ver.id));
  return jsonb_build_object('quotationId', v_q.id, 'reference', v_q.reference, 'versionId', v_ver.id, 'versionNo', 1,
    'rowVersion', v_ver.row_version, 'created', true);
end;
$$;

-- Partial save: only the keys present change.
create function public.quotation_version_save(p_version_id uuid, p_expected_row_version integer, p_fields jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_bad text[];
  v_key text;
  v_text text;
  v_date date;
  v_changed text[] := '{}'::text[];
  v_cols constant jsonb := jsonb_build_object('adults', 'adults', 'childrenWithBed', 'children_with_bed',
    'childrenNoBed', 'children_no_bed', 'infants', 'infants');
begin
  v_ver := authz.lock_quotation_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_bad := authz.b11_unknown_keys(p_fields, array['destination', 'scope', 'start', 'end', 'adults', 'childrenWithBed',
    'childrenNoBed', 'infants', 'paxRemarks', 'requirementsNote', 'content', 'validUntil']);
  if p_fields ? 'destination' and not authz.sf_text_ok(p_fields -> 'destination', 200, false) then v_bad := v_bad || 'destination'::text; end if;
  if p_fields ? 'scope' and jsonb_typeof(p_fields -> 'scope') <> 'null'
     and (jsonb_typeof(p_fields -> 'scope') <> 'string' or (p_fields ->> 'scope') not in ('domestic', 'international')) then
    v_bad := v_bad || 'scope'::text;
  end if;
  foreach v_key in array array['start', 'end'] loop
    if p_fields ? v_key and jsonb_typeof(p_fields -> v_key) <> 'null' and authz.sf_date(p_fields -> v_key) is null then
      v_bad := v_bad || v_key;
    end if;
  end loop;
  foreach v_key in array array['adults', 'childrenWithBed', 'childrenNoBed', 'infants'] loop
    if p_fields ? v_key and not authz.sf_int_ok(p_fields -> v_key, 0, 100, true) then v_bad := v_bad || v_key; end if;
  end loop;
  if p_fields ? 'paxRemarks' and not authz.sf_text_ok(p_fields -> 'paxRemarks', 500, false) then v_bad := v_bad || 'paxRemarks'::text; end if;
  if p_fields ? 'requirementsNote' and not authz.sf_text_ok(p_fields -> 'requirementsNote', 4000, false) then
    v_bad := v_bad || 'requirementsNote'::text;
  end if;
  if p_fields ? 'content' and not authz.quotation_content_ok(p_fields -> 'content') then v_bad := v_bad || 'content'::text; end if;
  if p_fields ? 'validUntil' then
    v_date := authz.sf_date(p_fields -> 'validUntil');
    if v_date is null then
      v_bad := v_bad || 'validUntil'::text;
    elsif v_date < authz.finance_today() then
      raise exception 'valid_until_past' using errcode = '22023';
    end if;
  end if;
  -- The merged dates must stay in order.
  if not ('start' = any (v_bad) or 'end' = any (v_bad))
     and (case when p_fields ? 'end' then authz.sf_date(p_fields -> 'end') else v_ver.trip_end end)
         < (case when p_fields ? 'start' then authz.sf_date(p_fields -> 'start') else v_ver.trip_start end) then
    v_bad := v_bad || 'end'::text;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;

  update public.quotation_versions v set
    trip_destination = case when p_fields ? 'destination' then authz.b11_text(p_fields -> 'destination') else v.trip_destination end,
    trip_scope = case when p_fields ? 'scope' then authz.b11_text(p_fields -> 'scope') else v.trip_scope end,
    trip_start = case when p_fields ? 'start' then authz.sf_date(p_fields -> 'start') else v.trip_start end,
    trip_end = case when p_fields ? 'end' then authz.sf_date(p_fields -> 'end') else v.trip_end end,
    adults = case when p_fields ? 'adults' then authz.sf_int_value(p_fields -> 'adults') else v.adults end,
    children_with_bed = case when p_fields ? 'childrenWithBed' then authz.sf_int_value(p_fields -> 'childrenWithBed') else v.children_with_bed end,
    children_no_bed = case when p_fields ? 'childrenNoBed' then authz.sf_int_value(p_fields -> 'childrenNoBed') else v.children_no_bed end,
    infants = case when p_fields ? 'infants' then authz.sf_int_value(p_fields -> 'infants') else v.infants end,
    pax_remarks = case when p_fields ? 'paxRemarks' then authz.b11_text(p_fields -> 'paxRemarks') else v.pax_remarks end,
    requirements_note = case when p_fields ? 'requirementsNote' then authz.b11_text(p_fields -> 'requirementsNote') else v.requirements_note end,
    content = case when p_fields ? 'content' then p_fields -> 'content' else v.content end,
    valid_until = case when p_fields ? 'validUntil' then authz.sf_date(p_fields -> 'validUntil') else v.valid_until end
  where v.id = v_ver.id;
  select coalesce(array_agg(k order by k), '{}'::text[]) into v_changed from jsonb_object_keys(p_fields) k;
  v_ver := authz.bump_quotation_version(v_ver.id);
  perform authz.write_audit('quotation.version_saved', v_ver.legal_entity_id,
    (select q.branch_id from public.quotations q where q.id = v_ver.quotation_id), 'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_ver.quotation_id, 'versionNo', v_ver.version_no, 'changedFields', to_jsonb(v_changed),
      'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'status', v_ver.status);
end;
$$;

create function public.quotation_tiers_save(p_version_id uuid, p_expected_row_version integer, p_tiers jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_row jsonb;
  v_keys text[] := '{}'::text[];
begin
  v_ver := authz.lock_quotation_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_tiers is null or jsonb_typeof(p_tiers) <> 'array' or jsonb_array_length(p_tiers) not between 1 and 2 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'tiers';
  end if;
  for v_row in select e from jsonb_array_elements(p_tiers) e loop
    if jsonb_typeof(v_row) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_row) k where k not in ('tierKey', 'label'))
       or jsonb_typeof(v_row -> 'tierKey') is distinct from 'string' or (v_row ->> 'tierKey') not in ('quoted', 'upgrade')
       or (v_row ->> 'tierKey') = any (v_keys)
       or not authz.sf_text_ok(v_row -> 'label', 80, false) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'tiers';
    end if;
    v_keys := v_keys || (v_row ->> 'tierKey');
  end loop;
  if not ('quoted' = any (v_keys))
     or exists (select 1 from public.quotation_version_items i
                where i.quotation_version_id = v_ver.id and i.tier_key is not null and i.tier_key <> all (v_keys)) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'tiers';
  end if;
  delete from public.quotation_version_tiers t where t.quotation_version_id = v_ver.id and t.tier_key <> all (v_keys);
  insert into public.quotation_version_tiers as t (quotation_version_id, legal_entity_id, tier_key, label)
  select v_ver.id, v_ver.legal_entity_id, e ->> 'tierKey', authz.b11_text(e -> 'label') from jsonb_array_elements(p_tiers) e
  on conflict (quotation_version_id, tier_key) do update set label = excluded.label;
  v_ver := authz.bump_quotation_version(v_ver.id);
  perform authz.write_audit('quotation.tiers_saved', v_ver.legal_entity_id,
    (select q.branch_id from public.quotations q where q.id = v_ver.quotation_id), 'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_ver.quotation_id, 'versionNo', v_ver.version_no, 'tiers', to_jsonb(v_keys),
      'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'status', v_ver.status);
end;
$$;

create function authz.quotation_item_facts(p_type text, p_tier text, p_facts jsonb, p_version uuid) returns jsonb
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
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  return v_facts;
end;
$$;

create function public.quotation_item_add(p_version_id uuid, p_expected_row_version integer, p_service_type text,
  p_tier_key text, p_facts jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_facts jsonb;
  v_no integer;
  v_id uuid;
begin
  v_ver := authz.lock_quotation_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  v_facts := authz.quotation_item_facts(p_service_type, p_tier_key, p_facts, v_ver.id);
  select coalesce(max(i.item_no), 0) + 1 into v_no from public.quotation_version_items i where i.quotation_version_id = v_ver.id;
  if v_no > 30 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'items';
  end if;
  insert into public.quotation_version_items (quotation_version_id, legal_entity_id, item_no, service_type, tier_key, facts)
  values (v_ver.id, v_ver.legal_entity_id, v_no, p_service_type, p_tier_key, v_facts)
  returning id into v_id;
  v_ver := authz.bump_quotation_version(v_ver.id);
  perform authz.write_audit('quotation.item_added', v_ver.legal_entity_id,
    (select q.branch_id from public.quotations q where q.id = v_ver.quotation_id), 'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_ver.quotation_id, 'versionNo', v_ver.version_no, 'itemNo', v_no,
      'serviceType', p_service_type, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('itemId', v_id, 'itemNo', v_no, 'rowVersion', v_ver.row_version);
end;
$$;

create function public.quotation_item_save(p_item_id uuid, p_version_id uuid, p_expected_row_version integer,
  p_tier_key text, p_facts jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_item public.quotation_version_items%rowtype;
  v_facts jsonb;
begin
  v_ver := authz.lock_quotation_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  select * into v_item from public.quotation_version_items i where i.id = p_item_id and i.quotation_version_id = v_ver.id;
  if v_item.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_facts := authz.quotation_item_facts(v_item.service_type, p_tier_key, p_facts, v_ver.id);
  update public.quotation_version_items i set facts = v_facts, tier_key = p_tier_key, updated_at = now() where i.id = v_item.id;
  v_ver := authz.bump_quotation_version(v_ver.id);
  perform authz.write_audit('quotation.item_saved', v_ver.legal_entity_id,
    (select q.branch_id from public.quotations q where q.id = v_ver.quotation_id), 'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_ver.quotation_id, 'versionNo', v_ver.version_no, 'itemNo', v_item.item_no,
      'serviceType', v_item.service_type, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version);
end;
$$;

create function public.quotation_item_remove(p_item_id uuid, p_version_id uuid, p_expected_row_version integer)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_item public.quotation_version_items%rowtype;
begin
  v_ver := authz.lock_quotation_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  select * into v_item from public.quotation_version_items i where i.id = p_item_id and i.quotation_version_id = v_ver.id;
  if v_item.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  delete from public.quotation_version_items i where i.id = v_item.id;
  v_ver := authz.bump_quotation_version(v_ver.id);
  perform authz.write_audit('quotation.item_removed', v_ver.legal_entity_id,
    (select q.branch_id from public.quotations q where q.id = v_ver.quotation_id), 'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_ver.quotation_id, 'versionNo', v_ver.version_no, 'itemNo', v_item.item_no,
      'serviceType', v_item.service_type, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version);
end;
$$;

create function public.quotation_contacts_save(p_version_id uuid, p_expected_row_version integer, p_fields jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_bad text[];
  v_mobile text;
  v_email text;
begin
  v_ver := authz.lock_quotation_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_bad := authz.b11_unknown_keys(p_fields, array['contactName', 'mobile', 'email', 'companyName', 'bookingFor']);
  if p_fields ? 'bookingFor' and jsonb_typeof(p_fields -> 'bookingFor') <> 'null'
     and (jsonb_typeof(p_fields -> 'bookingFor') <> 'string' or (p_fields ->> 'bookingFor') not in ('individual', 'business')) then
    v_bad := v_bad || 'bookingFor'::text;
  end if;
  if not authz.sf_text_ok(p_fields -> 'contactName', 120, true) then v_bad := v_bad || 'contactName'::text; end if;
  v_mobile := authz.b11_text(p_fields -> 'mobile');
  v_email := authz.b11_text(p_fields -> 'email');
  if (p_fields ? 'mobile' and jsonb_typeof(p_fields -> 'mobile') not in ('string', 'null'))
     or (v_mobile is not null and v_mobile !~ '^[6-9][0-9]{9}$') then
    v_bad := v_bad || 'mobile'::text;
  end if;
  if (p_fields ? 'email' and jsonb_typeof(p_fields -> 'email') not in ('string', 'null'))
     or (v_email is not null and (length(v_email) > 254 or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$')) then
    v_bad := v_bad || 'email'::text;
  end if;
  if v_mobile is null and v_email is null then v_bad := v_bad || 'mobile'::text; end if;
  if not authz.sf_text_ok(p_fields -> 'companyName', 200, false) then v_bad := v_bad || 'companyName'::text; end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  -- bookingFor is optional: absent keeps the saved value.
  insert into public.quotation_version_contacts as c (quotation_version_id, legal_entity_id, contact_name, mobile, email,
    company_name, booking_for, updated_by)
  values (v_ver.id, v_ver.legal_entity_id, authz.b11_text(p_fields -> 'contactName'), v_mobile, v_email,
    authz.b11_text(p_fields -> 'companyName'),
    case when p_fields ? 'bookingFor' then authz.b11_text(p_fields -> 'bookingFor') end, (select auth.uid()))
  on conflict (quotation_version_id) do update
    set contact_name = excluded.contact_name, mobile = excluded.mobile, email = excluded.email,
        company_name = excluded.company_name,
        booking_for = case when p_fields ? 'bookingFor' then excluded.booking_for else c.booking_for end,
        updated_by = excluded.updated_by, updated_at = now();
  v_ver := authz.bump_quotation_version(v_ver.id);
  perform authz.write_audit('quotation.contacts_saved', v_ver.legal_entity_id,
    (select q.branch_id from public.quotations q where q.id = v_ver.quotation_id), 'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_ver.quotation_id, 'versionNo', v_ver.version_no, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version);
end;
$$;

create function public.quotation_mark_ready(p_version_id uuid, p_expected_row_version integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_issues text[];
  v_hash text;
begin
  v_ver := authz.lock_quotation_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  v_issues := authz.quotation_issues(v_ver.id);
  if cardinality(v_issues) > 0 then
    raise exception 'not_ready' using errcode = '55000', hint = array_to_string(v_issues, ',');
  end if;
  v_hash := authz.quotation_content_hash(v_ver.id);
  update public.quotation_versions v
  set status = 'ready', content_hash = v_hash, row_version = v.row_version + 1, updated_by = (select auth.uid())
  where v.id = v_ver.id returning * into v_ver;
  perform authz.write_audit('quotation.marked_ready', v_ver.legal_entity_id,
    (select q.branch_id from public.quotations q where q.id = v_ver.quotation_id), 'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_ver.quotation_id, 'versionNo', v_ver.version_no, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('status', 'ready', 'contentHash', v_hash, 'rowVersion', v_ver.row_version);
end;
$$;

create function public.quotation_mark_sent(p_version_id uuid, p_expected_content_hash text, p_channel text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_q public.quotations%rowtype;
  v_old uuid;
  v_payload jsonb := jsonb_build_object('versionId', p_version_id, 'hash', p_expected_content_hash, 'channel', p_channel);
  v_result jsonb;
begin
  v_ver := authz.lock_quotation_version(p_version_id);
  select * into v_q from public.quotations q where q.id = v_ver.quotation_id;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_ver.legal_entity_id, p_request_id, 'quotation_mark_sent', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_q.converted_at is not null then
    raise exception 'quotation_converted' using errcode = '55000';
  end if;
  if v_ver.status <> 'ready' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_expected_content_hash is distinct from v_ver.content_hash
     or v_ver.content_hash is distinct from authz.quotation_content_hash(v_ver.id) then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if p_channel is null or p_channel not in ('whatsapp', 'email', 'in_person', 'phone', 'other') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'channel';
  end if;
  if v_ver.valid_until < authz.finance_today() then
    raise exception 'valid_until_past' using errcode = '22023';
  end if;
  -- Supersede the live sent version, or (review E2-3) the accepted but not yet
  -- converted version: the customer accepts the new version again.
  update public.quotation_versions v set status = 'superseded', superseded_at = now(), superseded_by_version_id = v_ver.id
  where v.quotation_id = v_ver.quotation_id and v.status in ('sent', 'accepted') returning v.id into v_old;
  if v_q.accepted_version_id is not null then
    update public.quotations q set accepted_version_id = null, row_version = q.row_version + 1, updated_at = now()
    where q.id = v_q.id;
  end if;
  update public.quotation_versions v
  set status = 'sent', sent_at = now(), sent_by = (select auth.uid()), sent_channel = p_channel,
      row_version = v.row_version + 1, updated_by = (select auth.uid())
  where v.id = v_ver.id returning * into v_ver;
  if v_old is not null then
    perform authz.write_audit('quotation.superseded', v_ver.legal_entity_id, v_q.branch_id, 'quotation_version', v_old, null,
      jsonb_build_object('quotationId', v_q.id, 'byVersionId', v_ver.id));
  end if;
  perform authz.write_audit('quotation.marked_sent', v_ver.legal_entity_id, v_q.branch_id, 'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_q.id, 'versionNo', v_ver.version_no, 'channel', p_channel));
  v_result := jsonb_build_object('status', 'sent', 'validUntil', to_char(v_ver.valid_until, 'YYYY-MM-DD'),
    'supersededVersionId', v_old, 'rowVersion', v_ver.row_version);
  perform authz.finance_remember(v_ver.legal_entity_id, p_request_id, 'quotation_mark_sent', v_payload, v_result);
  return v_result;
end;
$$;

create function public.quotation_evidence_begin(
  p_version_id uuid, p_kind text, p_file_name text, p_mime text, p_size_bytes integer, p_sha256 text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_name text := btrim(left(btrim(regexp_replace(coalesce(p_file_name, ''), '[^A-Za-z0-9._ -]', '_', 'g')), 120));
  v_sha text := lower(btrim(coalesce(p_sha256, '')));
  v_max integer := least(coalesce((select s.evidence_max_bytes from public.booking_settings s where s.id), 4194304), 4194304);
  v_id uuid := gen_random_uuid();
  v_path text;
begin
  v_ver := authz.lock_quotation_version(p_version_id);
  if v_ver.status = 'expired' then
    raise exception 'quotation_expired' using errcode = '55000';
  end if;
  if v_ver.status <> 'sent' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_kind is null or p_kind not in ('acceptance_message', 'other')
     or v_name = '' or v_name ~ '^[. ]+$'
     or p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > v_max
     or v_sha !~ '^[0-9a-f]{64}$'
     or (select count(*) from public.quotation_evidence e where e.quotation_version_id = v_ver.id and e.status <> 'removed') >= 10 then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  v_path := v_ver.legal_entity_id::text || '/' || v_ver.quotation_id::text || '/' || v_ver.id::text || '/' || v_id::text;
  insert into public.quotation_evidence (id, quotation_version_id, quotation_id, legal_entity_id, kind, object_path, file_name,
    mime, size_bytes, sha256, uploaded_by)
  values (v_id, v_ver.id, v_ver.quotation_id, v_ver.legal_entity_id, p_kind, v_path, v_name, p_mime, p_size_bytes, v_sha,
    (select auth.uid()));
  perform authz.write_audit('quotation.evidence_started', v_ver.legal_entity_id,
    (select q.branch_id from public.quotations q where q.id = v_ver.quotation_id), 'quotation_evidence', v_id, null,
    jsonb_build_object('quotationId', v_ver.quotation_id, 'versionId', v_ver.id, 'kind', p_kind, 'mime', p_mime,
      'sizeBytes', p_size_bytes));
  return jsonb_build_object('evidenceId', v_id, 'objectPath', v_path);
end;
$$;

create function public.quotation_evidence_finish(p_evidence_id uuid, p_ok boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ev public.quotation_evidence%rowtype;
  v_ver public.quotation_versions%rowtype;
  v_status text;
  v_missing boolean := false;
begin
  v_ver := authz.lock_quotation_version((select e.quotation_version_id from public.quotation_evidence e where e.id = p_evidence_id));
  select * into v_ev from public.quotation_evidence e where e.id = p_evidence_id for update;
  if v_ev.id is null or v_ev.uploaded_by is distinct from (select auth.uid()) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_ok is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_status := case when p_ok then 'stored' else 'failed' end;
  if v_ev.status <> 'pending_upload' then
    if v_ev.status = v_status or (p_ok and v_ev.status = 'failed') then
      return jsonb_build_object('evidenceId', v_ev.id, 'status', v_ev.status);
    end if;
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if v_ver.status <> 'sent' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_ok and (to_regclass('storage.objects') is null or not exists (
       select 1 from storage.objects o
       where o.bucket_id = 'quotation-evidence' and o.name = v_ev.object_path
         and (o.metadata ->> 'size') ~ '^[0-9]{1,18}$'
         and (o.metadata ->> 'size')::bigint = v_ev.size_bytes)) then
    v_status := 'failed';
    v_missing := true;
  end if;
  update public.quotation_evidence e
  set status = v_status, stored_at = case when v_status = 'stored' then now() else null end
  where e.id = v_ev.id;
  perform authz.write_audit(case when v_status = 'stored' then 'quotation.evidence_stored' else 'quotation.evidence_failed' end,
    v_ev.legal_entity_id, (select q.branch_id from public.quotations q where q.id = v_ev.quotation_id),
    'quotation_evidence', v_ev.id, null,
    jsonb_build_object('quotationId', v_ev.quotation_id, 'versionId', v_ev.quotation_version_id, 'objectMissing', v_missing));
  return jsonb_build_object('evidenceId', v_ev.id, 'status', v_status);
end;
$$;

create function public.quotation_evidence_remove(p_evidence_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ev public.quotation_evidence%rowtype;
  v_ver public.quotation_versions%rowtype;
begin
  v_ver := authz.lock_quotation_version((select e.quotation_version_id from public.quotation_evidence e where e.id = p_evidence_id));
  select * into v_ev from public.quotation_evidence e where e.id = p_evidence_id for update;
  if v_ev.id is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ev.status = 'removed' then
    return jsonb_build_object('evidenceId', v_ev.id, 'status', 'removed');
  end if;
  if v_ver.status <> 'sent' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  update public.quotation_evidence e set status = 'removed' where e.id = v_ev.id;
  perform authz.write_audit('quotation.evidence_removed', v_ev.legal_entity_id,
    (select q.branch_id from public.quotations q where q.id = v_ev.quotation_id), 'quotation_evidence', v_ev.id, null,
    jsonb_build_object('quotationId', v_ev.quotation_id, 'versionId', v_ev.quotation_version_id, 'previousStatus', v_ev.status));
  return jsonb_build_object('evidenceId', v_ev.id, 'status', 'removed');
end;
$$;

create function public.quotation_evidence_authorize_download(p_evidence_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ev public.quotation_evidence%rowtype;
begin
  select * into v_ev from public.quotation_evidence e where e.id = p_evidence_id;
  perform authz.refuse_removed_deal(authz.quotation_deal(v_ev.quotation_id));
  if v_ev.id is null or not authz.quotation_can_edit(v_ev.quotation_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ev.status <> 'stored' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.write_audit('quotation.evidence_viewed', v_ev.legal_entity_id,
    (select q.branch_id from public.quotations q where q.id = v_ev.quotation_id), 'quotation_evidence', v_ev.id, null,
    jsonb_build_object('quotationId', v_ev.quotation_id, 'versionId', v_ev.quotation_version_id));
  return jsonb_build_object('objectPath', v_ev.object_path, 'fileName', v_ev.file_name, 'mime', v_ev.mime);
end;
$$;

create function public.quotation_accept(p_version_id uuid, p_expected_content_hash text, p_evidence_id uuid,
  p_tier_key text, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_q public.quotations%rowtype;
  v_deal uuid;
  v_discarded uuid;
  v_superseded uuid;
  v_payload jsonb := jsonb_build_object('versionId', p_version_id, 'hash', p_expected_content_hash,
    'evidenceId', p_evidence_id, 'tierKey', p_tier_key);
  v_result jsonb;
begin
  v_ver := authz.lock_quotation_version(p_version_id);
  select * into v_q from public.quotations q where q.id = v_ver.quotation_id;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_ver.legal_entity_id, p_request_id, 'quotation_accept', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_ver.status = 'expired' then
    raise exception 'quotation_expired' using errcode = '55000';
  end if;
  if v_ver.status = 'superseded' then
    raise exception 'version_superseded' using errcode = '55000';
  end if;
  if v_ver.status <> 'sent' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_expected_content_hash is distinct from v_ver.content_hash
     or v_ver.content_hash is distinct from authz.quotation_content_hash(v_ver.id) then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if p_tier_key is null or not exists (select 1 from public.quotation_version_tiers t
                                       where t.quotation_version_id = v_ver.id and t.tier_key = p_tier_key) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'tierKey';
  end if;
  if not exists (select 1 from public.quotation_evidence e
                 where e.id = p_evidence_id and e.quotation_version_id = v_ver.id
                   and e.kind = 'acceptance_message' and e.status = 'stored') then
    raise exception 'acceptance_proof_required' using errcode = '55000';
  end if;
  v_deal := coalesce(v_q.deal_id, v_q.linked_deal_id);
  if v_deal is not null then
    if authz.deal_not_active(v_deal) then
      raise exception 'deal_not_active' using errcode = '55000';
    end if;
    perform 1 from public.deals d where d.id = v_deal for no key update;
    if exists (select 1 from public.quotations o
               where o.id <> v_q.id and o.accepted_version_id is not null
                 and (o.deal_id = v_deal or o.linked_deal_id = v_deal)) then
      raise exception 'quotation_already_accepted' using errcode = '55000';
    end if;
  end if;
  -- An earlier accepted version of this quotation is superseded; the open draft is discarded.
  update public.quotation_versions v set status = 'superseded', superseded_at = now(), superseded_by_version_id = v_ver.id
  where v.quotation_id = v_q.id and v.status = 'accepted' returning v.id into v_superseded;
  update public.quotation_versions v set status = 'discarded', discarded_at = now(), discarded_by = (select auth.uid())
  where v.quotation_id = v_q.id and v.status in ('draft', 'ready') returning v.id into v_discarded;
  update public.quotation_versions v
  set status = 'accepted', accepted_at = now(), accepted_by = (select auth.uid()), accepted_tier = p_tier_key,
      acceptance_evidence_id = p_evidence_id, row_version = v.row_version + 1, updated_by = (select auth.uid())
  where v.id = v_ver.id returning * into v_ver;
  update public.quotations q set accepted_version_id = v_ver.id, row_version = q.row_version + 1, updated_at = now()
  where q.id = v_q.id;
  perform authz.write_audit('quotation.accepted', v_ver.legal_entity_id, v_q.branch_id, 'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_q.id, 'versionNo', v_ver.version_no, 'tierKey', p_tier_key, 'evidenceId', p_evidence_id,
      'discardedVersionId', v_discarded, 'supersededVersionId', v_superseded));
  v_result := jsonb_build_object('status', 'accepted', 'acceptedTier', p_tier_key, 'quotationId', v_q.id,
    'discardedVersionId', v_discarded, 'supersededVersionId', v_superseded);
  perform authz.finance_remember(v_ver.legal_entity_id, p_request_id, 'quotation_accept', v_payload, v_result);
  return v_result;
end;
$$;

create function public.quotation_decline(p_version_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_payload jsonb := jsonb_build_object('versionId', p_version_id, 'rowVersion', p_expected_row_version, 'reason', p_reason);
  v_result jsonb;
begin
  v_ver := authz.lock_quotation_version(p_version_id);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_ver.legal_entity_id, p_request_id, 'quotation_decline', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_ver.status = 'expired' then
    raise exception 'quotation_expired' using errcode = '55000';
  end if;
  if v_ver.status <> 'sent' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_reason is null or p_reason not in ('price', 'dates', 'changed_plans', 'chose_other', 'no_response', 'other') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  update public.quotation_versions v
  set status = 'declined', declined_at = now(), declined_by = (select auth.uid()), decline_reason = p_reason,
      row_version = v.row_version + 1, updated_by = (select auth.uid())
  where v.id = v_ver.id returning * into v_ver;
  perform authz.write_audit('quotation.declined', v_ver.legal_entity_id,
    (select q.branch_id from public.quotations q where q.id = v_ver.quotation_id), 'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_ver.quotation_id, 'versionNo', v_ver.version_no, 'reason', p_reason));
  v_result := jsonb_build_object('status', 'declined', 'rowVersion', v_ver.row_version);
  perform authz.finance_remember(v_ver.legal_entity_id, p_request_id, 'quotation_decline', v_payload, v_result);
  return v_result;
end;
$$;

create function public.quotation_new_version(p_quotation_id uuid, p_base_version_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_q public.quotations%rowtype;
  v_base public.quotation_versions%rowtype;
  v_open public.quotation_versions%rowtype;
  v_new public.quotation_versions%rowtype;
begin
  select * into v_q from public.quotations q where q.id = p_quotation_id for update;
  perform authz.refuse_removed_deal(coalesce(v_q.deal_id, v_q.linked_deal_id));
  if v_q.id is null or not authz.quotation_can_edit(v_q.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  perform authz.quotation_expire_due(v_q.id);
  if v_q.converted_at is not null then
    raise exception 'quotation_converted' using errcode = '55000';
  end if;
  select * into v_open from public.quotation_versions v where v.quotation_id = v_q.id and v.status in ('draft', 'ready');
  if v_open.id is not null then
    return jsonb_build_object('versionId', v_open.id, 'versionNo', v_open.version_no, 'rowVersion', v_open.row_version,
      'created', false);
  end if;
  select * into v_base from public.quotation_versions v where v.id = p_base_version_id and v.quotation_id = v_q.id;
  if v_base.id is null or v_base.status = 'discarded' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'baseVersionId';
  end if;
  insert into public.quotation_versions (quotation_id, legal_entity_id, version_no, based_on_version_id, trip_destination,
    trip_scope, trip_start, trip_end, adults, children_with_bed, children_no_bed, infants, pax_remarks, requirements_note,
    content, created_by, updated_by)
  select v_q.id, v_q.legal_entity_id, (select max(x.version_no) + 1 from public.quotation_versions x where x.quotation_id = v_q.id),
    v_base.id, v_base.trip_destination, v_base.trip_scope, v_base.trip_start, v_base.trip_end, v_base.adults,
    v_base.children_with_bed, v_base.children_no_bed, v_base.infants, v_base.pax_remarks, v_base.requirements_note,
    v_base.content, (select auth.uid()), (select auth.uid())
  returning * into v_new;
  insert into public.quotation_version_tiers (quotation_version_id, legal_entity_id, tier_key, label)
  select v_new.id, t.legal_entity_id, t.tier_key, t.label from public.quotation_version_tiers t where t.quotation_version_id = v_base.id;
  insert into public.quotation_version_items (quotation_version_id, legal_entity_id, item_no, service_type, tier_key, facts)
  select v_new.id, i.legal_entity_id, i.item_no, i.service_type, i.tier_key, i.facts
  from public.quotation_version_items i where i.quotation_version_id = v_base.id;
  insert into public.quotation_version_contacts (quotation_version_id, legal_entity_id, contact_name, mobile, email, company_name,
    booking_for, updated_by)
  select v_new.id, c.legal_entity_id, c.contact_name, c.mobile, c.email, c.company_name, c.booking_for, (select auth.uid())
  from public.quotation_version_contacts c where c.quotation_version_id = v_base.id;
  perform authz.quotation_copy_lines(v_base.id, v_new.id);
  perform authz.write_audit('quotation.version_opened', v_q.legal_entity_id, v_q.branch_id, 'quotation_version', v_new.id, null,
    jsonb_build_object('quotationId', v_q.id, 'versionNo', v_new.version_no, 'basedOnVersionId', v_base.id));
  return jsonb_build_object('versionId', v_new.id, 'versionNo', v_new.version_no, 'rowVersion', v_new.row_version, 'created', true);
end;
$$;

create function public.quotation_discard(p_version_id uuid, p_expected_row_version integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
begin
  v_ver := authz.lock_quotation_version(p_version_id);
  if v_ver.status = 'discarded' then
    return jsonb_build_object('status', 'discarded', 'rowVersion', v_ver.row_version);
  end if;
  if v_ver.status not in ('draft', 'ready') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  update public.quotation_versions v
  set status = 'discarded', discarded_at = now(), discarded_by = (select auth.uid()), row_version = v.row_version + 1,
      updated_by = (select auth.uid())
  where v.id = v_ver.id returning * into v_ver;
  perform authz.write_audit('quotation.version_discarded', v_ver.legal_entity_id,
    (select q.branch_id from public.quotations q where q.id = v_ver.quotation_id), 'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_ver.quotation_id, 'versionNo', v_ver.version_no));
  return jsonb_build_object('status', 'discarded', 'rowVersion', v_ver.row_version);
end;
$$;

create function public.quotation_link_deal(p_quotation_id uuid, p_deal_id uuid, p_expected_row_version integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_q public.quotations%rowtype;
  v_lead public.crm_leads%rowtype;
  v_deal public.deals%rowtype;
begin
  select * into v_q from public.quotations q where q.id = p_quotation_id for update;
  if v_q.id is null or not authz.quotation_can_edit(v_q.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_q.lead_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'quotation';
  end if;
  perform authz.refuse_removed_deal(p_deal_id);
  if p_deal_id is null or not authz.can_edit_booking_draft(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_q.linked_deal_id is not null then
    if v_q.linked_deal_id = p_deal_id then
      return jsonb_build_object('quotationId', v_q.id, 'linkedDealId', v_q.linked_deal_id, 'rowVersion', v_q.row_version);
    end if;
    -- A link never changes.
    raise exception 'quotation_already_linked' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_q.row_version);
  if v_q.accepted_version_id is null then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id for no key update;
  if authz.deal_not_active(p_deal_id) then
    raise exception 'deal_not_active' using errcode = '55000';
  end if;
  select * into v_lead from public.crm_leads l where l.id = v_q.lead_id;
  if v_deal.source_lead_id is null or v_deal.source_lead_id is distinct from v_lead.source_lead_id
     or v_deal.source_portal is distinct from v_lead.source_portal or v_deal.legal_entity_id <> v_q.legal_entity_id then
    raise exception 'deal_not_from_lead' using errcode = '22023';
  end if;
  if v_deal.branch_id <> v_q.branch_id then
    raise exception 'branch_mismatch' using errcode = '22023';
  end if;
  -- Review E2-4: the Deal already has an accepted quotation of its own or a linked one.
  if exists (select 1 from public.quotations o
             where o.id <> v_q.id and (o.linked_deal_id = p_deal_id or (o.deal_id = p_deal_id and o.accepted_version_id is not null))) then
    raise exception 'deal_already_linked' using errcode = '55000';
  end if;
  update public.quotations q
  set linked_deal_id = p_deal_id, linked_by = (select auth.uid()), linked_at = now(), row_version = q.row_version + 1, updated_at = now()
  where q.id = v_q.id returning * into v_q;
  perform authz.write_audit('quotation.deal_linked', v_q.legal_entity_id, v_q.branch_id, 'quotation', v_q.id, null,
    jsonb_build_object('dealId', p_deal_id, 'leadId', v_q.lead_id));
  return jsonb_build_object('quotationId', v_q.id, 'linkedDealId', p_deal_id, 'rowVersion', v_q.row_version);
end;
$$;

create function public.quotation_convert_to_booking(p_version_id uuid, p_expected_content_hash text, p_request_id uuid)
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
  v_opened := public.booking_open_draft(v_deal);
  v_booking := (v_opened ->> 'versionId')::uuid;
  v_rv := (v_opened ->> 'rowVersion')::integer;
  if exists (select 1 from public.booking_versions b
             where b.id = v_booking
               and (b.service_type <> 'package' or b.revises_version_id is not null
                    or b.trip_destination is not null or b.trip_scope is not null
                    or b.trip_start is not null or b.trip_end is not null))
     or exists (select 1 from public.service_item_facts f where f.booking_version_id = v_booking)
     or exists (select 1 from public.booking_version_contacts c where c.booking_version_id = v_booking)
     or exists (select 1 from public.booking_version_commercials c where c.version_id = v_booking)
     or exists (select 1 from public.booking_version_instalments p where p.booking_version_id = v_booking) then
    raise exception 'draft_not_empty' using errcode = '55000';
  end if;

  insert into public.quotation_conversions (quotation_version_id, quotation_id, legal_entity_id, deal_id, booking_version_id,
    accepted_tier, request_id, created_by)
  values (v_ver.id, v_q.id, v_q.legal_entity_id, v_deal, v_booking, v_ver.accepted_tier, p_request_id, (select auth.uid()))
  returning * into v_conv;

  if coalesce(v_ver.trip_destination, v_ver.trip_scope) is not null or coalesce(v_ver.trip_start, v_ver.trip_end) is not null then
    v_rv := (public.booking_trip_save(v_booking, v_rv, jsonb_build_object('destination', v_ver.trip_destination,
      'scope', v_ver.trip_scope, 'start', to_char(v_ver.trip_start, 'YYYY-MM-DD'), 'end', to_char(v_ver.trip_end, 'YYYY-MM-DD'))) ->> 'rowVersion')::integer;
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
      'tierKey', v_ver.accepted_tier));
  return jsonb_build_object('outcome', 'created', 'bookingVersionId', v_booking, 'dealId', v_deal, 'itemsCreated', v_count);
end;
$$;

-- ===========================================================================
-- 6. Reads
-- ===========================================================================

create function public.quotation_list(p_subject_kind text, p_subject_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_subject_id is null or p_subject_kind is null
     or (p_subject_kind = 'deal' and not authz.can_edit_booking_draft(p_subject_id))
     or (p_subject_kind = 'lead' and not authz.quotation_lead_editor(p_subject_id))
     or p_subject_kind not in ('lead', 'deal')
     or (p_subject_kind = 'deal' and exists (select 1 from public.deals d where d.id = p_subject_id and d.removed_at is not null)) then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
        'quotationId', q.id, 'reference', q.reference, 'title', q.title, 'rowVersion', q.row_version,
        'subjectKind', case when q.lead_id is not null then 'lead' else 'deal' end,
        'leadId', q.lead_id, 'dealId', q.deal_id, 'linkedDealId', q.linked_deal_id,
        'acceptedVersionId', q.accepted_version_id, 'converted', q.converted_at is not null,
        'bookingVersionId', (select c.booking_version_id from public.quotation_conversions c where c.quotation_id = q.id),
        'createdAt', q.created_at,
        'versions', (select jsonb_agg(authz.quotation_version_json(v) order by v.version_no desc)
                     from public.quotation_versions v where v.quotation_id = q.id)) order by q.created_at desc, q.id)
    from public.quotations q
    where (p_subject_kind = 'lead' and q.lead_id = p_subject_id)
       or (p_subject_kind = 'deal' and (q.deal_id = p_subject_id or q.linked_deal_id = p_subject_id))), '[]'::jsonb);
end;
$$;

create function public.quotation_get(p_version_id uuid) returns jsonb
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
  if authz.quotation_money_can_read(v_q.id) then
    v_result := v_result || jsonb_build_object('money', authz.quotation_money_json(v_ver.id));
  end if;
  return v_result;
end;
$$;

create function public.quotation_link_candidates(p_quotation_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_q public.quotations;
  v_lead public.crm_leads;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_q from public.quotations q where q.id = p_quotation_id;
  if v_q.id is null or not authz.quotation_can_edit(v_q.id) or authz.quotation_deal_removed(v_q.id) then
    return null;
  end if;
  if v_q.lead_id is null then
    return '[]'::jsonb;
  end if;
  select * into v_lead from public.crm_leads l where l.id = v_q.lead_id;
  return coalesce((
    select jsonb_agg(jsonb_build_object('dealId', d.id, 'reference', d.reference, 'title', d.title,
        'branchName', (select b.name from public.branches b where b.id = d.branch_id),
        'sameBranch', d.branch_id = v_q.branch_id, 'active', d.removed_at is null and not authz.deal_not_active(d.id),
        'linkable', d.branch_id = v_q.branch_id and d.removed_at is null and not authz.deal_not_active(d.id)
                    and authz.can_edit_booking_draft(d.id)
                    and not exists (select 1 from public.quotations o where o.id <> v_q.id and o.accepted_version_id is not null
                                    and (o.deal_id = d.id or o.linked_deal_id = d.id))) order by d.created_at, d.id)
    from public.deals d
    where d.legal_entity_id = v_q.legal_entity_id and d.source_portal = v_lead.source_portal
      and d.source_lead_id = v_lead.source_lead_id and authz.can_read_deal(d.id)), '[]'::jsonb);
end;
$$;

-- ===========================================================================
-- 7. Replaced bodies (mechanical copies of the latest definitions plus the
--    B1.2 lines marked in comments)
-- ===========================================================================

-- Replaces 20261119000100: hotel extraBeds, childrenWithoutBed, bedRemarks.
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
    when 'transfer' then array['route', 'date', 'vehicleType', 'passengers', 'pickupTime', 'notes', 'pickup', 'drop']
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
           or exists (select 1 from jsonb_object_keys(v_seg) k where k not in ('from', 'to', 'date', 'flex'))
           or not authz.b11_place_ok(v_seg -> 'from') or not authz.b11_place_ok(v_seg -> 'to')
           or not authz.sf_text_ok(v_seg -> 'flex', 60, false) then
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

-- Replaces 20261119000300: bedRemarks is a "choice" field in revisions.
create or replace function authz.revision_field_class(p_field text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_field ~ '^items\.[0-9]+\.purchaseBudgetPaise$' then 'internal'
    when p_field ~ '^items\.[0-9]+\.(hotelName|city|area|roomType|mealPlan|inclusions|exclusions|specialRequests|preferences|notes|bedRemarks|route|pickup|drop|vehicleType|name|cabin|preferredTime|assistance|purpose|officeCity)$'
      then 'choice'
    when p_field in ('travellers.specialNeeds', 'trip.destination', 'contacts.contactName', 'contacts.mobile',
                     'contacts.email', 'contacts.contactConfirmed') then 'choice'
    else 'material' end
$$;

-- Replaces 20261120000100: adds sourceQuotation.
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
  return v_result;
end;
$$;

-- Replaces 20261120000100: quotation acceptance and quote_acceptance_stale.
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
    case when exists (select 1 from public.booking_version_contacts c
                      join public.customer_billing_profiles b on b.deal_id = d.id
                      where c.booking_version_id = v.id and c.booking_for = 'business' and b.gstin is null)
      then 'gstin_missing' end,
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

-- Replaces 20261120000100: quotation acceptance, quote_acceptance_stale, quote_details_changed.
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

-- ===========================================================================
-- 8. Grants
-- ===========================================================================

revoke all on function
  authz.quotations_guard(), authz.quotation_versions_guard(), authz.quotation_child_guard(),
  authz.quotation_evidence_guard(), authz.quotation_conversions_guard(),
  authz.quotation_money_check(uuid), authz.quotation_money_hash(uuid), authz.quotation_money_json(uuid),
  authz.quotation_copy_lines(uuid, uuid), authz.quotation_money_to_booking(uuid, uuid, text),
  authz.quotation_money_can_read(uuid), authz.quotation_money_can_edit(uuid),
  authz.quotation_lead_editor(uuid), authz.quotation_can_edit(uuid), authz.quotation_deal(uuid),
  authz.quotation_status(public.quotation_versions), authz.quotation_expire_due(uuid), authz.quotation_content_hash(uuid),
  authz.quotation_issues(uuid), authz.lock_quotation_draft(uuid), authz.bump_quotation_version(uuid),
  authz.quotation_conversion_item_map(uuid), authz.booking_quote_money_signature(uuid),
  authz.booking_quote_facts_signature(uuid), authz.booking_quote_minor_signature(uuid),
  authz.booking_quote_acceptance_ok(uuid), authz.booking_quote_change(uuid), authz.quotation_content_ok(jsonb),
  authz.quotation_version_json(public.quotation_versions), authz.lock_quotation_version(uuid),
  authz.quotation_item_facts(text, text, jsonb, uuid), authz.quotation_conversion_items_guard(),
  authz.booking_quote_pax_differs(uuid), authz.quotation_deal_removed(uuid), authz.booking_quote_party_stale(uuid)
from public, anon, authenticated, service_role;

revoke all on function
  public.quotation_create(text, uuid, text, uuid),
  public.quotation_version_save(uuid, integer, jsonb),
  public.quotation_tiers_save(uuid, integer, jsonb),
  public.quotation_item_add(uuid, integer, text, text, jsonb),
  public.quotation_item_save(uuid, uuid, integer, text, jsonb),
  public.quotation_item_remove(uuid, uuid, integer),
  public.quotation_contacts_save(uuid, integer, jsonb),
  public.quotation_mark_ready(uuid, integer),
  public.quotation_mark_sent(uuid, text, text, uuid),
  public.quotation_evidence_begin(uuid, text, text, text, integer, text),
  public.quotation_evidence_finish(uuid, boolean),
  public.quotation_evidence_remove(uuid),
  public.quotation_evidence_authorize_download(uuid),
  public.quotation_accept(uuid, text, uuid, text, uuid),
  public.quotation_decline(uuid, integer, text, uuid),
  public.quotation_new_version(uuid, uuid, uuid),
  public.quotation_discard(uuid, integer),
  public.quotation_link_deal(uuid, uuid, integer),
  public.quotation_convert_to_booking(uuid, text, uuid),
  public.quotation_list(text, uuid),
  public.quotation_get(uuid),
  public.quotation_link_candidates(uuid),
  public.intake_checklist(uuid),
  public.booking_form_get(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.quotation_create(text, uuid, text, uuid),
  public.quotation_version_save(uuid, integer, jsonb),
  public.quotation_tiers_save(uuid, integer, jsonb),
  public.quotation_item_add(uuid, integer, text, text, jsonb),
  public.quotation_item_save(uuid, uuid, integer, text, jsonb),
  public.quotation_item_remove(uuid, uuid, integer),
  public.quotation_contacts_save(uuid, integer, jsonb),
  public.quotation_mark_ready(uuid, integer),
  public.quotation_mark_sent(uuid, text, text, uuid),
  public.quotation_evidence_begin(uuid, text, text, text, integer, text),
  public.quotation_evidence_finish(uuid, boolean),
  public.quotation_evidence_remove(uuid),
  public.quotation_evidence_authorize_download(uuid),
  public.quotation_accept(uuid, text, uuid, text, uuid),
  public.quotation_decline(uuid, integer, text, uuid),
  public.quotation_new_version(uuid, uuid, uuid),
  public.quotation_discard(uuid, integer),
  public.quotation_link_deal(uuid, uuid, integer),
  public.quotation_convert_to_booking(uuid, text, uuid),
  public.quotation_list(text, uuid),
  public.quotation_get(uuid),
  public.quotation_link_candidates(uuid),
  public.intake_checklist(uuid),
  public.booking_form_get(uuid)
to authenticated;

commit;
