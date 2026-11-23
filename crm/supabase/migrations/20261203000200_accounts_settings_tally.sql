-- Accounts phase, Track B (1 of 6): Accounts settings, Tally matching tables,
-- Deal Tally GST invoice references and the review approval memory.
-- Contract: implementation/accounts-phase-2026-11-10/contract.md sections
-- 6.2.1, 6.2.4, 6.2.5, 6.2.6, 6.2.7 (frozen 10 Nov 2026).
--
-- Adds (no table grant; RLS on with the restrictive session policy; every
-- read and write goes through security definer functions of later Track B
-- migrations):
--   * accounts_settings (per entity): exception owner (H4, configurable,
--     never a hard-coded person) and the Tally export switch (off).
--     Audit trigger settings.accounts_changed (changed column names only).
--   * tally_exports, tally_export_counters (TE-YYYY-NNNNNN), tally_records
--     (matching state of one Tally row; a row exists only once something
--     happened), tally_export_lines (snapshot of every exported line, values
--     already masked).
--   * deal_tally_invoices: the Deal's statutory Tally GST invoice reference
--     (DEC-22), unique per entity and financial year while active.
--   * accounts_booking_reviews.last_approved_at / last_approved_by: set by
--     trigger whenever a review becomes approved, never cleared (the dues
--     basis keeps the last Accounts-approved version while a later version
--     is returned or pending). Backfilled from reviewed_at for approved rows
--     and from the latest finance.review_approved audit event for rows that
--     were approved and later returned.
--
-- Refusal tokens: none here (guards raise 42501 with a plain message).
--
-- Rollback (forward-only): a NEW migration dropping the trigger
-- accounts_booking_reviews_approval_memory and the function
-- authz.review_approval_memory(); the new tables and columns stay (they are
-- never read by older code). Never delete rows.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. accounts_settings (6.2.6)
-- ===========================================================================

create table public.accounts_settings (
  legal_entity_id uuid primary key references public.legal_entities (id),
  exception_owner_user_id uuid references public.staff_profiles (user_id),
  tally_export_enabled boolean not null default false,
  updated_by uuid references public.staff_profiles (user_id),
  updated_at timestamptz not null default now(),
  row_version integer not null default 1 check (row_version >= 1),
  created_at timestamptz not null default now()
);
create index accounts_settings_exception_owner_idx on public.accounts_settings (exception_owner_user_id)
  where exception_owner_user_id is not null;
create index accounts_settings_updated_by_idx on public.accounts_settings (updated_by) where updated_by is not null;
comment on table public.accounts_settings is
  'Accounts phase: per-entity Accounts settings (exception owner, Tally export switch). Row created lazily by the audited admin setters. No table grant.';

-- One audit row per real change, whoever writes; details carry the changed
-- column names only (never the values). The reason comes from the admin
-- command through tripnavigate.change_reason (authz.settings_begin_change).
create function authz.accounts_settings_audit() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_cols text[] := array[]::text[];
  v_col text;
  v_old jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) end;
  v_new jsonb := to_jsonb(new);
  v_reason text := left(nullif(btrim(coalesce(current_setting('tripnavigate.change_reason', true), ''), E' \t\r\n'), ''), 500);
  v_command text := left(nullif(btrim(coalesce(current_setting('tripnavigate.change_command', true), ''), E' \t\r\n'), ''), 100);
begin
  foreach v_col in array array['exception_owner_user_id', 'tally_export_enabled'] loop
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

create function authz.accounts_settings_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'accounts settings rows cannot be deleted' using errcode = '42501';
  end if;
  if new.legal_entity_id is distinct from old.legal_entity_id or new.created_at is distinct from old.created_at
     or new.row_version <> old.row_version + 1 then
    raise exception 'accounts settings identity is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger accounts_settings_a_guard before update or delete on public.accounts_settings
  for each row execute function authz.accounts_settings_guard();
create trigger accounts_settings_audit after insert or update on public.accounts_settings
  for each row execute function authz.accounts_settings_audit();
create trigger accounts_settings_no_truncate before truncate on public.accounts_settings
  for each statement execute function authz.refuse_settings_truncate();

-- ===========================================================================
-- 2. Tally exports (6.2.7)
-- ===========================================================================

create table public.tally_export_counters (
  legal_entity_id uuid not null references public.legal_entities (id),
  year integer not null check (year between 2000 and 2100),
  last_no integer not null default 0 check (last_no >= 0),
  primary key (legal_entity_id, year)
);

create table public.tally_exports (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  export_no text not null check (export_no ~ '^TE-[0-9]{4}-[0-9]{6}$'),
  period_from date not null,
  period_to date not null,
  kinds text[] not null check (cardinality(kinds) between 1 and 5 and array_position(kinds, null) is null
    and kinds <@ array['journal_entry', 'supplier_payment', 'supplier_document', 'expense', 'tally_gst_invoice']),
  include_exported boolean not null,
  branch_ids uuid[] check (branch_ids is null or (cardinality(branch_ids) between 1 and 50 and array_position(branch_ids, null) is null)),
  row_count integer not null check (row_count between 1 and 10000),
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  request_id uuid not null,
  unique (legal_entity_id, export_no),
  unique (legal_entity_id, request_id),
  unique (legal_entity_id, id),
  check (period_from <= period_to and period_to - period_from <= 366)
);
create index tally_exports_entity_created_idx on public.tally_exports (legal_entity_id, created_at desc);
create index tally_exports_created_by_idx on public.tally_exports (created_by);
comment on table public.tally_exports is
  'Accounts phase: one CSV evidence export (not a Tally import). Append-only. No table grant.';

-- ===========================================================================
-- 3. tally_records (6.2.1)
-- ===========================================================================

create table public.tally_records (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  deal_id uuid,
  record_kind text not null check (record_kind in ('journal_entry', 'supplier_payment', 'supplier_document', 'expense', 'tally_gst_invoice')),
  record_id uuid not null,
  status text not null check (status in ('exported', 'matched', 'exception')),
  export_count integer not null default 0 check (export_count >= 0),
  last_export_id uuid,
  last_exported_at timestamptz,
  last_export_hash text check (last_export_hash is null or last_export_hash ~ '^[0-9a-f]{64}$'),
  voucher_ref text check (voucher_ref is null or (length(voucher_ref) between 1 and 60 and voucher_ref !~ '[[:cntrl:]]')),
  voucher_date date check (voucher_date is null or voucher_date >= date '2000-01-01'),
  matched_by uuid references public.staff_profiles (user_id),
  matched_at timestamptz,
  exception_reason text check (exception_reason is null or length(exception_reason) between 10 and 500),
  exception_tally_amount_paise bigint check (exception_tally_amount_paise is null or exception_tally_amount_paise > 0),
  exception_by uuid references public.staff_profiles (user_id),
  exception_at timestamptz,
  status_before_exception text check (status_before_exception in ('ready', 'exported', 'matched')),
  row_version integer not null default 1 check (row_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.staff_profiles (user_id),
  foreign key (legal_entity_id, branch_id) references public.branches (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  foreign key (legal_entity_id, last_export_id) references public.tally_exports (legal_entity_id, id),
  unique (record_kind, record_id),
  unique (legal_entity_id, id),
  check ((status = 'matched') = (matched_at is not null)),
  check ((matched_at is null) = (matched_by is null)),
  check (status <> 'matched' or (voucher_ref is not null and voucher_date is not null)),
  check ((voucher_ref is null) = (voucher_date is null)),
  check ((status = 'exception') = (exception_reason is not null)),
  check ((status = 'exception') = (exception_at is not null and exception_by is not null)),
  check ((status = 'exception') = (status_before_exception is not null)),
  check (exception_tally_amount_paise is null or status = 'exception'),
  check ((export_count = 0) = (last_export_id is null)),
  check ((last_export_id is null) = (last_exported_at is null)),
  check ((last_export_id is null) = (last_export_hash is null))
);
create index tally_records_entity_status_idx on public.tally_records (legal_entity_id, status, updated_at desc);
create index tally_records_deal_idx on public.tally_records (deal_id) where deal_id is not null;
create index tally_records_branch_fk_idx on public.tally_records (legal_entity_id, branch_id);
create index tally_records_deal_fk_idx on public.tally_records (legal_entity_id, deal_id) where deal_id is not null;
create index tally_records_last_export_idx on public.tally_records (legal_entity_id, last_export_id) where last_export_id is not null;
create index tally_records_matched_by_idx on public.tally_records (matched_by) where matched_by is not null;
create index tally_records_exception_by_idx on public.tally_records (exception_by) where exception_by is not null;
create index tally_records_updated_by_idx on public.tally_records (updated_by) where updated_by is not null;
comment on table public.tally_records is
  'Accounts phase: Tally matching state of one record (journal entry, supplier payment, supplier document, company-paid expense, GST invoice reference). Exists only once exported, matched or excepted; not_ready/ready/not_applicable are computed. Export never sets matched. No table grant.';

create function authz.tally_records_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'tally records cannot be deleted' using errcode = '42501';
  end if;
  if new.id is distinct from old.id or new.record_kind is distinct from old.record_kind
     or new.record_id is distinct from old.record_id or new.legal_entity_id is distinct from old.legal_entity_id
     or new.deal_id is distinct from old.deal_id or new.created_at is distinct from old.created_at
     or new.export_count < old.export_count or new.row_version <> old.row_version + 1 then
    raise exception 'tally record identity is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger tally_records_a_guard before update or delete on public.tally_records
  for each row execute function authz.tally_records_guard();

create table public.tally_export_lines (
  export_id uuid not null references public.tally_exports (id),
  line_no integer not null check (line_no between 1 and 10000),
  legal_entity_id uuid not null,
  record_kind text not null check (record_kind in ('journal_entry', 'supplier_payment', 'supplier_document', 'expense', 'tally_gst_invoice')),
  record_id uuid not null,
  tally_record_id uuid not null,
  "values" jsonb not null check (jsonb_typeof("values") = 'object'),
  source_hash text not null check (source_hash ~ '^[0-9a-f]{64}$'),
  previously_exported_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (export_id, line_no),
  foreign key (legal_entity_id, tally_record_id) references public.tally_records (legal_entity_id, id),
  unique (export_id, record_kind, record_id)
);
create index tally_export_lines_record_idx on public.tally_export_lines (record_kind, record_id);
create index tally_export_lines_tally_record_idx on public.tally_export_lines (legal_entity_id, tally_record_id);
comment on table public.tally_export_lines is
  'Accounts phase: snapshot of one exported CSV line (values as exported, PAN and mobile already masked). Re-downloading an export reproduces the same file. Append-only. No table grant.';

-- ===========================================================================
-- 4. deal_tally_invoices (6.2.5)
-- ===========================================================================

create table public.deal_tally_invoices (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  deal_id uuid not null,
  invoice_ref text not null check (length(invoice_ref) between 1 and 40 and invoice_ref ~ '^[A-Za-z0-9/ .-]+$'),
  ref_norm text generated always as (upper(regexp_replace(invoice_ref, '[^A-Za-z0-9]', '', 'g'))) stored,
  invoice_date date not null check (invoice_date >= date '2000-01-01'),
  fiscal_year text generated always as (authz.finance_fiscal_year(invoice_date)) stored,
  note text check (note is null or (length(note) between 1 and 300)),
  status text not null default 'active' check (status in ('active', 'withdrawn')),
  created_by uuid not null references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  request_id uuid not null,
  withdrawn_by uuid references public.staff_profiles (user_id),
  withdrawn_at timestamptz,
  withdraw_reason text check (withdraw_reason is null or length(withdraw_reason) between 10 and 500),
  row_version integer not null default 1 check (row_version >= 1),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, branch_id, deal_id) references public.deals (legal_entity_id, branch_id, id),
  unique (legal_entity_id, request_id),
  check (ref_norm <> ''),
  check ((status = 'withdrawn') = (withdrawn_at is not null and withdrawn_by is not null and withdraw_reason is not null))
);
create unique index deal_tally_invoices_active_ref_key on public.deal_tally_invoices (legal_entity_id, ref_norm, fiscal_year)
  where status = 'active';
create index deal_tally_invoices_deal_idx on public.deal_tally_invoices (deal_id);
create index deal_tally_invoices_deal_fk_idx on public.deal_tally_invoices (legal_entity_id, branch_id, deal_id);
create index deal_tally_invoices_created_by_idx on public.deal_tally_invoices (created_by);
create index deal_tally_invoices_withdrawn_by_idx on public.deal_tally_invoices (withdrawn_by) where withdrawn_by is not null;
comment on table public.deal_tally_invoices is
  'Accounts phase (DEC-22): the Deal''s statutory GST invoice reference as typed by Accounts from Tally. Several per Deal allowed; unique per entity and financial year while active. No table grant.';

create function authz.deal_tally_invoices_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  -- ref_norm and fiscal_year are generated (null in NEW of a BEFORE trigger)
  -- and follow invoice_ref/invoice_date, which stay compared.
  v_mutable text[] := array['status', 'withdrawn_by', 'withdrawn_at', 'withdraw_reason', 'row_version', 'updated_at',
    'ref_norm', 'fiscal_year'];
begin
  if tg_op = 'DELETE' then
    raise exception 'GST invoice references cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable)
     or (new.status is distinct from old.status and not (old.status = 'active' and new.status = 'withdrawn'))
     or (old.status = 'withdrawn' and (to_jsonb(new) - array['updated_at', 'ref_norm', 'fiscal_year'])
                                      is distinct from (to_jsonb(old) - array['updated_at', 'ref_norm', 'fiscal_year']))
     or new.row_version < old.row_version then
    raise exception 'GST invoice reference facts are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger deal_tally_invoices_a_guard before update or delete on public.deal_tally_invoices
  for each row execute function authz.deal_tally_invoices_guard();

-- Append-only tables.
create trigger tally_exports_append_only before update or delete on public.tally_exports
  for each row execute function authz.finance_append_only();
create trigger tally_export_lines_append_only before update or delete on public.tally_export_lines
  for each row execute function authz.finance_append_only();
create trigger tally_export_counters_no_delete before delete on public.tally_export_counters
  for each row execute function authz.finance_no_delete();

-- ===========================================================================
-- 5. Review approval memory (6.2.4)
-- ===========================================================================

alter table public.accounts_booking_reviews
  add column last_approved_at timestamptz,
  add column last_approved_by uuid references public.staff_profiles (user_id);
create index accounts_booking_reviews_last_approved_by_idx on public.accounts_booking_reviews (last_approved_by)
  where last_approved_by is not null;
create index accounts_booking_reviews_deal_approved_idx on public.accounts_booking_reviews (deal_id)
  where last_approved_at is not null;

-- Backfill (one statement each, before the trigger exists).
update public.accounts_booking_reviews rv
set last_approved_at = rv.reviewed_at, last_approved_by = rv.reviewed_by
where rv.status = 'approved' and rv.last_approved_at is null;

update public.accounts_booking_reviews rv
set last_approved_at = a.occurred_at, last_approved_by = a.actor_user_id
from (
  select distinct on (e.target_id) e.target_id, e.occurred_at, e.actor_user_id
  from public.audit_events e
  where e.action = 'finance.review_approved' and e.target_type = 'booking_version'
  order by e.target_id, e.occurred_at desc, e.id desc
) a
where rv.status <> 'approved' and rv.last_approved_at is null and a.target_id = rv.booking_version_id
  and exists (select 1 from public.staff_profiles p where p.user_id = a.actor_user_id);

create function authz.review_approval_memory() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'UPDATE' then
    -- Never cleared.
    if old.last_approved_at is not null and new.last_approved_at is null then
      new.last_approved_at := old.last_approved_at;
      new.last_approved_by := old.last_approved_by;
    end if;
  end if;
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    new.last_approved_at := now();
    new.last_approved_by := coalesce((select auth.uid()), new.reviewed_by);
  end if;
  return new;
end;
$$;
create trigger accounts_booking_reviews_approval_memory before insert or update on public.accounts_booking_reviews
  for each row execute function authz.review_approval_memory();

-- ===========================================================================
-- 6. Row level security: no permissive policy, no table privilege.
-- ===========================================================================

do $$
declare
  t text;
begin
  foreach t in array array['accounts_settings', 'tally_export_counters', 'tally_exports', 'tally_records',
                           'tally_export_lines', 'deal_tally_invoices'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

revoke all on function authz.accounts_settings_audit(), authz.accounts_settings_guard(), authz.tally_records_guard(),
  authz.deal_tally_invoices_guard(), authz.review_approval_memory()
  from public, anon, authenticated, service_role;

commit;
