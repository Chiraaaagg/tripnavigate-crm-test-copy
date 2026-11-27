-- TripNavigate CRM - S4 background sync load (1 of 4): dispatch index and settings columns
--
-- Contract: hosting-migration-2026-11-26/10-s4-sync-load-contract.md, sections
-- 2.2 (D2, D5, D9, D12, D13) and 2.5 (a) and (b); review 10a.
--
-- Why: every 30-second scheduler tick runs authz.settle_sync_dispatches(),
-- whose two UPDATE statements look for the scheduler calls that have no answer
-- yet (answered_at is null). Live there is one such row among about 41,500,
-- and no index can find it, so each tick reads the whole table twice (measured
-- 26 Nov 2026: 256,634 sequential scans, about 9 billion rows read). The
-- partial index below holds only the unanswered rows (normally one page), so
-- both statements read it instead. The statements themselves are unchanged.
--
-- What changes:
--   * integration_sync_dispatches_unanswered_idx: partial index on
--     (dispatched_at) where answered_at is null. Plain CREATE INDEX inside the
--     transaction: the table is about 385 pages, the build takes milliseconds
--     under a brief write lock. Updates of answered_at stop being HOT (a few
--     hundred a day; negligible).
--   * integration_sync_dispatches.kind: 'tick' (the pg_cron scheduler's call,
--     default, so every existing row and the tick's existing insert stay
--     'tick'), 'event' (a Bitrix event woke the worker), 'copy' (an ID-proof
--     copy job asked for a full run), 'chain' (a full run asked for one more).
--     The alert check and the admin status read only 'tick' rows (D13).
--   * integration_sync_schedule gains three settings in its single row:
--       interval_seconds   30 (today) or 300; the cadence the alert check and
--                          the admin page use. Changed only together with the
--                          pg_cron schedule by authz.set_bitrix_sync_cadence.
--       log_retention_days 14 (7 to 90): how long the nightly prune keeps the
--                          three machine logs.
--       kick_enabled       false: the database does not wake the worker on
--                          events until an owner-approved, audited
--                          authz.set_bitrix_sync_kick(true, ...) after release.
--     Constant defaults: no table rewrite. authenticated keeps its column-level
--     read (id, enabled, last_dispatched_at, updated_at); the new columns are
--     not added to it.
--
-- Nothing here creates, alters or activates a pg_cron job, deletes a row,
-- sends a request or contains a URL or a secret. Behaviour after apply: the
-- tick gets cheaper; everything else is unchanged.
-- Rollback: forward-only. The index and columns are harmless if left; the
-- operator reverse steps are in supabase/s4-sync-load/.

begin;
set local lock_timeout = '5s';

create index if not exists integration_sync_dispatches_unanswered_idx
  on public.integration_sync_dispatches (dispatched_at)
  where answered_at is null;

alter table public.integration_sync_dispatches
  add column kind text not null default 'tick'
    constraint integration_sync_dispatches_kind_check check (kind in ('tick', 'event', 'copy', 'chain'));

comment on column public.integration_sync_dispatches.kind is
  'S4: tick = pg_cron scheduler call; event = woken by a Bitrix event; copy = ID-proof copy follow-up; chain = full-run follow-up.';

alter table public.integration_sync_schedule
  add column interval_seconds integer not null default 30
    constraint integration_sync_schedule_interval_check check (interval_seconds in (30, 300)),
  add column log_retention_days integer not null default 14
    constraint integration_sync_schedule_retention_check check (log_retention_days between 7 and 90),
  add column kick_enabled boolean not null default false;

comment on column public.integration_sync_schedule.interval_seconds is
  'S4: scheduler cadence in seconds (30 or 300). Changed only with the pg_cron job by authz.set_bitrix_sync_cadence.';
comment on column public.integration_sync_schedule.log_retention_days is
  'S4: days the nightly prune keeps cron.job_run_details, integration_worker_runs and integration_sync_dispatches.';
comment on column public.integration_sync_schedule.kick_enabled is
  'S4: when true, new Bitrix events and ID-proof copy jobs wake the worker at once. Changed only by authz.set_bitrix_sync_kick.';

commit;
