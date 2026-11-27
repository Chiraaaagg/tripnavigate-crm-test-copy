-- TripNavigate CRM - B1-1 stage 2b: the conflict handlers catch and raise PT409 only
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

-- Stage 2b. After 20261206000200 nothing raises 40001 any more. The seven
-- handlers now catch PT409 only, and the replay/remember wrappers raise
-- duplicate_request with PT409. Afterwards no function in public or authz
-- contains a class-40 SQLSTATE (tests/db/br-no-class40.test.ts).

-- Replaces (newest definition, source migration):
--   authz.cdoc_auto_run_inner(uuid, text)  (20261205000270_auto_bills_since.sql)
--   authz.flight_remember(uuid, uuid, text, jsonb, jsonb)  (20261201000100_flight_workspace.sql)
--   authz.flight_replay(uuid, uuid, text, jsonb)  (20261201000100_flight_workspace.sql)
--   authz.sm_remember(uuid, uuid, text, jsonb, jsonb)  (20261130000200_supplier_money.sql)
--   authz.sm_replay(uuid, uuid, text, jsonb)  (20261130000200_supplier_money.sql)
--   authz.visa_remember(uuid, uuid, text, jsonb, jsonb)  (20261202000110_visa_desk_commands.sql)
--   authz.visa_replay(uuid, uuid, text, jsonb)  (20261202000110_visa_desk_commands.sql)

begin;

-- authz.cdoc_auto_run_inner(uuid, text): from 20261205000270_auto_bills_since.sql
create or replace function authz.cdoc_auto_run_inner(p_deal uuid, p_rule text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_id uuid;
  v_doc public.customer_documents%rowtype;
  v_inv public.customer_documents%rowtype;
  v_exp record;
  v_build jsonb;
  v_codes text[];
  v_state text;
  v_release boolean;
  v_core jsonb;
  v_code text;
  v_budget integer;
  v_since timestamptz;
  v_approved_at timestamptz;
  n_drafted integer := 0;
  n_refreshed integer := 0;
  n_held integer := 0;
  n_ready integer := 0;
  n_released integer := 0;
begin
  -- Lock order 17.1: the finance head of the Deal first.
  v_deal := authz.finance_lock_deal(p_deal);
  if v_deal.id is null then
    return jsonb_build_object('status', 'not_found');
  end if;

  -- Accounts phase 3 (20261205000270, Addendum O3): only sources from switch-on.
  -- Null = drafts never ran: nothing is drafted (existing drafts are still checked).
  select s.auto_bills_since into v_since from public.accounts_settings s where s.legal_entity_id = v_deal.legal_entity_id;

  -- 1a. adv_on_receipt: verified money without any Advance Invoice (a cancelled or discarded one counts: never made again).
  for v_id in
    select r.id from public.customer_receipts r
    where r.deal_id = p_deal and r.status in ('verified', 'cleared')
      and v_since is not null
      and (case when r.status = 'cleared' then r.cleared_at else r.verified_at end) >= v_since
      and not exists (select 1 from public.customer_documents c where c.receipt_id = r.id and c.kind = 'advance_invoice')
    order by r.received_on, r.receipt_no
  loop
    if authz.cdoc_auto_try_draft(v_deal, 'advance_invoice', v_id, null, null, null, 'adv_on_receipt') then
      n_drafted := n_drafted + 1;
    end if;
  end loop;

  -- 1b. inv_on_approval / inv_replace_on_change (LD13).
  select * into v_exp from authz.cdoc_invoice_expected(p_deal) x limit 1;
  -- The Invoice source time: the latest Accounts approval, or an approved / paid cancellation settlement.
  select greatest(
      (select max(rv.last_approved_at) from public.accounts_booking_reviews rv where rv.deal_id = p_deal),
      (select max(q.decided_at) from public.customer_refund_requests q
       where q.deal_id = p_deal and q.kind = 'cancellation' and q.status in ('approved', 'paid')))
    into v_approved_at;
  if v_exp.total is not null and v_since is not null and v_approved_at >= v_since then
    select * into v_inv from public.customer_documents c
    where c.deal_id = p_deal and c.kind = 'invoice' and c.status in ('draft', 'released')
    order by (c.status = 'draft') desc, c.released_at desc nulls last, c.id desc limit 1;
    if v_inv.id is null then
      if not exists (select 1 from public.customer_documents c
                     where c.deal_id = p_deal and c.kind = 'invoice' and c.status in ('discarded', 'cancelled')
                       and c.basis_version_id is not distinct from v_exp.version_id and c.total_paise = v_exp.total) then
        if authz.cdoc_auto_try_draft(v_deal, 'invoice', null, null, null, null, 'inv_on_approval') then
          n_drafted := n_drafted + 1;
        end if;
      end if;
    elsif v_inv.status = 'released'
          and authz.cdoc_settlement_charge(p_deal) is null
          and (v_inv.basis_version_id is distinct from v_exp.version_id or v_inv.total_paise is distinct from v_exp.total)
          and not exists (select 1 from public.customer_documents c
                          where c.replaces_document_id = v_inv.id
                            and (c.status in ('draft', 'released')
                                 or (c.basis_version_id is not distinct from v_exp.version_id and c.total_paise = v_exp.total))) then
      if authz.cdoc_auto_try_draft(v_deal, 'invoice', null, null, v_inv.id, 'Booking changed', 'inv_replace_on_change') then
        n_drafted := n_drafted + 1;
      end if;
    end if;
  end if;

  -- 1c. cn_on_refund (LD12): payout paid, or keep-as-credit / charge-only approved.
  for v_id in
    select q.id from public.customer_refund_requests q
    where q.deal_id = p_deal
      and ((q.status = 'paid' and q.outcome = 'payout') or (q.status = 'approved' and q.outcome in ('keep_credit', 'charge_only')))
      and v_since is not null
      and (case when q.status = 'paid' then q.paid_at else q.decided_at end) >= v_since
      and not exists (select 1 from public.customer_documents c where c.refund_request_id = q.id and c.kind = 'credit_note')
    order by q.requested_at, q.id
  loop
    if authz.cdoc_credit_note_source(v_id) is not null
       and authz.cdoc_auto_try_draft(v_deal, 'credit_note', null, v_id, null, null, 'cn_on_refund') then
      n_drafted := n_drafted + 1;
    end if;
  end loop;

  -- 2-4. Refresh, check and release every automatic draft of the Deal.
  v_release := authz.cdoc_auto_release_on(v_deal.legal_entity_id);
  for v_id in
    select c.id from public.customer_documents c
    where c.deal_id = p_deal and c.status = 'draft' and c.auto_rule is not null
    order by c.created_at, c.id
  loop
    select * into v_doc from public.customer_documents c where c.id = v_id for update;
    if v_doc.status <> 'draft' then
      continue;
    end if;
    v_build := authz.cdoc_build(v_doc.deal_id, v_doc.kind, v_doc.receipt_id, v_doc.refund_request_id, v_doc.replaces_document_id,
      v_doc.tally_invoice_id);
    -- 2. Refresh a stale draft when its source still builds and credits the same document.
    if v_build ->> 'issue' is null
       and nullif(v_build ->> 'creditsDocumentId', '')::uuid is not distinct from v_doc.credits_document_id
       and authz.cdoc_build_hash(v_build) is distinct from v_doc.source_hash then
      update public.customer_documents c
      set content = v_build -> 'content', content_sha256 = authz.finance_payload_hash(v_build -> 'content'),
          source_hash = authz.cdoc_build_hash(v_build), total_paise = (v_build ->> 'totalPaise')::bigint,
          warnings = array(select jsonb_array_elements_text(v_build -> 'warnings')),
          basis_version_id = nullif(v_build ->> 'basisVersionId', '')::uuid,
          refreshed_at = now(), row_version = c.row_version + 1, updated_at = now()
      where c.id = v_doc.id returning * into v_doc;
      n_refreshed := n_refreshed + 1;
      perform authz.write_system_audit('accounts.customer_document.refreshed', v_doc.legal_entity_id, v_doc.branch_id,
        'customer_document', v_doc.id, p_rule,
        jsonb_build_object('documentId', v_doc.id, 'kind', v_doc.kind, 'rowVersion', v_doc.row_version));
    end if;
    -- 3. The checks.
    v_codes := authz.cdoc_auto_codes(v_doc, v_build);
    v_state := case when cardinality(v_codes) = 0 then 'ready' else 'held' end;
    if v_doc.auto_state is distinct from v_state or v_doc.hold_reasons is distinct from v_codes
       or v_doc.evaluated_at is null or v_doc.evaluated_at < now() - interval '5 minutes' then
      update public.customer_documents c
      set auto_state = v_state, hold_reasons = v_codes, evaluated_at = now(), row_version = c.row_version + 1, updated_at = now()
      where c.id = v_doc.id;
      if v_state = 'held' and (v_doc.auto_state is distinct from 'held' or v_doc.hold_reasons is distinct from v_codes) then
        perform authz.write_system_audit('accounts.customer_document.held', v_doc.legal_entity_id, v_doc.branch_id,
          'customer_document', v_doc.id, p_rule, jsonb_build_object('documentId', v_doc.id, 'codes', to_jsonb(v_codes)));
      end if;
    end if;
    if v_state = 'held' then
      n_held := n_held + 1;
      continue;
    end if;
    if not v_release then
      n_ready := n_ready + 1;
      continue;
    end if;
    -- Accounts phase 3 (20261205000260): the sweep's per-tick release budget
    -- (unset for event runs). Over budget, the draft stays ready for the next tick.
    v_budget := nullif(current_setting('tripnavigate.auto_release_budget', true), '')::integer;
    if v_budget is not null and v_budget <= 0 then
      n_ready := n_ready + 1;
      continue;
    end if;
    -- 4. Automatic release: exactly the manual path (cdoc_release_core).
    begin
      v_core := authz.cdoc_release_core(v_doc.id, null, 'auto_release', gen_random_uuid());
      perform authz.write_system_audit('accounts.customer_document.auto_released', v_doc.legal_entity_id, v_doc.branch_id,
        'customer_document', v_doc.id, 'auto_release',
        jsonb_build_object('documentId', v_doc.id, 'kind', v_doc.kind, 'seq', (v_core ->> 'seq')::integer,
          'replacesDocumentId', v_doc.replaces_document_id, 'renderJobId', v_core ->> 'renderJobId'));
      n_released := n_released + 1;
      if v_budget is not null then
        perform set_config('tripnavigate.auto_release_budget', (v_budget - 1)::text, true);
      end if;
    exception when sqlstate '55000' or sqlstate 'PT409' or sqlstate '23505' then
      -- A release refusal the checks did not foresee: held with the nearest code.
      v_code := case sqlerrm
        when 'billing_not_verified' then 'billing_not_verified'
        when 'receipt_not_verified' then 'receipt_not_money'
        when 'company_identity_missing' then 'company_identity_missing'
        when 'number_conflict' then 'number_conflict'
        else 'amount_mismatch' end;
      update public.customer_documents c
      set auto_state = 'held', hold_reasons = array[v_code], evaluated_at = now(), row_version = c.row_version + 1, updated_at = now()
      where c.id = v_doc.id;
      perform authz.write_system_audit('accounts.customer_document.held', v_doc.legal_entity_id, v_doc.branch_id,
        'customer_document', v_doc.id, p_rule, jsonb_build_object('documentId', v_doc.id, 'codes', jsonb_build_array(v_code)));
      n_held := n_held + 1;
    end;
  end loop;

  delete from public.cdoc_auto_pending p where p.deal_id = p_deal;
  return jsonb_build_object('status', 'ok', 'drafted', n_drafted, 'refreshed', n_refreshed, 'held', n_held, 'ready', n_ready,
    'released', n_released);
end;
$$;

-- authz.flight_remember(uuid, uuid, text, jsonb, jsonb): from 20261201000100_flight_workspace.sql
create or replace function authz.flight_remember(p_entity uuid, p_request uuid, p_command text, p_payload jsonb, p_result jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  begin
    return authz.finance_remember(p_entity, p_request, p_command, p_payload, p_result);
  exception when sqlstate 'PT409' then
    raise exception 'duplicate_request' using errcode = 'PT409';
  end;
end;
$$;

-- authz.flight_replay(uuid, uuid, text, jsonb): from 20261201000100_flight_workspace.sql
create or replace function authz.flight_replay(p_entity uuid, p_request uuid, p_command text, p_payload jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_request is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  begin
    return authz.finance_replay(p_entity, p_request, p_command, p_payload);
  exception when sqlstate 'PT409' then
    raise exception 'duplicate_request' using errcode = 'PT409';
  end;
end;
$$;

-- authz.sm_remember(uuid, uuid, text, jsonb, jsonb): from 20261130000200_supplier_money.sql
create or replace function authz.sm_remember(p_entity uuid, p_request uuid, p_command text, p_payload jsonb, p_result jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  begin
    return authz.finance_remember(p_entity, p_request, p_command, p_payload, p_result);
  exception when sqlstate 'PT409' then
    raise exception 'duplicate_request' using errcode = 'PT409';
  end;
end;
$$;

-- authz.sm_replay(uuid, uuid, text, jsonb): from 20261130000200_supplier_money.sql
create or replace function authz.sm_replay(p_entity uuid, p_request uuid, p_command text, p_payload jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_request is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  begin
    return authz.finance_replay(p_entity, p_request, p_command, p_payload);
  exception when sqlstate 'PT409' then
    raise exception 'duplicate_request' using errcode = 'PT409';
  end;
end;
$$;

-- authz.visa_remember(uuid, uuid, text, jsonb, jsonb): from 20261202000110_visa_desk_commands.sql
create or replace function authz.visa_remember(p_entity uuid, p_request uuid, p_command text, p_payload jsonb, p_result jsonb)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  begin
    return authz.finance_remember(p_entity, p_request, p_command, p_payload, p_result);
  exception when sqlstate 'PT409' then
    raise exception 'duplicate_request' using errcode = 'PT409';
  end;
end;
$$;

-- authz.visa_replay(uuid, uuid, text, jsonb): from 20261202000110_visa_desk_commands.sql
create or replace function authz.visa_replay(p_entity uuid, p_request uuid, p_command text, p_payload jsonb) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
begin
  if p_request is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'requestId';
  end if;
  begin
    return authz.finance_replay(p_entity, p_request, p_command, p_payload);
  exception when sqlstate 'PT409' then
    raise exception 'duplicate_request' using errcode = 'PT409';
  end;
end;
$$;

commit;
