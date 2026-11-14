-- TripNavigate CRM - B1.2 Phase F: branded itineraries from canonical facts.
--
-- Freeze: docs/implementation/frontend-first-plan-2026-10-10/b1.2/
--   b1.2-freeze-note-part-2.md section 5 (Q-F1, Q-F2); Atlas proposal Part 2
--   section 2.5; Nova phase A sections 5-6; shapes in the Atlas notes
--   (atlas-b12-0500-shapes).
--
-- What changes:
--   * itinerary_documents (on a quotation or a Deal), itinerary_source_files
--     (private bucket itinerary-sources: PDF, DOCX, JPEG, PNG, WebP, 4 MiB; no
--     extraction, never sent outside), itinerary_fact_drafts (hand-entered facts,
--     allowlisted JSON, no money), itinerary_difference_runs and
--     itinerary_fact_differences (field paths and kinds only, never values),
--     itinerary_render_jobs (idempotent by input hash, lease, at most 3
--     attempts, error codes from an allowlist) and itinerary_rendered_documents
--     (private bucket rendered-documents, PDF only).
--   * A draft becomes ready, and a final render is requested, only when the
--     differences against the current basis (accepted quotation version, else
--     the live sent version, else the working draft; for a Deal without a
--     quotation, its working booking version) were checked and every one was
--     acknowledged (Q-F2).
--   * Editors only: the quotation's editors, or the Deal's booking editors.
--     Never Purchase, Flight, the desk, Accounts or Super Admin. The worker
--     commands are granted to service_role only (the server calls them after
--     an authorized render request).
--
-- Known limit (accepted by the lead, 12 October 2026): the factual
-- differences are computed by the server code (Nova) and stored here; the
-- database checks their shape, the basis and the facts hash but cannot
-- recompute them, so an editor calling the command directly could submit an
-- empty list. Editors are trusted staff and every save is audited.
--
-- Refusal tokens added (message is exactly the token):
--   55000 differences_not_checked, differences_open
--   40001 basis_changed
--   Existing: not_authorized, deal_removed, invalid_input, evidence_rejected,
--   not_ready, version_changed, request_conflict, task_conflict, not_found.
--
-- Rollback (forward-only): a NEW migration revokes execute on the commands,
-- reads and worker commands. Rows and files are kept.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Tables
-- ===========================================================================

create table public.itinerary_documents (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  quotation_id uuid,
  deal_id uuid,
  title text not null check (length(title) between 1 and 200),
  request_id uuid not null,
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, branch_id) references public.branches (legal_entity_id, id),
  foreign key (legal_entity_id, quotation_id) references public.quotations (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  unique (legal_entity_id, id),
  constraint itinerary_documents_subject_check check (num_nonnulls(quotation_id, deal_id) = 1),
  constraint itinerary_documents_request_unique unique (created_by, request_id)
);
create index itinerary_documents_quotation_idx on public.itinerary_documents (quotation_id) where quotation_id is not null;
create index itinerary_documents_deal_idx on public.itinerary_documents (deal_id) where deal_id is not null;
create index itinerary_documents_branch_idx on public.itinerary_documents (legal_entity_id, branch_id);
comment on table public.itinerary_documents is
  'A branded itinerary built from hand-entered facts (B1.2 Phase F). Editors of its quotation or Deal only; no Data API read.';

create table public.itinerary_source_files (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  legal_entity_id uuid not null,
  object_path text not null unique,
  file_name text not null check (length(file_name) between 1 and 120 and file_name ~ '^[A-Za-z0-9._ -]+$'),
  mime text not null check (mime in ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                                     'image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 4194304),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending_upload' check (status in ('pending_upload', 'stored', 'failed', 'removed')),
  uploaded_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  stored_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, document_id) references public.itinerary_documents (legal_entity_id, id),
  unique (legal_entity_id, id),
  check (object_path = legal_entity_id::text || '/' || document_id::text || '/' || id::text),
  check (status <> 'stored' or stored_at is not null)
);
create index itinerary_source_files_document_idx on public.itinerary_source_files (document_id, status);
create index itinerary_source_files_entity_idx on public.itinerary_source_files (legal_entity_id, document_id);
create index itinerary_source_files_uploaded_by_idx on public.itinerary_source_files (uploaded_by);

create table public.itinerary_fact_drafts (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  legal_entity_id uuid not null,
  status text not null default 'draft' check (status in ('draft', 'ready')),
  row_version integer not null default 1 check (row_version >= 1),
  facts jsonb not null default '{}'::jsonb check (jsonb_typeof(facts) = 'object'),
  facts_hash text not null check (facts_hash ~ '^[0-9a-f]{64}$'),
  source_file_id uuid,
  ready_run_id uuid,
  created_by uuid not null references public.staff_profiles (user_id),
  updated_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, document_id) references public.itinerary_documents (legal_entity_id, id),
  foreign key (legal_entity_id, source_file_id) references public.itinerary_source_files (legal_entity_id, id),
  unique (legal_entity_id, id),
  constraint itinerary_fact_drafts_one_per_document unique (document_id),
  constraint itinerary_fact_drafts_ready_run check ((status = 'ready') = (ready_run_id is not null))
);
create index itinerary_fact_drafts_entity_idx on public.itinerary_fact_drafts (legal_entity_id, document_id);
create index itinerary_fact_drafts_source_idx on public.itinerary_fact_drafts (source_file_id) where source_file_id is not null;
create index itinerary_fact_drafts_created_by_idx on public.itinerary_fact_drafts (created_by);
create index itinerary_fact_drafts_updated_by_idx on public.itinerary_fact_drafts (updated_by);

create table public.itinerary_difference_runs (
  id uuid primary key default gen_random_uuid(),
  draft_id uuid not null,
  legal_entity_id uuid not null,
  facts_hash text not null check (facts_hash ~ '^[0-9a-f]{64}$'),
  basis_kind text not null check (basis_kind in ('quotation_version', 'booking_version', 'none')),
  basis_id uuid,
  basis_hash text not null check (basis_hash ~ '^[0-9a-f]{64}$'),
  difference_count integer not null check (difference_count between 0 and 500),
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, draft_id) references public.itinerary_fact_drafts (legal_entity_id, id),
  unique (legal_entity_id, id),
  constraint itinerary_difference_runs_unique unique (draft_id, facts_hash, basis_hash),
  check ((basis_kind = 'none') = (basis_id is null))
);
create index itinerary_difference_runs_entity_idx on public.itinerary_difference_runs (legal_entity_id, draft_id);
create index itinerary_difference_runs_created_by_idx on public.itinerary_difference_runs (created_by);
alter table public.itinerary_fact_drafts
  add constraint itinerary_fact_drafts_ready_run_fk foreign key (legal_entity_id, ready_run_id)
    references public.itinerary_difference_runs (legal_entity_id, id);
create index itinerary_fact_drafts_ready_run_idx on public.itinerary_fact_drafts (ready_run_id) where ready_run_id is not null;

create table public.itinerary_fact_differences (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null,
  legal_entity_id uuid not null,
  field_path text not null check (field_path ~ '^[A-Za-z][A-Za-z0-9_.\[\]-]{0,119}$'),
  difference text not null check (difference in ('missing', 'different', 'extra')),
  -- Review E3-9: hashes of each side's value (never the values), computed by the server.
  facts_value_hash text check (facts_value_hash ~ '^[0-9a-f]{32,64}$'),
  basis_value_hash text check (basis_value_hash ~ '^[0-9a-f]{32,64}$'),
  acknowledged_by uuid references public.staff_profiles (user_id),
  acknowledged_at timestamptz,
  note text check (length(note) between 1 and 500),
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, run_id) references public.itinerary_difference_runs (legal_entity_id, id),
  constraint itinerary_fact_differences_unique unique (run_id, field_path, difference),
  check ((acknowledged_at is null) = (acknowledged_by is null)),
  check (note is null or acknowledged_at is not null)
);
create index itinerary_fact_differences_entity_idx on public.itinerary_fact_differences (legal_entity_id, run_id);
create index itinerary_fact_differences_open_idx on public.itinerary_fact_differences (run_id) where acknowledged_at is null;
create index itinerary_fact_differences_ack_by_idx on public.itinerary_fact_differences (acknowledged_by) where acknowledged_by is not null;

create table public.itinerary_render_jobs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  legal_entity_id uuid not null,
  kind text not null check (kind in ('preview', 'final')),
  input_hash text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  template_version text not null check (template_version ~ '^[a-z0-9._-]{1,40}$'),
  facts_hash text not null check (facts_hash ~ '^[0-9a-f]{64}$'),
  basis_hash text not null check (basis_hash ~ '^[0-9a-f]{64}$'),
  -- DEC-48: the requester could read the customer prices (selling side) when asking for the render.
  include_money boolean not null default false,
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  attempts smallint not null default 0 check (attempts between 0 and 3),
  max_attempts smallint not null default 3 check (max_attempts between 1 and 3),
  available_at timestamptz not null default now(),
  lease_owner text check (length(lease_owner) between 1 and 60),
  lease_until timestamptz,
  last_error_code text check (last_error_code in ('render_timeout', 'browser_failed', 'asset_missing', 'input_invalid',
    'upload_failed', 'internal', 'content_safety', 'layout_overflow', 'placeholders_present', 'qa_blocked', 'lease_expired', 'input_changed', 'text_clipped')),
  requested_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  foreign key (legal_entity_id, document_id) references public.itinerary_documents (legal_entity_id, id),
  unique (legal_entity_id, id),
  check ((status = 'running') = (lease_owner is not null and lease_until is not null)),
  check ((status in ('succeeded', 'failed', 'cancelled')) = (finished_at is not null))
);
create unique index itinerary_render_jobs_input_unique on public.itinerary_render_jobs (document_id, kind, input_hash)
  where status in ('queued', 'running', 'succeeded');
create index itinerary_render_jobs_queue_idx on public.itinerary_render_jobs (available_at, created_at) where status in ('queued', 'running');
create index itinerary_render_jobs_document_idx on public.itinerary_render_jobs (document_id, created_at);
create index itinerary_render_jobs_entity_idx on public.itinerary_render_jobs (legal_entity_id, document_id);
create index itinerary_render_jobs_requested_by_idx on public.itinerary_render_jobs (requested_by);

create table public.itinerary_rendered_documents (
  id uuid primary key default gen_random_uuid(),
  render_job_id uuid not null unique,
  document_id uuid not null,
  legal_entity_id uuid not null,
  kind text not null check (kind in ('preview', 'final')),
  object_path text not null unique,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer not null check (size_bytes between 1 and 15728640),
  page_count integer not null check (page_count between 1 and 200),
  qa jsonb not null check (jsonb_typeof(qa) = 'object'),
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, document_id) references public.itinerary_documents (legal_entity_id, id),
  foreign key (legal_entity_id, render_job_id) references public.itinerary_render_jobs (legal_entity_id, id),
  check (object_path = legal_entity_id::text || '/' || document_id::text || '/' || render_job_id::text || '.pdf')
);
create index itinerary_rendered_documents_document_idx on public.itinerary_rendered_documents (document_id, created_at);
create index itinerary_rendered_documents_entity_idx on public.itinerary_rendered_documents (legal_entity_id, document_id);

-- ===========================================================================
-- 2. Guards (invoker trigger functions; they run inside the definer commands)
-- ===========================================================================

-- Documents, sources, runs, jobs and renders are never deleted; documents,
-- difference runs and rendered documents never change; fixed identity columns.
create function authz.itinerary_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'itinerary record is immutable' using errcode = '42501';
end;
$$;

create function authz.itinerary_source_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'itinerary records are never deleted' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.document_id is distinct from old.document_id
     or new.object_path is distinct from old.object_path or new.file_name is distinct from old.file_name
     or new.mime is distinct from old.mime or new.size_bytes is distinct from old.size_bytes
     or new.sha256 is distinct from old.sha256 or new.uploaded_by is distinct from old.uploaded_by
     or old.status = 'removed' then
    raise exception 'itinerary source identity is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

create function authz.itinerary_draft_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'itinerary records are never deleted' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.document_id is distinct from old.document_id
     or new.created_by is distinct from old.created_by then
    raise exception 'itinerary draft identity is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

create function authz.itinerary_difference_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'itinerary records are never deleted' using errcode = '42501';
  end if;
  if new.run_id is distinct from old.run_id or new.field_path is distinct from old.field_path
     or new.difference is distinct from old.difference or new.facts_value_hash is distinct from old.facts_value_hash
     or new.basis_value_hash is distinct from old.basis_value_hash or old.acknowledged_at is not null then
    raise exception 'an acknowledged difference is final' using errcode = '42501';
  end if;
  return new;
end;
$$;

create function authz.itinerary_job_guard() returns trigger
language plpgsql set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'itinerary records are never deleted' using errcode = '42501';
  end if;
  if new.document_id is distinct from old.document_id or new.kind is distinct from old.kind
     or new.input_hash is distinct from old.input_hash or new.facts_hash is distinct from old.facts_hash
     or new.basis_hash is distinct from old.basis_hash or new.include_money is distinct from old.include_money
     or old.status in ('succeeded', 'failed', 'cancelled') then
    raise exception 'a finished render job is final' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger itinerary_documents_a_guard before update or delete on public.itinerary_documents
  for each row execute function authz.itinerary_immutable();
create trigger itinerary_source_files_a_guard before update or delete on public.itinerary_source_files
  for each row execute function authz.itinerary_source_guard();
create trigger itinerary_fact_drafts_a_guard before update or delete on public.itinerary_fact_drafts
  for each row execute function authz.itinerary_draft_guard();
create trigger itinerary_difference_runs_a_guard before update or delete on public.itinerary_difference_runs
  for each row execute function authz.itinerary_immutable();
create trigger itinerary_fact_differences_a_guard before update or delete on public.itinerary_fact_differences
  for each row execute function authz.itinerary_difference_guard();
create trigger itinerary_render_jobs_a_guard before update or delete on public.itinerary_render_jobs
  for each row execute function authz.itinerary_job_guard();
create trigger itinerary_rendered_documents_a_guard before update or delete on public.itinerary_rendered_documents
  for each row execute function authz.itinerary_immutable();

do $$
declare
  t text;
begin
  foreach t in array array['itinerary_documents', 'itinerary_source_files', 'itinerary_fact_drafts', 'itinerary_difference_runs',
    'itinerary_fact_differences', 'itinerary_render_jobs', 'itinerary_rendered_documents'] loop
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
    values ('itinerary-sources', 'itinerary-sources', false, 4194304,
      array['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
            'image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update
      set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('rendered-documents', 'rendered-documents', false, 15728640, array['application/pdf'])
    on conflict (id) do update
      set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;

-- ===========================================================================
-- 3. Helpers
-- ===========================================================================

create function authz.itinerary_deal(p_document uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select coalesce(d.deal_id, authz.quotation_deal(d.quotation_id)) from public.itinerary_documents d where d.id = p_document
$$;

create function authz.itinerary_can_edit(p_document uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case when d.quotation_id is not null then authz.quotation_can_edit(d.quotation_id)
                else authz.can_edit_booking_draft(d.deal_id) end
    from public.itinerary_documents d where d.id = p_document), false)
$$;

-- One value against a spec: text:N, date, int:a:b, bool, texts:N:M, ints:a:b:M.
create function authz.itin_value_ok(p_value jsonb, p_spec text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare
  v_parts text[] := string_to_array(p_spec, ':');
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    return true;
  end if;
  case v_parts[1]
    when 'text' then
      return jsonb_typeof(p_value) = 'string' and length(p_value #>> '{}') between 1 and v_parts[2]::integer;
    when 'date' then
      return jsonb_typeof(p_value) = 'string' and (p_value #>> '{}') ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        and authz.sf_date(p_value) is not null;
    when 'int' then
      return authz.sf_int_ok(p_value, v_parts[2]::integer, v_parts[3]::integer, false);
    when 'bool' then
      return jsonb_typeof(p_value) = 'boolean';
    when 'texts' then
      return jsonb_typeof(p_value) = 'array' and jsonb_array_length(p_value) <= v_parts[3]::integer
        and not exists (select 1 from jsonb_array_elements(p_value) e
                        where jsonb_typeof(e) <> 'string' or length(e #>> '{}') not between 1 and v_parts[2]::integer);
    when 'ints' then
      return jsonb_typeof(p_value) = 'array' and jsonb_array_length(p_value) <= v_parts[4]::integer
        and not exists (select 1 from jsonb_array_elements(p_value) e
                        where not authz.sf_int_ok(e, v_parts[2]::integer, v_parts[3]::integer, true));
    else
      return false;
  end case;
end;
$$;

-- Bad paths of an object against a spec {key: 'spec'} or {key: {"max": n, "items": {...}}}
-- or {key: {"object": {...}}}.
create function authz.itin_object_problems(p_object jsonb, p_spec jsonb, p_prefix text) returns text[]
language plpgsql immutable set search_path = '' as $$
declare
  v_bad text[] := '{}'::text[];
  v_key text;
  v_spec jsonb;
  v_path text;
  v_i integer;
  v_item jsonb;
begin
  if p_object is null or jsonb_typeof(p_object) <> 'object' then
    return array[coalesce(nullif(p_prefix, ''), 'facts')];
  end if;
  for v_key in select k from jsonb_object_keys(p_object) k loop
    v_path := case when p_prefix = '' then v_key else p_prefix || '.' || v_key end;
    v_spec := p_spec -> v_key;
    if v_spec is null then
      v_bad := v_bad || v_path;
    elsif jsonb_typeof(v_spec) = 'string' then
      if not authz.itin_value_ok(p_object -> v_key, v_spec #>> '{}') then v_bad := v_bad || v_path; end if;
    elsif v_spec ? 'object' then
      if jsonb_typeof(p_object -> v_key) <> 'null' then
        v_bad := v_bad || authz.itin_object_problems(p_object -> v_key, v_spec -> 'object', v_path);
      end if;
    elsif v_spec ? 'items' then
      if jsonb_typeof(p_object -> v_key) = 'null' then
        continue;
      elsif jsonb_typeof(p_object -> v_key) <> 'array' or jsonb_array_length(p_object -> v_key) > (v_spec ->> 'max')::integer then
        v_bad := v_bad || v_path;
      else
        v_i := 0;
        for v_item in select e from jsonb_array_elements(p_object -> v_key) e loop
          v_i := v_i + 1;
          v_bad := v_bad || authz.itin_object_problems(v_item, v_spec -> 'items', v_path || '[' || v_i::text || ']');
        end loop;
      end if;
    end if;
  end loop;
  return v_bad;
end;
$$;

-- The frozen facts allowlist (no money keys).
create function authz.itinerary_facts_problems(p_facts jsonb) returns text[]
language plpgsql immutable set search_path = '' as $$
declare
  v_bad text[];
  v_key text;
begin
  v_bad := authz.itin_object_problems(p_facts, jsonb_build_object(
    'destination', 'text:200', 'startDate', 'date', 'endDate', 'date',
    'party', jsonb_build_object('object', jsonb_build_object('adults', 'int:0:100', 'children', 'int:0:100',
      'childAges', 'ints:0:17:20', 'infants', 'int:0:100')),
    'stays', jsonb_build_object('max', 30, 'items', jsonb_build_object('city', 'text:120', 'nights', 'int:1:60',
      'checkIn', 'date', 'checkOut', 'date', 'hotelName', 'text:200', 'roomType', 'text:120', 'mealPlan', 'text:60', 'rooms', 'int:1:50')),
    'days', jsonb_build_object('max', 60, 'items', jsonb_build_object('n', 'int:1:60', 'date', 'date', 'base', 'text:120',
      'title', 'text:120', 'story', 'text:2000', 'highlights', 'texts:200:10', 'meals', 'text:60')),
    'transfers', jsonb_build_object('max', 40, 'items', jsonb_build_object('date', 'date', 'from', 'text:200', 'to', 'text:200',
      'mode', 'text:60')),
    'activities', jsonb_build_object('max', 60, 'items', jsonb_build_object('date', 'date', 'city', 'text:120', 'name', 'text:200',
      'included', 'bool')),
    'flights', jsonb_build_object('max', 20, 'items', jsonb_build_object('date', 'date', 'from', 'text:60', 'to', 'text:60',
      'carrier', 'text:60', 'number', 'text:20')),
    'inclusions', 'texts:300:60', 'exclusions', 'texts:300:60',
    -- Narrative keys (no money): cover word, country, category, room basis, introduction and short lists.
    'coverWord', 'text:60', 'country', 'text:80', 'category', 'text:60', 'roomBasis', 'text:120',
    'introduction', 'text:2000', 'reasons', 'texts:200:6', 'handledByUs', 'texts:200:10', 'youBring', 'texts:200:10',
    'provenance', jsonb_build_object('object', '{}'::jsonb)), '');
  -- provenance: free keys (field paths) with a fixed value set.
  if jsonb_typeof(p_facts) = 'object' and p_facts ? 'provenance' and jsonb_typeof(p_facts -> 'provenance') <> 'null' then
    v_bad := array(select b from unnest(v_bad) b where b not like 'provenance.%');
    if jsonb_typeof(p_facts -> 'provenance') <> 'object'
       or (select count(*) from jsonb_object_keys(p_facts -> 'provenance')) > 500 then
      v_bad := v_bad || 'provenance'::text;
    else
      for v_key in select k from jsonb_object_keys(p_facts -> 'provenance') k loop
        if v_key !~ '^[A-Za-z][A-Za-z0-9_.\[\]-]{0,119}$'
           or jsonb_typeof(p_facts -> 'provenance' -> v_key) is distinct from 'string'
           or (p_facts -> 'provenance' ->> v_key) not in ('manual', 'quotation', 'booking') then
          v_bad := v_bad || ('provenance.' || left(v_key, 60));
        end if;
      end loop;
    end if;
  end if;
  return v_bad;
end;
$$;

create function authz.itinerary_facts_hash(p_facts jsonb) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(coalesce(p_facts, '{}'::jsonb)::text, 'UTF8')), 'hex')
$$;

-- What the facts are compared against (freeze 5): {kind, id, hash}.
create function authz.itinerary_basis(p_document uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_doc public.itinerary_documents;
  v_qv public.quotation_versions;
  v_bv public.booking_versions;
  v_quotation uuid;
begin
  select * into v_doc from public.itinerary_documents d where d.id = p_document;
  if v_doc.id is null then
    return null;
  end if;
  v_quotation := v_doc.quotation_id;
  if v_quotation is null then
    select q.id into v_quotation from public.quotations q
    where q.accepted_version_id is not null and (q.deal_id = v_doc.deal_id or q.linked_deal_id = v_doc.deal_id)
    order by q.created_at limit 1;
  end if;
  if v_quotation is not null then
    select * into v_qv from public.quotation_versions v where v.quotation_id = v_quotation and v.status = 'accepted';
    if v_qv.id is null then
      select * into v_qv from public.quotation_versions v
      where v.quotation_id = v_quotation and v.status = 'sent' and authz.quotation_status(v) = 'sent';
    end if;
    if v_qv.id is null and v_doc.quotation_id is not null then
      select * into v_qv from public.quotation_versions v where v.quotation_id = v_quotation and v.status in ('draft', 'ready');
    end if;
    if v_qv.id is not null then
      return jsonb_build_object('kind', 'quotation_version', 'id', v_qv.id,
        'hash', coalesce(v_qv.content_hash, authz.quotation_content_hash(v_qv.id)));
    end if;
  end if;
  if v_doc.deal_id is not null then
    v_bv := authz.deal_current_version(v_doc.deal_id);
    if v_bv.id is not null then
      return jsonb_build_object('kind', 'booking_version', 'id', v_bv.id, 'hash', v_bv.content_hash);
    end if;
  end if;
  return jsonb_build_object('kind', 'none', 'id', null, 'hash', repeat('0', 64));
end;
$$;

-- DEC-48: may the caller read the customer prices of this itinerary? Quotation
-- documents: the quotation money readers; Deal documents: commercial readers.
create function authz.itinerary_money_reader(p_document uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((
    select case when d.quotation_id is not null then authz.quotation_money_can_read(d.quotation_id)
                else authz.can_read_deal_commercial(d.deal_id) end
    from public.itinerary_documents d where d.id = p_document), false)
$$;

-- DEC-48: the selling side of the basis (never cost or margin): the quotation
-- version's customer money (Mercury) with its accepted tier, or the booking
-- version's selling total and payment plan. Null without a priced basis.
create function authz.itinerary_money_json(p_basis jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case p_basis ->> 'kind'
    when 'quotation_version' then (
      select jsonb_build_object('source', 'quotation_version', 'versionId', v.id, 'acceptedTier', v.accepted_tier)
        || coalesce(authz.quotation_customer_money_json(v.id), '{}'::jsonb)
      from public.quotation_versions v where v.id = (p_basis ->> 'id')::uuid)
    when 'booking_version' then (
      select jsonb_build_object('source', 'booking_version', 'versionId', b.id,
        'sellingTotalPaise', (select c.selling_total_paise::text from public.booking_version_commercials c where c.version_id = b.id),
        'plan', coalesce((select jsonb_agg(jsonb_build_object('seq', p.seq, 'label', p.label, 'amountPaise', p.amount_paise::text,
                            'dueDate', to_char(p.due_date, 'YYYY-MM-DD')) order by p.seq)
                          from public.booking_version_instalments p where p.booking_version_id = b.id), '[]'::jsonb))
      from public.booking_versions b where b.id = (p_basis ->> 'id')::uuid)
    end
$$;

-- Locks the document (and its Deal) for a command; rights; removed Deal.
create function authz.lock_itinerary_document(p_document uuid) returns public.itinerary_documents
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_doc public.itinerary_documents%rowtype;
begin
  select * into v_doc from public.itinerary_documents d where d.id = p_document for share;
  perform authz.refuse_removed_deal(authz.itinerary_deal(v_doc.id));
  if v_doc.id is null or not authz.itinerary_can_edit(v_doc.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return v_doc;
end;
$$;

-- The draft's current difference run against the current basis, or null.
create function authz.itinerary_current_run(p_draft uuid) returns public.itinerary_difference_runs
language sql stable security definer set search_path = '' as $$
  select r.* from public.itinerary_difference_runs r
  join public.itinerary_fact_drafts f on f.id = r.draft_id
  where r.draft_id = p_draft and r.facts_hash = f.facts_hash
    and r.basis_hash = (authz.itinerary_basis(f.document_id) ->> 'hash')
$$;

create function authz.itinerary_audit(p_action text, p_document uuid, p_target_type text, p_target uuid, p_details jsonb)
returns void
language sql volatile security definer set search_path = '' as $$
  select authz.write_audit(p_action, d.legal_entity_id, d.branch_id, p_target_type, p_target, null,
    jsonb_build_object('documentId', d.id) || coalesce(p_details, '{}'::jsonb))
  from public.itinerary_documents d where d.id = p_document
$$;

-- ===========================================================================
-- 4. Commands
-- ===========================================================================

create function public.itinerary_document_create(p_subject_kind text, p_subject_id uuid, p_title text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_title text := btrim(coalesce(p_title, ''), E' \t\r\n');
  v_entity uuid;
  v_branch uuid;
  v_doc public.itinerary_documents%rowtype;
  v_draft public.itinerary_fact_drafts%rowtype;
begin
  if p_subject_kind is null or p_subject_kind not in ('quotation', 'deal') or p_subject_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'subjectKind';
  end if;
  if p_subject_kind = 'deal' then
    perform authz.refuse_removed_deal(p_subject_id);
    if not authz.can_edit_booking_draft(p_subject_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    select d.legal_entity_id, d.branch_id into v_entity, v_branch from public.deals d where d.id = p_subject_id;
  else
    perform authz.refuse_removed_deal(authz.quotation_deal(p_subject_id));
    if not authz.quotation_can_edit(p_subject_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    select q.legal_entity_id, q.branch_id into v_entity, v_branch from public.quotations q where q.id = p_subject_id;
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  if length(v_title) not between 1 and 200 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'title';
  end if;
  select * into v_doc from public.itinerary_documents d where d.created_by = (select auth.uid()) and d.request_id = p_request_id;
  if v_doc.id is not null then
    if v_doc.title is distinct from v_title or coalesce(v_doc.quotation_id, v_doc.deal_id) is distinct from p_subject_id then
      raise exception 'request_conflict' using errcode = '40001';
    end if;
    select * into v_draft from public.itinerary_fact_drafts f where f.document_id = v_doc.id;
    return jsonb_build_object('documentId', v_doc.id, 'draftId', v_draft.id, 'rowVersion', v_draft.row_version, 'created', false);
  end if;
  insert into public.itinerary_documents (legal_entity_id, branch_id, quotation_id, deal_id, title, request_id, created_by)
  values (v_entity, v_branch, case when p_subject_kind = 'quotation' then p_subject_id end,
    case when p_subject_kind = 'deal' then p_subject_id end, v_title, p_request_id, (select auth.uid()))
  returning * into v_doc;
  insert into public.itinerary_fact_drafts (document_id, legal_entity_id, facts, facts_hash, created_by, updated_by)
  values (v_doc.id, v_entity, '{}'::jsonb, authz.itinerary_facts_hash('{}'::jsonb), (select auth.uid()), (select auth.uid()))
  returning * into v_draft;
  perform authz.itinerary_audit('itinerary.document_created', v_doc.id, 'itinerary_document', v_doc.id,
    jsonb_build_object('subjectKind', p_subject_kind, 'subjectId', p_subject_id));
  return jsonb_build_object('documentId', v_doc.id, 'draftId', v_draft.id, 'rowVersion', v_draft.row_version, 'created', true);
end;
$$;

create function public.itinerary_source_begin(p_document_id uuid, p_file_name text, p_mime text, p_size_bytes integer, p_sha256 text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_doc public.itinerary_documents%rowtype;
  v_name text := btrim(left(btrim(regexp_replace(coalesce(p_file_name, ''), '[^A-Za-z0-9._ -]', '_', 'g')), 120));
  v_sha text := lower(btrim(coalesce(p_sha256, '')));
  v_id uuid := gen_random_uuid();
  v_path text;
begin
  v_doc := authz.lock_itinerary_document(p_document_id);
  if v_name = '' or v_name ~ '^[. ]+$'
     or p_mime is null or p_mime not in ('application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                                         'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes not between 1 and 4194304
     or v_sha !~ '^[0-9a-f]{64}$'
     or (select count(*) from public.itinerary_source_files s where s.document_id = v_doc.id and s.status in ('pending_upload', 'stored')) >= 10 then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  v_path := v_doc.legal_entity_id::text || '/' || v_doc.id::text || '/' || v_id::text;
  insert into public.itinerary_source_files (id, document_id, legal_entity_id, object_path, file_name, mime, size_bytes, sha256, uploaded_by)
  values (v_id, v_doc.id, v_doc.legal_entity_id, v_path, v_name, p_mime, p_size_bytes, v_sha, (select auth.uid()));
  perform authz.itinerary_audit('itinerary.source_started', v_doc.id, 'itinerary_source_file', v_id,
    jsonb_build_object('fileId', v_id, 'mime', p_mime, 'sizeBytes', p_size_bytes));
  return jsonb_build_object('fileId', v_id, 'objectPath', v_path);
end;
$$;

create function public.itinerary_source_finish(p_file_id uuid, p_ok boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_file public.itinerary_source_files%rowtype;
  v_status text;
  v_missing boolean := false;
begin
  perform authz.lock_itinerary_document((select s.document_id from public.itinerary_source_files s where s.id = p_file_id));
  select * into v_file from public.itinerary_source_files s where s.id = p_file_id for update;
  if v_file.id is null or v_file.uploaded_by is distinct from (select auth.uid()) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_ok is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_status := case when p_ok then 'stored' else 'failed' end;
  if v_file.status <> 'pending_upload' then
    if v_file.status = v_status or (p_ok and v_file.status = 'failed') then
      return jsonb_build_object('fileId', v_file.id, 'status', v_file.status);
    end if;
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_ok and (to_regclass('storage.objects') is null or not exists (
       select 1 from storage.objects o
       where o.bucket_id = 'itinerary-sources' and o.name = v_file.object_path
         and (o.metadata ->> 'size') ~ '^[0-9]{1,18}$' and (o.metadata ->> 'size')::bigint = v_file.size_bytes)) then
    v_status := 'failed';
    v_missing := true;
  end if;
  update public.itinerary_source_files s
  set status = v_status, stored_at = case when v_status = 'stored' then now() end, updated_at = now()
  where s.id = v_file.id;
  perform authz.itinerary_audit(case when v_status = 'stored' then 'itinerary.source_stored' else 'itinerary.source_failed' end,
    v_file.document_id, 'itinerary_source_file', v_file.id, jsonb_build_object('fileId', v_file.id, 'objectMissing', v_missing));
  return jsonb_build_object('fileId', v_file.id, 'status', v_status);
end;
$$;

create function public.itinerary_source_remove(p_file_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_file public.itinerary_source_files%rowtype;
begin
  perform authz.lock_itinerary_document((select s.document_id from public.itinerary_source_files s where s.id = p_file_id));
  select * into v_file from public.itinerary_source_files s where s.id = p_file_id for update;
  if v_file.id is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_file.status = 'removed' then
    return jsonb_build_object('fileId', v_file.id, 'status', 'removed');
  end if;
  update public.itinerary_source_files s set status = 'removed', updated_at = now() where s.id = v_file.id;
  perform authz.itinerary_audit('itinerary.source_removed', v_file.document_id, 'itinerary_source_file', v_file.id,
    jsonb_build_object('fileId', v_file.id, 'previousStatus', v_file.status));
  return jsonb_build_object('fileId', v_file.id, 'status', 'removed');
end;
$$;

create function public.itinerary_source_authorize_download(p_file_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_file public.itinerary_source_files%rowtype;
begin
  select * into v_file from public.itinerary_source_files s where s.id = p_file_id;
  perform authz.refuse_removed_deal(authz.itinerary_deal(v_file.document_id));
  if v_file.id is null or not authz.itinerary_can_edit(v_file.document_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_file.status <> 'stored' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.itinerary_audit('itinerary.source_viewed', v_file.document_id, 'itinerary_source_file', v_file.id,
    jsonb_build_object('fileId', v_file.id));
  return jsonb_build_object('objectPath', v_file.object_path, 'fileName', v_file.file_name, 'mime', v_file.mime);
end;
$$;

-- Full replace of the facts; a ready draft goes back to draft.
create function public.itinerary_facts_save(p_draft_id uuid, p_expected_row_version integer, p_facts jsonb, p_source_file_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_draft public.itinerary_fact_drafts%rowtype;
  v_bad text[];
  v_hash text;
begin
  perform authz.lock_itinerary_document((select f.document_id from public.itinerary_fact_drafts f where f.id = p_draft_id));
  select * into v_draft from public.itinerary_fact_drafts f where f.id = p_draft_id for update;
  perform authz.require_row_version(p_expected_row_version, v_draft.row_version);
  v_bad := authz.itinerary_facts_problems(p_facts);
  if cardinality(v_bad) > 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = left(array_to_string(v_bad, ','), 500);
  end if;
  if p_source_file_id is not null and not exists (
       select 1 from public.itinerary_source_files s
       where s.id = p_source_file_id and s.document_id = v_draft.document_id and s.status = 'stored') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'sourceFileId';
  end if;
  v_hash := authz.itinerary_facts_hash(p_facts);
  update public.itinerary_fact_drafts f
  set facts = p_facts, facts_hash = v_hash, source_file_id = p_source_file_id, status = 'draft', ready_run_id = null,
      row_version = f.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
  where f.id = v_draft.id returning * into v_draft;
  perform authz.itinerary_audit('itinerary.facts_saved', v_draft.document_id, 'itinerary_document', v_draft.document_id,
    jsonb_build_object('draftId', v_draft.id, 'factsHash', v_hash, 'rowVersion', v_draft.row_version));
  return jsonb_build_object('rowVersion', v_draft.row_version, 'factsHash', v_hash, 'status', 'draft');
end;
$$;

create function public.itinerary_differences_save(p_draft_id uuid, p_expected_row_version integer, p_basis_kind text,
  p_basis_id uuid, p_basis_hash text, p_differences jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_draft public.itinerary_fact_drafts%rowtype;
  v_basis jsonb;
  v_run public.itinerary_difference_runs%rowtype;
  v_previous uuid;
  v_row jsonb;
  v_n integer := 0;
  v_seen text[] := '{}'::text[];
  v_open integer;
begin
  perform authz.lock_itinerary_document((select f.document_id from public.itinerary_fact_drafts f where f.id = p_draft_id));
  select * into v_draft from public.itinerary_fact_drafts f where f.id = p_draft_id for update;
  perform authz.require_row_version(p_expected_row_version, v_draft.row_version);
  v_basis := authz.itinerary_basis(v_draft.document_id);
  if p_basis_kind is distinct from (v_basis ->> 'kind') or p_basis_id is distinct from (v_basis ->> 'id')::uuid
     or p_basis_hash is distinct from (v_basis ->> 'hash') then
    raise exception 'basis_changed' using errcode = '40001';
  end if;
  if p_differences is null or jsonb_typeof(p_differences) <> 'array' or jsonb_array_length(p_differences) > 500 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'differences';
  end if;
  for v_row in select e from jsonb_array_elements(p_differences) e loop
    v_n := v_n + 1;
    if jsonb_typeof(v_row) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_row) k where k not in ('path', 'kind', 'factsValueHash', 'basisValueHash'))
       or (v_row ? 'factsValueHash' and jsonb_typeof(v_row -> 'factsValueHash') <> 'null'
           and coalesce(v_row ->> 'factsValueHash', '') !~ '^[0-9a-f]{32,64}$')
       or (v_row ? 'basisValueHash' and jsonb_typeof(v_row -> 'basisValueHash') <> 'null'
           and coalesce(v_row ->> 'basisValueHash', '') !~ '^[0-9a-f]{32,64}$')
       or jsonb_typeof(v_row -> 'path') is distinct from 'string'
       or (v_row ->> 'path') !~ '^[A-Za-z][A-Za-z0-9_.\[\]-]{0,119}$'
       or (v_row ->> 'kind') is null or (v_row ->> 'kind') not in ('missing', 'different', 'extra')
       or ((v_row ->> 'path') || '|' || (v_row ->> 'kind')) = any (v_seen) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'differences[' || v_n::text || ']';
    end if;
    v_seen := v_seen || ((v_row ->> 'path') || '|' || (v_row ->> 'kind'));
  end loop;

  select * into v_run from public.itinerary_difference_runs r
  where r.draft_id = v_draft.id and r.facts_hash = v_draft.facts_hash and r.basis_hash = p_basis_hash;
  if v_run.id is not null then
    if (select coalesce(array_agg(d.field_path || '|' || d.difference order by 1), '{}'::text[])
        from public.itinerary_fact_differences d where d.run_id = v_run.id)
       is distinct from (select coalesce(array_agg(s order by s), '{}'::text[]) from unnest(v_seen) s) then
      raise exception 'request_conflict' using errcode = '40001';
    end if;
    select count(*) into v_open from public.itinerary_fact_differences d where d.run_id = v_run.id and d.acknowledged_at is null;
    return jsonb_build_object('runId', v_run.id, 'differenceCount', v_run.difference_count, 'openCount', v_open, 'outcome', 'existing');
  end if;

  -- The latest earlier run against the same basis (its acknowledgements carry over).
  select r.id into v_previous from public.itinerary_difference_runs r
  where r.draft_id = v_draft.id and r.basis_hash = p_basis_hash order by r.created_at desc, r.id desc limit 1;
  insert into public.itinerary_difference_runs (draft_id, legal_entity_id, facts_hash, basis_kind, basis_id, basis_hash,
    difference_count, created_by)
  values (v_draft.id, v_draft.legal_entity_id, v_draft.facts_hash, p_basis_kind, p_basis_id, p_basis_hash, v_n, (select auth.uid()))
  returning * into v_run;
  -- Review E3-9: an acknowledgement carries over only when both sides' value hashes are given and unchanged.
  insert into public.itinerary_fact_differences (run_id, legal_entity_id, field_path, difference, facts_value_hash, basis_value_hash,
    acknowledged_by, acknowledged_at, note)
  select v_run.id, v_draft.legal_entity_id, e ->> 'path', e ->> 'kind', e ->> 'factsValueHash', e ->> 'basisValueHash',
    p.acknowledged_by, p.acknowledged_at, p.note
  from jsonb_array_elements(p_differences) e
  left join public.itinerary_fact_differences p
    on p.run_id = v_previous and p.field_path = e ->> 'path' and p.difference = e ->> 'kind'
   and p.facts_value_hash is not null and p.basis_value_hash is not null
   and p.facts_value_hash = e ->> 'factsValueHash' and p.basis_value_hash = e ->> 'basisValueHash';
  select count(*) into v_open from public.itinerary_fact_differences d where d.run_id = v_run.id and d.acknowledged_at is null;
  perform authz.itinerary_audit('itinerary.differences_saved', v_draft.document_id, 'itinerary_document', v_draft.document_id,
    jsonb_build_object('runId', v_run.id, 'count', v_n, 'open', v_open, 'basisKind', p_basis_kind));
  return jsonb_build_object('runId', v_run.id, 'differenceCount', v_n, 'openCount', v_open, 'outcome', 'created');
end;
$$;

create function public.itinerary_difference_acknowledge(p_difference_id uuid, p_note text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_diff public.itinerary_fact_differences%rowtype;
  v_doc uuid;
  v_note text := nullif(btrim(coalesce(p_note, ''), E' \t\r\n'), '');
begin
  select f.document_id into v_doc from public.itinerary_fact_differences d
  join public.itinerary_difference_runs r on r.id = d.run_id
  join public.itinerary_fact_drafts f on f.id = r.draft_id where d.id = p_difference_id;
  perform authz.lock_itinerary_document(v_doc);
  select * into v_diff from public.itinerary_fact_differences d where d.id = p_difference_id for update;
  if v_diff.id is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_diff.acknowledged_at is not null then
    return jsonb_build_object('differenceId', v_diff.id, 'acknowledged', true);
  end if;
  if v_note is not null and length(v_note) > 500 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'note';
  end if;
  update public.itinerary_fact_differences d
  set acknowledged_by = (select auth.uid()), acknowledged_at = now(), note = v_note where d.id = v_diff.id;
  perform authz.itinerary_audit('itinerary.difference_acknowledged', v_doc, 'itinerary_document', v_doc,
    jsonb_build_object('differenceId', v_diff.id, 'path', v_diff.field_path, 'kind', v_diff.difference, 'withNote', v_note is not null));
  return jsonb_build_object('differenceId', v_diff.id, 'acknowledged', true);
end;
$$;

create function public.itinerary_facts_mark_ready(p_draft_id uuid, p_expected_row_version integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_draft public.itinerary_fact_drafts%rowtype;
  v_run public.itinerary_difference_runs;
  v_issues text[];
begin
  perform authz.lock_itinerary_document((select f.document_id from public.itinerary_fact_drafts f where f.id = p_draft_id));
  select * into v_draft from public.itinerary_fact_drafts f where f.id = p_draft_id for update;
  perform authz.require_row_version(p_expected_row_version, v_draft.row_version);
  v_issues := array_remove(array[
    case when coalesce(v_draft.facts ->> 'destination', '') = '' then 'destination_missing' end,
    case when v_draft.facts ->> 'startDate' is null or v_draft.facts ->> 'endDate' is null then 'dates_missing' end,
    case when jsonb_typeof(v_draft.facts -> 'days') is distinct from 'array' or jsonb_array_length(v_draft.facts -> 'days') = 0
      then 'days_missing' end], null);
  if cardinality(v_issues) > 0 then
    raise exception 'not_ready' using errcode = '55000', hint = array_to_string(v_issues, ',');
  end if;
  v_run := authz.itinerary_current_run(v_draft.id);
  if v_run.id is null then
    raise exception 'differences_not_checked' using errcode = '55000';
  end if;
  if exists (select 1 from public.itinerary_fact_differences d where d.run_id = v_run.id and d.acknowledged_at is null) then
    raise exception 'differences_open' using errcode = '55000';
  end if;
  update public.itinerary_fact_drafts f
  set status = 'ready', ready_run_id = v_run.id, row_version = f.row_version + 1, updated_by = (select auth.uid()), updated_at = now()
  where f.id = v_draft.id returning * into v_draft;
  perform authz.itinerary_audit('itinerary.marked_ready', v_draft.document_id, 'itinerary_document', v_draft.document_id,
    jsonb_build_object('draftId', v_draft.id, 'runId', v_run.id, 'rowVersion', v_draft.row_version));
  return jsonb_build_object('status', 'ready', 'rowVersion', v_draft.row_version);
end;
$$;

create function public.itinerary_render_request(p_document_id uuid, p_kind text, p_input_hash text, p_template_version text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_doc public.itinerary_documents%rowtype;
  v_draft public.itinerary_fact_drafts%rowtype;
  v_run public.itinerary_difference_runs;
  v_job public.itinerary_render_jobs%rowtype;
  v_basis text;
begin
  v_doc := authz.lock_itinerary_document(p_document_id);
  if p_kind is null or p_kind not in ('preview', 'final') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  if p_input_hash is null or p_input_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'inputHash';
  end if;
  if p_template_version is null or p_template_version !~ '^[a-z0-9._-]{1,40}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'templateVersion';
  end if;
  select * into v_draft from public.itinerary_fact_drafts f where f.document_id = v_doc.id;
  v_basis := authz.itinerary_basis(v_doc.id) ->> 'hash';
  if p_kind = 'final' then
    if v_draft.status <> 'ready' then
      raise exception 'not_ready' using errcode = '55000', hint = 'draft';
    end if;
    v_run := authz.itinerary_current_run(v_draft.id);
    if v_run.id is null or v_run.id <> v_draft.ready_run_id then
      raise exception 'differences_not_checked' using errcode = '55000';
    end if;
  end if;
  select * into v_job from public.itinerary_render_jobs j
  where j.document_id = v_doc.id and j.kind = p_kind and j.input_hash = p_input_hash and j.status in ('queued', 'running', 'succeeded');
  if v_job.id is not null then
    return jsonb_build_object('jobId', v_job.id, 'status', v_job.status, 'outcome', 'existing');
  end if;
  begin
    insert into public.itinerary_render_jobs (document_id, legal_entity_id, kind, input_hash, template_version, facts_hash, basis_hash,
      include_money, requested_by)
    values (v_doc.id, v_doc.legal_entity_id, p_kind, p_input_hash, p_template_version, v_draft.facts_hash, v_basis,
      authz.itinerary_money_reader(v_doc.id), (select auth.uid()))
    returning * into v_job;
  exception when unique_violation then
    -- Review E3-11: a concurrent request with the same input won; answer with its job.
    select * into v_job from public.itinerary_render_jobs j
    where j.document_id = v_doc.id and j.kind = p_kind and j.input_hash = p_input_hash and j.status in ('queued', 'running', 'succeeded');
    return jsonb_build_object('jobId', v_job.id, 'status', v_job.status, 'outcome', 'existing');
  end;
  perform authz.itinerary_audit('itinerary.render_requested', v_doc.id, 'itinerary_render_job', v_job.id,
    jsonb_build_object('jobId', v_job.id, 'kind', p_kind));
  return jsonb_build_object('jobId', v_job.id, 'status', 'queued', 'outcome', 'created');
end;
$$;

-- Worker (service_role only): the oldest queued job, or a running job whose lease expired.
create function public.itinerary_render_claim(p_worker text, p_lease_seconds integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.itinerary_render_jobs%rowtype;
begin
  if p_worker is null or length(p_worker) not between 1 and 60 or p_lease_seconds is null or p_lease_seconds not between 10 and 600 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'worker';
  end if;
  -- Review E3-8: a running job whose lease expired on its last attempt fails
  -- (lease_expired), which frees its input hash for a new request.
  for v_job in
    update public.itinerary_render_jobs j
    set status = 'failed', last_error_code = 'lease_expired', lease_owner = null, lease_until = null, finished_at = now()
    where j.status = 'running' and j.lease_until < now() and j.attempts >= j.max_attempts
    returning *
  loop
    perform authz.itinerary_audit('itinerary.render_failed', v_job.document_id, 'itinerary_render_job', v_job.id,
      jsonb_build_object('jobId', v_job.id, 'errorCode', 'lease_expired', 'attempt', v_job.attempts, 'final', true));
  end loop;
  v_job := null;
  select * into v_job from public.itinerary_render_jobs j
  where ((j.status = 'queued' and j.available_at <= now()) or (j.status = 'running' and j.lease_until < now()))
    and j.attempts < j.max_attempts
  order by j.available_at, j.created_at
  for update skip locked
  limit 1;
  if v_job.id is null then
    return null;
  end if;
  update public.itinerary_render_jobs j
  set status = 'running', attempts = j.attempts + 1, lease_owner = p_worker,
      lease_until = now() + make_interval(secs => p_lease_seconds), started_at = coalesce(j.started_at, now())
  where j.id = v_job.id returning * into v_job;
  perform authz.itinerary_audit('itinerary.render_claimed', v_job.document_id, 'itinerary_render_job', v_job.id,
    jsonb_build_object('jobId', v_job.id, 'attempt', v_job.attempts));
  return jsonb_build_object('jobId', v_job.id, 'documentId', v_job.document_id, 'kind', v_job.kind, 'inputHash', v_job.input_hash,
    'templateVersion', v_job.template_version, 'factsHash', v_job.facts_hash, 'attempts', v_job.attempts,
    -- Where render_complete expects the PDF (bucket rendered-documents).
    'legalEntityId', v_job.legal_entity_id,
    'objectPath', v_job.legal_entity_id::text || '/' || v_job.document_id::text || '/' || v_job.id::text || '.pdf');
end;
$$;

create function public.itinerary_render_complete(p_job_id uuid, p_worker text, p_ok boolean, p_error_code text, p_file jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.itinerary_render_jobs%rowtype;
  v_path text;
  v_size bigint;
  v_qa jsonb;
  v_blocked boolean;
  v_rendered uuid;
  v_code text := p_error_code;
begin
  select * into v_job from public.itinerary_render_jobs j where j.id = p_job_id for update;
  if v_job.id is null or v_job.status <> 'running' or v_job.lease_owner is distinct from p_worker then
    raise exception 'task_conflict' using errcode = '40001';
  end if;
  if p_ok is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'ok';
  end if;
  if p_ok and authz.itinerary_fail_changed_final(v_job) then
    return jsonb_build_object('jobId', v_job.id, 'status', 'failed', 'renderedId', null, 'errorCode', 'input_changed');
  end if;
  if p_ok then
    v_path := v_job.legal_entity_id::text || '/' || v_job.document_id::text || '/' || v_job.id::text || '.pdf';
    v_qa := p_file -> 'qa';
    if p_file is null or jsonb_typeof(p_file) <> 'object' or (p_file ->> 'objectPath') is distinct from v_path
       or coalesce(p_file ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
       or not authz.sf_int_ok(p_file -> 'sizeBytes', 1, 15728640, true)
       or not authz.sf_int_ok(p_file -> 'pageCount', 1, 200, true)
       or v_qa is null or jsonb_typeof(v_qa) <> 'object'
       or exists (select 1 from jsonb_object_keys(v_qa) k where k not in ('placeholders', 'layoutIssues', 'safetyHits'))
       or not authz.sf_int_ok(v_qa -> 'placeholders', 0, 1000, true)
       or not authz.itin_value_ok(v_qa -> 'layoutIssues', 'texts:60:100') or jsonb_typeof(v_qa -> 'layoutIssues') is distinct from 'array'
       or not authz.itin_value_ok(v_qa -> 'safetyHits', 'texts:60:100') or jsonb_typeof(v_qa -> 'safetyHits') is distinct from 'array'
       or exists (select 1 from jsonb_array_elements_text(v_qa -> 'layoutIssues') c where c !~ '^[a-z_]{1,60}$')
       or exists (select 1 from jsonb_array_elements_text(v_qa -> 'safetyHits') c where c !~ '^[a-z_]{1,60}$') then
      raise exception 'invalid_input' using errcode = '22023', hint = 'file';
    end if;
    v_size := (p_file ->> 'sizeBytes')::bigint;
    if to_regclass('storage.objects') is null or not exists (
         select 1 from storage.objects o
         where o.bucket_id = 'rendered-documents' and o.name = v_path
           and (o.metadata ->> 'size') ~ '^[0-9]{1,18}$' and (o.metadata ->> 'size')::bigint = v_size) then
      p_ok := false;
      v_code := 'upload_failed';
    else
      v_blocked := v_job.kind = 'final' and ((v_qa ->> 'placeholders')::integer > 0
        or jsonb_array_length(v_qa -> 'layoutIssues') > 0 or jsonb_array_length(v_qa -> 'safetyHits') > 0);
      if v_blocked then
        update public.itinerary_render_jobs j
        set status = 'failed', last_error_code = 'qa_blocked', lease_owner = null, lease_until = null, finished_at = now()
        where j.id = v_job.id;
        perform authz.itinerary_audit('itinerary.render_failed', v_job.document_id, 'itinerary_render_job', v_job.id,
          jsonb_build_object('jobId', v_job.id, 'errorCode', 'qa_blocked'));
        return jsonb_build_object('jobId', v_job.id, 'status', 'failed', 'renderedId', null, 'errorCode', 'qa_blocked');
      end if;
      insert into public.itinerary_rendered_documents (render_job_id, document_id, legal_entity_id, kind, object_path, sha256,
        size_bytes, page_count, qa)
      values (v_job.id, v_job.document_id, v_job.legal_entity_id, v_job.kind, v_path, p_file ->> 'sha256', v_size::integer,
        (p_file ->> 'pageCount')::integer, v_qa)
      returning id into v_rendered;
      update public.itinerary_render_jobs j
      set status = 'succeeded', lease_owner = null, lease_until = null, finished_at = now(), last_error_code = null
      where j.id = v_job.id;
      perform authz.itinerary_audit('itinerary.render_succeeded', v_job.document_id, 'itinerary_render_job', v_job.id,
        jsonb_build_object('jobId', v_job.id, 'renderedId', v_rendered, 'kind', v_job.kind));
      return jsonb_build_object('jobId', v_job.id, 'status', 'succeeded', 'renderedId', v_rendered);
    end if;
  end if;
  if v_code is null or v_code not in ('render_timeout', 'browser_failed', 'asset_missing', 'input_invalid', 'upload_failed',
                                      'internal', 'content_safety', 'layout_overflow', 'placeholders_present', 'text_clipped',
                                      'qa_blocked') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'errorCode';
  end if;
  -- Deterministic failures (the same input fails the same way) end the job at
  -- once; transient ones (upload_failed, internal, render_timeout, browser_failed)
  -- go back to the queue while attempts remain.
  if v_job.attempts < v_job.max_attempts
     and v_code not in ('placeholders_present', 'content_safety', 'input_invalid', 'layout_overflow', 'text_clipped',
                        'qa_blocked', 'asset_missing') then
    update public.itinerary_render_jobs j
    set status = 'queued', last_error_code = v_code, lease_owner = null, lease_until = null,
        available_at = now() + make_interval(secs => 30 * v_job.attempts)
    where j.id = v_job.id;
  else
    update public.itinerary_render_jobs j
    set status = 'failed', last_error_code = v_code, lease_owner = null, lease_until = null, finished_at = now()
    where j.id = v_job.id;
  end if;
  perform authz.itinerary_audit('itinerary.render_failed', v_job.document_id, 'itinerary_render_job', v_job.id,
    jsonb_build_object('jobId', v_job.id, 'errorCode', v_code, 'attempt', v_job.attempts,
      'final', (select j.status from public.itinerary_render_jobs j where j.id = v_job.id) = 'failed'));
  return jsonb_build_object('jobId', v_job.id,
    'status', (select j.status from public.itinerary_render_jobs j where j.id = v_job.id),
    'renderedId', null, 'errorCode', v_code);
end;
$$;

-- Review E3-13 (service_role only): what the worker renders for a job it
-- holds: the facts, the basis and the customer side of the quotation money
-- (Mercury's selling-only JSON; never cost or margin).
-- Review E5-7: a FINAL job whose facts or basis changed since it was requested
-- fails (input_changed) instead of rendering unchecked facts.
create function authz.itinerary_fail_changed_final(p_job public.itinerary_render_jobs) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_job.kind <> 'final' or (
       (select f.facts_hash from public.itinerary_fact_drafts f where f.document_id = p_job.document_id) = p_job.facts_hash
       and (authz.itinerary_basis(p_job.document_id) ->> 'hash') = p_job.basis_hash) then
    return false;
  end if;
  update public.itinerary_render_jobs j
  set status = 'failed', last_error_code = 'input_changed', lease_owner = null, lease_until = null, finished_at = now()
  where j.id = p_job.id;
  perform authz.itinerary_audit('itinerary.render_failed', p_job.document_id, 'itinerary_render_job', p_job.id,
    jsonb_build_object('jobId', p_job.id, 'errorCode', 'input_changed', 'final', true));
  return true;
end;
$$;

create function public.itinerary_render_input(p_job_id uuid, p_worker text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.itinerary_render_jobs;
  v_draft public.itinerary_fact_drafts;
  v_basis jsonb;
begin
  select * into v_job from public.itinerary_render_jobs j where j.id = p_job_id for update;
  if v_job.id is null or v_job.status <> 'running' or v_job.lease_owner is distinct from p_worker or v_job.lease_until < now() then
    raise exception 'task_conflict' using errcode = '40001';
  end if;
  if authz.itinerary_fail_changed_final(v_job) then
    return jsonb_build_object('jobId', v_job.id, 'status', 'failed', 'errorCode', 'input_changed');
  end if;
  select * into v_draft from public.itinerary_fact_drafts f where f.document_id = v_job.document_id;
  v_basis := authz.itinerary_basis(v_job.document_id);
  return jsonb_build_object('jobId', v_job.id, 'status', 'running', 'documentId', v_job.document_id, 'kind', v_job.kind,
    'templateVersion', v_job.template_version, 'inputHash', v_job.input_hash,
    'factsHash', v_draft.facts_hash, 'factsChanged', v_draft.facts_hash <> v_job.facts_hash,
    'basisChanged', (v_basis ->> 'hash') <> v_job.basis_hash,
    'facts', v_draft.facts,
    'title', (select d.title from public.itinerary_documents d where d.id = v_job.document_id),
    'basis', v_basis,
    -- DEC-48: customer prices only when the requester could read them.
    'money', case when v_job.include_money then authz.itinerary_money_json(v_basis) end);
end;
$$;

create function public.itinerary_rendered_authorize_download(p_rendered_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_doc public.itinerary_rendered_documents%rowtype;
begin
  select * into v_doc from public.itinerary_rendered_documents r where r.id = p_rendered_id;
  perform authz.refuse_removed_deal(authz.itinerary_deal(v_doc.document_id));
  if v_doc.id is null or not authz.itinerary_can_edit(v_doc.document_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.itinerary_audit('itinerary.rendered_viewed', v_doc.document_id, 'itinerary_rendered_document', v_doc.id,
    jsonb_build_object('renderedId', v_doc.id, 'kind', v_doc.kind));
  return jsonb_build_object('objectPath', v_doc.object_path, 'mime', 'application/pdf',
    'fileName', 'itinerary-' || v_doc.kind || '-' || to_char(v_doc.created_at at time zone 'Asia/Kolkata', 'YYYYMMDD') || '.pdf');
end;
$$;

-- ===========================================================================
-- 5. Reads
-- ===========================================================================

create function public.itinerary_document_list(p_subject_kind text, p_subject_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_subject_id is null or p_subject_kind is null or p_subject_kind not in ('quotation', 'deal')
     or (p_subject_kind = 'deal' and not authz.can_edit_booking_draft(p_subject_id))
     or (p_subject_kind = 'quotation' and not authz.quotation_can_edit(p_subject_id))
     -- Review E3-12: nothing for a Deal removed by the sync.
     or exists (select 1 from public.deals d where d.removed_at is not null
                and d.id = case when p_subject_kind = 'deal' then p_subject_id else authz.quotation_deal(p_subject_id) end) then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('documentId', d.id, 'title', d.title,
        'subjectKind', case when d.quotation_id is not null then 'quotation' else 'deal' end,
        'draftStatus', f.status, 'factsHash', f.facts_hash, 'createdAt', d.created_at,
        'latestFinal', (select jsonb_build_object('renderedId', r.id, 'createdAt', r.created_at)
                        from public.itinerary_rendered_documents r where r.document_id = d.id and r.kind = 'final'
                        order by r.created_at desc limit 1)) order by d.created_at desc, d.id)
    from public.itinerary_documents d
    join public.itinerary_fact_drafts f on f.document_id = d.id
    where (p_subject_kind = 'quotation' and d.quotation_id = p_subject_id)
       or (p_subject_kind = 'deal' and d.deal_id = p_subject_id)), '[]'::jsonb);
end;
$$;

create function public.itinerary_document_get(p_document_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_doc public.itinerary_documents;
  v_draft public.itinerary_fact_drafts;
  v_run public.itinerary_difference_runs;
  v_latest public.itinerary_difference_runs;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_doc from public.itinerary_documents d where d.id = p_document_id;
  if v_doc.id is null or not authz.itinerary_can_edit(v_doc.id)
     or exists (select 1 from public.deals d where d.id = authz.itinerary_deal(v_doc.id) and d.removed_at is not null) then
    return null;
  end if;
  select * into v_draft from public.itinerary_fact_drafts f where f.document_id = v_doc.id;
  v_run := authz.itinerary_current_run(v_draft.id);
  select * into v_latest from public.itinerary_difference_runs r where r.draft_id = v_draft.id
  order by r.created_at desc, r.id desc limit 1;
  return jsonb_build_object(
    'documentId', v_doc.id, 'title', v_doc.title,
    'subject', jsonb_build_object('kind', case when v_doc.quotation_id is not null then 'quotation' else 'deal' end,
      'quotationId', v_doc.quotation_id, 'dealId', coalesce(v_doc.deal_id, authz.quotation_deal(v_doc.quotation_id))),
    'draft', jsonb_build_object('draftId', v_draft.id, 'status', v_draft.status, 'rowVersion', v_draft.row_version,
      'facts', v_draft.facts, 'factsHash', v_draft.facts_hash, 'sourceFileId', v_draft.source_file_id, 'updatedAt', v_draft.updated_at),
    'basis', authz.itinerary_basis(v_doc.id),
    -- DEC-48: the customer prices printed on the itinerary, for callers who may read them.
    'money', case when authz.itinerary_money_reader(v_doc.id) then authz.itinerary_money_json(authz.itinerary_basis(v_doc.id)) end,
    'differences', jsonb_build_object('runId', coalesce(v_run.id, v_latest.id), 'current', v_run.id is not null,
      'items', coalesce((select jsonb_agg(jsonb_build_object('differenceId', d.id, 'path', d.field_path, 'kind', d.difference,
                'acknowledged', d.acknowledged_at is not null,
                'acknowledgedByName', (select p.display_name from public.staff_profiles p where p.user_id = d.acknowledged_by),
                'acknowledgedAt', d.acknowledged_at, 'note', d.note) order by d.field_path, d.difference)
              from public.itinerary_fact_differences d where d.run_id = coalesce(v_run.id, v_latest.id)), '[]'::jsonb)),
    'sources', coalesce((select jsonb_agg(jsonb_build_object('fileId', s.id, 'fileName', s.file_name, 'mime', s.mime,
                'sizeBytes', s.size_bytes, 'status', s.status, 'createdAt', s.created_at) order by s.created_at, s.id)
              from public.itinerary_source_files s where s.document_id = v_doc.id and s.status <> 'removed'), '[]'::jsonb),
    'jobs', coalesce((select jsonb_agg(x.j order by x.created_at desc) from (
                select jsonb_build_object('jobId', j.id, 'kind', j.kind, 'status', j.status, 'attempts', j.attempts,
                  'lastErrorCode', j.last_error_code, 'createdAt', j.created_at, 'finishedAt', j.finished_at) as j, j.created_at
                from public.itinerary_render_jobs j where j.document_id = v_doc.id order by j.created_at desc limit 20) x), '[]'::jsonb),
    'rendered', coalesce((select jsonb_agg(jsonb_build_object('renderedId', r.id, 'kind', r.kind, 'pageCount', r.page_count,
                'sizeBytes', r.size_bytes, 'createdAt', r.created_at, 'qa', r.qa) order by r.created_at desc)
              from public.itinerary_rendered_documents r where r.document_id = v_doc.id), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- 6. Grants
-- ===========================================================================

revoke all on function
  authz.itinerary_immutable(), authz.itinerary_source_guard(), authz.itinerary_draft_guard(),
  authz.itinerary_difference_guard(), authz.itinerary_job_guard(), authz.itinerary_deal(uuid), authz.itinerary_can_edit(uuid), authz.itin_value_ok(jsonb, text),
  authz.itin_object_problems(jsonb, jsonb, text), authz.itinerary_facts_problems(jsonb), authz.itinerary_facts_hash(jsonb),
  authz.itinerary_basis(uuid), authz.lock_itinerary_document(uuid), authz.itinerary_current_run(uuid),
  authz.itinerary_fail_changed_final(public.itinerary_render_jobs),
  authz.itinerary_money_reader(uuid), authz.itinerary_money_json(jsonb),
  authz.itinerary_audit(text, uuid, text, uuid, jsonb)
from public, anon, authenticated, service_role;

revoke all on function
  public.itinerary_document_create(text, uuid, text, uuid),
  public.itinerary_source_begin(uuid, text, text, integer, text),
  public.itinerary_source_finish(uuid, boolean),
  public.itinerary_source_remove(uuid),
  public.itinerary_source_authorize_download(uuid),
  public.itinerary_facts_save(uuid, integer, jsonb, uuid),
  public.itinerary_differences_save(uuid, integer, text, uuid, text, jsonb),
  public.itinerary_difference_acknowledge(uuid, text),
  public.itinerary_facts_mark_ready(uuid, integer),
  public.itinerary_render_request(uuid, text, text, text),
  public.itinerary_render_claim(text, integer),
  public.itinerary_render_complete(uuid, text, boolean, text, jsonb),
  public.itinerary_render_input(uuid, text),
  public.itinerary_rendered_authorize_download(uuid),
  public.itinerary_document_list(text, uuid),
  public.itinerary_document_get(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.itinerary_document_create(text, uuid, text, uuid),
  public.itinerary_source_begin(uuid, text, text, integer, text),
  public.itinerary_source_finish(uuid, boolean),
  public.itinerary_source_remove(uuid),
  public.itinerary_source_authorize_download(uuid),
  public.itinerary_facts_save(uuid, integer, jsonb, uuid),
  public.itinerary_differences_save(uuid, integer, text, uuid, text, jsonb),
  public.itinerary_difference_acknowledge(uuid, text),
  public.itinerary_facts_mark_ready(uuid, integer),
  public.itinerary_render_request(uuid, text, text, text),
  public.itinerary_rendered_authorize_download(uuid),
  public.itinerary_document_list(text, uuid),
  public.itinerary_document_get(uuid)
to authenticated;

-- Worker commands: the server's privileged client only (after an authorized render request).
grant execute on function
  public.itinerary_render_claim(text, integer),
  public.itinerary_render_complete(uuid, text, boolean, text, jsonb),
  public.itinerary_render_input(uuid, text)
to service_role;

commit;
