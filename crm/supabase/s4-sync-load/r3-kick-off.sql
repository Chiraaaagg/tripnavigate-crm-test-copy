-- REVERSE SCRIPT R3 - not a migration. S4 build contract section 3.1.
-- Switches every event, copy and chain kick off (reverses release sub-step
-- 1b): back to tick-only sync. One audited statement; no migration, so main
-- stays equal to live. Owner SQL, covered by the step 1 approval as its undo.
-- Run R1 FIRST if the cadence is already 5 minutes, otherwise every lead and
-- deal waits for the 5-minute tick.
-- tests/supabase/s4-event-kick.real.test.ts runs this file verbatim.

select authz.set_bitrix_sync_kick(false, 'Rollback of S4 event kick: back to tick-only sync');
