-- TripNavigate CRM - Direction A Batch 2 (R3): automatic fill of new drafts
-- from the stored Bitrix snapshot, behind the new workflow switch
-- prefill_auto_fill (default OFF).
--
-- Contract: docs/implementation/frontend-redesign-2026-10-15/contracts.md
-- section A as amended by F.1 (deliberate clearing is never undone), F.2 (the
-- kept state can be checked and stays weaker than checked), F.5 and F.6
-- (Echo rulings). Owner-approved behaviour changes BC-A1, BC-A3, BC-A5, BC-A8
-- and BC-A8b (plan.md section 12). Lead ruling 20 Oct 2026: with the switch
-- Off every existing command behaves exactly as today.
--
-- What changes:
--   1. Workflow switch prefill_auto_fill (off). workflow_settings_audit is
--      recreated from its latest definition (20261119000100) with the new
--      column; admin_set_workflow_setting (latest body 20261119000500)
--      accepts the key and waits at most 5 s for the settings row
--      (lock_timeout only around that row; 55P03 there -> settings_busy).
--      workflow_settings_get adds prefillAutoFill.
--   2. Value-free provenance:
--      * prefill_marks.state gains kept and replaced_by_quotation; new column
--        applied_via (apply | auto_fill | fill_empty).
--      * prefill_field_history: per target and field, when staff last wrote a
--        non-empty value and when they last cleared it. No values, no hashes.
--        Written by the four replaced watcher triggers (which now also fire
--        on INSERT of booking_versions / quotation_versions). Recorded with
--        the switch on or off (invisible; it lets a later switch-on honour
--        clearing). The fill and apply commands of the same target are not
--        staff writes (guard tripnavigate.prefill_apply).
--      * prefill_history_settings.started_at: targets created before it have
--        no history and need audit-absence proof (F.1.2).
--      * prefill_fill_runs (append-only) and prefill_notice_dismissals.
--      * Partial index on audit_events (target_id, action) for booking and
--        quotation versions (audit-absence proof).
--   3. One predicate for every fill path: authz.prefill_field_block /
--      authz.prefill_field_untouched (F.1.3).
--   4. Commands:
--      * booking_start_draft (C2): booking_open_draft plus, when a new package
--        draft was created and the switch is on, the creation fill (C1).
--      * quotation_create (replaced): creation fill for version 1 when the
--        switch is on; a replay fills nothing.
--      * prefill_fill_empty (C3): "Fill empty fields from Bitrix" (explicit;
--        switch on only, else switch_off).
--      * prefill_notice_dismiss (C4): "Keep mine".
--      * prefill_mark_checked (replaced): also upgrades kept; notChecked.
--      * booking_prefill_apply / quotation_prefill_apply (replaced, "Use it"):
--        switch on only: refuse cleared_by_staff and accepted_quotation per
--        field; booking "Use it" on the name or booking-for keeps an existing
--        confirmation (BC-A5). Switch off: today's behaviour.
--      * booking_trip_save, booking_contacts_save, booking_customer_save,
--        quotation_version_save, quotation_contacts_save (replaced): switch
--        on only: unchanged Bitrix marks of the saved section become kept
--        (BC-A8); audit keptFields.
--      * authz.b11_contacts_write (replaced): switch on only: a fresh contact
--        confirmation checks the mobile and e-mail marks (BC-A8b).
--      * quotation_new_version (replaced): copies the value-free history.
--      * quotation_convert_to_booking (replaced): draft_not_empty ignores
--        untouched automatic values (BC-A3); their marks become
--        replaced_by_quotation.
--   5. Reads: authz.prefill_view (used by booking_form_get and quotation_get)
--      adds autoFill and fieldStates (notices computed on read, nothing
--      stored); intake_checklist (body 20261120000600) and quotation_get (body
--      20261120000800) count kept as unchecked. Reads write nothing.
--
-- Never: billing, GSTIN, consent, contact confirmation, money or acceptance
-- are filled; no fill on any read; no Bitrix write.
--
-- Refusal tokens added: 55P03 settings_busy; 55000 switch_off (prefill_fill_empty
-- while the switch is off). Existing tokens unchanged
-- (wrong_state hint 'copy' for revision and conversion drafts).
--
-- Any later migration that replaces a function below must copy THIS body.
--
-- Rollback (forward-only): turn the switch off (behaviour returns to today's
-- for every existing command). A new migration may revoke execute on
-- booking_start_draft, prefill_fill_empty and prefill_notice_dismiss. Marks,
-- history, runs and dismissals are kept.
--
-- Apply history: disposable local and CI stacks only. Amended in place on
-- 20 October 2026 (lead ruling Q2: prefill_fill_empty refuses switch_off and
-- autoFill.canFillEmpty is false while the switch is off) before any kept or
-- live database applied it. Amended in place again on 20 October 2026 after
-- the Echo-A review (echo-redesign-batch2-data.md: M1, L1-L6) before any kept
-- or live database applied it.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Switch
-- ===========================================================================

alter table public.workflow_settings
  add column prefill_auto_fill boolean not null default false;
drop trigger workflow_settings_audit on public.workflow_settings;
create trigger workflow_settings_audit
  after insert or update or delete on public.workflow_settings
  for each row execute function authz.audit_settings_change(
    'settings.workflow_changed', 'intake_prompt_enabled', 'service_items_enabled', 'visa_passport_tasks_enabled',
    'prefill_auto_fill');
comment on column public.workflow_settings.prefill_auto_fill is
  'Batch 2: new booking and quotation drafts start with Bitrix details in empty fields (contracts.md A). Off: every existing command behaves as before 20261122000100. Switching on needs the owner''s APPROVE.';

create function authz.prefill_auto_fill_enabled() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.prefill_auto_fill from public.workflow_settings s where s.id), false)
$$;

-- ===========================================================================
-- 2. Tables
-- ===========================================================================

do $$
declare
  v_name text;
begin
  select c.conname into v_name from pg_constraint c
  where c.conrelid = 'public.prefill_marks'::regclass and c.contype = 'c'
    and pg_get_constraintdef(c.oid) like '%from_bitrix%';
  execute format('alter table public.prefill_marks drop constraint %I', v_name);
end;
$$;
alter table public.prefill_marks
  add constraint prefill_marks_state_check
    check (state in ('from_bitrix', 'kept', 'checked', 'changed', 'replaced_by_quotation')),
  add column applied_via text not null default 'apply' check (applied_via in ('apply', 'auto_fill', 'fill_empty'));
comment on column public.prefill_marks.applied_via is
  'Batch 2: which path wrote the value: apply ("Use Bitrix value" / "Use it"), auto_fill (creation fill) or fill_empty ("Fill empty fields from Bitrix").';

create table public.prefill_field_history (
  target_kind text not null check (target_kind in ('booking_version', 'quotation_version')),
  target_id uuid not null,
  field_code text not null check (field_code in ('trip.start', 'trip.end', 'requirementsNote', 'contacts.contactName',
    'contacts.mobile', 'contacts.email', 'contacts.companyName', 'contacts.bookingFor')),
  legal_entity_id uuid not null references public.legal_entities (id),
  first_staff_write_at timestamptz,
  last_staff_write_at timestamptz,
  -- No foreign key: a missing profile must never block a staff save.
  last_staff_write_by uuid,
  cleared_at timestamptz,
  cleared_by uuid,
  primary key (target_kind, target_id, field_code),
  check ((first_staff_write_at is null) = (last_staff_write_at is null)),
  check (first_staff_write_at is not null or cleared_at is not null)
);
create index prefill_field_history_entity_idx on public.prefill_field_history (legal_entity_id);
comment on table public.prefill_field_history is
  'Batch 2 (contracts F.1.1): when staff last wrote a non-empty value into a prefill field and when they last cleared it. Value-free: no values, no hashes. Written only by triggers and commands. No Data API read.';

create table public.prefill_history_settings (
  id boolean primary key default true check (id),
  started_at timestamptz not null default now()
);
insert into public.prefill_history_settings (id) values (true);
comment on table public.prefill_history_settings is
  'Single row: when value-free field history started (20261122000100). Targets created earlier need audit-absence proof (contracts F.1.2).';

create table public.prefill_fill_runs (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  target_kind text not null check (target_kind in ('booking_version', 'quotation_version')),
  target_id uuid not null,
  mode text not null check (mode in ('create', 'fill_empty')),
  source_object text not null check (source_object in ('deal', 'lead')),
  source_modified_at timestamptz,
  filled text[] not null default '{}',
  skipped jsonb not null default '[]'::jsonb check (jsonb_typeof(skipped) = 'array'),
  ran_by uuid,
  ran_at timestamptz not null default now()
);
create unique index prefill_fill_runs_create_unique on public.prefill_fill_runs (target_kind, target_id) where mode = 'create';
create index prefill_fill_runs_target_idx on public.prefill_fill_runs (target_id);
create index prefill_fill_runs_entity_idx on public.prefill_fill_runs (legal_entity_id);
comment on table public.prefill_fill_runs is
  'Batch 2: one row per automatic (create) or explicit (fill_empty) fill of a draft: field codes and skip reasons only, no values. Append-only.';

create table public.prefill_notice_dismissals (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  target_kind text not null check (target_kind in ('booking_version', 'quotation_version')),
  target_id uuid not null,
  field_code text not null check (field_code in ('trip.start', 'trip.end', 'requirementsNote', 'contacts.contactName',
    'contacts.mobile', 'contacts.email', 'contacts.companyName', 'contacts.bookingFor')),
  source_modified_at timestamptz not null,
  dismissed_by uuid,
  dismissed_at timestamptz not null default now(),
  constraint prefill_notice_dismissals_unique unique (target_kind, target_id, field_code, source_modified_at)
);
create index prefill_notice_dismissals_entity_idx on public.prefill_notice_dismissals (legal_entity_id);
comment on table public.prefill_notice_dismissals is
  'Batch 2 "Keep mine": a Bitrix change notice dismissed for one snapshot time. No values. Append-only.';

create function authz.prefill_history_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'prefill history is append-only' using errcode = '42501';
  end if;
  if old.cleared_at is not null and (new.cleared_at is null or new.cleared_at < old.cleared_at) then
    raise exception 'prefill history clearing moves forward only' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger prefill_field_history_a_guard before update or delete on public.prefill_field_history
  for each row execute function authz.prefill_history_guard();
create function authz.prefill_append_only() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = '42501';
end;
$$;
create trigger prefill_fill_runs_a_guard before update or delete on public.prefill_fill_runs
  for each row execute function authz.prefill_append_only();
create trigger prefill_notice_dismissals_a_guard before update or delete on public.prefill_notice_dismissals
  for each row execute function authz.prefill_append_only();
create trigger prefill_field_history_no_truncate before truncate on public.prefill_field_history
  for each statement execute function authz.prefill_append_only();
create trigger prefill_fill_runs_no_truncate before truncate on public.prefill_fill_runs
  for each statement execute function authz.prefill_append_only();
create trigger prefill_notice_dismissals_no_truncate before truncate on public.prefill_notice_dismissals
  for each statement execute function authz.prefill_append_only();

alter table public.prefill_field_history enable row level security;
alter table public.prefill_history_settings enable row level security;
alter table public.prefill_fill_runs enable row level security;
alter table public.prefill_notice_dismissals enable row level security;
create policy require_valid_session on public.prefill_field_history as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
create policy require_valid_session on public.prefill_history_settings as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
create policy require_valid_session on public.prefill_fill_runs as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
create policy require_valid_session on public.prefill_notice_dismissals as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.prefill_field_history, public.prefill_history_settings, public.prefill_fill_runs,
  public.prefill_notice_dismissals from public, anon, authenticated, service_role;

-- F.1.2: audit-absence proof reads only action names and field lists of one target.
create index audit_events_prefill_target_idx on public.audit_events (target_id, action)
  where target_type in ('booking_version', 'quotation_version');

-- ===========================================================================
-- 3. History writers (replaced watchers; values compared in memory only)
-- ===========================================================================

-- One tracked field of one target changed in a row write. p_insert: the row
-- was inserted (an empty value is then not a clearing). Fills and "Use it" of
-- the same target set tripnavigate.prefill_apply and are not staff writes.
create function authz.prefill_history_note(p_entity uuid, p_kind text, p_target uuid, p_field text, p_old text,
  p_new text, p_insert boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_old_empty boolean := p_insert or nullif(btrim(coalesce(p_old, '')), '') is null;
  v_new_empty boolean := nullif(btrim(coalesce(p_new, '')), '') is null;
  v_at timestamptz := clock_timestamp();
begin
  if coalesce(current_setting('tripnavigate.prefill_apply', true), '') = p_target::text then
    return;
  end if;
  if not p_insert and p_old is not distinct from p_new then
    return;
  end if;
  if not v_new_empty then
    insert into public.prefill_field_history as h (target_kind, target_id, field_code, legal_entity_id,
      first_staff_write_at, last_staff_write_at, last_staff_write_by)
    values (p_kind, p_target, p_field, p_entity, v_at, v_at, (select auth.uid()))
    on conflict (target_kind, target_id, field_code) do update
      -- Echo L2: never move backwards (a wall-clock step back must not block a save).
      set first_staff_write_at = coalesce(h.first_staff_write_at, excluded.first_staff_write_at),
          last_staff_write_by = case when excluded.last_staff_write_at >= coalesce(h.last_staff_write_at, '-infinity'::timestamptz)
                                     then excluded.last_staff_write_by else h.last_staff_write_by end,
          last_staff_write_at = greatest(h.last_staff_write_at, excluded.last_staff_write_at);
  elsif not v_old_empty then
    insert into public.prefill_field_history as h (target_kind, target_id, field_code, legal_entity_id, cleared_at, cleared_by)
    values (p_kind, p_target, p_field, p_entity, v_at, (select auth.uid()))
    on conflict (target_kind, target_id, field_code) do update
      set cleared_by = case when excluded.cleared_at >= coalesce(h.cleared_at, '-infinity'::timestamptz)
                            then excluded.cleared_by else h.cleared_by end,
          cleared_at = greatest(h.cleared_at, excluded.cleared_at);
  end if;
end;
$$;

-- Review E5-1 (20261120000600), Batch 2: never turns replaced_by_quotation into changed.
create or replace function authz.prefill_mark_changed(p_kind text, p_target uuid, p_fields text[]) returns void
language sql volatile security definer set search_path = '' as $$
  update public.prefill_marks m set state = 'changed'
  where m.target_kind = p_kind and m.target_id = p_target and m.field_code = any (p_fields)
    and m.state not in ('changed', 'replaced_by_quotation')
    and coalesce(current_setting('tripnavigate.prefill_apply', true), '') is distinct from p_target::text
$$;

-- Replace 20261120000600 bodies: same mark rule plus the value-free history;
-- the version watchers also handle INSERT (Echo L3, F.6 N6).
create or replace function authz.prefill_watch_booking_version() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_ins boolean := tg_op = 'INSERT';
begin
  if not v_ins then
    perform authz.prefill_mark_changed('booking_version', new.id, array_remove(array[
      case when new.trip_start is distinct from old.trip_start then 'trip.start' end,
      case when new.trip_end is distinct from old.trip_end then 'trip.end' end], null));
  end if;
  perform authz.prefill_history_note(new.legal_entity_id, 'booking_version', new.id, 'trip.start',
    case when v_ins then null else old.trip_start::text end, new.trip_start::text, v_ins);
  perform authz.prefill_history_note(new.legal_entity_id, 'booking_version', new.id, 'trip.end',
    case when v_ins then null else old.trip_end::text end, new.trip_end::text, v_ins);
  return null;
end;
$$;
create or replace function authz.prefill_watch_booking_contacts() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_ins boolean := tg_op = 'INSERT';
begin
  perform authz.prefill_mark_changed('booking_version', new.booking_version_id, array_remove(array[
    case when tg_op = 'INSERT' or new.contact_name is distinct from old.contact_name then 'contacts.contactName' end,
    case when tg_op = 'INSERT' or new.mobile is distinct from old.mobile then 'contacts.mobile' end,
    case when tg_op = 'INSERT' or new.email is distinct from old.email then 'contacts.email' end,
    case when tg_op = 'INSERT' or new.booking_for is distinct from old.booking_for then 'contacts.bookingFor' end], null));
  perform authz.prefill_history_note(new.legal_entity_id, 'booking_version', new.booking_version_id, 'contacts.contactName',
    case when v_ins then null else old.contact_name end, new.contact_name, v_ins);
  perform authz.prefill_history_note(new.legal_entity_id, 'booking_version', new.booking_version_id, 'contacts.mobile',
    case when v_ins then null else old.mobile end, new.mobile, v_ins);
  perform authz.prefill_history_note(new.legal_entity_id, 'booking_version', new.booking_version_id, 'contacts.email',
    case when v_ins then null else old.email end, new.email, v_ins);
  perform authz.prefill_history_note(new.legal_entity_id, 'booking_version', new.booking_version_id, 'contacts.bookingFor',
    case when v_ins then null else old.booking_for end, new.booking_for, v_ins);
  return null;
end;
$$;
create or replace function authz.prefill_watch_quotation_version() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_ins boolean := tg_op = 'INSERT';
begin
  if not v_ins then
    perform authz.prefill_mark_changed('quotation_version', new.id, array_remove(array[
      case when new.trip_start is distinct from old.trip_start then 'trip.start' end,
      case when new.trip_end is distinct from old.trip_end then 'trip.end' end,
      case when new.requirements_note is distinct from old.requirements_note then 'requirementsNote' end], null));
  end if;
  perform authz.prefill_history_note(new.legal_entity_id, 'quotation_version', new.id, 'trip.start',
    case when v_ins then null else old.trip_start::text end, new.trip_start::text, v_ins);
  perform authz.prefill_history_note(new.legal_entity_id, 'quotation_version', new.id, 'trip.end',
    case when v_ins then null else old.trip_end::text end, new.trip_end::text, v_ins);
  perform authz.prefill_history_note(new.legal_entity_id, 'quotation_version', new.id, 'requirementsNote',
    case when v_ins then null else old.requirements_note end, new.requirements_note, v_ins);
  return null;
end;
$$;
create or replace function authz.prefill_watch_quotation_contacts() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_ins boolean := tg_op = 'INSERT';
begin
  perform authz.prefill_mark_changed('quotation_version', new.quotation_version_id, array_remove(array[
    case when tg_op = 'INSERT' or new.contact_name is distinct from old.contact_name then 'contacts.contactName' end,
    case when tg_op = 'INSERT' or new.mobile is distinct from old.mobile then 'contacts.mobile' end,
    case when tg_op = 'INSERT' or new.email is distinct from old.email then 'contacts.email' end,
    case when tg_op = 'INSERT' or new.company_name is distinct from old.company_name then 'contacts.companyName' end,
    case when tg_op = 'INSERT' or new.booking_for is distinct from old.booking_for then 'contacts.bookingFor' end], null));
  perform authz.prefill_history_note(new.legal_entity_id, 'quotation_version', new.quotation_version_id, 'contacts.contactName',
    case when v_ins then null else old.contact_name end, new.contact_name, v_ins);
  perform authz.prefill_history_note(new.legal_entity_id, 'quotation_version', new.quotation_version_id, 'contacts.mobile',
    case when v_ins then null else old.mobile end, new.mobile, v_ins);
  perform authz.prefill_history_note(new.legal_entity_id, 'quotation_version', new.quotation_version_id, 'contacts.email',
    case when v_ins then null else old.email end, new.email, v_ins);
  perform authz.prefill_history_note(new.legal_entity_id, 'quotation_version', new.quotation_version_id, 'contacts.companyName',
    case when v_ins then null else old.company_name end, new.company_name, v_ins);
  perform authz.prefill_history_note(new.legal_entity_id, 'quotation_version', new.quotation_version_id, 'contacts.bookingFor',
    case when v_ins then null else old.booking_for end, new.booking_for, v_ins);
  return null;
end;
$$;
drop trigger booking_versions_z_prefill on public.booking_versions;
create trigger booking_versions_z_prefill after insert or update of trip_start, trip_end on public.booking_versions
  for each row execute function authz.prefill_watch_booking_version();
drop trigger quotation_versions_z_prefill on public.quotation_versions;
create trigger quotation_versions_z_prefill after insert or update of trip_start, trip_end, requirements_note
  on public.quotation_versions
  for each row execute function authz.prefill_watch_quotation_version();

-- ===========================================================================
-- 4. Marks, values and the one precedence predicate
-- ===========================================================================

-- Records (or re-arms) a mark, naming the path that wrote the value.
create function authz.prefill_mark(p_entity uuid, p_kind text, p_target uuid, p_field text, p_source text,
  p_modified timestamptz, p_via text) returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.prefill_marks as m (legal_entity_id, target_kind, target_id, field_code, source_object, source_modified_at,
    state, applied_by, applied_via)
  values (p_entity, p_kind, p_target, p_field, p_source, p_modified, 'from_bitrix', (select auth.uid()), p_via)
  on conflict (target_kind, target_id, field_code) do update
    set source_object = excluded.source_object, source_modified_at = excluded.source_modified_at,
        state = 'from_bitrix', applied_by = excluded.applied_by, applied_at = now(), checked_by = null, checked_at = null,
        applied_via = excluded.applied_via
$$;
-- Replaces 20261120000600: the explicit apply path ("Use Bitrix value" / "Use it").
create or replace function authz.prefill_mark(p_entity uuid, p_kind text, p_target uuid, p_field text, p_source text,
  p_modified timestamptz) returns void
language sql volatile security definer set search_path = '' as $$
  select authz.prefill_mark(p_entity, p_kind, p_target, p_field, p_source, p_modified, 'apply')
$$;

-- The value a fill would write for one field, normalised like the fill
-- (null when Bitrix has nothing usable). Notes only with p_show_notes.
create function authz.prefill_candidate(p_fields jsonb, p_field text, p_show_notes boolean) returns text
language sql stable set search_path = '' as $$
  select case p_field
    when 'trip.start' then (select to_char(d, 'YYYY-MM-DD') from (select authz.sf_date(p_fields -> 'tourStart') as d) x
                            where d between date '2000-01-01' and date '2100-12-31')
    when 'trip.end' then (select to_char(d, 'YYYY-MM-DD') from (select authz.sf_date(p_fields -> 'tourEnd') as d) x
                          where d between date '2000-01-01' and date '2100-12-31')
    when 'requirementsNote' then case when coalesce(p_show_notes, false)
                                      then nullif(btrim(left(coalesce(p_fields ->> 'bookingNotes', ''), 4000)), '') end
    when 'contacts.contactName' then nullif(left(btrim(coalesce(p_fields -> 'contact' ->> 'name', '')), 120), '')
    when 'contacts.mobile' then authz.prefill_mobile(p_fields -> 'contact' ->> 'mobile')
    when 'contacts.email' then case when length(p_fields -> 'contact' ->> 'email') <= 254
                                     and (p_fields -> 'contact' ->> 'email') ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$'
                                    then p_fields -> 'contact' ->> 'email' end
    when 'contacts.companyName' then nullif(left(btrim(coalesce(p_fields -> 'company' ->> 'name', '')), 200), '')
    when 'contacts.bookingFor' then authz.prefill_booking_for(p_fields)
  end
$$;

-- Skip reason when prefill_candidate is null.
create function authz.prefill_candidate_reason(p_fields jsonb, p_field text, p_show_notes boolean) returns text
language sql immutable set search_path = '' as $$
  select case
    when p_field = 'requirementsNote' and not coalesce(p_show_notes, false) then 'not_allowed'
    when p_field = 'contacts.mobile' and p_fields -> 'contact' ->> 'mobile' is not null then 'mobile_format'
    else 'no_value' end
$$;

-- The saved value of one field (text; compared in memory, never stored).
create function authz.prefill_saved_value(p_kind text, p_target uuid, p_field text) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when p_kind = 'booking_version' and p_field in ('trip.start', 'trip.end') then (
      select to_char(case p_field when 'trip.start' then b.trip_start else b.trip_end end, 'YYYY-MM-DD')
      from public.booking_versions b where b.id = p_target)
    when p_kind = 'booking_version' and p_field like 'contacts.%' then (
      select case p_field when 'contacts.contactName' then c.contact_name when 'contacts.mobile' then c.mobile
                          when 'contacts.email' then c.email when 'contacts.bookingFor' then c.booking_for end
      from public.booking_version_contacts c where c.booking_version_id = p_target)
    when p_kind = 'quotation_version' and p_field in ('trip.start', 'trip.end', 'requirementsNote') then (
      select case p_field when 'trip.start' then to_char(v.trip_start, 'YYYY-MM-DD')
                          when 'trip.end' then to_char(v.trip_end, 'YYYY-MM-DD') else v.requirements_note end
      from public.quotation_versions v where v.id = p_target)
    when p_kind = 'quotation_version' and p_field like 'contacts.%' then (
      select case p_field when 'contacts.contactName' then c.contact_name when 'contacts.mobile' then c.mobile
                          when 'contacts.email' then c.email when 'contacts.companyName' then c.company_name
                          when 'contacts.bookingFor' then c.booking_for end
      from public.quotation_version_contacts c where c.quotation_version_id = p_target)
  end
$$;

-- The latest staff event of the field is a clearing (Echo M1, F.6 N3).
create function authz.prefill_cleared_last(p_kind text, p_target uuid, p_field text) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select h.cleared_at is not null and (h.last_staff_write_at is null or h.cleared_at >= h.last_staff_write_at)
                   from public.prefill_field_history h
                   where h.target_kind = p_kind and h.target_id = p_target and h.field_code = p_field), false)
$$;

-- Older targets (created before history started): no staff save of the
-- field's group in the append-only audit trail (F.1.2; action names and
-- field lists only, never values).
create function authz.prefill_audit_absent(p_kind text, p_target uuid, p_field text) returns boolean
language sql stable security definer set search_path = '' as $$
  select not exists (
    select 1 from public.audit_events a
    where a.target_id = p_target and a.target_type = p_kind
      -- Echo L1: literal list so the partial index audit_events_prefill_target_idx applies.
      and a.target_type in ('booking_version', 'quotation_version')
      and case
        when p_kind = 'booking_version' and p_field in ('trip.start', 'trip.end') then
          a.action in ('booking.trip_saved', 'booking.draft_saved')
          or (a.action = 'booking.prefill_applied' and coalesce(a.details -> 'fields', '[]'::jsonb) ? p_field)
        when p_kind = 'booking_version' then
          a.action in ('booking.contacts_saved', 'booking.draft_saved')
          or (a.action = 'booking.prefill_applied' and coalesce(a.details -> 'fields', '[]'::jsonb) ? p_field)
        when p_field in ('trip.start', 'trip.end', 'requirementsNote') then
          (a.action = 'quotation.version_saved'
            and (jsonb_typeof(a.details -> 'changedFields') is distinct from 'array'
                 or (a.details -> 'changedFields') ? (case p_field when 'trip.start' then 'start' when 'trip.end' then 'end'
                                                       else 'requirementsNote' end)))
          or (a.action = 'quotation.prefill_applied' and coalesce(a.details -> 'fields', '[]'::jsonb) ? p_field)
        else
          a.action = 'quotation.contacts_saved'
          or (a.action = 'quotation.prefill_applied' and coalesce(a.details -> 'fields', '[]'::jsonb) ? p_field)
      end)
$$;

-- F.1.3: why a fill path may NOT write this field (null = untouched, it may).
--   not_empty | cleared_by_staff | accepted_quotation | not_provable | copy | wrong_state
-- p_check_state = false is used for the base of a quotation version (its
-- state is sent or superseded; only the field's own history counts there).
create function authz.prefill_field_block(p_kind text, p_target uuid, p_field text, p_check_state boolean) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_mark public.prefill_marks%rowtype;
  v_started timestamptz := (select s.started_at from public.prefill_history_settings s where s.id);
  v_bv public.booking_versions%rowtype;
  v_qv public.quotation_versions%rowtype;
  v_base text;
begin
  if p_kind = 'booking_version' then
    select * into v_bv from public.booking_versions b where b.id = p_target;
    if v_bv.id is null then
      return 'wrong_state';
    end if;
    if p_check_state and (v_bv.revises_version_id is not null or v_bv.source_quotation_version_id is not null) then
      return 'copy';
    end if;
    if p_check_state and (v_bv.status <> 'draft' or v_bv.service_type <> 'package') then
      return 'wrong_state';
    end if;
    -- Echo M1 (A.3 #1, A.4): while the Deal has an accepted, unconverted
    -- quotation (own or linked), its facts outrank Bitrix: no fill path writes.
    if p_check_state and exists (select 1 from public.quotations q
                                 where (q.deal_id = v_bv.deal_id or q.linked_deal_id = v_bv.deal_id)
                                   and q.accepted_version_id is not null and q.converted_at is null) then
      return 'accepted_quotation';
    end if;
  elsif p_kind = 'quotation_version' then
    select * into v_qv from public.quotation_versions v where v.id = p_target;
    if v_qv.id is null then
      return 'wrong_state';
    end if;
    if p_check_state and (v_qv.status not in ('draft', 'ready')
                          or exists (select 1 from public.quotations q where q.id = v_qv.quotation_id and q.converted_at is not null)) then
      return 'wrong_state';
    end if;
  else
    return 'wrong_state';
  end if;
  if p_field not in ('trip.start', 'trip.end', 'requirementsNote', 'contacts.contactName', 'contacts.mobile', 'contacts.email',
                     'contacts.companyName', 'contacts.bookingFor')
     or (p_kind = 'booking_version' and p_field in ('requirementsNote', 'contacts.companyName')) then
    return 'wrong_state';
  end if;
  if nullif(btrim(coalesce(authz.prefill_saved_value(p_kind, p_target, p_field), '')), '') is not null then
    return 'not_empty';
  end if;
  select * into v_mark from public.prefill_marks m
  where m.target_kind = p_kind and m.target_id = p_target and m.field_code = p_field;
  if v_mark.id is not null then
    return case when v_mark.state = 'replaced_by_quotation' then 'accepted_quotation' else 'cleared_by_staff' end;
  end if;
  if exists (select 1 from public.prefill_field_history h
             where h.target_kind = p_kind and h.target_id = p_target and h.field_code = p_field) then
    return 'cleared_by_staff';
  end if;
  if coalesce(v_bv.created_at, v_qv.created_at) < v_started then
    -- Older target: version 1 / plain package draft and audit-absence proof, else excluded.
    if p_kind = 'quotation_version' and v_qv.version_no <> 1 then
      return 'not_provable';
    end if;
    if p_kind = 'booking_version' and (v_bv.revises_version_id is not null or v_bv.source_quotation_version_id is not null) then
      return 'not_provable';
    end if;
    if not authz.prefill_audit_absent(p_kind, p_target, p_field) then
      return 'not_provable';
    end if;
    return null;
  end if;
  -- A newer quotation version copied from an earlier one inherits that version's state of the field.
  if p_kind = 'quotation_version' and v_qv.based_on_version_id is not null then
    v_base := authz.prefill_field_block('quotation_version', v_qv.based_on_version_id, p_field, false);
    return case when v_base = 'not_empty' then 'not_provable' else v_base end;
  end if;
  return null;
end;
$$;

create function authz.prefill_field_untouched(p_kind text, p_target uuid, p_field text) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.prefill_field_block(p_kind, p_target, p_field, true) is null
$$;

-- BC-A3: the field holds only the creation fill's value (mark from_bitrix,
-- written by C1, and no staff history at all).
create function authz.prefill_auto_untouched(p_kind text, p_target uuid, p_field text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.prefill_marks m
                 where m.target_kind = p_kind and m.target_id = p_target and m.field_code = p_field
                   and m.state = 'from_bitrix' and m.applied_via = 'auto_fill')
     and not exists (select 1 from public.prefill_field_history h
                     where h.target_kind = p_kind and h.target_id = p_target and h.field_code = p_field)
$$;

-- BC-A8: unchanged Bitrix values of a saved section become kept (switch on,
-- not inside a fill or apply of the same target). Returns the kept codes.
create function authz.prefill_mark_kept(p_kind text, p_target uuid, p_fields text[]) returns text[]
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_kept text[];
begin
  if not authz.prefill_auto_fill_enabled()
     or coalesce(current_setting('tripnavigate.prefill_apply', true), '') = p_target::text then
    return '{}'::text[];
  end if;
  with u as (
    update public.prefill_marks m set state = 'kept'
    where m.target_kind = p_kind and m.target_id = p_target and m.field_code = any (p_fields) and m.state = 'from_bitrix'
    returning m.field_code)
  select coalesce(array_agg(u.field_code order by u.field_code), '{}'::text[]) into v_kept from u;
  return v_kept;
end;
$$;

-- ===========================================================================
-- 5. The fill (C1 creation fill and C3 explicit fill)
-- ===========================================================================

-- Fills the untouched empty fields of a locked, authorized draft target from
-- the stored snapshot (contracts A.4, A.7, F.1.3). One run row and one audit
-- row; values written under the target's guard (no staff history), marks
-- from_bitrix with applied_via = 'auto_fill' (p_mode create) or 'fill_empty'.
-- A filled contact is never confirmed by the fill; an existing confirmation
-- is cleared only when the fill writes a mobile or e-mail (Echo L10).
-- Returns {outcome: filled | unavailable, rowVersion, filled[], skipped[]}.
-- The caller has locked and authorized the target.
create function authz.prefill_fill(p_kind text, p_target uuid, p_mode text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_bv public.booking_versions%rowtype;
  v_qv public.quotation_versions%rowtype;
  v_q public.quotations%rowtype;
  v_entity uuid;
  v_branch uuid;
  v_subject_kind text;
  v_subject uuid;
  v_show_notes boolean := false;
  v jsonb;
  f jsonb;
  v_codes text[];
  v_field text;
  v_block text;
  v_cand jsonb := '{}'::jsonb;
  v_filled text[] := '{}'::text[];
  v_skipped jsonb := '[]'::jsonb;
  v_start date;
  v_end date;
  v_old_start date;
  v_old_end date;
  v_trip text[] := '{}'::text[];
  v_contact_fields text[] := '{}'::text[];
  v_bc public.booking_version_contacts%rowtype;
  v_qc public.quotation_version_contacts%rowtype;
  v_name text;
  v_mobile text;
  v_email text;
  v_company text;
  v_for text;
  v_rv integer;
  v_modified timestamptz;
  v_contact_ok boolean := false;  -- Echo L4
  v_returned boolean := false;
begin
  if p_mode not in ('create', 'fill_empty') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'mode';
  end if;
  if p_kind = 'booking_version' then
    select * into v_bv from public.booking_versions b where b.id = p_target;
    v_entity := v_bv.legal_entity_id;
    v_branch := v_bv.branch_id;
    v_subject_kind := 'deal';
    v_subject := v_bv.deal_id;
    v_codes := array['trip.start', 'trip.end', 'contacts.contactName', 'contacts.mobile', 'contacts.email', 'contacts.bookingFor'];
    v_old_start := v_bv.trip_start;
    v_old_end := v_bv.trip_end;
    v_rv := v_bv.row_version;
  else
    select * into v_qv from public.quotation_versions qv where qv.id = p_target;
    select * into v_q from public.quotations q where q.id = v_qv.quotation_id;
    v_entity := v_qv.legal_entity_id;
    v_branch := v_q.branch_id;
    v_subject_kind := case when v_q.deal_id is not null then 'deal' else 'lead' end;
    v_subject := coalesce(v_q.deal_id, v_q.lead_id);
    -- Lead decision A2: Booking Notes fill the requirements note only for callers with price scope.
    v_show_notes := authz.quotation_money_can_read(v_q.id);
    v_codes := array['trip.start', 'trip.end', 'requirementsNote', 'contacts.contactName', 'contacts.mobile', 'contacts.email',
      'contacts.companyName', 'contacts.bookingFor'];
    v_old_start := v_qv.trip_start;
    v_old_end := v_qv.trip_end;
    v_rv := v_qv.row_version;
  end if;
  v := authz.bitrix_prefill_json(v_subject_kind, v_subject);
  if not coalesce((v ->> 'available')::boolean, false) then
    return jsonb_build_object('outcome', 'unavailable', 'rowVersion', v_rv, 'filled', '[]'::jsonb, 'skipped', '[]'::jsonb);
  end if;
  f := v -> 'fields';
  v_modified := (v ->> 'sourceModifiedAt')::timestamptz;

  -- Which fields may be written, and with what (one predicate, F.1.3).
  foreach v_field in array v_codes loop
    v_block := authz.prefill_field_block(p_kind, p_target, v_field, true);
    if v_block = 'not_empty' then
      continue;
    elsif v_block is not null then
      v_skipped := v_skipped || jsonb_build_object('field', v_field, 'reason', v_block);
    elsif authz.prefill_candidate(f, v_field, v_show_notes) is null then
      v_skipped := v_skipped || jsonb_build_object('field', v_field,
        'reason', authz.prefill_candidate_reason(f, v_field, v_show_notes));
    else
      v_cand := v_cand || jsonb_build_object(v_field, authz.prefill_candidate(f, v_field, v_show_notes));
    end if;
  end loop;

  perform set_config('tripnavigate.prefill_apply', p_target::text, true);

  -- Trip dates (and the quotation's requirements note): order checked against the merged values.
  v_start := coalesce((v_cand ->> 'trip.start')::date, v_old_start);
  v_end := coalesce((v_cand ->> 'trip.end')::date, v_old_end);
  foreach v_field in array array['trip.start', 'trip.end'] loop
    if v_cand ? v_field then
      if v_start is not null and v_end is not null and v_end < v_start then
        v_skipped := v_skipped || jsonb_build_object('field', v_field, 'reason', 'date_order');
      else
        v_trip := v_trip || v_field;
      end if;
    end if;
  end loop;

  -- Contact plan: merged with the saved row; needs a name and a mobile or e-mail (nothing written yet).
  select array_agg(x order by x) into v_contact_fields from unnest(v_codes) x where x like 'contacts.%' and v_cand ? x;
  v_contact_fields := coalesce(v_contact_fields, '{}'::text[]);
  if cardinality(v_contact_fields) > 0 then
    if p_kind = 'booking_version' then
      select * into v_bc from public.booking_version_contacts c where c.booking_version_id = p_target;
      v_name := coalesce(v_cand ->> 'contacts.contactName', v_bc.contact_name);
      v_mobile := coalesce(v_cand ->> 'contacts.mobile', v_bc.mobile);
      v_email := coalesce(v_cand ->> 'contacts.email', v_bc.email);
      v_for := coalesce(v_cand ->> 'contacts.bookingFor', v_bc.booking_for, 'individual');
    else
      select * into v_qc from public.quotation_version_contacts c where c.quotation_version_id = p_target;
      v_name := coalesce(v_cand ->> 'contacts.contactName', v_qc.contact_name);
      v_mobile := coalesce(v_cand ->> 'contacts.mobile', v_qc.mobile);
      v_email := coalesce(v_cand ->> 'contacts.email', v_qc.email);
      v_company := coalesce(v_cand ->> 'contacts.companyName', v_qc.company_name);
      v_for := coalesce(v_cand ->> 'contacts.bookingFor', v_qc.booking_for);
    end if;
    if v_name is null then
      v_skipped := v_skipped || (select jsonb_agg(jsonb_build_object('field', x, 'reason', 'contact_name_missing')) from unnest(v_contact_fields) x);
    elsif v_mobile is null and v_email is null then
      v_skipped := v_skipped || (select jsonb_agg(jsonb_build_object('field', x, 'reason', 'contact_needs_mobile_or_email')) from unnest(v_contact_fields) x);
    else
      v_contact_ok := true;
    end if;
  end if;

  -- Echo L4: a ready quotation returns to draft only when something will be
  -- written (the row-version bump and the fill audit below record it).
  if p_kind = 'quotation_version' and v_qv.status = 'ready'
     and (cardinality(v_trip) > 0 or v_cand ? 'requirementsNote' or v_contact_ok) then
    update public.quotation_versions qv set status = 'draft', content_hash = null where qv.id = p_target;
    v_returned := true;
  end if;

  if p_kind = 'booking_version' then
    if cardinality(v_trip) > 0 then
      update public.booking_versions b
      set trip_start = case when 'trip.start' = any (v_trip) then (v_cand ->> 'trip.start')::date else b.trip_start end,
          trip_end = case when 'trip.end' = any (v_trip) then (v_cand ->> 'trip.end')::date else b.trip_end end
      where b.id = p_target
      returning * into v_bv;
      v_filled := v_filled || v_trip;
    end if;
  else
    if cardinality(v_trip) > 0 or v_cand ? 'requirementsNote' then
      update public.quotation_versions qv
      set trip_start = case when 'trip.start' = any (v_trip) then (v_cand ->> 'trip.start')::date else qv.trip_start end,
          trip_end = case when 'trip.end' = any (v_trip) then (v_cand ->> 'trip.end')::date else qv.trip_end end,
          requirements_note = case when v_cand ? 'requirementsNote' then v_cand ->> 'requirementsNote' else qv.requirements_note end
      where qv.id = p_target;
      v_filled := v_filled || v_trip;
      if v_cand ? 'requirementsNote' then
        v_filled := v_filled || 'requirementsNote'::text;
      end if;
    end if;
  end if;

  if v_contact_ok then
    if p_kind = 'booking_version' then
      perform authz.b11_contacts_write(v_bv, jsonb_build_object('contactName', v_name, 'mobile', v_mobile, 'email', v_email,
        -- Fills never confirm; an existing confirmation stays only while the mobile and e-mail are not written.
        'contactConfirmed', coalesce(v_bc.contact_confirmed, false)
                            and not (v_contact_fields && array['contacts.mobile', 'contacts.email']),
        'bookingFor', v_for, 'payerDifferent', coalesce(v_bc.payer_different, false), 'payerName', v_bc.payer_name));
    else
      insert into public.quotation_version_contacts as c (quotation_version_id, legal_entity_id, contact_name, mobile, email,
        company_name, booking_for, updated_by)
      values (p_target, v_entity, v_name, v_mobile, v_email, v_company, v_for, (select auth.uid()))
      on conflict (quotation_version_id) do update
        set contact_name = excluded.contact_name, mobile = excluded.mobile, email = excluded.email,
            company_name = excluded.company_name, booking_for = excluded.booking_for,
            updated_by = excluded.updated_by, updated_at = now();
    end if;
    v_filled := v_filled || v_contact_fields;
  end if;

  foreach v_field in array v_filled loop
    perform authz.prefill_mark(v_entity, p_kind, p_target, v_field, v_subject_kind, v_modified,
      case p_mode when 'create' then 'auto_fill' else 'fill_empty' end);
  end loop;
  if cardinality(v_filled) > 0 then
    if p_kind = 'booking_version' then
      v_rv := (authz.bump_package_version(p_target)).row_version;
    else
      v_rv := (authz.bump_quotation_version(p_target)).row_version;
    end if;
  end if;
  perform set_config('tripnavigate.prefill_apply', '', true);

  select coalesce(array_agg(x order by x), '{}'::text[]) into v_filled from unnest(v_filled) x;
  insert into public.prefill_fill_runs (legal_entity_id, target_kind, target_id, mode, source_object, source_modified_at, filled,
    skipped, ran_by)
  values (v_entity, p_kind, p_target, p_mode, v_subject_kind, v_modified, v_filled, v_skipped, (select auth.uid()));
  perform authz.write_audit(
    case when p_kind = 'booking_version' then 'booking.' else 'quotation.' end
      || case p_mode when 'create' then 'prefill_auto_filled' else 'prefill_filled_empty' end,
    v_entity, v_branch, p_kind, p_target, null,
    jsonb_build_object('versionId', p_target, 'fields', to_jsonb(v_filled), 'skipped', v_skipped,
      'sourceModifiedAt', v_modified, 'rowVersion', v_rv)
    || case when v_returned then jsonb_build_object('returnedToDraft', true) else '{}'::jsonb end
    || case when p_kind = 'booking_version' then jsonb_build_object('dealId', v_bv.deal_id)
            else jsonb_build_object('quotationId', v_q.id) end);
  return jsonb_build_object('outcome', 'filled', 'rowVersion', v_rv, 'filled', to_jsonb(v_filled), 'skipped', v_skipped);
end;
$$;

-- The creation fill inside a creating command (C1): never blocks the
-- creation. Switch off, Bitrix unavailable or any failure: nothing filled.
-- A failure writes *.prefill_auto_fill_failed with its SQLSTATE only (Echo L6).
create function authz.prefill_fill_on_create(p_kind text, p_target uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_res jsonb;
  v_rv integer;
  v_codes text[];
begin
  if not authz.prefill_auto_fill_enabled() then
    return jsonb_build_object('autoFill', 'off', 'filled', '[]'::jsonb, 'skipped', '[]'::jsonb);
  end if;
  begin
    v_res := authz.prefill_fill(p_kind, p_target, 'create');
  exception when others then
    v_rv := case when p_kind = 'booking_version'
                 then (select b.row_version from public.booking_versions b where b.id = p_target)
                 else (select qv.row_version from public.quotation_versions qv where qv.id = p_target) end;
    v_codes := case when p_kind = 'booking_version'
      then array['trip.start', 'trip.end', 'contacts.contactName', 'contacts.mobile', 'contacts.email', 'contacts.bookingFor']
      else array['trip.start', 'trip.end', 'requirementsNote', 'contacts.contactName', 'contacts.mobile', 'contacts.email',
                 'contacts.companyName', 'contacts.bookingFor'] end;
    -- Echo L6: one failure audit row, SQLSTATE only (never the message text or values).
    perform authz.write_audit(
      case when p_kind = 'booking_version' then 'booking.prefill_auto_fill_failed' else 'quotation.prefill_auto_fill_failed' end,
      t.legal_entity_id, t.branch_id, p_kind, p_target, null,
      jsonb_build_object('versionId', p_target, 'sqlState', SQLSTATE))
    from (select b.legal_entity_id, b.branch_id from public.booking_versions b where p_kind = 'booking_version' and b.id = p_target
          union all
          select qv.legal_entity_id, q.branch_id from public.quotation_versions qv join public.quotations q on q.id = qv.quotation_id
          where p_kind = 'quotation_version' and qv.id = p_target) t;
    return jsonb_build_object('autoFill', 'failed', 'rowVersion', v_rv, 'filled', '[]'::jsonb,
      'skipped', (select jsonb_agg(jsonb_build_object('field', x, 'reason', 'fill_failed')) from unnest(v_codes) x));
  end;
  return jsonb_build_object('autoFill', v_res ->> 'outcome', 'rowVersion', (v_res ->> 'rowVersion')::integer,
    'filled', v_res -> 'filled', 'skipped', v_res -> 'skipped');
end;
$$;

-- ===========================================================================
-- 6. New commands
-- ===========================================================================

-- C2 "Start booking": booking_open_draft (unchanged, conversion relies on it)
-- plus the creation fill when a NEW package draft was created, the Deal has
-- no accepted, unconverted quotation (own or linked; A.3) and the switch is on.
create function public.booking_start_draft(p_deal_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_open jsonb;
  v_ver public.booking_versions%rowtype;
  v_fill jsonb;
  v_reason text;
begin
  v_open := public.booking_open_draft(p_deal_id);
  select * into v_ver from public.booking_versions b where b.id = (v_open ->> 'versionId')::uuid;
  if not (v_open ->> 'created')::boolean then
    v_reason := 'existing_draft';
  elsif v_ver.service_type <> 'package' then
    v_reason := 'not_package';
  elsif not authz.prefill_auto_fill_enabled() then
    v_reason := 'off';
  elsif exists (select 1 from public.quotations q
                where (q.deal_id = p_deal_id or q.linked_deal_id = p_deal_id)
                  and q.accepted_version_id is not null and q.converted_at is null) then
    v_reason := 'accepted_quotation';
  end if;
  if v_reason is not null then
    return v_open || jsonb_build_object('autoFill', v_reason, 'filled', '[]'::jsonb, 'skipped', '[]'::jsonb);
  end if;
  v_fill := authz.prefill_fill_on_create('booking_version', v_ver.id);
  return v_open || jsonb_build_object('rowVersion', coalesce((v_fill ->> 'rowVersion')::integer, v_ver.row_version),
    'autoFill', v_fill ->> 'autoFill', 'filled', v_fill -> 'filled', 'skipped', v_fill -> 'skipped');
end;
$$;

-- C3 "Fill empty fields from Bitrix" (lead decision A1): explicit staff click;
-- fills only fields that pass authz.prefill_field_untouched. Refuses revision
-- and conversion drafts (wrong_state, hint copy) and non-working versions;
-- refuses switch_off while prefill_auto_fill is off.
create function public.prefill_fill_empty(p_target_kind text, p_target_id uuid, p_expected_row_version integer)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_bv public.booking_versions%rowtype;
  v_qv public.quotation_versions%rowtype;
  v_res jsonb;
begin
  if p_target_kind = 'booking_version' then
    v_bv := authz.lock_package_draft(p_target_id);
    perform authz.require_row_version(p_expected_row_version, v_bv.row_version);
    if v_bv.revises_version_id is not null or v_bv.source_quotation_version_id is not null then
      raise exception 'wrong_state' using errcode = '55000', hint = 'copy';
    end if;
  elsif p_target_kind = 'quotation_version' then
    -- Echo L4: lock without the ready -> draft flip; the fill returns a ready
    -- version to draft only when it writes something.
    v_qv := authz.lock_quotation_version(p_target_id);
    if exists (select 1 from public.quotations q where q.id = v_qv.quotation_id and q.converted_at is not null) then
      raise exception 'quotation_converted' using errcode = '55000';
    end if;
    if v_qv.status not in ('draft', 'ready') then
      raise exception 'wrong_state' using errcode = '55000';
    end if;
    perform authz.require_row_version(p_expected_row_version, v_qv.row_version);
  else
    raise exception 'invalid_input' using errcode = '22023', hint = 'targetKind';
  end if;
  -- Lead ruling 20 Oct 2026 (Q2): this new capability does not exist while
  -- prefill_auto_fill is off (authorization and the version check first).
  if not authz.prefill_auto_fill_enabled() then
    raise exception 'switch_off' using errcode = '55000';
  end if;
  v_res := authz.prefill_fill(p_target_kind, p_target_id, 'fill_empty');
  if v_res ->> 'outcome' = 'unavailable' then
    raise exception 'prefill_unavailable' using errcode = '55000';
  end if;
  return jsonb_build_object('rowVersion', (v_res ->> 'rowVersion')::integer, 'filled', v_res -> 'filled',
    'skipped', v_res -> 'skipped');
end;
$$;

-- C4 "Keep mine": hides the Bitrix change notice of one field until Bitrix
-- changes again. No row-version bump (like prefill_mark_checked).
create function public.prefill_notice_dismiss(p_target_kind text, p_target_id uuid, p_expected_row_version integer,
  p_field text, p_source_modified_at timestamptz) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entity uuid;
  v_branch uuid;
  v_rv integer;
  v_subject_kind text;  -- Echo L5
  v_subject uuid;
begin
  if p_target_kind = 'booking_version' then
    declare
      v_ver public.booking_versions%rowtype;
    begin
      v_ver := authz.lock_package_draft(p_target_id);
      v_entity := v_ver.legal_entity_id;
      v_branch := v_ver.branch_id;
      v_rv := v_ver.row_version;
      v_subject_kind := 'deal';
      v_subject := v_ver.deal_id;
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
      select q.branch_id, case when q.deal_id is not null then 'deal' else 'lead' end, coalesce(q.deal_id, q.lead_id)
      into v_branch, v_subject_kind, v_subject
      from public.quotations q where q.id = v_ver.quotation_id;
      v_rv := v_ver.row_version;
    end;
  else
    raise exception 'invalid_input' using errcode = '22023', hint = 'targetKind';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_rv);
  if p_field is null or p_field not in ('trip.start', 'trip.end', 'requirementsNote', 'contacts.contactName', 'contacts.mobile',
       'contacts.email', 'contacts.companyName', 'contacts.bookingFor')
     or (p_target_kind = 'booking_version' and p_field in ('requirementsNote', 'contacts.companyName')) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'field';
  end if;
  -- Echo L5: only a snapshot time that exists (never later than the current
  -- snapshot), so a dismissal cannot hide future Bitrix changes.
  if p_source_modified_at is null
     or p_source_modified_at > coalesce((authz.bitrix_prefill_json(v_subject_kind, v_subject) ->> 'sourceModifiedAt')::timestamptz,
                                        '-infinity'::timestamptz) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'sourceModifiedAt';
  end if;
  insert into public.prefill_notice_dismissals (legal_entity_id, target_kind, target_id, field_code, source_modified_at, dismissed_by)
  values (v_entity, p_target_kind, p_target_id, p_field, p_source_modified_at, (select auth.uid()))
  on conflict (target_kind, target_id, field_code, source_modified_at) do nothing;
  perform authz.write_audit('prefill.notice_kept', v_entity, v_branch, p_target_kind, p_target_id, null,
    jsonb_build_object('targetKind', p_target_kind, 'targetId', p_target_id, 'field', p_field,
      'sourceModifiedAt', p_source_modified_at));
  return jsonb_build_object('field', p_field, 'sourceModifiedAt', p_source_modified_at, 'dismissed', true);
end;
$$;

-- Replaces 20261120000600 (F.2 item 3): also upgrades kept; never changed or
-- replaced_by_quotation; notChecked names the requested fields not upgraded.
create or replace function public.prefill_mark_checked(p_target_kind text, p_target_id uuid, p_expected_row_version integer, p_fields text[])
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entity uuid;
  v_branch uuid;
  v_rv integer;
  v_checked text[];
  v_from_kept text[];
  v_not jsonb;
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
  select coalesce(array_agg(m.field_code order by m.field_code), '{}'::text[]) into v_from_kept
  from public.prefill_marks m
  where m.target_kind = p_target_kind and m.target_id = p_target_id and m.field_code = any (p_fields) and m.state = 'kept';
  with u as (
    update public.prefill_marks m set state = 'checked', checked_by = (select auth.uid()), checked_at = now()
    where m.target_kind = p_target_kind and m.target_id = p_target_id and m.field_code = any (p_fields)
      and m.state in ('from_bitrix', 'kept')
    returning m.field_code)
  select coalesce(array_agg(u.field_code order by u.field_code), '{}'::text[]) into v_checked from u;
  select coalesce(jsonb_agg(jsonb_build_object('field', x, 'state', m.state) order by x), '[]'::jsonb) into v_not
  from (select distinct unnest(p_fields) as x) r
  left join public.prefill_marks m on m.target_kind = p_target_kind and m.target_id = p_target_id and m.field_code = r.x
  where not (r.x = any (v_checked));
  perform authz.write_audit('prefill.checked', v_entity, v_branch, p_target_kind, p_target_id, null,
    jsonb_build_object('targetKind', p_target_kind, 'targetId', p_target_id, 'fields', to_jsonb(v_checked))
    || case when cardinality(v_from_kept) > 0 then jsonb_build_object('fromKept', to_jsonb(v_from_kept)) else '{}'::jsonb end);
  return jsonb_build_object('checked', to_jsonb(v_checked), 'notChecked', v_not);
end;
$$;

-- ===========================================================================
-- 7. Read block (replaces 20261120000600; booking_form_get and quotation_get
--    call it). Adds autoFill and fieldStates; computes "Bitrix now says"
--    notices on read (A.5); writes nothing.
-- ===========================================================================

create or replace function authz.prefill_view(p_subject_kind text, p_subject_id uuid, p_target_kind text, p_target uuid, p_show_notes boolean)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v jsonb;
  f jsonb;
  v_available boolean;
  v_modified timestamptz;
  v_codes text[];
  v_editable boolean := false;
  v_field text;
  v_mark public.prefill_marks%rowtype;
  v_hist public.prefill_field_history%rowtype;
  v_run public.prefill_fill_runs%rowtype;
  v_latest_run timestamptz;
  v_cand text;
  v_saved text;
  v_baseline timestamptz;
  v_cleared boolean;
  v_notice jsonb;
  v_states jsonb := '[]'::jsonb;
  v_can_fill boolean := false;
  v_block text;
begin
  if p_subject_id is null then
    return null;
  end if;
  v := authz.bitrix_prefill_json(p_subject_kind, p_subject_id);
  v_available := coalesce((v ->> 'available')::boolean, false);
  v_modified := (v ->> 'sourceModifiedAt')::timestamptz;
  f := v -> 'fields';
  if p_target is not null then
    if p_target_kind = 'booking_version' then
      v_codes := array['trip.start', 'trip.end', 'contacts.contactName', 'contacts.mobile', 'contacts.email', 'contacts.bookingFor'];
      v_editable := exists (select 1 from public.booking_versions b where b.id = p_target and b.status = 'draft'
                                                                   and b.service_type = 'package');
    else
      v_codes := array['trip.start', 'trip.end', 'requirementsNote', 'contacts.contactName', 'contacts.mobile', 'contacts.email',
        'contacts.companyName', 'contacts.bookingFor'];
      v_editable := exists (select 1 from public.quotation_versions qv join public.quotations q on q.id = qv.quotation_id
                            where qv.id = p_target and qv.status in ('draft', 'ready') and q.converted_at is null);
    end if;
    select * into v_run from public.prefill_fill_runs r
    where r.target_kind = p_target_kind and r.target_id = p_target and r.mode = 'create';
    select max(r.source_modified_at) into v_latest_run from public.prefill_fill_runs r
    where r.target_kind = p_target_kind and r.target_id = p_target;
    foreach v_field in array v_codes loop
      select * into v_mark from public.prefill_marks m
      where m.target_kind = p_target_kind and m.target_id = p_target and m.field_code = v_field;
      select * into v_hist from public.prefill_field_history h
      where h.target_kind = p_target_kind and h.target_id = p_target and h.field_code = v_field;
      v_saved := authz.prefill_saved_value(p_target_kind, p_target, v_field);
      v_cleared := nullif(btrim(coalesce(v_saved, '')), '') is null
                   and authz.prefill_cleared_last(p_target_kind, p_target, v_field);
      v_cand := case when v_available then authz.prefill_candidate(f, v_field, p_show_notes) end;
      v_notice := null;
      v_baseline := coalesce(v_mark.source_modified_at, v_latest_run);
      if v_editable and v_cand is not null and v_modified is not null and v_baseline is not null and v_modified > v_baseline
         and not v_cleared and v_mark.state is distinct from 'replaced_by_quotation'
         and (case when v_field = 'contacts.email' then lower(v_cand) is distinct from lower(v_saved)
                   else v_cand is distinct from v_saved end)
         and not exists (select 1 from public.prefill_notice_dismissals d
                         where d.target_kind = p_target_kind and d.target_id = p_target and d.field_code = v_field
                           and d.source_modified_at >= v_modified) then
        v_notice := jsonb_build_object('bitrixValue', v_cand, 'sourceModifiedAt', v_modified,
          'inline', coalesce(v_mark.state in ('from_bitrix', 'kept', 'checked'), false));
      end if;
      if v_editable and v_available and not v_can_fill and v_cand is not null and authz.prefill_auto_fill_enabled() then
        v_block := authz.prefill_field_block(p_target_kind, p_target, v_field, true);
        v_can_fill := v_block is null;
      end if;
      v_states := v_states || jsonb_build_object('field', v_field, 'state', v_mark.state, 'filledBy', v_mark.applied_via,
        'staffTouched', coalesce(v_hist.last_staff_write_at is not null, false), 'clearedByStaff', v_cleared,
        'notice', v_notice);
      v_mark := null;
      v_hist := null;
    end loop;
  end if;
  return jsonb_build_object(
    'available', v_available,
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
                       from public.prefill_marks m where m.target_kind = p_target_kind and m.target_id = p_target), '[]'::jsonb),
    -- Batch 2 (20261122000100)
    'autoFill', jsonb_build_object(
      'enabled', authz.prefill_auto_fill_enabled(),
      'run', case when v_run.id is null then null else jsonb_build_object('mode', v_run.mode, 'ranAt', v_run.ran_at,
               'filled', to_jsonb(v_run.filled), 'skipped', v_run.skipped) end,
      'canFillEmpty', v_can_fill),
    'fieldStates', v_states);
end;
$$;

-- ===========================================================================
-- 8. Replaced bodies (copied from their latest definitions; changes marked
--    "Batch 2")
-- ===========================================================================

-- authz.b11_contacts_write (replaces 20261119000100): BC-A8b contact tick.
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
begin
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'contact';
  end if;
  v_bad := authz.b11_unknown_keys(p_fields, array['contactName', 'mobile', 'email', 'contactConfirmed', 'bookingFor',
    'payerDifferent', 'payerName']);
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
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;

  select * into v_old from public.booking_version_contacts c where c.booking_version_id = p_ver.id for update;
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
    email, contact_confirmed, confirmed_by, confirmed_at, booking_for, payer_different, payer_name, updated_by)
  values (p_ver.id, p_ver.legal_entity_id, p_ver.deal_id, v_name, v_mobile, v_email, v_confirmed, v_by, v_at, v_for,
    v_payer_diff, v_payer, (select auth.uid()))
  on conflict (booking_version_id) do update
    set contact_name = excluded.contact_name, mobile = excluded.mobile, email = excluded.email,
        contact_confirmed = excluded.contact_confirmed, confirmed_by = excluded.confirmed_by,
        confirmed_at = excluded.confirmed_at, booking_for = excluded.booking_for,
        payer_different = excluded.payer_different, payer_name = excluded.payer_name, updated_by = excluded.updated_by;

  -- Batch 2 (BC-A8b, contracts F.2 item 5; switch on only): a fresh
  -- confirmation by this save checks the mobile and e-mail marks that are
  -- still from Bitrix or kept. A value changed in this same save is already
  -- 'changed' (watcher trigger), so it is never upgraded. Fills and "Use it"
  -- never confirm, so they never reach this.
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
    case when v_old.payer_name is distinct from v_payer then 'payerName' end], null);
end;
$$;

-- public.booking_contacts_save (replaces 20261119000100): kept marks (BC-A8).
create or replace function public.booking_contacts_save(p_version_id uuid, p_expected_row_version integer, p_fields jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_changed text[];
  v_kept text[];  -- Batch 2
begin
  v_ver := authz.lock_package_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  v_changed := authz.b11_contacts_write(v_ver, p_fields);
  v_kept := authz.prefill_mark_kept('booking_version', v_ver.id,
    array['contacts.contactName', 'contacts.mobile', 'contacts.email', 'contacts.bookingFor']);  -- Batch 2 (BC-A8)
  v_ver := authz.bump_package_version(v_ver.id);
  perform authz.write_audit('booking.contacts_saved', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id,
    null, jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'changedFields', to_jsonb(v_changed),
      'rowVersion', v_ver.row_version) || case when authz.prefill_auto_fill_enabled() then jsonb_build_object('keptFields', to_jsonb(v_kept)) else '{}'::jsonb end);
  return jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;

-- public.booking_customer_save (replaces 20261119000100): kept marks (BC-A8).
create or replace function public.booking_customer_save(
  p_version_id uuid, p_expected_row_version integer, p_contact jsonb, p_billing jsonb,
  p_billing_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_changed text[];
  v_kept text[];  -- Batch 2
  v_billing jsonb;
  v_result jsonb;
  v_payload jsonb := jsonb_build_object('versionId', p_version_id, 'expectedRowVersion', p_expected_row_version,
    'contact', p_contact, 'billing', p_billing, 'billingExpectedRowVersion', p_billing_expected_row_version);
begin
  v_ver := authz.lock_package_draft(p_version_id);
  -- Review A2: an exact retry of a committed step returns its stored result
  -- (finance_command_results, keyed by entity and request id) before the
  -- row-version check; another payload or actor is request_conflict.
  if p_request_id is not null then
    v_result := authz.finance_replay(v_ver.legal_entity_id, p_request_id, 'booking_customer_save', v_payload);
    if v_result is not null then
      return v_result;
    end if;
  elsif p_billing is not null and jsonb_typeof(p_billing) <> 'null' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  v_changed := authz.b11_contacts_write(v_ver, p_contact);
  v_kept := authz.prefill_mark_kept('booking_version', v_ver.id,
    array['contacts.contactName', 'contacts.mobile', 'contacts.email', 'contacts.bookingFor']);  -- Batch 2 (BC-A8)
  if p_billing is not null and jsonb_typeof(p_billing) <> 'null' then
    -- The billing part has its own derived request id (one result row per id).
    v_billing := authz.b11_billing_propose(v_ver.deal_id, p_billing_expected_row_version, p_billing,
      md5(p_request_id::text || ':billing')::uuid);
    v_billing := jsonb_build_object('outcome', v_billing ->> 'outcome', 'status', v_billing ->> 'status',
      'rowVersion', (v_billing ->> 'rowVersion')::integer);
  end if;
  v_ver := authz.bump_package_version(v_ver.id);
  perform authz.write_audit('booking.contacts_saved', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id,
    null, jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'changedFields', to_jsonb(v_changed),
      'rowVersion', v_ver.row_version) || case when authz.prefill_auto_fill_enabled() then jsonb_build_object('keptFields', to_jsonb(v_kept)) else '{}'::jsonb end);
  v_result := jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash, 'billing', v_billing);
  if p_request_id is not null then
    perform authz.finance_remember(v_ver.legal_entity_id, p_request_id, 'booking_customer_save', v_payload, v_result);
  end if;
  return v_result;
end;
$$;

-- public.booking_trip_save (replaces 20261119000100): kept marks (BC-A8).
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
begin
  v_ver := authz.lock_package_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'trip';
  end if;
  v_bad := authz.b11_unknown_keys(p_fields, array['destination', 'scope', 'start', 'end']);
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
  if (p_fields ? 'end' and jsonb_typeof(p_fields -> 'end') <> 'null' and v_end is null) or v_end < v_start then
    v_bad := v_bad || 'end'::text;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  update public.booking_versions v
  set trip_destination = v_dest, trip_scope = v_scope, trip_start = v_start, trip_end = v_end
  where v.id = v_ver.id;
  v_kept := authz.prefill_mark_kept('booking_version', v_ver.id, array['trip.start', 'trip.end']);  -- Batch 2 (BC-A8)
  v_ver := authz.bump_package_version(v_ver.id);
  perform authz.write_audit('booking.trip_saved', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'rowVersion', v_ver.row_version)
    || case when authz.prefill_auto_fill_enabled() then jsonb_build_object('keptFields', to_jsonb(v_kept)) else '{}'::jsonb end);
  return jsonb_build_object('rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;

-- public.quotation_version_save (replaces 20261120000200): kept marks (BC-A8).
create or replace function public.quotation_version_save(p_version_id uuid, p_expected_row_version integer, p_fields jsonb)
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
  v_kept text[];  -- Batch 2
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
  -- Batch 2 (BC-A8): the saved keys of the tracked fields.
  v_kept := authz.prefill_mark_kept('quotation_version', v_ver.id, array_remove(array[
    case when p_fields ? 'start' then 'trip.start' end, case when p_fields ? 'end' then 'trip.end' end,
    case when p_fields ? 'requirementsNote' then 'requirementsNote' end], null));
  v_ver := authz.bump_quotation_version(v_ver.id);
  perform authz.write_audit('quotation.version_saved', v_ver.legal_entity_id,
    (select q.branch_id from public.quotations q where q.id = v_ver.quotation_id), 'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_ver.quotation_id, 'versionNo', v_ver.version_no, 'changedFields', to_jsonb(v_changed),
      'rowVersion', v_ver.row_version) || case when authz.prefill_auto_fill_enabled() then jsonb_build_object('keptFields', to_jsonb(v_kept)) else '{}'::jsonb end);
  return jsonb_build_object('rowVersion', v_ver.row_version, 'status', v_ver.status);
end;
$$;

-- public.quotation_contacts_save (replaces 20261120000200): kept marks (BC-A8).
create or replace function public.quotation_contacts_save(p_version_id uuid, p_expected_row_version integer, p_fields jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions%rowtype;
  v_bad text[];
  v_mobile text;
  v_email text;
  v_kept text[];  -- Batch 2
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
  v_kept := authz.prefill_mark_kept('quotation_version', v_ver.id, array_remove(array['contacts.contactName', 'contacts.mobile',
    'contacts.email', 'contacts.companyName', case when p_fields ? 'bookingFor' then 'contacts.bookingFor' end], null));  -- Batch 2
  v_ver := authz.bump_quotation_version(v_ver.id);
  perform authz.write_audit('quotation.contacts_saved', v_ver.legal_entity_id,
    (select q.branch_id from public.quotations q where q.id = v_ver.quotation_id), 'quotation_version', v_ver.id, null,
    jsonb_build_object('quotationId', v_ver.quotation_id, 'versionNo', v_ver.version_no, 'rowVersion', v_ver.row_version)
    || case when authz.prefill_auto_fill_enabled() then jsonb_build_object('keptFields', to_jsonb(v_kept)) else '{}'::jsonb end);
  return jsonb_build_object('rowVersion', v_ver.row_version);
end;
$$;

-- public.quotation_create (replaces 20261120000200): creation fill (C1).
create or replace function public.quotation_create(p_subject_kind text, p_subject_id uuid, p_title text, p_request_id uuid)
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
  v_fill jsonb;  -- Batch 2
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
      'versionNo', 1, 'rowVersion', v_ver.row_version, 'created', false,
      'autoFill', 'existing_draft', 'filled', '[]'::jsonb, 'skipped', '[]'::jsonb);  -- Batch 2: a replay fills nothing
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
  -- Batch 2 (C1): the creation fill of version 1 (switch on; never blocks the creation).
  v_fill := authz.prefill_fill_on_create('quotation_version', v_ver.id);
  return jsonb_build_object('quotationId', v_q.id, 'reference', v_q.reference, 'versionId', v_ver.id, 'versionNo', 1,
    'rowVersion', coalesce((v_fill ->> 'rowVersion')::integer, v_ver.row_version), 'created', true,
    'autoFill', v_fill ->> 'autoFill', 'filled', v_fill -> 'filled', 'skipped', v_fill -> 'skipped');
end;
$$;

-- public.quotation_new_version (replaces 20261120000200): copies the value-free history (F.1.1).
create or replace function public.quotation_new_version(p_quotation_id uuid, p_base_version_id uuid, p_request_id uuid) returns jsonb
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
  -- Batch 2 (F.1.1 Copies): the new version inherits the base version's
  -- value-free history; the inserts above already recorded every non-empty
  -- copied field as a staff write. Latest events win.
  insert into public.prefill_field_history as h (target_kind, target_id, field_code, legal_entity_id, first_staff_write_at,
    last_staff_write_at, last_staff_write_by, cleared_at, cleared_by)
  select 'quotation_version', v_new.id, b.field_code, b.legal_entity_id, b.first_staff_write_at, b.last_staff_write_at,
    b.last_staff_write_by, b.cleared_at, b.cleared_by
  from public.prefill_field_history b where b.target_kind = 'quotation_version' and b.target_id = v_base.id
  on conflict (target_kind, target_id, field_code) do update
    set first_staff_write_at = least(h.first_staff_write_at, excluded.first_staff_write_at),
        last_staff_write_by = case when excluded.last_staff_write_at > coalesce(h.last_staff_write_at, '-infinity'::timestamptz)
                                   then excluded.last_staff_write_by else h.last_staff_write_by end,
        last_staff_write_at = greatest(h.last_staff_write_at, excluded.last_staff_write_at),
        cleared_by = case when excluded.cleared_at > coalesce(h.cleared_at, '-infinity'::timestamptz)
                          then excluded.cleared_by else h.cleared_by end,
        cleared_at = greatest(h.cleared_at, excluded.cleared_at);
  perform authz.write_audit('quotation.version_opened', v_q.legal_entity_id, v_q.branch_id, 'quotation_version', v_new.id, null,
    jsonb_build_object('quotationId', v_q.id, 'versionNo', v_new.version_no, 'basedOnVersionId', v_base.id));
  return jsonb_build_object('versionId', v_new.id, 'versionNo', v_new.version_no, 'rowVersion', v_new.row_version, 'created', true);
end;
$$;

-- public.quotation_convert_to_booking (replaces 20261120000200): BC-A3.
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
  -- Batch 2 (BC-A3, F.1.3, Echo L8): values written only by the creation
  -- fill (mark from_bitrix, applied_via auto_fill, no staff history) are not
  -- staff content; neither are the fill's unmarked contact defaults. Any
  -- other content still refuses draft_not_empty.
  if exists (select 1 from public.booking_versions b
             where b.id = v_booking
               and (b.service_type <> 'package' or b.revises_version_id is not null
                    or b.trip_destination is not null or b.trip_scope is not null
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
     or exists (select 1 from public.booking_version_instalments p where p.booking_version_id = v_booking) then
    raise exception 'draft_not_empty' using errcode = '55000';
  end if;
  select coalesce(array_agg(m.field_code order by m.field_code), '{}'::text[]) into v_auto
  from public.prefill_marks m
  where m.target_kind = 'booking_version' and m.target_id = v_booking
    and authz.prefill_auto_untouched('booking_version', v_booking, m.field_code);

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

-- public.booking_prefill_apply (replaces 20261120000600): "Use it" refusals and BC-A5 (switch on only).
create or replace function public.booking_prefill_apply(p_version_id uuid, p_expected_row_version integer, p_fields text[]) returns jsonb
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
  v_on boolean := authz.prefill_auto_fill_enabled();  -- Batch 2
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
  -- Batch 2 ("Use it", switch on only; lead ruling 20 Oct: off = today):
  -- an accepted quotation's value and a field staff cleared are not refilled.
  if v_on then
    select coalesce(jsonb_agg(jsonb_build_object('field', x, 'reason', r) order by x), '[]'::jsonb) into v_skipped
    from (select x, case when exists (select 1 from public.prefill_marks m
                                       where m.target_kind = 'booking_version' and m.target_id = v_ver.id and m.field_code = x
                                         and m.state = 'replaced_by_quotation') then 'accepted_quotation'
                         when nullif(btrim(coalesce(authz.prefill_saved_value('booking_version', v_ver.id, x), '')), '') is null
                              and authz.prefill_cleared_last('booking_version', v_ver.id, x) then 'cleared_by_staff' end as r
          from unnest(p_fields) x) z
    where r is not null;
    select coalesce(array_agg(x), '{}'::text[]) into p_fields from unnest(p_fields) x
    where not exists (select 1 from jsonb_array_elements(v_skipped) e where e ->> 'field' = x);
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
          -- Batch 2 (BC-A5, switch on): the name or "booking for" keeps an existing confirmation; a mobile or e-mail clears it.
          'contactConfirmed', v_on and coalesce(v_contact.contact_confirmed, false)
                              and not (v_contact_fields && array['contacts.mobile', 'contacts.email']),
          'bookingFor', coalesce(v_booking_for, 'individual'),
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

-- public.quotation_prefill_apply (replaces 20261120000600): "Use it" refusals (switch on only).
create or replace function public.quotation_prefill_apply(p_version_id uuid, p_expected_row_version integer, p_fields text[]) returns jsonb
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
  v_on boolean := authz.prefill_auto_fill_enabled();  -- Batch 2
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
  -- Batch 2 ("Use it", switch on only; lead ruling 20 Oct: off = today):
  -- an accepted quotation's value and a field staff cleared are not refilled.
  if v_on then
    select coalesce(jsonb_agg(jsonb_build_object('field', x, 'reason', r) order by x), '[]'::jsonb) into v_skipped
    from (select x, case when exists (select 1 from public.prefill_marks m
                                       where m.target_kind = 'quotation_version' and m.target_id = v_ver.id and m.field_code = x
                                         and m.state = 'replaced_by_quotation') then 'accepted_quotation'
                         when nullif(btrim(coalesce(authz.prefill_saved_value('quotation_version', v_ver.id, x), '')), '') is null
                              and authz.prefill_cleared_last('quotation_version', v_ver.id, x) then 'cleared_by_staff' end as r
          from unnest(p_fields) x) z
    where r is not null;
    select coalesce(array_agg(x), '{}'::text[]) into p_fields from unnest(p_fields) x
    where not exists (select 1 from jsonb_array_elements(v_skipped) e where e ->> 'field' = x);
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

-- public.admin_set_workflow_setting (replaces 20261119000500): prefill_auto_fill; settings_busy.
create or replace function public.admin_set_workflow_setting(p_key text, p_value boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before public.workflow_settings%rowtype;
  v_after public.workflow_settings%rowtype;
  v_reason text;
  v_prev text[];
  v_was boolean;
  v_now boolean;
  -- B1.1c
  v_created integer := 0;
  v_skipped integer := 0;
  v_item record;
  v_task uuid;
  v_timeout text;  -- Batch 2
begin
  if not authz.can_switch_live_settings(null) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_reason := authz.settings_change_reason(p_reason);
  if p_key is null or p_key not in ('intake_prompt_enabled', 'service_items_enabled', 'visa_passport_tasks_enabled',
                                    'prefill_auto_fill')
     or p_value is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- Batch 2 (Echo L11, F.6 N5): wait at most 5 s for the settings row only;
  -- a held row (55P03 here and only here) is settings_busy.
  v_timeout := current_setting('lock_timeout');
  begin
    perform set_config('lock_timeout', '5s', true);
    select * into v_before from public.workflow_settings s where s.id for update;
    perform set_config('lock_timeout', v_timeout, true);
  exception when lock_not_available then
    raise exception 'settings_busy' using errcode = '55P03';
  end;
  if v_before.id is null then
    raise exception 'settings row missing' using errcode = '55000';
  end if;

  v_prev := authz.settings_begin_change('admin_set_workflow_setting', v_reason);
  update public.workflow_settings s
  set intake_prompt_enabled = case when p_key = 'intake_prompt_enabled' then p_value else s.intake_prompt_enabled end,
      service_items_enabled = case when p_key = 'service_items_enabled' then p_value else s.service_items_enabled end,
      visa_passport_tasks_enabled = case when p_key = 'visa_passport_tasks_enabled' then p_value
                                         else s.visa_passport_tasks_enabled end,
      prefill_auto_fill = case when p_key = 'prefill_auto_fill' then p_value else s.prefill_auto_fill end
  where s.id
  returning * into v_after;
  perform authz.settings_end_change(v_prev);

  v_was := case p_key when 'intake_prompt_enabled' then v_before.intake_prompt_enabled
                      when 'service_items_enabled' then v_before.service_items_enabled
                      when 'prefill_auto_fill' then v_before.prefill_auto_fill
                      else v_before.visa_passport_tasks_enabled end;
  v_now := case p_key when 'intake_prompt_enabled' then v_after.intake_prompt_enabled
                      when 'service_items_enabled' then v_after.service_items_enabled
                      when 'prefill_auto_fill' then v_after.prefill_auto_fill
                      else v_after.visa_passport_tasks_enabled end;
  -- B1.1c: switching the desk on creates each missing task once (accepted
  -- visa/passport items); removed and lost Deals are skipped and counted.
  -- Review V3: also when already on (repair: Deals active again, a confirm that
  -- raced the first switch-on). Idempotent by task key.
  if p_key = 'visa_passport_tasks_enabled' and v_now then
    for v_item in
      select i.id, i.deal_id, i.service_type, i.department, v.id as version_id, v.version_no, v.legal_entity_id, v.branch_id,
        (d.removed_at is not null or authz.deal_not_active(d.id)) as skip
      from public.service_items i
      join public.booking_versions v on v.deal_id = i.deal_id and v.status = 'confirmed'
      join public.service_item_facts f on f.service_item_id = i.id and f.booking_version_id = v.id
      join public.deals d on d.id = i.deal_id
      where i.service_type in ('visa', 'passport') and i.state = 'active'
        and not exists (select 1 from public.fulfilment_tasks t where t.service_item_id = i.id)
      order by i.deal_id, i.item_no
    loop
      if v_item.skip then
        v_skipped := v_skipped + 1;
        continue;
      end if;
      v_task := null;
      insert into public.fulfilment_tasks (deal_id, legal_entity_id, branch_id, booking_version_id, service_purpose, task_key,
        created_by, service_item_id, department)
      values (v_item.deal_id, v_item.legal_entity_id, v_item.branch_id, v_item.version_id, v_item.service_type,
        'item:' || v_item.id::text || ':' || v_item.service_type, (select auth.uid()), v_item.id, 'visa')
      on conflict (task_key) do nothing
      returning id into v_task;
      if v_task is null then
        continue;
      end if;
      v_created := v_created + 1;
      insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
      values (v_item.legal_entity_id, 'fulfilment_task', v_task, 'fulfilment.task_created',
        jsonb_build_object('task_id', v_task, 'version_id', v_item.version_id, 'deal_id', v_item.deal_id,
          'version_no', v_item.version_no, 'service_purpose', v_item.service_type,
          'service_item_id', v_item.id, 'service_type', v_item.service_type))
      on conflict (event_type, aggregate_id) do nothing;
      perform authz.write_audit('fulfilment.task_created', v_item.legal_entity_id, v_item.branch_id,
        'fulfilment_task', v_task, null,
        jsonb_build_object('dealId', v_item.deal_id, 'versionId', v_item.version_id, 'versionNo', v_item.version_no,
          'serviceItemId', v_item.id, 'serviceType', v_item.service_type, 'cause', 'desk_launch'));
    end loop;
  end if;
  return jsonb_build_object('key', p_key, 'changed', v_was is distinct from v_now, 'before', v_was, 'after', v_now,
    'updatedAt', v_after.updated_at)
    || case when p_key = 'visa_passport_tasks_enabled' then jsonb_build_object('tasksCreated', v_created, 'skipped', v_skipped)
            else '{}'::jsonb end;
end;
$$;

-- public.workflow_settings_get (replaces 20261119000100): prefillAutoFill.
create or replace function public.workflow_settings_get() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return (select jsonb_build_object('intakePromptEnabled', s.intake_prompt_enabled,
    'serviceItemsEnabled', s.service_items_enabled,
    -- B1.1
    'visaPassportTasksEnabled', s.visa_passport_tasks_enabled,
    -- Batch 2
    'prefillAutoFill', s.prefill_auto_fill,
    'updatedAt', s.updated_at)
    from public.workflow_settings s where s.id);
end;
$$;

-- public.intake_checklist (replaces 20261120000600): kept counts as unchecked.
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

-- public.quotation_get (replaces 20261120000800): kept counts as unchecked.
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
      -- B1.2 0800 (DEC-50): the quotation's own branch (quotations.branch_id, fixed at creation).
      'branchCode', (select b.code from public.branches b where b.id = v_q.branch_id),
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
         where m.target_kind = 'quotation_version' and m.target_id = v_ver.id and m.state in ('from_bitrix', 'kept')), '[]'::jsonb)));
  if authz.quotation_money_can_read(v_q.id) then
    v_result := v_result || jsonb_build_object('money', authz.quotation_money_json(v_ver.id));
  end if;
  return v_result;
end;
$$;

-- ===========================================================================
-- 9. Grants
-- ===========================================================================

revoke all on function
  authz.prefill_auto_fill_enabled(), authz.prefill_history_guard(), authz.prefill_append_only(),
  authz.prefill_history_note(uuid, text, uuid, text, text, text, boolean),
  authz.prefill_mark(uuid, text, uuid, text, text, timestamptz, text),
  authz.prefill_candidate(jsonb, text, boolean), authz.prefill_candidate_reason(jsonb, text, boolean),
  authz.prefill_saved_value(text, uuid, text), authz.prefill_cleared_last(text, uuid, text),
  authz.prefill_audit_absent(text, uuid, text), authz.prefill_field_block(text, uuid, text, boolean),
  authz.prefill_field_untouched(text, uuid, text), authz.prefill_auto_untouched(text, uuid, text),
  authz.prefill_mark_kept(text, uuid, text[]), authz.prefill_fill(text, uuid, text),
  authz.prefill_fill_on_create(text, uuid),
  -- replaced internal helpers keep no API grant
  authz.prefill_mark_changed(text, uuid, text[]), authz.prefill_mark(uuid, text, uuid, text, text, timestamptz),
  authz.prefill_watch_booking_version(), authz.prefill_watch_booking_contacts(),
  authz.prefill_watch_quotation_version(), authz.prefill_watch_quotation_contacts(),
  authz.prefill_view(text, uuid, text, uuid, boolean), authz.b11_contacts_write(public.booking_versions, jsonb)
from public, anon, authenticated, service_role;

revoke all on function
  public.booking_start_draft(uuid),
  public.prefill_fill_empty(text, uuid, integer),
  public.prefill_notice_dismiss(text, uuid, integer, text, timestamptz),
  public.prefill_mark_checked(text, uuid, integer, text[]),
  public.booking_prefill_apply(uuid, integer, text[]),
  public.quotation_prefill_apply(uuid, integer, text[]),
  public.booking_contacts_save(uuid, integer, jsonb),
  public.booking_customer_save(uuid, integer, jsonb, jsonb, integer, uuid),
  public.booking_trip_save(uuid, integer, jsonb),
  public.quotation_version_save(uuid, integer, jsonb),
  public.quotation_contacts_save(uuid, integer, jsonb),
  public.quotation_create(text, uuid, text, uuid),
  public.quotation_new_version(uuid, uuid, uuid),
  public.quotation_convert_to_booking(uuid, text, uuid),
  public.admin_set_workflow_setting(text, boolean, text),
  public.workflow_settings_get(),
  public.intake_checklist(uuid),
  public.quotation_get(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.booking_start_draft(uuid),
  public.prefill_fill_empty(text, uuid, integer),
  public.prefill_notice_dismiss(text, uuid, integer, text, timestamptz),
  public.prefill_mark_checked(text, uuid, integer, text[]),
  public.booking_prefill_apply(uuid, integer, text[]),
  public.quotation_prefill_apply(uuid, integer, text[]),
  public.booking_contacts_save(uuid, integer, jsonb),
  public.booking_customer_save(uuid, integer, jsonb, jsonb, integer, uuid),
  public.booking_trip_save(uuid, integer, jsonb),
  public.quotation_version_save(uuid, integer, jsonb),
  public.quotation_contacts_save(uuid, integer, jsonb),
  public.quotation_create(text, uuid, text, uuid),
  public.quotation_new_version(uuid, uuid, uuid),
  public.quotation_convert_to_booking(uuid, text, uuid),
  public.admin_set_workflow_setting(text, boolean, text),
  public.workflow_settings_get(),
  public.intake_checklist(uuid),
  public.quotation_get(uuid)
to authenticated;

commit;
