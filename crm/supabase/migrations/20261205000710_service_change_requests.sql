-- TripNavigate CRM - Accounts phase 3, track H (2 of 5): add or remove
-- services - the switch, requests and approval rules.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 11.1, 11.2, 11.3,
-- 13, 14, 17.1, 17.3, 19, 21 LD28, LD30, LD32, LD36, LD37, Addendum O1
-- (no customer acceptance proof: the branch Manager's approval is the
-- control), Addendum L7 (the approve hook).
--
-- New (security definer, session first, execute to authenticated):
--   H1 public.admin_set_service_changes_enabled(p_enabled boolean, p_reason text)
--      - Super Admin; audit settings.booking_changes_changed (G's settings
--      trigger, column names and values only; the reason is the audit reason).
-- New internal helpers (no grant):
--   authz.service_changes_enabled()
--   authz.cr_removal_route(p_item uuid) -> 'simple' | 'cancellation' (11.3):
--     cancellation when the service's open task is supplier-confirmed or
--     completed, has a ticket batch (or a batch covers one of its sectors), a
--     submitted visa application, a supplier payment request (pending,
--     approved, paid or verified) or a company-paid fee; otherwise simple.
--   authz.cr_customer_charge(p_fields, p_route) -> customerChargePaise:
--     required (0 allowed) for the cancellation route, absent / null / 0 for
--     the simple route, absent for every other kind; whole paise only.
--   authz.cr_removal_charges(p_change_request) -> one row per thing the
--     department must charge for a booked removal: each open Purchase task of
--     the service with a cost (purchase_cancellation_charges), each ticket
--     batch of its tasks or sectors (flight_cancellation_charges), each
--     company-paid Visa fee of its tasks (visa_cancellation_fees); the latest
--     revision keyed by the request, who entered it, complete.
-- Replaced (latest bodies of track G, same signatures; changed lines marked
-- "Accounts phase 3 (20261205000710)"):
--   public.booking_change_request_create (20261205000620): kinds add_service
--     and remove_service (service_changes_off; allowed before commitment once
--     a confirmed version exists - not_ready hint not_submitted otherwise;
--     revision_open when the return-and-revise draft is open; add names no
--     item; remove names exactly one, never the last service - hint
--     last_service; the route is chosen and stored; customerChargePaise).
--   public.booking_change_request_resubmit (20261205000620) - NOT in the
--     contract's H list; without it a returned add or remove request could
--     never be sent again (reported to the lead): the same kind rules.
--   public.booking_change_open_version (20261205000620): service switch; a
--     remove_service change version opens without the removed service.
--   authz.booking_change_approve_block (20261205000620, Addendum L7):
--     service_changes_off; charges_missing until every charge of a booked
--     removal is entered (also when a simple removal became booked since the
--     request); not_self_approval for a person who entered a current charge.
--
-- Refusal tokens: service_changes_off (55000), charges_missing (55000),
-- not_self_approval (42501), change_open_exists (23505), not_ready (55000,
-- hints not_submitted, not_committed, trip_cancelled, refund_open,
-- revision_open, last_service), invalid_input (22023, hint names the field:
-- itemIds, customerChargePaise, ...), wrong_state, version_changed,
-- not_authorized.
-- Audit: booking.change_requested gains removalRoute (no amount);
-- settings.booking_changes_changed.
-- Rollback (forward-only): a NEW migration restoring the four cited track G
-- bodies and revoking the setter.

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Helpers
-- ===========================================================================

create function authz.service_changes_enabled() returns boolean
language sql stable security definer set search_path = '' as $$
  select coalesce((select s.service_changes_enabled from public.booking_change_settings s where s.id), false)
$$;

create function authz.cr_removal_route(p_item uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when exists (
      select 1 from public.fulfilment_tasks t
      where t.service_item_id = p_item and t.closed_state is null
        and (t.status in ('supplier_confirmed', 'completed')
             or exists (select 1 from public.flight_ticket_batches b where b.cost_task_id = t.id)
             or exists (select 1 from public.visa_applications a where a.task_id = t.id and a.submitted_at is not null)
             or exists (select 1 from public.supplier_payment_requests p
                        where p.task_id = t.id and p.status in ('pending', 'approved', 'paid', 'verified'))
             or exists (select 1 from public.department_cost_entries c where c.task_id = t.id and c.paid_by = 'company')))
    or exists (select 1 from public.flight_ticket_batches b
               join public.flight_sectors s on s.id = any (b.sector_ids)
               where s.service_item_id = p_item)
  then 'cancellation' else 'simple' end
$$;

create function authz.cr_customer_charge(p_fields jsonb, p_route text) returns bigint
language plpgsql volatile set search_path = '' as $$
declare
  v jsonb := p_fields -> 'customerChargePaise';
  v_charge bigint;
begin
  if v is null or jsonb_typeof(v) = 'null' then
    if p_route = 'cancellation' then
      perform authz.cr_invalid('customerChargePaise');
    end if;
    return null;
  end if;
  if jsonb_typeof(v) not in ('string', 'number') or (v #>> '{}') !~ '^(0|[1-9][0-9]{0,11})$' then
    perform authz.cr_invalid('customerChargePaise');
  end if;
  v_charge := (v #>> '{}')::bigint;
  if p_route is null or (p_route = 'simple' and v_charge <> 0) then
    perform authz.cr_invalid('customerChargePaise');
  end if;
  return case when p_route = 'cancellation' then v_charge end;
end;
$$;

-- What the department must charge for a booked removal, and what it entered
-- (latest revision keyed by the request). Ids only; amounts are read by R-H1.
create function authz.cr_removal_charges(p_change_request uuid)
returns table (department text, task_id uuid, subject_id uuid, charge_id uuid, revision_no integer, entered_by uuid,
               entered_at timestamptz, complete boolean)
language sql stable security definer set search_path = '' as $$
  with r as (select x.* from public.booking_change_requests x
             where x.id = p_change_request and x.kind = 'remove_service' and x.removal_route = 'cancellation'),
  tasks as (select t.* from public.fulfilment_tasks t cross join r
            where t.deal_id = r.deal_id and t.service_item_id = any (r.item_ids)
              and (t.closed_state is null or t.closed_change_request_id = r.id))
  select 'purchase'::text, t.id, t.id, x.id, x.revision_no, x.entered_by, x.entered_at, x.id is not null
  from tasks t cross join r
  left join lateral (select y.* from public.purchase_cancellation_charges y
                     where y.change_request_id = r.id and y.task_id = t.id order by y.revision_no desc limit 1) x on true
  where t.department = 'purchase' and exists (select 1 from public.purchase_cost_versions v where v.task_id = t.id)
  union all
  select 'flight'::text, b.cost_task_id, b.id, x.id, x.revision_no, x.entered_by, x.entered_at, x.id is not null
  from public.flight_ticket_batches b cross join r
  left join lateral (select y.* from public.flight_cancellation_charges y
                     where y.change_request_id = r.id and y.batch_id = b.id order by y.revision_no desc limit 1) x on true
  where b.deal_id = r.deal_id
    and (b.cost_task_id in (select t.id from tasks t)
         or exists (select 1 from public.flight_sectors s where s.id = any (b.sector_ids) and s.service_item_id = any (r.item_ids)))
  union all
  select 'visa'::text, c.task_id, c.id, x.id, x.revision_no, x.entered_by, x.entered_at, x.id is not null
  from public.department_cost_entries c cross join r
  left join lateral (select y.* from public.visa_cancellation_fees y
                     where y.change_request_id = r.id and y.entry_id = c.id order by y.revision_no desc limit 1) x on true
  where c.department = 'visa' and c.paid_by = 'company' and c.task_id in (select t.id from tasks t)
$$;

-- ===========================================================================
-- 2. H1 switch (Super Admin)
-- ===========================================================================

create function public.admin_set_service_changes_enabled(p_enabled boolean, p_reason text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_before boolean;
  v_after public.booking_change_settings%rowtype;
  v_reason text;
  v_prev text[];
begin
  if not coalesce(authz.session_ok(), false) or not authz.can_switch_live_settings(null) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_enabled is null then
    raise exception 'invalid_input' using errcode = '22023', hint = 'enabled';
  end if;
  v_reason := authz.cr_reason(p_reason, 'reason');
  select s.service_changes_enabled into v_before from public.booking_change_settings s where s.id for update;
  if not found then
    raise exception 'settings row missing' using errcode = '55000';
  end if;
  v_prev := authz.settings_begin_change('admin_set_service_changes_enabled', v_reason);
  update public.booking_change_settings s set service_changes_enabled = p_enabled, updated_at = now() where s.id
  returning * into v_after;
  perform authz.settings_end_change(v_prev);
  return jsonb_build_object('changed', v_before is distinct from v_after.service_changes_enabled,
    'changesEnabled', v_after.changes_enabled, 'serviceChangesEnabled', v_after.service_changes_enabled,
    'updatedAt', v_after.updated_at);
end;
$$;

-- ===========================================================================
-- 3. Replaced track G commands and the approve hook
-- ===========================================================================

-- Replaces 20261205000620_change_request_commands.sql:392 (latest body; changed lines marked).
create or replace function public.booking_change_request_create(p_deal_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_deal public.deals%rowtype;
  v_role text;
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id, 'fields', p_fields);
  v_result jsonb;
  v_key text;
  v_kind text;
  v_base public.booking_versions%rowtype;
  v_items uuid[];
  v_summary text;
  v_reason text;
  v_row public.booking_change_requests%rowtype;
  v_route text;     -- Accounts phase 3 (20261205000710)
  v_charge bigint;  -- Accounts phase 3 (20261205000710)
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  v_role := authz.cr_requester_role(v_deal.id);
  if v_deal.id is null or v_role is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.refuse_removed_deal(v_deal.id);
  if p_request_id is null then
    perform authz.cr_invalid('requestId');
  end if;
  -- Lock order (17.1): finance head, the Deal row, then the subject.
  perform authz.finance_lock_deal(v_deal.id);
  select * into v_deal from public.deals d where d.id = p_deal_id for no key update;
  v_result := authz.finance_replay(v_deal.legal_entity_id, p_request_id, 'booking_change_request_create', v_payload);
  if v_result is not null then
    return v_result;
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    perform authz.cr_invalid('fields');
  end if;
  for v_key in select k from jsonb_object_keys(p_fields) k order by k loop
    -- Accounts phase 3 (20261205000710): + customerChargePaise (a booked service being removed, 11.3).
    if v_key <> all (array['kind', 'itemIds', 'changeSummary', 'reason', 'customerChargePaise']) then
      perform authz.cr_invalid(v_key);
    end if;
  end loop;
  v_kind := authz.cr_text(p_fields, 'kind', 1, 20, false);
  if v_kind not in ('change', 'add_service', 'remove_service') then
    perform authz.cr_invalid('kind');
  end if;
  -- Accounts phase 3 (20261205000710): adding or removing a service needs its own switch (11.1).
  if v_kind <> 'change' then
    if not authz.service_changes_enabled() then
      raise exception 'service_changes_off' using errcode = '55000';
    end if;
  elsif not authz.booking_changes_enabled() then
    raise exception 'changes_off' using errcode = '55000';
  end if;

  -- The accepted version (base).
  select * into v_base from public.booking_versions v
  where v.deal_id = v_deal.id and v.status = 'confirmed' order by v.version_no desc limit 1 for update;
  if v_base.id is not null and v_base.service_type <> 'package' then
    raise exception 'change_not_supported' using errcode = '55000';  -- LD36
  end if;
  -- Accounts phase 3 (20261205000710): adding or removing a service is also allowed before commitment, once the
  -- booking was submitted (a confirmed version exists, 11.1); a change needs a committed Deal.
  if v_base.id is null then
    raise exception 'not_ready' using errcode = '55000', hint = case when v_kind = 'change' then 'not_committed' else 'not_submitted' end;
  end if;
  if v_kind = 'change' and not authz.deal_committed(v_deal.id) then
    raise exception 'not_ready' using errcode = '55000', hint = 'not_committed';
  end if;
  if authz.deal_trip_cancelled(v_deal.id) then
    raise exception 'not_ready' using errcode = '55000', hint = 'trip_cancelled';
  end if;
  if exists (select 1 from public.customer_refund_requests r
             where r.deal_id = v_deal.id
               and (r.status in ('requested', 'returned') or (r.status = 'approved' and r.outcome = 'payout'))) then
    raise exception 'not_ready' using errcode = '55000', hint = 'refund_open';
  end if;
  if authz.deal_change_open(v_deal.id) then
    raise exception 'change_open_exists' using errcode = '23505';
  end if;
  -- Accounts phase 3 (20261205000710): before commitment the ordinary return-and-revise draft may be open.
  if v_kind <> 'change' and exists (select 1 from public.booking_versions v
                                    where v.revises_version_id = v_base.id and v.status = 'draft') then
    raise exception 'not_ready' using errcode = '55000', hint = 'revision_open';
  end if;

  -- Accounts phase 3 (20261205000710): items per kind (change 1..20; add none - recorded as they are added;
  -- remove exactly one, never the last service) and the removal route (11.3).
  if v_kind = 'add_service' then
    perform authz.cr_item_ids(p_fields, v_base.id, 0, 0);
    v_items := '{}'::uuid[];
  elsif v_kind = 'remove_service' then
    v_items := authz.cr_item_ids(p_fields, v_base.id, 1, 1);
    if (select count(*) from public.service_item_facts f where f.booking_version_id = v_base.id) < 2 then
      raise exception 'not_ready' using errcode = '55000', hint = 'last_service';
    end if;
    v_route := authz.cr_removal_route(v_items[1]);
  else
    v_items := authz.cr_item_ids(p_fields, v_base.id, 1, 20);
  end if;
  v_charge := authz.cr_customer_charge(p_fields, v_route);
  v_summary := authz.cr_text(p_fields, 'changeSummary', 10, 500, false);
  v_reason := authz.cr_text(p_fields, 'reason', 10, 500, false);

  begin
    insert into public.booking_change_requests (legal_entity_id, branch_id, deal_id, ref_no, kind, base_version_id, item_ids,
      change_summary, reason, requested_as, requested_by, request_id,
      removal_route, customer_charge_paise)  -- Accounts phase 3 (20261205000710)
    values (v_deal.legal_entity_id, v_deal.branch_id, v_deal.id, authz.cr_next_ref(v_deal.legal_entity_id), v_kind, v_base.id,
      v_items, v_summary, v_reason, v_role, v_uid, p_request_id,
      v_route, v_charge)
    returning * into v_row;
  exception when unique_violation then
    raise exception 'change_open_exists' using errcode = '23505';
  end;

  perform authz.write_audit('booking.change_requested', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request', v_row.id,
    v_reason, jsonb_build_object('changeRequestId', v_row.id, 'dealId', v_row.deal_id, 'kind', v_row.kind,
      'itemCount', cardinality(v_row.item_ids),
      'removalRoute', v_row.removal_route));  -- Accounts phase 3 (20261205000710): no amount in the audit
  v_result := authz.cr_json(v_row) || jsonb_build_object('outcome', 'created');
  return authz.finance_remember(v_row.legal_entity_id, p_request_id, 'booking_change_request_create', v_payload, v_result);
end;
$$;

-- Replaces 20261205000620_change_request_commands.sql:517 (latest body; changed lines marked).
create or replace function public.booking_change_request_resubmit(p_id uuid, p_expected_row_version integer, p_fields jsonb, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.booking_change_requests%rowtype;
  v_payload jsonb := jsonb_build_object('id', p_id, 'expectedRowVersion', p_expected_row_version, 'fields', p_fields);
  v_result jsonb;
  v_key text;
  v_kind text;
  v_items uuid[];
  v_summary text;
  v_reason text;
  v_route text;     -- Accounts phase 3 (20261205000710)
  v_charge bigint;  -- Accounts phase 3 (20261205000710)
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_row from public.booking_change_requests r where r.id = p_id;
  if v_row.id is null or v_row.requested_by is distinct from v_uid or authz.cr_requester_role(v_row.deal_id) is null then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    perform authz.cr_invalid('requestId');
  end if;
  v_row := authz.cr_lock(p_id);
  v_result := authz.finance_replay(v_row.legal_entity_id, p_request_id, 'booking_change_request_resubmit', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_row.status <> 'returned' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_row.row_version);
  if v_row.kind = 'change' and not authz.booking_changes_enabled() then
    raise exception 'changes_off' using errcode = '55000';
  end if;
  -- Accounts phase 3 (20261205000710): adding or removing a service needs its own switch.
  if v_row.kind <> 'change' and not authz.service_changes_enabled() then
    raise exception 'service_changes_off' using errcode = '55000';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    perform authz.cr_invalid('fields');
  end if;
  for v_key in select k from jsonb_object_keys(p_fields) k order by k loop
    -- Accounts phase 3 (20261205000710): + customerChargePaise (a booked service being removed, 11.3).
    if v_key <> all (array['kind', 'itemIds', 'changeSummary', 'reason', 'customerChargePaise']) then
      perform authz.cr_invalid(v_key);
    end if;
  end loop;
  v_kind := coalesce(authz.cr_text(p_fields, 'kind', 1, 20, true), v_row.kind);
  if v_kind <> v_row.kind then
    perform authz.cr_invalid('kind');
  end if;
  if not exists (select 1 from public.booking_versions v where v.id = v_row.base_version_id and v.status = 'confirmed') then
    raise exception 'version_superseded' using errcode = '55000';
  end if;
  -- Accounts phase 3 (20261205000710): items per kind and the removal route, recomputed (11.3).
  if v_row.kind = 'add_service' then
    perform authz.cr_item_ids(p_fields, v_row.base_version_id, 0, 0);
    v_items := '{}'::uuid[];
  elsif v_row.kind = 'remove_service' then
    v_items := authz.cr_item_ids(p_fields, v_row.base_version_id, 1, 1);
    if (select count(*) from public.service_item_facts f where f.booking_version_id = v_row.base_version_id) < 2 then
      raise exception 'not_ready' using errcode = '55000', hint = 'last_service';
    end if;
    v_route := authz.cr_removal_route(v_items[1]);
  else
    v_items := authz.cr_item_ids(p_fields, v_row.base_version_id, 1, 20);
  end if;
  v_charge := authz.cr_customer_charge(p_fields, v_route);
  v_summary := authz.cr_text(p_fields, 'changeSummary', 10, 500, false);
  v_reason := authz.cr_text(p_fields, 'reason', 10, 500, false);

  update public.booking_change_requests r
  set status = 'requested', item_ids = v_items, change_summary = v_summary, reason = v_reason,
      removal_route = v_route, customer_charge_paise = v_charge,  -- Accounts phase 3 (20261205000710)
      decided_by = null, decided_at = null, decision_request_id = null, row_version = r.row_version + 1
  where r.id = v_row.id
  returning * into v_row;
  perform authz.write_audit('booking.change_resubmitted', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request', v_row.id,
    v_reason, jsonb_build_object('changeRequestId', v_row.id, 'dealId', v_row.deal_id, 'kind', v_row.kind,
      'itemCount', cardinality(v_row.item_ids), 'rowVersion', v_row.row_version));
  v_result := authz.cr_json(v_row) || jsonb_build_object('outcome', 'updated');
  return authz.finance_remember(v_row.legal_entity_id, p_request_id, 'booking_change_request_resubmit', v_payload, v_result);
end;
$$;

-- Replaces 20261205000620_change_request_commands.sql:739 (latest body; changed lines marked).
create or replace function public.booking_change_open_version(p_change_request_id uuid, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.booking_change_requests%rowtype;
  v_payload jsonb := jsonb_build_object('changeRequestId', p_change_request_id);
  v_result jsonb;
  v_base public.booking_versions%rowtype;
  v_ver public.booking_versions%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_row from public.booking_change_requests r where r.id = p_change_request_id;
  if v_row.id is null
     or not ((v_row.requested_by = v_uid and authz.cr_requester_role(v_row.deal_id) is not null)
             or authz.refund_is_so(v_row.deal_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.refuse_removed_deal(v_row.deal_id);
  if p_request_id is null then
    perform authz.cr_invalid('requestId');
  end if;
  v_row := authz.cr_lock(p_change_request_id);
  v_result := authz.finance_replay(v_row.legal_entity_id, p_request_id, 'booking_change_open_version', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_row.status <> 'approved' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if v_row.kind = 'change' and not authz.booking_changes_enabled() then
    raise exception 'changes_off' using errcode = '55000';
  end if;
  -- Accounts phase 3 (20261205000710): adding or removing a service needs its own switch.
  if v_row.kind <> 'change' and not authz.service_changes_enabled() then
    raise exception 'service_changes_off' using errcode = '55000';
  end if;
  if v_row.change_version_id is not null then
    select * into v_ver from public.booking_versions v where v.id = v_row.change_version_id;
    v_result := jsonb_build_object('changeRequestId', v_row.id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no,
      'rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash, 'outcome', 'existing');
    return authz.finance_remember(v_row.legal_entity_id, p_request_id, 'booking_change_open_version', v_payload, v_result);
  end if;
  -- Lock order: base version (17.1).
  select * into v_base from public.booking_versions v where v.id = v_row.base_version_id for update;
  if v_base.status <> 'confirmed' then
    raise exception 'version_superseded' using errcode = '55000';
  end if;
  if exists (select 1 from public.booking_versions v where v.revises_version_id = v_base.id and v.status = 'draft') then
    raise exception 'not_ready' using errcode = '55000', hint = 'revision_open';
  end if;

  v_ver := authz.booking_revision_copy(v_base.id, v_row.id);
  -- Accounts phase 3 (20261205000710): a service being removed is absent from the change version (its facts,
  -- participants and estimates; it cannot be put back in this version, 11.3).
  if v_row.kind = 'remove_service' then
    delete from public.service_item_facts f where f.booking_version_id = v_ver.id and f.service_item_id = any (v_row.item_ids);
    select * into v_ver from public.booking_versions v where v.id = v_ver.id;
  end if;
  update public.booking_change_requests r set change_version_id = v_ver.id, row_version = r.row_version + 1
  where r.id = v_row.id
  returning * into v_row;

  perform authz.write_audit('booking.change_version_opened', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request',
    v_row.id, null, jsonb_build_object('changeRequestId', v_row.id, 'dealId', v_row.deal_id, 'versionId', v_ver.id,
      'versionNo', v_ver.version_no, 'baseVersionId', v_base.id));
  v_result := jsonb_build_object('changeRequestId', v_row.id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no,
    'rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash, 'outcome', 'created');
  return authz.finance_remember(v_row.legal_entity_id, p_request_id, 'booking_change_open_version', v_payload, v_result);
end;
$$;

-- Replaces 20261205000620_change_request_commands.sql:163 (latest body; changed lines marked).
create or replace function authz.booking_change_approve_block(p_change_request uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_row public.booking_change_requests%rowtype;
begin
  -- Accounts phase 3 (20261205000710): switch, route and supplier charges of a service removal (11.1, 11.3, LD30).
  select * into v_row from public.booking_change_requests r where r.id = p_change_request;
  if v_row.id is null or v_row.kind = 'change' then
    return null;
  end if;
  if not authz.service_changes_enabled() then
    return 'service_changes_off';
  end if;
  if v_row.kind = 'remove_service' then
    -- Something was booked or paid since the request: it must go through the charges (returned, then sent again).
    if v_row.removal_route = 'simple' and authz.cr_removal_route(v_row.item_ids[1]) = 'cancellation' then
      return 'charges_missing';
    end if;
    if v_row.removal_route = 'cancellation' then
      if exists (select 1 from authz.cr_removal_charges(v_row.id) c where not c.complete) then
        return 'charges_missing';
      end if;
      -- Never approved by a person who entered a current charge.
      if exists (select 1 from authz.cr_removal_charges(v_row.id) c where c.entered_by = (select auth.uid())) then
        return 'not_self_approval';
      end if;
    end if;
  end if;
  return null;
end;
$$;

revoke all on function authz.service_changes_enabled(), authz.cr_removal_route(uuid), authz.cr_customer_charge(jsonb, text),
  authz.cr_removal_charges(uuid)
from public, anon, authenticated, service_role;
revoke all on function public.admin_set_service_changes_enabled(boolean, text) from public, anon, authenticated, service_role;
grant execute on function public.admin_set_service_changes_enabled(boolean, text) to authenticated;
-- The replaced commands keep their grants (CREATE OR REPLACE).

commit;
