-- TripNavigate CRM - Direction A Batch 1, item B1-2: one combined list of the
-- files on a Deal that the caller may open (Deal page, Documents tab, FP-025).
--
-- Contract: docs/implementation/frontend-redesign-2026-10-15/batch-1-backend-contract.md
-- item B1-2 with the Echo rulings M3 (kind booking_file with evidenceKind),
-- L4 (removed Deals: removed_at is null inside the read, not the volatile
-- refuse_removed_deal) and L5 (every rendered itinerary PDF row counts).
--
-- What changes: one new read, public.deal_documents_list(p_deal_id uuid), and
-- the internal helper authz.deal_row_visible(p_deal) (exactly the deals read
-- policies scoped_read and hide_removed, 20261107000100; also used by
-- public.record_staff_names in 20261121000130). No table, policy, grant or
-- download handler changes.
--
-- Rule: a file is listed exactly when the caller passes the predicate of that
-- file kind's EXISTING download authorizer and the file is stored, so the list
-- equals what each role can download today (no new exposure, no new hiding):
--   id_proof              traveller_id_proofs        authz.id_proof_viewer_role(deal) is not null
--                                                     (traveller_id_proof_authorize_download, 20261120000100)
--   booking_file          booking_evidence           authz.can_read_booking_evidence(deal)
--                                                     (booking_authorize_evidence_download, 20261004000100)
--   quotation_acceptance  quotation_evidence         authz.quotation_can_edit(quotation), quotation of the Deal
--                                                     (quotation_evidence_authorize_download, 20261120000200)
--   itinerary_source      itinerary_source_files     authz.itinerary_can_edit(document), document of the Deal
--                                                     (itinerary_source_authorize_download, 20261120000500)
--   itinerary_pdf         itinerary_rendered_documents  authz.itinerary_can_edit(document)
--                                                     (itinerary_rendered_authorize_download; no status test there)
--   purchase_file         purchase_evidence          authz.can_read_purchase_workspace(task)
--                                                     (purchase_evidence_authorize_download, 20261005000100/0200)
--   department_file       department_evidence        authz.can_read_department_task(task) only
--                                                     (department_evidence_authorize_download task branch; its
--                                                     Accounts expense branch is NOT used: Accounts read those
--                                                     files on their own pages)
-- Excluded on purpose: finance_evidence (customer payment proof, deposit
-- slips): Accounts pages only.
--
-- First gate (Echo M1): the Deal must be readable to the caller under the
-- deals read policy (authz.deal_row_visible). Some download predicates are
-- entity-wide (Purchase workspace, department tasks, the Accounts branch of
-- the ID-proof rule), so without this gate a caller could list files of a
-- Deal they cannot open. A removed Deal, a Deal the caller cannot read, an
-- unknown id and a Deal without files all answer {files: []} (not an
-- existence oracle). The tab exists only on a Deal the page shows, so the
-- gate hides nothing the page shows.
--
-- DTO allowlist per row: kind, id, fileName, mime, uploadedAt, context.
-- context keys per kind: id_proof {travellerSeq}; booking_file {versionNo,
-- evidenceKind}; quotation_acceptance {quotationReference, versionNo,
-- evidenceKind}; itinerary_source {documentId}; itinerary_pdf {pdfKind,
-- documentId}; purchase_file {department, fileKind}; department_file
-- {department, fileKind}. Never object_path, uploader or consent identities,
-- hashes, sizes or amounts.
--
-- The read writes nothing (stable; no audit row; no row version change).
-- Downloads keep their own audited handlers.
--
-- Rollback (forward-only): a new migration revoking execute on
-- public.deal_documents_list(uuid); the application then hides the tab.
--
-- Apply history: this file has run only on disposable local and CI stacks.
-- It was amended in place on 19 October 2026 after the Echo-A review
-- (echo-redesign-batch1-data.md: M1, L1-L3, L5, L7) before any kept or live
-- database applied it.

begin;
set local lock_timeout = '15s';

-- Copies the deals read policies (scoped_read and the restrictive hide_removed,
-- 20261107000100) exactly; keep in step with any later policy change. A
-- database test holds it equal to the policy for every role fixture.
create function authz.deal_row_visible(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and exists (
    select 1 from public.deals d
    where d.id = p_deal
      and d.removed_at is null
      and (
        d.legal_entity_id = any (authz.my_permission_entities('deal.read', 'entity'))
        or (
          d.legal_entity_id = any (authz.my_permission_entities('deal.read', 'own'))
          and (d.owner_user_id = (select auth.uid()) or d.id = any (authz.my_assigned_deal_ids()))
        )
        or (
          d.owner_user_id is not null
          and (
            d.legal_entity_id = any (authz.my_grant_entities('deal.read'))
            or d.branch_id = any (authz.my_grant_branches('deal.read'))
          )
        )
      )
  )
$$;
revoke all on function authz.deal_row_visible(uuid) from public, anon, authenticated, service_role;

create function public.deal_documents_list(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_id_proofs boolean;
  v_booking boolean;
  v_files jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id and d.removed_at is null;
  -- Echo M1: only a Deal the caller can open under the deals read policy.
  if v_deal.id is null or not authz.deal_row_visible(v_deal.id) then
    return jsonb_build_object('files', '[]'::jsonb);
  end if;
  -- Deal-level predicates are evaluated once per Deal.
  v_id_proofs := authz.id_proof_viewer_role(v_deal.id) is not null;
  v_booking := coalesce(authz.can_read_booking_evidence(v_deal.id), false);

  with quotes as (
    select q.id, q.reference from public.quotations q
    where (q.deal_id = v_deal.id or (q.deal_id is null and q.linked_deal_id = v_deal.id))
  ), editable_quotes as (
    select q.id, q.reference from quotes q where authz.quotation_can_edit(q.id)
  ), docs as (
    select doc.id from public.itinerary_documents doc
    where doc.deal_id = v_deal.id
       or (doc.deal_id is null and doc.quotation_id in (select q.id from quotes q))
  ), editable_docs as (
    select doc.id from docs doc where authz.itinerary_can_edit(doc.id)
  ), tasks as (
    select t.id, t.department from public.fulfilment_tasks t where t.deal_id = v_deal.id
  ), purchase_tasks as (
    select t.id from tasks t where authz.can_read_purchase_workspace(t.id)
  ), department_tasks as (
    select t.id, t.department from tasks t where authz.can_read_department_task(t.id)
  ), files as (
    select 'id_proof'::text as kind, f.id, f.file_name as file_name, f.mime, coalesce(f.stored_at, f.created_at) as uploaded_at,
           jsonb_build_object('travellerSeq',
             coalesce((select t.seq from public.deal_travellers t where t.id = f.traveller_id), f.traveller_seq)) as context
    from public.traveller_id_proofs f
    where v_id_proofs and f.legal_entity_id = v_deal.legal_entity_id and f.deal_id = v_deal.id and f.status = 'stored'
    union all
    select 'booking_file', e.id, e.file_name, e.mime, coalesce(e.stored_at, e.created_at),
           jsonb_build_object('versionNo', (select v.version_no from public.booking_versions v where v.id = e.version_id),
                              'evidenceKind', e.kind)
    from public.booking_evidence e
    where v_booking and e.deal_id = v_deal.id and e.status = 'stored'
    union all
    select 'quotation_acceptance', e.id, e.file_name, e.mime, coalesce(e.stored_at, e.created_at),
           jsonb_build_object('quotationReference', q.reference,
                              'versionNo', (select v.version_no from public.quotation_versions v where v.id = e.quotation_version_id),
                              'evidenceKind', e.kind)
    from editable_quotes q
    join public.quotation_evidence e on e.quotation_id = q.id
    where e.status = 'stored'
    union all
    select 'itinerary_source', s.id, s.file_name, s.mime, coalesce(s.stored_at, s.created_at),
           jsonb_build_object('documentId', s.document_id)
    from editable_docs doc
    join public.itinerary_source_files s on s.document_id = doc.id
    where s.status = 'stored'
    union all
    -- Same generated name as itinerary_rendered_authorize_download.
    select 'itinerary_pdf', r.id,
           'itinerary-' || r.kind || '-' || to_char(r.created_at at time zone 'Asia/Kolkata', 'YYYYMMDD') || '.pdf',
           'application/pdf', r.created_at,
           jsonb_build_object('pdfKind', r.kind, 'documentId', r.document_id)
    from editable_docs doc
    join public.itinerary_rendered_documents r on r.document_id = doc.id
    union all
    select 'purchase_file', e.id, e.file_name, e.mime, coalesce(e.stored_at, e.created_at),
           jsonb_build_object('department', 'purchase', 'fileKind', e.kind)
    from purchase_tasks t
    join public.purchase_evidence e on e.task_id = t.id
    where e.status = 'stored'
    union all
    select 'department_file', e.id, e.file_name, e.mime, coalesce(e.stored_at, e.created_at),
           jsonb_build_object('department', t.department, 'fileKind', e.kind)
    from department_tasks t
    join public.department_evidence e on e.task_id = t.id
    where e.status = 'stored'
  )
  select coalesce(jsonb_agg(jsonb_build_object('kind', f.kind, 'id', f.id, 'fileName', f.file_name, 'mime', f.mime,
                                               'uploadedAt', f.uploaded_at, 'context', f.context)
                            order by f.uploaded_at desc, f.kind, f.id), '[]'::jsonb)
  into v_files
  from files f;
  return jsonb_build_object('files', v_files);
end;
$$;

comment on function public.deal_documents_list(uuid) is
  'Direction A B1-2: files on a Deal the caller may open, each kind gated by the exact predicate of its existing download authorizer; removed, unreadable and unknown Deals answer {files: []}. Reads only; downloads keep their own audited handlers.';

revoke all on function public.deal_documents_list(uuid) from public, anon, authenticated, service_role;
grant execute on function public.deal_documents_list(uuid) to authenticated;

commit;
