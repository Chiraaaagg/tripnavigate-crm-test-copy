-- TripNavigate CRM - Visa and Passport desk build, track A (1 of 3): schema.
--
-- Contract: implementation/visa-build-2026-11-07/contract.md (frozen 8 Nov
-- 2026), sections 4 (definitions, document catalogue), 5.1-5.4 (data model),
-- 5.8 (legacy rows) and 16 (lead decisions).
--
-- What changes:
--   1. public.visa_applications gains the passenger-row, applied, decision,
--      handover, closure, removal, traveller-snapshot and re-application
--      columns (all nullable; checks hold for every existing row). The inline
--      unique (task_id, traveller_seq) constraint (real name checked:
--      visa_applications_task_id_traveller_seq_key) is replaced by a partial
--      unique index over current applications (superseded_at is null), so a
--      re-application after a refusal is possible (QB9). References are
--      unique per task ignoring case, superseded rows included (QB10).
--   2. New table public.visa_application_documents (per-passenger document
--      list: received / not received, soft removal) with the frozen 25-item
--      catalogue authz.visa_document_catalogue().
--   3. New table public.visa_result_notices (one per application outcome,
--      approved / rejected, for the Deal's Sales owner; recipient computed at
--      read time).
--   4. public.department_cost_entries gains application_id (visa only, new
--      entries only; immutable by the replaced guard). public.department_evidence
--      gains visa_document_id.
--   5. Guard trigger authz.visa_applications_guard (no DELETE; identity
--      immutable; seq changes only under authz.visa_transition = 'relink';
--      closed rows change only by supersession; closed_at / superseded_at set
--      once). authz.visa_application_closed(a) becomes closed_at is not null.
--   6. Legacy rows (section 5.8; expected to touch no row on live): documents
--      map -> document rows, appointment_at -> IST date/time, submitted_at ->
--      applied_on, old-rule closed rows -> closed_reason 'legacy', traveller
--      snapshots, duplicate references deduplicated with an audit row.
--
-- No new command, read or grant here (0110, 0120). The new tables have RLS
-- on, a restrictive valid-session policy and no table privilege for anyone.
--
-- Rollback (forward-only): a new migration dropping the guard trigger and
-- restoring authz.visa_application_closed from 20261119000500. Columns and
-- rows are kept (nothing is ever deleted).

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Document catalogue (contract section 4, frozen)
-- ===========================================================================

create function authz.visa_document_catalogue() returns table (code text, label text, ord integer)
language sql immutable set search_path = '' as $$
  select v.code, v.label, v.ord from (values
    ('passport_copy', 'Passport copy (front and back)', 1),
    ('photo', 'Photo, white background', 2),
    ('bank_statement', 'Bank statement (6 months)', 3),
    ('parent_passport', 'Parent’s passport copy', 4),
    ('travel_insurance', 'Travel insurance', 5),
    ('stay_proof', 'Hotel booking', 6),
    ('birth_certificate', 'Birth certificate', 7),
    ('parent_consent', 'Parents’ consent letter', 8),
    ('onward_ticket', 'Onward flight ticket', 9),
    ('original_passport', 'Original passport', 10),
    ('old_passports', 'Old passports', 11),
    ('passport_size_photos_2', 'Passport-size photos (2)', 12),
    ('aadhaar_card', 'Aadhaar card', 13),
    ('pan_card', 'PAN card', 14),
    ('itr_last_3_years', 'ITR (last 3 years)', 15),
    ('salary_slips_3_months', 'Salary slips (3 months)', 16),
    ('employment_letter_or_noc', 'Employment letter or NOC', 17),
    ('leave_letter', 'Leave letter', 18),
    ('cover_letter', 'Cover letter', 19),
    ('return_flight_booking', 'Return flight booking', 20),
    ('visa_application_form_signed', 'Visa application form (signed)', 21),
    ('marriage_certificate', 'Marriage certificate', 22),
    ('invitation_letter', 'Invitation letter', 23),
    ('business_registration_documents', 'Business registration documents', 24),
    ('school_or_college_id', 'School or college ID', 25)
  ) as v (code, label, ord)
$$;

-- Label key: trimmed, single spaces, lower case (contract section 4).
create function authz.visa_label_key(p_label text) returns text
language sql immutable set search_path = '' as $$
  select lower(regexp_replace(btrim(p_label), '\s+', ' ', 'g'))
$$;

create function authz.visa_catalogue_code_ok(p_code text) returns boolean
language sql immutable set search_path = '' as $$
  select p_code is null or exists (select 1 from authz.visa_document_catalogue() c where c.code = p_code)
$$;

-- Catalogue code of a label (by label key), else null.
create function authz.visa_catalogue_code_for(p_label text) returns text
language sql immutable set search_path = '' as $$
  select c.code from authz.visa_document_catalogue() c
  where authz.visa_label_key(c.label) = authz.visa_label_key(p_label)
  limit 1
$$;

revoke all on function authz.visa_document_catalogue(), authz.visa_label_key(text), authz.visa_catalogue_code_ok(text),
  authz.visa_catalogue_code_for(text)
from public, anon, authenticated, service_role;

-- ===========================================================================
-- 2. visa_applications: new columns (contract 5.1)
-- ===========================================================================

alter table public.visa_applications
  add column appointment_date date check (appointment_date between date '2000-01-01' and date '2100-12-31'),
  add column appointment_time text check (appointment_time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  add column remark text check (length(remark) between 1 and 300),
  add column visa_kind text check (visa_kind in ('e_visa', 'sticker')),
  add column jurisdiction_required boolean,
  add column jurisdiction_place text check (length(jurisdiction_place) between 1 and 120),
  add column passport_taken_at timestamptz,
  add column passport_taken_by uuid references public.staff_profiles (user_id),
  add column applied_on date,
  add column applied_remark text check (length(applied_remark) between 1 and 300),
  add column club_id uuid,
  add column club_size smallint check (club_size between 2 and 100),
  add column decision_remark text check (length(decision_remark) between 1 and 300),
  add column refusal_reason text check (length(refusal_reason) between 3 and 300),
  add column decided_by uuid references public.staff_profiles (user_id),
  add column evisa_recipient_email text
    check (length(evisa_recipient_email) between 3 and 200 and evisa_recipient_email ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$'),
  add column evisa_sent_at timestamptz,
  add column evisa_sent_by uuid references public.staff_profiles (user_id),
  add column handover_method text check (handover_method in ('office', 'executive', 'courier', 'not_with_us')),
  add column courier_number text check (length(courier_number) between 1 and 80),
  add column handover_set_at timestamptz,
  add column handover_set_by uuid references public.staff_profiles (user_id),
  add column handover_remark text check (length(handover_remark) between 1 and 300),
  add column delivered_on date,
  add column delivered_at timestamptz,
  add column delivered_by uuid references public.staff_profiles (user_id),
  add column delivery_remark text check (length(delivery_remark) between 1 and 300),
  add column withdraw_reason text check (length(withdraw_reason) between 3 and 300),
  add column closed_at timestamptz,
  add column closed_by uuid references public.staff_profiles (user_id),
  add column closed_reason text
    check (closed_reason in ('evisa_sent', 'refusal_told', 'not_with_us', 'courier_dispatched', 'delivered',
                             'customer_informed', 'reapplied', 'legacy')),
  add column removed_at timestamptz,
  add column removed_version_id uuid references public.booking_versions (id),
  add column traveller_name_snapshot text check (length(traveller_name_snapshot) between 1 and 120),
  add column traveller_type_snapshot text check (traveller_type_snapshot in ('adult', 'child', 'infant')),
  add column reapplication_of_id uuid references public.visa_applications (id),
  add column superseded_at timestamptz,
  -- Deferred: the new application is inserted after the old one is superseded.
  add column superseded_by_id uuid references public.visa_applications (id) deferrable initially deferred,
  add constraint visa_applications_time_needs_date check (appointment_time is null or appointment_date is not null),
  add constraint visa_applications_jurisdiction_place check ((jurisdiction_required is true) = (jurisdiction_place is not null)),
  add constraint visa_applications_club_shape check ((club_id is null) = (club_size is null)),
  add constraint visa_applications_evisa_sent_by check ((evisa_sent_at is null) = (evisa_sent_by is null)),
  add constraint visa_applications_evisa_sent_email check (evisa_sent_at is null or evisa_recipient_email is not null),
  add constraint visa_applications_courier_number check ((handover_method = 'courier') = (courier_number is not null)),
  add constraint visa_applications_handover_set check ((handover_method is null) = (handover_set_at is null)),
  add constraint visa_applications_handover_set_by check ((handover_set_at is null) = (handover_set_by is null)),
  add constraint visa_applications_delivered_method check (delivered_on is null or handover_method in ('office', 'executive')),
  add constraint visa_applications_delivered_at check ((delivered_on is null) = (delivered_at is null)),
  add constraint visa_applications_delivered_by check ((delivered_at is null) = (delivered_by is null)),
  add constraint visa_applications_passport_taken_by check ((passport_taken_at is null) = (passport_taken_by is null)),
  add constraint visa_applications_closed_reason check ((closed_at is null) = (closed_reason is null)),
  add constraint visa_applications_removed_version check ((removed_at is null) = (removed_version_id is null)),
  add constraint visa_applications_superseded_shape check ((superseded_at is null) = (superseded_by_id is null));

-- Composite key for the entity-scoped foreign keys of the new tables.
alter table public.visa_applications add constraint visa_applications_entity_id_key unique (legal_entity_id, id);

-- QB9: one CURRENT application per traveller; the real name of the inline
-- constraint of 20261119000500:165 is checked before it is dropped.
do $$
begin
  if not exists (
    select 1 from pg_catalog.pg_constraint c
    where c.conrelid = 'public.visa_applications'::regclass and c.contype = 'u'
      and c.conname = 'visa_applications_task_id_traveller_seq_key'
      and pg_catalog.pg_get_constraintdef(c.oid) = 'UNIQUE (task_id, traveller_seq)') then
    raise exception 'visa_applications unique (task_id, traveller_seq) constraint has an unexpected name';
  end if;
end;
$$;
alter table public.visa_applications drop constraint visa_applications_task_id_traveller_seq_key;
create unique index visa_applications_current_seq_key on public.visa_applications (task_id, traveller_seq)
  where superseded_at is null;
create index visa_applications_current_task_idx on public.visa_applications (task_id) where superseded_at is null;
create index visa_applications_passport_taken_by_idx on public.visa_applications (passport_taken_by) where passport_taken_by is not null;
create index visa_applications_decided_by_idx on public.visa_applications (decided_by) where decided_by is not null;
create index visa_applications_evisa_sent_by_idx on public.visa_applications (evisa_sent_by) where evisa_sent_by is not null;
create index visa_applications_handover_set_by_idx on public.visa_applications (handover_set_by) where handover_set_by is not null;
create index visa_applications_delivered_by_idx on public.visa_applications (delivered_by) where delivered_by is not null;
create index visa_applications_closed_by_idx on public.visa_applications (closed_by) where closed_by is not null;
create index visa_applications_removed_version_idx on public.visa_applications (removed_version_id) where removed_version_id is not null;
create index visa_applications_reapplication_of_idx on public.visa_applications (reapplication_of_id) where reapplication_of_id is not null;
create index visa_applications_superseded_by_idx on public.visa_applications (superseded_by_id) where superseded_by_id is not null;

-- ===========================================================================
-- 3. visa_application_documents (contract 5.2)
-- ===========================================================================

create table public.visa_application_documents (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  task_id uuid not null,
  application_id uuid not null,
  catalogue_code text check (authz.visa_catalogue_code_ok(catalogue_code)),
  label text not null check (length(label) between 1 and 120 and label = regexp_replace(btrim(label), '\s+', ' ', 'g')),
  label_key text generated always as (lower(regexp_replace(btrim(label), '\s+', ' ', 'g'))) stored,
  source text not null check (source in ('sales', 'desk', 'legacy', 'copied')),
  status text not null default 'not_received' check (status in ('not_received', 'received')),
  received_at timestamptz,
  received_by uuid references public.staff_profiles (user_id),
  remark text check (length(remark) between 1 and 300),
  added_by uuid references public.staff_profiles (user_id),
  removed_at timestamptz,
  removed_by uuid references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (legal_entity_id, application_id) references public.visa_applications (legal_entity_id, id),
  check ((status = 'received') = (received_at is not null)),
  check (removed_at is null or status = 'not_received'),
  check ((removed_at is null) = (removed_by is null))
);
create unique index visa_application_documents_label_key on public.visa_application_documents (application_id, label_key)
  where removed_at is null;
create index visa_application_documents_application_idx on public.visa_application_documents (legal_entity_id, application_id);
create index visa_application_documents_app_idx on public.visa_application_documents (application_id);
create index visa_application_documents_task_idx on public.visa_application_documents (legal_entity_id, task_id);
create index visa_application_documents_task_only_idx on public.visa_application_documents (task_id);
create index visa_application_documents_received_by_idx on public.visa_application_documents (received_by) where received_by is not null;
create index visa_application_documents_added_by_idx on public.visa_application_documents (added_by) where added_by is not null;
create index visa_application_documents_removed_by_idx on public.visa_application_documents (removed_by) where removed_by is not null;
comment on table public.visa_application_documents is
  'Documents needed from one visa or passport applicant (received / not received; soft removal). Written only by desk commands that lock the parent application and bump its row_version. No Data API read.';

create function authz.visa_application_documents_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'visa documents cannot be deleted' using errcode = '42501';
  end if;
  if old.removed_at is not null then
    raise exception 'a removed visa document is immutable' using errcode = '42501';
  end if;
  -- label_key is generated (null in NEW before the row is stored); label is compared instead.
  if (to_jsonb(new) - array['status', 'received_at', 'received_by', 'remark', 'removed_at', 'removed_by', 'updated_at', 'label_key'])
     <> (to_jsonb(old) - array['status', 'received_at', 'received_by', 'remark', 'removed_at', 'removed_by', 'updated_at', 'label_key']) then
    raise exception 'visa document identity columns are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger visa_application_documents_a_guard
  before update or delete on public.visa_application_documents
  for each row execute function authz.visa_application_documents_guard();

-- ===========================================================================
-- 4. visa_result_notices (contract 5.3)
-- ===========================================================================

create table public.visa_result_notices (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null references public.branches (id),
  deal_id uuid not null,
  task_id uuid not null,
  application_id uuid not null,
  traveller_seq integer not null check (traveller_seq between 1 and 100),
  outcome text not null check (outcome in ('approved', 'rejected')),
  created_at timestamptz not null default now(),
  created_by uuid references public.staff_profiles (user_id),
  seen_at timestamptz,
  seen_by uuid references public.staff_profiles (user_id),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (legal_entity_id, application_id) references public.visa_applications (legal_entity_id, id),
  unique (application_id, outcome),
  check ((seen_at is null) = (seen_by is null))
);
create index visa_result_notices_deal_idx on public.visa_result_notices (legal_entity_id, deal_id);
create index visa_result_notices_deal_only_idx on public.visa_result_notices (deal_id);
create index visa_result_notices_task_idx on public.visa_result_notices (legal_entity_id, task_id);
create index visa_result_notices_application_idx on public.visa_result_notices (legal_entity_id, application_id);
create index visa_result_notices_branch_idx on public.visa_result_notices (branch_id);
create index visa_result_notices_created_by_idx on public.visa_result_notices (created_by) where created_by is not null;
create index visa_result_notices_seen_by_idx on public.visa_result_notices (seen_by) where seen_by is not null;
create index visa_result_notices_unseen_idx on public.visa_result_notices (deal_id) where seen_at is null;
comment on table public.visa_result_notices is
  'One notice per visa application outcome (approved / rejected) for the Deal''s Sales owner (branch Manager when none), computed at read time. Only seen_at / seen_by are set, once. No Data API read.';

create function authz.visa_result_notices_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'visa result notices cannot be deleted' using errcode = '42501';
  end if;
  if old.seen_at is not null
     or (to_jsonb(new) - array['seen_at', 'seen_by']) <> (to_jsonb(old) - array['seen_at', 'seen_by']) then
    raise exception 'a visa result notice changes only once, when seen' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger visa_result_notices_a_guard
  before update or delete on public.visa_result_notices
  for each row execute function authz.visa_result_notices_guard();

-- ===========================================================================
-- 5. Cost entries and evidence links (contract 5.4)
-- ===========================================================================

alter table public.department_cost_entries
  add column application_id uuid,
  add constraint department_cost_entries_application_fk
    foreign key (legal_entity_id, application_id) references public.visa_applications (legal_entity_id, id),
  add constraint department_cost_entries_application_visa check (application_id is null or department = 'visa');
create index department_cost_entries_application_idx on public.department_cost_entries (application_id)
  where application_id is not null;
create index department_cost_entries_application_fk_idx on public.department_cost_entries (legal_entity_id, application_id)
  where application_id is not null;

-- Replaces 20261201000200: application_id joins the immutable columns
-- (Visa build 20261202000100). Accepted rows stay final; legacy rows keep
-- application_id null forever.
create or replace function authz.department_cost_entries_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'cost entries cannot be deleted' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.task_id is distinct from old.task_id or new.deal_id is distinct from old.deal_id
     or new.legal_entity_id is distinct from old.legal_entity_id or new.department is distinct from old.department
     or new.request_id is distinct from old.request_id or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at
     -- Flight build (20261201000200): the batch a direct payment belongs to.
     or new.supplier_id is distinct from old.supplier_id or new.flight_batch_id is distinct from old.flight_batch_id
     -- Visa build (20261202000100): the applicant a visa fee belongs to.
     or new.application_id is distinct from old.application_id then
    raise exception 'cost entry identity columns are immutable' using errcode = '42501';
  end if;
  if old.expense_status = 'accepted' then
    raise exception 'accepted expense records are immutable' using errcode = '42501';
  end if;
  if old.expense_status = 'submitted' and new.expense_status not in ('accepted', 'returned', 'submitted') then
    raise exception 'a submitted expense record changes only by review' using errcode = '42501';
  end if;
  if old.expense_status = 'submitted'
     and (to_jsonb(new) - array['expense_status', 'reviewed_by', 'reviewed_at', 'return_reason', 'row_version', 'updated_at'])
         <> (to_jsonb(old) - array['expense_status', 'reviewed_by', 'reviewed_at', 'return_reason', 'row_version', 'updated_at']) then
    raise exception 'a submitted expense record changes only by review' using errcode = '42501';
  end if;
  return new;
end;
$$;

alter table public.department_evidence
  add column visa_document_id uuid references public.visa_application_documents (id),
  add constraint department_evidence_visa_document_app check (visa_document_id is null or application_id is not null);
create index department_evidence_visa_document_idx on public.department_evidence (visa_document_id)
  where visa_document_id is not null;

-- ===========================================================================
-- 6. Row level security of the new tables (no Data API access)
-- ===========================================================================

alter table public.visa_application_documents enable row level security;
alter table public.visa_result_notices enable row level security;
create policy require_valid_session on public.visa_application_documents as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
create policy require_valid_session on public.visa_result_notices as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.visa_application_documents, public.visa_result_notices from public, anon, authenticated, service_role;

-- ===========================================================================
-- 7. Legacy rows (contract 5.8; expected to touch no row on live)
-- ===========================================================================

-- 7.1 Documents map -> rows (missing -> not_received; received / checked -> received).
insert into public.visa_application_documents (legal_entity_id, task_id, application_id, catalogue_code, label, source,
  status, received_at, created_at, updated_at)
select a.legal_entity_id, a.task_id, a.id, c.code,
       left(regexp_replace(btrim(coalesce(c.label, initcap(replace(e.key, '_', ' ')))), '\s+', ' ', 'g'), 120),
       'legacy',
       case when e.value in ('received', 'checked') then 'received' else 'not_received' end,
       case when e.value in ('received', 'checked') then a.updated_at end,
       a.created_at, a.updated_at
from public.visa_applications a
cross join lateral jsonb_each_text(a.documents) e
left join authz.visa_document_catalogue() c on c.code = e.key
where jsonb_typeof(a.documents) = 'object'
on conflict do nothing;

-- 7.2 - 7.4 and 7.6: appointment, applied date, closure under the old rule, snapshots.
update public.visa_applications a
set appointment_date = case when a.appointment_at is not null then (a.appointment_at at time zone 'Asia/Kolkata')::date end,
    appointment_time = case when a.appointment_at is not null then to_char(a.appointment_at at time zone 'Asia/Kolkata', 'HH24:MI') end,
    applied_on = case when a.submitted_at is not null then (a.submitted_at at time zone 'Asia/Kolkata')::date end,
    closed_at = case when (a.state = 'issued' and a.documents_returned_at is not null)
                       or (a.state in ('refused', 'withdrawn') and a.customer_informed_at is not null)
                     then coalesce(a.documents_returned_at, a.customer_informed_at) end,
    closed_by = case when (a.state = 'issued' and a.documents_returned_at is not null)
                       or (a.state in ('refused', 'withdrawn') and a.customer_informed_at is not null)
                     then coalesce(a.documents_returned_by, a.updated_by) end,
    closed_reason = case when (a.state = 'issued' and a.documents_returned_at is not null)
                           or (a.state in ('refused', 'withdrawn') and a.customer_informed_at is not null)
                         then 'legacy' end,
    traveller_name_snapshot = (select s.full_name from public.booking_version_travellers s
                               where s.booking_version_id = authz.task_current_version(a.task_id) and s.seq = a.traveller_seq),
    traveller_type_snapshot = (select s.traveller_type from public.booking_version_travellers s
                               where s.booking_version_id = authz.task_current_version(a.task_id) and s.seq = a.traveller_seq)
where true;

-- QB10 defensive: duplicate legacy references within a task get " (2)", " (3)".
do $$
declare
  r record;
begin
  for r in
    select x.id, x.legal_entity_id, x.task_id, x.traveller_seq, x.deal_id, x.n, x.reference
    from (select a.*, row_number() over (partition by a.task_id, lower(a.reference) order by a.created_at, a.id) as n
          from public.visa_applications a where a.reference is not null) x
    where x.n > 1
  loop
    update public.visa_applications a
    set reference = left(r.reference, 120 - length(' (' || r.n || ')')) || ' (' || r.n || ')'
    where a.id = r.id;
    perform authz.write_audit('visa.reference_deduplicated', r.legal_entity_id,
      (select d.branch_id from public.deals d where d.id = r.deal_id), 'visa_application', r.id, null,
      jsonb_build_object('taskId', r.task_id, 'seq', r.traveller_seq));
  end loop;
end;
$$;
create unique index visa_applications_reference_key on public.visa_applications (task_id, lower(reference))
  where reference is not null;

-- ===========================================================================
-- 8. Guard trigger and closure rule
-- ===========================================================================

create function authz.visa_applications_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'visa applications cannot be deleted' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.task_id is distinct from old.task_id
     or new.service_item_id is distinct from old.service_item_id or new.deal_id is distinct from old.deal_id
     or new.legal_entity_id is distinct from old.legal_entity_id or new.created_at is distinct from old.created_at
     or new.reapplication_of_id is distinct from old.reapplication_of_id then
    raise exception 'visa application identity columns are immutable' using errcode = '42501';
  end if;
  if new.traveller_seq is distinct from old.traveller_seq
     and coalesce(current_setting('authz.visa_transition', true), '') <> 'relink' then
    raise exception 'a visa application keeps its traveller' using errcode = '42501';
  end if;
  if old.closed_at is not null
     and (to_jsonb(new) - array['superseded_at', 'superseded_by_id', 'row_version', 'updated_at', 'updated_by'])
         <> (to_jsonb(old) - array['superseded_at', 'superseded_by_id', 'row_version', 'updated_at', 'updated_by']) then
    raise exception 'a closed visa application changes only by re-application' using errcode = '42501';
  end if;
  if (old.closed_at is not null and new.closed_at is distinct from old.closed_at)
     or (old.superseded_at is not null
         and (new.superseded_at is distinct from old.superseded_at or new.superseded_by_id is distinct from old.superseded_by_id)) then
    raise exception 'closure and supersession are final' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger visa_applications_a_guard
  before update or delete on public.visa_applications
  for each row execute function authz.visa_applications_guard();

-- Replaces 20261119000500 (same signature): closed = closed_at set (section 7).
create or replace function authz.visa_application_closed(a public.visa_applications) returns boolean
language sql immutable set search_path = '' as $$
  select a.closed_at is not null
$$;

revoke all on function authz.visa_application_documents_guard(), authz.visa_result_notices_guard(),
  authz.visa_applications_guard(), authz.visa_application_closed(public.visa_applications)
from public, anon, authenticated, service_role;

comment on table public.visa_applications is
  'One application of a visa or passport applicant: passenger row (appointment, documents in visa_application_documents), applied (reference, date, club), decision with its document, handover, closure; re-application after a refusal supersedes the old row. No Data API read.';

commit;
