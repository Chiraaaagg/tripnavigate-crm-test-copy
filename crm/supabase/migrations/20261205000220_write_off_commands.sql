-- TripNavigate CRM - Accounts phase 3, track B (3 of 4): write-off commands
-- and reads.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 4 (Approver), 6.6
-- (B3-B6, R-B1, R-B2), 13, 14, 17.1, 17.3, 21 LD15, LD16, LD37.
--
-- Commands (security definer; authz.session_ok() first; actor = auth.uid();
-- p_request_id required, replayed through finance_replay / finance_remember;
-- lock order: authz.finance_lock_deal, then the write-off row FOR UPDATE):
--   B3 public.write_off_propose(p_deal_id, p_fields {direction, amountPaise, reason}, p_request_id)   A
--   B4 public.write_off_decide(p_id, p_decision 'approve'|'return', p_expected_amount_paise,
--        p_reason, p_expected_row_version, p_request_id)                                             Approver
--   B5 public.write_off_withdraw(p_id, p_expected_row_version, p_reason, p_request_id)               the proposer
--   B6 public.write_off_undo(p_id, p_expected_row_version, p_reason, p_request_id)                   branch M
-- Reads (null when not allowed; never a partial object):
--   R-B1 public.small_balances_list(p_filter jsonb, p_after text, p_limit integer)   A (entity), M (branch)
--   R-B2 public.write_off_monthly(p_month date)                                      M (own branches), SA (all)
--
-- Rules (LD16): write_off_enabled; the trip ended (trip_end < India today) or
-- the Deal has an approved cancellation settlement; the amount is the WHOLE
-- current balance (due) or credit (excess) and at most the entity limit;
-- refused while a refund request is live, a cancellation is not approved, a
-- change request is live (authz.deal_change_open), a receipt is recorded /
-- awaiting clearance or a payment claim is reported, or money held is below
-- zero. Everything is re-checked at approval. No journal entry; money held
-- never changes (LD15) - the dues adjustment is in 20261205000230.
--
-- Approver (section 4, LD37): an active branch Manager of the Deal's branch
-- (Accounts readers excluded, no Purchase / Flight / Visa role), never the
-- proposer; when the branch has no other such Manager than the proposer, any
-- other active Manager of the entity.
--
-- Refusal tokens: write_off_off (55000), not_ready (55000, hint trip_not_ended
-- | refund_open | cancellation_open | change_open | receipt_unverified |
-- shortfall), write_off_over_limit (22023, hint limitPaise=<paise>),
-- write_off_not_balance (22023), write_off_open_exists (23505),
-- not_self_approval (42501), version_changed (40001), wrong_state (55000),
-- invalid_input (22023, hint = field), not_authorized (42501), not_found
-- (P0002), request_conflict (40001), environment_unset / not_configured (55000).
--
-- Audit (ids, kinds only; reasons in the reason column): accounts.write_off.
-- proposed {writeOffId, dealId, direction} | approved | returned | withdrawn |
-- undone.
--
-- Rollback (forward-only): a NEW migration revoking execute on these six
-- functions and dropping the helpers. Never delete write-off rows.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Helpers
-- ===========================================================================

create function authz.wo_enabled(p_entity uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.write_off_enabled from public.accounts_settings s where s.legal_entity_id = p_entity), false)
$$;

create function authz.wo_limit(p_entity uuid) returns bigint
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.write_off_limit_paise from public.accounts_settings s where s.legal_entity_id = p_entity), 500000)::bigint
$$;

-- Trip end of the Deal's confirmed version (legacy hotel versions: check-out).
create function authz.wo_trip_end(p_deal uuid) returns date
language sql stable security definer set search_path = '' as $$
  select coalesce(v.trip_end, v.check_out) from public.booking_versions v where v.deal_id = p_deal and v.status = 'confirmed' limit 1
$$;

-- What stops a write-off on the Deal now (B3 not_ready hints, contract order).
-- p_basis / p_money: the Deal's dues row (authz.dues_compute).
create function authz.wo_blockers(p_deal uuid, p_basis text, p_money bigint) returns text[]
language plpgsql stable security definer set search_path = '' as $$
declare
  v text[] := array[]::text[];
begin
  if not (coalesce(p_basis, '') = 'cancelled' or coalesce(authz.wo_trip_end(p_deal) < authz.finance_today(), false)) then
    v := v || 'trip_not_ended'::text;
  end if;
  if exists (select 1 from public.customer_refund_requests q
             where q.deal_id = p_deal and (q.status in ('requested', 'returned') or (q.status = 'approved' and q.outcome = 'payout'))) then
    v := v || 'refund_open'::text;
  end if;
  if exists (select 1 from public.deal_cancellations x where x.deal_id = p_deal and x.status <> 'approved') then
    v := v || 'cancellation_open'::text;
  end if;
  if coalesce(authz.deal_change_open(p_deal), false) then
    v := v || 'change_open'::text;
  end if;
  if exists (select 1 from public.customer_receipts r where r.deal_id = p_deal and r.status in ('recorded', 'pending_clearance'))
     or exists (select 1 from public.customer_payment_claims x where x.deal_id = p_deal and x.status = 'reported') then
    v := v || 'receipt_unverified'::text;
  end if;
  if coalesce(p_money, 0) < 0 then
    v := v || 'shortfall'::text;
  end if;
  return v;
end;
$$;

-- B3 / B4 checks on the Deal (lock held by the caller): the switch, the
-- blockers, the whole balance and the limit. Raises the refusal.
create function authz.wo_require_allowed(p_deal public.deals, p_direction text, p_amount bigint) returns void
language plpgsql stable security definer set search_path = '' as $$
declare
  r record;
  v_blockers text[];
  v_whole bigint;
  v_limit bigint := authz.wo_limit(p_deal.legal_entity_id);
begin
  if not authz.wo_enabled(p_deal.legal_entity_id) then
    raise exception 'write_off_off' using errcode = '55000';
  end if;
  select * into r from authz.dues_compute(array[]::uuid[], array[]::uuid[], array[]::uuid[], p_deal.is_synthetic, p_deal.id, true) x
  limit 1;
  if r.deal_id is null then
    -- No confirmed booking: no trip, nothing in dues.
    raise exception 'not_ready' using errcode = '55000', hint = 'trip_not_ended';
  end if;
  v_blockers := authz.wo_blockers(p_deal.id, r.basis, r.money);
  if cardinality(v_blockers) > 0 then
    raise exception 'not_ready' using errcode = '55000', hint = v_blockers[1];
  end if;
  v_whole := case p_direction when 'due' then r.balance when 'excess' then r.credit end;
  if p_amount is null or p_amount < 1 or v_whole is null or p_amount <> v_whole then
    raise exception 'write_off_not_balance' using errcode = '22023';
  end if;
  if p_amount > v_limit then
    raise exception 'write_off_over_limit' using errcode = '22023', hint = 'limitPaise=' || v_limit::text;
  end if;
end;
$$;

-- Approver of a write-off (section 4, LD37), ignoring self-approval.
create function authz.wo_is_approver(p_wo public.deal_write_offs) returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce(authz.session_ok(), false) and (
    p_wo.branch_id = any(authz.acct_m_branches())
    or (authz.refund_entity_manager(p_wo.legal_entity_id)
        and not authz.can_accounts(p_wo.legal_entity_id)
        and authz.finance_gate_issue(p_wo.legal_entity_id, null) is null
        and not exists (
          select 1 from public.memberships m
          join public.legal_entities e on e.id = m.legal_entity_id
          join public.branches b on b.id = m.branch_id
          where m.legal_entity_id = p_wo.legal_entity_id and m.branch_id = p_wo.branch_id and m.role_code = 'manager'
            and m.status = 'active' and e.status = 'enabled' and b.status = 'enabled' and m.user_id <> p_wo.proposed_by
            -- A branch Manager in the reader sense (section 4): no Accounts, Purchase, Flight or Visa role there.
            and not exists (select 1 from public.memberships o
                            where o.user_id = m.user_id and o.legal_entity_id = m.legal_entity_id and o.status = 'active'
                              and o.role_code in ('accounts', 'purchase', 'flight', 'visa')))))
$$;

create function authz.wo_result(p_outcome text, p_wo public.deal_write_offs) returns jsonb
language sql immutable set search_path = '' as $$
  select jsonb_build_object('outcome', p_outcome, 'writeOffId', p_wo.id, 'dealId', p_wo.deal_id, 'refNo', p_wo.ref_no,
    'direction', p_wo.direction, 'status', p_wo.status, 'amountPaise', p_wo.amount_paise::text, 'rowVersion', p_wo.row_version)
$$;

-- Start of B4-B6: the write-off's Deal, the environment gate, the finance head lock, then the row FOR UPDATE.
create function authz.wo_lock(p_id uuid) returns public.deal_write_offs
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.deal_write_offs%rowtype;
  v_syn boolean;
  v_issue text;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'writeOffId';
  end if;
  select * into v from public.deal_write_offs w where w.id = p_id;
  if v.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  select d.is_synthetic into v_syn from public.deals d where d.id = v.deal_id;
  v_issue := authz.finance_gate_issue(v.legal_entity_id, v_syn);
  if v_issue is not null then
    raise exception '%', v_issue using errcode = '55000';
  end if;
  perform authz.finance_lock_deal(v.deal_id);
  select * into v from public.deal_write_offs w where w.id = p_id for update;
  return v;
end;
$$;

create function authz.wo_reason(p_reason text) returns text
language plpgsql immutable set search_path = '' as $$
begin
  return authz.finance_reason(p_reason);
exception when sqlstate '22023' then
  raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
end;
$$;

-- ===========================================================================
-- 2. B3 propose
-- ===========================================================================

create function public.write_off_propose(p_deal_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_f jsonb := coalesce(p_fields, '{}'::jsonb);
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id, 'fields', p_fields);
  v_result jsonb;
  v_key text;
  v_direction text;
  v_amount bigint;
  v_reason text;
  v_year integer;
  v_no integer;
  v_wo public.deal_write_offs%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  perform authz.finance_require_accounts(v_deal.legal_entity_id, v_deal.is_synthetic);
  perform authz.finance_lock_deal(v_deal.id);
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'write_off_propose', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if not authz.wo_enabled(v_deal.legal_entity_id) then
    raise exception 'write_off_off' using errcode = '55000';
  end if;
  if jsonb_typeof(v_f) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'fields';
  end if;
  for v_key in select jsonb_object_keys(v_f) loop
    if v_key not in ('direction', 'amountPaise', 'reason') then
      raise exception 'invalid_input' using errcode = '22023', hint = v_key;
    end if;
  end loop;
  begin
    v_direction := authz.finance_field(v_f, 'direction');
  exception when sqlstate '22023' then
    v_direction := null;
  end;
  if v_direction is null or v_direction not in ('due', 'excess') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'direction';
  end if;
  begin
    v_amount := authz.finance_paise(v_f, 'amountPaise', 0);
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'amountPaise';
  end;
  if v_amount is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'amountPaise';
  end if;
  begin
    v_reason := authz.finance_reason(authz.finance_field(v_f, 'reason'));
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'reason';
  end;
  if exists (select 1 from public.deal_write_offs w where w.deal_id = v_deal.id and w.status in ('proposed', 'approved')) then
    raise exception 'write_off_open_exists' using errcode = '23505';
  end if;
  perform authz.wo_require_allowed(v_deal, v_direction, v_amount);

  -- WO-YYYY-NNNNNN per entity and India-time year.
  v_year := extract(year from authz.finance_today())::integer;
  insert into public.write_off_counters as k (legal_entity_id, year, last_no) values (v_deal.legal_entity_id, v_year, 1)
  on conflict (legal_entity_id, year) do update set last_no = k.last_no + 1
  returning k.last_no into v_no;
  begin
    insert into public.deal_write_offs (legal_entity_id, branch_id, deal_id, ref_no, direction, amount_paise, reason,
      proposed_by, request_id)
    values (v_deal.legal_entity_id, v_deal.branch_id, v_deal.id, 'WO-' || v_year::text || '-' || lpad(v_no::text, 6, '0'),
      v_direction, v_amount, v_reason, (select auth.uid()), p_request_id)
    returning * into v_wo;
  exception when unique_violation then
    raise exception 'write_off_open_exists' using errcode = '23505';
  end;
  perform authz.write_audit('accounts.write_off.proposed', v_deal.legal_entity_id, v_deal.branch_id, 'deal_write_off', v_wo.id, v_reason,
    jsonb_build_object('writeOffId', v_wo.id, 'dealId', v_deal.id, 'direction', v_wo.direction));
  v_result := authz.wo_result('created', v_wo);
  return authz.finance_remember(v_deal.legal_entity_id, p_request_id, 'write_off_propose', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 3. B4 decide
-- ===========================================================================

create function public.write_off_decide(p_id uuid, p_decision text, p_expected_amount_paise bigint, p_reason text,
  p_expected_row_version integer, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.deal_write_offs%rowtype;
  v_deal public.deals%rowtype;
  v_uid uuid := (select auth.uid());
  v_payload jsonb := jsonb_build_object('writeOffId', p_id, 'decision', p_decision, 'expectedAmountPaise', p_expected_amount_paise,
    'reason', p_reason, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_reason text;
begin
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v := authz.wo_lock(p_id);
  if v.proposed_by = v_uid then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if not authz.wo_is_approver(v) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_result := authz.finance_replay(v.legal_entity_id, p_request_id, 'write_off_decide', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if p_decision is null or p_decision not in ('approve', 'return') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'decision';
  end if;
  if v.status <> 'proposed' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_expected_row_version is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  if v.row_version <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if p_expected_amount_paise is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedAmountPaise';
  end if;
  if v.amount_paise <> p_expected_amount_paise then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if p_decision = 'return' then
    v_reason := authz.wo_reason(p_reason);
    update public.deal_write_offs w
    set status = 'returned', decided_by = v_uid, decided_at = now(), decision_request_id = p_request_id, return_reason = v_reason,
        row_version = w.row_version + 1, updated_at = now()
    where w.id = v.id returning * into v;
    perform authz.write_audit('accounts.write_off.returned', v.legal_entity_id, v.branch_id, 'deal_write_off', v.id, v_reason,
      jsonb_build_object('writeOffId', v.id, 'dealId', v.deal_id, 'direction', v.direction));
  else
    v_reason := case when nullif(btrim(coalesce(p_reason, ''), E' \t\r\n'), '') is null then null else authz.wo_reason(p_reason) end;
    select * into v_deal from public.deals d where d.id = v.deal_id;
    -- Both limits and the whole balance again (6.6): the write-off is still 'proposed', so dues are unadjusted.
    perform authz.wo_require_allowed(v_deal, v.direction, v.amount_paise);
    update public.deal_write_offs w
    set status = 'approved', decided_by = v_uid, decided_at = now(), decision_request_id = p_request_id,
        row_version = w.row_version + 1, updated_at = now()
    where w.id = v.id returning * into v;
    perform authz.write_audit('accounts.write_off.approved', v.legal_entity_id, v.branch_id, 'deal_write_off', v.id, v_reason,
      jsonb_build_object('writeOffId', v.id, 'dealId', v.deal_id, 'direction', v.direction));
  end if;
  v_result := authz.wo_result('updated', v);
  return authz.finance_remember(v.legal_entity_id, p_request_id, 'write_off_decide', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 4. B5 withdraw, B6 undo
-- ===========================================================================

create function public.write_off_withdraw(p_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.deal_write_offs%rowtype;
  v_payload jsonb := jsonb_build_object('writeOffId', p_id, 'expectedRowVersion', p_expected_row_version, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v := authz.wo_lock(p_id);
  if v.proposed_by is distinct from (select auth.uid()) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_result := authz.finance_replay(v.legal_entity_id, p_request_id, 'write_off_withdraw', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v.status <> 'proposed' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_expected_row_version is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  if v.row_version <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_reason := authz.wo_reason(p_reason);
  update public.deal_write_offs w
  set status = 'withdrawn', row_version = w.row_version + 1, updated_at = now()
  where w.id = v.id returning * into v;
  perform authz.write_audit('accounts.write_off.withdrawn', v.legal_entity_id, v.branch_id, 'deal_write_off', v.id, v_reason,
    jsonb_build_object('writeOffId', v.id, 'dealId', v.deal_id, 'direction', v.direction));
  v_result := authz.wo_result('updated', v);
  return authz.finance_remember(v.legal_entity_id, p_request_id, 'write_off_withdraw', v_payload, v_result);
end;
$$;

create function public.write_off_undo(p_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.deal_write_offs%rowtype;
  v_payload jsonb := jsonb_build_object('writeOffId', p_id, 'expectedRowVersion', p_expected_row_version, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
begin
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  v := authz.wo_lock(p_id);
  if not (v.branch_id = any(authz.acct_m_branches())) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  v_result := authz.finance_replay(v.legal_entity_id, p_request_id, 'write_off_undo', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v.status <> 'approved' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_expected_row_version is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'expectedRowVersion';
  end if;
  if v.row_version <> p_expected_row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_reason := authz.wo_reason(p_reason);
  update public.deal_write_offs w
  set status = 'undone', undone_by = (select auth.uid()), undone_at = now(), undo_reason = v_reason,
      row_version = w.row_version + 1, updated_at = now()
  where w.id = v.id returning * into v;
  perform authz.write_audit('accounts.write_off.undone', v.legal_entity_id, v.branch_id, 'deal_write_off', v.id, v_reason,
    jsonb_build_object('writeOffId', v.id, 'dealId', v.deal_id, 'direction', v.direction));
  v_result := authz.wo_result('updated', v);
  return authz.finance_remember(v.legal_entity_id, p_request_id, 'write_off_undo', v_payload, v_result);
end;
$$;

-- ===========================================================================
-- 5. R-B1 small balances
-- ===========================================================================

-- Deals in the caller's scope (A: entity; M: branch) whose trip ended (or
-- whose cancellation is settled) with 0 < balance or credit <= limit, or that
-- have a write-off in any state. Keyset (trip_end, deal_id), oldest trip
-- first. Filter keys: preset ('to_propose' | 'to_approve' | 'needs_review'),
-- branchId, dealReference. Blockers are computed for the page rows only.
create function public.small_balances_list(p_filter jsonb, p_after text default null, p_limit integer default 50) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_f jsonb := coalesce(p_filter, '{}'::jsonb);
  v_a uuid[];
  v_m uuid[];
  v_syn boolean;
  v_key text;
  v_preset text;
  v_branch uuid;
  v_ref text;
  v_like text;
  v_after_d date;
  v_after_id uuid;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 100);
  v_today date := authz.finance_today();
  v_rows jsonb;
  v_count integer;
  v_next text;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  v_a := authz.acct_a_entities();
  v_m := authz.acct_m_branches();
  v_syn := authz.acct_synthetic();
  if v_syn is null or (cardinality(v_a) = 0 and cardinality(v_m) = 0) then
    return null;
  end if;
  if jsonb_typeof(v_f) <> 'object' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'filter';
  end if;
  for v_key in select jsonb_object_keys(v_f) loop
    if v_key not in ('preset', 'branchId', 'dealReference') then
      raise exception 'invalid_input' using errcode = '22023', hint = v_key;
    end if;
  end loop;
  if v_f ? 'preset' and jsonb_typeof(v_f -> 'preset') not in ('string', 'null') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'preset';
  end if;
  v_preset := v_f ->> 'preset';
  if v_preset is not null and v_preset not in ('to_propose', 'to_approve', 'needs_review') then
    raise exception 'invalid_input' using errcode = '22023', hint = 'preset';
  end if;
  begin
    v_branch := authz.finance_uuid(authz.finance_field(v_f, 'branchId'));
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'branchId';
  end;
  begin
    v_ref := nullif(btrim(coalesce(authz.finance_field(v_f, 'dealReference'), '')), '');
  exception when sqlstate '22023' then
    raise exception 'invalid_input' using errcode = '22023', hint = 'dealReference';
  end;
  if v_ref is not null then
    if length(v_ref) > 60 then
      raise exception 'invalid_input' using errcode = '22023', hint = 'dealReference';
    end if;
    v_like := replace(replace(replace(lower(v_ref), '\', '\\'), '%', '\%'), '_', '\_') || '%';
  end if;
  if p_after is not null then
    begin
      v_after_d := split_part(p_after, '|', 1)::date;
      v_after_id := split_part(p_after, '|', 2)::uuid;
    exception when others then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end;
    if v_after_d is null or v_after_id is null then
      raise exception 'invalid_input' using errcode = '22023', hint = 'after';
    end if;
  end if;

  with c as (
    select x.deal_id, x.reference, x.branch_id, x.legal_entity_id, x.basis, x.money, x.balance, x.credit, x.is_a, x.is_m
    from authz.dues_compute(v_a, v_m, array[]::uuid[], v_syn, null, false) x
    where (x.is_a or x.is_m)
      and (v_branch is null or x.branch_id = v_branch)
      and (v_like is null or lower(x.reference) like v_like)
  ), base as (
    select c.*, cv.trip_end, coalesce(cv.trip_end, date '1900-01-01') as sort_end,
      coalesce(s.write_off_limit_paise, 500000)::bigint as lim, coalesce(s.write_off_enabled, false) as enabled,
      (c.basis = 'cancelled' or coalesce(cv.trip_end < v_today, false)) as ended,
      w.id as w_id, w.ref_no as w_ref, w.status as w_status, w.direction as w_dir, w.amount_paise as w_amount,
      w.reason as w_reason, w.proposed_by as w_proposed_by, w.row_version as w_rv
    from c
    left join lateral (select coalesce(v.trip_end, v.check_out) as trip_end from public.booking_versions v
                       where v.deal_id = c.deal_id and v.status = 'confirmed' limit 1) cv on true
    left join public.accounts_settings s on s.legal_entity_id = c.legal_entity_id
    left join lateral (select w.* from public.deal_write_offs w where w.deal_id = c.deal_id
                       order by (w.status in ('proposed', 'approved')) desc, w.proposed_at desc, w.id desc limit 1) w on true
  ), picked as (
    select b.*,
      ((b.balance > 0 and b.balance <= b.lim) or (b.credit > 0 and b.credit <= b.lim)) as small,
      row_number() over (order by b.sort_end, b.deal_id) as rn
    from base b
    where ((b.ended and ((b.balance > 0 and b.balance <= b.lim) or (b.credit > 0 and b.credit <= b.lim))) or b.w_id is not null)
      and (v_preset is null
           or (v_preset = 'to_propose' and b.ended and coalesce(b.w_status, '') not in ('proposed', 'approved')
               and ((b.balance > 0 and b.balance <= b.lim) or (b.credit > 0 and b.credit <= b.lim)))
           or (v_preset = 'to_approve' and b.w_status = 'proposed')
           or (v_preset = 'needs_review' and b.w_status = 'approved' and (b.balance > 0 or b.credit > 0)))
      and (v_after_d is null or (b.sort_end, b.deal_id) > (v_after_d, v_after_id))
    order by b.sort_end, b.deal_id
    limit v_limit + 1
  ), page as (
    select p.*,
      case when p.balance > 0 then 'due' when p.credit > 0 then 'excess' else coalesce(p.w_dir, 'due') end as direction,
      case when p.balance > 0 then p.balance when p.credit > 0 then p.credit else 0 end::bigint as amount,
      array_remove(array[
        case when not p.enabled then 'write_off_off' end,
        case when not p.ended then 'trip_not_ended' end,
        case when exists (select 1 from public.customer_refund_requests q where q.deal_id = p.deal_id
                          and (q.status in ('requested', 'returned') or (q.status = 'approved' and q.outcome = 'payout')))
             then 'refund_open' end,
        case when exists (select 1 from public.deal_cancellations x where x.deal_id = p.deal_id and x.status <> 'approved')
             then 'cancellation_open' end,
        case when coalesce(authz.deal_change_open(p.deal_id), false) then 'change_open' end,
        case when exists (select 1 from public.customer_receipts r where r.deal_id = p.deal_id and r.status in ('recorded', 'pending_clearance'))
               or exists (select 1 from public.customer_payment_claims x where x.deal_id = p.deal_id and x.status = 'reported')
             then 'receipt_unverified' end,
        case when p.money < 0 then 'shortfall' end,
        case when greatest(p.balance, p.credit) > p.lim then 'over_limit' end]::text[], null) as blocked
    from picked p
    where p.rn <= v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'dealId', g.deal_id,
      'dealReference', g.reference,
      'branchName', br.name,
      'tripEnd', to_char(g.trip_end, 'YYYY-MM-DD'),
      'direction', g.direction,
      'balancePaise', g.amount::text,
      'limitPaise', g.lim::text,
      'writeOff', case when g.w_id is not null then jsonb_build_object(
          'id', g.w_id, 'refNo', g.w_ref, 'status', g.w_status, 'amountPaise', g.w_amount::text, 'reason', g.w_reason,
          'proposedByName', sp.display_name, 'rowVersion', g.w_rv) end,
      'blockedBy', to_jsonb(g.blocked),
      'can', jsonb_build_object(
        'propose', coalesce(g.is_a and g.enabled and coalesce(g.w_status, '') not in ('proposed', 'approved')
                   and cardinality(g.blocked) = 0 and g.amount > 0, false),
        'approve', coalesce(g.is_m and g.enabled and g.w_status = 'proposed' and g.w_proposed_by is distinct from v_uid
                   and cardinality(g.blocked) = 0 and g.w_dir = g.direction and g.w_amount = g.amount, false),
        'return', coalesce(g.is_m and g.w_status = 'proposed' and g.w_proposed_by is distinct from v_uid, false),
        'withdraw', coalesce(g.w_status = 'proposed' and g.w_proposed_by = v_uid, false),
        'undo', coalesce(g.is_m and g.w_status = 'approved', false)))
      order by g.sort_end, g.deal_id), '[]'::jsonb),
    (select count(*)::integer from picked),
    (select to_char(p.sort_end, 'YYYY-MM-DD') || '|' || p.deal_id::text from picked p where p.rn = v_limit)
    into v_rows, v_count, v_next
  from page g
  join public.branches br on br.id = g.branch_id
  left join public.staff_profiles sp on sp.user_id = g.w_proposed_by;

  return jsonb_build_object('items', v_rows, 'hasMore', v_count > v_limit,
    'nextAfter', case when v_count > v_limit then v_next end);
end;
$$;

-- ===========================================================================
-- 6. R-B2 monthly totals
-- ===========================================================================

-- Approved write-offs (not undone) per branch, by the India-time month of
-- approval. M: own branches; SA: every branch of their entities. Counts and
-- sums only.
create function public.write_off_monthly(p_month date) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_m uuid[];
  v_sa uuid[];
  v_syn boolean;
  v_from date;
  v_to date;
  v_rows jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  v_syn := authz.acct_synthetic();
  if v_syn is null then
    return null;
  end if;
  v_m := authz.acct_m_branches();
  select coalesce(array_agg(e.id), array[]::uuid[]) into v_sa
  from public.legal_entities e where authz.can_switch_live_settings(e.id);
  if cardinality(v_m) = 0 and cardinality(v_sa) = 0 then
    return null;
  end if;
  if p_month is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'month';
  end if;
  v_from := date_trunc('month', p_month)::date;
  v_to := (v_from + interval '1 month')::date;
  select coalesce(jsonb_agg(jsonb_build_object('branchName', b.name, 'count', x.n, 'duePaise', x.due::text,
           'excessPaise', x.excess::text) order by b.name, b.id), '[]'::jsonb)
    into v_rows
  from public.branches b
  cross join lateral (
    select count(*)::integer as n,
      coalesce(sum(w.amount_paise) filter (where w.direction = 'due'), 0)::bigint as due,
      coalesce(sum(w.amount_paise) filter (where w.direction = 'excess'), 0)::bigint as excess
    from public.deal_write_offs w join public.deals d on d.id = w.deal_id
    where w.branch_id = b.id and w.status = 'approved' and d.is_synthetic = v_syn
      and w.decided_at >= (v_from::timestamp at time zone 'Asia/Kolkata')
      and w.decided_at < (v_to::timestamp at time zone 'Asia/Kolkata')) x
  where b.id = any(v_m) or b.legal_entity_id = any(v_sa);
  return jsonb_build_object('month', to_char(v_from, 'YYYY-MM-DD'), 'branches', v_rows);
end;
$$;

-- ===========================================================================
-- 7. Grants
-- ===========================================================================

revoke all on function
  authz.wo_enabled(uuid), authz.wo_limit(uuid), authz.wo_trip_end(uuid), authz.wo_blockers(uuid, text, bigint),
  authz.wo_require_allowed(public.deals, text, bigint), authz.wo_is_approver(public.deal_write_offs),
  authz.wo_result(text, public.deal_write_offs), authz.wo_lock(uuid), authz.wo_reason(text)
  from public, anon, authenticated, service_role;
revoke all on function
  public.write_off_propose(uuid, jsonb, uuid),
  public.write_off_decide(uuid, text, bigint, text, integer, uuid),
  public.write_off_withdraw(uuid, integer, text, uuid),
  public.write_off_undo(uuid, integer, text, uuid),
  public.small_balances_list(jsonb, text, integer),
  public.write_off_monthly(date)
  from public, anon, authenticated, service_role;
grant execute on function
  public.write_off_propose(uuid, jsonb, uuid),
  public.write_off_decide(uuid, text, bigint, text, integer, uuid),
  public.write_off_withdraw(uuid, integer, text, uuid),
  public.write_off_undo(uuid, integer, text, uuid),
  public.small_balances_list(jsonb, text, integer),
  public.write_off_monthly(date)
  to authenticated;

commit;
