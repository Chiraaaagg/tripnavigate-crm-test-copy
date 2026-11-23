-- TripNavigate CRM - B1.1 Stage 3 revision path for package versions (DEC-31).
--
-- Contract: docs/implementation/current/stage-3-contract-draft-2026-10-09.md
--   sections 5-8 and 10-12 with the owner answers of 9 October 2026, applied to
--   'package' versions only (b1.1-contract-2026-10-11.md section 2, order 3).
-- Shapes:  b1.1-freeze-note.md and its appendix A section 2.
--
-- What changes:
--   * booking_versions.status gains 'superseded' and 'discarded'; a revision
--     draft names its base (revises_version_id) and carries the change class
--     and the changed field names. Only booking_confirm moves a base from
--     'confirmed' to 'superseded' (transaction-local marker); a revision draft
--     may be discarded (kept, never deleted). 'confirmed' keeps meaning "the
--     accepted version in force", so every existing read stays correct.
--   * Every row that belongs to a version (facts, commercials, evidence,
--     contacts, participation, plan) is immutable once the version is not a
--     draft; a frozen version keeps its stored content hash.
--   * Commands: booking_open_revision, booking_classify_revision,
--     booking_discard_draft; read booking_version_history. booking_confirm
--     gains the revision branch (outcome 'revised', base 'superseded', no new
--     task; the items' existing tasks continue and read the new facts).
--   * Owner answers: a budget-only change is internal_only (no fresh customer
--     acceptance; Accounts still reviews the new version); return reasons
--     written before this release stay hidden from Sales
--     (accounts_booking_reviews.reason_shared_with_sales); no revision once any
--     task of the Deal is supplier-confirmed or completed (already_committed).
--   * Accounts: review commands on a superseded version refuse
--     version_superseded (authz.finance_confirmed_version); receipt_record
--     refuses version_superseded for a superseded bookingVersionId; a revision
--     gets its own pending review lazily, as every confirmed version does.
--   * Department task reads follow the item's current accepted version.
--   * Not here: go-ahead and company funding (Stage 3 section 9).
--
-- Refusal tokens added (message is exactly the token):
--   55000 revision_not_allowed, already_committed, version_superseded,
--         revision_items_fixed
--   22023 classification_not_allowed
--   Readiness issues added: revision_class_missing, customer_acceptance_required,
--   no_changes, base_no_longer_returned.
--
-- Rollback (forward-only): revoke execute on booking_open_revision (NEW
-- migration). Revisions, superseded and discarded versions are kept.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Schema
-- ===========================================================================

do $$
declare
  c record;
begin
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.booking_versions'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%status%'
      and (pg_get_constraintdef(con.oid) like '%draft%' or pg_get_constraintdef(con.oid) like '%confirmed_at%')
  loop
    execute format('alter table public.booking_versions drop constraint %I', c.conname);
  end loop;
end;
$$;

alter table public.booking_versions
  add column revises_version_id uuid,
  add column change_class text check (change_class in ('format_only', 'internal_only', 'customer_material')),
  add column changed_fields text[],
  add column acceptance_from_version_id uuid,
  add column superseded_by_version_id uuid,
  add column superseded_at timestamptz,
  add column discarded_at timestamptz,
  add column discarded_by uuid references public.staff_profiles (user_id),
  add constraint booking_versions_status_check check (status in ('draft', 'confirmed', 'superseded', 'discarded')),
  add constraint booking_versions_confirmed_at_check check ((status in ('confirmed', 'superseded')) = (confirmed_at is not null)),
  add constraint booking_versions_superseded_check
    check ((status = 'superseded') = (superseded_at is not null and superseded_by_version_id is not null)),
  add constraint booking_versions_discarded_check check ((status = 'discarded') = (discarded_at is not null)),
  add constraint booking_versions_class_needs_revision check (change_class is null or revises_version_id is not null),
  add constraint booking_versions_revision_package check (revises_version_id is null or service_type = 'package'),
  add constraint booking_versions_revises_fk foreign key (legal_entity_id, deal_id, revises_version_id)
    references public.booking_versions (legal_entity_id, deal_id, id),
  add constraint booking_versions_acceptance_from_fk foreign key (legal_entity_id, deal_id, acceptance_from_version_id)
    references public.booking_versions (legal_entity_id, deal_id, id),
  add constraint booking_versions_superseded_by_fk foreign key (legal_entity_id, deal_id, superseded_by_version_id)
    references public.booking_versions (legal_entity_id, deal_id, id);
-- The confirmed_at / confirmed_by pairing check went with the loop above.
alter table public.booking_versions
  add constraint booking_versions_confirmed_by_check check ((confirmed_at is null) = (confirmed_by is null));
create unique index booking_versions_one_live_revision on public.booking_versions (revises_version_id)
  where revises_version_id is not null and status <> 'discarded';
create index booking_versions_acceptance_from_idx on public.booking_versions (acceptance_from_version_id)
  where acceptance_from_version_id is not null;
create index booking_versions_superseded_by_idx on public.booking_versions (superseded_by_version_id)
  where superseded_by_version_id is not null;
create index booking_versions_discarded_by_idx on public.booking_versions (discarded_by) where discarded_by is not null;
comment on column public.booking_versions.revises_version_id is
  'Stage 3 revision: the accepted version this draft revises (its base). On confirmation the base becomes superseded.';

alter table public.accounts_booking_reviews
  add column reason_shared_with_sales boolean not null default false;
comment on column public.accounts_booking_reviews.reason_shared_with_sales is
  'True for returns recorded after the revision release (the return form says Sales will read the reason). Older reasons stay hidden from Sales (owner answer S3-D2).';

create function authz.review_reason_shared() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.status = 'returned' and (tg_op = 'INSERT' or old.status is distinct from 'returned'
                                  or old.return_reason is distinct from new.return_reason) then
    new.reason_shared_with_sales := true;
  end if;
  return new;
end;
$$;
create trigger accounts_booking_reviews_reason_shared
  before insert or update on public.accounts_booking_reviews
  for each row execute function authz.review_reason_shared();

alter table public.outbox_events drop constraint outbox_events_event_type_check;
alter table public.outbox_events add constraint outbox_events_event_type_check
  check (event_type in ('booking.version_confirmed', 'fulfilment.task_created', 'fulfilment.supplier_confirmed',
                        'booking.version_revised'));
alter table public.outbox_events drop constraint outbox_events_payload_check;
alter table public.outbox_events add constraint outbox_events_payload_check check (
  jsonb_typeof(payload) = 'object'
  and (payload - array['version_id', 'deal_id', 'task_id', 'version_no', 'service_purpose',
                       'service_item_id', 'service_type', 'base_version_id']) = '{}'::jsonb);

insert into public.permissions (code, description, is_grantable) values
  ('booking.revise', 'Fix a booking Accounts returned: open, save, classify and confirm a revision (booking editors).', false);
insert into public.role_permissions (role_code, permission_code, scope, policy_status, note) values
  ('sales', 'booking.revise', 'own', 'proposed', 'B1.1 / Stage 3: owner or active Sales assignee; confirm by the Deal owner'),
  ('manager', 'booking.revise', 'own', 'proposed', 'B1.1 / Stage 3: Sales Manager of the deal''s branch');

-- ===========================================================================
-- 2. Guards: a version that is not a draft is frozen
-- ===========================================================================

-- Replaces 20261119000100: non-draft rows are immutable, except confirmed ->
-- superseded inside booking_confirm (marker tripnavigate.booking_supersede).
create or replace function authz.booking_versions_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'confirmed booking versions are immutable' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'UPDATE' then
    if old.status <> 'draft' then
      if old.status = 'confirmed' and new.status = 'superseded'
         and coalesce(current_setting('tripnavigate.booking_supersede', true), '') = old.id::text
         and (to_jsonb(new) - array['status', 'superseded_by_version_id', 'superseded_at', 'updated_at'])
             = (to_jsonb(old) - array['status', 'superseded_by_version_id', 'superseded_at', 'updated_at']) then
        return new;
      end if;
      raise exception 'confirmed booking versions are immutable' using errcode = '42501';
    end if;
    if new.id is distinct from old.id or new.deal_id is distinct from old.deal_id
       or new.legal_entity_id is distinct from old.legal_entity_id
       or new.branch_id is distinct from old.branch_id or new.version_no is distinct from old.version_no
       or new.service_type is distinct from old.service_type or new.created_by is distinct from old.created_by
       or new.created_at is distinct from old.created_at
       or new.hash_schema is distinct from old.hash_schema
       -- B1.1 revision
       or new.revises_version_id is distinct from old.revises_version_id then
      raise exception 'booking version identity columns are immutable' using errcode = '42501';
    end if;
    if new.status = 'superseded' then
      raise exception 'only an accepted version can be superseded' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

-- Replaces 20261119000100: a version that is no longer a draft keeps its
-- stored hash (a superseded or discarded row never recomputes).
create or replace function authz.booking_versions_hash() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' and (old.status <> 'draft' or new.status = 'discarded') then
    new.content_hash := old.content_hash;
    return new;
  end if;
  if new.service_type = 'package' then
    new.content_hash := authz.booking_package_hash_row(new);
  else
    new.content_hash := authz.booking_hash(new.hotel_name, new.city, new.check_in, new.check_out, new.rooms,
      new.room_type, new.meal_plan, new.adults, new.children, new.inclusions, new.special_requests,
      new.purchase_budget_paise, new.commercial_revision, authz.booking_stored_evidence(new.id));
  end if;
  return new;
end;
$$;

-- Replaces 20261118000100: refused once the version is not a draft.
create or replace function authz.service_item_facts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.booking_versions v
    where v.status <> 'draft'
      and v.id in (case when tg_op = 'INSERT' then null else old.booking_version_id end,
                   case when tg_op = 'DELETE' then null else new.booking_version_id end)
  ) then
    raise exception 'facts of a confirmed booking version are immutable' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  if tg_op = 'UPDATE' and (
       new.id is distinct from old.id or new.service_item_id is distinct from old.service_item_id
       or new.booking_version_id is distinct from old.booking_version_id
       or new.legal_entity_id is distinct from old.legal_entity_id or new.created_at is distinct from old.created_at) then
    raise exception 'service item facts identity columns are immutable' using errcode = '42501';
  end if;
  new.facts_hash := authz.service_facts_hash(new.facts, new.purchase_budget_paise);
  return new;
end;
$$;

-- Replaces 20261004000100: refused once the version is not a draft.
create or replace function authz.booking_commercials_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_version uuid := case when tg_op = 'DELETE' then old.version_id else new.version_id end;
begin
  if exists (select 1 from public.booking_versions v where v.id = v_version and v.status <> 'draft')
     or (tg_op = 'UPDATE' and exists (
       select 1 from public.booking_versions v where v.id = old.version_id and v.status <> 'draft')) then
    raise exception 'commercials of a confirmed booking version are immutable' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (new.version_id is distinct from old.version_id
     or new.legal_entity_id is distinct from old.legal_entity_id) then
    raise exception 'booking commercial identity columns are immutable' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- Replaces 20261004000100: refused once the version is not a draft.
create or replace function authz.booking_evidence_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (
    select 1 from public.booking_versions v
    where v.status <> 'draft'
      and v.id in (case when tg_op = 'INSERT' then null else old.version_id end,
                   case when tg_op = 'DELETE' then null else new.version_id end)
  ) then
    raise exception 'evidence of a confirmed booking version is immutable' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and (
       new.id is distinct from old.id or new.version_id is distinct from old.version_id
       or new.deal_id is distinct from old.deal_id or new.legal_entity_id is distinct from old.legal_entity_id
       or new.kind is distinct from old.kind or new.object_path is distinct from old.object_path
       or new.file_name is distinct from old.file_name or new.mime is distinct from old.mime
       or new.size_bytes is distinct from old.size_bytes or new.sha256 is distinct from old.sha256
       or new.uploaded_by is distinct from old.uploaded_by or new.created_at is distinct from old.created_at) then
    raise exception 'booking evidence identity columns are immutable' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

-- A revision keeps the base's services: no item is added while a revision
-- draft is open (freeze note D9; removing an accepted item is item_locked).
create function authz.service_items_revision_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.booking_versions v
             where v.deal_id = new.deal_id and v.status = 'draft' and v.revises_version_id is not null) then
    raise exception 'revision_items_fixed' using errcode = '55000';
  end if;
  return new;
end;
$$;
create trigger service_items_b_revision_guard
  before insert on public.service_items
  for each row execute function authz.service_items_revision_guard();

-- Replaces 20261119000100: a revision also hashes its base and change class.
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
          -- Review A1: only travellers whose identity the trip needs (participants of a visa or
          -- passport item, or of a flight item on an international trip); the snapshot holds the same.
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
  ) || case when v.revises_version_id is not null
         then jsonb_build_object('revision', jsonb_build_array(v.revises_version_id, v.change_class))
         else '{}'::jsonb end end::text, 'UTF8')), 'hex')
$$;

-- ===========================================================================
-- 3. Version helpers
-- ===========================================================================

-- Replaces 20261118000100: the version an editor works on: the open draft
-- (a revision while one is open), else the accepted version. Never a
-- superseded or discarded row.
create or replace function authz.deal_current_version(p_deal uuid) returns public.booking_versions
language sql stable security definer set search_path = '' as $$
  select v.* from public.booking_versions v
  where v.deal_id = p_deal and v.status in ('draft', 'confirmed')
  order by (v.status = 'draft') desc, v.version_no desc
  limit 1
$$;

-- The accepted version in force, else the draft (department views never see
-- a revision draft).
create function authz.deal_accepted_or_draft_version(p_deal uuid) returns public.booking_versions
language sql stable security definer set search_path = '' as $$
  select v.* from public.booking_versions v
  where v.deal_id = p_deal and v.status in ('draft', 'confirmed')
  order by (v.status = 'confirmed') desc, v.version_no desc
  limit 1
$$;

-- The version a task's item currently follows: the accepted version holding
-- facts for the item, else the version that created the task.
create function authz.task_current_version(p_task uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select v.id from public.booking_versions v
    join public.service_item_facts f on f.booking_version_id = v.id and f.service_item_id = t.service_item_id
    where v.deal_id = t.deal_id and v.status = 'confirmed'), t.booking_version_id)
  from public.fulfilment_tasks t where t.id = p_task
$$;

-- Supplier-confirmed or completed work on the Deal (no revision after it).
create function authz.deal_committed(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.fulfilment_tasks t
                 where t.deal_id = p_deal and t.status in ('supplier_confirmed', 'completed'))
$$;

-- Change class of one changed field name (Stage 3 section 6 for packages).
create function authz.revision_field_class(p_field text) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_field ~ '^items\.[0-9]+\.purchaseBudgetPaise$' then 'internal'
    when p_field ~ '^items\.[0-9]+\.(hotelName|city|area|roomType|mealPlan|inclusions|exclusions|specialRequests|preferences|notes|route|pickup|drop|vehicleType|name|cabin|preferredTime|assistance|purpose|officeCity)$'
      then 'choice'
    when p_field in ('travellers.specialNeeds', 'trip.destination', 'contacts.contactName', 'contacts.mobile',
                     'contacts.email', 'contacts.contactConfirmed') then 'choice'
    else 'material' end
$$;

-- Changed field names of a revision draft against its base (empty for a
-- version that revises nothing). Live travellers and identities are compared
-- with the base's snapshots.
create function authz.revision_changed_fields(p_version uuid) returns text[]
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
      ('end', v.trip_end is distinct from b.trip_end)) as t(k, changed)
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
      ('payerName', cv.payer_name is distinct from cb.payer_name)) as t(k, changed)
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
  )
  select coalesce(array_agg(distinct f order by f), '{}'::text[]) from fields
$$;

-- Classes a revision may take for its changed fields (weakest first).
create function authz.revision_allowed_classes(p_fields text[]) returns text[]
language sql immutable set search_path = '' as $$
  select case
    when cardinality(coalesce(p_fields, '{}'::text[])) = 0 then '{}'::text[]
    when exists (select 1 from unnest(p_fields) f where authz.revision_field_class(f) = 'material') then array['customer_material']
    when exists (select 1 from unnest(p_fields) f where authz.revision_field_class(f) = 'choice') then array['format_only', 'customer_material']
    else array['internal_only', 'customer_material'] end
$$;

-- Changed field names safe for department readers (no commercial, plan,
-- contact or identity names).
create function authz.revision_department_fields(p_version uuid) returns text[]
language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(f order by f), '{}'::text[])
  from public.booking_versions v cross join unnest(coalesce(v.changed_fields, '{}'::text[])) f
  where v.id = p_version
    and f !~ '^(sellingTotal|listPrice|discount|plan|contacts\.|travellers\.[0-9]+\.identity)'
$$;

revoke all on function authz.review_reason_shared(), authz.service_items_revision_guard(),
  authz.deal_accepted_or_draft_version(uuid), authz.task_current_version(uuid), authz.deal_committed(uuid),
  authz.revision_field_class(text), authz.revision_changed_fields(uuid), authz.revision_allowed_classes(text[]),
  authz.revision_department_fields(uuid)
from public, anon, authenticated, service_role;

-- Replaces 20261119000100: any save on a revision clears its change class.
create or replace function authz.bump_package_version(p_version_id uuid) returns public.booking_versions
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
begin
  update public.booking_versions v
  set row_version = v.row_version + 1, updated_at = now(), updated_by = (select auth.uid()),
      -- B1.1 revision
      change_class = null, changed_fields = null
  where v.id = p_version_id
  returning * into v_ver;
  return v_ver;
end;
$$;

-- Replaces 20261118000100: a superseded or discarded version is not editable.
create or replace function authz.lock_package_draft(p_version_id uuid)
returns public.booking_versions
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
begin
  select * into v_ver from public.booking_versions v where v.id = p_version_id for update;
  perform authz.refuse_removed_deal(v_ver.deal_id);
  if v_ver.id is null or not authz.can_edit_booking_draft(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not authz.service_items_enabled() then
    raise exception 'service_items_disabled' using errcode = '55000';
  end if;
  -- Stage 7: no new intake work on a Deal that is lost or rejected in Bitrix.
  if authz.deal_not_active(v_ver.deal_id) then
    raise exception 'deal_not_active' using errcode = '55000';
  end if;
  if v_ver.status <> 'draft' then  -- B1.1 revision: superseded and discarded too
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  if v_ver.service_type <> 'package' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'version';
  end if;
  return v_ver;
end;
$$;

-- Replaces 20261107000300: a superseded or discarded version is not editable.
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

-- Replaces 20261107000300: a superseded or discarded version is not editable.
create or replace function public.booking_begin_evidence(
  p_version_id uuid, p_kind text, p_file_name text, p_mime text, p_size_bytes integer, p_sha256 text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_name text;
  v_sha text := lower(btrim(coalesce(p_sha256, '')));
  v_max integer;
  v_id uuid := gen_random_uuid();
  v_path text;
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
  if p_kind is null or p_kind not in ('acceptance_message', 'ticket', 'bill', 'payment_proof', 'other') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_name := btrim(left(btrim(regexp_replace(coalesce(p_file_name, ''), '[^A-Za-z0-9._ -]', '_', 'g')), 120));
  select s.evidence_max_bytes into v_max from public.booking_settings s where s.id;
  if v_name = '' or v_name ~ '^[. ]+$'
     or p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > coalesce(v_max, 0)
     or v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  if (select count(*) from public.booking_evidence e where e.version_id = v_ver.id and e.status <> 'removed') >= 10 then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  v_path := v_ver.legal_entity_id::text || '/' || v_ver.deal_id::text || '/' || v_ver.id::text || '/' || v_id::text;
  insert into public.booking_evidence
    (id, version_id, deal_id, legal_entity_id, kind, object_path, file_name, mime, size_bytes, sha256, uploaded_by)
  values (v_id, v_ver.id, v_ver.deal_id, v_ver.legal_entity_id, p_kind, v_path, v_name, p_mime, p_size_bytes,
    v_sha, (select auth.uid()));

  perform authz.write_audit('booking.evidence_started', v_ver.legal_entity_id, v_ver.branch_id,
    'booking_evidence', v_id, null,
    jsonb_build_object('versionId', v_ver.id, 'kind', p_kind, 'mime', p_mime, 'sizeBytes', p_size_bytes));
  return jsonb_build_object('evidenceId', v_id, 'objectPath', v_path);
end;
$$;

-- Replaces 20261004000100: a superseded or discarded version is not editable.
create or replace function public.booking_finish_evidence(p_evidence_id uuid, p_ok boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ev public.booking_evidence%rowtype;
  v_ver public.booking_versions%rowtype;
  v_status text;
  v_missing boolean := false;
begin
  -- Lock order everywhere: version, then evidence.
  select * into v_ver from public.booking_versions v
  where v.id = (select e.version_id from public.booking_evidence e where e.id = p_evidence_id)
  for update;
  select * into v_ev from public.booking_evidence e where e.id = p_evidence_id for update;
  if v_ev.id is null or v_ver.id is null or v_ev.uploaded_by is distinct from (select auth.uid())
     or not authz.can_edit_booking_draft(v_ev.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ver.status <> 'draft' then  -- B1.1 revision: superseded and discarded too
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  if p_ok is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_status := case when p_ok then 'stored' else 'failed' end;
  if v_ev.status <> 'pending_upload' then
    -- Repeats report the recorded outcome (finish(true) on a row that failed,
    -- e.g. object missing, stays 'failed'); stored -> failed is refused.
    if v_ev.status = v_status or (p_ok and v_ev.status = 'failed') then
      return jsonb_build_object('evidenceId', v_ev.id, 'status', v_ev.status);
    end if;
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  -- A4 H2: 'stored' only when Storage really holds the object at the
  -- server-generated path with the declared size. Otherwise the row fails.
  if p_ok and (to_regclass('storage.objects') is null or not exists (
       select 1 from storage.objects o
       where o.bucket_id = 'booking-evidence' and o.name = v_ev.object_path
         and (o.metadata ->> 'size') ~ '^[0-9]{1,18}$'
         and (o.metadata ->> 'size')::bigint = v_ev.size_bytes)) then
    v_status := 'failed';
    v_missing := true;
  end if;

  update public.booking_evidence e
  set status = v_status, stored_at = case when v_status = 'stored' then now() else null end, updated_at = now()
  where e.id = v_ev.id;

  perform authz.write_audit(case when v_status = 'stored' then 'booking.evidence_stored' else 'booking.evidence_failed' end,
    v_ver.legal_entity_id, v_ver.branch_id, 'booking_evidence', v_ev.id, null,
    jsonb_build_object('versionId', v_ver.id, 'objectMissing', v_missing));
  return jsonb_build_object('evidenceId', v_ev.id, 'status', v_status);
end;
$$;

-- Replaces 20261004000100: a superseded or discarded version is not editable.
create or replace function public.booking_remove_evidence(p_evidence_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ev public.booking_evidence%rowtype;
  v_ver public.booking_versions%rowtype;
begin
  select * into v_ver from public.booking_versions v
  where v.id = (select e.version_id from public.booking_evidence e where e.id = p_evidence_id)
  for update;
  select * into v_ev from public.booking_evidence e where e.id = p_evidence_id for update;
  if v_ev.id is null or v_ver.id is null or not authz.can_edit_booking_draft(v_ev.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ver.status <> 'draft' then  -- B1.1 revision: superseded and discarded too
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  if v_ev.status = 'removed' then
    return jsonb_build_object('evidenceId', v_ev.id, 'status', 'removed');
  end if;

  update public.booking_evidence e set status = 'removed', updated_at = now() where e.id = v_ev.id;

  perform authz.write_audit('booking.evidence_removed', v_ver.legal_entity_id, v_ver.branch_id,
    'booking_evidence', v_ev.id, null,
    jsonb_build_object('versionId', v_ver.id, 'previousStatus', v_ev.status));
  return jsonb_build_object('evidenceId', v_ev.id, 'status', 'removed');
end;
$$;

-- Replaces 20261119000100: revision drafts may change traveller names.
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
       or exists (select 1 from jsonb_object_keys(v_row) k where k not in ('fullName', 'type', 'seq', 'ageYears', 'specialNeeds'))
       or not authz.sf_text_ok(v_row -> 'fullName', 120, true)
       or not authz.sf_int_ok(v_row -> 'seq', 1, 100, true)
       or jsonb_typeof(v_row -> 'type') <> 'string' or (v_row #>> '{type}') not in ('adult', 'child', 'infant')
       or not authz.sf_int_ok(v_row -> 'ageYears', 0, 17, false)
       or not authz.sf_text_ok(v_row -> 'specialNeeds', 500, false) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'travellers[' || v_count::text || ']';
    end if;
    v_seq := (v_row #>> '{seq}')::integer;
    if v_seq = any (v_seqs) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'travellers[' || v_count::text || '].seq';
    end if;
    v_seqs := v_seqs || v_seq;
  end loop;

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
  insert into public.deal_travellers as t (deal_id, legal_entity_id, seq, full_name, traveller_type, age_years, special_needs)
  select p_deal_id, v_ver.legal_entity_id, (e #>> '{seq}')::integer, btrim(e #>> '{fullName}', E' \t\r\n'), e #>> '{type}',
    authz.sf_int_value(e -> 'ageYears'), authz.b11_text(e -> 'specialNeeds')
  from jsonb_array_elements(p_travellers) e
  on conflict (deal_id, seq) do update
    set full_name = excluded.full_name, traveller_type = excluded.traveller_type, age_years = excluded.age_years,
        special_needs = excluded.special_needs
    where (t.full_name, t.traveller_type, t.age_years, t.special_needs)
          is distinct from (excluded.full_name, excluded.traveller_type, excluded.age_years, excluded.special_needs);
  v_ver := authz.bump_package_version(v_ver.id);

  -- Count only; no names.
  perform authz.write_audit('booking.travellers_saved', v_ver.legal_entity_id, v_ver.branch_id,
    'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', p_deal_id, 'versionNo', v_ver.version_no, 'travellerCount', v_count,
      'removedCount', v_removed, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;

-- Replaces 20261119000100: revision readiness.
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
      then 'missing_acceptance_proof' end,
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

-- Replaces 20261119000100.
create or replace function authz.deal_services_json(p_deal uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_scope text[];
  v_ver public.booking_versions;
  v_items jsonb;
  v_full boolean;
  v_needed integer[];
begin
  if p_deal is null or not authz.session_ok() then
    return null;
  end if;
  v_scope := authz.deal_services_scope(p_deal);
  if v_scope is not null and cardinality(v_scope) = 0 then
    return null;
  end if;
  v_full := v_scope is null;
  -- B1.1 revision: editors see the working version (an open revision);
  -- department readers the accepted one.
  if v_full then
    v_ver := authz.deal_current_version(p_deal);
  else
    v_ver := authz.deal_accepted_or_draft_version(p_deal);
  end if;
  select coalesce(jsonb_agg(authz.service_item_json(i.id, v_ver.id, v_full or i.department = any (v_scope))
           || case when v_full then jsonb_build_object('participants',
                to_jsonb(authz.item_participant_seqs(i.id, v_ver.id))) else '{}'::jsonb end
           order by i.item_no), '[]'::jsonb)
  into v_items
  from public.service_items i
  where i.deal_id = p_deal and (v_full or i.department = any (v_scope));
  if v_full and v_ver.id is not null then
    v_needed := authz.b11_identity_needed_seqs(v_ver.id);
  end if;
  return jsonb_build_object(
    'dealId', p_deal,
    'version', case when v_ver.id is null then null else jsonb_build_object(
      'versionId', v_ver.id, 'versionNo', v_ver.version_no, 'status', v_ver.status, 'rowVersion', v_ver.row_version,
      'contentHash', v_ver.content_hash, 'serviceType', v_ver.service_type,
      -- B1.1
      'trip', jsonb_build_object('destination', v_ver.trip_destination, 'scope', v_ver.trip_scope,
        'start', to_char(v_ver.trip_start, 'YYYY-MM-DD'), 'end', to_char(v_ver.trip_end, 'YYYY-MM-DD'))) end,
    'items', v_items,
    'progress', authz.deal_progress_json(p_deal, v_scope),
    'canEdit', v_full and coalesce(v_ver.status, 'draft') = 'draft' and authz.can_edit_booking_draft(p_deal),
    'canConfirm', v_full and v_ver.status = 'draft' and authz.can_confirm_booking(p_deal))
  || case when v_full then jsonb_build_object('travellers', coalesce((
       select jsonb_agg(jsonb_build_object('fullName', t.full_name, 'type', t.traveller_type, 'seq', t.seq,
           -- B1.1
           'ageYears', t.age_years, 'specialNeeds', t.special_needs,
           'identityStatus', case
             when not (t.seq = any (coalesce(v_needed, '{}'::integer[]))) then 'not_needed'
             when x.traveller_id is null or (x.date_of_birth is null and x.nationality is null) then 'missing'
             when x.date_of_birth is null or x.nationality is null or x.passport_number is null or x.passport_expiry is null then 'partial'
             else 'complete' end)
         order by t.seq)
       from public.deal_travellers t
       left join public.traveller_identities x on x.traveller_id = t.id
       where t.deal_id = p_deal), '[]'::jsonb))
     else '{}'::jsonb end;
end;
$$;

-- ===========================================================================
-- 4. Revision commands and history
-- ===========================================================================

-- Opens (or returns) the revision draft of a returned accepted package version.
-- Copies trip, contacts, facts, participation, commercials and plan; not the
-- evidence (fresh acceptance is attached to the revision when needed).
create function public.booking_open_revision(p_base_version_id uuid) returns jsonb
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

  insert into public.booking_versions (deal_id, legal_entity_id, branch_id, version_no, created_by, service_type,
    trip_destination, trip_scope, trip_start, trip_end, revises_version_id, updated_by)
  values (v_base.deal_id, v_base.legal_entity_id, v_base.branch_id,
    (select max(v.version_no) from public.booking_versions v where v.deal_id = v_base.deal_id) + 1,
    (select auth.uid()), 'package', v_base.trip_destination, v_base.trip_scope, v_base.trip_start, v_base.trip_end,
    v_base.id, (select auth.uid()))
  returning * into v_ver;
  insert into public.service_item_facts (service_item_id, booking_version_id, legal_entity_id, facts, purchase_budget_paise, facts_hash)
  select f.service_item_id, v_ver.id, f.legal_entity_id, f.facts, f.purchase_budget_paise, f.facts_hash
  from public.service_item_facts f where f.booking_version_id = v_base.id;
  insert into public.service_item_travellers (booking_version_id, service_item_id, legal_entity_id, traveller_seq)
  select v_ver.id, f.service_item_id, f.legal_entity_id, s
  from public.service_item_facts f cross join unnest(authz.item_participant_seqs(f.service_item_id, v_base.id)) s
  where f.booking_version_id = v_base.id;
  insert into public.booking_version_contacts (booking_version_id, legal_entity_id, deal_id, contact_name, mobile, email,
    contact_confirmed, confirmed_by, confirmed_at, booking_for, payer_different, payer_name, updated_by)
  select v_ver.id, c.legal_entity_id, c.deal_id, c.contact_name, c.mobile, c.email, c.contact_confirmed, c.confirmed_by,
    c.confirmed_at, c.booking_for, c.payer_different, c.payer_name, c.updated_by
  from public.booking_version_contacts c where c.booking_version_id = v_base.id;
  insert into public.booking_version_commercials (version_id, legal_entity_id, selling_total_paise, list_price_paise, discount_paise)
  select v_ver.id, c.legal_entity_id, c.selling_total_paise, c.list_price_paise, c.discount_paise
  from public.booking_version_commercials c where c.version_id = v_base.id;
  insert into public.booking_version_instalments (booking_version_id, deal_id, legal_entity_id, seq, label, amount_paise, due_date)
  select v_ver.id, p.deal_id, p.legal_entity_id, p.seq, p.label, p.amount_paise, p.due_date
  from public.booking_version_instalments p where p.booking_version_id = v_base.id;
  select * into v_ver from public.booking_versions v where v.id = v_ver.id;

  perform authz.write_audit('booking.revision_opened', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id,
    null, jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'baseVersionId', v_base.id,
      'baseVersionNo', v_base.version_no));
  return jsonb_build_object('versionId', v_ver.id, 'versionNo', v_ver.version_no, 'rowVersion', v_ver.row_version,
    'revisesVersionId', v_base.id, 'created', true);
end;
$$;

-- Records the change class of a revision draft (Stage 3 section 6).
create function public.booking_classify_revision(p_version_id uuid, p_expected_row_version integer, p_change_class text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_fields text[];
begin
  v_ver := authz.lock_package_draft(p_version_id);
  if v_ver.revises_version_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'version';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_change_class is null or p_change_class not in ('format_only', 'internal_only', 'customer_material') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'changeClass';
  end if;
  v_fields := authz.revision_changed_fields(v_ver.id);
  if cardinality(v_fields) = 0 then
    raise exception 'not_ready' using errcode = '55000', hint = 'no_changes';
  end if;
  if not (p_change_class = any (authz.revision_allowed_classes(v_fields))) then
    raise exception 'classification_not_allowed' using errcode = '22023';
  end if;
  update public.booking_versions v
  set change_class = p_change_class, changed_fields = v_fields, row_version = v.row_version + 1, updated_at = now(),
      updated_by = (select auth.uid())
  where v.id = v_ver.id
  returning * into v_ver;
  perform authz.write_audit('booking.revision_classified', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version',
    v_ver.id, null, jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'changeClass', p_change_class,
      'changedFields', to_jsonb(v_fields), 'rowVersion', v_ver.row_version));
  return jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash, 'changedFields', to_jsonb(v_fields));
end;
$$;

-- Discards a revision draft (kept with its rows; evidence marked removed).
create function public.booking_discard_draft(p_version_id uuid, p_expected_row_version integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
begin
  select * into v_ver from public.booking_versions v where v.id = p_version_id for update;
  perform authz.refuse_removed_deal(v_ver.deal_id);
  if v_ver.id is null or not authz.can_edit_booking_draft(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ver.status = 'discarded' then
    return jsonb_build_object('outcome', 'existing');
  end if;
  if v_ver.status <> 'draft' then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  if v_ver.revises_version_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'version';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  update public.booking_evidence e set status = 'removed', updated_at = now()
  where e.version_id = v_ver.id and e.status <> 'removed';
  update public.booking_versions v
  set status = 'discarded', discarded_at = now(), discarded_by = (select auth.uid()), updated_at = now(),
      updated_by = (select auth.uid())
  where v.id = v_ver.id;
  perform authz.write_audit('booking.draft_discarded', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id,
    null, jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'baseVersionId', v_ver.revises_version_id));
  return jsonb_build_object('outcome', 'discarded');
end;
$$;

-- Version history for booking readers (Sales, Manager): selling total and
-- delta only with deal.read_commercial; a return reason only when it was
-- shared with Sales and the caller edits or accepts the booking.
create function public.booking_version_history(p_deal_id uuid) returns jsonb
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
        'changedFields', to_jsonb(coalesce(v.changed_fields, '{}'::text[])), 'supersededAt', v.superseded_at,
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

-- Replaces 20261119000100: the revision branch (Stage 3 section 5.1).
create or replace function public.booking_confirm(p_version_id uuid, p_expected_content_hash text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_deal public.deals%rowtype;
  v_task uuid;
  v_task_version uuid;
  v_key text;
  v_env text;
  v_item record;
  v_hotel_item uuid;
  v_tasks uuid[] := '{}'::uuid[];
  -- B1.1 revision
  v_base public.booking_versions%rowtype;
  v_review text;
begin
  -- 1. Row lock: a concurrent confirmation waits here, then sees 'confirmed'.
  select * into v_ver from public.booking_versions v where v.id = p_version_id for update;
  -- Stage 0: a Deal removed by the Bitrix sync takes no new booking work.
  perform authz.refuse_removed_deal(v_ver.deal_id);
  -- 2. Existence is not revealed.
  if v_ver.id is null or not authz.can_confirm_booking(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- 3. Repeat / concurrent confirmation: every task of the version, item order.
  if v_ver.status = 'confirmed' then
    -- B1.1 revision: a package version's tasks are its items' tasks (a revision creates none).
    select coalesce(array_agg(t.id order by i.item_no, t.created_at), '{}'::uuid[]) into v_tasks
    from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
    where t.booking_version_id = v_ver.id
       or (v_ver.service_type = 'package' and t.service_item_id in (
             select f.service_item_id from public.service_item_facts f where f.booking_version_id = v_ver.id));
    if cardinality(v_tasks) > 0 or v_ver.service_type = 'package' then
      return jsonb_build_object('outcome', 'existing', 'taskId', v_tasks[1], 'versionId', v_ver.id,
        'taskIds', to_jsonb(v_tasks));
    end if;
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  -- B1: a package version confirms only while the switch is on.
  if v_ver.service_type = 'package' and not authz.service_items_enabled() then
    raise exception 'service_items_disabled' using errcode = '55000';
  end if;
  -- 4. Optimistic check against the live hash.
  if p_expected_content_hash is null or p_expected_content_hash <> authz.booking_content_hash(v_ver.id) then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  -- 5. Gate.
  select * into v_deal from public.deals d where d.id = v_ver.deal_id;
  v_env := authz.deployment_environment();
  if v_env = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if not v_deal.is_synthetic
     and not coalesce((select s.real_booking_enabled from public.booking_settings s where s.id), false) then
    raise exception 'booking_disabled' using errcode = '55000';
  end if;
  if v_deal.is_synthetic and v_env <> 'test' then
    raise exception 'booking_disabled' using errcode = '55000';
  end if;
  -- B1.1 revision: the base must still be the accepted version, returned by
  -- Accounts, with no supplier-confirmed or completed work on the Deal.
  if v_ver.revises_version_id is not null then
    select * into v_base from public.booking_versions b where b.id = v_ver.revises_version_id for update;
    if v_base.status <> 'confirmed' then
      raise exception 'version_superseded' using errcode = '55000';
    end if;
    select rv.status into v_review from public.accounts_booking_reviews rv where rv.booking_version_id = v_base.id for update;
    if v_review is distinct from 'returned' then
      raise exception 'revision_not_allowed' using errcode = '55000';
    end if;
    if authz.deal_committed(v_ver.deal_id) then
      raise exception 'already_committed' using errcode = '55000';
    end if;
    -- Review R1: the recorded class must still match the actual changes.
    if v_ver.change_class is null or v_ver.changed_fields is distinct from authz.revision_changed_fields(v_ver.id)
       or not (v_ver.change_class = any (authz.revision_allowed_classes(authz.revision_changed_fields(v_ver.id)))) then
      raise exception 'not_ready' using errcode = '55000';
    end if;
  end if;
  -- 6. Readiness (package versions: includes stage_not_confirmed, no_services, ...).
  if cardinality(authz.booking_issues(v_ver.id)) > 0 then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  -- B1 (before the freeze: facts rows of a confirmed version are immutable).
  if v_ver.service_type = 'package' then
    -- Traveller snapshot (B1.1: with age and special needs).
    insert into public.booking_version_travellers (booking_version_id, legal_entity_id, seq, full_name, traveller_type,
      age_years, special_needs)
    select v_ver.id, v_ver.legal_entity_id, t.seq, t.full_name, t.traveller_type, t.age_years, t.special_needs
    from public.deal_travellers t where t.deal_id = v_ver.deal_id;
    -- B1.1: identity snapshot (restricted).
    insert into public.booking_version_traveller_identities (booking_version_id, legal_entity_id, seq, date_of_birth,
      nationality, passport_number, passport_expiry)
    select v_ver.id, v_ver.legal_entity_id, t.seq, x.date_of_birth, x.nationality, x.passport_number, x.passport_expiry
    from public.traveller_identities x join public.deal_travellers t on t.id = x.traveller_id
    where t.deal_id = v_ver.deal_id
      -- Review A1: identities the trip needs only (same set as the draft hash).
      and t.seq = any (authz.b11_identity_needed_seqs(v_ver.id));
  else
    -- Legacy hotel version: the Deal's hotel item and its facts snapshot.
    v_hotel_item := authz.hotel_item_for_deal(v_ver.deal_id, v_ver.created_by, v_ver.created_at);
    perform authz.hotel_facts_sync(v_ver.id, v_hotel_item);
  end if;
  -- B1.1 revision: the base is superseded first (one accepted version per Deal).
  if v_ver.revises_version_id is not null then
    perform set_config('tripnavigate.booking_supersede', v_base.id::text, true);
    update public.booking_versions b
    set status = 'superseded', superseded_by_version_id = v_ver.id, superseded_at = now(), updated_at = now()
    where b.id = v_base.id;
    perform set_config('tripnavigate.booking_supersede', '', true);
  end if;
  -- 7. Freeze.
  update public.booking_versions v
  set status = 'confirmed', confirmed_by = (select auth.uid()), confirmed_at = now(),
      -- B1.1 revision: the base's acceptance stands for format-only and internal-only changes.
      acceptance_from_version_id = case when v.revises_version_id is not null and v.change_class <> 'customer_material'
                                        then v.revises_version_id end,
      confirmed_deal_source_modified_at = v_deal.source_modified_at, updated_at = now()
  where v.id = v_ver.id
  returning * into v_ver;
  -- B1.1 revision: no new task; the items' existing tasks continue.
  if v_ver.revises_version_id is not null then
    select coalesce(array_agg(t.id order by i.item_no, t.created_at), '{}'::uuid[]) into v_tasks
    from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
    where t.service_item_id in (select f.service_item_id from public.service_item_facts f where f.booking_version_id = v_ver.id);
    insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
    values (v_ver.legal_entity_id, 'booking_version', v_ver.id, 'booking.version_revised',
      jsonb_build_object('version_id', v_ver.id, 'deal_id', v_ver.deal_id, 'version_no', v_ver.version_no,
        'base_version_id', v_base.id))
    on conflict (event_type, aggregate_id) do nothing;
    perform authz.write_audit('booking.version_superseded', v_base.legal_entity_id, v_base.branch_id, 'booking_version',
      v_base.id, null, jsonb_build_object('dealId', v_base.deal_id, 'versionNo', v_base.version_no,
        'supersededByVersionId', v_ver.id));
    perform authz.write_audit('booking.version_revised', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version',
      v_ver.id, null, jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'baseVersionId', v_base.id,
        'changeClass', v_ver.change_class, 'changedFields', to_jsonb(coalesce(v_ver.changed_fields, '{}'::text[])),
        'taskIds', to_jsonb(v_tasks)));
    return jsonb_build_object('outcome', 'revised', 'versionId', v_ver.id, 'supersededVersionId', v_base.id,
      'taskId', v_tasks[1], 'taskIds', to_jsonb(v_tasks));
  end if;
  -- 8. Exactly one task per item (hotel path: one task, legacy key).
  if v_ver.service_type = 'package' then
    -- Review V3: read the desk switch under a share lock so a concurrent
    -- switch-on either sees this version's items or is seen here.
    perform 1 from public.workflow_settings s where s.id for share;
    update public.service_items i set state = 'active', updated_at = now()
    where i.state = 'planned'
      and i.id in (select f.service_item_id from public.service_item_facts f where f.booking_version_id = v_ver.id);
    for v_item in
      select i.id, i.item_no, i.service_type, i.department
      from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
      where f.booking_version_id = v_ver.id
        -- B1.1: visa/passport tasks wait for the desk launch.
        and (i.service_type not in ('visa', 'passport') or authz.visa_passport_tasks_enabled())
      order by i.item_no
    loop
      v_key := 'item:' || v_item.id::text || ':' || v_item.service_type;
      v_task := null;
      insert into public.fulfilment_tasks
        (deal_id, legal_entity_id, branch_id, booking_version_id, service_purpose, task_key, created_by,
         service_item_id, department)
      values (v_ver.deal_id, v_ver.legal_entity_id, v_ver.branch_id, v_ver.id, v_item.service_type, v_key,
        (select auth.uid()), v_item.id, v_item.department)
      on conflict (task_key) do nothing
      returning id into v_task;
      if v_task is null then
        select t.id, t.booking_version_id into v_task, v_task_version
        from public.fulfilment_tasks t where t.task_key = v_key;
        if v_task_version is distinct from v_ver.id then
          raise exception 'task_conflict' using errcode = '40001';
        end if;
      end if;
      v_tasks := v_tasks || v_task;
      -- 9. Outbox per task (ids and types only).
      insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
      values (v_ver.legal_entity_id, 'fulfilment_task', v_task, 'fulfilment.task_created',
        jsonb_build_object('task_id', v_task, 'version_id', v_ver.id, 'deal_id', v_ver.deal_id,
          'version_no', v_ver.version_no, 'service_purpose', v_item.service_type,
          'service_item_id', v_item.id, 'service_type', v_item.service_type))
      on conflict (event_type, aggregate_id) do nothing;
      -- 10. Audit per task.
      perform authz.write_audit('fulfilment.task_created', v_ver.legal_entity_id, v_ver.branch_id,
        'fulfilment_task', v_task, null,
        jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no,
          'serviceItemId', v_item.id, 'serviceType', v_item.service_type));
    end loop;
    insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
    values (v_ver.legal_entity_id, 'booking_version', v_ver.id, 'booking.version_confirmed',
      jsonb_strip_nulls(jsonb_build_object('version_id', v_ver.id, 'deal_id', v_ver.deal_id, 'task_id', v_tasks[1],
        'version_no', v_ver.version_no, 'service_purpose', 'package')))
    on conflict (event_type, aggregate_id) do nothing;
    perform authz.write_audit('booking.version_confirmed', v_ver.legal_entity_id, v_ver.branch_id,
      'booking_version', v_ver.id, null,
      jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'taskId', v_tasks[1],
        'taskIds', to_jsonb(v_tasks), 'serviceType', 'package'));
    return jsonb_build_object('outcome', 'created', 'taskId', v_tasks[1], 'versionId', v_ver.id,
      'taskIds', to_jsonb(v_tasks));
  end if;

  v_key := 'booking:' || v_ver.id::text || ':hotel';
  insert into public.fulfilment_tasks
    (deal_id, legal_entity_id, branch_id, booking_version_id, service_purpose, task_key, created_by, service_item_id)
  values (v_ver.deal_id, v_ver.legal_entity_id, v_ver.branch_id, v_ver.id, 'hotel', v_key, (select auth.uid()),
    v_hotel_item)
  on conflict (task_key) do nothing
  returning id into v_task;
  if v_task is null then
    select t.id, t.booking_version_id into v_task, v_task_version
    from public.fulfilment_tasks t where t.task_key = v_key;
    if v_task_version is distinct from v_ver.id then
      raise exception 'task_conflict' using errcode = '40001';
    end if;
  end if;
  update public.service_items i set state = 'active', updated_at = now()
  where i.id = v_hotel_item and i.state = 'planned';
  -- 9. Outbox (ids only).
  insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
  values
    (v_ver.legal_entity_id, 'booking_version', v_ver.id, 'booking.version_confirmed',
     jsonb_build_object('version_id', v_ver.id, 'deal_id', v_ver.deal_id, 'task_id', v_task,
       'version_no', v_ver.version_no, 'service_purpose', 'hotel')),
    (v_ver.legal_entity_id, 'fulfilment_task', v_task, 'fulfilment.task_created',
     jsonb_build_object('task_id', v_task, 'version_id', v_ver.id, 'deal_id', v_ver.deal_id,
       'version_no', v_ver.version_no, 'service_purpose', 'hotel'))
  on conflict (event_type, aggregate_id) do nothing;
  -- 10. Audit: ids and version_no only.
  perform authz.write_audit('booking.version_confirmed', v_ver.legal_entity_id, v_ver.branch_id,
    'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'taskId', v_task));
  perform authz.write_audit('fulfilment.task_created', v_ver.legal_entity_id, v_ver.branch_id,
    'fulfilment_task', v_task, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no));
  -- 11.
  return jsonb_build_object('outcome', 'created', 'taskId', v_task, 'versionId', v_ver.id,
    'taskIds', jsonb_build_array(v_task));
end;
$$;

-- ===========================================================================
-- 5. Accounts and receipts
-- ===========================================================================

-- Replaces 20261101000100: a superseded version answers version_superseded
-- (after the Accounts authorization), so accounts_review_return/approve refuse
-- it with that token.
create or replace function authz.finance_confirmed_version(p_version uuid) returns public.booking_versions
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.booking_versions%rowtype;
  v_synthetic boolean;
begin
  select * into v from public.booking_versions x where x.id = p_version and x.status in ('confirmed', 'superseded');
  if v.id is null then
    if coalesce(authz.session_ok(), false) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = v.deal_id;
  perform authz.finance_require_accounts(v.legal_entity_id, v_synthetic);
  -- B1.1 revision
  if v.status = 'superseded' then
    raise exception 'version_superseded' using errcode = '55000';
  end if;
  return v;
end;
$$;

-- Replaces 20261110000100: version_superseded for a superseded bookingVersionId.
create or replace function public.receipt_record(p_deal_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_entity uuid;
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id, 'fields', p_fields);
  v_result jsonb;
  v_t timestamptz := now();
  v_today date := authz.finance_today();
  v_policy public.finance_policy_versions%rowtype;
  v_mode text;
  v_amount_text text;
  v_amount bigint;
  v_received date;
  v_branch uuid;
  v_collector uuid;
  v_payer text;
  v_pan text;
  v_mobile text;
  v_reference text;
  v_norm text;
  v_micr text;
  v_cheque_no text;
  v_cheque_date date;
  v_payee jsonb;
  v_booking uuid;
  v_corrects uuid;
  v_note text;
  v_orig public.customer_receipts%rowtype;
  v_id uuid := gen_random_uuid();
  v_keys text[] := '{}';
  v_hash bigint;
  v_sum bigint;
  v_fy text;
  v_seq integer;
  v_no text;
  v_dest_version uuid;
  v_dv public.company_destination_versions%rowtype;
  v_dest public.company_destinations%rowtype;
  v_snapshot jsonb;
begin
  select * into v_deal from public.deals d where d.id = p_deal_id;
  perform authz.finance_require_accounts(v_deal.legal_entity_id, v_deal.is_synthetic);
  v_entity := v_deal.legal_entity_id;
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  perform authz.finance_lock_policy(v_entity, false);   -- lock 1
  perform authz.finance_lock_deal(v_deal.id);           -- lock 2
  v_result := authz.finance_replay(v_entity, p_request_id, 'receipt_record', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  -- Stage 0 (20261107000300, kept here): a Deal removed by the Bitrix sync takes
  -- no new receipt (an exact retry of a receipt recorded before the removal
  -- replays above). The KEY SHARE lock waits for an in-flight removal, which
  -- holds FOR UPDATE on the Deal.
  perform 1 from public.deals d where d.id = v_deal.id for key share;
  if exists (select 1 from public.deals d where d.id = v_deal.id and d.removed_at is not null) then
    raise exception 'deal_removed' using errcode = '55000';
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['mode', 'amountPaise', 'receivedOn', 'branchId', 'collectorUserId', 'payerName', 'payerPan',
                          'payerMobile', 'reference', 'micrCode', 'chequeNumber', 'chequeDate', 'accountPayee',
                          'bookingVersionId', 'correctsReceiptId', 'note', 'destinationVersionId']) <> '{}'::jsonb then
    perform authz.finance_invalid();
  end if;
  v_mode := authz.finance_field(p_fields, 'mode');
  if v_mode is null or v_mode not in ('bank_transfer', 'upi', 'cash', 'cheque') then
    perform authz.finance_invalid();
  end if;
  if not authz.finance_mode_allowed(v_entity, v_mode) then
    raise exception 'mode_not_live' using errcode = '55000';
  end if;

  -- The policy is read once: this version and v_t for every check.
  v_policy := authz.finance_policy_at(v_entity, v_t);
  if v_policy.id is null then
    raise exception 'not_configured' using errcode = '55000';
  end if;

  v_amount_text := authz.finance_field(p_fields, 'amountPaise');
  if v_amount_text is null or v_amount_text !~ '^[1-9][0-9]{0,17}$' then
    perform authz.finance_invalid();
  end if;
  v_amount := v_amount_text::bigint;
  if v_amount > v_policy.receipt_max_paise then
    perform authz.finance_invalid();
  end if;

  v_received := authz.finance_date(authz.finance_field(p_fields, 'receivedOn'));
  if v_received is null or v_received not between v_today - 30 and v_today then
    perform authz.finance_invalid();
  end if;

  v_branch := authz.finance_uuid(authz.finance_field(p_fields, 'branchId'));
  if v_branch is null or not exists (
       select 1 from public.branches b where b.id = v_branch and b.legal_entity_id = v_entity and b.status = 'enabled') then
    perform authz.finance_invalid();
  end if;

  v_collector := authz.finance_uuid(authz.finance_field(p_fields, 'collectorUserId'));
  if v_mode = 'cash' then
    if v_collector is null or not exists (
         select 1 from public.staff_profiles p
         join public.memberships m on m.user_id = p.user_id
         where p.user_id = v_collector and p.status = 'active' and m.status = 'active' and m.legal_entity_id = v_entity) then
      perform authz.finance_invalid();
    end if;
  elsif v_collector is not null then
    perform authz.finance_invalid();
  end if;

  v_payer := authz.finance_text(authz.finance_field(p_fields, 'payerName'), 1, 200, false);
  v_pan := upper(authz.finance_text(authz.finance_field(p_fields, 'payerPan'), 1, 10, false));
  v_mobile := authz.finance_mobile(authz.finance_field(p_fields, 'payerMobile'));
  if v_payer is null or (v_pan is not null and v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$') or (v_pan is null and v_mobile is null) then
    perform authz.finance_invalid();
  end if;

  v_reference := authz.finance_text(authz.finance_field(p_fields, 'reference'), 1, 40, false);
  if v_mode in ('bank_transfer', 'upi') then
    if v_reference is null or v_reference !~ '^[A-Za-z0-9/-]{6,40}$' then
      perform authz.finance_invalid();
    end if;
    v_norm := upper(replace(replace(v_reference, ' ', ''), '-', ''));
  elsif v_reference is not null then
    perform authz.finance_invalid();
  end if;

  v_micr := authz.finance_text(authz.finance_field(p_fields, 'micrCode'), 1, 9, false);
  v_cheque_no := authz.finance_text(authz.finance_field(p_fields, 'chequeNumber'), 1, 6, false);
  v_cheque_date := authz.finance_date(authz.finance_field(p_fields, 'chequeDate'));
  v_payee := p_fields -> 'accountPayee';
  if v_payee is not null and jsonb_typeof(v_payee) = 'null' then
    v_payee := null;
  end if;
  if v_mode = 'cheque' then
    if v_micr is null or v_micr !~ '^[0-9]{9}$' or v_cheque_no is null or v_cheque_no !~ '^[0-9]{6}$'
       or v_cheque_date is null or v_cheque_date not between v_today - 90 and v_today + 90
       or v_payee is distinct from 'true'::jsonb then
      perform authz.finance_invalid();
    end if;
  elsif v_micr is not null or v_cheque_no is not null or v_cheque_date is not null or v_payee is not null then
    perform authz.finance_invalid();
  end if;

  v_booking := authz.finance_uuid(authz.finance_field(p_fields, 'bookingVersionId'));
  -- B1.1 revision: a superseded version is named as such.
  if v_booking is not null and exists (
       select 1 from public.booking_versions v where v.id = v_booking and v.deal_id = v_deal.id and v.status = 'superseded') then
    raise exception 'version_superseded' using errcode = '55000';
  end if;
  if v_booking is not null and not exists (
       select 1 from public.booking_versions v where v.id = v_booking and v.deal_id = v_deal.id and v.status = 'confirmed') then
    perform authz.finance_invalid();
  end if;
  v_corrects := authz.finance_uuid(authz.finance_field(p_fields, 'correctsReceiptId'));
  v_note := authz.finance_text(authz.finance_field(p_fields, 'note'), 1, 500, true);

  -- Lock 3: the receipt being corrected. Its link is set first so the
  -- correction may reuse the genuine reference and the caps exclude it.
  if v_corrects is not null then
    select * into v_orig from public.customer_receipts r where r.id = v_corrects for update;
    if v_orig.id is null or v_orig.deal_id <> v_deal.id or v_orig.mode <> v_mode then
      perform authz.finance_invalid();
    end if;
    if v_orig.corrected_by_receipt_id is not null
       or not ((v_orig.status = 'rejected' and v_orig.rejection_kind = 'data_error')
               or (v_orig.status = 'reversed' and v_orig.reversal_kind = 'data_error')) then
      raise exception 'wrong_state' using errcode = '55000';
    end if;
    update public.customer_receipts r set corrected_by_receipt_id = v_id, updated_at = now() where r.id = v_orig.id;
  end if;

  -- Lock 4 (Stage 2): the company destination of a bank-transfer or UPI
  -- receipt, read under a share lock so retirement or replacement cannot
  -- interleave. A correction selects the current version too; it never
  -- inherits the original receipt's version. A mismatch is refused, never
  -- replaced by another version.
  v_dest_version := authz.finance_uuid(authz.finance_field(p_fields, 'destinationVersionId'));
  if v_mode in ('bank_transfer', 'upi') then
    if v_dest_version is null then
      perform authz.finance_invalid();
    end if;
    select * into v_dv from public.company_destination_versions dv
    where dv.id = v_dest_version and dv.legal_entity_id = v_entity;
    if v_dv.id is not null then
      select * into v_dest from public.company_destinations d where d.id = v_dv.destination_id for share;
    end if;
    if v_dv.id is null or v_dest.retired_at is not null or v_dest.current_version_id is distinct from v_dv.id
       or v_dv.status <> 'approved'
       or v_dest.kind <> (case v_mode when 'bank_transfer' then 'bank' else 'upi' end)
       or v_dest.is_synthetic is distinct from v_deal.is_synthetic then
      raise exception 'destination_changed' using errcode = '55000';
    end if;
    v_snapshot := jsonb_build_object('destinationId', v_dest.id, 'versionId', v_dv.id, 'versionNo', v_dv.version_no,
      'kind', v_dest.kind, 'label', v_dest.label, 'holderName', v_dv.holder_name, 'bankName', v_dv.bank_name,
      'accountNumber', v_dv.account_number, 'ifsc', v_dv.ifsc, 'payeeName', v_dv.payee_name, 'upiId', v_dv.upi_id);
  elsif v_dest_version is not null then
    perform authz.finance_invalid();
  end if;

  -- Lock 5: cash caps (contract 9.2). Counted cash: recorded, verified,
  -- reversed or rejected, except not_received outcomes and receipts
  -- superseded by a correction (a correction can never be not_received, so
  -- the end of a correction chain always counts and the cash counts once).
  if v_mode = 'cash' then
    if v_pan is not null then
      v_keys := v_keys || ('cash-payer|' || v_entity::text || '|pan:' || v_pan || '|' || to_char(v_received, 'YYYY-MM-DD'));
    end if;
    if v_mobile is not null then
      v_keys := v_keys || ('cash-payer|' || v_entity::text || '|mobile:' || v_mobile || '|' || to_char(v_received, 'YYYY-MM-DD'));
    end if;
    v_keys := v_keys || ('cash-trip|' || v_entity::text || '|' || v_deal.id::text);
    for v_hash in select distinct hashtextextended(k, 0) from unnest(v_keys) as k order by 1 loop
      perform pg_advisory_xact_lock(v_hash);
    end loop;

    if v_pan is not null then
      select coalesce(sum(r.amount_paise), 0) into v_sum from public.customer_receipts r
      where r.legal_entity_id = v_entity and r.mode = 'cash' and r.received_on = v_received and r.payer_pan = v_pan
        and r.status in ('recorded', 'verified', 'reversed', 'rejected')
        and not (r.status = 'rejected' and r.rejection_kind = 'not_received')
        and not (r.status = 'reversed' and r.reversal_kind = 'not_received')
        and r.corrected_by_receipt_id is null;
      if v_sum + v_amount > v_policy.cash_payer_day_cap_paise then
        raise exception 'cash_cap_exceeded' using errcode = '55000', detail = 'payer_day';
      end if;
    end if;
    if v_mobile is not null then
      select coalesce(sum(r.amount_paise), 0) into v_sum from public.customer_receipts r
      where r.legal_entity_id = v_entity and r.mode = 'cash' and r.received_on = v_received and r.payer_mobile = v_mobile
        and r.status in ('recorded', 'verified', 'reversed', 'rejected')
        and not (r.status = 'rejected' and r.rejection_kind = 'not_received')
        and not (r.status = 'reversed' and r.reversal_kind = 'not_received')
        and r.corrected_by_receipt_id is null;
      if v_sum + v_amount > v_policy.cash_payer_day_cap_paise then
        raise exception 'cash_cap_exceeded' using errcode = '55000', detail = 'payer_day';
      end if;
    end if;
    select coalesce(sum(r.amount_paise), 0) into v_sum from public.customer_receipts r
    where r.deal_id = v_deal.id and r.mode = 'cash'
      and r.status in ('recorded', 'verified', 'reversed', 'rejected')
      and not (r.status = 'rejected' and r.rejection_kind = 'not_received')
      and not (r.status = 'reversed' and r.reversal_kind = 'not_received')
      and r.corrected_by_receipt_id is null;
    if v_sum + v_amount > v_policy.cash_trip_cap_paise then
      raise exception 'cash_cap_exceeded' using errcode = '55000', detail = 'trip';
    end if;
  end if;

  -- Duplicate references (the unique indexes also refuse concurrent races).
  if v_mode in ('bank_transfer', 'upi') and exists (
       select 1 from public.customer_receipts r
       where r.legal_entity_id = v_entity and r.mode in ('bank_transfer', 'upi') and r.reference_norm = v_norm
         and r.corrected_by_receipt_id is null) then
    raise exception 'duplicate_reference' using errcode = '23505';
  end if;
  if v_mode = 'cheque' and exists (
       select 1 from public.customer_receipts r
       where r.legal_entity_id = v_entity and r.mode = 'cheque' and r.micr_code = v_micr and r.cheque_number = v_cheque_no
         and r.corrected_by_receipt_id is null) then
    raise exception 'duplicate_reference' using errcode = '23505';
  end if;

  -- Lock 6: the receipt counter of the recording date's fiscal year (IST).
  v_fy := authz.finance_fiscal_year(v_today);
  insert into public.finance_receipt_counters (legal_entity_id, fiscal_year) values (v_entity, v_fy) on conflict do nothing;
  update public.finance_receipt_counters c set last_no = c.last_no + 1
  where c.legal_entity_id = v_entity and c.fiscal_year = v_fy
  returning c.last_no into v_seq;
  v_no := 'R-' || v_fy || '-' || lpad(v_seq::text, 6, '0');

  begin
    insert into public.customer_receipts (id, legal_entity_id, deal_id, branch_id, receipt_no, fiscal_year, mode, status,
      amount_paise, received_on, collector_user_id, payer_name, payer_pan, payer_mobile, reference, reference_norm,
      micr_code, cheque_number, cheque_date, account_payee, booking_version_id, corrects_receipt_id, note,
      policy_version_id, request_id, recorded_by, recorded_at, destination_version_id, destination_snapshot)
    values (v_id, v_entity, v_deal.id, v_branch, v_no, v_fy, v_mode, 'recorded',
      v_amount, v_received, v_collector, v_payer, v_pan, v_mobile, v_reference, v_norm,
      v_micr, v_cheque_no, v_cheque_date, case when v_mode = 'cheque' then true end, v_booking, v_corrects, v_note,
      v_policy.id, p_request_id, (select auth.uid()), v_t, v_dv.id, v_snapshot);
  exception
    when unique_violation then
      raise exception 'duplicate_reference' using errcode = '23505';
    -- Stage 2: the row now carries a destination snapshot; never let a
    -- constraint error echo it ("Failing row contains ...").
    when check_violation or not_null_violation or foreign_key_violation then
      raise exception 'invalid_input' using errcode = '22023';
  end;

  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'receiptNo', v_no, 'status', 'recorded');
  perform authz.finance_remember(v_entity, p_request_id, 'receipt_record', v_payload, v_result);
  perform authz.write_audit('finance.receipt_recorded', v_entity, v_branch, 'customer_receipt', v_id, null,
    jsonb_build_object('dealId', v_deal.id, 'receiptNo', v_no, 'mode', v_mode, 'policyVersionNo', v_policy.version_no,
      'correctsReceiptId', v_corrects, 'destinationVersionId', v_dv.id));
  return v_result;
end;
$$;

-- ===========================================================================
-- 6. Department task reads follow the item's current accepted version
-- ===========================================================================

-- Replaces 20261118000100.
create or replace function authz.task_budget(p_task uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(f.purchase_budget_paise, v.purchase_budget_paise)
  from public.fulfilment_tasks t
  join public.booking_versions v on v.id = authz.task_current_version(t.id)
  left join public.service_item_facts f on f.service_item_id = t.service_item_id and f.booking_version_id = v.id
  where t.id = p_task
$$;

-- Replaces 20261119000100.
create or replace function authz.task_participants_json(p_task uuid, p_identity boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('seq', s.seq, 'fullName', s.full_name, 'type', s.traveller_type,
      'ageYears', s.age_years, 'specialNeeds', s.special_needs)
    || case when p_identity and authz.can_read_traveller_identity(t.deal_id, s.seq) then coalesce((
         select jsonb_build_object('dateOfBirth', to_char(x.date_of_birth, 'YYYY-MM-DD'), 'nationality', x.nationality,
           'passportNumber', x.passport_number, 'passportExpiry', to_char(x.passport_expiry, 'YYYY-MM-DD'))
         from public.deal_travellers dt join public.traveller_identities x on x.traveller_id = dt.id
         where dt.deal_id = t.deal_id and dt.seq = s.seq),
         jsonb_build_object('dateOfBirth', null, 'nationality', null, 'passportNumber', null, 'passportExpiry', null))
       else '{}'::jsonb end
    order by s.seq), '[]'::jsonb)
  from public.fulfilment_tasks t
  join public.booking_version_travellers s on s.booking_version_id = authz.task_current_version(t.id)
  where t.id = p_task
    and s.seq = any (authz.item_participant_seqs(t.service_item_id, authz.task_current_version(t.id)))
$$;

-- Replaces 20261119000100.
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
  ) else '{}'::jsonb end
  from x
  join public.booking_versions v on v.id = authz.task_current_version(x.id)
  join public.deals d on d.id = x.deal_id
  join public.branches b on b.id = x.branch_id
  left join public.staff_profiles ap on ap.user_id = x.assignee_user_id
  left join public.staff_profiles cp on cp.user_id = v.confirmed_by
$$;

-- Replaces 20261119000100.
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
  ) else '{}'::jsonb end
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

-- Replaces 20261118000100: review state, open revision and canRevise.
create or replace function public.booking_panel(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_version jsonb;
  v_readiness jsonb;
  v_issues text[];
  v_evidence jsonb;
  v_task jsonb;
  v_can_edit boolean;
  v_can_confirm boolean;
  v_services jsonb;
  -- B1.1 revision
  v_revision public.booking_versions%rowtype;
  v_review public.accounts_booking_reviews%rowtype;
  v_editor boolean;
  v_review_json jsonb;
  v_revision_json jsonb;
  v_can_revise boolean := false;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Purchase role holders and non-readers get null (Purchase uses purchase_task_*).
  if p_deal_id is null or not authz.can_read_booking(p_deal_id) then
    return null;
  end if;

  select * into v_ver from public.booking_versions v
  where v.deal_id = p_deal_id and v.status in ('draft', 'confirmed')  -- B1.1 revision
  order by (v.status = 'confirmed') desc, v.version_no desc
  limit 1;

  if v_ver.id is not null then
    v_version := jsonb_build_object(
      'versionId', v_ver.id,
      'versionNo', v_ver.version_no,
      'status', v_ver.status,
      'rowVersion', v_ver.row_version,
      'contentHash', v_ver.content_hash,
      'facts', authz.booking_facts_json(v_ver.id),
      -- B1
      'serviceType', v_ver.service_type,
      'confirmedAt', v_ver.confirmed_at,
      'confirmedByName', (select p.display_name from public.staff_profiles p where p.user_id = v_ver.confirmed_by));
    if authz.can_read_deal_commercial(p_deal_id) then
      v_version := v_version || jsonb_build_object('sellingTotalPaise',
        (select c.selling_total_paise::text from public.booking_version_commercials c where c.version_id = v_ver.id));
    end if;
    if v_ver.status = 'draft' then
      v_issues := authz.booking_issues_for_viewer(v_ver.id);
      v_readiness := jsonb_build_object('ready', cardinality(v_issues) = 0, 'issues', to_jsonb(v_issues),
        'contentHash', v_ver.content_hash);
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
        'id', e.id,
        'kind', e.kind,
        'fileName', e.file_name,
        'mime', e.mime,
        'sizeBytes', e.size_bytes,
        'status', e.status,
        'uploadedByYou', e.uploaded_by = (select auth.uid()),
        'createdAt', e.created_at,
        'storedAt', e.stored_at) order by e.created_at, e.id), '[]'::jsonb)
    into v_evidence
    from public.booking_evidence e
    where e.version_id = v_ver.id and e.status <> 'removed'
      and authz.can_read_booking_evidence(p_deal_id);  -- A4 M2
    -- B1: the first task of the version (the hotel task for hotel versions);
    -- only for full booking readers (review E6: a department-scoped viewer
    -- gets its own tasks through services[], never another department's).
    if authz.deal_services_scope(p_deal_id) is null then
      select jsonb_build_object('taskId', t.id, 'status', t.status, 'assigneeName', p.display_name)
      into v_task
      from public.fulfilment_tasks t
      join public.service_items i on i.id = t.service_item_id
      left join public.staff_profiles p on p.user_id = t.assignee_user_id
      where t.booking_version_id = v_ver.id
         or t.service_item_id in (select f.service_item_id from public.service_item_facts f where f.booking_version_id = v_ver.id)
      order by i.item_no, t.created_at
      limit 1;
    end if;
  end if;

  v_can_edit := coalesce(v_ver.status, 'draft') = 'draft' and authz.can_edit_booking_draft(p_deal_id);
  v_can_confirm := v_ver.status = 'draft' and authz.can_confirm_booking(p_deal_id);
  v_services := authz.deal_services_json(p_deal_id);

  -- B1.1 revision: Accounts review state for editors and acceptors (reason
  -- only when it was shared with Sales), the open revision and "Fix this booking".
  v_editor := authz.can_edit_booking_draft(p_deal_id) or authz.can_confirm_booking(p_deal_id);
  if v_editor and v_ver.status = 'confirmed' then
    select * into v_review from public.accounts_booking_reviews rv where rv.booking_version_id = v_ver.id;
    v_review_json := jsonb_build_object('status', coalesce(v_review.status, 'pending'), 'reviewedAt', v_review.reviewed_at,
      'reason', case when v_review.status = 'returned' and v_review.reason_shared_with_sales then v_review.return_reason end,
      'reasonHidden', coalesce(v_review.status = 'returned' and not v_review.reason_shared_with_sales, false));
    select * into v_revision from public.booking_versions v
    where v.revises_version_id = v_ver.id and v.status = 'draft';
    if v_revision.id is not null then
      v_revision_json := jsonb_build_object('versionId', v_revision.id, 'versionNo', v_revision.version_no,
        'rowVersion', v_revision.row_version, 'contentHash', v_revision.content_hash, 'changeClass', v_revision.change_class,
        'changedFields', to_jsonb(authz.revision_changed_fields(v_revision.id)),
        'allowedClasses', to_jsonb(authz.revision_allowed_classes(authz.revision_changed_fields(v_revision.id))),
        'readiness', jsonb_build_object('issues', to_jsonb(authz.booking_issues_for_viewer(v_revision.id))));
    end if;
    v_can_revise := v_ver.service_type = 'package' and v_review.status = 'returned' and v_revision.id is null
      and authz.can_edit_booking_draft(p_deal_id) and not authz.deal_committed(p_deal_id)
      and not authz.deal_not_active(p_deal_id) and authz.service_items_enabled();
  end if;

  return jsonb_build_object(
    'dealId', p_deal_id,
    'canEdit', coalesce(v_can_edit, false),
    'canConfirm', coalesce(v_can_confirm, false),
    'gate', jsonb_build_object(
      'realBookingEnabled', coalesce((select s.real_booking_enabled from public.booking_settings s where s.id), false),
      'environment', authz.deployment_environment()),
    'version', v_version,
    'readiness', v_readiness,
    'evidence', coalesce(v_evidence, '[]'::jsonb),
    -- Re-review M-NEW-1: tells the UI the list was withheld, not empty.
    'evidenceVisible', authz.can_read_booking_evidence(p_deal_id),
    'task', v_task,
    -- Stage 7: the Deal is lost or rejected in Bitrix, so a new booking cannot be started.
    'dealNotActive', authz.deal_not_active(p_deal_id),
    -- B1
    'services', coalesce(v_services -> 'items', '[]'::jsonb),
    'progress', coalesce(v_services -> 'progress', authz.deal_progress_json(p_deal_id, null)),
    'serviceItemsEnabled', authz.service_items_enabled(),
    -- B1.1 revision
    'accountsReview', v_review_json,
    'revision', v_revision_json,
    'canRevise', v_can_revise);
end;
$$;

-- Replaces 20261119000100: revision drafts in the checklist.
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
       where e.version_id = v_ver.id and e.kind = 'acceptance_message' and e.status = 'stored') then
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

-- Replaces 20261119000200 (Mercury reviews): booking.revision and booking.earlierVersions.
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
        'prefillSource', bp.prefill_source)
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

-- Replaces 20261119000100: identity changes clear an open revision's class (review R1).
create or replace function authz.b11_rehash_deal() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  -- Review R1: an identity change also clears an open revision's class (as
  -- every draft save does through bump_package_version).
  update public.booking_versions v set content_hash = v.content_hash,
    change_class = case when v.revises_version_id is not null then null else v.change_class end,
    changed_fields = case when v.revises_version_id is not null then null else v.changed_fields end
  where v.deal_id in (case when tg_op = 'INSERT' then null else old.deal_id end,
                      case when tg_op = 'DELETE' then null else new.deal_id end)
    and v.status = 'draft' and v.service_type = 'package';
  return null;
end;
$$;

-- Replaces 20261119000100: the Flight clause follows the task's current version (review R2).
create or replace function authz.can_read_traveller_identity(p_deal uuid, p_seq integer) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_seq is not null and (
    authz.can_edit_booking_draft(p_deal) or authz.can_confirm_booking(p_deal)
    or exists (
      select 1 from public.fulfilment_tasks t
      join public.booking_versions v on v.id = authz.task_current_version(t.id)  -- review R2
      where t.deal_id = p_deal and t.department = 'flight' and t.status = 'in_progress'
        and t.assignee_user_id = (select auth.uid()) and authz.holds_active_role('flight', t.legal_entity_id)
        and v.trip_scope = 'international'
        and exists (select 1 from public.service_item_travellers p
                    where p.service_item_id = t.service_item_id and p.traveller_seq = p_seq
                      and p.booking_version_id = (select c.id from public.booking_versions c
                                                  where c.deal_id = p_deal and c.status = 'confirmed'))))
$$;

-- ===========================================================================
-- 7. Grants
-- ===========================================================================

revoke all on function
  public.booking_open_revision(uuid),
  public.booking_classify_revision(uuid, integer, text),
  public.booking_discard_draft(uuid, integer),
  public.booking_version_history(uuid)
from public, anon, authenticated, service_role;
grant execute on function
  public.booking_open_revision(uuid),
  public.booking_classify_revision(uuid, integer, text),
  public.booking_discard_draft(uuid, integer),
  public.booking_version_history(uuid)
to authenticated;

commit;
