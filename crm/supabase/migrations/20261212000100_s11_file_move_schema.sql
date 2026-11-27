-- TripNavigate CRM - S11 "files to Bitrix" (1 of 6): tables, constraints and shared helpers
--
-- Contract: hosting-migration-2026-11-26/14-s11-files-to-bitrix-contract.md
-- (wins), 11-s11-files-to-bitrix-contract.md revision 4, sections 2.2 to 2.6
-- (2.4 a, b, c, d, h, l); lead freeze of 27 Nov 2026 (slice 0).
--
-- Why: identity papers and Accounts papers move to two file boxes on the
-- linked Bitrix deal. The CRM deletes its own copy only after the database has
-- compared two separate full downloads of the Bitrix copy with its own record,
-- the second one at least 15 minutes after the first. This file creates only
-- the tables and the helpers the later S11 files use. Nothing here sends,
-- moves or deletes anything, and every switch is Off.
--
-- What changes:
--   * public.file_bitrix_moves: one row per source file that may move; it is
--     both the job and the record of where the file is. The two safety
--     constraints of 2.4 (a) are written exactly as in the contract, with the
--     15 minutes hard coded. crm_copy_present ("the CRM still holds the
--     object") is kept apart from the state, is true on insert, and may change
--     only while the two confirm functions (20261212000120) have set the
--     transaction flag tripnavigate.file_move_copy_writer (guard trigger).
--     Columns added to the contract list (and why):
--       kind_code              neutral code the worker puts in the Bitrix file
--                              name (freeze, "kindCode")
--       stored_at              the source file's stored time (90-day rule,
--                              stuck-row report)
--       lease_mode             the mode handed out with the lease, so each
--                              worker command can check it is the right one
--       relocate_due           a search of the box by hash is queued
--       relocate_source_deal_id  the Bitrix deal to search instead (a deal
--                              merged in Bitrix; set by file_move_relocate)
--       restore_checked_at     the copy-back download matched; the bytes may
--                              now be uploaded and confirmed
--       enqueued_by            trigger | sweep | backfill (missed-enqueue count)
--     There are deliberately no foreign keys to deals or to the DEC-43 job
--     table (deal_id and dec43_job_id are plain ids): existing test clean-ups
--     delete deals and jobs, and a move row must never stop that. Business
--     rows are never re-pointed, so nothing is lost.
--   * public.file_move_settings: one row per company (created on first use;
--     a missing row means "all Off, listing on, hold 15 minutes, 90 days").
--     Columns as 2.4 (b) plus pilot_source_deal_id and delete_ever_on (the
--     delete switch may be turned on the first time only while a pilot deal is
--     set). Watched by authz.audit_settings_change (settings.file_move_changed).
--     accounts_hold_days has no staff setter (owner SQL only, audited by the
--     trigger, floor 90).
--   * public.file_move_kick_state: one unaudited row for the kick's 20-second
--     breaker; also records installed_at (the time this file ran), so the
--     10-minute sweep lists only files stored after the install.
--   * public.file_move_stops: alert rows, append and acknowledge once (shape of
--     bitrix_id_proof_copy_stops, plus deal-level rows with no move).
--   * public.file_bitrix_views: one row per view served from Bitrix (who,
--     which file, outcome). Business-linked; never pruned; never deleted.
--   * public.file_move_box_state: last append time per Bitrix deal and box.
--     Allowed deviation from file 14 section 5.2 (freeze): it is created here,
--     not in 20261212000140, because the worker commands in 20261212000120
--     already write it.
--   * Helpers (owner only): authz.file_move_deal_lock(bigint),
--     authz.file_move_try_deal_lock(bigint) (the per-deal lock shared with the
--     restated DEC-43 claim), authz.file_move_settings_for(uuid),
--     authz.file_move_audit(...), and the guard and box triggers.
--
-- Every table: RLS on with the restrictive require_valid_session policy, all
-- privileges revoked from public, anon, authenticated and service_role (no
-- Data API access; only the S11 commands read and write them). Codes and ids
-- only: no link, host, file name or file content is ever stored.
-- Nothing here contains a URL, a host, a bearer or a secret, or schedules a job.
-- Rollback: forward-only. With all switches Off the tables are inert.

begin;
set local lock_timeout = '5s';

-- ===========================================================================
-- 1. The per-deal lock (shared with the restated DEC-43 claim)
-- ===========================================================================

-- Waits for the transaction-level lock of one Bitrix deal. Used by single-row
-- commands that need it, always before any row lock.
create function authz.file_move_deal_lock(p_source_deal_id bigint) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_source_deal_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'sourceDealId';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('file_move_deal:' || p_source_deal_id::text, 0));
end;
$$;

-- Takes the same lock only when it is free. Claims use it and skip a busy
-- deal, so two claims never wait for each other.
create function authz.file_move_try_deal_lock(p_source_deal_id bigint) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_source_deal_id is null then
    return false;
  end if;
  return pg_try_advisory_xact_lock(hashtextextended('file_move_deal:' || p_source_deal_id::text, 0));
end;
$$;

-- ===========================================================================
-- 2. Settings (one row per company)
-- ===========================================================================

create table public.file_move_settings (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null unique references public.legal_entities (id),
  -- "Check ID proof copies in Bitrix": S11 copies and checks identity papers.
  check_id_proof_copies boolean not null default false,
  -- "Move Accounts files after 90 days".
  move_accounts_files boolean not null default false,
  -- "Delete the CRM's copy after the hold".
  delete_after_hold boolean not null default false,
  delete_hold_minutes integer not null default 15 check (delete_hold_minutes between 15 and 43200),
  accounts_hold_days integer not null default 90 check (accounts_hold_days between 90 and 3650),
  -- The Accounts box (item-API key), set by the Super Admin; never the identity box.
  accounts_bitrix_field text
    check (accounts_bitrix_field ~ '^ufCrm_[0-9A-Za-z_]{1,40}$' and accounts_bitrix_field <> 'ufCrm_1784359513'),
  -- Lead's stop for the listing itself.
  enqueue_enabled boolean not null default true,
  -- Pilot scope: while set, second checks, deletion and every Accounts mode
  -- are handed out only for rows of this one Bitrix deal.
  pilot_source_deal_id bigint check (pilot_source_deal_id > 0),
  -- True once the delete switch has been on; the first time needs a pilot.
  delete_ever_on boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.staff_profiles (user_id),
  check (not delete_after_hold or delete_ever_on)
);
comment on table public.file_move_settings is
  'S11: switches and values of the file move to Bitrix, one row per company. All switches Off by default; written only by the file_move_set_* commands (Super Admin, reason, audited) or audited owner SQL. No Data API access.';

create trigger file_move_settings_audit
  after insert or update or delete on public.file_move_settings
  for each row execute function authz.audit_settings_change(
    'settings.file_move_changed', 'check_id_proof_copies', 'move_accounts_files', 'delete_after_hold',
    'delete_hold_minutes', 'accounts_hold_days', 'accounts_bitrix_field', 'enqueue_enabled',
    'pilot_source_deal_id', 'delete_ever_on');
create trigger file_move_settings_touch before update on public.file_move_settings
  for each row execute function authz.touch_settings_updated_at();
create trigger file_move_settings_no_truncate before truncate on public.file_move_settings
  for each statement execute function authz.refuse_settings_truncate();

alter table public.file_move_settings enable row level security;
create policy require_valid_session on public.file_move_settings as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.file_move_settings from public, anon, authenticated, service_role;

-- The settings of one company, or the defaults when it has no row yet.
create function authz.file_move_settings_for(p_entity uuid) returns public.file_move_settings
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.file_move_settings;
begin
  select * into v from public.file_move_settings s where s.legal_entity_id = p_entity;
  if v.id is null then
    v.legal_entity_id := p_entity;
    v.check_id_proof_copies := false;
    v.move_accounts_files := false;
    v.delete_after_hold := false;
    v.delete_hold_minutes := 15;
    v.accounts_hold_days := 90;
    v.accounts_bitrix_field := null;
    v.enqueue_enabled := true;
    v.pilot_source_deal_id := null;
    v.delete_ever_on := false;
  end if;
  return v;
end;
$$;

-- ===========================================================================
-- 3. Kick breaker (one row, not audited)
-- ===========================================================================

create table public.file_move_kick_state (
  id boolean primary key default true check (id),
  last_kick_at timestamptz,
  installed_at timestamptz not null default now()
);
comment on table public.file_move_kick_state is
  'S11: one row. last_kick_at is the breaker of authz.kick_file_move (touched with FOR UPDATE SKIP LOCKED); installed_at is when S11 was installed (the sweep lists files stored after it). Not audited.';
insert into public.file_move_kick_state (id) values (true);

alter table public.file_move_kick_state enable row level security;
create policy require_valid_session on public.file_move_kick_state as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.file_move_kick_state from public, anon, authenticated, service_role;

-- ===========================================================================
-- 4. Moves
-- ===========================================================================

create table public.file_bitrix_moves (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  source_table text not null check (source_table in ('traveller_id_proofs', 'department_evidence', 'customer_party_documents',
    'finance_evidence', 'refund_evidence', 'supplier_money_evidence', 'booking_evidence')),
  source_id uuid not null,
  file_class text not null check (file_class in ('id_proof', 'accounts')),
  kind_code text not null check (kind_code ~ '^[a-z]{1,10}$'),
  bucket_id text not null check (bucket_id in ('traveller-id-proofs', 'department-evidence', 'customer-party-documents',
    'finance-evidence', 'supplier-money', 'booking-evidence')),
  object_path text not null check (length(object_path) between 1 and 300),
  mime text not null check (mime in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 4194304),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  stored_at timestamptz not null,
  -- CRM deal (no foreign key, see the header) and its Bitrix identity.
  deal_id uuid,
  source_portal text,
  source_deal_id bigint check (source_deal_id > 0),
  traveller_id uuid,
  -- Item-API key of the box: the identity box for class A, the configured
  -- Accounts box for class B (null while a class B row waits). Limited to
  -- those two values by authz.file_move_box_guard.
  bitrix_field text check (bitrix_field ~ '^ufCrm_[0-9A-Za-z_]{1,40}$'),
  state text not null check (state in ('no_target', 'waiting', 'copy_pending', 'copy_sending', 'copy_unknown', 'copied',
    'verified', 'delete_pending', 'deleted', 'restore_pending', 'quarantined', 'needs_manual_check', 'failed',
    'lost_in_bitrix', 'lost_accepted', 'cancelled')),
  due_at timestamptz,
  attempts integer not null default 0 check (attempts between 0 and 50),
  read_back_attempts integer not null default 0 check (read_back_attempts between 0 and 50),
  max_attempts integer not null default 5 check (max_attempts between 1 and 50),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  locked_until timestamptz,
  lease_mode text check (lease_mode in ('copy', 'verify_copy', 'verify', 'reverify', 'delete', 'confirm_delete', 'restore',
    'relocate', 'presence')),
  -- Bitrix file ids the box held just before the last S11 send.
  prior_file_ids bigint[],
  bitrix_file_id bigint check (bitrix_file_id > 0),
  verified_sha256 text check (verified_sha256 ~ '^[0-9a-f]{64}$'),
  verified_size_bytes integer check (verified_size_bytes >= 0),
  verified_at timestamptz,
  delete_after timestamptz,
  reverified_sha256 text check (reverified_sha256 ~ '^[0-9a-f]{64}$'),
  reverified_size_bytes integer check (reverified_size_bytes >= 0),
  reverified_at timestamptz,
  -- The start of the second check's read, proved later than the last append
  -- to this box when the row became delete_pending.
  reverified_after_append_at timestamptz,
  deleted_at timestamptz,
  presence_checked_at timestamptz,
  keep_in_crm boolean not null default false,
  crm_copy_present boolean not null default true,
  dec43_job_id uuid,
  relocate_due boolean not null default false,
  relocate_source_deal_id bigint check (relocate_source_deal_id > 0),
  restore_checked_at timestamptz,
  enqueued_by text not null default 'trigger' check (enqueued_by in ('trigger', 'sweep', 'backfill')),
  last_error_code text check (last_error_code ~ '^[a-z_]{1,60}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint file_bitrix_moves_source_unique unique (source_table, source_id),
  -- 2.4 (a), first check: written as in the contract.
  constraint file_bitrix_moves_first_check check (state not in ('verified','delete_pending','deleted') or (verified_sha256 = sha256 and verified_size_bytes = size_bytes and bitrix_file_id is not null and verified_at is not null and delete_after is not null and delete_after >= verified_at + interval '15 minutes')),
  -- 2.4 (a), second check: written as in the contract.
  constraint file_bitrix_moves_second_check check (state not in ('delete_pending','deleted') or (reverified_sha256 = sha256 and reverified_size_bytes = size_bytes and reverified_at is not null and reverified_at >= delete_after and not keep_in_crm)),
  constraint file_bitrix_moves_deleted_check check (state <> 'deleted' or (deleted_at is not null and not crm_copy_present)),
  constraint file_bitrix_moves_copy_fact_check check (crm_copy_present or deleted_at is not null),
  constraint file_bitrix_moves_after_append_check check (state not in ('delete_pending','deleted') or reverified_after_append_at is not null),
  constraint file_bitrix_moves_lease_check check ((lease_token is null) = (locked_until is null)),
  constraint file_bitrix_moves_lease_mode_check check ((lease_token is null) = (lease_mode is null)),
  constraint file_bitrix_moves_target_check check (state in ('no_target', 'cancelled') or source_deal_id is not null),
  constraint file_bitrix_moves_box_check check (state in ('no_target', 'waiting', 'cancelled') or bitrix_field is not null),
  constraint file_bitrix_moves_due_check check (file_class <> 'accounts' or state <> 'waiting' or due_at is not null)
);
create index file_bitrix_moves_due_idx on public.file_bitrix_moves (next_attempt_at)
  where state in ('copy_pending', 'copy_sending', 'copy_unknown', 'copied', 'verified', 'delete_pending', 'restore_pending')
     or relocate_due;
create index file_bitrix_moves_entity_idx on public.file_bitrix_moves (legal_entity_id);
create index file_bitrix_moves_deal_idx on public.file_bitrix_moves (deal_id);
create index file_bitrix_moves_box_idx on public.file_bitrix_moves (source_deal_id, bitrix_field);
create index file_bitrix_moves_dec43_idx on public.file_bitrix_moves (dec43_job_id) where dec43_job_id is not null;
create index file_bitrix_moves_sole_copy_idx on public.file_bitrix_moves (source_deal_id, bitrix_field) where not crm_copy_present;
create index file_bitrix_moves_waiting_idx on public.file_bitrix_moves (due_at) where state = 'waiting';
comment on table public.file_bitrix_moves is
  'S11: one row per identity or Accounts file that may move to Bitrix; the job and the record of where the file is. Codes, ids, hashes and times only; never a link, host, file name or content. Written only by the S11 commands and triggers. No Data API access.';

-- Identity columns never change; crm_copy_present changes only inside the two
-- confirm functions (they set tripnavigate.file_move_copy_writer for that one
-- statement). updated_at follows every change.
create function authz.file_move_row_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if not new.crm_copy_present or new.deleted_at is not null then
      raise exception 'a move row starts with the CRM copy present' using errcode = '23514';
    end if;
    return new;
  end if;
  if (new.id, new.legal_entity_id, new.source_table, new.source_id, new.file_class, new.kind_code, new.bucket_id,
      new.object_path, new.mime, new.size_bytes, new.sha256, new.stored_at, new.created_at)
     is distinct from
     (old.id, old.legal_entity_id, old.source_table, old.source_id, old.file_class, old.kind_code, old.bucket_id,
      old.object_path, old.mime, old.size_bytes, old.sha256, old.stored_at, old.created_at) then
    raise exception 'the file of a move row never changes' using errcode = '23514';
  end if;
  if new.crm_copy_present is distinct from old.crm_copy_present
     and coalesce(current_setting('tripnavigate.file_move_copy_writer', true), '') <> 'on' then
    raise exception 'crm_copy_present is written only by file_move_confirm_deleted and file_move_confirm_restored'
      using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger file_bitrix_moves_guard before insert or update on public.file_bitrix_moves
  for each row execute function authz.file_move_row_guard();

-- The box is one of exactly two values: the identity box for class A, the
-- company's configured Accounts box for class B.
create function authz.file_move_box_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_box text;
begin
  if new.bitrix_field is null then
    return new;
  end if;
  if new.file_class = 'id_proof' then
    if new.bitrix_field <> 'ufCrm_1784359513' then
      raise exception 'bitrix_field must be the identity box' using errcode = '23514';
    end if;
  else
    select s.accounts_bitrix_field into v_box from public.file_move_settings s where s.legal_entity_id = new.legal_entity_id;
    if v_box is null or new.bitrix_field <> v_box then
      raise exception 'bitrix_field must be the configured Accounts box' using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;
create trigger file_bitrix_moves_box before insert or update of bitrix_field on public.file_bitrix_moves
  for each row execute function authz.file_move_box_guard();
create trigger file_bitrix_moves_no_truncate before truncate on public.file_bitrix_moves
  for each statement execute function authz.refuse_settings_truncate();

alter table public.file_bitrix_moves enable row level security;
create policy require_valid_session on public.file_bitrix_moves as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.file_bitrix_moves from public, anon, authenticated, service_role;

-- ===========================================================================
-- 5. Stops (alerts)
-- ===========================================================================

create table public.file_move_stops (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  -- Null for a deal-level alert (deal_removed_with_files).
  move_id uuid references public.file_bitrix_moves (id),
  source_deal_id bigint check (source_deal_id > 0),
  bitrix_field text check (bitrix_field ~ '^ufCrm_[0-9A-Za-z_]{1,40}$'),
  reason_code text not null check (reason_code in ('prior_files_lost', 'copy_mismatch', 'missing_in_bitrix', 'deal_not_found',
    'deal_removed_with_files')),
  opened_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  acknowledge_reason text check (char_length(acknowledge_reason) between 10 and 500),
  check ((acknowledged_at is null) = (acknowledged_by is null)),
  check ((acknowledged_at is null) = (acknowledge_reason is null))
);
create index file_move_stops_open_idx on public.file_move_stops (legal_entity_id) where acknowledged_at is null;
create index file_move_stops_move_idx on public.file_move_stops (move_id) where move_id is not null;
comment on table public.file_move_stops is
  'S11: automatic stops and alerts of the file move (copy mismatch, files lost from a box, file missing in Bitrix, deal not found, removed deal holding files). Append and acknowledge once; codes and ids only.';

create function authz.file_move_stop_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'file move stops are never deleted' using errcode = '23514';
  end if;
  if (new.id, new.legal_entity_id, new.move_id, new.source_deal_id, new.bitrix_field, new.reason_code, new.opened_at)
       is distinct from (old.id, old.legal_entity_id, old.move_id, old.source_deal_id, old.bitrix_field, old.reason_code, old.opened_at)
     or (old.acknowledged_at is not null
         and (new.acknowledged_at, new.acknowledged_by, new.acknowledge_reason)
             is distinct from (old.acknowledged_at, old.acknowledged_by, old.acknowledge_reason)) then
    raise exception 'a file move stop can only be acknowledged once' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger file_move_stops_guard before update or delete on public.file_move_stops
  for each row execute function authz.file_move_stop_guard();
create trigger file_move_stops_no_truncate before truncate on public.file_move_stops
  for each statement execute function authz.refuse_settings_truncate();

alter table public.file_move_stops enable row level security;
create policy require_valid_session on public.file_move_stops as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.file_move_stops from public, anon, authenticated, service_role;

-- ===========================================================================
-- 6. Views served from Bitrix
-- ===========================================================================

create table public.file_bitrix_views (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  actor_user_id uuid not null,
  move_id uuid not null references public.file_bitrix_moves (id),
  started_at timestamptz not null default now(),
  -- Set once by file_view_resolve (server, within 60 seconds of the start).
  resolved_at timestamptz,
  outcome text check (outcome in ('served', 'bitrix_unavailable', 'mismatch', 'not_found_in_bitrix', 'deal_not_found')),
  finished_at timestamptz,
  check ((outcome is null) = (finished_at is null))
);
create index file_bitrix_views_actor_idx on public.file_bitrix_views (actor_user_id, started_at);
create index file_bitrix_views_move_idx on public.file_bitrix_views (move_id);
comment on table public.file_bitrix_views is
  'S11: one row per file view served from Bitrix: who, which move row, outcome. Business-linked audit detail; never pruned or deleted.';

create function authz.file_view_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'file views are never deleted' using errcode = '23514';
  end if;
  if (new.id, new.legal_entity_id, new.actor_user_id, new.move_id, new.started_at)
       is distinct from (old.id, old.legal_entity_id, old.actor_user_id, old.move_id, old.started_at)
     or (old.resolved_at is not null and new.resolved_at is distinct from old.resolved_at)
     or (old.outcome is not null and (new.outcome, new.finished_at) is distinct from (old.outcome, old.finished_at)) then
    raise exception 'a file view is resolved once and finished once' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger file_bitrix_views_guard before update or delete on public.file_bitrix_views
  for each row execute function authz.file_view_guard();
create trigger file_bitrix_views_no_truncate before truncate on public.file_bitrix_views
  for each statement execute function authz.refuse_settings_truncate();

alter table public.file_bitrix_views enable row level security;
create policy require_valid_session on public.file_bitrix_views as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.file_bitrix_views from public, anon, authenticated, service_role;

-- ===========================================================================
-- 7. Last append per Bitrix deal and box (2.4 l)
-- ===========================================================================

-- Written when a send to the box starts (S11 and DEC-43 mark sending) and
-- when it settles (S11 and DEC-43 complete). A second check counts only if
-- its read started after last_append_at.
create table public.file_move_box_state (
  source_deal_id bigint not null check (source_deal_id > 0),
  bitrix_field text not null check (bitrix_field ~ '^ufCrm_[0-9A-Za-z_]{1,40}$'),
  last_append_started_at timestamptz,
  last_append_at timestamptz,
  primary key (source_deal_id, bitrix_field)
);
comment on table public.file_move_box_state is
  'S11: time of the last append to each Bitrix deal box (by S11 or DEC-43). Ids and times only.';
create trigger file_move_box_state_no_truncate before truncate on public.file_move_box_state
  for each statement execute function authz.refuse_settings_truncate();

alter table public.file_move_box_state enable row level security;
create policy require_valid_session on public.file_move_box_state as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.file_move_box_state from public, anon, authenticated, service_role;

-- ===========================================================================
-- 8. Audit helper (codes and ids only)
-- ===========================================================================

-- One audit row about a move row. No Bitrix deal id, Bitrix file id, link,
-- host or file name: the move id leads to them for whoever may read the table.
create function authz.file_move_audit(p_action text, p_move public.file_bitrix_moves, p_reason text, p_details jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform authz.write_audit(p_action, p_move.legal_entity_id,
    (select d.branch_id from public.deals d where d.id = p_move.deal_id),
    'file_bitrix_move', p_move.id, p_reason,
    jsonb_build_object('moveId', p_move.id, 'sourceTable', p_move.source_table, 'sourceId', p_move.source_id,
      'fileClass', p_move.file_class, 'kindCode', p_move.kind_code, 'state', p_move.state, 'attempts', p_move.attempts)
    || coalesce(p_details, '{}'::jsonb));
end;
$$;

revoke all on function
  authz.file_move_deal_lock(bigint),
  authz.file_move_try_deal_lock(bigint),
  authz.file_move_settings_for(uuid),
  authz.file_move_row_guard(),
  authz.file_move_box_guard(),
  authz.file_move_stop_guard(),
  authz.file_view_guard(),
  authz.file_move_audit(text, public.file_bitrix_moves, text, jsonb)
from public, anon, authenticated, service_role;

commit;
