-- TripNavigate CRM - B1.1b: advance claims (Sales-reported payments).
--
-- Contract: docs/implementation/frontend-first-plan-2026-10-10/b1.1/
--   b1.1-contract-2026-10-11.md (frozen 11 Oct 2026, DEC-29, DEC-30) and
--   b1.1-freeze-note.md section 3.2 with appendix B (freeze/appendix-b-claims-0200.md).
-- Created with the pinned CLI (npx supabase@2.119.0 migration new), then
-- ordered after 20261119000100 (Atlas) and before 20261119000300. Forward-only.
--
-- A claim is what Sales says the customer paid. It is NEVER money:
--   * no existing money read changes: finance_money_json, finance_queue_item_json,
--     accounts_queue, finance_cash_branch_json, finance_unresolved_json,
--     accounts_cash_overview, finance_post, the journal and my_work_counts are
--     untouched; none of them reads customer_payment_claims;
--   * customer_receipts is unchanged (no column, guard untouched). The link
--     lives on the claim (linked_receipt_id unique);
--   * Accounts records the real receipt from a claim through the existing
--     public.receipt_record in the same transaction (every receipt rule
--     applies unchanged: cash caps, cheque clearance, destination, maximum
--     receipt, removed Deal, duplicate reference), or links a receipt already
--     recorded. A different Accounts person verifies the receipt through the
--     unchanged receipt_verify. Only then does money exist (journal).
--
-- What changes:
--   * table customer_payment_claims (finance-table convention: RLS on, one
--     RESTRICTIVE session policy, no permissive policy, no table privilege);
--   * commands payment_claim_report, payment_claim_withdraw (Sales: booking
--     editors with commercial access), receipt_record_from_claim,
--     payment_claim_link_receipt, payment_claim_mark_not_received (Accounts);
--   * reads deal_payment_claims (Sales projection, status derived from the
--     linked receipt), accounts_payment_claims (paged Accounts list) and an
--     additive accounts_deal_detail replacement (claims, payment plan review
--     keys of DEC-29, contact, billing prefill source);
--   * helper authz.finance_claims_to_process_count() for Home (called by
--     Atlas's my_work_counts in 20261119000500).
--
-- Error contract (the message is exactly the token):
--   42501 not_authorized, not_self_approval | 55000 environment_unset,
--   not_configured, deal_removed, deal_not_active, service_items_disabled,
--   wrong_state, claim_over_total, destination_changed (and every receipt_record
--   refusal: mode_not_live, cash_cap_exceeded with DETAIL) | 22023 invalid_input |
--   23505 duplicate_claim, receipt_already_linked, duplicate_reference |
--   40001 request_conflict, version_changed | P0002 not_found.
--
-- Lock order (extends 20261101000100, never reversed): policy head FOR SHARE
-- (only when a receipt is recorded) -> finance_deal_heads FOR UPDATE ->
-- receipt rows FOR UPDATE -> claim row FOR UPDATE -> (inside receipt_record:
-- destination FOR SHARE, cash advisory keys, receipt counter). Every claim
-- command takes the Deal head first, so claim commands on one Deal are
-- serialised; the partial unique indexes are the race backstops.
--
-- Rollback (forward-only): service_items_enabled off stops new claims; an
-- emergency rollback is a new migration revoking execute on the five commands
-- and two claim reads from authenticated. Claims and audit rows are never deleted.

begin;
set local lock_timeout = '15s';

-- ---------------------------------------------------------------------------
-- 1. Table
-- ---------------------------------------------------------------------------

create table public.customer_payment_claims (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null,
  deal_id uuid not null,
  -- The draft or accepted version current at report time (resolved by the server).
  booking_version_id uuid not null,
  mode text not null check (mode in ('bank_transfer', 'upi', 'cash', 'cheque')),
  amount_paise bigint not null check (amount_paise >= 1),
  currency char(3) not null default 'INR' check (currency = 'INR'),
  paid_on date not null,
  payer_name text not null check (length(payer_name) between 1 and 200),
  reference text check (reference ~ '^[A-Za-z0-9/-]{6,40}$'),
  reference_norm text,
  cheque_number text check (cheque_number ~ '^[0-9]{6}$'),
  cheque_date date,
  destination_version_id uuid,
  note text check (note is null or length(note) between 1 and 500),
  status text not null default 'reported' check (status in ('reported', 'linked', 'not_received', 'withdrawn')),
  linked_receipt_id uuid unique,
  link_kind text check (link_kind in ('recorded_from_claim', 'linked_existing')),
  link_reason text check (link_reason is null or length(link_reason) between 10 and 500),
  linked_by uuid references public.staff_profiles (user_id),
  linked_at timestamptz,
  closed_reason text check (closed_reason is null or length(closed_reason) between 10 and 500),
  closed_by uuid references public.staff_profiles (user_id),
  closed_at timestamptz,
  reported_by uuid not null references public.staff_profiles (user_id),
  reported_at timestamptz not null default now(),
  request_id uuid not null,
  row_version integer not null default 1 check (row_version >= 1),
  updated_at timestamptz not null default now(),
  foreign key (legal_entity_id, deal_id) references public.deals (legal_entity_id, id),
  foreign key (legal_entity_id, deal_id, booking_version_id) references public.booking_versions (legal_entity_id, deal_id, id),
  foreign key (legal_entity_id, destination_version_id) references public.company_destination_versions (legal_entity_id, id),
  foreign key (legal_entity_id, linked_receipt_id) references public.customer_receipts (legal_entity_id, id),
  constraint customer_payment_claims_request_unique unique (legal_entity_id, request_id),
  check ((mode in ('bank_transfer', 'upi')) = (reference is not null)),
  check (reference_norm is not distinct from upper(replace(replace(reference, ' ', ''), '-', ''))),
  check ((mode in ('bank_transfer', 'upi')) = (destination_version_id is not null)),
  check ((mode = 'cheque') = (cheque_number is not null) and (mode = 'cheque') = (cheque_date is not null)),
  check ((status = 'linked') = (linked_receipt_id is not null)),
  check ((linked_receipt_id is null) = (link_kind is null) and (linked_receipt_id is null) = (linked_by is null)
         and (linked_receipt_id is null) = (linked_at is null)),
  check ((status in ('not_received', 'withdrawn')) = (closed_at is not null)),
  check ((closed_at is null) = (closed_by is null) and (closed_at is null) = (closed_reason is null)),
  -- Maker/checker backstops: the reporter never links or closes as "not received".
  check (linked_by is distinct from reported_by),
  check (status <> 'not_received' or closed_by <> reported_by)
);
comment on table public.customer_payment_claims is
  'B1.1b: payments Sales says the customer made. Never money: no journal entry, no money read. Accounts records or links the real receipt; a different Accounts person verifies it. No Data API access.';

create index customer_payment_claims_deal_idx on public.customer_payment_claims (deal_id, reported_at);
create index customer_payment_claims_version_idx on public.customer_payment_claims (booking_version_id);
create index customer_payment_claims_destination_idx on public.customer_payment_claims (destination_version_id)
  where destination_version_id is not null;
create index customer_payment_claims_entity_idx on public.customer_payment_claims (legal_entity_id, reported_at, id);
-- Accounts list ("to process") and the Home count, oldest first.
create index customer_payment_claims_reported_idx on public.customer_payment_claims (legal_entity_id, reported_at, id)
  where status = 'reported';
create index customer_payment_claims_reported_by_idx on public.customer_payment_claims (reported_by);
create index customer_payment_claims_linked_by_idx on public.customer_payment_claims (linked_by) where linked_by is not null;
create index customer_payment_claims_closed_by_idx on public.customer_payment_claims (closed_by) where closed_by is not null;
-- Contract 5: reference_norm unique among open claims per Deal (open = reported or linked).
create unique index customer_payment_claims_open_reference_unique on public.customer_payment_claims (deal_id, reference_norm)
  where status in ('reported', 'linked') and reference_norm is not null;
create unique index customer_payment_claims_open_cheque_unique on public.customer_payment_claims (deal_id, cheque_number)
  where status in ('reported', 'linked') and mode = 'cheque';

-- Facts immutable; reported -> linked | not_received | withdrawn only; a link
-- and a closure are permanent; never deleted.
create function authz.customer_payment_claims_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_mutable text[] := array['status', 'linked_receipt_id', 'link_kind', 'link_reason', 'linked_by', 'linked_at',
    'closed_reason', 'closed_by', 'closed_at', 'row_version', 'updated_at'];
begin
  if tg_op = 'DELETE' then
    raise exception 'payment claims cannot be deleted' using errcode = '42501';
  end if;
  if (to_jsonb(new) - v_mutable) is distinct from (to_jsonb(old) - v_mutable) then
    raise exception 'payment claim facts are immutable' using errcode = '42501';
  end if;
  if old.status <> 'reported' and (to_jsonb(new) - array['row_version', 'updated_at'])
       is distinct from (to_jsonb(old) - array['row_version', 'updated_at']) then
    raise exception 'a handled payment claim is permanent' using errcode = '42501';
  end if;
  if new.status is distinct from old.status
     and not (old.status = 'reported' and new.status in ('linked', 'not_received', 'withdrawn')) then
    raise exception 'payment claim status % cannot become %', old.status, new.status using errcode = '42501';
  end if;
  return new;
end;
$$;
create trigger customer_payment_claims_a_guard before update or delete on public.customer_payment_claims
  for each row execute function authz.customer_payment_claims_guard();

-- ---------------------------------------------------------------------------
-- 2. Helpers (all named finance_claim* so the finance helper grant test covers them)
-- ---------------------------------------------------------------------------

-- Request id of the receipt recorded from a claim: derived, so the outer
-- command and the inner receipt_record each keep their own stored result.
create function authz.finance_claim_receipt_request(p_request uuid) returns uuid
language sql immutable set search_path = '' as $$
  select md5('claim-receipt:' || p_request::text)::uuid
$$;

-- Normalised bank/UPI reference (receipt rule).
create function authz.finance_claim_norm(p_reference text) returns text
language sql immutable set search_path = '' as $$
  select case when p_reference is null then null
    else upper(replace(replace(btrim(p_reference, E' \t\r\n'), ' ', ''), '-', '')) end
$$;

-- Sales side of claims: booking editors who may see the selling total.
create function authz.finance_claim_sales_ok(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.can_edit_booking_draft(p_deal) and authz.can_read_deal_commercial(p_deal), false)
$$;

-- The version a new claim attaches to: the open draft, else the accepted one.
create function authz.finance_claim_version(p_deal uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  select v.id from public.booking_versions v
  where v.deal_id = p_deal and v.status in ('draft', 'confirmed')
  order by (v.status = 'draft') desc, v.version_no desc
  limit 1
$$;

-- End of a receipt's correction chain (bounded).
create function authz.finance_claim_effective_receipt(p_receipt uuid) returns uuid
language sql stable security definer set search_path = '' as $$
  with recursive c (id, depth) as (
    select p_receipt, 0
    union all
    select r.corrected_by_receipt_id, c.depth + 1
    from c join public.customer_receipts r on r.id = c.id
    where r.corrected_by_receipt_id is not null and c.depth < 20
  )
  select c.id from c where p_receipt is not null order by c.depth desc limit 1
$$;

-- True when the receipt or any receipt it corrects already backs a claim.
create function authz.finance_claim_chain_linked(p_receipt uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  with recursive a (id, depth) as (
    select p_receipt, 0
    union all
    select r.corrects_receipt_id, a.depth + 1
    from a join public.customer_receipts r on r.id = a.id
    where r.corrects_receipt_id is not null and a.depth < 20
  )
  select exists (select 1 from public.customer_payment_claims c join a on c.linked_receipt_id = a.id)
$$;

-- Display status: the claim's own state, or the linked receipt's (via its correction chain).
create function authz.finance_claim_display_status(p_claim uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when c.status <> 'linked' then c.status
    else (select case r.status
            when 'recorded' then 'recorded'
            when 'verified' then 'verified'
            when 'pending_clearance' then 'pending_clearance'
            when 'cleared' then 'cleared'
            when 'rejected' then 'rejected'
            when 'reversed' then 'reversed'
            else 'bounced' end      -- bounced, stopped, cancelled: cheque not paid
          from public.customer_receipts r
          where r.id = authz.finance_claim_effective_receipt(c.linked_receipt_id))
  end
  from public.customer_payment_claims c where c.id = p_claim
$$;

-- What this Accounts viewer may do with a claim (null = allowed). Commands
-- raise from the same decisions.
create function authz.finance_claim_actions(p_claim uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c public.customer_payment_claims%rowtype;
  v_common text;
begin
  select * into c from public.customer_payment_claims x where x.id = p_claim;
  if c.id is null then
    return null;
  end if;
  v_common := case
    when c.status <> 'reported' then 'wrong_state'
    when c.reported_by = (select auth.uid()) then 'own_record'
    when authz.finance_deal_conflict(c.deal_id) then 'deal_conflict'
    else null end;
  return jsonb_build_object(
    'recordReceipt', coalesce(v_common, case
      when exists (select 1 from public.deals d where d.id = c.deal_id and d.removed_at is not null) then 'deal_removed'
      when not authz.finance_mode_allowed(c.legal_entity_id, c.mode) then 'mode_not_live'
      else null end),
    'linkReceipt', v_common,
    'markNotReceived', v_common);
end;
$$;

-- Raises the refusal of a claim action block (own_record/deal_conflict ->
-- not_self_approval; anything else -> wrong_state).
create function authz.finance_claim_raise_block(p_block text) returns void
language plpgsql volatile set search_path = '' as $$
begin
  if p_block is null then
    return;
  elsif p_block in ('own_record', 'deal_conflict') then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  raise exception 'wrong_state' using errcode = '55000';
end;
$$;

-- Claim for an Accounts command: permission and gate on the claim's entity
-- and Deal (a missing claim looks like finance_receipt_for_command). No lock.
create function authz.finance_claim_for_command(p_claim uuid) returns public.customer_payment_claims
language plpgsql stable security definer set search_path = '' as $$
declare
  c public.customer_payment_claims%rowtype;
  v_synthetic boolean;
begin
  select * into c from public.customer_payment_claims x where x.id = p_claim;
  if c.id is null then
    if coalesce(authz.session_ok(), false) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select d.is_synthetic into v_synthetic from public.deals d where d.id = c.deal_id;
  perform authz.finance_require_accounts(c.legal_entity_id, v_synthetic);
  return c;
end;
$$;

-- True when the receipt facts differ from what the claim says.
create function authz.finance_claim_mismatch(
  p_claim uuid, p_mode text, p_amount text, p_reference text, p_cheque_number text
) returns boolean
language sql stable security definer set search_path = '' as $$
  select p_mode is distinct from c.mode
    or p_amount is distinct from c.amount_paise::text
    or (c.mode in ('bank_transfer', 'upi') and authz.finance_claim_norm(p_reference) is distinct from c.reference_norm)
    or (c.mode = 'cheque' and btrim(coalesce(p_cheque_number, '')) is distinct from c.cheque_number)
  from public.customer_payment_claims c where c.id = p_claim
$$;

-- Masked destination of a claim (label, kind, bank, last four).
create function authz.finance_claim_destination_json(p_version uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'label', d.label,
    'kind', d.kind,
    'versionNo', v.version_no,
    'bankName', v.bank_name,
    'accountMasked', authz.destination_mask_account(v.account_number),
    'upiMasked', authz.destination_mask_upi(v.upi_id),
    'isCurrent', d.current_version_id is not distinct from v.id and d.retired_at is null)
  from public.company_destination_versions v
  join public.company_destinations d on d.id = v.destination_id
  where v.id = p_version
$$;

-- Sales view of one claim: no receipt number, payer identifiers, MICR,
-- account numbers, evidence, Accounts names or receipt reasons.
create function authz.finance_claim_sales_json(p_claim uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'claimId', c.id,
    'status', c.status,
    'displayStatus', authz.finance_claim_display_status(c.id),
    'amountPaise', c.amount_paise::text,
    'mode', c.mode,
    'reference', c.reference,
    'chequeNumber', c.cheque_number,
    'chequeDate', to_char(c.cheque_date, 'YYYY-MM-DD'),
    'paidOn', to_char(c.paid_on, 'YYYY-MM-DD'),
    'payerName', c.payer_name,
    'note', c.note,
    'destinationLabel', (select d.label from public.company_destination_versions v
                         join public.company_destinations d on d.id = v.destination_id
                         where v.id = c.destination_version_id),
    'receiptAmountPaise', (select r.amount_paise::text from public.customer_receipts r
                           where r.id = authz.finance_claim_effective_receipt(c.linked_receipt_id)),
    'notReceivedReason', case when c.status = 'not_received' then c.closed_reason end,
    'reportedByName', authz.finance_name(c.reported_by),
    'reportedAt', c.reported_at,
    'rowVersion', c.row_version,
    'canWithdraw', c.status = 'reported')
  from public.customer_payment_claims c where c.id = p_claim
$$;

-- Accounts view of one claim (accounts_deal_detail.claims).
create function authz.finance_claim_accounts_json(p_claim uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'claimId', c.id,
    'status', c.status,
    'displayStatus', authz.finance_claim_display_status(c.id),
    'amountPaise', c.amount_paise::text,
    'mode', c.mode,
    'reference', c.reference,
    'chequeNumber', c.cheque_number,
    'chequeDate', to_char(c.cheque_date, 'YYYY-MM-DD'),
    'paidOn', to_char(c.paid_on, 'YYYY-MM-DD'),
    'payerName', c.payer_name,
    'note', c.note,
    'destination', authz.finance_claim_destination_json(c.destination_version_id),
    'bookingVersionNo', (select v.version_no from public.booking_versions v where v.id = c.booking_version_id),
    'reportedByName', authz.finance_name(c.reported_by),
    'reportedAt', c.reported_at,
    'linkedReceiptId', c.linked_receipt_id,
    'linkedReceiptNo', (select r.receipt_no from public.customer_receipts r where r.id = c.linked_receipt_id),
    'linkKind', c.link_kind,
    'linkReason', c.link_reason,
    'linkedByName', authz.finance_name(c.linked_by),
    'linkedAt', c.linked_at,
    'closedReason', c.closed_reason,
    'closedByName', authz.finance_name(c.closed_by),
    'closedAt', c.closed_at,
    'rowVersion', c.row_version,
    -- Same-Deal receipts that could back this claim: end of chain, linkable,
    -- not backing a claim, matching reference, cheque number or amount.
    'possibleReceiptIds', case when c.status <> 'reported' then '[]'::jsonb else coalesce((
      select jsonb_agg(r.id order by r.recorded_at, r.id)
      from public.customer_receipts r
      where r.deal_id = c.deal_id and r.corrected_by_receipt_id is null
        and r.status in ('recorded', 'verified', 'pending_clearance', 'cleared', 'bounced')
        and not authz.finance_claim_chain_linked(r.id)
        and ((c.reference_norm is not null and r.reference_norm = c.reference_norm)
             or (c.cheque_number is not null and r.cheque_number = c.cheque_number)
             or r.amount_paise = c.amount_paise)), '[]'::jsonb) end,
    'actions', authz.finance_claim_actions(c.id))
  from public.customer_payment_claims c where c.id = p_claim
$$;

-- One row of the Accounts claims list.
create function authz.finance_claim_list_item_json(p_claim uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'claimId', c.id,
    'dealId', d.id,
    'dealReference', d.reference,
    'dealTitle', d.title,
    'branchName', b.name,
    'amountPaise', c.amount_paise::text,
    'mode', c.mode,
    'paidOn', to_char(c.paid_on, 'YYYY-MM-DD'),
    'payerName', c.payer_name,
    'reference', c.reference,
    'chequeNumber', c.cheque_number,
    'status', c.status,
    'displayStatus', authz.finance_claim_display_status(c.id),
    'reportedByName', authz.finance_name(c.reported_by),
    'reportedAt', c.reported_at,
    'linkedReceiptNo', (select r.receipt_no from public.customer_receipts r where r.id = c.linked_receipt_id))
  from public.customer_payment_claims c
  join public.deals d on d.id = c.deal_id
  join public.branches b on b.id = d.branch_id
  where c.id = p_claim
$$;

-- Home count (freeze note 3.1: called by my_work_counts from 20261119000500):
-- null unless the caller holds an active Accounts role (not with Purchase);
-- else the reported claims over the accounts_queue gate, which equals
-- accounts_payment_claims('reported').totalCount.
create function authz.finance_claims_to_process_count() returns integer
language plpgsql stable security definer set search_path = '' as $$
declare
  v_n integer;
begin
  if not coalesce(authz.session_ok(), false) or not exists (
       select 1 from public.memberships m
       where m.user_id = (select auth.uid()) and m.status = 'active' and m.role_code = 'accounts'
         and authz.holds_active_role('accounts', m.legal_entity_id) and not authz.holds_role('purchase', m.legal_entity_id)) then
    return null;
  end if;
  with gate as materialized (
    select e.id as legal_entity_id, s.is_synthetic
    from public.legal_entities e
    cross join (values (true), (false)) as s(is_synthetic)
    where authz.can_accounts(e.id)
      and authz.finance_gate_issue(e.id, s.is_synthetic) is null
  )
  select count(*) into v_n
  from public.customer_payment_claims c
  join public.deals d on d.id = c.deal_id
  join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
  where c.status = 'reported';
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Sales commands
-- ---------------------------------------------------------------------------

create function public.payment_claim_report(p_deal_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id, 'fields', p_fields);
  v_result jsonb;
  v_issue text;
  v_today date := authz.finance_today();
  v_policy public.finance_policy_versions%rowtype;
  v_mode text;
  v_amount_text text;
  v_amount bigint;
  v_paid date;
  v_payer text;
  v_reference text;
  v_norm text;
  v_cheque_no text;
  v_cheque_date date;
  v_dest_version uuid;
  v_dv public.company_destination_versions%rowtype;
  v_dest public.company_destinations%rowtype;
  v_note text;
  v_version uuid;
  v_total bigint;
  v_id uuid := gen_random_uuid();
  v_constraint text;
begin
  perform authz.refuse_removed_deal(p_deal_id);
  if p_deal_id is null or not authz.finance_claim_sales_ok(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  v_issue := authz.finance_gate_issue(v_deal.legal_entity_id, v_deal.is_synthetic);
  if v_issue is not null then
    raise exception '%', v_issue using errcode = '55000';
  end if;
  if not authz.service_items_enabled() then
    raise exception 'service_items_disabled' using errcode = '55000';
  end if;
  if authz.deal_not_active(v_deal.id) then
    raise exception 'deal_not_active' using errcode = '55000';
  end if;
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  perform authz.finance_lock_deal(v_deal.id);
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'payment_claim_report', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['mode', 'amountPaise', 'paidOn', 'payerName', 'reference', 'chequeNumber', 'chequeDate',
                          'destinationVersionId', 'note']) <> '{}'::jsonb then
    perform authz.finance_invalid();
  end if;
  v_mode := authz.finance_field(p_fields, 'mode');
  if v_mode is null or v_mode not in ('bank_transfer', 'upi', 'cash', 'cheque') then
    perform authz.finance_invalid();
  end if;
  v_policy := authz.finance_policy_at(v_deal.legal_entity_id, now());
  if v_policy.id is null then
    raise exception 'not_configured' using errcode = '55000';
  end if;
  v_amount_text := authz.finance_field(p_fields, 'amountPaise');
  if v_amount_text is null or v_amount_text !~ '^[1-9][0-9]{0,17}$' then
    perform authz.finance_invalid();
  end if;
  v_amount := v_amount_text::bigint;
  -- A claim no receipt could ever hold is refused.
  if v_amount > v_policy.receipt_max_paise then
    perform authz.finance_invalid();
  end if;
  v_paid := authz.finance_date(authz.finance_field(p_fields, 'paidOn'));
  if v_paid is null or v_paid not between v_today - 365 and v_today then
    perform authz.finance_invalid();
  end if;
  v_payer := authz.finance_text(authz.finance_field(p_fields, 'payerName'), 1, 200, false);
  if v_payer is null then
    perform authz.finance_invalid();
  end if;

  v_reference := authz.finance_text(authz.finance_field(p_fields, 'reference'), 1, 40, false);
  v_dest_version := authz.finance_uuid(authz.finance_field(p_fields, 'destinationVersionId'));
  if v_mode in ('bank_transfer', 'upi') then
    if v_reference is null or v_reference !~ '^[A-Za-z0-9/-]{6,40}$' or v_dest_version is null then
      perform authz.finance_invalid();
    end if;
    v_norm := authz.finance_claim_norm(v_reference);
  elsif v_reference is not null or v_dest_version is not null then
    perform authz.finance_invalid();
  end if;

  v_cheque_no := authz.finance_text(authz.finance_field(p_fields, 'chequeNumber'), 1, 6, false);
  v_cheque_date := authz.finance_date(authz.finance_field(p_fields, 'chequeDate'));
  if v_mode = 'cheque' then
    if v_cheque_no is null or v_cheque_no !~ '^[0-9]{6}$'
       or v_cheque_date is null or v_cheque_date not between v_today - 90 and v_today + 90 then
      perform authz.finance_invalid();
    end if;
  elsif v_cheque_no is not null or v_cheque_date is not null then
    perform authz.finance_invalid();
  end if;
  v_note := authz.finance_text(authz.finance_field(p_fields, 'note'), 1, 500, true);

  -- Company destination: the receipt rule (approved current, not retired, same
  -- entity, kind matching the mode, same synthetic flag), read under a share lock.
  if v_mode in ('bank_transfer', 'upi') then
    select * into v_dv from public.company_destination_versions dv
    where dv.id = v_dest_version and dv.legal_entity_id = v_deal.legal_entity_id;
    if v_dv.id is not null then
      select * into v_dest from public.company_destinations d where d.id = v_dv.destination_id for share;
    end if;
    if v_dv.id is null or v_dest.retired_at is not null or v_dest.current_version_id is distinct from v_dv.id
       or v_dv.status <> 'approved'
       or v_dest.kind <> (case v_mode when 'bank_transfer' then 'bank' else 'upi' end)
       or v_dest.is_synthetic is distinct from v_deal.is_synthetic then
      raise exception 'destination_changed' using errcode = '55000';
    end if;
  end if;

  v_version := authz.finance_claim_version(v_deal.id);
  if v_version is null then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  select c.selling_total_paise into v_total from public.booking_version_commercials c where c.version_id = v_version;
  if v_total is not null and v_amount > v_total then
    raise exception 'claim_over_total' using errcode = '55000';
  end if;

  if exists (
       select 1 from public.customer_payment_claims c
       where c.deal_id = v_deal.id and c.status in ('reported', 'linked')
         and ((v_norm is not null and c.reference_norm = v_norm)
              or (v_mode = 'cheque' and c.mode = 'cheque' and c.cheque_number = v_cheque_no))) then
    raise exception 'duplicate_claim' using errcode = '23505';
  end if;

  begin
    insert into public.customer_payment_claims (id, legal_entity_id, deal_id, booking_version_id, mode, amount_paise,
      paid_on, payer_name, reference, reference_norm, cheque_number, cheque_date, destination_version_id, note,
      reported_by, request_id)
    values (v_id, v_deal.legal_entity_id, v_deal.id, v_version, v_mode, v_amount,
      v_paid, v_payer, v_reference, v_norm, v_cheque_no, v_cheque_date, v_dv.id, v_note,
      (select auth.uid()), p_request_id);
  exception
    when unique_violation then
      get stacked diagnostics v_constraint = constraint_name;
      if v_constraint = 'customer_payment_claims_request_unique' then
        raise exception 'request_conflict' using errcode = '40001';
      end if;
      raise exception 'duplicate_claim' using errcode = '23505';
    when check_violation or not_null_violation or foreign_key_violation then
      raise exception 'invalid_input' using errcode = '22023';
  end;

  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'status', 'reported', 'rowVersion', 1);
  perform authz.finance_remember(v_deal.legal_entity_id, p_request_id, 'payment_claim_report', v_payload, v_result);
  perform authz.write_audit('finance.claim_reported', v_deal.legal_entity_id, v_deal.branch_id, 'payment_claim', v_id, null,
    jsonb_build_object('dealId', v_deal.id, 'bookingVersionId', v_version, 'mode', v_mode));
  return v_result;
end;
$$;

create function public.payment_claim_withdraw(
  p_claim_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.customer_payment_claims%rowtype;
  v_deal public.deals%rowtype;
  v_payload jsonb := jsonb_build_object('claimId', p_claim_id, 'expectedRowVersion', p_expected_row_version, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  select * into c from public.customer_payment_claims x where x.id = p_claim_id;
  if c.id is null then
    if coalesce(authz.session_ok(), false) then
      raise exception 'not_found' using errcode = 'P0002';
    end if;
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.refuse_removed_deal(c.deal_id);
  if not authz.finance_claim_sales_ok(c.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null or p_expected_row_version is null then
    perform authz.finance_invalid();
  end if;
  v_deal := authz.finance_lock_deal(c.deal_id);
  v_result := authz.finance_replay(c.legal_entity_id, p_request_id, 'payment_claim_withdraw', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  select * into c from public.customer_payment_claims x where x.id = p_claim_id for update;
  if c.row_version <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if c.status <> 'reported' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  v_reason := authz.finance_reason(p_reason);

  update public.customer_payment_claims x
  set status = 'withdrawn', closed_reason = v_reason, closed_by = (select auth.uid()), closed_at = now(),
      row_version = x.row_version + 1, updated_at = now()
  where x.id = c.id
  returning * into c;

  v_result := jsonb_build_object('outcome', 'updated', 'id', c.id, 'status', 'withdrawn', 'rowVersion', c.row_version);
  perform authz.finance_remember(c.legal_entity_id, p_request_id, 'payment_claim_withdraw', v_payload, v_result);
  perform authz.write_audit('finance.claim_withdrawn', c.legal_entity_id, v_deal.branch_id, 'payment_claim', c.id, v_reason,
    jsonb_build_object('dealId', c.deal_id));
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Accounts commands
-- ---------------------------------------------------------------------------

create function public.receipt_record_from_claim(p_claim_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.customer_payment_claims%rowtype;
  v_deal public.deals%rowtype;
  v_payload jsonb := jsonb_build_object('claimId', p_claim_id, 'fields', p_fields);
  v_result jsonb;
  v_receipt jsonb;
  v_reason text;
  v_mismatch boolean;
begin
  c := authz.finance_claim_for_command(p_claim_id);
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  perform authz.finance_lock_policy(c.legal_entity_id, false);   -- lock 1
  v_deal := authz.finance_lock_deal(c.deal_id);                  -- lock 2
  v_result := authz.finance_replay(c.legal_entity_id, p_request_id, 'receipt_record_from_claim', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  select * into c from public.customer_payment_claims x where x.id = p_claim_id for update;
  perform authz.finance_claim_raise_block(case
    when c.status <> 'reported' then 'wrong_state'
    when c.reported_by = (select auth.uid()) then 'own_record'
    when authz.finance_deal_conflict(c.deal_id) then 'deal_conflict'
    else null end);

  -- The receipt form (prefilled from the claim), without corrections, plus an
  -- optional mismatch reason. receipt_record checks every other key.
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields ? 'correctsReceiptId' and jsonb_typeof(p_fields -> 'correctsReceiptId') <> 'null') then
    perform authz.finance_invalid();
  end if;
  v_reason := authz.finance_text(authz.finance_field(p_fields, 'mismatchReason'), 10, 500, true);
  v_mismatch := authz.finance_claim_mismatch(c.id, authz.finance_field(p_fields, 'mode'),
    authz.finance_field(p_fields, 'amountPaise'), authz.finance_field(p_fields, 'reference'),
    authz.finance_field(p_fields, 'chequeNumber'));
  if v_mismatch and v_reason is null then
    perform authz.finance_invalid();
  end if;

  -- Every receipt rule applies unchanged; its refusals propagate as they are.
  v_receipt := public.receipt_record(c.deal_id, p_fields - 'mismatchReason' - 'correctsReceiptId',
    authz.finance_claim_receipt_request(p_request_id));

  begin
    update public.customer_payment_claims x
    set status = 'linked', linked_receipt_id = (v_receipt ->> 'id')::uuid, link_kind = 'recorded_from_claim',
        link_reason = v_reason, linked_by = (select auth.uid()), linked_at = now(),
        row_version = x.row_version + 1, updated_at = now()
    where x.id = c.id
    returning * into c;
  exception when unique_violation then
    raise exception 'receipt_already_linked' using errcode = '23505';
  end;

  v_result := jsonb_build_object('outcome', 'created', 'id', c.id, 'status', 'linked', 'rowVersion', c.row_version,
    'receiptId', v_receipt ->> 'id', 'receiptNo', v_receipt ->> 'receiptNo');
  perform authz.finance_remember(c.legal_entity_id, p_request_id, 'receipt_record_from_claim', v_payload, v_result);
  perform authz.write_audit('finance.claim_receipt_recorded', c.legal_entity_id, v_deal.branch_id, 'payment_claim', c.id,
    v_reason, jsonb_build_object('dealId', c.deal_id, 'receiptId', v_receipt ->> 'id',
      'receiptNo', v_receipt ->> 'receiptNo', 'mismatch', v_mismatch));
  return v_result;
end;
$$;

create function public.payment_claim_link_receipt(p_claim_id uuid, p_receipt_id uuid, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.customer_payment_claims%rowtype;
  r public.customer_receipts%rowtype;
  v_deal public.deals%rowtype;
  v_payload jsonb := jsonb_build_object('claimId', p_claim_id, 'receiptId', p_receipt_id, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
  v_mismatch boolean;
begin
  c := authz.finance_claim_for_command(p_claim_id);
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  v_deal := authz.finance_lock_deal(c.deal_id);                  -- lock 2
  v_result := authz.finance_replay(c.legal_entity_id, p_request_id, 'payment_claim_link_receipt', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  select * into r from public.customer_receipts x
  where x.id = p_receipt_id and x.deal_id = c.deal_id for update;   -- lock 3
  select * into c from public.customer_payment_claims x where x.id = p_claim_id for update;
  perform authz.finance_claim_raise_block(case
    when c.status <> 'reported' then 'wrong_state'
    when c.reported_by = (select auth.uid()) then 'own_record'
    when authz.finance_deal_conflict(c.deal_id) then 'deal_conflict'
    else null end);
  -- Another Deal's receipt and a missing one look the same.
  if r.id is null then
    perform authz.finance_invalid();
  end if;
  -- Link the end of a correction chain, in a state that can still be money.
  if r.corrected_by_receipt_id is not null
     or r.status not in ('recorded', 'verified', 'pending_clearance', 'cleared', 'bounced') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if authz.finance_claim_chain_linked(r.id) then
    raise exception 'receipt_already_linked' using errcode = '23505';
  end if;
  v_reason := authz.finance_text(p_reason, 10, 500, true);
  v_mismatch := authz.finance_claim_mismatch(c.id, r.mode, r.amount_paise::text, r.reference, r.cheque_number);
  if v_mismatch and v_reason is null then
    perform authz.finance_invalid();
  end if;

  begin
    update public.customer_payment_claims x
    set status = 'linked', linked_receipt_id = r.id, link_kind = 'linked_existing', link_reason = v_reason,
        linked_by = (select auth.uid()), linked_at = now(), row_version = x.row_version + 1, updated_at = now()
    where x.id = c.id
    returning * into c;
  exception when unique_violation then
    raise exception 'receipt_already_linked' using errcode = '23505';
  end;

  v_result := jsonb_build_object('outcome', 'updated', 'id', c.id, 'status', 'linked', 'rowVersion', c.row_version,
    'receiptId', r.id, 'receiptNo', r.receipt_no);
  perform authz.finance_remember(c.legal_entity_id, p_request_id, 'payment_claim_link_receipt', v_payload, v_result);
  perform authz.write_audit('finance.claim_linked', c.legal_entity_id, v_deal.branch_id, 'payment_claim', c.id, v_reason,
    jsonb_build_object('dealId', c.deal_id, 'receiptId', r.id, 'receiptNo', r.receipt_no, 'mismatch', v_mismatch));
  return v_result;
end;
$$;

create function public.payment_claim_mark_not_received(p_claim_id uuid, p_reason text, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  c public.customer_payment_claims%rowtype;
  v_deal public.deals%rowtype;
  v_payload jsonb := jsonb_build_object('claimId', p_claim_id, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  c := authz.finance_claim_for_command(p_claim_id);
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  v_deal := authz.finance_lock_deal(c.deal_id);
  v_result := authz.finance_replay(c.legal_entity_id, p_request_id, 'payment_claim_mark_not_received', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  select * into c from public.customer_payment_claims x where x.id = p_claim_id for update;
  perform authz.finance_claim_raise_block(case
    when c.status <> 'reported' then 'wrong_state'
    when c.reported_by = (select auth.uid()) then 'own_record'
    when authz.finance_deal_conflict(c.deal_id) then 'deal_conflict'
    else null end);
  v_reason := authz.finance_reason(p_reason);

  update public.customer_payment_claims x
  set status = 'not_received', closed_reason = v_reason, closed_by = (select auth.uid()), closed_at = now(),
      row_version = x.row_version + 1, updated_at = now()
  where x.id = c.id
  returning * into c;

  v_result := jsonb_build_object('outcome', 'updated', 'id', c.id, 'status', 'not_received', 'rowVersion', c.row_version);
  perform authz.finance_remember(c.legal_entity_id, p_request_id, 'payment_claim_mark_not_received', v_payload, v_result);
  perform authz.write_audit('finance.claim_not_received', c.legal_entity_id, v_deal.branch_id, 'payment_claim', c.id, v_reason,
    jsonb_build_object('dealId', c.deal_id));
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Reads
-- ---------------------------------------------------------------------------

-- Sales projection. Null when the caller may not see claims for this Deal
-- (Purchase, Flight, Visa desk, Accounts, Super Admin, other owners, removed
-- Deals); gate problems are reported in reportBlock, never raised.
-- confirmedPaise is the journal balance (finance_money_json), never a claim.
create function public.deal_payment_claims(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_version uuid;
  v_total bigint;
  v_confirmed bigint;
  v_block text;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_deal_id is null or not authz.finance_claim_sales_ok(p_deal_id) then
    return null;
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  v_version := authz.finance_claim_version(v_deal.id);
  select c.selling_total_paise into v_total from public.booking_version_commercials c where c.version_id = v_version;
  v_confirmed := (authz.finance_money_json(v_deal.id) ->> 'availablePaise')::bigint;
  v_block := case
    when authz.finance_gate_issue(v_deal.legal_entity_id, v_deal.is_synthetic) is not null then 'finance_not_ready'
    when not authz.service_items_enabled() then 'service_items_disabled'
    when authz.deal_not_active(v_deal.id) then 'deal_not_active'
    when v_version is null then 'no_booking'
    else null end;

  return jsonb_build_object(
    'dealId', v_deal.id,
    'sellingTotalPaise', v_total::text,
    'reportedPaise', (select coalesce(sum(c.amount_paise), 0)::text from public.customer_payment_claims c
                      where c.deal_id = v_deal.id and c.status in ('reported', 'linked')),
    'confirmedPaise', v_confirmed::text,
    'balancePaise', (v_total - v_confirmed)::text,
    'canReport', v_block is null,
    'reportBlock', v_block,
    'destinations', case when v_block is not null then '[]'::jsonb else coalesce((
      select jsonb_agg(jsonb_build_object(
          'versionId', v.id, 'kind', d.kind, 'label', d.label, 'bankName', v.bank_name,
          'accountMasked', authz.destination_mask_account(v.account_number),
          'upiMasked', authz.destination_mask_upi(v.upi_id))
        order by d.kind, lower(d.label), d.id)
      from public.company_destinations d
      join public.company_destination_versions v on v.id = d.current_version_id
      where d.legal_entity_id = v_deal.legal_entity_id and d.retired_at is null and v.status = 'approved'
        and d.is_synthetic = v_deal.is_synthetic), '[]'::jsonb) end,
    'claims', coalesce((
      select jsonb_agg(authz.finance_claim_sales_json(c.id) order by c.reported_at desc, c.id)
      from public.customer_payment_claims c where c.deal_id = v_deal.id), '[]'::jsonb));
end;
$$;

-- Accounts claims list, paged like accounts_queue (20261117000100): the same
-- materialized gate; removed Deals included; oldest report first.
create function public.accounts_payment_claims(p_filter text, p_after text default null, p_limit integer default 50)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_after_id uuid;
  v_after_at timestamptz;
  v_result jsonb;
begin
  perform authz.finance_require_accounts_anywhere();
  if p_filter is null or p_filter not in ('reported', 'linked', 'closed', 'all') then
    perform authz.finance_invalid();
  end if;
  if p_after is not null then
    -- "<claimId>:<reportedAt, UTC, microseconds>" of the previous page's last item.
    if length(p_after) < 38 or substr(p_after, 37, 1) <> ':'
       or substr(p_after, 1, 36) !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or substr(p_after, 38) !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{6}Z$' then
      perform authz.finance_invalid();
    end if;
    v_after_id := substr(p_after, 1, 36)::uuid;
    begin
      v_after_at := substr(p_after, 38)::timestamptz;
    exception when others then
      perform authz.finance_invalid();
    end;
  end if;

  with gate as materialized (
    select e.id as legal_entity_id, s.is_synthetic
    from public.legal_entities e
    cross join (values (true), (false)) as s(is_synthetic)
    where authz.can_accounts(e.id)
      and authz.finance_gate_issue(e.id, s.is_synthetic) is null
  ), matched as (
    select c.id, c.reported_at
    from public.customer_payment_claims c
    join public.deals d on d.id = c.deal_id
    join gate g on g.legal_entity_id = d.legal_entity_id and g.is_synthetic = d.is_synthetic
    where case p_filter
      when 'all' then true
      when 'reported' then c.status = 'reported'
      when 'linked' then c.status = 'linked'
      else c.status in ('not_received', 'withdrawn')
    end
  ), page as (
    select m.id, m.reported_at, row_number() over (order by m.reported_at, m.id) as n
    from (select m.id, m.reported_at from matched m
          where v_after_id is null or (m.reported_at, m.id) > (v_after_at, v_after_id)
          order by m.reported_at, m.id
          limit v_limit + 1) m
  )
  select jsonb_build_object(
    'items', coalesce((select jsonb_agg(authz.finance_claim_list_item_json(p.id) order by p.n) from page p where p.n <= v_limit),
                      '[]'::jsonb),
    'hasMore', exists (select 1 from page p where p.n > v_limit),
    'nextAfter', case when exists (select 1 from page p where p.n > v_limit)
      then (select p.id::text || ':' || to_char(p.reported_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
            from page p where p.n = v_limit) end,
    'totalCount', (select count(*) from matched))
  into v_result;
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. accounts_deal_detail (replaces 20261101000100; signature, grants and every
--    existing key unchanged; additive keys only). 20261119000300 replaces it
--    from this text to add the revision keys (freeze note 3.1).
--    booking: serviceType, listPricePaise, discountPaise, paymentPlan (DEC-29:
--    Accounts reviews the plan with the booking), services, contact.
--    billing: prefillSource. New: claims, claimsReportedPaise (never money).
--    Identity data (traveller_identities) is never read here.
-- ---------------------------------------------------------------------------

create or replace function public.accounts_deal_detail(p_deal_id uuid) returns jsonb
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
        'sellingTotalPaise', c.selling_total_paise::text,
        'confirmedAt', v.confirmed_at,
        'confirmedByName', authz.finance_name(v.confirmed_by),
        'reviewStatus', coalesce(rv.status, 'pending'),
        'reviewRowVersion', coalesce(rv.row_version, 0),
        -- Kept in history; shown only while the review is returned.
        'returnReason', case when rv.status = 'returned' then rv.return_reason end,
        'reviewedByName', authz.finance_name(rv.reviewed_by),
        'reviewedAt', rv.reviewed_at,
        'canApprove', authz.finance_approve_block(v.id) is null,
        'approveBlock', authz.finance_approve_block(v.id),
        -- B1.1 (DEC-29): what Accounts reviews with the booking.
        'serviceType', v.service_type,
        'listPricePaise', c.list_price_paise::text,
        'discountPaise', c.discount_paise::text,
        'paymentPlan', (
          select jsonb_build_object(
            'instalments', jsonb_agg(jsonb_build_object(
                'seq', i.seq, 'label', i.label, 'amountPaise', i.amount_paise::text,
                'dueDate', to_char(i.due_date, 'YYYY-MM-DD'))
              order by i.seq),
            'totalPaise', sum(i.amount_paise)::text,
            'matchesSellingTotal', c.selling_total_paise is not null and sum(i.amount_paise) = c.selling_total_paise)
          from public.booking_version_instalments i
          where i.booking_version_id = v.id
          having count(*) > 0),
        'services', case when v.service_type = 'package' then coalesce((
          select jsonb_agg(jsonb_build_object('itemNo', s.item_no, 'serviceType', s.service_type) order by s.item_no)
          from public.service_items s
          where exists (select 1 from public.service_item_facts f
                        where f.service_item_id = s.id and f.booking_version_id = v.id)), '[]'::jsonb)
          else '[]'::jsonb end,
        'contact', (
          select jsonb_build_object(
            'name', k.contact_name, 'mobile', k.mobile, 'email', k.email, 'bookingFor', k.booking_for,
            'payerName', k.payer_name)
          from public.booking_version_contacts k where k.booking_version_id = v.id))
      from public.booking_versions v
      left join public.booking_version_commercials c on c.version_id = v.id
      left join public.accounts_booking_reviews rv on rv.booking_version_id = v.id
      where v.id = authz.current_accepted_version(v_deal.id)),
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
        'verifiedAt', bp.verified_at,
        'prefillSource', bp.prefill_source)
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
    'policy', authz.finance_policy_json(v_policy.id),
    -- B1.1b: Sales-reported payments, newest first. Never money.
    'claims', coalesce((
      select jsonb_agg(authz.finance_claim_accounts_json(x.id) order by x.reported_at desc, x.id)
      from public.customer_payment_claims x where x.deal_id = v_deal.id), '[]'::jsonb),
    'claimsReportedPaise', (select coalesce(sum(x.amount_paise), 0)::text from public.customer_payment_claims x
                            where x.deal_id = v_deal.id and x.status in ('reported', 'linked')));
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Row level security and grants (finance-table convention)
-- ---------------------------------------------------------------------------

alter table public.customer_payment_claims enable row level security;
-- Restrictive only: no permissive policy exists, so the Data API sees no rows.
create policy require_valid_session on public.customer_payment_claims as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.customer_payment_claims from public, anon, authenticated, service_role;

revoke all on function
  authz.customer_payment_claims_guard(), authz.finance_claim_receipt_request(uuid), authz.finance_claim_norm(text),
  authz.finance_claim_sales_ok(uuid), authz.finance_claim_version(uuid), authz.finance_claim_effective_receipt(uuid),
  authz.finance_claim_chain_linked(uuid), authz.finance_claim_display_status(uuid), authz.finance_claim_actions(uuid),
  authz.finance_claim_raise_block(text), authz.finance_claim_for_command(uuid),
  authz.finance_claim_mismatch(uuid, text, text, text, text), authz.finance_claim_destination_json(uuid),
  authz.finance_claim_sales_json(uuid), authz.finance_claim_accounts_json(uuid), authz.finance_claim_list_item_json(uuid),
  authz.finance_claims_to_process_count()
from public, anon, authenticated, service_role;

revoke all on function
  public.payment_claim_report(uuid, jsonb, uuid), public.payment_claim_withdraw(uuid, integer, text, uuid),
  public.receipt_record_from_claim(uuid, jsonb, uuid), public.payment_claim_link_receipt(uuid, uuid, text, uuid),
  public.payment_claim_mark_not_received(uuid, text, uuid), public.deal_payment_claims(uuid),
  public.accounts_payment_claims(text, text, integer)
from public, anon, authenticated, service_role;

grant execute on function
  public.payment_claim_report(uuid, jsonb, uuid), public.payment_claim_withdraw(uuid, integer, text, uuid),
  public.receipt_record_from_claim(uuid, jsonb, uuid), public.payment_claim_link_receipt(uuid, uuid, text, uuid),
  public.payment_claim_mark_not_received(uuid, text, uuid), public.deal_payment_claims(uuid),
  public.accounts_payment_claims(text, text, integer)
to authenticated;

commit;
