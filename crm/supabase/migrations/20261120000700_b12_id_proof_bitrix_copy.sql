-- TripNavigate CRM - B1.2 (DEC-43): copy traveller identity-proof files to
-- the linked Bitrix Deal. The ONLY Bitrix write the CRM may make.
--
-- Owner decision: DEC-43 confirmed in the build session ("go for it",
-- "approve the step", target choice "a"): the Deal field "Aadhar and
-- Passports" (UF_CRM_1784359513, file, multiple) of the Bitrix Deal the CRM
-- Deal was imported from. Live activation needs its own APPROVE.
--
-- What changes:
--   1. Switch integration_intake_config.bitrix_id_proof_copy (OFF by default),
--      written only by public.integration_set_bitrix_id_proof_copy (Super
--      Admin at aal2, reason 10-500, audited; settings trigger watches it).
--   2. public.bitrix_id_proof_copy_jobs: one job per (Deal, traveller, file
--      sha256), idempotent. Status pending -> unknown (being sent: the answer
--      may be lost) -> sent | failed; pending again for a retry; cancelled
--      when the proof was removed or the Deal left the sync before sending.
--      At most 5 attempts with back-off (60 s x 2^(n-1), at most 1 h). The job
--      keeps the Bitrix file ids the field held before the send, so a lost
--      answer is resolved by reading the field back (a new id = sent; none =
--      pending again), never by sending blindly.
--   3. Enqueue: a trigger on traveller_id_proofs when a proof becomes
--      'stored', only while the switch is on and only for a Deal imported from
--      the configured Bitrix portal. A failure to enqueue never blocks the
--      upload (it is caught and audited as a code).
--   4. Worker commands (service_role only): claim, mark_sending (records the
--      prior file ids and moves the job to unknown before any Bitrix call),
--      complete (sent / retry / failed / unknown). No file content and no file
--      name ever reaches the database, the audit or a log.
--   5. Staff: bitrix_id_proof_copy_retry (booking editors of the Deal and the
--      Super Admin; failed or unknown back to pending; a job stopped for lost
--      files or refused credentials only by the Super Admin) and
--      bitrix_id_proof_copy_status (booking editors: one row per job, codes
--      only).
--   6. Review E7-1 circuit breaker: when a read shows that files the field
--      held before are gone, the worker calls bitrix_id_proof_copy_stop: the
--      job fails, the switch goes off (audited, reason "automatic stop") and
--      an alert row is opened in bitrix_id_proof_copy_stops for the Super
--      Admin (bitrix_id_proof_copy_alerts). Switching the copy on again
--      acknowledges the open alerts with the Super Admin's reason.
--   8. Review E8-2: undecided read-backs are counted; after 5 in a row the job
--      ends needs_manual_check (the Deal is freed for its other jobs; the
--      Super Admin sees it in bitrix_id_proof_copy_alerts and may retry it).
--   7. Review E7-2/E7-3/E7-6: the claim hands out at most one job per Deal and
--      never a job of a Deal that has another job in flight (leased, or
--      unknown and waiting for its read-back); claims are serialised. The
--      claim returns the file size so the worker can recognise its own file
--      on read-back.
--
-- Only proofs stored while the switch is on are copied (review E7-4: proofs
-- stored earlier are not copied; the owner chose no backfill). A proof
-- re-uploaded with the same file after its earlier job was cancelled re-arms
-- that job (review E7-5).
--
-- A copy never blocks booking, money or tasks: nothing reads these jobs except
-- the worker and the status read.
--
-- Rollback (forward-only): switch off with integration_set_bitrix_id_proof_copy(false, reason);
-- the worker then claims nothing. Files already in Bitrix stay there (the CRM
-- never deletes Bitrix files). Never delete jobs or audit rows.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Switch
-- ===========================================================================

alter table public.integration_intake_config
  add column bitrix_id_proof_copy boolean not null default false;
comment on column public.integration_intake_config.bitrix_id_proof_copy is
  'B1.2 DEC-43: copy stored traveller ID proofs to the Bitrix Deal field UF_CRM_1784359513 (append only). Off by default; written only by public.integration_set_bitrix_id_proof_copy (Super Admin, reason, audited). Live use needs the owner''s APPROVE.';

drop trigger integration_intake_config_audit on public.integration_intake_config;
create trigger integration_intake_config_audit
  after insert or update or delete on public.integration_intake_config
  for each row execute function authz.audit_settings_change(
    'settings.intake_config_changed', 'enabled', 'portal_domain', 'portal_member_id', 'category_id',
    'eligible_category_ids', 'eligible_stage_ids', 'cutoff_at', 'pilot_legal_entity_id', 'pilot_branch_id',
    'lead_intake_mode', 'deal_intake_mode',
    'deal_entry_stage_ids',
    'bitrix_trip_facts_read', 'lead_intake_unowned',
    -- B1.2 0700
    'bitrix_id_proof_copy');

create function public.integration_set_bitrix_id_proof_copy(p_on boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_n integer;
  v_reason text;
  v_prev text[];
begin
  select count(*) into v_n from public.integration_intake_config;
  if v_n <> 1 then
    raise exception 'intake is not configured' using errcode = '55000';
  end if;
  select * into v_cfg from public.integration_intake_config;
  if not authz.can_switch_live_settings(v_cfg.pilot_legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_reason := authz.settings_change_reason(p_reason);
  if p_on is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'on';
  end if;
  select * into v_cfg from public.integration_intake_config c where c.id = v_cfg.id for update;
  if v_cfg.bitrix_id_proof_copy = p_on then
    return jsonb_build_object('changed', false, 'on', p_on);
  end if;
  v_prev := authz.settings_begin_change('integration_set_bitrix_id_proof_copy', v_reason);
  update public.integration_intake_config c
  set bitrix_id_proof_copy = p_on, updated_at = now(), updated_by = auth.uid()
  where c.id = v_cfg.id;
  perform authz.settings_end_change(v_prev);
  if p_on then
    -- Review E7-1: switching on again acknowledges any automatic stop.
    update public.bitrix_id_proof_copy_stops s
    set acknowledged_at = now(), acknowledged_by = auth.uid()
    where s.portal_member_id = v_cfg.portal_member_id and s.acknowledged_at is null;
  end if;
  perform authz.write_audit('integration.id_proof_copy_switch_set', v_cfg.pilot_legal_entity_id, null,
    'integration_intake_config', v_cfg.id, v_reason, jsonb_build_object('before', v_cfg.bitrix_id_proof_copy, 'after', p_on));
  return jsonb_build_object('changed', true, 'on', p_on);
end;
$$;

revoke all on function public.integration_set_bitrix_id_proof_copy(boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.integration_set_bitrix_id_proof_copy(boolean, text) to authenticated;

-- ===========================================================================
-- 2. Jobs
-- ===========================================================================

create table public.bitrix_id_proof_copy_jobs (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  deal_id uuid not null references public.deals (id),
  traveller_id uuid not null,
  id_proof_id uuid not null references public.traveller_id_proofs (id),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  source_portal text not null,
  source_deal_id bigint not null check (source_deal_id > 0),
  status text not null default 'pending' check (status in ('pending', 'unknown', 'sent', 'failed', 'cancelled', 'needs_manual_check')),
  attempts integer not null default 0 check (attempts between 0 and 50),
  -- Review E8-2: undecided read-backs in a row (answer lost, or the new file's
  -- facts could not be learnt). At 5 the job ends needs_manual_check.
  read_back_attempts integer not null default 0 check (read_back_attempts between 0 and 50),
  max_attempts integer not null default 5 check (max_attempts between 1 and 50),
  next_attempt_at timestamptz not null default now(),
  lease_token uuid,
  locked_until timestamptz,
  -- Bitrix file ids the field held just before the last send (append check and lost-answer read-back).
  prior_file_ids bigint[],
  bitrix_file_id bigint check (bitrix_file_id > 0),
  last_error_code text check (last_error_code ~ '^[a-z_]{1,60}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz,
  constraint bitrix_id_proof_copy_jobs_unique unique (deal_id, traveller_id, file_sha256),
  check ((status = 'sent') = (sent_at is not null)),
  check ((lease_token is null) = (locked_until is null))
);
create index bitrix_id_proof_copy_jobs_due_idx on public.bitrix_id_proof_copy_jobs (next_attempt_at)
  where status in ('pending', 'unknown');
create index bitrix_id_proof_copy_jobs_entity_idx on public.bitrix_id_proof_copy_jobs (legal_entity_id);
create index bitrix_id_proof_copy_jobs_proof_idx on public.bitrix_id_proof_copy_jobs (id_proof_id);
comment on table public.bitrix_id_proof_copy_jobs is
  'DEC-43: copies of stored traveller ID proofs to the Bitrix Deal field UF_CRM_1784359513 (append only). No file content or name; codes and ids only. Written only by the copy commands; no Data API access.';

alter table public.bitrix_id_proof_copy_jobs enable row level security;
create policy require_valid_session on public.bitrix_id_proof_copy_jobs as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.bitrix_id_proof_copy_jobs from public, anon, authenticated, service_role;

-- Audit with codes and ids only: traveller, Bitrix Deal id and file hash; never content or file name.
create function authz.id_proof_copy_audit(p_action text, p_job public.bitrix_id_proof_copy_jobs, p_details jsonb)
returns void language plpgsql volatile security definer set search_path = '' as $$
begin
  perform authz.write_audit(p_action, p_job.legal_entity_id, (select d.branch_id from public.deals d where d.id = p_job.deal_id),
    'deal', p_job.deal_id, null,
    jsonb_build_object('jobId', p_job.id, 'travellerId', p_job.traveller_id, 'bitrixDealId', p_job.source_deal_id,
      'sha256', p_job.file_sha256, 'attempt', p_job.attempts) || coalesce(p_details, '{}'::jsonb));
end;
$$;

-- Back-off before attempt n+1: 60 s x 2^(n-1), at most one hour.
create function authz.id_proof_copy_backoff(p_attempts integer) returns interval
language sql immutable set search_path = '' as $$
  select make_interval(secs => least(3600, 60 * power(2, greatest(p_attempts, 1) - 1))::integer)
$$;

-- ===========================================================================
-- 3. Enqueue on a stored proof (switch on, Bitrix-imported Deal only)
-- ===========================================================================

create function authz.id_proof_copy_enqueue() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
  v_deal public.deals%rowtype;
  v_job public.bitrix_id_proof_copy_jobs%rowtype;
begin
  if new.status <> 'stored' or old.status = 'stored' then
    return new;
  end if;
  begin
    select * into v_deal from public.deals d where d.id = new.deal_id;
    select * into v_cfg from public.integration_intake_config c
    where c.portal_member_id = v_deal.source_portal and c.enabled and c.bitrix_id_proof_copy;
    if v_cfg.id is null or v_deal.source_system is distinct from 'bitrix' or v_deal.source_deal_id is null
       or v_deal.removed_at is not null then
      return new;
    end if;
    insert into public.bitrix_id_proof_copy_jobs (legal_entity_id, deal_id, traveller_id, id_proof_id, file_sha256,
      source_portal, source_deal_id)
    values (new.legal_entity_id, new.deal_id, new.traveller_id, new.id, new.sha256, v_deal.source_portal, v_deal.source_deal_id)
    on conflict on constraint bitrix_id_proof_copy_jobs_unique do update
      -- Review E7-5: the same file stored again after its job was cancelled
      -- (proof removed before sending) is copied after all.
      set status = 'pending', id_proof_id = excluded.id_proof_id, attempts = 0, next_attempt_at = now(),
          prior_file_ids = null, last_error_code = null, lease_token = null, locked_until = null, updated_at = now()
      where public.bitrix_id_proof_copy_jobs.status = 'cancelled'
    returning * into v_job;
    if v_job.id is not null then
      perform authz.id_proof_copy_audit('integration.id_proof_copy_enqueued', v_job, null);
    end if;
  exception when others then
    -- Never block the upload: record the failure (codes only) and carry on.
    perform authz.write_audit('integration.id_proof_copy_enqueue_failed', new.legal_entity_id, null,
      'traveller_id_proof', new.id, null, jsonb_build_object('dealId', new.deal_id, 'sqlState', sqlstate));
  end;
  return new;
end;
$$;

create trigger traveller_id_proofs_bitrix_copy
  after update of status on public.traveller_id_proofs
  for each row execute function authz.id_proof_copy_enqueue();

-- ===========================================================================
-- 4. Worker commands (service_role only)
-- ===========================================================================

-- Claims due jobs (pending, or unknown waiting for a read-back) with a lease.
-- Nothing is claimed while the switch is off. A job whose proof is no longer
-- stored, or whose Deal left the sync, is cancelled instead. Review E7-2/E7-6:
-- claims are serialised, at most one job per Deal is handed out, and a Deal
-- with another job in flight (leased, or unknown and waiting for its
-- read-back) is skipped; an unknown job of a Deal goes before its pending
-- ones. The worker claims one job at a time. Returns
-- [{jobId, leaseToken, mode: send|verify, bitrixDealId, objectPath, mime,
--   sizeBytes, sha256, travellerSeq, priorFileIds, attempts}].
create function public.bitrix_id_proof_copy_claim(p_limit integer, p_lease_seconds integer) returns jsonb
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

-- Before the Bitrix call: record the field's current file ids and move the
-- job to unknown (a crash or a lost answer is then resolved by read-back).
create function public.bitrix_id_proof_copy_mark_sending(p_job_id uuid, p_lease_token uuid, p_prior_file_ids bigint[])
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.bitrix_id_proof_copy_jobs%rowtype;
begin
  select * into v_job from public.bitrix_id_proof_copy_jobs j where j.id = p_job_id for update;
  if v_job.id is null or v_job.lease_token is distinct from p_lease_token or v_job.locked_until < now() then
    raise exception 'task_conflict' using errcode = '40001';
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

-- p_outcome:
--   sent     the field now holds the copy (p_bitrix_file_id = the new file id)
--   retry    not sent (transient error, or the read-back found no new file):
--            pending again with back-off while attempts remain, else failed
--   failed   permanent (p_error_code), no further automatic attempt
--   unknown  the answer was lost: read back later
create function public.bitrix_id_proof_copy_complete(
  p_job_id uuid, p_lease_token uuid, p_outcome text, p_error_code text, p_bitrix_file_id bigint
) returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.bitrix_id_proof_copy_jobs%rowtype;
begin
  select * into v_job from public.bitrix_id_proof_copy_jobs j where j.id = p_job_id for update;
  if v_job.id is null or v_job.lease_token is distinct from p_lease_token then
    raise exception 'task_conflict' using errcode = '40001';
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

-- ===========================================================================
-- 4b. Circuit breaker (review E7-1)
-- ===========================================================================

-- One row per automatic stop of the copy: append and acknowledge only. Codes,
-- ids and times; never file content or names.
create table public.bitrix_id_proof_copy_stops (
  id uuid primary key default gen_random_uuid(),
  legal_entity_id uuid not null references public.legal_entities (id),
  portal_member_id text not null references public.integration_intake_config (portal_member_id),
  job_id uuid not null references public.bitrix_id_proof_copy_jobs (id),
  source_deal_id bigint not null check (source_deal_id > 0),
  reason_code text not null check (reason_code in ('prior_files_lost')),
  opened_at timestamptz not null default now(),
  acknowledged_at timestamptz,
  acknowledged_by uuid,
  check ((acknowledged_at is null) = (acknowledged_by is null))
);
create index bitrix_id_proof_copy_stops_open_idx on public.bitrix_id_proof_copy_stops (portal_member_id) where acknowledged_at is null;
comment on table public.bitrix_id_proof_copy_stops is
  'DEC-43 review E7-1: automatic stops of the Bitrix ID-proof copy (files the Deal field held before were gone). Append and acknowledge only; codes and ids.';

create function authz.id_proof_copy_stop_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'copy stops are never deleted' using errcode = '23514';
  end if;
  if (new.id, new.legal_entity_id, new.portal_member_id, new.job_id, new.source_deal_id, new.reason_code, new.opened_at)
       is distinct from (old.id, old.legal_entity_id, old.portal_member_id, old.job_id, old.source_deal_id, old.reason_code, old.opened_at)
     or (old.acknowledged_at is not null and (new.acknowledged_at, new.acknowledged_by) is distinct from (old.acknowledged_at, old.acknowledged_by)) then
    raise exception 'a copy stop can only be acknowledged once' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger bitrix_id_proof_copy_stop_guard
  before update or delete on public.bitrix_id_proof_copy_stops
  for each row execute function authz.id_proof_copy_stop_guard();
create trigger bitrix_id_proof_copy_stops_no_truncate before truncate on public.bitrix_id_proof_copy_stops
  for each statement execute function authz.refuse_settings_truncate();

alter table public.bitrix_id_proof_copy_stops enable row level security;
create policy require_valid_session on public.bitrix_id_proof_copy_stops as restrictive for all to authenticated
  using ((select authz.session_valid())) with check ((select authz.session_valid()));
revoke all on public.bitrix_id_proof_copy_stops from public, anon, authenticated, service_role;

-- Worker (service role): a read showed that files the field held before are
-- gone. In one transaction: the job fails with the code, the switch goes off
-- (audited through the settings trigger, reason "automatic stop") and an alert
-- row is opened. Nothing is claimed afterwards until the Super Admin switches
-- the copy on again.
create function public.bitrix_id_proof_copy_stop(p_job_id uuid, p_lease_token uuid, p_reason_code text)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.bitrix_id_proof_copy_jobs%rowtype;
  v_cfg public.integration_intake_config%rowtype;
  v_prev text[];
  v_stop uuid;
begin
  if p_reason_code is null or p_reason_code not in ('prior_files_lost') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  select * into v_job from public.bitrix_id_proof_copy_jobs j where j.id = p_job_id for update;
  if v_job.id is null or v_job.lease_token is distinct from p_lease_token then
    raise exception 'task_conflict' using errcode = '40001';
  end if;
  update public.bitrix_id_proof_copy_jobs j
  set status = 'failed', last_error_code = p_reason_code, lease_token = null, locked_until = null, updated_at = now()
  where j.id = v_job.id returning * into v_job;
  perform authz.id_proof_copy_audit('integration.id_proof_copy_failed', v_job, jsonb_build_object('errorCode', p_reason_code));

  select * into v_cfg from public.integration_intake_config c where c.portal_member_id = v_job.source_portal for update;
  if v_cfg.id is not null and v_cfg.bitrix_id_proof_copy then
    v_prev := authz.settings_begin_change('bitrix_id_proof_copy_stop', 'automatic stop: ' || p_reason_code);
    update public.integration_intake_config c
    set bitrix_id_proof_copy = false, updated_at = now()
    where c.id = v_cfg.id;
    perform authz.settings_end_change(v_prev);
  end if;
  insert into public.bitrix_id_proof_copy_stops (legal_entity_id, portal_member_id, job_id, source_deal_id, reason_code)
  values (v_job.legal_entity_id, v_job.source_portal, v_job.id, v_job.source_deal_id, p_reason_code)
  returning id into v_stop;
  perform authz.id_proof_copy_audit('integration.id_proof_copy_auto_stopped', v_job,
    jsonb_build_object('reasonCode', p_reason_code, 'stopId', v_stop, 'switchWasOn', coalesce(v_cfg.bitrix_id_proof_copy, false)));
  return jsonb_build_object('stopId', v_stop, 'jobId', v_job.id, 'switchOn', false);
end;
$$;

-- Super Admin: automatic stops (open first) and, review E8-2, jobs that need
-- a manual check (newest first). Codes, ids and times only:
-- {stops: [{stopId, jobId, bitrixDealId, reasonCode, openedAt, acknowledgedAt}],
--  manualChecks: [{jobId, bitrixDealId, lastErrorCode, readBackAttempts, updatedAt}]}.
create function public.bitrix_id_proof_copy_alerts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_cfg public.integration_intake_config%rowtype;
begin
  select * into v_cfg from public.integration_intake_config c limit 1;
  if not authz.session_ok() or v_cfg.id is null or not authz.can_switch_live_settings(v_cfg.pilot_legal_entity_id) then
    return null;
  end if;
  return jsonb_build_object(
    'stops', coalesce((
      select jsonb_agg(jsonb_build_object('stopId', s.id, 'jobId', s.job_id, 'bitrixDealId', s.source_deal_id::text,
        'reasonCode', s.reason_code, 'openedAt', s.opened_at, 'acknowledgedAt', s.acknowledged_at)
        order by (s.acknowledged_at is null) desc, s.opened_at desc)
      from public.bitrix_id_proof_copy_stops s where s.portal_member_id = v_cfg.portal_member_id), '[]'::jsonb),
    'manualChecks', coalesce((
      select jsonb_agg(jsonb_build_object('jobId', j.id, 'bitrixDealId', j.source_deal_id::text, 'lastErrorCode', j.last_error_code,
        'readBackAttempts', j.read_back_attempts, 'updatedAt', j.updated_at) order by j.updated_at desc, j.id)
      from public.bitrix_id_proof_copy_jobs j
      where j.source_portal = v_cfg.portal_member_id and j.status = 'needs_manual_check'), '[]'::jsonb));
end;
$$;

revoke all on function public.bitrix_id_proof_copy_stop(uuid, uuid, text), public.bitrix_id_proof_copy_alerts(),
  authz.id_proof_copy_stop_guard()
from public, anon, authenticated, service_role;
grant execute on function public.bitrix_id_proof_copy_stop(uuid, uuid, text) to service_role;
grant execute on function public.bitrix_id_proof_copy_alerts() to authenticated;

revoke all on function
  public.bitrix_id_proof_copy_claim(integer, integer),
  public.bitrix_id_proof_copy_mark_sending(uuid, uuid, bigint[]),
  public.bitrix_id_proof_copy_complete(uuid, uuid, text, text, bigint),
  authz.id_proof_copy_audit(text, public.bitrix_id_proof_copy_jobs, jsonb),
  authz.id_proof_copy_backoff(integer),
  authz.id_proof_copy_enqueue()
from public, anon, authenticated, service_role;
grant execute on function
  public.bitrix_id_proof_copy_claim(integer, integer),
  public.bitrix_id_proof_copy_mark_sending(uuid, uuid, bigint[]),
  public.bitrix_id_proof_copy_complete(uuid, uuid, text, text, bigint)
to service_role;

-- ===========================================================================
-- 5. Staff: manual retry and status
-- ===========================================================================

-- Booking editors of the Deal, or the Super Admin of the company: a failed or
-- unknown copy goes back to pending with fresh attempts (needs_manual_check:
-- Super Admin only, back to a read-back). An unknown one keeps
-- its prior file ids, so the next send is checked against them again.
create function public.bitrix_id_proof_copy_retry(p_job_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.bitrix_id_proof_copy_jobs%rowtype;
begin
  select * into v_job from public.bitrix_id_proof_copy_jobs j where j.id = p_job_id for update;
  if v_job.id is null or not (authz.can_edit_booking_draft(v_job.deal_id) or authz.can_switch_live_settings(v_job.legal_entity_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_job.status not in ('failed', 'unknown', 'needs_manual_check') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  -- Review E8-2: a job that needs a manual check is retried only by the Super
  -- Admin, and it is read back first (never re-sent blindly).
  if v_job.status = 'needs_manual_check' and not authz.can_switch_live_settings(v_job.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Review E7-1/E7-8: a job stopped because files were lost, or refused for
  -- its credentials, is retried only by the Super Admin; after a loss only
  -- once the copy is switched on again.
  if v_job.last_error_code in ('prior_files_lost', 'bitrix_auth_failed') then
    if not authz.can_switch_live_settings(v_job.legal_entity_id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    if v_job.last_error_code = 'prior_files_lost' and not exists (
         select 1 from public.integration_intake_config c
         where c.portal_member_id = v_job.source_portal and c.enabled and c.bitrix_id_proof_copy) then
      raise exception 'wrong_state' using errcode = '55000', hint = 'switch_off';
    end if;
  end if;
  update public.bitrix_id_proof_copy_jobs j
  set status = case when j.status in ('unknown', 'needs_manual_check') then 'unknown' else 'pending' end,
      attempts = 0, read_back_attempts = 0, next_attempt_at = now(), lease_token = null, locked_until = null, updated_at = now()
  where j.id = v_job.id returning * into v_job;
  perform authz.id_proof_copy_audit('integration.id_proof_copy_manual_retry', v_job, null);
  return jsonb_build_object('jobId', v_job.id, 'status', v_job.status);
end;
$$;

-- One row per copy job of the Deal (booking editors): codes only.
create function public.bitrix_id_proof_copy_status(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
begin
  if not authz.session_ok() or not authz.can_edit_booking_draft(p_deal_id) then
    return null;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('jobId', j.id, 'travellerId', j.traveller_id, 'idProofId', j.id_proof_id,
      'status', j.status, 'attempts', j.attempts, 'maxAttempts', j.max_attempts, 'lastErrorCode', j.last_error_code,
      'updatedAt', j.updated_at, 'sentAt', j.sent_at) order by j.created_at, j.id)
    from public.bitrix_id_proof_copy_jobs j where j.deal_id = p_deal_id), '[]'::jsonb);
end;
$$;

revoke all on function public.bitrix_id_proof_copy_retry(uuid), public.bitrix_id_proof_copy_status(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.bitrix_id_proof_copy_retry(uuid), public.bitrix_id_proof_copy_status(uuid) to authenticated;

commit;
