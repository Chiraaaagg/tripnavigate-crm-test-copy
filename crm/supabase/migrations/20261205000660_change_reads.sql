-- TripNavigate CRM - Accounts phase 3, track G (6b of 6): change reads.
-- Contract: accounts-phase3-2026-11-12/contract.md sections 10.5 (R-G1 -
-- R-G4), 14 (fences: every read returns null when not allowed, never a
-- partial object), 17.4 (no per-row definer function inside list scans).
--
-- New reads (security definer, session first, execute to authenticated):
--   R-G1 public.deal_change_requests(p_deal_id) - SO, branch M, A (read):
--        the Deal's requests with their reconfirmation states. supplierName and
--        reference of confirmed services for M and A only. No cost or rate.
--   R-G2 public.change_requests_list(p_filter, p_after, p_limit) - M (their
--        branches; preset to_approve), SO (own Deals), A (entity, read-only);
--        keyset (requested_at desc, id desc); can {approve, return} per row.
--   R-G3 public.task_reconfirmation_get(p_task_id) - the task's Purchase
--        readers (authz.can_read_purchase_workspace) and the branch Manager:
--        the latest reconfirmation of the task, old and new department-safe
--        facts (money keys removed), never a selling price. Null when the task
--        has no reconfirmation.
--   R-G4 public.deal_change_history(p_deal_id) - SO, branch M, A: confirmed
--        and superseded versions with their change requests, and every
--        confirmation in time order; amountPaise / changeFeePaise keys for M
--        and A only; supplierName / reference for M and A only. Purchase
--        holders of the entity: only the confirmations of tasks assigned to
--        them and department-safe changed fields.
--   + public.booking_change_preview(p_change_request_id) (NOT in contract
--        10.5; reported to the lead): what the change-mode form needs for G6
--        (content hash, the changed services the screen must send, services
--        outside the request, readiness codes). Requester, SO, branch M.
--
-- Rollback (forward-only): a NEW migration revoking execute on the reads.

begin;
set local lock_timeout = '15s';

-- The caller's reader kind for a Deal's change requests: 'accounts',
-- 'manager', 'sales' or null (Phase 2 refund readers: A, M, SO). A holder of
-- Purchase, Flight or Visa in the entity is none of them (fence 14).
create function authz.cr_viewer(p_deal uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case when authz.refund_pfv(d.legal_entity_id) then null else authz.refund_viewer(d.id) end
  from public.deals d where d.id = p_deal
$$;

-- Department-safe facts of an item in a version (money keys removed).
create function authz.cr_safe_facts(p_item uuid, p_version uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((select jsonb_object_agg(k, f.facts -> k)
                   from jsonb_object_keys(f.facts) k
                   where not authz.purchase_money_key(k)), '{}'::jsonb)
  from public.service_item_facts f
  where f.service_item_id = p_item and f.booking_version_id = p_version
$$;

-- ===========================================================================
-- R-G1
-- ===========================================================================

create function public.deal_change_requests(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_viewer text;
  v_am boolean;
  v_deal public.deals%rowtype;
  v_base public.booking_versions%rowtype;
  v_blocked text[] := '{}'::text[];
  v_role text;
  v_is_m boolean;
  v_is_so boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  v_viewer := authz.cr_viewer(p_deal_id);
  if v_viewer is null then
    return null;
  end if;
  v_am := v_viewer in ('accounts', 'manager');
  select * into v_deal from public.deals d where d.id = p_deal_id;
  select * into v_base from public.booking_versions v
  where v.deal_id = v_deal.id and v.status = 'confirmed' order by v.version_no desc limit 1;
  v_role := case when v_viewer in ('sales', 'manager') then authz.cr_requester_role(v_deal.id) end;
  v_is_m := authz.refund_is_m(v_deal.id);
  v_is_so := authz.refund_is_so(v_deal.id);
  if not authz.booking_changes_enabled() then
    v_blocked := array_append(v_blocked, 'changes_off');
  end if;
  if v_base.id is not null and v_base.service_type <> 'package' then
    v_blocked := array_append(v_blocked, 'change_not_supported');
  end if;
  if v_base.id is null or not authz.deal_committed(v_deal.id) then
    v_blocked := array_append(v_blocked, 'not_committed');
  end if;
  if authz.deal_trip_cancelled(v_deal.id) then
    v_blocked := array_append(v_blocked, 'trip_cancelled');
  end if;
  if exists (select 1 from public.customer_refund_requests r
             where r.deal_id = v_deal.id
               and (r.status in ('requested', 'returned') or (r.status = 'approved' and r.outcome = 'payout'))) then
    v_blocked := array_append(v_blocked, 'refund_open');
  end if;
  if authz.deal_change_open(v_deal.id) then
    v_blocked := array_append(v_blocked, 'change_open');
  end if;

  return jsonb_build_object(
    'dealId', v_deal.id,
    'enabled', authz.booking_changes_enabled(),
    'canRequest', v_role is not null and cardinality(v_blocked) = 0,
    'blockedBy', to_jsonb(v_blocked),
    'confirmed', coalesce((
      select jsonb_agg(jsonb_build_object(
          'itemId', i.id, 'itemNo', i.item_no,
          'serviceTitle', coalesce(authz.service_item_title(i.service_type, f.facts), 'Service'),
          'department', t.department, 'taskStatus', t.status,
          'supplierName', case when v_am then s.name end,
          'reference', case when v_am then t.supplier_reference end)
        order by i.item_no)
      from public.service_item_facts f
      join public.service_items i on i.id = f.service_item_id
      join public.fulfilment_tasks t on t.service_item_id = i.id and t.deal_id = v_deal.id
      left join public.purchase_quotes q on q.id = t.selected_quote_id
      left join public.suppliers s on s.id = q.supplier_id
      where f.booking_version_id = v_base.id and t.status in ('supplier_confirmed', 'completed')), '[]'::jsonb),
    'requests', coalesce((
      select jsonb_agg(jsonb_build_object(
          'id', r.id, 'refNo', r.ref_no, 'kind', r.kind, 'status', r.status,
          'itemNos', coalesce((select jsonb_agg(i.item_no order by i.item_no) from public.service_items i where i.id = any (r.item_ids)),
                              '[]'::jsonb),
          'changeSummary', r.change_summary, 'reason', r.reason,
          'requestedByName', rp.display_name, 'requestedAt', r.requested_at,
          'decidedByName', dp.display_name, 'decidedAt', r.decided_at, 'returnReason', r.return_reason,
          'changeVersionId', r.change_version_id,
          'reconfirmations', coalesce((
            select jsonb_agg(jsonb_build_object(
                'taskId', x.task_id,
                'serviceTitle', coalesce(authz.service_item_title(xi.service_type, xf.facts), 'Service'),
                'status', x.status, 'overBudget', x.over_budget, 'refusedReason', x.refused_reason)
              order by xi.item_no)
            from public.task_reconfirmations x
            join public.fulfilment_tasks xt on xt.id = x.task_id
            join public.service_items xi on xi.id = xt.service_item_id
            left join public.service_item_facts xf on xf.service_item_id = xi.id and xf.booking_version_id = x.booking_version_id
            where x.change_request_id = r.id), '[]'::jsonb),
          'closeReason', r.close_reason, 'rowVersion', r.row_version,
          'can', jsonb_build_object(
            'resubmit', r.status = 'returned' and r.requested_by = v_uid and v_role is not null,
            'withdraw', r.status in ('requested', 'returned', 'approved', 'submitted')
                        and ((r.requested_by = v_uid and v_role is not null) or v_is_m),
            'openVersion', r.status = 'approved' and r.change_version_id is null
                           and ((r.requested_by = v_uid and v_role is not null) or v_is_so),
            'submit', r.status = 'approved' and r.change_version_id is not null
                      and ((r.requested_by = v_uid and v_role is not null) or v_is_so)))
        order by r.requested_at desc, r.id desc)
      from public.booking_change_requests r
      left join public.staff_profiles rp on rp.user_id = r.requested_by
      left join public.staff_profiles dp on dp.user_id = r.decided_by
      where r.deal_id = v_deal.id), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- R-G2
-- ===========================================================================

create function public.change_requests_list(p_filter jsonb, p_after text default null, p_limit integer default 50)
returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_filter jsonb := coalesce(p_filter, '{}'::jsonb);
  v_a uuid[];
  v_m uuid[];
  v_sales boolean;
  v_preset text;
  v_branch uuid;
  v_ref text;
  v_after_ts timestamptz;
  v_after_id uuid;
  v_limit integer := least(greatest(coalesce(p_limit, 50), 1), 200);
  v_rows jsonb;
  v_n integer;
  v_next text;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  v_a := authz.acct_a_entities();
  v_m := array(select b.id from public.branches b
               where b.id = any (authz.manager_branch_ids()) and not authz.refund_pfv(b.legal_entity_id));
  v_sales := exists (select 1 from public.memberships m
                     where m.user_id = v_uid and m.role_code = 'sales' and m.status = 'active'
                       and not authz.refund_pfv(m.legal_entity_id));
  if cardinality(v_a) = 0 and cardinality(v_m) = 0 and not v_sales then
    return null;
  end if;
  if jsonb_typeof(v_filter) <> 'object' then
    perform authz.cr_invalid('filter');
  end if;
  v_preset := coalesce(nullif(v_filter ->> 'preset', ''), 'all');
  if v_preset not in ('all', 'open', 'to_approve') then
    perform authz.cr_invalid('preset');
  end if;
  begin
    v_ref := nullif(btrim(v_filter ->> 'dealReference'), '');
    v_branch := nullif(v_filter ->> 'branchId', '')::uuid;
    if p_after is not null then
      v_after_ts := split_part(p_after, '|', 1)::timestamptz;
      v_after_id := split_part(p_after, '|', 2)::uuid;
    end if;
  exception when others then
    perform authz.cr_invalid('filter');
  end;

  with scoped as (
    select r.*, d.reference, d.title, b.name as branch_name
    from public.booking_change_requests r
    join public.deals d on d.id = r.deal_id
    join public.branches b on b.id = r.branch_id
    where (r.legal_entity_id = any (v_a) or r.branch_id = any (v_m)
           or (v_sales and d.owner_user_id = v_uid))
      and (v_ref is null or d.reference = v_ref)
      and (v_branch is null or r.branch_id = v_branch)
      and (v_preset = 'all'
           or (v_preset = 'open' and r.status in ('requested', 'returned', 'approved', 'submitted'))
           or (v_preset = 'to_approve' and r.status = 'requested' and r.requested_by <> v_uid
               and (r.branch_id = any (v_m) or r.requested_as = 'manager')))
      and (v_after_ts is null or (r.requested_at, r.id) < (v_after_ts, v_after_id))
    order by r.requested_at desc, r.id desc
    limit v_limit + 1
  ), numbered as (
    select s.*, row_number() over (order by s.requested_at desc, s.id desc) as n from scoped s
  ), page as (
    -- Per-row checks only for the page (17.4).
    select x.*, (x.status = 'requested' and x.requested_by <> v_uid and authz.cr_is_approver(x.id)) as can_decide
    from numbered x where x.n <= v_limit
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'refNo', p.ref_no, 'dealId', p.deal_id, 'dealReference', p.reference, 'dealTitle', p.title,
      'branchName', p.branch_name, 'kind', p.kind, 'status', p.status,
      'itemNos', coalesce((select jsonb_agg(i.item_no order by i.item_no) from public.service_items i where i.id = any (p.item_ids)),
                          '[]'::jsonb),
      'changeSummary', p.change_summary, 'reason', p.reason, 'requestedByName', rp.display_name,
      'requestedAt', p.requested_at, 'rowVersion', p.row_version,
      'can', jsonb_build_object('approve', p.can_decide, 'return', p.can_decide),
      'cursor', to_char(p.requested_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') || '|' || p.id::text)
      order by p.n), '[]'::jsonb),
    (select count(*)::integer from numbered)
  into v_rows, v_n
  from page p
  left join public.staff_profiles rp on rp.user_id = p.requested_by;
  if v_n > v_limit then
    v_next := (v_rows -> (v_limit - 1)) ->> 'cursor';
  end if;
  -- to_approve: only rows the caller may decide.
  if v_preset = 'to_approve' then
    v_rows := coalesce((select jsonb_agg(e order by o) from jsonb_array_elements(v_rows) with ordinality as t(e, o)
                        where (e -> 'can' ->> 'approve')::boolean), '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'items', (select coalesce(jsonb_agg(e - 'cursor' order by o), '[]'::jsonb) from jsonb_array_elements(v_rows) with ordinality as t(e, o)),
    'nextAfter', v_next,
    'hasMore', v_n > v_limit);
end;
$$;

-- ===========================================================================
-- R-G3
-- ===========================================================================

create function public.task_reconfirmation_get(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_x public.task_reconfirmations%rowtype;
  v_r public.booking_change_requests%rowtype;
  v_cost public.purchase_cost_versions;
  v_work boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  -- Purchase holders of the entity (not also a branch Manager of the Deal), or
  -- the branch Manager without Purchase / Flight / Visa (section 4, Addendum L5).
  if v_task.id is null or v_task.department is distinct from 'purchase' or not authz.session_ok()
     or not ((authz.holds_active_role('purchase', v_task.legal_entity_id) and not authz.is_branch_sales_manager(v_task.deal_id))
             or authz.refund_is_m(v_task.deal_id)) then
    return null;
  end if;
  select * into v_x from public.task_reconfirmations x where x.task_id = v_task.id order by x.created_at desc, x.id desc limit 1;
  if v_x.id is null then
    return null;
  end if;
  select * into v_r from public.booking_change_requests r where r.id = v_x.change_request_id;
  select c.* into v_cost from public.purchase_cost_versions c
  where c.task_id = v_task.id and c.stage = 'committed' order by c.version_no desc limit 1;
  v_work := authz.can_work_purchase_task(v_task.id);
  return jsonb_build_object(
    'taskId', v_task.id,
    'changeRequest', jsonb_build_object('refNo', v_r.ref_no, 'status', v_r.status),
    'old', jsonb_build_object(
      'details', authz.cr_safe_facts(v_task.service_item_id, v_r.base_version_id),
      'ratePaise', v_cost.amount_paise::text,
      'reference', v_task.supplier_reference,
      'confirmedAt', v_task.supplier_confirmed_at),
    'new', jsonb_build_object(
      'details', authz.cr_safe_facts(v_task.service_item_id, v_x.booking_version_id),
      'changedFields', to_jsonb(authz.revision_department_fields(v_x.booking_version_id))),
    'reconfirmation', jsonb_build_object(
      'id', v_x.id, 'status', v_x.status, 'newRatePaise', v_x.new_rate_paise::text, 'supplierFeePaise', v_x.supplier_fee_paise::text,
      'newReference', v_x.new_reference, 'evidenceId', v_x.evidence_id, 'overBudget', v_x.over_budget,
      'budgetPaise', v_x.budget_paise::text, 'refusedReason', v_x.refused_reason, 'rowVersion', v_x.row_version),
    'can', jsonb_build_object(
      'record', v_work and v_x.status = 'pending' and v_r.status = 'submitted',
      'refuse', v_work and v_x.status in ('pending', 'recorded') and v_r.status = 'submitted',
      'approveOverBudget', v_x.status = 'recorded' and v_x.over_budget and v_x.over_budget_approved_by is null
                           and v_r.status = 'submitted' and v_x.recorded_by is distinct from v_uid
                           and authz.can_manage_purchase_task(v_task.id) and authz.cr_is_approver(v_r.id)));
end;
$$;

-- ===========================================================================
-- R-G4
-- ===========================================================================

create function public.deal_change_history(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_viewer text;
  v_am boolean;
  v_purchase boolean := false;
  v_deal public.deals%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null then
    return null;
  end if;
  v_viewer := authz.cr_viewer(v_deal.id);
  if v_viewer is null then
    if authz.holds_active_role('purchase', v_deal.legal_entity_id) and not authz.is_branch_sales_manager(v_deal.id)
       and exists (select 1 from public.fulfilment_tasks t
                   where t.deal_id = v_deal.id and t.department = 'purchase' and t.assignee_user_id = v_uid) then
      v_purchase := true;
    else
      return null;
    end if;
  end if;
  v_am := v_viewer in ('accounts', 'manager');
  return jsonb_build_object(
    'dealId', v_deal.id,
    'versions', coalesce((
      select jsonb_agg(jsonb_build_object(
          'versionNo', v.version_no, 'status', v.status, 'confirmedAt', v.confirmed_at,
          'changedFields', case when v_purchase then to_jsonb(authz.revision_department_fields(v.id))
                                else to_jsonb(coalesce(v.changed_fields, '{}'::text[])) end,
          'changeRequest', case when r.id is not null then jsonb_build_object(
            'refNo', r.ref_no, 'kind', r.kind, 'requestedByName', rp.display_name, 'decidedByName', dp.display_name) end)
        order by v.confirmed_at, v.version_no)
      from public.booking_versions v
      left join public.booking_change_requests r on r.id = v.change_request_id
      left join public.staff_profiles rp on rp.user_id = r.requested_by
      left join public.staff_profiles dp on dp.user_id = r.decided_by
      where v.deal_id = v_deal.id and v.status in ('confirmed', 'superseded')), '[]'::jsonb),
    'confirmations', coalesce((
      select jsonb_agg(jsonb_build_object(
          'taskId', c.task_id,
          'serviceTitle', coalesce(authz.service_item_title(i.service_type, f.facts), 'Service'),
          'confirmationNo', c.confirmation_no,
          'supplierName', case when v_am or v_purchase then s.name end,
          'reference', case when v_am or v_purchase then c.supplier_reference end,
          'confirmedByName', cp.display_name, 'confirmedAt', c.confirmed_at)
        || case when v_am then jsonb_build_object('amountPaise', c.amount_paise::text,
                                                  'changeFeePaise', c.change_fee_paise::text)
           else '{}'::jsonb end
        order by c.confirmed_at, c.task_id, c.confirmation_no)
      from public.task_confirmations c
      join public.fulfilment_tasks t on t.id = c.task_id
      join public.service_items i on i.id = t.service_item_id
      left join public.service_item_facts f on f.service_item_id = i.id and f.booking_version_id = c.booking_version_id
      left join public.purchase_quotes q on q.id = c.quote_id
      left join public.suppliers s on s.id = q.supplier_id
      left join public.staff_profiles cp on cp.user_id = c.confirmed_by
      where t.deal_id = v_deal.id and (not v_purchase or t.assignee_user_id = v_uid)), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- Change-mode preview (not in contract 10.5; for the G6 form)
-- ===========================================================================

create function public.booking_change_preview(p_change_request_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_r public.booking_change_requests%rowtype;
  v_ver public.booking_versions%rowtype;
  v_changed uuid[] := '{}'::uuid[];
  v_issues text[] := '{}'::text[];
  v_actor boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v_r from public.booking_change_requests r where r.id = p_change_request_id;
  if v_r.id is null or authz.cr_viewer(v_r.deal_id) not in ('sales', 'manager') then
    return null;
  end if;
  v_actor := (v_r.requested_by = v_uid and authz.cr_requester_role(v_r.deal_id) is not null) or authz.refund_is_so(v_r.deal_id);
  select * into v_ver from public.booking_versions v where v.id = v_r.change_version_id;
  if v_ver.id is not null and v_ver.status = 'draft' then
    v_changed := authz.cr_changed_item_ids(v_ver.id);
    v_issues := array(select i from unnest(authz.booking_issues(v_ver.id)) i
                      where i not in ('revision_class_missing'));
  end if;
  return jsonb_build_object(
    'changeRequestId', v_r.id, 'refNo', v_r.ref_no, 'kind', v_r.kind, 'status', v_r.status,
    'changeSummary', v_r.change_summary,
    'versionId', v_ver.id, 'rowVersion', v_ver.row_version,
    'contentHash', case when v_ver.status = 'draft' then authz.booking_content_hash(v_ver.id) end,
    'requestItemIds', to_jsonb(v_r.item_ids),
    'changedItemIds', to_jsonb(v_changed),
    'itemNos', coalesce((select jsonb_object_agg(i.id::text, i.item_no) from public.service_items i
                         where i.id = any (v_r.item_ids || v_changed)), '{}'::jsonb),
    'outsideItemNos', coalesce((select jsonb_agg(i.item_no order by i.item_no) from public.service_items i
                                where i.id = any (v_changed) and not (i.id = any (v_r.item_ids))), '[]'::jsonb),
    'changedFields', to_jsonb(case when v_ver.status = 'draft' then authz.revision_changed_fields(v_ver.id) else '{}'::text[] end),
    'issues', to_jsonb(v_issues),
    'canSubmit', v_actor and v_r.status = 'approved' and v_ver.status = 'draft' and cardinality(v_changed) > 0
                 and cardinality(v_issues) = 0
                 and not exists (select 1 from public.service_items i where i.id = any (v_changed) and not (i.id = any (v_r.item_ids))));
end;
$$;

revoke all on function authz.cr_viewer(uuid), authz.cr_safe_facts(uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.deal_change_requests(uuid), public.change_requests_list(jsonb, text, integer),
  public.task_reconfirmation_get(uuid), public.deal_change_history(uuid), public.booking_change_preview(uuid)
from public, anon, authenticated, service_role;
grant execute on function public.deal_change_requests(uuid), public.change_requests_list(jsonb, text, integer),
  public.task_reconfirmation_get(uuid), public.deal_change_history(uuid), public.booking_change_preview(uuid)
to authenticated;

commit;
