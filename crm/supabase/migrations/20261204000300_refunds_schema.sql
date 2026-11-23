-- Accounts phase 2, Track C (contract accounts-phase2-2026-11-11 section 7.1,
-- LD5, LD8, LD9 + Addendum L1, LD13, LD28, LD30): refunds, refund proof files,
-- the refund journal kinds, Flight and Visa cancellation rows and supplier
-- refunds received.
--
-- Tables (all: RLS on, restrictive require_valid_session, every privilege
-- revoked, guard trigger, index on every foreign key; reached only through
-- the security definer commands and reads of 20261204000310..0350):
--   customer_refund_counters   RF-YYYY-NNNNNN per entity and IST year
--   customer_refund_requests   request / Manager decision / withdraw; one live per Deal
--   refund_evidence            private proof files (bucket finance-evidence)
--   customer_refund_payouts    append-only; recorded and verified by ONE Accounts person (Q6)
--   flight_cancellation_charges  append-only revisions per ticket batch
--   visa_cancellation_fees     append-only revisions per company-paid Visa fee
--   supplier_refund_receipts   recorded and verified in one step (L1); cancel = rejected
-- Columns: visa_applications.cancellation_choice/_by/_at/_reason;
--   finance_journal_entries.refund_payout_id; accounts_settings.refunds_enabled
--   (added by Track B; "if not exists" here only so this file also applies
--   alone); customer_documents.refund_request_id foreign key (when Track B's
--   table exists).
-- Journal: kinds refund_bank, refund_cash; (kind in (deposit, refund_*)) =
--   (receipt_id is null); (kind like 'refund%') = (refund_payout_id is not null).
--
-- Refusal tokens raised by the guards: none for staff (42501 integrity
-- messages only; the commands refuse first).
--
-- Rollback (forward-only): a NEW migration that drops the new tables and
-- columns after restoring the journal checks of 20261101000100 (only while
-- no refund_* journal entry exists).

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 0. Refund switch (column owned by Track B, section 6.2)
-- ===========================================================================

alter table public.accounts_settings add column if not exists refunds_enabled boolean not null default false;

-- ===========================================================================
-- 1. Customer refund requests
-- ===========================================================================

create table public.customer_refund_counters (
  legal_entity_id uuid not null references public.legal_entities (id),
  year integer not null check (year between 2000 and 2999),
  last_no integer not null default 0 check (last_no between 0 and 999999),
  primary key (legal_entity_id, year)
);
comment on table public.customer_refund_counters is
  'Accounts phase 2: running refund number per entity and IST calendar year (RF-YYYY-NNNNNN). No table grant.';

create table public.customer_refund_requests (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  deal_id uuid not null,
  ref_no text not null check (ref_no ~ '^RF-[0-9]{4}-[0-9]{6}$'),
  kind text not null check (kind in ('cancellation', 'overpayment')),
  outcome text not null check (outcome in ('payout', 'keep_credit', 'charge_only')),
  cancellation_id uuid references public.deal_cancellations (id),
  -- How the requester was entitled (7.2): the Deal's Sales owner, or a branch
  -- Manager because the Deal had no active Sales owner (LD32 approver rule).
  requested_as text not null check (requested_as in ('sales_owner', 'manager')),
  held_at_request_paise bigint not null check (held_at_request_paise >= 0),
  customer_charge_paise bigint not null default 0 check (customer_charge_paise between 0 and 999999999999999),
  amount_paise bigint not null check (amount_paise between 0 and 999999999999999),
  payee_kind text check (payee_kind in ('original_payer', 'other')),
  payee_name text check (length(payee_name) between 1 and 200),
  payee_receipt_id uuid,
  payee_reason text check (length(payee_reason) between 10 and 500),
  reason text not null check (length(reason) between 10 and 500),
  status text not null default 'requested' check (status in ('requested', 'returned', 'approved', 'paid', 'withdrawn')),
  requested_by uuid not null references public.staff_profiles (user_id),
  requested_at timestamptz not null default now(),
  request_id uuid not null,
  resubmitted_at timestamptz,
  decided_by uuid references public.staff_profiles (user_id),
  decided_at timestamptz,
  decision_request_id uuid,
  return_reason text check (length(return_reason) between 10 and 500),
  withdrawn_by uuid references public.staff_profiles (user_id),
  withdrawn_at timestamptz,
  withdraw_reason text check (length(withdraw_reason) between 10 and 500),
  paid_at timestamptz,
  row_version integer not null default 1 check (row_version >= 1),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  foreign key (legal_entity_id, branch_id) references public.branches (legal_entity_id, id),
  foreign key (legal_entity_id, payee_receipt_id) references public.customer_receipts (legal_entity_id, id),
  unique (legal_entity_id, ref_no),
  unique (legal_entity_id, request_id),
  unique (legal_entity_id, id),
  check ((kind = 'cancellation') = (cancellation_id is not null)),
  check (kind = 'cancellation' or customer_charge_paise = 0),
  check (kind = 'cancellation' or outcome <> 'charge_only'),
  check ((outcome = 'charge_only') = (amount_paise = 0)),
  check ((outcome = 'payout') = (payee_kind is not null)),
  check ((outcome = 'payout') = (payee_name is not null)),
  check ((payee_receipt_id is not null) = (payee_kind is not distinct from 'original_payer')),
  check ((payee_reason is not null) = (payee_kind is not distinct from 'other')),
  check (decided_by is distinct from requested_by or decided_by is null),
  check (status not in ('approved', 'paid') or (decided_by is not null and decided_at is not null)),
  check ((status = 'returned') = (return_reason is not null)),
  check ((status = 'withdrawn') = (withdrawn_by is not null and withdrawn_at is not null and withdraw_reason is not null)),
  check ((status = 'paid') = (paid_at is not null)),
  check (status <> 'paid' or outcome = 'payout')
);
-- LD5: one live request per Deal (section 4: requested, returned, or an approved payout not yet paid).
create unique index customer_refund_requests_one_live on public.customer_refund_requests (deal_id)
  where status in ('requested', 'returned') or (status = 'approved' and outcome = 'payout');
create index customer_refund_requests_deal_idx on public.customer_refund_requests (deal_id, requested_at desc);
create index customer_refund_requests_list_idx on public.customer_refund_requests (legal_entity_id, requested_at desc, id desc);
create index customer_refund_requests_status_idx on public.customer_refund_requests (legal_entity_id, status, requested_at desc, id desc);
create index customer_refund_requests_branch_idx on public.customer_refund_requests (branch_id, requested_at desc, id desc);
create index customer_refund_requests_cancellation_idx on public.customer_refund_requests (cancellation_id) where cancellation_id is not null;
create index customer_refund_requests_receipt_idx on public.customer_refund_requests (payee_receipt_id) where payee_receipt_id is not null;
create index customer_refund_requests_requested_by_idx on public.customer_refund_requests (requested_by);
create index customer_refund_requests_decided_by_idx on public.customer_refund_requests (decided_by) where decided_by is not null;
create index customer_refund_requests_withdrawn_by_idx on public.customer_refund_requests (withdrawn_by) where withdrawn_by is not null;
comment on table public.customer_refund_requests is
  'Accounts phase 2 (7.1/7.2): a customer refund, keep-as-credit or charge-only settlement asked by the Deal''s Sales owner (branch Manager when none) and decided by a branch Manager who is not the requester. One live request per Deal. No customer bank numbers (LD8). No table grant.';

create function authz.customer_refund_requests_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_facts text[] := array['kind', 'outcome', 'cancellation_id', 'held_at_request_paise', 'customer_charge_paise', 'amount_paise',
    'payee_kind', 'payee_name', 'payee_receipt_id', 'payee_reason', 'reason', 'resubmitted_at'];
  v_identity text[] := array['id', 'legal_entity_id', 'branch_id', 'deal_id', 'ref_no', 'requested_as', 'requested_by',
    'requested_at', 'request_id'];
  k text;
begin
  if tg_op = 'DELETE' then
    raise exception 'refund requests cannot be deleted' using errcode = '42501';
  end if;
  foreach k in array v_identity loop
    if (to_jsonb(new) -> k) is distinct from (to_jsonb(old) -> k) then
      raise exception 'refund request identity is immutable' using errcode = '42501';
    end if;
  end loop;
  if new.row_version <> old.row_version + 1 then
    raise exception 'refund request changes bump row_version' using errcode = '42501';
  end if;
  if old.status in ('paid', 'withdrawn')
     or not ((old.status = 'requested' and new.status in ('approved', 'returned', 'withdrawn'))
          or (old.status = 'returned' and new.status in ('requested', 'withdrawn'))
          or (old.status = 'approved' and new.status in ('paid', 'withdrawn'))) then
    raise exception 'refund request status move not allowed' using errcode = '42501';
  end if;
  -- Facts change only on a resubmission (returned -> requested).
  if not (old.status = 'returned' and new.status = 'requested') then
    foreach k in array v_facts loop
      if (to_jsonb(new) -> k) is distinct from (to_jsonb(old) -> k) then
        raise exception 'refund request facts change only on resubmission' using errcode = '42501';
      end if;
    end loop;
  end if;
  -- After approval only the paid / withdrawn columns move.
  if old.status = 'approved'
     and (new.decided_by is distinct from old.decided_by or new.decided_at is distinct from old.decided_at
          or new.decision_request_id is distinct from old.decision_request_id) then
    raise exception 'an approved refund decision is final' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger customer_refund_requests_a_guard
  before update or delete on public.customer_refund_requests
  for each row execute function authz.customer_refund_requests_guard();

-- ===========================================================================
-- 2. Refund proof files (pattern of finance_evidence)
-- ===========================================================================

create table public.refund_evidence (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  deal_id uuid not null,
  subject_kind text not null check (subject_kind in ('customer_refund', 'supplier_refund')),
  -- customer_refund: the refund request; supplier_refund: the Deal's cancellation case.
  subject_id uuid not null,
  object_path text not null unique,
  file_name text not null check (length(file_name) between 1 and 120 and file_name ~ '^[A-Za-z0-9._ -]+$'),
  mime text not null check (mime in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')),
  size_bytes integer not null check (size_bytes between 1 and 4194304),
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  status text not null default 'pending_upload' check (status in ('pending_upload', 'stored', 'failed', 'removed')),
  uploaded_by uuid not null references public.staff_profiles (user_id),
  request_id uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  stored_at timestamptz,
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  unique (legal_entity_id, request_id),
  check (object_path = legal_entity_id::text || '/refund/' || subject_id::text || '/' || id::text),
  check ((status = 'stored') = (stored_at is not null))
);
create unique index refund_evidence_sha_unique on public.refund_evidence (legal_entity_id, sha256)
  where status in ('pending_upload', 'stored');
create index refund_evidence_subject_idx on public.refund_evidence (subject_kind, subject_id, status);
create index refund_evidence_deal_idx on public.refund_evidence (deal_id);
create index refund_evidence_uploaded_by_idx on public.refund_evidence (uploaded_by);
comment on table public.refund_evidence is
  'Accounts phase 2: private proof of a customer refund payout or a supplier refund received (bucket finance-evidence, path <entity>/refund/<subject>/<id>). Accounts and the Deal''s branch Manager download through an audited command. No table grant.';

create function authz.refund_evidence_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'refund evidence rows cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['status', 'stored_at', 'updated_at']) is distinct from (to_jsonb(old) - array['status', 'stored_at', 'updated_at'])
     or not ((old.status = 'pending_upload' and new.status in ('stored', 'failed'))
             or (old.status = 'stored' and new.status = 'removed')
             or new.status = old.status) then
    raise exception 'refund evidence facts are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger refund_evidence_a_guard
  before update or delete on public.refund_evidence
  for each row execute function authz.refund_evidence_guard();

-- ===========================================================================
-- 3. Payouts (append-only) and the refund journal kinds
-- ===========================================================================

create table public.customer_refund_payouts (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  deal_id uuid not null,
  refund_request_id uuid not null unique,
  amount_paise bigint not null check (amount_paise between 1 and 999999999999999),
  mode text not null check (mode in ('bank_transfer', 'upi', 'cash', 'cheque')),
  paid_on date not null check (paid_on between date '2000-01-01' and date '2100-12-31'),
  reference text check (reference ~ '^[A-Za-z0-9/-]{4,40}$'),
  evidence_id uuid not null unique references public.refund_evidence (id),
  journal_entry_id uuid not null unique references public.finance_journal_entries (id),
  -- Q6: one Accounts person records AND verifies the payout.
  recorded_by uuid not null references public.staff_profiles (user_id),
  recorded_at timestamptz not null default now(),
  request_id uuid not null,
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  foreign key (legal_entity_id, branch_id) references public.branches (legal_entity_id, id),
  foreign key (legal_entity_id, refund_request_id) references public.customer_refund_requests (legal_entity_id, id),
  unique (legal_entity_id, request_id),
  check (mode = 'cash' or reference is not null)
);
create index customer_refund_payouts_deal_idx on public.customer_refund_payouts (deal_id);
create index customer_refund_payouts_recorded_by_idx on public.customer_refund_payouts (recorded_by);
create index customer_refund_payouts_entity_idx on public.customer_refund_payouts (legal_entity_id, recorded_at desc);
comment on table public.customer_refund_payouts is
  'Accounts phase 2: money sent back to the customer for an approved refund, recorded and verified in one step by one Accounts person (owner Q6) who is neither the requester nor the approver. Posts refund_bank / refund_cash. Append-only. No table grant.';
create trigger customer_refund_payouts_a_append_only
  before update or delete on public.customer_refund_payouts
  for each row execute function authz.finance_append_only();

alter table public.finance_journal_entries
  add column refund_payout_id uuid unique references public.customer_refund_payouts (id) deferrable initially deferred;

do $$
declare
  c record;
begin
  -- The auto-named checks of 20261101000100 on kind and on (kind = 'deposit') = (receipt_id is null).
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.finance_journal_entries'::regclass and con.contype = 'c'
      and (pg_get_constraintdef(con.oid) like '%reversal_cash_undeposited%'
           or pg_get_constraintdef(con.oid) like '%(receipt_id IS NULL)%')
  loop
    execute format('alter table public.finance_journal_entries drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table public.finance_journal_entries
  add constraint finance_journal_entries_kind_check check (kind in ('receipt_bank', 'receipt_cash', 'deposit', 'reversal_bank',
    'reversal_cash_deposited', 'reversal_cash_undeposited', 'refund_bank', 'refund_cash')),
  add constraint finance_journal_entries_receipt_check check ((kind in ('deposit', 'refund_bank', 'refund_cash')) = (receipt_id is null)),
  add constraint finance_journal_entries_refund_check check ((kind like 'refund%') = (refund_payout_id is not null));

-- ===========================================================================
-- 4. Flight cancellation charges (append-only revisions, LD13)
-- ===========================================================================

create table public.flight_cancellation_charges (
  id uuid primary key default gen_random_uuid(),
  cancellation_id uuid not null references public.deal_cancellations (id),
  legal_entity_id uuid not null,
  deal_id uuid not null,
  batch_id uuid not null,
  cost_task_id uuid not null,
  supplier_id uuid not null,
  revision_no integer not null check (revision_no >= 1),
  -- Snapshot of the batch's supplier cost when the charge was entered.
  supplier_cost_paise bigint not null check (supplier_cost_paise >= 0),
  airline_charge_paise bigint not null check (airline_charge_paise between 0 and 999999999999),
  refund_expected_paise bigint not null check (refund_expected_paise between 0 and 999999999999),
  -- Flight-reported refund (not money; Accounts records the real one).
  refund_reported_paise bigint check (refund_reported_paise between 0 and 999999999999),
  note text check (note is null or length(note) between 1 and 500),
  entered_by uuid not null references public.staff_profiles (user_id),
  entered_at timestamptz not null default now(),
  request_id uuid not null,
  foreign key (legal_entity_id, batch_id) references public.flight_ticket_batches (legal_entity_id, id),
  foreign key (legal_entity_id, cost_task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (legal_entity_id, supplier_id) references public.suppliers (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  unique (cancellation_id, batch_id, revision_no),
  unique (legal_entity_id, request_id),
  unique (legal_entity_id, id)
);
create index flight_cancellation_charges_batch_idx on public.flight_cancellation_charges (batch_id, cancellation_id, revision_no desc);
create index flight_cancellation_charges_cancellation_idx on public.flight_cancellation_charges (cancellation_id);
create index flight_cancellation_charges_task_idx on public.flight_cancellation_charges (cost_task_id);
create index flight_cancellation_charges_supplier_idx on public.flight_cancellation_charges (supplier_id);
create index flight_cancellation_charges_deal_idx on public.flight_cancellation_charges (deal_id);
create index flight_cancellation_charges_entered_by_idx on public.flight_cancellation_charges (entered_by);
comment on table public.flight_cancellation_charges is
  'Accounts phase 2 (2d): append-only revisions of the airline charge, refund expected and Flight-reported refund per ticket batch of a cancelled trip; the latest revision is current. Approved by the branch Manager with the Deal cancellation. No table grant.';
create trigger flight_cancellation_charges_a_append_only
  before update or delete on public.flight_cancellation_charges
  for each row execute function authz.procurement_append_only();

-- ===========================================================================
-- 5. Visa: cancellation fees and per-application choice (LD12)
-- ===========================================================================

create table public.visa_cancellation_fees (
  id uuid primary key default gen_random_uuid(),
  cancellation_id uuid not null references public.deal_cancellations (id),
  legal_entity_id uuid not null,
  deal_id uuid not null,
  task_id uuid not null,
  entry_id uuid not null references public.department_cost_entries (id),
  revision_no integer not null check (revision_no >= 1),
  refund_expected_paise bigint not null check (refund_expected_paise between 0 and 999999999999),
  note text check (note is null or length(note) between 1 and 500),
  entered_by uuid not null references public.staff_profiles (user_id),
  entered_at timestamptz not null default now(),
  request_id uuid not null,
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  unique (cancellation_id, entry_id, revision_no),
  unique (legal_entity_id, request_id),
  unique (legal_entity_id, id)
);
create index visa_cancellation_fees_entry_idx on public.visa_cancellation_fees (entry_id, cancellation_id, revision_no desc);
create index visa_cancellation_fees_cancellation_idx on public.visa_cancellation_fees (cancellation_id);
create index visa_cancellation_fees_task_idx on public.visa_cancellation_fees (task_id);
create index visa_cancellation_fees_deal_idx on public.visa_cancellation_fees (deal_id);
create index visa_cancellation_fees_entered_by_idx on public.visa_cancellation_fees (entered_by);
comment on table public.visa_cancellation_fees is
  'Accounts phase 2 (2d): append-only revisions of the refund the Visa desk expects back on a company-paid Visa fee of a cancelled trip. No row = not refundable. No table grant.';
create trigger visa_cancellation_fees_a_append_only
  before update or delete on public.visa_cancellation_fees
  for each row execute function authz.procurement_append_only();

alter table public.visa_applications
  add column cancellation_choice text check (cancellation_choice in ('withdraw', 'finish')),
  add column cancellation_choice_by uuid references public.staff_profiles (user_id),
  add column cancellation_choice_at timestamptz,
  add column cancellation_choice_reason text check (length(cancellation_choice_reason) between 10 and 300),
  add constraint visa_applications_cancellation_choice_set check (
    (cancellation_choice is null) = (cancellation_choice_by is null)
    and (cancellation_choice is null) = (cancellation_choice_at is null)
    and (cancellation_choice is null) = (cancellation_choice_reason is null));
create index visa_applications_cancellation_choice_by_idx on public.visa_applications (cancellation_choice_by)
  where cancellation_choice_by is not null;

-- ===========================================================================
-- 6. Supplier refunds received (LD9 + Addendum L1: one step, one person)
-- ===========================================================================

create table public.supplier_refund_receipts (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  deal_id uuid not null,
  cancellation_id uuid not null references public.deal_cancellations (id),
  source_kind text not null check (source_kind in ('purchase_charge', 'flight_charge', 'visa_fee')),
  -- purchase_charge: purchase_cancellation_charges.id; flight_charge: flight_cancellation_charges.id;
  -- visa_fee: department_cost_entries.id (the company-paid fee).
  source_id uuid not null,
  -- The task the source belongs to (Purchase task, the batch's cost task, the Visa task).
  task_id uuid not null,
  -- The refund group (Purchase task, ticket batch or Visa fee entry) the expected amount belongs to.
  source_group_id uuid not null,
  supplier_id uuid,
  amount_paise bigint not null check (amount_paise between 1 and 999999999999),
  received_on date not null check (received_on between date '2000-01-01' and date '2100-12-31'),
  mode text not null check (mode in ('bank_transfer', 'upi', 'cheque', 'card_reversal', 'other')),
  reference text not null check (reference ~ '^[A-Za-z0-9/-]{4,40}$'),
  evidence_id uuid not null unique references public.refund_evidence (id),
  over_expected_reason text check (length(over_expected_reason) between 10 and 500),
  status text not null default 'verified' check (status in ('verified', 'rejected')),
  recorded_by uuid not null references public.staff_profiles (user_id),
  recorded_at timestamptz not null default now(),
  verified_by uuid not null references public.staff_profiles (user_id),
  verified_at timestamptz not null,
  reject_reason text check (length(reject_reason) between 10 and 500),
  rejected_by uuid references public.staff_profiles (user_id),
  rejected_at timestamptz,
  request_id uuid not null,
  row_version integer not null default 1 check (row_version >= 1),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  foreign key (legal_entity_id, branch_id) references public.branches (legal_entity_id, id),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (legal_entity_id, supplier_id) references public.suppliers (legal_entity_id, id),
  unique (legal_entity_id, request_id),
  unique (legal_entity_id, id),
  check ((source_kind = 'visa_fee') = (supplier_id is null)),
  check (verified_by = recorded_by and verified_at = recorded_at),
  check ((status = 'rejected') = (reject_reason is not null and rejected_by is not null and rejected_at is not null))
);
create index supplier_refund_receipts_deal_idx on public.supplier_refund_receipts (deal_id);
create index supplier_refund_receipts_cancellation_idx on public.supplier_refund_receipts (cancellation_id);
create index supplier_refund_receipts_group_idx on public.supplier_refund_receipts (source_kind, source_group_id, status);
create index supplier_refund_receipts_task_idx on public.supplier_refund_receipts (task_id);
create index supplier_refund_receipts_supplier_idx on public.supplier_refund_receipts (supplier_id) where supplier_id is not null;
create index supplier_refund_receipts_entity_idx on public.supplier_refund_receipts (legal_entity_id, recorded_at desc, id desc);
create index supplier_refund_receipts_recorded_by_idx on public.supplier_refund_receipts (recorded_by);
create index supplier_refund_receipts_verified_by_idx on public.supplier_refund_receipts (verified_by);
create index supplier_refund_receipts_rejected_by_idx on public.supplier_refund_receipts (rejected_by) where rejected_by is not null;
comment on table public.supplier_refund_receipts is
  'Accounts phase 2: money received back from a supplier, airline or visa authority after a cancellation, recorded and verified in one step by one Accounts person (LD9, Addendum L1); cancelled = rejected with a reason. Never posts to the customer journal; never read by dues. No table grant.';

create function authz.supplier_refund_receipts_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'supplier refunds cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - array['status', 'reject_reason', 'rejected_by', 'rejected_at', 'row_version', 'updated_at'])
       is distinct from (to_jsonb(old) - array['status', 'reject_reason', 'rejected_by', 'rejected_at', 'row_version', 'updated_at'])
     or old.status <> 'verified' or new.status <> 'rejected' or new.row_version <> old.row_version + 1 then
    raise exception 'a supplier refund changes only from verified to rejected' using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger supplier_refund_receipts_a_guard
  before update or delete on public.supplier_refund_receipts
  for each row execute function authz.supplier_refund_receipts_guard();

-- ===========================================================================
-- 7. Credit notes point at their refund request (Track B's column)
-- ===========================================================================

do $$
begin
  if to_regclass('public.customer_documents') is not null
     and exists (select 1 from information_schema.columns
                 where table_schema = 'public' and table_name = 'customer_documents' and column_name = 'refund_request_id')
     and not exists (select 1 from pg_constraint where conname = 'customer_documents_refund_request_fk') then
    alter table public.customer_documents
      add constraint customer_documents_refund_request_fk foreign key (refund_request_id) references public.customer_refund_requests (id);
    if not exists (select 1 from pg_indexes where schemaname = 'public' and tablename = 'customer_documents'
                   and indexdef like '%(refund_request_id)%') then
      create index customer_documents_refund_request_idx on public.customer_documents (refund_request_id)
        where refund_request_id is not null;
    end if;
  end if;
end;
$$;

-- ===========================================================================
-- 8. Row level security and grants: definer functions only
-- ===========================================================================

do $$
declare
  t text;
begin
  foreach t in array array['customer_refund_counters', 'customer_refund_requests', 'refund_evidence', 'customer_refund_payouts',
                           'flight_cancellation_charges', 'visa_cancellation_fees', 'supplier_refund_receipts'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

revoke all on function authz.customer_refund_requests_guard(), authz.refund_evidence_guard(),
  authz.supplier_refund_receipts_guard()
from public, anon, authenticated, service_role;

commit;
