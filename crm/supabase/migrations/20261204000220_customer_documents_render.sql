-- Accounts phase 2, Track B (3 of 4): customer document PDF jobs, retry and
-- download authorisation.
-- Contract: implementation/accounts-phase2-2026-11-11/contract.md sections
-- 6.2, 6.7 (B8, B10, worker commands), 6.8 (LD2), 10, Addendum L5
-- (frozen 11 Nov 2026).
--
-- Worker commands (service_role only; never executable by authenticated):
--   public.customer_document_render_claim(p_worker, p_lease_seconds)
--   public.customer_document_render_input(p_job_id, p_worker)
--       -> {status 'running', jobId, documentId, templateVersion, contentSha256, content, objectPath}
--          or {status 'failed', errorCode 'content_changed'}; task_conflict without the live lease
--   public.customer_document_render_complete(p_job_id, p_worker, p_ok, p_error_code, p_file)
--       p_file {objectPath, sha256, sizeBytes, pageCount}; stores customer_document_files;
--       never changes the document's content.
-- Commands (authenticated):
--   B8  public.customer_document_render_retry(p_document_id, p_request_id)    Accounts of the entity
--   B10 public.customer_document_authorize_download(p_document_id)            A, M (Deal branch), SO
-- Helper: authz.cdoc_viewer(p_deal) -> 'accounts' | 'manager' | 'sales' | null
-- (contract 4 readers; Purchase, Flight and Visa never; synthetic flag by
-- environment as Phase 1).
--
-- Refusal tokens: 42501 not_authorized | P0002 not_found | 40001
-- task_conflict, request_conflict | 22023 invalid_input (hint) | 55000
-- documents_off, wrong_state, environment_unset, not_configured.
-- Audit: accounts.customer_document.render_retried,
-- accounts.customer_document.downloaded (one row per download).
--
-- Rollback (forward-only): a NEW migration revoking execute on these functions.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Readers
-- ===========================================================================

create function authz.cdoc_viewer(p_deal uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_syn boolean;
begin
  if p_deal is null or not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v_deal from public.deals d where d.id = p_deal;
  v_syn := authz.acct_synthetic();
  if v_deal.id is null or v_syn is null or v_deal.is_synthetic is distinct from v_syn then
    return null;
  end if;
  if v_deal.legal_entity_id = any(authz.acct_a_entities()) then
    return 'accounts';
  end if;
  if v_deal.branch_id = any(authz.acct_m_branches()) then
    return 'manager';
  end if;
  if v_deal.owner_user_id = (select auth.uid())
     and authz.holds_active_role('sales', v_deal.legal_entity_id)
     and authz.finance_enabled(v_deal.legal_entity_id)
     and authz.finance_gate_issue(v_deal.legal_entity_id, v_deal.is_synthetic) is null
     and not exists (select 1 from public.memberships m
                     where m.user_id = (select auth.uid()) and m.legal_entity_id = v_deal.legal_entity_id
                       and m.role_code in ('purchase', 'flight', 'visa') and m.status = 'active') then
    return 'sales';
  end if;
  return null;
end;
$$;

create function authz.cdoc_object_path(p_entity uuid, p_document uuid, p_job uuid) returns text
language sql immutable set search_path = '' as $$
  select p_entity::text || '/customer-documents/' || p_document::text || '/' || p_job::text || '.pdf'
$$;

-- ===========================================================================
-- 2. Worker commands (service_role)
-- ===========================================================================

create function public.customer_document_render_claim(p_worker text, p_lease_seconds integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.customer_document_render_jobs%rowtype;
begin
  if p_worker is null or length(p_worker) not between 1 and 60 or p_lease_seconds is null or p_lease_seconds not between 10 and 600 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'worker';
  end if;
  -- A running job whose lease expired on its last attempt fails (lease_expired).
  update public.customer_document_render_jobs j
  set status = 'failed', last_error_code = 'lease_expired', lease_owner = null, lease_until = null, finished_at = now()
  where j.status = 'running' and j.lease_until < now() and j.attempts >= j.max_attempts;
  select * into v_job from public.customer_document_render_jobs j
  where ((j.status = 'queued' and j.available_at <= now()) or (j.status = 'running' and j.lease_until < now()))
    and j.attempts < j.max_attempts
  order by j.available_at, j.created_at
  for update skip locked
  limit 1;
  if v_job.id is null then
    return null;
  end if;
  update public.customer_document_render_jobs j
  set status = 'running', attempts = j.attempts + 1, lease_owner = p_worker,
      lease_until = now() + make_interval(secs => p_lease_seconds), started_at = coalesce(j.started_at, now())
  where j.id = v_job.id returning * into v_job;
  return jsonb_build_object('jobId', v_job.id, 'documentId', v_job.document_id, 'contentSha256', v_job.content_sha256,
    'templateVersion', v_job.template_version, 'attempts', v_job.attempts, 'legalEntityId', v_job.legal_entity_id,
    'objectPath', authz.cdoc_object_path(v_job.legal_entity_id, v_job.document_id, v_job.id));
end;
$$;

create function public.customer_document_render_input(p_job_id uuid, p_worker text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.customer_document_render_jobs%rowtype;
  v_doc public.customer_documents%rowtype;
begin
  select * into v_job from public.customer_document_render_jobs j where j.id = p_job_id for update;
  if v_job.id is null or v_job.status <> 'running' or v_job.lease_owner is distinct from p_worker or v_job.lease_until < now() then
    raise exception 'task_conflict' using errcode = '40001';
  end if;
  select * into v_doc from public.customer_documents c where c.id = v_job.document_id;
  if v_doc.content_sha256 is distinct from v_job.content_sha256 or v_doc.status not in ('released', 'replaced', 'cancelled') then
    update public.customer_document_render_jobs j
    set status = 'failed', last_error_code = 'content_changed', lease_owner = null, lease_until = null, finished_at = now()
    where j.id = v_job.id;
    return jsonb_build_object('jobId', v_job.id, 'status', 'failed', 'errorCode', 'content_changed');
  end if;
  return jsonb_build_object('jobId', v_job.id, 'status', 'running', 'documentId', v_doc.id, 'templateVersion', v_job.template_version,
    'contentSha256', v_job.content_sha256, 'content', v_doc.content,
    'objectPath', authz.cdoc_object_path(v_job.legal_entity_id, v_job.document_id, v_job.id));
end;
$$;

create function public.customer_document_render_complete(p_job_id uuid, p_worker text, p_ok boolean, p_error_code text, p_file jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.customer_document_render_jobs%rowtype;
  v_path text;
  v_size bigint;
  v_file uuid;
  v_code text := p_error_code;
  v_ok boolean := p_ok;
  v_status text;
begin
  select * into v_job from public.customer_document_render_jobs j where j.id = p_job_id for update;
  if v_job.id is null or v_job.status <> 'running' or v_job.lease_owner is distinct from p_worker then
    raise exception 'task_conflict' using errcode = '40001';
  end if;
  if v_ok is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'ok';
  end if;
  if v_ok then
    v_path := authz.cdoc_object_path(v_job.legal_entity_id, v_job.document_id, v_job.id);
    if p_file is null or jsonb_typeof(p_file) <> 'object'
       or exists (select 1 from jsonb_object_keys(p_file) k where k not in ('objectPath', 'sha256', 'sizeBytes', 'pageCount'))
       or (p_file ->> 'objectPath') is distinct from v_path
       or coalesce(p_file ->> 'sha256', '') !~ '^[0-9a-f]{64}$'
       or not authz.sf_int_ok(p_file -> 'sizeBytes', 1, 15728640, true)
       or not authz.sf_int_ok(p_file -> 'pageCount', 1, 50, true) then
      raise exception 'invalid_input' using errcode = '22023', hint = 'file';
    end if;
    v_size := (p_file ->> 'sizeBytes')::bigint;
    if to_regclass('storage.objects') is null or not exists (
         select 1 from storage.objects o
         where o.bucket_id = 'rendered-documents' and o.name = v_path
           and (o.metadata ->> 'size') ~ '^[0-9]{1,18}$' and (o.metadata ->> 'size')::bigint = v_size) then
      v_ok := false;
      v_code := 'upload_failed';
    else
      insert into public.customer_document_files (legal_entity_id, document_id, render_job_id, object_path, sha256, size_bytes, page_count)
      values (v_job.legal_entity_id, v_job.document_id, v_job.id, v_path, p_file ->> 'sha256', v_size::integer,
        (p_file ->> 'pageCount')::integer)
      returning id into v_file;
      update public.customer_document_render_jobs j
      set status = 'succeeded', lease_owner = null, lease_until = null, finished_at = now(), last_error_code = null
      where j.id = v_job.id;
      return jsonb_build_object('jobId', v_job.id, 'status', 'succeeded', 'fileId', v_file);
    end if;
  end if;
  if v_code is null or v_code not in ('render_timeout', 'browser_failed', 'asset_missing', 'input_invalid', 'upload_failed',
                                      'internal', 'content_safety', 'layout_overflow', 'placeholders_present', 'text_clipped',
                                      'qa_blocked') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'errorCode';
  end if;
  -- Deterministic failures end the job at once; transient ones go back to the
  -- queue while attempts remain (at most 3).
  if v_job.attempts < v_job.max_attempts
     and v_code not in ('placeholders_present', 'content_safety', 'input_invalid', 'layout_overflow', 'text_clipped',
                        'qa_blocked', 'asset_missing') then
    update public.customer_document_render_jobs j
    set status = 'queued', last_error_code = v_code, lease_owner = null, lease_until = null,
        available_at = now() + make_interval(secs => 30 * v_job.attempts)
    where j.id = v_job.id returning j.status into v_status;
  else
    update public.customer_document_render_jobs j
    set status = 'failed', last_error_code = v_code, lease_owner = null, lease_until = null, finished_at = now()
    where j.id = v_job.id returning j.status into v_status;
  end if;
  return jsonb_build_object('jobId', v_job.id, 'status', v_status, 'fileId', null, 'errorCode', v_code);
end;
$$;

-- ===========================================================================
-- 3. B8 retry and B10 download
-- ===========================================================================

create function public.customer_document_render_retry(p_document_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.customer_documents%rowtype;
  v_payload jsonb := jsonb_build_object('documentId', p_document_id);
  v_result jsonb;
  v_last public.customer_document_render_jobs%rowtype;
  v_job uuid;
begin
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v := authz.cdoc_lock(p_document_id);
  v_result := authz.finance_replay(v.legal_entity_id, p_request_id, 'customer_document_render_retry', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  perform authz.cdoc_require_enabled(v.legal_entity_id);
  select * into v_last from public.customer_document_render_jobs j where j.document_id = v.id
  order by j.created_at desc, j.id desc limit 1;
  if v.status <> 'released' or v_last.id is null or v_last.status <> 'failed'
     or exists (select 1 from public.customer_document_files f where f.document_id = v.id) then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  insert into public.customer_document_render_jobs (legal_entity_id, document_id, content_sha256, template_version, requested_by)
  values (v.legal_entity_id, v.id, v.content_sha256, 'cdoc-1', (select auth.uid()))
  returning id into v_job;
  perform authz.write_audit('accounts.customer_document.render_retried', v.legal_entity_id, v.branch_id, 'customer_document', v.id, null,
    jsonb_build_object('documentId', v.id, 'renderJobId', v_job, 'previousJobId', v_last.id));
  v_result := jsonb_build_object('outcome', 'created', 'documentId', v.id, 'renderJobId', v_job);
  return authz.finance_remember(v.legal_entity_id, p_request_id, 'customer_document_render_retry', v_payload, v_result);
end;
$$;

create function public.customer_document_authorize_download(p_document_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.customer_documents%rowtype;
  v_file public.customer_document_files%rowtype;
  v_viewer text;
begin
  if p_document_id is null or not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v from public.customer_documents c where c.id = p_document_id;
  v_viewer := case when v.id is not null then authz.cdoc_viewer(v.deal_id) end;
  if v.id is null or v_viewer is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.cdoc_require_enabled(v.legal_entity_id);
  if v.status not in ('released', 'replaced', 'cancelled') then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_file from public.customer_document_files f where f.document_id = v.id;
  if v_file.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.write_audit('accounts.customer_document.downloaded', v.legal_entity_id, v.branch_id, 'customer_document', v.id, null,
    jsonb_build_object('documentId', v.id, 'fileId', v_file.id, 'viewer', v_viewer));
  return jsonb_build_object('documentId', v.id, 'objectPath', v_file.object_path, 'fileName', v.number || '.pdf',
    'sizeBytes', v_file.size_bytes, 'sha256', v_file.sha256);
end;
$$;

-- ===========================================================================
-- 4. Grants
-- ===========================================================================

revoke all on function authz.cdoc_viewer(uuid), authz.cdoc_object_path(uuid, uuid, uuid)
  from public, anon, authenticated, service_role;
revoke all on function
  public.customer_document_render_claim(text, integer),
  public.customer_document_render_input(uuid, text),
  public.customer_document_render_complete(uuid, text, boolean, text, jsonb),
  public.customer_document_render_retry(uuid, uuid),
  public.customer_document_authorize_download(uuid)
  from public, anon, authenticated, service_role;
grant execute on function
  public.customer_document_render_claim(text, integer),
  public.customer_document_render_input(uuid, text),
  public.customer_document_render_complete(uuid, text, boolean, text, jsonb)
  to service_role;
grant execute on function
  public.customer_document_render_retry(uuid, uuid),
  public.customer_document_authorize_download(uuid)
  to authenticated;

commit;
