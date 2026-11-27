-- TripNavigate CRM - S11 "files to Bitrix" (4 of 6): view path and Super Admin commands
--
-- Contract: 14-s11-files-to-bitrix-contract.md sections 2.4, 2.5 and 2.7;
-- 11-s11-files-to-bitrix-contract.md revision 4, 2.4 (g), (h) and the frozen
-- seven-row table; lead freeze of 27 Nov 2026 ("View DB API", "Staff DB API").
--
-- View path (no Bitrix id, box key or file id ever reaches the user's session):
--   public.file_view_begin(p_source_table, p_source_id) (authenticated)
--     Dispatches with a fixed CASE on the seven table names (no dynamic SQL;
--     any other name is refused with 22023) and calls exactly the existing
--     authorize function of that table, so the same rule decides and the same
--     audit row is written as today; a refusal propagates unchanged:
--       traveller_id_proofs       traveller_id_proof_authorize_download
--       department_evidence       department_evidence_authorize_download
--       customer_party_documents  customer_party_document_authorize_download
--       finance_evidence          finance_evidence_authorize_download
--       refund_evidence           refund_evidence_authorize_download
--       supplier_money_evidence   supplier_money_evidence_authorize_download
--       booking_evidence          booking_authorize_evidence_download
--     Answers that function's own {objectPath, fileName, mime} plus
--     location 'crm', or location 'bitrix' and a one-time viewId when the CRM
--     copy is gone (crm_copy_present false) or the row is delete_pending. A
--     Bitrix view writes a file_bitrix_views row; 30 Bitrix views by one
--     person within a minute are refused (PT429 view_limit).
--   public.file_view_resolve(p_view_id) (service_role): the Bitrix location
--     of a view, once, within 60 seconds of its start, unfinished views only;
--     otherwise P0002 not_found.
--   public.file_view_finish(p_view_id, p_outcome) (authenticated): same
--     person, once. served | bitrix_unavailable | mismatch |
--     not_found_in_bitrix | deal_not_found | unreadable_in_bitrix (no link,
--     another host or a redirect: an alert only, review 14a P3-3); every outcome except
--     bitrix_unavailable needs a resolved view (so a person cannot trip the
--     safety stop by calling this directly). mismatch quarantines the row and
--     turns the delete switch off; not_found_in_bitrix queues a search by hash;
--     deal_not_found opens an alert. Audit files.served_from_bitrix.
-- Super Admin commands (authenticated; authz.can_switch_live_settings of the
-- intake configuration's pilot company, the test DEC-43 uses; reason 10 to 500
-- characters through authz.settings_change_reason; every change audited):
--   file_move_settings_get, file_move_set_switch, file_move_set_hold,
--   file_move_set_accounts_box, file_move_set_pilot, file_move_acknowledge_stop,
--   file_move_alerts, file_move_retry, file_move_relocate, file_move_accept_lost.
--   The delete switch may be turned on the first time only while a pilot deal
--   is set (55000 pilot_required) and never while a stop is unacknowledged
--   (55000 open_stops). The Accounts box cannot be changed once a row has used
--   it (55000 box_in_use).
-- Added audit actions (beyond the frozen list): files.move_stop_acknowledged.
-- Setting changes use files.move_switch_changed with the setting named.
-- Nothing here contains a URL, a host, a bearer or a secret, or schedules a job.
-- Rollback: forward-only. The new app falls back to the old download path when
-- file_view_begin is missing (old database).

begin;
set local lock_timeout = '5s';

-- ===========================================================================
-- 1. View path
-- ===========================================================================

create function public.file_view_begin(p_source_table text, p_source_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_answer jsonb;
  v_m public.file_bitrix_moves%rowtype;
  v_uid uuid := (select auth.uid());
  v_view uuid;
begin
  if p_source_table is null or p_source_table not in ('traveller_id_proofs', 'department_evidence', 'customer_party_documents',
       'finance_evidence', 'refund_evidence', 'supplier_money_evidence', 'booking_evidence') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'sourceTable';
  end if;
  if p_source_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'sourceId';
  end if;
  -- The existing authorize function decides, audits and may refuse.
  v_answer := case p_source_table
    when 'traveller_id_proofs' then public.traveller_id_proof_authorize_download(p_source_id)
    when 'department_evidence' then public.department_evidence_authorize_download(p_source_id)
    when 'customer_party_documents' then public.customer_party_document_authorize_download(p_source_id)
    when 'finance_evidence' then public.finance_evidence_authorize_download(p_source_id)
    when 'refund_evidence' then public.refund_evidence_authorize_download(p_source_id)
    when 'supplier_money_evidence' then public.supplier_money_evidence_authorize_download(p_source_id)
    when 'booking_evidence' then public.booking_authorize_evidence_download(p_source_id)
  end;
  if v_answer is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_m from public.file_bitrix_moves m where m.source_table = p_source_table and m.source_id = p_source_id;
  if v_m.id is null or (v_m.crm_copy_present and v_m.state <> 'delete_pending') then
    return v_answer || jsonb_build_object('location', 'crm');
  end if;
  if v_uid is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- One count at a time per person.
  perform pg_advisory_xact_lock(hashtextextended('file_view_limit:' || v_uid::text, 0));
  if (select count(*) from public.file_bitrix_views v
      where v.actor_user_id = v_uid and v.started_at > now() - interval '1 minute') >= 30 then
    raise exception 'view_limit' using errcode = 'PT429';
  end if;
  insert into public.file_bitrix_views (legal_entity_id, actor_user_id, move_id)
  values (v_m.legal_entity_id, v_uid, v_m.id)
  returning id into v_view;
  return v_answer || jsonb_build_object('location', 'bitrix', 'viewId', v_view);
end;
$$;

-- Server only (service role), straight after file_view_begin allowed the view.
create function public.file_view_resolve(p_view_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_move uuid;
  v_m public.file_bitrix_moves%rowtype;
begin
  update public.file_bitrix_views v set resolved_at = now()
  where v.id = p_view_id and v.resolved_at is null and v.outcome is null and v.started_at > now() - interval '60 seconds'
  returning v.move_id into v_move;
  if v_move is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select * into v_m from public.file_bitrix_moves m where m.id = v_move;
  if v_m.bitrix_file_id is null or v_m.source_deal_id is null or v_m.bitrix_field is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  return jsonb_build_object('bitrixDealId', v_m.source_deal_id::text, 'bitrixField', v_m.bitrix_field,
    'bitrixFileId', v_m.bitrix_file_id::text, 'sha256', v_m.sha256, 'sizeBytes', v_m.size_bytes, 'mime', v_m.mime);
end;
$$;

create function public.file_view_finish(p_view_id uuid, p_outcome text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_view public.file_bitrix_views%rowtype;
  v_m public.file_bitrix_moves%rowtype;
begin
  if p_outcome is null or p_outcome not in ('served', 'bitrix_unavailable', 'mismatch', 'not_found_in_bitrix', 'deal_not_found',
       'unreadable_in_bitrix') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'outcome';
  end if;
  select * into v_view from public.file_bitrix_views v where v.id = p_view_id for update;
  if v_view.id is null or v_view.actor_user_id is distinct from (select auth.uid()) or not authz.session_ok() then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_view.outcome is not null then
    raise exception 'wrong_state' using errcode = '55000', hint = 'finished';
  end if;
  if p_outcome <> 'bitrix_unavailable' and v_view.resolved_at is null then
    raise exception 'wrong_state' using errcode = '55000', hint = 'not_resolved';
  end if;
  update public.file_bitrix_views v set outcome = p_outcome, finished_at = now() where v.id = v_view.id;

  select * into v_m from public.file_bitrix_moves m where m.id = v_view.move_id for update;
  if p_outcome = 'mismatch' then
    if v_m.state = 'delete_pending' then
      -- The delete step settles it: confirm_deleted ends quarantined.
      perform authz.file_move_open_stop(v_m.legal_entity_id, v_m.id, v_m.source_deal_id, v_m.bitrix_field, 'copy_mismatch', true);
    else
      perform authz.file_move_quarantine(v_m.id, 'copy_mismatch');
    end if;
  elsif p_outcome = 'not_found_in_bitrix' then
    if v_m.state = 'delete_pending' then
      perform authz.file_move_open_stop(v_m.legal_entity_id, v_m.id, v_m.source_deal_id, v_m.bitrix_field, 'missing_in_bitrix', true);
    elsif v_m.state not in ('lost_in_bitrix', 'lost_accepted') and not v_m.relocate_due then
      update public.file_bitrix_moves m set relocate_due = true, last_error_code = 'missing_at_view', next_attempt_at = now()
      where m.id = v_m.id;
      perform authz.kick_file_move();
    end if;
  elsif p_outcome = 'deal_not_found' then
    perform authz.file_move_open_stop(v_m.legal_entity_id, v_m.id, v_m.source_deal_id, v_m.bitrix_field, 'deal_not_found', true);
  elsif p_outcome = 'unreadable_in_bitrix' then
    -- Review 14a P3-3: the file could not be read (no link, another host, a
    -- redirect), which is not a different file. Alert only: no quarantine,
    -- the delete switch stays as it is. One open alert per move is enough.
    if not exists (select 1 from public.file_move_stops s
                   where s.move_id = v_m.id and s.reason_code = 'view_unreadable' and s.acknowledged_at is null) then
      perform authz.file_move_open_stop(v_m.legal_entity_id, v_m.id, v_m.source_deal_id, v_m.bitrix_field, 'view_unreadable', false);
    end if;
  end if;
  perform authz.write_audit('files.served_from_bitrix', v_m.legal_entity_id,
    (select d.branch_id from public.deals d where d.id = v_m.deal_id), 'file_bitrix_view', v_view.id, null,
    jsonb_build_object('viewId', v_view.id, 'moveId', v_m.id, 'sourceTable', v_m.source_table, 'sourceId', v_m.source_id,
      'outcome', p_outcome));
  return jsonb_build_object('outcome', p_outcome);
end;
$$;

-- ===========================================================================
-- 2. Super Admin helpers
-- ===========================================================================

-- The company whose settings the Super Admin screen shows and changes: the
-- pilot company of the single intake configuration, when the caller may
-- switch its live settings; null otherwise.
create function authz.file_move_admin_entity() returns uuid
language sql stable security definer set search_path = '' as $$
  select c.pilot_legal_entity_id
  from public.integration_intake_config c
  where (select count(*) from public.integration_intake_config) = 1
    and authz.can_switch_live_settings(c.pilot_legal_entity_id)
$$;

-- The same, for commands: refuses when intake is not configured or the caller
-- is not that company's Super Admin. Returns the settings row, locked
-- (created with the defaults on first use).
create function authz.file_move_admin_settings() returns public.file_move_settings
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entity uuid;
  v public.file_move_settings;
begin
  if (select count(*) from public.integration_intake_config) <> 1 then
    raise exception 'wrong_state' using errcode = '55000', hint = 'not_configured';
  end if;
  v_entity := authz.file_move_admin_entity();
  if v_entity is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  insert into public.file_move_settings (legal_entity_id) values (v_entity)
  on conflict (legal_entity_id) do nothing;
  select * into v from public.file_move_settings s where s.legal_entity_id = v_entity for update;
  return v;
end;
$$;

-- ===========================================================================
-- 3. Settings
-- ===========================================================================

-- null for anyone but the Super Admin.
create function public.file_move_settings_get() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_entity uuid;
  v public.file_move_settings;
  v_row boolean;
begin
  v_entity := authz.file_move_admin_entity();
  if v_entity is null then
    return null;
  end if;
  v_row := exists (select 1 from public.file_move_settings s where s.legal_entity_id = v_entity);
  v := authz.file_move_settings_for(v_entity);
  return jsonb_build_object(
    'checkIdProofCopies', v.check_id_proof_copies,
    'moveAccountsFiles', v.move_accounts_files,
    'deleteAfterHold', v.delete_after_hold,
    'deleteHoldMinutes', v.delete_hold_minutes,
    'accountsHoldDays', v.accounts_hold_days,
    'accountsBox', v.accounts_bitrix_field,
    'pilotBitrixDealId', v.pilot_source_deal_id::text,
    'deleteEverOn', v.delete_ever_on,
    'enqueueEnabled', v.enqueue_enabled,
    'openStops', (select count(*)::integer from public.file_move_stops s
                  where s.legal_entity_id = v_entity and s.acknowledged_at is null),
    'updatedAt', case when v_row then v.updated_at end);
end;
$$;

create function public.file_move_set_switch(p_switch text, p_on boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.file_move_settings;
  v_reason text;
  v_before boolean;
  v_prev text[];
begin
  if p_switch is null or p_switch not in ('check_id_proof_copies', 'move_accounts_files', 'delete_after_hold') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'switch';
  end if;
  if p_on is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'on';
  end if;
  v := authz.file_move_admin_settings();
  v_reason := authz.settings_change_reason(p_reason);
  v_before := case p_switch when 'check_id_proof_copies' then v.check_id_proof_copies
                            when 'move_accounts_files' then v.move_accounts_files
                            else v.delete_after_hold end;
  if v_before = p_on then
    return jsonb_build_object('changed', false, 'switch', p_switch, 'on', p_on);
  end if;
  if p_switch = 'delete_after_hold' and p_on then
    if not v.delete_ever_on and v.pilot_source_deal_id is null then
      raise exception 'wrong_state' using errcode = '55000', hint = 'pilot_required';
    end if;
    if exists (select 1 from public.file_move_stops s where s.legal_entity_id = v.legal_entity_id and s.acknowledged_at is null) then
      raise exception 'wrong_state' using errcode = '55000', hint = 'open_stops';
    end if;
  end if;
  v_prev := authz.settings_begin_change('file_move_set_switch', v_reason);
  update public.file_move_settings s
  set check_id_proof_copies = case when p_switch = 'check_id_proof_copies' then p_on else s.check_id_proof_copies end,
      move_accounts_files = case when p_switch = 'move_accounts_files' then p_on else s.move_accounts_files end,
      delete_after_hold = case when p_switch = 'delete_after_hold' then p_on else s.delete_after_hold end,
      delete_ever_on = s.delete_ever_on or (p_switch = 'delete_after_hold' and p_on),
      updated_by = (select auth.uid())
  where s.id = v.id;
  perform authz.settings_end_change(v_prev);
  perform authz.write_audit('files.move_switch_changed', v.legal_entity_id, null, 'file_move_settings', v.id, v_reason,
    jsonb_build_object('switch', p_switch, 'before', v_before, 'after', p_on, 'automatic', false));
  if p_on then
    perform authz.kick_file_move();
  end if;
  return jsonb_build_object('changed', true, 'switch', p_switch, 'on', p_on);
end;
$$;

create function public.file_move_set_hold(p_minutes integer, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.file_move_settings;
  v_reason text;
  v_prev text[];
begin
  if p_minutes is null or p_minutes not between 15 and 43200 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'minutes';
  end if;
  v := authz.file_move_admin_settings();
  v_reason := authz.settings_change_reason(p_reason);
  if v.delete_hold_minutes = p_minutes then
    return jsonb_build_object('changed', false, 'deleteHoldMinutes', p_minutes);
  end if;
  v_prev := authz.settings_begin_change('file_move_set_hold', v_reason);
  update public.file_move_settings s set delete_hold_minutes = p_minutes, updated_by = (select auth.uid()) where s.id = v.id;
  perform authz.settings_end_change(v_prev);
  perform authz.write_audit('files.move_switch_changed', v.legal_entity_id, null, 'file_move_settings', v.id, v_reason,
    jsonb_build_object('setting', 'delete_hold_minutes', 'before', v.delete_hold_minutes, 'after', p_minutes));
  return jsonb_build_object('changed', true, 'deleteHoldMinutes', p_minutes);
end;
$$;

-- p_item_key null clears the box (only while no row has used it).
create function public.file_move_set_accounts_box(p_item_key text, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.file_move_settings;
  v_reason text;
  v_prev text[];
begin
  if p_item_key is not null and (p_item_key !~ '^ufCrm_[0-9A-Za-z_]{1,40}$' or p_item_key = 'ufCrm_1784359513') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'itemKey';
  end if;
  v := authz.file_move_admin_settings();
  v_reason := authz.settings_change_reason(p_reason);
  if v.accounts_bitrix_field is not distinct from p_item_key then
    return jsonb_build_object('changed', false, 'accountsBox', p_item_key);
  end if;
  if v.accounts_bitrix_field is not null and exists (
       select 1 from public.file_bitrix_moves m
       where m.legal_entity_id = v.legal_entity_id and m.file_class = 'accounts' and m.bitrix_field = v.accounts_bitrix_field) then
    raise exception 'wrong_state' using errcode = '55000', hint = 'box_in_use';
  end if;
  v_prev := authz.settings_begin_change('file_move_set_accounts_box', v_reason);
  update public.file_move_settings s set accounts_bitrix_field = p_item_key, updated_by = (select auth.uid()) where s.id = v.id;
  perform authz.settings_end_change(v_prev);
  perform authz.write_audit('files.move_switch_changed', v.legal_entity_id, null, 'file_move_settings', v.id, v_reason,
    -- Review 14a P3-5: that the box changed, not the Bitrix key itself.
    jsonb_build_object('setting', 'accounts_bitrix_field', 'changed', true, 'wasSet', v.accounts_bitrix_field is not null,
      'isSet', p_item_key is not null));
  return jsonb_build_object('changed', true, 'accountsBox', p_item_key);
end;
$$;

-- p_source_deal_id null clears the pilot: the company-wide start of deletion.
create function public.file_move_set_pilot(p_source_deal_id bigint, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.file_move_settings;
  v_reason text;
  v_prev text[];
begin
  if p_source_deal_id is not null and p_source_deal_id <= 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'sourceDealId';
  end if;
  v := authz.file_move_admin_settings();
  v_reason := authz.settings_change_reason(p_reason);
  if p_source_deal_id is not null and not exists (
       select 1 from public.deals d
       where d.legal_entity_id = v.legal_entity_id and d.source_system = 'bitrix' and d.source_deal_id = p_source_deal_id) then
    raise exception 'invalid_input' using errcode = '22023', hint = 'sourceDealId';
  end if;
  if v.pilot_source_deal_id is not distinct from p_source_deal_id then
    return jsonb_build_object('changed', false, 'pilotBitrixDealId', p_source_deal_id::text);
  end if;
  v_prev := authz.settings_begin_change('file_move_set_pilot', v_reason);
  update public.file_move_settings s set pilot_source_deal_id = p_source_deal_id, updated_by = (select auth.uid()) where s.id = v.id;
  perform authz.settings_end_change(v_prev);
  perform authz.write_audit('files.move_switch_changed', v.legal_entity_id, null, 'file_move_settings', v.id, v_reason,
    jsonb_build_object('setting', 'pilot_source_deal_id', 'pilotSet', p_source_deal_id is not null,
      'wasSet', v.pilot_source_deal_id is not null));
  return jsonb_build_object('changed', true, 'pilotBitrixDealId', p_source_deal_id::text);
end;
$$;

create function public.file_move_acknowledge_stop(p_stop_id uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_stop public.file_move_stops%rowtype;
  v_reason text;
begin
  select * into v_stop from public.file_move_stops s where s.id = p_stop_id for update;
  if v_stop.id is null or not authz.can_switch_live_settings(v_stop.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_reason := authz.settings_change_reason(p_reason);
  if v_stop.acknowledged_at is not null then
    raise exception 'wrong_state' using errcode = '55000', hint = 'acknowledged';
  end if;
  update public.file_move_stops s
  set acknowledged_at = now(), acknowledged_by = (select auth.uid()), acknowledge_reason = v_reason
  where s.id = v_stop.id;
  perform authz.write_audit('files.move_stop_acknowledged', v_stop.legal_entity_id, null, 'file_move_stop', v_stop.id, v_reason,
    jsonb_build_object('stopId', v_stop.id, 'moveId', v_stop.move_id, 'reasonCode', v_stop.reason_code));
  return jsonb_build_object('stopId', v_stop.id);
end;
$$;

-- ===========================================================================
-- 4. Alerts (codes, ids and times only)
-- ===========================================================================

create function public.file_move_alerts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_entity uuid;
  v_since timestamptz;
begin
  v_entity := authz.file_move_admin_entity();
  if v_entity is null then
    return null;
  end if;
  select k.installed_at into v_since from public.file_move_kick_state k where k.id;
  return jsonb_build_object(
    'stops', coalesce((
      select jsonb_agg(jsonb_build_object('stopId', x.id, 'moveId', x.move_id, 'bitrixDealId', x.source_deal_id::text,
          'reasonCode', x.reason_code, 'openedAt', x.opened_at, 'acknowledgedAt', x.acknowledged_at)
        order by (x.acknowledged_at is null) desc, x.opened_at desc)
      from (select s.* from public.file_move_stops s where s.legal_entity_id = v_entity
            order by (s.acknowledged_at is null) desc, s.opened_at desc limit 100) x), '[]'::jsonb),
    'items', coalesce((
      select jsonb_agg(jsonb_build_object('moveId', y.id, 'kind', y.kind, 'fileClass', y.file_class, 'sourceTable', y.source_table,
          'state', y.state, 'lastErrorCode', y.last_error_code, 'bitrixDealId', y.source_deal_id::text, 'updatedAt', y.updated_at)
        order by y.updated_at desc, y.id)
      from (
        select z.* from (
          select m.id, m.file_class, m.source_table, m.state, m.last_error_code, m.source_deal_id, m.updated_at,
            case
              when m.state = 'quarantined' then 'quarantined'
              when m.state = 'needs_manual_check' then 'needs_manual_check'
              when m.state = 'lost_in_bitrix' then 'lost_in_bitrix'
              when m.state = 'failed' then 'failed'
              when m.state in ('waiting', 'copy_pending') and exists (
                select 1 from public.file_bitrix_moves l
                where l.source_deal_id = m.source_deal_id and l.bitrix_field = m.bitrix_field and l.state = 'lost_in_bitrix')
                then 'blocked_by_lost_file'
              when m.file_class = 'id_proof' and m.state in ('waiting', 'copy_pending') and m.stored_at < now() - interval '1 day'
                then 'stuck'
              when m.state = 'verified' and m.delete_after <= now() and not m.keep_in_crm
                and authz.file_move_append_in_flight(m.source_deal_id, m.bitrix_field, null, true)
                then 'deletion_waiting'
            end as kind
          from public.file_bitrix_moves m
          where m.legal_entity_id = v_entity
            and m.state in ('quarantined', 'needs_manual_check', 'lost_in_bitrix', 'failed', 'waiting', 'copy_pending', 'verified')
        ) z
        where z.kind is not null
        order by z.updated_at desc, z.id
        limit 200) y), '[]'::jsonb),
    'counts', jsonb_build_object(
      'noTarget', (select count(*)::integer from public.file_bitrix_moves m where m.legal_entity_id = v_entity and m.state = 'no_target'),
      'missedEnqueue', (select count(*)::integer from public.file_bitrix_moves m where m.legal_entity_id = v_entity and m.enqueued_by = 'sweep')
                       + (select count(*)::integer from authz.file_move_missing_sources(coalesce(v_since, now()), 1000)),
      'waitingAccounts', (select count(*)::integer from public.file_bitrix_moves m
                          where m.legal_entity_id = v_entity and m.file_class = 'accounts' and m.state = 'waiting'),
      'soleCopies', (select count(*)::integer from public.file_bitrix_moves m
                     where m.legal_entity_id = v_entity and not m.crm_copy_present),
      -- Review 14a P3-12: move rows whose CRM deal row no longer exists (there
      -- is no foreign key); such rows drop out of every claim and presence run.
      'orphaned', (select count(*)::integer from public.file_bitrix_moves m
                   where m.legal_entity_id = v_entity and m.deal_id is not null
                     and not exists (select 1 from public.deals d where d.id = m.deal_id))));
end;
$$;

-- ===========================================================================
-- 5. Row actions (Super Admin of the row's company)
-- ===========================================================================

-- "Try again". Always a read-back or a copy-back first, never a blind re-send:
--   no CRM copy          -> restore_pending (lost_in_bitrix: a new search by hash)
--   lost_in_bitrix       -> copied again by its engine (S11: copy_pending; DEC-43 proofs: waiting)
--   a Bitrix file id     -> copied (a fresh first check)
--   a send was marked    -> copy_unknown (read back)
--   otherwise            -> copy_pending (S11) or waiting (DEC-43 proofs)
create function public.file_move_retry(p_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_m public.file_bitrix_moves%rowtype;
  v_state text;
  v_relocate boolean := false;
  v_clear_id boolean := false;
begin
  select * into v_m from public.file_bitrix_moves m where m.id = p_id for update;
  if v_m.id is null or not authz.can_switch_live_settings(v_m.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_m.state not in ('needs_manual_check', 'failed', 'quarantined', 'lost_in_bitrix') then
    raise exception 'wrong_state' using errcode = '55000', hint = 'state';
  end if;
  if v_m.locked_until >= now() then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  if not v_m.crm_copy_present then
    if v_m.state = 'lost_in_bitrix' then
      v_state := 'lost_in_bitrix';
      v_relocate := true;
    else
      v_state := 'restore_pending';
    end if;
  elsif v_m.state = 'lost_in_bitrix' then
    v_state := case when v_m.source_table = 'traveller_id_proofs' then 'waiting' else 'copy_pending' end;
    v_clear_id := true;
  elsif v_m.bitrix_file_id is not null then
    v_state := 'copied';
  elsif v_m.prior_file_ids is not null and v_m.source_table <> 'traveller_id_proofs' then
    v_state := 'copy_unknown';
  elsif v_m.source_table = 'traveller_id_proofs' then
    v_state := 'waiting';
  else
    v_state := 'copy_pending';
  end if;
  update public.file_bitrix_moves m
  set state = v_state, relocate_due = v_relocate, attempts = 0, read_back_attempts = 0, next_attempt_at = now(),
      last_error_code = null, restore_checked_at = null,
      bitrix_file_id = case when v_clear_id then null else m.bitrix_file_id end,
      verified_sha256 = case when v_state in ('copied', 'copy_pending', 'waiting', 'copy_unknown') then null else m.verified_sha256 end,
      verified_size_bytes = case when v_state in ('copied', 'copy_pending', 'waiting', 'copy_unknown') then null else m.verified_size_bytes end,
      verified_at = case when v_state in ('copied', 'copy_pending', 'waiting', 'copy_unknown') then null else m.verified_at end,
      delete_after = case when v_state in ('copied', 'copy_pending', 'waiting', 'copy_unknown') then null else m.delete_after end,
      lease_token = null, locked_until = null, lease_mode = null
  where m.id = v_m.id returning * into v_m;
  perform authz.file_move_audit('files.move_retry', v_m, null, jsonb_build_object('by', 'super_admin'));
  perform authz.kick_file_move();
  return jsonb_build_object('moveId', v_m.id, 'state', v_m.state);
end;
$$;

-- For a deal merged in Bitrix (or a fresh search on the same deal): the
-- worker searches the named deal's box by hash.
create function public.file_move_relocate(p_id uuid, p_new_source_deal_id bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_m public.file_bitrix_moves%rowtype;
begin
  select * into v_m from public.file_bitrix_moves m where m.id = p_id for update;
  if v_m.id is null or not authz.can_switch_live_settings(v_m.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_new_source_deal_id is null or p_new_source_deal_id <= 0 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'newSourceDealId';
  end if;
  if v_m.bitrix_file_id is null or v_m.bitrix_field is null
     or v_m.state not in ('copied', 'verified', 'deleted', 'restore_pending', 'quarantined', 'needs_manual_check', 'failed', 'lost_in_bitrix') then
    raise exception 'wrong_state' using errcode = '55000', hint = 'state';
  end if;
  if v_m.locked_until >= now() then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  update public.file_bitrix_moves m
  set relocate_due = true,
      relocate_source_deal_id = case when p_new_source_deal_id = m.source_deal_id then null else p_new_source_deal_id end,
      read_back_attempts = 0, next_attempt_at = now()
  where m.id = v_m.id returning * into v_m;
  perform authz.file_move_audit('files.move_relocated', v_m, null,
    jsonb_build_object('phase', 'requested', 'otherDeal', v_m.relocate_source_deal_id is not null));
  perform authz.kick_file_move();
  return jsonb_build_object('moveId', v_m.id);
end;
$$;

-- "Accept this file is lost": releases the deal blocked by the sole-copy rule.
create function public.file_move_accept_lost(p_id uuid, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_m public.file_bitrix_moves%rowtype;
  v_reason text;
begin
  select * into v_m from public.file_bitrix_moves m where m.id = p_id for update;
  if v_m.id is null or not authz.can_switch_live_settings(v_m.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_reason := authz.settings_change_reason(p_reason);
  if v_m.state <> 'lost_in_bitrix' then
    raise exception 'wrong_state' using errcode = '55000', hint = 'state';
  end if;
  if v_m.locked_until >= now() then
    raise exception 'task_conflict' using errcode = 'PT409';
  end if;
  update public.file_bitrix_moves m
  set state = 'lost_accepted', relocate_due = false, relocate_source_deal_id = null
  where m.id = v_m.id returning * into v_m;
  perform authz.file_move_audit('files.move_lost_accepted', v_m, v_reason, null);
  perform authz.kick_file_move();
  return jsonb_build_object('moveId', v_m.id, 'state', 'lost_accepted');
end;
$$;

revoke all on function
  public.file_view_begin(text, uuid),
  public.file_view_resolve(uuid),
  public.file_view_finish(uuid, text),
  authz.file_move_admin_entity(),
  authz.file_move_admin_settings(),
  public.file_move_settings_get(),
  public.file_move_set_switch(text, boolean, text),
  public.file_move_set_hold(integer, text),
  public.file_move_set_accounts_box(text, text),
  public.file_move_set_pilot(bigint, text),
  public.file_move_acknowledge_stop(uuid, text),
  public.file_move_alerts(),
  public.file_move_retry(uuid),
  public.file_move_relocate(uuid, bigint),
  public.file_move_accept_lost(uuid, text)
from public, anon, authenticated, service_role;
grant execute on function public.file_view_resolve(uuid) to service_role;
grant execute on function
  public.file_view_begin(text, uuid),
  public.file_view_finish(uuid, text),
  public.file_move_settings_get(),
  public.file_move_set_switch(text, boolean, text),
  public.file_move_set_hold(integer, text),
  public.file_move_set_accounts_box(text, text),
  public.file_move_set_pilot(bigint, text),
  public.file_move_acknowledge_stop(uuid, text),
  public.file_move_alerts(),
  public.file_move_retry(uuid),
  public.file_move_relocate(uuid, bigint),
  public.file_move_accept_lost(uuid, text)
to authenticated;

commit;
