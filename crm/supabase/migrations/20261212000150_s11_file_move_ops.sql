-- TripNavigate CRM - S11 "files to Bitrix" (6 of 6): owner-only operator helpers
--
-- Contract: 11-s11-files-to-bitrix-contract.md revision 4, 2.4 (i), 2.8
-- (rollback) and 4.3; 14-s11-files-to-bitrix-contract.md 5.5; lead freeze of
-- 27 Nov 2026. No grants: owner SQL (and, for the tick, pg_cron) only. Each is
-- an approved operator step; nothing here runs on apply.
--
-- What changes:
--   * authz.file_move_backfill(p_limit default 5): lists stored files of a
--     moving kind that have no move row (files stored before the install),
--     oldest first, at most p_limit (1..100) per call. Owner decision 27 Nov
--     2026: the 18 existing ID proofs are test uploads and are NOT moved, so
--     this helper exists but nobody runs it. Answers {created}.
--   * authz.file_move_request_restore(p_ids uuid[], p_reason): rollback step
--     2.8 (3). Each row loses nothing: a row whose CRM copy is gone becomes
--     restore_pending and keep_in_crm (it is copied back and then stays in the
--     CRM); a row whose CRM copy is present is pinned (keep_in_crm, never
--     deleted); a delete_pending or leased row is skipped (ask again once it
--     settles). Reason 10 to 500 characters. Audit files.move_restore_requested.
--     Answers {restorePending, pinned, skipped: [ids]}.
--   * authz.provision_file_move_sweep_job(): same pattern as
--     authz.provision_machine_log_prune_job (20261208000130). Refuses (55000)
--     without pg_cron; creates file-move-sweep ('*/10 * * * *', command
--     select authz.file_move_safety_tick()) PAUSED in the same transaction;
--     leaves an existing job of that name exactly as it is; answers the job.
--   * authz.file_move_pilot_make_due(p_source_deal_id): for the rehearsal only.
--     Refuses (55000 not_pilot) unless the deal is a company's pilot deal; sets
--     due_at = now() on that deal's waiting Accounts rows; the next sweep then
--     makes them copy_pending if the Accounts switch is on and the box is set.
--     Audit files.move_pilot_made_due. Answers {madeDue}.
-- Added audit actions (beyond the frozen list): files.move_restore_requested,
-- files.move_pilot_made_due.
-- S11 tables are business-linked and are never pruned: authz.prune_machine_logs
-- is not changed.
-- Nothing here contains a URL, a host, a bearer or a secret, or schedules a
-- job on apply.

begin;
set local lock_timeout = '5s';

create function authz.file_move_backfill(p_limit integer default 5) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_created integer := 0;
  r record;
begin
  for r in select * from authz.file_move_missing_sources(null, least(greatest(coalesce(p_limit, 5), 1), 100)) loop
    if authz.file_move_enqueue_source(r.src_table, r.src_id, 'backfill') is not null then
      v_created := v_created + 1;
    end if;
  end loop;
  return jsonb_build_object('created', v_created);
end;
$$;

create function authz.file_move_request_restore(p_ids uuid[], p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_reason text;
  v_restore integer := 0;
  v_pinned integer := 0;
  v_skipped uuid[] := '{}';
  v_id uuid;
  v_m public.file_bitrix_moves%rowtype;
begin
  if p_ids is null or cardinality(p_ids) not between 1 and 500 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'ids';
  end if;
  v_reason := authz.settings_change_reason(p_reason);
  foreach v_id in array p_ids loop
    select * into v_m from public.file_bitrix_moves m where m.id = v_id for update;
    if v_m.id is null or v_m.state = 'delete_pending' or v_m.locked_until >= now()
       or v_m.state in ('cancelled', 'lost_in_bitrix', 'lost_accepted') then
      v_skipped := v_skipped || v_id;
      continue;
    end if;
    if not v_m.crm_copy_present then
      update public.file_bitrix_moves m
      set keep_in_crm = true, state = 'restore_pending', read_back_attempts = 0, restore_checked_at = null,
          next_attempt_at = now()
      where m.id = v_m.id returning * into v_m;
      v_restore := v_restore + 1;
    else
      update public.file_bitrix_moves m set keep_in_crm = true where m.id = v_m.id returning * into v_m;
      v_pinned := v_pinned + 1;
    end if;
    perform authz.file_move_audit('files.move_restore_requested', v_m, v_reason, null);
  end loop;
  if v_restore > 0 then
    perform authz.kick_file_move();
  end if;
  return jsonb_build_object('restorePending', v_restore, 'pinned', v_pinned, 'skipped', to_jsonb(v_skipped));
end;
$$;

-- Creates file-move-sweep PAUSED (cron.job.active = false, set in the same
-- transaction). A job that already exists under that name is left exactly as
-- it is. Requires pg_cron; owner only. Activating it is an approved operator
-- step.
create function authz.provision_file_move_sweep_job() returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_id bigint;
  v_result jsonb;
begin
  if to_regclass('cron.job') is null then
    raise exception 'pg_cron is not installed' using errcode = '55000';
  end if;
  execute 'select j.jobid from cron.job j where j.jobname = $1' into v_id using 'file-move-sweep';
  if v_id is null then
    execute 'select cron.schedule($1, $2, $3)' into v_id
      using 'file-move-sweep', '*/10 * * * *', 'select authz.file_move_safety_tick()';
    execute 'select cron.alter_job($1, active := false)' using v_id;
  end if;
  execute $q$
    select coalesce(jsonb_agg(jsonb_build_object('jobname', j.jobname, 'schedule', j.schedule, 'active', j.active)
                              order by j.jobname), '[]'::jsonb)
    from cron.job j where j.jobname = 'file-move-sweep'
  $q$ into v_result;
  return v_result;
end;
$$;

create function authz.file_move_pilot_make_due(p_source_deal_id bigint) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_entity uuid;
  v_n integer;
begin
  select s.legal_entity_id into v_entity from public.file_move_settings s
  where p_source_deal_id is not null and s.pilot_source_deal_id = p_source_deal_id;
  if v_entity is null then
    raise exception 'wrong_state' using errcode = '55000', hint = 'not_pilot';
  end if;
  update public.file_bitrix_moves m set due_at = now()
  where m.legal_entity_id = v_entity and m.source_deal_id = p_source_deal_id
    and m.file_class = 'accounts' and m.state = 'waiting';
  get diagnostics v_n = row_count;
  perform authz.write_audit('files.move_pilot_made_due', v_entity, null, 'file_move_settings',
    (select s.id from public.file_move_settings s where s.legal_entity_id = v_entity), null,
    jsonb_build_object('madeDue', v_n));
  return jsonb_build_object('madeDue', v_n);
end;
$$;

revoke all on function
  authz.file_move_backfill(integer),
  authz.file_move_request_restore(uuid[], text),
  authz.provision_file_move_sweep_job(),
  authz.file_move_pilot_make_due(bigint)
from public, anon, authenticated, service_role;

commit;
