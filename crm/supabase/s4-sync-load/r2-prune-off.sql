-- REVERSE SCRIPT R2 - not a migration. S4 build contract section 3.1.
-- Stops the automatic nightly prune and returns to the two old clean-ups
-- (reverses step 3). Owner SQL, under that step's approval. Run both
-- statements in one transaction (psql -1 -f ...). Writes no audit row by
-- itself: record the time, the person and the approval in the release record.
-- Rows already deleted stay deleted; they can only be restored from a daily
-- backup (machine logs; the owner approved their removal).
-- tests/supabase/s4-event-kick.real.test.ts runs this file verbatim.

select cron.alter_job(jobid, active := false) from cron.job where jobname = 'machine-log-prune';
select cron.alter_job(jobid, active := true)  from cron.job
 where jobname in ('bitrix-sync-heartbeat-cleanup', 'bitrix-sync-dispatch-cleanup');
