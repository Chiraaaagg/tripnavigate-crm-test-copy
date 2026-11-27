-- TripNavigate CRM - S11 "files to Bitrix" (2 of 6): listing, cancel, adoption, removed deals, the kick
--
-- Contract: 14-s11-files-to-bitrix-contract.md section 1.3 (class table,
-- owner approved) and 2.1; 11-s11-files-to-bitrix-contract.md revision 4,
-- 2.3 and 2.4 (e), (k); lead freeze of 27 Nov 2026.
--
-- What changes:
--   * Trigger <table>_file_move, AFTER INSERT OR UPDATE OF status, on the seven
--     source tables (traveller_id_proofs, department_evidence,
--     customer_party_documents, finance_evidence, refund_evidence,
--     supplier_money_evidence, booking_evidence). When a row becomes 'stored'
--     and its kind moves (class table below) and the company's
--     enqueue_enabled is true, one file_bitrix_moves row is created:
--       class A identity papers (box "Aadhar and Passports"):
--         traveller_id_proofs (all)       waiting (DEC-43 sends it), or
--                                         copied at once when a DEC-43 job of
--                                         the same (deal, traveller, sha256) is
--                                         already sent (the re-upload case)
--         department_evidence
--           applicant_document            copy_pending (S11 sends it)
--         customer_party_documents
--           id_proof                      no_target (tied to a customer, not a deal)
--       class B Accounts papers (the Accounts box), waiting until
--       stored_at + accounts_hold_days (90):
--         finance_evidence bank_proof, cheque_image (deal through the receipt);
--         deposit_slip is no_target (tied to a branch)
--         refund_evidence (both kinds)
--         supplier_money_evidence proforma, payment_proof, invoice, credit_note
--         booking_evidence bill, payment_proof
--         department_evidence fee_receipt, direct_payment_proof
--       Every other kind (class C) gets no row and never moves. A file whose
--       deal is not a Bitrix deal is no_target. A file of a deal the sync has
--       marked removed is listed normally; the claims skip it while the deal
--       is removed.
--     When the row leaves 'stored' before its CRM copy is gone, the move row is
--     cancelled (a row with a send in flight is cancelled by the claim once the
--     send has settled). The trigger body never raises: a failure is audited
--     as files.move_enqueue_failed (codes only) and the 10-minute sweep lists
--     the file later.
--   * Trigger bitrix_id_proof_copy_jobs_file_move_adopt, AFTER UPDATE OF status,
--     when a DEC-43 job becomes 'sent': the move row of the currently stored
--     proof with the same (deal, traveller, sha256) becomes 'copied' with the
--     job's Bitrix file id, only from 'waiting' or 'copy_pending'; in any other
--     state it audits files.move_adoption_ignored and changes nothing.
--   * Trigger deals_file_move_removed, AFTER UPDATE OF removed_at WHEN
--     (old.removed_at IS DISTINCT FROM new.removed_at): when the sync marks a
--     deal removed while Bitrix holds the only copy of one of its files, an
--     alert deal_removed_with_files opens. Never raises.
--   * authz.kick_file_move() (owner only): modelled on authz.kick_bitrix_sync
--     (20261208000110). Posts ?task=files once through pg_net with the three
--     existing Vault names (bitrix_sync_url, bitrix_sync_bearer,
--     vercel_protection_bypass). Returns false and sends nothing when Vault or
--     pg_net is absent, when there is nothing it could do (every switch Off and
--     no copy-back, in-flight check, pending delete, search or sole copy), when
--     the breaker row is locked by another kick (FOR UPDATE SKIP LOCKED) or was
--     touched less than 20 seconds ago, or when a Vault value is missing or
--     invalid. Never raises. Writes only file_move_kick_state; it never writes
--     integration_sync_dispatches, integration_sync_schedule or settings.
--     Called when a row becomes copy_pending and on adoption.
--   * Owner-only helpers used by the later files: authz.file_move_source,
--     authz.file_move_kind, authz.file_move_bucket, authz.file_move_source_stored,
--     authz.file_move_missing_sources, authz.file_move_enqueue_source,
--     authz.file_move_cancel_row, authz.file_move_cancel_source,
--     authz.file_move_delete_off, authz.file_move_open_stop.
--
-- Added audit actions (beyond the frozen list): files.move_enqueue_failed,
-- files.move_cancelled.
-- Creating the triggers takes a brief lock on nine existing tables
-- (lock_timeout 5 s). No existing function or table column is changed.
-- Nothing here contains a URL, a host, a bearer or a secret, or schedules a job.
-- Rollback: set file_move_settings.enqueue_enabled = false (audited) to stop
-- the listing; forward-only otherwise.

begin;
set local lock_timeout = '5s';

-- ===========================================================================
-- 1. The kick
-- ===========================================================================

create function authz.kick_file_move() returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_last timestamptz;
  v_url text;
  v_bearer text;
  v_bypass text;
  v_headers jsonb;
  v_id bigint;
begin
  if to_regclass('vault.decrypted_secrets') is null or to_regnamespace('net') is null then
    return false;
  end if;
  begin
    -- Nothing to do: every switch Off and nothing that ignores the switches.
    if not exists (
         select 1 from public.file_move_settings s
         where s.check_id_proof_copies or s.move_accounts_files or s.delete_after_hold)
       and not exists (
         select 1 from public.file_bitrix_moves m
         where m.state in ('restore_pending', 'copy_sending', 'copy_unknown', 'delete_pending')
            or m.relocate_due or not m.crm_copy_present) then
      return false;
    end if;

    -- Breaker: one kick at a time, at most one every 20 seconds.
    select k.last_kick_at into v_last from public.file_move_kick_state k where k.id for update skip locked;
    if not found then
      return false;
    end if;
    if v_last is not null and v_last > now() - interval '20 seconds' then
      return false;
    end if;

    -- Same names and validation as authz.kick_bitrix_sync.
    select s.decrypted_secret into v_url from vault.decrypted_secrets s where s.name = 'bitrix_sync_url';
    select s.decrypted_secret into v_bearer from vault.decrypted_secrets s where s.name = 'bitrix_sync_bearer';
    select s.decrypted_secret into v_bypass from vault.decrypted_secrets s where s.name = 'vercel_protection_bypass';
    v_url := nullif(btrim(v_url), '');
    v_bearer := nullif(btrim(v_bearer), '');
    if v_url is null or v_bearer is null or v_url !~ '^https?://[^\s?#]+$' then
      return false;
    end if;
    v_headers := jsonb_build_object(
      'Authorization', 'Bearer ' || v_bearer,
      'Content-Type', 'application/json');
    if nullif(btrim(v_bypass), '') is not null then
      v_headers := v_headers || jsonb_build_object('x-vercel-protection-bypass', btrim(v_bypass));
    end if;

    v_id := net.http_post(
      url := v_url,
      params := jsonb_build_object('task', 'files'),
      headers := v_headers,
      body := '{}'::jsonb,
      timeout_milliseconds := 90000);
    if v_id is null then
      return false;
    end if;
    update public.file_move_kick_state k set last_kick_at = now() where k.id;
    return true;
  exception when others then
    return false;
  end;
end;
$$;

-- ===========================================================================
-- 2. Source files (fixed list of seven tables; no dynamic SQL)
-- ===========================================================================

-- The facts of one source file: {legalEntityId, dealId, travellerId, kind,
-- objectPath, mime, sizeBytes, sha256, status, storedAt}; null when absent.
create function authz.file_move_source(p_table text, p_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v jsonb;
begin
  case p_table
    when 'traveller_id_proofs' then
      select jsonb_build_object('legalEntityId', f.legal_entity_id, 'dealId', f.deal_id, 'travellerId', f.traveller_id,
        'kind', null, 'objectPath', f.object_path, 'mime', f.mime, 'sizeBytes', f.size_bytes, 'sha256', f.sha256,
        'status', f.status, 'storedAt', f.stored_at)
      into v from public.traveller_id_proofs f where f.id = p_id;
    when 'department_evidence' then
      select jsonb_build_object('legalEntityId', f.legal_entity_id, 'dealId', t.deal_id, 'travellerId', null,
        'kind', f.kind, 'objectPath', f.object_path, 'mime', f.mime, 'sizeBytes', f.size_bytes, 'sha256', f.sha256,
        'status', f.status, 'storedAt', f.stored_at)
      into v from public.department_evidence f left join public.fulfilment_tasks t on t.id = f.task_id where f.id = p_id;
    when 'customer_party_documents' then
      select jsonb_build_object('legalEntityId', f.legal_entity_id, 'dealId', null, 'travellerId', null,
        'kind', f.kind, 'objectPath', f.object_path, 'mime', f.mime, 'sizeBytes', f.size_bytes, 'sha256', f.sha256,
        'status', f.status, 'storedAt', f.stored_at)
      into v from public.customer_party_documents f where f.id = p_id;
    when 'finance_evidence' then
      select jsonb_build_object('legalEntityId', f.legal_entity_id, 'dealId', r.deal_id, 'travellerId', null,
        'kind', f.kind, 'objectPath', f.object_path, 'mime', f.mime, 'sizeBytes', f.size_bytes, 'sha256', f.sha256,
        'status', f.status, 'storedAt', f.stored_at)
      into v from public.finance_evidence f left join public.customer_receipts r on r.id = f.receipt_id where f.id = p_id;
    when 'refund_evidence' then
      select jsonb_build_object('legalEntityId', f.legal_entity_id, 'dealId', f.deal_id, 'travellerId', null,
        'kind', f.subject_kind, 'objectPath', f.object_path, 'mime', f.mime, 'sizeBytes', f.size_bytes, 'sha256', f.sha256,
        'status', f.status, 'storedAt', f.stored_at)
      into v from public.refund_evidence f where f.id = p_id;
    when 'supplier_money_evidence' then
      select jsonb_build_object('legalEntityId', f.legal_entity_id, 'dealId', t.deal_id, 'travellerId', null,
        'kind', f.kind, 'objectPath', f.object_path, 'mime', f.mime, 'sizeBytes', f.size_bytes, 'sha256', f.sha256,
        'status', f.status, 'storedAt', f.stored_at)
      into v from public.supplier_money_evidence f left join public.fulfilment_tasks t on t.id = f.task_id where f.id = p_id;
    when 'booking_evidence' then
      select jsonb_build_object('legalEntityId', f.legal_entity_id, 'dealId', f.deal_id, 'travellerId', null,
        'kind', f.kind, 'objectPath', f.object_path, 'mime', f.mime, 'sizeBytes', f.size_bytes, 'sha256', f.sha256,
        'status', f.status, 'storedAt', f.stored_at)
      into v from public.booking_evidence f where f.id = p_id;
    else
      raise exception 'invalid_input' using errcode = '22023', hint = 'sourceTable';
  end case;
  return v;
end;
$$;

-- Class table (file 14 section 1.3): {file_class, kind_code} for a kind that
-- moves, null for one that stays in the CRM.
create function authz.file_move_kind(p_table text, p_kind text) returns text[]
language sql immutable set search_path = '' as $$
  select case
    when p_table = 'traveller_id_proofs' then array['id_proof', 'id']
    when p_table = 'department_evidence' and p_kind = 'applicant_document' then array['id_proof', 'id']
    when p_table = 'department_evidence' and p_kind = 'fee_receipt' then array['accounts', 'fee']
    when p_table = 'department_evidence' and p_kind = 'direct_payment_proof' then array['accounts', 'dpp']
    when p_table = 'customer_party_documents' and p_kind = 'id_proof' then array['id_proof', 'id']
    when p_table = 'finance_evidence' and p_kind = 'bank_proof' then array['accounts', 'bank']
    when p_table = 'finance_evidence' and p_kind = 'cheque_image' then array['accounts', 'chq']
    when p_table = 'finance_evidence' and p_kind = 'deposit_slip' then array['accounts', 'dep']
    when p_table = 'refund_evidence' then array['accounts', 'rfd']
    when p_table = 'supplier_money_evidence' and p_kind = 'proforma' then array['accounts', 'pro']
    when p_table = 'supplier_money_evidence' and p_kind = 'payment_proof' then array['accounts', 'pay']
    when p_table = 'supplier_money_evidence' and p_kind = 'invoice' then array['accounts', 'inv']
    when p_table = 'supplier_money_evidence' and p_kind = 'credit_note' then array['accounts', 'cn']
    when p_table = 'booking_evidence' and p_kind = 'bill' then array['accounts', 'bill']
    when p_table = 'booking_evidence' and p_kind = 'payment_proof' then array['accounts', 'pay']
  end
$$;

-- The private bucket of each source table.
create function authz.file_move_bucket(p_table text) returns text
language sql immutable set search_path = '' as $$
  select case p_table
    when 'traveller_id_proofs' then 'traveller-id-proofs'
    when 'department_evidence' then 'department-evidence'
    when 'customer_party_documents' then 'customer-party-documents'
    when 'finance_evidence' then 'finance-evidence'
    when 'refund_evidence' then 'finance-evidence'
    when 'supplier_money_evidence' then 'supplier-money'
    when 'booking_evidence' then 'booking-evidence'
  end
$$;

create function authz.file_move_source_stored(p_table text, p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((authz.file_move_source(p_table, p_id) ->> 'status') = 'stored', false)
$$;

-- Stored files of a moving kind that have no move row, oldest first.
-- p_since null = every such file (backfill); otherwise stored at or after it.
create function authz.file_move_missing_sources(p_since timestamptz, p_limit integer)
returns table (src_table text, src_id uuid)
language sql stable security definer set search_path = '' as $$
  select x.t, x.id
  from (
    select 'traveller_id_proofs'::text as t, f.id, f.stored_at from public.traveller_id_proofs f
    where f.status = 'stored'
    union all
    select 'department_evidence', f.id, f.stored_at from public.department_evidence f
    where f.status = 'stored' and f.kind in ('applicant_document', 'fee_receipt', 'direct_payment_proof')
    union all
    select 'customer_party_documents', f.id, f.stored_at from public.customer_party_documents f
    where f.status = 'stored' and f.kind = 'id_proof'
    union all
    select 'finance_evidence', f.id, f.stored_at from public.finance_evidence f
    where f.status = 'stored' and f.kind in ('bank_proof', 'cheque_image', 'deposit_slip')
    union all
    select 'refund_evidence', f.id, f.stored_at from public.refund_evidence f
    where f.status = 'stored'
    union all
    select 'supplier_money_evidence', f.id, f.stored_at from public.supplier_money_evidence f
    where f.status = 'stored' and f.kind in ('proforma', 'payment_proof', 'invoice', 'credit_note')
    union all
    select 'booking_evidence', f.id, f.stored_at from public.booking_evidence f
    where f.status = 'stored' and f.kind in ('bill', 'payment_proof')
  ) x
  where (p_since is null or x.stored_at >= p_since)
    and not exists (select 1 from public.file_bitrix_moves m where m.source_table = x.t and m.source_id = x.id)
  order by x.stored_at, x.id
  limit least(greatest(coalesce(p_limit, 100), 1), 1000)
$$;

-- ===========================================================================
-- 3. Stops and the automatic delete-switch-off
-- ===========================================================================

-- Turns the company's delete switch off (audited through the settings trigger
-- with reason "automatic stop: <code>", and files.move_switch_changed).
-- Returns whether it was on.
create function authz.file_move_delete_off(p_entity uuid, p_reason_code text) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_s public.file_move_settings%rowtype;
  v_prev text[];
begin
  select * into v_s from public.file_move_settings s where s.legal_entity_id = p_entity for update;
  if v_s.id is null or not v_s.delete_after_hold then
    return false;
  end if;
  v_prev := authz.settings_begin_change('file_move_stop', 'automatic stop: ' || p_reason_code);
  update public.file_move_settings s set delete_after_hold = false, updated_at = now() where s.id = v_s.id;
  perform authz.settings_end_change(v_prev);
  perform authz.write_audit('files.move_switch_changed', p_entity, null, 'file_move_settings', v_s.id,
    'automatic stop: ' || p_reason_code,
    jsonb_build_object('switch', 'delete_after_hold', 'before', true, 'after', false, 'automatic', true, 'reasonCode', p_reason_code));
  return true;
end;
$$;

-- Opens one alert row; with p_switch_off the delete switch goes off too.
create function authz.file_move_open_stop(p_entity uuid, p_move_id uuid, p_source_deal_id bigint, p_box text,
  p_reason_code text, p_switch_off boolean) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_stop uuid;
  v_was boolean := false;
begin
  insert into public.file_move_stops (legal_entity_id, move_id, source_deal_id, bitrix_field, reason_code)
  values (p_entity, p_move_id, p_source_deal_id, p_box, p_reason_code)
  returning id into v_stop;
  if p_switch_off then
    v_was := authz.file_move_delete_off(p_entity, p_reason_code);
  end if;
  perform authz.write_audit('files.move_stopped', p_entity, null, 'file_move_stop', v_stop, null,
    jsonb_build_object('stopId', v_stop, 'moveId', p_move_id, 'reasonCode', p_reason_code, 'deleteSwitchTurnedOff', v_was));
  return v_stop;
end;
$$;

-- ===========================================================================
-- 4. Listing and cancelling
-- ===========================================================================

-- Creates the move row of one stored source file (idempotent). Returns the new
-- row id, or null when the file does not move or already has a row.
create function authz.file_move_enqueue_source(p_table text, p_id uuid, p_via text) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v jsonb;
  v_kind text[];
  v_entity uuid;
  v_s public.file_move_settings;
  v_deal public.deals%rowtype;
  v_job public.bitrix_id_proof_copy_jobs%rowtype;
  v_m public.file_bitrix_moves%rowtype;
  v_state text;
  v_due timestamptz;
  v_field text;
  v_target boolean;
begin
  if p_via is null or p_via not in ('trigger', 'sweep', 'backfill') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'via';
  end if;
  if exists (select 1 from public.file_bitrix_moves m where m.source_table = p_table and m.source_id = p_id) then
    return null;
  end if;
  v := authz.file_move_source(p_table, p_id);
  if v is null or (v ->> 'status') is distinct from 'stored' then
    return null;
  end if;
  v_kind := authz.file_move_kind(p_table, v ->> 'kind');
  if v_kind is null then
    return null;
  end if;
  v_entity := (v ->> 'legalEntityId')::uuid;
  v_s := authz.file_move_settings_for(v_entity);
  if not v_s.enqueue_enabled then
    return null;
  end if;
  if (v ->> 'dealId') is not null then
    select * into v_deal from public.deals d where d.id = (v ->> 'dealId')::uuid;
  end if;
  v_target := v_deal.id is not null and v_deal.source_system is not distinct from 'bitrix' and v_deal.source_deal_id is not null
    and p_table <> 'customer_party_documents'
    and not (p_table = 'finance_evidence' and (v ->> 'kind') = 'deposit_slip');

  if not v_target then
    v_state := 'no_target';
  elsif v_kind[1] = 'accounts' then
    v_state := 'waiting';
    v_due := (v ->> 'storedAt')::timestamptz + make_interval(days => v_s.accounts_hold_days);
  elsif p_table = 'traveller_id_proofs' then
    v_field := 'ufCrm_1784359513';
    -- Re-upload case: the same file was already sent by DEC-43.
    select * into v_job from public.bitrix_id_proof_copy_jobs j
    where j.deal_id = v_deal.id and j.traveller_id = (v ->> 'travellerId')::uuid and j.file_sha256 = (v ->> 'sha256')
      and j.status = 'sent' and j.bitrix_file_id is not null;
    v_state := case when v_job.id is not null then 'copied' else 'waiting' end;
  else
    v_field := 'ufCrm_1784359513';
    v_state := 'copy_pending';
  end if;

  insert into public.file_bitrix_moves (legal_entity_id, source_table, source_id, file_class, kind_code, bucket_id,
    object_path, mime, size_bytes, sha256, stored_at, deal_id, source_portal, source_deal_id, traveller_id,
    bitrix_field, state, due_at, bitrix_file_id, dec43_job_id, enqueued_by)
  values (v_entity, p_table, p_id, v_kind[1], v_kind[2], authz.file_move_bucket(p_table),
    v ->> 'objectPath', v ->> 'mime', (v ->> 'sizeBytes')::integer, v ->> 'sha256', (v ->> 'storedAt')::timestamptz,
    v_deal.id, case when v_target then v_deal.source_portal end, case when v_target then v_deal.source_deal_id end,
    (v ->> 'travellerId')::uuid, v_field, v_state, v_due, v_job.bitrix_file_id, v_job.id, p_via)
  on conflict on constraint file_bitrix_moves_source_unique do nothing
  returning * into v_m;
  if v_m.id is null then
    return null;
  end if;
  perform authz.file_move_audit('files.move_enqueued', v_m, null,
    jsonb_build_object('via', p_via, 'adoptedAtCreation', v_job.id is not null, 'dec43JobId', v_job.id));
  if v_state = 'copy_pending' then
    perform authz.kick_file_move();
  end if;
  return v_m.id;
end;
$$;

-- Cancels one move row whose source file is no longer stored, unless the CRM
-- copy is already gone or a send of it may still be in flight. Returns
-- whether it cancelled.
create function authz.file_move_cancel_row(p_move_id uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_m public.file_bitrix_moves%rowtype;
begin
  update public.file_bitrix_moves m
  set state = 'cancelled', lease_token = null, locked_until = null, lease_mode = null, relocate_due = false,
      last_error_code = 'source_removed'
  where m.id = p_move_id and m.crm_copy_present
    and (m.state in ('no_target', 'waiting', 'copied', 'verified', 'needs_manual_check', 'failed', 'quarantined', 'lost_in_bitrix')
         or (m.state = 'copy_pending' and (m.locked_until is null or m.locked_until < now())))
  returning * into v_m;
  if v_m.id is null then
    return false;
  end if;
  perform authz.file_move_audit('files.move_cancelled', v_m, null, null);
  return true;
end;
$$;

create function authz.file_move_cancel_source(p_table text, p_id uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id uuid;
begin
  select m.id into v_id from public.file_bitrix_moves m where m.source_table = p_table and m.source_id = p_id;
  if v_id is not null then
    perform authz.file_move_cancel_row(v_id);
  end if;
end;
$$;

-- ===========================================================================
-- 5. Triggers on the seven source tables
-- ===========================================================================

create function authz.file_move_source_changed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    if tg_op = 'UPDATE' then
      if old.status = 'stored' and new.status is distinct from 'stored' then
        perform authz.file_move_cancel_source(tg_table_name, new.id);
        return null;
      end if;
      if old.status is not distinct from 'stored' then
        return null;
      end if;
    end if;
    if new.status = 'stored' then
      perform authz.file_move_enqueue_source(tg_table_name, new.id, 'trigger');
    end if;
  exception when others then
    -- Never block staff work: record the failure (codes only); the sweep
    -- lists the file within 10 minutes.
    perform authz.write_audit('files.move_enqueue_failed', new.legal_entity_id, null, tg_table_name, new.id, null,
      jsonb_build_object('sourceTable', tg_table_name, 'operation', lower(tg_op), 'sqlState', sqlstate));
  end;
  return null;
end;
$$;

create trigger traveller_id_proofs_file_move after insert or update of status on public.traveller_id_proofs
  for each row execute function authz.file_move_source_changed();
create trigger department_evidence_file_move after insert or update of status on public.department_evidence
  for each row execute function authz.file_move_source_changed();
create trigger customer_party_documents_file_move after insert or update of status on public.customer_party_documents
  for each row execute function authz.file_move_source_changed();
create trigger finance_evidence_file_move after insert or update of status on public.finance_evidence
  for each row execute function authz.file_move_source_changed();
create trigger refund_evidence_file_move after insert or update of status on public.refund_evidence
  for each row execute function authz.file_move_source_changed();
create trigger supplier_money_evidence_file_move after insert or update of status on public.supplier_money_evidence
  for each row execute function authz.file_move_source_changed();
create trigger booking_evidence_file_move after insert or update of status on public.booking_evidence
  for each row execute function authz.file_move_source_changed();

-- ===========================================================================
-- 6. Adoption of a DEC-43 send
-- ===========================================================================

create function authz.file_move_adopt_dec43() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_m public.file_bitrix_moves%rowtype;
begin
  begin
    select m.* into v_m
    from public.file_bitrix_moves m
    join public.traveller_id_proofs p on p.id = m.source_id
    where m.source_table = 'traveller_id_proofs' and m.deal_id = new.deal_id and m.traveller_id = new.traveller_id
      and m.sha256 = new.file_sha256 and p.status = 'stored'
    order by m.created_at desc, m.id
    limit 1
    for update of m;
    if v_m.id is null then
      return null;
    end if;
    if v_m.state in ('waiting', 'copy_pending') and new.bitrix_file_id is not null then
      update public.file_bitrix_moves m
      set state = 'copied', bitrix_file_id = new.bitrix_file_id, dec43_job_id = new.id, bitrix_field = 'ufCrm_1784359513',
          next_attempt_at = now(), lease_token = null, locked_until = null, lease_mode = null, last_error_code = null
      where m.id = v_m.id
      returning * into v_m;
      perform authz.file_move_audit('files.move_copied', v_m, null, jsonb_build_object('via', 'dec43', 'dec43JobId', new.id));
      perform authz.kick_file_move();
    else
      perform authz.file_move_audit('files.move_adoption_ignored', v_m, null, jsonb_build_object('dec43JobId', new.id));
    end if;
  exception when others then
    perform authz.write_audit('files.move_adoption_ignored', new.legal_entity_id, null, 'bitrix_id_proof_copy_job', new.id, null,
      jsonb_build_object('dec43JobId', new.id, 'sqlState', sqlstate));
  end;
  return null;
end;
$$;

create trigger bitrix_id_proof_copy_jobs_file_move_adopt after update of status on public.bitrix_id_proof_copy_jobs
  for each row when (new.status = 'sent' and old.status is distinct from 'sent')
  execute function authz.file_move_adopt_dec43();

-- ===========================================================================
-- 7. A deal removed by the sync while Bitrix holds sole copies
-- ===========================================================================

create function authz.file_move_deal_removed() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    if new.removed_at is not null and new.source_deal_id is not null
       and exists (
         select 1 from public.file_bitrix_moves m
         where m.deal_id = new.id and (m.state = 'delete_pending' or (not m.crm_copy_present and m.state <> 'lost_accepted')))
       and not exists (
         select 1 from public.file_move_stops s
         where s.source_deal_id = new.source_deal_id and s.reason_code = 'deal_removed_with_files' and s.acknowledged_at is null) then
      perform authz.file_move_open_stop(new.legal_entity_id, null, new.source_deal_id, null, 'deal_removed_with_files', false);
    end if;
  exception when others then
    perform authz.write_audit('files.move_stopped', new.legal_entity_id, null, 'deal', new.id, null,
      jsonb_build_object('reasonCode', 'deal_removed_with_files', 'failed', true, 'sqlState', sqlstate));
  end;
  return null;
end;
$$;

create trigger deals_file_move_removed after update of removed_at on public.deals
  for each row when (old.removed_at is distinct from new.removed_at)
  execute function authz.file_move_deal_removed();

revoke all on function
  authz.kick_file_move(),
  authz.file_move_source(text, uuid),
  authz.file_move_kind(text, text),
  authz.file_move_bucket(text),
  authz.file_move_source_stored(text, uuid),
  authz.file_move_missing_sources(timestamptz, integer),
  authz.file_move_delete_off(uuid, text),
  authz.file_move_open_stop(uuid, uuid, bigint, text, text, boolean),
  authz.file_move_enqueue_source(text, uuid, text),
  authz.file_move_cancel_row(uuid),
  authz.file_move_cancel_source(text, uuid),
  authz.file_move_source_changed(),
  authz.file_move_adopt_dec43(),
  authz.file_move_deal_removed()
from public, anon, authenticated, service_role;

commit;
