-- Accounts phase 2, Track B (2 of 4): customer document content and commands.
-- Contract: implementation/accounts-phase2-2026-11-11/contract.md sections
-- 6.3 (sources and numbering), 6.4 (frozen content cdoc-1), 6.6, 6.7 (B1-B7,
-- B9), 9, 13.1, 13.2, LD4, LD7, LD15, LD16, LD17, LD18, LD29, Addendum L5
-- (audit actions accounts.customer_document.<event>), frozen 11 Nov 2026.
--
-- Commands (security definer, execute to authenticated only; caller =
-- Accounts of the Deal's entity through authz.finance_require_accounts;
-- p_request_id required and replayed through finance_replay/finance_remember;
-- first lock authz.finance_lock_deal, then the document row, then the counter):
--   B1 public.customer_document_draft_create(p_deal_id, p_kind, p_source, p_request_id)
--   B2 public.customer_document_refresh(p_document_id, p_expected_row_version, p_request_id)
--   B3 public.customer_document_release(p_document_id, p_expected_row_version, p_expected_content_sha256, p_request_id)
--   B4 public.customer_document_discard(p_document_id, p_expected_row_version, p_reason, p_request_id)
--   B5 public.customer_document_cancel(p_document_id, p_expected_row_version, p_reason, p_request_id)
--   B6 public.customer_document_replace(p_document_id, p_expected_row_version, p_reason, p_request_id)
--   B7 public.customer_document_link_tally(p_document_id, p_tally_invoice_id, p_expected_row_version, p_request_id)
--   B9 public.admin_set_customer_documents_enabled(p_entity, p_enabled, p_reason)   (policy manager; no request id)
--   public.admin_customer_documents_settings(p_entity)   (addition: both Phase 2 switches for the settings screen)
--
-- Content (6.4, schema cdoc-1) is built by authz.cdoc_build from the source
-- facts; drafts carry source_hash = hash of the whole build result, so a draft
-- is stale when a rebuild differs (booking, money, billing, Tally link, ...).
-- No "not a tax invoice" line (Q1). Keys avoid the forbidden key words.
-- The Invoice after an approved cancellation settlement (LD17) reads Track C's
-- customer_refund_requests through dynamic SQL when that table exists.
--
-- Refusal tokens (message is exactly the token): 42501 not_authorized |
-- P0002 not_found | 40001 version_changed, request_conflict, document_stale |
-- 22023 invalid_input (hint = field) | 55000 documents_off, not_ready (hint =
-- reason: receiptId, basis, refundRequestId, replacesDocumentId),
-- billing_not_verified, receipt_not_verified, has_credit_notes, wrong_state,
-- environment_unset, not_configured | already_recorded (55000).
--
-- Audit (ids, kinds, seq, row versions only; reasons in the reason column):
-- accounts.customer_document.drafted|refreshed|released|discarded|cancelled|
-- replace_started|tally_linked; settings.accounts_changed (trigger).
--
-- Rollback (forward-only): a NEW migration revoking execute on these functions.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Content helpers
-- ===========================================================================

create function authz.cdoc_title(p_kind text) returns text
language sql immutable set search_path = '' as $$
  select case p_kind when 'advance_invoice' then 'Advance Invoice' when 'invoice' then 'Invoice' when 'credit_note' then 'Credit Note' end
$$;

create function authz.cdoc_code(p_kind text) returns text
language sql immutable set search_path = '' as $$
  select case p_kind when 'advance_invoice' then 'ADV' when 'invoice' then 'INV' when 'credit_note' then 'CN' end
$$;

-- Verified money held for the Deal (customer_advances, net of reversals and refunds).
create function authz.cdoc_money_held(p_deal uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce(sum(l.credit_paise - l.debit_paise), 0)::bigint
  from public.finance_journal_lines l where l.deal_id = p_deal and l.account = 'customer_advances'
$$;

-- LD17: the customer charge of the Deal's approved cancellation settlement
-- (Track C table, read only when it exists); null when there is none.
create function authz.cdoc_settlement_charge(p_deal uuid) returns bigint
language plpgsql stable security definer set search_path = '' as $$
declare
  v bigint;
begin
  if to_regclass('public.customer_refund_requests') is null then
    return null;
  end if;
  execute $q$
    select r.customer_charge_paise from public.customer_refund_requests r
    where r.deal_id = $1 and r.kind = 'cancellation' and r.status in ('approved', 'paid')
    order by r.decided_at desc nulls last, r.id desc limit 1 $q$
  into v using p_deal;
  return v;
end;
$$;

-- Trip summary of a version (destination, dates, traveller count).
create function authz.cdoc_trip(p_version uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'destination', coalesce(v.trip_destination, v.city),
    'startDate', to_char(coalesce(v.trip_start, v.check_in), 'YYYY-MM-DD'),
    'endDate', to_char(coalesce(v.trip_end, v.check_out), 'YYYY-MM-DD'),
    'travellerCount', coalesce(v.pax_total::integer,
      nullif((select count(*)::integer from public.booking_version_travellers t where t.booking_version_id = v.id), 0),
      case when v.adults is not null then v.adults + coalesce(v.children, 0) end))
  from public.booking_versions v where v.id = p_version
$$;

create function authz.cdoc_customer(p_deal uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('billingName', b.billing_name, 'addressLine1', b.address_line1, 'addressLine2', b.address_line2,
    'city', b.city, 'stateCode', b.state_code, 'postalCode', b.postal_code, 'gstin', b.gstin)
  from public.customer_billing_profiles b where b.deal_id = p_deal
$$;

-- The one line of a non-flight Invoice (LD16: visa / passport one line).
create function authz.cdoc_service_label(p_class text, p_destination text) returns text
language sql immutable set search_path = '' as $$
  select case p_class
      when 'hotel' then 'Hotel booking'
      when 'transfer' then 'Transfer services'
      when 'activity' then 'Sightseeing and activities'
      when 'visa' then 'Visa services'
      when 'passport' then 'Passport services'
      when 'flight_domestic' then 'Air tickets'
      when 'flight_international' then 'Air tickets'
      else 'Holiday package' end
    || case when p_destination is not null and p_class <> 'passport' then ' — ' || p_destination else '' end
$$;

-- What a released Invoice would carry now (for "booking changed since release"):
-- the dues basis version and total, or the settlement charge (LD17).
create function authz.cdoc_invoice_expected(p_deal uuid) returns table (version_id uuid, total bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_charge bigint := authz.cdoc_settlement_charge(p_deal);
  v_version uuid;
  v_basis text;
  v_class text;
  v_total bigint;
begin
  select b.version_id, b.basis into v_version, v_basis from authz.dues_basis(p_deal) b limit 1;
  if v_charge is not null then
    return query select v_version, v_charge;
    return;
  end if;
  if v_version is null or v_basis <> 'approved' then
    return query select v_version, null::bigint;
    return;
  end if;
  v_class := authz.deal_service_class(v_version);
  if v_class like 'flight%' and exists (select 1 from public.flight_ticket_batches t where t.deal_id = p_deal and t.deal_kind = 'flight_only') then
    select sum(t.customer_total_paise)::bigint into v_total from public.flight_ticket_batches t
    where t.deal_id = p_deal and t.deal_kind = 'flight_only';
  else
    select c.selling_total_paise into v_total from public.booking_version_commercials c where c.version_id = v_version;
  end if;
  return query select v_version, coalesce(v_total, 0)::bigint;
end;
$$;

-- The content of a document from its source (6.3, 6.4). Never raises for a
-- missing source: returns {issue: 'not_ready', hint} instead, so reads can
-- offer candidates and flag stale drafts. Number and issue date stay null
-- (set at release). Result keys: issue, hint, content, totalPaise (bigint
-- text), warnings, basisVersionId, creditsDocumentId.
create function authz.cdoc_build(p_deal uuid, p_kind text, p_receipt uuid, p_refund uuid, p_replaces uuid, p_tally uuid)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_branch public.branches%rowtype;
  v_rec public.customer_receipts%rowtype;
  v_version uuid;
  v_basis text;
  v_trip_version uuid;
  v_trip jsonb;
  v_lines jsonb := '[]'::jsonb;
  v_total bigint := 0;
  v_paid bigint;
  v_warnings text[] := array[]::text[];
  v_plan jsonb;
  v_payment jsonb;
  v_credits jsonb;
  v_credits_doc uuid;
  v_replaces jsonb;
  v_gst text;
  v_class text;
  v_charge bigint;
  v_selling bigint;
  v_src jsonb;
  v_content jsonb;
  v_dest text;
  v_found boolean;
begin
  select * into v_deal from public.deals d where d.id = p_deal;
  if v_deal.id is null or p_kind not in ('advance_invoice', 'invoice', 'credit_note') then
    return jsonb_build_object('issue', 'not_ready', 'hint', 'dealId');
  end if;
  select * into v_branch from public.branches b where b.id = v_deal.branch_id;
  select b.version_id, b.basis into v_version, v_basis from authz.dues_basis(p_deal) b limit 1;
  v_trip_version := v_version;
  v_paid := greatest(authz.cdoc_money_held(p_deal), 0);

  if p_kind = 'advance_invoice' then
    select * into v_rec from public.customer_receipts r where r.id = p_receipt and r.deal_id = p_deal;
    if v_rec.id is null or v_rec.status not in ('verified', 'cleared') then
      return jsonb_build_object('issue', 'not_ready', 'hint', 'receiptId');
    end if;
    v_lines := jsonb_build_array(jsonb_build_object('label', 'Advance received', 'amountPaise', v_rec.amount_paise::text));
    v_total := v_rec.amount_paise;
    v_paid := v_rec.amount_paise;
    v_payment := jsonb_build_object('reference', v_rec.receipt_no, 'receivedOn', to_char(v_rec.received_on, 'YYYY-MM-DD'),
      'mode', v_rec.mode);
  elsif p_kind = 'invoice' then
    v_charge := authz.cdoc_settlement_charge(p_deal);
    if v_charge is not null then
      -- LD17: after an approved settlement the Invoice is the cancellation charges.
      v_lines := jsonb_build_array(jsonb_build_object('label', 'Cancellation charges', 'amountPaise', v_charge::text));
      v_total := v_charge;
    else
      if v_version is null or v_basis <> 'approved' then
        return jsonb_build_object('issue', 'not_ready', 'hint', 'basis');
      end if;
      select c.selling_total_paise into v_selling from public.booking_version_commercials c where c.version_id = v_version;
      v_selling := coalesce(v_selling, 0);
      v_class := authz.deal_service_class(v_version);
      v_dest := authz.cdoc_trip(v_version) ->> 'destination';
      if v_class like 'flight%' and exists (select 1 from public.flight_ticket_batches t where t.deal_id = p_deal and t.deal_kind = 'flight_only') then
        -- LD15: one line per ticket batch; the total is the batches' sum.
        select coalesce(jsonb_agg(jsonb_build_object(
                 'label', 'Air tickets — batch ' || t.batch_no || coalesce(' (' || (
                   select string_agg(s.from_place || ' → ' || s.to_place, ', ' order by x.ord)
                   from unnest(t.sector_ids) with ordinality x(sid, ord)
                   join public.flight_sectors s on s.id = x.sid) || ')', ''),
                 'amountPaise', t.customer_total_paise::text) order by t.batch_no), '[]'::jsonb),
               coalesce(sum(t.customer_total_paise), 0)::bigint
          into v_lines, v_total
        from public.flight_ticket_batches t where t.deal_id = p_deal and t.deal_kind = 'flight_only';
        if v_total <> v_selling then
          v_warnings := v_warnings || 'flight_total_differs'::text;
        end if;
      else
        v_lines := jsonb_build_array(jsonb_build_object('label', authz.cdoc_service_label(v_class, v_dest), 'amountPaise', v_selling::text));
        v_total := v_selling;
      end if;
      -- LD29: the plan only when the version has instalments.
      select jsonb_agg(jsonb_build_object('label', i.label, 'dueDate', to_char(i.due_date, 'YYYY-MM-DD'),
               'amountPaise', i.amount_paise::text) order by i.due_date, i.seq)
        into v_plan
      from public.booking_version_instalments i where i.booking_version_id = v_version;
    end if;
  else
    if p_refund is null then
      return jsonb_build_object('issue', 'not_ready', 'hint', 'refundRequestId');
    end if;
    -- The refund request must belong to this Deal (Track C table, when present).
    if to_regclass('public.customer_refund_requests') is not null then
      execute 'select exists (select 1 from public.customer_refund_requests r where r.id = $1 and r.deal_id = $2)'
        into v_found using p_refund, p_deal;
      if not v_found then
        return jsonb_build_object('issue', 'not_ready', 'hint', 'refundRequestId');
      end if;
    end if;
    v_src := authz.cdoc_credit_note_source(p_refund);
    if v_src is null or jsonb_typeof(v_src) <> 'object' or coalesce(v_src ->> 'amountPaise', '') !~ '^[1-9][0-9]{0,17}$' then
      return jsonb_build_object('issue', 'not_ready', 'hint', 'refundRequestId');
    end if;
    v_total := (v_src ->> 'amountPaise')::bigint;
    v_lines := jsonb_build_array(jsonb_build_object('label',
      'Credit for ' || coalesce(nullif(btrim(v_src ->> 'reasonWords'), ''), 'the cancellation'), 'amountPaise', v_total::text));
    v_credits_doc := nullif(v_src ->> 'creditsDocumentId', '')::uuid;
    if v_credits_doc is not null then
      select jsonb_build_object('number', c.number, 'title', authz.cdoc_title(c.kind)) into v_credits
      from public.customer_documents c where c.id = v_credits_doc and c.deal_id = p_deal and c.number is not null;
      if v_credits is null then
        return jsonb_build_object('issue', 'not_ready', 'hint', 'refundRequestId');
      end if;
    end if;
  end if;

  if p_replaces is not null then
    select jsonb_build_object('number', r.number) into v_replaces
    from public.customer_documents r where r.id = p_replaces and r.deal_id = p_deal and r.number is not null;
    if v_replaces is null then
      return jsonb_build_object('issue', 'not_ready', 'hint', 'replacesDocumentId');
    end if;
  end if;
  if p_tally is not null and p_kind in ('invoice', 'credit_note') then
    select g.invoice_ref into v_gst from public.deal_tally_invoices g
    where g.id = p_tally and g.deal_id = p_deal and g.status = 'active';
  end if;

  v_trip := coalesce(authz.cdoc_trip(v_trip_version),
    jsonb_build_object('destination', null, 'startDate', null, 'endDate', null, 'travellerCount', null));
  v_content := jsonb_build_object(
    'schema', 'cdoc-1',
    'kind', p_kind,
    'title', authz.cdoc_title(p_kind),
    'number', null,
    'issueDate', null,
    'company', authz.cdoc_company(v_deal.branch_id),
    'branch', jsonb_build_object('code', v_branch.code, 'name', v_branch.name),
    'customer', authz.cdoc_customer(p_deal),
    'deal', jsonb_build_object('reference', v_deal.reference, 'dealNumber', v_deal.source_deal_id::text),
    'trip', v_trip,
    'lines', v_lines,
    'totalPaise', v_total::text,
    'paidPaise', v_paid::text,
    'payment', v_payment,
    'credits', v_credits,
    'gstInvoiceNumber', v_gst,
    'replaces', v_replaces);
  if p_kind = 'invoice' then
    v_content := v_content || jsonb_build_object('balancePaise', greatest(v_total - v_paid, 0)::text);
    if v_plan is not null then
      v_content := v_content || jsonb_build_object('plan', v_plan);
    end if;
  end if;
  return jsonb_build_object('issue', null, 'hint', null, 'content', v_content, 'totalPaise', v_total::text,
    'warnings', to_jsonb(v_warnings), 'basisVersionId', case when p_kind = 'invoice' then v_version end,
    'creditsDocumentId', v_credits_doc);
end;
$$;

-- Hash of a build result (drafts store it as source_hash).
create function authz.cdoc_build_hash(p_build jsonb) returns text
language sql immutable set search_path = '' as $$
  select authz.finance_payload_hash(p_build)
$$;

-- The source hash a document would have if rebuilt now.
create function authz.cdoc_source_hash(p_document uuid) returns text
language sql stable security definer set search_path = '' as $$
  select authz.cdoc_build_hash(authz.cdoc_build(c.deal_id, c.kind, c.receipt_id, c.refund_request_id, c.replaces_document_id,
    c.tally_invoice_id))
  from public.customer_documents c where c.id = p_document
$$;

-- Refusal for a build issue (raised by commands).
create function authz.cdoc_raise_issue(p_build jsonb) returns void
language plpgsql volatile set search_path = '' as $$
begin
  if p_build ->> 'issue' is not null then
    raise exception '%', p_build ->> 'issue' using errcode = '55000', hint = coalesce(p_build ->> 'hint', '');
  end if;
end;
$$;

create function authz.cdoc_enabled(p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.customer_documents_enabled from public.accounts_settings s where s.legal_entity_id = p_entity), false)
$$;

create function authz.cdoc_require_enabled(p_entity uuid) returns void
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.cdoc_enabled(p_entity) then
    raise exception 'documents_off' using errcode = '55000';
  end if;
end;
$$;

-- Start of every document command: the document's Deal, Accounts of its
-- entity, the finance head lock, then the document row FOR UPDATE.
create function authz.cdoc_lock(p_document uuid) returns public.customer_documents
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.customer_documents%rowtype;
  v_syn boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_document is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'documentId';
  end if;
  select * into v from public.customer_documents c where c.id = p_document;
  if v.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select d.is_synthetic into v_syn from public.deals d where d.id = v.deal_id;
  perform authz.finance_require_accounts(v.legal_entity_id, v_syn);
  perform authz.finance_lock_deal(v.deal_id);
  select * into v from public.customer_documents c where c.id = p_document for update;
  return v;
end;
$$;

create function authz.cdoc_check_version(p_doc public.customer_documents, p_expected integer) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_expected is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  if p_doc.row_version <> p_expected then
    raise exception 'version_changed' using errcode = '40001';
  end if;
end;
$$;

-- Result of a document command.
create function authz.cdoc_result(p_outcome text, p_doc public.customer_documents) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('outcome', p_outcome, 'documentId', p_doc.id, 'dealId', p_doc.deal_id, 'kind', p_doc.kind,
    'status', p_doc.status, 'number', p_doc.number, 'rowVersion', p_doc.row_version, 'contentSha256', p_doc.content_sha256)
$$;

-- A new draft (B1 and B6). Caller holds the finance head lock of the Deal.
create function authz.cdoc_new_draft(p_deal public.deals, p_kind text, p_receipt uuid, p_refund uuid, p_replaces uuid,
  p_replace_reason text, p_request uuid)
returns public.customer_documents
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_old public.customer_documents%rowtype;
  v_receipt uuid := p_receipt;
  v_tally uuid;
  v_build jsonb;
  v_doc public.customer_documents%rowtype;
begin
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
      created_by, request_id, replace_reason)
    values (p_deal.legal_entity_id, p_deal.branch_id, p_deal.id, p_kind, nullif(v_build ->> 'basisVersionId', '')::uuid,
      case when p_kind = 'advance_invoice' then v_receipt end, case when p_kind = 'credit_note' then p_refund end,
      nullif(v_build ->> 'creditsDocumentId', '')::uuid, p_replaces, v_tally, v_build -> 'content',
      authz.finance_payload_hash(v_build -> 'content'), authz.cdoc_build_hash(v_build), (v_build ->> 'totalPaise')::bigint,
      array(select jsonb_array_elements_text(v_build -> 'warnings')), (select auth.uid()), p_request, p_replace_reason)
    returning * into v_doc;
  exception when unique_violation then
    raise exception 'already_recorded' using errcode = '55000';
  end;
  return v_doc;
end;
$$;

-- ===========================================================================
-- 2. B1 draft create
-- ===========================================================================

create function public.customer_document_draft_create(p_deal_id uuid, p_kind text, p_source jsonb, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id, 'kind', p_kind, 'source', p_source);
  v_result jsonb;
  v_src jsonb := coalesce(p_source, '{}'::jsonb);
  v_receipt uuid;
  v_refund uuid;
  v_replaces uuid;
  v_doc public.customer_documents%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.finance_require_accounts(v_deal.legal_entity_id, v_deal.is_synthetic);
  perform authz.finance_lock_deal(v_deal.id);
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'customer_document_draft_create', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.cdoc_require_enabled(v_deal.legal_entity_id);
  if p_kind is null or p_kind not in ('advance_invoice', 'invoice', 'credit_note') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'kind';
  end if;
  if jsonb_typeof(v_src) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'source';
  end if;
  begin
    v_receipt := authz.finance_uuid(authz.finance_field(v_src, 'receiptId'));
    v_refund := authz.finance_uuid(authz.finance_field(v_src, 'refundRequestId'));
    v_replaces := authz.finance_uuid(authz.finance_field(v_src, 'replacesDocumentId'));
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'source';
  end;
  if (p_kind = 'advance_invoice' and not ((v_src - 'receiptId') = '{}'::jsonb and v_receipt is not null)
                                 and not ((v_src - 'replacesDocumentId') = '{}'::jsonb and v_replaces is not null))
     or (p_kind = 'invoice' and not (v_src = '{}'::jsonb or ((v_src - 'replacesDocumentId') = '{}'::jsonb and v_replaces is not null)))
     or (p_kind = 'credit_note' and not ((v_src - 'refundRequestId') = '{}'::jsonb and v_refund is not null)) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'source';
  end if;
  v_doc := authz.cdoc_new_draft(v_deal, p_kind, v_receipt, v_refund, v_replaces, null, p_request_id);
  perform authz.write_audit('accounts.customer_document.drafted', v_deal.legal_entity_id, v_deal.branch_id, 'customer_document', v_doc.id,
    null, jsonb_build_object('documentId', v_doc.id, 'kind', v_doc.kind, 'dealId', v_deal.id,
      'replacesDocumentId', v_doc.replaces_document_id, 'rowVersion', v_doc.row_version));
  v_result := authz.cdoc_result('created', v_doc) || jsonb_build_object('warnings', to_jsonb(v_doc.warnings));
  return authz.finance_remember(v_deal.legal_entity_id, p_request_id, 'customer_document_draft_create', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 3. B2 refresh
-- ===========================================================================

create function public.customer_document_refresh(p_document_id uuid, p_expected_row_version integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.customer_documents%rowtype;
  v_payload jsonb := jsonb_build_object('documentId', p_document_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_build jsonb;
begin
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v := authz.cdoc_lock(p_document_id);
  v_result := authz.finance_replay(v.legal_entity_id, p_request_id, 'customer_document_refresh', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.cdoc_require_enabled(v.legal_entity_id);
  if v.status <> 'draft' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.cdoc_check_version(v, p_expected_row_version);
  v_build := authz.cdoc_build(v.deal_id, v.kind, v.receipt_id, v.refund_request_id, v.replaces_document_id, v.tally_invoice_id);
  perform authz.cdoc_raise_issue(v_build);
  update public.customer_documents c
  set content = v_build -> 'content', content_sha256 = authz.finance_payload_hash(v_build -> 'content'),
      source_hash = authz.cdoc_build_hash(v_build), total_paise = (v_build ->> 'totalPaise')::bigint,
      warnings = array(select jsonb_array_elements_text(v_build -> 'warnings')),
      basis_version_id = nullif(v_build ->> 'basisVersionId', '')::uuid,
      credits_document_id = nullif(v_build ->> 'creditsDocumentId', '')::uuid,
      refreshed_at = now(), row_version = c.row_version + 1, updated_at = now()
  where c.id = v.id returning * into v;
  perform authz.write_audit('accounts.customer_document.refreshed', v.legal_entity_id, v.branch_id, 'customer_document', v.id, null,
    jsonb_build_object('documentId', v.id, 'kind', v.kind, 'rowVersion', v.row_version));
  v_result := authz.cdoc_result('updated', v) || jsonb_build_object('warnings', to_jsonb(v.warnings));
  return authz.finance_remember(v.legal_entity_id, p_request_id, 'customer_document_refresh', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 4. B3 release
-- ===========================================================================

create function public.customer_document_release(p_document_id uuid, p_expected_row_version integer, p_expected_content_sha256 text,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.customer_documents%rowtype;
  v_old public.customer_documents%rowtype;
  v_payload jsonb := jsonb_build_object('documentId', p_document_id, 'expectedRowVersion', p_expected_row_version,
    'expectedContentSha256', p_expected_content_sha256);
  v_result jsonb;
  v_seq integer;
  v_number text;
  v_today date := authz.finance_today();
  v_content jsonb;
  v_job uuid;
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
  if not exists (select 1 from public.customer_billing_profiles b where b.deal_id = v.deal_id and b.status = 'verified') then
    raise exception 'billing_not_verified' using errcode = '55000';
  end if;
  if v.kind = 'advance_invoice' and not exists (
       select 1 from public.customer_receipts r where r.id = v.receipt_id and r.status in ('verified', 'cleared')) then
    raise exception 'receipt_not_verified' using errcode = '55000';
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

  -- Number (6.3, LD4): the Deal's counter for this kind, locked.
  insert into public.customer_document_counters (deal_id, kind) values (v.deal_id, v.kind) on conflict do nothing;
  update public.customer_document_counters k set last_no = k.last_no + 1
  where k.deal_id = v.deal_id and k.kind = v.kind returning k.last_no into v_seq;
  v_number := authz.cdoc_prefix(v.deal_id) || '-' || authz.cdoc_code(v.kind) || '-' || v_seq::text;
  v_content := v.content || jsonb_build_object('number', v_number, 'issueDate', to_char(v_today, 'YYYY-MM-DD'));

  update public.customer_documents c
  set status = 'released', number = v_number, seq = v_seq, content = v_content,
      content_sha256 = authz.finance_payload_hash(v_content), issue_date = v_today,
      released_by = (select auth.uid()), released_at = now(), release_request_id = p_request_id,
      row_version = c.row_version + 1, updated_at = now()
  where c.id = v.id returning * into v;

  if v_old.id is not null then
    update public.customer_documents c
    set status = 'replaced', ended_by = (select auth.uid()), ended_at = now(),
        end_reason = coalesce(v.replace_reason, 'Replaced by ' || v.number), row_version = c.row_version + 1, updated_at = now()
    where c.id = v_old.id;
  end if;

  insert into public.customer_document_render_jobs (legal_entity_id, document_id, content_sha256, template_version, requested_by)
  values (v.legal_entity_id, v.id, v.content_sha256, 'cdoc-1', (select auth.uid()))
  returning id into v_job;

  perform authz.write_audit('accounts.customer_document.released', v.legal_entity_id, v.branch_id, 'customer_document', v.id, null,
    jsonb_build_object('documentId', v.id, 'kind', v.kind, 'seq', v.seq, 'replacesDocumentId', v.replaces_document_id,
      'renderJobId', v_job, 'rowVersion', v.row_version));
  v_result := authz.cdoc_result('updated', v) || jsonb_build_object('seq', v.seq, 'issueDate', to_char(v.issue_date, 'YYYY-MM-DD'),
    'renderJobId', v_job, 'replacedDocumentId', v_old.id);
  return authz.finance_remember(v.legal_entity_id, p_request_id, 'customer_document_release', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 5. B4 discard, B5 cancel, B6 replace
-- ===========================================================================

create function public.customer_document_discard(p_document_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.customer_documents%rowtype;
  v_payload jsonb := jsonb_build_object('documentId', p_document_id, 'expectedRowVersion', p_expected_row_version, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v := authz.cdoc_lock(p_document_id);
  v_result := authz.finance_replay(v.legal_entity_id, p_request_id, 'customer_document_discard', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.cdoc_require_enabled(v.legal_entity_id);
  if v.status <> 'draft' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.cdoc_check_version(v, p_expected_row_version);
  begin
    v_reason := authz.finance_reason(p_reason);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end;
  update public.customer_documents c
  set status = 'discarded', ended_by = (select auth.uid()), ended_at = now(), end_reason = v_reason,
      row_version = c.row_version + 1, updated_at = now()
  where c.id = v.id returning * into v;
  perform authz.write_audit('accounts.customer_document.discarded', v.legal_entity_id, v.branch_id, 'customer_document', v.id, v_reason,
    jsonb_build_object('documentId', v.id, 'kind', v.kind, 'rowVersion', v.row_version));
  return authz.finance_remember(v.legal_entity_id, p_request_id, 'customer_document_discard', v_payload, authz.cdoc_result('updated', v));
end;
$$;

create function public.customer_document_cancel(p_document_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.customer_documents%rowtype;
  v_payload jsonb := jsonb_build_object('documentId', p_document_id, 'expectedRowVersion', p_expected_row_version, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v := authz.cdoc_lock(p_document_id);
  v_result := authz.finance_replay(v.legal_entity_id, p_request_id, 'customer_document_cancel', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.cdoc_require_enabled(v.legal_entity_id);
  if v.status <> 'released' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.cdoc_check_version(v, p_expected_row_version);
  begin
    v_reason := authz.finance_reason(p_reason);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end;
  if exists (select 1 from public.customer_documents c where c.credits_document_id = v.id and c.status = 'released') then
    raise exception 'has_credit_notes' using errcode = '55000';
  end if;
  -- A replacement in progress must be released or discarded first.
  if exists (select 1 from public.customer_documents c where c.replaces_document_id = v.id and c.status = 'draft') then
    raise exception 'wrong_state' using errcode = '55000', hint = 'replacement';
  end if;
  update public.customer_documents c
  set status = 'cancelled', ended_by = (select auth.uid()), ended_at = now(), end_reason = v_reason,
      row_version = c.row_version + 1, updated_at = now()
  where c.id = v.id returning * into v;
  perform authz.write_audit('accounts.customer_document.cancelled', v.legal_entity_id, v.branch_id, 'customer_document', v.id, v_reason,
    jsonb_build_object('documentId', v.id, 'kind', v.kind, 'seq', v.seq, 'rowVersion', v.row_version));
  return authz.finance_remember(v.legal_entity_id, p_request_id, 'customer_document_cancel', v_payload, authz.cdoc_result('updated', v));
end;
$$;

create function public.customer_document_replace(p_document_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.customer_documents%rowtype;
  v_deal public.deals%rowtype;
  v_new public.customer_documents%rowtype;
  v_payload jsonb := jsonb_build_object('documentId', p_document_id, 'expectedRowVersion', p_expected_row_version, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v := authz.cdoc_lock(p_document_id);
  v_result := authz.finance_replay(v.legal_entity_id, p_request_id, 'customer_document_replace', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.cdoc_require_enabled(v.legal_entity_id);
  if v.status <> 'released' or v.kind not in ('advance_invoice', 'invoice') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.cdoc_check_version(v, p_expected_row_version);
  begin
    v_reason := authz.finance_reason(p_reason);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end;
  select * into v_deal from public.deals d where d.id = v.deal_id;
  v_new := authz.cdoc_new_draft(v_deal, v.kind, v.receipt_id, null, v.id, v_reason, p_request_id);
  perform authz.write_audit('accounts.customer_document.replace_started', v.legal_entity_id, v.branch_id, 'customer_document', v.id,
    v_reason, jsonb_build_object('documentId', v.id, 'replacementDocumentId', v_new.id, 'kind', v.kind));
  v_result := authz.cdoc_result('created', v_new) || jsonb_build_object('replacesDocumentId', v.id, 'warnings', to_jsonb(v_new.warnings));
  return authz.finance_remember(v.legal_entity_id, p_request_id, 'customer_document_replace', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 6. B7 Tally GST invoice link (LD18)
-- ===========================================================================

create function public.customer_document_link_tally(p_document_id uuid, p_tally_invoice_id uuid, p_expected_row_version integer,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.customer_documents%rowtype;
  v_payload jsonb := jsonb_build_object('documentId', p_document_id, 'tallyInvoiceId', p_tally_invoice_id,
    'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_build jsonb;
begin
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v := authz.cdoc_lock(p_document_id);
  v_result := authz.finance_replay(v.legal_entity_id, p_request_id, 'customer_document_link_tally', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.cdoc_require_enabled(v.legal_entity_id);
  if v.kind not in ('invoice', 'credit_note') or v.status not in ('draft', 'released') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.cdoc_check_version(v, p_expected_row_version);
  if p_tally_invoice_id is not null and not exists (
       select 1 from public.deal_tally_invoices g where g.id = p_tally_invoice_id and g.deal_id = v.deal_id and g.status = 'active') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'tallyInvoiceId';
  end if;
  if v.status = 'released' then
    if v.tally_invoice_id is not null then
      raise exception 'already_recorded' using errcode = '55000';
    end if;
    if p_tally_invoice_id is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'tallyInvoiceId';
    end if;
    update public.customer_documents c set tally_invoice_id = p_tally_invoice_id, row_version = c.row_version + 1, updated_at = now()
    where c.id = v.id returning * into v;
  else
    v_build := authz.cdoc_build(v.deal_id, v.kind, v.receipt_id, v.refund_request_id, v.replaces_document_id, p_tally_invoice_id);
    perform authz.cdoc_raise_issue(v_build);
    update public.customer_documents c
    set tally_invoice_id = p_tally_invoice_id, content = v_build -> 'content',
        content_sha256 = authz.finance_payload_hash(v_build -> 'content'), source_hash = authz.cdoc_build_hash(v_build),
        total_paise = (v_build ->> 'totalPaise')::bigint, warnings = array(select jsonb_array_elements_text(v_build -> 'warnings')),
        basis_version_id = nullif(v_build ->> 'basisVersionId', '')::uuid,
        credits_document_id = nullif(v_build ->> 'creditsDocumentId', '')::uuid,
        refreshed_at = now(), row_version = c.row_version + 1, updated_at = now()
    where c.id = v.id returning * into v;
  end if;
  perform authz.write_audit('accounts.customer_document.tally_linked', v.legal_entity_id, v.branch_id, 'customer_document', v.id, null,
    jsonb_build_object('documentId', v.id, 'tallyInvoiceId', v.tally_invoice_id, 'rowVersion', v.row_version));
  return authz.finance_remember(v.legal_entity_id, p_request_id, 'customer_document_link_tally', v_payload, authz.cdoc_result('updated', v));
end;
$$;

-- ===========================================================================
-- 7. B9 switch and the settings read
-- ===========================================================================

create function public.admin_set_customer_documents_enabled(p_entity uuid, p_enabled boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before boolean;
  v_after public.accounts_settings%rowtype;
  v_reason text;
  v_prev text[];
begin
  if p_entity is null or not authz.can_manage_finance_policy(p_entity) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  begin
    v_reason := authz.finance_reason(p_reason);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end;
  if p_enabled is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'enabled';
  end if;
  select s.customer_documents_enabled into v_before from public.accounts_settings s where s.legal_entity_id = p_entity for update;
  v_prev := authz.settings_begin_change('admin_set_customer_documents_enabled', v_reason);
  insert into public.accounts_settings as s (legal_entity_id, customer_documents_enabled, updated_by)
  values (p_entity, p_enabled, (select auth.uid()))
  on conflict (legal_entity_id) do update
    set customer_documents_enabled = excluded.customer_documents_enabled, updated_by = excluded.updated_by, updated_at = now(),
        row_version = s.row_version + 1
    where s.customer_documents_enabled is distinct from excluded.customer_documents_enabled
  returning * into v_after;
  perform authz.settings_end_change(v_prev);
  if v_after.legal_entity_id is null then
    select * into v_after from public.accounts_settings s where s.legal_entity_id = p_entity;
  end if;
  return jsonb_build_object('changed', coalesce(v_before, false) is distinct from p_enabled,
    'customerDocumentsEnabled', v_after.customer_documents_enabled, 'rowVersion', v_after.row_version, 'updatedAt', v_after.updated_at);
end;
$$;

-- Addition (lead to confirm): both Phase 2 switches for the settings screen.
-- Policy managers only; null otherwise.
create function public.admin_customer_documents_settings(p_entity uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.accounts_settings%rowtype;
begin
  if p_entity is null or not authz.can_manage_finance_policy(p_entity) then
    return null;
  end if;
  select * into v from public.accounts_settings s where s.legal_entity_id = p_entity;
  return jsonb_build_object('entityId', p_entity,
    'customerDocumentsEnabled', coalesce(v.customer_documents_enabled, false),
    'refundsEnabled', coalesce(v.refunds_enabled, false),
    'rowVersion', coalesce(v.row_version, 0), 'updatedAt', v.updated_at);
end;
$$;

-- ===========================================================================
-- 8. Grants
-- ===========================================================================

revoke all on function
  authz.cdoc_title(text), authz.cdoc_code(text), authz.cdoc_money_held(uuid), authz.cdoc_settlement_charge(uuid),
  authz.cdoc_trip(uuid), authz.cdoc_customer(uuid), authz.cdoc_service_label(text, text), authz.cdoc_invoice_expected(uuid),
  authz.cdoc_build(uuid, text, uuid, uuid, uuid, uuid), authz.cdoc_build_hash(jsonb), authz.cdoc_source_hash(uuid),
  authz.cdoc_raise_issue(jsonb), authz.cdoc_enabled(uuid), authz.cdoc_require_enabled(uuid), authz.cdoc_lock(uuid),
  authz.cdoc_check_version(public.customer_documents, integer), authz.cdoc_result(text, public.customer_documents),
  authz.cdoc_new_draft(public.deals, text, uuid, uuid, uuid, text, uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  public.customer_document_draft_create(uuid, text, jsonb, uuid),
  public.customer_document_refresh(uuid, integer, uuid),
  public.customer_document_release(uuid, integer, text, uuid),
  public.customer_document_discard(uuid, integer, text, uuid),
  public.customer_document_cancel(uuid, integer, text, uuid),
  public.customer_document_replace(uuid, integer, text, uuid),
  public.customer_document_link_tally(uuid, uuid, integer, uuid),
  public.admin_set_customer_documents_enabled(uuid, boolean, text),
  public.admin_customer_documents_settings(uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  public.customer_document_draft_create(uuid, text, jsonb, uuid),
  public.customer_document_refresh(uuid, integer, uuid),
  public.customer_document_release(uuid, integer, text, uuid),
  public.customer_document_discard(uuid, integer, text, uuid),
  public.customer_document_cancel(uuid, integer, text, uuid),
  public.customer_document_replace(uuid, integer, text, uuid),
  public.customer_document_link_tally(uuid, uuid, integer, uuid),
  public.admin_set_customer_documents_enabled(uuid, boolean, text),
  public.admin_customer_documents_settings(uuid)
  to authenticated;

commit;
