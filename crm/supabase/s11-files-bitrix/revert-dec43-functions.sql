-- TripNavigate CRM - S11 prepared revert of the three restated DEC-43 functions
--
-- NOT A MIGRATION. Keep it out of supabase/migrations. Run it only as an
-- approved operator step if a function restated by
-- 20261212000140_s11_dec43_two_way.sql misbehaves.
--
-- What it does: puts back the three DEC-43 function bodies exactly as they
-- were newest before S11 (create or replace keeps the signature, grants and
-- owner):
--   public.bitrix_id_proof_copy_claim(integer, integer)
--     from 20261120000700_b12_id_proof_bitrix_copy.sql
--   public.bitrix_id_proof_copy_mark_sending(uuid, uuid, bigint[])
--     from 20261206000200_conflict_code_all.sql
--   public.bitrix_id_proof_copy_complete(uuid, uuid, text, text, bigint)
--     from 20261206000200_conflict_code_all.sql
-- Effect: DEC-43 no longer takes the shared per-deal lock, no longer waits for
-- S11 appends and no longer copies sole copies back first. Before running it,
-- turn the S11 delete switch off (file_move_set_switch('delete_after_hold',
-- false, reason)) and confirm no row is delete_pending or deleted, because the
-- sole-copy rule then holds only on the S11 side. authz.file_move_dec43_gate,
-- file_move_box_state and every S11 table are left as they are.
-- Forward fix afterwards: a new migration that restates the functions again.

begin;
set local lock_timeout = '5s';

-- public.bitrix_id_proof_copy_claim(integer, integer): from 20261120000700_b12_id_proof_bitrix_copy.sql
create or replace function public.bitrix_id_proof_copy_claim(p_limit integer, p_lease_seconds integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_token uuid;
  v_deals uuid[] := '{}';
  r record;
begin
  if p_limit is null or p_limit not between 1 and 20 or p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'limit';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('bitrix_id_proof_copy_claim', 0));
  for r in
    select j.id, j.deal_id, j.status, p.status as proof_status, d.removed_at, c.id as cfg_id
    from public.bitrix_id_proof_copy_jobs j
    join public.traveller_id_proofs p on p.id = j.id_proof_id
    join public.deals d on d.id = j.deal_id
    left join public.integration_intake_config c
      on c.portal_member_id = j.source_portal and c.enabled and c.bitrix_id_proof_copy
    where j.status in ('pending', 'unknown') and j.next_attempt_at <= now()
      and (j.locked_until is null or j.locked_until < now())
      -- No other job of the same Deal in flight.
      and not exists (
        select 1 from public.bitrix_id_proof_copy_jobs o
        where o.deal_id = j.deal_id and o.id <> j.id
          and ((o.locked_until is not null and o.locked_until >= now())
               or (o.status = 'unknown' and j.status = 'pending')))
    order by (j.status = 'unknown') desc, j.next_attempt_at, j.id
    limit 200
    for update of j skip locked
  loop
    exit when jsonb_array_length(v_out) >= p_limit;
    if r.cfg_id is null then
      continue;  -- switch off: leave the job as it is
    end if;
    if r.deal_id = any (v_deals) then
      continue;  -- one job per Deal per claim
    end if;
    if r.proof_status <> 'stored' or r.removed_at is not null then
      if r.status = 'pending' then
        update public.bitrix_id_proof_copy_jobs j
        set status = 'cancelled', last_error_code = case when r.removed_at is not null then 'deal_removed' else 'proof_removed' end,
            updated_at = now()
        where j.id = r.id;
        continue;
      end if;
    end if;
    v_deals := v_deals || r.deal_id;
    v_token := gen_random_uuid();
    update public.bitrix_id_proof_copy_jobs j
    set lease_token = v_token, locked_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
    where j.id = r.id;
    v_out := v_out || (
      select jsonb_build_object('jobId', j.id, 'leaseToken', v_token,
        'mode', case when j.status = 'unknown' then 'verify' else 'send' end,
        'bitrixDealId', j.source_deal_id::text, 'objectPath', p.object_path, 'mime', p.mime, 'sizeBytes', p.size_bytes,
        'sha256', j.file_sha256,
        'travellerSeq', p.traveller_seq, 'priorFileIds', to_jsonb(coalesce(j.prior_file_ids, '{}'::bigint[])),
        'attempts', j.attempts)
      from public.bitrix_id_proof_copy_jobs j join public.traveller_id_proofs p on p.id = j.id_proof_id
      where j.id = r.id);
  end loop;
  return v_out;
end;
$$;

-- public.bitrix_id_proof_copy_mark_sending(uuid, uuid, bigint[]): from 20261206000200_conflict_code_all.sql
create or replace function public.bitrix_id_proof_copy_mark_sending(p_job_id uuid, p_lease_token uuid, p_prior_file_ids bigint[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.bitrix_id_proof_copy_jobs%rowtype;
begin
  select * into v_job from public.bitrix_id_proof_copy_jobs j where j.id = p_job_id for update;
  if v_job.id is null or v_job.lease_token is distinct from p_lease_token or v_job.locked_until < now() then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  if v_job.status <> 'pending' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_prior_file_ids is null or cardinality(p_prior_file_ids) > 200
     or exists (select 1 from unnest(p_prior_file_ids) x where x is null or x <= 0) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'priorFileIds';
  end if;
  update public.bitrix_id_proof_copy_jobs j
  set status = 'unknown', attempts = j.attempts + 1, prior_file_ids = p_prior_file_ids, updated_at = now()
  where j.id = v_job.id
  returning * into v_job;
  return jsonb_build_object('jobId', v_job.id, 'status', v_job.status, 'attempts', v_job.attempts);
end;
$$;

-- public.bitrix_id_proof_copy_complete(uuid, uuid, text, text, bigint): from 20261206000200_conflict_code_all.sql
create or replace function public.bitrix_id_proof_copy_complete(
  p_job_id uuid, p_lease_token uuid, p_outcome text, p_error_code text, p_bitrix_file_id bigint
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.bitrix_id_proof_copy_jobs%rowtype;
begin
  select * into v_job from public.bitrix_id_proof_copy_jobs j where j.id = p_job_id for update;
  if v_job.id is null or v_job.lease_token is distinct from p_lease_token then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  if p_outcome is null or p_outcome not in ('sent', 'retry', 'failed', 'unknown')
     or (p_error_code is not null and p_error_code !~ '^[a-z_]{1,60}$')
     or (p_outcome = 'sent' and (p_bitrix_file_id is null or p_bitrix_file_id <= 0))
     or (p_outcome in ('retry', 'failed', 'unknown') and p_error_code is null) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'outcome';
  end if;
  -- A job that ends before mark_sending (read or download failed, Deal gone,
  -- file changed) still uses an attempt, so retries stay bounded.
  if v_job.status = 'pending' and p_outcome <> 'sent' then
    update public.bitrix_id_proof_copy_jobs j set attempts = j.attempts + 1 where j.id = v_job.id returning * into v_job;
  end if;
  if p_outcome = 'sent' then
    update public.bitrix_id_proof_copy_jobs j
    set status = 'sent', bitrix_file_id = p_bitrix_file_id, sent_at = now(), last_error_code = null, read_back_attempts = 0,
        lease_token = null, locked_until = null, updated_at = now()
    where j.id = v_job.id returning * into v_job;
    perform authz.id_proof_copy_audit('integration.id_proof_copy_sent', v_job, jsonb_build_object('bitrixFileId', p_bitrix_file_id));
  elsif p_outcome = 'unknown' and v_job.read_back_attempts + 1 >= 5 then
    -- Review E8-2: five undecided read-backs in a row: stop trying, free the
    -- Deal, and leave it to the Super Admin (alerts, manual retry).
    update public.bitrix_id_proof_copy_jobs j
    set status = 'needs_manual_check', read_back_attempts = j.read_back_attempts + 1, last_error_code = p_error_code,
        lease_token = null, locked_until = null, updated_at = now()
    where j.id = v_job.id returning * into v_job;
    perform authz.id_proof_copy_audit('integration.id_proof_copy_needs_manual_check', v_job,
      jsonb_build_object('errorCode', p_error_code, 'readBackAttempts', v_job.read_back_attempts));
  elsif p_outcome = 'unknown' then
    update public.bitrix_id_proof_copy_jobs j
    set status = 'unknown', read_back_attempts = j.read_back_attempts + 1, last_error_code = p_error_code,
        next_attempt_at = now() + authz.id_proof_copy_backoff(j.read_back_attempts + 1),
        lease_token = null, locked_until = null, updated_at = now()
    where j.id = v_job.id returning * into v_job;
    perform authz.id_proof_copy_audit('integration.id_proof_copy_unknown', v_job, jsonb_build_object('errorCode', p_error_code));
  elsif p_outcome = 'retry' and v_job.attempts < v_job.max_attempts then
    update public.bitrix_id_proof_copy_jobs j
    set status = 'pending', read_back_attempts = 0, last_error_code = p_error_code, next_attempt_at = now() + authz.id_proof_copy_backoff(j.attempts),
        lease_token = null, locked_until = null, updated_at = now()
    where j.id = v_job.id returning * into v_job;
    perform authz.id_proof_copy_audit('integration.id_proof_copy_retry_scheduled', v_job, jsonb_build_object('errorCode', p_error_code));
  else
    update public.bitrix_id_proof_copy_jobs j
    set status = 'failed', last_error_code = p_error_code, lease_token = null, locked_until = null, updated_at = now()
    where j.id = v_job.id returning * into v_job;
    perform authz.id_proof_copy_audit('integration.id_proof_copy_failed', v_job, jsonb_build_object('errorCode', p_error_code));
  end if;
  return jsonb_build_object('jobId', v_job.id, 'status', v_job.status, 'attempts', v_job.attempts, 'errorCode', v_job.last_error_code);
end;
$$;

commit;
