-- TripNavigate CRM - B1.2 Phase D: traveller identity proof (Aadhaar card or
-- another ID) uploaded per traveller on Book now step 1.
--
-- Freeze note: docs/implementation/frontend-first-plan-2026-10-10/b1.2/
--   b1.2-freeze-note.md section 2.2 (owner correction of 12 October 2026).
-- Recorded deviation: this file was first written (commit 67331e6) as a
-- Deal-level passenger list. That design was withdrawn by the owner before the
-- file ran on any kept database (disposable local stacks only), so the file is
-- rewritten in place under the same number.
--
-- The three-step Book now form needs no other database change: no step is
-- stored anywhere; the step of a checklist item comes from the frozen
-- TypeScript map.
--
-- What changes:
--   * public.traveller_id_proofs: private files proving a traveller's identity,
--     bound to the traveller row (deal_travellers.id) they were uploaded for,
--     with the traveller seq and the booking version recorded at upload. One
--     or more files per traveller (front and back), at most 4 live
--     (pending_upload or stored) per traveller. Full Aadhaar copies accepted
--     (DEC-39); no typed Aadhaar or ID number anywhere; no extraction; never
--     sent to an external service or Bitrix (DEC-40); never in any content
--     hash; never bumps a booking version's row version; allowed after
--     confirmation. Each upload records the consent tick (who, when; DEC-39).
--     Kept indefinitely (DEC-42): soft removal by an editor only, rows and
--     storage objects are kept.
--   * A proof never moves to another person: when its traveller row is deleted,
--     or the row's name changes (the form renumbers seqs by position, so a
--     changed name at a seq can be a different person), the proof is detached
--     (status removed, reason traveller_removed / traveller_changed, audited).
--   * Private Storage bucket traveller-id-proofs (4 MiB; pdf, jpeg, png, webp),
--     no storage.objects policy; no Data API read of the table.
--   * Commands: traveller_id_proof_begin (consent required; idempotent by
--     request id), traveller_id_proof_finish, traveller_id_proof_remove (file
--     row version), traveller_id_proof_authorize_download (audited view with
--     the viewer's role). Reads traveller_id_proofs_for_task (department
--     task screens) and traveller_id_proofs_for_deal (every viewer, incl.
--     Accounts on its Deal review screen).
--   * Readiness (DEC-38): authz.booking_issues (copy of the 20261119000300
--     body) adds the blocker id_proof_missing for an adult traveller without
--     a stored proof, on package drafts (first and revision drafts);
--     confirmed versions are not re-checked.
--   * booking_form_get (copy of the 20261119000100 body, the latest definition)
--     adds travellers[].idProofs (only where the caller may read the
--     traveller's identity) and idProofLimits.
--   * intake_checklist (copy of the 20261119000300 body, the latest
--     definition) adds id_proof_missing (blocking, adults) and
--     id_proof_missing_child (warning, children and infants) with their
--     travellerSeqs.
--
-- Access (DEC-41):
--   view (form list, task list, download) = authz.id_proof_viewer_role: the
--     Sales owner or sales assignee, the branch Sales Manager, Accounts of the
--     entity (authz.accounts_sees_deal: the accounts_deal_detail gate, no
--     assignment needed), and the assignee of ANY
--     fulfilment task of that Deal holding the active role of its department
--     (Purchase, Flight, Visa & Passport desk; any task status). Never Super
--     Admin by role alone; never staff without a link to the Deal. The B1.1
--     typed identity details (date of birth, nationality, passport number)
--     keep their own rule (authz.can_read_traveller_identity), unchanged.
--   write (begin, finish, remove) = authz.can_edit_booking_draft (Sales owner
--     or sales assignee, branch Sales Manager); never a department or Accounts.
-- Removed / lost Deal and the switch (review D1-2): begin refuses a removed
--   Deal, the switch off and a lost Deal; finish, download and remove refuse a
--   removed Deal only (nobody holds booking rights on it any more) and keep
--   working with the switch off and on a lost Deal.
--
-- Refusal tokens (message is exactly the token): new 55000 id_proof_limit,
--   22023 consent_required;
--   existing 42501 not_authorized; 55000 deal_removed, service_items_disabled,
--   deal_not_active; 22023 invalid_input (hint requestId | seq),
--   evidence_rejected; 40001 request_conflict, version_changed; P0002 not_found.
--
-- Any later migration that replaces booking_form_get, intake_checklist or
-- authz.booking_issues must copy the bodies in THIS file.
--
-- Rollback (forward-only): a NEW migration revokes execute on the four
-- commands and the task read and restores booking_form_get (20261119000100),
-- intake_checklist and authz.booking_issues (20261119000300). Rows and files
-- are kept.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Table
-- ===========================================================================

create table public.traveller_id_proofs (
  id uuid primary key default gen_random_uuid(),
  deal_id uuid not null,
  legal_entity_id uuid not null,
  -- The traveller row the file proves (no foreign key: the row may be deleted
  -- later; the proof is then detached, never re-pointed).
  traveller_id uuid not null,
  traveller_seq integer not null check (traveller_seq between 1 and 100),
  booking_version_id uuid,
  request_id uuid not null,
  -- The consent tick "Customer agreed to share this ID for this booking" (DEC-39).
  consent_by uuid not null references public.staff_profiles (user_id),
  consent_at timestamptz not null,
  object_path text not null unique,
  file_name text not null check (length(file_name) between 1 and 120 and file_name ~ '^[A-Za-z0-9._ -]+$'),
  mime text not null check (mime in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 4194304),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending_upload'
    check (status in ('pending_upload', 'stored', 'failed', 'removed')),
  row_version integer not null default 1 check (row_version >= 1),
  uploaded_by uuid not null references public.staff_profiles (user_id),
  removed_reason text check (removed_reason in ('staff', 'traveller_removed', 'traveller_changed')),
  removed_by uuid references public.staff_profiles (user_id),
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  stored_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id, booking_version_id)
    references public.booking_versions (legal_entity_id, deal_id, id),
  -- Server-generated path; never taken from input.
  constraint traveller_id_proofs_path_check
    check (object_path = legal_entity_id::text || '/' || deal_id::text || '/' || traveller_id::text || '/' || id::text),
  constraint traveller_id_proofs_stored_check check (status <> 'stored' or stored_at is not null),
  constraint traveller_id_proofs_removed_check
    check ((status = 'removed') = (removed_at is not null and removed_reason is not null)),
  constraint traveller_id_proofs_staff_removal_check check (removed_reason is distinct from 'staff' or removed_by is not null),
  constraint traveller_id_proofs_request_unique unique (deal_id, request_id)
);
-- deal_id leads the unique (deal_id, request_id) index (access predicate and replay).
create index traveller_id_proofs_traveller_idx on public.traveller_id_proofs (traveller_id, status);
create index traveller_id_proofs_entity_deal_idx on public.traveller_id_proofs (legal_entity_id, deal_id);
create index traveller_id_proofs_version_idx on public.traveller_id_proofs (booking_version_id) where booking_version_id is not null;
create index traveller_id_proofs_uploaded_by_idx on public.traveller_id_proofs (uploaded_by);
create index traveller_id_proofs_consent_by_idx on public.traveller_id_proofs (consent_by);
create index traveller_id_proofs_removed_by_idx on public.traveller_id_proofs (removed_by) where removed_by is not null;
comment on table public.traveller_id_proofs is
  'Private identity-proof files (Aadhaar card or another ID) of one traveller of a Deal, bound to the traveller row they were uploaded for, with the consent tick. No typed ID number. Viewers: authz.id_proof_viewer_role (DEC-41); never Super Admin by role alone; no Data API read; never hashed; never sent to an external service or Bitrix. Kept indefinitely; soft removal only; detached automatically when the traveller is removed or renamed.';

-- Rows are never deleted; identity columns never change; status moves only
-- pending_upload -> stored | failed and any open state -> removed (final).
-- Every update bumps row_version. Runs inside the definer commands (invoker).
create function authz.traveller_id_proofs_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'traveller id proofs are never deleted' using errcode = '42501';
  end if;
  if tg_op = 'INSERT' then
    if new.status <> 'pending_upload' or new.row_version <> 1 or new.removed_at is not null
       or new.removed_by is not null or new.removed_reason is not null then
      raise exception 'a traveller id proof starts as pending_upload' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.id is distinct from old.id or new.deal_id is distinct from old.deal_id
     or new.legal_entity_id is distinct from old.legal_entity_id or new.traveller_id is distinct from old.traveller_id
     or new.traveller_seq is distinct from old.traveller_seq or new.booking_version_id is distinct from old.booking_version_id
     or new.request_id is distinct from old.request_id or new.object_path is distinct from old.object_path
     or new.consent_by is distinct from old.consent_by or new.consent_at is distinct from old.consent_at
     or new.file_name is distinct from old.file_name or new.mime is distinct from old.mime
     or new.size_bytes is distinct from old.size_bytes or new.sha256 is distinct from old.sha256
     or new.uploaded_by is distinct from old.uploaded_by or new.created_at is distinct from old.created_at then
    raise exception 'traveller id proof identity columns are immutable' using errcode = '42501';
  end if;
  if old.status = 'removed'
     or (new.status is distinct from old.status and not (
           (old.status = 'pending_upload' and new.status in ('stored', 'failed'))
           or new.status = 'removed')) then
    raise exception 'traveller id proof status change not allowed' using errcode = '42501';
  end if;
  new.row_version := old.row_version + 1;
  new.updated_at := now();
  return new;
end;
$$;
create trigger traveller_id_proofs_a_guard
  before insert or update or delete on public.traveller_id_proofs
  for each row execute function authz.traveller_id_proofs_guard();

alter table public.traveller_id_proofs enable row level security;
create policy require_valid_session on public.traveller_id_proofs as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
-- No permissive policy and no privilege: definer functions only (same as
-- traveller_identities).
revoke all on public.traveller_id_proofs from public, anon, authenticated, service_role;

-- Private bucket (no storage.objects policy; the server uses the secret key
-- only after a command below authorized the actor).
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('traveller-id-proofs', 'traveller-id-proofs', false, 4194304,
      array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;

-- ===========================================================================
-- 2. A proof never moves to another person
-- ===========================================================================

-- Name as compared for "same person": trimmed, inner spaces collapsed, lower case.
create function authz.traveller_name_key(p_name text) returns text
language sql immutable set search_path = '' as $$
  select lower(regexp_replace(btrim(coalesce(p_name, ''), E' \t\r\n'), '\s+', ' ', 'g'))
$$;

-- deal_travellers_save upserts by seq and the form numbers seqs by position:
-- removing traveller 2 of 3 deletes row seq 3 and writes person 3's name into
-- row seq 2. Detach every open proof of a deleted row, or of a row whose name
-- changed, so it can never show as another person's proof.
create function authz.traveller_id_proofs_detach() returns trigger
language plpgsql set search_path = '' as $$
declare
  v_reason text;
  v_file record;
begin
  if tg_op = 'DELETE' then
    v_reason := 'traveller_removed';
  elsif authz.traveller_name_key(new.full_name) is distinct from authz.traveller_name_key(old.full_name) then
    v_reason := 'traveller_changed';
  else
    return null;
  end if;
  for v_file in
    update public.traveller_id_proofs f
    set status = 'removed', removed_reason = v_reason, removed_at = now(), removed_by = (select auth.uid())
    where f.traveller_id = old.id and f.status <> 'removed'
    returning f.id, f.deal_id, f.legal_entity_id
  loop
    perform authz.write_audit('booking.id_proof_detached', v_file.legal_entity_id,
      (select d.branch_id from public.deals d where d.id = v_file.deal_id), 'traveller_id_proof', v_file.id, null,
      jsonb_build_object('dealId', v_file.deal_id, 'fileId', v_file.id, 'reason', v_reason));
  end loop;
  return null;
end;
$$;
create trigger deal_travellers_id_proofs_detach
  after delete or update of full_name on public.deal_travellers
  for each row execute function authz.traveller_id_proofs_detach();

-- ===========================================================================
-- 3. Helpers
-- ===========================================================================

-- Effective per-file limit (review D1-11: the read shows what the command enforces).
create function authz.id_proof_max_bytes() returns integer
language sql stable security definer set search_path = '' as $$
  select least(coalesce((select s.evidence_max_bytes from public.booking_settings s where s.id), 4194304), 4194304)
$$;

-- The gate of accounts_deal_detail (20261119000300) as a predicate.
create function authz.accounts_sees_deal(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select coalesce(authz.session_ok(), false)
      and authz.holds_active_role('accounts', d.legal_entity_id)
      and not authz.holds_role('purchase', d.legal_entity_id)
      and authz.finance_gate_issue(d.legal_entity_id, d.is_synthetic) is null
      and d.removed_at is null
    from public.deals d where d.id = p_deal), false)
$$;

-- DEC-41: why the caller may view identity proofs of this Deal (null = not
-- allowed). First match wins; the value goes into the view audit row.
create function authz.id_proof_viewer_role(p_deal uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when p_deal is null or not coalesce(authz.session_ok(), false) then null
    when authz.can_edit_booking_draft(p_deal) or authz.can_confirm_booking(p_deal) then
      case when d.owner_user_id = (select auth.uid()) then 'sales_owner'
           when authz.is_branch_sales_manager(p_deal) then 'manager'
           else 'sales_assignee' end
    -- DEC-41 / real-journey fix: exactly the gate under which accounts_deal_detail shows this
    -- Deal to Accounts (active Accounts role in the entity, no Purchase role, finance gate open),
    -- for a Deal not removed by the sync. No Deal assignment needed.
    when authz.accounts_sees_deal(p_deal) then 'accounts'
    else (select t.department || '_assignee'
          from public.fulfilment_tasks t
          where t.deal_id = p_deal and t.assignee_user_id = (select auth.uid())
            and authz.holds_active_role(t.department, t.legal_entity_id)
          order by t.department, t.created_at
          limit 1)
    end
  from public.deals d
  where d.id = p_deal
$$;

-- Live proofs (pending_upload, stored) of one traveller row, for the Book now
-- form (review D2-1: failed and removed rows are never listed, so the list
-- never exceeds the cap).
create function authz.traveller_id_proofs_json(p_traveller uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'fileId', f.id, 'fileName', f.file_name, 'mime', f.mime, 'sizeBytes', f.size_bytes,
      'status', f.status, 'rowVersion', f.row_version,
      'uploadedByName', (select p.display_name from public.staff_profiles p where p.user_id = f.uploaded_by),
      'uploadedByYou', f.uploaded_by = (select auth.uid()),
      'consentByName', (select p.display_name from public.staff_profiles p where p.user_id = f.consent_by),
      'consentAt', f.consent_at,
      'createdAt', f.created_at, 'storedAt', f.stored_at) order by f.created_at, f.id), '[]'::jsonb)
  from public.traveller_id_proofs f
  where f.traveller_id = p_traveller and f.status in ('pending_upload', 'stored')
$$;

-- Review D3-5: the caller may remove identity proofs right now: a booking
-- editor on a Deal not removed by the sync (also with the switch off, on a
-- lost Deal and after submission).
create function authz.id_proof_can_remove(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.can_edit_booking_draft(p_deal)
    and exists (select 1 from public.deals d where d.id = p_deal and d.removed_at is null), false)
$$;

-- Review D2-3: the caller may attach identity proofs right now:
-- a booking editor on an active, not removed Deal with the switch on; also
-- after submission.
create function authz.id_proof_can_edit(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.can_edit_booking_draft(p_deal) and authz.service_items_enabled()
    and not authz.deal_not_active(p_deal)
    and exists (select 1 from public.deals d where d.id = p_deal and d.removed_at is null), false)
$$;

-- ===========================================================================
-- 4. Commands
-- ===========================================================================

-- Starts one upload for the traveller at p_seq. An exact retry (same Deal,
-- request id, actor, traveller and file) returns the row as it is now; the
-- object path is returned only while the row waits for its upload. Anything
-- else under that request id is request_conflict. The Deal lock is taken
-- before the authorization reads (review D1-4) and serializes the cap.
create function public.traveller_id_proof_begin(
  p_deal_id uuid, p_seq integer, p_request_id uuid, p_consent boolean, p_file_name text, p_mime text,
  p_size_bytes integer, p_sha256 text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_traveller public.deal_travellers%rowtype;
  v_existing public.traveller_id_proofs%rowtype;
  v_name text := btrim(left(btrim(regexp_replace(coalesce(p_file_name, ''), '[^A-Za-z0-9._ -]', '_', 'g')), 120));
  v_sha text := lower(btrim(coalesce(p_sha256, '')));
  v_id uuid := gen_random_uuid();
  v_path text;
begin
  perform authz.refuse_removed_deal(p_deal_id);
  select * into v_deal from public.deals d where d.id = p_deal_id for no key update;
  if v_deal.id is null or not authz.can_edit_booking_draft(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if not authz.service_items_enabled() then
    raise exception 'service_items_disabled' using errcode = '55000';
  end if;
  if authz.deal_not_active(p_deal_id) then
    raise exception 'deal_not_active' using errcode = '55000';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if p_seq is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'seq';
  end if;
  -- DEC-39: the customer's consent to share this ID for this booking.
  if p_consent is distinct from true then
    raise exception 'consent_required' using errcode = '22023';
  end if;
  -- Review D3-1: FOR SHARE conflicts with the row lock of a rename or delete
  -- (deal_travellers_save): a save waits for this upload's commit, so its
  -- detach sees the new proof; a begin that waited for a save reads the row
  -- as saved (a deleted row is not_found).
  select * into v_traveller from public.deal_travellers t where t.deal_id = p_deal_id and t.seq = p_seq for share;
  if v_traveller.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;

  select * into v_existing from public.traveller_id_proofs f
  where f.deal_id = p_deal_id and f.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.uploaded_by is distinct from (select auth.uid()) or v_existing.traveller_id is distinct from v_traveller.id
       or v_existing.file_name is distinct from v_name or v_existing.mime is distinct from p_mime
       or v_existing.size_bytes is distinct from p_size_bytes or v_existing.sha256 is distinct from v_sha then
      raise exception 'request_conflict' using errcode = '40001';
    end if;
    -- Review D1-3: no upload path for a row that no longer waits for one.
    return jsonb_build_object('fileId', v_existing.id, 'outcome', 'existing', 'status', v_existing.status,
      'rowVersion', v_existing.row_version,
      'objectPath', case when v_existing.status = 'pending_upload' then v_existing.object_path end);
  end if;

  if v_name = '' or v_name ~ '^[. ]+$'
     or p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > authz.id_proof_max_bytes()
     or v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  -- Review D1-5/D1-6: failed and removed rows do not count; own token.
  if (select count(*) from public.traveller_id_proofs f
      where f.traveller_id = v_traveller.id and f.status in ('pending_upload', 'stored')) >= 4 then
    raise exception 'id_proof_limit' using errcode = '55000';
  end if;

  v_path := v_deal.legal_entity_id::text || '/' || v_deal.id::text || '/' || v_traveller.id::text || '/' || v_id::text;
  insert into public.traveller_id_proofs
    (id, deal_id, legal_entity_id, traveller_id, traveller_seq, booking_version_id, request_id, consent_by, consent_at,
     object_path, file_name, mime, size_bytes, sha256, uploaded_by)
  values (v_id, v_deal.id, v_deal.legal_entity_id, v_traveller.id, v_traveller.seq,
    (authz.deal_current_version(p_deal_id)).id, p_request_id, (select auth.uid()), now(), v_path, v_name, p_mime,
    p_size_bytes, v_sha, (select auth.uid()));

  -- No file name in the audit record (it may carry a person's name).
  perform authz.write_audit('booking.id_proof_started', v_deal.legal_entity_id, v_deal.branch_id,
    'traveller_id_proof', v_id, null,
    jsonb_build_object('dealId', v_deal.id, 'fileId', v_id, 'travellerSeq', v_traveller.seq,
      'mime', p_mime, 'sizeBytes', p_size_bytes));
  return jsonb_build_object('fileId', v_id, 'outcome', 'created', 'status', 'pending_upload', 'rowVersion', 1,
    'objectPath', v_path);
end;
$$;

-- Records the upload outcome. 'stored' only when Storage really holds the
-- object at the server-generated path with the declared size; otherwise
-- 'failed'. Only the uploader, while still a booking editor. Refuses a
-- removed Deal; completes an upload begun earlier also with the switch off or
-- on a lost Deal. Repeats report the recorded outcome.
create function public.traveller_id_proof_finish(p_file_id uuid, p_ok boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal uuid := (select f.deal_id from public.traveller_id_proofs f where f.id = p_file_id);
  v_file public.traveller_id_proofs%rowtype;
  v_status text;
  v_missing boolean := false;
begin
  perform authz.refuse_removed_deal(v_deal);
  -- Lock order everywhere: Deal, traveller row, file (the same order as a
  -- traveller save and its detach; review D3-1).
  perform 1 from public.deals d where d.id = v_deal for no key update;
  perform 1 from public.deal_travellers t
  where t.id = (select f.traveller_id from public.traveller_id_proofs f where f.id = p_file_id) for share;
  select * into v_file from public.traveller_id_proofs f where f.id = p_file_id for update;
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
       where o.bucket_id = 'traveller-id-proofs' and o.name = v_file.object_path
         and (o.metadata ->> 'size') ~ '^[0-9]{1,18}$'
         and (o.metadata ->> 'size')::bigint = v_file.size_bytes)) then
    v_status := 'failed';
    v_missing := true;
  end if;

  update public.traveller_id_proofs f
  set status = v_status, stored_at = case when v_status = 'stored' then now() else null end
  where f.id = v_file.id
  returning * into v_file;

  perform authz.write_audit(
    case when v_status = 'stored' then 'booking.id_proof_stored' else 'booking.id_proof_failed' end,
    v_file.legal_entity_id, (select d.branch_id from public.deals d where d.id = v_file.deal_id),
    'traveller_id_proof', v_file.id, null,
    jsonb_build_object('dealId', v_file.deal_id, 'fileId', v_file.id, 'objectMissing', v_missing));
  return jsonb_build_object('fileId', v_file.id, 'status', v_status, 'rowVersion', v_file.row_version);
end;
$$;

-- Soft removal (the storage object is kept). Any booking editor; available
-- with the switch off, on a lost Deal and after confirmation so a wrong file
-- can be taken off. A Deal removed by the sync has no booking editor any more
-- (its rows are hidden from everyone), so members get deal_removed. The file
-- row version guards a stale screen.
create function public.traveller_id_proof_remove(p_file_id uuid, p_expected_row_version integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal uuid := (select f.deal_id from public.traveller_id_proofs f where f.id = p_file_id);
  v_file public.traveller_id_proofs%rowtype;
  v_previous text;
begin
  perform authz.refuse_removed_deal(v_deal);
  perform 1 from public.deals d where d.id = v_deal for no key update;
  -- Review D3-2: FOR SHARE on the open draft conflicts with booking_confirm's
  -- FOR UPDATE, so a confirm either sees this removal in its readiness check
  -- or finishes first (a confirmed version is not re-checked).
  perform 1 from public.booking_versions v where v.deal_id = v_deal and v.status = 'draft' for share;
  select * into v_file from public.traveller_id_proofs f where f.id = p_file_id for update;
  if v_file.id is null or not authz.can_edit_booking_draft(v_file.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_file.status = 'removed' then
    return jsonb_build_object('fileId', v_file.id, 'status', 'removed', 'rowVersion', v_file.row_version);
  end if;
  perform authz.require_row_version(p_expected_row_version, v_file.row_version);
  v_previous := v_file.status;

  update public.traveller_id_proofs f
  set status = 'removed', removed_reason = 'staff', removed_at = now(), removed_by = (select auth.uid())
  where f.id = v_file.id
  returning * into v_file;

  perform authz.write_audit('booking.id_proof_removed', v_file.legal_entity_id,
    (select d.branch_id from public.deals d where d.id = v_file.deal_id), 'traveller_id_proof', v_file.id, null,
    jsonb_build_object('dealId', v_file.deal_id, 'fileId', v_file.id, 'previousStatus', v_previous));
  return jsonb_build_object('fileId', v_file.id, 'status', 'removed', 'rowVersion', v_file.row_version);
end;
$$;

-- Authorizes one download (the server then signs a short URL with the secret
-- key). Viewers by DEC-41. Refuses a removed Deal; a lost Deal stays
-- readable. Every view is audited with the viewer's role (DEC-39).
create function public.traveller_id_proof_authorize_download(p_file_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_file public.traveller_id_proofs%rowtype;
  v_role text;
begin
  select * into v_file from public.traveller_id_proofs f where f.id = p_file_id;
  perform authz.refuse_removed_deal(v_file.deal_id);
  v_role := authz.id_proof_viewer_role(v_file.deal_id);
  if v_file.id is null or v_role is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_file.status <> 'stored' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.write_audit('booking.id_proof_viewed', v_file.legal_entity_id,
    (select d.branch_id from public.deals d where d.id = v_file.deal_id), 'traveller_id_proof', v_file.id, null,
    jsonb_build_object('dealId', v_file.deal_id, 'fileId', v_file.id, 'travellerSeq',
      coalesce((select t.seq from public.deal_travellers t where t.id = v_file.traveller_id), v_file.traveller_seq),
      'viewerRole', v_role));
  return jsonb_build_object('objectPath', v_file.object_path, 'fileName', v_file.file_name, 'mime', v_file.mime);
end;
$$;

-- Department task screens (Purchase, Flight, Visa & Passport desk): the
-- participants of the task's service with their STORED proofs (metadata only).
-- The task's assignee holding the active role of its department, or the
-- Deal's branch Sales Manager; null for everyone else.
create function public.traveller_id_proofs_for_task(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  -- Review D3-4: nothing for a Deal removed by the sync.
  if v_task.id is null
     or exists (select 1 from public.deals d where d.id = v_task.deal_id and d.removed_at is not null)
     or not coalesce(
       (v_task.assignee_user_id = (select auth.uid()) and authz.holds_active_role(v_task.department, v_task.legal_entity_id))
       or authz.is_branch_sales_manager(v_task.deal_id), false) then
    return null;
  end if;
  return jsonb_build_object(
    'taskId', v_task.id,
    'travellers', coalesce((
      select jsonb_agg(jsonb_build_object(
          'seq', t.seq, 'fullName', t.full_name, 'type', t.traveller_type,
          'idProofs', coalesce((
            select jsonb_agg(jsonb_build_object('fileId', f.id, 'fileName', f.file_name, 'mime', f.mime,
                'sizeBytes', f.size_bytes, 'storedAt', f.stored_at) order by f.created_at, f.id)
            from public.traveller_id_proofs f
            where f.traveller_id = t.id and f.status = 'stored'), '[]'::jsonb)) order by t.seq)
      from public.deal_travellers t
      where t.deal_id = v_task.deal_id
        and t.seq = any (authz.item_participant_seqs(v_task.service_item_id, authz.task_current_version(v_task.id)))),
      '[]'::jsonb));
end;
$$;

-- Review D2-5 (DEC-41): every identity-proof viewer of the Deal, including
-- Accounts on its Deal review screen: travellers with their STORED proofs
-- (metadata only). Null for anyone else and for a Deal removed by the sync.
create function public.traveller_id_proofs_for_deal(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_deal_id is null or authz.id_proof_viewer_role(p_deal_id) is null
     or exists (select 1 from public.deals d where d.id = p_deal_id and d.removed_at is not null) then
    return null;
  end if;
  return jsonb_build_object(
    'dealId', p_deal_id,
    'travellers', coalesce((
      select jsonb_agg(jsonb_build_object(
          'seq', t.seq, 'fullName', t.full_name, 'type', t.traveller_type,
          'idProofs', coalesce((
            select jsonb_agg(jsonb_build_object('fileId', f.id, 'fileName', f.file_name, 'mime', f.mime,
                'sizeBytes', f.size_bytes, 'storedAt', f.stored_at) order by f.created_at, f.id)
            from public.traveller_id_proofs f
            where f.traveller_id = t.id and f.status = 'stored'), '[]'::jsonb)) order by t.seq)
      from public.deal_travellers t where t.deal_id = p_deal_id), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- 5. Book now read (replaces 20261119000100; adds travellers[].idProofs and
--    idProofLimits only)
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
  return v_result;
end;
$$;

-- ===========================================================================
-- 5b. Readiness (replaces 20261119000300 authz.booking_issues; adds
--     id_proof_missing only)
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

-- ===========================================================================
-- 6. Checklist (replaces 20261119000300; adds id_proof_missing and
--    id_proof_missing_child only)
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
-- 7. Grants
-- ===========================================================================

revoke all on function
  authz.traveller_id_proofs_guard(),
  authz.traveller_id_proofs_detach(),
  authz.traveller_name_key(text),
  authz.id_proof_max_bytes(),
  authz.id_proof_viewer_role(uuid),
  authz.accounts_sees_deal(uuid),
  authz.id_proof_can_edit(uuid),
  authz.id_proof_can_remove(uuid),
  authz.traveller_id_proofs_json(uuid)
from public, anon, authenticated, service_role;

revoke all on function
  public.traveller_id_proof_begin(uuid, integer, uuid, boolean, text, text, integer, text),
  public.traveller_id_proof_finish(uuid, boolean),
  public.traveller_id_proof_remove(uuid, integer),
  public.traveller_id_proof_authorize_download(uuid),
  public.traveller_id_proofs_for_task(uuid),
  public.traveller_id_proofs_for_deal(uuid),
  public.booking_form_get(uuid),
  public.intake_checklist(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.traveller_id_proof_begin(uuid, integer, uuid, boolean, text, text, integer, text),
  public.traveller_id_proof_finish(uuid, boolean),
  public.traveller_id_proof_remove(uuid, integer),
  public.traveller_id_proof_authorize_download(uuid),
  public.traveller_id_proofs_for_task(uuid),
  public.traveller_id_proofs_for_deal(uuid),
  public.booking_form_get(uuid),
  public.intake_checklist(uuid)
to authenticated;

commit;
