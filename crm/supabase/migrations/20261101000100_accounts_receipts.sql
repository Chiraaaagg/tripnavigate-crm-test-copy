-- TripNavigate CRM - Phase 5A: Accounts review and customer receipts.
--
-- Contract: docs/implementation/next/phase-5a-contract.md (FROZEN 6 Oct 2026).
-- Shared result shapes: crm/src/modules/finance/contracts.ts.
--
-- This is an internal operational record of money the company says it
-- received. It is not an official ledger, not a tax receipt voucher and not a
-- tax invoice. No invoice, tax, refund, supplier payment or bank movement is
-- created here.
--
-- What changes:
--   * Permissions finance.accounts (role accounts, entity) and
--     finance.policy_manage (role super_admin, entity).
--   * Settings: finance_live_settings (one row per finance-enabled entity; the
--     four payment-mode switches default false and have no API write),
--     finance_legal_limits (owner-SQL-only legal ceilings),
--     finance_policy_heads + append-only finance_policy_versions.
--     The migration enables finance for HOLIDAY_CHACHA only.
--   * finance_deal_heads: the finance-owned per-deal lock row (deals are read,
--     never locked or edited).
--   * customer_billing_profiles, accounts_booking_reviews, customer_receipts,
--     finance_receipt_counters, cash_deposits, cash_deposit_items,
--     cash_reconciliations, finance_evidence (private bucket
--     finance-evidence), finance_journal_entries/lines (append-only, entry
--     shape validated at commit by a deferred constraint trigger) and
--     finance_command_results (request identity for exact retries).
--   * Every finance table: RLS on, a RESTRICTIVE session policy, no permissive
--     policy and no table privilege for anon/authenticated. All access goes
--     through SECURITY DEFINER functions with search_path ''.
--
-- Error contract (the message is exactly the token; contract section 11):
--   42501 not_authorized, not_self_approval | 55000 environment_unset,
--   not_configured, mode_not_live, wrong_state, cash_cap_exceeded (DETAIL is
--   the cap kind: payer_day | trip), evidence_required, billing_not_verified |
--   22023 invalid_input | 23505 duplicate_reference | 40001 request_conflict,
--   version_changed | P0002 not_found.
--
-- Lock order (never reversed): policy head (FOR SHARE; policy update FOR
-- UPDATE) -> finance_deal_heads FOR UPDATE (deposits: ascending deal id) ->
-- receipt rows FOR UPDATE ascending id -> deposit / reconciliation row ->
-- advisory cash keys ascending -> receipt counter row. Commands assume READ
-- COMMITTED: every statement after a lock wait sees rows committed before it.
--
-- Public RPCs (security definer; execute granted to authenticated only):
--   reads   accounts_queue(text), accounts_deal_lookup(text),
--           accounts_deal_detail(uuid), accounts_cash_overview(uuid),
--           finance_policy_get(uuid)
--   commands accounts_billing_save(uuid, integer, jsonb, uuid),
--           accounts_billing_verify(uuid, integer, uuid),
--           accounts_review_return(uuid, text, uuid),
--           accounts_review_approve(uuid, integer, uuid),
--           receipt_record(uuid, jsonb, uuid), receipt_verify(uuid, uuid),
--           receipt_reject(uuid, text, text, uuid),
--           cheque_clear(uuid, date, uuid),
--           cheque_mark(uuid, text, date, text, uuid),
--           cheque_represent(uuid, uuid),
--           receipt_reverse(uuid, text, text, uuid),
--           cash_deposit_record(uuid, uuid[], date, text, uuid, uuid),
--           cash_deposit_verify(uuid, uuid), cash_deposit_reject(uuid, text, uuid),
--           cash_reconciliation_record(uuid, date, bigint, text, uuid),
--           cash_reconciliation_verify(uuid, uuid),
--           finance_policy_update(uuid, jsonb, timestamptz, text, uuid),
--           finance_evidence_begin(text, uuid, text, text, text, integer, text, uuid),
--           finance_evidence_finish(uuid, boolean),
--           finance_evidence_authorize_download(uuid),
--           finance_evidence_remove(uuid)
--
-- Rollback / recovery (forward-only): the fastest safe stop is
-- deployment_settings.environment = 'unset' (every finance read and command
-- refuses) or leaving every finance_live_settings mode false (operational
-- recording refuses). An emergency rollback is a NEW migration that revokes
-- execute on these functions from authenticated. Receipts, journal entries,
-- policy versions, evidence rows and audit_events are never deleted.

begin;

-- ---------------------------------------------------------------------------
-- Permission catalogue (role-derived, not grantable)
-- ---------------------------------------------------------------------------

insert into public.permissions (code, description, is_grantable) values
  ('finance.accounts', 'Accounts review, customer billing details, customer receipts, cash custody and reconciliation.', false),
  ('finance.policy_manage', 'Edit the versioned company finance policy (receipt maximum, cash caps, deposit days, reconciliation).', false);

insert into public.role_permissions (role_code, permission_code, scope, policy_status, note) values
  ('accounts', 'finance.accounts', 'entity', 'confirmed', 'Phase 5A: entity-wide Accounts; refused while the person also holds Purchase in the entity'),
  ('super_admin', 'finance.policy_manage', 'entity', 'confirmed', 'Phase 5A: refused while the person also holds Accounts in the entity');

-- ---------------------------------------------------------------------------
-- Settings, legal ceilings and versioned policy
-- ---------------------------------------------------------------------------

create table public.finance_live_settings (
  legal_entity_id uuid primary key references public.legal_entities (id),
  bank_transfer_live boolean not null default false,
  upi_live boolean not null default false,
  cash_live boolean not null default false,
  cheque_live boolean not null default false,
  updated_at timestamptz not null default now()
);
comment on table public.finance_live_settings is
  'Finance is enabled only for entities with a row. Mode switches are changed by owner SQL after CA confirmation; no API writes them.';

create table public.finance_legal_limits (
  legal_entity_id uuid primary key references public.legal_entities (id),
  cash_cap_ceiling_paise bigint not null default 19999900 check (cash_cap_ceiling_paise >= 0),
  receipt_max_ceiling_paise bigint not null default 10000000000 check (receipt_max_ceiling_paise >= 1),
  updated_at timestamptz not null default now()
);
comment on table public.finance_legal_limits is
  'CA-confirmed legal ceilings. Owner SQL only; Super Admin policy must stay within them.';

create table public.finance_policy_heads (
  legal_entity_id uuid primary key references public.legal_entities (id),
  current_version_no integer not null check (current_version_no >= 1),
  updated_at timestamptz not null default now()
);

create table public.finance_policy_versions (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.finance_policy_heads (legal_entity_id),
  version_no integer not null check (version_no >= 1),
  effective_at timestamptz not null,
  receipt_max_paise bigint not null check (receipt_max_paise >= 1),
  cash_payer_day_cap_paise bigint not null check (cash_payer_day_cap_paise >= 0),
  cash_trip_cap_paise bigint not null check (cash_trip_cap_paise >= 0),
  cash_deposit_days integer not null check (cash_deposit_days between 1 and 7),
  reconciliation_required boolean not null,
  reason text not null check (length(reason) between 10 and 500),
  created_by uuid references public.staff_profiles (user_id),
  created_at timestamptz not null default now(),
  request_id uuid,
  unique (legal_entity_id, version_no)
);
create index finance_policy_versions_effective_idx on public.finance_policy_versions (legal_entity_id, effective_at desc, version_no desc);

-- ---------------------------------------------------------------------------
-- Per-deal finance lock, counters and request identity
-- ---------------------------------------------------------------------------

create table public.finance_deal_heads (
  deal_id uuid primary key,
  legal_entity_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id)
);
comment on table public.finance_deal_heads is
  'Finance-owned per-deal serialisation row. Commands insert it (on conflict do nothing) and lock it FOR UPDATE; deals are never locked.';

create table public.finance_receipt_counters (
  legal_entity_id uuid not null references public.legal_entities (id),
  fiscal_year text not null check (fiscal_year ~ '^[0-9]{4}-[0-9]{2}$'),
  last_no integer not null default 0 check (last_no >= 0),
  primary key (legal_entity_id, fiscal_year)
);

create table public.finance_command_results (
  legal_entity_id uuid not null references public.legal_entities (id),
  request_id uuid not null,
  actor uuid not null references public.staff_profiles (user_id),
  command text not null,
  payload_hash text not null check (payload_hash ~ '^[0-9a-f]{64}$'),
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (legal_entity_id, request_id)
);
comment on table public.finance_command_results is
  'Committed command results by (entity, request_id). Same actor, command and canonical payload replays the stored result; anything else is request_conflict.';

-- ---------------------------------------------------------------------------
-- Billing details and booking review
-- ---------------------------------------------------------------------------

create table public.customer_billing_profiles (
  deal_id uuid primary key,
  legal_entity_id uuid not null,
  billing_name text not null check (length(billing_name) between 1 and 200),
  address_line1 text not null check (length(address_line1) between 1 and 200),
  address_line2 text check (address_line2 is null or length(address_line2) between 1 and 200),
  city text not null check (length(city) between 1 and 120),
  state_code text not null check (state_code ~ '^(0[1-9]|[12][0-9]|3[0-8]|97)$'),
  postal_code text not null check (postal_code ~ '^[1-9][0-9]{5}$'),
  gstin text check (gstin is null or (gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' and left(gstin, 2) = state_code)),
  status text not null default 'draft' check (status in ('draft', 'verified')),
  row_version integer not null default 1 check (row_version >= 1),
  prefill_source text not null default 'none' check (prefill_source = 'none'),
  created_at timestamptz not null default now(),
  updated_by uuid not null references public.staff_profiles (user_id),
  updated_at timestamptz not null default now(),
  verified_by uuid references public.staff_profiles (user_id),
  verified_at timestamptz,
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  check ((status = 'verified') = (verified_at is not null)),
  check ((verified_at is null) = (verified_by is null))
);

create table public.accounts_booking_reviews (
  id uuid primary key default gen_random_uuid(),
  booking_version_id uuid not null unique,
  deal_id uuid not null,
  legal_entity_id uuid not null,
  status text not null default 'pending' check (status in ('pending', 'returned', 'approved')),
  return_reason text check (return_reason is null or length(return_reason) between 10 and 500),
  reviewed_by uuid references public.staff_profiles (user_id),
  reviewed_at timestamptz,
  row_version integer not null default 1 check (row_version >= 1),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, deal_id, booking_version_id) references public.booking_versions (legal_entity_id, deal_id, id),
  check (status <> 'returned' or return_reason is not null)
);

-- ---------------------------------------------------------------------------
-- Customer receipts
-- ---------------------------------------------------------------------------

create table public.customer_receipts (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  deal_id uuid not null,
  -- Collecting branch (may differ from the deal's branch).
  branch_id uuid not null,
  receipt_no text not null check (receipt_no ~ '^R-[0-9]{4}-[0-9]{2}-[0-9]{6,}$'),
  fiscal_year text not null check (fiscal_year ~ '^[0-9]{4}-[0-9]{2}$'),
  mode text not null check (mode in ('bank_transfer', 'upi', 'cash', 'cheque')),
  status text not null default 'recorded' check (status in (
    'recorded', 'verified', 'pending_clearance', 'cleared', 'bounced', 'stopped', 'cancelled', 'rejected', 'reversed')),
  amount_paise bigint not null check (amount_paise >= 1),
  currency char(3) not null default 'INR' check (currency = 'INR'),
  received_on date not null,
  collector_user_id uuid references public.staff_profiles (user_id),
  payer_name text not null check (length(payer_name) between 1 and 200),
  payer_pan text check (payer_pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  payer_mobile text check (payer_mobile ~ '^[6-9][0-9]{9}$'),
  reference text check (reference ~ '^[A-Za-z0-9/-]{6,40}$'),
  reference_norm text,
  micr_code text check (micr_code ~ '^[0-9]{9}$'),
  cheque_number text check (cheque_number ~ '^[0-9]{6}$'),
  cheque_date date,
  account_payee boolean,
  booking_version_id uuid references public.booking_versions (id),
  corrects_receipt_id uuid unique references public.customer_receipts (id),
  -- Set on the original before the correction is inserted (same transaction).
  corrected_by_receipt_id uuid unique references public.customer_receipts (id) deferrable initially deferred,
  note text check (note is null or length(note) between 1 and 500),
  policy_version_id uuid not null references public.finance_policy_versions (id),
  request_id uuid not null,
  recorded_by uuid not null references public.staff_profiles (user_id),
  recorded_at timestamptz not null default now(),
  verified_by uuid references public.staff_profiles (user_id),
  verified_at timestamptz,
  cleared_by uuid references public.staff_profiles (user_id),
  cleared_at timestamptz,
  outcome_date date,
  marked_by uuid references public.staff_profiles (user_id),
  marked_at timestamptz,
  rejection_kind text check (rejection_kind in ('not_received', 'data_error')),
  reversal_kind text check (reversal_kind in ('bank_return', 'not_received', 'data_error')),
  reason text check (reason is null or length(reason) between 1 and 500),
  rejected_by uuid references public.staff_profiles (user_id),
  rejected_at timestamptz,
  reversed_by uuid references public.staff_profiles (user_id),
  reversed_at timestamptz,
  represent_count integer not null default 0 check (represent_count >= 0),
  -- finance_evidence.seq at the latest bounce or re-presentation: proofs for
  -- the next cheque step must be newer than this.
  evidence_watermark bigint not null default 0,
  row_version integer not null default 1 check (row_version >= 1),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  foreign key (legal_entity_id, branch_id) references public.branches (legal_entity_id, id),
  unique (legal_entity_id, receipt_no),
  unique (legal_entity_id, id),
  check (payer_pan is not null or payer_mobile is not null),
  check ((mode in ('bank_transfer', 'upi')) = (reference is not null)),
  check (reference_norm is not distinct from upper(replace(replace(reference, ' ', ''), '-', ''))),
  check ((mode = 'cash') = (collector_user_id is not null)),
  check (case when mode = 'cheque'
    then micr_code is not null and cheque_number is not null and cheque_date is not null and account_payee is true
    else micr_code is null and cheque_number is null and cheque_date is null and account_payee is null end),
  check (mode = 'cheque' or status in ('recorded', 'verified', 'rejected', 'reversed')),
  check (mode <> 'cheque' or status <> 'verified'),
  check ((status = 'rejected') = (rejection_kind is not null)),
  check ((status = 'reversed') = (reversal_kind is not null)),
  check (corrects_receipt_id is null or corrects_receipt_id <> id)
);
create index customer_receipts_deal_idx on public.customer_receipts (deal_id, recorded_at);
create index customer_receipts_branch_cash_idx on public.customer_receipts (branch_id, received_on) where mode = 'cash';
create index customer_receipts_payer_pan_idx on public.customer_receipts (legal_entity_id, payer_pan, received_on) where mode = 'cash';
create index customer_receipts_payer_mobile_idx on public.customer_receipts (legal_entity_id, payer_mobile, received_on) where mode = 'cash';
-- Duplicate reference: bank transfer and UPI share one namespace per entity.
create unique index customer_receipts_reference_unique on public.customer_receipts (legal_entity_id, reference_norm)
  where mode in ('bank_transfer', 'upi') and corrected_by_receipt_id is null;
create unique index customer_receipts_cheque_unique on public.customer_receipts (legal_entity_id, micr_code, cheque_number)
  where mode = 'cheque' and corrected_by_receipt_id is null;

-- ---------------------------------------------------------------------------
-- Cash custody
-- ---------------------------------------------------------------------------

create table public.cash_deposits (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  deposited_on date not null,
  bank_reference text not null check (bank_reference ~ '^[A-Za-z0-9/ .-]{3,60}$'),
  total_paise bigint not null check (total_paise >= 1),
  status text not null default 'recorded' check (status in ('recorded', 'verified', 'rejected')),
  request_id uuid not null,
  recorded_by uuid not null references public.staff_profiles (user_id),
  recorded_at timestamptz not null default now(),
  verified_by uuid references public.staff_profiles (user_id),
  verified_at timestamptz,
  rejected_by uuid references public.staff_profiles (user_id),
  rejected_at timestamptz,
  reject_reason text check (reject_reason is null or length(reject_reason) between 10 and 500),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, branch_id) references public.branches (legal_entity_id, id),
  unique (legal_entity_id, id),
  check ((status = 'rejected') = (reject_reason is not null))
);

create table public.cash_deposit_items (
  deposit_id uuid not null references public.cash_deposits (id),
  receipt_id uuid not null references public.customer_receipts (id),
  legal_entity_id uuid not null,
  amount_paise bigint not null check (amount_paise >= 1),
  -- True once the deposit is rejected: the receipt may join a new deposit.
  released boolean not null default false,
  primary key (deposit_id, receipt_id)
);
create unique index cash_deposit_items_active_unique on public.cash_deposit_items (receipt_id) where not released;

create table public.cash_reconciliations (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  business_date date not null,
  counted_paise bigint not null check (counted_paise >= 0),
  expected_paise bigint not null,
  unverified_cash_paise bigint not null check (unverified_cash_paise >= 0),
  note text check (note is null or length(note) between 10 and 500),
  status text not null default 'recorded' check (status in ('recorded', 'verified')),
  -- Set by trigger when a cash_in_hand entry later posts on or before business_date.
  stale boolean not null default false,
  stale_at timestamptz,
  request_id uuid not null,
  recorded_by uuid not null references public.staff_profiles (user_id),
  recorded_at timestamptz not null default now(),
  verified_by uuid references public.staff_profiles (user_id),
  verified_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, branch_id) references public.branches (legal_entity_id, id),
  check (counted_paise = expected_paise or note is not null),
  check (stale = (stale_at is not null))
);
-- One current (non-stale) reconciliation per branch and business date.
create unique index cash_reconciliations_current_unique on public.cash_reconciliations (branch_id, business_date) where not stale;

-- ---------------------------------------------------------------------------
-- Evidence (private bucket finance-evidence)
-- ---------------------------------------------------------------------------

create table public.finance_evidence (
  id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity unique,
  legal_entity_id uuid not null references public.legal_entities (id),
  kind text not null check (kind in ('bank_proof', 'cheque_image', 'deposit_slip')),
  receipt_id uuid references public.customer_receipts (id),
  deposit_id uuid references public.cash_deposits (id),
  -- Owner of a deposit slip uploaded before its deposit exists (the branch).
  branch_id uuid,
  object_path text not null unique,
  file_name text not null check (length(file_name) between 1 and 120 and file_name ~ '^[A-Za-z0-9._ -]+$'),
  mime text not null check (mime in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 4194304),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending_upload' check (status in ('pending_upload', 'stored', 'failed', 'removed')),
  uploaded_by uuid not null references public.staff_profiles (user_id),
  request_id uuid,
  -- True once the slip's deposit is rejected: it no longer backs custody and
  -- the same file may be uploaded again for a new deposit.
  released boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  stored_at timestamptz,
  foreign key (legal_entity_id, branch_id) references public.branches (legal_entity_id, id),
  check (not released or kind = 'deposit_slip'),
  check (case when kind = 'deposit_slip'
    then receipt_id is null and branch_id is not null
    else receipt_id is not null and deposit_id is null and branch_id is null end),
  check (object_path = legal_entity_id::text || '/' || coalesce(receipt_id, branch_id)::text || '/' || id::text)
);
create index finance_evidence_receipt_idx on public.finance_evidence (receipt_id, kind, status);
create index finance_evidence_deposit_idx on public.finance_evidence (deposit_id);
-- The same file cannot back two receipts (or two deposits). Failed uploads and
-- slips of rejected deposits hold no proof.
create unique index finance_evidence_sha_unique on public.finance_evidence (legal_entity_id, kind, sha256)
  where status in ('pending_upload', 'stored') and not released;

-- ---------------------------------------------------------------------------
-- Internal journal (not a chart of accounts)
-- ---------------------------------------------------------------------------

create table public.finance_journal_entries (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  kind text not null check (kind in ('receipt_bank', 'receipt_cash', 'deposit', 'reversal_bank',
    'reversal_cash_deposited', 'reversal_cash_undeposited')),
  receipt_id uuid references public.customer_receipts (id),
  deposit_id uuid references public.cash_deposits (id),
  deal_id uuid references public.deals (id),
  branch_id uuid not null references public.branches (id),
  business_date date not null,
  reverses_entry_id uuid unique references public.finance_journal_entries (id),
  posted_at timestamptz not null default now(),
  posted_by uuid not null references public.staff_profiles (user_id),
  unique (receipt_id, kind),
  check ((kind = 'deposit') = (deposit_id is not null)),
  check ((kind = 'deposit') = (receipt_id is null)),
  check ((kind like 'reversal%') = (reverses_entry_id is not null))
);
create index finance_journal_entries_deal_idx on public.finance_journal_entries (deal_id);
create unique index finance_journal_entries_one_deposit on public.finance_journal_entries (deposit_id) where kind = 'deposit';

create table public.finance_journal_lines (
  id bigint generated always as identity primary key,
  entry_id uuid not null references public.finance_journal_entries (id),
  account text not null check (account in ('bank', 'cash_in_hand', 'customer_advances')),
  deal_id uuid references public.deals (id),
  branch_id uuid not null references public.branches (id),
  debit_paise bigint not null default 0 check (debit_paise >= 0),
  credit_paise bigint not null default 0 check (credit_paise >= 0),
  check ((debit_paise > 0 and credit_paise = 0) or (credit_paise > 0 and debit_paise = 0))
);
create index finance_journal_lines_entry_idx on public.finance_journal_lines (entry_id);
create index finance_journal_lines_deal_idx on public.finance_journal_lines (deal_id, account);
create index finance_journal_lines_branch_idx on public.finance_journal_lines (branch_id, account);

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

create function authz.finance_append_only() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception '% rows are append-only', tg_table_name using errcode = '42501';
end;
$$;
create trigger finance_policy_versions_append_only before update or delete on public.finance_policy_versions
  for each row execute function authz.finance_append_only();
create trigger finance_command_results_append_only before update or delete on public.finance_command_results
  for each row execute function authz.finance_append_only();
create trigger finance_journal_entries_append_only before update or delete on public.finance_journal_entries
  for each row execute function authz.finance_append_only();
create trigger finance_journal_lines_append_only before update or delete on public.finance_journal_lines
  for each row execute function authz.finance_append_only();

create function authz.finance_no_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception '% rows cannot be deleted', tg_table_name using errcode = '42501';
end;
$$;
create trigger finance_policy_heads_no_delete before delete on public.finance_policy_heads
  for each row execute function authz.finance_no_delete();
create trigger finance_deal_heads_no_delete before delete on public.finance_deal_heads
  for each row execute function authz.finance_no_delete();
create trigger finance_receipt_counters_no_delete before delete on public.finance_receipt_counters
  for each row execute function authz.finance_no_delete();
create trigger customer_billing_profiles_no_delete before delete on public.customer_billing_profiles
  for each row execute function authz.finance_no_delete();
create trigger accounts_booking_reviews_no_delete before delete on public.accounts_booking_reviews
  for each row execute function authz.finance_no_delete();

-- Policy ceilings are enforced on every version, whoever inserts it.
create function authz.finance_policy_versions_ceiling() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_limits public.finance_legal_limits%rowtype;
begin
  select * into v_limits from public.finance_legal_limits l where l.legal_entity_id = new.legal_entity_id;
  if v_limits.legal_entity_id is null
     or new.cash_payer_day_cap_paise > v_limits.cash_cap_ceiling_paise
     or new.cash_trip_cap_paise > v_limits.cash_cap_ceiling_paise
     or new.receipt_max_paise > v_limits.receipt_max_ceiling_paise then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  return new;
end;
$$;
create trigger finance_policy_versions_ceiling before insert on public.finance_policy_versions
  for each row execute function authz.finance_policy_versions_ceiling();

create function authz.customer_receipts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_mutable text[] := array['status', 'verified_by', 'verified_at', 'cleared_by', 'cleared_at', 'outcome_date',
    'marked_by', 'marked_at', 'rejection_kind', 'reversal_kind', 'reason', 'rejected_by', 'rejected_at',
    'reversed_by', 'reversed_at', 'corrected_by_receipt_id', 'represent_count', 'evidence_watermark',
    'row_version', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    raise exception 'customer receipts cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    raise exception 'receipt facts are immutable' using errcode = '42501';
  end if;
  if old.corrected_by_receipt_id is not null and new.corrected_by_receipt_id is distinct from old.corrected_by_receipt_id then
    raise exception 'a correction link is permanent' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and (old.status, new.status) not in (
       ('recorded', 'verified'), ('recorded', 'pending_clearance'), ('recorded', 'rejected'),
       ('pending_clearance', 'cleared'), ('pending_clearance', 'bounced'), ('pending_clearance', 'stopped'),
       ('pending_clearance', 'cancelled'), ('bounced', 'pending_clearance'),
       ('verified', 'reversed'), ('cleared', 'reversed')) then
    raise exception 'receipt status % cannot become %', old.status, new.status using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger customer_receipts_a_guard before update or delete on public.customer_receipts
  for each row execute function authz.customer_receipts_guard();

create function authz.cash_deposits_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_mutable text[] := array['status', 'verified_by', 'verified_at', 'rejected_by', 'rejected_at', 'reject_reason', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    raise exception 'cash deposits cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable)
     or (new.status is distinct from old.status and not (old.status = 'recorded' and new.status in ('verified', 'rejected'))) then
    raise exception 'deposit facts are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger cash_deposits_a_guard before update or delete on public.cash_deposits
  for each row execute function authz.cash_deposits_guard();

create function authz.cash_deposit_items_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' or (to_jsonb(new) - 'released') is distinct from (to_jsonb(old) - 'released')
     or (old.released and not new.released) then
    raise exception 'deposit membership is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger cash_deposit_items_a_guard before update or delete on public.cash_deposit_items
  for each row execute function authz.cash_deposit_items_guard();

create function authz.cash_reconciliations_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_mutable text[] := array['status', 'verified_by', 'verified_at', 'stale', 'stale_at', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    raise exception 'reconciliations cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable)
     or (old.stale and not new.stale)
     or (new.status is distinct from old.status and not (old.status = 'recorded' and new.status = 'verified')) then
    raise exception 'reconciliation facts are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger cash_reconciliations_a_guard before update or delete on public.cash_reconciliations
  for each row execute function authz.cash_reconciliations_guard();

create function authz.finance_evidence_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_mutable text[] := array['status', 'updated_at', 'stored_at', 'deposit_id', 'released'];
begin
  if tg_op = 'DELETE' then
    raise exception 'finance evidence rows cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable)
     or (old.deposit_id is not null and new.deposit_id is distinct from old.deposit_id)
     or (old.released and not new.released)
     or (old.status = 'removed' and new.status <> 'removed') then
    raise exception 'finance evidence identity is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger finance_evidence_a_guard before update or delete on public.finance_evidence
  for each row execute function authz.finance_evidence_guard();

-- Journal shape (contract section 10), validated at commit.
create function authz.finance_check_entry(p_entry uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  e public.finance_journal_entries%rowtype;
  r public.customer_receipts%rowtype;
  d public.cash_deposits%rowtype;
  v_amount bigint;
  v_expected jsonb;
  v_actual jsonb;
  v_ok boolean := true;
begin
  select * into e from public.finance_journal_entries j where j.id = p_entry;
  if e.id is null then
    raise exception 'journal_shape' using errcode = '23514';
  end if;
  if e.kind = 'deposit' then
    select * into d from public.cash_deposits x where x.id = e.deposit_id;
    v_ok := d.id is not null and d.status = 'verified' and e.deal_id is null and e.branch_id = d.branch_id
      and e.business_date = d.deposited_on and e.legal_entity_id = d.legal_entity_id;
    v_amount := d.total_paise;
  else
    select * into r from public.customer_receipts x where x.id = e.receipt_id;
    v_ok := r.id is not null and e.deal_id = r.deal_id and e.branch_id = r.branch_id
      and e.legal_entity_id = r.legal_entity_id;
    v_amount := r.amount_paise;
    if v_ok and e.kind in ('receipt_bank', 'receipt_cash') then
      v_ok := e.business_date = r.received_on and e.reverses_entry_id is null
        and ((e.kind = 'receipt_cash' and r.mode = 'cash') or (e.kind = 'receipt_bank' and r.mode <> 'cash'));
    elsif v_ok then
      -- Reverses this receipt's own receipt entry, on the IST date of the
      -- reversal, with the custody path its deposit membership implies.
      v_ok := exists (
        select 1 from public.finance_journal_entries o
        where o.id = e.reverses_entry_id and o.receipt_id = e.receipt_id
          and o.kind = case when e.kind = 'reversal_bank' then 'receipt_bank' else 'receipt_cash' end)
        and e.business_date = (e.posted_at at time zone 'Asia/Kolkata')::date
        and r.status = 'reversed'
        and case e.kind
          when 'reversal_bank' then r.mode <> 'cash'
          when 'reversal_cash_deposited' then r.mode = 'cash'
            and authz.finance_receipt_deposit_status(r.id) is not distinct from 'verified'
          else r.mode = 'cash' and authz.finance_receipt_deposit_status(r.id) is null
        end;
    end if;
  end if;
  if not v_ok or v_amount is null then
    raise exception 'journal_shape' using errcode = '23514';
  end if;

  v_expected := case e.kind
    when 'receipt_bank' then jsonb_build_array(jsonb_build_array('bank', v_amount, 0), jsonb_build_array('customer_advances', 0, v_amount))
    when 'receipt_cash' then jsonb_build_array(jsonb_build_array('cash_in_hand', v_amount, 0), jsonb_build_array('customer_advances', 0, v_amount))
    when 'deposit' then jsonb_build_array(jsonb_build_array('bank', v_amount, 0), jsonb_build_array('cash_in_hand', 0, v_amount))
    when 'reversal_cash_undeposited' then jsonb_build_array(jsonb_build_array('cash_in_hand', 0, v_amount), jsonb_build_array('customer_advances', v_amount, 0))
    else jsonb_build_array(jsonb_build_array('bank', 0, v_amount), jsonb_build_array('customer_advances', v_amount, 0))
  end;
  select jsonb_agg(jsonb_build_array(l.account, l.debit_paise, l.credit_paise) order by l.account, l.debit_paise, l.credit_paise)
  into v_actual
  from public.finance_journal_lines l
  where l.entry_id = e.id;
  if v_actual is distinct from v_expected
     or exists (select 1 from public.finance_journal_lines l
                where l.entry_id = e.id and (l.deal_id is distinct from e.deal_id or l.branch_id <> e.branch_id)) then
    raise exception 'journal_shape' using errcode = '23514';
  end if;
end;
$$;

create function authz.finance_entry_shape_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform authz.finance_check_entry(new.id);
  return null;
end;
$$;
create function authz.finance_line_shape_trigger() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  perform authz.finance_check_entry(new.entry_id);
  return null;
end;
$$;
create constraint trigger finance_journal_entries_shape after insert on public.finance_journal_entries
  deferrable initially deferred for each row execute function authz.finance_entry_shape_trigger();
create constraint trigger finance_journal_lines_shape after insert on public.finance_journal_lines
  deferrable initially deferred for each row execute function authz.finance_line_shape_trigger();

-- A cash entry posted on or before a reconciliation's date makes it stale.
create function authz.finance_mark_reconciliations_stale() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.account = 'cash_in_hand' then
    update public.cash_reconciliations c
    set stale = true, stale_at = now(), updated_at = now()
    where c.branch_id = new.branch_id and not c.stale
      and c.business_date >= (select e.business_date from public.finance_journal_entries e where e.id = new.entry_id);
  end if;
  return null;
end;
$$;
create trigger finance_journal_lines_stale after insert on public.finance_journal_lines
  for each row execute function authz.finance_mark_reconciliations_stale();

-- ---------------------------------------------------------------------------
-- Entity enablement (owner SQL; no API grant)
-- ---------------------------------------------------------------------------

create function authz.finance_enable_entity(p_entity uuid) returns void
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.finance_live_settings (legal_entity_id) values (p_entity) on conflict do nothing;
  insert into public.finance_legal_limits (legal_entity_id) values (p_entity) on conflict do nothing;
  insert into public.finance_policy_heads (legal_entity_id, current_version_no) values (p_entity, 1) on conflict do nothing;
  if not exists (select 1 from public.finance_policy_versions v where v.legal_entity_id = p_entity) then
    insert into public.finance_policy_versions (legal_entity_id, version_no, effective_at, receipt_max_paise,
      cash_payer_day_cap_paise, cash_trip_cap_paise, cash_deposit_days, reconciliation_required, reason)
    values (p_entity, 1, now(), 1000000000, 4999900, 4999900, 1, true,
      'Initial company finance policy (owner-approved defaults, migration 20261101000100).');
  end if;
end;
$$;

select authz.finance_enable_entity(e.id) from public.legal_entities e where e.code = 'HOLIDAY_CHACHA';

-- ---------------------------------------------------------------------------
-- Authorization and gate helpers (contract sections 4 and 5)
-- ---------------------------------------------------------------------------

create function authz.finance_enabled(p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.finance_live_settings s
    join public.legal_entities e on e.id = s.legal_entity_id
    where s.legal_entity_id = p_entity and e.status = 'enabled'
  )
$$;

create function authz.can_accounts(p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok() and authz.finance_enabled(p_entity)
    and authz.holds_active_role('accounts', p_entity)
    and not authz.holds_role('purchase', p_entity), false)
$$;

create function authz.can_manage_finance_policy(p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok() and authz.finance_enabled(p_entity)
    and authz.holds_active_role('super_admin', p_entity)
    and not authz.holds_role('accounts', p_entity), false)
$$;

-- The actor owns the deal or has an active Sales assignment on it.
create function authz.finance_deal_conflict(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.deals d where d.id = p_deal and d.owner_user_id = (select auth.uid()))
    or exists (
      select 1 from public.deal_assignments a
      where a.deal_id = p_deal and a.user_id = (select auth.uid())
        and a.assignment_kind = 'sales' and a.ended_at is null)
$$;

-- Environment/configuration refusal for an entity (and a deal's synthetic
-- flag when known): 'environment_unset', 'not_configured' or null.
create function authz.finance_gate_issue(p_entity uuid, p_synthetic boolean) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when authz.deployment_environment() = 'unset' then 'environment_unset'
    when authz.deployment_environment() not in ('test', 'operational') then 'not_configured'
    when p_entity is not null and not authz.finance_enabled(p_entity) then 'not_configured'
    when p_synthetic is null then null
    when authz.deployment_environment() = 'test' and not p_synthetic then 'not_configured'
    when authz.deployment_environment() = 'operational' and p_synthetic then 'not_configured'
    else null
  end
$$;

-- Permission, then environment. Accounts role holders of a finance-disabled
-- entity get not_configured; everyone else not_authorized.
create function authz.finance_require_accounts(p_entity uuid, p_synthetic boolean) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_issue text;
begin
  if p_entity is null or not coalesce(authz.session_ok(), false)
     or not authz.holds_active_role('accounts', p_entity) or authz.holds_role('purchase', p_entity) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_issue := authz.finance_gate_issue(p_entity, p_synthetic);
  if v_issue is not null then
    raise exception '%', v_issue using errcode = '55000';
  end if;
end;
$$;

create function authz.finance_require_policy_manager(p_entity uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_issue text;
begin
  if p_entity is null or not coalesce(authz.session_ok(), false)
     or not authz.holds_active_role('super_admin', p_entity) or authz.holds_role('accounts', p_entity) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_issue := authz.finance_gate_issue(p_entity, null);
  if v_issue is not null then
    raise exception '%', v_issue using errcode = '55000';
  end if;
end;
$$;

-- test: every mode; operational: the live switch; otherwise none.
create function authz.finance_mode_allowed(p_entity uuid, p_mode text) returns boolean
language sql stable security definer set search_path = '' as $$
  select case authz.deployment_environment()
    when 'test' then true
    when 'operational' then coalesce((
      select case p_mode
        when 'bank_transfer' then s.bank_transfer_live
        when 'upi' then s.upi_live
        when 'cash' then s.cash_live
        when 'cheque' then s.cheque_live
        else false end
      from public.finance_live_settings s where s.legal_entity_id = p_entity), false)
    else false
  end
$$;

create function authz.finance_today() returns date
language sql stable set search_path = '' as $$
  select (now() at time zone 'Asia/Kolkata')::date
$$;

-- Indian fiscal year label of a date, for example 2026-27.
create function authz.finance_fiscal_year(p_date date) returns text
language sql immutable set search_path = '' as $$
  select case when extract(month from p_date) >= 4
    then extract(year from p_date)::int::text || '-' || lpad(((extract(year from p_date)::int + 1) % 100)::text, 2, '0')
    else (extract(year from p_date)::int - 1)::text || '-' || lpad((extract(year from p_date)::int % 100)::text, 2, '0')
  end
$$;

-- Adds working days (Monday to Saturday; Sunday skipped; no holiday calendar).
create function authz.finance_add_working_days(p_from date, p_days integer) returns date
language plpgsql immutable set search_path = '' as $$
declare
  v date := p_from;
  n integer := 0;
begin
  while n < p_days loop
    v := v + 1;
    if extract(isodow from v) <> 7 then
      n := n + 1;
    end if;
  end loop;
  return v;
end;
$$;

create function authz.finance_name(p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select p.display_name from public.staff_profiles p where p.user_id = p_user
$$;

-- ---------------------------------------------------------------------------
-- Input helpers (every refusal is invalid_input)
-- ---------------------------------------------------------------------------

create function authz.finance_invalid() returns void
language plpgsql volatile set search_path = '' as $$
begin
  raise exception 'invalid_input' using errcode = '22023';
end;
$$;

-- A string field of a jsonb object: null when absent or JSON null.
create function authz.finance_field(p_fields jsonb, p_key text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v jsonb := p_fields -> p_key;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v) <> 'string' then
    perform authz.finance_invalid();
  end if;
  return v #>> '{}';
end;
$$;

-- Trimmed text; '' -> null; outside [min, max] or control characters -> invalid_input.
create function authz.finance_text(p_value text, p_min integer, p_max integer, p_multiline boolean) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v text := btrim(coalesce(p_value, ''), E' \t\r\n');
begin
  if v = '' then
    return null;
  end if;
  if length(v) < p_min or length(v) > p_max
     or (p_multiline and v ~ E'[\\x01-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]')
     or (not p_multiline and v ~ E'[\\x01-\\x1f\\x7f]') then
    perform authz.finance_invalid();
  end if;
  return v;
end;
$$;

create function authz.finance_uuid(p_value text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  if p_value is null then
    return null;
  end if;
  if p_value !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    perform authz.finance_invalid();
  end if;
  return p_value::uuid;
end;
$$;

create function authz.finance_date(p_value text) returns date
language plpgsql immutable set search_path = '' as $$
declare
  v date;
begin
  if p_value is null then
    return null;
  end if;
  if p_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    perform authz.finance_invalid();
  end if;
  begin
    v := p_value::date;
  exception when others then
    perform authz.finance_invalid();
  end;
  if to_char(v, 'YYYY-MM-DD') <> p_value then
    perform authz.finance_invalid();
  end if;
  return v;
end;
$$;

-- Whole paise as decimal digits (string, or a JSON integer for policy fields).
create function authz.finance_paise(p_fields jsonb, p_key text, p_min bigint) returns bigint
language plpgsql immutable set search_path = '' as $$
declare
  v jsonb := p_fields -> p_key;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    return null;
  end if;
  if jsonb_typeof(v) not in ('string', 'number') or (v #>> '{}') !~ '^(0|[1-9][0-9]{0,17})$'
     or (v #>> '{}')::bigint < p_min then
    perform authz.finance_invalid();
  end if;
  return (v #>> '{}')::bigint;
end;
$$;

-- Mobile after removing spaces and a +91 or leading 0; null when absent.
create function authz.finance_mobile(p_value text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v text;
begin
  if p_value is null or btrim(p_value) = '' then
    return null;
  end if;
  v := replace(p_value, ' ', '');
  if left(v, 3) = '+91' then
    v := substr(v, 4);
  elsif left(v, 1) = '0' then
    v := substr(v, 2);
  end if;
  if v !~ '^[6-9][0-9]{9}$' then
    perform authz.finance_invalid();
  end if;
  return v;
end;
$$;

create function authz.finance_reason(p_value text) returns text
language plpgsql immutable set search_path = '' as $$
declare
  v text := authz.finance_text(p_value, 10, 500, true);
begin
  if v is null then
    perform authz.finance_invalid();
  end if;
  return v;
end;
$$;

-- ---------------------------------------------------------------------------
-- Request identity (contract section 11)
-- ---------------------------------------------------------------------------

create function authz.finance_payload_hash(p_payload jsonb) returns text
language sql immutable set search_path = '' as $$
  select encode(sha256(convert_to(coalesce(p_payload, 'null'::jsonb)::text, 'UTF8')), 'hex')
$$;

-- The stored result (outcome 'existing') for an exact retry, null for a new
-- request; request_conflict for another actor, command or payload.
create function authz.finance_replay(p_entity uuid, p_request uuid, p_command text, p_payload jsonb) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.finance_command_results%rowtype;
begin
  if p_request is null then
    perform authz.finance_invalid();
  end if;
  select * into v from public.finance_command_results r
  where r.legal_entity_id = p_entity and r.request_id = p_request;
  if v.request_id is null then
    return null;
  end if;
  if v.actor is distinct from (select auth.uid()) or v.command <> p_command
     or v.payload_hash <> authz.finance_payload_hash(p_payload) then
    raise exception 'request_conflict' using errcode = '40001';
  end if;
  return v.result || jsonb_build_object('outcome', 'existing');
end;
$$;

create function authz.finance_remember(p_entity uuid, p_request uuid, p_command text, p_payload jsonb, p_result jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  begin
    insert into public.finance_command_results (legal_entity_id, request_id, actor, command, payload_hash, result)
    values (p_entity, p_request, (select auth.uid()), p_command, authz.finance_payload_hash(p_payload), p_result);
  exception when unique_violation then
    raise exception 'request_conflict' using errcode = '40001';
  end;
  return p_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Locks
-- ---------------------------------------------------------------------------

create function authz.finance_lock_policy(p_entity uuid, p_for_update boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_for_update then
    perform 1 from public.finance_policy_heads h where h.legal_entity_id = p_entity for update;
  else
    perform 1 from public.finance_policy_heads h where h.legal_entity_id = p_entity for share;
  end if;
  if not found then
    raise exception 'not_configured' using errcode = '55000';
  end if;
end;
$$;

create function authz.finance_lock_deal(p_deal uuid) returns public.deals
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.deals%rowtype;
begin
  insert into public.finance_deal_heads (deal_id, legal_entity_id)
  select d.id, d.legal_entity_id from public.deals d where d.id = p_deal
  on conflict (deal_id) do nothing;
  perform 1 from public.finance_deal_heads h where h.deal_id = p_deal for update;
  select * into v from public.deals d where d.id = p_deal;
  return v;
end;
$$;

-- Latest version with effective_at <= p_at.
create function authz.finance_policy_at(p_entity uuid, p_at timestamptz) returns public.finance_policy_versions
language sql stable security definer set search_path = '' as $$
  select * from public.finance_policy_versions v
  where v.legal_entity_id = p_entity and v.effective_at <= p_at
  order by v.effective_at desc, v.version_no desc
  limit 1
$$;

-- Receipt command prelude: permission and gate on the receipt's entity and
-- deal, then the deal head lock, then the receipt row lock.
create function authz.finance_receipt_for_command(p_receipt uuid) returns public.customer_receipts
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.customer_receipts%rowtype;
  v_synthetic boolean;
begin
  select * into r from public.customer_receipts x where x.id = p_receipt;
  if r.id is null then
    if coalesce(authz.session_ok(), false) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = r.deal_id;
  perform authz.finance_require_accounts(r.legal_entity_id, v_synthetic);
  perform authz.finance_lock_deal(r.deal_id);
  select * into r from public.customer_receipts x where x.id = p_receipt for update;
  return r;
end;
$$;

-- ---------------------------------------------------------------------------
-- Evidence, posting and per-viewer actions
-- ---------------------------------------------------------------------------

create function authz.finance_has_evidence(p_receipt uuid, p_kinds text[], p_after bigint) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.finance_evidence e
    where e.receipt_id = p_receipt and e.kind = any (p_kinds) and e.status = 'stored' and e.seq > p_after)
$$;

create function authz.finance_evidence_seq() returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(max(e.seq), 0) from public.finance_evidence e
$$;

-- Deposit status of a receipt's active membership (null when none).
create function authz.finance_receipt_deposit_status(p_receipt uuid) returns text
language sql stable security definer set search_path = '' as $$
  select d.status from public.cash_deposit_items i
  join public.cash_deposits d on d.id = i.deposit_id
  where i.receipt_id = p_receipt and not i.released
$$;

-- What this viewer may do with a receipt (ActionBlock per action; null = allowed).
-- Commands raise from the same decisions (authz.finance_raise_block).
create function authz.finance_receipt_actions(p_receipt uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  r public.customer_receipts%rowtype;
  v_me uuid := (select auth.uid());
  v_conflict boolean;
  v_deposit text;
begin
  select * into r from public.customer_receipts x where x.id = p_receipt;
  if r.id is null then
    return null;
  end if;
  v_conflict := authz.finance_deal_conflict(r.deal_id);
  v_deposit := authz.finance_receipt_deposit_status(r.id);
  return jsonb_build_object(
    'verify', case
      when r.status <> 'recorded' then 'wrong_state'
      when r.recorded_by = v_me then 'own_record'
      when v_conflict then 'deal_conflict'
      when r.mode in ('bank_transfer', 'upi') and not authz.finance_has_evidence(r.id, array['bank_proof'], 0) then 'evidence_required'
      when r.mode = 'cheque' and not authz.finance_has_evidence(r.id, array['cheque_image'], 0) then 'evidence_required'
      else null end,
    'reject', case
      when r.status <> 'recorded' then 'wrong_state'
      when r.recorded_by = v_me then 'own_record'
      when v_conflict then 'deal_conflict'
      else null end,
    'cheque_clear', case
      when r.mode <> 'cheque' or r.status <> 'pending_clearance' then 'wrong_state'
      when r.recorded_by = v_me then 'own_record'
      when v_conflict then 'deal_conflict'
      when not authz.finance_has_evidence(r.id, array['bank_proof'], r.evidence_watermark) then 'evidence_required'
      else null end,
    'cheque_mark', case
      when r.mode <> 'cheque' or r.status <> 'pending_clearance' then 'wrong_state'
      when r.recorded_by = v_me then 'own_record'
      when v_conflict then 'deal_conflict'
      else null end,
    'cheque_represent', case
      when r.mode <> 'cheque' or r.status <> 'bounced' then 'wrong_state'
      when r.recorded_by = v_me then 'own_record'
      when v_conflict then 'deal_conflict'
      when not authz.finance_mode_allowed(r.legal_entity_id, r.mode) then 'mode_not_live'
      when not authz.finance_has_evidence(r.id, array['cheque_image', 'bank_proof'], r.evidence_watermark) then 'evidence_required'
      else null end,
    'reverse', case
      when not ((r.mode <> 'cheque' and r.status = 'verified') or (r.mode = 'cheque' and r.status = 'cleared')) then 'wrong_state'
      when r.verified_by = v_me then 'own_verification'
      when r.mode = 'cheque' and r.cleared_by = v_me then 'own_clearance'
      when v_conflict then 'deal_conflict'
      when v_deposit = 'recorded' then 'in_unverified_deposit'
      else null end,
    'correct', case
      when r.corrected_by_receipt_id is not null
        or not ((r.status = 'rejected' and r.rejection_kind = 'data_error')
                or (r.status = 'reversed' and r.reversal_kind = 'data_error')) then 'wrong_state'
      when not authz.finance_mode_allowed(r.legal_entity_id, r.mode) then 'mode_not_live'
      else null end);
end;
$$;

create function authz.finance_raise_block(p_block text) returns void
language plpgsql volatile set search_path = '' as $$
begin
  if p_block is null then
    return;
  elsif p_block in ('own_record', 'own_verification', 'own_clearance', 'deal_conflict') then
    raise exception 'not_self_approval' using errcode = '42501';
  elsif p_block in ('wrong_state', 'in_unverified_deposit') then
    raise exception 'wrong_state' using errcode = '55000';
  elsif p_block in ('evidence_required', 'mode_not_live', 'billing_not_verified') then
    raise exception '%', p_block using errcode = '55000';
  end if;
  raise exception 'wrong_state' using errcode = '55000';
end;
$$;

-- ---------------------------------------------------------------------------
-- Read shapes
-- ---------------------------------------------------------------------------

create function authz.finance_money_json(p_deal uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'availablePaise', (select coalesce(sum(l.credit_paise - l.debit_paise), 0)::text
                       from public.finance_journal_lines l where l.deal_id = p_deal and l.account = 'customer_advances'),
    'awaitingVerificationPaise', (select coalesce(sum(r.amount_paise), 0)::text from public.customer_receipts r
                                  where r.deal_id = p_deal and r.status = 'recorded' and r.mode <> 'cheque'),
    'chequesAwaitingClearancePaise', (select coalesce(sum(r.amount_paise), 0)::text from public.customer_receipts r
                                      where r.deal_id = p_deal and r.mode = 'cheque' and r.status in ('recorded', 'pending_clearance')))
$$;

create function authz.finance_policy_json(p_version uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'versionNo', v.version_no,
    'effectiveAt', v.effective_at,
    'receiptMaxPaise', v.receipt_max_paise::text,
    'cashPayerDayCapPaise', v.cash_payer_day_cap_paise::text,
    'cashTripCapPaise', v.cash_trip_cap_paise::text,
    'cashDepositDays', v.cash_deposit_days,
    'reconciliationRequired', v.reconciliation_required,
    'reason', v.reason,
    'createdByName', authz.finance_name(v.created_by),
    'createdAt', v.created_at)
  from public.finance_policy_versions v where v.id = p_version
$$;

create function authz.finance_evidence_list_json(p_receipt uuid, p_deposit uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', e.id, 'kind', e.kind, 'fileName', e.file_name, 'status', e.status, 'createdAt', e.created_at)
    order by e.seq), '[]'::jsonb)
  from public.finance_evidence e
  where e.status <> 'removed'
    and ((p_receipt is not null and e.receipt_id = p_receipt) or (p_deposit is not null and e.deposit_id = p_deposit))
$$;

create function authz.finance_receipt_json(p_receipt uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'receiptId', r.id,
    'receiptNo', r.receipt_no,
    'mode', r.mode,
    'status', r.status,
    'amountPaise', r.amount_paise::text,
    'receivedOn', to_char(r.received_on, 'YYYY-MM-DD'),
    'branchName', b.name,
    'collectorName', authz.finance_name(r.collector_user_id),
    'payerName', r.payer_name,
    'payerPanMasked', case when r.payer_pan is null then null else 'XXXXX' || substr(r.payer_pan, 6, 4) || 'X' end,
    'payerMobileMasked', case when r.payer_mobile is null then null else 'XXXXXX' || right(r.payer_mobile, 4) end,
    'reference', r.reference,
    'chequeNumber', r.cheque_number,
    'micrCode', r.micr_code,
    'chequeDate', to_char(r.cheque_date, 'YYYY-MM-DD'),
    'rejectionKind', r.rejection_kind,
    'reversalKind', r.reversal_kind,
    'reason', r.reason,
    'correctsReceiptNo', (select o.receipt_no from public.customer_receipts o where o.id = r.corrects_receipt_id),
    'correctedByReceiptNo', (select o.receipt_no from public.customer_receipts o where o.id = r.corrected_by_receipt_id),
    'recordedByName', authz.finance_name(r.recorded_by),
    'recordedAt', r.recorded_at,
    'verifiedByName', authz.finance_name(r.verified_by),
    'verifiedAt', r.verified_at,
    'outcomeDate', to_char(r.outcome_date, 'YYYY-MM-DD'),
    'policyVersionNo', (select v.version_no from public.finance_policy_versions v where v.id = r.policy_version_id),
    'evidence', authz.finance_evidence_list_json(r.id, null),
    'actions', authz.finance_receipt_actions(r.id))
  from public.customer_receipts r
  join public.branches b on b.id = r.branch_id
  where r.id = p_receipt
$$;

create function authz.finance_queue_item_json(p_deal uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'dealId', d.id,
    'dealReference', d.reference,
    'dealTitle', d.title,
    'branchName', b.name,
    'hasConfirmedBooking', v.id is not null,
    'billingStatus', bp.status,
    'reviewStatus', case when v.id is null then null else coalesce(rv.status, 'pending') end,
    'money', authz.finance_money_json(d.id),
    'updatedAt', greatest(d.created_at, v.confirmed_at, bp.updated_at, rv.updated_at,
      (select max(r.updated_at) from public.customer_receipts r where r.deal_id = d.id)))
  from public.deals d
  join public.branches b on b.id = d.branch_id
  left join public.booking_versions v on v.deal_id = d.id and v.status = 'confirmed'
  left join public.customer_billing_profiles bp on bp.deal_id = d.id
  left join public.accounts_booking_reviews rv on rv.booking_version_id = v.id
  where d.id = p_deal
$$;

create function authz.finance_deposit_json(p_deposit uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'depositId', dp.id,
    'depositedOn', to_char(dp.deposited_on, 'YYYY-MM-DD'),
    'bankReference', dp.bank_reference,
    'totalPaise', dp.total_paise::text,
    'status', dp.status,
    'receiptNos', coalesce((select jsonb_agg(r.receipt_no order by r.receipt_no)
                            from public.cash_deposit_items i join public.customer_receipts r on r.id = i.receipt_id
                            where i.deposit_id = dp.id), '[]'::jsonb),
    'recordedByName', authz.finance_name(dp.recorded_by),
    'verifiedByName', authz.finance_name(dp.verified_by),
    'rejectReason', dp.reject_reason,
    'evidence', authz.finance_evidence_list_json(null, dp.id),
    'actions', jsonb_build_object(
      'verify', case
        when dp.status <> 'recorded' then 'wrong_state'
        when dp.recorded_by = (select auth.uid()) then 'own_record'
        when exists (select 1 from public.cash_deposit_items i join public.customer_receipts r on r.id = i.receipt_id
                     where i.deposit_id = dp.id and authz.finance_deal_conflict(r.deal_id)) then 'deal_conflict'
        else null end,
      'reject', case
        when dp.status <> 'recorded' then 'wrong_state'
        when dp.recorded_by = (select auth.uid()) then 'own_record'
        else null end))
  from public.cash_deposits dp where dp.id = p_deposit
$$;

create function authz.finance_reconciliation_json(p_reconciliation uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'reconciliationId', c.id,
    'businessDate', to_char(c.business_date, 'YYYY-MM-DD'),
    'countedPaise', c.counted_paise::text,
    'expectedPaise', c.expected_paise::text,
    'differencePaise', (c.counted_paise - c.expected_paise)::text,
    'unverifiedCashPaise', c.unverified_cash_paise::text,
    'note', c.note,
    'status', c.status,
    'stale', c.stale,
    'recordedByName', authz.finance_name(c.recorded_by),
    'verifiedByName', authz.finance_name(c.verified_by),
    'actions', jsonb_build_object('verify', case
      when c.status <> 'recorded' or c.stale then 'wrong_state'
      when c.recorded_by = (select auth.uid()) then 'own_record'
      else null end))
  from public.cash_reconciliations c where c.id = p_reconciliation
$$;

create function authz.finance_unresolved_json(p_branch uuid, p_policy uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with pol as (
    select v.cash_deposit_days, v.reconciliation_required from public.finance_policy_versions v where v.id = p_policy
  ), today as (
    select authz.finance_today() as d
  ), items as (
    select 'deposit_overdue'::text as kind, r.id as receipt_id, r.receipt_no, r.received_on as business_date,
           r.amount_paise, 1 as ord
    from public.customer_receipts r, pol, today
    where r.branch_id = p_branch and r.mode = 'cash' and r.status = 'verified'
      and authz.finance_receipt_deposit_status(r.id) is distinct from 'verified'
      and today.d > authz.finance_add_working_days(r.received_on, pol.cash_deposit_days)
    union all
    select 'verification_overdue', r.id, r.receipt_no, r.received_on, r.amount_paise, 2
    from public.customer_receipts r, pol, today
    where r.branch_id = p_branch and r.mode = 'cash' and r.status = 'recorded'
      and today.d > authz.finance_add_working_days(r.received_on, pol.cash_deposit_days)
    union all
    select 'reversed_undeposited', r.id, r.receipt_no, e.business_date, r.amount_paise, 3
    from public.customer_receipts r
    join public.finance_journal_entries e on e.receipt_id = r.id and e.kind = 'reversal_cash_undeposited'
    where r.branch_id = p_branch
    union all
    select 'reconciliation_missing', null, null, x.d, null, 4
    from (
      select r.received_on as d from public.customer_receipts r where r.branch_id = p_branch and r.mode = 'cash'
      union
      select e.business_date from public.finance_journal_entries e
      join public.finance_journal_lines l on l.entry_id = e.id
      where l.branch_id = p_branch and l.account = 'cash_in_hand'
    ) x, pol, today
    where pol.reconciliation_required and x.d < today.d and x.d >= today.d - 60
      and not exists (select 1 from public.cash_reconciliations c
                      where c.branch_id = p_branch and c.business_date = x.d and not c.stale)
    union all
    select 'reconciliation_stale', null, null, s.business_date, null, 5
    from (select distinct c.business_date from public.cash_reconciliations c where c.branch_id = p_branch and c.stale) s
    where not exists (select 1 from public.cash_reconciliations c
                      where c.branch_id = p_branch and c.business_date = s.business_date and not c.stale)
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'kind', i.kind, 'receiptId', i.receipt_id, 'receiptNo', i.receipt_no,
      'businessDate', to_char(i.business_date, 'YYYY-MM-DD'), 'amountPaise', i.amount_paise::text)
    order by i.ord, i.business_date, i.receipt_no), '[]'::jsonb)
  from items i
$$;

create function authz.finance_cash_branch_json(p_branch uuid, p_policy uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'branchId', b.id,
    'branchName', b.name,
    'cashInHandPaise', (select coalesce(sum(l.debit_paise - l.credit_paise), 0)::text from public.finance_journal_lines l
                        where l.branch_id = b.id and l.account = 'cash_in_hand'),
    'recordedUnverifiedCashPaise', (select coalesce(sum(r.amount_paise), 0)::text from public.customer_receipts r
                                    where r.branch_id = b.id and r.mode = 'cash' and r.status = 'recorded'),
    'undepositedVerified', coalesce((
      select jsonb_agg(jsonb_build_object('receiptId', r.id, 'receiptNo', r.receipt_no, 'amountPaise', r.amount_paise::text,
          'receivedOn', to_char(r.received_on, 'YYYY-MM-DD'), 'dealReference', d.reference)
        order by r.received_on, r.receipt_no)
      from public.customer_receipts r join public.deals d on d.id = r.deal_id
      where r.branch_id = b.id and r.mode = 'cash' and r.status = 'verified'
        and authz.finance_receipt_deposit_status(r.id) is null), '[]'::jsonb),
    'unresolved', authz.finance_unresolved_json(b.id, p_policy),
    'deposits', coalesce((
      select jsonb_agg(authz.finance_deposit_json(x.id) order by x.deposited_on desc, x.recorded_at desc)
      from (select dp.id, dp.deposited_on, dp.recorded_at from public.cash_deposits dp where dp.branch_id = b.id
            order by dp.deposited_on desc, dp.recorded_at desc limit 100) x), '[]'::jsonb),
    'reconciliations', coalesce((
      select jsonb_agg(authz.finance_reconciliation_json(x.id) order by x.business_date desc, x.recorded_at desc)
      from (select c.id, c.business_date, c.recorded_at from public.cash_reconciliations c where c.branch_id = b.id
            order by c.business_date desc, c.recorded_at desc limit 100) x), '[]'::jsonb))
  from public.branches b where b.id = p_branch
$$;

-- Approval decision for a booking review (null = may approve).
create function authz.finance_approve_block(p_version uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when coalesce(rv.status, 'pending') = 'approved' then 'wrong_state'
    when v.confirmed_by = (select auth.uid()) or authz.finance_deal_conflict(v.deal_id) then 'deal_conflict'
    when coalesce((select bp.status from public.customer_billing_profiles bp where bp.deal_id = v.deal_id), 'draft') <> 'verified'
      then 'billing_not_verified'
    else null
  end
  from public.booking_versions v
  left join public.accounts_booking_reviews rv on rv.booking_version_id = v.id
  where v.id = p_version
$$;

-- ---------------------------------------------------------------------------
-- Commands: billing details (contract section 7)
-- ---------------------------------------------------------------------------

create function public.accounts_billing_save(
  p_deal_id uuid, p_expected_row_version integer, p_fields jsonb, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_old public.customer_billing_profiles%rowtype;
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id, 'expectedRowVersion', p_expected_row_version, 'fields', p_fields);
  v_result jsonb;
  v_name text;
  v_line1 text;
  v_line2 text;
  v_city text;
  v_state text;
  v_postal text;
  v_gstin text;
  v_changed text[] := '{}';
  v_row integer;
  v_review public.accounts_booking_reviews%rowtype;
begin
  select * into v_deal from public.deals d where d.id = p_deal_id;
  perform authz.finance_require_accounts(v_deal.legal_entity_id, v_deal.is_synthetic);
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  perform authz.finance_lock_deal(v_deal.id);
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'accounts_billing_save', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['billingName', 'addressLine1', 'addressLine2', 'city', 'stateCode', 'postalCode', 'gstin']) <> '{}'::jsonb
     or p_expected_row_version is null or p_expected_row_version < 0 then
    perform authz.finance_invalid();
  end if;
  v_name := authz.finance_text(authz.finance_field(p_fields, 'billingName'), 1, 200, false);
  v_line1 := authz.finance_text(authz.finance_field(p_fields, 'addressLine1'), 1, 200, false);
  v_line2 := authz.finance_text(authz.finance_field(p_fields, 'addressLine2'), 1, 200, false);
  v_city := authz.finance_text(authz.finance_field(p_fields, 'city'), 1, 120, false);
  v_state := authz.finance_text(authz.finance_field(p_fields, 'stateCode'), 1, 2, false);
  v_postal := authz.finance_text(authz.finance_field(p_fields, 'postalCode'), 1, 6, false);
  v_gstin := upper(authz.finance_text(authz.finance_field(p_fields, 'gstin'), 1, 15, false));
  if v_name is null or v_line1 is null or v_city is null or v_state is null or v_postal is null
     or v_state !~ '^(0[1-9]|[12][0-9]|3[0-8]|97)$' or v_postal !~ '^[1-9][0-9]{5}$'
     or (v_gstin is not null and (v_gstin !~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$' or left(v_gstin, 2) <> v_state)) then
    perform authz.finance_invalid();
  end if;

  select * into v_old from public.customer_billing_profiles b where b.deal_id = v_deal.id for update;
  if coalesce(v_old.row_version, 0) <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;

  if v_old.deal_id is null then
    insert into public.customer_billing_profiles (deal_id, legal_entity_id, billing_name, address_line1, address_line2,
      city, state_code, postal_code, gstin, status, updated_by)
    values (v_deal.id, v_deal.legal_entity_id, v_name, v_line1, v_line2, v_city, v_state, v_postal, v_gstin, 'draft',
      (select auth.uid()))
    returning row_version into v_row;
    v_changed := array['billingName', 'addressLine1', 'addressLine2', 'city', 'stateCode', 'postalCode', 'gstin'];
  else
    v_changed := array_remove(array[
      case when v_old.billing_name is distinct from v_name then 'billingName' end,
      case when v_old.address_line1 is distinct from v_line1 then 'addressLine1' end,
      case when v_old.address_line2 is distinct from v_line2 then 'addressLine2' end,
      case when v_old.city is distinct from v_city then 'city' end,
      case when v_old.state_code is distinct from v_state then 'stateCode' end,
      case when v_old.postal_code is distinct from v_postal then 'postalCode' end,
      case when v_old.gstin is distinct from v_gstin then 'gstin' end], null);
    update public.customer_billing_profiles b
    set billing_name = v_name, address_line1 = v_line1, address_line2 = v_line2, city = v_city,
        state_code = v_state, postal_code = v_postal, gstin = v_gstin, status = 'draft',
        verified_by = null, verified_at = null, row_version = b.row_version + 1,
        updated_by = (select auth.uid()), updated_at = now()
    where b.deal_id = v_deal.id
    returning row_version into v_row;
  end if;

  -- An approved review of the deal's confirmed booking returns to pending.
  select rv.* into v_review
  from public.accounts_booking_reviews rv
  join public.booking_versions v on v.id = rv.booking_version_id
  where v.deal_id = v_deal.id and v.status = 'confirmed'
  for update of rv;
  if v_review.status = 'approved' then
    update public.accounts_booking_reviews rv
    set status = 'pending', row_version = rv.row_version + 1, updated_at = now()
    where rv.id = v_review.id;
    perform authz.write_audit('finance.review_reset', v_deal.legal_entity_id, v_deal.branch_id, 'booking_version',
      v_review.booking_version_id, null, jsonb_build_object('cause', 'billing_saved'));
  end if;

  v_result := jsonb_build_object('outcome', case when v_old.deal_id is null then 'created' else 'updated' end,
    'id', v_deal.id, 'status', 'draft', 'rowVersion', v_row);
  perform authz.finance_remember(v_deal.legal_entity_id, p_request_id, 'accounts_billing_save', v_payload, v_result);
  perform authz.write_audit('finance.billing_saved', v_deal.legal_entity_id, v_deal.branch_id, 'deal', v_deal.id, null,
    jsonb_build_object('changedFields', to_jsonb(v_changed), 'rowVersion', v_row));
  return v_result;
end;
$$;

create function public.accounts_billing_verify(p_deal_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_old public.customer_billing_profiles%rowtype;
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_row integer;
begin
  select * into v_deal from public.deals d where d.id = p_deal_id;
  perform authz.finance_require_accounts(v_deal.legal_entity_id, v_deal.is_synthetic);
  if p_request_id is null or p_expected_row_version is null then
    perform authz.finance_invalid();
  end if;
  perform authz.finance_lock_deal(v_deal.id);
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'accounts_billing_verify', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  select * into v_old from public.customer_billing_profiles b where b.deal_id = v_deal.id for update;
  if v_old.deal_id is null then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if v_old.row_version <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if v_old.status = 'verified' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  -- The editor may verify: a data-quality step, not a money approval (contract 7).
  update public.customer_billing_profiles b
  set status = 'verified', verified_by = (select auth.uid()), verified_at = now(), row_version = b.row_version + 1
  where b.deal_id = v_deal.id
  returning row_version into v_row;

  v_result := jsonb_build_object('outcome', 'updated', 'id', v_deal.id, 'status', 'verified', 'rowVersion', v_row);
  perform authz.finance_remember(v_deal.legal_entity_id, p_request_id, 'accounts_billing_verify', v_payload, v_result);
  perform authz.write_audit('finance.billing_verified', v_deal.legal_entity_id, v_deal.branch_id, 'deal', v_deal.id, null,
    jsonb_build_object('editedBy', v_old.updated_by, 'verifiedBy', (select auth.uid()), 'rowVersion', v_row));
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Commands: booking review (contract section 8)
-- ---------------------------------------------------------------------------

create function authz.finance_confirmed_version(p_version uuid) returns public.booking_versions
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.booking_versions%rowtype;
  v_synthetic boolean;
begin
  select * into v from public.booking_versions x where x.id = p_version and x.status = 'confirmed';
  if v.id is null then
    if coalesce(authz.session_ok(), false) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = v.deal_id;
  perform authz.finance_require_accounts(v.legal_entity_id, v_synthetic);
  return v;
end;
$$;

create function public.accounts_review_return(p_booking_version_id uuid, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_review public.accounts_booking_reviews%rowtype;
  v_payload jsonb := jsonb_build_object('bookingVersionId', p_booking_version_id, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  v_ver := authz.finance_confirmed_version(p_booking_version_id);
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  perform authz.finance_lock_deal(v_ver.deal_id);
  v_result := authz.finance_replay(v_ver.legal_entity_id, p_request_id, 'accounts_review_return', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  v_reason := authz.finance_reason(p_reason);

  select * into v_review from public.accounts_booking_reviews rv where rv.booking_version_id = v_ver.id for update;
  if v_review.status = 'returned' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if v_review.id is null then
    insert into public.accounts_booking_reviews (booking_version_id, deal_id, legal_entity_id, status, return_reason,
      reviewed_by, reviewed_at)
    values (v_ver.id, v_ver.deal_id, v_ver.legal_entity_id, 'returned', v_reason, (select auth.uid()), now())
    returning * into v_review;
  else
    update public.accounts_booking_reviews rv
    set status = 'returned', return_reason = v_reason, reviewed_by = (select auth.uid()), reviewed_at = now(),
        row_version = rv.row_version + 1, updated_at = now()
    where rv.id = v_review.id
    returning * into v_review;
  end if;

  v_result := jsonb_build_object('outcome', 'updated', 'id', v_review.id, 'status', 'returned', 'rowVersion', v_review.row_version);
  perform authz.finance_remember(v_ver.legal_entity_id, p_request_id, 'accounts_review_return', v_payload, v_result);
  perform authz.write_audit('finance.review_returned', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id,
    v_reason, jsonb_build_object('reviewId', v_review.id));
  return v_result;
end;
$$;

create function public.accounts_review_approve(p_booking_version_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_review public.accounts_booking_reviews%rowtype;
  v_payload jsonb := jsonb_build_object('bookingVersionId', p_booking_version_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  v_ver := authz.finance_confirmed_version(p_booking_version_id);
  if p_request_id is null or p_expected_row_version is null then
    perform authz.finance_invalid();
  end if;
  perform authz.finance_lock_deal(v_ver.deal_id);
  v_result := authz.finance_replay(v_ver.legal_entity_id, p_request_id, 'accounts_review_approve', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  select * into v_review from public.accounts_booking_reviews rv where rv.booking_version_id = v_ver.id for update;
  if coalesce(v_review.row_version, 0) <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  perform authz.finance_raise_block(authz.finance_approve_block(v_ver.id));

  -- Approval posts no money, issues no document and never changes the booking.
  if v_review.id is null then
    insert into public.accounts_booking_reviews (booking_version_id, deal_id, legal_entity_id, status, reviewed_by, reviewed_at)
    values (v_ver.id, v_ver.deal_id, v_ver.legal_entity_id, 'approved', (select auth.uid()), now())
    returning * into v_review;
  else
    update public.accounts_booking_reviews rv
    set status = 'approved', reviewed_by = (select auth.uid()), reviewed_at = now(),
        row_version = rv.row_version + 1, updated_at = now()
    where rv.id = v_review.id
    returning * into v_review;
  end if;

  v_result := jsonb_build_object('outcome', 'updated', 'id', v_review.id, 'status', 'approved', 'rowVersion', v_review.row_version);
  perform authz.finance_remember(v_ver.legal_entity_id, p_request_id, 'accounts_review_approve', v_payload, v_result);
  perform authz.write_audit('finance.review_approved', v_ver.legal_entity_id, v_ver.branch_id, 'booking_version', v_ver.id,
    null, jsonb_build_object('reviewId', v_review.id));
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Commands: receipts (contract section 9)
-- ---------------------------------------------------------------------------

create function public.receipt_record(p_deal_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
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

  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['mode', 'amountPaise', 'receivedOn', 'branchId', 'collectorUserId', 'payerName', 'payerPan',
                          'payerMobile', 'reference', 'micrCode', 'chequeNumber', 'chequeDate', 'accountPayee',
                          'bookingVersionId', 'correctsReceiptId', 'note']) <> '{}'::jsonb then
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
      policy_version_id, request_id, recorded_by, recorded_at)
    values (v_id, v_entity, v_deal.id, v_branch, v_no, v_fy, v_mode, 'recorded',
      v_amount, v_received, v_collector, v_payer, v_pan, v_mobile, v_reference, v_norm,
      v_micr, v_cheque_no, v_cheque_date, case when v_mode = 'cheque' then true end, v_booking, v_corrects, v_note,
      v_policy.id, p_request_id, (select auth.uid()), v_t);
  exception when unique_violation then
    raise exception 'duplicate_reference' using errcode = '23505';
  end;

  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'receiptNo', v_no, 'status', 'recorded');
  perform authz.finance_remember(v_entity, p_request_id, 'receipt_record', v_payload, v_result);
  perform authz.write_audit('finance.receipt_recorded', v_entity, v_branch, 'customer_receipt', v_id, null,
    jsonb_build_object('dealId', v_deal.id, 'receiptNo', v_no, 'mode', v_mode, 'policyVersionNo', v_policy.version_no,
      'correctsReceiptId', v_corrects));
  return v_result;
end;
$$;

create function public.receipt_verify(p_receipt_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.customer_receipts%rowtype;
  v_payload jsonb := jsonb_build_object('receiptId', p_receipt_id);
  v_result jsonb;
  v_status text;
begin
  r := authz.finance_receipt_for_command(p_receipt_id);
  v_result := authz.finance_replay(r.legal_entity_id, p_request_id, 'receipt_verify', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.finance_raise_block(authz.finance_receipt_actions(r.id) ->> 'verify');

  -- Cheques wait for bank clearance and post nothing yet.
  v_status := case when r.mode = 'cheque' then 'pending_clearance' else 'verified' end;
  -- A cheque's clearance or bounce proof must be newer than its presentation.
  update public.customer_receipts x
  set status = v_status, verified_by = (select auth.uid()), verified_at = now(), row_version = x.row_version + 1,
      evidence_watermark = case when r.mode = 'cheque' then authz.finance_evidence_seq() else x.evidence_watermark end,
      updated_at = now()
  where x.id = r.id;
  if r.mode <> 'cheque' then
    perform authz.finance_post(case when r.mode = 'cash' then 'receipt_cash' else 'receipt_bank' end,
      r.legal_entity_id, r.id, null, r.deal_id, r.branch_id, r.received_on, null, r.amount_paise);
  end if;

  v_result := jsonb_build_object('outcome', 'updated', 'id', r.id, 'receiptNo', r.receipt_no, 'status', v_status);
  perform authz.finance_remember(r.legal_entity_id, p_request_id, 'receipt_verify', v_payload, v_result);
  perform authz.write_audit('finance.receipt_verified', r.legal_entity_id, r.branch_id, 'customer_receipt', r.id, null,
    jsonb_build_object('receiptNo', r.receipt_no, 'status', v_status, 'recordedBy', r.recorded_by));
  return v_result;
end;
$$;

create function public.receipt_reject(p_receipt_id uuid, p_kind text, p_reason text, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.customer_receipts%rowtype;
  v_payload jsonb := jsonb_build_object('receiptId', p_receipt_id, 'kind', p_kind, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  r := authz.finance_receipt_for_command(p_receipt_id);
  v_result := authz.finance_replay(r.legal_entity_id, p_request_id, 'receipt_reject', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_kind is null or p_kind not in ('not_received', 'data_error')
     or (r.corrects_receipt_id is not null and p_kind <> 'data_error') then
    perform authz.finance_invalid();
  end if;
  v_reason := authz.finance_reason(p_reason);
  perform authz.finance_raise_block(authz.finance_receipt_actions(r.id) ->> 'reject');

  update public.customer_receipts x
  set status = 'rejected', rejection_kind = p_kind, reason = v_reason, rejected_by = (select auth.uid()), rejected_at = now(),
      row_version = x.row_version + 1, updated_at = now()
  where x.id = r.id;

  v_result := jsonb_build_object('outcome', 'updated', 'id', r.id, 'receiptNo', r.receipt_no, 'status', 'rejected');
  perform authz.finance_remember(r.legal_entity_id, p_request_id, 'receipt_reject', v_payload, v_result);
  perform authz.write_audit('finance.receipt_rejected', r.legal_entity_id, r.branch_id, 'customer_receipt', r.id, v_reason,
    jsonb_build_object('receiptNo', r.receipt_no, 'kind', p_kind));
  return v_result;
end;
$$;

create function public.cheque_clear(p_receipt_id uuid, p_outcome_date date, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.customer_receipts%rowtype;
  v_payload jsonb := jsonb_build_object('receiptId', p_receipt_id, 'outcomeDate', p_outcome_date);
  v_result jsonb;
begin
  r := authz.finance_receipt_for_command(p_receipt_id);
  v_result := authz.finance_replay(r.legal_entity_id, p_request_id, 'cheque_clear', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_outcome_date is null then
    perform authz.finance_invalid();
  end if;
  perform authz.finance_raise_block(authz.finance_receipt_actions(r.id) ->> 'cheque_clear');
  if p_outcome_date < r.cheque_date or p_outcome_date > (r.cheque_date + interval '3 months')::date
     or p_outcome_date > authz.finance_today() then
    perform authz.finance_invalid();
  end if;

  update public.customer_receipts x
  set status = 'cleared', outcome_date = p_outcome_date, cleared_by = (select auth.uid()), cleared_at = now(),
      row_version = x.row_version + 1, updated_at = now()
  where x.id = r.id;
  perform authz.finance_post('receipt_bank', r.legal_entity_id, r.id, null, r.deal_id, r.branch_id, r.received_on, null, r.amount_paise);

  v_result := jsonb_build_object('outcome', 'updated', 'id', r.id, 'receiptNo', r.receipt_no, 'status', 'cleared');
  perform authz.finance_remember(r.legal_entity_id, p_request_id, 'cheque_clear', v_payload, v_result);
  perform authz.write_audit('finance.cheque_cleared', r.legal_entity_id, r.branch_id, 'customer_receipt', r.id, null,
    jsonb_build_object('receiptNo', r.receipt_no, 'outcomeDate', p_outcome_date));
  return v_result;
end;
$$;

create function public.cheque_mark(p_receipt_id uuid, p_kind text, p_outcome_date date, p_note text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.customer_receipts%rowtype;
  v_payload jsonb := jsonb_build_object('receiptId', p_receipt_id, 'kind', p_kind, 'outcomeDate', p_outcome_date, 'note', p_note);
  v_result jsonb;
  v_note text;
begin
  r := authz.finance_receipt_for_command(p_receipt_id);
  v_result := authz.finance_replay(r.legal_entity_id, p_request_id, 'cheque_mark', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_kind is null or p_kind not in ('bounced', 'stopped', 'cancelled') or p_outcome_date is null then
    perform authz.finance_invalid();
  end if;
  v_note := authz.finance_text(p_note, 10, 500, true);
  if p_kind = 'cancelled' and v_note is null then
    perform authz.finance_invalid();
  end if;
  perform authz.finance_raise_block(authz.finance_receipt_actions(r.id) ->> 'cheque_mark');
  if p_outcome_date < r.received_on or p_outcome_date > authz.finance_today() then
    perform authz.finance_invalid();
  end if;
  if p_kind in ('bounced', 'stopped') and not authz.finance_has_evidence(r.id, array['bank_proof'], r.evidence_watermark) then
    raise exception 'evidence_required' using errcode = '55000';
  end if;

  update public.customer_receipts x
  set status = p_kind, outcome_date = p_outcome_date, marked_by = (select auth.uid()), marked_at = now(),
      reason = coalesce(v_note, x.reason), evidence_watermark = authz.finance_evidence_seq(),
      row_version = x.row_version + 1, updated_at = now()
  where x.id = r.id;

  v_result := jsonb_build_object('outcome', 'updated', 'id', r.id, 'receiptNo', r.receipt_no, 'status', p_kind);
  perform authz.finance_remember(r.legal_entity_id, p_request_id, 'cheque_mark', v_payload, v_result);
  perform authz.write_audit('finance.cheque_marked', r.legal_entity_id, r.branch_id, 'customer_receipt', r.id, v_note,
    jsonb_build_object('receiptNo', r.receipt_no, 'kind', p_kind, 'outcomeDate', p_outcome_date));
  return v_result;
end;
$$;

create function public.cheque_represent(p_receipt_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.customer_receipts%rowtype;
  v_payload jsonb := jsonb_build_object('receiptId', p_receipt_id);
  v_result jsonb;
begin
  r := authz.finance_receipt_for_command(p_receipt_id);
  v_result := authz.finance_replay(r.legal_entity_id, p_request_id, 'cheque_represent', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.finance_raise_block(authz.finance_receipt_actions(r.id) ->> 'cheque_represent');

  -- Same receipt and amount: nothing is counted twice.
  update public.customer_receipts x
  set status = 'pending_clearance', outcome_date = null, represent_count = x.represent_count + 1,
      evidence_watermark = authz.finance_evidence_seq(), row_version = x.row_version + 1, updated_at = now()
  where x.id = r.id;

  v_result := jsonb_build_object('outcome', 'updated', 'id', r.id, 'receiptNo', r.receipt_no, 'status', 'pending_clearance');
  perform authz.finance_remember(r.legal_entity_id, p_request_id, 'cheque_represent', v_payload, v_result);
  perform authz.write_audit('finance.cheque_represented', r.legal_entity_id, r.branch_id, 'customer_receipt', r.id, null,
    jsonb_build_object('receiptNo', r.receipt_no, 'representCount', r.represent_count + 1));
  return v_result;
end;
$$;

create function public.receipt_reverse(p_receipt_id uuid, p_kind text, p_reason text, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.customer_receipts%rowtype;
  v_payload jsonb := jsonb_build_object('receiptId', p_receipt_id, 'kind', p_kind, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
  v_entry uuid;
  v_deposit text;
  v_kind text;
begin
  r := authz.finance_receipt_for_command(p_receipt_id);
  v_result := authz.finance_replay(r.legal_entity_id, p_request_id, 'receipt_reverse', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_kind is null or p_kind not in ('bank_return', 'not_received', 'data_error')
     or (p_kind = 'bank_return' and r.mode = 'cash')
     or (r.corrects_receipt_id is not null and p_kind <> 'data_error') then
    perform authz.finance_invalid();
  end if;
  v_reason := authz.finance_reason(p_reason);
  perform authz.finance_raise_block(authz.finance_receipt_actions(r.id) ->> 'reverse');

  select e.id into v_entry from public.finance_journal_entries e
  where e.receipt_id = r.id and e.kind in ('receipt_bank', 'receipt_cash');
  if r.mode = 'cash' then
    -- Lock 4: the deposit holding this cash, if any.
    select d.status into v_deposit from public.cash_deposit_items i
    join public.cash_deposits d on d.id = i.deposit_id
    where i.receipt_id = r.id and not i.released
    for share of d;
    if v_deposit = 'recorded' then
      raise exception 'wrong_state' using errcode = '55000';
    end if;
    v_kind := case when v_deposit = 'verified' then 'reversal_cash_deposited' else 'reversal_cash_undeposited' end;
  else
    v_kind := 'reversal_bank';
  end if;

  update public.customer_receipts x
  set status = 'reversed', reversal_kind = p_kind, reason = v_reason, reversed_by = (select auth.uid()), reversed_at = now(),
      row_version = x.row_version + 1, updated_at = now()
  where x.id = r.id;
  perform authz.finance_post(v_kind, r.legal_entity_id, r.id, null, r.deal_id, r.branch_id, authz.finance_today(), v_entry,
    r.amount_paise);

  v_result := jsonb_build_object('outcome', 'updated', 'id', r.id, 'receiptNo', r.receipt_no, 'status', 'reversed');
  perform authz.finance_remember(r.legal_entity_id, p_request_id, 'receipt_reverse', v_payload, v_result);
  perform authz.write_audit('finance.receipt_reversed', r.legal_entity_id, r.branch_id, 'customer_receipt', r.id, v_reason,
    jsonb_build_object('receiptNo', r.receipt_no, 'kind', p_kind, 'entryKind', v_kind));
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Commands: cash custody and reconciliation (contract section 12)
-- ---------------------------------------------------------------------------

-- Locks the deal heads of a deposit's receipts (ascending deal id, gate
-- checked per deal), then the receipt rows ascending.
create function authz.finance_lock_deposit_receipts(p_entity uuid, p_receipts uuid[]) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v record;
  v_issue text;
begin
  for v in
    select distinct r.deal_id, d.is_synthetic
    from public.customer_receipts r join public.deals d on d.id = r.deal_id
    where r.id = any (p_receipts) and r.legal_entity_id = p_entity
    order by r.deal_id
  loop
    v_issue := authz.finance_gate_issue(p_entity, v.is_synthetic);
    if v_issue is not null then
      raise exception '%', v_issue using errcode = '55000';
    end if;
    perform authz.finance_lock_deal(v.deal_id);
  end loop;
  perform 1 from public.customer_receipts r where r.id = any (p_receipts) order by r.id for update;
end;
$$;

create function public.cash_deposit_record(
  p_branch_id uuid, p_receipt_ids uuid[], p_deposited_on date, p_bank_reference text, p_evidence_id uuid, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_branch public.branches%rowtype;
  v_ids uuid[];
  v_payload jsonb;
  v_result jsonb;
  v_reference text;
  v_ev public.finance_evidence%rowtype;
  v_total bigint;
  v_latest date;
  v_count integer;
  v_id uuid := gen_random_uuid();
begin
  select * into v_branch from public.branches b where b.id = p_branch_id;
  perform authz.finance_require_accounts(v_branch.legal_entity_id, null);
  if p_request_id is null or p_receipt_ids is null or cardinality(p_receipt_ids) not between 1 and 200
     or array_position(p_receipt_ids, null) is not null then
    perform authz.finance_invalid();
  end if;
  select array_agg(distinct x order by x) into v_ids from unnest(p_receipt_ids) as x;
  if cardinality(v_ids) <> cardinality(p_receipt_ids) then
    perform authz.finance_invalid();
  end if;
  v_payload := jsonb_build_object('branchId', p_branch_id, 'receiptIds', to_jsonb(v_ids), 'depositedOn', p_deposited_on,
    'bankReference', p_bank_reference, 'evidenceId', p_evidence_id);
  perform authz.finance_lock_deposit_receipts(v_branch.legal_entity_id, v_ids);
  v_result := authz.finance_replay(v_branch.legal_entity_id, p_request_id, 'cash_deposit_record', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  select count(*), sum(r.amount_paise), max(r.received_on) into v_count, v_total, v_latest
  from public.customer_receipts r
  where r.id = any (v_ids) and r.legal_entity_id = v_branch.legal_entity_id and r.branch_id = v_branch.id and r.mode = 'cash';
  if v_count <> cardinality(v_ids) then
    perform authz.finance_invalid();
  end if;
  if exists (select 1 from public.customer_receipts r where r.id = any (v_ids)
             and (r.status <> 'verified' or authz.finance_receipt_deposit_status(r.id) is not null)) then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  v_reference := authz.finance_text(p_bank_reference, 3, 60, false);
  if p_deposited_on is null or p_deposited_on < v_latest or p_deposited_on > authz.finance_today()
     or v_reference is null or v_reference !~ '^[A-Za-z0-9/ .-]{3,60}$' then
    perform authz.finance_invalid();
  end if;

  -- Lock 4: the deposit slip.
  select * into v_ev from public.finance_evidence e where e.id = p_evidence_id for update;
  if v_ev.id is null or v_ev.kind <> 'deposit_slip' or v_ev.status <> 'stored' or v_ev.deposit_id is not null
     or v_ev.branch_id is distinct from v_branch.id or v_ev.legal_entity_id <> v_branch.legal_entity_id then
    raise exception 'evidence_required' using errcode = '55000';
  end if;

  -- Custody moves to the bank; no customer receipt is created.
  insert into public.cash_deposits (id, legal_entity_id, branch_id, deposited_on, bank_reference, total_paise, request_id, recorded_by)
  values (v_id, v_branch.legal_entity_id, v_branch.id, p_deposited_on, v_reference, v_total, p_request_id, (select auth.uid()));
  begin
    insert into public.cash_deposit_items (deposit_id, receipt_id, legal_entity_id, amount_paise)
    select v_id, r.id, r.legal_entity_id, r.amount_paise from public.customer_receipts r where r.id = any (v_ids);
  exception when unique_violation then
    raise exception 'wrong_state' using errcode = '55000';
  end;
  update public.finance_evidence e set deposit_id = v_id, updated_at = now() where e.id = v_ev.id;

  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'status', 'recorded');
  perform authz.finance_remember(v_branch.legal_entity_id, p_request_id, 'cash_deposit_record', v_payload, v_result);
  perform authz.write_audit('finance.deposit_recorded', v_branch.legal_entity_id, v_branch.id, 'cash_deposit', v_id, null,
    jsonb_build_object('receiptCount', cardinality(v_ids), 'evidenceId', v_ev.id));
  return v_result;
end;
$$;

create function authz.finance_deposit_for_command(p_deposit uuid) returns public.cash_deposits
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.cash_deposits%rowtype;
  v_ids uuid[];
begin
  select * into v from public.cash_deposits d where d.id = p_deposit;
  if v.id is null then
    if coalesce(authz.session_ok(), false) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.finance_require_accounts(v.legal_entity_id, null);
  select array_agg(i.receipt_id order by i.receipt_id) into v_ids from public.cash_deposit_items i where i.deposit_id = v.id;
  perform authz.finance_lock_deposit_receipts(v.legal_entity_id, v_ids);
  select * into v from public.cash_deposits d where d.id = p_deposit for update;
  return v;
end;
$$;

create function public.cash_deposit_verify(p_deposit_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.cash_deposits%rowtype;
  v_payload jsonb := jsonb_build_object('depositId', p_deposit_id);
  v_result jsonb;
begin
  v := authz.finance_deposit_for_command(p_deposit_id);
  v_result := authz.finance_replay(v.legal_entity_id, p_request_id, 'cash_deposit_verify', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.finance_raise_block(authz.finance_deposit_json(v.id) -> 'actions' ->> 'verify');

  update public.cash_deposits d
  set status = 'verified', verified_by = (select auth.uid()), verified_at = now(), updated_at = now()
  where d.id = v.id;
  -- Custody only: customer funds are unchanged.
  perform authz.finance_post('deposit', v.legal_entity_id, null, v.id, null, v.branch_id, v.deposited_on, null, v.total_paise);

  v_result := jsonb_build_object('outcome', 'updated', 'id', v.id, 'status', 'verified');
  perform authz.finance_remember(v.legal_entity_id, p_request_id, 'cash_deposit_verify', v_payload, v_result);
  perform authz.write_audit('finance.deposit_verified', v.legal_entity_id, v.branch_id, 'cash_deposit', v.id, null,
    jsonb_build_object('recordedBy', v.recorded_by));
  return v_result;
end;
$$;

create function public.cash_deposit_reject(p_deposit_id uuid, p_reason text, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.cash_deposits%rowtype;
  v_payload jsonb := jsonb_build_object('depositId', p_deposit_id, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  v := authz.finance_deposit_for_command(p_deposit_id);
  v_result := authz.finance_replay(v.legal_entity_id, p_request_id, 'cash_deposit_reject', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  v_reason := authz.finance_reason(p_reason);
  perform authz.finance_raise_block(authz.finance_deposit_json(v.id) -> 'actions' ->> 'reject');

  update public.cash_deposits d
  set status = 'rejected', rejected_by = (select auth.uid()), rejected_at = now(), reject_reason = v_reason, updated_at = now()
  where d.id = v.id;
  update public.cash_deposit_items i set released = true where i.deposit_id = v.id;
  update public.finance_evidence e set released = true, updated_at = now() where e.deposit_id = v.id;

  v_result := jsonb_build_object('outcome', 'updated', 'id', v.id, 'status', 'rejected');
  perform authz.finance_remember(v.legal_entity_id, p_request_id, 'cash_deposit_reject', v_payload, v_result);
  perform authz.write_audit('finance.deposit_rejected', v.legal_entity_id, v.branch_id, 'cash_deposit', v.id, v_reason,
    jsonb_build_object('recordedBy', v.recorded_by));
  return v_result;
end;
$$;

create function public.cash_reconciliation_record(
  p_branch_id uuid, p_business_date date, p_counted_paise bigint, p_note text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_branch public.branches%rowtype;
  v_payload jsonb := jsonb_build_object('branchId', p_branch_id, 'businessDate', p_business_date,
    'countedPaise', p_counted_paise::text, 'note', p_note);
  v_result jsonb;
  v_note text;
  v_expected bigint;
  v_unverified bigint;
  v_id uuid := gen_random_uuid();
  v_today date := authz.finance_today();
begin
  select * into v_branch from public.branches b where b.id = p_branch_id;
  perform authz.finance_require_accounts(v_branch.legal_entity_id, null);
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  -- Serialises with cash postings for this branch (see authz.finance_post),
  -- and with an exact retry of this command.
  perform pg_advisory_xact_lock(hashtextextended('cash-branch|' || v_branch.id::text, 0));
  v_result := authz.finance_replay(v_branch.legal_entity_id, p_request_id, 'cash_reconciliation_record', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_business_date is null or p_business_date not between v_today - 90 and v_today
     or p_counted_paise is null or p_counted_paise < 0 or v_branch.status <> 'enabled' then
    perform authz.finance_invalid();
  end if;
  v_note := authz.finance_text(p_note, 10, 500, true);

  if exists (select 1 from public.cash_reconciliations c
             where c.branch_id = v_branch.id and c.business_date = p_business_date and not c.stale) then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  select coalesce(sum(l.debit_paise - l.credit_paise), 0) into v_expected
  from public.finance_journal_lines l
  join public.finance_journal_entries e on e.id = l.entry_id
  where l.branch_id = v_branch.id and l.account = 'cash_in_hand' and e.business_date <= p_business_date;
  select coalesce(sum(r.amount_paise), 0) into v_unverified
  from public.customer_receipts r
  where r.branch_id = v_branch.id and r.mode = 'cash' and r.status = 'recorded' and r.received_on <= p_business_date;
  if p_counted_paise <> v_expected and v_note is null then
    perform authz.finance_invalid();
  end if;

  begin
    insert into public.cash_reconciliations (id, legal_entity_id, branch_id, business_date, counted_paise, expected_paise,
      unverified_cash_paise, note, request_id, recorded_by)
    values (v_id, v_branch.legal_entity_id, v_branch.id, p_business_date, p_counted_paise, v_expected, v_unverified, v_note,
      p_request_id, (select auth.uid()));
  exception when unique_violation then
    raise exception 'wrong_state' using errcode = '55000';
  end;

  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'status', 'recorded');
  perform authz.finance_remember(v_branch.legal_entity_id, p_request_id, 'cash_reconciliation_record', v_payload, v_result);
  perform authz.write_audit('finance.reconciliation_recorded', v_branch.legal_entity_id, v_branch.id, 'cash_reconciliation',
    v_id, null, jsonb_build_object('businessDate', p_business_date, 'balanced', p_counted_paise = v_expected));
  return v_result;
end;
$$;

create function public.cash_reconciliation_verify(p_reconciliation_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.cash_reconciliations%rowtype;
  v_payload jsonb := jsonb_build_object('reconciliationId', p_reconciliation_id);
  v_result jsonb;
begin
  select * into v from public.cash_reconciliations c where c.id = p_reconciliation_id;
  if v.id is null then
    if coalesce(authz.session_ok(), false) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.finance_require_accounts(v.legal_entity_id, null);
  select * into v from public.cash_reconciliations c where c.id = p_reconciliation_id for update;
  v_result := authz.finance_replay(v.legal_entity_id, p_request_id, 'cash_reconciliation_verify', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.finance_raise_block(authz.finance_reconciliation_json(v.id) -> 'actions' ->> 'verify');

  update public.cash_reconciliations c
  set status = 'verified', verified_by = (select auth.uid()), verified_at = now(), updated_at = now()
  where c.id = v.id;

  v_result := jsonb_build_object('outcome', 'updated', 'id', v.id, 'status', 'verified');
  perform authz.finance_remember(v.legal_entity_id, p_request_id, 'cash_reconciliation_verify', v_payload, v_result);
  perform authz.write_audit('finance.reconciliation_verified', v.legal_entity_id, v.branch_id, 'cash_reconciliation', v.id,
    null, jsonb_build_object('recordedBy', v.recorded_by));
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Command: finance policy (contract section 6)
-- ---------------------------------------------------------------------------

create function public.finance_policy_update(
  p_entity_id uuid, p_fields jsonb, p_effective_at timestamptz, p_reason text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_payload jsonb := jsonb_build_object('entityId', p_entity_id, 'fields', p_fields, 'effectiveAt', p_effective_at,
    'reason', p_reason);
  v_result jsonb;
  v_latest public.finance_policy_versions%rowtype;
  v_limits public.finance_legal_limits%rowtype;
  v_receipt_max bigint;
  v_payer_cap bigint;
  v_trip_cap bigint;
  v_days integer;
  v_recon boolean;
  v_effective timestamptz;
  v_reason text;
  v_id uuid;
  v_value jsonb;
begin
  perform authz.finance_require_policy_manager(p_entity_id);
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  perform authz.finance_lock_policy(p_entity_id, true);
  v_result := authz.finance_replay(p_entity_id, p_request_id, 'finance_policy_update', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['receiptMaxPaise', 'cashPayerDayCapPaise', 'cashTripCapPaise', 'cashDepositDays',
                          'reconciliationRequired']) <> '{}'::jsonb then
    perform authz.finance_invalid();
  end if;
  select * into v_latest from public.finance_policy_versions v
  where v.legal_entity_id = p_entity_id order by v.version_no desc limit 1;
  select * into v_limits from public.finance_legal_limits l where l.legal_entity_id = p_entity_id;

  -- Omitted fields copy from the latest version.
  v_receipt_max := coalesce(authz.finance_paise(p_fields, 'receiptMaxPaise', 1), v_latest.receipt_max_paise);
  v_payer_cap := coalesce(authz.finance_paise(p_fields, 'cashPayerDayCapPaise', 0), v_latest.cash_payer_day_cap_paise);
  v_trip_cap := coalesce(authz.finance_paise(p_fields, 'cashTripCapPaise', 0), v_latest.cash_trip_cap_paise);
  v_value := p_fields -> 'cashDepositDays';
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    v_days := v_latest.cash_deposit_days;
  elsif jsonb_typeof(v_value) = 'number' and (v_value #>> '{}') ~ '^[1-7]$' then
    v_days := (v_value #>> '{}')::integer;
  else
    perform authz.finance_invalid();
  end if;
  v_value := p_fields -> 'reconciliationRequired';
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    v_recon := v_latest.reconciliation_required;
  elsif jsonb_typeof(v_value) = 'boolean' then
    v_recon := (v_value #>> '{}')::boolean;
  else
    perform authz.finance_invalid();
  end if;
  if v_limits.legal_entity_id is null
     or v_payer_cap > v_limits.cash_cap_ceiling_paise or v_trip_cap > v_limits.cash_cap_ceiling_paise
     or v_receipt_max > v_limits.receipt_max_ceiling_paise then
    perform authz.finance_invalid();
  end if;
  v_effective := coalesce(p_effective_at, now());
  if v_effective < now() or v_effective < v_latest.effective_at or v_effective > now() + interval '90 days' then
    perform authz.finance_invalid();
  end if;
  v_reason := authz.finance_reason(p_reason);

  insert into public.finance_policy_versions (legal_entity_id, version_no, effective_at, receipt_max_paise,
    cash_payer_day_cap_paise, cash_trip_cap_paise, cash_deposit_days, reconciliation_required, reason, created_by, request_id)
  values (p_entity_id, v_latest.version_no + 1, v_effective, v_receipt_max, v_payer_cap, v_trip_cap, v_days, v_recon,
    v_reason, (select auth.uid()), p_request_id)
  returning id into v_id;
  update public.finance_policy_heads h set current_version_no = v_latest.version_no + 1, updated_at = now()
  where h.legal_entity_id = p_entity_id;

  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'rowVersion', v_latest.version_no + 1,
    'status', case when v_effective <= now() then 'effective' else 'scheduled' end);
  perform authz.finance_remember(p_entity_id, p_request_id, 'finance_policy_update', v_payload, v_result);
  perform authz.write_audit('finance.policy_updated', p_entity_id, null, 'finance_policy_version', v_id, v_reason,
    jsonb_build_object('versionNo', v_latest.version_no + 1, 'effectiveAt', v_effective,
      'changedFields', (select coalesce(jsonb_agg(k order by k), '[]'::jsonb) from jsonb_object_keys(p_fields) as k)));
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Commands: evidence (contract section 13; purchase evidence pattern)
-- ---------------------------------------------------------------------------

create function public.finance_evidence_begin(
  p_target_type text, p_target_id uuid, p_kind text, p_file_name text, p_mime text, p_size_bytes integer,
  p_sha256 text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  r public.customer_receipts%rowtype;
  v_branch public.branches%rowtype;
  v_entity uuid;
  v_owner uuid;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_name text := btrim(coalesce(p_file_name, ''));
  v_sha text := lower(coalesce(p_sha256, ''));
  v_payload jsonb := jsonb_build_object('targetType', p_target_type, 'targetId', p_target_id, 'kind', p_kind,
    'fileName', p_file_name, 'mime', p_mime, 'sizeBytes', p_size_bytes, 'sha256', p_sha256);
  v_result jsonb;
begin
  if p_target_type = 'receipt' then
    r := authz.finance_receipt_for_command(p_target_id);
    v_entity := r.legal_entity_id;
    v_owner := r.id;
  elsif p_target_type = 'branch' then
    select * into v_branch from public.branches b where b.id = p_target_id;
    perform authz.finance_require_accounts(v_branch.legal_entity_id, null);
    v_entity := v_branch.legal_entity_id;
    v_owner := v_branch.id;
  else
    if not coalesce(authz.session_ok(), false) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    perform authz.finance_invalid();
  end if;
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  v_result := authz.finance_replay(v_entity, p_request_id, 'finance_evidence_begin', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  if p_kind is null
     or (p_target_type = 'receipt' and not ((p_kind = 'bank_proof' and r.mode <> 'cash') or (p_kind = 'cheque_image' and r.mode = 'cheque')))
     or (p_target_type = 'branch' and p_kind <> 'deposit_slip')
     or p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes not between 1 and 4194304
     or v_sha !~ '^[0-9a-f]{64}$'
     or length(v_name) not between 1 and 120 or v_name !~ '^[A-Za-z0-9._ -]+$' then
    perform authz.finance_invalid();
  end if;
  if p_target_type = 'receipt' and r.status not in ('recorded', 'pending_clearance', 'bounced') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if (select count(*) from public.finance_evidence e
      where e.status <> 'removed' and e.deposit_id is null
        and (e.receipt_id = v_owner or e.branch_id = v_owner)) >= 10 then
    perform authz.finance_invalid();
  end if;
  if exists (select 1 from public.finance_evidence e
             where e.legal_entity_id = v_entity and e.kind = p_kind and e.sha256 = v_sha
               and e.status in ('pending_upload', 'stored') and not e.released) then
    raise exception 'duplicate_reference' using errcode = '23505';
  end if;

  v_path := v_entity::text || '/' || v_owner::text || '/' || v_id::text;
  begin
    insert into public.finance_evidence (id, legal_entity_id, kind, receipt_id, branch_id, object_path, file_name, mime,
      size_bytes, sha256, uploaded_by, request_id)
    values (v_id, v_entity, p_kind, case when p_target_type = 'receipt' then v_owner end,
      case when p_target_type = 'branch' then v_owner end, v_path, v_name, p_mime, p_size_bytes, v_sha,
      (select auth.uid()), p_request_id);
  exception when unique_violation then
    raise exception 'duplicate_reference' using errcode = '23505';
  end;

  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'objectPath', v_path);
  perform authz.finance_remember(v_entity, p_request_id, 'finance_evidence_begin', v_payload, v_result);
  perform authz.write_audit('finance.evidence_started', v_entity, coalesce(r.branch_id, v_branch.id), 'finance_evidence', v_id,
    null, jsonb_build_object('targetType', p_target_type, 'targetId', v_owner, 'kind', p_kind, 'mime', p_mime,
      'sizeBytes', p_size_bytes));
  return v_result;
end;
$$;

-- Permission and gate for an existing evidence row, then the lock order:
-- deal head and receipt (receipt evidence), then the evidence row.
create function authz.finance_evidence_for_command(p_evidence uuid) returns public.finance_evidence
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.finance_evidence%rowtype;
begin
  select * into v from public.finance_evidence e where e.id = p_evidence;
  if v.id is null then
    if coalesce(authz.session_ok(), false) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v.receipt_id is not null then
    perform authz.finance_receipt_for_command(v.receipt_id);
  else
    perform authz.finance_require_accounts(v.legal_entity_id, null);
  end if;
  select * into v from public.finance_evidence e where e.id = p_evidence for update;
  return v;
end;
$$;

create function public.finance_evidence_finish(p_evidence_id uuid, p_ok boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.finance_evidence%rowtype;
  v_status text;
  v_missing boolean := false;
begin
  v := authz.finance_evidence_for_command(p_evidence_id);
  if v.uploaded_by is distinct from (select auth.uid()) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_ok is null then
    perform authz.finance_invalid();
  end if;
  v_status := case when p_ok then 'stored' else 'failed' end;
  if v.status <> 'pending_upload' then
    if v.status = v_status or (p_ok and v.status = 'failed') then
      return jsonb_build_object('outcome', 'existing', 'id', v.id, 'status', v.status);
    end if;
    raise exception 'wrong_state' using errcode = '55000';
  end if;

  -- 'stored' only when Storage holds the object at the generated path with the declared size.
  if p_ok and (to_regclass('storage.objects') is null or not exists (
       select 1 from storage.objects o
       where o.bucket_id = 'finance-evidence' and o.name = v.object_path
         and (o.metadata ->> 'size') ~ '^[0-9]{1,18}$'
         and (o.metadata ->> 'size')::bigint = v.size_bytes)) then
    v_status := 'failed';
    v_missing := true;
  end if;

  update public.finance_evidence e
  set status = v_status, stored_at = case when v_status = 'stored' then now() else null end, updated_at = now()
  where e.id = v.id;
  perform authz.write_audit(case when v_status = 'stored' then 'finance.evidence_stored' else 'finance.evidence_failed' end,
    v.legal_entity_id, null, 'finance_evidence', v.id, null,
    jsonb_build_object('receiptId', v.receipt_id, 'branchId', v.branch_id, 'objectMissing', v_missing));
  return jsonb_build_object('outcome', 'updated', 'id', v.id, 'status', v_status);
end;
$$;

create function public.finance_evidence_remove(p_evidence_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.finance_evidence%rowtype;
  v_receipt_status text;
begin
  v := authz.finance_evidence_for_command(p_evidence_id);
  if v.status = 'removed' then
    return jsonb_build_object('outcome', 'existing', 'id', v.id, 'status', 'removed');
  end if;
  if v.status = 'stored' then
    -- Proof behind verified, cleared, reversed or deposited money is
    -- immutable; a slip of a rejected deposit (released) may be removed.
    if v.deposit_id is not null and not v.released then
      raise exception 'wrong_state' using errcode = '55000';
    end if;
    if v.receipt_id is not null then
      select r.status into v_receipt_status from public.customer_receipts r where r.id = v.receipt_id;
      if v_receipt_status not in ('recorded', 'rejected') then
        raise exception 'wrong_state' using errcode = '55000';
      end if;
    end if;
  end if;
  update public.finance_evidence e set status = 'removed', updated_at = now() where e.id = v.id;
  perform authz.write_audit('finance.evidence_removed', v.legal_entity_id, null, 'finance_evidence', v.id, null,
    jsonb_build_object('receiptId', v.receipt_id, 'branchId', v.branch_id, 'previousStatus', v.status));
  return jsonb_build_object('outcome', 'updated', 'id', v.id, 'status', 'removed');
end;
$$;

create function public.finance_evidence_authorize_download(p_evidence_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.finance_evidence%rowtype;
  v_synthetic boolean;
begin
  select * into v from public.finance_evidence e where e.id = p_evidence_id;
  if v.id is null then
    if coalesce(authz.session_ok(), false) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v.receipt_id is not null then
    select d.is_synthetic into v_synthetic
    from public.customer_receipts r join public.deals d on d.id = r.deal_id where r.id = v.receipt_id;
  end if;
  perform authz.finance_require_accounts(v.legal_entity_id, v_synthetic);
  if v.status <> 'stored' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.write_audit('finance.evidence_viewed', v.legal_entity_id, null, 'finance_evidence', v.id, null,
    jsonb_build_object('receiptId', v.receipt_id, 'depositId', v.deposit_id));
  return jsonb_build_object('objectPath', v.object_path, 'fileName', v.file_name, 'mime', v.mime);
end;
$$;

-- ---------------------------------------------------------------------------
-- Reads (contract sections 8, 9.5, 12, 15). Shapes: finance/contracts.ts.
-- ---------------------------------------------------------------------------

-- Session, Accounts role somewhere, environment, then finance enablement.
create function authz.finance_require_accounts_anywhere() returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_issue text;
begin
  if not coalesce(authz.session_ok(), false) or not exists (
       select 1 from public.memberships m
       where m.user_id = (select auth.uid()) and m.status = 'active' and m.role_code = 'accounts'
         and authz.holds_active_role('accounts', m.legal_entity_id) and not authz.holds_role('purchase', m.legal_entity_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_issue := authz.finance_gate_issue(null, null);
  if v_issue is not null then
    raise exception '%', v_issue using errcode = '55000';
  end if;
  if not exists (
       select 1 from public.memberships m
       where m.user_id = (select auth.uid()) and m.status = 'active' and m.role_code = 'accounts'
         and authz.can_accounts(m.legal_entity_id)) then
    raise exception 'not_configured' using errcode = '55000';
  end if;
end;
$$;

create function public.accounts_queue(p_filter text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  perform authz.finance_require_accounts_anywhere();
  if p_filter is null or p_filter not in ('all', 'needs_review', 'returned', 'awaiting_verification', 'cheques_pending') then
    perform authz.finance_invalid();
  end if;
  return coalesce((
    select jsonb_agg(q.item order by q.item ->> 'updatedAt' desc, q.item ->> 'dealReference')
    from (
      select authz.finance_queue_item_json(d.id) as item
      from public.deals d
      left join public.booking_versions v on v.deal_id = d.id and v.status = 'confirmed'
      left join public.accounts_booking_reviews rv on rv.booking_version_id = v.id
      where authz.can_accounts(d.legal_entity_id)
        and authz.finance_gate_issue(d.legal_entity_id, d.is_synthetic) is null
        and (v.id is not null or exists (select 1 from public.customer_receipts r where r.deal_id = d.id))
        and case p_filter
          when 'all' then true
          when 'needs_review' then v.id is not null and coalesce(rv.status, 'pending') = 'pending'
          when 'returned' then rv.status is not distinct from 'returned'
          when 'awaiting_verification' then exists (
            select 1 from public.customer_receipts r where r.deal_id = d.id and r.status = 'recorded')
          else exists (
            select 1 from public.customer_receipts r
            where r.deal_id = d.id and r.mode = 'cheque' and r.status in ('recorded', 'pending_clearance'))
        end
    ) q), '[]'::jsonb);
end;
$$;

-- Exact reference within the viewer's finance-enabled entities; audited.
create function public.accounts_deal_lookup(p_reference text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ref text := btrim(coalesce(p_reference, ''));
  v_deal public.deals%rowtype;
  v_entity uuid;
begin
  perform authz.finance_require_accounts_anywhere();
  if v_ref = '' or length(v_ref) > 120 or v_ref ~ E'[\\x01-\\x1f\\x7f]' then
    perform authz.finance_invalid();
  end if;
  select * into v_deal from public.deals d
  where d.reference = v_ref and authz.can_accounts(d.legal_entity_id)
    and authz.finance_gate_issue(d.legal_entity_id, d.is_synthetic) is null
  order by d.created_at, d.id
  limit 1;
  v_entity := coalesce(v_deal.legal_entity_id, (
    select m.legal_entity_id from public.memberships m
    where m.user_id = (select auth.uid()) and m.status = 'active' and m.role_code = 'accounts'
      and authz.can_accounts(m.legal_entity_id)
    order by m.legal_entity_id limit 1));
  perform authz.write_audit('finance.deal_lookup', v_entity, v_deal.branch_id, 'deal', v_deal.id, null,
    jsonb_build_object('found', v_deal.id is not null));
  if v_deal.id is null then
    return null;
  end if;
  return jsonb_build_object(
    'dealId', v_deal.id,
    'dealReference', v_deal.reference,
    'dealTitle', v_deal.title,
    'branchName', (select b.name from public.branches b where b.id = v_deal.branch_id),
    'hasConfirmedBooking', exists (select 1 from public.booking_versions v where v.deal_id = v_deal.id and v.status = 'confirmed'));
end;
$$;

create function public.accounts_deal_detail(p_deal_id uuid) returns jsonb
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
        'sellingTotalPaise', (select c.selling_total_paise::text from public.booking_version_commercials c where c.version_id = v.id),
        'confirmedAt', v.confirmed_at,
        'confirmedByName', authz.finance_name(v.confirmed_by),
        'reviewStatus', coalesce(rv.status, 'pending'),
        'reviewRowVersion', coalesce(rv.row_version, 0),
        -- Kept in history; shown only while the review is returned.
        'returnReason', case when rv.status = 'returned' then rv.return_reason end,
        'reviewedByName', authz.finance_name(rv.reviewed_by),
        'reviewedAt', rv.reviewed_at,
        'canApprove', authz.finance_approve_block(v.id) is null,
        'approveBlock', authz.finance_approve_block(v.id))
      from public.booking_versions v
      left join public.accounts_booking_reviews rv on rv.booking_version_id = v.id
      where v.deal_id = v_deal.id and v.status = 'confirmed'),
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
        'verifiedAt', bp.verified_at)
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
    'policy', authz.finance_policy_json(v_policy.id));
end;
$$;

create function public.accounts_cash_overview(p_entity_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_policy public.finance_policy_versions%rowtype;
begin
  perform authz.finance_require_accounts(p_entity_id, null);
  v_policy := authz.finance_policy_at(p_entity_id, now());
  return jsonb_build_object(
    'legalEntityId', p_entity_id,
    'policy', authz.finance_policy_json(v_policy.id),
    'branches', coalesce((
      select jsonb_agg(authz.finance_cash_branch_json(b.id, v_policy.id) order by b.is_head_office desc, b.name)
      from public.branches b where b.legal_entity_id = p_entity_id and b.status = 'enabled'), '[]'::jsonb));
end;
$$;

create function public.finance_policy_get(p_entity_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_issue text;
  v_current public.finance_policy_versions%rowtype;
begin
  if p_entity_id is null or not coalesce(authz.session_ok(), false) or not (
       (authz.holds_active_role('accounts', p_entity_id) and not authz.holds_role('purchase', p_entity_id))
       or (authz.holds_active_role('super_admin', p_entity_id) and not authz.holds_role('accounts', p_entity_id))) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_issue := authz.finance_gate_issue(p_entity_id, null);
  if v_issue is not null then
    raise exception '%', v_issue using errcode = '55000';
  end if;
  v_current := authz.finance_policy_at(p_entity_id, now());
  return jsonb_build_object(
    'legalEntityId', p_entity_id,
    'legalEntityName', (select e.legal_name from public.legal_entities e where e.id = p_entity_id),
    'current', authz.finance_policy_json(v_current.id),
    'scheduled', coalesce((
      select jsonb_agg(authz.finance_policy_json(v.id) order by v.effective_at, v.version_no)
      from public.finance_policy_versions v where v.legal_entity_id = p_entity_id and v.effective_at > now()), '[]'::jsonb),
    'history', coalesce((
      select jsonb_agg(authz.finance_policy_json(v.id) order by v.effective_at desc, v.version_no desc)
      from public.finance_policy_versions v
      where v.legal_entity_id = p_entity_id and v.effective_at <= now() and v.id <> v_current.id), '[]'::jsonb),
    'ceilings', (
      select jsonb_build_object('cashCapCeilingPaise', l.cash_cap_ceiling_paise::text,
        'receiptMaxCeilingPaise', l.receipt_max_ceiling_paise::text)
      from public.finance_legal_limits l where l.legal_entity_id = p_entity_id),
    'canEdit', authz.can_manage_finance_policy(p_entity_id));
end;
$$;

-- Navigation helper: finance-enabled entities among the caller's memberships.
create function public.finance_enabled_entities() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(distinct m.legal_entity_id)
    from public.memberships m
    where m.user_id = (select auth.uid()) and m.status = 'active' and authz.finance_enabled(m.legal_entity_id)), '[]'::jsonb);
end;
$$;

-- ---------------------------------------------------------------------------
-- Cash postings serialise with reconciliation per branch (lock 5 family).
-- ---------------------------------------------------------------------------

create function authz.finance_post(
  p_kind text, p_entity uuid, p_receipt uuid, p_deposit uuid, p_deal uuid, p_branch uuid,
  p_business_date date, p_reverses uuid, p_amount bigint
) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid;
  v_debit text;
  v_credit text;
begin
  if p_kind in ('receipt_cash', 'deposit', 'reversal_cash_undeposited') then
    perform pg_advisory_xact_lock(hashtextextended('cash-branch|' || p_branch::text, 0));
  end if;
  insert into public.finance_journal_entries (legal_entity_id, kind, receipt_id, deposit_id, deal_id, branch_id,
    business_date, reverses_entry_id, posted_by)
  values (p_entity, p_kind, p_receipt, p_deposit, p_deal, p_branch, p_business_date, p_reverses, (select auth.uid()))
  returning id into v_id;
  select x.debit, x.credit into v_debit, v_credit from (values
    ('receipt_bank', 'bank', 'customer_advances'),
    ('receipt_cash', 'cash_in_hand', 'customer_advances'),
    ('deposit', 'bank', 'cash_in_hand'),
    ('reversal_bank', 'customer_advances', 'bank'),
    ('reversal_cash_deposited', 'customer_advances', 'bank'),
    ('reversal_cash_undeposited', 'customer_advances', 'cash_in_hand')
  ) as x (kind, debit, credit) where x.kind = p_kind;
  insert into public.finance_journal_lines (entry_id, account, deal_id, branch_id, debit_paise, credit_paise) values
    (v_id, v_debit, p_deal, p_branch, p_amount, 0),
    (v_id, v_credit, p_deal, p_branch, 0, p_amount);
  return v_id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Row level security and grants (contract section 4)
-- ---------------------------------------------------------------------------

do $$
declare
  t text;
begin
  foreach t in array array[
    'finance_live_settings', 'finance_legal_limits', 'finance_policy_heads', 'finance_policy_versions',
    'finance_deal_heads', 'finance_receipt_counters', 'finance_command_results', 'customer_billing_profiles',
    'accounts_booking_reviews', 'customer_receipts', 'cash_deposits', 'cash_deposit_items', 'cash_reconciliations',
    'finance_evidence', 'finance_journal_entries', 'finance_journal_lines'
  ] loop
    execute format('alter table public.%I enable row level security', t);
    -- Restrictive only: no permissive policy exists, so the Data API sees no rows.
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

revoke all on function
  authz.finance_append_only(), authz.finance_no_delete(), authz.finance_policy_versions_ceiling(),
  authz.customer_receipts_guard(), authz.cash_deposits_guard(), authz.cash_deposit_items_guard(),
  authz.cash_reconciliations_guard(), authz.finance_evidence_guard(), authz.finance_check_entry(uuid),
  authz.finance_entry_shape_trigger(), authz.finance_line_shape_trigger(), authz.finance_mark_reconciliations_stale(),
  authz.finance_enable_entity(uuid),
  authz.finance_enabled(uuid), authz.can_accounts(uuid), authz.can_manage_finance_policy(uuid),
  authz.finance_deal_conflict(uuid), authz.finance_gate_issue(uuid, boolean),
  authz.finance_require_accounts(uuid, boolean), authz.finance_require_policy_manager(uuid),
  authz.finance_require_accounts_anywhere(),
  authz.finance_mode_allowed(uuid, text), authz.finance_today(), authz.finance_fiscal_year(date),
  authz.finance_add_working_days(date, integer), authz.finance_name(uuid), authz.finance_invalid(),
  authz.finance_field(jsonb, text), authz.finance_text(text, integer, integer, boolean), authz.finance_uuid(text),
  authz.finance_date(text), authz.finance_paise(jsonb, text, bigint), authz.finance_mobile(text),
  authz.finance_reason(text), authz.finance_payload_hash(jsonb), authz.finance_replay(uuid, uuid, text, jsonb),
  authz.finance_remember(uuid, uuid, text, jsonb, jsonb), authz.finance_lock_policy(uuid, boolean),
  authz.finance_lock_deal(uuid), authz.finance_policy_at(uuid, timestamptz),
  authz.finance_receipt_for_command(uuid), authz.finance_has_evidence(uuid, text[], bigint),
  authz.finance_evidence_seq(),
  authz.finance_post(text, uuid, uuid, uuid, uuid, uuid, date, uuid, bigint),
  authz.finance_receipt_deposit_status(uuid), authz.finance_receipt_actions(uuid), authz.finance_raise_block(text),
  authz.finance_money_json(uuid), authz.finance_policy_json(uuid), authz.finance_evidence_list_json(uuid, uuid),
  authz.finance_receipt_json(uuid), authz.finance_queue_item_json(uuid), authz.finance_deposit_json(uuid),
  authz.finance_reconciliation_json(uuid), authz.finance_unresolved_json(uuid, uuid),
  authz.finance_cash_branch_json(uuid, uuid), authz.finance_approve_block(uuid),
  authz.finance_confirmed_version(uuid), authz.finance_lock_deposit_receipts(uuid, uuid[]),
  authz.finance_deposit_for_command(uuid), authz.finance_evidence_for_command(uuid)
from public, anon, authenticated;

revoke all on function
  public.accounts_queue(text), public.accounts_deal_lookup(text), public.accounts_deal_detail(uuid),
  public.accounts_cash_overview(uuid), public.finance_policy_get(uuid), public.finance_enabled_entities(),
  public.accounts_billing_save(uuid, integer, jsonb, uuid), public.accounts_billing_verify(uuid, integer, uuid),
  public.accounts_review_return(uuid, text, uuid), public.accounts_review_approve(uuid, integer, uuid),
  public.receipt_record(uuid, jsonb, uuid), public.receipt_verify(uuid, uuid), public.receipt_reject(uuid, text, text, uuid),
  public.cheque_clear(uuid, date, uuid), public.cheque_mark(uuid, text, date, text, uuid), public.cheque_represent(uuid, uuid),
  public.receipt_reverse(uuid, text, text, uuid),
  public.cash_deposit_record(uuid, uuid[], date, text, uuid, uuid), public.cash_deposit_verify(uuid, uuid),
  public.cash_deposit_reject(uuid, text, uuid), public.cash_reconciliation_record(uuid, date, bigint, text, uuid),
  public.cash_reconciliation_verify(uuid, uuid), public.finance_policy_update(uuid, jsonb, timestamptz, text, uuid),
  public.finance_evidence_begin(text, uuid, text, text, text, integer, text, uuid),
  public.finance_evidence_finish(uuid, boolean), public.finance_evidence_authorize_download(uuid),
  public.finance_evidence_remove(uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.accounts_queue(text), public.accounts_deal_lookup(text), public.accounts_deal_detail(uuid),
  public.accounts_cash_overview(uuid), public.finance_policy_get(uuid), public.finance_enabled_entities(),
  public.accounts_billing_save(uuid, integer, jsonb, uuid), public.accounts_billing_verify(uuid, integer, uuid),
  public.accounts_review_return(uuid, text, uuid), public.accounts_review_approve(uuid, integer, uuid),
  public.receipt_record(uuid, jsonb, uuid), public.receipt_verify(uuid, uuid), public.receipt_reject(uuid, text, text, uuid),
  public.cheque_clear(uuid, date, uuid), public.cheque_mark(uuid, text, date, text, uuid), public.cheque_represent(uuid, uuid),
  public.receipt_reverse(uuid, text, text, uuid),
  public.cash_deposit_record(uuid, uuid[], date, text, uuid, uuid), public.cash_deposit_verify(uuid, uuid),
  public.cash_deposit_reject(uuid, text, uuid), public.cash_reconciliation_record(uuid, date, bigint, text, uuid),
  public.cash_reconciliation_verify(uuid, uuid), public.finance_policy_update(uuid, jsonb, timestamptz, text, uuid),
  public.finance_evidence_begin(text, uuid, text, text, text, integer, text, uuid),
  public.finance_evidence_finish(uuid, boolean), public.finance_evidence_authorize_download(uuid),
  public.finance_evidence_remove(uuid)
to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: private finance evidence bucket (no storage.objects policies).
-- ---------------------------------------------------------------------------

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('finance-evidence', 'finance-evidence', false, 4194304,
      array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;

commit;
