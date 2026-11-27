-- Accounts phase 2, Track B (1 of 4): customer documents schema.
-- Contract: implementation/accounts-phase2-2026-11-11/contract.md sections
-- 4 (deal service class, document number prefix), 6.1, 6.2, 6.3, 6.5 (SQL
-- mirror of the company identity), LD1, LD2, LD4, Addenda L4 and L5
-- (frozen 11 Nov 2026).
--
-- Adds (no table grant; RLS on with the restrictive session policy; every
-- read and write goes through the security definer functions of
-- 20261204000210..0230):
--   * accounts_settings.customer_documents_enabled (setter B9) and
--     accounts_settings.refunds_enabled (setter C12, Track C), both default
--     false; authz.accounts_settings_audit replaced so its column list covers
--     all four switches.
--   * customer_documents (Advance Invoice, Invoice, Credit Note), with a
--     guard: no DELETE; draft -> released | discarded; released -> replaced |
--     cancelled; frozen content once released; tally_invoice_id changes while
--     draft and only null -> value after release (LD18).
--   * customer_document_counters (one per Deal and kind, locked at release).
--   * customer_document_render_jobs and customer_document_files (pattern of
--     itinerary_render_jobs / itinerary_rendered_documents; private bucket
--     rendered-documents, path <entity>/customer-documents/<document>/<job>.pdf).
--   * authz.deal_service_class(p_version uuid) (contract section 4; L4: B
--     creates it here, C and D call it).
--   * authz.cdoc_prefix(p_deal uuid): Bitrix Deal id, else the CRM Deal reference.
--   * authz.cdoc_company(p_entity, p_branch): SQL mirror of
--     src/modules/documents/company-identity.ts (one company GSTIN for every
--     known branch, Q2/LD1); a unit test keeps both equal.
--   * authz.cdoc_credit_note_source(p_refund_request uuid) returns jsonb:
--     STUB returning null (credit note drafts refused not_ready). Track C
--     replaces it (contract 7.6).
--
-- Deviation (needed for B6 replacement of an Advance Invoice, reported to the
-- lead): the one-live-ADV-per-receipt index excludes replacement drafts
-- (replaces_document_id is null); the commands refuse a second ADV for a
-- receipt whenever any live ADV exists, and a replacement is unique per
-- replaced document.
--
-- Refusal tokens: none here (guards raise 42501 with a plain message).
--
-- Rollback (forward-only): a NEW migration restoring
-- authz.accounts_settings_audit from 20261203000200 and revoking the Track B
-- functions; tables and columns stay (never read by older code). Never delete
-- rows.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Switches (6.2)
-- ===========================================================================

alter table public.accounts_settings
  add column customer_documents_enabled boolean not null default false,
  add column refunds_enabled boolean not null default false;

-- Accounts phase 2 (20261204000200): column list covers the two new switches.
create or replace function authz.accounts_settings_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_cols text[] := array[]::text[];
  v_col text;
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
  v_new jsonb := to_jsonb(new);
  v_reason text := left(nullif(btrim(coalesce(current_setting('tripnavigate.change_reason', true), ''), E' \t\r\n'), ''), 500);
  v_command text := left(nullif(btrim(coalesce(current_setting('tripnavigate.change_command', true), ''), E' \t\r\n'), ''), 100);
begin
  foreach v_col in array array['exception_owner_user_id', 'tally_export_enabled',
                               'customer_documents_enabled', 'refunds_enabled'] loop  -- Accounts phase 2 (20261204000200)
    if tg_op = 'INSERT' or (v_old -> v_col) is distinct from (v_new -> v_col) then
      v_cols := v_cols || v_col;
    end if;
  end loop;
  if tg_op = 'UPDATE' and cardinality(v_cols) = 0 then
    return null;
  end if;
  perform authz.write_audit('settings.accounts_changed', new.legal_entity_id, null, 'accounts_settings', new.legal_entity_id,
    v_reason, jsonb_build_object('operation', lower(tg_op), 'columns', to_jsonb(v_cols), 'command', v_command,
      'rowVersion', new.row_version));
  return null;
end;
$$;

-- ===========================================================================
-- 2. customer_documents (6.1)
-- ===========================================================================

create table public.customer_documents (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  deal_id uuid not null,
  kind text not null check (kind in ('advance_invoice', 'invoice', 'credit_note')),
  status text not null default 'draft' check (status in ('draft', 'released', 'replaced', 'cancelled', 'discarded')),
  number text check (number ~ '^.{1,40}-(ADV|INV|CN)-[0-9]{1,4}$'),
  seq integer check (seq between 1 and 9999),
  basis_version_id uuid,
  receipt_id uuid references public.customer_receipts (id),
  -- Credit notes: the refund request (FK added by Track C).
  refund_request_id uuid,
  credits_document_id uuid,
  replaces_document_id uuid,
  tally_invoice_id uuid references public.deal_tally_invoices (id),
  content jsonb not null check (jsonb_typeof(content) = 'object'),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  total_paise bigint not null check (total_paise >= 0),
  warnings text[] not null default array[]::text[]
    check (cardinality(warnings) <= 10 and array_position(warnings, null) is null),
  issue_date date,
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  request_id uuid not null,
  refreshed_at timestamptz,
  released_by uuid references public.staff_profiles (user_id),
  released_at timestamptz,
  release_request_id uuid,
  ended_by uuid references public.staff_profiles (user_id),
  ended_at timestamptz,
  end_reason text check (end_reason is null or length(end_reason) between 10 and 500),
  -- B6: the reason given when the replacement was started (copied to the
  -- replaced document's end_reason at release).
  replace_reason text check (replace_reason is null or length(replace_reason) between 10 and 500),
  row_version integer not null default 1 check (row_version >= 1),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, branch_id, deal_id) references public.deals (legal_entity_id, branch_id, id),
  foreign key (legal_entity_id, deal_id, basis_version_id) references public.booking_versions (legal_entity_id, deal_id, id),
  unique (legal_entity_id, id),
  unique (legal_entity_id, deal_id, id),
  unique (legal_entity_id, number),
  unique (legal_entity_id, request_id),
  check ((status in ('draft', 'discarded')) = (number is null)),
  check ((number is null) = (seq is null)),
  check ((kind = 'advance_invoice') = (receipt_id is not null)),
  check ((kind = 'credit_note') = (refund_request_id is not null)),
  check (kind = 'credit_note' or credits_document_id is null),
  check (kind in ('advance_invoice', 'invoice') or replaces_document_id is null),
  check (replace_reason is null or replaces_document_id is not null),
  check ((status in ('released', 'replaced', 'cancelled'))
    = (released_at is not null and released_by is not null and issue_date is not null and release_request_id is not null)),
  check ((status in ('replaced', 'cancelled', 'discarded'))
    = (ended_at is not null and ended_by is not null and end_reason is not null))
);
alter table public.customer_documents
  add constraint customer_documents_credits_fk foreign key (legal_entity_id, deal_id, credits_document_id)
    references public.customer_documents (legal_entity_id, deal_id, id),
  add constraint customer_documents_replaces_fk foreign key (legal_entity_id, deal_id, replaces_document_id)
    references public.customer_documents (legal_entity_id, deal_id, id);

-- One live Advance Invoice per receipt (replacement drafts excluded; see header).
create unique index customer_documents_one_live_adv on public.customer_documents (receipt_id)
  where kind = 'advance_invoice' and status in ('draft', 'released') and replaces_document_id is null;
-- One live replacement per replaced document.
create unique index customer_documents_one_live_replacement on public.customer_documents (replaces_document_id)
  where status in ('draft', 'released');
-- One Invoice draft per Deal at a time (first draft or replacement).
create unique index customer_documents_one_invoice_draft on public.customer_documents (deal_id)
  where kind = 'invoice' and status = 'draft';
-- One live credit note per refund request.
create unique index customer_documents_one_live_cn on public.customer_documents (refund_request_id)
  where kind = 'credit_note' and status in ('draft', 'released');

create index customer_documents_entity_status_idx on public.customer_documents (legal_entity_id, status, released_at desc, id desc);
create index customer_documents_entity_order_idx on public.customer_documents
  (legal_entity_id, (coalesce(released_at, created_at)) desc, id desc);
create index customer_documents_deal_idx on public.customer_documents (deal_id, kind, status);
create index customer_documents_deal_fk_idx on public.customer_documents (legal_entity_id, branch_id, deal_id);
create index customer_documents_basis_idx on public.customer_documents (legal_entity_id, deal_id, basis_version_id)
  where basis_version_id is not null;
create index customer_documents_receipt_idx on public.customer_documents (receipt_id) where receipt_id is not null;
create index customer_documents_refund_idx on public.customer_documents (refund_request_id) where refund_request_id is not null;
create index customer_documents_credits_idx on public.customer_documents (legal_entity_id, deal_id, credits_document_id)
  where credits_document_id is not null;
create index customer_documents_replaces_idx on public.customer_documents (legal_entity_id, deal_id, replaces_document_id)
  where replaces_document_id is not null;
create index customer_documents_tally_idx on public.customer_documents (tally_invoice_id) where tally_invoice_id is not null;
create index customer_documents_created_by_idx on public.customer_documents (created_by);
create index customer_documents_released_by_idx on public.customer_documents (released_by) where released_by is not null;
create index customer_documents_ended_by_idx on public.customer_documents (ended_by) where ended_by is not null;
comment on table public.customer_documents is
  'Accounts phase 2 (2a): customer Advance Invoice / Invoice / Credit Note (not a Tally voucher). Content frozen at release with its sha256; number taken at release. No table grant.';

create function authz.customer_documents_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_fixed text[] := array['id', 'legal_entity_id', 'branch_id', 'deal_id', 'kind', 'receipt_id', 'refund_request_id',
    'credits_document_id', 'replaces_document_id', 'created_by', 'created_at', 'request_id'];
  v_frozen text[] := array['number', 'seq', 'content', 'content_sha256', 'source_hash', 'total_paise', 'warnings', 'issue_date',
    'basis_version_id', 'released_by', 'released_at', 'release_request_id', 'refreshed_at', 'replace_reason'];
  v_old jsonb := to_jsonb(old);
  v_new jsonb := to_jsonb(new);
  k text;
begin
  if tg_op = 'DELETE' then
    raise exception 'customer documents cannot be deleted' using errcode = '42501';
  end if;
  foreach k in array v_fixed loop
    if (v_old -> k) is distinct from (v_new -> k) then
      raise exception 'customer document identity is immutable' using errcode = '42501';
    end if;
  end loop;
  if new.row_version <> old.row_version + 1 then
    raise exception 'customer document row version must step by one' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'draft' and new.status in ('released', 'discarded'))
       or (old.status = 'released' and new.status in ('replaced', 'cancelled'))) then
    raise exception 'customer document status move not allowed' using errcode = '42501';
  end if;
  if old.status <> 'draft' then
    foreach k in array v_frozen loop
      if (v_old -> k) is distinct from (v_new -> k) then
        raise exception 'released customer document content is immutable' using errcode = '42501';
      end if;
    end loop;
    -- LD18: after release the Tally GST invoice link only goes from none to one, on a released document.
    if new.tally_invoice_id is distinct from old.tally_invoice_id
       and not (old.status = 'released' and new.status = 'released' and old.tally_invoice_id is null and new.tally_invoice_id is not null) then
      raise exception 'released customer document Tally link may only be added once' using errcode = '42501';
    end if;
    if old.status in ('replaced', 'cancelled', 'discarded')
       and (v_new - array['updated_at', 'row_version']) is distinct from (v_old - array['updated_at', 'row_version']) then
      raise exception 'ended customer documents are final' using errcode = '42501';
    end if;
    if old.status = 'released' and new.status = 'released'
       and (v_new - array['updated_at', 'row_version', 'tally_invoice_id']) is distinct from (v_old - array['updated_at', 'row_version', 'tally_invoice_id']) then
      raise exception 'released customer document is immutable' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;
create trigger customer_documents_a_guard before update or delete on public.customer_documents
  for each row execute function authz.customer_documents_guard();

-- ===========================================================================
-- 3. Counters, render jobs, files (6.2)
-- ===========================================================================

create table public.customer_document_counters (
  deal_id uuid not null references public.deals (id),
  kind text not null check (kind in ('advance_invoice', 'invoice', 'credit_note')),
  last_no integer not null default 0 check (last_no between 0 and 9999),
  primary key (deal_id, kind)
);
comment on table public.customer_document_counters is
  'Accounts phase 2: last released document number per Deal and kind (row locked at release). No table grant.';

create function authz.customer_document_counters_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'document counters cannot be deleted' using errcode = '42501';
  end if;
  if new.deal_id is distinct from old.deal_id or new.kind is distinct from old.kind or new.last_no < old.last_no then
    raise exception 'document counters only move forward' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger customer_document_counters_a_guard before update or delete on public.customer_document_counters
  for each row execute function authz.customer_document_counters_guard();

create table public.customer_document_render_jobs (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  document_id uuid not null,
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  template_version text not null check (template_version ~ '^[a-z0-9._-]{1,40}$'),
  status text not null default 'queued' check (status in ('queued', 'running', 'succeeded', 'failed')),
  attempts smallint not null default 0 check (attempts between 0 and 3),
  max_attempts smallint not null default 3 check (max_attempts between 1 and 3),
  available_at timestamptz not null default now(),
  lease_owner text check (length(lease_owner) between 1 and 60),
  lease_until timestamptz,
  last_error_code text check (last_error_code in ('render_timeout', 'browser_failed', 'asset_missing', 'input_invalid',
    'upload_failed', 'internal', 'content_safety', 'layout_overflow', 'placeholders_present', 'qa_blocked', 'lease_expired',
    'input_changed', 'text_clipped', 'content_changed')),
  requested_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  foreign key (legal_entity_id, document_id) references public.customer_documents (legal_entity_id, id),
  unique (legal_entity_id, id),
  check ((status = 'running') = (lease_owner is not null and lease_until is not null)),
  check ((status in ('succeeded', 'failed')) = (finished_at is not null))
);
create unique index customer_document_render_jobs_live on public.customer_document_render_jobs (document_id)
  where status in ('queued', 'running', 'succeeded');
create index customer_document_render_jobs_queue_idx on public.customer_document_render_jobs (available_at, created_at)
  where status in ('queued', 'running');
create index customer_document_render_jobs_document_idx on public.customer_document_render_jobs (document_id, created_at desc);
create index customer_document_render_jobs_entity_idx on public.customer_document_render_jobs (legal_entity_id, document_id);
create index customer_document_render_jobs_requested_by_idx on public.customer_document_render_jobs (requested_by);
comment on table public.customer_document_render_jobs is
  'Accounts phase 2: PDF job of one released customer document (frozen content hash). Worker commands are service_role only. No table grant.';

create function authz.customer_document_render_jobs_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception 'render jobs cannot be deleted' using errcode = '42501';
end;
$$;
create trigger customer_document_render_jobs_a_guard before delete on public.customer_document_render_jobs
  for each row execute function authz.customer_document_render_jobs_guard();

create table public.customer_document_files (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  document_id uuid not null unique,
  render_job_id uuid not null unique,
  object_path text not null unique,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size_bytes integer not null check (size_bytes between 1 and 15728640),
  page_count integer not null check (page_count between 1 and 50),
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, document_id) references public.customer_documents (legal_entity_id, id),
  foreign key (legal_entity_id, render_job_id) references public.customer_document_render_jobs (legal_entity_id, id),
  check (object_path = legal_entity_id::text || '/customer-documents/' || document_id::text || '/' || render_job_id::text || '.pdf')
);
create index customer_document_files_entity_idx on public.customer_document_files (legal_entity_id, document_id);
create index customer_document_files_job_fk_idx on public.customer_document_files (legal_entity_id, render_job_id);
comment on table public.customer_document_files is
  'Accounts phase 2: the stored PDF of a released customer document (private bucket rendered-documents). Append-only. No table grant.';

create trigger customer_document_files_append_only before update or delete on public.customer_document_files
  for each row execute function authz.finance_append_only();

-- ===========================================================================
-- 4. Shared helpers (contract section 4)
-- ===========================================================================

-- Contract section 4 (L4: created here; Tracks C and D call it). The services
-- with facts in the version (cancelled items excluded): all flights ->
-- flight_domestic / flight_international (by trip scope); all visa -> visa;
-- all passport -> passport; all hotel / transfer / activity -> that type;
-- otherwise package_domestic / package_overseas (by trip scope). A legacy
-- single-hotel version (no service items) is hotel. Null for an unknown version.
create function authz.deal_service_class(p_version uuid) returns text
language sql stable security definer set search_path = '' as $$
  with v as (
    select bv.id, bv.service_type, coalesce(bv.trip_scope, 'domestic') as scope
    from public.booking_versions bv where bv.id = p_version
  ), t as (
    select array_agg(distinct i.service_type) as types
    from public.service_item_facts f
    join public.service_items i on i.id = f.service_item_id
    join v on v.id = f.booking_version_id
    where i.state <> 'cancelled'
  )
  select case
    when v.id is null then null
    when t.types is null then case when v.service_type = 'hotel' then 'hotel'
                                   when v.scope = 'international' then 'package_overseas' else 'package_domestic' end
    when t.types = array['flight'] then case when v.scope = 'international' then 'flight_international' else 'flight_domestic' end
    when t.types = array['visa'] then 'visa'
    when t.types = array['passport'] then 'passport'
    when t.types = array['hotel'] then 'hotel'
    when t.types = array['transfer'] then 'transfer'
    when t.types = array['activity'] then 'activity'
    when v.scope = 'international' then 'package_overseas'
    else 'package_domestic'
  end
  from v left join t on true
$$;

-- Document number prefix (contract section 4, Q3): the Bitrix Deal id, else
-- the CRM Deal reference.
create function authz.cdoc_prefix(p_deal uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(d.source_deal_id::text, d.reference) from public.deals d where d.id = p_deal
$$;

-- SQL mirror of src/modules/documents/company-identity.ts (DEC-50 as changed
-- by Q2 / LD1: one company GSTIN for every known branch). A missing or
-- unknown branch prints the "[GSTIN for branch]" placeholder (blocks the PDF).
-- tests/unit/acc2b-company-identity.test.ts keeps both records equal.
create function authz.cdoc_company(p_branch uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'legalName', 'Holiday Chacha Pvt Ltd',
    'registeredAddress', '59A, Babu Rajendra Marg, Masuria Colony, Baldev Nagar, Jodhpur, Rajasthan 342003',
    'pan', 'AAFCH9191M',
    'gstin', case when known then '08AAFCH9191M1ZV' else '[GSTIN for branch]' end,
    'gstinState', case when known then 'Rajasthan' end)
  from (select coalesce((select upper(btrim(b.code)) from public.branches b where b.id = p_branch) in ('JDH', 'DEL', 'AMD'), false) as known) x
$$;

-- Credit-note source (contract 7.6). STUB: Track C replaces this function
-- (same signature). Null = no credit note can be drafted (not_ready).
create function authz.cdoc_credit_note_source(p_refund_request uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  return null;
end;
$$;

-- ===========================================================================
-- 5. Row level security: no permissive policy, no table privilege.
-- ===========================================================================

do $$
declare
  t text;
begin
  foreach t in array array['customer_documents', 'customer_document_counters', 'customer_document_render_jobs',
                           'customer_document_files'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

revoke all on function authz.customer_documents_guard(), authz.customer_document_counters_guard(),
  authz.customer_document_render_jobs_guard(), authz.deal_service_class(uuid), authz.cdoc_prefix(uuid),
  authz.cdoc_company(uuid), authz.cdoc_credit_note_source(uuid)
  from public, anon, authenticated, service_role;

commit;
