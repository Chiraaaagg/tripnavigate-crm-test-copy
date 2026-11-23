-- Accounts phase 2, Track B (5): fixes after the independent backend review.
-- Contract: implementation/accounts-phase2-2026-11-11/contract.md Addendum L7
-- (reviews 3, 5, 6, 7; review 10 is application code), 11 Nov 2026.
-- Applied files 20261204000200..0230 stay unchanged; the functions below
-- start from their bodies there (changed lines marked
-- "Accounts phase 2 (20261204000240)").
--
--   review 3  public.customer_documents_list: the query is built from the
--             filters actually given (dynamic SQL), so no definer function
--             runs per row unless that filter is asked for; the PDF state and
--             "booking changed" filters are plain indexed subqueries; the
--             stale filter runs the rebuild only on drafts. The list order
--             uses customer_documents_entity_order_idx.
--   review 5  customer_document_release refuses company_identity_missing
--             (55000) when the content's company GSTIN is a placeholder.
--   review 6  customer_document_refresh / customer_document_link_tally never
--             rewrite credits_document_id; a rebuild naming another credited
--             document refuses not_ready (hint creditsDocumentId) instead of
--             the guard's raw 42501.
--   review 7  customer_document_counters.prefix: fixed at the Deal's first
--             release, kept on every counter row of the Deal, immutable once
--             set; a prefix already used by another Deal of the entity
--             refuses number_conflict (23505, hint "otherDealReference=<ref>").
--             Backfilled from released numbers.
--   L7 review 1 (charge semantics): authz.cdoc_settlement_charge takes the
--             highest customer charge of the Deal's approved settlements.
--   authz.cdoc_invoice_expected: same rule as the list filter (flight-only
--             batches decide the flight total; no per-row class function).
--
-- New refusal tokens: company_identity_missing (55000), number_conflict (23505).
-- Rollback (forward-only): a NEW migration restoring the 0210/0230 bodies;
-- the prefix column stays.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Counter prefix (review 7)
-- ===========================================================================

alter table public.customer_document_counters
  add column prefix text check (prefix is null or length(prefix) between 1 and 40);
create index customer_document_counters_prefix_idx on public.customer_document_counters (prefix) where prefix is not null;

update public.customer_document_counters k
set prefix = x.prefix
from (select distinct on (c.deal_id) c.deal_id, regexp_replace(c.number, '-(ADV|INV|CN)-[0-9]{1,4}$', '') as prefix
      from public.customer_documents c where c.number is not null
      order by c.deal_id, c.released_at, c.id) x
where x.deal_id = k.deal_id and k.prefix is null;

-- Accounts phase 2 (20261204000240): the prefix goes from none to one, never changes.
create or replace function authz.customer_document_counters_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'document counters cannot be deleted' using errcode = '42501';
  end if;
  if new.deal_id is distinct from old.deal_id or new.kind is distinct from old.kind or new.last_no < old.last_no
     or (old.prefix is not null and new.prefix is distinct from old.prefix) then
    raise exception 'document counters only move forward' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- ===========================================================================
-- 2. Helpers
-- ===========================================================================

-- Accounts phase 2 (20261204000240, L7 review 1): the highest charge of the approved settlements.
create or replace function authz.cdoc_settlement_charge(p_deal uuid) returns bigint
language plpgsql stable security definer set search_path = '' as $$
declare
  v bigint;
begin
  if to_regclass('public.customer_refund_requests') is null then
    return null;
  end if;
  execute $q$
    select max(r.customer_charge_paise) from public.customer_refund_requests r
    where r.deal_id = $1 and r.kind = 'cancellation' and r.status in ('approved', 'paid') $q$
  into v using p_deal;
  return v;
end;
$$;

-- Accounts phase 2 (20261204000240): the expected version and total of a
-- released Invoice, written as the list filter computes it.
create or replace function authz.cdoc_invoice_expected(p_deal uuid) returns table (version_id uuid, total bigint)
language plpgsql stable security definer set search_path = '' as $$
declare
  v_charge bigint := authz.cdoc_settlement_charge(p_deal);
  v_approved uuid;
  v_version uuid;
  v_total bigint;
begin
  select v.id into v_approved from public.booking_versions v
  join public.accounts_booking_reviews rv on rv.booking_version_id = v.id
  where v.deal_id = p_deal and v.status in ('confirmed', 'superseded') and rv.last_approved_at is not null
  order by v.version_no desc limit 1;
  v_version := coalesce(v_approved, (select v.id from public.booking_versions v where v.deal_id = p_deal and v.status = 'confirmed'));
  if v_charge is not null then
    v_total := v_charge;
  elsif exists (select 1 from public.flight_ticket_batches t where t.deal_id = p_deal and t.deal_kind = 'flight_only') then
    select sum(t.customer_total_paise)::bigint into v_total from public.flight_ticket_batches t where t.deal_id = p_deal and t.deal_kind = 'flight_only';
  else
    select c.selling_total_paise into v_total from public.booking_version_commercials c where c.version_id = v_approved;
  end if;
  return query select v_version, v_total;
end;
$$;

-- Review 6: a rebuild must name the credited document the draft was made for.
create function authz.cdoc_require_same_credits(p_doc public.customer_documents, p_build jsonb) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if nullif(p_build ->> 'creditsDocumentId', '')::uuid is distinct from p_doc.credits_document_id then
    raise exception 'not_ready' using errcode = '55000', hint = 'creditsDocumentId';
  end if;
end;
$$;

-- ===========================================================================
-- 3. Commands (reviews 5, 6, 7)
-- ===========================================================================

create or replace function public.customer_document_refresh(p_document_id uuid, p_expected_row_version integer, p_request_id uuid)
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
  perform authz.cdoc_require_same_credits(v, v_build);  -- Accounts phase 2 (20261204000240)
  update public.customer_documents c
  set content = v_build -> 'content', content_sha256 = authz.finance_payload_hash(v_build -> 'content'),
      source_hash = authz.cdoc_build_hash(v_build), total_paise = (v_build ->> 'totalPaise')::bigint,
      warnings = array(select jsonb_array_elements_text(v_build -> 'warnings')),
      basis_version_id = nullif(v_build ->> 'basisVersionId', '')::uuid,
      -- Accounts phase 2 (20261204000240, L7 review 6): credits_document_id is never rewritten.
      refreshed_at = now(), row_version = c.row_version + 1, updated_at = now()
  where c.id = v.id returning * into v;
  perform authz.write_audit('accounts.customer_document.refreshed', v.legal_entity_id, v.branch_id, 'customer_document', v.id, null,
    jsonb_build_object('documentId', v.id, 'kind', v.kind, 'rowVersion', v.row_version));
  v_result := authz.cdoc_result('updated', v) || jsonb_build_object('warnings', to_jsonb(v.warnings));
  return authz.finance_remember(v.legal_entity_id, p_request_id, 'customer_document_refresh', v_payload, v_result);
end;
$$;

create or replace function public.customer_document_release(p_document_id uuid, p_expected_row_version integer, p_expected_content_sha256 text,
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
  v_prefix text;
  v_other text;
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
  -- Accounts phase 2 (20261204000240, L7 review 5): never release with the company GSTIN placeholder.
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

  -- Number (6.3, LD4): the Deal's counter for this kind, locked.
  -- Accounts phase 2 (20261204000240, L7 review 7): the prefix is fixed at the
  -- Deal's first release and kept on its counter rows; another Deal of the
  -- entity holding the same prefix refuses number_conflict.
  select k.prefix into v_prefix from public.customer_document_counters k
  where k.deal_id = v.deal_id and k.prefix is not null order by k.kind limit 1;
  v_prefix := coalesce(v_prefix, authz.cdoc_prefix(v.deal_id));
  select d.reference into v_other
  from public.customer_document_counters k join public.deals d on d.id = k.deal_id
  where k.prefix = v_prefix and k.deal_id <> v.deal_id and d.legal_entity_id = v.legal_entity_id
  limit 1;
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

create or replace function public.customer_document_link_tally(p_document_id uuid, p_tally_invoice_id uuid, p_expected_row_version integer,
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
    perform authz.cdoc_require_same_credits(v, v_build);  -- Accounts phase 2 (20261204000240)
    update public.customer_documents c
    set tally_invoice_id = p_tally_invoice_id, content = v_build -> 'content',
        content_sha256 = authz.finance_payload_hash(v_build -> 'content'), source_hash = authz.cdoc_build_hash(v_build),
        total_paise = (v_build ->> 'totalPaise')::bigint, warnings = array(select jsonb_array_elements_text(v_build -> 'warnings')),
        basis_version_id = nullif(v_build ->> 'basisVersionId', '')::uuid,
        -- Accounts phase 2 (20261204000240, L7 review 6): credits_document_id is never rewritten.
        refreshed_at = now(), row_version = c.row_version + 1, updated_at = now()
    where c.id = v.id returning * into v;
  end if;
  perform authz.write_audit('accounts.customer_document.tally_linked', v.legal_entity_id, v.branch_id, 'customer_document', v.id, null,
    jsonb_build_object('documentId', v.id, 'tallyInvoiceId', v.tally_invoice_id, 'rowVersion', v.row_version));
  return authz.finance_remember(v.legal_entity_id, p_request_id, 'customer_document_link_tally', v_payload, authz.cdoc_result('updated', v));
end;
$$;

-- ===========================================================================
-- 4. R-B3 list (review 3)
-- ===========================================================================

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
                     'from', 'to', 'branchId', 'toRelease') then
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

  -- Accounts phase 2 (20261204000240, review 3): only the conditions asked for.
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
  if v_after_ts is not null then
    v_where := v_where || ' and (coalesce(c.released_at, c.created_at), c.id) < ($15, $16)';
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
    order by coalesce(c.released_at, c.created_at) desc, c.id desc
    limit $17 + 1
  ), numbered as (
    select p.*, row_number() over (order by p.sort_at desc, p.id desc) as rn from page p
  )
  select coalesce(jsonb_agg(
           authz.cdoc_doc_json(x, n.viewer, authz.cdoc_enabled(n.legal_entity_id),
             exists (select 1 from public.customer_billing_profiles bp where bp.deal_id = n.deal_id and bp.status = ''verified''))
           || jsonb_build_object(''dealId'', n.deal_id, ''dealReference'', n.deal_reference, ''branchName'', n.branch_name)
           order by n.rn) filter (where n.rn <= $17), ''[]''::jsonb),
         count(*)::integer,
         max(case when n.rn = $17 then to_char(n.sort_at at time zone ''UTC'', ''YYYY-MM-DD"T"HH24:MI:SS.US"Z"'') || ''|'' || n.id::text end)
  from numbered n
  join public.customer_documents x on x.id = n.id';
  execute v_sql into v_rows, v_count, v_next
    using v_a, v_m, v_syn, v_status, v_kind, v_branch, v_like, v_from, v_to, v_tally, v_to_release, v_reversed, v_pdf, v_changed,
      v_after_ts, v_after_id, v_limit;

  return jsonb_build_object('items', v_rows, 'hasMore', v_count > v_limit,
    'nextAfter', case when v_count > v_limit then v_next end);
end;
$$;

revoke all on function authz.cdoc_require_same_credits(public.customer_documents, jsonb) from public, anon, authenticated, service_role;

commit;
