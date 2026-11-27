-- REVERSE SCRIPT R1 - not a migration. S4 build contract section 3.1.
-- Restores the 30-second Bitrix sync schedule (reverses the step 2 schedule
-- change). Owner SQL on the database named in the approval, under that
-- approval only. One audited statement; it does not change the job's active
-- flag or the pause switch.
-- Check afterwards: cron.job 'bitrix-sync' schedule = '30 seconds', active
-- unchanged; integration_auto_sync_status() intervalSeconds = 30.
-- After R1 the nightly prune still keeps up (up to 50,000 rows a night against
-- about 5,750 worker-run rows a day at 30 seconds); R2 is not needed for that.
-- tests/supabase/s4-event-kick.real.test.ts runs this file verbatim.

select authz.set_bitrix_sync_cadence(30, 'Rollback of S4 schedule change: restore 30-second sync');
