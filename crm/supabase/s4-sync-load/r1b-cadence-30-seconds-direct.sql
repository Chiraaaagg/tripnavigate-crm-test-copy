-- REVERSE SCRIPT R1b - not a migration. S4 build contract section 3.1.
-- Same result as R1 when authz.set_bitrix_sync_cadence is unavailable.
-- Owner SQL, under the approval of the step it reverses. Run both statements
-- in one transaction (psql -1 -f ...). Writes no audit row by itself: record
-- the time, the person and the approval in the release record.
-- tests/supabase/s4-event-kick.real.test.ts runs this file verbatim.

select cron.alter_job((select jobid from cron.job where jobname = 'bitrix-sync'), schedule := '30 seconds');
update public.integration_sync_schedule set interval_seconds = 30, updated_at = now() where id;
