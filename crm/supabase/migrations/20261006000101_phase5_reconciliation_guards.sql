-- Phase 5 reconciliation: exact confirmation retries and independent intake gating.
-- No schema/API signature changes. Earlier migrations remain unchanged.
begin;

create or replace function public.purchase_supplier_confirm(p_task_id uuid, p_expected_version_no integer, p_reference text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_cost public.purchase_cost_versions;
  v_proposal public.purchase_cost_versions;
  v_ref text := btrim(coalesce(p_reference, ''));
  v_issues text[];
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- The first confirmation already stores its identity in immutable cost history.
  -- The committed version is NEW: retries must name the accepted PROPOSED
  -- version, not the current committed version. That proposal also fixes the offer.
  if v_task.status = 'supplier_confirmed' then
    v_cost := authz.purchase_latest_cost(v_task.id);
    select * into v_proposal from public.purchase_cost_versions c
      where c.task_id = v_task.id and c.version_no = p_expected_version_no;
    if v_task.supplier_reference = v_ref
       and v_cost.stage = 'committed'
       and p_expected_version_no = v_cost.version_no - 1
       and v_proposal.stage = 'proposed'
       and v_proposal.quote_id = v_cost.quote_id
       and v_proposal.quote_id = v_task.selected_quote_id then
      return jsonb_build_object('outcome', 'existing', 'taskId', v_task.id);
    end if;
    raise exception 'task_conflict' using errcode = '40001';
  end if;
  if length(v_ref) not between 1 and 120 or v_ref ~ E'[\\x01-\\x1f\\x7f]' then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_cost := authz.purchase_latest_cost(v_task.id);
  if v_cost.id is not null and p_expected_version_no is distinct from v_cost.version_no then
    raise exception 'version_changed' using errcode = '40001';
  end if;

  v_issues := authz.procurement_issues(v_task.id);
  if 'environment_unset' = any (v_issues) then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if 'procurement_disabled' = any (v_issues) then
    raise exception 'procurement_disabled' using errcode = '55000';
  end if;
  if v_issues = array['over_budget'] then
    raise exception 'over_budget' using errcode = '55000';
  end if;
  if cardinality(v_issues) > 0 then
    raise exception 'not_ready' using errcode = '55000';
  end if;

  insert into public.purchase_cost_versions (task_id, legal_entity_id, version_no, quote_id, request_id, stage,
    amount_paise, due_date, note, created_by)
  values (v_task.id, v_task.legal_entity_id, v_cost.version_no + 1, v_cost.quote_id, gen_random_uuid(), 'committed',
    v_cost.amount_paise, v_cost.due_date, v_cost.note, (select auth.uid()));
  update public.purchase_quotes q set status = 'selected', updated_at = now() where q.id = v_cost.quote_id;
  update public.fulfilment_tasks t
  set status = 'supplier_confirmed', selected_quote_id = v_cost.quote_id, supplier_reference = v_ref,
      supplier_confirmed_by = (select auth.uid()), supplier_confirmed_at = now(), updated_at = now()
  where t.id = v_task.id;

  insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
  values (v_task.legal_entity_id, 'fulfilment_task', v_task.id, 'fulfilment.supplier_confirmed',
    jsonb_build_object('task_id', v_task.id, 'deal_id', v_task.deal_id, 'service_purpose', v_task.service_purpose))
  on conflict (event_type, aggregate_id) do nothing;

  perform authz.write_audit('purchase.supplier_confirmed', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('quoteId', v_cost.quote_id, 'committedVersionNo', v_cost.version_no + 1));
  return jsonb_build_object('outcome', 'created', 'taskId', v_task.id);
end;
$$;

create or replace function public.integration_receive_bitrix_event(
  p_credential text, p_member_id text, p_domain text, p_event_type text, p_deal_id bigint, p_source_ts bigint
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_enabled integer;
  v_match boolean;
  v_test_portals boolean;
  v_result jsonb;
begin
  -- 1. Receiver credential first: nothing else is read for an unknown caller.
  if not authz.intake_receiver_authorized(p_credential) then
    raise exception 'receiver not authorized' using errcode = '28000';
  end if;

  -- 2. Environment and portal identity (member_id AND domain) from configuration.
  -- Real portal events require the operational database independently of
  -- application placement. Local test fixtures may use reserved .test portals;
  -- test mode must never accept an actual Bitrix portal domain.
  if authz.deployment_environment() not in ('operational', 'test') then
    raise exception 'intake is not configured (environment not operational)' using errcode = '55000';
  end if;
  select count(*)::integer, bool_and(c.portal_domain ~ '\.test$'),
         bool_or(c.portal_member_id = p_member_id
                 and c.portal_domain = authz.normalise_portal_domain(p_domain))
    into v_enabled, v_test_portals, v_match
  from public.integration_intake_config c
  where c.enabled;
  -- None enabled, or more than one (ambiguous: one REST credential per deployment).
  if v_enabled <> 1 then
    raise exception 'intake is not configured' using errcode = '55000';
  end if;
  if authz.deployment_environment() = 'test' and not coalesce(v_test_portals, false) then
    raise exception 'intake is not configured (test portal required)' using errcode = '55000';
  end if;
  if p_member_id is null or p_domain is null or length(p_domain) > 253 or not coalesce(v_match, false) then
    raise exception 'portal not recognised' using errcode = '42501';
  end if;

  -- 3. Existing durable record (dedupe, coalescing, argument checks).
  v_result := public.integration_record_bitrix_event(p_member_id, p_event_type, p_deal_id, p_source_ts);
  return jsonb_build_object('inboxId', v_result -> 'inboxId', 'duplicate', v_result -> 'duplicate');
end;
$$;

commit;
