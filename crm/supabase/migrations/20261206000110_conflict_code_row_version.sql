-- TripNavigate CRM - B1-1 stage 1b: authz.require_row_version raises PT409
--
-- Booking reliability fix, item B1-1 (build contract section 6, B1-1; addendum 2, gate G0).
-- PostgREST 14 treats SQLSTATE 40001 as a serialization failure and re-runs the
-- whole request without end after the client has gone. Business refusals
-- ("someone changed this", "duplicate request", ...) therefore move from 40001
-- to PT409: PostgREST's custom-status prefix, answered once as HTTP 409, with
-- code, message and hint intact (proved on PostgREST 14.18 by gate G0). The app
-- accepts both codes before this runs (src/lib/sqlstate.ts).
--
-- How this file was made: every function below is restated from its newest
-- definition in the migration history (source file named next to it), with
-- only the code literal changed. "create function" becomes "create or replace
-- function"; the body, the argument list, the return type, language,
-- volatility, security definer and set search_path are restated exactly as
-- written there. Owner, grants and comments are kept by create or replace.
-- Message tokens, hints and every condition that raises stay as they are.
-- tests/db/br-conflict-code.test.ts compares each function before and after
-- (definition with the literal put back, security definer, configuration,
-- volatility, grants, owner) and fails on any other difference.
-- Function list and live pre-check: supabase/conflict-code/.

-- Stage 1b. authz.require_row_version (called by 88 save functions) raises
-- version_changed with PT409 instead of 40001. This is the proven looper.

-- Replaces (newest definition, source migration):
--   authz.require_row_version(integer, integer)  (20261118000100_b1_service_items.sql)

begin;

-- authz.require_row_version(integer, integer): from 20261118000100_b1_service_items.sql
create or replace function authz.require_row_version(p_expected integer, p_actual integer) returns void
language plpgsql immutable set search_path = '' as $$
begin
  if p_expected is null or p_expected <> p_actual then
    raise exception 'version_changed' using errcode = 'PT409';
  end if;
end;
$$;

commit;
