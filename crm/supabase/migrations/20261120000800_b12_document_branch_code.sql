-- TripNavigate CRM - B1.2 (DEC-50): branch code on the quotation and
-- itinerary document reads, so the printed company identity can show the
-- GSTIN of the right branch.
--
-- What changes (reads only; no table, data, grant or authorization change):
--   * public.quotation_get: subject.branchCode = branches.code of
--     quotations.branch_id. The column is set from the Lead or Deal at
--     creation and can never change (authz.quotations_guard), so a Lead
--     quotation keeps its own branch after it is linked to a Deal.
--   * public.itinerary_document_get: subject.branchCode = branches.code of
--     itinerary_documents.branch_id (copied from the Deal or quotation at
--     creation; the row is immutable).
--   * public.itinerary_render_input (render worker, service_role):
--     top-level branchCode from the SAME column as itinerary_document_get,
--     so a final itinerary's content hash is identical whether the staff
--     request or the worker computes it.
--   A missing branch gives null; the reads never fail on it. Branch code is
--   not commercial data: who may call each read is unchanged.
--
-- Bodies are exact copies of the latest definitions with only the branchCode
-- key added: quotation_get from 20261120000600_b12_prefill;
-- itinerary_document_get and itinerary_render_input from
-- 20261120000500_b12_itineraries. Any later migration that replaces one of
-- them must copy the bodies in THIS file.
--
-- Rollback (forward-only): a NEW migration restores the three bodies from the
-- files named above. Nothing else to undo.

begin;
set local lock_timeout = '15s';

create or replace function public.quotation_get(p_version_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_ver public.quotation_versions;
  v_q public.quotations;
  v_result jsonb;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_ver from public.quotation_versions v where v.id = p_version_id;
  select * into v_q from public.quotations q where q.id = v_ver.quotation_id;
  if v_q.id is null or not authz.quotation_can_edit(v_q.id) or authz.quotation_deal_removed(v_q.id) then
    return null;
  end if;
  v_result := jsonb_build_object(
    'quotationId', v_q.id, 'reference', v_q.reference, 'title', v_q.title, 'rowVersion', v_q.row_version,
    'subject', jsonb_build_object('kind', case when v_q.lead_id is not null then 'lead' else 'deal' end,
      'leadId', v_q.lead_id, 'dealId', v_q.deal_id, 'linkedDealId', v_q.linked_deal_id,
      -- B1.2 0800 (DEC-50): the quotation's own branch (quotations.branch_id, fixed at creation).
      'branchCode', (select b.code from public.branches b where b.id = v_q.branch_id),
      'reference', coalesce((select l.reference from public.crm_leads l where l.id = v_q.lead_id),
                            (select d.reference from public.deals d where d.id = v_q.deal_id)),
      'title', coalesce((select l.title from public.crm_leads l where l.id = v_q.lead_id),
                        (select d.title from public.deals d where d.id = v_q.deal_id))),
    'version', authz.quotation_version_json(v_ver),
    'trip', jsonb_build_object('destination', v_ver.trip_destination, 'scope', v_ver.trip_scope,
      'start', to_char(v_ver.trip_start, 'YYYY-MM-DD'), 'end', to_char(v_ver.trip_end, 'YYYY-MM-DD')),
    'pax', jsonb_build_object('adults', v_ver.adults, 'childrenWithBed', v_ver.children_with_bed,
      'childrenNoBed', v_ver.children_no_bed, 'infants', v_ver.infants, 'remarks', v_ver.pax_remarks),
    'requirementsNote', v_ver.requirements_note,
    'content', v_ver.content,
    'tiers', coalesce((select jsonb_agg(jsonb_build_object('tierKey', t.tier_key, 'label', t.label) order by t.tier_key)
                       from public.quotation_version_tiers t where t.quotation_version_id = v_ver.id), '[]'::jsonb),
    'items', coalesce((select jsonb_agg(jsonb_build_object('itemId', i.id, 'itemNo', i.item_no, 'serviceType', i.service_type,
                         'tierKey', i.tier_key,
                         'title', coalesce(nullif(authz.service_item_title(i.service_type, i.facts), ''), initcap(i.service_type)),
                         'facts', i.facts,
                         'factsValid', cardinality(authz.validate_service_facts(i.service_type, i.facts)) = 0) order by i.item_no)
                       from public.quotation_version_items i where i.quotation_version_id = v_ver.id), '[]'::jsonb),
    'contacts', (select jsonb_build_object('contactName', c.contact_name, 'mobile', c.mobile, 'email', c.email,
                   'companyName', c.company_name, 'bookingFor', c.booking_for)
                 from public.quotation_version_contacts c where c.quotation_version_id = v_ver.id),
    'evidence', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'fileName', e.file_name, 'mime', e.mime,
                            'sizeBytes', e.size_bytes, 'status', e.status, 'createdAt', e.created_at, 'storedAt', e.stored_at,
                            'uploadedByYou', e.uploaded_by = (select auth.uid())) order by e.created_at, e.id)
                          from public.quotation_evidence e where e.quotation_version_id = v_ver.id and e.status <> 'removed'), '[]'::jsonb),
    'issues', case when v_ver.status = 'draft' then to_jsonb(authz.quotation_issues(v_ver.id)) else '[]'::jsonb end,
    'canEdit', v_ver.status in ('draft', 'ready') and v_q.converted_at is null,
    'conversion', (select jsonb_build_object('bookingVersionId', c.booking_version_id, 'dealId', c.deal_id, 'createdAt', c.created_at)
                   from public.quotation_conversions c where c.quotation_version_id = v_ver.id));
  -- B1.2 0600: Bitrix values of the quotation's Deal or Lead (DEC-36); the caller is an editor.
  v_result := v_result || jsonb_build_object('prefill',
    authz.prefill_view(case when v_q.deal_id is not null then 'deal' else 'lead' end, coalesce(v_q.deal_id, v_q.lead_id),
      'quotation_version', v_ver.id, authz.quotation_money_can_read(v_q.id))
    || jsonb_build_object('unchecked', coalesce((select jsonb_agg(m.field_code order by m.field_code) from public.prefill_marks m
         where m.target_kind = 'quotation_version' and m.target_id = v_ver.id and m.state = 'from_bitrix'), '[]'::jsonb)));
  if authz.quotation_money_can_read(v_q.id) then
    v_result := v_result || jsonb_build_object('money', authz.quotation_money_json(v_ver.id));
  end if;
  return v_result;
end;
$$;

create or replace function public.itinerary_document_get(p_document_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_doc public.itinerary_documents;
  v_draft public.itinerary_fact_drafts;
  v_run public.itinerary_difference_runs;
  v_latest public.itinerary_difference_runs;
begin
  if not authz.session_ok() then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_doc from public.itinerary_documents d where d.id = p_document_id;
  if v_doc.id is null or not authz.itinerary_can_edit(v_doc.id)
     or exists (select 1 from public.deals d where d.id = authz.itinerary_deal(v_doc.id) and d.removed_at is not null) then
    return null;
  end if;
  select * into v_draft from public.itinerary_fact_drafts f where f.document_id = v_doc.id;
  v_run := authz.itinerary_current_run(v_draft.id);
  select * into v_latest from public.itinerary_difference_runs r where r.draft_id = v_draft.id
  order by r.created_at desc, r.id desc limit 1;
  return jsonb_build_object(
    'documentId', v_doc.id, 'title', v_doc.title,
    'subject', jsonb_build_object('kind', case when v_doc.quotation_id is not null then 'quotation' else 'deal' end,
      'quotationId', v_doc.quotation_id, 'dealId', coalesce(v_doc.deal_id, authz.quotation_deal(v_doc.quotation_id)),
      -- B1.2 0800 (DEC-50): the document's own branch (itinerary_documents.branch_id, immutable);
      -- itinerary_render_input reads the same column.
      'branchCode', (select b.code from public.branches b where b.id = v_doc.branch_id)),
    'draft', jsonb_build_object('draftId', v_draft.id, 'status', v_draft.status, 'rowVersion', v_draft.row_version,
      'facts', v_draft.facts, 'factsHash', v_draft.facts_hash, 'sourceFileId', v_draft.source_file_id, 'updatedAt', v_draft.updated_at),
    'basis', authz.itinerary_basis(v_doc.id),
    -- DEC-48: the customer prices printed on the itinerary, for callers who may read them.
    'money', case when authz.itinerary_money_reader(v_doc.id) then authz.itinerary_money_json(authz.itinerary_basis(v_doc.id)) end,
    'differences', jsonb_build_object('runId', coalesce(v_run.id, v_latest.id), 'current', v_run.id is not null,
      'items', coalesce((select jsonb_agg(jsonb_build_object('differenceId', d.id, 'path', d.field_path, 'kind', d.difference,
                'acknowledged', d.acknowledged_at is not null,
                'acknowledgedByName', (select p.display_name from public.staff_profiles p where p.user_id = d.acknowledged_by),
                'acknowledgedAt', d.acknowledged_at, 'note', d.note) order by d.field_path, d.difference)
              from public.itinerary_fact_differences d where d.run_id = coalesce(v_run.id, v_latest.id)), '[]'::jsonb)),
    'sources', coalesce((select jsonb_agg(jsonb_build_object('fileId', s.id, 'fileName', s.file_name, 'mime', s.mime,
                'sizeBytes', s.size_bytes, 'status', s.status, 'createdAt', s.created_at) order by s.created_at, s.id)
              from public.itinerary_source_files s where s.document_id = v_doc.id and s.status <> 'removed'), '[]'::jsonb),
    'jobs', coalesce((select jsonb_agg(x.j order by x.created_at desc) from (
                select jsonb_build_object('jobId', j.id, 'kind', j.kind, 'status', j.status, 'attempts', j.attempts,
                  'lastErrorCode', j.last_error_code, 'createdAt', j.created_at, 'finishedAt', j.finished_at) as j, j.created_at
                from public.itinerary_render_jobs j where j.document_id = v_doc.id order by j.created_at desc limit 20) x), '[]'::jsonb),
    'rendered', coalesce((select jsonb_agg(jsonb_build_object('renderedId', r.id, 'kind', r.kind, 'pageCount', r.page_count,
                'sizeBytes', r.size_bytes, 'createdAt', r.created_at, 'qa', r.qa) order by r.created_at desc)
              from public.itinerary_rendered_documents r where r.document_id = v_doc.id), '[]'::jsonb));
end;
$$;

create or replace function public.itinerary_render_input(p_job_id uuid, p_worker text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.itinerary_render_jobs;
  v_draft public.itinerary_fact_drafts;
  v_basis jsonb;
begin
  select * into v_job from public.itinerary_render_jobs j where j.id = p_job_id for update;
  if v_job.id is null or v_job.status <> 'running' or v_job.lease_owner is distinct from p_worker or v_job.lease_until < now() then
    raise exception 'task_conflict' using errcode = '40001';
  end if;
  if authz.itinerary_fail_changed_final(v_job) then
    return jsonb_build_object('jobId', v_job.id, 'status', 'failed', 'errorCode', 'input_changed');
  end if;
  select * into v_draft from public.itinerary_fact_drafts f where f.document_id = v_job.document_id;
  v_basis := authz.itinerary_basis(v_job.document_id);
  return jsonb_build_object('jobId', v_job.id, 'status', 'running', 'documentId', v_job.document_id, 'kind', v_job.kind,
    'templateVersion', v_job.template_version, 'inputHash', v_job.input_hash,
    'factsHash', v_draft.facts_hash, 'factsChanged', v_draft.facts_hash <> v_job.facts_hash,
    'basisChanged', (v_basis ->> 'hash') <> v_job.basis_hash,
    'facts', v_draft.facts,
    'title', (select d.title from public.itinerary_documents d where d.id = v_job.document_id),
    -- B1.2 0800 (DEC-50): same source as itinerary_document_get subject.branchCode.
    'branchCode', (select b.code from public.itinerary_documents d join public.branches b on b.id = d.branch_id
                   where d.id = v_job.document_id),
    'basis', v_basis,
    -- DEC-48: customer prices only when the requester could read them.
    'money', case when v_job.include_money then authz.itinerary_money_json(v_basis) end);
end;
$$;

-- Grants exactly as before (create or replace keeps them; restated for clarity).
revoke all on function
  public.quotation_get(uuid),
  public.itinerary_document_get(uuid),
  public.itinerary_render_input(uuid, text)
from public, anon, authenticated, service_role;

grant execute on function
  public.quotation_get(uuid),
  public.itinerary_document_get(uuid)
to authenticated;

grant execute on function
  public.itinerary_render_input(uuid, text)
to service_role;

commit;
