-- TripNavigate CRM - Accounts phase 3, track G (8): proof for a supplier
-- refund after a lower rate (LD29, Addendum L7).
--
-- Replaced (latest body 20261204000360:18, same signature; changed lines marked
-- "Accounts phase 3 (20261205000680)"):
--   public.refund_evidence_begin: subject_kind 'supplier_refund' also takes an
--     applied change request whose reconfirmation leaves a supplier refund
--     expected (subject_id = the change request; supplier_refund_record,
--     20261205000650, looks the proof up by that subject). Who may upload is
--     unchanged: Accounts of the entity through the finance gate (Purchase never
--     handles refunds, standing rule 9). refund_evidence_finish and
--     refund_evidence_authorize_download do not read the subject: unchanged.
--
-- Refusal tokens: unchanged; not_ready (hint sourceId) when the change is not
-- applied or nothing is expected.
-- Rollback (forward-only): a NEW migration restoring the 20261204000360 body.

begin;
set local lock_timeout = '15s';

create or replace function public.refund_evidence_begin(p_subject_kind text, p_subject_id uuid, p_file_name text, p_mime text,
  p_size_bytes integer, p_sha256 text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_req public.customer_refund_requests%rowtype;
  v_c public.deal_cancellations%rowtype;
  v_cr public.booking_change_requests%rowtype;  -- Accounts phase 3 (20261205000680)
  v_id uuid := gen_random_uuid();
  v_path text;
  v_name text := btrim(coalesce(p_file_name, ''));
  v_sha text := lower(coalesce(p_sha256, ''));
  v_payload jsonb := jsonb_build_object('subjectKind', p_subject_kind, 'subjectId', p_subject_id, 'fileName', p_file_name,
    'mime', p_mime, 'sizeBytes', p_size_bytes, 'sha256', p_sha256);
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_subject_kind = 'customer_refund' then
    select * into v_req from public.customer_refund_requests r where r.id = p_subject_id;
    select * into v_deal from public.deals d where d.id = v_req.deal_id;
  elsif p_subject_kind = 'supplier_refund' then
    select * into v_c from public.deal_cancellations c where c.id = p_subject_id;
    -- Accounts phase 3 (20261205000680): or an applied change request (a lower rate, LD29).
    if v_c.id is null then
      select * into v_cr from public.booking_change_requests r where r.id = p_subject_id;
    end if;
    select * into v_deal from public.deals d where d.id = coalesce(v_c.deal_id, v_cr.deal_id);
  else
    perform authz.refund_invalid('subjectKind');
  end if;
  if v_deal.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.finance_require_accounts(v_deal.legal_entity_id, v_deal.is_synthetic);
  if p_request_id is null then
    perform authz.refund_invalid('requestId');
  end if;
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'refund_evidence_begin', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_subject_kind = 'customer_refund' and (v_req.status <> 'approved' or v_req.outcome <> 'payout') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_subject_kind = 'supplier_refund' and v_c.id is not null and v_c.status <> 'approved' then
    raise exception 'not_ready' using errcode = '55000', hint = 'cancellation';
  end if;
  -- Accounts phase 3 (20261205000680): the change must be applied and leave a supplier refund expected.
  if p_subject_kind = 'supplier_refund' and v_c.id is null
     and (v_cr.status <> 'applied' or not exists (
            select 1 from authz.supplier_refund_sources(v_cr.deal_id) s
            join public.task_reconfirmations x on x.id = s.source_id
            where s.source_kind = 'reconfirmation' and x.change_request_id = v_cr.id)) then
    raise exception 'not_ready' using errcode = '55000', hint = 'sourceId';
  end if;
  if length(v_name) not between 1 and 120 or v_name !~ '^[A-Za-z0-9._ -]+$' then
    perform authz.refund_invalid('fileName');
  end if;
  if p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp') then
    perform authz.refund_invalid('mime');
  end if;
  if p_size_bytes is null or p_size_bytes not between 1 and 4194304 then
    perform authz.refund_invalid('sizeBytes');
  end if;
  if v_sha !~ '^[0-9a-f]{64}$' then
    perform authz.refund_invalid('sha256');
  end if;
  -- 20261204000360: at most 10 proofs not yet used by a payout or a supplier
  -- refund per subject (a cancellation case may need many supplier refunds).
  if (select count(*) from public.refund_evidence e
      where e.subject_kind = p_subject_kind and e.subject_id = p_subject_id and e.status in ('pending_upload', 'stored')
        and not exists (select 1 from public.customer_refund_payouts p where p.evidence_id = e.id)
        and not exists (select 1 from public.supplier_refund_receipts x where x.evidence_id = e.id)) >= 10 then
    perform authz.refund_invalid('file');
  end if;
  if exists (select 1 from public.refund_evidence e
             where e.legal_entity_id = v_deal.legal_entity_id and e.sha256 = v_sha and e.status in ('pending_upload', 'stored')) then
    raise exception 'duplicate_file' using errcode = '23505';
  end if;
  v_path := v_deal.legal_entity_id::text || '/refund/' || p_subject_id::text || '/' || v_id::text;
  begin
    insert into public.refund_evidence (id, legal_entity_id, deal_id, subject_kind, subject_id, object_path, file_name, mime,
      size_bytes, sha256, uploaded_by, request_id)
    values (v_id, v_deal.legal_entity_id, v_deal.id, p_subject_kind, p_subject_id, v_path, v_name, p_mime, p_size_bytes, v_sha,
      (select auth.uid()), p_request_id);
  exception when unique_violation then
    raise exception 'duplicate_file' using errcode = '23505';
  end;
  v_result := jsonb_build_object('outcome', 'created', 'evidenceId', v_id, 'objectPath', v_path);
  return authz.finance_remember(v_deal.legal_entity_id, p_request_id, 'refund_evidence_begin', v_payload, v_result);
end;
$$;

commit;
