-- Accounts phase 2, Track B (4 of 4): customer document reads.
-- Contract: implementation/accounts-phase2-2026-11-11/contract.md sections
-- 6.6 (computed flags), 6.9 (R-B1, R-B2, R-B3), 10 (fences), 13
-- (frozen 11 Nov 2026).
--
-- Reads (security definer, stable, execute to authenticated; null when the
-- caller may not read; never a partial object):
--   R-B1 public.deal_customer_documents(p_deal_id)                A, M (Deal branch), SO
--   R-B2 public.customer_document_get(p_document_id)             same fence; {...row, content}
--   R-B3 public.customer_documents_list(p_filter, p_after, p_limit)  A (entity), M (branch, released only, read-only)
-- Managers and Sales owners see released / replaced / cancelled documents
-- only, with can limited to download / printView. Purchase, Flight and Visa
-- never read customer documents (authz.cdoc_viewer).
--
-- pdf.state from the database: none (no job), queued, ready, failed. The
-- application shows "off" for queued while the online PDF maker is off.
--
-- Refusal tokens: 22023 invalid_input (hint = filter key or 'after').
-- Rollback (forward-only): a NEW migration revoking execute on the three reads.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Row JSON
-- ===========================================================================

create function authz.cdoc_pdf_json(p_document uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select case
    when f.id is not null then jsonb_build_object('state', 'ready', 'fileId', f.id)
    when j.status in ('queued', 'running') then jsonb_build_object('state', 'queued', 'fileId', null)
    when j.status = 'failed' then jsonb_build_object('state', 'failed', 'fileId', null)
    else jsonb_build_object('state', 'none', 'fileId', null) end
  from (select 1) one
  left join public.customer_document_files f on f.document_id = p_document
  left join lateral (select j.status from public.customer_document_render_jobs j where j.document_id = p_document
                     order by j.created_at desc, j.id desc limit 1) j on true
$$;

-- One document row of R-B1 / R-B3 for a viewer ('accounts' | 'manager' | 'sales').
create function authz.cdoc_doc_json(p_doc public.customer_documents, p_viewer text, p_enabled boolean, p_billing_verified boolean)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_a boolean := p_viewer = 'accounts';
  v_am boolean := p_viewer in ('accounts', 'manager');
  v_stale boolean := false;
  v_changed boolean := false;
  v_reversed boolean := false;
  v_pdf jsonb := authz.cdoc_pdf_json(p_doc.id);
  v_ended boolean := p_doc.status in ('released', 'replaced', 'cancelled');
  v_exp record;
  v_has_cn boolean;
  v_live_replacement boolean;
  v_replacement_draft boolean;
begin
  if p_doc.status = 'draft' then
    v_stale := authz.cdoc_source_hash(p_doc.id) is distinct from p_doc.source_hash;
  end if;
  if p_doc.kind = 'invoice' and p_doc.status = 'released' then
    select * into v_exp from authz.cdoc_invoice_expected(p_doc.deal_id) x limit 1;
    v_changed := v_exp.version_id is distinct from p_doc.basis_version_id or v_exp.total is distinct from p_doc.total_paise;
  end if;
  if p_doc.kind = 'advance_invoice' then
    v_reversed := not exists (select 1 from public.customer_receipts r where r.id = p_doc.receipt_id and r.status in ('verified', 'cleared'));
  end if;
  v_has_cn := exists (select 1 from public.customer_documents c where c.credits_document_id = p_doc.id and c.status = 'released');
  v_live_replacement := exists (select 1 from public.customer_documents c where c.replaces_document_id = p_doc.id and c.status in ('draft', 'released'));
  v_replacement_draft := exists (select 1 from public.customer_documents c where c.replaces_document_id = p_doc.id and c.status = 'draft');
  return jsonb_build_object(
    'documentId', p_doc.id,
    'kind', p_doc.kind,
    'title', authz.cdoc_title(p_doc.kind),
    'number', p_doc.number,
    'status', p_doc.status,
    'totalPaise', p_doc.total_paise::text,
    'issueDate', to_char(p_doc.issue_date, 'YYYY-MM-DD'),
    'createdAt', p_doc.created_at,
    'releasedAt', p_doc.released_at,
    'releasedByName', case when v_am then authz.finance_name(p_doc.released_by) end,
    'rowVersion', p_doc.row_version,
    'contentSha256', p_doc.content_sha256,
    'stale', v_stale,
    'bookingChangedSinceRelease', v_changed,
    'paymentReversed', v_reversed,
    'pdf', v_pdf,
    'tallyLinked', p_doc.tally_invoice_id is not null,
    'gstInvoiceNumber', (select g.invoice_ref from public.deal_tally_invoices g where g.id = p_doc.tally_invoice_id),
    'replacesNumber', (select r.number from public.customer_documents r where r.id = p_doc.replaces_document_id),
    'replacedByNumber', (select r.number from public.customer_documents r
                         where r.replaces_document_id = p_doc.id and r.status in ('released', 'replaced', 'cancelled')
                         order by r.released_at desc limit 1),
    'endReason', case when v_am then p_doc.end_reason end,
    'warnings', to_jsonb(p_doc.warnings),
    'can', jsonb_build_object(
      'refresh', v_a and p_enabled and p_doc.status = 'draft',
      'release', v_a and p_enabled and p_doc.status = 'draft' and not v_stale and p_billing_verified and not v_reversed,
      'discard', v_a and p_enabled and p_doc.status = 'draft',
      'cancel', v_a and p_enabled and p_doc.status = 'released' and not v_has_cn and not v_replacement_draft,
      'replace', v_a and p_enabled and p_doc.status = 'released' and p_doc.kind in ('advance_invoice', 'invoice') and not v_live_replacement,
      'linkTally', v_a and p_enabled and p_doc.kind in ('invoice', 'credit_note')
                   and (p_doc.status = 'draft' or (p_doc.status = 'released' and p_doc.tally_invoice_id is null)),
      'retryPdf', v_a and p_enabled and p_doc.status = 'released' and v_pdf ->> 'state' = 'failed',
      'download', p_enabled and v_ended and v_pdf ->> 'state' = 'ready',
      'printView', v_ended));
end;
$$;

-- ===========================================================================
-- 2. R-B1 deal_customer_documents
-- ===========================================================================

create function public.deal_customer_documents(p_deal_id uuid) returns jsonb
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
           order by coalesce(c.released_at, c.created_at) desc, c.id desc), '[]'::jsonb)
    into v_docs
  from public.customer_documents c
  where c.deal_id = v_deal.id
    and (v_viewer = 'accounts' or c.status in ('released', 'replaced', 'cancelled'));

  return jsonb_build_object(
    'dealId', v_deal.id,
    'viewer', v_viewer,
    'enabled', v_enabled,
    'billing', jsonb_build_object('verified', v_verified, 'missing', v_billing.deal_id is null),
    'candidates', v_candidates,
    'documents', v_docs);
end;
$$;

-- ===========================================================================
-- 3. R-B2 customer_document_get
-- ===========================================================================

create function public.customer_document_get(p_document_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v public.customer_documents%rowtype;
  v_viewer text;
  v_verified boolean;
begin
  if p_document_id is null then
    return null;
  end if;
  select * into v from public.customer_documents c where c.id = p_document_id;
  if v.id is null then
    return null;
  end if;
  v_viewer := authz.cdoc_viewer(v.deal_id);
  if v_viewer is null or (v_viewer <> 'accounts' and v.status not in ('released', 'replaced', 'cancelled')) then
    return null;
  end if;
  v_verified := exists (select 1 from public.customer_billing_profiles b where b.deal_id = v.deal_id and b.status = 'verified');
  return authz.cdoc_doc_json(v, v_viewer, authz.cdoc_enabled(v.legal_entity_id), v_verified)
    || jsonb_build_object('dealId', v.deal_id, 'viewer', v_viewer, 'content', v.content);
end;
$$;

-- ===========================================================================
-- 4. R-B3 customer_documents_list
-- ===========================================================================

create function public.customer_documents_list(p_filter jsonb, p_after text default null, p_limit integer default 50) returns jsonb
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
  v_from date;
  v_to date;
  v_branch uuid;
  v_to_release boolean;
  v_after_ts timestamptz;
  v_after_id uuid;
  v_key text;
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

  with page as (
    select c.id, c.legal_entity_id, c.deal_id, d.reference as deal_reference, b.name as branch_name,
      case when c.legal_entity_id = any(v_a) then 'accounts' else 'manager' end as viewer,
      coalesce(c.released_at, c.created_at) as sort_at
    from public.customer_documents c
    join public.deals d on d.id = c.deal_id
    join public.branches b on b.id = c.branch_id
    where d.is_synthetic = v_syn
      and (c.legal_entity_id = any(v_a)
           or (c.branch_id = any(v_m) and c.status in ('released', 'replaced', 'cancelled')))
      and (v_status is null or c.status = any(v_status))
      and (v_kind is null or c.kind = any(v_kind))
      and (v_branch is null or c.branch_id = v_branch)
      and (v_ref is null or lower(d.reference) like replace(replace(replace(lower(v_ref), '\', '\\'), '%', '\%'), '_', '\_') || '%')
      and (v_from is null or c.issue_date >= v_from)
      and (v_to is null or c.issue_date <= v_to)
      and (v_tally is null or (c.tally_invoice_id is not null) = v_tally)
      and (v_to_release is null or (c.status = 'draft') = v_to_release)
      and (v_reversed is null or (c.kind = 'advance_invoice' and not exists (
             select 1 from public.customer_receipts r where r.id = c.receipt_id and r.status in ('verified', 'cleared'))) = v_reversed)
      and (v_pdf is null or (authz.cdoc_pdf_json(c.id) ->> 'state') = v_pdf)
      and (v_stale is null or (c.status = 'draft' and authz.cdoc_source_hash(c.id) is distinct from c.source_hash) = v_stale)
      and (v_changed is null or (c.kind = 'invoice' and c.status = 'released' and exists (
             select 1 from authz.cdoc_invoice_expected(c.deal_id) x
             where x.version_id is distinct from c.basis_version_id or x.total is distinct from c.total_paise)) = v_changed)
      and (v_after_ts is null or (coalesce(c.released_at, c.created_at), c.id) < (v_after_ts, v_after_id))
    order by coalesce(c.released_at, c.created_at) desc, c.id desc
    limit v_limit + 1
  ), numbered as (
    select p.*, row_number() over (order by p.sort_at desc, p.id desc) as rn from page p
  )
  select coalesce(jsonb_agg(
           authz.cdoc_doc_json(x,
             n.viewer, authz.cdoc_enabled(n.legal_entity_id),
             exists (select 1 from public.customer_billing_profiles bp where bp.deal_id = n.deal_id and bp.status = 'verified'))
           || jsonb_build_object('dealId', n.deal_id, 'dealReference', n.deal_reference, 'branchName', n.branch_name)
           order by n.rn) filter (where n.rn <= v_limit), '[]'::jsonb),
         count(*),
         max(case when n.rn = v_limit then to_char(n.sort_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || n.id::text end)
    into v_rows, v_count, v_next
  from numbered n
  join public.customer_documents x on x.id = n.id;

  return jsonb_build_object('items', v_rows, 'hasMore', v_count > v_limit,
    'nextAfter', case when v_count > v_limit then v_next end);
end;
$$;

-- ===========================================================================
-- 5. Grants
-- ===========================================================================

revoke all on function authz.cdoc_pdf_json(uuid), authz.cdoc_doc_json(public.customer_documents, text, boolean, boolean)
  from public, anon, authenticated, service_role;
revoke all on function
  public.deal_customer_documents(uuid),
  public.customer_document_get(uuid),
  public.customer_documents_list(jsonb, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function
  public.deal_customer_documents(uuid),
  public.customer_document_get(uuid),
  public.customer_documents_list(jsonb, text, integer)
  to authenticated;

commit;
