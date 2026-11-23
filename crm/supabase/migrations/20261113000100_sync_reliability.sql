-- TripNavigate CRM - sync reliability (9 October 2026).
--
-- 1. Honest run counts on the admin page. public.integration_auto_sync_status()
--    gains the key "runs24h": worker and reconcile heartbeats of the last
--    24 hours counted per outcome (ok, partial, provider_error, internal_error),
--    the items those runs could not save (failed, dead-lettered) and the time of
--    the last failed run. Found on the first live day: about 10 worker runs an
--    hour ended internal_error while the page still said "Auto sync running"
--    and showed no problem, because only the last run and the reconcile
--    heartbeat were read. Counts only; no customer data. Every other key is
--    unchanged, so older app versions keep working.
--
-- 2. Lead link backfill through the full resync. A Deal stored before the
--    Bitrix LEAD_ID was read (or whose LEAD_ID changed without a new
--    DATE_MODIFY) was never re-applied: integration_enqueue_reconcile answers
--    "upToDate" for a stored Deal with the same DATE_MODIFY, so the resync
--    never queued it and deals.source_lead_id stayed empty. Each resync page
--    item may now carry "leadId" (Bitrix LEAD_ID as listed: digits, or empty
--    for none). When the stored, live Deal has the listed DATE_MODIFY and its
--    source_lead_id differs from the listed one,
--    the newest finished inbox row of that Deal (processed or ignored) is
--    re-queued (pending, attempts 0, origin manual_retry, as the
--    20261111000100 scope re-queue does) unless a row for the Deal is already
--    pending, processing or failed. The worker then reads the Deal from Bitrix
--    and the Deal apply writes the link (a changed leadId alone is applied).
--    Items without "leadId" behave exactly as before. The page result adds
--    "leadLinkRequeued". Nothing is written to Bitrix.
--
-- 3. public.integration_inbox_row_status(uuid) (new, service role only): the
--    status of one inbox row. After a fail call is refused because the row was
--    already finished, the worker counts the item by that status instead of as
--    failed. Answer {"status": ...} or null for an unknown row.
--
-- Replaces (same signatures, same grants):
--   public.integration_auto_sync_status()                           from 20261107000100
--   public.integration_resync_page(uuid, uuid, jsonb, integer, boolean)
--                                                                   from 20261107000100 (section 10 body)
-- Bodies copied unchanged except the lines marked "Sync reliability".
-- Rollback: forward-only (a new migration restoring the 20261107000100 bodies).
-- Nothing is deleted; no table or column changes.

begin;
set local lock_timeout = '15s';

create or replace function public.integration_auto_sync_status() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_job jsonb := null;
begin
  if not authz.can_admin_any('integration.manage') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if to_regclass('cron.job') is not null then
    execute $q$select jsonb_build_object('schedule', j.schedule, 'active', j.active)
               from cron.job j where j.jobname = 'bitrix-sync'$q$ into v_job;
  end if;
  return jsonb_build_object(
    'cronInstalled', to_regclass('cron.job') is not null,
    'job', v_job,
    'enabled', (select s.enabled from public.integration_sync_schedule s where s.id),
    'lastCalls', coalesce((
      select jsonb_agg(jsonb_build_object('at', d.dispatched_at, 'answeredAt', d.answered_at,
               'statusCode', d.status_code, 'ok', d.ok, 'reason', d.reason) order by d.dispatched_at desc)
      from (select * from public.integration_sync_dispatches order by dispatched_at desc limit 5) d), '[]'::jsonb),
    'lastOkCallAt', (select max(d.dispatched_at) from public.integration_sync_dispatches d where d.ok),
    'failingSince', (select min(d.dispatched_at) from public.integration_sync_dispatches d
                     where d.ok = false and d.dispatched_at > coalesce(
                       (select max(x.dispatched_at) from public.integration_sync_dispatches x where x.ok), '-infinity')),
    -- Sync reliability: every heartbeat of the last 24 hours, counted per kind and outcome.
    'runs24h', (
      select jsonb_build_object(
        'since', now() - interval '24 hours',
        'worker', jsonb_build_object(
          'ok', count(*) filter (where r.kind = 'worker' and r.outcome = 'ok'),
          'partial', count(*) filter (where r.kind = 'worker' and r.outcome = 'partial'),
          'providerError', count(*) filter (where r.kind = 'worker' and r.outcome = 'provider_error'),
          'internalError', count(*) filter (where r.kind = 'worker' and r.outcome = 'internal_error')),
        'reconcile', jsonb_build_object(
          'ok', count(*) filter (where r.kind = 'reconcile' and r.outcome = 'ok'),
          'partial', count(*) filter (where r.kind = 'reconcile' and r.outcome = 'partial'),
          'providerError', count(*) filter (where r.kind = 'reconcile' and r.outcome = 'provider_error'),
          'internalError', count(*) filter (where r.kind = 'reconcile' and r.outcome = 'internal_error')),
        'itemsFailed', coalesce(sum(r.failed), 0),
        'itemsDeadLettered', coalesce(sum(r.dead_lettered), 0),
        'lastFailedAt', max(r.finished_at) filter (where r.outcome in ('provider_error', 'internal_error')))
      from public.integration_worker_runs r
      where r.finished_at >= now() - interval '24 hours'));
end;
$$;
grant execute on function public.integration_auto_sync_status() to authenticated;

create or replace function public.integration_resync_page(
  p_job uuid, p_token uuid, p_deals jsonb, p_total integer, p_last boolean
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_job public.integration_resync_jobs%rowtype;
  v_item jsonb;
  v_id bigint;
  v_max bigint;
  v_enqueued integer := 0;
  v_n integer := 0;
  v_res jsonb;
  -- Sync reliability: Lead link backfill.
  v_cfg public.integration_intake_config%rowtype;
  v_lead_text text;
  v_lead bigint;
  v_rows integer;
  v_relinked integer := 0;
begin
  v_job := authz.require_resync_lease(p_job, p_token);
  if p_deals is null or jsonb_typeof(p_deals) <> 'array' or jsonb_array_length(p_deals) > 500 or p_last is null then
    raise exception 'invalid resync page' using errcode = '22023';
  end if;
  -- Sync reliability: the stored Deal identity (pilot entity and branch) the up-to-date check uses.
  select c.* into v_cfg from public.integration_intake_config c
  where c.portal_member_id = v_job.portal_member_id and c.enabled;
  v_max := v_job.cursor_id;
  for v_item in select * from jsonb_array_elements(p_deals) loop
    v_id := (v_item ->> 'id')::bigint;
    if v_id is null or v_id <= v_job.cursor_id then
      raise exception 'resync page out of order' using errcode = '22023';
    end if;
    insert into public.integration_resync_seen (job_id, source_deal_id) values (v_job.id, v_id)
    on conflict do nothing;
    v_res := public.integration_enqueue_reconcile(v_job.portal_member_id, v_id, (v_item ->> 'modified')::bigint);
    -- Only a new queue row counts; a manifest refusal (ignored) or a duplicate is not progress.
    if not coalesce((v_res ->> 'duplicate')::boolean, false) and not coalesce((v_res ->> 'ignored')::boolean, false) then
      v_enqueued := v_enqueued + 1;
    end if;

    -- Sync reliability: a stored, current Deal whose Lead link differs from the
    -- listed Bitrix LEAD_ID is read and applied again. Malformed leadId: no action.
    if coalesce((v_res ->> 'upToDate')::boolean, false) and v_cfg.id is not null
       and jsonb_typeof(v_item -> 'leadId') = 'string' then
      v_lead_text := v_item ->> 'leadId';
      if v_lead_text ~ '^0*$' then
        v_lead := null;
      elsif v_lead_text ~ '^[0-9]{1,18}$' then
        v_lead := v_lead_text::bigint;
      else
        v_lead_text := null;
      end if;
      if v_lead_text is not null and exists (
        select 1 from public.deals d
        where d.source_system = 'bitrix' and d.source_portal = v_job.portal_member_id
          and d.source_deal_id = v_id
          and d.legal_entity_id = v_cfg.pilot_legal_entity_id and d.branch_id = v_cfg.pilot_branch_id
          and d.removed_at is null
          -- Only when the stored version equals the listed one: a stored Deal newer than
          -- the listing is answered stale by the apply, so re-queuing it would never converge.
          and d.source_modified_at <= to_timestamp((v_item ->> 'modified')::double precision)
          and d.source_lead_id is distinct from v_lead
      ) and not exists (
        select 1 from public.integration_inbox q
        where q.portal_member_id = v_job.portal_member_id and q.source_object = 'deal'
          and q.source_deal_id = v_id and q.status in ('pending', 'processing', 'failed')
      ) then
        update public.integration_inbox i
        set status = 'pending', attempts = 0, next_attempt_at = now(), reason_code = null,
            lock_token = null, locked_until = null, origin = 'manual_retry', updated_at = now()
        where i.id = (
            select q.id from public.integration_inbox q
            where q.portal_member_id = v_job.portal_member_id and q.source_object = 'deal'
              and q.source_deal_id = v_id
            order by q.received_at desc, q.id desc
            limit 1)
          and i.status in ('processed', 'ignored');
        get diagnostics v_rows = row_count;
        v_relinked := v_relinked + v_rows;
      end if;
    end if;

    v_max := greatest(v_max, v_id);
    v_n := v_n + 1;
  end loop;
  update public.integration_resync_jobs j
  set cursor_id = v_max, scanned = j.scanned + v_n, enqueued = j.enqueued + v_enqueued,
      bitrix_total = coalesce(j.bitrix_total, case when v_job.cursor_id = 0 then p_total end),
      listing_done = p_last,
      locked_until = greatest(j.locked_until, now() + interval '60 seconds')
  where j.id = v_job.id;
  return jsonb_build_object('enqueued', v_enqueued, 'scanned', v_job.scanned + v_n, 'cursorId', v_max,
    -- Sync reliability
    'leadLinkRequeued', v_relinked);
end;
$$;

revoke all on function public.integration_resync_page(uuid, uuid, jsonb, integer, boolean)
from public, anon, authenticated, service_role;
grant execute on function public.integration_resync_page(uuid, uuid, jsonb, integer, boolean) to service_role;

-- Sync reliability: the worker asks for a row's real status after a fail call was
-- refused (the row was already finished), so a saved item is never counted as failed.
create function public.integration_inbox_row_status(p_inbox_id uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('status', i.status)
  from public.integration_inbox i
  where i.id = p_inbox_id
$$;

revoke all on function public.integration_inbox_row_status(uuid) from public, anon, authenticated, service_role;
grant execute on function public.integration_inbox_row_status(uuid) to service_role;

commit;
