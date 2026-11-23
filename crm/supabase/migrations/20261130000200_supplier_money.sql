-- Purchase build, Track B: supplier money (schema, helpers, commands).
-- Contract: purchase build contract section B (frozen 2 Nov 2026);
-- shapes and refusal tokens: crm/src/modules/supplier-money/contracts.ts.
-- Runs after 20261130000100_purchase_workflow.sql (Track A) and uses its
-- go-ahead and cancellation tables and helpers.
--
-- Adds:
--   * supplier_money_evidence + private bucket 'supplier-money'
--     (proforma, payment_proof, invoice, credit_note). Purchase never reads
--     a payment proof.
--   * supplier_payment_requests (SP-YYYY-NNNNNN): Purchase asks, Accounts
--     (cumulative live total for the supplier on the Deal <= INR 50,000) or
--     the branch Manager (above) approves or returns, Accounts records the
--     payment (the approver may record), a DIFFERENT Accounts person
--     verifies. Nobody approves their own request. Nothing is paid by the
--     CRM: recording states that money left the company's bank.
--   * company_funding_requests: one per payment request when customer money
--     on the Deal does not cover it; amount computed here; routed by the
--     cumulative company funding on the Deal; Accounts marks it recovered.
--   * supplier_documents: supplier invoices and credit notes, checked by
--     Accounts.
--   * authz.purchase_has_live_payment replaces Track A's placeholder.
--
-- Owner rules (2 Nov 2026): exactly 5_000_000 paise = Accounts, above =
-- branch Manager; splitting never bypasses (the route counts every live
-- request for the same supplier on the same Deal, this one included);
-- approval is not payment; hotel requests need a valid Accounts go-ahead;
-- deposit before supplier confirmation, balance/full only after; a payment
-- is not recorded while the supplier's latest bank details are unapproved or
-- its company funding is not approved.
--
-- Error contract (the message is exactly the token):
--   42501 not_authorized, not_self_approval, not_self_verification |
--   P0002 not_found | 40001 version_changed, duplicate_request |
--   22023 invalid_input, evidence_rejected |
--   55000 not_ready, over_budget, go_ahead_missing, trip_cancelled,
--         over_agreed_cost, customer_money_short, bank_details_on_hold,
--         funding_pending, already_decided, environment_unset,
--         not_configured, procurement_disabled, deal_removed.
--
-- Lock order (never reversed): finance_deal_heads FOR UPDATE (the Deal's
-- money scope; every create/decision/record on the Deal serialises here, so
-- two concurrent requests cannot split past INR 50,000) -> fulfilment task
-- FOR UPDATE -> payment request FOR UPDATE -> funding request FOR UPDATE ->
-- payment counter. Track A's commands lock the task only; customer receipt
-- commands lock the deal head and receipts only.
--
-- Audit rows never carry amounts, bank values, funding reasons or file
-- contents.
--
-- Rollback (forward-only): a NEW migration revoking execute on the public
-- functions below from authenticated. Requests, funding, documents, evidence
-- and audit rows are never deleted.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Tables
-- ===========================================================================

create table public.supplier_money_evidence (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  task_id uuid not null,
  -- Set for payment proofs (the payment they prove).
  payment_request_id uuid,
  kind text not null check (kind in ('proforma', 'payment_proof', 'invoice', 'credit_note')),
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
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  check ((kind = 'payment_proof') = (payment_request_id is not null)),
  check (object_path = legal_entity_id::text || '/' || task_id::text || '/' || id::text),
  unique (legal_entity_id, request_id)
);
create index supplier_money_evidence_task_idx on public.supplier_money_evidence (task_id, kind, status);
create index supplier_money_evidence_payment_idx on public.supplier_money_evidence (payment_request_id)
  where payment_request_id is not null;
comment on table public.supplier_money_evidence is
  'Private supplier money files (bucket supplier-money). Purchase uploads proforma/invoice/credit_note; Accounts uploads payment_proof, which Purchase never reads. No table grant.';

create table public.supplier_payment_counters (
  legal_entity_id uuid not null references public.legal_entities (id),
  year integer not null check (year between 2000 and 2100),
  last_no integer not null default 0 check (last_no >= 0),
  primary key (legal_entity_id, year)
);

create table public.supplier_payment_requests (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  deal_id uuid not null,
  task_id uuid not null,
  supplier_id uuid not null,
  ref_no text not null check (ref_no ~ '^SP-[0-9]{4}-[0-9]{6}$'),
  -- The proposed cost version the request is bound to (the committed copy
  -- made at supplier confirmation carries the same quote and amount).
  cost_version_no integer not null check (cost_version_no >= 1),
  go_ahead_request_id uuid references public.purchase_go_ahead_requests (id),
  part text not null check (part in ('deposit', 'balance', 'full')),
  amount_paise bigint not null check (amount_paise > 0 and amount_paise <= 999999999999999),
  -- amount - company funding: the part paid from the customer's money.
  customer_money_paise bigint not null check (customer_money_paise >= 0),
  due_date date check (due_date between date '2000-01-01' and date '2100-12-31'),
  note text check (note is null or length(note) between 1 and 500),
  proforma_evidence_id uuid not null references public.supplier_money_evidence (id),
  route text not null check (route in ('accounts', 'manager')),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'returned', 'cancelled', 'paid', 'verified')),
  return_reason text check (return_reason is null or length(return_reason) between 10 and 500),
  decided_by uuid references public.staff_profiles (user_id),
  decided_at timestamptz,
  approved_by uuid references public.staff_profiles (user_id),
  approved_at timestamptz,
  cancelled_by uuid references public.staff_profiles (user_id),
  cancelled_at timestamptz,
  paid_on date check (paid_on between date '2000-01-01' and date '2100-12-31'),
  payment_mode text check (payment_mode in ('bank_transfer', 'upi', 'cheque')),
  bank_reference text check (bank_reference is null or (length(bank_reference) between 4 and 40
    and bank_reference ~ '^[A-Za-z0-9/. -]+$')),
  payment_proof_evidence_id uuid references public.supplier_money_evidence (id),
  bank_revision_no integer check (bank_revision_no >= 1),
  recorded_by uuid references public.staff_profiles (user_id),
  recorded_at timestamptz,
  verified_by uuid references public.staff_profiles (user_id),
  verified_at timestamptz,
  resubmits_id uuid unique references public.supplier_payment_requests (id),
  request_id uuid not null,
  requested_by uuid not null references public.staff_profiles (user_id),
  requested_at timestamptz not null default now(),
  row_version integer not null default 1 check (row_version >= 1),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (legal_entity_id, supplier_id) references public.suppliers (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  foreign key (legal_entity_id, branch_id) references public.branches (legal_entity_id, id),
  unique (legal_entity_id, ref_no),
  unique (legal_entity_id, request_id),
  check (customer_money_paise <= amount_paise),
  check (resubmits_id is null or resubmits_id <> id),
  check (approved_by is null or approved_by <> requested_by),
  check (decided_by is null or decided_by <> requested_by),
  check (verified_by is null or verified_by <> recorded_by),
  check ((status = 'returned') = (return_reason is not null)),
  check ((status = 'cancelled') = (cancelled_by is not null and cancelled_at is not null)),
  check ((status in ('approved', 'paid', 'verified')) = (approved_by is not null and approved_at is not null)),
  check ((status in ('paid', 'verified')) = (paid_on is not null and payment_mode is not null and bank_reference is not null
    and payment_proof_evidence_id is not null and bank_revision_no is not null and recorded_by is not null
    and recorded_at is not null)),
  check ((status = 'verified') = (verified_by is not null and verified_at is not null))
);
create index supplier_payment_requests_scope_idx on public.supplier_payment_requests (deal_id, supplier_id, status);
create index supplier_payment_requests_task_idx on public.supplier_payment_requests (task_id, status);
create index supplier_payment_requests_status_idx on public.supplier_payment_requests (legal_entity_id, status, requested_at desc);
create index supplier_payment_requests_requested_by_idx on public.supplier_payment_requests (requested_by, status);
comment on table public.supplier_payment_requests is
  'Supplier payment requests. Live = pending|approved|paid|verified. Route fixed at create from the cumulative live total for (deal, supplier). Approval is not payment; nothing pays automatically. No table grant.';

create table public.company_funding_requests (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  deal_id uuid not null,
  payment_request_id uuid not null unique references public.supplier_payment_requests (id),
  amount_paise bigint not null check (amount_paise > 0),
  reason text not null check (length(reason) between 10 and 500),
  route text not null check (route in ('accounts', 'manager')),
  status text not null default 'pending' check (status in ('pending', 'approved', 'returned', 'recovered')),
  return_reason text check (return_reason is null or length(return_reason) between 10 and 500),
  decided_by uuid references public.staff_profiles (user_id),
  decided_at timestamptz,
  recovered_by uuid references public.staff_profiles (user_id),
  recovered_at timestamptz,
  recovery_note text check (recovery_note is null or length(recovery_note) between 10 and 500),
  requested_by uuid not null references public.staff_profiles (user_id),
  requested_at timestamptz not null default now(),
  row_version integer not null default 1 check (row_version >= 1),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  foreign key (legal_entity_id, branch_id) references public.branches (legal_entity_id, id),
  check (decided_by is null or decided_by <> requested_by),
  check ((status = 'returned') = (return_reason is not null)),
  check ((status = 'pending') = (decided_by is null and decided_at is null)),
  check ((status = 'recovered') = (recovered_by is not null and recovered_at is not null and recovery_note is not null))
);
create index company_funding_requests_deal_idx on public.company_funding_requests (deal_id, status);
create index company_funding_requests_status_idx on public.company_funding_requests (legal_entity_id, status, requested_at desc);
comment on table public.company_funding_requests is
  'Company pays a supplier before customer money arrives. Amount and reason never reach Purchase. Routed by cumulative live company funding on the Deal. No table grant.';

create table public.supplier_documents (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  branch_id uuid not null,
  deal_id uuid not null,
  task_id uuid not null,
  supplier_id uuid not null,
  kind text not null check (kind in ('invoice', 'credit_note')),
  number text not null check (length(number) between 1 and 60 and number !~ '[[:cntrl:]]'),
  doc_date date not null check (doc_date between date '2000-01-01' and date '2100-12-31'),
  total_paise bigint not null check (total_paise > 0 and total_paise <= 999999999999999),
  gst_included boolean not null,
  evidence_id uuid not null unique references public.supplier_money_evidence (id),
  status text not null default 'uploaded' check (status in ('uploaded', 'accepted', 'returned')),
  return_reason text check (return_reason is null or length(return_reason) between 10 and 500),
  uploaded_by uuid not null references public.staff_profiles (user_id),
  uploaded_at timestamptz not null default now(),
  reviewed_by uuid references public.staff_profiles (user_id),
  reviewed_at timestamptz,
  request_id uuid not null,
  row_version integer not null default 1 check (row_version >= 1),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, task_id) references public.fulfilment_tasks (legal_entity_id, id),
  foreign key (legal_entity_id, supplier_id) references public.suppliers (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  unique (legal_entity_id, request_id),
  check (reviewed_by is null or reviewed_by <> uploaded_by),
  check ((status = 'returned') = (return_reason is not null)),
  check ((status = 'uploaded') = (reviewed_by is null and reviewed_at is null))
);
create index supplier_documents_task_idx on public.supplier_documents (task_id, kind, status);
create index supplier_documents_status_idx on public.supplier_documents (legal_entity_id, status, uploaded_at desc);

alter table public.supplier_money_evidence
  add constraint supplier_money_evidence_payment_fk
  foreign key (payment_request_id) references public.supplier_payment_requests (id);

-- ===========================================================================
-- 2. Integrity triggers
-- ===========================================================================

create function authz.sm_no_delete() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  raise exception '% rows cannot be deleted', tg_table_name using errcode = '42501';
end;
$$;

create function authz.sm_evidence_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if (to_jsonb(new) - array['status', 'updated_at', 'stored_at'])
     is distinct from (to_jsonb(old) - array['status', 'updated_at', 'stored_at'])
     or (old.status in ('stored', 'removed') and new.status is distinct from old.status and new.status <> 'removed') then
    raise exception 'supplier money evidence identity is immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Facts are fixed at create; only the decision, payment and verification
-- columns move, and only forward.
create function authz.sm_payment_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_mutable text[] := array['status', 'return_reason', 'decided_by', 'decided_at', 'approved_by', 'approved_at',
    'cancelled_by', 'cancelled_at', 'paid_on', 'payment_mode', 'bank_reference', 'payment_proof_evidence_id',
    'bank_revision_no', 'recorded_by', 'recorded_at', 'verified_by', 'verified_at', 'row_version', 'updated_at'];
begin
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    raise exception 'supplier payment request facts are immutable' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'pending' and new.status in ('approved', 'returned', 'cancelled'))
    or (old.status = 'approved' and new.status in ('paid', 'returned'))
    or (old.status = 'paid' and new.status = 'verified')) then
    raise exception 'supplier payment request status cannot move this way' using errcode = '42501';
  end if;
  return new;
end;
$$;

create function authz.sm_funding_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_mutable text[] := array['status', 'return_reason', 'decided_by', 'decided_at', 'recovered_by', 'recovered_at',
    'recovery_note', 'row_version', 'updated_at'];
begin
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    raise exception 'company funding facts are immutable' using errcode = '42501';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'pending' and new.status in ('approved', 'returned'))
    or (old.status = 'approved' and new.status = 'recovered')) then
    raise exception 'company funding status cannot move this way' using errcode = '42501';
  end if;
  return new;
end;
$$;

create function authz.sm_document_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_mutable text[] := array['status', 'return_reason', 'reviewed_by', 'reviewed_at', 'row_version', 'updated_at'];
begin
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable)
     or (new.status is distinct from old.status and old.status <> 'uploaded') then
    raise exception 'supplier document facts are immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger supplier_money_evidence_a_no_delete before delete on public.supplier_money_evidence
  for each row execute function authz.sm_no_delete();
create trigger supplier_money_evidence_b_guard before update on public.supplier_money_evidence
  for each row execute function authz.sm_evidence_guard();
create trigger supplier_payment_requests_a_no_delete before delete on public.supplier_payment_requests
  for each row execute function authz.sm_no_delete();
create trigger supplier_payment_requests_b_guard before update on public.supplier_payment_requests
  for each row execute function authz.sm_payment_guard();
create trigger company_funding_requests_a_no_delete before delete on public.company_funding_requests
  for each row execute function authz.sm_no_delete();
create trigger company_funding_requests_b_guard before update on public.company_funding_requests
  for each row execute function authz.sm_funding_guard();
create trigger supplier_documents_a_no_delete before delete on public.supplier_documents
  for each row execute function authz.sm_no_delete();
create trigger supplier_documents_b_guard before update on public.supplier_documents
  for each row execute function authz.sm_document_guard();

-- ===========================================================================
-- 3. Row level security: no permissive policy, no table privilege. Every
--    read and write goes through the security definer functions below.
-- ===========================================================================

do $$
declare
  t text;
begin
  foreach t in array array['supplier_money_evidence', 'supplier_payment_counters', 'supplier_payment_requests',
                           'company_funding_requests', 'supplier_documents'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format(
      'create policy require_valid_session on public.%I as restrictive for all to authenticated
         using ((select authz.session_valid())) with check ((select authz.session_valid()))', t);
    execute format('revoke all on public.%I from public, anon, authenticated, service_role', t);
  end loop;
end;
$$;

-- ===========================================================================
-- 4. Permission catalogue (role-derived, documentation of who acts)
-- ===========================================================================

insert into public.permissions (code, description, is_grantable) values
  ('supplier.payment_request', 'Ask Accounts to pay a supplier for a Purchase task you work on; upload proformas, supplier invoices and credit notes.', false),
  ('supplier.payment_approve', 'Approve or return supplier payment requests and company funding (Accounts up to INR 50,000 cumulative per Deal and supplier; branch Manager above).', false),
  ('supplier.payment_record', 'Record and verify supplier payments, mark company funding recovered and check supplier invoices (two different Accounts people).', false)
on conflict (code) do nothing;

insert into public.role_permissions (role_code, permission_code, scope, policy_status, note) values
  ('purchase', 'supplier.payment_request', 'own', 'confirmed', 'Purchase build 2 Nov 2026: the task assignee asks; nothing pays automatically'),
  ('accounts', 'supplier.payment_approve', 'entity', 'confirmed', 'Owner 2 Nov 2026: cumulative live total per Deal and supplier <= INR 50,000; never own request'),
  ('manager', 'supplier.payment_approve', 'own', 'confirmed', 'Owner 2 Nov 2026: manager of the Deal''s branch above INR 50,000; never own request'),
  ('accounts', 'supplier.payment_record', 'entity', 'confirmed', 'Owner 2 Nov 2026: approver may record; a different Accounts person verifies')
on conflict do nothing;

-- ===========================================================================
-- 5. Helpers
-- ===========================================================================

-- Request identity (finance_command_results), with this module's token.
create function authz.sm_replay(p_entity uuid, p_request uuid, p_command text, p_payload jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_request is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  begin
    return authz.finance_replay(p_entity, p_request, p_command, p_payload);
  exception when sqlstate '40001' then
    raise exception 'duplicate_request' using errcode = '40001';
  end;
end;
$$;

create function authz.sm_remember(p_entity uuid, p_request uuid, p_command text, p_payload jsonb, p_result jsonb)
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

create function authz.sm_task_confirmed(p_status text) returns boolean
language sql immutable set search_path = '' as $$
  select coalesce(p_status in ('supplier_confirmed', 'completed'), false)
$$;

-- Facts of the task's item in its current accepted version.
create function authz.sm_task_facts(p_task uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case when i.service_type = 'hotel' then coalesce(f.facts, authz.hotel_facts_of_version(v.id))
              else coalesce(f.facts, '{}'::jsonb) end
  from public.fulfilment_tasks t
  join public.booking_versions v on v.id = authz.task_current_version(t.id)
  left join public.service_items i on i.id = t.service_item_id
  left join public.service_item_facts f on f.service_item_id = t.service_item_id and f.booking_version_id = v.id
  where t.id = p_task
$$;

create function authz.sm_task_title(p_task uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(authz.service_item_title(coalesce(i.service_type, t.service_purpose), authz.sm_task_facts(t.id)), ''),
                  initcap(coalesce(i.service_type, t.service_purpose)) || coalesce(' ' || i.item_no::text, ''))
  from public.fulfilment_tasks t
  left join public.service_items i on i.id = t.service_item_id
  where t.id = p_task
$$;

create function authz.sm_task_type(p_task uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(i.service_type, t.service_purpose)
  from public.fulfilment_tasks t left join public.service_items i on i.id = t.service_item_id
  where t.id = p_task
$$;

-- Last day of the service: hotel check-out, else the trip end of the version.
create function authz.sm_trip_end(p_task uuid) returns date
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.sf_date(authz.sm_task_facts(t.id) -> 'checkOut'), v.trip_end)
  from public.fulfilment_tasks t
  join public.booking_versions v on v.id = authz.task_current_version(t.id)
  where t.id = p_task
$$;

-- Task confirmed, trip ended, and no non-returned supplier invoice.
create function authz.sm_invoice_missing(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.sm_task_confirmed(t.status)
    and authz.sm_trip_end(t.id) < authz.finance_today()
    and not exists (select 1 from public.supplier_documents s
                    where s.task_id = t.id and s.kind = 'invoice' and s.status <> 'returned'), false)
  from public.fulfilment_tasks t where t.id = p_task
$$;

-- The supplier's latest bank detail revision is approved.
create function authz.sm_bank_approved(p_supplier uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select r.status = 'approved' from public.supplier_beneficiary_revisions r
                   where r.supplier_id = p_supplier order by r.revision_no desc limit 1), false)
$$;

-- Customer money available on the Deal: verified or cleared receipts, minus
-- the customer-money part of live supplier payments (pending ones too, so two
-- pending requests never count the same customer money twice), minus company
-- funding already recovered from it.
create function authz.sm_customer_money_available(p_deal uuid, p_exclude uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce((select sum(r.amount_paise) from public.customer_receipts r
                   where r.deal_id = p_deal and r.status in ('verified', 'cleared')), 0)
       - coalesce((select sum(p.customer_money_paise) from public.supplier_payment_requests p
                   where p.deal_id = p_deal and p.status in ('pending', 'approved', 'paid', 'verified')
                     and p.id is distinct from p_exclude), 0)
       - coalesce((select sum(f.amount_paise) from public.company_funding_requests f
                   where f.deal_id = p_deal and f.status = 'recovered'), 0)
$$;

-- Live total for one supplier on one Deal (route basis).
create function authz.sm_supplier_running_total(p_deal uuid, p_supplier uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(p.amount_paise), 0)::bigint from public.supplier_payment_requests p
  where p.deal_id = p_deal and p.supplier_id = p_supplier and p.status in ('pending', 'approved', 'paid', 'verified')
$$;

-- Live company funding on the Deal (funding route basis): not returned, and
-- its payment request not returned or cancelled.
create function authz.sm_funding_running_total(p_deal uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(f.amount_paise), 0)::bigint
  from public.company_funding_requests f
  join public.supplier_payment_requests p on p.id = f.payment_request_id
  where f.deal_id = p_deal and f.status <> 'returned' and p.status not in ('returned', 'cancelled')
$$;

create function authz.sm_route(p_total bigint) returns text
language sql immutable set search_path = '' as $$
  select case when p_total > 5000000 then 'manager' else 'accounts' end
$$;

-- Why an approved (or pending) payment cannot be recorded yet.
create function authz.sm_hold_reason(p_payment uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when p.status not in ('pending', 'approved') then null
    when not authz.sm_bank_approved(p.supplier_id) then 'bank_details_on_hold'
    when p.status <> 'approved' then null
    when f.status = 'pending' then 'funding_pending'
    when f.status = 'returned' then 'funding_returned'
    else null
  end
  from public.supplier_payment_requests p
  left join public.company_funding_requests f on f.payment_request_id = p.id
  where p.id = p_payment
$$;

-- Accounts of the entity, through the finance gate for this synthetic flag.
create function authz.sm_accounts_sees(p_entity uuid, p_synthetic boolean) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.can_accounts(p_entity) and authz.finance_gate_issue(p_entity, p_synthetic) is null, false)
$$;

-- The viewer may decide (approve/return) for this route on this Deal.
create function authz.sm_can_decide_route(p_route text, p_entity uuid, p_deal uuid, p_synthetic boolean) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(not authz.finance_deal_conflict(p_deal) and case p_route
    when 'accounts' then authz.sm_accounts_sees(p_entity, p_synthetic)
    when 'manager' then authz.session_ok() and authz.is_branch_sales_manager(p_deal)
                        and not authz.holds_role('purchase', p_entity)
                        and authz.finance_gate_issue(p_entity, p_synthetic) is null
    else false end, false)
$$;

-- Permission then environment for a decision; raises the token.
create function authz.sm_require_decider(p_route text, p_entity uuid, p_deal uuid, p_synthetic boolean) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v_issue text;
begin
  if p_route = 'accounts' then
    perform authz.finance_require_accounts(p_entity, p_synthetic);
  elsif p_route = 'manager' then
    -- A manager who also holds Purchase in the entity never decides money.
    if not coalesce(authz.session_ok(), false) or not authz.is_branch_sales_manager(p_deal)
       or authz.holds_role('purchase', p_entity) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    v_issue := authz.finance_gate_issue(p_entity, p_synthetic);
    if v_issue is not null then
      raise exception '%', v_issue using errcode = '55000';
    end if;
  else
    raise exception 'not_authorized' using errcode = '42501';
  end if;
end;
$$;

-- Next SP-YYYY-NNNNNN for the entity (calendar year, Asia/Kolkata).
create function authz.sm_next_ref(p_entity uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_year integer := extract(year from authz.finance_today())::integer;
  v_no integer;
begin
  insert into public.supplier_payment_counters (legal_entity_id, year, last_no) values (p_entity, v_year, 1)
  on conflict (legal_entity_id, year) do update set last_no = public.supplier_payment_counters.last_no + 1
  returning last_no into v_no;
  return 'SP-' || v_year::text || '-' || lpad(v_no::text, 6, '0');
end;
$$;

-- Track A placeholder replaced: a live payment request exists on the task's
-- current agreed (latest proposed) cost version. purchase_cost_propose then
-- refuses a new cost with payment_in_progress.
create or replace function authz.purchase_has_live_payment(p_task uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.supplier_payment_requests p
    where p.task_id = p_task and p.status in ('pending', 'approved', 'paid', 'verified')
      and p.cost_version_no = (select c.version_no from public.purchase_cost_versions c
                               where c.task_id = p_task and c.stage = 'proposed'
                               order by c.version_no desc limit 1))
$$;

-- Track A's credit note check widened: a stored Purchase file of the task,
-- or a stored supplier-money credit note of the task.
create or replace function authz.cancellation_credit_note_ok(p_task uuid, p_evidence uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.purchase_evidence e
                 where e.id = p_evidence and e.task_id = p_task and e.status = 'stored')
      or exists (select 1 from public.supplier_money_evidence e
                 where e.id = p_evidence and e.task_id = p_task and e.kind = 'credit_note' and e.status = 'stored')
$$;

revoke all on function
  authz.sm_no_delete(), authz.sm_evidence_guard(), authz.sm_payment_guard(), authz.sm_funding_guard(),
  authz.sm_document_guard(),
  authz.sm_replay(uuid, uuid, text, jsonb), authz.sm_remember(uuid, uuid, text, jsonb, jsonb),
  authz.sm_task_confirmed(text), authz.sm_task_facts(uuid), authz.sm_task_title(uuid),
  authz.sm_task_type(uuid), authz.sm_trip_end(uuid), authz.sm_invoice_missing(uuid), authz.sm_bank_approved(uuid),
  authz.sm_customer_money_available(uuid, uuid),
  authz.sm_supplier_running_total(uuid, uuid), authz.sm_funding_running_total(uuid), authz.sm_route(bigint),
  authz.sm_hold_reason(uuid), authz.sm_accounts_sees(uuid, boolean), authz.sm_can_decide_route(text, uuid, uuid, boolean),
  authz.sm_require_decider(text, uuid, uuid, boolean), authz.sm_next_ref(uuid),
  authz.purchase_has_live_payment(uuid), authz.cancellation_credit_note_ok(uuid, uuid)
from public, anon, authenticated;

-- ===========================================================================
-- 6. Evidence (private bucket supplier-money)
-- ===========================================================================

-- Purchase kinds target a task; payment_proof targets an approved payment.
create function public.supplier_money_evidence_begin(
  p_kind text, p_target_id uuid, p_file_name text, p_mime text, p_size_bytes integer, p_sha256 text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_pay public.supplier_payment_requests%rowtype;
  v_synthetic boolean;
  v_gate text;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_name text := btrim(coalesce(p_file_name, ''));
  v_sha text := lower(coalesce(p_sha256, ''));
  v_payload jsonb := jsonb_build_object('kind', p_kind, 'targetId', p_target_id, 'fileName', p_file_name,
    'mime', p_mime, 'sizeBytes', p_size_bytes, 'sha256', p_sha256);
  v_result jsonb;
begin
  if p_kind = 'payment_proof' then
    select * into v_pay from public.supplier_payment_requests p where p.id = p_target_id;
    if v_pay.id is null then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    select d.is_synthetic into v_synthetic from public.deals d where d.id = v_pay.deal_id;
    perform authz.finance_require_accounts(v_pay.legal_entity_id, v_synthetic);
    select * into v_task from public.fulfilment_tasks t where t.id = v_pay.task_id;
  elsif p_kind in ('proforma', 'invoice', 'credit_note') then
    select * into v_task from public.fulfilment_tasks t where t.id = p_target_id;
    if v_task.id is null or v_task.department is distinct from 'purchase'
       or not authz.holds_active_role('purchase', v_task.legal_entity_id)
       or (p_kind = 'proforma' and not authz.can_work_purchase_task(v_task.id)) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    v_gate := authz.procurement_gate_issue(v_task.id);
    if v_gate is not null then
      raise exception '%', v_gate using errcode = '55000';
    end if;
  else
    if not coalesce(authz.session_ok(), false) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  v_result := authz.sm_replay(v_task.legal_entity_id, p_request_id, 'supplier_money_evidence_begin', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  if p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes not between 1 and 4194304
     or v_sha !~ '^[0-9a-f]{64}$'
     or length(v_name) not between 1 and 120 or v_name !~ '^[A-Za-z0-9._ -]+$' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  if p_kind = 'payment_proof' and v_pay.status <> 'approved' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if (select count(*) from public.supplier_money_evidence e
      where e.task_id = v_task.id and e.status <> 'removed') >= 40 then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  v_path := v_task.legal_entity_id::text || '/' || v_task.id::text || '/' || v_id::text;
  insert into public.supplier_money_evidence (id, legal_entity_id, task_id, payment_request_id, kind, object_path,
    file_name, mime, size_bytes, sha256, uploaded_by, request_id)
  values (v_id, v_task.legal_entity_id, v_task.id, v_pay.id, p_kind, v_path, v_name, p_mime, p_size_bytes, v_sha,
    (select auth.uid()), p_request_id);

  v_result := jsonb_build_object('outcome', 'created', 'evidenceId', v_id, 'objectPath', v_path);
  perform authz.sm_remember(v_task.legal_entity_id, p_request_id, 'supplier_money_evidence_begin', v_payload, v_result);
  perform authz.write_audit('purchase.money_file_started', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('evidenceId', v_id, 'kind', p_kind, 'mime', p_mime, 'sizeBytes', p_size_bytes));
  return v_result;
end;
$$;

create function public.supplier_money_evidence_finish(p_evidence_id uuid, p_ok boolean) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ev public.supplier_money_evidence%rowtype;
  v_branch uuid;
  v_status text;
  v_missing boolean := false;
begin
  select * into v_ev from public.supplier_money_evidence e where e.id = p_evidence_id for update;
  if v_ev.id is null or not coalesce(authz.session_ok(), false) or v_ev.uploaded_by is distinct from (select auth.uid()) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_ok is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_status := case when p_ok then 'stored' else 'failed' end;
  if v_ev.status <> 'pending_upload' then
    if v_ev.status = v_status or (p_ok and v_ev.status = 'failed') then
      return jsonb_build_object('evidenceId', v_ev.id, 'status', v_ev.status);
    end if;
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  -- 'stored' only when Storage holds the object at the generated path with the declared size.
  if p_ok and (to_regclass('storage.objects') is null or not exists (
       select 1 from storage.objects o
       where o.bucket_id = 'supplier-money' and o.name = v_ev.object_path
         and (o.metadata ->> 'size') ~ '^[0-9]{1,18}$'
         and (o.metadata ->> 'size')::bigint = v_ev.size_bytes)) then
    v_status := 'failed';
    v_missing := true;
  end if;

  update public.supplier_money_evidence e
  set status = v_status, stored_at = case when v_status = 'stored' then now() else null end, updated_at = now()
  where e.id = v_ev.id;
  select t.branch_id into v_branch from public.fulfilment_tasks t where t.id = v_ev.task_id;
  perform authz.write_audit(case when v_status = 'stored' then 'purchase.money_file_stored' else 'purchase.money_file_failed' end,
    v_ev.legal_entity_id, v_branch, 'fulfilment_task', v_ev.task_id, null,
    jsonb_build_object('evidenceId', v_ev.id, 'kind', v_ev.kind, 'objectMissing', v_missing));
  return jsonb_build_object('evidenceId', v_ev.id, 'status', v_status);
end;
$$;

-- Payment proofs: Accounts only. Other kinds: Purchase of the entity, the
-- manager of the Deal's branch, or Accounts of the entity.
create function public.supplier_money_evidence_authorize_download(p_evidence_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ev public.supplier_money_evidence%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_synthetic boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_ev from public.supplier_money_evidence e where e.id = p_evidence_id;
  if v_ev.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = v_ev.task_id;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = v_task.deal_id;
  if v_ev.kind = 'payment_proof' then
    if not authz.sm_accounts_sees(v_ev.legal_entity_id, v_synthetic) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
  elsif not ((v_task.department = 'purchase' and authz.holds_active_role('purchase', v_task.legal_entity_id))
             or authz.is_branch_sales_manager(v_task.deal_id)
             or authz.sm_accounts_sees(v_ev.legal_entity_id, v_synthetic)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ev.status <> 'stored' then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.write_audit('purchase.money_file_viewed', v_ev.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_ev.task_id, null, jsonb_build_object('evidenceId', v_ev.id, 'kind', v_ev.kind));
  return jsonb_build_object('objectPath', v_ev.object_path, 'fileName', v_ev.file_name, 'mime', v_ev.mime);
end;
$$;

-- ===========================================================================
-- 7. Payment requests
-- ===========================================================================

-- Shared by create and resubmit. Fields (camelCase, unknown keys refused):
-- expectedCostVersionNo, part, amountPaise, dueDate, note, proformaEvidenceId,
-- askFunding, fundingReason.
create function authz.sm_payment_create(p_task_id uuid, p_fields jsonb, p_request_id uuid, p_resubmits uuid, p_command text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_old public.supplier_payment_requests%rowtype;
  v_cost public.purchase_cost_versions;
  v_supplier uuid;
  v_quote_status text;
  v_gate text;
  v_payload jsonb;
  v_result jsonb;
  v_part text;
  v_amount bigint;
  v_due date;
  v_note text;
  v_proforma uuid;
  v_reason text;
  v_expected integer;
  v_budget bigint;
  v_live bigint;
  v_available bigint;
  v_funding bigint;
  v_route text;
  v_funding_route text;
  v_go_ahead uuid;
  v_id uuid := gen_random_uuid();
  v_ref text;
begin
  -- 1. Who: the assignee of this Purchase task (unlocked read, then locks).
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or v_task.department is distinct from 'purchase' or not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.finance_lock_deal(v_task.deal_id);
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  -- Wait for an in-flight removal of the Deal so the gate reads its result.
  perform 1 from public.deals d where d.id = v_task.deal_id for key share;
  if not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_gate := authz.procurement_gate_issue(v_task.id);
  if v_gate is not null then
    raise exception '%', v_gate using errcode = '55000';
  end if;

  v_payload := jsonb_build_object('taskId', p_task_id, 'resubmitsId', p_resubmits, 'fields', p_fields);
  v_result := authz.sm_replay(v_task.legal_entity_id, p_request_id, p_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;

  -- 2. Input.
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['expectedCostVersionNo', 'part', 'amountPaise', 'dueDate', 'note', 'proformaEvidenceId',
                          'askFunding', 'fundingReason']) <> '{}'::jsonb
     or jsonb_typeof(p_fields -> 'expectedCostVersionNo') is distinct from 'number'
     or (p_fields ->> 'expectedCostVersionNo') !~ '^[0-9]{1,9}$'
     or (p_fields ? 'askFunding' and jsonb_typeof(p_fields -> 'askFunding') not in ('boolean', 'null')) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_expected := (p_fields ->> 'expectedCostVersionNo')::integer;
  v_part := authz.finance_field(p_fields, 'part');
  v_amount := authz.finance_paise(p_fields, 'amountPaise', 1);
  v_due := authz.finance_date(authz.finance_field(p_fields, 'dueDate'));
  v_note := authz.finance_text(authz.finance_field(p_fields, 'note'), 1, 500, true);
  v_proforma := authz.finance_uuid(authz.finance_field(p_fields, 'proformaEvidenceId'));
  -- Optional note for Accounts (10-500), stored as the company funding
  -- reason only when funding is needed. askFunding is accepted and ignored
  -- (earlier clients): Purchase gets no customer money signal at all.
  v_reason := authz.finance_text(authz.finance_field(p_fields, 'fundingReason'), 10, 500, true);
  if v_part is null or v_part not in ('deposit', 'balance', 'full') or v_amount is null
     or v_amount > 999999999999999 or v_proforma is null
     or (v_due is not null and v_due not between date '2000-01-01' and date '2100-12-31') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  -- 3. The returned request being sent again.
  if p_resubmits is not null then
    select * into v_old from public.supplier_payment_requests p where p.id = p_resubmits for update;
    if v_old.id is null or v_old.task_id <> v_task.id then
      raise exception 'invalid_input' using errcode = '22023';
    end if;
    if v_old.status <> 'returned'
       or exists (select 1 from public.supplier_payment_requests p where p.resubmits_id = v_old.id) then
      raise exception 'already_decided' using errcode = '55000';
    end if;
  end if;

  -- 4. Business checks, in contract order.
  if authz.deal_trip_cancelled(v_task.deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  v_cost := authz.purchase_agreed_cost(v_task.id);
  if v_cost.id is null then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if v_expected is distinct from v_cost.version_no then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  select q.supplier_id, q.status into v_supplier, v_quote_status
  from public.purchase_quotes q where q.id = v_cost.quote_id;
  if v_part in ('balance', 'full') and not authz.sm_task_confirmed(v_task.status) then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if not authz.sm_task_confirmed(v_task.status) then
    if v_quote_status is distinct from 'open' then
      raise exception 'not_ready' using errcode = '55000';
    end if;
    v_budget := authz.task_budget(v_task.id);
    if (v_budget is null or v_cost.amount_paise > v_budget)
       and not authz.cost_version_approved(v_task.id, v_cost.version_no) then
      raise exception 'over_budget' using errcode = '55000';
    end if;
    if authz.purchase_go_ahead_needed(v_task.id) then
      -- The booking request e-mail must have gone (sent or marked sent), not
      -- merely be queued or failed.
      if not authz.purchase_booking_request_sent(v_task.id) then
        raise exception 'booking_request_not_sent' using errcode = '55000';
      end if;
      if not authz.purchase_go_ahead_valid(v_task.id) then
        raise exception 'go_ahead_missing' using errcode = '55000';
      end if;
    end if;
  end if;
  if not exists (select 1 from public.supplier_money_evidence e
                 where e.id = v_proforma and e.task_id = v_task.id and e.kind = 'proforma' and e.status = 'stored') then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  select coalesce(sum(p.amount_paise), 0) into v_live from public.supplier_payment_requests p
  where p.task_id = v_task.id and p.status in ('pending', 'approved', 'paid', 'verified');
  if v_live + v_amount > v_cost.amount_paise then
    raise exception 'over_agreed_cost' using errcode = '55000';
  end if;
  -- Customer money (lead decision, review F1): Purchase gets no signal and
  -- no refusal. When the Deal's available customer money does not cover the
  -- amount, the company funding request for the difference is created here
  -- automatically; nothing in the reply depends on it.
  v_available := greatest(authz.sm_customer_money_available(v_task.deal_id, null), 0);
  v_funding := greatest(v_amount - v_available, 0);

  -- 5. Route: every live request for this supplier on this Deal, this one included.
  v_route := authz.sm_route(authz.sm_supplier_running_total(v_task.deal_id, v_supplier) + v_amount);
  select g.id into v_go_ahead from public.purchase_go_ahead_requests g
  where g.task_id = v_task.id and g.status = 'approved'
  order by g.decided_at desc nulls last, g.requested_at desc limit 1;

  v_ref := authz.sm_next_ref(v_task.legal_entity_id);
  insert into public.supplier_payment_requests (id, legal_entity_id, branch_id, deal_id, task_id, supplier_id, ref_no,
    cost_version_no, go_ahead_request_id, part, amount_paise, customer_money_paise, due_date, note,
    proforma_evidence_id, route, resubmits_id, request_id, requested_by)
  values (v_id, v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, v_supplier, v_ref,
    v_cost.version_no, v_go_ahead, v_part, v_amount, v_amount - v_funding, v_due, v_note,
    v_proforma, v_route, p_resubmits, p_request_id, v_uid);

  if v_funding > 0 then
    v_funding_route := authz.sm_route(authz.sm_funding_running_total(v_task.deal_id) + v_funding);
    insert into public.company_funding_requests (legal_entity_id, branch_id, deal_id, payment_request_id, amount_paise,
      reason, route, requested_by)
    values (v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_id, v_funding,
      coalesce(v_reason, 'No note from Purchase'), v_funding_route, v_uid);
  end if;

  perform authz.write_audit(case when p_resubmits is null then 'purchase.payment_requested' else 'purchase.payment_resubmitted' end,
    v_task.legal_entity_id, v_task.branch_id, 'fulfilment_task', v_task.id, null,
    jsonb_build_object('paymentRequestId', v_id, 'refNo', v_ref, 'part', v_part, 'route', v_route,
      'costVersionNo', v_cost.version_no, 'resubmitsId', p_resubmits));

  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'refNo', v_ref, 'route', v_route,
    'status', 'pending');
  return authz.sm_remember(v_task.legal_entity_id, p_request_id, p_command, v_payload, v_result);
end;
$$;
revoke all on function authz.sm_payment_create(uuid, jsonb, uuid, uuid, text) from public, anon, authenticated;

create function public.supplier_payment_request_create(p_task_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  return authz.sm_payment_create(p_task_id, p_fields, p_request_id, null, 'supplier_payment_request_create');
end;
$$;

create function public.supplier_payment_request_resubmit(p_payment_id uuid, p_fields jsonb, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task uuid;
begin
  select p.task_id into v_task from public.supplier_payment_requests p where p.id = p_payment_id;
  if v_task is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  return authz.sm_payment_create(v_task, p_fields, p_request_id, p_payment_id, 'supplier_payment_request_resubmit');
end;
$$;

-- A request may still be approved or paid: no trip cancellation, the agreed
-- cost is still the one it was made for, and (before supplier confirmation)
-- a hotel's go-ahead is still valid. Raises trip_cancelled / version_changed.
create function authz.sm_payment_still_valid(p_payment uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.supplier_payment_requests%rowtype;
  v_status text;
begin
  select * into v from public.supplier_payment_requests p where p.id = p_payment;
  if authz.deal_trip_cancelled(v.deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  if (authz.purchase_agreed_cost(v.task_id)).version_no is distinct from v.cost_version_no then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  select t.status into v_status from public.fulfilment_tasks t where t.id = v.task_id;
  if not authz.sm_task_confirmed(v_status)
     and authz.purchase_go_ahead_needed(v.task_id) and not authz.purchase_go_ahead_valid(v.task_id) then
    raise exception 'version_changed' using errcode = '40001';
  end if;
end;
$$;
revoke all on function authz.sm_payment_still_valid(uuid) from public, anon, authenticated;

-- Permission (unlocked read) then lock order deal head -> payment row.
create function authz.sm_payment_for_command(p_payment uuid, p_actor text) returns public.supplier_payment_requests
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.supplier_payment_requests%rowtype;
  v_synthetic boolean;
begin
  select * into v from public.supplier_payment_requests p where p.id = p_payment;
  if v.id is null then
    if coalesce(authz.session_ok(), false) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = v.deal_id;
  if p_actor = 'decider' then
    perform authz.sm_require_decider(v.route, v.legal_entity_id, v.deal_id, v_synthetic);
  elsif p_actor = 'accounts' then
    perform authz.finance_require_accounts(v.legal_entity_id, v_synthetic);
  elsif p_actor = 'requester' then
    if not coalesce(authz.session_ok(), false) or v.requested_by is distinct from (select auth.uid())
       or not authz.holds_active_role('purchase', v.legal_entity_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
  else
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.finance_lock_deal(v.deal_id);
  select * into v from public.supplier_payment_requests p where p.id = p_payment for update;
  return v;
end;
$$;
revoke all on function authz.sm_payment_for_command(uuid, text) from public, anon, authenticated;

create function public.supplier_payment_request_cancel(p_payment_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.supplier_payment_requests%rowtype;
  v_payload jsonb := jsonb_build_object('paymentId', p_payment_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  v := authz.sm_payment_for_command(p_payment_id, 'requester');
  v_result := authz.sm_replay(v.legal_entity_id, p_request_id, 'supplier_payment_request_cancel', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v.status <> 'pending' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  update public.supplier_payment_requests p
  set status = 'cancelled', cancelled_by = (select auth.uid()), cancelled_at = now(),
      row_version = p.row_version + 1, updated_at = now()
  where p.id = v.id returning * into v;
  perform authz.write_audit('purchase.payment_cancelled', v.legal_entity_id, v.branch_id, 'fulfilment_task', v.task_id,
    null, jsonb_build_object('paymentRequestId', v.id, 'refNo', v.ref_no));
  v_result := jsonb_build_object('outcome', 'created', 'id', v.id, 'status', v.status, 'rowVersion', v.row_version);
  return authz.sm_remember(v.legal_entity_id, p_request_id, 'supplier_payment_request_cancel', v_payload, v_result);
end;
$$;

-- approve | return. Route accounts: Accounts of the entity; route manager:
-- the manager of the Deal's branch. Never the requester. An approved,
-- unpaid request may be returned only while it is on hold.
create function public.supplier_payment_decide(
  p_payment_id uuid, p_decision text, p_reason text, p_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v public.supplier_payment_requests%rowtype;
  v_reason text;
  v_payload jsonb := jsonb_build_object('paymentId', p_payment_id, 'decision', p_decision, 'reason', p_reason,
    'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  v := authz.sm_payment_for_command(p_payment_id, 'decider');
  v_result := authz.sm_replay(v.legal_entity_id, p_request_id, 'supplier_payment_decide', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_decision is null or p_decision not in ('approve', 'return') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- Never the requester, the Deal's owner or its Sales assignee (review F6).
  if v.requested_by = v_uid or authz.finance_deal_conflict(v.deal_id) then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  -- Decisions are final, except that an approved request still on hold
  -- (bank details or company funding) may be returned so it stops blocking.
  if not (v.status = 'pending'
          or (p_decision = 'return' and v.status = 'approved' and authz.sm_hold_reason(v.id) is not null)) then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;

  if p_decision = 'approve' then
    perform authz.sm_payment_still_valid(v.id);
    if v.customer_money_paise > authz.sm_customer_money_available(v.deal_id, v.id) then
      raise exception 'customer_money_short' using errcode = '55000';
    end if;
    update public.supplier_payment_requests p
    set status = 'approved', decided_by = v_uid, decided_at = now(), approved_by = v_uid, approved_at = now(),
        row_version = p.row_version + 1, updated_at = now()
    where p.id = v.id returning * into v;
  else
    v_reason := authz.finance_reason(p_reason);
    update public.supplier_payment_requests p
    set status = 'returned', return_reason = v_reason, decided_by = v_uid, decided_at = now(),
        approved_by = null, approved_at = null,
        row_version = p.row_version + 1, updated_at = now()
    where p.id = v.id returning * into v;
  end if;

  perform authz.write_audit(case when p_decision = 'approve' then 'finance.supplier_payment_approved'
                                 else 'finance.supplier_payment_returned' end,
    v.legal_entity_id, v.branch_id, 'fulfilment_task', v.task_id, null,
    jsonb_build_object('paymentRequestId', v.id, 'refNo', v.ref_no, 'route', v.route));
  v_result := jsonb_build_object('outcome', 'created', 'id', v.id, 'status', v.status, 'rowVersion', v.row_version);
  return authz.sm_remember(v.legal_entity_id, p_request_id, 'supplier_payment_decide', v_payload, v_result);
end;
$$;

-- Accounts states the money left the company's bank; nothing is paid here.
create function public.supplier_payment_record(
  p_payment_id uuid, p_paid_on date, p_mode text, p_bank_reference text, p_proof_evidence_id uuid,
  p_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v public.supplier_payment_requests%rowtype;
  v_funding text;
  v_revision integer;
  v_ref text;
  v_payload jsonb := jsonb_build_object('paymentId', p_payment_id, 'paidOn', p_paid_on, 'mode', p_mode,
    'bankReference', p_bank_reference, 'proofEvidenceId', p_proof_evidence_id,
    'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  v := authz.sm_payment_for_command(p_payment_id, 'accounts');
  v_result := authz.sm_replay(v.legal_entity_id, p_request_id, 'supplier_payment_record', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v.status <> 'approved' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_ref := authz.finance_text(p_bank_reference, 4, 40, false);
  if p_paid_on is null or p_paid_on not between date '2000-01-01' and authz.finance_today()
     or p_mode is null or p_mode not in ('bank_transfer', 'upi', 'cheque')
     or v_ref is null or v_ref !~ '^[A-Za-z0-9/. -]+$' or p_proof_evidence_id is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  perform authz.sm_payment_still_valid(v.id);
  select r.revision_no into v_revision from public.supplier_beneficiary_revisions r
  where r.supplier_id = v.supplier_id order by r.revision_no desc limit 1;
  if not authz.sm_bank_approved(v.supplier_id) then
    raise exception 'bank_details_on_hold' using errcode = '55000';
  end if;
  select f.status into v_funding from public.company_funding_requests f where f.payment_request_id = v.id for update;
  if v_funding is not null and v_funding not in ('approved', 'recovered') then
    raise exception 'funding_pending' using errcode = '55000';
  end if;
  if not exists (select 1 from public.supplier_money_evidence e
                 where e.id = p_proof_evidence_id and e.payment_request_id = v.id
                   and e.kind = 'payment_proof' and e.status = 'stored') then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  update public.supplier_payment_requests p
  set status = 'paid', paid_on = p_paid_on, payment_mode = p_mode, bank_reference = v_ref,
      payment_proof_evidence_id = p_proof_evidence_id, bank_revision_no = v_revision,
      recorded_by = v_uid, recorded_at = now(), row_version = p.row_version + 1, updated_at = now()
  where p.id = v.id returning * into v;
  -- No bank values or amounts in the audit trail.
  perform authz.write_audit('finance.supplier_payment_recorded', v.legal_entity_id, v.branch_id, 'fulfilment_task',
    v.task_id, null, jsonb_build_object('paymentRequestId', v.id, 'refNo', v.ref_no, 'mode', p_mode,
      'bankRevisionNo', v_revision));
  v_result := jsonb_build_object('outcome', 'created', 'id', v.id, 'status', v.status, 'rowVersion', v.row_version);
  return authz.sm_remember(v.legal_entity_id, p_request_id, 'supplier_payment_record', v_payload, v_result);
end;
$$;

create function public.supplier_payment_verify(p_payment_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v public.supplier_payment_requests%rowtype;
  v_payload jsonb := jsonb_build_object('paymentId', p_payment_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  v := authz.sm_payment_for_command(p_payment_id, 'accounts');
  v_result := authz.sm_replay(v.legal_entity_id, p_request_id, 'supplier_payment_verify', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v.status <> 'paid' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if v.recorded_by = v_uid then
    raise exception 'not_self_verification' using errcode = '42501';
  end if;
  if p_expected_row_version is distinct from v.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  update public.supplier_payment_requests p
  set status = 'verified', verified_by = v_uid, verified_at = now(), row_version = p.row_version + 1, updated_at = now()
  where p.id = v.id returning * into v;
  perform authz.write_audit('finance.supplier_payment_verified', v.legal_entity_id, v.branch_id, 'fulfilment_task',
    v.task_id, null, jsonb_build_object('paymentRequestId', v.id, 'refNo', v.ref_no));
  v_result := jsonb_build_object('outcome', 'created', 'id', v.id, 'status', v.status, 'rowVersion', v.row_version);
  return authz.sm_remember(v.legal_entity_id, p_request_id, 'supplier_payment_verify', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 8. Company funding
-- ===========================================================================

create function authz.sm_funding_for_command(p_funding uuid, p_actor text) returns public.company_funding_requests
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.company_funding_requests%rowtype;
  v_synthetic boolean;
begin
  select * into v from public.company_funding_requests f where f.id = p_funding;
  if v.id is null then
    if coalesce(authz.session_ok(), false) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = v.deal_id;
  if p_actor = 'decider' then
    perform authz.sm_require_decider(v.route, v.legal_entity_id, v.deal_id, v_synthetic);
  else
    perform authz.finance_require_accounts(v.legal_entity_id, v_synthetic);
  end if;
  perform authz.finance_lock_deal(v.deal_id);
  perform 1 from public.supplier_payment_requests p where p.id = v.payment_request_id for update;
  select * into v from public.company_funding_requests f where f.id = p_funding for update;
  return v;
end;
$$;
revoke all on function authz.sm_funding_for_command(uuid, text) from public, anon, authenticated;

create function public.company_funding_decide(
  p_funding_id uuid, p_decision text, p_reason text, p_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v public.company_funding_requests%rowtype;
  v_pay public.supplier_payment_requests%rowtype;
  v_reason text;
  v_payload jsonb := jsonb_build_object('fundingId', p_funding_id, 'decision', p_decision, 'reason', p_reason,
    'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  v := authz.sm_funding_for_command(p_funding_id, 'decider');
  v_result := authz.sm_replay(v.legal_entity_id, p_request_id, 'company_funding_decide', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_decision is null or p_decision not in ('approve', 'return') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if v.requested_by = v_uid or authz.finance_deal_conflict(v.deal_id) then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  select * into v_pay from public.supplier_payment_requests p where p.id = v.payment_request_id;
  if v.status <> 'pending' or v_pay.status in ('returned', 'cancelled') then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if p_decision = 'approve' then
    update public.company_funding_requests f
    set status = 'approved', decided_by = v_uid, decided_at = now(), row_version = f.row_version + 1, updated_at = now()
    where f.id = v.id returning * into v;
  else
    v_reason := authz.finance_reason(p_reason);
    update public.company_funding_requests f
    set status = 'returned', return_reason = v_reason, decided_by = v_uid, decided_at = now(),
        row_version = f.row_version + 1, updated_at = now()
    where f.id = v.id returning * into v;
  end if;
  -- Funding audits target the funding row: Purchase's task history never shows them.
  perform authz.write_audit(case when p_decision = 'approve' then 'finance.company_funding_approved'
                                 else 'finance.company_funding_returned' end,
    v.legal_entity_id, v.branch_id, 'company_funding_request', v.id, null,
    jsonb_build_object('paymentRequestId', v.payment_request_id, 'route', v.route));
  v_result := jsonb_build_object('outcome', 'created', 'id', v.id, 'status', v.status, 'rowVersion', v.row_version);
  return authz.sm_remember(v.legal_entity_id, p_request_id, 'company_funding_decide', v_payload, v_result);
end;
$$;

create function public.company_funding_mark_recovered(
  p_funding_id uuid, p_note text, p_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v public.company_funding_requests%rowtype;
  v_pay_status text;
  v_note text;
  v_payload jsonb := jsonb_build_object('fundingId', p_funding_id, 'note', p_note,
    'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  v := authz.sm_funding_for_command(p_funding_id, 'accounts');
  v_result := authz.sm_replay(v.legal_entity_id, p_request_id, 'company_funding_mark_recovered', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v.status <> 'approved' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  select p.status into v_pay_status from public.supplier_payment_requests p where p.id = v.payment_request_id;
  if v_pay_status not in ('paid', 'verified') then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  v_note := authz.finance_reason(p_note);
  update public.company_funding_requests f
  set status = 'recovered', recovered_by = v_uid, recovered_at = now(), recovery_note = v_note,
      row_version = f.row_version + 1, updated_at = now()
  where f.id = v.id returning * into v;
  perform authz.write_audit('finance.company_funding_recovered', v.legal_entity_id, v.branch_id,
    'company_funding_request', v.id, null, jsonb_build_object('paymentRequestId', v.payment_request_id));
  v_result := jsonb_build_object('outcome', 'created', 'id', v.id, 'status', v.status, 'rowVersion', v.row_version);
  return authz.sm_remember(v.legal_entity_id, p_request_id, 'company_funding_mark_recovered', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 9. Supplier invoices and credit notes
-- ===========================================================================

-- Fields: kind, number, docDate, totalPaise, gstIncluded, evidenceId.
-- Purchase of the task's entity (also after supplier confirmation). The
-- supplier is the supplier of the task's agreed cost.
create function public.supplier_document_upload(p_task_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_cost public.purchase_cost_versions;
  v_supplier uuid;
  v_gate text;
  v_kind text;
  v_number text;
  v_date date;
  v_total bigint;
  v_evidence uuid;
  v_id uuid := gen_random_uuid();
  v_payload jsonb := jsonb_build_object('taskId', p_task_id, 'fields', p_fields);
  v_result jsonb;
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  if v_task.id is null or v_task.department is distinct from 'purchase'
     or not coalesce(authz.session_ok(), false) or not authz.holds_active_role('purchase', v_task.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_gate := authz.procurement_gate_issue(v_task.id);
  if v_gate is not null then
    raise exception '%', v_gate using errcode = '55000';
  end if;
  v_result := authz.sm_replay(v_task.legal_entity_id, p_request_id, 'supplier_document_upload', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['kind', 'number', 'docDate', 'totalPaise', 'gstIncluded', 'evidenceId']) <> '{}'::jsonb
     or jsonb_typeof(p_fields -> 'gstIncluded') is distinct from 'boolean' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_kind := authz.finance_field(p_fields, 'kind');
  v_number := authz.finance_text(authz.finance_field(p_fields, 'number'), 1, 60, false);
  v_date := authz.finance_date(authz.finance_field(p_fields, 'docDate'));
  v_total := authz.finance_paise(p_fields, 'totalPaise', 1);
  v_evidence := authz.finance_uuid(authz.finance_field(p_fields, 'evidenceId'));
  if v_kind is null or v_kind not in ('invoice', 'credit_note') or v_number is null or v_date is null
     or v_date not between date '2000-01-01' and authz.finance_today() + 1
     or v_total is null or v_total > 999999999999999 or v_evidence is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_cost := authz.purchase_agreed_cost(v_task.id);
  if v_cost.id is null then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  select q.supplier_id into v_supplier from public.purchase_quotes q where q.id = v_cost.quote_id;
  if not exists (select 1 from public.supplier_money_evidence e
                 where e.id = v_evidence and e.task_id = v_task.id and e.kind = v_kind and e.status = 'stored')
     or exists (select 1 from public.supplier_documents s where s.evidence_id = v_evidence) then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  insert into public.supplier_documents (id, legal_entity_id, branch_id, deal_id, task_id, supplier_id, kind, number,
    doc_date, total_paise, gst_included, evidence_id, uploaded_by, request_id)
  values (v_id, v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, v_supplier, v_kind, v_number,
    v_date, v_total, (p_fields ->> 'gstIncluded')::boolean, v_evidence, (select auth.uid()), p_request_id);
  perform authz.write_audit('purchase.supplier_document_uploaded', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null, jsonb_build_object('documentId', v_id, 'kind', v_kind));
  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'status', 'uploaded', 'rowVersion', 1);
  return authz.sm_remember(v_task.legal_entity_id, p_request_id, 'supplier_document_upload', v_payload, v_result);
end;
$$;

create function public.supplier_document_review(
  p_document_id uuid, p_decision text, p_reason text, p_expected_row_version integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v public.supplier_documents%rowtype;
  v_synthetic boolean;
  v_reason text;
  v_payload jsonb := jsonb_build_object('documentId', p_document_id, 'decision', p_decision, 'reason', p_reason,
    'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  select * into v from public.supplier_documents s where s.id = p_document_id;
  if v.id is null then
    if coalesce(authz.session_ok(), false) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = v.deal_id;
  perform authz.finance_require_accounts(v.legal_entity_id, v_synthetic);
  select * into v from public.supplier_documents s where s.id = p_document_id for update;
  v_result := authz.sm_replay(v.legal_entity_id, p_request_id, 'supplier_document_review', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_decision is null or p_decision not in ('accept', 'return') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if v.uploaded_by = v_uid then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if v.status <> 'uploaded' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_row_version is distinct from v.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if p_decision = 'accept' then
    update public.supplier_documents s
    set status = 'accepted', reviewed_by = v_uid, reviewed_at = now(), row_version = s.row_version + 1, updated_at = now()
    where s.id = v.id returning * into v;
  else
    v_reason := authz.finance_reason(p_reason);
    update public.supplier_documents s
    set status = 'returned', return_reason = v_reason, reviewed_by = v_uid, reviewed_at = now(),
        row_version = s.row_version + 1, updated_at = now()
    where s.id = v.id returning * into v;
  end if;
  perform authz.write_audit(case when p_decision = 'accept' then 'finance.supplier_document_accepted'
                                 else 'finance.supplier_document_returned' end,
    v.legal_entity_id, v.branch_id, 'fulfilment_task', v.task_id, null,
    jsonb_build_object('documentId', v.id, 'kind', v.kind));
  v_result := jsonb_build_object('outcome', 'created', 'id', v.id, 'status', v.status, 'rowVersion', v.row_version);
  return authz.sm_remember(v.legal_entity_id, p_request_id, 'supplier_document_review', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 10. Grants
-- ===========================================================================

revoke all on function
  public.supplier_money_evidence_begin(text, uuid, text, text, integer, text, uuid),
  public.supplier_money_evidence_finish(uuid, boolean),
  public.supplier_money_evidence_authorize_download(uuid),
  public.supplier_payment_request_create(uuid, jsonb, uuid),
  public.supplier_payment_request_resubmit(uuid, jsonb, uuid),
  public.supplier_payment_request_cancel(uuid, integer, uuid),
  public.supplier_payment_decide(uuid, text, text, integer, uuid),
  public.supplier_payment_record(uuid, date, text, text, uuid, integer, uuid),
  public.supplier_payment_verify(uuid, integer, uuid),
  public.company_funding_decide(uuid, text, text, integer, uuid),
  public.company_funding_mark_recovered(uuid, text, integer, uuid),
  public.supplier_document_upload(uuid, jsonb, uuid),
  public.supplier_document_review(uuid, text, text, integer, uuid)
from public, anon, authenticated, service_role;

grant execute on function
  public.supplier_money_evidence_begin(text, uuid, text, text, integer, text, uuid),
  public.supplier_money_evidence_finish(uuid, boolean),
  public.supplier_money_evidence_authorize_download(uuid),
  public.supplier_payment_request_create(uuid, jsonb, uuid),
  public.supplier_payment_request_resubmit(uuid, jsonb, uuid),
  public.supplier_payment_request_cancel(uuid, integer, uuid),
  public.supplier_payment_decide(uuid, text, text, integer, uuid),
  public.supplier_payment_record(uuid, date, text, text, uuid, integer, uuid),
  public.supplier_payment_verify(uuid, integer, uuid),
  public.company_funding_decide(uuid, text, text, integer, uuid),
  public.company_funding_mark_recovered(uuid, text, integer, uuid),
  public.supplier_document_upload(uuid, jsonb, uuid),
  public.supplier_document_review(uuid, text, text, integer, uuid)
to authenticated;

-- ===========================================================================
-- 11. Storage: private bucket (no storage.objects policies)
-- ===========================================================================

do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('supplier-money', 'supplier-money', false, 4194304,
      array['application/pdf', 'image/jpeg', 'image/png', 'image/webp'])
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;
end;
$$;

commit;
