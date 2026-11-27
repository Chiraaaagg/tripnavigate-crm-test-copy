-- TripNavigate CRM - S11 "files to Bitrix" (3 of 6): worker commands (service role only)
--
-- Contract: 14-s11-files-to-bitrix-contract.md section 2.3 (rules) and 2.5;
-- 11-s11-files-to-bitrix-contract.md revision 4, 2.3, 2.4 (f) and 2.6; lead
-- freeze of 27 Nov 2026 ("Worker DB API": shapes, modes, outcomes).
--
-- The worker never says "it matched": it passes the hash and size it
-- observed, and the database compares them with its own record. A row reaches
-- delete_pending only through file_move_record_observation (second matching
-- observation, at or after delete_after, read started after the last append
-- to the box, no append in flight), and deleted only through
-- file_move_confirm_deleted after storage.objects no longer holds the path.
--
-- What changes (all new; public functions executable by service_role only):
--   public.file_move_claim(p_limit 1..5, p_lease_seconds 30..900)
--     Modes, in this order per pass: relocate, restore, delete/confirm_delete,
--     verify_copy, reverify, verify, copy, then presence. At most one job per
--     Bitrix deal per call. Every row of a deal the sync marked removed is
--     skipped in every mode.
--       copy      copy_pending; class switch on; Accounts rows only on the
--                 pilot deal while a pilot is set; no append in flight on the
--                 deal (S11 or DEC-43, either box); D6: when the box holds a
--                 sole copy the append is not handed out and those rows become
--                 restore_pending first (files.move_copy_back_before_append)
--       verify_copy copy_sending with a lapsed lease, or copy_unknown
--                 (read-back; ignores the switches: it only reads)
--       verify    copied; class switch on (Accounts: pilot rule)
--       reverify  verified, not keep_in_crm, CRM copy present,
--                 delete_after <= now(); delete switch and class switch on;
--                 pilot deal only while a pilot is set; no append in flight
--                 on the deal and box
--       delete    delete_pending while deletion is allowed (same rules)
--       confirm_delete delete_pending while deletion is not allowed now
--       restore, relocate, presence: always claimable, whatever the switches
--     Lease up to p_lease_seconds; 5 attempts, back-off 60 s x 2^(n-1) up to
--     1 h (authz.id_proof_copy_backoff), then needs_manual_check. The per-deal
--     lock is taken with pg_try_advisory_xact_lock; a busy deal is skipped.
--     Presence: one deal and box holding sole copies, at most once per 24 h.
--   public.file_move_mark_sending(p_id, p_lease_token, p_prior_file_ids)
--   public.file_move_record_observation(p_id, p_lease_token, p_bitrix_file_id,
--     p_observed_sha256, p_observed_size, p_read_started_at)
--     The second check is ordered by the database clock (review 14a P2-1):
--     the lease (leased_at, set by the claim, returned as leasedAt) must have
--     started at or after delete_after and after the box's last append;
--     p_read_started_at must lie between leased_at and now().
--   public.file_move_complete(p_id, p_lease_token, p_outcome, p_error_code, p_bitrix_file_id)
--   public.file_move_confirm_deleted(p_id, p_lease_token)
--   public.file_move_confirm_restored(p_id, p_lease_token, p_stored_sha256, p_stored_size)
--   public.file_move_lease_ok(p_id, p_lease_token, p_min_seconds): asked just
--     before the Storage remove (review 14a P3-7)
--   public.file_move_stop(p_id, p_lease_token, p_reason_code)
--   public.file_move_presence_result(p_source_deal_id, p_bitrix_field, p_lease_token, p_present_ids)
--   public.file_move_relocated(p_id, p_lease_token, p_new_file_id, p_observed_sha256, p_observed_size)
--   public.file_move_sweep()
--   authz.file_move_safety_tick() (owner and pg_cron only): sweep, then kick.
--   Owner-only helpers: authz.file_move_append_in_flight,
--   authz.file_move_box_has_sole_copy, authz.file_move_copy_back_before_append,
--   authz.file_move_may_check, authz.file_move_may_delete,
--   authz.file_move_quarantine, authz.file_move_job, authz.file_move_note_append.
--
-- Refusals: lease or token mismatch PT409 task_conflict; wrong state 55000
-- wrong_state (hint = detail); bad argument 22023 invalid_input (hint =
-- argument). No class-40 code anywhere.
-- Nothing here contains a URL, a host, a bearer or a secret, or schedules a job.
-- Rollback: switch everything Off (file_move_set_switch); forward-only otherwise.

begin;
set local lock_timeout = '5s';

-- ===========================================================================
-- 1. Rule helpers
-- ===========================================================================

-- An append is in flight for a Bitrix deal (and box, when p_box is given):
-- an S11 row of it is copy_sending or copy_unknown, or holds a live copy
-- lease (it may be between reading the box and writing it); with
-- p_include_dec43, also a DEC-43 job of that deal that is leased or unknown
-- (identity box only).
create function authz.file_move_append_in_flight(p_source_deal_id bigint, p_box text, p_exclude uuid, p_include_dec43 boolean)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
      select 1 from public.file_bitrix_moves m
      where m.source_deal_id = p_source_deal_id and (p_box is null or m.bitrix_field = p_box)
        and m.id is distinct from p_exclude
        and (m.state in ('copy_sending', 'copy_unknown')
             or (m.state = 'copy_pending' and m.lease_mode = 'copy' and m.locked_until >= now())))
    or (coalesce(p_include_dec43, false) and (p_box is null or p_box = 'ufCrm_1784359513') and exists (
      select 1 from public.bitrix_id_proof_copy_jobs j
      where j.source_deal_id = p_source_deal_id and (j.status = 'unknown' or j.locked_until >= now())))
$$;

-- "Sole copy": the CRM copy is gone (and the loss was not accepted), or the
-- row is delete_pending (its object may be gone at any moment).
create function authz.file_move_box_has_sole_copy(p_source_deal_id bigint, p_box text)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.file_bitrix_moves m
    where m.source_deal_id = p_source_deal_id and m.bitrix_field = p_box
      and (m.state = 'delete_pending' or (not m.crm_copy_present and m.state <> 'lost_accepted')))
$$;

-- D6: before any append to this box, every file of it whose only copy is in
-- Bitrix is copied back first. Rows that are free become restore_pending.
-- Returns how many rows changed.
create function authz.file_move_copy_back_before_append(p_source_deal_id bigint, p_box text) returns integer
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_n integer := 0;
  r public.file_bitrix_moves%rowtype;
begin
  for r in
    update public.file_bitrix_moves m
    set state = 'restore_pending', read_back_attempts = 0, next_attempt_at = now(), restore_checked_at = null,
        lease_token = null, locked_until = null, lease_mode = null
    where m.id in (
      select x.id from public.file_bitrix_moves x
      where x.source_deal_id = p_source_deal_id and x.bitrix_field = p_box and not x.crm_copy_present
        and x.state in ('deleted', 'quarantined', 'needs_manual_check', 'failed')
        and (x.locked_until is null or x.locked_until < now())
      for update skip locked)
    returning m.*
  loop
    v_n := v_n + 1;
    perform authz.file_move_audit('files.move_copy_back_before_append', r, null, null);
  end loop;
  return v_n;
end;
$$;

-- Copy and first check: the class switch (Accounts: box set, pilot rule).
create function authz.file_move_may_check(p_move public.file_bitrix_moves, p_s public.file_move_settings)
returns boolean language sql stable set search_path = '' as $$
  select coalesce(case when p_move.file_class = 'id_proof' then p_s.check_id_proof_copies
    else p_s.move_accounts_files and p_s.accounts_bitrix_field is not null
         and (p_s.pilot_source_deal_id is null or p_s.pilot_source_deal_id = p_move.source_deal_id) end, false)
$$;

-- Second check and deletion: delete switch, class switch, pilot scope.
create function authz.file_move_may_delete(p_move public.file_bitrix_moves, p_s public.file_move_settings)
returns boolean language sql stable set search_path = '' as $$
  select coalesce(p_s.delete_after_hold and not p_move.keep_in_crm
    and case when p_move.file_class = 'id_proof' then p_s.check_id_proof_copies else p_s.move_accounts_files end
    and (p_s.pilot_source_deal_id is null or p_s.pilot_source_deal_id = p_move.source_deal_id), false)
$$;

-- The box was written (or may have been): its last append settles now.
create function authz.file_move_note_append(p_source_deal_id bigint, p_box text, p_started boolean) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  insert into public.file_move_box_state (source_deal_id, bitrix_field, last_append_started_at, last_append_at)
  values (p_source_deal_id, p_box, case when p_started then now() end, now())
  on conflict (source_deal_id, bitrix_field) do update
    set last_append_started_at = case when p_started then now() else public.file_move_box_state.last_append_started_at end,
        last_append_at = now();
end;
$$;

-- Observed copy differs: quarantined (the CRM copy fact is not touched), an
-- alert, and the delete switch off.
create function authz.file_move_quarantine(p_move_id uuid, p_reason_code text) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_m public.file_bitrix_moves%rowtype;
begin
  update public.file_bitrix_moves m
  set state = 'quarantined', last_error_code = p_reason_code, relocate_due = false, next_attempt_at = now(),
      lease_token = null, locked_until = null, lease_mode = null
  where m.id = p_move_id
  returning * into v_m;
  perform authz.file_move_audit('files.move_quarantined', v_m, null, jsonb_build_object('reasonCode', p_reason_code));
  perform authz.file_move_open_stop(v_m.legal_entity_id, v_m.id, v_m.source_deal_id, v_m.bitrix_field, p_reason_code, true);
end;
$$;

-- The job handed to the worker (freeze shape). Bitrix ids as digit strings.
create function authz.file_move_job(p_move public.file_bitrix_moves, p_mode text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal bigint := case when p_mode = 'relocate' then coalesce(p_move.relocate_source_deal_id, p_move.source_deal_id)
                        else p_move.source_deal_id end;
  v_known jsonb := '[]'::jsonb;
begin
  if p_mode = 'relocate' then
    select coalesce(jsonb_agg(distinct k.x::text), '[]'::jsonb) into v_known
    from (
      select o.bitrix_file_id as x from public.file_bitrix_moves o
      where o.source_deal_id = v_deal and o.bitrix_field = p_move.bitrix_field and o.bitrix_file_id is not null and o.id <> p_move.id
      union
      select j.bitrix_file_id from public.bitrix_id_proof_copy_jobs j
      where p_move.bitrix_field = 'ufCrm_1784359513' and j.source_deal_id = v_deal and j.status = 'sent' and j.bitrix_file_id is not null
    ) k
    where k.x is distinct from p_move.bitrix_file_id;
  end if;
  return jsonb_build_object(
    'moveId', p_move.id, 'leaseToken', p_move.lease_token, 'mode', p_mode,
    'fileClass', p_move.file_class, 'sourceTable', p_move.source_table, 'kindCode', p_move.kind_code,
    'bitrixDealId', v_deal::text, 'bitrixField', p_move.bitrix_field,
    'bucket', p_move.bucket_id, 'objectPath', p_move.object_path, 'mime', p_move.mime, 'sizeBytes', p_move.size_bytes,
    'sha256', p_move.sha256, 'bitrixFileId', p_move.bitrix_file_id::text,
    'priorFileIds', coalesce((select jsonb_agg(u.x::text order by u.o) from unnest(p_move.prior_file_ids) with ordinality u(x, o)), '[]'::jsonb),
    'knownFileIds', v_known,
    'attempts', p_move.attempts,
    'leasedAt', p_move.leased_at);
end;
$$;

-- ===========================================================================
-- 2. Claim
-- ===========================================================================

create function public.file_move_claim(p_limit integer, p_lease_seconds integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_out jsonb := '[]'::jsonb;
  v_deals bigint[] := '{}';
  v_until timestamptz;
  v_token uuid;
  v_mode text;
  v_s public.file_move_settings;
  v_m public.file_bitrix_moves%rowtype;
  v_ids bigint[];
  r record;
  g record;
begin
  if p_limit is null or p_limit not between 1 and 5 or p_lease_seconds is null or p_lease_seconds not between 30 and 900 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'limit';
  end if;
  v_until := now() + make_interval(secs => p_lease_seconds);

  for r in
    select m.id
    from public.file_bitrix_moves m
    join public.deals d on d.id = m.deal_id
    where (m.state in ('copy_pending', 'copy_sending', 'copy_unknown', 'copied', 'verified', 'delete_pending', 'restore_pending')
           or (m.relocate_due and m.state <> 'delete_pending'))
      and m.next_attempt_at <= now()
      and (m.locked_until is null or m.locked_until < now())
      and m.source_deal_id is not null and m.bitrix_field is not null
      and d.removed_at is null
      and (m.state <> 'verified' or m.relocate_due
           or (m.delete_after <= now() and not m.keep_in_crm and m.crm_copy_present))
    order by case when m.relocate_due and m.state <> 'delete_pending' then 0
                  when m.state = 'restore_pending' then 1
                  when m.state = 'delete_pending' then 2
                  when m.state in ('copy_sending', 'copy_unknown') then 3
                  when m.state = 'verified' then 4
                  when m.state = 'copied' then 5
                  else 6 end,
             m.next_attempt_at, m.id
    limit 200
    for update of m skip locked
  loop
    exit when jsonb_array_length(v_out) >= p_limit;
    select * into v_m from public.file_bitrix_moves m where m.id = r.id;
    continue when v_m.source_deal_id = any (v_deals);
    v_s := authz.file_move_settings_for(v_m.legal_entity_id);

    v_mode := null;
    if v_m.relocate_due and v_m.state <> 'delete_pending' then
      v_mode := 'relocate';
    elsif v_m.state = 'restore_pending' then
      v_mode := 'restore';
    elsif v_m.state = 'delete_pending' then
      v_mode := case when authz.file_move_may_delete(v_m, v_s) then 'delete' else 'confirm_delete' end;
    elsif v_m.state in ('copy_sending', 'copy_unknown') then
      v_mode := 'verify_copy';
    elsif v_m.state = 'copy_pending' and authz.file_move_may_check(v_m, v_s) then
      v_mode := 'copy';
    elsif v_m.state = 'copied' and authz.file_move_may_check(v_m, v_s) then
      v_mode := 'verify';
    elsif v_m.state = 'verified' and authz.file_move_may_delete(v_m, v_s) then
      v_mode := 'reverify';
    end if;
    continue when v_mode is null;

    -- A source file that is no longer stored is neither copied nor checked.
    if v_mode in ('copy', 'verify', 'reverify') and not authz.file_move_source_stored(v_m.source_table, v_m.source_id) then
      perform authz.file_move_cancel_row(v_m.id);
      continue;
    end if;

    -- One writer per deal: the shared per-deal lock, skipped when busy.
    continue when not authz.file_move_try_deal_lock(v_m.source_deal_id);

    if v_mode = 'copy' then
      -- One append at a time per deal (S11 or DEC-43, either box).
      continue when authz.file_move_append_in_flight(v_m.source_deal_id, null, v_m.id, true);
      -- D6: never rewrite a box that holds a sole copy; copy those back first.
      if authz.file_move_box_has_sole_copy(v_m.source_deal_id, v_m.bitrix_field) then
        perform authz.file_move_copy_back_before_append(v_m.source_deal_id, v_m.bitrix_field);
        continue;
      end if;
    elsif v_mode in ('reverify', 'delete', 'confirm_delete') then
      -- No second check and no deletion while an append to this box is in flight.
      continue when authz.file_move_append_in_flight(v_m.source_deal_id, v_m.bitrix_field, null, true);
    end if;

    v_token := gen_random_uuid();
    update public.file_bitrix_moves m
    set lease_token = v_token, locked_until = v_until, lease_mode = v_mode, leased_at = now(), restore_checked_at = null
    where m.id = v_m.id
    returning * into v_m;
    v_out := v_out || jsonb_build_array(authz.file_move_job(v_m, v_mode));
    v_deals := v_deals || v_m.source_deal_id;
  end loop;

  -- Presence: one deal and box holding sole copies, checked at most once a day.
  if jsonb_array_length(v_out) < p_limit then
    for g in
      select m.source_deal_id, m.bitrix_field
      from public.file_bitrix_moves m
      join public.deals d on d.id = m.deal_id
      where not m.crm_copy_present and m.state in ('deleted', 'quarantined', 'needs_manual_check', 'failed')
        and m.bitrix_file_id is not null and not m.relocate_due and d.removed_at is null
        and m.source_deal_id is not null and m.bitrix_field is not null
      group by m.source_deal_id, m.bitrix_field
      having bool_or(m.presence_checked_at is null or m.presence_checked_at < now() - interval '24 hours')
         and bool_and(m.locked_until is null or m.locked_until < now())
      order by min(coalesce(m.presence_checked_at, '-infinity'::timestamptz)), m.source_deal_id, m.bitrix_field
      limit 10
    loop
      exit when jsonb_array_length(v_out) >= p_limit;
      continue when g.source_deal_id = any (v_deals);
      continue when not authz.file_move_try_deal_lock(g.source_deal_id);
      v_token := gen_random_uuid();
      with leased as (
        update public.file_bitrix_moves m
        set lease_token = v_token, locked_until = v_until, lease_mode = 'presence', leased_at = now()
        where m.id in (
          select x.id from public.file_bitrix_moves x
          where x.source_deal_id = g.source_deal_id and x.bitrix_field = g.bitrix_field and not x.crm_copy_present
            and x.state in ('deleted', 'quarantined', 'needs_manual_check', 'failed')
            and x.bitrix_file_id is not null and not x.relocate_due
            and (x.locked_until is null or x.locked_until < now())
          for update skip locked)
        returning m.bitrix_file_id)
      select array_agg(l.bitrix_file_id order by l.bitrix_file_id) into v_ids from leased l;
      continue when v_ids is null;
      v_out := v_out || jsonb_build_array(jsonb_build_object(
        'moveId', null, 'leaseToken', v_token, 'mode', 'presence',
        'bitrixDealId', g.source_deal_id::text, 'bitrixField', g.bitrix_field,
        'expectedFileIds', (select jsonb_agg(u.x::text order by u.x) from unnest(v_ids) u(x)),
        'leasedAt', now()));
      v_deals := v_deals || g.source_deal_id;
    end loop;
  end if;
  return v_out;
end;
$$;

-- ===========================================================================
-- 3. Mark sending (copy mode, before the Bitrix write)
-- ===========================================================================

create function public.file_move_mark_sending(p_id uuid, p_lease_token uuid, p_prior_file_ids bigint[]) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal bigint;
  v_m public.file_bitrix_moves%rowtype;
begin
  select m.source_deal_id into v_deal from public.file_bitrix_moves m where m.id = p_id;
  if v_deal is null then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  -- The per-deal lock first, before any row lock.
  perform authz.file_move_deal_lock(v_deal);
  select * into v_m from public.file_bitrix_moves m where m.id = p_id for update;
  if v_m.lease_token is distinct from p_lease_token or v_m.locked_until < now() or v_m.lease_mode is distinct from 'copy'
     or v_m.source_deal_id is distinct from v_deal then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  if v_m.state <> 'copy_pending' then
    raise exception 'wrong_state' using errcode = '55000', hint = 'state';
  end if;
  if p_prior_file_ids is null or cardinality(p_prior_file_ids) > 200
     or exists (select 1 from unnest(p_prior_file_ids) x where x is null or x <= 0) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'priorFileIds';
  end if;
  if not authz.file_move_source_stored(v_m.source_table, v_m.source_id) then
    raise exception 'wrong_state' using errcode = '55000', hint = 'source_removed';
  end if;
  if authz.file_move_append_in_flight(v_deal, null, v_m.id, true) then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  if authz.file_move_box_has_sole_copy(v_deal, v_m.bitrix_field) then
    raise exception 'wrong_state' using errcode = '55000', hint = 'sole_copy_present';
  end if;
  update public.file_bitrix_moves m
  set state = 'copy_sending', attempts = least(m.attempts + 1, 50), prior_file_ids = p_prior_file_ids
  where m.id = v_m.id
  returning * into v_m;
  perform authz.file_move_note_append(v_deal, v_m.bitrix_field, true);
  return jsonb_build_object('moveId', v_m.id, 'state', v_m.state);
end;
$$;

-- ===========================================================================
-- 4. Observations: the database compares
-- ===========================================================================

-- verify (copied):    equal -> verified, delete_after = now() + hold
-- reverify (verified): at or after delete_after, read started at or after
--                     delete_after and after the box's last append, no append
--                     in flight (checked under the per-deal lock), deletion
--                     still allowed: equal -> delete_pending; otherwise
--                     "retry" (row stays verified, lease released)
-- restore (restore_pending): equal -> restore_checked (lease kept: the worker
--                     uploads and calls file_move_confirm_restored)
-- Unequal at verify or reverify -> quarantined, alert, delete switch off.
-- Unequal at restore -> retry with back-off; the fifth time lost_in_bitrix,
-- alert, delete switch off (answer "quarantined").
-- There is no argument by which the worker can assert a match.
create function public.file_move_record_observation(p_id uuid, p_lease_token uuid, p_bitrix_file_id bigint,
  p_observed_sha256 text, p_observed_size integer, p_read_started_at timestamptz) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal bigint;
  v_m public.file_bitrix_moves%rowtype;
  v_s public.file_move_settings;
  v_last timestamptz;
  v_equal boolean;
begin
  if p_bitrix_file_id is null or p_bitrix_file_id <= 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'bitrixFileId';
  end if;
  if p_observed_sha256 is null or p_observed_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'observedSha256';
  end if;
  if p_observed_size is null or p_observed_size < 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'observedSize';
  end if;
  select m.source_deal_id into v_deal from public.file_bitrix_moves m where m.id = p_id;
  if v_deal is null then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  perform authz.file_move_deal_lock(v_deal);
  select * into v_m from public.file_bitrix_moves m where m.id = p_id for update;
  if v_m.lease_token is distinct from p_lease_token or v_m.locked_until < now() or v_m.source_deal_id is distinct from v_deal then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  if not ((v_m.state = 'copied' and v_m.lease_mode = 'verify')
          or (v_m.state = 'verified' and v_m.lease_mode = 'reverify')
          or (v_m.state = 'restore_pending' and v_m.lease_mode = 'restore')) then
    raise exception 'wrong_state' using errcode = '55000', hint = 'state';
  end if;
  if p_bitrix_file_id is distinct from v_m.bitrix_file_id then
    raise exception 'invalid_input' using errcode = '22023', hint = 'bitrixFileId';
  end if;
  v_equal := p_observed_sha256 = v_m.sha256 and p_observed_size = v_m.size_bytes;
  v_s := authz.file_move_settings_for(v_m.legal_entity_id);

  if v_m.state = 'copied' then
    if not v_equal then
      perform authz.file_move_quarantine(v_m.id, 'copy_mismatch');
      return jsonb_build_object('result', 'quarantined');
    end if;
    update public.file_bitrix_moves m
    set state = 'verified', verified_sha256 = p_observed_sha256, verified_size_bytes = p_observed_size, verified_at = now(),
        delete_after = now() + make_interval(mins => v_s.delete_hold_minutes),
        reverified_sha256 = null, reverified_size_bytes = null, reverified_at = null, reverified_after_append_at = null,
        read_back_attempts = 0, last_error_code = null,
        next_attempt_at = now() + make_interval(mins => v_s.delete_hold_minutes),
        lease_token = null, locked_until = null, lease_mode = null
    where m.id = v_m.id
    returning * into v_m;
    perform authz.file_move_audit('files.move_verified', v_m, null, null);
    return jsonb_build_object('result', 'verified');
  end if;

  if v_m.state = 'verified' then
    select b.last_append_at into v_last from public.file_move_box_state b
    where b.source_deal_id = v_deal and b.bitrix_field = v_m.bitrix_field;
    -- Review 14a P2-1: the order is decided by the database clock. The read
    -- began after this lease was handed out (leased_at), so the lease must
    -- have started at or after the hold ended and after the last append to
    -- this box settled. p_read_started_at (the worker's own figure, derived
    -- from leasedAt) is only an extra check: never before the lease, never in
    -- the future.
    if now() < v_m.delete_after
       or v_m.leased_at is null or v_m.leased_at < v_m.delete_after
       or (v_last is not null and v_m.leased_at <= v_last)
       or p_read_started_at is null or p_read_started_at < v_m.leased_at or p_read_started_at > now()
       or authz.file_move_append_in_flight(v_deal, v_m.bitrix_field, null, true)
       or not authz.file_move_may_delete(v_m, v_s)
       or exists (select 1 from public.deals d where d.id = v_m.deal_id and d.removed_at is not null)
       or not authz.file_move_source_stored(v_m.source_table, v_m.source_id) then
      update public.file_bitrix_moves m
      set next_attempt_at = now() + interval '60 seconds', lease_token = null, locked_until = null, lease_mode = null
      where m.id = v_m.id;
      return jsonb_build_object('result', 'retry');
    end if;
    if not v_equal then
      perform authz.file_move_quarantine(v_m.id, 'copy_mismatch');
      return jsonb_build_object('result', 'quarantined');
    end if;
    update public.file_bitrix_moves m
    set state = 'delete_pending', reverified_sha256 = p_observed_sha256, reverified_size_bytes = p_observed_size,
        reverified_at = now(), reverified_after_append_at = v_m.leased_at,
        read_back_attempts = 0, last_error_code = null, next_attempt_at = now(),
        lease_token = null, locked_until = null, lease_mode = null
    where m.id = v_m.id
    returning * into v_m;
    perform authz.file_move_audit('files.move_reverified', v_m, null, null);
    return jsonb_build_object('result', 'delete_pending');
  end if;

  -- restore_pending
  if not v_equal then
    if v_m.read_back_attempts + 1 >= 5 then
      update public.file_bitrix_moves m
      set state = 'lost_in_bitrix', read_back_attempts = least(m.read_back_attempts + 1, 50), last_error_code = 'copy_mismatch',
          relocate_due = false, lease_token = null, locked_until = null, lease_mode = null
      where m.id = v_m.id
      returning * into v_m;
      perform authz.file_move_audit('files.move_quarantined', v_m, null, jsonb_build_object('reasonCode', 'copy_mismatch'));
      perform authz.file_move_open_stop(v_m.legal_entity_id, v_m.id, v_m.source_deal_id, v_m.bitrix_field, 'copy_mismatch', true);
      return jsonb_build_object('result', 'quarantined');
    end if;
    update public.file_bitrix_moves m
    set read_back_attempts = m.read_back_attempts + 1, last_error_code = 'copy_mismatch',
        next_attempt_at = now() + authz.id_proof_copy_backoff(m.read_back_attempts + 1),
        restore_checked_at = null, lease_token = null, locked_until = null, lease_mode = null
    where m.id = v_m.id;
    return jsonb_build_object('result', 'retry');
  end if;
  update public.file_bitrix_moves m set restore_checked_at = now() where m.id = v_m.id;
  return jsonb_build_object('result', 'restore_checked');
end;
$$;

-- ===========================================================================
-- 5. Complete (every outcome that is not an observation)
-- ===========================================================================

-- p_outcome:
--   copied        the new file id (p_bitrix_file_id) is in the box (send or read-back)
--   unknown       the answer was lost: read back later (5 times, then needs_manual_check)
--   not_sent      the read-back found no new file: copy again later
--   retry         Bitrix down, rate limited or timed out (p_error_code)
--   failed        permanent (p_error_code)
--   deal_not_found  Bitrix does not know the deal: alert, never a deletion
--   not_in_box    the file id is not in the box: a search by hash is queued;
--                 for relocate (no candidate matched): lost_in_bitrix, alert,
--                 delete switch off
--   released      out of time before the first Bitrix call: lease released
-- verified, delete_pending, deleted and any other value are refused (22023).
create function public.file_move_complete(p_id uuid, p_lease_token uuid, p_outcome text, p_error_code text, p_bitrix_file_id bigint)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_m public.file_bitrix_moves%rowtype;
  v_sent boolean;
  v_mode text;
  v_ok boolean;
begin
  if p_outcome is null or p_outcome not in ('copied', 'unknown', 'not_sent', 'retry', 'failed', 'deal_not_found', 'not_in_box', 'released')
     or (p_error_code is not null and p_error_code !~ '^[a-z_]{1,60}$')
     or (p_outcome not in ('copied', 'released') and p_error_code is null)
     or (p_outcome = 'copied' and (p_bitrix_file_id is null or p_bitrix_file_id <= 0)) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'outcome';
  end if;
  select * into v_m from public.file_bitrix_moves m where m.id = p_id for update;
  if v_m.id is null or v_m.lease_token is distinct from p_lease_token then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  v_mode := v_m.lease_mode;
  v_sent := v_m.state in ('copy_sending', 'copy_unknown');
  v_ok := case p_outcome
    when 'copied' then v_sent and v_mode in ('copy', 'verify_copy')
    when 'unknown' then v_sent and v_mode in ('copy', 'verify_copy')
    when 'not_sent' then v_sent and v_mode in ('copy', 'verify_copy')
    when 'retry' then v_mode <> 'presence'
    when 'failed' then v_mode not in ('delete', 'confirm_delete', 'presence')
    when 'deal_not_found' then v_mode not in ('delete', 'confirm_delete', 'presence')
    when 'not_in_box' then v_mode in ('verify', 'reverify', 'restore', 'relocate')
    when 'released' then v_mode <> 'presence' and not (v_mode = 'copy' and v_m.state = 'copy_sending')
  end;
  if not coalesce(v_ok, false) then
    raise exception 'wrong_state' using errcode = '55000', hint = 'outcome_not_allowed';
  end if;
  -- Review 14a P3-6: the lease ends here, and with it any copy-back check of
  -- this lease (a later restore must check the bytes again).
  update public.file_bitrix_moves m set restore_checked_at = null where m.id = v_m.id and m.restore_checked_at is not null
  returning * into v_m;
  if v_m.id is null then
    select * into v_m from public.file_bitrix_moves m where m.id = p_id;
  end if;
  if p_outcome = 'copied' and p_bitrix_file_id = any (coalesce(v_m.prior_file_ids, '{}'::bigint[])) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'bitrixFileId';
  end if;
  -- A send was marked: whatever the outcome, the last append to the box settles now.
  if v_sent then
    perform authz.file_move_note_append(v_m.source_deal_id, v_m.bitrix_field, false);
  end if;

  if p_outcome = 'copied' then
    update public.file_bitrix_moves m
    set state = 'copied', bitrix_file_id = p_bitrix_file_id, read_back_attempts = 0, last_error_code = null,
        relocate_due = false, next_attempt_at = now(), lease_token = null, locked_until = null, lease_mode = null
    where m.id = v_m.id returning * into v_m;
    perform authz.file_move_audit('files.move_copied', v_m, null, jsonb_build_object('via', 's11'));
  elsif p_outcome = 'unknown' or (p_outcome = 'retry' and v_sent) then
    if v_m.read_back_attempts + 1 >= 5 then
      update public.file_bitrix_moves m
      set state = 'needs_manual_check', read_back_attempts = least(m.read_back_attempts + 1, 50), last_error_code = p_error_code,
          lease_token = null, locked_until = null, lease_mode = null
      where m.id = v_m.id returning * into v_m;
    else
      update public.file_bitrix_moves m
      set state = 'copy_unknown', read_back_attempts = m.read_back_attempts + 1, last_error_code = p_error_code,
          next_attempt_at = now() + authz.id_proof_copy_backoff(m.read_back_attempts + 1),
          lease_token = null, locked_until = null, lease_mode = null
      where m.id = v_m.id returning * into v_m;
    end if;
  elsif p_outcome = 'not_sent' then
    if v_m.attempts >= v_m.max_attempts then
      update public.file_bitrix_moves m
      set state = 'needs_manual_check', read_back_attempts = 0, last_error_code = p_error_code,
          lease_token = null, locked_until = null, lease_mode = null
      where m.id = v_m.id returning * into v_m;
    else
      update public.file_bitrix_moves m
      set state = 'copy_pending', read_back_attempts = 0, last_error_code = p_error_code,
          next_attempt_at = now() + authz.id_proof_copy_backoff(m.attempts),
          lease_token = null, locked_until = null, lease_mode = null
      where m.id = v_m.id returning * into v_m;
    end if;
  elsif p_outcome = 'retry' then
    if v_m.state = 'copy_pending' then
      -- Ended before the send: still uses an attempt, so retries stay bounded.
      update public.file_bitrix_moves m
      set attempts = least(m.attempts + 1, 50),
          state = case when m.attempts + 1 >= m.max_attempts then 'needs_manual_check' else m.state end,
          last_error_code = p_error_code, next_attempt_at = now() + authz.id_proof_copy_backoff(m.attempts + 1),
          lease_token = null, locked_until = null, lease_mode = null
      where m.id = v_m.id returning * into v_m;
    elsif v_m.state = 'delete_pending' then
      -- Never left half-done: keep trying, at most hourly.
      update public.file_bitrix_moves m
      set read_back_attempts = least(m.read_back_attempts + 1, 50), last_error_code = p_error_code,
          next_attempt_at = now() + authz.id_proof_copy_backoff(least(m.read_back_attempts + 1, 7)),
          lease_token = null, locked_until = null, lease_mode = null
      where m.id = v_m.id returning * into v_m;
    else
      update public.file_bitrix_moves m
      set read_back_attempts = least(m.read_back_attempts + 1, 50),
          state = case when m.read_back_attempts + 1 >= 5 then 'needs_manual_check' else m.state end,
          relocate_due = case when m.read_back_attempts + 1 >= 5 then false else m.relocate_due end,
          last_error_code = p_error_code, next_attempt_at = now() + authz.id_proof_copy_backoff(m.read_back_attempts + 1),
          lease_token = null, locked_until = null, lease_mode = null
      where m.id = v_m.id returning * into v_m;
    end if;
    perform authz.file_move_audit('files.move_retry', v_m, null, jsonb_build_object('errorCode', p_error_code, 'mode', v_mode));
  elsif p_outcome = 'failed' then
    update public.file_bitrix_moves m
    set state = 'failed', attempts = case when m.state = 'copy_pending' then least(m.attempts + 1, 50) else m.attempts end,
        relocate_due = false, last_error_code = p_error_code, lease_token = null, locked_until = null, lease_mode = null
    where m.id = v_m.id returning * into v_m;
  elsif p_outcome = 'deal_not_found' then
    update public.file_bitrix_moves m
    set state = 'needs_manual_check', relocate_due = false, last_error_code = 'deal_not_found',
        lease_token = null, locked_until = null, lease_mode = null
    where m.id = v_m.id returning * into v_m;
    perform authz.file_move_open_stop(v_m.legal_entity_id, v_m.id, v_m.source_deal_id, v_m.bitrix_field, 'deal_not_found',
      exists (select 1 from public.file_bitrix_moves o where o.source_deal_id = v_m.source_deal_id
              and (o.state = 'delete_pending' or (not o.crm_copy_present and o.state <> 'lost_accepted'))));
  elsif p_outcome = 'not_in_box' then
    if v_mode = 'relocate' then
      update public.file_bitrix_moves m
      set state = 'lost_in_bitrix', relocate_due = false, last_error_code = p_error_code,
          lease_token = null, locked_until = null, lease_mode = null
      where m.id = v_m.id returning * into v_m;
      perform authz.file_move_open_stop(v_m.legal_entity_id, v_m.id, v_m.source_deal_id, v_m.bitrix_field, 'missing_in_bitrix', true);
    else
      update public.file_bitrix_moves m
      set relocate_due = true, last_error_code = p_error_code, next_attempt_at = now(),
          lease_token = null, locked_until = null, lease_mode = null
      where m.id = v_m.id returning * into v_m;
    end if;
  else
    -- released
    update public.file_bitrix_moves m
    set lease_token = null, locked_until = null, lease_mode = null
    where m.id = v_m.id returning * into v_m;
  end if;
  return jsonb_build_object('moveId', v_m.id, 'state', v_m.state, 'attempts', v_m.attempts);
end;
$$;

-- ===========================================================================
-- 6. The two writers of crm_copy_present (they look at storage.objects)
-- ===========================================================================

-- After the Storage API remove (mode delete), or instead of it (mode
-- confirm_delete): object gone -> deleted (Bitrix holds the only copy);
-- object present -> still_present (delete mode, tried again) or
-- back_to_verified (confirm_delete mode). A copy mismatch reported by a view
-- after the second check makes the end state quarantined instead.
-- Fails closed (55000) when storage.objects does not exist.
create function public.file_move_confirm_deleted(p_id uuid, p_lease_token uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_m public.file_bitrix_moves%rowtype;
  v_present boolean;
  v_mismatch boolean;
begin
  select * into v_m from public.file_bitrix_moves m where m.id = p_id for update;
  if v_m.id is null or v_m.lease_token is distinct from p_lease_token then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  if v_m.state <> 'delete_pending' or v_m.lease_mode not in ('delete', 'confirm_delete') then
    raise exception 'wrong_state' using errcode = '55000', hint = 'state';
  end if;
  if to_regclass('storage.objects') is null then
    raise exception 'wrong_state' using errcode = '55000', hint = 'storage_unavailable';
  end if;
  v_present := exists (select 1 from storage.objects o where o.bucket_id = v_m.bucket_id and o.name = v_m.object_path);
  v_mismatch := exists (select 1 from public.file_move_stops s
                        where s.move_id = v_m.id and s.reason_code = 'copy_mismatch' and s.opened_at >= v_m.reverified_at);
  if not v_present then
    perform set_config('tripnavigate.file_move_copy_writer', 'on', true);
    update public.file_bitrix_moves m
    set state = case when v_mismatch then 'quarantined' else 'deleted' end, crm_copy_present = false, deleted_at = now(),
        presence_checked_at = now(), read_back_attempts = 0, last_error_code = case when v_mismatch then 'copy_mismatch' end,
        next_attempt_at = now(), lease_token = null, locked_until = null, lease_mode = null
    where m.id = v_m.id returning * into v_m;
    perform set_config('tripnavigate.file_move_copy_writer', '', true);
    perform authz.file_move_audit('files.move_deleted_from_crm', v_m, null, null);
    return jsonb_build_object('result', 'deleted');
  end if;
  if v_m.lease_mode = 'delete' then
    update public.file_bitrix_moves m
    set next_attempt_at = now() + interval '60 seconds', lease_token = null, locked_until = null, lease_mode = null
    where m.id = v_m.id;
    return jsonb_build_object('result', 'still_present');
  end if;
  update public.file_bitrix_moves m
  set state = case when v_mismatch then 'quarantined' else 'verified' end,
      last_error_code = case when v_mismatch then 'copy_mismatch' end,
      reverified_sha256 = null, reverified_size_bytes = null, reverified_at = null, reverified_after_append_at = null,
      next_attempt_at = now(), lease_token = null, locked_until = null, lease_mode = null
  where m.id = v_m.id;
  return jsonb_build_object('result', 'back_to_verified');
end;
$$;

-- Review 14a P3-7: asked by the worker immediately before the Storage remove.
-- Answers ok only while this delete lease is still held, the row is still
-- delete_pending, deletion is still allowed for it and at least p_min_seconds
-- of the lease are left. On "not ok" the worker does not remove anything.
create function public.file_move_lease_ok(p_id uuid, p_lease_token uuid, p_min_seconds integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_m public.file_bitrix_moves%rowtype;
  v_ok boolean;
begin
  if p_min_seconds is null or p_min_seconds not between 0 and 900 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'minSeconds';
  end if;
  select * into v_m from public.file_bitrix_moves m where m.id = p_id for update;
  v_ok := v_m.id is not null and v_m.lease_token is not distinct from p_lease_token and p_lease_token is not null
    and v_m.lease_mode = 'delete' and v_m.state = 'delete_pending'
    and v_m.locked_until >= now() + make_interval(secs => p_min_seconds)
    and authz.file_move_may_delete(v_m, authz.file_move_settings_for(v_m.legal_entity_id));
  return jsonb_build_object('ok', coalesce(v_ok, false));
end;
$$;

-- After a database-compared copy-back download (restore_checked, in THIS
-- lease) and the upload of those bytes to the old path, the worker reads the
-- object back from Storage and passes the hash and size it observed there.
-- The database compares them with the row (review 14a P3-6: not size only)
-- and checks storage.objects holds the object with that size -> restored (the
-- CRM holds the file again; pinned rows stop at verified, others go through
-- the first check, hold and second check again); otherwise missing.
-- Fails closed (55000) when storage.objects does not exist.
create function public.file_move_confirm_restored(p_id uuid, p_lease_token uuid, p_stored_sha256 text, p_stored_size integer)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_m public.file_bitrix_moves%rowtype;
  v_s public.file_move_settings;
begin
  select * into v_m from public.file_bitrix_moves m where m.id = p_id for update;
  if v_m.id is null or v_m.lease_token is distinct from p_lease_token then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  if v_m.state <> 'restore_pending' or v_m.lease_mode is distinct from 'restore' then
    raise exception 'wrong_state' using errcode = '55000', hint = 'state';
  end if;
  if v_m.restore_checked_at is null or v_m.leased_at is null or v_m.restore_checked_at < v_m.leased_at then
    raise exception 'wrong_state' using errcode = '55000', hint = 'not_checked';
  end if;
  if p_stored_sha256 is null or p_stored_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'storedSha256';
  end if;
  if p_stored_size is null or p_stored_size < 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'storedSize';
  end if;
  if to_regclass('storage.objects') is null then
    raise exception 'wrong_state' using errcode = '55000', hint = 'storage_unavailable';
  end if;
  if p_stored_sha256 <> v_m.sha256 or p_stored_size <> v_m.size_bytes or not exists (
       select 1 from storage.objects o
       where o.bucket_id = v_m.bucket_id and o.name = v_m.object_path
         and (o.metadata ->> 'size') ~ '^[0-9]{1,18}$'
         and (o.metadata ->> 'size')::bigint = v_m.size_bytes) then
    -- The fifth time in a row (for example a different object already sits at
    -- the old path and is never overwritten): needs a person. An alert opens;
    -- the row still blocks appends to this box (D6) until a Super Admin acts.
    if v_m.read_back_attempts + 1 >= 5 then
      update public.file_bitrix_moves m
      set state = 'needs_manual_check', read_back_attempts = least(m.read_back_attempts + 1, 50),
          last_error_code = case when p_stored_sha256 <> v_m.sha256 or p_stored_size <> v_m.size_bytes then 'restore_mismatch' else 'restore_missing' end,
          restore_checked_at = null, lease_token = null, locked_until = null, lease_mode = null
      where m.id = v_m.id returning * into v_m;
      perform authz.file_move_audit('files.move_stopped', v_m, null, jsonb_build_object('reasonCode', v_m.last_error_code));
      return jsonb_build_object('result', 'missing');
    end if;
    update public.file_bitrix_moves m
    set read_back_attempts = least(m.read_back_attempts + 1, 50),
        last_error_code = case when p_stored_sha256 <> v_m.sha256 or p_stored_size <> v_m.size_bytes then 'restore_mismatch' else 'restore_missing' end,
        next_attempt_at = now() + authz.id_proof_copy_backoff(m.read_back_attempts + 1),
        restore_checked_at = null, lease_token = null, locked_until = null, lease_mode = null
    where m.id = v_m.id;
    return jsonb_build_object('result', 'missing');
  end if;
  v_s := authz.file_move_settings_for(v_m.legal_entity_id);
  perform set_config('tripnavigate.file_move_copy_writer', 'on', true);
  update public.file_bitrix_moves m
  set crm_copy_present = true,
      state = case when m.keep_in_crm then 'verified' else 'copied' end,
      verified_sha256 = case when m.keep_in_crm then m.sha256 end,
      verified_size_bytes = case when m.keep_in_crm then m.size_bytes end,
      verified_at = case when m.keep_in_crm then m.restore_checked_at end,
      delete_after = case when m.keep_in_crm then m.restore_checked_at + make_interval(mins => v_s.delete_hold_minutes) end,
      reverified_sha256 = null, reverified_size_bytes = null, reverified_at = null, reverified_after_append_at = null,
      restore_checked_at = null, read_back_attempts = 0, last_error_code = null, next_attempt_at = now(),
      lease_token = null, locked_until = null, lease_mode = null
  where m.id = v_m.id returning * into v_m;
  perform set_config('tripnavigate.file_move_copy_writer', '', true);
  perform authz.file_move_audit('files.move_restored', v_m, null, null);
  return jsonb_build_object('result', 'restored');
end;
$$;

-- ===========================================================================
-- 7. Stop, presence result, relocation
-- ===========================================================================

-- prior_files_lost (row failed), copy_mismatch (quarantined), missing_in_bitrix
-- (lost_in_bitrix), deal_not_found (needs_manual_check). Turns the delete
-- switch off (audited) and opens an alert.
create function public.file_move_stop(p_id uuid, p_lease_token uuid, p_reason_code text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_m public.file_bitrix_moves%rowtype;
  v_stop uuid;
begin
  if p_reason_code is null or p_reason_code not in ('prior_files_lost', 'copy_mismatch', 'missing_in_bitrix', 'deal_not_found') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end if;
  select * into v_m from public.file_bitrix_moves m where m.id = p_id for update;
  if v_m.id is null or v_m.lease_token is distinct from p_lease_token then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  if v_m.state = 'delete_pending' then
    raise exception 'wrong_state' using errcode = '55000', hint = 'state';
  end if;
  if v_m.state in ('copy_sending', 'copy_unknown') then
    perform authz.file_move_note_append(v_m.source_deal_id, v_m.bitrix_field, false);
  end if;
  update public.file_bitrix_moves m
  set state = case p_reason_code when 'prior_files_lost' then 'failed' when 'copy_mismatch' then 'quarantined'
                                 when 'missing_in_bitrix' then 'lost_in_bitrix' else 'needs_manual_check' end,
      last_error_code = p_reason_code, relocate_due = false, lease_token = null, locked_until = null, lease_mode = null
  where m.id = v_m.id returning * into v_m;
  if p_reason_code = 'copy_mismatch' then
    perform authz.file_move_audit('files.move_quarantined', v_m, null, jsonb_build_object('reasonCode', p_reason_code));
  end if;
  v_stop := authz.file_move_open_stop(v_m.legal_entity_id, v_m.id, v_m.source_deal_id, v_m.bitrix_field, p_reason_code, true);
  return jsonb_build_object('stopId', v_stop);
end;
$$;

-- The ids present in the box of a presence job. A row whose id is present is
-- marked checked (a quarantined one is copied back, which compares its hash
-- again); a missing id queues a search by hash. p_present_ids null = Bitrix
-- answered "deal not found": alert, delete switch off. Answers
-- {checked, missing} (plus dealNotFound: true in that case).
create function public.file_move_presence_result(p_source_deal_id bigint, p_bitrix_field text, p_lease_token uuid,
  p_present_ids bigint[]) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entity uuid;
  v_checked integer := 0;
  v_missing integer := 0;
  r public.file_bitrix_moves%rowtype;
begin
  if p_source_deal_id is null or p_source_deal_id <= 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'sourceDealId';
  end if;
  if p_bitrix_field is null or p_bitrix_field !~ '^ufCrm_[0-9A-Za-z_]{1,40}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'bitrixField';
  end if;
  if p_present_ids is not null and (cardinality(p_present_ids) > 500
     or exists (select 1 from unnest(p_present_ids) x where x is null or x <= 0)) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'presentIds';
  end if;
  select m.legal_entity_id into v_entity from public.file_bitrix_moves m
  where m.source_deal_id = p_source_deal_id and m.bitrix_field = p_bitrix_field and m.lease_mode = 'presence'
    and m.lease_token = p_lease_token and m.locked_until >= now()
  limit 1;
  if v_entity is null then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  if p_present_ids is null then
    update public.file_bitrix_moves m
    -- presence_checked_at too: the deal is read again after 24 hours, not on
    -- every safety run (one alert, not one per run).
    set lease_token = null, locked_until = null, lease_mode = null, last_error_code = 'deal_not_found',
        presence_checked_at = now()
    where m.source_deal_id = p_source_deal_id and m.bitrix_field = p_bitrix_field and m.lease_token = p_lease_token;
    perform authz.file_move_open_stop(v_entity, null, p_source_deal_id, p_bitrix_field, 'deal_not_found', true);
    return jsonb_build_object('checked', 0, 'missing', 0, 'dealNotFound', true);
  end if;
  for r in
    select * from public.file_bitrix_moves m
    where m.source_deal_id = p_source_deal_id and m.bitrix_field = p_bitrix_field and m.lease_token = p_lease_token
    for update
  loop
    if r.bitrix_file_id = any (p_present_ids) then
      v_checked := v_checked + 1;
      update public.file_bitrix_moves m
      set presence_checked_at = now(),
          state = case when m.state = 'quarantined' then 'restore_pending' else m.state end,
          read_back_attempts = case when m.state = 'quarantined' then 0 else m.read_back_attempts end,
          next_attempt_at = now(), lease_token = null, locked_until = null, lease_mode = null
      where m.id = r.id;
    else
      v_missing := v_missing + 1;
      update public.file_bitrix_moves m
      set relocate_due = true, last_error_code = 'missing_at_presence', next_attempt_at = now(),
          lease_token = null, locked_until = null, lease_mode = null
      where m.id = r.id;
    end if;
  end loop;
  if v_missing > 0 then
    perform authz.kick_file_move();
  end if;
  return jsonb_build_object('checked', v_checked, 'missing', v_missing);
end;
$$;

-- One relocation candidate: the database compares the observed hash and size.
-- Match -> the row takes the new file id (and the new Bitrix deal, when the
-- Super Admin named one). A deleted row stays deleted with the new id (the
-- database has just compared its hash) and a restore_pending row stays
-- restore_pending; any other row that has lost its CRM copy becomes
-- restore_pending (copied back); a row that still has its CRM copy gets a
-- fresh first check (copied). No match -> no_match (lease kept for the next
-- candidate).
create function public.file_move_relocated(p_id uuid, p_lease_token uuid, p_new_file_id bigint,
  p_observed_sha256 text, p_observed_size integer) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_m public.file_bitrix_moves%rowtype;
  v_deal bigint;
begin
  if p_new_file_id is null or p_new_file_id <= 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'newFileId';
  end if;
  if p_observed_sha256 is null or p_observed_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'observedSha256';
  end if;
  if p_observed_size is null or p_observed_size < 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'observedSize';
  end if;
  select * into v_m from public.file_bitrix_moves m where m.id = p_id for update;
  if v_m.id is null or v_m.lease_token is distinct from p_lease_token or v_m.locked_until < now()
     or v_m.lease_mode is distinct from 'relocate' then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  v_deal := coalesce(v_m.relocate_source_deal_id, v_m.source_deal_id);
  if p_observed_sha256 <> v_m.sha256 or p_observed_size <> v_m.size_bytes
     or exists (select 1 from public.file_bitrix_moves o
                where o.id <> v_m.id and o.source_deal_id = v_deal and o.bitrix_field = v_m.bitrix_field
                  and o.bitrix_file_id = p_new_file_id) then
    return jsonb_build_object('result', 'no_match');
  end if;
  update public.file_bitrix_moves m
  set bitrix_file_id = p_new_file_id, source_deal_id = v_deal, relocate_source_deal_id = null, relocate_due = false,
      presence_checked_at = now(), read_back_attempts = 0, last_error_code = null, next_attempt_at = now(),
      state = case
        when m.state in ('deleted', 'restore_pending') then m.state
        when not m.crm_copy_present then 'restore_pending'
        else 'copied' end,
      verified_sha256 = case when m.crm_copy_present then null else m.verified_sha256 end,
      verified_size_bytes = case when m.crm_copy_present then null else m.verified_size_bytes end,
      verified_at = case when m.crm_copy_present then null else m.verified_at end,
      delete_after = case when m.crm_copy_present then null else m.delete_after end,
      reverified_sha256 = case when m.crm_copy_present then null else m.reverified_sha256 end,
      reverified_size_bytes = case when m.crm_copy_present then null else m.reverified_size_bytes end,
      reverified_at = case when m.crm_copy_present then null else m.reverified_at end,
      reverified_after_append_at = case when m.crm_copy_present then null else m.reverified_after_append_at end,
      lease_token = null, locked_until = null, lease_mode = null
  where m.id = v_m.id returning * into v_m;
  perform authz.file_move_audit('files.move_relocated', v_m, null, jsonb_build_object('phase', 'found'));
  return jsonb_build_object('result', 'relocated');
end;
$$;

-- ===========================================================================
-- 8. Sweep and the safety tick
-- ===========================================================================

-- Lists files stored since the install that have no move row (a failed
-- listing), makes due Accounts rows copy_pending (due, Accounts switch on,
-- Accounts box set, deal not removed), and counts identity rows still waiting
-- a day after they were stored. Answers {created, madeDue, stuck}.
create function public.file_move_sweep() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_since timestamptz;
  v_created integer := 0;
  v_due integer := 0;
  v_stuck integer := 0;
  r record;
begin
  select k.installed_at into v_since from public.file_move_kick_state k where k.id;
  for r in select * from authz.file_move_missing_sources(coalesce(v_since, now()), 500) loop
    begin
      if authz.file_move_enqueue_source(r.src_table, r.src_id, 'sweep') is not null then
        v_created := v_created + 1;
      end if;
    exception when others then
      perform authz.write_audit('files.move_enqueue_failed', null, null, r.src_table, r.src_id, null,
        jsonb_build_object('sourceTable', r.src_table, 'operation', 'sweep', 'sqlState', sqlstate));
    end;
  end loop;

  with due as (
    update public.file_bitrix_moves m
    set state = 'copy_pending', bitrix_field = s.accounts_bitrix_field, next_attempt_at = now()
    from public.file_move_settings s, public.deals d
    where s.legal_entity_id = m.legal_entity_id and d.id = m.deal_id
      and m.state = 'waiting' and m.file_class = 'accounts' and m.due_at <= now()
      and s.move_accounts_files and s.accounts_bitrix_field is not null and d.removed_at is null
    returning m.id)
  select count(*)::integer into v_due from due;

  select count(*)::integer into v_stuck from public.file_bitrix_moves m
  where m.file_class = 'id_proof' and m.state in ('waiting', 'copy_pending') and m.stored_at < now() - interval '1 day';

  if v_due > 0 then
    perform authz.kick_file_move();
  end if;
  return jsonb_build_object('created', v_created, 'madeDue', v_due, 'stuck', v_stuck);
end;
$$;

-- What the 10-minute job runs: the sweep, then one kick (never raises).
create function authz.file_move_safety_tick() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v jsonb;
begin
  v := public.file_move_sweep();
  return v || jsonb_build_object('kicked', authz.kick_file_move());
end;
$$;

-- Both lines are required: the owner's default privileges in public grant new
-- functions to service_role automatically on the hosted database.
revoke all on function
  authz.file_move_append_in_flight(bigint, text, uuid, boolean),
  authz.file_move_box_has_sole_copy(bigint, text),
  authz.file_move_copy_back_before_append(bigint, text),
  authz.file_move_may_check(public.file_bitrix_moves, public.file_move_settings),
  authz.file_move_may_delete(public.file_bitrix_moves, public.file_move_settings),
  authz.file_move_note_append(bigint, text, boolean),
  authz.file_move_quarantine(uuid, text),
  authz.file_move_job(public.file_bitrix_moves, text),
  authz.file_move_safety_tick(),
  public.file_move_claim(integer, integer),
  public.file_move_mark_sending(uuid, uuid, bigint[]),
  public.file_move_record_observation(uuid, uuid, bigint, text, integer, timestamptz),
  public.file_move_complete(uuid, uuid, text, text, bigint),
  public.file_move_confirm_deleted(uuid, uuid),
  public.file_move_confirm_restored(uuid, uuid, text, integer),
  public.file_move_lease_ok(uuid, uuid, integer),
  public.file_move_stop(uuid, uuid, text),
  public.file_move_presence_result(bigint, text, uuid, bigint[]),
  public.file_move_relocated(uuid, uuid, bigint, text, integer),
  public.file_move_sweep()
from public, anon, authenticated, service_role;
grant execute on function
  public.file_move_claim(integer, integer),
  public.file_move_mark_sending(uuid, uuid, bigint[]),
  public.file_move_record_observation(uuid, uuid, bigint, text, integer, timestamptz),
  public.file_move_complete(uuid, uuid, text, text, bigint),
  public.file_move_confirm_deleted(uuid, uuid),
  public.file_move_confirm_restored(uuid, uuid, text, integer),
  public.file_move_lease_ok(uuid, uuid, integer),
  public.file_move_stop(uuid, uuid, text),
  public.file_move_presence_result(bigint, text, uuid, bigint[]),
  public.file_move_relocated(uuid, uuid, bigint, text, integer),
  public.file_move_sweep()
to service_role;

commit;
