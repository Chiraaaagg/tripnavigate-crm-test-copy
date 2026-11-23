-- TripNavigate CRM - Accounts phase 3, track B (2 of 4): automatic bills.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 6.2, 6.3, 6.4,
-- 6.5 (document reads), 14 (bills fence unchanged), 17.1 (lock order), 17.3,
-- 21 LD11, LD12, LD13, LD14; plan 8.7 as changed by owner 17.1.
--
-- Bills are drafted, checked and (while automatic release is on) released by
-- the CRM inside the transaction of the event that caused them (LD11). They
-- are NEVER sent to the customer (LD12): nothing here queues a message.
--
-- Replaced (latest bodies re-confirmed with the sorted grep; changed lines
-- marked "Accounts phase 3 (20261205000210)"):
--   authz.cdoc_new_draft (20261204000210:398): one more argument p_auto_rule
--     (default null; every existing caller passes 7 arguments and gets null);
--     an automatic draft stores the rule and no person (created_by null).
--   public.customer_document_release (20261204000240:168): same signature,
--     refusals, audit and result; the body from "billing verified" to the end
--     moved into authz.cdoc_release_core(p_doc, p_released_by, p_rule,
--     p_request) so the automatic release runs exactly the manual path.
--   public.deal_customer_documents (20261204000230:114) and
--   public.customer_documents_list (20261204000240:339): rows add autoRule,
--     autoState, holdReasons, releasedByCrm; deal read adds autoBills {drafts,
--     release}; list filter adds autoState and preset 'toCheck' (held
--     automatic drafts, oldest first; boolean alias {toCheck: true}).
--
-- New (frozen signature, tracks G and H call it after applying a change):
--   authz.cdoc_auto_run(p_deal uuid, p_rule text) returns jsonb
--     1) drafts what is missing (Advance Invoice per verified receipt, the
--        Invoice of the approved basis, a replacement Invoice when a released
--        one no longer matches the basis (no settlement), a Credit Note per paid
--        payout / approved keep-credit or charge-only settlement); 2) refreshes
--        stale automatic drafts; 3) checks every automatic draft (the ten 6.3
--        checks -> ready | held with the codes); 4) releases ready drafts while
--        automatic release is on. finance_lock_deal first; inside an exception
--        block: it never fails the event that caused it - an error writes one
--        cdoc_auto_pending row (SQLSTATE only) for the sweep. With documents or
--        automatic bills Off it does nothing (Phase 2 behaves as before).
--     A draft discarded or a document cancelled by a person is not made again
--     for the same source (receipt, refund request) or the same basis and
--     total (Invoice, replacement): the CRM never fights Accounts.
--   Triggers (AFTER, same transaction, only while the switches are on):
--     customer_receipts status -> verified / cleared (adv_on_receipt) or away
--     from them (receipt_changed); accounts_booking_reviews.last_approved_at
--     set or moved (inv_on_approval); customer_refund_requests insert / status
--     (cn_on_refund, refund_changed); customer_billing_profiles status
--     (billing_changed); deal_cancellations insert / status
--     (cancellation_changed).
--   Timer task customer_documents_auto_sweep (every minute, <= 50 Deals:
--     pending rows first, then held / unchecked automatic drafts and ready ones
--     while release is on, oldest evaluated_at first, each at most every 5
--     minutes).
--
-- Audit (system audit, {by: 'crm', rule}; ids, kinds, codes, seq only):
--   accounts.customer_document.auto_drafted | refreshed | held (only when the
--   code set changes) | auto_released. The manual release keeps
--   accounts.customer_document.released.
--
-- Refusal tokens (manual release, unchanged): invalid_input, not_authorized,
-- not_found, documents_off, wrong_state, version_changed, billing_not_verified,
-- receipt_not_verified, company_identity_missing, document_stale,
-- number_conflict, request_conflict.
--
-- Rollback (forward-only): a NEW migration dropping the five triggers and the
-- timer task row, restoring customer_document_release (20261204000240),
-- deal_customer_documents (20261204000230), customer_documents_list
-- (20261204000240) and the 7-argument cdoc_new_draft (20261204000210).

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Helpers
-- ===========================================================================

-- Automatic drafts run while customer documents and automatic bills are both on.
create function authz.cdoc_auto_on(p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.customer_documents_enabled and s.auto_bills_enabled
                   from public.accounts_settings s where s.legal_entity_id = p_entity), false)
$$;

-- Automatic release (On by default, owner 17.1) has effect only while drafts are on.
create function authz.cdoc_auto_release_on(p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.customer_documents_enabled and s.auto_bills_enabled and s.auto_bill_release_enabled
                   from public.accounts_settings s where s.legal_entity_id = p_entity), false)
$$;

-- The number prefix of the Deal: fixed at its first release (counter rows), else the one it would get.
create function authz.cdoc_number_prefix(p_deal uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce((select k.prefix from public.customer_document_counters k
                   where k.deal_id = p_deal and k.prefix is not null order by k.kind limit 1),
                  authz.cdoc_prefix(p_deal))
$$;

-- The reference of another Deal of the entity already holding this prefix (null: none).
create function authz.cdoc_prefix_other_deal(p_deal uuid, p_entity uuid, p_prefix text) returns text
language sql stable security definer set search_path = '' as $$
  select d.reference
  from public.customer_document_counters k join public.deals d on d.id = k.deal_id
  where k.prefix = p_prefix and k.deal_id <> p_deal and d.legal_entity_id = p_entity
  limit 1
$$;

-- ===========================================================================
-- 2. cdoc_new_draft with the automatic rule (replaces 20261204000210:398)
-- ===========================================================================

drop function authz.cdoc_new_draft(public.deals, text, uuid, uuid, uuid, text, uuid);

-- A new draft (B1, B6 and the automatic run). Caller holds the finance head lock of the Deal.
create function authz.cdoc_new_draft(p_deal public.deals, p_kind text, p_receipt uuid, p_refund uuid, p_replaces uuid,
  p_replace_reason text, p_request uuid, p_auto_rule text default null)
returns public.customer_documents
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_old public.customer_documents%rowtype;
  v_receipt uuid := p_receipt;
  v_tally uuid;
  v_build jsonb;
  v_doc public.customer_documents%rowtype;
begin
  -- Accounts phase 3 (20261205000210): a rule, when given, must be a valid rule name.
  if p_auto_rule is not null and not authz.system_rule_ok(p_auto_rule) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'rule';
  end if;
  if p_replaces is not null then
    select * into v_old from public.customer_documents c where c.id = p_replaces for update;
    if v_old.id is null or v_old.deal_id <> p_deal.id then
      raise exception 'invalid_input' using errcode = '22023', hint = 'replacesDocumentId';
    end if;
    if v_old.kind <> p_kind or v_old.kind not in ('advance_invoice', 'invoice') or v_old.status <> 'released' then
      raise exception 'wrong_state' using errcode = '55000', hint = 'replacesDocumentId';
    end if;
    if exists (select 1 from public.customer_documents c where c.replaces_document_id = v_old.id and c.status in ('draft', 'released')) then
      raise exception 'already_recorded' using errcode = '55000';
    end if;
    v_receipt := v_old.receipt_id;
    -- A replacement prints the linked Tally number (LD18) while that reference is active.
    select g.id into v_tally from public.deal_tally_invoices g where g.id = v_old.tally_invoice_id and g.status = 'active';
  end if;
  if p_kind = 'advance_invoice' then
    if v_receipt is null or not exists (select 1 from public.customer_receipts r where r.id = v_receipt and r.deal_id = p_deal.id) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'receiptId';
    end if;
    if p_replaces is null and exists (select 1 from public.customer_documents c
               where c.receipt_id = v_receipt and c.kind = 'advance_invoice' and c.status in ('draft', 'released')) then
      raise exception 'already_recorded' using errcode = '55000';
    end if;
  elsif p_kind = 'invoice' then
    if exists (select 1 from public.customer_documents c where c.deal_id = p_deal.id and c.kind = 'invoice' and c.status = 'draft')
       or (p_replaces is null and exists (select 1 from public.customer_documents c
                                         where c.deal_id = p_deal.id and c.kind = 'invoice' and c.status = 'released')) then
      raise exception 'already_recorded' using errcode = '55000';
    end if;
  else
    if exists (select 1 from public.customer_documents c
               where c.refund_request_id = p_refund and c.kind = 'credit_note' and c.status in ('draft', 'released')) then
      raise exception 'already_recorded' using errcode = '55000';
    end if;
  end if;
  v_build := authz.cdoc_build(p_deal.id, p_kind, v_receipt, p_refund, p_replaces, v_tally);
  perform authz.cdoc_raise_issue(v_build);
  begin
    insert into public.customer_documents (legal_entity_id, branch_id, deal_id, kind, basis_version_id, receipt_id, refund_request_id,
      credits_document_id, replaces_document_id, tally_invoice_id, content, content_sha256, source_hash, total_paise, warnings,
      created_by, request_id, replace_reason, auto_rule)
    values (p_deal.legal_entity_id, p_deal.branch_id, p_deal.id, p_kind, nullif(v_build ->> 'basisVersionId', '')::uuid,
      case when p_kind = 'advance_invoice' then v_receipt end, case when p_kind = 'credit_note' then p_refund end,
      nullif(v_build ->> 'creditsDocumentId', '')::uuid, p_replaces, v_tally, v_build -> 'content',
      authz.finance_payload_hash(v_build -> 'content'), authz.cdoc_build_hash(v_build), (v_build ->> 'totalPaise')::bigint,
      array(select jsonb_array_elements_text(v_build -> 'warnings')),
      -- Accounts phase 3 (20261205000210): an automatic draft is made by the CRM, not by a person.
      case when p_auto_rule is null then (select auth.uid()) end, p_request, p_replace_reason, p_auto_rule)
    returning * into v_doc;
  exception when unique_violation then
    raise exception 'already_recorded' using errcode = '55000';
  end;
  return v_doc;
end;
$$;

-- ===========================================================================
-- 3. Release core (6.4) and the manual release command
-- ===========================================================================

-- The release from "billing verified" to the end (moved from
-- customer_document_release, 20261204000240:168). The caller holds the
-- finance head lock of the Deal and has checked the switch, the state, the
-- row version and the content hash. p_released_by = the person, or null with
-- p_rule (released by the CRM). Writes no audit row (callers do).
create function authz.cdoc_release_core(p_doc uuid, p_released_by uuid, p_rule text, p_request uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.customer_documents%rowtype;
  v_old public.customer_documents%rowtype;
  v_seq integer;
  v_number text;
  v_today date := authz.finance_today();
  v_content jsonb;
  v_job uuid;
  v_prefix text;
  v_other text;
  v_rule text := case when p_released_by is null then p_rule end;
begin
  if p_released_by is null and not authz.system_rule_ok(p_rule) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'rule';
  end if;
  if p_request is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into v from public.customer_documents c where c.id = p_doc for update;
  if v.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v.status <> 'draft' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if not exists (select 1 from public.customer_billing_profiles b where b.deal_id = v.deal_id and b.status = 'verified') then
    raise exception 'billing_not_verified' using errcode = '55000';
  end if;
  if v.kind = 'advance_invoice' and not exists (
       select 1 from public.customer_receipts r where r.id = v.receipt_id and r.status in ('verified', 'cleared')) then
    raise exception 'receipt_not_verified' using errcode = '55000';
  end if;
  -- L7 review 5: never release with the company GSTIN placeholder.
  if coalesce(v.content -> 'company' ->> 'gstin', '[') like '[%' then
    raise exception 'company_identity_missing' using errcode = '55000';
  end if;
  if authz.cdoc_source_hash(v.id) is distinct from v.source_hash then
    raise exception 'document_stale' using errcode = '40001';
  end if;
  if v.replaces_document_id is not null then
    select * into v_old from public.customer_documents c where c.id = v.replaces_document_id for update;
    if v_old.status <> 'released' then
      raise exception 'wrong_state' using errcode = '55000', hint = 'replacesDocumentId';
    end if;
  end if;

  -- Number (6.3, LD4; L7 review 7): the prefix is fixed at the Deal's first
  -- release and kept on its counter rows; another Deal of the entity holding
  -- the same prefix refuses number_conflict.
  v_prefix := authz.cdoc_number_prefix(v.deal_id);
  v_other := authz.cdoc_prefix_other_deal(v.deal_id, v.legal_entity_id, v_prefix);
  if v_other is not null then
    raise exception 'number_conflict' using errcode = '23505', hint = 'otherDealReference=' || v_other;
  end if;
  insert into public.customer_document_counters (deal_id, kind, prefix) values (v.deal_id, v.kind, v_prefix) on conflict do nothing;
  update public.customer_document_counters k set prefix = v_prefix where k.deal_id = v.deal_id and k.prefix is null;
  update public.customer_document_counters k set last_no = k.last_no + 1
  where k.deal_id = v.deal_id and k.kind = v.kind returning k.last_no into v_seq;
  v_number := v_prefix || '-' || authz.cdoc_code(v.kind) || '-' || v_seq::text;
  if exists (select 1 from public.customer_documents x where x.legal_entity_id = v.legal_entity_id and x.number = v_number) then
    raise exception 'number_conflict' using errcode = '23505', hint = 'otherDealReference=' ||
      coalesce((select d.reference from public.customer_documents x join public.deals d on d.id = x.deal_id
                where x.legal_entity_id = v.legal_entity_id and x.number = v_number), '');
  end if;
  v_content := v.content || jsonb_build_object('number', v_number, 'issueDate', to_char(v_today, 'YYYY-MM-DD'));

  update public.customer_documents c
  set status = 'released', number = v_number, seq = v_seq, content = v_content,
      content_sha256 = authz.finance_payload_hash(v_content), issue_date = v_today,
      released_by = p_released_by, release_rule = v_rule, released_at = now(), release_request_id = p_request,
      auto_state = null, hold_reasons = array[]::text[],
      row_version = c.row_version + 1, updated_at = now()
  where c.id = v.id returning * into v;

  if v_old.id is not null then
    update public.customer_documents c
    set status = 'replaced', ended_by = p_released_by, end_rule = v_rule, ended_at = now(),
        end_reason = coalesce(v.replace_reason, 'Replaced by ' || v.number), row_version = c.row_version + 1, updated_at = now()
    where c.id = v_old.id;
  end if;

  insert into public.customer_document_render_jobs (legal_entity_id, document_id, content_sha256, template_version, requested_by)
  values (v.legal_entity_id, v.id, v.content_sha256, 'cdoc-1', p_released_by)
  returning id into v_job;

  return jsonb_build_object('documentId', v.id, 'kind', v.kind, 'seq', v.seq, 'number', v.number,
    'issueDate', to_char(v.issue_date, 'YYYY-MM-DD'), 'renderJobId', v_job, 'replacedDocumentId', v_old.id,
    'replacesDocumentId', v.replaces_document_id, 'rowVersion', v.row_version);
end;
$$;

-- B3 release (same signature, refusals, audit and result as 20261204000240:168).
create or replace function public.customer_document_release(p_document_id uuid, p_expected_row_version integer, p_expected_content_sha256 text,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.customer_documents%rowtype;
  v_payload jsonb := jsonb_build_object('documentId', p_document_id, 'expectedRowVersion', p_expected_row_version,
    'expectedContentSha256', p_expected_content_sha256);
  v_result jsonb;
  v_core jsonb;
begin
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v := authz.cdoc_lock(p_document_id);
  v_result := authz.finance_replay(v.legal_entity_id, p_request_id, 'customer_document_release', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.cdoc_require_enabled(v.legal_entity_id);
  if v.status <> 'draft' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.cdoc_check_version(v, p_expected_row_version);
  if p_expected_content_sha256 is null or p_expected_content_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedContentSha256';
  end if;
  if v.content_sha256 <> p_expected_content_sha256 then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  -- Accounts phase 3 (20261205000210): the rest is the shared release core (also clears auto_state).
  v_core := authz.cdoc_release_core(v.id, (select auth.uid()), null, p_request_id);
  select * into v from public.customer_documents c where c.id = v.id;

  perform authz.write_audit('accounts.customer_document.released', v.legal_entity_id, v.branch_id, 'customer_document', v.id, null,
    jsonb_build_object('documentId', v.id, 'kind', v.kind, 'seq', v.seq, 'replacesDocumentId', v.replaces_document_id,
      'renderJobId', v_core ->> 'renderJobId', 'rowVersion', v.row_version));
  v_result := authz.cdoc_result('updated', v) || jsonb_build_object('seq', v.seq, 'issueDate', to_char(v.issue_date, 'YYYY-MM-DD'),
    'renderJobId', v_core ->> 'renderJobId', 'replacedDocumentId', v_core ->> 'replacedDocumentId');
  return authz.finance_remember(v.legal_entity_id, p_request_id, 'customer_document_release', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 4. Automatic checks (6.3)
-- ===========================================================================

-- The hold codes of one automatic draft, in the contract order. p_build is
-- authz.cdoc_build of the draft's own source (built once by the caller).
create function authz.cdoc_auto_codes(p_doc public.customer_documents, p_build jsonb) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v text[] := array[]::text[];
  v_rec public.customer_receipts%rowtype;
  v_source bigint;
  v_cn jsonb;
  v_issue boolean := p_build ->> 'issue' is not null;
  v_approved_no integer;
  v_prefix text;
begin
  if coalesce(p_doc.content -> 'company' ->> 'gstin', '[') like '[%' then
    v := v || 'company_identity_missing'::text;
  end if;
  if not exists (select 1 from public.customer_billing_profiles b where b.deal_id = p_doc.deal_id and b.status = 'verified') then
    v := v || 'billing_not_verified'::text;
  end if;
  -- The amount equals its source: the verified receipt, the approved basis, the credit-note source.
  if p_doc.kind = 'advance_invoice' then
    select * into v_rec from public.customer_receipts r where r.id = p_doc.receipt_id;
    v_source := v_rec.amount_paise;
  elsif p_doc.kind = 'invoice' then
    v_source := case when not v_issue then (p_build ->> 'totalPaise')::bigint end;
  else
    v_cn := authz.cdoc_credit_note_source(p_doc.refund_request_id);
    v_source := case when coalesce(v_cn ->> 'amountPaise', '') ~ '^[0-9]{1,18}$' then (v_cn ->> 'amountPaise')::bigint end;
  end if;
  if v_source is distinct from p_doc.total_paise
     or (not v_issue and authz.cdoc_build_hash(p_build) is distinct from p_doc.source_hash)
     or (v_issue and p_doc.kind <> 'advance_invoice') then
    v := v || 'amount_mismatch'::text;
  end if;
  if p_doc.total_paise <= 0 then
    v := v || 'amount_zero'::text;
  end if;
  select max(bv.version_no) into v_approved_no
  from public.booking_versions bv join public.accounts_booking_reviews rv on rv.booking_version_id = bv.id
  where bv.deal_id = p_doc.deal_id and bv.status in ('confirmed', 'superseded') and rv.last_approved_at is not null;
  if v_approved_no is not null and exists (select 1 from public.booking_versions bv
       where bv.deal_id = p_doc.deal_id and bv.status = 'confirmed' and bv.version_no > v_approved_no) then
    v := v || 'newer_version_waiting'::text;
  end if;
  if p_doc.kind = 'advance_invoice' and (v_rec.id is null or v_rec.status not in ('verified', 'cleared')) then
    v := v || 'receipt_not_money'::text;
  end if;
  if exists (select 1 from public.deal_cancellations x
             where x.deal_id = p_doc.deal_id and x.status in ('open', 'charges_entered', 'sent_to_manager')) then
    v := v || 'cancellation_open'::text;
  end if;
  if coalesce(authz.deal_change_open(p_doc.deal_id), false) then
    v := v || 'change_open'::text;
  end if;
  if p_doc.kind = 'invoice' and exists (select 1 from public.customer_refund_requests q
       where q.deal_id = p_doc.deal_id and q.status in ('requested', 'returned')) then
    v := v || 'refund_open'::text;
  end if;
  -- No other live document covers the same receipt, basis or refund (a replacement covers what it replaces).
  if exists (select 1 from public.customer_documents c
             where c.deal_id = p_doc.deal_id and c.kind = p_doc.kind and c.id <> p_doc.id
               and c.id is distinct from p_doc.replaces_document_id and c.status in ('draft', 'released')
               and case p_doc.kind
                     when 'advance_invoice' then c.receipt_id = p_doc.receipt_id
                     when 'credit_note' then c.refund_request_id = p_doc.refund_request_id
                     else true end) then
    v := v || 'duplicate_cover'::text;
  end if;
  v_prefix := authz.cdoc_number_prefix(p_doc.deal_id);
  if authz.cdoc_prefix_other_deal(p_doc.deal_id, p_doc.legal_entity_id, v_prefix) is not null
     or exists (select 1 from public.customer_documents x join public.customer_document_counters k
                  on k.deal_id = p_doc.deal_id and k.kind = p_doc.kind
                where x.legal_entity_id = p_doc.legal_entity_id and x.deal_id <> p_doc.deal_id
                  and x.number = v_prefix || '-' || authz.cdoc_code(p_doc.kind) || '-' || (k.last_no + 1)::text) then
    v := v || 'number_conflict'::text;
  end if;
  return v;
end;
$$;

-- ===========================================================================
-- 5. The automatic run (6.2, 6.4)
-- ===========================================================================

-- One automatic draft, or false when the source is not ready or already covered (55000 refusals of cdoc_new_draft).
create function authz.cdoc_auto_try_draft(p_deal public.deals, p_kind text, p_receipt uuid, p_refund uuid, p_replaces uuid,
  p_reason text, p_rule text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_doc public.customer_documents%rowtype;
begin
  begin
    v_doc := authz.cdoc_new_draft(p_deal, p_kind, p_receipt, p_refund, p_replaces, p_reason, gen_random_uuid(), p_rule);
  exception when sqlstate '55000' then
    return false;
  end;
  perform authz.write_system_audit('accounts.customer_document.auto_drafted', v_doc.legal_entity_id, v_doc.branch_id,
    'customer_document', v_doc.id, p_rule,
    jsonb_build_object('documentId', v_doc.id, 'kind', v_doc.kind, 'dealId', v_doc.deal_id,
      'replacesDocumentId', v_doc.replaces_document_id, 'rowVersion', v_doc.row_version));
  return true;
end;
$$;

-- The work of one run. Caller: authz.cdoc_auto_run (exception block, switches checked).
create function authz.cdoc_auto_run_inner(p_deal uuid, p_rule text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_id uuid;
  v_doc public.customer_documents%rowtype;
  v_inv public.customer_documents%rowtype;
  v_exp record;
  v_build jsonb;
  v_codes text[];
  v_state text;
  v_release boolean;
  v_core jsonb;
  v_code text;
  n_drafted integer := 0;
  n_refreshed integer := 0;
  n_held integer := 0;
  n_ready integer := 0;
  n_released integer := 0;
begin
  -- Lock order 17.1: the finance head of the Deal first.
  v_deal := authz.finance_lock_deal(p_deal);
  if v_deal.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- 1a. adv_on_receipt: verified money without any Advance Invoice (a cancelled or discarded one counts: never made again).
  for v_id in
    select r.id from public.customer_receipts r
    where r.deal_id = p_deal and r.status in ('verified', 'cleared')
      and not exists (select 1 from public.customer_documents c where c.receipt_id = r.id and c.kind = 'advance_invoice')
    order by r.received_on, r.receipt_no
  loop
    if authz.cdoc_auto_try_draft(v_deal, 'advance_invoice', v_id, null, null, null, 'adv_on_receipt') then
      n_drafted := n_drafted + 1;
    end if;
  end loop;

  -- 1b. inv_on_approval / inv_replace_on_change (LD13).
  select * into v_exp from authz.cdoc_invoice_expected(p_deal) x limit 1;
  if v_exp.total is not null then
    select * into v_inv from public.customer_documents c
    where c.deal_id = p_deal and c.kind = 'invoice' and c.status in ('draft', 'released')
    order by (c.status = 'draft') desc, c.released_at desc nulls last, c.id desc limit 1;
    if v_inv.id is null then
      if not exists (select 1 from public.customer_documents c
                     where c.deal_id = p_deal and c.kind = 'invoice' and c.status in ('discarded', 'cancelled')
                       and c.basis_version_id is not distinct from v_exp.version_id and c.total_paise = v_exp.total) then
        if authz.cdoc_auto_try_draft(v_deal, 'invoice', null, null, null, null, 'inv_on_approval') then
          n_drafted := n_drafted + 1;
        end if;
      end if;
    elsif v_inv.status = 'released'
          and authz.cdoc_settlement_charge(p_deal) is null
          and (v_inv.basis_version_id is distinct from v_exp.version_id or v_inv.total_paise is distinct from v_exp.total)
          and not exists (select 1 from public.customer_documents c
                          where c.replaces_document_id = v_inv.id
                            and (c.status in ('draft', 'released')
                                 or (c.basis_version_id is not distinct from v_exp.version_id and c.total_paise = v_exp.total))) then
      if authz.cdoc_auto_try_draft(v_deal, 'invoice', null, null, v_inv.id, 'Booking changed', 'inv_replace_on_change') then
        n_drafted := n_drafted + 1;
      end if;
    end if;
  end if;

  -- 1c. cn_on_refund (LD12): payout paid, or keep-as-credit / charge-only approved.
  for v_id in
    select q.id from public.customer_refund_requests q
    where q.deal_id = p_deal
      and ((q.status = 'paid' and q.outcome = 'payout') or (q.status = 'approved' and q.outcome in ('keep_credit', 'charge_only')))
      and not exists (select 1 from public.customer_documents c where c.refund_request_id = q.id and c.kind = 'credit_note')
    order by q.requested_at, q.id
  loop
    if authz.cdoc_credit_note_source(v_id) is not null
       and authz.cdoc_auto_try_draft(v_deal, 'credit_note', null, v_id, null, null, 'cn_on_refund') then
      n_drafted := n_drafted + 1;
    end if;
  end loop;

  -- 2-4. Refresh, check and release every automatic draft of the Deal.
  v_release := authz.cdoc_auto_release_on(v_deal.legal_entity_id);
  for v_id in
    select c.id from public.customer_documents c
    where c.deal_id = p_deal and c.status = 'draft' and c.auto_rule is not null
    order by c.created_at, c.id
  loop
    select * into v_doc from public.customer_documents c where c.id = v_id for update;
    if v_doc.status <> 'draft' then
      continue;
    end if;
    v_build := authz.cdoc_build(v_doc.deal_id, v_doc.kind, v_doc.receipt_id, v_doc.refund_request_id, v_doc.replaces_document_id,
      v_doc.tally_invoice_id);
    -- 2. Refresh a stale draft when its source still builds and credits the same document.
    if v_build ->> 'issue' is null
       and nullif(v_build ->> 'creditsDocumentId', '')::uuid is not distinct from v_doc.credits_document_id
       and authz.cdoc_build_hash(v_build) is distinct from v_doc.source_hash then
      update public.customer_documents c
      set content = v_build -> 'content', content_sha256 = authz.finance_payload_hash(v_build -> 'content'),
          source_hash = authz.cdoc_build_hash(v_build), total_paise = (v_build ->> 'totalPaise')::bigint,
          warnings = array(select jsonb_array_elements_text(v_build -> 'warnings')),
          basis_version_id = nullif(v_build ->> 'basisVersionId', '')::uuid,
          refreshed_at = now(), row_version = c.row_version + 1, updated_at = now()
      where c.id = v_doc.id returning * into v_doc;
      n_refreshed := n_refreshed + 1;
      perform authz.write_system_audit('accounts.customer_document.refreshed', v_doc.legal_entity_id, v_doc.branch_id,
        'customer_document', v_doc.id, p_rule,
        jsonb_build_object('documentId', v_doc.id, 'kind', v_doc.kind, 'rowVersion', v_doc.row_version));
    end if;
    -- 3. The checks.
    v_codes := authz.cdoc_auto_codes(v_doc, v_build);
    v_state := case when cardinality(v_codes) = 0 then 'ready' else 'held' end;
    if v_doc.auto_state is distinct from v_state or v_doc.hold_reasons is distinct from v_codes
       or v_doc.evaluated_at is null or v_doc.evaluated_at < now() - interval '5 minutes' then
      update public.customer_documents c
      set auto_state = v_state, hold_reasons = v_codes, evaluated_at = now(), row_version = c.row_version + 1, updated_at = now()
      where c.id = v_doc.id;
      if v_state = 'held' and (v_doc.auto_state is distinct from 'held' or v_doc.hold_reasons is distinct from v_codes) then
        perform authz.write_system_audit('accounts.customer_document.held', v_doc.legal_entity_id, v_doc.branch_id,
          'customer_document', v_doc.id, p_rule, jsonb_build_object('documentId', v_doc.id, 'codes', to_jsonb(v_codes)));
      end if;
    end if;
    if v_state = 'held' then
      n_held := n_held + 1;
      continue;
    end if;
    if not v_release then
      n_ready := n_ready + 1;
      continue;
    end if;
    -- 4. Automatic release: exactly the manual path (cdoc_release_core).
    begin
      v_core := authz.cdoc_release_core(v_doc.id, null, 'auto_release', gen_random_uuid());
      perform authz.write_system_audit('accounts.customer_document.auto_released', v_doc.legal_entity_id, v_doc.branch_id,
        'customer_document', v_doc.id, 'auto_release',
        jsonb_build_object('documentId', v_doc.id, 'kind', v_doc.kind, 'seq', (v_core ->> 'seq')::integer,
          'replacesDocumentId', v_doc.replaces_document_id, 'renderJobId', v_core ->> 'renderJobId'));
      n_released := n_released + 1;
    exception when sqlstate '55000' or sqlstate '40001' or sqlstate '23505' then
      -- A release refusal the checks did not foresee: held with the nearest code.
      v_code := case sqlerrm
        when 'billing_not_verified' then 'billing_not_verified'
        when 'receipt_not_verified' then 'receipt_not_money'
        when 'company_identity_missing' then 'company_identity_missing'
        when 'number_conflict' then 'number_conflict'
        else 'amount_mismatch' end;
      update public.customer_documents c
      set auto_state = 'held', hold_reasons = array[v_code], evaluated_at = now(), row_version = c.row_version + 1, updated_at = now()
      where c.id = v_doc.id;
      perform authz.write_system_audit('accounts.customer_document.held', v_doc.legal_entity_id, v_doc.branch_id,
        'customer_document', v_doc.id, p_rule, jsonb_build_object('documentId', v_doc.id, 'codes', jsonb_build_array(v_code)));
      n_held := n_held + 1;
    end;
  end loop;

  delete from public.cdoc_auto_pending p where p.deal_id = p_deal;
  return jsonb_build_object('status', 'ok', 'drafted', n_drafted, 'refreshed', n_refreshed, 'held', n_held, 'ready', n_ready,
    'released', n_released);
end;
$$;

-- FROZEN SIGNATURE (6.2): tracks G and H call it after applying a change.
-- Never raises: any error is recorded in cdoc_auto_pending (SQLSTATE only)
-- and the timer sweep runs the Deal again. Off (documents or automatic bills)
-- = nothing at all. p_rule names the cause (for example 'change_applied').
create function authz.cdoc_auto_run(p_deal uuid, p_rule text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entity uuid;
  v_syn boolean;
  v_rule text := case when authz.system_rule_ok(p_rule) then p_rule else 'auto_run' end;
  v_prev_rule text := current_setting('tripnavigate.system_rule', true);
  v_result jsonb;
begin
  if p_deal is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  select d.legal_entity_id, d.is_synthetic into v_entity, v_syn from public.deals d where d.id = p_deal;
  if v_entity is null then
    return jsonb_build_object('status', 'not_found');
  end if;
  if not authz.cdoc_auto_on(v_entity) or authz.finance_gate_issue(v_entity, v_syn) is not null then
    delete from public.cdoc_auto_pending p where p.deal_id = p_deal;
    return jsonb_build_object('status', 'off');
  end if;
  begin
    perform authz.system_rule(v_rule);
    v_result := authz.cdoc_auto_run_inner(p_deal, v_rule);
    perform set_config('tripnavigate.system_rule', coalesce(v_prev_rule, ''), true);
  exception when others then
    -- The block's own work is rolled back; the event that caused it goes on.
    insert into public.cdoc_auto_pending as p (deal_id, reason_code)
    values (p_deal, left(coalesce(nullif(sqlstate, ''), 'error'), 40))
    on conflict (deal_id) do update
      set reason_code = excluded.reason_code, attempts = p.attempts + 1, updated_at = now();
    v_result := jsonb_build_object('status', 'pending', 'errorCode', sqlstate);
  end;
  return v_result;
end;
$$;

-- ===========================================================================
-- 6. Event triggers (AFTER, same transaction; nothing while the switches are Off)
-- ===========================================================================

create function authz.cdoc_auto_on_receipt() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not authz.cdoc_auto_on(new.legal_entity_id) then
    return null;
  end if;
  if new.status in ('verified', 'cleared') then
    perform authz.cdoc_auto_run(new.deal_id, 'adv_on_receipt');
  elsif old.status in ('verified', 'cleared') then
    perform authz.cdoc_auto_run(new.deal_id, 'receipt_changed');
  end if;
  return null;
end;
$$;
create trigger customer_receipts_z_auto_bills after update on public.customer_receipts
  for each row when (old.status is distinct from new.status)
  execute function authz.cdoc_auto_on_receipt();

create function authz.cdoc_auto_on_review() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if new.last_approved_at is null or not authz.cdoc_auto_on(new.legal_entity_id) then
    return null;
  end if;
  perform authz.cdoc_auto_run(new.deal_id, 'inv_on_approval');
  return null;
end;
$$;
create trigger accounts_booking_reviews_z_auto_bills_insert after insert on public.accounts_booking_reviews
  for each row when (new.last_approved_at is not null)
  execute function authz.cdoc_auto_on_review();
create trigger accounts_booking_reviews_z_auto_bills_update after update on public.accounts_booking_reviews
  for each row when (new.last_approved_at is not null and old.last_approved_at is distinct from new.last_approved_at)
  execute function authz.cdoc_auto_on_review();

create function authz.cdoc_auto_on_refund() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not authz.cdoc_auto_on(new.legal_entity_id) then
    return null;
  end if;
  if tg_op = 'UPDATE' and ((new.status = 'paid' and new.outcome = 'payout')
                           or (new.status = 'approved' and new.outcome in ('keep_credit', 'charge_only'))) then
    perform authz.cdoc_auto_run(new.deal_id, 'cn_on_refund');
  else
    perform authz.cdoc_auto_run(new.deal_id, 'refund_changed');
  end if;
  return null;
end;
$$;
create trigger customer_refund_requests_z_auto_bills_insert after insert on public.customer_refund_requests
  for each row execute function authz.cdoc_auto_on_refund();
create trigger customer_refund_requests_z_auto_bills_status after update on public.customer_refund_requests
  for each row when (old.status is distinct from new.status)
  execute function authz.cdoc_auto_on_refund();

create function authz.cdoc_auto_on_billing() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_entity uuid;
begin
  select d.legal_entity_id into v_entity from public.deals d where d.id = new.deal_id;
  if not authz.cdoc_auto_on(v_entity) then
    return null;
  end if;
  perform authz.cdoc_auto_run(new.deal_id, 'billing_changed');
  return null;
end;
$$;
create trigger customer_billing_profiles_z_auto_bills_insert after insert on public.customer_billing_profiles
  for each row execute function authz.cdoc_auto_on_billing();
create trigger customer_billing_profiles_z_auto_bills_status after update on public.customer_billing_profiles
  for each row when (old.status is distinct from new.status)
  execute function authz.cdoc_auto_on_billing();

create function authz.cdoc_auto_on_cancellation() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not authz.cdoc_auto_on(new.legal_entity_id) then
    return null;
  end if;
  perform authz.cdoc_auto_run(new.deal_id, 'cancellation_changed');
  return null;
end;
$$;
create trigger deal_cancellations_z_auto_bills_insert after insert on public.deal_cancellations
  for each row execute function authz.cdoc_auto_on_cancellation();
create trigger deal_cancellations_z_auto_bills_status after update on public.deal_cancellations
  for each row when (old.status is distinct from new.status)
  execute function authz.cdoc_auto_on_cancellation();

-- ===========================================================================
-- 7. Timer task customer_documents_auto_sweep (every minute, <= 50 Deals)
-- ===========================================================================

create function authz.cdoc_auto_sweep() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal uuid;
  v_res jsonb;
  n_deals integer := 0;
  n_drafted integer := 0;
  n_released integer := 0;
  n_held integer := 0;
  n_pending integer := 0;
  n_off integer := 0;
begin
  for v_deal in
    select x.deal_id from (
      select p.deal_id, 0 as pri, p.created_at as at from public.cdoc_auto_pending p
      union all
      select c.deal_id, 1, min(coalesce(c.evaluated_at, c.created_at))
      from public.customer_documents c
      left join public.accounts_settings s on s.legal_entity_id = c.legal_entity_id
      where c.status = 'draft' and c.auto_rule is not null
        and (c.auto_state is null or c.auto_state = 'held'
             or (c.auto_state = 'ready' and coalesce(s.auto_bill_release_enabled, true)))
        and (c.evaluated_at is null or c.evaluated_at < now() - interval '5 minutes')
      group by c.deal_id
    ) x
    group by x.deal_id
    order by min(x.pri), min(x.at), x.deal_id
    limit 50
  loop
    v_res := authz.cdoc_auto_run(v_deal, 'auto_sweep');
    n_deals := n_deals + 1;
    n_drafted := n_drafted + coalesce((v_res ->> 'drafted')::integer, 0);
    n_released := n_released + coalesce((v_res ->> 'released')::integer, 0);
    n_held := n_held + coalesce((v_res ->> 'held')::integer, 0);
    if v_res ->> 'status' = 'pending' then
      n_pending := n_pending + 1;
    elsif v_res ->> 'status' = 'off' then
      n_off := n_off + 1;
    end if;
  end loop;
  return jsonb_build_object('deals', n_deals, 'drafted', n_drafted, 'released', n_released, 'held', n_held,
    'pending', n_pending, 'off', n_off);
end;
$$;

select authz.timer_task_register('customer_documents_auto_sweep', 'authz.cdoc_auto_sweep', 1);

-- ===========================================================================
-- 8. Reads (6.5)
-- ===========================================================================

-- R-B1 (replaces 20261204000230:114): rows add the automatic fields; autoBills switches.
create or replace function public.deal_customer_documents(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_viewer text := authz.cdoc_viewer(p_deal_id);
  v_enabled boolean;
  v_billing public.customer_billing_profiles%rowtype;
  v_verified boolean;
  v_candidates jsonb;
  v_invoice jsonb;
  v_build jsonb;
  v_cn jsonb := '[]'::jsonb;
  v_ids uuid[];
  v_id uuid;
  v_src jsonb;
  v_ref text;
  v_docs jsonb;
begin
  if v_viewer is null then
    return null;
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  v_enabled := authz.cdoc_enabled(v_deal.legal_entity_id);
  select * into v_billing from public.customer_billing_profiles b where b.deal_id = v_deal.id;
  v_verified := coalesce(v_billing.status = 'verified', false);

  if v_viewer = 'accounts' then
    if not exists (select 1 from public.customer_documents c where c.deal_id = v_deal.id and c.kind = 'invoice'
                   and c.status in ('draft', 'released')) then
      v_build := authz.cdoc_build(v_deal.id, 'invoice', null, null, null, null);
      if v_build ->> 'issue' is null then
        v_invoice := jsonb_build_object(
          'basisVersionNo', (select v.version_no from public.booking_versions v where v.id = nullif(v_build ->> 'basisVersionId', '')::uuid),
          'totalPaise', v_build ->> 'totalPaise',
          'lines', v_build -> 'content' -> 'lines',
          'warnings', v_build -> 'warnings');
      end if;
    end if;
    if to_regclass('public.customer_refund_requests') is not null then
      execute $q$
        select coalesce(array_agg(r.id order by r.requested_at, r.id), array[]::uuid[]) from public.customer_refund_requests r
        where r.deal_id = $1 and r.status in ('approved', 'paid') $q$
      into v_ids using v_deal.id;
      foreach v_id in array v_ids loop
        if not exists (select 1 from public.customer_documents c where c.refund_request_id = v_id and c.kind = 'credit_note'
                       and c.status in ('draft', 'released')) then
          v_src := authz.cdoc_credit_note_source(v_id);
          if v_src is not null and coalesce(v_src ->> 'amountPaise', '') ~ '^[1-9][0-9]{0,17}$' then
            execute 'select r.ref_no from public.customer_refund_requests r where r.id = $1' into v_ref using v_id;
            v_cn := v_cn || jsonb_build_array(jsonb_build_object('refundRequestId', v_id, 'refNo', v_ref,
              'amountPaise', v_src ->> 'amountPaise'));
          end if;
        end if;
      end loop;
    end if;
    v_candidates := jsonb_build_object(
      'advances', coalesce((
        select jsonb_agg(jsonb_build_object('receiptId', r.id, 'receiptNo', r.receipt_no, 'amountPaise', r.amount_paise::text,
                 'receivedOn', to_char(r.received_on, 'YYYY-MM-DD')) order by r.received_on, r.receipt_no)
        from public.customer_receipts r
        where r.deal_id = v_deal.id and r.status in ('verified', 'cleared')
          and not exists (select 1 from public.customer_documents c where c.receipt_id = r.id and c.kind = 'advance_invoice'
                          and c.status in ('draft', 'released'))), '[]'::jsonb),
      'invoice', v_invoice,
      'creditNotes', v_cn);
  end if;

  select coalesce(jsonb_agg(authz.cdoc_doc_json(c, v_viewer, v_enabled, v_verified)
           -- Accounts phase 3 (20261205000210): automatic fields.
           || jsonb_build_object('autoRule', c.auto_rule, 'autoState', c.auto_state, 'holdReasons', to_jsonb(c.hold_reasons),
                'releasedByCrm', c.release_rule is not null)
           order by coalesce(c.released_at, c.created_at) desc, c.id desc), '[]'::jsonb)
    into v_docs
  from public.customer_documents c
  where c.deal_id = v_deal.id
    and (v_viewer = 'accounts' or c.status in ('released', 'replaced', 'cancelled'));

  return jsonb_build_object(
    'dealId', v_deal.id,
    'viewer', v_viewer,
    'enabled', v_enabled,
    -- Accounts phase 3 (20261205000210): the automatic bill switches (release has effect only with drafts on).
    'autoBills', jsonb_build_object('drafts', authz.cdoc_auto_on(v_deal.legal_entity_id),
                                    'release', authz.cdoc_auto_release_on(v_deal.legal_entity_id)),
    'billing', jsonb_build_object('verified', v_verified, 'missing', v_billing.deal_id is null),
    'candidates', v_candidates,
    'documents', v_docs);
end;
$$;

-- R-B3 (replaces 20261204000240:339): filter autoState, preset 'toCheck' (held automatic drafts, oldest first).
create or replace function public.customer_documents_list(p_filter jsonb, p_after text default null, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  c_status constant text[] := array['draft', 'released', 'replaced', 'cancelled', 'discarded'];
  c_kind constant text[] := array['advance_invoice', 'invoice', 'credit_note'];
  c_pdf constant text[] := array['none', 'queued', 'ready', 'failed'];
  v_f jsonb := coalesce(p_filter, '{}'::jsonb);
  v_a uuid[];
  v_m uuid[];
  v_syn boolean;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_status text[];
  v_kind text[];
  v_stale boolean;
  v_changed boolean;
  v_reversed boolean;
  v_pdf text;
  v_tally boolean;
  v_ref text;
  v_like text;
  v_from date;
  v_to date;
  v_branch uuid;
  v_to_release boolean;
  v_auto_state text;
  v_preset text;
  v_dir text := 'desc';
  v_cmp text := '<';
  v_after_ts timestamptz;
  v_after_id uuid;
  v_key text;
  v_where text := '';
  v_ev text;
  v_charge text;
  v_sql text;
  v_rows jsonb;
  v_count integer;
  v_next text;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  v_a := authz.acct_a_entities();
  v_m := authz.acct_m_branches();
  v_syn := authz.acct_synthetic();
  if v_syn is null or (cardinality(v_a) = 0 and cardinality(v_m) = 0) then
    return null;
  end if;
  if jsonb_typeof(v_f) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'filter';
  end if;
  for v_key in select jsonb_object_keys(v_f) loop
    if v_key not in ('status', 'kind', 'stale', 'bookingChanged', 'paymentReversed', 'pdfState', 'tallyLinked', 'dealReference',
                     'from', 'to', 'branchId', 'toRelease', 'autoState', 'preset', 'toCheck') then
      raise exception 'invalid_input' using errcode = '22023', hint = v_key;
    end if;
  end loop;
  begin
    if v_f ? 'status' and jsonb_typeof(v_f -> 'status') <> 'null' then
      v_status := array(select jsonb_array_elements_text(v_f -> 'status'));
      if not v_status <@ c_status then raise exception 'bad'; end if;
    end if;
  exception when others then
    raise exception 'invalid_input' using errcode = '22023', hint = 'status';
  end;
  begin
    if v_f ? 'kind' and jsonb_typeof(v_f -> 'kind') <> 'null' then
      v_kind := array(select jsonb_array_elements_text(v_f -> 'kind'));
      if not v_kind <@ c_kind then raise exception 'bad'; end if;
    end if;
  exception when others then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end;
  foreach v_key in array array['stale', 'bookingChanged', 'paymentReversed', 'tallyLinked', 'toRelease'] loop
    if v_f ? v_key and jsonb_typeof(v_f -> v_key) not in ('boolean', 'null') then
      raise exception 'invalid_input' using errcode = '22023', hint = v_key;
    end if;
  end loop;
  v_stale := (v_f ->> 'stale')::boolean;
  v_changed := (v_f ->> 'bookingChanged')::boolean;
  v_reversed := (v_f ->> 'paymentReversed')::boolean;
  v_tally := (v_f ->> 'tallyLinked')::boolean;
  v_to_release := (v_f ->> 'toRelease')::boolean;
  v_pdf := v_f ->> 'pdfState';
  if v_pdf is not null and not (v_pdf = any(c_pdf)) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'pdfState';
  end if;
  -- Accounts phase 3 (20261205000210)
  if v_f ? 'autoState' and jsonb_typeof(v_f -> 'autoState') not in ('string', 'null') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'autoState';
  end if;
  v_auto_state := v_f ->> 'autoState';
  if v_auto_state is not null and v_auto_state not in ('ready', 'held') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'autoState';
  end if;
  if v_f ? 'preset' and jsonb_typeof(v_f -> 'preset') not in ('string', 'null') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'preset';
  end if;
  v_preset := v_f ->> 'preset';
  if v_preset is not null and v_preset <> 'toCheck' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'preset';
  end if;
  -- Boolean alias of the preset (like toRelease): {toCheck: true}.
  if v_f ? 'toCheck' and jsonb_typeof(v_f -> 'toCheck') not in ('boolean', 'null') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'toCheck';
  end if;
  if (v_f ->> 'toCheck')::boolean then
    v_preset := 'toCheck';
  end if;
  v_ref := nullif(btrim(coalesce(v_f ->> 'dealReference', '')), '');
  if v_ref is not null and length(v_ref) > 60 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'dealReference';
  end if;
  begin
    v_from := authz.finance_date(v_f ->> 'from');
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'from';
  end;
  begin
    v_to := authz.finance_date(v_f ->> 'to');
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'to';
  end;
  begin
    v_branch := authz.finance_uuid(v_f ->> 'branchId');
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'branchId';
  end;
  if p_after is not null then
    begin
      v_after_ts := split_part(p_after, '|', 1)::timestamptz;
      v_after_id := split_part(p_after, '|', 2)::uuid;
    exception when others then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end;
    if v_after_ts is null or v_after_id is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end if;
  end if;

  if v_status is not null then v_where := v_where || ' and c.status = any($4)'; end if;
  if v_kind is not null then v_where := v_where || ' and c.kind = any($5)'; end if;
  if v_branch is not null then v_where := v_where || ' and c.branch_id = $6'; end if;
  if v_ref is not null then
    v_like := replace(replace(replace(lower(v_ref), '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_where := v_where || ' and lower(d.reference) like $7';
  end if;
  if v_from is not null then v_where := v_where || ' and c.issue_date >= $8'; end if;
  if v_to is not null then v_where := v_where || ' and c.issue_date <= $9'; end if;
  if v_tally is not null then v_where := v_where || ' and (c.tally_invoice_id is not null) = $10'; end if;
  if v_to_release is not null then v_where := v_where || ' and (c.status = ''draft'') = $11'; end if;
  if v_reversed is not null then
    v_where := v_where || ' and (c.kind = ''advance_invoice'' and not exists (select 1 from public.customer_receipts r
      where r.id = c.receipt_id and r.status in (''verified'', ''cleared''))) = $12';
  end if;
  if v_pdf is not null then
    v_where := v_where || ' and (case when exists (select 1 from public.customer_document_files f where f.document_id = c.id) then ''ready''
      else coalesce((select case when j.status in (''queued'', ''running'') then ''queued'' when j.status = ''failed'' then ''failed'' else ''none'' end
                     from public.customer_document_render_jobs j where j.document_id = c.id order by j.created_at desc, j.id desc limit 1), ''none'') end) = $13';
  end if;
  if v_stale is true then
    v_where := v_where || ' and c.status = ''draft'' and authz.cdoc_source_hash(c.id) is distinct from c.source_hash';
  elsif v_stale is false then
    v_where := v_where || ' and (c.status <> ''draft'' or authz.cdoc_source_hash(c.id) is not distinct from c.source_hash)';
  end if;
  if v_changed is not null then
    v_ev := '(select v.id from public.booking_versions v join public.accounts_booking_reviews rv on rv.booking_version_id = v.id
      where v.deal_id = c.deal_id and v.status in (''confirmed'', ''superseded'') and rv.last_approved_at is not null
      order by v.version_no desc limit 1)';
    v_charge := case when to_regclass('public.customer_refund_requests') is null then 'null::bigint' else
      '(select max(r.customer_charge_paise) from public.customer_refund_requests r where r.deal_id = c.deal_id
         and r.kind = ''cancellation'' and r.status in (''approved'', ''paid''))' end;
    v_where := v_where || ' and (c.kind = ''invoice'' and c.status = ''released'' and (
        c.basis_version_id is distinct from coalesce(' || v_ev || ', (select v.id from public.booking_versions v
          where v.deal_id = c.deal_id and v.status = ''confirmed''))
        or c.total_paise is distinct from coalesce(' || v_charge || ', case
          when exists (select 1 from public.flight_ticket_batches t where t.deal_id = c.deal_id and t.deal_kind = ''flight_only'')
          then (select sum(t.customer_total_paise)::bigint from public.flight_ticket_batches t where t.deal_id = c.deal_id and t.deal_kind = ''flight_only'')
          else (select bc.selling_total_paise from public.booking_version_commercials bc where bc.version_id = ' || v_ev || ') end))) = $14';
  end if;
  -- Accounts phase 3 (20261205000210): automatic state and the "Bills to check" preset (oldest first).
  if v_auto_state is not null then
    v_where := v_where || ' and c.status = ''draft'' and c.auto_state = $18';
  end if;
  if v_preset = 'toCheck' then
    v_where := v_where || ' and c.status = ''draft'' and c.auto_rule is not null and c.auto_state = ''held''';
    v_dir := 'asc';
    v_cmp := '>';
  end if;
  if v_after_ts is not null then
    v_where := v_where || ' and (coalesce(c.released_at, c.created_at), c.id) ' || v_cmp || ' ($15, $16)';
  end if;

  v_sql := 'with page as (
    select c.id, c.legal_entity_id, c.deal_id, d.reference as deal_reference, b.name as branch_name,
      case when c.legal_entity_id = any($1) then ''accounts'' else ''manager'' end as viewer,
      coalesce(c.released_at, c.created_at) as sort_at
    from public.customer_documents c
    join public.deals d on d.id = c.deal_id
    join public.branches b on b.id = c.branch_id
    where d.is_synthetic = $3
      and (c.legal_entity_id = any($1) or (c.branch_id = any($2) and c.status in (''released'', ''replaced'', ''cancelled'')))'
    || v_where || '
    order by coalesce(c.released_at, c.created_at) ' || v_dir || ', c.id ' || v_dir || '
    limit $17 + 1
  ), numbered as (
    select p.*, row_number() over (order by p.sort_at ' || v_dir || ', p.id ' || v_dir || ') as rn from page p
  )
  select coalesce(jsonb_agg(
           authz.cdoc_doc_json(x, n.viewer, authz.cdoc_enabled(n.legal_entity_id),
             exists (select 1 from public.customer_billing_profiles bp where bp.deal_id = n.deal_id and bp.status = ''verified''))
           || jsonb_build_object(''dealId'', n.deal_id, ''dealReference'', n.deal_reference, ''branchName'', n.branch_name,
                ''autoRule'', x.auto_rule, ''autoState'', x.auto_state, ''holdReasons'', to_jsonb(x.hold_reasons),
                ''releasedByCrm'', x.release_rule is not null)
           order by n.rn) filter (where n.rn <= $17), ''[]''::jsonb),
         count(*)::integer,
         max(case when n.rn = $17 then to_char(n.sort_at at time zone ''UTC'', ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"'') || ''|'' || n.id::text end)
  from numbered n
  join public.customer_documents x on x.id = n.id';
  execute v_sql into v_rows, v_count, v_next
    using v_a, v_m, v_syn, v_status, v_kind, v_branch, v_like, v_from, v_to, v_tally, v_to_release, v_reversed, v_pdf, v_changed,
      v_after_ts, v_after_id, v_limit, v_auto_state;

  return jsonb_build_object('items', v_rows, 'hasMore', v_count > v_limit,
    'nextAfter', case when v_count > v_limit then v_next end);
end;
$$;

-- ===========================================================================
-- 9. Grants: internal functions to nobody; the two reads keep their grants.
-- ===========================================================================

revoke all on function
  authz.cdoc_auto_on(uuid), authz.cdoc_auto_release_on(uuid), authz.cdoc_number_prefix(uuid),
  authz.cdoc_prefix_other_deal(uuid, uuid, text),
  authz.cdoc_new_draft(public.deals, text, uuid, uuid, uuid, text, uuid, text),
  authz.cdoc_release_core(uuid, uuid, text, uuid),
  authz.cdoc_auto_codes(public.customer_documents, jsonb),
  authz.cdoc_auto_try_draft(public.deals, text, uuid, uuid, uuid, text, text),
  authz.cdoc_auto_run_inner(uuid, text), authz.cdoc_auto_run(uuid, text),
  authz.cdoc_auto_on_receipt(), authz.cdoc_auto_on_review(), authz.cdoc_auto_on_refund(), authz.cdoc_auto_on_billing(),
  authz.cdoc_auto_on_cancellation(), authz.cdoc_auto_sweep()
  from public, anon, authenticated, service_role;

commit;
