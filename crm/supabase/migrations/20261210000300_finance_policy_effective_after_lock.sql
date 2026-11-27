-- TripNavigate CRM - G19 (bundled into booking go-live 2, owner 27 November 2026):
-- a finance policy version is effective from the time the policy head lock is
-- held, not from the start of its transaction.
--
-- The race: public.finance_policy_update stamped a version effective at now(),
-- the transaction start, which is before it takes the policy head lock
-- (authz.finance_lock_policy, FOR UPDATE). public.receipt_record takes the
-- same head FOR SHARE and reads the policy as of its own now()
-- (authz.finance_policy_at(entity, v_t)). When a policy update starts first
-- but a receipt takes the head first, the receipt commits with the old
-- version, and the new version is then stored as effective from a time before
-- that receipt: the history says the receipt should have used the new rules.
--
-- The fix, in public.finance_policy_update only (replaces its only definition,
-- 20261101000100_accounts_receipts.sql:2481; lines marked G19):
--   - v_now := clock_timestamp() right after the head lock;
--   - with no effective time given, the version is effective from v_now;
--   - an explicit effective time that falls before v_now moves to v_now;
--   - the answer's status compares with v_now.
-- Unchanged: the checks (an explicit time before the transaction start, before
-- the latest version, or more than 90 days ahead is still refused with
-- invalid_input, 22023), the lock order, replay, audit, arguments, return
-- shape, plpgsql volatile security definer, search_path '', owner and grants
-- (create or replace keeps them). public.receipt_record is not changed. No
-- refusal uses SQLSTATE 40001 (conflict refusals stay PT409, raised by the
-- helpers this function calls). No table, column, read, switch or data change.
--
-- Effect: a receipt recorded in the SAME transaction as a policy update (only
-- tests do this) now uses the version in force when that transaction started.
-- Rollback (forward-only): a NEW migration restoring the 20261101000100 body.

begin;
set local lock_timeout = '15s';

create or replace function public.finance_policy_update(
  p_entity_id uuid, p_fields jsonb, p_effective_at timestamptz, p_reason text, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_payload jsonb := jsonb_build_object('entityId', p_entity_id, 'fields', p_fields, 'effectiveAt', p_effective_at,
    'reason', p_reason);
  v_result jsonb;
  v_latest public.finance_policy_versions%rowtype;
  v_limits public.finance_legal_limits%rowtype;
  v_receipt_max bigint;
  v_payer_cap bigint;
  v_trip_cap bigint;
  v_days integer;
  v_recon boolean;
  v_effective timestamptz;
  v_now timestamptz;  -- G19
  v_reason text;
  v_id uuid;
  v_value jsonb;
begin
  perform authz.finance_require_policy_manager(p_entity_id);
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  perform authz.finance_lock_policy(p_entity_id, true);
  -- G19: the time after the policy head lock, not the transaction start. A receipt that
  -- took the head first has committed by now and was recorded with the old version.
  v_now := clock_timestamp();
  v_result := authz.finance_replay(p_entity_id, p_request_id, 'finance_policy_update', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['receiptMaxPaise', 'cashPayerDayCapPaise', 'cashTripCapPaise', 'cashDepositDays',
                          'reconciliationRequired']) <> '{}'::jsonb then
    perform authz.finance_invalid();
  end if;
  select * into v_latest from public.finance_policy_versions v
  where v.legal_entity_id = p_entity_id order by v.version_no desc limit 1;
  select * into v_limits from public.finance_legal_limits l where l.legal_entity_id = p_entity_id;

  -- Omitted fields copy from the latest version.
  v_receipt_max := coalesce(authz.finance_paise(p_fields, 'receiptMaxPaise', 1), v_latest.receipt_max_paise);
  v_payer_cap := coalesce(authz.finance_paise(p_fields, 'cashPayerDayCapPaise', 0), v_latest.cash_payer_day_cap_paise);
  v_trip_cap := coalesce(authz.finance_paise(p_fields, 'cashTripCapPaise', 0), v_latest.cash_trip_cap_paise);
  v_value := p_fields -> 'cashDepositDays';
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    v_days := v_latest.cash_deposit_days;
  elsif jsonb_typeof(v_value) = 'number' and (v_value #>> '{}') ~ '^[1-7]$' then
    v_days := (v_value #>> '{}')::integer;
  else
    perform authz.finance_invalid();
  end if;
  v_value := p_fields -> 'reconciliationRequired';
  if v_value is null or jsonb_typeof(v_value) = 'null' then
    v_recon := v_latest.reconciliation_required;
  elsif jsonb_typeof(v_value) = 'boolean' then
    v_recon := (v_value #>> '{}')::boolean;
  else
    perform authz.finance_invalid();
  end if;
  if v_limits.legal_entity_id is null
     or v_payer_cap > v_limits.cash_cap_ceiling_paise or v_trip_cap > v_limits.cash_cap_ceiling_paise
     or v_receipt_max > v_limits.receipt_max_ceiling_paise then
    perform authz.finance_invalid();
  end if;
  v_effective := coalesce(p_effective_at, v_now);  -- G19
  if v_effective < now() or v_effective < v_latest.effective_at or v_effective > now() + interval '90 days' then
    perform authz.finance_invalid();
  end if;
  -- G19: never effective before the lock was held (an explicit time between the transaction
  -- start and the lock moves to the lock time).
  v_effective := greatest(v_effective, v_now);
  v_reason := authz.finance_reason(p_reason);

  insert into public.finance_policy_versions (legal_entity_id, version_no, effective_at, receipt_max_paise,
    cash_payer_day_cap_paise, cash_trip_cap_paise, cash_deposit_days, reconciliation_required, reason, created_by, request_id)
  values (p_entity_id, v_latest.version_no + 1, v_effective, v_receipt_max, v_payer_cap, v_trip_cap, v_days, v_recon,
    v_reason, (select auth.uid()), p_request_id)
  returning id into v_id;
  update public.finance_policy_heads h set current_version_no = v_latest.version_no + 1, updated_at = now()
  where h.legal_entity_id = p_entity_id;

  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'rowVersion', v_latest.version_no + 1,
    'status', case when v_effective <= v_now then 'effective' else 'scheduled' end);  -- G19
  perform authz.finance_remember(p_entity_id, p_request_id, 'finance_policy_update', v_payload, v_result);
  perform authz.write_audit('finance.policy_updated', p_entity_id, null, 'finance_policy_version', v_id, v_reason,
    jsonb_build_object('versionNo', v_latest.version_no + 1, 'effectiveAt', v_effective,
      'changedFields', (select coalesce(jsonb_agg(k order by k), '[]'::jsonb) from jsonb_object_keys(p_fields) as k)));
  return v_result;
end;
$$;

commit;
