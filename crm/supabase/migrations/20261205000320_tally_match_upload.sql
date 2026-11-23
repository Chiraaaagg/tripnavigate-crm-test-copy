-- TripNavigate CRM - Accounts phase 3, track C (3 of 3): matching upload of
-- Tally's Day Book (Tally's voucher numbers come back).
-- Contract: accounts-phase3-2026-11-12/contract.md sections 7.4, 13, 14,
-- 17.1, 17.3, 19 (C extracts the internals of accounts_tally_match /
-- accounts_tally_exception), 21 LD17.
--
-- The app parses the Day Book (S/modules/accounts-desk/tally-daybook.ts: no
-- DTD, no entities, 10 MiB and 5,000 vouchers at most) and sends one row per
-- voucher: {tnTag | null, voucherRef, voucherDate, voucherType | null,
-- amountPaise}. The narration itself never reaches the database.
--
-- What this file changes:
--   1. Shared internals (no grant): authz.tally_apply_match(...) and
--      authz.tally_apply_exception(...) - the insert-or-update and audit of
--      a match / an exception, extracted unchanged from
--      public.accounts_tally_match / public.accounts_tally_exception
--      (replace 20261203000330:138 / :206; same signatures, refusals,
--      results and audit), now also used by the matching upload.
--   2. authz.tally_match_evaluate(p_entity, p_rows): the outcome of every
--      row against tally_export_lines (tag -> XML file line -> record) and the
--      record's exported amount:
--        no_tag             the narration has no TN:<file>/<line> tag
--        not_found          the tag names no line of an XML file of this
--                           company, or the record can no longer be matched
--        duplicate_in_file  a later row with the same tag or the same record
--                           (the first one is evaluated)
--        already_matched    the record is matched (or has an open exception)
--        amount_differs     the Tally amount is not the exported amount
--        matched            otherwise
--   3. C4 public.accounts_tally_match_stage(p_entity, p_file_name, p_file_sha256,
--      p_rows, p_request_id)  A; the same file (sha256) twice while not
--      cancelled -> already_recorded (hint batchId=<id>); returns the batch
--      {batchId, fileName, status, rowCount, summary, proposalHash, stagedAt,
--      stagedByName, appliedAt}. Audit accounts.tally_match.staged (counts).
--   4. C5 public.accounts_tally_match_apply(p_batch_id, p_expected_proposal_hash,
--      p_request_id)  A; Tally entity lock exclusive; evaluates the stored
--      rows again and refuses version_changed when anything changed since
--      staging; matched rows -> voucher_ref / voucher_date / matched (the
--      match rules); amount_differs rows -> an exception with the Tally amount
--      for the exception owner (the exception rules; the existing
--      tally_exception notice fires); other rows change nothing. Audit
--      accounts.tally_match.applied {batchId, matched, exceptions}.
--   5. C6 public.accounts_tally_match_cancel(p_batch_id, p_request_id)  A;
--      staged -> cancelled. Audit accounts.tally_match.cancelled.
--   6. R-C4 public.accounts_tally_match_get(p_batch_id, p_outcome, p_after,
--      p_limit)  A; else null. Keyset on the row number (p_after text).
--
-- Refusal tokens: already_recorded (55000), version_changed (40001),
-- wrong_state (55000), invalid_input (22023, hint = field), not_authorized
-- (42501), not_found (P0002), request_conflict (40001), and the existing
-- match / exception tokens on the single-record commands.
-- Lock order (17.1): apply takes the Tally entity lock exclusive first, then
-- the Tally rows by id; it never locks a source row.
-- Rollback (forward-only): a NEW migration restoring accounts_tally_match /
-- accounts_tally_exception from 20261203000330 and revoking C4-C6 / R-C4.
-- Never delete batches or rows.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Shared internals (extracted from 20261203000330)
-- ===========================================================================

-- Marks one record matched (insert or update) and writes accounts.tally_matched.
-- The caller holds the locks and has checked the state (p_from).
create function authz.tally_apply_match(p_kind text, p_record_id uuid, p_entity uuid, p_branch uuid, p_deal uuid,
  p_tr public.tally_records, p_ref text, p_date date, p_from text) returns public.tally_records
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_tr public.tally_records%rowtype := p_tr;
begin
  if v_tr.id is null then
    insert into public.tally_records (legal_entity_id, branch_id, deal_id, record_kind, record_id, status, voucher_ref, voucher_date,
      matched_by, matched_at, updated_by)
    values (p_entity, p_branch, p_deal, p_kind, p_record_id, 'matched', p_ref, p_date, (select auth.uid()), now(), (select auth.uid()))
    returning * into v_tr;
  else
    update public.tally_records r
    set status = 'matched', voucher_ref = p_ref, voucher_date = p_date, matched_by = (select auth.uid()), matched_at = now(),
        row_version = r.row_version + 1, updated_at = now(), updated_by = (select auth.uid())
    where r.id = v_tr.id
    returning * into v_tr;
  end if;
  perform authz.write_audit('accounts.tally_matched', p_entity, p_branch, p_kind, p_record_id, null,
    jsonb_build_object('tallyRecordId', v_tr.id, 'rowVersion', v_tr.row_version, 'fromStatus', p_from,
      'voucherRef', v_tr.voucher_ref, 'voucherDate', to_char(v_tr.voucher_date, 'YYYY-MM-DD')));
  return v_tr;
end;
$$;

-- Raises an exception on one record (insert or update) and writes
-- accounts.tally_exception_raised. The caller holds the locks and has checked the state.
create function authz.tally_apply_exception(p_kind text, p_record_id uuid, p_entity uuid, p_branch uuid, p_deal uuid,
  p_tr public.tally_records, p_reason text, p_amount bigint, p_from text) returns public.tally_records
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_tr public.tally_records%rowtype := p_tr;
  v_prev_ref text := p_tr.voucher_ref;
  v_prev_date date := p_tr.voucher_date;
begin
  if v_tr.id is null then
    insert into public.tally_records (legal_entity_id, branch_id, deal_id, record_kind, record_id, status, exception_reason,
      exception_tally_amount_paise, exception_by, exception_at, status_before_exception, updated_by)
    values (p_entity, p_branch, p_deal, p_kind, p_record_id, 'exception', p_reason, p_amount, (select auth.uid()), now(),
      p_from, (select auth.uid()))
    returning * into v_tr;
  else
    -- The voucher reference stays known while the exception is open.
    update public.tally_records r
    set status = 'exception', exception_reason = p_reason, exception_tally_amount_paise = p_amount,
        exception_by = (select auth.uid()), exception_at = now(), status_before_exception = p_from,
        matched_by = null, matched_at = null,
        row_version = r.row_version + 1, updated_at = now(), updated_by = (select auth.uid())
    where r.id = v_tr.id
    returning * into v_tr;
  end if;
  perform authz.write_audit('accounts.tally_exception_raised', p_entity, p_branch, p_kind, p_record_id, p_reason,
    jsonb_build_object('tallyRecordId', v_tr.id, 'rowVersion', v_tr.row_version, 'fromStatus', p_from,
      'amountGiven', p_amount is not null,
      'previousVoucherRef', v_prev_ref, 'previousVoucherDate', to_char(v_prev_date, 'YYYY-MM-DD')));
  return v_tr;
end;
$$;

-- Replaces 20261203000330:138: the core moved to authz.tally_apply_match (unchanged behaviour).
create or replace function public.accounts_tally_match(p_kind text, p_record_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  t record;
  v_tr public.tally_records%rowtype;
  v_payload jsonb := jsonb_build_object('kind', p_kind, 'recordId', p_record_id, 'expectedRowVersion', p_expected_row_version,
    'fields', p_fields);
  v_result jsonb;
  v_ref text;
  v_date date;
  v_from text;
begin
  select * into t from authz.tally_prelude(p_kind, p_record_id, p_request_id) x limit 1;
  select * into v_tr from public.tally_records r where r.record_kind = p_kind and r.record_id = p_record_id for update;
  v_result := authz.finance_replay(t.entity, p_request_id, 'accounts_tally_match', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_expected_row_version is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' or (p_fields - array['voucherRef', 'voucherDate']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  begin
    v_ref := authz.finance_text(authz.finance_field(p_fields, 'voucherRef'), 1, 60, false);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'voucherRef';
  end;
  if v_ref is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'voucherRef';
  end if;
  v_date := authz.tally_voucher_date(authz.finance_field(p_fields, 'voucherDate'));
  if coalesce(v_tr.row_version, 0) <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_from := authz.tally_effective(t.computed, v_tr.status);
  if v_from in ('not_ready', 'not_applicable') then
    raise exception 'tally_not_ready' using errcode = '55000';
  elsif v_from = 'matched' then
    raise exception 'already_matched' using errcode = '55000';
  elsif v_from = 'exception' then
    raise exception 'tally_exception_open' using errcode = '55000';
  end if;

  -- Accounts phase 3 (20261205000320): shared internal.
  v_tr := authz.tally_apply_match(p_kind, p_record_id, t.entity, t.branch_id, t.deal_id, v_tr, v_ref, v_date, v_from);
  v_result := jsonb_build_object('outcome', 'updated', 'tallyRecordId', v_tr.id, 'status', v_tr.status, 'rowVersion', v_tr.row_version);
  return authz.finance_remember(t.entity, p_request_id, 'accounts_tally_match', v_payload, v_result);
end;
$$;

-- Replaces 20261203000330:206: the core moved to authz.tally_apply_exception (unchanged behaviour).
create or replace function public.accounts_tally_exception(p_kind text, p_record_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  t record;
  v_tr public.tally_records%rowtype;
  v_payload jsonb := jsonb_build_object('kind', p_kind, 'recordId', p_record_id, 'expectedRowVersion', p_expected_row_version,
    'fields', p_fields);
  v_result jsonb;
  v_reason text;
  v_amount bigint;
  v_raw jsonb;
  v_from text;
begin
  select * into t from authz.tally_prelude(p_kind, p_record_id, p_request_id) x limit 1;
  select * into v_tr from public.tally_records r where r.record_kind = p_kind and r.record_id = p_record_id for update;
  v_result := authz.finance_replay(t.entity, p_request_id, 'accounts_tally_exception', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_expected_row_version is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' or (p_fields - array['reason', 'tallyAmountPaise']) <> '{}'::jsonb then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  begin
    v_reason := authz.finance_reason(authz.finance_field(p_fields, 'reason'));
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end;
  v_raw := p_fields -> 'tallyAmountPaise';
  if v_raw is not null and jsonb_typeof(v_raw) <> 'null' then
    if jsonb_typeof(v_raw) <> 'string' or (v_raw #>> '{}') !~ '^[1-9][0-9]{0,14}$' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'tallyAmountPaise';
    end if;
    v_amount := (v_raw #>> '{}')::bigint;
  end if;
  if coalesce(v_tr.row_version, 0) <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_from := authz.tally_effective(t.computed, v_tr.status);
  if v_from in ('not_ready', 'not_applicable') then
    raise exception 'tally_not_ready' using errcode = '55000';
  elsif v_from = 'exception' then
    raise exception 'tally_exception_open' using errcode = '55000';
  end if;

  -- Accounts phase 3 (20261205000320): shared internal.
  v_tr := authz.tally_apply_exception(p_kind, p_record_id, t.entity, t.branch_id, t.deal_id, v_tr, v_reason, v_amount, v_from);
  v_result := jsonb_build_object('outcome', 'updated', 'tallyRecordId', v_tr.id, 'status', v_tr.status, 'rowVersion', v_tr.row_version);
  return authz.finance_remember(t.entity, p_request_id, 'accounts_tally_exception', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 2. Evaluation
-- ===========================================================================

-- p_rows: a validated array (authz.tally_match_rows_check). One row per voucher, in file order.
create function authz.tally_match_evaluate(p_entity uuid, p_rows jsonb)
returns table (row_no integer, tn_tag text, voucher_ref text, voucher_date date, voucher_type text, amount_paise bigint,
  outcome text, tally_record_id uuid, crm_amount_paise bigint, tr_row_version integer)
language sql stable security definer set search_path = '' as $$
  with r as (
    select o.n::integer as row_no, nullif(o.e ->> 'tnTag', '') as tag, o.e ->> 'voucherRef' as ref,
           (o.e ->> 'voucherDate')::date as d, nullif(o.e ->> 'voucherType', '') as vt, (o.e ->> 'amountPaise')::bigint as amt
    from jsonb_array_elements(p_rows) with ordinality o(e, n)
  ),
  l as (
    select r.*, ln.tally_record_id as rec, (ln."values" ->> 'amountPaise')::bigint as crm
    from r
    left join public.tally_exports x
      on r.tag is not null and x.legal_entity_id = p_entity and x.format = 'xml'
     and x.export_no = substring(r.tag from '^TN:(TE-[0-9]{4}-[0-9]{6})/')
    left join public.tally_export_lines ln
      on ln.export_id = x.id and ln.line_no = substring(r.tag from '/([0-9]{1,5})$')::integer
  ),
  k as (
    select l.*,
           row_number() over (partition by l.tag order by l.row_no) as tag_rank,
           row_number() over (partition by l.rec order by l.row_no) as rec_rank
    from l
  )
  select k.row_no, k.tag, k.ref, k.d, k.vt, k.amt,
    case
      when k.tag is null then 'no_tag'
      when k.rec is null then 'not_found'
      when k.tag_rank > 1 or k.rec_rank > 1 then 'duplicate_in_file'
      when tr.status in ('matched', 'exception') then 'already_matched'
      when coalesce(authz.tally_effective(tg.computed, tr.status), 'not_applicable') not in ('ready', 'exported') then 'not_found'
      when k.amt = k.crm then 'matched'
      else 'amount_differs' end,
    case when k.rec is not null then k.rec end,
    k.crm,
    tr.row_version
  from k
  left join public.tally_records tr on tr.id = k.rec
  left join lateral (select x.computed from authz.tally_target(tr.record_kind, tr.record_id) x limit 1) tg on tr.id is not null
  order by k.row_no
$$;

-- Validates the rows of an upload (shape only; raises invalid_input hint rows).
create function authz.tally_match_rows_check(p_rows jsonb) returns void
language plpgsql stable set search_path = '' as $$
begin
  if p_rows is null or jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) not between 1 and 5000 then
    raise exception 'invalid_input' using errcode = '22023', hint = 'rows';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_rows) e
    where jsonb_typeof(e) <> 'object'
       or (e - array['tnTag', 'voucherRef', 'voucherDate', 'voucherType', 'amountPaise']) <> '{}'::jsonb
       or (e ? 'tnTag' and jsonb_typeof(e -> 'tnTag') <> 'null'
           and (jsonb_typeof(e -> 'tnTag') <> 'string' or (e ->> 'tnTag') !~ '^TN:TE-[0-9]{4}-[0-9]{6}/[0-9]{1,5}$'))
       or jsonb_typeof(e -> 'voucherRef') is distinct from 'string'
       or char_length(e ->> 'voucherRef') not between 1 and 60 or (e ->> 'voucherRef') ~ '[[:cntrl:]]'
       or jsonb_typeof(e -> 'voucherDate') is distinct from 'string' or (e ->> 'voucherDate') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       or (e ? 'voucherType' and jsonb_typeof(e -> 'voucherType') <> 'null'
           and (jsonb_typeof(e -> 'voucherType') <> 'string' or char_length(e ->> 'voucherType') not between 1 and 60
                or (e ->> 'voucherType') ~ '[[:cntrl:]]'))
       or jsonb_typeof(e -> 'amountPaise') is distinct from 'string' or (e ->> 'amountPaise') !~ '^(0|[1-9][0-9]{0,14})$') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'rows';
  end if;
  begin
    perform 1 from jsonb_array_elements(p_rows) e
    where (e ->> 'voucherDate')::date < date '2000-01-01' or (e ->> 'voucherDate')::date > authz.finance_today() + 366;
    if found then
      raise exception 'invalid_input' using errcode = '22023', hint = 'rows';
    end if;
  exception when sqlstate '22008' or sqlstate '22007' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'rows';
  end;
end;
$$;

-- The proposal hash of an evaluation (what apply binds to).
create function authz.tally_match_hash(p_entity uuid, p_rows jsonb) returns text
language sql stable security definer set search_path = '' as $$
  select authz.finance_payload_hash(jsonb_build_object('entity', p_entity, 'rows', coalesce((
    select jsonb_agg(jsonb_build_array(e.row_no, e.outcome, e.tally_record_id, e.tr_row_version, e.crm_amount_paise::text,
                                       e.amount_paise::text, e.voucher_ref, e.voucher_date) order by e.row_no)
    from authz.tally_match_evaluate(p_entity, p_rows) e), '[]'::jsonb)))
$$;

-- The stored rows of a batch, back in the upload shape.
create function authz.tally_match_batch_rows(p_batch uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('tnTag', r.tn_tag, 'voucherRef', r.voucher_ref,
      'voucherDate', to_char(r.voucher_date, 'YYYY-MM-DD'), 'voucherType', r.voucher_type, 'amountPaise', r.amount_paise::text)
    order by r.row_no), '[]'::jsonb)
  from public.tally_match_rows r where r.batch_id = p_batch
$$;

create function authz.tally_match_batch_json(p_batch uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('batchId', b.id, 'fileName', b.file_name, 'status', b.status, 'rowCount', b.row_count,
    'summary', b.summary, 'proposalHash', b.proposal_hash, 'stagedAt', b.staged_at, 'stagedByName', p.display_name,
    'appliedAt', b.applied_at)
  from public.tally_match_batches b
  left join public.staff_profiles p on p.user_id = b.staged_by
  where b.id = p_batch
$$;

-- ===========================================================================
-- 3. C4 stage
-- ===========================================================================

create function public.accounts_tally_match_stage(p_entity uuid, p_file_name text, p_file_sha256 text, p_rows jsonb, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_payload jsonb := jsonb_build_object('entityId', p_entity, 'fileName', p_file_name, 'fileSha256', p_file_sha256,
    'rowsHash', authz.finance_payload_hash(p_rows));
  v_result jsonb;
  v_name text;
  v_existing uuid;
  v_summary jsonb;
  v_hash text;
  v_batch public.tally_match_batches%rowtype;
  v_count integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_entity is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'entityId';
  end if;
  perform authz.finance_require_accounts(p_entity, null);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(p_entity, p_request_id, 'accounts_tally_match_stage', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  v_name := btrim(coalesce(p_file_name, ''));
  if char_length(v_name) not between 1 and 200 or v_name ~ '[[:cntrl:]]' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fileName';
  end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fileSha256';
  end if;
  perform authz.tally_match_rows_check(p_rows);
  select b.id into v_existing from public.tally_match_batches b
  where b.legal_entity_id = p_entity and b.file_sha256 = p_file_sha256 and b.status <> 'cancelled';
  if v_existing is not null then
    raise exception 'already_recorded' using errcode = '55000', hint = 'batchId=' || v_existing::text;
  end if;

  drop table if exists pg_temp.tally_match_work;
  create temporary table tally_match_work on commit drop as
    select * from authz.tally_match_evaluate(p_entity, p_rows);
  select count(*)::integer into v_count from pg_temp.tally_match_work;
  select jsonb_build_object(
      'matched', count(*) filter (where w.outcome = 'matched'),
      'amount_differs', count(*) filter (where w.outcome = 'amount_differs'),
      'not_found', count(*) filter (where w.outcome = 'not_found'),
      'already_matched', count(*) filter (where w.outcome = 'already_matched'),
      'duplicate_in_file', count(*) filter (where w.outcome = 'duplicate_in_file'),
      'no_tag', count(*) filter (where w.outcome = 'no_tag'))
  into v_summary from pg_temp.tally_match_work w;
  v_hash := authz.finance_payload_hash(jsonb_build_object('entity', p_entity, 'rows', coalesce((
    select jsonb_agg(jsonb_build_array(e.row_no, e.outcome, e.tally_record_id, e.tr_row_version, e.crm_amount_paise::text,
                                       e.amount_paise::text, e.voucher_ref, e.voucher_date) order by e.row_no)
    from pg_temp.tally_match_work e), '[]'::jsonb)));

  begin
    insert into public.tally_match_batches (legal_entity_id, file_name, file_sha256, row_count, summary, proposal_hash, staged_by,
      request_id)
    values (p_entity, v_name, p_file_sha256, v_count, v_summary, v_hash, (select auth.uid()), p_request_id)
    returning * into v_batch;
  exception when unique_violation then
    raise exception 'already_recorded' using errcode = '55000';
  end;
  insert into public.tally_match_rows (batch_id, legal_entity_id, row_no, tn_tag, voucher_ref, voucher_date, voucher_type,
    amount_paise, outcome, tally_record_id, crm_amount_paise)
  select v_batch.id, p_entity, w.row_no, w.tn_tag, w.voucher_ref, w.voucher_date, w.voucher_type, w.amount_paise, w.outcome,
    w.tally_record_id, w.crm_amount_paise
  from pg_temp.tally_match_work w;

  perform authz.write_audit('accounts.tally_match.staged', p_entity, null, 'tally_match_batch', v_batch.id, null,
    jsonb_build_object('batchId', v_batch.id, 'rows', v_count) || v_summary);
  v_result := authz.tally_match_batch_json(v_batch.id) || jsonb_build_object('outcome', 'created');
  return authz.finance_remember(p_entity, p_request_id, 'accounts_tally_match_stage', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 4. C5 apply
-- ===========================================================================

create function public.accounts_tally_match_apply(p_batch_id uuid, p_expected_proposal_hash text, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_batch public.tally_match_batches%rowtype;
  v_payload jsonb := jsonb_build_object('batchId', p_batch_id, 'expectedProposalHash', p_expected_proposal_hash);
  v_result jsonb;
  v_rows jsonb;
  w record;
  t record;
  v_tr public.tally_records%rowtype;
  v_from text;
  v_matched integer := 0;
  v_exceptions integer := 0;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_batch_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'batchId';
  end if;
  select * into v_batch from public.tally_match_batches b where b.id = p_batch_id;
  if v_batch.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.finance_require_accounts(v_batch.legal_entity_id, null);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_batch.legal_entity_id, p_request_id, 'accounts_tally_match_apply', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_expected_proposal_hash is null or p_expected_proposal_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedProposalHash';
  end if;

  -- Lock order 17.1 (4): the Tally entity lock exclusive, then the batch, then Tally rows by id.
  perform authz.tally_entity_lock(v_batch.legal_entity_id, true);
  select * into v_batch from public.tally_match_batches b where b.id = p_batch_id for update;
  if v_batch.status <> 'staged' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if v_batch.proposal_hash <> p_expected_proposal_hash then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_rows := authz.tally_match_batch_rows(v_batch.id);
  if authz.tally_match_hash(v_batch.legal_entity_id, v_rows) <> v_batch.proposal_hash then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  perform 1 from public.tally_records r
  where r.id in (select x.tally_record_id from public.tally_match_rows x
                 where x.batch_id = v_batch.id and x.outcome in ('matched', 'amount_differs'))
  order by r.id for update;

  for w in
    select x.* from public.tally_match_rows x
    where x.batch_id = v_batch.id and x.outcome in ('matched', 'amount_differs') order by x.row_no
  loop
    select * into v_tr from public.tally_records r where r.id = w.tally_record_id;
    select * into t from authz.tally_target(v_tr.record_kind, v_tr.record_id) x limit 1;
    v_from := authz.tally_effective(t.computed, v_tr.status);
    if w.outcome = 'matched' then
      perform authz.tally_apply_match(v_tr.record_kind, v_tr.record_id, v_tr.legal_entity_id, v_tr.branch_id, v_tr.deal_id, v_tr,
        w.voucher_ref, w.voucher_date, v_from);
      v_matched := v_matched + 1;
    else
      perform authz.tally_apply_exception(v_tr.record_kind, v_tr.record_id, v_tr.legal_entity_id, v_tr.branch_id, v_tr.deal_id, v_tr,
        left('Tally amount differs from the CRM amount (Tally voucher ' || w.voucher_ref || ' of '
             || to_char(w.voucher_date, 'YYYY-MM-DD') || ', matching upload).', 500),
        nullif(w.amount_paise, 0), v_from);
      v_exceptions := v_exceptions + 1;
    end if;
  end loop;

  update public.tally_match_batches b
  set status = 'applied', applied_by = (select auth.uid()), applied_at = now(), apply_request_id = p_request_id,
      row_version = b.row_version + 1
  where b.id = v_batch.id;
  perform authz.write_audit('accounts.tally_match.applied', v_batch.legal_entity_id, null, 'tally_match_batch', v_batch.id, null,
    jsonb_build_object('batchId', v_batch.id, 'matched', v_matched, 'exceptions', v_exceptions));
  v_result := jsonb_build_object('outcome', 'updated', 'batchId', v_batch.id, 'status', 'applied', 'matched', v_matched,
    'exceptions', v_exceptions);
  return authz.finance_remember(v_batch.legal_entity_id, p_request_id, 'accounts_tally_match_apply', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 5. C6 cancel
-- ===========================================================================

create function public.accounts_tally_match_cancel(p_batch_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_batch public.tally_match_batches%rowtype;
  v_payload jsonb := jsonb_build_object('batchId', p_batch_id);
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_batch_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'batchId';
  end if;
  select * into v_batch from public.tally_match_batches b where b.id = p_batch_id;
  if v_batch.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.finance_require_accounts(v_batch.legal_entity_id, null);
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v_result := authz.finance_replay(v_batch.legal_entity_id, p_request_id, 'accounts_tally_match_cancel', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  select * into v_batch from public.tally_match_batches b where b.id = p_batch_id for update;
  if v_batch.status <> 'staged' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  update public.tally_match_batches b
  set status = 'cancelled', cancelled_by = (select auth.uid()), cancelled_at = now(), cancel_request_id = p_request_id,
      row_version = b.row_version + 1
  where b.id = v_batch.id;
  perform authz.write_audit('accounts.tally_match.cancelled', v_batch.legal_entity_id, null, 'tally_match_batch', v_batch.id, null,
    jsonb_build_object('batchId', v_batch.id, 'rows', v_batch.row_count));
  v_result := jsonb_build_object('outcome', 'updated', 'batchId', v_batch.id, 'status', 'cancelled');
  return authz.finance_remember(v_batch.legal_entity_id, p_request_id, 'accounts_tally_match_cancel', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 6. R-C4 batch with its rows
-- ===========================================================================

-- p_outcome: one of the six outcomes or null (all); p_after: the last row number as text.
create function public.accounts_tally_match_get(p_batch_id uuid, p_outcome text default null, p_after text default null,
  p_limit integer default 100) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_batch public.tally_match_batches%rowtype;
  v_limit integer := least(greatest(coalesce(p_limit, 100), 1), 500);
  v_after integer := 0;
  v_rows jsonb;
  v_count integer;
  v_last integer;
begin
  if p_batch_id is null or not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v_batch from public.tally_match_batches b where b.id = p_batch_id;
  if v_batch.id is null or not (v_batch.legal_entity_id = any(authz.acct_a_entities())) then
    return null;
  end if;
  if p_outcome is not null and p_outcome not in ('matched', 'amount_differs', 'not_found', 'already_matched', 'duplicate_in_file', 'no_tag') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'outcome';
  end if;
  if p_after is not null then
    if p_after !~ '^[0-9]{1,5}$' then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end if;
    v_after := p_after::integer;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('rowNo', o.row_no, 'tnTag', o.tn_tag, 'voucherRef', o.voucher_ref,
           'voucherDate', to_char(o.voucher_date, 'YYYY-MM-DD'), 'voucherType', o.voucher_type,
           'amountPaise', o.amount_paise::text, 'outcome', o.outcome, 'crmAmountPaise', o.crm_amount_paise::text,
           'crmReference', o.crm_reference) order by o.row_no) filter (where o.rn <= v_limit), '[]'::jsonb),
         count(*)::int,
         max(o.row_no) filter (where o.rn = v_limit)
  into v_rows, v_count, v_last
  from (select x.*, row_number() over (order by x.row_no) as rn,
               (select ln."values" ->> 'reference' from public.tally_records tr
                join public.tally_export_lines ln on ln.export_id = tr.xml_export_id and ln.line_no = tr.xml_line_no
                where tr.id = x.tally_record_id) as crm_reference
        from public.tally_match_rows x
        where x.batch_id = v_batch.id and x.row_no > v_after and (p_outcome is null or x.outcome = p_outcome)
        order by x.row_no
        limit v_limit + 1) o;
  return jsonb_build_object('batch', authz.tally_match_batch_json(v_batch.id), 'outcome', p_outcome, 'rows', v_rows,
    'nextAfter', case when v_count > v_limit then v_last::text end, 'hasMore', v_count > v_limit);
end;
$$;

-- ===========================================================================
-- 7. Grants
-- ===========================================================================

revoke all on function authz.tally_apply_match(text, uuid, uuid, uuid, uuid, public.tally_records, text, date, text),
  authz.tally_apply_exception(text, uuid, uuid, uuid, uuid, public.tally_records, text, bigint, text),
  authz.tally_match_evaluate(uuid, jsonb), authz.tally_match_rows_check(jsonb), authz.tally_match_hash(uuid, jsonb),
  authz.tally_match_batch_rows(uuid), authz.tally_match_batch_json(uuid)
  from public, anon, authenticated, service_role;
revoke all on function public.accounts_tally_match_stage(uuid, text, text, jsonb, uuid),
  public.accounts_tally_match_apply(uuid, text, uuid), public.accounts_tally_match_cancel(uuid, uuid),
  public.accounts_tally_match_get(uuid, text, text, integer)
  from public, anon, authenticated, service_role;
grant execute on function public.accounts_tally_match_stage(uuid, text, text, jsonb, uuid),
  public.accounts_tally_match_apply(uuid, text, uuid), public.accounts_tally_match_cancel(uuid, uuid),
  public.accounts_tally_match_get(uuid, text, text, integer)
  to authenticated;

commit;
