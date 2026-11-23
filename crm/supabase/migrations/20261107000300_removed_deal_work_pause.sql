-- TripNavigate CRM - Stage 0: a Deal removed by the Bitrix sync pauses new work.
--
-- Owner rule (8 October 2026): source-removed Deals pause new booking,
-- commitment and receipt work. Recorded money, history, reversals and existing
-- cash/cheque settlement stay. Historical approval conflicts survive removal
-- of the current owner or assignment.
--
-- Refused with 'deal_removed' (SQLSTATE 55000) while deals.removed_at is set:
--   booking_open_draft, booking_save_draft, booking_begin_evidence,
--   booking_confirm                       (checked before the role check, for
--                                          signed-in members of the Deal's
--                                          legal entity; others keep not_authorized)
--   purchase_quote_add, purchase_quote_withdraw, purchase_cost_propose,
--   purchase_evidence_begin               (authz.lock_workable_task gate)
--   purchase_cost_approve_over_budget, purchase_supplier_confirm
--   receipt_record                        (after the Accounts check; an exact
--                                          retry of a receipt recorded before
--                                          the removal still replays)
-- Unchanged and still usable: receipt_verify, receipt_reject, receipt_reverse,
-- cheque_clear, cheque_mark, cheque_represent, cash_deposit_record/verify/reject,
-- cash_reconciliation_*, finance evidence finish/remove/download, booking and
-- purchase evidence finish/remove, every read.
--
-- Approval conflicts: authz.finance_deal_conflict also counts the owner and
-- Sales assignees recorded in deal_removal_participants (20261107000100), so a
-- person removed from the Deal by the sync still cannot verify, clear or
-- approve its money.
--
-- Removal race: the booking commands, purchase_supplier_confirm, the purchase
-- work gate (authz.lock_workable_task) and receipt_record take FOR KEY SHARE on
-- the Deal before checking, so they wait for an in-flight removal and a removal
-- waits for them. purchase_cost_approve_over_budget keeps its snapshot check
-- (approval only; no money or supplier commitment).
--
-- Every replaced body is the latest definition copied unchanged except the
-- lines marked "Stage 0". Signatures, grants and return shapes are unchanged.
-- Rollback: forward-only (restore the previous bodies).

begin;

-- Raises deal_removed when p_deal is removed and the caller is a signed-in
-- active member of its legal entity. Otherwise does nothing, so the command's
-- own authorization answers (no removal state leaks to non-members).
-- The KEY SHARE lock waits for an in-flight removal (authz.remove_bitrix_deals
-- holds FOR UPDATE on the Deal) so the check sees its committed result, and it
-- blocks a removal until the command commits. KEY SHARE does not conflict with
-- the FOR NO KEY UPDATE that booking commands take on the same Deal.
create function authz.refuse_removed_deal(p_deal uuid) returns void
language plpgsql volatile security definer set search_path = '' as $$
begin
  perform 1 from public.deals d where d.id = p_deal for key share;
  if exists (
    select 1 from public.deals d
    where d.id = p_deal and d.removed_at is not null
      and coalesce(authz.session_ok(), false) and authz.is_entity_member(d.legal_entity_id)
  ) then
    raise exception 'deal_removed' using errcode = '55000';
  end if;
end;
$$;

revoke all on function authz.refuse_removed_deal(uuid) from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Approval conflicts survive removal (replaces 20261101000100)
-- ---------------------------------------------------------------------------

-- The actor owns the deal, has an active Sales assignment on it, or was its
-- owner or a Sales assignee when the Bitrix sync removed it (Stage 0).
create or replace function authz.finance_deal_conflict(p_deal uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.deals d where d.id = p_deal and d.owner_user_id = (select auth.uid()))
    or exists (
      select 1 from public.deal_assignments a
      where a.deal_id = p_deal and a.user_id = (select auth.uid())
        and a.assignment_kind = 'sales' and a.ended_at is null)
    or exists (
      select 1 from public.deal_removal_participants h
      where h.deal_id = p_deal and h.user_id = (select auth.uid())
        and h.participation in ('owner', 'sales'))
$$;

-- ---------------------------------------------------------------------------
-- Purchase: the procurement gate refuses removed Deals (replaces 20261005000100)
-- ---------------------------------------------------------------------------

-- P4-D7 gate: 'environment_unset', 'deal_removed' (Stage 0), 'procurement_disabled' or null.
create or replace function authz.procurement_gate_issue(p_task uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when authz.deployment_environment() = 'unset' then 'environment_unset'
    -- Stage 0: a Deal removed by the Bitrix sync takes no new purchase work.
    when d.removed_at is not null then 'deal_removed'
    when not d.is_synthetic
      and not coalesce((select s.live_supplier_confirmation_enabled from public.procurement_settings s where s.id), false)
      then 'procurement_disabled'
    when d.is_synthetic and authz.deployment_environment() <> 'test' then 'procurement_disabled'
    else null
  end
  from public.fulfilment_tasks t join public.deals d on d.id = t.deal_id
  where t.id = p_task
$$;

-- Supplier confirmation (replaces 20261006000101): names the removal instead of not_ready.
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

-- ---------------------------------------------------------------------------
-- Booking (replaces 20261004000100)
-- ---------------------------------------------------------------------------

create or replace function public.booking_open_draft(p_deal_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_ver public.booking_versions%rowtype;
begin
  -- Stage 0: a Deal removed by the Bitrix sync takes no new booking work.
  perform authz.refuse_removed_deal(p_deal_id);
  if p_deal_id is null or not authz.can_edit_booking_draft(p_deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if authz.deployment_environment() = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  -- Serializes concurrent opens for one deal.
  select * into v_deal from public.deals d where d.id = p_deal_id for no key update;
  if exists (select 1 from public.booking_versions v where v.deal_id = p_deal_id and v.status = 'confirmed') then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  select * into v_ver from public.booking_versions v where v.deal_id = p_deal_id and v.status = 'draft';
  if v_ver.id is not null then
    return jsonb_build_object('versionId', v_ver.id, 'versionNo', v_ver.version_no,
      'rowVersion', v_ver.row_version, 'created', false);
  end if;

  insert into public.booking_versions (deal_id, legal_entity_id, branch_id, version_no, created_by)
  values (v_deal.id, v_deal.legal_entity_id, v_deal.branch_id,
    coalesce((select max(v.version_no) from public.booking_versions v where v.deal_id = v_deal.id), 0) + 1,
    (select auth.uid()))
  returning * into v_ver;

  perform authz.write_audit('booking.draft_opened', v_deal.legal_entity_id, v_deal.branch_id,
    'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_deal.id, 'versionNo', v_ver.version_no));
  return jsonb_build_object('versionId', v_ver.id, 'versionNo', v_ver.version_no,
    'rowVersion', v_ver.row_version, 'created', true);
end;
$$;

create or replace function public.booking_save_draft(
  p_version_id uuid, p_expected_row_version integer, p_facts jsonb, p_selling_total_paise bigint,
  p_selling_total_provided boolean
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_keys constant text[] := array['hotelName', 'city', 'checkIn', 'checkOut', 'rooms', 'roomType', 'mealPlan',
    'adults', 'children', 'inclusions', 'specialRequests', 'purchaseBudgetPaise'];
  v_hotel text; v_city text; v_in date; v_out date; v_rooms integer; v_room_type text; v_meal text;
  v_adults integer; v_children integer; v_incl text; v_req text; v_budget bigint;
begin
  select * into v_ver from public.booking_versions v where v.id = p_version_id for update;
  -- Stage 0: a Deal removed by the Bitrix sync takes no new booking work.
  perform authz.refuse_removed_deal(v_ver.deal_id);
  if v_ver.id is null or not authz.can_edit_booking_draft(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ver.status = 'confirmed' then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  if p_expected_row_version is null or p_expected_row_version <> v_ver.row_version then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  if p_facts is null or jsonb_typeof(p_facts) <> 'object'
     or exists (select 1 from jsonb_object_keys(p_facts) k where k <> all (v_keys))
     or exists (select 1 from unnest(v_keys) k where not (p_facts ? k)) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  if p_selling_total_provided is null
     or (p_selling_total_provided and p_selling_total_paise is not null and p_selling_total_paise < 0) then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  -- A4 M3: only a caller who may read the commercial value may send it.
  if p_selling_total_provided and not authz.can_read_deal_commercial(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;

  v_hotel := authz.booking_fact_text(p_facts, 'hotelName', 200, false);
  v_city := authz.booking_fact_text(p_facts, 'city', 120, false);
  v_in := authz.booking_fact_date(p_facts, 'checkIn');
  v_out := authz.booking_fact_date(p_facts, 'checkOut');
  v_rooms := authz.booking_fact_int(p_facts, 'rooms', 1, 50);
  v_room_type := authz.booking_fact_text(p_facts, 'roomType', 120, false);
  v_meal := authz.booking_fact_text(p_facts, 'mealPlan', 60, false);
  v_adults := authz.booking_fact_int(p_facts, 'adults', 1, 100);
  v_children := authz.booking_fact_int(p_facts, 'children', 0, 100);
  v_incl := authz.booking_fact_text(p_facts, 'inclusions', 2000, true);
  v_req := authz.booking_fact_text(p_facts, 'specialRequests', 2000, true);
  v_budget := authz.booking_fact_paise(p_facts, 'purchaseBudgetPaise');

  -- A4 M3 (supersedes A1): not provided -> the commercial row is untouched;
  -- provided -> null clears, a value sets (authorization checked above).
  if p_selling_total_provided then
    if p_selling_total_paise is null then
      delete from public.booking_version_commercials c where c.version_id = v_ver.id;
    else
      insert into public.booking_version_commercials (version_id, legal_entity_id, selling_total_paise)
      values (v_ver.id, v_ver.legal_entity_id, p_selling_total_paise)
      on conflict (version_id) do update
        set selling_total_paise = excluded.selling_total_paise, updated_at = now();
    end if;
  end if;

  update public.booking_versions v
  set hotel_name = v_hotel, city = v_city, check_in = v_in, check_out = v_out, rooms = v_rooms,
      room_type = v_room_type, meal_plan = v_meal, adults = v_adults, children = v_children,
      inclusions = v_incl, special_requests = v_req, purchase_budget_paise = v_budget,
      row_version = v.row_version + 1, updated_at = now()
  where v.id = v_ver.id
  returning * into v_ver;

  -- No amounts or customer content in the audit record.
  perform authz.write_audit('booking.draft_saved', v_ver.legal_entity_id, v_ver.branch_id,
    'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'rowVersion', v_ver.row_version));
  return jsonb_build_object('versionId', v_ver.id, 'rowVersion', v_ver.row_version, 'contentHash', v_ver.content_hash);
end;
$$;

create or replace function public.booking_begin_evidence(
  p_version_id uuid, p_kind text, p_file_name text, p_mime text, p_size_bytes integer, p_sha256 text
) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_name text;
  v_sha text := lower(btrim(coalesce(p_sha256, '')));
  v_max integer;
  v_id uuid := gen_random_uuid();
  v_path text;
begin
  select * into v_ver from public.booking_versions v where v.id = p_version_id for update;
  -- Stage 0: a Deal removed by the Bitrix sync takes no new booking work.
  perform authz.refuse_removed_deal(v_ver.deal_id);
  if v_ver.id is null or not authz.can_edit_booking_draft(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_ver.status = 'confirmed' then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  if p_kind is null or p_kind not in ('acceptance_message', 'ticket', 'bill', 'payment_proof', 'other') then
    raise exception 'invalid_input' using errcode = '22023';
  end if;
  v_name := btrim(left(btrim(regexp_replace(coalesce(p_file_name, ''), '[^A-Za-z0-9._ -]', '_', 'g')), 120));
  select s.evidence_max_bytes into v_max from public.booking_settings s where s.id;
  if v_name = '' or v_name ~ '^[. ]+$'
     or p_mime is null or p_mime not in ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
     or p_size_bytes is null or p_size_bytes < 1 or p_size_bytes > coalesce(v_max, 0)
     or v_sha !~ '^[0-9a-f]{64}$' then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;
  if (select count(*) from public.booking_evidence e where e.version_id = v_ver.id and e.status <> 'removed') >= 10 then
    raise exception 'evidence_rejected' using errcode = '22023';
  end if;

  v_path := v_ver.legal_entity_id::text || '/' || v_ver.deal_id::text || '/' || v_ver.id::text || '/' || v_id::text;
  insert into public.booking_evidence
    (id, version_id, deal_id, legal_entity_id, kind, object_path, file_name, mime, size_bytes, sha256, uploaded_by)
  values (v_id, v_ver.id, v_ver.deal_id, v_ver.legal_entity_id, p_kind, v_path, v_name, p_mime, p_size_bytes,
    v_sha, (select auth.uid()));

  perform authz.write_audit('booking.evidence_started', v_ver.legal_entity_id, v_ver.branch_id,
    'booking_evidence', v_id, null,
    jsonb_build_object('versionId', v_ver.id, 'kind', p_kind, 'mime', p_mime, 'sizeBytes', p_size_bytes));
  return jsonb_build_object('evidenceId', v_id, 'objectPath', v_path);
end;
$$;

create or replace function public.booking_confirm(p_version_id uuid, p_expected_content_hash text) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_ver public.booking_versions%rowtype;
  v_deal public.deals%rowtype;
  v_task uuid;
  v_task_version uuid;
  v_key text;
  v_env text;
begin
  -- 1. Row lock: a concurrent confirmation waits here, then sees 'confirmed'.
  select * into v_ver from public.booking_versions v where v.id = p_version_id for update;
  -- Stage 0: a Deal removed by the Bitrix sync takes no new booking work.
  perform authz.refuse_removed_deal(v_ver.deal_id);
  -- 2. Existence is not revealed.
  if v_ver.id is null or not authz.can_confirm_booking(v_ver.deal_id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- 3. Repeat / concurrent confirmation.
  if v_ver.status = 'confirmed' then
    select t.id into v_task from public.fulfilment_tasks t
    where t.booking_version_id = v_ver.id and t.service_purpose = 'hotel';
    if v_task is not null then
      return jsonb_build_object('outcome', 'existing', 'taskId', v_task, 'versionId', v_ver.id);
    end if;
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  -- 4. Optimistic check against the live hash.
  if p_expected_content_hash is null or p_expected_content_hash <> authz.booking_content_hash(v_ver.id) then
    raise exception 'version_changed' using errcode = '40001';
  end if;
  -- 5. Gate.
  select * into v_deal from public.deals d where d.id = v_ver.deal_id;
  v_env := authz.deployment_environment();
  if v_env = 'unset' then
    raise exception 'environment_unset' using errcode = '55000';
  end if;
  if not v_deal.is_synthetic
     and not coalesce((select s.real_booking_enabled from public.booking_settings s where s.id), false) then
    raise exception 'booking_disabled' using errcode = '55000';
  end if;
  if v_deal.is_synthetic and v_env <> 'test' then
    raise exception 'booking_disabled' using errcode = '55000';
  end if;
  -- 6. Readiness.
  if cardinality(authz.booking_issues(v_ver.id)) > 0 then
    raise exception 'not_ready' using errcode = '55000';
  end if;
  -- 7. Freeze.
  update public.booking_versions v
  set status = 'confirmed', confirmed_by = (select auth.uid()), confirmed_at = now(),
      confirmed_deal_source_modified_at = v_deal.source_modified_at, updated_at = now()
  where v.id = v_ver.id
  returning * into v_ver;
  -- 8. Exactly one task per version.
  v_key := 'booking:' || v_ver.id::text || ':hotel';
  insert into public.fulfilment_tasks
    (deal_id, legal_entity_id, branch_id, booking_version_id, service_purpose, task_key, created_by)
  values (v_ver.deal_id, v_ver.legal_entity_id, v_ver.branch_id, v_ver.id, 'hotel', v_key, (select auth.uid()))
  on conflict (task_key) do nothing
  returning id into v_task;
  if v_task is null then
    select t.id, t.booking_version_id into v_task, v_task_version
    from public.fulfilment_tasks t where t.task_key = v_key;
    if v_task_version is distinct from v_ver.id then
      raise exception 'task_conflict' using errcode = '40001';
    end if;
  end if;
  -- 9. Outbox (ids only).
  insert into public.outbox_events (legal_entity_id, aggregate_type, aggregate_id, event_type, payload)
  values
    (v_ver.legal_entity_id, 'booking_version', v_ver.id, 'booking.version_confirmed',
     jsonb_build_object('version_id', v_ver.id, 'deal_id', v_ver.deal_id, 'task_id', v_task,
       'version_no', v_ver.version_no, 'service_purpose', 'hotel')),
    (v_ver.legal_entity_id, 'fulfilment_task', v_task, 'fulfilment.task_created',
     jsonb_build_object('task_id', v_task, 'version_id', v_ver.id, 'deal_id', v_ver.deal_id,
       'version_no', v_ver.version_no, 'service_purpose', 'hotel'))
  on conflict (event_type, aggregate_id) do nothing;
  -- 10. Audit: ids and version_no only.
  perform authz.write_audit('booking.version_confirmed', v_ver.legal_entity_id, v_ver.branch_id,
    'booking_version', v_ver.id, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionNo', v_ver.version_no, 'taskId', v_task));
  perform authz.write_audit('fulfilment.task_created', v_ver.legal_entity_id, v_ver.branch_id,
    'fulfilment_task', v_task, null,
    jsonb_build_object('dealId', v_ver.deal_id, 'versionId', v_ver.id, 'versionNo', v_ver.version_no));
  -- 11.
  return jsonb_build_object('outcome', 'created', 'taskId', v_task, 'versionId', v_ver.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- Receipts (replaces 20261101000100)
-- ---------------------------------------------------------------------------

create or replace function public.receipt_record(p_deal_id uuid, p_fields jsonb, p_request_id uuid) returns jsonb
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_entity uuid;
  v_payload jsonb := jsonb_build_object('dealId', p_deal_id, 'fields', p_fields);
  v_result jsonb;
  v_t timestamptz := now();
  v_today date := authz.finance_today();
  v_policy public.finance_policy_versions%rowtype;
  v_mode text;
  v_amount_text text;
  v_amount bigint;
  v_received date;
  v_branch uuid;
  v_collector uuid;
  v_payer text;
  v_pan text;
  v_mobile text;
  v_reference text;
  v_norm text;
  v_micr text;
  v_cheque_no text;
  v_cheque_date date;
  v_payee jsonb;
  v_booking uuid;
  v_corrects uuid;
  v_note text;
  v_orig public.customer_receipts%rowtype;
  v_id uuid := gen_random_uuid();
  v_keys text[] := '{}';
  v_hash bigint;
  v_sum bigint;
  v_fy text;
  v_seq integer;
  v_no text;
begin
  select * into v_deal from public.deals d where d.id = p_deal_id;
  perform authz.finance_require_accounts(v_deal.legal_entity_id, v_deal.is_synthetic);
  v_entity := v_deal.legal_entity_id;
  if p_request_id is null then
    perform authz.finance_invalid();
  end if;
  perform authz.finance_lock_policy(v_entity, false);   -- lock 1
  perform authz.finance_lock_deal(v_deal.id);           -- lock 2
  v_result := authz.finance_replay(v_entity, p_request_id, 'receipt_record', v_payload);
  if v_result is not null then
    return v_result;
  end if;
  -- Stage 0: a Deal removed by the Bitrix sync takes no new receipt (an exact
  -- retry of a receipt recorded before the removal replays above). The KEY
  -- SHARE lock waits for an in-flight removal, which holds FOR UPDATE on the Deal.
  perform 1 from public.deals d where d.id = v_deal.id for key share;
  if exists (select 1 from public.deals d where d.id = v_deal.id and d.removed_at is not null) then
    raise exception 'deal_removed' using errcode = '55000';
  end if;

  if p_fields is null or jsonb_typeof(p_fields) <> 'object'
     or (p_fields - array['mode', 'amountPaise', 'receivedOn', 'branchId', 'collectorUserId', 'payerName', 'payerPan',
                          'payerMobile', 'reference', 'micrCode', 'chequeNumber', 'chequeDate', 'accountPayee',
                          'bookingVersionId', 'correctsReceiptId', 'note']) <> '{}'::jsonb then
    perform authz.finance_invalid();
  end if;
  v_mode := authz.finance_field(p_fields, 'mode');
  if v_mode is null or v_mode not in ('bank_transfer', 'upi', 'cash', 'cheque') then
    perform authz.finance_invalid();
  end if;
  if not authz.finance_mode_allowed(v_entity, v_mode) then
    raise exception 'mode_not_live' using errcode = '55000';
  end if;

  -- The policy is read once: this version and v_t for every check.
  v_policy := authz.finance_policy_at(v_entity, v_t);
  if v_policy.id is null then
    raise exception 'not_configured' using errcode = '55000';
  end if;

  v_amount_text := authz.finance_field(p_fields, 'amountPaise');
  if v_amount_text is null or v_amount_text !~ '^[1-9][0-9]{0,17}$' then
    perform authz.finance_invalid();
  end if;
  v_amount := v_amount_text::bigint;
  if v_amount > v_policy.receipt_max_paise then
    perform authz.finance_invalid();
  end if;

  v_received := authz.finance_date(authz.finance_field(p_fields, 'receivedOn'));
  if v_received is null or v_received not between v_today - 30 and v_today then
    perform authz.finance_invalid();
  end if;

  v_branch := authz.finance_uuid(authz.finance_field(p_fields, 'branchId'));
  if v_branch is null or not exists (
       select 1 from public.branches b where b.id = v_branch and b.legal_entity_id = v_entity and b.status = 'enabled') then
    perform authz.finance_invalid();
  end if;

  v_collector := authz.finance_uuid(authz.finance_field(p_fields, 'collectorUserId'));
  if v_mode = 'cash' then
    if v_collector is null or not exists (
         select 1 from public.staff_profiles p
         join public.memberships m on m.user_id = p.user_id
         where p.user_id = v_collector and p.status = 'active' and m.status = 'active' and m.legal_entity_id = v_entity) then
      perform authz.finance_invalid();
    end if;
  elsif v_collector is not null then
    perform authz.finance_invalid();
  end if;

  v_payer := authz.finance_text(authz.finance_field(p_fields, 'payerName'), 1, 200, false);
  v_pan := upper(authz.finance_text(authz.finance_field(p_fields, 'payerPan'), 1, 10, false));
  v_mobile := authz.finance_mobile(authz.finance_field(p_fields, 'payerMobile'));
  if v_payer is null or (v_pan is not null and v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$') or (v_pan is null and v_mobile is null) then
    perform authz.finance_invalid();
  end if;

  v_reference := authz.finance_text(authz.finance_field(p_fields, 'reference'), 1, 40, false);
  if v_mode in ('bank_transfer', 'upi') then
    if v_reference is null or v_reference !~ '^[A-Za-z0-9/-]{6,40}$' then
      perform authz.finance_invalid();
    end if;
    v_norm := upper(replace(replace(v_reference, ' ', ''), '-', ''));
  elsif v_reference is not null then
    perform authz.finance_invalid();
  end if;

  v_micr := authz.finance_text(authz.finance_field(p_fields, 'micrCode'), 1, 9, false);
  v_cheque_no := authz.finance_text(authz.finance_field(p_fields, 'chequeNumber'), 1, 6, false);
  v_cheque_date := authz.finance_date(authz.finance_field(p_fields, 'chequeDate'));
  v_payee := p_fields -> 'accountPayee';
  if v_payee is not null and jsonb_typeof(v_payee) = 'null' then
    v_payee := null;
  end if;
  if v_mode = 'cheque' then
    if v_micr is null or v_micr !~ '^[0-9]{9}$' or v_cheque_no is null or v_cheque_no !~ '^[0-9]{6}$'
       or v_cheque_date is null or v_cheque_date not between v_today - 90 and v_today + 90
       or v_payee is distinct from 'true'::jsonb then
      perform authz.finance_invalid();
    end if;
  elsif v_micr is not null or v_cheque_no is not null or v_cheque_date is not null or v_payee is not null then
    perform authz.finance_invalid();
  end if;

  v_booking := authz.finance_uuid(authz.finance_field(p_fields, 'bookingVersionId'));
  if v_booking is not null and not exists (
       select 1 from public.booking_versions v where v.id = v_booking and v.deal_id = v_deal.id and v.status = 'confirmed') then
    perform authz.finance_invalid();
  end if;
  v_corrects := authz.finance_uuid(authz.finance_field(p_fields, 'correctsReceiptId'));
  v_note := authz.finance_text(authz.finance_field(p_fields, 'note'), 1, 500, true);

  -- Lock 3: the receipt being corrected. Its link is set first so the
  -- correction may reuse the genuine reference and the caps exclude it.
  if v_corrects is not null then
    select * into v_orig from public.customer_receipts r where r.id = v_corrects for update;
    if v_orig.id is null or v_orig.deal_id <> v_deal.id or v_orig.mode <> v_mode then
      perform authz.finance_invalid();
    end if;
    if v_orig.corrected_by_receipt_id is not null
       or not ((v_orig.status = 'rejected' and v_orig.rejection_kind = 'data_error')
               or (v_orig.status = 'reversed' and v_orig.reversal_kind = 'data_error')) then
      raise exception 'wrong_state' using errcode = '55000';
    end if;
    update public.customer_receipts r set corrected_by_receipt_id = v_id, updated_at = now() where r.id = v_orig.id;
  end if;

  -- Lock 5: cash caps (contract 9.2). Counted cash: recorded, verified,
  -- reversed or rejected, except not_received outcomes and receipts
  -- superseded by a correction (a correction can never be not_received, so
  -- the end of a correction chain always counts and the cash counts once).
  if v_mode = 'cash' then
    if v_pan is not null then
      v_keys := v_keys || ('cash-payer|' || v_entity::text || '|pan:' || v_pan || '|' || to_char(v_received, 'YYYY-MM-DD'));
    end if;
    if v_mobile is not null then
      v_keys := v_keys || ('cash-payer|' || v_entity::text || '|mobile:' || v_mobile || '|' || to_char(v_received, 'YYYY-MM-DD'));
    end if;
    v_keys := v_keys || ('cash-trip|' || v_entity::text || '|' || v_deal.id::text);
    for v_hash in select distinct hashtextextended(k, 0) from unnest(v_keys) as k order by 1 loop
      perform pg_advisory_xact_lock(v_hash);
    end loop;

    if v_pan is not null then
      select coalesce(sum(r.amount_paise), 0) into v_sum from public.customer_receipts r
      where r.legal_entity_id = v_entity and r.mode = 'cash' and r.received_on = v_received and r.payer_pan = v_pan
        and r.status in ('recorded', 'verified', 'reversed', 'rejected')
        and not (r.status = 'rejected' and r.rejection_kind = 'not_received')
        and not (r.status = 'reversed' and r.reversal_kind = 'not_received')
        and r.corrected_by_receipt_id is null;
      if v_sum + v_amount > v_policy.cash_payer_day_cap_paise then
        raise exception 'cash_cap_exceeded' using errcode = '55000', detail = 'payer_day';
      end if;
    end if;
    if v_mobile is not null then
      select coalesce(sum(r.amount_paise), 0) into v_sum from public.customer_receipts r
      where r.legal_entity_id = v_entity and r.mode = 'cash' and r.received_on = v_received and r.payer_mobile = v_mobile
        and r.status in ('recorded', 'verified', 'reversed', 'rejected')
        and not (r.status = 'rejected' and r.rejection_kind = 'not_received')
        and not (r.status = 'reversed' and r.reversal_kind = 'not_received')
        and r.corrected_by_receipt_id is null;
      if v_sum + v_amount > v_policy.cash_payer_day_cap_paise then
        raise exception 'cash_cap_exceeded' using errcode = '55000', detail = 'payer_day';
      end if;
    end if;
    select coalesce(sum(r.amount_paise), 0) into v_sum from public.customer_receipts r
    where r.deal_id = v_deal.id and r.mode = 'cash'
      and r.status in ('recorded', 'verified', 'reversed', 'rejected')
      and not (r.status = 'rejected' and r.rejection_kind = 'not_received')
      and not (r.status = 'reversed' and r.reversal_kind = 'not_received')
      and r.corrected_by_receipt_id is null;
    if v_sum + v_amount > v_policy.cash_trip_cap_paise then
      raise exception 'cash_cap_exceeded' using errcode = '55000', detail = 'trip';
    end if;
  end if;

  -- Duplicate references (the unique indexes also refuse concurrent races).
  if v_mode in ('bank_transfer', 'upi') and exists (
       select 1 from public.customer_receipts r
       where r.legal_entity_id = v_entity and r.mode in ('bank_transfer', 'upi') and r.reference_norm = v_norm
         and r.corrected_by_receipt_id is null) then
    raise exception 'duplicate_reference' using errcode = '23505';
  end if;
  if v_mode = 'cheque' and exists (
       select 1 from public.customer_receipts r
       where r.legal_entity_id = v_entity and r.mode = 'cheque' and r.micr_code = v_micr and r.cheque_number = v_cheque_no
         and r.corrected_by_receipt_id is null) then
    raise exception 'duplicate_reference' using errcode = '23505';
  end if;

  -- Lock 6: the receipt counter of the recording date's fiscal year (IST).
  v_fy := authz.finance_fiscal_year(v_today);
  insert into public.finance_receipt_counters (legal_entity_id, fiscal_year) values (v_entity, v_fy) on conflict do nothing;
  update public.finance_receipt_counters c set last_no = c.last_no + 1
  where c.legal_entity_id = v_entity and c.fiscal_year = v_fy
  returning c.last_no into v_seq;
  v_no := 'R-' || v_fy || '-' || lpad(v_seq::text, 6, '0');

  begin
    insert into public.customer_receipts (id, legal_entity_id, deal_id, branch_id, receipt_no, fiscal_year, mode, status,
      amount_paise, received_on, collector_user_id, payer_name, payer_pan, payer_mobile, reference, reference_norm,
      micr_code, cheque_number, cheque_date, account_payee, booking_version_id, corrects_receipt_id, note,
      policy_version_id, request_id, recorded_by, recorded_at)
    values (v_id, v_entity, v_deal.id, v_branch, v_no, v_fy, v_mode, 'recorded',
      v_amount, v_received, v_collector, v_payer, v_pan, v_mobile, v_reference, v_norm,
      v_micr, v_cheque_no, v_cheque_date, case when v_mode = 'cheque' then true end, v_booking, v_corrects, v_note,
      v_policy.id, p_request_id, (select auth.uid()), v_t);
  exception when unique_violation then
    raise exception 'duplicate_reference' using errcode = '23505';
  end;

  v_result := jsonb_build_object('outcome', 'created', 'id', v_id, 'receiptNo', v_no, 'status', 'recorded');
  perform authz.finance_remember(v_entity, p_request_id, 'receipt_record', v_payload, v_result);
  perform authz.write_audit('finance.receipt_recorded', v_entity, v_branch, 'customer_receipt', v_id, null,
    jsonb_build_object('dealId', v_deal.id, 'receiptNo', v_no, 'mode', v_mode, 'policyVersionNo', v_policy.version_no,
      'correctsReceiptId', v_corrects));
  return v_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Purchase work gate waits for an in-flight removal (replaces 20261005000100)
-- ---------------------------------------------------------------------------

create or replace function authz.lock_workable_task(p_task uuid) returns public.fulfilment_tasks
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_gate text;
begin
  select * into v_task from public.fulfilment_tasks t where t.id = p_task for update;
  if v_task.id is null or not authz.can_work_purchase_task(v_task.id) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if v_task.status = 'supplier_confirmed' then
    raise exception 'already_confirmed' using errcode = '55000';
  end if;
  -- Stage 0: wait for an in-flight removal of the Deal (it holds FOR UPDATE)
  -- so the gate below reads its committed result.
  perform 1 from public.deals d where d.id = v_task.deal_id for key share;
  v_gate := authz.procurement_gate_issue(v_task.id);
  if v_gate is not null then
    raise exception '%', v_gate using errcode = '55000';
  end if;
  return v_task;
end;
$$;
revoke all on function authz.lock_workable_task(uuid) from public, anon, authenticated;

commit;
