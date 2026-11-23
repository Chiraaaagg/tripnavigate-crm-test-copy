-- TripNavigate CRM - Accounts phase 3, track H (9): the Manager approves the
-- final change version (owner decision, Addendum O2).
-- Contract: sections 10.2-10.5, 11, 13, 14, 17.1, LD24, LD28, LD30, Addendum
-- O1, Addendum O2.
--
-- New order for every kind (change, add_service, remove_service):
--   create (status 'draft') -> open the change version -> the Sales owner fills
--   it, including selling total and payment plan -> booking_change_submit
--   (status 'requested', submitted_content_hash) -> the Manager (Approver, never
--   the requester) approves exactly that version (approved_content_hash; a
--   booked removal only once the supplier charges are entered, LD30) or
--   returns it (the same version is edited and sent again) -> reconfirmations
--   are written at approval for a change -> apply refuses version_changed when
--   the version differs from the approved hash. No Accounts step (LD24, O1).
--   'requested' keeps meaning "waiting for the Manager" (Track N's notices 50,
--   51 and 57 follow it unchanged); 'approved' now means "waiting for the
--   suppliers' reconfirmations"; 'submitted' is no longer written.
-- Schema: booking_change_requests status gains 'draft' (the new default);
--   submitted_content_hash, approved_content_hash; the one-live index and the
--   status index include 'draft'.
-- New: authz.cr_lock_h (17.1 lock order for decide and apply);
--   R-H2 public.change_request_review(p_change_request_id) and
--   authz.cr_version_view.
-- Replaced (latest bodies, same signatures; changed lines marked
-- "Accounts phase 3 (20261205000780)"): the request guard, the change-version guard,
-- deal_change_open, cr_apply_if_ready, resubmit (edits the draft or returned
-- request; status unchanged), open_version, submit, decide, apply, withdraw,
-- the three reconfirmation commands, purchase_evidence_begin and
-- task_reconfirmation_get (reconfirmation while 'approved'), the reads
-- (change_requests_list, booking_change_preview, deal_change_requests) and
-- track H's functions with live-status lists.
-- Refusal tokens: version_changed (40001) at decide and apply; wrong_state.
-- Rollback (forward-only): a NEW migration restoring the cited bodies; the
-- statuses already used stay valid.

begin;
set local lock_timeout = '15s';

alter table public.booking_change_requests
  add column submitted_content_hash text check (submitted_content_hash is null or submitted_content_hash ~ '^[0-9a-f]{64}$'),
  add column approved_content_hash text check (approved_content_hash is null or approved_content_hash ~ '^[0-9a-f]{64}$'),
  alter column status set default 'draft';
do $$
declare
  c record;
begin
  for c in
    select con.conname from pg_constraint con
    where con.conrelid = 'public.booking_change_requests'::regclass and con.contype = 'c'
      and pg_get_constraintdef(con.oid) like '%''not_possible''%' and pg_get_constraintdef(con.oid) like '%''withdrawn''%'
      and pg_get_constraintdef(con.oid) not like '%closed_at%'
  loop
    execute format('alter table public.booking_change_requests drop constraint %I', c.conname);
  end loop;
end;
$$;
alter table public.booking_change_requests
  add constraint booking_change_requests_status_check
    check (status in ('draft', 'requested', 'returned', 'approved', 'submitted', 'applied', 'not_possible', 'withdrawn'));
drop index public.booking_change_requests_one_live;
create unique index booking_change_requests_one_live on public.booking_change_requests (deal_id)
  where status in ('draft', 'requested', 'returned', 'approved', 'submitted');
drop index public.booking_change_requests_status_idx;
create index booking_change_requests_status_idx on public.booking_change_requests (status, requested_at desc, id desc)
  where status in ('draft', 'requested', 'returned', 'approved', 'submitted');

-- Replaces 20261205000610_change_request_schema.sql:165 (latest body; changed lines marked).
create or replace function authz.booking_change_requests_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'change requests cannot be deleted' using errcode = '42501';
  end if;
  if new.id <> old.id or new.legal_entity_id <> old.legal_entity_id or new.branch_id <> old.branch_id
     or new.deal_id <> old.deal_id or new.ref_no <> old.ref_no or new.kind <> old.kind
     or new.base_version_id <> old.base_version_id or new.requested_by <> old.requested_by
     or new.requested_at <> old.requested_at or new.request_id <> old.request_id or new.requested_as <> old.requested_as then
    raise exception 'change request identity is immutable' using errcode = '42501';
  end if;
  if old.status in ('applied', 'not_possible', 'withdrawn') then
    raise exception 'a finished change request is final' using errcode = '42501';
  end if;
  -- Accounts phase 3 (20261205000780) (Addendum O2): the request facts change while it is
  -- drafted or returned (before it is sent to the Manager again).
  if (new.change_summary, new.reason, new.removal_route, new.customer_charge_paise)
     is distinct from (old.change_summary, old.reason, old.removal_route, old.customer_charge_paise)
     and not (old.status in ('draft', 'returned') and new.status in (old.status, 'requested')) then
    raise exception 'change request facts change only when it is sent again' using errcode = '42501';
  end if;
  -- Items: on resubmit, or (track H) items added to an approved add_service request.
  if new.item_ids is distinct from old.item_ids
     and not (old.status in ('draft', 'returned') and new.status in (old.status, 'requested')) then  -- Accounts phase 3 (20261205000780)
    raise exception 'change request items change only when it is sent again' using errcode = '42501';
  end if;
  -- Accounts phase 3 (20261205000780) (Addendum O2): draft -> requested (sent with the filled
  -- change version) -> approved (that exact version) | returned -> requested;
  -- approved -> applied | not_possible. 'submitted' is kept for older rows only.
  if new.status is distinct from old.status and not (
       (old.status = 'draft' and new.status in ('requested', 'withdrawn'))
    or (old.status = 'requested' and new.status in ('approved', 'returned', 'withdrawn'))
    or (old.status = 'returned' and new.status in ('requested', 'withdrawn'))
    or (old.status = 'approved' and new.status in ('applied', 'not_possible', 'withdrawn'))
    or (old.status = 'submitted' and new.status in ('applied', 'not_possible', 'withdrawn'))) then
    raise exception 'change request status cannot move this way' using errcode = '42501';
  end if;
  if old.change_version_id is not null and new.change_version_id is distinct from old.change_version_id then
    raise exception 'the change version of a request is fixed once opened' using errcode = '42501';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
-- Replaces 20261205000630_change_apply.sql:115 (latest body; changed lines marked).
create or replace function authz.booking_versions_change_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.change_request_id is not null and old.status = 'draft'
     and coalesce(current_setting('tripnavigate.change_apply', true), '') <> old.id::text
     and exists (select 1 from public.booking_change_requests r
                 where r.id = old.change_request_id and r.status not in ('draft', 'returned')) then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  return new;
end;
$$;
-- Replaces 20261205000620_change_request_commands.sql:221 (latest body; changed lines marked).
create or replace function authz.deal_change_open(p_deal uuid) returns boolean
language plpgsql stable security definer set search_path = '' as $$
begin
  -- Accounts phase 3 (20261205000620): a live change request on the Deal.
  return exists (select 1 from public.booking_change_requests r
                 where r.deal_id = p_deal and r.status in ('draft', 'requested', 'returned', 'approved', 'submitted'));
end;
$$;
-- Replaces 20261205000640_change_reconfirmation.sql:380 (latest body; changed lines marked).
create or replace function authz.cr_apply_if_ready(p_change_request uuid) returns boolean
language plpgsql volatile security definer set search_path = '' as $$
begin
  if exists (select 1 from public.booking_change_requests r where r.id = p_change_request and r.status = 'approved')
     and not exists (select 1 from public.task_reconfirmations x
                     where x.change_request_id = p_change_request
                       and (x.status = 'pending' or (x.status = 'recorded' and x.over_budget and x.over_budget_approved_by is null))) then
    perform authz.booking_change_apply(p_change_request);
    return true;
  end if;
  return false;
end;
$$;
-- 17.1 for decide and apply: finance head, Deal, base, change version, the
-- removed service's tasks by id (a removal), then authz.cr_lock_apply
-- (reconfirmation tasks, reconfirmations, the request).
create function authz.cr_lock_h(p_change_request uuid) returns public.booking_change_requests
language plpgsql volatile security definer set search_path = '' as $$
declare
  v public.booking_change_requests%rowtype;
begin
  select * into v from public.booking_change_requests q where q.id = p_change_request;
  if v.id is null then
    return null;
  end if;
  perform authz.finance_lock_deal(v.deal_id);
  perform 1 from public.deals d where d.id = v.deal_id for no key update;
  perform 1 from public.booking_versions b where b.id = v.base_version_id for update;
  if v.change_version_id is not null then
    perform 1 from public.booking_versions b where b.id = v.change_version_id for update;
  end if;
  if v.kind = 'remove_service' then
    perform 1 from public.fulfilment_tasks t
    where t.deal_id = v.deal_id and t.service_item_id = any (v.item_ids) order by t.id for update;
  end if;
  return authz.cr_lock_apply(p_change_request);
end;
$$;
-- Replaces 20261205000710_service_change_requests.sql:310 (latest body; changed lines marked).
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
  if v_row.status not in ('draft', 'returned') then  -- Accounts phase 3 (20261205000780): edit while drafted or returned
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
  -- Accounts phase 3 (20261205000780): the change version of a removal already left its service out.
  if v_row.kind = 'remove_service' and v_row.change_version_id is not null and v_items is distinct from v_row.item_ids then
    perform authz.cr_invalid('itemIds');
  end if;
  v_summary := authz.cr_text(p_fields, 'changeSummary', 10, 500, false);
  v_reason := authz.cr_text(p_fields, 'reason', 10, 500, false);

  update public.booking_change_requests r
  set status = r.status, item_ids = v_items,  -- Accounts phase 3 (20261205000780): status unchanged; booking_change_submit sends it change_summary = v_summary, reason = v_reason,
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
-- Replaces 20261205000710_service_change_requests.sql:400 (latest body; changed lines marked).
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
  if v_row.status not in ('draft', 'returned') then  -- Accounts phase 3 (20261205000780) (O2): the version is filled before the approval
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
-- Replaces 20261205000720_service_change_apply.sql:375 (latest body; changed lines marked).
create or replace function public.booking_change_submit(p_change_request_id uuid, p_expected_content_hash text,
  p_expected_changed_item_ids uuid[], p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.booking_change_requests%rowtype;
  v_payload jsonb := jsonb_build_object('changeRequestId', p_change_request_id, 'contentHash', p_expected_content_hash,
    'changedItemIds', to_jsonb(p_expected_changed_item_ids));
  v_result jsonb;
  v_ver public.booking_versions%rowtype;
  v_fields text[];
  v_changed uuid[];
  v_outside text;
  v_expected uuid[];
  v_class text;
  v_issues text[];
  v_n integer := 0;
  v_applied boolean := false;
  v_added uuid[];  -- Accounts phase 3 (20261205000720)
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
  v_row := authz.cr_lock_apply(p_change_request_id);
  v_result := authz.finance_replay(v_row.legal_entity_id, p_request_id, 'booking_change_submit', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_row.status not in ('draft', 'returned') or v_row.change_version_id is null then  -- Accounts phase 3 (20261205000780) (O2)
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if v_row.kind = 'change' and not authz.booking_changes_enabled() then
    raise exception 'changes_off' using errcode = '55000';
  end if;
  -- Accounts phase 3 (20261205000720): adding or removing a service needs its own switch.
  if v_row.kind <> 'change' and not authz.service_changes_enabled() then
    raise exception 'service_changes_off' using errcode = '55000';
  end if;
  if not exists (select 1 from public.booking_versions b where b.id = v_row.base_version_id and b.status = 'confirmed') then
    raise exception 'version_superseded' using errcode = '55000';
  end if;
  select * into v_ver from public.booking_versions v where v.id = v_row.change_version_id;
  if v_ver.status <> 'draft' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  if p_expected_content_hash is null or p_expected_content_hash <> authz.booking_content_hash(v_ver.id) then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_fields := authz.revision_changed_fields(v_ver.id);
  if cardinality(v_fields) = 0 then
    raise exception 'not_ready' using errcode = '55000', hint = 'no_changes';
  end if;
  -- LD28: every service whose facts changed is named in the approved request.
  v_changed := authz.cr_changed_item_ids(v_ver.id);
  -- Accounts phase 3 (20261205000720): add - the request names exactly the services added
  -- in the change version (no existing service may change, 11.2); remove - the
  -- service is gone from the version, and a simple removal must still be simple.
  if v_row.kind = 'add_service' then
    select coalesce(array_agg(f.service_item_id order by f.service_item_id), '{}'::uuid[]) into v_added
    from public.service_item_facts f
    where f.booking_version_id = v_ver.id
      and not exists (select 1 from public.service_item_facts b
                      where b.booking_version_id = v_row.base_version_id and b.service_item_id = f.service_item_id);
    if cardinality(v_added) = 0 then
      raise exception 'not_ready' using errcode = '55000', hint = 'no_service_added';
    end if;
    if v_added is distinct from v_row.item_ids then
      update public.booking_change_requests r set item_ids = v_added where r.id = v_row.id
      returning * into v_row;
    end if;
  elsif v_row.kind = 'remove_service' then
    if exists (select 1 from public.service_item_facts f
               where f.booking_version_id = v_ver.id and f.service_item_id = any (v_row.item_ids)) then
      raise exception 'not_ready' using errcode = '55000', hint = 'service_not_removed';
    end if;
    if v_row.removal_route = 'simple' and authz.cr_removal_route(v_row.item_ids[1]) = 'cancellation' then
      raise exception 'not_ready' using errcode = '55000', hint = 'service_booked';
    end if;
  end if;
  select string_agg(i.item_no::text, ',' order by i.item_no) into v_outside
  from public.service_items i
  where i.id = any (v_changed) and not (i.id = any (v_row.item_ids));
  if v_outside is not null then
    raise exception 'change_outside_request' using errcode = '22023', hint = v_outside;
  end if;
  -- The set the screen showed.
  select coalesce(array_agg(distinct x order by x), '{}'::uuid[]) into v_expected
  from unnest(coalesce(p_expected_changed_item_ids, '{}'::uuid[])) x;
  if v_expected is distinct from v_changed then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  -- The weakest allowed class, for the history view.
  v_class := (authz.revision_allowed_classes(v_fields))[1];
  update public.booking_versions v set change_class = v_class, changed_fields = v_fields, updated_at = now(),
    updated_by = v_uid
  where v.id = v_ver.id
  returning * into v_ver;
  v_issues := authz.booking_issues(v_ver.id);
  if cardinality(v_issues) > 0 then
    raise exception 'not_ready' using errcode = '55000', hint = v_issues[1];
  end if;

  -- Accounts phase 3 (20261205000780) (O2): reconfirmations are written when the Manager
  -- approves this exact version (booking_change_request_decide).
  v_n := 0;

  update public.booking_change_requests r
  set status = 'requested', submitted_by = v_uid, submitted_at = now(), changed_fields = v_fields, change_class = v_class,
      -- Accounts phase 3 (20261205000780) (O2): sent to the Manager with the version's content hash.
      submitted_content_hash = authz.booking_content_hash(v_ver.id),
      decided_by = null, decided_at = null, decision_request_id = null,
      row_version = r.row_version + 1
  where r.id = v_row.id
  returning * into v_row;
  perform authz.write_audit('booking.change_submitted', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request', v_row.id,
    null, jsonb_build_object('changeRequestId', v_row.id, 'dealId', v_row.deal_id, 'versionId', v_ver.id,
      'reconfirmations', v_n, 'changedItemCount', cardinality(v_changed)));
  if v_n = 0 then
    v_applied := authz.cr_apply_if_ready(v_row.id);
  end if;
  select * into v_row from public.booking_change_requests r where r.id = v_row.id;
  v_result := authz.cr_json(v_row) || jsonb_build_object('outcome', 'updated', 'reconfirmations', v_n, 'applied', v_applied);
  return authz.finance_remember(v_row.legal_entity_id, p_request_id, 'booking_change_submit', v_payload, v_result);
end;
$$;
-- Replaces 20261205000620_change_request_commands.sql:658 (latest body; changed lines marked).
create or replace function public.booking_change_request_decide(p_id uuid, p_decision text, p_reason text, p_expected_row_version integer,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.booking_change_requests%rowtype;
  v_payload jsonb := jsonb_build_object('id', p_id, 'decision', p_decision, 'reason', p_reason,
    'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
  v_reason text;
  v_block text;
  v_n integer := 0;  -- Accounts phase 3 (20261205000780)
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_row from public.booking_change_requests r where r.id = p_id;
  if v_row.id is null or not authz.cr_is_approver(v_row.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_row.requested_by = v_uid then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if p_request_id is null then
    perform authz.cr_invalid('requestId');
  end if;
  if p_decision is null or p_decision not in ('approve', 'return') then
    perform authz.cr_invalid('decision');
  end if;
  v_row := authz.cr_lock_h(p_id);  -- Accounts phase 3 (20261205000780): 17.1 (decide may apply)
  v_result := authz.finance_replay(v_row.legal_entity_id, p_request_id, 'booking_change_request_decide', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_row.status <> 'requested' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_row.row_version);
  if v_row.kind = 'change' and not authz.booking_changes_enabled() then
    raise exception 'changes_off' using errcode = '55000';
  end if;
  if p_decision = 'return' or nullif(btrim(coalesce(p_reason, '')), '') is not null then
    v_reason := authz.cr_reason(p_reason, 'reason');
  end if;

  if p_decision = 'approve' then
    -- The base must still be the accepted version.
    if not exists (select 1 from public.booking_versions v where v.id = v_row.base_version_id and v.status = 'confirmed') then
      raise exception 'version_superseded' using errcode = '55000';
    end if;
    -- Accounts phase 3 (20261205000780) (O2): the Manager approves exactly the version sent.
    if not exists (select 1 from public.booking_versions v where v.id = v_row.change_version_id and v.status = 'draft')
       or v_row.submitted_content_hash is distinct from authz.booking_content_hash(v_row.change_version_id) then
      raise exception 'version_changed' using errcode = '40001';
    end if;
    v_block := authz.booking_change_approve_block(v_row.id);  -- track H hook (11.3)
    if v_block is not null then
      raise exception '%', v_block using errcode = case when v_block = 'not_self_approval' then '42501' else '55000' end;
    end if;
    update public.booking_change_requests r
    set status = 'approved', decided_by = v_uid, decided_at = now(), decision_request_id = p_request_id,
        approved_content_hash = r.submitted_content_hash,  -- Accounts phase 3 (20261205000780)
        row_version = r.row_version + 1
    where r.id = v_row.id
    returning * into v_row;
    perform authz.write_audit('booking.change_approved', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request', v_row.id,
      v_reason, jsonb_build_object('changeRequestId', v_row.id, 'dealId', v_row.deal_id, 'kind', v_row.kind,
        'rowVersion', v_row.row_version));
    -- Accounts phase 3 (20261205000780) (O2, moved from submit): one pending reconfirmation per
    -- changed Purchase service whose supplier confirmed (a change only; LD27);
    -- with none the change applies at once.
    insert into public.task_reconfirmations (legal_entity_id, change_request_id, task_id, booking_version_id, budget_paise)
    select t.legal_entity_id, v_row.id, t.id, v_row.change_version_id, f.purchase_budget_paise
    from public.fulfilment_tasks t
    left join public.service_item_facts f on f.service_item_id = t.service_item_id and f.booking_version_id = v_row.change_version_id
    where v_row.kind = 'change' and t.deal_id = v_row.deal_id
      and t.service_item_id = any (authz.cr_changed_item_ids(v_row.change_version_id))
      and t.department = 'purchase' and t.status = 'supplier_confirmed' and t.closed_state is null
    order by t.id;
    get diagnostics v_n = row_count;
    if v_n = 0 then
      perform authz.cr_apply_if_ready(v_row.id);
    end if;
    select * into v_row from public.booking_change_requests r where r.id = v_row.id;
  else
    update public.booking_change_requests r
    set status = 'returned', decided_by = v_uid, decided_at = now(), decision_request_id = p_request_id,
        return_reason = v_reason, row_version = r.row_version + 1
    where r.id = v_row.id
    returning * into v_row;
    perform authz.write_audit('booking.change_returned', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request', v_row.id,
      v_reason, jsonb_build_object('changeRequestId', v_row.id, 'dealId', v_row.deal_id, 'kind', v_row.kind,
        'rowVersion', v_row.row_version));
  end if;
  v_result := authz.cr_json(v_row) || jsonb_build_object('outcome', 'updated',
    'reconfirmations', v_n, 'applied', v_row.status = 'applied');  -- Accounts phase 3 (20261205000780)
  return authz.finance_remember(v_row.legal_entity_id, p_request_id, 'booking_change_request_decide', v_payload, v_result);
end;
$$;
-- Replaces 20261205000720_service_change_apply.sql:519 (latest body; changed lines marked).
create or replace function authz.booking_change_apply(p_change_request uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.booking_change_requests%rowtype;
  v_base public.booking_versions%rowtype;
  v_ver public.booking_versions%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_cost public.purchase_cost_versions;
  r public.task_reconfirmations%rowtype;
  v_next integer;
  v_conf integer;
  v_tasks uuid[] := '{}'::uuid[];
  v_pre public.booking_change_requests%rowtype;  -- Accounts phase 3 (20261205000720)
  v_added uuid[] := '{}'::uuid[];
  v_closed uuid[] := '{}'::uuid[];
  v_t public.fulfilment_tasks%rowtype;
  v_state text;
begin
  -- Accounts phase 3 (20261205000720): lock order 17.1 for a removal - the removed service's
  -- tasks (by id) are locked after the versions and before the request row
  -- (authz.cr_lock_apply then takes the same locks again and the rest).
  select * into v_pre from public.booking_change_requests q where q.id = p_change_request;
  if v_pre.kind = 'remove_service' then
    perform authz.finance_lock_deal(v_pre.deal_id);
    perform 1 from public.deals d where d.id = v_pre.deal_id for no key update;
    perform 1 from public.booking_versions b where b.id = v_pre.base_version_id for update;
    perform 1 from public.booking_versions b where b.id = v_pre.change_version_id for update;
    perform 1 from public.fulfilment_tasks t
    where t.deal_id = v_pre.deal_id and t.service_item_id = any (v_pre.item_ids) order by t.id for update;
  end if;
  v_row := authz.cr_lock_apply(p_change_request);
  if v_row.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_row.status <> 'approved' or v_row.change_version_id is null then  -- Accounts phase 3 (20261205000780) (O2)
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  -- The version must be exactly the one the Manager approved.
  if v_row.approved_content_hash is distinct from authz.booking_content_hash(v_row.change_version_id) then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if exists (select 1 from public.task_reconfirmations x
             where x.change_request_id = v_row.id
               and (x.status = 'pending' or (x.status = 'recorded' and x.over_budget and x.over_budget_approved_by is null))) then
    raise exception 'not_ready' using errcode = '55000', hint = 'reconfirmation_open';
  end if;
  select * into v_base from public.booking_versions b where b.id = v_row.base_version_id;
  select * into v_ver from public.booking_versions b where b.id = v_row.change_version_id;
  if v_base.status <> 'confirmed' then
    raise exception 'version_superseded' using errcode = '55000';
  end if;
  if v_ver.status <> 'draft' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;

  -- 5 (first, so the automatic bill checks below see no live change).
  update public.booking_change_requests q set status = 'applied', applied_at = now(), row_version = q.row_version + 1
  where q.id = v_row.id
  returning * into v_row;

  -- 1. Freeze the change version and supersede the base.
  perform set_config('tripnavigate.change_apply', v_ver.id::text, true);
  v_ver := authz.booking_version_freeze(v_ver.id, v_base.id);
  perform set_config('tripnavigate.change_apply', '', true);

  -- 2. The Manager's approval stands in for the Accounts review (LD24).
  insert into public.accounts_booking_reviews (booking_version_id, deal_id, legal_entity_id, status, approval_source,
    change_request_id)
  values (v_ver.id, v_ver.deal_id, v_ver.legal_entity_id, 'approved', 'change_request', v_row.id);

  -- 3. Recorded reconfirmations become the task's new committed cost and confirmation.
  for r in
    select * from public.task_reconfirmations x
    where x.change_request_id = v_row.id and x.status = 'recorded' order by x.task_id
  loop
    select * into v_task from public.fulfilment_tasks t where t.id = r.task_id;
    v_cost := authz.purchase_latest_cost(v_task.id);
    select coalesce(max(c.version_no), 0) into v_next from public.purchase_cost_versions c where c.task_id = v_task.id;
    select coalesce(max(c.confirmation_no), 0) + 1 into v_conf from public.task_confirmations c where c.task_id = v_task.id;
    insert into public.purchase_cost_versions (task_id, legal_entity_id, version_no, quote_id, request_id, stage,
      amount_paise, due_date, note, created_by, confirmation_no, change_fee_paise)
    values (v_task.id, v_task.legal_entity_id, v_next + 1, v_task.selected_quote_id, gen_random_uuid(), 'proposed',
      r.new_rate_paise + r.supplier_fee_paise, v_cost.due_date, null, r.recorded_by, v_conf, r.supplier_fee_paise);
    insert into public.purchase_cost_versions (task_id, legal_entity_id, version_no, quote_id, request_id, stage,
      amount_paise, due_date, note, created_by, confirmation_no, change_fee_paise)
    values (v_task.id, v_task.legal_entity_id, v_next + 2, v_task.selected_quote_id, gen_random_uuid(), 'committed',
      r.new_rate_paise + r.supplier_fee_paise, v_cost.due_date, null, coalesce(v_uid, r.recorded_by), v_conf, r.supplier_fee_paise);
    if r.over_budget then
      -- The agreed (proposed) cost carries the approval, bound to the new version.
      insert into public.purchase_cost_approvals (task_id, legal_entity_id, version_no, approved_by, approved_at,
        booking_version_id, reconfirmation_id)
      values (v_task.id, v_task.legal_entity_id, v_next + 1, r.over_budget_approved_by, r.over_budget_approved_at,
        v_ver.id, r.id);
    end if;
    perform set_config('authz.task_transition', 'reconfirm', true);
    update public.fulfilment_tasks t
    set supplier_reference = r.new_reference, supplier_confirmed_by = r.recorded_by, supplier_confirmed_at = r.recorded_at,
        updated_at = now()
    where t.id = v_task.id;
    perform set_config('authz.task_transition', '', true);
    insert into public.task_confirmations (legal_entity_id, task_id, confirmation_no, quote_id, committed_version_no, amount_paise,
      change_fee_paise, supplier_reference, evidence_ids, booking_version_id, change_request_id, confirmed_by, confirmed_at)
    values (v_task.legal_entity_id, v_task.id, v_conf, v_task.selected_quote_id, v_next + 2, r.new_rate_paise + r.supplier_fee_paise,
      r.supplier_fee_paise, r.new_reference, array[r.evidence_id], v_ver.id, v_row.id, r.recorded_by, r.recorded_at);
    -- The Purchase person reconfirmed against the change version: that is their new basis.
    insert into public.purchase_task_basis (task_id, legal_entity_id, deal_id, basis_version_id, seen_by, seen_at)
    values (v_task.id, v_task.legal_entity_id, v_task.deal_id, v_ver.id, r.recorded_by, now())
    on conflict (task_id) do update
      set basis_version_id = excluded.basis_version_id, seen_by = excluded.seen_by, seen_at = excluded.seen_at,
          row_version = public.purchase_task_basis.row_version + 1, updated_at = now();
    update public.task_reconfirmations x set status = 'applied', row_version = x.row_version + 1 where x.id = r.id;
  end loop;

  -- Accounts phase 3 (20261205000720): add a service - one task per new service for its
  -- department (the task-creation loop of booking_confirm, 11.2).
  if v_row.kind = 'add_service' then
    v_added := authz.booking_create_item_tasks(v_ver.id, v_row.item_ids);
  end if;
  -- Accounts phase 3 (20261205000720): remove a service - its open task(s) close (withdrawn for
  -- a simple removal, cancelled for a booked one; status unchanged, LD31) and
  -- the service is cancelled. Supplier refunds expected follow from the charge
  -- rows of this request (authz.supplier_refund_sources); no deal_cancellations
  -- row is written (LD30).
  if v_row.kind = 'remove_service' then
    v_state := case when v_row.removal_route = 'cancellation' then 'cancelled' else 'withdrawn' end;
    for v_t in
      select t.* from public.fulfilment_tasks t
      where t.deal_id = v_row.deal_id and t.service_item_id = any (v_row.item_ids) and t.closed_state is null
      order by t.id
    loop
      perform set_config('authz.task_transition', 'close', true);
      update public.fulfilment_tasks t
      set closed_state = v_state, closed_at = now(), closed_by = coalesce(v_uid, v_row.decided_by),
          closed_change_request_id = v_row.id, updated_at = now()
      where t.id = v_t.id;
      perform set_config('authz.task_transition', '', true);
      perform authz.write_audit('fulfilment.task_closed', v_t.legal_entity_id, v_t.branch_id, 'fulfilment_task', v_t.id, null,
        jsonb_build_object('taskId', v_t.id, 'dealId', v_t.deal_id, 'changeRequestId', v_row.id, 'closedState', v_state,
          'department', v_t.department, 'serviceItemId', v_t.service_item_id));
      v_closed := v_closed || v_t.id;
    end loop;
    perform set_config('tripnavigate.service_item_cancel', v_row.item_ids[1]::text, true);
    update public.service_items i set state = 'cancelled', updated_at = now()
    where i.id = v_row.item_ids[1] and i.state <> 'cancelled';
    perform set_config('tripnavigate.service_item_cancel', '', true);
  end if;

  -- Every task of the new version's services (the history and notices name them).
  select coalesce(array_agg(t.id order by i.item_no, t.created_at), '{}'::uuid[]) into v_tasks
  from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
  where t.service_item_id in (select f.service_item_id from public.service_item_facts f where f.booking_version_id = v_ver.id);

  -- 4. Supplier money: a supplier refund expected is computed from verified
  -- payments and the new committed cost (authz.supplier_refund_sources).

  -- 5. Outbox and audit.
  insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
  values (v_ver.legal_entity_id, 'booking_version', v_ver.id, 'booking.version_revised',
    jsonb_build_object('version_id', v_ver.id, 'deal_id', v_ver.deal_id, 'version_no', v_ver.version_no,
      'base_version_id', v_base.id))
  on conflict (event_type, aggregate_id) do nothing;
  perform authz.write_audit('booking.version_superseded', v_base.legal_entity_id, v_base.branch_id, 'booking_version',
    v_base.id, null, jsonb_build_object('dealId', v_base.deal_id, 'versionNo', v_base.version_no,
      'supersededByVersionId', v_ver.id, 'changeRequestId', v_row.id));
  perform authz.write_audit('booking.change_applied', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request', v_row.id,
    null, jsonb_build_object('changeRequestId', v_row.id, 'versionId', v_ver.id, 'baseVersionId', v_base.id,
      'taskIds', to_jsonb(v_tasks),
      -- Accounts phase 3 (20261205000720): ids only.
      'kind', v_row.kind, 'addedTaskIds', to_jsonb(v_added), 'closedTaskIds', to_jsonb(v_closed)));

  -- 6. Bills and the customer message (never fail this transaction).
  perform authz.cdoc_auto_run(v_row.deal_id, 'inv_replace_on_change');
  perform authz.cmsg_enqueue(v_row.deal_id, 'booking_changed', 'cr:' || v_row.id::text, '{}'::jsonb, null);

  return jsonb_build_object('changeRequestId', v_row.id, 'status', v_row.status, 'versionId', v_ver.id,
    'baseVersionId', v_base.id, 'taskIds', to_jsonb(v_tasks),
    'addedTaskIds', to_jsonb(v_added), 'closedTaskIds', to_jsonb(v_closed));  -- Accounts phase 3 (20261205000720)
end;
$$;
-- Replaces 20261205000620_change_request_commands.sql:608 (latest body; changed lines marked).
create or replace function public.booking_change_request_withdraw(p_id uuid, p_expected_row_version integer, p_reason text, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.booking_change_requests%rowtype;
  v_payload jsonb := jsonb_build_object('id', p_id, 'expectedRowVersion', p_expected_row_version, 'reason', p_reason);
  v_result jsonb;
  v_reason text;
  v_voided integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_row from public.booking_change_requests r where r.id = p_id;
  if v_row.id is null
     or not ((v_row.requested_by = v_uid and authz.cr_requester_role(v_row.deal_id) is not null)
             or authz.refund_is_m(v_row.deal_id)) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    perform authz.cr_invalid('requestId');
  end if;
  v_row := authz.cr_lock(p_id);
  v_result := authz.finance_replay(v_row.legal_entity_id, p_request_id, 'booking_change_request_withdraw', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_row.status not in ('draft', 'requested', 'returned', 'approved', 'submitted') then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_row.row_version);
  v_reason := authz.cr_reason(p_reason, 'reason');
  -- Lock order: change version, then reconfirmations (inside cr_close).
  perform 1 from public.task_reconfirmations x where x.change_request_id = v_row.id order by x.task_id for update;
  select count(*)::integer into v_voided from public.task_reconfirmations x
  where x.change_request_id = v_row.id and x.status = 'recorded';
  v_row := authz.cr_close(v_row, 'withdrawn', v_reason);
  perform authz.write_audit('booking.change_withdrawn', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request', v_row.id,
    v_reason, jsonb_build_object('changeRequestId', v_row.id, 'dealId', v_row.deal_id, 'kind', v_row.kind,
      'voidedReconfirmations', v_voided, 'changeVersionId', v_row.change_version_id));
  v_result := authz.cr_json(v_row) || jsonb_build_object('outcome', 'updated');
  return authz.finance_remember(v_row.legal_entity_id, p_request_id, 'booking_change_request_withdraw', v_payload, v_result);
end;
$$;
-- Replaces 20261205000720_service_change_apply.sql:291 (latest body; changed lines marked).
create or replace function authz.service_items_revision_guard() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
begin
  select * into v_ver from public.booking_versions v
  where v.deal_id = new.deal_id and v.status = 'draft' and v.revises_version_id is not null
  limit 1;
  if v_ver.id is not null then
    -- Accounts phase 3 (20261205000720): the change version of an approved add_service request
    -- takes new services; each is recorded in the request's item_ids (11.2).
    if v_ver.change_request_id is not null and exists (
         select 1 from public.booking_change_requests r
         where r.id = v_ver.change_request_id and r.kind = 'add_service' and r.status in ('draft', 'returned')) then
      update public.booking_change_requests r set item_ids = r.item_ids || new.id
      where r.id = v_ver.change_request_id and not (new.id = any (r.item_ids));
      return new;
    end if;
    raise exception 'revision_items_fixed' using errcode = '55000';
  end if;
  return new;
end;
$$;
-- Replaces 20261205000720_service_change_apply.sql:316 (latest body; changed lines marked).
create or replace function public.service_item_remove(p_item_id uuid, p_version_id uuid, p_expected_row_version integer)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_item public.service_items%rowtype;
  v_cr public.booking_change_requests%rowtype;  -- Accounts phase 3 (20261205000720)
begin
  v_ver := authz.lock_package_draft(p_version_id);
  perform authz.require_row_version(p_expected_row_version, v_ver.row_version);
  -- Accounts phase 3 (20261205000720): in the change version of a remove_service request the
  -- named service leaves this version only (it stays in the accepted versions;
  -- the apply closes its task). booking_change_open_version already left it out.
  if v_ver.change_request_id is not null then
    select * into v_cr from public.booking_change_requests r where r.id = v_ver.change_request_id;
    if v_cr.kind = 'remove_service' and p_item_id = any (v_cr.item_ids) and v_cr.status in ('draft', 'returned') then
      select i.* into v_item from public.service_items i where i.id = p_item_id and i.deal_id = v_ver.deal_id;
      if exists (select 1 from public.service_item_facts f where f.service_item_id = p_item_id and f.booking_version_id = v_ver.id) then
        delete from public.service_item_facts f where f.service_item_id = p_item_id and f.booking_version_id = v_ver.id;
        v_ver := authz.bump_package_version(v_ver.id);
        perform authz.write_audit('booking.service_item_removed', v_ver.legal_entity_id, v_ver.branch_id,
          'service_item', v_item.id, null,
          jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no,
            'itemNo', v_item.item_no, 'serviceType', v_item.service_type, 'rowVersion', v_ver.row_version,
            'changeRequestId', v_cr.id));
      end if;
      return jsonb_build_object('removed', true, 'rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
    end if;
  end if;
  select i.* into v_item from public.service_items i where i.id = p_item_id and i.deal_id = v_ver.deal_id for update;
  if v_item.id is null then
    raise exception 'not_found' using errcode = 'P0002';
  end if;
  if v_item.state <> 'planned' or exists (
       select 1 from public.service_item_facts f join public.booking_versions v on v.id = f.booking_version_id
       where f.service_item_id = v_item.id and v.status = 'confirmed') then
    raise exception 'item_locked' using errcode = '55000';
  end if;

  delete from public.service_item_facts f where f.service_item_id = v_item.id;
  perform set_config('tripnavigate.service_item_remove', v_item.id::text, true);
  delete from public.service_items i where i.id = v_item.id;
  perform set_config('tripnavigate.service_item_remove', '', true);
  -- Accounts phase 3 (20261205000720): a service added in an add_service change version and taken out again.
  if v_cr.kind = 'add_service' then
    update public.booking_change_requests r set item_ids = array_remove(r.item_ids, v_item.id)
    where r.id = v_cr.id and v_item.id = any (r.item_ids);
  end if;
  v_ver := authz.bump_package_version(v_ver.id);

  perform authz.write_audit('booking.service_item_removed', v_ver.legal_entity_id, v_ver.branch_id,
    'service_item', v_item.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no,
      'itemNo', v_item.item_no, 'serviceType', v_item.service_type, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('removed', true, 'rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;
-- Replaces 20261205000640_change_reconfirmation.sql:519 (latest body; changed lines marked).
create or replace function public.task_reconfirm_record(p_reconfirmation_id uuid, p_expected_row_version integer, p_fields jsonb,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_x public.task_reconfirmations%rowtype;
  v_row public.booking_change_requests%rowtype;
  v_task public.fulfilment_tasks%rowtype;
  v_payload jsonb := jsonb_build_object('reconfirmationId', p_reconfirmation_id, 'expectedRowVersion', p_expected_row_version,
    'fields', p_fields);
  v_result jsonb;
  v_key text;
  v_rate bigint;
  v_fee bigint;
  v_ref text;
  v_note text;
  v_evidence uuid;
  v_budget bigint;
  v_over boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_x from public.task_reconfirmations x where x.id = p_reconfirmation_id;
  if v_x.id is null or not authz.can_work_purchase_task(v_x.task_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    perform authz.cr_invalid('requestId');
  end if;
  v_row := authz.cr_lock_apply(v_x.change_request_id);
  select * into v_x from public.task_reconfirmations x where x.id = p_reconfirmation_id;
  v_result := authz.finance_replay(v_x.legal_entity_id, p_request_id, 'task_reconfirm_record', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_x.status <> 'pending' or v_row.status <> 'approved' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_x.row_version);
  select * into v_task from public.fulfilment_tasks t where t.id = v_x.task_id;
  -- A live supplier payment request on the task is settled first.
  if exists (select 1 from public.supplier_payment_requests p
             where p.task_id = v_task.id and p.status in ('pending', 'approved', 'paid')) then
    raise exception 'payment_in_progress' using errcode = '55000';
  end if;
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    perform authz.cr_invalid('fields');
  end if;
  for v_key in select k from jsonb_object_keys(p_fields) k order by k loop
    if v_key <> all (array['newRatePaise', 'supplierFeePaise', 'newReference', 'evidenceId', 'note']) then
      perform authz.cr_invalid(v_key);
    end if;
  end loop;
  if jsonb_typeof(p_fields -> 'newRatePaise') not in ('string', 'number')
     or (p_fields ->> 'newRatePaise') !~ '^[1-9][0-9]{0,11}$' then
    perform authz.cr_invalid('newRatePaise');
  end if;
  v_rate := (p_fields ->> 'newRatePaise')::bigint;
  if p_fields -> 'supplierFeePaise' is null or jsonb_typeof(p_fields -> 'supplierFeePaise') = 'null' then
    v_fee := 0;
  elsif jsonb_typeof(p_fields -> 'supplierFeePaise') not in ('string', 'number')
        or (p_fields ->> 'supplierFeePaise') !~ '^(0|[1-9][0-9]{0,11})$' then
    perform authz.cr_invalid('supplierFeePaise');
  else
    v_fee := (p_fields ->> 'supplierFeePaise')::bigint;
  end if;
  v_ref := authz.cr_text(p_fields, 'newReference', 1, 120, false);
  if v_ref ~ '[[:cntrl:]]' then
    perform authz.cr_invalid('newReference');
  end if;
  v_note := authz.cr_text(p_fields, 'note', 1, 500, true);
  if p_fields -> 'evidenceId' is not null and jsonb_typeof(p_fields -> 'evidenceId') = 'string'
     and (p_fields ->> 'evidenceId') ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    v_evidence := (p_fields ->> 'evidenceId')::uuid;
  elsif p_fields -> 'evidenceId' is not null and jsonb_typeof(p_fields -> 'evidenceId') <> 'null' then
    perform authz.cr_invalid('evidenceId');
  end if;
  -- The supplier's proof: a stored supplier confirmation of this task uploaded for this reconfirmation
  -- (purchase_evidence_begin links it, 20261205000670), not used before.
  if v_evidence is null or not exists (
       select 1 from public.purchase_evidence e
       where e.id = v_evidence and e.task_id = v_task.id and e.kind = 'supplier_confirmation' and e.status = 'stored'
         and e.reconfirmation_id = v_x.id and e.created_at >= v_row.decided_at)
     or exists (select 1 from public.task_reconfirmations y where y.evidence_id = v_evidence and y.id <> v_x.id)
     or exists (select 1 from public.task_confirmations c where c.task_id = v_task.id and v_evidence = any (c.evidence_ids)) then
    raise exception 'evidence_missing' using errcode = '55000';
  end if;
  select f.purchase_budget_paise into v_budget from public.service_item_facts f
  where f.service_item_id = v_task.service_item_id and f.booking_version_id = v_x.booking_version_id;
  v_over := v_budget is null or v_rate + v_fee > v_budget;

  update public.task_reconfirmations x
  set status = 'recorded', new_rate_paise = v_rate, supplier_fee_paise = v_fee, new_reference = v_ref, evidence_id = v_evidence,
      note = v_note, budget_paise = v_budget, over_budget = v_over, recorded_by = v_uid, recorded_at = now(),
      request_id = p_request_id, row_version = x.row_version + 1
  where x.id = v_x.id
  returning * into v_x;
  -- Amounts and references stay out of the audit trail.
  perform authz.write_audit('purchase.reconfirm_recorded', v_x.legal_entity_id, v_task.branch_id, 'fulfilment_task', v_task.id,
    null, jsonb_build_object('reconfirmationId', v_x.id, 'taskId', v_task.id, 'changeRequestId', v_x.change_request_id,
      'overBudget', v_over));
  perform authz.cr_apply_if_ready(v_x.change_request_id);
  select * into v_x from public.task_reconfirmations x where x.id = v_x.id;
  v_result := authz.reconf_json(v_x) || jsonb_build_object('outcome', 'updated');
  return authz.finance_remember(v_x.legal_entity_id, p_request_id, 'task_reconfirm_record', v_payload, v_result);
end;
$$;
-- Replaces 20261205000640_change_reconfirmation.sql:633 (latest body; changed lines marked).
create or replace function public.task_reconfirm_approve_over_budget(p_reconfirmation_id uuid, p_expected_row_version integer,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_x public.task_reconfirmations%rowtype;
  v_row public.booking_change_requests%rowtype;
  v_payload jsonb := jsonb_build_object('reconfirmationId', p_reconfirmation_id, 'expectedRowVersion', p_expected_row_version);
  v_result jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_x from public.task_reconfirmations x where x.id = p_reconfirmation_id;
  if v_x.id is null or not authz.cr_is_approver(v_x.change_request_id) or not authz.can_manage_purchase_task(v_x.task_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_x.recorded_by = v_uid then
    raise exception 'not_self_approval' using errcode = '42501';
  end if;
  if p_request_id is null then
    perform authz.cr_invalid('requestId');
  end if;
  v_row := authz.cr_lock_apply(v_x.change_request_id);
  select * into v_x from public.task_reconfirmations x where x.id = p_reconfirmation_id;
  v_result := authz.finance_replay(v_x.legal_entity_id, p_request_id, 'task_reconfirm_approve_over_budget', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_x.status <> 'recorded' or not v_x.over_budget or v_x.over_budget_approved_by is not null or v_row.status <> 'approved' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_x.row_version);
  update public.task_reconfirmations x
  set over_budget_approved_by = v_uid, over_budget_approved_at = now(), row_version = x.row_version + 1
  where x.id = v_x.id
  returning * into v_x;
  perform authz.write_audit('purchase.reconfirm_over_budget_approved', v_x.legal_entity_id, v_row.branch_id, 'fulfilment_task',
    v_x.task_id, null, jsonb_build_object('reconfirmationId', v_x.id, 'taskId', v_x.task_id, 'changeRequestId', v_x.change_request_id));
  perform authz.cr_apply_if_ready(v_x.change_request_id);
  select * into v_x from public.task_reconfirmations x where x.id = v_x.id;
  v_result := authz.reconf_json(v_x) || jsonb_build_object('outcome', 'updated');
  return authz.finance_remember(v_x.legal_entity_id, p_request_id, 'task_reconfirm_approve_over_budget', v_payload, v_result);
end;
$$;
-- Replaces 20261205000640_change_reconfirmation.sql:684 (latest body; changed lines marked).
create or replace function public.task_reconfirm_refuse(p_reconfirmation_id uuid, p_expected_row_version integer, p_reason text,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_x public.task_reconfirmations%rowtype;
  v_row public.booking_change_requests%rowtype;
  v_payload jsonb := jsonb_build_object('reconfirmationId', p_reconfirmation_id, 'expectedRowVersion', p_expected_row_version,
    'reason', p_reason);
  v_result jsonb;
  v_reason text;
  v_voided integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_x from public.task_reconfirmations x where x.id = p_reconfirmation_id;
  if v_x.id is null or not authz.can_work_purchase_task(v_x.task_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    perform authz.cr_invalid('requestId');
  end if;
  v_row := authz.cr_lock_apply(v_x.change_request_id);
  select * into v_x from public.task_reconfirmations x where x.id = p_reconfirmation_id;
  v_result := authz.finance_replay(v_x.legal_entity_id, p_request_id, 'task_reconfirm_refuse', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  if v_x.status not in ('pending', 'recorded') or v_row.status <> 'approved' then
    raise exception 'wrong_state' using errcode = '55000';
  end if;
  perform authz.require_row_version(p_expected_row_version, v_x.row_version);
  v_reason := authz.cr_reason(p_reason, 'reason');
  update public.task_reconfirmations x set status = 'refused', refused_reason = v_reason, row_version = x.row_version + 1
  where x.id = v_x.id
  returning * into v_x;
  select count(*)::integer into v_voided from public.task_reconfirmations y
  where y.change_request_id = v_row.id and y.status = 'recorded';
  -- Other reconfirmations void, the change version discarded, the request not_possible.
  v_row := authz.cr_close(v_row, 'not_possible', v_reason);
  perform authz.write_audit('purchase.reconfirm_refused', v_x.legal_entity_id, v_row.branch_id, 'fulfilment_task', v_x.task_id,
    v_reason, jsonb_build_object('reconfirmationId', v_x.id, 'taskId', v_x.task_id, 'changeRequestId', v_row.id));
  perform authz.write_audit('booking.change_not_possible', v_row.legal_entity_id, v_row.branch_id, 'booking_change_request',
    v_row.id, v_reason, jsonb_build_object('changeRequestId', v_row.id, 'dealId', v_row.deal_id,
      'refusedReconfirmationId', v_x.id, 'voidedReconfirmations', v_voided));
  select * into v_x from public.task_reconfirmations x where x.id = v_x.id;
  v_result := authz.reconf_json(v_x) || jsonb_build_object('outcome', 'updated');
  return authz.finance_remember(v_x.legal_entity_id, p_request_id, 'task_reconfirm_refuse', v_payload, v_result);
end;
$$;
-- Replaces 20261205000670_reconfirmation_proof.sql:57 (latest body; changed lines marked).
create or replace function public.purchase_evidence_begin(
  p_task_id uuid, p_kind text, p_file_name text, p_mime text, p_size_bytes integer, p_sha256 text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_id uuid := gen_random_uuid();
  v_path text;
  v_name text := btrim(coalesce(p_file_name, ''));
  v_sha text := lower(coalesce(p_sha256, ''));
  v_max integer := coalesce((select s.evidence_max_bytes from public.booking_settings s where s.id), 4194304);
  v_gate text;
  v_reconf uuid;  -- Accounts phase 3 (20261205000670)
begin
  if p_kind = 'customer_voucher' then
    -- Accounts phase 3 (20261205000120): the customer voucher of a supplier-confirmed hotel task.
    select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
    if v_task.id is null or v_task.department is distinct from 'purchase' or not authz.can_work_purchase_task(v_task.id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    if v_task.status <> 'supplier_confirmed' then
      raise exception 'not_ready' using errcode = '55000', hint = 'not_confirmed';
    end if;
    perform 1 from public.deals d where d.id = v_task.deal_id for key share;
    v_gate := authz.procurement_gate_issue(v_task.id);
    if v_gate is not null then
      raise exception '%', v_gate using errcode = '55000';
    end if;
  -- Accounts phase 3 (20261205000670): the supplier's reconfirmation proof on a
  -- supplier-confirmed task with an open reconfirmation of a submitted change.
  elsif p_kind = 'supplier_confirmation'
        and exists (select 1 from public.fulfilment_tasks t where t.id = p_task_id and t.status = 'supplier_confirmed') then
    select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
    if v_task.id is null or v_task.department is distinct from 'purchase' or not authz.can_work_purchase_task(v_task.id) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
    select x.id into v_reconf from public.task_reconfirmations x
    join public.booking_change_requests r on r.id = x.change_request_id
    where x.task_id = v_task.id and x.status = 'pending' and r.status = 'approved'
    order by x.created_at desc limit 1;
    if v_reconf is null then
      raise exception 'already_confirmed' using errcode = '55000';
    end if;
    perform 1 from public.deals d where d.id = v_task.deal_id for key share;
    v_gate := authz.procurement_gate_issue(v_task.id);
    if v_gate is not null then
      raise exception '%', v_gate using errcode = '55000';
    end if;
  else
    v_task := authz.lock_workable_task(p_task_id);
  end if;
  if p_kind is null or p_kind not in ('quote', 'supplier_confirmation', 'other', 'customer_voucher')
     or p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes not between 1 and least(v_max, 4194304)
     or v_sha !~ '^[0-9a-f]{64}$'
     or length(v_name) not between 1 and 120 or v_name !~ '^[A-Za-z0-9._ -]+$' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  if (select count(*) from public.purchase_evidence e where e.task_id = v_task.id and e.status <> 'removed') >= 10 then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  v_path := v_task.legal_entity_id::text || '/' || v_task.id::text || '/' || v_id::text;
  insert into public.purchase_evidence (id, task_id, legal_entity_id, kind, object_path, file_name, mime,
    size_bytes, sha256, uploaded_by, reconfirmation_id)
  values (v_id, v_task.id, v_task.legal_entity_id, p_kind, v_path, v_name, p_mime, p_size_bytes, v_sha,
    (select auth.uid()), v_reconf);

  perform authz.write_audit('purchase.evidence_started', v_task.legal_entity_id, v_task.branch_id,
    'purchase_evidence', v_id, null,
    jsonb_build_object('taskId', v_task.id, 'kind', p_kind, 'mime', p_mime, 'sizeBytes', p_size_bytes));
  return jsonb_build_object('evidenceId', v_id, 'objectPath', v_path);
end;
$$;
-- Replaces 20261205000690_reconfirmation_proof_pick.sql:157 (latest body; changed lines marked).
create or replace function public.task_reconfirmation_get(p_task_id uuid) returns jsonb
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
      'record', v_work and v_x.status = 'pending' and v_r.status = 'approved',
      -- Accounts phase 3 (20261205000690): purchase_evidence_begin accepts the proof now (same rule as 20261205000670).
      'uploadProof', v_work and v_task.status = 'supplier_confirmed' and v_x.status = 'pending' and v_r.status = 'approved',
      'refuse', v_work and v_x.status in ('pending', 'recorded') and v_r.status = 'approved',
      'approveOverBudget', v_x.status = 'recorded' and v_x.over_budget and v_x.over_budget_approved_by is null
                           and v_r.status = 'approved' and v_x.recorded_by is distinct from v_uid
                           and authz.can_manage_purchase_task(v_task.id) and authz.cr_is_approver(v_r.id)));
end;
$$;
-- Replaces 20261205000660_change_reads.sql:165 (latest body; changed lines marked).
create or replace function public.change_requests_list(p_filter jsonb, p_after text default null, p_limit integer default 50)
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
           or (v_preset = 'open' and r.status in ('draft', 'requested', 'returned', 'approved', 'submitted'))
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
-- Replaces 20261205000660_change_reads.sql:396 (latest body; changed lines marked).
create or replace function public.booking_change_preview(p_change_request_id uuid) returns jsonb
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
    'canSubmit', v_actor and v_r.status in ('draft', 'returned') and v_ver.status = 'draft' and cardinality(v_changed) > 0
                 and cardinality(v_issues) = 0
                 and not exists (select 1 from public.service_items i where i.id = any (v_changed) and not (i.id = any (v_r.item_ids))));
end;
$$;
-- Replaces 20261205000740_service_change_reads.sql:767 (latest body; changed lines marked).
create or replace function public.deal_change_requests(p_deal_id uuid) returns jsonb
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
  v_service_blocked text[] := '{}'::text[];  -- Accounts phase 3 (20261205000740)
  v_service_ok boolean;
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
  -- Accounts phase 3 (20261205000740): why a service cannot be added or removed now (11.1).
  v_service_blocked := array_remove(array[
    case when not authz.service_changes_enabled() then 'service_changes_off' end,
    case when v_base.id is not null and v_base.service_type <> 'package' then 'change_not_supported' end,
    case when v_base.id is null then 'not_submitted' end,
    case when 'trip_cancelled' = any (v_blocked) then 'trip_cancelled' end,
    case when 'refund_open' = any (v_blocked) then 'refund_open' end,
    case when 'change_open' = any (v_blocked) then 'change_open' end,
    case when exists (select 1 from public.booking_versions v where v.revises_version_id = v_base.id and v.status = 'draft')
      then 'revision_open' end], null);
  v_service_ok := v_role is not null and cardinality(v_service_blocked) = 0;

  return jsonb_build_object(
    'dealId', v_deal.id,
    'enabled', authz.booking_changes_enabled(),
    'canRequest', v_role is not null and cardinality(v_blocked) = 0,
    'blockedBy', to_jsonb(v_blocked),
    -- Accounts phase 3 (20261205000740): additive - adding or removing a service (11.1-11.3).
    'serviceChangesEnabled', authz.service_changes_enabled(),
    'serviceBlockedBy', to_jsonb(v_service_blocked),
    'addableTypes', case when v_service_ok then '["hotel", "transfer", "activity", "flight", "visa", "passport"]'::jsonb
                         else '[]'::jsonb end,
    'removable', case when v_service_ok and (select count(*) from public.service_item_facts f where f.booking_version_id = v_base.id) > 1
      then coalesce((
        select jsonb_agg(jsonb_build_object(
            'itemId', i.id, 'itemNo', i.item_no,
            'serviceTitle', coalesce(authz.service_item_title(i.service_type, f.facts), 'Service'),
            'department', i.department, 'route', authz.cr_removal_route(i.id))
          order by i.item_no)
        from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
        where f.booking_version_id = v_base.id), '[]'::jsonb)
      else '[]'::jsonb end,
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
          -- Accounts phase 3 (20261205000740): additive - the route and customer charge of a removal
          -- (the Sales owner sees the customer charge, never supplier amounts) and
          -- per department whether the supplier charges are entered.
          'removalRoute', r.removal_route,
          'customerChargePaise', r.customer_charge_paise::text,
          'charges', case when r.kind = 'remove_service' and r.removal_route = 'cancellation' then coalesce((
            select jsonb_agg(jsonb_build_object('department', g.department, 'enteredByName', g.entered_by_name, 'complete', g.complete)
              order by g.department)
            from (select c.department, bool_and(c.complete) as complete,
                    (select p.display_name from public.staff_profiles p
                     where p.user_id = (array_agg(c.entered_by order by c.entered_at desc nulls last))[1]) as entered_by_name
                  from authz.cr_removal_charges(r.id) c group by c.department) g), '[]'::jsonb)
            else '[]'::jsonb end,
          'can', jsonb_build_object(
            'resubmit', r.status in ('draft', 'returned') and r.requested_by = v_uid and v_role is not null,
            'withdraw', r.status in ('draft', 'requested', 'returned', 'approved', 'submitted')
                        and ((r.requested_by = v_uid and v_role is not null) or v_is_m),
            'openVersion', r.status in ('draft', 'returned') and r.change_version_id is null
                           and ((r.requested_by = v_uid and v_role is not null) or v_is_so),
            'submit', r.status in ('draft', 'returned') and r.change_version_id is not null
                      and ((r.requested_by = v_uid and v_role is not null) or v_is_so)))
        order by r.requested_at desc, r.id desc)
      from public.booking_change_requests r
      left join public.staff_profiles rp on rp.user_id = r.requested_by
      left join public.staff_profiles dp on dp.user_id = r.decided_by
      where r.deal_id = v_deal.id), '[]'::jsonb));
end;
$$;
-- Replaces 20261205000750_closed_tasks_work_lists.sql:671 (latest body; changed lines marked).
create or replace function authz.sm_payment_create(p_task_id uuid, p_fields jsonb, p_request_id uuid, p_resubmits uuid, p_command text)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_old public.supplier_payment_requests%rowtype;
  v_cost public.purchase_cost_versions;
  v_supplier uuid;
  v_quote_status text;
  v_gate text;
  v_payload jsonb;
  v_result jsonb;
  v_part text;
  v_amount bigint;
  v_due date;
  v_note text;
  v_proforma uuid;
  v_reason text;
  v_expected integer;
  v_budget bigint;
  v_live bigint;
  v_available bigint;
  v_funding bigint;
  v_route text;
  v_funding_route text;
  v_go_ahead uuid;
  v_id uuid := gen_random_uuid();
  v_ref text;
begin
  -- Flight build (20261201000210): flight tasks pay per ticket batch.
  if exists (select 1 from public.fulfilment_tasks t where t.id = p_task_id and t.department = 'flight') then
    -- Accounts phase 3 (20261205000730): a removed Flight service takes no new payment.
    if exists (select 1 from public.fulfilment_tasks t where t.id = p_task_id and t.closed_state is not null)
       and authz.flight_owns_task(p_task_id) then
      raise exception 'service_removed' using errcode = '55000';
    end if;
    return authz.sm_payment_create_flight(p_task_id, p_fields, p_request_id, p_resubmits, p_command);
  end if;

  -- 1. Who: the assignee of this Purchase task (unlocked read, then locks).
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  -- Accounts phase 3 (20261205000750): its assignee hears service_removed (can_work_purchase_task
  -- is false for a closed task, so this is checked first).
  if v_task.closed_state is not null and v_task.department = 'purchase' and v_task.assignee_user_id = (select auth.uid())
     and authz.holds_active_role('purchase', v_task.legal_entity_id) then
    raise exception 'service_removed' using errcode = '55000';
  end if;
  if v_task.id is null or v_task.department is distinct from 'purchase' or not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  perform authz.finance_lock_deal(v_task.deal_id);
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  -- Wait for an in-flight removal of the Deal so the gate reads its result.
  perform 1 from public.deals d where d.id = v_task.deal_id for key share;
  if not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Accounts phase 3 (20261205000730): a removed service takes no new payment (11.1); one
  -- being removed waits until the removal is settled.
  if v_task.closed_state is not null then
    raise exception 'service_removed' using errcode = '55000';
  end if;
  if exists (select 1 from public.booking_change_requests r
             where r.deal_id = v_task.deal_id and r.kind = 'remove_service' and v_task.service_item_id = any (r.item_ids)
               and r.status in ('draft', 'requested', 'returned', 'approved', 'submitted')) then
    raise exception 'change_in_progress' using errcode = '55000';
  end if;
  v_gate := authz.procurement_gate_issue(v_task.id);
  if v_gate is not null then
    raise exception '%', v_gate using errcode = '55000';
  end if;

  v_payload := jsonb_build_object('taskId', p_task_id, 'resubmitsId', p_resubmits, 'fields', p_fields);
  v_result := authz.sm_replay(v_task.legal_entity_id, p_request_id, p_command, v_payload);
  if v_result is not null then
    return v_result;
  end if;

  -- 2. Input.
  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['expectedCostVersionNo', 'part', 'amountPaise', 'dueDate', 'note', 'proformaEvidenceId',
                          'askFunding', 'fundingReason']) <> '{}'::jsonb
     or jsonb_typeof(p_fields -> 'expectedCostVersionNo') is distinct from 'number'
     or (p_fields ->> 'expectedCostVersionNo') !~ '^[0-9]{1,9}$'
     or (p_fields ? 'askFunding' and jsonb_typeof(p_fields -> 'askFunding') not in ('boolean', 'null')) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_expected := (p_fields ->> 'expectedCostVersionNo')::integer;
  v_part := authz.finance_field(p_fields, 'part');
  v_amount := authz.finance_paise(p_fields, 'amountPaise', 1);
  v_due := authz.finance_date(authz.finance_field(p_fields, 'dueDate'));
  v_note := authz.finance_text(authz.finance_field(p_fields, 'note'), 1, 500, true);
  v_proforma := authz.finance_uuid(authz.finance_field(p_fields, 'proformaEvidenceId'));
  -- Optional note for Accounts (10-500), stored as the company funding
  -- reason only when funding is needed. askFunding is accepted and ignored
  -- (earlier clients): Purchase gets no customer money signal at all.
  v_reason := authz.finance_text(authz.finance_field(p_fields, 'fundingReason'), 10, 500, true);
  if v_part is null or v_part not in ('deposit', 'balance', 'full') or v_amount is null
     or v_amount > 999999999999999 or v_proforma is null
     or (v_due is not null and v_due not between date '2000-01-01' and date '2100-12-31') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  -- 3. The returned request being sent again.
  if p_resubmits is not null then
    select * into v_old from public.supplier_payment_requests p where p.id = p_resubmits for update;
    if v_old.id is null or v_old.task_id <> v_task.id then
      raise exception 'invalid_input' using errcode = '22023';
    end if;
    if v_old.status <> 'returned'
       or exists (select 1 from public.supplier_payment_requests p where p.resubmits_id = v_old.id) then
      raise exception 'already_decided' using errcode = '55000';
    end if;
  end if;

  -- 4. Business checks, in contract order.
  if authz.deal_trip_cancelled(v_task.deal_id) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  -- Accounts phase 3 (20261205000640): a change waiting for this supplier
  -- (pending or recorded reconfirmation) takes no new payment request.
  if exists (select 1 from public.task_reconfirmations x
             where x.task_id = v_task.id and x.status in ('pending', 'recorded')) then
    raise exception 'change_in_progress' using errcode = '55000';
  end if;
  v_cost := authz.purchase_agreed_cost(v_task.id);
  if v_cost.id is null then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if v_expected is distinct from v_cost.version_no then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  select q.supplier_id, q.status into v_supplier, v_quote_status
  from public.purchase_quotes q where q.id = v_cost.quote_id;
  if v_part in ('balance', 'full') and not authz.sm_task_confirmed(v_task.status) then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  if not authz.sm_task_confirmed(v_task.status) then
    if v_quote_status is distinct from 'open' then
      raise exception 'not_ready' using errcode = '55000';
    end if;
    v_budget := authz.task_budget(v_task.id);
    if (v_budget is null or v_cost.amount_paise > v_budget)
       and not authz.cost_version_approved(v_task.id, v_cost.version_no) then
      raise exception 'over_budget' using errcode = '55000';
    end if;
    if authz.purchase_go_ahead_needed(v_task.id) then
      -- The booking request e-mail must have gone (sent or marked sent), not
      -- merely be queued or failed.
      if not authz.purchase_booking_request_sent(v_task.id) then
        raise exception 'booking_request_not_sent' using errcode = '55000';
      end if;
      if not authz.purchase_go_ahead_valid(v_task.id) then
        raise exception 'go_ahead_missing' using errcode = '55000';
      end if;
    end if;
  end if;
  if not exists (select 1 from public.supplier_money_evidence e
                 where e.id = v_proforma and e.task_id = v_task.id and e.kind = 'proforma' and e.status = 'stored') then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  select coalesce(sum(p.amount_paise), 0) into v_live from public.supplier_payment_requests p
  where p.task_id = v_task.id and p.status in ('pending', 'approved', 'paid', 'verified');
  if v_live + v_amount > v_cost.amount_paise then
    raise exception 'over_agreed_cost' using errcode = '55000';
  end if;
  -- Customer money (lead decision, review F1): Purchase gets no signal and
  -- no refusal. When the Deal's available customer money does not cover the
  -- amount, the company funding request for the difference is created here
  -- automatically; nothing in the reply depends on it.
  v_available := greatest(authz.sm_customer_money_available(v_task.deal_id, null), 0);
  v_funding := greatest(v_amount - v_available, 0);

  -- 5. Route: every live request for this supplier on this Deal, this one included.
  v_route := authz.sm_route(authz.sm_supplier_running_total(v_task.deal_id, v_supplier) + v_amount);
  select g.id into v_go_ahead from public.purchase_go_ahead_requests g
  where g.task_id = v_task.id and g.status = 'approved'
  order by g.decided_at desc nulls last, g.requested_at desc limit 1;

  v_ref := authz.sm_next_ref(v_task.legal_entity_id);
  insert into public.supplier_payment_requests (id, legal_entity_id, branch_id, deal_id, task_id, supplier_id, ref_no,
    cost_version_no, go_ahead_request_id, part, amount_paise, customer_money_paise, due_date, note,
    proforma_evidence_id, route, resubmits_id, request_id, requested_by)
  values (v_id, v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_task.id, v_supplier, v_ref,
    v_cost.version_no, v_go_ahead, v_part, v_amount, v_amount - v_funding, v_due, v_note,
    v_proforma, v_route, p_resubmits, p_request_id, v_uid);

  if v_funding > 0 then
    v_funding_route := authz.sm_route(authz.sm_funding_running_total(v_task.deal_id) + v_funding);
    insert into public.company_funding_requests (legal_entity_id, branch_id, deal_id, payment_request_id, amount_paise,
      reason, route, requested_by)
    values (v_task.legal_entity_id, v_task.branch_id, v_task.deal_id, v_id, v_funding,
      coalesce(v_reason, 'No note from Purchase'), v_funding_route, v_uid);
  end if;

  perform authz.write_audit(case when p_resubmits is null then 'purchase.payment_requested' else 'purchase.payment_resubmitted' end,
    v_task.legal_entity_id, v_task.branch_id, 'fulfilment_task', v_task.id, null,
    jsonb_build_object('paymentRequestId', v_id, 'refNo', v_ref, 'part', v_part, 'route', v_route,
      'costVersionNo', v_cost.version_no, 'resubmitsId', p_resubmits));

  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'refNo', v_ref, 'route', v_route,
    'status', 'pending');
  return authz.sm_remember(v_task.legal_entity_id, p_request_id, p_command, v_payload, v_result);
end;
$$;
-- Replaces 20261205000750_closed_tasks_work_lists.sql:972 (latest body; changed lines marked).
create or replace function public.purchase_task_claim(p_task_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_uid uuid := (select auth.uid());
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or not authz.can_claim_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- Accounts phase 3 (20261205000750): a service removed, or being removed, is not taken (11.1, 11.3).
  if exists (select 1 from public.fulfilment_tasks t2 where t2.id = v_task.id and (t2.closed_state is not null or exists (
         select 1 from public.booking_change_requests r
         where r.deal_id = t2.deal_id and r.kind = 'remove_service' and t2.service_item_id = any (r.item_ids)
           and r.status in ('draft', 'requested', 'returned', 'approved', 'submitted')))) then
    raise exception 'service_removed' using errcode = '55000';
  end if;
  if v_task.assignee_user_id = v_uid then
    return jsonb_build_object('taskId', v_task.id, 'status', v_task.status, 'assignedToYou', true,
      'alreadyYours', true);
  end if;
  if v_task.assignee_user_id is not null then
    raise exception 'task_conflict' using errcode = '40001';
  end if;

  update public.fulfilment_tasks t
  set assignee_user_id = v_uid, status = 'in_progress', updated_at = now()
  where t.id = v_task.id;
  insert into public.deal_assignments (deal_id, legal_entity_id, user_id, assignment_kind, assigned_by)
  values (v_task.deal_id, v_task.legal_entity_id, v_uid, 'purchase', v_uid)
  on conflict (deal_id, user_id, assignment_kind) where ended_at is null do nothing;

  perform authz.write_audit('fulfilment.task_claimed', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('dealId', v_task.deal_id, 'versionId', v_task.booking_version_id));
  return jsonb_build_object('taskId', v_task.id, 'status', 'in_progress', 'assignedToYou', true,
    'alreadyYours', false);
end;
$$;
-- Replaces 20261205000750_closed_tasks_work_lists.sql:1012 (latest body; changed lines marked).
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
  -- Stage 0: wait for an in-flight removal of the Deal (it holds FOR UPDATE)
  -- so the gate below reads its committed result.
  perform 1 from public.deals d where d.id = v_task.deal_id for key share;
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
  -- Accounts phase 3 (20261205000750): a service removed, or being removed, is not confirmed (11.1, 11.3).
  if exists (select 1 from public.fulfilment_tasks t2 where t2.id = v_task.id and (t2.closed_state is not null or exists (
         select 1 from public.booking_change_requests r
         where r.deal_id = t2.deal_id and r.kind = 'remove_service' and t2.service_item_id = any (r.item_ids)
           and r.status in ('draft', 'requested', 'returned', 'approved', 'submitted')))) then
    raise exception 'service_removed' using errcode = '55000';
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
  -- Stage 0: a Deal removed by the Bitrix sync takes no new commitment.
  if 'deal_removed' = any (v_issues) then
    raise exception 'deal_removed' using errcode = '55000';
  end if;
  if 'procurement_disabled' = any (v_issues) then
    raise exception 'procurement_disabled' using errcode = '55000';
  end if;
  -- Purchase build: a cancelled trip takes no new commitment.
  if 'trip_cancelled' = any (v_issues) then
    raise exception 'trip_cancelled' using errcode = '55000';
  end if;
  if v_issues = array['over_budget'] then
    raise exception 'over_budget' using errcode = '55000';
  end if;
  -- Purchase build: when only the booking request or the Accounts go-ahead is
  -- missing, name it (booking request first: it starts the go-ahead).
  if cardinality(v_issues) > 0 and v_issues <@ array['booking_request_not_sent', 'go_ahead_missing'] then
    if 'booking_request_not_sent' = any (v_issues) then
      raise exception 'booking_request_not_sent' using errcode = '55000';
    end if;
    raise exception 'go_ahead_missing' using errcode = '55000';
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
  -- Accounts phase 3 (20261205000630): confirmation 1 of the task's history.
  insert into public.task_confirmations (legal_entity_id, task_id, confirmation_no, quote_id, committed_version_no, amount_paise,
    supplier_reference, evidence_ids, booking_version_id, confirmed_by, confirmed_at)
  values (v_task.legal_entity_id, v_task.id, 1, v_cost.quote_id, v_cost.version_no + 1, v_cost.amount_paise, v_ref,
    coalesce((select array_agg(e.id order by e.created_at, e.id) from public.purchase_evidence e
              where e.task_id = v_task.id and e.kind = 'supplier_confirmation' and e.status = 'stored'), '{}'::uuid[]),
    authz.task_current_version(v_task.id), (select auth.uid()), now())
  on conflict (task_id, confirmation_no) do nothing;

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
-- Replaces 20261205000730_service_removal_charges.sql:49 (latest body; changed lines marked).
create or replace function public.purchase_cancellation_charge_set(
  p_task_id uuid, p_keeps_paise bigint, p_refund_paise bigint, p_note text, p_credit_note_evidence_id uuid,
  p_expected_revision integer, p_request_id uuid
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_c public.deal_cancellations%rowtype;
  v_existing public.purchase_cancellation_charges%rowtype;
  v_rev integer;
  v_cost public.purchase_cost_versions;
  v_supplier uuid;
  v_note text;
  v_cr public.booking_change_requests%rowtype;  -- Accounts phase 3 (20261205000730)
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id for update;
  if v_task.id is null or v_task.department is distinct from 'purchase' or not coalesce(authz.session_ok(), false)
     or not authz.holds_active_role('purchase', v_task.legal_entity_id)
     or (v_task.assignee_user_id is not null and v_task.assignee_user_id <> v_uid) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_request_id is null then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  select * into v_c from public.deal_cancellations c where c.deal_id = v_task.deal_id for update;
  -- Accounts phase 3 (20261205000730): without a trip cancellation, the charge belongs to the
  -- live remove_service request (route cancellation) naming this service (11.3).
  -- Lock order 17.1: the task, then the request.
  if v_c.id is null then
    select r.* into v_cr from public.booking_change_requests r
    where r.deal_id = v_task.deal_id and r.kind = 'remove_service' and r.removal_route = 'cancellation'
      and v_task.service_item_id = any (r.item_ids) and r.status in ('draft', 'requested', 'returned', 'approved', 'submitted')
    for update;
  end if;
  if v_c.id is null and v_cr.id is null then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  select * into v_existing from public.purchase_cancellation_charges x
  where x.legal_entity_id = v_task.legal_entity_id and x.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.task_id = v_task.id and v_existing.entered_by = v_uid
       and (v_existing.cancellation_id = v_c.id or v_existing.change_request_id = v_cr.id) then  -- Accounts phase 3 (20261205000730)
      return jsonb_build_object('cancellationId', v_c.id, 'revisionNo', v_existing.revision_no,
        'status', coalesce(v_c.status, 'charges_entered'), 'outcome', 'existing', 'changeRequestId', v_cr.id);
    end if;
    raise exception 'duplicate_request' using errcode = '23505';
  end if;
  if v_c.status = 'approved' then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  -- Accounts phase 3 (20261205000730): the charges stand once the Manager approved the removal.
  if v_cr.id is not null and v_cr.status not in ('draft', 'requested', 'returned') then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  select coalesce(max(x.revision_no), 0) into v_rev from public.purchase_cancellation_charges x
  where (x.cancellation_id = v_c.id or x.change_request_id = v_cr.id) and x.task_id = v_task.id;  -- Accounts phase 3 (20261205000730)
  if p_expected_revision is distinct from v_rev then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  v_cost := authz.purchase_latest_cost(v_task.id);
  if v_cost.id is null then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  select q.supplier_id into v_supplier from public.purchase_quotes q where q.id = v_cost.quote_id;
  if p_keeps_paise is null or p_refund_paise is null or p_keeps_paise < 0 or p_refund_paise < 0
     or p_keeps_paise > 999999999999999999 or p_refund_paise > 999999999999999999 then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_note := authz.booking_fact_text(jsonb_build_object('note', p_note), 'note', 500, true);
  if p_credit_note_evidence_id is not null and not authz.cancellation_credit_note_ok(v_task.id, p_credit_note_evidence_id) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;

  insert into public.purchase_cancellation_charges (cancellation_id, legal_entity_id, task_id, revision_no, supplier_id,
    committed_cost_paise, supplier_keeps_paise, supplier_refund_paise, note, credit_note_evidence_id, entered_by, request_id,
    change_request_id)  -- Accounts phase 3 (20261205000730)
  values (v_c.id, v_task.legal_entity_id, v_task.id, v_rev + 1, v_supplier, v_cost.amount_paise, p_keeps_paise,
    p_refund_paise, v_note, p_credit_note_evidence_id, v_uid, p_request_id, v_cr.id);

  update public.deal_cancellations c
  set status = 'charges_entered', row_version = c.row_version + 1, updated_at = now()
  where c.id = v_c.id;

  perform authz.write_audit('purchase.cancellation_charge_set', v_task.legal_entity_id, v_task.branch_id,
    'fulfilment_task', v_task.id, null,
    jsonb_build_object('cancellationId', v_c.id, 'revisionNo', v_rev + 1, 'previousStatus', v_c.status,
      'creditNote', p_credit_note_evidence_id is not null, 'changeRequestId', v_cr.id));  -- Accounts phase 3 (20261205000730)
  return jsonb_build_object('cancellationId', v_c.id, 'revisionNo', v_rev + 1, 'status', 'charges_entered',
    'outcome', 'created', 'changeRequestId', v_cr.id);
end;
$$;
-- Replaces 20261205000770_removed_flight_visa_work.sql:907 (latest body; changed lines marked).
create or replace function public.flight_cancellation_charge_set(p_batch_id uuid, p_fields jsonb, p_expected_revision integer,
  p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_batch public.flight_ticket_batches%rowtype;
  v_c public.deal_cancellations%rowtype;
  v_prev public.flight_cancellation_charges%rowtype;
  v_existing public.flight_cancellation_charges%rowtype;
  v_key text;
  v_airline bigint;
  v_expected bigint;
  v_reported bigint;
  v_note text;
  v_rev integer;
  v_cr public.booking_change_requests%rowtype;  -- Accounts phase 3 (20261205000730)
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_batch from public.flight_ticket_batches b where b.id = p_batch_id;
  if v_batch.id is null or not authz.holds_active_role('flight', v_batch.legal_entity_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if p_request_id is null then
    perform authz.refund_invalid('requestId');
  end if;
  perform authz.refuse_removed_deal(v_batch.deal_id);
  -- Lock order (13.1): finance head, the Deal's Flight tasks, the cancellation row.
  perform authz.finance_lock_deal(v_batch.deal_id);
  perform 1 from authz.flight_lock_group(v_batch.deal_id);
  select * into v_c from public.deal_cancellations c where c.deal_id = v_batch.deal_id for update;
  -- Accounts phase 3 (20261205000730): without a trip cancellation, the charge belongs to the
  -- live remove_service request (route cancellation) whose service this batch
  -- serves (its cost task or one of its sectors, 11.3). Who: the batch's cost-task
  -- owner, or any active Flight person while that task has no assignee (C9).
  if v_c.id is null then
    select r.* into v_cr from public.booking_change_requests r
    where r.deal_id = v_batch.deal_id and r.kind = 'remove_service' and r.removal_route = 'cancellation'
      and r.status in ('draft', 'requested', 'returned', 'approved', 'submitted')
      and (exists (select 1 from public.fulfilment_tasks t where t.id = v_batch.cost_task_id and t.service_item_id = any (r.item_ids))
           or exists (select 1 from public.flight_sectors s where s.id = any (v_batch.sector_ids) and s.service_item_id = any (r.item_ids)))
    for update;
    if v_cr.id is null then
      raise exception 'not_ready' using errcode = '55000', hint = 'cancellation';
    end if;
    if not exists (select 1 from public.fulfilment_tasks t
                   where t.id = v_batch.cost_task_id
                     and (authz.flight_owns_task_record(t.id)  -- Accounts phase 3 (20261205000770): also after the removal applied (LD13)
                          or (t.assignee_user_id is null and authz.holds_active_role('flight', t.legal_entity_id)))) then
      raise exception 'not_authorized' using errcode = '42501';
    end if;
  elsif not authz.flight_can_enter_charge(v_batch.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_existing from public.flight_cancellation_charges x
  where x.legal_entity_id = v_batch.legal_entity_id and x.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.batch_id = v_batch.id and v_existing.entered_by = v_uid
       and (v_existing.cancellation_id = v_c.id or v_existing.change_request_id = v_cr.id) then  -- Accounts phase 3 (20261205000730)
      return jsonb_build_object('outcome', 'existing', 'cancellationId', v_c.id, 'batchId', v_batch.id,
        'revisionNo', v_existing.revision_no, 'status', coalesce(v_c.status, 'charges_entered'), 'changeRequestId', v_cr.id);
    end if;
    raise exception 'duplicate_request' using errcode = '23505';
  end if;
  select * into v_prev from public.flight_cancellation_charges x
  where (x.cancellation_id = v_c.id or x.change_request_id = v_cr.id) and x.batch_id = v_batch.id  -- Accounts phase 3 (20261205000730)
  order by x.revision_no desc limit 1;
  v_rev := coalesce(v_prev.revision_no, 0);
  if p_fields is null or jsonb_typeof(p_fields) <> 'object' then
    perform authz.refund_invalid('fields');
  end if;
  for v_key in select k from jsonb_object_keys(p_fields) k order by k loop
    if v_key <> all (array['airlineChargePaise', 'refundExpectedPaise', 'refundReportedPaise', 'note']) then
      perform authz.refund_invalid(v_key);
    end if;
  end loop;
  v_airline := authz.refund_paise(p_fields, 'airlineChargePaise');
  if v_airline is null or v_airline > 999999999999 then
    perform authz.refund_invalid('airlineChargePaise');
  end if;
  v_expected := authz.refund_paise(p_fields, 'refundExpectedPaise');
  if v_expected is null or v_expected > 999999999999 then
    perform authz.refund_invalid('refundExpectedPaise');
  end if;
  v_reported := authz.refund_paise(p_fields, 'refundReportedPaise');
  if v_reported > 999999999999 then
    perform authz.refund_invalid('refundReportedPaise');
  end if;
  v_note := authz.refund_text(p_fields, 'note', 1, 500, true);
  -- LD13: after approval only the Flight-reported refund may change.
  if (v_c.status = 'approved' or v_cr.status in ('approved', 'submitted'))  -- Accounts phase 3 (20261205000730): the same after the removal was approved
     and (v_prev.id is null or v_airline is distinct from v_prev.airline_charge_paise
          or v_expected is distinct from v_prev.refund_expected_paise) then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if p_expected_revision is distinct from v_rev then
    raise exception 'version_changed' using errcode = '40001';
  end if;

  insert into public.flight_cancellation_charges (cancellation_id, legal_entity_id, deal_id, batch_id, cost_task_id, supplier_id,
    revision_no, supplier_cost_paise, airline_charge_paise, refund_expected_paise, refund_reported_paise, note, entered_by, request_id,
    change_request_id)  -- Accounts phase 3 (20261205000730)
  values (v_c.id, v_batch.legal_entity_id, v_batch.deal_id, v_batch.id, v_batch.cost_task_id, v_batch.supplier_id, v_rev + 1,
    v_batch.supplier_cost_paise, v_airline, v_expected, v_reported, v_note, v_uid, p_request_id, v_cr.id);
  -- Purchase rule: a change before approval (also after sending) puts the case back to charges_entered.
  if v_c.status <> 'approved' then
    update public.deal_cancellations c
    set status = 'charges_entered', row_version = c.row_version + 1, updated_at = now()
    where c.id = v_c.id;
  end if;
  perform authz.write_audit('flight.cancellation_charge_set', v_batch.legal_entity_id, v_batch.branch_id,
    'flight_ticket_batch', v_batch.id, null,
    jsonb_build_object('cancellationId', v_c.id, 'batchId', v_batch.id, 'revisionNo', v_rev + 1, 'previousStatus', v_c.status,
      'changeRequestId', v_cr.id));  -- Accounts phase 3 (20261205000730)
  return jsonb_build_object('outcome', 'created', 'cancellationId', v_c.id, 'batchId', v_batch.id, 'revisionNo', v_rev + 1,
    'status', case when v_c.status = 'approved' or v_cr.status in ('approved', 'submitted') then 'approved' else 'charges_entered' end,
    'changeRequestId', v_cr.id);
end;
$$;
-- Replaces 20261205000770_removed_flight_visa_work.sql:1032 (latest body; changed lines marked).
create or replace function public.visa_cancellation_fee_set(p_entry_id uuid, p_refund_expected_paise bigint, p_note text,
  p_expected_revision integer, p_request_id uuid)
returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_entry public.department_cost_entries%rowtype;
  v_c public.deal_cancellations%rowtype;
  v_existing public.visa_cancellation_fees%rowtype;
  v_rev integer;
  v_note text;
  v_cr public.booking_change_requests%rowtype;  -- Accounts phase 3 (20261205000730)
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_entry from public.department_cost_entries c where c.id = p_entry_id;
  if v_entry.id is null or v_entry.department <> 'visa' or not authz.visa_can_manage_fees(v_entry.task_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_request_id is null then
    perform authz.refund_invalid('requestId');
  end if;
  perform authz.refuse_removed_deal(v_entry.deal_id);
  perform authz.finance_lock_deal(v_entry.deal_id);
  perform 1 from public.fulfilment_tasks t where t.id = v_entry.task_id for update;
  select * into v_c from public.deal_cancellations c where c.deal_id = v_entry.deal_id;
  -- Accounts phase 3 (20261205000730): without a trip cancellation, the fee refund belongs to the
  -- remove_service request (route cancellation) naming this Visa service, live or applied (11.3).
  if v_c.id is null then
    select r.* into v_cr from public.booking_change_requests r
    join public.fulfilment_tasks t on t.id = v_entry.task_id
    where r.deal_id = v_entry.deal_id and r.kind = 'remove_service' and r.removal_route = 'cancellation'
      and t.service_item_id = any (r.item_ids) and r.status in ('draft', 'requested', 'returned', 'approved', 'submitted', 'applied')
    order by r.requested_at desc, r.id desc limit 1
    for share of r;
  end if;
  -- Accounts phase 3 (20261205000770): the fee refunds of a removal stand once the Manager approved it.
  if v_cr.id is not null and v_cr.status not in ('draft', 'requested', 'returned') then
    raise exception 'already_decided' using errcode = '55000';
  end if;
  if (v_c.id is null and v_cr.id is null) or v_entry.paid_by <> 'company' then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  select * into v_existing from public.visa_cancellation_fees x
  where x.legal_entity_id = v_entry.legal_entity_id and x.request_id = p_request_id;
  if v_existing.id is not null then
    if v_existing.entry_id = v_entry.id and v_existing.entered_by = v_uid then
      return jsonb_build_object('outcome', 'existing', 'entryId', v_entry.id, 'revisionNo', v_existing.revision_no);
    end if;
    raise exception 'duplicate_request' using errcode = '23505';
  end if;
  select coalesce(max(x.revision_no), 0) into v_rev from public.visa_cancellation_fees x
  where (x.cancellation_id = v_c.id or x.change_request_id = v_cr.id) and x.entry_id = v_entry.id;  -- Accounts phase 3 (20261205000730)
  if p_expected_revision is distinct from v_rev then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if p_refund_expected_paise is null or p_refund_expected_paise < 0 or p_refund_expected_paise > v_entry.amount_paise then
    perform authz.refund_invalid('refundExpectedPaise');
  end if;
  begin
    v_note := authz.finance_text(p_note, 1, 500, true);
  exception when sqlstate '22023' then
    perform authz.refund_invalid('note');
  end;
  insert into public.visa_cancellation_fees (cancellation_id, legal_entity_id, deal_id, task_id, entry_id, revision_no,
    refund_expected_paise, note, entered_by, request_id, change_request_id)  -- Accounts phase 3 (20261205000730)
  values (v_c.id, v_entry.legal_entity_id, v_entry.deal_id, v_entry.task_id, v_entry.id, v_rev + 1, p_refund_expected_paise,
    v_note, v_uid, p_request_id, v_cr.id);
  perform authz.write_audit('visa.cancellation_fee_set', v_entry.legal_entity_id, v_entry.branch_id, 'department_cost_entry',
    v_entry.id, null, jsonb_build_object('cancellationId', v_c.id, 'entryId', v_entry.id, 'revisionNo', v_rev + 1,
      'changeRequestId', v_cr.id));  -- Accounts phase 3 (20261205000730)
  return jsonb_build_object('outcome', 'created', 'entryId', v_entry.id, 'cancellationId', v_c.id, 'revisionNo', v_rev + 1,
    'changeRequestId', v_cr.id);
end;
$$;
-- Replaces 20261205000740_service_change_reads.sql:328 (latest body; changed lines marked).
create or replace function authz.task_cancellation_json(p_task uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce((
  select jsonb_build_object(
      'cancellationId', c.id,
      'status', c.status,
      'reason', c.reason,
      'openedAt', c.opened_at,
      'openedByName', op.display_name,
      'rowVersion', c.row_version,
      'returnReason', c.return_reason,
      'myCharge', authz.cancellation_charge_json(c.id, t.id),
      'canEnter', c.status <> 'approved' and t.department = 'purchase'
        and authz.holds_active_role('purchase', t.legal_entity_id)
        and (t.assignee_user_id is null or t.assignee_user_id = (select auth.uid()))
        and exists (select 1 from public.purchase_cost_versions v where v.task_id = t.id),
      'canSend', c.status in ('open', 'charges_entered')
        and authz.holds_active_role('purchase', c.legal_entity_id)
        and authz.cancellation_charges_missing(c.id) = 0,
      'chargesMissing', authz.cancellation_charges_missing(c.id))
    from public.fulfilment_tasks t
    join public.deal_cancellations c on c.deal_id = t.deal_id
    left join public.staff_profiles op on op.user_id = c.opened_by
    where t.id = p_task
  -- Accounts phase 3 (20261205000740): additive changeRequestId (null for a trip cancellation).
  ) || jsonb_build_object('changeRequestId', null), (
  -- Accounts phase 3 (20261205000740): without a trip cancellation, the removal of this booked
  -- service (route cancellation) keyed by its request: the same panel, no send step,
  -- never the customer charge (Purchase never sees selling data).
  select jsonb_build_object(
    'cancellationId', null,
    'changeRequestId', r.id,
    'status', case when r.status in ('approved', 'submitted', 'applied') then 'approved'
                   when x.id is not null then 'charges_entered' else 'open' end,
    'reason', r.reason,
    'openedAt', r.requested_at,
    'openedByName', op.display_name,
    'rowVersion', r.row_version,
    'returnReason', null,
    'myCharge', authz.cr_charge_json(r.id, t.id),
    'canEnter', r.status in ('draft', 'requested', 'returned') and t.department = 'purchase' and t.closed_state is null
      and authz.holds_active_role('purchase', t.legal_entity_id)
      and (t.assignee_user_id is null or t.assignee_user_id = (select auth.uid()))
      and exists (select 1 from public.purchase_cost_versions v where v.task_id = t.id),
    'canSend', false,
    'chargesMissing', (select count(*)::integer from authz.cr_removal_charges(r.id) c where c.department = 'purchase' and not c.complete))
  from public.fulfilment_tasks t
  join lateral (select q.* from public.booking_change_requests q
                where q.deal_id = t.deal_id and q.kind = 'remove_service' and q.removal_route = 'cancellation'
                  and t.service_item_id = any (q.item_ids) and q.status in ('draft', 'requested', 'returned', 'approved', 'submitted', 'applied')
                order by q.requested_at desc, q.id desc limit 1) r on true
  left join lateral (select y.id from public.purchase_cancellation_charges y
                     where y.change_request_id = r.id and y.task_id = t.id limit 1) x on true
  left join public.staff_profiles op on op.user_id = r.requested_by
  where t.id = p_task))
$$;
-- Replaces 20261205000740_service_change_reads.sql:73 (latest body; changed lines marked).
create or replace function authz.cr_visa_cancellation_json(p_task uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'changeRequestId', r.id,
    'cancellationId', null,
    'status', case when r.status in ('approved', 'submitted', 'applied') then 'approved'
                   when exists (select 1 from public.visa_cancellation_fees y where y.change_request_id = r.id and y.task_id = t.id)
                     then 'charges_entered' else 'open' end,
    'approved', r.status in ('approved', 'submitted', 'applied'),
    'fees', (select coalesce(jsonb_agg(jsonb_build_object(
        'entryId', c.id, 'applicationId', c.application_id, 'costKind', c.cost_kind, 'amountPaise', c.amount_paise::text,
        'refundExpectedPaise', f.refund_expected_paise::text, 'revisionNo', coalesce(f.revision_no, 0),
        'canSet', authz.visa_can_manage_fees(t.id)) order by c.created_at, c.id), '[]'::jsonb)
      from public.department_cost_entries c
      left join lateral (select x.refund_expected_paise, x.revision_no from public.visa_cancellation_fees x
                         where x.entry_id = c.id and x.change_request_id = r.id
                         order by x.revision_no desc limit 1) f on true
      where c.task_id = t.id and c.paid_by = 'company'))
  from public.fulfilment_tasks t
  join lateral (select q.* from public.booking_change_requests q
                where q.deal_id = t.deal_id and q.kind = 'remove_service' and q.removal_route = 'cancellation'
                  and t.service_item_id = any (q.item_ids) and q.status in ('draft', 'requested', 'returned', 'approved', 'submitted', 'applied')
                order by q.requested_at desc, q.id desc limit 1) r on true
  where t.id = p_task
$$;
-- Replaces 20261205000740_service_change_reads.sql:386 (latest body; changed lines marked).
create or replace function public.flight_money(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_deal public.deals%rowtype;
  v_f boolean;
  v_fa boolean;
  v_m boolean;
  v_a boolean;
  v_so boolean;
  v_full boolean;
  v_kind text;
  v_fo boolean;
  v_budget bigint;
  v_cost bigint;
  v_cancelled boolean;
  v_sell boolean;
  v_c public.deal_cancellations%rowtype;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  if v_deal.id is null or not exists (select 1 from public.fulfilment_tasks t where t.deal_id = v_deal.id and t.department = 'flight') then
    return null;
  end if;
  v_f := authz.holds_active_role('flight', v_deal.legal_entity_id);
  v_fa := v_f and exists (select 1 from public.fulfilment_tasks t
                          where t.deal_id = v_deal.id and t.department = 'flight'
                            and t.status in ('in_progress', 'completed') and t.assignee_user_id = v_uid);
  v_m := authz.is_branch_sales_manager(v_deal.id) and not authz.holds_role('purchase', v_deal.legal_entity_id);
  v_a := authz.can_accounts(v_deal.legal_entity_id) and not authz.holds_role('purchase', v_deal.legal_entity_id)
         and authz.finance_gate_issue(v_deal.legal_entity_id, v_deal.is_synthetic) is null;
  v_so := authz.flight_is_sales_owner(v_deal.id) and not authz.holds_role('purchase', v_deal.legal_entity_id)
          and not authz.holds_role('visa', v_deal.legal_entity_id);
  v_full := v_f or v_m or v_a;
  -- 20261201000250 (lead): a holder of Purchase never gets selling-side values.
  v_sell := not authz.holds_role('purchase', v_deal.legal_entity_id);
  if not (v_full or v_so) then
    return null;
  end if;

  v_kind := authz.flight_deal_kind(v_deal.id);
  v_fo := v_kind = 'flight_only';
  v_budget := authz.flight_deal_budget(v_deal.id);
  v_cost := authz.flight_deal_supplier_cost(v_deal.id);
  v_cancelled := authz.deal_trip_cancelled(v_deal.id);
  select * into v_c from public.deal_cancellations c where c.deal_id = v_deal.id;

  -- Keys a role may not see are absent (contract 9.3 table), not null.
  return jsonb_build_object(
    'dealKind', v_kind,
    -- 20261201000270: true only on flight-only Deals for a caller who may see
    -- and enter markup and discount (never a holder of Purchase).
    'marginsAllowed', v_fo and v_sell,
    'budget', jsonb_build_object(
      'dealPaise', v_budget::text,
      'tasks', coalesce((
        select jsonb_agg(jsonb_build_object('taskId', t.id, 'budgetPaise', b.budget_paise::text, 'source', coalesce(b.source, 'none'))
                         order by i.item_no, t.id)
        from public.fulfilment_tasks t
        join public.service_items i on i.id = t.service_item_id
        left join lateral (select x.budget_paise, x.source from authz.flight_task_budget(t.id) x limit 1) b on true
        where t.deal_id = v_deal.id and t.department = 'flight'), '[]'::jsonb)),
    'supplierCostPaise', v_cost::text,
    'overBudget', v_cost > 0 and (v_budget is null or v_cost > v_budget),
    'batches', coalesce((
      select jsonb_agg(
        jsonb_build_object(
          'batchId', b.id,
          'batchNo', b.batch_no,
          'costTaskId', b.cost_task_id,
          'supplierId', b.supplier_id,
          'supplierName', s.name,
          'sectorIds', to_jsonb(b.sector_ids),
          'confirmedAt', b.confirmed_at,
          'confirmedByName', cp.display_name,
          -- Accounts phase 2 (20261204000330): tickets stay immutable; after approval they read cancelled.
          'ticketsCancelled', v_c.status is not distinct from 'approved',
          -- Flight never gets a company funding signal (as Purchase, review F1).
          'payment', case when v_full then jsonb_build_object(
              'state', x.state,
              'route', x.route,
              'refNo', x.ref_no,
              'returnReason', x.return_reason,
              'onHold', case when v_m or v_a then x.on_hold else coalesce(x.hold_reason = 'bank_details_on_hold', false) end,
              'holdReason', case when v_m or v_a then x.hold_reason
                                 when x.hold_reason = 'bank_details_on_hold' then x.hold_reason end)
            || case when v_fa then jsonb_build_object(
              'entryId', x.entry_id,
              'entryRowVersion', x.entry_row_version,
              'paymentId', x.payment_id,
              'paymentRowVersion', x.payment_row_version,
              -- Accounts phase (20261203000120): a pending request is cancelled by its
              -- requester or the current owner of the batch's cost task (H9).
              'canCancel', x.state = 'request_pending' and x.payment_id is not null
                           and (exists (select 1 from public.supplier_payment_requests p
                                        where p.id = x.payment_id and p.requested_by = v_uid)
                                or authz.flight_owns_task(b.cost_task_id)))
            -- Accounts phase (20261203000130): the requester of a pending request who
            -- is no longer a Flight assignee of the Deal can still cancel it.
            when v_f and x.state = 'request_pending' and x.payment_id is not null
                 and exists (select 1 from public.supplier_payment_requests p
                             where p.id = x.payment_id and p.requested_by = v_uid) then jsonb_build_object(
              'paymentId', x.payment_id,
              'paymentRowVersion', x.payment_row_version,
              'canCancel', true) else '{}'::jsonb end
            else jsonb_build_object('state', x.state) end)
        -- Fares and supplier amounts: F, M, A; the Sales owner on flight-only Deals.
        || case when v_full or b.deal_kind = 'flight_only' then jsonb_build_object(
          'fares', coalesce((
            select jsonb_agg(jsonb_build_object(
                'paxType', f.pax_type,
                'basicPaise', f.basic_paise::text,
                'kPaise', f.k_paise::text,
                'yqPaise', f.yq_paise::text,
                'yrPaise', f.yr_paise::text,
                'otherPaise', f.other_paise::text,
                'supplierPerPersonPaise', f.supplier_per_person_paise::text,
                'paxCount', f.pax_count,
                'supplierAmountPaise', (f.supplier_per_person_paise * f.pax_count)::text)
              || case when b.deal_kind = 'flight_only' and v_sell then jsonb_build_object(
                'markupPaise', f.markup_paise::text,
                'discountPaise', f.discount_paise::text,
                'totalPerPersonPaise', f.total_per_person_paise::text,
                'customerAmountPaise', (f.total_per_person_paise * f.pax_count)::text) else '{}'::jsonb end
              order by case f.pax_type when 'adult' then 1 when 'child' then 2 else 3 end)
            from public.flight_batch_fares f where f.batch_id = b.id), '[]'::jsonb),
          'supplierCostPaise', b.supplier_cost_paise::text,
          -- 20261201000250 (L18): covered by old-form payments, and still to pay.
          'legacyPaidPaise', authz.flight_batch_legacy_paid(b.id)::text,
          'duePaise', authz.flight_batch_due(b.id)::text) else '{}'::jsonb end
        || case when b.deal_kind = 'flight_only' and v_sell then jsonb_build_object('customerTotalPaise', b.customer_total_paise::text)
                else '{}'::jsonb end
        -- Accounts phase 2 (20261204000330, 2d): the batch's cancellation charge for F, M and A.
        || case when v_full and v_c.id is not null then jsonb_build_object('cancellation', jsonb_build_object(
          'changeRequestId', null,  -- Accounts phase 3 (20261205000740)
          'state', case when v_c.status = 'approved' then 'approved' else 'open' end,
          'revisionNo', coalesce(fc.revision_no, 0),
          'airlineChargePaise', fc.airline_charge_paise::text,
          'refundExpectedPaise', fc.refund_expected_paise::text,
          'refundReportedPaise', fc.refund_reported_paise::text,
          -- Accounts phase 2 (20261204000370): the Flight note of the latest revision (F, M, A).
          'note', fc.note,
          'supplierRefundReceivedPaise', (select coalesce(sum(s2.amount_paise), 0)::text from public.supplier_refund_receipts s2
                                          where s2.source_kind = 'flight_charge' and s2.source_group_id = b.id and s2.status = 'verified'),
          'canEnter', authz.flight_can_enter_charge(b.id)))
                else '{}'::jsonb end
        -- Accounts phase 3 (20261205000740): a booked Flight service being removed (11.3) - the
        -- same per-batch charge, keyed by the remove_service request (F, M, A).
        || case when v_full and v_c.id is null and bcr.id is not null then jsonb_build_object('cancellation', jsonb_build_object(
          'changeRequestId', bcr.id,
          'state', case when bcr.status in ('approved', 'submitted', 'applied') then 'approved' else 'open' end,
          'revisionNo', coalesce(cfc.revision_no, 0),
          'airlineChargePaise', cfc.airline_charge_paise::text,
          'refundExpectedPaise', cfc.refund_expected_paise::text,
          'refundReportedPaise', cfc.refund_reported_paise::text,
          'note', cfc.note,
          'supplierRefundReceivedPaise', (select coalesce(sum(s2.amount_paise), 0)::text from public.supplier_refund_receipts s2
                                          where s2.source_kind = 'flight_charge' and s2.source_group_id = b.id and s2.status = 'verified'),
          'canEnter', bcr.status in ('requested', 'returned', 'approved', 'submitted')
                      and (authz.flight_owns_task(b.cost_task_id)
                           or (bct.assignee_user_id is null and authz.holds_active_role('flight', bct.legal_entity_id)))))
                else '{}'::jsonb end
        || case when v_full then jsonb_build_object(
          'routePreview', case when rt.total + authz.flight_batch_due(b.id) <= 5000000 then 'direct' else 'manager' end)
                else '{}'::jsonb end
        -- Actions: the Flight person only.
        || case when v_fa then jsonb_build_object(
          'canPayDirect', authz.flight_owns_task(b.cost_task_id) and not v_cancelled and authz.flight_batch_due(b.id) > 0
                          and bct.closed_state is null  -- Accounts phase 3 (20261205000740): a removed service takes no new payment
                          and x.state in ('unpaid', 'direct_returned', 'request_returned', 'request_cancelled')
                          and rt.total + authz.flight_batch_due(b.id) <= 5000000,
          'canRequest', authz.flight_owns_task(b.cost_task_id) and not v_cancelled and authz.flight_batch_due(b.id) > 0
                        and bct.closed_state is null  -- Accounts phase 3 (20261205000740)
                        and x.state in ('unpaid', 'direct_returned', 'request_returned', 'request_cancelled'))
                else '{}'::jsonb end
        order by b.batch_no)
      from public.flight_ticket_batches b
      join public.suppliers s on s.id = b.supplier_id
      left join public.staff_profiles cp on cp.user_id = b.confirmed_by
      cross join lateral authz.flight_batch_payment(b.id) x
      left join lateral (select y.* from public.flight_cancellation_charges y
                         where y.batch_id = b.id and y.cancellation_id = v_c.id
                         order by y.revision_no desc limit 1) fc on true
      -- Accounts phase 3 (20261205000740): the batch's cost task and the removal request covering the batch.
      join public.fulfilment_tasks bct on bct.id = b.cost_task_id
      left join lateral (select q.* from public.booking_change_requests q
                         where q.deal_id = b.deal_id and q.kind = 'remove_service' and q.removal_route = 'cancellation'
                           and q.status in ('draft', 'requested', 'returned', 'approved', 'submitted', 'applied')
                           and (bct.service_item_id = any (q.item_ids)
                                or exists (select 1 from public.flight_sectors fs
                                           where fs.id = any (b.sector_ids) and fs.service_item_id = any (q.item_ids)))
                         order by q.requested_at desc, q.id desc limit 1) bcr on true
      left join lateral (select y.* from public.flight_cancellation_charges y
                         where y.batch_id = b.id and y.change_request_id = bcr.id
                         order by y.revision_no desc limit 1) cfc on true
      cross join lateral (select authz.sm_supplier_running_total(b.deal_id, b.supplier_id) as total) rt
      where b.deal_id = v_deal.id), '[]'::jsonb))
  -- Customer total: flight-only Deals only (absent on package Deals).
  || case when v_fo and v_sell then jsonb_build_object('customerTotalPaise', (
       select coalesce(sum(b.customer_total_paise), 0)::text from public.flight_ticket_batches b where b.deal_id = v_deal.id))
     else '{}'::jsonb end
  -- Supplier totals, approvals and invoices: F, M, A only.
  || case when v_full then jsonb_build_object(
    'supplierTotals', coalesce((
      select jsonb_agg(jsonb_build_object('supplierId', y.supplier_id, 'supplierName', y.name,
               'runningTotalPaise', authz.sm_supplier_running_total(v_deal.id, y.supplier_id)::text) order by lower(y.name), y.supplier_id)
      from (select distinct b.supplier_id, s.name from public.flight_ticket_batches b
            join public.suppliers s on s.id = b.supplier_id where b.deal_id = v_deal.id) y), '[]'::jsonb),
    'approvals', coalesce((
      select jsonb_agg(jsonb_build_object(
        'approvalId', a.id,
        'approvalNo', a.approval_no,
        'status', a.status,
        'batchSupplierCostPaise', a.batch_supplier_cost_paise::text,
        'projectedSupplierCostPaise', a.projected_supplier_cost_paise::text,
        'budgetPaise', a.budget_paise::text,
        'requestedAt', a.requested_at,
        'requestedByName', rp.display_name,
        'decidedAt', a.decided_at,
        'decidedByName', dp.display_name,
        'returnReason', a.return_reason,
        'rowVersion', a.row_version,
        'canDecide', v_m and a.status = 'pending' and a.requested_by <> v_uid and not authz.flight_is_deal_assignee(v_deal.id),
        'canWithdraw', v_fa and a.status = 'pending' and a.requested_by = v_uid) order by a.approval_no desc)
      from public.flight_fare_approvals a
      left join public.staff_profiles rp on rp.user_id = a.requested_by
      left join public.staff_profiles dp on dp.user_id = a.decided_by
      where a.deal_id = v_deal.id), '[]'::jsonb),
    'invoices', coalesce((
      select jsonb_agg(jsonb_build_object(
        'documentId', x.id, 'supplierId', x.supplier_id, 'number', x.number, 'docDate', to_char(x.doc_date, 'YYYY-MM-DD'),
        'totalPaise', x.total_paise::text, 'status', x.status) order by x.uploaded_at, x.id)
      from public.supplier_documents x
      join public.fulfilment_tasks t on t.id = x.task_id
      where t.deal_id = v_deal.id and t.department = 'flight' and x.kind = 'invoice'), '[]'::jsonb),
    'invoiceMissing', coalesce((
      select bool_or(authz.sm_invoice_missing(t.id)) from public.fulfilment_tasks t
      where t.deal_id = v_deal.id and t.department = 'flight'), false)) else '{}'::jsonb end;
end;
$$;

-- R-H2 (Addendum O2): what the Manager approves - the accepted booking and
-- the change version side by side, with selling total and payment plan.
-- Readers: the branch Manager / Approver, Accounts and the Sales owner of the
-- Deal (authz.cr_viewer, which never answers a Purchase / Flight / Visa holder).
create function public.change_request_review(p_change_request_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_r public.booking_change_requests%rowtype;
  v_viewer text;
begin
  if not coalesce(authz.session_ok(), false) then
    return null;
  end if;
  select * into v_r from public.booking_change_requests r where r.id = p_change_request_id;
  if v_r.id is null then
    return null;
  end if;
  v_viewer := authz.cr_viewer(v_r.deal_id);
  if v_viewer is null and not authz.cr_is_approver(v_r.id) then
    return null;
  end if;
  return jsonb_build_object(
    'changeRequestId', v_r.id, 'refNo', v_r.ref_no, 'kind', v_r.kind, 'status', v_r.status, 'rowVersion', v_r.row_version,
    'removalRoute', v_r.removal_route, 'customerChargePaise', v_r.customer_charge_paise::text,
    'base', authz.cr_version_view(v_r.base_version_id),
    'proposed', case when v_r.change_version_id is not null then authz.cr_version_view(v_r.change_version_id) end,
    'changedItemIds', to_jsonb(case when v_r.change_version_id is not null then authz.cr_changed_item_ids(v_r.change_version_id)
                                    else '{}'::uuid[] end),
    'changedFields', to_jsonb(coalesce(v_r.changed_fields, case when v_r.change_version_id is not null
                                        then authz.revision_changed_fields(v_r.change_version_id) end, '{}'::text[])),
    -- The version sent is still the one shown (false = it changed since it was sent).
    'sentVersionCurrent', v_r.submitted_content_hash is not null and v_r.change_version_id is not null
                          and v_r.submitted_content_hash = authz.booking_content_hash(v_r.change_version_id),
    'canDecide', v_r.status = 'requested' and v_r.requested_by <> (select auth.uid()) and authz.cr_is_approver(v_r.id));
end;
$$;

create function authz.cr_version_view(p_version uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'versionId', v.id, 'versionNo', v.version_no, 'status', v.status,
    'tripStart', v.trip_start, 'tripEnd', v.trip_end,
    'sellingTotalPaise', (select c.selling_total_paise::text from public.booking_version_commercials c where c.version_id = v.id),
    'plan', coalesce((select jsonb_agg(jsonb_build_object('seq', p.seq, 'label', p.label, 'amountPaise', p.amount_paise::text,
                        'dueDate', p.due_date) order by p.seq)
                      from public.booking_version_instalments p where p.booking_version_id = v.id), '[]'::jsonb),
    'services', coalesce((select jsonb_agg(jsonb_build_object('itemId', i.id, 'itemNo', i.item_no, 'serviceType', i.service_type,
                            'serviceTitle', coalesce(authz.service_item_title(i.service_type, f.facts), 'Service'),
                            'facts', f.facts, 'budgetPaise', f.purchase_budget_paise::text) order by i.item_no)
                          from public.service_item_facts f join public.service_items i on i.id = f.service_item_id
                          where f.booking_version_id = v.id), '[]'::jsonb))
  from public.booking_versions v where v.id = p_version
$$;

revoke all on function authz.cr_lock_h(uuid), authz.cr_version_view(uuid) from public, anon, authenticated, service_role;
revoke all on function public.change_request_review(uuid) from public, anon, authenticated, service_role;
grant execute on function public.change_request_review(uuid) to authenticated;

commit;
