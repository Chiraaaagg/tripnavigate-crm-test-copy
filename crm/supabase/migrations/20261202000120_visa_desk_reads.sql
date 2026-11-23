-- TripNavigate CRM - Visa and Passport desk build, track A (3 of 3): reads.
--
-- Contract: implementation/visa-build-2026-11-07/contract.md (frozen 8 Nov
-- 2026), sections 8 (status words, steps, Home rows) and 9.1-9.4.
--
-- What changes:
--   * New reads: visa_queue() (Visa desk: every visa task of the entity;
--     branch Manager: branch Deals, read only), visa_workspace(task),
--     deal_visa_summary(deal), deal_visa_history(deal), visa_home_counts().
--   * department_task_history (replaces 20261201000120): visa kinds for visa
--     tasks (applicantSeq, clubSize, method); the branch Manager reads visa
--     History through can_read_visa_task (0110).
--   * authz.finance_expense_item_json (replaces 20261119000500): applicantName
--     of visa fees linked to a passenger (Accounts sees nothing else).
--
-- Every read returns null (or raises not_authorized without a valid
-- session) when the caller may not read it, never a partial object. Money
-- fence: no selling price, list price, discount, margin, plan, customer
-- receipts or payment evidence, Deal contacts, billing or bank values in any
-- visa read. Passport numbers only for the task's assignee. E-visa recipient
-- e-mail only in visa_workspace (Visa desk and branch Manager).
--
-- Refusal tokens: 42501 not_authorized (no valid session).
--
-- Rollback (forward-only): a new migration revoking the new reads and
-- restoring department_task_history (20261201000120) and
-- finance_expense_item_json (20261119000500).

begin;
set local lock_timeout = '15s';

-- ===========================================================================
-- 1. Shared helpers
-- ===========================================================================

create function authz.visa_task_title(p_task uuid) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(nullif(authz.service_item_title(i.service_type, authz.visa_task_facts(t.id)), ''),
                  initcap(i.service_type) || ' ' || i.item_no::text)
  from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
  where t.id = p_task
$$;

-- "France · Tourism · Sticker visa · travel 6 Feb 27" / "Fresh passport · Jodhpur".
create function authz.visa_facts_line(p_type text, p_facts jsonb) returns text
language plpgsql stable set search_path = '' as $$
declare
  v_date date;
begin
  if p_type = 'passport' then
    return nullif(concat_ws(' · ',
      case p_facts ->> 'applicationType' when 'fresh' then 'Fresh passport' when 'renewal' then 'Passport renewal'
        when 'tatkaal' then 'Tatkaal passport' when 'minor' then 'Minor passport' end,
      nullif(btrim(coalesce(p_facts ->> 'officeCity', '')), '')), '');
  end if;
  v_date := authz.sf_date(p_facts -> 'travelDate');
  return nullif(concat_ws(' · ', nullif(btrim(coalesce(p_facts ->> 'country', '')), ''),
    nullif(btrim(coalesce(p_facts ->> 'purpose', '')), ''),
    case authz.visa_sales_kind(p_facts) when 'e_visa' then 'E-visa' when 'sticker' then 'Sticker visa' end,
    case when v_date is not null then 'travel ' || to_char(v_date, 'FMDD Mon YY') end), '');
end;
$$;

-- Counted applications (section 8): current, except removed ones not applied.
-- Steps, status words and counts of one task.
create function authz.visa_task_progress(p_task uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with t as (select x.* from public.fulfilment_tasks x where x.id = p_task),
  f as (select authz.visa_task_facts(p_task) as facts),
  c as (
    select count(*)::integer as n,
      (count(*) filter (where a.closed_at is not null or a.state <> 'docs_pending'
                          or cardinality(authz.visa_not_ready(a, f.facts)) = 0))::integer as ready_met,
      (count(*) filter (where a.closed_at is not null or a.state <> 'docs_pending'))::integer as applied_met,
      (count(*) filter (where a.state in ('issued', 'refused', 'withdrawn')))::integer as decided,
      (count(*) filter (where a.closed_at is not null))::integer as closed,
      (count(*) filter (where a.state = 'docs_pending' and a.closed_at is null
                          and cardinality(authz.visa_not_ready(a, f.facts)) = 0))::integer as ready_now,
      (count(*) filter (where a.submitted_at is not null or a.applied_on is not null))::integer as applied
    from public.visa_applications a cross join f
    where a.task_id = p_task and a.superseded_at is null and not (a.removed_at is not null and a.state = 'docs_pending')
  ),
  s as (
    select t.status, t.assignee_user_id is not null as taken, c.*,
      t.assignee_user_id is not null as take_done,
      t.assignee_user_id is not null and c.n > 0 and c.ready_met = c.n as ready_done,
      t.assignee_user_id is not null and c.n > 0 and c.ready_met = c.n and c.applied_met = c.n as applied_done,
      t.assignee_user_id is not null and c.n > 0 and c.ready_met = c.n and c.applied_met = c.n and c.decided = c.n as decision_done,
      t.assignee_user_id is not null and c.n > 0 and c.ready_met = c.n and c.applied_met = c.n and c.decided = c.n
        and c.closed = c.n as handover_done
    from t cross join c
  )
  select jsonb_build_object(
    'steps', jsonb_build_array(
      jsonb_build_object('key', 'take', 'label', 'Task taken', 'met', case when s.taken then 1 else 0 end, 'of', 1, 'done', s.take_done),
      jsonb_build_object('key', 'ready', 'label', 'Documents and date', 'met', s.ready_met, 'of', s.n, 'done', s.ready_done),
      jsonb_build_object('key', 'applied', 'label', 'Applied', 'met', s.applied_met, 'of', s.n, 'done', s.applied_done),
      jsonb_build_object('key', 'decision', 'label', 'Decision', 'met', s.decided, 'of', s.n, 'done', s.decision_done),
      jsonb_build_object('key', 'handover', 'label', 'Handover', 'met', s.closed, 'of', s.n, 'done', s.handover_done)),
    'status', case
      when s.status = 'completed' then jsonb_build_object('code', 'completed', 'step', null, 'text', 'Completed')
      when s.status = 'not_started' then jsonb_build_object('code', 'not_taken', 'step', null, 'text', 'Not taken')
      when not s.ready_done then jsonb_build_object('code', 'in_progress', 'step', 'ready', 'text', 'Documents and date pending')
      when not s.applied_done then jsonb_build_object('code', 'in_progress', 'step', 'applied', 'text', 'Not applied yet')
      when not s.decision_done then jsonb_build_object('code', 'in_progress', 'step', 'decision', 'text', 'Waiting for decision')
      when not s.handover_done then jsonb_build_object('code', 'in_progress', 'step', 'handover', 'text', 'Handover pending')
      else jsonb_build_object('code', 'in_progress', 'step', null, 'text', 'In progress') end,
    'applicantCount', s.n, 'readyCount', s.ready_now, 'appliedCount', s.applied, 'decidedCount', s.decided,
    'closedCount', s.closed)
  from s
$$;

-- Travellers added by a revision after the task completed (VL12).
create function authz.visa_added_after_completion(p_task uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select case when t.status <> 'completed' then 0 else (
    select count(*)::integer from unnest(authz.item_participant_seqs(t.service_item_id, authz.task_current_version(t.id))) s
    where not exists (select 1 from public.visa_applications a
                      where a.task_id = t.id and a.traveller_seq = s and a.superseded_at is null)) end
  from public.fulfilment_tasks t where t.id = p_task
$$;

-- Staff name shown on a visa task: the assignee only (department_task_history rule).
create function authz.visa_staff_name(p_task uuid, p_user uuid) returns text
language sql stable security definer set search_path = '' as $$
  select s.display_name from public.fulfilment_tasks t join public.staff_profiles s on s.user_id = t.assignee_user_id
  where t.id = p_task and p_user is not null and t.assignee_user_id = p_user
$$;

-- Plain label of a revision field of the task's item.
create function authz.visa_field_label(p_key text) returns text
language sql immutable set search_path = '' as $$
  select case p_key
    when 'country' then 'Country' when 'purpose' then 'Purpose' when 'travelDate' then 'Travel date'
    when 'applyBy' then 'Apply by' when 'feePaidBy' then 'Government fee paid by' when 'notes' then 'Notes'
    when 'visaKind' then 'E-visa or sticker visa' when 'jurisdiction' then 'Jurisdiction passport'
    when 'jurisdictionPlace' then 'Jurisdiction place' when 'documentsNeeded' then 'Documents needed'
    when 'applicationType' then 'Application type' when 'officeCity' then 'Passport office city'
    when 'neededBy' then 'Needed by' when 'participation' then 'Passengers on this service'
    when 'travellers' then 'Passenger names'
    else initcap(regexp_replace(p_key, '([a-z])([A-Z])', '\1 \2', 'g')) end
$$;

-- Applicant name in a version (fallback: the application's snapshot).
create function authz.visa_name_in(p_version uuid, p_task uuid, p_seq integer) returns text
language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select s.full_name from public.booking_version_travellers s where s.booking_version_id = p_version and s.seq = p_seq),
    (select a.traveller_name_snapshot from public.visa_applications a
     where a.task_id = p_task and a.traveller_seq = p_seq order by a.superseded_at is null desc, a.created_at desc limit 1))
$$;

-- "Booking version N changed this task" from the latest visa.booking_synced audit.
create function authz.visa_booking_change_json(p_task uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  with e as (
    select a.occurred_at, a.details from public.audit_events a
    where a.target_type = 'fulfilment_task' and a.target_id = p_task and a.action = 'visa.booking_synced'
    order by a.occurred_at desc, a.id desc limit 1
  ), v as (
    select x.id, x.version_no, x.revises_version_id from public.booking_versions x join e on x.id = (e.details ->> 'versionId')::uuid
  ), i as (
    select si.item_no from public.fulfilment_tasks t join public.service_items si on si.id = t.service_item_id where t.id = p_task
  )
  select jsonb_build_object(
    'versionNo', v.version_no, 'at', e.occurred_at,
    'added', (select coalesce(jsonb_agg(jsonb_build_object('seq', q.s, 'name', authz.visa_name_in(v.id, p_task, q.s)) order by q.s), '[]'::jsonb)
              from jsonb_array_elements_text(coalesce(e.details -> 'addedSeqs', '[]'::jsonb)) as q0 (v) cross join lateral (select q0.v::integer as s) q),
    'removed', (select coalesce(jsonb_agg(jsonb_build_object('seq', q.s, 'name', authz.visa_name_in(v.revises_version_id, p_task, q.s)) order by q.s), '[]'::jsonb)
                from jsonb_array_elements_text(coalesce(e.details -> 'removedSeqs', '[]'::jsonb)) as q0 (v) cross join lateral (select q0.v::integer as s) q),
    'back', (select coalesce(jsonb_agg(jsonb_build_object('seq', q.s, 'name', authz.visa_name_in(v.id, p_task, q.s)) order by q.s), '[]'::jsonb)
             from jsonb_array_elements_text(coalesce(e.details -> 'backSeqs', '[]'::jsonb)) as q0 (v) cross join lateral (select q0.v::integer as s) q),
    'renamed', (select coalesce(jsonb_agg(jsonb_build_object('seq', q.s,
                   'oldName', authz.visa_name_in(v.revises_version_id, p_task, q.s), 'newName', authz.visa_name_in(v.id, p_task, q.s))
                   order by q.s), '[]'::jsonb)
                from jsonb_array_elements_text(coalesce(e.details -> 'renamedSeqs', '[]'::jsonb)) as q0 (v) cross join lateral (select q0.v::integer as s) q),
    'documentsAdded', coalesce((e.details ->> 'documentsAdded')::integer, 0),
    'fields', (select coalesce(jsonb_agg(distinct authz.visa_field_label(
                    case when f like 'participation.%' then 'participation' when f = 'travellers' then 'travellers'
                         else split_part(f, '.', 3) end)), '[]'::jsonb)
               from unnest(authz.revision_department_fields(v.id)) f cross join i
               where (f like 'items.' || i.item_no || '.%' and f <> 'items.' || i.item_no || '.purchaseBudgetPaise')
                  or f = 'participation.' || i.item_no or f = 'travellers'))
  from e join v on true
$$;

revoke all on function authz.visa_task_title(uuid), authz.visa_facts_line(text, jsonb), authz.visa_task_progress(uuid),
  authz.visa_added_after_completion(uuid), authz.visa_staff_name(uuid, uuid), authz.visa_field_label(text),
  authz.visa_name_in(uuid, uuid, integer), authz.visa_booking_change_json(uuid)
from public, anon, authenticated, service_role;

-- ===========================================================================
-- 2. Applicant JSON (section 9.2)
-- ===========================================================================

create function authz.visa_fee_json(p_entry uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'entryId', c.id, 'costKind', c.cost_kind, 'amountPaise', c.amount_paise::text, 'paidBy', c.paid_by,
    'paymentMode', c.payment_mode, 'expenseStatus', c.expense_status, 'returnReason', c.return_reason,
    'rowVersion', c.row_version,
    'receipt', (select jsonb_build_object('evidenceId', e.id, 'fileName', e.file_name)
                from public.department_evidence e where e.id = c.receipt_evidence_id and e.status <> 'removed'))
  from public.department_cost_entries c where c.id = p_entry
$$;

create function authz.visa_applicant_json(p_application uuid, p_va boolean, p_facts jsonb) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'applicationId', a.id, 'seq', a.traveller_seq, 'fullName', coalesce(cur.full_name, a.traveller_name_snapshot),
    'type', coalesce(cur.traveller_type, a.traveller_type_snapshot), 'ageYears', cur.age_years, 'rowVersion', a.row_version,
    'state', a.state,
    'stateText', case
      when a.state = 'docs_pending' and a.removed_at is not null then 'Removed from the booking'
      when a.state = 'docs_pending' and cardinality(nr.tokens) = 0 then 'Ready'
      when a.state = 'docs_pending' then 'Not applied'
      when a.state in ('submitted', 'decision_pending') then 'Applied · waiting for decision'
      when a.state = 'issued' then 'Approved'
      when a.state = 'refused' then 'Rejected'
      else 'Withdrawn' end,
    'ready', cardinality(nr.tokens) = 0, 'notReady', to_jsonb(nr.tokens), 'removed', a.removed_at is not null,
    'superseded', a.superseded_at is not null, 'secondApplication', a.reapplication_of_id is not null,
    'previousApplicationId', a.reapplication_of_id,
    'travellerChanged', case when authz.visa_traveller_changed(a)
                             then jsonb_build_object('was', a.traveller_name_snapshot, 'now', cur.full_name) end,
    'passport', case when p_va and a.removed_at is null and authz.can_read_traveller_identity(a.deal_id, a.traveller_seq) then (
        select jsonb_build_object('number', x.passport_number, 'identityRowVersion', x.row_version)
        from public.deal_travellers dt left join public.traveller_identities x on x.traveller_id = dt.id
        where dt.deal_id = a.deal_id and dt.seq = a.traveller_seq) end,
    'visaKind', authz.visa_kind_json(a, p_facts), 'jurisdiction', authz.visa_jurisdiction_json(a, p_facts),
    'appointment', jsonb_build_object('date', to_char(a.appointment_date, 'YYYY-MM-DD'), 'time', a.appointment_time),
    'remark', a.remark,
    'documents', (select coalesce(jsonb_agg(jsonb_build_object(
        'documentId', d.id, 'catalogueCode', d.catalogue_code, 'label', d.label, 'status', d.status, 'source', d.source,
        'remark', d.remark, 'receivedAt', d.received_at,
        'files', (select coalesce(jsonb_agg(jsonb_build_object('evidenceId', e.id, 'fileName', e.file_name)
                                           order by e.stored_at, e.id), '[]'::jsonb)
                  from public.department_evidence e where e.visa_document_id = d.id and e.status = 'stored'))
        order by coalesce(cat.ord, 1000), d.created_at, d.id), '[]'::jsonb)
      from public.visa_application_documents d
      left join authz.visa_document_catalogue() cat on cat.code = d.catalogue_code
      where d.application_id = a.id and d.removed_at is null),
    'documentsReceived', (select count(*)::integer from public.visa_application_documents d
                          where d.application_id = a.id and d.removed_at is null and d.status = 'received'),
    'documentsTotal', (select count(*)::integer from public.visa_application_documents d
                       where d.application_id = a.id and d.removed_at is null),
    'applied', case when a.state <> 'docs_pending' and (a.submitted_at is not null or a.applied_on is not null) then jsonb_build_object(
        'reference', a.reference, 'appliedOn', to_char(a.applied_on, 'YYYY-MM-DD'), 'clubId', a.club_id,
        'clubWith', (select coalesce(jsonb_agg(authz.visa_app_name(o) order by o.traveller_seq), '[]'::jsonb)
                     from public.visa_applications o where a.club_id is not null and o.club_id = a.club_id and o.id <> a.id),
        'remark', a.applied_remark, 'passportTaken', a.passport_taken_at is not null) end,
    'decision', case when a.state in ('issued', 'refused', 'withdrawn') then jsonb_build_object(
        'outcome', case a.state when 'issued' then 'approved' when 'refused' then 'rejected' else 'withdrawn' end,
        'at', case when a.state = 'withdrawn' then coalesce(a.customer_informed_at, a.updated_at) else a.outcome_at end,
        'remark', a.decision_remark,
        'reason', case when a.state = 'refused' then a.refusal_reason when a.state = 'withdrawn' then a.withdraw_reason end,
        'proof', (select jsonb_build_object('evidenceId', e.id, 'fileName', e.file_name)
                  from public.department_evidence e where e.id = a.outcome_evidence_id)) end,
    'handover', case when a.state in ('issued', 'refused', 'withdrawn') then jsonb_build_object(
        'kind', case when a.evisa_sent_at is not null then 'evisa'
                     when a.handover_method is not null then 'method'
                     when a.visa_kind = 'e_visa' and a.state = 'refused' and a.customer_informed_at is not null then 'customer_told'
                     when a.documents_returned_at is not null then 'legacy_returned' end,
        'recipientEmail', a.evisa_recipient_email,
        'sentAt', coalesce(a.evisa_sent_at, case when a.handover_method is null then a.documents_returned_at end),
        'method', a.handover_method, 'courierNumber', a.courier_number,
        'deliveredOn', to_char(a.delivered_on, 'YYYY-MM-DD'), 'remark', a.handover_remark) end,
    'closed', case when a.closed_at is not null then jsonb_build_object('at', a.closed_at, 'reason', a.closed_reason) end,
    'fees', (select coalesce(jsonb_agg(authz.visa_fee_json(c.id) order by c.created_at, c.id), '[]'::jsonb)
             from public.department_cost_entries c where c.application_id = a.id),
    'can', jsonb_build_object(
      'edit', p_va and a.closed_at is null and a.removed_at is null and a.state = 'docs_pending',
      'select', p_va and cardinality(nr.tokens) = 0,
      'decide', p_va and a.closed_at is null and a.state in ('submitted', 'decision_pending'),
      'handover', p_va and a.closed_at is null and a.state in ('issued', 'refused')
                  and a.handover_method is null and a.evisa_sent_at is null,
      'deliver', p_va and a.closed_at is null and a.handover_method in ('office', 'executive'),
      'withdraw', p_va and a.closed_at is null and a.state in ('docs_pending', 'submitted', 'decision_pending'),
      'reapply', p_va and a.state = 'refused' and a.removed_at is null,
      'confirmTraveller', p_va and authz.visa_traveller_changed(a)))
  from public.visa_applications a
  left join lateral (select s.* from public.booking_version_travellers s
                     where s.booking_version_id = authz.task_current_version(a.task_id) and s.seq = a.traveller_seq) cur on true
  cross join lateral (select authz.visa_not_ready(a, p_facts) as tokens) nr
  where a.id = p_application
$$;

revoke all on function authz.visa_fee_json(uuid), authz.visa_applicant_json(uuid, boolean, jsonb)
from public, anon, authenticated, service_role;

-- ===========================================================================
-- 3. 9.1 visa_queue
-- ===========================================================================

create function public.visa_queue() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_visa boolean;
  v_manager boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select coalesce(bool_or(m.role_code = 'visa'), false), coalesce(bool_or(m.role_code = 'manager'), false)
  into v_visa, v_manager
  from public.memberships m
  join public.legal_entities e on e.id = m.legal_entity_id and e.status = 'enabled'
  join public.branches b on b.id = m.branch_id and b.status = 'enabled'
  where m.user_id = v_uid and m.status = 'active';
  -- Readers: the Visa desk and branch Managers only.
  if not (v_visa or v_manager) then
    return null;
  end if;
  return jsonb_build_object(
    'isManagerView', not v_visa,
    'canTake', v_visa,
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
          'taskId', t.id, 'serviceType', t.service_purpose, 'dealReference', d.reference, 'branchName', b.name,
          'title', authz.visa_task_title(t.id),
          'factsLine', authz.visa_facts_line(t.service_purpose, authz.visa_task_facts(t.id)),
          'travelDate', to_char(authz.sf_date(case when t.service_purpose = 'passport' then authz.visa_task_facts(t.id) -> 'neededBy'
                                                    else authz.visa_task_facts(t.id) -> 'travelDate' end), 'YYYY-MM-DD'),
          'status', p.j -> 'status',
          'applicantCount', case when t.status = 'not_started'
                                 then cardinality(authz.item_participant_seqs(t.service_item_id, authz.task_current_version(t.id)))
                                 else (p.j ->> 'applicantCount')::integer end,
          'readyCount', (p.j ->> 'readyCount')::integer, 'appliedCount', (p.j ->> 'appliedCount')::integer,
          'decidedCount', (p.j ->> 'decidedCount')::integer, 'closedCount', (p.j ->> 'closedCount')::integer,
          'assigneeName', ap.display_name,
          'assignedToYou', t.assignee_user_id is not distinct from v_uid and t.assignee_user_id is not null,
          'createdAt', t.created_at)
        order by t.created_at desc, t.id)
      from public.fulfilment_tasks t
      join public.deals d on d.id = t.deal_id
      join public.branches b on b.id = t.branch_id
      left join public.staff_profiles ap on ap.user_id = t.assignee_user_id
      cross join lateral (select authz.visa_task_progress(t.id) as j) p
      where t.department = 'visa' and authz.can_read_visa_task(t.id)), '[]'::jsonb));
end;
$$;

-- ===========================================================================
-- 4. 9.2 visa_workspace
-- ===========================================================================

create function public.visa_workspace(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_task public.fulfilment_tasks%rowtype;
  v_ver public.booking_versions%rowtype;
  v_facts jsonb;
  v_va boolean;
  v_visa boolean;
  v_progress jsonb;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_task_id is null or not authz.can_read_visa_task(p_task_id) then
    return null;
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;
  select * into v_ver from public.booking_versions v where v.id = authz.task_current_version(v_task.id);
  v_facts := authz.visa_task_facts(v_task.id);
  v_va := authz.can_work_department_task(v_task.id);
  v_visa := authz.holds_active_role('visa', v_task.legal_entity_id);
  v_progress := authz.visa_task_progress(v_task.id);
  return jsonb_build_object(
    'taskId', v_task.id, 'serviceType', v_task.service_purpose, 'dealId', v_task.deal_id,
    'dealReference', (select d.reference from public.deals d where d.id = v_task.deal_id),
    'branchName', (select b.name from public.branches b where b.id = v_task.branch_id),
    'title', authz.visa_task_title(v_task.id),
    'status', v_progress -> 'status',
    'assignee', jsonb_build_object(
      'name', (select s.display_name from public.staff_profiles s where s.user_id = v_task.assignee_user_id),
      'isYou', v_task.assignee_user_id is not distinct from v_uid and v_task.assignee_user_id is not null,
      'takenAt', case when v_task.assignee_user_id is not null then (
          select a.occurred_at from public.audit_events a
          where a.target_type = 'fulfilment_task' and a.target_id = v_task.id
            and a.action in ('fulfilment.task_claimed', 'fulfilment.task_reassigned')
          order by a.occurred_at desc, a.id desc limit 1) end),
    'canClaim', v_visa and v_task.status = 'not_started' and v_task.assignee_user_id is null,
    'canWork', v_va,
    'isManagerView', not v_visa,
    'versionNo', v_ver.version_no, 'confirmedAt', v_ver.confirmed_at,
    'facts', case when v_task.service_purpose = 'passport' then jsonb_build_object('passport', jsonb_build_object(
        'applicationType', v_facts ->> 'applicationType', 'officeCity', v_facts ->> 'officeCity',
        'neededBy', v_facts ->> 'neededBy', 'notes', v_facts ->> 'notes'))
      else jsonb_build_object('visa', jsonb_build_object(
        'country', v_facts ->> 'country', 'purpose', v_facts ->> 'purpose', 'travelDate', v_facts ->> 'travelDate',
        'applyBy', v_facts ->> 'applyBy', 'feePaidBy', v_facts ->> 'feePaidBy', 'notes', v_facts ->> 'notes',
        'visaKind', authz.visa_sales_kind(v_facts), 'jurisdiction', authz.visa_sales_jurisdiction(v_facts),
        'jurisdictionPlace', case when authz.visa_sales_jurisdiction(v_facts) = 'yes' then v_facts ->> 'jurisdictionPlace' end,
        'documentsNeeded', to_jsonb(authz.visa_sales_document_labels(v_facts)))) end,
    'steps', v_progress -> 'steps',
    'bookingChange', authz.visa_booking_change_json(v_task.id),
    'addedAfterCompletion', authz.visa_added_after_completion(v_task.id),
    'applicants', (select coalesce(jsonb_agg(authz.visa_applicant_json(a.id, v_va, v_facts)
                                             order by (a.removed_at is not null), a.traveller_seq, a.created_at), '[]'::jsonb)
                   from public.visa_applications a where a.task_id = v_task.id and a.superseded_at is null),
    'previousApplications', (select coalesce(jsonb_agg(jsonb_build_object(
        'applicationId', a.id, 'seq', a.traveller_seq, 'reference', a.reference, 'state', a.state,
        'closed', a.closed_at is not null,
        'decision', case a.state when 'issued' then 'approved' when 'refused' then 'rejected' when 'withdrawn' then 'withdrawn' end)
        order by a.traveller_seq, a.created_at), '[]'::jsonb)
      from public.visa_applications a where a.task_id = v_task.id and a.superseded_at is not null),
    'readyCount', (v_progress ->> 'readyCount')::integer, 'appliedCount', (v_progress ->> 'appliedCount')::integer,
    'costSummary', jsonb_build_object(
      'travellers', (select coalesce(jsonb_agg(jsonb_build_object(
          'seq', a.traveller_seq, 'name', authz.visa_app_name(a),
          'governmentFeePaise', (g.e).amount_paise::text, 'serviceFeePaise', (sv.e).amount_paise::text,
          'paidBy', coalesce((g.e).paid_by, (sv.e).paid_by), 'expenseStatus', coalesce((g.e).expense_status, (sv.e).expense_status),
          'state', a.state) order by a.traveller_seq), '[]'::jsonb)
        from public.visa_applications a
        left join lateral (select c as e from public.department_cost_entries c
                           where c.application_id = a.id and c.cost_kind = 'government_fee'
                           order by c.created_at desc, c.id desc limit 1) g on true
        left join lateral (select c as e from public.department_cost_entries c
                           where c.application_id = a.id and c.cost_kind = 'service_fee'
                           order by c.created_at desc, c.id desc limit 1) sv on true
        where a.task_id = v_task.id and a.superseded_at is null),
      'taskLevel', (select coalesce(jsonb_agg(jsonb_build_object('entryId', c.id, 'costKind', c.cost_kind,
          'amountPaise', c.amount_paise::text, 'paidBy', c.paid_by, 'expenseStatus', c.expense_status)
          order by c.created_at, c.id), '[]'::jsonb)
        from public.department_cost_entries c where c.task_id = v_task.id and c.application_id is null),
      'companyTotalPaise', (select coalesce(sum(c.amount_paise), 0)::text from public.department_cost_entries c
                            where c.task_id = v_task.id and c.paid_by = 'company'),
      'customerDirectTotalPaise', (select coalesce(sum(c.amount_paise), 0)::text from public.department_cost_entries c
                                   where c.task_id = v_task.id and c.paid_by = 'customer_direct')),
    'returnedFees', (select coalesce(jsonb_agg(jsonb_build_object(
        'entryId', c.id, 'applicantName', (select authz.visa_app_name(a) from public.visa_applications a where a.id = c.application_id),
        'costKind', c.cost_kind, 'amountPaise', c.amount_paise::text, 'returnReason', c.return_reason, 'rowVersion', c.row_version)
        order by c.reviewed_at, c.id), '[]'::jsonb)
      from public.department_cost_entries c where c.task_id = v_task.id and c.expense_status = 'returned'),
    'catalogue', case when v_va then (select jsonb_agg(jsonb_build_object('code', c.code, 'label', c.label) order by c.ord)
                                      from authz.visa_document_catalogue() c) else '[]'::jsonb end,
    'files', (select coalesce(jsonb_agg(jsonb_build_object(
        'evidenceId', e.id, 'kind', e.kind, 'applicationId', e.application_id, 'fileName', e.file_name, 'mime', e.mime,
        'sizeBytes', e.size_bytes, 'status', e.status, 'uploadedByYou', e.uploaded_by = v_uid,
        'uploadedByName', authz.visa_staff_name(v_task.id, e.uploaded_by), 'createdAt', e.created_at, 'storedAt', e.stored_at,
        'visaDocumentId', e.visa_document_id,
        'applicantSeq', (select a.traveller_seq from public.visa_applications a where a.id = e.application_id))
        order by e.created_at, e.id), '[]'::jsonb)
      from public.department_evidence e where e.task_id = v_task.id and e.status <> 'removed'),
    'canUpload', v_va);
end;
$$;

-- ===========================================================================
-- 5. 9.3 Deal reads (no money, identity, reference or e-mail)
-- ===========================================================================

create function public.deal_visa_summary(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_notices boolean;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  -- SO, branch Manager and other Sales readers with the full services scope;
  -- Purchase, Flight, Visa and Accounts never.
  if v_deal.id is null or authz.deal_services_scope(p_deal_id) is not null
     or not (authz.is_branch_sales_manager(p_deal_id) or authz.holds_active_role('sales', v_deal.legal_entity_id)) then
    return null;
  end if;
  v_notices := authz.visa_notice_reader(p_deal_id);
  return jsonb_build_object(
    'tasks', (select coalesce(jsonb_agg(jsonb_build_object(
        'taskId', t.id, 'serviceType', t.service_purpose, 'title', authz.visa_task_title(t.id),
        'status', authz.visa_task_progress(t.id) -> 'status',
        'applicantCount', case when t.status = 'not_started'
                               then cardinality(authz.item_participant_seqs(t.service_item_id, authz.task_current_version(t.id)))
                               else (select count(*)::integer from public.visa_applications a
                                     where a.task_id = t.id and a.superseded_at is null
                                       and not (a.removed_at is not null and a.state = 'docs_pending')) end,
        'approved', (select count(*)::integer from public.visa_applications a
                     where a.task_id = t.id and a.superseded_at is null and a.state = 'issued'),
        'rejected', (select count(*)::integer from public.visa_applications a
                     where a.task_id = t.id and a.superseded_at is null and a.state = 'refused'),
        'withdrawn', (select count(*)::integer from public.visa_applications a
                      where a.task_id = t.id and a.superseded_at is null and a.state = 'withdrawn'),
        'waiting', (select count(*)::integer from public.visa_applications a
                    where a.task_id = t.id and a.superseded_at is null and a.state in ('submitted', 'decision_pending')),
        'addedAfterCompletion', authz.visa_added_after_completion(t.id))
        order by i.item_no, t.id), '[]'::jsonb)
      from public.fulfilment_tasks t join public.service_items i on i.id = t.service_item_id
      where t.deal_id = p_deal_id and t.department = 'visa'),
    'notices', case when v_notices then (select coalesce(jsonb_agg(jsonb_build_object(
        'noticeId', n.id, 'taskId', n.task_id, 'title', authz.visa_task_title(n.task_id),
        'travellerName', (select authz.visa_app_name(a) from public.visa_applications a where a.id = n.application_id),
        'outcome', n.outcome, 'at', n.created_at,
        'reason', case when n.outcome = 'rejected' then (select a.refusal_reason from public.visa_applications a where a.id = n.application_id) end,
        'seen', n.seen_at is not null, 'canAck', n.seen_at is null)
        order by n.created_at, n.id), '[]'::jsonb)
      from public.visa_result_notices n where n.deal_id = p_deal_id) else '[]'::jsonb end);
end;
$$;

create function authz.visa_deal_history_kind(p_action text) returns text
language sql immutable set search_path = '' as $$
  select case p_action
    when 'fulfilment.task_claimed' then 'taken'
    when 'visa.application_applied' then 'applied'
    when 'visa.application_approved' then 'approved'
    when 'visa.application_rejected' then 'rejected'
    when 'visa.application_withdrawn' then 'withdrawn'
    when 'visa.evisa_sent' then 'evisa_sent'
    when 'visa.handover_set' then 'handed_over'
    when 'visa.handover_delivered' then 'delivered'
    when 'visa.application_reapplied' then 'reapplied'
    when 'fulfilment.task_completed' then 'completed'
  end
$$;
revoke all on function authz.visa_deal_history_kind(text) from public, anon, authenticated, service_role;

create function public.deal_visa_history(p_deal_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_deal public.deals%rowtype;
  v_uid uuid := (select auth.uid());
  v_events jsonb;
  v_n integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  select * into v_deal from public.deals d where d.id = p_deal_id;
  -- VL5: the Sales owner and the branch Manager.
  if v_deal.id is null or not (authz.visa_is_sales_owner(p_deal_id) or authz.is_branch_sales_manager(p_deal_id)) then
    return null;
  end if;
  with targets (target_type, target_id, task_id) as (
    select 'fulfilment_task', t.id, t.id from public.fulfilment_tasks t where t.deal_id = p_deal_id and t.department = 'visa'
    union all
    select 'visa_application', a.id, a.task_id from public.visa_applications a
    join public.fulfilment_tasks t on t.id = a.task_id where t.deal_id = p_deal_id and t.department = 'visa'
  ), picked as (
    select a.id, a.occurred_at, a.actor_user_id, a.reason, a.details, g.task_id, g.target_id,
           authz.visa_deal_history_kind(a.action) as kind,
           case when a.action = 'visa.application_applied' and jsonb_typeof(a.details -> 'clubId') = 'string'
                then a.details ->> 'clubId' end as club
    from targets g
    join public.audit_events a on a.target_type = g.target_type and a.target_id = g.target_id
    where authz.visa_deal_history_kind(a.action) is not null
  ), ranked as (
    select p.*, count(*) over (partition by p.club) as club_n,
           row_number() over (partition by p.club order by p.occurred_at desc, p.id desc) as club_rn
    from picked p
  ), kept as (
    select k.*, row_number() over (order by k.occurred_at desc, k.id desc) as rn
    from ranked k where k.club is null or k.club_rn = 1
  )
  select count(*)::integer,
         coalesce(jsonb_agg(jsonb_build_object(
           'at', k.occurred_at, 'kind', k.kind, 'taskId', k.task_id, 'title', authz.visa_task_title(k.task_id),
           'travellerName', case when k.club is null and jsonb_typeof(k.details -> 'seq') = 'number' then
               authz.visa_name_in(authz.task_current_version(k.task_id), k.task_id, (k.details ->> 'seq')::integer) end,
           'byName', authz.visa_staff_name(k.task_id, k.actor_user_id),
           'byYou', k.actor_user_id is not null and k.actor_user_id = v_uid,
           'note', case when k.kind in ('rejected', 'withdrawn') then k.reason
                        when k.club is not null then 'Applied together: ' || k.club_n || ' travellers' end)
           order by k.occurred_at desc, k.id desc) filter (where k.rn <= 200), '[]'::jsonb)
  into v_n, v_events
  from kept k;
  return jsonb_build_object('events', v_events, 'truncated', v_n > 200);
end;
$$;

-- ===========================================================================
-- 6. Home counts (section 8)
-- ===========================================================================

create function public.visa_home_counts() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_visa boolean;
  v_sales boolean;
  v_mine uuid[];
  v_waiting uuid[];
  v_handover uuid[];
  v_returned uuid[];
  v_noreceipt uuid[];
  v_changed uuid[];
  v_notice_deals uuid[];
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  -- SO* rows only for Sales / Manager people without a department role (who read Deals with the full scope).
  select coalesce(bool_or(m.role_code = 'visa'), false),
         coalesce(bool_or(m.role_code in ('sales', 'manager')), false)
           and not coalesce(bool_or(m.role_code in ('purchase', 'flight', 'visa')), false)
  into v_visa, v_sales
  from public.memberships m
  join public.legal_entities e on e.id = m.legal_entity_id and e.status = 'enabled'
  join public.branches b on b.id = m.branch_id and b.status = 'enabled'
  where m.user_id = v_uid and m.status = 'active';
  if v_visa then
    select coalesce(array_agg(t.id order by t.created_at, t.id), '{}') into v_mine
    from public.fulfilment_tasks t join public.deals d on d.id = t.deal_id
    where t.department = 'visa' and t.status = 'in_progress' and t.assignee_user_id = v_uid and d.removed_at is null
      and authz.holds_active_role('visa', t.legal_entity_id);
    -- One task id per matching row, in task order (first = link target).
    select coalesce(array_agg(a.task_id order by array_position(v_mine, a.task_id), a.id), '{}') into v_waiting
    from public.visa_applications a
    where a.task_id = any (v_mine) and a.superseded_at is null and a.closed_at is null and a.state in ('submitted', 'decision_pending');
    select coalesce(array_agg(a.task_id order by array_position(v_mine, a.task_id), a.id), '{}') into v_handover
    from public.visa_applications a
    where a.task_id = any (v_mine) and a.superseded_at is null and a.closed_at is null and a.state in ('issued', 'refused');
    select coalesce(array_agg(c.task_id order by array_position(v_mine, c.task_id), c.id), '{}') into v_returned
    from public.department_cost_entries c where c.task_id = any (v_mine) and c.expense_status = 'returned';
    select coalesce(array_agg(c.task_id order by array_position(v_mine, c.task_id), c.id), '{}') into v_noreceipt
    from public.department_cost_entries c
    where c.task_id = any (v_mine) and c.paid_by = 'company' and c.expense_status = 'draft' and not authz.expense_receipt_ok(c.id);
    select coalesce(array_agg(a.task_id order by array_position(v_mine, a.task_id), a.id), '{}') into v_changed
    from public.visa_applications a where a.task_id = any (v_mine) and authz.visa_traveller_changed(a);
  end if;
  if v_sales then
    select coalesce(array_agg(n.deal_id order by n.created_at desc, n.id), '{}') into v_notice_deals
    from public.visa_result_notices n join public.deals d on d.id = n.deal_id
    where n.seen_at is null and d.removed_at is null and authz.visa_notice_reader(n.deal_id);
  end if;
  return jsonb_build_object(
    'visaApplicantsWaitingResult', case when v_visa then cardinality(v_waiting) end,
    'visaApplicantsWaitingResultTaskId', case when v_visa then v_waiting[1] end,
    'visaHandoverPending', case when v_visa then cardinality(v_handover) end,
    'visaHandoverPendingTaskId', case when v_visa then v_handover[1] end,
    'visaFeesReturned', case when v_visa then cardinality(v_returned) end,
    'visaFeesReturnedTaskId', case when v_visa then v_returned[1] end,
    'visaFeesWithoutReceipt', case when v_visa then cardinality(v_noreceipt) end,
    'visaFeesWithoutReceiptTaskId', case when v_visa then v_noreceipt[1] end,
    'visaTravellerChanged', case when v_visa then cardinality(v_changed) end,
    'visaTravellerChangedTaskId', case when v_visa then v_changed[1] end,
    'salesVisaResultsToSee', case when v_sales then cardinality(v_notice_deals) end,
    'salesVisaResultsDealId', case when v_sales then v_notice_deals[1] end);
end;
$$;

-- ===========================================================================
-- 7. Task History (replaces 20261201000120)
-- ===========================================================================

create or replace function public.department_task_history(p_task_id uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_task public.fulfilment_tasks%rowtype;
  v_uid uuid := (select auth.uid());
  v_events jsonb;
  v_n integer;
begin
  if not coalesce(authz.session_ok(), false) then
    raise exception 'not_authorized' using errcode = '42501';
  end if;
  if p_task_id is null or not authz.can_read_task_history(p_task_id) then
    return null;
  end if;
  select * into v_task from public.fulfilment_tasks t where t.id = p_task_id;

  with targets (target_type, target_id) as (
    select 'fulfilment_task', p_task_id
    union all select 'purchase_evidence', e.id from public.purchase_evidence e where e.task_id = p_task_id
    union all select 'department_evidence', e.id from public.department_evidence e where e.task_id = p_task_id
    union all select 'department_cost_entry', c.id from public.department_cost_entries c where c.task_id = p_task_id
    union all select 'visa_application', a.id from public.visa_applications a where a.task_id = p_task_id
  ), kinds (action, kind) as (
    values ('fulfilment.task_created', 'created'), ('fulfilment.task_claimed', 'taken'),
           ('fulfilment.task_released', 'released'), ('fulfilment.task_reassigned', 'reassigned'),
           ('fulfilment.task_completed', 'completed'),
           ('purchase.quote_added', 'offer_added'), ('purchase.quote_withdrawn', 'offer_withdrawn'),
           ('purchase.cost_proposed', 'cost_recorded'), ('purchase.cost_over_budget_approved', 'over_budget_approved'),
           ('purchase.supplier_confirmed', 'supplier_confirmed'),
           ('purchase.evidence_stored', 'file_added'), ('purchase.evidence_removed', 'file_removed'),
           ('department.evidence_stored', 'file_added'), ('department.evidence_removed', 'file_removed'),
           ('department.cost_saved', 'cost_recorded'), ('department.cost_submitted', 'sent_to_accounts'),
           ('finance.expense_record_accepted', 'accounts_accepted'),
           ('finance.expense_record_returned', 'accounts_returned'),
           ('visa.application_updated', 'applicant_updated'),
           ('visa.application_state_changed', 'applicant_stage'),
           ('visa.application_withdrawn_by_revision', 'applicant_withdrawn'),
           -- Purchase build (20261130000120).
           ('purchase.rate_request_recorded', 'rate_request_sent'),
           ('purchase.booking_request_recorded', 'booking_request_sent'),
           ('purchase.supplier_email_sent', 'email_sent'),
           ('purchase.supplier_email_failed', 'email_failed'),
           ('purchase.go_ahead_requested', 'go_ahead_requested'),
           ('purchase.go_ahead_approved', 'go_ahead_approved'),
           ('purchase.go_ahead_returned', 'go_ahead_returned'),
           ('purchase.cancellation_charge_set', 'cancellation_charge_saved')
  ), flight_kinds (action, kind) as (
    -- Flight build (20261201000120), flight tasks only.
    values ('flight.booking_change_applied', 'booking_change_applied'),
           ('flight.screenshot_sectors_saved', 'sectors_entered'),
           ('flight.sector_details_filled', 'sector_details_filled'),
           ('flight.change_submitted', 'change_submitted'), ('flight.change_approved', 'change_approved'),
           ('flight.change_rejected', 'change_rejected'), ('flight.change_withdrawn', 'change_withdrawn'),
           ('flight.tickets_confirmed', 'tickets_confirmed'), ('flight.ticket_corrected', 'ticket_corrected'),
           ('flight.fare_approval_requested', 'fare_approval_requested'),
           ('flight.fare_approval_approved', 'fare_approval_approved'),
           ('flight.fare_approval_returned', 'fare_approval_returned'),
           ('flight.fare_approval_withdrawn', 'fare_approval_withdrawn'),
           ('flight.direct_payment_recorded', 'direct_payment_recorded'),
           ('flight.payment_requested', 'payment_requested'), ('flight.payment_resubmitted', 'payment_resubmitted'),
           ('flight.payment_cancelled', 'payment_cancelled'),
           ('finance.supplier_payment_approved', 'payment_approved'),
           ('finance.supplier_payment_returned', 'payment_returned'),
           ('finance.supplier_payment_recorded', 'payment_recorded'),
           ('finance.supplier_payment_verified', 'payment_verified')
  ), visa_kinds (action, kind) as (
    -- Visa build (20261202000120), visa tasks only. booking.traveller_identity_saved is not shown.
    values ('visa.application_row_saved', 'applicant_row_saved'),
           ('visa.document_added', 'document_added'), ('visa.document_removed', 'document_removed'),
           ('visa.application_applied', 'applied'), ('visa.application_approved', 'approved'),
           ('visa.application_rejected', 'rejected'), ('visa.application_withdrawn', 'withdrawn'),
           ('visa.evisa_sent', 'evisa_sent'), ('visa.handover_set', 'handover_set'),
           ('visa.handover_delivered', 'delivered'), ('visa.application_closed', 'applicant_closed'),
           ('visa.application_reapplied', 'reapplied'), ('visa.traveller_change_confirmed', 'traveller_confirmed'),
           ('visa.fee_sent', 'fee_sent'), ('visa.booking_synced', 'booking_synced'),
           ('visa.application_relinked', 'applicant_back')
  ), all_kinds (action, kind) as (
    select k.action, k.kind from kinds k
    union all
    select f.action, f.kind from flight_kinds f where v_task.department = 'flight'
    union all
    select v.action, v.kind from visa_kinds v where v_task.department = 'visa'
  ), picked as (
    select a.id, a.occurred_at, a.actor_user_id, a.action, a.reason, a.details, k.kind
    from targets t
    join public.audit_events a
      on a.target_id = t.target_id and a.target_type = t.target_type
     and a.target_type in ('fulfilment_task', 'purchase_evidence', 'department_evidence', 'department_cost_entry',
                           'visa_application')
    join all_kinds k on k.action = a.action
    order by a.occurred_at desc, a.id desc
    limit 201
  )
  select count(*)::integer,
         coalesce(jsonb_agg(jsonb_build_object(
           'at', p.occurred_at,
           'kind', p.kind,
           -- Names only where the task page already shows that person to its
           -- readers ("Taken by": the current assignee); yourself = byYou.
           'byName', case when p.actor_user_id is not null and p.actor_user_id = v_task.assignee_user_id then
                       (select s.display_name from public.staff_profiles s where s.user_id = p.actor_user_id) end,
           'byYou', p.actor_user_id is not null and p.actor_user_id = v_uid,
           'toName', case when p.kind = 'reassigned' and v_task.assignee_user_id is not null
                           and p.details ->> 'toUserId' = v_task.assignee_user_id::text then
                       (select s.display_name from public.staff_profiles s where s.user_id = v_task.assignee_user_id) end,
           'toYou', p.kind = 'reassigned' and p.details ->> 'toUserId' = v_uid::text,
           'applicantSeq', case when (p.kind like 'applicant\_%' or p.kind like 'document\_%'
                                      -- Visa build: per-passenger kinds.
                                      or p.kind in ('applied', 'approved', 'rejected', 'withdrawn', 'evisa_sent',
                                                    'handover_set', 'delivered', 'reapplied', 'traveller_confirmed'))
                                     and jsonb_typeof(p.details -> 'seq') = 'number'
                                then p.details -> 'seq' end,
           'state', case when p.kind = 'applicant_stage' and jsonb_typeof(p.details -> 'to') = 'string'
                         then p.details ->> 'to' end,
           'note', case when p.kind in ('accounts_returned', 'applicant_withdrawn', 'go_ahead_returned',
                                        -- Flight build: reasons of rejected changes, corrections and returns.
                                        'change_rejected', 'ticket_corrected', 'fare_approval_returned', 'payment_returned')
                          or (p.kind = 'reassigned' and v_task.department = 'flight')
                          -- Visa build: refusal and withdrawal reasons, fee-send remark.
                          or (v_task.department = 'visa' and p.kind in ('rejected', 'withdrawn', 'fee_sent'))
                        then p.reason end)
           -- Flight build: flight tasks also carry the change number of change events.
           || case when v_task.department = 'flight' then jsonb_build_object('changeNo',
                case when p.kind like 'change\_%' and jsonb_typeof(p.details -> 'changeNo') = 'number'
                     then p.details -> 'changeNo' end) else '{}'::jsonb end
           -- Visa build: club size of applied events, method of handover events.
           || case when v_task.department = 'visa' then jsonb_build_object(
                'clubSize', case when p.kind = 'applied' and jsonb_typeof(p.details -> 'clubSize') = 'number'
                                 then p.details -> 'clubSize' end,
                'method', case when p.kind = 'handover_set' and jsonb_typeof(p.details -> 'method') = 'string'
                               then p.details ->> 'method' end) else '{}'::jsonb end
           order by p.occurred_at desc, p.id desc) filter (where p.rn <= 200), '[]'::jsonb)
  into v_n, v_events
  from (select x.*, row_number() over (order by x.occurred_at desc, x.id desc) rn from picked x) p;

  return jsonb_build_object('taskId', v_task.id, 'department', v_task.department,
    'events', v_events, 'truncated', v_n > 200);
end;
$$;

-- ===========================================================================
-- 8. Accounts expense item (replaces 20261119000500): applicant name
-- ===========================================================================

create or replace function authz.finance_expense_item_json(p_entry uuid) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'entryId', c.id, 'dealId', c.deal_id, 'dealReference', d.reference, 'department', c.department,
    'serviceType', t.service_purpose, 'kind', c.cost_kind, 'amountPaise', c.amount_paise::text, 'paidBy', c.paid_by,
    'paymentMode', c.payment_mode, 'paidOn', to_char(c.paid_on, 'YYYY-MM-DD'), 'reference', c.reference,
    'status', c.expense_status, 'submittedByName', authz.finance_name(c.submitted_by), 'submittedAt', c.submitted_at,
    'reviewedByName', authz.finance_name(c.reviewed_by), 'reviewedAt', c.reviewed_at, 'returnReason', c.return_reason,
    'rowVersion', c.row_version,
    -- Visa build (20261202000120, VL16): the applicant's full name only.
    'applicantName', case when c.application_id is not null then
        (select authz.visa_app_name(a) from public.visa_applications a where a.id = c.application_id) end,
    -- ExpenseEvidenceView (finance contracts; review E2).
    'evidence', coalesce((select jsonb_agg(jsonb_build_object('id', e.id, 'kind', e.kind, 'fileName', e.file_name,
        'status', e.status, 'createdAt', e.created_at))
      from public.department_evidence e where e.id = c.receipt_evidence_id and e.kind in ('fee_receipt', 'direct_payment_proof')),
      '[]'::jsonb),
    -- Block token per action, null = allowed (ExpenseActionBlock; review E1).
    'actions', jsonb_build_object(
      'accept', case when c.expense_status is distinct from 'submitted' then 'wrong_state'
                     when c.submitted_by = (select auth.uid()) or c.created_by = (select auth.uid()) then 'own_submission'
                     when authz.finance_deal_conflict(c.deal_id) then 'deal_conflict'
                     when not authz.expense_receipt_ok(c.id) then 'receipt_required' end,
      'return', case when c.expense_status is distinct from 'submitted' then 'wrong_state'
                     when c.submitted_by = (select auth.uid()) or c.created_by = (select auth.uid()) then 'own_submission'
                     when authz.finance_deal_conflict(c.deal_id) then 'deal_conflict' end))
  from public.department_cost_entries c
  join public.deals d on d.id = c.deal_id
  join public.fulfilment_tasks t on t.id = c.task_id
  where c.id = p_entry
$$;

-- ===========================================================================
-- 9. Grants
-- ===========================================================================

revoke all on function public.visa_queue(), public.visa_workspace(uuid), public.deal_visa_summary(uuid),
  public.deal_visa_history(uuid), public.visa_home_counts()
from public, anon, authenticated, service_role;
grant execute on function public.visa_queue(), public.visa_workspace(uuid), public.deal_visa_summary(uuid),
  public.deal_visa_history(uuid), public.visa_home_counts()
to authenticated;
-- department_task_history and finance_expense_item_json keep their ACLs (CREATE OR REPLACE).

commit;
