-- TripNavigate CRM - Visa and Passport desk build, track A (2 of 3): commands.
--
-- Contract: implementation/visa-build-2026-11-07/contract.md (frozen 8 Nov
-- 2026), sections 4, 5.7, 6 (C1-C16, access helpers), 7 (closure and
-- completion) and 16 (lead decisions: no matching of people by name; "other"
-- visa costs per passenger).
--
-- What changes:
--   * Access: authz.can_read_visa_task adds the branch Manager (D2, read only);
--     authz.can_claim_visa_task is the active Visa role only.
--   * Helpers: facts, effective kind / jurisdiction, readiness tokens,
--     traveller-changed, closure (authz.visa_close), idempotency wrappers
--     (authz.visa_replay / visa_remember over finance_replay / finance_remember).
--   * authz.visa_sync_applications (same signature) follows the item's
--     participants without matching by name: new participant -> new
--     application with the Sales documents; participant gone -> application
--     flagged removed (nothing deleted, no automatic withdrawal); the same seq
--     back on the item -> flag cleared; Sales documents added later go only to
--     passengers not applied yet. During a revision one visa.booking_synced
--     audit row describes the change.
--   * authz.visa_task_complete_if_done (same signature): completion per
--     section 7 (removed passengers not applied never block).
--   * authz.visa_sync_after_revision (trigger body): passes the confirmed
--     version to the sync.
--   * Commands C1-C14 (new or replaced), C15 department_cost_save (visa: only
--     "other" costs linked to a passenger, lead decision 16), C16 old desk
--     commands revoked. department_evidence_begin: 200 files per visa task.
--
-- Refusal tokens (new in this build): 55000 not_ready, applicant_removed,
-- traveller_changed, document_received, already_recorded; 23505
-- duplicate_reference, duplicate_document; 22023 applied_date_in_future,
-- delivered_date_in_future, too_many_documents. Existing: 42501
-- not_authorized, P0002 not_found, 40001 version_changed / duplicate_request
-- / task_conflict, 22023 invalid_input / evidence_rejected, 55000
-- deal_removed / task_closed / application_closed / wrong_state /
-- outcome_document_required / receipt_required / cost_locked.
--
-- Rollback (forward-only): a new migration restoring the replaced bodies from
-- 20261119000500 / 20261201000130 / 20261201000210, re-granting
-- visa_application_update / visa_application_set_state and revoking the new
-- commands. Rows are kept.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Access helpers (contract 6, "Access helpers")
-- ===========================================================================

-- Replaces 20261119000500: the branch Manager of the Deal reads visa tasks
-- (D2). This widens the visa_read policy and can_read_task_history('visa').
create or replace function authz.can_read_visa_task(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task and t.department = 'visa'
      -- Visa build (20261202000110): or the branch Manager (read only).
      and (authz.holds_active_role('visa', t.legal_entity_id) or authz.is_branch_sales_manager(t.deal_id))
  )
$$;

-- Replaces 20261119000500: only an active Visa person takes a task.
create or replace function authz.can_claim_visa_task(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select authz.session_ok() and exists (
    select 1 from public.fulfilment_tasks t
    where t.id = p_task and t.department = 'visa' and authz.holds_active_role('visa', t.legal_entity_id)
  )
$$;

-- SO: the Deal's owner holding an active Sales role and no Visa role. A
-- holder of a Purchase or Flight role is left out too: such a person reads
-- the Deal with the department scope only (deal_visa_summary is null).
create function authz.visa_is_sales_owner(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select d.owner_user_id = (select auth.uid())
       and authz.holds_active_role('sales', d.legal_entity_id)
       and authz.deal_services_scope(d.id) is null
    from public.deals d where d.id = p_deal), false)
$$;

-- SO*: SO, or the branch Manager (without a Visa role) when the Deal has no
-- active Sales owner (same fallback as flight changes and name fill).
create function authz.visa_notice_reader(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and (
    authz.visa_is_sales_owner(p_deal)
    or (authz.is_branch_sales_manager(p_deal)
        and authz.deal_services_scope(p_deal) is null
        and not authz.flight_has_active_sales_owner(p_deal)))
$$;

-- ===========================================================================
-- 2. Facts, kind, jurisdiction, names, readiness (contract section 4)
-- ===========================================================================

-- Facts of the task's item in the task's current version.
create function authz.visa_task_facts(p_task uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select f.facts from public.fulfilment_tasks t
    join public.service_item_facts f on f.service_item_id = t.service_item_id
     and f.booking_version_id = authz.task_current_version(t.id)
    where t.id = p_task), '{}'::jsonb)
$$;

create function authz.visa_is_passport_task(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select t.service_purpose = 'passport' from public.fulfilment_tasks t where t.id = p_task), false)
$$;

create function authz.visa_sales_kind(p_facts jsonb) returns text
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_facts -> 'visaKind') = 'string' and (p_facts ->> 'visaKind') in ('e_visa', 'sticker')
              then p_facts ->> 'visaKind' end
$$;

create function authz.visa_sales_jurisdiction(p_facts jsonb) returns text
language sql immutable set search_path = '' as $$
  select case when jsonb_typeof(p_facts -> 'jurisdiction') = 'string' and (p_facts ->> 'jurisdiction') in ('yes', 'no')
              then p_facts ->> 'jurisdiction' end
$$;

-- Sales' documents-needed labels: trimmed, single spaces, 1..120, distinct by
-- label key, in Sales' order.
create function authz.visa_sales_document_labels(p_facts jsonb) returns text[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(s.l order by s.o), '{}'::text[])
  from (
    select distinct on (lower(regexp_replace(btrim(e.x #>> '{}'), '\s+', ' ', 'g')))
           regexp_replace(btrim(e.x #>> '{}'), '\s+', ' ', 'g') as l, e.o
    from jsonb_array_elements(case when jsonb_typeof(p_facts -> 'documentsNeeded') = 'array'
                                   then p_facts -> 'documentsNeeded' else '[]'::jsonb end) with ordinality as e (x, o)
    where jsonb_typeof(e.x) = 'string' and length(btrim(e.x #>> '{}')) between 1 and 120
    order by lower(regexp_replace(btrim(e.x #>> '{}'), '\s+', ' ', 'g')), e.o
  ) s
$$;

-- Effective visa kind: passport task -> null; applied or later -> frozen
-- value; before Applied Sales' value wins, else the desk's choice.
create function authz.visa_effective_kind(a public.visa_applications, p_facts jsonb) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when authz.visa_is_passport_task(a.task_id) then null
    when a.state <> 'docs_pending' then a.visa_kind
    else coalesce(authz.visa_sales_kind(p_facts), a.visa_kind) end
$$;

-- {value, source}: source 'sales' | 'desk' | 'applied' | null.
create function authz.visa_kind_json(a public.visa_applications, p_facts jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case
    when authz.visa_is_passport_task(a.task_id) then jsonb_build_object('value', null, 'source', null)
    when a.state <> 'docs_pending' then jsonb_build_object('value', a.visa_kind,
           'source', case when a.visa_kind is not null then 'applied' end)
    when authz.visa_sales_kind(p_facts) is not null then jsonb_build_object('value', authz.visa_sales_kind(p_facts), 'source', 'sales')
    else jsonb_build_object('value', a.visa_kind, 'source', case when a.visa_kind is not null then 'desk' end) end
$$;

-- {required, place, source} with the same precedence as the kind.
create function authz.visa_jurisdiction_json(a public.visa_applications, p_facts jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case
    when authz.visa_is_passport_task(a.task_id) then jsonb_build_object('required', null, 'place', null, 'source', null)
    when a.state <> 'docs_pending' then jsonb_build_object('required', a.jurisdiction_required, 'place', a.jurisdiction_place,
           'source', case when a.jurisdiction_required is not null then 'applied' end)
    when authz.visa_sales_jurisdiction(p_facts) is not null then jsonb_build_object(
           'required', authz.visa_sales_jurisdiction(p_facts) = 'yes',
           'place', case when authz.visa_sales_jurisdiction(p_facts) = 'yes'
                         then nullif(regexp_replace(btrim(coalesce(p_facts ->> 'jurisdictionPlace', '')), '\s+', ' ', 'g'), '') end,
           'source', 'sales')
    else jsonb_build_object('required', a.jurisdiction_required, 'place', a.jurisdiction_place,
           'source', case when a.jurisdiction_required is not null then 'desk' end) end
$$;

-- The traveller's current name / type in the task's current version (null when unnamed).
create function authz.visa_current_traveller(a public.visa_applications) returns public.booking_version_travellers
language sql stable security definer set search_path = '' as $$
  select s.* from public.booking_version_travellers s
  where s.booking_version_id = authz.task_current_version(a.task_id) and s.seq = a.traveller_seq
$$;

-- Name shown for an application: the current name, else the snapshot.
create function authz.visa_app_name(a public.visa_applications) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((authz.visa_current_traveller(a)).full_name, a.traveller_name_snapshot)
$$;

-- Traveller changed (section 4): open current application whose snapshot no
-- longer matches the current name / type, or the seq is no longer named.
create function authz.visa_traveller_changed(a public.visa_applications) returns boolean
language sql stable security definer set search_path = '' as $$
  select a.superseded_at is null and a.removed_at is null and a.closed_at is null
     and a.traveller_name_snapshot is not null
     and not exists (select 1 from public.booking_version_travellers s
                     where s.booking_version_id = authz.task_current_version(a.task_id) and s.seq = a.traveller_seq
                       and s.full_name = a.traveller_name_snapshot
                       and s.traveller_type = coalesce(a.traveller_type_snapshot, s.traveller_type))
$$;

-- Readiness tokens, in order (empty = ready).
create function authz.visa_not_ready(a public.visa_applications, p_facts jsonb) returns text[]
language sql stable security definer set search_path = '' as $$
  with k as (
    select authz.visa_is_passport_task(a.task_id) as passport, authz.visa_effective_kind(a, p_facts) as kind
  )
  select array_remove(array[
    case when a.removed_at is not null then 'removed' end,
    case when a.superseded_at is not null then 'superseded' end,
    case when a.state <> 'docs_pending' then 'wrong_state' end,
    case when authz.visa_traveller_changed(a) then 'traveller_changed' end,
    case when not exists (select 1 from public.visa_application_documents d
                          where d.application_id = a.id and d.removed_at is null) then 'no_documents' end,
    case when exists (select 1 from public.visa_application_documents d
                      where d.application_id = a.id and d.removed_at is null and d.status = 'not_received') then 'documents_missing' end,
    case when (k.passport or k.kind is null or k.kind = 'sticker') and a.appointment_date is null then 'appointment_missing' end,
    case when not k.passport and k.kind is null and a.appointment_date is null then 'kind_missing' end], null)
  from k
$$;

revoke all on function authz.visa_is_sales_owner(uuid), authz.visa_notice_reader(uuid), authz.visa_task_facts(uuid),
  authz.visa_is_passport_task(uuid), authz.visa_sales_kind(jsonb), authz.visa_sales_jurisdiction(jsonb),
  authz.visa_sales_document_labels(jsonb), authz.visa_effective_kind(public.visa_applications, jsonb),
  authz.visa_kind_json(public.visa_applications, jsonb), authz.visa_jurisdiction_json(public.visa_applications, jsonb),
  authz.visa_current_traveller(public.visa_applications), authz.visa_app_name(public.visa_applications),
  authz.visa_traveller_changed(public.visa_applications), authz.visa_not_ready(public.visa_applications, jsonb)
from public, anon, authenticated, service_role;

-- ===========================================================================
-- 3. Audit, closure, idempotency
-- ===========================================================================

-- Audit on a visa application: taskId and seq always; no names, references,
-- e-mails or amounts (reasons go in p_reason).
create function authz.visa_audit(p_action text, p_app uuid, p_reason text, p_details jsonb) returns void
language sql volatile security definer set search_path = '' as $$
  select authz.write_audit(p_action, a.legal_entity_id, d.branch_id, 'visa_application', a.id, p_reason,
    jsonb_build_object('taskId', a.task_id, 'seq', a.traveller_seq) || coalesce(p_details, '{}'::jsonb))
  from public.visa_applications a join public.deals d on d.id = a.deal_id
  where a.id = p_app
$$;

-- Closes an application (section 7) and writes visa.application_closed.
create function authz.visa_close(p_application uuid, p_reason text) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  update public.visa_applications a
  set closed_at = now(), closed_by = (select auth.uid()), closed_reason = p_reason,
      updated_by = (select auth.uid()), updated_at = now()
  where a.id = p_application and a.closed_at is null;
  if found then
    perform authz.visa_audit('visa.application_closed', p_application, null, jsonb_build_object('closedReason', p_reason));
  end if;
end;
$$;

create function authz.visa_replay(p_entity uuid, p_request uuid, p_command text, p_payload jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_request is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  begin
    return authz.finance_replay(p_entity, p_request, p_command, p_payload);
  exception when sqlstate '40001' then
    raise exception 'duplicate_request' using errcode = '40001';
  end;
end;
$$;

create function authz.visa_remember(p_entity uuid, p_request uuid, p_command text, p_payload jsonb, p_result jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  begin
    return authz.finance_remember(p_entity, p_request, p_command, p_payload, p_result);
  exception when sqlstate '40001' then
    raise exception 'duplicate_request' using errcode = '40001';
  end;
end;
$$;

-- Locks the task, then the application (lock order of section 5.7).
create function authz.visa_lock_application(p_application uuid) returns public.visa_applications
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_app public.visa_applications%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_app from public.visa_applications a where a.id = p_application;
  if v_app.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.refuse_removed_deal(v_app.deal_id);
  perform 1 from public.fulfilment_tasks t where t.id = v_app.task_id for update;
  select * into v_app from public.visa_applications a where a.id = p_application for update;
  return v_app;
end;
$$;

-- Work authority on a task: the assignee holding the Visa role, task open.
create function authz.visa_require_work(p_task uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task;
  if v_task.id is null or v_task.department <> 'visa' or v_task.assignee_user_id is distinct from (select auth.uid())
     or not authz.holds_active_role('visa', v_task.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_task.status = 'completed' then
    raise exception 'task_closed' using errcode = '55000';
  end if;
  if not authz.can_work_department_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
end;
$$;

-- Common refusals of an application command (contract 6, conventions).
create function authz.visa_require_open(a public.visa_applications, p_allow_removed boolean, p_allow_closed boolean)
returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  perform authz.visa_require_work(a.task_id);
  if a.superseded_at is not null then
    raise exception 'application_closed' using errcode = '55000';
  end if;
  if a.closed_at is not null and not p_allow_closed then
    raise exception 'application_closed' using errcode = '55000';
  end if;
  if a.removed_at is not null and not p_allow_removed then
    raise exception 'applicant_removed' using errcode = '55000';
  end if;
end;
$$;

revoke all on function authz.visa_audit(text, uuid, text, jsonb), authz.visa_close(uuid, text),
  authz.visa_replay(uuid, uuid, text, jsonb), authz.visa_remember(uuid, uuid, text, jsonb, jsonb),
  authz.visa_lock_application(uuid), authz.visa_require_work(uuid),
  authz.visa_require_open(public.visa_applications, boolean, boolean)
from public, anon, authenticated, service_role;

-- ===========================================================================
-- 4. Sync, completion, revision trigger (section 7)
-- ===========================================================================

-- Adds the Sales labels missing from an application (by label key, removed
-- rows included); never more than 40 listed documents. Returns rows added.
create function authz.visa_add_sales_documents(p_application uuid, p_labels text[]) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_app public.visa_applications%rowtype;
  v_label text;
  v_n integer := 0;
begin
  select * into v_app from public.visa_applications a where a.id = p_application;
  foreach v_label in array coalesce(p_labels, '{}'::text[]) loop
    exit when (select count(*) from public.visa_application_documents d
               where d.application_id = v_app.id and d.removed_at is null) >= 40;
    if not exists (select 1 from public.visa_application_documents d
                   where d.application_id = v_app.id and d.label_key = authz.visa_label_key(v_label)) then
      insert into public.visa_application_documents (legal_entity_id, task_id, application_id, catalogue_code, label, source)
      values (v_app.legal_entity_id, v_app.task_id, v_app.id, authz.visa_catalogue_code_for(v_label), v_label, 'sales');
      v_n := v_n + 1;
    end if;
  end loop;
  return v_n;
end;
$$;

-- The sync itself; p_version is the revision being confirmed (null at claim
-- and before completion checks). Lead decision 16: nobody is matched by name.
create function authz.visa_sync_task(p_task uuid, p_version uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_ver uuid;
  v_prev uuid;
  v_seqs integer[];
  v_facts jsonb;
  v_labels text[];
  v_passport boolean;
  v_added integer[] := '{}';
  v_removed integer[] := '{}';
  v_back integer[] := '{}';
  v_renamed integer[] := '{}';
  v_docs integer := 0;
  v_n integer;
  v_seq integer;
  v_id uuid;
  r record;
begin
  -- Lock order: task, then applications by id.
  select * into v_task from public.fulfilment_tasks t where t.id = p_task for update;
  if v_task.id is null or v_task.department <> 'visa' or v_task.status <> 'in_progress' then
    return;
  end if;
  perform 1 from public.visa_applications a where a.task_id = v_task.id order by a.id for update;
  v_ver := authz.task_current_version(v_task.id);
  v_seqs := authz.item_participant_seqs(v_task.service_item_id, v_ver);
  v_facts := authz.visa_task_facts(v_task.id);
  v_passport := v_task.service_purpose = 'passport';
  v_labels := case when v_passport then '{}'::text[] else authz.visa_sales_document_labels(v_facts) end;

  -- Removed: open current applications whose seq no longer takes part.
  for r in
    update public.visa_applications a
    set removed_at = now(), removed_version_id = v_ver, row_version = a.row_version + 1,
        updated_by = (select auth.uid()), updated_at = now()
    where a.task_id = v_task.id and a.superseded_at is null and a.removed_at is null and a.closed_at is null
      and not (a.traveller_seq = any (v_seqs))
    returning a.traveller_seq
  loop
    v_removed := v_removed || r.traveller_seq;
  end loop;
  -- The same traveller (same seq) back on the item.
  for r in
    update public.visa_applications a
    set removed_at = null, removed_version_id = null, row_version = a.row_version + 1,
        updated_by = (select auth.uid()), updated_at = now()
    where a.task_id = v_task.id and a.superseded_at is null and a.removed_at is not null and a.closed_at is null
      and a.traveller_seq = any (v_seqs)
    returning a.traveller_seq
  loop
    v_back := v_back || r.traveller_seq;
  end loop;
  -- Added: a participant without a current application gets a new one.
  foreach v_seq in array v_seqs loop
    if not exists (select 1 from public.visa_applications a
                   where a.task_id = v_task.id and a.traveller_seq = v_seq and a.superseded_at is null) then
      insert into public.visa_applications (task_id, service_item_id, deal_id, legal_entity_id, traveller_seq, updated_by,
        traveller_name_snapshot, traveller_type_snapshot)
      select v_task.id, v_task.service_item_id, v_task.deal_id, v_task.legal_entity_id, v_seq, (select auth.uid()),
             s.full_name, s.traveller_type
      from (select 1) x
      left join public.booking_version_travellers s on s.booking_version_id = v_ver and s.seq = v_seq
      returning id into v_id;
      perform authz.visa_add_sales_documents(v_id, v_labels);
      v_added := v_added || v_seq;
    end if;
  end loop;
  -- Blank -> named: the snapshot is filled silently (not a change).
  update public.visa_applications a
  set traveller_name_snapshot = s.full_name, traveller_type_snapshot = s.traveller_type,
      updated_at = now()
  from public.booking_version_travellers s
  where a.task_id = v_task.id and a.superseded_at is null and a.closed_at is null and a.traveller_name_snapshot is null
    and s.booking_version_id = v_ver and s.seq = a.traveller_seq;
  -- New Sales documents only for passengers not applied yet; nothing removed.
  if cardinality(v_labels) > 0 then
    for r in
      select a.id from public.visa_applications a
      where a.task_id = v_task.id and a.superseded_at is null and a.removed_at is null and a.closed_at is null
        and a.state = 'docs_pending' and not (a.traveller_seq = any (v_added))
      order by a.id
    loop
      v_n := authz.visa_add_sales_documents(r.id, v_labels);
      if v_n > 0 then
        update public.visa_applications a set row_version = a.row_version + 1, updated_at = now() where a.id = r.id;
        v_docs := v_docs + v_n;
      end if;
    end loop;
  end if;

  if p_version is not null then
    select v.revises_version_id into v_prev from public.booking_versions v where v.id = p_version;
    -- Renamed in this revision (same seq, other name or type).
    select coalesce(array_agg(a.traveller_seq order by a.traveller_seq), '{}') into v_renamed
    from public.visa_applications a
    join public.booking_version_travellers n on n.booking_version_id = v_ver and n.seq = a.traveller_seq
    join public.booking_version_travellers o on o.booking_version_id = v_prev and o.seq = a.traveller_seq
    where a.task_id = v_task.id and a.superseded_at is null and a.removed_at is null
      and (n.full_name, n.traveller_type) is distinct from (o.full_name, o.traveller_type);
    if cardinality(v_added) + cardinality(v_removed) + cardinality(v_back) + cardinality(v_renamed) + v_docs > 0 then
      perform authz.write_audit('visa.booking_synced', v_task.legal_entity_id, v_task.branch_id, 'fulfilment_task', v_task.id,
        null, jsonb_build_object('versionId', p_version,
          'versionNo', (select v.version_no from public.booking_versions v where v.id = p_version),
          'addedSeqs', to_jsonb(v_added), 'removedSeqs', to_jsonb(v_removed), 'backSeqs', to_jsonb(v_back),
          'renamedSeqs', to_jsonb(v_renamed), 'documentsAdded', v_docs));
    end if;
  end if;
end;
$$;

-- Replaces 20261119000500 (same signature).
create or replace function authz.visa_sync_applications(p_task uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform authz.visa_sync_task(p_task, null);
end;
$$;

-- Replaces 20261119000500 (same signature): completes the task when it has
-- at least one current non-removed application, every current participant
-- has a current application, and no blocking application exists (section 4:
-- current and not closed, except removed ones not applied yet).
create or replace function authz.visa_task_complete_if_done(p_task uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_seqs integer[];
begin
  perform authz.visa_sync_applications(p_task);
  select * into v_task from public.fulfilment_tasks t where t.id = p_task;
  if v_task.id is null or v_task.status <> 'in_progress' then
    return false;
  end if;
  v_seqs := authz.item_participant_seqs(v_task.service_item_id, authz.task_current_version(v_task.id));
  if not exists (select 1 from public.visa_applications a
                 where a.task_id = p_task and a.superseded_at is null and a.removed_at is null)
     or exists (select 1 from unnest(v_seqs) s
                where not exists (select 1 from public.visa_applications a
                                  where a.task_id = p_task and a.traveller_seq = s and a.superseded_at is null))
     or exists (select 1 from public.visa_applications a
                where a.task_id = p_task and a.superseded_at is null and a.closed_at is null
                  and not (a.removed_at is not null and a.state = 'docs_pending')) then
    return false;
  end if;
  update public.fulfilment_tasks t
  set status = 'completed', completed_by = (select auth.uid()), completed_at = now(), updated_at = now()
  where t.id = p_task;
  insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
  values (v_task.legal_entity_id, 'fulfilment_task', v_task.id, 'fulfilment.task_completed',
    jsonb_build_object('task_id', v_task.id, 'deal_id', v_task.deal_id, 'service_item_id', v_task.service_item_id,
      'service_type', v_task.service_purpose))
  on conflict (event_type, aggregate_id) do nothing;
  perform authz.write_audit('fulfilment.task_completed', v_task.legal_entity_id, v_task.branch_id, 'fulfilment_task',
    v_task.id, null, jsonb_build_object('dealId', v_task.deal_id, 'serviceItemId', v_task.service_item_id,
      'department', 'visa'));
  return true;
end;
$$;

-- Replaces 20261119000500 (trigger body): the sync knows the confirmed
-- revision, so the desk sees "Booking version N changed this task".
create or replace function authz.visa_sync_after_revision() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_task uuid;
begin
  for v_task in
    select t.id from public.fulfilment_tasks t
    where t.deal_id = new.deal_id and t.department = 'visa' and t.status = 'in_progress'
    order by t.id
  loop
    perform authz.visa_sync_task(v_task, new.id);
    perform authz.visa_task_complete_if_done(v_task);
  end loop;
  return null;
end;
$$;

revoke all on function authz.visa_add_sales_documents(uuid, text[]), authz.visa_sync_task(uuid, uuid)
from public, anon, authenticated, service_role;

-- ===========================================================================
-- 5. C1 visa_task_claim (replaced, same signature)
-- ===========================================================================

create or replace function public.visa_task_claim(p_task_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_uid uuid := (select auth.uid());
  v_count integer;
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  perform authz.refuse_removed_deal(v_task.deal_id);
  if v_task.id is null or not authz.can_claim_visa_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_task.assignee_user_id = v_uid then
    return jsonb_build_object('taskId', v_task.id, 'status', v_task.status, 'assignedToYou', true, 'alreadyYours', true,
      'applicationCount', (select count(*)::integer from public.visa_applications a
                           where a.task_id = v_task.id and a.superseded_at is null));
  end if;
  if v_task.assignee_user_id is not null then
    raise exception 'task_conflict' using errcode = '40001';
  end if;

  update public.fulfilment_tasks t
  set assignee_user_id = v_uid, status = 'in_progress', updated_at = now()
  where t.id = v_task.id;
  insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
  values (v_task.deal_id, v_task.legal_entity_id, v_uid, 'visa', v_uid)
  on conflict (deal_id, user_id, assignment_kind) where ended_at is null do nothing;
  perform authz.visa_sync_applications(v_task.id);
  select count(*)::integer into v_count from public.visa_applications a where a.task_id = v_task.id and a.superseded_at is null;

  perform authz.write_audit('fulfilment.task_claimed', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('dealId', v_task.deal_id, 'versionId', v_task.booking_version_id,
      'serviceItemId', v_task.service_item_id, 'department', 'visa', 'applicationCount', v_count));
  return jsonb_build_object('taskId', v_task.id, 'status', 'in_progress', 'assignedToYou', true, 'alreadyYours', false,
    'applicationCount', v_count);
end;
$$;

-- ===========================================================================
-- 6. C2 visa_application_set_row (Passengers table row Save)
-- ===========================================================================

create function public.visa_application_set_row(p_application_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_app public.visa_applications%rowtype;
  v_facts jsonb;
  v_passport boolean;
  v_command text := 'visa_application_set_row';
  v_payload jsonb := jsonb_build_object('applicationId', p_application_id, 'expectedRowVersion', p_expected_row_version,
                                        'fields', p_fields);
  v_result jsonb;
  v_bad text[] := '{}';
  v_date date;
  v_time text;
  v_remark text;
  v_kind text;
  v_jreq boolean;
  v_jplace text;
  v_docs jsonb := '[]'::jsonb;
  v_doc jsonb;
  v_pass text;
  v_trav public.deal_travellers%rowtype;
  v_ident public.traveller_identities%rowtype;
  v_changed text[];
  v_not text[];
begin
  v_app := authz.visa_lock_application(p_application_id);
  v_result := authz.visa_replay(v_app.legal_entity_id, p_request_id, v_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.visa_require_open(v_app, false, false);
  perform authz.require_row_version(p_expected_row_version, v_app.row_version);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_facts := authz.visa_task_facts(v_app.task_id);
  v_passport := authz.visa_is_passport_task(v_app.task_id);
  v_bad := authz.b11_unknown_keys(p_fields, array['appointmentDate', 'appointmentTime', 'remark', 'documents',
    'passportNumber', 'visaKind', 'jurisdiction', 'jurisdictionPlace']);
  if v_app.state <> 'docs_pending' and (p_fields ?| array['appointmentDate', 'appointmentTime', 'documents', 'visaKind',
                                                          'jurisdiction', 'jurisdictionPlace']) then
    raise exception 'wrong_state' using errcode = '55000';
  end if;

  -- Appointment date and time.
  v_date := v_app.appointment_date;
  if p_fields ? 'appointmentDate' then
    v_date := authz.sf_date(p_fields -> 'appointmentDate');
    if jsonb_typeof(p_fields -> 'appointmentDate') <> 'null' and v_date is null then
      v_bad := v_bad || 'appointmentDate'::text;
    end if;
  end if;
  v_time := v_app.appointment_time;
  if p_fields ? 'appointmentTime' then
    v_time := authz.b11_text(p_fields -> 'appointmentTime');
    if jsonb_typeof(p_fields -> 'appointmentTime') not in ('string', 'null')
       or (v_time is not null and v_time !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$') then
      v_bad := v_bad || 'appointmentTime'::text;
    end if;
  end if;
  if v_time is not null and v_date is null and not ('appointmentTime' = any (v_bad)) then
    v_bad := v_bad || 'appointmentTime'::text;
  end if;
  -- Remark.
  v_remark := v_app.remark;
  if p_fields ? 'remark' then
    if not authz.sf_text_ok(p_fields -> 'remark', 300, false) then
      v_bad := v_bad || 'remark'::text;
    end if;
    v_remark := authz.b11_text(p_fields -> 'remark');
  end if;
  -- Documents: [{documentId, received}] of this application, not removed.
  if p_fields ? 'documents' then
    if jsonb_typeof(p_fields -> 'documents') <> 'array'
       or exists (select 1 from jsonb_array_elements(p_fields -> 'documents') x
                  where jsonb_typeof(x) <> 'object'
                     or cardinality(authz.b11_unknown_keys(x, array['documentId', 'received'])) > 0
                     or jsonb_typeof(x -> 'received') is distinct from 'boolean'
                     or jsonb_typeof(x -> 'documentId') is distinct from 'string'
                     or (x ->> 'documentId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                     or not exists (select 1 from public.visa_application_documents d
                                    where d.id = (x ->> 'documentId')::uuid and d.application_id = v_app.id
                                      and d.removed_at is null))
       or (select count(*) from jsonb_array_elements(p_fields -> 'documents'))
          <> (select count(distinct x ->> 'documentId') from jsonb_array_elements(p_fields -> 'documents') x) then
      v_bad := v_bad || 'documents'::text;
    else
      v_docs := p_fields -> 'documents';
    end if;
  end if;
  -- Kind: visa task only, only while Sales left it blank.
  v_kind := v_app.visa_kind;
  if p_fields ? 'visaKind' then
    v_kind := authz.b11_text(p_fields -> 'visaKind');
    if v_passport or authz.visa_sales_kind(v_facts) is not null
       or jsonb_typeof(p_fields -> 'visaKind') not in ('string', 'null')
       or (v_kind is not null and v_kind not in ('e_visa', 'sticker')) then
      v_bad := v_bad || 'visaKind'::text;
    end if;
  end if;
  -- Jurisdiction: sticker visa (effective), Sales blank.
  v_jreq := v_app.jurisdiction_required;
  v_jplace := v_app.jurisdiction_place;
  if p_fields ?| array['jurisdiction', 'jurisdictionPlace'] then
    if v_passport or authz.visa_sales_jurisdiction(v_facts) is not null
       or coalesce(authz.visa_sales_kind(v_facts), v_kind) is distinct from 'sticker' then
      v_bad := v_bad || 'jurisdiction'::text;
    else
      if p_fields ? 'jurisdiction' then
        if jsonb_typeof(p_fields -> 'jurisdiction') = 'null' then
          v_jreq := null;
        elsif jsonb_typeof(p_fields -> 'jurisdiction') = 'string' and (p_fields ->> 'jurisdiction') in ('yes', 'no') then
          v_jreq := (p_fields ->> 'jurisdiction') = 'yes';
        else
          v_bad := v_bad || 'jurisdiction'::text;
        end if;
      end if;
      if p_fields ? 'jurisdictionPlace' then
        if not authz.sf_text_ok(p_fields -> 'jurisdictionPlace', 120, false) then
          v_bad := v_bad || 'jurisdictionPlace'::text;
        end if;
        v_jplace := regexp_replace(authz.b11_text(p_fields -> 'jurisdictionPlace'), '\s+', ' ', 'g');
      elsif v_jreq is not true then
        v_jplace := null;
      end if;
      if (v_jreq is true) <> (v_jplace is not null) and not ('jurisdictionPlace' = any (v_bad)) then
        v_bad := v_bad || 'jurisdictionPlace'::text;
      end if;
    end if;
  end if;
  if coalesce(authz.visa_sales_kind(v_facts), v_kind) is distinct from 'sticker' and authz.visa_sales_jurisdiction(v_facts) is null then
    -- Jurisdiction belongs to sticker visas only.
    v_jreq := null;
    v_jplace := null;
  end if;
  -- Passport number (V2): written to the traveller identity record only.
  if p_fields ? 'passportNumber' then
    v_pass := nullif(upper(regexp_replace(coalesce(authz.b11_text(p_fields -> 'passportNumber'), ''), '[ -]', '', 'g')), '');
    select * into v_trav from public.deal_travellers t where t.deal_id = v_app.deal_id and t.seq = v_app.traveller_seq;
    if jsonb_typeof(p_fields -> 'passportNumber') not in ('string', 'null')
       or (v_pass is not null and v_pass !~ '^[A-Z0-9]{6,15}$') or v_trav.id is null then
      v_bad := v_bad || 'passportNumber'::text;
    end if;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;

  update public.visa_applications a
  set appointment_date = v_date, appointment_time = v_time, remark = v_remark, visa_kind = v_kind,
      jurisdiction_required = v_jreq, jurisdiction_place = v_jplace,
      row_version = a.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
  where a.id = v_app.id
  returning * into v_app;
  for v_doc in select x from jsonb_array_elements(v_docs) x loop
    update public.visa_application_documents d
    set status = case when (v_doc ->> 'received')::boolean then 'received' else 'not_received' end,
        received_at = case when (v_doc ->> 'received')::boolean then coalesce(d.received_at, now()) end,
        received_by = case when (v_doc ->> 'received')::boolean then coalesce(d.received_by, (select auth.uid())) end,
        updated_at = now()
    where d.id = (v_doc ->> 'documentId')::uuid
      and d.status is distinct from case when (v_doc ->> 'received')::boolean then 'received' else 'not_received' end;
  end loop;
  if p_fields ? 'passportNumber' then
    select * into v_ident from public.traveller_identities x where x.traveller_id = v_trav.id;
    if v_ident.passport_number is distinct from v_pass then
      -- Same rules and audit row as the booking form (traveller_identity_save).
      perform public.traveller_identity_save(v_app.deal_id, v_app.traveller_seq, coalesce(v_ident.row_version, 0),
        jsonb_strip_nulls(jsonb_build_object(
          'dateOfBirth', to_char(v_ident.date_of_birth, 'YYYY-MM-DD'), 'nationality', v_ident.nationality,
          'passportExpiry', to_char(v_ident.passport_expiry, 'YYYY-MM-DD')))
        || jsonb_build_object('passportNumber', v_pass));
    end if;
  end if;

  v_changed := array(select k from jsonb_object_keys(p_fields) k order by k);
  perform authz.visa_audit('visa.application_row_saved', v_app.id, null, jsonb_build_object(
    'changedFields', to_jsonb(v_changed),
    'documentsReceived', (select count(*) from public.visa_application_documents d
                          where d.application_id = v_app.id and d.removed_at is null and d.status = 'received'),
    'documentsTotal', (select count(*) from public.visa_application_documents d
                       where d.application_id = v_app.id and d.removed_at is null),
    'rowVersion', v_app.row_version));
  v_not := authz.visa_not_ready(v_app, v_facts);
  v_result := jsonb_build_object('outcome', 'updated', 'applicationId', v_app.id, 'rowVersion', v_app.row_version,
    'state', v_app.state, 'ready', cardinality(v_not) = 0, 'notReady', to_jsonb(v_not), 'closed', false,
    'taskCompleted', false);
  return authz.visa_remember(v_app.legal_entity_id, p_request_id, v_command, v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 7. C3 / C4 documents
-- ===========================================================================

create function public.visa_application_document_add(p_application_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_app public.visa_applications%rowtype;
  v_command text := 'visa_application_document_add';
  v_payload jsonb := jsonb_build_object('applicationId', p_application_id, 'expectedRowVersion', p_expected_row_version,
                                        'fields', p_fields);
  v_result jsonb;
  v_bad text[] := '{}';
  v_code text;
  v_label text;
  v_received boolean := false;
  v_remark text;
  v_doc uuid;
  v_not text[];
begin
  v_app := authz.visa_lock_application(p_application_id);
  v_result := authz.visa_replay(v_app.legal_entity_id, p_request_id, v_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.visa_require_open(v_app, false, false);
  perform authz.require_row_version(p_expected_row_version, v_app.row_version);
  if v_app.state <> 'docs_pending' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_bad := authz.b11_unknown_keys(p_fields, array['catalogueCode', 'label', 'received', 'remark']);
  v_code := authz.b11_text(p_fields -> 'catalogueCode');
  v_label := regexp_replace(authz.b11_text(p_fields -> 'label'), '\s+', ' ', 'g');
  if v_code is not null and v_label is null then
    select c.label into v_label from authz.visa_document_catalogue() c where c.code = v_code;
    if v_label is null then
      v_bad := v_bad || 'catalogueCode'::text;
    end if;
  elsif v_code is null and v_label is not null then
    if not authz.sf_text_ok(p_fields -> 'label', 120, true) then
      v_bad := v_bad || 'label'::text;
    end if;
    v_code := authz.visa_catalogue_code_for(v_label);
  else
    v_bad := v_bad || 'catalogueCode'::text;
  end if;
  if p_fields ? 'received' then
    if jsonb_typeof(p_fields -> 'received') <> 'boolean' then
      v_bad := v_bad || 'received'::text;
    else
      v_received := (p_fields ->> 'received')::boolean;
    end if;
  end if;
  if not authz.sf_text_ok(p_fields -> 'remark', 300, false) then
    v_bad := v_bad || 'remark'::text;
  end if;
  v_remark := authz.b11_text(p_fields -> 'remark');
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  if exists (select 1 from public.visa_application_documents d
             where d.application_id = v_app.id and d.removed_at is null and d.label_key = authz.visa_label_key(v_label)) then
    raise exception 'duplicate_document' using errcode = '23505';
  end if;
  if (select count(*) from public.visa_application_documents d where d.application_id = v_app.id and d.removed_at is null) >= 40 then
    raise exception 'too_many_documents' using errcode = '22023';
  end if;
  insert into public.visa_application_documents (legal_entity_id, task_id, application_id, catalogue_code, label, source,
    status, received_at, received_by, remark, added_by)
  values (v_app.legal_entity_id, v_app.task_id, v_app.id, v_code, v_label, 'desk',
    case when v_received then 'received' else 'not_received' end, case when v_received then now() end,
    case when v_received then (select auth.uid()) end, v_remark, (select auth.uid()))
  returning id into v_doc;
  update public.visa_applications a
  set row_version = a.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
  where a.id = v_app.id
  returning * into v_app;
  perform authz.visa_audit('visa.document_added', v_app.id, null, jsonb_build_object('documentId', v_doc,
    'catalogueCode', v_code, 'custom', v_code is null, 'received', v_received, 'rowVersion', v_app.row_version));
  v_not := authz.visa_not_ready(v_app, authz.visa_task_facts(v_app.task_id));
  v_result := jsonb_build_object('outcome', 'created', 'applicationId', v_app.id, 'documentId', v_doc,
    'rowVersion', v_app.row_version, 'state', v_app.state, 'ready', cardinality(v_not) = 0, 'notReady', to_jsonb(v_not),
    'closed', false, 'taskCompleted', false);
  return authz.visa_remember(v_app.legal_entity_id, p_request_id, v_command, v_payload, v_result);
end;
$$;

create function public.visa_application_document_remove(p_document_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_doc public.visa_application_documents%rowtype;
  v_app public.visa_applications%rowtype;
  v_command text := 'visa_application_document_remove';
  v_payload jsonb := jsonb_build_object('documentId', p_document_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_not text[];
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_doc from public.visa_application_documents d where d.id = p_document_id;
  if v_doc.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_app := authz.visa_lock_application(v_doc.application_id);
  v_result := authz.visa_replay(v_app.legal_entity_id, p_request_id, v_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.visa_require_open(v_app, false, false);
  perform authz.require_row_version(p_expected_row_version, v_app.row_version);
  if v_app.state <> 'docs_pending' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  select * into v_doc from public.visa_application_documents d where d.id = p_document_id;
  if v_doc.removed_at is not null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_doc.status = 'received' then
    raise exception 'document_received' using errcode = '55000';
  end if;
  update public.visa_application_documents d
  set removed_at = now(), removed_by = (select auth.uid()), updated_at = now()
  where d.id = v_doc.id;
  update public.visa_applications a
  set row_version = a.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
  where a.id = v_app.id
  returning * into v_app;
  perform authz.visa_audit('visa.document_removed', v_app.id, null, jsonb_build_object('documentId', v_doc.id,
    'source', v_doc.source, 'rowVersion', v_app.row_version));
  v_not := authz.visa_not_ready(v_app, authz.visa_task_facts(v_app.task_id));
  v_result := jsonb_build_object('outcome', 'updated', 'applicationId', v_app.id, 'documentId', v_doc.id,
    'rowVersion', v_app.row_version, 'state', v_app.state, 'ready', cardinality(v_not) = 0, 'notReady', to_jsonb(v_not),
    'closed', false, 'taskCompleted', false);
  return authz.visa_remember(v_app.legal_entity_id, p_request_id, v_command, v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 8. C5 visa_applications_apply (one transaction for 1..n applicants)
-- ===========================================================================

create function public.visa_applications_apply(p_task_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_command text := 'visa_applications_apply';
  v_payload jsonb := jsonb_build_object('taskId', p_task_id, 'fields', p_fields);
  v_result jsonb;
  v_facts jsonb;
  v_passport boolean;
  v_list jsonb;
  v_n integer;
  v_i integer;
  v_x jsonb;
  v_ids uuid[] := '{}';
  v_app public.visa_applications%rowtype;
  v_bad text[] := '{}';
  v_not text[];
  v_kind_post text;
  v_kind_needed boolean := false;
  v_jpost boolean := false;
  v_jreq boolean;
  v_jplace text;
  v_taken boolean := false;
  v_paid text;
  v_mode text;
  v_receipt uuid;
  v_remark text;
  v_club uuid;
  v_today date := authz.finance_today();
  v_ref text;
  v_on date;
  v_gov bigint;
  v_svc bigint;
  v_kind text;
  v_entry uuid;
  v_entries uuid[];
  v_all_entries uuid[] := '{}';
  v_apps jsonb := '[]'::jsonb;
  v_status text;
  v_k text;
  v_amount bigint;
  v_done boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or v_task.department <> 'visa' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.refuse_removed_deal(v_task.deal_id);
  -- Lock order: deal head (fees, as Accounts review), task, applications by id.
  perform authz.finance_lock_deal(v_task.deal_id);
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  v_result := authz.visa_replay(v_task.legal_entity_id, p_request_id, v_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.visa_require_work(v_task.id);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_facts := authz.visa_task_facts(v_task.id);
  v_passport := v_task.service_purpose = 'passport';
  v_bad := authz.b11_unknown_keys(p_fields, array['applicants', 'visaKind', 'jurisdiction', 'jurisdictionPlace',
    'passportTaken', 'paidBy', 'paymentMode', 'receiptEvidenceId', 'remark']);
  v_list := p_fields -> 'applicants';
  if jsonb_typeof(v_list) is distinct from 'array' or jsonb_array_length(v_list) not between 1 and 100
     or exists (select 1 from jsonb_array_elements(v_list) x
                where jsonb_typeof(x) <> 'object' or jsonb_typeof(x -> 'applicationId') is distinct from 'string'
                   or (x ->> 'applicationId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                   or jsonb_typeof(x -> 'expectedRowVersion') is distinct from 'number')
     or (select count(distinct x ->> 'applicationId') from jsonb_array_elements(v_list) x) <> jsonb_array_length(v_list) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'applicants';
  end if;
  v_n := jsonb_array_length(v_list);
  v_ids := array(select (x ->> 'applicationId')::uuid from jsonb_array_elements(v_list) x);
  perform 1 from public.visa_applications a where a.id = any (v_ids) order by a.id for update;

  -- Per-applicant state checks (in posted order).
  for v_i in 0 .. v_n - 1 loop
    v_x := v_list -> v_i;
    select * into v_app from public.visa_applications a
    where a.id = (v_x ->> 'applicationId')::uuid and a.task_id = v_task.id;
    if v_app.id is null then
      raise exception 'invalid_input' using errcode = '22023', hint = format('applicants[%s].applicationId', v_i);
    end if;
    perform authz.require_row_version((v_x ->> 'expectedRowVersion')::integer, v_app.row_version);
    if v_app.superseded_at is not null or v_app.closed_at is not null then
      raise exception 'application_closed' using errcode = '55000';
    end if;
    if v_app.removed_at is not null then
      raise exception 'applicant_removed' using errcode = '55000';
    end if;
    if v_app.state <> 'docs_pending' then
      raise exception 'wrong_state' using errcode = '55000';
    end if;
    if authz.visa_traveller_changed(v_app) then
      raise exception 'traveller_changed' using errcode = '55000';
    end if;
    v_not := authz.visa_not_ready(v_app, v_facts);
    if cardinality(v_not) > 0 then
      raise exception 'not_ready' using errcode = '55000', hint = format('applicants[%s]:%s', v_i, v_not[1]);
    end if;
    if not v_passport and authz.visa_effective_kind(v_app, v_facts) is null then
      v_kind_needed := true;
    end if;
  end loop;

  -- Shared fields.
  if p_fields ? 'visaKind' then
    v_kind_post := authz.b11_text(p_fields -> 'visaKind');
    if jsonb_typeof(p_fields -> 'visaKind') not in ('string', 'null') or (v_passport and v_kind_post is not null)
       or (v_kind_post is not null and v_kind_post not in ('e_visa', 'sticker')) then
      v_bad := v_bad || 'visaKind'::text;
    end if;
  end if;
  if v_kind_needed and v_kind_post is null and not ('visaKind' = any (v_bad)) then
    v_bad := v_bad || 'visaKind'::text;
  end if;
  if p_fields ?| array['jurisdiction', 'jurisdictionPlace'] then
    v_jpost := true;
    if v_passport or authz.visa_sales_jurisdiction(v_facts) is not null then
      v_bad := v_bad || 'jurisdiction'::text;
    else
      if jsonb_typeof(p_fields -> 'jurisdiction') = 'string' and (p_fields ->> 'jurisdiction') in ('yes', 'no') then
        v_jreq := (p_fields ->> 'jurisdiction') = 'yes';
      elsif coalesce(jsonb_typeof(p_fields -> 'jurisdiction'), 'null') <> 'null' then
        v_bad := v_bad || 'jurisdiction'::text;
      end if;
      if not authz.sf_text_ok(p_fields -> 'jurisdictionPlace', 120, false) then
        v_bad := v_bad || 'jurisdictionPlace'::text;
      end if;
      v_jplace := regexp_replace(authz.b11_text(p_fields -> 'jurisdictionPlace'), '\s+', ' ', 'g');
      if (v_jreq is true) <> (v_jplace is not null) and not ('jurisdictionPlace' = any (v_bad)) then
        v_bad := v_bad || 'jurisdictionPlace'::text;
      end if;
    end if;
  end if;
  if p_fields ? 'passportTaken' then
    if jsonb_typeof(p_fields -> 'passportTaken') not in ('boolean', 'null') then
      v_bad := v_bad || 'passportTaken'::text;
    else
      v_taken := coalesce((p_fields ->> 'passportTaken')::boolean, false);
    end if;
  end if;
  if v_taken and (v_passport or exists (
       select 1 from public.visa_applications a where a.id = any (v_ids)
         and coalesce(authz.visa_effective_kind(a, v_facts), v_kind_post) is distinct from 'sticker')) then
    v_bad := v_bad || 'passportTaken'::text;
  end if;
  v_paid := authz.b11_text(p_fields -> 'paidBy');
  if v_paid is null or v_paid not in ('company', 'customer_direct') then
    v_bad := v_bad || 'paidBy'::text;
  end if;
  v_mode := authz.b11_text(p_fields -> 'paymentMode');
  if (v_paid = 'company' and (v_mode is null or v_mode not in ('bank_transfer', 'upi', 'card', 'cash', 'other')))
     or (v_paid is distinct from 'company' and v_mode is not null and v_mode not in ('bank_transfer', 'upi', 'card', 'cash', 'other'))
     or (p_fields ? 'paymentMode' and jsonb_typeof(p_fields -> 'paymentMode') not in ('string', 'null')) then
    v_bad := v_bad || 'paymentMode'::text;
  end if;
  if p_fields ? 'receiptEvidenceId' and jsonb_typeof(p_fields -> 'receiptEvidenceId') <> 'null' then
    if jsonb_typeof(p_fields -> 'receiptEvidenceId') <> 'string'
       or (p_fields ->> 'receiptEvidenceId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      v_bad := v_bad || 'receiptEvidenceId'::text;
    else
      v_receipt := (p_fields ->> 'receiptEvidenceId')::uuid;
      if not exists (select 1 from public.department_evidence e
                     where e.id = v_receipt and e.task_id = v_task.id and e.kind = 'fee_receipt' and e.status = 'stored'
                       and (e.application_id is null or e.application_id = any (v_ids))) then
        v_bad := v_bad || 'receiptEvidenceId'::text;
      end if;
    end if;
  end if;
  if not authz.sf_text_ok(p_fields -> 'remark', 300, false) then
    v_bad := v_bad || 'remark'::text;
  end if;
  v_remark := authz.b11_text(p_fields -> 'remark');
  -- Per-applicant fields.
  for v_i in 0 .. v_n - 1 loop
    v_x := v_list -> v_i;
    v_bad := v_bad || array(select format('applicants[%s].%s', v_i, k)
                            from unnest(authz.b11_unknown_keys(v_x, array['applicationId', 'expectedRowVersion', 'reference',
                              'appliedOn', 'governmentFeePaise', 'serviceFeePaise'])) k);
    if not authz.sf_text_ok(v_x -> 'reference', 120, true) then
      v_bad := v_bad || format('applicants[%s].reference', v_i);
    end if;
    if authz.sf_date(v_x -> 'appliedOn') is null then
      v_bad := v_bad || format('applicants[%s].appliedOn', v_i);
    end if;
    if not (jsonb_typeof(v_x -> 'governmentFeePaise') in ('string', 'number')
            and (v_x ->> 'governmentFeePaise') ~ '^[1-9][0-9]{0,14}$') then
      v_bad := v_bad || format('applicants[%s].governmentFeePaise', v_i);
    end if;
    if coalesce(jsonb_typeof(v_x -> 'serviceFeePaise'), 'null') <> 'null'
       and not (jsonb_typeof(v_x -> 'serviceFeePaise') in ('string', 'number')
                and (v_x ->> 'serviceFeePaise') ~ '^[1-9][0-9]{0,14}$') then
      v_bad := v_bad || format('applicants[%s].serviceFeePaise', v_i);
    end if;
  end loop;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  -- V11: applied date never after today (IST).
  if exists (select 1 from jsonb_array_elements(v_list) x where authz.sf_date(x -> 'appliedOn') > v_today) then
    raise exception 'applied_date_in_future' using errcode = '22023';
  end if;
  -- QB10: references unique per task ignoring case (superseded rows included).
  for v_i in 0 .. v_n - 1 loop
    v_ref := authz.b11_text(v_list -> v_i -> 'reference');
    if exists (select 1 from generate_series(0, v_i - 1) j
               where lower(authz.b11_text(v_list -> j -> 'reference')) = lower(v_ref))
       or exists (select 1 from public.visa_applications a
                  where a.task_id = v_task.id and a.reference is not null and lower(a.reference) = lower(v_ref)
                    and a.id <> (v_list -> v_i ->> 'applicationId')::uuid) then
      raise exception 'duplicate_reference' using errcode = '23505', hint = format('applicants[%s].reference', v_i);
    end if;
  end loop;

  v_club := case when v_n > 1 then gen_random_uuid() end;
  v_status := case when v_paid = 'company' then case when v_receipt is not null then 'submitted' else 'draft' end end;
  for v_i in 0 .. v_n - 1 loop
    v_x := v_list -> v_i;
    select * into v_app from public.visa_applications a where a.id = (v_x ->> 'applicationId')::uuid;
    v_ref := authz.b11_text(v_x -> 'reference');
    v_on := authz.sf_date(v_x -> 'appliedOn');
    v_gov := (v_x ->> 'governmentFeePaise')::bigint;
    v_svc := case when coalesce(jsonb_typeof(v_x -> 'serviceFeePaise'), 'null') <> 'null' then (v_x ->> 'serviceFeePaise')::bigint end;
    v_kind := case when v_passport then null else coalesce(authz.visa_effective_kind(v_app, v_facts), v_kind_post) end;
    update public.visa_applications a
    set state = 'decision_pending', reference = v_ref, applied_on = v_on, submitted_at = now(), visa_kind = v_kind,
        jurisdiction_required = case when v_kind = 'sticker' then
            case when authz.visa_sales_jurisdiction(v_facts) is not null
                 then authz.visa_sales_jurisdiction(v_facts) = 'yes'
                 when v_jpost then v_jreq else a.jurisdiction_required end end,
        jurisdiction_place = case when v_kind = 'sticker' then
            case when authz.visa_sales_jurisdiction(v_facts) is not null
                 then (authz.visa_jurisdiction_json(a, v_facts) ->> 'place')
                 when v_jpost then v_jplace else a.jurisdiction_place end end,
        passport_taken_at = case when v_taken then now() else a.passport_taken_at end,
        passport_taken_by = case when v_taken then v_uid else a.passport_taken_by end,
        applied_remark = v_remark, club_id = v_club, club_size = case when v_club is not null then v_n end,
        row_version = a.row_version + 1, updated_by = v_uid, updated_at = now()
    where a.id = v_app.id
    returning * into v_app;
    v_entries := '{}';
    foreach v_k in array array['government_fee', 'service_fee'] loop
      v_amount := case when v_k = 'government_fee' then v_gov else v_svc end;
      continue when v_amount is null;
      insert into public.department_cost_entries (task_id, deal_id, legal_entity_id, branch_id, department, cost_kind,
        amount_paise, paid_by, payment_mode, paid_on, reference, receipt_evidence_id, expense_status, submitted_by,
        submitted_at, request_id, created_by, application_id)
      values (v_task.id, v_task.deal_id, v_task.legal_entity_id, v_task.branch_id, 'visa', v_k, v_amount, v_paid,
        v_mode, v_on, v_ref, v_receipt, v_status,
        case when v_status = 'submitted' then v_uid end, case when v_status = 'submitted' then now() end,
        md5(p_request_id::text || v_app.id::text || v_k)::uuid, v_uid, v_app.id)
      returning id into v_entry;
      v_entries := v_entries || v_entry;
      perform authz.write_audit('department.cost_saved', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry',
        v_entry, null, jsonb_build_object('taskId', v_task.id, 'department', 'visa', 'costKind', v_k,
          'paidBy', v_paid, 'rowVersion', 1));
      if v_status = 'submitted' then
        perform authz.write_audit('department.cost_submitted', v_task.legal_entity_id, v_task.branch_id,
          'department_cost_entry', v_entry, null, jsonb_build_object('taskId', v_task.id, 'department', 'visa',
            'costKind', v_k, 'rowVersion', 1));
      end if;
    end loop;
    v_all_entries := v_all_entries || v_entries;
    perform authz.visa_audit('visa.application_applied', v_app.id, null, jsonb_build_object('clubId', v_club,
      'clubSize', case when v_club is not null then v_n end, 'visaKind', v_kind, 'passportTaken', v_taken,
      'paidBy', v_paid, 'entryIds', to_jsonb(v_entries), 'rowVersion', v_app.row_version));
    v_apps := v_apps || jsonb_build_object('applicationId', v_app.id, 'rowVersion', v_app.row_version, 'state', v_app.state);
  end loop;
  v_done := authz.visa_task_complete_if_done(v_task.id);
  v_result := jsonb_build_object('outcome', 'updated', 'clubId', v_club, 'applications', v_apps,
    'entryIds', to_jsonb(v_all_entries), 'taskCompleted', v_done);
  return authz.visa_remember(v_task.legal_entity_id, p_request_id, v_command, v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 9. C6-C10 decision, handover, delivery, withdrawal, re-application
-- ===========================================================================

-- Validated handover object {method, courierNumber, remark?}; raises
-- invalid_input with p_prefix-named hints.
create function authz.visa_parse_handover(p_value jsonb, p_prefix text) returns jsonb
language plpgsql immutable set search_path = '' as $$
declare
  v_bad text[] := '{}';
  v_method text;
  v_courier text;
begin
  if jsonb_typeof(p_value) is distinct from 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = p_prefix;
  end if;
  v_bad := array(select p_prefix || k from unnest(authz.b11_unknown_keys(p_value, array['method', 'courierNumber', 'remark'])) k);
  v_method := authz.b11_text(p_value -> 'method');
  if v_method is null or v_method not in ('office', 'executive', 'courier', 'not_with_us') then
    v_bad := v_bad || (p_prefix || 'method');
  end if;
  v_courier := authz.b11_text(p_value -> 'courierNumber');
  if (v_method = 'courier' and (v_courier is null or not authz.sf_text_ok(p_value -> 'courierNumber', 80, true)))
     or (v_method is distinct from 'courier' and v_courier is not null)
     or (p_value ? 'courierNumber' and jsonb_typeof(p_value -> 'courierNumber') not in ('string', 'null')) then
    v_bad := v_bad || (p_prefix || 'courierNumber');
  end if;
  if not authz.sf_text_ok(p_value -> 'remark', 300, false) then
    v_bad := v_bad || (p_prefix || 'remark');
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  return jsonb_build_object('method', v_method, 'courierNumber', v_courier, 'remark', authz.b11_text(p_value -> 'remark'));
end;
$$;

-- Records a handover method (C6 / C7): not_with_us closes; courier counts as
-- dispatched (documents returned) and closes (QB8); office / executive wait
-- for Mark delivered. p_close false = record only (withdrawal).
create function authz.visa_record_handover(p_application uuid, p_handover jsonb, p_close boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_method text := p_handover ->> 'method';
begin
  update public.visa_applications a
  set handover_method = v_method, courier_number = p_handover ->> 'courierNumber',
      handover_set_at = now(), handover_set_by = (select auth.uid()), handover_remark = p_handover ->> 'remark',
      documents_returned_at = case when p_close and v_method = 'courier' then now() else a.documents_returned_at end,
      documents_returned_by = case when p_close and v_method = 'courier' then (select auth.uid()) else a.documents_returned_by end,
      updated_by = (select auth.uid()), updated_at = now()
  where a.id = p_application;
  perform authz.visa_audit('visa.handover_set', p_application, null, jsonb_build_object('method', v_method));
  if p_close and v_method in ('not_with_us', 'courier') then
    perform authz.visa_close(p_application, case when v_method = 'courier' then 'courier_dispatched' else 'not_with_us' end);
  end if;
end;
$$;

-- Notice for the Deal's Sales owner, once per application outcome.
create function authz.visa_create_notice(p_application uuid, p_outcome text) returns void
language sql volatile security definer set search_path = '' as $$
  insert into public.visa_result_notices (legal_entity_id, branch_id, deal_id, task_id, application_id, traveller_seq,
    outcome, created_by, created_at)
  -- clock_timestamp: notices written in one transaction keep their order.
  select a.legal_entity_id, d.branch_id, a.deal_id, a.task_id, a.id, a.traveller_seq, p_outcome, (select auth.uid()),
         clock_timestamp()
  from public.visa_applications a join public.deals d on d.id = a.deal_id
  where a.id = p_application
  on conflict (application_id, outcome) do nothing
$$;

-- Result of an application command.
create function authz.visa_app_result(p_application uuid, p_outcome text, p_done boolean) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('outcome', p_outcome, 'applicationId', a.id, 'rowVersion', a.row_version, 'state', a.state,
    'closed', a.closed_at is not null, 'taskCompleted', coalesce(p_done, false))
  from public.visa_applications a where a.id = p_application
$$;

revoke all on function authz.visa_parse_handover(jsonb, text), authz.visa_record_handover(uuid, jsonb, boolean),
  authz.visa_create_notice(uuid, text), authz.visa_app_result(uuid, text, boolean)
from public, anon, authenticated, service_role;

create function public.visa_application_decide(p_application_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_app public.visa_applications%rowtype;
  v_command text := 'visa_application_decide';
  v_payload jsonb := jsonb_build_object('applicationId', p_application_id, 'expectedRowVersion', p_expected_row_version,
                                        'fields', p_fields);
  v_result jsonb;
  v_bad text[] := '{}';
  v_passport boolean;
  v_decision text;
  v_kind text;
  v_evidence uuid;
  v_remark text;
  v_reason text;
  v_email text;
  v_handover jsonb;
  v_done boolean;
begin
  v_app := authz.visa_lock_application(p_application_id);
  v_result := authz.visa_replay(v_app.legal_entity_id, p_request_id, v_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.visa_require_open(v_app, true, false);
  perform authz.require_row_version(p_expected_row_version, v_app.row_version);
  if v_app.state not in ('submitted', 'decision_pending') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_passport := authz.visa_is_passport_task(v_app.task_id);
  v_bad := authz.b11_unknown_keys(p_fields, array['decision', 'outcomeEvidenceId', 'visaKind', 'remark', 'reason',
    'recipientEmail', 'handover']);
  v_decision := authz.b11_text(p_fields -> 'decision');
  if v_decision is null or v_decision not in ('approved', 'rejected') then
    v_bad := v_bad || 'decision'::text;
  end if;
  v_kind := v_app.visa_kind;
  if p_fields ? 'visaKind' and jsonb_typeof(p_fields -> 'visaKind') <> 'null' then
    if v_passport or v_app.visa_kind is not null or (p_fields ->> 'visaKind') not in ('e_visa', 'sticker')
       or jsonb_typeof(p_fields -> 'visaKind') <> 'string' then
      v_bad := v_bad || 'visaKind'::text;
    else
      v_kind := p_fields ->> 'visaKind';
    end if;
  end if;
  if v_decision = 'approved' then
    if not authz.sf_text_ok(p_fields -> 'remark', 300, false) then v_bad := v_bad || 'remark'::text; end if;
    v_remark := authz.b11_text(p_fields -> 'remark');
    if coalesce(jsonb_typeof(p_fields -> 'reason'), 'null') <> 'null' then v_bad := v_bad || 'reason'::text; end if;
  elsif v_decision = 'rejected' then
    v_reason := authz.b11_text(p_fields -> 'reason');
    if not authz.sf_text_ok(p_fields -> 'reason', 300, true) or length(v_reason) < 3 then v_bad := v_bad || 'reason'::text; end if;
    if coalesce(jsonb_typeof(p_fields -> 'remark'), 'null') <> 'null' then v_bad := v_bad || 'remark'::text; end if;
  end if;
  if v_kind = 'e_visa' and v_decision = 'approved' then
    v_email := authz.b11_text(p_fields -> 'recipientEmail');
    if v_email is null or length(v_email) not between 3 and 200 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      v_bad := v_bad || 'recipientEmail'::text;
    end if;
  elsif coalesce(jsonb_typeof(p_fields -> 'recipientEmail'), 'null') <> 'null' then
    v_bad := v_bad || 'recipientEmail'::text;
  end if;
  if coalesce(jsonb_typeof(p_fields -> 'handover'), 'null') <> 'null' then
    if v_kind = 'e_visa' then
      v_bad := v_bad || 'handover'::text;
    elsif cardinality(v_bad) = 0 then
      v_handover := authz.visa_parse_handover(p_fields -> 'handover', 'handover.');
    end if;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  -- Q3 / V5: the visa or refusal document is required.
  if jsonb_typeof(p_fields -> 'outcomeEvidenceId') = 'string'
     and (p_fields ->> 'outcomeEvidenceId') ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    v_evidence := (p_fields ->> 'outcomeEvidenceId')::uuid;
  end if;
  if v_evidence is null or not exists (
       select 1 from public.department_evidence e
       where e.id = v_evidence and e.task_id = v_app.task_id and e.kind = 'authority_outcome' and e.status = 'stored'
         and (e.application_id is null or e.application_id = v_app.id)) then
    raise exception 'outcome_document_required' using errcode = '55000';
  end if;

  update public.visa_applications a
  set state = case when v_decision = 'approved' then 'issued' else 'refused' end,
      outcome_evidence_id = v_evidence, outcome_at = now(), decided_by = (select auth.uid()),
      decision_remark = v_remark, refusal_reason = v_reason, visa_kind = case when v_passport then null else v_kind end,
      evisa_recipient_email = case when v_email is not null then v_email else a.evisa_recipient_email end,
      evisa_sent_at = case when v_email is not null then now() else a.evisa_sent_at end,
      evisa_sent_by = case when v_email is not null then (select auth.uid()) else a.evisa_sent_by end,
      customer_informed_at = case when v_kind = 'e_visa' and v_decision = 'rejected' then now() else a.customer_informed_at end,
      row_version = a.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
  where a.id = v_app.id;
  if v_decision = 'approved' then
    perform authz.visa_audit('visa.application_approved', v_app.id, null, jsonb_build_object('visaKind', v_kind,
      'evidenceId', v_evidence, 'rowVersion', v_app.row_version + 1));
  else
    perform authz.visa_audit('visa.application_rejected', v_app.id, v_reason, jsonb_build_object('visaKind', v_kind,
      'evidenceId', v_evidence, 'rowVersion', v_app.row_version + 1));
  end if;
  perform authz.visa_create_notice(v_app.id, v_decision);
  if v_email is not null then
    perform authz.visa_audit('visa.evisa_sent', v_app.id, null, null);
    perform authz.visa_close(v_app.id, 'evisa_sent');
  elsif v_kind = 'e_visa' and v_decision = 'rejected' then
    perform authz.visa_close(v_app.id, 'refusal_told');
  elsif v_handover is not null then
    perform authz.visa_record_handover(v_app.id, v_handover, true);
  end if;
  v_done := authz.visa_task_complete_if_done(v_app.task_id);
  v_result := authz.visa_app_result(v_app.id, 'updated', v_done);
  return authz.visa_remember(v_app.legal_entity_id, p_request_id, v_command, v_payload, v_result);
end;
$$;

create function public.visa_application_set_handover(p_application_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_app public.visa_applications%rowtype;
  v_command text := 'visa_application_set_handover';
  v_payload jsonb := jsonb_build_object('applicationId', p_application_id, 'expectedRowVersion', p_expected_row_version,
                                        'fields', p_fields);
  v_result jsonb;
  v_email text;
  v_handover jsonb;
  v_done boolean;
begin
  v_app := authz.visa_lock_application(p_application_id);
  v_result := authz.visa_replay(v_app.legal_entity_id, p_request_id, v_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.visa_require_open(v_app, true, false);
  perform authz.require_row_version(p_expected_row_version, v_app.row_version);
  if v_app.state not in ('issued', 'refused') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if v_app.handover_method is not null or v_app.evisa_sent_at is not null then
    raise exception 'already_recorded' using errcode = '55000';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  if v_app.visa_kind = 'e_visa' and v_app.state = 'issued' then
    -- Legacy: issued e-visa without a recorded send.
    v_email := authz.b11_text(p_fields -> 'recipientEmail');
    if cardinality(authz.b11_unknown_keys(p_fields, array['recipientEmail'])) > 0
       or v_email is null or length(v_email) not between 3 and 200 or v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'recipientEmail';
    end if;
    update public.visa_applications a
    set evisa_recipient_email = v_email, evisa_sent_at = now(), evisa_sent_by = (select auth.uid()),
        row_version = a.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
    where a.id = v_app.id;
    perform authz.visa_audit('visa.evisa_sent', v_app.id, null, null);
    perform authz.visa_close(v_app.id, 'evisa_sent');
  elsif v_app.visa_kind = 'e_visa' then
    -- Legacy: refused e-visa, customer told.
    if cardinality(authz.b11_unknown_keys(p_fields, array['customerTold'])) > 0
       or jsonb_typeof(p_fields -> 'customerTold') is distinct from 'boolean' or not (p_fields ->> 'customerTold')::boolean then
      raise exception 'invalid_input' using errcode = '22023', hint = 'customerTold';
    end if;
    update public.visa_applications a
    set customer_informed_at = now(), row_version = a.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
    where a.id = v_app.id;
    perform authz.visa_close(v_app.id, 'refusal_told');
  else
    v_handover := authz.visa_parse_handover(p_fields, '');
    update public.visa_applications a
    set row_version = a.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
    where a.id = v_app.id;
    perform authz.visa_record_handover(v_app.id, v_handover, true);
  end if;
  v_done := authz.visa_task_complete_if_done(v_app.task_id);
  v_result := authz.visa_app_result(v_app.id, 'updated', v_done);
  return authz.visa_remember(v_app.legal_entity_id, p_request_id, v_command, v_payload, v_result);
end;
$$;

create function public.visa_application_mark_delivered(p_application_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_app public.visa_applications%rowtype;
  v_command text := 'visa_application_mark_delivered';
  v_payload jsonb := jsonb_build_object('applicationId', p_application_id, 'expectedRowVersion', p_expected_row_version,
                                        'fields', p_fields);
  v_result jsonb;
  v_bad text[] := '{}';
  v_on date;
  v_done boolean;
begin
  v_app := authz.visa_lock_application(p_application_id);
  v_result := authz.visa_replay(v_app.legal_entity_id, p_request_id, v_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.visa_require_open(v_app, true, false);
  perform authz.require_row_version(p_expected_row_version, v_app.row_version);
  if v_app.handover_method is null or v_app.handover_method not in ('office', 'executive') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_bad := authz.b11_unknown_keys(p_fields, array['deliveredOn', 'remark']);
  v_on := authz.sf_date(p_fields -> 'deliveredOn');
  if v_on is null or (v_app.applied_on is not null and v_on < v_app.applied_on) then
    v_bad := v_bad || 'deliveredOn'::text;
  end if;
  if not authz.sf_text_ok(p_fields -> 'remark', 300, false) then
    v_bad := v_bad || 'remark'::text;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  if v_on > authz.finance_today() then
    raise exception 'delivered_date_in_future' using errcode = '22023';
  end if;
  update public.visa_applications a
  set delivered_on = v_on, delivered_at = now(), delivered_by = (select auth.uid()),
      delivery_remark = authz.b11_text(p_fields -> 'remark'),
      documents_returned_at = coalesce(a.documents_returned_at, now()),
      documents_returned_by = coalesce(a.documents_returned_by, (select auth.uid())),
      row_version = a.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
  where a.id = v_app.id;
  perform authz.visa_audit('visa.handover_delivered', v_app.id, null, jsonb_build_object('method', v_app.handover_method));
  perform authz.visa_close(v_app.id, 'delivered');
  v_done := authz.visa_task_complete_if_done(v_app.task_id);
  v_result := authz.visa_app_result(v_app.id, 'updated', v_done);
  return authz.visa_remember(v_app.legal_entity_id, p_request_id, v_command, v_payload, v_result);
end;
$$;

create function public.visa_application_withdraw(p_application_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_app public.visa_applications%rowtype;
  v_command text := 'visa_application_withdraw';
  v_payload jsonb := jsonb_build_object('applicationId', p_application_id, 'expectedRowVersion', p_expected_row_version,
                                        'fields', p_fields);
  v_result jsonb;
  v_bad text[] := '{}';
  v_reason text;
  v_handover jsonb;
  v_done boolean;
begin
  v_app := authz.visa_lock_application(p_application_id);
  v_result := authz.visa_replay(v_app.legal_entity_id, p_request_id, v_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.visa_require_open(v_app, true, false);
  perform authz.require_row_version(p_expected_row_version, v_app.row_version);
  if v_app.state not in ('docs_pending', 'submitted', 'decision_pending') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_bad := authz.b11_unknown_keys(p_fields, array['reason', 'customerInformed', 'handover']);
  v_reason := authz.b11_text(p_fields -> 'reason');
  if not authz.sf_text_ok(p_fields -> 'reason', 300, true) or length(v_reason) < 3 then
    v_bad := v_bad || 'reason'::text;
  end if;
  if jsonb_typeof(p_fields -> 'customerInformed') is distinct from 'boolean' or not (p_fields ->> 'customerInformed')::boolean then
    v_bad := v_bad || 'customerInformed'::text;
  end if;
  if coalesce(jsonb_typeof(p_fields -> 'handover'), 'null') <> 'null' then
    -- Only when a sticker passport was taken from the customer (VL13).
    if v_app.passport_taken_at is null then
      v_bad := v_bad || 'handover'::text;
    elsif cardinality(v_bad) = 0 then
      v_handover := authz.visa_parse_handover(p_fields -> 'handover', 'handover.');
    end if;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  update public.visa_applications a
  set state = 'withdrawn', withdraw_reason = v_reason, customer_informed_at = now(),
      row_version = a.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
  where a.id = v_app.id;
  perform authz.visa_audit('visa.application_withdrawn', v_app.id, v_reason, jsonb_build_object('rowVersion', v_app.row_version + 1));
  if v_handover is not null then
    perform authz.visa_record_handover(v_app.id, v_handover, false);
  end if;
  perform authz.visa_close(v_app.id, 'customer_informed');
  v_done := authz.visa_task_complete_if_done(v_app.task_id);
  v_result := authz.visa_app_result(v_app.id, 'updated', v_done);
  return authz.visa_remember(v_app.legal_entity_id, p_request_id, v_command, v_payload, v_result);
end;
$$;

create function public.visa_application_reapply(p_application_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_app public.visa_applications%rowtype;
  v_command text := 'visa_application_reapply';
  v_payload jsonb := jsonb_build_object('applicationId', p_application_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_facts jsonb;
  v_new uuid := gen_random_uuid();
  v_was_closed boolean;
  v_cur public.booking_version_travellers%rowtype;
begin
  v_app := authz.visa_lock_application(p_application_id);
  v_result := authz.visa_replay(v_app.legal_entity_id, p_request_id, v_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.visa_require_open(v_app, false, true);
  perform authz.require_row_version(p_expected_row_version, v_app.row_version);
  if v_app.state <> 'refused' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  v_facts := authz.visa_task_facts(v_app.task_id);
  v_was_closed := v_app.closed_at is not null;
  if not v_was_closed then
    perform authz.visa_close(v_app.id, 'reapplied');
  end if;
  update public.visa_applications a
  set superseded_at = now(), superseded_by_id = v_new, row_version = a.row_version + 1,
      updated_by = (select auth.uid()), updated_at = now()
  where a.id = v_app.id;
  v_cur := authz.visa_current_traveller(v_app);
  insert into public.visa_applications (id, task_id, service_item_id, deal_id, legal_entity_id, traveller_seq, updated_by,
    traveller_name_snapshot, traveller_type_snapshot, reapplication_of_id, visa_kind, jurisdiction_required,
    jurisdiction_place, passport_taken_at, passport_taken_by)
  values (v_new, v_app.task_id, v_app.service_item_id, v_app.deal_id, v_app.legal_entity_id, v_app.traveller_seq,
    (select auth.uid()), v_cur.full_name, v_cur.traveller_type, v_app.id,
    case when authz.visa_sales_kind(v_facts) is null then v_app.visa_kind end,
    case when authz.visa_sales_jurisdiction(v_facts) is null then v_app.jurisdiction_required end,
    case when authz.visa_sales_jurisdiction(v_facts) is null then v_app.jurisdiction_place end,
    v_app.passport_taken_at, v_app.passport_taken_by);
  insert into public.visa_application_documents (legal_entity_id, task_id, application_id, catalogue_code, label, source,
    status, received_at, received_by, remark, added_by)
  select d.legal_entity_id, d.task_id, v_new, d.catalogue_code, d.label, 'copied', d.status, d.received_at, d.received_by,
         d.remark, (select auth.uid())
  from public.visa_application_documents d
  where d.application_id = v_app.id and d.removed_at is null
  order by d.created_at, d.id;
  perform authz.visa_audit('visa.application_reapplied', v_app.id, null, jsonb_build_object('newApplicationId', v_new));
  v_result := jsonb_build_object('outcome', 'created', 'applicationId', v_new, 'rowVersion', 1,
    'previousApplicationId', v_app.id, 'state', 'docs_pending', 'closed', false, 'taskCompleted', false);
  return authz.visa_remember(v_app.legal_entity_id, p_request_id, v_command, v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 10. C11 document file, department_evidence_begin (200 files per visa task)
-- ===========================================================================

-- Replaces 20261201000130 (same signature): visa tasks may hold 200
-- non-removed files (VL25); purchase and flight keep 50.
create or replace function public.department_evidence_begin(
  p_task_id uuid, p_application_id uuid, p_kind text, p_file_name text, p_mime text, p_size_bytes integer, p_sha256 text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_name text := btrim(coalesce(p_file_name, ''));
  v_sha text := lower(coalesce(p_sha256, ''));
  v_max integer := coalesce((select s.evidence_max_bytes from public.booking_settings s where s.id), 4194304);
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  perform authz.refuse_removed_deal(v_task.deal_id);
  if v_task.id is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_task.status in ('completed', 'supplier_confirmed') then
    raise exception 'task_closed' using errcode = '55000';
  end if;
  if not authz.can_work_department_task(v_task.id) or v_task.department = 'purchase' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_kind is null
     or (v_task.department = 'visa' and p_kind not in ('applicant_document', 'fee_receipt', 'authority_outcome', 'other'))
     -- Flight build (20261201000130): e-tickets.
     or (v_task.department = 'flight' and p_kind not in ('e_ticket', 'direct_payment_proof', 'other'))
     or (p_application_id is not null and not exists (
           select 1 from public.visa_applications a where a.id = p_application_id and a.task_id = v_task.id))
     or p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes not between 1 and least(v_max, 4194304)
     or v_sha !~ '^[0-9a-f]{64}$'
     or length(v_name) not between 1 and 120 or v_name !~ '^[A-Za-z0-9._ -]+$' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  -- Visa build (20261202000110, VL25): 200 files per visa task.
  if (select count(*) from public.department_evidence e where e.task_id = v_task.id and e.status <> 'removed')
     >= (case when v_task.department = 'visa' then 200 else 50 end) then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  v_path := v_task.legal_entity_id::text || '/' || v_task.id::text || '/' || v_id::text;
  insert into public.department_evidence (id, task_id, application_id, legal_entity_id, kind, object_path, file_name, mime,
    size_bytes, sha256, uploaded_by)
  values (v_id, v_task.id, p_application_id, v_task.legal_entity_id, p_kind, v_path, v_name, p_mime, p_size_bytes, v_sha,
    (select auth.uid()));
  perform authz.write_audit('department.evidence_started', v_task.legal_entity_id, v_task.branch_id,
    'department_evidence', v_id, null,
    jsonb_build_object('taskId', v_task.id, 'kind', p_kind, 'mime', p_mime, 'sizeBytes', p_size_bytes));
  return jsonb_build_object('evidenceId', v_id, 'objectPath', v_path);
end;
$$;

-- C11: begins an applicant-document upload against one listed document.
-- Finish stays department_evidence_finish.
create function public.visa_document_file_begin(p_document_id uuid, p_file_name text, p_mime text, p_size_bytes integer,
  p_sha256 text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_doc public.visa_application_documents%rowtype;
  v_app public.visa_applications%rowtype;
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_doc from public.visa_application_documents d where d.id = p_document_id;
  if v_doc.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_app := authz.visa_lock_application(v_doc.application_id);
  perform authz.visa_require_open(v_app, false, false);
  select * into v_doc from public.visa_application_documents d where d.id = p_document_id;
  if v_doc.removed_at is not null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  v_result := public.department_evidence_begin(v_app.task_id, v_app.id, 'applicant_document', p_file_name, p_mime,
    p_size_bytes, p_sha256);
  update public.department_evidence e set visa_document_id = v_doc.id where e.id = (v_result ->> 'evidenceId')::uuid;
  return v_result;
end;
$$;

-- ===========================================================================
-- 11. C12 visa_fee_send, C13 confirm traveller, C14 notice ack
-- ===========================================================================

create function public.visa_fee_send(p_entry_id uuid, p_expected_row_version integer, p_fields jsonb, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entry public.department_cost_entries%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_command text := 'visa_fee_send';
  v_payload jsonb := jsonb_build_object('entryId', p_entry_id, 'expectedRowVersion', p_expected_row_version, 'fields', p_fields);
  v_result jsonb;
  v_bad text[] := '{}';
  v_amount bigint;
  v_receipt uuid;
  v_remark text;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_entry from public.department_cost_entries c where c.id = p_entry_id;
  if v_entry.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.refuse_removed_deal(v_entry.deal_id);
  -- Lock order: deal head, task, entry (as Accounts review).
  perform authz.finance_lock_deal(v_entry.deal_id);
  select * into v_task from public.fulfilment_tasks t where t.id = v_entry.task_id for update;
  select * into v_entry from public.department_cost_entries c where c.id = p_entry_id for update;
  v_result := authz.visa_replay(v_entry.legal_entity_id, p_request_id, v_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_entry.department <> 'visa' then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.visa_require_work(v_task.id);
  perform authz.require_row_version(p_expected_row_version, v_entry.row_version);
  if v_entry.expense_status in ('submitted', 'accepted') then
    raise exception 'cost_locked' using errcode = '55000';
  end if;
  if v_entry.paid_by <> 'company' or v_entry.expense_status is null or v_entry.expense_status not in ('draft', 'returned') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  v_bad := authz.b11_unknown_keys(p_fields, array['amountPaise', 'receiptEvidenceId', 'remark']);
  v_amount := v_entry.amount_paise;
  if p_fields ? 'amountPaise' then
    if jsonb_typeof(p_fields -> 'amountPaise') in ('string', 'number') and (p_fields ->> 'amountPaise') ~ '^[1-9][0-9]{0,14}$' then
      v_amount := (p_fields ->> 'amountPaise')::bigint;
    else
      v_bad := v_bad || 'amountPaise'::text;
    end if;
  end if;
  v_receipt := v_entry.receipt_evidence_id;
  if coalesce(jsonb_typeof(p_fields -> 'receiptEvidenceId'), 'null') <> 'null' then
    if jsonb_typeof(p_fields -> 'receiptEvidenceId') <> 'string'
       or (p_fields ->> 'receiptEvidenceId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or not exists (select 1 from public.department_evidence e
                      where e.id = (p_fields ->> 'receiptEvidenceId')::uuid and e.task_id = v_task.id
                        and e.kind = 'fee_receipt' and e.status = 'stored') then
      v_bad := v_bad || 'receiptEvidenceId'::text;
    else
      v_receipt := (p_fields ->> 'receiptEvidenceId')::uuid;
    end if;
  end if;
  if not authz.sf_text_ok(p_fields -> 'remark', 300, false) then
    v_bad := v_bad || 'remark'::text;
  end if;
  v_remark := authz.b11_text(p_fields -> 'remark');
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  if v_receipt is null or not exists (select 1 from public.department_evidence e
                                      where e.id = v_receipt and e.task_id = v_task.id and e.kind = 'fee_receipt'
                                        and e.status = 'stored') then
    raise exception 'receipt_required' using errcode = '55000';
  end if;
  update public.department_cost_entries c
  set amount_paise = v_amount, receipt_evidence_id = v_receipt, expense_status = 'submitted',
      submitted_by = (select auth.uid()), submitted_at = now(), reviewed_by = null, reviewed_at = null, return_reason = null,
      row_version = c.row_version + 1, updated_at = now()
  where c.id = v_entry.id
  returning * into v_entry;
  perform authz.write_audit('department.cost_saved', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('taskId', v_task.id, 'department', 'visa', 'costKind', v_entry.cost_kind,
      'paidBy', v_entry.paid_by, 'rowVersion', v_entry.row_version));
  perform authz.write_audit('department.cost_submitted', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('taskId', v_task.id, 'department', 'visa', 'costKind', v_entry.cost_kind,
      'rowVersion', v_entry.row_version));
  perform authz.write_audit('visa.fee_sent', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry', v_entry.id,
    v_remark, jsonb_build_object('taskId', v_task.id, 'entryId', v_entry.id, 'applicationId', v_entry.application_id,
      'costKind', v_entry.cost_kind, 'seq', (select a.traveller_seq from public.visa_applications a where a.id = v_entry.application_id)));
  v_result := jsonb_build_object('outcome', 'updated', 'entryId', v_entry.id, 'rowVersion', v_entry.row_version,
    'expenseStatus', v_entry.expense_status, 'taskCompleted', false);
  return authz.visa_remember(v_entry.legal_entity_id, p_request_id, v_command, v_payload, v_result);
end;
$$;

create function public.visa_application_confirm_traveller(p_application_id uuid, p_expected_row_version integer,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_app public.visa_applications%rowtype;
  v_command text := 'visa_application_confirm_traveller';
  v_payload jsonb := jsonb_build_object('applicationId', p_application_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_cur public.booking_version_travellers%rowtype;
begin
  v_app := authz.visa_lock_application(p_application_id);
  v_result := authz.visa_replay(v_app.legal_entity_id, p_request_id, v_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.visa_require_open(v_app, false, false);
  perform authz.require_row_version(p_expected_row_version, v_app.row_version);
  if not authz.visa_traveller_changed(v_app) then
    v_result := authz.visa_app_result(v_app.id, 'existing', false);
  else
    v_cur := authz.visa_current_traveller(v_app);
    update public.visa_applications a
    set traveller_name_snapshot = v_cur.full_name, traveller_type_snapshot = v_cur.traveller_type,
        row_version = a.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
    where a.id = v_app.id;
    perform authz.visa_audit('visa.traveller_change_confirmed', v_app.id, null, null);
    v_result := authz.visa_app_result(v_app.id, 'updated', false);
  end if;
  return authz.visa_remember(v_app.legal_entity_id, p_request_id, v_command, v_payload, v_result);
end;
$$;

-- C14: the Deal's Sales owner (branch Manager when none) marks a result seen.
-- No audit (view state).
create function public.visa_result_notice_ack(p_notice_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_notice public.visa_result_notices%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_notice from public.visa_result_notices n where n.id = p_notice_id for update;
  if v_notice.id is null or not authz.visa_notice_reader(v_notice.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_notice.seen_at is not null then
    return jsonb_build_object('outcome', 'existing', 'noticeId', v_notice.id, 'seenAt', v_notice.seen_at);
  end if;
  update public.visa_result_notices n set seen_at = now(), seen_by = (select auth.uid()) where n.id = v_notice.id
  returning * into v_notice;
  return jsonb_build_object('outcome', 'updated', 'noticeId', v_notice.id, 'seenAt', v_notice.seen_at);
end;
$$;

-- ===========================================================================
-- 12. C15 department_cost_save (replaced, same signature)
-- ===========================================================================

-- Replaces 20261201000210: visa tasks may record only "other" costs linked
-- to a passenger (lead decision 16; fees come from Applied); task-level visa
-- entries are refused (hint visaFees). Flight and Purchase refused as before.
create or replace function public.department_cost_save(p_task_id uuid, p_entry_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_old public.department_cost_entries%rowtype;
  v_entry public.department_cost_entries%rowtype;
  v_bad text[];
  v_kind text;
  v_amount bigint;
  v_paid text;
  v_mode text;
  v_on date;
  v_ref text;
  v_receipt uuid;
  v_status text;
  v_app uuid;  -- Visa build
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  perform authz.refuse_removed_deal(v_task.deal_id);
  if v_task.id is null or not authz.can_work_department_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- B1.1c: Purchase gets the read-only placeholder only (B2/B3 build its costs).
  if v_task.department = 'purchase' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'department';
  end if;
  -- Flight build (20261201000210, owner D3): the per-passenger fare breakup
  -- is the only flight cost record; manual flight entries end here.
  if v_task.department = 'flight' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'flightFares';
  end if;
  -- Visa build (20261202000110, VL18 as changed by lead decision 16): only an
  -- "other" cost of one current passenger (applicationId); fees come from Applied.
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or jsonb_typeof(p_fields -> 'applicationId') is distinct from 'string'
     or (p_fields ->> 'applicationId') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or not exists (select 1 from public.visa_applications a
                    where a.id = (p_fields ->> 'applicationId')::uuid and a.task_id = v_task.id and a.superseded_at is null)
     or authz.b11_text(p_fields -> 'costKind') is distinct from 'other' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'visaFees';
  end if;
  v_app := (p_fields ->> 'applicationId')::uuid;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if p_entry_id is null then
    select * into v_old from public.department_cost_entries c where c.task_id = v_task.id and c.request_id = p_request_id;
    if v_old.id is not null then
      return jsonb_build_object('entryId', v_old.id, 'rowVersion', v_old.row_version, 'expenseStatus', v_old.expense_status);
    end if;
  else
    select * into v_old from public.department_cost_entries c where c.id = p_entry_id and c.task_id = v_task.id for update;
    if v_old.id is null then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    perform authz.require_row_version(p_expected_row_version, v_old.row_version);
    if v_old.expense_status in ('submitted', 'accepted') then
      raise exception 'cost_locked' using errcode = '55000';
    end if;
    -- Visa build: only an "other" cost of the same passenger is edited here.
    if v_old.application_id is distinct from v_app or v_old.cost_kind <> 'other' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'visaFees';
    end if;
  end if;

  v_bad := authz.b11_unknown_keys(p_fields, array['costKind', 'amountPaise', 'paidBy', 'paymentMode', 'paidOn', 'reference',
    'receiptEvidenceId', 'applicationId']);
  v_kind := authz.b11_text(p_fields -> 'costKind');
  if jsonb_typeof(p_fields -> 'amountPaise') in ('string', 'number') and (p_fields ->> 'amountPaise') ~ '^[1-9][0-9]{0,14}$' then
    v_amount := (p_fields ->> 'amountPaise')::bigint;
  else
    v_bad := v_bad || 'amountPaise'::text;
  end if;
  v_paid := authz.b11_text(p_fields -> 'paidBy');
  -- Visa build: same paid-by choices as the Applied fees.
  if v_paid is null or v_paid not in ('company', 'customer_direct') then v_bad := v_bad || 'paidBy'::text; end if;
  v_mode := authz.b11_text(p_fields -> 'paymentMode');
  v_on := authz.sf_date(p_fields -> 'paidOn');
  if v_paid is not null then
    if (v_paid = 'company' and (v_mode is null or v_mode not in ('bank_transfer', 'upi', 'card', 'cash', 'other')))
       or (v_paid = 'customer_direct' and v_mode is not null and v_mode not in ('bank_transfer', 'upi', 'card', 'cash', 'other')) then
      v_bad := v_bad || 'paymentMode'::text;
    end if;
    -- Business date in IST, as the finance commands (review E3).
    if v_on is null or v_on > authz.finance_today() then v_bad := v_bad || 'paidOn'::text; end if;
  end if;
  if not authz.sf_text_ok(p_fields -> 'reference', 120, false) then v_bad := v_bad || 'reference'::text; end if;
  v_ref := authz.b11_text(p_fields -> 'reference');
  if p_fields ? 'receiptEvidenceId' and jsonb_typeof(p_fields -> 'receiptEvidenceId') <> 'null' then
    begin
      v_receipt := (p_fields ->> 'receiptEvidenceId')::uuid;
    exception when others then
      v_bad := v_bad || 'receiptEvidenceId'::text;
    end;
    if v_receipt is not null and not exists (
         select 1 from public.department_evidence e where e.id = v_receipt and e.task_id = v_task.id
           and e.kind = 'fee_receipt' and e.status <> 'removed') then
      v_bad := v_bad || 'receiptEvidenceId'::text;
    end if;
  end if;
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = array_to_string(v_bad, ',');
  end if;
  v_status := case when v_paid = 'company' then coalesce(case when v_old.expense_status = 'returned' then 'returned' end, 'draft') end;

  if v_old.id is null then
    insert into public.department_cost_entries (task_id, deal_id, legal_entity_id, branch_id, department, cost_kind,
      amount_paise, paid_by, payment_mode, paid_on, reference, receipt_evidence_id, expense_status, request_id, created_by,
      application_id)
    values (v_task.id, v_task.deal_id, v_task.legal_entity_id, v_task.branch_id, v_task.department, v_kind, v_amount, v_paid,
      v_mode, v_on, v_ref, v_receipt, v_status, p_request_id, (select auth.uid()), v_app)
    returning * into v_entry;
  else
    update public.department_cost_entries c
    set cost_kind = v_kind, amount_paise = v_amount, paid_by = v_paid, payment_mode = v_mode, paid_on = v_on,
        reference = v_ref, receipt_evidence_id = v_receipt, expense_status = v_status,
        submitted_by = case when v_status = 'returned' then c.submitted_by end,
        submitted_at = case when v_status = 'returned' then c.submitted_at end,
        reviewed_by = case when v_status = 'returned' then c.reviewed_by end,
        reviewed_at = case when v_status = 'returned' then c.reviewed_at end,
        return_reason = case when v_status = 'returned' then c.return_reason end,
        row_version = c.row_version + 1, updated_at = now()
    where c.id = v_old.id
    returning * into v_entry;
  end if;
  -- No amount in the audit record.
  perform authz.write_audit('department.cost_saved', v_task.legal_entity_id, v_task.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('taskId', v_task.id, 'department', v_task.department, 'costKind', v_kind,
      'paidBy', v_paid, 'rowVersion', v_entry.row_version));
  return jsonb_build_object('entryId', v_entry.id, 'rowVersion', v_entry.row_version, 'expenseStatus', v_entry.expense_status);
end;
$$;

-- ===========================================================================
-- 13. Grants; C16 old desk commands revoked
-- ===========================================================================

revoke all on function
  public.visa_application_set_row(uuid, integer, jsonb, uuid),
  public.visa_application_document_add(uuid, integer, jsonb, uuid),
  public.visa_application_document_remove(uuid, integer, uuid),
  public.visa_applications_apply(uuid, jsonb, uuid),
  public.visa_application_decide(uuid, integer, jsonb, uuid),
  public.visa_application_set_handover(uuid, integer, jsonb, uuid),
  public.visa_application_mark_delivered(uuid, integer, jsonb, uuid),
  public.visa_application_withdraw(uuid, integer, jsonb, uuid),
  public.visa_application_reapply(uuid, integer, uuid),
  public.visa_document_file_begin(uuid, text, text, integer, text),
  public.visa_fee_send(uuid, integer, jsonb, uuid),
  public.visa_application_confirm_traveller(uuid, integer, uuid),
  public.visa_result_notice_ack(uuid)
from public, anon, authenticated, service_role;
grant execute on function
  public.visa_application_set_row(uuid, integer, jsonb, uuid),
  public.visa_application_document_add(uuid, integer, jsonb, uuid),
  public.visa_application_document_remove(uuid, integer, uuid),
  public.visa_applications_apply(uuid, jsonb, uuid),
  public.visa_application_decide(uuid, integer, jsonb, uuid),
  public.visa_application_set_handover(uuid, integer, jsonb, uuid),
  public.visa_application_mark_delivered(uuid, integer, jsonb, uuid),
  public.visa_application_withdraw(uuid, integer, jsonb, uuid),
  public.visa_application_reapply(uuid, integer, uuid),
  public.visa_document_file_begin(uuid, text, text, integer, text),
  public.visa_fee_send(uuid, integer, jsonb, uuid),
  public.visa_application_confirm_traveller(uuid, integer, uuid),
  public.visa_result_notice_ack(uuid)
to authenticated;

-- The claim helper is not needed by any policy (contract 0: authz helpers revoked).
revoke execute on function authz.can_claim_visa_task(uuid) from public, anon, authenticated, service_role;

-- C16 (VL17): the old desk commands would bypass the new rules.
revoke execute on function public.visa_application_update(uuid, integer, jsonb),
  public.visa_application_set_state(uuid, integer, text, uuid)
from public, anon, authenticated, service_role;
comment on function public.visa_task_list() is 'Deprecated (Visa build 20261202000110): use visa_queue. Kept one release.';
comment on function public.visa_task_get(uuid) is 'Deprecated (Visa build 20261202000110): use visa_workspace. Kept one release.';
comment on function public.department_work_form(uuid) is 'Deprecated for visa tasks (Visa build 20261202000110): use visa_workspace.';

-- visa_task_claim, department_evidence_begin, department_cost_save and the
-- replaced authz helpers keep their ACLs (CREATE OR REPLACE).

commit;
